/**
 * Activate-time lazy message hydrate（非 demo）。
 * sessionActions.test.ts 全局 isDemoMode=true 会短路本路径，故独立文件。
 *
 * 覆盖维度（Wave 1 · Task W1-D）：
 * 1. Phase 1 SQLite 命中时直接恢复消息与 agents，不再触发远程事件冲刷；
 * 2. Phase 1 SQLite 为空时自动回退 Phase 2 引擎水合，且真实空会话水合一次后收敛不死循环；
 * 3. C1 死锁修复：A -> B -> A 高频切换复用 inFlight Promise，不自增 token、不卡死。
 */
import { produce } from 'immer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERAL_FOLDER } from '../api/projectStore';
import {
  __resetSessionHydrateStateForTests,
  getSessionHydrateToken,
  isSessionHydrationInFlight,
  shouldSkipSessionHydrate,
  triggerSessionMessageHydrateIfNeeded,
} from './sessionActivateHydrate';
import {
  createSessionActions,
  type SessionImmerSet,
  type SessionStoreGet,
  type SessionStoreSlice,
} from './sessionActions';
import { buildSessionsById } from './sessionIndex';
import { needsEngineMessageHydrate } from './sessionSharedHelpers';
import type { SessionAgent, SessionMessage, SessionState } from './types';

const ensureBodyMock = vi.fn<
  (sessionId: string) => Promise<{
    messages: SessionMessage[];
    agents: SessionAgent[];
  }>
>();
const saveBodyMock = vi
  .fn<
    (
      sessionId: string,
      messages: SessionMessage[],
      batchVersion?: number | null
    ) => Promise<void>
  >()
  .mockResolvedValue(undefined);
const hydrateMock = vi.fn();
const activateWorkspaceMock = vi.hoisted(() => vi.fn());
const mergeMock = vi.fn(
  (existing: SessionMessage[], incoming: SessionMessage[]) => [
    ...existing,
    ...incoming,
  ]
);

vi.mock('../api/appMode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/appMode')>();
  return {
    ...actual,
    isDemoMode: () => false,
  };
});

vi.mock('../api/projectStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/projectStore')>();
  return {
    ...actual,
    activateWorkspaceForSessionFolder: activateWorkspaceMock,
    getActiveProjectId: () => GENERAL_FOLDER,
  };
});

vi.mock(
  '../api/session-persistence/sessionRustDbHydrate',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../api/session-persistence/sessionRustDbHydrate')
      >();
    return {
      ...actual,
      ensureSessionBodyHydrated: (sessionId: string) =>
        ensureBodyMock(sessionId),
    };
  }
);

vi.mock(
  '../api/session-persistence/sessionRustDbSql',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../api/session-persistence/sessionRustDbSql')
      >();
    return {
      ...actual,
      saveSessionBody: (
        sessionId: string,
        messages: SessionMessage[],
        batchVersion?: number | null
      ) => saveBodyMock(sessionId, messages, batchVersion),
    };
  }
);

vi.mock('../api/sessionEventHydrate', () => ({
  hydrateSessionMessagesFromEngine: (...args: unknown[]) =>
    hydrateMock(...args),
  mergeMessagesById: (existing: SessionMessage[], incoming: SessionMessage[]) =>
    mergeMock(existing, incoming),
}));

function emptyRemoteShell(
  partial: Partial<SessionState> & { id: string; title: string }
): SessionState {
  return {
    folder: GENERAL_FOLDER,
    isPinned: false,
    isArchived: false,
    timestamp: new Date().toISOString(),
    messages: [],
    ...partial,
  };
}

function makeHarness(initial: SessionStoreSlice) {
  let state = initial;
  const set: SessionImmerSet = (recipe) => {
    state = produce(state, recipe);
  };
  const get: SessionStoreGet = () => state;
  const actions = createSessionActions(set, get);
  return {
    actions,
    set,
    get,
    getState: () => state,
  };
}

