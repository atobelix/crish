/**
 * apps/crish-desktop/src/store/sessionEviction.test.ts
 *
 * Wave 1 · Task W1-E：标签栏感知软驱逐与会话保活状态机单元测试。
 * 覆盖：
 * 1. 三级保活状态机（PinnedActive / OpenRetained / EvictableCandidate）精确分类；
 * 2. 多标签页与左右/上下分屏操作下，邻叶会话与后台打开标签绝不被误驱逐；
 * 3. 流式推流中会话（消息流式、块流式、思考流式、工具运行、StreamingStore 缓冲、显式标记）绝对保活；
 * 4. 后台历史会话（EvictableCandidate）在超出上限时严格按 LRU 从旧到新软驱逐；
 * 5. 软驱逐后保留懒壳（messagesHydrated=false, messages=[], 删除 hydratedFromEngine）及二次防御守卫。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  applySoftEvictionInState,
  classifySessionEvictionTier,
  clearSessionAccessTimestamps,
  evaluateSessionEviction,
  findInactiveHydratedSessionIdsToEvict,
  getActiveStreamingSessionIds,
  getOpenTabSessionIds,
  getVisibleSplitSessionIds,
  isSessionStreaming,
  planSessionsToEvict,
  recordSessionAccess,
  softEvictSessionToLazyShell,
  type EvictableSessionState,
} from './sessionEviction';
import {
  createDefaultTree,
  createLeaf,
  createSessionTab,
  useLayoutTreeStore,
} from './layout-tree';
import { createBranch } from './layout-tree/types';
import { useStreamingStore } from './streamingStore';
import type { SessionMessage } from './types';
import { useWorkspaceShellStore } from './workspace-shell/workspaceShellStore';

function makeMessage(
  id: string,
  overrides: Partial<SessionMessage> = {}
): SessionMessage {
  return {
    id,
    sender: 'assistant',
    text: `content-${id}`,
    timestamp: 1_700_000_000_000,
    status: 'completed',
    ...overrides,
  };
}

function makeSession(
  id: string,
  overrides: Partial<EvictableSessionState> = {}
): EvictableSessionState {
  return {
    id,
    title: `Session ${id}`,
    folder: '常规会话',
    isPinned: false,
    isArchived: false,
    timestamp: '2026-10-12T00:00:00.000Z',
    messages: [makeMessage(`msg-${id}`)],
    messagesHydrated: true,
    hydratedFromEngine: true,
    hydrationStatus: 'Hydrated_Ready',
    messageCount: 1,
    ...overrides,
  };
}

describe('sessionEviction — 标签栏感知三级保活软驱逐状态机 (W1-E)', () => {
  beforeEach(() => {
    clearSessionAccessTimestamps();
    useLayoutTreeStore.setState({
      tree: createDefaultTree(),
      activeLeafId: null,
    });
    useStreamingStore.setState({ byKey: Object.create(null) });
    const shellState = useWorkspaceShellStore.getState() as unknown as Record<
      string,
      unknown
    >;
    delete shellState.openTabs;
    delete shellState.openTabIds;
  });

  describe('1. 三级保活状态机分类 (PinnedActive / OpenRetained / EvictableCandidate)', () => {
    it('当前活跃聚焦会话与流式推流会话归为 PinnedActive，打开标签与分屏归为 OpenRetained，其余归为 EvictableCandidate', () => {
      const sActive = makeSession('sess-active');
      const sStreaming = makeSession('sess-streaming', { isStreaming: true });
      const sSplit = makeSession('sess-split');
      const sOpenTab = makeSession('sess-open-tab');
      const sHistory = makeSession('sess-history');

      const context = {
        activeSessionId: 'sess-active',
        streamingSessionIds: new Set<string>(),
        visibleSplitSessionIds: new Set<string>(['sess-split']),
        openTabSessionIds: new Set<string>(['sess-split', 'sess-open-tab']),
      };

      expect(classifySessionEvictionTier(sActive, context)).toBe(
        'PinnedActive'
      );
      expect(classifySessionEvictionTier(sStreaming, context)).toBe(
        'PinnedActive'
      );
      expect(classifySessionEvictionTier(sSplit, context)).toBe('OpenRetained');
      expect(classifySessionEvictionTier(sOpenTab, context)).toBe(
        'OpenRetained'
      );
      expect(classifySessionEvictionTier(sHistory, context)).toBe(
        'EvictableCandidate'
      );
    });

    it('当分屏会话同时处于流式推流态时，优先升级为最高级别 PinnedActive', () => {
      const sSplitStreaming = makeSession('sess-split-stream', {
        messages: [makeMessage('m1', { status: 'processing' })],
      });

      const tier = classifySessionEvictionTier(sSplitStreaming, {
        activeSessionId: 'sess-other',
        openTabSessionIds: new Set(['sess-split-stream']),
        visibleSplitSessionIds: new Set(['sess-split-stream']),
      });

      expect(tier).toBe('PinnedActive');
    });
  });

  describe('2. 流式推流会话全方位识别与绝对保活 (PinnedActive Hard Immunity)', () => {
    it('全方位识别各种流式信号：isStreaming 字段、message.status、blocks.isStreaming、thinkingTurns、toolCalls、agents 及 StreamingStore', () => {
      const sByFlag = makeSession('s-flag', { isStreaming: true });
      const sByMsgStatus = makeSession('s-msg-status', {
        messages: [makeMessage('m1', { status: 'processing' })],
      });
      const sByBlock = makeSession('s-block', {
        messages: [
          makeMessage('m2', {
            status: 'completed',
            blocks: [
              { type: 'text', content: 'streaming...', isStreaming: true },
            ],
          }),
        ],
      });
      const sByThinking = makeSession('s-thinking', {
        messages: [
          makeMessage('m3', {
            thinkingTurns: [
              { turnIndex: 0, content: 'thinking', isStreaming: true },
            ],
          }),
        ],
      });
      const sByTool = makeSession('s-tool', {
        messages: [
          makeMessage('m4', {
            toolCalls: [{ id: 'tc1', name: 'bash', status: 'running' }],
          }),
        ],
      });
      const sByAgent = makeSession('s-agent', {
        agents: [
          {
            id: 'ag1',
            subagentRunId: 'run1',
            parentSessionId: 's-agent',
            parentRunId: 'prun1',
            description: 'subagent',
            mode: 'implement',
            status: 'running',
            messages: [],
            startedAt: 1000,
          },
        ],
      });
      const sByStreamStore = makeSession('s-stream-store');
      useStreamingStore
        .getState()
        .setStreamText('s-stream-store', 'msg-live', 'delta token');

      const sIdle = makeSession('s-idle');

      expect(isSessionStreaming(sByFlag)).toBe(true);
      expect(isSessionStreaming(sByMsgStatus)).toBe(true);
      expect(isSessionStreaming(sByBlock)).toBe(true);
      expect(isSessionStreaming(sByThinking)).toBe(true);
      expect(isSessionStreaming(sByTool)).toBe(true);
      expect(isSessionStreaming(sByAgent)).toBe(true);
      expect(isSessionStreaming(sByStreamStore)).toBe(true);
      expect(isSessionStreaming(sIdle)).toBe(false);

      const all = [
        sByFlag,
        sByMsgStatus,
        sByBlock,
        sByThinking,
        sByTool,
        sByAgent,
        sByStreamStore,
        sIdle,
      ];
      const byId = Object.fromEntries(all.map((s) => [s.id, s]));
      const activeStreams = getActiveStreamingSessionIds(byId, all);

      expect(activeStreams.has('s-flag')).toBe(true);
      expect(activeStreams.has('s-msg-status')).toBe(true);
      expect(activeStreams.has('s-block')).toBe(true);
      expect(activeStreams.has('s-thinking')).toBe(true);
      expect(activeStreams.has('s-tool')).toBe(true);
      expect(activeStreams.has('s-agent')).toBe(true);
      expect(activeStreams.has('s-stream-store')).toBe(true);
      expect(activeStreams.has('s-idle')).toBe(false);
    });

    it('即使 keepBudget=1 且调用方传入空 streamingSessionIds，所有推流中后台会话也绝对不会被驱逐', () => {
      const sActive = makeSession('s-active', { lastAccessedAt: 5000 });
      const sStreamBg1 = makeSession('s-stream-bg-1', {
        lastAccessedAt: 1000,
        isStreaming: true,
      });
      const sStreamBg2 = makeSession('s-stream-bg-2', {
        lastAccessedAt: 900,
        messages: [
          makeMessage('m-s2', {
            blocks: [{ type: 'text', content: 'partial', isStreaming: true }],
          }),
        ],
      });
      const sStreamBg3 = makeSession('s-stream-bg-3', { lastAccessedAt: 800 });
      useStreamingStore
        .getState()
        .setStreamText('s-stream-bg-3', 'msg-3', 'streaming token');

      const sIdleOld = makeSession('s-idle-old', { lastAccessedAt: 2000 });

      const sessions = [sActive, sStreamBg1, sStreamBg2, sStreamBg3, sIdleOld];
      const sessionsById = Object.fromEntries(sessions.map((s) => [s.id, s]));

      const toEvict = findInactiveHydratedSessionIdsToEvict(
        's-active',
        new Set(),
        sessions,
        sessionsById,
        1
      );

      expect(toEvict).toEqual(['s-idle-old']);
      expect(toEvict).not.toContain('s-active');
      expect(toEvict).not.toContain('s-stream-bg-1');
      expect(toEvict).not.toContain('s-stream-bg-2');
      expect(toEvict).not.toContain('s-stream-bg-3');
    });
  });

  describe('3. 多标签栏与多分屏（Split Panes）感知保活 (OpenRetained)', () => {
    it('通过 LayoutTreeStore 感知左右分屏与后台标签页，切换焦点时分屏邻叶会话绝不被误驱逐', () => {
      const tabLeftActive = createSessionTab({
        tabId: 'tab-l1',
        sessionId: 's-left-active',
        title: 'Left Active',
      });
      const tabLeftBg = createSessionTab({
        tabId: 'tab-l2',
        sessionId: 's-left-bg-tab',
        title: 'Left Background Tab',
      });
      const tabRightSplit = createSessionTab({
        tabId: 'tab-r1',
        sessionId: 's-right-split',
        title: 'Right Split Pane',
      });

      const leftLeaf = createLeaf({
        id: 'leaf-left',
        tabs: [tabLeftActive, tabLeftBg],
        activeTabId: 'tab-l1',
      });
      const rightLeaf = createLeaf({
        id: 'leaf-right',
        tabs: [tabRightSplit],
        activeTabId: 'tab-r1',
      });
      const branch = createBranch('horizontal', leftLeaf, rightLeaf, 0.5);

      useLayoutTreeStore.setState({
        tree: { root: branch, version: 3 },
        activeLeafId: 'leaf-left',
      });

      expect(getVisibleSplitSessionIds()).toEqual(
        new Set(['s-left-active', 's-right-split'])
      );
      expect(getOpenTabSessionIds()).toEqual(
        new Set(['s-left-active', 's-left-bg-tab', 's-right-split'])
      );

      const sLeftActive = makeSession('s-left-active', { lastAccessedAt: 500 });
      const sRightSplit = makeSession('s-right-split', { lastAccessedAt: 100 });
      const sLeftBgTab = makeSession('s-left-bg-tab', { lastAccessedAt: 200 });
      const sHistoryOld = makeSession('s-history-old', { lastAccessedAt: 300 });
      const sHistoryNew = makeSession('s-history-new', { lastAccessedAt: 400 });

      const sessions = [
        sLeftActive,
        sRightSplit,
        sLeftBgTab,
        sHistoryOld,
        sHistoryNew,
      ];
      const sessionsById = Object.fromEntries(sessions.map((s) => [s.id, s]));

      const plan = evaluateSessionEviction(sessions, sessionsById, {
        activeSessionId: 's-left-active',
        keepBudget: 3,
      });

      expect(plan.pinnedActiveIds).toEqual(['s-left-active']);
      expect(plan.openRetainedIds).toEqual(['s-right-split', 's-left-bg-tab']);
      expect(plan.evictableCandidateIds).toEqual([
        's-history-old',
        's-history-new',
      ]);
      expect(plan.sessionIdsToEvict).toEqual([
        's-history-old',
        's-history-new',
      ]);
      expect(plan.sessionIdsToEvict).not.toContain('s-right-split');
      expect(plan.sessionIdsToEvict).not.toContain('s-left-bg-tab');
    });

    it('通过 WorkspaceShellStore.openTabs 或显式 openTabs 感知打开标签，即使打开标签数超过 keepBudget 也不误驱逐打开的标签', () => {
      const shellState = useWorkspaceShellStore.getState() as unknown as Record<
        string,
        unknown
      >;
      shellState.openTabs = [
        { sessionId: 's-open-1' },
        { sessionId: 's-open-2' },
        { sessionId: 's-open-3' },
        { sessionId: 's-open-4' },
      ];

      const s1 = makeSession('s-open-1', { lastAccessedAt: 1000 });
      const s2 = makeSession('s-open-2', { lastAccessedAt: 100 });
      const s3 = makeSession('s-open-3', { lastAccessedAt: 200 });
      const s4 = makeSession('s-open-4', { lastAccessedAt: 300 });
      const sClosed1 = makeSession('s-closed-1', { lastAccessedAt: 800 });
      const sClosed2 = makeSession('s-closed-2', { lastAccessedAt: 900 });

      const sessions = [s1, s2, s3, s4, sClosed1, sClosed2];
      const sessionsById = Object.fromEntries(sessions.map((s) => [s.id, s]));

      const evicted = planSessionsToEvict(
        's-open-1',
        sessions,
        sessionsById,
        3
      );

      expect(evicted).toEqual(['s-closed-1', 's-closed-2']);
      expect(evicted).not.toContain('s-open-2');
      expect(evicted).not.toContain('s-open-3');
      expect(evicted).not.toContain('s-open-4');
    });
  });

  describe('4. EvictableCandidate 后台历史会话 LRU 软驱逐顺序与预算控制', () => {
    it('当 PinnedActive + OpenRetained 未占满 keepBudget 时，剩余名额保留最近访问的 EvictableCandidate，仅驱逐最久未访问会话', () => {
      const sActive = makeSession('s-active', { lastAccessedAt: 10_000 });
      const sTab = makeSession('s-tab', { lastAccessedAt: 5_000 });
      const sCand1 = makeSession('s-cand-t300', { lastAccessedAt: 300 });
      const sCand2 = makeSession('s-cand-t100', { lastAccessedAt: 100 });
      const sCand3 = makeSession('s-cand-t400', { lastAccessedAt: 400 });
      const sCand4 = makeSession('s-cand-t200', { lastAccessedAt: 200 });

      const sessions = [sActive, sTab, sCand1, sCand2, sCand3, sCand4];
      const sessionsById = Object.fromEntries(sessions.map((s) => [s.id, s]));

      const evicted = planSessionsToEvict(
        's-active',
        sessions,
        sessionsById,
        4,
        { openTabs: ['s-tab'] }
      );

      expect(evicted).toEqual(['s-cand-t100', 's-cand-t200']);
    });

    it('支持通过 recordSessionAccess 与 hydrationMeta.lastHydratedAt 追踪 LRU 访问序', () => {
      const sActive = makeSession('s-active');
      const sA = makeSession('s-a', {
        hydrationMeta: { lastHydratedAt: 2000 },
      });
      const sB = makeSession('s-b');
      const sC = makeSession('s-c');

      recordSessionAccess('s-b', 1000);
      recordSessionAccess('s-c', 3000);

      const sessions = [sActive, sA, sB, sC];
      const sessionsById = Object.fromEntries(sessions.map((s) => [s.id, s]));

      const evicted = planSessionsToEvict(
        's-active',
        sessions,
        sessionsById,
        2
      );
      expect(evicted).toEqual(['s-b', 's-a']);
    });

    it('已水合会话总数未超过 keepBudget 时不驱逐任何会话；空壳会话不占用已水合配额', () => {
      const sActive = makeSession('s-active');
      const sHydrated1 = makeSession('s-h1');
      const sHydrated2 = makeSession('s-h2');
      const sLazy1 = makeSession('s-lazy-1', {
        messages: [],
        messagesHydrated: false,
        hydrationStatus: 'Shell_Lazy',
      });
      const sLazy2 = makeSession('s-lazy-2', {
        messages: [],
        messagesHydrated: false,
        hydrationStatus: 'Shell_Lazy',
      });

      const sessions = [sActive, sHydrated1, sHydrated2, sLazy1, sLazy2];
      const sessionsById = Object.fromEntries(sessions.map((s) => [s.id, s]));

      const evicted = planSessionsToEvict(
        's-active',
        sessions,
        sessionsById,
        3
      );
      expect(evicted).toEqual([]);
    });
  });

  describe('5. 软驱逐状态变更契约与二次防线 (softEvictSessionToLazyShell & applySoftEvictionInState)', () => {
    it('软驱逐后保留懒壳元数据，标记 messagesHydrated=false、messages=[]、清除 hydratedFromEngine', () => {
      const s = makeSession('s-target', {
        title: '重要历史讨论',
        folder: 'project-alpha',
        messageCount: 12,
        engineCursor: 48,
      });

      softEvictSessionToLazyShell(s);

      expect(s.messages).toEqual([]);
      expect(s.messagesHydrated).toBe(false);
      expect('hydratedFromEngine' in s).toBe(false);
      expect(s.hydrationStatus).toBe('Shell_Lazy');
      expect(s.id).toBe('s-target');
      expect(s.title).toBe('重要历史讨论');
      expect(s.folder).toBe('project-alpha');
      expect(s.messageCount).toBe(12);
      expect(s.engineCursor).toBe(48);
    });

    it('applySoftEvictionInState 具备刚性防线：即使误传入当前聚焦或正在推流的会话 ID，也绝不清空其正文', () => {
      const sActive = makeSession('s-active');
      const sStreaming = makeSession('s-streaming', { isStreaming: true });
      const sOpenTab = makeSession('s-open-tab');
      const sCandidate = makeSession('s-candidate');

      const state = {
        activeSessionId: 's-active',
        sessions: [sActive, sStreaming, sOpenTab, sCandidate],
        sessionsById: {
          's-active': sActive,
          's-streaming': sStreaming,
          's-open-tab': sOpenTab,
          's-candidate': sCandidate,
        },
      };

      const actuallyEvicted = applySoftEvictionInState(
        state,
        ['s-active', 's-streaming', 's-open-tab', 's-candidate'],
        {
          openTabSessionIds: new Set(['s-open-tab']),
        }
      );

      expect(actuallyEvicted).toEqual(['s-candidate']);
      expect(state.sessionsById['s-candidate']?.messages).toEqual([]);
      expect(state.sessionsById['s-candidate']?.messagesHydrated).toBe(false);

      expect(state.sessionsById['s-active']?.messages).toHaveLength(1);
      expect(state.sessionsById['s-active']?.messagesHydrated).toBe(true);
      expect(state.sessionsById['s-streaming']?.messages).toHaveLength(1);
      expect(state.sessionsById['s-streaming']?.messagesHydrated).toBe(true);
      expect(state.sessionsById['s-open-tab']?.messages).toHaveLength(1);
      expect(state.sessionsById['s-open-tab']?.messagesHydrated).toBe(true);
    });
  });
});
