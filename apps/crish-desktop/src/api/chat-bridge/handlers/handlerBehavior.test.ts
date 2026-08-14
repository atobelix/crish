/**
 * 分派表行为级测试（T7 审计补位）。
 *
 * 审计结论：dispatch.test.ts 只有结构性穷举（24 引擎键 + 4 legacy 键"有 handler 且不抛错"），
 * EventRouter.test.ts 只对约 10 个事件类型有行为断言。本文件为以下类型补行为级断言：
 * - context-compression-* / checkpoint-* / runtime-steering / runtime-intervention-required /
 *   turn-start / turn-end / agent-start / message-start：显式空实现，锁定"无副作用"；
 * - tool-update / tool-batch-start / tool-batch-end / tool-input-repaired：
 *   toolHandlers.ts 的 4 个显式 no-op handler，锁定"不应有副作用"（含批事件携带 calls 也不消费）；
 * - provider-diagnostic：唯一有实际副作用的诊断 handler，锁定"记可观测日志，不触碰状态/回调"。
 *
 * 信封一律经 parseBridgeEvent 宽容路径构造（缺信封字段的典型形态），
 * 经 dispatchEvent 分派，覆盖"解析 → 分派 → handler"整链行为。
 */
import { describe, expect, it, vi } from 'vitest';
import { ApprovalFlowMachine } from '../../approvalFlowMachine';
import type { StreamCallbacks } from '../../chatApi';
import { parseBridgeEvent } from './eventParser';
import { dispatchEvent } from './dispatch';
import type { HandlerEnv } from './handlerEnv';
import type { StreamState } from './streamState';

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
  return {
    env,
    state,
    callbacks,
    approvalFlow,
    finish,
    tryResumeFinish,
    client,
  };
}

/** 锁定无副作用：全部回调、finish、tryResumeFinish、client.send 未调用，状态与审批机不变 */
function expectNoSideEffects(env: HandlerEnv): void {
  const { callbacks, approvalFlow, finish, tryResumeFinish, client, state } =
    env;
  for (const [, cb] of Object.entries(callbacks)) {
    expect(cb).not.toHaveBeenCalled();
  }
  expect(finish).not.toHaveBeenCalled();
  expect(tryResumeFinish).not.toHaveBeenCalled();
  expect(client.send).not.toHaveBeenCalled();
  expect(approvalFlow.snapshot()).toEqual({
    pendingCount: 0,
    inflightCount: 0,
    deferredTerminal: false,
    sawRunTerminal: false,
    flowStatus: 'idle',
  });
  expect(state).toEqual({
    cancelled: false,
    finished: false,
    assistantText: '',
    assistantThought: '',
    unsub: null,
    endTimer: null,
  });
}

function expectDispatchLenientNoSideEffects(
  payload: Record<string, unknown>
): void {
  const { env } = makeEnv();
  const parsed = parseBridgeEvent(payload);
  expect(parsed.ok).toBe(true);
  if (parsed.ok !== true) throw new Error(`测试载荷未解析：${parsed.error}`);
  dispatchEvent(env, parsed.data);
  expectNoSideEffects(env);
}

