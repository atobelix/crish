/**
 * hooks/chat-stream 公共入口：主对话流式门面与其对外类型。
 * 实现唯一在 ./useChatStream.ts；本文件不承载逻辑。
 */
export { useChatStream } from './useChatStream';
export type { SendWhileRunningAction } from './streamRunState';
export type {
  ChatAttachment,
  QueuedMessage,
  UseChatStreamOptions,
  UseChatStreamResult,
  TerminalToolReason,
  TerminalToolPatch,
} from './types';
