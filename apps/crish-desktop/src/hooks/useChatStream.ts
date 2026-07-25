/**
 * useChatStream.ts - Pure Facade Hook & Re-exports
 *
 * 拆分后的主门面/组装 Hook。领域具体逻辑已拆分移至 `./chat-stream/` 目录：
 * - `./chat-stream/helpers.ts`: 纯工具函数（session id 解析、stream 状态防护、terminal tool patches 等）
 * - `./chat-stream/multimodal.ts`: 附件解析与多模态 content parts 构建
 * - `./chat-stream/useStreamBatchers.ts`: rAF 渲染缓冲区与 48ms 高频批处理器管理
 * - `./chat-stream/useGoalMode.ts`: /goal 目标模式续写与排队消息 drain
 * - `./chat-stream/useStreamCallbacks.ts`: 流式 SSE 回调处理、子 agent 时间线更新与终态收口
 * - `./chat-stream/useSlashSend.ts`: Slash 命令分发与 handleSendChat 对话发送流程
 */

import { useChatStream } from './chat-stream';

export { useChatStream };
export default useChatStream;

export {
  scheduleFinalMarkdownHtml,
  resolveStreamSessionId,
  isLiveStreamRun,
  safeCancelStream,
  canStreamLocalSession,
  stopAssistantPlaceholderText,
  buildTerminalToolPatches,
  ensureSessionMessages,
} from './chat-stream/helpers';

export type {
  ChatAttachment,
  RunNotice,
  UseChatStreamOptions,
  UseChatStreamResult,
  TerminalToolReason,
  TerminalToolPatch,
} from './chat-stream/types';
