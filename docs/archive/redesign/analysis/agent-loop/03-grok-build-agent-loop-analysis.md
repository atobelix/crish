# Grok-build Agent Loop 架构分析

> 本文通过实际阅读 `reference/grok-build`（Rust workspace）的 `xai-grok-shell`、`xai-grok-sampler`、`xai-chat-state` 三个 crate 的源码，提取其 agent loop 设计模式，并与 conex 现有 `packages/agent-core/src/session-loop/index.ts` 的状态机式实现做对比，给出可借鉴的系统性改进建议。
>
> 所有结论均附带具体文件路径与行号引用，便于复核。文中 "grok-build" 指代 `reference/grok-build` 项目；"conex" 指代 `c:\Software\conex` 当前实现。

---

## 1. Grok-build Agent Loop 架构概述

grok-build 的 agent loop 是一个**三层 Actor + 双层循环**的结构，核心设计原则：

1. **三层 Actor 分工，状态所有权单点化**
   - `SamplerActor`（`xai-grok-sampler/src/actor/mod.rs:27-145`）：纯传输层，spawn per-request tokio task，拥有 `JoinSet<RequestId>` 与 `active_requests`，不感知对话语义。
   - `ChatStateActor`（`xai-chat-state/src/actor/mod.rs:30-430`）：单线程 owns 全部对话状态（conversation / tokens / credentials / sampling_config），通过 `mpsc::UnboundedSender<ChatStateCommand>` 接收命令。所有读写都序列化到这个 actor 上，避免锁竞争。
   - `SessionActor`（`xai-grok-shell/src/session/acp_session_impl/turn.rs:140+`）：turn driver，编排 sampler 调用、工具执行、stop gate、compaction、hooks，但不直接持有对话状态——所有状态操作走 `chat_state_handle` 代理。

2. **双层循环：外层 turn 级，内层 step 级**
   - 外层 `handle_prompt` 的 `loop {}`（`turn.rs:842-900`）：每轮调 `process_conversation_turn_with_recovery` 一次，根据返回的 `TurnOutcome` 决定继续/终止，并跑 `run_stop_gate`。
   - 内层 `process_conversation_turn` 的 `loop {}`（`turn.rs:1990-2619`）：每轮一次 LLM 调用 + 一次工具批执行，是真正的 "sample → tool → sample → tool" agentic loop。
   - 这是 grok-build 避免单轮就结束的核心结构（详见 §3.1）。

3. **统一的消息与响应类型跨 provider**
   - `ConversationRequest` / `ConversationResponse`（`xai-grok-sampling-types/src/conversation.rs:775-815`）是跨 provider 的统一契约。
   - 三种后端 `ApiBackend::{ChatCompletions, Responses, Messages}`（`xai-grok-sampler/src/client.rs:1991-2008`）通过各自的 stream transform 折叠到同一响应类型。
   - `StopReason` 枚举（`conversation.rs:683-715`）归一化各 provider 的 finish_reason。

4. **错误恢复是分层的、显式的**
   - 传输层重试：`run_request_task` 内的 `RetryDecision` 枚举（`xai-grok-sampler/src/actor/request_task.rs:81-312`）—— `Retry / RetryWithBackoff / RetryWithImageStrip / RetryWithClientRebuild / EmitToSession / Fatal`。
   - 业务层恢复：`process_conversation_turn_with_recovery`（`turn.rs:1509-1647`）—— `CompletionRequirement` 不满足时按指数退避注入 recovery 消息重试。
   - Doom-loop 恢复：独立预算的 mid-stream abort + resample（`xai-grok-sampler/src/doom_loop.rs` + `request_task.rs:127-267`）。
   - 工具错误永不终止循环：编码为 `tool_result` 后 `ToolLoop::Continue`（`tool_calls.rs:355-401`）。

5. **Provider 配置单一来源**
   - `SamplerConfig`（`xai-grok-sampler/src/config.rs:48-134`）是 per-request 的单一配置对象，shell 在 `agent::config::resolve_model_to_sampling_config` 处组装，通过 `SamplerCommand::UpdateConfig` 或 `Submit` 的 override 传入 actor。
   - `extra_headers` / `query_params` / `env_http_headers` / `bearer_resolver` / `header_injector` 都是 `SamplerConfig` 的字段，sampler 不读 URL 推导 header。

---

## 2. 核心循环流程图（文字描述）

### 2.1 三层 Actor 与数据流

```
                          ┌─────────────────────────────────────────┐
   客户端 / ACP 请求 ───►  │ SessionActor (turn driver)              │
                          │   - handle_prompt (外层 loop)           │
                          │   - process_conversation_turn (内层)    │
                          │   - execute_tool_calls                  │
                          │   - run_stop_gate                       │
                          └──────────┬───────────────┬──────────────┘
                                     │               │
                  chat_state_handle  │               │ sampler_handle
                  (mpsc commands)    │               │ (submit_and_collect)
                                     ▼               ▼
                       ┌─────────────────────┐  ┌──────────────────────────┐
                       │ ChatStateActor      │  │ SamplerActor             │
                       │ - conversation[]    │  │  - JoinSet<RequestId>    │
                       │ - total_tokens      │  │  - active_requests       │
                       │ - sampling_config   │  │  - per-request task:     │
                       │ - credentials       │  │    run_request_task      │
                       │ - persistence       │  │    (retry loop + doom)   │
                       └─────────────────────┘  └──────────────────────────┘
                                                            │
                                                            ▼
                                                 ┌────────────────────────┐
                                                 │ SamplingClient         │
                                                 │  - conversation_stream │
                                                 │  - conversation_stream │
                                                 │    _responses          │
                                                 │  - conversation_stream │
                                                 │    _messages           │
                                                 └────────────────────────┘
                                                            │
                                                            ▼
                                              ChatCompletions / Responses / Messages
                                                    (OpenAI / xAI / Anthropic)
```

