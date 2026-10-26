/**
 * T3 编辑器补全测试（40 方案 T3）：
 * Mention 注册 / CodeBlock Enter 保护 / DOMPurify 粘贴清洗 / IME 三条件门 / 动态占位符。
 * 真实渲染，不 mock TiptapEditorField 本体；waitFor 收口。
 */
// @vitest-environment jsdom
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';

const acceptsImageMock = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../api/modelVisionSupport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/modelVisionSupport')>();
  return {
    ...actual,
    activeModelAcceptsImage: () => acceptsImageMock(),
  };
});

import { TiptapEditorField } from './TiptapEditorField';
import { useSettingsStore } from '../../store/settingsStore';

// jsdom 缺 ClipboardEvent：prosemirror-view.pasteHTML 会构造合成事件，补最小实现
if (
  typeof (globalThis as Record<string, unknown>).ClipboardEvent === 'undefined'
) {
  (globalThis as Record<string, unknown>).ClipboardEvent =
    class ClipboardEvent extends Event {
      clipboardData: DataTransfer | null;
      constructor(type: string, init?: { clipboardData?: DataTransfer }) {
        super(type);
        this.clipboardData = init?.clipboardData ?? null;
      }
    };
}

function getEditorDom(): HTMLElement {
  const el = document.querySelector('[contenteditable="true"]');
  if (!el) throw new Error('编辑器未挂载');
  return el as HTMLElement;
}

/**
 * 输入模拟：jsdom 无原生可编辑行为（PM 文本插入依赖浏览器原生 DOM 变更），
 * 采用「光标处 DOM 变更 + input 事件」驱动 ProseMirror DOMObserver 同步为真实事务
 * （与 TiptapComposerField.test 同款；beforeinput 合成事件在 jsdom 下不被 PM 消费）。
 */
async function typeText(text: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 60));
  const dom = getEditorDom();
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

