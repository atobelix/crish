// @vitest-environment jsdom
/* eslint-disable react/no-multi-comp */
/**
 * 外部会话预览布局与空态隔离测试：
 * 验证当 previewExternalSession 存在时：
 * 1. chatBody 不打上 data-empty-kind="session-empty"（杜绝 translateY 将底栏推至半空）
 * 2. chatDocFlow 不打上 data-empty="true"（杜绝垂直居中干扰消息列表流式排布）
 * 3. ChatComposer 接收 layoutVariant="adaptive" 与 emptyKind=null（保持单行输入卡片而非巨大多行空态卡）
 * 4. ChatComposerWrapper 接收 emptyKind=null 且 composerLead 恒为 null
 * 5. 渲染 ChatMessageList 呈现外部消息列表，视同常规对话
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatCard } from '../ChatCard';
import type { ChatComposerProps } from '../../chat-composer/composerTypes';
import type { ChatComposerWrapperProps } from '../ChatComposerWrapper';

const { stateHolder, previewHolder } = vi.hoisted(() => ({
  stateHolder: { current: null as Record<string, unknown> | null },
  previewHolder: {
    current: null as {
      previewExternalSession: unknown;
      isImporting: boolean;
      handleImportAndContinue: () => Promise<void>;
    } | null,
  },
}));

let lastComposerProps: ChatComposerProps | null = null;
let lastWrapperProps: ChatComposerWrapperProps | null = null;

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

vi.mock('../ChatHeaderControls', () => ({
  ModelBadgePicker: () => null,
}));

vi.mock('../../chat-composer/ChatComposer', () => ({
  ChatComposer: (props: ChatComposerProps) => {
    lastComposerProps = props;
    return (
      <div
        data-testid="mock-composer"
        data-layout-variant={props.layoutVariant}
        data-empty-kind={props.emptyKind ?? 'null'}
      />
    );
  },
}));

vi.mock('../ChatComposerWrapper', () => ({
  ChatComposerWrapper: (props: ChatComposerWrapperProps) => {
    lastWrapperProps = props;
    return (
      <div
        data-testid="mock-composer-wrapper"
        data-empty-kind={props.emptyKind ?? 'null'}
        data-has-lead={props.composerLead != null ? 'true' : 'false'}
      >
        {props.composerElement}
      </div>
    );
  },
}));

vi.mock('../../chat-message-list/ChatMessageList', () => ({
  ChatMessageList: (props: { messages?: { messages?: unknown[] } }) => (
    <div
      data-testid="mock-chat-message-list"
      data-count={props.messages?.messages?.length ?? 0}
    />
  ),
}));

vi.mock('../ChatEmptyState', () => ({
  ChatEmptyState: () => <div data-testid="mock-empty-state" />,
}));

vi.mock('../../settings/ScheduledTasksPanel', () => ({
  ScheduledTasksPanel: () => null,
}));

vi.mock('../../extensions-surface/ExtensionsMainSurface', () => ({
  ExtensionsMainSurface: () => null,
}));

vi.mock('../useChatCardState', () => ({
  useChatCardState: () => stateHolder.current,
}));

vi.mock('../useChatCardDragDrop', () => ({
  useChatCardDragDrop: () => ({
    rootRef: { current: null },
    isDragOver: false,
    dragHandlers: {},
  }),
}));

vi.mock('../useExternalLongSessionDetection', () => ({
  useExternalLongSessionDetection: () =>
    previewHolder.current ?? {
      previewExternalSession: null,
      isImporting: false,
      handleImportAndContinue: vi.fn(),
    },
}));

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    composerProps: {
      handlePasteImage: vi.fn(),
      handleStopGeneration: vi.fn(),
      handleForceCancelGeneration: vi.fn(),
      handleFilesSelected: vi.fn(),
      handleDroppedFiles: vi.fn(),
      setChatInput: vi.fn(),
      chatInput: '',
      attachments: [],
      setAttachments: vi.fn(),
      fileInputRef: { current: null },
      onPickFiles: vi.fn(),
    },
    isProcessing: false,
    permissionMode: 'ask',
    setPermissionMode: vi.fn(),
    setMainSurface: vi.fn(),
    handleRetract: vi.fn(),
    messages: [],
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
    activeSessionId: 'sess-empty-1',
    chatRegionAria: '对话',
    messagesLoading: false,
    mainSurface: 'chat',
    emptyKind: 'session-empty',
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
    displayMessages: [],
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
    workspaceKey: 'default',
    ...overrides,
  };
}

describe('ChatCard 外部会话预览态防浮动与布局隔离', () => {
  beforeEach(() => {
    lastComposerProps = null;
    lastWrapperProps = null;
  });

  it('存在 previewExternalSession 时：视同正常对话，输入框停靠底部单行，不打上 session-empty 属性', () => {
    stateHolder.current = makeState({ emptyKind: 'session-empty' });
    previewHolder.current = {
      previewExternalSession: {
        detected: {
          id: 'ext-long-1',
          source: 'claude-code',
          title: 'Claude 历史长会话',
          messageCount: 10,
        },
        mapped: {
          source: 'claude-code',
          sourceId: 'ext-long-1',
          title: 'Claude 历史长会话',
          messages: [
            { id: 'm1', sender: 'user', text: 'hello', timestamp: 100 },
            { id: 'm2', sender: 'assistant', text: 'world', timestamp: 101 },
          ],
        },
      },
      isImporting: false,
      handleImportAndContinue: vi.fn(),
    };

    const { container } = render(
      <ChatCard handleGlobalTabClick={vi.fn()} sessionId="sess-empty-1" />
    );

    const chatBody = container.querySelector('[data-testid="chat-body"]');
    const chatDocFlow = container.querySelector(
      '[data-testid="chat-doc-flow"]'
    );

    // 1. chatBody 不得存在 data-empty-kind 属性（彻底杜绝 translateY 上移半空）
    expect(chatBody?.getAttribute('data-empty-kind')).toBeNull();

    // 2. chatDocFlow 不得存在 data-empty 属性（杜绝 justify-content: center 破坏流式列表）
    expect(chatDocFlow?.getAttribute('data-empty')).toBeNull();

    // 3. 渲染 ChatMessageList 呈现外部消息列表
    expect(screen.getByTestId('mock-chat-message-list')).toBeTruthy();
    expect(screen.queryByTestId('mock-empty-state')).toBeNull();

    // 4. ChatComposer layoutVariant 必须为 'adaptive'，emptyKind 为 null
    expect(lastComposerProps?.layoutVariant).toBe('adaptive');
    expect(lastComposerProps?.emptyKind).toBeNull();

    // 5. ChatComposerWrapper emptyKind 必须为 null，composerLead 必须为 null
    expect(lastWrapperProps?.emptyKind).toBeNull();
    expect(lastWrapperProps?.composerLead).toBeNull();
  });

  it('无 previewExternalSession 且处于 session-empty 时：正常表现为 landing 空态', () => {
    stateHolder.current = makeState({ emptyKind: 'session-empty' });
    previewHolder.current = {
      previewExternalSession: null,
      isImporting: false,
      handleImportAndContinue: vi.fn(),
    };

    const { container } = render(
      <ChatCard handleGlobalTabClick={vi.fn()} sessionId="sess-empty-1" />
    );

    const chatBody = container.querySelector('[data-testid="chat-body"]');
    const chatDocFlow = container.querySelector(
      '[data-testid="chat-doc-flow"]'
    );

    // 1. chatBody 包含 data-empty-kind="session-empty"
    expect(chatBody?.getAttribute('data-empty-kind')).toBe('session-empty');

    // 2. chatDocFlow 包含 data-empty="true"
    expect(chatDocFlow?.getAttribute('data-empty')).toBe('true');

    // 3. 渲染 ChatEmptyState 空态
    expect(screen.getByTestId('mock-empty-state')).toBeTruthy();
    expect(screen.queryByTestId('mock-chat-message-list')).toBeNull();

    // 4. ChatComposer layoutVariant 为 'multiline'
    expect(lastComposerProps?.layoutVariant).toBe('multiline');
    expect(lastComposerProps?.emptyKind).toBe('session-empty');

    // 5. ChatComposerWrapper emptyKind 为 'session-empty'，包含 composerLead
    expect(lastWrapperProps?.emptyKind).toBe('session-empty');
    expect(lastWrapperProps?.composerLead).not.toBeNull();
  });
});
