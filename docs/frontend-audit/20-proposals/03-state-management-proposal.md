# 【状态管理】修复方案（frontend-audit 20-proposals / 03）

- 提案日期：2026-08-09
- 依据：`docs/frontend-audit/10-analysis/03-state-management-audit.md`（P0×1 / P1×4）+ `docs/frontend-audit/00-cross-analysis.md`（P0-1 快照桥为全前端最高优先级功能缺陷）
- 性质：只读 + 方案文档。所有结论均经实读代码复核（证据以 `文件:行号` 给出）。
- 与 02 组件方案的衔接：见「③ 步骤 5」与「⑥ 风险」——组件直引 store 的治理依赖组件重构，本方案只定义访问边界规则与依赖顺序，不重复 02 的组件设计。

---

## ① 目标态

| 维度 | 现状（审计证据） | 目标态 |
|------|------------------|--------|
| 事件→store 写入 | 三路分裂：facade action / storeAccess 编排 / raw setState recipe（16 处，审计 §3.1） | **单一收敛路径**：事件 handler → env.callbacks → layoutStore action（跨域经 `api/storeAccess` 编排）→ 写 store。生产代码 `*Store.setState` 零残留 |
| store 访问 | 组件 45 处 `useLayoutStore(selector)` + 58 个组件直引 `store/`（02 审计 :149）、api 层直 import layoutStore（messageHandlers.ts:12、subagentHandlers.ts:15） | **统一走 facade**：组件读面仅经 `store/storeAccess`（T11 新域读面）/ 域 facade hook / `api/storeAccess`（编排）/ `app/compositionRoot`（命令热路径） |
| 双源 | 10 项（D1–D10），实质缺陷面 4 项（D2 连接态 / D3 主题 / D5 项目 folder / D10 open-tabs）+ 死面 2 项（D8 rustCoreStore / D4 双写点） | 逐项裁决落地：真源唯一、镜像显式化并收敛写入、死面删除（裁决表见 ④） |
| 快照桥 | `messageSnapshotsBridge._ops` 恒 null，save/clear 永真 no-op（P0-1） | **接线恢复**：注入真实 `MessageSnapshots` 单例，save/clear 语义生效，并有可见性与单测锁防静默失效再犯（决策见 ②） |
| 订阅性能 | 整表 `sessions` 订阅 4 处（OverviewCard.tsx:47、ApprovalSection.tsx:25、useRuntimePanelData.ts:45、workspaceChromeHooks.ts:77） | 随 ②③④ 步收敛为按 id/域 selector（P2-1 顺带闭合） |
| 门禁 | 行数门禁 44 违规未接 CI；ui-layer 门禁不覆盖 store 直引（00 根因 D） | 新增「raw setState 清零」与「组件禁直引 store」两道脚本门禁，接 CI 快层 |

**架构目标一句话**：god store（layoutStore）暂不拆分（READMME「Current truth: sessions 仍住 layoutStore，本波不拆」），但在不拆实例的前提下把「写路径」与「读边界」收成单一通道——拆分留给 multi-store 路线（README:211-215），本方案不触碰实例结构，只收敛访问纪律。

---

## ② 快照桥决策与方案（P0-1）

### 2.1 决策：接线恢复（Option A）

**结论先行：选择「接线恢复」——在 bootstrapStores 注入真实 `MessageSnapshots` 单例，恢复 save/clear 语义；同时把「restore 侧未接线」显式登记为已知缺口，并加可见性守卫防止再犯静默失效。**

### 2.2 决策依据（实读复核）

| 事实 | 证据 | 对本决策的意义 |
|------|------|----------------|
| 桥的注入函数已被删，当前文件**连可注入的缝隙都不存在**（`const _ops: MessageSnapshotsOps \| null = null` 且无任何 setter 导出） | messageSnapshotsBridge.ts:31-43 | 恢复接线需先补回 `bindMessageSnapshotsOps`（或等价注入函数） |
| 保存侧调用点语义完整：withdrawMessage 构造了 prevMessages / prevPinned / diffFilePaths 完整载荷再调用 save | sessionMessageActions.ts:85-129 | 保存侧是「破坏性操作前数据保护」的刻意设计，行为与意图不符 = 静默失效 |
| 删除侧调用点：deleteSession 删除成功后 clear | sessionCrudActions.ts:441-444 | 清栈语义同样应真实生效 |
| 读侧（undo / peek / peekDelta / getStack）**生产代码零调用**，仅 MessageSnapshots.test.ts 使用（grep 全仓验证） | MessageSnapshots.ts:212-247；测试 :116-311 | **关键事实**：子系统当前是「只记不读」。接线后用户仍无撤销能力——接线恢复的是保存侧，restore UI 不在本方案范围 |
| 真实实现完整且有测试资产：diff/applyDelta/容量淘汰/栈深限制全部实现，`MessageSnapshots.test.ts` 21 组用例 | MessageSnapshots.ts:36-286 | 退役需删「桥 + 2 调用点 + 类 + 21 组测试」，成本高于接线（接线约 15 行） |
| 快照为纯内存态，不持久化（栈/容量在 Map 中，无落盘） | MessageSnapshots.ts:147-148 | 保护窗口仅限同会话；接线后文档须明示此边界 |
| 快照操作类型定义含 withdraw/regenerate/archive/batch-pin/edit，仅 withdraw 有调用点 | messageSnapshotsBridge.ts:8-16 | 其余操作类型属预留，不新增调用点 |

