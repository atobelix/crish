/**
 * entry-core.tsx — 单入口启动协调器（Single-Pass Startup Coordinator · ACT-301）
 *
 * 拍平原 main.tsx 四阶动态 import 瀑布，聚合首屏核心依赖为静态闭包，
 * 消除微任务挂起延迟。Stage 3 因果边界（DAG-02）：
 * - 仅负责装配与挂载 React 根树；
 * - 严禁在本路径发起业务数据水合 IPC；
 * - FCP 前 Worker = 0（由既有 WorkerPool lazyInit 保证）；
 * - 业务连接 / 目录水合 / OAuth 由 idle 交接至 bootstrap-full / Stage 4。
 *
 * 源文件扩展名铁律：含 JSX，必须为 .tsx（entry-core.ts / 旧稿称谓废除）。
 */
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { GlobalErrorBanner } from './components/GlobalErrorBanner';
import { ToastProvider } from './services/toast/ToastContext';
import { initSsrGlobals } from './createSsrGlobals';
import { initVisualPresentationController } from './services/visualThemeController';
import { bootstrapTheme } from './api/themeStore';
import { registerBuiltInViews } from './services/view-registry';
import { builtinViewFactories } from './builtinViewFactories';
import {
  activateNotePaper,
  shouldActivateOfficialNotePaper,
} from './extensions/note-paper';
import {
  activateConversationFlow,
  shouldActivateOfficialConversationFlow,
} from './extensions/conversation-flow';
import { memoryManager } from '@crish/shared-utils/browser';
import { logger } from './services/LoggerService';
import './index.css';

export interface StartupCoordinatorOptions {
  enableDevPerformanceMarks?: boolean;
}

/**
 * 单拍同步启动协调器。
 * 模块求值即刻 bootstrap()；幂等防重入。
 */
export class StartupCoordinator {
  private static isBootstrapped = false;

  public static bootstrap(options?: StartupCoordinatorOptions): void {
    if (this.isBootstrapped) {
      logger.warn('[StartupCoordinator] bootstrap() 被重复调用，已自动忽略');
      return;
    }
    this.isBootstrapped = true;

    const t0 = performance.now();

    try {
      // 1. 同步环境评估：DOM 属性直读镜像（纯内存）
      initSsrGlobals();
      initVisualPresentationController();

      // 2. 主题与 Token 纯内存水合（继承 Stage 2 DOM 属性；严禁此处发 IPC）
      bootstrapTheme();

      // 3. 注册 10 槽内置视图工厂（内部保持 lazy，不实例化具体视图）
      registerBuiltInViews(builtinViewFactories);

      // 4. 官方绑定扩展（功能完整性：严禁砍功能）
      if (shouldActivateOfficialNotePaper()) {
        activateNotePaper();
      }
      if (shouldActivateOfficialConversationFlow()) {
        activateConversationFlow();
      }

      // 5. DEV 调试 Store 门面（生产静态剥离；不发起业务 IPC）。
      //    非关键路径动态 import，不阻塞首帧。
      if (import.meta.env.DEV) {
        void Promise.all([
          import('./store/layoutStore'),
          import('./store/sessionStore'),
          import('./store/layout-tree'),
        ])
          .then(([layout, session, tree]) => {
            const win = window as unknown as Record<string, unknown>;
            win.__CRISH_LAYOUT_STORE__ = layout.useLayoutStore;
            win.__CRISH_STORE__ = session.useSessionStore;
            win.__CRISH_SESSION_STORE__ = session.useSessionStore;
            win.__CRISH_TREE_STORE__ = tree.useLayoutTreeStore;
          })
          .catch((e) => {
            logger.warn('[StartupCoordinator] 暴露调试 Store 失败 (非致命):', {
              module: 'StartupCoordinator',
              err:
                e instanceof Error
                  ? { message: e.message, stack: e.stack, name: e.name }
                  : { message: String(e) },
            });
          });
      }

      // 6. DOM 根节点
      const rootElement = document.getElementById('root');
      if (!rootElement) {
        throw new Error('Fatal: #root container element missing in index.html');
      }

      // 7. 内存管理器
      memoryManager.start();

      // 8. 单拍同步挂载 React 根树（不含业务数据水合）
      const root = createRoot(rootElement);
      root.render(
        <StrictMode>
          <ToastProvider>
            <AppErrorBoundary>
              <App />
            </AppErrorBoundary>
          </ToastProvider>
          <GlobalErrorBanner />
        </StrictMode>
      );

      const tMounted = performance.now();
      window.__crish_perf = {
        ...window.__crish_perf,
        startupEvaluationMs: tMounted - t0,
        reactMounted: tMounted,
        firstPaint: performance.now(),
      };

      if (options?.enableDevPerformanceMarks || import.meta.env.DEV) {
        try {
          performance.mark('crish:react_mounted');
        } catch {
          /* mark 不可用时静默 */
        }
      }

      // 9. 首帧：解除 .preload 门闩 + 解锁 WorkerPool JIT + 闲时交接
      requestAnimationFrame(() => {
        document.documentElement.classList.remove('preload');
        window.__crish_perf = {
          ...window.__crish_perf,
          reactInteractiveReady: performance.now(),
        };

        // FCP 已达成：解锁既有 WorkerPool 的 JIT 派生（此前 Worker = 0）
        void import('./workers/index')
          .then(({ getWorkerPool }) => {
            getWorkerPool().markFirstScreenRendered();
          })
          .catch((e) => {
            logger.warn(
              '[StartupCoordinator] markFirstScreenRendered 失败 (非致命):',
              {
                module: 'StartupCoordinator',
                err:
                  e instanceof Error
                    ? { message: e.message, stack: e.stack, name: e.name }
                    : { message: String(e) },
              }
            );
          });

        this.handoffToIdlePhase();
      });
    } catch (err) {
      this.handleFatalStartupError(err);
    }
  }