describe('needsEngineMessageHydrate', () => {
  it('true only when empty messages and not yet hydrated', () => {
    expect(needsEngineMessageHydrate(null)).toBe(false);
    expect(
      needsEngineMessageHydrate({ messages: [], hydratedFromEngine: false })
    ).toBe(true);
    expect(needsEngineMessageHydrate({ messages: [] })).toBe(true);
    expect(
      needsEngineMessageHydrate({
        messages: [{ id: 'm1', sender: 'user', text: 'hi', timestamp: 1 }],
      })
    ).toBe(false);
    expect(
      needsEngineMessageHydrate({
        messages: [],
        hydratedFromEngine: true,
      })
    ).toBe(false);
  });
});

describe('setActiveSessionId — lazy engine message hydrate', () => {
  beforeEach(() => {
    __resetSessionHydrateStateForTests();
    ensureBodyMock.mockReset();
    ensureBodyMock.mockResolvedValue({ messages: [], agents: [] });
    saveBodyMock.mockReset();
    saveBodyMock.mockResolvedValue(undefined);
    hydrateMock.mockReset();
    mergeMock.mockClear();
  });

  afterEach(() => {
    __resetSessionHydrateStateForTests();
    vi.clearAllMocks();
  });

  it('reserves workspace authorization before synchronously switching the active session', () => {
    const current = emptyRemoteShell({
      id: 'current-session',
      title: 'current',
      hydratedFromEngine: true,
      messagesHydrated: true,
    });
    const target = emptyRemoteShell({
      id: 'target-session',
      title: 'target',
      folder: 'proj-target',
      hydratedFromEngine: true,
      messagesHydrated: true,
    });
    const h = makeHarness({
      sessions: [current, target],
      sessionsById: buildSessionsById([current, target]),
      folderOrder: [GENERAL_FOLDER, 'proj-target'],
      activeSessionId: current.id,
      draftFolder: '',
      activeAgentId: null,
      panelAgentId: null,
      composerDrafts: {},
    });
    let activeIdAtReservation = '';
    activateWorkspaceMock.mockImplementationOnce(() => {
      activeIdAtReservation = h.getState().activeSessionId;
      return Promise.resolve();
    });

    h.actions.setActiveSessionId(target.id);

    expect(activateWorkspaceMock).toHaveBeenCalledWith(target.folder);
    expect(activeIdAtReservation).toBe(current.id);
    expect(h.getState().activeSessionId).toBe(target.id);
  });

  it('reserves the fallback workspace before atomically deleting the active session', () => {
    const left = emptyRemoteShell({
      id: 'left-session',
      title: 'left',
      folder: 'proj-left',
      hydratedFromEngine: true,
      messagesHydrated: true,
    });
    const current = emptyRemoteShell({
      id: 'current-session',
      title: 'current',
      folder: 'proj-current',
      hydratedFromEngine: true,
      messagesHydrated: true,
    });
    const right = emptyRemoteShell({
      id: 'right-session',
      title: 'right',
      folder: 'proj-right',
      hydratedFromEngine: true,
      messagesHydrated: true,
    });
    const h = makeHarness({
      sessions: [left, current, right],
      sessionsById: buildSessionsById([left, current, right]),
      folderOrder: [GENERAL_FOLDER, 'proj-left', 'proj-current', 'proj-right'],
      activeSessionId: current.id,
      draftFolder: '',
      activeAgentId: null,
      panelAgentId: null,
      composerDrafts: {},
    });
    let activeIdAtReservation = '';
    activateWorkspaceMock.mockImplementationOnce(() => {
      activeIdAtReservation = h.getState().activeSessionId;
      return Promise.resolve();
    });

    expect(h.actions.deleteSession(current.id)).toBe(true);

    expect(activateWorkspaceMock).toHaveBeenCalledWith(right.folder);
    expect(activeIdAtReservation).toBe(current.id);
    expect(h.getState().activeSessionId).toBe(right.id);
  });

  it('does not reserve a workspace when deleting a stale active ID is a no-op', () => {
    const remaining = emptyRemoteShell({
      id: 'remaining-session',
      title: 'remaining',
      folder: 'proj-remaining',
      hydratedFromEngine: true,
      messagesHydrated: true,
    });
    const h = makeHarness({
      sessions: [remaining],
      sessionsById: buildSessionsById([remaining]),
      folderOrder: [GENERAL_FOLDER, 'proj-remaining'],
      activeSessionId: 'stale-active-session',
      draftFolder: '',
      activeAgentId: null,
      panelAgentId: null,
      composerDrafts: {},
    });

    expect(h.actions.deleteSession('stale-active-session')).toBe(false);
    expect(activateWorkspaceMock).not.toHaveBeenCalled();
  });

  it('activate empty remote shell merges daemon messages into sessions[] and sessionsById', async () => {
    const remote = emptyRemoteShell({
      id: 'engine-sess-1',
      title: '从引擎恢复的任务',
    });
    const peer = emptyRemoteShell({
      id: 'engine-sess-2',
      title: '另一个未激活远程壳',
    });
    const h = makeHarness({
      sessions: [remote, peer],
      sessionsById: buildSessionsById([remote, peer]),
      folderOrder: [GENERAL_FOLDER],
      activeSessionId: peer.id,
      draftFolder: '',
      activeAgentId: null,
      panelAgentId: null,
      composerDrafts: {},
    });

    // MCP 观测点：activate 前 titles 在、messages 全空（lazy 预期）
    expect(h.getState().sessions.every((s) => s.messages.length === 0)).toBe(
      true
    );
    expect(h.getState().sessions.map((s) => s.title)).toEqual([
      '从引擎恢复的任务',
      '另一个未激活远程壳',
    ]);

    const daemonMsgs: SessionMessage[] = [
      {
        id: 'msg-user-1',
        sender: 'user',
        text: 'hello from engine',
        timestamp: 100,
      },
      {
        id: 'msg-asst-1',
        sender: 'assistant',
        text: 'hi back',
        timestamp: 101,
      },
    ];
    hydrateMock.mockResolvedValue({
      ok: true,
      messages: daemonMsgs,
      nextAfterSequence: 42,
      hasMore: false,
      lastRunId: 'run-9',
    });

    h.actions.setActiveSessionId('engine-sess-1');

    await vi.waitFor(() => {
      expect(hydrateMock).toHaveBeenCalledWith('engine-sess-1');
    });
    await vi.waitFor(() => {
      const st = h.getState();
      expect(st.sessionsById['engine-sess-1']?.messages.length).toBe(2);
    });

    const st = h.getState();
    const byId = st.sessionsById['engine-sess-1'];
    const inArr = st.sessions.find((s) => s.id === 'engine-sess-1');
    expect(byId).toBeDefined();
    expect(inArr).toBeDefined();
    // 同引用：sessions[] 与 sessionsById 两边都有正文（防 immer map-only fork）
    expect(byId).toBe(inArr);
    expect(inArr!.messages.map((m) => m.id)).toEqual([
      'msg-user-1',
      'msg-asst-1',
    ]);
    expect(byId!.messages.map((m) => m.id)).toEqual([
      'msg-user-1',
      'msg-asst-1',
    ]);
    expect(byId!.messagesHydrated).toBe(true);
    expect(byId!.hydratedFromEngine).toBe(true);
    expect(byId!.engineCursor).toBe(42);
    expect(byId!.engineLastRunId).toBe('run-9');
    // MCP 观测点：activate 后 sessions[].messages 不再全 0
    expect(
      st.sessions.find((s) => s.id === 'engine-sess-1')?.messages.length
    ).toBe(2);

    // 未 activate 的 peer 仍保持 lazy 空壳
    expect(st.sessionsById['engine-sess-2']?.messages).toEqual([]);
    expect(
      st.sessionsById['engine-sess-2']?.hydratedFromEngine
    ).toBeUndefined();
  });

  it('does not re-fetch when already hydratedFromEngine with empty messages', async () => {
    const sess = emptyRemoteShell({
      id: 'done',
      title: '已水合空对话',
      messagesHydrated: true,
      hydratedFromEngine: true,
    });
    const h = makeHarness({
      sessions: [sess],
      sessionsById: buildSessionsById([sess]),
      folderOrder: [GENERAL_FOLDER],
      activeSessionId: 'other',
      draftFolder: '',
      activeAgentId: null,
      panelAgentId: null,
      composerDrafts: {},
    });
    h.actions.setActiveSessionId('done');
    await Promise.resolve();
    await Promise.resolve();
    expect(ensureBodyMock).not.toHaveBeenCalled();
    expect(hydrateMock).not.toHaveBeenCalled();
  });

  it('truncated hydrate（分页超限截断）：会话置 hydrateTruncated=true（诊断标记）', async () => {
    const remote = emptyRemoteShell({
      id: 'engine-sess-trunc',
      title: '截断远程会话',
    });
    const h = makeHarness({
      sessions: [remote],
      sessionsById: buildSessionsById([remote]),
      folderOrder: [GENERAL_FOLDER],
      activeSessionId: remote.id,
      draftFolder: '',
      activeAgentId: null,
      panelAgentId: null,
      composerDrafts: {},
    });

    hydrateMock.mockResolvedValue({
      ok: true,
      messages: [{ id: 'm1', sender: 'user', text: 'partial', timestamp: 100 }],
      nextAfterSequence: 800,
      hasMore: true,
      truncated: true,
    });

    h.actions.setActiveSessionId(remote.id);

    await vi.waitFor(() => {
      expect(
        h.getState().sessionsById['engine-sess-trunc']?.hydrateTruncated
      ).toBe(true);
    });
    expect(h.getState().sessionsById['engine-sess-trunc']?.engineCursor).toBe(
      800
    );
  });

  it('完整 hydrate（分页拉全）：无截断标记 → 既有 hydrateTruncated 标记被清除', async () => {
    const remote = emptyRemoteShell({
      id: 'engine-sess-full',
      title: '完整远程会话',
      hydratedFromEngine: false,
      hydrateTruncated: true,
    });
    const h = makeHarness({
      sessions: [remote],
      sessionsById: buildSessionsById([remote]),
      folderOrder: [GENERAL_FOLDER],
      activeSessionId: remote.id,
      draftFolder: '',
      activeAgentId: null,
      panelAgentId: null,
      composerDrafts: {},
    });

    hydrateMock.mockResolvedValue({
      ok: true,
      messages: [
        { id: 'm1', sender: 'user', text: 'full', timestamp: 100 },
        { id: 'm2', sender: 'assistant', text: 'done', timestamp: 101 },
      ],
      nextAfterSequence: 1000,
      hasMore: false,
    });

    h.actions.setActiveSessionId(remote.id);

    await vi.waitFor(() => {
      expect(
        h.getState().sessionsById['engine-sess-full']?.hydrateTruncated
      ).toBeUndefined();
    });
  });

  it('does not fetch when local messages already present', async () => {
    const sess: SessionState = {
      id: 'local-full',
      title: '本地已有正文',
      folder: GENERAL_FOLDER,
      isPinned: false,
      isArchived: false,
      timestamp: new Date().toISOString(),
      messages: [{ id: 'm1', sender: 'user', text: 'local', timestamp: 1 }],
    };
    const h = makeHarness({
      sessions: [sess],
      sessionsById: buildSessionsById([sess]),
      folderOrder: [GENERAL_FOLDER],
      activeSessionId: 'local-full',
      draftFolder: '',
      activeAgentId: null,
      panelAgentId: null,
      composerDrafts: {},
    });
    h.actions.setActiveSessionId('local-full');
    await Promise.resolve();
    await Promise.resolve();
    expect(ensureBodyMock).not.toHaveBeenCalled();
    expect(hydrateMock).not.toHaveBeenCalled();
    expect(h.getState().sessionsById['local-full']?.messages).toHaveLength(1);
  });

  it('Phase 1 SQLite 命中：直接从本地 SQLite 恢复权威消息与 agents，绝对不再触发远程引擎重放冲刷', async () => {
    const lazyShell = emptyRemoteShell({
      id: 'sqlite-hit-sess',
      title: 'SQLite 懒壳会话',
      messagesHydrated: false,
    });
    const h = makeHarness({
      sessions: [lazyShell],
      sessionsById: buildSessionsById([lazyShell]),
      folderOrder: [GENERAL_FOLDER],
      activeSessionId: lazyShell.id,
      draftFolder: '',
      activeAgentId: null,
      panelAgentId: null,
      composerDrafts: {},
    });

    const sqliteMessages: SessionMessage[] = [
      {
        id: 'user-msg-1',
        sender: 'user',
        text: '来自 SQLite 的用户提问',
        timestamp: 1000,
      },
      {
        id: 'assistant-msg-1',
        sender: 'assistant',
        text: '来自 SQLite 的助手回答',
        timestamp: 1001,
      },
    ];
    const sqliteAgents: SessionAgent[] = [
      {
        id: 'agent-1',
        name: 'Researcher',
        role: 'explorer',
        status: 'completed',
        task: '查阅代码',
      },
    ];
    ensureBodyMock.mockResolvedValue({
      messages: sqliteMessages,
      agents: sqliteAgents,
    });

    await triggerSessionMessageHydrateIfNeeded('sqlite-hit-sess', h.get, h.set);

    expect(ensureBodyMock).toHaveBeenCalledTimes(1);
    expect(ensureBodyMock).toHaveBeenCalledWith('sqlite-hit-sess');
    expect(mergeMock).toHaveBeenCalledTimes(1);
    // 关键断言：Phase 1 命中后绝不调用远程引擎事件重放
    expect(hydrateMock).not.toHaveBeenCalled();

    const hydrated = h.getState().sessionsById['sqlite-hit-sess'];
    expect(hydrated?.messagesHydrated).toBe(true);
    expect(hydrated?.hydratedFromEngine).toBeUndefined();
    expect(hydrated?.messages.map((m) => m.id)).toEqual([
      'user-msg-1',
      'assistant-msg-1',
    ]);
    expect(hydrated?.agents).toEqual(sqliteAgents);

    // 再次激活/触发时命中卫语句，零重复 IO
    await triggerSessionMessageHydrateIfNeeded('sqlite-hit-sess', h.get, h.set);
    expect(ensureBodyMock).toHaveBeenCalledTimes(1);
    expect(hydrateMock).not.toHaveBeenCalled();
  });

  it('Phase 1 SQLite 为空时自动回退 Phase 2 引擎水合，且真实空会话水合后收敛不再重复拉取', async () => {
    const emptySess = emptyRemoteShell({
      id: 'truly-empty-sess',
      title: '真实空会话',
      messagesHydrated: false,
    });
    const h = makeHarness({
      sessions: [emptySess],
      sessionsById: buildSessionsById([emptySess]),
      folderOrder: [GENERAL_FOLDER],
      activeSessionId: emptySess.id,
      draftFolder: '',
      activeAgentId: null,
      panelAgentId: null,
      composerDrafts: {},
    });

    // Phase 1 SQLite 返回空
    ensureBodyMock.mockResolvedValue({ messages: [], agents: [] });
    // Phase 2 引擎也返回空消息（真实空会话）
    hydrateMock.mockResolvedValue({
      ok: true,
      messages: [],
      nextAfterSequence: 0,
      hasMore: false,
    });

    await triggerSessionMessageHydrateIfNeeded(
      'truly-empty-sess',
      h.get,
      h.set
    );

    expect(ensureBodyMock).toHaveBeenCalledTimes(1);
    expect(hydrateMock).toHaveBeenCalledTimes(1);

    const afterFirst = h.getState().sessionsById['truly-empty-sess'];
    expect(afterFirst?.messages).toEqual([]);
    // 关键断言：真实空会话水合完成后同时标记 messagesHydrated=true 与 hydratedFromEngine=true
    expect(afterFirst?.messagesHydrated).toBe(true);
    expect(afterFirst?.hydratedFromEngine).toBe(true);

    // 再次触发同一空会话水合：命中卫语句直接跳过，彻底杜绝死循环重拉
    await triggerSessionMessageHydrateIfNeeded(
      'truly-empty-sess',
      h.get,
      h.set
    );
    expect(ensureBodyMock).toHaveBeenCalledTimes(1);
    expect(hydrateMock).toHaveBeenCalledTimes(1);
  });

  it('C1 死锁修复：A -> B -> A 高频切换复用 inFlight Promise，不自增 token、不误杀在途水合', async () => {
    const sessA = emptyRemoteShell({
      id: 'sess-A',
      title: '会话 A',
      messagesHydrated: false,
    });
    const sessB = emptyRemoteShell({
      id: 'sess-B',
      title: '会话 B',
      messagesHydrated: false,
    });
    const h = makeHarness({
      sessions: [sessA, sessB],
      sessionsById: buildSessionsById([sessA, sessB]),
      folderOrder: [GENERAL_FOLDER],
      activeSessionId: 'sess-A',
      draftFolder: '',
      activeAgentId: null,
      panelAgentId: null,
      composerDrafts: {},
    });

    let resolveA!: (val: {
      messages: SessionMessage[];
      agents: SessionAgent[];
    }) => void;
    const pendingPromiseA = new Promise<{
      messages: SessionMessage[];
      agents: SessionAgent[];
    }>((resolve) => {
      resolveA = resolve;
    });

    ensureBodyMock.mockImplementation((id: string) => {
      if (id === 'sess-A') return pendingPromiseA;
      return Promise.resolve({
        messages: [
          { id: 'b-msg-1', sender: 'user', text: 'B content', timestamp: 200 },
        ],
        agents: [],
      });
    });

    // Step 1: 切入 A，启动 A 的异步水合（飞行中）
    const flightA1 = triggerSessionMessageHydrateIfNeeded(
      'sess-A',
      h.get,
      h.set
    );
    expect(isSessionHydrationInFlight('sess-A')).toBe(true);
    const tokenA1 = getSessionHydrateToken('sess-A');
    expect(tokenA1).toBe(1);

    // Step 2: A 尚未返回时快速切到 B
    const flightB = triggerSessionMessageHydrateIfNeeded(
      'sess-B',
      h.get,
      h.set
    );

    // Step 3: A 仍在飞行中，用户立即从 B 切回 A（A -> B -> A）
    const flightA2 = triggerSessionMessageHydrateIfNeeded(
      'sess-A',
      h.get,
      h.set
    );

    // 关键死锁修复断言：
    // 1. 直接复用同一个 Promise 引用
    expect(flightA2).toBe(flightA1);
    // 2. 复用分支绝对不自增 sess-A 的 token（保持为 1）
    expect(getSessionHydrateToken('sess-A')).toBe(tokenA1);
    // 3. 不会对 sess-A 发起第二次重复的 SQLite IO
    expect(
      ensureBodyMock.mock.calls.filter(([id]) => id === 'sess-A')
    ).toHaveLength(1);

    // Step 4: 释放 A 的慢 SQLite 响应，验证 A 成功落入 Store 而未被旧 token 误杀
    resolveA({
      messages: [
        { id: 'a-msg-1', sender: 'user', text: 'A question', timestamp: 100 },
        {
          id: 'a-msg-2',
          sender: 'assistant',
          text: 'A answer',
          timestamp: 101,
        },
      ],
      agents: [],
    });

    await Promise.all([flightA1, flightA2, flightB]);

    expect(isSessionHydrationInFlight('sess-A')).toBe(false);
    const hydratedA = h.getState().sessionsById['sess-A'];
    expect(hydratedA?.messagesHydrated).toBe(true);
    expect(hydratedA?.messages.map((m) => m.id)).toEqual([
      'a-msg-1',
      'a-msg-2',
    ]);

    const hydratedB = h.getState().sessionsById['sess-B'];
    expect(hydratedB?.messagesHydrated).toBe(true);
    expect(hydratedB?.messages.map((m) => m.id)).toEqual(['b-msg-1']);
  });

  it('Phase 2 成功从 events 表恢复出消息时，自动调用 saveSessionBody 写回 SQLite 实现点击即永久自愈', async () => {
    const remote = emptyRemoteShell({
      id: 'auto-heal-sess',
      title: '待自愈历史会话',
      messagesHydrated: false,
      hydratedFromEngine: true, // 曾被旧 bug 擦空 session_messages 但保留了 hydratedFromEngine=1
    });
    const h = makeHarness({
      sessions: [remote],
      sessionsById: buildSessionsById([remote]),
      folderOrder: [GENERAL_FOLDER],
      activeSessionId: remote.id,
      draftFolder: '',
      activeAgentId: null,
      panelAgentId: null,
      composerDrafts: {},
    });

    // Phase 1 SQLite 返回空（被旧 bug 擦空）
    ensureBodyMock.mockResolvedValue({ messages: [], agents: [] });
    // Phase 2 引擎事件表完整保留对话载荷
    const recoveredMsgs: SessionMessage[] = [
      { id: 'm-recover-1', sender: 'user', text: '历史提问', timestamp: 100 },
      {
        id: 'm-recover-2',
        sender: 'assistant',
        text: '历史回答',
        timestamp: 101,
      },
    ];
    hydrateMock.mockResolvedValue({
      ok: true,
      messages: recoveredMsgs,
      nextAfterSequence: 10,
      hasMore: false,
    });

    await triggerSessionMessageHydrateIfNeeded('auto-heal-sess', h.get, h.set);

    // 关键断言 1：即使 hydratedFromEngine === true，仍然无条件触发 Phase 2 从 events 恢复
    expect(hydrateMock).toHaveBeenCalledWith('auto-heal-sess');
    // 关键断言 2：恢复出消息后立即调用 saveSessionBody 将消息写回 SQLite session_messages 永久自愈
    expect(saveBodyMock).toHaveBeenCalledWith(
      'auto-heal-sess',
      recoveredMsgs,
      null
    );

    const healed = h.getState().sessionsById['auto-heal-sess'];
    expect(healed?.messages).toHaveLength(2);
    expect(healed?.messagesHydrated).toBe(true);
    expect(healed?.hydratedFromEngine).toBe(true);
  });

  it('Phase 1 IPC 抛错失败且引擎未恢复消息时，不得将 messagesHydrated 置为 true 锁死重试', async () => {
    const remote = emptyRemoteShell({
      id: 'err-sess',
      title: 'IPC 报错会话',
      messagesHydrated: false,
    });
    const h = makeHarness({
      sessions: [remote],
      sessionsById: buildSessionsById([remote]),
      folderOrder: [GENERAL_FOLDER],
      activeSessionId: remote.id,
      draftFolder: '',
      activeAgentId: null,
      panelAgentId: null,
      composerDrafts: {},
    });

    // Phase 1 模拟 IPC 报错抛出异常
    ensureBodyMock.mockRejectedValue(new Error('IPC timeout / DB busy'));
    // Phase 2 引擎也返回空
    hydrateMock.mockResolvedValue({
      ok: true,
      messages: [],
      nextAfterSequence: 0,
      hasMore: false,
    });

    await triggerSessionMessageHydrateIfNeeded('err-sess', h.get, h.set);

    const s = h.getState().sessionsById['err-sess'];
    // 关键断言：Phase 1 抛错失败且未恢复出消息时，严禁锁死 messagesHydrated = true
    expect(s?.messagesHydrated).toBe(false);
  });
});

