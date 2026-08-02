# Crish 统一事件系统与组件间通信架构

> 编制: 2026-07-20 | 范围: 全应用 503 个审计问题中涉及通信/事件/状态传播的全部断裂点

---

## 1. 当前问题分析

### 1.1 组件间通信断裂点清单

审计文档中**所有**涉及通信断裂的核心问题归类如下（按通信模式）：

#### 模式 A: emitUiEvent（~70 次调用，双向兼容层）
| 事件名 | 发射方 | 监听方 | 断裂原因 |
|--------|--------|--------|----------|
| `open-chat` | Sidebar, SettingsScheduleTab, SkillsSettingsTab | App.tsx（全局 keydown 处理器） | 间接链路过长（#106） |
| `open-scheduled` | ComposePlusMenu, RuntimePanel, ChatHeaderMore, Sidebar | App.tsx | 事件发射后须穿透多层才能到达目标 |
| `model-changed` | providerProfiles, ModelPicker | ChatCard | 订阅在 effect 中，组件重建时订阅可能丢失 |
| `profiles-changed` | providerProfiles | 无明确消费者（隐式） | 无订阅，事件实际无效果 |
| `focus-composer` | App.tsx（快捷键处理器） | ChatCard | 跨组件 DOM focus 通过 window event |
| `pick-workspace` | Sidebar, WorkspaceChromeBars | App.tsx | 链路过长，`openProjectPicker` 只需直接调用 |
| `toggle-msg-filter` | ChatHeaderMore | ChatCard | 父子组件通过 window event 通信（反模式） |
| `export-session-md` | ChatHeaderMore | ChatCard | 同上 |
| `stop-generation` | App.tsx（快捷键） | useChatStream | 快捷键 ⇒ window event ⇒ App ⇒ dispatch ⇒ hook |

#### 模式 B: window.dispatchEvent(new CustomEvent('crish-*'))（~25 处散发射击）
| 事件名 | 发射方 | 监听方 | 断裂原因 |
|--------|--------|--------|----------|
| `crish-project-changed` | projectStore (~3 处) | ~8 个组件 | 无类型约束，无订阅生命周期管理 |
| `crish-open-file` | workspaceFsApi | CardPanel, FilesCard | 无 payload 验证 |
| `crish-open-terminal` | backgroundTasksApi | CardPanel | daemon 事件 ⇒ window event ⇒ UI |
| `crish-theme-changed` | themeStore | SettingsAppearanceTab | 与 emitUiEvent 两套系统并存 |
| `crish-fonts-changed` | fontStore | 无人消费 | 死事件 |
| `crish-skills-changed` | skillsApi | ChatCard | 同上反模式 |
| `crish-sidebar-resize` | 无人 emit | WorkspaceChromeBars, SettingsQuickMenu 监听 | #305: 事件已定义但无人发射 |
| `crish-preview-url/bookmarks/history` | previewBrowserStore | PreviewCard | 合理的窗口事件（外部 store ⇒ UI） |
| `crish-focus-chat` | OverviewCard, RuntimePanel | 无人消费（死事件） | 历史遗留 |
| `crish-file-annotations-changed` | workspaceFsApi | FilesCard | 合理但无类型化 |
| `crish-update-changed` | updateStore | 无人消费 | 死事件 |

