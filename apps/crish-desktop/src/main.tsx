import { initSsrGlobals } from './createSsrGlobals';
import { memoryManager } from '@crish/shared-utils/browser';
import './index.css';
import { SIDEBAR_WIDTH_DEFAULT, CHAT_COL_MAX } from './constants/layout';

// 必须在任何模块前执行 — 替换 appMode / productMode 的同步 localStorage 读
initSsrGlobals();

// CSS token runtime injection — keeps JS source of truth in sync with CSS
document.documentElement.style.setProperty('--sidebar-width', `${SIDEBAR_WIDTH_DEFAULT}px`);
document.documentElement.style.setProperty('--chat-col-max', `${CHAT_COL_MAX}px`);

async function startup() {
  // Phase 0: 等待 ServiceRegistry / ConfigService 初始化
  await import('./bootstrap-orchestrator').then((m) => m.ready);

  // Phase 1: 并行初始化最小依赖（失败不阻塞渲染）
  try {
    await import('./bootstrap-core').then(({ bootstrapCore }) => bootstrapCore());
  } catch (e) {
    console.warn('[crish] bootstrap-core failed, continuing startup:', e);
  }

  // Phase 1.5: 动态加载 React + App（失败则展示错误边界 fallback）
  let StrictMode: any;
  let createRoot: any;
  let App: any;
  try {
    const [{ StrictMode: SM }, { createRoot: CR }] = await Promise.all([
      import('react'),
      import('react-dom/client'),
    ]);
    StrictMode = SM;
    createRoot = CR;
    const { default: AppModule } = await import('./App');
    App = AppModule;
  } catch (e) {
    console.error('[crish] fatal: failed to load React or App module:', e);
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
    // 动态加载 AppErrorBoundary 避免与 App 同 chunk 捆绑
    const { AppErrorBoundary } = await import('./components/AppErrorBoundary');
    root.render(
      <StrictMode>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </StrictMode>,
    );
  } catch {
    // 降级：不含 AppErrorBoundary 的渲染
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  }

  // Phase 2: idle 时加载完整 UI（后台连接、设置同步、会话元数据）
  // 失败不应阻塞已有 UI，只记日志
  const idleTask = () => {
    import('./bootstrap-full').then((m) => m.bootstrapFull()).catch((e) => {
      console.warn('[crish] bootstrap-full failed (non-fatal):', e);
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

  if (import.meta.env.DEV) {
    const p = (window as any).__crish_perf;
    p.marks = {} as Record<string, number[]>;
    p.budgetExceeded = (entry: { name: string; duration: number; budget: number }) => {
      if (!p.marks[entry.name]) {
        p.marks[entry.name] = [];
      }
      p.marks[entry.name].push(entry.duration);
      if (p.marks[entry.name].length > 100) {
        p.marks[entry.name].shift();
      }
    };
  }
}

startup();
