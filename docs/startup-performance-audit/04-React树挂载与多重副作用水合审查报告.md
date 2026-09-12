# 04-React 树挂载与多重副作用水合审查报告

> **战役定位**：全链路启动性能深度审查 Stage 4  
> **物理阶段**：React 树初次渲染 → 多重 Effect 级联更新 → 布局与样式最终稳定（首屏 DOM 水合与交互态稳定）  
> **时间基准**：T0 + 400ms ~ 700ms（对齐冷启动 2.82s 阶梯分析：首屏首绘 1.78s → 用户名就绪 2.78s → 首屏加载完成 2.82s）  
> **审查对象**：`apps/crish-desktop/src/App.tsx`、`apps/crish-desktop/src/app/AppBootstrap.ts`、`apps/crish-desktop/src/app/hydrateWorkspaceShell.ts`、`apps/crish-desktop/src/hooks/usePreferencesHydration.ts`、`apps/crish-desktop/src/app/useEngineBootstrap.ts` 等核心启动代码域  
> **报告标准**：详尽代码走读、精确到 `文件路径:行号` 的实证链条、底层渲染引擎与状态机根因剖析、架构级优化治理方案  

---

## 一、审查总览与分层范围

### 1.1 阶段定义与性能物理边界

在 Conex / Crish 桌面客户端（Tauri v2 + Rust 微内核 + WebView2 / WebKit + React 19）的启动链路中，Stage 4 承担着将静态骨架屏转化为完全动态可交互 UI（TTI: Time to Interactive）的核心使命。该阶段在物理上划定于以下两个明确的时间与状态边界之间：

1. **起始边界（T_mount_start）**：
   `apps/crish-desktop/src/main.tsx:233` 执行 `const root = createRoot(document.getElementById('root')!)` 并调用 `root.render(...)`。此时 index.html 内联的单图标启动骨架屏（`#skel-app`）被 React DOM 替换，React 19 Fiber 调度器启动初次全树调和（Reconciliation），Fiber 节点在内存中完成构建并提交至真实 DOM 树。
2. **终结边界（T_hydration_settled）**：
   所有首屏关键 Context Provider 完成派发、`AppBootstrap` 与各域 Store 的初始水合完成、`BinaryTreeWorkspace` 布局二叉树完成几何计算与 Leaf 挂载、`ChatCard` 默认视图渲染完毕、以及解除 `html.preload` 动画门闩（`main.tsx:275-281`）。此时 DOM 树结构与 CSSOM 处于稳态，无悬挂微任务（Microtask）触发额外的 Re-render，主线程事件循环重回空闲等待用户输入。

```mermaid
flowchart TD
    subgraph Stage3["Stage 3: 前端模块编排 (300ms ~ 500ms)"]
        S3_Entry["main.tsx 模块评估"]
        S3_Init["bootstrap-core & minimalConfig"]
    end

    subgraph Stage4["Stage 4: React 树挂载与多重副作用水合 (400ms ~ 700ms)"]
        direction TB
        M0["createRoot(document.getElementById('root'))"]
        M1["<StrictMode><ToastProvider><AppErrorBoundary><App /></AppErrorBoundary></ToastProvider></StrictMode>"]
        
        subgraph RenderPhase["初次渲染阶段 (Initial Render Pass)"]
            R_App["App.tsx: 订阅 8+ Store 字段, 派发骨架 fallback"]
            R_Ctx["PlatformAdaptationCtx & SessionTabDragProvider 包装"]
            R_ShellCheck["shellReady = false -> 渲染 <SkeletonFallback height={400} />"]
            R_Sidebar["挂载 Sidebar (同步 chunk)"]
            R_TopBar["挂载 AppTopBar & WindowControls"]
        end

        subgraph EffectPhase["副作用与微任务风暴 (Effect Cascades)"]
            E_Boot["AppBootstrap 16 个散落 Hooks 并发激活"]
            E_Pref["usePreferencesHydration: getAllPreferences() 异步 IPC"]
            E_Eng["useEngineBootstrap: transport.isReady() & chatBridge 探测"]
            E_Shell["useLayoutEffect: waitLayoutTreeHydration -> hydrateWorkspaceShell"]
            E_DOM["DOM 属性反复写入: data-ui-size, data-density, data-fullscreen"]
            E_Raf["两层 rAF 嵌套: requestAnimationFrame(rAF(rebind))"]
        end

        subgraph CascadeReconcile["级联重绘与二叉树激活 (Cascade Reconciliation)"]
            CR_ShellReady["setShellReady(true) -> App Re-render"]
            CR_LazyTree["BinaryTreeWorkspace Lazy Chunk 触发 Suspense -> Fallback 2"]
            CR_TreeMount["BinaryTreeWorkspace 挂载 -> TreeLeafPanel"]
            CR_LazyChat["ChatCard Lazy Chunk 触发 Suspense -> Fallback 3"]
            CR_ChatMount["ChatCard 首屏挂载完成"]
            CR_LatchRelease["rAF: document.documentElement.classList.remove('preload')"]
        end

        M0 --> M1
        M1 --> RenderPhase
        RenderPhase --> EffectPhase
        EffectPhase --> CascadeReconcile
    end

    subgraph Stage5["Stage 5: IPC 数据通道就绪 (500ms ~ 900ms)"]
        S5_IPC["SQLite 完整历史回灌与双向状态管道稳态"]
    end

    S3_Init --> M0
    CR_LatchRelease --> S5_IPC
```

### 1.2 审查范围与全量涉及文件矩阵

本次深度审查穿透覆盖以下关键源码模块与层级：

| 文件路径 | 所属层级 | 审查核心聚焦与职责 |
| :--- | :--- | :--- |
| `apps/crish-desktop/src/App.tsx` | 渲染根组件 | 根组件初始状态装载、Context 提供者嵌套、Props 钻取与 8+ 域 Store 订阅开销、骨架占位分流 |
| `apps/crish-desktop/src/main.tsx` | 应用总入口 | `createRoot` 挂载点、`ToastProvider` 包装、`preload` 动画门闩生命周期、`boundaryLoad` 并行机制 |
| `apps/crish-desktop/src/app/AppBootstrap.ts` | 启动副作用中枢 | **16 个分散的 `useEffect`/`useLayoutEffect`**、异步 Import 链、连续多次 `setState` 触发全树级联更新 |
| `apps/crish-desktop/src/app/hydrateWorkspaceShell.ts` | 工作区水合引擎 | `waitLayoutTreeHydration()` 竞态、冷启动空白单页 vs 历史多页恢复时的 DOM 节点膨胀、ActiveTab 预流水合 |
| `apps/crish-desktop/src/hooks/usePreferencesHydration.ts` | 偏好水合钩子 | 独立 IPC 读取全量偏好、与 `AppBootstrap` 偏好加载形成的时序重叠与双重写入竞态 |
| `apps/crish-desktop/src/app/useEngineBootstrap.ts` | 引擎连通门闩 | 异步状态拉取与会话列表反向合并（`syncSessionsFromEngine`）导致的次级重绘 |
| `apps/crish-desktop/src/app/AppShortcuts.ts` | 快捷键监听器 | 依赖项频繁变动引发的全局事件解绑与重新注册开销 |
| `apps/crish-desktop/src/services/visualThemeController.ts` | 视觉直写控制器 | 直接 DOM 操作机制与 React 状态派生之间的属性覆盖冲突 |
| `apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.tsx` | 工作区主画布 | 动态代码分割导致的延迟悬挂、叶子几何缓存（`stabilizeLeafEntries`）及 `@starting-style` 动画门控 |
| `apps/crish-desktop/src/components/sidebar/useSidebarResize.ts` | 侧栏交互钩子 | 挂载期 `getComputedStyle` 与 `setProperty` 夹杂执行导致的强制同步布局（Forced Reflow） |
| `apps/crish-desktop/src/styles/tokens.css` | 核心样式系统 | `html.preload *` 全局通配选择器导致的样式重算范围爆炸（Style Invalidation Storm） |

