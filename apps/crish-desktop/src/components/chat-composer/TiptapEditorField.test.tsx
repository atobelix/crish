/**
 * T3 编辑器补全测试（40 方案 T3）：
 * Mention 注册 / CodeBlock Enter 保护 / DOMPurify 粘贴清洗 / IME 三条件门 / 动态占位符。
 * 真实渲染，不 mock TiptapEditorField 本体；waitFor 收口。
 */
// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TiptapEditorField } from './TiptapEditorField';

// jsdom 缺 ClipboardEvent：prosemirror-view.pasteHTML 会构造合成事件，补最小实现
if (typeof (globalThis as Record<string, unknown>).ClipboardEvent === 'undefined') {
  (globalThis as Record<string, unknown>).ClipboardEvent = class ClipboardEvent extends Event {
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

/** 逐字符输入（走 beforeinput 真实事务链） */
function typeText(text: string): void {
  const dom = getEditorDom();
  for (const ch of text) {
    fireEvent.beforeInput(dom, { inputType: 'insertText', data: ch });
  }
}

describe('TiptapEditorField T3 补全', () => {
  it('Mention 注册：markdown 水合渲染 mention chip，序列化双向保真', async () => {
    const onMarkdownChange = vi.fn();
    render(
      <TiptapEditorField content={'提及 @[Agent 史密斯](agent-007:agent)'} onMarkdownChange={onMarkdownChange} />
    );
    const dom = getEditorDom();
    await waitFor(() => {
      expect(dom.textContent).toContain('Agent 史密斯');
    });
    const chip = dom.querySelector('span[data-type="mention"]');
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute('data-id')).toBe('agent-007');
    expect(chip?.getAttribute('data-kind')).toBe('agent');
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
    expect(onMarkdownChange.mock.calls[onMarkdownChange.mock.calls.length - 1][0]).toContain('\n');
  });

  it('普通段落 Enter 发送，且发送后内容清空', async () => {
    const onSendMarkdown = vi.fn();
    render(<TiptapEditorField content="hello world" onSendMarkdown={onSendMarkdown} />);
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
  });

  it('event.isComposing 门：标记中的 Enter 不发送，普通 Enter 恢复发送', async () => {
    const onSendMarkdown = vi.fn();
    render(<TiptapEditorField content="中文" onSendMarkdown={onSendMarkdown} />);
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
    const html = '<p>安全内容</p><script>alert(1)</script><p style="color:red">样式剥离</p>';
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
    const onPasteImage = vi.fn();
    render(<TiptapEditorField onPasteImage={onPasteImage} />);
    const dom = getEditorDom();
    const fakeFile = new File(['x'], 'shot.png', { type: 'image/png' });
    const items = [{ type: 'image/png', getAsFile: () => fakeFile }];
    const eventStub = { items, getData: () => '' };
    fireEvent.paste(dom, { clipboardData: eventStub });
    expect(onPasteImage).toHaveBeenCalledWith(fakeFile, expect.anything());
  });

  it('动态占位符：placeholder prop 切换后重算装饰', async () => {
    const { rerender } = render(<TiptapEditorField placeholder="默认占位" />);
    const dom = getEditorDom();
    await waitFor(() => {
      expect(dom.querySelector('p')?.getAttribute('data-placeholder')).toBe('默认占位');
    });
    rerender(<TiptapEditorField placeholder="处理中占位" />);
    await waitFor(() => {
      expect(dom.querySelector('p')?.getAttribute('data-placeholder')).toBe('处理中占位');
    });
  });

  it('ctrlEnter 偏好：普通 Enter 不发送，Ctrl+Enter 发送', async () => {
    const onSendMarkdown = vi.fn();
    render(
      <TiptapEditorField content="ctrl 消息" sendShortcut="ctrlEnter" onSendMarkdown={onSendMarkdown} />
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
