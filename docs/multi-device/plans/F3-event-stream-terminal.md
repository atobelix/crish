# F3 功能域方案：手机端事件流与终端输出（事件流与终端域）

- 文档代号：F3-event-stream-terminal
- 关联功能域：F1（会话与同步）、F2（审批中心）、F4（文件与资源）、F5（会话消息）、D1（总体架构）、D3（协议）、D6（同步一致性）、D7（推送通知）
- 本方案职责：**手机端实时查看桌面端 run 的事件流（时间线 feed）与终端输出**；只读展示面，不承载桌面端审批动作（归 F2）、不承载发送消息/发起 run（归 F1/F5）、不承载交互式 PTY（桌面专属能力）。
- 设计原则：**事件契约零改动**——复用 `AgentEvent` 41 变体与 `AgentEventEnvelope` 信封（`crates/conex-types/src/events.rs`），复用桌面端已沉淀的解析、去重、背压、批合并语义；手机端只新增「消费面 + 渲染面」，不在 Rust 侧新增任何事件类型或字段。

## 1. 背景与目标

桌面端 run 在执行期间持续发射 41 种域事件（`events.rs:306-782`），经 Tauri IPC 事件桥（`buffer.rs` 背压缓冲 + `EventRouter` 分派）实时驱动聊天界面。手机端的核心诉求是**不打开电脑也能看到任务进展**：

- 桌面 run 进行中，手机实时看到：消息正文增量、工具调用（含 shell 命令输出流）、run 状态、审批请求、后台任务、缓存指标、错误。
- 手机端是**纯观察端**：不修改 run 执行（无 cancel/approve/重试等控制动作——除 F2 审批中心已有的审批动作外），控制动作后续版本再评估。

### 1.1 目标场景（用户故事）

| 编号 | 场景 | 说明 |
|---|---|---|
| F3-US1 | 观察 run 进展 | 用户在手机发起/发现桌面正在执行任务，打开事件流页实时看到消息、工具调用、输出流 |
| F3-US2 | 盯 shell 输出 | 桌面正在跑长命令（构建/测试），手机看到逐行流式输出，不阻塞聊天正文 |
| F3-US3 | 后台提醒 | 手机切后台，任务失败/审批请求/后台任务终态到达时收到本地通知（推送细节归 D7） |
| F3-US4 | 事后复盘 | run 结束后浏览完整事件时间线，过滤只看错误，查看工具调用详情 |
| F3-US5 | 缓存与开销感知 | 在事件流中看到缓存命中率/浪费告警徽标，判断任务是否「烧钱」 |

### 1.2 非目标（边界）

- 不做交互式终端输入（PTY stdin）——`TerminalCard.xterm.tsx` 依赖 xterm + PTY 桌面能力，手机端只读。
- 不做审批动作（归 F2-approval-center）。
- 不做 run 控制（取消/重试/发起新 run）。
- 不在 Rust 侧新增事件或字段（事件契约冻结，仅消费）。
- 不重放历史事件流全量（历史回看由同步域 F1/D6 提供会话快照，本域只做「快照之上的增量」）。

### 1.3 术语表

| 术语 | 含义 |
|---|---|
| feed | 手机端事件流时间线视图（本域主界面） |
| run | 一次 agent 执行（agent-start → agent-end/run-terminal），信封 runId 标识 |
| 信封 | `AgentEventEnvelope` 扁平 JSON 帧（`events.rs:921-933`），携带 type/runId/sequence/schemaVersion |
| S1 协议 | 工具执行流式输出协议：tool-start → tool-update* → tool-end（`tool_events.rs:1-9`） |
| Delta/Soft/Critical | 事件背压三级（`events.rs:167-188`）：可丢/尽力/必达 |
| 终态权威 | message-end 全文 / tool-end 终值覆盖流式增量（`eventUtils.ts:49-63`） |
| 快照 | 同步域提供的 run 历史状态（F1/D6），用于断线重建 |
| 脏标记 | 后台模式下的合并写入标记（1s 一次补齐渲染） |
| 环形缓冲 | 有界内存结构（feed 500 条 / 行缓冲 200 行），超出淘汰最早条目 |
| 数据面 | task-*/timer-*/cron-fired 10 类无 run 归属事件（`dataPlaneRouter.ts:59-70`） |

## 2. 事件面盘点（41 变体 → 手机端三分类）

事实源：`crates/conex-types/src/events.rs`（事件注册表编号 1-41，`ALL_TYPE_NAMES` 见 `events.rs:810-852`）。桌面端消费行为佐证：`apps/crish-desktop/src/api/chat-bridge/`（分派表 `dispatch.ts:78-134`、各 handler 显式空实现或真实消费）。

分类定义：

- **实时流展示型（S）**：事件携带增量内容或状态变化，进入时间线 feed 做**增量渲染**；手机端主消费面。
- **通知型（N）**：事件本身有价值但**不产生连续画面**——app 在前台时合并进 feed 高亮（或折叠为状态徽标），app 在后台/未打开 run 页时触发本地通知（推送语义细节归 D7，本域只给出「通知触发点」清单）。
- **忽略型（I）**：无 UI 价值、或桌面端已显式空实现、或仅内部观测用途；手机端**不消费**（或仅记日志水位），防高频噪声。

### 2.1 Agent 域（4 个）

| # | 事件（wire 名） | 位置 | 桌面消费 | 分类 | 手机端处理 |
|---|---|---|---|---|---|
| 1 | `agent-start` | `events.rs:309-314` | 空实现（`lifecycleHandlers.ts:13-18`） | S | feed 的 **run 分组头**：run 启动时间、会话归属（run 状态卡骨架） |
| 2 | `agent-end` | `events.rs:316-323` | reason→finish / error→surfaceStreamFailure（`lifecycleHandlers.ts:20-60`） | S | run 分组头的**收尾状态**（reason + error 摘要）；error 时红色高亮 + 通知 |
| 3 | `turn-start` | `events.rs:327-332` | 空实现（`lifecycleHandlers.ts:62-67`） | S（轻量） | 时间线**轮次分隔线**（第 N 轮），折叠/展开粒度 |
| 4 | `turn-end` | `events.rs:334-340` | 空实现（`lifecycleHandlers.ts:69-74`） | S（轻量） | 轮次小结：`toolCallCount` 次工具调用（分隔线尾部注记） |

### 2.2 Message 域（3 个）

| # | 事件 | 位置 | 桌面消费 | 分类 | 手机端处理 |
|---|---|---|---|---|---|
| 5 | `message-start` | `events.rs:344-348` | 空实现（`messageHandlers.ts:68-73`） | I | 桌面已显式空实现；手机端由 message-end 收口，无需此事件（弱信号，无增量内容） |
| 6 | `message-delta` | `events.rs:350-356` | 增量正文 onChunk / thought 累积（`messageHandlers.ts:75-107`） | S | **流式正文渲染**：block.type = text 追加正文、thought 追加思考块；消息气泡实时更新 |
| 7 | `message-end` | `events.rs:359-367` | 终态全文 + turnIndex 分段合并（G4，`messageHandlers.ts:109-168`） | S | **终态权威**：以 message-end 全文替换流式增量（`mergeAssistantTextPiece` 语义复用）；顺带收割消息级缓存指标（`computeCacheMetricsFromUsage`）挂徽标 |

关键契约（手机端必须继承）：**message-delta 可丢、message-end 必达**——`buffer.rs:36-42` `drop_class_of` 仅 message-delta 属 Soft（可丢），丢帧不丢 message-end（全文兜底，`buffer.rs:7-11`）；前端消费侧按「增量累积 + 终态全文合并」渲染（`eventUtils.ts:49-63`）。手机端照抄该语义即可获得与桌面一致的容错性。

### 2.3 Tool 域（6 个）

| # | 事件 | 位置 | 桌面消费 | 分类 | 手机端处理 |
|---|---|---|---|---|---|
| 8 | `tool-start` | `events.rs:371-377` | onToolStart（`toolHandlers.ts:12-23`） | S | **工具调用卡片创建**：icon + 工具名 + 人话摘要（`toolHumanLabel` 语义）+ 入参预览（折叠） |
| 9 | `tool-update` | `events.rs:379-386` | **空实现**（`toolHandlers.ts:25-30`） | S | **终端流式输出卡片**（S1 协议，见 §4）：update.text 增量 append；`metadata.kind='tool-progress'` 普通进度 / `tool-args-delta` 参数预览（`partialToolArgs.ts:52-62`）——**手机端领先桌面端消费此事件** |
| 10 | `tool-end` | `events.rs:388-394` | onToolSuccess/onToolError（`toolHandlers.ts:32-45`） | S | 卡片收口：成功 ✓ / 失败 ✗ + 结果预览（`toolResultPreview` 语义）+ 耗时；isError 红色高亮 + 通知触发点 |
| 11 | `tool-batch-start` | `events.rs:396-403` | 显式 ignore（`toolHandlers.ts:47-52`） | I | 桌面显式 ignore；手机端不消费（批内并行组信息由 tool-start 逐个到达，无增益） |
| 12 | `tool-batch-end` | `events.rs:405-411` | 显式 ignore（`toolHandlers.ts:54-59`） | I | 同上 |
| 13 | `tool-input-repaired` | `events.rs:413-420` | 空实现（`toolHandlers.ts:61-66`） | I | 桌面空实现；工具入参修复属内部细节，手机端忽略（避免噪音） |

