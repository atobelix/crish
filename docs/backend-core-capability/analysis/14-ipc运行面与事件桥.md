# IPC 运行面与事件桥

> 日期：2026-10-13
> 范围：`core_run_commands` 门面、`run/`、`engine*`、`engine_provider/`、`core_event_bridge`、`core_error`、`subagent_spawner`、`task_event_consumer`。
> 只记现存问题。旧系统地图只作线索，以当前代码为准。

## 能力结论

一条用户消息可以经 `core_run_task` → `RunManager::start_run` → `SessionLoopProducer` 跑完，再用 `drive_outcome` 收口，事件经 `BufferedRunEventBridge` 发到 `workbench-run-event`。主路径的用户 `client_message_id` 和助手 `assistant_client_message_id` 已经透进循环，不是丢弃。产品聊天的停止已经只发 `core_run_control`；系统地图里的 `TRANSITIONAL_DUAL_CANCEL_RUN_WIRE` 在前端出站已经删掉。

壳上仍有第二条运行状态，而且和循环不是同一条。`RunHandle`（orchestrator 九态）由 `start_run` / `cancel_run` / 审批转移维护；`ControlBus` + `AbortSignal` 由 `core_run_control` 维护，只在循环安全点或循环自己的读流竞速里生效。审批超时、第二条取消命令、子代理 lifecycle 强停，都会让这三边在终态对不上。

L2 协作停止能进循环。L3 能停掉循环对当前流的读取，但壳层 HTTP 适配器在生产上拿不到这次 abort，传输不中断。事件桥对 Tauri 发射失败仍计「已发射」，序列化失败则把这条（含终态）丢掉。任务终态唤醒写进了队列，但 `session_id` 是空串，会话隔离的消费面取不到。

## 问题清单

### BC14-1 L3 打到了循环，没有打到壳层 HTTP

- 现象：用户强停（以及任何只靠 run 级 `AbortSignal` 的路径）可以让 session-loop 停止再读流，但本次 provider HTTP 在首包前不会被选中取消，SSE 读循环的 `AbortFlag` 也不会被置位。连接一直读到对端结束或空闲超时。
- 证据：`apps/agent-workbench/src-tauri/src/engine_build.rs:410-411`、`apps/agent-workbench/src-tauri/src/engine_build.rs:512-515` 生产 `HttpProviderCall::new(...)`，没有 `with_abort_signal`。`apps/agent-workbench/src-tauri/src/engine_provider/stream.rs:36-45` 的 `register_session_abort_signal` 是 `#[cfg(test)]`，生产没有注册点。`apps/agent-workbench/src-tauri/src/engine_provider.rs:477-482` 只在调用对象自带信号或会话注册表命中时才有 abort。`apps/agent-workbench/src-tauri/src/engine_provider.rs:489-510`、`543-556` 这两段（首包 `select!`、流开始后的 `AbortFlag`）都挂在 `abort_signal` 为 `Some` 上。
- 机制：每个 run 在 `apps/agent-workbench/src-tauri/src/run/run_launch.rs:738` 新建 `AbortSignal`，经 `engine_build.rs:1598-1599` 只注入 `AgentSessionLoop`。`ProviderRequest` 没有 abort 字段。共享的 `HttpProviderCall` 跨 run 复用，生产路径上 `self.abort_signal` 与注册表都是空，`stream()` 里的信号恒为 `None`，走无取消的 `send().await`。循环侧 `consume_stream` 仍用自己的信号停读（那是循环内部，不在本文件范围）；壳层传输不知道这次停。
- 影响：L3 的「abort provider」在壳层传输上是空的。停读之后上游仍在生成并占连接；空闲超时（默认 60 秒，`engine_provider.rs:63`）之前，同连接池上的下一次请求和计费都不干净。子代理 lifecycle 连循环这份信号都不打，见 BC14-6。

### BC14-2 `core_run_control` 与 `core_cancel_run` 改的不是同一条终态

