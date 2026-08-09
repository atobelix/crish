// @vitest-environment jsdom
/**
 * P18（AA-07）：子代理落盘截断修复契约测试。
 *
 * 缺陷复现：SESSION_AGENTS_SAVE_CAP=40 曾是硬上限，第 41 个起的 agent 及其
 * 消息在保存时被静默截断（LS 与 SQLite 两侧一致），无提示无留痕。
 *
 * 修复后契约（方案 C）：
 * 1. SQLite 主路径（save_session_agents invoke）全量保存，不 slice——第 41
 *    起不再丢失（Rust 侧无数量上限）；
 * 2. LS 镜像受配额保护线约束仍截断，但置位截断标志（crish_agents_truncated_<id>，
 *    值 = AgentsTruncationRecord{cap,total,saved,at}），全量写成功时清除；
 * 3. 超过软上限的会话写 session_meta 留痕（agents_over_cap:<id>，saved=total
 *    无丢失），readAgentsOverCapMeta 供数据面提示；
 * 4. hydrate 链读 LS 截断标志 → logInternalError('ls-agents-truncated') 留痕。
 *
 * 防作弊约束：不 mock slice、不绕过分支——经真实 localStorage / 假库 invoke
 * 触发；logInternalError 仅 spy 观测。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand, mockTauriMissing } from '../../test-setup';
import type { SessionAgent, SessionState } from '../../store/layoutStore';
import * as userFacingErrors from '../userFacingErrors';
import {
  DEFAULT_SESSION_FOLDER,
  SESSION_AGENTS_OVER_CAP_META_PREFIX,
  SESSION_AGENTS_PREFIX,
  SESSION_AGENTS_SAVE_CAP,
  SESSION_INDEX_KEY,
} from './sessionPersistenceTypes';
import {
  clearAgentsTruncation,
  hasAgentsTruncation,
  markAgentsTruncated,
  readAgentsTruncation,
} from './sessionAgentsTruncation';
import { saveSessionAgents } from './sessionLocalStorage';
import {
  hydrateSessionsFromRust,
  persistAllSessionsRust,
  readAgentsOverCapMeta,
} from './sessionRustDb';

// ── 形状 helpers ─────────────────────────────────────────────────────────────

/** 构造 n 个子代理（id 从 0 起编号，便于断言第 41 个起的保留/截断）。 */
function makeAgents(n: number): SessionAgent[] {
  const out: SessionAgent[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `ag${i}`,
      subagentRunId: `r${i}`,
      parentSessionId: 's1',
      parentRunId: `pr${i}`,
      description: `d${i}`,
      mode: 'research',
      status: 'completed',
      messages: [],
      startedAt: i,
      depth: 0,
      subagentPath: [`ag${i}`],
    });
  }
  return out;
}

function sess(agents: SessionAgent[]): SessionState {
  return {
    id: 's1',
    title: 'T',
    folder: DEFAULT_SESSION_FOLDER,
    isPinned: false,
    isArchived: false,
    timestamp: '2026-08-06T00:00:00Z',
    messages: [],
    agents,
  };
}

/** LS agents 镜像存储条数（存盘侧断言）。 */
function storedAgentsCount(): number {
  const raw = localStorage.getItem(SESSION_AGENTS_PREFIX + 's1');
  if (!raw) return 0;
  return (JSON.parse(raw) as unknown[]).length;
}

// ── 内存假库（invoke ok 路径；对齐 sessionRustDbTruncationGuard.test.ts 手法） ──

interface FakeRow {
  entry: Record<string, unknown>;
  messages: unknown[];
  agents: unknown[];
}

function makeFakeDb(): {
  db: { sessions: Map<string, FakeRow>; meta: Map<string, string> };
  call: ReturnType<typeof vi.fn>;
} {
  const sessions = new Map<string, FakeRow>();
  const meta = new Map<string, string>();
  const call = vi.fn(
    async (cmd: string, args: Record<string, unknown> = {}) => {
      switch (cmd) {
        case 'list_sessions':
          return {
            status: 'ok' as const,
            data: [...sessions.values()].map((r) => r.entry),
          };
        case 'save_session_agents': {
          const id = String(args.sessionId);
          if (!sessions.has(id)) {
            // 与 Rust save 语义对齐：行不存在自动建行（含可解析的索引 entry，
            // 供 hydrate 的 list_sessions 探针回读）
            sessions.set(id, {
              entry: {
                id,
                title: 'T',
                folder: DEFAULT_SESSION_FOLDER,
                isPinned: false,
                isArchived: false,
                timestamp: '2026-08-06T00:00:00Z',
                updatedAt: 1000,
                messageCount: 0,
              },
              messages: [],
              agents: [],
            });
          }
          sessions.get(id)!.agents = (args.agents as unknown[]) || [];
          return { status: 'ok' as const, data: undefined };
        }
        case 'load_session_agents':
          return {
            status: 'ok' as const,
            data: sessions.get(String(args.sessionId))?.agents ?? [],
          };
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
        case 'cleanup_orphan_sessions':
          return { status: 'ok' as const, data: 0 };
        default:
          return { status: 'missing' as const, data: undefined };
      }
    }
  );
  return { db: { sessions, meta }, call };
}

