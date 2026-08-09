# D7 推送通知体系设计方案（多端互通 · 桌面事件源 → 移动端被动接收）

> 文档性质：设计方案（子代理 D7 交付物）
> 产出日期：2026-08-09
> 状态：草案，待评审（PE 计划会汇入）
> 读者：主 Agent、移动端子代理（D8 及后续）、引擎/前端实现子代理、评审人
> 输入依据：任务书（D7 推送通知体系设计）；代码调研（crates/conex-types、crates/session-loop handlers、apps/agent-workbench/src-tauri/src、apps/crish-desktop/src）；网络查证（Expo 官方文档、华为 HMS 插件仓库、统一推送工作委员会资料）
> 禁止阅读范围遵守声明：未读取 `reference/**`、`apps/crish-mobile/**`、`docs/**`、`node_modules/**`、`target/**`；本文件为唯一写产物。

---

## 摘要（结论先行）

- **场景数**：从 AgentEvent **41 个变体**（任务书写 27，实际代码已演进到 41，见 §1.2 勘误）中筛选出 **13 个值得推送的事件场景**，分 P0/P1/P2/P3 四级（§3），其中 **P0 必达 6 类**（审批请求、审批过期、run 失败、子代理失败、任务失败、安全拦截），P1 重要 4 类（run 完成、子代理完成、任务完成、定时器/cron 到期），P2 可折叠 3 类（缓存告警等），其余 28 类不推送。
- **架构结论**：采用**分层推送架构——在线 WS 直推优先 + 离线厂商通道兜底**。桌面端（Tauri 进程内）内置轻量 WS 中继与推送策略引擎；移动端在线时走 WS（零成本、全量数据），离线/后台被系统杀死后走厂商通道（摘要级、低延迟）。自建云中继列为 M3 可选演进，不进入本方案一期。
- **国内通道结论**：**国内安卓无 GMS，Expo Push Service（exp.host）对国内安卓不可用**（Android 侧必须 FCM token，FCM 被墙；exp.host 服务器托管在美国 GCP，国内直连不稳定）；**UMS（统一推送工作委员会）只是「规范统一、各家自营」，没有统一的推送服务器**，华为/荣耀名义适配但实际仍走自家 HMS 推送；因此国内安卓必须**逐厂商接入通道**（HMS/小米/vivo/OPPO/荣耀），Expo 生态下需 `prebuild` 出原生工程后集成厂商 SDK（`@hmscore/react-native-hms-push` 等），`expo-notifications` 仅承担本地通知/前台呈现/点击跳转能力。一期建议先接**聚合通道（个推/极光）或仅接 HMS 验证链路**，二期铺全矩阵。

---

## 目录

1. 任务背景与勘误
2. 现状盘点（可复用资产）
3. 推送场景清单（核心交付 1）
4. 推送架构设计（核心交付 2）
5. 国内安卓厂商通道矩阵（核心交付 3）
6. 桌面端推送生成（核心交付 4）
7. 移动端接收（核心交付 5）
8. 配置与密钥（核心交付 6）
9. 与现有代码融合（核心交付 7）
10. 测试方案（核心交付 8）
11. 风险与缓解（核心交付 9）
12. 里程碑分期
13. 附录

---

## 1. 任务背景与勘误

### 1.1 任务书要点回顾

本任务为「crish 多端互通」子任务 D7。多端互通中移动端的核心价值是：**桌面端有动作时，手机能收到通知**。典型诉求：

- 桌面端 Agent 发起**审批请求**时，用户在手机端及时看到并处理（审批不能漏）；
- 桌面端 **run 完成 / 失败**时，手机端收到结果摘要；
- **子代理完成**、**后台任务完成/失败/卡死**、**定时器/cron 到期**、**异常**等事件按需通知；
- 桌面端是事件源，移动端是被动接收；
- 国内安卓无 GMS，推送必须走厂商通道。

任务书要求的覆盖点（对照本方案章节）：

| 任务书要求 | 本方案章节 |
| --- | --- |
| 1. 推送场景清单（触发条件 + 防打扰） | §3 |
| 2. 推送架构三路线评估 + 国内厂商通道矩阵 | §4、§5 |
| 3. 桌面端推送生成（映射/敏感度/在线协同） | §6 |
| 4. 移动端接收（前台/后台/点击跳转/权限/iOS 差异） | §7 |
| 5. 配置与密钥（存哪/环境隔离） | §8 |
| 6. 与现有代码融合（文件:行号）+ 审批优先级 | §9 |
| 7. 测试（mock/离线/跳转/真机清单） | §10 |
| 8. 风险（审核/配额/碎片化/Expo 支持度） | §11 |

### 1.2 事件数量勘误：27 → 41

任务书表述为「从 AgentEvent 27 变体（读 events.rs 确认）筛选」。**实际代码中 AgentEvent 已演进为 41 个变体**：

- `crates/conex-types/src/events.rs:3` 模块文档明确写「[AgentEvent] 是 41 种域事件的 serde tagged enum」；
- `events.rs:295-296` 记录演进史：「2026-08-05 T-CF-04 定时器域兼容新增 2 变体（timer-fired/timer-cancelled），38 → 40；同日 T-CF-08 cron 域兼容新增 1 变体（cron-fired），40 → 41」；
- `events.rs:804-805` 的 `ALL_TYPE_NAMES` 宏展开清单即 41 项（agent-start 到 cron-fired，见 events.rs:810-852）。

27 应为更早基线（约 24-27 时代的计数，`events.rs:937` 残留注释「v1 = 当前 24 事件基线」也印证基线曾经很小）。**本方案按 41 变体全量筛选**，表格覆盖全部事件，避免因版本漂移漏筛。

### 1.3 阅读范围与调研方法

允许读取（按任务书）：

| 路径 | 用途 |
| --- | --- |
| `crates/conex-types/**` | 事件类型契约（41 变体、背压分级、信封结构） |
| `crates/session-loop/src/loop/handlers/` | 审批/事件产生点 |
| `apps/agent-workbench/src-tauri/src/` | 事件桥、审批流、后台任务、唤醒摘要 |
| `apps/crish-desktop/src/` | 前端通知/toast 现状、事件消费面 |

网络查证（webfetch，无需 firecrawl）：

| 查证项 | 来源 | 结论 |
| --- | --- | --- |
| Expo Push Service 概览与可用性 | docs.expo.dev/push-notifications/overview + sending-notifications | exp.host 托管于美国（GCP US），Android 必须 FCM token，无 SLA；国内安卓不可用 |
| Expo 推送设置（token/凭证） | docs.expo.dev/push-notifications/push-notifications-setup | Android 必须配置 FCM v1；`expo-notifications` 是推送服务无关的 |
| expo-notifications SDK（SDK 57） | docs.expo.dev/versions/latest/sdk/notifications | 本地通知/前台 handler/渠道/点击跳转能力全；Expo Go 安卓 SDK 53 起不支持远程推送，必须 dev build |
| 华为 HMS React Native 插件 | github.com/HMS-Core/hms-react-native-plugin | 官方 `@hmscore/react-native-hms-push`（Apache-2.0，265 star），海外版另有 `react-native-hms-push-fcm` |
| 统一推送现状 | zh.wikipedia.org/wiki/统一推送工作委员会 | 2017 联盟 → 2022 升格委员会；规范统一、各家自营；华为/荣耀名义适配实际自家推送；无统一推送服务器 |

### 1.4 术语表

| 术语 | 含义 |
| --- | --- |
| 事件（AgentEvent） | 引擎域事件，41 变体 serde tagged enum，顶层 `type` 为 kebab-case wire 名（events.rs:306） |
| 信封（AgentEventEnvelope） | 发射层注入 runId/sequence/schemaVersion 的扁平顶层 JSON（events.rs:921-932） |
| 背压分级 | Delta 可丢 / Soft 尽力 / Critical 必达（events.rs:179-188），事件 → 级别映射见 events.rs:867-893 |
| 推送（PushMessage） | 本方案定义的跨平台推送消息（§6.2 schema），与事件解耦 |
| 在线直推 | 移动端与桌面端建立 WS 长连接时，桌面直接把通知推给手机应用内呈现 |
| 厂商通道 | 华为 HMS / 小米 / vivo / OPPO / 荣耀等国内厂商自营的推送系统（无 GMS 设备的唯一离线兜底） |
| 聚合通道 | 个推（GeTui）、极光（JPush）等第三方，一套 SDK 聚合多家厂商通道 |
| UMS | 统一推送工作委员会（原联盟）推动的统一推送规范，各家厂商自营实现 |
| 静默时段 | 用户配置的免打扰时间窗（默认 22:30-07:30） |
| 折叠/合并 | 多条推送按规则合并为一条摘要通知 |
| 去重 | 同一事件的重复推送抑制（同 dedupeKey + 时间窗） |

---

## 2. 现状盘点（可复用资产）

### 2.1 事件面：AgentEvent 41 变体与背压分级

事件契约（`crates/conex-types/src/events.rs`）是本方案的地基。关键事实：

1. **事件与推送天然同源**：引擎所有值得推送的事件都已经有结构化事件产出，推送层不需要自己发明触发点，只需在事件出口旁挂一个「推送意图判定器」。
2. **背压分级可以直接映射推送优先级**：
   - `event_backpressure()`（events.rs:867-893）把事件分为 Delta（可丢）/ Soft（尽力）/ Critical（必达）；
   - 推送分层可对齐：**Critical ≈ 至少进厂商通道**，Soft ≈ 仅在线直推，Delta ≈ 不推。
3. **审批载荷完整**：`ApprovalRequested`（events.rs:479-484）携带 `request: PermissionRequest`（events.rs:194-218），含 `toolCallId`（必填）、`toolName`、`parameters`、`summary`、`cwd`，以及 T-D-14 权限传递层的 `requester_run_id` / `reason`（子代理申请理由）——推送文案可以直接从这些字段生成，**审批请求甚至可以在不查询数据库的情况下渲染完整通知**。
4. **终态语义完整**：`RunTerminalStatus`（completed/cancelled/failed，events.rs:29-36）、`SubagentEndStatus`（completed/failed/cancelled，events.rs:156-165）、`RunTerminal`（events.rs:510-519，含 error 可选字段）、`AgentEndReason` 等，判定「完成/失败/取消」无需猜测。
5. **安全域有专属事件**：`SecurityAudit`（events.rs:556-577）带 `operation`（delete/trash-restore/trash-purge/git-revert/command-exec/undeclared-write）、`decision`（blocked/approved/denied/redirected/restored/purged）、`impact` 影响面——「红线拦截」等用户必须知道的操作有现成事件源。
6. **定时器/cron 有 prompt 文案**：`TimerFired`（events.rs:737-746）与 `CronFired`（events.rs:765-781）自带 `prompt` 字段，是现成的通知正文。

### 2.2 桥接面：Emitter 抽象与 workbench-run-event

`apps/agent-workbench/src-tauri/src/core_event_bridge.rs` 是**推送接入的天然挂点**：

- `Emitter` trait（core_event_bridge.rs:51-54）：`fn emit(&self, channel: &str, payload: &str)`——一个发射抽象，测试替身友好；
- `TauriEmitter`（core_event_bridge.rs:57-81）：`app.emit("workbench-run-event", payload)`，发射失败仅 warn 不阻断；
- `EventBridge`（core_event_bridge.rs:83-145）：信封序列化 + 发射，通道名恒为 `workbench-run-event`；
- 装配点在 `main.rs:344-348`（`EventBridge::new("workbench-run-event", Arc::new(TauriEmitter::new(app_handle)))`）。

**推送改造的关键洞察**：`Emitter` 已经抽象了「发射到哪」，我们可以新增一个 `PushAwareEmitter`（装饰器）或更优雅地在 `BufferedRunEventBridge` flush 路径上挂监听（§9.2 详述），让**事件流经过推送策略引擎，零侵入既有发射路径**。

补充事实：任务事件桥另有一条生产发射链（`main.rs:397-399`、`background.rs:2001`、`task_event_consumer.rs:242`），timer/cron 缓冲事件由 500ms drain loop 转发（`main.rs:430-441`）——这是**「缓冲 + 周期 drain」推送去重/合并的现成先例**。

### 2.3 前端 toast 现状（防打扰策略可对齐的现成语义）

`apps/crish-desktop/src/hooks/useToastQueue.ts` 已经沉淀了一套成熟的**通知策略**，移动端推送防打扰可以直接对齐：

- `TOAST_TTL_MS = 5000`、`TOAST_MAX_QUEUE = 5`（useToastQueue.ts:55-58）——时间与数量上限；
- **成功文案禁入 toast**：`FORBIDDEN_SUCCESS_TOAST_PATTERNS`（useToastQueue.ts:75-144）禁止「已保存/已完成/已批准」等成功回流，允许的只有错误/用法/降级/可撤销（:147-180）——**移动端推送也可以继承「成功不打扰」产品语义**；
- **去重键** `toastDedupeKey = 归一文案 + 是否可撤销`（useToastQueue.ts:258-260），同文案只叠一层、刷新 TTL——推送去重键设计可对齐（§3.4）；
- 横幅侧同文案去重窗口已存在（`chat-stream/index.ts:12`「横幅同文案去重窗口（对齐 toast dedupe 语义）」）。

前端事件消费面（移动端可复用模式）：

- `tauriTransport.ts:30` `RUN_EVENT_CHANNEL = 'workbench-run-event'`；
- `dataPlaneRouter.ts:59-70` 数据面 10 类事件（task-* 7 + timer-* 2 + cron-fired）全局路由；
- `dataPlaneRouter.ts:185-189` 子代理面 3 类事件（subagent-started/event/ended）跨 run 全局兜底路由；
- `dataPlaneRouter.ts:211-212` `_liveParentRuns` 活跃父 run 集合（128 上限淘汰）——**移动端「哪些 run 还在跑」的在线语义可以照搬**。

### 2.4 唤醒摘要资产（推送文案的现成中文模板）

`apps/agent-workbench/src-tauri/src/wakeup_summary.rs` 是**推送文案生成的现成资产**：

- `wakeup_summary()`（wakeup_summary.rs:63-135）把事件映射为中文摘要，覆盖六类唤醒源：
  1. 子代理完成 → 「子代理 <role>（<id>）已完成：<status>」；
  2. run 终态 → 「任务 <id> 已运行 <duration>，退出码 <code>」；
  3. 定时器到期 → 「<prompt>（定时器 <id> 已到期）」；
  4. cron 触发 → 「<prompt>（cron <id> 第 <n> 次触发）」；
  5. 后台任务完成 → 「任务 <id> 已运行 <duration>，日志已累积 <lines> 行，最近输出 <ts>」；
  6. 恢复通知走 orchestrator steering_text，不经本模块；