describe('TiptapEditorField T3 补全', () => {
  beforeEach(() => {
    acceptsImageMock.mockReturnValue(true);
  });

  it('Mention 注册：markdown 水合渲染 mention chip，序列化双向保真', async () => {
    const onMarkdownChange = vi.fn();
    render(
      <TiptapEditorField
        content={'提及 @[Agent 史密斯](agent-007:agent)'}
        onMarkdownChange={onMarkdownChange}
      />
    );
    const dom = getEditorDom();
    await waitFor(() => {
      expect(dom.textContent).toContain('Agent 史密斯');
    });
    const chip = dom.querySelector('span[data-type="mention"]');
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute('data-id')).toBe('agent-007');
    expect(chip?.getAttribute('data-kind')).toBe('agent');
    expect(chip?.getAttribute('data-file-open-path')).toBeNull();
  });

  it('file mention 水合带 data-file-open-path', async () => {
    render(
      <TiptapEditorField
        content={'请看 @[index.ts](src/index.ts:file)'}
        onMarkdownChange={vi.fn()}
      />
    );
    const dom = getEditorDom();
    await waitFor(() => {
      expect(dom.textContent).toContain('index.ts');
    });
    const chip = dom.querySelector('span[data-type="mention"]');
    expect(chip?.getAttribute('data-kind')).toBe('file');
    expect(chip?.getAttribute('data-id')).toBe('src/index.ts');
    expect(chip?.getAttribute('data-file-open-path')).toBe('src/index.ts');
  });

  it('CodeBlock Enter 保护：代码块内 Enter 只换行，不触发发送', async () => {
    const onSendMarkdown = vi.fn();
    const onMarkdownChange = vi.fn();
    render(
      <TiptapEditorField
        content={'```ts\nconst a = 1;\n```'}
        onSendMarkdown={onSendMarkdown}
        onMarkdownChange={onMarkdownChange}
      />
    );
    const dom = getEditorDom();
    // 水合完成后光标默认在文档起始（codeBlock 内）
    await waitFor(() => {
      expect(dom.textContent).toContain('const a = 1;');
    });
    fireEvent.keyDown(dom, { key: 'Enter' });
    expect(onSendMarkdown).not.toHaveBeenCalled();
    // Enter 换行生效（内容发生变化而非发送）
    await waitFor(() => {
      expect(onMarkdownChange).toHaveBeenCalledWith(
        expect.stringContaining('```ts')
      );
    });
    expect(
      onMarkdownChange.mock.calls[onMarkdownChange.mock.calls.length - 1][0]
    ).toContain('\n');
  });

  it('代码块内 Tab 在光标处插入 codeBlockIndent（默认 2 空格）', async () => {
    const onSendMarkdown = vi.fn();
    const onMarkdownChange = vi.fn();
    render(
      <TiptapEditorField
        content={'```ts\nconst a = 1;\n```'}
        onSendMarkdown={onSendMarkdown}
        onMarkdownChange={onMarkdownChange}
      />
    );
    const dom = getEditorDom();
    await waitFor(() => {
      expect(dom.textContent).toContain('const a = 1;');
    });
    fireEvent.keyDown(dom, { key: 'Tab' });
    expect(onSendMarkdown).not.toHaveBeenCalled();
    await waitFor(() => {
      const last =
        onMarkdownChange.mock.calls[
          onMarkdownChange.mock.calls.length - 1
        ]?.[0];
      expect(last).toContain('const a = 1;  ');
    });
  });

  it('代码块内 Tab 插入 4 空格当 markdown.codeBlockIndent 为 4 空格', async () => {
    useSettingsStore.setState({
      appSettings: { markdown: { codeBlockIndent: '    ' } } as never,
    });
    try {
      const onMarkdownChange = vi.fn();
      render(
        <TiptapEditorField
          content={'```ts\nconst a = 1;\n```'}
          onMarkdownChange={onMarkdownChange}
        />
      );
      const dom = getEditorDom();
      await waitFor(() => {
        expect(dom.textContent).toContain('const a = 1;');
      });
      fireEvent.keyDown(dom, { key: 'Tab' });
      await waitFor(() => {
        const last =
          onMarkdownChange.mock.calls[
            onMarkdownChange.mock.calls.length - 1
          ]?.[0];
        expect(last).toContain('const a = 1;    ');
      });
    } finally {
      useSettingsStore.setState({ appSettings: null });
    }
  });

  it('普通段落 Enter 发送，且发送后内容清空', async () => {
    const onSendMarkdown = vi.fn();
    render(
      <TiptapEditorField
        content="hello world"
        onSendMarkdown={onSendMarkdown}
      />
    );
    const dom = getEditorDom();
    await waitFor(() => {
      expect(dom.textContent).toContain('hello world');
    });
    fireEvent.keyDown(dom, { key: 'Enter' });
    expect(onSendMarkdown).toHaveBeenCalledWith('hello world');
    await waitFor(() => {
      expect(dom.textContent).toBe('');
    });
  });

  it('IME 三条件门：composition 期间 Enter 不发送，composition 状态同步宿主', async () => {
    const onSendMarkdown = vi.fn();
    const onCompositionChange = vi.fn();
    render(
      <TiptapEditorField
        content="中文"
        onSendMarkdown={onSendMarkdown}
        onCompositionChange={onCompositionChange}
      />
    );
    const dom = getEditorDom();
    await waitFor(() => {
      expect(dom.textContent).toContain('中文');
    });
    // DOM 监听 → isComposingRef 置位并同步宿主
    fireEvent.compositionStart(dom);
    expect(onCompositionChange).toHaveBeenLastCalledWith(true);
    // composition 中 Enter：view.composing / isComposingRef 双保险拦截，绝不发送
    fireEvent.keyDown(dom, { key: 'Enter' });
    expect(onSendMarkdown).not.toHaveBeenCalled();
    // composition 结束 → 状态复位同步宿主
    fireEvent.compositionEnd(dom);
    expect(onCompositionChange).toHaveBeenLastCalledWith(false);
    fireEvent.blur(dom);
    expect(onCompositionChange).toHaveBeenCalledTimes(2);
  });

  it('组合期间 blur 保留聊天草稿、解锁状态并忽略迟到的 compositionend', async () => {
    const onCompositionChange = vi.fn();

    function Harness() {
      const [content, setContent] = React.useState('已有草稿');
      return (
        <TiptapEditorField
          content={content}
          onMarkdownChange={setContent}
          onCompositionChange={onCompositionChange}
        />
      );
    }

    render(<Harness />);
    const dom = getEditorDom();
    await waitFor(() => expect(dom.textContent).toContain('已有草稿'));

    fireEvent.compositionStart(dom);
    await typeText('中文草稿');
    const draftAtBlur = dom.textContent;
    expect(draftAtBlur).toContain('中文草稿');

    fireEvent.blur(dom);
    expect(onCompositionChange.mock.calls).toEqual([[true], [false]]);
    await waitFor(() => expect(dom.textContent).toBe(draftAtBlur));

    fireEvent.compositionEnd(dom);
    expect(onCompositionChange).toHaveBeenCalledTimes(2);
    expect(dom.textContent).toBe(draftAtBlur);
  });

  it('blur 消费组合期间最新外部草稿更新，迟到结束事件不重复应用', async () => {
    const onCompositionChange = vi.fn();
    const { rerender } = render(
      <TiptapEditorField
        content="旧草稿"
        onMarkdownChange={vi.fn()}
        onCompositionChange={onCompositionChange}
      />
    );
    const dom = getEditorDom();
    await waitFor(() => expect(dom.textContent).toContain('旧草稿'));

    fireEvent.compositionStart(dom);
    rerender(
      <TiptapEditorField
        content="较新的外部草稿"
        onMarkdownChange={vi.fn()}
        onCompositionChange={onCompositionChange}
      />
    );
    fireEvent.blur(dom);

    await waitFor(() => expect(dom.textContent).toContain('较新的外部草稿'));
    expect(onCompositionChange.mock.calls).toEqual([[true], [false]]);
    fireEvent.compositionEnd(dom);
    expect(onCompositionChange).toHaveBeenCalledTimes(2);
    expect(dom.textContent).toContain('较新的外部草稿');
  });

  it('event.isComposing 门：标记中的 Enter 不发送，普通 Enter 恢复发送', async () => {
    const onSendMarkdown = vi.fn();
    render(
      <TiptapEditorField content="中文" onSendMarkdown={onSendMarkdown} />
    );
    const dom = getEditorDom();
    await waitFor(() => {
      expect(dom.textContent).toContain('中文');
    });
    fireEvent.keyDown(dom, { key: 'Enter', isComposing: true });
    expect(onSendMarkdown).not.toHaveBeenCalled();
    fireEvent.keyDown(dom, { key: 'Enter' });
    expect(onSendMarkdown).toHaveBeenCalledTimes(1);
  });

  it('DOMPurify 粘贴清洗：script 被剥离，安全内容保留', async () => {
    render(<TiptapEditorField />);
    const dom = getEditorDom();
    const html =
      '<p>安全内容</p><script>alert(1)</script><p style="color:red">样式剥离</p>';
    fireEvent.paste(dom, {
      clipboardData: {
        items: [],
        getData: (type: string) => (type === 'text/html' ? html : ''),
      },
    });
    await waitFor(() => {
      expect(dom.textContent).toContain('安全内容');
    });
    expect(dom.querySelector('script')).toBeNull();
    const styled = dom.querySelector('p[style]');
    expect(styled).toBeNull();
    expect(dom.textContent).toContain('样式剥离');
  });

  it('图片粘贴转发原事件与文件（适配层附件链）', async () => {
    acceptsImageMock.mockReturnValue(true);
    const onPasteImage = vi.fn();
    render(<TiptapEditorField onPasteImage={onPasteImage} />);
    const dom = getEditorDom();
    const fakeFile = new File(['x'], 'shot.png', { type: 'image/png' });
    const items = [{ type: 'image/png', getAsFile: () => fakeFile }];
    const eventStub = { items, getData: () => '' };
    fireEvent.paste(dom, { clipboardData: eventStub });
    expect(onPasteImage).toHaveBeenCalledWith(fakeFile, expect.anything());
  });

  it('无视觉时粘贴图片不转交附件链（不 preventDefault 成附件）', async () => {
    acceptsImageMock.mockReturnValue(false);
    const onPasteImage = vi.fn();
    render(<TiptapEditorField onPasteImage={onPasteImage} />);
    const dom = getEditorDom();
    const fakeFile = new File(['x'], 'shot.png', { type: 'image/png' });
    const items = [{ type: 'image/png', getAsFile: () => fakeFile }];
    fireEvent.paste(dom, {
      clipboardData: { items, getData: () => '' },
    });
    expect(onPasteImage).not.toHaveBeenCalled();
  });

  it('剪贴板物理文件接管（模块 C）：clipboardData.files 优先提取并调用 onPasteFiles，阻止默认行为', async () => {
    const onPasteFiles = vi.fn();
    render(<TiptapEditorField onPasteFiles={onPasteFiles} />);
    const dom = getEditorDom();
    const fakeFile1 = new File(['fn main() {}'], 'main.rs', {
      type: 'text/rust',
    });
    const fakeFile2 = new File(['# Title'], 'doc.md', {
      type: 'text/markdown',
    });

    let prevented = false;
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'preventDefault', {
      value: () => {
        prevented = true;
      },
    });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        files: [fakeFile1, fakeFile2],
        items: [],
        getData: () => '',
      },
    });

    dom.dispatchEvent(pasteEvent);

    expect(prevented).toBe(true);
    expect(onPasteFiles).toHaveBeenCalledWith([fakeFile1, fakeFile2]);
  });

  it('优先提取物理文件：当 clipboardData 同时存在 files 与 text/html 时，优先分发 files 而不走 html 清洗', async () => {
    const onPasteFiles = vi.fn();
    render(<TiptapEditorField onPasteFiles={onPasteFiles} />);
    const dom = getEditorDom();
    const fakeFile = new File(['print("hi")'], 'script.py', {
      type: 'text/x-python',
    });
    const html = '<p>should not be pasted as html</p>';

    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        files: [fakeFile],
        items: [],
        getData: (type: string) => (type === 'text/html' ? html : ''),
      },
    });

    dom.dispatchEvent(pasteEvent);

    expect(onPasteFiles).toHaveBeenCalledWith([fakeFile]);
    expect(dom.textContent).not.toContain('should not be pasted as html');
  });

  it('非图片物理文件不受视觉限制：即使当前无视觉，代码或文档物理文件依然正常被接管派发', async () => {
    acceptsImageMock.mockReturnValue(false);
    const onPasteFiles = vi.fn();
    render(<TiptapEditorField onPasteFiles={onPasteFiles} />);
    const dom = getEditorDom();
    const docFile = new File(['content'], 'notes.txt', { type: 'text/plain' });

    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        files: [docFile],
        items: [],
        getData: () => '',
      },
    });

    dom.dispatchEvent(pasteEvent);

    expect(onPasteFiles).toHaveBeenCalledWith([docFile]);
  });

  it('动态占位符：placeholder prop 切换后重算装饰', async () => {
    const { rerender } = render(<TiptapEditorField placeholder="默认占位" />);
    const dom = getEditorDom();
    await waitFor(() => {
      expect(dom.querySelector('p')?.getAttribute('data-placeholder')).toBe(
        '默认占位'
      );
    });
    rerender(<TiptapEditorField placeholder="处理中占位" />);
    await waitFor(() => {
      expect(dom.querySelector('p')?.getAttribute('data-placeholder')).toBe(
        '处理中占位'
      );
    });
  });

  it('ctrlEnter 偏好：普通 Enter 不发送，Ctrl+Enter 发送', async () => {
    const onSendMarkdown = vi.fn();
    render(
      <TiptapEditorField
        content="ctrl 消息"
        sendShortcut="ctrlEnter"
        onSendMarkdown={onSendMarkdown}
      />
    );
    const dom = getEditorDom();
    await waitFor(() => {
      expect(dom.textContent).toContain('ctrl 消息');
    });
    fireEvent.keyDown(dom, { key: 'Enter' });
    expect(onSendMarkdown).not.toHaveBeenCalled();
    fireEvent.keyDown(dom, { key: 'Enter', ctrlKey: true });
    expect(onSendMarkdown).toHaveBeenCalledWith('ctrl 消息');
  });

  it('命令式句柄 getMarkdown：绕过防抖同步读取', async () => {
    const ref = React.createRef<{ getMarkdown: () => string }>();
    render(<TiptapEditorField ref={ref} content="同步内容" />);
    await waitFor(() => {
      expect(getEditorDom().textContent).toContain('同步内容');
    });
    expect(ref.current?.getMarkdown()).toBe('同步内容');
    expect(screen.getByTestId('chat-input')).toBeTruthy();
  });
});

