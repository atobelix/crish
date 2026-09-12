/**
 * U-PERSIST-A（D4 票 A）负向断言单测。
 *
 * NA-A1 partialize ∩ {sessions, sessionsById} = ∅
 * NA-A2 生产 merge 不回灌 sessions
 * NA-A4 beforeunload 同步路径 lsSaveSessionBody = 0
 * NA-A5 deleteSession 后 composerDrafts 无该 id
 * 旧键迁移：含 sessions 的壳键被剥离；损坏键 removeItem
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_STORE_PERSIST_KEY,
  migrateSessionStoreShellKey,
} from '../api/session-persistence/sessionShellKeyMigration';
import {
  persistAllSessionsSyncViaLocalStorage,
} from '../api/session-persistence/sessionRustDbHydrate';
import { lsSaveSessionBody } from '../api/session-persistence/sessionRustDbFallback';
import {
  DEFAULT_SESSION_FOLDER,
  SESSION_ACTIVE_KEY,
  SESSION_BODY_PREFIX,
} from '../api/session-persistence/sessionPersistenceTypes';
import type { SessionMessage, SessionState } from './layoutStore';
import { createSessionActions } from './sessionActions';

function msg(id: string): SessionMessage {
  return {
    id,
    sender: 'user',
    text: 'hello',
    timestamp: new Date().toISOString(),
  } as SessionMessage;
}

function sess(id: string, messages: SessionMessage[]): SessionState {
  return {
    id,
    title: id,
    folder: DEFAULT_SESSION_FOLDER,
    isPinned: false,
    isArchived: false,
    timestamp: new Date().toISOString(),
    messages,
    messagesHydrated: true,
    hydratedFromEngine: true,
  } as SessionState;
}

describe('U-PERSIST-A · 旧键迁移（sessionShellKeyMigration）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('含 sessions 的壳键被剥离为 meta 壳；sessions 字段消失', () => {
    const big = {
      state: {
        sessions: [sess('s1', [msg('m1'), msg('m2')])],
        folderOrder: ['默认'],
        activeSessionId: 's1',
        composerDrafts: { s1: 'draft' },
      },
      version: 1,
    };
    localStorage.setItem(SESSION_STORE_PERSIST_KEY, JSON.stringify(big));

    migrateSessionStoreShellKey();

    const raw = localStorage.getItem(SESSION_STORE_PERSIST_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { state: Record<string, unknown> };
    expect(parsed.state.sessions).toBeUndefined();
    expect(parsed.state.activeSessionId).toBe('s1');
    expect(parsed.state.folderOrder).toEqual(['默认']);
    expect(parsed.state.composerDrafts).toEqual({ s1: 'draft' });
  });

  it('损坏 JSON → removeItem，不抛', () => {
    localStorage.setItem(SESSION_STORE_PERSIST_KEY, '{not-json');
    expect(() => migrateSessionStoreShellKey()).not.toThrow();
    expect(localStorage.getItem(SESSION_STORE_PERSIST_KEY)).toBeNull();
  });

  it('已无 sessions 字段的壳 → no-op（幂等）', () => {
    const shell = {
      state: { activeSessionId: 'a', folderOrder: [], composerDrafts: {} },
      version: 1,
    };
    localStorage.setItem(SESSION_STORE_PERSIST_KEY, JSON.stringify(shell));
    migrateSessionStoreShellKey();
    const parsed = JSON.parse(
      localStorage.getItem(SESSION_STORE_PERSIST_KEY)!
    ) as { state: Record<string, unknown> };
    expect(parsed.state.activeSessionId).toBe('a');
    expect(parsed.state.sessions).toBeUndefined();
  });
});

describe('U-PERSIST-A · NA-A4 beforeunload meta-only', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persistAllSessionsSyncViaLocalStorage 不写 lsSaveSessionBody', () => {
    const s = sess('s1', [msg('m1')]);
    persistAllSessionsSyncViaLocalStorage([s], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex: (list) =>
        list.map((x) => ({
          id: x.id,
          title: x.title,
          folder: x.folder,
          isPinned: x.isPinned,
          isArchived: x.isArchived,
          timestamp: 0,
          messageCount: x.messages?.length ?? 0,
        })),
    });
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 's1')).toBeNull();
    expect(localStorage.getItem(SESSION_ACTIVE_KEY)).toBe('s1');
  });

  it('已有 LS body 残留时 beforeunload 不覆盖/不删除 body 键（A-3 不触碰 SESSION_BODY_PREFIX）', () => {
    lsSaveSessionBody('s1', [msg('pre')]);
    const s = sess('s1', [msg('m1'), msg('m2')]);
    persistAllSessionsSyncViaLocalStorage([s], 's1', [DEFAULT_SESSION_FOLDER]);
    // 票 A：beforeunload 不再写 body；既有键保持不动（不擦不写）
    const raw = localStorage.getItem(SESSION_BODY_PREFIX + 's1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as SessionMessage[];
    expect(parsed).toHaveLength(1); // 仍是 pre，未被 beforeunload 改写
    expect(parsed[0]?.id).toBe('pre');
  });
});

describe('U-PERSIST-A · NA-A5 deleteSession 清 composerDrafts', () => {
  function makeHarness() {
    // 最小 immer-free set/get 契约：直接用 zustand vanilla create 不引入完整 store
    // 本 harness 复用 createSessionActions 对 state 的写路径
    let state: Record<string, unknown> = {
      sessions: [],
      sessionsById: {},
      folderOrder: [],
      activeSessionId: '',
      draftFolder: '',
      activeAgentId: null,
      panelAgentId: null,
      composerDrafts: {},
      hydrationComplete: false,
    };
    const set = (fn: (s: typeof state) => void) => {
      // 简易 immer 风格：直接突变（与 createSessionActions 契约一致）
      fn(state);
    };
    const get = () => state;
    const actions = createSessionActions(
      set as never,
      get as never
    ) as unknown as Record<string, (...args: unknown[]) => unknown>;
    return {
      get state() {
        return state;
      },
      setState(partial: Record<string, unknown>) {
        state = { ...state, ...partial };
      },
      actions,
    };
  }

  it('成功删除后 composerDrafts 不再含该 id', () => {
    const h = makeHarness();
    // 通过 actions 造一个会话 + draft
    const id = h.actions.createSession!({ title: 'draft-victim' } as never) as string;
    h.actions.setComposerDraft!(id, 'unsent text');
    expect((h.state.composerDrafts as Record<string, string>)[id]).toBe(
      'unsent text'
    );

    const ok = h.actions.deleteSession!(id);
    expect(ok).toBe(true);
    expect(
      (h.state.composerDrafts as Record<string, string>)[id]
    ).toBeUndefined();
  });

  it('删除不存在 id：draft 不误伤', () => {
    const h = makeHarness();
    h.setState({ composerDrafts: { other: 'keep' } });
    expect(h.actions.deleteSession!('ghost')).toBe(false);
    expect((h.state.composerDrafts as Record<string, string>).other).toBe(
      'keep'
    );
  });
});

describe('U-PERSIST-A · 真实 store partialize 探针（NA-A1）', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('useSessionStore setState 后 LS 键 state 不含 sessions/sessionsById', async () => {
    // 动态 import 以触发 ensureSessionStoreShellKeyMigrated
    const { useSessionStore } = await import('./sessionStore');
    useSessionStore.setState({
      activeSessionId: 'probe-1',
      folderOrder: ['默认'],
      sessions: [sess('probe-1', [msg('m1')])],
      sessionsById: { 'probe-1': sess('probe-1', [msg('m1')]) },
    } as never);

    // zustand persist 同步写（测试环境 sync storage）
    const raw = localStorage.getItem(SESSION_STORE_PERSIST_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { state: Record<string, unknown> };
    expect(parsed.state.sessions).toBeUndefined();
    expect(parsed.state.sessionsById).toBeUndefined();
    expect(parsed.state.activeSessionId).toBe('probe-1');
    expect(Object.keys(parsed.state).sort()).toEqual(
      expect.not.arrayContaining(['sessions', 'sessionsById'])
    );
    // 允许的三元组
    for (const k of ['activeSessionId', 'folderOrder', 'composerDrafts']) {
      expect(parsed.state).toHaveProperty(k);
    }
  });

  it('旧键含大 sessions 时 create 前迁移已剥离（启动窗口）', async () => {
    const legacy = {
      state: {
        sessions: [sess('legacy', [msg('m1'), msg('m2')])],
        folderOrder: [],
        activeSessionId: 'legacy',
        composerDrafts: {},
      },
      version: 1,
    };
    localStorage.setItem(
      SESSION_STORE_PERSIST_KEY,
      JSON.stringify(legacy)
    );
    vi.resetModules();
    await import('./sessionStore');
    const raw = localStorage.getItem(SESSION_STORE_PERSIST_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { state: Record<string, unknown> };
      expect(parsed.state.sessions).toBeUndefined();
    }
  });
});
