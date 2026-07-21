/**
 * bootstrap-services —— 统一服务初始化入口。
 *
 * 在应用启动时调用此函数，初始化所有新服务：
 * - beforeunloadFlush：页面关闭时同步持久化保护
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

export function bootstrapServices(): () => void {
  const cleanups: Array<() => void> = [];

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
    if (process.env.NODE_ENV === 'development' || (event.payload as any)?.severity === 'error') {
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