- 纯函数、无状态、可单测（wakeup_summary.rs:263-447 已有全套测试）；
- 未覆盖事件有「收到事件 <type>」通用回退（wakeup_summary.rs:133）。

**结论**：推送文案模板 = `wakeup_summary` 的职责扩展（新增 approval-requested / run-failed / security-audit 等 arm，或新建 `push_copy.rs` 复用其风格与测试模式）。文案风格统一走「中文、无占位符残留」护栏（wakeup_summary.rs:393-447 有占位符校验测试先例）。

### 2.5 桌面端进程模型

- 引擎（session-loop / orchestrator / agent-provider）运行在 **Tauri 进程内**（`main.rs:290-457` setup 装配），前端通过 Tauri IPC 与 `workbench-run-event` 事件通道消费事件——**当前无任何对外网络监听**（tauriTransport.ts:17「不依赖 WebSocket：无心跳、无重连（进程内核心）」）；
- 已有网络能力的先例：`reqwest` 客户端（engine.rs:323-324 共享连接池）、`dev_mcp.rs` 的调试 socket（CRISH_MCP_SOCKET）、`core_run_commands.rs:5295` 测试用 `tokio::net::TcpListener::bind("127.0.0.1:0")`——**桌面端开一个监听端口在技术栈上完全可行**；
- 桌面端是事件源：应用退出 = 事件源消失。**「桌面关机则无推送」是架构固有属性**，本方案一期接受（自建中继 M3 才解决），§11.4 有风险说明。

### 2.6 现状缺口分析

| 缺口 | 现状 | 本方案填补 |
| --- | --- | --- |
| 无推送意图判定 | 事件全部进 `workbench-run-event`，无「该不该推/怎么推」决策层 | §3 场景清单 + §6 桌面端策略引擎 |
| 无移动端通道 | 无 device 注册表、无 token 管理、无厂商凭据 | §5 厂商矩阵 + §8 配置 |
| 无在线状态面 | 前端无对外长连接 | §4.4 WS 中继 + 在线状态机 |
| 无推送文案 | 只有唤醒摘要（六类） | §6.5 扩展文案模板 |
| 无推送测试 | 无厂商 mock | §10 全套测试方案 |

---

## 3. 推送场景清单（核心交付 1）

### 3.1 筛选原则

从 41 事件筛推送的判定顺序（实现为纯函数 `push_intent(event) -> Option<PushIntent>`）：

1. **用户必须行动**（审批请求/审批过期/安全拦截/需人工介入）→ 必达；
2. **结果类终态**（run 完成/失败/取消、子代理完成/失败、任务完成/失败/卡死、定时器/cron 到期）→ 按价值与频率分级；
3. **过程类增量**（message-delta、tool-start/end、task-output、task-heartbeat、subagent-event）→ 一律不推（价值低、噪音高）；
4. **诊断/观测类**（provider-diagnostic、cache-stats-updated、checkpoint-*、turn-*）→ 不推；
5. 复用事件自带分级：**背压 Critical 是「值得考虑推送」的必要不充分条件**（Delta 一定不推，Soft 只在特殊场景推），推送分级比背压更严。

推送四级定义：

| 级别 | 定义 | 在线直推 | 厂商通道 | 静默时段 | 示例 |
| --- | --- | --- | --- | --- | --- |
| P0 必达 | 用户必须知道/行动，漏了有实际损失 | 立即 | 立即（高优先级） | 仍发（可选静音） | 审批请求、审批过期、run 失败、安全拦截 |
| P1 重要 | 结果/进展，用户大概率关心 | 立即 | 立即 | 折叠进夜间摘要 | run 完成、子代理完成、任务完成 |
| P2 可折叠 | 信息价值有限，可合并 | 立即 | 合并窗口后发 | 不推 | 缓存浪费告警、任务启动 |
| P3 不推 | 噪音 | — | — | — | message-delta、tool 全系、task-output 等 |

### 3.2 41 事件全量筛选表

事件 wire 名对照 `events.rs:810-852`；背压列对照 `events.rs:867-893`。

| # | 事件（wire 名） | 变体（代码位置） | 背压 | 推送级别 | 推送理由 |
| --- | --- | --- | --- | --- | --- |
| 1 | agent-start | events.rs:309-314 | Critical | P3 不推 | run 启动是过程态，噪音 |
| 2 | agent-end | events.rs:317-323 | Critical | P3 不推（由 run-terminal 收敛） | agent-end 与 run-terminal 信息重复，避免双推 |
| 3 | turn-start | events.rs:327-332 | Critical | P3 不推 | 过程态 |
| 4 | turn-end | events.rs:334-340 | Critical | P3 不推 | 过程态 |
| 5 | message-start | events.rs:344-348 | Critical | P3 不推 | 对话流不推送 |
| 6 | message-delta | events.rs:350-356 | Delta | P3 不推 | 增量噪音 |
| 7 | message-end | events.rs:359-367 | Critical | P3 不推 | 对话流不推送 |
| 8 | tool-start | events.rs:371-377 | Critical | P3 不推 | 工具过程噪音 |
| 9 | tool-update | events.rs:379-386 | Critical | P3 不推 | 进度增量 |
| 10 | tool-end | events.rs:388-394 | Critical | P3 不推 | 工具结果展示在桌面端即可 |
| 11 | tool-batch-start | events.rs:396-403 | Critical | P3 不推 | 前端显式 ignore 的事件 |
| 12 | tool-batch-end | events.rs:405-411 | Critical | P3 不推 | 同上 |
| 13 | tool-input-repaired | events.rs:413-420 | Critical | P3 不推 | 修复过程，低价值 |
| 14 | context-compression-start | events.rs:424-430 | Critical | P3 不推 | 内部机制 |
| 15 | context-compression-end | events.rs:432-441 | Critical | P3 不推 | 内部机制 |
| 16 | provider-diagnostic | events.rs:445-450 | Critical | P3 不推 | 仅前端 logInternalError |
| 17 | runtime-error | events.rs:453-460 | Critical | **P0** | 运行期错误，用户需知情（§3.3 S10） |
| 18 | runtime-steering | events.rs:462-468 | Critical | P3 不推 | steering 注入消息，内部机制 |
| 19 | runtime-intervention-required | events.rs:470-477 | Critical | **P0** | 需人工介入，候选动作清单（§3.3 S10b） |
| 20 | approval-requested | events.rs:479-484 | Critical | **P0 最高** | 审批不能漏（§3.3 S1） |
| 21 | approval-resolved | events.rs:487-495 | Critical | P2（仅 expired 推） | approved/denied 是桌面端发起的决策回执，移动端处理完自然知道；**expired 必须推**（§3.3 S2） |
| 22 | checkpoint-created | events.rs:497-502 | Critical | P3 不推 | 内部机制 |
| 23 | checkpoint-restored | events.rs:504-509 | Critical | P3 不推 | 内部机制 |
| 24 | run-terminal | events.rs:511-519 | Critical | **P0/P1** | 终态：failed→P0、completed→P1、cancelled→P1（§3.3 S3/S4/S5） |
| 25 | cache-stats-updated | events.rs:525-529 | Critical | P3 不推 | 测量展示 |
| 26 | cache-waste-alert | events.rs:532-543 | Critical | **P2** | 浪费告警可折叠（§3.3 S12） |
| 27 | cold-cache-warning | events.rs:546-554 | Critical | P3 不推 | 前端 tick 驱动的冷缓存提示，不推 |
| 28 | security-audit | events.rs:559-577 | Critical | **P0（部分）** | 仅 decision ∈ {blocked, purged} 推；approved/denied 由桌面端审批流已展示；redirected/restored 低价值（§3.3 S11） |
| 29 | subagent-started | events.rs:583-603 | Critical | P3 不推 | 过程态 |
| 30 | subagent-event | events.rs:606-612 | Delta/Soft | P3 不推 | progress 可丢，message/tool 尽力，均不推 |
| 31 | subagent-ended | events.rs:615-626 | Critical | **P0/P1** | failed→P0、completed→P1、cancelled→P1（§3.3 S6/S7） |
| 32 | task-started | events.rs:635-648 | Critical | P2 | 长任务启动可告知（§3.3 S8a） |
| 33 | task-output | events.rs:651-665 | Delta | P3 不推 | 增量噪音 |
| 34 | task-heartbeat | events.rs:667-675 | Delta | P3 不推 | 心跳噪音 |
| 35 | task-suspicious | events.rs:677-687 | Soft | **P0** | 任务疑似卡死需用户知情（§3.3 S8c） |
| 36 | task-completed | events.rs:690-701 | Critical | **P1** | 后台任务完成（§3.3 S8b） |
| 37 | task-failed | events.rs:703-715 | Critical | **P0** | 任务失败必达（§3.3 S8d） |
| 38 | task-killed | events.rs:718-728 | Critical | P1 | 任务被终止（用户主动 kill 时可不推，需与 kill 来源联动，§3.3 S8e） |
| 39 | timer-fired | events.rs:737-746 | Critical | **P1** | 定时器到期带 prompt（§3.3 S9a） |
| 40 | timer-cancelled | events.rs:749-758 | Soft | P3 不推 | 取消通知，低价值 |
| 41 | cron-fired | events.rs:768-781 | Critical | **P1** | cron 触发带 prompt（§3.3 S9b） |

**筛选统计**：P0 6 类（含 runtime-error/runtime-intervention-required、security-audit 部分、task-suspicious）+ P1 4 类 + P2 3 类 = 13 类值得推送（security-audit 按 decision 子集、run-terminal 按终态子集、approval-resolved 仅 expired 子集，实际触发条件更细，见 §3.3 场景明细）。

### 3.3 场景明细（触发条件 / 文案 / 优先级 / 防打扰）

每个场景给出：触发事件与字段、推送级别、标题/正文模板、去重键、合并规则、静默时段行为、点击跳转目标（跳转映射总表见 §7.4）。

#### S1 审批请求（P0 · 必达最高优先）

- **触发**：`approval-requested`（events.rs:479-484），`request.toolCallId` 必填（events.rs:198）；
- **字段**：`toolName`、`summary`、`parameters`、`cwd`、`requester_run_id`/`reason`（T-D-14，子代理申请理由）；
- **文案**：标题「Crish 需要你的批准」；正文「<toolName>：<summary 摘要前 60 字>」；子代理来源追加「（由 <role> 子代理申请）」与理由；权限模式信息可选带出；
- **去重**：`dedupeKey = approval-requested:{toolCallId}`——同一次审批绝不重推；
- **合并**：同 batch 的多项审批（`tool_exec.rs:384`「审批逐个发起：approval-requested 事件全组先发」）**合并为一条**「有 N 项操作待批准」；桌面端审批弹窗已有同类合并语义（`useChatApprovalHandlers.ts:34-37` `collectPendingApprovals`）；
- **静默时段**：仍立即推送（审批有超时语义，迟了可能过期）；可选仅震动不响铃（用户在设置中决定）；
- **跳转**：审批中心/会话内审批卡（§7.4 表行 1）；
- **重推阶梯**：厂商通道发送失败或 15 分钟未获「已读」回执 → 重推（第 1 次 +15min，第 2 次 +60min，之后每小时一次，最多 5 次）；`approval-resolved(expired)` 到达后立即补一条「审批已过期」并停止重推。审批重推是「审批不能漏」的落地保障（§9.3）。

#### S2 审批结果（P2 · 仅 expired 必达）

- **触发**：`approval-resolved`（events.rs:487-495）；
- **规则**：`decision == Expired` → 推（正文「审批已过期：<toolName>」）；`Approved/Denied` 不推——用户在移动端处理的场景（未来移动端直接审批）是自身行为，无需回执通知；
- **跳转**：会话内对应工具卡。

#### S3 run 完成（P1）

- **触发**：`run-terminal { terminal: Completed }`（events.rs:511-519）；
- **文案**：复用唤醒摘要模板「任务 <runId 截断> 已完成，运行 <duration>」（wakeup_summary.rs:82-96 同构）；
- **去重**：`run-terminal:{runId}`；
- **合并**：与前 60s 内的 `subagent-ended(Completed)` 合并为「run 完成，含 N 个子代理」；
- **静默时段**：折叠进夜间摘要；
- **跳转**：会话详情。

#### S4 run 失败（P0）

- **触发**：`run-terminal { terminal: Failed, error: Some }`；
- **文案**：标题「任务运行失败」；正文「<error 截断 80 字>」；
- **去重**：`run-terminal:{runId}:failed`；
- **静默时段**：仍发（可选静音）；
- **跳转**：会话详情错误卡。

#### S5 run 取消（P1）

- **触发**：`run-terminal { terminal: Cancelled }`；
- **文案**：「任务已取消」；
- **静默时段**：折叠。

#### S6 子代理完成（P1）

- **触发**：`subagent-ended { status: Completed }`（events.rs:615-626），`summary` 可选；
- **文案**：「子代理 <role>（<id>）已完成：成功」+ summary 摘要（wakeup_summary.rs:67-78 同构；role 需从 SubagentStarted 声明或会话状态补充，事件体无 role 字段）；
- **去重**：`subagent-ended:{subagentId}`；
- **合并**：多个子代理完成合并为「N 个子代理已完成」；与 run-terminal 合并见 S3；
- **跳转**：子代理时间线。

#### S7 子代理失败（P0）

- **触发**：`subagent-ended { status: Failed }`；
- **文案**：「子代理 <role>（<id>）失败」+ summary/错误摘录；
- **静默时段**：仍发；
- **跳转**：子代理时间线/错误详情。

#### S8 后台任务（task 域，7 事件 4 场景）

- **S8a task-started（P2）**：仅 `is_daemon=true` 或预计长耗时任务推送「后台任务已启动：<command 摘要>」，普通任务不推；
- **S8b task-completed（P1）**：「任务 <id> 已完成，退出码 0」+ 运行时长（wakeup_summary.rs:104-121 同构）；
- **S8c task-suspicious（P0）**：「任务 <id> 疑似卡死（<silence_ms> 无输出）」——Soft 级事件但用户价值高，走 P0；
- **S8d task-failed（P0）**：「任务 <id> 异常退出（exit code N），附最后 20 行日志」——tail 字段（events.rs:711）截断 100 字入推送正文，全量进点击后的任务详情；
- **S8e task-killed（P1）**：与 kill 来源联动——用户主动 kill 不推，系统/watchdog 强制 kill 才推；
- **防打扰**：task 域全部用 `task_id` 作去重键；同一任务 10 分钟内最多 2 条（卡死→失败合并为一条「任务卡死后失败」）。

