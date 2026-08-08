# 04 对话流输出一致性：多输出 / 少显示 / 事件与 UI 不同步

> 文档类型：深度分析（只读，未修改任何代码）
> 分析日期：2026-08-09
> 范围：Rust 引擎（session-loop / orchestrator / agent-workbench 桥）→ Tauri IPC 事件通道 → 前端（EventRouter → useStreamCallbacks → store → UI）全链路输出一致性。
> 用户真实反馈（长期存在）：**对话流会多输出（显示内容比实际多/重复），有时显示比实际少（丢失）**；用户要求"保证状态的展示唯一性、事件的唯一性，不要重复"。
> 证据标注：所有结论均基于实读代码，标注 `文件路径:行号`；无法从代码面证实的推断显式标注【推断】。

---

## 0. 结论先行

1. **主链路（T09.1 双轨）本身设计为防双发**：Rust 实时轨（sequence=None）与收口轨（sequence 分配）的 message-delta 在发射层做了"收口跳过"（core_run_commands.rs:2441），前端 message-end 全文兜底；**正常单轮、无丢帧、无修订场景下，输出是唯一且完整的**。
2. **多输出（显示多于实际）最大嫌疑是"丢帧后的启发式恢复失败 → 追加拼接"**：message-end 全文合并依赖 `mergeAssistantTextPiece` 的子串包含判定（eventUtils.ts:41-54），当流式增量与终稿不一致（中间 delta 被缓冲丢弃 / provider 终稿修订）时，判定不命中即 `\n\n` 追加——**同一份内容以"增量版 + 终稿版"两段共存**。其次是多轮 run 的 live 单气泡与 hydrate 多消息/覆盖展示不一致（R3/M2）。
3. **少显示（显示少于实际）最大嫌疑是"事件无消费方"与"终态权威丢失"**：① 子代理事件仅 per-run 路由器消费，父 run 结束后跨 run 存活的子代理事件无人接收（subagent_events.rs:11 信封 runId=父 run + dataPlaneRouter 只收 task/timer/cron）；② 多轮 run hydrate 投影同 clientMessageId 折叠后 `a.text = text` 覆盖，只剩末轮文本；③ 引擎崩溃无任何终态事件时消息永久卡 processing（endTimer 仅由 agent-end 设置）。
4. **唯一性现状**：状态层（store 按 id upsert、toolCalls/blocks 按 id 去重）与 Rust 发射层（收口跳过、丢帧只丢 Delta、run-terminal 唯一终态）防护较完备；**缺口集中在"事件层无消费侧去重/游标"与"message-end 全文合并无精确对账"两处**——EventRouter.ts:93-96 明确"前端不校验 sequence、不做去重/缺口检测"，所有防重复都押在"引擎单发"单点上，无兜底。

---

## 1. 事件流全景

### 1.1 事件通道与信封

- 通道：Tauri `listen('workbench-run-event')`（tauriTransport.ts:30，懒订阅 tauriTransport.ts:305-341）；Rust 侧 `app.emit(channel, payload)`（core_event_bridge.rs:69）。
- 信封：顶层平铺 `{ type, runId, sequence, schemaVersion, sessionId, ...事件字段 }`，逐字透传不做二次归一（core_event_bridge.rs:7-9, 196-220；tauriTransport.ts:316-323）。
- 双轨（T09.1）：
  - **实时轨**：`BridgeDeltaSink::push`（engine.rs:1444-1452）→ 信封 `sequence=None`、runId=Some → 入缓冲即 flush；只承载 message-delta（text/thought 增量，streaming.rs:511-530）。
  - **收口轨**：`drive_outcome` 经 EventQueue 分配**会话级原子 sequence**（orchestrator/events.rs:17, 210；T08.12）→ `drive_run_loop` 逐条 emit（core_run_commands.rs:2434-2454）；**`delta_sink_active` 时收口 message-delta 跳过不双发**（core_run_commands.rs:2441-2443）。