### 2.2 外层 loop（handle_prompt，turn.rs:842-900）

```
handle_prompt(prompt_id, prompt_blocks, ...)
  │
  ├─ push_user_message(user_chat)              // 落到 ChatStateActor
  ├─ dispatch_hook(UserPromptSubmit)
  │
  └─ loop {                                     // 外层 turn 级循环
       │
       ├─ round = process_conversation_turn_with_recovery(...)
       │         (内层 loop，见 §2.3)
       │
       ├─ if !matches!(round, Ok(Completed { .. })): break round
       │   // Cancelled / MaxTurnsReached / StationarityEnded / Err 都直接交出
       │
       ├─ if matches!(round, Ok(Completed { refusal: Some(_) })):
       │     auto_pause_goal_if_active; break round
       │
       ├─ if goal_active:
       │     decision = run_goal_round_end()
       │     if Continue(directive):
       │        inject_goal_continuation_message(directive)
       │        continue
       │
       └─ match run_stop_gate(prompt_id, stop_continuations_this_turn):
            ├─ AllowStop            => break round
            └─ KeepWorking { feedback } =>
                 stop_continuations_this_turn += 1
                 push_user_message(stop_hook_feedback(feedback))
                 // 不 break，继续外层 loop
     }
  │
  └─ emit TurnEnded / AfterTurn / dispatch StopFailure / log DoomLoopRecovery
```

### 2.3 内层 loop（process_conversation_turn，turn.rs:1990-2619）

```
process_conversation_turn(req_id, ...)
  │
  ├─ prepare_tool_definitions_timed()           // 含 MCP 等待
  ├─ initialize: loop_index, identical_tool_calls, turn_span_totals, ...
  │
  └─ loop {                                     // 内层 step 级循环
       │
       ├─ emit LoopStarted { loop_index }; loop_index += 1
       │
       ├─ Action Stationarity 检查:
       │   if identical_tool_calls.run_len >= hard_stop_threshold():
       │      return Ok(StationarityEnded { snapshot })
       │   if take_nudge():
       │      push_system_reminder(ACTION_STATIONARITY_NUDGE_TEMPLATE)
       │
       ├─ drain_pending_interjections / flush_pending_skill_reminders
       ├─ first_turn_memory_reminder / maybe_inject_mcp_reminder
       ├─ refresh_token_if_expired / check_auto_compact_needed
       │
       ├─ build_request via chat_state_handle.build_request(...)
       ├─ run_turn_via_sampler(request)         // 一次 LLM 调用
       │   │
       │   ├─ Ok(Response(r, latency)) => 继续
       │   ├─ Ok(CompactAndResubmit)   => continue  // 上下文压缩后重发
       │   ├─ Ok(RefreshAuthAndResubmit) =>
       │   │     sleep(auth_retry_schedule.next_delay()); continue
       │   └─ Err(error) => return Err(error)     // 终态失败上抛
       │
       ├─ record token usage / emit inference_done
       ├─ let tool_calls = response.tool_calls().to_vec()
       │
       ├─ if tool_calls.is_empty():              // ★ AI 自然停止
       │     if todo_gate_decision == Nudge && fires < cap:
       │        push_system_reminder(reminder); continue
       │     if drain_pending_interjections():
       │        continue
       │     snapshot = finalize_turn_bookkeeping(...)
       │     if drain_pending_interjections(): continue
       │     return Ok(Completed { snapshot, tools_called, structured_output, refusal })
       │
       ├─ if structured_output_tool:
       │     handle_structured_output_tool_call(...)
       │     Complete(validated) => return Ok(Completed { ... })
       │     Retry              => continue
       │     Proceed            => fallthrough
       │
       ├─ for tc in &tool_calls: turn_tools_called.push(tc.name)
       ├─ identical_tool_calls.observe(signature, ...)  // 检测重复
       │
       ├─ execute_tool_calls(tool_calls)         // 工具批执行
       │   │
       │   ├─ Ok(PermissionReject { .. }) => return Ok(Cancelled { ... })
       │   ├─ Ok(Cancelled)                => return Ok(Cancelled { ... })
       │   ├─ Ok(HookDenied { .. })        => {} // 非终态，deny reason 已入 conversation
       │   ├─ Ok(FollowupMessage(msg))     =>
       │   │     add_followup_message_as_user_turn(msg); continue
       │   └─ Ok(Continue) / Ok(NonExistingTool) / Ok(ToolParsingError) =>
       │        // 工具结果已作为 tool_result push，继续循环让模型自决策
       │
       ├─ if max_turns && next_turn > limit:
       │     return Ok(MaxTurnsReached { limit })
       │
       ├─ tool_turn_count += 1
       ├─ check_preflight_overflow => run_compact_only; continue
       │
       └─ // 自然回到 loop 顶部，开始下一轮 sample
     }
```

