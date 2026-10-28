/**
 * composer-wrapper 卡片网格：附件在上、加号/权限常驻左槽、融合/发送在右槽、页脚无撤回。
 */
// @vitest-environment jsdom
import React, { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChatComposer } from './ChatComposer';

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

function renderLayout() {
  function Harness() {
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
        filteredCommands={[]}
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
        onOpenSchedule={vi.fn()}
      />
    );
  }
  return render(<Harness />);
}

describe('ChatComposer 卡片网格（composer-wrapper 结构）', () => {
  it('卡片 + 网格：附件在输入上沿，加号/权限/融合/发送都在', async () => {
    renderLayout();
    const card = document.querySelector('[data-composer-card]');
    const layout = document.querySelector('[data-composer-layout]');
    expect(card).toBeTruthy();
    expect(layout).toBeTruthy();
    expect(layout?.getAttribute('data-composer-footer')).toBe('1');

    const strip = await screen.findByTestId('composer-attach-strip');
    const field = document.querySelector('[data-composer-field="1"]');
    expect(field).toBeTruthy();
    expect(
      strip.compareDocumentPosition(field as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    expect(screen.getByRole('button', { name: '打开添加菜单' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /当前权限模式：每次询问/ })
    ).toBeTruthy();
    expect(screen.getByTestId('composer-fused-trigger')).toBeTruthy();
    expect(screen.getByRole('button', { name: /发送/ })).toBeTruthy();
  });

  it('有附件时切多行；页脚/网格无撤回', () => {
    renderLayout();
    const card = document.querySelector('[data-composer-card]');
    expect(card?.getAttribute('data-multiline')).toBe('1');
    expect(
      screen.queryByRole('button', { name: '撤回上一条用户消息' })
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-composer-footer="1"] [data-testid="message-retract"]'
      )
    ).toBeNull();
  });

  it('有内容时可点发送圆（不经悬挂底栏）', async () => {
    const onSend = vi.fn();
    function Harness() {
      const [input, setInput] = useState('发一条');
      const fileInputRef = useRef<HTMLInputElement>(null);
      const [composing, setComposing] = useState(false);
      return (
        <ChatComposer
          chatInput={input}
          setChatInput={setInput}
          isComposing={composing}
          setIsComposing={setComposing}
          filteredCommands={[]}
          loadSkillSlash={vi.fn()}
          onPasteImage={vi.fn()}
          onSend={onSend}
          onStop={vi.fn()}
          canSend
          isProcessing={false}
          attachments={[]}
          setAttachments={() => {}}
          fileInputRef={fileInputRef}
          onFilesSelected={vi.fn()}
          showPlusMenu={false}
          setShowPlusMenu={() => {}}
          permissionMode="ask"
          onPermissionChange={() => {}}
          onOpenSchedule={vi.fn()}
        />
      );
    }
    render(<Harness />);
    const send = await waitFor(() =>
      screen.getByRole('button', { name: '发送' })
    );
    fireEvent.click(send);
    await waitFor(() => {
      expect(onSend).toHaveBeenCalled();
    });
  });

  it('单行模式：权限模式按钮常驻左槽（[data-composer-grid="left"]），不跳入右侧融合胶囊（T6-6）', () => {
    function SingleLineHarness() {
      const [input, setInput] = useState('');
      const fileInputRef = useRef<HTMLInputElement>(null);
      const [permission, setPermission] = useState<
        'ask' | 'deep' | 'full' | 'plan'
      >('ask');
      return (
        <ChatComposer
          chatInput={input}
          setChatInput={setInput}
          isComposing={false}
          setIsComposing={() => {}}
          filteredCommands={[]}
          loadSkillSlash={vi.fn()}
          onPasteImage={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
          canSend={false}
          isProcessing={false}
          attachments={[]}
          setAttachments={() => {}}
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
    const { container } = render(<SingleLineHarness />);
    const card = container.querySelector('[data-composer-card]');
    expect(card?.getAttribute('data-multiline')).toBe('0');

    expect(container.querySelector('[data-composer-grid="perm"]')).toBeNull();

    const leftSlot = container.querySelector('[data-composer-grid="left"]');
    const fusedTrigger = screen.getByTestId('composer-fused-trigger');
    const permBtn = screen.getByRole('button', {
      name: /当前权限模式：每次询问/,
    });
    expect(leftSlot?.contains(permBtn)).toBe(true);
    expect(fusedTrigger.contains(permBtn)).toBe(false);
    expect(fusedTrigger.getAttribute('data-has-prefix')).toBe('false');
  });
});
