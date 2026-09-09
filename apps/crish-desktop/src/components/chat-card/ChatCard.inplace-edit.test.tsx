// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { ChatCard } from './ChatCard';
import type { ChatMessageListProps } from '../chat-message-list/chatMessageListProps';
import type { ChatComposerProps } from '../chat-composer/ChatComposer';
import type { ChatComposerWrapperProps } from './ChatComposerWrapper';

const capturedStreamProps: { current: ChatMessageListProps | null } = { current: null };
const capturedComposerProps: { current: ChatComposerProps | null } = { current: null };
const capturedWrapperProps: { current: ChatComposerWrapperProps | null } = { current: null };

const { mockState } = vi.hoisted(() => {
  const setChatInput = vi.fn();
  const setAttachments = vi.fn();
  const handleEditMessageAndResend = vi.fn().mockResolvedValue(undefined);
  return {
    mockState: {
      composerProps: {
        chatInput: '底部的草稿输入',
        setChatInput,
        attachments: [{ id: 'draft-att-1', name: 'draft.png', path: 'c:/draft.png' }],
        setAttachments,
        handlePasteImage: vi.fn(),
        handleStopGeneration: vi.fn(),
        handleForceCancelGeneration: vi.fn(),
        handleFilesSelected: vi.fn(),
        handleDroppedFiles: vi.fn(),
        runNotice: null,
        setRunNotice: vi.fn(),
        onSend: vi.fn(),
      },
      handleEditMessageAndResend,
      isProcessing: false,
      permissionMode: 'ask',
      setPermissionMode: vi.fn(),
      setMainSurface: vi.fn(),
      handleRetract: vi.fn(),
      handleSendFollowUp: vi.fn(),
      handleRegenerate: vi.fn(),
      handleBranch: vi.fn(),
      messages: [],
      displayMessages: [],
      showModelPicker: false,
      engineModel: '',
      activeProfileId: '',
      needsModelSetup: false,
      showModelDropdown: false,
      setShowModelDropdown: vi.fn(),
      openSidePanel: vi.fn(),
      diffFiles: [],
      engineHint: null,
      needsKeySetup: false,
      onEmptySurface: false,
      inPlanMode: false,
      planApproved: false,
      setPlanApproved: vi.fn(),
      goalModeActive: false,
      goalMode: null,
      activeSessionId: 'sess-test-1',
      chatRegionAria: '对话',
      messagesLoading: false,
      emptyKind: null,
      mainSurface: 'chat',
      approvalState: {
        approvalBusy: false,
        pendingApprovalMsgId: '',
        handleApprovalAllow: vi.fn(),
        handleApprovalDeny: vi.fn(),
        handleBatchApprove: vi.fn(),
        handleBatchDeny: vi.fn(),
        approvalUiPlan: { mode: 'none' },
        pendingApprovalCount: 0,
        approvalDockVisible: false,
        pendingApprovalDockLabel: '',
        pendingApprovalToolId: '',
      },
      showProjectPicker: false,
      setShowProjectPicker: vi.fn(),
      handleProjectChanged: vi.fn(),
      openDiffInRightPanel: vi.fn(),
      openPathInFilesPanel: vi.fn(),
      handleOpenTerminal: vi.fn(),
      handleOpenDiffPanel: vi.fn(),
    },
  };
});

vi.mock('./useChatCardState', () => ({
  useChatCardState: () => mockState,
}));

vi.mock('../../hooks/useIpcListener', () => ({
  useIpcListener: vi.fn(),
}));

vi.mock('../../services/toast/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../../api/storeAccess', () => ({
  openSettings: vi.fn(),
  patchSession: vi.fn(),
}));

vi.mock('../../api/providerProfiles', () => ({
  anyProfileHasKey: () => false,
}));

const capturedAllComposers: ChatComposerProps[] = [];

vi.mock('../chat-composer/ChatComposer', () => ({
  ChatComposer: (props: ChatComposerProps) => {
    capturedComposerProps.current = props;
    capturedAllComposers.push(props);
    return (
      <div
        data-testid={props.isEditingMessage ? 'edit-chat-composer' : 'main-chat-composer'}
        data-editing={props.isEditingMessage ? 'true' : 'false'}
      />
    );
  },
}));

