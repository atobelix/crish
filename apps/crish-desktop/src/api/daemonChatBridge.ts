/**
 * Maps daemon run-task event stream → ChatCard StreamCallbacks.
 *
 * Facade layer: Re-exports all public API functions and types from split modules
 * under ./daemon-chat-bridge/ to preserve backward compatibility for ChatCard,
 * StreamRecovery, storeAccess, and subagentApi callers.
 *
 * ## Transport SoT (inventory #10)
 * - **Primary:** `streamViaDaemon` (this facade → `ConnectionLifecycle`).
 * - **Degraded:** `directFetchBridge.streamViaDirectFetch` only when daemon WS
 *   is unreachable and `ALLOW_AUTO_DIRECT_FETCH_FALLBACK` is true — not a product SoT.
 * - Product callers should use `chatApi.streamAssistantResponseApi` or this
 *   `streamViaDaemon` export; do not call directFetch as a second primary path.
 *
 * Error policy (product):
 * - User bubble only shows network-style failures.
 * - Agent/runtime failures are logged and end the run quietly so the
 *   model loop / tool cards can own operational detail.
 *
 * @see docs/plans/progress/architecture-dedup-inventory.md #10
 */

// Helper utils & types
export {
  blockText,
  mergeAssistantTextPiece,
  messageBelongsToRun,
  normalizeStreamSessionId,
} from './daemon-chat-bridge/handlers/eventUtils';

export { resolveEventType } from './daemon-chat-bridge/handlers/eventType';

export {
  toolCallFields,
  toolCallFieldsFromEvent,
  toolResultFields,
} from './daemon-chat-bridge/handlers/toolUtils';

export type { StreamState } from './daemon-chat-bridge/handlers/streamState';

// Error policy
export { surfaceStreamFailure } from './daemon-chat-bridge/BridgeErrorPolicy';

// Approval handling
export type { ApprovalResolvedFields } from './daemon-chat-bridge/ApprovalHandler';
export {
  daemonApproveTool,
  daemonDenyTool,
  parseApprovalResolvedFields,
} from './daemon-chat-bridge/ApprovalHandler';

// Event routing
export { EventRouter } from './daemon-chat-bridge/EventRouter';

// Connection lifecycle & stream session management
export {
  ALLOW_AUTO_DIRECT_FETCH_FALLBACK,
  createFinishController,
  createStreamCancel,
  createStreamSession,
  ensureDaemonConnected,
  streamViaDaemon,
  type StreamCancelFn,
  type StreamCancelMode,
} from './daemon-chat-bridge/ConnectionLifecycle';
