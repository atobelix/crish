/**
 * entry-core.tsx — 单入口启动协调器（Single-Pass Startup Coordinator · ACT-301）
 *
 * 拍平原 main.tsx 四阶动态 import 瀑布，聚合首屏核心依赖为静态闭包，
 * 消除微任务挂起延迟。Stage 3/4 编排闭环（DAG-02 根治）：
 * - createRoot 前经 UnifiedAppHydrationCoordinator.preloadHydrationSnapshot 单拍预取；
 * - applyAtomicCommit 先 setState 再 hydrateShell，再挂载 React 根树；
 * - FCP 前 Worker = 0（由既有 WorkerPool lazyInit 保证）；
 * - 业务连接 / OAuth 由 idle 交接至 bootstrap-full。
 *
 * 源文件扩展名铁律：含 JSX，必须为 .tsx（entry-core.ts / 旧稿称谓废除）。
 */
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { GlobalErrorBanner } from './components/GlobalErrorBanner';
import { ToastProvider } from './services/toast/ToastContext';
import { I18nProvider } from './i18n';
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
import { UnifiedAppHydrationCoordinator } from './app/UnifiedAppHydrationCoordinator';
import {
  markStartupEntry,
  markStartupPhase,
} from './services/startup/startupMetrics';
import './index.css';

