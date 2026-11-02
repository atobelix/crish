// @vitest-environment jsdom
/**
 * R1（打字解耦，性能审计 P0-2）渲染计数契约：
 * 此前 chatStreamProps 是 ChatCard 渲染体内的裸对象字面量——每次按键都
 * 新建六个分组对象，ChatMessageList 的 memo 与 MessageVirtualizer 的分组
 * 引用比较恒失效，60 行长会话每次按键整列表窗口重算。本测试用忠实复刻
 * 真实 churn 的 useChatCardState 替身锁定修复：
 *  - composerProps 每次构建都是新对象、仅 chatInput/canSend 随草稿变化；
 *  - 追问/生成/审批 handler 每次构建都是新闭包（真实代码中
 *    handleSendFollowUp 的 useCallback 依赖整个 composerProps 字面量、
 *    生成/审批 handler 链入流与审批执行器内部，身份本就逐渲染变化）；
 *  - 其余字段（消息数组、会话 id、导航回调等）跨构建保持同一引用。
 * 断言：20 次草稿变更后 ① 列表 memo 叶渲染计数仍为 1；② 容器与六分组
 * 引用逐次恒定；③ 经 trampoline 的追问回调恒命中最新构建的闭包；
 * ④ 与输入框无关的状态变化（engineHint）不换 composerElement 引用；
 * ⑤ 正对照：displayMessages 真变化时列表放行重渲染（计数变 2）。
 *
 * 渲染泵说明：替身 hook 无内部 setState，ChatCard 自身的 React.memo 会
 * 挡住 props 不变的 rerender，故每次 rerender 传入新的
 * handleGlobalTabClick 身份充当「组件体被重新执行」的泵——该 prop 只进
 * useChatCardState 入参（已被替身吞掉），不流入任何分组，口径无污染。
 * 生产环境中同等效应的触发源是 useChatInput 内部的草稿 setState。
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import '../chat-message-list/workspaceChatStream.slot';
import './workspaceChatComposerAbove.slot';
import type { ChatMessageListProps } from '../chat-message-list/chatMessageListProps';
import { slotCore } from '../../services/view-registry/SlotCore';
import { ChatCard } from './ChatCard';

const hoisted = vi.hoisted(() => ({
  state: null as Record<string, unknown> | null,
  listPropsLog: [] as ChatMessageListProps[],
  leafRenderCount: 0,
  wrapperPropsLog: [] as Record<string, unknown>[],
  followUpCalls: [] as { buildIndex: number; prompt: string }[],
  buildIndex: 0,
}));

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../../store/storeAccess', () => ({
  openSettings: vi.fn(),
  patchSession: vi.fn(),
}));

vi.mock('../../api/providerProfiles', () => ({
  listProviderProfiles: () => [],
  getProviderProfile: () => null,
}));

vi.mock('./ChatHeaderControls', () => ({
  ModelBadgePicker: () => null,
}));

vi.mock('../chat-composer/ChatComposer', () => ({
  ChatComposer: () => <div data-testid="mock-composer" />,
}));

vi.mock('./ChatComposerWrapper', () => ({
  ChatComposerWrapper: (props: Record<string, unknown>) => {
    hoisted.wrapperPropsLog.push(props);
    return <div data-testid="mock-composer-wrap" />;
  },
}));

vi.mock('./ChatEmptyState', () => ({
  ChatEmptyState: () => <div data-testid="mock-empty" />,
}));

vi.mock('../settings/ScheduledTasksPanel', () => ({
  ScheduledTasksPanel: () => <div data-testid="mock-scheduled" />,
}));

// 列表替身：记录每次收到的 props，并把 props 透传给一个 React.memo 叶
// 组件——叶的函数体执行次数即「列表真正重渲染次数」，与生产环境
// ChatMessageList 的默认浅比较 memo 语义同构（六分组任一换引用即穿透）。
vi.mock('../chat-message-list/ChatMessageList', async () => {
  const React = await import('react');
  const Leaf = React.memo(function Leaf(_props: ChatMessageListProps) {
    hoisted.leafRenderCount++;
    return <div data-testid="list-leaf" />;
  });
  const ChatMessageList = (props: ChatMessageListProps) => {
    hoisted.listPropsLog.push(props);
    return <Leaf {...props} />;
  };
  return { ChatMessageList };
});

vi.mock('./useChatCardState', () => ({
  useChatCardState: () => hoisted.state,
}));

vi.mock('./useChatCardDragDrop', () => ({
  useChatCardDragDrop: () => ({ isDragOver: false, dragHandlers: {} }),
}));

// —— 跨构建恒定的字段引用（复刻真实代码中 store 派生/useCallback 的稳定性）
const MESSAGES = Array.from({ length: 60 }, (_, i) => ({
  id: `m-${i}`,
  sender: i % 2 === 0 ? 'user' : 'assistant',
  timestamp: i + 1,
  text: `消息 ${i}`,
}));
const DISPLAY_MESSAGES = [...MESSAGES];
const AGENTS: unknown[] = [];
const ATTACHMENTS: unknown[] = [];
const FILTERED_COMMANDS = [{ cmd: '/goal', desc: '目标' }];
const noop = () => {};
const noopAsync = async () => {};
const stableComposerFields = {
  setChatInput: noop,
  isComposing: false,
  setIsComposing: noop,
  hasUndo: false,
  handleUndoDraft: noop,
  draftInjectionTick: 0,
  slashMenuOpen: false,
  setSlashMenuOpen: noop,
  slashSelectedIndex: 0,
  setSlashSelectedIndex: noop,
  filteredCommands: FILTERED_COMMANDS,
  loadSkillSlash: noopAsync,
  attachments: ATTACHMENTS,
  setAttachments: noop,
  fileInputRef: { current: null },
  handleFilesSelected: noop,
  handlePathsSelected: noop,
  handleDroppedFiles: noop,
  handlePickFiles: noop,
  handlePasteImage: noop,
  handlePasteFiles: noop,
  handlePastePath: noop,
  showPlusMenu: false,
  setShowPlusMenu: noop,
  runStreamingAssistant: noopAsync,
  handleSendChat: noopAsync,
  handleStopGeneration: noop,
  handleSilentStopGeneration: noop,
  handleForceCancelGeneration: noop,
  onSend: noopAsync,
};
const stableStateFields = {
  messages: MESSAGES,
  displayMessages: DISPLAY_MESSAGES,
  agents: AGENTS,
  activeSessionId: 'sess-1',
  isFiltering: false,
  showProjectPicker: false,
  setShowProjectPicker: noop,
  handleProjectChanged: noop,
  openDiffInRightPanel: noop,
  openPathInFilesPanel: noop,
  handleOpenTerminal: noop,
  handleOpenDiffPanel: noop,
  engineModel: 'gpt-test',
  engineHint: null as { ok: boolean } | null,
  engineOk: true,
  needsModelSetup: false,
  needsKeySetup: false,
  showModelDropdown: false,
  setShowModelDropdown: noop,
  isProcessing: false,
  permissionMode: 'smart',
  setPermissionMode: noop,
  emptyKind: null,
  mainSurface: 'chat',
  setMainSurface: noop,
  messagesLoading: false,
  localMsgFilter: '',
  setLocalMsgFilter: noop,
  chatRegionAria: '聊天',
  workspaceKey: 'default',
  firstRunOpen: false,
  handleCreateSessionFromEmpty: noopAsync,
  diffFiles: [] as unknown[],
  openSidePanel: noop,
  onEmptySurface: noop,
  goalMode: null,
  goalModeActive: false,
  setProjectTick: noop,
};

function makeState(
  opts: { draft?: string } & Record<string, unknown> = {}
): Record<string, unknown> {
  const { draft = '', ...overrides } = opts;
  const buildIndex = ++hoisted.buildIndex;
  return {
    ...stableStateFields,
    // 逐构建新闭包：复刻真实 churn（见文件头注释）
    handleSendFollowUp: (prompt: string) => {
      hoisted.followUpCalls.push({ buildIndex, prompt });
    },
    handleRegenerate: vi.fn(),
    handleBranch: vi.fn(),
    handleRetract: vi.fn(),
    handleEditMessageAndResend: vi.fn(),
    approvalState: {
      approvalBusy: false,
      pendingApprovalMsgId: null,
      approvalUiPlan: { mode: 'idle' },
      handleApprovalAllow: vi.fn(),
      handleApprovalDeny: vi.fn(),
      handleBatchApprove: vi.fn(),
      handleBatchDeny: vi.fn(),
    },
    composerProps: {
      ...stableComposerFields,
      chatInput: draft,
      canSend: Boolean(draft.trim()),
    },
    ...overrides,
  };
}

describe('ChatCard · 打字解耦（R1 / P0-2）', () => {
  beforeEach(() => {
    slotCore.clear();
    hoisted.state = null;
    hoisted.listPropsLog = [];
    hoisted.leafRenderCount = 0;
    hoisted.wrapperPropsLog = [];
    hoisted.followUpCalls = [];
    hoisted.buildIndex = 0;
  });

  it('60 行长会话下 20 次草稿变更：列表零重渲染、分组引用恒定、追问走最新闭包', () => {
    hoisted.state = makeState({ draft: '' });
    const ui = render(
      <ChatCard handleGlobalTabClick={vi.fn()} sessionId="sess-1" />
    );
    expect(hoisted.leafRenderCount).toBe(1);
    const firstProps = hoisted.listPropsLog[0];

    for (let i = 1; i <= 20; i++) {
      hoisted.state = makeState({ draft: `草稿${i}` });
      ui.rerender(
        <ChatCard handleGlobalTabClick={vi.fn()} sessionId="sess-1" />
      );
    }

    // ① 列表 memo 叶从未重渲染
    expect(hoisted.leafRenderCount).toBe(1);
    // ② 六分组引用逐次恒定（注：替身记录的是 React 为元素合成的 props
    // 对象，其本体逐渲染新建、不可比；契约落在六个分组字段的引用上——
    // 它们正是 MessageVirtualizer 分组比较与列表 memo 的实际输入）
    const lastProps = hoisted.listPropsLog[hoisted.listPropsLog.length - 1];
    expect(lastProps.messages).toBe(firstProps.messages);
    expect(lastProps.projectPicker).toBe(firstProps.projectPicker);
    expect(lastProps.composer).toBe(firstProps.composer);
    expect(lastProps.generation).toBe(firstProps.generation);
    expect(lastProps.approval).toBe(firstProps.approval);
    expect(lastProps.navigation).toBe(firstProps.navigation);

    // ③ trampoline 恒调用最新构建（第 21 次构建）的闭包，无陈旧闭包
    lastProps.composer.onSendFollowUp?.('继续任务');
    expect(hoisted.followUpCalls).toEqual([
      { buildIndex: hoisted.buildIndex, prompt: '继续任务' },
    ]);

    // ④ 与输入框无关的状态变化不换 composerElement 引用（草稿内容不变）
    const elementBefore =
      hoisted.wrapperPropsLog[hoisted.wrapperPropsLog.length - 1]
        .composerElement;
    hoisted.state = makeState({ draft: '草稿20', engineHint: { ok: false } });
    ui.rerender(<ChatCard handleGlobalTabClick={vi.fn()} sessionId="sess-1" />);
    const elementAfter =
      hoisted.wrapperPropsLog[hoisted.wrapperPropsLog.length - 1]
        .composerElement;
    expect(elementAfter).toBe(elementBefore);
    expect(hoisted.leafRenderCount).toBe(1);

    // ⑤ 正对照：displayMessages 真变化时列表必须放行重渲染
    hoisted.state = makeState({
      draft: '草稿20',
      displayMessages: [
        ...DISPLAY_MESSAGES,
        { id: 'm-60', sender: 'user', timestamp: 61, text: '新消息' },
      ],
    });
    ui.rerender(<ChatCard handleGlobalTabClick={vi.fn()} sessionId="sess-1" />);
    expect(hoisted.leafRenderCount).toBe(2);
  });
});
