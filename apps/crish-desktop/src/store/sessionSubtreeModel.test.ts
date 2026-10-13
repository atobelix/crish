// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_PERSIST_DEBOUNCE_MS } from './persistenceConstants';
import {
  getSessionMetaById,
  reorderSessionOrderById,
  reorderSessionOrderByIdList,
} from './sessionIndex';
import {
  clearSessionSelectorsCache,
  selectHydrationComplete,
  selectSessionMessageEpoch,
  selectSessionMeta,
  selectSessionMetaEpoch,
  selectSessionOrder,
  useSessionAgents,
  useSessionFolder,
  useSessionIsPinned,
  useSessionMessageEpoch,
  useSessionMessages,
  useSessionMeta,
  useSessionMetaEpoch,
  useSessionOrder,
  useSessionTitle,
} from './sessionSelectors';
import { useSessionStore } from './sessionStore';
import {
  bumpEpochScalar,
  createInitialSubtreeSlice,
  EMPTY_AGENTS,
  EMPTY_MESSAGES,
  extractSessionMeta,
  isSessionMetaEqual,
  patchSubtreeSessionMeta,
  performThreeWaySubtreeMerge,
  SessionPersistenceCoordinator,
  updateSubtreeMessageText,
  type PersistCoordinatorState,
  type SotaPersistPayload,
} from './sessionSubtreeModel';
import type { SessionAgent, SessionMessage, SessionState } from './types';

function makeMessage(
  id: string,
  text: string,
  sender: 'user' | 'assistant' = 'assistant'
): SessionMessage {
  return {
    id,
    sender,
    text,
    timestamp: 1700000000000,
    blocks: [{ type: 'text', content: text, startTime: 1700000000000 }],
  };
}

function makeSession(
  id: string,
  title: string,
  messages: SessionMessage[] = [],
  agents: SessionAgent[] = []
): SessionState {
  return {
    id,
    title,
    folder: '默认项目',
    isPinned: false,
    isArchived: false,
    timestamp: '2026-10-13T00:00:00.000Z',
    messages,
    agents,
  };
}