vi.mock('./ChatComposerWrapper', () => ({
  ChatComposerWrapper: (props: ChatComposerWrapperProps) => {
    capturedWrapperProps.current = props;
    return <div data-testid="chat-composer-wrapper">{props.composerElement}</div>;
  },
}));

vi.mock('../chat-message-list/ChatMessageList', () => ({
  ChatMessageList: (props: ChatMessageListProps) => {
    capturedStreamProps.current = props;
    return <div data-testid="chat-message-list">{props.composer.composerElement}</div>;
  },
}));

describe('ChatCard 底部输入框常驻与原位消息编辑独立流测试', () => {
  it('默认状态：底部渲染 mainComposerElement，消息列表无原位编辑组件', () => {
    capturedAllComposers.length = 0;
    render(<ChatCard handleGlobalTabClick={vi.fn()} />);

    expect(capturedWrapperProps.current?.composerElement).not.toBeNull();
    expect(capturedStreamProps.current?.composer.editingMessageId).toBeNull();
    expect(capturedStreamProps.current?.composer.composerElement).toBeNull();
  });

  it('触发就地编辑：底部 ChatComposerWrapper 持续保持渲染（主输入框不消失），消息流呼出独立 editComposer', async () => {
    capturedAllComposers.length = 0;
    render(<ChatCard handleGlobalTabClick={vi.fn()} />);

    const targetUserMsg = {
      id: 'target-user-msg-99',
      sender: 'user' as const,
      timestamp: Date.now(),
      text: '这是历史提问的文本',
      attachments: [{ name: 'image.png', path: 'c:/Software/image.png' }],
    };

    // 触发就地编辑
    await act(async () => {
      capturedStreamProps.current?.composer.onStartEditMessage?.(targetUserMsg);
    });

    // 1) 核心断言：底部输入框持续常驻，绝不置空消失！
    expect(capturedWrapperProps.current?.composerElement).not.toBeNull();

    // 2) 核心断言：消息流获得专属 editComposerElement
    expect(capturedStreamProps.current?.composer.editingMessageId).toBe('target-user-msg-99');
    expect(capturedStreamProps.current?.composer.composerElement).not.toBeNull();

    // 3) 验证编辑输入框已初始载入目标消息的内容与附件
    const editProps = capturedAllComposers.find((p) => p.isEditingMessage);
    expect(editProps).toBeDefined();
    expect(editProps?.chatInput).toBe('这是历史提问的文本');
    expect(editProps?.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'c:/Software/image.png' }),
      ])
    );
    expect(editProps?.onCancelEdit).toBeDefined();

    // 4) 点击取消编辑（叉号 / Esc）：消息流原位编辑框收起，底部输入框依然持续常驻
    await act(async () => {
      editProps?.onCancelEdit?.();
    });

    expect(capturedWrapperProps.current?.composerElement).not.toBeNull();
    expect(capturedStreamProps.current?.composer.editingMessageId).toBeNull();
    expect(capturedStreamProps.current?.composer.composerElement).toBeNull();
  });

  it('编辑提交：触发 handleEditMessageAndResend 并退出编辑态，底部输入框持续保持', async () => {
    capturedAllComposers.length = 0;
    render(<ChatCard handleGlobalTabClick={vi.fn()} />);

    const targetUserMsg = {
      id: 'msg-to-save',
      sender: 'user' as const,
      timestamp: Date.now(),
      text: '待保存文本',
    };

    await act(async () => {
      capturedStreamProps.current?.composer.onStartEditMessage?.(targetUserMsg);
    });

    const editProps = capturedAllComposers.find((p) => p.isEditingMessage);
    expect(editProps).toBeDefined();

    // 触发编辑状态下的 onSend
    await act(async () => {
      editProps?.onSend?.();
    });

    expect(mockState.handleEditMessageAndResend).toHaveBeenCalledWith(
      'msg-to-save',
      '待保存文本',
      expect.anything()
    );

    // 提交后退出编辑态，底部输入框持续常驻
    expect(capturedWrapperProps.current?.composerElement).not.toBeNull();
    expect(capturedStreamProps.current?.composer.editingMessageId).toBeNull();
    expect(capturedStreamProps.current?.composer.composerElement).toBeNull();
  });
});