时序契约（S1，`crates/session-loop/src/tool_events.rs:1-9`）：`tool-batch-start → (tool-start → approval-requested → tool-update* → tool-end)* → tool-batch-end`。tool-update 恒位于 tool-start 与 tool-end 之间，零或多条。手机端按此契约把卡片生命周期建模为 `created → (streaming)* → finalized` 状态机。

### 2.4 压缩域（2 个）

| # | 事件 | 位置 | 桌面消费 | 分类 | 手机端处理 |
|---|---|---|---|---|---|
| 14 | `context-compression-start` | `events.rs:424-430` | 空实现（`compressionHandlers.ts:10-15`） | S（轻量） | 时间线**进度条目**：「上下文压缩中（N tokens 前）」——用户在手机上看到任务在压缩而非卡死 |
| 15 | `context-compression-end` | `events.rs:432-441` | 空实现（`compressionHandlers.ts:17-22`） | S（轻量） | 条目收口：压缩完成 / aborted / error 标注 |

### 2.5 诊断/审批/检查点域（6 个）

| # | 事件 | 位置 | 桌面消费 | 分类 | 手机端处理 |
|---|---|---|---|---|---|
| 16 | `provider-diagnostic` | `events.rs:445-450` | 仅 logInternalError（`diagnosticHandlers.ts:12-17`） | I | 桌面仅日志；手机端忽略（不消费，防噪声） |
| 17 | `runtime-error` | `events.rs:453-460` | surfaceStreamFailure（`diagnosticHandlers.ts:19-25`） | N | **错误条目 + 通知**：错误文案 + retryable 标记；点击进错误详情（见 §5.3） |
| 18 | `runtime-steering` | `events.rs:462-468` | 空实现（`diagnosticHandlers.ts:27-32`） | I | 桌面空实现；steering 注入属内部机制，手机端忽略 |
| 19 | `runtime-intervention-required` | `events.rs:470-477` | 空实现（`diagnosticHandlers.ts:34-39`） | N | **高优先级通知 + feed 醒目条目**：reason + choices 列表展示（手机端只读展示候选动作，不执行）；run 以 stop 收场（`events.rs:469` 注释），告知用户回桌面处理 |
| 20 | `approval-requested` | `events.rs:479-484` | onToolPendingApproval / 白名单自动放行（`approvalHandlers.ts:25-114`） | S + N | feed 工具卡置 `pending_approval` 态（`toolRowTone` 语义）；后台时**立即通知**（审批时效敏感）；**点击跳转 F2 审批中心**处理 |
| 21 | `approval-resolved` | `events.rs:487-495` | onApprovalResolved（`approvalHandlers.ts:116-146`） | S | 卡片状态更新：批准 ✓ / 拒绝 ✗ / 过期 ⏱ |
| 22 | `checkpoint-created` | `events.rs:497-502` | 空实现（`compressionHandlers.ts:24-30`） | I | 桌面空实现；检查点属恢复机制，手机端忽略 |
| 23 | `checkpoint-restored` | `events.rs:504-509` | 空实现（`compressionHandlers.ts:31-36`） | I | 同上 |

### 2.6 缓存测量域（3 个）

| # | 事件 | 位置 | 桌面消费 | 分类 | 手机端处理 |
|---|---|---|---|---|---|
| 24 | `cache-stats-updated` | `events.rs:524-529` | cacheEventsStore（`cacheEventHandlers.ts:25-32`） | S（徽标） | **缓存指标徽标**：命中率 hitRatio / 总 token / 写占比 writeRatio（`RunCacheStats` 字段 `events.rs:238-266`）；sample_count=0 或比例 None 时隐藏而非显示 0%（`events.rs:254-256` 注释） |
| 25 | `cache-waste-alert` | `events.rs:532-543` | cacheEventsStore.pushWasteAlert（`cacheEventHandlers.ts:34-46`） | N | 徽标变红 + 通知：浪费量 missedTokens / 预估金额 missedCostUsd / 归因 attribution（8 类 `events.rs:271-288`）；归因映射中文文案（cold→冷缓存、model-switch→换模型等） |
| 26 | `cold-cache-warning` | `events.rs:546-554` | cacheEventsStore.setColdHint（`cacheEventHandlers.ts:48-58`） | N | 通知/徽标：TTL 到期 + 重发预估 token（run 启动时仅发一次，`events.rs:544-545` 注释——低噪声，可放心通知） |

### 2.7 安全审计域（1 个）

| # | 事件 | 位置 | 桌面消费 | 分类 | 手机端处理 |
|---|---|---|---|---|---|
| 27 | `security-audit` | `events.rs:559-577` | securityAuditStore（`securityAuditHandlers.ts`） | S + N | **高危操作审计卡片**：operation 中文名（delete→删除接管 / trash-restore→回收站恢复 / command-exec→命令执行等 6 类 `events.rs:63-83`）+ targets 路径列表 + impact 影响面（文件数/总大小）+ decision 处置（blocked/approved/denied/redirected 等 `events.rs:89-104`）；blocked 红条 + 通知 |

### 2.8 子代理域（3 个）

| # | 事件 | 位置 | 桌面消费 | 分类 | 手机端处理 |
|---|---|---|---|---|---|
| 28 | `subagent-started` | `events.rs:583-603` | onSubagentStarted / 全局兜底（`subagentHandlers.ts:29-44, 93-132`） | S | 嵌套 feed 条目：「协作子任务启动」（description + mode），渲染为可折叠的子时间线容器（对齐桌面 InlineAgentPanel 层级语义） |
| 29 | `subagent-event` | `events.rs:606-612` | 透传 onSubagentEvent（`subagentHandlers.ts:46-60`） | S（折叠） | 子代理内部 progress/message/tool 事件**默认折叠**（背压分级 `events.rs:870-872`：progress=Delta 可丢、message/tool=Soft）；展开子容器后按 kind 渲染迷你条目 |
| 30 | `subagent-ended` | `events.rs:614-626` | onSubagentEnded（`subagentHandlers.ts:62-74`） | S + N | 子容器收口：completed / failed / cancelled（前端映射 stopped，`subagentHandlers.ts:21-27`）+ summary；failed 时通知 |

### 2.9 任务域（7 个）

| # | 事件 | 位置 | 桌面消费 | 分类 | 手机端处理 |
|---|---|---|---|---|---|
| 31 | `task-started` | `events.rs:635-648` | 刷新信号（`taskEventHandlers.ts:264-271`） | S | **后台任务卡片**：command 摘要 + cwd + isDaemon 标记 |
| 32 | `task-output` | `events.rs:651-665` | 仅计数水位（`taskEventHandlers.ts:274-280`） | S（高频合并） | **任务输出流**：line/chunk 增量 append 到任务卡片 body（节流合并，见 §4.3） |
| 33 | `task-heartbeat` | `events.rs:668-675` | 仅计数水位（`taskEventHandlers.ts:282-289`） | I | 桌面仅计数；手机端**不渲染**（高频采样，无画面增益），仅统计「最后活动时间」供卡死判定 |
| 34 | `task-suspicious` | `events.rs:678-687` | 置标 + 刷新信号（`taskEventHandlers.ts:292-301`） | N | 任务卡置「疑似卡死（N 秒无输出）」警示 + 通知 |
| 35 | `task-completed` | `events.rs:690-695` | 刷新信号（`taskEventHandlers.ts:303-311`） | S + N | 任务卡收口 ✓（exit 0 + duration + lineCount）；后台时通知「任务已完成」 |
| 36 | `task-failed` | `events.rs:704-715` | 刷新信号（`taskEventHandlers.ts:314-321`） | S + N | 任务卡收口 ✗（exit N + **tail 最后 20 行**展示，`events.rs:712`）+ 通知 |
| 37 | `task-killed` | `events.rs:718-728` | 刷新信号（`taskEventHandlers.ts:323-331`） | S | 任务卡收口 ⏹（viaForce 强制终止标记 + diagnostics） |

