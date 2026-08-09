# 前端状态管理架构审计（apps/crish-desktop）

- 审计日期：2026-08-09
- 审计范围：`src/store/` 全部 store、`src/services/` 单例（EventBus / ErrorStore / ConnectionManager）、`src/api/chat-bridge/`（EventRouter / dataPlaneRouter / handlers 分派表）、`src/hooks/chat-stream/`（流式写入路径）、`src/api/store-access/`（编排层）、持久化（zustand persist + SQLite + localStorage 直读直写面）
- 方法：全实读 + git 历史追溯（关键结论均附 `文件:行号` 证据）
- 一句话结论：**「单一 god store（layoutStore）+ 门面 alias」是当前架构主形态，事件→store 写入路径存在 16 处绕过 action 的直接 setState 残留；最严重发现是消息快照桥（messageSnapshotsBridge）为死桥——撤回/归档等破坏性操作的数据保护机制静默失效（git 证明注入函数从未被调用、且被 2026-08-08 knip 清理删除）。**

---

## ① store 全景表

### 1.1 实例清单（zustand create 实例）

| # | Store | 文件:行号 | 核心状态 | 方法数 | 订阅面（组件/模块） | 持久化 |
|---|-------|-----------|----------|--------|---------------------|--------|
| S1 | **layoutStore**（god store） | `src/store/layoutStore.ts:189` | sessions / sessionsById / folderOrder / activeSessionId / agents / composerDrafts / workspaces / draggedTab / dropPreview / 8 项布局 chrome（uiSize、shellChromeMode、chatMainSurface、sidebarCollapsed、tabMode、settingsOverlay×2、hydrationComplete） | 58（layout-core 8 + SessionActions ~30 + WorkspaceActions ~20，见 1.2） | 极宽：Sidebar / Workspace / ChatCard / Settings* / OverviewCard / ApprovalSection / 45 处 `useLayoutStore(`（components 内 grep 计数） | `crish-layout-v1`（仅 4 字段：workspaces / sidebarCollapsed / activeWorkspaceIndex / tabModeEnabled，layoutStore.ts:232-240） |
| S2 | sessionStore / workspaceStore / settingsUiStore（**三门面 = 同一实例**） | `sessionStore.ts:30`、`workspaceStore.ts:40`、`settingsUiStore.ts:69` | —（alias） | 门面 API（selector / get* / 便捷 hook） | 会话/工作区/设置 UI 消费方 | 同 S1 |
| S3 | **streamingStore**（热路径 token 缓冲，无 immer） | `streamingStore.ts:129` | byKey（`sessionId::messageId` → StreamEntry：text / thinking / tools / images） | 15（7 setter + 8 getter）+ 12 命令式 helper | 仅 2 组件：MessageContent（正文+tools，单 shallow 订阅，`MessageContent.tsx:47-54`）、ChatAssistantMessageRow（仅 thinking，`ChatAssistantMessageRow.tsx:126-129`） | 无（一次性缓冲，收口后 clear） |
| S4 | **terminalStore** | `terminalStore.ts:66` | terminalLines（活动镜像）/ terminalBySession / activeTerminalSessionId / diffFiles / activeDiffSource | 9 | TerminalCard / diff 面板 / RuntimePanel（经 storeAccess 读面） | 无 |
| S5 | **workerStore** | `workerStore.ts:39` | activeWorkers / killedWorkerIds / manuallyTriggeredWorkers | 4 | RuntimePanel（worker 列表 / kill） | `crish-workers-v1`（仅 killedWorkerIds，workerStore.ts:107-112） |
| S6 | **permissionStore** | `permissionStore.ts:54` | permissionMode / planModeEnabled / planApproved / commandPermissions | 6 | Composer / 审批 UI / 设置页 | 刻意不 persist（委托 api/permissionModes + api/commandPermissions，permissionStore.ts:11-18） |
| S7 | **settingsStore** | `settingsStore.ts:53` | appSettings / providers / scheduledTasks / mcpServers / tokenUsage | 5 | 设置页 / OverviewCard（tokenUsage）/ RuntimePanel / ScheduledTasksPanel | `crish-settings-v1`（仅 scheduledTasks，settingsStore.ts:111-116） |
| S8 | **workspaceShellStore**（TabSurface write owner） | `src/store/workspace-shell/workspaceShellStore.ts:262` | openTabs / activeTabId / shellReady | 12（open/focus/close/reorder/dock/restore…） | App（shellReady）/ TabBar / compositionRoot.shell | 内存态 + legacy open-tabs map（localStorage，`api/workspaceChromeTabs.ts`）双向同步 |
| S9 | **layoutTreeStore**（二叉树几何 write owner） | `src/store/layout-tree/layoutTreeStore.ts:238` | tree / activeLeafId / draggedSource / activeDropZone / past / future / toolColumnCollapsed | 26（结构 8 + 焦点 4 + 拖拽 4 + 历史 6 + misc） | BinaryTreeWorkspace | `crish-layout-tree-v1`（window-scoped，layoutTreeStore.ts:73-84、479；版本迁移 migration.ts） |
| S10 | layoutAnimationStore | `src/store/layoutAnimationStore.ts` | 动画冻结状态机（active 集合 + watchdog） | ~8 | ResizeObserverManager 桥（bootstrap 注册/退订，bootstrap-services.ts:123） | 无 |
| S11 | rustCoreStore | `src/store/rustCoreStore.ts:47` | status / statusLoading / statusError | 5 | **0 调用点（DEAD）**，文件头自述 deprecated（rustCoreStore.ts:38-46），index.ts:174 仍导出 | 无 |
| S12 | cacheEventsStore | `src/api/chat-bridge/handlers/cacheEventsStore.ts:130` | runStats / alerts / coldHint / coldWarnedRunIds | 4 | SessionCacheStatsPanel（事件→store 单链） | 无 |
| S13 | securityAuditStore | `src/api/chat-bridge/handlers/securityAuditStore.ts:58` | entries | 2 | SecurityAuditSection / RuntimePanel | 无 |
| S14 | flowDagStore / SlashExtension 内部 store | `src/components/workspace/flowDagStore.ts`、`src/components/chat-composer/SlashExtension.ts` | 组件局部状态 | 少量 | 仅本组件 | 无 |

