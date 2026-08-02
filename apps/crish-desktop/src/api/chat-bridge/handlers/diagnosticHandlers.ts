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

export function onProviderDiagnostic(
  env: HandlerEnv,
  envelope: EngineEnvelope<'provider-diagnostic'>
): void {
  logInternalError('provider-diagnostic', envelope.event.diagnostic ?? envelope.raw.data);
}

export function onRuntimeError(
  env: HandlerEnv,
  envelope: EngineEnvelope<'runtime-error'>
): void {
  const { event, raw } = envelope;
  surfaceStreamFailure(event.error ?? raw.data, 'runtime-error', env.callbacks, env.runId);
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