### 2.3 理由（为何不选退役）

1. **接线成本远低于退役成本**：退役需要删桥、删 withdrawMessage 内 13 行快照载荷构造、删 deleteSession 的 clear、删类、删 21 组测试；接线只需补注入函数 + bootstrapStores 一处装配（约 15 行）。
2. **退役是「清理死代码导致静默 no-op」事故的二次伤害**：本 P0 的本质教训是 knip 清理时未检查「无调用方 export 是否为静默兜底」（审计 ⑦ 建议③ 原话）。退役删除的恰恰是数据保护意图的保存侧，若未来补「撤回可撤销」UI，需从 git 考古恢复全部。
3. **接线后行为与代码意图一致**：调用点存在且载荷完整，注入后 save/clear 真实生效——「调用点存在但 no-op」这一静默失效类被根治，而不是被消灭（消灭后连意图都不可见）。
4. **读侧缺失不构成接线障碍**：读侧（undo）本就没有任何 UI 消费方，接线后系统状态为「保护性记录已生效，恢复入口待产品决策」——这是诚实且可观测的状态；而退役后系统状态为「无此能力且无记录」，二者对未来"撤回撤销"需求的响应成本差异极大。
5. **测试资产保护**（AGENTS.md 铁律精神）：MessageSnapshots.ts 与其 21 组测试是有效资产，退役即删资产。

### 2.4 接线方案

| 任务 | 内容 | 涉及文件 |
|------|------|----------|
| 补注入函数 | bridge 增加模块级 `bindMessageSnapshotsOps(ops: MessageSnapshotsOps): void`（注入后置 `_ops`；幂等：重复注入以最后一次为准并 dev 告警）；保留现有类型导出 | `src/store/messageSnapshotsBridge.ts` |
| 装配注入 | `bootstrapStores()` 内 `initStoreAccess(...)` 旁注入 `new MessageSnapshots()` 单例（模块图稳定后，符合桥注释「bootstrapStores 在模块图稳定后注入」的原设计意图）；注入失败（构造异常）走 `logger.warn` 显式告警，**禁止空 catch** | `src/store/bootstrapStores.ts` |
| 可见性 | 注入成功后在 dev 分支记录一次 debug 日志（沿用 StoreFreq 模式：`logger.debug('[Snapshots] bridge bound', …)`）；不做 UI 展示 | `src/store/bootstrapStores.ts` |
| 单测锁 | 新增 `messageSnapshotsBridge.test.ts`：① 未注入时 save/clear 不抛错且无副作用（兼容现状的调用面）；② 注入后 save 真实入栈（断言 getStack 长度 1、delta 正确）；③ clear 清空；④ 重复注入幂等 | 新增 `src/store/messageSnapshotsBridge.test.ts` |
| 调用点 | **零改动**（withdrawMessage / deleteSession 载荷已完整，语义即接线目标） | `sessionMessageActions.ts` / `sessionCrudActions.ts` 仅读 |
| 文档 | `src/store/README.md` 增补快照桥条目：接线状态、纯内存边界（重启即失）、restore 侧未接线为已知缺口 | `src/store/README.md` |

### 2.5 退役备选（决策 B，仅当产品裁决「永不提供撤回撤销」时启用）

若用户最终裁决退役，按 DEAD formal 流程：① 删 `messageSnapshotsBridge.ts`；② 删 `sessionMessageActions.ts:113-125` 快照载荷构造与调用；③ 删 `sessionCrudActions.ts:443`；④ 删 `MessageSnapshots.ts` 与其测试；⑤ 单次提交并注明「快照子系统显式退役，P0-1 关闭方式 = 退役」；⑥ 全仓 grep 确认零引用。**本方案主路径不选此项。**