### 1.2 非 zustand 单例（服务层状态）

| 单例 | 文件 | 状态面 | 订阅面 |
|------|------|--------|--------|
| eventBus | `services/EventBus.ts:98` | 事件总线（Map<type, Set<handler>>，MAX_LISTENERS_WARN=10，EventBus.ts:85-87） | ConnectionManager 发布连接态；bootstrap 常驻订阅 1 处 |
| errorStore | `services/ErrorStore.ts:263` | activeErrors / errorHistory / connectionStatus / persistenceStatus | AppErrorBoundary（订阅连接态投影） |
| connectionManager | `services/ConnectionManager.ts:264` | ConnectionState（phase 投影） | bootstrap-services.ts:81 启动；EventBus 广播 |
| useEngineState 模块单例 | `hooks/useEngineState.ts:88-107` | engineOnline / activeRuns / pendingApprovals / bgTasks / workflows（4s 轮询 + 事件刷新） | RuntimePanel / OverviewCard（refcount 生命周期） |
| api 级 localStorage store | themeStore / fontStore / projectStore / usageStore / pricingStore / profileStore / updateStore / previewBrowserStore / workspaceLayoutStore 等（52 个非测试文件直读直写 localStorage，见 ⑤） | 各自域 | 组件/设置页 |

### 1.3 store 间依赖关系

- **门面 alias**：S2 三门面 `= useLayoutStore` 同引用（sessionStore.ts:30、workspaceStore.ts:40、settingsUiStore.ts:69，storeFacades.test.ts 已验证）。
- **跨域单向委托（设计内）**：settingsStore → workerStore（`settingsStore.ts:106-108` syncTelemetryData 单向落盘）；sessionActions/sessionOrderingActions → terminalStore（`sessionCrudActions.ts:97/161/356/403/431/485`、`sessionOrderingActions.ts:78/130`，会话切换时同步终端镜像）。
- **sibling store 交叉投影**：workspaceShellStore ↔ layoutTreeStore（applyDockToTree / registerTreeDockSync 反向投影，workspaceShellStore.ts:631-651；投影抑制防回环 treeDockProjection.ts）。
- **编排层**：`api/storeAccess.ts`（三域 facade + 跨域写 getLayoutState）+ `store/storeAccess.ts`（T11 新域读面）。
- **compositionRoot**：`app/compositionRoot.ts` 提供 session/shell/layout/workspace/pty 门面，为命令式热路径唯一入口（README:23-32）。

---

## ② 双源/冗余清单（D1–D10）