### 2.10 定时器域（2 个）+ cron 域（1 个）

| # | 事件 | 位置 | 桌面消费 | 分类 | 手机端处理 |
|---|---|---|---|---|---|
| 38 | `timer-fired` | `events.rs:737-746` | 摘要 + 刷新信号（`taskEventHandlers.ts:340-356`） | N | **通知**：「定时器到期：<prompt>」（T-CF-12 唤醒摘要语义，`events.rs:735-736` 注释）；feed 内轻量条目（无 run 归属，按 timerId 分组展示） |
| 39 | `timer-cancelled` | `events.rs:749-758` | 摘要 + 刷新信号（`taskEventHandlers.ts:359-373`） | I | 桌面低价值摘要；手机端**忽略**（取消通知无画面增益，避免与 timer-fired 成对噪声） |
| 40 | `cron-fired` | `events.rs:768-781` | 摘要 + 刷新信号（`taskEventHandlers.ts:376-396`） | N | **通知**：「cron <id> 第 N 次触发：<prompt>」（`events.rs:761-765` 注释）；feed 内轻量条目 |

### 2.11 信封级遗留事件（1 个）

| # | 事件 | 位置 | 桌面消费 | 分类 | 手机端处理 |
|---|---|---|---|---|---|
| 41 | `error`（legacy 信封） | `eventParser.ts:70-71`（LegacyEventType） | surfaceStreamFailure + finish（`subagentHandlers.ts:193-203`） | N | **顶层错误横幅 + 通知**：message/error 字段展示；错误导致 run 失败时 feed 顶部常驻失败横幅 |

### 2.12 分类汇总与理由

| 分类 | 事件数 | 事件清单 | 理由 |
|---|---|---|---|
| 实时流展示型（S） | 23（主类）+ 5（与 N 双类） | agent-start/end、turn-start/end、message-delta/end、tool-start/update/end、context-compression-start/end、approval-requested/resolved、cache-stats-updated、security-audit、subagent-started/event/ended、task-started/output/completed/failed/killed | 均携带增量内容或状态迁移，是 feed 的主体画面；桌面端均真实消费（或部分空实现但事件内容有独立展示价值） |
| 通知型（N） | 8（主类）+ 5（双类） | runtime-error、runtime-intervention-required、cache-waste-alert、cold-cache-warning、task-suspicious、timer-fired、cron-fired、error（legacy）+ 双类：approval-requested、security-audit、subagent-ended、task-completed、task-failed | 单次/低频事件、时效敏感（审批）、或触发时刻用户大概率不在 run 页（后台任务/定时器）——通知价值远大于画面价值；前台态合并进 feed 后不重复打扰 |
| 忽略型（I） | 10 | message-start、tool-batch-start/end、tool-input-repaired、provider-diagnostic、runtime-steering、checkpoint-created/restored、task-heartbeat、timer-cancelled | 桌面显式空实现（`dispatch.ts` 各 handler 注释）+ 无独立画面增益；task-heartbeat 高频（采样 loop 发射，`events.rs:666-667`）防噪声；timer-cancelled 与 timer-fired 成对且后者已通知 |

> 说明 1：S 与 N 不互斥——approval-requested、security-audit、subagent-ended、task-completed、task-failed 5 个事件同时属于两类（前台渲染 + 后台通知）；分类按**主消费路径**取主类，上表按「主类计数 + 双类另计」统计。
> 说明 2：**通知触发点清单（§7.4，14 条）≠ 通知型分类**——触发点还包含 task-killed、subagent-ended 等终态事件（此类事件主类为 S，但终态到达时用户大概率不在看 feed，通知价值高），以 §7.4 清单为 D7 交接真源。

## 3. 实时事件流设计

### 3.0 手机端模块划分（消费面分层）

事件流域在手机端 App 内按「**消费面 → 合并面 → 存储面 → 渲染面**」四层切分，与桌面端 `EventRouter → dispatch → handler → store → 组件` 的链路同构但更薄：

```
┌─ 传输层（同步域 F1/D3 提供，本域只订阅）──────────────────────┐
│  WS 帧（AgentEventEnvelope 扁平 JSON，逐事件到达）             │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
┌─ 消费面（F3-consume）────────────────────────────────────────┐
│  resolveEventType（type/event/kind 别名抽取）                  │
│  → parseBridgeEvent 兼容归一（对齐 eventParser.ts 单一入口）    │
│  → 幂等去重（buildEventDedupeKey 同构实现）                    │
│  → 事件分类器（41 变体 → S/N/I 映射表，T1 护栏）               │
│  → runId/会话归属分组（对齐 messageBelongsToRun + 数据面隔离）  │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
┌─ 合并面（F3-merge，纯函数无 UI 依赖）─────────────────────────┐
│  StreamValueBatcher（48ms 文本/工具/任务输出合并窗口）          │
│  → tool-update 行缓冲累积（\n 追加 / \r 覆盖）                 │
│  → message-end 终态权威合并（mergeAssistantTextPiece）         │
│  → 有界环形（feed 500 条 / 行缓冲 200 行）                     │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
┌─ 存储面（F3-store）──────────────────────────────────────────┐
│  feedStore：不可变状态（run 分组树 + 条目数组 + 过滤条件）      │
│  单次 setState / reducer 提交（React 自动批处理）              │
│  后台模式：只写脏标记不触发渲染                                │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
┌─ 渲染面（F3-view）───────────────────────────────────────────┐
│  虚拟列表（FlashList）+ 条目类型渲染器（工具卡/消息/任务卡…）    │
│  三级 markdown（§5.2）+ 终端行视图（§4.2）                     │
└──────────────────────────────────────────────────────────────┘
```

分层边界（防桌面端重演的问题）：

- 消费面与合并面**纯函数化**，不依赖任何组件/Store——单元测试直接在 Node 侧跑（T1-T10 全部属于这两层）。
- 存储面只做「折叠 + 有界」，不做渲染派生（派生全部在渲染面 memo 化）。
- 渲染面不感知事件细节，只消费 feedStore 的条目模型（EntryType 联合）——新增条目类型不改渲染管线框架，只加渲染器。

### 3.1 展示形态：时间线 feed（主形态）+ 按 run 分组（次形态）

**主形态：时间线 feed**——单列纵向流，事件按到达顺序（引擎单通道顺序契约，`EventRouter.ts:100-104` 注释）排列，自动跟随底部（sticky bottom，用户上滚时暂停跟随）。

feed 条目类型（EntryType）：

| 条目 | 来源事件 | 渲染元素 |
|---|---|---|
| run-header | agent-start / agent-end / run-terminal | run 状态卡：状态点（运行中/完成/取消/失败）+ 开始/结束时间 + 会话名；run 卡可折叠（子条目收起） |
| turn-separator | turn-start / turn-end | 细分割线「第 N 轮 · M 次工具调用」 |
| message | message-delta / message-end | 助手气泡：正文 + 思考块（折叠样式）+ 缓存指标徽标（§3.3.4） |
| tool-card | tool-start / tool-update / tool-end / approval-* | 工具卡片：icon + 工具名 + 人话摘要 + 入参预览 + 流式输出体 + 结果状态（§3.3.2 / §4） |
| task-card | task-* | 后台任务卡片：命令 + 输出流 + 终态（§4 复用终端行渲染） |
| subagent-container | subagent-* | 子代理条目：可折叠容器，内含迷你 feed |
| audit-card | security-audit | 安全审计卡片：operation + targets + decision |
| progress-entry | context-compression-* | 轻量进度条目（单行） |
| error-entry | runtime-error / runtime-intervention-required / run-terminal(failed) | 错误条目：红色高亮 + 文案 + retryable 标记 |
| timer/cron-entry | timer-fired / cron-fired | 轻量单行条目（无 run 归属，按实体 id 分组） |
| metrics-badge | cache-stats-updated / cache-waste-alert / cold-cache-warning | run 卡上的徽标位（§3.3.4） |

**次形态：按 run 分组**——一个会话可能多 run 并发（主 agent run + 子代理 run + 定时器伪 run）。feed 内按信封 `runId` 分组：主 run 为主时间线，子 run（`subagent-*` 事件的 `subagentRunId`/信封 runId，`events.rs:583-603`）以嵌套容器形式内嵌；无 run 归属的数据面事件（task-*/timer-*/cron-fired，`dataPlaneRouter.ts:59-70` 注释「信封 runId/sequence 均不注入」）挂在「会话级」区段。

分组规则（对齐桌面双面隔离语义，`EventRouter.ts:85-88` + `dataPlaneRouter.ts:74-78`）：

