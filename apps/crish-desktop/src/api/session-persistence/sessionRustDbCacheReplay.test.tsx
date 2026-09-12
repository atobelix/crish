// @vitest-environment jsdom
/**
 * R6-D5：消息级 cacheMetrics 持久化回放面测试（sessionRustDb）。
 *
 * 数据链（回放面）：message-end → computeCacheMetricsFromUsage →
 * SessionMessage.cacheMetrics → save_session_body（usage_json 快照）→
 * load_session_body 回读 → computeCacheMetricsFromUsage 重派生 →
 * SessionMessage.cacheMetrics → CacheMetricsBadge。
 *
 * 契约锚点：
 *   1. 写入面：cacheMetrics 原始计数序列化为 camelCase CacheUsage 形状
 *      JSON（inputTotal 以 Included 权威口径映射为 promptTokens，与
 *      conex-db tests.rs usage_json fixture 同形）；无指标不写 usage 键。
 *   2. 回读面：usage_json → 复用 computeCacheMetricsFromUsage 重派生
 *      （C9 口径唯一真源）；null/坏 JSON/全零 → 不挂载（C15：隐藏而非 0%）。
 *   3. localStorage 只读迁移面（D-F06）：整条消息 JSON 中的 cacheMetrics
 *      读回保留（形状守卫，source 枚举合法才挂载）；loadSessionBody 不再
 *      静默回退 LS 正文，失败仅 errorStore 留痕。
 *   4. 徽标末端：回放派生的 metrics 可直接被 CacheMetricsBadge 消费
 *      （hitRatio 优先、hitRate 兼容别名回退）。
 *
 * 核对结论（R6-D5）：usage_json 列已在 v5 迁移落地（schema.rs/migrate.rs），
 * 但 Rust `SessionMessage` 结构体与 save_session_body 尚未读写该列——
 * 前端按 P5 S4 审计修正的契约（线上键 camelCase `usage`）先行实现写入面，
 * 待 Rust 侧补字段后生效（serde 未知字段静默丢弃，不影响既有路径）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { mockTauriCommand } from '../../test-setup';
import type { SessionMessage, SessionState } from '../../store/layoutStore';
import type { CacheMetrics } from '@crish/shared-types';
import {
  DEFAULT_SESSION_FOLDER,
  SESSION_BODY_PREFIX,
  SESSION_INDEX_KEY,
  type SessionIndexEntry,
} from './sessionPersistenceTypes';
import {
  hydrateSessionsFromRust,
  loadSessionBody,
  persistAllSessionsRust,
} from './sessionRustDb';
import { lsLoadSessionBody } from './sessionRustDbFallback';
import * as userFacingErrors from '../userFacingErrors';
import { computeCacheMetricsFromUsage } from '../chat-bridge/handlers/messageHandlers';
import { CacheMetricsBadge } from '../../components/chat-message-row/CacheMetricsBadge';

// ── 夹具 helpers ─────────────────────────────────────────────────────────────

function cachedAssistantMsg(id: string, metrics: CacheMetrics): SessionMessage {
  return {
    id,
    sender: 'assistant',
    timestamp: 1_700_000_000_000,
    text: `text-${id}`,
    cacheMetrics: { metrics, source: 'engine-message-end' },
  };
}

function sess(id: string, messages: SessionMessage[]): SessionState {
  return {
    id,
    title: '回放会话',
    folder: DEFAULT_SESSION_FOLDER,
    isPinned: false,
    isArchived: false,
    timestamp: new Date(1_700_000_000_000).toISOString(),
    messages,
  };
}

function indexEntry(id: string): SessionIndexEntry {
  return {
    id,
    title: '回放会话',
    folder: DEFAULT_SESSION_FOLDER,
    isPinned: false,
    isArchived: false,
    timestamp: new Date(1_700_000_000_000).toISOString(),
    updatedAt: Date.now(),
    messageCount: 0,
  };
}

/** 内存假库：只注册 R6-D5 回放链需要走的命令（其余默认 missing） */
function installTransport(store: Map<string, unknown[]>): void {
  mockTauriCommand('list_sessions', async () => []);
  mockTauriCommand('save_session_body', async (args) => {
    const { sessionId, messages } = args as {
      sessionId: string;
      messages: unknown[];
    };
    store.set(
      sessionId,
      (messages ?? []).map((m, i) => ({ ...(m as object), seq: i }))
    );
  });
  mockTauriCommand('load_session_body', async (args) => {
    return store.get((args as { sessionId: string }).sessionId) ?? [];
  });
  mockTauriCommand('save_session_agents', async () => undefined);
  mockTauriCommand('load_session_agents', async () => []);
  mockTauriCommand('set_session_meta', async () => undefined);
  mockTauriCommand('get_session_meta', async () => null);
  mockTauriCommand('cleanup_orphan_sessions', async () => 0);
}