| # | 数据 | 源 A（写） | 源 B（写） | 同步机制 | 竞态/风险 |
|---|------|-----------|-----------|----------|-----------|
| D1 | 消息正文（流式期） | streamingStore.byKey（`useStreamCallbacks.ts:298` buffer.onFrame → setStreamText） | sessionStore messages[].text（终态） | 收口时单次 commit（`helpers.ts:184-217` commitStreamToSession；工具前快照 `snapshotStreamTextToSession` helpers.ts:224-237）；读侧合并函数 `applyStreamTextToMessage`（streamingStore.ts:423-464） | **设计内缓冲**；合并逻辑有分叉兜底（streamingStore.ts:445-448）。无竞态（单写单收）。复杂度风险在 merge 语义（blocks/streamTextOffset 交错） |
| D2 | 引擎在线状态 | `useEngineState.engineOnline`（transport.onStatus 直连，useEngineState.ts:171-173） | `errorStore.connectionStatus`（transport → ConnectionManager.handleStatusChange（ConnectionManager.ts:86-88,193-215）→ eventBus `engine:connection:change`（:245-247）→ bootstrap 挂接（bootstrap-services.ts:91-110）→ ErrorStore.setConnectionStatus） | **无交叉同步**；两条独立投影链，第二个链多一跳 EventBus | 两个 React 可见连接态；EventBus 链路存在时序延迟，UI 两处状态展示可能短暂不一致 |
| D3 | 主题 theme | themeStore：`crish_theme` 键 + 合并写 `crish_settings`（themeStore.ts:16-17、49-60） | settingsStore.appSettings.theme（引擎事件权威回灌，settingsStore.ts:71-74；启动播种 DOM：AppBootstrap.ts:238-244） | 仅启动单向播种（engine → DOM + persistTheme）；**运行期无双向同步** | 设置页改主题只写 localStorage（themeStore.setTheme），引擎侧设置不被回写；settingsStore.appSettings 刷新后 DOM 不回读 → 主题与设置快照可能分叉 |
| D4 | tokenUsage | settingsStore.tokenUsage（telemetry 权威累计，settingsStore.ts:86-104，经 accumulateTokenUsage 增量合并，useStreamCallbacks.ts:917-924） | api/usageStore（`crish_usage_history_v1` 日/模型历史，usageStore.ts:43，recordUsageDelta 同事件写入 useStreamCallbacks.ts:928-936） | 同一 telemetry 事件双写两个 sink（useStreamCallbacks.ts:917/928 并列） | 口径不同（当前值 vs 历史流水），非冲突但为同因双写点；已做串行化增量防并发丢失（注释 F5 P2） |
| D5 | 项目/文件夹归属 | api/projectStore（`crish_projects_v1`，projectStore.ts:20） | sessions[].folder / folderOrder（layoutStore 会话域） | AppBootstrap 订阅 sessions 引用变化 → rebind 全表重扫 + **直写** folderOrder（AppBootstrap.ts:144-189、155） | rebind 为 O(sessions×projects) 全表扫描，且订阅了 store 自身（prevSessions 引用比较防环，AppBootstrap.ts:184-189）；folder 去规范化进 sessions 无索引回写，删除项目后脏 folder 依赖 rebind 收敛 |
| D6 | sessionsById vs sessions[] | 同一 store 双投影（index + 保序数组） | autoIndex 中间件维护（autoIndexMiddleware.ts） | reindex 时机：sessions 数组引用变化时重建（README:130-133） | **已知 immer 陷阱**：只经 sessionsById mutate 时 map 值 fork，数组持旧引用 → 「列表丢消息」表象（README:130-133 已文档化）；有 getSessionForWrite / withAutoIndex 双防线 |
| D7 | terminalLines vs terminalBySession[active] | terminalStore 内镜像 | setActiveTerminalSession / addTerminalLine 双写（terminalStore.ts:76-100） | 会话切换时由 session actions 8 个散点调用 setActiveTerminalSession（见 1.3） | 新增会话切换路径若漏调 → 镜像陈旧；当前 8 个调用点覆盖 CRUD/排序，流式路径不切换镜像（低风险） |
| D8 | rustCoreStore.status | rustCoreStore（DEAD，0 调用） | useEngineState.engineOnline（活面） | 无 | 死面占位，需按 DEAD formal 流程删除（rustCoreStore.ts:42-45） |
| D9 | activeSessionId vs shell openTabs[].sessionId | layoutStore.activeSessionId | workspaceShellStore.openTabs | shell 动作编排（openOrFocusSession/activateTab 双向，workspaceShellStore.ts:286-288、316-321）+ 组件侧「禁止双写」纪律（storeOwnership.ts:69-73） | 设计内单一手势；风险在于纪律型约束（无运行时守卫），组件误调 setActiveSessionId + shell activate 会漂移 |
| D10 | open-tabs 持久化 | workspaceShellStore（内存） | legacy open-tabs map（localStorage OPEN_SESSION_TABS_KEY） | open/close/reorder 同步写 map（workspaceShellStore.ts:297-301、379、390-394）；migrateFromOpenTabsMap 一次性迁移（:546-580） | 迁移期双写并存的过渡态；无竞态（同线程同步写） |