### 2.6 防静默回归（本 P0 的教训固化）

快照桥事故根因是「清理死代码 → 调用点保留但实现消失 → 静默 no-op」。接线后建立三道防线：
1. **单测锁**：bridge 注入前后行为断言（2.4 单测 ①②③④），注入点丢失即红。
2. **注入点门禁**：`scripts/check-no-raw-setstate.mjs`（③ 步骤 4 新增）顺带断言 `bootstrapStores.ts` 含 `bindMessageSnapshotsOps` 调用（防止未来清理误删注入）。
3. **装配效应测试**：`AppBootstrap.test.ts` 已有 effect 排序断言（:28-103），扩展一条「bootstrapStores 装配后桥已绑定」。

### 2.7 本步输出（下一步输入）

- P0-1 关闭，快照保存侧行为与代码意图一致；
- 产出「action 内副作用样板」：`withdrawMessage` = 一次 immer 写 + 一次副作用调用（save），作为③ 步骤 3「事件写入收敛」中 action 封装副作用的参照形态；
- 产出门禁脚本骨架约定，供步骤 4 复用。

---

## ③ 分步方案

> 执行顺序仅表示逻辑依赖（后步依赖前步产物），不写时间/人员/优先级（00 交叉分析的批次划分由主控调度）。每步独立提交、独立门禁，避免大爆炸式重构。每步的「输出」即下一步的「输入」，闭环可迭代。

### 步骤 1：快照桥接线（P0-1）

即 ② 全部内容。

- **任务**：补注入函数 → bootstrapStores 装配真实单例 → 单测锁 + 装配效应测试 → README 登记。
- **文件面**：`src/store/messageSnapshotsBridge.ts`、`src/store/bootstrapStores.ts`、`src/store/README.md`、新增 `src/store/messageSnapshotsBridge.test.ts`、`src/app/__tests__/AppBootstrap.test.ts`（扩展 1 条）。
- **验证方式**：
  - 测试断言：`npx vitest run src/store/messageSnapshotsBridge.test.ts src/store/sessionActions.test.ts src/store/layoutStore.test.ts`——桥行为四断言全绿，既有 withdraw 路径测试不破；
  - 行为验证：dev 运行撤回一条消息后，dev 日志出现 `[Snapshots] bridge bound` 且无 warn；
  - 门禁：`npm run typecheck`、`npm run check:desktop`。
- **完成判据**：
  - `bindMessageSnapshotsOps` 在 `bootstrapStores.ts` 有装配调用（grep 命中）；
  - bridge 单测注入分支全绿；
  - 全仓 grep `messageSnapshotsBridge`：仅 bridge / bootstrapStores / 两个 action / 测试命中，无其他绕行。
- **输出**：活体快照桥 + 门禁脚本约定 + 装配效应测试模式（供步骤 4 扩展门禁参考）。

### 步骤 2：双源裁决与收敛（D1–D10）

先产出 ④ 裁决表（设计物），再按表逐项落地。裁决优先级：**实质缺陷面（D2/D3/D5/D10）优先，死面（D8）顺手，设计内项（D1/D6/D7/D9）只加锁不重构。**

