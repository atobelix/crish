# T-E 状态治理轨道 · 详细执行计划（05-state-governance-detail）

> 派生子 Agent 产出：`docs/frontend-audit/40-final-plan/10-details/05-state-governance-detail.md`
> 输入：`00-master-plan.md`（批次 5 / R-03 / R-06）、`20-proposals/03-state-management-proposal.md`（步骤②-⑤）、`30-reviews/01~03`、阶段 6 评审 `30-reviews/01-batch-structure-review.md` / `02-detail-technical-review.md`（含 ③-P0-1）、`10-analysis/03-state-management-audit.md`（D1-D10、raw setState 口径以 §0 实读修正 18 处为准）
> 性质：只读 + 本计划文档；全部结论经 2026-08-09 工作区实读复核（行号为**当前工作区实测**，执行时语义定位优先，参考 03-评审「行号普遍偏大 3%~8%」的漂移纪律）
> 版本：v2（v1 修订：吸收阶段 6 评审 C-10 与承办分工定案，见「修订日志」；不改变 00 批次边界与串行纪律）

---

## 0. 执行范围与前置

本轨道承接 00 批次 5 之 5.3（03-②③）与 5.4（03-④⑤ + R-03），即 03 方案的**步骤 2~5**。步骤 1（快照桥接线，P0-1）属批次 1 T-A，不在本轨道；但 R-10 的脏状态处置属批次 0 前置，本轨道**开工前必须 git status 干净**。

**实读修正声明（诚实边界）**：

