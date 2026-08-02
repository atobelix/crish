/**
 * Activate-time lazy message hydrate（非 demo）。
 * sessionActions.test.ts 全局 isDemoMode=true 会短路本路径，故独立文件。
 */
import { produce } from 'immer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERAL_FOLDER } from '../api/projectStore';
import { createSessionActions, type SessionStoreSlice } from './sessionActions';
import { buildSessionsById } from './sessionIndex';
import { needsEngineMessageHydrate } from './sessionSharedHelpers';
import type { SessionMessage, SessionState } from './types';

const hydrateMock = vi.fn();
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
    activateWorkspaceForSessionFolder: vi.fn(),
    getActiveProjectId: () => GENERAL_FOLDER,
  };
});

vi.mock('../api/sessionEventHydrate', () => ({
  hydrateSessionMessagesFromEngine: (...args: unknown[]) =>
    hydrateMock(...args),
  mergeMessagesById: (
    existing: SessionMessage[],
    incoming: SessionMessage[]
  ) => mergeMock(existing, incoming),
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
  const set = (recipe: (draft: SessionStoreSlice) => void) => {
    state = produce(state, recipe);
  };
  const get = () => state;
  const actions = createSessionActions(set, get);
  return {
    actions,
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
    hydrateMock.mockReset();
    mergeMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
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
      terminalLines: [],
      terminalBySession: {},
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

    // 动态 import + promise
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
    expect(byId!.hydratedFromEngine).toBe(true);
    expect(byId!.engineCursor).toBe(42);
    expect(byId!.engineLastRunId).toBe('run-9');
    // MCP 观测点：activate 后 sessions[].messages 不再全 0
    expect(
      st.sessions.find((s) => s.id === 'engine-sess-1')?.messages.length
    ).toBe(2);

    // 未 activate 的 peer 仍保持 lazy 空壳
    expect(st.sessionsById['engine-sess-2']?.messages).toEqual([]);
    expect(st.sessionsById['engine-sess-2']?.hydratedFromEngine).toBeUndefined();
  });

  it('does not re-fetch when already hydratedFromEngine with empty messages', async () => {
    const sess = emptyRemoteShell({
      id: 'done',
      title: '已水合空对话',
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
      terminalLines: [],
      terminalBySession: {},
      composerDrafts: {},
    });
    // active 指向不存在 → setActive 会 skip unknown；用合法 peer
    // 直接 active 已是 other 不存在，先 seed active as done then switch away
    h.actions.setActiveSessionId('done');
    await Promise.resolve();
    await Promise.resolve();
    expect(hydrateMock).not.toHaveBeenCalled();
  });

  it('does not fetch when local messages already present', async () => {
    const sess: SessionState = {
      id: 'local-full',
      title: '本地已有正文',
      folder: GENERAL_FOLDER,
      isPinned: false,
      isArchived: false,
      timestamp: new Date().toISOString(),
      messages: [
        { id: 'm1', sender: 'user', text: 'local', timestamp: 1 },
      ],
    };
    const h = makeHarness({
      sessions: [sess],
      sessionsById: buildSessionsById([sess]),
      folderOrder: [GENERAL_FOLDER],
      activeSessionId: 'local-full',
      draftFolder: '',
      activeAgentId: null,
      panelAgentId: null,
      terminalLines: [],
      terminalBySession: {},
      composerDrafts: {},
    });
    h.actions.setActiveSessionId('local-full');
    await Promise.resolve();
    await Promise.resolve();
    expect(hydrateMock).not.toHaveBeenCalled();
    expect(h.getState().sessionsById['local-full']?.messages).toHaveLength(1);
  });
});
