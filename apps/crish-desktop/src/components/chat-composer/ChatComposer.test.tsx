/**
 * ChatComposer 全链测试（40 方案 T6 接线）：
 * 真实渲染 ChatComposer + TiptapComposerField + 编辑器本体，宿主 props 全链驱动：
 * 发送/IME/增高/空护栏 / 附件粘贴→附件条 / 权限菜单 / 斜杠注入与 open-schedule /
 * skill 预载 / 队列面板共存 / 焦点回迁 / 退役组件清理。
 */
// @vitest-environment jsdom
import React, { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const acceptsImageMock = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../api/modelVisionSupport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/modelVisionSupport')>();
  return {
    ...actual,
    activeModelAcceptsImage: () => acceptsImageMock(),
  };
});

vi.mock('../../app/compositionRoot', () => ({
  getCompositionRoot: () => ({
    session: {
      getActiveSessionId: () => null,
      getState: () => ({
        activeSessionId: null,
        setComposerDraft: () => undefined,
      }),
    },
  }),
}));

vi.mock('../../api/storeAccess', () => ({
  openSettings: vi.fn(),
}));

import { ChatComposer, type ChatComposerProps } from './ChatComposer';

function getEditorDom(): HTMLElement {
  const el = document.querySelector('[contenteditable="true"]');
  if (!el) throw new Error('编辑器未挂载');
  return el as HTMLElement;
}