- 背压丢帧：`EventBuffer`（buffer.rs:91-144）——Soft 水位 64 / Critical 水位 256（buffer.rs:202）；仅 `message-delta` 属 DropClass::Soft（buffer.rs:36-42，丢帧不丢 message-end）；Critical 永不丢（无 Soft 可驱逐时超限接受）。
- runId 过滤：`messageBelongsToRun`（eventUtils.ts:30-39）——事件无 runId 放行、有 runId 须等于本地 runId。

### 1.2 事件类型清单（41 类，conex-types/events.rs:290-296；前端分派表 dispatch.ts:78-134）

| 事件 | 语义 | Rust 发射面 | 前端消费方（handler → 落点） |
|---|---|---|---|
| agent-start | run 启动 | 收口轨 | onAgentStart（空实现，lifecycleHandlers.ts:13-18） |
| agent-end | run 结束（reason/error） | 收口轨 | onAgentEnd → surfaceStreamFailure / finish（lifecycleHandlers.ts:20-60） |
| turn-start / turn-end | 轮次边界 | 收口轨 | onTurnStart/onTurnEnd（空实现，lifecycleHandlers.ts:62-74） |
| message-start | 消息开始（载荷 Arc） | 收口轨，每 turn 一次（streaming.rs:492-505） | onMessageStart（空实现，messageHandlers.ts:67-72） |
| message-delta | 增量正文/思考块（硬依赖 block.text + messageId，conex-types/events.rs:349-356） | **实时轨**（sequence=None）+ 收口轨（delta_sink_active 时跳过） | onMessageDelta（messageHandlers.ts:74-106）→ `state.assistantText += t` → `callbacks.onChunk` → useStreamCallbacks → StreamRenderBuffer → streamingStore（useStreamBatchers.ts:49, useStreamCallbacks.ts:249, 555-577） |
| message-end | 消息终态全文（含 clientMessageId 稳定 id，conex-types/events.rs:359-363） | 收口轨，每 turn 一次（Critical 永不丢） | onMessageEnd（messageHandlers.ts:108-154）→ mergeAssistantTextPiece 全文合并 → onChunk 差额 → 缓存指标挂 store |
| tool-start | 单工具开始（硬依赖 call.id/toolName） | 收口轨 | onToolStart（toolHandlers.ts:12-23）→ callbacks.onToolStart → upsertToolCall → toolBatcher → store（sessionMessageActions.ts:223-243 按 id merge） |
| tool-update | 进度增量（预留） | 收口轨 | 显式空实现（toolHandlers.ts:25-30） |
| tool-end | 单工具结束（result.output/isError） | 收口轨 | onToolEnd（toolHandlers.ts:32-45）→ onToolSuccess/onToolError → tool 终态 patch（isImmediateToolStatus 立即落 store） |
| tool-batch-start / tool-batch-end | 批量（前端显式 ignore） | 收口轨 | 显式空实现（toolHandlers.ts:47-59） |
| tool-input-repaired | 入参修复记录 | 收口轨 | 显式空实现（toolHandlers.ts:61-66） |
| run-terminal | run 唯一终态（terminal/error，03 §5.2-2） | 收口轨，`terminal_sent` 守卫唯一一次（orchestrator/events.rs:277-331, 328） | onRunTerminal（lifecycleHandlers.ts:76-107）→ surfaceStreamFailure（非 run-cancelled 失败）/ clear_all / finish |
| runtime-error | 观测性错误（不直接收口） | 收口轨（另写 lastError，core_run_commands.rs:2445-2459） | onRuntimeError（diagnosticHandlers）→ 诊断登记 |
| runtime-steering / runtime-intervention-required | 引导注入 / 需人工介入 | 收口轨 | diagnosticHandlers 消费 |
| provider-diagnostic | provider 运行诊断 | 收口轨（streaming.rs:356-365） | onProviderDiagnostic → logInternalError |
| approval-requested | 审批请求（硬依赖 request.toolCallId，03 §5.1-9） | **实时预览**：sequence=None 广播（core_run_commands.rs:2927, engine.rs:168） | onApprovalRequested（approvalHandlers.ts:25-114）→ approvalFlow + onToolPendingApproval / 白名单自动放行 |
| approval-resolved | 审批结果（持久化 + sequence，emit_approval_resolved core_run_commands.rs:3578-3611） | 独立队列发射（非 drive 路径） | onApprovalResolved（approvalHandlers.ts:116-146）→ 工具 patch + tryResumeFinish |
| context-compression-start / end | 上下文压缩 | 收口轨 | compressionHandlers → 记录/日志 |
| checkpoint-created / restored | 检查点 | 收口轨 | compressionHandlers |
| cache-stats-updated / cache-waste-alert / cold-cache-warning | 缓存测量（runId 信封注入） | 收口轨/实时轨（T-40） | cacheEventHandlers → cacheEventsStore |
| security-audit | 高危操作审计（runId 信封注入） | 收口轨/工具侧发射 | securityAuditHandlers → securityAuditStore |
| subagent-started / subagent-event / subagent-ended | 子代理生命周期（信封 runId = **父 run**，subagent_events.rs:11, 41-48；子代理域唯一发射方 subagent_events.rs:1-6） | EventQueue（started/ended=Critical；event 按 kind Delta/Soft） | per-run EventRouter → subagentHandlers.ts:12-63 → callbacks.onSubagentStarted/Event/Ended → store agents（useStreamCallbacks.ts:405-495）；**无全局订阅者** |
| task-started / task-output / task-heartbeat / task-suspicious / task-completed / task-failed / task-killed | 后台任务域（数据面） | task_events.rs 发射 | **全局** dataPlaneRouter（dataPlaneRouter.ts:46-57, 141-153）+ per-run EventRouter 对数据面类型 return（EventRouter.ts:81） |
| timer-fired / timer-cancelled / cron-fired | 定时器/Cron 域（数据面） | timers.rs / sched.rs | 同上数据面路由 |