- **任务**：
  1. **D2 连接态单真源化（P1-2）**：真源 = `errorStore.connectionStatus`（transport → ConnectionManager.handleStatusChange → eventBus → ErrorStore 链路完整，含重连/失败语义）；`useEngineState.engineOnline` 删除或改为从 ErrorStore 投影（模块内其余字段与 4s 轮询不动）。消费组件（RuntimePanel / OverviewCard）改走 errorStore 投影。同时将 bootstrap-services.ts:81 `connect().catch(() => {})` 空 catch 改为 `ErrorStore` 显式登记（分类告警走 classifyError），消灭「连接失败静默显示离线」。
  2. **D3 主题收敛（P1-4）**：真源 = `settingsStore.appSettings.theme`（引擎事件权威回灌，settingsStore.ts:71-74）。收敛动作：设置页主题切换 → 调引擎设置命令（依赖 04 维度断链命令修复）→ 事件回灌 → `settingsStore` 订阅投影：写 DOM（AppBootstrap.ts:238-244 播种逻辑抽为订阅投影）+ 收敛写 `crish_theme` 缓存（themeStore.persistTheme 单一写端，删除设置页双写）。**依赖登记**：若 04 断链命令未修，本项先收敛前端（settingsStore 订阅 → DOM + 缓存），引擎命令修复后链路自动完整（见 ⑥ 风险 2）。
  3. **D5 项目 folder 收敛（P2-2）**：裁决 = 保留镜像（projectStore 真源 + sessions.folder 去规范化镜像，镜像删除需渲染期查询不划算）；收敛写入：AppBootstrap.ts:144-189 的直写 rebind 抽为 store action `rebindSessionFolders`（内含 folderOrder 维护），触发点收为「启动一次 + crish-project-changed 事件」，**删除对 layoutStore 自身的订阅**（消除 prevSessions 引用比较防环纪律依赖）；增量 rebind 优化（按变更 sessionId 集合，不做 O(sessions×projects) 全表扫描）同步骤落地。
  4. **D7 terminal 镜像散点收敛（P2-3）**：8 处 `setActiveTerminalSession` 调用收敛为 session actions 内统一 helper `syncActiveTerminalSession(sessionId)`（terminalStore 侧不动），CRUD/排序/流式路径全部经 helper；补单测锁「会话切换动作必同步镜像」。
  5. **D8 死面删除（P2-5 部分）**：删 `rustCoreStore.ts` + `store/index.ts:174`（及 :179 附近同文件导出组）+ 全仓引用清点（文件头自述 deprecated，0 调用）；`layoutAnimationStore.ts:12-15` TODO 无引用类型顺手清。
  6. **D4 双写点收敛（P2-6）**：裁决 = 保留双 sink（口径不同：settingsStore.tokenUsage 当前值 vs usageStore 历史流水），把 `useStreamCallbacks.ts:917/928` 并列双写收敛为 telemetry action 内单点（accumulateTokenUsage 内完成 recordUsageDelta 委托），注释 F5 P2 的串行化增量保护保留。
  7. **D1/D6/D9 加锁不重构**：D1（流式缓冲）与 D6（sessions 双投影）维持设计内形态，补回归用例（流式 commit 单写单收；sessionsById 一致性断言沿用 checkSessionsIndex）；D9（activeSessionId vs shell tabs）维持纪律型约束，在 `storeOwnership.ts` 增补注释声明「本约束为设计内单一手势，组件不得双写」，**不引入运行时守卫**（成本高收益低）。
  8. **D10 open-tabs 双写收敛**：执行期验证 `migrateFromOpenTabsMap` 覆盖后 legacy map 是否仍有消费方；若无 → 删除运行期双写路径（workspaceShellStore.ts:297-301/379/390-394 的同步写），仅保留启动一次性迁移；若有 → 双写抽为单一 helper 并登记待清理。
- **文件面**：`useEngineState.ts`、`bootstrap-services.ts`、`ErrorStore.ts`（只读或投影接入）、`themeStore.ts`、`settingsStore.ts`、`AppBootstrap.ts`、`store/sessionCrudActions.ts` / `sessionOrderingActions.ts` / `sessionAgentActions.ts`（helper 接入）、`rustCoreStore.ts`（删）、`store/index.ts`、`layoutAnimationStore.ts`、`workspaceShellStore.ts`、`storeOwnership.ts`、`useStreamCallbacks.ts`（D4 单点收敛）、相关测试文件。
- **验证方式**：
  - 测试断言：连接态投影单测（engineOnline 消费方改后行为等价）；`settingsStore` 主题订阅投影测试（切换 → DOM 类名 + crish_theme 缓存同步）；`rebindSessionFolders` action 测试（folder/folderOrder 一致性）；terminal 镜像同步测试（CRUD/排序后镜像跟随）；删除 D8 后全仓 typecheck 通过；D4 双写单点测试；
  - 行为验证：主题切换即时生效且刷新保持；删除项目后文件夹归属收敛正确；连接断开/重连两处 UI 显示一致无闪烁。
- **完成判据**：④ 裁决表全部落地（每项有提交或「维持现状 + 理由 + 锁」）；`useEngineState.engineOnline` 无消费方；`AppBootstrap` 无 layoutStore 自订阅；全仓 grep `rustCoreStore` 零命中。
- **输出**：真源/镜像矩阵最终态（裁决表标注「已落地」）；`rebindSessionFolders` 等新 action 已入 store——步骤 3 的「事件写入收敛」以该组 action 为承载面，只增补不重构。

### 步骤 3：事件→store 写入单一收敛路径（P1-1 事件面 + P1-3）