**双源问题数：10 项（D1–D10），其中 2 项设计内缓冲/镜像（D1/D6/D7 属设计内、D9 属纪律型），实质缺陷面 4 项（D2/D3/D5/D10 残留）+ 2 项死面/占位（D8 + D4 双写点）。**

---

## ③ 事件流生命周期

### 3.1 事件→store 写入路径（统一性结论：**不统一**）

事件到达前端有三条入口，最终写 store 的方式分裂为「facade action / storeAccess 编排 / **raw setState recipe**」三种：

| 入口 | 链路 | 写入方式 |
|------|------|----------|
| per-run 流式（run 内） | transport.onMessage（state.unsub，ConnectionLifecycle.ts:493）→ EventRouter.onMsg（EventRouter.ts:92-132，runId 过滤 + 消费侧幂等去重）→ dispatchEvent 分派表（dispatch.ts:146-157）→ handler → env.callbacks.*（HandlerEnv，handlerEnv.ts:16-25）→ useStreamCallbacks 回调 | 混合：facade action（compositionRoot.layout.getState().*，useStreamCallbacks.ts:728/788/801/808）+ raw setState（:404/487/505/811/1061）+ storeAccess（:32-34）+ streamingStore |
| 数据面子面（跨 run 存活） | transport.onMessage 全局 fanout → dataPlaneRouter.handleDataPlaneMessage（dataPlaneRouter.ts:121-148，仅 10 类 task/timer/cron 类型）→ taskEventHandlers（刷新信号 + 轻量摘要，不落独立 store，taskEventHandlers.ts:264-396） | 不写 store（轮询快照全量覆盖 = 真源，taskEventHandlers.ts:5-6）；timer/cron 摘要为模块级 Set/计数 + useSyncExternalStore 订阅面（:142-152） |
| 子代理面（父 run 收口兜底） | transport.onMessage → subagentPlaneRouter（dataPlaneRouter.ts:217-268，_liveParentRuns 活跃集合防双写）→ onSubagentStartedGlobal/Event/EndedGlobal（subagentHandlers.ts:93-191） | **raw setState recipe 直写 agents/toolCalls**（subagentHandlers.ts:118/146/165） |

**直接 setState 绕过 action 的 16 处生产点（组件/hook/handler 直接 `useLayoutStore.setState` immer recipe）：**

| 位置 | 行号 | 写入内容 | 备注 |
|------|------|----------|------|
| `hooks/chat-stream/useStreamCallbacks.ts` | 404 / 487 / 505 / 811 / 1061 | engineLastRunId / agent messages / agent 终态+父工具卡 / timeline 归一 / stop 工具终态 | OPT-H4 标注「intentional residual」（:402-403、:486、:504、:810、:1060），LayoutFacade 无 setState 的已知缺口 |
| `hooks/useAgentStream.ts` | 134 / 280 | 子 agent 流式消息 patch | 同 OPT-H4 标注（:127-129） |
| `api/chat-bridge/handlers/messageHandlers.ts` | 36 | SessionMessage.cacheMetrics | 注释明示必须经 sessions[] canonical 数组写（:34-35），**手工纪律替代索引保障** |
| `api/chat-bridge/handlers/subagentHandlers.ts` | 118 / 146 / 165 | 全局面 agents/工具卡 | 无 action 封装，直写 |
| `app/AppBootstrap.ts` | 155 | 项目 rebind 写 sessions.folder + folderOrder | 启动期一次性 + sessions 变更订阅（:184-189） |
| `components/overview/useOverviewState.ts` | 154 | 待审批工具卡局部置标（markLocalTool 全表扫描 sessions） | 组件内全表遍历 O(all sessions × messages) |
| `components/workspace/workspaceChromeHooks.ts` | 319 | 工具列折叠 collapseToolColumnPreserve | 组件 hook 直写 workspaces |
| `components/workspace/Workspace.tsx` | 69 | resize 时 clamp activeWorkspaceIndex | 事件回调 |
| `components/workspace/ApprovalSection.tsx` | 68 | 批量审批后工具卡状态 | 组件直写 |
| `store/workspaceStore.ts`（facade） | 121 / 128-145 | setGroupActiveCard / focusExistingPanelCard | facade 层自身用 setState recipe 而非 action（facade 内无 action 定义的 2 个函数） |