describe('isLazySessionShell（防空壳误判删库硬核守卫）', () => {
  it('只要 messages 非空，恒返回 false', async () => {
    const { isLazySessionShell } =
      await import('../api/session-persistence/sessionRustDbHydrate');
    expect(
      isLazySessionShell({
        id: 's1',
        messages: [{ id: 'm1', sender: 'user', text: 'hi', timestamp: 1 }],
        messagesHydrated: false,
        hydratedFromEngine: false,
      })
    ).toBe(false);

    expect(
      isLazySessionShell({
        id: 's2',
        messages: [{ id: 'm1', sender: 'user', text: 'hi', timestamp: 1 }],
        messagesHydrated: true,
        hydratedFromEngine: true,
      })
    ).toBe(false);
  });

  it('messages 为空且 messagesHydrated === false 时，必须无条件返回 true（判定为未水合懒壳）', async () => {
    const { isLazySessionShell } =
      await import('../api/session-persistence/sessionRustDbHydrate');
    // 关键断言 1：即使 hydratedFromEngine === true，也绝不能误判为 false！
    expect(
      isLazySessionShell({
        id: 's3',
        messages: [],
        messagesHydrated: false,
        hydratedFromEngine: true,
      })
    ).toBe(true);

    // 关键断言 2：即使 session.id === activeSessionId，在水合完成前也绝不能误判为 false！
    expect(
      isLazySessionShell(
        {
          id: 's4',
          messages: [],
          messagesHydrated: false,
          hydratedFromEngine: true,
        },
        's4'
      )
    ).toBe(true);
  });

  it('messages 为空且 messagesHydrated === true 时返回 false（真实空会话正常下发写指令）', async () => {
    const { isLazySessionShell } =
      await import('../api/session-persistence/sessionRustDbHydrate');
    expect(
      isLazySessionShell({
        id: 's5',
        messages: [],
        messagesHydrated: true,
      })
    ).toBe(false);
  });
});