- **任务**：定义并落地「事件写 store 的唯一通道」：**事件 handler → env.callbacks → layoutStore action（跨域经 `api/storeAccess` 编排）**，禁止 raw setState。规则写入 `src/store/README.md` 并挂门禁（步骤 4 的脚本按此规则实现）。
  - **补全 action 承载面**（现状缺口的根因是 layoutStore 58 个 action 未覆盖全部写入面，OPT-H4 注释自述「LayoutFacade 无 setState 的已知缺口」）：
    - `setEngineLastRunId(sessionId, runId)`（接 useStreamCallbacks.ts:404）；
    - agent 域：`appendSessionAgentMessage` / `patchSessionAgent` 已有，补齐 `patchSessionAgentToolStatus` 类终态动作（接 :505/:1061 与 useAgentStream.ts:134/280 同语义收敛——同一组 action 两个调用方）；
    - `updateMessageText` / `updateMessageThinking` 已有（接 :811 timeline 归一语义，新增 `updateMessageTimeline` 或在 action 内复用）；
    - `setMessageCacheMetrics(sessionId, messageId, metrics)`（接 messageHandlers.ts:36，把「必须经 sessions[] canonical 写」的手工纪律变为 action 内部实现——索引保障内建化）；
    - agent 域批处理 action（接 subagentHandlers.ts:118/146/165 三处，与 useStreamCallbacks 的 onSubagentStarted/Event/Ended 共用——**同一数据两个写入方收敛为「同一组 action 两个调用方」**，`_liveParentRuns` 判活集合保留不改）。
  - **P1-3 裁决**：per-run 面 + 全局兜底面保留双调用方（设计内兜底，防单点断流），但写路径归一：两方都只调上述 agent 域 action，不再各自写 immer recipe。`dataPlaneRouter.ts:211-242` 判活逻辑零改动（防双写职责仍在路由层）。
  - 数据面子面（taskEventHandlers）不落 store（轮询快照 = 真源），维持现状，不迁移。
- **文件面**：`src/store/sessionActions.ts`（签名新增）、`sessionMessageActions.ts` / `sessionAgentActions.ts`（实现）、`src/api/chat-bridge/handlers/messageHandlers.ts`、`subagentHandlers.ts`、`src/hooks/chat-stream/useStreamCallbacks.ts`、`useAgentStream.ts`、`src/store/README.md`、`src/api/store-access/sessionAccess.ts`（如需编排出口）、相关测试。
- **验证方式**：
  - 测试断言：新增 action 单测（agent 终态、cacheMetrics canonical 写断言——写 sessionsById 会被下次索引重建覆盖的回归用例）；既有 `useStreamCallbacks.streamStore.test.ts` 不破；子代理路径测试（若存在）不破；
  - 行为验证：流式 token → 终态、子代理消息实时上屏、cacheMetrics 徽标显示（04 维度相关 e2e 若存在则跑）、撤回/审批操作无回归；
  - grep 断言：`hooks/chat-stream/` 与 `api/chat-bridge/handlers/` 下 `useLayoutStore.setState` 命中数 = 0。
- **完成判据**：事件面（handlers/hooks）raw setState 清零；16 处中事件相关 10 处（useStreamCallbacks 5 + useAgentStream 2 + messageHandlers 1 + subagentHandlers 3）全部收敛；README 写入「事件写 store 唯一通道」规则。
- **输出**：写路径收敛后的 action 全集清单（步骤 4 门禁脚本的白名单依据）；组件侧 5 处（AppBootstrap / useOverviewState / workspaceChromeHooks / Workspace / ApprovalSection）仍未动，交步骤 4。

### 步骤 4：raw setState 清零（16 处 → 0，P1-1 全量 + P3-4 + P2-4 语义收敛）

- **任务**：迁移剩余非事件面直写，并落地门禁：
  1. `AppBootstrap.ts:155` → 调步骤 2 已产出的 `rebindSessionFolders`（替换直写 recipe）；
  2. `useOverviewState.ts:154` markLocalTool → 新 action `markToolCallLocalStatus(toolCallId, status, output, scope?)`：store 内实现原全表扫描语义（保行为等价），`scope` 参数（可限定 sessionId/agentId）**本步一并引入**以消除 O(sessions×messages×toolCalls) 全表扫描（P2-4，避免二次动工）；调用方在已知 runId 时传 scope；
  3. `workspaceChromeHooks.ts:319` collapseToolColumnPreserve → workspace action（`workspaceActions.ts` 内新增，替换组件直写 workspaces）；
  4. `Workspace.tsx:69` resize clamp activeWorkspaceIndex → layout-core action（与步骤 2 的 D10 helper 一致收敛到 store 层）；
  5. `ApprovalSection.tsx:68` 批量审批后工具卡状态 → `batchRespondToApproval` / 批量工具状态 action（respondToApproval 的单条语义保留，批量语义封装）；
  6. `workspaceStore.ts:121/128-145`（P3-4）→ `setGroupActiveCard` / `focusExistingPanelCard` 移入 workspaceActions 定义为真 action，facade 仅转发——facade 层自身不再出现 setState recipe；
  7. 若步骤 3 有事件面残留，补清（判据为 0）。
  - **门禁**：新增 `scripts/check-no-raw-setstate.mjs`（仿 check-no-as-any-store.mjs 模式）：扫描生产文件 `useLayoutStore.setState` / `useSessionStore.setState` / `useWorkspaceStore.setState` / `useSettingsUiStore.setState` / `useTerminalStore.setState` 等调用点，允许面 = store 自身 action 定义文件 + `api/store-access/` + `bootstrapStores.ts` + 测试 + dev-only；白名单外违规即 CI 失败。接入 `package.json`（`npm run check:store-writes`）+ CI 快层。
