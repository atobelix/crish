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
import { logger } from './services/LoggerService';

export function bootstrapServices(): () => void {
  const cleanups: Array<() => void> = [];

  // 0a. Composition Root：登记 pty / session / shell / workspace / runControl / metrics（B3）
  // reset 必须在 exit-kill 之后（见末尾 cleanups），否则 killAll 门面被清空。
  registerCompositionRoot();

  // 0a.1 全局未捕获错误监听（D1 接线 GlobalErrorBanner 生产者）：
  // React 渲染树之外的异常（timer / 回调 / Promise 链 / store 初始化等）
  // 经 window.onerror + unhandledrejection 统一收敛到 errorStore，由
  // GlobalErrorBanner 呈现（非阻塞告知 + dismiss）。这是该横幅的唯一活路径
  // 生产者——与下方 ENGINE_CONNECT_FAILED 同模式同文件。
  if (typeof window !== 'undefined') {
    const pushUncaught = (kind: 'error' | 'unhandledrejection') => {
      return (event: ErrorEvent | PromiseRejectionEvent) => {
        let message = '发生一次未预期的错误';
        let technical: string | undefined;
        if (kind === 'error') {
          const ev = event as ErrorEvent;
          if (ev.message) message = ev.message;
          if (ev.error instanceof Error && ev.error.stack) {
            technical = ev.error.stack;
          } else if (ev.filename || ev.lineno || ev.colno) {
            technical = `${ev.filename ?? '<unknown>'}:${ev.lineno ?? 0}:${
              ev.colno ?? 0
            }`;
          }
        } else {
          const reason = (event as PromiseRejectionEvent).reason;
          if (reason instanceof Error) {
            message = reason.message || message;
            technical = reason.stack ?? reason.message;
          } else if (reason !== undefined && reason !== null) {
            technical = String(reason);
          }
        }
        errorStore.push({
          code: 'GLOBAL_UNCAUGHT_ERROR',
          module: 'bootstrap-services',
          severity: 'error',
          message,
          technical,
          autoResolve: true,
        });
      };
    };
    const onError = pushUncaught('error');
    const onUnhandledRejection = pushUncaught('unhandledrejection');
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    cleanups.push(() => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    });
  }

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
  // 返回退订函数，供 cleanup 移除监听器（幂等；StrictMode 双执行安全）
  cleanups.push(installBeforeunloadFlush());

  // 3. Start ConnectionManager (fire-and-forget, retries internally)
  // R-06 / T-E D2：空 catch 显式登记——连接失败不再静默（ErrorStore.push 内部
  // 已跑 classifyError；ready 时 resolveByCode 自动关闭，见 7 分支）。
  connectionManager.connect().catch((err) => {
    errorStore.push({
      code: 'ENGINE_CONNECT_FAILED',
      module: 'bootstrap-services',
      severity: 'warning',
      message: '引擎连接失败',
      technical: err instanceof Error ? err.message : String(err),
      autoResolve: true, // 连接成功后 resolveByCode('ENGINE_CONNECT_FAILED')
    });
  });

  // 4. (C3.1) StreamRecovery 已删：连接就绪恢复由 Rust 事件通道有序保证，前端不再重放

  // 5. (C3.1) SessionSyncService 已删：会话即本地 SQLite，无 push/pull 双向同步

  // 7. Wire ErrorStore to EventBus — map daemon connection state
  const unsubErrorStore = eventBus.on('engine:connection:change', (payload) => {
    const p = payload as { phase?: string };
    if (!p?.phase) return;
    switch (p.phase) {
      case 'ready':
        errorStore.setConnectionStatus('connected');
        // R-06：连接成功 → 自动关闭启动期登记的重连失败告警
        errorStore.resolveByCode('ENGINE_CONNECT_FAILED');
        break;
      case 'recovering':
        errorStore.setConnectionStatus('reconnecting');
        break;
      case 'connecting':
      case 'authenticating':
        errorStore.setConnectionStatus('waiting');
        break;
      // T5-1：崩溃域映射——引擎探活判死（前端心跳连续失败）进入
      // engine_crashed；恢复由心跳成功路径/ready 相位回 connected
      case 'engine-crashed':
        errorStore.setConnectionStatus('engine_crashed');
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
  // R-06 / T-E D2：空 catch 显式登记（非连接态软失败，warning 不打扰；
  // 05 步骤 3 收口时以 grep 实测剔除本处）。
  void WindowResizeBridge.getInstance()
    .connect()
    .catch((err) => {
      errorStore.push({
        code: 'RESIZE_BRIDGE_CONNECT_FAILED',
        module: 'bootstrap-services',
        severity: 'warning',
        message: '窗口缩放桥接初始化失败',
        technical: err instanceof Error ? err.message : String(err),
        autoResolve: true,
      });
    });
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
        logger.error('[bootstrap] cleanup error', {
          module: 'bootstrap',
          err: err instanceof Error
            ? { message: err.message, stack: err.stack, name: err.name }
            : { message: String(err) },
        });
      }
    }
  };
}
