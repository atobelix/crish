# Conex/Crish 启动/热启动终极优化方案

## 1. 当前瓶颈分析

从现有代码（`main.tsx`、`App.tsx`、`layoutStore.ts`、`index.css`）审查得出：

| 瓶颈 | 位置 | 影响 |
|------|------|------|
| CSS 全量导入 (~400KB) | `index.css` → 6 个 `@import` | 阻塞首次渲染 |
| theme/font bootstrap 同步执行 | `main.tsx:6-7` | 阻塞 `createRoot` |
| Stores 全量初始化 | `layoutStore.ts` 启动时计算全部状态 | 拖慢核心加载 |
| 磁盘镜像回灌 | `initLayoutStorePersistence` 同步触发 | 可能阻塞首次渲染 |
| 所有组件静态导入 | `App.tsx:24-46` | 打包为一个巨大 chunk |
| daemon 连接阻塞 UI ready | `App.tsx:281-318` | 首屏空白等待 |
| 无骨架屏 | `index.html` 空的 `<div id="root">` | 白屏期无反馈 |
| markdown/code highlight 在主线程 | `markdownRender.ts`、`codeHighlight.ts` | 卡 UI |
| settings UI 同步加载 | `clientApi.getSettings()` 在 `useEffect` 中串行 | 延迟设置面板 |

## 2. 三阶段启动架构

```
Time:  0ms    50ms    200ms    500ms    1s        2s
       ├──────┼────────┼────────┼────────┼─────────┤
Phase: P0     P1       P2       │        │
       │      │        │        │        │
       Skeleton        Core UI  │        │
       │      │        │        │        │
       │      │        │        ├── Full UI ──┤
       │      │        │        │             │
       │      │        │        ├── Daemon connect
       │      │        │        ├── Worker pool ready
       │      │        │        ├── Idle preload ────►
```

### 阶段 0: 骨架屏 (0-50ms)

**目标**: 50ms 内显示内容，用户感知"应用已启动"

**改动清单**:

#### `index.html` — 内联骨架屏 + 主题标记

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Crish · AI 工作台</title>
    <!-- 内联骨架屏 CSS (0.3KB gzip) -->
    <style>
      /* ── 骨架屏动画 ── */
      .skel-shimmer {
        background: linear-gradient(90deg, #eee 25%, #f5f5f5 50%, #eee 75%);
        background-size: 200% 100%;
        animation: skel-shimmer 1.5s infinite;
        border-radius: 6px;
      }
      @keyframes skel-shimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
      /* ── 骨架屏布局 ── */
      .skel-app {
        display: flex; height: 100vh; width: 100%; overflow: hidden;
      }
      .skel-sidebar {
        width: 260px; height: 100%; padding: 12px; display: flex; flex-direction: column; gap: 8px;
      }
      .skel-sidebar-header { height: 36px; width: 100%; }
      .skel-sidebar-item { height: 44px; width: 100%; }
      .skel-main { flex: 1; height: 100%; display: flex; flex-direction: column; padding: 16px; gap: 12px; }
      .skel-toolbar { height: 32px; width: 100%; }
      .skel-body { flex: 1; width: 100%; }
      /* ── 皮肤标记 ── */
      html[data-theme='dark'] .skel-shimmer {
        background: linear-gradient(90deg, #2a2a2a 25%, #333 50%, #2a2a2a 75%);
        background-size: 200% 100%;
      }
    </style>
    <!-- 预加载主题 (原有 inline script，保留) -->
    <script>
      (function () {
        try {
          var t = localStorage.getItem('crish_theme');
          if (t !== 'dark' && t !== 'default' && t !== 'light') {
            var raw = localStorage.getItem('crish_settings') || localStorage.getItem('conex_pi_settings');
            if (raw) { var s = JSON.parse(raw); t = s && s.theme; }
          }
          if (t === 'light') t = 'default';
          if (t !== 'dark') t = 'default';
          document.documentElement.setAttribute('data-theme', t);
          document.documentElement.classList.add(t === 'dark' ? 'theme-dark' : 'theme-light');
        } catch (e) { document.documentElement.setAttribute('data-theme', 'default'); }
        try {
          var fr = localStorage.getItem('crish_fonts');
          if (!fr) { var raw2 = localStorage.getItem('crish_settings') || localStorage.getItem('conex_pi_settings');
            if (raw2) { var s2 = JSON.parse(raw2); if (s2 && s2.fonts) fr = JSON.stringify(s2.fonts); } }
          if (fr) { var f = JSON.parse(fr);
            if (f && f.uiFont) document.documentElement.setAttribute('data-ui-font', String(f.uiFont).indexOf('local:') === 0 ? 'local' : f.uiFont);
            if (f && f.monoFont) document.documentElement.setAttribute('data-mono-font', String(f.monoFont).indexOf('local:') === 0 ? 'local' : f.monoFont); }
        } catch (e2) {}
      })();
    </script>
  </head>
  <body>
    <div id="root">
      <!-- 骨架屏：Suspense 替换目标 -->
      <div class="skel-app" id="skel-app">
        <div class="skel-sidebar">
          <div class="skel-shimmer skel-sidebar-header"></div>
          <div class="skel-shimmer skel-sidebar-item"></div>
          <div class="skel-shimmer skel-sidebar-item"></div>
          <div class="skel-shimmer skel-sidebar-item"></div>
          <div class="skel-shimmer skel-sidebar-item"></div>
        </div>
        <div class="skel-main">
          <div class="skel-shimmer skel-toolbar"></div>
          <div class="skel-shimmer skel-body"></div>
        </div>
      </div>
    </div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

#### `src/createSsrGlobals.ts` (新增)

最小全局初始化 — 在 React 加载前运行：

```typescript
// 在 main.tsx 顶部执行：硬件标记、platform、appMode 快速判断
// 这些值被多处 import 时同步读取，避免动态 import 延迟

export const SSR_GLOBALS = {
  isTauri: false as boolean,
  isProduct: false as boolean,
  appMode: 'normal' as 'normal' | 'demo',
  theme: 'default' as string,
  uiFont: 'auto' as string,
  monoFont: 'auto' as string,
};

export function initSsrGlobals(): void {
  try {
    SSR_GLOBALS.isTauri = !!(window as any).__TAURI_INTERNALS__;
    SSR_GLOBALS.isProduct = SSR_GLOBALS.isTauri || localStorage.getItem('crish_product_shell') === '1';
    SSR_GLOBALS.appMode = SSR_GLOBALS.isProduct ? 'normal' : (localStorage.getItem('crish_app_mode') as any) || 'normal';
    SSR_GLOBALS.theme = document.documentElement.getAttribute('data-theme') || 'default';
    SSR_GLOBALS.uiFont = document.documentElement.getAttribute('data-ui-font') || 'auto';
    SSR_GLOBALS.monoFont = document.documentElement.getAttribute('data-mono-font') || 'auto';
  } catch {}
}

// 快速判断函数（替代原有 appMode.ts / productMode.ts 中的同步读取）
export function isTauriShellFast(): boolean { return SSR_GLOBALS.isTauri; }
export function isProductShellFast(): boolean { return SSR_GLOBALS.isProduct; }
export function isDemoModeFast(): boolean { return SSR_GLOBALS.appMode === 'demo'; }
```

### 阶段 1: 核心 UI (50-200ms)

**目标**: 侧栏 + 工具栏骨架可见，用户可操作

#### `src/main.tsx` — 重写为异步入口

```typescript
import { initSsrGlobals } from './createSsrGlobals';

// 必须在任何模块前执行 — 替换 appMode / productMode 的同步 localStorage 读
initSsrGlobals();

// 启动核心 bootstrap（并行、不阻塞渲染树）
async function startup() {
  // Phase 1: 并行初始化最小依赖
  const core = await import('./bootstrap-core');
  await core.bootstrapCore();

  // 动态加载 React + App
  const [{ StrictMode, lazy }, { createRoot }, { App }] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('./App'),
  ]);

  const root = createRoot(document.getElementById('root')!);

  // 先渲染侧栏骨架（Suspense fallback 已由 App 内部的 skeleton 提供）
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  // Phase 2: idle 时加载完整 UI
  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => import('./bootstrap-full'), { timeout: 2000 });
  } else {
    setTimeout(() => import('./bootstrap-full'), 1000);
  }
}

startup();
```

#### `src/bootstrap-core.ts` (新增)

```typescript
// 核心启动：不依赖 React，纯并行异步初始化

let coreReady = false;
export function isCoreReady(): boolean { return coreReady; }

export async function bootstrapCore(): Promise<void> {
  const start = performance.now();

  // 并行执行所有非阻塞初始化
  await Promise.all([
    // 1. 硬件检测（不阻塞渲染）
    (async () => {
      const { detectPlatform } = await import('./api/platformDetect');
      await detectPlatform(); // 写入 shared-utils PlatformAdaptationCtx
    })(),

    // 2. Worker 池初始化 (2 个核心 worker)
    (async () => {
      const { initWorkerPool } = await import('./worker/pool');
      initWorkerPool({ minWorkers: 2, maxWorkers: navigator.hardwareConcurrency || 4 });
    })(),

    // 3. 最小配置读取 (只读必要的 localStorage key)
    (async () => {
      const { loadMinimalConfig } = await import('./store/minimalConfig');
      await loadMinimalConfig();
    })(),

    // 4. 主题已由 index.html 内联处理，无需额外操作
  ]);

  coreReady = true;
  console.debug(`[perf] bootstrapCore: ${performance.now() - start}ms`);
}
```

#### `src/store/minimalConfig.ts` (新增)

```typescript
// 仅读取启动必需的 localStorage key，不触及其他模块

export interface MinimalConfig {
  sidebarCollapsed: boolean;
  shellChromeMode: string | null;
  uiSize: string;
  tabModeEnabled: boolean;
  theme: string;
}

const KEYS = {
  shellChrome: 'crish_shell_chrome',
  sidebar: 'crish_sidebar_collapsed',
  uiSize: 'crish_ui_size',
  tabMode: 'crish_tab_mode',
};

let cached: MinimalConfig | null = null;

export function getMinimalConfig(): MinimalConfig {
  if (cached) return cached;
  try {
    const sidebar = localStorage.getItem(KEYS.sidebar) === '1';
    const chrome = localStorage.getItem(KEYS.shellChrome);
    const size = localStorage.getItem(KEYS.uiSize) || 'medium';
    const tab = localStorage.getItem(KEYS.tabMode) !== '0';
    const theme = document.documentElement.getAttribute('data-theme') || 'default';
    cached = { sidebarCollapsed: sidebar, shellChromeMode: chrome, uiSize: size, tabModeEnabled: tab, theme };
  } catch {
    cached = { sidebarCollapsed: false, shellChromeMode: null, uiSize: 'medium', tabModeEnabled: true, theme: 'default' };
  }
  return cached;
}

export async function loadMinimalConfig(): Promise<MinimalConfig> {
  return getMinimalConfig();
}
```

### 阶段 2: 完整 UI (200-500ms)

**目标**: 全部 UI 就绪，可交互

#### `src/bootstrap-full.ts` (新增)

```typescript
// 完整启动：代码分割 + 后台连接 + 懒加载

export async function bootstrapFull(): Promise<void> {
  const start = performance.now();

  // 并行加载完整模块
  await Promise.all([
    // 1. 代码分割组件在 App 内用 React.lazy 处理
    // 2. 后台连接 daemon WebSocket
    (async () => {
      const { ensureDaemonConnected } = await import('./api/daemonChatBridge');
      ensureDaemonConnected().catch(() => {});
    })(),

    // 3. 同步引擎配置
    (async () => {
      const { clientApi } = await import('./api/clientApi');
      try {
        const settings = await clientApi.getSettings();
        if (settings?.theme) {
          const { applyTheme, normalizeTheme } = await import('./api/themeStore');
          applyTheme(normalizeTheme(settings.theme));
        }
      } catch {}
    })(),

    // 4. 会话元数据加载（不加载消息正文）
    (async () => {
      const { loadSessionIndexOnly } = await import('./store/sessionIndexLoader');
      await loadSessionIndexOnly();
    })(),
  ]);

  // 5. 剩余 Worker 在 idle 时创建
  scheduleIdleWorkers();

  console.debug(`[perf] bootstrapFull: ${performance.now() - start}ms`);
}

function scheduleIdleWorkers(): void {
  const task = () => {
    const { growWorkerPool } = await import('./worker/pool');
    growWorkerPool(navigator.hardwareConcurrency || 4);
  };
  if ('requestIdleCallback' in window) {
    requestIdleCallback(task, { timeout: 3000 });
  } else {
    setTimeout(task, 2000);
  }
}
```

## 3. 代码分割策略

### `App.tsx` — 所有组件改为懒加载

```typescript
// 静态导入仅保留 React、Zustand、最小类型
import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react';
import { useLayoutStore } from './store/layoutStore';
import { matchShortcutActions } from './api/shortcutBindings';

// 其余全部懒加载
const Sidebar = lazy(() => import('./components/Sidebar').then(m => ({ default: m.Sidebar })));
const Workspace = lazy(() => import('./components/Workspace').then(m => ({ default: m.Workspace })));
const WorkspaceChromeBars = lazy(() => import('./components/WorkspaceChromeBars').then(m => ({ default: m.WorkspaceChromeBars })));
const SettingsPanel = lazy(() => import('./components/SettingsPanel').then(m => ({ default: m.SettingsPanel })));
const ChatCard = lazy(() => import('./components/ChatCard').then(m => ({ default: m.ChatCard })));
const ToastStack = lazy(() => import('./components/ToastStack').then(m => ({ default: m.ToastStack })));
const RuntimeFloatPanel = lazy(() => import('./components/RuntimeFloatPanel').then(m => ({ default: m.RuntimeFloatPanel })));
const CheatsheetModal = lazy(() => import('./components/CheatsheetModal').then(m => ({ default: m.CheatsheetModal })));
const FirstRunWizard = lazy(() => import('./components/FirstRunWizard').then(m => ({ default: m.FirstRunWizard })));
const AppErrorBoundary = lazy(() => import('./components/AppErrorBoundary').then(m => ({ default: m.AppErrorBoundary })));
const IconSidebarLeft = lazy(() => import('./components/SidebarToggleIcons').then(m => ({ default: m.IconSidebarLeft })));
const IconSidebarRight = lazy(() => import('./components/SidebarToggleIcons').then(m => ({ default: m.IconSidebarRight })));
```

### 分割点清单

| 模块 | 分割策略 | 加载时机 |
|------|---------|---------|
| `Sidebar` | `React.lazy` | App mount |
| `Workspace` | `React.lazy` | App mount |
| `WorkspaceChromeBars` | `React.lazy` | App mount |
| `ChatCard` | `React.lazy` | 会话激活 |
| `DiffCard` | `React.lazy` | 用户点击 diff |
| `SettingsPanel` | `React.lazy` (已有) | 用户点击设置 |
| `ChatMessageList` | `React.lazy` | 会话激活 |
| `RuntimeFloatPanel` | `React.lazy` | 用户点击运行 |
| `ToastStack` | `React.lazy` | App mount |
| `FirstRunWizard` | `React.lazy` | 首次运行 |
| `CheatsheetModal` | `React.lazy` | 用户打开快捷键 |
| Lucide icons | 按需导入 | 组件渲染时 |
| `themeStore` / `fontStore` | 动态 `import()` | 阶段 2 |
| `clientApi` | 动态 `import()` | 阶段 2 |
| `daemonClient` | 动态 `import()` | 阶段 2 |

## 4. CSS 分割

### `index.css` 改为按需加载

```css
/* index.css — 仅保留核心 tokens + 骨架相关样式 */
@import './styles/tokens.css';
/* 其余 CSS 在对应组件中引入，或通过 Vite CSS code-split 自动处理 */
```

### 组件级 CSS

```typescript
// 每个懒加载组件同级放置 CSS
// DiffCard.tsx
import './DiffCard.css';
// Vite 自动将 CSS 打包到对应 chunk
```

### CSS 加载优先级

```
Phase 0: tokens.css (15KB) → 骨架屏
Phase 1: shell.css (108KB) → 侧栏、顶栏
Phase 2: chat.css (34KB) + panels.css (18KB) + settings.css (184KB) → 其余 UI
         theme-dark.css (31KB) → 深色主题（按需）
```

## 5. Worker 池设计

### `src/worker/pool.ts` (新增)

```typescript
type WorkerKind = 'markdown' | 'highlight' | 'background';

interface PoolWorker {
  kind: WorkerKind;
  worker: Worker;
  busy: boolean;
}

let pool: PoolWorker[] = [];

export function initWorkerPool({ minWorkers, maxWorkers }: { minWorkers: number; maxWorkers: number }): void {
  const count = Math.min(minWorkers, maxWorkers);
  for (let i = 0; i < count; i++) {
    spawnWorker(i === 0 ? 'markdown' : 'highlight');
  }
}

function spawnWorker(kind: WorkerKind): PoolWorker | null {
  try {
    const url = kind === 'markdown'
      ? new URL('../workers/markdown.worker.ts', import.meta.url)
      : new URL('../workers/highlight.worker.ts', import.meta.url);
    const worker = new Worker(url, { type: 'module' });
    const pw: PoolWorker = { kind, worker, busy: false };
    pool.push(pw);
    return pw;
  } catch {
    return null;
  }
}

export function growWorkerPool(target: number): void {
  const kinds: WorkerKind[] = ['markdown', 'highlight', 'background'];
  while (pool.length < target) {
    const kind = kinds[pool.length % kinds.length];
    spawnWorker(kind);
  }
}

export function getWorker(kind: WorkerKind): Worker | null {
  // 找空闲 worker，或轮询
  const free = pool.find(w => w.kind === kind && !w.busy);
  if (free) {
    free.busy = true;
    free.worker.onmessage = () => { free.busy = false; };
    return free.worker;
  }
  return null;
}
```

### Worker 文件

#### `src/workers/markdown.worker.ts` (新增)

```typescript
// 在 worker 线程中执行 markdown 解析
// 利用 highlight.js 在 worker 中高亮代码块

import { marked } from 'marked'; // 若使用 marked
// 或使用轻量 marked 替代品 (marked 本身 ~30KB gzip)

self.onmessage = (e: MessageEvent) => {
  const { id, text } = e.data;
  try {
    // 解析 markdown → HTML
    const html = parseMarkdown(text);
    self.postMessage({ id, html, ok: true });
  } catch (err) {
    self.postMessage({ id, error: String(err), ok: false });
  }
};

function parseMarkdown(text: string): string {
  // 轻量解析：只做基本渲染，无缓存
  // ...
}
```

#### `src/workers/highlight.worker.ts` (新增)

```typescript
// 代码高亮 worker
// highlight.js ~80KB gzip，放在 worker 中不阻塞主线程

import hljs from 'highlight.js';

self.onmessage = (e: MessageEvent) => {
  const { id, code, language } = e.data;
  try {
    const result = language
      ? hljs.highlight(code, { language }).value
      : hljs.highlightAuto(code).value;
    self.postMessage({ id, html: result, ok: true });
  } catch (err) {
    self.postMessage({ id, error: String(err), ok: false });
  }
};
```

## 6. 模块预热 (Preload)

### `src/hooks/usePreloader.ts` (新增)

```typescript
import { useEffect } from 'react';

type PreloadTask = () => void;

const QUEUE: PreloadTask[] = [];
let scheduled = false;

function scheduleFlush(): void {
  if (scheduled) return;
  scheduled = true;
  const flush = () => {
    scheduled = false;
    while (QUEUE.length > 0) {
      const task = QUEUE.shift()!;
      try { task(); } catch {}
    }
  };
  if ('requestIdleCallback' in window) {
    requestIdleCallback(flush, { timeout: 2000 });
  } else {
    setTimeout(flush, 1000);
  }
}

export function preload(fn: PreloadTask): void {
  QUEUE.push(fn);
  scheduleFlush();
}

// 在 App 挂载后调用
export function usePreloader(): void {
  useEffect(() => {
    // 优先队列：用户最可能先交互的模块优先 preload
    preload(() => {
      import('../components/DiffCard');
      import('../components/ChatMessageList');
    });
    // 次级
    setTimeout(() => {
      preload(() => {
        import('../components/SettingsPanel');
        import('../api/providerProfiles');
        import('../api/markdownRender');
      });
    }, 3000);
    // Worker 预热
    setTimeout(() => {
      preload(() => {
        // 创建 worker 后立即 terminate，浏览器缓存脚本
        const w = new Worker(
          new URL('../workers/markdown.worker.ts', import.meta.url),
          { type: 'module' },
        );
        w.terminate();
      });
    }, 5000);
  }, []);
}
```

## 7. Store 启动优化

### `layoutStore.ts` — 延迟初始化

```typescript
// 改为工厂函数，不在模块作用域执行副作用
export function createLayoutStore(initialState?: Partial<LayoutStoreState>) {
  return create<LayoutStoreState>()(
    immer((set, get) => ({
      // ... 状态定义
      // 但不在 create() 内部读取 localStorage
    }))
  );
}

// 保持单例
let store: ReturnType<typeof createLayoutStore> | null = null;
export function getLayoutStore() {
  if (!store) store = createLayoutStore();
  return store;
}
export const useLayoutStore = new Proxy({}, {
  get(_, prop) {
    return getLayoutStore()[prop as keyof ReturnType<typeof createLayoutStore>];
  },
});
```

> **注意**: 上述 Proxy 方案仅作思路示意。实际实现时，最简单的方案是确保 store 的 `create()` 调用不触发昂贵的 localStorage 读取 — 将 `create` 的 `default` 初始状态设为最小集合，persistence middleware 通过 `partialize` 只持久化必要的字段。

### Session 加载优化

`sessionIndexLoader.ts` (新增):

```typescript
// 只加载会话元数据（标题、时间、模型），不加载消息正文
export async function loadSessionIndexOnly(): Promise<void> {
  const { restoreSessionsFromDiskMirror } = await import('../api/sessionDiskMirror');
  const restored = await restoreSessionsFromDiskMirror();
  if (!restored?.sessions?.length) return;

  // 只填充索引，不加载 messages
  const index = restored.sessions.map(s => ({
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    model: s.model,
    folder: s.folder,
  }));

  const { useLayoutStore } = await import('../store/layoutStore');
  useLayoutStore.setState((state) => {
    // 只设置索引
    state.sessionIndex = index;
    // 消息在用户点击会话时懒加载
  });
}
```

## 8. 轻量维护模式

### `src/api/lightweightMode.ts` (新增)

```typescript
import { isTauriShellFast } from './createSsrGlobals';

export type ResourceLevel = 0 | 1 | 2 | 3;

export interface LightweightConfig {
  enabled: boolean;
  maxSessions: number;
  maxMessages: number;
  workerCount: number;
  disableHighlight: boolean;
  disableMarkdownCache: boolean;
  disableAnimations: boolean;
  disableTelemetry: boolean;
}

let config: LightweightConfig = {
  enabled: false,
  maxSessions: 50,
  maxMessages: 100,
  workerCount: 2,
  disableHighlight: false,
  disableMarkdownCache: false,
  disableAnimations: false,
  disableTelemetry: false,
};

export function getLightweightConfig(): LightweightConfig {
  return config;
}

export function computeLightweightConfig(platformLevel: ResourceLevel): LightweightConfig {
  // Level 0: 低端平台 + 内存压力
  if (platformLevel === 0) {
    config = {
      enabled: true,
      maxSessions: 20,
      maxMessages: 20,
      workerCount: 1,
      disableHighlight: true,
      disableMarkdownCache: true,
      disableAnimations: true,
      disableTelemetry: true,
    };
  }
  return config;
}
```

## 9. 加载时序图

```
                  main.tsx                  DOMContentLoaded
                     │                             │
                     ├─ initSsrGlobals() ──────────┤ (0ms)
                     │                             │
                     ├─ bootstrapCore()            │
                     │  ├─ detectPlatform           │ (并行)
                     │  ├─ initWorkerPool(2)        │
                     │  ├─ loadMinimalConfig        │
                     │  └─ ✓ CoreReady             │
                     │                             │
                     ├─ import('react') ──────────►│
                     ├─ import('App') ────────────►│
                     │                             │
                     ├─ createRoot → render()      │ (50-200ms)
                     │  └─ Suspense fallback        │
                     │     └─ 侧栏骨架              │
                     │                             │
Phase 1 ────────────►│                             │
                     │                             │
                     ├─ bootstrapFull()            │ (200-500ms)
                     │  ├─ import(lazy components) │
                     │  ├─ ensureDaemonConnected   │
                     │  ├─ clientApi.getSettings    │
                     │  └─ loadSessionIndexOnly     │
                     │                             │
Phase 2 ────────────►│  └─ Full UI rendered        │ (500ms)
                     │                             │
                     ├─ preloadModules()           │ (idle)
                     │  ├─ preload DiffCard        │
                     │  ├─ preload SettingsPanel   │
                     │  └─ worker warmup           │
                     │                             │
                     ├─ growWorkerPool(full)       │ (idle, 2s+)
                     │                             │
Hot restart ◄────────┤ (10ms restore from memory)  │
```

## 10. 热启动优化 (Tab 切回)

```typescript
// src/hot-restart.ts
// Tauri 桌面端：窗口隐藏后恢复，避免重新初始化

const SESSION_CACHE = new Map<string, {
  scrollPosition: number;
  expandedCards: string[];
  collapsedSections: string[];
  composerDraft: string;
}>();

export function captureSessionUI(sessionId: string, state: { ... }): void {
  SESSION_CACHE.set(sessionId, state);
}

export function restoreSessionUI(sessionId: string) {
  return SESSION_CACHE.get(sessionId);
}

// 在 App.tsx 中监听 visibilitychange
useEffect(() => {
  const handleVisibility = () => {
    if (document.hidden) {
      // 保存当前 UI 状态到内存
      captureSessionUI(activeSessionId, {
        scrollPosition: chatContainerRef.current?.scrollTop ?? 0,
        // ...
      });
    } else {
      // 从内存恢复 — 10ms
      const cached = restoreSessionUI(activeSessionId);
      if (cached) {
        chatContainerRef.current?.scrollTo(0, cached.scrollPosition);
      }
    }
  };
  document.addEventListener('visibilitychange', handleVisibility);
  return () => document.removeEventListener('visibilitychange', handleVisibility);
}, [activeSessionId]);
```

## 11. 文件改动清单

### 新增文件

| 文件 | 用途 |
|------|------|
| `src/createSsrGlobals.ts` | 最小全局初始化，在 React 加载前运行 |
| `src/bootstrap-core.ts` | 阶段 1 核心启动 |
| `src/bootstrap-full.ts` | 阶段 2 完整启动 |
| `src/store/minimalConfig.ts` | 仅读最小 localStorage key |
| `src/store/sessionIndexLoader.ts` | 仅加载会话元数据 |
| `src/worker/pool.ts` | Worker 池管理 |
| `src/workers/markdown.worker.ts` | Markdown 渲染 Worker |
| `src/workers/highlight.worker.ts` | 代码高亮 Worker |
| `src/hooks/usePreloader.ts` | idle 模块预热 |
| `src/api/lightweightMode.ts` | 轻量维护模式 |
| `src/api/platformDetect.ts` | 硬件/平台检测 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `index.html` | 内联骨架屏 + 预加载主题标记 |
| `src/main.tsx` | 三阶段异步入口 |
| `src/App.tsx` | 全部组件改为 `React.lazy` + Suspense |
| `src/index.css` | 只保留 tokens.css，其余按需加载 |
| `src/store/layoutStore.ts` | 移除 `create()` 中的 localStorage 同步读取 |
| `src/api/appMode.ts` | 改用 SSR_GLOBALS 快速路径 |
| `src/api/productMode.ts` | 改用 SSR_GLOBALS 快速路径 |
| `src/api/daemonClient.ts` | 延迟连接（不在 import 时自动连接） |
| `src/api/markdownRender.ts` | 改用 Worker 代理渲染 |
| `src/api/codeHighlight.ts` | 改用 Worker 代理高亮 |
| `vite.config.ts` | 添加 manualChunks 策略 |
| `tsconfig.app.json` | 无必要改动 |

### Vite 分块策略

```typescript
// vite.config.ts
build: {
  rollupOptions: {
    output: {
      manualChunks: {
        'vendor-react': ['react', 'react-dom'],
        'vendor-zustand': ['zustand', 'immer'],
        'vendor-lucide': ['lucide-react'],
        'vendor-highlight': ['highlight.js'],
        'vendor-fonts': [
          '@fontsource/inter',
          '@fontsource/jetbrains-mono',
          '@fontsource/ibm-plex-sans',
          '@fontsource/ibm-plex-mono',
        ],
      },
    },
  },
},
```

## 12. 性能测量

在 `window.__crish_perf` 上挂载标记：

```typescript
// 在 bootstrap-core.ts 结束时
window.__crish_perf = {
  ...window.__crish_perf,
  coreReady: performance.now(),
};

// 在 App 首次渲染后
window.__crish_perf = {
  ...window.__crish_perf,
  firstPaint: performance.now(),
  interactive: performance.now(),
};

// 在 bootstrap-full 完成
window.__crish_perf = {
  ...window.__crish_perf,
  fullReady: performance.now(),
};
```

### 测量指标与目标

| 指标 | 实现方式 | 目标 |
|------|---------|------|
| 骨架屏显示 | `performance.mark('skeleton')` | <50ms |
| 核心 UI 可交互 | `firstPaint - navigationStart` | <200ms |
| 完整 UI 就绪 | `fullReady - navigationStart` | <500ms |
| WebSocket 连接 | `daemonConnected - navigationStart` | <1s |
| Worker 池就绪 | `workerReady - navigationStart` | <500ms |
| 热启动恢复 | `visibilitychange → restore` | <10ms |
| TTI (Time to Interactive) | Lighthouse TTI | <500ms |

## 13. 实施优先序

### Sprint 1: 骨架屏 + 异步入口 (2-3d)
- `index.html` 内联骨架屏
- `createSsrGlobals.ts`
- 重写 `main.tsx` 为三阶段
- `bootstrap-core.ts`
- `minimalConfig.ts`

### Sprint 2: 代码分割 (2-3d)
- `App.tsx` 全部 `React.lazy`
- CSS 按需加载
- Vite manualChunks
- Suspense fallback 组件

### Sprint 3: Worker 池 (2d)
- `worker/pool.ts`
- `markdown.worker.ts`
- `highlight.worker.ts`
- 改造 `markdownRender.ts` / `codeHighlight.ts`

### Sprint 4: 预热 + 轻量模式 (2d)
- `usePreloader.ts`
- `lightweightMode.ts`
- `platformDetect.ts`
- 热启动优化

### Sprint 5: 测试 + 调优 (2d)
- 性能标记
- Lighthouse CI 集成
- 各阶段超时兜底
- 边界情况处理