### 1.3 前端消费拓扑（谁在听）

- **per-run EventRouter**（唯一 run 级消费者）：`streamViaEngine` → `createStreamSession` 在 `transport.onMessage(onMessage)` 订阅（ConnectionLifecycle.ts:345），`startRunTask` 派发在订阅之后（ConnectionLifecycle.ts:467）——**不存在"未订阅先收事件"的窗口**。
- **全局 dataPlaneRouter**（task/timer/cron 10 类）：`ensureDataPlaneRouter` refcount 单例（dataPlaneRouter.ts:141-153），useEngineState 持有（useEngineState.ts:177）。
- 双面隔离防重复 dispatch：EventRouter.handleAgentEvent 对数据面类型直接 return（EventRouter.ts:81）。
- 除此之外**没有第三个 onMessage 订阅者**（实读确认；tauriTransport.ts:325-331 fanout 仅此两路）。

---

## 2. 多输出根因清单（显示多于实际）

| # | 路径 | 代码证据 | 影响 | 触发条件 |
|---|---|---|---|---|
| R1 | **message-end 全文合并启发式失败 → `\n\n` 追加（内容重复两段）** | messageHandlers.ts:136-144：`piece = text.trim()` → `mergeAssistantTextPiece(state.assistantText, piece)`，仅当 `state.assistantText.length > prevLen` 时 onChunk 差额；eventUtils.ts:41-54：`prior===p \| p.startsWith(prior) \| prior.endsWith(p) \| p.includes(prior)` 四判据全不中 → `return prior + "\n\n" + p` | **高**：气泡内出现"流式增量版 + 终稿版"两份近重复内容；commitStreamToSession（helpers.ts:184-217）原样落库、scheduleFinalMarkdownHtml 渲染 | ① 中间 delta 被缓冲丢弃（buffer.rs:112-128 Soft 水位 64 丢最早 delta；高密度流下真实可达，buffer.rs:368-395 压测证实丢帧路径）→ prior 缺中段，`p.includes(prior)` 不命中；② provider 终稿与增量不一致（修订/回退），如流式输出 "Hello world" 后终稿 "Hello beautiful world" |
| R2 | **onMessageDelta 追加假设 = 增量流，全文块 delta 会整段重复** | messageHandlers.ts:88-102：无 `raw.message.content` 或 content 更短时走 `state.assistantText += t` 纯追加；delta_to_message_event（streaming.rs:511-530）逐条发射增量 | 中（当前主路径被 core_run_commands.rs:2441 防住） | 任何路径使收口 message-delta 未跳过（delta_sink_active=false / 新增 emit 路径未走同一判定）→ 全文块被 `+=` 双写。**防重复依赖发射层单点，前端无兜底** |
| R3 | **多轮 run：live 单气泡 vs hydrate/DB 逐轮消息（展示不一致）** | streaming.rs:492-505：每 turn 各 commit_message_with_deltas（每 turn 独立 message-end，同 clientMessageId 跨 turn 复用，build_assistant_message streaming.rs:431-476）；live 侧 messageHandlers.ts:136-144 逐轮 merge 累积 → 单气泡；hydrate 侧 sessionEventHydrate.ts:186-208 同 id 折叠 → 单消息；DB 侧 agent_messages 逐 turn 落行【推断：按 message-end 逐条持久化，orchestrator/events.rs:50-56 message-delta 不落库、message-end 属 Persistent】 | 中高：**同一次对话，live 视图与 reload 后视图消息条数/内容不一致**（详见 M2 少显示面） | 多轮（含工具循环）run + 会话重载/hydrate |
| R4 | **hydrate 投影中 delta 累积 + message-end 覆盖（若事件流含 delta）** | sessionEventHydrate.ts:287-310：message-delta 逐条 `a.text += t`；:259-282 message-end `a.text = text` 整体覆盖——若同一 assistant 既有累积 delta 又到 message-end 且内容不恰好相等 → 覆盖后无残留（不重复）但累积段被弃（少显示面）；若事件流含"全文型 delta"则 `+=` 重复 | 低（当前 delta 不落库 = 现状护栏，orchestrator/events.rs:50 与 events.rs:724-731 测试锁定） | 未来任何"把 delta 加入持久化"的改动 |
| R5 | **失败四源收敛各自触发 onRunError（多条 toast/横幅，展示噪音）** | BridgeErrorPolicy.ts:38-40 每源各调一次 onRunError：run-terminal-failed（lifecycleHandlers.ts:89-98）、agent-end-error（lifecycleHandlers.ts:31-39）、error 信封（subagentHandlers.ts:65-74）、未知事件登记不收敛（EventRouter.ts:116-125）；useStreamCallbacks.ts:597-606 每调一次 pushRunNotice + onShowToast | 低（非正文重复，但属"事件不唯一"表象） | run-failed 同时伴随 agent-end-error / error 信封双到 |
| R6 | **thinking 占位清理后被迟到的 onThought 回填（思考与正文并存展示）** | useStreamCallbacks.ts:571-576 onChunk 到达即 drop thinking 批 + `updateMessageThinking('')`；但 onThought（:360-366）仍持续 push——思考增量晚于首个正文块到达时，批合并窗口内 thinking 又被写回 | 低 | thinking 流与 text 流交错到达（引擎顺序保证 thought 先于 text，仅异常/丢帧时可见） |
| R7（已防护） | 工具块/工具卡重复 | addMessageToolCall 按 id merge + blocks 去重（sessionMessageActions.ts:223-243）；commitToolPatchToSession 走 updateMessageToolCall（helpers.ts:134-157）；normalizeAssistantTimeline + dedupeToolCalls（timelineNormalizer.ts:81-120）；toolBatcher 按 `sid::mid::toolId` 合并（useStreamBatchers.ts:77-107） | 无（该面已完备） | —— |
| R8（已防护） | 消息双气泡 | addMessage 同 id upsert（sessionMessageActions.ts:59-69 + upsertMessageById sessionSharedHelpers.ts:342-355）；对抗测试锁定（sessionActions.test.ts:925-995）；mergeMessagesById 同 id 折叠（sessionEventHydrate.ts:118-149）；rekeyAssistantIfStable（sessionEventHydrate.ts:99-111） | 无（该面已完备） | —— |

