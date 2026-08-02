/**
 * bootstrap-services —— 统一服务初始化入口。
 *
 * 在应用启动时调用此函数，初始化所有新服务：
 * - Composition Root：pty / session / shell / workspace / runControl / metrics 门面（B3）
 * - beforeunloadFlush：页面关闭时同步持久化保护
 * - PTY exit kill：pagehide + cleanup 唯一走 compositionRoot.pty.killAll（关窗 best-effort；
 *   权威杀进程在 Rust `RunEvent::Exit` → kill_all_sessions）
 * - ConnectionManager：核心连接状态投影器（transport 驱动）
 * - CrossTabCoordinator：跨标签页协调
 * - ErrorStore 挂接到 EventBus
 *
 * C3.1：StreamRecovery（流恢复协议）与 SessionSyncService（会话双向同步）已删除
 * ——reload/HMR 恢复由 Rust 事件通道有序保证；会话即本地 SQLite。
 *
 * 返回清理函数供 useEffect 卸载时调用。
 */

import { installBeforeunloadFlush } from './api/beforeunloadFlush';
import { connectionManager } from './services/ConnectionManager';
import { crossTabCoordinator } from './services/CrossTabCoordinator';
import { errorStore } from './services/ErrorStore';
import { eventBus } from './services/EventBus';
import { WindowResizeBridge } from './services/WindowResizeBridge';
import { sessionRuntimeRegistry } from './api/SessionRuntimeRegistry';
import { getActiveSessionId } from './api/storeAccess';
import { registerLayoutAnimationBridge } from './store/layoutAnimationStore';
import { registerTreeDockSync } from './store/workspace-shell/workspaceShellStore';
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

  // 4. (C3.1) StreamRecovery 已删：连接就绪恢复由 Rust 事件通道有序保证，前端不再重放

  // 5. (C3.1) SessionSyncService 已删：会话即本地 SQLite，无 push/pull 双向同步

  // 6. Start CrossTabCoordinator (leader election, cross-tab sync)
  crossTabCoordinator.init();

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

  // 8. WindowResizeBridge（T06.10 接线）：窗口缩放冻结状态机唯一入口。
  // connect 幂等，StrictMode 双执行安全；disconnect 随 cleanup 对称清理。
  // 原 AppBootstrap E13 手动 classList 双写已删除，is-layout-frozen 自此单源。
  void WindowResizeBridge.getInstance().connect().catch(() => {});
  cleanups.push(() => {
    WindowResizeBridge.getInstance().disconnect();
  });

  // 9. 布局动画桥（T06.9.1）：isLayoutFrozen → ResizeObserverManager 挂起，
  // 原模块级永久订阅改为显式生命周期（注册幂等，cleanup 退订）。
  cleanups.push(registerLayoutAnimationBridge());

  // 10. tree→shell dock 反向投影（T06.9.1）：原 workspaceShellStore 模块级
  // 永久订阅归位为显式注册/退订（cleanup 时退订）。
  cleanups.push(registerTreeDockSync());

  // 11. 活动会话解析器（T06.9.1）：sessionStore 模块级注册补注销，
  // 统一挂 bootstrap 生命周期（cleanup 时注销）。
  sessionRuntimeRegistry.registerActiveIdResolver(() => getActiveSessionId());
  cleanups.push(() => {
    sessionRuntimeRegistry.unregisterActiveIdResolver();
  });

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