function sessionsToIndex(sessions: SessionState[]): SessionIndexEntry[] {
  return sessions.map((s) => indexEntry(s.id));
}

beforeEach(() => {
  localStorage.clear();
});

// ── 写入面：cacheMetrics → usage_json 快照 ───────────────────────────────────

describe('写入面：cacheMetrics → usage_json（R6-D5 快照契约）', () => {
  it('带 cacheMetrics 的 assistant 消息 → 载荷 usage 为 camelCase CacheUsage JSON（inputTotal 映射为 promptTokens）', async () => {
    const store = new Map<string, unknown[]>();
    installTransport(store);
    const s = sess('s1', [
      cachedAssistantMsg('m1', {
        cacheReadTokens: 9000,
        cacheWriteTokens: 500,
        cacheMissTokens: 2500,
        hitRate: 0.75,
        inputTotal: 12000,
      }),
    ]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });

    const saved = store.get('s1')?.[0] as Record<string, unknown> | undefined;
    expect(saved?.usage).toBe(
      '{"cacheReadTokens":9000,"cacheWriteTokens":500,"cacheMissTokens":2500,"promptTokens":12000}'
    );
  });

  it('无 cacheMetrics 的消息 → 载荷不含 usage 键', async () => {
    const store = new Map<string, unknown[]>();
    installTransport(store);
    const s = sess('s1', [
      { id: 'm1', sender: 'assistant', timestamp: 1, text: 'hi' },
      { id: 'm2', sender: 'user', timestamp: 2, text: 'q' },
    ]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });

    const msgs = store.get('s1') ?? [];
    for (const m of msgs) {
      expect((m as Record<string, unknown>).usage).toBeUndefined();
    }
  });

  it('cacheMetrics 为 null（C15 隐藏态）→ 不写 usage 键', async () => {
    const store = new Map<string, unknown[]>();
    installTransport(store);
    const s = sess('s1', [
      {
        id: 'm1',
        sender: 'assistant',
        timestamp: 1,
        text: 'hi',
        cacheMetrics: null,
      },
    ]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });

    const saved = store.get('s1')?.[0] as Record<string, unknown> | undefined;
    expect(saved?.usage).toBeUndefined();
  });
});

// ── 回读面：usage_json → cacheMetrics 派生 ───────────────────────────────────

describe('回读面：usage_json → cacheMetrics（R6-D5 回放链）', () => {
  it('loadSessionBody 回读 usage → cacheMetrics（命中率重派生 + source 溯源）', async () => {
    const store = new Map<string, unknown[]>();
    store.set('s1', [
      {
        id: 'm1',
        sender: 'assistant',
        text: 'hi',
        timestamp: 1,
        usage: '{"promptTokens":12000,"cacheReadTokens":9000}',
      },
      { id: 'm2', sender: 'user', text: 'q', timestamp: 2 },
    ]);
    installTransport(store);

    const msgs = await loadSessionBody('s1');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.cacheMetrics).toEqual({
      metrics: { cacheReadTokens: 9000, hitRate: 0.75, inputTotal: 12000 },
      source: 'engine-message-end',
    });
    expect(msgs[1]?.cacheMetrics).toBeUndefined();
  });

  it('usage 缺失 / 空串 / 坏 JSON / 无 cache 字段 → 不挂载（C15：隐藏而非 0%）', async () => {
    const cases: Array<{ usage: string | null | undefined; id: string }> = [
      { id: 'm-absent', usage: undefined },
      { id: 'm-empty', usage: '' },
      { id: 'm-bad-json', usage: 'not-json' },
      { id: 'm-no-cache', usage: '{"promptTokens":12000}' },
      { id: 'm-zero-cache', usage: '{"cacheReadTokens":0}' },
      { id: 'm-empty-obj', usage: '{}' },
    ];
    const store = new Map<string, unknown[]>();
    store.set(
      's1',
      cases.map((c) => ({
        id: c.id,
        sender: 'assistant',
        text: c.id,
        timestamp: 1,
        ...(c.usage !== undefined ? { usage: c.usage } : {}),
      }))
    );
    installTransport(store);

    const msgs = await loadSessionBody('s1');
    expect(msgs).toHaveLength(cases.length);
    for (const m of msgs) {
      expect(
        m.cacheMetrics,
        `消息 ${m.id} 不应挂载 cacheMetrics`
      ).toBeUndefined();
    }
  });

  it('回读不破坏既有字段（text/thinking/status/blocks 等）', async () => {
    const store = new Map<string, unknown[]>();
    store.set('s1', [
      {
        id: 'm1',
        sender: 'assistant',
        text: 'hi',
        thinking: 'thought',
        status: 'completed',
        timestamp: 1,
        streamTextOffset: 2,
        thinkingTime: 3,
        blocksJson: '[{"type":"text","content":"hi"}]',
        usage: '{"promptTokens":12000,"cacheReadTokens":9000}',
      },
    ]);
    installTransport(store);

    const [m] = await loadSessionBody('s1');
    expect(m?.text).toBe('hi');
    expect(m?.thinking).toBe('thought');
    expect(m?.status).toBe('completed');
    expect(m?.streamTextOffset).toBe(2);
    expect(m?.thinkingTime).toBe(3);
    expect(m?.blocks).toEqual([
      {
        id: 'thought-legacy',
        type: 'thought',
        content: 'thought',
        durationMs: 3000,
        turnIndex: 0,
      },
      { type: 'text', content: 'hi', turnIndex: 0 },
    ]);
    expect(m?.cacheMetrics?.metrics?.hitRate).toBeCloseTo(0.75);
  });
});