1. 信封带 runId 且 = 当前查看 run → 主时间线；
2. 信封 runId = 子代理 run → 挂到对应 subagent-container；
3. 数据面类型（10 类，`dataPlaneRouter.ts:59-70`）→ 会话级区段；
4. runId 缺失 → 放行并归会话级（`eventUtils.ts:30-39` messageBelongsToRun 语义：null runId 放行）。

#### 3.1.1 feed 数据结构（存储面模型）

```ts
// F3 事件流域 feed store 状态（示意）
interface FeedState {
  sessionId: string;
  // run 分组树：主 run + 子代理容器 + 会话级区段
  groups: {
    kind: 'main-run' | 'subagent' | 'session-level';
    id: string;                       // runId / subagentId / 'session'
    header: RunHeader | null;         // agent-start/end 折叠出的状态卡
    entries: FeedEntry[];             // 有界环形（500 条）
  }[];
  activeRunId: string | null;         // 当前跟随的 run（过滤用）
  filters: { errorsOnly: boolean; runId: string | null };
  autoScroll: boolean;                // sticky bottom 跟随
  truncatedCount: number;             // 被环形淘汰的条目计数（顶部提示）
  network: 'live' | 'reconnecting' | 'offline';
}
type FeedEntry =
  | { kind: 'turn'; turnIndex: number; toolCallCount?: number }
  | { kind: 'message'; id: string; role: 'assistant'; text: string; thought: string; metricsBadge?: CacheBadgeData }
  | { kind: 'tool'; id: string; state: ToolCardState }
  | { kind: 'task'; id: string; state: TaskCardState }
  | { kind: 'subagent'; id: string; status: ... }
  | { kind: 'audit'; operation: ...; targets: string[]; decision: ... }
  | { kind: 'progress'; label: string; done: boolean }
  | { kind: 'error'; text: string; retryable?: boolean; source: 'runtime' | 'run-terminal' | 'intervention' }
  | { kind: 'timer-cron'; entityId: string; label: string };
```

reducer 动作（对齐桌面 handler 事件源，动作名 = 事件名）：

```
agent-start/agent-end/run-terminal → groups[runId].header 更新
turn-start/turn-end                 → 插入 turn 条目
message-delta/end                   → 合并到 groups[runId].entries 中 message 条目
tool-start/update/end               → 创建/合并 tool 条目（状态机驱动）
approval-requested/resolved         → tool 条目置 pending_approval / 收口
task-*                              → 会话级区段 task 条目
subagent-*                          → 子代理容器（不存在则创建）
security-audit                      → 会话级 audit 条目
cache-*                             → 仅更新 run-header 徽标数据
runtime-error / runtime-steering    → error 条目（steering 归忽略型不产生动作）
context-compression-*               → progress 条目
timer-fired / cron-fired            → timer-cron 条目
```

**防重放语义**：所有条目以 `(eventType, entityId, sequence)` 或事件自带 id（messageId/toolCallId/taskId）为键 upsert——与桌面 `consumedEvents` 集合（`EventRouter.ts:46`）语义一致，保证断线重连后的快照重建 + 增量续接不产生重复条目（T18 覆盖）。

### 3.2 传输链路（与同步域衔接：在线 WS 直推）

**衔接模型**：桌面端事件到达手机的通道由同步域（F1/D3/D6）统一建立——手机端与桌面 daemon 建立**在线 WebSocket 直连**（或经中转服务，由 D1/D3 定夺），daemon 侧事件桥（`buffer.rs` 冲刷 + 广播）对每个已连接手机端 **fanout 扁平 JSON 事件帧**（`AgentEventEnvelope` 序列化形态：顶层 `{type, runId, sequence, schemaVersion, sessionId, ...事件字段}`，`events.rs:907-908` 注释）。

手机端事件流域在本域内不新建传输通道，只定义**消费契约**：

1. **帧格式零改写**：直接复用 `AgentEventEnvelope` 扁平 JSON（`events.rs:941-964` 序列化实现）；手机端 TS 类型直接复用 `packages/shared-types/src/generated/engine/`（生成产物，`events.rs:5-8` 注释，脚本 `scripts/generate-engine-bindings.mjs` 生成），**保证与桌面端同一份契约事实源**。
2. **顺序保证**：与桌面端同语义——单通道顺序（`EventRouter.ts:100-104` 注释「前端不校验 sequence，不做乱序缓冲」）；手机端同样信任 WS 单通道顺序，不做乱序重组。
3. **去重**：复用桌面端消费侧幂等去重（`EventRouter.ts:120-131` + `buildEventDedupeKey` `EventRouter.ts:166-189`：`type:messageId:sequence` 键）；手机端同构实现一份（简单 Map，run 收口后清理）。
4. **背压语义继承**：`event_backpressure`（`events.rs:867-893`：Delta 可丢 / Soft 尽力 / Critical 必达）在手机端消费面同样适用——**Delta 事件（message-delta、task-output、subagent-event progress、task-heartbeat）在手机端网络拥塞时可丢弃**，以 message-end/task 终态兜底；Critical 事件（终态/审批/审计）必须到达。
5. **断线重连**：WS 断开 → 手机端事件流暂停 + 显示「连接中断」横幅；重连后**不做事件重放**，由同步域拉取 run 会话快照（F1/D6 负责），本域以快照重建 feed 骨架（run 状态卡 + 已落库消息/工具终态），再继续增量。快照重建时按「增量 vs 终态」合并（复用 `mergeAssistantTextPiece` 语义，`eventUtils.ts:49-63`）。

#### 3.2.1 连接状态机（事件流域视图）

```
disconnected ──同步域握手成功──▶ live ──帧到达──▶ live（渲染）
    ▲                              │
    │  WS 断开/超时                │ 心跳超时（前台 30s / 后台 120s）
    │                              ▼
    └───────────▶ reconnecting ──▶ offline（≥2 次重连失败）
                       │
                       └── 同步域恢复 → 快照重建 → live
```

- `live`：消费面全速（前台）/ 降速（后台，§7.2）。
- `reconnecting`：事件**缓冲到内存暂存区**（上限 500 条，超限丢 Delta 事件——继承 `event_backpressure` 分级，`events.rs:867-893`）；重连成功先 flush 暂存区（按 sequence 排序保证顺序，`AgentEventEnvelope.sequence`，`events.rs:929-931`），再快照对账去重。
- `offline`：停消费；由 D7 推送域接管关键事件通知；用户手动/网络恢复后回 live。

#### 3.2.2 订阅粒度

- **会话级订阅**：手机端与 daemon 建立的是「会话订阅」（一个会话一条 WS 订阅流），事件流域在其中**按 runId 过滤**出当前 feed 需要的事件（对齐 `messageBelongsToRun` 语义，`eventUtils.ts:30-39`）。
- **应用级监听**：即使没有打开事件流页，应用级也保持一条**轻量订阅**（只消费通知触发点事件，§6.4）——与 feed 消费面解耦，防止「feed 页关闭导致通知丢失」。
- 两条订阅复用同一 WS 连接（不同 filter），不建第二通道（省电，§6.3）。

#### 3.2.3 关键路径消费伪代码（合并面）

三条关键路径的消费逻辑（全部纯函数，供 T1-T10 直接单测）：

```
// 路径 A：消息流（message-delta → message-end）
onMessageDelta(entry, delta) → 批合并器.push(`msg:${messageId}`, delta.text)  // 48ms 窗口
onMessageEnd(entry, msg) → {
  text = mergeAssistantTextPiece(entry.text, msg 全文 text)   // 终态权威
  thought = merge(entry.thought, msg.thought)
  flushNow()                                                   // 立即替换渲染
  metrics = computeCacheMetricsFromUsage(msg.metadata)         // 徽标（None 不写）
}

// 路径 B：工具流（tool-start → tool-update* → tool-end）
onToolStart(toolCallId, toolName, args) → 创建 tool 条目（state=created，折叠）
onToolUpdate(toolCallId, update) → {
  if (update.metadata?.kind === 'tool-args-delta') 更新入参预览位（500 字符截断）
  else if (update.text) 行缓冲.append(update.text)（100ms 窗口合并，state=streaming）
}
onToolEnd(toolCallId, result) → {
  flushNow()
  if (行缓冲与 result.output 不一致) 行缓冲.replaceAll(result.output)  // 终值权威
  state = result.isError ? 'error' : 'success'（错误计数 +1，通知判定）
}

// 路径 C：run 收口（run-terminal / agent-end）
onRunTerminal(terminal, error) → {
  runHeader.state = terminal（completed/cancelled/failed）
  if (failed) { 错误条目追加；通知触发点（§7.4） }
  feed 释放本 run 的幂等去重集合（内存回收）
}
```

