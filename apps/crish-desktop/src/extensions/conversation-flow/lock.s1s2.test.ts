// @vitest-environment jsdom
/**
 * S1/S2 契约锁：默认关、无第 12 内置、关插件无叙事 DOM、host 不撑包含块。
 * 绿 ≠ 叙事 UI 完成 ≠ 默认开。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ChatCard } from '../../components/chat-card/ChatCard';
import '../../components/chat-message-list/workspaceChatStream.slot';
import { slotCore } from '../../services/view-registry/SlotCore';
import {
  deactivateConversationFlow,
  setOfficialConversationFlowActivateForTesting,
  shouldActivateOfficialConversationFlow,
} from './activate';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const DESKTOP_SRC = join(DIR, '../..');

const BUILTIN_IDS = [
  'chat',
  'terminal',
  'preview',
  'overview',
  'files',
  'diff',
  'runtime',
  'agent',
  'browser',
  'flow-dag',
  'file-viewer',
] as const;

const PLUGIN_ON_ENV = [
  'CRISH_CONVERSATION_FLOW',
  'CRISH_ENABLE_CONVERSATION_FLOW',
  'VITE_CONVERSATION_FLOW',
  'VITE_ENABLE_CONVERSATION_FLOW',
  'CONVERSATION_FLOW',
  'ENABLE_CONVERSATION_FLOW',
] as const;

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

vi.mock('../../components/chat-card/ChatHeaderControls', () => ({
  ModelBadgePicker: () => null,
}));

vi.mock('../../components/chat-composer/ChatComposer', async () => {
  const { createElement: h } = await import('react');
  return {
    ChatComposer: () => h('div', { 'data-testid': 'mock-composer' }),
  };
});

vi.mock('../../components/chat-card/ChatComposerWrapper', async () => {
  const { createElement: h } = await import('react');
  return {
    ChatComposerWrapper: () =>
      h('div', { 'data-testid': 'mock-composer-wrap' }),
  };
});

vi.mock('../../components/chat-message-list/ChatMessageList', async () => {
  const { createElement: h } = await import('react');
  return {
    ChatMessageList: () =>
      h('div', { 'data-testid': 'fallback-chat-message-list' }),
  };
});

vi.mock('../../components/chat-card/ChatEmptyState', async () => {
  const { createElement: h } = await import('react');
  return {
    ChatEmptyState: () => h('div', { 'data-testid': 'mock-empty' }),
  };
});

vi.mock('../../components/settings/ScheduledTasksPanel', async () => {
  const { createElement: h } = await import('react');
  return {
    ScheduledTasksPanel: () =>
      h('div', { 'data-testid': 'mock-scheduled' }),
  };
});

vi.mock('../../components/chat-card/useChatCardState', () => ({
  useChatCardState: () => stateHolder.current,
}));

function makeState(overrides: Record<string, unknown> = {}) {
  const msg = { id: 'm1', sender: 'user', timestamp: 1, text: 'hi' };
  return {
    composerProps: {
      handlePasteImage: vi.fn(),
      handleStopGeneration: vi.fn(),
      handleForceCancelGeneration: vi.fn(),
      handleFilesSelected: vi.fn(),
      setChatInput: vi.fn(),
      runNotice: null,
      setRunNotice: vi.fn(),
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
    showScrollToBottom: false,
    scrollToBottom: vi.fn(),
    inPlanMode: false,
    planApproved: false,
    setPlanApproved: vi.fn(),
    goalModeActive: false,
    goalMode: null,
    activeSessionId: 'sess-lock-1',
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
    chatFlowRef: { current: null },
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

function factoryKeys(mainSrc: string): string[] {
  const block = mainSrc.match(
    /const builtinViewFactories:\s*ViewFactoryMap\s*=\s*\{([\s\S]*?)\n\};/
  );
  return [
    ...(block?.[1] ?? '').matchAll(
      /^  (?:'([^']+)'|([A-Za-z_][\w-]*))\s*:/gm
    ),
  ].map((m) => m[1] ?? m[2] ?? '');
}

function registrarIds(src: string): string[] {
  return [...src.matchAll(/^\s*id:\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? '');
}

function assertNoNarrativeDom(container: HTMLElement): void {
  expect(container.querySelector('[data-conversation-flow="on"]')).toBeNull();
  expect(container.querySelector('[data-kind="purpose"]')).toBeNull();
  expect(container.querySelector('[data-flow-kind="purpose"]')).toBeNull();
  expect(container.querySelector('[data-node-kind="purpose"]')).toBeNull();
  expect(container.querySelector('[data-purpose]')).toBeNull();
  expect(container.querySelector('[data-flow-task]')).toBeNull();
  expect(container.querySelector('[data-flow-plan]')).toBeNull();
  expect(container.querySelector('.plan-progress-bar')).toBeNull();
  expect(container.textContent ?? '').not.toMatch(/\bPurpose\b/);
}

describe('S1/S2 契约锁', () => {
  beforeEach(() => {
    deactivateConversationFlow();
    setOfficialConversationFlowActivateForTesting(null);
    slotCore.clear();
    stateHolder.current = makeState();
  });

  afterEach(() => {
    cleanup();
    act(() => {
      deactivateConversationFlow();
    });
    setOfficialConversationFlowActivateForTesting(null);
    slotCore.clear();
  });

  it('默认环境、无开插件 env：shouldActivateOfficialConversationFlow() === false', () => {
    const saved = PLUGIN_ON_ENV.map((key) => [key, process.env[key]] as const);
    for (const key of PLUGIN_ON_ENV) {
      delete process.env[key];
    }
    try {
      setOfficialConversationFlowActivateForTesting(null);
      expect(shouldActivateOfficialConversationFlow()).toBe(false);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const activateSrc = readFileSync(join(DIR, 'activate.ts'), 'utf8');
    expect(activateSrc).not.toMatch(/officialOverride\s*\?\?\s*true/);
    const mainSrc = readFileSync(join(DESKTOP_SRC, 'main.tsx'), 'utf8');
    expect(mainSrc).toMatch(
      /if\s*\(\s*shouldActivateOfficialConversationFlow\s*\(\s*\)\s*\)/
    );
    const guarded = mainSrc.match(
      /if\s*\(\s*shouldActivateOfficialConversationFlow\s*\(\s*\)\s*\)\s*\{([^}]*)\}/
    );
    expect(guarded?.[1]).toMatch(/activateConversationFlow\s*\(/);
  });

  it('内置 view 仍 11 个，无 note / conversation-flow 第 12 内置', () => {
    const registrar = readFileSync(
      join(DESKTOP_SRC, 'services/view-registry/registerBuiltInViews.tsx'),
      'utf8'
    );
    const ids = registrarIds(registrar);
    expect(ids).toEqual([...BUILTIN_IDS]);
    expect(ids).toHaveLength(11);
    expect(ids).not.toContain('note');
    expect(ids).not.toContain('conversation-flow');
    expect(registrar).toMatch(/全部 11 个/);
    expect(registrar).not.toMatch(/id:\s*['"]note['"]/);
    expect(registrar).not.toMatch(/id:\s*['"]conversation-flow['"]/);

    const mainSrc = readFileSync(join(DESKTOP_SRC, 'main.tsx'), 'utf8');
    const keys = factoryKeys(mainSrc);
    expect(keys).toEqual([...BUILTIN_IDS]);
    expect(keys).not.toContain('note');
    expect(keys).not.toContain('conversation-flow');
  });

  it('关插件：ChatCard 有消息枝走 SlotOutlet fallback，DOM 无 Purpose / data-conversation-flow=on', () => {
    const chatCardSrc = readFileSync(
      join(DESKTOP_SRC, 'components/chat-card/ChatCard.tsx'),
      'utf8'
    );
    expect(chatCardSrc).toMatch(/slotKey=["']workspace\.chat\.stream["']/);
    expect(chatCardSrc).toMatch(/fallback=\{<ChatMessageList/);
    expect(chatCardSrc).not.toMatch(/\bPurpose\b/);
    expect(chatCardSrc).not.toMatch(/data-conversation-flow/);
    expect(chatCardSrc).not.toMatch(/data-permission-bar/);

    const wrapperSrc = readFileSync(
      join(DESKTOP_SRC, 'components/chat-card/ChatComposerWrapper.tsx'),
      'utf8'
    );
    expect(wrapperSrc).toMatch(/slotKey=["']workspace\.chat\.composerAbove["']/);
    expect(wrapperSrc).toMatch(/fallback=\{null\}/);

    const { container } = render(
      createElement(ChatCard, {
        handleGlobalTabClick: vi.fn(),
        sessionId: 'sess-lock-1',
      })
    );
    expect(
      container.querySelector('[data-slot="workspace.chat.stream"]')
    ).not.toBeNull();
    expect(screen.getByTestId('fallback-chat-message-list')).toBeTruthy();
    assertNoNarrativeDom(container);
    expect(container.querySelector('[data-permission-bar]')).toBeNull();
  });

  it('host 根 style 钉 display:contents，不撑破包含块', () => {
    const hostSrc = readFileSync(join(DIR, 'host.tsx'), 'utf8');
    expect(hostSrc).toMatch(/display:\s*['"]contents['"]/);
  });
});
