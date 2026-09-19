/**
 * 压缩与检查点域 handler（T7 分派表）：context-compression-start / end、
 * checkpoint-created / restored。
 *
 * 四者目前均无 UI 落地，保留显式空实现以保证分派表全键覆盖。
 */
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';
import { useSessionStore } from '../../../store/sessionStore';

export function onContextCompressionStart(
  env: HandlerEnv,
  _envelope: EngineEnvelope<'context-compression-start'>
): void {
  const sessionId = env.sessionId;
  if (!sessionId) return;
  useSessionStore.getState().addContextInjection(sessionId, {
    id: `context-compression-${sessionId}`,
    kind: 'memory',
    status: 'active',
    source: 'context_compression',
    title: '状态切换',
    content: '系统 · 上下文正在压缩...',
    timestamp: Date.now(),
    metadata: {
      mode: 'context-state',
      type: 'context_compression',
    },
  });
}

export function onContextCompressionEnd(
  env: HandlerEnv,
  envelope: EngineEnvelope<'context-compression-end'>
): void {
  const sessionId = env.sessionId;
  if (!sessionId) return;
  const rawResult = (
    envelope.event as {
      result?: { tokensBefore?: number; tokensAfter?: number };
    }
  )?.result;
  let summary = '系统 · 上下文压缩完成';
  if (
    rawResult &&
    typeof rawResult.tokensBefore === 'number' &&
    typeof rawResult.tokensAfter === 'number'
  ) {
    const saved = rawResult.tokensBefore - rawResult.tokensAfter;
    if (saved > 0) {
      summary = `系统 · 上下文压缩完成（节省 ${saved} tokens）`;
    }
  }
  useSessionStore.getState().addContextInjection(sessionId, {
    id: `context-compression-${sessionId}`,
    kind: 'memory',
    status: 'active',
    source: 'context_compression',
    title: '状态切换',
    content: summary,
    timestamp: Date.now(),
    metadata: {
      mode: 'context-state',
      type: 'context_compression',
    },
  });
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
