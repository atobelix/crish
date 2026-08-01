/**
 * T08.10 写模型定稿测试（PE-08 任务书 / AA-07 P08 P09 P10）：
 *
 * 覆盖验收：
 * 1. 写并发：快速连续 commit（两个 debounce 批次并发）不丢数据、旧批次不覆盖新批次
 * 2. 真相源切换：hydrate SQLite 优先（LS 仅回退）；30 天清理按 SQLite 集合核对
 * 3. 懒壳窗口：剪枝空壳（仅 SQLite 存在）不在清理 keepIds 内也不会被删
 *    （keepIds = 内存 ∪ SQLite）；hydrationComplete 门闩与清理互斥
 * 4. 增量写：未变会话跳过 save_session_body（不再每次 commit 全量重写）
 * 5. 写后校验：保存后读回核对，不一致自动重试
 * 6. P17：legacy LS 清理完成后移除 LS 镜像写（仅 SQLite 单写路径）
 *
 * 用内存假库 mock transport（status: 'ok'），不经真实 Tauri invoke。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTransport: vi.fn(),
}));

vi.mock('../transport', () => ({
  getTransport: mocks.getTransport,
}));

import type { SessionMessage, SessionState } from '../../store/layoutStore';
import {
  DEFAULT_SESSION_FOLDER,
  SESSION_ACTIVE_KEY,
  SESSION_AGENTS_PREFIX,
  SESSION_BODY_PREFIX,
  SESSION_FOLDER_KEY,
  SESSION_INDEX_KEY,
  type SessionIndexEntry,
} from './sessionPersistenceTypes';
import {
  cleanupLegacyLocalStorageSessions,
  runMigrationCleanupIfNeeded,
} from './migrateFromLocalStorage';
import {
  hydrateSessionsFromRust,
  persistAllSessionsRust,
  persistAllSessionsSyncViaLocalStorage,
  resetSessionWriteModelForTests,
  setLegacyLocalStorageCleaned,
} from './sessionRustDb';
import { prepareSessionsForUi } from '../sessionTitle';

// ── 内存假库（模拟 Rust 侧 SQLite 行为） ────────────────────────────────────

interface FakeRow {
  entry: Record<string, unknown>;
  messages: unknown[];
  agents: unknown[];
}

function makeFakeDb(opts?: {
  /** save_session_body / save_session_agents 的模拟磁盘延迟 */
  saveDelayMs?: number;
  /** 仅第一次 list_sessions（probe）延迟——控制并发批次入队顺序 */
  probeDelayMs?: number;
  /** 前 N 次 load_session_body 返回空（模拟写后读回不一致） */
  bodyReadCorruption?: number;
}): { db: { sessions: Map<string, FakeRow>; meta: Map<string, string> }; call: ReturnType<typeof vi.fn> } {
  const saveDelayMs = opts?.saveDelayMs ?? 0;
  let probeDelayMs = opts?.probeDelayMs ?? 0;
  let bodyReadCorruption = opts?.bodyReadCorruption ?? 0;
  const sessions = new Map<string, FakeRow>();
  const meta = new Map<string, string>();

  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const call = vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case 'list_sessions': {
        if (probeDelayMs > 0) {
          // 先清零再等待：只延迟首个调用（并发批次控制入队顺序用）
          const d = probeDelayMs;
          probeDelayMs = 0;
          await delay(d);
        }
        return { status: 'ok' as const, data: [...sessions.values()].map((r) => r.entry) };
      }
      case 'upsert_session_entry': {
        const e = (args.entry ?? {}) as Record<string, unknown>;
        const id = String(e.id);
        const existing = sessions.get(id);
        sessions.set(id, {
          entry: { ...(existing?.entry ?? {}), ...e },
          messages: existing?.messages ?? [],
          agents: existing?.agents ?? [],
        });
        return { status: 'ok' as const, data: undefined };
      }
      case 'save_session_body': {
        if (saveDelayMs > 0) await delay(saveDelayMs);
        const row = sessions.get(String(args.sessionId));
        if (!row) return { status: 'error' as const, error: 'fk_missing_session' };
        const msgs = (args.messages as unknown[]) || [];
        row.messages = msgs.map((m, i) => ({ ...(m as object), seq: i }));
        return { status: 'ok' as const, data: undefined };
      }
      case 'load_session_body': {
        if (bodyReadCorruption > 0) {
          bodyReadCorruption--;
          return { status: 'ok' as const, data: [] };
        }
        return {
          status: 'ok' as const,
          data: sessions.get(String(args.sessionId))?.messages ?? [],
        };
      }
      case 'save_session_agents': {
        if (saveDelayMs > 0) await delay(saveDelayMs);
        const row = sessions.get(String(args.sessionId));
        if (!row) return { status: 'error' as const, error: 'fk_missing_session' };
        row.agents = (args.agents as unknown[]) || [];
        return { status: 'ok' as const, data: undefined };
      }
      case 'load_session_agents': {
        return { status: 'ok' as const, data: sessions.get(String(args.sessionId))?.agents ?? [] };
      }
      case 'set_session_meta': {
        meta.set(String(args.key), String(args.value));
        return { status: 'ok' as const, data: undefined };
      }
      case 'get_session_meta': {
        return { status: 'ok' as const, data: meta.get(String(args.key)) ?? null };
      }
      case 'cleanup_orphan_sessions': {
        const keep = new Set((args.activeIds as string[]) || []);
        let deleted = 0;
        for (const id of [...sessions.keys()]) {
          if (!keep.has(id)) {
            sessions.delete(id);
            deleted++;
          }
        }
        return { status: 'ok' as const, data: deleted };
      }
      default:
        return { status: 'missing' as const, data: undefined };
    }
  });

  return { db: { sessions, meta }, call };
}

