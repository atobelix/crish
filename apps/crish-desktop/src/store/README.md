# store 架构说明

## 现状（Phase 0/1 · facade 收尾）

桌面 UI 状态仍是 **单一** zustand + immer 实例：`useLayoutStore`（`layoutStore.ts`）。

| 层 | 文件 | 职责 |
|----|------|------|
| 权威 store | `layoutStore.ts` | 创建 store、拼装各域 actions、持久化订阅 |
| 会话 actions | `sessionActions.ts` | 会话/消息/agent/permissionMode 写入 |
| 工作区 actions | `workspaceActions.ts` | columns、标签 DnD、布局预设 |
| 纯函数 | `layoutHelpers.ts` | 默认工作区、列宽、group 查找、diff/终端缓冲 |
| 索引 | `sessionIndex.ts` | `sessionsById` O(1) + 一致性校验 + 侧栏投影（空壳过滤） |
| 类型 | `types.ts` | 公共类型 |
| barrel | `index.ts` | 统一 re-export |
| 命令式 api | `api/storeAccess.ts` | 非 React 热路径集中 getState / action |

**兼容约定**：`import { useLayoutStore } from '../store/layoutStore'` **不得破坏**。新代码优先 facade / barrel / `storeAccess`。

### 域 facade（薄代理 → 未来 multi-store）

三门面 **同一对齐约定**：

1. `use*Store === useLayoutStore`（同引用，已单测）
2. 便捷 hooks 经本域 `use*Store` 订阅，不直连 `layoutStore` 符号
3. 命令式 `get*State()` / 域 helper；跨组件事件回调优先 `api/storeAccess`

| Facade | hook | 覆盖 | 命令式 |
|--------|------|------|--------|
| 会话 | `useSessionStore` / `useSessionField` / `useActiveSession*` | sessions、sessionsById、activeSession*、SessionActions | `getSessionStoreState` / `getSessionById` / `getSessionAgent` |
| 工作区 | `useWorkspaceStore` / `useWorkspaceField` / `useActiveWorkspace*` | workspaces、draggedTab、dropPreview、WorkspaceActions | `getWorkspaceStoreState` / `getActiveWorkspace` / `setGroupActiveCard` / `setDropPreview` / `focusExistingPanelCard` |
| 设置 UI | `useSettingsUiStore` / `useSettingsUiField` / `usePermissionMode`… | showSettingsOverlay、settings tab、permission/plan | `getSettingsUiState` / `openSettings` / `closeSettings` / `toggleSettingsOverlay` / `setPermissionMode` / `setPlanMode*` |

- **非 React 热路径**请走 `api/storeAccess.ts`（或 facade 的 get*），组件渲染用 selector。
- `storeAccess` 已覆盖：会话 CRUD/消息 toolCall/archive·unarchive/pin/agent、`getActiveSessionId` / `getSessionAgent`、设置 UI 开关与 plan/`getPermissionMode`、工作区 `setGroupActiveCard` / `focusOrOpenPanel` / DnD `getDropPreview`、diff、遥测、`setAppSettings` / `getCommandPermissions` / `setScheduledTasks`。跨域写统一经 `getLayoutState()`。

### 状态归属（该放哪）

| 状态 | 归属 | 说明 |
|------|------|------|
| sessions / sessionsById / folderOrder / activeSession* / agents | 会话域 | 高频；Phase 2 优先拆独立 store |
| workspaces / draggedTab / dropPreview / tabMode | 工作区域 | DnD 与布局 |
| showSettingsOverlay / settingsActiveTab / permissionMode / plan* | 设置 UI 域 | 浮层与权限开关 |
| activeDiffSource / diffFiles | 仍在 layout（横切） | 工具结果与 Git 共用；经 `storeAccess.pushDiffFile` |
| terminalLines / terminalBySession | 仍在 layout | 与会话 id 关联，但非消息时间线 |
| appSettings / providers / mcp / cron / tokenUsage / workers | 遥测 & 设置数据 | 非布局；syncTelemetryData 已类型化为 `TelemetrySyncPayload` |
| uiSize / sidebarCollapsed | 壳层 UI | 可随 settings UI 或独立 chrome store |

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
| 流式 bridge / daemon / 快捷键 | `api/storeAccess`；避免组件散落 getState |
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
| `api/daemonChatBridge.ts` | getPermissionMode / getCommandPermissions |
| `SettingsPanel.tsx` | setAppSettings → storeAccess |

**仍可接受 / 后续 Phase 再收：**

| 位置 | 原因 |
|------|------|
| `hooks/useChatStream.ts` | 部分已迁（thinking / permission / activeSessionId）；其余 setState 仍可续迁 |
| `components/Sidebar.tsx` | sidebarCollapsed 拖拽折叠；壳层 chrome，非三域 facade |
| `components/AgentCard.tsx` / `InlineAgentPanel.tsx` | 局部 immer setState 写 agent 消息 |
| `components/Settings*Tab.tsx` | 部分合并写；SettingsPanel 已用 storeAccess.setAppSettings |
| `api/chatApi.demo.ts` | demo 脚本，非生产路径 |

## 门禁

```bash
npm run check:store-types   # scripts/check-no-as-any-store.mjs
npm run test:desktop-helpers  # 含 sessionIndex / storeFacades / storeAccess
npm run check:desktop         # crish-desktop tsc
```

`check-no-as-any-store` 扫描整个 `src/store/*.ts` + `api/storeAccess.ts` + barrel/README：

- 禁止 `as any`、`: any`、`as unknown as any`、`set as any` / `get as any`
- 禁止 `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` 与 `eslint-disable no-explicit-any`
- 非 facade 生产文件禁止 `as unknown as`；三门面各允许 1 处 get*StoreState 窄化
- 要求 `createSessionActions(set, get)` / `createWorkspaceActions(set, get)` 无 cast
- 要求 `SessionStoreSlice` / `WorkspaceStoreSlice` + `create*<T extends *Slice>`；actions **不得** import layoutStore/facade（反环）
- 要求 `syncTelemetryData(data: TelemetrySyncPayload)` 且 layout 导出该类型
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
