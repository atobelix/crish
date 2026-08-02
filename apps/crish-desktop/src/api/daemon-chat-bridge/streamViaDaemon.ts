/**
 * Re-export barrel for stream lifecycle (Tauri IPC transport, C3.1)。
 * Implementation + SoT docs: `./ConnectionLifecycle.ts`.
 */
export {
  createFinishController,
  createStreamCancel,
  createStreamSession,
  ensureDaemonConnected,
  streamViaDaemon,
  type StreamCancelFn,
  type StreamCancelMode,
} from './ConnectionLifecycle';
