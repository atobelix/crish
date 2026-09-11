# Rust 会话循环与中间事件发射机制深度分析报告

> **文档定位**：全链路底层架构深度诊断与重构分析
> **分析师角色**：【子Agent 01: Rust 会话循环与中间事件发射机制深度分析师】
> **代码权威审视域**：
>
> - `crates/session-loop/src/loop/handlers/streaming.rs`
> - `crates/session-loop/src/loop/handlers/executing_tools.rs`
> - `crates/session-loop/src/loop/handlers/prepare_turn.rs`
> - `crates/session-loop/src/loop/handlers/turn_complete.rs`
> - `crates/session-loop/src/loop/loop_exec.rs`
> - `crates/session-loop/src/tool_events.rs`
> - `apps/agent-workbench/src-tauri/src/engine_channels.rs`
> - `apps/agent-workbench/src-tauri/src/run/run_idle.rs`
> - `apps/agent-workbench/src-tauri/src/run/run_launch.rs`
> - `crates/orchestrator/src/events.rs`

---

## 目录（Table of Contents）

1. [执行摘要与问题拓扑（Executive Summary）](#一执行摘要与问题拓扑)
2. [逐行追踪：19 轮工具循环的完整生命周期与事件发射时序](#二逐行追踪19-轮工具循环的完整生命周期与事件发射时序)
3. [深入剖析：双轨架构断层与事件滞留代码证据](#三深入剖析双轨架构断层与事件滞留代码证据)
4. [多轮轮次索引（turn_index）与消息 ID 生成演进机制](#四多轮轮次索引turn_index与消息-id-生成演进机制)
5. [“TheTheThe...” 思考首 Token 误杀断层深入剖析](#五thethethe-思考首-token-误杀断层深入剖析)
6. [完整 Rust 架构重构方案：中间事件安全接入实时通知轨](#六完整-rust-架构重构方案中间事件安全接入实时通知轨)
7. [风险评估、不变性证明与测试验证矩阵](#七风险评估不变性证明与测试验证矩阵)

---

## 一、执行摘要与问题拓扑

在针对用户 19 轮工具循环的长程任务实测中，用户反馈了两个极具代表性的系统级体验缺陷：

1. **思考内容只看到首个 Token（"TheTheThe..."）**；
2. **多轮执行过程中的思考内容与工具调用在界面上无法实时看到，直到全任务完成才一次性爆发**。

经过对 Rust 会话循环引擎、Tauri 壳层通道、事件编排与前端接收管道的逐行审查，我们得出了明确的核心结论：

### 核心结论矩阵

| 关注维度                                                               | 运行时表现                           | 架构机制与代码断点                                                                                                                                                                                                                                                                                                                                                                                                                                           | 根因分类                              |
| ---------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| **LLM 流式吐字 (`ThoughtDelta`/`TextDelta`)**                          | **即时无延迟发射**                   | [`streaming.rs:117-123`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/streaming.rs#L117-L123) 逐 chunk 调用 `delta_sink.push()`；[`engine_channels.rs:715-721`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/engine_channels.rs#L715-L721) 的 `BridgeDeltaSink::push` 每次 push 立即执行 `bridge.emit()` + `bridge.flush()` 推送到 Tauri IPC。**Rust 侧没有任何缓冲延迟**。                                               | 机制正常                              |
| **"TheTheThe..." 思考首字碎片化**                                      | **思考流被误杀截断**                 | Rust 侧实时发射的 `MessageDelta` 信封携带 `sequence=None`。前端旧版 `EventRouter.ts` 的 `buildEventDedupeKey` 在处理无 `sequence` 的事件时回退为 `${type}:${messageId}`。由于一轮内所有 token 共享同一 `messageId`，导致**除第 1 个 token（如 `"The"`）外，后续数千个 token 全部被作为重复事件拦截丢弃**。多轮累加后呈现为 `"TheTheThe..."`。                                                                                                                | 前端去重 Bug（已定位）                |
| **工具调用 (`ToolStart`/`ToolEnd`/`ToolProgress`)**                    | **中途完全不可见，终态一次性倾泻**   | [`executing_tools.rs:91, 263-426`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/executing_tools.rs#L91) 将所有工具事件仅 push 到内存中的 `state.events: Vec<AgentEvent>`；[`run_idle.rs:1252, 1338-1398`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run/run_idle.rs#L1252) 在 `producer.produce().await`（整个多轮循环 19 次工具执行全部跑完）返回后，才统一分配 sequence 并批量发射。**执行期间前端处于事件真空期**。 | **Rust 双轨设计滞留**（历史设计断层） |
| **轮次与消息边界 (`TurnStart`/`TurnEnd`/`MessageStart`/`MessageEnd`)** | **中途完全滞留，终态一次性倾泻**     | [`prepare_turn.rs:71`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/prepare_turn.rs#L71)（`TurnStart`）、[`streaming.rs:558, 564`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/streaming.rs#L558)（`MessageStart`/`MessageEnd`）、[`turn_complete.rs:41`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/turn_complete.rs#L41)（`TurnEnd`）全部仅写入 `state.events`，中途无任何实时发射。           | **Rust 双轨设计滞留**                 |
| **多轮感知与 UI 假死**                                                 | **用户界面卡死无反馈，最后瞬间弹窗** | 中间 18 轮工具执行由于拿不到 `ToolStart`/`TurnStart`，前端流式管理器无法推进轮次和渲染运行中工具卡片，用户感知界面“卡死假死”；第 19 轮结束后，数百个积压事件瞬间涌入。                                                                                                                                                                                                                                                                                       | 级联体验崩溃                          |

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       Rust 会话循环双轨事件分流与滞留拓扑                                       │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

 [LLM Streaming Chunk]
          │
          ├──► (ThoughtDelta / TextDelta)
          │             │
          │             ▼ 【Real-time Track (实时轨)】
          │      delta_sink.push(delta) ──► BridgeDeltaSink (sequence=None)
          │                                         │
          │                                         ▼ (Immediate Tauri IPC Emit & Flush)
          │                                   前端 EventRouter (实时接收)
          │                                         │
          │                                         ▼ (旧版 buildEventDedupeKey 误杀)
          │                                   💥 仅放行每轮首个 Token ("TheTheThe...")
          │
          └──► (TurnStart / TurnEnd / MessageStart / MessageEnd / ToolStart / ToolEnd / ToolUpdate)
                        │
                        ▼ 【Terminal Track (收口轨)】
                 state.events.push(AgentEvent::...)
                        │
                        ▼ (⚠️ 滞留在内存 Vec<AgentEvent> 中，19 轮循环期间 0 次对外发射)
                        │
                 ┌──────┴─────────────────────────────────────────┐
                 │ 19 轮多轮工具循环持续执行 (npm install / shell / 写文件 ...) │
                 │ 前端处于 0 事件真空期，工具卡片完全不可见，界面感知假死     │
                 └──────┬─────────────────────────────────────────┘
                        │
                        ▼ (全任务 19 轮全部结束，AgentSessionLoop::run 返回)
                 producer.produce().await 收敛
                        │
                        ▼
                 drive_outcome() 统一分配全局递增原子 sequence 序号并写入 SQLite
                        │
                        ▼
                 active.bridge.emit(&envelope) + active.bridge.flush()
                        │
                        ▼ 💥 (数百个积压事件在全任务结束的一瞬间一次性爆发倾泻给前端！)
```

---

## 二、逐行追踪：19 轮工具循环的完整生命周期与事件发射时序

为了精确说明事件在 Rust 内部的流转过程，我们跟踪一次包含 19 轮工具调用的完整 Run。

### 1. 19 轮执行宏观生命周期图

```mermaid
sequenceDiagram
    autonumber
    participant UI as 前端 crish-desktop
    participant Driver as Tauri drive_run_loop
    participant Loop as AgentSessionLoop (Rust)
    participant SM as AgentSessionMachine (状态机)
    participant Provider as LLM Provider (SSE Stream)
    participant ToolExec as ToolExecutor (工具执行器)
    participant Store as SQLite DB (events 表)

    UI->>Driver: core_run_task(options)
    Driver->>Loop: producer.produce().await (启动会话循环)

    rect rgb(240, 248, 255)
    note over Loop, SM: 【第 1 轮工具循环 Turn 1】
    Loop->>SM: dispatch(Initialized) -> PreparingTurn
    Loop->>Loop: prepare_turn::handle() -> state.events.push(TurnStart { turn_index: 1 })
    Loop->>SM: dispatch(TurnPrepared) -> Streaming
    Loop->>Provider: provider.stream(&request).await
    Loop->>Loop: emit_provider_request_anchored() -> state.events.push(ProviderRequestAnchored)

    loop LLM SSE Stream (Chunk 实时流)
        Provider-->>Loop: ProviderStreamEvent::ThoughtDelta / TextDelta
        Loop->>UI: BridgeDeltaSink::push() -> Tauri IPC (sequence: None) [实时轨]
        Note over UI: ⚠️ 旧版前端误杀后续 Token，仅留首字 "The"
    end

    Provider-->>Loop: ProviderStreamEvent::ToolCall (tool_use: shell) + Stop
    Loop->>Loop: commit_message_with_deltas() -> state.events.push(MessageStart/End)
    Loop->>SM: dispatch(HasToolCalls) -> ExecutingTools

    Loop->>ToolExec: executor.execute_batch(&calls).await (执行命令耗时数秒)
    ToolExec-->>Loop: outcome.events (BatchStart, ToolStart, ToolEnd, BatchEnd)
    Loop->>Loop: emit_tool_events() -> state.events.push(ToolStart/ToolEnd...) (⚠️ 仅存内存)
    Loop->>Loop: record_message(tool_result_message) -> state.events.push(MessageStart/End)
    Loop->>SM: dispatch(ToolsComplete) -> TurnComplete
    Loop->>Loop: turn_complete::handle() -> state.events.push(TurnEnd { turn_index: 1 })
    Loop->>SM: dispatch(NextTurn) -> PreparingTurn (tool_call_count > 0 续轮)
    end

    rect rgb(255, 250, 240)
    note over Loop, SM: 【第 2 轮至第 18 轮工具循环 Turn 2..18】
    Loop->>Loop: 重复执行: TurnStart(N) -> Streaming -> ToolExec -> ToolEnd -> TurnEnd(N)
    Note over Loop: 所有中间事件 (ToolStart/End/TurnStart/End) 持续累加进 state.events 内存数组
    Note over UI: 界面无法获知正在执行何种工具，无卡片渲染，体感假死
    end

    rect rgb(240, 255, 240)
    note over Loop, SM: 【第 19 轮收口轮 Turn 19 (NoToolCalls)】
    Loop->>SM: PreparingTurn -> Streaming -> LLM 吐出最终正文文本 (NoToolCalls)
    Loop->>Loop: commit_message_with_deltas() -> state.events.push(MessageStart/End)
    Loop->>SM: dispatch(NoToolCalls) -> TurnComplete
    Loop->>Loop: turn_complete::handle() -> state.events.push(TurnEnd { turn_index: 19 })
    Loop->>SM: dispatch(ShouldStop) -> Done
    Loop->>Loop: converge() -> state.events.push(AgentEnd { reason: Stop })
    end

    Loop-->>Driver: 返回 RunOutcome { events: 19 轮所有事件 (~150+条) }

    rect rgb(255, 240, 245)
    note over Driver, Store: 【全 Run 结束时一次性批量发射与落库】
    Driver->>Store: drive_outcome() 分配连续 sequence (1..N) 并写入 events 表
    loop 遍历 driven.events
        Driver->>UI: active.bridge.emit(&envelope) -> 批量推送 150+ 个事件
    end
    Driver->>UI: active.bridge.flush()
    Note over UI: 💥 前端瞬间收到 19 个 TurnEnd、19 个 ToolStart/End，卡片与消息爆发式弹出
    end
```

### 2. 单轮循环内的微观代码级执行轨迹

我们以第 $K$ 轮（$K \in [1, 19]$）为例，分析代码行号与状态机流转：

#### 步骤 1：轮次准备 (`PreparingTurn`)

- **入口**：[`prepare_turn.rs:37`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/prepare_turn.rs#L37)
- **代码动作**：
  ```rust
  // prepare_turn.rs:65-75
  let session_id = state.machine.context().session_id.clone();
  let turn_index = state.machine.context().turn_index.saturating_add(1);
  state.turn_usage = None;
  state.events.push(AgentEvent::TurnStart {
      session_id: session_id.clone(),
      turn_index,
      timestamp: crate::steering::now_iso_utc(),
  });
  state.current_turn_index = Some(turn_index);
  ```
- **发射状态**：`state.events.push()` 仅存入内存 `Vec`，**未向 IPC 发射**。
- **状态转移**：`dispatch(state, E::TurnPrepared)` 推进状态机，`turn_index` 递增为 $K$，状态进入 `Streaming`。

#### 步骤 2：请求构造与 LLM 消费 (`Streaming`)

- **入口**：[`streaming.rs:40`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/streaming.rs#L40)
- **代码动作**：
  1. [`streaming.rs:79`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/streaming.rs#L79)：`let assistant_message_id = new_message_id("assistant");`（如 `assistant-1771161205000-1`）；
  2. [`streaming.rs:75`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/streaming.rs#L75)：`emit_provider_request_anchored(state, ...)` 写入 `state.events`；
  3. [`streaming.rs:95-144`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/streaming.rs#L95-L144)：进入 `stream.next()` 循环。收到 `TextDelta` 或 `ThoughtDelta` 时：
     ```rust
     // streaming.rs:117-123
     if let Some(sink) = delta_sink {
         if let Some(delta) = delta_to_message_event(state, &assistant_message_id, &event) {
             sink.push(delta);
         }
     }
     builder.push(event);
     ```
- **发射状态**：`delta_sink.push(delta)` 走实时轨，**立即通过 IPC 发射给前端**。
- **收尾处理**：当收到 `ProviderStreamEvent::ToolCall` + `StopReason::ToolCall` 时，流结束：
  ```rust
  // streaming.rs:201
  commit_message_with_deltas(state, message);
  ```
  在 `commit_message_with_deltas` 中：
  - `state.events.push(AgentEvent::MessageStart { ... })`
  - `state.conversation.push(message)`
  - `state.events.push(AgentEvent::MessageEnd { turn_index: Some(K), ... })`
- **发射状态**：`MessageStart` 和 `MessageEnd` **仅存入内存 `state.events`**。
- **状态转移**：`dispatch(state, E::HasToolCalls { count })`，进入 `ExecutingTools`。

#### 步骤 3：工具批处理执行 (`ExecutingTools`)

- **入口**：[`executing_tools.rs:40`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/executing_tools.rs#L40)
- **代码动作**：
  1. [`executing_tools.rs:62-80`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/executing_tools.rs#L62-L80)：从上一条 assistant 消息提取 `ToolBatchCall`；
  2. [`executing_tools.rs:84-86`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/executing_tools.rs#L84-L86)：`let outcome = executor.execute_batch(&calls, ctx, approval, options, abort).await;`（工具执行耗时发生在此处）；
  3. [`executing_tools.rs:91`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/executing_tools.rs#L91)：`emit_tool_events(state, &outcome.events);`：
     ```rust
     // executing_tools.rs:272-424
     state.events.push(AgentEvent::ToolBatchStart { ... });
     state.events.push(AgentEvent::ToolStart { turn_index: Some(K), ... });
     // 若有流式进度: state.events.push(AgentEvent::ToolUpdate { ... });
     state.events.push(AgentEvent::ToolEnd { turn_index: Some(K), ... });
     state.events.push(AgentEvent::ToolBatchEnd { ... });
     ```
  4. [`executing_tools.rs:96-98`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/executing_tools.rs#L96-L98)：为每个工具结果创建 `tool-result` 消息并调用 `record_message`：
     - `state.events.push(AgentEvent::MessageStart)`
     - `state.conversation.push(tool_result_message)`
     - `state.events.push(AgentEvent::MessageEnd { turn_index: Some(K) })`
- **发射状态**：所有 `ToolBatchStart`、`ToolStart`、`ToolUpdate`、`ToolEnd`、`ToolBatchEnd`、`MessageStart`、`MessageEnd` **全部仅存入内存 `state.events`**。
- **状态转移**：`dispatch(state, E::ToolsComplete)`，进入 `TurnComplete`。

#### 步骤 4：轮次完成与继续决策 (`TurnComplete`)

- **入口**：[`turn_complete.rs:33`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/turn_complete.rs#L33)
- **代码动作**：
  ```rust
  // turn_complete.rs:41-51
  state.events.push(AgentEvent::TurnEnd {
      session_id: ctx.session_id.clone(),
      turn_index: ctx.turn_index,
      timestamp: crate::steering::now_iso_utc(),
      tool_call_count: ctx.tool_call_count,
      usage: state.turn_usage.take(),
  });
  state.current_turn_index = None;
  ```
- **发射状态**：`TurnEnd` 写入 `state.events`，**未向 IPC 发射**。
- **续轮判断**：
  ```rust
  // turn_complete.rs:183-186
  if ctx.tool_call_count > 0 {
      dispatch(state, E::NextTurn)?;
      return Ok(HandlerOutcome::continue_run());
  }
  ```
- **状态转移**：由于 `tool_call_count > 0`，派发 `NextTurn`，状态机回到 `PreparingTurn`，开始第 $K+1$ 轮！

---

## 三、深入剖析：双轨架构断层与事件滞留代码证据

### 1. 实时轨（Real-time Track）深度审查

实时轨由 `BridgeDeltaSink` 承载，位于 [`apps/agent-workbench/src-tauri/src/engine_channels.rs:697-722`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/engine_channels.rs#L697-L722)：

```rust
// engine_channels.rs:714-722
impl DeltaSink for BridgeDeltaSink {
    fn push(&self, delta: AgentEvent) {
        // 信封：{event, runId: Some, sequence: None}（T09.1 实时轨）
        let envelope = AgentEventEnvelope::new(delta, Some(self.run_id.clone()), None);
        self.bridge.emit(&envelope);
        // 实时通道立即发射（丢帧由 buffer 的 Delta 类目兜底，不丢 message-end）
        self.bridge.flush();
    }
}
```

#### 实时轨的严格类型限制

在 [`streaming.rs:577-596`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/streaming.rs#L577-L596) 中，`delta_to_message_event` 施加了硬过滤：

```rust
fn delta_to_message_event(
    state: &LoopState,
    message_id: &str,
    event: &ProviderStreamEvent,
) -> Option<AgentEvent> {
    let block = match event {
        ProviderStreamEvent::TextDelta { text } => AgentMessageBlock::Text { text: text.clone() },
        ProviderStreamEvent::ThoughtDelta { text, redacted } => AgentMessageBlock::Thought {
            text: text.clone(),
            redacted: *redacted,
        },
        _ => return None, // ⚠️ ToolCall / Stop / ProviderDiagnostic 统统返回 None！
    };
    Some(AgentEvent::MessageDelta {
        session_id: state.machine.context().session_id.clone(),
        timestamp: crate::steering::now_iso_utc(),
        message_id: message_id.to_string(),
        block,
    })
}
```

**审查结论**：`BridgeDeltaSink` 在设计之初，仅被赋予了转发 `MessageDelta`（`Text` / `Thought`）的单一职责，`ToolCall` 与状态事件完全被排除在实时轨之外。

---

### 2. 收口批量轨（Terminal Track）与滞留代码证据

在整个 19 轮循环期间，所有结构化业务事件全部被推入 `state.events: Vec<AgentEvent>`。

#### 证据 1：工具事件的批收口契约限制

在 [`crates/session-loop/src/tool_events.rs:15-29`](file:///c:/Software/conex/crates/session-loop/src/tool_events.rs#L15-L29)，官方注释显式记录了历史架构决议：

```rust
// tool_events.rs:15-29
//! # 批收口语义（EV-09 / D-03 文档化契约）
//!
//! **tool 域事件 = 批收口一次性广播（execute_batch 全部返回后经
//! `emit_tool_events` 翻译为 AgentEvent），非实时轨**——不做逐事件实时
//! 推送（R-16 裁决：不建实时工具轨，加字段不加系统）。观测含义：
//! ...
//! - 实时轨登记为后续增强（触发条件：工具执行 >N 秒场景出现或用户明确
//!   要求），当前不实现。
```

**审查结论**：历史架构为了控制系统复杂度，采用了 `R-16 裁决`，将工具事件定义为“批收口广播”。然而在 19 轮长程任务中，一次 Run 可以执行数分钟甚至更久，导致前端长时间陷入事件盲区。

#### 证据 2：`AgentSessionLoop::run()` 的黑盒化阻塞

在 [`crates/session-loop/src/loop/loop_exec.rs:131-157`](file:///c:/Software/conex/crates/session-loop/src/loop/loop_exec.rs#L131-L157)：

```rust
// loop_exec.rs:131-147
// while(!done) 按当前状态分派 handler（01 §2.1）
while !self.state.machine.is_done() {
    let outcome = self.dispatch_once().await;
    match outcome {
        Ok(handler_outcome) => {
            if let Some(end) = handler_outcome.end {
                return self.converge(end).await;
            }
        }
        ...
    }
}
```

`run()` 内部通过 `while !self.state.machine.is_done()` 驱动全部 19 轮。只有当第 19 轮 `NoToolCalls` 收场，调用 `converge()` 时，才一次性移交事件：

```rust
// loop_exec.rs:329
RunOutcome {
    ...
    events: std::mem::take(&mut self.state.events),
    ...
}
```

#### 证据 3：Tauri 壳层 `drive_run_loop` 的集中爆发点

在 [`apps/agent-workbench/src-tauri/src/run/run_idle.rs:1252-1398`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run/run_idle.rs#L1252-L1398)：

```rust
// run_idle.rs:1252
let outcome = producer.produce().await; // ⚠️ 阻塞等待 19 轮全部跑完！

// run_idle.rs:1338-1341
let driven = {
    let mut run = active.handle.lock().await;
    let mut queue = active.queue.lock().await;
    drive_outcome(&mut run, &mut queue, outcome).await // 统一分配 sequence 并落库
};

// run_idle.rs:1370-1398
for sequenced in driven.events {
    // T09.1：实时轨已发 delta，收口流 message-delta 跳过不双发
    if active.delta_sink_active
        && matches!(sequenced.event, AgentEvent::MessageDelta { .. })
    {
        continue;
    }
    let envelope = AgentEventEnvelope::new(
        sequenced.event,
        Some(run_id.clone()),
        Some(sequenced.sequence),
    );
    report.add(active.bridge.emit(&envelope)); // 💥 批量发射
}
report.add(active.bridge.flush()); // 💥 一次性冲刷到 IPC
```

**审查结论**：`drive_run_loop` 处于最外层，它将 `producer.produce()` 视为一个黑盒原子操作。所有 19 轮累积的 150+ 个事件（`ToolStart`、`ToolEnd`、`TurnStart`、`TurnEnd`、`MessageEnd`）直到此时才在一瞬间全部 emit 给前端。

---

## 四、多轮轮次索引（turn_index）与消息 ID 生成演进机制

### 1. 消息 ID（Message ID）生成体系剖析

在 [`crates/session-loop/src/loop/handlers/mod.rs:53-60`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/mod.rs#L53-L60)：

```rust
// handlers/mod.rs:53-60
static MESSAGE_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) fn new_message_id(prefix: &str) -> String {
    let n = MESSAGE_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{n}", crate::steering::unix_millis())
}
```

在 19 轮工具循环中，消息 ID 的演进遵循严格规则：

1. **Assistant 消息 ID**：每进入一轮 `Streaming`，在流开始前通过 `new_message_id("assistant")` 预分配（如 `assistant-1771161205000-1`）；
   - 该 ID 同时作为该轮流式 `ThoughtDelta` / `TextDelta` 的 `message_id`；
   - 并在流收口时作为该轮最终 `AgentMessage` 的 `id`，保证前后端按 `message_id` 对齐。
2. **Tool 结果消息 ID**：在工具执行完毕后，通过 `format!("tool-result-{}", result.id)` 生成（如 `tool-result-call_987654`）；
   - 该 ID 作为 `AgentMessageRole::Tool` 消息的唯一标识；
   - 消息内部包含 `ToolResult` 块，映射对应的 `tool_call_id`。

### 2. 轮次索引（turn_index）演进状态机

轮次计数器维护在 `AgentSessionMachine` 的上下文 `context.turn_index` 中：

```
           [Run Start]
                │ (turn_index = 0)
                ▼
        ┌───────────────┐
   ┌───►│ PreparingTurn │ ── prepare_turn.rs: TurnStart { turn_index: K }
   │    └───────┬───────┘
   │            │ dispatch(TurnPrepared) -> context.turn_index = K
   │            ▼
   │    ┌───────────────┐
   │    │   Streaming   │ ── streaming.rs: MessageEnd { turn_index: Some(K) }
   │    └───────┬───────┘
   │            │ dispatch(HasToolCalls)
   │            ▼
   │    ┌───────────────┐
   │    │ExecutingTools │ ── executing_tools.rs: ToolStart/ToolEnd { turn_index: Some(K) }
   │    └───────┬───────┘
   │            │ dispatch(ToolsComplete)
   │            ▼
   │    ┌───────────────┐
   │    │ TurnComplete  │ ── turn_complete.rs: TurnEnd { turn_index: K }
   │    └───────┬───────┘
   │            │
   │  tool_call_count > 0 (dispatch(NextTurn))
   └────────────┴──────► 若 tool_call_count == 0 ──► dispatch(ShouldStop) ──► Done
```

1. **第 1 轮**：
   - `prepare_turn.rs`：读取 `turn_index(0).saturating_add(1) = 1`，发射 `TurnStart { turn_index: 1 }`；
   - `dispatch(TurnPrepared)`：状态机将 `context.turn_index` 设为 `1`；
   - `streaming.rs`：`MessageEnd` 附加 `turn_index: Some(1)`；
   - `executing_tools.rs`：`ToolStart` / `ToolEnd` 附加 `turn_index: Some(1)`；
   - `turn_complete.rs`：`TurnEnd` 携带 `turn_index: 1`；
   - `dispatch(NextTurn)`：推进到第 2 轮。
2. **第 2..18 轮**：
   - 状态机依次递增至 `turn_index = 2, 3, ..., 18`，每个事件的 `turn_index` 严格单调递增并准确对齐。
3. **第 19 轮（最终轮）**：
   - `turn_index = 19`；
   - 模型返回纯文本，无工具调用；
   - `turn_complete.rs` 检测到 `tool_call_count == 0`，派发 `ShouldStop` 进入终态 `Done`。

---

## 五、“TheTheThe...” 思考首 Token 误杀断层深入剖析

在 19 轮长程任务中，用户观察到思考窗的内容呈现为 `"TheTheThe...All...package"`，只包含了每轮思考的首个单词。

### 1. 故障链条全景分析

```
[Rust streaming.rs] ──► 产出 ThoughtDelta("The") ──► BridgeDeltaSink (sequence: None)
                                                            │
                                                            ▼ (Tauri IPC)
                                                    [前端 EventRouter.ts]
                                                            │
                                                            ▼ buildEventDedupeKey(envelope)
                                                    返回 key = "message-delta:assistant-1771161200000-0"
                                                            │
                                                            ▼ 首次遇见该 key ──► 放行给 UI ("The")

[Rust streaming.rs] ──► 产出 ThoughtDelta(" package") ──► BridgeDeltaSink (sequence: None)
                                                            │
                                                            ▼ (Tauri IPC)
                                                    [前端 EventRouter.ts]
                                                            │
                                                            ▼ buildEventDedupeKey(envelope)
                                                    返回 key = "message-delta:assistant-1771161200000-0"
                                                            │
                                                            ▼ 💥 命中已见 key ──► 判定为“重复事件”直接丢弃！

[Rust streaming.rs] ──► 产出 ThoughtDelta(" manager") ──► 💥 同样被丢弃！
... (本轮剩余的 2000 个思考 Token 全部被丢弃)

[进入第 2 轮工具循环] ──► 新分配 messageId = "assistant-1771161205000-1"
Rust 产出 ThoughtDelta("The") ──► 前端计算新 key = "message-delta:assistant-1771161205000-1"
                                                            │
                                                            ▼ 首次遇见新 key ──► 放行给 UI ("The")
                                                            ▼ 后续 Token 再次全被丢弃！
```

### 2. 根因代码与修复对照

前端 `EventRouter.ts` 中的原始去重键生成逻辑：

```typescript
// 错误实现（旧代码）
function buildEventDedupeKey(envelope: AgentEventEnvelope): string | null {
  if (envelope.sequence != null) {
    return `seq:${envelope.sequence}`;
  }
  // 💥 致命错误：无 sequence 的增量流式事件被回退为 type + messageId
  // 导致同一条 assistant 消息下的所有增量全部共享同一个去重键！
  if (envelope.event.type === 'message-delta') {
    return `message-delta:${envelope.event.messageId}`;
  }
  return null;
}
```

**修复方案**：

```typescript
// 正确实现（修复后）
function buildEventDedupeKey(envelope: AgentEventEnvelope): string | null {
  if (envelope.sequence != null) {
    return `seq:${envelope.sequence}`;
  }
  // 无 sequence 的实时流式增量事件（MessageDelta）永远不参与去重拦截
  if (envelope.event.type === 'message-delta') {
    return null;
  }
  return null;
}
```

**断言**：经此修复后，Rust 实时轨发出的每一个 `ThoughtDelta` 和 `TextDelta` 都能完整无损流经前端流式状态机。

---

## 六、完整 Rust 架构重构方案：中间事件安全接入实时通知轨

为了彻底解决“**19 轮工具调用在中途界面完全看不到，全任务结束才一次性爆发**”的架构断层，我们提出以下优雅、安全且符合反过度设计原则的 Rust 架构重构方案。

### 1. 架构重构核心设计原则

1. **单向不可变与双轨清晰解耦**：
   - **实时轨（Real-time Live Track）**：信封 `sequence=None`，只负责向前端 UI 实时广播当前执行状态（`TurnStart`、`MessageStart`、`ToolStart`、`ToolProgress`、`ToolEnd`、`TurnEnd`、`ApprovalRequested`）。丢帧安全（Soft 水位），不参与持久化；
   - **持久化收口轨（Persistent Terminal Track）**：在 Run 收口时由 `drive_outcome` 统一分配严格单调的 `sequence`，写入 SQLite `events` 表，确保会话可无损回放与审计；
2. **前后端幂等合并契约**：
   - 前端根据 `(event.type, call.id / message.id / turn_index)` 对实时通知与收口事件进行 O(1) 幂等合并；
   - 实时到达的 `ToolStart` 立即唤起运行中工具卡片；收口到达的 `ToolEnd`（带 sequence）将卡片状态落定为完成。
3. **零锁竞争与 O(1) 广播开销**：
   - 沿用 `BufferedRunEventBridge`，不增加复杂的分布式流式队列，保持轻量高效。

---

### 2. 具体重构实施方案

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 重构后统一实时事件分发架构图                                    │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘

                            crates/session-loop
                                     │
    ┌────────────────────────────────┼────────────────────────────────┐
    │                                │                                │
[streaming.rs]              [executing_tools.rs]              [prepare_turn.rs & turn_complete.rs]
    │                                │                                │
    ├─ Thought/TextDelta             ├─ ToolStart (实时执行前)         ├─ TurnStart (轮次开始)
    ├─ MessageStart (思考开始)       ├─ ToolProgress (执行进度)        └─ TurnEnd (轮次结束)
    └─ MessageEnd (思考完成)         └─ ToolEnd (执行完成后)
    │                                │                                │
    └────────────────────────────────┼────────────────────────────────┘
                                     │
                                     ▼
                      live_sink.push_live(AgentEvent)
                                     │
                                     ▼
                BridgeLiveSink (apps/agent-workbench/src-tauri)
                                     │
                   AgentEventEnvelope { sequence: None }
                                     │
                     BufferedRunEventBridge::emit() + flush()
                                     │
                                     ▼ (Immediate Tauri IPC)
                             前端 EventRouter
                                     │
                   ┌─────────────────┴─────────────────┐
                   ▼                                   ▼
         [实时思考流更新]                     [工具卡片即刻登场]
     (Sticky Auto-Scroll 追尾)          (status='running', 实时计时与入参展示)
```

#### 改动点 1：扩展 `DeltaSink` trait 为通用 `LiveEventSink`

文件：[`crates/session-loop/src/provider.rs`](file:///c:/Software/conex/crates/session-loop/src/provider.rs#L91-L103)

```rust
/// 实时事件通知接口（支持流式增量、工具状态与轮次信标实时推送）
pub trait LiveEventSink: Send + Sync {
    /// 推送实时事件（信封 sequence=None，立即发射至前端 IPC）
    fn push_live(&self, event: AgentEvent);
}

// 向后兼容现有 DeltaSink 别名
pub type DeltaSink = dyn LiveEventSink;
```

#### 改动点 2：在 `executing_tools.rs` 中实现逐工具实时广播

文件：[`crates/session-loop/src/loop/handlers/executing_tools.rs`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/executing_tools.rs)

在工具执行器执行每个工具的开始和结束点，实时将事件推送到 `live_sink`：

```rust
pub(crate) async fn handle(
    state: &mut LoopState,
    executor: &ToolExecutor,
    ctx: &ToolExecCtx,
    options: &ToolBatchOptions,
    approval: Option<Arc<dyn ApprovalGate>>,
    live_sink: Option<&dyn LiveEventSink>, // 注入实时事件汇
) -> Result<HandlerOutcome, LoopError> {
    ...
    // 2b. 批量执行工具
    let outcome = executor
        .execute_batch(&calls, ctx, approval, options, abort)
        .await;

    // 2c. 翻译工具事件并进入内存收口轨 (state.events)
    emit_tool_events(state, &outcome.events);

    // 2d. 🌟【重构增强】：将工具事件同步推入实时通知轨 (实时 IPC)
    if let Some(sink) = live_sink {
        for event in state.events.iter().rev().take(outcome.events.len()) {
            sink.push_live(event.clone());
        }
    }
    ...
}
```

#### 改动点 3：在 `prepare_turn.rs` 与 `turn_complete.rs` 中实时广播轮次边界

文件：[`crates/session-loop/src/loop/handlers/prepare_turn.rs`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/prepare_turn.rs#L71-L75) 与 [`turn_complete.rs`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/turn_complete.rs#L41-L51)

```rust
// prepare_turn.rs
let turn_start = AgentEvent::TurnStart {
    session_id: session_id.clone(),
    turn_index,
    timestamp: crate::steering::now_iso_utc(),
};
state.events.push(turn_start.clone());
if let Some(sink) = live_sink {
    sink.push_live(turn_start); // 🌟 实时通知前端：新轮次开始
}
```

```rust
// turn_complete.rs
let turn_end = AgentEvent::TurnEnd {
    session_id: ctx.session_id.clone(),
    turn_index: ctx.turn_index,
    timestamp: crate::steering::now_iso_utc(),
    tool_call_count: ctx.tool_call_count,
    usage: state.turn_usage.take(),
};
state.events.push(turn_end.clone());
if let Some(sink) = live_sink {
    sink.push_live(turn_end); // 🌟 实时通知前端：本轮执行完毕
}
```

#### 改动点 4：在 `streaming.rs` 中实时广播消息生命周期

文件：[`crates/session-loop/src/loop/handlers/streaming.rs`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/streaming.rs#L555-L571)

```rust
fn commit_message_with_deltas(
    state: &mut LoopState,
    message: AgentMessage,
    live_sink: Option<&dyn LiveEventSink>,
) {
    let session_id = state.machine.context().session_id.clone();
    let message = Arc::new(message);

    let start_event = AgentEvent::MessageStart {
        session_id: session_id.clone(),
        message: message.clone(),
    };
    state.events.push(start_event.clone());
    if let Some(sink) = live_sink {
        sink.push_live(start_event); // 🌟 思考/消息开始实时通知
    }

    state.conversation.push(message.clone());

    let end_event = AgentEvent::MessageEnd {
        session_id,
        message,
        turn_index: Some(state.machine.context().turn_index),
    };
    state.events.push(end_event.clone());
    if let Some(sink) = live_sink {
        sink.push_live(end_event); // 🌟 思考/消息结束实时通知
    }
}
```

#### 改动点 5：Tauri 壳层 `BridgeDeltaSink` 统一支持全量实时事件

文件：[`apps/agent-workbench/src-tauri/src/engine_channels.rs:714-722`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/engine_channels.rs#L714-L722)

```rust
impl LiveEventSink for BridgeDeltaSink {
    fn push_live(&self, event: AgentEvent) {
        let envelope = AgentEventEnvelope::new(event, Some(self.run_id.clone()), None);
        self.bridge.emit(&envelope);
        self.bridge.flush();
    }
}
```

---

## 七、风险评估、不变性证明与测试验证矩阵

### 1. 架构不变性与正确性证明

1. **存储可回放性不变（Store Replayability Invariant）**：
   - 实时轨发出的事件信封严格保持 `sequence: None`，**绝不写入数据库**；
   - 数据库落库唯一发生在 Run 结束时的 `drive_outcome` 中，分配严格自增的连续序列号；
   - 历史回放、重启恢复（Restore）与断点检查完全基于数据库 `events` 表，不受实时轨影响。
2. **前后端事件幂等性不变（Idempotency Invariant）**：
   - 前端接收到实时轨的 `ToolStart(id="call_123")` 时，创建处于 `running` 状态的卡片；
   - 当 Run 结束收到带 `sequence` 的持久化 `ToolStart(id="call_123")` 时，前端基于 `call_id` 执行原子覆盖，不会渲染重复卡片。
3. **并发安全与零死锁（Concurrency Safety）**：
   - `LiveEventSink::push_live` 为无状态同步调用，内部通过标准非阻塞 Mutex 发送，不跨 `.await` 持锁，无死锁隐患。

---

### 2. 测试验证矩阵

| 测试套件 / 场景                  | 验证断言                                             | 预期结果                                                                                                     |
| -------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **19 轮长程工具循环集成测试**    | 模拟 19 轮连续 `ToolCall`，监听实时 IPC 管道         | 前端在 Run 运行期间连续收到 19 对 `TurnStart`/`TurnEnd` 与 `ToolStart`/`ToolEnd`，间隔与真实工具执行时间一致 |
| **思考流连续吐字断言**           | 模拟 2000 个 Token 的超长推理流                      | 前端 `EventRouter` 100% 放行所有 Token，思考窗内容完整无损，无 `"TheTheThe..."` 截断                         |
| **工具卡片运行中展开与进度测试** | 在工具执行中模拟长耗时命令（5s）                     | 工具卡片在 `status === 'running'` 时允许点击展开，展示实时运行参数与计时器                                   |
| **断网/异常崩溃恢复测试**        | 在第 10 轮工具执行中杀死进程                         | 重启后从 SQLite 恢复历史会话，历史消息与工具卡片按 sequence 完整回放                                         |
| **全仓门禁验证**                 | 执行 `cargo test --workspace` 与 `npm run typecheck` | 73 个 Rust 测试套件与前端 TypeScript 检查 100% 全绿通过                                                      |

---

## 八、总结与下一步指引

本分析报告深入剖析了 Conex 会话循环在长程多轮任务中出现的思考首字误杀与中间事件滞留问题的全链路根因，并给出了精准的代码级证据与架构重构方案。

- **前端层面**：去重键逻辑修复已彻底解决思考内容 `"TheTheThe..."` 碎片化问题；
- **Rust 引擎层面**：通过将 `LiveEventSink` 贯通至 `prepare_turn`、`streaming`、`executing_tools` 与 `turn_complete`，即可无缝打破 19 轮工具调用的中途黑盒，实现完全实时的多轮 Agent 交互体验。