---

## 3. 少显示根因清单（显示少于实际）

| # | 路径 | 代码证据 | 影响 | 触发条件 |
|---|---|---|---|---|
| M1 | **子代理事件无跨 run 全局订阅者 → 父 run 结束后事件丢失** | subagent-* 事件信封 runId = 父 run（subagent_events.rs:11, 41-48），仅 per-run EventRouter 消费（dispatch.ts:117-119 → subagentHandlers.ts）；EventRouter 随 run 收口卸载（cleanupStreamState streamState.ts:26-33，state.unsub 退订）；dataPlaneRouter 只收 task/timer/cron 10 类（dataPlaneRouter.ts:46-57）——**subagent-* 不在其列**；子代理 run 独立于父 run（T-D-13，core_run_commands.rs:3300-3305 注册/释放），父 run L2/L3 收口不必然终止子代理 | **高**：子代理面板在父 run 结束后停滞（缺消息/工具/终态）；started 后 ended 前父 run 结束 → 子代理永不收口显示 |
| M2 | **多轮 run hydrate 投影：同 clientMessageId 折叠后 `a.text = text` 覆盖 → 只剩末轮文本** | sessionEventHydrate.ts:262-268：message-end → `a.text = text`（整体替换，非追加）；ensureAssistant（:186-208）同 id 折叠；turn 间无 user message 重置 currentAssistant（pushUser 才重置 :167）；引擎每 turn message-end 同 clientMessageId（streaming.rs:431-476） | **高**：多轮（含工具循环）run 在 reload/hydrate 后正文只剩最后一轮，此前轮次文本丢失；与 live 单气泡全文展示不一致（R3 B 面） |
| M3 | **message-end 恢复失败方向性**：中间丢帧时无法恢复（落入 R1 追加），头/尾丢帧可恢复但依赖子串判定 | eventUtils.ts:41-54 四判据；中间丢失时 prior 非 p 子串 → 追加（内容错误，不产生正确全文）；尾部丢失 `p.startsWith(prior)` 命中 → 返回 p 全文正确恢复；头部丢失 `p.includes(prior)` 命中 → 返回更长者正确恢复 | 中：恢复机制没有精确对账（无增量序号/内容哈希），只覆盖"缺失段在首/尾"的形态 |
| M4 | **onRunError 路径 renderBuffer 未强制 flush → 尾帧可能丢失** | useStreamCallbacks.ts:578-636：onRunError 只 `flushStreamBatchers()`（:635）——刷的是 batcher 层（useStreamBatchers.ts:130-134），**renderBuffer 的 pending 帧依赖 rAF 自然 flush**（StreamRenderBuffer.ts:146-151）；对比 onComplete（:649-651）与 finalizeStopGeneration（:947-949）均 `buffer.push('', true); flush(true)` | 低-中：失败瞬间若仍有未出帧的 delta，正文停在最后已刷帧（消息置 error、文本 partial）；rAF 通常数帧内补刷，窗口极小 |
| M5 | **引擎崩溃/无终态事件 → 消息永久卡 processing（停滞而非丢失）** | endTimer 仅由 agent-end 设置（lifecycleHandlers.ts:56-59，8s 兜底）；createFinishController 的 finishTimeoutMs=120s 仅覆盖 inflight approval（ConnectionLifecycle.ts:185-199）；run 中途进程退出（无 agent-end/run-terminal）→ 前端无任何超时收口；checkAndAlertSilentComplete（useStreamCallbacks.ts:775-786）仅 metric + dev warn，不改状态 | 中：UI 永久显示"处理中"，本轮输出看似"没有出现"；实际 DB 已有部分消息（persist 先行） |
| M6 | **runId 过滤静默丢弃（by design，但子代理 run 自身事件被误滤）** | eventUtils.ts:30-39：runId 不匹配即 return（EventRouter.ts:91）；子代理 run 的 message-*/tool-* 事件带**子代理 runId**，被父 run 路由器过滤（走 subagent-event 封装透传才是正路，subagent_events.rs:22-25）——若封装链路任一环缺失（引擎侧接线未全 / 落库恢复路径），子代理时间线缺正文与工具卡 | 低-中（依赖封装链路完备性）【推断：封装链路的子代理 run 实时事件派生接线在引擎侧，未逐行核实】 |
| M7（已防护） | 懒订阅窗口 / 事件提前到达 | 订阅在 startRunTask 之前（ConnectionLifecycle.ts:345 < :467）；进程内 IPC 无重连（tauriTransport.ts:17, 224-256）；StreamRecovery 重放已删除（ConnectionLifecycle.ts:13） | 无（该面已完备） | —— |
| M8（已防护） | 终态收口时正文提交丢失 | onComplete 三源取一：getStreamText || buffer.currentText || streamedFullText（useStreamCallbacks.ts:653-659）；finalizeStopGeneration 同样三源（:957-963）；commitStreamToSession 单次幂等 update（helpers.ts:184-217） | 无（该面已完备） | —— |

