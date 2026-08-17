# Conex 前端基础框架、窗口布局体系与可扩展 Slot 插槽机制深度审查报告

> **审查范围**：`apps/crish-desktop/src/` 核心基础框架、布局容器、侧栏与状态管理代码
> **报告定位**：客观、严谨、详尽的工程架构审查与系统性重构演进方案
> **生成时间**：2026-08-16
> **字符集**：UTF-8 无 BOM

---

## 目录

1. [执行摘要与核心结论](#一执行摘要与核心结论)
2. [顶层框架与视图分发硬编码深度剖析](#二顶层框架与视图分发硬编码深度剖析)
   - 2.1 `TreeLeafPanel.tsx` 静态 `switch(panelId)` 分发机制与历史包袱
   - 2.2 `App.tsx` 与 `AppGlobalDialogs.tsx` 顶层弹窗全量提升与硬编码
   - 2.3 `LeafToolTabStrip.tsx` 与 `ui-panel.ts` 字典重复散落与死锁
   - 2.4 新视图接入困境与被孤立组件案例（`BrowserPanel.tsx`、`FlowDagView.tsx`）
3. [窗口与分屏容器抽象度深度评估](#三窗口与分屏容器抽象度深度评估)
   - 3.1 `BinaryTreeWorkspace` 二叉树布局体系评估（优势与不足）
   - 3.2 布局树与业务域（Chat / Session）的过度耦合
   - 3.3 `CardPanelLayout` 遗留分栏模型的历史包袱与双轨制风险
4. [扩展性与 Slot 插槽机制缺失现状审查](#四扩展性与-slot-插槽机制缺失现状审查)
   - 4.1 顶栏（`AppTopBar.tsx` / `GlobalSessionTabBar.tsx`）的扩展点缺失
   - 4.2 侧栏（`Sidebar.tsx` / `SidebarHeader.tsx` / `SidebarFooter.tsx`）的扩展点缺失
   - 4.3 主工作区与叶子面板头部（`UnitChromeActions.tsx`）的扩展点缺失
   - 4.4 状态栏（Status Bar）的完全缺位与状态指示碎片化
5. [系统性重构方案：轻量 Shell 宿主 + 声明式 ViewRegistry + Slot 体系](#五系统性重构方案轻量-shell-宿主--声明式-viewregistry--slot-体系)
   - 5.1 声明式视图注册表体系（`ViewRegistry` & `PanelDefinition`）
   - 5.2 声明式 Slot 插槽体系（`SlotRegistry` & `<Slot />` 架构）
   - 5.3 纯粹的通用二叉树布局容器（`GenericBinaryTreeWorkspace`）
   - 5.4 统一全局浮层与模态管理器（`OverlayManager`）
6. [保留与舍弃决策矩阵（Keep vs Discard）](#六保留与舍弃决策矩阵keep-vs-discard)
7. [分步演进与迁移路线图](#七分步演进与迁移路线图)

---

## 一、执行摘要与核心结论

通过对 `apps/crish-desktop/src/` 关键架构代码的深度审查，当前 Conex（Crish）前端基础框架呈现出**「优秀算法内核」与「僵化分发外壳」并存**的典型矛盾：

1. **算法与渲染层优势明显**：
   - 二叉树布局（`apps/crish-desktop/src/store/layout-tree/`）参考了 VS Code `SerializableGrid` 思想，基于不可变纯函数树操作（`operations.ts`），并实现了深度的 React 渲染优化（如 `BinaryTreeWorkspace.tsx` 中的引用稳定化缓存、`TreeLeafPanel.tsx` 在 live-resize 期间直接写 DOM `style` 绕过 React 状态以消除 sash 拖拽延迟、`DropZoneOverlay.tsx` 取消 rAF 轮询改为纯事件驱动）。
2. **扩展机制与抽象层严重僵化**：
   - **视图分发完全依赖静态硬编码**：`TreeLeafPanel.tsx:265-295` 采用静态 `switch (panelId)` 分发 9 类已知面板；`AppGlobalDialogs.tsx:87-175` 采用静态条件渲染挂载所有全局弹窗。任何新增面板（如外部调试器、受管浏览器、可视化流程图、MCP 监控器）都必须侵入核心 switch 语句并修改多处散落的静态字典。
   - **二叉树容器与 Chat 业务高度耦合**：布局树核心节点判定内置了 `isChatDomain`（`types.ts:96-98`），在二叉树层直接硬编码了「对话域」与「功能区」的二元对立，导致多会话绑定的 Conversation Unit 逻辑深度污染了本应通用的空间分割引擎。
   - **Slot 插槽机制完全缺位**：从顶栏（`AppTopBar.tsx`）、侧栏（`SidebarNav.tsx`、`SidebarFooter.tsx`）到面板头部（`UnitChromeActions.tsx`），所有按钮、图标与操作项均硬编码在 JSX 树中，无法通过插件化、声明式方式注入扩展项。
   - **历史双轨制包袱仍未清退**：`createSsrGlobals.ts:14` 仍保留 `'columns' | 'tree'` 布局切换支持，`CardPanel.tsx` 与 `CardPanelLayout.tsx` 等近千行旧分栏代码仍在代码库中驻留，并迫使 `TreeLeafPanel.tsx` 传递无意义的 `wsId="default"`, `colIdx={0}`, `groupIdx={0}` 僵尸参数。
   - **已实现组件被孤立**：如 `BrowserPanel.tsx`（受管浏览器面板）与 `FlowDagView.tsx`（DAG 编排图）已开发完毕，却因为没有动态注册表，无法作为顶级或工具 Tab 挂载到二叉树工作区中。

**重构核心指导方针**：坚决贯彻「轻量 Shell 宿主 + 声明式 ViewRegistry 动态注册表 + 声明式 Slot 插槽」架构，彻底剥离二叉树布局中的业务硬编码，淘汰 Columns 遗留资产，构建可无限扩展的现代化桌面工作台。

---

## 二、顶层框架与视图分发硬编码深度剖析

### 2.1 `TreeLeafPanel.tsx` 静态 `switch(panelId)` 分发机制与历史包袱

在 `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx:226-295` 中，叶子面板的内容渲染完全由 `LeafBody` 函数内的硬编码 `switch (panelId)` 控制：

```tsx
// apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx:265-295
switch (panelId) {
  case 'chat':
    return (
      <ChatCard
        wsId="default"
        colIdx={0}
        groupIdx={0}
        handleGlobalTabClick={handleOpenTool}
        onShowToast={onShowToast}
        sessionId={sessionForPanel ?? undefined}
      />
    );
  case 'terminal':
    return <TerminalCard sessionId={sessionForPanel ?? undefined} />;
  case 'preview':
    return <PreviewCard wsId="default" onShowToast={onShowToast} />;
  case 'overview':
    return <OverviewCard wsId="default" onOpenPanel={handleOpenTool} />;
  case 'files':
    return <FilesCard onShowToast={onShowToast} />;
  case 'diff':
    return <DiffCard onShowToast={onShowToast} />;
  case 'runtime':
    return <RuntimePanel wsId="default" onShowToast={onShowToast} />;
  case 'agent':
    return <AgentCard />;
  default:
    return <div className={styles.emptyState}>未知面板类型：{panelId}</div>;
}
```

#### 架构缺陷分析：

1. **违背开闭原则（OCP）**：
   - 每次新增视图类型，必须修改 `TreeLeafPanel.tsx` 源码。
   - 视图与二叉树容器形成了强耦合，二叉树容器必须全量知晓所有面板组件的引用与类型（如 `ChatCard`, `TerminalCard`, `PreviewCard`, `OverviewCard`, `FilesCard`, `DiffCard`, `RuntimePanel`, `AgentCard`）。
2. **僵尸参数（Zombie Props）传染**：
   - 在旧 Columns 时代，每个面板依赖 `wsId`, `colIdx`, `groupIdx` 定位。迁移到二叉树后，`TreeLeafPanel.tsx` 仍然给 `ChatCard` 传递 `wsId="default"`, `colIdx={0}`, `groupIdx={0}`，给 `PreviewCard`, `OverviewCard`, `RuntimePanel` 传递 `wsId="default"`。
   - 这些参数在二叉树布局下毫无意义，但因为旧组件签名未清理，导致新老参数互相混杂。
3. **字符串前缀 Hack 分发**：
   - `TreeLeafPanel.tsx:254-263` 对文件查看器采用了字符串前缀匹配：
     ```tsx
     if (panelId.startsWith('file-viewer:')) {
       const filePath = panelId.substring('file-viewer:'.length);
       return (
         <FileViewerCard
           key={filePath}
           filePath={filePath}
           onShowToast={onShowToast}
         />
       );
     }
     ```
   - 这种通过拼接字符串（`file-viewer:path`）来编码动态视图实例参数的方式，是缺乏通用视图实例（View Instance / URI Router）模型的典型表征。当未来需要支持 `diff:fileA...fileB`、`debugger:port`、`log-viewer:id` 时，字符串分支将会进一步失控。

---

### 2.2 `App.tsx` 与 `AppGlobalDialogs.tsx` 顶层弹窗全量提升与硬编码

在 `apps/crish-desktop/src/App.tsx:310-324` 与 `apps/crish-desktop/src/app/AppGlobalDialogs.tsx:87-175` 中，全局弹窗与覆盖层全部提升至顶层组件的 `useState` / `useLayoutStore` 中并静态挂载：

```tsx
// apps/crish-desktop/src/app/AppGlobalDialogs.tsx:87-175
export function AppGlobalDialogs({
  showFirstRun, setShowFirstRun,
  toasts, dismissToast,
  showTelemetry, setShowTelemetry,
  showCheatsheet, setShowCheatsheet,
  showSettingsOverlay, setShowSettingsOverlay,
  activeWorkspaceId, settingsActiveTab, handleShowToast,
}: AppGlobalDialogsProps) {
  return (
    <>
      {showFirstRun && (
        <AppErrorBoundary compact title="首次运行向导出错">
          <Suspense fallback={<SkeletonFallback height={400} />}>
            <FirstRunWizard ... />
          </Suspense>
        </AppErrorBoundary>
      )}

      <div role="region" aria-label="通知" aria-live="polite">
        <AppErrorBoundary variant="minimal" title="通知出错">
          <Suspense fallback={null}>
            <ToastStack toasts={toasts} onDismiss={dismissToast} />
          </Suspense>
        </AppErrorBoundary>
      </div>

      {showTelemetry && <TelemetryDialog onClose={() => setShowTelemetry(false)} />}
      {showCheatsheet && <CheatsheetModal onClose={() => setShowCheatsheet(false)} />}
      {showSettingsOverlay && <SettingsPanel ... />}
      <FullThoughtModal />
    </>
  );
}
```

#### 架构缺陷分析：

1. **顶层组件状态爆炸与不必要的 Re-render**：
   - `App.tsx:102-103` 维护了 `const [showCheatsheet, setShowCheatsheet] = useState(false);`、`const [showTelemetry, setShowTelemetry] = useState(false);`、`const [showFirstRun, setShowFirstRun] = useState(...)`。
   - 每次用户按下快捷键打开 Cheatsheet，或者 Telemetry 状态变化，都会触发 `App.tsx` 顶层组件的重新渲染。虽然有 `React.memo` 阻断部分子树，但这违背了状态就近原则。
2. **模态浮层无法动态扩展**：
   - 若新增一个「MCP 服务安装向导」、「Git 冲突合并弹窗」或「插件配置对话框」，开发者必须在 `App.tsx` 加状态、在 `AppShortcuts.ts` 加快捷键、在 `AppGlobalDialogs.tsx` 加 JSX 节点、在 `AppGlobalDialogsProps` 加类型声明，改动链路长达 4~5 个文件。
3. **缺乏统一的 Overlay/Modal 声明式总线**：
   - 目前浮层的打开方式极度碎片化：有的走 `window.dispatchEvent(new CustomEvent('open-cheatsheet'))`（`AppTopBar.tsx:34`），有的走 Zustand store `setShowSettingsOverlay(true)`（`App.tsx:93`），有的走 React useState props 传递。

---

### 2.3 `LeafToolTabStrip.tsx` 与 `ui-panel.ts` 字典重复散落与死锁

在系统各个角落，面板类型、标题与图标存在严重的多重硬编码与定义漂移：

1. **`LeafToolTabStrip.tsx:27-35` 的硬编码字典**：
   ```tsx
   const PANEL_LABELS: Record<string, string> = {
     overview: '总览',
     files: '文件',
     diff: '差异',
     terminal: '终端',
     preview: '预览',
     runtime: '运行时',
     agent: '协作体',
   };
   ```
2. **`ui-panel.ts:3-7` 的硬编码字典**：
   ```tsx
   const PANEL_TITLE_MAP: Record<string, string> = {
     agent: '协作体',
     overview: '总览',
     files: '文件',
     preview: '预览',
     diff: '变更',
     terminal: '终端',
     tasks: '任务',
     runtime: '运行',
     chat: '对话',
     settings: '设置',
     plan: '计划',
   };
   ```
3. **`UnitChromeActions.tsx:21-46` 的硬编码工具列表**：
   ```tsx
   const UNIT_TOOL_PANELS = [
     {
       id: 'overview',
       label: '打开总览',
       testId: 'chat-open-overview',
       Icon: LayoutDashboard,
     },
     {
       id: 'files',
       label: '打开文件',
       testId: 'chat-open-files',
       Icon: FolderTree,
     },
     {
       id: 'diff',
       label: '打开差异',
       testId: 'chat-open-diff',
       Icon: GitBranch,
     },
     {
       id: 'terminal',
       label: '打开终端',
       testId: 'chat-open-terminal',
       Icon: Terminal,
     },
   ] as const;
   ```
4. **`cardPanelHelpers.ts:4-14` 的硬编码集合**：
   ```tsx
   export const KNOWN_BODY_IDS = new Set([
     'chat',
     'preview',
     'overview',
     'files',
     'diff',
     'terminal',
     'settings',
     'runtime',
     'agent',
   ]);
   ```

#### 冲突与漂移证据：

- 在 `ui-panel.ts` 中，`diff` 叫「**变更**」，而在 `LeafToolTabStrip.tsx` 中叫「**差异**」；`runtime` 在 `ui-panel.ts` 中叫「**运行**」，在 `LeafToolTabStrip.tsx` 中叫「**运行时**」。
- `tasks` 与 `plan` 在 `ui-panel.ts` 中存在，但在 `LeafToolTabStrip.tsx` 中完全缺失。
- 字典定义四散各处，新增面板必须同时同步 4 个以上文件，极易遗漏。

---

### 2.4 新视图接入困境与被孤立组件案例

审查代码时发现，仓库中已经开发了多个功能完整且强大的视图组件，但由于缺乏动态注册机制，它们处于被孤立或只能内嵌在特定次级面板中的窘境：

#### 案例 1：`BrowserPanel.tsx`（受管 AI 浏览器面板）

- **实现度**：`apps/crish-desktop/src/components/workspace/BrowserPanel.tsx` 完整实现了 Tauri Channel 下行帧流（`useFrameStream.ts`）、鼠标与键盘 ASCII 上行转发（`InputLayer.tsx`）、IME 组合输入（`compositionend`）、AI/人工接管指示条（`IndicatorBar.tsx`）以及 Cookie 导入（`BrowserImportSection.tsx`）。
- **孤立现状**：在 `TreeLeafPanel.tsx` 的 `switch(panelId)`、`LeafToolTabStrip.tsx` 的 `PANEL_LABELS`、`ui-panel.ts` 的 `PANEL_TITLE_MAP` 中，**完全没有 `browser` 的注册条目**！
- 甚至在 `ui-panel.ts:18` 中存在一段降级注释：`if (id === 'browser') return 'preview';`。这导致功能强大的浏览器面板无法被用户作为顶级 Tab 独立开启。

#### 案例 2：`FlowDagView.tsx`（DAG 编排图可视化）

- **实现度**：`apps/crish-desktop/src/components/workspace/FlowDagView.tsx` 实现了基于拓扑分层的纯 SVG/CSS 编排图展示，具备节点状态机旋转圆环、层间骨架连线与实时轮询。
- **孤立现状**：它被硬编码塞进了 `RuntimePanel.tsx:218` 作为次级折叠区段，无法像 VS Code 的 Editor Panel 一样作为独立面板拖拽、分屏或全屏查看。

---

## 三、窗口与分屏容器抽象度深度评估

### 3.1 `BinaryTreeWorkspace` 二叉树布局体系评估

`apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.tsx` 与 `apps/crish-desktop/src/store/layout-tree/` 是当前工作区的核心布局引擎。

```
┌─────────────────────────────────────────────────────────┐
│                 BinaryTreeWorkspace.tsx                 │
│                                                         │
│  ┌────────────────────────┬──────────────────────────┐  │
│  │   TreeLeafPanel (chat) │ TreeLeafPanel (tools)    │  │
│  │                        │ ┌──────────────────────┐ │  │
│  │                        │ │  LeafToolTabStrip    │ │  │
│  │                        │ ├──────────────────────┤ │  │
│  │                        │ │  LeafBody (Switch)   │ │  │
│  │                        │ └──────────────────────┘ │  │
│  └────────────────────────┴──────────────────────────┘  │
│                           │                             │
│                    TreeResizeSash                       │
└─────────────────────────────────────────────────────────┘
```

#### 优秀设计资产（必须保留）：

1. **纯函数不可变数据结构**：
   - `types.ts` 定义的 `LayoutLeaf` 与 `LayoutBranch` 构成了严格的二叉树。`operations.ts` 中的 `splitLeaf`, `mergeBranch`, `moveLeaf`, `resizeBranch` 全部为无副作用纯函数，易于单测且具备可重放性（天然支持 Undo/Redo，见 `layoutTreeStore.ts:451-477`）。
2. **极佳的性能保护机制**：
   - **引用稳定化缓存**：`BinaryTreeWorkspace.tsx:82-124` 实现了 `stabilizeLeafEntries` 与 `stabilizeBranches`，通过缓存 Map 复用未变动的 Leaf/Branch 引用，使得 `React.memo(TreeLeafPanel)` 和 `React.memo(TreeResizeSash)` 能精准跳过非变动节点的 Re-render。
   - **DOM 直写绕过 React 状态**：`TreeLeafPanel.tsx:147-155` 在 `document.body.classList.contains('tree-resizing')` 期间阻止 React style prop 写入，而是由 `useTreeResize` 监听 pointermove 直接操作 DOM `el.style`，彻底消除了分屏调整（Resize）时的掉帧与不跟手现象。
   - **DropZone 覆盖层事件驱动**：`DropZoneOverlay.tsx:91-125` 杜绝了 60fps rAF 轮询 `getBoundingClientRect`，仅在 `dropZone` 变化或窗口 resize 时计算坐标。

#### 抽象度不足与缺陷（亟需重构）：

1. **二叉树模型内置业务域判定**：
   - `types.ts:96-103` 定义了：
     ```ts
     export function isChatDomain(panelId: string): boolean {
       return panelId === 'chat';
     }
     export function isSameDomain(panelId1: string, panelId2: string): boolean {
       return isChatDomain(panelId1) === isChatDomain(panelId2);
     }
     ```
   - 二叉树应当是一个纯粹的**空间二叉分割算法容器**，但当前代码在二叉树层硬编码了 `panelId === 'chat'` 的「对话域」与「功能区」划分。这导致未来如果引入「多 Editor 模式」、「白板画布模式」或「多终端口布局」时，整个拖拽规则（`isSameDomain`）和合并逻辑就会产生逻辑错乱。

---

### 3.2 布局树与业务域（Chat / Session）的过度耦合

在 `apps/crish-desktop/src/store/layout-tree/conversationUnit.ts` 与 `apps/crish-desktop/src/store/workspace-shell/adapterShape.ts` 中，布局树被深度绑定到了 `sessionId` 上：

```ts
// apps/crish-desktop/src/store/layout-tree/types.ts:19-22
export interface LayoutLeaf {
  type: 'leaf';
  id: string;
  panelId: string;
  tabs: string[];
  activeTab: string;
  sessionId?: string; // 业务字段直接侵入布局节点！
}
```

```ts
// apps/crish-desktop/src/store/workspace-shell/adapterShape.ts:5-7
// UnitRoot =
//   | chatLeaf(sessionId)
//   | H-branch( chatLeaf(sessionId), toolSubtree )
```

#### 耦合带来的问题：

1. **双向投影与循环触发回环**：
   - 存在 `workspaceShellStore`（管理 `openTabs` 和 `rightDock`）与 `layoutTreeStore`（管理二叉树）。
   - 打开工具时，`openTool.ts` 先改 `workspaceShellStore` 的 `rightDock`，再调用 `adapterShape.ts:applyDockToTree` 改树；而树变更又被 `workspaceShellStore.ts:636-646` 的订阅监听，反向同步 `syncShellDocksFromTree`。
   - 为了防止死循环，系统不得不引入 `withTreeDockProjectionSuppressed` 锁标志（`treeDockProjection.ts`）。这种因为状态双向投影带来的补丁是典型的**架构职责边界不清**导致的次生复杂度。
2. **顶栏标签与分屏标签的割裂**：
   - 单 chat 时用 `AppTopBar.tsx` 内的 `GlobalSessionTabBar.tsx`；多 chat 分屏时，`TreeLeafPanel.tsx:176` 在每个 chat leaf 顶上额外挂载 `UnitSessionTabStrip.tsx`，而 `LeafToolTabStrip.tsx` 又挂在工具 leaf 顶上。这导致标签栏呈现多套规范，且拖拽上下文必须通过 `SessionTabDragContext.tsx` 勉强拼接。

---

### 3.3 `CardPanelLayout` 遗留分栏模型的历史包袱与双轨制风险

在 `apps/crish-desktop/src/components/CardPanel.tsx` 与 `apps/crish-desktop/src/components/card-panel/CardPanelLayout.tsx` 中，完整保留了基于列/组（Columns/Groups）的旧布局渲染引擎。

```tsx
// apps/crish-desktop/src/createSsrGlobals.ts:8-15
/**
 * 工作区布局版本：
 * - 'columns' 旧 columns/groups 模型（CardPanelLayout）
 * - 'tree'    新二叉树拖拽工作区（BinaryTreeWorkspace）
 * 默认 'tree'（重构目标）；用户可通过 localStorage['crish_workspace'] = 'columns' 回退
 */
workspaceKind: 'tree' as 'tree' | 'columns',
```

```tsx
// apps/crish-desktop/src/App.tsx:291-301
{
  useTreeWorkspace ? (
    <BinaryTreeWorkspace onShowToast={handleShowToast} />
  ) : (
    workspaceIds.map((id) => (
      <Workspace key={id} wsId={id} onShowToast={handleShowToast} />
    ))
  );
}
```

#### 风险与包袱评估：

1. **维护成本翻倍**：任何核心组件修改（如 `ChatCard`、`TerminalCard`）都必须同时兼容二叉树与旧 Columns 模型。
2. **`layoutStore.ts` 膨胀**：`layoutStore.ts` 包含了大量的 `createWorkspaceActions`（`workspaceActions.ts` 达 23KB），用于处理旧分栏的拖拽、折叠与比例计算，而这些代码在默认的二叉树工作区下完全处于冷闲置状态。
3. **彻底舍弃时机已经成熟**：二叉树工作区已在多次迭代中稳定运行，旧 Columns 模型已无任何业务优势，应全量清除，彻底卸下包袱。

---

## 四、扩展性与 Slot 插槽机制缺失现状审查

现代可扩展应用（如 VS Code、Chrome、Figma、Obsidian）普遍采用「核心宿主（Shell）+ 区域插槽（Slots）+ 扩展注册表（Registry）」的三层解耦架构。审查表明，Conex 当前前端架构在所有核心交互区域**均未提供声明式 Slot 扩展点**。

```
┌────────────────────────────────────────────────────────────────────────┐
│ Conex 前端插槽缺失现状总览                                             │
├────────────────────────────────────────────────────────────────────────┤
│ [TopBar Slot 缺失]                                                     │
│ AppTopBar.tsx: 硬编码 [SidebarToggle] [GlobalSessionTabBar] [WinCtrls] │
├────────────────────────────┬───────────────────────────────────────────┤
│ [Sidebar Slot 缺失]        │ [Main Workspace Slot 缺失]                │
│ SidebarHeader.tsx:         │ TreeLeafPanel.tsx:                        │
│   硬编码 新建/定时/搜索    │   硬编码 switch(panelId)                  │
│ SidebarFooter.tsx:         │ UnitChromeActions.tsx:                    │
│   硬编码 用户/更新/设置    │   硬编码 [总览, 文件, 差异, 终端, 展开]   │
├────────────────────────────┴───────────────────────────────────────────┤
│ [StatusBar 完全缺失]                                                   │
│ 缺乏底部状态栏，系统级状态（Engine/Persistence/Git/Token）散落在各子面板 │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.1 顶栏（`AppTopBar.tsx` / `GlobalSessionTabBar.tsx`）的扩展点缺失

查看 `apps/crish-desktop/src/components/AppTopBar.tsx:40-147`：

```tsx
<div className="app-top-bar" role="banner" data-tauri-drag-region>
  <div className="app-top-bar__rail">
    {/* 硬编码：侧栏展开/收起按钮 */}
    <Button ... data-testid="sidebar-toggle" onClick={onToggleSidebar} />
  </div>

  <div className="app-top-bar__main app-top-bar__main--tabs">
    {/* 硬编码：全局会话标签条 */}
    <GlobalSessionTabBar variant="caption" startSessionDrag={startSessionDrag} />
  </div>

  <div className="app-top-bar__trail app-top-bar__trail--fixed">
    {/* 硬编码：帮助按钮 */}
    <Button ... aria-label="快捷键与帮助" onClick={openCheatsheet} />
    {/* 硬编码：Tauri 窗口三键 (最小化/最大化/关闭) */}
    <Button ... onClick={() => void winCtl('minimize')} />
    <Button ... onClick={() => void winCtl('toggleMaximize')} />
    <Button ... onClick={() => void winCtl('close')} />
  </div>
</div>
```

- **问题**：顶栏没有为扩展提供任何入口。若需要添加「快速模型选择器」、「同步状态指示灯」、「环境选择下拉框」或「自定义动作按钮」，必须直接改写 `AppTopBar.tsx`。

---

### 4.2 侧栏（`Sidebar.tsx` / `SidebarHeader.tsx` / `SidebarFooter.tsx`）的扩展点缺失

查看 `apps/crish-desktop/src/components/sidebar/SidebarNav.tsx:23-84` 与 `SidebarFooter.tsx:62-135`：

```tsx
// SidebarNav.tsx: 硬编码的顶部操作
<div className={styles.topActions}>
  <Button ...>新对话</Button>
  <Button ...>定时任务</Button>
  <div className={styles.navItem} role="search"><input placeholder="搜索会话与消息…" /></div>
</div>

// SidebarFooter.tsx: 硬编码的底部操作
<div className={styles.sidebarFooter}>
  {canUseDemoMode() && <button>演示/正式</button>}
  <div className={styles.footerUserCol}><UserProfileCard ... /></div>
  <div className={styles.footerGearCol}>
    {updateAvailable ? <Button>更新</Button> : null}
    <SettingsIconButton ... />
  </div>
</div>
```

- **问题**：侧栏顶部与底部完全固化。无法在侧栏顶部注入新的导航项（如「知识库」、「MCP 广场」、「工作流市场」），也无法在侧栏底部扩展用户自定义状态（如 Git 状态徽章、网络延迟指示器）。

---

### 4.3 主工作区与叶子面板头部（`UnitChromeActions.tsx`）的扩展点缺失

查看 `apps/crish-desktop/src/components/chat-card/UnitChromeActions.tsx:142-163`：

```tsx
{
  UNIT_TOOL_PANELS.map(({ id, label, testId, Icon }) => {
    const isOpen = openPanelSet.has(id);
    const isActive = !rightDockCollapsed && activePanelId === id;
    return (
      <Tooltip key={id} content={label}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={styles.toolBtn}
          data-testid={testId}
          data-panel={id}
          onClick={() => handleOpenTool(id)}
          icon={<Icon size={15} strokeWidth={1.75} aria-hidden />}
        />
      </Tooltip>
    );
  });
}
```

- **问题**：工具快捷入口写死为 `overview`, `files`, `diff`, `terminal` 四个按钮。新视图（如 `browser`, `flow-dag`, `debugger`）无法声明式地在此处挂载快捷图标。

---

### 4.4 状态栏（Status Bar）的完全缺位与状态指示碎片化

Crish 桌面端目前**没有统一的状态栏（Status Bar）容器**。这导致多项关键系统状态被迫散落在各个子面板内：

- 引擎连接状态（`connectionStatus`）与持久化状态（`persistenceStatus`）挤在 `RuntimePanel.tsx:100-145`；
- Git 分支（`git.branch`）与 Token 费用估计塞在 `OverviewCard.tsx:91-110`；
- 电源与内存指示在某些 debug overlay 中隐式读取。
  这导致用户在常规对话界面无法全局感知应用底层的健康状况。

---

## 五、系统性重构方案：轻量 Shell 宿主 + 声明式 ViewRegistry + Slot 体系

为了根除上述硬编码与扩展性缺失问题，设计一套**高内聚、低耦合、强类型、声明式**的前端架构体系。

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        全新架构演进图谱 (Target Architecture)            │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  [Extension / Built-in Plugins]                                          │
│    │ registerView(...)                                                   │
│    │ registerSlotItem(...)                                               │
│    ▼                                                                     │
│  ┌──────────────────────────────┐       ┌─────────────────────────────┐  │
│  │      ViewRegistry            │       │        SlotRegistry         │  │
│  │ (id, component, icon, title) │       │ (slotId, priority, element) │  │
│  └──────────────┬───────────────┘       └──────────────┬──────────────┘  │
│                 │                                      │                 │
│                 ▼                                      ▼                 │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                     AppShell (轻量宿主容器)                        │  │
│  │                                                                    │  │
│  │  ┌──────────────────────────────────────────────────────────────┐  │  │
│  │  │ AppTopBar: <Slot id="workbench.topbar.leading" /> ...         │  │  │
│  │  ├──────────────────────────────────────────────────────────────┤  │  │
│  │  │ ┌──────────────────────┬───────────────────────────────────┐ │  │  │
│  │  │ │ Sidebar:             │ GenericBinaryTreeWorkspace:       │ │  │  │
│  │  │ │  <Slot               │   GenericLeafPanel:               │ │  │  │
│  │  │ │   id="sidebar.nav"/> │     ViewRegistry.render(panelId)  │ │  │  │
│  │  │ │  SessionList         │     <Slot id="panel.header" />    │ │  │  │
│  │  │ │  <Slot               │                                   │ │  │  │
│  │  │ │   id="sidebar.foot"/>│                                   │ │  │  │
│  │  │ └──────────────────────┴───────────────────────────────────┘ │  │  │
│  │  ├──────────────────────────────────────────────────────────────┤  │  │
│  │  │ AppStatusBar: <Slot id="workbench.statusbar.left" /> ...     │  │  │
│  │  └──────────────────────────────────────────────────────────────┘  │  │
│  │                                                                    │  │
│  │  <OverlayHost /> (统一响应 openModal / openDrawer)                 │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

---

### 5.1 声明式视图注册表体系（`ViewRegistry` & `PanelDefinition`）

将所有面板的元数据、渲染组件、生命周期与上下文解耦为统一的注册项。

#### 1. 契约定义（`types/viewRegistry.ts`）：

```ts
import type React from 'react';

export type ViewCategory = 'primary' | 'tool' | 'auxiliary' | 'debug';

export interface ViewRenderContext {
  panelId: string;
  leafId: string;
  sessionId?: string;
  isActive: boolean;
  onShowToast: (msg: string) => void;
  [key: string]: unknown;
}

export interface ViewDefinition {
  /** 唯一面板 ID，如 'chat', 'terminal', 'browser', 'flow-dag' */
  readonly id: string;
  /** 面板显示标题或动态标题解析函数 */
  readonly title: string | ((ctx: ViewRenderContext) => string);
  /** 面板图标 */
  readonly icon?: React.ComponentType<{ size?: number; className?: string }>;
  /** 面板归属分类 */
  readonly category: ViewCategory;
  /** 渲染组件（支持 React.lazy 动态加载） */
  readonly component: React.ComponentType<ViewRenderContext>;
  /** 是否允许单会话多开实例（默认 false） */
  readonly allowMultipleInstances?: boolean;
  /** 默认初始比例 (0.1 ~ 0.9) */
  readonly defaultSplitRatio?: number;
  /** 快捷键 (如 'Mod+Shift+T') */
  readonly shortcut?: string;
  /** 面板关闭前的清理钩子 (如释放 PTY 进程、断开 WebRTC/Channel) */
  readonly onDispose?: (ctx: {
    leafId: string;
    sessionId?: string;
  }) => void | Promise<void>;
}
```

#### 2. 单例注册表实现（`services/ViewRegistry.ts`）：

```ts
class ViewRegistryService {
  private views = new Map<string, ViewDefinition>();
  private listeners = new Set<() => void>();

  public registerView(view: ViewDefinition): () => void {
    if (this.views.has(view.id)) {
      console.warn(
        `[ViewRegistry] View '${view.id}' already registered, overwriting.`
      );
    }
    this.views.set(view.id, view);
    this.notify();
    return () => {
      this.views.delete(view.id);
      this.notify();
    };
  }

  public getView(id: string): ViewDefinition | undefined {
    // 支持动态 URI 路由匹配，如 file-viewer:/path/to/file
    if (id.startsWith('file-viewer:')) {
      return this.views.get('file-viewer');
    }
    return this.views.get(id);
  }

  public getAllViews(category?: ViewCategory): ViewDefinition[] {
    const list = Array.from(this.views.values());
    return category ? list.filter((v) => v.category === category) : list;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }
}

export const viewRegistry = new ViewRegistryService();
```

#### 3. 核心面板声明式注册（`app/registerBuiltInViews.ts`）：

```ts
import { lazy } from 'react';
import {
  LayoutDashboard,
  FolderTree,
  GitBranch,
  Terminal,
  Globe,
  Workflow,
} from 'lucide-react';
import { viewRegistry } from '../services/ViewRegistry';

export function registerBuiltInViews(): void {
  viewRegistry.registerView({
    id: 'chat',
    title: '对话',
    category: 'primary',
    component: lazy(() =>
      import('../components/chat-card/ChatCard').then((m) => ({
        default: m.ChatCard,
      }))
    ),
  });

  viewRegistry.registerView({
    id: 'overview',
    title: '总览',
    category: 'tool',
    icon: LayoutDashboard,
    component: lazy(() =>
      import('../components/overview/OverviewCard').then((m) => ({
        default: m.OverviewCard,
      }))
    ),
  });

  viewRegistry.registerView({
    id: 'terminal',
    title: '终端',
    category: 'tool',
    icon: Terminal,
    component: lazy(() =>
      import('../components/workspace/TerminalCard').then((m) => ({
        default: m.TerminalCard,
      }))
    ),
  });

  // 释放被孤立的 BrowserPanel 与 FlowDagView
  viewRegistry.registerView({
    id: 'browser',
    title: 'AI 浏览器',
    category: 'tool',
    icon: Globe,
    component: lazy(() =>
      import('../components/workspace/BrowserPanel').then((m) => ({
        default: m.BrowserPanel,
      }))
    ),
  });

  viewRegistry.registerView({
    id: 'flow-dag',
    title: '编排图',
    category: 'tool',
    icon: Workflow,
    component: lazy(() =>
      import('../components/workspace/FlowDagView').then((m) => ({
        default: m.FlowDagView,
      }))
    ),
  });
}
```

---

### 5.2 声明式 Slot 插槽体系（`SlotRegistry` & `<Slot />` 架构）

通过轻量级 Slot 组件，使得 Shell 宿主无需关心具体业务按钮，而是提供挂载点。

#### 1. 插槽类型与注册器（`services/SlotRegistry.ts`）：

```ts
import React from 'react';

export type StandardSlotId =
  | 'workbench.topbar.leading'
  | 'workbench.topbar.center'
  | 'workbench.topbar.actions'
  | 'workbench.topbar.trailing'
  | 'sidebar.header.actions'
  | 'sidebar.footer.leading'
  | 'sidebar.footer.trailing'
  | 'panel.header.actions'
  | 'workbench.statusbar.leading'
  | 'workbench.statusbar.trailing';

export interface SlotItem<TContext = unknown> {
  readonly id: string;
  readonly slotId: StandardSlotId | string;
  readonly priority?: number; // 排序权重，数值越小越靠前
  readonly visible?: (ctx: TContext) => boolean;
  readonly render: (ctx: TContext) => React.ReactNode;
}

class SlotRegistryService {
  private items = new Map<string, SlotItem<any>[]>();
  private listeners = new Set<() => void>();

  public registerItem<TContext>(item: SlotItem<TContext>): () => void {
    const list = this.items.get(item.slotId) || [];
    list.push(item);
    list.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    this.items.set(item.slotId, list);
    this.notify();
    return () => {
      const cur = this.items.get(item.slotId) || [];
      this.items.set(
        item.slotId,
        cur.filter((i) => i.id !== item.id)
      );
      this.notify();
    };
  }

  public getItems<TContext>(slotId: string): SlotItem<TContext>[] {
    return (this.items.get(slotId) || []) as SlotItem<TContext>[];
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }
}

export const slotRegistry = new SlotRegistryService();
```

#### 2. 通用 `<Slot />` 渲染组件（`components/ui/Slot.tsx`）：

```tsx
import React, { useEffect, useState } from 'react';
import { slotRegistry, type StandardSlotId } from '../../services/SlotRegistry';

export interface SlotProps<TContext = unknown> {
  id: StandardSlotId | string;
  context?: TContext;
  className?: string;
  fallback?: React.ReactNode;
}

export function Slot<TContext>({
  id,
  context,
  className,
  fallback,
}: SlotProps<TContext>) {
  const [, setTick] = useState(0);

  useEffect(() => {
    return slotRegistry.subscribe(() => setTick((t) => t + 1));
  }, []);

  const items = slotRegistry.getItems<TContext>(id);
  const visibleItems = items.filter((item) =>
    item.visible ? item.visible(context as TContext) : true
  );

  if (visibleItems.length === 0) {
    return fallback ? <>{fallback}</> : null;
  }

  return (
    <div className={`slot-container ${className || ''}`} data-slot-id={id}>
      {visibleItems.map((item) => (
        <React.Fragment key={item.id}>
          {item.render(context as TContext)}
        </React.Fragment>
      ))}
    </div>
  );
}
```

---

### 5.3 纯粹的通用二叉树布局容器（`GenericBinaryTreeWorkspace`）

将 `TreeLeafPanel.tsx` 改造为通过 `ViewRegistry` 动态渲染，彻底消除 `switch(panelId)`：

```tsx
// apps/crish-desktop/src/components/binary-tree/GenericLeafPanel.tsx
import React, { Suspense } from 'react';
import { viewRegistry } from '../../services/ViewRegistry';
import { Slot } from '../ui/Slot';
import styles from './BinaryTreeWorkspace.module.css';

export const GenericLeafBody: React.FC<{
  panelId: string;
  leafId: string;
  sessionId?: string;
  isActive: boolean;
  onShowToast: (msg: string) => void;
}> = React.memo(({ panelId, leafId, sessionId, isActive, onShowToast }) => {
  const viewDef = viewRegistry.getView(panelId);

  if (!viewDef) {
    return <div className={styles.emptyState}>未注册的面板类型：{panelId}</div>;
  }

  const Component = viewDef.component;
  const renderCtx = { panelId, leafId, sessionId, isActive, onShowToast };

  return (
    <div className={styles.panelContainer} data-view-id={panelId}>
      {/* 声明式面板头部动作 Slot */}
      <Slot id="panel.header.actions" context={renderCtx} />

      <Suspense fallback={<div className={styles.emptyState}>加载中…</div>}>
        <Component {...renderCtx} />
      </Suspense>
    </div>
  );
});
```

---

### 5.4 统一全局浮层与模态管理器（`OverlayManager`）

替代 `AppGlobalDialogs.tsx` 中的全量提升状态，采用命令式触发与声明式挂载相结合的模型：

```ts
// services/OverlayManager.ts
import React from 'react';

export interface ModalOptions {
  id: string;
  title?: string;
  component: React.ComponentType<{
    onClose: () => void;
    [key: string]: unknown;
  }>;
  props?: Record<string, unknown>;
}

class OverlayManagerService {
  private activeModals = new Map<string, ModalOptions>();
  private listeners = new Set<() => void>();

  public openModal(options: ModalOptions): void {
    this.activeModals.set(options.id, options);
    this.notify();
  }

  public closeModal(id: string): void {
    this.activeModals.delete(id);
    this.notify();
  }

  public getActiveModals(): ModalOptions[] {
    return Array.from(this.activeModals.values());
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }
}

export const overlayManager = new OverlayManagerService();
```

---

## 六、保留与舍弃决策矩阵（Keep vs Discard）

在本次重构体系中，必须做到「有取有舍」，严禁无限兼容旧包袱。

| 模块 / 资产                                             |          决策          | 处置方案与理由                                                                                           |
| :------------------------------------------------------ | :--------------------: | :------------------------------------------------------------------------------------------------------- |
| **二叉树不可变纯函数算子** (`operations.ts`)            |    **保留 (Keep)**     | 优秀的数学与算法资产，严格无副作用，天然支撑 Undo/Redo 历史栈。                                          |
| **Resize DOM 直写优化** (`TreeResizeSash.tsx`)          |    **保留 (Keep)**     | live-resize 绕过 React 状态直接修改 DOM `style`，消除拖拽迟滞的核心关键。                                |
| **`ui/TabStrip` 基座** (`TabStrip.tsx`)                 |    **保留 (Keep)**     | 完整的 roving tabindex 与无障碍 a11y 支持，已被顶栏与工具栏充分复用。                                    |
| **`TreeLeafPanel.tsx` 中的静态 switch**                 | **彻底舍弃 (Discard)** | 替换为 `ViewRegistry.getView(panelId)` 动态渲染，支持外部扩展。                                          |
| **旧 Columns/Groups 模型** (`CardPanelLayout.tsx`)      | **彻底舍弃 (Discard)** | 移除 `workspaceKind: 'columns'` 降级路径，删除 `CardPanel.tsx` 及关联的 `workspaceActions.ts` 冗余状态。 |
| **散落的静态名称字典** (`PANEL_LABELS` / `ui-panel.ts`) | **彻底舍弃 (Discard)** | 归一到 `ViewDefinition.title` 单一事实来源。                                                             |
| **`TreeLeaf` 中的业务 `isChatDomain` 硬编码**           | **彻底舍弃 (Discard)** | 二叉树回归纯粹的空间分割容器，会话与上下文关联转由 View 自身的 ContextAdapter 承载。                     |
| **`App.tsx` 顶层弹窗 `useState` 矩阵**                  | **彻底舍弃 (Discard)** | 替换为轻量 `OverlayManager` 驱动的 `<OverlayHost />`。                                                   |

---

## 七、分步演进与迁移路线图

为确保重构过程平稳，采取「**底座先行、向后兼容、渐进切流、彻底清退**」的四阶段实施路径：

```
┌────────────────────────────────────────────────────────────────────────┐
│                        四阶段渐进式重构路线图                          │
├────────────────────────────────────────────────────────────────────────┤
│  Phase 1: 基础设施注入 (Infrastructures)                               │
│  - 新建 ViewRegistry & SlotRegistry & OverlayManager 服务              │
│  - 建立标准 TypeScript 契约，与现有系统完全无害共存                    │
├────────────────────────────────────────────────────────────────────────┤
│  Phase 2: 视图分发切流 (ViewRegistry Cutover)                          │
│  - 注册 Chat, Terminal, Overview, Files, Diff 等全部内置视图           │
│  - 将 BrowserPanel 与 FlowDagView 注册为一等公民视图                   │
│  - 改造 TreeLeafPanel 接入 ViewRegistry，移除静态 switch               │
├────────────────────────────────────────────────────────────────────────┤
│  Phase 3: 区域插槽化改造 (Slotify Chrome)                              │
│  - 改造 AppTopBar, Sidebar, UnitChromeActions 接入 <Slot />            │
│  - 引入底部 AppStatusBar，将分散的引擎/Git/用量状态统一收敛            │
│  - 改造 AppGlobalDialogs 接入 OverlayManager                           │
├────────────────────────────────────────────────────────────────────────┤
│  Phase 4: 遗留资产清理 (Legacy Purge)                                  │
│  - 移除 CardPanel.tsx, CardPanelLayout.tsx 及旧 columns 布局代码       │
│  - 清理 createSsrGlobals.ts 中的 workspaceKind: 'columns' 选项         │
│  - 清理 layoutStore 中的 workspaceActions 冗余切片                     │
└────────────────────────────────────────────────────────────────────────┘
```

### 验收标准（Checklist）：

- [ ] 所有内置面板均通过 `viewRegistry.registerView()` 注册，`TreeLeafPanel.tsx` 无任何 `switch (panelId)`。
- [ ] `BrowserPanel`（AI 浏览器）和 `FlowDagView`（编排图）可作为独立 Tab 在二叉树中自由分屏、合并与拖拽。
- [ ] 顶栏、侧栏与面板头部均提供强类型 Slot 扩展点，支持无侵入注入新按钮与指示器。
- [ ] 彻底移除 Columns 遗留代码，代码库减少 ~1,500 行历史包袱。
- [ ] 保持全量 TypeScript 类型严格检查通过，无 `any` 逃逸，所有测试套件保持绿灯。
