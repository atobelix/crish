// @vitest-environment jsdom
/**
 * S1：chat 叶文档流挂 SlotOutlet('workspace.chat.stream')。
 * 未登记 → fallback ChatMessageList；空态 / 定时任务面不进该槽。
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { slotCore } from '../../services/view-registry/SlotCore';
import '../chat-message-list/workspaceChatStream.slot';
import './workspaceChatComposerAbove.slot';
import type { SlotMap } from '../../services/view-registry/SlotTypes';
import { ChatCard } from './ChatCard';

const { stateHolder } = vi.hoisted(() => ({
  stateHolder: { current: null as Record<string, unknown> | null },
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

vi.mock('./ChatHeaderControls', () => ({
  ModelBadgePicker: () => null,
}));

vi.mock('../chat-composer/ChatComposer', () => ({
  ChatComposer: () => <div data-testid="mock-composer" />,
}));

vi.mock('./ChatComposerWrapper', () => ({
  ChatComposerWrapper: () => <div data-testid="mock-composer-wrap" />,
}));

vi.mock('../chat-message-list/ChatMessageList', () => ({
  ChatMessageList: () => <div data-testid="fallback-chat-message-list" />,
}));

vi.mock('./ChatEmptyState', () => ({
  ChatEmptyState: () => <div data-testid="mock-empty" />,
}));

vi.mock('../settings/ScheduledTasksPanel', () => ({
  ScheduledTasksPanel: () => <div data-testid="mock-scheduled" />,
}));

vi.mock('./useChatCardState', () => ({
  useChatCardState: () => stateHolder.current,
}));

vi.mock('./useChatCardDragDrop', () => ({
  useChatCardDragDrop: () => ({
    rootRef: { current: null },
    isDragOver: false,
    dragHandlers: {},
  }),
}));

const STREAM_KIND: SlotMap['workspace.chat.stream']['kind'] = 'single';
const ABOVE_KIND: SlotMap['workspace.chat.composerAbove']['kind'] = 'single';

function makeState(overrides: Record<string, unknown> = {}) {
  const msg = { id: 'm1', sender: 'user', timestamp: 1, text: 'hi' };
  return {
    composerProps: {
      handlePasteImage: vi.fn(),
      handleStopGeneration: vi.fn(),
      handleForceCancelGeneration: vi.fn(),
      handleFilesSelected: vi.fn(),
      handleDroppedFiles: vi.fn(),
      setChatInput: vi.fn(),
    },
    isProcessing: false,
    permissionMode: 'ask',
    setPermissionMode: vi.fn(),
    setMainSurface: vi.fn(),
    handleRetract: vi.fn(),
    messages: [msg],
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
    hideThinkingBlock: false,
    goalModeActive: false,
    goalMode: null,
    activeSessionId: 'sess-1',
    chatRegionAria: '对话',
    messagesLoading: false,
    mainSurface: 'chat',
    emptyKind: null,
    engineOk: true,
    approvalState: {
      approvalUiPlan: { mode: 'none' },
      approvalBusy: false,
      pendingApprovalMsgId: '',
      handleApprovalAllow: vi.fn(),
      handleApprovalDeny: vi.fn(),
      handleBatchApprove: vi.fn(),
      handleBatchDeny: vi.fn(),
      pendingApprovalCount: 0,
      approvalDockVisible: false,
      pendingApprovalDockLabel: '',
      pendingApprovalToolId: '',
    },
    displayMessages: [msg],
    agents: [],
    isFiltering: false,
    showProjectPicker: false,
    setShowProjectPicker: vi.fn(),
    handleProjectChanged: vi.fn(),
    handleSendFollowUp: vi.fn(),
    handleRegenerate: vi.fn(),
    handleBranch: vi.fn(),
    openDiffInRightPanel: vi.fn(),
    openPathInFilesPanel: vi.fn(),
    handleOpenTerminal: vi.fn(),
    handleOpenDiffPanel: vi.fn(),
    localMsgFilter: '',
    firstRunOpen: false,
    setProjectTick: vi.fn(),
    handleCreateSessionFromEmpty: vi.fn(),
    setLocalMsgFilter: vi.fn(),
    ...overrides,
  };
}

describe('ChatCard workspace.chat.stream 槽', () => {
  beforeEach(() => {
    slotCore.clear();
    stateHolder.current = makeState();
  });

  it('SlotMap 将 workspace.chat.stream 定为 single', () => {
    expect(STREAM_KIND).toBe('single');
  });

  it('SlotMap 将 workspace.chat.composerAbove 定为 single', () => {
    expect(ABOVE_KIND).toBe('single');
  });

  it('未登记槽时有消息枝渲染 data-slot 且走 ChatMessageList fallback', () => {
    const { container } = render(
      <ChatCard handleGlobalTabClick={vi.fn()} sessionId="sess-1" />
    );
    const outlet = container.querySelector(
      '[data-slot="workspace.chat.stream"]'
    );
    expect(outlet).not.toBeNull();
    expect(screen.getByTestId('fallback-chat-message-list')).toBeTruthy();
  });

  it('空态不进入 workspace.chat.stream 槽', () => {
    stateHolder.current = makeState({ emptyKind: 'session-empty' });
    const { container } = render(
      <ChatCard handleGlobalTabClick={vi.fn()} sessionId="sess-1" />
    );
    expect(
      container.querySelector('[data-slot="workspace.chat.stream"]')
    ).toBeNull();
    expect(screen.getByTestId('mock-empty')).toBeTruthy();
    expect(screen.queryByTestId('fallback-chat-message-list')).toBeNull();
  });

  it('emptyKind + messagesLoading 仍挂欢迎面，不进零消息列表槽', () => {
    stateHolder.current = makeState({
      emptyKind: 'session-empty',
      messagesLoading: true,
      messages: [],
      displayMessages: [],
    });
    const { container } = render(
      <ChatCard handleGlobalTabClick={vi.fn()} sessionId="sess-1" />
    );
    expect(
      container.querySelector('[data-empty-kind="session-empty"]')
    ).toBeTruthy();
    expect(
      container.querySelector('[data-messages-loading="true"]')
    ).toBeTruthy();
    expect(
      container.querySelector('[data-slot="workspace.chat.stream"]')
    ).toBeNull();
    expect(screen.getByTestId('mock-empty')).toBeTruthy();
    expect(screen.queryByTestId('fallback-chat-message-list')).toBeNull();
  });

  it('定时任务面不进入 workspace.chat.stream 槽', async () => {
    stateHolder.current = makeState({ mainSurface: 'scheduled' });
    const { container } = render(
      <ChatCard handleGlobalTabClick={vi.fn()} sessionId="sess-1" />
    );
    expect(
      container.querySelector('[data-slot="workspace.chat.stream"]')
    ).toBeNull();
    expect(screen.queryByTestId('fallback-chat-message-list')).toBeNull();
    expect(await screen.findByTestId('mock-scheduled')).toBeTruthy();
  });
});