### 2.4 Sampler 内部 retry loop（run_request_task，request_task.rs:81-312）

```
run_request_task(request_id, request, config, retry_policy, ...)
  │
  ├─ max_retries = resolve_max_retries(config.max_retries)
  ├─ doom_policy = config.doom_loop_recovery
  │
  └─ loop {
       │
       ├─ if cancel_token.is_cancelled(): handle_cancellation; return
       │
       ├─ doom_check = doom_policy.filter(|_| doom_retry_count < doom_max_retries)
       ├─ outcome = run_one_attempt(...)  // 单次 HTTP 流式请求
       │
       ├─ match outcome:
       │   ├─ Completed { response, metrics } =>
       │   │     // doom-loop confident triggers 即使存在，预算用尽后也接受
       │   │     emit Completed; send_completion(Ok); return
       │   │
       │   ├─ Empty { context } =>
       │   │     err = SamplingError::EmptyResponse { context }
       │   │     apply_retry_decision(err, ...) // 空响应视为瞬时
       │   │
       │   ├─ Failed { error } =>
       │   │     if DoomLoopDetected:
       │   │        doom_retry_count += 1
       │   │        sleep(doom_loop_backoff); continue
       │   │     else:
       │   │        apply_retry_decision(error, ...)
       │   │
       │   ├─ Cancelled => handle_cancellation; return
       │   │
       │   └─ InitFailed { error } => apply_retry_decision(error, ...)
       │
       └─ apply_retry_decision 内根据 classify_error 返回:
          ├─ Retry { backoff }                  => sleep; continue
          ├─ RetryWithBackoff { backoff }       => sleep; continue
          ├─ RetryWithImageStrip                => strip_images; continue
          ├─ RetryWithClientRebuild { backoff } => 重建 HTTP/1.1 client; continue
          ├─ EmitToSession(err)                 => emit Failed; completion(Err); return
          └─ Fatal(err)                         => emit Failed; completion(Err); return
     }
```

---

## 3. 关键设计决策及代码引用

### 3.1 双层循环：把 "AI 自然停止" 与 "Agent 必须停止" 解耦

grok-build 把"模型这一 step 没有再调用工具"和"整个 agent turn 应该结束"分成两个独立的判定点：

- **内层 `process_conversation_turn` 在 `tool_calls.is_empty()` 时返回 `Ok(Completed)`**（`turn.rs:2397-2484`）。这只是"模型这一 step 选择停止"，不等于 turn 结束。
- **外层 `handle_prompt` loop 收到 `Completed` 后并不直接返回**，而是先跑 `run_stop_gate`（`turn.rs:889-899`）。stop gate 可以返回 `KeepWorking { feedback }`，把 hook 反馈作为合成 user message 推入对话，然后 `continue` 外层 loop —— 这相当于让 agent 在"自己以为完成"之后被外部 hook 强制继续工作。
- 同时外层还有 goal loop（`turn.rs:874-888`）：如果 goal 仍 Active，`run_goal_round_end` 可以返回 `Continue(directive)`，注入 goal 续轮指令后 `continue`。

这把"何时停止"从单一判断点（`toolCalls.length === 0`）扩展成了三段式：**模型停止 → completion requirement / goal / stop hook 各自可以否决 → 真正停止**。

代码引用：
- 内层终止：`crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs:2397-2484`
- 外层 stop gate：`crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs:889-899`
- Stop gate 实现：`crates/codegen/xai-grok-shell/src/session/acp_session_impl/stop_gate.rs:251-335`

### 3.2 CompletionRequirement：显式的"任务完成契约"与自动恢复

`AgentDefinition.completion_requirement`（`xai-grok-agent/src/config.rs`，引用见 `agent.rs:103-105`）允许声明"这个 agent 必须调用某个工具才算完成"。`process_conversation_turn_with_recovery`（`turn.rs:1509-1647`）就是它的执行器：

```rust
// turn.rs:1551-1575  简化
let mut result = self.process_conversation_turn(...).await;
if let Ok(Completed { ref tools_called, .. }) = result
    && tools_called.iter().any(|name| name == &required_tool)
{
    return result;  // 契约满足
}
// 否则进入恢复 loop
loop {
    attempt += 1;
    if attempt > recovery.max_retries {
        send AutoRecoveryExhausted; return result;
    }
    let delay_ms = min(base_delay_ms * 2^(attempt-1), max_delay_ms);
    sleep(delay).await;
    push_user_message(ConversationItem::auto_recovery(recovery_prompt));
    result = self.process_conversation_turn(...).await;
    if let Ok(Completed { ref tools_called, .. }) = result
        && tools_called.iter().any(|name| name == &required_tool)
    {
        return result;
    }
}
```