- **文件面**：`AppBootstrap.ts`、`components/overview/useOverviewState.ts`、`components/workspace/workspaceChromeHooks.ts`、`Workspace.tsx`、`ApprovalSection.tsx`、`store/workspaceStore.ts`、`store/workspaceActions.ts`、`store/sessionMessageActions.ts`（新 action）、`store/layout-helpers/*`（如需）、`scripts/check-no-raw-setstate.mjs`（新增）、`package.json`、CI 配置。
- **验证方式**：
  - 测试断言：新增 action 单测（markToolCallLocalStatus 行为等价 + scope 命中；batchRespondToApproval 批量语义）；既有组件测试（OverviewCard / ApprovalSection / Workspace 相关）不破；
  - 门禁：`npm run check:store-writes` 全绿（白名单外 0 命中）；
  - 行为验证：审批通过/拒绝、工具折叠、resize、撤回、批量审批全流程手测 + `npm run typecheck`。
- **完成判据**：全仓生产代码非白名单 `*Store.setState` = 0（16 处全清）；门禁脚本在 CI 快层执行。
- **输出**：写路径零直写的最终态 + 门禁脚本（步骤 5 直接复用其「入口集合」思路定义读边界）。

### 步骤 5：组件直引 store 门禁（58 处，与 02 方案衔接）

- **任务**：业务组件禁止直引 `store/` 内部符号（02 审计 P1-6，58 个组件计数 :149）；全部经以下「store 访问入口集合」：
  - 读面：`store/storeAccess`（T11 新域读面）、域 facade hook（`sessionStore` / `workspaceStore` / `settingsUiStore` 的 `use*Field` / `get*`）、`api/storeAccess`（编排）、`app/compositionRoot`（命令热路径）；
  - 组件内局部状态（S14 flowDagStore / SlashExtension 内部 store）豁免（组件私有，非跨模块）；
  - 门禁实现：仿 `check:ui-layer` 模式扩展（02 审计 :331 建议）——扫描 `components/**` 下 import 源，白名单 = 上述入口集合 + `store/types`（类型导入） + 组件私有 store；违规即 CI 失败。
- **依赖关系（不重复设计）**：58 处的迁移涉及组件重构（selector 替换、props 聚合、局部状态提升），具体重构由 02 组件方案定义。本步骤只定义：① 访问边界规则与门禁脚本；② 迁移顺序依赖——纯读面 selector 替换可独立先行（低风险），涉及组件结构变动的迁移**必须等 02 方案落地后执行**（同文件串行，见 ⑥ 风险 6）。
- **文件面**：`scripts/`（门禁扩展）、`components/**`（随 02 批次迁移）、CI 配置、`store/README.md`（更新消费侧收紧进度表）。
- **验证方式**：门禁全绿（components 下 store 直引 = 0 或全部命中白名单）；`npm run typecheck`；`npx vitest run` 组件相关回归；e2e 冒烟（如有）。
- **完成判据**：components 下直引计数归零（白名单内）；门禁进 CI；`store/README.md` 消费侧收紧进度表清空「仍可接受」列。
- **输出**：读边界门禁闭环——「写路径零直写（步骤 4）+ 读路径零直引（本步）+ 事件单通道（步骤 3）」三者合拢为目标态。

---

## ④ 双源裁决表（D1–D10）