#### S9 定时器/cron 到期（P1）

- **S9a timer-fired（P1）**：正文直接取 `prompt`（events.rs:742）——「<prompt>（定时器 <id> 已到期）」；
- **S9b cron-fired（P1）**：「<prompt>（cron <id> 第 <n> 次触发）」（events.rs:775-776 + wakeup_summary.rs:126-131）；
- **防打扰**：**重复提醒类（cron 高频）默认折叠**：同 cron_id 在静默时段只推首条，其余进夜间摘要；用户可在设置中把某定时器设为「重要」提升为逐条推送；
- **跳转**：定时器/任务详情页。

#### S10 运行异常（P0）

- **S10a runtime-error（P0）**：`retryable=true` 时文案「运行异常（可重试）：<error 摘要>」——注意引擎语义是「不直接 finish，等 run-terminal 收口」（events.rs:451-452），所以**运行时错误通常只作为 run-failed 的先行提示，推一条即可**，避免与 S4 双推（去重键 `runtime-error:{runId}`，且 run-terminal(failed) 到达后 30 分钟内不再重复）；
- **S10b runtime-intervention-required（P0）**：「需要你介入：<reason>」+ 候选动作列表（choices 字段）摘要；run 以 stop 收场（events.rs:469），用户必须知情。

#### S11 安全审计（P0 子集）

- **触发**：`security-audit`（events.rs:559-577）；
- **推送子集**：`decision ∈ {blocked, purged}` 必推——红线拦截（blocked）说明用户有操作被拦下需要知道，彻底清除（purged）不可逆必须知道；
- **不推子集**：`approved/denied`（桌面端审批流已展示）、`redirected/restored`（可恢复路径，低价值）；
- **文案**：「安全拦截：<operation> <targets 前 2 个>」/「已彻底清除：<targets>」；
- **跳转**：审计面板/会话。

#### S12 缓存浪费告警（P2）

- **触发**：`cache-waste-alert`（events.rs:532-543，missed_tokens ≥ 20k 或 missed_cost ≥ $0.1 才发射）；
- **文案**：「缓存浪费 <N> token（约 $X）」；
- **防打扰**：P2 级，静默时段不推，10 分钟合并窗口内多归因只推一条；
- **跳转**：会话缓存详情。

#### 3.3.13 场景推送载荷样例（S1-S12 各一条）

以下为 12 个推送场景的 PushMessage 完整样例（WS 直推形态；厂商通道形态取 `title/body/target/data` 最小子集，data 按白名单瘦身，§6.3）。这些样例同时是 §10.2 文案单测的预期基准（golden fixture）。

**S1 审批请求（P0 · 必达最高）**

```json
{
  "schemaVersion": 1, "id": "push-000001", "eventType": "approval-requested",
  "seq": 101, "tsMs": 1786214400000, "severity": "critical", "category": "approval",
  "title": "Crish 需要你的批准",
  "body": "bash：执行部署脚本（由「实现」子代理申请：需要 shell 写权限）",
  "dedupeKey": "approval-requested:tc-9f3a", "collapseKey": "session:s-7",
  "channelId": "approval",
  "target": { "screen": "approval", "sessionId": "s-7", "params": { "toolCallId": "tc-9f3a", "toolName": "bash" } },
  "data": { "requesterRunId": "run-42", "requesterRole": "实现" }
}
```

**S2 审批过期（P2 · 触发即达）**

```json
{
  "schemaVersion": 1, "id": "push-000002", "eventType": "approval-resolved",
  "seq": 102, "tsMs": 1786218000000, "severity": "important", "category": "approval",
  "title": "审批已过期",
  "body": "bash 调用（tc-9f3a）等待超时，已自动拒绝",
  "dedupeKey": "approval-resolved:tc-9f3a:expired", "collapseKey": "session:s-7",
  "channelId": "approval",
  "target": { "screen": "approval", "sessionId": "s-7", "params": { "toolCallId": "tc-9f3a" } },
  "data": {}
}
```

**S3 run 完成（P1）**

```json
{
  "schemaVersion": 1, "id": "push-000003", "eventType": "run-terminal",
  "seq": 103, "tsMs": 1786214700000, "severity": "important", "category": "run",
  "title": "任务已完成",
  "body": "任务 run-42 已运行 3 分 12 秒，退出码 0",
  "dedupeKey": "run-terminal:run-42", "collapseKey": "session:s-7",
  "channelId": "run",
  "target": { "screen": "session", "sessionId": "s-7", "params": { "runId": "run-42" } },
  "data": {}
}
```

**S4 run 失败（P0）**

```json
{
  "schemaVersion": 1, "id": "push-000004", "eventType": "run-terminal",
  "seq": 104, "tsMs": 1786214800000, "severity": "critical", "category": "run",
  "title": "任务运行失败",
  "body": "run-42：provider 返回 401，API 密钥可能已失效",
  "dedupeKey": "run-terminal:run-42:failed", "collapseKey": "session:s-7",
  "channelId": "run",
  "target": { "screen": "session", "sessionId": "s-7", "params": { "runId": "run-42" } },
  "data": {}
}
```

**S5 run 取消（P1）**

```json
{
  "schemaVersion": 1, "id": "push-000005", "eventType": "run-terminal",
  "seq": 105, "tsMs": 1786214900000, "severity": "important", "category": "run",
  "title": "任务已取消",
  "body": "任务 run-42 已被取消",
  "dedupeKey": "run-terminal:run-42:cancelled", "collapseKey": "session:s-7",
  "channelId": "run",
  "target": { "screen": "session", "sessionId": "s-7", "params": { "runId": "run-42" } },
  "data": {}
}
```

**S6 子代理完成（P1）**

```json
{
  "schemaVersion": 1, "id": "push-000006", "eventType": "subagent-ended",
  "seq": 106, "tsMs": 1786214400000, "severity": "important", "category": "subagent",
  "title": "子代理已完成",
  "body": "子代理 分析（sa-3）已完成：成功——已产出缺口分析 5 页",
  "dedupeKey": "subagent-ended:sa-3", "collapseKey": "session:s-7",
  "channelId": "subagent",
  "target": { "screen": "subagent", "sessionId": "s-7", "params": { "subagentId": "sa-3" } },
  "data": {}
}
```

**S7 子代理失败（P0）**

```json
{
  "schemaVersion": 1, "id": "push-000007", "eventType": "subagent-ended",
  "seq": 107, "tsMs": 1786214400000, "severity": "critical", "category": "subagent",
  "title": "子代理失败",
  "body": "子代理 评审（sa-4）失败——工具执行超时",
  "dedupeKey": "subagent-ended:sa-4", "collapseKey": "session:s-7",
  "channelId": "subagent",
  "target": { "screen": "subagent", "sessionId": "s-7", "params": { "subagentId": "sa-4" } },
  "data": {}
}
```

**S8d 后台任务失败（P0）**

```json
{
  "schemaVersion": 1, "id": "push-000008", "eventType": "task-failed",
  "seq": 108, "tsMs": 1786214500000, "severity": "critical", "category": "task",
  "title": "后台任务异常退出",
  "body": "任务 t-11 异常退出（exit code 1），运行 2 分 5 秒",
  "dedupeKey": "task-failed:t-11", "collapseKey": "session:s-7",
  "channelId": "task",
  "target": { "screen": "task", "sessionId": "s-7", "params": { "taskId": "t-11" } },
  "data": {}
}
```

**S8c 任务疑似卡死（P0）**

```json
{
  "schemaVersion": 1, "id": "push-000009", "eventType": "task-suspicious",
  "seq": 109, "tsMs": 1786214600000, "severity": "critical", "category": "task",
  "title": "任务疑似卡死",
  "body": "任务 t-12 疑似卡死（120 秒无输出）",
  "dedupeKey": "task-suspicious:t-12", "collapseKey": "session:s-7",
  "channelId": "task",
  "target": { "screen": "task", "sessionId": "s-7", "params": { "taskId": "t-12" } },
  "data": {}
}
```

**S9a 定时器到期（P1）**

```json
{
  "schemaVersion": 1, "id": "push-000010", "eventType": "timer-fired",
  "seq": 110, "tsMs": 1786214700000, "severity": "important", "category": "timer",
  "title": "定时器提醒",
  "body": "请检查任务进度（定时器 timer-1 已到期）",
  "dedupeKey": "timer-fired:timer-1", "collapseKey": "timer:timer-1",
  "channelId": "timer",
  "target": { "screen": "timer", "sessionId": "s-7", "params": { "timerId": "timer-1" } },
  "data": {}
}
```

**S10b 需人工介入（P0）**

```json
{
  "schemaVersion": 1, "id": "push-000011", "eventType": "runtime-intervention-required",
  "seq": 111, "tsMs": 1786214800000, "severity": "critical", "category": "run",
  "title": "需要你介入",
  "body": "缺少 API 密钥，可选择：设置密钥 / 跳过",
  "dedupeKey": "intervention:run-42", "collapseKey": "session:s-7",
  "channelId": "run",
  "target": { "screen": "session", "sessionId": "s-7", "params": { "runId": "run-42" } },
  "data": {}
}
```

**S11 安全拦截（P0）**

```json
{
  "schemaVersion": 1, "id": "push-000012", "eventType": "security-audit",
  "seq": 112, "tsMs": 1786214900000, "severity": "critical", "category": "security",
  "title": "安全拦截",
  "body": "拦截删除操作：C:\\workspace\\src\\main.rs（红线规则命中）",
  "dedupeKey": "security-audit:tc-9f4b", "collapseKey": "session:s-7",
  "channelId": "security",
  "target": { "screen": "audit", "sessionId": "s-7", "params": {} },
  "data": {}
}
```

**S12 缓存浪费告警（P2）**

```json
{
  "schemaVersion": 1, "id": "push-000013", "eventType": "cache-waste-alert",
  "seq": 113, "tsMs": 1786215000000, "severity": "normal", "category": "system",
  "title": "缓存浪费告警",
  "body": "本次运行浪费约 24,000 token（约 $0.12）",
  "dedupeKey": "cache-waste-alert:run-42", "collapseKey": "session:s-7",
  "channelId": "summary",
  "target": { "screen": "session", "sessionId": "s-7", "params": { "runId": "run-42" } },
  "data": {}
}
```

**夜间摘要（静默时段折叠产物）**

```json
{
  "schemaVersion": 1, "id": "push-000014", "eventType": "night-summary",
  "seq": 114, "tsMs": 1786282200000, "severity": "normal", "category": "system",
  "title": "Crish 夜间简报",
  "body": "夜间完成 5 项：任务 run-55 已完成、子代理 分析 完成 ×2、任务 t-21 失败（已跳过）、cron-2 触发 3 次",
  "dedupeKey": "night-summary:2026-08-10", "collapseKey": "night-summary",
  "channelId": "summary",
  "target": { "screen": "home", "sessionId": "", "params": {} },
  "data": {}
}
```

样例约束（供实现对照）：`id` 全局递增（对齐事件 sequence 语义，events.rs:930）；`seq` 每设备单调；`collapseKey` 用于厂商通道同链折叠；`channelId` 与 §7.7 渠道表一一对应；样例中的路径/文案仅为示意，实际由 `push/copy.rs` 渲染（§6.5）。

### 3.4 防打扰策略（去重 / 合并 / 静默时段 / 节流）

#### 3.4.1 去重（dedupe）

- **去重键设计**（对齐 toast 语义，useToastQueue.ts:258-260）：`dedupeKey = {eventType}:{业务键}`；
- 业务键示例：`approval-requested:{toolCallId}`、`run-terminal:{runId}`、`subagent-ended:{subagentId}`、`task-failed:{taskId}`、`timer-fired:{timerId}`、`cron-fired:{cronId}`；
- **去重作用域**：桌面端策略引擎进程内 Map（带 TTL，如 24h）——重启丢失可接受（推送本来就是尽力而为），但**审批去重表必须持久化**（SQLite，审批不能漏，§9.3）；
- 同一事件重复到达（背压重发等）只推一次；`sequence` 信封字段（events.rs:930）可辅助判定乱序/重放。

#### 3.4.2 合并（coalesce）

合并规则表（实现为 `coalesce(pending: Vec<PushIntent>) -> Vec<PushIntent>`）：

| 合并窗口 | 规则 |
| --- | --- |
| 60s | run-terminal 与前 60s 的 subagent-ended 合并 → 「run 完成，含 N 个子代理」 |
| 60s | 多条 approval-requested（同 batch）→ 「N 项操作待批准」 |
| 10min | 同 session 的多条 task-failed → 「N 个后台任务失败」 |
| 10min | 同 cron_id 多次触发 → 「cron 已触发 N 次」 |
| 10min | task-suspicious 后跟 task-failed → 只推 failed（卡死已失败） |

厂商通道侧再叠加系统级合并：Android 用 `tag = dedupeKey`（替换已展示通知，Expo 文档 collapseId/tag 语义）、iOS 用 `threadId = sessionId`（分组堆叠）。

#### 3.4.3 静默时段（quiet hours）

- 默认 22:30-07:30（用户可配，按本地时区；桌面端推送生成时以**移动端时区**判定——移动端上报时区偏移，或直接由移动端在本地展示层决定是否静音，两种方案取后者为默认：**桌面端只负责「发不发」，移动端负责「响不响」**，静默时段主要过滤 P1/P2 级推送的**发送时机**）；
- P1 级在静默时段内**不立即发**，而是折叠进「夜间摘要」：次日 07:30 后发一条「夜间完成 N 项：任务 X 已完成、子代理 Y 完成…」；
- P0 级静默时段仍立即发（可选静音、无震动）；
- 时区处理：移动端注册时上报 `timezoneOffsetMinutes`，桌面端按该时区计算静默窗口。

#### 3.4.4 节流（throttle）

- **厂商通道节流**：同 device 每分钟 ≤ 2 条、同 session 每 10 分钟 ≤ 3 条，超出合并（对齐厂商配额红线，§11.1）；
- **总量护栏**：单 device 每日 ≤ 50 条推送（超出折叠为日报）；
- **重推节流**：审批重推阶梯见 §3.3 S1，其他事件不重推。

