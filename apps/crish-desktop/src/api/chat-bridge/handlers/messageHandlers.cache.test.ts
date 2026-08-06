/**
 * messageHandlers 缓存域测试（T-47 → T-48）。
 *
 * - `computeCacheMetricsFromUsage`：message-end 的 metadata.usage /
 *   cacheBreakdown 派生（T-41 shared-utils 未就位时的本地等效纯函数）；
 * - `onMessageEnd` 集成：经 parseBridgeEvent → dispatchEvent 整链，
 *   验证 metadata.usage 不再被丢弃、派生结果写入流状态；
 * - T-48：消息级展示链路——派生结果同步挂到 store 消息
 *   `SessionMessage.cacheMetrics`（badge 数据源，含消息 id 兜底）。
 *
 * null 语义（P5 §3.1 / P6 C15）：无数据 → null / undefined，UI 隐藏而非 0%。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalFlowMachine } from '../../approvalFlowMachine';
import type { StreamCallbacks } from '../../chatApi';
import { parseBridgeEvent } from './eventParser';
import { dispatchEvent } from './dispatch';
import {
  computeCacheMetricsFromUsage,
  type MessageCacheMetrics,
} from './messageHandlers';
import type { HandlerEnv } from './handlerEnv';
import type { StreamState } from './streamState';
import { useLayoutStore } from '../../../store/layoutStore';
import type { SessionMessage, SessionState } from '../../../store/types';

function makeEnv() {
  const state: StreamState = {
    cancelled: false,
    finished: false,
    assistantText: '',
    assistantThought: '',
    unsub: null,
    endTimer: null,
  };
  const callbacks: StreamCallbacks = {
    onThought: vi.fn(),
    onToolStart: vi.fn(),
    onToolSuccess: vi.fn(),
    onToolError: vi.fn(),
    onChunk: vi.fn(),
    onComplete: vi.fn(),
    onRunError: vi.fn(),
    onToolPendingApproval: vi.fn(),
    onTerminalLine: vi.fn(),
    onRunMeta: vi.fn(),
    onApprovalResolved: vi.fn(),
    onSubagentStarted: vi.fn(),
    onSubagentEvent: vi.fn(),
    onSubagentEnded: vi.fn(),
  };
  const approvalFlow = new ApprovalFlowMachine();
  const finish = vi.fn();
  const tryResumeFinish = vi.fn();
  const client = { send: vi.fn() };
  const env: HandlerEnv = {
    state,
    approvalFlow,
    callbacks,
    runId: 'run-test',
    sessionId: 'sess-test',
    finish,
    tryResumeFinish,
    client,
  };
  return { env, state, callbacks, approvalFlow };
}

describe('computeCacheMetricsFromUsage（T-47 本地等效，R6 合并 shared-utils）', () => {
  it('无 metadata / 空对象 → null（未上报隐藏）', () => {
    expect(computeCacheMetricsFromUsage(null)).toBeNull();
    expect(computeCacheMetricsFromUsage(undefined)).toBeNull();
    expect(computeCacheMetricsFromUsage({})).toBeNull();
    expect(computeCacheMetricsFromUsage('str')).toBeNull();
  });

  it('metadata.usage（ProviderUsage camelCase）派生 read/write/miss + hitRate', () => {
    const m: MessageCacheMetrics | null = computeCacheMetricsFromUsage({
      usage: {
        promptTokens: 100,
        cacheReadTokens: 70,
        cacheWriteTokens: 10,
        cacheMissTokens: 20,
      },
    });
    expect(m).toMatchObject({
      cacheReadTokens: 70,
      cacheWriteTokens: 10,
      cacheMissTokens: 20,
      inputTotal: 100,
    });
    expect(m?.hitRate).toBeCloseTo(0.7);
    expect(m?.writeRate).toBeCloseTo(0.1);
  });

  it('cacheBreakdown（Rust C9 派生块 camelCase）优先于 usage', () => {
    const m = computeCacheMetricsFromUsage({
      usage: { promptTokens: 999, cacheReadTokens: 1 },
      cacheBreakdown: { read: 70, write: 10, miss: 20, inputTotal: 180 },
    });
    expect(m?.cacheReadTokens).toBe(70);
    expect(m?.inputTotal).toBe(180);
    expect(m?.hitRate).toBeCloseTo(70 / 180);
    expect(m?.writeRate).toBeCloseTo(10 / 180);
  });

  it('全零 / 非法值 → null（0 与负数都不冒充未上报）', () => {
    expect(
      computeCacheMetricsFromUsage({
        cacheBreakdown: { read: 0, write: 0, miss: 0, inputTotal: 0 },
      })
    ).toBeNull();
    expect(
      computeCacheMetricsFromUsage({
        usage: { cacheReadTokens: -5, cacheWriteTokens: 'x' },
      })
    ).toBeNull();
  });

  it('T-48/C15：usage 显式声明 cache 字段且确为 0 → 非 null「未命中」态（0 与 null 可区分，P6 用例④）', () => {
    const m = computeCacheMetricsFromUsage({
      usage: { promptTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(m).not.toBeNull();
    expect(m?.inputTotal).toBe(100);
    expect(m?.hitRate).toBe(0);
    expect(m?.cacheReadTokens).toBeUndefined();
  });

  it('T-48：Included 形态兜底——未直报 miss 时 inputTotal = promptTokens', () => {
    const m = computeCacheMetricsFromUsage({
      usage: {
        promptTokens: 12000,
        cacheReadTokens: 9000,
        cacheWriteTokens: 500,
        reasoningTokens: 60,
      },
    });
    expect(m?.inputTotal).toBe(12000);
    expect(m?.hitRate).toBeCloseTo(0.75);
  });

  it('T-48：Excluded 形态（prompt < read + write）→ 回退已上报 sum（C9）', () => {
    const m = computeCacheMetricsFromUsage({
      usage: {
        promptTokens: 100,
        cacheReadTokens: 9000,
        cacheWriteTokens: 500,
      },
    });
    expect(m?.inputTotal).toBe(9500);
    expect(m?.hitRate).toBeCloseTo(9000 / 9500);
  });

  it('无 cacheBreakdown 时按 C9 恒等式本地推导 inputTotal / hitRate', () => {
    const m = computeCacheMetricsFromUsage({
      usage: { cacheReadTokens: 40, cacheMissTokens: 60 },
    });
    expect(m?.inputTotal).toBe(100);
    expect(m?.hitRate).toBeCloseTo(0.4);
    expect(m?.cacheWriteTokens).toBeUndefined();
    expect(m?.writeRate).toBeUndefined();
  });
});

describe('onMessageEnd 保留 metadata.usage（T-47 数据流）', () => {
  it('message-end 携带 metadata.usage → state.lastMessageCacheMetrics 写入', () => {
    const { env, state } = makeEnv();
    const parsed = parseBridgeEvent({
      type: 'message-end',
      sessionId: 'sess-test',
      message: {
        role: 'assistant',
        content: 'hi',
        metadata: {
          usage: {
            promptTokens: 100,
            cacheReadTokens: 70,
            cacheWriteTokens: 10,
            cacheMissTokens: 20,
          },
        },
      },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok !== true) throw new Error(parsed.error);
    dispatchEvent(env, parsed.data);
    expect(state.lastMessageCacheMetrics).toMatchObject({
      cacheReadTokens: 70,
      cacheWriteTokens: 10,
      cacheMissTokens: 20,
    });
    expect(state.lastMessageCacheMetrics?.hitRate).toBeCloseTo(0.7);
  });

  it('metadata.cacheBreakdown 形态同样写入流状态', () => {
    const { env, state } = makeEnv();
    const parsed = parseBridgeEvent({
      type: 'message-end',
      sessionId: 'sess-test',
      message: {
        role: 'assistant',
        content: 'hi',
        metadata: {
          usage: { promptTokens: 200, cacheReadTokens: 10 },
          cacheBreakdown: { read: 160, write: 20, miss: 20, inputTotal: 200 },
        },
      },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok !== true) throw new Error(parsed.error);
    dispatchEvent(env, parsed.data);
    expect(state.lastMessageCacheMetrics?.cacheReadTokens).toBe(160);
    expect(state.lastMessageCacheMetrics?.hitRate).toBeCloseTo(0.8);
  });

  it('无 usage → 不写入（undefined 保持，不覆盖上一拍）', () => {
    const { env, state } = makeEnv();
    const parsed = parseBridgeEvent({
      type: 'message-end',
      sessionId: 'sess-test',
      message: { role: 'assistant', content: 'hi' },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok !== true) throw new Error(parsed.error);
    dispatchEvent(env, parsed.data);
    expect(state.lastMessageCacheMetrics).toBeUndefined();
  });

  it('非 assistant 消息（user）→ 不处理缓存域', () => {
    const { env, state } = makeEnv();
    const parsed = parseBridgeEvent({
      type: 'message-end',
      sessionId: 'sess-test',
      message: {
        role: 'user',
        content: 'ping',
        metadata: { usage: { promptTokens: 100, cacheReadTokens: 70 } },
      },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok !== true) throw new Error(parsed.error);
    dispatchEvent(env, parsed.data);
    expect(state.lastMessageCacheMetrics).toBeUndefined();
  });
});

describe('onMessageEnd 消息级展示链路（T-48：事件 → SessionMessage.cacheMetrics）', () => {
  const SESS = 'sess-cache-link';
  const MSG = 'asst-cache-1';

  function seedSession(msgs: SessionMessage[]) {
    const session = {
      id: SESS,
      title: '缓存链路测试',
      folder: '常规会话',
      isPinned: false,
      isArchived: false,
      timestamp: new Date().toISOString(),
      messages: msgs,
    } as unknown as SessionState;
    // sessions[] 为 autoIndex 的 canonical 数组（handler 经其写入）；
    // sessionsById 由中间件重建，测试里同时种子两者避免索引漂移
    useLayoutStore.setState((state) => ({
      sessions: [...state.sessions.filter((s) => s.id !== SESS), session],
      sessionsById: { ...state.sessionsById, [SESS]: session },
    }));
  }

  beforeEach(() => {
    seedSession([
      {
        id: MSG,
        sender: 'assistant',
        text: '',
        status: 'processing',
        timestamp: Date.now(),
        blocks: [],
      },
    ]);
  });

  afterEach(() => {
    useLayoutStore.setState((state) => {
      const next = { ...state.sessionsById };
      delete next[SESS];
      return {
        sessions: state.sessions.filter((s) => s.id !== SESS),
        sessionsById: next,
      };
    });
  });

  function dispatchMessageEndWithUsage(env: HandlerEnv, metadata: unknown) {
    const parsed = parseBridgeEvent({
      type: 'message-end',
      sessionId: SESS,
      message: {
        role: 'assistant',
        content: 'hi',
        metadata,
      },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok !== true) throw new Error(parsed.error);
    dispatchEvent(env, parsed.data);
  }

  it('message-end 携带 usage → SessionMessage.cacheMetrics 写入（badge 数据源）', () => {
    const { env } = makeEnv();
    const env2 = { ...env, sessionId: SESS };
    dispatchMessageEndWithUsage(env2, {
      usage: {
        promptTokens: 12000,
        cacheReadTokens: 9000,
        cacheWriteTokens: 500,
        cacheMissTokens: 2500,
      },
    });
    const msg = useLayoutStore
      .getState()
      .sessionsById[SESS]?.messages.find((m) => m.id === MSG);
    expect(msg?.cacheMetrics?.source).toBe('engine-message-end');
    expect(msg?.cacheMetrics?.metrics?.cacheReadTokens).toBe(9000);
    expect(msg?.cacheMetrics?.metrics?.hitRate).toBeCloseTo(0.75);
    expect(msg?.cacheMetrics?.metrics?.inputTotal).toBe(12000);
  });

  it('message-end 载荷缺消息 id → 兜底最后一条 processing 的 assistant 消息', () => {
    const { env } = makeEnv();
    const env2 = { ...env, sessionId: SESS };
    dispatchMessageEndWithUsage(env2, {
      cacheBreakdown: { read: 70, write: 10, miss: 20, inputTotal: 180 },
    });
    const msg = useLayoutStore
      .getState()
      .sessionsById[SESS]?.messages.find((m) => m.id === MSG);
    expect(msg?.cacheMetrics?.metrics?.cacheReadTokens).toBe(70);
    expect(msg?.cacheMetrics?.metrics?.hitRate).toBeCloseTo(70 / 180);
  });

  it('无 cache 字段 → 不写入 cacheMetrics（null 语义：隐藏而非 0%）', () => {
    const { env } = makeEnv();
    const env2 = { ...env, sessionId: SESS };
    dispatchMessageEndWithUsage(env2, { usage: { promptTokens: 100 } });
    const msg = useLayoutStore
      .getState()
      .sessionsById[SESS]?.messages.find((m) => m.id === MSG);
    expect(msg?.cacheMetrics).toBeUndefined();
  });

  it('会话不存在 / 无可匹配消息 → 静默跳过（不抛错）', () => {
    const { env } = makeEnv();
    const env2 = { ...env, sessionId: 'sess-missing' };
    dispatchMessageEndWithUsage(env2, {
      usage: { cacheReadTokens: 10 },
    });
    expect(
      useLayoutStore.getState().sessionsById['sess-missing']
    ).toBeUndefined();
  });
});