// ── 形状 helpers ─────────────────────────────────────────────────────────────

function sessionsToIndex(sessions: SessionState[]): SessionIndexEntry[] {
  return sessions.map((s) => ({
    id: s.id,
    title: s.title,
    folder: s.folder,
    isPinned: s.isPinned,
    isArchived: s.isArchived,
    timestamp: s.timestamp,
    updatedAt: Date.now(),
    messageCount: s.messages?.length ?? 0,
  }));
}

function msg(id: string, sender: 'user' | 'assistant', text?: string): SessionMessage {
  const t = text ?? `text-${id}`;
  return { id, sender, timestamp: 1_700_000_000_000 + t.length, text: t };
}

function sess(
  id: string,
  messages: SessionMessage[],
  partial?: Partial<SessionState>,
): SessionState {
  return {
    id,
    title: 'T',
    folder: DEFAULT_SESSION_FOLDER,
    isPinned: false,
    isArchived: false,
    timestamp: new Date(1_700_000_000_000).toISOString(),
    messages,
    ...partial,
  };
}

function indexEntry(id: string, title = 'T'): SessionIndexEntry {
  return {
    id,
    title,
    folder: DEFAULT_SESSION_FOLDER,
    isPinned: false,
    isArchived: false,
    timestamp: new Date(1_700_000_000_000).toISOString(),
    updatedAt: Date.now(),
    messageCount: 0,
  };
}

function installFakeTransport(call: ReturnType<typeof vi.fn>): void {
  mocks.getTransport.mockReturnValue({ call });
}