// ── 端到端：persist → hydrate 徽标回放 ───────────────────────────────────────

describe('端到端：persist → hydrate 恢复出 cacheMetrics（徽标回放）', () => {
  it('persist（含 cacheMetrics）→ 假库落盘 → hydrateSessionsFromRust 回放完整', async () => {
    const store = new Map<string, unknown[]>();
    installTransport(store);
    localStorage.setItem(SESSION_INDEX_KEY, JSON.stringify([indexEntry('s1')]));
    const s = sess('s1', [
      cachedAssistantMsg('m1', {
        cacheReadTokens: 9000,
        cacheWriteTokens: 500,
        cacheMissTokens: 2500,
        hitRate: 0.75,
        inputTotal: 12000,
      }),
      { id: 'm2', sender: 'user', timestamp: 2, text: 'q' },
    ]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });

    const res = await hydrateSessionsFromRust();
    expect(res.sessions.map((x) => x.id)).toEqual(['s1']);
    const m1 = res.sessions[0]?.messages.find((x) => x.id === 'm1');
    expect(m1?.cacheMetrics?.metrics?.cacheReadTokens).toBe(9000);
    expect(m1?.cacheMetrics?.metrics?.cacheWriteTokens).toBe(500);
    expect(m1?.cacheMetrics?.metrics?.cacheMissTokens).toBe(2500);
    expect(m1?.cacheMetrics?.metrics?.inputTotal).toBe(12000);
    expect(m1?.cacheMetrics?.metrics?.hitRate).toBeCloseTo(0.75);
    expect(m1?.cacheMetrics?.source).toBe('engine-message-end');
    // 无 usage 的消息不挂载
    expect(
      res.sessions[0]?.messages.find((x) => x.id === 'm2')?.cacheMetrics
    ).toBeUndefined();
  });

  it('恢复时 processing 收尾（sanitizeMessagesForHydrate）不丢 cacheMetrics', async () => {
    const store = new Map<string, unknown[]>();
    installTransport(store);
    localStorage.setItem(SESSION_INDEX_KEY, JSON.stringify([indexEntry('s1')]));
    const s = sess('s1', [
      {
        id: 'm1',
        sender: 'assistant',
        timestamp: 1,
        text: 'hi',
        status: 'processing',
        cacheMetrics: {
          metrics: { cacheReadTokens: 9000, hitRate: 0.75, inputTotal: 12000 },
          source: 'engine-message-end',
        },
      },
    ]);
    await persistAllSessionsRust([s], 's1', [DEFAULT_SESSION_FOLDER], {
      sessionsToIndex,
    });

    const res = await hydrateSessionsFromRust();
    const m1 = res.sessions[0]?.messages.find((x) => x.id === 'm1');
    expect(m1?.status).toBe('completed');
    expect(m1?.cacheMetrics?.metrics?.cacheReadTokens).toBe(9000);
    expect(m1?.cacheMetrics?.metrics?.hitRate).toBeCloseTo(0.75);
  });
});

// ── localStorage 只读迁移面：整条消息 JSON 中的 cacheMetrics 保留 ──────────────