  /**
   * 闲时交接：bootstrap-core 残余（性能属性 / 平台检测）+ 视图 chunk 预热 + bootstrap-full。
   * 不阻塞已有 UI。
   */
  private static handoffToIdlePhase(): void {
    const idleTask = () => {
      void import('./bootstrap-core')
        .then((m) => m.bootstrapCore())
        .catch((e) => {
          logger.warn('[StartupCoordinator] bootstrap-core 失败 (非致命):', {
            module: 'StartupCoordinator',
            err:
              e instanceof Error
                ? { message: e.message, stack: e.stack, name: e.name }
                : { message: String(e) },
          });
        });

      Promise.allSettled([
        import('./components/diff/DiffCard'),
        import('./components/files/FilesCard'),
        import('./components/overview/OverviewCard'),
        import('./components/workspace/PreviewCard'),
        import('./components/workspace/RuntimePanel'),
      ]).catch(() => {});

      void import('./bootstrap-full')
        .then((m) => m.bootstrapFull())
        .catch((e) => {
          logger.warn('[StartupCoordinator] bootstrap-full 失败 (非致命):', {
            module: 'StartupCoordinator',
            err:
              e instanceof Error
                ? { message: e.message, stack: e.stack, name: e.name }
                : { message: String(e) },
          });
        });
    };

    if ('requestIdleCallback' in window) {
      requestIdleCallback(idleTask, { timeout: 2000 });
    } else {
      setTimeout(idleTask, 800);
    }
  }

  /**
   * 致命降级：Design Tokens + 零裸 Hex + 零旧式 rgba + 零 Emoji + 零外部 Chunk。
   */
  private static handleFatalStartupError(error: unknown): void {
    logger.error('[StartupCoordinator] 致命错误：应用启动异常阻断', {
      module: 'StartupCoordinator',
      err:
        error instanceof Error
          ? { message: error.message, stack: error.stack, name: error.name }
          : { message: String(error) },
    });

    document.documentElement.classList.remove('preload');

    const rootElement = document.getElementById('root');
    if (rootElement) {
      rootElement.innerHTML = `
        <div style="display:flex;height:100vh;width:100vw;align-items:center;justify-content:center;
                    background-color:var(--bg-primary, hsl(240 6% 10%));
                    color:var(--text-primary, hsl(0 0% 100%));
                    font-family:var(--font-sans, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
                    padding:var(--space-6, 24px);box-sizing:border-box;text-align:center;user-select:none;">
          <div style="max-width:420px;padding:var(--space-8, 32px);
                      background:var(--bg-secondary, hsl(240 5% 16%));
                      border:1px solid var(--border-color, hsl(240 4% 24%));
                      border-radius:var(--radius-lg, 8px);
                      box-shadow:var(--shadow-lg, 0 10px 15px -3px hsl(0 0% 0% / 0.3));">
            <div style="width:36px;height:36px;margin:0 auto var(--space-4, 16px);
                        border:2px solid var(--text-secondary, hsl(240 5% 65%));
                        border-radius:50%;display:flex;align-items:center;justify-content:center;
                        font-size:18px;font-weight:700;color:var(--text-secondary, hsl(240 5% 65%));">!</div>
            <h2 style="margin:0 0 var(--space-3, 12px);font-weight:600;font-size:18px;color:var(--text-primary, hsl(0 0% 100%));">
              应用核心启动失败
            </h2>
            <p style="margin:0 0 var(--space-5, 20px);font-size:14px;color:var(--text-secondary, hsl(240 5% 65%));line-height:1.5;">
              界面装配层在初始化时遭遇未捕获异常。本地数据完整，请尝试重新加载。
            </p>
            <button onclick="window.location.reload()"
                    style="padding:var(--space-2, 8px) var(--space-5, 20px);font-size:13px;font-weight:500;
                           border:none;border-radius:var(--radius-md, 4px);
                           background-color:var(--brand-primary, hsl(217 91% 60%));
                           color:var(--text-on-primary, hsl(0 0% 100%));
                           cursor:pointer;">
              重新加载
            </button>
          </div>
        </div>
      `;
    }
  }
}

// 模块求值即刻启动单拍流
StartupCoordinator.bootstrap();
