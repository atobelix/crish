/**
 * T2 适配层契约测试（40 方案 T3 适配层）：
 * props 兼容超集 / 受控值水合 / 发送回流最新 markdown（防抖 150ms 场景）/ IME 门 /
 * processing 占位切换 / 空护栏 / 斜杠系统与 skill 命令接入 / Stop L2。
 * 真实渲染 TiptapComposerField（含 TiptapEditorField 本体），waitFor 收口。
 */
// @vitest-environment jsdom
import React, { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  TiptapComposerField,
  type TiptapComposerFieldProps,
} from './TiptapComposerField';

function getEditorDom(): HTMLElement {
  const el = document.querySelector('[contenteditable="true"]');
  if (!el) throw new Error('编辑器未挂载');
  return el as HTMLElement;
}

/**
 * 输入模拟：jsdom 无原生可编辑行为（PM 文本插入依赖浏览器原生 DOM 变更），
 * 采用「光标处 DOM 变更 + input 事件」驱动 ProseMirror DOMObserver 同步为真实事务。
 * 返回 promise 等待 flush（flushSoon ~20ms）完成后调用方可读最新 state。
 */
async function typeText(text: string): Promise<void> {
  // 等编辑器初始装配/水合事务落定，避免手动 DOM 变更被初始同步覆盖
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
    // 无有效光标（jsdom 常见）：追加到最后一个段落
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
  // 光标移到插入文本之后（suggestion 插件依赖光标前字符判定 / 触发）
  if (sel) {
    const range = document.createRange();
    range.setStart(textNode, textNode.length);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  dom.dispatchEvent(new Event('input', { bubbles: true }));
  // 等待 DOMObserver flush 完成（MutationObserver 微任务 + flushSoon ~20ms 定时）
  await new Promise((r) => setTimeout(r, 50));
}

/**
 * 模拟中文输入法：先 compositionstart，再把字符写进文档，且先不 compositionend。
 * 调用方负责在断言后派发 compositionend。
 */
async function typeTextDuringComposition(text: string): Promise<HTMLElement> {
  await new Promise((r) => setTimeout(r, 60));
  const dom = getEditorDom();
  dom.setAttribute('data-composer-card', '');
  dom.setAttribute('data-mock-rect', '32,640,680,88');
  dom.dispatchEvent(
    new CompositionEvent('compositionstart', { bubbles: true, data: '' })
  );
  const textNode = document.createTextNode(text);
  const lastP = dom.querySelector('p:last-of-type');
  const target = lastP ?? dom;
  target.appendChild(textNode);
  const sel = document.getSelection();
  if (sel) {
    const range = document.createRange();
    range.setStart(textNode, textNode.length);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  dom.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  return dom;
}

/**
 * 宿主语义 Harness：value 状态真相源；onSend 记录发送时的 chatInput 并清空
 * （对齐宿主 handleSendChat 发送后 setChatInput('') 行为）。
 */
function renderAdapter(opts: {
  onSend?: () => void;
  canSend?: boolean;
  isProcessing?: boolean;
  processingPlaceholder?: string;
  placeholder?: string;
  onSlashMenuPick?: (cmd: string) => void;
  skillSlashCommands?: Array<{ cmd: string; desc: string }>;
  extraProps?: Partial<TiptapComposerFieldProps>;
}) {
  const sentValues: string[] = [];
  const onChangeLog: string[] = [];
  const onSend = vi.fn(opts.onSend ?? (() => {}));

  function Harness() {
    const [value, setValue] = useState('');
    const valueRef = useRef(value);
    valueRef.current = value;
    return (
      <TiptapComposerField
        value={value}
        onChange={(v) => {
          onChangeLog.push(v);
          setValue(v);
        }}
        onSend={() => {
          sentValues.push(valueRef.current);
          onSend();
          setValue('');
        }}
        canSend={opts.canSend ?? true}
        isComposing={opts.isComposing ?? false}
        setIsComposing={() => {}}
        isProcessing={opts.isProcessing ?? false}
        processingPlaceholder={opts.processingPlaceholder}
        placeholder={opts.placeholder}
        onSlashMenuPick={opts.onSlashMenuPick}
        skillSlashCommands={opts.skillSlashCommands}
        {...opts.extraProps}
      />
    );
  }

  const utils = render(<Harness />);
  return { ...utils, sentValues, onChangeLog, onSend };
}

describe('TiptapComposerField 适配层契约（T2）', () => {
  it('受控值注入水合：value 渲染为编辑器内容，外部更新同步', async () => {
    const { rerender } = renderAdapter({
      extraProps: { value: '你好 **世界**' },
    });
    await waitFor(() => {
      expect(getEditorDom().textContent).toContain('你好');
    });
    expect(getEditorDom().querySelector('strong')?.textContent).toBe('世界');
    rerender(
      <TiptapComposerField
        value="第二段内容"
        onChange={() => {}}
        onSend={() => {}}
        canSend
        isComposing={false}
        setIsComposing={() => {}}
      />
    );
    // rerender 后编辑器实例更换，需重新查询 DOM
    await waitFor(() => {
      expect(getEditorDom().textContent).toContain('第二段内容');
    });
  });

  it('Enter 发送携带最新 markdown（防抖 150ms 内快速回车不丢内容）', async () => {
    const { sentValues, onSend } = renderAdapter({});
    await typeText('测试消息');
    // 不等 150ms 防抖，立即 Enter → 宿主 chatInput 必须已是最新文本
    fireEvent.keyDown(getEditorDom(), { key: 'Enter' });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
    expect(sentValues).toEqual(['测试消息']);
    // 发送后编辑器清空（宿主 setChatInput('') 语义下）
    await waitFor(() => {
      expect(getEditorDom().textContent).toBe('');
    });
  });

  it('防抖回流：输入 150ms 后 onChange 收到完整 markdown', async () => {
    const { onChangeLog } = renderAdapter({});
    await typeText('防抖回流');
    await waitFor(() => {
      expect(onChangeLog).toContain('防抖回流');
    });
  });

  it('IME 门：isComposing 标记中的 Enter 不发送，恢复后发送', async () => {
    const { onSend } = renderAdapter({});
    const dom = getEditorDom();
    await typeText('中文输入');
    fireEvent.keyDown(dom, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(dom, { key: 'Enter' });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
  });

  it('processing 态占位切换：双态占位符随 isProcessing 切换', async () => {
    const { rerender } = renderAdapter({
      isProcessing: true,
      processingPlaceholder: '输入排队消息…',
      placeholder: '输入消息…',
    });
    await waitFor(() => {
      expect(
        getEditorDom().querySelector('p')?.getAttribute('data-placeholder')
      ).toBe('输入排队消息…');
    });
    rerender(
      <TiptapComposerField
        value=""
        onChange={() => {}}
        onSend={() => {}}
        canSend
        isComposing={false}
        setIsComposing={() => {}}
        isProcessing={false}
        placeholder="输入消息…"
      />
    );
    await waitFor(() => {
      expect(
        getEditorDom().querySelector('p')?.getAttribute('data-placeholder')
      ).toBe('输入消息…');
    });
  });

  it('空护栏：canSend=false 时 Enter 不发送，文本经水合恢复', async () => {
    const { onSend } = renderAdapter({ canSend: false });
    const dom = getEditorDom();
    await typeText('待发送文本');
    fireEvent.keyDown(dom, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 30));
    expect(onSend).not.toHaveBeenCalled();
    // 编辑器内容恢复（宿主保留文本，二次 Enter 可发送）
    await waitFor(() => {
      expect(getEditorDom().textContent).toContain('待发送文本');
    });
  });

  it('斜杠系统命令：/goal 在菜单中可选，点选后文本注入编辑器并回流宿主', async () => {
    const { onChangeLog } = renderAdapter({});
    await typeText('/');
    const goalItem = await screen.findByRole('option', { name: /目标/ });
    fireEvent.click(goalItem);
    // 胶囊展示「目标」；序列化回流仍是 /goal，供目标模式识别
    await waitFor(() => {
      expect(getEditorDom().textContent).toContain('目标');
      expect(getEditorDom().textContent ?? '').not.toContain('/goal');
      expect(document.querySelector('.mention-chip-goal')).toBeTruthy();
    });
    await waitFor(() => {
      expect(onChangeLog).toContain('/goal');
    });
    fireEvent.click(screen.getByRole('button', { name: '移除目标' }));
    await waitFor(() => {
      expect(getEditorDom().textContent ?? '').not.toContain('目标');
    });
  });

  it('斜杠 /schedule 点选：填入对话模板前缀（维度三 §2.6——不再转交宿主回调）', async () => {
    const { onChangeLog } = renderAdapter({});
    await typeText('/');
    const scheduleItem = await screen.findByRole('option', {
      name: /schedule/,
    });
    fireEvent.click(scheduleItem);
    // 编辑器芯片展示 'schedule'（无斜杠）；序列化回流仍是 /schedule
    await waitFor(() => {
      expect(getEditorDom().textContent).toContain('schedule');
    });
    await waitFor(() => {
      expect(onChangeLog).toContain('/schedule');
    });
  });

  it('skill 命令接入：动态 skillSlashCommands 并入菜单并文本注入', async () => {
    const { onChangeLog } = renderAdapter({
      skillSlashCommands: [{ cmd: '/skill:检视', desc: '检视代码质量' }],
    });
    await typeText('/');
    const skillItem = await screen.findByRole('option', {
      name: /检视/,
    });
    fireEvent.click(skillItem);
    await waitFor(() => {
      expect(getEditorDom().textContent).toContain('检视');
      expect(document.querySelector('.mention-chip-skill')).toBeTruthy();
      expect(document.querySelector('.mention-chip-goal')).toBeNull();
    });
    await waitFor(() => {
      expect(onChangeLog.some((val) => val.includes('/skill:检视'))).toBe(true);
    });
  });

  it('中文顿号上屏后仍是顿号，并打开同一套命令菜单', async () => {
    const { onChangeLog } = renderAdapter({});
    const dom = await typeTextDuringComposition('、');
    dom.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: '、' })
    );
    await waitFor(() => {
      expect(getEditorDom().textContent).toContain('、');
      expect(getEditorDom().textContent ?? '').not.toContain('/');
    });
    const goalItem = await screen.findByRole('option', { name: /目标/ });
    fireEvent.click(goalItem);
    await waitFor(() => {
      expect(getEditorDom().textContent).toContain('目标');
    });
    await waitFor(() => {
      expect(onChangeLog).toContain('/goal');
    });
  });

  it('直接输入顿号会打开同一套命令菜单，顿号留在正文', async () => {
    const { onChangeLog } = renderAdapter({});
    await typeText('、');
    await waitFor(() => {
      expect(getEditorDom().textContent).toContain('、');
      expect(getEditorDom().textContent ?? '').not.toContain('/');
    });
    const goalItem = await screen.findByRole('option', {
      name: /目标/,
    });
    fireEvent.click(goalItem);
    await waitFor(() => {
      expect(getEditorDom().textContent).toContain('目标');
    });
    await waitFor(() => {
      expect(onChangeLog).toContain('/goal');
    });
  });

  it('顿号后继续写中文时，顿号留在正文且菜单关闭', async () => {
    renderAdapter({});
    await typeText('、');
    await screen.findByRole('option', { name: /目标/ });
    await typeText('香蕉');
    await waitFor(() => {
      expect(getEditorDom().textContent).toContain('、香蕉');
    });
    expect(screen.queryByRole('option', { name: /目标/ })).toBeNull();
  });

  it('句中顿号保持正文，不打开斜杠菜单', async () => {
    renderAdapter({});
    await typeText('你好、世界');
    await waitFor(() => {
      expect(getEditorDom().textContent).toContain('你好、世界');
    });
    expect(screen.queryByRole('option', { name: /目标/ })).toBeNull();
  });

  it('Stop L2：处理中显示停止钮，单击触发 onStop（不触发 force）', async () => {
    const onStop = vi.fn();
    const { onSend } = renderAdapter({
      isProcessing: true,
      extraProps: { onStop },
    });
    const stop = screen.getByTestId('composer-stop');
    expect(stop.getAttribute('data-stop-level')).toBe('l2');
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('发送钮点击：宿主已同步时直发', async () => {
    const { sentValues, onSend } = renderAdapter({});
    await typeText('按钮发送');
    // 等防抖回流完成（宿主已同步）
    await new Promise((r) => setTimeout(r, 200));
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
    expect(sentValues).toEqual(['按钮发送']);
  });

  it('TiptapComposerField 剪贴板文件接管：粘贴物理文件正确分发至 onPasteFiles', async () => {
    const onPasteFiles = vi.fn();
    render(
      <TiptapComposerField
        value=""
        onChange={() => {}}
        onSend={() => {}}
        canSend={true}
        isComposing={false}
        setIsComposing={() => {}}
        onPasteFiles={onPasteFiles}
      />
    );
    const dom = getEditorDom();
    const codeFile = new File(['const x = 42;'], 'index.ts', {
      type: 'text/typescript',
    });
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        files: [codeFile],
        items: [],
        getData: () => '',
      },
    });
    dom.dispatchEvent(pasteEvent);
    expect(onPasteFiles).toHaveBeenCalledWith([codeFile]);
  });

  it('TiptapComposerField 剪贴板文件接管回退：未提供 onPasteFiles 时回退至 onFilesSelected', async () => {
    const onFilesSelected = vi.fn();
    render(
      <TiptapComposerField
        value=""
        onChange={() => {}}
        onSend={() => {}}
        canSend={true}
        isComposing={false}
        setIsComposing={() => {}}
        onFilesSelected={onFilesSelected}
      />
    );
    const dom = getEditorDom();
    const codeFile = new File(['const x = 42;'], 'index.ts', {
      type: 'text/typescript',
    });
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        files: [codeFile],
        items: [],
        getData: () => '',
      },
    });
    dom.dispatchEvent(pasteEvent);
    expect(onFilesSelected).toHaveBeenCalledWith([codeFile]);
  });
});
