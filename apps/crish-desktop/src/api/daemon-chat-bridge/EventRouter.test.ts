/**
 * EventRouter.onMsg 消费端测试（C2.2 / C2.4）。
 *
 * C2.2：`event` 信封分支与 run-ended 别名分支已删，onMsg 平铺事件直进 handleAgentEvent
 * （03 §5.2-1/2）。C2.4：四源失败全部收敛到 surfaceStreamFailure + finish（03 §2.4 表）。
 */
import { describe, expect, it, vi } from 'vitest';
import { EventRouter } from './EventRouter';
import { ApprovalFlowMachine } from '../approvalFlowMachine';
import type { StreamState } from './handlers/streamState';
import type { StreamCallbacks } from '../chatApi';

function makeState(): StreamState {
  return {
    cancelled: false,
    finished: false,
    assistantText: '',
    assistantThought: '',
    unsub: null,
    endTimer: null,
  };
}

function makeRouter(finish: ReturnType<typeof vi.fn>) {
  const state = makeState();
  const callbacks: StreamCallbacks = {
    onChunk: vi.fn(),
    onThought: vi.fn(),
    onComplete: vi.fn(),
    onToolStart: vi.fn(),
    onToolSuccess: vi.fn(),
    onToolError: vi.fn(),
  };
  const approvalFlow = new ApprovalFlowMachine();
  const router = new EventRouter(
    state,
    approvalFlow,
    callbacks,
    'run-test',
    finish,
    vi.fn(),
    'session-test',
  );
  return { router, state, callbacks, approvalFlow };
}