关键点：
- 恢复预算独立于 sampler 的传输层 retry 预算 —— 传输层只重试 HTTP 错误，这里重试的是"模型逻辑上没完成任务"。
- 恢复手段是注入 `ConversationItem::auto_recovery(recovery_prompt)` 作为合成 user message，让模型看到明确的补救指令。
- `MaxTurnsReached` 与 `StationarityEnded` 短路返回（`turn.rs:1559-1564`、`1626-1631`），不会被恢复 loop 覆盖。

### 3.3 Action Stationarity：识别"模型陷入循环"并分级处理

`IdenticalToolCallRun`（`turn.rs:2644-2683`）在每一步工具调用后 `observe` 一次签名（tool_name + arguments 的 hash），并区分两类：

- **非 true-noop 重复**：`NUDGE_AFTER_IDENTICAL_TOOL_CALLS = 8` 次后注入 nudge 提醒，`MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS = 16` 次后硬终止为 `StationarityEnded`。
- **true-noop 重复**（如 `bash "true"`）：阈值收紧到 `MAX_CONSECUTIVE_TRUE_NOOPS = 4`，因为这些调用毫无副作用，纯噪声。

`StationarityEnded` 是与 `Completed` 不同的 `TurnOutcome` 变体（`types.rs:68-71`），外层 loop、stop gate、recovery 都不会重新打开 sampling loop —— 这是显式的"不可恢复终止"。

代码引用：
- 阈值常量：`crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs:2622-2626`
- `IdenticalToolCallRun::observe`：`turn.rs:2653-2669`
- 内层 loop 中的检查与 nudge：`turn.rs:1993-2063`

### 3.4 工具执行：错误永不终止循环

`execute_tool_calls`（`tool_calls.rs:355-401`）的返回 `ToolLoop` 枚举（`types.rs:74-95`）明确区分"终态"与"非终态"：

| ToolLoop 变体 | 是否终态 | 处理 |
|---|---|---|
| `Continue` | 否 | 工具结果已入 conversation，内层 loop 继续 sample |
| `NonExistingTool` | 否 | 错误结果已 push 给模型，loop 继续 |
| `ToolParsingError` | 否 | parse 错误结果已 push，loop 继续 |
| `HookDenied` | 否 | deny reason 已 push，loop 继续 |
| `PermissionReject` | **是** | 返回 `TurnOutcome::Cancelled { category: PermissionRejected }` |
| `Cancelled` | **是** | 返回 `TurnOutcome::Cancelled { category: PermissionCancelled }` |
| `FollowupMessage(msg)` | **是**（重新进入） | 把 msg 作为新 user turn 入队，`continue` |

关键设计：**只有用户主动行为（拒绝/取消/插入新指令）能终止工具环**；工具自身的 `is_error`、parse 失败、hook deny 都被编码为 `tool_result` 喂回模型，由模型决定下一步。这与 conex 的 `findFatalToolError` 黑名单式终止形成鲜明对比。

代码引用：
- `execute_tool_calls` 主体：`crates/codegen/xai-grok-shell/src/session/acp_session_impl/tool_calls.rs:355-401`
- `prepare_tool_call` 的 parse 容错（含 concatenated-JSON 恢复）：`tool_calls.rs:973-1045`
- `ToolLoop` 枚举：`crates/codegen/xai-grok-shell/src/session/acp_session_impl/types.rs:74-95`

### 3.5 Provider 适配：统一类型 + 后端 dispatch

grok-build 不维护"多 provider adapter 列表"，而是用**一对统一类型 + 一个后端枚举**解决：

- `ConversationRequest` / `ConversationResponse`（`xai-grok-sampling-types/src/conversation.rs:775-815`）跨所有 provider。
- `ApiBackend::{ChatCompletions, Responses, Messages}`（`client.rs:1991-2008` 的 `conversation_collect` 内 match）决定走哪个 stream transform。
- 三个 transform（`stream/chat_completions.rs`、`stream/responses.rs`、`stream/messages.rs`）各自把 provider 原生 SSE 折叠到 `SamplingEvent` 流，最终 `collect_response` 聚合为 `ConversationResponse`。
- `StopReason`（`conversation.rs:683-715`）在类型层归一化 `FinishReason`：
  ```rust
  FinishReason::Stop        => StopReason::Stop,
  FinishReason::Length      => StopReason::Length,
  FinishReason::ToolCalls | FinishReason::FunctionCall => StopReason::ToolCalls,
  FinishReason::ContentFilter => StopReason::ContentFilter,
  ```
- `SamplerConfig`（`config.rs:48-134`）是 per-request 单一配置对象。`api_backend` 只控制协议形状；`auth_scheme` 单独选；URL-derived header 由 shell 在构造前注入 `extra_headers`，sampler 自身不读 URL。

这种设计的直接收益：增加新 provider 只需实现一个 stream transform + 在 `ApiBackend` 加一个变体，turn loop 完全无感知。

### 3.6 Sampler 传输层重试：分类驱动的 RetryDecision

`run_request_task`（`request_task.rs:81-312`）的重试不是简单的"失败 → 退避 → 重试"，而是先 `classify_error` 产出 `RetryDecision`（`request_task.rs:320-454`），不同决策有不同副作用：

