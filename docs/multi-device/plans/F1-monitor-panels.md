# F1 监控与状态面板域设计（手机端 Companion）

- 文档编号：F1
- 状态：设计稿（供主控评审）
- 日期：2026-08-09
- 范围：手机端「监控与状态面板」功能域——连接状态、核心状态卡、活动任务（run/审批计数）、run 详情钻取、会话列表、用量与缓存指标、后台任务、系统诊断
- 相关文档：`docs/multi-device/plans/D1-overall-architecture.md`（总体架构）、`D3-protocol.md`（协议）、`D5-security.md`（安全）、`D7-push-notifications.md`（推送）、`F2-approval-center.md`（审批域，操作面归属）
- 代码证据基线：`apps/agent-workbench/src-tauri/src/core_query_commands.rs`、`crates/conex-types/src/events.rs`、`crates/conex-db/src/runs.rs`、`apps/crish-desktop/src/components/overview/*`、`apps/crish-desktop/src/components/settings/StatusDiagnosticsPanel.tsx`、`apps/crish-desktop/src/components/workspace/SessionCacheStatsPanel.tsx`、`apps/crish-desktop/src/components/settings/SettingsUsageTab.tsx`、`apps/crish-desktop/src/hooks/useEngineState.ts`

---

## 1 背景与定位

### 1.1 手机端是什么

手机端是桌面 crish 的 Companion：桌面端负责引擎执行（session-loop / run / 审批裁决 / 后台任务），手机端负责「随时看一眼、及时知道、轻量处理」。监控与状态面板是手机端第一个落地功能域，承担**只读观测**职责，为审批域（F2）提供入口与上下文。

### 1.2 本域边界

- **只读边界**：本域全部功能只读，不包含任何操作按钮（远程暂停/恢复 run、取消任务、批准/拒绝等一律不在本域，见 §6 权限边界）。
- **与 F2 审批域的边界**：`approval-requested` 事件与待审批计数在本域**展示计数与入口**（徽标 + 跳转），审批动作本体（allow/deny、决策表单、审批历史）归 F2。
- **与 F4 文件域的边界**：run 详情中的工具产出（diff/文件变更）展示归 F4，本域只提供事件时间线与状态摘要。
- **与 F6 设置域的边界**：模型/账号/通知偏好归 F6；本域只消费 `core_get_status` 的只读字段（模型名、日志目录等）。

### 1.3 设计原则

1. **数据源复用桌面已冻结的契约**：不发明新状态，不重复造命令；移动端直接消费桌面端已存在的查询命令与事件流（证据见 §2）。
2. **状态诚实化**：沿用桌面「无数据不显示 0% 误导」口径（`RunUsage::from_run_cache_stats` 的 `sample_count == 0 → None`，core_query_commands.rs:389-411；`SessionCacheStatsPanel.tsx:33-38` 的 null 空态）。
3. **刷新节流对齐桌面**：桌面 `useEngineState` 4s 轮询 + 事件触发的提前刷新（useEngineState.ts:191、186-188），移动端沿用同一节奏，后台/熄屏跳过轮询（useEngineState.ts:135-140 的 visibility 判据）。
4. **推送只推「需要人知道」的事**：Critical 级终态/审批/审计事件走推送（D7），增量事件（message-delta / task-output）不进推送，只用于打开 app 后的实时流。

---

## 2 桌面端能力盘点（文件:行号证据）

本节是手机端功能的「货源清单」。所有数据在桌面端已可查询/可订阅，移动端**不需要新增引擎能力**，只需在 Companion 网关侧做聚合与裁剪。

### 2.1 查询命令面（Tauri IPC，只读清单）

| # | 命令 | 位置 | 返回内容 | 手机端用途 |
|---|------|------|----------|-----------|
| Q1 | `core_get_status` | core_query_commands.rs:277 | `CoreStatus`（字段见 core_query_commands.rs:150-181）：initialized / version / engineReady / searchIndexReady / dbReady / compactionReady / providerStatus{hasApiKey, model, baseUrl, credentialMode} / logLevel / logDir / diagnostics（环形 20，最旧在前）/ lastError / restore{state, mode, snapshotNote, interruptedCount, lastSequence} / snapshot{generation, writtenAt, lastError} / backgroundTasks{activeCount, daemonCount, lastFinished} | 连接状态卡、核心状态卡、诊断页、后台任务汇总 |
| Q2 | `core_get_run_snapshot` | core_query_commands.rs:595 | `{snapshot: RunSnapshot}`（core_query_commands.rs:426-442）：runId / sessionId / status / cursor / createdAt / updatedAt / endReason / error / usage（RunUsage，core_query_commands.rs:346-375：prompt/completion/total tokens、cacheRead/cacheWrite/cacheMiss、hitRatio、writeRatio、missedTokens、warmUntilMs） | run 详情页状态与用量卡 |
| Q3 | `core_read_session_events` | core_query_commands.rs:511 | `EventPage`：events / nextAfterSequence / hasMore（游标 = 会话内连续 sequence） | 会话事件时间线（详情页钻取） |
| Q4 | `core_read_run_events` | core_query_commands.rs:546 | 按 runId 过滤的事件分页 | run 事件时间线 |
| Q5 | `list_sessions` | session_commands.rs:116 | `Vec<SessionIndexEntry>`（conex-types/src/lib.rs:229-255）：id / title / folder / isPinned / isArchived / timestamp / updatedAt / messageCount / engineCursor / engineLastRunId / hydratedFromEngine | 会话列表页 |
| Q6 | `get_flow_snapshot` | session_commands.rs:536 | DAG 流程快照（flow_declaration + flow_state + session_agents 节点状态） | 子代理/流程概览（P2） |
| Q7 | `workbench_list_background_tasks` | background.rs:2605 | `{tasks: [...]}` 后台任务列表（含已结束，归档循环惰性启动） | 后台任务页 |
| Q8 | `workbench_get_background_task_output` | background.rs:2614 | 单任务状态与输出（运行中可读） | 任务详情（P2） |
| Q9 | `catalog_get*`（模型目录快照） | catalog_commands.rs:42、57 | 运行时模型目录快照 | 用量页模型分布（P1） |
| Q10 | `core_list_commands` | command_manifest.rs:191 | 命令注册表（单一真源） | 诊断页「命令面健康」（P2） |
| Q11 | `core_search_files` / `core_rebuild_search_index` | core_commands.rs:127、173 | 搜索索引状态/重建（重建为写操作，本域只用前者） | 搜索索引就绪状态 |
| Q12 | workflow 列表命令（`workflowApi` 对应面） | workflow_commands.rs | workflow 定义列表 | 定时/cron 概览（P2） |

### 2.2 事件面（41 种域事件，events.rs 全清单）

事件经信封 `{type, runId, sequence, schemaVersion, sessionId, ...}` 扁平 JSON 广播（events.rs:905-933、core_event_bridge.rs:1-15）。按手机端监控用途分组：

**A. run 生命周期（驱动首页活动任务与详情页状态）**
- `agent-start`（events.rs:310）/ `agent-end`（events.rs:317，reason 必填、error 可选）
- `run-terminal`（events.rs:512，terminal 三态 completed/cancelled/failed + error；runId 必须填充）
- `turn-start` / `turn-end`（events.rs:328/335，turn_index + toolCallCount）

**B. 进度与内容增量（详情页时间线；不进推送）**
- `message-start` / `message-delta` / `message-end`（events.rs:345/351/360；delta 为 Delta 级可丢，events.rs:869）
- `tool-start` / `tool-update` / `tool-end`（events.rs:372/380/389）、`tool-batch-start` / `tool-batch-end`（events.rs:397/405）
- `context-compression-start` / `context-compression-end`（events.rs:425/433）

**C. 审批（驱动待办计数，推送最高优先）**
- `approval-requested`（events.rs:480，载荷含 toolCallId / toolName / parameters / summary；请求计数 +1）
- `approval-resolved`（events.rs:488，decision 三态 approved/denied/expired；计数 -1）

**D. 缓存与成本（驱动缓存指标卡）**
- `cache-stats-updated`（events.rs:525，RunCacheStats：命中率/读/写/浪费 tokens，run 收口发一次）
- `cache-waste-alert`（events.rs:533，归因分类 + missedTokens + missedCostUsd；阈值 ≥20k tokens 或 ≥$0.1）
- `cold-cache-warning`（events.rs:547，run 启动冷缓存提示，每次 run 一次）

