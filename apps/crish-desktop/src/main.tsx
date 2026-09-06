import { initSsrGlobals } from './createSsrGlobals';
import { initVisualPresentationController } from './services/visualThemeController';
import { bootstrapTheme } from './api/themeStore';
import { memoryManager } from '@crish/shared-utils/browser';
import { logger } from './services/LoggerService';
import '@xterm/xterm/css/xterm.css';
import './index.css';
import { SIDEBAR_WIDTH_DEFAULT, CHAT_COL_MAX } from './constants/layout';
import {
  registerBuiltInViews,
  type ViewFactoryMap,
} from './services/view-registry';
import type { ViewRenderContext } from './services/view-registry';
import {
  activateNotePaper,
  shouldActivateOfficialNotePaper,
} from './extensions/note-paper';
import {
  activateConversationFlow,
  shouldActivateOfficialConversationFlow,
} from './extensions/conversation-flow';
import { lazy } from 'react';

import { ToastProvider } from './services/toast/ToastContext';

// 维度 3 步骤 1 / 3-E：视图 lazy factory 注入面。
// registerBuiltInViews 不再自引 components（斩断 services/view-registry → components
// 反向边）；实际 lazy import 在此注入（app → components 为合法下行边，无环）。
// 每个 factory 返回 React.ComponentType<ViewRenderContext>（lazy + 适配器，
// 把 ViewRenderContext 投影成各组件真实 props）。
const builtinViewFactories: ViewFactoryMap = {
  chat: () =>
    lazy(() =>
      import('./components/chat-card/ChatCard').then((m) => ({
        default: (ctx: ViewRenderContext) => (
          <m.ChatCard
            sessionId={ctx.sessionId}
            handleGlobalTabClick={ctx.openView}
          />
        ),
      }))
    ),
  terminal: () =>
    lazy(() =>
      import('./components/workspace/TerminalCard').then((m) => ({
        default: (ctx: ViewRenderContext) => (
          <m.TerminalCard
            sessionId={ctx?.sessionId}
            panelId={ctx?.panelId}
          />
        ),
      }))
    ),
  preview: () =>
    lazy(() =>
      import('./components/workspace/PreviewCard').then((m) => ({
        default: () => <m.PreviewCard />,
      }))
    ),
  overview: () =>
    lazy(() =>
      import('./components/overview/OverviewCard').then((m) => ({
        default: (ctx: ViewRenderContext) => (
          <m.OverviewCard onOpenPanel={ctx.openView} />
        ),
      }))
    ),
  files: () =>
    lazy(() =>
      import('./components/files/FilesCard').then((m) => ({
        default: () => <m.FilesCard />,
      }))
    ),
  diff: () =>
    lazy(() =>
      import('./components/diff/DiffCard').then((m) => ({
        default: () => <m.DiffCard />,
      }))
    ),
  runtime: () =>
    lazy(() =>
      import('./components/workspace/RuntimePanel').then((m) => ({
        default: () => <m.RuntimePanel />,
      }))
    ),
  agent: () =>
    lazy(() =>
      import('./components/agent-card/AgentCard').then((m) => ({
        default: () => <m.AgentCard />,
      }))
    ),
  'flow-dag': () =>
    lazy(() =>
      import('./components/workspace/FlowDagView').then((m) => ({
        default: () => <m.FlowDagView />,
      }))
    ),
  'file-viewer': () =>
    lazy(() =>
      import('./components/files/FileViewerCard').then((m) => ({
        default: m.FileViewerCardView,
      }))
    ),
};

// 必须在任何模块前执行 — 替换 appMode / productMode 的同步 localStorage 读
initSsrGlobals();
initVisualPresentationController();

// 🌟 主题与个性化皮肤同步水合（彻底斩断 useEffect 延迟与二次跳变）
bootstrapTheme();

// CSS token runtime injection — keeps JS source of truth in sync with CSS
document.documentElement.style.setProperty(
  '--sidebar-width',
  `${SIDEBAR_WIDTH_DEFAULT}px`
);
document.documentElement.style.setProperty(
  '--chat-col-max',
  `${CHAT_COL_MAX}px`
);

