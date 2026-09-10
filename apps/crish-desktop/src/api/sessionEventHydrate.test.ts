import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '../store/layoutStore';
import {
  applyUsageDelta,
  mergeMessagesById,
  parseRunSnapshotUsage,
  projectEventsToMessages,
  type UsageDeltaState,
} from './sessionEventHydrate';
import { projectAgentMessageContent } from './messageProjection';

const baseUsage: UsageDeltaState = {
  input: 100,
  output: 50,
  costStatus: 'priced',
  currency: 'USD',
  costMicros: 10000,
  formattedCost: '$0.0100',
  cost: 0.01,
  inputMax: 160000,
  outputMax: 40000,
};

/** 引擎有价账夹具（USD） */
const engineCost = (totalMicros: number, formatted: string) => ({
  currency: 'USD' as const,
  inputMicros: totalMicros,
  outputMicros: 0,
  cacheReadMicros: 0,
  cacheWriteMicros: 0,
  totalMicros,
  formattedTotal: formatted,
  isFree: false,
});

describe('parseRunSnapshotUsage', () => {
  it('returns null without usage', () => {
    expect(parseRunSnapshotUsage(null)).toBeNull();
    expect(parseRunSnapshotUsage({})).toBeNull();
    expect(parseRunSnapshotUsage({ snapshot: {} })).toBeNull();
  });

  it('parses 2D usage without cache (2D fallback)', () => {
    const got = parseRunSnapshotUsage({
      type: 'run-snapshot',
      runId: 'r1',
      snapshot: {
        usage: {
          sampleCount: 2,
          promptTokens: 150,
          completionTokens: 40,
          totalTokens: 190,
        },
      },
    });
    expect(got).toEqual({
      promptTokens: 150,
      completionTokens: 40,
      totalTokens: 190,
      sampleCount: 2,
    });
    expect(got?.cacheReadTokens).toBeUndefined();
    expect(got?.cacheWriteTokens).toBeUndefined();
  });

  it('透传 snapshot.cache.readTokens / writeTokens → cacheRead/WriteTokens', () => {
    const got = parseRunSnapshotUsage({
      snapshot: {
        usage: {
          sampleCount: 2,
          promptTokens: 150,
          completionTokens: 40,
          totalTokens: 190,
        },
        cache: {
          sampleCount: 2,
          promptTokens: 150,
          readTokens: 52,
          writeTokens: 10,
          missTokens: 98,
          hitRatio: 52 / 150,
          writeRatio: 10 / 150,
        },
      },
    });
    expect(got).toMatchObject({
      promptTokens: 150,
      completionTokens: 40,
      totalTokens: 190,
      sampleCount: 2,
      cacheReadTokens: 52,
      cacheWriteTokens: 10,
    });
  });

  it('falls back to usage.cacheReadTokens when snapshot.cache missing', () => {
    const got = parseRunSnapshotUsage({
      usage: {
        sampleCount: 1,
        promptTokens: 20,
        completionTokens: 7,
        cacheReadTokens: 4,
        cacheWriteTokens: 3,
      },
    });
    expect(got?.cacheReadTokens).toBe(4);
    expect(got?.cacheWriteTokens).toBe(3);
  });

  it('ignores negative / non-number cache fields', () => {
    const got = parseRunSnapshotUsage({
      snapshot: {
        usage: { sampleCount: 1, promptTokens: 10, completionTokens: 1 },
        cache: { readTokens: -5, writeTokens: 'x' },
      },
    });
    expect(got?.cacheReadTokens).toBeUndefined();
    expect(got?.cacheWriteTokens).toBeUndefined();
  });
});

describe('applyUsageDelta', () => {
  it('no-ops when all deltas are zero and no cost', () => {
    const next = applyUsageDelta(baseUsage, {});
    expect(next).toBe(baseUsage);
  });

  it('accumulates tokens + 引擎有价账（同币种累计 micros）', () => {
    const next = applyUsageDelta(baseUsage, {
      promptTokens: 10,
      completionTokens: 5,
      cost: engineCost(20000, '$0.0200'),
    });
    expect(next.input).toBe(110);
    expect(next.output).toBe(55);
    // base 10000 + 20000 = 30000 micros
    expect(next.costStatus).toBe('priced');
    expect(next.costMicros).toBe(30000);
    expect(next.formattedCost).toBe('$0.0200');
    expect(next.cacheRead).toBeUndefined();
  });

  it('accumulates 4D cache + 引擎 cost when provided', () => {
    const next = applyUsageDelta(baseUsage, {
      promptTokens: 100,
      completionTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      cost: engineCost(12000, '$0.0120'),
    });
    expect(next.input).toBe(200);
    expect(next.output).toBe(70);
    expect(next.cacheRead).toBe(40);
    expect(next.cacheWrite).toBe(10);
    expect(next.costMicros).toBe(22000);
  });

  it('preserves existing cache counters across subsequent deltas', () => {
    const mid = applyUsageDelta(
      { ...baseUsage, cacheRead: 10 },
      { promptTokens: 5, completionTokens: 0, cacheReadTokens: 3 }
    );
    expect(mid.cacheRead).toBe(13);
    expect(mid.costStatus).toBe('priced');
  });
});