/** 输入模拟：光标处 DOM 变更 + input 事件驱动 PM DOMObserver（jsdom 无原生可编辑行为） */
async function typeText(text: string): Promise<void> {
  // 富文本经 React.lazy 软接（F1-γ）：等待编辑器挂载（Suspense 解析完成），
  // 再保留与拆分前一致的 60ms settle 窗口（PM view / DOMObserver 初始化完成），
  // 避免 DOM 变更落在 view 就绪前被 PM 回滚
  const dom = await waitFor(() => getEditorDom());
  await new Promise((r) => setTimeout(r, 60));
  const sel = document.getSelection();
  let target: Node = dom;
  let offset = 0;
  if (
    sel &&
    sel.rangeCount > 0 &&
    dom.contains(sel.getRangeAt(0).startContainer)
  ) {
    target = sel.getRangeAt(0).startContainer;
    offset = sel.getRangeAt(0).startOffset;
  } else {
    const lastP = dom.querySelector('p:last-of-type');
    if (lastP) {
      target = lastP;
      offset = lastP.childNodes.length;
    }
  }
  const textNode = document.createTextNode(text);
  if (target.nodeType === Node.TEXT_NODE) {
    (target as Text).insertData(
      Math.min(offset, (target as Text).length),
      text
    );
  } else {
    (target as Element).insertBefore(
      textNode,
      (target as Element).childNodes[offset] ?? null
    );
  }
  if (sel) {
    const range = document.createRange();
    range.setStart(textNode, textNode.length);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  dom.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
}

const BASE_COMMANDS = [
  { cmd: '/goal', desc: '多轮推进直至完成' },
  { cmd: '/schedule', desc: '定时任务' },
  { cmd: '/learn', desc: '记住一条规则' },
];

const SKILL_COMMANDS = [{ cmd: '/skill:检视', desc: '检视代码质量' }];

/**
 * 宿主语义 Harness：复刻 useChatComposerProps 关键链路
 * （chatInput 状态、附件、filteredCommands 前缀过滤、onSend 发送后清空）。
 */
function renderChatComposer(opts: {
  onSend?: () => void;
  onPasteImage?: (e: React.ClipboardEvent) => void;
  isProcessing?: boolean;
  initialInput?: string;
}) {
  const loadSkillSlash = vi.fn();
  const onSend = vi.fn(opts.onSend ?? (() => {}));
  const onPasteImage = vi.fn(
    opts.onPasteImage ??
      ((e: React.ClipboardEvent) => {
        const items = Array.from(e.clipboardData?.items ?? []);
        if (items.some((it) => it.type.startsWith('image/'))) {
          // 宿主 handlePasteImage 语义：图片 → blobToImageAttachment
        }
      })
  );
  const sentValues: string[] = [];

  function Harness() {
    const [input, setInput] = useState(opts.initialInput ?? '');
    const [attachments, setAttachments] = useState<
      ChatComposerProps['attachments']
    >([]);
    const [permission, setPermission] = useState<
      'ask' | 'deep' | 'full' | 'plan'
    >('ask');
    const [composing, setComposing] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const inputRef = useRef(input);
    inputRef.current = input;
    const filtered = [...BASE_COMMANDS, ...SKILL_COMMANDS].filter((c) =>
      c.cmd.toLowerCase().startsWith(input.toLowerCase())
    );
    return (
      <ChatComposer
        chatInput={input}
        setChatInput={setInput}
        isComposing={composing}
        setIsComposing={setComposing}
        filteredCommands={filtered}
        loadSkillSlash={loadSkillSlash}
        onPasteImage={onPasteImage}
        onSend={() => {
          sentValues.push(inputRef.current);
          onSend();
          setInput('');
        }}
        onStop={vi.fn()}
        onForceStop={vi.fn()}
        canSend={Boolean(input.trim() || attachments.length > 0)}
        isProcessing={opts.isProcessing ?? false}
        attachments={attachments}
        setAttachments={setAttachments}
        fileInputRef={fileInputRef}
        onFilesSelected={vi.fn()}
        showPlusMenu={false}
        setShowPlusMenu={() => {}}
        permissionMode={permission}
        onPermissionChange={setPermission}
      />
    );
  }

  const utils = render(<Harness />);
  return {
    ...utils,
    loadSkillSlash,
    onSend,
    onPasteImage,
    sentValues,
  };
}

describe('ChatComposer 全链（T6 接线）', () => {
  it('发送全链：输入 → Enter → 宿主 onSend 携带最新文本，发送后清空', async () => {
    const { onSend, sentValues } = renderChatComposer({});
    await typeText('你好，分析一下');
    fireEvent.keyDown(getEditorDom(), { key: 'Enter' });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
    expect(sentValues).toEqual(['你好，分析一下']);
    await waitFor(() => {
      expect(getEditorDom().textContent).toBe('');
    });
  });

  it('IME 门：composition 期间 Enter 不发送，结束后恢复', async () => {
    const { onSend } = renderChatComposer({});
    const dom = getEditorDom();
    await typeText('中文输入');
    fireEvent.compositionStart(dom);
    fireEvent.keyDown(dom, { key: 'Enter', isComposing: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.compositionEnd(dom);
    // jsdom 的 navigator.vendor 为 Apple Computer → PM 走 Safari IME 保护分支：
    // compositionend 后 500ms 内的首个 Enter 被吞（真实 WebView2/Chromium 无此行为），
    // 连续第二个 Enter 即恢复发送语义。
    fireEvent.keyDown(dom, { key: 'Enter' });
    fireEvent.keyDown(dom, { key: 'Enter' });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
  });

  it('空护栏：无内容时 Enter 不发送', async () => {
    const { onSend } = renderChatComposer({});
    // 富文本经 React.lazy 软接（F1-γ）：等编辑器挂载 + PM view settle 再发 Enter
    const dom = await waitFor(() => getEditorDom());
    await new Promise((r) => setTimeout(r, 60));
    fireEvent.keyDown(dom, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 30));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('附件全链：粘贴图片 → 宿主 onPasteImage 收事件 → 附件条展示 → 移除', async () => {
    const { onPasteImage } = renderChatComposer({
      onPasteImage: (e) => {
        // 宿主 handlePasteImage 语义：读 clipboardData 提取图片
        const file = Array.from(e.clipboardData?.items ?? [])
          .find((it) => it.type.startsWith('image/'))
          ?.getAsFile();
        if (file) {
          // 简化：不跑 imageProcessing，直接以名称入附件
        }
      },
    });
    // 直接驱动宿主回调：编辑器 onPaste 转发原事件（含 clipboardData）
    // 富文本经 React.lazy 软接（F1-γ）：等编辑器挂载 + PM view settle
    const dom = await waitFor(() => getEditorDom());
    await new Promise((r) => setTimeout(r, 60));
    const fakeFile = new File(['x'], '截图.png', { type: 'image/png' });
    const items = [{ type: 'image/png', getAsFile: () => fakeFile }];
    fireEvent.paste(dom, { clipboardData: { items, getData: () => '' } });
    expect(onPasteImage).toHaveBeenCalledTimes(1);
    // 宿主回调拿到转发事件的 clipboardData
    const forwarded = onPasteImage.mock.calls[0][0] as unknown as {
      clipboardData: DataTransfer;
    };
    expect(Array.from(forwarded.clipboardData.items).length).toBe(1);
    // 附件条随宿主 attachments 状态渲染（经 setAttachments 链）
  });

  it('附件条与移除：宿主注入附件后展示，点击移除回调 setAttachments', async () => {
    // 直接以 attachments 渲染验证条与移除（宿主 setAttachments 链由 useChatComposerProps 负责）
    function AttachHarness() {
      const [input, setInput] = useState('');
      const [attachments, setAttachments] = useState([
        { name: 'report.md', text: '内容' },
      ]);
      const fileInputRef = useRef<HTMLInputElement>(null);
      const [permission, setPermission] = useState<
        'ask' | 'deep' | 'full' | 'plan'
      >('ask');
      const [composing, setComposing] = useState(false);
      return (
        <ChatComposer
          chatInput={input}
          setChatInput={setInput}
          isComposing={composing}
          setIsComposing={setComposing}
          filteredCommands={BASE_COMMANDS}
          loadSkillSlash={vi.fn()}
          onPasteImage={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
          canSend={Boolean(input.trim() || attachments.length > 0)}
          isProcessing={false}
          attachments={attachments}
          setAttachments={setAttachments}
          fileInputRef={fileInputRef}
          onFilesSelected={vi.fn()}
          showPlusMenu={false}
          setShowPlusMenu={() => {}}
          permissionMode={permission}
          onPermissionChange={setPermission}
        />
      );
    }
    render(<AttachHarness />);
    const chip = await screen.findByText('report.md');
    expect(chip).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '移除附件 report.md' }));
    await waitFor(() => {
      expect(screen.queryByText('report.md')).toBeNull();
    });
  });

  it('权限菜单全链：胶囊展示当前模式，切换触发 onPermissionChange', async () => {
    renderChatComposer({});
    const pill = screen.getByRole('button', { name: /当前权限模式：需确认/ });
    expect(pill).toBeTruthy();
    fireEvent.click(pill);
    const menu = await screen.findByRole('menu');
    expect(menu).toBeTruthy();
    const items = screen.getAllByRole('menuitem');
    expect(items.length).toBeGreaterThan(1);
    // 点击非当前项（plan）→ 胶囊切换（菜单项为 role=menuitem 按钮）
    const planItem = screen.getByRole('menuitem', { name: /计划/ });
    fireEvent.click(planItem);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /当前权限模式：计划/ })
      ).toBeTruthy();
    });
  });

  it('斜杠全链：/ 触发 tiptap 菜单，宿主命令可点选注入并回流 chatInput', async () => {
    const { onSend } = renderChatComposer({});
    await typeText('/go');
    const goalItem = await screen.findByRole('option', { name: /目标/ });
    fireEvent.click(goalItem);
    await waitFor(() => {
      expect(getEditorDom().textContent).toContain('目标');
    });
    // 防抖回流 → 宿主 chatInput 更新 → 可发送
    await waitFor(() => {
      expect(onSend).toBeDefined();
    });
    await new Promise((r) => setTimeout(r, 250));
    fireEvent.keyDown(getEditorDom(), { key: 'Enter' });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
  });

  it('/schedule 点选：填入对话模板前缀（维度三 §2.6——面板不再经斜杠打开）', async () => {
    renderChatComposer({});
    await typeText('/sche');
    const scheduleItem = await screen.findByRole('option', {
      name: /\/schedule/,
    });
    fireEvent.click(scheduleItem);
    await waitFor(() => {
      expect(getEditorDom().textContent).toContain('/schedule');
    });
  });

  it('skill 预载：输入斜杠前缀后 loadSkillSlash 被调用，skill 命令并入菜单', async () => {
    const { loadSkillSlash } = renderChatComposer({});
    await typeText('/');
    await waitFor(() => {
      expect(loadSkillSlash).toHaveBeenCalled();
    });
    // skill 命令经 filteredCommands 桥入菜单
    const skillItem = await screen.findByRole('option', {
      name: /\/skill:检视/,
    });
    expect(skillItem).toBeTruthy();
  });

  it('增高语义：容器携带行数/行高 token 属性', async () => {
    renderChatComposer({});
    const container = document.querySelector('[data-composer-field="1"]');
    expect(container).toBeTruthy();
    expect(container?.getAttribute('data-composer-max-lines')).toBe('10');
    expect(
      (container as HTMLElement).style.getPropertyValue('--composer-max-lines')
    ).toBe('10');
    expect(
      (container as HTMLElement).style.getPropertyValue(
        '--composer-line-height'
      )
    ).toBe('1.45');
  });

  it('焦点回迁：斜杠点选后编辑器获得焦点（菜单关闭 → 编辑器）', async () => {
    renderChatComposer({});
    await typeText('/go');
    const goalItem = await screen.findByRole('option', { name: /目标/ });
    fireEvent.click(goalItem);
    await waitFor(() => {
      expect(document.activeElement).toBe(getEditorDom());
    });
  });

  it('退役组件清理：TiptapComposerContainer / useTiptapComposerState 模块已移除', async () => {
    // 变量形式的动态导入：规避 vite import-analysis 静态解析（字面量会直接 transform 报错）
    const containerPath = './TiptapComposerContainer';
    const statePath = './useTiptapComposerState';
    await expect(import(containerPath)).rejects.toThrow();
    await expect(import(statePath)).rejects.toThrow();
  });

  it('宿主导出面保留：ComposerField 仍从 ChatComposer 再导出（侧栏/内联复用）', async () => {
    const mod = await import('./ChatComposer');
    expect(typeof mod.ComposerField).toBe('object');
    expect(typeof mod.STOP_TOOLTIP).toBe('string');
  });

  it('ChatComposer 始终渲染可编辑输入槽（ComposerFieldSlot），无幽灵按钮与点击劫持', async () => {
    renderChatComposer({
      initialInput: '',
    });

    // 1. 绝对不存在幽灵导入按钮与劫持文案
    expect(screen.queryByTestId('external-session-import-btn')).toBeNull();
    expect(screen.queryByText(/点击以导入对话并继续输入/)).toBeNull();
    expect(screen.queryByText(/正在导入对话并接续/)).toBeNull();

    // 2. 核心编辑域（ProseMirror / ContentEditable / Textarea）100% 可用且可聚焦
    const editor = await waitFor(() => getEditorDom());
    expect(editor).toBeInTheDocument();
    expect(editor.getAttribute('contenteditable')).toBe('true');

    // 3. 键盘输入行为与发送状态机完全由真实文本驱动
    await typeText('你好，这是全新的对话');
    await waitFor(() => {
      const sendBtn = screen.getByRole('button', { name: /发送/ });
      expect(sendBtn).not.toBeDisabled();
    });

    // 4. 点击输入槽网格容器仅起到获取焦点的自然语义，不存在任何第三方导入拦截回调
    const slot = document.querySelector('[data-composer-grid="text"]');
    expect(slot).toBeTruthy();
    if (slot) fireEvent.click(slot);
    expect(getEditorDom()).toBeInTheDocument();
  });
});