---

## 4. 推送架构设计（核心交付 2）

### 4.1 三路线评估

#### 路线 A：直连推送（桌面 → 移动端 WS 在线直推）

- **形态**：桌面端（Tauri 进程内 tokio）开一个轻量 WS/TCP 服务（如 127.0.0.1 局域网 IP: 随机高位端口），移动端通过配对码/局域网发现连接；桌面把「事件 → 通知」直接推给在线移动端；
- **优点**：零外部依赖、零成本、实时（毫秒级）、可携带全量结构化载荷（不受厂商 4KiB 限制）、数据不出局域网（隐私最好）、不依赖账号体系；
- **缺点**：桌面关机/睡眠/断网 = 推送断源；移动端后台被系统杀死后 WS 断开（国内 ROM 激进清杀）；跨网段（手机走蜂窝）不可达；无 GMS 的国内安卓「系统级保活长连接」不可靠；
- **结论**：**做在线主通道，但不能作为唯一通道**——它解决「桌面开着、手机在线」的最常见场景，且是唯一能承载全量数据的通道。

#### 路线 B：厂商通道（HMS / APNs / 小米 / vivo / OPPO / 荣耀）

- **形态**：桌面端持厂商 AppId/密钥，移动端注册厂商 token 上报，桌面经各厂商 REST API 发送；华为走 HMS Push Kit，iOS 走 APNs（Expo Push Service 或直连 APNs）；
- **优点**：系统级通道，应用被杀/锁屏/省电均可达，国内安卓唯一可靠的离线兜底；
- **缺点**：每厂商一个 SDK/一套 API/一次审核；配额与消息分类限制；payload 有限制（HMS 4KiB、各厂商对消息类型分类管控）；**Expo 官方不支持国产厂商通道**（见 §5.2），需 prebuild 原生集成；
- **结论**：**离线兜底主通道，必须做**。

#### 路线 C：自建推送服务（云中继）

- **形态**：云端常驻服务（中继 + 设备注册表 + 厂商通道代理）；桌面事件 → HTTPS → 云 → 厂商通道/长连接 → 手机；手机 token 注册到云；
- **优点**：桌面关机仍可推（云转存）、跨网段、多桌面/多账号未来可扩展；是主流 IM 的做法；
- **缺点**：**需要服务器、账号体系、运维与成本**；crish 当前无账号体系；隐私（事件摘要过云）；国内服务器需备案（域名+ICP）；维护精力大；
- **结论**：**架构上作为 M3 可选演进**（桌面端策略引擎与厂商发送器保持接口隔离，云中继只是把发送器搬到云端），一期不做。

#### 路线对比汇总

| 维度 | A 直连 WS | B 厂商通道 | C 自建中继 |
| --- | --- | --- | --- |
| 实时性 | 毫秒 | 秒级 | 秒级 |
| 桌面关机可用 | 否 | 否 | **是** |
| 手机后台被清杀可用 | 否 | **是** | 是 |
| 全量数据载荷 | **是** | 否（摘要级） | 是 |
| 依赖账号/服务器 | 否 | 否 | **是** |
| 国内合规成本 | 低 | 中（各厂商审核） | 高（备案） |
| 成本 | 0 | 0（免费通道） | 服务器费用 |
| 隐私 | 最好（不出网） | 摘要过厂商服务器 | 全量过云 |
| 一期可行性 | 立即 | 2-4 周/厂商 | 1-2 月 + 运维 |

### 4.2 分层架构推荐：在线 WS 优先 + 离线厂商兜底

```
┌──────────────────────────────────────────────────────────────┐
│                        桌面端（事件源）                          │
│  crates/session-loop  ── AgentEvent ──► core_event_bridge      │
│        (41 事件)                      (workbench-run-event)    │
│                                          │                      │
│                               ┌──────────▼──────────┐          │
│                               │ 推送策略引擎 push-core │          │
│                               │ · 场景筛选 push_intent │          │
│                               │ · 去重/合并/静默/节流  │          │
│                               │ · 文案生成 push_copy  │          │
│                               │ · 审批重推阶梯        │          │
│                               └────┬──────────┬──────┘          │
│                                     │          │                  │
│                    ┌────────────────▼──┐   ┌───▼────────────────┐│
│                    │ WS 中继（在线直推） │   │ 厂商发送器 Vendor   ││
│                    │ tokio TcpListener  │   │ PushDispatcher     ││
│                    │ 局域网 + 配对码    │   │ HMS/小米/vivo/...   ││
│                    └──────┬───────────┘   └───┬───┬─────────────┘│
│                           │                    │   │              │
└───────────────────────────┼────────────────────┼───┼──────────────┘
                            │                    │   │
       移动端在线（前台/后台短）│                    │   │  移动端离线/被杀
                            ▼                    │   ▼
                   ┌────────────────┐            │  ┌──────────────────┐
                   │ 移动端 App      │            │  │ 厂商推送服务        │
                   │ · WS 客户端     │            │  │ 华为 HMS/小米/vivo/ │
                   │ · 应用内通知    │            │  │ OPPO/荣耀/APNs      │
                   │ · 全量载荷渲染  │            │  └───────┬──────────┘
                   └────────────────┘            │          │
                                                 └──────────▼────────────────┐
                                                  移动端（系统通知中心）         │
                                                  摘要级展示 + 点击后拉全量     │
                                                  └───────────────────────────┘
```

组件清单：

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| push-core（策略引擎） | 桌面端 Rust（apps/agent-workbench/src-tauri/src/push/） | 事件 → PushIntent 判定、去重/合并/静默/节流、审批重推阶梯、文案 |
| push-ws-relay（在线中继） | 桌面端 Rust | 局域网 WS 服务，设备配对、在线状态、直推、Ack |
| push-vendor（厂商发送器） | 桌面端 Rust | `VendorPushChannel` trait + 各厂商实现（HMS/小米/vivo/OPPO/荣耀/APNs） |
| push-device-registry | 桌面端 SQLite（复用 LocalDb 连接） | 设备表（device_id、平台、厂商、token、时区、配对状态） |
| push-client（移动端） | 移动端（crish-mobile，本次不实现仅契约） | WS 客户端、厂商 token 注册、本地通知渲染、点击跳转、静音时段本地决策 |
| 厂商推送服务 | 云（各厂商） | 系统级投递 |

### 4.3 关键决策说明

1. **推送生成在桌面端**：桌面端是唯一事件源，策略引擎放在桌面端进程内（不是移动端）——移动端无需理解 41 事件，只消费「通知 + 目标」；也避免移动端重复实现筛选逻辑。
2. **在线判定由桌面端做**：移动端 WS 心跳上报 `foreground/background/active`，桌面端据此决定「只直推」还是「直推 + 厂商通道双发」；**在线且前台时不发厂商通道**（省配额、省电量、避免双通知）。
3. **厂商发送失败不阻塞**：发送器异步、失败只记录 + 审批类重推；厂商通道返回 DeviceNotRegistered 时从注册表移除该设备（对齐 Expo 文档对 DeviceNotRegistered 的处理建议）。
4. **移动端本地展示层兜底**：静默时段的「响不响」由移动端决定（设备本地判定），桌面端只管「发不发」——两层职责分离，避免时区/策略在双端漂移。
5. **协议自有定义**：推送协议（§6.2 schema）与事件协议解耦——事件是「引擎发生了什么」，推送是「用户需要知道什么」，未来云中继（路线 C）直接复用同一 schema。

### 4.4 消息流时序（在线与离线两态）

在线态（移动端前台）：

```
移动端                      桌面端 WS 中继               引擎/策略引擎
  │  1. 配对（二维码/配对码）     │                           │
  ├──────────────────────────►│                           │
  │  2. presence: {appState}   │                           │
  ├──────────────────────────►│                           │
  │                            │   3. approval-requested    │
  │                            │◄──────────────────────────┤
  │                            │   4. 直推 PushMessage       │
  │◄───────────────────────────┤  （在线且前台 → 不发厂商通道）│
  │  5. ack {seq}              │                           │
  ├──────────────────────────►│                           │
  │  6. 应用内通知渲染 + 点击跳转  │                           │
```

离线态（移动端被杀/断网/锁屏深眠）：

```
移动端                      桌面端 WS 中继               策略引擎        厂商通道(云)
  │   WS 断开（心跳超时 30s）     │                           │              │
  │                            │   1. presence: offline     │              │
  │                            │◄──────────────────────────┤              │
  │                            │   2. run-terminal(failed)  │              │
  │                            │◄──────────────────────────┤              │
  │                            │   3. 判定离线 → 厂商发送      │              │
  │                            │─────────────────────────────────────────►│
  │                            │                           4. 系统投递      │
  │◄───────────────────────────────────────────────────────────────────────┤
  │  5. 通知中心展示（摘要级）    │                                           │
  │  6. 点击 → 冷启动 → 拉全量数据 │                                           │
```

### 4.5 在线状态机

移动端状态机（推送层面）：

```
         ┌─────────┐  配对成功    ┌──────────────┐
         │ 未配对    │──────────►│ connected     │
         └─────────┘             │ (在线直推)     │
         ▲                       └──────┬───────┘
         │  配对失效/换桌面             │ 心跳超时 30s / app killed
         │                             ▼
         │                       ┌──────────────┐
         └───────────────────────│ offline       │
                                 │ (厂商通道兜底) │
                                 └──────────────┘
```

- 心跳间隔 10s，3 次未响应判离线（30s）；
- `connected + appState=active` → 只直推；`connected + background` → 直推（移动端展示层决定是否横幅）；`offline` → 厂商通道；
- 桌面端掉线（桌面进程退出）→ 移动端 WS 断连，进入「无推送状态」（一期接受；M3 云中继解决）。

### 4.5a WS 中继协议规格（v1）

WS 中继是 M0 的核心交付，协议在桌面端 Rust（relay.rs）与移动端（D8）双端实现，故冻结为契约。以下消息均为 UTF-8 JSON 帧（\n 分隔，帧内无换行）。

**阶段一：配对（移动端发起）**

```
移动端 → 桌面端（桌面端发布在配对页的二维码内嵌地址）
  {"type":"pair-request","code":"8F3K2Q","deviceName":"小米13","platform":"android","vendor":"xiaomi","pushToken":"<token>","timezoneOffsetMinutes":480}
桌面端 → 移动端（成功）
  {"type":"pair-accept","deviceId":"dev-01","wsKey":"<32位会话密钥>","env":"prod","serverTimeMs":1786214400000}
（失败）
  {"type":"pair-reject","reason":"code-expired"}
```

- 配对码：6 位大写字母数字（去除易混淆字符），一次性、5 分钟过期、最多 3 次尝试（第 3 次失败锁 30 分钟）；
- `wsKey`：桌面端生成的随机会话密钥，后续所有帧携带（HMAC 校验）；`pushToken` 在配对时一并上报（厂商通道 token 与 WS 通道建立互不依赖）；
- 移动端配对成功后进入 `connected`，此后心跳由移动端驱动。

**阶段二：心跳与 presence**

```
移动端 → 桌面端（每 10s）
  {"type":"ping","wsKey":"...","appState":"active"|"background"|"inactive"}
桌面端 → 移动端
  {"type":"pong","serverTimeMs":1786214400000}
```

- 桌面端维护 `last_seen_at`；超过 30s 未 ping → 判定 offline（状态机 §4.5）；
- `appState` 变更（前台切后台等）时移动端立即补发一次 ping（不等 10s 周期）。

**阶段三：推送与确认**

```
桌面端 → 移动端
  {"type":"push","msg":{...PushMessage 全量，§6.2},"hmac":"<wsKey 派生>"}
移动端 → 桌面端（处理成功或已入系统通知中心后）
  {"type":"ack","id":"push-000042","dedupeKey":"approval-requested:tc-9f3a"}
```

- **ack 语义**：移动端「已收到」即 ack（不要求已展示）；桌面端收到 ack 后该条从「待确认推送」移除；审批类消息 ack 视为「已送达」——重推阶梯（§9.3）以「无 ack 且无 approval-resolved」为触发条件，**ack 不代表用户已处理审批**（处理以 approval-resolved 为准）；
- 重发：桌面端对审批类消息保留 15 分钟重发窗口，未 ack 且移动端仍在线 → 重发一次（幂等，dedupeKey 去重）；
- 乱序：帧序号 `seq` 单调，移动端收到小于已处理 seq 的帧直接丢弃（幂等）。

**阶段四：解绑/切换**

```
移动端 → 桌面端
  {"type":"unpair","deviceId":"dev-01","wsKey":"..."}
桌面端 → 移动端
  {"type":"unpair-ok"}
```

- 解绑后 device registry 移除 token 与配对记录（§8.2）；厂商通道停发该设备；
- 桌面端删除设备（设置页）→ 桌面端主动发 `{"type":"kick","deviceId":"..."}`，移动端本地清除配对状态。

**帧级错误处理**

| 帧 | 错误 | 处理 |
| --- | --- | --- |
| 任意 | HMAC 校验失败 | 丢弃 + 计数，连续 5 次断开连接并要求重配对 |
| push | 移动端处于静默时段（本地判定） | 仍 ack（已入通知中心/应用内），本地决定展示策略（§4.3 决策 4） |
| push | schemaVersion 高于本地支持 | ack + 本地降级为「Crish 有新消息」通用提示 |
| 任意 | 协议版本不匹配（v1 vs v2） | 桌面端发 `{"type":"version-mismatch","supported":1}`，双端协商最低版本 |

**安全说明**：WS 只监听局域网接口（绑定 `0.0.0.0` 但通过 HMAC wsKey 认证 + 配对码门槛）；不支持公网穿透（M3 云中继才处理 NAT/公网场景）。

### 4.6 与账号体系的关系

- 一期**无账号体系**：设备与桌面是「1 桌面 : N 设备」的配对关系，配对信息（设备指纹 + 配对码 + 设备名）存桌面端 SQLite；
- 配对流程（一期）：移动端扫描桌面端二维码（含 `ws://<ip>:<port>/pair?code=<6位码>`）→ 桌面端确认配对码 → 交换设备名/token → 建立连接；
- 二期若引入账号：device registry 增加 `account_id` 列，WS 中继/厂商发送器接口不变——**架构为账号演进预留，不阻塞**。

---

## 5. 国内安卓厂商通道矩阵（核心交付 3）

