/**
 * P1-D2（T3.6）persist 熔断红测试。
 *
 * 复现缺陷（R2 §6 回写链）：引擎懒水合单页截断 → hydratedFromEngine=true 封死
 * 重试 → 350ms debounce → save_session_body 先删后插 → 截断正文不可逆覆盖 SQLite。
 *
 * 修复后契约（熔断）：会话处于「hydratedFromEngine=true + hydrateTruncated=true」
 * （未完整）时，任何 persist 周期都跳过 save_session_body（含 LS 镜像与同步路径），
 * 防截断态固化；完整态（无截断标记）正常落盘。
 *
 * 修复前：persistAllSessionsRust 不识别截断标记 → 截断正文照常落库 → 本文件用例红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand } from '../../test-setup';
import type { SessionMessage, SessionState } from '../../store/layoutStore';
import {
  DEFAULT_SESSION_FOLDER,
  SESSION_BODY_PREFIX,
} from './sessionPersistenceTypes';
import {
  persistAllSessionsRust,
  persistAllSessionsSyncViaLocalStorage,
} from './sessionRustDb';
import { invokeResult } from '../tauriInvoke';

// ── 内存假库（对齐 sessionRustDbWriteModel.test.ts 的 makeFakeDb 手法） ──────

interface FakeRow {
  entry: Record<string, unknown>;
  messages: unknown[];
  agents: unknown[];
}

function makeFakeDb(): {
  db: { sessions: Map<string, FakeRow> };
  call: ReturnType<typeof vi.fn>;
} {
  const sessions = new Map<string, FakeRow>();
  const call = vi.fn(
    async (cmd: string, args: Record<string, unknown> = {}) => {
      switch (cmd) {
        case 'list_sessions':
          return {
            status: 'ok' as const,
            data: [...sessions.values()].map((r) => r.entry),
          };
        case 'save_session_body': {
          const id = String(args.sessionId);
          if (!sessions.has(id)) {
            sessions.set(id, { entry: {}, messages: [], agents: [] });
          }
          const row = sessions.get(id)!;
          row.messages = ((args.messages as unknown[]) || []).map((m, i) => ({
            ...(m as object),
            seq: i,
          }));
          return { status: 'ok' as const, data: undefined };
        }
        case 'load_session_body':
          return {
            status: 'ok' as const,
            data: sessions.get(String(args.sessionId))?.messages ?? [],
          };
        case 'save_session_agents':
          return { status: 'ok' as const, data: undefined };
        case 'load_session_agents':
          return { status: 'ok' as const, data: [] };
        case 'set_session_meta':
          return { status: 'ok' as const, data: undefined };
        case 'get_session_meta':
          return { status: 'ok' as const, data: null };
        case 'cleanup_orphan_sessions':
          return { status: 'ok' as const, data: 0 };
        default:
          return { status: 'missing' as const, data: undefined };
      }
    }
  );
  return { db: { sessions }, call };
}

function installFakeTransport(call: ReturnType<typeof vi.fn>): void {
  for (const cmd of [
    'list_sessions',
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

// ── 形状 helpers ─────────────────────────────────────────────────────────────

function msg(id: string): SessionMessage {
  return {
    id,
    sender: 'user',
    timestamp: 1_700_000_000_000,
    text: `text-${id}`,
  };
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

function bodySaveCalls(call: ReturnType<typeof vi.fn>): unknown[][] {
  return call.mock.calls.filter((c) => c[0] === 'save_session_body');
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('P1-D2 persist 熔断：截断态禁止回写 SQLite', () => {
  it('truncated_hydrate_skips_body_persist：hydratedFromEngine + hydrateTruncated → save_session_body 未被调用', async () => {
    const { db, call } = makeFakeDb();
    installFakeTransport(call);
    // 预热 invoke 懒加载（tauriInvoke 冷启动竞态会整体回退 localStorage，与本用例无关）
    await invokeResult('list_sessions');
    call.mockClear();

    const truncated = sess('s1', [msg('m1'), msg('m2')], {
      hydratedFromEngine: true,
      hydrateTruncated: true,
    });

    await persistAllSessionsRust(
      [truncated],
      's1',
      [DEFAULT_SESSION_FOLDER]
    );

    // 修复前：save_session_body 被调用、截断正文落库 → 本断言红
    expect(bodySaveCalls(call)).toHaveLength(0);
    expect(db.sessions.get('s1')).toBeUndefined();
  });

  it('完整态正常落盘：无截断标记 → save_session_body 被调用且正文入库', async () => {
    const { db, call } = makeFakeDb();
    installFakeTransport(call);
    await invokeResult('list_sessions');
    call.mockClear();

    const complete = sess('s1', [msg('m1'), msg('m2')], {
      hydratedFromEngine: true,
      hydrateTruncated: false,
    });

    await persistAllSessionsRust(
      [complete],
      's1',
      [DEFAULT_SESSION_FOLDER]
    );

    expect(bodySaveCalls(call)).toHaveLength(1);
    expect(db.sessions.get('s1')?.messages ?? []).toHaveLength(2);
  });

  it('同步镜像路径（beforeunload）同样熔断：截断态不写 LS body', () => {
    const truncated = sess('s1', [msg('m1'), msg('m2')], {
      hydratedFromEngine: true,
      hydrateTruncated: true,
    });

    persistAllSessionsSyncViaLocalStorage([truncated], 's1', [
      DEFAULT_SESSION_FOLDER,
    ]);

    // 修复前：同步路径照常写 LS 镜像 → 本断言红
    expect(localStorage.getItem(SESSION_BODY_PREFIX + 's1')).toBeNull();
  });

  it('同步镜像路径：完整态正常写 LS body', () => {
    const complete = sess('s1', [msg('m1'), msg('m2')], {
      hydratedFromEngine: true,
      hydrateTruncated: false,
    });

    persistAllSessionsSyncViaLocalStorage([complete], 's1', [
      DEFAULT_SESSION_FOLDER,
    ]);

    expect(localStorage.getItem(SESSION_BODY_PREFIX + 's1')).not.toBeNull();
  });
});