**E. 健康与诊断（驱动诊断页与错误横幅）**
- `provider-diagnostic`（events.rs:446）
- `runtime-error`（events.rs:454，error + retryable）
- `runtime-steering`（events.rs:463）/ `runtime-intervention-required`（events.rs:471，choices 候选动作）

**F. 后台任务（驱动任务页与终态推送）**
- `task-started`（events.rs:636）/ `task-output`（events.rs:652，Delta 级）/ `task-heartbeat`（events.rs:669，Delta 级，CPU/RSS 资源摘要）
- `task-suspicious`（events.rs:679，疑似卡死，Soft 级）
- `task-completed`（events.rs:691）/ `task-failed`（events.rs:705，附最后 20 行 tail）/ `task-killed`（events.rs:719）——全部 Critical 必达

**G. 子代理（驱动 Agent 概览）**
- `subagent-started`（events.rs:584，role/capabilityMode/description/mode）
- `subagent-event`（events.rs:607，progress=Delta / message、tool=Soft）
- `subagent-ended`（events.rs:616，status 规范值 completed/failed/cancelled）

**H. 定时与 cron（P2 概览）**
- `timer-fired` / `timer-cancelled`（events.rs:738/750）、`cron-fired`（events.rs:769）

**I. 安全审计（P2）**
- `security-audit`（events.rs:560，operation/targets/impact/decision 七种处置）

**背压分级**（决定移动端推送与落库策略）：`event_backpressure`（events.rs:867-893）——Delta 可丢（message-delta、task-output、task-heartbeat、subagent progress）、Soft 尽力（subagent message/tool、task-suspicious、timer-cancelled）、Critical 必达（其余全部，含审批/终态/审计）。

### 2.3 桌面 UI 面板清单（手机端「抄什么」）

| 桌面组件 | 位置 | 内容 | 手机端对应 |
|----------|------|------|-----------|
| OverviewCard（总览） | OverviewCard.tsx:100-177 | 头部（workspace 路径/branch/会话）+ 用量折叠 + 活动任务（liveTasks + 待审批 + 允许/拒绝按钮）+ Agent 区 + 后台任务区 + 定时任务区 + 变更区 + 快捷入口 | 首页仪表盘（去掉操作按钮） |
| useOverviewState（liveTasks 派生） | useOverviewState.ts:64-99 | 由「processing 状态消息」+「activeRuns」合成活跃任务列表，带 elapsed 秒数 | 首页活动任务列表的数据口径 |
| ActiveTasksSection | ActiveTasksSection.tsx:21-73 | 待审批条目（toolName + summary + 允许/拒绝）+ 活动任务条目（名称 + 时长） | 首页活动区；审批按钮剔除（跳转 F2） |
| useEngineState（轮询单例） | useEngineState.ts:133-243 | 4s 轮询 core_get_status + listBackgroundTasks；visibility hidden 跳过；事件到达触发提前刷新（onDataPlaneRefresh）；浅等防护 | 手机端刷新策略范本（§3.3） |
| engineStatus.ts（投影） | engineStatus.ts:42-104 | core_get_status → activeRuns / pendingApprovals 投影 | 手机端首页两个数据源 |
| StatusDiagnosticsPanel | StatusDiagnosticsPanel.tsx:110-293 | 四区：子系统就绪（engine/db/search 三行 OK/异常/未知）、日志配置（logLevel/logDir）、最近错误（lastError kind+detail+复制）、最近诊断（环形 20 最新在前）；5s 轮询；连接异常横幅 | 诊断页（简化：去掉复制按钮可保留） |
| SessionCacheStatsPanel | SessionCacheStatsPanel.tsx:28-86 | 命中率 / 读·写 tokens / 未命中提示 / 浪费 tokens / 冷缓存提示（🧊 下次重发 ~X tokens）/ 浪费预警列表（归因 + 金额） | run 详情缓存卡 + 用量页缓存区 |
| SettingsUsageTab | SettingsUsageTab.tsx:320-541 | 历史统计卡（累计输入/输出/费用/缓存命中读取/缓存节省）+ 7/14 日趋势柱状图 + 模型分布（每模型 tokens + 命中率 + 节省金额） | 用量页 |
| UsageSection（概览用量） | UsageSection.tsx:13-34 | 输入/输出 tokens + 费用三列 | 首页用量摘要行 |
| RunNoticeBar | RunNoticeBar.tsx:21-60 | 运行提示播报条（错误/空回复等，aria-live） | run 详情错误横幅（P1） |
| ChatStatusRibbons / chatStatusRibbonsLib | ChatStatusRibbons.tsx | run 状态丝带（运行中/等待审批/失败等） | run 详情状态条 |
| RuntimePanel / RuntimeSection | RuntimePanel.tsx、RuntimeSection.tsx | 运行期任务实时列表 | 任务页（P1） |
| FlowDagView | FlowDagView.tsx | 子代理 DAG 节点状态 | 流程概览（P2） |
| SecurityAuditSection | SecurityAuditSection.tsx | 安全审计事件列表 | 审计页（P2） |
| CacheMetricsBadge | chat-message-row/CacheMetricsBadge.tsx | 消息行缓存命中徽标 | 会话列表缓存徽标（P2） |

### 2.4 状态机盘点（桌面端已冻结的枚举）

- **run 生命周期**：`RunStatus` 十态（conex-db/src/runs.rs:21-35）——`queued / initializing / running / awaiting-approval / completing / cancelling / completed / failed / cancelled / unknown`；未知字面量保真透传（runs.rs:17-19）。run 终态另有三态事件 `RunTerminalStatus`（events.rs:29-36：completed/cancelled/failed）。
- **子代理**：`SessionAgent.status` 四态（conex-types/src/lib.rs:200-201：running/completed/failed/stopped）；`SubagentEndStatus` 三态规范值（events.rs:158-165：completed/failed/cancelled）。
- **后台任务**：任务注册表五态（task-started → running → completed/failed/killed，TaskTerminal 三态，core_query_commands.rs:120-129）。
- **restore/snapshot**：`RestoreStatus.state` 三态（core_query_commands.rs:91-104：pending/done/failed）；快照代数与写入时间（core_query_commands.rs:106-118）。
- **审批**：`PermissionBehavior` 三态（events.rs:40-48：allow/deny/ask）+ `ApprovalDecision` 三态（events.rs:225-232：approved/denied/expired）。

### 2.5 事件 → 手机端功能映射矩阵（41 事件全覆盖）

下表把 §2.2 的 41 种事件逐条映射到手机端功能与动作（推=推送、实=打开 app 后实时流、刷=触发刷新、显=展示、落=本地落库计数）。「落」用于角标/告警去重。

| 事件（wire 名） | 背压级 | 手机端动作 | 消费功能 |
|----------------|--------|-----------|---------|
| agent-start | Critical | 实+刷 | F03 活动任务新增、F04 详情 |
| agent-end | Critical | 实+刷+推(failed) | F03 任务移除、F12 错误横幅 |
| turn-start / turn-end | Critical | 实 | F04 详情轮次指示 |
| message-start / message-end | Critical | 实 | F04 时间线（骨架行→内容） |
| message-delta | Delta | 实（节流合并） | F04 时间线增量 |
| tool-start / tool-update / tool-end | Critical / Critical / Critical | 实 | F04 时间线工具行 |
| tool-batch-start / tool-batch-end | Critical | 忽略 | —（桌面显式 ignore，events.rs:395-411 同口径） |
| tool-input-repaired | Critical | 实 | F04 时间线（罕见行） |
| context-compression-start / end | Critical | 实 | F04 时间线（压缩标记） |
| provider-diagnostic | Critical | 实 | F11 诊断页日志（仅 error 级） |
| runtime-error | Critical | 实+推 | F12 错误横幅 |
| runtime-steering | Critical | 实 | F04 时间线（注入消息行） |
| runtime-intervention-required | Critical | 实+推 | F12 干预横幅（choices 展示） |
| approval-requested | Critical | 推+实+落 | F10 角标 +1、F03 置顶、F2 深链 |
| approval-resolved | Critical | 实+落 | F10 角标 −1 |
| checkpoint-created / checkpoint-restored | Critical | 实 | F04 时间线（检查点标记） |
| run-terminal | Critical | 实+刷+推(failed) | F03 移除、F04 终态、F07 用量刷新 |
| cache-stats-updated | Critical | 刷 | F08 缓存卡、F07 用量 |
| cache-waste-alert | Critical | 推+显 | F08 浪费预警列表 |
| cold-cache-warning | Critical | 显 | F08 冷缓存提示 |
| security-audit | Critical | 推(高危)+显 | F15 审计列表（P2） |
| subagent-started | Critical | 实 | F13 流程概览（P2） |
| subagent-event（progress） | Delta | 忽略 | —（可丢不落，events.rs:870-872） |
| subagent-event（message/tool） | Soft | 实（尽力） | F13 流程详情（P2） |
| subagent-ended | Critical | 实+刷 | F13 节点终态（P2） |
| task-started | Critical | 实+刷 | F09 任务列表 |
| task-output | Delta | 实（节流合并 60ms） | F16 任务输出（P2） |
| task-heartbeat | Delta | 忽略 | —（资源摘要不进推送，P2 可展示） |
| task-suspicious | Soft | 推+显 | F09 疑似卡死 |
| task-completed | Critical | 刷 | F09 任务终态 |
| task-failed | Critical | 推+显 | F09 失败 + tail 摘要 |
| task-killed | Critical | 推 | F09 已终止 |
| timer-fired | Critical | 推+显 | F14 定时概览（P2） |
| timer-cancelled | Soft | 显 | F14（P2） |
| cron-fired | Critical | 推+显 | F14 cron 概览（P2） |