describe('显式空实现 handler 无副作用锁定（审计行为级补位）', () => {
  const cases: Array<{ name: string; payload: Record<string, unknown> }> = [
    { name: 'agent-start', payload: { type: 'agent-start' } },
    {
      name: 'message-start',
      payload: { type: 'message-start', message: { role: 'assistant' } },
    },
    { name: 'turn-start', payload: { type: 'turn-start', turnIndex: 1 } },
    {
      name: 'turn-end',
      payload: { type: 'turn-end', turnIndex: 1, toolCallCount: 2 },
    },
    {
      name: 'tool-update',
      payload: {
        type: 'tool-update',
        batchId: 'b-1',
        toolCallId: 't-1',
        update: { text: 'x' },
      },
    },
    {
      name: 'tool-batch-start（携带 calls 也不消费）',
      payload: {
        type: 'tool-batch-start',
        batchId: 'b-2',
        calls: [
          {
            id: 'c-1',
            toolName: 'shell_command',
            summary: 'ls',
            input: { command: 'ls' },
            category: 'terminal',
            concurrency: 'sequential',
          },
        ],
      },
    },
    {
      name: 'tool-batch-end（携带 calls 也不消费）',
      payload: {
        type: 'tool-batch-end',
        batchId: 'b-3',
        calls: [
          {
            id: 'r-1',
            toolName: 'shell_command',
            output: 'done',
            isError: false,
            durationMs: 1,
          },
        ],
      },
    },
    {
      name: 'context-compression-start',
      payload: {
        type: 'context-compression-start',
        reason: 'token-budget',
        tokensBefore: 1000,
      },
    },
    {
      name: 'context-compression-end',
      payload: {
        type: 'context-compression-end',
        aborted: false,
        result: { trigger: 'manual', reason: 'budget' },
      },
    },
    {
      name: 'checkpoint-created',
      payload: {
        type: 'checkpoint-created',
        checkpoint: {
          id: 'cp-1',
          kind: 'workspace-checkpoint',
          label: 'l',
          toolCallId: 't-3',
          toolName: 'write_file',
        },
      },
    },
    {
      name: 'checkpoint-restored',
      payload: {
        type: 'checkpoint-restored',
        restore: {
          checkpointId: 'cp-1',
          toolCallId: 't-4',
          toolName: 'write_file',
          restored: ['a.txt'],
          deleted: [],
          skipped: [],
        },
      },
    },
    {
      name: 'runtime-steering',
      payload: {
        type: 'runtime-steering',
        reason: 'overlap',
        message: { role: 'assistant' },
      },
    },
    {
      name: 'runtime-intervention-required',
      payload: {
        type: 'runtime-intervention-required',
        reason: 'low-quality',
        choices: ['retry', 'abort'],
        message: 'm',
      },
    },
  ];

  for (const c of cases) {
    it(`${c.name}：回调 / finish / client / 状态 / 审批机全部无变化`, () => {
      expectDispatchLenientNoSideEffects(c.payload);
    });
  }

  it('tool-batch-start 信封携带 calls 直达 handler（宽容路径不丢数据），handler 无副作用', () => {
    const { env } = makeEnv();
    const parsed = parseBridgeEvent({
      type: 'tool-batch-start',
      batchId: 'b-2',
      calls: [
        {
          id: 'c-1',
          toolName: 'shell_command',
          summary: 'ls',
          input: {},
          category: 'terminal',
          concurrency: 'sequential',
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok !== true) throw new Error(parsed.error);
    expect(parsed.data.kind).toBe('engine');
    if (parsed.data.kind === 'engine') {
      expect(parsed.data.event.calls).toHaveLength(1);
    }
    dispatchEvent(env, parsed.data);
    expectNoSideEffects(env);
  });
});

describe('provider-diagnostic 行为：记可观测日志，不触碰状态与回调', () => {
  it('宽容形态 diagnostic 载荷经分派只触发 console.warn（scope=provider-diagnostic）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { env } = makeEnv();
      const parsed = parseBridgeEvent({
        type: 'provider-diagnostic',
        diagnostic: {
          phase: 'request',
          providerId: 'openai',
          status: 429,
          retryable: true,
        },
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok !== true) throw new Error(parsed.error);
      dispatchEvent(env, parsed.data);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('provider-diagnostic');
      const detail = String(warn.mock.calls[0][1] ?? '');
      expect(detail).toContain('openai');
      expect(detail).toContain('429');
      expectNoSideEffects(env);
    } finally {
      warn.mockRestore();
    }
  });

  it('缺 diagnostic 时回退顶层 data 字段记录', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { env } = makeEnv();
      const parsed = parseBridgeEvent({
        type: 'provider-diagnostic',
        data: { phase: 'connect', endpoint: 'https://x' },
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok !== true) throw new Error(parsed.error);
      dispatchEvent(env, parsed.data);
      expect(warn).toHaveBeenCalledTimes(1);
      const detail = String(warn.mock.calls[0][1] ?? '');
      expect(detail).toContain('https://x');
      expectNoSideEffects(env);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('onMessageEnd 终态权威 + turnIndex 分段（G3/G4 / 04 §5.1-2、§5.2-5）', () => {
  function dispatchMessageEnd(
    env: HandlerEnv,
    payload: Record<string, unknown>
  ): void {
    const parsed = parseBridgeEvent({ type: 'message-end', ...payload });
    expect(parsed.ok).toBe(true);
    if (parsed.ok !== true) throw new Error(`测试载荷未解析：${parsed.error}`);
    dispatchEvent(env, parsed.data);
  }

  function assistantMessage(content: string): Record<string, unknown> {
    return { role: 'assistant', content };
  }

  it('丢中段/修订：终稿全文权威覆盖增量累积（不做 \\n\\n 追加，消灭两段共存）', () => {
    const { env, state, callbacks } = makeEnv();
    // 模拟增量丢帧后的累积文本（缺中段）
    state.assistantText = 'Helloworld';
    dispatchMessageEnd(env, {
      message: assistantMessage('Hello brave new world'),
    });
    expect(state.assistantText).toBe('Hello brave new world');
    // onChunk 只补差额（slice(prevLen)）：'Helloworld' 长 10，终稿 21 → 差 11 字符
    expect(callbacks.onChunk).toHaveBeenCalledWith('e new world');
  });

  it('多轮 run：同 clientMessageId 按 turnIndex 分段追加（live 单气泡全文）', () => {
    const { env, state, callbacks } = makeEnv();
    dispatchMessageEnd(env, {
      turnIndex: 1,
      message: assistantMessage('第一轮'),
    });
    expect(state.assistantText).toBe('第一轮');
    dispatchMessageEnd(env, {
      turnIndex: 2,
      message: assistantMessage('第二轮'),
    });
    expect(state.assistantText).toBe('第一轮\n\n第二轮');
    expect(callbacks.onChunk).toHaveBeenNthCalledWith(1, '第一轮');
    // 第二段差额含段间分隔符（\n\n 前缀，由 join 产出）
    expect(callbacks.onChunk).toHaveBeenNthCalledWith(2, '\n\n第二轮');
  });

  it('同 turn 重复 message-end（重发）：幂等覆盖，不重复追加', () => {
    const { env, state, callbacks } = makeEnv();
    dispatchMessageEnd(env, {
      turnIndex: 1,
      message: assistantMessage('第一轮'),
    });
    dispatchMessageEnd(env, {
      turnIndex: 1,
      message: assistantMessage('第一轮'),
    });
    expect(state.assistantText).toBe('第一轮');
    expect(callbacks.onChunk).toHaveBeenCalledTimes(1);
  });

  it('同 turn 修订 message-end：终态权威覆盖该段，不追加', () => {
    const { env, state, callbacks } = makeEnv();
    dispatchMessageEnd(env, {
      turnIndex: 1,
      message: assistantMessage('第一轮'),
    });
    dispatchMessageEnd(env, {
      turnIndex: 1,
      message: assistantMessage('第一轮（修订）'),
    });
    expect(state.assistantText).toBe('第一轮（修订）');
    // 修订段更长 → 补差额；同 turn 不产生第二段
    expect(callbacks.onChunk).toHaveBeenCalledTimes(2);
    expect(callbacks.onChunk).toHaveBeenNthCalledWith(2, '（修订）');
  });

  it('旧载荷（无 turnIndex）：按 0 处理，重复 message-end 幂等（向前兼容）', () => {
    const { env, state, callbacks } = makeEnv();
    dispatchMessageEnd(env, { message: assistantMessage('正文') });
    dispatchMessageEnd(env, { message: assistantMessage('正文') });
    expect(state.assistantText).toBe('正文');
    expect(callbacks.onChunk).toHaveBeenCalledTimes(1);
  });

  it('message-end 缺正文（content/blocks 全空）：不产生 onChunk，状态不变', () => {
    const { env, state, callbacks } = makeEnv();
    dispatchMessageEnd(env, { turnIndex: 1, message: { role: 'assistant' } });
    expect(state.assistantText).toBe('');
    expect(callbacks.onChunk).not.toHaveBeenCalled();
  });
});