beforeEach(() => {
  localStorage.clear();
  resetSessionWriteModelForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('T08.10 写并发：串行队列 + 批次版本戳（P08）', () => {
  it('快速连续 commit：并发两批次不交错、不丢数据，最终 = 最新批次', async () => {
    const { db, call } = makeFakeDb({ saveDelayMs: 20 });
    installFakeTransport(call);

    // 两个 debounce 批次未 await 直接并发（模拟 350ms 窗口内连续 commit）
    const batch1 = sess('s1', [msg('m1', 'user'), msg('m2', 'assistant')]);
    const batch2 = sess('s1', [
      msg('m1', 'user'),
      msg('m2', 'assistant'),
      msg('m3', 'user'),
      msg('m4', 'assistant'),
    ]);
    const p1 = persistAllSessionsRust([batch1], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    const p2 = persistAllSessionsRust([batch2], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    await Promise.all([p1, p2]);

    // 最终 body = 最新批次（batch2 调用更晚 → 批次戳更高），无丢失
    const final = db.sessions.get('s1')?.messages ?? [];
    expect(final).toHaveLength(4);
    expect((final as { id: string }[]).map((m) => m.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ]);
  });

  it('旧批次晚执行（低批次戳）不覆盖新批次（updated_at CAS 哨兵）', async () => {
    const { db, call } = makeFakeDb({ saveDelayMs: 5, probeDelayMs: 40 });
    installFakeTransport(call);

    const oldBatch = sess('s1', [msg('m1', 'user'), msg('m2', 'assistant')]);
    const newBatch = sess('s1', [
      msg('m1', 'user'),
      msg('m2', 'assistant'),
      msg('m3', 'user'),
      msg('m4', 'assistant'),
    ]);

    // p1（旧内容，低批次戳）的 probe 慢 → 其写任务后入队
    const p1 = persistAllSessionsRust([oldBatch], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    await new Promise((r) => setTimeout(r, 10));
    // p2（新内容，高批次戳）先完成 probe 并先写入
    const p2 = persistAllSessionsRust([newBatch], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    await Promise.all([p1, p2]);

    // 旧批次（低戳）晚执行时被跳过 → 只写了一次且内容是新的 4 条
    const saves = call.mock.calls.filter((c) => c[0] === 'save_session_body').length;
    expect(saves).toBe(1);
    const final = db.sessions.get('s1')?.messages ?? [];
    expect((final as { id: string }[]).map((m) => m.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ]);
  });
});

describe('T08.10 真相源切换：SQLite 优先 / LS 回退（P09）', () => {
  it('hydrate：SQLite 有数据 → 以 SQLite 为准（忽略 LS 索引差异）', async () => {
    const { db, call } = makeFakeDb();
    db.sessions.set('sq1', {
      entry: { ...indexEntry('sq1', 'SQLite 会话'), messageCount: 1 },
      messages: [msg('m1', 'user', 'sqlite body')],
      agents: [],
    });
    // LS 索引存在但内容不同（历史镜像）
    localStorage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify([{ ...indexEntry('ls-only', 'LS 会话') }]),
    );
    localStorage.setItem(
      SESSION_BODY_PREFIX + 'ls-only',
      JSON.stringify([msg('m1', 'user', 'ls body')]),
    );
    installFakeTransport(call);

    const res = await hydrateSessionsFromRust();
    expect(res.sessions.map((s) => s.id)).toEqual(['sq1']);
    expect(res.sessions[0]?.messages[0]?.text).toBe('sqlite body');
  });

  it('hydrate：SQLite 为空 → 回退 LS 索引（正文以 SQLite 为准）', async () => {
    const { call } = makeFakeDb();
    localStorage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify([{ ...indexEntry('ls1', 'LS 会话') }]),
    );
    localStorage.setItem(
      SESSION_BODY_PREFIX + 'ls1',
      JSON.stringify([msg('m1', 'user', 'ls body')]),
    );
    installFakeTransport(call);

    const res = await hydrateSessionsFromRust();
    // 索引回退 LS；正文走 load_session_body（invoke 可用 → SQLite 权威，空库返回空）
    expect(res.sessions.map((s) => s.id)).toEqual(['ls1']);
    expect(res.sessions[0]?.messages ?? []).toEqual([]);
  });

  it('30 天清理：仅删 SQLite 已落库会话的 body/agents key；未落库会话与索引保留', async () => {
    const { db, call } = makeFakeDb();
    db.sessions.set('in-sqlite', {
      entry: { ...indexEntry('in-sqlite'), messageCount: 1 },
      messages: [msg('m1', 'user')],
      agents: [],
    });
    // LS 镜像：in-sqlite（已落库）+ ls-only（仅 LS 存在）
    localStorage.setItem(
      SESSION_BODY_PREFIX + 'in-sqlite',
      JSON.stringify([msg('m1', 'user')]),
    );
    localStorage.setItem(SESSION_AGENTS_PREFIX + 'in-sqlite', '[]');
    localStorage.setItem(
      SESSION_BODY_PREFIX + 'ls-only',
      JSON.stringify([msg('m2', 'user')]),
    );
    localStorage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify([
        { ...indexEntry('in-sqlite') },
        { ...indexEntry('ls-only', 'LS-only') },
      ]),
    );
    installFakeTransport(call);

    await cleanupLegacyLocalStorageSessions();

    // 已落库会话的镜像被删；仅 LS 存在的会话保留（防 P01 类会话被永久丢失）
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 'in-sqlite')).toBeNull();
    expect(localStorage.getItem(SESSION_AGENTS_PREFIX + 'in-sqlite')).toBeNull();
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 'ls-only')).not.toBeNull();
    // ls-only 未落库 → 索引 key 不删（索引在全部落库后才删除）
    expect(localStorage.getItem(SESSION_INDEX_KEY)).not.toBeNull();
  });

  it('30 天清理：全部落库后索引 key 删除', async () => {
    const { db, call } = makeFakeDb();
    db.sessions.set('a', { entry: { ...indexEntry('a') }, messages: [], agents: [] });
    db.sessions.set('b', { entry: { ...indexEntry('b') }, messages: [], agents: [] });
    localStorage.setItem(SESSION_BODY_PREFIX + 'a', JSON.stringify([msg('m1', 'user')]));
    localStorage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify([{ ...indexEntry('a') }, { ...indexEntry('b') }]),
    );
    localStorage.setItem(SESSION_ACTIVE_KEY, 'a');
    localStorage.setItem(SESSION_FOLDER_KEY, JSON.stringify(['常规会话']));
    installFakeTransport(call);

    await cleanupLegacyLocalStorageSessions();

    expect(localStorage.getItem(SESSION_INDEX_KEY)).toBeNull();
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 'a')).toBeNull();
  });

  it('P17：legacy 清理完成后 persist 与 beforeunload 均不再写 LS 镜像', async () => {
    const { db, call } = makeFakeDb();
    installFakeTransport(call);

    // 模拟 30 天清理完成（meta 标记 + 内存标记）
    db.meta.set('migration_completed_at', String(Date.now() - 31 * 24 * 60 * 60 * 1000));
    await runMigrationCleanupIfNeeded();
    expect(db.meta.get('legacy_localstorage_cleaned')).toBe('1');

    const s = sess('s1', [msg('m1', 'user')]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], { sessionsToIndex });
    // 仅 SQLite 单写路径：LS 索引 / body 镜像不再写
    expect(localStorage.getItem(SESSION_INDEX_KEY)).toBeNull();
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 's1')).toBeNull();
    // SQLite 侧正常写入
    expect(db.sessions.get('s1')?.messages).toHaveLength(1);

    // beforeunload 同步路径同样跳过
    persistAllSessionsSyncViaLocalStorage([s], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    expect(localStorage.getItem(SESSION_INDEX_KEY)).toBeNull();
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 's1')).toBeNull();
  });

  it('清理未完成时：LS 镜像写保留（兼容过渡期）', async () => {
    const { db, call } = makeFakeDb();
    installFakeTransport(call);
    const s = sess('s1', [msg('m1', 'user')]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], { sessionsToIndex });
    expect(localStorage.getItem(SESSION_INDEX_KEY)).not.toBeNull();
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 's1')).not.toBeNull();
  });
});