describe('Stage 01 — sessionSubtreeModel & Orthogonal 3-Subtree Architecture', () => {
  beforeEach(() => {
    clearSessionSelectorsCache();
    useSessionStore.setState({
      ...createInitialSubtreeSlice(),
      sessions: [],
      sessionsById: {},
      folderOrder: ['默认项目'],
      activeSessionId: '',
      draftFolder: '',
      activeAgentId: null,
      panelAgentId: null,
      composerDrafts: {},
      hydrationComplete: true,
    });
  });

  afterEach(() => {
    clearSessionSelectorsCache();
    vi.useRealTimers();
  });

  it('ASSERT-01-01: 100 Token/s 高频流式推流期间 metaById / agentsBySessionId / sessionOrder 引用 100% 恒定且元数据组件 0 重渲染', () => {
    const sess1 = makeSession('sess-stream', '流式主会话', [
      makeMessage('m-stream', 'init'),
    ]);
    const sess2 = makeSession('sess-idle', '旁路静止会话', [
      makeMessage('m-idle', 'hello'),
    ]);

    useSessionStore.setState((st) => {
      st.sessions = [sess1, sess2];
      st.sessionsById = { [sess1.id]: sess1, [sess2.id]: sess2 };
    });

    const initialMetaMapRef = useSessionStore.getState().metaById;
    const initialAgentsMapRef = useSessionStore.getState().agentsBySessionId;
    const initialOrderRef = useSessionStore.getState().sessionOrder;
    const initialIdleMsgsRef =
      useSessionStore.getState().messagesBySessionId['sess-idle'];

    let metaRenders = 0;
    let titleRenders = 0;
    let folderRenders = 0;
    let pinnedRenders = 0;
    let agentsRenders = 0;
    let metaEpochRenders = 0;
    let orderRenders = 0;
    let msgEpochRenders = 0;
    let messagesRenders = 0;

    function Observers() {
      const meta = useSessionMeta('sess-stream');
      metaRenders++;
      const title = useSessionTitle('sess-stream');
      titleRenders++;
      const folder = useSessionFolder('sess-stream');
      folderRenders++;
      const pinned = useSessionIsPinned('sess-stream');
      pinnedRenders++;
      const agents = useSessionAgents('sess-stream');
      agentsRenders++;
      const metaEpoch = useSessionMetaEpoch('sess-stream');
      metaEpochRenders++;
      const order = useSessionOrder();
      orderRenders++;
      return React.createElement(
        'div',
        { 'data-testid': 'meta-summary' },
        `${meta?.title}:${title}:${folder}:${pinned}:${agents.length}:${metaEpoch}:${order.length}`
      );
    }

    function StreamConsumer() {
      const msgEpoch = useSessionMessageEpoch('sess-stream');
      msgEpochRenders++;
      const msgs = useSessionMessages('sess-stream');
      messagesRenders++;
      return React.createElement(
        'div',
        { 'data-testid': 'stream-view' },
        `${msgEpoch}:${msgs[0]?.text ?? ''}`
      );
    }

    render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Observers),
        React.createElement(StreamConsumer)
      )
    );

    expect(metaRenders).toBe(1);
    expect(msgEpochRenders).toBe(1);

    // 模拟 100 Token/s 连续推流 100 次
    for (let i = 1; i <= 100; i++) {
      act(() => {
        useSessionStore
          .getState()
          .updateMessageText('sess-stream', 'm-stream', `init token-${i}`);
      });
    }

    const afterState = useSessionStore.getState();

    // 1. 正交子树物理引用 100% 恒定 (===)
    expect(afterState.metaById).toBe(initialMetaMapRef);
    expect(afterState.agentsBySessionId).toBe(initialAgentsMapRef);
    expect(afterState.sessionOrder).toBe(initialOrderRef);
    expect(afterState.messagesBySessionId['sess-idle']).toBe(
      initialIdleMsgsRef
    );

    // 2. 元数据与顺序订阅组件保持绝对 0 重渲染（仅首屏挂载 1 次）
    expect(metaRenders).toBe(1);
    expect(titleRenders).toBe(1);
    expect(folderRenders).toBe(1);
    expect(pinnedRenders).toBe(1);
    expect(agentsRenders).toBe(1);
    expect(metaEpochRenders).toBe(1);
    expect(orderRenders).toBe(1);

    // 3. 流式消费者与 messageEpoch 精准递增 100 次
    expect(msgEpochRenders).toBe(101);
    expect(messagesRenders).toBe(101);
    expect(selectSessionMessageEpoch(afterState, 'sess-stream')).toBe(100);
    expect(selectSessionMetaEpoch(afterState, 'sess-stream')).toBe(0);
    expect(screen.getByTestId('stream-view').textContent).toBe(
      '100:init token-100'
    );
  });

  it('ASSERT-01-02: 2,000 条历史消息大负载下 updateSubtreeMessageText 单次均摊耗时 < 0.08ms', () => {
    const historyMessages: SessionMessage[] = Array.from(
      { length: 2000 },
      (_, i) => makeMessage(`msg-${i}`, `Historical message content line ${i}`)
    );
    let slice = createInitialSubtreeSlice();
    slice.metaById['sess-2k'] = extractSessionMeta(
      makeSession('sess-2k', '2000条压测')
    );
    slice.sessionOrder = ['sess-2k'];
    slice.messagesBySessionId['sess-2k'] = historyMessages;
    slice.agentsBySessionId['sess-2k'] = EMPTY_AGENTS;
    slice.metaEpochById['sess-2k'] = 0;
    slice.messageEpochById['sess-2k'] = 0;

    // 预热 JIT
    for (let w = 0; w < 10; w++) {
      slice = updateSubtreeMessageText(
        slice,
        'sess-2k',
        'msg-1999',
        `warmup ${w}`
      );
    }

    const iterations = 100;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      slice = updateSubtreeMessageText(
        slice,
        'sess-2k',
        'msg-1999',
        `streamed token payload ${i}`,
        `<p>${i}</p>`
      );
    }
    const elapsedMs = performance.now() - start;
    const avgMs = elapsedMs / iterations;

    expect(avgMs).toBeLessThan(0.08);
    expect(slice.messagesBySessionId['sess-2k']?.[1999]?.text).toBe(
      'streamed token payload 99'
    );
    expect(slice.messagesBySessionId['sess-2k']?.[1999]?.precomputedHtml).toBe(
      '<p>99</p>'
    );
    expect(slice.messageEpochById['sess-2k']).toBe(110);
  });

  it('ASSERT-01-03: patchSessionMeta 与 renameSession 绝对零触碰 messagesBySessionId 与 agentsBySessionId', () => {
    const sess = makeSession('sess-meta', '原始标题', [
      makeMessage('m1', 'body'),
    ]);
    useSessionStore.setState((st) => {
      st.sessions = [sess];
      st.sessionsById = { [sess.id]: sess };
    });

    const before = useSessionStore.getState();
    const msgsMapBefore = before.messagesBySessionId;
    const agentsMapBefore = before.agentsBySessionId;
    const orderBefore = before.sessionOrder;

    // 1. 调用 patchSessionMeta
    useSessionStore
      .getState()
      .patchSessionMeta('sess-meta', { title: 'SOTA 新标题', isPinned: true });
    const afterPatch = useSessionStore.getState();

    expect(afterPatch.messagesBySessionId).toBe(msgsMapBefore);
    expect(afterPatch.agentsBySessionId).toBe(agentsMapBefore);
    expect(afterPatch.sessionOrder).toBe(orderBefore);
    expect(afterPatch.metaById['sess-meta']?.title).toBe('SOTA 新标题');
    expect(afterPatch.metaById['sess-meta']?.isPinned).toBe(true);
    expect(selectSessionMetaEpoch(afterPatch, 'sess-meta')).toBe(1);
    expect(selectSessionMessageEpoch(afterPatch, 'sess-meta')).toBe(0);

    // 2. 幂等短路：相同属性 patch 不产生新引用，不递增 metaEpoch
    useSessionStore
      .getState()
      .patchSessionMeta('sess-meta', { title: 'SOTA 新标题', isPinned: true });
    expect(useSessionStore.getState().metaById).toBe(afterPatch.metaById);
    expect(
      selectSessionMetaEpoch(useSessionStore.getState(), 'sess-meta')
    ).toBe(1);

    // 3. 调用 renameSession 同样保持 messagesBySessionId 零触碰
    useSessionStore.getState().renameSession('sess-meta', '二次改名');
    const afterRename = useSessionStore.getState();
    expect(afterRename.messagesBySessionId).toBe(msgsMapBefore);
    expect(afterRename.agentsBySessionId).toBe(agentsMapBefore);
    expect(afterRename.metaById['sess-meta']?.title).toBe('二次改名');
    expect(selectSessionMetaEpoch(afterRename, 'sess-meta')).toBe(2);
    expect(selectSessionMessageEpoch(afterRename, 'sess-meta')).toBe(0);
  });

  it('ASSERT-01-04: 内置双标量版本代数槽位支持 ((prev + 1) | 0) 32位有符号整数原子递增与溢出安全回绕', () => {
    expect(bumpEpochScalar(undefined)).toBe(1);
    expect(bumpEpochScalar(0)).toBe(1);
    expect(bumpEpochScalar(41)).toBe(42);
    // 32 位最大正整数 0x7fffffff 溢出安全回绕至 -2147483648
    expect(bumpEpochScalar(0x7fffffff)).toBe(-2147483648);
    expect(bumpEpochScalar(-2147483648)).toBe(-2147483647);
    expect(bumpEpochScalar(-1)).toBe(0);

    // 验证选择器双模调用与边界防御
    const state = useSessionStore.getState();
    expect(selectSessionMetaEpoch(state, null)).toBe(0);
    expect(selectSessionMetaEpoch(null)(state)).toBe(0);
    expect(selectSessionMessageEpoch(state, undefined)).toBe(0);
    expect(selectSessionMessageEpoch(undefined)(state)).toBe(0);
    expect(selectSessionOrder(state)).toEqual([]);
    expect(selectHydrationComplete(state)).toBe(true);
  });

  it('ASSERT-01-05: performThreeWaySubtreeMerge 集合论无损合并内存新增会话、重叠流式会话、磁盘历史会话并拦截墓碑会话', () => {
    const localNewMeta = extractSessionMeta(
      makeSession('local-new', '内存新建会话')
    );
    const sharedLocalMeta = extractSessionMeta({
      ...makeSession('shared-1', '用户手动改名'),
      titleSource: 'user',
      timestamp: '2026-10-13T02:00:00.000Z',
    });

    const localInput = {
      metaById: {
        'local-new': localNewMeta,
        'shared-1': sharedLocalMeta,
      },
      messagesBySessionId: {
        'local-new': [makeMessage('m-local-1', 'local draft msg')],
        'shared-1': [
          makeMessage('m-shared-1', 'updated in memory'),
          makeMessage('m-shared-2', 'streaming chunk'),
        ],
      },
      agentsBySessionId: {
        'local-new': EMPTY_AGENTS,
        'shared-1': EMPTY_AGENTS,
      },
      sessionOrder: ['local-new', 'shared-1'],
    };

    const diskSessions: SessionState[] = [
      {
        ...makeSession('shared-1', '旧磁盘标题', [
          makeMessage('m-shared-0', 'older disk msg'),
          makeMessage('m-shared-1', 'stale disk copy'),
        ]),
        timestamp: '2026-10-13T01:00:00.000Z',
        engineCursor: 88,
        engineLastRunId: 'run-88',
      },
      makeSession('disk-history-1', '磁盘历史会话', [
        makeMessage('m-disk-1', 'from sqlite'),
      ]),
      makeSession('disk-tombstoned', '已删除墓碑会话', [
        makeMessage('m-dead', 'should not revive'),
      ]),
    ];

    const tombstones = new Set(['disk-tombstoned']);
    const merged = performThreeWaySubtreeMerge(localInput, diskSessions, (id) =>
      tombstones.has(id)
    );

    // 1. 顺序保序且墓碑会话被彻底物理拦截
    expect(merged.sessionOrder).toEqual([
      'local-new',
      'shared-1',
      'disk-history-1',
    ]);
    expect(merged.metaById['disk-tombstoned']).toBeUndefined();
    expect(merged.restoredFromDiskCount).toBe(1);

    // 2. 重叠会话消息按 ID 去重保序合并，内存最新文本优先于磁盘旧副本
    const sharedMsgs = merged.messagesBySessionId['shared-1']!;
    expect(sharedMsgs.map((m) => m.id)).toEqual([
      'm-shared-0',
      'm-shared-1',
      'm-shared-2',
    ]);
    expect(sharedMsgs[1]?.text).toBe('updated in memory');

    // 3. 重叠会话元数据保留用户手动命名与最新时间戳，并无损合入磁盘 engineCursor
    expect(merged.metaById['shared-1']?.title).toBe('用户手动改名');
    expect(merged.metaById['shared-1']?.timestamp).toBe(
      '2026-10-13T02:00:00.000Z'
    );
    expect(merged.metaById['shared-1']?.engineCursor).toBe(88);
    expect(merged.metaById['shared-1']?.engineLastRunId).toBe('run-88');
    expect(merged.metaById['shared-1']?.messageCount).toBe(3);

    // 4. 磁盘独有历史会话完整恢复
    expect(merged.metaById['disk-history-1']?.title).toBe('磁盘历史会话');
    expect(merged.messagesBySessionId['disk-history-1']).toHaveLength(1);
  });

  it('ASSERT-01-06: SessionPersistenceCoordinator 三道物理写屏障与 CAS 世代号单飞锁验证', async () => {
    vi.useFakeTimers();
    expect(STORAGE_PERSIST_DEBOUNCE_MS).toBe(300);

    const asyncWrites: SotaPersistPayload[] = [];
    const syncWrites: SotaPersistPayload[] = [];
    let resolveInFlight: (() => void) | null = null;

    const coordinator = new SessionPersistenceCoordinator({
      asyncWriter: (payload) => {
        asyncWrites.push(payload);
        return new Promise<void>((resolve) => {
          resolveInFlight = resolve;
        });
      },
      syncWriter: (payload) => {
        syncWrites.push(payload);
      },
    });

    let mockState: PersistCoordinatorState = {
      metaById: {},
      sessionOrder: [],
      activeSessionId: '',
      folderOrder: ['默认项目'],
      hydrationComplete: false,
    };
    const storeLike = { getState: () => mockState };

    // 屏障 1: hydrationComplete === false 期间绝对阻断防抖写盘与同步写盘
    coordinator.schedulePersist(storeLike);
    coordinator.flushPersistenceSync(storeLike);
    vi.advanceTimersByTime(500);
    expect(asyncWrites).toHaveLength(0);
    expect(syncWrites).toHaveLength(0);

    // 开启水合并写入首个有效会话
    const meta1 = extractSessionMeta(makeSession('s1', '会话1'));
    mockState = {
      metaById: { s1: meta1 },
      sessionOrder: ['s1'],
      activeSessionId: 's1',
      folderOrder: ['默认项目'],
      hydrationComplete: true,
    };

    // 连续高频触发 5 次 schedulePersist，300ms 防抖合并为 1 次 IO
    for (let i = 0; i < 5; i++) coordinator.schedulePersist(storeLike);
    expect(asyncWrites).toHaveLength(0);

    vi.advanceTimersByTime(300);
    expect(asyncWrites).toHaveLength(1);
    expect(coordinator.getGenerationSnapshot().isPersisting).toBe(true);

    // 在首次异步写盘尚未完成 (in-flight) 期间产生新状态变更：验证 CAS 世代号尾随重排
    const meta2 = extractSessionMeta(makeSession('s2', '会话2'));
    mockState = {
      ...mockState,
      metaById: { s1: meta1, s2: meta2 },
      sessionOrder: ['s1', 's2'],
    };
    coordinator.schedulePersist(storeLike);
    vi.advanceTimersByTime(300);
    // 单飞锁生效：前序写盘未完成前不并发重入
    expect(asyncWrites).toHaveLength(1);

    // 完成首次写盘后，自动触发尾随世代补写
    resolveInFlight?.();
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(300);
    expect(asyncWrites).toHaveLength(2);
    expect(asyncWrites[1]?.sessionOrder).toEqual(['s1', 's2']);
    resolveInFlight?.();
    await Promise.resolve();

    // 屏障 2: 已确立非空基线后，异常空状态被刚性熔断，绝不覆写磁盘
    mockState = {
      ...mockState,
      metaById: {},
      sessionOrder: [],
    };
    coordinator.schedulePersist(storeLike);
    vi.advanceTimersByTime(300);
    coordinator.flushPersistenceSync(storeLike);
    expect(asyncWrites).toHaveLength(2);
    expect(syncWrites).toHaveLength(0);

    // 屏障 3: BeforeUnload 终态同步排空 (flushPersistenceSync)
    mockState = {
      ...mockState,
      metaById: { s1: meta1 },
      sessionOrder: ['s1'],
    };
    coordinator.schedulePersist(storeLike);
    coordinator.flushPersistenceSync(storeLike);
    expect(syncWrites).toHaveLength(1);
    expect(syncWrites[0]?.sessionOrder).toEqual(['s1']);
  });

  it('sessionIndex 纯 ID 顺序重排 (reorderSessionOrderById / reorderSessionOrderByIdList) 与 getSessionMetaById 验证', () => {
    const order = ['s1', 's2', 's3', 's4'];
    expect(reorderSessionOrderById(order, 's3', 0)).toEqual([
      's3',
      's1',
      's2',
      's4',
    ]);
    // 无位移返回原引用
    expect(reorderSessionOrderById(order, 's1', 0)).toBe(order);
    expect(reorderSessionOrderById(order, 'missing', 2)).toBe(order);

    expect(reorderSessionOrderByIdList(order, ['s4', 's2'])).toEqual([
      's4',
      's2',
      's1',
      's3',
    ]);
    expect(reorderSessionOrderByIdList(order, ['s1', 's2', 's3', 's4'])).toBe(
      order
    );

    const s1 = makeSession('s1', 'Meta Lookup');
    useSessionStore.setState((st) => {
      st.sessions = [s1];
      st.sessionsById = { s1 };
    });
    const meta = getSessionMetaById(useSessionStore.getState(), 's1');
    expect(meta?.title).toBe('Meta Lookup');
    expect(selectSessionMeta(useSessionStore.getState(), 's1')).toBe(meta);
    expect(isSessionMetaEqual(meta, s1)).toBe(true);
    expect(EMPTY_MESSAGES).toHaveLength(0);
    expect(EMPTY_AGENTS).toHaveLength(0);
  });
});
