import {
  SessionStreamManager,
  type SessionStreamHandle,
  type StreamStarter,
  type StreamCancelFn,
  type StreamCancelMode,
} from '../../api/sessionStreamManager';
import type { StreamRenderBuffer } from '../../api/StreamRenderBuffer';

export {
  SessionStreamManager,
  type SessionStreamHandle,
  type StreamStarter,
  type StreamCancelFn,
  type StreamCancelMode,
};

/**
 * 窗口内共享的多会话流式管理器单例。
 * SessionStreamManager 内部以 Map<sessionId, ActiveStream> 维护各会话并发流，
 * 共享单例确保多分屏各自挂载 ChatCard 时按 sessionId 精确查询、启动与中止对应会话流。
 */
export const sharedSessionStreamManager = new SessionStreamManager();

/**
 * 按 sessionId 索引的流式渲染缓冲表（Guard-2）。
 * 确保停止或完成指定 sessionId 的流时，仅冲刷（flushImmediate + destroy）该会话自身的
 * StreamRenderBuffer，绝不误冲或销毁其他并发流式分屏的缓冲区。
 */
const sessionRenderBuffers = new Map<string, StreamRenderBuffer>();

export function registerSessionRenderBuffer(
  sessionId: string,
  buffer: StreamRenderBuffer
): void {
  if (!sessionId) return;
  sessionRenderBuffers.set(sessionId, buffer);
}

export function getSessionRenderBuffer(
  sessionId: string | null | undefined
): StreamRenderBuffer | null {
  if (!sessionId) return null;
  return sessionRenderBuffers.get(sessionId) ?? null;
}

export function flushAndRemoveSessionRenderBuffer(
  sessionId: string | null | undefined,
  expectedBuffer?: StreamRenderBuffer | null
): void {
  if (!sessionId) return;
  const current = sessionRenderBuffers.get(sessionId);
  if (!current) return;
  if (expectedBuffer && current !== expectedBuffer) return;
  sessionRenderBuffers.delete(sessionId);
  current.flushFinal();
}

export function abortSessionRenderBuffer(sessionId: string): void {
  if (!sessionId) return;
  const current = sessionRenderBuffers.get(sessionId);
  if (current) {
    sessionRenderBuffers.delete(sessionId);
    current.reset();
  }
}

export function clearSessionRenderBuffers(): void {
  for (const [, buf] of sessionRenderBuffers) {
    buf?.stop?.();
  }
  sessionRenderBuffers.clear();
}