describe('T08.10 懒壳窗口与清理互斥（P10）', () => {
  it('剪枝空壳（仅 SQLite 存在）不在清理 keepIds 内也不会被删', async () => {
    const { db, call } = makeFakeDb();
    // SQLite 中有懒壳空壳（正文/索引已落库，内存中已被剪枝）
    db.sessions.set('lazy-shell', {
      entry: { ...indexEntry('lazy-shell', '新会话'), messageCount: 0 },
      messages: [],
      agents: [],
    });
    installFakeTransport(call);

    const s = sess('keep', [msg('m1', 'user')]);
    await persistAllSessionsRust([s], 'keep', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });

    // keepIds = 内存 ∪ SQLite：懒壳空壳不在内存列表，但仍在 SQLite → 不被删除
    expect(db.sessions.has('lazy-shell')).toBe(true);
    expect(db.sessions.has('keep')).toBe(true);
  });

  it('hydrationComplete=false 门闩：不触发任何写与清理（互斥守卫）', async () => {
    const { db, call } = makeFakeDb();
    installFakeTransport(call);
    const s = sess('s1', [msg('m1', 'user')]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
      hydrationComplete: false,
    });
    // 门闩未置位：零 IPC、零清理、零写入
    expect(call).not.toHaveBeenCalled();
    expect(db.sessions.size).toBe(0);
    expect(localStorage.getItem(SESSION_INDEX_KEY)).toBeNull();
  });

  it('近 5 分钟更新的空壳不剪枝（懒壳窗口，与 Rust ORPHAN_GRACE_MS 对齐）', () => {
    const now = Date.now();
    const recent = {
      id: 'recent',
      title: '新会话',
      messages: [] as unknown[],
      updatedAt: now - 60_000,
    };
    const old = {
      id: 'old',
      title: '新会话',
      messages: [] as unknown[],
      updatedAt: now - 10 * 60_000,
    };
    const content = {
      id: 'content',
      title: '真实',
      messages: [{ sender: 'user', text: 'hi' }] as unknown[],
    };
    const next = prepareSessionsForUi([recent, old, content], null);
    expect(next.map((x) => x.id)).toEqual(['recent', 'content']);
  });

  it('无 updatedAt 的空壳保持剪枝（窗口不可判定）；显式窗口可覆盖', () => {
    const ghost = { id: 'ghost', title: '新会话', messages: [] as unknown[] };
    expect(prepareSessionsForUi([ghost], null).map((x) => x.id)).toEqual([]);
    const now = Date.now();
    const a = { id: 'a', title: '新会话', messages: [] as unknown[], updatedAt: now - 60_000 };
    // 窗口调为 0 → 近更新也剪
    expect(prepareSessionsForUi([a], null, { lazyShellGraceMs: 0 }).map((x) => x.id)).toEqual([]);
    // 窗口放大 → 保留
    expect(
      prepareSessionsForUi([a], null, { lazyShellGraceMs: 120_000 }).map((x) => x.id),
    ).toEqual(['a']);
  });
});