另有 3 处 `useLayoutStore.getState()` 非订阅读：helpers.ts:88（事件路径）、useChatComposerProps.ts:120（effect 内一次性恢复草稿，合规边缘）、Workspace.tsx:67（事件回调）。README 消费侧收紧进度承认部分残留（README:173-181）。

### 3.2 订阅生命周期审计（泄漏面结论：**总体干净，无发现未退订常驻订阅**）

| 订阅 | 管理方式 | 证据 |
|------|----------|------|
| bootstrapStores 频率计数（layoutStore + 4 域 store 共 5 个订阅） | 显式 cleanup 退订 | bootstrapStores.ts:47-82 |
| EventBus `engine:connection:change` | bootstrap cleanup 退订 | bootstrap-services.ts:91-111 |
| ConnectionManager transport.onStatus | 单例生命周期（dispose 仅测试用）；emitStateChange 全量广播 | ConnectionManager.ts:86-88、234-243 |
| useEngineState 模块单例 | **refcount**：首订启动（transport.onStatus + dataPlane + subagent + refresh + 4s interval），归零全退订（4 个 unsub 对称） | useEngineState.ts:168-233 |
| dataPlaneRouter / subagentPlaneRouter | **refcount**：首个订阅者开 transport.onMessage，归零退订 | dataPlaneRouter.ts:154-166、276-288 |
| per-run 流式订阅 | state.unsub = transport.onMessage（ConnectionLifecycle.ts:493）→ cleanupStreamState 统一退订 + 清 endTimer（streamState.ts:24-31） | ConnectionLifecycle.ts:690-700、725-729 |
| registerTreeDockSync（tree→shell 反投影） | 显式注册/退订（幂等） | bootstrap-services.ts:127、workspaceShellStore.ts:631-651 |
| sessionRuntimeRegistry activeIdResolver | 模块级注册（sessionStore.ts:189-191）+ bootstrap 注销（bootstrap-services.ts:131-134） | — |
| layoutStore DEV 更新计数 | `import.meta.env.DEV` 分支才订阅（生产无常驻计数订阅） | layoutStore.ts:249-256 |
| EventBus 监听数警戒 | MAX_LISTENERS_WARN=10 时 console.warn（防泄漏提示） | EventBus.ts:85-87 |

**风险点（非泄漏但值得关注）**：
- dataPlane/subagent 路由的 refcount 依赖「轮询层持有引用」；若某消费方忘记 ensure 而另一个归零，数据面事件将无消费者（dataPlaneRouter.ts:29-33 自述「待装配」语义，生产装配点仅在 useEngineState.ts:178/183 一处——单点装配，属单点故障风险）。
- taskEventHandlers 的模块级 Map（recentEvents / suspiciousMarks / refreshThrottle / timerCronListeners）只在测试中 clear（clearDataPlaneStateForTests，taskEventHandlers.ts:435-449）；生产生命周期内无上限风险（有 DATA_PLANE_RECORD_CAP=256 与 1s 节流，taskEventHandlers.ts:28/31/202-212），但属模块级可变状态，无销毁语义。

---

## ④ 跨模块通信与隐式耦合

### 4.1 通信方式占比（定性）

- **props 传递**：主流（MessageContent / ChatAssistantMessageRow / ToolStack / Settings*Tab 均 props 驱动）。
- **store 单例 import**：第二大面——45 处组件内 `useLayoutStore(selector)`；hooks/组件 import facade 成惯例；api 层 → store 单向依赖（handler 直 import layoutStore，messageHandlers.ts:12、subagentHandlers.ts:15）。
- **事件**：EventBus（仅连接态 + uiEvents 局部事件）、事件→store 的 handler 面（chat-bridge）。
- **context**：SessionTabDragProvider（App.tsx:187）、PlatformAdaptationCtx（App.tsx:186）。

### 4.2 「组件 A 修改组件 B 状态」的隐式耦合面

