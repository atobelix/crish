/**
 * 协作子 agent 与信封级错误 handler（T7 分派表）。
 *
 * subagent-started / subagent-event / subagent-ended 为信封级遗留事件
 * （不在生成引擎事件联合中），经 legacy 信封直出；
 * error 为 Rust 侧事件通道顶层失败信封，四源失败收敛之一。
 */
import { surfaceStreamFailure } from '../BridgeErrorPolicy';
import type { LegacyEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';

export function onSubagentStarted(
  env: HandlerEnv,
  envelope: LegacyEnvelope
): void {
  const msg = envelope.raw;
  env.callbacks.onSubagentStarted?.({
    subagentId: String(msg.subagentId ?? ''),
    subagentRunId: String(msg.subagentRunId ?? ''),
    parentRunId: String(msg.runId ?? env.runId),
    parentToolCallId: msg.parentToolCallId
      ? String(msg.parentToolCallId)
      : undefined,
    description: String(msg.description ?? '协作 agent'),
    mode: String(msg.mode ?? 'research'),
  });
}

export function onSubagentEvent(
  env: HandlerEnv,
  envelope: LegacyEnvelope
): void {
  const msg = envelope.raw;
  const ev =
    msg.event && typeof msg.event === 'object' && !Array.isArray(msg.event)
      ? (msg.event as Record<string, unknown>)
      : {};
  env.callbacks.onSubagentEvent?.({
    subagentId: String(msg.subagentId ?? ''),
    subagentRunId: String(msg.subagentRunId ?? ''),
    event: ev,
  });
}

export function onSubagentEnded(
  env: HandlerEnv,
  envelope: LegacyEnvelope
): void {
  const msg = envelope.raw;
  const raw = String(msg.status ?? '').toLowerCase();
  const st: 'completed' | 'failed' | 'stopped' =
    /cancel|stopp?ed|abort/i.test(raw)
      ? 'stopped'
      : /fail|error/i.test(raw)
        ? 'failed'
        : 'completed';
  env.callbacks.onSubagentEnded?.({
    subagentId: String(msg.subagentId ?? ''),
    subagentRunId: String(msg.subagentRunId ?? ''),
    status: st,
    summary: msg.summary ? String(msg.summary) : undefined,
  });
}

export function onError(env: HandlerEnv, envelope: LegacyEnvelope): void {
  const msg = envelope.raw;
  surfaceStreamFailure(
    msg.message ?? msg.error ?? msg,
    'engine-error',
    env.callbacks,
    env.runId
  );
  env.approvalFlow.dispatch({ type: 'clear_all' });
  env.finish(true);
}