- 现象：产品聊天停止只发 `core_run_control`。壳和 REST 仍保留 `core_cancel_run`。两条命令对 `RunHandle`、`user_stopped`、`AbortSignal` 的写入不一致，同一句「协作停止 / 强停」会收成不同终态。
- 证据：`apps/agent-workbench/src-tauri/src/run/run_launch.rs:1189-1230` 的 L2/L3 只写 `user_stopped`、控制总线，L3 再 `abort_signal.abort()`，不调用 `RunHandle::cancel_run`。`apps/agent-workbench/src-tauri/src/run/run_launch.rs:1551-1574` 的 `cancel_run_impl` 立刻 `handle.cancel_run`。`1558-1561` 除字面量 `"cooperative"` 外（含缺省、`"force"`）都是 `CancelMode::Force`。协作分支不置 `user_stopped`，也不打 `abort_signal`（那只在 `ActiveRunEngine::abort`，`run/run_core.rs:124-131`，且仅强制路径调用）。前端出站已删双线：`apps/crish-desktop/src/api/runControlClient.ts:11-12`、`81-84`。系统地图「flag 仍开、L2/L3 成对附 cancel-run」与这条出站不符。`daemonClient.cancelRunCommand` 和 `server/core_backend.rs` 的 `cancel_run` 仍调用 `cancel_run_impl`。
- 机制：`cancel_run(Cooperative)` 在引擎接受协作停止后把 run 转成 `Cancelling`，并置 `cancel_requested`（`crates/orchestrator/src/run.rs:401-413`）。`drive_outcome` 看到 `cancel_requested` 就强制终态 `Cancelled` / `end_reason=aborted`，不管循环交回的是 `Stopped` 还是 `Stop`（`crates/orchestrator/src/run.rs:660-665`）。只走 `core_run_control` 时 `cancel_requested` 保持 false：循环 L2 交回 `Stopped`，被收成 `Completed` / `"stop"`（同文件 `640-642`、`668-669`，orchestrator 注释写明这是 D1）。另外 `cancel_run` 的协作路径不置 `user_stopped`，收口的 idle 续跑判定看不到「用户停过」。
- 影响：聊天 Stop 与 REST/daemon 的 cancel 不是同一个终态。前者协作停止看起来像正常完成；后者即使 mode 写成协作，也会把尚未停稳的 run 先打成 `Cancelling`，收口一律 `aborted`。两条都活着，调用方无法从命令名推断 run 状态机里现在是什么。

### BC14-3 忙时再发的 L1 丢掉 `clientMessageId`

- 现象：`core_run_task` 会把用户消息的 `clientMessageId` 写进 `AgentMessage`。运行中再发走 L1 时，壳层构造注入消息固定 `client_message_id: None`，载荷里的 id 不读。
- 证据：`apps/agent-workbench/src-tauri/src/run/run_launch.rs:1157-1177` 只从 `message` 或 `payload.text` 取正文，然后 `user_message(&text, None)`。`payload.kind` 只用来区分 follow_up / steer。前端 follow-up 会带 id：`apps/crish-desktop/src/api/runControlClient.ts:183-188`（`payload.clientMessageId`）。对照主路径已接通：`run/run_launch.rs:966-969`，`engine_provider/timestamp.rs:63-76`。
- 机制：忙时发送的产品语义是 L1 follow_up，不新开 `core_run_task`。乐观气泡的幂等键因此只存在于前端载荷，进循环的用户消息没有 `client_message_id`。助手 id 依赖当次 run 装配时的 `assistant_client_message_id`（`run_launch.rs:899`），跟不上这条后注入的用户消息。
- 影响：同一轮里后注入的用户消息无法用客户端 id 和乐观气泡对齐，重放或回声去重会把它当成另一条。主路径首发不受此条影响。

### BC14-4 审批超时后 run 状态停在 `awaiting-approval`，跑完会被收成失败