---

## 4. 唯一性保障现状与缺口

### 4.1 现状盘点（已存在的幂等/去重）

| 层 | 机制 | 代码锚点 |
|---|---|---|
| Rust 发射层 | 收口 message-delta 跳过防双发（delta_sink_active 判定） | core_run_commands.rs:2441-2443 |
| Rust 发射层 | 背压丢帧只丢 Delta（message-delta），message-end/工具/终态永不丢 | buffer.rs:36-42, 91-144 |
| Rust 发射层 | run-terminal 唯一终态（terminal_sent 守卫，重复驱动报 TerminalImmutable） | orchestrator/events.rs:277-331, 328 |
| Rust 发射层 | 会话级原子 sequence（EventQueue 取号） | orchestrator/events.rs:17, 210；conex-db T08.12 |
| Rust 持久化 | message-delta 不落库（非持久化类） | orchestrator/events.rs:50-56, 724-731 |
| 前端路由 | 数据面双面隔离防重复 dispatch | EventRouter.ts:81；dataPlaneRouter.ts:62-64 |
| 前端状态 | 消息 addMessage 同 id upsert（原地 merge，不 push） | sessionMessageActions.ts:59-69；sessionSharedHelpers.ts:342-355 |
| 前端状态 | status/text 合并优先级（终态不被 partial 回退/缩短；partial 取更长） | sessionSharedHelpers.ts:158-224 |
| 前端状态 | toolCalls 按 id merge；blocks 按 tool_call id 去重；终态不被 running 回退 | sessionMessageActions.ts:198-243；timelineNormalizer.ts:81-120 |
| 前端状态 | streamingStore 值相等跳过（setStreamText 同值 no-op） | streamingStore.ts:135 |
| 前端状态 | textBatcher 全文覆盖（非 delta 追加） | streamTextBatcher.ts:272-275；useStreamBatchers.ts:43-52 |
| 前端水合 | 按 id 折叠 + hyd-* 重键到 clientMessageId + merge 单条 | sessionEventHydrate.ts:99-149, 385-397, 462 对抗测试 |