function installFakeTransport(call: ReturnType<typeof vi.fn>): void {
  for (const cmd of [
    'list_sessions',
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

describe('P18：子代理落盘截断修复（不丢数据 + 留痕 + 提示）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── LS 侧（sessionLocalStorage.saveSessionAgents） ─────────────────────────

  it('1. LS 截断落盘置位标志：45 条存 40 条 + 记录 {cap,total,saved}（先红：当前无标志）', () => {
    saveSessionAgents('s1', makeAgents(SESSION_AGENTS_SAVE_CAP + 5));

    expect(storedAgentsCount()).toBe(SESSION_AGENTS_SAVE_CAP);
    expect(hasAgentsTruncation('s1')).toBe(true);
    const record = readAgentsTruncation('s1');
    expect(record).toEqual({
      cap: SESSION_AGENTS_SAVE_CAP,
      total: SESSION_AGENTS_SAVE_CAP + 5,
      saved: SESSION_AGENTS_SAVE_CAP,
      at: expect.any(Number),
    });
  });

  it('2. 未超上限全量落盘：无标志', () => {
    saveSessionAgents('s1', makeAgents(SESSION_AGENTS_SAVE_CAP));

    expect(storedAgentsCount()).toBe(SESSION_AGENTS_SAVE_CAP);
    expect(hasAgentsTruncation('s1')).toBe(false);
  });

  it('3. 恢复清除：截断置标志后全量写成功 → 标志清除（先红：当前无清除逻辑）', () => {
    saveSessionAgents('s1', makeAgents(SESSION_AGENTS_SAVE_CAP + 5));
    expect(hasAgentsTruncation('s1')).toBe(true);

    // 子代理回落至上限内：全量落盘 + 清除历史标志
    saveSessionAgents('s1', makeAgents(SESSION_AGENTS_SAVE_CAP - 1));

    expect(hasAgentsTruncation('s1')).toBe(false);
    expect(storedAgentsCount()).toBe(SESSION_AGENTS_SAVE_CAP - 1);
  });

  it('4. 空列表清 key + 清标志', () => {
    markAgentsTruncated('s1', {
      cap: SESSION_AGENTS_SAVE_CAP,
      total: 45,
      saved: SESSION_AGENTS_SAVE_CAP,
      at: 1,
    });
    localStorage.setItem(SESSION_AGENTS_PREFIX + 's1', JSON.stringify([]));

    saveSessionAgents('s1', []);

    expect(localStorage.getItem(SESSION_AGENTS_PREFIX + 's1')).toBeNull();
    expect(hasAgentsTruncation('s1')).toBe(false);
  });

  // ── SQLite 主路径（persistAllSessionsRust → save_session_agents invoke） ──

  it('5. SQLite 主路径全量保存：45 条全量送达（不 slice）+ session_meta 留痕 saved=total', async () => {
    const { db, call } = makeFakeDb();
    installFakeTransport(call);

    await persistAllSessionsRust(
      [sess(makeAgents(SESSION_AGENTS_SAVE_CAP + 5))],
      '',
      []
    );

    // 全量 45 条送达 Rust 侧（修复前 slice 到 40 → 断言红）
    const saved = db.sessions.get('s1')!.agents;
    expect(saved).toHaveLength(SESSION_AGENTS_SAVE_CAP + 5);
    expect(saved[44]).toMatchObject({ id: 'ag44', subagentRunId: 'r44' });
    // meta 留痕：超过软上限事实（saved=total，SQLite 全量无丢失）
    const metaKey = SESSION_AGENTS_OVER_CAP_META_PREFIX + 's1';
    const record = await readAgentsOverCapMeta('s1');
    expect(record).toEqual({
      cap: SESSION_AGENTS_SAVE_CAP,
      total: SESSION_AGENTS_SAVE_CAP + 5,
      saved: SESSION_AGENTS_SAVE_CAP + 5,
      at: expect.any(Number),
    });
    expect(db.meta.get(metaKey)).toBeTruthy();
  });

  it('6. 未超上限主路径：不写 agents_over_cap meta', async () => {
    const { db, call } = makeFakeDb();
    installFakeTransport(call);

    await persistAllSessionsRust(
      [sess(makeAgents(SESSION_AGENTS_SAVE_CAP))],
      '',
      []
    );

    expect(db.sessions.get('s1')!.agents).toHaveLength(SESSION_AGENTS_SAVE_CAP);
    expect(
      db.meta.has(SESSION_AGENTS_OVER_CAP_META_PREFIX + 's1')
    ).toBe(false);
    expect(await readAgentsOverCapMeta('s1')).toBeNull();
  });

  // ── 降级路径（invoke 缺失 → LS 回退） ──────────────────────────────────────

  it('7. 降级路径：LS 截断落盘 + 标志置位 + persist-degraded-ls 日志', async () => {
    const logSpy = vi.spyOn(userFacingErrors, 'logInternalError');
    // 不注册任何命令：probe list_sessions → missing → 整批降级 LS

    await persistAllSessionsRust(
      [sess(makeAgents(SESSION_AGENTS_SAVE_CAP + 5))],
      '',
      []
    );

    expect(storedAgentsCount()).toBe(SESSION_AGENTS_SAVE_CAP);
    expect(hasAgentsTruncation('s1')).toBe(true);
    expect(readAgentsTruncation('s1')?.total).toBe(SESSION_AGENTS_SAVE_CAP + 5);
    expect(logSpy).toHaveBeenCalledWith('persist-degraded-ls', expect.anything());
  });

  // ── hydrate 链数据面暴露 ───────────────────────────────────────────────────

  it('8. hydrate 链读截断标志 → ls-agents-truncated 日志留痕', async () => {
    // 历史截断态：LS 镜像 40 条 + 标志（SQLite 假库仅空数据）
    saveSessionAgents('s1', makeAgents(SESSION_AGENTS_SAVE_CAP + 5));
    expect(hasAgentsTruncation('s1')).toBe(true);
    // LS 索引（hydrate 优先 LS 索引真相源）
    localStorage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify([
        {
          id: 's1',
          title: 'T',
          folder: DEFAULT_SESSION_FOLDER,
          isPinned: false,
          isArchived: false,
          timestamp: '2026-08-06T00:00:00Z',
          updatedAt: 1000,
          messageCount: 0,
        },
      ])
    );
    const { db, call } = makeFakeDb();
    installFakeTransport(call);
    // SQLite 侧无该会话数据：load_session_agents 走 missing → hydrate 回退 LS
    // 镜像（40 条截断态），标志如实暴露「LS 镜像截断」事实
    mockTauriMissing('load_session_agents');
    const logSpy = vi.spyOn(userFacingErrors, 'logInternalError');

    const { sessions } = await hydrateSessionsFromRust();

    // 修复前：loadSessionAgents 不读标志、无日志 → logSpy 未调用，用例红
    expect(logSpy).toHaveBeenCalledWith('ls-agents-truncated', {
      sessionId: 's1',
      cap: SESSION_AGENTS_SAVE_CAP,
      total: SESSION_AGENTS_SAVE_CAP + 5,
      saved: SESSION_AGENTS_SAVE_CAP,
    });
    // 数据面暴露：标志可被 UI 层读取
    expect(hasAgentsTruncation('s1')).toBe(true);
    // LS 回退展示 40 条（镜像截断态，标志如实反映）
    expect(sessions[0]?.agents).toHaveLength(SESSION_AGENTS_SAVE_CAP);
    expect(db.sessions.size).toBe(0);
  });

  it('9. 标志不存在时 hydrate 链无 ls-agents-truncated 日志（不误报）', async () => {
    const { call } = makeFakeDb();
    installFakeTransport(call);
    const logSpy = vi.spyOn(userFacingErrors, 'logInternalError');

    await persistAllSessionsRust([sess(makeAgents(3))], '', []);
    const { sessions } = await hydrateSessionsFromRust();

    expect(sessions[0]?.agents).toHaveLength(3);
    expect(logSpy).not.toHaveBeenCalledWith(
      'ls-agents-truncated',
      expect.anything()
    );
  });

  it('10. clearAgentsTruncation 幂等（无标志时调用不抛）', () => {
    expect(() => clearAgentsTruncation('s1')).not.toThrow();
    expect(hasAgentsTruncation('s1')).toBe(false);
  });
});