- 现象：审批超时或状态机转移失败时，工具批继续（超时是非致命），IPC 批准/拒绝仍返回成功。`RunHandle` 不回到 `running`。循环以正常 `Stop` 结束时，`drive_outcome` 无法收成 `Completed`，整次 run 走失败收口。
- 证据：进入等待前 `apps/agent-workbench/src-tauri/src/run/run_approval.rs:267-277` 调用 `request_approval`（`running → awaiting-approval`）；转移失败只 `warn`，审批照等。超时分支 `319-337` 清掉 pending、返回 `Expired`，没有 `resolve_approval`。`resolve` 在 `165-174`：决策已经送进 oneshot，状态机恢复失败只 `warn`，函数仍 `Ok(())`。`approve_tool_impl` / `deny_tool_impl`（`375-384`、`407-422`）接着返回 `ok: true`。`Completed` 只允许从 `running` / `completing` 收口（`crates/orchestrator/src/run.rs:590-599`）；`awaiting-approval` 会 `RunError::Transition`。`drive_run_loop` 把这个错误交给 `finalize_failed`（`apps/agent-workbench/src-tauri/src/run/run_idle.rs:1392-1402`）。循环侧超时不中断 run：`crates/session-loop/src/approval_router.rs:26`。
- 机制：壳层审批门和 orchestrator 状态机是两套写入。门用 oneshot 决定工具继续与否；状态机要另一次 `request_approval` / `resolve_approval`。超时路径只做了前者。于是循环认为这是一次非致命的过期审批，run 记录仍停在 `awaiting-approval`。收口按 `Stop → Completed` 转移被拒绝后，`finalize_failed` 把本可完成的 run 记成 `failed`。
- 影响：用户没赶上 120 秒批准、工具按过期交回模型并最终正常说完时，会话终态是失败，而不是「这步没批、后面继续」。批准命令在状态机没跟上时也对调用方报成功。

### BC14-5 子代理审批的死锁改道没有装配

- 现象：子代理工具审批在「父 run 正在 wait 这个子代理」时应当改由用户裁决。生产装配不注入检测器，这条改道不存在，只能干等超时。
- 证据：`apps/agent-workbench/src-tauri/src/run/run_launch.rs:657-661` 写明 `with_deadlock_detector` 未接，`ApprovalGateImpl::new` 的检测器是 `None`。`run/run_approval.rs:227-231`：`deadlock_detector` 为空时直接 `route_approval(&source)`，不会调用带守卫的改道。
- 机制：检测器的类型和测试注入都在，生产 `run_task_impl` 明确留空。子代理来源仍路由给主 agent。主 agent 若正堵在 wait，没有人批，120 秒后落到 BC14-4 的 `Expired`。
- 影响：父子互相等的审批不会转给用户。超时之后还要承受 BC14-4 的失败收口，子代理 run 会被记失败，而不是「改人批」或「这步过期但 run 仍完成」。

### BC14-6 子代理 lifecycle 强停、spawner 记账、run 状态机各写各的

- 现象：`kill_subagent` / `kill_all` 把行写成 `failed` 并发出 `subagent-ended(cancelled)` 时，活动 run 往往还在读流。壳的 `ForceCancelSink` 只往控制总线投 `force_cancel`，不打该 run 的 `abort_signal`。收口时 spawner 再把非 `Completed` 一律写成失败文案。
- 证据：`apps/agent-workbench/src-tauri/src/run/run_core.rs:1124-1135` 只 `request_subagent_force_cancel`（总线，`crates/session-loop/src/control.rs:328-336`），没有 `active.abort_signal.abort()`。用户 L3 会打信号：`run/run_launch.rs:1209`。lifecycle 在投递后立即把行写成 `failed` 并直发 `cancelled` 事件：`crates/orchestrator/src/lifecycle.rs:241-262`、`313-319`、`519`。循环读流只竞速自己的 `abort_signal`，不看总线（`crates/session-loop/src/loop/handlers/streaming.rs:143-149`）。收口映射 `run/run_core.rs:889-893`：只有 `RunStatus::Completed` 是 `SubagentState::Completed`，`Cancelled` 也变成 `Failed`。spawner 再写行摘要 `subagent_spawner.rs:967-970`（非完成即「子代理已结束（失败）」）。产出目录注入生产恒空：`subagent_spawner.rs:739` `output_dir: None`；`run/run_launch.rs:858-865` 只有 `Some` 才注入；`SubagentSpawnRequest`（`crates/agent-tools/src/tools/subagent/contract.rs:56-95`）没有产出目录字段。
- 机制：三套账。orchestrator lifecycle 同步改 `session_agents` 行并自己 `append_event`。spawner 的 `RunTracking` 另记深度、容量和终态闩锁，等 `drive_run_loop` 调用 `on_subagent_terminal`。`RunHandle` 要等循环自己结束才由 `drive_outcome` 收口。总线意图要到下一个安全点才被看；流中没有 abort，当前 HTTP 会读完。行和 `subagent-ended(cancelled)` 已经对外说结束了。之后若 run 被收成 `Cancelled`，spawner 仍把行覆盖成失败语义，和已落库的 `cancelled` 事件不是同一个状态。`output_dir` 段在装配里写了，唯一生产构造传 `None`，这段不会执行。
- 影响：kill 返回时子代理可能仍在跑工具和请求。前端或父代理看到的结束事件是 `cancelled`，行状态和收口摘要是失败。父代理的下一轮可能按「已经杀掉」继续，子 run 的后半段还在写。