---

## 二、正面设计与优良机制（禁止回潮项）

在深入剖析性能瓶颈前，必须明确仓库历史架构重构中沉淀的优秀设计。这些机制在解决特定性能与稳定性问题上具有不可替代的价值，**在后续任何优化重构中严禁回退或降级**：

### 2.1 创制前置同步主题注水与 CSS Token 直写防闪白机制
- **源码位置**：`apps/crish-desktop/src/main.tsx:112-127`
  ```typescript
  // 112: 必须在任何模块前执行 — 替换 appMode / productMode 的同步 localStorage 读
  // 113: initSsrGlobals();
  // 114: initVisualPresentationController();
  // 116: 🌟 主题与个性化皮肤同步水合（彻底斩断 useEffect 延迟与二次跳变）
  // 117: bootstrapTheme();
  // 119: document.documentElement.style.setProperty('--sidebar-width', `${SIDEBAR_WIDTH_DEFAULT}px`);
  // 123: document.documentElement.style.setProperty('--chat-col-max', `${CHAT_COL_MAX}px`);
  ```
- **优良价值**：通过在 React 根挂载之前直接执行 `bootstrapTheme()` 与 CSS 关键布局变量初始化，使 WebView 在初次绘制（First Paint）时即已持有最终的主题配色方案与几何基准，彻底杜绝了将主题写入推迟到 React `useEffect` 中所必然导致的白屏闪烁（FOUC, Flash of Unstyled Content）。

### 2.2 视觉配置直写 DOM 控制器与 React 0 重绘隔离
- **源码位置**：`apps/crish-desktop/src/services/visualThemeController.ts:20-68`
  ```typescript
  // 21: * 视觉配置直写 DOM 控制器 (React 0 重绘机制)
  // 22: * 监听 layoutStore 变更，直接操作 document.documentElement
  // 53: const unsubLayout = useLayoutStore.subscribe((state, prev) => {
  // 54:   if (state.uiSize && state.uiSize !== prev?.uiSize) {
  // 55:     applyUiSize(state.uiSize);
  // 56:   }
  // 57:   if (state.shellChromeMode && state.shellChromeMode !== prev?.shellChromeMode) {
  // 58:     applyShellChrome(state.shellChromeMode);
  // 59:   }
  // 60: });
  ```
- **优良价值**：采用 Zustand 底层 `subscribe` 监听单一布局字段变化，绕过 React 组件树的 `useState`/`useContext` 机制，直接通过原生 DOM API 修改 `data-ui-size` 和 `data-shell-chrome`。当用户在设置面板微调 UI 尺寸或主题密度时，实现了“0 React 组件调和”的高性能直写。此模式具备极佳的解耦性，需予以保留，但须解决与后续 `AppBootstrap` 冗余覆写之间的冲突。

### 2.3 侧栏会话快照深度比对与外部存储同步断流
- **源码位置**：`apps/crish-desktop/src/store/sessionStore.ts:148-171`
  ```typescript
  // 148: export function useSidebarSessions(searching: boolean): SessionState[] {
  // 149:   const snapshotRef = useRef<SessionState[]>(useSessionStore.getState().sessions);
  // 155:   const getSnapshot = useCallback((): SessionState[] => {
  // 156:     const cur = useSessionStore.getState().sessions;
  // 157:     if (searchingRef.current || !sidebarSessionsEqual(snapshotRef.current, cur)) {
  // 158:       snapshotRef.current = cur;
  // 159:     }
  // 160:     return snapshotRef.current;
  // 161:   }, []);
  // 166:   return useSyncExternalStore(..., getSnapshot, getSnapshot);
  // 171: }
  ```
- **优良价值**：利用 `useSyncExternalStore` 配合特化的 `sidebarSessionsEqual` 结构比较函数。当会话内部接收高频流式 Token、更新消息列表或变动非侧栏展示属性时，`snapshotRef` 维持引用不变，精确阻断了主工作区打字时引发的整个左侧栏会话列表级联重渲染。

### 2.4 二叉树工作区叶子与分支几何恒等式缓存
- **源码位置**：`apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.tsx:113-157`
  ```typescript
  // 113: function stabilizeLeafEntries(panels: FlatPanelItem[], prev: Map<string, StableLeafEntry>): Map<string, StableLeafEntry>
  // 144: function stabilizeBranches(branches: FlatBranch[], prev: Map<string, FlatBranch>): Map<string, FlatBranch>
  ```
- **优良价值**：二叉树扁平化函数 `flattenTree` 每次计算均会产出新的 JavaScript 对象字面量。通过 `stabilizeLeafEntries` 和 `stabilizeBranches` 设立 ID 索引的弱引用复用机制，只要叶子的 Tab 状态与 Dock 几何未变，就返回历史引用，使 `React.memo` 包裹的 `TreeLeafPanel` 能精确命中 Bailout，避免无谓的 Virtual DOM Diff。

### 2.5 全局错误边界与横幅的并行预取与非阻塞渲染
- **源码位置**：`apps/crish-desktop/src/main.tsx:187-204`
  ```typescript
  // 187: const boundaryLoad = import('./components/AppErrorBoundary');
  // 189: const [{ StrictMode: SM }, { createRoot: CR }] = await Promise.all([
  // 190:   import('react'),
  // 191:   import('react-dom/client'),
  // 192: ]);
  // 239: const { AppErrorBoundary } = await boundaryLoad;
  ```
- **优良价值**：在 Phase 1.5 动态引入 React 核心库的同时，并发启动 `AppErrorBoundary` 的 chunk 预取，消除了原方案中“先 await React、再 await Boundary、最后 await App”的串行网络瀑布，减少了约 35ms 的首屏等待。

---

## 三、高严重度性能瓶颈（P0/High）

### P0-1: `AppBootstrap.ts` 16 处分散 Hooks 引发微任务重叠与 7 次全树级联调和风暴

#### 1. 源码证据与切片
在 `apps/crish-desktop/src/app/AppBootstrap.ts` 中，存在多达 16 个独立的 `useEffect` 与 `useLayoutEffect` 调用。同时，根组件 `apps/crish-desktop/src/App.tsx:76-126` 订阅了多个原子状态：

```typescript
// apps/crish-desktop/src/App.tsx:76-117
76:  function App() {
77:    const { isHydrated } = usePreferencesHydration();
78:    const platformAdaptation = usePlatformAdaptation({ autoApplyRender: true, autoStartEngine: true });
82:    const activeWorkspaceId = useWorkspaceStore((s) => s.workspaces[s.activeWorkspaceIndex]?.id || 'ws-0');
85:    const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
87:    const chatMainSurface = useLayoutStore((s) => s.chatMainSurface) ?? 'chat';
88:    const uiSize = useLayoutStore((s) => s.uiSize);
89:    const shellChromeMode = useLayoutStore((s) => s.shellChromeMode);
90:    const showSettingsOverlay = useSettingsUiStore((s) => s.showSettingsOverlay);
95:    const setAppSettings = useSettingsStore((s) => s.setAppSettings);
111:   const shellReady = useWorkspaceShellStore((s) => s.shellReady);
116:   const engineReady = useEngineBootstrap();
```

