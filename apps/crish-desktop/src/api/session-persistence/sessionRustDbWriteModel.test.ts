/**
 * sessionRustDb 写路径契约测试（Stream D 当前实现）。
 *
 * 契约变更说明（2026-08）：
 * 1. R6 收尾 34-cleanup-closure.md:181 判定：本文件原为 T08.10 写模型定稿测试
 *    （PE-08 任务书 / AA-07 P08 P09 P10：串行队列 + 批次版本戳 + updated_at CAS +
 *    增量脏签名 + 写后校验 + SQLite 优先真相源 + P17 单写路径），但该写模型自
 *    58ebaa93 起从未实现，随后被 Stream D（d9e5b61e 重构的 sessionRustDb.ts）取代。
 * 2. PS-03 T3.2（D6 写竞态，2026-08-08）契约翻转：删除被错误固化的
 *    「旧批次晚完成覆盖新批次（最后写者胜，无 CAS 哨兵）」断言（原 :278-308），
 *    改为正确契约——并发批次间，后发批次（高版本）结果不被先发但晚完成的批次
 *    （低版本）覆盖；实现为模块级写串行队列（writeChain）+ 批次版本戳 CAS
 *    （R9：单调递增版本号，非时间戳）。本文件断言覆盖：
 *
 * 1. 写并发：并发批次按发起序串行落库（模块级 writeChain），每批次完整全量写；
 *    后发批次最终落库，先发晚完成批次不得回滚（批次版本戳 CAS 兜底）
 * 2. 真相源切换：hydrate 时 LS 索引优先（过渡期契约），正文一律走 SQLite
 *    （LS 正文不再作为正文源）；30 天清理按 LS 会话镜像全量清除（SQLite 唯一真相源）
 * 3. 懒壳：保护窗口由 prepareSessionsForUi（标题/内容/keep）承担；persist 清理按
 *    内存集合（keepIds = 内存），SQLite 孤立空壳会被回收
 * 4. 写路径：每次 commit 全量重写（无增量签名、无写后校验、无 hydration 门闩选项）
 * 5. LS 镜像：过渡期始终保留（供 seedSessions 同步路径与 MCP 观测；P17 单写路径未实施）
 *
 * 用内存假库 mock transport（status: 'ok'），不经真实 Tauri invoke。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand } from '../../test-setup';

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
} from './sessionRustDb';
import { invokeResult } from '../tauriInvoke';
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
  /** 前 N 次 load_session_body 返回空（模拟读回不一致场景） */
  bodyReadCorruption?: number;
}): {
  db: { sessions: Map<string, FakeRow>; meta: Map<string, string> };
  call: ReturnType<typeof vi.fn>;
} {
  const saveDelayMs = opts?.saveDelayMs ?? 0;
  let probeDelayMs = opts?.probeDelayMs ?? 0;
  let bodyReadCorruption = opts?.bodyReadCorruption ?? 0;
  const sessions = new Map<string, FakeRow>();
  const meta = new Map<string, string>();

  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const call = vi.fn(
    async (cmd: string, args: Record<string, unknown> = {}) => {
      switch (cmd) {
        case 'list_sessions': {
          if (probeDelayMs > 0) {
            // 先清零再等待：只延迟首个调用（并发批次控制入队顺序用）
            const d = probeDelayMs;
            probeDelayMs = 0;
            await delay(d);
          }
          return {
            status: 'ok' as const,
            data: [...sessions.values()].map((r) => r.entry),
          };
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
          // Stream D 契约：body/agents 写为「先删后插」幂等写（无前置 upsert 步骤）；
          // 行不存在时自动建行（对齐 Rust 侧 save 语义，非 FK 报错）
          const id = String(args.sessionId);
          if (!sessions.has(id)) {
            sessions.set(id, { entry: {}, messages: [], agents: [] });
          }
          const row = sessions.get(id)!;
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
          // 同上：幂等写，行不存在自动建行
          const id = String(args.sessionId);
          if (!sessions.has(id)) {
            sessions.set(id, { entry: {}, messages: [], agents: [] });
          }
          sessions.get(id)!.agents = (args.agents as unknown[]) || [];
          return { status: 'ok' as const, data: undefined };
        }
        case 'load_session_agents': {
          return {
            status: 'ok' as const,
            data: sessions.get(String(args.sessionId))?.agents ?? [],
          };
        }
        case 'set_session_meta': {
          meta.set(String(args.key), String(args.value));
          return { status: 'ok' as const, data: undefined };
        }
        case 'get_session_meta': {
          return {
            status: 'ok' as const,
            data: meta.get(String(args.key)) ?? null,
          };
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
    }
  );

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

function msg(
  id: string,
  sender: 'user' | 'assistant',
  text?: string
): SessionMessage {
  const t = text ?? `text-${id}`;
  return { id, sender, timestamp: 1_700_000_000_000 + t.length, text: t };
}

function sess(
  id: string,
  messages: SessionMessage[],
  partial?: Partial<SessionState>
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
  // sessionRustDb 的 invoke 走 tauriInvoke（@tauri-apps/api/core invoke），不经 ../transport。
  // 经 test-setup 的 mockTauriCommand 把内存假库注册为各命令的 invoke 实现，
  // 使 SQLite 路径（status: 'ok'）被真实驱动；错误态抛错让 invokeResult 落到 error。
  for (const cmd of [
    'list_sessions',
    'upsert_session_entry',
    'save_session_body',
    'load_session_body',
    'save_session_agents',
    'load_session_agents',
    'set_session_meta',
    'get_session_meta',
    'cleanup_orphan_sessions',
  ]) {
    mockTauriCommand(cmd, async (args: unknown) => {
      const res = await call(cmd, (args ?? {}) as Record<string, unknown>);
      if (res.status === 'error') throw new Error(String(res.error));
      return res.data;
    });
  }
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('写并发：串行队列 + 批次版本戳 CAS，后发批次最终落库（T3.2 D6）', () => {
  it('快速连续 commit：两批次按发起序串行全量落库，最终 = 后发起批次', async () => {
    const { db, call } = makeFakeDb({ saveDelayMs: 20 });
    installFakeTransport(call);

    // 预热 invoke 懒加载（F-A 收尾修复基线失败）：tauriInvoke.getTauriInvoke
    // 冷启动存在竞态——首个并发调用置位 tauriChecked 后 await 动态 import，
    // 同一时刻的第二个调用会读到 cachedInvoke=null 而整体回退 localStorage，
    // 与本用例「并发写」语义无关。预热一次让两个批次真正并发走 SQLite 路径。
    await invokeResult('list_sessions');
    call.mockClear();

    // 两个 debounce 批次未 await 直接并发（模拟 350ms 窗口内连续 commit）
    const batch1 = sess('s1', [msg('m1', 'user'), msg('m2', 'assistant')]);
    const batch2 = sess('s1', [
      msg('m1', 'user'),
      msg('m2', 'assistant'),
      msg('m3', 'user'),
      msg('m4', 'assistant'),
    ]);
    const p1 = persistAllSessionsRust(
      [batch1],
      's1',
      [DEFAULT_SESSION_FOLDER],
      {
        sessionsToIndex,
      }
    );
    const p2 = persistAllSessionsRust(
      [batch2],
      's1',
      [DEFAULT_SESSION_FOLDER],
      {
        sessionsToIndex,
      }
    );
    await Promise.all([p1, p2]);

    // 两批次按发起序串行落库（模块级 writeChain）：p1 完整落库后 p2 才执行，
    // 各批次全量替换语义不变；最终 = 后发起批次（高版本）内容。
    const saves = call.mock.calls.filter(
      (c) => c[0] === 'save_session_body'
    ).length;
    expect(saves).toBe(2);
    // 批次版本戳（R9：单调递增版本号）随 save_session_body 调用路径传递，
    // 发起序 = 版本序。修复前无版本参数 → batchVersion 缺失，本断言红。
    const bodyVersions = call.mock.calls
      .filter((c) => c[0] === 'save_session_body')
      .map((c) => (c[1] as { batchVersion?: number })?.batchVersion ?? -1);
    expect(bodyVersions[0]).toBeLessThan(bodyVersions[1]);
    const final = db.sessions.get('s1')?.messages ?? [];
    expect(final).toHaveLength(4);
    expect((final as { id: string }[]).map((m) => m.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ]);
  });

  it('串行队列：晚完成的旧批次不得覆盖新批次（最终 = 新内容）', async () => {
    const { db, call } = makeFakeDb({ saveDelayMs: 5, probeDelayMs: 40 });
    installFakeTransport(call);

    const oldBatch = sess('s1', [msg('m1', 'user'), msg('m2', 'assistant')]);
    const newBatch = sess('s1', [
      msg('m1', 'user'),
      msg('m2', 'assistant'),
      msg('m3', 'user'),
      msg('m4', 'assistant'),
    ]);

    // p1（旧内容）先发起，probe 慢 → 修复前其写任务晚完成；p2（新内容）后发起
    const p1 = persistAllSessionsRust(
      [oldBatch],
      's1',
      [DEFAULT_SESSION_FOLDER],
      {
        sessionsToIndex,
      }
    );
    await new Promise((r) => setTimeout(r, 10));
    const p2 = persistAllSessionsRust(
      [newBatch],
      's1',
      [DEFAULT_SESSION_FOLDER],
      {
        sessionsToIndex,
      }
    );
    await Promise.all([p1, p2]);

    // 正确契约（PS-03 T3.2 翻转）：并发批次间，后发批次（高版本）结果不被
    // 先发但晚完成的批次（低版本）覆盖；旧批次晚完成时最终落库应为新批次内容。
    // 修复前（无串行队列）：p1 晚完成 → 最终 = ['m1','m2']（旧覆盖新，本用例红）。
    const saves = call.mock.calls.filter(
      (c) => c[0] === 'save_session_body'
    ).length;
    expect(saves).toBe(2);
    // 版本戳随调用路径传递且发起序 = 版本序（修复前 batchVersion 缺失 → 红）
    const bodyVersions = call.mock.calls
      .filter((c) => c[0] === 'save_session_body')
      .map((c) => (c[1] as { batchVersion?: number })?.batchVersion ?? -1);
    expect(bodyVersions[0]).toBeLessThan(bodyVersions[1]);
    const final = db.sessions.get('s1')?.messages ?? [];
    expect((final as { id: string }[]).map((m) => m.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ]);
  });

  it('多批次交错（3 批）：最终 = 最新快照，中间批次不得回滚', async () => {
    const { db, call } = makeFakeDb({ saveDelayMs: 5, probeDelayMs: 80 });
    installFakeTransport(call);

    const b1 = sess('s1', [msg('m1', 'user'), msg('m2', 'assistant')]);
    const b2 = sess('s1', [
      msg('m1', 'user'),
      msg('m2', 'assistant'),
      msg('m3', 'user'),
      msg('m4', 'assistant'),
    ]);
    const b3 = sess('s1', [
      msg('m1', 'user'),
      msg('m2', 'assistant'),
      msg('m3', 'user'),
      msg('m4', 'assistant'),
      msg('m5', 'user'),
      msg('m6', 'assistant'),
    ]);

    // 三批先后发起，每批间隔 10ms；b1 的 probe 最慢（30ms）→ 修复前其写任务
    // 最后完成，把已落库的新内容回滚成最旧快照。
    const p1 = persistAllSessionsRust([b1], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    await new Promise((r) => setTimeout(r, 10));
    const p2 = persistAllSessionsRust([b2], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    await new Promise((r) => setTimeout(r, 10));
    const p3 = persistAllSessionsRust([b3], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    await Promise.all([p1, p2, p3]);

    // 正确契约：中间批次（b1/b2）被后续批次覆盖但不得回滚，最终 = 最新快照（6 条）
    const saves = call.mock.calls.filter(
      (c) => c[0] === 'save_session_body'
    ).length;
    expect(saves).toBe(3);
    // 三批版本严格递增（修复前 batchVersion 缺失 → 红）
    const bodyVersions = call.mock.calls
      .filter((c) => c[0] === 'save_session_body')
      .map((c) => (c[1] as { batchVersion?: number })?.batchVersion ?? -1);
    expect(bodyVersions[0]).toBeLessThan(bodyVersions[1]);
    expect(bodyVersions[1]).toBeLessThan(bodyVersions[2]);
    const final = db.sessions.get('s1')?.messages ?? [];
    expect((final as { id: string }[]).map((m) => m.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
      'm6',
    ]);
  });
});

describe('真相源切换：LS 索引优先 / SQLite 提供正文（过渡期契约）', () => {
  it('hydrate：LS 索引为真相源（忽略 SQLite 索引差异）；正文走 SQLite', async () => {
    const { db, call } = makeFakeDb();
    db.sessions.set('sq1', {
      entry: { ...indexEntry('sq1', 'SQLite 会话'), messageCount: 1 },
      messages: [msg('m1', 'user', 'sqlite body')],
      agents: [],
    });
    // LS 索引存在但内容不同（历史镜像）
    localStorage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify([{ ...indexEntry('ls-only', 'LS 会话') }])
    );
    localStorage.setItem(
      SESSION_BODY_PREFIX + 'ls-only',
      JSON.stringify([msg('m1', 'user', 'ls body')])
    );
    installFakeTransport(call);

    const res = await hydrateSessionsFromRust();
    // 过渡期契约：LS 索引优先（真相源），SQLite 索引差异被忽略
    expect(res.sessions.map((s) => s.id)).toEqual(['ls-only']);
    // 正文一律走 SQLite：ls-only 不在 SQLite → 空正文；LS 正文镜像不再作为正文源
    expect(res.sessions[0]?.messages ?? []).toEqual([]);
  });

  it('hydrate：LS 索引回退路径（正文以 SQLite 为准）', async () => {
    const { call } = makeFakeDb();
    localStorage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify([{ ...indexEntry('ls1', 'LS 会话') }])
    );
    localStorage.setItem(
      SESSION_BODY_PREFIX + 'ls1',
      JSON.stringify([msg('m1', 'user', 'ls body')])
    );
    installFakeTransport(call);

    const res = await hydrateSessionsFromRust();
    // 索引回退 LS；正文走 load_session_body（invoke 可用 → SQLite 权威，空库返回空）
    expect(res.sessions.map((s) => s.id)).toEqual(['ls1']);
    expect(res.sessions[0]?.messages ?? []).toEqual([]);
  });

  it('30 天清理：LS 会话镜像全量清除（SQLite 唯一真相源），SQLite 数据不受影响', async () => {
    const { db, call } = makeFakeDb();
    db.sessions.set('in-sqlite', {
      entry: { ...indexEntry('in-sqlite'), messageCount: 1 },
      messages: [msg('m1', 'user')],
      agents: [],
    });
    // LS 镜像：in-sqlite（已落库）+ ls-only（仅 LS 存在）
    localStorage.setItem(
      SESSION_BODY_PREFIX + 'in-sqlite',
      JSON.stringify([msg('m1', 'user')])
    );
    localStorage.setItem(SESSION_AGENTS_PREFIX + 'in-sqlite', '[]');
    localStorage.setItem(
      SESSION_BODY_PREFIX + 'ls-only',
      JSON.stringify([msg('m2', 'user')])
    );
    localStorage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify([
        { ...indexEntry('in-sqlite') },
        { ...indexEntry('ls-only', 'LS-only') },
      ])
    );
    installFakeTransport(call);

    await cleanupLegacyLocalStorageSessions();

    // Stream D 契约：30 天清理不区分是否已落库，LS 会话镜像全量清除。
    // 安全前提：清理仅在迁移完成（migration_completed_at 置位）满 30 天后触发，
    // 此时 SQLite 已持有全部会话（含原 ls-only），LS 仅回滚保险。
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 'in-sqlite')).toBeNull();
    expect(
      localStorage.getItem(SESSION_AGENTS_PREFIX + 'in-sqlite')
    ).toBeNull();
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 'ls-only')).toBeNull();
    expect(localStorage.getItem(SESSION_INDEX_KEY)).toBeNull();
    // SQLite 真相源不受清理影响
    expect(db.sessions.has('in-sqlite')).toBe(true);
    expect(db.sessions.get('in-sqlite')?.messages).toHaveLength(1);
  });

  it('30 天清理：索引 key 删除（LS 全量清除）', async () => {
    const { db, call } = makeFakeDb();
    db.sessions.set('a', {
      entry: { ...indexEntry('a') },
      messages: [],
      agents: [],
    });
    db.sessions.set('b', {
      entry: { ...indexEntry('b') },
      messages: [],
      agents: [],
    });
    localStorage.setItem(
      SESSION_BODY_PREFIX + 'a',
      JSON.stringify([msg('m1', 'user')])
    );
    localStorage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify([{ ...indexEntry('a') }, { ...indexEntry('b') }])
    );
    localStorage.setItem(SESSION_ACTIVE_KEY, 'a');
    localStorage.setItem(SESSION_FOLDER_KEY, JSON.stringify(['常规会话']));
    installFakeTransport(call);

    await cleanupLegacyLocalStorageSessions();

    expect(localStorage.getItem(SESSION_INDEX_KEY)).toBeNull();
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 'a')).toBeNull();
  });

  it('清理置位后 persist 仍写 LS 镜像（P17 单写路径未实施：镜像供 seedSessions 同步路径与 MCP 观测）', async () => {
    const { db, call } = makeFakeDb();
    installFakeTransport(call);

    // 模拟 30 天清理完成（meta 标记 + 清理置位）
    db.meta.set(
      'migration_completed_at',
      String(Date.now() - 31 * 24 * 60 * 60 * 1000)
    );
    await runMigrationCleanupIfNeeded();
    expect(db.meta.get('legacy_localstorage_cleaned')).toBe('1');

    const s = sess('s1', [msg('m1', 'user')]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    // Stream D 过渡期契约：清理置位后 persist 仍写 LS 索引 / body 镜像
    expect(localStorage.getItem(SESSION_INDEX_KEY)).not.toBeNull();
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 's1')).not.toBeNull();
    // SQLite 侧正常写入
    expect(db.sessions.get('s1')?.messages).toHaveLength(1);

    // beforeunload 同步路径同样保留镜像
    persistAllSessionsSyncViaLocalStorage([s], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    expect(localStorage.getItem(SESSION_INDEX_KEY)).not.toBeNull();
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 's1')).not.toBeNull();
  });

  it('清理未完成时：LS 镜像写保留（兼容过渡期）', async () => {
    const { call } = makeFakeDb();
    installFakeTransport(call);
    const s = sess('s1', [msg('m1', 'user')]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    expect(localStorage.getItem(SESSION_INDEX_KEY)).not.toBeNull();
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 's1')).not.toBeNull();
  });
});