// 实测对比：entry 模块求值即锚定 t0（crishStartupReport 可读）
markStartupEntry();

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
          import('./store/workspaceStore'),
          import('./store/sessionStore'),
          import('./store/layout-tree'),
        ])
          .then(([layout, workspace, session, tree]) => {
            const win = window as unknown as Record<string, unknown>;
            win.__CRISH_LAYOUT_STORE__ = layout.useLayoutStore;
            win.__CRISH_WORKSPACE_STORE__ = workspace.useWorkspaceStore;
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

      // 5b. DEV：MCP guest 监听器注册（真实宿主自动化唯一入口）。
      //     插件不会自动注入 guest 监听器（Cargo.toml exclude /guest-js、
      //     build.rs 无 guest 打包步骤、listener_patch.js 不含 execute-js），
      //     必须由前端显式注册；否则 execute-js 等 emit_and_wait 事件无人接收
      //     → 所有依赖 webview JS 桥的工具永久超时。
      //     注册成功后串接 app_bridge 助手（shell/session 直驱）。
      if (import.meta.env.DEV) {
        void Promise.all([
          import('tauri-plugin-mcp'),
          import('./dev/mcpBridge'),
        ])
          .then(async ([mcp, bridge]) => {
            await mcp.setupPluginListeners();
            // 监听器就绪即应已装好 __MCP_BRIDGE__ 注册表；缺失则显式告警。
            if (!(window as { __MCP_BRIDGE__?: unknown }).__MCP_BRIDGE__) {
              logger.error(
                '[StartupCoordinator] MCP app_bridge 未就绪：window.__MCP_BRIDGE__ 缺失',
                { module: 'StartupCoordinator' }
              );
            }
            bridge.registerCrishMcpBridge();
          })
          .catch((e) => {
            logger.error(
              '[StartupCoordinator] MCP guest 监听器注册失败（宿主桥工具将不可用）:',
              {
                module: 'StartupCoordinator',
                err:
                  e instanceof Error
                    ? { message: e.message, stack: e.stack, name: e.name }
                    : { message: String(e) },
              }
            );
          });
      }

      // 6. DOM 根节点
      const rootElement = document.getElementById('root');
      if (!rootElement) {
        throw new Error('Fatal: #root container element missing in index.html');
      }

      // 7. 内存管理器（ACT-606：绝对阈值 + apps 层熔断注入）
      //    packages 只发 pressure 事件；level 3 时清空空闲预热队列
      memoryManager.onPressure((evt) => {
        if (evt.level === 3) {
          void import('./services/idle/StaggeredIdleQueue')
            .then(({ staggeredIdleQueue }) => {
              staggeredIdleQueue.clear();
            })
            .catch(() => {
              /* 队列模块未加载时无队列可清，静默 */
            });
        }
      });
      memoryManager.start();

      // 8. Stage 4：createRoot 前 preloadHydrationSnapshot + 单拍原子 Commit
      void this.hydrateAndMount(rootElement, t0, options);
    } catch (err) {
      this.handleFatalStartupError(err);
    }
  }

  /**
   * Stage 4 编排闭环：预取 → applyAtomicCommit（先 setState 再 hydrateShell）→ 挂载。
   * 软超时 fallback 由 Coordinator 保证；异常时走致命降级。
   */
  private static async hydrateAndMount(
    rootElement: HTMLElement,
    t0: number,
    options?: StartupCoordinatorOptions
  ): Promise<void> {
    try {
      const coordinator = UnifiedAppHydrationCoordinator.getInstance();
      const snapshot = await coordinator.preloadHydrationSnapshot();
      markStartupPhase('preloadSnapshotDone');
      coordinator.applyAtomicCommit(snapshot);

      const root = createRoot(rootElement);
      root.render(
        <StrictMode>
          <I18nProvider>
            <ToastProvider>
              <AppErrorBoundary>
                <App />
              </AppErrorBoundary>
            </ToastProvider>
          </I18nProvider>
          <GlobalErrorBanner />
        </StrictMode>
      );

      const tMounted = performance.now();
      markStartupPhase('reactMounted', tMounted);
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

      // 首帧：解除 .preload 门闩 + 解锁 WorkerPool JIT + 闲时交接
      requestAnimationFrame(() => {
        document.documentElement.classList.remove('preload');
        markStartupPhase('reactInteractiveReady');
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
   * 闲时交接（Stage 6 ACT-601）：bootstrap-core 残余 + 5 大视图 Chunk 预热
   * + bootstrap-full，统一经 StaggeredIdleQueue 分片调度。
   * 禁止 rIC timeout 整批强刷（CUT-03）；maxWaitMs 兜底防饿死（可配置）。
   */
  private static handoffToIdlePhase(): void {
    // 兜底最坏延迟：默认 10s；可用 window 注入覆盖（0 禁用）
    const injectedMaxWait =
      typeof window !== 'undefined'
        ? (window as { __CRISH_IDLE_MAX_WAIT_MS__?: number })
            .__CRISH_IDLE_MAX_WAIT_MS__
        : undefined;
    const maxWaitMs =
      typeof injectedMaxWait === 'number' && Number.isFinite(injectedMaxWait)
        ? injectedMaxWait
        : 10_000;

    void import('./services/idle/StaggeredIdleQueue')
      .then(({ staggeredIdleQueue }) => {
        // bootstrap-core 残余（优先级 0，先于视图预热）
        staggeredIdleQueue
          .enqueue(
            async () => {
              const m = await import('./bootstrap-core');
              await m.bootstrapCore();
            },
            { name: 'bootstrap:core', priority: 0, maxWaitMs }
          )
          .catch((e) => {
            logger.warn('[StartupCoordinator] bootstrap-core 失败 (非致命):', {
              module: 'StartupCoordinator',
              err:
                e instanceof Error
                  ? { message: e.message, stack: e.stack, name: e.name }
                  : { message: String(e) },
            });
          });

        // 与旧 Promise.allSettled 列表一一对应的 5 大视图 Chunk（真实路径）
        const secondaryViews: Array<{
          name: string;
          loader: () => Promise<unknown>;
        }> = [
          {
            name: 'DiffCard',
            loader: () => import('./components/diff/DiffCard'),
          },
          {
            name: 'FilesCard',
            loader: () => import('./components/files/FilesCard'),
          },
          {
            name: 'OverviewCard',
            loader: () => import('./components/overview/OverviewCard'),
          },
          {
            name: 'PreviewCard',
            loader: () => import('./components/workspace/PreviewCard'),
          },
          {
            name: 'RuntimePanel',
            loader: () => import('./components/workspace/RuntimePanel'),
          },
        ];
        for (const view of secondaryViews) {
          staggeredIdleQueue
            .enqueue(
              async () => {
                const start = performance.now();
                await view.loader();
                const duration = performance.now() - start;
                if (duration > 40) {
                  console.warn(
                    `[Prefetch] ${view.name} 求值耗时偏高: ${duration.toFixed(1)}ms`
                  );
                }
              },
              { name: `prefetch:${view.name}`, priority: 1, maxWaitMs }
            )
            .catch(() => {
              /* 预热失败非致命：视图仍可在真实打开时按需加载 */
            });
        }

        // bootstrap-full：与预热共享预算守卫，优先级 0
        staggeredIdleQueue
          .enqueue(
            async () => {
              const m = await import('./bootstrap-full');
              await m.bootstrapFull();
            },
            { name: 'bootstrap:full', priority: 0, maxWaitMs }
          )
          .catch((e) => {
            logger.warn('[StartupCoordinator] bootstrap-full 失败 (非致命):', {
              module: 'StartupCoordinator',
              err:
                e instanceof Error
                  ? { message: e.message, stack: e.stack, name: e.name }
                  : { message: String(e) },
            });
          });
      })
      .catch((e) => {
        // StaggeredIdleQueue 模块加载失败：回退直接执行（最小正确性）
        logger.warn(
          '[StartupCoordinator] StaggeredIdleQueue 加载失败，回退直调 (非致命):',
          {
            module: 'StartupCoordinator',
            err:
              e instanceof Error
                ? { message: e.message, stack: e.stack, name: e.name }
                : { message: String(e) },
          }
        );
        void import('./bootstrap-core')
          .then((m) => m.bootstrapCore())
          .catch(() => {
            /* swallow-ok: 回退 bootstrap 已失败；上层 handleFatalStartupError 兜底 */
          });
        Promise.allSettled([
          import('./components/diff/DiffCard'),
          import('./components/files/FilesCard'),
          import('./components/overview/OverviewCard'),
          import('./components/workspace/PreviewCard'),
          import('./components/workspace/RuntimePanel'),
        ]).catch(() => {
          /* swallow-ok: allSettled 仅预热；单 chunk 失败不阻断启动 */
        });
        void import('./bootstrap-full')
          .then((m) => m.bootstrapFull())
          .catch(() => {
            /* swallow-ok: 预热路径失败；主 bootstrap-core 已在执行 */
          });
      });
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
                    background-color:var(--bg-primary);
                    color:var(--text-primary);
                    font-family:var(--font-sans, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
                    padding:var(--space-6, 24px);box-sizing:border-box;text-align:center;user-select:none;">
          <div style="max-width:420px;padding:var(--space-8, 32px);
                      background:var(--bg-secondary);
                      border:1px solid var(--border-color);
                      border-radius:var(--radius-lg);
                      box-shadow:var(--shadow-lg);">
            <div style="width:36px;height:36px;margin:0 auto var(--space-4, 16px);
                        border:2px solid var(--text-secondary);
                        border-radius:50%;display:flex;align-items:center;justify-content:center;
                        font-size:18px;font-weight:700;color:var(--text-secondary);">!</div>
            <h2 style="margin:0 0 var(--space-3, 12px);font-weight:600;font-size:18px;color:var(--text-primary);">
              应用核心启动失败
            </h2>
            <p style="margin:0 0 var(--space-5, 20px);font-size:14px;color:var(--text-secondary);line-height:1.5;">
              界面装配层在初始化时遭遇未捕获异常。本地数据完整，请尝试重新加载。
            </p>
            <button onclick="window.location.reload()"
                    style="padding:var(--space-2, 8px) var(--space-5, 20px);font-size:13px;font-weight:500;
                           border:none;border-radius:var(--radius-md);
                           background-color:var(--brand-primary);
                           color:var(--text-on-accent);
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