### 3.3 事件渲染

#### 3.3.1 消息文本（message-delta / message-end）

- 桌面语义复用：delta 增量 append（`messageHandlers.ts:89-107`），thought 单独累积（`messageHandlers.ts:84-88`），message-end 终态全文替换增量（`mergeAssistantTextPiece`，`eventUtils.ts:49-63`）。
- 手机端差异：delta 频率高，**按渲染合并窗口 flush**（§3.4.1），不逐 token 重绘。
- 思考块（thought）默认折叠成「思考中…」一行，点击展开（对齐桌面折叠语义）；`redacted` 块仅显示占位（`message.rs:108-114`）。
- 正文渲染策略（轻量 markdown）见 §5。

#### 3.3.2 工具调用卡片（tool-start / tool-update / tool-end）

卡片结构（对齐桌面 `ChatToolCallBlock.tsx` 的 CompactToolRow 视觉层级，但手机端更紧凑）：

```
[icon] 工具名                        状态点（运行中…/✓/✗/⏳待确认）
摘要行人话（toolHumanLabel 语义）
[展开] 入参 JSON 预览（折叠，max 500 字符，`partialToolArgs.ts:9-10`）
[展开] 流式输出体（shell 命令时，§4）
──────────────
结果行：✓ 结果预览（toolResultPreview）/ ✗ 错误文案 + 耗时
```

- 人话摘要：直接复用 `toolCardPresenter.ts` 的 `toolHumanLabel` / `toolCommandPreview` / `extractToolCommand` 纯函数逻辑（**移植为共享包**，见 §6.3 方案）。
- 状态机：`created(tool-start) → streaming(tool-update*) → finalized(tool-end)`；`pending_approval` 态插在 created 之后（`approval-requested` 到达时置位，`approvalHandlers.ts:99-114` 桌面路径）。
- 卡片默认折叠（对齐 `isToolRowDefaultOpen=false`，`toolCardPresenter.ts:306-314`「防流式高度抖动」），流式期间自动展开输出体，结束后记忆用户展开状态。
- 并行组：桌面按 turnId+startedAt ≤200ms 聚类（`ChatToolCallBlock.tsx:179-199`），手机端对齐（Parallel(N) 分组头）。

#### 3.3.3 错误高亮（runtime-error / run-terminal failed / task-failed / tool-end isError）

- 统一错误视觉：红色左边条 + 错误 icon；错误文案单行预览 + 展开详情。
- `run-terminal` failed（`events.rs:511-519`）：run-header 卡整体变红 + error 字段展开（对齐 `lifecycleHandlers.ts:84-98` 的 surface 逻辑——`run-cancelled` 不做失败横幅，仅状态点变灰，手机端照抄）。
- 错误计数徽标：feed 顶部过滤栏显示「错误 (N)」，一键过滤只看错误（§5.1）。

#### 3.3.4 缓存指标徽标（cache-stats-updated 等）

- 挂在 run-header 卡右侧的徽标位，数据来自 `RunCacheStats`（`events.rs:238-266`）：
  - 命中率 `hitRatio`（None 隐藏，`events.rs:255-256` 注释「前端隐藏而非显示 0%」）；
  - 总 token `totalTokens`；
  - 写占比 `writeRatio`（None 隐藏）；
  - `cache-waste-alert` 时徽标变红 + 金额（`missedCostUsd`）+ 归因 tooltip（8 类归因中文映射，`events.rs:271-288`）。
- 点击徽标 → 弹出缓存明细面板（本地计算，无需新事件）：sampleCount、missedTokens、cacheMissTokens、warmUntilMs（冷缓存倒计时，`events.rs:264-265`）。

### 3.4 性能（手机端渲染能力有限）

#### 3.4.1 高频事件节流与合并

复用桌面端已验证的批合并器模式（`streamTextBatcher.ts`）：

| 层 | 机制 | 参数（对齐桌面先例） |
|---|---|---|
| 文本 delta 合并 | 同 messageId 全文覆盖式合并（StreamTextBatcher 语义，`streamTextBatcher.ts:258-314`） | intervalMs=48（桌面默认 `streamTextBatcher.ts:64`）；maxBufferedChars=8000（`streamTextBatcher.ts:78`） |
| 工具输出合并 | 同 toolCallId 行级累积合并：update.text append、update.json 最新覆盖 | 合并窗口 100ms（tool-update 帧率低于 delta，窗口放宽） |
| 任务输出合并 | 同 taskId 行缓冲 append（line/chunk，`events.rs:651-665`） | 与工具输出同窗口 100ms |
| 终态强制 flush | tool-end / message-end / run-terminal / task-* 终态到达时 flushNow（对齐 `isImmediateToolStatus` 语义 `streamTextBatcher.ts:335-339`） | 保证终态不延迟一拍 |
| 丢弃 | task-heartbeat 直接丢弃不渲染；message-delta 超限丢旧帧（对齐 `buffer.rs` Soft 水位语义：手机端本地缓冲 Soft=64 / Critical=256，`buffer.rs:200-206`） | 内存有界 |

#### 3.4.2 虚拟列表

- 主 feed 用虚拟化长列表（FlashList 类）：窗口化渲染，只渲染视口附近条目。
- **条目上限**：feed 内存上限 500 条（有界环形，超出淘汰最早条目并在顶部显示「已收起 N 条早期事件」，点击展开历史页）；单条消息正文渲染上限（如 20 万字符，超出显示「内容过长，请回桌面端查看」）。
- 消息正文/工具输出体渲染截断：折叠态只渲染前 4 行 + 行数标记（对齐桌面 16 行/1600 字符预览上限的本地 helper——【裁决修正】AU2 F-5：`toolCardPresenter.ts` 导出面无 `truncateToolOutput`，实际为同文件本地 helper `ln(output, maxLines=16, maxChars=1600)`，移植时改用现有导出 `toolResultPreview` 或自带同语义函数），展开态全量（仍受条目上限约束）。

#### 3.4.3 渲染卸载与合并写入

- 事件到达 → 纯函数式折叠进 feed store（不可变更新，单次 `useReducer`/zustand set），React 自动批处理；不做逐事件 setState。
- 后台/页面不可见时（§7.2）：**只消费事件进 store，不触发组件渲染**（store 更新节流为 1s 一次的「脏标记」），唤醒后一次补齐。
- 文本渲染不做 streaming token 高亮（桌面端 `streamingCodeHighlighter` + worker 是桌面专属重负载，`render-worker.ts`）；手机端流式期间纯文本，终态后再轻量着色（§6.2 的 L3 级）。

## 4. 终端输出（S1 流式协议 ToolUpdate 的手机端呈现）

### 4.0 终端视图组件规格（TerminalLineBuffer）

终端流卡片与任务卡片共用同一个行缓冲渲染组件，规格如下：

```
class TerminalLineBuffer {
  lines: string[];              // 有界环形（默认 200 行）
  cursorRow: number;            // 当前 \r 覆盖目标行（shell 进度条语义）
  maxLines: number;             // 200（可配）
  maxLineChars: number;         // 5000（单行截断）
  append(text: string): void;   // 按 \n 切行：普通行 push，\r 结尾段覆盖 cursorRow
  replaceAll(terminal: string): void;  // tool-end 终值权威重建
  search(query: string): number[];     // 命中行号数组
  tail(n: number): string[];    // 复制/分享尾部
  truncated: boolean;           // 是否发生过环形淘汰
}
```

组件行为约定：

- `\r` 覆盖语义只对「单行进度」生效（`\r` 后无 `\n` 的段覆盖当前行）；包含多段 `\r` 时取最后一段（对齐 shell 常见进度条输出）。
- 空行折叠：连续空行压缩为 1 行（终端日志常见空行风暴，防行缓冲被空行淹没）。
- ANSI 转义码（`\x1b[` 序列）**剥离后渲染**（手机端不做真终端，色彩由 UI 主题统一表达；剥离逻辑手写 30 行内，只处理 SGR/光标/清屏三类）。
- 组件以 `slice 视口` 方式渲染（配合外层虚拟列表），不整体重绘。

### 4.1 数据形态（事实源）

S1 流式协议（TOOLS-01 §3.1.5，`crates/session-loop/src/tool_exec.rs:1424-1445`）：

```
ToolProgress::Text { text }   → ToolProgressUpdate { text, metadata: { kind: "tool-progress" } }
ToolProgress::Custom { ... }  → ToolProgressUpdate { json, metadata: { kind: subkind } }
ToolProgress::Content { .. }  → 不发射（None）
```