| 耦合 | 路径 | 机制 |
|------|------|------|
| ChatCard（流式收口）→ 子 agent 面板 | useStreamCallbacks onSubagentStarted/Event/Ended（useStreamCallbacks.ts:454-544）经 raw setState 写 sessionsById[].agents | ChatCard 通过 god store 单例改 InlineAgentPanel 的展示数据，无显式接口 |
| 子代理面全局消费（dataPlaneRouter）→ InlineAgentPanel / 工具卡 | subagentHandlers.ts:93-191 直写 agents + 父工具卡 | 与上一条**同一数据的两个写入方**（per-run 面 + 全局兜底面），靠 _liveParentRuns 集合防双写（dataPlaneRouter.ts:211-242） |
| OverviewCard（markLocalTool）→ 消息工具卡 | useOverviewState.ts:154-169 全表扫描 sessions 置标 | 组件 A 改全表任意会话的工具卡状态，无 action 边界 |
| AppBootstrap rebind → 会话域 | AppBootstrap.ts:155 直写 sessions.folder/folderOrder | 启动/变更期全表直写 |
| workspaceShellStore → layoutStore | shell 动作内部调 setActiveSessionId（workspaceShellStore.ts:288/302/316/321/426/572） | **设计内**（shell 编排授权），README 明示「components 不得双写」纪律 |
| sessionActions → terminalStore | 8 个散点 setActiveTerminalSession（见 1.3） | 设计内跨域副作用，但散点无集中封装 |

### 4.3 结论

跨模块耦合的核心形态是「**多个消费方通过 god store 单例隐式互写**」：同一 agents/toolCalls 数据存在 2 个独立写入方（per-run 面 + 全局兜底面）与 2 个独立消费方（ChatCard 流式、InlineAgentPanel），加上 OverviewCard 的全表置标，形成 3 写多读的隐式网格，靠纪律与 Set 判活防重，而非类型/接口隔离。

---

## ⑤ 持久化与恢复

### 5.1 zustand persist 使用情况

| Store | 键名 | partialize | 版本/迁移 |
|-------|------|-----------|-----------|
| layoutStore | `crish-layout-v1` | workspaces / sidebarCollapsed / activeWorkspaceIndex / tabModeEnabled | 无版本号字段（withPersist 默认 version=1，withPersist.ts:31-35）；无迁移函数 |
| settingsStore | `crish-settings-v1` | 仅 scheduledTasks | 同上；appSettings/providers/mcp/tokenUsage **刻意不持久化**（引擎事件权威回灌，settingsStore.ts:15-19） |
| workerStore | `crish-workers-v1` | 仅 killedWorkerIds | 同上 |
| layoutTreeStore | `crish-layout-tree-v1`（window-scoped，layoutTreeStore.ts:73-84） | tree / activeLeafId / toolColumnCollapsed | **唯一有版本迁移的 store**（migration.ts）；onRehydrateStorage 冷启动 restore 策略（layoutTreeStore.ts:497-515） |
| permissionStore | 无（刻意委托 api/permissionModes + api/commandPermissions，permissionStore.ts:11-18） | — | — |

**缺口**：3/4 个 persist store 无版本号与迁移（除 layoutTreeStore）；`crish-layout-v1` 缺 version 意味着未来结构变更无迁移钩子。

### 5.2 会话本体持久化（非 zustand）

- 主路径 **SQLite**（`api/session-persistence/sessionRustDb.ts`，19 处 localStorage 引用为容量/配额/回退管理）+ localStorage 一次性迁移（migrateFromLocalStorage.ts）。
- 订阅式落盘：`initStorePersistence`（store-persistence.ts:114-311）——store 订阅 + 350ms debounce（:144-156）+ boot 窗口空列表守卫（:137-142）+ hydrate 回灌/补正文分支（:170-293）。hydrate 竞态防护层层加固（PERSIST-01 残余闭合）。
- demo 模式不持久化（store-persistence.ts:117-119）。

### 5.3 localStorage 直读直写面统计

52 个非测试文件直接 `getItem/setItem/removeItem`（rg 计数）；代表性：sessionRustDb(19) / themeStore(19) / clientApi(12) / profileStore(11) / projectStore(10) / pricingStore(7) / CrossTabCoordinator(6) / fontStore(5) / TelemetryService(3)…

