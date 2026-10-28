# store 架构说明

## Layout identity ownership（OPT-C1 · write owners）

Three **real** store instances matter for “what is open / where is it painted / what is the session body”. Facades on layout are **aliases**, not extra create(). T11 起新增四个**域 store**（独立实例）。

| Instance | Path | Write owner for | Forbidden for new code |
|----------|------|-----------------|------------------------|
| **layoutStore** (god, T11 瘦身) | `layoutStore.ts` | sessions[], messages, agents, chrome (sidebar/tabMode/uiSize/shellChrome/chatSurface/settingsOverlay), legacy columns | Opening tabs by `setActiveSessionId` alone; mutating layout-tree |
| **terminalStore** | `terminalStore.ts` | terminal buffers（terminalLines / terminalBySession）+ diff buffers（diffFiles / activeDiffSource） | 会话 CRUD；权限写入 |
| **workerStore** | `workerStore.ts` | activeWorkers / killedWorkerIds / manuallyTriggeredWorkers（killWorker / triggerCronJobNow） | 权限写入；settings 数据 |
| **permissionStore** | `permissionStore.ts` | permissionMode / commandPermissions | 会话 CRUD |
| **settingsStore** | `settingsStore.ts` | appSettings / providers / scheduledTasks / mcpServers / tokenUsage（syncTelemetryData 单向委托 workerStore） | 布局 chrome |
| **workspaceShellStore** | `workspace-shell/*` | openTabs / TabSurface, activeTabId, rightDock, shellReady; open/focus/close/new-draft | Session message body; raw tree split as “open chat” |
| **layoutTreeStore** | `layout-tree/*` | binary tree geometry, activeLeafId, history, leaf↔session bind | Tab strip order; sessions[] CRUD |

| Alias (same zustand as layoutStore) | Path |
|-------------------------------------|------|
| `useSessionStore` | `sessionStore.ts` |
| `useWorkspaceStore` | `workspaceStore.ts` — **≠** workspace-shell |
| `useSettingsUiStore` | `settingsUiStore.ts`（浮层直读 layout；权限便捷入口委托 permissionStore） |

### Command entry (compositionRoot naming trap)

| Want | Use | Do **not** confuse with |
|------|-----|-------------------------|
| New draft / open tab | `compositionRoot.shell` / `session.openOrFocusSession` | `compositionRoot.layout` |
| Sessions list / sidebar / plan / appSettings | `compositionRoot.layout` / session facade | **layout-tree** (no facade yet) |
| Split / merge / drop panels | `useLayoutTreeStore` + layout-tree ops | `compositionRoot.layout` |
| Legacy card columns | `compositionRoot.workspace` | workspace-shell |

**One owner per gesture:** open/focus/new-draft → **shell only** (shell may call `setActiveSessionId` internally). Components must not call `setActiveSessionId` *and* shell activate for the same open.

Type tags: `storeOwnership.ts` (`StoreOwnership`, `SHELL_TAB_OWNERSHIP`, …).

**Current truth:** sessions **still live on layoutStore**（OPT-C1，本波不拆）。T11 已把 terminal / worker / permission / settings 四域拆为独立 store；session/workspace 拆分为后续波次。

---

## 现状（T11 后 · facade 收尾）

桌面 UI **会话/chrome/legacy workspace** 仍是 **单一** zustand + immer 实例：`useLayoutStore`（`layoutStore.ts`，布局域 ≤8 action）。**terminal / worker / permission / settings 为四个独立实例**（`terminalStore.ts` / `workerStore.ts` / `permissionStore.ts` / `settingsStore.ts`）。Tab 条与二叉树是 sibling stores（上表）。