### 5.1 查证结论汇总（2026-08 网络查证）

| 结论 | 依据 |
| --- | --- |
| 国内安卓无 GMS，FCM 不可用 | 常识 + 统一推送背景（维基「Google 服务在中国大陆被防火墙屏蔽，FCM 推送长期不稳定」） |
| Expo Push Service 依赖 FCM/APNs，服务器在美国 | Expo 官方文档（sending-notifications.md「Your server must have connectivity to Google Cloud Platform services in the United States」；无 SLA） |
| expo-notifications 的 Android 远程推送**必须 FCM v1** | Expo 官方文档（push-notifications-setup.md「For Android, you need to configure Firebase Cloud Messaging (FCM)」） |
| Expo 生态对国产厂商通道**无官方支持** | 华为官方 RN 插件为独立 npm 包（@hmscore/react-native-hms-push），Expo 无 HMS 文档/插件；expo-notifications 文档无 HMS/小米/vivo/OPPO 字样 |
| UMS「统一推送」不是统一服务器 | 维基：联盟提供规范、各家厂商自营服务器；华为/荣耀名义适配实际仍自家推送 |
| 华为 HMS Push 是华为系事实通道 | HMS-Core/hms-react-native-plugin 官方插件仓库（265 star、Apache-2.0） |

### 5.2 HMS Push（华为）详解

#### 5.2.1 定位

- 华为/荣耀（预装 HMS 的机型）的系统级推送服务，**国内华为系唯一可靠通道**；
- 荣耀独立后另有荣耀推送服务（Honor Push），但荣耀机型普遍预装 HMS，HMS Push 在荣耀上仍可用——**覆盖矩阵把荣耀机型并入 HMS 通道（实测为准，§10.5）**；
- 生态地位：华为不参与统一推送互通（名义适配实际自家），接华为必须走 HMS Push Kit。

#### 5.2.2 接入形态（Expo 路径）

Expo 对 HMS 无官方支持，接入路径为：

1. **prebuild 出原生工程**：`npx expo prebuild`（CNG 模式），此后 Android 工程为原生 Gradle 工程；
2. **集成官方 RN 插件**：npm 安装 `@hmscore/react-native-hms-push`（Apache-2.0，HMS-Core/hms-react-native-plugin 仓库，npm 下载量长期活跃）；
   - 官方插件**没有提供 Expo config plugin**——需自写 config plugin 或在 prebuild 后手工改 `android/`（autolinking 可自动链接，但 agconnect 配置/签名需要 plugin 注入）；
   - 华为文档给出 RN 插件指引（Getting Started: developer.huawei.com HMS-Plugin-Guides）；
3. **Expo 侧取舍**：
   - `expo-notifications` 仍承担：本地通知渲染、前台 `setNotificationHandler`、点击 `addNotificationResponseReceivedListener`、Android Channel 管理（§7）；
   - HMS 插件承担：`HmsPushInstanceId.getToken()` 获取 HMS token（经 `onTokenReceived` 事件）、透传/通知消息监听；
   - **两套通知体系并存的风险**：HMS 通知消息（显示型）由 HMS 系统直接展示，不经过 expo-notifications 的前台 handler——前台收到 HMS 通知时会出现「系统横幅 + 应用内通知」双显示，需要移动端按 `appState` 决定（前台时用透传消息（data-only）+ 应用内渲染；后台/被杀用通知消息）。此点列入移动端实现要点（§7.3）与真机测试清单（§10.5）。
4. **服务端发送**：华为 Push Kit REST API——OAuth2 client credentials 换 AT（`POST /oauth2/v3/tokens`），再 `POST /push/v1/{appId}/messages:send`，通知消息/透传消息两类，4KiB 载荷上限，消息分类（IM/资讯/服务提醒/营销）影响展示优先级；
5. **开发者流程**：华为开发者联盟注册 → 创建应用（包名需与移动端一致）→ 开通 Push Kit → 下载 agconnect-services.json 配置进原生工程 → 申请「系统通知」权限分类（IM 类消息可全屏/置顶）。

#### 5.2.3 华为通道要点（凭据/配额/审核）

| 项 | 说明 |
| --- | --- |
| 凭据 | App ID + App Secret（服务端 AT 换发）；移动端 agconnect-services.json |
| 审核 | 推送服务需在 AGC 控制台申请开通；消息分类（系统/服务提醒/营销）影响送达策略 |
| 配额 | 免费；营销类消息有频控；系统通知类（IM/审批）可高优先级（紧急消息可 5 秒内送达） |
| 海外 | 华为海外机型走 `react-native-hms-push-fcm`（FCM 桥），国内不用管 |

### 5.3 小米推送（MiPush）

- **定位**：小米/红米系统级推送；小米市场占有率高，仅次于华为系；
- **接入**：小米开放平台创建应用（包名匹配）→ 获取 AppId/AppSecret → 移动端集成小米推送 SDK（`com.xiaomi.mipush.sdk`，Expo 下同 HMS 路径：prebuild + 原生集成，无官方 Expo 插件）；
- **服务端**：小米推送 REST API（HTTPS，POST 到 `api.xmpush.xiaomi.com`），支持通知栏消息/透传，Android 13+ 需申请通知权限；有「高优先级/重要消息」通道（需申请）；
- **注意点**：
  - 小米对**应用自启动/后台限制**严格（MIUI 省电策略），但系统推送通道本身可达；
  - 小米推送分「通知消息分类」（私信/订阅/提醒/兴趣/运营），审批类应映射「私信/提醒」类以保送达；
  - 小米禁止滥用：纯营销消息会被限流。

### 5.4 vivo 推送（vivo Push）

- **定位**：vivo/iQOO 系统级推送；
- **接入**：vivo 开放平台创建应用（包名匹配 + 应用审核）→ AppId/AppKey/AppSecret → 集成 vivo 推送 SDK（Expo：prebuild + 原生集成）；
- **服务端**：vivo 推送 REST API（HTTPS POST），消息分类「系统消息/运营消息」，**系统消息需申请**（审批/任务完成类应申请系统消息分类，否则限频限流）；
- **注意点**：vivo 测试环境有配额（正式环境需审核通过后解锁）；应用需在 vivo 应用商店上架或至少完成开发者认证。

### 5.5 OPPO 推送（OPPO Push）

- **定位**：OPPO/一加/realme 系统级推送；
- **接入**：OPPO 开放平台创建应用 → AppKey/AppSecret（服务端）+ MasterSecret → 集成 OPPO 推送 SDK（Expo：prebuild + 原生集成）；
- **服务端**：OPPO 推送 REST API（HTTPS POST），通知栏消息/透传，**正式环境有单日推送配额**（按应用等级，需在控制台申请调额）；
- **注意点**：OPPO 对**消息内容分类**（如 2024 年后对营销消息强管控），审批/IM 类映射「IM/系统」分类保送达；一加/realme 国内机型使用 OPPO 通道。

### 5.6 荣耀推送与其他厂商

| 厂商 | 通道 | 策略 |
| --- | --- | --- |
| 荣耀 | 荣耀推送服务（Honor Push，独立开发者平台）；机型普遍预装 HMS → 也可走 HMS Push | **优先走 HMS**（覆盖 + 已有 RN 插件），荣耀独立通道列为 M2 验证项（§10.5 真机验证） |
| 三星 | 统一推送标准适配（国内存量少） | M2 可选 |
| 魅族 | Flyme 推送（份额小） | M2 可选 |
| 中兴/联想/努比亚等 | 统一推送适配（各家自营实现） | 不单独接，走聚合通道（若选用）或放弃（份额极小） |

### 5.7 UMS（统一推送）与「厂商合并推送」现状

- **历史**：2017 年工信部牵头成立统一推送联盟（泰尔实验室挂靠，副理事长含华为/小米/OPPO/vivo/个推/极光）；2022 年升格为统一推送工作委员会；官网曾短暂停摆（2022-08 chinaupa.com 域名出售，9 月换新站）；
- **本质**：**规范统一、各家自营**——「不是由工信部提供统一的推送服务器，而是提供一套规范，由各家厂商自己运营」；华为/荣耀「声称已完成适配，但实则仍在使用自家的推送服务」；
- **2026 现状**：UMS 规范至今未形成「一个合并推送 API」的业界事实标准；开发者实际可选：
  1. **逐家接入**（本方案主推）：华为/小米/vivo/OPPO/荣耀各自 SDK + 各自 REST API；
  2. **聚合商**（个推/极光等）：一套 SDK 在设备端按机型自动选厂商通道，服务端一个 API 统发（§5.8）；
- **结论**：**不存在「接一次全部覆盖」的官方统一通道**，厂商合并推送只能靠聚合商，或者自建逐厂商发送器——本方案选后者（免费、可控、凭据自持），聚合商作为备选路线（§5.8 对比）。

### 5.8 聚合通道评估（个推 / 极光）

| 维度 | 个推（GeTui） | 极光（JPush） |
| --- | --- | --- |
| 设备端 | 一个 SDK 聚合华为/小米/vivo/OPPO/荣耀/魅族/三星 + APNs | 同左 |
| 服务端 | 统一 REST API（云推送），服务端做厂商路由 | 同左 |
| 优势 | 接入成本最低；覆盖面广（长尾厂商）；后台常驻推送可达 | 同左；文档中文完善 |
| 劣势 | 付费（免费额度有限）；设备端多一个第三方 SDK 与保活服务；数据过第三方；离线回执口径黑盒 | 同左 |
| 适用 | 快速验证期 / 不想逐家维护凭据 | 同左 |
| 结论 | **M1 验证期可选用**（尤其覆盖长尾厂商）；**M2 转自建逐厂商**（免费 + 凭据自持 + 审批重推可精细控制） | 备选 |

### 5.9 Expo Push Service 国内可用性结论（重点查证项）

- **对国内安卓：不可用**。Android 侧 `getExpoPushTokenAsync` 依赖 FCM（Firebase），无 GMS 的设备拿不到 token；即便拿到，FCM 连接在国内被墙不可达。Expo 官方文档明确 Android 必须配置 FCM v1。
- **对国内 iOS：基本可用但不建议依赖**。APNs 在国内可用；`exp.host/--/api/v2/push/send` 本身不备案、服务器在美国，国内网络可达性不稳（官方文档 troubleshooting 章节也提示需确保到 GCP US 的连通性）；无 SLA。
- **结论**：国内发行版**不依赖 Expo Push Service**。iOS 端建议经自建发送器直连 APNs（或经聚合商），与安卓共用同一推送 schema；Expo Push Service 仅作为海外发行的可选通道（海外版移动端可保留 expo-notifications + exp.host 路径，与国内路径按构建配置切换——§8.3 环境隔离）。

### 5.10 通道选型决策矩阵与推荐

| 通道 | 覆盖机型 | 一期（M1） | 二期（M2） | 备注 |
| --- | --- | --- | --- | --- |
| WS 直推 | 全部（在线时） | 必做 | 必做 | 唯一全量通道 |
| 华为 HMS Push | 华为/荣耀 | **先做** | 必做 | 官方 RN 插件现成；覆盖最大单厂商份额 |
| 小米推送 | 小米/红米 | 视进度 | 必做 | 份额第二 |
| vivo 推送 | vivo/iQOO | 视进度 | 必做 | 需申请系统消息分类 |
| OPPO 推送 | OPPO/一加/realme | 视进度 | 必做 | 注意正式环境配额 |
| 荣耀推送 | 荣耀（无 HMS 或验证失败时） | 不做 | 验证项 | 先验证 HMS 覆盖 |
| APNs（iOS） | iPhone | 必做（国内直连 APNs） | 必做 | 与安卓同 schema |
| 个推/极光 | 长尾厂商 | **备选（M1 提速）** | 不选 | 覆盖中兴/三星/魅族等 |

**推荐结论**：M1 先「WS 直推 + HMS + APNs」，覆盖「在线全量 + 华为系离线 + iPhone 离线」；M2 铺小米/vivo/OPPO 全矩阵 + 长尾（或聚合商补长尾）。

---

## 6. 桌面端推送生成（核心交付 4）

### 6.1 事件 → 推送消息映射

映射链路（纯函数，便于测试）：

```
AgentEvent (41 变体)
   │
   ▼ push_intent(event, ctx) -> Option<PushIntent>        [场景筛选 §3.2]
   │
   ▼ coalesce(pending) -> Vec<PushIntent>                 [合并 §3.4.2]
   │
   ▼ quiet_hours_filter(intent, tz) -> Policy             [静默 §3.4.3]
   │        (send-now / defer-to-summary / suppress)
   │
   ▼ render_copy(intent) -> {title, body, category}       [文案 §6.5]
   │
   ▼ build_push_message(intent, copy) -> PushMessage       [schema §6.2]
   │
   ▼ deliver(messages, presence)                           [§6.4 双通道分发]
```

`PushIntent` 定义（Rust）：

```rust
/// 推送意图（场景筛选输出，Rust 侧新模块 push/core.rs）
pub struct PushIntent {
    /// 事件类型名（wire 名，events.rs type_name 同源）
    pub event_type: &'static str,
    /// 业务键（去重键 = event_type + ":" + 业务键，§3.4.1）
    pub dedupe_key: String,
    /// 合并键（同键在合并窗口内折叠，§3.4.2）
    pub coalesce_key: Option<String>,
    /// 推送级别（P0 必达 / P1 重要 / P2 可折叠 / P3 不推）
    pub level: PushLevel,
    /// 目标屏幕（移动端跳转，§7.4 映射表）
    pub target: PushTarget,
    /// 会话/run/任务上下文（跳转与折叠需要）
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    /// 桌面端审批登记（P0 重推阶梯用，§9.3）
    pub approval: Option<ApprovalPushRef>,
    /// 事件原始载荷（全量数据随 WS 直推；厂商通道只带摘要，见 §6.3）
    pub event_json: Option<serde_json::Value>,
}

/// 推送级别（对齐 §3.1 定义）
pub enum PushLevel { P0Critical, P1Important, P2Collapsible }
```

### 6.2 推送消息结构（schema v1）

跨平台统一 schema（WS 直推与厂商通道共用；厂商通道只取其 title/body/data 子集）：