### BC14-7 任务终态唤醒入了队，没有任何会话取得到

- 现象：任务 completed / failed / killed 会往共享 steering 队列放一条唤醒。条目的 `session_id` 恒为空串。idle 续跑按会话取出，这条永远匹配不上。
- 证据：`apps/agent-workbench/src-tauri/src/task_event_consumer.rs:202-213` 调用 `build_wake_steering_entry` 后 `replace_or_enqueue`，不改 `session_id`。构造函数把会话定成空串：`crates/orchestrator/src/task_events.rs:174-182`。消费器自己的 `session_id` 也是空串占位：`run/run_core.rs:430-433`。取出是 `dequeue_all_for`（`crates/orchestrator/src/steering_queue.rs:201-202`，相等比较）。续跑使用 `drain_pending_to_inject_messages(&mut queue, &active.session_id)`（`run/run_idle.rs:543-547`）。归属只记了 `owner_run_id`（`task_event_consumer.rs:184-200`），没有反查 run 所在会话。验收测试只 `peek()` 全局队首（`core_run_commands_tests.rs:8663-8674`），不断言 `session_id`，也不走 `dequeue_all_for`。
- 机制：队列后来加了会话隔离，唤醒构造还是旧的空 `session_id`，分组还是全局 `task-wake`。`replace_or_enqueue` 用 `session_id + group_id` 对齐（`steering_queue.rs:155-164`），于是所有任务终态挤在同一条空会话记录上，后一条覆盖前一条。`clear_for(真实会话)` 也清不掉它。无 `owner_run_id` 的任务按设计跳过唤醒（`task_event_consumer.rs:192-200`），有归属的任务在生产上同样到不了该会话。
- 影响：后台任务结束不会把摘要注入所属会话的下一轮。主代理不会因为任务完成而醒。审计事件另走桥，那条还能发出；唤醒这条不能。

### BC14-8 事件桥把发射失败计成成功，序列化失败则丢掉终态

- 现象：Tauri `emit` 失败只打日志，报告仍是已发射 1 条。信封序列化失败则这条不发、不重试，调用方看到的是默认空报告。收口流在「实时轨已开」时跳过全部 `message-delta`，不再补发。
- 证据：`apps/agent-workbench/src-tauri/src/core_event_bridge.rs:83-94` 失败只 `warn`。`228-238` `emit_payload` 不论 `emit` 结果，`emitted` 固定为 1。`200-223` 序列化 `Err` 打错误日志并返回 `None`，`emit_envelope` 变成空 `EmitReport`。`run/run_idle.rs:1414-1420`：`delta_sink_active` 时 `MessageDelta` 直接 `continue`。实时轨本身会按 Soft 水位丢 delta（`engine_channels.rs:633-656`，类目在 `buffer.rs:28-29`）。手动压缩在事件入队失败时仍 `Ok`：`run/run_launch.rs:1508` 的 `push` 用 `ok()?` 变成 `None`，`1490-1495` 照样返回 `CompactNowResult`（缓存已在 `1395` 替换）。
- 机制：缓冲层对 Critical（含 `message-end`、`run-terminal`）不丢帧，这是设计。洞在缓冲之后：发射和序列化失败没有回灌，也没有让 `drive_run_loop` 改终态。实时 delta 被跳过的前提是「实时轨已经送到」；发射失败被计成成功，这个前提是假的，收口轨又不会把 delta 再发一遍。`message-end` 仍走收口轨，全文兜底还在，但只在整次 `produce` 结束之后，而且同样可能在 `emit` 时被吞掉。
- 影响：WebView 未就绪或 emit 失败时，UI 可以收不到 `run-terminal`，本地却已经把 run 收口并从 `active_runs` 移除。流式文本会缺段，直到（如果还能送到的）`message-end`。调用方无法从 `EmitReport.emitted` 判断通道是否真的写出。