| 层 | 文件 | 职责 |
|----|------|------|
| 权威 store | `layoutStore.ts` | 布局/壳层 UI + 会话域 + 工作区域（拼装切片 actions、持久化订阅） |
| 会话 actions | `sessionActions.ts` | 会话/消息/agent 写入（terminal 镜像经 terminalStore 委托） |
| 工作区 actions | `workspaceActions.ts` | columns、标签 DnD、布局预设 |
| 域 store（T11 新） | `terminalStore.ts` | 终端行缓冲 + diff 缓冲 |
| 域 store（T11 新） | `workerStore.ts` | 活动/manual/killed worker |
| 域 store（T11 新） | `permissionStore.ts` | 权限/plan/命令白名单 |
| 域 store（T11 新） | `settingsStore.ts` | 设置/遥测（scheduledTasks 持久化） |
| 公共读面（T11 新） | `storeAccess.ts` | **components 只经它读新域 store**（T14 规则引用） |
| 纯函数 | `layoutHelpers.ts` | 默认工作区、列宽、group 查找、diff/终端缓冲 |
| 索引 | `sessionIndex.ts` | `sessionsById` O(1) + 一致性校验 + 侧栏投影（空壳过滤） |
| 类型 | `types.ts` | 公共类型 |
| ownership tags | `storeOwnership.ts` | domain / write-owner aliases（文档用） |
| barrel | `index.ts` | 统一 re-export |
| 命令式 api | `api/storeAccess.ts` | 非 React 热路径集中 getState / action（既有编排层；T11 后其 getLayoutState 形状依赖归 T14/汇合修复） |
| TabSurface | `workspace-shell/*` | open tabs / dock（独立 store） |
| Geometry | `layout-tree/*` | binary tree（独立 store） |

**兼容约定**：`import { useLayoutStore } from '../store/layoutStore'` **不得破坏**。新代码优先 facade / barrel / `storeAccess` / compositionRoot。

### 域 facade（薄代理 → 未来 multi-store）

三门面 **同一对齐约定**：

1. `use*Store === useLayoutStore`（同引用，已单测）
2. 便捷 hooks 经本域 `use*Store` 订阅，不直连 `layoutStore` 符号
3. 命令式 `get*State()` / 域 helper；跨组件事件回调优先 `api/storeAccess`

| Facade | hook | 覆盖 | 命令式 |
|--------|------|------|--------|
| 会话 | `useSessionStore` / `useSessionField` / `useActiveSession*` | sessions、sessionsById、activeSession*、SessionActions | `getSessionStoreState` / `getSessionById` / `getSessionAgent` |
| 工作区 | `useWorkspaceStore` / `useWorkspaceField` / `useActiveWorkspace*` | workspaces、draggedTab、dropPreview、WorkspaceActions | `getWorkspaceStoreState` / `getActiveWorkspace` / `setGroupActiveCard` / `setDropPreview` / `focusExistingPanelCard` |
| 设置 UI | `useSettingsUiStore` / `useSettingsUiField` / `usePermissionMode`… | showSettingsOverlay、settings tab（layout 直读）；permission/plan 经 permissionStore 委托 | `getSettingsUiState` / `openSettings` / `closeSettings` / `toggleSettingsOverlay` / `setPermissionMode`（→permissionStore） |

- **非 React 热路径**请走 `api/storeAccess.ts`（或 facade 的 get*），组件渲染用 selector。
- `storeAccess` 已覆盖：会话 CRUD/消息 toolCall/archive·unarchive/pin/agent、`getActiveSessionId` / `getSessionAgent`、设置 UI 开关与 plan/`getPermissionMode`、工作区 `setGroupActiveCard` / `focusOrOpenPanel` / DnD `getDropPreview`、diff、遥测、`setAppSettings` / `getCommandPermissions` / `setScheduledTasks`。跨域写统一经 `getLayoutState()`。

### 状态归属（该放哪 — T11 后）

| 状态 | 归属 | 说明 |
|------|------|------|
| sessions / sessionsById / folderOrder / activeSession* / agents | 会话域（layoutStore 切片） | 高频；后续波次拆独立 store |
| workspaces / draggedTab / dropPreview / tabMode | 工作区域（layoutStore 切片） | DnD 与布局 |
| uiSize / shellChromeMode / chatMainSurface / sidebarCollapsed | 布局 chrome（layoutStore） | 壳层 UI |
| showSettingsOverlay / settingsActiveTab / openSettings | 布局 chrome（layoutStore） | 设置浮层 = 布局 UI |
| terminalLines / terminalBySession / activeDiffSource / diffFiles | **terminalStore** | 会话输出/工作缓冲 |
| activeWorkers / killedWorkerIds / manuallyTriggeredWorkers | **workerStore** | killWorker / triggerCronJobNow / applyTelemetryWorkers |
| permissionMode / commandPermissions | **permissionStore** | 权限三态联动 + 白名单 |
| appSettings / providers / scheduledTasks / mcpServers / tokenUsage | **settingsStore** | 设置/遥测；syncTelemetryData 单向委托 workerStore |