1. **raw setState 实测为 18 处而非审计/方案的 16 处**：审计 §3.1 表格逐行实读，`useStreamCallbacks.ts`（404/487/505/811/1061）×5、`useAgentStream.ts`（134/280）×2、`messageHandlers.ts`（36）×1、`subagentHandlers.ts`（118/146/165）×3、`AppBootstrap.ts`（155）×1、`useOverviewState.ts`（154）×1、`workspaceChromeHooks.ts`（319）×1、`Workspace.tsx`（69）×1、`ApprovalSection.tsx`（68）×1、`workspaceStore.ts`（121/130）×2，合计 **18 个 `*Store.setState` 调用点**。审计按「行」计为 16（workspaceStore 两行合一、或未计入其一），本计划以 18 处清单为准（③ 节），门禁脚本按调用点数计数。
2. **03 方案步骤 3 完成判据「事件相关 10 处（useStreamCallbacks 5 + useAgentStream 2 + messageHandlers 1 + subagentHandlers 3）」自算为 11**：本计划以 11 处为准（③ 节 A 组）。
3. **D3 主题的「引擎事件权威回灌」链路当前不成立**：实读 `clientApi.saveSettingsEx`（clientApi.ts:737-754）写的是 localStorage `crish_settings`，`commandMap.ts` 无 `core_settings*` 命令——「设置页 → 引擎命令 → 事件回灌」的权威回灌**尚未存在**（与 03 方案风险 2 一致）。本计划按 03 的两段式收敛执行，并登记显式依赖：04 批次 1 断链修复后链路自动完整。
4. **组件直引 `store/` 实测 78 个非测试文件**（rg 实测，2026-08-09 工作区；审计 02 计数 58 为当时口径）。门禁基线以 grep 实测为准（04-步骤 3 同纪律）。
5. **`bootstrap-services.ts:81` 之外 `:116` 存在同类空 catch**（WindowResizeBridge），03-评审 P0-3 已裁决 03-D2 独占 :81/**116** 两处，05 清单以 grep 实测剔除。

---

## 修订日志

| 版本 | 日期 | 修订要点 |
|---|---|---|
| v1 → v2 | 2026-08-09 | 吸收阶段 6 评审（`02-detail-technical-review.md` ③-P0-1）与主控裁决：**C-10**——D2 连接态消费方清单补齐 **LiveTasksSection / BgTasksSection / PlansSection**（engineOnline 经 RuntimePanel props 下传 :156/:163/:191，三组件各自声明 prop 并用于空态文案）——同步更新 ① 裁决表 D2、①-1 子任务 2、6.2 提交 B 文件面、⑥ 6.1 D2 验收判据（grep engineOnline 零命中的生产文件面补全为 5 个文件 + 测试面）；**交叉核对**：R-06（bootstrap-services:81 归 03）与 §⑤ 已有口径一致（无改动）；store 迁移承办分工显式化——**02 承办（02-A2 消费点迁移）、03/本轨道只做门禁**（§4.3，消除 B-P0-2 所指互等表述）；themeStore 串行登记对称性补声明（02 评审 ③-P1-3/P2-5，见 ①-3 段一-5） |

---

## ① 双源裁决表（D1-D10：裁决 / 文件 / 任务）

> 优先级（03 方案步骤 2）：实质缺陷面（D2/D3/D5/D10）优先 → 死面（D8）顺手 → 设计内项（D1/D6/D7/D9）只加锁不重构。
> 行号为 2026-08-09 工作区实测；「产出」即步骤 3/4 的承载面（只增补不重构）。

| # | 数据 | 真源裁决 | 保留/合并/删除 | 涉及文件（实测行号） | 任务 |
|---|------|----------|----------------|----------------------|------|
| D1 | 消息正文（流式期） | streamingStore（流式期）+ sessionStore（终态） | **保留**（设计内缓冲） | `store/streamingStore.ts`（applyStreamTextToMessage 分叉兜底 :423-464，早退 :132-147） | 不重构。补回归用例锁 merge 兜底分支（分叉分支 :445-448）：①流式期正文读 streamingStore；②收口 commit 后读 sessionStore；③分叉兜底（既有 streamingStore 旧值时合并）断言。无代码改动 |
| D2 | 引擎连接态 | `errorStore.connectionStatus`（transport → ConnectionManager.handleStatusChange → eventBus `engine:connection:change` → bootstrap-services:91-110 → ErrorStore.setConnectionStatus，链路完整含重连/失败语义） | **合并**（单真源） | `hooks/useEngineState.ts`（engineOnline 写点 :147/:170-173）、`services/ErrorStore.ts`（:191-198 投影 / :111 分类）、`bootstrap-services.ts`（:81/:116 空 catch）、`components/workspace/RuntimePanel.tsx`（:51/:97-105/:156/:163/:191——engineOnline 经 props 下传三 Section，**C-10 补齐**）、`components/workspace/LiveTasksSection.tsx`（prop 声明 :18/:25，空态文案 :42 emptyLiveTasksHint）、`components/workspace/BgTasksSection.tsx`（prop 声明 :27/:34，:75 emptyBgTasksHint；测试面 BgTasksSection.test.tsx:62-92 同迁）、`components/workspace/PlansSection.tsx`（prop 声明 :18/:26，:52 emptyPlansHint）、`components/overview/OverviewCard.tsx`（:48）、`runtimePanelLib.ts`（formatEngineStatus*） | **见 ①-1 子任务（含 R-06）** |
| D3 | 主题 theme | `settingsStore.appSettings.theme`（收敛后真源；当前引擎回灌链路缺失见 §0-3） | **合并**（单真源，两段式） | `api/themeStore.ts`（persistTheme :49-65 双键写 / applyTheme :71-91 / setTheme :823-829）、`store/settingsStore.ts`（setAppSettings :71-74）、`app/AppBootstrap.ts`（启动播种 :238-244）、`components/settings/SettingsAppearanceTab.tsx`（save 双写 :182-209，setTheme 调用 :191-192/:433-434） | **见 ①-3 子任务** |
| D4 | tokenUsage | settingsStore.tokenUsage（当前值）+ usageStore（历史流水） | **保留双 sink**（口径不同）+ 写点收敛 | `hooks/chat-stream/useStreamCallbacks.ts`（:917-924 与 :925-936 并列双写；:957-961 与 :963-970 兜底双写）、`api/store-access/telemetryAccess.ts`（accumulateTokenUsage :152）、`api/usageStore.ts`（recordUsageDelta :131） | accumulateTokenUsage 内单点完成 recordUsageDelta 委托（动态 import usageStore，失败仍静默）。useStreamCallbacks 删 :925-936 与 :962-973 两个并行块（保留 F5 P2 串行化增量注释与 delta 计算）。两处兜底路径（:957-961 估算）同样走单点。单测锁：同事件双写无丢失 |
| D5 | 项目/文件夹归属 | projectStore（真源）+ sessions.folder/folderOrder 镜像 | **保留镜像** + 收敛写入 | `app/AppBootstrap.ts`（:144-199：动态 import :147、rememberProjectFolderAlias :154、直写 recipe :155-168、双 rAF :178-182、自订阅 layoutStore :184-190、crish-project-changed :192）、`api/projectStore.ts`（listProjects / rebindSessionFoldersToProjects / rememberProjectFolderAlias） | 新 action `rebindSessionFolders(projects)`：store 内实现原 recipe 语义（folderOrder 维护），增量 rebind（按变更 sessionId 集合，避免 O(sessions×projects) 全表扫描）。触发点收为「启动一次 + crish-project-changed 事件」两处；**删除对 layoutStore 自身的订阅**（消除 prevSessions 引用比较防环纪律，AppBootstrap.ts:184-190 整体删除）。AppBootstrap.ts:155 直写交步骤 4 清零 |
| D6 | sessionsById vs sessions[] | 同一 store 双投影 | **保留**（设计内索引） | `store/sessionIndex.ts`（getSessionForWrite / rebindSessionById）、`store/autoIndexMiddleware.ts`、`store/sessionIndex.test.ts`（既有） | 不重构。回归用例沿用 checkSessionsIndex 断言（既有测试已覆盖，步骤 2 完成后全量跑一次确认）。README:130-133 的 immer fork 陷阱文档已存在，不动 |
| D7 | terminalLines vs terminalBySession | terminalStore 内镜像 | **保留镜像** + 散点收敛 | 8 散点：`store/sessionCrudActions.ts`（:97/:161/:356/:403/:431/:485）、`store/sessionOrderingActions.ts`（:78/:130）、`store/terminalStore.ts`（setActiveTerminalSession :76-100；头注释 GBK 乱码 P3-1 顺带登记） | 新 helper `syncActiveTerminalSession(sessionId)`（建议落 `store/sessionSharedHelpers.ts` 或独立 `store/terminalSync.ts`），8 散点全部改走 helper；helper 内做「与当前 active 相同则跳过」幂等。单测锁「会话 CRUD/排序动作必同步镜像」 |
| D8 | rustCoreStore.status | 死面 | **删除**（DEAD formal） | `store/rustCoreStore.ts`（整文件 84 行，自述 deprecated :38-46）、`store/index.ts`（:174-179 导出组） | 删文件 + 删 barrel 导出组 + 全仓 grep 清点。**已实读确认**：`api/rustCore` 仍有活消费（markdownRenderAsync.ts、workers/api-adapters.ts、test-setup.test.ts:265-290 均 import `./api/rustCore` 而非 store），只删 store 包装，api/rustCore 保留。删除后跑既有 store 门禁（check-no-as-any-store.mjs 的 barrel 检查）确认不误伤 |
| D9 | activeSessionId vs shell openTabs | 设计内单一手势 | **保留**（纪律型） | `store/storeOwnership.ts`（SHELL_TAB_OWNERSHIP :69-73） | 注释强化：「本约束为设计内单一手势（shell 编排授权，workspaceShellStore 动作内部调 setActiveSessionId），组件不得双写」；**不引入运行时守卫**（成本高收益低，维持 03 方案裁定）。无代码断言 |
| D10 | open-tabs 持久化 | workspaceShellStore（内存） | **收敛**（运行期双写消除或收敛） | legacy map 写方：`store/workspace-shell/workspaceShellStore.ts`（openSessionTab :297-301、moveSessionTab :379、closeSessionTab :390-394/:457）、`components/workspace/workspaceChromeHooks.ts`（:102/:185 best-effort 同步）；迁移读方：`app/hydrateWorkspaceShell.ts`（:96-136）；map 模块：`api/workspaceChromeTabs.ts` | **执行期验证结论（本计划预判）：legacy map 仍有运行期消费方**（workspaceChromeHooks :102/:185 在 shell store 之外直写 map；hydrate 启动一次性迁移）。走 03 方案「有消费方」分支：**双写抽为单一 helper**（`api/workspaceChromeTabs.ts` 已是单一模块——实际散点是调用方未收敛，抽 `syncOpenTabsToLegacy()` 类 helper 供 shell store 与 chrome hooks 共用），**登记待清理**（README 备注 + storeOwnership 注释），不删除运行期双写路径（删除会破坏跨窗口/重启标签恢复）。验收：运行期写路径 grep 归零或登记在案 |

### ①-1 D2 子任务（含 R-06 归并，实质缺陷修复）

1. **useEngineState 去 engineOnline 化**（`hooks/useEngineState.ts`）：
   - 删除 `engineOnline` 字段（:33/:100）与全部写点（:147 `_tick` 内、:170/:172 transport.onStatus 回调）。
   - **模块其余能力全部保留**：activeRuns/pendingApprovals/bgTasks/workflows 的 4s 轮询（:133-155）、`_setState` 浅等防护（:113-131）、**dataPlaneRouter/subagentPlaneRouter 的 refcount 装配（:178-183 不得动**——P2-7 单点装配风险与 D2 无关）、`onDataPlaneRefresh`（:186-188）。`_setState` 浅等比较同步去掉 engineOnline 项。
   - 唯一保留的 transport 订阅？**transport.onStatus 不再需要**（连接态由 ErrorStore 链承接）：删除 `_unsubState` 的 transport.onStatus 接线（:171-173/:199-202），首订/归零 refcount 逻辑（:88-94/:219-233）不动。
   - **新增连接态投影**：`useEngineState` 输出 `engineOnline` 的替代——在 RuntimePanel/OverviewCard 处新增 `useConnectionStatus()`（`useSyncExternalStore(errorStore.subscribe, ...)`，ErrorStore.ts:223-228 已有订阅接口），**或**在 useEngineState 内以投影字段暴露（二选一，推荐前者：useEngineState 与 errorStore 无依赖，避免模块单例再挂一跳；组件侧消费 `errorStore.getState().connectionStatus`）。
2. **消费组件迁移**（RuntimePanel.tsx / OverviewCard.tsx / LiveTasksSection.tsx / BgTasksSection.tsx / PlansSection.tsx——**C-10 补齐三 Section**）：
   - `ds.engineOnline` → `connectionStatus` 投影（connected → 在线；reconnecting/waiting → 重连/等待中文案由 `runtimePanelLib.ts` 的 formatEngineStatus* 承载，函数签名由 boolean 改为 ConnectionStatus 或保持布尔投影）。
   - **RuntimePanel 不再向下传 `engineOnline` prop**：删除 :156（LiveTasksSection）/:163（BgTasksSection）/:191（PlansSection）三处下传；三 Section 删除 prop 声明与解构（LiveTasksSection.tsx:18/:25、BgTasksSection.tsx:27/:34、PlansSection.tsx:18/:26），**空态文案按 connectionStatus 投影迁移**（emptyLiveTasksHint :42 / emptyBgTasksHint :75 / emptyPlansHint :52——与 runtimePanelLib 的 formatEngineStatus* 同款语义，离线仍显示「离线」空态提示，不因投影缺失漏判）；BgTasksSection.test.tsx:62-92 的 engineOnline prop 用例同步移除。
   - `ds.loading` / activeRuns 等仍走 useEngineState（不迁移）。
   - 行为等价验证：连接/断开/重连三态四处 UI 一致无闪烁（EventBus 一跳延迟可接受，见 ⑦ 风险 1）。
3. **bootstrap 空 catch 显式登记（R-06 落点，05 清单剔除）**：`bootstrap-services.ts:81` 改：
   ```ts
   connectionManager.connect().catch((err) => {
     errorStore.push({
       code: 'ENGINE_CONNECT_FAILED',
       module: 'bootstrap-services',
       severity: 'warning',
       message: '引擎连接失败',
       technical: err instanceof Error ? err.message : String(err),
       autoResolve: true,   // 连接成功后 resolveByCode('ENGINE_CONNECT_FAILED')
     });
   });
   ```
   （ErrorStore.push 内部已跑 classifyError :111，无需手工调；autoResolve + 连接成功路径 `resolveByCode` 在 :91-110 的 ready 分支补一行。）`:116` WindowResizeBridge 同类处理（code `RESIZE_BRIDGE_CONNECT_FAILED` 或按 05 分级判定的 swallow-ok 语义，二选一由 05 收口时对齐；03-D2 先改）。
4. **连接态显示语义对齐**：ConnectionManager 的 failed/recovering 重试循环（ConnectionManager.ts:86-88/193-215，connect 内部重试 + eventBus 广播 phase）→ bootstrap 映射（:94-108）→ ErrorStore 四态。**本收敛后「recovering」不再折叠成离线**——RuntimePanel 显示「重连中」而非「离线」，这是 R-06/03-D2 的预期行为收益，列入验收断言。

### ①-3 D3 子任务（主题收敛，两段式）

**段一（本轨道，不依赖 04）——前端单真源 + 订阅投影**：

1. **settingsStore 主题订阅投影**：新增 `store/themeProjection.ts`（或挂 settingsStore 模块级）——`useSettingsStore.subscribe` 监听 `appSettings.theme` 变化 → `applyTheme(t)`（DOM）+ `persistTheme(t)`（crish_theme 单一写端）。AppBootstrap.ts:238-244 的启动播种逻辑（applyTheme + persistTheme）**抽为该投影的首次执行**（bootstrapStores 或 AppBootstrap 启动调一次），删除双写。
2. **crish_theme 单一写端**：全仓 grep `persistTheme` 调用点收为「themeProjection 内唯一」。`themeStore.setTheme`（:823-829，persist + dispatch crish-theme-changed）保留为**写端入口函数**（投影内部调用），设置页不再直接调。
3. **设置页收敛**：SettingsAppearanceTab.save()（:182-209）删除 `setTheme` 直接调用（:191-193），只保留 `saveSettingsEx`（写 crish_settings）+ `setAppSettings(merged)`（写 settingsStore）→ 订阅投影自动完成 DOM + crish_theme 同步；:433-434 的「重置为默认主题」同样改走 save 路径。
4. **依赖登记**：段二 = 04 批次 1 断链命令修复后，「saveSettingsEx → 引擎命令 → 事件回灌 settingsStore」链路自动完整（04 是否已有引擎设置命令面未实读确认，登记为交叉依赖，见 ⑦ 风险 2）。
5. **同文件串行声明（02 评审 ③-P1-3/P2-5 对称性补齐）**：`themeStore.ts` 与 02 轨道（T-B 批次 2 的 S1-注入段，02-detail §0 C11 声明）同文件——02 先动 applyTheme 注入段（:706-742/:773-795）、本轨道提交 C 只动 persistTheme/setTheme 与调用面，批次错开（批次 2 → 批次 5）成立，两侧声明对称。

**行为变更验收**：切换即时生效 + 刷新保持（crish_theme 键仍最先读）；`crish_theme` 写端 grep = 1 处。

### ①-4 D5 子任务（rebindSessionFolders action）

1. 新 action `rebindSessionFolders(projects: ProjectEntry[])`（落 `store/sessionActions.ts` 或独立 `store/sessionFolderActions.ts`，经 layoutStore 切片接线）：内部实现 AppBootstrap.ts:155-168 recipe 语义（rebindSessionFoldersToProjects + folderOrder 去重追加）+ 增量优化（入参可选 `changedSessionIds?: string[]`，仅处理变更集合；首启全量）。
2. AppBootstrap rebind 重构（:144-199）：动态 import 保留（防 init 环）；`rememberProjectFolderAlias` 循环保留；直写 recipe 换为 `compositionRoot.layout.rebindSessionFolders(projects)`；**删除自订阅块 :184-190**；触发点 = 启动双 rAF（:178-182 保留）+ crish-project-changed（:192 保留）。
3. 测试：action 单测（folder/folderOrder 一致性；增量 rebind 只动变更集合）；AppBootstrap 测试改断言「无 layoutStore 自订阅」（grep `AppBootstrap` 无 `useLayoutStore.subscribe`）。

---

## ② 事件写入收敛（03 步骤 3：三路 → 单一收敛路径）

### 2.1 目标通道（写入 README 并挂门禁）

```
事件 handler（api/chat-bridge/handlers/*）
  → env.callbacks（handlerEnv.ts:16-25）
  → hooks（useStreamCallbacks / useAgentStream）或全局面（subagentHandlers Global*）
  → layoutStore action（跨域经 api/storeAccess 编排；命令热路径经 compositionRoot.layout.getState()）
  → 写 store（immer + getSessionForWrite/rebindSessionById 索引保障内建）
```

**规则**：生产代码 `*Store.setState` 零残留（步骤 4 门禁强制）；数据面子面（taskEventHandlers，轮询快照 = 真源）**不落 store 不迁移**（维持现状）。

### 2.2 需补全的 action 承载面（新 action 清单，全部落 store 切片，经 barrel 导出）

> 现状缺口根因（OPT-H4 注释误导性已由 03 评审⑤-5 定案）：LayoutFacade 无 setState + layoutStore 58 个 action 未覆盖写入面。**补 action 而非给 facade 加 setState**。

| 新 action | 签名 | 承载的 raw 写点（18 处清单编号） | 实现要点 |
|-----------|------|----------------------------------|----------|
| `setEngineLastRunId` | `(sessionId, runId)` | U1（useStreamCallbacks:404） | 经 getSessionForWrite 写 sessionsById[].engineLastRunId + rebindSessionById |
| `patchSessionAgentMessage` | `(sessionId, agentId, messageId, patch)` | U2（useStreamCallbacks:487）、A1（useAgentStream:134）、S2（subagentHandlers:146） | 找 agent 内 message 按 patch 应用（applySubagentEventToMessages 由调用方算好结果传入或 action 内复用纯函数） |
| `patchSessionAgentToolStatus` | `(sessionId, agentId, status, summary?, endedAt?)` | U3（useStreamCallbacks:505-542）、S3（subagentHandlers:165-190） | agent 终态 patch + 时间线 processing→completed 收口 + **父工具卡终态**（status 归一 failed/stopped/completed → 工具卡 error/success，输出截断 1200 语义内建）；两个调用方（per-run 面 + 全局面）语义逐行对齐（subagentHandlers:165-190 与 useStreamCallbacks:505-542 当前为复制关系，收敛为同一 action） |
| `updateMessageTimeline` | `(sessionId, messageId)` | U4（useStreamCallbacks:811-820） | action 内调 `normalizeAssistantTimeline`（api/toolPresentation.ts 已导出），写 blocks/toolCalls；sender 非 assistant 早退语义保留 |
| `applyToolCallPatches` | `(sessionId, messageId, patches[])` | U5（useStreamCallbacks:1061-1072） | stop 批量终态（buildTerminalToolPatches 结果）；批内单次 immer |
| `setMessageCacheMetrics` | `(sessionId, messageId, metrics)` | M1（messageHandlers:36-54） | **「必须经 sessions[] canonical 写」的手工纪律内建化**：getSessionForWrite + rebindSessionById；messageId 兜底（末条 processing assistant）语义保留；metrics 为 null 不写语义保留 |
| `markToolCallLocalStatus` | `(toolCallId, status, output, scope?)` | C1（useOverviewState:154）、C2（ApprovalSection:68） | store 内实现原全表扫描语义（保行为等价）；`scope: { sessionId?/agentId?/runId? }` 命中时只扫 scope 内（P2-4 消除 O(sessions×messages×toolCalls)，同批引入避免二次动工）；调用方已知 runId 时传 scope |
| `batchRespondToApproval` | `(decisions: Array<{sessionId, messageId, toolCallId, decision}>)` | C2 的批量语义封装 | respondToApproval 单条语义保留，批量封装（批量审批 UI 用） |
| `setGroupActiveCard` / `focusExistingPanelCard` | 由 workspaceStore facade 迁入 | W1/W2（workspaceStore:121/:130） | 移到 workspaceActions 定义为真 action（facade 仅转发），facade 层自身不再出现 setState recipe（P3-4） |
| `rebindSessionFolders` | `(projects, opts?)` | B1（AppBootstrap:155） | ①-4 产出 |
| `setActiveWorkspaceIndex` | `(index)` | C3（Workspace.tsx:69） | 新 layout-core action（现无此 action，实读 workspaceActions 无该定义），clamp 语义内建 |
| `collapseToolColumnPreserve` | `(wsId)` | C4（workspaceChromeHooks:319） | workspaceActions 内新增（collapseToolColumnPreserve 逻辑自 components 迁入，现位于 layout-helpers 或组件侧，执行时 grep 定位） |
| `finalizeAgentMessages` | `(sessionId, agentId)` | A2（useAgentStream:280-299） | finalizeInFlight 语义：全部 processing→completed、running/pending 工具卡→error「已停止」 |

### 2.3 涉及文件与接线

- **handlers 面**：`api/chat-bridge/handlers/messageHandlers.ts`（M1 改调 setMessageCacheMetrics，删除直写 recipe；文件头 import layoutStore :12 改走 `store/index` barrel 的 action 入口或 storeAccess）；`api/chat-bridge/handlers/subagentHandlers.ts`（:118/:146/:165 改调对应 action；import :15 同改）。
- **hooks 面**：`hooks/chat-stream/useStreamCallbacks.ts`（U1-U5，:404/:487/:505/:811/:1061；保留 getCompositionRoot().layout.getState() 的既有 facade action 调用风格 :728/:801/:808 不动）、`hooks/useAgentStream.ts`（A1/A2，:134/:280，删 OPT-H4 注释组 :127-129/:279）。
- **store 面**：`sessionActions.ts`（签名新增）、`sessionMessageActions.ts` / `sessionAgentActions.ts`（实现）、`workspaceActions.ts`（W1/W2/C4）、layout-core actions（C3）、`store/index.ts`（barrel 导出新增 action）、`api/store-access/sessionAccess.ts`（如需编排出口）。
- **P1-3 双写方收敛**：per-run 面（useStreamCallbacks）与全局兜底面（subagentHandlers Global*）**都只调上述 agent 域 action**，不再各自写 recipe；`dataPlaneRouter.ts:211-242` 判活逻辑与 `_liveParentRuns` 集合**零改动**（防双写职责仍在路由层）。
- **README**：`store/README.md` 写入「事件写 store 唯一通道」规则 + 消费侧收紧进度表更新（:173-181 的「已收尾」宣称与 workspaceStore recipe 实情脱节问题顺带修正）。

---

## ③ raw setState 18 处清单（零残目标）

> 分组：**A 组 = 事件面 11 处**（03 步骤 3 判据口径 5+2+1+3=11，实读修正自「10 处」）；**B 组 = 组件/hook 面 5 处**（03 步骤 4）；**C 组 = store 内部 2 处**（P3-4）。

### A 组：事件面（hooks/chat-stream + useAgentStream + chat-bridge handlers）→ ② 的 action

| # | 文件:行号（实测） | 当前调用/写入内容 | 改为（action） | 归属步骤 |
|---|-------------------|-------------------|----------------|----------|
| U1 | `hooks/chat-stream/useStreamCallbacks.ts:404` | onRunMeta 写 sessionsById[].engineLastRunId | `setEngineLastRunId(sid, runId)` | 步骤 3 |
| U2 | `useStreamCallbacks.ts:487` | onSubagentEvent patch agent messages | `patchSessionAgentMessage(sid, subagentId, ..., ...)` | 步骤 3 |
| U3 | `useStreamCallbacks.ts:505` | onSubagentEnded agent 终态 + 父工具卡（:505-542） | `patchSessionAgentToolStatus` | 步骤 3 |
| U4 | `useStreamCallbacks.ts:811` | timeline 归一（blocks/toolCalls） | `updateMessageTimeline(sid, assistantMsgId)` | 步骤 3 |
| U5 | `useStreamCallbacks.ts:1061` | stop 批量工具终态 | `applyToolCallPatches(sid, cur.assistantMsgId, stopPatches)` | 步骤 3 |
| A1 | `hooks/useAgentStream.ts:134` | buildPatchAsst 消息 patch | `patchSessionAgentMessage` | 步骤 3 |
| A2 | `hooks/useAgentStream.ts:280` | finalizeInFlight 全消息收口 | `finalizeAgentMessages` | 步骤 3 |
| M1 | `api/chat-bridge/handlers/messageHandlers.ts:36` | attachCacheMetricsToStoreMessage 直写 sessions[] | `setMessageCacheMetrics` | 步骤 3 |
| S1 | `api/chat-bridge/handlers/subagentHandlers.ts:118` | 父工具卡置 running | `patchToolCallPatch(sid, parentToolCallId, {status:'running',...})`（既有 updateMessageToolCall 语义或新 action，执行时选） | 步骤 3 |
| S2 | `subagentHandlers.ts:146` | Global subagent-event patch | `patchSessionAgentMessage` | 步骤 3 |
| S3 | `subagentHandlers.ts:165` | Global subagent-ended 终态 | `patchSessionAgentToolStatus`（与 U3 同一 action，两调用方） | 步骤 3 |

### B 组：组件/hook 面（03 步骤 4 任务 1-5）

| # | 文件:行号（实测） | 当前调用/写入内容 | 改为 | 备注 |
|---|-------------------|-------------------|------|------|
| B1 | `app/AppBootstrap.ts:155` | 项目 rebind 直写 sessions.folder + folderOrder | `rebindSessionFolders(projects)`（①-4 action） | 随 D5 一并删除 :184-190 自订阅 |
| C1 | `components/overview/useOverviewState.ts:154` | markLocalTool 全表扫描置标（:154-174，与 ApprovalSection 为复制关系） | `markToolCallLocalStatus(toolCallId, status, output, scope?)` | 调用方 handleApprovalAllow（:185/:188）有 a.runId 可传 scope |
| C2 | `components/workspace/ApprovalSection.tsx:68` | markLocalTool 全表扫描置标（:68-88，复制实现）+ 批量审批（:100+） | `markToolCallLocalStatus` + `batchRespondToApproval`（批量语义封装） | 与 C1 共用同一 action |
| C3 | `components/workspace/Workspace.tsx:69` | focusThisWorkspace clamp activeWorkspaceIndex | `setActiveWorkspaceIndex(wsIndex)`（layout-core action） | :67 的 getState() 读保留 |
| C4 | `components/workspace/workspaceChromeHooks.ts:319` | collapseToolColumnPreserve 直写 workspaces | `collapseToolColumnPreserve(wsId)`（workspaceActions action） | 与 D10 的 legacy map helper 收敛同步做 |

### C 组：store 内部（P3-4，03 步骤 4 任务 6）

| # | 文件:行号（实测） | 当前 | 改为 |
|---|-------------------|------|------|
| W1 | `store/workspaceStore.ts:121` | setGroupActiveCard 在 facade 层直接 setState recipe | 移入 workspaceActions 真 action，facade 仅转发（`getWorkspaceStoreState().setGroupActiveCard(...)`） |
| W2 | `store/workspaceStore.ts:130`（函数体 :128-145） | focusExistingPanelCard facade 直写 recipe（含 expandToolColumnIfCollapsed 副作用） | 同上；**check-no-as-any-store.mjs 的 FACADE_REQUIRED 检查（:218-219 要求 setGroupActiveCard/focusExistingPanelCard 在 workspaceStore 导出）需同步更新**（改为断言「转发到 action」形态或移到 workspaceActions 检查） |

**完成判据**：全仓生产代码非白名单 `*Store.setState` = 0（18 处全清）；`npm run check:store-writes` 绿。

---

## ④ store-facade 门禁设计（R-03 归本轨道：check:store-facade）

### 4.1 裁决依据（R-03 采纳）

- 00 主计划 R-03：**门禁脚本 + CI 双接线归 03（本轨道 T-E）**；02-A2（02 方案 :107-116）**仅做消费点迁移**（78 文件 import 换道，实测口径）。
- 03-评审⑥-9 建议：03-步骤5 与 02-A2 两道近似门禁合并为一道，复用 check:ui-layer 模式，避免双脚本双口径。
- 03 方案步骤 5 的入口集合白名单制（非路径前缀黑名单）：读面 `store/storeAccess`、域 facade hook、`api/storeAccess`（编排）、`app/compositionRoot`（命令热路径）+ `store/types`（类型导入）+ 组件私有 store（S14 豁免）。

### 4.2 脚本设计（`scripts/check-store-facade.mjs`，仿 check-ui-layer.mjs 模式）

| 项 | 设计 |
|----|------|
| 命令 | `npm run check:store-facade`（根 package.json 注册，与 `check:store-types` / `check:ui-layer` 并列） |
| 扫描目录 | `apps/crish-desktop/src/components/**/*.{ts,tsx}`；排除 `*.test.*`/`*.spec.*`；排除 `components/ui/**`（ui 原子层已由 check:ui-layer 禁入 store，双门禁不重叠） |
| 检测模式 | 复用 check-ui-layer.mjs 的 import 说明符解析（相对路径 + `@/` 别名解析到 src 内绝对路径），解析后命中 `src/store/` 前缀即命中检查面 |
| **白名单（路径级）** | ① `src/store/index.ts`（barrel——facade hook 合法入口）；② `src/store/storeAccess.ts`（T11 新域读面）；③ `src/store/types.ts`（类型导入；脚本层面放行路径，类型-only 由 typecheck 把关）；④ 组件私有 store 天然豁免（flowDagStore.ts / SlashExtension 内部 store 在 components/ 下，不匹配 store/ 前缀） |
| 违规定义 | import 说明符解析落入 `src/store/**` 且不在白名单 → 违规（layoutStore / sessionStore / workspaceStore / settingsUiStore / streamingStore / terminalStore / workerStore / permissionStore / settingsStore / layout-tree/** / workspace-shell/** / layout-helpers/** / bootstrapStores / sessionIndex / session*Actions / workspaceActions / 等全部禁） |
| 基线机制 | `--baseline` 模式：首次运行输出 `components-store-direct-imports.json`（文件→import 行清单，入库）作为**计数基线**；普通模式报告「当前违规数 vs 基线数」；02-A2 迁移逐域清零后基线文件删除（或置 0），CI 接线以 0 违规为门槛 |
| 报告形态 | 违规行输出 `文件:行号 import "..." → 建议入口（barrel / storeAccess）`，可读可评审 |
| CI 接入 | `.github/workflows/ci.yml` 快层：新增 job（或并入 lint job 的 step）：`node scripts/check-store-facade.mjs`。**接线时机 = 02-A2 迁移完成（违规归零）同批提交**，避免 CI 长期红（见 4.3 交接） |

### 4.3 与 02-A2 的交接（消费点迁移触发条件）

| 阶段 | 责任方 | 内容 |
|------|--------|------|
| 1. 脚本就绪 | **本轨道（T-E）** | check-store-facade.mjs 落地 + `--baseline` 生成基线（78 文件实测） + 本地跑通（红基线可复现）+ 规则写入 `store/README.md` 消费侧收紧进度表 |
| 2. 迁移执行 | **02 承办**（02-A2 消费点迁移） | 78 文件 import 换道（纯读面 selector 替换可先行；涉及组件结构变动的迁移**显式等待 02 重构落地**，同文件串行）；每批跑 `npm run check:store-facade` 核对递减 |
| 3. 清零接线 | **本轨道（T-E）** | 违规归零 → 基线文件置 0/删除 → CI 快层接线 + README 进度表「仍可接受」列清空 → 验收断言（grep 直引 = 0 或全命中白名单） |

**承办分工（阶段 6 主控裁决，替代 B-P0-2 所指的互等表述）**：78 文件 import 换道由 **02 承办**（02-A2 消费点迁移），**本轨道（T-E，承办 03 方案）只做门禁**（check:store-facade 脚本 + 基线 + CI 接线）——双方责任定案，不再互等。**触发条件显式化**：02-A2 迁移**必须等步骤 1 的脚本与基线入库后才可开工**（脚本是迁移的度量工具）；CI 接线**必须等迁移完成**（否则提交即红）；两道门禁（check:store-facade 与 check:store-writes）在批次 5 提交 D 中同时出现。

### 4.4 与既有门禁的关系

- `check:store-types`（check-no-as-any-store.mjs）：管 store 内部类型纪律（as any / 反环 / barrel / facade 对齐），本轨道 C 组（W1/W2）改动需同步其 FACADE_REQUIRED 断言（:218-219）与 BARREL_REQUIRED（:259-264）。
- `check:ui-layer`：管 ui 原子层反向依赖，扫描面不重叠，无改动。
- `check:store-writes`（步骤 4 新增，03 方案步骤 4 门禁）：`scripts/check-no-raw-setstate.mjs`，扫描**全仓生产文件** `useLayoutStore.setState` / `useSessionStore.setState` / `useWorkspaceStore.setState` / `useSettingsUiStore.setState` / `useTerminalStore.setState` / `useSettingsStore.setState` / `useWorkerStore.setState` / `usePermissionStore.setState` 调用点；**允许面** = store 自身 action 定义文件 + `api/store-access/` + `bootstrapStores.ts` + 测试 + dev-only 分支（import.meta.env.DEV 包裹）；白名单外违规即失败。**顺带断言** `bootstrapStores.ts` 含 `bindMessageSnapshotsOps` 调用（2.6 防线 ②，防快照桥注入点再失联）。

---

## ⑤ R-06 归并（bootstrap-services.ts:81）

### 5.1 裁决定位

- 00 主计划 R-06：03-D2 与 05-步骤3 双重处理 `bootstrap-services.ts:81` → **归 03**（状态/连接）；05 删除该项。
- 03-评审 P0-3 细化：03-D2 **先行独占 :81 与 :116**（功能性修复优先），05 步骤 3 的 33 处 `.catch(() => {})` 清单执行时 grep 实测剔除这两处。

### 5.2 在 03 方案中的步骤归属

**03 方案步骤 2（双源裁决与收敛）任务 1（D2 连接态单真源化，P1-2）**——即本计划 ①-1 子任务 3。它是 D2 合并的组成部分而非独立任务：空 catch 不处理则「连接失败静默显示离线」在单真源化后依然成立（ErrorStore.ts:74-119 有 push/classifyError 能力未用）。

### 5.3 处理细节（与 03-D2 的连接态生命周期关系）

- **failed/recovering 重试循环的可视化**：ConnectionManager.connect 内部重试（bootstrap-services.ts:80 注释「fire-and-forget, retries internally」）→ phase 事件（connecting/authenticating/ready/recovering/disconnected，ConnectionManager.ts:86-88/193-215）→ eventBus → bootstrap 映射（:94-108）→ ErrorStore 四态（connected/reconnecting/waiting/disconnected）。**本收敛后 UI 能显示「重连中」而非静默离线**——连接态生命周期治理的闭环动作就是 ①-1 的全部内容（投影 + 消费迁移 + 空 catch 登记）。
- 失败登记语义：`ENGINE_CONNECT_FAILED` 错误在 ready 时 `resolveByCode` 自动关闭（autoResolve: true 同步）；severity 定 warning（重连是软失败，不打扰）。
- :116（WindowResizeBridge）为非连接态空 catch：本轨道同样改为显式登记（或按 05 分级判定为 swallow-ok——**03 先改登记，05 收口时以 grep 实测剔除，两语义兼容**，符合 30-01 C11「语义兼容由先到者承办、后者验收」）。

---

## ⑥ 验证与提交

### 6.1 验证清单（每项断言）

| 项 | 验证方式 | 断言 |
|----|----------|------|
| D1 锁 | `npx vitest run src/store/streamingStore.test.ts` | 分叉兜底分支用例绿 |
| D2 | 新增 `useConnectionStatus` 单测（mock errorStore 四态）+ RuntimePanel/OverviewCard/三 Section 投影用例；手测 | 连接/断开/重连四处 UI 一致；**engineOnline 生产文件面 grep 零命中**（useEngineState.ts + RuntimePanel.tsx + LiveTasksSection.tsx + BgTasksSection.tsx + PlansSection.tsx，含「RuntimePanel 不再下传 engineOnline prop」断言；测试面 BgTasksSection.test.tsx 同步清零）；`bootstrap-services.ts:81` 无空 catch |
| D3 | `settingsStore` 主题订阅投影单测（切换 → DOM data-theme + crish_theme 写）+ 手测 | 切换即时生效 + 刷新保持；`persistTheme` 生产调用点 grep = 1；设置页无直接 setTheme |
| D4 | `telemetryAccess.tokenUsage.test.ts` 扩展 | 同事件双写无丢失；useStreamCallbacks 无 recordUsageDelta 直调（grep 零命中于 hooks/chat-stream/） |
| D5 | `rebindSessionFolders` action 单测（folder/folderOrder 一致 + 增量）+ AppBootstrap 测试 | 无 `useLayoutStore.subscribe` 于 AppBootstrap（grep） |
| D7 | terminal 镜像同步测试（CRUD/排序后跟随） | 8 散点 grep 归零（仅 helper 一处） |
| D8 | 全仓 grep `rustCoreStore` | 零命中；typecheck 过 |
| D9 | 无代码断言 | storeOwnership 注释更新（人工评审） |
| D10 | grep legacy map 写方 | 运行期写路径归零或登记在案（本计划预判走「登记在案」分支） |
| 步骤 3 | 新增 action 单测（agent 终态 / cacheMetrics canonical 写——**写 sessionsById 会被下次索引重建覆盖的回归用例**）+ 既有 `useStreamCallbacks.streamStore.test.ts` 不破 + 子代理路径测试不破 | `hooks/chat-stream/` 与 `api/chat-bridge/handlers/` 下 `useLayoutStore.setState` 命中数 = 0 |
| 步骤 4 | 新 action 单测（markToolCallLocalStatus 行为等价 + scope 命中；batchRespondToApproval 批量）+ 既有组件测试（OverviewCard/ApprovalSection/Workspace 相关）不破 | `npm run check:store-writes` 全绿（白名单外 0 命中）；行为手测（审批/折叠/resize/停止生成） |
| 门禁 | `npm run check:store-facade -- --baseline` → 02 迁移后 `--no-baseline` 归零 | 违规数单调递减至 0；CI 快层接线后提交绿 |
| 全量 | `npm run typecheck` + `npm run test:coverage -- --project=unit`（快层 45/70/65/45）+ 中层 vitest 全量 + 5 个 markdown-editor e2e 专项（**禁止删除**） | 全绿；`cargo test` 与本轨道无交集（不涉及 Rust 面） |

### 6.2 批次 5 提交清单（T-E 域，每提交独立可回退）

| 提交 | 内容 | 文件面（错开要点） |
|------|------|--------------------|
| 提交 A（03-步骤2 低风险项） | D8 死面删除 + D9 注释 + D7 terminal helper 收敛 + layoutAnimationStore TODO 清理（:12-15/:40） | `rustCoreStore.ts`（删）、`store/index.ts`、`sessionCrudActions.ts`、`sessionOrderingActions.ts`、`sessionSharedHelpers.ts`、`storeOwnership.ts`、`layoutAnimationStore.ts` |
| 提交 B（D2 + R-06） | 连接态单真源：useEngineState 去 engineOnline + useConnectionStatus + RuntimePanel/OverviewCard/三 Section 迁移 + bootstrap :81/:116 显式登记 | `useEngineState.ts`、`bootstrap-services.ts`、`components/workspace/RuntimePanel.tsx`、`components/overview/OverviewCard.tsx`、`components/workspace/LiveTasksSection.tsx`、`components/workspace/BgTasksSection.tsx`（含 BgTasksSection.test.tsx prop 用例）、`components/workspace/PlansSection.tsx`、`runtimePanelLib.ts`、新增 `hooks/useConnectionStatus.ts`（或 errorStore 投影文件） |
| 提交 C（D3） | 主题收敛段一：settingsStore 订阅投影 + crish_theme 单一写端 + 设置页去双写 | `api/themeStore.ts`、`store/settingsStore.ts`（或新增 themeProjection.ts）、`app/AppBootstrap.ts`、`components/settings/SettingsAppearanceTab.tsx` |
| 提交 D（D4/D5/D10） | telemetry 单点 + rebindSessionFolders action（含 AppBootstrap 重构去自订阅）+ legacy map 写方 helper 收敛 | `api/store-access/telemetryAccess.ts`、`useStreamCallbacks.ts`（仅 D4 块）、`store/sessionActions.ts`（或 sessionFolderActions.ts）、`app/AppBootstrap.ts`、`api/workspaceChromeTabs.ts`、`workspaceChromeHooks.ts`（仅 :102/:185）、`store/workspace-shell/workspaceShellStore.ts` |
| 提交 E（03-步骤3 事件收敛） | 新 action 组（② 2.2 全表）+ handlers/hooks 11 处改道（U1-U5/A1-A2/M1/S1-S3）+ README 规则 | `store/sessionActions.ts`、`sessionMessageActions.ts`、`sessionAgentActions.ts`、`workspaceActions.ts`、`store/index.ts`、`api/chat-bridge/handlers/messageHandlers.ts`、`subagentHandlers.ts`、`hooks/chat-stream/useStreamCallbacks.ts`、`hooks/useAgentStream.ts`、`api/store-access/sessionAccess.ts`（如需）、`store/README.md` |
| 提交 F（03-步骤4 + 写门禁） | B 组 5 处 + C 组 2 处 + `scripts/check-no-raw-setstate.mjs` + package.json `check:store-writes` + CI 接线 | `AppBootstrap.ts`、`useOverviewState.ts`、`ApprovalSection.tsx`、`Workspace.tsx`、`workspaceChromeHooks.ts`、`store/workspaceStore.ts`、`store/workspaceActions.ts`、`scripts/check-no-raw-setstate.mjs`、`package.json`、`.github/workflows/ci.yml` |
| 提交 G（R-03 门禁 + 验收） | `scripts/check-store-facade.mjs` + 基线 + CI 接线 + README 进度表清空 + 验收断言 | `scripts/check-store-facade.mjs`、`package.json`、`.github/workflows/ci.yml`、`store/README.md`、基线 JSON（入库） |

> 串行纪律：提交 E 依赖提交 D 的 action 承载面（只增补不重构）；提交 F 依赖 E（markToolCallLocalStatus/rebindSessionFolders 等已入 store）；提交 G 依赖 02-A2 迁移完成（跨批次，**02 承办的 78 文件 import 换道、本轨道只做门禁**——阶段 6 主控裁决，见 4.3；迁移面在 components/**，与 T-E 无文件重叠，本轨道只动 store/ 与 scripts/）。

---

## ⑦ 风险

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| 1 | **D2 合并的行为变化**：engineOnline 布尔 vs connectionStatus 四态 → RuntimePanel/OverviewCard 文案变化（recovering 从「离线」变「重连中」）+ 三 Section 空态文案（emptyLiveTasksHint/emptyBgTasksHint/emptyPlansHint 的 engineOnline 判定随投影迁移，空态提示语义保持）；EventBus 链路多一跳延迟（时序上四处 UI 可能短暂不一致）；`_tick` 4s 轮询的 engineOnline 与 transport 事件源的差异消失后，activeRuns 刷新不受影响但状态点文案变了 | 中 | 投影语义映射表先定（connected→在线，reconnecting→重连中，waiting→连接中，disconnected→离线）；验收断言「四处 UI 一致」；文案变更列入行为验证清单（不视为回归） |
| 2 | **D3 两段式收敛的链路缺口**：04 断链修复前无引擎设置事件回灌（§0-3 实读确认 saveSettingsEx 仅写 localStorage），「引擎事件权威回灌」暂为「settingsStore 写入即真源」；若未来事件回灌实现，需防回灌覆盖与前端写入竞态 | 中 | 段一收敛完成后 settingsStore 是唯一写入口（设置页 save 与回灌都经 setAppSettings）；README 登记两段式状态；04 批次 1 后验证回灌不丢字段 |
| 3 | **步骤 3 改 11 处写路径的回归面**：流式 token/thinking/tool/终态、子代理（per-run + 全局兜底双写入方）、cacheMetrics、stop 批量——幂等语义与时序重组风险 | 高 | 新增 action 语义与原 recipe 逐行等价（对照表评审物）；EventRouter 去重与 `_liveParentRuns` 判活零改动；流式/子代理路径行为验证 + 既有测试不破（useStreamCallbacks.streamStore.test.ts、subagentHandlers.test.ts）；撤回/审批全流程手测 |
| 4 | **markToolCallLocalStatus scope 化**：调用方（useOverviewState/ApprovalSection）仅知 toolCallId，scope 需从 a.runId 投影——传错 scope 会漏标 | 中 | 默认不传 scope 时行为与原全表扫描等价（保底）；scope 仅在调用方确知 runId 时传（handleApprovalAllow 有 a.runId）；单测覆盖「scope 命中」与「无 scope 全表」两路径 |
| 5 | **门禁误伤**：components 合法使用 barrel facade hook 会匹配「store/ 直引」模式；store/index barrel 放行后无法路径级阻断其内部符号 | 中 | 白名单制（非黑名单）；barrel 符号级由 typecheck/评审把关（README 明示 barrel 内仅 facade hook/action 合法）；本地先跑通再进 CI（03 风险 5 同款缓解） |
| 6 | **与 02/05 的文件冲突**：提交 B 动 RuntimePanel/OverviewCard（02 组件域）、提交 E 动 workspaceChromeHooks（02-A2 迁移面 components/** 高重叠）、bootstrap-services:81/116 与 05 清单重叠（R-06 已裁决） | 中 | 同文件串行（AGENTS.md 派单规则）；本轨道文件面集中在 store/ + hooks/ + handlers/，components/** 仅 6 个文件（B1/C1-C4/W 组之外）；05 步骤 3 以 grep 实测剔除 :81/:116 |
| 7 | **D10 收敛分支依赖执行期验证**：若迁移面演进（hydrate 路径删除）导致 legacy map 消费方消失，走「删除双写」分支 | 低 | 双出口判据已给（grep 消费方）；本计划预判「有消费方」分支（实读 :102/:185 存在），执行时以 grep 实测复核 |
| 8 | **W1/W2 迁移破坏既有门禁**：check-no-as-any-store.mjs FACADE_REQUIRED（:218-219）断言 setGroupActiveCard/focusExistingPanelCard 在 workspaceStore 导出 | 低 | 与 C 组同提交更新脚本断言（facade 保留转发导出签名不变，断言形态同步） |
| 9 | **行号漂移**：本计划行号为 2026-08-09 实测，执行 Agent 开工时仓库可能继续演进（03-评审 P0 面实测「行号普遍偏大 3%~8%」） | 低 | 语义定位优先（按函数名/注释锚点 grep 定位，不以行号硬抄）；开工前 git status 确认工作区干净（R-10 脏状态已处理） |
| 10 | **18 处 vs 16 处口径差**：审计/方案按 16 处验收，本计划实测 18 处——若验收方按 16 对账会误判 | 低 | 本计划③ 表为唯一验收清单（18 处逐项）；门禁以调用点计数（18→0），README 备注口径修正 |

---

## 附：与上游文档的对账

| 上游条目 | 本计划落点 |
|----------|-----------|
| 00 批次 5.3（03-②③） | ① 全部 + ②（提交 A-E） |
| 00 批次 5.4（03-④⑤ + R-03） | ③ + ④ + 提交 F/G |
| 00 R-03（check:store-facade 归 03） | ④（脚本 + CI 双接线归本轨道；02-A2 仅迁移，触发条件见 4.3） |
| 00 R-06（bootstrap-services.ts:81 归 03） | ⑤（落点 = 步骤 2-D2 子任务，即①-1-3） |
| 03 方案步骤 2 完成判据 | ① 各子任务验收行（裁决表全部落地；engineOnline 零消费方；AppBootstrap 无自订阅；rustCoreStore grep 零命中） |
| 03 方案步骤 3 完成判据 | ② + ③ A 组（11 处）；README 规则写入 |
| 03 方案步骤 4 完成判据 | ③ B/C 组（7 处）+ check:store-writes 进 CI |
| 03 方案步骤 5 完成判据 | ④（components 直引归零或白名单内；CI 接线；README 进度表清空） |
| 30-01 C15（P2-1 整表订阅落点） | ③ 表 C1/C2（markToolCallLocalStatus 收敛时 ApprovalSection 的整表 sessions 订阅顺带按需收窄——**登记为顺带项**，主断言「4 处整表订阅 grep 归零」随本轨道相关文件同步核对） |
| 30-03 批 7（03-步骤3/4 依赖批 1 产物） | 本轨道提交 D/E 依赖 T-A 批次 1 的 store action 基线（rebindSessionFolders 等），与 00 批次顺序一致 |
| 02 评审 ③-P0-1（D2 消费方清单缺口） | ①-1-2 + 提交 B + ⑥ 6.1 D2 验收（**C-10**，v2 补齐 LiveTasksSection/BgTasksSection/PlansSection 文件面与 grep 零命中断言） |
| 01 评审 B-P0-2 + 主控裁决（02-A2 承办） | ④ 4.3（**02 承办迁移、03/本轨道只做门禁**，互等表述消除） |

---

（T-E 状态治理详细计划 v2 完——待主控派单；未决点：① useConnectionStatus 独立 hook——01 评审 附④ 执行期小决策已定（推荐独立，避免 useEngineState 再挂一跳），执行按此；② S1 父工具卡 patch 复用 updateMessageToolCall 还是新建 patchToolCallPatch（执行时按既有 action 语义选）；③ :116 的 05/03 语义收口（05 验收）。）
