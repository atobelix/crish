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
import { reportRuntimeStatus } from '../../../store/sessionRuntimeStatusStore';

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

  if (diag.phase !== 'retry') return;

  const attempt =
    typeof diag.attempt === 'number' ? diag.attempt : Number(diag.attempt);
  if (!Number.isFinite(attempt) || attempt <= 0) return;

  const maxAttempts =
    typeof diag.maxAttempts === 'number' && diag.maxAttempts > 0
      ? diag.maxAttempts
      : undefined;
  const errorKind =
    typeof diag.errorKind === 'string' && diag.errorKind
      ? diag.errorKind
      : undefined;

  // 单轨收敛（docs/chat-notice-convergence §2.0）：唯一上报入口，只投影 retrying 相位。
  // 引擎 ProviderDiagnostic 的 reason 是分类 Debug 字串、且不下发倒计时——两者都不进 UI 文案。
  reportRuntimeStatus({
    type: 'retrying',
    sessionId,
    retry: { attempt, maxAttempts, errorKind },
  });
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
