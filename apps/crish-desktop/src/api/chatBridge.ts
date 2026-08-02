/**
 * 引擎流式事件桥 —— Tauri IPC transport 版（C3.1 后唯一通道）。
 *
 * Facade layer: Re-exports all public API functions and types from split modules
 * under ./chat-bridge/ to preserve backward compatibility for ChatCard,
 * storeAccess, and subagentApi callers.
 *
 * ## Transport SoT (inventory #10 → C3.1)
 * - **唯一通道:** `streamViaEngine`（本 facade → `ConnectionLifecycle`）经
 *   `getTransport()`（TauriTransport）分派 `core_run_task`，事件经
 *   `listen('workbench-run-event')` → `router.onMsg`。
 * - directFetch HTTP SSE 降级已删（C3.4），核心未就绪直接拒绝启动。
 *
 * Error policy (product):
 * - User bubble only shows network-style failures.
 * - Agent/runtime failures are logged and end the run quietly so the
 *   model loop / tool cards can own operational detail.
 */

// Helper utils & types
export {
  blockText,
  extractEventSequence,
  mergeAssistantTextPiece,
  messageBelongsToRun,
  normalizeStreamSessionId,
} from './chat-bridge/handlers/eventUtils';

export { resolveEventType } from './chat-bridge/handlers/eventType';

export {
  toolCallFields,
  toolCallFieldsFromEvent,
  toolResultFields,
} from './chat-bridge/handlers/toolUtils';

export type { StreamState } from './chat-bridge/handlers/streamState';

// Error policy
export { surfaceStreamFailure } from './chat-bridge/BridgeErrorPolicy';

// Approval handling
export type { ApprovalResolvedFields } from './chat-bridge/ApprovalHandler';
export {
  engineApproveTool,
  engineDenyTool,
  parseApprovalResolvedFields,
} from './chat-bridge/ApprovalHandler';

// Event routing
export { EventRouter } from './chat-bridge/EventRouter';

// Connection lifecycle & stream session management
export {
  createFinishController,
  createStreamCancel,
  createStreamSession,
  ensureEngineConnected,
  streamViaEngine,
  type StreamCancelFn,
  type StreamCancelMode,
} from './chat-bridge/ConnectionLifecycle';
