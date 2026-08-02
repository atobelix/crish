/**
 * 生命周期域 handler（T7 分派表）：agent-start / agent-end / turn-start /
 * turn-end / run-terminal。
 *
 * run-terminal 同时承接 run-completed / run-failed / run-cancelled 别名
 * （解析层归一为 run-terminal 信封，originalType 保留来源 type），
 * 失败收口语义与原 16 分支实现完全等价（含 run-cancelled 不 surface）。
 */
import { surfaceStreamFailure } from '../BridgeErrorPolicy';
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';

export function onAgentStart(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'agent-start'>
): void {
  // agent-start 暂无 UI 语义：显式空实现
}

export function onAgentEnd(
  env: HandlerEnv,
  envelope: EngineEnvelope<'agent-end'>
): void {
  const { state, approvalFlow, callbacks, runId, finish } = env;
  const { event, raw } = envelope;
  if (approvalFlow.hasPending()) {
    approvalFlow.dispatch({ type: 'defer_terminal' });
    return;
  }
  const reason = event.reason;
  if (reason === 'error') {
    surfaceStreamFailure(
      event.error ?? raw,
      'agent-end-error',
      callbacks,
      runId
    );
    finish(true);
    return;
  }
  // L2 stop / L3 aborted / max-turns / stopped：立即收口，isProcessing 及时清除
  if (
    reason === 'stop' ||
    reason === 'aborted' ||
    reason === 'max-turns' ||
    reason === 'stopped'
  ) {
    approvalFlow.dispatch({ type: 'clear_all' });
    finish(false);
    return;
  }
  if (approvalFlow.snapshot().sawRunTerminal) {
    finish(false);
    return;
  }
  if (state.endTimer) clearTimeout(state.endTimer);
  state.endTimer = setTimeout(() => {
    if (!state.cancelled && !state.finished) finish(false);
  }, 8000);
}

export function onTurnStart(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'turn-start'>
): void {
  // turn-start 暂无 UI 语义：显式空实现
}

export function onTurnEnd(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'turn-end'>
): void {
  // turn-end 暂无 UI 语义：显式空实现
}

export function onRunTerminal(
  env: HandlerEnv,
  envelope: EngineEnvelope<'run-terminal'>
): void {
  const { approvalFlow, callbacks, runId, finish } = env;
  const { event, raw } = envelope;
  const sourceType = envelope.originalType;
  const terminal = event.terminal;
  const failed =
    sourceType === 'run-failed' ||
    sourceType === 'run-cancelled' ||
    terminal === 'failed' ||
    terminal === 'cancelled';
  if (failed && sourceType !== 'run-cancelled') {
    // L3 cancel: keep partial assistant text; do not surface as stream failure toast
    const errPayload = event.error ?? raw.error ?? raw.message ?? raw;
    surfaceStreamFailure(
      errPayload ?? raw,
      sourceType === 'run-failed' ? 'run-failed' : 'run-terminal-failed',
      callbacks,
      runId
    );
  }
  approvalFlow.dispatch({ type: 'run_terminal_seen' });
  if (approvalFlow.hasPending() && !failed) {
    approvalFlow.dispatch({ type: 'defer_terminal' });
    return;
  }
  approvalFlow.dispatch({ type: 'clear_all' });
  // run-cancelled / failed both close the stream; failed only for true errors
  finish(failed && sourceType !== 'run-cancelled');
}