```json
{
  "schemaVersion": 1,
  "id": "push-000042",
  "eventType": "approval-requested",
  "seq": 42,
  "tsMs": 1786214400000,
  "severity": "critical",
  "category": "approval",
  "title": "Crish 需要你的批准",
  "body": "bash：运行部署脚本（由「实现」子代理申请）",
  "dedupeKey": "approval-requested:tc-9f3a",
  "collapseKey": "session:s-7",
  "channelId": "approval",
  "target": {
    "screen": "approval",
    "sessionId": "s-7",
    "params": { "toolCallId": "tc-9f3a" }
  },
  "data": {}
}
```

- **severity**：critical（P0）/ important（P1）/ normal（P2）——移动端据此决定横幅/静音；
- **category**：approval / run / subagent / task / timer / security / system——映射 Android Channel（§7.7）与 iOS 分组；
- **channelId**：Android 通知渠道 id（`expo-notifications` `setNotificationChannelAsync` 建同名渠道）；
- **target**：点击跳转目标（§7.4），`screen` 取值枚举：approval / session / subagent / task / audit / timer / home；
- **data**：补充结构化字段（如 approval 的 toolName、task 的 exitCode）——WS 直推时**事件全量**放 `data.event`（不受 4KiB 限制），厂商通道时清空（只留跳转所需最小字段）；
- **厂商通道适配**：HMS 通知消息 `title/body` 用同一字段，`data` 序列化入消息体（4KiB 上限内）；小米/vivo/OPPO 同构。

字段参考表（serde camelCase，与事件契约风格一致，events.rs:2-3）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| schemaVersion | u32 | 是 | 推送 schema 版本（当前 1；演进登记仿 33-event-schema-changelog 惯例，events.rs:11） |
| id | string | 是 | 推送全局唯一 id（`push-<递增>`；对齐全域 event sequence 语义，events.rs:930） |
| eventType | string | 是 | 来源事件 wire 名（41 枚举之一；night-summary 为合成事件） |
| seq | u64 | 是 | 每设备单调递增序号（WS 帧级去重与 ack 对应，§4.5a） |
| tsMs | u64 | 是 | 生成时刻（epoch 毫秒，对齐全仓惯例） |
| severity | enum | 是 | critical（P0）/ important（P1）/ normal（P2）——移动端横幅与声音决策 |
| category | enum | 是 | approval / run / subagent / task / timer / security / system（§7.7 渠道映射） |
| title | string | 是 | 通知标题（≤ 30 字） |
| body | string | 是 | 通知正文（≤ 120 字，§6.3 截断） |
| dedupeKey | string | 是 | 去重键（§3.4.1），移动端展示层幂等键 |
| collapseKey | string | 否 | 合并键（§3.4.2），厂商通道系统级折叠（Android tag / iOS threadId） |
| channelId | string | 是 | Android 通知渠道 id（§7.7 表） |
| target | object | 是 | 跳转目标：`{screen, sessionId, params}`（§7.4 映射表） |
| data | object | 否 | 结构化附加数据；WS 直推时可为事件全量（§6.3），厂商通道时仅白名单字段 |

厂商通道适配（发送器实现要点）：HMS/小米/vivo/OPPO/荣耀各通道把本 schema 映射为自身字段（华为 `title/body/click_action`、小米 `title/description/extra`、vivo `title/content`、OPPO `title/content`），`collapseKey → tag/threadId`、`channelId → 厂商通知分类`、`severity → 厂商消息优先级`；映射在 vendor trait 实现内收敛，上层不感知厂商差异（§9.2 `VendorPushChannel`）。

### 6.3 敏感度分级（摘要级 vs 全量）

原则：**厂商通道只走「摘要级 + 跳转参数」，全量数据只走 WS 直推**。

| 通道 | 载荷内容 | 理由 |
| --- | --- | --- |
| WS 直推（在线） | 完整 PushMessage + 事件全量 JSON（data.event） | 局域网内、零成本、无 4KiB 限制 |
| 厂商通道（离线兜底） | 仅 title/body（摘要）/target/最小 data（sessionId、toolCallId 等） | 厂商服务器中转，**不上送对话/工具参数全文**（隐私 + 4KiB 限制 + 厂商内容审核） |

敏感度细则：

1. **正文截断**：所有正文 ≤ 120 字（中文）；工具参数、日志 tail、prompt 全量只进跳转后的页面（点击后经 WS 拉取，若已断连则桌面端不可达时只显示摘要——文档性质内容，不涉敏感）；
2. **不上送**：`parameters`（工具参数全文）、`message` 正文、`tail`（日志全文）、密钥类内容——厂商通道 data 白名单仅 `{sessionId, runId, toolCallId, subagentId, taskId, timerId, cronId, screen}`；
3. **桌面端审批登记表**（§9.3）持久化的也是摘要 + id，不存参数全文（要查全量回桌面端看）；
4. **用户可关闭摘要内容**（设置「锁屏不显示正文」→ 移动端本地把 body 替换为「Crish 有新消息」——厂商通道 payload 不含敏感内容时此开关无成本）。

### 6.4 与移动端在线状态的协同

分发决策表（输入：presence 状态 × 推送级别）：

| presence | P0 | P1 | P2 |
| --- | --- | --- | --- |
| connected + active | 仅 WS 直推（应用内呈现） | 仅 WS 直推 | 仅 WS 直推 |
| connected + background | WS 直推（移动端本地决定是否横幅/声音） | WS 直推 | WS 直推 |
| offline（< 15min，可能短暂离开） | WS 直推（尽力） + **厂商通道** | 厂商通道 | 合并窗口再发厂商通道 |
| offline（> 15min / 从未在线） | 厂商通道 | 厂商通道 | 合并后厂商通道 |
| 未配对 | 不推（无目标设备） | 不推 | 不推 |

- 双通道互斥：同一 `id` 双发时移动端按 `dedupeKey` 去重（展示层去重，§7.2）——防止「在线判定刚切换」的竞态双通知；
- presence 由移动端心跳上报 + 移动端 `AppState` 变化事件推送（active/background/inactive）；心跳 10s、超时 30s 判 offline（§4.5）；
- **审批类例外**：即使 connected+active（用户正在用手机），审批仍按 P0 推（桌面端可能不在用户视线内；移动端展示层可判断「用户正在审批页」时不打扰——移动端本地决策）。

### 6.5 文案生成（复用唤醒摘要资产）

- 新增 `apps/agent-workbench/src-tauri/src/push/copy.rs`：`push_copy(intent, event) -> {title, body, category}`；
- **复用 wakeup_summary 模板与风格**：S3/S6/S8b/S9 直接复用 `wakeup_summary()`（wakeup_summary.rs:63-135）的模板或与其同构（「任务 <id> 已运行 <duration>」「子代理 <role>（<id>）已完成：<status>」「<prompt>（定时器 <id> 已到期）」）；
- 新增模板（不在 wakeup_summary 六类内的场景）：
  - approval-requested：「Crish 需要你的批准」+「<toolName>：<summary 60 字>」；
  - run failed：「任务运行失败」+「<error 80 字>」；
  - security-audit blocked：「安全拦截：<operation> <targets 前 2 项>」；
  - task-suspicious：「任务 <id> 疑似卡死（<N> 秒无输出）」；
  - runtime-intervention-required：「需要你介入：<reason>」；
- 测试护栏复用 wakeup_summary.rs:393-447 的「无占位符残留」断言模式（`<...>` 不得残留）+ 中文文案单测；
- 文案与 `useToastQueue` 产品语义对齐：**成功类不打扰**（S3/S6 在移动端展示层仅静默更新会话状态页，横幅可选关——移动端设置「完成类通知」开关）。

### 6.6 推送队列与背压

- 推送引擎异步队列（tokio mpsc，对齐 `buffer.rs` 的背压先例）：
  - 队列满时**P0 不可丢**（阻塞/持久化入 SQLite 待发表），P1/P2 可丢（记录计数）；
  - 对齐事件背压语义（events.rs:867-893）：Delta 类事件根本不进推送队列（筛选层已挡），Soft 类（task-suspicious）进队但可丢，Critical 类（审批/终态）必须落「待发表」；
- 厂商通道发送器并发上限（如 4 并发、每厂商 1 个 worker），失败重试（指数退避，对齐 Expo 官方文档重试建议：429/5xx 退避重试、400 不重试）；
- **审批待发表持久化**（§9.3）：approval-requested 落库 + 重推阶梯，应用重启后恢复扫描。

---

## 7. 移动端接收（核心交付 5）

> 注：移动端实现细节归 D8（crish-mobile 不可读，本方案只给契约与行为规范，供 D8 实现与验收）。

### 7.1 接收链路总览

```
厂商系统通知（离线）
      │ 点击
      ▼
冷启动/后台启动 → NotificationResponse（data.target）
      │
      ▼
路由解析（screen/sessionId/params）→ 导航到目标页
      │
      ▼
若需全量数据 → WS 拉取（在线）或显示摘要（离线）
```

三条入口统一汇入「通知处理模块」：

1. **厂商通道到达**（后台/被杀）：系统通知中心展示（摘要），点击后进路由；
2. **WS 直推到达**（在线）：应用内通知/横幅（`expo-notifications` 本地呈现或自绘），点击进路由；
3. **应用内状态同步**（在线且用户在目标页）：静默合并（不弹横幅，只更新页面状态）。

### 7.2 前台通知

- `expo-notifications` `setNotificationHandler`（SDK 57 文档）：前台收到通知时 JS 决定是否展示——返回 `{shouldShowBanner, shouldPlaySound, shouldSetBadge}`，3 秒内不响应则丢弃；
- 行为规范：
  - 用户正停留目标屏幕（如审批页）→ 不弹横幅（静默更新）；
  - 其他场景 → P0 弹横幅（assertive），P1 弹横幅（polite，可选），P2 不弹横幅（列表角标）；
  - **竞态去重**：WS 直推与厂商通道同 id 双达 → 按 `dedupeKey` 展示层去重（§6.4）；
- Android 13+ 前台通知无需特殊权限（已有 POST_NOTIFICATIONS 即正常展示）。

### 7.3 后台 / 杀死态

- **后台（进程存活）**：厂商通道到达走系统通知中心；`expo-notifications` `addNotificationReceivedListener` 可感知（iOS 后台可达、Android 视 ROM）；可选 headless task（`registerTaskAsync`，SDK 57 支持）做轻量处理（如更新角标）；
- **被杀死**：系统通知中心展示；点击 → 冷启动 → `useLastNotificationResponse` / `getLastNotificationResponseAsync`（SDK 57）取回点击的 notification → 路由跳转；
- **HMS 双显示问题**（§5.2.2）：前台时 HMS 通知消息会由系统直接展示——移动端处理：
  - 前台场景优先让服务端发**透传消息（data-only）**，由应用内渲染（统一走 expo-notifications 本地通知路径）；
  - 后台/被杀场景发**通知消息**（系统展示，不依赖应用进程）；
  - 服务端如何知道移动端前台/后台？——WS presence（§4.5）；WS 断连即按后台处理发通知消息；
  - 该双模式写入移动端实现要点 + 真机测试（§10.5）。

### 7.4 点击跳转（路由映射表）

`target.screen` 枚举与跳转目标（移动端路由契约，D8 实现）：

| screen | 触发场景 | 跳转目标 | 冷启动处理 |
| --- | --- | --- | --- |
| approval | S1 审批请求 / S2 审批过期 | 审批中心（或会话内审批卡，`params.toolCallId` 定位） | 启动后直达审批卡 |
| session | S3/S4/S5 run 终态、S10 异常 | 会话详情（`sessionId`），run 终态定位到错误卡/结果消息 | 启动后直达会话 |
| subagent | S6/S7 子代理完成/失败 | 子代理时间线（`subagentId`） | 启动后直达时间线 |
| task | S8 任务全场景 | 任务详情/后台任务面板（`taskId`） | 启动后直达任务 |
| timer | S9a 定时器到期 | 定时器详情（`timerId`） | 启动后直达 |
| audit | S11 安全拦截 | 审计面板（`sessionId`） | 启动后直达审计 |
| home | 夜间摘要等汇总 | 首页/通知中心 | 常规启动 |

跳转实现（SDK 57 文档已给出两条现成路径）：
- Expo Router：`useNotificationObserver` + `data.url` 深链（docs 原文示例）；
- React Navigation：`linking.getInitialURL` + `addNotificationResponseReceivedListener`；
- 契约约定：**跳转参数只依赖 `data.target`，不解析 title/body 文案**（文案可变、参数稳定）。

### 7.5 通知权限引导

- **Android 13+（API 33）**：`POST_NOTIFICATIONS` 运行时权限——系统弹窗（`requestPermissionsAsync`）；**必须先创建至少一个通知渠道再请求权限**（SDK 57 文档明确「prompt 不会出现直到至少一个 channel 被创建」）；渠道创建在 token 获取之前（同一文档）；
- **iOS**：`requestPermissionsAsync({ios: {allowAlert, allowBadge, allowSound}})`；`ios.status` 有 NOT_DETERMINED/DENIED/AUTHORIZED/PROVISIONAL/EPHEMERAL 五态（需按 ios.status 判断而非根 status，SDK 57 文档）；
- **引导时机与文案**：配对完成后、首次需要推送前引导（首次审批请求是天然引导点：「允许 Crish 发送通知，审批请求才不会漏」）；拒绝后提供设置页引导（iOS 跳系统设置，Android 引导到应用通知设置）；
- **厂商通道特殊性**：HMS/小米/vivo/OPPO 除系统权限外还有「厂商消息分类开关」（部分机型把应用通知细分）；移动端引导文案要提示用户开启「重要消息」分类（真机清单 §10.5 验证）。

### 7.6 iOS 与安卓差异

| 维度 | iOS | 安卓（国内） |
| --- | --- | --- |
| 系统通道 | APNs（国内可用） | 厂商通道（HMS/小米/vivo/OPPO/荣耀） |
| 推送服务 | 自建直连 APNs 或聚合商（不依赖 exp.host） | 自建逐厂商 REST |
| 前台通知 | `setNotificationHandler` 全可控 | 厂商通知消息由系统直接展示（需透传双模式，§7.3） |
| 通知渠道 | 无 channel 概念，用 `threadId` 分组 | Android 8+ 必须 channel（§7.7） |
| 静默推送 | 支持（contentAvailable + 后台任务，节流严格） | 厂商透传消息 |
| 权限 | 系统设置面板 + PROVISIONAL 可选 | Android 13+ 运行时弹窗 + 渠道级开关 |
| 角标 | badge 支持完整 | 部分桌面 launcher 支持 |
| 点击恢复 | `useLastNotificationResponse` | 同左（Expo 统一 API） |
| 锁屏正文隐藏 | iOS 设置 | 各厂商 ROM 设置（引导） |

