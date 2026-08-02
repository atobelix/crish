/**
 * 压缩与检查点域 handler（T7 分派表）：context-compression-start / end、
 * checkpoint-created / restored。
 *
 * 四者目前均无 UI 落地，保留显式空实现以保证分派表全键覆盖。
 */
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';

export function onContextCompressionStart(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'context-compression-start'>
): void {
  // context-compression-start 暂无 UI 落地：显式空实现
}

export function onContextCompressionEnd(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'context-compression-end'>
): void {
  // context-compression-end 暂无 UI 落地：显式空实现
}

export function onCheckpointCreated(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'checkpoint-created'>
): void {
  // checkpoint-created 暂无 UI 落地：显式空实现
}

export function onCheckpointRestored(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'checkpoint-restored'>
): void {
  // checkpoint-restored 暂无 UI 落地：显式空实现
}
