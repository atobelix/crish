/**
 * streamingStore 命令式辅助函数（callbacks / batchers；无 React）。
 *
 * 从 streamingStore.ts 拆出（T4-11 基线清零）：纯转发封装，调用方经
 * `streamingStore.ts` re-export 取用，import 路径不变。
 */

import { useStreamingStore } from './streamingStore';
import type {
  StreamToolLive,
  StreamEntry,
} from './streamingStore';

/** 设置流式文本（命令式）。 */
export function setStreamText(
  sessionId: string,
  messageId: string,
  text: string
): void {
  useStreamingStore.getState().setStreamText(sessionId, messageId, text);
}

/** 设置流式思维（命令式）。 */
export function setStreamThinking(
  sessionId: string,
  messageId: string,
  thinking: string
): void {
  useStreamingStore
    .getState()
    .setStreamThinking(sessionId, messageId, thinking);
}

/** 设置流式工具行 patch（命令式）。 */
export function setStreamTool(
  sessionId: string,
  messageId: string,
  toolId: string,
  patch: StreamToolLive
): void {
  useStreamingStore
    .getState()
    .setStreamTool(sessionId, messageId, toolId, patch);
}

/** 清除单个流式工具行（命令式）。 */
export function clearStreamTool(
  sessionId: string,
  messageId: string,
  toolId: string
): void {
  useStreamingStore.getState().clearStreamTool(sessionId, messageId, toolId);
}

/** 清除某消息全部流式工具行（命令式）。 */
export function clearStreamTools(sessionId: string, messageId: string): void {
  useStreamingStore.getState().clearStreamTools(sessionId, messageId);
}

/** 清除单条流式缓冲（命令式）。 */
export function clearStream(sessionId: string, messageId: string): void {
  useStreamingStore.getState().clearStream(sessionId, messageId);
}

/** 批量清除多条流式缓冲（命令式）。 */
export function clearStreams(sessionId: string, messageIds: string[]): void {
  useStreamingStore.getState().clearStreams(sessionId, messageIds);
}

/** 清除某会话全部流式缓冲（命令式）。 */
export function clearSessionStreams(sessionId: string): void {
  useStreamingStore.getState().clearSession(sessionId);
}

/** 读取流式文本（命令式）。 */
export function getStreamText(
  sessionId: string,
  messageId: string
): string | undefined {
  return useStreamingStore.getState().getStreamText(sessionId, messageId);
}

/** 读取流式思维（命令式）。 */
export function getStreamThinking(
  sessionId: string,
  messageId: string
): string | undefined {
  return useStreamingStore.getState().getStreamThinking(sessionId, messageId);
}

/** 读取流式工具行集合（命令式）。 */
export function getStreamTools(
  sessionId: string,
  messageId: string
): Record<string, StreamToolLive> | undefined {
  return useStreamingStore.getState().getStreamTools(sessionId, messageId);
}

/** 读取单条流式工具行（命令式）。 */
export function getStreamTool(
  sessionId: string,
  messageId: string,
  toolId: string
): StreamToolLive | undefined {
  return useStreamingStore
    .getState()
    .getStreamTool(sessionId, messageId, toolId);
}

/** 读取整条流式缓冲条目（命令式）。 */
export function getStreamEntry(
  sessionId: string,
  messageId: string
): StreamEntry | undefined {
  return useStreamingStore.getState().getStreamEntry(sessionId, messageId);
}