### BC14-9 目录未命中时按 chat 发请求；摘要器另开一条只懂 chat 的 HTTP

- 现象：主运行流的 body / URL / 解析器委托 `agent-provider`，这一点不是第二套解析器。但目录 lookup 失败时壳把协议收成 chat 并照样 POST。摘要请求不走这条四协议适配，永远是 chat-completions + Bearer + `choices[0].message.content`。
- 证据：`CatalogRequestProfile::fail_closed` 把协议设为 `WireProtocol::Chat`（`engine_provider/protocol.rs:161-174`）。`catalog_request_profile` 在 provider/model 未命中时直接返回它（`193-212`）。`engine_provider.rs:455-474` 用这个剖面建 body 和 URL，没有「未命中就拒绝出站」。注释仍称未命中为 fail-closed（`protocol.rs:396-398`），行为是改协议继续发。`engine_provider.rs:128-131` 把非 Responses 的端点字段收成 `ChatCompletions`，诊断却读这个字段（`561-562`），与剖面协议可以不一致。摘要：`engine_channels.rs:123-159` 固定 `build_chat_completions_request_body` 和 `chat_provider_url`；`216-233` 只认 chat 的 `choices[0].message.content`。
- 机制：热路径协议以 live catalog 为准，这是单次 lookup，不是壳里重写的 SSE 状态机。lookup 失败被收成「像 OpenAI chat 一样发」，而不是把 run 停在未就绪。摘要器是另一条 HTTP：不看 `WireProtocol`，Anthropic / Gemini 的 base URL 会收到 chat 形状的 body；响应不是 chat 形状时 `summary_content_from_response` 返回 `None`，调用方当成没有摘要。
- 影响：模型不在已提交目录里时，请求会以错误协议打到该 base URL，上游 4xx 或错解析，而不是装配期拒绝。非 chat 协议的压缩 / 阶段摘要在壳层这条路上拿不到正文，压缩会走「摘要不可用」，即使主对话流用的是同一把 key 和同一个模型。

## 已核对闭合或不是问题