| # | 数据 | 真源裁决 | 保留/合并/删除 | 收敛动作 | 归属步骤 | 验收断言 |
|---|------|----------|----------------|----------|----------|----------|
| D1 | 消息正文（流式期） | streamingStore（流式期）+ sessionStore（终态） | **保留**（设计内缓冲） | 不重构；补回归用例锁 merge 兜底（streamingStore.ts:445-448 分叉分支） | 步骤 2 | streamingStore 单测覆盖分叉兜底分支 |
| D2 | 引擎连接态 | `errorStore.connectionStatus`（完整链路含重连/失败语义） | **合并**（单真源） | 删 `useEngineState.engineOnline`（或改投影）；消费组件迁移；bootstrap 空 catch → ErrorStore 显式告警 | 步骤 2 | 两处 UI 显示一致；engineOnline 零消费方 |
| D3 | 主题 | `settingsStore.appSettings.theme`（引擎事件权威） | **合并**（单真源） | 设置页 → engine 命令（依赖 04 修复）→ 事件回灌 → 订阅投影 DOM + 收敛 crish_theme 写端；删除设置页双写 | 步骤 2 | 切换即时生效 + 刷新保持；crish_theme 单一写端（grep 1 处） |
| D4 | tokenUsage | settingsStore.tokenUsage（当前值）+ usageStore（历史流水） | **保留双 sink**（口径不同）+ 写点收敛 | accumulateTokenUsage 内单点完成 recordUsageDelta 委托；串行化增量保护保留 | 步骤 2 | 双 sink 单点测试；同事件双写无丢失 |
| D5 | 项目/文件夹归属 | projectStore（真源）+ sessions.folder 镜像 | **保留镜像** + 收敛写入 | `rebindSessionFolders` action；删 AppBootstrap 对 layoutStore 自订阅；增量 rebind | 步骤 2 + 步骤 4（直写清零） | action 测试 folder/folderOrder 一致；无自订阅（grep） |
| D6 | sessionsById vs sessions[] | 同一 store 双投影 | **保留**（设计内索引） | 维持 getSessionForWrite / withAutoIndex 双防线；checkSessionsIndex 断言复用 | 步骤 2 | 索引一致性测试全绿 |
| D7 | terminalLines vs terminalBySession | terminalStore 内镜像 | **保留镜像** + 散点收敛 | `syncActiveTerminalSession` helper 统一 8 散点；单测锁「会话切换必同步镜像」 | 步骤 2 | 会话 CRUD/排序后镜像跟随断言 |
| D8 | rustCoreStore.status | 死面 | **删除**（DEAD formal） | 删文件 + barrel 导出（index.ts:174/179 组）+ 引用清点 | 步骤 2 | 全仓 grep 零命中；typecheck 过 |
| D9 | activeSessionId vs shell openTabs | 设计内单一手势 | **保留**（纪律型） | storeOwnership.ts 注释声明强化；不引入运行时守卫 | 步骤 2 | 无代码断言；ownership 文档更新 |
| D10 | open-tabs 持久化 | workspaceShellStore（内存） | **收敛**（运行期双写消除） | 执行期验证迁移覆盖后删 legacy 双写路径；仅保留启动一次性迁移（无消费方时） | 步骤 2 | legacy map 运行期写路径 grep 归零或登记待清理 |

**汇总：保留 4（D1/D6/D7/D9，其中 D7 收敛写点）+ 保留双 sink 收敛写点 1（D4）+ 合并 2（D2/D3）+ 镜像保留写收敛 1（D5）+ 删除 1（D8）+ 双写收敛 1（D10）——实质缺陷面（D2/D3/D5/D10）全部收敛，无维持原状项。**

---

## ⑤ 新发现补充（读代码时超出审计原文本的复核结论）