### 7.7 通知渠道（Channel）设计（Android）

渠道与 category 映射（创建时机：应用启动即建，权限引导前）：

| channelId | category | importance | 用途 | 对应场景 |
| --- | --- | --- | --- | --- |
| approval | approval | MAX | 审批请求/过期（可全屏/震动） | S1/S2 |
| run | run | HIGH | run 完成/失败/取消 | S3/S4/S5/S10 |
| subagent | subagent | HIGH | 子代理完成/失败 | S6/S7 |
| task | task | HIGH | 后台任务完成/失败/卡死 | S8 |
| timer | timer | DEFAULT | 定时器/cron | S9 |
| security | security | MAX | 安全拦截/清除 | S11 |
| summary | system | LOW | 夜间摘要/合并汇总 | §3.4.3 |

- 用户可在系统设置中单独关掉低价值渠道（如 timer/summary）——**渠道是防打扰的最后一层用户控制**；
- 厂商通道侧同构：HMS/小米/vivo/OPPO 的通知分类与 channelId 对齐（厂商控制台配置），保证「渠道开关」在系统层生效。

---

## 8. 配置与密钥（核心交付 6）

### 8.1 凭据矩阵（存哪 / 谁用）

| 凭据 | 所在端 | 用途 | 敏感性 |
| --- | --- | --- | --- |
| 华为 App ID / App Secret | **桌面端** | HMS REST API OAuth2 换 AT | 高（能发推送） |
| 小米 AppId / AppSecret | 桌面端 | 小米推送 REST API | 高 |
| vivo AppId / AppKey / AppSecret | 桌面端 | vivo 推送 REST API | 高 |
| OPPO AppKey / MasterSecret | 桌面端 | OPPO 推送 REST API | 高 |
| 荣耀 AppId / AppSecret | 桌面端 | 荣耀推送 REST API（M2） | 高 |
| APNs AuthKey（.p8）+ KeyID + TeamID | 桌面端 | 直连 APNs（iOS） | 高 |
| agconnect-services.json / 厂商 SDK 配置 | **移动端（打包）** | 移动端 SDK 初始化与 token 获取 | 中（随包分发，需混淆保护） |
| 移动端各厂商 device token | 桌面端（device registry） | 发送目标寻址 | 中（需随设备删除清理） |
| WS 配对码/传输密钥 | 桌面端 + 移动端（配对时交换） | WS 直推认证与加密 | 高（局域网窃听防护） |

**结论：发送凭据全部只存桌面端**；移动端只持有「自己的 token 与厂商 SDK 配置」，没有发送能力（防滥用与泄密面最小化）。

### 8.2 桌面端存储

- **device registry**：SQLite 表（复用现有 `LocalDb` 连接，`main.rs:300-302` 的 `open_session_db` 同一连接或新建连接池）：
  - 表 `push_devices`：`device_id`（PK）、`device_name`、`platform`（android/ios）、`vendor`（hms/xiaomi/vivo/oppo/honor/apns）、`push_token`、`pair_code`、`paired_at`、`last_seen_at`、`timezone_offset_minutes`、`enabled`；
  - 表 `push_pending_approvals`（审批待发表，§9.3）：`approval_id`、`tool_call_id`、`session_id`、`summary`、`created_at`、`next_retry_at`、`retry_count`、`resolved`；
  - 表 `push_events_dedupe`（去重表，24h TTL 扫描清理）：`dedupe_key`（PK）、`first_seen_at`；
  - 表 `push_night_summary`（夜间摘要折叠表，§3.4.3）：`day`、`session_id`、`items`（JSON）。
- **厂商凭据**：优先环境变量（`CRISH_PUSH_HMS_APP_ID` 等），或复用现有密钥槽（`config/credentials.rs` 机制，main.rs:305 注释「ApiConfigStore + 密钥槽」）——**不落配置文件明文、不进 git**（.gitignore 校验，`git check-ignore` 验证）。

### 8.3 环境隔离（dev / prod）

| 维度 | dev | prod |
| --- | --- | --- |
| 厂商控制台 | 每个厂商建 dev 应用（包名后缀 `.dev` 或独立签名） | 正式应用（包名/签名与商店一致） |
| 凭据 | dev AppId/Secret（env 注入） | prod 凭据（env/密钥槽） |
| 移动端打包 | dev build（Expo dev client，debug 签名） | release（生产签名 + 商店） |
| 推送目标 | 白名单设备（配对码限 dev 设备） | 全部已配对设备 |
| 静默时段 | 默认关（方便联调） | 默认开 |
| 审批重推 | 缩短阶梯（5min 起步，方便测） | 正式阶梯（15min 起步） |
| 日志 | 全量（含 payload 脱敏版） | 摘要级（不落 token/凭据） |

- **同一 schema 双环境共推**：PushMessage 增加 `env: "dev"|"prod"` 字段，移动端 dev build 只消费 dev 消息、prod 只消费 prod 消息（防 dev 误推真实用户）；
- 海外发行（若做）单独通道配置：Expo Push Service（海外）与国内厂商通道按构建渠道隔离，互不干扰。

### 8.4 安全要点

1. 厂商凭据不进 git、不进日志（tracing 打码）；
2. WS 配对：6 位配对码一次性、5 分钟过期；连接后 TLS 或至少 AES 会话密钥（局域网环境）；设备指纹绑定；
3. 厂商 token 属于个人信息（《个人信息保护法》）：移动端配对时明示收集用途；token 随设备解绑即删；
4. 推送内容脱敏（§6.3）——厂商通道 payload 白名单机制 + 代码评审红线（不允许新字段直接透传进厂商 data）；
5. 审批待发表可被重放 → 重推阶梯用 `approval_id` 幂等（同 id 不重复计数）。

---

## 9. 与现有代码融合（核心交付 7）

### 9.1 事件面触发点清单（文件:行号）

推送策略引擎的输入是事件流，触发点全部是既有发射点（**零侵入**——只加旁路监听）：

| 触发点 | 位置 | 事件 | 推送场景 |
| --- | --- | --- | --- |
| 审批请求（执行批内先发） | crates/session-loop/src/loop/handlers/executing_tools.rs:241-268 | approval-requested | S1 |
| 审批门（先发后等防死锁） | crates/session-loop/src/approval.rs:110-115 | approval-requested | S1 |
| 批级审批先发 | crates/session-loop/src/tool_exec.rs:384、677-680 | approval-requested（全组先发） | S1（合并） |
| 审批裁决 | orchestrator/src/run.rs:44、146、368（RunStatus::AwaitingApproval） | approval-resolved | S2 |
| 审批事件持久化 | crates/orchestrator/src/events.rs:8、43、106（同步等待落库） | 审批类事件 | S1/S2（推送读取时已可观测） |
| run 终态 | crates/conex-types/src/events.rs:511-519（类型）；emit 层由 orchestrator 收口发射 | run-terminal | S3/S4/S5 |
| 子代理结束 | events.rs:615-626 | subagent-ended | S6/S7 |
| 任务七事件 | events.rs:635-728；发射链 background.rs:2001、task_event_consumer.rs:242、main.rs:397-399 | task-* | S8 |
| 定时器/cron | events.rs:737-746、765-781；drain 链 main.rs:430-441（500ms 周期转发） | timer-fired / cron-fired | S9 |
| 运行异常 | events.rs:453-460、470-477 | runtime-error / intervention | S10 |
| 安全审计 | events.rs:556-577 | security-audit | S11 |
| 缓存告警 | events.rs:532-543 | cache-waste-alert | S12 |
| 事件桥（统一出口） | apps/agent-workbench/src-tauri/src/core_event_bridge.rs:51-145 | 全事件 | 旁路挂点 |

### 9.2 桥接层挂点（PushEmitter 方案）

**推荐实现**：事件桥发射路径加旁路监听器，不动既有发射逻辑。

- 方案 a（推荐）：在 `main.rs:344-348` 事件桥装配处，把 `EventBridge` 的 `Emitter` 包一层 `PushAwareEmitter`（实现 `Emitter` trait，core_event_bridge.rs:51-54）：
  - 转发原 channel（行为不变）；
  - 同步把 payload 交给推送策略引擎（`push_core::on_event(json)`，内部反序列化信封 → push_intent）；
  - `Emitter` trait 是唯一抽象，测试替身机制现成（core_event_bridge.rs:155-181 RecordingEmitter），**现有测试零破坏**；
- 方案 b（备选）：`BufferedRunEventBridge::flush`（engine.rs 内）处加钩子——侵入引擎侧，**不推荐**（引擎保持纯净）；
- 任务/定时器/cron 事件已有独立发射链（main.rs:397-399、430-441），推送旁路同样在桥层接线（`set_event_bridge` 之后的统一出口，task_event_consumer.rs:242 与 engine::forward_drained_*_events 均走同一 bridge）；
- 推送引擎生命周期：随 CoreRunState 一起 `app.manage`（main.rs:388 同款模式），后台发送任务用 `tauri::async_runtime::spawn`（main.rs:381-383 先例）。

**新增模块建议**（apps/agent-workbench/src-tauri/src/push/）：

```
src/push/
  mod.rs            模块登记（对齐 lib.rs:7-11 模块登记注释风格）
  core.rs           推送策略引擎：push_intent / coalesce / quiet_hours / throttle
  copy.rs           推送文案（复用 wakeup_summary 风格）
  schema.rs         PushMessage 结构（serde，对齐事件契约风格）
  registry.rs       设备注册表（SQLite）
  relay.rs          WS 中继（tokio TcpListener + 配对 + presence + 直推）
  vendor/
    mod.rs          VendorPushChannel trait + dispatcher（并发/重试/退避）
    hms.rs          HMS Push REST 客户端（OAuth2 AT + messages:send）
    xiaomi.rs / vivo.rs / oppo.rs / apns.rs
  approve.rs        审批待发表 + 重推阶梯（SQLite + 定时扫描）
  tests.rs          （见 §10）
```

### 9.3 审批推送优先级（不能漏的落地保障）

审批是移动端最高价值场景，从四条链路保证「不能漏」：

1. **事件级**：approval-requested 是 Critical 背压（events.rs:891 走 `_ => Critical` 分支），事件必达落库（orchestrator/src/events.rs:106 同步等待落库）——**事件层已经保证不丢**，推送层只需消费落库后的观测；
2. **推送级**：S1 场景 P0 最高级，厂商通道高优先级消息 + 审批专属 channel（MAX importance，§7.7）；
3. **重推级**：`push_pending_approvals` 表持久化 + 重推阶梯（15min/60min/每小时×5）+ 过期（approval-resolved=expired）立即补推并停止（§3.3 S1）；桌面端重启后扫描恢复——**桌面端崩溃/重启不丢审批推送**；
4. **双通道级**：审批类即使移动端在线也双发（WS 直推 + 厂商通道，展示层按 dedupeKey 去重）——在线判定竞态下仍可达（§6.4 例外规则）。

桌面端审批 UX 联动（不冲突）：桌面端现有审批弹窗（`useChatApprovalHandlers.ts:26-31`、ApprovalSection 的「批准/拒绝」+ toast）保持不变；推送只在桌面端展示层面不重复弹（桌面端专注弹窗，移动端专注推送）。

### 9.4 前端/移动端消费模式对齐

- 桌面前端与移动端消费同一「事件 → 用户价值」语义，避免双端行为分叉：
  - 桌面端 toast 策略（成功禁 toast、去重键、TTL/队列上限，useToastQueue.ts:55-58、75-180、258-260）→ 移动端推送防打扰策略直接对齐（§3.4）；
  - 桌面端数据面子路由（dataPlaneRouter.ts:59-70 10 类 + :185-189 子代理 3 类 + :211-212 活跃 run 集合）→ 移动端「目标页面活跃判定」同构；
- 移动端不重复实现事件筛选：推送 schema 已含 severity/category/target，移动端只做呈现与跳转（§6.2）。

### 9.5 与唤醒摘要的边界

- `wakeup_summary`（唤醒摘要）面向「AI 的 steering 注入」，推送文案面向「人的通知」——两者文案风格共用但消费方不同：
  - 不把推送引擎塞进 wakeup_summary（保持其纯函数职责）；
  - 新增 `push/copy.rs` 复用其模板函数（S3/S6/S8b/S9 直接调用 `wakeup_summary()`，其余场景新模板）；
  - 未来如需「AI 被推送唤醒」（定时器场景由 steering 面唤醒，02-CF §4.7 语义），推送层只生成人的通知，不做 AI 唤醒——职责不越界。

---

## 10. 测试方案（核心交付 8）

### 10.1 测试分层

| 层 | 对象 | 工具 | 门禁 |
| --- | --- | --- | --- |
| 单元 | push/core（筛选/合并/静默/节流）、copy（文案）、schema（序列化）、registry（SQLite）、approve（重推阶梯） | Rust `cargo test`（vitest 不适用，纯 Rust） | 快层（并入现有 cargo test 基线） |
| 集成 | vendor dispatcher（mock 厂商网关）、relay（WS 配对/直推/Ack）、双通道去重 | tokio test + mock HTTP 网关 | 中层 |
| 端到端 | 真机矩阵（§10.5） | 手动 + 脚本化检查清单 | 发版前 |
| 前端（桌面） | 推送设置 UI、配对 UI（如做） | vitest（现有前端门禁） | 快层 |

### 10.2 单元测试清单（Rust 侧）

**push/core.rs（策略纯函数，注入时钟与配置）：**

| 用例 | 断言 |
| --- | --- |
| 41 事件全量判定 | 每个事件类型都返回预期级别（P0/P1/P2/P3），与 §3.2 表逐行一致（护栏：新事件类型必须补 arm，对齐 registry_drift.rs 模式） |
| approval-requested 必达 | 返回 P0 + dedupeKey=`approval-requested:{toolCallId}` + approval 登记引用 |
| approval-resolved 子集 | approved/denied → None；expired → P2（或 P0 补推触发） |
| run-terminal 分级 | completed→P1、failed→P0（带 error）、cancelled→P1 |
| security-audit 子集 | blocked/purged → P0；approved/denied/redirected/restored → None |
| task 域 | output/heartbeat → None；suspicious → P0；failed → P0；completed → P1；killed → 按 kill 来源 |
| 合并规则 | 60s 窗口 run-terminal + subagent-ended → 1 条；同 batch 审批 → 1 条；task-suspicious→failed → 1 条 |
| 静默时段 | P1 在 22:30-07:30 → defer-to-summary；P0 仍 send-now；次日 07:30 摘要生成 |
| 节流 | 同 device 每分钟第 3 条被合并；每日第 51 条折叠为日报 |
| 去重 | 同 dedupeKey 24h 内重复到达 → None（审批表除外，走重推逻辑） |