### 4.2 缺口清单

| # | 缺口 | 后果 | 代码证据 |
|---|---|---|---|
| G1 | **事件层无消费侧去重/游标**：前端明确"不校验 sequence、不做乱序缓冲/去重/缺口检测"，防重复全押在"引擎单发"假设 | 引擎任何路径重复发同一事件（未来新增 emit 点/恢复重放），前端必然重复消费；R1/R2 即此缺口的后果面 | EventRouter.ts:93-96（F5-12 收口删除游标死代码）；extractEventSequence 仅为死代码保留（eventUtils.ts:5-12） |
| G2 | **实时轨 sequence=None，无端到端事件幂等键** | 无法按 (runId, sequence) 去重 delta；双轨事件无法互相去重（实时 delta vs 收口 delta 无共同键） | engine.rs:1447（AgentEventEnvelope::new(delta, Some(runId), None)） |
| G3 | **message-end 全文合并无精确对账**：mergeAssistantTextPiece 子串启发式，非前缀匹配即追加/覆盖，无"终态权威优先"语义 | R1 重复 / M2 覆盖 | eventUtils.ts:41-54；messageHandlers.ts:136-144 |
| G4 | **多轮消息跨 turn 共用 clientMessageId，无 turn 维度** | live 单气泡 vs hydrate 逐轮消息展示不一致（R3/M2）；DB 逐轮落行 vs 前端单消息 | streaming.rs:431-476, 492-505；sessionEventHydrate.ts:186-282 |
| G5 | **子代理事件无全局订阅者（跨 run 存活）** | 父 run 结束后子代理时间线停滞（M1） | dataPlaneRouter.ts:46-57（无 subagent-*）；streamState.ts:26-33 |
| G6 | **失败多源 onRunError 无去重** | 同一次失败多条横幅/toast（R5） | BridgeErrorPolicy.ts:38-40；lifecycleHandlers.ts:31-39, 89-98；subagentHandlers.ts:65-74 |
| G7 | **run 崩溃无终态事件 → 无超时收口** | 消息永久 processing（M5） | lifecycleHandlers.ts:56-59；ConnectionLifecycle.ts:185-199 |

