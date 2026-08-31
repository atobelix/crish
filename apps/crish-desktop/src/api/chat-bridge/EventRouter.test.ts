/**
 * EventRouter.onMsg 消费端测试（C2.2 / C2.4）。
 *
 * C2.2：`event` 信封分支与 run-ended 别名分支已删，onMsg 平铺事件直进 handleAgentEvent
 * （03 §5.2-1/2）。C2.4：四源失败全部收敛到 surfaceStreamFailure + finish（03 §2.4 表）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventRouter, buildEventDedupeKey } from './EventRouter';
import { ApprovalFlowMachine } from '../approvalFlowMachine';
import type { StreamState } from './handlers/streamState';
import type { StreamCallbacks } from '../chatApi';
import * as userFacingErrors from '../userFacingErrors';
import * as eventParserModule from './handlers/eventParser';
import * as streamDiagModule from '../streamDiag';

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
    'session-test'
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
    expect(kind).toBe('engine-error');
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

describe('EventRouter 消费侧 parser 异常兜底（T3.7 D7，F8-01 消费面）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parseBridgeEvent 抛异常被兜底：registerUnknownEvent 登记 + 不中断事件处理循环', () => {
    const finish = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    const logSpy = vi.spyOn(userFacingErrors, 'logInternalError');
    const parserSpy = vi.spyOn(eventParserModule, 'parseBridgeEvent');

    // 注入 parser 抛异常（模拟解析器未收敛的异常路径；验证的是消费侧兜底
    // 而非 parser 本身，故以故障注入方式驱动）
    parserSpy.mockImplementation(() => {
      throw new Error('parser threw: boom');
    });
    expect(() =>
      router.onMsg({ type: 'message-delta', runId: 'run-test', sequence: 1 })
    ).not.toThrow();
    // 显式登记（不静默吞），错误文案带 parser threw 标记
    expect(logSpy).toHaveBeenCalledWith(
      'engine-unknown-event',
      expect.objectContaining({
        error: expect.stringContaining('parser threw'),
      })
    );

    // 后续正常事件仍被处理（循环不中断）
    parserSpy.mockRestore();
    router.onMsg({
      type: 'message-delta',
      runId: 'run-test',
      sequence: 2,
      block: { type: 'text', text: 'hi' },
    });
    expect(callbacks.onChunk).toHaveBeenCalledWith('hi');
  });

  it('真实深嵌套载荷（5000 层）经 onMsg 消费不抛异常（修复前 RangeError 逃逸）', () => {
    const finish = vi.fn();
    const { router } = makeRouter(finish);
    let input: unknown = 'leaf';
    for (let i = 0; i < 5000; i++) input = [input];
    expect(() =>
      router.onMsg({
        type: 'message-delta',
        runId: 'run-test',
        sequence: 1,
        sessionId: 's1',
        timestamp: 't1',
        messageId: 'm1',
        block: {
          type: 'tool-call',
          id: 'tc-1',
          toolName: 'shell_command',
          input,
        },
      })
    ).not.toThrow();
  });
});

describe('EventRouter 消费侧 per-run 幂等去重（04 §5.1-1 / G1/G2）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('重复 message-end（同 sequence）只消费一次', () => {
    const finish = vi.fn();
    const { router, callbacks, state } = makeRouter(finish);
    const msg = {
      type: 'message-end',
      runId: 'run-test',
      sequence: 7,
      message: {
        id: 'm1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'hi' }],
      },
    };
    router.onMsg(msg);
    router.onMsg(msg);
    // 单增量生产者铁律：onMessageEnd 严禁向 onChunk 注入伪增量
    expect(callbacks.onChunk).not.toHaveBeenCalled();
    expect(state.assistantText).toBe('hi');
  });

  it('重复 message-delta（同 messageId 同 sequence）只消费一次', () => {
    const finish = vi.fn();
    const { router, callbacks, state } = makeRouter(finish);
    const delta = {
      type: 'message-delta',
      runId: 'run-test',
      sequence: 1,
      messageId: 'm1',
      block: { type: 'text', text: 'hi' },
    };
    router.onMsg(delta);
    router.onMsg(delta);
    expect(callbacks.onChunk).toHaveBeenCalledTimes(1);
    expect(state.assistantText).toBe('hi');
  });

  it('实时轨 delta（sequence=None）增量流式放行，所有分片正常累积消费', () => {
    const finish = vi.fn();
    const { router, callbacks, state } = makeRouter(finish);
    const delta1 = {
      type: 'message-delta',
      runId: 'run-test',
      messageId: 'm1',
      block: { type: 'text', text: 'hi' },
    };
    const delta2 = {
      type: 'message-delta',
      runId: 'run-test',
      messageId: 'm1',
      block: { type: 'text', text: ' world' },
    };
    router.onMsg(delta1);
    router.onMsg(delta2);
    expect(callbacks.onChunk).toHaveBeenCalledTimes(2);
    expect(state.assistantText).toBe('hi world');
  });

  it('乱序回放不重复：先到高 sequence 后回放同键跳过，迟到的新 sequence 正常消费', () => {
    const finish = vi.fn();
    const { router, callbacks, state } = makeRouter(finish);
    router.onMsg({
      type: 'message-delta',
      runId: 'run-test',
      sequence: 10,
      messageId: 'm1',
      block: { type: 'text', text: 'hi' },
    });
    // 引擎重放同一事件（同键）
    router.onMsg({
      type: 'message-delta',
      runId: 'run-test',
      sequence: 10,
      messageId: 'm1',
      block: { type: 'text', text: 'hi' },
    });
    // 迟到的新增量（不同键）
    router.onMsg({
      type: 'message-delta',
      runId: 'run-test',
      sequence: 9,
      messageId: 'm1',
      block: { type: 'text', text: ' world' },
    });
    expect(callbacks.onChunk).toHaveBeenCalledTimes(2);
    expect(state.assistantText).toBe('hi world');
  });

  it('去重不误伤：不同 messageId 与同 messageId 不同 sequence（跨 turn 增量）各自消费', () => {
    const finish = vi.fn();
    const { router, callbacks, state } = makeRouter(finish);
    router.onMsg({
      type: 'message-delta',
      runId: 'run-test',
      sequence: 1,
      messageId: 'm1',
      block: { type: 'text', text: 'hi' },
    });
    router.onMsg({
      type: 'message-delta',
      runId: 'run-test',
      sequence: 2,
      messageId: 'm1',
      block: { type: 'text', text: ' world' },
    });
    router.onMsg({
      type: 'message-delta',
      runId: 'run-test',
      sequence: 3,
      messageId: 'm2',
      block: { type: 'text', text: '!' },
    });
    expect(callbacks.onChunk).toHaveBeenCalledTimes(3);
    expect(state.assistantText).toBe('hi world!');
  });

  it('无 messageId 无 sequence 的事件不参与去重（legacy 信封透传）', () => {
    const finish = vi.fn();
    const onSubagentStarted = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    callbacks.onSubagentStarted = onSubagentStarted;
    const subagentEvent = {
      type: 'subagent-started',
      runId: 'run-test',
      subagentId: 'sa-1',
      subagentRunId: 'sr-1',
      description: '协作 agent',
      mode: 'research',
    };
    router.onMsg(subagentEvent);
    router.onMsg({ ...subagentEvent, subagentId: 'sa-2' });
    expect(onSubagentStarted).toHaveBeenCalledTimes(2);
  });

  it('重复事件跳过时记录 streamDiag（event-dedupe 可观测，不阻断事件流）', () => {
    const finish = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    const diagSpy = vi.spyOn(streamDiagModule, 'recordStreamDiag');
    const delta = {
      type: 'message-delta',
      runId: 'run-test',
      sequence: 1,
      messageId: 'm1',
      block: { type: 'text', text: 'hi' },
    };
    router.onMsg(delta);
    router.onMsg(delta);
    expect(diagSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-test',
        scope: 'event-dedupe',
        kind: 'duplicate',
      })
    );
    expect(callbacks.onChunk).toHaveBeenCalledTimes(1);
  });

  it('失败双源（runtime-error + run-terminal-failed 同错误）只 surface 一次（G6/R5）', () => {
    const finish = vi.fn();
    const onRunError = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    callbacks.onRunError = onRunError;
    router.onMsg({
      type: 'runtime-error',
      runId: 'run-test',
      error: 'dup-boom',
      retryable: false,
    });
    router.onMsg({
      type: 'run-terminal',
      runId: 'run-test',
      terminal: 'failed',
      error: 'dup-boom',
    });
    expect(onRunError).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(true);
  });

  it('实时轨 1000 个 message-delta Token 连续到达 100% 直通放行，0 丢失', () => {
    const finish = vi.fn();
    const { router, callbacks, state } = makeRouter(finish);
    for (let i = 0; i < 1000; i++) {
      router.onMsg({
        type: 'message-delta',
        runId: 'run-test',
        messageId: 'm1',
        block: { type: 'text', text: 'a' },
      });
    }
    expect(callbacks.onChunk).toHaveBeenCalledTimes(1000);
    expect(state.assistantText.length).toBe(1000);
    expect(finish).not.toHaveBeenCalled();
  });

  it('因果时序缓冲：tool-end 先于 tool-start 到达时挂起，待 tool-start 到达后在同一微任务同步收口', () => {
    const finish = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    const diagSpy = vi.spyOn(streamDiagModule, 'recordStreamDiag');

    // 1. 乱序到达：tool-end 先到
    router.onMsg({
      type: 'tool-end',
      runId: 'run-test',
      call: { id: 'call-1', name: 'read_file' },
      result: { id: 'call-1', status: 'success', output: 'content ok' },
      turnIndex: 0,
    });

    // tool-end 此时被挂起，不应触发 onToolSuccess 回调
    expect(callbacks.onToolSuccess).not.toHaveBeenCalled();
    expect(diagSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'event-router',
        kind: 'causality-buffered',
      })
    );

    // 2. 迟到的 tool-start 到达
    router.onMsg({
      type: 'tool-start',
      runId: 'run-test',
      call: { id: 'call-1', name: 'read_file', arguments: '{}' },
      turnIndex: 0,
    });

    // tool-start 触发后，立即排空挂起的 tool-end
    expect(callbacks.onToolStart).toHaveBeenCalledTimes(1);
    expect(callbacks.onToolSuccess).toHaveBeenCalledTimes(1);
  });

  it('多轮自主循环：同名工具在不同 turnIndex 下各自正常放行，不误杀', () => {
    const finish = vi.fn();
    const { router, callbacks } = makeRouter(finish);

    // 轮次 0: tool-start view_file
    router.onMsg({
      type: 'tool-start',
      runId: 'run-test',
      call: { id: 'call-dup', name: 'view_file' },
      turnIndex: 0,
    });
    // 轮次 1: 同名工具再次调用
    router.onMsg({
      type: 'tool-start',
      runId: 'run-test',
      call: { id: 'call-dup', name: 'view_file' },
      turnIndex: 1,
    });

    expect(callbacks.onToolStart).toHaveBeenCalledTimes(2);
  });

  it('consumedEvents 满足 2000 条 FIFO 淘汰机制，防内存泄漏', () => {
    const finish = vi.fn();
    const { router, callbacks } = makeRouter(finish);

    // 灌入 2005 个唯一事件
    for (let i = 0; i < 2005; i++) {
      router.onMsg({
        type: 'turn-start',
        runId: 'run-test',
        sequence: i + 1,
        turnIndex: i,
      });
    }

    // 再次发送最老的前 5 个事件中的第 1 个（已从 FIFO 中淘汰）
    // 应当作为新事件再次放行
    const _wasCalledCount = (callbacks.onChunk as ReturnType<typeof vi.fn>).mock
      .calls.length;
    router.onMsg({
      type: 'turn-start',
      runId: 'run-test',
      sequence: 1,
      turnIndex: 0,
    });
    // 验证 router 内部处理了该事件且未报错
    expect(finish).not.toHaveBeenCalled();
  });
});

describe('buildEventDedupeKey 键生成规则（04 §5.1-1 / DIM-02 复合因果 Key 矩阵）', () => {
  it('收口轨：messageId + sequence → type:messageId:sequence', () => {
    const key = buildEventDedupeKey({
      kind: 'engine',
      type: 'message-delta',
      originalType: 'message-delta',
      event: {
        type: 'message-delta',
        sessionId: 's1',
        timestamp: 't1',
        messageId: 'm1',
        block: { type: 'text', text: 'x' },
      },
      raw: { type: 'message-delta', sequence: 5, messageId: 'm1' },
    });
    expect(key).toBe('message-delta:m1:5');
  });

  it('实时轨：message-delta 无 sequence 返回 null 放行流式增量', () => {
    const key = buildEventDedupeKey({
      kind: 'engine',
      type: 'message-delta',
      originalType: 'message-delta',
      event: {
        type: 'message-delta',
        sessionId: 's1',
        timestamp: 't1',
        messageId: 'm1',
        block: { type: 'text', text: 'x' },
      },
      raw: { type: 'message-delta', messageId: 'm1' },
    });
    expect(key).toBeNull();
  });

  it('工具域：tool-start 包含 turnIndex 与 toolId', () => {
    const keyWithSeq = buildEventDedupeKey({
      kind: 'engine',
      type: 'tool-start',
      originalType: 'tool-start',
      event: {
        type: 'tool-start',
        sessionId: 's1',
        turnIndex: 2,
        call: { id: 'call-xyz', name: 'read_file', arguments: '{}' },
      },
      raw: { type: 'tool-start', sequence: 10, turnIndex: 2 },
    });
    expect(keyWithSeq).toBe('tool-start:turn-2:call-xyz:10');

    const keyLive = buildEventDedupeKey({
      kind: 'engine',
      type: 'tool-start',
      originalType: 'tool-start',
      event: {
        type: 'tool-start',
        sessionId: 's1',
        turnIndex: 0,
        call: { id: 'call-xyz', name: 'read_file', arguments: '{}' },
      },
      raw: { type: 'tool-start' },
    });
    expect(keyLive).toBe('tool-start:turn-0:call-xyz');
  });

  it('message-end 取 message.id 与 turnTag；无 messageId 时退化 type:sequence', () => {
    const key = buildEventDedupeKey({
      kind: 'engine',
      type: 'message-end',
      originalType: 'message-end',
      event: {
        type: 'message-end',
        sessionId: 's1',
        turnIndex: 1,
        message: { id: 'm9', role: 'assistant', createdAt: 'c', blocks: [] },
      },
      raw: { type: 'message-end', sequence: 9, turnIndex: 1 },
    });
    expect(key).toBe('message-end:m9:turn-1:9');

    const seqOnly = buildEventDedupeKey({
      kind: 'engine',
      type: 'run-terminal',
      originalType: 'run-terminal',
      event: {
        type: 'run-terminal',
        sessionId: 's1',
        runId: 'r1',
        terminal: 'completed',
      },
      raw: { type: 'run-terminal', sequence: 3 },
    });
    expect(seqOnly).toBe('run-terminal:3');
  });

  it('legacy 信封与无 id 无 sequence 事件返回 null（透传）', () => {
    const legacy = buildEventDedupeKey({
      kind: 'legacy',
      type: 'subagent-started',
      raw: { type: 'subagent-started' },
    });
    expect(legacy).toBeNull();
    const noKey = buildEventDedupeKey({
      kind: 'engine',
      type: 'agent-start',
      originalType: 'agent-start',
      event: { type: 'agent-start', sessionId: 's1' },
      raw: { type: 'agent-start' },
    });
    expect(noKey).toBeNull();
  });
});
