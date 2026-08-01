# AA-03 前端状态管理与 hooks 审查报告

审查日期：2026-08-01
审查范围（只读静态审查，未改动任何代码）：
- `apps/crish-desktop/src/store/`（全部 zustand store 与辅助模块）
- `apps/crish-desktop/src/hooks/`（全部 hooks）
- `apps/crish-desktop/src/app/`（AppBootstrap / useEngineBootstrap / compositionRoot / hydrateWorkspaceShell）
- `apps/crish-desktop/src/services/`
- 关联消费方：`src/App.tsx`、`src/main.tsx`、`src/bootstrap-*.ts`、`src/api/storeAccess.ts`、`src/api/store-access/*`

审查方式：静态精读 + 引用计数（grep import 面）验证死代码与重复实现。

## 一、总览

### zustand 实例盘点（任务书称「13 个」，实测 12 个可见实例 + 1 个纯死代码实例）

| 类别 | 实例 | 文件 | 状态 |
|---|---|---|---|
| 真实 create() | layoutStore（god） | store/layoutStore.ts | 活跃 |
| 真实 create() | layoutTreeStore | store/layout-tree/layoutTreeStore.ts | 活跃 |
| 真实 create() | workspaceShellStore | store/workspace-shell/workspaceShellStore.ts | 活跃 |
| 真实 create() | streamingStore | store/streamingStore.ts | 活跃 |
| 真实 create() | layoutAnimationStore | store/layoutAnimationStore.ts | 活跃 |
| 真实 create() | rustCoreStore | store/rustCoreStore.ts | 活跃 |
| 真实 create() | capabilitiesStore | store/capabilitiesStore.ts | 活跃 |
| 真实 create() | providerStore | store/provider/providerStore.ts | 活跃 |
| 真实 create() | **telemetryStore** | store/telemetryStore.ts | **死代码**（全仓 0 import） |
| facade（alias = layoutStore） | sessionStore | store/sessionStore.ts | 活跃 |
| facade（alias = layoutStore） | workspaceStore | store/workspaceStore.ts | 活跃 |
| facade（alias = layoutStore） | settingsUiStore | store/settingsUiStore.ts | 活跃 |
| 仿 store 死文件 | slices/*（ui/terminal/permission/diff 4 个） | store/slices/*.ts | **死代码**（0 import） |

合计 9 个真实实例 + 3 个 alias facade + 1 个（telemetryStore）即可凑成任务书口径的「13 个」；另有 `store/slices/` 4 个死文件、`storeTelemetryActions.ts`、`store/storeTransaction.ts` 两份死实现（详见问题清单）。

### 问题统计

| 严重度 | 数量 | 编号 |
|---|---|---|
| 阻塞 | 0 | — |
| 重要 | 9 | Q01–Q09 |
| 建议 | 16 | Q10–Q25 |
| 合计 | 25 | — |

无阻塞级问题：架构方向（god-store + facade + storeAccess 编排 + ownership 文档）是自洽的，主要风险集中在**死代码堆积、启动链路重复初始化与并发写竞态、以及遥测/拖拽/回灌三块的多实现并存**。

## 二、store 职责矩阵

| Store | state 摘要 | action 摘要 | 依赖 | 问题 |
|---|---|---|---|---|
| **layoutStore**（god，单 immer 实例） | workspaces/activeWorkspaceIndex/tabMode/uiSize/shellChrome/chatMainSurface/sidebarCollapsed；sessions[]/sessionsById/folderOrder/activeSessionId/draftFolder/activeAgentId/panelAgentId/composerDrafts；draggedTab/dropPreview；showSettingsOverlay/settingsActiveTab/permissionMode；activeDiffSource/diffFiles；planModeEnabled/planApproved/commandPermissions；appSettings/providers/scheduledTasks/mcpServers/activeWorkers/tokenUsage/killedWorkerIds/manuallyTriggeredWorkers；terminalLines/terminalBySession；hydrationComplete | createSessionActions（约 40 个会话/消息/agent action，拆分于 session*Actions.ts）+ createWorkspaceActions + createLayoutCoreActions（diff/permission/遥测/终端/UI） | api/clientApi（类型）、commandPermissions、permissionModes、layout-helpers/*、sessionIndex、autoIndexMiddleware、persist/logger/devtools | 职责过载（会话+工作区+设置+遥测+diff+终端+shell chrome 七域合一），README 自认 Phase 2 拆消息流；`window.useLayoutStore`+永久 subscribe（L327-333） |
| **sessionStore**（alias=layoutStore） | 同 layoutStore 会话切片 | 同 SessionActions | layoutStore、sessionIndex、sessionProgressApi、SessionRuntimeRegistry | 无独立状态；`useSidebarSessions` 手写 useReducer+subscribe（L111-143）与 useSyncExternalStore 范式重复；模块级注册 `registerActiveIdResolver`（L283）无注销 |
| **workspaceStore**（alias=layoutStore） | workspaces/draggedTab/dropPreview/diffFiles/activeDiffSource | 工作区 DnD/分组/面板 focus | layoutStore、storeAccess | 正常（alias 契约） |
| **settingsUiStore**（alias=layoutStore） | 设置浮层/permission/plan/UI 尺寸/appSettings/遥测字段（类型声明 14 项） | 设置 UI 开关/权限/plan | layoutStore、commandPermissions、permissionModes、shellChrome | 类型面与 layoutStore 遥测字段重叠（同实例无数据重复，但类型声明复制 4 处遥测字段） |
| **workspaceShellStore** | openTabs/activeTabId/shellReady/per-tab rightDock | openOrFocusSession/activateTab/closeTab/closeTabBySessionId/reorderSessionTab/updateRightDock/openNewDraftTab/resetToCleanDraft/migrateFromOpenTabsMap/setShellReady | layoutTreeStore（**直接 import，非 compositionRoot.tree**）、api/storeAccess（enterDraftMode/setActiveSessionId）、workspaceChromeTabs、ptyRegistry（动态 import） | **跨 store 直取**：L85/99/121/150-157/514 直连 useLayoutTreeStore.getState，与 layoutRestorePolicy「经 compositionRoot.tree」契约不一致；**模块级永久订阅** L610-624（never unsub） |
| **layoutTreeStore** | tree/activeLeafId/draggedSource/activeDropZone/past/future/toolColumnCollapsed | setTree/resetTree/splitLeaf/mergeBranch/moveLeaf/resizeBranch/commitDrop/undo/redo 等 20 个 | operations.ts 纯函数、persist（window-scoped key）、layoutRestorePolicy | 结构清晰；onRehydrateStorage 与 hydrateWorkspaceShell 的 restore 策略**双份实现**（layoutTreeStore.ts:497-515 vs app/hydrateWorkspaceShell.ts:65-153），判定逻辑不同步 |
| **streamingStore** | byKey（sessionId::messageId → text/thinking/tools/images） | setStream*/clearStream*/getStream* + 命令式 helper 导出 | 无（纯 zustand 无 immer） | 设计良好；updateStreamImage 有并发防护（L233-242） |
| **layoutAnimationStore** | activeAnimations(Set)/isLayoutFrozen/phase/catchupQueue | startAnimation/endAnimation/registerCatchupTask/flushCatchupTasks + begin/endLayoutInteraction helper | ResizeObserverManager（模块级 subscribe L354-358 永不退订）、react-dom flushSync | window-resizing 状态机在**生产未被接线**（见 Q07） |
| **rustCoreStore** | status/statusLoading/statusError | refreshStatus/search/compact/count/checkCmd/diff（全部薄包 api/rustCore） | api/rustCore | 职责合理；6 个 action 中 5 个纯转发无状态，可简化为纯函数模块 |
| **capabilitiesStore** | capabilities/cachedAt | refresh/reset + useCapability/useCapabilities hooks | api/capabilitiesStore | extractCapabilities 手工解析 unknown（L23-45），API 返回无类型契约 |
| **providerStore** | providers(Map)/activeProviderId/routes/accounts/healthStatus(Map) | add/update/remove provider/model/route/account + refreshAccountStatus/refreshAllAccounts/setHealthStatus | persist + immer + migration | **refreshAccountStatus 直连 fetch（L105）绕过 api 层**；persist 用 Map reviver/replacer 自造序列化；**与 layoutStore.providers 数据重叠**（providerStore 是用户配置，layoutStore.providers 是引擎同步的 ProviderInfo 列表——两处「provider 状态」并存） |
| **telemetryStore（死）** | appSettings/scheduledTasks/mcpServers/providers/activeWorkers/tokenUsage/killedWorkerIds/manuallyTriggeredWorkers/hydratedFromDisk | setAppSettings/setScheduledTasks/syncTelemetryData/killWorker/triggerCronJobNow | layoutStore（类型） | **全仓 0 import**；与 layoutStore 遥测字段完全重叠；appSettings 类型 `Record<string, unknown>` 与 layoutStore `Settings | null` 不一致（L20 vs layoutStore L220） |