1. **桥连「可注入缝隙」都不存在**（新增细节）：审计称 2026-08-08 knip 删除注入函数 `bindMessageSnapshotsOps`，实读确认当前 `messageSnapshotsBridge.ts:31` 的 `const _ops = null` 是模块常量且无任何 setter 导出——恢复接线必须**先补注入函数**，不是「找到被删的调用点接回去」。（步骤 1 任务已含）
2. **快照读侧生产零调用**（决策关键事实）：undo / peek / peekDelta / getStack 全仓仅测试引用——子系统是「只记不读」。这决定了接线恢复 ≠ 用户获得撤销能力；若产品期望「撤回可撤销」体验，必须另立 restore UI 任务书（属 02/08 维度，本方案明确不设计 UI）。
3. **MessageSnapshots 纯内存不持久化**（边界事实）：栈与容量全在 `Map` 中，无落盘——重启即清空。接线后其保护窗口仅限同会话，README 登记时须明示，避免再次「功能像存在其实没持久」的误解。
4. **workspaceStore facade 自写 recipe 与 README 收尾宣称不符**：`store/README.md:173-181` 把 workspaceStore 列入「已收尾」，实读 `workspaceStore.ts:121/128-145` 仍有 setState recipe（P3-4 实证）——facade 收尾进度表需在步骤 4 后更新，避免声明与实现再次脱节（与行数门禁「声明与执行脱节」同模式）。
5. **OPT-H4 注释的误导性**：useStreamCallbacks.ts:402-403/486/504/810/1060 标注「intentional residual」，实读后该判断不准确——根因是 **LayoutFacade 确实没有 setState**，且 layoutStore 58 个 action 未覆盖 agent 域/工具状态/engineLastRunId 写入面。「intentional」实为「缺口被容忍」，步骤 3 应补 action 而非改 facade 加 setState。
6. **AppBootstrap rebind 的动态加载 + 自订阅**：rebind 每轮 `import('../api/projectStore')` 动态加载并全表重扫，且订阅 layoutStore 自身（AppBootstrap.ts:184-189，靠 prevSessions 引用比较防环）——D5 收敛后该防环纪律可整体删除，属于「纪律型约束」向「结构保障」的迁移样本（与 D9 的纪律对比：D9 保留纪律，D5 是纪律可以被结构替代的案例，判定标准 = 是否有可测的收敛 action）。
7. **`store/index.ts` barrel 残留组**：:174 导出 `useRustCoreStore`，:179 附近还有同一文件的一组导出——删除 D8 时必须连组清点，knip 曾清理过同类面（fc4b3a5a），但 barrel 是门禁强制的 re-export 面（check-no-as-any-store.mjs:259-264），删除后需跑既有 store 门禁确认不误伤。
8. **连接态空 catch 与 D2 同源**：`bootstrap-services.ts:81` 的 `connect().catch(() => {})`（05 审计亦列）——D2 单真源化时若保留该空 catch，「连接失败静默显示离线」仍成立；应顺势改为 ErrorStore.classifyError 显式登记（ErrorStore.ts:74-119 已有能力未用）。

---

## ⑥ 风险

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| 1 | 快照接线后 withdraw 每次产生 diff 计算 + 内存占用（上限 5MB / 栈深 20 已有淘汰） | 低 | 容量淘汰机制已在类内实现；超大消息撤回的 O(n) diff 一次性成本可接受；接线即登记内存边界 |
| 2 | D3 主题收敛依赖 04 维度断链命令修复（engine 侧设置命令从未生效）——若断链未修，「引擎事件权威回灌」链路断 | 中 | 收敛分两段：先收敛前端（settingsStore 订阅 → DOM + 缓存，不依赖 engine 命令），04 批次 1 修复后链路自动完整；登记显式依赖 |
| 3 | 步骤 3 改 16 处写路径 → 流式/子代理/cacheMetrics 路径回归风险（幂等语义、时序重组） | 高 | 保持 EventRouter 去重与 `_liveParentRuns` 判活零改动；新增 action 语义与原 recipe 逐行等价（行为断言）；流式与子代理路径行为验证 + 既有测试不破 |
| 4 | markLocalTool 若本步只收敛语义不改复杂度，P2-4 全表扫描风险滞留 | 中 | 步骤 4 一并引入 scope 参数（调用方已知 runId 时传），语义收敛与性能优化同批，避免二次动工 |
| 5 | 门禁脚本误伤：组件合法使用 facade hook / 域 store 也会匹配「直引 store」模式 | 中 | 采用**入口集合白名单制**（非路径前缀黑名单）；白名单含域 facade hook 与 `store/types` 类型导入；本地先跑通再进 CI |
| 6 | 与 02 组件方案的文件冲突：步骤 5 迁移组件 import 与 02 重构同批组件（components/** 高重叠） | 中 | 同文件串行（AGENTS.md 派单规则）；步骤 5 的纯读面替换可先行，结构迁移**显式等待 02 落地**；本方案已把 58 处迁移置于最后一步降低冲突面 |
| 7 | 快照接线点若在 store 定义期 import MessageSnapshots 会引入 init 环（桥注释原意即防此） | 低 | 注入点固定 `bootstrapStores()`（模块图稳定后），禁止在 store 定义期 import；AppBootstrap.test.ts 效应排序测试覆盖装配顺序 |
| 8 | 退役备选（决策 B）若被采用：删除 21 组测试资产与完整实现 | — | 仅在产品裁决「永不提供撤回撤销」时启用；执行走 DEAD formal 单提交，注明关闭方式 |

---

## 附：与 00 交叉分析的批次映射

- 本方案步骤 1（快照桥）即 00 批次 1 之 A 项（P0-1）；
- 本方案步骤 2 的 D3 主题与 04 维度 P0-2（断链命令）存在顺序依赖（见风险 2）；
- 本方案步骤 5 与 02 方案（组件体系）互斥文件面标注为「02 先行或同文件串行」；
- 每步独立提交、独立门禁，符合 00「批次独立提交避免大爆炸重构」策略。