describe('TiptapEditorField T8 提及与 aria 全链', () => {
  it('空候选人兜底：@ 不弹面板、不崩溃', async () => {
    render(<TiptapEditorField content="测试" />);
    const dom = getEditorDom();
    await waitFor(() => {
      expect(dom.textContent).toContain('测试');
    });
    await typeText('@');
    await new Promise((r) => setTimeout(r, 300));
    // 空候选人时不挂载弹层（无 listbox、无 option）
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(dom.getAttribute('aria-expanded')).toBeNull();
    expect(dom.textContent).toContain('@');
  });

  it('@ 触发提及菜单，点选插入 mention chip 并序列化 @[label](id:kind)', async () => {
    const onMarkdownChange = vi.fn();
    render(
      <TiptapEditorField
        content="请分析"
        mentionCandidates={[
          { id: 'agent-007', label: 'Agent 史密斯', kind: 'agent' },
          { id: 'file-1', label: 'index.ts', kind: 'file' },
        ]}
        onMarkdownChange={onMarkdownChange}
      />
    );
    const dom = getEditorDom();
    await waitFor(() => {
      expect(dom.textContent).toContain('请分析');
    });
    await typeText('@');
    // 提及弹层打开：aria-controls 指向 -mention listbox
    await waitFor(() => {
      expect(dom.getAttribute('aria-expanded')).toBe('true');
    });
    const listboxId = dom.getAttribute('aria-controls') ?? '';
    expect(listboxId.endsWith('-mention')).toBe(true);
    const listbox = () => document.getElementById(listboxId);
    await waitFor(() => {
      expect(listbox()?.textContent).toContain('Agent 史密斯');
    });
    // 点选候选人 → 插入 mention chip
    const agentOption = listbox()?.querySelector('button');
    expect(agentOption).toBeTruthy();
    fireEvent.click(agentOption as HTMLButtonElement);
    await waitFor(() => {
      expect(dom.querySelector('span[data-type="mention"]')).toBeTruthy();
    });
    const chip = dom.querySelector('span[data-type="mention"]');
    expect(chip?.getAttribute('data-id')).toBe('agent-007');
    expect(chip?.getAttribute('data-kind')).toBe('agent');
    // 防抖后回流宿主 markdown 含双向保真语法
    await waitFor(() => {
      expect(onMarkdownChange).toHaveBeenCalledWith(
        expect.stringContaining('@[Agent 史密斯](agent-007:agent)')
      );
    });
  });

  it('combobox 基链常驻：role/haspopup/autocomplete', async () => {
    render(<TiptapEditorField ariaLabel="主对话输入" />);
    const dom = getEditorDom();
    await waitFor(() => {
      expect(dom.getAttribute('role')).toBe('combobox');
    });
    expect(dom.getAttribute('aria-label')).toBe('主对话输入');
    expect(dom.getAttribute('aria-haspopup')).toBe('listbox');
    expect(dom.getAttribute('aria-autocomplete')).toBe('list');
  });

  it('斜杠弹层 aria 全链：打开置位 expanded/controls，漫游更新 activedescendant，Esc 清理', async () => {
    render(<TiptapEditorField />);
    const dom = getEditorDom();
    await waitFor(() => {
      expect(dom.getAttribute('role')).toBe('combobox');
    });
    await typeText('/');
    // 斜杠弹层打开：aria-expanded/controls 置位（controls 指向 -slash listbox）
    await waitFor(() => {
      expect(dom.getAttribute('aria-expanded')).toBe('true');
    });
    const listboxId = dom.getAttribute('aria-controls') ?? '';
    expect(listboxId.endsWith('-slash')).toBe(true);
    await waitFor(() => {
      expect(document.getElementById(listboxId)?.textContent).toContain('目标');
    });
    // 初始高亮首项，activedescendant 指向 listbox 内 option
    expect(dom.getAttribute('aria-activedescendant')).toBe(
      `${listboxId}-opt-0`
    );
    // 键盘漫游：ArrowDown 高亮下一项，activedescendant 跟随
    fireEvent.keyDown(dom, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(dom.getAttribute('aria-activedescendant')).toBe(
        `${listboxId}-opt-1`
      );
    });
    // Esc 关闭：combobox 弹层 aria 全部清理
    fireEvent.keyDown(dom, { key: 'Escape' });
    await waitFor(() => {
      expect(dom.getAttribute('aria-expanded')).toBeNull();
    });
    expect(dom.getAttribute('aria-controls')).toBeNull();
    expect(dom.getAttribute('aria-activedescendant')).toBeNull();
    expect(document.getElementById(listboxId)).toBeNull();
  });
});