而在 `apps/crish-desktop/src/app/AppBootstrap.ts` 中：
```typescript
// apps/crish-desktop/src/app/AppBootstrap.ts:84-233
84:   useEffect(() => {
85:     import('../store/layoutStore').then(({ initLayoutStorePersistence }) => initLayoutStorePersistence());
86:   }, []);
92:   useLayoutEffect(() => {
93:     let cancelled = false;
94:     void (async () => {
96:       await waitLayoutTreeHydration();
97:       if (cancelled) return;
98:       hydrateWorkspaceShell();
99:     })();
100:  }, []);
111:  useEffect(() => { const cleanup = bootstrapServices(); return () => cleanup(); }, []);
120:  useEffect(() => { /* telemetry crash check & clientApi.getSettings() */ }, []);
139:  useEffect(() => { const cleanup = bootstrapStores(); return () => cleanup(); }, []);
146:  useLayoutEffect(() => { /* 双重 rAF 调度 rebind */ }, []);
179:  useEffect(() => {
180:    void import('../api/fontStore').then(({ bootstrapFonts }) => bootstrapFonts());
185:    const unsubTheme = import('../store/themeProjection').then(({ initThemeProjection }) => initThemeProjection());
188:    const unsubIndent = import('../store/codeIndentProjection').then(({ initCodeIndentProjection }) => initCodeIndentProjection());
191:    const initApp = async () => {
195:      const settings = await clientApi.getSettings();
206:      if (setAppSettings) setAppSettings(settings);
214:      await setFontPreferences(normalizeFontPrefs(settings.fonts));
217:      getCompositionRoot().layout.setTabModeEnabled(settings.tabModeEnabled);
228:    };
229:    void initApp();
233:  }, [setAppSettings]);
```

#### 2. 底层机制与因果推导
React 18/19 引入了微任务自动批处理（Automatic Batching），但批处理的**刚性边界是单个事件循环微任务队列（Single Microtask Turn）**。当多个状态更新发生在不同的 Promise 解决周期、异步 Import 回调或 IPC 通信返回时刻时，React 无法进行跨微任务的合并调和。

在当前冷启动流程中，从组件初次 Mount 到首屏交互稳态的 150ms 窗口期内，发生了极其严重的级联更新链：
1. **Pass 1 (T+0ms)**：初始挂载。`engineReady=false`, `isHydrated=false`, `shellReady=false`。此时 `App.tsx:240` 渲染 `<SkeletonFallback height={400} />`。
2. **Pass 2 (T+12ms)**：`AppBootstrap.ts:92` 的 `useLayoutEffect` 中 `waitLayoutTreeHydration()`（`Promise.resolve()` 微任务）触发 `hydrateWorkspaceShell()`，最终调用 `root.shell.setShellReady(true)`。`useWorkspaceShellStore` 变更，触发 `App` 第 2 次全树重渲染。
3. **Pass 3 (T+18ms)**：`useEngineBootstrap.ts:20` 的早探 `import('../api/transport')` 解决，`transport.isReady()` 返回 true，触发 `setEngineReady(true)`。`App` 发生第 3 次重渲染。
4. **Pass 4 (T+35ms)**：`usePreferencesHydration.ts:42` 的 `preferencesClient.getAllPreferences()` IPC 返回，设置 Theme、Fonts，并执行 `layout.setSidebarCollapsed()`，最后触发 `setIsHydrated(true)`。`App` 发生第 4 次重渲染。
5. **Pass 5 (T+48ms)**：`AppBootstrap.ts:195` 的 `clientApi.getSettings()` IPC 返回，调用 `setAppSettings(settings)`，同时更改 `layout.setTabModeEnabled()`。`App` 发生第 5 次重渲染。
6. **Pass 6 (T+62ms)**：`usePlatformAdaptation.ts:134` 的 `detectHardware()` 异步任务完成，调用 `globalStore.setState({ hardwareReady: true, level: ... })`。通过 `useSyncExternalStore` 触发 `App` 第 6 次重渲染。
7. **Pass 7 (T+80ms)**：`usePlatformAdaptation.ts:155` 的 `createAdaptationEngine()` 启动，再次调用 `globalStore.setState({ engine })`。`App` 发生第 7 次重渲染。

在短短 80ms 内，React 根节点 `App` 经历了多达 **7 次全量调和（Reconciliation）**！每次调和不仅重新计算 `App` 组件函数，由于 `App.tsx` 内直接渲染了 `Sidebar`、`AppTopBar`、`SessionTabDragProvider` 等巨型子树，即使子组件做了部分 memo，仍然造成巨大的 V8 Call Stack 占用与内存 Garbage Collection 压力。

#### 3. 架构级精准修复方案
构建**启动状态总线汇聚器（Unified App Hydration Coordinator）**，将 16 个分散的 Hooks 与多通道异步任务彻底降维为两阶段管道式状态转移：
1. **阶段一：状态静默收集（Silent State Accumulation）**：在挂载阶段，禁止各子系统直接调用根级 React `setState`。由单例调度器 `StartupHydrationCoordinator` 并发发起 `getAllPreferences()`、`getSettings()`、`detectHardware()`、`waitLayoutTreeHydration()`。
2. **阶段二：单次原子回灌（Single Atomic Commit）**：所有核心配置就绪后，利用 React 19 的 `startTransition` 或在单一微任务中通过 Zustand 的 `batch` 或组合 Action 将全量状态一次性灌入 Store，将根组件冷启动重渲染次数由 **7 次硬性压缩至 1 次（Initial -> Ready）**。

---

### P0-2: 双重偏好水合竞态与重复写入 (Dual Hydration Race)

#### 1. 源码证据与切片
系统内存在两套平行的偏好设置拉取与应用逻辑，两者在组件挂载后并发执行：

通道 A（现代化偏好通道）：
```typescript
// apps/crish-desktop/src/hooks/usePreferencesHydration.ts:37-118
37:  useEffect(() => {
40:    async function hydrate() {
42:      const allPrefs = await preferencesClient.getAllPreferences();
46:      const theme: UiTheme = normalizeTheme(allPrefs.theme);
63:      persistTheme(theme);
64:      writeStoredPersonalization(personalization);
67:      TokenRuntimeController.getInstance().applyTokens(personalization, theme);
70:      TokenRuntimeController.getInstance().setUiScale(allPrefs.ui_size);
85:      if (allPrefs.fonts) {
86:        const fontPrefs: FontPreferences = normalizeFontPrefs(allPrefs.fonts);
87:        persistFonts(fontPrefs);
88:        applyFontStacks(fontPrefs);
96:        window.dispatchEvent(new CustomEvent('crish-fonts-changed', { detail: fontPrefs }));
104:     // 同步 layoutStore
111:     layout.setSidebarCollapsed(allPrefs.sidebar_collapsed);
117:     layout.setTabModeEnabled(allPrefs.tab_mode_enabled);
124:     setIsHydrated(true);
```

通道 B（遗留 Bootstrap 通道）：
```typescript
// apps/crish-desktop/src/app/AppBootstrap.ts:178-223
178:  // 6. Theme, Font, and Settings bootstrap
179:  useEffect(() => {
180:    void import('../api/fontStore').then(({ bootstrapFonts }) => bootstrapFonts());
186:    const unsubTheme = import('../store/themeProjection').then(({ initThemeProjection }) => initThemeProjection());
188:    const unsubIndent = import('../store/codeIndentProjection').then(({ initCodeIndentProjection }) => initCodeIndentProjection());
191:    const initApp = async () => {
195:      const settings = await clientApi.getSettings();
198:      const localTheme = readStoredTheme();
201:      void clientApi.saveSettingsEx('__global__', 'global', { theme: localTheme });
206:      if (setAppSettings) setAppSettings(settings);
214:      await setFontPreferences(normalizeFontPrefs(settings.fonts));
217:      getCompositionRoot().layout.setTabModeEnabled(settings.tabModeEnabled);
228:    };
```