**规则**：Delta 级事件一律不推送、不落库，仅前台实时流消费（省电省流量）；Soft 级尽力展示；Critical 级按 §2.5 表驱动推送/刷新/落库。此分级直接复用 `event_backpressure`（events.rs:867-893），移动端不做第二套分级。

---

## 3 手机端功能清单

按用户价值排序。**触发方式**三通道：P=推送（系统通知，见 D7）、O=打开 app（冷启动拉取）、R=下拉刷新（手动）。

### 3.1 P0 必须（第一版落地）

| # | 功能 | 优先级 | 触发 | 数据来源 | 刷新策略 |
|---|------|--------|------|----------|----------|
| F01 | 连接状态条（Companion ↔ 桌面） | P0 | O、R | 网关心跳（封装 core_get_status 的连通性；engineStatus.ts:42-48 的 connected 语义） | 打开 app 立即探测；断线后 5s 指数退避重试（1/5/15/30s）；状态变化由网关事件推给 UI |
| F02 | 核心状态卡（引擎/数据库/搜索索引/模型） | P0 | O、R | `core_get_status`（Q1）：engineReady/dbReady/searchIndexReady/compactionReady/providerStatus.model | 首页打开拉取 + 每 4s 轮询（对齐 useEngineState.ts:191）；事件到达触发提前刷新 |
| F03 | 活动任务列表（运行中 run + 待审批计数） | P0 | P、O、R | 活动 run：`core_get_status.activeRuns`（engineStatus.ts:58-73）；待审批：`pendingApprovals`（engineStatus.ts:75-86）；实时增量：approval-requested/approval-resolved/run-terminal/agent-start/agent-end（events.rs:310/317/480/488/512） | 首页 4s 轮询 + 事件触发提前拉取；审批计数变化立即重算 |
| F04 | run 详情页（状态条 + 事件时间线 + 用量卡） | P0 | O | 状态：`core_get_run_snapshot`（Q2）；时间线：`core_read_run_events`（Q4，游标分页，200/页，core_query_commands.rs:43-45）；实时：订阅 run 事件流（按 runId 过滤） | 打开全量拉第一页；时间线翻页拉历史（nextAfterSequence 游标）；顶部状态 4s 轮询；事件流增量追加 |
| F05 | 会话列表页 | P0 | O | `list_sessions`（Q5）；会话「活跃」标记由 run 状态派生（engineLastRunId + 活动 run 集合） | 打开拉取 + 4s 轮询；会话标题/时间戳与桌面会话存储同步 |
| F06 | 空态/加载态/离线态（全局） | P0 | — | — | 见 §4.7 |

### 3.2 P1 重要（第二版）

| # | 功能 | 优先级 | 触发 | 数据来源 | 刷新策略 |
|---|------|--------|------|----------|----------|
| F07 | 用量与成本摘要（本会话 + 累计） | P1 | O、R | run 用量：`core_get_run_snapshot.usage`（Q2，RunUsage core_query_commands.rs:346-375）；累计：桌面 usageStore 口径（SettingsUsageTab.tsx:333-372 的 summary 卡），经网关聚合 | 打开拉取；run 终态（cache-stats-updated，events.rs:525）到达后刷新；手动刷新按钮 |
| F08 | 缓存指标卡（命中率/读/写/浪费/冷缓存） | P1 | P（仅浪费告警）、O | 会话级：`cache-stats-updated`（events.rs:525）+ `cache-waste-alert`（events.rs:533）+ `cold-cache-warning`（events.rs:547）；run 级：snapshot.usage | 事件驱动（run 收口时更新一次）；打开 app 从网关缓存读最近值 |
| F09 | 后台任务列表 | P1 | P（task-failed/task-killed/task-suspicious 推送）、O | `workbench_list_background_tasks`（Q7）；实时：task-started/task-completed/task-failed/task-killed/task-suspicious（events.rs:636/691/705/719/679） | 打开拉取 + 事件驱动增量；终态推送后打开 app 定位到该任务 |
| F10 | 待审批徽标（全局角标 + 首页卡片） | P1 | P（approval-requested 必达推送） | `core_get_status.pendingApprovals`（engineStatus.ts:75-86）+ approval-resolved 事件计数减一 | 事件驱动（请求 +1 / 解决 -1），推送通知本体 + 本地角标；打开 app 后全量重算 |
| F11 | 诊断页（子系统就绪/最近错误/最近诊断） | P1 | O、R | `core_get_status`：diagnostics（环形 20 最旧在前，core_query_commands.rs:169-170；桌面展示前 reverse，StatusDiagnosticsPanel.tsx:159）+ lastError（core_query_commands.rs:172-173）+ logLevel/logDir | 打开拉取 + 手动刷新（不做常驻轮询，省电；桌面 5s 轮询是桌面特权，手机只在页面可见时 15s 轮询，见 StatusDiagnosticsPanel.tsx:111） |
| F12 | run 错误横幅与干预提示 | P1 | P（runtime-error/runtime-intervention-required） | `runtime-error`（events.rs:454）/ `runtime-intervention-required`（events.rs:471，choices）/ `agent-end` error（events.rs:317）/ snapshot.error | 事件驱动；打开 app 时从网关最近事件缓存恢复 |

### 3.3 P2 可选（后续迭代）

| # | 功能 | 优先级 | 触发 | 数据来源 | 刷新策略 |
|---|------|--------|------|----------|----------|
| F13 | 子代理/流程概览 | P2 | O | `get_flow_snapshot`（Q6）+ subagent-started/ended（events.rs:584/616） | 打开拉取 |
| F14 | 定时/cron 概览 | P2 | P（timer-fired/cron-fired） | workflow 列表命令（Q12）+ timer-fired/cron-fired（events.rs:738/769） | 打开拉取 + 事件刷新 |
| F15 | 安全审计列表 | P2 | P（security-audit 仅高危时） | `security-audit`（events.rs:560） | 事件驱动，仅展示最近 20 条 |
| F16 | 后台任务输出查看 | P2 | O | `workbench_get_background_task_output`（Q8） | 打开拉取，滚动到底自动加载 |
| F17 | 会话消息级缓存徽标 | P2 | O | cache-stats-updated 与会话消息绑定（桌面 CacheMetricsBadge 口径） | 随会话列表刷新 |
| F18 | 快照/restore 健康指示 | P2 | O | core_get_status.restore/snapshot（core_query_commands.rs:175-176） | 打开拉取 |

### 3.4 功能优先级总结

- **P0 五件**：连接条、核心状态卡、活动任务、run 详情、会话列表——构成「打开即知桌面在干什么」的最小闭环。
- **P1 六件**：用量、缓存、后台任务、审批徽标、诊断、错误横幅——构成「省钱 + 省心 + 排障」。
- **P2 六件**：流程/定时/审计/任务输出/会话徽标/快照健康——锦上添花，随主架构迭代。

### 3.5 数据来源总矩阵（功能 × 命令 × 事件 × 推送）