与「状态唯一性」的关系：
- **合理隔离**：usageStore（历史流水）、pricingStore（定价表）、profileStore（模型档案）、CrossTabCoordinator（跨标签选举）——职责独立，非 store 双源。
- **冲突面**：theme（D3，双键双写 + settingsStore 播种）、permission 持久化刻意外移（设计内）、chrome 微键（crish_sidebar_collapsed / crish_shell_chrome / crish_ui_size / crish_tab_mode）在 `store/minimalConfig.ts:9-14` 与 `layout-helpers/layout-core-actions.ts` **各维护一份键名常量**（键名注册表分散，无单一来源）。

---

## ⑥ 性能面

| 面 | 评估 | 证据 |
|----|------|------|
| selector 粒度（layoutStore 面） | 整体**良好**：主流为单字段 selector；侧栏用 useSyncExternalStore + sidebarSessionsEqual 引用拦截（sessionStore.ts:76-101，注释 AA-03 Q19）；App.tsx 用 join 字符串化 selector（App.tsx:78-80） | — |
| **整表订阅残留（风险点）** | 4 处直接订阅整个 `sessions` 数组：OverviewCard.tsx:47、ApprovalSection.tsx:25、useRuntimePanelData.ts:45、workspaceChromeHooks.ts:77 —— 任何消息/tool 写入（immer 新数组）都会触发这些组件整棵重渲 | — |
| streamingStore 高频面 | 订阅粒度**优**：MessageContent 单 shallow sub + 非 live 行稳定 EMPTY_STREAM_BODY（MessageContent.tsx:30-54）；thinking 与正文拆分到两个组件避免双重订阅（ChatAssistantMessageRow.tsx:124-129 注释 S4.4）；每 token 整表 byKey 展开（O(n) 键拷贝）但仅 2 订阅者 + setStreamText 相等早退（streamingStore.ts:135） | — |
| 工具 patch 面 | toolBatcher 批量 + 终态一次 commit（commitToolPatchToSession 单次 immer，helpers.ts:81-158）；commitStreamToSession 终态单次（helpers.ts:184-217） | — |
| 高频副作用 | useEngineState 轮询 4s + _setState 浅等拦截 + bgTasks 内容级归一（useEngineState.ts:54-84,113-131）；数据面刷新信号 1s 节流（taskEventHandlers.ts:202-212） | — |
| useOverviewState.markLocalTool | **全表扫描** O(sessions×messages×toolCalls) 仅为了置一个工具卡（useOverviewState.ts:154-169） | 潜在卡顿点 |
| immer 索引写陷阱 | README:130-133 已文档化 sessionsById fork 问题，消费侧有 getSessionForWrite 纪律 | 低风险 |

---

## ⑦ P0–P3 清单

### P0（架构缺陷 / 数据丢失风险）

| # | 问题 | 证据 | 建议 |
|---|------|------|------|
| P0-1 | **消息快照桥为死桥：撤回/归档/编辑等破坏性操作的数据保护静默失效**。`messageSnapshotsBridge._ops` 恒为 `null`（messageSnapshotsBridge.ts:31），`saveMessageSnapshot`（:33-39）/ `clearMessageSnapshots`（:41-43）为永真 no-op；真实实现 `MessageSnapshots`（api/MessageSnapshots.ts:146）除测试外零引用。调用点：withdrawMessage（sessionMessageActions.ts:113）、deleteSession（sessionCrudActions.ts:443）。git 追溯：注入函数 `bindMessageSnapshotsOps` 自基线（682fed69）起**从未有任何调用方**（全仓 grep 零命中），2026-08-08 knip 收敛提交 fc4b3a5a 将其删除，桥成为死桥。后果：撤回消息即永久删除，快照/撤销语义（若有 UI 接入）将静默不工作 | ① 在 bootstrapStores 注入真实 MessageSnapshots 单例并接线（恢复 save/clear 语义）；② 或按 DEAD formal 流程删除桥与调用点并提交说明；③ 修复前禁用依赖快照的 UI。注意：这是「清理死代码导致静默 no-op」的典型案例，属 knip 清理模式风险，需在删除 unused export 前检查其调用方是否为静默兜底 |

### P1（明显双源 / 耦合）