- 事件载体：`tool-update`（`events.rs:379-386`），字段 `sessionId/batchId/toolCallId/update/timestamp`；TS 类型 `ToolProgressUpdate { text?; json?; metadata? }`（`packages/shared-types/src/generated/engine/types.ts:143-147`）。
- 时序：恒位于 tool-start 与 tool-end 之间（`tool_events.rs:1-9`）；**ToolUpdate 是展示面事件，不进消息历史，终值由 ToolEnd 承载**（`executing_tools.rs:270-279`）——手机端必须按「流式增量 + 终值补齐」渲染，不能把增量当终态。
- shell_command 的输出即经此通道流式到达（与桌面端同一帧，手机端直接消费，无需新协议）。

### 4.2 呈现：终端流卡片

- **终端流卡片**是 tool-card 的特化：工具名为 shell/powershell/bash/exec 类（`isShellToolName` 语义，`toolFeedback.ts`）时，工具卡展开体切换为**终端行缓冲视图**（§4.0 组件）。
- 视觉：等宽字体、深色底（对齐桌面 xterm 深色视觉但不引入 xterm），行前缀显示行号（可选，长输出时可关）。
- 增量渲染：`update.text` 按行切分 append 到行缓冲（兼容 `\r` 覆盖行的 shell 进度条语义——识别行尾 `\r` 时**替换当前行**而非追加）；`metadata.kind='tool-progress'` 的普通进度文本同路径渲染。
- `tool-args-delta`（`metadata.kind='tool-args-delta'`，`partialToolArgs.ts:52-62`）在工具卡入参预览位增量更新（参数 JSON 预览，max 500 字符）。
- 终值补齐：tool-end 到达时（`result.output`，`events.rs:388-394`），若流式行缓冲与终值不一致（丢帧/修订），**以终值为准**重建卡片输出体（对齐 `mergeAssistantTextPiece`「终态权威」语义，`eventUtils.ts:49-63`）；错误时（`isError`）显示 `error_message`（`tool_exec.rs:325-340` 失败形态 text=错误文案 + json={code}）。
- 任务输出（task-output）复用同一行缓冲组件（任务卡片 body），共享行渲染器。
- 与桌面端差异清单（手机端不做的）：
  - 不做真 PTY / 交互输入（`TerminalCard.xterm.tsx` 的 `ptyWrite` 等桌面专属能力）；
  - 不做 WebGL 加速渲染（`TerminalCard.xterm.tsx:20` WebglAddon——手机端行缓冲是轻量 Text 渲染，无需 GPU）；
  - 不做 24 位真彩 ANSI 渲染（统一主题色）。
  - 桌面端 `terminalShellApi.ts`（系统 shell 直调）与 agent 的 `shell_command` 是两条线——手机端只展示 `shell_command` 经 tool-update 的流，不涉及系统 shell API。

### 4.3 滚动 / 搜索 / 复制

| 能力 | 设计 |
|---|---|
| 自动滚动 | 默认跟随底部（sticky bottom）；用户上滚后暂停跟随，底部浮出「回到底部」按钮 |
| 行缓冲上限 | 内存行缓冲默认 200 行（与桌面 16 行预览 helper 语义不同——手机端给更多但仍有界）；超出后淘汰最早行并显示「已截断 N 行」标记 + 「查看全部」按钮（从 tool-end 终值/task-failed tail 或同步域全量接口拉取） |
| 单行上限 | 单行 5000 字符截断（超长单行 JSON 日志），尾部省略号 + 点击展开该行 |
| 搜索 | 客户端行内搜索（行缓冲 200 行内线性匹配，高亮 + 命中计数 + 上下跳转）；行缓冲超限时降级为「搜索当前已缓冲 + 提示结果可能不完整」 |
| 复制 | 长按选择复制（原生文本选择）；「复制全部」按钮（≤200 行时直接复制缓冲，超限复制尾部 200 行 + 截断提示）；分享（系统分享面板，文本方式） |

### 4.4 大输出截断（与桌面端对齐）

| 层 | 截断策略 | 对齐依据 |
|---|---|---|
| 折叠预览 | 4 行预览 + 「共 N 行」 | 桌面 16 行/1600 字符预览 helper（`toolCardPresenter.ts` 本地 `ln`，【裁决修正】AU2 F-5）的缩水版 |
| 流式行缓冲 | 200 行内存有界（环形） | 与桌面 feed 内存有界原则一致（`buffer.rs` 水位思想） |
| 渲染层 | 单条消息正文 20 万字符渲染上限 | 防虚拟列表单条目巨高 |
| 全量获取 | 终态后可由同步域提供全量输出（tool-end output / task 全量日志拉取），手机端按需分页 | 桌面端桌面本地全量 vs 手机按需，语义对齐 |

### 4.5 桌面端 vs 手机端终端能力对照（边界确认）

| 能力 | 桌面端 | 手机端 | 说明 |
|---|---|---|---|
| 交互式 PTY（stdin 输入） | ✓ xterm + ptyWrite（`TerminalCard.xterm.tsx`） | ✗ | 手机端只读；交互归后续版本评估 |
| agent shell_command 流式输出 | 事件已到达（tool-update 空实现，`toolHandlers.ts:25-30`，UI 未消费） | ✓ **终端流卡片**（本域 P2 落地） | 手机端领先桌面端消费此事件 |
| ANSI 真彩渲染 | xterm 原生 | ✗ 剥离转义 + 主题色 | 手写 30 行剥离器 |
| WebGL 加速 | ✓ WebglAddon（`TerminalCard.xterm.tsx:20`） | ✗ | 行缓冲轻量 Text 渲染即可 |
| 输出行缓冲 | 无上限（终端本地） | 200 行有界 + 按需全量 | §4.4 |
| 搜索 | xterm 原生搜索（桌面 UI 壳） | 行内搜索 + 降级策略 | §4.3 |

## 5. 交互设计

### 5.1 过滤（feed 顶栏过滤条）

feed 顶部固定过滤条（随 feed 滚动吸顶），三个维度可组合：

| 过滤项 | 行为 | 数据依据 |
|---|---|---|
| 只看错误 | 只显示 error-entry + 错误态工具卡/任务卡 + run-header 失败态 | 条目携带 `errorLevel` 派生标记（runtime-error / run-terminal failed / tool-end isError / task-failed / security-audit blocked） |
| 只看当前 run | 隐藏会话级区段与其它 run 分组（子代理容器保留——属于当前 run 的派生活动） | 信封 runId 归属（§3.1 分组规则）；数据面事件（task-*/timer/cron）是否随 run 过滤：**默认跟随**（ownerRunId 匹配当前 run 的任务保留，`events.rs:646`），其余收进「全部事件」 |
| 只看工具 | 只显示 tool-card + task-card + audit-card（执行面，隐藏正文与分隔线） | 条目类型过滤 |
| 会话选择器 | 顶部下拉切换会话（F1 同步域会话列表），切换后 feed 整体重建 | 会话列表来自同步域；切换动作不打断 WS 订阅（订阅是会话级，切换仅换 filter + 清 feed 重建） |

过滤状态存于 feedStore（`filters` 字段），切换过滤**不丢失已缓冲条目**（仅渲染层过滤，内存条目保留——用户切回全量视图时无需重新消费）。

### 5.2 点击事件跳转（事件 → 详情/帮助）

| 条目 | 点击行为 |
|---|---|
| tool-card | 进入**工具详情页**：完整入参 JSON（格式化 + 语法着色）、输出全文（行缓冲全量，超限时按需分页拉取）、执行耗时、toolCallId/batchId、时间线位置（同批其它工具） |
| error-entry / 错误态工具卡 | 进入**错误详情页**：错误文案全文 + 来源（runtime/run-terminal/tool）+ retryable 标记 + 「常见原因」帮助卡片（本地 FAQ 规则表，按错误关键字匹配：权限/网络/超时/工具不存在四类）+ 动作按钮「回桌面处理」（深链桌面端 run） |
| audit-card | 展开 targets 路径列表 + impact 明细（文件数/大小/目录数，`events.rs:563-571`）+ decision 解释 |
| approval 态工具卡 | 跳转 **F2 审批中心**（深链，事件 id 传参）——本域不承载审批动作 |
| subagent-container | 展开子时间线；子代理失败时头部显示「查看详情」入口（复用错误详情页） |
| 缓存徽标 | 弹出缓存明细面板（§3.3.4），waste-alert 时附归因解释文案 |
| timer/cron 条目 | 展开 prompt 全文 + 触发时间（无详情页，轻量展开） |
| task-card | 展开输出体 + 终态详情（exit code/duration/line count）；task-failed 时尾部 20 行优先展示（`events.rs:712`） |