汇总 §2.1/§2.5 为一张对照表，供网关白名单（§6.3）与协议裁剪（D3）直接引用：

| 手机端功能 | 查询命令 | 事件（实时/推送） | 推送 | 轮询 |
|-----------|---------|-------------------|------|------|
| F01 连接条 | core_get_status（连通性） | 网关心跳 | 无（状态条即可） | 断线退避 1/5/15/30s |
| F02 核心状态卡 | core_get_status | — | 无 | 4s（前台） |
| F03 活动任务 | core_get_status.activeRuns + pendingApprovals | agent-start/end、run-terminal、approval-requested/resolved | 无（页内实时） | 4s |
| F04 run 详情 | core_get_run_snapshot + core_read_run_events | 按 runId 订阅全部相关事件 | 无 | 4s（仅状态条） |
| F05 会话列表 | list_sessions | run-terminal、agent-start（活跃标记） | 无 | 4s |
| F06 三态规范 | — | — | — | — |
| F07 用量 | core_get_run_snapshot.usage + 网关历史缓存 | cache-stats-updated | 无 | 打开/终态刷新 |
| F08 缓存卡 | snapshot.usage 缓存域 | cache-stats-updated、cache-waste-alert、cold-cache-warning | waste-alert | 事件驱动 |
| F09 后台任务 | workbench_list_background_tasks | task-* 七事件 | failed/killed/suspicious | 事件 + 打开 |
| F10 审批徽标 | core_get_status.pendingApprovals | approval-requested / approval-resolved | requested 必达 | 查询兜底 |
| F11 诊断页 | core_get_status（diagnostics/lastError/logLevel） | provider-diagnostic、runtime-error | 无 | 15s（可见时） |
| F12 错误横幅 | snapshot.error | runtime-error、runtime-intervention-required、agent-end.error | error/intervention | 事件驱动 |
| F13 流程概览 | get_flow_snapshot | subagent-started/ended | 无 | 打开 |
| F14 定时概览 | workflow 列表 | timer-fired、cron-fired | fired | 打开 |
| F15 审计 | 网关事件缓存 | security-audit | 高危 | 打开 |
| F16 任务输出 | workbench_get_background_task_output | task-output | 无 | 打开/滚动 |
| F17 会话缓存徽标 | 网关事件缓存 | cache-stats-updated | 无 | 随会话列表 |
| F18 快照健康 | core_get_status.restore/snapshot | — | 无 | 打开 |

---

## 4 面板设计

### 4.1 信息层级总则

```
L0 连接层    → 顶部连接状态条（永远可见，钉在状态栏下方）
L1 状态层    → 核心状态卡 + 活动任务（首页首屏，一眼看懂「活着没、在干嘛」）
L2 列表层    → 会话列表 / 后台任务 / 用量明细（按需进入）
L3 详情层    → run 详情 / 任务详情（钻取）
L4 诊断层    → 诊断页（低频排障）
```

底部固定 Tab 四个：**首页 | 会话 | 用量 | 诊断**。审批入口不做 Tab，以首页徽标卡 + 系统通知进入（避免与 F2 重复设计导航）。

> 【裁决修正 7】本节 Tab 建议已被 **M4 §0.2 裁决**取代：移动端五 Tab =
> 首页/会话/审批/文件/设置（审批占 Tab 位、文件进 Tab、用量/诊断归二级页）；
> 本节的「四 Tab + 审批不走 Tab」仅作历史建议保留（AU1 P1-4 关闭）。

### 4.2 首页仪表盘

```
┌───────────────────────────────────┐
│ 09:41                     ● 已连接 │ ← L0 连接条（绿/黄/红 + 重连文案）
├───────────────────────────────────┤
│ 引擎 ● 就绪   数据库 ● 就绪       │ ← L1 核心状态卡（横向四个胶囊）
│ 搜索索引 ● 就绪   模型 deepseek-v4 │
├───────────────────────────────────┤
│ 活动任务                    (4)   │ ← L1 活动区
│ ┌─────────────────────────────┐   │
│ │ 🟡 会话A · 检查 package.json │   │
│ │     待审批 · 运行中 12s      │   │
│ └─────────────────────────────┘   │
│ 待审批 2 项（run_approval）  → 去处理
│ ┌─────────────────────────────┐   │
│ │ 🟢 会话B · 生成测试          │   │
│ │     运行中 3m42s             │   │
│ └─────────────────────────────┘   │
├───────────────────────────────────┤
│ 用量 $0.12 · 输入 12.3k · 输出 8k │ ← L2 用量摘要行（点击进用量页）
│ 缓存 命中 78% · 节省 $0.03        │ ← 缓存摘要行（点击进 run 详情缓存卡）
├───────────────────────────────────┤
│ 后台任务 1 项（daemon: watch）     │ ← 任务摘要行（点击进任务页）
└───────────────────────────────────┘
[首页]  [会话]  [用量]  [诊断]        ← 底部 Tab
```

交互规则：
- 活动任务条目 = 桌面 `liveTasks` 口径（useOverviewState.ts:64-99：processing 消息 + activeRuns 合成）+ 待审批条目置顶（对齐 ActiveTasksSection.tsx:39-56 的「审批在前」排序）。**无允许/拒绝按钮**，点击整卡进入 run 详情；待审批条目点击直接跳 F2 审批处理页。
- 核心状态卡胶囊三态：就绪（绿）/ 异常（红，显示失败子系统名）/ 未知（灰，`undefined` 时，对齐 StatusDiagnosticsPanel.tsx:88-104 的 known 判定）。
- 刷新：下拉刷新 = 全量重拉 Q1 + 会话列表 + 后台任务（并行）；4s 轮询只拉 Q1 活动面（对齐 useEngineState.ts:191）。

### 4.3 run 详情页

```
┌───────────────────────────────────┐
│ ← 会话A · 检查 package.json        │
│ ┌─────────────────────────────┐   │
│ │ ● 运行中 · 12s               │   │  ← 状态条（十态映射 §5.1）
│ │ 模型 deepseek-v4 · turn 3    │   │
│ └─────────────────────────────┘   │
│ ┌─────────────────────────────┐   │
│ │ 用量   输入 2.1k · 输出 1.4k │   │  ← usage 卡（P0；无样本隐藏，不显 0）
│ │ 缓存   命中 82% · 读 1.8k    │   │  ← 缓存子卡（命中率 None 时隐藏）
│ │ 浪费 ~0 tokens               │   │
│ └─────────────────────────────┘   │
│ 事件时间线                        │  ← 游标分页，倒序（最新在上）
│ ┌─────────────────────────────┐   │
│ │ 14:02:11  tool-end 读取文件   │   │
│ │ 14:02:09  message-end 输出…   │   │
│ │ 14:02:05  tool-start 检查文件  │   │
│ │ …  加载更早事件（上拉翻页）     │   │
│ └─────────────────────────────┘   │
└───────────────────────────────────┘
```

交互规则：
- 状态条十态 → 五色分组（§5.1 表）：灰=排队中，蓝=进行中，黄=等待审批（闪烁提示），红=失败/取消中，绿=完成。
- 时间线事件行 = `core_read_run_events` 扁平 JSON（core_query_commands.rs:331-338 EventPage），移动端按 type 渲染模板（agent-start/message/tool/compression/approval/run-terminal 六类模板即可覆盖 95% 场景；未知 type 走兜底「事件 <type>」行，保真不丢）。
- 打开时若 run 已终态，显示终态条（completed/failed/cancelled + endReason + error 全文），时间线一次性可翻完（hasMore=false 显示「已全部加载」）。

### 4.4 会话列表页

```
┌───────────────────────────────────┐
│ 会话                            🔍│
│ ┌─────────────────────────────┐   │
│ │ 会话A · 检查 package.json     ● │  ← ●=有活动 run；黄点=有审批待办
│ │ 3m42s 前 · 12 条消息          │   │
│ └─────────────────────────────┘   │
│ ┌─────────────────────────────┐   │
│ │ 会话B · 生成测试              │   │
│ │ 昨天 · 45 条消息             │   │
│ └─────────────────────────────┘   │
│ …（虚拟列表，仅渲染可视区）         │
└───────────────────────────────────┘
```

