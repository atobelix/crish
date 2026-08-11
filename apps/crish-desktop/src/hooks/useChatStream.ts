/**
 * useChatStream.ts — **主对话** 流式门面（ChatCard / Composer 唯一入口）
 *
 * ## 边界（与 useAgentPanel 互斥）
 * | 表面 | 模块 | Stop API |
 * |------|------|----------|
 * | **主对话** | 本门面 → `./chat-stream/*` | `handleStopGeneration` (L2) / `handleForceCancelGeneration` (L3) |
 * | **子 Agent 面板** | `hooks/useAgentStream.ts` → `useAgentPanel` | `handleStopGeneration` / `handleForceCancelGeneration` |
 *
 * 实现目录 `./chat-stream/`；本文件只 re-export。
 * 协议终止统一经 SessionStreamManager.cancel → createStreamCancel → compositionRoot.runControl。
 * 勿从本门面拉子 Agent 面板逻辑；勿 import 已删除的 `hooks/useStreamCallbacks.ts`。
 *
 * 拆分模块：
 * - `./chat-stream/helpers.ts`: session id / stream 防护 / terminal tool patches
 * - `./chat-stream/multimodal.ts`: 附件与多模态 content parts
 * - `./chat-stream/useStreamBatchers.ts`: rAF buffer + 48ms 批处理
 * - `./chat-stream/useGoalMode.ts`: /goal 续写与 drain
 * - `./chat-stream/useStreamCallbacks.ts`: SSE 回调、子 agent 时间线、终态
 * - `./chat-stream/useSlashSend.ts`: slash 与 handleSendChat
 */

import { useChatStream } from './chat-stream';

export { useChatStream };

export type { SendWhileRunningAction } from './chat-stream/helpers';

export type {
  ChatAttachment,
  QueuedMessage,
  RunNotice,
  UseChatStreamOptions,
  UseChatStreamResult,
  TerminalToolReason,
  TerminalToolPatch,
} from './chat-stream/types';