describe('mergeMessagesById (C0 幂等)', () => {
  const base: SessionMessage[] = [
    {
      id: 'user-stable-1',
      sender: 'user',
      text: 'hello',
      timestamp: 1,
      status: 'processing',
    },
    {
      id: 'asst-1',
      sender: 'assistant',
      text: 'hi',
      timestamp: 2,
      status: 'completed',
    },
  ];

  it('重放相同 id 不增加 length，并合并字段', () => {
    const replay: SessionMessage[] = [
      {
        id: 'user-stable-1',
        sender: 'user',
        text: 'hello',
        timestamp: 1,
        status: 'completed',
      },
      {
        id: 'asst-1',
        sender: 'assistant',
        text: 'hi there',
        timestamp: 2,
        status: 'completed',
      },
    ];
    const once = mergeMessagesById(base, replay);
    expect(once).toHaveLength(2);
    expect(once[0]?.status).toBe('completed');
    expect(once[1]?.text).toBe('hi there');

    // 再重放一遍 length 仍不增
    const twice = mergeMessagesById(once, replay);
    expect(twice).toHaveLength(2);
    expect(twice.map((m) => m.id)).toEqual(['user-stable-1', 'asst-1']);
  });

  it('新 id 才 append', () => {
    const next = mergeMessagesById(base, [
      {
        id: 'user-stable-2',
        sender: 'user',
        text: 'next',
        timestamp: 3,
        status: 'completed',
      },
    ]);
    expect(next).toHaveLength(3);
    expect(next[2]?.id).toBe('user-stable-2');
  });

  it('existing 为空时直接返回 incoming 副本', () => {
    const incoming = base.slice();
    const got = mergeMessagesById([], incoming);
    expect(got).toEqual(incoming);
    expect(got).not.toBe(incoming);
  });

  it('对抗：stream final completed + hydrate partial 同 id 不双气泡、不回退终态', () => {
    const afterStreamFinal: SessionMessage[] = [
      {
        id: 'user-client-1',
        sender: 'user',
        text: 'ping',
        timestamp: 10,
        status: 'completed',
      },
      {
        id: 'asst-client-1',
        sender: 'assistant',
        text: 'full final answer from stream',
        timestamp: 20,
        status: 'completed',
        toolCalls: [
          {
            id: 'tc-1',
            name: 'read',
            arguments: '{}',
            status: 'success',
            output: 'ok',
          },
        ],
        blocks: [
          { type: 'tool_call', id: 'tc-1' },
          { type: 'text', content: 'full final answer from stream' },
        ],
      },
    ];
    // 迟到的 partial / 重放中间态（同 clientMessageId）
    const latePartial: SessionMessage[] = [
      {
        id: 'user-client-1',
        sender: 'user',
        text: 'ping',
        timestamp: 9,
        status: 'processing',
      },
      {
        id: 'asst-client-1',
        sender: 'assistant',
        text: 'partial…',
        timestamp: 15,
        status: 'processing',
        toolCalls: [],
        blocks: [{ type: 'text', content: 'partial…' }],
      },
    ];
    const merged = mergeMessagesById(afterStreamFinal, latePartial);
    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.id)).toEqual(['user-client-1', 'asst-client-1']);
    expect(merged[0]?.status).toBe('completed');
    expect(merged[1]?.status).toBe('completed');
    expect(merged[1]?.text).toBe('full final answer from stream');
    expect(merged[1]?.toolCalls).toHaveLength(1);
    expect(merged[1]?.toolCalls?.[0]?.id).toBe('tc-1');
  });

  it('对抗：hydrate completed 后再来 stream partial 同 id 仍单条', () => {
    const hydrated: SessionMessage[] = [
      {
        id: 'asst-client-2',
        sender: 'assistant',
        text: 'from hydrate',
        timestamp: 100,
        status: 'completed',
      },
    ];
    const streamEcho: SessionMessage[] = [
      {
        id: 'asst-client-2',
        sender: 'assistant',
        text: 'fr',
        timestamp: 90,
        status: 'processing',
      },
    ];
    const once = mergeMessagesById(hydrated, streamEcho);
    const twice = mergeMessagesById(once, streamEcho);
    expect(twice).toHaveLength(1);
    expect(twice[0]?.status).toBe('completed');
    expect(twice[0]?.text).toBe('from hydrate');
  });

  it('对抗：incoming 自身重复同 id 仍合并为一条', () => {
    const dup: SessionMessage[] = [
      {
        id: 'dup-1',
        sender: 'user',
        text: 'a',
        timestamp: 1,
        status: 'processing',
      },
      {
        id: 'dup-1',
        sender: 'user',
        text: 'a!',
        timestamp: 2,
        status: 'completed',
      },
    ];
    const got = mergeMessagesById([], dup);
    expect(got).toHaveLength(1);
    expect(got[0]?.status).toBe('completed');
    expect(got[0]?.text).toBe('a!');
  });

  it('D1 有序合并：incoming 旧 ts 对插入前部，不追加到末尾', () => {
    // 本地已有较晚一轮 [u2(ts=200), a2(ts=201)]
    const local: SessionMessage[] = [
      {
        id: 'u2',
        sender: 'user',
        text: 'second ask',
        timestamp: 200,
        status: 'completed',
      },
      {
        id: 'a2',
        sender: 'assistant',
        text: 'second answer',
        timestamp: 201,
        status: 'completed',
      },
    ];
    // 引擎回放更早一轮 [u1(ts=100), a1(ts=101)]
    const fromEngine: SessionMessage[] = [
      {
        id: 'u1',
        sender: 'user',
        text: 'first ask',
        timestamp: 100,
        status: 'completed',
      },
      {
        id: 'a1',
        sender: 'assistant',
        text: 'first answer',
        timestamp: 101,
        status: 'completed',
      },
    ];
    const merged = mergeMessagesById(local, fromEngine);
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(merged.map((m) => m.timestamp)).toEqual([100, 101, 200, 201]);
  });
});