- 排序：活动会话置顶（有活动 run / 有待审批），其余按 updatedAt 降序（对齐桌面会话排序直觉）。
- 数据 = `list_sessions`（Q5）+ 首页活动 run 集合做并集标记；`engineLastRunId`（lib.rs:252）与会话绑定的 run 终态（run-terminal 事件）用于清空活动标记。
- 点击会话 → run 详情（若该会话有最新 run）或「该会话暂无 run」空态（F06）。

### 4.5 用量与缓存页

```
┌───────────────────────────────────┐
│ 用量                [近7日|近14日] │
│ 累计输入 123.4k · 输出 88.2k      │  ← 摘要卡（SettingsUsageTab 口径）
│ 累计费用 $1.23                    │
│ 缓存命中读取 45.1k · 节省 $0.34   │
│ ┌─────────────────────────────┐   │
│ │ 每日趋势（柱状图，输入/输出堆叠）│  ← 7/14 日切换
│ └─────────────────────────────┘   │
│ 模型分布                          │
│ deepseek-v4  命中 78% · 读 45k     │  ← 每模型行（SettingsUsageTab.tsx:469-499）
│ deepseek-r1  命中 62% · 读 12k     │     命中率口径 C9，无数据隐藏
│ 缓存浪费预警                      │
│ 前缀变化 · 浪费 ~20k ≈ $0.10       │  ← cache-waste-alert 列表
│ 🧊 缓存已过期 · 下次重发 ~15k      │  ← cold-cache-warning（每 run 一条）
└───────────────────────────────────┘
```

- 数据源：网关聚合 `core_get_run_snapshot.usage`（Q2，run 级）+ 事件缓存（cache-stats-updated 会话级）+ 桌面 pricingStore 口径（SettingsUsageTab.tsx:8-13 的 ModelPrice 表）估算金额。手机端不做本机历史持久化，只消费网关缓存（历史明细持久化归 F6/同步域）。

### 4.6 诊断页

```
┌───────────────────────────────────┐
│ 诊断                     [刷新] 🔄 │
│ 子系统就绪                        │
│ 引擎（session-loop）        OK     │  ← engineReady
│ 会话数据库                 OK     │  ← dbReady
│ 搜索索引                 异常     │  ← searchIndexReady（红）
│ 压缩能力                  未知     │  ← compactionReady（灰，未接线如实）
│ 日志配置                           │
│ 日志级别  info · 日志目录 …/logs   │
│ 最近错误                           │
│ [Io] store.append_event: …        │  ← lastError（kind 徽标 + detail + 时间）
│ 无错误记录                        │  ← 空态（CheckCircle 同款）
│ 最近诊断（最新在前）               │
│ error  14:02:11  disk full         │  ← 环形 20 条，reverse 后展示
│ info   14:01:03  restore done      │
└───────────────────────────────────┘
```

- 对齐 StatusDiagnosticsPanel.tsx:205-292 的四区结构；「复制」按钮在手机端替换为「长按复制」（iOS/Android 原生交互，省去图标按钮）。
- 轮询：页面可见时 15s（省电），不可见停止；下拉刷新立即重拉（比桌面 5s 保守，诊断数据变更频率低）。

### 4.7 空态 / 加载态 / 离线态（F06，全局规范）

**空态**（无数据，禁用「0」误导）：
- 活动任务为空 → 居中插画 + 「当前无活动任务」+ 副文案「桌面端 run 结束时这里会更新」。
- 用量无样本 → 「暂无用量数据」（沿用 `sample_count == 0 → 隐藏` 口径，core_query_commands.rs:389-391）。
- 缓存无数据 → 「暂无缓存统计数据」（SessionCacheStatsPanel.tsx:36 文案）。
- 诊断无记录 → 「无错误记录 / 暂无诊断记录」（StatusDiagnosticsPanel.tsx:262、273 文案）。
- 会话列表空 → 「还没有会话，去桌面端开始第一个对话」。
- run 事件流空 → 「该 run 暂无事件」。

**加载态**：
- 首页首拉：骨架屏（三块：核心卡 4 胶囊、活动区 2 行、摘要行）——对齐 SettingsUsageTab 的 skeletonSection 做法（SettingsUsageTab.tsx:325-329）。
- 翻页加载：列表底部「加载中…」行 + 加载失败「点击重试」（游标不变，可安全重试，分页接口幂等，core_query_commands.rs:498-505）。

**离线态**（Companion 连不上桌面）：
- 连接条变红：「桌面端离线」+ 最后同步时间（`xx 分钟前更新`）。
- 页面内容保留上次成功快照（灰化 + 顶栏横幅「数据可能过期」），**不显示伪造的新数据**（诚实化）。
- 重连成功：自动触发一次全量刷新，横幅消失；重连失败退避重试（1/5/15/30s 指数退避，与推送通道重连共享）。

**深色模式**：
- 跟随系统 `prefers-color-scheme`，提供「跟随系统/浅色/深色」三选项（默认跟随系统）。
- 色板：背景 `#0F1115` 系、卡片 `#1A1D24`、分隔线 `#262A33`；语义色与桌面一致（绿=就绪/完成、黄=等待审批/进行中偏灰、红=失败/异常、灰=未知/离线）；状态圆点与文字双通道表达（不止颜色，色盲可读）。

### 4.8 通知与角标界面（F10 关联设计）

**应用图标角标**（OS 级）：
- 数值 = 待审批数 + 未读失败事件数（run failed / task-failed / runtime-error），两者分别计数展示「审批 2 · 异常 1」拆分或合并角标（合并 ≤99+）。
- 打开 app 后角标清零时机：审批数清零 = 全量重算后为 0；异常数清零 = 用户进入对应详情页后。

**通知卡片样式**（与 D7 对齐的线框）：

```
┌─────────────────────────────────────┐
│ Crish · 待审批                        │
│ 会话A · 工具 shell:write（运行测试）   │  ← approval-requested
│ 摘要：npm test 需要执行权限            │     深链 → F2 审批处理页
│ 09:41                                │
└─────────────────────────────────────┘
┌─────────────────────────────────────┐
│ Crish · 运行失败                      │
│ 会话B · run failed：测试未通过         │  ← run-terminal(failed)
│ error: exit code 1（点击查看详情）     │     深链 → run 详情页
│ 09:40                                │
└─────────────────────────────────────┘
┌─────────────────────────────────────┐
│ Crish · 任务异常                      │
│ 任务 build-7 异常退出（exit code 2）   │  ← task-failed（events.rs:705 文案）
│ tail: ERROR: cannot find module…     │     深链 → 任务页
│ 09:39                                │
└─────────────────────────────────────┘
```

- 推送去重：以信封 `sequence` 为幂等键（events.rs:905-933），重复投递仅更新原通知（不叠加）。
- 免打扰时段（默认 21:00-08:00）：只放行 approval-requested（Critical 且时效性强，120s 过期窗口，core_run_commands.rs:3150-3154 的 Expired 语义）；其余事件静默积压为应用内列表。

---

## 5 状态定义与桌面对应

### 5.1 run 生命周期（十态 → 手机端五色分组）

| 桌面字面量（runs.rs:21-35） | 手机端分组 | 颜色 | 展示文案 | 说明 |
|---------------------------|-----------|------|---------|------|
| queued | 排队 | 灰 | 排队中 | 未开始 |
| initializing | 进行中 | 蓝 | 初始化中 | 短暂态，可并入进行中 |
| running | 进行中 | 蓝 | 运行中 | 主状态 |
| awaiting-approval | 等待审批 | 黄 | 等待审批 | 高亮 + 通知（approval-requested） |
| completing | 收尾 | 蓝 | 收尾中 | finalize 前 |
| cancelling | 取消中 | 红 | 取消中 | 短暂态 |
| completed | 终态-成功 | 绿 | 已完成 | run-terminal completed |
| failed | 终态-失败 | 红 | 失败 | 附 error 全文（snapshot.error） |
| cancelled | 终态-取消 | 红(淡) | 已取消 | run-terminal cancelled / agent-end reason |
| unknown | 未知 | 灰 | 状态未知 | 透传保真（runs.rs:17-19），不静默改写 |

**终态判定**：`run-terminal` 事件（events.rs:512）是唯一权威终态信号；快照 status（Q2）是回退源。两者冲突时以事件为准（事件有 sequence 序，可判先后）。

### 5.2 会话状态（派生，不落库）

