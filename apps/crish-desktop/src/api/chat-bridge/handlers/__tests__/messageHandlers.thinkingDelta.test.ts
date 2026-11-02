/**
 * R6：思考事件 delta 化回归（性能审计 P2-2）。
 *
 * 旧实现每帧把累计全文（prevThought + t）经 onThought 整体回放，长思考流
 * 的回调总字符量为 O(n²)；新实现只传本帧 delta，下游按 mode 累积：
 * - 本轮首个增量 mode='set'（下游覆写上一轮累积、从本轮重新累积）；
 * - 后续增量 mode='append'（下游拼接）；
 * - message-end 权威思考以 mode='set' 全文覆写。
 * 本文件断言回调流量线性、下游按 mode 重组后与旧全文语义逐字等价。
 */
import { describe, expect, it, vi } from 'vitest';
import { ApprovalFlowMachine } from '../../../approvalFlowMachine';
import type { StreamCallbacks } from '../../../chatApi';
import { parseBridgeEvent } from '../eventParser';
import { dispatchEvent } from '../dispatch';
import type { HandlerEnv } from '../handlerEnv';
import type { StreamState } from '../streamState';

const SESS_ID = 'sess-thinking-delta';
const MSG_ID = 'asst-thinking-delta';

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
  const env: HandlerEnv = {
    state,
    approvalFlow: new ApprovalFlowMachine(),
    callbacks,
    runId: 'run-thinking-delta',
    sessionId: SESS_ID,
    finish: vi.fn(),
    tryResumeFinish: vi.fn(),
    client: { send: vi.fn() },
  };
  return { env, state, callbacks };
}

function dispatchThought(
  env: HandlerEnv,
  text: string,
  turnIndex?: number
): void {
  const parsed = parseBridgeEvent({
    type: 'message-delta',
    sessionId: SESS_ID,
    timestamp: new Date().toISOString(),
    messageId: MSG_ID,
    ...(turnIndex !== undefined ? { turnIndex } : {}),
    block: { type: 'thought', text },
  });
  if (parsed.ok) dispatchEvent(env, parsed.data);
}

type ThoughtCall = [string, number | undefined, ('append' | 'set') | undefined];

function thoughtCalls(callbacks: StreamCallbacks): ThoughtCall[] {
  return (callbacks.onThought as ReturnType<typeof vi.fn>).mock
    .calls as ThoughtCall[];
}

/** 按 mode 语义在下游重组：set 覆写、append 拼接（与消费侧实现同构）。 */
function reassemble(calls: ThoughtCall[]): string {
  let acc = '';
  for (const [payload, , mode] of calls) {
    acc = mode === 'append' ? acc + payload : payload;
  }
  return acc;
}

describe('R6 思考 delta 化', () => {
  it('500 个 delta 的回调总字符量线性（旧全文回放为平方量级）', () => {
    const { env, state, callbacks } = makeEnv();
    const N = 500;
    const piece = '一二三四五六七八九十'; // 10 字符/帧
    for (let i = 0; i < N; i++) dispatchThought(env, piece);

    const calls = thoughtCalls(callbacks);
    expect(calls).toHaveLength(N);
    const totalChars = calls.reduce((sum, c) => sum + c[0].length, 0);
    // 线性：总流量恰为全文长度；旧实现为 sum(len_i) ≈ N(N+1)/2 × 10 ≈ 1.25M
    expect(totalChars).toBe(N * piece.length);
    // 首帧 set、其余 append
    expect(calls[0]?.[2]).toBe('set');
    expect(calls[1]?.[2]).toBe('append');
    expect(calls[N - 1]?.[2]).toBe('append');
    // 下游重组与 handler 侧累积逐字一致
    expect(reassemble(calls)).toBe(state.assistantThought);
    expect(state.assistantThought).toBe(piece.repeat(N));
    expect(callbacks.onChunk).not.toHaveBeenCalled();
  });

  it('轮次切换时新轮首帧重新以 set 下发', () => {
    const { env, callbacks } = makeEnv();
    dispatchThought(env, '第一轮思考', 0);
    dispatchThought(env, '继续', 0);
    dispatchThought(env, '第二轮思考', 1);
    dispatchThought(env, '继续', 1);

    const calls = thoughtCalls(callbacks);
    expect(calls.map((c) => c[2])).toEqual(['set', 'append', 'set', 'append']);
    expect(calls.map((c) => c[1])).toEqual([0, 0, 1, 1]);
    // 下游按轮重组：每轮 set 重置累积
    let acc = '';
    const perTurn: string[] = [];
    for (const [payload, , mode] of calls) {
      if (mode === 'set') {
        if (acc) perTurn.push(acc);
        acc = payload;
      } else {
        acc += payload;
      }
    }
    perTurn.push(acc);
    expect(perTurn).toEqual(['第一轮思考继续', '第二轮思考继续']);
  });

  it('message-end 权威思考以 set 全文覆写流式累积', () => {
    const { env, state, callbacks } = makeEnv();
    dispatchThought(env, '流式思考片段', 0);
    const parsed = parseBridgeEvent({
      type: 'message-end',
      sessionId: SESS_ID,
      timestamp: new Date().toISOString(),
      turnIndex: 0,
      message: {
        id: MSG_ID,
        role: 'assistant',
        createdAt: new Date().toISOString(),
        content: '',
        blocks: [{ type: 'thought', text: '流式思考片段（权威版）' }],
      },
    });
    if (parsed.ok) dispatchEvent(env, parsed.data);

    const calls = thoughtCalls(callbacks);
    const last = calls[calls.length - 1];
    expect(last?.[0]).toBe('流式思考片段（权威版）');
    expect(last?.[2]).toBe('set');
    expect(reassemble(calls)).toBe('流式思考片段（权威版）');
    expect(state.assistantThought).toBe('流式思考片段（权威版）');
  });
});