---

## 5. 三层收敛建议（事件 / 状态 / UI）

### 5.1 事件唯一性层

1. **Rust 侧单发收口 + 前端消费侧兜底去重（G1/G2）**：
   - 实时轨 delta 增加事件幂等键：`messageId + block 序号`（T09.1 已保证 messageId 预生成对齐，streaming.rs:66-68），或在信封增加可选的 `deltaSeq`（0..n）；收口轨跳过逻辑（core_run_commands.rs:2441）保持不变，但**把"delta_sink 装配即跳过"提升为桥层不变量**——所有新增 emit 路径强制走同一判定，杜绝 R2 类泄漏。
   - 前端 EventRouter 在 `parseBridgeEvent` 与 `dispatchEvent` 之间（EventRouter.ts:101-112）增加 **per-run 已消费事件集合**：以 `(type, messageId, deltaSeq|sequence)` 为键幂等去重（收口轨事件用 sequence，实时轨 delta 用 messageId+deltaSeq）；重启 F5-12 删除的缺口检测（sequence 断档告警不阻断，进 recordStreamDiag）。
   - 锚点：EventRouter.ts:85-113；engine.rs:1444-1452；core_run_commands.rs:2439-2443。

2. **message-end 为终态权威（G3）**：`mergeAssistantTextPiece` 语义改为——`p`（message-end 全文）与 `prior`（增量累积）不一致时**以 p 为准**（终态权威，不做 `\n\n` 拼接），onChunk 仍按 `slice(prevLen)` 只补差额（保持渲染增量最小化）；仅在 `prior` 完整包含于 `p` 时维持现有快速路径。这同时消灭 R1（重复）与 M3（恢复失败）。锚点：eventUtils.ts:41-54；messageHandlers.ts:136-144。

3. **子代理事件全局路由（G5/M1）**：对齐 dataPlaneRouter 模式（dataPlaneRouter.ts:141-153 refcount 单例），新增 `subagent-*` 全局订阅面（按 subagentRunId 路由到 agents store），与 per-run 路由双面共存时按 `(runId, sequence)` 去重（父 run 路由优先，全局兜底）；或父 run 收口时将子代理订阅引用转移给全局路由。锚点：dataPlaneRouter.ts；subagentHandlers.ts。

4. **失败四源收敛去重（G6/R5）**：surfaceStreamFailure（BridgeErrorPolicy.ts:14-41）增加 per-run 失败事件幂等（同一 run 只 surface 一次，后续同类失败仅 logInternalError）。

### 5.2 状态唯一性层

5. **多轮消息 turn 维度（G4/R3/M2）**：message-end 载荷补 `turnIndex`（turn-start/turn-end 已有 turnIndex，events.rs:327-340，补齐到 message-end 即可）；前端 store 对同 clientMessageId 消息按 turnIndex 分段合并（`text` 追加、`turnIndex` 递增），hydrate 投影同步按 turnIndex 追加而非覆盖（sessionEventHydrate.ts:262-268）。落地后 live 与 hydrate/DB 展示同构（单消息多段 vs 单消息多段或逐轮消息按 id 唯一）。