| 手机端会话状态 | 派生规则 | 依据 |
|---------------|---------|------|
| 空闲 | 无活动 run 且无待审批 | list_sessions（Q5）+ activeRuns 并集 |
| 运行中 | 该会话有 activeRuns 中状态 ∈ {queued, initializing, running, completing} | core_get_status.activeRuns（engineStatus.ts:58-73） |
| 等待审批 | 该会话有 pendingApprovals 条目 | pendingApprovals（engineStatus.ts:75-86） |
| 收尾/取消 | 有 run ∈ {cancelling} | 同 activeRuns |

会话状态是**派生量**（桌面 useOverviewState.ts:64-99 的 liveTasks 就是此口径），手机端不做独立存储，打开 app 时由网关聚合计算，避免双端状态漂移。

### 5.3 审批待办数（角标口径）

- 数值 = `core_get_status.pendingApprovals` 数组长度（engineStatus.ts:75-86）。
- 增量维护：`approval-requested` +1（events.rs:480，Critical 必达 → 推送 + 本地角标）；`approval-resolved` −1（events.rs:488，approved/denied/expired 均减）。
- 打开 app 时全量重算（以查询为准，事件缓存只做增量猜测，查询失败时显示「未知」而非 0——诚实化）。
- 角标上限 99+，过期策略：approval-resolved 后立即减一；桌面端已处理（跨端裁决，用户可能在桌面点了允许）由下一次查询兜底收敛。

### 5.4 Companion 自身状态机（网关连接层）

```
disconnected → connecting → connected ⇄ reconnecting（指数退避）
     ↑            ↑              │
     └────────────┴──────────────┘（推送通道活/死、app 前后台切换均触发重估）
```

- `connected`：可查询 + 事件流活跃；`reconnecting`：查询失败但推送通道可能存活（双通道独立判定）。
- 数据新鲜度：每个页面级数据带 `lastSyncedAt`，超过 60s 未刷新显示「数据可能过期」标记（下拉刷新清除）。
- 桌面端在线判定依据：`core_get_status` 可返回即在线（engineStatus.ts:42-48 的 connected 语义），不以 activeRuns 数量判定。

### 5.5 后台任务状态（五态 → 手机端）

| 桌面状态（events.rs 任务域） | 手机端展示 | 推送策略 |
|---------------------------|-----------|---------|
| running（task-started 后） | 运行中 + 时长 | 无 |
| suspicious（task-suspicious，Soft） | 疑似卡死（黄，可重复出现） | 推送一次（通知文案对齐 events.rs:676「任务 <id> 疑似卡死」） |
| completed（task-completed，Critical） | 已完成 + 退出码 0 + 时长 | 无（低价值） |
| failed（task-failed，Critical） | 失败 + 退出码 + 最后 20 行尾部 | 推送（高价值，附 tail 摘要前 3 行） |
| killed（task-killed，Critical） | 已终止（viaForce 标注） | 推送 |

### 5.6 run 状态迁移表（事件驱动，与桌面引擎一致）

手机端**不持有**状态机，只消费事件做展示投影；此表是「事件 → 状态预期」的映射，用于测试断言（§8.9）与 UI 一致性校验：

| 事件 | 迁移（桌面字面量） | 手机端投影 |
|------|-------------------|-----------|
| core_run_task 注册（Q 面无事件，以 activeRuns 出现为据） | → queued | 活动列表新增（灰「排队中」） |
| 引擎开始执行 | queued → initializing → running | 状态条蓝 |
| turn-start | running（turn_index+1） | 详情轮次指示更新 |
| approval-requested | running → awaiting-approval | 状态条黄 + 角标 +1 + 列表置顶 |
| approval-resolved（approved） | awaiting-approval → running | 状态条蓝 + 角标 −1 |
| approval-resolved（denied/expired） | awaiting-approval → running（继续） | 同上 + 时间线记录决策 |
| run-terminal completed | running → completed | 终态绿 + 移出活动列表 + 用量刷新 |
| run-terminal failed | running → failed | 终态红 + error 展示 + 推送 |
| run-terminal cancelled | running → cancelled | 终态淡红 + 移出活动列表 |
| agent-end（reason） | 终态收口 | 与 run-terminal 一致性校验（两者终态 reason 应互洽；冲突时以 run-terminal 为准） |
| core_run_control cooperative_stop | running → cancelling | 状态条红「取消中」（短暂） |
| core_run_control force_cancel | running → cancelling → cancelled | 同上 |

**恢复与重启场景**（restore 域，core_query_commands.rs:91-104）：
- 桌面重启恢复中：`restore.state = pending` → 手机端显示「桌面正在恢复会话（xx 个 run 被中断）」横幅；`interruptedCount > 0` 提示「N 个运行中任务已被中断」。
- 恢复完成（done）：横幅消失，活动列表全量重拉。
- 恢复失败（failed）：诊断页 restore 行红色 + 说明；不阻塞其他功能展示。

---

## 6 权限边界：监控只读，操作归审批域

### 6.1 结论

**本域（监控与状态面板）全部功能只读**。远程操作（暂停/恢复/取消 run、取消后台任务、注入 stdin、批准/拒绝工具调用）一律不进监控域，按归属放 F2 审批域（或后续明确的操作域）。

### 6.2 依据与理由

1. **桌面已冻结的读写分面**：查询面（core_get_status / core_get_run_snapshot / core_read_*_events / list_sessions / workbench_list_background_tasks / get_flow_snapshot）与操作面（core_run_control core_run_commands.rs:3592、core_cancel_run core_run_commands.rs:3706、core_approve_tool core_run_commands.rs:3750、core_deny_tool core_run_commands.rs:3777、workbench_cancel_background_task background.rs:2624、workbench_send_input background.rs:2651）在命令层天然分离，监控域直接**不注册**操作命令即可硬性保证只读（类似子代理工具面剔除 run_subagent 的防护先例，core_run_commands.rs:3110-3112）。
2. **安全基线**（docs/rust-rewrite/31-security-baseline.md）：移动端是低信任终端（可丢、可被拿走），高频只读观测不影响引擎；任何操作命令都要求更强认证与二次确认，放审批域统一做（D5 安全域与此对齐）。
3. **用户要求「移动端与桌面同权」的处理**：同权 = 移动端**可以**触达所有能力，不等于监控面板把操作铺满。操作面集中在审批域，监控域提供「去处理」跳转，路径上完成身份确认与二次确认，比在监控面板里散布按钮更安全也更不容易误触。
4. **run 暂停/恢复的归属建议**：`core_run_control` 的 L0-L3 语义（core_run_commands.rs:3585-3590）中，L2 协作停止 / L3 强停属于高风险操作，建议 F2 审批域以「run 控制」子页承载（带 run 当前状态 + 停止后果提示 + 二次确认）；L1 软注入（steer/follow_up）价值低且需要文本输入，P2 再议。**监控域只显示 run 状态与「可在审批域控制」的提示文案**。
5. **UI 铁律**：监控域任何页面不渲染操作按钮；待审批条目只渲染「去处理」跳转（跳 F2）。首页连接条/状态卡不可点击出操作。

### 6.3 网关侧强制（建议 D2/D3 落地时写死）

Companion 网关按域白名单命令：监控域白名单 = §2.1 只读清单（Q1-Q12 只读子集）；操作命令（core_run_control / core_cancel_run / core_approve_tool / core_deny_tool / workbench_cancel_background_task / workbench_send_input / core_run_task / core_rebuild_search_index）默认拒绝，仅 F2 域可声明访问，且每个操作命令要求 `confirmation_token`（D5 定义）。网关拒绝返回结构化错误（仿 `subagent.nesting_denied` 的先例，返回明确「监控域只读」语义，而非静默失败）。

### 6.4 网关请求与响应形状示例（本域消费面，建议 D3 照此裁剪）

监控域网关方法命名统一 `monitor.*` 前缀（只读），与操作面 `control.*` / `approval.*`（F2）天然分区：

```jsonc
// 请求 1：首页聚合（D2 网关可选实现；未实现时退化为三次独立调用）
POST /monitor/overview
{
  "include": ["coreStatus", "activeRuns", "pendingApprovals", "bgTaskSummary"]
}

// 响应（字段全部源自 Q1/Q7 冻结形状，网关只做裁剪与并集）
{
  "coreStatus": {
    "engineReady": true, "dbReady": true, "searchIndexReady": true,
    "compactionReady": false,                 // 未接线如实（core_query_commands.rs:161-162）
    "providerStatus": { "model": "deepseek-v4" },
    "backgroundTasks": { "activeCount": 1, "daemonCount": 1 }
  },
  "activeRuns": [
    { "runId": "r-1", "sessionId": "s-1", "status": "running",
      "startedAt": 1754700000000, "prompt": "检查 package.json" }
  ],
  "pendingApprovals": [
    { "toolCallId": "tc-9", "toolName": "shell:write", "runId": "r-1",
      "summary": "npm test 需要执行权限" }
  ]
}
```