#### 模式 C: 轮询（4 秒固定间隔）
| 位置 | 轮询内容 | 问题 |
|------|----------|------|
| OverviewCard (#382) | `fetchEngineLiveStatus` + `listBackgroundTasks` | 面板不可见时仍在运行 |
| RuntimePanel (#382) | 同上代码重复 | 与 OverviewCard 各有一个独立实例 |
| AgentCard (#205) | daemon 状态轮询 | InlineAgentPanel 用推送，AgentCard 用轮询，两组件状态不一致 |
| themeStore (#352) | 60 秒时光过渡轮询 | tab 不可见时仍在运行 |
| SettingsAppearanceTab (#234) | 10 秒定时器 | tab 不可见时仍在运行 |
| ChatStatusRibbons (#102) | `listBackgroundTasks` | 多个 ChatCard 实例各启动独立轮询，永不停止 |

#### 模式 D: 直接 window event 监听（组件内 addEventListener）
- #9: keydown 处理器在 toast 变化时重建（依赖 `handleShowToast`）
- #492: App.tsx 全局 keydown 处理器混杂快捷键 + 事件转发
- #361-362: 多个组件各自独立 `window.addEventListener('keydown', ...)`，无统一仲裁
- #297: `SettingsUI` Tooltip 使用 `React.cloneElement`，非 prop 传递

#### 模式 E: 跨标签页/窗口通信缺失
- #447-454: 无 `storage` 事件、无 BroadcastChannel、无 SharedWorker
- WebSocket 冲突：两个标签页各自建立独立连接 (#451)
- localStorage 写入互相覆盖 (#450)
- 关闭标签页丢失 in-flight 批处理 (#453)

#### 模式 F: store 层面状态传播问题
- #341: 三个 store 仍是同一 zustand 实例别名，任何状态变更触发所有订阅者重选择
- #346: `setSessions` 全量替换，无增量/补丁更新
- #444-445: 多个独立 `set()` 调用可能被交织的 React effect 打断
- #479: `useLayoutStore.setState` 直接修改嵌套对象

#### 模式 G: 快捷键系统
- #1, #366: `matchShortcutActions` 跳过含空格无 `+` 的绑定（`Escape Escape` 永久失效）
- #9: 键盘处理器在 toast 变化时重建
- #366-369: 无 Command Palette、无 Diff 面板快捷键、macOS Ctrl 显示问题
- #283-286: 快捷键配置仅 localStorage，不走 settings schema

### 1.2 混合通信模式的系统性缺陷

```
┌────────────────────────────────────────────────────────┐
│                  当前通信模式 (N+1 混乱)                  │
│                                                        │
│  emitUiEvent('...') ──→ window.dispatchEvent ──→ listener│
│  dispatchEvent(new CustomEvent('crish-*')) ───────→ 同上 │
│  store.subscribe + selector ──→ useStore() ────→ 组件  │
│  setInterval(fn, 4000) ──→ API call ──→ setState  ─→ 组件 │
│  props ──→ callbacks ──→ parent state ──→ 子组件       │
│  BroadcastChannel / storage event ──→ (缺失)           │
└────────────────────────────────────────────────────────┘
```

**核心问题：**
1. **无事件注册中心**：`crish-*` 事件名随意注册，无命名空间/类型约束/文档
2. **两条 window event 系统共存**：`emitUiEvent`（类型化）与裸 `dispatchEvent(crish-*)`（无类型）并行，新增者不知选哪个
3. **订阅生命周期不管理**：组件卸载后事件监听可能残留（#104, #201）
4. **无事件溯源**：无法追踪事件从 emit → 何处消费 → 消费结果
5. **轮询泛滥**：至少 6 处独立轮询，无统一调度，不可见时仍运行
6. **跨标签页真空**：多窗口场景下完全不协调

---

## 2. 事件系统架构

### 2.1 设计原则

```
P1: 分层设计
    内部事件 (In-process EventBus) → 外部事件 (Daemon Event Router)
    → 状态变更事件 (Store Event) → 跨窗口事件 (BroadcastChannel)

P2: 优先级 (Communication Hierarchy)
    props → callbacks → store → events (EventBus)
    ↑ 优先使用      ↑ 组件间距离远/跨层级时使用

P3: 类型优先
    所有事件名 + payload 必须有 TypeScript 类型定义
    运行时 payload 校验（zod 或类似）

P4: 零泄漏
    订阅返回 unsubscribe 函数，组件 unmount 自动清理
    useEventBus hook 自动管理生命周期

P5: 推送优先，轮询兜底
    WebSocket 事件流 → EventBus → 组件
    仅无推送通道的场景才允许轮询，且轮询需统一调度

P6: 跨窗口透明
    单窗口内的事件（跨组件）和跨窗口的事件采用相同接口
    BroadcastChannel 作为后端透明切换
```

### 2.2 事件类型体系

```
Event (所有事件基接口)
├── InternalEvent        # 进程内事件，不序列化
│   ├── UiEvent          # UI 操作事件（emitUiEvent 迁移目标）
│   │   ├── NavigationEvent     # open-chat, open-scheduled, open-settings
│   │   ├── ActionEvent         # focus-composer, stop-generation, toggle-filter
│   │   └── NotificationEvent   # show-toast, show-error
│   │
│   ├── LifecycleEvent   # 组件/应用生命周期
│   │   ├── AppBootEvent        # app-ready, engine-ready, store-hydrated
│   │   ├── ComponentEvent      # panel-mounted, panel-unmounted
│   │   └── SessionEvent        # session-activated, session-deactivated
│   │
│   └── StoreEvent       # Store 状态变更（自动发布）
│       ├── SessionStoreEvent   # session-created, session-deleted, message-added
│       ├── WorkspaceStoreEvent # panel-opened, column-resized
│       └── SettingsStoreEvent  # setting-changed, theme-changed
│
├── ExternalEvent        # 外部系统事件（需序列化路由）
│   ├── DaemonEvent      # WebSocket 来的事件
│   │   ├── streamViaDaemon 事件 (tool-start, text-delta, approval-requested 等)
│   │   └── 系统事件 (background-task-*, engine-status-*)
│   │
│   ├── TauriEvent       # Tauri 桥事件
│   └── WorkerEvent      # Web Worker 事件
│
└── CrossTabEvent        # 跨标签页事件（BroadcastChannel）
    ├── StoreSyncEvent   # 存储同步 (session-body-saved, settings-changed)
    ├── FocusEvent       # 焦点协调 (request-focus, yield-focus)
    └── DaemonEvent      # 引擎连接协调 (primary-tab-claimed, engine-state)
```

### 2.3 事件发布/订阅模式

```
┌─────────────────────────────────────┐
│            EventBus                  │
│  ┌─────────────────────────────┐    │
│  │   Registry (事件注册中心)     │    │
│  │   - 所有事件名 + payload 定义│    │
│  │   - 运行时校验 (开发模式)    │    │
│  └──────────┬──────────────────┘    │
│             │                        │
│  ┌──────────▼──────────────────┐    │
│  │   Dispatcher (调度器)        │    │
│  │   - 同步/异步调度            │    │
│  │   - 异常隔离 (handler 抛错  │    │
│  │     不影响其他订阅者)        │    │
│  │   - 优先级队列              │    │
│  │   - 事件溯源 (调试模式)      │    │
│  └──────────┬──────────────────┘    │
│             │                        │
│  ┌──────────▼──────────────────┐    │
│  │  Subscriber Manager          │    │
│  │  - 订阅生命周期管理           │    │
│  │  - 弱引用/自动清理            │    │
│  │  - 订阅数量监控              │    │
│  └─────────────────────────────┘    │
│                                      │
│  跨窗口桥接:                         │
│  EventBus ⇄ BroadcastChannel        │
│  (同源事件自动跨窗口转发)            │
└─────────────────────────────────────┘
```

---

## 3. 详细设计

### 3.1 EventBus 接口定义

```typescript
// ============================================================
// 1. 事件类型定义体系
// ============================================================

// ---- 事件类型标签 ----
export type EventCategory =
  | 'ui'           // UI 操作
  | 'lifecycle'    // 生命周期
  | 'store'        // Store 状态变更
  | 'daemon'       // Daemon/引擎事件
  | 'tauri'        // Tauri 原生
  | 'worker'       // Worker
  | 'cross-tab'    // 跨标签页
  | 'system';      // 系统内部

// ---- 基础事件接口 ----
export interface BusEvent {
  readonly type: string;
  readonly category: EventCategory;
  readonly timestamp: number;
  readonly source?: string;  // 发射者标识（调试用）
}

export interface PayloadEvent<P> extends BusEvent {
  readonly payload: P;
}

// ---- 内部事件：零序列化开销 ----
export type InternalEvent = BusEvent | PayloadEvent<unknown>;

// ---- 外部事件：必须可序列化 ----
export interface ExternalEvent<P extends JsonObject = JsonObject>
  extends PayloadEvent<P> {
  readonly eventId: string;
  readonly origin: 'daemon' | 'tauri' | 'worker';
}

// ---- 跨标签页事件 ----
export interface CrossTabEvent<P extends JsonObject = JsonObject>
  extends PayloadEvent<P> {
  readonly tabId: string;
  readonly version: number;
}

// ============================================================
// 2. EventBus 核心接口
// ============================================================

export interface EventBus {
  // ---- 发射 ----
  emit<E extends InternalEvent>(event: E): void;
  emitExternal<E extends ExternalEvent>(event: E): void;
  emitCrossTab<E extends CrossTabEvent>(event: E): void;

  // ---- 订阅 ----
  on<E extends InternalEvent>(
    type: E['type'],
    handler: (event: E) => void,
    options?: SubscribeOptions,
  ): Unsubscribe;

  // ---- 一次性订阅 ----
  once<E extends InternalEvent>(
    type: E['type'],
    handler: (event: E) => void,
  ): Unsubscribe;

  // ---- 按 category 订阅 ----
  onCategory(
    category: EventCategory,
    handler: (event: InternalEvent) => void,
  ): Unsubscribe;

  // ---- 过滤订阅 (pattern matching) ----
  onMatch(
    pattern: string | RegExp,
    handler: (event: InternalEvent) => void,
  ): Unsubscribe;

  // ---- 取消所有订阅 ----
  clear(): void;

  // ---- 调试/监控 ----
  getSnapshot(): EventBusSnapshot;       // 当前订阅者列表 + 已发射事件计数
  getHistory(limit?: number): BusEvent[]; // 最近 N 个事件（仅调试模式）
}

export interface SubscribeOptions {
  /** 优先级：数值越大越先执行 */
  priority?: number;
  /** 自动清理条件（组件 ID 等） */
  scope?: string;
  /** 仅对 cross-tab 事件：是否接受来自其他 tab 的事件 */
  acceptForeign?: boolean;
}

export type Unsubscribe = () => void;

export interface EventBusSnapshot {
  subscriberCount: number;
  eventCounts: Record<string, number>;
  registeredTypes: string[];
}

// ============================================================
// 3. React Hooks
// ============================================================

export function useEventBus(): EventBus;
export function useEvent<E extends InternalEvent>(
  type: E['type'],
  handler: (event: E) => void,
  deps?: React.DependencyList,
): void;
export function useEventOnce<E extends InternalEvent>(
  type: E['type'],
  handler: (event: E) => void,
): void;
export function useEventHistory(type?: string): BusEvent[];
export function useEventEmit(): <E extends InternalEvent>(event: E) => void;
```

### 3.2 事件名称命名规范

消除当前 `crish-*` 随意嫁接的问题，采用 `category:scope:action` 三段式命名。

```typescript
// ============================================================
// 所有内部事件名（替代当前 emitUiEvent + crish-* 双体系）
// ============================================================

export const UI_EVENTS = {
  // ---- Navigation（原本 open-* 系列）----
  NAV_CHAT_OPEN:          'ui:nav:open-chat' as const,
  NAV_SCHEDULED_OPEN:     'ui:nav:open-scheduled' as const,
  NAV_OVERVIEW_OPEN:      'ui:nav:open-overview' as const,
  NAV_TASKS_OPEN:         'ui:nav:open-tasks' as const,
  NAV_SETTINGS_OPEN:      'ui:nav:open-settings' as const,
  NAV_AGENT_PANEL_OPEN:   'ui:nav:open-agent-panel' as const,
  NAV_PICK_WORKSPACE:     'ui:nav:pick-workspace' as const,
  NAV_PICK_PROJECT:       'ui:nav:open-project-picker' as const,

  // ---- Actions ----
  ACT_FOCUS_COMPOSER:     'ui:act:focus-composer' as const,
  ACT_STOP_GENERATION:    'ui:act:stop-generation' as const,
  ACT_TOGGLE_MSG_FILTER:  'ui:act:toggle-msg-filter' as const,
  ACT_EXPORT_SESSION_MD:  'ui:act:export-session-md' as const,
  ACT_COMPOSER_SEED:      'ui:act:composer-seed' as const,

  // ---- Notification ----
  NOTIF_SHOW_TOAST:       'ui:notif:show-toast' as const,
  NOTIF_SHOW_ERROR:       'ui:notif:show-error' as const,
  NOTIF_DISMISS_TOAST:    'ui:notif:dismiss-toast' as const,

  // ---- Sidebar ----
  SB_TOGGLE:              'ui:sidebar:toggle' as const,
  SB_RESIZE:              'ui:sidebar:resize' as const,
  SB_COLLAPSE_CHANGED:    'ui:sidebar:collapse-changed' as const,
} as const;

// ---- 对应的 payload 类型 ----
export interface UiEventPayloads {
  [UI_EVENTS.NAV_CHAT_OPEN]:         void;
  [UI_EVENTS.NAV_SCHEDULED_OPEN]:    void;
  [UI_EVENTS.NAV_OVERVIEW_OPEN]:     { sessionId?: string };
  [UI_EVENTS.NAV_SETTINGS_OPEN]:     { tabId?: string };
  [UI_EVENTS.NAV_AGENT_PANEL_OPEN]:  { agentId?: string };
  [UI_EVENTS.NAV_PICK_WORKSPACE]:    void;
  [UI_EVENTS.NAV_PICK_PROJECT]:      void;
  [UI_EVENTS.ACT_FOCUS_COMPOSER]:    void;
  [UI_EVENTS.ACT_STOP_GENERATION]:   void;
  [UI_EVENTS.ACT_TOGGLE_MSG_FILTER]: void;
  [UI_EVENTS.ACT_EXPORT_SESSION_MD]: void;
  [UI_EVENTS.ACT_COMPOSER_SEED]:     { text: string };
  [UI_EVENTS.NOTIF_SHOW_TOAST]:      ToastPayload;
  [UI_EVENTS.NOTIF_SHOW_ERROR]:      ErrorPayload;
  [UI_EVENTS.NOTIF_DISMISS_TOAST]:   { toastId: string };
  [UI_EVENTS.SB_TOGGLE]:             void;
  [UI_EVENTS.SB_RESIZE]:             { width: number };
  [UI_EVENTS.SB_COLLAPSE_CHANGED]:   { collapsed: boolean };
}

export const LIFECYCLE_EVENTS = {
  APP_READY:              'lc:app:ready' as const,
  ENGINE_READY:           'lc:app:engine-ready' as const,
  STORE_HYDRATED:         'lc:app:store-hydrated' as const,
  SESSION_ACTIVATED:      'lc:session:activated' as const,
  SESSION_DEACTIVATED:    'lc:session:deactivated' as const,
  PANEL_MOUNTED:          'lc:panel:mounted' as const,
  PANEL_UNMOUNTED:        'lc:panel:unmounted' as const,
} as const;

export const STORE_EVENTS = {
  SESSION_CREATED:        'store:session:created' as const,
  SESSION_DELETED:        'store:session:deleted' as const,
  SESSION_ACTIVE_CHANGED: 'store:session:active-changed' as const,
  MESSAGE_ADDED:          'store:message:added' as const,
  MESSAGE_STATUS_CHANGED: 'store:message:status-changed' as const,
  SESSIONS_REINDEXED:     'store:sessions:reindexed' as const,
  PROJECT_CHANGED:        'store:project:changed' as const,
  THEME_CHANGED:          'store:theme:changed' as const,
  SETTINGS_CHANGED:       'store:settings:changed' as const,
  TOOL_DIFFS_CHANGED:     'store:tool:diffs-changed' as const,
  COMPOSER_DRAFT_CHANGED: 'store:composer:draft-changed' as const,
} as const;
```

### 3.3 组件间通信推荐模式（按优先级）

```
优先级 1: props (父子直接通信)
  适用: 父子组件间简单数据传递
  示例: <Sidebar onSessionSelect={handleSelect} />

优先级 2: callbacks (父子 action → 回调)
  适用: 子组件触发父组件动作
  示例: <Composer onSend={handleSendChat} onStop={handleStop} />

优先级 3: store (跨层级状态共享)
  适用: 全局/会话状态，多组件消费
  示例: useSessionStore(s => s.activeSessionId)

优先级 4: EventBus (跨组件、无直接关系的操作触发)
  适用: A 触发操作，B 响应（A 不知 B 存在）
  示例: Sidebar → emit(NAV_CHAT_OPEN) → ChatCard 响应
```

#### 需要从 emitUiEvent 迁移到 store action 的场景

| 当前 emitUiEvent | 目标模式 | 理由 |
|-----------------|----------|------|
| `model-changed` | store action: `sessionActions.setActiveModel()` | 这是状态变更，非一次性操作。ChatCard 通过 store selector 响应 |
| `profiles-changed` | store action: `providerProfiles.refreshProfiles()` → store 状态变更 → 自动通知 selector | 无 event 订阅者，直接用 store 效果相同 |
| `update-changed` | store action + store event | 状态变更应走 store |
| `project-changed` | store action（已有 `projectStore.setState`）→ store event | 8 个组件监听 window event，应统一走 store |

#### 保留 EventBus 的场景

| 事件 | 理由 |
|------|------|
| `open-chat`, `open-scheduled`, `open-settings` | 这些是操作指令，非状态。操作方（快捷键/侧栏）不应被 store 感知 |
| `focus-composer`, `stop-generation` | 命令式 DOM 操作，不产生持久状态 |
| `toggle-msg-filter`, `export-session-md` | 局部 UI 操作，ChatHeaderMore ≠ ChatCard 的父子，通过 event 解耦合理 |
| `open-agent-panel` | 跨多组件触发的导航操作 |
| `open-project-picker`, `pick-workspace` | 模态/弹窗触发，非 store 状态 |

### 3.4 轮询 → 推送的迁移方案

| 当前轮询 | 推送替代 | 技术方案 |
|----------|----------|----------|
| OverviewCard/RuntimePanel `fetchEngineLiveStatus` (4s) | Daemon 推送 | daemon 已有 `status-update` 事件类型，但客户端未订阅。添加 client 层 `onStatusUpdate` listener，路由到 EventBus |
| ChatStatusRibbons `listBackgroundTasks` (4s) | Daemon 推送 | daemon 已有 `background-task-started/completed` 事件（#381），添加显式 handler 路由到 EventBus，再通知 ChatStatusRibbons |
| AgentCard daemon 状态轮询 (4s) | daemon 推送 | 复用 daemon 连接的状态推送，AgentCard 和 InlineAgentPanel 统一走 `useDaemonState()` hook |
| themeStore 60 秒光过渡轮询 (#352) | `requestAnimationFrame` + visibility | `timeTransitionSystem` 改为 rAF + 可见性感知：tab 隐藏时停止计时 |
| SettingsAppearanceTab 10 秒定时器 (#234) | 同 rAF 改造 | 移入 `useAnimationFrame` hook，tab 不可见时自动暂停 |
| 多个 ChatCard 独立轮询 (#102) | 单例轮询 | 将 `backgroundTaskPoller` 提升为应用级单例，组件通过 store/EventBus 消费结果 |

**统一轮询调度器设计：**

```typescript
// 当轮询无法避免时（如外部系统无推送能力），使用统一调度器
export interface PollTask {
  id: string;
  poll: () => Promise<void>;
  intervalMs: number;
  /** 不可见时是否继续（默认 false） */
  runWhenHidden?: boolean;
  /** 自动暂停条件 */
  pauseWhen?: () => boolean;
}

export class PollScheduler {
  register(task: PollTask): Unsubscribe;
  pause(taskId: string): void;
  resume(taskId: string): void;
  getActiveTasks(): PollTask[];
}
```

### 3.5 跨标签页通信方案

采用三层次策略，每个层次独立工作且互为后备：

```
层次 1: BroadcastChannel（首选，同源可靠）
  ┌──────────┐         ┌──────────┐
  │ Tab A    │ ←──────→ │ Tab B    │
  │ EventBus │  BC API  │ EventBus │
  └────┬─────┘         └────┬─────┘
       │                     │
       ▼                     ▼
  ┌─────────────────────────────┐
  │     BroadcastChannel        │
  │  "crish-cross-tab-v1"      │
  └─────────────────────────────┘

层次 2: storage event（后备，自动同步 localStorage）
  localStorage 写入 → 其他 tab storage 事件触发 → 状态更新

层次 3: Tab Coordinator（跨标签页引擎连接协调）
  - 首个标签页为主 tab，持有引擎 WebSocket
  - 其他标签页通过 BroadcastChannel 共享主 tab 的事件流
  - 主 tab 崩溃时自动选举新主
```

```typescript
// ============================================================
// CrossTabBridge - 跨标签页桥接器
// ============================================================

export interface CrossTabMessage {
  type: string;
  tabId: string;
  payload: unknown;
  timestamp: number;
}

export class CrossTabBridge {
  private bc: BroadcastChannel;
  private tabId: string;
  private storageListener: (e: StorageEvent) => void;

  constructor(private eventBus: EventBus) {
    this.tabId = crypto.randomUUID();
    this.bc = new BroadcastChannel('crish-cross-tab-v1');
    this.bc.onmessage = (ev) => this.handleCrossTabMessage(ev.data);
    // 后备：storage 事件监听
    this.storageListener = (e) => this.handleStorageEvent(e);
    window.addEventListener('storage', this.storageListener);
  }

  // 向所有标签页广播
  broadcast(type: string, payload: unknown): void {
    const msg: CrossTabMessage = {
      type,
      tabId: this.tabId,
      payload,
      timestamp: Date.now(),
    };
    this.bc.postMessage(msg);
  }

  // 仅在非发起方的标签页触发
  private handleCrossTabMessage(msg: CrossTabMessage): void {
    if (msg.tabId === this.tabId) return;  // 忽略自己的消息
    this.eventBus.emit({
      type: `cross-tab:${msg.type}`,
      category: 'cross-tab',
      payload: msg.payload,
      timestamp: msg.timestamp,
      source: msg.tabId,
    } as InternalEvent);
  }

  private handleStorageEvent(e: StorageEvent): void {
    if (!e.key || !e.newValue) return;
    // 仅处理跨标签页相关的存储键
    if (e.key.startsWith('crish_crosstab_')) {
      this.eventBus.emit({
        type: `cross-tab:storage:${e.key}`,
        category: 'cross-tab',
        payload: { key: e.key, value: e.newValue },
        timestamp: Date.now(),
      } as InternalEvent);
    }
  }

  destroy(): void {
    this.bc.close();
    window.removeEventListener('storage', this.storageListener);
  }
}
```

**需要跨标签页同步的数据：**

| 数据 | 当前问题 | 方案 |
|------|----------|------|
| 会话列表/消息 | #447: 多标签页完全不知彼此变更 | BroadcastChannel 推送 `store:session:*` + `storage` 后备 |
| 设置变更 | #450: localStorage 互相覆盖 | BC 广播 settings-changed + 乐观锁 |
| 引擎连接 | #451: 各自独立 WS ⇒ 冲突 | Tab Coordinator 单 WS 共享 |
| scheduledTasks | #194: localStorage 跨窗口不同步 | BC 广播 + storage 监听 |
| activeSessionId | 切换后另一 tab 无感知 | BC 广播 |
| 审批状态 | 多 tab 同时审批冲突 | BC 协调，主 tab 发审批指令 |

### 3.6 快捷键系统重构

将快捷键从 `App.tsx` 全局 `keydown` 处理器提取为独立模块：

```typescript
// ============================================================
// 独立的快捷键系统
// ============================================================

// --- 快捷键定义 ---
export interface ShortcutBinding {
  /** 规范化的组合键（如 'mod+k', 'escape escape'） */
  key: string;
  /** 绑定的命令 ID */
  commandId: string;
  /** 命令参数（可选） */
  args?: unknown;
  /** 当某个条件不满足时跳过 */
  when?: () => boolean;
  /** 描述（显示在 Command Palette 中） */
  title?: string;
}

// --- 命令注册 ---
export interface Command {
  id: string;
  title: string;
  category: 'navigation' | 'editor' | 'panel' | 'settings' | 'system';
  /** 默认快捷键 */
  defaultKeys?: string[];
  /** 执行函数 */
  execute: (args?: unknown) => void;
}

// --- ShortcutService ---
export class ShortcutService {
  private commands = new Map<string, Command>();
  private bindings = new Map<string, ShortcutBinding>();  // key → binding
  private commandToKeys = new Map<string, string[]>();    // commandId → [keys]
  private keySequence: string[] = [];  // 双击等组合键支持
  private sequenceTimeout: number | null = null;
  private userOverrides: Record<string, string>;  // localStorage 用户自定义

  constructor(private eventBus: EventBus) {}

  registerCommand(command: Command): void {
    this.commands.set(command.id, command);
    if (command.defaultKeys) {
      for (const key of command.defaultKeys) {
        this.bind(key, command.id);
      }
    }
  }

  private bind(key: string, commandId: string): void {
    const normalized = this.normalizeKey(key);
    this.bindings.set(normalized, { key: normalized, commandId });
    const existing = this.commandToKeys.get(commandId) || [];
    existing.push(normalized);
    this.commandToKeys.set(commandId, existing);
  }

  handleKeyEvent(e: KeyboardEvent): boolean {
    const key = this.keyFromEvent(e);
    if (!key) return false;

    // 支持组合键序列（如 Escape → Escape）
    this.keySequence.push(key);
    if (this.sequenceTimeout) clearTimeout(this.sequenceTimeout);
    this.sequenceTimeout = window.setTimeout(() => {
      this.keySequence = [];
    }, 500);

    const sequenceKey = this.keySequence.join(' ');
    const binding = this.bindings.get(sequenceKey);
    if (binding) {
      if (binding.when && !binding.when()) return false;
      e.preventDefault();
      this.keySequence = [];
      this.executeCommand(binding.commandId, binding.args);
      return true;
    }

    // 单键匹配（序列的最后一个）
    const singleBinding = this.bindings.get(key);
    if (singleBinding) {
      if (singleBinding.when && !singleBinding.when()) return false;
      e.preventDefault();
      this.executeCommand(singleBinding.commandId, singleBinding.args);
      return true;
    }

    return false;
  }

  private executeCommand(commandId: string, args?: unknown): void {
    const cmd = this.commands.get(commandId);
    if (!cmd) return;
    try {
      cmd.execute(args);
    } catch (e) {
      console.error(`[ShortcutService] command "${commandId}" failed:`, e);
    }
  }

  // macOS 上 mod 应显示为 ⌘
  getDisplayKey(key: string): string {
    if (navigator.platform?.startsWith('Mac')) {
      return key.replace('mod', '⌘').replace('ctrl', '⌃').replace('alt', '⌥').replace('shift', '⇧');
    }
    return key.replace('mod', 'Ctrl');
  }
}

// --- React Hook ---
export function useShortcut(
  keys: string | string[],
  handler: (e: KeyboardEvent) => void,
  options?: { when?: () => boolean; preventDefault?: boolean },
): void;

// --- 重构后的 App.tsx 快捷键初始化 ---
function initShortcuts(eventBus: EventBus): ShortcutService {
  const svc = new ShortcutService(eventBus);

  svc.registerCommand({
    id: 'chat.new',
    title: '新对话',
    category: 'navigation',
    defaultKeys: ['mod+k'],
    execute: () => eventBus.emit({ type: 'ui:nav:open-chat', category: 'ui', timestamp: Date.now() }),
  });

  svc.registerCommand({
    id: 'chat.focus',
    title: '聚焦输入框',
    category: 'editor',
    defaultKeys: ['escape'],
    execute: () => eventBus.emit({ type: 'ui:act:focus-composer', category: 'ui', timestamp: Date.now() }),
  });

  svc.registerCommand({
    id: 'chat.branch',
    title: '分叉会话',
    category: 'navigation',
    defaultKeys: ['escape escape'],
    execute: () => { /* branchSession logic */ },
  });

  svc.registerCommand({
    id: 'generation.stop',
    title: '停止生成',
    category: 'system',
    defaultKeys: ['escape'],
    when: () => isAiBusy(),
    execute: () => eventBus.emit({ type: 'ui:act:stop-generation', category: 'ui', timestamp: Date.now() }),
  });

  // 全局 keydown 只保留一个监听
  window.addEventListener('keydown', (e) => svc.handleKeyEvent(e));

  return svc;
}
```

### 3.7 Daemon 事件路由

将 daemon 的 WebSocket 事件流通过 EventBus 路由到各个组件：

```typescript
// ============================================================
// DaemonEventRouter — 外部事件 → EventBus
// ============================================================

export class DaemonEventRouter {
  private daemonClient: DesktopDaemonClient;

  constructor(
    private eventBus: EventBus,
  ) {
    this.daemonClient = getDesktopDaemonClient();
  }

  /** 启动路由：将 daemon 事件分类倾倒入 EventBus */
  start(): Unsubscribe {
    const unsubMsg = this.daemonClient.onMessage((msg) => {
      this.routeMessage(msg);
    });

    const unsubState = this.daemonClient.onState((state, err) => {
      this.eventBus.emit({
        type: 'daemon:connection:state-changed',
        category: 'daemon',
        payload: { state, error: err?.message },
        timestamp: Date.now(),
      } as InternalEvent);
    });

    return () => { unsubMsg(); unsubState(); };
  }

  private routeMessage(msg: Record<string, unknown>): void {
    const type = String(msg.type ?? '');

    // 系统级事件 → 广播到 EventBus
    if (type === 'status-update') {
      this.eventBus.emit({
        type: 'daemon:engine:status-update',
        category: 'daemon',
        payload: msg,
        timestamp: Date.now(),
      } as InternalEvent);
      return;
    }

    if (type === 'background-task-started' || type === 'background-task-completed') {
      this.eventBus.emit({
        type: `daemon:background:${type}`,
        category: 'daemon',
        payload: msg,
        timestamp: Date.now(),
      } as InternalEvent);
      return;
    }

    if (type === 'error') {
      this.eventBus.emit({
        type: 'daemon:system:error',
        category: 'daemon',
        payload: msg,
        timestamp: Date.now(),
      } as InternalEvent);
      return;
    }

    // streamViaDaemon 的运行期事件继续走旧路径（直接路由到 stream callbacks）
    // 因为这些事件需要跟具体 runId 绑定，不适合广播
    // 未来：考虑 streamViaDaemon 内部也使用 EventBus（scope 隔离）
  }
}
```

### 3.8 Toast 总线重构

```typescript
// ============================================================
// Toast 总线（替代当前 useToastQueue 的 props 传递）
// ============================================================

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title?: string;
  message: string;
  /** 毫秒，0 为不自动关闭 */
  duration?: number;
  /** 撤销/操作按钮 */
  action?: { label: string; onClick: () => void };
  /** 是否使用 aria-live="assertive"（错误用） */
  assertive?: boolean;
}

// 发射
export function showToast(toast: Omit<ToastMessage, 'id'>): void;
export function showError(error: string | Error, options?: Partial<ToastMessage>): void;
export function dismissToast(id: string): void;

// 组件消费
export function useToast(): {
  toasts: ToastMessage[];
  show: (t: Omit<ToastMessage, 'id'>) => string;
  dismiss: (id: string) => void;
  clear: () => void;
};

// ToastStack 直接从 EventBus 消费，不再通过 props
function ToastStack() {
  const { toasts, dismiss } = useToast();
  // toast:notif:show-toast 事件 → toasts 新增
  // toast:notif:dismiss-toast 事件 → toasts 移除
}
```

---

## 4. 迁移策略

### 4.1 阶段计划

```
Phase 1: 基础设施（~3 天）
├── 实现 EventBus 核心（EventBus class + useEventBus hook）
├── 实现事件命名规范（定义所有事件名常量）
├── 实现 CrossTabBridge
├── 实现 PollScheduler
├── 编写事件迁移指南文档
└── 编写兼容层：旧的 emitUiEvent → EventBus 适配器

Phase 2: 快捷键系统（~2 天）
├── 实现 ShortcutService
├── 提取所有命令定义
├── 修复 #1/#366 (Escape Escape 双击分叉)
├── 添加 Command Palette (#367)
└── macOS Ctrl→⌘ 显示 (#369)

Phase 3: emitUiEvent → EventBus（~3 天）
├── 迁移所有 emitUiEvent 调用到 eventBus.emit()
├── 迁移 toasts 到总线模式
├── 按表 3.3 将 3 个事件迁移到 store action
└── 移除 emitUiEvent 旧实现（保留兼容层一周期）

Phase 4: 轮询 → 推送（~4 天）
├── DaemonEventRouter 实现
├── OverviewCard/RuntimePanel 轮询迁移
├── ChatStatusRibbons 后台任务推送
├── AgentCard 统一推送
├── themeStore/SettingsAppearanceTab rAF 改造
└── 首屏轮询调度器实现

Phase 5: 跨标签页（~3 天）
├── CrossTabBridge 集成到 EventBus
├── 会话数据跨标签页同步
├── 设置变更跨标签页同步
├── Tab Coordinator 引擎连接管理
└── storage 事件后备

Phase 6: 清理与审计（~2 天）
├── 移除所有 window.addEventListener('crish-*') 裸监听
├── 验证所有组件生命周期中订阅正确清理
├── 事件溯源/调试面板
└── 性能测试（对比迁移前后的渲染次数）
```

### 4.2 兼容层设计

```typescript
// ============================================================
// 兼容层：旧 emitUiEvent → EventBus
// 仅 Phase 1 使用，Phase 6 移除
// ============================================================

// OldEventCompatLayer — 将旧事件桥接到新总线
export function installCompatLayer(eventBus: EventBus): Unsubscribe {
  const offs: Unsubscribe[] = [];

  // 旧 emitUiEvent 的监听器注册到新 bus
  for (const oldName of UI_EVENT_NAMES) {
    const newType = oldToNewEventName(oldName);
    if (!newType) continue;

    offs.push(
      eventBus.on({ type: newType } as any, (event: any) => {
        // 转发到旧的 window event（存量组件继续工作）
        emitUiEvent(oldName as any, event.payload);
      }),
    );
  }

  // 倒过来：旧的 window event → EventBus
  for (const oldName of UI_EVENT_NAMES) {
    const newType = oldToNewEventName(oldName);
    if (!newType) continue;

    const off = onUiEvent(oldName as any, (detail: any) => {
      eventBus.emit({
        type: newType,
        category: 'ui',
        payload: detail,
        timestamp: Date.now(),
      } as InternalEvent);
    });
    offs.push(off);
  }

  return () => offs.forEach(fn => fn());
}

function oldToNewEventName(old: string): string | null {
  const map: Record<string, string> = {
    'open-chat': 'ui:nav:open-chat',
    'open-scheduled': 'ui:nav:open-scheduled',
    'open-overview': 'ui:nav:open-overview',
    'open-tasks': 'ui:nav:open-tasks',
    'open-agent-panel': 'ui:nav:open-agent-panel',
    'pick-workspace': 'ui:nav:pick-workspace',
    'open-project-picker': 'ui:nav:pick-project',
    'focus-composer': 'ui:act:focus-composer',
    'stop-generation': 'ui:act:stop-generation',
    'toggle-msg-filter': 'ui:act:toggle-msg-filter',
    'export-session-md': 'ui:act:export-session-md',
    'model-changed': 'store:settings:model-changed',
    'profiles-changed': 'store:settings:profiles-changed',
    'update-changed': 'store:update:changed',
  };
  return map[old] ?? null;
}
```

### 4.3 迁移检查清单

每个组件迁移时的检查项：

```
□ 组件中的 window.addEventListener('crish-*', ...) → useEvent()
□ window.dispatchEvent(new CustomEvent('crish-*')) → eventBus.emit()
□ emitUiEvent(...) → eventBus.emit({ type: 'ui:...', category: 'ui', timestamp })
□ onUiEvent(...) → useEvent()
□ 轮询 setInterval → PollScheduler.register() 或推送替代
□ keydown listener → ShortcutService.registerCommand()
□ Toast props → useToast() hook
□ 校验: 组件 unmount 时所有订阅被清理
□ 校验: 不在 effect 依赖中使用事件处理函数（修复 #2, #9）
```

---

## 5. 与其他系统的交互

### 5.1 EventBus ⟷ Store 架构

```typescript
// ============================================================
// Store → EventBus 桥接器
// 当 store 状态变更时，自动发布到 EventBus
// ============================================================

// 方案：在 store subscribe 中桥接
export function bridgeStoreToEventBus(
  eventBus: EventBus,
): Unsubscribe {
  const offs: Unsubscribe[] = [];

  // 监听 session store 变更
  offs.push(
    useSessionStore.subscribe(
      (state, prev) => {
        if (state.activeSessionId !== prev.activeSessionId) {
          eventBus.emit({
            type: STORE_EVENTS.SESSION_ACTIVE_CHANGED,
            category: 'store',
            payload: { sessionId: state.activeSessionId },
            timestamp: Date.now(),
          });
        }
        if (state.sessions.length !== prev.sessions.length) {
          // sessions 引用已变，由具体 action 决定事件类型
        }
      },
    ),
  );

  // 监听 workspace store 变更
  offs.push(
    useWorkspaceStore.subscribe(
      (state, prev) => {
        if (state.sidebarCollapsed !== prev.sidebarCollapsed) {
          eventBus.emit({
            type: UI_EVENTS.SB_COLLAPSE_CHANGED,
            category: 'ui',
            payload: { collapsed: state.sidebarCollapsed },
            timestamp: Date.now(),
          });
        }
      },
    ),
  );

  return () => offs.forEach(fn => fn());
}
```

**反方向：EventBus → Store action**

```typescript
// 某些 UI 事件触发 store action
eventBus.on('ui:nav:open-chat', () => {
  useSessionStore.getState().actions.createSession();
});

eventBus.on('ui:sidebar:toggle', () => {
  useWorkspaceStore.getState().actions.toggleSidebar();
});
```

### 5.2 EventBus ⟷ Daemon 通信

```
Daemon WebSocket ──→ DaemonEventRouter ──→ EventBus ──→ 组件
                          │
                          ├── status-update  →  'daemon:engine:status-update'
                          ├── background-task →  'daemon:background:*'
                          ├── system error    →  'daemon:system:error'
                          └── run-time events →  streamViaDaemon (旧路径，不改)
                                                     │
                                                     ↓
                                              StreamCallbacks
                                              (保持现有实现)

组件 ──→ EventBus ──→ DaemonCommandRouter ──→ Daemon WebSocket
                           │
                           ├── 'daemon:cmd:approve-tool'  →  client.approveTool()
                           ├── 'daemon:cmd:cancel-run'    →  client.cancelRun()
                           └── 'daemon:cmd:sync-sessions' →  client.syncSessions()
```

```typescript
// ============================================================
// DaemonCommandRouter — EventBus → daemon 写操作
// ============================================================

export function installDaemonCommandRouter(eventBus: EventBus): Unsubscribe {
  const client = getDesktopDaemonClient();

  const offApprove = eventBus.on({
    type: 'daemon:cmd:approve-tool',
    category: 'system',
  } as any, async (event: any) => {
    await client.send({ type: 'approve-tool', toolCallId: event.payload.toolCallId });
  });

  const offCancel = eventBus.on({
    type: 'daemon:cmd:cancel-run',
    category: 'system',
  } as any, async (event: any) => {
    await client.send({ type: 'cancel-run', runId: event.payload.runId });
  });

  return () => { offApprove(); offCancel(); };
}
```

### 5.3 EventBus ⟷ 快捷键系统

```
键盘事件 ──→ ShortcutService ──→ EventBus ──→ 组件
                 │
                 ├── Escape        →  focus-composer / stop-generation（上下文相关）
                 ├── Escape Escape →  branch session
                 ├── Ctrl+K       →  new chat
                 └── Ctrl+Shift+P →  command palette

快捷键系统的「when」条件从 store 读取（isAiBusy, sidebarCollapsed 等）
```

---

## 附录 A: 受影响的文件清单与迁移工作量

| 文件 | 迁移内容 | 工作量 |
|------|----------|--------|
| `api/uiEvents.ts` | 废弃，保留兼容层 | 小 |
| `api/daemonClient.ts` | 添加 `onStatusUpdate` + `onBackgroundTask` 监听 | 中 |
| `api/daemonChatBridge.ts` | 添加 DaemonEventRouter 集成 | 中 |
| `api/backgroundTasksApi.ts` | 停止使用 `crish-terminal-append`/`crish-open-terminal` window event | 小 |
| `api/projectStore.ts` | `crish-project-changed` → STORE_EVENTS.PROJECT_CHANGED | 小 |
| `api/themeStore.ts` | 60s 轮询 → rAF + visibility | 中 |
| `api/fontStore.ts` | `crish-fonts-changed` → store event | 小 |
| `api/skillsApi.ts` | `crish-skills-changed` → store event | 小 |
| `api/updateStore.ts` | `crish-update-changed` → store event | 小 |
| `api/previewBrowserStore.ts` | `crish-preview-*` → EventBus（这些是合理的 window event，可保留） | 小 |
| `api/workspaceFsApi.ts` | `crish-open-file`/`crish-file-annotations` → EventBus | 小 |
| `api/shortcutBindings.ts` | 废弃，由 ShortcutService 替代 | 中 |
| `components/App.tsx` | 移除全局 keydown 处理器；移除 emitUiEvent 封装；精简 | 大 |
| `components/Sidebar.tsx` | emitUiEvent → eventBus.emit() | 中 |
| `components/SidebarSessionList.tsx` | emitUiEvent → eventBus.emit() | 小 |
| `components/ChatCard.tsx` | `crish-skills-changed`/COMPOSER_SEED_EVENT → EventBus | 中 |
| `components/ChatHeaderMore.tsx` | emitUiEvent → eventBus.emit() | 小 |
| `components/ChatStatusRibbons.tsx` | 轮询 → 推送 | 中 |
| `components/OverviewCard.tsx` | 轮询 → 推送；emitUiEvent → eventBus | 大 |
| `components/RuntimePanel.tsx` | 轮询 → 推送；emitUiEvent → eventBus | 大 |
| `components/AgentCard.tsx` | 轮询 → 推送统一 | 中 |
| `components/CardPanel.tsx` | `crish-open-file`/`crish-open-terminal` → EventBus | 小 |
| `components/FilesCard.tsx` | `crish-*` listeners → useEvent() | 小 |
| `components/PreviewCard.tsx` | `crish-preview-*` → useEvent()（兼容） | 小 |
| `components/WorkspaceChromeBars.tsx` | #305: 监听 `crish-sidebar-resize` → EventBus；emitUiEvent → bus | 中 |
| `components/SettingsQuickMenu.tsx` | `crish-sidebar-resize` → EventBus | 小 |
| `components/SettingsScheduleTab.tsx` | emitUiEvent → eventBus.emit() | 小 |
| `components/SkillsSettingsTab.tsx` | emitUiEvent → eventBus.emit() | 小 |
| `components/ComposePlusMenu.tsx` | emitUiEvent → eventBus.emit() | 小 |
| `components/FirstRunWizard.tsx` | keydown → ShortcutService | 小 |
| `components/SettingsAppearanceTab.tsx` | `crish-theme-changed` → EventBus；10s 定时器 → rAF | 中 |
| `components/SettingsRulesTab.tsx` | `crish-project-changed` → EventBus | 小 |
| `components/SettingsShortcutsTab.tsx` | ShortcutService 集成 | 中 |
| `api/engineStatus.ts` | 状态变更 → EventBus | 小 |
| `store/sessionActions.ts` | setSessions 增量更新 | 大 |
| `store/layoutStore.ts` | composerDrafts 持久化 + cleanup | 中 |
| `components/ToastStack.tsx` | useToast() from EventBus | 中 |
| 新建 `api/eventBus.ts` | EventBus 核心实现 | 中 |
| 新建 `hooks/useEventBus.ts` | React hooks | 小 |
| 新建 `api/crossTabBridge.ts` | 跨标签页通信 | 中 |
| 新建 `api/pollScheduler.ts` | 统一轮询调度 | 中 |
| 新建 `api/shortcutService.ts` | 提取快捷键系统 | 大 |
| 新建 `api/daemonEventRouter.ts` | daemon 事件路由 | 中 |
| 新建 `api/toastBus.ts` | Toast 总线 | 小 |

## 附录 B: 关键指标（迁移后）

| 指标 | 当前 | 目标 |
|------|------|------|
| 独立 window event 监听 | ~40 处 | ≤5 处（遗留兼容） |
| 轮询实例 | ~6 个 | ≤2 个（无推送的第三方系统） |
| 独立 keydown 监听 | ~12 处 | 1 处（ShortcutService） |
| window event 事件名 | 无约束（crish-* 任意） | 类型约束 3 段式命名 |
| 订阅泄漏风险 | 高（多处未清理） | 零（hook 自动清理） |
| 跨标签页能力 | 无 | BroadcastChannel + storage |
| 事件可追溯性 | 无 | 调试模式全链路溯源 |
