# 全局状态流拓扑、Store 边界模糊与 Hook 过载 (Stores, Slices & Hook Topology) 深度审查

> **审查日期**：2026-08-16  
> **审查对象**：`apps/crish-desktop/src/store/` 状态架构、`apps/crish-desktop/src/hooks/` 核心 Hook 拓扑与组件层状态流  
> **审查性质**：前端架构全景扫描专项报告（Full-Sweep Architecture Review）  
> **审计纪律**：纯前端代码源码（.ts, .tsx）静态深度审查，严禁阅读外部文档，严禁执行构建与测试命令，全篇以代码路径与真实行号为铁证支撑。

---

## 目录

1. [核心执行摘要与架构现状](#一核心执行摘要与架构现状)
2. [layoutStore 上帝 Store 与伪门面模式深度剖析](#二layoutstore-上帝-store-与伪门面模式深度剖析)
   - 2.1 5 重异构领域与 74 个 Actions 的混杂全景
   - 2.2 伪门面（Pseudo-Facades）的本质与隐式穿透机制
   - 2.3 全局订阅风暴与级联重绘连锁反应
   - 2.4 病态防御代码案例：useScopedSessionField 逆向短路
   - 2.5 中间件与持久化开销叠加
3. [onShowToast 39 文件深层 Prop-Drilling 污染溯源](#三onshowtoast-39-文件深层-prop-drilling-污染溯源)
   - 3.1 跨越 9 层组件树的传递拓扑链条
   - 3.2 39 个受污染文件全景清单与类型分析
   - 3.3 破坏组件纯洁度与破坏 Memo 比较的根因
   - 3.4 策略断层与虚假调用陷阱
4. [上帝 Hook 过载与拓扑膨胀深度解剖](#四上帝-hook-过载与拓扑膨胀深度解剖)
   - 4.1 useChatCardState.ts（60 个导出属性）的超宽吞吐与过度订阅
   - 4.2 useChatComposerProps.ts（32 个导出属性）的职责交织与引擎侵入
   - 4.3 宽吞吐对象击穿 React.memo 的连带破坏
5. [状态流治理与 Slice 拆分架构重构方案](#五状态流治理与-slice-拆分架构重构方案)
   - 5.1 物理拆分 layoutStore 为三大独立 Zustand Store
   - 5.2 基于 Context / EventBus 的 Toast 通知体系重构
   - 5.3 上帝 Hook 的原子化解耦与分层装配设计
   - 5.4 四阶段平滑演进与迁移实施路径

---

## 一、核心执行摘要与架构现状

在前端架构设计中，状态管理不仅决定了数据流转的正确性，更深刻地制约着 UI 渲染性能、组件内聚度以及模块间的解耦边界。经过对 `apps/crish-desktop` 状态层与组件交互层的全景源码审计，当前系统在状态流拓扑上暴露出**四个根本性架构缺陷**：

```
                    ┌────────────────────────────────────────────────────────┐
                    │            layoutStore (God Store, 74 Actions)         │
                    │  [Chrome] [Sessions] [Legacy Columns] [Drafts] [Pop]   │
                    └──────────────────────────┬─────────────────────────────┘
                                               │ (Pseudo-Facades: same instance)
                 ┌─────────────────────────────┼─────────────────────────────┐
                 ▼                             ▼                             ▼
        useSessionStore               useWorkspaceStore             useSettingsUiStore
        (alias of layoutStore)        (alias of layoutStore)        (alias of layoutStore)
                 │                             │                             │
                 └──────────────────────┬──────┴─────────────────────────────┘
                                        │ 隐式全量通知 (Any change triggers all)
                                        ▼
                         ┌─────────────────────────────┐
                         │   useChatCardState (God)    │ ◀── 60 导出属性 / 5 Store 跨域
                         │   useChatComposerProps (God)│ ◀── 32 导出属性 / 队列+防抖杂糅
                         └──────────────┬──────────────┘
                                        │ 宽对象下发
                                        ▼
                         ┌─────────────────────────────┐
                         │      ChatCard.tsx (UI)      │
                         └──────────────┬──────────────┘
                                        │ onShowToast 9 层 Prop-Drilling
                                        ▼
        App.tsx ──▶ BinaryTreeWorkspace ──▶ TreeLeafPanel ──▶ ChatCard ──▶ ChatMessageList
        ──▶ MessageVirtualizer ──▶ ChatAssistantMessageRow ──▶ MessageActions ──▶ ChangeOverviewCard
```

1. **上帝 Store 伪门面（God Store & Pseudo-Facades）**：  
   `apps/crish-desktop/src/store/layoutStore.ts` 承载了 5 重异构领域（布局 Chrome、会话/消息/代理、遗留工作区列/DnD、草稿 Drafts、设置浮层）以及 74 个 Actions。虽然表面上建立了 `sessionStore.ts`、`workspaceStore.ts`、`settingsUiStore.ts` 等独立文件，但其本质均为 `export const useSessionStore = useLayoutStore;` 的**别名门面**。任何局部的微小改动（如输入框草稿写入、侧边栏折叠、列宽微调）都会在底层 Zustand 触发全局 listener，导致所有挂在伪门面上的下游 Selector 全部被动唤醒。

2. **通知穿透 39 文件的深层 Prop-Drilling 污染**：  
   `onShowToast` 作为全局性轻量通知能力，没有采用 React Context 或全局事件机制，而是从根节点 `App.tsx` 沿着组件树层层向下透传至最底层的卡片操作栏与行内按钮，纵深跨越 **9 层组件**，波及 **39+ 个源码文件**。展示型、几何型与虚拟化滚动组件（如 `BinaryTreeWorkspace`, `TreeLeafPanel`, `MessageVirtualizer`）被迫承载无意义的函数签名，导致 `React.memo` 比较冗余，且引发多处无效的策略冲突调用。

3. **巨型上帝 Hook（God Hooks）过载**：  
   `useChatCardState.ts` 导出多达 **60 个属性**，`useChatComposerProps.ts` 导出 **32 个属性**。单一 Hook 内部混合了数据订阅、项目切换、本地过滤、模型选择、权限控制、滚动锚定、审批处理、输入防抖、消息排队、流式收发等极度分散的职责。这种超宽的吞吐面导致下游组件即使使用 `useMemo` 也无法维持依赖项稳定，任何细微更新都会击穿 Memoization 机制，引发雪崩式重渲染。

4. **病态防御代码的滋生与蔓延**：  
   为了对抗上帝 Store 伪门面带来的全局高频更新，开发人员在业务层被迫发明了 `useScopedSessionField` 等复杂的定制订阅短路机制（通过 `useLayoutStore.subscribe` + `useReducer` 强行拦截），进一步加剧了状态拓扑的混乱与不可预测性。

---

## 二、layoutStore 上帝 Store 与伪门面模式深度剖析

### 2.1 5 重异构领域与 74 个 Actions 的混杂全景

在 `apps/crish-desktop/src/store/layoutStore.ts` 中，`useLayoutStore` 作为一个单例 Store，混合了 5 个在生命周期、更新频率、读写模型上完全正交的领域状态：

```typescript
// apps/crish-desktop/src/store/layoutStore.ts:142-185
export interface LayoutStore extends SessionActions, WorkspaceActions {
  // 领域 1: 遗留工作区列/卡片/拖拽 (Legacy Workspace Columns & DnD)
  workspaces: WorkspaceState[];
  activeWorkspaceIndex: number;
  draggedTab: DraggedTabState | null;
  dropPreview: DropPreviewState | null;

  // 领域 2: 布局与壳层 UI (Layout Chrome)
  tabModeEnabled: boolean;
  uiSize: UiSize;
  shellChromeMode: ShellChromeMode;
  chatMainSurface: 'chat' | 'scheduled';
  sidebarCollapsed: boolean;

  // 领域 3: 会话与消息账本 (Session Domain)
  sessions: SessionState[];
  sessionsById: Record<string, SessionState>;
  folderOrder: string[];
  activeSessionId: string;
  draftFolder: string;
  activeAgentId: string | null;
  panelAgentId: string | null;
  hydrationComplete: boolean;

  // 领域 4: 输入框草稿暂存 (Composer Drafts)
  composerDrafts: Record<string, string>;

  // 领域 5: 设置浮层 UI (Settings Overlay)
  showSettingsOverlay: boolean;
  settingsActiveTab: SettingsTabType;

  // Layout Chrome Actions
  setUiSize: (size: UiSize) => void;
  setShellChromeMode: (mode: ShellChromeMode) => void;
  setChatMainSurface: (surface: 'chat' | 'scheduled') => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTabModeEnabled: (enabled: boolean) => void;
  setShowSettingsOverlay: (show: boolean) => void;
  setSettingsActiveTab: (tab: SettingsTabType) => void;
  openSettings: (tab?: SettingsTabType) => void;
  setActiveWorkspaceIndex: (index: number) => void;
}
```

这些领域所承载的 Actions 数量极为庞大，分布在以下模块中：

| Action 切片模块       | 文件路径                                                                                                                               | Action 数量 | 典型操作与职责                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LayoutCoreActions** | [layout-core-actions.ts:38-123](file:///c:/Software/conex/apps/crish-desktop/src/store/layout-helpers/layout-core-actions.ts#L38-L123) | **9 个**    | `setUiSize`, `setShellChromeMode`, `setChatMainSurface`, `setSidebarCollapsed`, `setTabModeEnabled`, `setShowSettingsOverlay`, `setSettingsActiveTab`, `openSettings`, `setActiveWorkspaceIndex`                                                                                                                                                                                                      |
| **WorkspaceActions**  | [workspaceActions.ts:61-82](file:///c:/Software/conex/apps/crish-desktop/src/store/workspaceActions.ts#L61-L82)                        | **16 个**   | `setDropPreview`, `togglePanel`, `resizeColumns`, `resizeGroups`, `setDraggedTab`, `mergeTab`, `detachTabToStandalone`, `moveTabOrGroupRealtime`, `closeTabInGroup`, `splitScreenWorkspace`, `closeWorkspace`, `applyLayoutPreset`, `applyWorkspaceLayout`, `setGroupActiveCard`, `focusExistingPanelCard`, `collapseToolColumnPreserve`                                                              |
| **SessionActions**    | [sessionActions.ts:66-280](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionActions.ts#L66-L280)                          | **49 个**   | 涵盖 CRUD（`createSession`, `deleteSession`, `renameSession` 等）、消息管理（`addMessage`, `updateMessageText`, `withdrawMessage`, `applyTimelineTruncate` 等）、工具调用与审批（`respondToApproval`, `applyToolCallPatches`, `markToolCallLocalStatus` 等）、Agent/Subagent（`upsertSessionAgent`, `patchSessionAgentMessage` 等）、排序与归档（`pinSession`, `archiveSession`, `branchSession` 等） |
| **合计**              | —                                                                                                                                      | **74 个**   | **全部混杂在单一 useLayoutStore 实例中**                                                                                                                                                                                                                                                                                                                                                              |

### 2.2 伪门面（Pseudo-Facades）的本质与隐式穿透机制

在代码库的目录结构中，虽然存在 `sessionStore.ts`、`workspaceStore.ts` 和 `settingsUiStore.ts`，给人一种「领域驱动切分」的错觉，但查看源码即可发现它们全部是**纯粹的引用别名**：

```typescript
// apps/crish-desktop/src/store/sessionStore.ts:35
/** 与 layout 同引用：切片式 facade，禁止第二份 sessions 真相源 */
export const useSessionStore = useLayoutStore;

// apps/crish-desktop/src/store/workspaceStore.ts:39
export const useWorkspaceStore = useLayoutStore;

// apps/crish-desktop/src/store/settingsUiStore.ts:69
export const useSettingsUiStore = useLayoutStore;
```

甚至在官方归属文档 `apps/crish-desktop/src/store/storeOwnership.ts:45-48` 中，明确标注了这些 Store 的别名本质：

```typescript
export type StoreWriteOwner =
  | 'layoutStore'
  | 'sessionStore' // alias of layoutStore
  | 'workspaceStore' // alias of layoutStore
  | 'settingsUiStore' // alias of layoutStore (overlay) + permissionStore delegation
  ...
```

**伪门面的隐式穿透危害**：

1. **单一 EventEmitter 广播**：Zustand 的工作原理是基于单一 Store 实例的发布订阅机制。调用 `useSessionStore(selector)` 与调用 `useLayoutStore(selector)` 在运行时注册的是同一个 Store 的订阅者列表。
2. **无关领域变更唤醒**：
   - 当用户拖动窗口边框调整列宽时，触发 `resizeColumns`（修改 `workspaces`），注册在 `useSessionStore` 下的数十个会话消息订阅者被全部唤醒并执行 selector。
   - 当用户在输入框输入文字，通过防抖触发 `setComposerDraft`（修改 `composerDrafts`）时，注册在 `useWorkspaceStore` 下的布局树订阅者与侧边栏订阅者被全部唤醒。
   - 当切换设置浮层标签触发 `setSettingsActiveTab` 时，整个聊天消息列表的 selector 也会被动触发重新计算。

### 2.3 全局订阅风暴与级联重绘连锁反应

在 `apps/crish-desktop/src/store/layoutStore.ts:253-258` 中，开发期甚至挂载了全局更新计数器：

```typescript
if (import.meta.env?.DEV) {
  window.__storeUpdateCount = 0;
  useLayoutStore.subscribe(() => {
    window.__storeUpdateCount = (window.__storeUpdateCount || 0) + 1;
  });
}
```

由于 5 个领域的数据均在此单例中频繁变更，在一次典型的 AI 流式回答或用户多标签拖拽过程中，`__storeUpdateCount` 可以在数秒内增加数百次。

即使 React 组件使用了 selector（如 `(s) => s.sidebarCollapsed`），Zustand 的 `useStore` 仍必须在每次 Store 派发更新时，同步调用该 selector 函数，并通过 `Object.is` 对比前后返回值。当组件树中有数以百计的叶子节点均连接到此 Store 时，每次微小变更都会引发大量的函数执行与闭包开销。

### 2.4 病态防御代码案例：useScopedSessionField 逆向短路

由于上帝 Store 的全局更新过于剧烈，严重影响了消息列表的渲染性能，开发团队在 `apps/crish-desktop/src/components/chat-card/useChatCardState.ts:60-105` 中不得不手写了一段极为扭曲的「会话级订阅短路」逻辑：

```typescript
// apps/crish-desktop/src/components/chat-card/useChatCardState.ts:60-105
export function useScopedSessionField<T>(
  resolveSid: (state: SessionStoreStateShape) => string,
  selector: (session: SessionState | undefined) => T
): T {
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);
  const resolveSidRef = useRef(resolveSid);
  resolveSidRef.current = resolveSid;
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const cacheRef = useRef<{
    sid: string;
    session: SessionState | undefined;
    value: T;
  } | null>(null);

  useEffect(() => {
    return useLayoutStore.subscribe((state, prev) => {
      const st = state as SessionStoreStateShape;
      const sid = resolveSidRef.current(st);
      const prevSid = resolveSidRef.current(prev as SessionStoreStateShape);
      const session = st.sessionsById[sid];
      const cached = cacheRef.current;
      // 会话级订阅短路：本会话引用未变 + activeSessionId 未变 → 直接短路
      if (
        cached &&
        cached.sid === prevSid &&
        cached.session === session &&
        (prev as SessionStoreStateShape).activeSessionId === st.activeSessionId
      ) {
        return;
      }
      cacheRef.current = { sid, session, value: selectorRef.current(session) };
      forceUpdate();
    });
  }, []);

  // 渲染期求值（首次挂载 / forceUpdate 后）：缓存命中直接复用
  const st = useLayoutStore.getState() as SessionStoreStateShape;
  const sid = resolveSid(st);
  const session = st.sessionsById[sid];
  const cached = cacheRef.current;
  if (!cached || cached.sid !== sid || cached.session !== session) {
    cacheRef.current = { sid, session, value: selector(session) };
  }
  return cacheRef.current!.value;
}
```

**对该病态实现的架构定性**：

- **绕过 React 正常状态流**：通过 `useLayoutStore.subscribe` 原生监听配合 `useReducer` 强行触发局部更新，完全脱离了 React 18 的 `useSyncExternalStore` 体系。
- **倒逼业务层为架构缺陷买单**：在 `useChatCardState.ts:135-162` 中，为了获取一个会话的 7 个字段（`messages`, `agents`, `goalMode`, `hydratedFromEngine`, `engineCursor`, `engineLastRunId`, `activeSessionTitle`），连续调用了 7 次 `useScopedSessionField`，注册了 7 个独立的底层 subscribe 监听器！
- **本质根因**：如果 `sessionStore` 是独立的物理 Store，且按 `sessionId` 进行分片或规范化，根本无需这种人工短路黑魔法。

### 2.5 中间件与持久化开销叠加

在 `apps/crish-desktop/src/store/layoutStore.ts:192-246` 中，`useLayoutStore` 被层层中间件包裹：

```typescript
withDevtools(
  withLogger(
    withPersist(
      withAutoIndex(
        immer(...)
      )
    )
  )
)
```

查看 `apps/crish-desktop/src/store/autoIndexMiddleware.ts:56-123`：

```typescript
const setWithIndex: SetStateFn<S> = (partial, replace) => {
  ...
  if (isSessionsAwareState(partial)) {
    if (partial.sessions !== prevSessions || !('sessionsById' in partial)) {
      prevSessions = partial.sessions;
      rawSet({
        ...partial,
        sessionsById: buildSessionsMap(partial.sessions),
      } as S, false);
      return;
    }
  }
  rawSet(partial, replace);
};
```

哪怕调用的是 `setUiSize('compact')` 或 `setSidebarCollapsed(true)`，每次 `set` 操作都必须无差别地流经 `withAutoIndex`、`withPersist`（执行 partialize 提取与序列化判断）、`withLogger` 和 `withDevtools`，造成不必要的 CPU 周期浪费。

---

## 三、onShowToast 39 文件深层 Prop-Drilling 污染溯源

### 3.1 跨越 9 层组件树的传递拓扑链条

在当前的 UI 实现中，全局轻量提示（Toast）未采用 React Context 或全局事件发布订阅，而是从顶层组件逐级向下 Prop-Drilling，形成了一条极其漫长且脆弱的传递链路：

```
[Level 1] App.tsx:101 (useToastQueue 产生 handleShowToast)
   │
   ├─▶ Line 292: <BinaryTreeWorkspace onShowToast={handleShowToast} />
   │
   ▼
[Level 2] BinaryTreeWorkspace.tsx:38, 129
   │
   ├─▶ Line 224: <TreeLeafPanel onShowToast={onShowToast} ... />
   │
   ▼
[Level 3] TreeLeafPanel.tsx:80, 120 (并在 Line 209 加入 memo 比较)
   │
   ├─▶ Line 196: <ChatCard onShowToast={onShowToast} ... />
   ├─▶ Line 281: <PreviewCard onShowToast={onShowToast} ... />
   ├─▶ Line 285: <FilesCard onShowToast={onShowToast} ... />
   ├─▶ Line 287: <DiffCard onShowToast={onShowToast} ... />
   ├─▶ Line 289: <RuntimePanel onShowToast={onShowToast} ... />
   │
   ▼
[Level 4] ChatCard.tsx:23, 33
   │
   ├─▶ Line 36: useChatCardState({ onShowToast, ... })
   ├─▶ Line 170: <ScheduledTasksPanel onShowToast={onShowToast} />
   ├─▶ Line 206: <ChatMessageList onShowToast={onShowToast} />
   ├─▶ Line 236: <ChatComposerWrapper onShowToast={onShowToast} />
   │
   ▼
[Level 5] ChatMessageList.tsx:65, 78
   │
   ├─▶ Line 129: useChatMessageState({ onShowToast, ... })
   ├─▶ Line 186: useScrollAnchor({ onShowToast, ... })
   ├─▶ Line 350: <MessageVirtualizer onShowToast={onShowToast} />
   │
   ▼
[Level 6] MessageVirtualizer.tsx:40, 61
   │
   ├─▶ Line 303: <ChatUserMessageRow onShowToast={onShowToast} />
   ├─▶ Line 327: <StreamingAssistantRow onShowToast={onShowToast} />
   │
   ▼
[Level 7] ChatAssistantMessageRow.tsx:40, 53
   │
   ├─▶ Line 86, 92: handleCopy() 内使用 onShowToast('没有可复制的正文') / onShowToast('复制失败')
   ├─▶ Line 140: <MessageActions onShowToast={onShowToast} />
   │
   ▼
[Level 8] MessageActions.tsx:38, 62
   │
   ├─▶ Line 71, 77: onNoteSuccess / onNoteError 回调内使用 onShowToast
   ├─▶ Line 124: <ChangeOverviewCard onShowToast={onShowToast} />
   │
   ▼
[Level 9] ChangeOverviewCard.tsx
```

### 3.2 39 个受污染文件全景清单与类型分析

通过静态全量扫描，直接在 Props 接口中声明或透传 `onShowToast: ShowToastFn` / `onShowToast: (message: string) => void` 的文件多达 **39 个**（排除测试文件后），涵盖整个前端架构的所有层级：

| 架构层级                     | 受污染文件清单与代码位置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **应用根与全局容器 (3)**     | [App.tsx:259, 292, 298](file:///c:/Software/conex/apps/crish-desktop/src/App.tsx#L259)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **工作区与多窗格几何层 (4)** | [BinaryTreeWorkspace.tsx:38, 129, 224](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.tsx#L38)<br>[TreeLeafPanel.tsx:80, 120, 196, 209, 223, 260, 273, 281, 285, 287, 289](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx#L80)<br>[CardPanel.tsx:24, 82, 200](file:///c:/Software/conex/apps/crish-desktop/src/components/CardPanel.tsx#L24)<br>[CardPanelLayout.tsx:8](file:///c:/Software/conex/apps/crish-desktop/src/components/card-panel/CardPanelLayout.tsx#L8)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **对话主卡片与外壳 (4)**     | [ChatCard.tsx:23, 33, 36, 170, 206, 236](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatCard.tsx#L23)<br>[ChatComposerWrapper.tsx:4, 236](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatComposerWrapper.tsx#L4)<br>[ApprovalDock.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ApprovalDock.tsx)<br>[ChatStatusRibbons.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.tsx)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **消息列表与虚拟滚动层 (3)** | [ChatMessageList.tsx:65, 78, 88, 129, 186, 350](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/ChatMessageList.tsx#L65)<br>[MessageVirtualizer.tsx:40, 303, 327](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx#L40)<br>[messageVirtualizerMemo.ts:19](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/messageVirtualizerMemo.ts#L19)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **消息行与动作栏层 (5)**     | [ChatAssistantMessageRow.tsx:40, 86, 92, 140](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatAssistantMessageRow.tsx#L40)<br>[ChatUserMessageRow.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatUserMessageRow.tsx)<br>[chatMessageRowUtils.ts](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/chatMessageRowUtils.ts)<br>[MessageActions.tsx:38, 62, 71, 77, 124](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageActions.tsx#L38)<br>[AgentMessageRow.tsx:83](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/AgentMessageRow.tsx#L83)                                                                                                                                                                                                                                                                                             |
| **功能扩展面板 (6)**         | [DiffCard.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.tsx)<br>[DiffCardFileList.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx)<br>[ChangeOverviewCard.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/ChangeOverviewCard.tsx)<br>[FilesCard.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.tsx)<br>[FileViewerCard.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileViewerCard.tsx)<br>[OverviewCard.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.tsx)                                                                                                                                                                                                                                                                                                                                 |
| **侧边栏与用户设置 (8)**     | [Sidebar.tsx:14](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.tsx#L14)<br>[SidebarFooter.tsx:12](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarFooter.tsx#L12)<br>[UserProfileCard.tsx:5](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/UserProfileCard.tsx#L5)<br>[useSidebarContextMenu.ts:4](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/useSidebarContextMenu.ts#L4)<br>[SettingsExtensionsTab.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/SettingsExtensionsTab.tsx)<br>[McpSettingsTab.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-mcp/McpSettingsTab.tsx)<br>[McpServerForm.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-mcp/McpServerForm.tsx)<br>[ModelsSettingsTab.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.tsx) |
| **浏览器与系统卡片 (3)**     | [BrowserPanel.tsx:49](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/BrowserPanel.tsx#L49)<br>[BrowserImportSection.tsx:41](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/browser-panel/BrowserImportSection.tsx#L41)<br>[ComputerPanel.tsx:27](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/computer-panel/ComputerPanel.tsx#L27)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **底层 Hooks 传递层 (7+)**   | [useChatCardState.ts:26, 109, 117](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/useChatCardState.ts#L26)<br>[useChatComposerProps.ts:8, 36, 48](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/useChatComposerProps.ts#L8)<br>[useChatHandlers.ts:2](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/useChatHandlers.ts#L2)<br>[useChatApprovalHandlers.ts:2](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/useChatApprovalHandlers.ts#L2)<br>[useChatApprovalExecutor.ts:10](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/useChatApprovalExecutor.ts#L10)<br>[useChatMessageState.ts:129](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/useChatMessageState.ts#L129)<br>[useScrollAnchor.ts:186](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/useScrollAnchor.ts#L186)                                    |

### 3.3 破坏组件纯洁度与破坏 Memo 比较的根因

1. **中间组件契约污染**：  
   `TreeLeafPanel`（二叉树布局叶子节点）的核心职责是根据 `leaf.kind` 路由渲染对应的面板卡片；`MessageVirtualizer` 的职责是管理虚拟滚动视口与计算 offset。这两个纯几何/结构组件本不需要感知任何全局 Toast 通知，却被迫在 Props 类型定义中声明 `onShowToast: ShowToastFn`，严重违反了**单一职责原则**与**接口隔离原则**。

2. **React.memo 比较防御膨胀**：  
   在 `TreeLeafPanel.tsx:209` 中：
   ```typescript
   export const TreeLeafPanel = React.memo(
     TreeLeafPanelInner,
     (prev, next) =>
       prev.leaf === next.leaf &&
       prev.wsId === next.wsId &&
       prev.isActive === next.isActive &&
       prev.onShowToast === next.onShowToast && // 冗余的函数引用比较
       prev.handleGlobalTabClick === next.handleGlobalTabClick
   );
   ```
   中间层为了保证自身的 `React.memo` 不被破坏，必须将 `onShowToast` 纳入 props 比较，一旦上游某层生成了新的闭包，就会直接击穿下游所有组件的 memo 护盾。

### 3.4 策略断层与虚假调用陷阱

在 `apps/crish-desktop/src/hooks/useToastQueue.ts:75-144` 中，定义了严格的 `FORBIDDEN_SUCCESS_TOAST_PATTERNS` 禁令：

```typescript
const FORBIDDEN_SUCCESS_TOAST_PATTERNS: readonly RegExp[] = [
  /^已打开/,
  /^已导出/,
  /^已复制/,
  /^已保存/,
  /^已发送/, // 成功类文案一律禁止弹 Toast 刷屏
  ...
];
```

然而，在经过 8 层透传后的 `MessageActions.tsx:68-72` 中，业务代码却写道：

```typescript
const onNoteSuccess = useCallback(
  (_result: Extract<SendToNoteResult, { ok: true }>) => {
    onShowToast('已发送到笔记'); // 违反策略，将被 useToastQueue 静默丢弃
  },
  [onShowToast]
);
```

**问题定性**：深层的 Prop-Drilling 彻底割裂了「Toast 策略定义」与「业务触发点」的可见性。底层组件的开发者根本无法直接感知 `useToastQueue` 的产品禁令，盲目传入 `onShowToast('已发送到笔记')` 产生假死调用，造成无效的代码膨胀。

---

## 四、上帝 Hook 过载与拓扑膨胀深度解剖

### 4.1 useChatCardState.ts（60 个导出属性）的超宽吞吐与过度订阅

`apps/crish-desktop/src/components/chat-card/useChatCardState.ts` 是整个对话界面的核心控制 Hook，其代码行数达 446 行，返回一个包含 **60 个属性** 的巨大对象：

```typescript
// apps/crish-desktop/src/components/chat-card/useChatCardState.ts:381-443
return {
  activeSessionId,
  activeSessionTitle,
  messages,
  agents,
  goalMode,
  goalModeActive,
  diffFiles,
  showProjectPicker,
  setShowProjectPicker,
  mainSurface,
  setMainSurface,
  projectTick,
  setProjectTick,
  localMsgFilter,
  setLocalMsgFilter,
  showMsgFilter,
  setShowMsgFilter,
  msgFilterInputRef,
  engineModel,
  activeProfileId,
  showModelDropdown,
  setShowModelDropdown,
  engineHint,
  needsKeySetup,
  needsModelSetup,
  showModelPicker,
  displayMessages,
  messagesLoading,
  emptyKind,
  onEmptySurface,
  chatRegionAria,
  permissionMode,
  setPermissionMode,
  planApproved,
  setPlanApproved,
  inPlanMode,
  openSidePanel,
  isProcessing,
  openPathInFilesPanel,
  chatFlowRef,
  showScrollToBottom,
  scrollToBottom,
  composerProps,
  handleRegenerate,
  handleBranch,
  handleRetract,
  handleExportMarkdown,
  approvalState,
  openDiffInRightPanel,
  isFiltering,
  firstRunOpen,
  engineOk,
  handleCreateSessionFromEmpty,
  handleProjectChanged,
  handleSendFollowUp,
  handleOpenTerminal,
  handleOpenDiffPanel,
  openSettings,
  patchSession,
  clearSessionMessages,
};
```

**该 Hook 混杂的 12 重正交职责**：

1. **会话核心数据订阅**（`messages`, `agents`, `activeSessionTitle` 等）
2. **多 Agent 状态与 Goal 推进模式**（`goalMode`, `goalModeActive`）
3. **全局设置与 Diff 终端联动**（`appSettings`, `diffFiles`, `openSidePanel`）
4. **模型切换与状态提示**（`useModelSelection`, `showModelDropdown`, `engineHint`）
5. **项目选择器弹窗状态**（`showProjectPicker`, `projectTick`）
6. **主界面视口模式**（`chatMainSurface`: 'chat' | 'scheduled'）
7. **本地行内消息过滤**（`localMsgFilter`, `showMsgFilter`, `msgFilterInputRef`）
8. **空状态判定与占位渲染**（`useChatEmptyKind`, `emptyKind`, `onEmptySurface`）
9. **权限与 Plan 审批模式**（`permissionMode`, `planApproved`, `inPlanMode`）
10. **滚动与锚点控制**（`useChatScrollAnchor`, `scrollToBottom`, `showScrollToBottom`）
11. **嵌套集成输入框 Hook**（`useChatComposerProps`，又引入 32 个属性）
12. **消息操作与审批闭包**（`useChatHandlers`, `useChatApprovalHandlers`）

**跨 Store 过度订阅**：
在单个 Hook 中，同时订阅了：

- `useSessionField` / `useScopedSessionField` (Session 域)
- `useSettingsField` (Settings 域)
- `useTerminalField` (Terminal 域)
- `usePermissionField` (Permission 域)
- `useLayoutStore` (Layout Chrome 域)

任何一个外部域的状态微调（如终端输出产生新的 diff、权限模式由 ask 变为 allow、设置中心保存了 token），都会触发 `useChatCardState` 的全量重求值。

### 4.2 useChatComposerProps.ts（32 个导出属性）的职责交织与引擎侵入

`apps/crish-desktop/src/components/chat-card/useChatComposerProps.ts` 共 532 行代码，返回 **32 个属性**：

```typescript
// apps/crish-desktop/src/components/chat-card/useChatComposerProps.ts:498-531
return {
  chatInput,
  setChatInput,
  isComposing,
  setIsComposing,
  slashMenuOpen,
  setSlashMenuOpen,
  slashSelectedIndex,
  setSlashSelectedIndex,
  filteredCommands,
  loadSkillSlash,
  attachments,
  setAttachments,
  fileInputRef,
  handleFilesSelected,
  handlePasteImage,
  canSend,
  showPlusMenu,
  setShowPlusMenu,
  runNotice,
  setRunNotice,
  runStreamingAssistant,
  handleSendChat,
  handleStopGeneration,
  handleForceCancelGeneration,
  onSend,
  queueMode,
  queuedMessages,
  enqueueMessage,
  deleteQueuedMessage,
  editQueuedMessage,
  sendQueuedMessageNow,
};
```

**职责交织缺陷**：

1. **草稿防抖持久化逻辑侵入**：  
   `scheduleComposerDraft` 设置了 350ms 的定时器，向 `useLayoutStore` 写入 `composerDrafts`。打字操作直接与全局 Store 产生高频 I/O。
2. **Slash Command 检索与动态导入混杂**：  
   静态内置指令（`/goal`, `/learn`, `/schedule` 等）与异步技能命令（`crish-skills-changed` 事件、`getSkillSlashCommandsCached` 动态 import）全部由本 Hook 自行发起并维护 state。
3. **消息队列引擎（Queue Mode Engine）倒挂在 UI Hook 中**：  
   `useChatComposerProps` 内部居然维护了完整的后台消息排队与 Drain 状态机（`queuedMessages`, `drainLockRef`, `editedBackMsgIdRef`，并在 `useEffect` 中监听 `isProcessing` 自动触发 `sendQueuedMessageNow`）。这种本应属于「会话运行时协调器（SessionCoordinator）」的后台调度逻辑，被硬编码在了一个 React 输入框 Hook 中！

### 4.3 宽吞吐对象击穿 React.memo 的连带破坏

在 `apps/crish-desktop/src/components/chat-card/ChatCard.tsx:79-114` 中，为了组装状态条 props，编写了如下代码：

```typescript
// apps/crish-desktop/src/components/chat-card/ChatCard.tsx:79-114
const ribbons = React.useMemo(
  () => ({
    onOpenTerminal: () => state.openSidePanel('terminal'),
    onOpenDiff: () => state.openSidePanel('diff'),
    diffCount: state.diffFiles.length,
    engineHint: state.engineHint,
    needsKeySetup: state.needsKeySetup,
    needsModelSetup: state.needsModelSetup,
    onEmptySurface: state.onEmptySurface,
    localHasKey: anyProfileHasKey(),
    onOpenModelSettings: () => state.openSettings('models'),
    onOpenModelDropdown: () => state.setShowModelDropdown(true),
    inPlanMode: state.inPlanMode,
    planApproved: state.planApproved,
    onApprovePlan: () => {
      state.setPermissionMode('ask');
      state.setPlanApproved(true);
    },
    goalModeActive: state.goalModeActive,
    goalText: state.goalMode?.goal || '',
    goalIteration: state.goalMode?.iteration ?? 0,
    goalTasksDone: (state.goalMode?.tasks || []).filter((t) => t.done).length,
    goalTasksTotal: (state.goalMode?.tasks || []).length,
    onStopGoal: () => {
      state.composerProps.handleStopGeneration();
      if (state.activeSessionId) {
        state.patchSession(state.activeSessionId, { goalMode: null });
      }
    },
    showScrollToBottom: state.showScrollToBottom,
    onScrollToBottom: state.scrollToBottom,
  }),
  [state] // 致命依赖：直接依赖上帝 Hook 返回的整包 state！
);
```

**破坏后果**：

- 由于 `state` 是一个拥有 60 个属性的非稳定对象引用，只要 `state` 中任何一个无关属性（如 `localMsgFilter` 打字、`projectTick` 递增、`isComposing` 改变）发生变动，`useMemo(..., [state])` 就会立即失效，重新生成全新的 `ribbons` 对象。
- 下游的 `<ChatComposerWrapper ribbons={ribbons} />` 将无条件重新渲染，导致整个底栏组件的 `React.memo` 完全失效。

---

## 五、状态流治理与 Slice 拆分架构重构方案

针对上述审查发现的系统性缺陷，提出以下标准架构治理方案，彻底解除 Store 伪门面、消除 Prop-Drilling 污染并拆解上帝 Hook。

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                重构后全新状态拓扑设计                                   │
└────────────────────────────────────────────────────────────────────────────────────────┘

 [1. 物理 Store 拆分 (Independent Zustand Stores)]
 ┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐
 │      sessionStore       │  │    layoutChromeStore    │  │   composerDraftStore    │
 │ (sessions, messages,    │  │ (uiSize, sidebar,       │  │ (drafts, attachments,   │
 │  agents, activeSid)     │  │  shellMode, overlay)    │  │  debounced local save)  │
 └─────────────────────────┘  └─────────────────────────┘  └─────────────────────────┘

 [2. 全局通知解耦 (Toast Context & Event Architecture)]
 ┌───────────────────────────────────────────────────────────────────────────────────┐
 │  <ToastProvider> ──▶ useToast() Hook / toast.error() / toast.undo()                │
 │  彻底拔除 39 个组件上的 onShowToast Prop-Drilling 链条                               │
 └───────────────────────────────────────────────────────────────────────────────────┘

 [3. 上帝 Hook 原子化装配 (Composable Chat Hooks)]
 ┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐
 │  useChatSessionMessages │  │     useChatFilter       │  │  useChatRibbonControls  │
 │  (按 sid 精确隔离订阅)   │  │   (本地行内搜索防抖)   │  │  (面板联动与权限审批)    │
 └─────────────────────────┘  └─────────────────────────┘  └─────────────────────────┘
              │                            │                            │
              └────────────────────────────┼────────────────────────────┘
                                           ▼
                                ┌─────────────────────┐
                                │    ChatCard.tsx     │ 按需解构，依赖精确细化
                                └─────────────────────┘
```

### 5.1 物理拆分 layoutStore 为三大独立 Zustand Store

彻底废除 `useSessionStore = useLayoutStore` 的别名伪门面，建立三个物理隔离的 Zustand 实例：

#### (1) `sessionStore.ts`（会话与消息核心账本）

- **状态范围**：`sessions: SessionState[]`, `sessionsById: Record<string, SessionState>`, `activeSessionId: string`, `folderOrder: string[]`, `activeAgentId: string | null`, `panelAgentId: string | null`, `hydrationComplete: boolean`
- **Actions**：保留 49 个会话/消息/Agent CRUD Actions。
- **持久化**：独立存储键 `crish-sessions-v1`。
- **索引机制**：`withAutoIndex` 中间件仅服务于本 Store，不会再被布局与草稿操作意外触发。

#### (2) `layoutChromeStore.ts`（纯净布局与壳层 UI）

- **状态范围**：`uiSize: UiSize`, `shellChromeMode: ShellChromeMode`, `chatMainSurface: 'chat' | 'scheduled'`, `sidebarCollapsed: boolean`, `tabModeEnabled: boolean`, `showSettingsOverlay: boolean`, `settingsActiveTab: SettingsTabType`
- **Actions**：仅保留 9 个布局控制 Actions（`setUiSize`, `setSidebarCollapsed`, `openSettings` 等）。
- **持久化**：独立存储键 `crish-layout-chrome-v1`。
- **收益**：侧栏折叠、界面缩放、设置弹窗等 UI 交互与消息数据彻底解耦，互不干扰。

#### (3) `composerDraftStore.ts`（输入框草稿暂存）

- **状态范围**：`draftsBySessionId: Record<string, string>`, `attachmentsBySessionId: Record<string, ChatAttachment[]>`
- **Actions**：`setDraft(sid, text)`, `clearDraft(sid)`, `setAttachments(sid, items)`
- **持久化**：独立防抖持久化 `crish-composer-drafts-v1`。
- **收益**：用户高速打字时，只在 `composerDraftStore` 产生极小范围的单键更新，绝对不触发 `sessionStore` 和 `layoutChromeStore` 的任何 Listener。

#### (4) 遗留 `workspaceStore` 彻底退役

由于现代多窗格架构已完全由 `layout-tree`（二叉树几何）和 `workspace-shell`（TabSurface 标签页）接管，原 `workspaceStore` 中遗留的 pre-tree 卡片列管理逻辑（`workspaces[]`, `ColumnState`, `CardGroupState`）应全部标记为废弃并安全下线。

---

### 5.2 基于 Context / EventBus 的 Toast 通知体系重构

#### 设计方案：ToastContext + useToast() Hook

在 `apps/crish-desktop/src/context/ToastContext.tsx` 中建立标准的 Context 提供者：

```typescript
// 建议标准实现：apps/crish-desktop/src/context/ToastContext.tsx
import React, { createContext, useContext } from 'react';
import { useToastQueue, type ShowToastFn } from '../hooks/useToastQueue';
import { ToastStack } from '../components/overlay/ToastStack';

const ToastContext = createContext<ShowToastFn | null>(null);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { toasts, showToast, dismissToast } = useToastQueue();

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
};

export function useToast(): ShowToastFn {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
```

#### 改造收益：

1. **彻底拔除 39 个文件的 Prop 传递**：
   从 `App.tsx`、`BinaryTreeWorkspace.tsx`、`TreeLeafPanel.tsx`、`ChatMessageList.tsx`、`MessageVirtualizer.tsx` 等中间层中完全删除 `onShowToast` 属性声明。
2. **叶子组件即时消费**：
   在真正需要弹出提示的叶子组件（如 `ChatAssistantMessageRow.tsx` 或 `UserProfileCard.tsx`）中，直接调用：
   ```typescript
   const showToast = useToast();
   // 触发错误或撤销通知
   showToast('复制失败');
   ```
3. **接口大幅精简**：
   `MessageVirtualizerProps` 和 `TreeLeafPanelProps` 不再受 `onShowToast` 函数引用的干扰，`React.memo` 比较函数可以直接精简为基于核心数据属性的比对。

---

### 5.3 上帝 Hook 的原子化解耦与分层装配设计

将巨型 Hook 按照**单一职责**拆分为若干高内聚、窄接口的微 Hook：

#### (1) `useChatCardState` 拆解方案

```typescript
// 1. 会话数据核心 Hook (精确订阅当前 sessionId 的消息与 Agent)
export function useChatSessionMessages(sessionId: string | null) {
  const session = useSessionStore((s) =>
    sessionId ? s.sessionsById[sessionId] : undefined
  );
  return {
    messages: session?.messages || EMPTY_ARRAY,
    agents: session?.agents || EMPTY_ARRAY,
    goalMode: session?.goalMode,
    title: session?.title || '',
  };
}

// 2. 本地搜索与过滤 Hook
export function useChatFilter(messages: SessionMessage[]) {
  const [filterQuery, setFilterQuery] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const filteredMessages = useMemo(() => {
    if (!filterQuery.trim()) return messages;
    return messages.filter((m) =>
      m.text.toLowerCase().includes(filterQuery.toLowerCase())
    );
  }, [messages, filterQuery]);

  return {
    filterQuery,
    setFilterQuery,
    filterOpen,
    setFilterOpen,
    filteredMessages,
  };
}

// 3. 权限与审批集成 Hook
export function useChatPermissions() {
  const permissionMode = usePermissionStore((s) => s.permissionMode);
  const setPermissionMode = usePermissionStore((s) => s.setPermissionMode);
  const planApproved = usePermissionStore((s) => s.planApproved);
  const setPlanApproved = usePermissionStore((s) => s.setPlanApproved);
  return { permissionMode, setPermissionMode, planApproved, setPlanApproved };
}

// 4. 对话卡片控制器装配 (仅做组合，各子模块返回值按需向下分发)
```

#### (2) `useChatComposerProps` 拆解方案

```typescript
// 1. 草稿持久化与输入状态 Hook
export function useComposerDraft(sessionId: string | null) {
  const draft = useComposerDraftStore((s) =>
    sessionId ? s.draftsBySessionId[sessionId] || '' : ''
  );
  const setDraftStore = useComposerDraftStore((s) => s.setDraft);
  const [input, setInput] = useState(draft);

  // 本地更新立即响应，异步防抖落盘
  const updateInput = useCallback(
    (text: string) => {
      setInput(text);
      if (sessionId) debounce(() => setDraftStore(sessionId, text), 300);
    },
    [sessionId, setDraftStore]
  );

  return { input, updateInput };
}

// 2. Slash 菜单与技能发现 Hook
export function useComposerSlashCommands(input: string) {
  // 仅负责斜杠菜单的开闭、索引与过滤
}

// 3. 消息队列调度器 Hook (分离 UI 表现与队列调度)
export function useComposerQueue(sessionId: string | null) {
  // 仅负责 queuedMessages 的入队、出队与 Drain 执行
}
```

---

### 5.4 四阶段平滑演进与迁移实施路径

为了确保重构过程不对现存功能和测试资产造成破坏，建议采用**渐进式四步演进策略**：

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                渐进式实施路线图                                  │
└─────────────────────────────────────────────────────────────────────────────────┘

 阶段一：Toast Context 落地 (低风险 · 高回报)
   ├─ 引入 ToastProvider 与 useToast()
   ├─ 批量剥离 39 个文件的 onShowToast Props 传递
   └─ 修复 MessageActions 中被策略静默丢弃的错误提示文案

 阶段二：输入框草稿隔离 (直接提升打字性能)
   ├─ 创建独立的 composerDraftStore
   ├─ 将 useChatComposerProps 的草稿防抖持久化迁移至新 Store
   └─ 切断输入打字对 layoutStore 的全局通知穿透

 阶段三：layoutStore 物理拆分为两大 Store (解除伪门面)
   ├─ 将 sessionStore 实例化为独立 Zustand Store，独立维护 sessions 索引与持久化
   ├─ layoutStore 瘦身为纯粹的 layoutChromeStore (仅保留 9 个 UI 控制 Action)
   └─ 移除废弃的 pre-tree workspaceActions 遗留代码

 阶段四：上帝 Hook 拆解与组件精细化 Memo (收敛渲染拓扑)
   ├─ 拆解 useChatCardState 为 4 个聚焦 Hook
   ├─ 拆解 useChatComposerProps，将队列状态机与 UI 呈现解耦
   └─ 消除 ChatCard 中 ribbons 对整包 [state] 的粗暴依赖
```

1. **阶段一（Phase 1: Toast Context 落地，耗时极短，风险为 0）**：
   - 在应用顶层包裹 `<ToastProvider>`，导出 `useToast()`。
   - 自底向上逐步清理 39 个文件中的 `onShowToast` prop-drilling，将叶子组件改为调用 `useToast()`。
   - 移除 `TreeLeafPanel.tsx:209` 和 `messageVirtualizerMemo.ts` 中针对 `onShowToast` 的多余 memo 比较。

2. **阶段二（Phase 2: composerDraftStore 独立）**：
   - 新建 `composerDraftStore.ts`，接管 `composerDrafts` 和 `attachments` 暂存。
   - 彻底切断输入框打字对会话账本与布局 Store 的高频 I/O 污染，从根源消除输入掉帧隐患。

3. **阶段三（Phase 3: sessionStore 与 layoutChromeStore 物理拆分）**：
   - 将 `sessionStore.ts` 改为独立的 `create<SessionStore>()` 物理实例，由其独占 `crish-sessions-v1` 持久化与 `withAutoIndex` 索引中间件。
   - 将 `layoutStore.ts` 重命名为 `layoutChromeStore.ts`，仅保留 9 个布局 Chrome 相关的 Action，消除别名门面。
   - 彻底废除 `useScopedSessionField` 这类病态的短路代码，恢复标准清晰的 `useSessionStore((s) => s.sessionsById[sid]?.messages)` 订阅模型。

4. **阶段四（Phase 4: 上帝 Hook 拆解与依赖精细化）**：
   - 将 `useChatCardState` 和 `useChatComposerProps` 拆解为原子 Hook。
   - 重构 `ChatCard.tsx` 中的 `ribbons` 依赖项，只依赖具体的数据字段（如 `state.diffFiles.length`, `state.engineHint`），彻底杜绝全局级联重绘。

---

## 结论

本报告通过对 `apps/crish-desktop` 状态层与组件交互层的全景代码审计，彻底查明了当前系统在 **Store 物理边界模糊**、**伪门面全量广播穿透**、**Toast 通知深度 Prop-Drilling 污染** 以及 **巨型上帝 Hook 过载** 方面的深层根因。

通过实施物理 Store 三元拆分（Session / LayoutChrome / ComposerDraft）、引入 React Toast Context 机制、以及微 Hook 分层装配，将从根本上理顺前端状态流拓扑，使组件层恢复纯净内聚，彻底消除非必要的全局重渲染与性能损耗，为 Conex / Crish 桌面端奠定坚实、优雅、可维护的现代化前端架构基石。