describe('shouldSkipSessionHydrate（防死锁与防漏水合卫语句）', () => {
  it('messages 为空且 messagesHydrated !== true 时，即使 hydratedFromEngine === true 也绝对不跳过', () => {
    expect(
      shouldSkipSessionHydrate({
        id: 's1',
        title: 's1',
        folder: GENERAL_FOLDER,
        isPinned: false,
        isArchived: false,
        timestamp: '2026-01-01',
        messages: [],
        messagesHydrated: false,
        hydratedFromEngine: true,
      })
    ).toBe(false);

    expect(
      shouldSkipSessionHydrate({
        id: 's2',
        title: 's2',
        folder: GENERAL_FOLDER,
        isPinned: false,
        isArchived: false,
        timestamp: '2026-01-01',
        messages: [],
        messagesHydrated: undefined,
        hydratedFromEngine: true,
      })
    ).toBe(false);
  });

  it('仅当 messagesHydrated === true 且已有正文时跳过', () => {
    expect(
      shouldSkipSessionHydrate({
        id: 's3',
        title: 's3',
        folder: GENERAL_FOLDER,
        isPinned: false,
        isArchived: false,
        timestamp: '2026-01-01',
        messages: [{ id: 'm1', sender: 'user', text: 'hi', timestamp: 1 }],
        messagesHydrated: true,
      })
    ).toBe(true);
  });

  it('真实空会话在 messagesHydrated === true && hydratedFromEngine === true 时跳过（防死循环）', () => {
    expect(
      shouldSkipSessionHydrate({
        id: 's4',
        title: 's4',
        folder: GENERAL_FOLDER,
        isPinned: false,
        isArchived: false,
        timestamp: '2026-01-01',
        messages: [],
        messagesHydrated: true,
        hydratedFromEngine: true,
      })
    ).toBe(true);
  });
});
