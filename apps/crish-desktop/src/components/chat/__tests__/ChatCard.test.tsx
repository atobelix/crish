import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../ChatCard.module.css', () => ({
  default: {
    chatBody: 'chatBody',
    chatDocFlow: 'chatDocFlow',
    chatFooter: 'chatFooter',
    modelBadge: 'modelBadge',
    modelText: 'modelText',
    active: 'active',
    emptyComposer: 'emptyComposer',
  },
}));

vi.mock('../../ChatComposer', () => ({
  ChatComposer: vi.fn(({ rightActions }) => (
    <div data-testid="chat-composer">{rightActions}</div>
  )),
}));

vi.mock('../../ChatMessageList', () => ({
  ChatMessageList: vi.fn(() => <div data-testid="chat-message-list" />),
}));

vi.mock('../../ChatEmptyState', () => ({
  ChatEmptyState: vi.fn(() => <div data-testid="chat-empty-state" />),
}));

vi.mock('../../ChatStatusRibbons', () => ({
  ChatStatusRibbons: vi.fn(() => <div data-testid="chat-status-ribbons" />),
}));

vi.mock('../../ChatMsgFilterBar', () => ({
  ChatMsgFilterBar: vi.fn(() => <div data-testid="chat-msg-filter-bar" />),
}));

vi.mock('../../../hooks/useChatStream', () => ({
  useChatStream: vi.fn(() => ({
    runNotice: null,
    setRunNotice: vi.fn(),
    runStreamingAssistant: vi.fn(),
    handleSendChat: vi.fn(),
    handleStopGeneration: vi.fn(),
  })),
}));

vi.mock('../../../hooks/useChatAutoScroll', () => ({
  useChatAutoScroll: vi.fn(() => ({
    chatFlowRef: { current: null },
    showScrollToBottom: false,
    scrollToBottom: vi.fn(),
  })),
}));

vi.mock('../../../hooks/useThinkingTimer', () => ({
  useThinkingTimer: vi.fn(() => 0),
}));

vi.mock('../../../store/sessionStore', () => ({
  useSessionField: vi.fn(() => undefined),
  selectActiveSessionId: Symbol('selectActiveSessionId'),
  getSessionById: vi.fn(() => null),
  getSessionStoreState: vi.fn(() => ({
    sessionsById: {},
    activeSessionId: null,
    folderOrder: [],
    composerDrafts: {},
  })),
}));

vi.mock('../../../store/layoutStore', () => ({
  useLayoutStore: vi.fn(() => ({
    withdrawMessage: vi.fn(),
    appSettings: null,
    diffFiles: [],
    permissionMode: 'none',
    setPermissionMode: vi.fn(),
    planModeEnabled: false,
    planApproved: false,
    setPlanApproved: vi.fn(),
    chatMainSurface: 'chat',
    setChatMainSurface: vi.fn(),
    setComposerDraft: vi.fn(),
    composerDrafts: {},
  })),
}));

vi.mock('../../../store/useShallowSelector', () => ({
  useShallow: vi.fn((fn) => fn),
}));

vi.mock('../../../api/storeAccess', () => ({
  addMessage: vi.fn(),
  archiveSession: vi.fn(),
  branchSession: vi.fn(),
  enterDraftMode: vi.fn(),
  getSessionStoreState: vi.fn(() => ({ sessionsById: {}, activeSessionId: null })),
  openSettings: vi.fn(),
  patchSession: vi.fn(),
  setActiveDiffSource: vi.fn(),
  setActiveSessionId: vi.fn(),
  setSessionMessageStatus: vi.fn(),
  updateMessageToolCall: vi.fn(),
  addCommandPermission: vi.fn(),
}));

vi.mock('../../../api/engineConfig', () => ({
  fetchEngineStatus: vi.fn(() => Promise.resolve({ ok: true, model: 'gpt-4', hasApiKey: true })),
}));

vi.mock('../../../api/providerProfiles', () => ({
  anyProfileHasKey: vi.fn(() => true),
  getActiveModelId: vi.fn(() => 'gpt-4'),
  getActiveProfileId: vi.fn(() => 'profile-1'),
  getActiveProfile: vi.fn(() => null),
  getProviderSetupStatus: vi.fn(() => ({ needsKeySetup: false, needsModelSetup: false, showModelPicker: true })),
  resolveDisplayModelId: vi.fn((id) => id || ''),
  resolvePreferredModelSelection: vi.fn(() => ({ model: '', profileId: '' })),
}));

vi.mock('../../../api/appMode', () => ({ isDemoMode: vi.fn(() => true) }));

vi.mock('../../../hooks/useToastQueue', () => ({ formatBranchUndoToast: vi.fn(() => '') }));

vi.mock('../../../api/uiEvents', () => ({ onUiEvent: vi.fn(() => vi.fn()) }));

vi.mock('../../../api/sessionSearch', () => ({ messageMatchesSearch: vi.fn(() => false) }));

vi.mock('../../../store/draftSession', () => ({ isPendingDraft: vi.fn(() => false) }));

vi.mock('../../FirstRunWizard', () => ({ isFirstRunOverlayOpen: vi.fn(() => false) }));