describe('T08.10 增量写：仅写脏会话（F7 全量替换语义保留）', () => {
  it('未变会话不重写 body/agents；变更会话才写', async () => {
    const { db, call } = makeFakeDb();
    installFakeTransport(call);

    const s = sess('s1', [msg('m1', 'user'), msg('m2', 'assistant')]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], { sessionsToIndex });
    const saves = () => call.mock.calls.filter((c) => c[0] === 'save_session_body').length;
    expect(saves()).toBe(1);

    // 内容未变 → 增量判定跳过（不再每次 commit 全量重写）
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], { sessionsToIndex });
    expect(saves()).toBe(1);

    // 追加消息 → 增量写
    const s2 = sess('s1', [...s.messages, msg('m3', 'user')]);
    await persistAllSessionsRust([s2], 's1', [DEFAULT_SESSION_FOLDER], { sessionsToIndex });
    expect(saves()).toBe(2);
    expect(db.sessions.get('s1')?.messages).toHaveLength(3);
  });

  it('保存成功后记录签名：内容回退到已持久化形态也不再写', async () => {
    const { db, call } = makeFakeDb();
    installFakeTransport(call);
    const s = sess('s1', [msg('m1', 'user')]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], { sessionsToIndex });
    const saves = () => call.mock.calls.filter((c) => c[0] === 'save_session_body').length;
    expect(saves()).toBe(1);
    // 同一内容再次（含 hydrate 回灌场景）→ 跳过
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], { sessionsToIndex });
    expect(saves()).toBe(1);
  });
});

describe('T08.10 写后校验（可读回）', () => {
  it('读回条数不一致 → 自动重试一次后一致', async () => {
    const { db, call } = makeFakeDb({ bodyReadCorruption: 1 });
    installFakeTransport(call);
    const s = sess('s1', [msg('m1', 'user'), msg('m2', 'assistant')]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], { sessionsToIndex });
    // 首次 save + 读回失败重试 save = 2 次
    const saves = call.mock.calls.filter((c) => c[0] === 'save_session_body').length;
    expect(saves).toBe(2);
    expect(db.sessions.get('s1')?.messages).toHaveLength(2);
  });

  it('读回一致 → 单次保存（无多余重试）', async () => {
    const { call } = makeFakeDb();
    installFakeTransport(call);
    const s = sess('s1', [msg('m1', 'user')]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], { sessionsToIndex });
    const saves = call.mock.calls.filter((c) => c[0] === 'save_session_body').length;
    expect(saves).toBe(1);
  });
});