## 三、问题清单

| 编号 | 文件:行号 | 严重度 | 描述 | 建议 |
|---|---|---|---|---|
| Q01 | app/AppBootstrap.ts:147-154 + 279-331；app/useEngineBootstrap.ts:5-61；bootstrap-full.ts:7-9；api/ConnectionManager 体系 | 重要 | **引擎就绪初始化四份复制**：AppBootstrap 内 section 3（transport.isReady 探测）与 section 7（完整 initEngine：transport 订阅 + ensureDaemonConnected + syncActiveProfileToEngine + syncSessionsFromDaemon + 12s gate timer）几乎相同；useEngineBootstrap.ts 是第三份完整拷贝（**死代码**，仅测试引用）；bootstrap-full.ts idle 阶段又跑一次 ensureDaemonConnected；另 ConnectionManager.connect 也独立启动。main.tsx 启用 StrictMode（L74），section 7 的 effect 会 mount→unmount→mount 执行**两遍**，`syncSessionsFromDaemon` 并发 merge 两次、`setEngineReady` 被 gate timer 强制置位 | 收敛为单一 `useEngineState`/ConnectionManager 投影；删除 useEngineBootstrap.ts 与 section 3；StrictMode 双执行用 cleanup 语义或去重锁（ensureDaemonConnected 幂等化）；gate timer 不应无条件 setEngineReady |
| Q02 | store/layout-helpers/store-persistence.ts:134-283；app/AppBootstrap.ts:305-313；store/sessionIndexLoader.ts:11-26 | 重要 | **sessions 三写路径并发竞态**：E3（SQLite 回灌 `store.setState` 整表/补正文）、E12（daemon merge 后 `layout.setSessions` 整表替换）、bootstrap-full→sessionIndexLoader（第三处「补保险」按 `!sessionsById[id]` 增量 push）。三者异步无串行化，回灌与 daemon merge 交错时可能互相覆盖（README 已记载「350ms persist 用空数组擦 SQLite」的历史教训，但三写并存使同类竞态仍可复现） | 确立单一「会话回灌编排」：E3 完成前 E12 不 merge（等待 hydrationComplete），sessionIndexLoader 并入 E3 或删除 |
| Q03 | app/AppBootstrap.ts:92-111；store/layout-helpers/store-persistence.ts:71-86 | 重要 | **hydrateWorkspaceShell 不等 layoutStore hydration**：门闩只等 `waitLayoutTreeHydration()`，而 layoutStore 的 `waitForHydration()`（store-persistence.ts:71-86，已导出）从未被调用。restore 路径（L97）读 `root.layout.getSessions()` 时可能只有 seed 壳，known 表缺失真实会话标题 | hydrateWorkspaceShell 前加 `await waitForHydration()`（或等价门闩），与 layout-tree 门闩并行 |
| Q04 | store/telemetryStore.ts:58-124；store/storeTelemetryActions.ts:76-107；store/slices/*.ts（4 文件） | 重要 | **遥测/切片实现三份并存，两份死代码**：telemetryStore 全仓 0 import；storeTelemetryActions.createTelemetryActions 0 import；store/slices/ 4 文件 0 import。活路径 layout-core-actions.ts:118-173,218-260 与两份死实现逻辑几乎逐行相同（syncTelemetryData/killWorker/triggerCronJobNow）。门禁 `check:store-types` 未覆盖死文件，死代码不受类型门禁约束，易腐烂 | 删除 telemetryStore.ts、storeTelemetryActions.ts、store/slices/ 全部 4 文件；遥测 action 收敛到 layout-core-actions 单一实现 |
| Q05 | store/provider/providerStore.ts:105 | 重要 | **store 绕过 api 层直连网络**：`refreshAccountStatus` 直接 `fetch('/api/accounts/${id}/status')`，无 transport 封装、无超时/重试/类型校验（`data` 为 any-ish JSON）。这是全仓唯一 store 内裸网络调用，违反「store→api 模块分层」契约 | 抽出 `api/accountStatusApi.ts`（复用 transport/clientApi 模式），store 只调 api |
| Q06 | store/workspace-shell/workspaceShellStore.ts:85,99,121,150-157,514,610-624 | 重要 | **shell 跨 store 直取 + 永久订阅**：shell 内部 6 处直接 `useLayoutTreeStore.getState()`，与 layoutRestorePolicy.ts:6-9「shell 包必须经 compositionRoot.tree」的自家契约矛盾；模块加载即注册 L614-624 对 layoutTreeStore 的 subscribe（syncShellDocksFromTree 反向投影），**永不退订**，且 shell↔tree 双向投影（shell→tree applyDockToTree，tree→shell syncShellDocksFromTree）存在回环风险 | 统一经 compositionRoot.tree 门面；模块级订阅改为显式生命周期（bootstrap 注册/卸载）或接受单例并文档化 |
| Q07 | app/AppBootstrap.ts:334-351；services/WindowResizeBridge.ts:82-111；store/layoutAnimationStore.ts:32-42 | 重要 | **窗口缩放冻结状态机未接线 + 双写**：WindowResizeBridge.connect 在生产 **0 调用方**（仅测试），`window-resizing` 冻结从未进入 layoutAnimationStore（is-layout-frozen 永不触发）；AppBootstrap E13 仍在手动 `classList.add/remove('window-resizing')`（100ms debounce），与 layoutAnimationStore TYPE_BODY_CLASSES 已声明的接管职责**双写**，且手动 remove 可能清掉 store 期望保留的 class | 在 bootstrap-services 调 `WindowResizeBridge.getInstance().connect()`；删除 AppBootstrap E13 手动 class 逻辑，统一走 begin/endLayoutInteraction |
| Q08 | app/AppBootstrap.ts:168-181 | 重要 | **AppBootstrap 直接 immer 写 sessions**：folder rebind 用 `useLayoutStore.setState` recipe 直接 `state.sessions.push` + 改 folderOrder，绕过 session 域 action（renameSession/moveSession 等）与 storeAccess 编排层，且 `console.info` 保留在生产 | 收敛为 session action（如 `rebindSessionFolders(projects)`）或经 compositionRoot.session 命名方法 |
| Q09 | store/layout-helpers/layout-core-actions.ts:41-42；store/layout-helpers/store-persistence.ts:36 | 重要 | **门禁违例**：自家门禁（store/README.md:181-182）声明 store/*.ts 禁止 `: any`，但 layout-core-actions.ts:41 `set: (updater: (state: any) => void) => void, get: () => any` 与 store-persistence.ts:36 `setState: (partial: any, replace?: any) => void` 均为显式 `: any`（门禁脚本未覆盖到这两个文件） | 门禁脚本扩展到 layout-helpers/ 与 workspace-shell/；`StoreApiLike` 用 Pick<LayoutStore,...> 窄化，layout-core-actions 用 `unknown` + 类型守卫 |
| Q10 | store/bootstrapStores.ts:10-94；store/storeTransaction.ts:23-66；api/store-access/storeAccessCore.ts:101-206 | 建议 | **死代码双份 + 双 StoreTransaction 实现**：bootstrapStores 内 6 个 sync* 函数（syncLayoutToSession 等）与 `batchRollback` 标志从未被调用（注释自认「no inter-store subscribe sync required」）；`store/storeTransaction.ts` 的 StoreTransaction 全仓 0 import（deepClone 语义），而活实现是 `api/store-access/storeAccessCore.ts:101-206`（浅 clone 语义）——两个同名类语义不同，极易误用 | 删除 store/storeTransaction.ts 与 bootstrapStores 死函数；bootstrapStores 只保留 initStoreAccess + freq 日志 |
| Q11 | app/AppBootstrap.ts:21-23；store/layoutStore.ts:327-333 | 建议 | **window 全局 + 永久计数订阅双写**：AppBootstrap.ts:22 与 layoutStore.ts:328 都执行 `window.useLayoutStore = useLayoutStore`；layoutStore.ts:330 的 subscribe 每次 store 更新给 `__storeUpdateCount` +1，生产环境也执行、永不清退 | 保留单处赋值（layoutStore 内），计数订阅移入 DEV 分支 |
| Q12 | services/SessionSyncService.ts:189-227,348-353；bootstrap-services.ts:81-84,126-134 | 建议 | **SessionSyncService 生命周期泄漏 + 双同步体系**：init 启动 5s push / 5min pull 定时器，bootstrapServices 的 cleanup **不含 `sessionSyncService.destroy()`**（L126-134 只清理注册的 unsubs）；且该服务与 sessionDaemonSync（E12 主路径）构成两套会话同步协议（sync-push/sync-pull vs daemon 直连），注释自认「引擎不支持 sync-pull 则停表」 | 明确主备关系：若 daemon 同步为主，删 SessionSyncService（含 IndexedDB 队列）；若保留，cleanup 必须 destroy |
| Q13 | services/ConnectionManager.ts:75-81；hooks/useDaemonState.ts:123-148；app/AppBootstrap.ts:283-290 | 建议 | **连接状态三处独立投影**：ConnectionManager（bootstrap 单例）、useDaemonState（模块单例 refcount）、AppBootstrap E12 各自 `transport.onStatus` 订阅，状态更新点分散，future 状态漂移面大 | useDaemonState/AppBootstrap 改为消费 ConnectionManager 投影（onStateChange），单一订阅源 |
| Q14 | store/layout-tree/layoutTreeStore.ts:497-515 vs app/hydrateWorkspaceShell.ts:65-153 | 建议 | **restore 策略双份实现**：layoutTreeStore.onRehydrateStorage 与 hydrateWorkspaceShell 各自实现「restore 开关读取 + 校验 + clean 回退」，读取 `RESTORE_LAST_WORKSPACE_LS_KEY` 的三处（layoutTreeStore.ts:208-217、layoutRestorePolicy.ts、hydrateWorkspaceShell.ts:52-54）判定规则需保持一致 | 收敛为 layoutRestorePolicy 单一纯函数（validate+decide），两处调用同一实现 |
| Q15 | hooks/chat-stream/useSlashSend.ts:393-395 | 建议 | **会话激活绕过 shell 门面**：send 路径直接 `sessionFacade.setActiveSessionId(sessionId)`，与 README「one owner per gesture（shell only）」冲突；注释自认例外，但 useSlashSend 是 hooks 层，等同组件行为 | 若确需保持，升级为文档正式契约（session.sendActivate 命名 action）；否则经 shell.openOrFocusSession |
| Q16 | store/layout-helpers/store-persistence.ts:231-263 | 建议 | **回灌后直接 setActiveSessionId**：绕过 shell 激活语义（不建 TabSurface、不绑 leaf），远程壳的 UI 入口（顶栏 tab）不会出现，与 shell 激活路径行为不一致（有注释解释动机，但属第 4 条激活实现） | 回灌后经 compositionRoot.session.openOrFocusSession（由 shell 决定建 tab/绑 leaf），或显式文档化「仅 hydrate 不建 tab」 |
| Q17 | hooks/useAgentStream.ts:133-143,279-299 | 建议 | **hooks 直改 store（immer recipe）**：buildPatchAsst/finalizeInFlight 用 `useLayoutStore.setState` 直接 patch agent 消息，绕过 patchSessionAgent/appendSessionAgentMessage action；文件头注释自认 OPT-H4「intentional residual」，但与 README「消费侧收紧」方向相悖 | 流式热路径可保留（性能理由），但应统一走 streamingStore 缓冲（主对话已如此），agent 面板对齐主对话架构 |
| Q18 | hooks/chat-stream/index.ts:65；hooks/useAgentStream.ts:215；store/workspace-shell/openTool.ts:114,124 | 建议 | **类型逃逸**：`setActiveDiffSource as (source: any) => void`（index.ts:65，setActiveDiffSource 实参类型本可精确声明）；`approvalMeta?: any`（useAgentStream.ts:215，应引 MessageToolCallApprovalMeta）；openTool.ts:114,124 `node: any` 两处（应 LayoutNode 联合类型 + 类型守卫） | 全部消除；门禁脚本扩展到 hooks/ 与 workspace-shell/ |
| Q19 | store/sessionStore.ts:111-143 | 建议 | **useSidebarSessions 手写订阅范式**：useReducer + subscribe + ref 快照实现，与 useDaemonState（useSyncExternalStore）范式不统一；`searching` 变化不重新订阅（依赖 []），靠 snapshot 比较绕过 | 改 useSyncExternalStore + 相等函数（sidebarSessionsEqual 已有），删手写样板 |
| Q20 | hooks/useWindowControls.ts:8-35；app/AppBootstrap.ts:31-45 | 建议 | **窗口控制重复实现**：useWindowControls 与 AppBootstrap.winCtl 代码逐行相同，AppTopBar 用的是 winCtl（AppBootstrap），useWindowControls 生产 0 消费方（仅测试引用） | 删除 useWindowControls，AppBootstrap.winCtl 保留为唯一实现（或反之） |
| Q21 | hooks/useStreamRenderThrottle.ts:17-64 | 建议 | **死 hook**：useStreamRenderThrottle 全仓 0 消费方（渲染节流已由 streamingStore + StreamRenderBuffer + useChatAutoScroll 覆盖） | 删除 |
| Q22 | hooks/useTreeDrag.ts:49-54；hooks/useToolDockTabDrag.ts:41-44；hooks/useTabDrag.ts（tab-drag/*） | 建议 | **三套拖拽控制器 + 常量重复**：useTreeDrag / useToolDockTabDrag / useTabDrag(tab-drag/) 各自实现 pointer 生命周期、ghost 跟随、drop zone、phase 状态机；`DRAG_THRESHOLD_PX=5`、`GHOST_OFFSET_X/Y=16`、`DROP_DETECT_INTERVAL_MS=16` 常量重复 2-3 份 | 抽公共「pointer 手势基座」（阈值/ghost/phase/监听注册统一），三套只留 drop 语义差异层 |
| Q23 | hooks/useVirtualDiffScroll.ts:8-19；hooks/useVirtualScroll.ts:62-74 | 建议 | **虚拟滚动简化重复实现**：useVirtualDiffScroll 重写 ResizeObserver + scrollTop 逻辑，与 useVirtualScroll 重复 | 删简化版，或让 useVirtualScroll 支持「仅高度同步」模式 |
| Q24 | store/layout-helpers/store-persistence.ts:100-290 vs store/sessionIndexLoader.ts:11-26 | 建议 | **回灌路径双实现**：sessionIndexLoader「按缺失 id 增量 push」与 initStorePersistence「空则全量/补正文」语义重叠，两条 SQLite 读取路径并行 | 删除 sessionIndexLoader，保留 initStorePersistence 单一路径（补保险并入其中） |
| Q25 | store/capabilitiesStore.ts:23-45；store/provider/providerStore.ts:105-122 | 建议 | **API 返回无类型契约**：capabilities 手工 `(raw as Record<string, unknown>)` 解析、accounts status 用裸 JSON——store 状态形状依赖运行时猜测，与「store 状态与 API 返回类型一致」目标不符 | 在 api 层为 capabilities/account-status 定义 zod/类型守卫 + 导出类型，store 消费类型化结果 |

## 四、hooks 重复清单

| 组 | 文件列表 | 建议合并方向 |
|---|---|---|
| 1. 会话激活 / 打开 tab | workspaceShellStore.openOrFocusSession（store 内）；useSlashSend.commitDraftAndOpenShell（useSlashSend.ts:132-145）与 send 路径 setActiveSessionId（:393-395）；store-persistence 回灌后 setActive（:231-263）；keyboard/editing-keys.ts:30-35（openNewDraftTab）；sessionActions.setActiveSessionId 本体 | 统一经 compositionRoot.shell + session facade 命名 action；删除 useSlashSend 内直接 setActiveSessionId 分支与回灌直激活 |
| 2. 引擎/连接就绪探测 | AppBootstrap section 3（:147-154）；AppBootstrap section 7（:279-331）；useEngineBootstrap.ts（死）；bootstrap-full.ts:7-9；ConnectionManager.connect；useDaemonState 模块单例 | 单一 ConnectionManager/useEngineState 投影；删 useEngineBootstrap、section 3、bootstrap-full 中重复探测 |
| 3. 拖拽控制器 | useTreeDrag.ts；useToolDockTabDrag.ts；useTabDrag.ts + tab-drag/*（useTabDragEvents/useTabDragReorder/tabDragGhost/tabDragGeometry） | 抽公共 pointer-drag 基座（phase 状态机/阈值/ghost/pointerId 隔离），三套仅保留 drop 语义 |
| 4. resize / sash | useColumnResize.ts；useTreeResize.ts；components/workspace/useWorkspaceResize.ts（自注已废弃仍存在） | 抽公共 sash 手势基座；删除已废弃 useWorkspaceResize |
| 5. 虚拟滚动 | useVirtualScroll.ts；useVirtualDiffScroll.ts | 保留 useVirtualScroll，删简化版 |
| 6. 窗口控制 | useWindowControls.ts（死）；AppBootstrap.winCtl | 保留 winCtl，删 hook |
| 7. toast 通道 | useToastQueue.ts；services/ToastBus.ts（'toast:show' 监听）；services/TelemetryService debug | 明确单一通道（建议 useToastQueue 为主，ToastBus 仅转发或删除） |
| 8. 会话回灌 | initStorePersistence（store-persistence.ts）；sessionIndexLoader.ts；sessionDaemonSync（E12） | 单一回灌编排 + 串行化（见 Q02/Q24） |
| 9. 遥测 actions | layout-core-actions.ts（活）；storeTelemetryActions.ts（死）；telemetryStore.ts（死） | 删两份死实现，收敛到 layout-core-actions |
| 10. 窗口缩放冻结 | AppBootstrap E13 手动 class；WindowResizeBridge.ts（未接线）；layoutAnimationStore window-resizing | 统一走 begin/endLayoutInteraction（见 Q07） |

## 五、启动链路时序现状图（文字描述）

```
main.tsx startup()
 └─ initSsrGlobals（同步 localStorage 读替换）
 └─ bootstrap-orchestrator.ready：configService.init() → registerConfigSchemas() → serviceRegistry.startAll()
 └─ bootstrap-core：platformDetect → lightweightMode → workers.initMinimalPool → minimalConfig → oauthTokenScheduler
 └─ 暴露 window.__CRISH_STORE__ 等 4 个全局
 └─ 动态 import React / createRoot → render(<StrictMode><AppErrorBoundary><App/>)
      App render（useAppBootstrap 13 个 effect 按序注册；StrictMode 下 effect 全部双跑）
        E1  窗口 globals（AUTO_FOLD_DELAY）
        E2  document lang/title
        E3  initLayoutStorePersistence（异步）：ensureMigrated → hydrateSessionsFromRust → setState 回灌/补正文 → 350ms debounce persist → hydrationComplete=true
        E4  (useLayoutEffect) 等 waitLayoutTreeHydration → hydrateWorkspaceShell：readRestoreLastWorkspace → validateRestorableLayoutTree
            ├─ false/失败 → applySafeCleanColdStart → setShellReady(true)
            └─ true  → ensureAdapterShape → loadLegacyOpenTabsMap → shell.migrateFromOpenTabsMap / resetToCleanDraft → syncShellDocksFromTree → setShellReady(true)
        E5  bootstrapServices：registerCompositionRoot → ptyRegistry↔Tauri bridge → pagehide killAll → installBeforeunloadFlush → ConnectionManager.connect → SessionSyncService.init → CrossTabCoordinator.init → EventBus wiring（telemetry/ErrorStore）
        E6  崩溃遥测上报（clientApi.getSettings → telemetry）
        E7  bootstrapStores：initStoreAccess(三 facade) + 60s 频率日志 interval
        E8  transport.isReady 探测 → setEngineReady(true)（if ready）
        E9  (useLayoutEffect) folder rebind：rAF×2 → rebindSessionFoldersToProjects（直接 setState 写 sessions）+ layoutStore.subscribe + crish-project-changed 监听
        E10 workspaceLayoutStore.initWorkspaceLayoutSync
        E11 theme/font/settings：clientApi.getSettings → setAppSettings → applyTheme/persistTheme → setFontPreferences → setTabModeEnabled
        E12 initEngine：transport.isReady → onStatus(connected) → ensureDaemonConnected → syncActiveProfileToEngine + syncSessionsFromDaemon（getSessions/setSessions 回调）→ gateTimer(12s/0ms) 强制 setEngineReady
        E13 resize listener：手动 body.classList 'window-resizing'（100ms debounce，不进 store）
        E14 root data-* 属性（uiSize/density/shell-chrome）
        E15 body data-app-mode
        E16 clientApi.subscribeTelemetry → syncTelemetryData
        E17 pick-workspace UI 事件
        E18 layout-tree 迁移 migrateLayoutIfNeeded
 └─ idle（requestIdleCallback/timeout 1s）：bootstrap-full
      ├─ ensureDaemonConnected（第 4 份连接尝试）
      ├─ clientApi.getSettings → applyTheme（与 E11 重复）
      ├─ loadSessionIndexOnly（第 3 条 sessions 写路径）
      └─ workers.scaleUpPool
```

**并发/竞态关键点**：E3（SQLite 回灌）与 E12（daemon merge）并发写 sessions（Q02）；E4 不等 E3 完成（Q03）；StrictMode 下 E5/E7/E12 全双跑，E12 的 syncSessionsFromDaemon 与 gate timer 各执行两次；E13 与 layoutAnimationStore 的 window-resizing 双写（Q07）。

## 六、正面发现

1. **架构文档化质量极高**：store/README.md 的 ownership 表、forbidden writes、getState 约定、门禁命令（check:store-types）与 storeOwnership.ts 类型标签形成完整的「文档即契约」体系；storeFacades.test.ts 单测锁死三门面同实例。
2. **streamingStore 设计正确**：无 immer 的 per-token 缓冲避免每次 token 重写 immer 树；`updateStreamImage` 在 set recipe 内二次读取防并发覆盖（streamingStore.ts:233-242）；命令式 helper 与 hook 分离。
3. **useDaemonState 采用标准范式**：useSyncExternalStore + 模块级单例 + refcount 生命周期 + 浅比较拦截，后台标签页跳过轮询，无 Lanes 级联风险。
4. **layoutAnimationStore 的 watchdog**（30s force-end，layoutAnimationStore.ts:58-87）与对称 end 清理（重复 end 仍校正 body class）防永久冻结，是防御性编程范例。
5. **shell 的 PTY 清理纪律**：closeTab/resetToCleanDraft 经动态 import ptyRegistry 杀 PTY（防环），pagehide killAll 走 compositionRoot 单入口。
6. **messageSnapshotsBridge 打破 init 环的 DI 注入模式**（模块稳定后 bind 真实实现）是解决 store 循环依赖的好样板。
7. **sessionIndex O(1) 索引 + 一致性校验工具链**（build/reindex/check/assert + 单测）对 god-store 下的热路径与调试均有利。
8. **组件级清理普遍规范**：useToastQueue timers Map 卸载清空、useChatAutoScroll rAF/MutationObserver 双清理、useToolDockTabDrag 卸载兜底 cancelDrag、useAgentStream mountedRef + cancelRef + cooldown 清理。
9. **门禁脚本 check-no-as-any-store 确实生效于主路径**（store 顶层与 storeAccess 无 any），仅 layout-helpers/ 与 workspace-shell/ 存在漏网（见 Q09/Q18）。