async function startup() {
  // 微内核生命周期前置：显式注册 Conex 全量内置视图与插槽，彻底消除 ESM 模块加载副作用依赖
  // 维度 3 步骤 1 / 3-E：factory 由本文件注入（斩断 view-registry → components 反向边）
  registerBuiltInViews(builtinViewFactories);
  // 官方捆绑笔记扩展（可卸）；不是内核第 12 个内置
  if (shouldActivateOfficialNotePaper()) {
    activateNotePaper();
  }
  if (shouldActivateOfficialConversationFlow()) {
    activateConversationFlow();
  }

  // Phase 0: 等待 ServiceRegistry / ConfigService 初始化
  await import('./bootstrap-orchestrator').then((m) => m.ready);

  // Phase 1: 并行初始化最小依赖（失败不阻塞渲染）
  try {
    await import('./bootstrap-core').then(({ bootstrapCore }) =>
      bootstrapCore()
    );
  } catch (e) {
    logger.warn('[crish] bootstrap-core failed, continuing startup:', {
      module: 'main',
      err: e instanceof Error
        ? { message: e.message, stack: e.stack, name: e.name }
        : { message: String(e) },
    });
  }

  // 将核心 store 暴露到 window，便于浏览器环境调试与自动化测试
  //（不影响生产构建安全性，只提供与 UI 同等的 API 入口）
  try {
    const { useLayoutStore } = await import('./store/layoutStore');
    const { useSessionStore } = await import('./store/sessionStore');
    const { useLayoutTreeStore } = await import('./store/layout-tree');
    // __CRISH_STORE__ 保持为会话 store（与既有测试脚本、手动调试习惯一致）
    const win = window as unknown as Record<string, unknown>;
    win.__CRISH_STORE__ = useSessionStore;
    win.__CRISH_SESSION_STORE__ = useSessionStore;
    win.__CRISH_LAYOUT_STORE__ = useLayoutStore;
    win.__CRISH_TREE_STORE__ = useLayoutTreeStore;
  } catch (e) {
    logger.warn('[crish] exposing stores failed:', {
      module: 'main',
      err: e instanceof Error
        ? { message: e.message, stack: e.stack, name: e.name }
        : { message: String(e) },
    });
  }

  // Phase 1.5: 动态加载 React + App（失败则展示错误边界 fallback）
  // R-09（T5.3）：AppErrorBoundary chunk 与 React/App 并行预取——
  // 首屏渲染不再被 boundary chunk 加载阻塞一拍（原 render 前单独 await）
  let StrictMode: React.ComponentType<{ children?: React.ReactNode }> | null =
    null;
  let createRoot: typeof import('react-dom/client').createRoot | null = null;
  let App: React.ComponentType<Record<string, never>> | null = null;
  let GlobalErrorBanner: React.ComponentType<Record<string, never>> | null =
    null;
  const boundaryLoad = import('./components/AppErrorBoundary');
  try {
    const [{ StrictMode: SM }, { createRoot: CR }] = await Promise.all([
      import('react'),
      import('react-dom/client'),
    ]);
    StrictMode = SM;
    createRoot = CR;
    const { default: AppModule } = await import('./App');
    App = AppModule;
    // T5-4：全局错误横幅（消费 errorStore 的 GLOBAL_UNCAUGHT_ERROR 槽位；
    // 与 AppErrorBoundary 同批预取，失败不阻断主渲染——横幅是可选的
    // 呈现面，加载失败仅缺失告知）
    try {
      const { GlobalErrorBanner: GEB } =
        await import('./components/GlobalErrorBanner');
      GlobalErrorBanner = GEB;
    } catch (e) {
      logger.warn('[crish] failed to load GlobalErrorBanner (non-fatal):', {
        module: 'main',
        err: e instanceof Error
          ? { message: e.message, stack: e.stack, name: e.name }
          : { message: String(e) },
      });
    }
  } catch (e) {
    logger.error('[crish] fatal: failed to load React or App module:', {
      module: 'main',
      err: e instanceof Error
        ? { message: e.message, stack: e.stack, name: e.name }
        : { message: String(e) },
    });
    // 异常安全复位：解除门闩避免内联错误页冻结
    document.documentElement.classList.remove('preload');
    const el = document.getElementById('root');
    if (el) {
      el.innerHTML =
        '<div style="display:flex;height:100vh;align-items:center;justify-content:center;font-family:sans-serif;color:#888;padding:20px;text-align:center">' +
        '<div><h2 style="margin:0 0 8px;font-weight:500;font-size:18px">应用启动失败</h2>' +
        '<p style="margin:0;font-size:14px">核心模块加载失败，请查看控制台后重试</p></div></div>';
    }
    return;
  }

  memoryManager.start();

  const root = createRoot(document.getElementById('root')!);

  // 首次渲染：骨架屏由 index.html 内联提供，createRoot 替换为 React 树
  // 外包 AppErrorBoundary 捕获渲染阶段异常，防止白屏
  try {
    // 动态加载 AppErrorBoundary 避免与 App 同 chunk 捆绑（已并行预取）
    const { AppErrorBoundary } = await boundaryLoad;
    root.render(
      <StrictMode>
        <ToastProvider>
          <AppErrorBoundary>
            <App />
          </AppErrorBoundary>
        </ToastProvider>
        {/* T5-4：React 渲染树之外的全局错误呈现面（bootstrap-services 注册
            window.onerror / unhandledrejection → errorStore.push 的消费端；
            不弹模态、不打断渲染，仅可见告知 + dismiss；横幅 chunk 加载失败
            仅缺失告知，不阻断主渲染） */}
        {GlobalErrorBanner ? <GlobalErrorBanner /> : null}
      </StrictMode>
    );
  } catch {
    // T5-4：AppErrorBoundary chunk 加载失败 → 内联静态错误面（复用上方
    // 「应用启动失败」同一套内联 HTML fallback 构造，不依赖任何 chunk）。
    // **不再回到裸 <App/>**——App 内再抛错即白屏，白屏路径必须消除。
    logger.error('[crish] fatal: failed to load AppErrorBoundary chunk', {
      module: 'main',
    });
    // 异常安全复位：解除门闩避免内联错误页冻结
    document.documentElement.classList.remove('preload');
    const el = document.getElementById('root');
    if (el) {
      el.innerHTML =
        '<div style="display:flex;height:100vh;align-items:center;justify-content:center;font-family:sans-serif;color:#888;padding:20px;text-align:center">' +
        '<div><h2 style="margin:0 0 8px;font-weight:500;font-size:18px">应用启动失败</h2>' +
        '<p style="margin:0;font-size:14px">界面保护模块加载失败，请查看控制台后重试</p></div></div>';
    }
  }

  // R-09（T5.3）：React 首帧渲染完成标记——root.render 后首个 rAF 打点，
  // 回答「App 何时可交互」（07 审计 R-09 / 4.3）
  // 🌟 解除冷启动 .preload 全局动画门闩，恢复所有交互态过渡
  requestAnimationFrame(() => {
    document.documentElement.classList.remove('preload');
    window.__crish_perf = {
      ...window.__crish_perf,
      reactInteractiveReady: performance.now(),
    };
  });

  // Phase 2: idle 时加载完整 UI（后台连接、设置同步、会话元数据）及预热视图 Chunk
  // 失败不应阻塞已有 UI，只记日志
  const idleTask = () => {
    // 🌟 预热常用右侧工具视图 Chunk，彻底消除用户首次点击时的 Suspense 停顿
    Promise.allSettled([
      import('./components/diff/DiffCard'),
      import('./components/files/FilesCard'),
      import('./components/overview/OverviewCard'),
      import('./components/workspace/PreviewCard'),
      import('./components/workspace/RuntimePanel'),
    ]).catch(() => {});

    import('./bootstrap-full')
      .then((m) => m.bootstrapFull())
      .catch((e) => {
        logger.warn('[crish] bootstrap-full failed (non-fatal):', {
          module: 'main',
          err: e instanceof Error
            ? { message: e.message, stack: e.stack, name: e.name }
            : { message: String(e) },
        });
      });
  };
  if ('requestIdleCallback' in window) {
    requestIdleCallback(idleTask, { timeout: 2000 });
  } else {
    setTimeout(idleTask, 1000);
  }

  // 性能标记
  window.__crish_perf = {
    ...window.__crish_perf,
    firstPaint: performance.now(),
  };

  // Tauri MCP guest bindings (debug only): console/DOM/IPC capture for AI agents
  // Requires agent-workbench debug build with tauri-plugin-mcp + MCP server CLI.
  if (import.meta.env.DEV) {
    void import('tauri-plugin-mcp')
      .then((m) => m.setupPluginListeners())
      .then(() => {
        logger.info('[crish] tauri-plugin-mcp guest listeners ready', {
          module: 'main',
        });
        // shell helpers for app_bridge (open_session / shell_snapshot)
        return import('./dev/mcpBridge').then((b) =>
          b.registerCrishMcpBridge()
        );
      })
      .catch((e) => {
        // Browser-only / plugin not linked: non-fatal
        logger.debug('[crish] tauri-plugin-mcp guest not available:', {
          module: 'main',
          err: e instanceof Error
            ? { message: e.message, stack: e.stack, name: e.name }
            : { message: String(e) },
        });
      });
  }

  if (import.meta.env.DEV) {
    if (!window.__crish_perf) {
      window.__crish_perf = {};
    }
    const p = window.__crish_perf;
    const marks: Record<string, number[]> = {};
    p.marks = marks;
  }

  // 修复 8：budgetExceeded 注册移出 DEV 守卫——生产环境也注册。
  // 生产回调仅推入环形缓冲 + logger.warn，不推入 errorStore（预算超限是
  // 性能信号，非用户可见错误）。
  if (!window.__crish_perf) {
    window.__crish_perf = {};
  }
  const perfBuf: Array<{ name: string; duration: number; budget: number }> =
    [];
  const PERF_BUF_MAX = 100;
  window.__crish_perf.budgetExceeded = (entry: {
    name: string;
    duration: number;
    budget: number;
  }) => {
    // 环形缓冲（max 100 条，溢出丢弃最旧）
    perfBuf.push(entry);
    if (perfBuf.length > PERF_BUF_MAX) {
      perfBuf.shift();
    }
    // 仅 logger.warn，不推入 errorStore
    logger.warn(
      `[Perf] ${entry.name}: ${entry.duration.toFixed(1)}ms exceeds ${entry.budget}ms budget`,
      { module: 'performance-budget' }
    );
  };
}

startup();