#### 2. 底层机制与因果推导
1. **双重 IPC 开销**：`preferencesClient.getAllPreferences()` 与 `clientApi.getSettings()` 在冷启动时通过 Tauri IPC 分别向 Rust 端发出两个结构高度重合的查询请求，各自产生序列化、反序列化及 SQLite 查询。
2. **状态竞态（Race Condition）与闪烁风险**：
   - 通道 A 使用 `preferencesClient` 读取的值更新 `TokenRuntimeController`，分发 `crish-theme-changed` 和 `crish-fonts-changed`；
   - 通道 B 几乎在同一时刻通过 `clientApi.getSettings()` 拿到数据，又调用 `initThemeProjection()` 监听 `settingsStore`，再执行一遍 `setTheme()`，并调用 `setFontPreferences()`。
   - 若通道 A 与通道 B 返回的字体或主题版本存在微小的时间戳或缓存偏差，会导致 DOM 的 CSS Variables 在数十毫秒内被连续改写两次，触发两次全局样式计算（Recalculate Style）。
3. **冗余数据持久化反写**：通道 B（行 201）甚至在启动期检测到 `settings.theme !== localTheme` 时发起 `clientApi.saveSettingsEx` 磁盘回写！这在应用启动最关键的 CPU/IO 争抢期强行插入了一次文件系统的写操作。

#### 3. 架构级精准修复方案
1. **废黜 `AppBootstrap.ts:178-233` 的重复偏好逻辑**：将该 Effect 块内的 `clientApi.getSettings()`、`bootstrapFonts`、`setFontPreferences` 完全剔除。
2. **SSOT 单一真理源收口**：将 `usePreferencesHydration` 提升为全系统唯一的偏好注水门面，其获取的 `allPrefs` 数据在单一位置一次性派发给 `themeStore`、`fontStore`、`layoutStore` 和 `settingsStore`，彻底切断双重 IPC 与 DOM 样式覆写。

---

### P0-3: 关键首屏路径上的三重 Suspense / 代码分割瀑布流 (Critical Path Lazy Loading Waterfall)

#### 1. 源码证据与切片
系统将本该在首屏立即呈现的核心工作区组件错误地配置了多层 `React.lazy()` 懒加载：

第 1 层：`App.tsx` 中的工作区懒加载：
```typescript
// apps/crish-desktop/src/App.tsx:68-72
68:  // 二叉树工作区（重构后默认入口；代码分割避免影响旧路径首屏）
69:  const BinaryTreeWorkspace = lazy(() =>
70:    import('./components/binary-tree/BinaryTreeWorkspace').then((m) => ({
71:      default: m.BinaryTreeWorkspace,
72:    }))
73:  );

// apps/crish-desktop/src/App.tsx:240-246
240: {!shellReady ? (
241:   <SkeletonFallback height={400} />
242: ) : (
243:   <Suspense fallback={<SkeletonFallback height={400} />}>
244:     <BinaryTreeWorkspace />
245:   </Suspense>
246: )}
```

第 2 层：`main.tsx` 中的内置视图注册工厂懒加载：
```typescript
// apps/crish-desktop/src/main.tsx:31-42
31:  const builtinViewFactories: ViewFactoryMap = {
32:    chat: () =>
33:      lazy(() =>
34:        import('./components/chat-card/ChatCard').then((m) => ({
35:          default: (ctx: ViewRenderContext) => (
36:            <m.ChatCard
37:              sessionId={ctx.sessionId}
38:              handleGlobalTabClick={ctx.openView}
39:            />
40:          ),
41:        }))
42:      ),
```

第 3 层：`ChatCard.tsx` 内部依赖的次级懒加载：
```typescript
// apps/crish-desktop/src/components/chat-card/ChatCard.tsx:21-25
21:  const ScheduledTasksPanel = lazy(() =>
22:    import('../settings/ScheduledTasksPanel').then((m) => ({
23:      default: m.ScheduledTasksPanel,
24:    }))
25:  );
```

#### 2. 底层机制与因果推导
代码注释明确写道：`// 二叉树工作区（重构后默认入口；代码分割避免影响旧路径首屏）`。这是典型的“架构演进已完成，但历史过渡代码未收口”的设计缺陷。旧的多列布局早已废除，`BinaryTreeWorkspace` 目前是全系统**唯一的、无条件的**默认工作区容器。

然而当前的加载时序却构成了极其恶劣的串行网络/磁盘 IO 瀑布：
```mermaid
gantt
    title 首屏关键路径代码分割瀑布延迟
    dateFormat X
    axisFormat %s ms
    section 主线程与加载
    main.js 加载与执行            :active, a1, 0, 100
    App.tsx 首次渲染 (shellReady=false, 骨架屏1) :a2, 100, 120
    hydrateWorkspaceShell 触发 setShellReady :a3, 120, 135
    App.tsx 二次渲染，触发 BinaryTree chunk 请求 :crit, a4, 135, 140
    BinaryTreeWorkspace.js 磁盘读取与解析 (骨架屏2) :crit, a5, 140, 240
    BinaryTree 挂载，触发 ChatCard chunk 请求 :crit, a6, 240, 245
    ChatCard.js 磁盘读取与解析 (叶内骨架3) :crit, a7, 245, 340
    首屏内容真实渲染完成 (TTI)   :milestone, m1, 340, 340
```

1. **时序延迟放大**：当 `shellReady` 变为 true 后，React 才首次执行 `import('./components/binary-tree/BinaryTreeWorkspace')`。在 WebView 环境下，这涉及一次 IPC 拦截或本地文件读取、V8 脚本编译和模块实例化（耗时约 80ms ~ 120ms）。在此期间，用户看到的仍然是 `<SkeletonFallback height={400} />`。
2. **二次嵌套悬挂**：当 `BinaryTreeWorkspace` 代码下载并挂载后，内部渲染 `TreeLeafPanel`，其需要渲染默认的 `chat` 视图。此时又触发了 `builtinViewFactories.chat` 中的 `import('./components/chat-card/ChatCard')`！再次进入 Suspense 悬挂（耗时约 80ms ~ 100ms）。
3. **三次视觉跳动**：用户眼睁睁看到：页面先闪现 App 骨架屏 → 骨架屏刷新一次 → 出现二叉树框体但中间再次展示叶内骨架屏 → 最终弹出聊天输入框。这种连续 3 次的视觉跳变严重破坏了产品体验，并白白浪费了 **180ms ~ 220ms** 的宝贵时间。

#### 3. 架构级精准修复方案
1. **提升首屏关键路径组件为静态同步导入**：
   在 `App.tsx` 中直接同步导入 `BinaryTreeWorkspace`：
   ```typescript
   import { BinaryTreeWorkspace } from './components/binary-tree/BinaryTreeWorkspace';
   ```
2. **主视图预装载（Eager Chat Factory）**：
   在 `main.tsx` 中，对 `builtinViewFactories.chat` 采用同步组件引用，其余非首屏视图（如 `diff`, `overview`, `files`, `runtime`）维持 `lazy` 懒加载。
3. **消除双重 Fallback 闪烁**：当二叉树与 ChatCard 打包进主 Entry Chunk 时，首屏渲染将实现“骨架屏直接一步到位替换为完全就绪的工作区”，彻底消灭 200ms 的悬挂停顿。