深链规范（对齐 D1 总体架构深链约定）：`conex://mobile/event-stream/{sessionId}?runId={runId}&entry={entryId}`——entryId 由事件键（§3.1.1）派生，详情页可定位到 feed 对应条目。

### 5.3 交互防误触与可达性

- 工具卡/任务卡流式期间可展开但**禁止导航**（防滚动误触打断查看输出）；终态后可点击。
- 长按行为：工具卡/终端输出 → 复制；消息气泡 → 复制/分享。
- 可达性：所有条目有 a11y label（类型 + 摘要文本）；错误条目读屏播报；状态变化（run 收口/错误）轻触反馈（震动可选，默认关闭省电）。

## 6. 与桌面端渲染的对齐（markdown 轻量渲染策略）

### 6.1 桌面端现状（不移植的部分）

- 桌面端正文渲染：`api/markdown-render/`（IncrementalMarkdownParser 增量解析 + markdownPlugins + markdownSanitizer）+ 流式代码高亮（`api/streamingCodeHighlighter.ts`，worker `workers/render-worker.ts` 承载）+ 表格/图表插件（markdownTable）。
- **这些是桌面端重负载资产**（增量解析器 + Web Worker + 高亮 tokenizer），手机端直接引入会显著膨胀包体并吃掉中端手机 CPU。

### 6.2 手机端策略：三级渲染管线（不引入重型依赖）

**不新增 markdown 库**（remark/marked/micromark/prism/highlight.js 等一律不进手机端包），全部手写轻量实现，目标包体增量 < 80KB。

| 级 | 阶段 | 渲染内容 | 实现 |
|---|---|---|---|
| L1 | 流式进行中（message-delta 持续到达） | **纯文本 + 极简 inline** | 手写 mini-inline 规则（≤120 行）：`**bold**`、`*italic*`、`` `code` ``、`[link](url)`、行内图片标记占位；**代码块整块单色等宽**（不做行内 token 高亮，防抖动）；增量合并窗口 48ms flush |
| L2 | 终态（message-end 到达，全文替换增量） | **块级 markdown** | 手写块级解析（≤200 行）：标题/列表/围栏代码块/表格（对齐 `markdownTable.ts` 简单表语义）/引用/分隔线；行内规则沿用 L1；代码块做**极简关键字着色**（见 L3） |
| L3 | 代码块着色 | 轻量 token 化 | 按语言分派手写微型 tokenizer（≤150 行）：ts/js/bash/json 4 种常用语言 + 兜底纯文本；**只识别字符串/注释/关键字三类 token**（5-8 色），不做完整语法树；流式期间不运行（L1 阶段单色），只在 L2 终态运行一次 |

安全性：渲染输出为**受控组件树**（无 `dangerouslySetInnerHTML`、无 HTML 注入面）；链接点击白名单（http/https + 站内深链）；图片仅渲染 markdown 图片标记占位（手机端不自动加载桌面工作区图片，避免数据消耗——归 F4 按需加载）。

渲染正确性保障（对齐桌面端测试思路）：

- 快照测试：L2 解析器对桌面 `IncrementalMarkdownParser` 的行为对齐用例（标题/列表嵌套/表格/围栏代码/转义）逐条快照比对——**语义对齐而非输出逐字节一致**（手机端布局与桌面不同，但块级结构必须一致）。
- 流式边界：L1→L2 切换发生在 message-end 到达那一帧（增量全文替换），切换瞬间不闪动（同一 messageId 条目原地替换，靠渲染 memo 保证）。

### 6.3 共享纯函数移植

手机端复用桌面端已验证的纯函数（**抽到 packages/ 共享包**，与 D1 总体架构的共享包策略一致）：

- `toolCardPresenter.ts`：`extractToolCommand`、`toolHumanLabel`、`toolCommandPreview`、`toolResultPreview`、`toolDiffLineStats`（+N/−N 角标）、`humanizeShellCommand`、`isInterruptedTool` 等——纯函数无 DOM 依赖，直接移植。【裁决修正】AU2 F-5：`truncateToolOutput` 不在导出面（同文件本地 helper `ln`，16 行/1600 字符语义），如需截断预览移植本地 helper 或改引 `toolResultPreview`。
- `eventUtils.ts`：`blockText`、`mergeAssistantTextPiece`、`messageBelongsToRun`。
- `streamTextBatcher.ts`：批合并器整体复用。
- `partialToolArgs.ts`：`parseToolArgsDeltaEvent`、`truncateToolArgsPreview`。
- 移植原则：**只移纯函数，不移组件/Store/Worker**；共享包内以 `*.pure.ts` 命名防误引 DOM。

## 7. 体验要求

### 7.1 实时性（首帧快）

| 指标 | 预算 |
|---|---|
| feed 页骨架可见 | < 500ms（进入 run 页立即显示骨架 + 本地已缓存快照） |
| 首个真实事件条目渲染 | < 1s（WS 连接复用同步域已建立的连接，不重复握手） |
| delta 到达 → 屏幕可见 | ≤ 100ms（48ms 合并窗口 + 一次渲染提交） |
| 终态（message-end/run-terminal）渲染 | 立即 flushNow，不经过合并窗口 |

启动路径：进入事件流页 → 同步域会话快照（本地缓存优先）→ 快照重建 feed 骨架（run 卡 + 终态条目）→ WS 增量接管。**先渲染骨架再等增量**，不阻塞在网络上。

### 7.2 后台监听（app 切后台时事件流如何处理）

| 场景 | 行为 |
|---|---|
| app 前台但不在事件流页 | 事件流 store 继续消费（只记入内存缓冲，上限 500 条），页面级组件卸载；run-header 状态 + 通知触发点在应用级 store 维护 |
| app 退后台（< 30s） | WS 保持连接，事件**只消费不渲染**（store 脏标记 1s 合并）；恢复前台时一次补齐渲染 |
| app 退后台（≥ 30s） | 进入省电模式：WS 心跳降频、事件流暂停消费；**关键事件通知由 D7 推送域接管**（§7.4 通知触发点清单），用户点通知回前台时经同步域快照补齐 |
| 系统杀掉 app | WS 断开；D7 推送域按订阅规则推送关键事件通知（审批/任务终态/定时器），点击通知唤起 app → 快照重建 |

关键设计：**通知与 feed 消费解耦**——事件流消费面只负责「app 可见时的画面」，通知由应用级监听面（D7）独立订阅，两套订阅不互相阻塞。

### 7.3 省电

- 渲染节能：后台只消费不渲染（§7.2）；前台流式渲染窗口 48ms 合并（比桌面端 48ms 更少重绘次数）。
- 网络节能：WS 帧复用同步域连接（不建第二通道）；`task-heartbeat` 类高频帧在手机端网络层直接过滤（不进入 JS 层解析）。
- 生命周期节能：事件流页退场即退订消费面（对齐 `cleanupStreamState` 退订语义，`streamState.ts:24-30`），不留后台常驻 setInterval；store 脏标记合并写入。
- 磁盘节能：手机端**不落盘事件流**（事件流是瞬态视图，历史由同步域会话快照承担）；本地仅内存缓冲，杜绝 SQLite/WAL 写放大。

### 7.4 通知触发点清单（D7 衔接面）

app 不在前台/不在 run 页时触发本地通知（`app 在前台时这些事件并入 feed 高亮，不弹通知`）：

| 事件 | 通知文案（摘要） | 优先级 |
|---|---|---|
| approval-requested | 「需要确认：<工具名> <人话摘要>」→ 深链 F2 审批中心 | 高 |
| run-terminal（failed） | 「任务失败：<error 前 120 字符>」 | 高 |
| runtime-error | 「运行错误：<error 前 120 字符>」（retryable 附「可重试」） | 中 |
| runtime-intervention-required | 「需要人工介入：<reason>」 | 高 |
| task-completed | 「任务 <id> 已完成（exit 0，N 行）」 | 低 |
| task-failed | 「任务 <id> 异常退出（exit N），尾部 20 行见详情」 | 中 |
| task-killed | 「任务 <id> 已被终止」 | 中 |
| task-suspicious | 「任务 <id> 疑似卡死（N 秒无输出）」 | 中 |
| subagent-ended（failed） | 「协作子任务失败：<summary>」 | 中 |
| timer-fired | 「定时器到期：<prompt>」 | 低 |
| cron-fired | 「cron <id> 第 N 次触发：<prompt>」 | 低 |
| cache-waste-alert | 「缓存浪费：约 $X（<归因中文>）」 | 低 |
| cold-cache-warning | 「冷缓存预警：重发约 N tokens」 | 低 |
| security-audit（blocked/redirected 高危） | 「高危操作已拦截/已接管删除：<operation> N 个文件」 | 高 |