- `RetryWithImageStrip`：先 `request.strip_images()`，没图可剥就升级为 Fatal。
- `RetryWithClientRebuild`：重建 HTTP/1.1 client 以逃离职化的 HTTP/2 连接池。
- `RetryWithBackoff`：标准退避。
- `EmitToSession`：错误上抛给 session 层（由 `handle_sampling_failure` 决定 CompactAndResubmit / RefreshAuthAndResubmit / 终态）。
- `Fatal`：真正耗尽预算或 server 说不重试。

并且有 `retry_only_before_output` 标志（`request_task.rs:158-163`）：一旦观察到 output token，瞬时错误不再重试，避免重复输出。这是对"流式重试导致内容重复"问题的系统性解法。

### 3.7 Doom-loop 检测：服务端信号 + 客户端预算

`DoomLoopSignalCollector`（`xai-grok-sampler/src/doom_loop.rs:24-124`）在 SSE 解码层吸收服务端 `response.doom_loop_check` 事件，按 `DoomLoopRecoveryPolicy.confident_triggers` 判断是否要 mid-stream abort。重试预算独立于传输层（`request_task.rs:127-133`）：

```rust
let doom_max_retries = doom_policy.map_or(0, |p| p.max_retries);
let mut doom_retry_count: u32 = 0;
```

预算用尽后 `disarm_abort`（`doom_loop.rs:48-52`），让最后一次 attempt 完成并被接受，避免无限重试。这与 conex 的 `maxRepeatedToolCalls` steering（pre-turn 评估）不同——grok-build 是 mid-stream 拦截，避免浪费已生成的 token。

### 3.8 状态管理：ChatStateActor 的单点所有权

`ChatStateActor`（`xai-chat-state/src/actor/mod.rs:30-430`）是 conex 没有的层级。所有对话状态（conversation / total_tokens / sampling_config / credentials / prompt_index / turn_capture / harness_trace）都由这个 actor 独占，外部通过 `ChatStateHandle` 发命令：

- `PushUserMessage` / `PushAssistantResponse` / `PushToolResult`：写入对话
- `BuildConversationRequest`：在 actor 内组装下一个 request（含 prune / memory inject / image compaction），见 `actor/request_builder.rs:37-149`
- `RecordTokenUsage` / `RecordLastTurnUsage` / `RecordModelCallUsage`：token 记账
- `ReplaceConversation` / `RestoreSnapshot` / `TruncateToPromptIndex`：rewind / fork / compaction
- `RepairHistory` / `RepairDanglingAfterHarnessHalt`：自愈

收益：turn driver 不持锁，所有状态操作天然序列化，compaction 与 turn 执行不会 race；`build_request` 在 actor 内做 prune（`should_prune` 在 `total_tokens > context_window / 2` 时触发，`request_builder.rs:159-161`），保证每次发出的 request 都已剪枝。

---

## 4. 与 conex 对比的差异点

### 4.1 "AI 返回文本但无工具调用" 的处理

| 维度 | grok-build | conex |
|---|---|---|
| 内层终止条件 | `tool_calls.is_empty()` 返回 `Completed`（`turn.rs:2397`） | `toolCalls.length === 0` 后 `dispatch('NO_TOOL_CALLS')`（`session-loop/index.ts:378`） |
| 终止后是否可被否决 | 是。外层跑 `run_stop_gate`，hook 可 `KeepWorking` 强制继续（`turn.rs:889-899`） | 否。`NO_TOOL_CALLS` → `turn-complete` → `SHOULD_STOP`，hook `shouldStopAfterTurn` 只能"建议停"不能"强制继续" |
| TodoGate | 有。`tool_calls.is_empty()` 时若 TodoGate 判定 `Nudge`，注入 reminder 后 `continue` 内层 loop（`turn.rs:2398-2451`） | 无等价机制。conex 在 `handleNoToolCalls` 里只有 `stopReason=length` 升级与 tool-promise nudge（`index.ts:476-515`），没有"todo 仍未完成 → 强制再轮"的能力 |

**结论**：conex 的 `toolCalls.length === 0` 是单向终止，grok-build 是"可被外部否决的终止"。这是 conex "单轮就结束"问题在架构层的根因之一。

### 4.2 工具调用失败后的恢复

| 维度 | grok-build | conex |
|---|---|---|
| 工具 `is_error` | 编码为 tool_result，`ToolLoop::Continue`，loop 继续（`tool_calls.rs:400`） | `findFatalToolError` 黑名单判定，命中即 `endReason='error'`（`index.ts:556`） |
| 工具 parse 错误 | `handle_tool_parse_error` push 错误结果，`ToolLoop::ToolParsingError`，loop 继续（`tool_calls.rs:1035-1044`） | 由 `tool-executor` 内部处理，loop 层不感知 parse 失败的语义 |
| Hook deny | 非终态，deny reason 入 conversation，loop 继续（`types.rs:91-94`） | conex 无 hook deny 概念 |
| 用户拒绝 | `PermissionReject` 返回 `Cancelled`（终态） | `approvalPipeline` 拒绝后行为分散在 tool-executor |
| 重复调用检测 | `IdenticalToolCallRun` 在内层 loop 内逐步检测，nudge + 硬终止两档（`turn.rs:1993-2063`） | `maxRepeatedToolCalls` 在 pre-turn steering 评估（`recovery/`），非 step 级 |