| # | 问题 | 证据 |
|---|------|------|
| P1-1 | **god store 直写面 16 处**：事件→store 写入路径三分（facade action / storeAccess / raw setState），组件与 handler 直接 immer recipe 绕过 action 层，无索引/持久化副作用保障（messageHandlers.ts:34-36 注释明示依赖手工纪律）；已在上文 ③ 列出全部 16 处 | useStreamCallbacks.ts:404/487/505/811/1061、useAgentStream.ts:134/280、messageHandlers.ts:36、subagentHandlers.ts:118/146/165、AppBootstrap.ts:155、useOverviewState.ts:154、workspaceChromeHooks.ts:319、Workspace.tsx:69、ApprovalSection.tsx:68、workspaceStore.ts:121/128 |
| P1-2 | **引擎连接态双源**：`useEngineState.engineOnline`（transport 直连）与 `errorStore.connectionStatus`（transport→ConnectionManager→EventBus 一跳）两个 React 可见投影，无交叉同步 | useEngineState.ts:171-173、ConnectionManager.ts:86-88/193-215、bootstrap-services.ts:91-110 |
| P1-3 | **同一 agents/toolCalls 数据双写双读**：per-run 面（useStreamCallbacks）与全局子代理兜底面（subagentHandlers）是两个独立写入方，靠 `_liveParentRuns` 集合防双写——判活失败即双写或丢事件 | useStreamCallbacks.ts:454-544、subagentHandlers.ts:93-191、dataPlaneRouter.ts:211-242 |
| P1-4 | **主题三处落地无运行期同步**：crish_theme 键 / crish_settings.theme 键 / settingsStore.appSettings.theme（仅启动播种） | themeStore.ts:16-18、49-60、AppBootstrap.ts:238-244、settingsStore.ts:71-74 |

### P2

| # | 问题 | 证据 |
|---|------|------|
| P2-1 | 整表 `sessions` 订阅 4 处，消息/tool 写入触发整棵重渲 | OverviewCard.tsx:47、ApprovalSection.tsx:25、useRuntimePanelData.ts:45、workspaceChromeHooks.ts:77 |
| P2-2 | 项目文件夹 rebind：全表扫描 + 直写 folderOrder，与 projectStore 双源，依赖订阅防环纪律 | AppBootstrap.ts:144-189 |
| P2-3 | terminalLines 镜像同步散点 8 处，新增会话切换路径漏调即镜像陈旧 | sessionCrudActions.ts:97/161/356/403/431/485、sessionOrderingActions.ts:78/130 |
| P2-4 | markLocalTool 全表扫描置标（潜在卡顿） | useOverviewState.ts:154-169 |
| P2-5 | 死面占位：rustCoreStore（0 调用，仍从 store/index.ts:174 导出）、layoutAnimationStore 含 TODO 无引用类型（layoutAnimationStore.ts:12-15） | rustCoreStore.ts:38-46 |
| P2-6 | tokenUsage 同事件双写两个 sink（当前值 + 历史流水） | useStreamCallbacks.ts:917-936 |
| P2-7 | dataPlane/subagent 全局路由装配单点（仅 useEngineState 持有），refcount 归零后数据面事件断流 | dataPlaneRouter.ts:29-33、useEngineState.ts:178-183 |

### P3

| # | 问题 | 证据 |
|---|------|------|
| P3-1 | terminalStore.ts 中文注释编码损坏（GBK/UTF-8 双编码乱码，违反「中文注释 UTF-8 无 BOM」约定；代码 ASCII 可编译） | terminalStore.ts:1-14（实读显示 mojibake） |
| P3-2 | chrome localStorage 键名注册表分散：minimalConfig.ts:9-14 与 layout-helpers/layout-core-actions.ts 各维护一份（crish_sidebar_collapsed 等） | minimalConfig.ts:9-14 |
| P3-3 | 三个 zustand persist store 无版本号/迁移钩子（仅 layoutTreeStore 有 migration.ts） | withPersist.ts:31-35、layoutTreeStore.ts |
| P3-4 | workspaceStore facade 内 setGroupActiveCard / focusExistingPanelCard 用 setState recipe 而非 action（facade 层绕行） | workspaceStore.ts:121-145 |
| P3-5 | EventBus 键为裸 string（类型表外事件静默丢弃，runControlClient.ts:181 注释自述） | EventBus.ts:11-96、runControlClient.ts:181 |

---

## 附：审计方法备注

- 所有引用均为实读证据（路径:行号）；git 追溯使用 `git log -S bindMessageSnapshotsOps` 与 `git show fc4b3a5a` 确认死桥成因。
- 未运行任何测试/构建；本审计为只读分析。
- 本文件为 `docs/frontend-audit/10-analysis/` 系列的第 03 份（状态管理专题）。