describe('EventRouter.onMsg 平铺事件直进 handleAgentEvent（C2.2）', () => {
  it('顶层 message-delta 事件直接流转（无 event 信封）', () => {
    const finish = vi.fn();
    const { router, callbacks, state } = makeRouter(finish);
    router.onMsg({
      type: 'message-delta',
      runId: 'run-test',
      sequence: 1,
      block: { type: 'text', text: 'hi' },
    });
    expect(callbacks.onChunk).toHaveBeenCalledTimes(1);
    expect(callbacks.onChunk).toHaveBeenCalledWith('hi');
    expect(state.assistantText).toBe('hi');
    expect(finish).not.toHaveBeenCalled();
  });

  it('schemaVersion 信封字段被忽略消费（PE-03 T03.10 双端 golden）', () => {
    // Rust 信封自 v1 起注入顶层 schemaVersion: 1（events.rs serialize 层）；
    // 前端按字段白名单消费，未知键必须静默忽略——新老事件同路径处理
    const finish = vi.fn();
    const { router, callbacks, state } = makeRouter(finish);
    router.onMsg({
      type: 'message-delta',
      runId: 'run-test',
      sequence: 2,
      schemaVersion: 1,
      block: { type: 'text', text: 'hi' },
    });
    expect(callbacks.onChunk).toHaveBeenCalledTimes(1);
    expect(callbacks.onChunk).toHaveBeenCalledWith('hi');
    expect(state.assistantText).toBe('hi');
    expect(finish).not.toHaveBeenCalled();

    // 终态事件同样带 schemaVersion 时收口不受影响
    const finish2 = vi.fn();
    const { router: router2 } = makeRouter(finish2);
    router2.onMsg({
      type: 'run-terminal',
      runId: 'run-test',
      sequence: 3,
      schemaVersion: 1,
      terminal: 'completed',
    });
    expect(finish2).toHaveBeenCalledTimes(1);
    expect(finish2).toHaveBeenCalledWith(false);
  });

  it('event 信封不再解包（分支已删，内层事件不双处理）', () => {
    const finish = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    router.onMsg({
      type: 'event',
      runId: 'run-test',
      event: { type: 'message-delta', block: { text: 'inner' } },
    });
    expect(callbacks.onChunk).not.toHaveBeenCalled();
    expect(callbacks.onThought).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it('run-ended 别名不再触发收口（分支已删，且非 handleAgentEvent 主路径别名）', () => {
    const finish = vi.fn();
    const onRunError = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    callbacks.onRunError = onRunError;
    router.onMsg({
      type: 'run-ended',
      runId: 'run-test',
      terminal: 'completed',
    });
    expect(finish).not.toHaveBeenCalled();
    expect(onRunError).not.toHaveBeenCalled();
  });

  it('run-terminal 平铺事件走主路径收口（唯一终态，03 §5.2-2）', () => {
    const finish = vi.fn();
    const { router } = makeRouter(finish);
    router.onMsg({
      type: 'run-terminal',
      runId: 'run-test',
      sequence: 5,
      terminal: 'completed',
    });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(false);
  });

  it('runId 过滤仍生效：非本 run 事件放行跳过', () => {
    const finish = vi.fn();
    const onRunError = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    callbacks.onRunError = onRunError;
    router.onMsg({
      type: 'run-terminal',
      runId: 'other-run',
      terminal: 'failed',
      error: 'boom',
    });
    expect(finish).not.toHaveBeenCalled();
    expect(onRunError).not.toHaveBeenCalled();
  });

  it('run-failed 平铺事件经主路径兼容别名收敛（run_terminal_seen + clear_all + finish(true)）', () => {
    const finish = vi.fn();
    const onRunError = vi.fn();
    const { router, callbacks, approvalFlow } = makeRouter(finish);
    callbacks.onRunError = onRunError;
    router.onMsg({
      type: 'run-failed',
      runId: 'run-test',
      error: 'x',
    });
    expect(onRunError).toHaveBeenCalledTimes(1);
    expect(onRunError.mock.calls[0][1]).toBe('run-failed');
    // run_terminal_seen 后 clear_all 全量复位（含 sawRunTerminal），机器回到 idle
    expect(approvalFlow.snapshot().flowStatus).toBe('idle');
    expect(finish).toHaveBeenCalledWith(true);
  });

  it('agent-end reason=stopped 平铺事件正常收口（D1，不报错）', () => {
    const finish = vi.fn();
    const onRunError = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    callbacks.onRunError = onRunError;
    router.onMsg({
      type: 'agent-end',
      runId: 'run-test',
      reason: 'stopped',
    });
    expect(finish).toHaveBeenCalledWith(false);
    expect(onRunError).not.toHaveBeenCalled();
  });

  it('approval-resolved 平铺事件直通 applyApprovalResolved（toolCallId 键控）', () => {
    const finish = vi.fn();
    const onApprovalResolved = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    callbacks.onApprovalResolved = onApprovalResolved;
    router.onMsg({
      type: 'approval-resolved',
      runId: 'run-test',
      toolCallId: 't1',
      decision: 'approved',
    });
    expect(onApprovalResolved).toHaveBeenCalledWith('t1', 'allow');
    expect(finish).not.toHaveBeenCalled();
  });

  it('approval-resolved 缺 toolCallId → 记协议错误，不触发回调', () => {
    const finish = vi.fn();
    const onApprovalResolved = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    callbacks.onApprovalResolved = onApprovalResolved;
    router.onMsg({
      type: 'approval-resolved',
      runId: 'run-test',
      decision: 'approved',
    });
    expect(onApprovalResolved).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it('subagent-started 信封级事件仍直转 UI 回调', () => {
    const finish = vi.fn();
    const onSubagentStarted = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    callbacks.onSubagentStarted = onSubagentStarted;
    router.onMsg({
      type: 'subagent-started',
      runId: 'run-test',
      subagentId: 'sa-1',
      subagentRunId: 'sr-1',
      description: '协作 agent',
      mode: 'research',
    });
    expect(onSubagentStarted).toHaveBeenCalledWith({
      subagentId: 'sa-1',
      subagentRunId: 'sr-1',
      parentRunId: 'run-test',
      parentToolCallId: undefined,
      description: '协作 agent',
      mode: 'research',
    });
    expect(finish).not.toHaveBeenCalled();
  });
});

describe('EventRouter.onMsg 四源失败收敛（C2.4，03 §2.4 表）', () => {
  it('源 4：error 信封（Rust 侧事件通道顶层 type=error）→ surfaceStreamFailure + clear_all + finish(true)', () => {
    const finish = vi.fn();
    const onRunError = vi.fn();
    const { router, callbacks, approvalFlow } = makeRouter(finish);
    callbacks.onRunError = onRunError;
    router.onMsg({
      type: 'error',
      runId: 'run-test',
      message: 'daemon exploded',
    });
    expect(onRunError).toHaveBeenCalledTimes(1);
    const [msg, kind] = onRunError.mock.calls[0];
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
    expect(kind).toBe('daemon-error');
    expect(approvalFlow.snapshot().flowStatus).toBe('idle');
    expect(finish).toHaveBeenCalledWith(true);
  });

  it('源 1：run-terminal failed 平铺 → surfaceStreamFailure + finish(true)', () => {
    const finish = vi.fn();
    const onRunError = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    callbacks.onRunError = onRunError;
    router.onMsg({
      type: 'run-terminal',
      runId: 'run-test',
      terminal: 'failed',
      error: 'boom',
    });
    expect(onRunError).toHaveBeenCalledTimes(1);
    expect(onRunError.mock.calls[0][1]).toBe('run-terminal-failed');
    expect(finish).toHaveBeenCalledWith(true);
  });

  it('源 2：runtime-error 平铺 → surfaceStreamFailure 但不 finish（Rust 必发 terminal，8s endTimer 兜底不动）', () => {
    const finish = vi.fn();
    const onRunError = vi.fn();
    const { router, callbacks, state } = makeRouter(finish);
    callbacks.onRunError = onRunError;
    router.onMsg({
      type: 'runtime-error',
      runId: 'run-test',
      error: 'provider boom',
      retryable: false,
    });
    expect(onRunError).toHaveBeenCalledTimes(1);
    expect(onRunError.mock.calls[0][1]).toBe('runtime-error');
    expect(finish).not.toHaveBeenCalled();
    expect(state.finished).toBe(false);
  });
});

describe('EventRouter approval-requested 最小防御解析（C3.2：原 zod safeParseApprovalRequest 内联）', () => {
  it('嵌套 request + parameters.command → onToolPendingApproval 收到归一 args', () => {
    const finish = vi.fn();
    const onPending = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    callbacks.onToolPendingApproval = onPending;
    router.onMsg({
      type: 'approval-requested',
      runId: 'run-test',
      request: {
        toolCallId: 'tc-ap',
        toolName: 'shell_command',
        parameters: { command: 'git push origin main' },
        summary: 'push branch',
      },
    });
    expect(onPending).toHaveBeenCalledTimes(1);
    expect(onPending.mock.calls[0][0]).toBe('tc-ap');
    expect(onPending.mock.calls[0][1]).toBe('shell_command');
    expect(onPending.mock.calls[0][2]).toBe('git push origin main');
    expect(onPending.mock.calls[0][3]).toBe('push branch');
  });

  it('平铺 daemon WS 形状（input 包）→ args 从 input.command 抽取', () => {
    const finish = vi.fn();
    const onPending = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    callbacks.onToolPendingApproval = onPending;
    router.onMsg({
      type: 'approval-requested',
      runId: 'run-test',
      toolCallId: 'tc-flat',
      toolName: 'shell_command',
      input: { command: 'rm -rf /tmp/x', cwd: '.' },
      summary: 'delete temp',
    });
    expect(onPending).toHaveBeenCalledTimes(1);
    expect(onPending.mock.calls[0][2]).toBe('rm -rf /tmp/x');
  });

  it('顶层 command 键与 args 兜底仍可用', () => {
    const finish = vi.fn();
    const onPending = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    callbacks.onToolPendingApproval = onPending;
    router.onMsg({
      type: 'approval-requested',
      runId: 'run-test',
      toolCallId: 'tc-top',
      toolName: 'shell_command',
      command: 'echo hello',
    });
    expect(onPending.mock.calls[0][2]).toBe('echo hello');
    onPending.mockClear();
    router.onMsg({
      type: 'approval-requested',
      runId: 'run-test',
      toolCallId: 'tc-args',
      toolName: 'shell_command',
      args: { command: 'cat file', cwd: '.' },
    });
    expect(onPending.mock.calls[0][2]).toBe('cat file');
  });

  it('缺 toolCallId → 记协议错误并跳过（不进入审批流）', () => {
    const finish = vi.fn();
    const onPending = vi.fn();
    const { router, callbacks, approvalFlow } = makeRouter(finish);
    callbacks.onToolPendingApproval = onPending;
    router.onMsg({
      type: 'approval-requested',
      runId: 'run-test',
      request: { toolName: 'shell_command' },
    });
    expect(onPending).not.toHaveBeenCalled();
    expect(approvalFlow.snapshot().flowStatus).toBe('idle');
  });

  it('toolName 缺失回退 command；explanation 回退 toolName', () => {
    const finish = vi.fn();
    const onPending = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    callbacks.onToolPendingApproval = onPending;
    router.onMsg({
      type: 'approval-requested',
      runId: 'run-test',
      toolCallId: 'tc-noname',
    });
    expect(onPending).toHaveBeenCalledTimes(1);
    expect(onPending.mock.calls[0][1]).toBe('command');
    expect(onPending.mock.calls[0][3]).toBe('command');
  });
});

describe('EventRouter run-terminal 最小防御解析（C3.2：原 zod safeParseRunTerminal 内联）', () => {
  it('terminal 拼写变体 canceled/error/大写 FAILED 均视为 failed', () => {
    // error 载荷用中性文案（避免 classifySoftFailure 命中 'error'/'failed' 词面）
    const payloads = ['boom-1', 'boom-2', 'boom-3'];
    for (const [i, terminal] of ['canceled', 'error', 'FAILED'].entries()) {
      const finish = vi.fn();
      const onRunError = vi.fn();
      const { router, callbacks } = makeRouter(finish);
      callbacks.onRunError = onRunError;
      router.onMsg({
        type: 'run-terminal',
        runId: 'run-test',
        terminal,
        error: payloads[i],
      });
      expect(onRunError).toHaveBeenCalledTimes(1);
      expect(onRunError.mock.calls[0][1]).toBe('run-terminal-failed');
      expect(finish).toHaveBeenCalledWith(true);
    }
  });

  it('run-failed 无 error 字段 → error 回退 message 字符串（surfaceStreamFailure 收到 message）', () => {
    const finish = vi.fn();
    const onRunError = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    callbacks.onRunError = onRunError;
    router.onMsg({
      type: 'run-failed',
      runId: 'run-test',
      message: 'nope',
    });
    expect(onRunError).toHaveBeenCalledTimes(1);
    // 诊断 detail 含回退的 message 原文；kind 走 scope 兜底
    expect(String(onRunError.mock.calls[0][2] ?? '')).toContain('nope');
    expect(onRunError.mock.calls[0][1]).toBe('run-failed');
    expect(finish).toHaveBeenCalledWith(true);
  });

  it('run-cancelled 携带 cancelled terminal → 不 surface 失败、finish(false)（L3 保留正文）', () => {
    const finish = vi.fn();
    const onRunError = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    callbacks.onRunError = onRunError;
    router.onMsg({
      type: 'run-cancelled',
      runId: 'run-test',
      terminal: 'cancelled',
    });
    expect(onRunError).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(false);
  });
});