describe('懒壳保护窗口与清理（P10 现状）', () => {
  it('persist 清理按内存集合（keepIds = 内存）：SQLite 孤立空壳被回收', async () => {
    const { db, call } = makeFakeDb();
    // SQLite 中有懒壳空壳（正文/索引已落库，内存中已被 prepareSessionsForUi 剪枝）
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

    // Stream D 契约：keepIds = 内存会话集合；不在内存的 SQLite 孤立空壳由
    // cleanup_orphan_sessions 回收。懒壳保护由 prepareSessionsForUi 的
    // 标题/内容/keep 判定承担（见 sessionTitle.ts），不依赖清理侧 keepIds 并集。
    expect(db.sessions.has('lazy-shell')).toBe(false);
    expect(db.sessions.has('keep')).toBe(true);
  });

  it('无 hydration 门闩选项：persist 直接写（门闩语义在 store 层 hydrationComplete）', async () => {
    const { db, call } = makeFakeDb();
    installFakeTransport(call);
    const s = sess('s1', [msg('m1', 'user')]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    // Stream D 契约：persistAllSessionsRust 无 hydration 门闩选项，调用即写。
    // 互斥守卫由 store 层 hydrationComplete 状态 + waitForStoreHydration 承担
    // （store-persistence.ts），不在写模型内重复实现。
    expect(call).toHaveBeenCalled();
    expect(db.sessions.size).toBe(1);
    expect(localStorage.getItem(SESSION_INDEX_KEY)).not.toBeNull();
  });

  it('空壳剪枝无时间窗口：近 5 分钟更新的空壳同样剪除（keep 仅 active）', () => {
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
    // Stream D 契约：无 ORPHAN_GRACE_MS 时间窗口（Rust 侧孤立清理窗口与
    // 前端剪枝解耦）；默认标题 + 无实质内容的空壳一律剪除。
    expect(next.map((x) => x.id)).toEqual(['content']);
  });

  it('空壳判定不看 updatedAt / 窗口选项：一律按标题与内容剪枝', () => {
    const ghost = { id: 'ghost', title: '新会话', messages: [] as unknown[] };
    expect(prepareSessionsForUi([ghost], null).map((x) => x.id)).toEqual([]);
    const now = Date.now();
    const a = {
      id: 'a',
      title: '新会话',
      messages: [] as unknown[],
      updatedAt: now - 60_000,
    };
    // lazyShellGraceMs 窗口选项不存在于当前契约 → 近更新空壳仍剪除
    expect(
      prepareSessionsForUi([a], null, { lazyShellGraceMs: 0 }).map((x) => x.id)
    ).toEqual([]);
    expect(
      prepareSessionsForUi([a], null, { lazyShellGraceMs: 120_000 }).map(
        (x) => x.id
      )
    ).toEqual([]);
  });
});

describe('写路径：每次 commit 全量重写（F7 全量替换语义）', () => {
  it('重复 commit 全量重写 body/agents（无增量脏签名）', async () => {
    const { db, call } = makeFakeDb();
    installFakeTransport(call);

    const s = sess('s1', [msg('m1', 'user'), msg('m2', 'assistant')]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    const saves = () =>
      call.mock.calls.filter((c) => c[0] === 'save_session_body').length;
    expect(saves()).toBe(1);

    // 内容未变 → Stream D 契约：仍全量重写（无增量签名去重）
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    expect(saves()).toBe(2);

    // 追加消息 → 继续全量重写
    const s2 = sess('s1', [...s.messages, msg('m3', 'user')]);
    await persistAllSessionsRust([s2], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    expect(saves()).toBe(3);
    expect(db.sessions.get('s1')?.messages).toHaveLength(3);
  });

  it('重复 persist 重复写（无持久化签名去重）', async () => {
    const { call } = makeFakeDb();
    installFakeTransport(call);
    const s = sess('s1', [msg('m1', 'user')]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    const saves = () =>
      call.mock.calls.filter((c) => c[0] === 'save_session_body').length;
    expect(saves()).toBe(1);
    // 同一内容再次 commit → Stream D 契约：仍重写
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    expect(saves()).toBe(2);
  });
});

describe('写后一致性（现状：无读回校验）', () => {
  it('无写后校验：单次保存（读回核对/重试未实施）', async () => {
    const { db, call } = makeFakeDb({ bodyReadCorruption: 1 });
    installFakeTransport(call);
    const s = sess('s1', [msg('m1', 'user'), msg('m2', 'assistant')]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    // Stream D 契约：persist 不读回核对，save 仅 1 次
    const saves = call.mock.calls.filter(
      (c) => c[0] === 'save_session_body'
    ).length;
    expect(saves).toBe(1);
    expect(db.sessions.get('s1')?.messages).toHaveLength(2);
  });

  it('写后数据一致（mock 正常落库）', async () => {
    const { call } = makeFakeDb();
    installFakeTransport(call);
    const s = sess('s1', [msg('m1', 'user')]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });
    const saves = call.mock.calls.filter(
      (c) => c[0] === 'save_session_body'
    ).length;
    expect(saves).toBe(1);
  });
});
