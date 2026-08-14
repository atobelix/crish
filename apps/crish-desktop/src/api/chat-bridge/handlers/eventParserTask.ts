/**
 * 任务与调度事件宽容归一器（Task / Timer / Cron）。
 */
import type {
  EngineTaskStartedEvent,
  EngineTaskOutputEvent,
  EngineTaskHeartbeatEvent,
  EngineTaskSuspiciousEvent,
  EngineTaskCompletedEvent,
  EngineTaskFailedEvent,
  EngineTaskKilledEvent,
  EngineTimerFiredEvent,
  EngineTimerCancelledEvent,
  EngineCronFiredEvent,
} from '../../../../../../packages/shared-types/src/generated/engine';
import {
  alt,
  normalizeResource,
  num,
  str,
  tailArray,
  withEnvelopeRunId,
  type Normalizer,
} from './eventParserShared';

export const TASK_NORMALIZERS: Record<string, Normalizer> = {
  'task-started': (raw): EngineTaskStartedEvent =>
    withEnvelopeRunId(
      {
        type: 'task-started',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        taskId: str(alt(raw, 'taskId', 'task_id')),
        command: str(raw.command),
        cwd: str(raw.cwd),
        ownerRunId: str(alt(raw, 'ownerRunId', 'owner_run_id')),
        isDaemon: alt(raw, 'isDaemon', 'is_daemon') === true,
      },
      raw
    ),
  'task-output': (raw): EngineTaskOutputEvent => {
    const event: EngineTaskOutputEvent = {
      type: 'task-output',
      sessionId: str(alt(raw, 'sessionId', 'session_id')),
      taskId: str(alt(raw, 'taskId', 'task_id')),
    };
    const line = str(raw.line);
    if (line) event.line = line;
    const chunk = str(raw.chunk);
    if (chunk) event.chunk = chunk;
    const lineCount = num(alt(raw, 'lineCount', 'line_count'));
    if (lineCount !== undefined) event.lineCount = lineCount;
    return withEnvelopeRunId(event, raw);
  },
  'task-heartbeat': (raw): EngineTaskHeartbeatEvent =>
    withEnvelopeRunId(
      {
        type: 'task-heartbeat',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        taskId: str(alt(raw, 'taskId', 'task_id')),
        resource: normalizeResource(raw.resource),
      },
      raw
    ),
  'task-suspicious': (raw): EngineTaskSuspiciousEvent =>
    withEnvelopeRunId(
      {
        type: 'task-suspicious',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        taskId: str(alt(raw, 'taskId', 'task_id')),
        silenceMs: num(alt(raw, 'silenceMs', 'silence_ms')) ?? 0,
        lastOutputAtMs:
          num(alt(raw, 'lastOutputAtMs', 'last_output_at_ms')) ?? 0,
      },
      raw
    ),
  'task-completed': (raw): EngineTaskCompletedEvent =>
    withEnvelopeRunId(
      {
        type: 'task-completed',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        taskId: str(alt(raw, 'taskId', 'task_id')),
        exitCode: num(alt(raw, 'exitCode', 'exit_code')) ?? 0,
        durationMs: num(alt(raw, 'durationMs', 'duration_ms')) ?? 0,
        lineCount: num(alt(raw, 'lineCount', 'line_count')) ?? 0,
      },
      raw
    ),
  'task-failed': (raw): EngineTaskFailedEvent =>
    withEnvelopeRunId(
      {
        type: 'task-failed',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        taskId: str(alt(raw, 'taskId', 'task_id')),
        exitCode: num(alt(raw, 'exitCode', 'exit_code')) ?? 0,
        tail: tailArray(raw.tail),
        durationMs: num(alt(raw, 'durationMs', 'duration_ms')) ?? 0,
      },
      raw
    ),
  'task-killed': (raw): EngineTaskKilledEvent => {
    const event: EngineTaskKilledEvent = {
      type: 'task-killed',
      sessionId: str(alt(raw, 'sessionId', 'session_id')),
      taskId: str(alt(raw, 'taskId', 'task_id')),
      viaForce: alt(raw, 'viaForce', 'via_force') === true,
    };
    const diagnostics = str(raw.diagnostics);
    if (diagnostics) event.diagnostics = diagnostics;
    return withEnvelopeRunId(event, raw);
  },
  'timer-fired': (raw): EngineTimerFiredEvent =>
    withEnvelopeRunId(
      {
        type: 'timer-fired',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        timerId: str(alt(raw, 'timerId', 'timer_id')),
        prompt: str(raw.prompt),
        firedAtMs: num(alt(raw, 'firedAtMs', 'fired_at_ms')) ?? 0,
      },
      raw
    ),
  'timer-cancelled': (raw): EngineTimerCancelledEvent =>
    withEnvelopeRunId(
      {
        type: 'timer-cancelled',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        timerId: str(alt(raw, 'timerId', 'timer_id')),
        reason: str(raw.reason),
        cancelledAtMs: num(alt(raw, 'cancelledAtMs', 'cancelled_at_ms')) ?? 0,
      },
      raw
    ),
  'cron-fired': (raw): EngineCronFiredEvent =>
    withEnvelopeRunId(
      {
        type: 'cron-fired',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        cronId: str(alt(raw, 'cronId', 'cron_id')),
        prompt: str(raw.prompt),
        expression: str(raw.expression),
        iteration: num(raw.iteration) ?? 0,
        firedAtMs: num(alt(raw, 'firedAtMs', 'fired_at_ms')) ?? 0,
      },
      raw
    ),
};