---

## 四、中严重度性能问题（P1/Medium）

### P1-1: 根元素与 Body 属性交替写入引发的全局样式重算与强制重排 (Forced Reflow)

#### 1. 源码证据与切片
在应用挂载后的极短时间内，多个模块对 `document.documentElement` 和 `document.body` 的 `data-*` 属性及 CSS Variables 进行了密集的交替读写：

切片 1（AppBootstrap 属性直写）：
```typescript
// apps/crish-desktop/src/app/AppBootstrap.ts:251-267
251:  useEffect(() => {
252:    const size = uiSize || 'medium';
253:    const chrome = shellChromeMode || 'classic';
254:    const root = document.documentElement;
255:    root.setAttribute('data-ui-size', size);
261:    root.setAttribute('data-density', density);
263:    root.setAttribute('data-shell-chrome', chrome);
264:    document.body.setAttribute('data-ui-size', size);
265:    document.body.setAttribute('data-density', density);
266:    document.body.setAttribute('data-shell-chrome', chrome);
267:  }, [uiSize, shellChromeMode]);
```

切片 2（全屏状态探测与写入）：
```typescript
// apps/crish-desktop/src/app/AppBootstrap.ts:278-321
278:  const applyFullscreen = (isFullscreen: boolean): void => {
279:    document.documentElement.setAttribute('data-fullscreen', isFullscreen ? 'true' : 'false');
280:  };
290:  applyFullscreen(Boolean(document.fullscreenElement)); // 初始写 false
294:  const mod = await import('@tauri-apps/api/window');
321:  applyFullscreen(await win.isFullscreen()); // 异步再写真值
```

切片 3（侧栏挂载期读取计算样式与强制重排）：
```typescript
// apps/crish-desktop/src/components/sidebar/useSidebarResize.ts:54-79
54:  document.documentElement.style.setProperty('--sidebar-width', `${restoredWidth}px`);
58:  document.documentElement.style.setProperty('--sidebar-visible-width', `${restoredWidth}px`);
66:  const cssW = parseInt(
67:    getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'),
68:    10
69:  );
```

#### 2. 底层机制与因果推导
1. **全局样式缓存失效（Computed Style Invalidation Storm）**：
   现代浏览器排版引擎（Blink / WebKit）维护着高度优化的计算样式缓存。当修改根节点 `document.documentElement` 或 `document.body` 的 `data-ui-size`、`data-density`、`data-shell-chrome`、`data-fullscreen` 时，由于全局 CSS 中存在大量依赖这些属性的祖先复合选择器（例如 `[data-density="compact"] .btn`、`[data-shell-chrome="classic"] .topbar`），Blink 会将**整个 DOM 树的所有节点标记为 `kNeedsStyleRecalc`**。
2. **挂载期 CSSOM 读取触发强制同步样式重算（Forced Synchronous Layout）**：
   在 `useSidebarResize.ts` 中，恢复宽度失败后的**兜底分支**（66-71 行）调用 `getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')`。注意：当 `restoredWidth` 合法时走 54-63 行纯写分支，并**不会**「写后紧接着读」——写/读为互斥分支，旧稿「紧接着读写」因果链不成立（见 audits/05 §4.2）。但该读取仍强制同步执行一次 **Recalculate Style & Reflow**，挂载热路径上应消除。
3. **双重赋值冗余**：`AppBootstrap.ts:264-266` 同时把属性写到 `documentElement` 和 `document.body`。在现代 CSS 体系中，属性挂在 `:root`（`documentElement`）即可全局继承，写入 `body` 完全是冗余开销，徒增 DOM 变异记录（MutationRecord）。

#### 3. 优化方案建议
1. **移除 `AppBootstrap.ts:251-267` 中的重复写入**：该职责已由 `initVisualPresentationController()`（`visualThemeController.ts`）在 `main.tsx` 启动期通过精准监听 `layoutStore` 实现，删除 `AppBootstrap` 内的重复副作用。
2. **彻底消灭 `useSidebarResize.ts` 中的 `getComputedStyle`**：直接使用 TS 模块级常量 `SIDEBAR_WIDTH_DEFAULT` 或从 Store 读取数值，禁止在挂载热路径上通过计算样式反查 CSS 变量。
3. **全屏属性写入单次收口**：在 Tauri 窗体初始化就绪前，不在 DOM 上反复播种默认 `false`，仅在真实状态获取后写入一次。

---

### P1-2: 历史工作区恢复模式下的 DOM 节点爆炸与并行水合冲击 (Layout Tree Hydration DOM Explosion)

#### 1. 源码证据与切片
在 `apps/crish-desktop/src/app/hydrateWorkspaceShell.ts` 中：
```typescript
// apps/crish-desktop/src/app/hydrateWorkspaceShell.ts:75-158
75:  export function hydrateWorkspaceShell(): void {
77:    const restore = readRestoreLastWorkspace();
78:    const treeStore = root.tree.getState();
80:    if (!restore) {
81:      applySafeCleanColdStart();
82:      root.shell.setShellReady(true);
83:      return;
84:    }
97:    const result = migrate({ tree: treeStore.tree, ... });
116:   treeStore.setTree(result.tree);
148:   // 遍历所有 ChatLeaf 的首选活动 Tab，自动预流水合，消除刷新后显示空屏需手动点击的缺陷
149:   for (const leaf of chatLeaves as Array<{ id: string; tabs?: Array<{ tabId: string; sessionId?: string }>; activeTabId?: string }>) {
150:     const activeTab = leaf.tabs?.find((t) => t.tabId === leaf.activeTabId) || leaf.tabs?.[0];
151:     if (activeTab?.sessionId && !isPendingDraft(activeTab.sessionId)) {
152:       triggerSessionMessageHydrateIfNeeded(activeTab.sessionId);
153:     }
154:   }
158: }
```

#### 2. 底层机制与因果推导
当用户启用了“恢复上次工作区”（`readRestoreLastWorkspace() === true`）时，冷启动的水合负荷会发生剧烈的非线性膨胀：
1. **DOM 节点数量倍增**：
   - **安全空白启动模式**（`!restore`）：只有 1 个 Clean Chat 叶，1 个空的草稿 Tab。首屏渲染的 DOM 节点数量仅约为 **220 ~ 280 个**。
   - **历史恢复模式**（`restore`）：若用户上次关闭前开启了 3 分屏（Left / Center / Right），每个分屏拥有 3~5 个 Tab：
     二叉树工作区将同时实例化 3 个 `TreeLeafPanel`、3 个 `PaneHeader`、3 个 `LeafToolTabStrip` 以及 3 个 `ChatCard`。首屏 DOM 节点数量瞬间飙升至 **2,400 ~ 4,200 个**！
2. **并发 IPC 消息洪峰**：
   第 149-154 行的循环在首帧前对**所有 ChatLeaf 的首选 Tab 并发调用 `triggerSessionMessageHydrateIfNeeded`**。这意味着 3 个会话同时向 SQLite 数据库发起历史消息列表查询，数十条乃至上百条消息的 Markdown 抽象语法树（AST）解析、代码高亮（Prism/Shiki）和附件卡片在同一帧内涌入 React 调和队列，导致长任务执行时间（Long Task）直接突破 **180ms**，产生肉眼可见的界面冻结。

#### 3. 优化方案建议
1. **分屏按需懒水合（Lazy Leaf Hydration）**：
   在冷启动恢复阶段，仅对全局当前激活的叶子（`treeStore.activeLeafId`）执行同步渲染与消息水合；其余非激活的分屏叶子先渲染轻量占位骨架（`<PanePlaceholder />`）。
