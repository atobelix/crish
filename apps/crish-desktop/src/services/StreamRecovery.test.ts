/**
 * StreamRecovery — 高频 chunk + 断线 sequence 续流 + 64KB 背压
 *
 * 验收：
 * 1. 100+ chunk 中途 disconnect → recover + read-run-events replay
 * 2. 最终 assistant 全文 === 期望拼接（无截断无重叠）
 * 3. buffer > 64KB 触发 pause 信号
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequest = vi.fn();
const mockSend = vi.fn();
const mockIsConnected = vi.fn(() => true);
const mockWaitUntilConnected = vi.fn(async () => true);
const mockSendBinary = vi.fn();
const mockSupportsBinary = vi.fn(() => false);

vi.mock('../api/daemonClient', () => ({
  getDesktopDaemonClient: () => ({
    request: mockRequest,
    send: mockSend,
    isConnected: mockIsConnected,
    waitUntilConnected: mockWaitUntilConnected,
    sendBinary: mockSendBinary,
    supportsBinaryFrames: mockSupportsBinary,
    onMessage: () => () => undefined,
    startKeepAlive: () => undefined,
  }),
  sendStreamPause: async (runId: string) => {
    await mockSend({ type: 'stream-pause', runId });
    return 'json' as const;
  },
  sendStreamResume: async (runId: string) => {
    await mockSend({ type: 'stream-resume', runId });
    return 'json' as const;
  },
  BinaryFrameType: { STREAM_PAUSE: 0x21, STREAM_RESUME: 0x22 },
}));

import {
  BACKPRESSURE_HIGH_WATER,
  BACKPRESSURE_LOW_WATER,
  extractEventSequence,
  orchestratorEventToAgentEvent,
  projectAssistantTextFromEvents,
  StreamRecovery,
  suffixDelta,
} from './StreamRecovery';
import { EventRouter, type StreamState } from '../api/daemonChatBridge';
import { ApprovalFlowMachine } from '../api/approvalFlowMachine';

function makeRuntimeDelta(seq: number, text: string, runId = 'run-1'): Record<string, unknown> {
  return {
    id: `ev-${seq}`,
    sequence: seq,
    type: 'runtime-event',
    runId,
    sessionId: 'sess-1',
    timestamp: new Date().toISOString(),
    payload: {
      event: {
        type: 'message-delta',
        block: { type: 'text', text },
      },
    },
  };
}

describe('suffixDelta / project helpers', () => {
  it('suffixDelta only emits new tail (no overlap)', () => {
    expect(suffixDelta('', 'hello')).toBe('hello');
    expect(suffixDelta('hel', 'hello')).toBe('lo');
    expect(suffixDelta('hello', 'hello')).toBe('');
    expect(suffixDelta('hello world', 'hello')).toBe('');
  });

  it('projectAssistantTextFromEvents concatenates message-delta blocks', () => {
    const events = [
      makeRuntimeDelta(1, 'Hello '),
      makeRuntimeDelta(2, 'world'),
      makeRuntimeDelta(3, '!'),
    ];
    expect(projectAssistantTextFromEvents(events)).toBe('Hello world!');
  });

  it('orchestratorEventToAgentEvent unwraps runtime-event and terminals', () => {
    const agent = orchestratorEventToAgentEvent(makeRuntimeDelta(1, 'x'));
    expect(agent?.type).toBe('message-delta');
    const done = orchestratorEventToAgentEvent({
      type: 'run-completed',
      runId: 'r',
      sequence: 9,
    });
    expect(done?.type).toBe('run-terminal');
    expect(done?.terminal).toBe('completed');
  });

  it('extractEventSequence reads sequence / eventSequence / seq', () => {
    expect(extractEventSequence({ sequence: 3 })).toBe(3);
    expect(extractEventSequence({ eventSequence: 4 })).toBe(4);
    expect(extractEventSequence({ seq: 5 })).toBe(5);
    expect(extractEventSequence({})).toBeNull();
  });
});

describe('StreamRecovery register / heartbeat / terminal', () => {
  let recovery: StreamRecovery;

  beforeEach(() => {
    recovery = new StreamRecovery();
    mockRequest.mockReset();
    mockSend.mockReset();
    mockIsConnected.mockReturnValue(true);
  });

  afterEach(() => {
    recovery.clearAll();
  });

  it('registerStream + updateHeartbeat advances sequence and bytes', () => {
    recovery.registerStream('sess-a', 'run-a');
    recovery.updateHeartbeat('sess-a', { sequence: 3, bytes: 10 });
    recovery.updateHeartbeat('sess-a', { sequence: 2, bytes: 5 }); // 不回退
    recovery.updateHeartbeat('sess-a', { sequence: 7, bytes: 2 });
    const s = recovery.getStream('sess-a');
    expect(s?.lastSequenceNumber).toBe(7);
    expect(s?.receivedBytes).toBe(17);
    expect(s?.status).toBe('streaming');
  });

  it('markCompleted / markFailed are terminal and idempotent', () => {
    recovery.registerStream('sess-b', 'run-b');
    recovery.markCompleted('sess-b');
    expect(recovery.getStream('sess-b')?.status).toBe('completed');
    recovery.markFailed('sess-b', 'x');
    expect(recovery.getStream('sess-b')?.status).toBe('completed');
  });
});

describe('StreamRecovery recover + read-run-events replay (no truncate / no overlap)', () => {
  let recovery: StreamRecovery;

  beforeEach(() => {
    recovery = new StreamRecovery();
    mockRequest.mockReset();
    mockSend.mockReset();
    mockIsConnected.mockReturnValue(true);
    mockWaitUntilConnected.mockResolvedValue(true);
  });

  afterEach(() => {
    recovery.clearAll();
  });

  it('100+ chunks mid disconnect → recover replays remaining → full text exact', async () => {
    const sessionId = 'sess-hf';
    const runId = 'run-hf';
    recovery.registerStream(sessionId, runId);

    // 模拟 120 个 chunk；前 70 已 live 收到
    const allParts: string[] = [];
    for (let i = 1; i <= 120; i++) {
      allParts.push(`c${i}|`);
    }
    const expectedFull = allParts.join('');

    // live 已应用 1..70
    let liveText = '';
    for (let i = 0; i < 70; i++) {
      liveText += allParts[i]!;
      recovery.updateHeartbeat(sessionId, {
        sequence: i + 1,
        bytes: allParts[i]!.length,
      });
    }
    expect(recovery.getStream(sessionId)?.lastSequenceNumber).toBe(70);

    // 断线后 recover：snapshot=running，read-run-events 返回 71..120
    const missingEvents = allParts.slice(70).map((t, idx) =>
      makeRuntimeDelta(71 + idx, t, runId),
    );

    mockRequest.mockImplementation(async (cmd: Record<string, unknown>) => {
      if (cmd.type === 'get-run-snapshot') {
        return {
          type: 'run-snapshot',
          runId,
          snapshot: { status: 'running', runId },
        };
      }
      if (cmd.type === 'read-run-events') {
        const after = Number(cmd.afterSequence ?? 0);
        expect(after).toBe(70);
        const events = missingEvents.filter(
          (e) => (extractEventSequence(e) ?? 0) > after,
        );
        // 故意乱序，验证排序
        const shuffled = [...events].reverse();
        return {
          type: 'run-events',
          runId,
          events: shuffled,
          nextAfterSequence: 120,
          hasMore: false,
        };
      }
      throw new Error(`unexpected request ${String(cmd.type)}`);
    });

    // 用 EventRouter 作为真实 UI 累加路径
    const state: StreamState = {
      cancelled: false,
      finished: false,
      assistantText: liveText,
      assistantThought: '',
      unsub: null,
      endTimer: null,
    };
    let uiText = liveText;
    const chunks: string[] = [];
    const approval = new ApprovalFlowMachine();
    const router = new EventRouter(
      state,
      approval,
      {
        onChunk: (c) => {
          chunks.push(c);
          uiText += c;
        },
        onThought: () => undefined,
        onToolStart: () => undefined,
        onToolSuccess: () => undefined,
        onToolError: () => undefined,
        onComplete: () => undefined,
      },
      runId,
      () => undefined,
      () => undefined,
      { send: mockSend } as unknown as ReturnType<
        typeof import('../api/daemonClient').getDesktopDaemonClient
      >,
      sessionId,
    );
    // 同步 lastApplied
    for (let i = 1; i <= 70; i++) {
      recovery.updateHeartbeat(sessionId, { sequence: i });
    }
    // EventRouter 内部 lastApplied 从 0 起；通过 applyReplay 的 afterSequence 控制
    // 先把 router 的游标推进到 70：模拟 live 已处理
    router.applyReplayEvents({
      sessionId,
      runId,
      events: allParts.slice(0, 70).map((t, idx) => makeRuntimeDelta(idx + 1, t, runId)),
      afterSequence: 0,
      nextAfterSequence: 70,
    });
    // 此时 uiText 应仍等于 live（suffix 无新内容）
    expect(uiText).toBe(liveText);
    expect(state.assistantText).toBe(liveText);

    recovery.setReplayHandler(sessionId, (payload) => {
      router.applyReplayEvents(payload);
    });

    const ok = await recovery.recoverStream(sessionId);
    expect(ok).toBe(true);

    // 验证 read-run-events 被调用
    const readCalls = mockRequest.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === 'read-run-events',
    );
    expect(readCalls.length).toBeGreaterThanOrEqual(1);
    expect((readCalls[0]![0] as { afterSequence: number }).afterSequence).toBe(70);

    // 全文精确：无截断无重叠
    expect(uiText).toBe(expectedFull);
    expect(state.assistantText).toBe(expectedFull);
    expect(recovery.getStream(sessionId)?.lastSequenceNumber).toBe(120);
    expect(recovery.getStream(sessionId)?.status).toBe('streaming');
  });

  it('replay skips seq <= lastApplied (no double apply)', async () => {
    const sessionId = 'sess-dedup';
    const runId = 'run-dedup';
    recovery.registerStream(sessionId, runId);
    recovery.updateHeartbeat(sessionId, { sequence: 5, bytes: 10 });

    const events = [
      makeRuntimeDelta(4, 'SKIP'),
      makeRuntimeDelta(5, 'SKIP2'),
      makeRuntimeDelta(6, 'OK'),
      makeRuntimeDelta(7, '!'),
    ];

    mockRequest.mockImplementation(async (cmd: Record<string, unknown>) => {
      if (cmd.type === 'get-run-snapshot') {
        return { type: 'run-snapshot', snapshot: { status: 'running' } };
      }
      if (cmd.type === 'read-run-events') {
        return {
          type: 'run-events',
          events,
          nextAfterSequence: 7,
          hasMore: false,
        };
      }
      throw new Error('bad');
    });

    let text = 'base';
    recovery.setReplayHandler(sessionId, (payload) => {
      // 只拼 fresh 事件文本
      const parts = payload.events.map((e) => {
        const a = orchestratorEventToAgentEvent(e);
        const b = a?.block as { text?: string } | undefined;
        return b?.text ?? '';
      });
      text += parts.join('');
    });

    await recovery.recoverStream(sessionId);
    // recovery 侧已 filter seq>5 → OK!
    expect(text).toBe('baseOK!');
  });
});

describe('StreamRecovery 64KB backpressure', () => {
  let recovery: StreamRecovery;

  beforeEach(() => {
    recovery = new StreamRecovery();
    mockSend.mockReset();
    mockSend.mockResolvedValue(undefined);
  });

  afterEach(() => {
    recovery.clearAll();
  });

  it('buffer > 64KB triggers stream-pause; < 16KB triggers stream-resume', async () => {
    recovery.registerStream('sess-bp', 'run-bp');

    const pause = recovery.noteRenderBuffer('sess-bp', BACKPRESSURE_HIGH_WATER + 1);
    expect(pause).toBe('pause');
    expect(recovery.isBackpressurePaused('sess-bp')).toBe(true);

    // 等 microtask 完成 send
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stream-pause', runId: 'run-bp' }),
    );

    mockSend.mockClear();
    // 仍在高水位：不再重复 pause
    expect(recovery.noteRenderBuffer('sess-bp', BACKPRESSURE_HIGH_WATER + 100)).toBe('none');

    const resume = recovery.noteRenderBuffer('sess-bp', BACKPRESSURE_LOW_WATER - 1);
    expect(resume).toBe('resume');
    expect(recovery.isBackpressurePaused('sess-bp')).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stream-resume', runId: 'run-bp' }),
    );
  });

  it('backpressure queue never drops chunks; drain returns them in order', () => {
    recovery.registerStream('sess-q', 'run-q');
    expect(recovery.enqueueBackpressureChunk('sess-q', 'aaa')).toBe(true);
    expect(recovery.enqueueBackpressureChunk('sess-q', 'bbb')).toBe(true);
    expect(recovery.pendingBackpressureBytes('sess-q')).toBe(6);
    expect(recovery.drainBackpressureChunks('sess-q')).toEqual(['aaa', 'bbb']);
    expect(recovery.pendingBackpressureBytes('sess-q')).toBe(0);
  });
});

describe('EventRouter.applyReplayEvents integration', () => {
  it('accumulates deltas without overlap when replaying after partial live text', () => {
    const state: StreamState = {
      cancelled: false,
      finished: false,
      assistantText: 'Hello ',
      assistantThought: '',
      unsub: null,
      endTimer: null,
    };
    let full = 'Hello ';
    const router = new EventRouter(
      state,
      new ApprovalFlowMachine(),
      {
        onChunk: (c) => {
          full += c;
        },
        onThought: () => undefined,
        onToolStart: () => undefined,
        onToolSuccess: () => undefined,
        onToolError: () => undefined,
        onComplete: () => undefined,
      },
      'run-x',
      () => undefined,
      () => undefined,
      { send: vi.fn() } as unknown as ReturnType<
        typeof import('../api/daemonClient').getDesktopDaemonClient
      >,
      'sess-x',
    );

    // 全量 replay（afterSequence=0）包含已有 + 新内容
    router.applyReplayEvents({
      sessionId: 'sess-x',
      runId: 'run-x',
      events: [
        makeRuntimeDelta(1, 'Hello '),
        makeRuntimeDelta(2, 'world'),
        makeRuntimeDelta(3, '!'),
      ],
      afterSequence: 0,
      nextAfterSequence: 3,
    });

    expect(full).toBe('Hello world!');
    expect(state.assistantText).toBe('Hello world!');
    expect(router.getLastAppliedSequence()).toBe(3);
  });
});
