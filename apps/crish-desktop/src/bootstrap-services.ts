/**
 * bootstrap-services —— 统一服务初始化入口。
 *
 * 在应用启动时调用此函数，初始化所有新服务：
 * - Composition Root：pty / session / shell / workspace / runControl / metrics 门面（B3）
 * - beforeunloadFlush：页面关闭时同步持久化保护
 * - PTY exit kill：pagehide + cleanup 唯一走 compositionRoot.pty.killAll（关窗 best-effort；
 *   权威杀进程在 Rust `RunEvent::Exit` → kill_all_sessions）
 * - ConnectionManager：Daemon 连接管理器
 * - StreamRecovery：流恢复协议
 * - SessionSyncService：会话双向同步
 * - CrossTabCoordinator：跨标签页协调
 * - ErrorStore 挂接到 EventBus
 *
 * 返回清理函数供 useEffect 卸载时调用。
 */

import { installBeforeunloadFlush } from './api/beforeunloadFlush';
import { connectionManager } from './services/ConnectionManager';
import { streamRecovery } from './services/StreamRecovery';
import { sessionSyncService } from './services/SessionSyncService';
import { crossTabCoordinator } from './services/CrossTabCoordinator';
import { errorStore } from './services/ErrorStore';
import { eventBus } from './services/EventBus';
import { telemetry } from './services/TelemetryService';
import {
  killAllPtysOnAppExit,
  registerCompositionRoot,
  resetCompositionRoot,
} from './app/compositionRoot';

// Re-export for callers/tests that keyed off bootstrap
export { killAllPtysOnAppExit } from './app/compositionRoot';

export function bootstrapServices(): () => void {
  const cleanups: Array<() => void> = [];

  // 0a. Composition Root：登记 pty / session / shell / workspace / runControl / metrics（B3）
  // reset 必须在 exit-kill 之后（见末尾 cleanups），否则 killAll 门面被清空。
  registerCompositionRoot();

  // 0b. PTY registry ↔ Tauri bridge（关 tab 时 kill 会话终端）
  void import('./api/ptySessionApi').then(({ ptyCreate, ptyKill }) => {
    void import('./api/ptyRegistry').then(({ registerPtyHandlers }) => {
      registerPtyHandlers({
        spawn: async (sessionId) => {
          const res = await ptyCreate({
            sessionKey: sessionId,
            cols: 80,
            rows: 24,
          });
          return res.status === 'ok' ? res.data.ptyId : null;
        },
        kill: async (ptyId) => {
          await ptyKill(ptyId);
        },
      });
    });
  });

  // 0c. App exit kill — 单路径：compositionRoot.pty.killAll
  // 策略 A：折坞 / Terminal unmount **不** kill；仅 exit / closeTab / reset。
  // pagehide 为 best-effort（IPC 可能赶不及）；Rust Exit 为权威。
  const onPageHide = () => {
    killAllPtysOnAppExit();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPageHide);
    cleanups.push(() => {
      window.removeEventListener('pagehide', onPageHide);
      killAllPtysOnAppExit();
    });
  }

  // 1. EventBus is singleton — no init needed

  // 2. Install beforeunload flush (beforeunload/pagehide handlers)
  installBeforeunloadFlush();

  // 3. Start ConnectionManager (fire-and-forget, retries internally)
  connectionManager.connect().catch(() => {});

  // 4. Register daemon connection listener for StreamRecovery
  const unsubStreamRecovery = eventBus.on('daemon:connection:change', (payload) => {
    const p = payload as { phase?: string };
    if (p?.phase === 'ready') {
      streamRecovery.recoverAllStreams().catch(() => {});
    }
  });
  cleanups.push(unsubStreamRecovery);

  // 5. Start SessionSyncService (loads queue, starts push/pull timers)
  sessionSyncService.init().catch((err) => {
    console.error('[bootstrap] sessionSyncService.init failed:', err);
  });

  // 6. Start CrossTabCoordinator (leader election, cross-tab sync)
  crossTabCoordinator.init();

  // 6b. Wire TelemetryService to EventBus — log all events for debugging
  const unsubTelemetry = eventBus.onAny((event) => {
    const isErrorEvent = typeof event.payload === 'object' && event.payload !== null && (event.payload as Record<string, unknown>).severity === 'error';
    if (process.env.NODE_ENV === 'development' || isErrorEvent) {
      telemetry.debug('eventbus', `Event: ${event.type}`, { source: event.source });
    }
  });
  cleanups.push(unsubTelemetry);

  // 7. Wire ErrorStore to EventBus — map daemon connection state
  const unsubErrorStore = eventBus.on('daemon:connection:change', (payload) => {
    const p = payload as { phase?: string };
    if (!p?.phase) return;
    switch (p.phase) {
      case 'ready':
        errorStore.setConnectionStatus('connected');
        break;
      case 'recovering':
        errorStore.setConnectionStatus('reconnecting');
        break;
      case 'connecting':
      case 'authenticating':
        errorStore.setConnectionStatus('waiting');
        break;
      case 'disconnected':
      default:
        errorStore.setConnectionStatus('disconnected');
        break;
    }
  });
  cleanups.push(unsubErrorStore);

  // Composition root teardown last（exit kill 已在 0c 跑过）
  cleanups.push(() => {
    resetCompositionRoot();
  });

  return () => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch (err) {
        console.error('[bootstrap] cleanup error:', err);
      }
    }
  };
}