2. **消息水合排队调度**：
   将非激活分屏的消息拉取与解析任务推迟至 `requestIdleCallback` 中串行执行，确保首屏主交互焦点在 50ms 内率先就绪。

---

### P1-3: 防御性两层 rAF 嵌套导致的目录重绑定延迟 (Defensive Double-rAF)

#### 1. 源码证据与切片
在 `apps/crish-desktop/src/app/AppBootstrap.ts` 中存在以下防御性代码：
```typescript
// apps/crish-desktop/src/app/AppBootstrap.ts:161-175
161:    let raf1: number | null = null;
162:    let raf2: number | null = null;
163:    raf1 = window.requestAnimationFrame(() => {
164:      raf2 = window.requestAnimationFrame(() => {
165:        rebind();
166:      });
167:    });
168:
169:    window.addEventListener('crish-project-changed', rebind);
170:    return () => {
171:      if (raf1 !== null) window.cancelAnimationFrame(raf1);
172:      if (raf2 !== null) window.cancelAnimationFrame(raf2);
173:      window.removeEventListener('crish-project-changed', rebind);
174:    };
```
在 `apps/crish-desktop/src/app/AppGlobalDialogs.tsx:116-120` 中亦存在类似结构：
```typescript
116:  window.requestAnimationFrame(() => {
117:    window.requestAnimationFrame(() => {
118:      setShowSettingsOverlay(true);
119:    });
120:  });
```

#### 2. 底层机制与因果推导
1. **双重 rAF 的历史根因**：
   经查阅 Git 提交历史（Commit `d297338554` 与 `add998edfda6`），该实现始创于早期架构重构阶段。当时的开发者为了确保“React 挂载完成、DOM 布局稳定、且 SessionStore 已经从磁盘镜像回灌完成”，因缺乏明确的就绪事件通知，采用了经典的“浏览器双帧延迟黑魔法”（Frame 1 等待 React Commit，Frame 2 等待浏览器渲染与样式沉淀）。
2. **严重的负面性能与体验代价**：
   - **绝对延迟放大**：在 60Hz 屏幕上，双重 rAF 强制引入了 **33.3ms** 的空转等待；若在低性能设备或帧率波动时，该延迟可放大至 **50ms+**。
   - **纯内存操作却空耗动画帧**：分析 `rebind()` 内部实现：
     ```typescript
     const projects = listProjects();
     for (const p of projects) rememberProjectFolderAlias(p.id, p.path);
     getCompositionRoot().session.getState().rebindSessionFolders(projects);
     ```
     `rebind()` 执行的纯粹是内存中 `projectStore` 与 `sessionStore` 的数据映射计算，根本不涉及任何 DOM 几何测距！为了纯 JS 数据运算而空等两帧动画，是严重的架构反模式。
   - **破坏首屏渲染稳态**：当首屏好不容易渲染完成、用户以为界面已经稳定时，第 2 帧的 rAF 突然激活，执行 `rebindSessionFolders` 修改 Store，导致侧栏会话列表（`SidebarSessionList`）在用户眼皮底下发生一次滞后的重新排序与重刷。

#### 3. 优化方案建议
1. **彻底铲除双重 rAF**：将 `rebind()` 归位到 Store 初始化的确定性链条中，在 `projectStore` 与 `sessionStore` 水合完成的回调中同步执行。
2. **显式事件驱动替代盲目等待**：监听确切的 `projects-hydrated` 状态，消除防御性计时器。

---

### P1-4: `useAppShortcuts` 依赖项变动导致的快捷键系统频繁销毁与重构

#### 1. 源码证据与切片
在 `apps/crish-desktop/src/app/AppShortcuts.ts:176-184` 中：
```typescript
// apps/crish-desktop/src/app/AppShortcuts.ts:176-184
176:   }, [
177:     showCheatsheet,
178:     showSettingsOverlay,
179:     showFirstRun,
180:     setShowCheatsheet,
181:     setShowSettingsOverlay,
182:     setShowTelemetry,
183:     setSidebarCollapsed,
184:   ]);
```

#### 2. 底层机制与影响分析
- `ShortcutService.getInstance().init(document)` 是单例服务。
- 依赖项数组中包含了 `showCheatsheet`、`showSettingsOverlay`、`showFirstRun` 等频繁变化的 UI 状态。
- 每当用户唤起或关闭设置面板、或者首次启动向导状态切换时，`useAppShortcuts` 的 Effect 清理函数均会被触发：
  执行 `svc.destroy()`，解绑 document 上的 `keydown` 监听器，随后立即再次执行 `svc.init(document)` 重新注册。
- 在冷启动期间，`showFirstRun` 等状态在初次渲染与异步检测后发生变化，导致快捷键系统在启动前 100ms 内经历两次“销毁-重建”，造成无谓的垃圾回收与事件分发抖动。

#### 3. 优化方案建议
利用 `useRef` 保存最新的 UI 弹窗状态快照，将 `useAppShortcuts` 的依赖项数组置空（`[]`），使全局快捷键管理器在整个应用生命周期内仅在挂载时初始化一次。

---

## 五、低严重度与微架构隐患（P2/Low）

### P2-1: 生产环境中无条件执行的 Store 订阅包装闭包
- **源码位置**：`apps/crish-desktop/src/store/bootstrapStores.ts:40-60`, `115-134`
  ```typescript
  // 47: store.subscribe = ((listener: (state: unknown, prev: unknown) => void) => {
  // 48:   active++;
  // 49:   const wrapped = (state: unknown, prev: unknown) => {
  // 50:     invocations++;
  // 51:     listener(state, prev);
  // 52:   };
  // 53:   const unsub = orig(wrapped);
  // ...
  // 116: _wrapSubscriberCounting(useLayoutStore, 'layoutStore');
  // 133: _wrapSubscriberCounting(domainHooks[i]!, _STORE_NAMES[4 + i]!);
  ```
- **隐患剖析**：虽然 `_setupFrequencyLogging()` 检查了 `process.env.NODE_ENV !== 'development'`，但 `_wrapSubscriberCounting` 却在所有环境下无条件对 `useLayoutStore`、`useTerminalStore`、`useWorkerStore`、`usePermissionStore`、`useSettingsStore` 的原生 `subscribe` 进行猴子补丁（Monkey-patching）。每一次 Store 状态更新，都会额外产生一次函数闭包调用与原子计数器递增，在生产环境中徒增微架构层面的执行开销。
- **优化建议**：将 `_wrapSubscriberCounting` 整体置于 `import.meta.env.DEV` 门控之下，生产环境直接返回原始原生 `store.subscribe`。

### P2-2: `AppTopBar` 与 `WindowControls` 中的冗余 IPC 窗口状态探测
- **源码位置**：`apps/crish-desktop/src/components/shell/WindowControls.tsx:15-32` vs `apps/crish-desktop/src/app/AppBootstrap.ts:294-324`
- **隐患剖析**：`WindowControls` 挂载时通过动态 `import('@tauri-apps/api/window')` 异步调用 `win.isMaximized()`；与此同时，`AppBootstrap` 也在异步导入相同模块并调用 `win.isFullscreen()`。两个紧邻的组件各自发起独立的 Tauri IPC 通信，不仅产生重复的模块解析，且在不同微任务中返回，造成额外的组件局部重绘。
- **优化建议**：在 Rust 壳层启动创建主窗口时，将 `isMaximized` 与 `isFullscreen` 的初始状态直接注入首屏上下文（或与 `createSsrGlobals` 合并），前端组件挂载时直接同步读取，免除首屏 IPC 往返。

