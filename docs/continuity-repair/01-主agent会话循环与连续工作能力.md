# 01 — 主 Agent 会话循环与连续工作能力分析

> 分析域：crates/session-loop/src/（lib.rs、loop/mod.rs、loop/end.rs、loop/handlers/*、state.rs、checkpoint.rs、safe_point.rs、hydrate.rs、control.rs、input.rs、steering/*、loop/summary_*、escape_watch.rs）
> 壳层消费侧：apps/agent-workbench/src-tauri/src/core_run_commands.rs、engine.rs、watchdog.rs、background.rs
> 语义依据：docs/rust-rewrite/01-session-loop-semantics.md（下称「01 规范」）
> 日期：2026-08-10

---

## 1. 结论先行

一句话现状：**单个 run 内，只要存在工具调用链或系统注入输入，主 agent 就能持续工作（while(!done) 多轮驱动）；但跨 run 的「任务未完成自动继续」只存在于系统事件驱动（子代理完成 / 定时器 / Cron / 逃逸监视注入）这一条窄通道；不存在 goal 目标跟踪驱动的继续；provider 网络错误耗尽重试后以 error 收场，系统不会自动恢复，只能靠用户再输入或新 run 手动续接。**

分项结论：

1. **Q1（网络错误恢复阶梯）**：引擎有完整分类恢复阶梯——瞬态错误重试（默认 3 次/run，**无退避**）→ length 升级（2 次）→ 溢出压缩（1 次）→ error 收场（PROVIDER_ERROR，endReason=error）。run 结束后已产出消息保留在引擎内存缓存（SessionHistoryCache）与前端 store，用户再输入/新 run 可经消息级水合接着继续；但引擎不会自动续 run。
2. **Q2（goal 模式）**：**无**。GoalAudit 策略是占位（恒空），before-turn 相位无策略注册；max-turns 后无继续机制；SHOULD_STOP 后仅靠壳层 idle_resume（系统事件源）或用户输入恢复；纯文字回复（stopReason=stop）即正常收场，系统不判定「任务是否完成」。
3. **Q3（checkpoint/hydrate）**：checkpoint 采集函数已实现但**生产未接线**（仅测试调用）；恢复能力 = 消息级水合（hydrate_history + SessionHistoryCache 保真缓存），非状态机级恢复——每 run 状态机从 idle 重建，轮次/重试/steering 计数不持久化。
4. **Q4（主动停止 vs 网络中断）**：语义上完全区分——L2 cooperative_stop → reason=Stopped（独立 reason，D1）、L3 force_cancel/AbortSignal → reason=Aborted、网络中断耗尽 → reason=Error；三者在壳层 idle_resume 判定中**一律不自动续 run**（仅正常 Stop 且存在唤醒源才续）。
5. **Q5（结论）**：**不满足**「未主动停止 / 未用户停止 → 应能一直工作」的强语义。现状满足的是「单 run 内多轮工作」与「系统事件驱动续 run」；缺口是 goal 跟踪、max-turns/error 后的自动继续、重试退避。

### 缺口清单

- G1（高）：瞬态重试无退避——规范 01 §2.5 要求的指数 sleep 未实现，3 次重试连发，Retry-After 不被消费。
- G2（高）：error / max-turns 收场后无自动恢复——idle_resume 硬性排除非 Stop reason，网络中断后任务悬挂。
- G3（高）：goal 模式缺失——无目标跟踪、无任务完成度判定、max-turns 后无续轮。
- G4（中）：checkpoint 采集生产未接线——「存在 checkpoint 时优先恢复」只是提示词声明。
- G5（中）：恢复粒度 = 消息级，非状态机级——中断时进行中的轮次/工具批/计数全部丢失。
- G6（中）：水合双路径语义不一致——引擎缓存保真含 error 态消息，前端路径过滤 error 态（hydrate.rs:87-93）。
- G7（低-中）：max_turns 固定 64（MAX_TURNS_DEFAULT，core_run_commands.rs:91），无会话级配置。
- G8（低）：D8 nudge 通道（PendingNudgeChannel）实现但生产未接线（background.rs:643 留痕）。

---

## 2. 现状事实（证据）

### 2.1 run 主循环与跨 run 生命周期

- `AgentSessionLoop::run`：每 run 新建状态机（idle → … → done），对话与输入队列跨 run 持久——loop/mod.rs:335-337、642-646。
- 生产路径每 run 重建 `AgentSessionLoop`（SessionLoopProducer::produce，engine.rs:2409-2445），对话经 `with_initial_conversation_arc` 从缓存/前端历史水合（loop/mod.rs:553-560）。
- 单 run 内多轮：`while !done` 按状态分派（loop/mod.rs:713-729）；工具调用后 `toolCallCount > 0` → NEXT_TURN 续轮（turn_complete.rs:175-177）；followUp 环在 turn-complete 时 promote → INPUT_AVAILABLE → 同一 run 内继续新一轮（turn_complete.rs:183-187，轮次计数归零语义见 state.rs:91-95）。
- 纯文字回复（无 tool-call）：NO_TOOL_CALLS → turn-complete → 默认 SHOULD_STOP → stop 收场（no_tool_calls.rs:60-63、turn_complete.rs:189-191）——run 结束，**任务是否完成系统不判定**。

### 2.2 provider 网络错误恢复阶梯（Q1）

- **分类入口**：RateLimit / ServerError / Timeout / Network → 瞬态重试；ContextLengthExceeded → length 阶梯；PayloadTooLarge → 压缩阶梯；其余（Auth / Quota / InvalidRequest / Unknown 等）→ 直接 fatal——stream_error.rs:62-77。
- **瞬态重试**：上限默认 3（`SessionLoopOptions::transient_retry_limit`，loop/mod.rs:281），计数每 run 起始归零（loop/mod.rs:672）；每次重试 = 计数 +1 → 发 provider-diagnostic 事件 → 派发 NO_PROGRESS_CONTINUE 重进 provider 循环（stream_error.rs:81-95）。**重试之间没有任何 sleep/退避**——规范 01 §2.5 的「指数 sleep 600ms×retry」（01-session-loop-semantics.md:138）未落地；`retry_after_ms` 在 agent-provider 侧已解析（agent-provider/src/consume/mod.rs:370）但 session-loop 从不消费（stream.rs 测试恒 None，stream.rs:421/510/536）。
- **length 阶梯**：max_tokens 翻倍 8192 → 16384 → 32768，上限 2 次（stream_error.rs:100-120；MAX_LENGTH_UPGRADES=2，stream_error.rs:44），用尽后接压缩阶梯（stream_error.rs:117-120）。
- **溢出压缩阶梯**：压缩对话（唯一前缀重写点，真实恢复）+ 重试一次，上限 1（stream_error.rs:142-205；MAX_OVERFLOW_COMPRESSION_RETRIES=1，stream_error.rs:38）；未配置预算/压缩策略时 PayloadTooLarge 直接 fatal（stream_error.rs:154-160）；无可丢内容（noop 压缩）不假恢复直接 fatal（stream_error.rs:174-177）。
- **耗尽收场**：fatal_provider_error → 记录 terminal_error → 发 runtime-error 事件（retryable 标志透传，stream_error.rs:261）→ 派发 PROVIDER_ERROR → 状态机 streaming → turn-complete（endReason=error，state.rs:317-320）→ turn_complete 收敛 FINISH + `EndDecision::error`（turn_complete.rs:56-65、stream_error.rs:263-268）。
- **run 结束后的消息**：converge 处 `mem::take` 移交 RunOutcome.messages（loop/mod.rs:876-913）；壳层收口 `to_history_messages` 全角色保真（user/assistant/tool/system）写入 SessionHistoryCache（core_run_commands.rs:916-941、2718）；用户再输入/新 run 时经 `resolve_history_source` 从缓存/前端水合续接（core_run_commands.rs:3615-3622）——**消息级续接成立**。
- 但：error 收场**不会**自动续 run（见 2.4）。

### 2.3 goal 模式（Q2）

- **GoalAudit 策略**：占位、恒返回空；`BeforeTurn` 相位无策略注册——steering/mod.rs:48-57。prepare_turn 虽有 AfterTools/BeforeTurn 两相位评估点（prepare_turn.rs:64-84），实际唯一活跃策略 RecoverySteeringStrategy 只注册 after-tools / empty-response（strategy.rs:93-95）。
- **max-turns**：`turnIndex >= maxTurns` → 发 runtime-error 观测事件（retryable=true，纯观测）+ MAX_TURNS_REACHED → endReason=max-turns（turn_complete.rs:117-154；独立预算 reason，非错误非中止，01 §1.5）。**无继续机制、无 synthesis nudge**（D8 裁决删除 run 内注入后为空）。
- **SHOULD_STOP 之后**：run 收场。壳层 drive_run_loop 收口处 `decide_idle_resume` 判定是否自动续 run（core_run_commands.rs:2861-2912）——续 run 条件为三源任一非空：PendingMessageQueue（跨 run steering 条目：子代理完成 / 定时器到期 / Cron 触发 / watchdog 兜底通知）、TimerRegistry 活跃、Cron enabled（core_run_commands.rs:2485-2490）；**硬性排除**：abort 信号、`reason != Stop`（Aborted / Stopped / Error / MaxTurns 全不续，core_run_commands.rs:2511-2515，注释明确「MaxTurns = 异常边界，保守不续」）、user_touched（用户消息到达）；空转护栏：连续 3 次续 run 无 AI 产出则停止（IDLE_RESUME_MAX_EMPTY_ROUNDS=3，core_run_commands.rs:2458、2561-2582）。
- **nudge**：D8 裁决 run 内不注入 nudge，`PendingNudgeChannel` 通道已实现（nudge.rs:166-276，drain_all / enqueue_into_input_queue）但**生产未接线**（background.rs:643「nudge 通道未接线——留痕待 T-AB-18」）；实际生效的跨 run 注入通道是壳层 PendingMessageQueue + L1 followUp/steer 环（如逃逸监视注入走 request_follow_up，core_run_commands.rs:650-654）。
- drive_run_loop 注释自认：「未来 goal 多轮模式在本循环续轮」（core_run_commands.rs:2701-2702）。
- **结论**：不存在「run 结束（stop / max-turns / 无 tool-call 主动结束）但任务未完成 → 系统自动让 agent 继续」的 goal 能力。最接近的是 idle_resume（系统事件驱动），不是目标驱动。

### 2.4 checkpoint / hydrate（Q3）

- checkpoint.rs 只是 system 提示词内容段（checkpoint.rs:16-21，声明「存在 checkpoint 时优先恢复」「由引擎采集只读不写」）；采集函数 `parse_checkpoint_marker` / `collect_checkpoint_from_messages` 已实现（safe_point.rs:212-278，倒序扫描、system 排除、工具输出参与、载荷损坏降级 Err），但**生产零调用**——全仓库仅 crates/orchestrator/tests/checkpoint.rs 测试引用；M5B「采集结果写入会话树叶子 payload」未接线。
- hydrate：消息级水合——HistoryMessage → AgentMessage 映射（hydrate.rs:36-46）；完成态过滤：仅 completed 或无 status 放行，**error 终态消息被跳过**（hydrate.rs:87-93）；尾部截断到最后一个 user 消息（hydrate.rs:294-299）。
- 引擎缓存路径：SessionHistoryCache 全角色保真（含 tool/system，core_run_commands.rs:907-915），但**内存态不落库**（core_run_commands.rs:662-670）；跨进程重启依赖前端 store 全量写（前端载荷经 hydrate_history 过滤 error 态）。
- **恢复粒度 = 消息列表**；状态机每 run 从 idle 重建（loop/mod.rs:642-646），不存在轮次/重试计数/steering 计数的持久化恢复。

### 2.5 主动停止 vs 网络中断（Q4）

- **L2 cooperative_stop**：不 abort，安全点推 SM 到 done，收场 reason=Stopped（独立 reason，D1 裁决——既不是错误也不是取消，end.rs:11-12、67-70；safe_point.rs:84-89；check_control 落点 handlers/mod.rs:834-843；streaming 安全点路径 streaming.rs:263-273）。stop 前未消费的 L1 消息默认入 steer 环，下一次 run 立即消费（handlers/mod.rs:838-839、safe_point.rs:180-187）。
- **L3 force_cancel / AbortSignal**：ABORT → aborted（safe_point.rs:79-83、126-131）；streaming / executing-tools 中先转 turn-complete 抢救已产出内容（state.rs:307-313、380-384），内容保留落盘。
- **网络中断耗尽**：error（见 2.2）。
- **语义区别**：stopped / aborted = 用户意志（可观测、不误判为错误）；error = 引擎判定不可恢复。**三者在 idle_resume 中一律不自动续 run**（仅 Stop 且三源非空才续，core_run_commands.rs:2511-2515）。区别体现在：用户停止后用户可随时再发消息继续（上下文在）；网络中断后同样可以手动继续（上下文在），但系统不会自动拉起。

---

## 3. 能力矩阵

| 能力 | 支持程度 | 证据 |
|---|---|---|
| 单 run 内多轮（工具链续轮） | 有 | loop/mod.rs:713-729；turn_complete.rs:175-177 |
| run 内 followUp/steer 注入续轮 | 有 | turn_complete.rs:183-187；handlers/mod.rs:844-855 |
| 瞬态 provider 错误重试（3 次/run） | 有 | stream_error.rs:81-95；loop/mod.rs:281 |
| 重试退避（指数 sleep / Retry-After） | 无 | stream_error.rs:81-95 无 sleep；规范 01 §2.5（01-session-loop-semantics.md:138） |
| length 超限恢复（max_tokens 翻倍 ×2） | 有 | stream_error.rs:100-120；no_tool_calls.rs:27-51 |
| 溢出压缩恢复（PayloadTooLarge / ContextLengthExceeded） | 有（需配置预算/策略） | stream_error.rs:142-205 |
| 错误耗尽收场语义 | 有（error，非静默，内容保留） | stream_error.rs:237-269；turn_complete.rs:56-65 |
| run 结束后消息保留 / 手动续接（消息级） | 有 | loop/mod.rs:900；core_run_commands.rs:2718、3615-3622 |
| error 收场后自动恢复 | 无 | core_run_commands.rs:2511-2515（Error 不续） |
| max-turns 后继续 | 无 | turn_complete.rs:117-154；core_run_commands.rs:2493-2494 |
| goal 目标跟踪 / 审计 | 无（占位恒空） | steering/mod.rs:48-57（GoalAudit 无实现） |
| 任务完成度判定（stop 时任务是否完成） | 无 | turn_complete.rs:189-191 直接 SHOULD_STOP |
| 系统事件驱动续 run（idle_resume：队列/定时器/Cron） | 有（部分） | core_run_commands.rs:2483-2593 |
| nudge 注入通道（D8） | 部分（实现未接线） | nudge.rs:166-276；background.rs:643 |
| checkpoint 采集 | 部分（实现未接线） | safe_point.rs:212-278；仅 orchestrator/tests/checkpoint.rs 调用 |
| 状态机级恢复（轮次/计数持久化） | 无 | 每 run 新建状态机（loop/mod.rs:642-646） |
| 消息级水合恢复 | 有 | hydrate.rs:36-46；core_run_commands.rs:3615-3622 |
| cooperative_stop 独立语义（非 abort） | 有 | end.rs:67-70；safe_point.rs:84-89；state.rs:615-644 测试锚定 |
| 用户停止 / 网络中断语义区分 | 有 | Stopped / Aborted / Error 三 reason 独立 |
| 空转护栏（防自动续 run 风暴） | 有 | core_run_commands.rs:2458、2561-2582 |

---

## 4. 缺口与风险

### G1（高）：瞬态重试无退避

- 证据：transient_retry 内计数后立即 NO_PROGRESS_CONTINUE（stream_error.rs:81-95），无 sleep；retry_after_ms 解析后不被消费（agent-provider/src/consume/mod.rs:370 vs session-loop 无引用）。
- 风险：网络抖动 / 限流场景下 3 次重试连发，等于在同一失败窗口内连续击打 provider；RateLimit 类错误重试必再被限流，3 次全浪费后 error 收场。与规范 01 §2.5 明确偏离。

### G2（高）：error / max-turns 收场后无自动恢复

- 证据：decide_idle_resume 硬性排除 `reason != Stop`（core_run_commands.rs:2511-2515），注释明确 MaxTurns 保守不续（:2493-2494）。
- 风险：网络中断 3 次重试耗尽 → error → agent 停止，任务悬挂直到用户手动再发消息；与用户诉求「provider 网络问题中断输出时能否通过系统调度继续」直接冲突。长任务的 max-turns 预算用尽（默认 64 轮）同样硬停。

### G3（高）：goal 模式缺失

- 证据：GoalAudit 占位恒空（steering/mod.rs:48-57）；before-turn 相位无策略注册（strategy.rs:93-95）；turn_complete 默认路径无条件 SHOULD_STOP（turn_complete.rs:189-191）；drive_run_loop 自认「未来 goal 多轮模式」（core_run_commands.rs:2701-2702）。
- 风险：「未主动停止 / 未用户停止 → 应能一直工作」的语义无法实现：纯文字回复（哪怕任务只做了一半）即收场；无「任务完成度」可观测信号，前端也无从判断该不该提示继续。

### G4（中）：checkpoint 采集生产未接线

- 证据：采集函数仅测试调用（safe_point.rs:212-278；crates/orchestrator/tests/checkpoint.rs）；提示词承诺「存在 checkpoint 时优先恢复」（checkpoint.rs:19）无引擎支撑。
- 风险：中断后恢复完全依赖消息水合，无「目标 / 已完成 / 下一步」结构化恢复；长任务中断后模型只能靠对话历史自我推断进度。

### G5（中）：恢复粒度 = 消息级，非状态机级

- 证据：每 run 新建状态机（loop/mod.rs:642-646）；恢复阶梯计数每 run 归零（loop/mod.rs:670-675）；无轮次/计数持久化。
- 风险：中断时进行中的工具批、steering 注入计数、length 升级状态全部丢失；流中断且未产出任何内容的那一轮（streaming.rs:116-129 空 builder 进重试阶梯）输出丢失，下轮需重跑。

### G6（中）：水合双路径语义不一致

- 证据：引擎缓存路径全角色保真含 error 态消息（core_run_commands.rs:907-915）；前端 store 路径经 hydrate_history 过滤 error 态（hydrate.rs:87-93「失败回合进上下文会污染后续模型判断」）。
- 风险：跨进程重启后若前端 store 为主源，网络中断轮的对话内容（含部分成果）从上下文中消失，模型「失忆」。

### G7（低-中）：max_turns 固定 64 且不可配

- 证据：MAX_TURNS_DEFAULT=64（core_run_commands.rs:91、3634），无会话级/任务级覆盖入口。
- 风险：长任务在 64 轮工具循环后强制停止，无续轮路径（G2 的 max-turns 分支）。

### G8（低）：D8 nudge 通道生产未接线

- 证据：PendingNudgeChannel 已实现（nudge.rs:166-276）但生产无调用方（background.rs:643 留痕待 T-AB-18）；当前生效的跨 run 注入是壳层 PendingMessageQueue + L1 环（core_run_commands.rs:650-654）。
- 注：empty-response / after-tools 的 steering 恢复注入（inject-message 直接 append system 消息进对话，steering/mod.rs:282-291；prepare_turn.rs:64-84）是规范设计的 run 内恢复路径（01 §3.2），不属于 D8 的 nudge 范畴，不视为缺口。

---

## 5. 建议：如何实现「run 结束后任务未完成可继续」与更强的网络中断恢复

按优先级排序，每项给出模块、机制、可配置项与护栏。

### P1（先做：直接对应 Q1/Q5 核心缺口）

#### P1-1 瞬态重试加退避（crates/session-loop/src/loop/handlers/stream_error.rs）

- 在 transient_retry 内、派发 NO_PROGRESS_CONTINUE 前插入退避：优先消费 `ClassifiedStreamError.retry_after_ms`（agent-provider 已解析，agent-provider/src/consume/mod.rs:370），缺省指数退避 600ms × attempt（对齐规范 01 §2.5，01-session-loop-semantics.md:138）。
- 配置面：SessionLoopOptions 增 `retry_backoff_base_ms: Option<u64>`（None = 现状无退避，向后兼容），并仿 META_KEY_SUMMARY_BACKOFF_MS 模式（summary_dispatch.rs:57-113）提供 session_meta 键（如 `provider_retry_backoff_ms`），壳层 run_task_impl 装配时读取。
- 护栏：每级决策前 abort 复查已存在（stream_error.rs:53-55、83-85）；退避上限（如 ≤ 10s）防长停。
- 验收：单测断言两次 provider 调用间隔 ≥ 退避值；Retry-After 存在时以其为准。

#### P1-2 error 收场后自动续 run（EndDecision + core_run_commands::decide_idle_resume）

- 数据面：EndDecision / RunOutcome 增加 `retryable: bool`（error 收场时取运行时错误分类——stream_error 的 classified.retryable 已带，stream_error.rs:261；或复用 drive_run_loop 已捕获的 runtime_error 事件 retryable 标志，core_run_commands.rs:2772-2774）。
- 机制：decide_idle_resume 放行 `reason == Error && retryable` 的续 run——经 PendingMessageQueue 入队系统条目（复用 C7 写入侧，orchestrator/task_events.rs）→ spawn_idle_resume_run 拉起新 run（core_run_commands.rs:2637-2671），注入文本如「上一轮 provider 中断（<错误>），继续任务」。
- 护栏（必须）：会话级连续 error 续 run 上限（如 3 次）+ 退避（复用 resume_empty_streak 计数器模式，core_run_commands.rs:2561-2582）+ 用户消息到达即取消（user_touched 已覆盖，:2517-2519）+ 非 retryable error（Auth / Quota / InvalidRequest）不续。
- 验收：模拟 3 次重试耗尽后系统自动拉起新 run 且上下文完整；第 4 次 error 后停止自动续。

#### P1-3 max-turns 后继续（turn_complete.rs + decide_idle_resume）

- 机制：max-turns 分支（turn_complete.rs:117-154）观测事件照发（retryable=true 已含），壳层判定 MaxTurns 可续（当前「保守不续」注释，core_run_commands.rs:2493-2494）；续 run 注入「预算用尽，聚焦收尾」nudge（经 PendingMessageQueue 或 PendingNudgeChannel 接线）。
- 护栏：max-turns 续 run 连续 N 次仍 max-turns → 停止（防无限续轮）；与 P1-2 共用空转/连续失败计数器。
- 验收：64 轮预算用尽后自动续 run 一次，nudge 生效；连续 max-turns 3 次后停止。

### P2（goal 模式：Q2 根因修复）

#### P2-1 任务完成度判定与 goal 跟踪（orchestrator 层 + steering）

- 目标状态：壳层会话上下文维护任务目标（任务书 / goal 元数据，落 session_meta），run 收口点（drive_run_loop）判定「任务完成？」——输入 = 本轮消息 + 目标 + 已完成步骤（结构化提取，可先复用 checkpoint 载荷的 target/summary/completed/next 字段形状，safe_point.rs:212-278）。
- 未完成且 reason==Stop（纯文字回复 / 无 tool-call 主动结束）→ 注入「任务未完成，继续」nudge 经 PendingMessageQueue 入队 → idle_resume 自动续 run（现成机制，core_run_commands.rs:2872-2911）。
- 策略面：实现 GoalAuditStrategy（新文件或 steering/strategy.rs 扩展）注册 BeforeTurn 相位（评估点已存在，prepare_turn.rs:64-84），产出 inject 动作（budget 由 SteeringCoordinator 单一计数源约束，steering/mod.rs:211-256）。
- 护栏：连续 N 次「未完成判定」仍无进展 → 转人工（runtime-intervention-required 事件照发 + stop 收场，复用 steering_evaluation.rs:68-75 模式）；空转护栏沿用（core_run_commands.rs:2458）。
- 验收：任务未完成场景下 stop 后自动续 run；模型反复无进展 3 次后转人工事件。

#### P2-2 checkpoint 接线（safe_point.rs + drive_run_loop）

- 采集：drive_run_loop 收口处调用 collect_checkpoint_from_messages（safe_point.rs:255-278），结果写入会话树叶子 payload（M5B 原定接线点，core_run_commands.rs:1516 会话树注册表注释）；载荷损坏 → 降级普通会话 + 通知（safe_point.rs:235-238 语义已有）。
- 恢复：resolve_history_source（core_run_commands.rs:3615-3622）把最新 checkpoint 作为首条 user 消息注入（「存在 checkpoint 时优先恢复」从提示词声明变为真实行为，checkpoint.rs:19）。
- 验收：带 checkpoint 标记的会话中断 → 新 run 首条消息为 checkpoint 摘要；损坏载荷 → 正常水合不阻断。

### P3（结构完善）

#### P3-1 水合双路径对齐（hydrate.rs + core_run_commands.rs）

- hydrate.rs:87-93 的 error 态过滤与缓存路径保真（core_run_commands.rs:907-915）统一：建议 error 态消息保留但带 metadata 标记（如 `{kind:"failed-turn"}`），由模型自行参考；或前端 store 路径与缓存同语义。
- 验收：error 收场轮的对话内容在重启后仍在水合序列中。

#### P3-2 PendingNudgeChannel 生产接线（T-AB-18 遗留）

- background.rs:643 留痕项落地：nudge 入队 → 下一 run 开始 drain_all 转用户消息（nudge.rs:230-232、264-275 已实现，只差调用点）；可与 P2-1 共用注入通道。

#### P3-3 max_turns 会话级可配

- MAX_TURNS_DEFAULT=64（core_run_commands.rs:91）改为 session_meta 键（如 `max_turns_per_run`），run_task_impl 装配时读取（仿 compaction_policy_for 模式，core_run_commands.rs:3580）；0 = 不限制（需同步处理 loop/mod.rs:652-668 的 max_turns=0 早退语义）。

### 优先级排序与依赖

P1-1（退避）→ P1-2（error 续 run）→ P1-3（max-turns 续 run）→ P2-1（goal 判定）→ P2-2（checkpoint 接线）→ P3-*。

- P1 三项直接决定「网络中断能否恢复」与「预算耗尽能否继续」——是用户诉求的第一响应。
- P2-1 是「任务未完成应能一直工作」的根因修复（goal 跟踪），依赖 P1-3 的续 run 通道（两者共享 idle_resume + PendingMessageQueue）。
- 护栏（空转 / 连续失败 / 用户取消）在每项落地时同步实现，防自动续 run 风暴；用户显式停止（stopped / aborted）永远不自动续——这条红线保持现状（core_run_commands.rs:2511-2515）。