去重：同实体同类型通知 5 分钟合并一次（对齐 `taskEventHandlers.ts:202-212` 节流思想，`DATA_PLANE_REFRESH_THROTTLE_MS=1000` 的手机端放大版）。

## 8. 测试点（事件流全链路验证）

### 8.1 单测（纯函数层，vitest 手机端工程）

| 编号 | 用例 | 覆盖点 |
|---|---|---|
| T1 | 事件分类器：41 变体 → S/N/I 映射表全量断言 | 分类表与 `ALL_TYPE_NAMES`（`events.rs:810-852`）一一对应；新增事件时测试强制补分类（对齐 `registry_drift.rs` 护栏思想） |
| T2 | 消费侧幂等去重：同键重复事件只消费一次 | `buildEventDedupeKey` 移植逻辑（type:messageId:sequence 三形态，`EventRouter.ts:166-189`） |
| T3 | message-delta 增量 + message-end 终态合并：丢帧场景（delta 丢尾/丢头/修订）渲染结果 = 终稿 | `mergeAssistantTextPiece` 五分支（`eventUtils.ts:49-63`） |
| T4 | tool-update 流式行缓冲：`\n` 追加 / `\r` 行覆盖 / 混合流 | S1 增量语义（`tool_exec.rs:1424-1445`） |
| T5 | tool-update → tool-end 终值补齐：流式与终值不一致时以终值为准 | 展示面事件语义（`executing_tools.rs:270-279`） |
| T6 | 批合并器：48ms 窗口合并、同 key 覆盖、终态 flushNow、maxBufferedChars 强制 flush | `streamTextBatcher.ts` 全行为对齐 |
| T7 | 行缓冲截断：200 行环形淘汰、单行 5000 字符、折叠预览 4 行 | §4.4 截断表 |
| T8 | 轻量 markdown 渲染器：L1 inline 规则、L2 块级、L3 四语言 tokenizer 快照测试 | 与桌面渲染语义对齐（标题/列表/表格/围栏代码） |
| T9 | tool-args-delta 解析：生产形态 + 别名形态 | `partialToolArgs.ts:52-110` |
| T10 | 缓存徽标派生：hitRatio/writeRatio None 隐藏、sample_count=0 隐藏 | `RunCacheStats` 语义（`events.rs:238-266`） |

### 8.2 组件测试

| 编号 | 用例 |
|---|---|
| T11 | 工具卡片状态机：created → streaming → finalized；pending_approval 插入；parallel 分组（≤200ms 聚类） |
| T12 | 错误高亮：runtime-error / run-terminal failed / tool-end isError / task-failed 四类错误视觉一致 |
| T13 | run-header 卡：agent-start 建立、agent-end/run-terminal 收口、失败变红、run-cancelled 不弹失败横幅 |
| T14 | 虚拟列表：500 条上限环形淘汰、滚动回收、sticky bottom 跟随/暂停 |
| T15 | 过滤交互：只看错误 / 只看当前 run / 只看工具 / 会话选择切换后 feed 重建 |
| T23 | 详情页跳转：工具详情（入参/输出/耗时）、错误详情（FAQ 匹配 + 深链）、审计明细、F2 审批深链 |
| T24 | 终端交互：自动滚动跟随/暂停/回底部、行内搜索高亮与跳转、复制/分享 |

### 8.3 集成与端到端（E2E）

| 编号 | 用例 | 方式 |
|---|---|---|
| T16 | 全链路：daemon 发射 41 类事件（测试夹具仿 `eventParser.test.ts` 模式）→ WS 帧 → 手机消费面 → feed 渲染断言 | 模拟 daemon（WS 测试服务器）+ 真机/模拟器 |
| T17 | 洪峰压测：20 万 message-delta + 终态（复用 `buffer.rs` stress 思路，`buffer.rs:369-399`）→ 断言 message-end/run-terminal 必达、UI 无卡死、内存有界 | 压测脚本 + 内存快照 |
| T18 | 断线重连：WS 断开 → 快照重建 → 增量续接，无重复条目（幂等键生效）、无缺失终态 | 模拟断网/服务端主动断开 |
| T19 | 后台场景：退后台消费不渲染 → 回前台一次补齐；≥30s 省电模式停消费 → 通知触发 → 点通知回前台快照补齐 | 系统级生命周期测试 |
| T20 | 首帧性能：进入 run 页 <500ms 骨架、<1s 首条目、delta 可见延迟 ≤100ms | 性能 profile + 真机采样 |
| T21 | 截断边界：>200 行输出、>5000 字符单行、>20 万字符消息正文 三档边界 | 构造夹具 |
| T22 | 双端对照：同一 run 桌面端与手机端事件序列/终态一致性（抽样比对） | 双端同跑对照脚本 |

### 8.4 回归护栏

- 手机端事件分类表、去重键、合并器均有「与桌面端语义对照」的回归测试；Rust 侧事件变更（新增变体/字段）由 `registry_drift.rs` 护栏先拦截（`events.rs:7-8`），手机端生成类型随 `generate-engine-bindings.mjs` 重新生成后，分类器测试因枚举不全会**编译失败**强制补分类——这是与桌面端同构的防漂移手段。

## 9. 风险与依赖

| 项 | 风险/依赖 | 缓解 |
|---|---|---|
| 依赖 D1/D3 协议 | WS 帧格式与连接建立由同步域定义，本域消费契约依赖其稳定性 | 本域严格只依赖 `AgentEventEnvelope` 序列化形态（`events.rs:941-964`），该形态桌面端已线上验证 |
| 依赖 F1/D6 快照 | 断线重建依赖会话快照 | 快照只重建骨架，增量以事件为真源；快照缺失时降级「仅显示连接后事件」 |
| 依赖 D7 推送 | 通知触发点清单是 D7 的输入 | 本域给出 14 个触发点 + 去重策略，D7 按优先级订阅 |
| 共享纯函数迁移 | 桌面端 `toolCardPresenter.ts` 等当前为桌面 store 类型耦合 | 抽 `*.pure.ts` 时以「仅依赖纯类型（string/JSON）」为边界，类型层面解耦 |
| 手机端性能 | 中端手机渲染压力 | §3.4 三层防线（合并/虚拟列表/有界缓冲）+ §7.3 省电策略；T17 压测为验收门禁 |
| 事件契约演进 | 41 变体未来新增 | 分类表 + 生成类型双护栏（§8.4），新增事件必须补分类才可编译 |

## 10. 验收标准

1. 41 变体全部有明确分类归属（S/N/I），分类表与 `ALL_TYPE_NAMES` 一一对应且有测试护栏。
2. 手机端事件流页：run 分组时间线 feed、消息/工具/任务/审计/错误条目渲染完整，过滤（只看错误/只看当前 run/只看工具）与会话选择可用。
3. S1 终端输出：tool-update 流式行渲染 + tool-end 终值补齐 + 行缓冲截断 + 搜索/复制全部落地。
4. 交互跳转：工具详情/错误详情（含 FAQ 帮助）/审计明细/审批深链全部可用（T23 通过）。
5. 首帧 <500ms、delta 可见延迟 ≤100ms、20 万 delta 洪峰下无卡死且内存有界（T17 通过）。
6. 后台监听与省电行为符合 §7.2/§7.3 表；通知触发点清单交接 D7。
7. 全链路 E2E（T16-T24）通过；双端对照无终态不一致。

## 11. 实施分期建议

| 阶段 | 内容 | 产出 |
|---|---|---|
| F3-P1（基础流） | 事件分类器 + 消费面（去重/背压/合并器）+ feed 骨架（run-header/message/tool-card）+ 虚拟列表 | 事件流域最小可用版，T1-T6/T14/T16/T17 通过 |
| F3-P2（终端输出） | S1 终端流卡片 + 行缓冲 + 搜索/复制/截断 | T4/T5/T7/T21/T24 通过 |
| F3-P3（对齐与优化） | 三级 markdown 渲染 + 共享纯函数迁移 + 缓存徽标 | T8/T10/T22 通过 |
| F3-P4（交互与体验收口） | 详情页/过滤/会话选择 + 后台监听/省电 + 通知触发点接线 D7 + 断线重连 | T15/T18/T19/T20/T23 通过 |

---

*本方案为 F3 功能域设计输入；与 F1（会话同步）/F2（审批中心）/D1（总体架构）/D3（协议）/D6（同步一致性）/D7（推送通知）的边界以各域方案为准，冲突时由 D1 主方案裁决。*