- `core_run_task` 不再丢用户 `client_message_id`。`run/run_launch.rs:492-493`、`966-969` 传入 `user_message_with_content`，`engine_provider/timestamp.rs:76` 写入消息。历史线索的这一半已经接上。L1 仍丢，见 BC14-3。
- 主路径助手 `assistant_client_message_id` 不是壳里写死的 `None`。`run/run_launch.rs:899` 放进 `SessionLoopOptions.tool_exec`，循环在提交助手消息时读取。子代理 spawn、idle 续跑、workflow 构造 `RunTaskOptions` 时仍传 `None`（例如 `subagent_spawner.rs:749-750`）；那是引擎自己拉起的 run，没有前端占位气泡。不把主路径再记成「硬编码 None」。
- 产品聊天不再对每次 L2/L3 成对发送 `core_cancel_run`。`runControlClient.ts:11-12` 写明过渡双线已删，`sendWireViaTransport` 只放行 `run-control`。系统地图第 3.3 节过时。命令本身还在，语义分叉见 BC14-2，不是「flag 仍在前端成对发送」。
- L2 和 L3 都会进循环，不是只有一条总线写入是空操作。L2：`run_launch.rs:1196-1199` → 同一把 `ControlBus`（`engine_build.rs:1595-1596`）。L3：总线 `force_cancel` 加循环 `AbortSignal`（`run_launch.rs:1209-1215`，`engine_build.rs:1598-1599`）。没接上的是壳层 HTTP（BC14-1）和 lifecycle 那条只写总线的强停（BC14-6）。L2 收成 `Completed`/`stop` 是 orchestrator D1 对 `Stopped` 的映射，在「只走 run-control」时与「协作收尾、不当取消」一致；不能单独当成壳把停止记成成功。和 `core_cancel_run` 叠在一起才分叉。
- 背压丢的是 Soft delta，不是终态。`buffer.rs:8-16`、`28-29`：唯一 Soft 是 `message-delta`；`message-end` 与 `run-terminal` 为 Critical，水位不丢。收口跳过 `MessageDelta`（`run_idle.rs:1414-1420`）是为了不和实时轨双发，全文在 `message-end`。这不是「桥有意丢掉终态」。终态会丢的情况是发射/序列化失败，见 BC14-8。
- 主运行流没有在壳里再实现一套 SSE 解析器。`HttpStreamParser` 把帧交给 `agent-provider` 的 chat / responses / anthropic / gemini 解析器（`engine_provider/protocol.rs:492-516`），body 用 `agent-provider::request::build_*`。并行的是摘要 HTTP 和 lookup 失败改走 chat，见 BC14-9。
- `map_run_err` / `map_store_err`（`core_error.rs:34-51`）把转移拒绝收成 `InvalidInput`、存储失败收成 `Io`，detail 里保留原文，不是把错误收成 `Ok`。审批 IPC 在状态机失败时仍 `Ok`，记在 BC14-4，不记在错误类型映射上。

## 覆盖与未覆盖

覆盖：`core_run_task` / `core_run_control` / `core_cancel_run` / 审批命令的壳层实现，`drive_run_loop` 与 `finalize_failed`，`SessionLoopProducer` 与 `HttpProviderCall` 的装配和 abort，事件桥与缓冲的发射语义，摘要器的出站形状，子代理 spawner 终态与 `ForceCancelSink`，任务事件消费器入队。

未覆盖（按调度交给别路，这里只在机制处引用了行号，没有重审）：`core_query_commands` 与 `command_manifest`（15）；`agent-provider` 的请求、解析、重试内部（08/09）；session-loop 安全点如何消费总线（03）；orchestrator 状态机全表与 lifecycle 命令本身（06/07）；前端是否把 `sequence=None` 的预览画出来。`run/` 里压缩里程碑、goal 续轮、快照三代的业务规则没有逐项当成本路问题，除非它们经事件桥或 run 终态把失败收成成功。

## 给主控的摘要

1. 主路径 `core_run_task` 的用户/助手 client id 已接通；忙时 L1 仍把 `payload.clientMessageId` 丢掉（BC14-3）。
2. 系统地图的停止双线在聊天出站已删；壳上 `core_cancel_run` 仍会把 run 打成 Cancelling 并强制 `aborted`，`core_run_control` 不会（BC14-2）。
3. L2/L3 都进了循环总线；L3 的 HTTP abort 生产未接，`register_session_abort_signal` 只在测试里（BC14-1）。
4. 子代理 kill 只写总线、不打 abort，行和 cancelled 事件先落地，run 还在读流；收口再把 Cancelled 写成失败（BC14-6）。
5. 审批超时不把 `RunHandle` 拉回 running，非致命 Expired 之后正常收口会变成 `finalize_failed`（BC14-4）。
6. 子代理审批死锁改道未注入，父 run 在 wait 时只能干等 120 秒（BC14-5）。
7. 任务终态唤醒 `session_id` 恒空，`dequeue_all_for` 取不到；现有 E2E 只看全局队首（BC14-7）。
8. 事件 `emit` 失败仍计 emitted=1；序列化失败丢掉该条，收口不再补发 delta（BC14-8）。
9. 目录未命中按 chat 继续 POST；摘要器是另一条只认 chat-completions 的 HTTP（BC14-9）。
10. 子代理产出目录注入生产恒 `None`，请求类型没有该字段（BC14-6 末）。