新代码读取新域 store：`storeAccess.ts`（`useTerminalField` / `getWorkerState` / `usePermissionField` / `useSettingsField` …）。

### 循环依赖

```
layoutStore → sessionActions / workspaceActions / layoutHelpers / sessionIndex
sessionStore / workspaceStore / settingsUiStore → layoutStore（仅 alias）
sessionActions ↛ layoutStore（只用 SessionStoreSlice 泛型）
workspaceActions ↛ layoutStore（只用 WorkspaceStoreSlice 泛型）
api/storeAccess → facades + layoutStore（编排层，允许）
api/* 可 → store；store 避免 → 组件
```

禁止：`sessionActions` import `layoutStore`（会环）。跨域写用 set 切片字段或 `storeAccess` 编排。

## `sessionsById` 索引

- `sessions: SessionState[]`：保序（侧栏、拖拽重排）。
- `sessionsById: Record<string, SessionState>`：热路径 **O(1)**；**与数组元素同一对象引用**（immer 要求）。
- 结构变更后：`reindexSessionsById` / `buildSessionsById` / create·branch 时点写索引。
- 查找：`getSessionById`（索引未命中则线性回退并回填）。
- 一致性：`checkSessionsIndex` / `isSessionsIndexConsistent` / `assertSessionsIndexConsistent`（测试与调试；热路径勿 assert）。

## 会话消息水合（lazy vs eager）

| 路径 | messages | 说明 |
|------|----------|------|
| 本地 disk / SQLite `hydrateSessionsFrom*` | **eager** 全量 body | `loadSessionBody` 与 index 一并回灌 |
| 引擎 `list-sessions` merge | **lazy** `messages: []` + title | 见 `api/sessionEngineSync` |
| `setActiveSessionId` | 空且 `!hydratedFromEngine` → 拉 `session-events` | `needsEngineMessageHydrate` |
| `prepareSessionsForUi` | **不** strip messages | 只补默认标题 + prune 幽灵空壳（I-DRAFT） |

因此调试/MCP 见 `sessions[].messages` 全 length 0 而 titles 存在：**对未 activate 的远程壳是预期**，不是 sessions 丢消息。
activate 后 `sessions[]` 与 `sessionsById` 同引用同时有正文；`hydratedFromEngine=true`。

**Immer 写路径注意**：只经 `sessionsById[id]` mutate 时，immer 可能把 map 值 fork 成新对象，
`sessions[]` 仍持旧引用 → 看起来像「列表丢消息」。activate 水合与结构性写入须用
`getSessionForWrite`（优先 `sessions[]` 再 rebind map），或依赖 `withAutoIndex` 在
sessions 数组引用变化时从数组重建 map。

```ts
// ✅
const s = getSessionById(id);
const active = useSessionField(selectActiveSession);

// ❌ 组件内整表订阅 + find
const s = useLayoutStore(s => s.sessions).find(x => x.id === id);
```

## getState 约定

| 场景 | 推荐 |
|------|------|
| 渲染订阅 | `useSessionField(selector)` / `useWorkspaceField` / `useSettingsUiField` |
| 事件回调需最新快照 | facade `getSessionById` / `get*StoreState` / `api/storeAccess` |
| 流式 bridge / 引擎同步 / 快捷键 | `api/storeAccess`；避免组件散落 getState |
| 禁止 | 新代码在组件 render 路径调用 `useLayoutStore.getState()` |

### 消费侧收紧进度（真实状态 · 2026-07）

**已迁到 facade / storeAccess（本轮）：**