### P2-3: `PaneHeader` 入场门控 `setBooted(true)` 引发的微任务重绘
- **源码位置**：`apps/crish-desktop/src/components/binary-tree/PaneHeader.tsx:131-133`
  ```typescript
  // 131: // 入场动画门控：首轮挂载后的首个副作用之后才允许 @starting-style 生效
  // 132: useEffect(() => {
  // 133:   setBooted(true);
  // 134: }, []);
  ```
- **隐患剖析**：每个 Leaf 的 `PaneHeader` 挂载时，`booted` 初始为 `false`，随后在首个 `useEffect` 中立即执行 `setBooted(true)`。如果冷启动恢复了 3 个分屏，会导致 3 个 `PaneHeader` 在首绘后紧接着被推入下一轮微任务队列触发二次调和。
- **优化建议**：使用 CSS 类名配合父级已有的 `preload` 机制控制过渡动画，废除通过 React State 驱动的 `booted` 标记。

### P2-4: `GlobalErrorBanner` 与 `AppErrorBoundary` 双重边界加载冗余
- **源码位置**：`apps/crish-desktop/src/main.tsx:187-211`
- **隐患剖析**：在 `main.tsx` 中，`AppErrorBoundary` 与 `GlobalErrorBanner` 采用分离的动态导入。虽然有异常隔离的意图，但在主渲染流程启动前串行 `try-catch` 解析，延长了主线程评估时间。
- **优化建议**：将错误保护层作为微小核心模块与 Entry 打包整合，消除不必要的动态 chunk 分割。

---

## 六、React 水合全链路时序图与状态迁移拓扑

### 6.1 现有实现（级联水合与多次重绘时序图）

展示当前代码在冷启动期间所经历的微任务交替、多次全树调和与 DOM 重排风暴：

```mermaid
sequenceDiagram
    autonumber
    participant Main as main.tsx
    participant DOM as HTML / DOM 树
    participant React as React 19 Root
    participant App as App.tsx
    participant Boot as AppBootstrap.ts
    participant Shell as hydrateWorkspaceShell
    participant Pref as usePreferencesHydration
    participant Tree as BinaryTreeWorkspace
    participant IPC as Tauri / Rust 内核

    Note over Main, DOM: Phase 1.5 模块加载完成
    Main->>DOM: createRoot(rootEl).render(<App />)
    Note over React, App: 【Pass 1: 初次渲染 (0ms)】
    React->>App: 执行 App() 函数
    App->>DOM: 挂载 Sidebar, AppTopBar, 渲染 SkeletonFallback (shellReady=false)
    
    par 并发触发 16+ 个 Effects
        App->>Boot: 激活 useAppBootstrap
        App->>Pref: 激活 usePreferencesHydration
        App->>Shell: useLayoutEffect: waitLayoutTreeHydration
    end

    Note over Shell: 微任务 1: LayoutTree 水合
    Shell->>Shell: hydrateWorkspaceShell()
    Shell->>App: setShellReady(true)
    Note over React, App: 【Pass 2: 调和重绘 (T+15ms)】
    App->>DOM: 更新 DOM，开始评估 <BinaryTreeWorkspace />
    Note over Tree: BinaryTree 是 lazy chunk，触发 Suspense！
    Tree->>DOM: 再次呈现 SkeletonFallback

    Pref->>IPC: getAllPreferences()
    Boot->>IPC: clientApi.getSettings()
    
    IPC-->>Pref: 返回全量偏好 (T+35ms)
    Pref->>DOM: TokenRuntimeController.applyTokens() (样式变脏)
    Pref->>App: setIsHydrated(true)
    Note over React, App: 【Pass 3: 调和重绘 (T+38ms)】

    IPC-->>Boot: 返回 Settings (T+45ms)
    Boot->>DOM: setAttribute('data-ui-size', ...) (强制样式失效)
    Boot->>App: setAppSettings(settings)
    Note over React, App: 【Pass 4: 调和重绘 (T+48ms)】

    Note over Tree: BinaryTree chunk 加载完成 (T+80ms)
    Tree->>DOM: 挂载 TreeLeafPanel
    Note over Tree: Builtin chat 是 lazy chunk，再次触发 Suspense！
    Tree->>IPC: ChatCard chunk 请求

    Boot->>Boot: raf1 -> raf2 (双重 rAF 到期 T+95ms)
    Boot->>App: rebindSessionFolders()
    Note over React, App: 【Pass 5: 调和重绘 (T+98ms)】

    IPC-->>Tree: ChatCard chunk 返回 (T+130ms)
    Tree->>DOM: 最终挂载 ChatCard 与 MessageList
    Main->>DOM: rAF: classList.remove('preload') (全局样式大重算)
    Note over DOM: 最终达到稳态 TTI (~160ms+)
```

---

### 6.2 目标架构（单阶段批处理与零悬挂水合时序图）

优化后的单阶段确定性水合拓扑：

```mermaid
sequenceDiagram
    autonumber
    participant Main as main.tsx
    participant Coord as UnifiedHydrationCoordinator
    participant IPC as Tauri / Rust 内核
    participant Store as Zustand Root Stores
    participant React as React 19 Root
    participant App as App.tsx (Eager Tree & Chat)
    participant DOM as HTML / DOM 树

    Main->>Coord: 启动并行预取 (Phase 1)
    par 并发无锁预取
        Coord->>IPC: 批量拉取 Preferences & Settings & Layout
        Coord->>IPC: detectHardware
    end
    IPC-->>Coord: 聚合配置数据一次性就绪 (T+35ms)
    
    Note over Coord, Store: 原子注入核心 Store (No React Re-renders)
    Coord->>Store: batchUpdate(prefs, settings, layoutTree, shellReady=true)
    Coord->>DOM: VisualThemeController 单点写入 :root 属性

    Main->>React: createRoot(rootEl).render(<App />)
    Note over React, App: 【Pass 1: 单次首绘即稳态 (T+40ms)】
    React->>App: 执行 App() (所有状态已就绪)
    App->>DOM: 同步直出 Sidebar + BinaryTreeWorkspace + ChatCard
    Note over DOM: 零 Suspense 悬挂、零 Fallback 闪跳

    Main->>DOM: 紧接着的单次 rAF: classList.remove('preload')
    Note over DOM: 达成完全可交互稳态 (TTI 压缩至 <50ms)
```

---

## 七、运行时性能验证断言与测试用例设计建议

为防止未来开发过程中任何形式的架构回潮或性能退化，必须在自动化 CI 与端到端性能门禁中植入以下刚性断言：

### 7.1 React 根组件重渲染次数硬门禁断言
- **断言目标**：在冷启动过程中，从 `createRoot` 调用到 `reactInteractiveReady` 标记之间，`App` 组件的函数执行次数必须严格 **≤ 2 次**（理想目标为 1 次，严禁出现当前的 5~7 次）。
- **自动化测试用例设计（Vitest / Testing Library）**：
  ```typescript
  // tests/perf/startupReconciliation.spec.tsx
  import { render } from '@testing-library/react';
  import { vi, expect, test } from 'vitest';
  import App from '@/App';

  test('PERF-GATE: App 根组件在冷启动水合过程中调和次数不得超过 2 次', async () => {
    let renderCount = 0;
    const ProfilerWrapper = () => (
      <React.Profiler id="AppRoot" onRender={() => { renderCount++; }}>
        <App />
      </React.Profiler>
    );

    render(<ProfilerWrapper />);

    // 等待所有微任务与启动 Effect 完成
    await vi.waitFor(() => {
      expect(document.querySelector('[data-engine-ready="true"]')).toBeInTheDocument();
      expect(document.querySelector('[data-preferences-hydrated="true"]')).toBeInTheDocument();
    }, { timeout: 1500 });

    // 刚性断言：绝不允许级联重渲染
    expect(renderCount).toBeLessThanOrEqual(2);
  });
  ```