```jsonc
// 请求 2：run 详情（状态 + 时间线两段式）
GET /monitor/run/r-1?afterSequence=0&maxEvents=200
{
  "snapshot": {                             // core_get_run_snapshot 原样
    "runId": "r-1", "sessionId": "s-1", "status": "running",
    "cursor": 42, "createdAt": 1754700000000, "updatedAt": 1754700030000,
    "usage": {                              // RunUsage（core_query_commands.rs:346-375）
      "promptTokens": 2100, "completionTokens": 1400, "totalTokens": 3500,
      "sampleCount": 3, "cacheReadTokens": 1800, "cacheWriteTokens": 120,
      "cacheMissTokens": 300, "hitRatio": 0.81
    }
  },
  "events": [
    { "type": "tool-end", "runId": "r-1", "sequence": 41,
      "schemaVersion": 1, "sessionId": "s-1", "batchId": "b-1",
      "result": { "id": "tc-9", "toolCallId": "tc-9", "output": "...", "isError": false } }
  ],
  "nextAfterSequence": 41, "hasMore": false
}
```

```jsonc
// 越权示例：监控域调用操作命令 → 网关统一拒绝（仿 nesting_denied 先例）
POST /monitor/run/r-1/control
{
  "error": { "kind": "domain_readonly", "detail": "monitor 域只读：请使用审批域操作" }
}
```

**口径约定**（全部沿用桌面冻结契约，移动端不改语义）：
- 时间统一 epoch 毫秒（snapshot.createdAt/updatedAt）与 ISO8601（事件 timestamp）并存，移动端展示层各取所需，不互相换算（避免精度漂移）。
- 金额估算在网关侧完成（pricingStore 口径，SettingsUsageTab.tsx:8-13），移动端不内置价格表（价格更新随桌面同步，F6 范围）。
- 命中率等派生值只在**有样本**时下发（None 语义，core_query_commands.rs:389-411），移动端收到 None 即隐藏，不做 0 填充。

---

## 7 体验要求

### 7.1 简洁与分区

- 每屏一个主任务：首页 = 看状态，会话 = 找会话，用量 = 看钱，诊断 = 排障；不做聚合大杂烩。
- 信息密度：首页首屏（不打滚）必须呈现 L0 连接 + L1 核心卡 + 至少 2 条活动任务；超过 5 条活动任务折叠为「展开全部」。
- 数字格式统一：tokens 千分位（`toLocaleString('zh-CN')`，SettingsUsageTab.tsx:27-30）；金额 4 位小数 `$0.1234`；时长 `Xm Ys`（对齐 overview/helpers formatElapsed）。

### 7.2 按钮与触控

- 可点击区域 ≥ 44pt；活动任务卡整卡可点（不做小图钉按钮）。
- 危险操作按钮**不存在于本域**（§6.1）；唯一按钮形态 = 跳转（→去处理 / →用量页 / →任务页 / 刷新 / 重试）。
- 刷新：首页下拉刷新 + 诊断页按钮刷新 + 详情页右上刷新按钮；轮询与手动刷新互不打断（seq 守卫，对齐 useOverviewState.ts:233-242 的 git 刷新 seq 模式）。

### 7.3 深色模式

- 跟随系统 + 手动三选；两套色板均为原生实现（无框架依赖）；对比度满足 WCAG AA（状态圆点 + 文字双通道）。
- 图表（用量柱状图）深浅两套样式；空态插画随主题切换。

### 7.4 空态 / 加载态 / 离线态

- 见 §4.7 全局规范。要点重申：**无数据 = 空态（绝不显示 0% / 0 tokens 误导）**；**断线 = 灰化旧数据 + 横幅，不伪造新数据**；骨架屏只出现在首次加载。

### 7.5 通知与角标联动

- 推送点击 → 深链到对应页面：approval-requested → F2 审批处理页；run-terminal(failed) → run 详情；task-failed → 任务页；cache-waste-alert → 用量页缓存区。
- 角标与推送去重：同 runId+toolCallId 的 approval-requested 重复投递只计一次（事件有 sequence，可去重，events.rs:905-933）。
- 免打扰：21:00-08:00 默认静默（仅保留审批推送），开关在 F6 设置页。

### 7.6 深链与导航规则

**深链协议**（推送点击 / 跨域跳转统一走 schema，形如 `crish://monitor/run/r-1`）：

| 深链 | 目标 | 用途 |
|------|------|------|
| `crish://monitor/home` | 首页 | 默认 |
| `crish://monitor/run/{runId}` | run 详情 | run-terminal(failed) 推送 |
| `crish://monitor/sessions` | 会话列表 | 会话通知 |
| `crish://monitor/tasks` | 任务页 | task-failed / task-killed 推送 |
| `crish://monitor/usage` | 用量页 | cache-waste-alert 推送 |
| `crish://monitor/diagnostics` | 诊断页 | lastError 产生时引导 |
| `crish://approval/{requestId}` | F2 审批处理页 | approval-requested 推送（跨域深链） |

**导航规则**：
- 推送深链打开 app → 目标页入栈；返回键回首页（不堆叠中间页）。
- 跨域跳转（监控 → F2 审批处理）返回后回到发起页并刷新（角标收敛）。
- 深链目标数据不存在（run 已归档/会话已删）→ 显示对应空态 + 返回首页，不崩溃。
- 顶部导航恒定显示「← 返回」与「刷新」；连接状态条恒在状态栏下方（不随页面滚动消失）。

---

## 8 测试点（每个功能的验证场景）

### 8.1 连接层（F01）

| # | 场景 | 预期 |
|---|------|------|
| T01 | 桌面在线，打开 app | 连接条绿「已连接」，核心卡 4s 内出数据 |
| T02 | 桌面关闭/网络断开，打开 app | 连接条红「桌面端离线」，旧数据灰化 + 「数据可能过期」横幅；不显示伪造状态 |
| T03 | 断开后桌面恢复 | 指数退避重连成功，自动全量刷新，横幅消失 |
| T04 | 查询超时（8s） | 显示「连接异常」+ 重试按钮；页面其余部分保持旧快照 |
| T05 | 前后台切换 | 前台恢复时立即重拉一次（不等 4s 轮询周期） |

### 8.2 首页核心卡与活动任务（F02/F03）

| # | 场景 | 预期 |
|---|------|------|
| T06 | 无 run 无审批 | 活动区空态「当前无活动任务」；核心卡全绿 |
| T07 | 一个 run 运行中 | 活动列表显示 run 条目 + 递增时长（1s 步进）；核心卡不变 |
| T08 | 待审批 2 项 | 审批条目置顶，徽标=2；点击跳 F2（断言跳转参数 toolCallId） |
| T09 | 桌面端在 F2 处理掉 1 项 | 角标 2→1（approval-resolved 事件驱动）；4s 轮询兜底收敛 |
| T10 | run 终态（completed） | 条目移出活动列表；run 详情终态条绿 |
| T11 | run 终态（failed） | 条目移出；推送通知（若在前台则不弹，仅页内横幅） |
| T12 | engineReady=false | 核心卡胶囊红「引擎异常」；其余子系统如实展示（不硬编码 true） |

### 8.3 run 详情（F04）

| # | 场景 | 预期 |
|---|------|------|
| T13 | 打开运行中 run | 状态条蓝；事件时间线最新在上；usage 卡显示真实 token（有样本时） |
| T14 | 时间线 >200 条 | 上拉翻页按游标加载，hasMore=false 显示「已全部加载」 |
| T15 | 打开已终态 run | 终态条 + endReason + error 全文（failed）；时间线可一次翻完 |
| T16 | usage 无样本 | 用量卡整体隐藏（不显示 0/0/0） |
| T17 | 命中率 None | 缓存子卡隐藏命中率行，保留读/写 tokens |
| T18 | 事件流断线重连 | 以 lastSequence 游标续拉增量，不重复不跳条 |

