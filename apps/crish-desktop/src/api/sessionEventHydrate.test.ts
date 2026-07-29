import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '../store/layoutStore';
import {
  applyUsageDelta,
  mergeMessagesById,
  parseRunSnapshotUsage,
  projectEventsToMessages,
  type UsageDeltaState,
} from './sessionEventHydrate';

const baseUsage: UsageDeltaState = {
  input: 100,
  output: 50,
  cost: 0.01,
  inputMax: 160000,
  outputMax: 40000,
};

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
  it('no-ops when all deltas are zero', () => {
    const next = applyUsageDelta(baseUsage, {}, () => 1);
    expect(next).toBe(baseUsage);
  });

  it('accumulates 2D tokens + cost via estimateCost', () => {
    const next = applyUsageDelta(
      baseUsage,
      { promptTokens: 10, completionTokens: 5 },
      (i, o) => i * 0.001 + o * 0.002,
    );
    expect(next.input).toBe(110);
    expect(next.output).toBe(55);
    // base 0.01 + (10*0.001 + 5*0.002)=0.02 → 0.03
    expect(next.cost).toBeCloseTo(0.03, 8);
    expect(next.cacheRead).toBeUndefined();
    expect(next.savedCost).toBeUndefined();
  });

  it('accumulates 4D cache + savedCost when provided', () => {
    const next = applyUsageDelta(
      baseUsage,
      {
        promptTokens: 100,
        completionTokens: 20,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
      },
      (i, o, cr = 0, cw = 0) => i * 0.0001 + o * 0.0002 + cr * 0.00001 + cw * 0.00005,
      (i, o, cr = 0) => cr * 0.00009,
    );
    expect(next.input).toBe(200);
    expect(next.output).toBe(70);
    expect(next.cacheRead).toBe(40);
    expect(next.cacheWrite).toBe(10);
    expect(next.savedCost).toBeCloseTo(40 * 0.00009, 8);
    expect(next.cost).toBeGreaterThan(baseUsage.cost);
  });

  it('preserves existing cache counters across subsequent deltas', () => {
    const mid = applyUsageDelta(
      { ...baseUsage, cacheRead: 10, savedCost: 0.01 },
      { promptTokens: 5, completionTokens: 0, cacheReadTokens: 3 },
      () => 0.001,
      () => 0.002,
    );
    expect(mid.cacheRead).toBe(13);
    expect(mid.savedCost).toBeCloseTo(0.012, 8);
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
    expect(merged.map((m) => m.id)).toEqual([
      'user-client-1',
      'asst-client-1',
    ]);
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
    expect(messages.map((m) => m.id)).toEqual(['user-client-1', 'asst-client-1']);
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
    expect(merged.map((m) => m.id)).toEqual([
      'user-client-1',
      'asst-client-1',
    ]);
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
      projectEventsToMessages(events).messages,
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
      'local stream body',
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
