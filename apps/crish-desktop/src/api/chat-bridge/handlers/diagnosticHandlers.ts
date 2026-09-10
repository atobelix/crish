/**
 * 诊断域 handler（T7 分派表）：provider-diagnostic / runtime-error /
 * runtime-steering / runtime-intervention-required。
 *
 * runtime-error 优先用生成载荷的 error 字段，兼容旧形态的顶层 data 字段。
 */
import { surfaceStreamFailure } from '../BridgeErrorPolicy';
import { logInternalError } from '../../userFacingErrors';
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';
import { useContinuityUiStore } from '../../continuity/continuityUiStore';
import { useEphemeralChatStore } from '../../../store/ephemeralChatStore';

export function onProviderDiagnostic(
  _env: HandlerEnv,
  envelope: EngineEnvelope<'provider-diagnostic'>
): void {
  const diag =
    envelope.event.diagnostic ??
    (envelope.raw.data as typeof envelope.event.diagnostic);
  logInternalError('provider-diagnostic', diag);

  const sessionId = String(
    envelope.event.sessionId ?? envelope.raw.sessionId ?? ''
  ).trim();
  if (!sessionId || !diag) return;

  if (diag.phase === 'retry') {
    const attempt =
      typeof diag.attempt === 'number' ? diag.attempt : Number(diag.attempt);
    if (Number.isFinite(attempt) && attempt > 0) {
      const maxAttempts =
        typeof diag.maxAttempts === 'number' ? diag.maxAttempts : undefined;
      useContinuityUiStore
        .getState()
        .applyRetryNotice(sessionId, attempt, maxAttempts);

      const rawDelay = (diag as unknown as Record<string, unknown> | undefined)?.delayMs;
      const delayMs = typeof rawDelay === 'number' ? rawDelay : 3000;
      useEphemeralChatStore.getState().updateRetryProgress(sessionId, {
        attempt,
        maxAttempts: maxAttempts ?? 3,
        nextRetryTimestamp: Date.now() + delayMs,
        backoffMs: delayMs,
        reasonText: (diag as { message?: string })?.message || '网络连接抖动，正在自动重试',
        rawDiagnostic: diag,
      });
    }
  }
}

export function onRuntimeError(
  env: HandlerEnv,
  envelope: EngineEnvelope<'runtime-error'>
): void {
  const { event, raw } = envelope;
  surfaceStreamFailure(
    event.error ?? raw.data,
    'runtime-error',
    env.callbacks,
    env.runId
  );
}

export function onRuntimeSteering(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'runtime-steering'>
): void {
  // runtime-steering 暂无 UI 落地：显式空实现
}

export function onRuntimeInterventionRequired(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'runtime-intervention-required'>
): void {
  // runtime-intervention-required 暂无 UI 落地：显式空实现
}