| 位置 | 改动 |
|------|------|
| `App.tsx` | 快捷键 toggle settings / branch / archive / telemetry → storeAccess |
| `ChatCard.tsx` | approval toolCall / regenerate / branch / goal stop / openDiff → storeAccess |
| `CardPanel.tsx` | tab 切换 / 全局开面板 → `setGroupActiveCard` / `focusOrOpenPanel` |
| `SettingsScheduleTab.tsx` | 关设置浮层 → `closeSettings` |
| `ScheduledTasksPanel.tsx` | create/focus session → storeAccess（无 layout getState） |
| `RuntimePanel.tsx` | setActiveSessionId / setScheduledTasks → storeAccess |
| `OverviewCard.tsx` | sessions / permissionMode 用 domain field selectors |
| `TerminalCard.tsx` | 已用 `getSessionStoreState`（既有） |
| `hooks/useTabDrag.ts` | dropPreview / draggedTab → workspace facade get*/set* |
| `hooks/useAgentToolApproval.ts` | getSessionById / getSessionAgent / addCommandPermission |
| `hooks/useChatStream.ts` | updateMessageThinking / getActiveSessionId / setPermissionMode |
| `api/chat-bridge/ConnectionLifecycle.ts`、`handlers/approvalHandlers.ts` | getPermissionMode / getCommandPermissions（经 `api/storeAccess`） |
| `SettingsPanel.tsx` | setAppSettings → storeAccess |

**仍可接受 / 后续 Phase 再收：**

| 位置 | 原因 |
|------|------|
| `hooks/useChatStream.ts` | 部分已迁（thinking / permission / activeSessionId）；其余 setState 仍可续迁 |
| `components/Sidebar.tsx` | sidebarCollapsed 拖拽折叠；壳层 chrome，非三域 facade |
| `components/AgentCard.tsx` / `InlineAgentPanel.tsx` | 局部 immer setState 写 agent 消息 |
| `components/Settings*Tab.tsx` | 部分合并写；SettingsPanel 已用 storeAccess.setAppSettings |
| `api/chatApi.demo.ts` | demo 脚本，非生产路径 |

## 事件写入唯一通道（T-E 批次 5，03 方案步骤 3 落地）

```
事件 handler（api/chat-bridge/handlers/*）
  → env.callbacks（handlerEnv）
  → hooks（useStreamCallbacks / useAgentStream）或全局面（subagentHandlers Global*）
  → layoutStore action（跨域经 api/storeAccess 编排；命令热路径经 compositionRoot.layout.getState()）
  → 写 store（immer + getSessionForWrite/rebindSessionById 索引保障内建）
```

- **规则**：生产代码 `*Store.setState` 零残留（`npm run check:store-writes` 强制；
  白名单 = store/ 自身 action 定义 + `api/store-access/` + `bootstrapStores.ts` + 测试 + dev-only）。
- 事件面承载 action（T-E 步骤 3 新增，全部挂 layoutStore 实例）：`setEngineLastRunId` /
  `patchSessionAgentMessage` / `applySubagentEventToAgent` / `patchSessionAgentToolStatus` /
  `finalizeAgentMessages` / `updateMessageTimeline` / `applyToolCallPatches` /
  `setMessageCacheMetrics` / `markToolCallLocalStatus` / `batchRespondToApproval` /
  `rebindSessionFolders` / `setActiveWorkspaceIndex` / `collapseToolColumnPreserve` /
  `setGroupActiveCard` / `focusExistingPanelCard`（后两者经 workspace facade 转发）。
- 数据面子面（taskEventHandlers，轮询快照 = 真源）**不落 store 不迁移**（维持现状）。
- 组件直引 `store/` 由 `npm run check:store-facade` 度量（T-C 批次 7.4 迁移归零；
  白名单入口 = `store/index` barrel / `store/storeAccess` / `store/types`；
  门禁已接 CI 快层 lint job，违规数必须为 0）。

## D10 登记待清理（legacy open-tabs map 双写）

- 运行期双写路径**保留**（跨窗口/重启标签恢复依赖 legacy map）：shell store 与
  workspaceChromeHooks 的「打开/聚焦会话 → legacy map」同步已收敛到统一入口
  `api/workspaceChromeTabs.syncOpenTabsToLegacy`（`migrateFromOpenTabsMap` 覆盖后
  消费方消失时，按该入口单一 grep 删除双写，仅保留启动一次性迁移）。
- move/close 同步仍为 `moveSessionTab` / `closeSessionTab` 直接调用（legacy-only
  fallback 与 shell 路径均经 workspaceChromeTabs 单一模块）。

## 消息快照桥（P0-1 接线状态）