**结论**：grok-build 的"工具错误永不终止循环"是显式契约；conex 的 `findFatalToolError` 是补丁式黑名单，违反"系统化"原则。

### 4.3 避免单轮就结束

grok-build 的三道防线：
1. **TodoGate**（`turn.rs:2398-2451`）：模型停止但 todo 仍有 pending/in_progress 时强制再轮。
2. **Stop Hook Gate**（`stop_gate.rs:251-335`）：模型停止但外部 hook 认为不该停时强制再轮。
3. **CompletionRequirement + auto-recovery**（`turn.rs:1509-1647`）：模型停止但未调用必备工具时按指数退避重试。

conex 现状：三道防线均缺失。`shouldStopAfterTurn` hook 只能建议停，不能建议继续；`tool-promise nudge`（`index.ts:498-512`）只在"模型承诺调工具但未发 tool_call"时触发，覆盖面窄。

### 4.4 Provider 配置管理

| 维度 | grok-build | conex |
|---|---|---|
| 配置对象 | `SamplerConfig`（`config.rs:48-134`）单一 struct，含 api_key / base_url / api_backend / auth_scheme / extra_headers / query_params / env_http_headers / bearer_resolver / header_injector / context_window / doom_loop_recovery / ... | `AgentRuntimeOptions.provider`（`runtime-options.ts`）+ `providerGateway`（`runtime-components/provider-call-gateway.ts`），分散 |
| per-request override | `SamplerCommand::Submit { config: Option<Box<SamplerConfig>> }`（`actor/mod.rs:100-130`）支持每次调用覆盖 | 需重建 `AgentSessionLoop` 实例 |
| 多 provider 协议 | `ApiBackend` 枚举 + 三个 stream transform，统一 `ConversationResponse`（`client.rs:1991-2008`） | 每个 provider 各自的 streamFn，无统一响应类型 |
| StopReason 归一化 | 类型层 `StopReason` 枚举 + `From<FinishReason>`（`conversation.rs:706-715`） | `msg.metadata.stopReason` 字符串 |

**结论**：grok-build 的 `SamplerConfig` 是"单一来源 + 可覆盖"，conex 是"分散配置 + 重建实例"。

### 4.5 错误重试策略

| 维度 | grok-build | conex |
|---|---|---|
| 传输层重试 | `RetryDecision` 分类驱动，含 image strip / HTTP/1.1 rebuild / `retry_only_before_output`（`request_task.rs:320-454`） | `ProviderCallCoordinator.MAX_PROVIDER_TRANSIENT_RETRIES=3` + 600ms×n 退避（`index.ts:452-457`） |
| 空响应 | `EmptyResponse` 视为瞬时，重试（`request_task.rs:199-233`） | `ar.type === 'empty-response'` → `STEERING_NEEDED`（`index.ts:366`），走 steering 而非重试 |
| 上下文溢出 | `CompactAndResubmit`：压缩后 `continue` 内层 loop（`turn.rs:2195-2198`） | `compressionGate.maybeCompress` 在 `handlePrepareTurn` 内执行（`index.ts:250-262`），不在错误路径 |
| Auth 401 | `RefreshAuthAndResubmit`：刷新 token 后 `continue`（`sampler_turn.rs:916-956`） | 无独立 401 恢复路径，依赖 `isTransientProviderError` 判定 |
| Doom-loop | 服务端信号 + 客户端独立预算 + mid-stream abort（`doom_loop.rs`） | 无 |

### 4.6 状态管理

| 维度 | grok-build | conex |
|---|---|---|
| 状态所有权 | `ChatStateActor` 单点 owns（`actor/mod.rs:30-430`） | `ConversationEngine` + `ContextManager` + `ledger` + `recorder` 分散在 `AgentSessionLoop` 字段 |
| 状态操作序列化 | 天然序列化（mpsc 命令） | `sessionMutex` 单互斥锁 |
| Request 构建 | `BuildConversationRequest` 在 actor 内执行 prune / memory inject / image compaction（`request_builder.rs:37-149`） | `provider-call.ts` 内 `buildProviderCall`，prune 分散 |
| 历史修复 | `RepairHistory` / `RepairDanglingAfterHarnessHalt` 显式自愈命令（`actor/mod.rs:224-242`、`275-277`） | 无显式 repair 步骤 |

---

## 5. 可借鉴的模式和建议

### 5.1 必须借鉴（正确性问题）

#### A. 双层循环 + Stop Gate：把"模型停止"与"agent 停止"解耦

**问题**：conex `handleStreaming` 在 `toolCalls.length === 0` 时直接 `dispatch('NO_TOOL_CALLS')` → `turn-complete` → `SHOULD_STOP`（`session-loop/index.ts:378、513、641`）。这是 conex "AI 返回文本但无工具调用就单轮结束"的根因。当前唯一的"否决"是 `tool-promise nudge`，覆盖面窄且只能触发一次。

**借鉴**：grok-build 的外层 loop 在 `Completed` 后跑 `run_stop_gate`（`turn.rs:889-899`），hook 可以返回 `KeepWorking { feedback }` 强制注入合成 user message 并继续循环。