**push/copy.rs：**

- 每场景模板渲染正确（S1-S12 全覆盖）；
- 占位符零残留（复用 wakeup_summary.rs:393-447 断言模式）；
- 正文截断（120 字）、error/tail/parameters 摘要截断（80/100 字）；
- 厂商通道 payload 白名单校验：`data` 只含允许字段（敏感字段白名单测试，§6.3）。

**push/schema.rs：**

- PushMessage serde roundtrip；
- 厂商通道适配子集（HMS/小米/vivo/OPPO 字段映射）在 4KiB 内（构造最大载荷用例断言长度）。

**push/approve.rs（重推阶梯，注入时钟）：**

- 登记 → 阶梯时间点 → 重推 N 次 → expired 停止；
- 重启恢复（SQLite 持久化 → 重新扫描 next_retry_at）；
- 幂等：同 approval_id 不重复计数；
- 审批过期立即补推「已过期」+ 停止重推。

**push/registry.rs：**

- 设备增删查、token 更新、配对码一次性/过期、DeviceNotRegistered 清理、时区字段存取。

### 10.3 集成测试（mock 厂商通道 / 离线场景）

- **Mock 厂商网关**（tokio + 本地 HTTP mock，仿 `core_run_commands.rs:5295` 的 `TcpListener::bind("127.0.0.1:0")` 先例）：
  - HMS：OAuth2 token 交换成功/失败/过期刷新；messages:send 200/4xx/5xx/429（退避重试断言）；超时；
  - 小米/vivo/OPPO/APNs：同构用例；
  - **DeviceNotRegistered**：响应后断言 registry 设备被清理、不再发；
- **dispatcher 并发**：4 worker 并发发送、队列满时 P0 持久化（SQLite 待发表）不丢、P1 可丢计数；
- **relay（WS 中继）**：
  - 配对：扫码码正确/错误/过期、一次性消费；
  - presence：心跳正常/超时判离线（30s 注入时钟）；
  - 直推：connected+active 只直推（厂商不发，断言 mock 网关零调用）；
  - 竞态：presence 刚切换离线 + 直推双发 → 移动端侧去重（mock 客户端断言按 dedupeKey 合并）；
  - 离线场景：offline → 只厂商发，断言载荷为摘要级（data 白名单）；
- **审批全链路**（mock 网关 + 注入时钟）：approval-requested → 直推 + 厂商高优先级 → 无 Ack → 15min 重推 → expired → 补推 + 停。

### 10.4 桌面端 / 前端测试

- 推送设置 UI（如做设置面板）：开关/静默时段/摘要开关 → vitest 组件测试（对齐现有前端测试模式）；
- 桌面端「离线诊断」入口（`status_diagnostics.rs` 模式）：显示设备在线数/厂商通道健康度（mock 注入）。

### 10.5 国内真机适配清单

发版前真机矩阵（每机型 × 每状态）：

| 状态 \ 机型 | 华为 Mate/P 系 | 荣耀 Magic | 小米/红米 | vivo/iQOO | OPPO/一加/realme | 三星（可选） | iPhone |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 锁屏（亮屏通知） | 必测 | 必测 | 必测 | 必测 | 必测 | 可选 | 必测 |
| 后台 10min（进程存活） | 必测 | 必测 | 必测 | 必测 | 必测 | 可选 | 必测 |
| 后台清杀（从最近任务划掉） | 必测 | 必测 | 必测 | 必测 | 必测 | 可选 | 不适用（iOS 无清杀概念，模拟 force quit） |
| 省电/深眠模式 | 必测 | 必测 | 必测 | 必测 | 必测 | 可选 | 低电量模式 |
| 通知分类开关（厂商） | 必测（系统通知分类） | 必测 | 必测（私信/提醒分类） | 必测（系统消息） | 必测（IM/系统） | — | — |

每状态验证点：

1. 审批请求必达（锁屏横幅 + 声音可选）；
2. run 完成（P1）锁屏可达；静默时段不发（或夜间摘要）；
3. 点击跳转冷启动直达目标页（§7.4 全 screen 各一遍）；
4. 前台双显示问题：HMS 通知消息 vs 透传消息模式切换正确（§7.3）；
5. 设备 token 轮换（厂商 token 变更 → 移动端 addPushTokenListener 同构逻辑重注册）；
6. 卸载重装 → 旧 token 失效 → DeviceNotRegistered 清理。

---

## 11. 风险与缓解（核心交付 9）

### 11.1 厂商通道风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 审核周期 | 华为/小米/vivo/OPPO 均需开发者认证 + 应用创建 + 推送服务开通，周期 1-5 个工作日不等 | 尽早申请；M1 先做 HMS（华为开发者联盟认证最快）；申请清单整理成文档（附录 B 可加） |
| 消息分类管控 | 厂商对「营销类」限流/降级，分类选错送达率骤降 | 审批/任务类映射「IM/系统/私信」分类；控制台预申请高优先级/系统消息；真机验证（§10.5） |
| 配额限制 | OPPO 正式环境日配额、vivo 测试环境配额、小米频控 | 推送前节流（§3.4.4）；超配时降级为合并摘要；配额告警（诊断面板） |
| 兼容碎片化 | 各厂商 ROM 对通知展示/渠道开关/自启动策略差异大 | 真机矩阵（§10.5）；厂商通道适配层隔离（vendor trait），新机型问题只改对应实现 |
| 荣耀独立通道 | 荣耀机型 HMS 覆盖情况因系统版本而异 | 真机验证（Magic 系必测）；必要时 M2 加接荣耀推送 |
| token 时效 | 厂商 token 会轮换/失效 | 移动端 token 监听上报（SDK 57 addPushTokenListener 同构）；DeviceNotRegistered 清理（§10.3） |
| 长尾厂商 | 三星/魅族/中兴等份额小 | M2 经聚合商补（个推/极光）或明确放弃 |

### 11.2 Expo 推送服务风险（重点结论）

- **国内安卓：Expo Push Service 不可用**（FCM 被墙 + 无 GMS token），本方案不依赖——**已用架构规避**；
- **iOS 直连 exp.host：不稳**（美国服务器、无 SLA、国内访问抖动）——方案要求 iOS 走自建 APNs 直连或聚合商，exp.host 仅海外发行备选；
- **expo-notifications 本身无风险**：它只是本地能力库（呈现/点击/渠道），不依赖 exp.host 的 API 也能用（`getDevicePushTokenAsync` 直接取厂商/FCM token 路径存在，但国产厂商 token 仍需厂商 SDK，§5.2.2）；
- **Expo 版本演进**：SDK 57 文档已确认「Expo Go 安卓 SDK 53 起不支持远程推送，必须 dev build」——移动端必须以 dev build/正式包交付，不能用 Expo Go 演示（风险告知 D8）。

### 11.3 合规风险（个人信息）

| 风险 | 缓解 |
| --- | --- |
| device token / 设备信息属个人信息（个保法） | 配对时明示用途；注册表限本机存储；解绑即删 |
| 推送内容过厂商服务器（摘要级） | §6.3 敏感度白名单；审批参数全文不上市厂通道；数据最小化设计 |
| 国内应用商店对推送权限的合规要求 | 按各商店要求声明推送用途（HarmonyOS NEXT/华为商店、小米商店等）；隐私政策补充推送条款 |

### 11.4 桌面端常驻风险

| 风险 | 缓解 |
| --- | --- |
| 桌面关机 = 推送断源 | 一期接受并明确告知（架构属性）；M3 云中继解决；桌面端开机自启 + 托盘常驻（现有 watchdog.rs 先例）作为缓解 |
| 桌面端崩溃丢推送 | 审批待发表持久化（§9.3）——审批不丢，其余尽力 |
| 局域网 WS 安全 | 配对码一次性 + 会话密钥 + 仅内网绑定（不暴露公网） |
| 多桌面共存（未来） | device registry 预留 `desktop_id` 列；本期单桌面 |

### 11.5 风险缓解汇总表（一张表收口）

| 风险 | 概率 | 影响 | 缓解 | 责任方 |
| --- | --- | --- | --- | --- |
| 厂商审核延迟 | 高 | 中 | 尽早申请、M1 单厂商起步 | D8 + 运营 |
| 分类管控致送达率低 | 中 | 高 | 高优分类申请 + 真机矩阵 | D8 |
| 配额超限 | 中 | 中 | 节流 + 折叠降级 + 告警 | 桌面端 |
| ROM 碎片化 | 高 | 中 | 真机矩阵 + vendor 隔离 | D8 |
| 桌面关机断源 | 高 | 中 | 告知 + M3 云中继 | 产品 |
| Expo Go 不能演示推送 | 中 | 低 | dev build 交付（告知 D8） | D8 |
| 隐私合规 | 中 | 高 | 摘要白名单 + 隐私条款 | 产品 + 桌面端 |

---

## 12. 里程碑分期

| 阶段 | 范围 | 交付 | 依赖 |
| --- | --- | --- | --- |
| M0 在线直推（1-2 周） | WS 中继 + 配对 + 推送策略引擎（筛选/去重/文案）+ 移动端应用内通知 + 点击跳转 | 桌面开、手机在线的完整链路；审批必达（WS 通道） | 移动端 D8 配套 |
| M1 离线兜底第一站（2-4 周） | vendor trait + HMS Push + APNs 直连 + 审批待发表/重推阶梯 + DeviceNotRegistered 清理 | 华为系 + iPhone 离线可达；审批不丢闭环 | 华为开发者账号、Apple Developer |
| M2 全厂商矩阵（4-6 周） | 小米/vivo/OPPO 接入 + 静默时段/夜间摘要 + 合并优化 + 真机矩阵全量 | 国内安卓全覆盖；防打扰完整 | 各厂商账号与审核 |
| M3 自建中继（可选） | 云中继 + 账号体系 + 多桌面 | 桌面关机仍可达；多端多设备 | 服务器/备案/账号 |

关键里程碑验收标准：

- M0：手机与桌面同局域网、桌面开 app、手机前台 → 桌面发起审批 → 手机 1 秒内收到并可跳转审批；手机断 WS → 收不到（预期）；
- M1：手机息屏/清杀 → 审批请求 10 秒内到达华为系手机通知中心；桌面端杀进程重启 → 未决审批 15 分钟后仍重推；iOS 同局域网 + APNs 可达；
- M2：小米/vivo/OPPO 真机矩阵通过（§10.5 全绿）；静默时段只收夜间摘要；同 session 高频任务不刷屏。

---

## 13. 附录

### 13.1 参考资料（网络查证摘要）

1. Expo 官方文档《Push notifications: Overview》— expo 承担 FCM/APNs 对接，Android 必须 FCM；
2. Expo 官方文档《Expo push notifications setup》— FCM v1 凭证、expo-notifications + expo-constants 安装、projectId、push token 流程；
3. Expo 官方文档《Send notifications with the Expo Push Service》— exp.host HTTP/2 API、tickets/receipts、DeviceNotRegistered/MessageTooBig/MessageRateExceeded 等错误码、600 条/秒限制、100 条/请求、4KiB 载荷、TTL/priority/collapseId/tag/channelId/threadId 语义、无 SLA、服务器位于 GCP US；
4. Expo SDK 57《Notifications》参考 — 前台 handler（3s 超时）、Android 13 权限与渠道先建约束、iOS ios.status 五态、useLastNotificationResponse/getLastNotificationResponseAsync、addPushTokenListener/getDevicePushTokenAsync、registerTaskAsync 后台任务、Expo Go 安卓 SDK 53 起不支持远程推送；
5. GitHub HMS-Core/hms-react-native-plugin — 华为官方 RN 插件集（@hmscore/react-native-hms-push，Apache-2.0；海外版 react-native-hms-push-fcm）；
6. 维基百科《统一推送工作委员会》— 2017 联盟 → 2022 升格；规范统一、各家自营；华为/荣耀名义适配实际自家推送；15 品牌适配清单。

### 13.2 开放问题（需评审裁决）

1. **聚合商 vs 逐厂商**：M1 是否先用个推/极光提速（覆盖长尾），M2 再转自建？——本方案默认 M1=HMS 自建，评审可改；
2. **审批远程处理**：一期移动端只收审批通知，能否在移动端直接批准/拒绝？（涉及桌面端安全模型与多端一致性，超出本任务范围，需产品决策——本方案 schema 已预留 `target.screen=approval` 与 `toolCallId`，若批准需新增移动端→桌面命令通道）；
3. **静默时段默认值**：22:30-07:30 是否合理？是否按「仅周末/工作日」区分？
4. **M3 云中继**：是否立项？私有部署 vs 托管？
5. **夜间摘要开关**：默认开还是关？

### 13.3 本文档与代码的对应关系（评审复核索引）

- 事件契约：`crates/conex-types/src/events.rs`（41 变体 events.rs:306-782、type 名 events.rs:810-852、背压 events.rs:867-893、信封 events.rs:921-993）；
- 审批产生点：`crates/session-loop/src/loop/handlers/executing_tools.rs:241-268`、`crates/session-loop/src/approval.rs:110-115`、`crates/session-loop/src/tool_exec.rs:384/677-680`；
- 审批状态机：`crates/orchestrator/src/run.rs:44/146/368`；
- 事件桥：`apps/agent-workbench/src-tauri/src/core_event_bridge.rs:51-145`、装配 `main.rs:344-348`；
- 唤醒摘要：`apps/agent-workbench/src-tauri/src/wakeup_summary.rs:63-135`；
- 前端 toast 策略：`apps/crish-desktop/src/hooks/useToastQueue.ts:55-58/75-180/258-260`；
- 前端事件路由：`apps/crish-desktop/src/api/chat-bridge/dataPlaneRouter.ts:59-70/185-189/211-212`；
- 桌面审批 UX：`apps/crish-desktop/src/components/chat-card/useChatApprovalHandlers.ts:26-64`。

### 13.4 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-08-09 | 初稿（D7 交付物）；41 事件勘误、三路线评估、厂商矩阵、分层架构、测试与风险闭环 |