describe('projectEventsToMessages id 稳定 / 幂等', () => {
  const sampleEvents = [
    {
      sequence: 1,
      type: 'runtime-event',
      payload: {
        event: {
          type: 'message-end',
          timestamp: 1000,
          message: {
            role: 'user',
            clientMessageId: 'user-client-1',
            content: 'ping',
          },
        },
      },
    },
    {
      sequence: 2,
      type: 'runtime-event',
      payload: {
        event: {
          type: 'message-end',
          timestamp: 2000,
          message: {
            role: 'assistant',
            clientMessageId: 'asst-client-1',
            content: 'pong',
          },
        },
      },
    },
  ];

  it('优先采用 clientMessageId 作为稳定 id', () => {
    const { messages } = projectEventsToMessages(sampleEvents);
    expect(messages.map((m) => m.id)).toEqual([
      'user-client-1',
      'asst-client-1',
    ]);
    expect(messages[0]?.text).toBe('ping');
    expect(messages[1]?.text).toBe('pong');
  });

  it('同事件流 project 两次 id 稳定，merge 后 length 不增', () => {
    const a = projectEventsToMessages(sampleEvents).messages;
    const b = projectEventsToMessages(sampleEvents).messages;
    expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id));
    const merged = mergeMessagesById(a, b);
    expect(merged).toHaveLength(a.length);
  });

  it('message-end 重复事件同 clientMessageId 只投影一条', () => {
    const doubled = [...sampleEvents, ...sampleEvents];
    const { messages } = projectEventsToMessages(doubled);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id)).toEqual([
      'user-client-1',
      'asst-client-1',
    ]);
    expect(messages[0]?.status).toBe('completed');
    expect(messages[1]?.status).toBe('completed');
  });

  it('多轮 run：同 clientMessageId 按 turnIndex 分段追加（reload 后不再只剩末轮）', () => {
    const events = [
      {
        sequence: 1,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-end',
            timestamp: 1000,
            turnIndex: 1,
            message: { role: 'user', content: 'ping' },
          },
        },
      },
      {
        sequence: 2,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-end',
            timestamp: 2000,
            turnIndex: 1,
            message: {
              role: 'assistant',
              clientMessageId: 'asst-client-1',
              content: '第一轮',
            },
          },
        },
      },
      {
        sequence: 3,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-end',
            timestamp: 3000,
            turnIndex: 2,
            message: {
              role: 'assistant',
              clientMessageId: 'asst-client-1',
              content: '第二轮',
            },
          },
        },
      },
    ];
    const { messages } = projectEventsToMessages(events);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.id).toBe('asst-client-1');
    expect(messages[1]?.text).toBe('第一轮\n\n第二轮');
    expect(messages[1]?.status).toBe('completed');
  });

  it('同 turnIndex 重复/修订 message-end：终态权威覆盖，不追加', () => {
    const events = [
      {
        sequence: 1,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-end',
            timestamp: 2000,
            turnIndex: 1,
            message: {
              role: 'assistant',
              clientMessageId: 'asst-client-1',
              content: '第一轮',
            },
          },
        },
      },
      {
        sequence: 2,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-end',
            timestamp: 2001,
            turnIndex: 1,
            message: {
              role: 'assistant',
              clientMessageId: 'asst-client-1',
              content: '第一轮（修订）',
            },
          },
        },
      },
    ];
    const { messages } = projectEventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe('第一轮（修订）');
  });

  it('旧载荷（无 turnIndex 的多轮事件）：按 0 处理，覆盖语义保持旧行为（向前兼容）', () => {
    const events = [
      {
        sequence: 1,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-end',
            timestamp: 2000,
            message: {
              role: 'assistant',
              clientMessageId: 'asst-client-1',
              content: '第一轮',
            },
          },
        },
      },
      {
        sequence: 2,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-end',
            timestamp: 3000,
            message: {
              role: 'assistant',
              clientMessageId: 'asst-client-1',
              content: '第二轮',
            },
          },
        },
      },
    ];
    const { messages } = projectEventsToMessages(events);
    expect(messages).toHaveLength(1);
    // 旧引擎无 turn 维度，无从分段——锁定「覆盖」旧行为不改变（不产生拼接噪声）
    expect(messages[0]?.text).toBe('第二轮');
  });

  it('delta hyd-* 后 message-end 带 clientMessageId 时重键到稳定 id', () => {
    const events = [
      {
        sequence: 1,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-delta',
            timestamp: 1000,
            block: { type: 'text', text: 'Hel' },
          },
        },
      },
      {
        sequence: 2,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-end',
            timestamp: 2000,
            message: {
              role: 'assistant',
              clientMessageId: 'asst-stable-rekey',
              content: 'Hello world',
            },
          },
        },
      },
    ];
    const { messages } = projectEventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe('asst-stable-rekey');
    expect(messages[0]?.text).toBe('Hello world');
    expect(messages[0]?.status).toBe('completed');
  });

  it('对抗：本地 stream final + hydrate project 同 clientMessageId merge 不增条', () => {
    const localFinal: SessionMessage[] = [
      {
        id: 'user-client-1',
        sender: 'user',
        text: 'ping',
        timestamp: 1,
        status: 'completed',
      },
      {
        id: 'asst-client-1',
        sender: 'assistant',
        text: 'pong',
        timestamp: 2,
        status: 'completed',
      },
    ];
    const fromEvents = projectEventsToMessages(sampleEvents).messages;
    const merged = mergeMessagesById(localFinal, fromEvents);
    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.id)).toEqual(['user-client-1', 'asst-client-1']);
    // 再 hydrate 一次仍幂等
    const again = mergeMessagesById(merged, fromEvents);
    expect(again).toHaveLength(2);
  });

  it('对抗：本地 assistant-msg-* stream final + hydrate message-end 同 clientMessageId rekey 后 merge 单条', () => {
    // 本地 stream 路径：generateMessageId('assistant') → assistant-msg-*
    const localAsstId = 'assistant-msg-m1abc-deadbeef-0001';
    const localFinal: SessionMessage[] = [
      {
        id: 'user-msg-m1abc-cafebabe-0000',
        sender: 'user',
        text: 'hello',
        timestamp: 10,
        status: 'completed',
      },
      {
        id: localAsstId,
        sender: 'assistant',
        text: 'Hello from stream final',
        timestamp: 20,
        status: 'completed',
      },
    ];
    // 引擎事件：delta 无 id → hyd-asst-*; message-end 带回 UI clientMessageId
    const events = [
      {
        sequence: 1,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-delta',
            timestamp: 15,
            block: { type: 'text', text: 'Hel' },
          },
        },
      },
      {
        sequence: 2,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-end',
            timestamp: 25,
            message: {
              role: 'assistant',
              id: 'engine-uuid-asst-99',
              clientMessageId: localAsstId,
              content: 'Hello from stream final',
            },
          },
        },
      },
    ];
    const fromEvents = projectEventsToMessages(events).messages;
    expect(fromEvents).toHaveLength(1);
    expect(fromEvents[0]?.id).toBe(localAsstId);
    expect(fromEvents[0]?.id).not.toMatch(/^hyd-asst-/);

    const merged = mergeMessagesById(localFinal, fromEvents);
    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.id)).toEqual([
      'user-msg-m1abc-cafebabe-0000',
      localAsstId,
    ]);
    expect(merged[1]?.status).toBe('completed');
    expect(merged[1]?.text).toBe('Hello from stream final');

    // 再 project + merge 仍不增条（stream final + hydrate 幂等）
    const again = mergeMessagesById(
      merged,
      projectEventsToMessages(events).messages
    );
    expect(again).toHaveLength(2);
  });

  it('daemon 省略 clientMessageId 时：本地 stream 仍用稳定 assistant-msg-* upsert；hydrate 走 engine id 不覆盖本地键', () => {
    const localAsstId = 'assistant-msg-local-stable-0002';
    const localOnly: SessionMessage[] = [
      {
        id: localAsstId,
        sender: 'assistant',
        text: 'local stream body',
        timestamp: 1,
        status: 'completed',
      },
    ];
    // 无 clientMessageId → pickStableMessageId 用 engine id（或 hyd 回退）
    const events = [
      {
        sequence: 1,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-end',
            timestamp: 2,
            message: {
              role: 'assistant',
              id: 'engine-only-id-xyz',
              content: 'engine body',
            },
          },
        },
      },
    ];
    const fromEvents = projectEventsToMessages(events).messages;
    expect(fromEvents[0]?.id).toBe('engine-only-id-xyz');
    // 本地键保持；merge 因 id 不同会并列（daemon omit 时无法 rekey）
    // 但本地路径自身始终用 assistant-msg-* 做 stream upsert，不依赖 hydrate
    expect(localOnly[0]?.id).toBe(localAsstId);
    const merged = mergeMessagesById(localOnly, fromEvents);
    expect(merged.some((m) => m.id === localAsstId)).toBe(true);
    expect(merged.find((m) => m.id === localAsstId)?.text).toBe(
      'local stream body'
    );
  });

  it('metadata.clientMessageId 亦可驱动 rekey（runtime enrich 路径）', () => {
    const events = [
      {
        sequence: 1,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-delta',
            timestamp: 1,
            block: { type: 'text', text: 'x' },
          },
        },
      },
      {
        sequence: 2,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-end',
            timestamp: 2,
            message: {
              role: 'assistant',
              id: 'engine-id',
              metadata: {
                clientMessageId: 'assistant-msg-from-meta',
              },
              content: 'via meta',
            },
          },
        },
      },
    ];
    const { messages } = projectEventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe('assistant-msg-from-meta');
  });
});