### 8.4 会话列表（F05）

| # | 场景 | 预期 |
|---|------|------|
| T19 | 有活动会话 | 置顶 + 绿/黄点标记；点击进该会话最新 run 详情 |
| T20 | 会话无 run | 点击显示「该会话暂无 run」空态 |
| T21 | 会话数量多（>50） | 虚拟列表流畅滚动（只渲染可视区） |
| T22 | 桌面新建会话 | 4s 轮询后出现（或事件驱动提前出现） |

### 8.5 用量与缓存（F07/F08）

| # | 场景 | 预期 |
|---|------|------|
| T23 | 有历史用量 | 摘要卡 + 7/14 日图表正确；金额与桌面 pricingStore 口径一致（±0 误差） |
| T24 | 无任何用量 | 空态「暂无用量数据」，不显示 $0.000 |
| T25 | cache-waste-alert 到达 | 用量页预警列表新增一行（归因 + tokens + $）；推送通知 |
| T26 | cold-cache-warning | 显示「🧊 缓存已过期 · 下次重发 ~X tokens」 |
| T27 | 模型分布命中率无数据 | 该模型行不显示 0% 误导 |

### 8.6 后台任务与诊断（F09/F11/F12）

| # | 场景 | 预期 |
|---|------|------|
| T28 | 任务 running | 任务页显示运行中 + 时长 |
| T29 | task-failed | 推送 + 任务页显示失败 + tail 前 3 行 |
| T30 | task-suspicious | 黄条「疑似卡死」；可重复出现 |
| T31 | 诊断页无错误 | 「无错误记录」空态（CheckCircle 样式） |
| T32 | 诊断页有 lastError | kind 徽标 + detail + 时间；长按可复制 |
| T33 | 诊断环形 20 条 | 最新在前（reverse 后）；第 21 条挤掉最旧 |
| T34 | runtime-error 事件 | run 详情顶部错误横幅（带 retryable 标记） |

### 8.7 权限与安全（§6）

| # | 场景 | 预期 |
|---|------|------|
| T35 | 监控域页面不出现任何操作按钮 | UI 遍历断言：监控域路由的按钮白名单 = {跳转/刷新/重试} |
| T36 | 越权调用操作命令（网关直发 core_cancel_run） | 网关拒绝，返回「监控域只读」结构化错误；监控域不渲染该错误为可恢复操作 |
| T37 | 待审批跳转 F2 | 深链携带 toolCallId/sessionId；F2 返回后角标正确收敛 |
| T38 | 深色模式切换 | 全部页面（含图表/插画/横幅）无明暗残留；对比度 AA |

### 8.8 边界与容错

| # | 场景 | 预期 |
|---|------|------|
| T39 | 桌面返回 unknown run 状态 | 显示「状态未知」灰态，不崩溃 |
| T40 | 事件载荷损坏 | 分页解析跳过损坏行（core_query_commands.rs:483-491 防御），不整页失败 |
| T41 | 轮询与下拉刷新并发 | seq 守卫：后发结果覆盖先发，不闪旧数据 |
| T42 | 通知重复投递 | sequence 去重，角标不重复计数 |
| T43 | 弱网（Fast 3G 模拟） | 首页 4s 轮询自动降级为 15s；下拉刷新仍可用；数据横幅「可能过期」 |

### 8.9 状态机专项测试（对照 §5.6 迁移表）

| # | 场景 | 预期 |
|---|------|------|
| T44 | queued → running 迁移 | 活动列表「排队中」灰 →「运行中」蓝；不闪黄 |
| T45 | running → awaiting-approval（approval-requested） | 状态条黄 + 角标 +1 + 条目置顶；推送（后台时） |
| T46 | awaiting-approval → running（approved） | 状态条蓝 + 角标 −1；时间线出现 approval-resolved 行 |
| T47 | awaiting-approval → running（denied/expired） | 同上 + 时间线决策为 denied/expired；无推送 |
| T48 | running → completed（run-terminal） | 终态绿；移出活动列表；用量卡刷新为终值 |
| T49 | running → failed | 终态红 + error 全文 + 推送；点击推送进详情页定位终态条 |
| T50 | running → cancelling → cancelled（force_cancel） | 短暂红「取消中」→「已取消」淡红；移出列表 |
| T51 | 状态未知（unknown 字面量） | 「状态未知」灰态；后续事件到达可正常迁移（不锁死） |
| T52 | 事件与快照终态冲突 | 以 run-terminal 事件为准（有 sequence 序） |
| T53 | 桌面重启恢复（restore pending + interruptedCount=2） | 顶部横幅「恢复中 · 2 个 run 被中断」；完成后横幅消失并全量重拉 |
| T54 | 恢复失败（restore failed） | 诊断页 restore 行红 + 原因；其余功能不受阻 |

### 8.10 深链与导航测试

| # | 场景 | 预期 |
|---|------|------|
| T55 | 推送点击 run failed 通知 | 直达 run 详情终态条；返回回首页 |
| T56 | 推送点击审批通知 | 直达 F2 审批处理页；返回回首页并角标收敛 |
| T57 | 深链目标 run 已归档 | 空态「该 run 已归档」+ 返回首页可用 |
| T58 | 前台收到推送事件 | 不弹系统通知，仅页内实时更新（推送去重） |
| T59 | 免打扰时段审批推送 | 放行；run failed 静默积压为应用内列表 |

### 8.11 性能与流量

| # | 场景 | 预期 |
|---|------|------|
| T60 | 首页首拉耗时 | 网关聚合 ≤500ms（退化为三次独立调用时 ≤1s）；骨架屏可见 |
| T61 | 4s 轮询节流 | 前台可见才轮询；后台/熄屏零轮询（对齐 useEngineState.ts:135-140） |
| T62 | 事件增量合流 | message-delta 节流合并（60ms 窗口），详情页无抖动 |
| T63 | 时间线 1000+ 条翻页 | 游标分页稳定，无重复无遗漏（序列单调） |
| T64 | 弱网降级 | 首页轮询 4s→15s；横幅「数据可能过期」 |

---

## 9 里程碑与依赖

> 【裁决修正 9】阶段映射（统一 R0-R5）：M1 网关/协议/白名单 → R0/R1；M2 P0
> 五件 → **R2 移动端基础**；M3 P1 六件 → R2 后半（依赖 R3 推送通道的条目随
> R3）；M4 P2 六件 → R3 后/R2 扩展。任务书引用一律使用 R 阶段号。

| 里程碑 | 内容 | 依赖 |
|--------|------|------|
| M1 | D1-D3 落地：网关 + 协议 + 只读命令白名单 | D1/D2/D3（本域提供 §6.3 白名单输入） |
| M2 | P0 五件（F01-F06）：连接条/核心卡/活动任务/run 详情/会话列表 + 空载离三态 | M1 |
| M3 | P1 六件（F07-F12）：用量/缓存/后台任务/审批徽标/诊断/错误横幅 | M2 + D7 推送通道 |
| M4 | P2 六件（F13-F18） | M3 |
| 常驻 | 状态映射表（§5）与桌面枚举漂移监控：新增 RunStatus/事件变体时，手机端映射表须同步（注册表漂移护栏思路同 tests/registry_drift.rs，events.rs:7-8） | 引擎侧事件注册表 |

---

## 10 风险与未决

1. **网关聚合开销**：首页一次刷新 = core_get_status + list_sessions + workbench_list_background_tasks 三次查询；若延迟不达标（>500ms），需 D2 网关提供 `companion_overview` 聚合端点（本域推荐，但实现归 D2/D3）。
2. **推送与查询的双通道计数收敛**：审批角标依赖事件增量 + 查询兜底；极端丢推送场景下角标可能短暂滞后（下轮轮询收敛），可接受。
3. **桌面 usageStore 历史数据的移动端可见性**：本域只消费网关缓存与 run 级 usage；完整历史统计（7/14 日图）依赖桌面 pricingStore/usageStore 数据经同步域导出（F6/同步域范围）。
4. **unknown 状态的展示**：透传保真（runs.rs:17-19），但移动端文案「状态未知」可能让用户困惑；后续可加「查看桌面端」引导深链。
5. **本设计不新增任何引擎侧代码**：全部复用冻结契约；若评审发现需要新字段（如 activeRuns 缺 prompt 摘要），走既有 F2 串行增量流程（core_query_commands.rs:4-16 的字段契约纪律）。