vi.mock('../../../api/chatEmptyState', () => ({
  resolveChatEmptyKind: vi.fn(() => null),
  chatEmptyKindAriaLabel: vi.fn(() => ''),
}));

vi.mock('../../../api/workspaceFsApi', () => ({ openFileInPanel: vi.fn() }));

vi.mock('../hooks/useChatCardSelectors', () => ({
  useChatCardSelectors: vi.fn(() => ({
    activeSessionId: null,
    messages: [],
    agents: [],
    goalMode: null,
    hydratedFromEngine: false,
    engineCursor: null,
    engineLastRunId: null,
    activeSessionTitle: '',
    withdrawMessage: vi.fn(),
    appSettings: null,
    diffFiles: [],
    permissionMode: 'none',
    setPermissionMode: vi.fn(),
    planModeEnabled: false,
    planApproved: false,
    setPlanApproved: vi.fn(),
    inPlanMode: false,
    mainSurface: 'chat',
    setMainSurface: vi.fn(),
    setComposerDraft: vi.fn(),
    composerDrafts: {},
  })),
}));

vi.mock('../hooks/useChatApproval', () => ({
  useChatApproval: vi.fn(() => ({
    approvalBusy: false,
    pendingApprovalMsgId: '',
    pendingApprovalToolId: '',
    approvalUiPlan: { mode: '', showDock: false, total: 0, counts: {} },
    pendingApprovalCount: 0,
    pendingApprovalSummary: '',
    approvalDockVisible: false,
    pendingApprovalDockLabel: '',
    handleApprovalAllow: vi.fn(),
    handleApprovalDeny: vi.fn(),
    handleBatchApprove: vi.fn(),
    handleBatchDeny: vi.fn(),
  })),
}));

vi.mock('../hooks/useChatComposerProps', () => ({
  useChatComposerProps: vi.fn(() => ({
    chatInput: '',
    setChatInput: vi.fn(),
    isComposing: false,
    setIsComposing: vi.fn(),
    slashMenuOpen: false,
    setSlashMenuOpen: vi.fn(),
    slashSelectedIndex: 0,
    setSlashSelectedIndex: vi.fn(),
    attachments: [],
    setAttachments: vi.fn(),
    fileInputRef: { current: null },
    canSend: false,
    handlePasteImage: vi.fn(),
    addAttachments: vi.fn(),
    modelSelectorRef: { current: null },
    showModelDropdown: false,
    setShowModelDropdown: vi.fn(),
    showPlusMenu: false,
    setShowPlusMenu: vi.fn(),
    pickerInlineError: '',
    setPickerInlineError: vi.fn(),
    localMsgFilter: '',
    setLocalMsgFilter: vi.fn(),
    showMsgFilter: false,
    setShowMsgFilter: vi.fn(),
    msgFilterInputRef: { current: null },
    projectTick: 0,
    setProjectTick: vi.fn(),
    showProjectPicker: false,
    setShowProjectPicker: vi.fn(),
    filteredCommands: [],
    loadSkillSlash: vi.fn(),
    skillCommandsEnabled: false,
  })),
}));

vi.mock('../../ChatDemoChrome', () => ({ ChatDemoChrome: vi.fn(() => <div />) }));

vi.mock('../../ScheduledTasksPanel', () => ({ default: vi.fn(() => <div />) }));

vi.mock('../../ModelBadgePickerMenu', () => ({
  ModelBadgePickerMenu: vi.fn(() => <div />),
  default: vi.fn(() => <div />),
}));

const defaultProps = {
  wsId: 'ws-1',
  colIdx: 0,
  groupIdx: 0,
  onShowToast: vi.fn(),
  handleGlobalTabClick: vi.fn(),
};

describe('ChatCard', () => {
  it('renders without crashing with minimal props', async () => {
    const { ChatCard } = await import('../ChatCard');
    const { container } = render(<ChatCard {...defaultProps} />);
    expect(container.querySelector('[class*="chatBody"]')).toBeTruthy();
  });

  it('renders ChatHeader as rightActions in ChatComposer', async () => {
    const { ChatCard } = await import('../ChatCard');
    render(<ChatCard {...defaultProps} />);
    expect(screen.getByTestId('chat-composer')).toBeTruthy();
  });

  it('all three hooks (useChatCardSelectors, useChatComposerProps, useChatApproval) work together without conflict', async () => {
    const { useChatCardSelectors } = await import('../hooks/useChatCardSelectors');
    const { useChatApproval } = await import('../hooks/useChatApproval');
    const { useChatComposerProps } = await import('../hooks/useChatComposerProps');

    const { ChatCard } = await import('../ChatCard');
    render(<ChatCard {...defaultProps} />);

    expect(vi.mocked(useChatCardSelectors)).toHaveBeenCalled();
    expect(vi.mocked(useChatComposerProps)).toHaveBeenCalled();
    expect(vi.mocked(useChatApproval)).toHaveBeenCalled();
  });

  it('does not throw when activeSessionId is null and mainSurface is chat', async () => {
    const { ChatCard } = await import('../ChatCard');
    expect(() => render(<ChatCard {...defaultProps} />)).not.toThrow();
  });
});