6. **updateMessageText 块重建单一收口**：流中 snapshot（helpers.ts:224-237 与 sessionMessageActions.ts:158-178 的 streamTextOffset/segment 逻辑）保持现状（已幂等），**终态块重建只经 normalizeAssistantTimeline 一处**（onComplete 已接线，useStreamCallbacks.ts:741-750），并加守卫：终态后再来的 partial 写入不得改动 blocks（mergeSessionMessageFields 已有终态不回退规则，sessionSharedHelpers.ts:198-224，可复用）。

7. **streamingStore 与 session store 双源收敛**：现状"流中读 streamingStore、终态后读 msg.text"（MessageContent.tsx:47-65 + applyStreamTextToMessage streamingStore.ts:423-464）语义正确；补一条：`commitStreamToSession`（helpers.ts:184-217）后必须 clearStream 已完成（默认 true ✓）——增加断言/测试锁定"commit 后 streamingStore 无残留"（防双源显示残留）。

### 5.3 UI 唯一性层

8. **渲染 key 唯一性**：消息列表按 `message.id` 为 key（现状，且 id 生成唯一 generateMessageId / hyd 前缀折叠）；工具卡按 `toolId` + 消息内唯一（blocks/toolCalls 已去重，R7）；**新增**：渲染前统一 `normalizeAssistantTimeline + dedupeToolCalls`（timelineNormalizer.ts:25-120）——流中渲染层（MessageContent 的 applyStreamTextToMessage/applyStreamToolsToMessage）与终态层共用同一规范化入口，杜绝两套块序列漂移。

9. **thinking/text 展示互斥**（R6）：onChunk 到达后 thinking 展示即失效（useStreamCallbacks.ts:571-576 已有 drop）；补强：`thinkingBatcher` 在 onChunk 路径的 drop 是幂等入口（streamTextBatcher.ts:141-146），渲染层以"最后写入方"为准——若思考内容在正文后回填，UI 不渲染（thinking 展示条件 = 消息无 text）。

10. **run 崩溃兜底（G7/M5）**：扩展 silent-complete 检测为"run 无终态事件超时"（如 60s 无新事件且消息仍 processing → 自动置 error + 提示），避免永久卡 processing；锚点 useStreamCallbacks.ts:775-786 与 streamStop 面。

### 5.4 建议验证路径

- 单测：mergeAssistantTextPiece 新语义（终态权威）边界表——丢尾/丢头/丢中段/修订/多轮；EventRouter 幂等去重表（重复 message-end、重复 delta、乱序回放）；hydrate turnIndex 追加。
- 集成：buffer 洪峰丢帧（buffer.rs:368-395 压测同款）后 message-end 恢复正确性；多轮 run live→reload 一致性；子代理跨父 run 存活事件全链路。
- 门禁：现有 `npm test`（vitest unit）+ `cargo test --workspace`（73 套件基线）；主仓库 tests/e2e 5 个 markdown-editor 专项 spec 回归不受影响（本分析不触及引擎/渲染代码）。

---

## 附：关键链路代码索引

- 双轨发射：crates/session-loop/src/loop/handlers/streaming.rs:104-115（实时轨）、:492-505（收口轨）
- 收口跳过：apps/agent-workbench/src-tauri/src/core_run_commands.rs:2434-2454
- 实时桥：apps/agent-workbench/src-tauri/src/engine.rs:1444-1452
- 背压缓冲：apps/agent-workbench/src-tauri/src/buffer.rs:36-42, 91-144
- 终态唯一：crates/orchestrator/src/events.rs:277-331；run-terminal 事件定义 conex-types/events.rs:506-515
- 前端路由：apps/crish-desktop/src/api/chat-bridge/EventRouter.ts:85-113；handlers/eventParser.ts:399-857；handlers/dispatch.ts:78-158
- 文本链路：handlers/messageHandlers.ts:74-154；handlers/eventUtils.ts:41-54；hooks/chat-stream/useStreamCallbacks.ts:555-577, 637-912；api/StreamRenderBuffer.ts:78-208
- 状态层：store/sessionMessageActions.ts:37-83, 143-244；store/sessionSharedHelpers.ts:179-355
- 水合投影：api/sessionEventHydrate.ts:155-382
- 子代理：crates/orchestrator/src/subagent_events.rs:1-48；handlers/subagentHandlers.ts:12-63