- **接线状态**：`messageSnapshotsBridge.ts` 的 `bindMessageSnapshotsOps` 由 `bootstrapStores.ts` 装配真实 `MessageSnapshots` 单例（模块图稳定后注入，防 init 环）。`withdrawMessage`（撤回）保存倒向 delta、`deleteSession`（删除会话）清空对应栈——破坏性操作前的数据保护已生效。
- **纯内存边界**：栈与容量全在 `MessageSnapshots` 的 `Map` 中，**无落盘，重启即失**；保护窗口仅限同会话（上限 5MB / 栈深 20 淘汰内建）。快照 ≠ 持久化备份。
- **restore 侧为已知缺口**：`undo` / `peek` / `peekDelta` / `getStack` 生产代码零调用——当前是「只记不读」，用户暂无撤销能力；恢复 UI 待产品决策，未接线。
- **防静默回归**：桥单测锁（`messageSnapshotsBridge.test.ts` 四断言）+ `AppBootstrap.test.ts` 装配效应断言，注入点丢失即红。

## 门禁

```bash
npm run check:store-types   # scripts/check-no-as-any-store.mjs
npm run check:store-writes  # scripts/check-no-raw-setstate.mjs（T-E 批次 5.4，已接 CI 快层）
npm run check:store-facade  # scripts/check-store-facade.mjs（基线模式；CI 接线等 02-A2 迁移归零）
npm run test:desktop-helpers  # 含 sessionIndex / storeFacades / storeAccess
npm run check:desktop         # crish-desktop tsc
```

`check-no-as-any-store` 扫描整个 `src/store/*.ts` + `api/storeAccess.ts` + barrel/README：

- 禁止 `as any`、`: any`、`as unknown as any`、`set as any` / `get as any`
- 禁止 `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` 与 `eslint-disable no-explicit-any`
- 非 facade 生产文件禁止 `as unknown as`；三门面各允许 1 处 get*StoreState 窄化
- 要求 `createSessionActions(set, get)` / `createWorkspaceActions(set, get)` 无 cast
- 要求 `SessionStoreSlice` / `WorkspaceStoreSlice` + `create*<T extends *Slice>`；actions **不得** import layoutStore/facade（反环）
- 要求 `syncTelemetryData(data: TelemetrySyncPayload)` 且 layout 导出该类型（T11 起签名检查落在 settingsStore）
- 要求 `sessionIndex` 导出 build/reindex/get/check/isConsistent/**assert**
- 要求三门面 `use*Store = useLayoutStore`、get*State / 域 helper 符号齐全；门面互不 import
- 要求 `index.ts` barrel re-export 三门面 + `useLayoutStore`；`store/README.md` 存在
- 要求 `storeAccess` 编排三域 facade（含 focusOrOpenPanel / create·archive·unarchive / getAppSettings / setScheduledTasks / getCommandPermissions 等）
- 扫描 `api/storeAccess.ts`：禁止 `as any` / `: any` / `as unknown as`；跨域写须 `getLayoutState()`；恰好 1 处 `useLayoutStore.getState()`；禁止 import `components/`

相关单测：

- `store/sessionIndex.test.ts` — 索引一致性
- `store/storeFacades.test.ts` — 三门面同实例 + get* / DnD / plan 对齐
- `api/storeAccess.test.ts` — 命令式 api 行为

## multi-store 路线

1. **Phase 0/1（当前）** — 单 store + 域 actions + 对齐 facade + storeAccess；消费侧持续收紧 selector/getState。
2. **Phase 2** — 会话消息流独立 zustand；只改 `sessionStore.ts` 实现，hook 名稳定。
3. **Phase 3** — 工作区 / 设置 UI 按需拆；跨域写经 `storeAccess` 编排，禁止 facade 互 import 成环。

### 约束

- **不要**为了拆分一次性改光全仓 `useLayoutStore` import。
- **不要**未同步 `sessionsById` 就改 `sessions` 结构。
- demo 模式不落盘；持久化见 `initLayoutStorePersistence`。
- workspace DnD 纯逻辑进 `layoutHelpers`（`findGroupInWorkspace` / `extractCardFromGroup` 等），actions 只编排。
- 新组件 **禁止** 在 render 中 `useLayoutStore.getState()`；事件回调走 `storeAccess`。

### 连接态真源（R2 收口）
- `errorStore.connectionStatus` 为连接态唯一真源（D2 合并：useEngineState 的 engineOnline 已删除，投影经 `hooks/useConnectionStatus.ts` 消费，RuntimePanel/三 Section 经 prop 下传）。
- sessionActions 已拆分：sessionFolderActions / sessionAgentActions 等（批次 5）。
