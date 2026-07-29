/**
 * Re-export barrel for stream lifecycle (primary transport + #10 flag).
 * Implementation + SoT docs: `./ConnectionLifecycle.ts`.
 */
export {
  ALLOW_AUTO_DIRECT_FETCH_FALLBACK,
  createFinishController,
  createStreamCancel,
  createStreamSession,
  ensureDaemonConnected,
  streamViaDaemon,
  type StreamCancelFn,
  type StreamCancelMode,
} from './ConnectionLifecycle';