// ──────────────────────────────────────────────
// R-08（08-detail T5.5）：大文档序列化阈值警告
describe('TiptapEditorField 大文档警告（R-08）', () => {
  it('超过阈值（50KB）→ onOversizeWarning 回调一次；回落后再超可再次触发', async () => {
    const warns: number[] = [];
    const { unmount } = render(
      <TiptapEditorField onOversizeWarning={(n) => warns.push(n)} />
    );
    const dom = getEditorDom();
    // 大文档输入（阈值 50KB 之上）
    const big = '大文档段落。' + 'x'.repeat(52 * 1024);
    await act(async () => {
      dom.textContent = big;
      dom.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // 防抖 150ms 末帧序列化 → 警告
    await waitFor(() => {
      expect(warns.length).toBe(1);
      expect(warns[0]).toBeGreaterThan(50000);
    });
    // 同阈值内继续输入（不再次警告）
    await act(async () => {
      dom.textContent = big + 'y';
      dom.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(warns.length).toBe(1);
    // 清空回落 → 可再次触发
    await act(async () => {
      dom.textContent = '';
      dom.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 250));
    await act(async () => {
      dom.textContent = '再次大文档。' + 'z'.repeat(52 * 1024);
      dom.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitFor(() => {
      expect(warns.length).toBe(2);
    });
    unmount();
  });

  it('阈值以下不触发警告', async () => {
    const warns: number[] = [];
    render(<TiptapEditorField onOversizeWarning={(n) => warns.push(n)} />);
    const dom = getEditorDom();
    await act(async () => {
      dom.textContent = '正常大小的文档内容';
      dom.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(warns).toHaveLength(0);
  });
});