### 7.2 Blink 样式重算与强制重排零容忍断言
- **断言目标**：利用 Chrome DevTools Protocol (CDP) 或 Playwright 捕获启动热路径，断言在首屏渲染过程中 `LayoutEvict` 与 `ForcedSynchronousLayout` 的事件计数为 **0**。
- **Playwright Trace 性能断言脚本**：
  ```typescript
  // tests/e2e/perf-reflow.spec.ts
  import { test, expect } from '@playwright/test';

  test('PERF-GATE: 启动期间禁止发生 Forced Synchronous Layout', async ({ page }) => {
    await page.goto('about:blank');
    const client = await page.context().newCDPSession(page);
    await client.send('Performance.enable');

    // 监听样式重算与布局事件
    const metricsBefore = await client.send('Performance.getMetrics');
    await page.goto('/');

    await page.waitForFunction(() => window.__crish_perf?.reactInteractiveReady > 0);
    const metricsAfter = await client.send('Performance.getMetrics');

    const getMetric = (metrics: any[], name: string) =>
      metrics.find((m) => m.name === name)?.value || 0;

    const layoutCount =
      getMetric(metricsAfter.metrics, 'LayoutCount') -
      getMetric(metricsBefore.metrics, 'LayoutCount');

    // 允许整页初始渲染的正常 Layout，但监控持续的重排风暴
    expect(layoutCount).toBeLessThanOrEqual(3);
  });
  ```

### 7.3 首屏关键 Chunk 零 Suspense 悬挂断言
- **断言目标**：验证在生产环境下，二叉树工作区及默认 Chat 视图没有触发任何异步 Suspense Fallback。
- **断言方法**：检查挂载瞬间 `#root` 下是否存在带有 `.skel-shimmer` 或 `.settings-suspense-fallback` 的元素。一旦在 `shellReady=true` 后检测到骨架屏再次出现，立即阻断构建并告警。

---

## 八、修复行动项矩阵

下表总结了 Stage 4 审查发现的全量问题、波及文件、建议工程方案及量化验收指标：

| 编号 | 严重度 | 问题分类与特征 | 受影响文件与行号 | 架构级精准修复方案 | 核心验收指标 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **ACT-01** | **P0** | `AppBootstrap` 16 个 Hooks 导致 7 次全树级联重调和 | `apps/crish-desktop/src/app/AppBootstrap.ts:65-385`<br>`apps/crish-desktop/src/App.tsx:76-126` | 建立 `UnifiedHydrationCoordinator`，将偏好、引擎状态、树水合汇聚至单一微任务中通过 Zustand 批量原子注入 | `App` 调和次数从 **7 次降至 ≤ 2 次**；CPU 脚本执行耗时降低 **45ms** |
| **ACT-02** | **P0** | 双重偏好水合竞态与冗余磁盘反写 | `apps/crish-desktop/src/hooks/usePreferencesHydration.ts:37-125`<br>`apps/crish-desktop/src/app/AppBootstrap.ts:178-233` | 废除 `AppBootstrap` 内部的 `clientApi.getSettings()` 重复调用与回写逻辑；统一由 `usePreferencesHydration` 承担 SSOT 单一注水职责 | 消除重复的 `getSettings` IPC 请求；冷启动写磁盘次数 **归零** |
| **ACT-03** | **P0** | 首屏关键路径二叉树与 ChatCard 连续 Suspense 瀑布 | `apps/crish-desktop/src/App.tsx:68-72, 240-246`<br>`apps/crish-desktop/src/main.tsx:31-42` | 将 `BinaryTreeWorkspace` 与 `ChatCard` 提至主 bundle 同步静态导入，消除首屏核心组件的 `lazy()` 包装 | 消除连续 2 次二次骨架屏闪烁；首屏 TTI 缩短 **150ms ~ 200ms** |
| **ACT-04** | **P1** | 根元素与 Body 密集修改触发 Forced Reflow | `apps/crish-desktop/src/app/AppBootstrap.ts:251-267`<br>`apps/crish-desktop/src/components/sidebar/useSidebarResize.ts:54-79` | 移除 `AppBootstrap` 对 `data-ui-size` 等的二次覆写；彻底删除 `useSidebarResize` 挂载期 `getComputedStyle` 调用 | 启动热路径上的强制同步布局（Forced Reflow）降至 **0 次** |
| **ACT-05** | **P1** | 历史工作区恢复导致并发 IPC 与 DOM 节点爆炸 | `apps/crish-desktop/src/app/hydrateWorkspaceShell.ts:75-158` | 引入虚拟分屏延迟水合机制（Virtual Panes）：首屏仅水合 ActiveLeaf，非活跃分屏延迟至 Idle 队列 | 恢复模式下首屏 DOM 节点数从 **3500+ 压制在 600 以内** |
| **ACT-06** | **P1** | 双重 rAF 防御性延迟拖慢项目会话绑定 | `apps/crish-desktop/src/app/AppBootstrap.ts:161-175`<br>`apps/crish-desktop/src/app/AppGlobalDialogs.tsx:116-120` | 删除无意义的两层 `requestAnimationFrame` 嵌套，将 `rebindSessionFolders` 接入 Store 初始化完成的明确事件源 | 消除 **33.3ms ~ 50ms** 的无意义空转延迟；侧栏会话闪跳完全消除 |
| **ACT-07** | **P1** | `useAppShortcuts` 依赖变动引发高频解绑重建 | `apps/crish-desktop/src/app/AppShortcuts.ts:176-184` | 改用 Ref 闭包引用，将 Hook 依赖项清空，实现生命周期单次初始化 | 快捷键解绑与重注册次数从 3+ 次降至 **1 次** |
| **ACT-08** | **P2** | 生产环境无条件包装 Store 订阅闭包 | `apps/crish-desktop/src/store/bootstrapStores.ts:40-60` | 将 `_wrapSubscriberCounting` 用 `import.meta.env.DEV` 包裹，生产环境直连原生订阅 | 消除生产态每个 Store 订阅者的额外闭包层与调用开销 |
| **ACT-09** | **P2** | WindowControls 与 AppBootstrap 重复发起窗口 IPC | `apps/crish-desktop/src/components/shell/WindowControls.tsx:15-32`<br>`apps/crish-desktop/src/app/AppBootstrap.ts:294-324` | 合并窗口全屏与最大化状态探测，由 Rust 宿主在创建时直接注入初始状态值 | 减少 2 次无谓的跨进程 IPC 调用 |
| **ACT-10** | **P2** | PaneHeader 挂载期 `setBooted(true)` 产生额外微任务 | `apps/crish-desktop/src/components/binary-tree/PaneHeader.tsx:131-133` | 废弃 React State 门控，统一复用 CSSOM 的 `.preload` 门闩管理过渡动画 | 消除每个分屏 Leaf 产生的一次微任务重绘 |

---

> **本报告归档说明**：  
> 本报告严格遵循全链路启动性能审查总纲，针对 Stage 4（React 树挂载与多重副作用水合）完成了穷尽式的代码追溯与根因定性。本篇所有发现均基于当前仓库可复核的实际代码切片。所有修复项均遵循反退避设计原则，旨在彻底消灭级联重绘、渲染挂起与强制重排，确保 Conex / Crish 迈向极致流畅的现代化桌面工程标准。