**系统化改进**：在 conex 状态机里把 `turn-complete` 的 `SHOULD_STOP` 转移改成可被 hook 否决：
1. 在 `handleTurnComplete`（`index.ts:571-643`）的 `SHOULD_STOP` 之前，新增一个 `stopGate` 评估点，调用 `lifecycleHooks.emit('stop.gate', ...)` 或复用 `composedHooks.shouldStopAfterTurn` 的反向语义。
2. 若 stop gate 返回 `keepWorking(reason)`，则注入合成 user message 并 `dispatch('NEXT_TURN')` 而非 `SHOULD_STOP`。
3. 加 `MAX_STOP_GATE_CONTINUATIONS_PER_TURN` 上限（grok-build 是 8，`stop_gate.rs:9`），避免无限续轮。

这比"补丁式"加 steering 策略更系统化：它把"何时停止"从单一判断点扩展为可扩展的 gate 链。

#### B. CompletionRequirement：显式任务完成契约 + 自动恢复

**问题**：conex 没有显式的"agent 必须完成什么才算结束"契约。`shouldStopAfterTurn` 只能返回 boolean，无法表达"必须调用某工具"或"必须产出某结构"。

**借鉴**：grok-build 的 `CompletionRequirement`（`xai-grok-agent/src/config.rs`）+ `process_conversation_turn_with_recovery`（`turn.rs:1509-1647`）。agent 定义里声明 `tool` 与 `reminder`，loop 在 `Completed` 后检查 `tools_called` 是否包含必备工具，不满足则按指数退避注入 recovery_prompt 重试。

**系统化改进**：在 conex 的 `AgentRuntimeOptions` 里加 `completionRequirement?: { tool: string; reminder: string; maxRetries: number; baseDelayMs: number; maxDelayMs: number }`，在 `handleTurnComplete` 的 stop gate 之前评估。这与 §5.1.A 的 stop gate 是互补的：stop gate 是"外部 hook 否决"，completion requirement 是"内部契约否决"。

#### C. 工具错误永不终止循环

**问题**：conex `findFatalToolError`（`session-loop/types.ts`，在 `index.ts:556` 调用）用黑名单判定"致命工具错误"，命中即 `endReason='error'` 终止整个 run。这是补丁式处理：黑名单需要手动维护，且工具错误本应由模型自决策。

**借鉴**：grok-build 的 `ToolLoop` 枚举（`types.rs:74-95`）显式区分终态（`PermissionReject`/`Cancelled`/`FollowupMessage`）与非终态（`Continue`/`NonExistingTool`/`ToolParsingError`/`HookDenied`）。只有用户主动行为能终止工具环；工具自身的 `is_error` 一律编码为 tool_result 喂回模型。

**系统化改进**：移除 `findFatalToolError` 的黑名单语义，改为：
- 工具 `execute` 抛异常 → 编码为 `isError=true` 的 toolResult，`TOOLS_COMPLETE` 继续下一轮。
- 仅当工具主动声明 `terminate`（类比 pi 的 `AgentToolResult.terminate`）时才终止 run。
- 保留 `PermissionReject` / 用户 cancel 的终态语义。

#### D. Action Stationarity：step 级重复调用检测

**问题**：conex 的 `maxRepeatedToolCalls` steering 在 pre-turn 评估（`recovery/`），无法检测内层 loop 内的"模型反复调同一个工具"。

**借鉴**：grok-build 的 `IdenticalToolCallRun`（`turn.rs:2644-2683`）在每一步工具调用后 `observe` 签名，nudge（8 次）+ 硬终止（16 次 / true-noop 4 次）两档。

**系统化改进**：在 conex 的 `ToolExecutionCoordinator`（`runtime-components/tool-executor.ts`）里加 `IdenticalToolCallRun` 等价物，在 `executeToolBatch` 返回前 observe。nudge 通过 `inputQueue.steer` 注入（已有路径），硬终止通过 `dispatch('ERROR')` + 新的 `endReason='stationarity'`。

### 5.2 可选借鉴（健壮性问题）

#### E. SamplerConfig 单一配置对象 + per-request override

**现状**：conex 的 provider 配置分散在 `AgentRuntimeOptions.provider`、`providerGateway`、`systemPrompt`、`promptContext` 等字段，per-request 覆盖需要重建 `AgentSessionLoop`。

**借鉴**：grok-build 的 `SamplerConfig`（`config.rs:48-134`）是单一 struct，`SamplerCommand::Submit` 接受 `Option<Box<SamplerConfig>>` 实现 per-request 覆盖（`actor/mod.rs:100-130`）。

**建议**：conex 可在 `ProviderCallGateway` 层引入 `SamplerConfig` 等价物，把 `provider`、`systemPrompt`、`maxTokens`、`thinkingIntensity` 等合并为单一对象，并支持 `providerCall` 的 per-call override。这是性能与可维护性优化，非正确性问题。

#### F. RetryDecision 分类驱动 + retry_only_before_output

**现状**：conex 的 `isTransientProviderError` 判定 + 600ms×n 退避（`index.ts:452-457`）是简化版，不区分错误类型，且流式输出后仍可能重试（导致内容重复）。

