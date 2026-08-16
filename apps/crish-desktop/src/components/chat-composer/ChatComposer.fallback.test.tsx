/**
 * F1-γ 契约兜底：富文本（TiptapComposerField）装配失败时，
 * 主对话输入回落 textarea（ComposerField）且可正常发送纯文本。
 * 模拟方式：vi.mock TiptapComposerField 为「渲染即抛错」组件，
 * InputFieldErrorBoundary 捕获 → richTextFailed → textarea 分支。
 */
// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ChatComposerProps } from './ChatComposer';

// 富文本装配失败模拟：模块加载成功但渲染即抛错
vi.mock('./TiptapComposerField', () => ({
  TiptapComposerField: () => {
    throw new Error('tiptap-assembly-boom');
  },
}));

import { ChatComposer } from './ChatComposer';

function renderFallbackHarness() {
  const onSend = vi.fn();
  const sentValues: string[] = [];

  function Harness() {
    const [input, setInput] = React.useState('');
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const [permission, setPermission] = React.useState<
      'ask' | 'deep' | 'full' | 'plan'
    >('ask');
    const [composing, setComposing] = React.useState(false);
    const inputRef = React.useRef(input);
    inputRef.current = input;
    return (
      <ChatComposer
        chatInput={input}
        setChatInput={setInput}
        isComposing={composing}
        setIsComposing={setComposing}
        filteredCommands={[]}
        loadSkillSlash={vi.fn()}
        onPasteImage={vi.fn()}
        onSend={() => {
          sentValues.push(inputRef.current);
          onSend();
          setInput('');
        }}
        onStop={vi.fn()}
        onForceStop={vi.fn()}
        canSend={Boolean(input.trim())}
        isProcessing={false}
        attachments={[]}
        setAttachments={(() => {}) as ChatComposerProps['setAttachments']}
        fileInputRef={fileInputRef}
        onFilesSelected={vi.fn()}
        showPlusMenu={false}
        setShowPlusMenu={() => {}}
        permissionMode={permission}
        onPermissionChange={setPermission}
        onOpenSchedule={vi.fn()}
      />
    );
  }

  render(<Harness />);
  return { onSend, sentValues };
}

describe('ChatComposer F1-γ 兜底（富文本装配失败 → textarea）', () => {
  it('失败后切换 data-input-field=textarea 并渲染 textarea', async () => {
    renderFallbackHarness();
    await waitFor(() => {
      expect(
        document
          .querySelector('[data-input-field]')
          ?.getAttribute('data-input-field')
      ).toBe('textarea');
    });
    const ta = document.querySelector('textarea[data-testid="chat-input"]');
    expect(ta).toBeTruthy();
    // 富文本不再挂载（contenteditable 根不存在）
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
  });

  it('textarea 兜底可输入并 Enter 发送纯文本（契约 onSend 直调）', async () => {
    const { onSend, sentValues } = renderFallbackHarness();
    await waitFor(() => {
      expect(
        document
          .querySelector('[data-input-field]')
          ?.getAttribute('data-input-field')
      ).toBe('textarea');
    });
    const ta = document.querySelector(
      'textarea[data-testid="chat-input"]'
    ) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '兜底纯文本' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
    expect(sentValues).toEqual(['兜底纯文本']);
  });

  it('撤回按钮链不受兜底影响（onRetract 常显可点）', async () => {
    const onRetract = vi.fn();
    function RetractHarness() {
      const [input, setInput] = React.useState('');
      const fileInputRef = React.useRef<HTMLInputElement>(null);
      const [permission, setPermission] = React.useState<
        'ask' | 'deep' | 'full' | 'plan'
      >('ask');
      const [composing, setComposing] = React.useState(false);
      return (
        <ChatComposer
          chatInput={input}
          setChatInput={setInput}
          isComposing={composing}
          setIsComposing={setComposing}
          filteredCommands={[]}
          loadSkillSlash={vi.fn()}
          onPasteImage={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
          onRetract={onRetract}
          canRetract
          canSend={false}
          isProcessing={false}
          attachments={[]}
          setAttachments={(() => {}) as ChatComposerProps['setAttachments']}
          fileInputRef={fileInputRef}
          onFilesSelected={vi.fn()}
          showPlusMenu={false}
          setShowPlusMenu={() => {}}
          permissionMode={permission}
          onPermissionChange={setPermission}
          onOpenSchedule={vi.fn()}
        />
      );
    }
    render(<RetractHarness />);
    await waitFor(() => {
      expect(
        document
          .querySelector('[data-input-field]')
          ?.getAttribute('data-input-field')
      ).toBe('textarea');
    });
    const retractBtn = screen.getByRole('button', {
      name: '撤回上一条用户消息',
    });
    expect(retractBtn).toBeTruthy();
    fireEvent.click(retractBtn);
    expect(onRetract).toHaveBeenCalledTimes(1);
  });
});