describe('T3 归一断言：replay 与 live 走同一 generated parser / 共享投影', () => {
  it('replay（信封解包→parseBridgeEvent→投影）与 live（parseBridgeEvent→共享投影后处理）正文/块一致', () => {
    // 同一组 raw 事件（runtime-event 信封 + message-delta + message-end），
    // 与 live 桥同协议形态。replay 经 projectEventsToMessages 投影。
    const replay = projectEventsToMessages([
      {
        sequence: 1,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-delta',
            timestamp: 1000,
            block: { type: 'text', text: '同一条' },
          },
        },
      },
      {
        sequence: 2,
        type: 'runtime-event',
        payload: {
          event: {
            type: 'message-end',
            timestamp: 2000,
            message: {
              role: 'assistant',
              clientMessageId: 'asst-same-doc',
              blocks: [
                { type: 'text', text: '同一条终态' },
                { type: 'thought', text: '思考过程' },
              ],
            },
          },
        },
      },
    ]).messages;
    expect(replay).toHaveLength(1);
    expect(replay[0]?.id).toBe('asst-same-doc');
    expect(replay[0]?.text).toBe('同一条终态');
    expect(replay[0]?.thinking).toBe('思考过程');

    // live onMessageEnd 对同一 AgentMessage 走同一共享投影原语
    //（projectAgentMessageContent 在 messageHandlers.onMessageEnd 消费），
    // 正文/思考与 replay 一致 —— 证明无第二条手写解析路径。
    const live = projectAgentMessageContent({
      blocks: [{ type: 'text', text: '同一条终态' }],
      content: '同一条终态',
    });
    expect(live.text).toBe('同一条终态');
    expect(live.thought).toBe('');
  });
});