**借鉴**：grok-build 的 `RetryDecision` 枚举（`request_task.rs:320-454`）按错误类型分类：image strip / HTTP/1.1 rebuild / standard backoff / fatal。`retry_only_before_output` 标志（`request_task.rs:158-163`）在观察到 output token 后禁用重试。

**建议**：在 `ProviderCallCoordinator`（`session-loop/provider-call.ts`）里引入 `RetryDecision` 等价物，并把 `providerConsumer` 的 "已观察到 output" 信号反馈给重试决策。这是对流式重试内容重复问题的系统性解法。

#### G. EmptyResponse 重试而非 steering

**现状**：conex 对 `ar.type === 'empty-response'` 走 `STEERING_NEEDED`（`index.ts:366`），注入 steering 消息让模型重新生成。

**借鉴**：grok-build 把 `EmptyResponse` 视为瞬时错误，直接在 sampler 层重试（`request_task.rs:199-233`），不污染对话历史。

**建议**：conex 可在 `ProviderCallCoordinator` 内区分"空响应原因"——若是 `ReasoningOnly` 或 `NoVisibleContent` 且未观察到 output，走重试；若是模型主动停止，才走 steering。避免对话历史被空响应 nudge 污染。

#### H. ChatStateActor 式的状态单点所有权

**现状**：conex 的 `ConversationEngine` / `ContextManager` / `ledger` / `recorder` 分散在 `AgentSessionLoop` 字段，状态操作通过 `sessionMutex` 串行化，但 prune / compaction / request build 分散在多个文件。

**借鉴**：grok-build 的 `ChatStateActor`（`actor/mod.rs:30-430`）单点 owns 所有对话状态，`BuildConversationRequest` 在 actor 内执行 prune / memory inject / image compaction（`request_builder.rs:37-149`）。

**建议**：这是较大的架构调整，建议在 conex 的下一轮重构中评估。短期可先在 `ContextManager` 内补齐 `buildRequest` 的 prune 逻辑（grok-build 的 `should_prune` 在 `total_tokens > context_window / 2` 时触发，`request_builder.rs:159-161`），保证每次发出的 request 都已剪枝。

### 5.3 不建议借鉴

#### I. grok-build 的三层 Actor 模型

grok-build 用 tokio actor + mpsc channel 实现 ChatStateActor / SamplerActor，这对 Rust 的所有权模型是必要的（编译期避免数据竞争）。conex 是 TypeScript 单线程事件循环，强行引入 actor 模型会引入不必要的复杂度。conex 现有的 `sessionMutex` + `AsyncMutex` 已足够。

#### J. Doom-loop 服务端信号

grok-build 的 doom-loop 检测依赖 xAI 服务端的 `response.doom_loop_check` SSE 事件（`doom_loop.rs:12-15`），这是 xAI 私有协议。conex 作为多 provider 通用 agent，无法依赖此信号。§5.1.D 的 `IdenticalToolCallRun` 客户端检测已足够。

---

## 附录：关键文件索引

| 文件 | 作用 |
|---|---|
| `crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs` | 外层 + 内层 loop（`handle_prompt` / `process_conversation_turn` / `process_conversation_turn_with_recovery`） |
| `crates/codegen/xai-grok-shell/src/session/acp_session_impl/stop_gate.rs` | Stop hook gate（`run_stop_gate`） |
| `crates/codegen/xai-grok-shell/src/session/acp_session_impl/tool_calls.rs` | 工具执行（`execute_tool_calls` / `prepare_tool_call`） |
| `crates/codegen/xai-grok-shell/src/session/acp_session_impl/tool_dispatch.rs` | 工具分发（`dispatch_tool`） |
| `crates/codegen/xai-grok-shell/src/session/acp_session_impl/sampler_turn.rs` | Sampler 适配（`run_turn_via_sampler` / `handle_sampling_failure` / `call_with_auth_retry`） |
| `crates/codegen/xai-grok-shell/src/session/acp_session_impl/types.rs` | `TurnOutcome` / `ToolLoop` / `StopGateDecision` / `SamplerTurnOutcome` 枚举 |
| `crates/codegen/xai-grok-sampler/src/actor/mod.rs` | SamplerActor（per-request task spawn） |
| `crates/codegen/xai-grok-sampler/src/actor/request_task.rs` | 传输层 retry loop（`run_request_task` / `apply_retry_decision`） |
| `crates/codegen/xai-grok-sampler/src/doom_loop.rs` | Doom-loop 信号收集器 |
| `crates/codegen/xai-grok-sampler/src/client.rs` | 三后端 dispatch（`conversation_collect`） |
| `crates/codegen/xai-grok-sampler/src/config.rs` | `SamplerConfig` / `RetryPolicy` |
| `crates/codegen/xai-grok-sampling-types/src/conversation.rs` | `ConversationRequest` / `ConversationResponse` / `StopReason` |
| `crates/codegen/xai-chat-state/src/actor/mod.rs` | ChatStateActor（状态单点所有权） |
| `crates/codegen/xai-chat-state/src/actor/request_builder.rs` | `build_conversation_request`（prune / memory inject / image compaction） |
| `crates/codegen/xai-grok-agent/src/agent.rs` | `Agent` 结构体（`completion_requirement` / `hosted_tools` / `compaction_policy`） |