describe('lsLoadSessionBody 只读迁移面：cacheMetrics 保留（R6-D5 / D-F06）', () => {
  it('LS JSON 数组路径：cacheMetrics 读回保留（迁移面直读，不经 loadSessionBody）', () => {
    // D-F06 后 loadSessionBody 不再静默回退 LS——cacheMetrics 形状守卫逻辑
    // 仍由 lsLoadSessionBody（30 天清理护栏 / 迁移读取）承载，直测该面。
    localStorage.setItem(
      SESSION_BODY_PREFIX + 's1',
      JSON.stringify([
        {
          id: 'm1',
          sender: 'assistant',
          text: 'hi',
          timestamp: 1,
          cacheMetrics: {
            metrics: {
              cacheReadTokens: 9000,
              hitRate: 0.75,
              inputTotal: 12000,
            },
            source: 'engine-message-end',
          },
        },
        { id: 'm2', sender: 'user', text: 'q', timestamp: 2 },
      ])
    );

    const msgs = lsLoadSessionBody('s1');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.cacheMetrics).toEqual({
      metrics: { cacheReadTokens: 9000, hitRate: 0.75, inputTotal: 12000 },
      source: 'engine-message-end',
    });
    expect(msgs[1]?.cacheMetrics).toBeUndefined();
  });

  it('LS JSONL 路径：cacheMetrics 读回保留', () => {
    const line1 = JSON.stringify({
      id: 'm1',
      sender: 'assistant',
      text: 'hi',
      timestamp: 1,
      cacheMetrics: {
        metrics: { cacheReadTokens: 9000, hitRate: 0.75, inputTotal: 12000 },
        source: 'engine-message-end',
      },
    });
    const line2 = JSON.stringify({
      id: 'm2',
      sender: 'user',
      text: 'q',
      timestamp: 2,
    });
    localStorage.setItem(SESSION_BODY_PREFIX + 's1', `${line1}\n${line2}\n`);

    const msgs = lsLoadSessionBody('s1');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.cacheMetrics?.metrics?.cacheReadTokens).toBe(9000);
    expect(msgs[0]?.cacheMetrics?.source).toBe('engine-message-end');
    expect(msgs[1]?.cacheMetrics).toBeUndefined();
  });

  it('LS 坏 cacheMetrics 形状（metrics 为 null / source 非法）→ 不挂载，消息其余字段正常', () => {
    localStorage.setItem(
      SESSION_BODY_PREFIX + 's1',
      JSON.stringify([
        {
          id: 'm1',
          sender: 'assistant',
          text: 'bad-metrics-null',
          timestamp: 1,
          cacheMetrics: { metrics: null, source: 'engine-message-end' },
        },
        {
          id: 'm2',
          sender: 'assistant',
          text: 'bad-source',
          timestamp: 2,
          cacheMetrics: {
            metrics: { cacheReadTokens: 9000 },
            source: 'unknown-source',
          },
        },
      ])
    );

    const msgs = lsLoadSessionBody('s1');
    expect(msgs[0]?.text).toBe('bad-metrics-null');
    expect(msgs[0]?.cacheMetrics).toBeUndefined();
    expect(msgs[1]?.text).toBe('bad-source');
    expect(msgs[1]?.cacheMetrics).toBeUndefined();
  });

  it('D-F06：invoke missing 时 loadSessionBody 不再回退 LS 正文（返回空 + errorStore 留痕）', async () => {
    // 不安装 transport → invoke missing；历史 LS 键仍在，但正文权威在 SQLite，
    // load 失败仅 errorStore 留痕，不把 LS 当正文源静默回灌。
    localStorage.setItem(
      SESSION_BODY_PREFIX + 's-fallback-cut',
      JSON.stringify([
        { id: 'm1', sender: 'user', text: 'legacy', timestamp: 1 },
      ])
    );
    const logSpy = vi.spyOn(userFacingErrors, 'logInternalError');

    const msgs = await loadSessionBody('s-fallback-cut');
    expect(msgs).toEqual([]);
    expect(logSpy).toHaveBeenCalledWith(
      'persist-degraded-ls',
      expect.objectContaining({
        command: 'load_session_body',
        sessionId: 's-fallback-cut',
      })
    );
    vi.restoreAllMocks();
  });
});

// ── 徽标回放末端：回放派生的 metrics → CacheMetricsBadge ────────────────────

describe('徽标回放末端：usage_json 回放派生 → CacheMetricsBadge', () => {
  it('回放派生的 metrics 渲染命中徽标（hitRate 兼容别名消费）', () => {
    // 与回读路径同一派生纯函数：从 usage_json 内容重派生
    const metrics = computeCacheMetricsFromUsage({
      usage: {
        promptTokens: 12000,
        cacheReadTokens: 9000,
        cacheWriteTokens: 500,
      },
    });
    expect(metrics).not.toBeNull();

    render(<CacheMetricsBadge metrics={metrics} />);
    const badge = screen.getByTestId('cache-metrics-badge');
    expect(badge.textContent).toContain('75%');
    expect(badge.textContent).toContain('9,000');
    expect(badge.textContent).toContain('500');
  });

  it('回放无数据（usage 无 cache 字段 → 派生 null）→ 徽标不渲染（C15）', () => {
    const metrics = computeCacheMetricsFromUsage({
      usage: { promptTokens: 12000 },
    });
    expect(metrics).toBeNull();

    const { container } = render(<CacheMetricsBadge metrics={metrics} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('cache-metrics-badge')).toBeNull();
  });
});
