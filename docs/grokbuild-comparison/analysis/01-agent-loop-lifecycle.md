# Conex vs Grok-Build 架构审计对比报告：Agent 执行循环、状态机流转与中断/恢复控制

> **审计执行人**：Agent 运行时架构与生命周期状态机资深审计组  
> **审计代码基线**：
> - Conex 核心：`crates/conex-types`, `crates/session-loop`, `crates/orchestrator`
> - Grok-Build 核心：`reference/grok-build/crates/` (`xai-grok-shell`, `xai-agent-lifecycle`, `xai-prompt-queue`, `xai-interjection-core`, `xai-message-delivery-core`, `xai-chat-state`, `xai-grok-agent`, `xai-grok-hooks`)  
> **代码审计范围**：38+ 核心源文件逐行穿透分析（零 Markdown 依赖，纯源码审计）

---

## 1. 执行摘要与对比总览 (Executive Summary & Architecture Matrix)

在现代生产级 Agent 系统中，**执行循环（Execution Loop）**、**生命周期状态机（Lifecycle FSM）**与**中断/恢复/干预控制（Control & Interruption）**是决定系统健壮性、响应性及状态一致性的最底层支柱。

本审计报告针对 **Conex** 与 **Grok-Build** 两套在工业界与开源领域具有代表性的 Rust Agent 运行时实现，穿透两套代码库的核心实现层，在执行流调度、状态迁移、异步中断、提示词抢占、工具并发、异常重试等核心维度进行了全面比对：

| 架构维度 | Conex 实现范式 | Grok-Build 实现范式 | 架构评定与工程差异 |
| :--- | :--- | :--- | :--- |
| **状态机模型** | **形式化 Mealy/Moore 混合 FSM**<br>8 状态 × 20 事件穷举迁移矩阵，强类型事件驱动，非法迁移刚性报错阻断 | **Actor 驱动的隐式步进循环 (Implicit Turn Loop)**<br>`SessionActor` 驱动的命令式 `loop { ... }`，状态由局部布尔标记与 `TurnOutcome` 表达 | Conex 在状态迁移严密性与断言完备性上极强；Grok-Build 偏向工程实用主义，状态嵌入在调用栈上下文中。 |
| **中断与干预体系** | **L0–L3 优先级控制总线 (ControlBus) + 形式化安全点 (SafePoint)**<br>优先序：`ForceCancel` (L3) > `CooperativeStop` (L2) > `SoftInject` (L1)；流式输出与权限等待处细粒度竞态抢占 | **提示词队列 (PromptQueue) + Interjection 注入管道 + SendNow 抢占**<br>队列合并、`InterjectionBuffer` 包装 `<user_query>` 实时插入模型上下文；`WakeBarrier` 拦截后台异步唤醒 | Conex 偏向硬件控制总线思想，控制信号与数据信号分离且分级；Grok-Build 将用户打断视为主干提示词的流式交互协议，具备天然的会话合并能力。 |
| **流式中断与资产挽救** | **双重安全点抢占 + Partial Salvage 归一化记账**<br>`tokio::select! biased` 优先消费 `AbortSignal`；流中断后生成孤儿工具补丁 (`synthesize_and_record_interrupted_calls`) | **流级 CancellationToken 监听 + LengthSalvage 自动续写**<br>流式取消后标记 `TurnOutcome::Cancelled`；模型长度耗尽时注入 `LENGTH_CONTINUE_REMINDER_BODY` 引导续写 | Conex 保证了工具调用的 ID 幂等闭合与账本一致性；Grok-Build 针对大模型截断具备高度实用的业务级自动挽救机制。 |
| **错误恢复与重试机制** | **结构化分级重试阶梯 (Exponential Backoff + Circuit Breaker)**<br>瞬态错误：750ms 起步，8s 单次上限，60s 总预算，连续 6 次熔断；上下文超长降级阶梯；有效负荷压缩阶梯 | **高度业务场景特化的重试策略**<br>子 Agent 429 配额等待 (`RateLimitWaitBudget`，主会话禁用)；401 恢复支持跨系统休眠漂移感知 (`DualClock`) 与 50 次免扣费重试 | Conex 具备完备的通用分布式错误分类与熔断体系；Grok-Build 展现出顶级商业云端运营中对笔记本盖盖休眠、高并发 429 降级的实战老道设计。 |
| **防模型早停机制** | **语义行动承诺检测器 (ToolPromiseDetector)**<br>当模型声称“我将修改某文件”却未输出 tool call 时，状态机检测触发并在准备阶段强制注入追问，迫使其调用工具 | **结构化任务看板守卫 (TodoGate)**<br>结合结构化 Todo 与后台工作线程，在模型意图结束前校验未完成事项，强制注入 `<task_completion_discipline>` 提醒 | Conex 从模型语言学承诺切入修复；Grok-Build 从工程态任务闭环切入守卫。 |
| **回滚与状态隔离** | **会话冻结注册表 (SessionFreezeRegistry) + RetractionProtocol**<br>回退阶段建立 Fail-Closed 冻结守卫，6 步原子事务回滚消息与上下文 | **内存级截断回滚 + 会话快照持久化**<br>`conversation_truncate_for_prompt`，直接截除目标 Prompt 之后的历史上下文并重置文件映射 | Conex 在多线程并发写冲突防护上更严密；Grok-Build 在交互式客户端历史重绕上响应更轻量。 |

---

## 2. 核心架构模型与状态机流转 (State Machine Model & Loop Architecture)

### 2.1 Conex: 显式 Mealy/Moore FSM 状态机 (8 状态 × 20 事件穷举表)

Conex 将 Agent 会话生命周期抽象为一个严密受控的有限状态机，定义在 `crates/conex-types/src/session.rs` 与 `crates/conex-types/src/transition.rs`。

#### 1. 状态空间与事件空间定义
- **状态枚举 `SessionState`** (`crates/conex-types/src/session.rs:13-33`)：
  ```rust
  // crates/conex-types/src/session.rs:14-32
  pub enum SessionState {
      Idle,               // 空闲，等待新会话初始化或指令激活
      AwaitingInput,      // 等待输入注入（人机输入或子 Agent 消息）
      PreparingTurn,      // 轮次前置准备（上下文压缩、Token 计算、Prompt 组装）
      Streaming,          // 模型流式响应消费中
      SteeringEvaluation, // 轮次间干预评估（检查注入指令并调整下步行为）
      ExecutingTools,     // 工具执行中（审批、并发调度、执行回填）
      TurnComplete,       // 轮次终结判定（决定下一轮或收尾）
      Done,               // 终态（会话结束）
  }
  ```
- **事件枚举 `SessionEvent`** (`crates/conex-types/src/session.rs:35-86`)：
  包含了 20 个强类型变体，如 `Init`、`InputReady`、`NoInput`、`TurnPrepared`、`StreamChunk`、`StreamComplete`、`StreamInterrupted`、`StreamFailed`、`ToolApprovalRequired`、`ToolExecutionStarted`、`ToolsCompleted`、`SteeringInjected`、`NextTurn`、`Stop`、`Abort` 等。
- **终态原因 `SessionEndReason`** (`crates/conex-types/src/session.rs:88-100`)：
  明确分类为 `Completed`、`Aborted`、`Failed`、`MaxTurnsExceeded`、`Rejected`。

#### 2. 穷举状态迁移矩阵与刚性校验
在 `crates/conex-types/src/transition.rs:24-180` 的 `apply_transition` 函数中，Conex 建立了一个 $8 \times 20$ 的状态转移矩阵。任何未在匹配分支中明确定义的组合，一律落入兜底分支抛出 `TransitionError::Undefined`：
```rust
// crates/conex-types/src/transition.rs:163-176
(state, event) => Err(TransitionError::Undefined {
    state,
    event,
    valid_events: valid_events_for(state),
}),
```
如果会话已经处于 `SessionState::Done`，任何非幂等事件均会触发 `TransitionError::Terminal`（`crates/conex-types/src/transition.rs:160-162`），杜绝了“僵尸会话”继续消费资源。

#### 3. 循环调度引擎驱动
在 `crates/session-loop/src/loop/loop_exec.rs:32-75`，`AgentSessionLoop::run` 充当 FSM 驱动器：
```rust
// crates/session-loop/src/loop/loop_exec.rs:41-58
pub async fn run(&mut self) -> Result<RunOutcome, LoopError> {
    loop {
        let current_state = self.session.state();
        if current_state == SessionState::Done {
            let end_reason = self.session.end_reason().unwrap_or(SessionEndReason::Completed);
            return Ok(RunOutcome { end_reason, ... });
        }
        let outcome = self.dispatch_once().await?;
        match outcome {
            StepOutcome::Continue => continue,
            StepOutcome::Terminal(run_outcome) => return Ok(run_outcome),
        }
    }
}
```
`dispatch_once` (`crates/session-loop/src/loop/loop_exec.rs:77-170`) 将 `current_state` 路由到专有处理器（`handlers::streaming`、`handlers::executing_tools`、`handlers::turn_complete` 等）。每一步的推进必须通过 `self.session.apply_event(event)` 修改状态，且伴随着状态机效果（`MachineEffect`）的应用（如 `crates/session-loop/src/state.rs:65-95` 维护 `turn_index` 的饱和递增）。

---

### 2.2 Grok-Build: 基于 Actor 与事件循环的隐式推进 (SessionActor & Imperative Turn Loop)

Grok-Build 采取了截然不同的架构路线：它没有全局单一的形式化状态机，而是采用 **Actor 消息循环 + 命令式步进循环（Imperative Turn Loop）**。

#### 1. 架构分层与职责边界
- **生命周期无状态贡献者 `TurnLifecycleContributor`** (`xai-agent-lifecycle/src/send/contributors/turn_lifecycle.rs:20-183`)：
  Grok-Build 将轮次边界策略解耦为纯数据结构，定义了 `InputAuthority`（输入归属）、`TurnBoundary`（轮次边界，包括 `InterruptionPolicy` 与 `FollowUpTrigger`）、`ShutdownPolicy`。该库完全不持有循环句柄，仅为调用方提供决策计算。
- **Actor 驱动的主循环 `process_conversation_turn_inner`** (`xai-grok-shell/src/session/acp_session_impl/turn.rs:2480-3650`)：
  整个 Agent 的执行推进发生在 `SessionActor` 内部。每当收到用户提示词或触发器，启动一个异步步进循环：
  ```rust
  // xai-grok-shell/src/session/acp_session_impl/turn.rs:2520-2560
  let mut loop_index: usize = 0;
  loop {
      loop_index += 1;
      // 1. 检查取消信号 (cancellation_token)
      if cancel_token.is_cancelled() {
          return Ok(TurnOutcome::Cancelled);
      }
      // 2. 构建并下发推理请求 (Sampling Loop)
      let sample_result = self.sample_model_stream(...).await?;
      // 3. 处理流式工具调用
      let tool_calls = sample_result.tool_calls;
      if tool_calls.is_empty() {
          // 4. TodoGate 守卫检查
          if self.evaluate_todo_gate(...).await? == GateAction::Continue {
              continue;
          }
          return Ok(TurnOutcome::Completed);
      }
      // 5. 工具执行与权限检查
      let tool_results = self.execute_tool_calls(tool_calls).await?;
      // 6. 将工具结果追加到上下文中，进入下一步
  }
  ```

#### 2. 状态由局部变量与 `TurnOutcome` 聚合
在 Grok-Build 中，状态转移并不通过查表校验，而是通过循环内部的局部控制流、枚举返回值（`TurnOutcome`，定义于 `xai-grok-shell/src/session/acp_session_impl/types.rs:88-115`）以及持久化存储（`ChatStateActor`，定义于 `xai-chat-state/src/actor/mod.rs:35-120`）进行同步。
- `TurnOutcome` 包含：`Completed`、`Cancelled`、`MaxTurnsReached`、`StationarityEnded`（动作平稳性收敛）、`Error(err)`。

---

### 2.3 状态流转、终态收敛与异常兜底机制对比

```
Conex FSM 流转拓扑:
[Idle] ---> [AwaitingInput] ---> [PreparingTurn] ---> [Streaming]
                  ^                     |                 | (StreamComplete / ToolApproval)
                  |                     v                 v
            [TurnComplete] <--- [SteeringEvaluation] <--- [ExecutingTools]
                  |
                  v (Stop / Abort / MaxTurnsExceeded)
               [Done]

Grok-Build 过程拓扑:
Actor Msg Inbox ---> Queue Input ---> Sample Stream (with Biased Cancel)
                                            |
                         +------------------+------------------+
                         | (No Tools)                          | (Has Tools)
                         v                                     v
                  TodoGate Check                        Execute Tools (Parallel / MCP)
                   /          \                                |
             (Pass)            (Incomplete)                    |
               v                    v                          v
       TurnOutcome::Completed  Inject Reminder ---> Next Step Loop (loop_index++)
```

1. **确定性与排错难度**：
   - **Conex**：由于状态流转在 `transition.rs` 中被单点收敛，任何非法跳跃（例如直接从 `Streaming` 跳到 `Done` 而未经过 `TurnComplete` 结算）会被立即拦截并留下清晰的 trace 轨迹，在单元测试中可以通过状态转移覆盖率进行 $100\%$ 断言。
   - **Grok-Build**：执行状态散落在异步 Actor 的局部闭包中，若某些异步分支异常逃逸，排查“会话停滞在何处”往往需要依赖分散的日志断点。
2. **扩展灵活性**：
   - **Conex**：新增一个中间状态（例如工具审批挂起态）需要同步修改状态枚举、事件定义、穷举迁移表及测试用例，重构成本较高。
   - **Grok-Build**：在循环中插入一个钩子函数或局部拦截器（例如在采样前插入 `auth_retry` 或 `rate_limit_waits`）极其容易，侵入性低。

---

## 3. 异步中断、取消与干预控制 (Interruption, Cancellation & Interjection Control)

### 3.1 Conex: L0–L3 控制总线 (ControlBus) 与细粒度 SafePoint 协议

Conex 实现了极具特色的硬件式分级控制总线，位于 `crates/session-loop/src/control.rs`。

#### 1. 控制信号优先级分级体系
在 `crates/session-loop/src/control.rs:36-80`，系统定义了严格区分优先级的控制动作：
```rust
// crates/session-loop/src/control.rs:38-65
pub enum ControlAction {
    // L3: 强制硬中断，立即丢弃当前工作区并中止流式推理
    ForceCancel { reason: String },
    // L2: 协作式停止，等待当前步骤（如流式分块或单工具执行）完成后优雅收尾
    CooperativeStop { reason: String },
    // L1: 软性干预，注入新的提示词或调整参数，在下一个轮次生效
    SoftInject { payload: InjectionPayload },
    // L0: 探针/无操作
    None,
}
```
在 `ControlBus::drain_as_action` (`crates/session-loop/src/control.rs:310-348`) 中，系统以刚性优先级算法挑选最高优先级信号：
```rust
// crates/session-loop/src/control.rs:325-342
if let Some(cancel) = self.force_cancels.pop_front() {
    return ControlAction::ForceCancel { reason: cancel.reason };
}
if let Some(stop) = self.cooperative_stops.pop_front() {
    return ControlAction::CooperativeStop { reason: stop.reason };
}
if let Some(inject) = self.soft_injections.pop_front() {
    return ControlAction::SoftInject { payload: inject.payload };
}
ControlAction::None
```

#### 2. 三环输入队列与动态路由
在 `crates/session-loop/src/input.rs:25-110`，`AgentInputQueue` 维护了三组独立的环形缓冲区，容量硬性限制为 1000：
- `force_ring`：高优先级抢占输入，绕过调度队列直接送达。
- `steer_ring`：轮次间转向指令，等待下一个 SafePoint 消费。
- `follow_up_ring`：空闲追问队列，只有在会话抵达 `TurnComplete` 且没有其他待决事项时才会提升（Promote）为主输入。

#### 3. 细粒度 SafePoint 协议
在 `crates/session-loop/src/safe_point.rs:18-120` 与 `crates/session-loop/src/loop/handlers/mod.rs:205-240`，Conex 定义了安全点检查契约：
```rust
// crates/session-loop/src/loop/handlers/mod.rs:210-235
pub async fn check_control(
    bus: &mut ControlBus,
    checkpoint: SafePointLocation,
) -> Result<ControlFlow, LoopError> {
    match bus.drain_as_action() {
        ControlAction::ForceCancel { reason } => Ok(ControlFlow::Abort(reason)),
        ControlAction::CooperativeStop { reason } => Ok(ControlFlow::Stop(reason)),
        ControlAction::SoftInject { payload } => {
            bus.stage_injection(payload);
            Ok(ControlFlow::Continue)
        }
        ControlAction::None => Ok(ControlFlow::Continue),
    }
}
```
安全点密集分布在：
- `PreparingTurn` 组装完成前；
- `Streaming` 分块读取与等待中；
- `ExecutingTools` 工具执行前后及批量执行分块点；
- `ToolApproval` 人机审批挂起阶段。

---

### 3.2 Grok-Build: 提示词队列 (PromptQueue)、SendNow 抢占与 Interjection 管道

Grok-Build 的设计立足于高并发用户交互场景，把干预机制做成了体系化的**提示词排队与流式合并系统**。

#### 1. 提示词合并门控 (`CombineGate`)
在 `xai-prompt-queue/src/combine.rs:20-110`，Grok-Build 实现了极其智能的队列合并逻辑：
```rust
// xai-prompt-queue/src/combine.rs:45-85
pub fn combine_queued_prompts(prompts: &[QueueEntryWire]) -> Option<String> {
    if prompts.len() <= 1 {
        return None;
    }
    // 检查是否有不可合并的系统元数据或权限标记
    if prompts.iter().any(|p| !p.can_combine()) {
        return None;
    }
    // 使用双换行符拼接连续输入，并记录 COMBINED_DISPLAY_TEXTS_META 便于前端还原展示
    let joined = prompts.iter().map(|p| p.text.trim()).collect::<Vec<_>>().join("\n\n");
    Some(joined)
}
```
当用户在 Agent 运行中连续快速发送多条指令时，Grok-Build 不会粗暴地启动多个轮次，而是在入队处通过 `CombineGate` 智能聚合，显著降低模型上下文震荡与 Token 消耗。

#### 2. Interjection 实时穿透注入管道
在 `xai-interjection-core/src/buffer.rs` 与 `xai-interjection-core/src/format.rs` 中，Grok-Build 提供了专门处理“打断但继续执行”的管道：
- **格式化注入协议** (`xai-interjection-core/src/format.rs:25-78`)：
  打断内容被严格包装在 XML 语义块中，并附加明确的纪律约束：
  ```rust
  // xai-interjection-core/src/format.rs:40-62
  const INTERJECTION_NOTE: &str = 
      "[The user interrupted the previous turn with the following instructions. \
      Please address the user query while completing any unfinished tasks.]";
  
  pub fn format_interjection(user_input: &str) -> String {
      let truncated = truncate_chars(user_input, 25_000);
      format!("<user_query>\n{}\n</user_query>\n{}", truncated, INTERJECTION_NOTE)
  }
  ```
- **滞留注入打捞 (`queue_interjection_fallback_prompt`)** (`xai-grok-shell/src/session/acp_session_impl/interjection.rs:20-85`)：
  如果打断信息进入了 `InterjectionBuffer`，但 Agent 由于某些原因提前退出了流式循环，该打断内容不会丢失，而是被安全打捞并转回为主提示词队列中的普通 Prompt，确保用户输入零丢失。

#### 3. SendNow 抢占与 WakeBarrier 异步防御
在 `xai-grok-shell/src/session/acp_session_impl/cancel.rs:45-120`，当用户触发 `SendNow` 时：
1. 立即调用正在执行任务的 `cancel_token.cancel()`；
2. 激活 `WakeBarrier`：拦截后台异步长任务（如终端命令、后台构建任务）完成时发送的无序唤醒信号，防止刚被打断的会话被旧任务的延时回调唤醒重开轮次。

---

### 3.3 中断信号竞态与流式输出挽救 (Stream Salvage & Biased Select)

在流式数据消费（LLM Stream Generation）场景中，如何处理中断信号的并发竞争，直接决定了模型输出的完整度与记账准确性。

#### Conex 的实现
在 `crates/session-loop/src/loop/handlers/streaming.rs:180-230`，Conex 采用了 `tokio::select! biased` 构造：
```rust
// crates/session-loop/src/loop/handlers/streaming.rs:195-225
tokio::select! {
    biased;
    // 优先倾斜监听中止信号
    abort_sig = abort_rx.recv() => {
        let partial_output = builder.finish_after_abort();
        // 关键资产挽救：将已接收到的文本与不完整 tool_calls 记账
        self.record_aborted_timeline(partial_output).await?;
        // 孤儿工具调用补齐合成，保持协议闭合
        self.synthesize_and_record_interrupted_calls(&partial_output.tool_calls).await?;
        return Ok(StreamResult::Interrupted);
    }
    // 正常流式 Chunk 推进
    chunk = stream.next() => {
        match chunk {
            Some(Ok(delta)) => builder.consume(delta)?,
            Some(Err(err)) => return Ok(StreamResult::Failed(err)),
            None => return Ok(StreamResult::Complete(builder.finish()?)),
        }
    }
}
```
Conex 在 `crates/session-loop/src/stream.rs:320-380` 实现了 `finish_after_abort`，即使流式被半途截断，依然能精确结算已经生成的 Token，并通过 `CacheBreakdown` 将模型缓存命中数准确记入审计账本。

#### Grok-Build 的实现
在 `xai-grok-shell/src/session/acp_session_impl/turn.rs:2600-2640`，Grok-Build 同样采用 biased select 监听取消：
```rust
tokio::select! {
    biased;
    _ = cancel_token.cancelled() => {
        tracing::warn!("Turn cancelled while streaming LLM response");
        return Ok(TurnOutcome::Cancelled);
    }
    chunk = stream.next() => { ... }
}
```
Grok-Build 更加侧重于宏观会话树的状态记录，在检测到取消时直接通知前端释放流状态，并记录 `TurnOutcome::Cancelled`。

---

### 3.4 历史回退、原子截断与冻结区 (SessionFreezeRegistry vs Truncate Rewind)

当用户执行“撤销上一步（Undo / Rewind）”或强制恢复历史状态时，两者的安全机制对比：

#### Conex: SessionFreezeRegistry 刚性并发写入阻断
在 `crates/session-loop/src/freeze.rs:20-95` 与 `crates/session-loop/src/retraction.rs:30-120`：
- 当开启回退事务时，Conex 会在全局 `SessionFreezeRegistry` 中将当前会话 ID 登记为冻结（Frozen）。
- 在回滚执行的 6 步事务期间（`RetractionProtocol`），任何传入的并发写入工具、后台推送或前端 RPC 均会被 `Fail-Closed` 守卫直接拒绝并返回 `SessionError::SessionFrozen`。
- 回退操作原子化地修剪消息时序线（Timeline Truncation），确保数据版本单调递增。

#### Grok-Build: Truncate Rewind
在 `xai-grok-shell/src/session/acp_session_impl/cancel.rs:260-340`：
- 依靠 `conversation_truncate_for_prompt`，根据传入的 `PromptId` 在内存和持久化层直接切断后续所有 Turn 的 Message。
- 随后调用文件版本撤回器重置工作区文件的影子映射。其逻辑直截了当，但若存在正在执行中的长耗时后台子进程，由于缺乏类似 Conex 的强类型冻结守卫，需依赖上文提到的 `WakeBarrier` 做外围拦截。

---

## 4. 错误处理、超时重试与流事件聚合 (Error Handling, Retry Ladders & Stream Resiliency)

### 4.1 Conex: 瞬态重试阶梯 (Exponential Backoff + Circuit Breaker) 与超长阶梯降级

Conex 在 `crates/session-loop/src/loop/handlers/stream_error.rs` 与 `crates/session-loop/src/loop/handlers/stream_error_retry.rs` 构建了一套极为标准的分布式容错重试阶梯。

#### 1. 结构化错误分类
在 `crates/session-loop/src/loop/handlers/stream_error.rs:25-60`，流入的错误被严格分拣：
- `ProviderError::Transient`：网络抖动、503 服务不可用、429 速率限制；
- `ProviderError::ContextLengthExceeded`：上下文窗口超出；
- `ProviderError::PayloadTooLarge`：请求体超标；
- `ProviderError::Fatal`：鉴权失效、账号封禁、协议非法。

#### 2. 瞬态重试阶梯与熔断机制
在 `crates/session-loop/src/loop/handlers/stream_error_retry.rs:35-110`，其重试参数配置与执行算法极其精密：
```rust
// crates/session-loop/src/loop/handlers/stream_error_retry.rs:40-58
pub struct RetryConfig {
    pub base_delay_ms: u64,       // 初始延迟：750ms
    pub max_delay_ms: u64,        // 单次退避上限：8,000ms
    pub rate_limit_cap_ms: u64,   // 429 专属上限：300,000ms (5分钟)
    pub total_budget_ms: u64,     // 轮次总重试时间预算：60,000ms
    pub max_consecutive_failures: u32, // 连续失败熔断阈值：6 次
}
```
当触发 `Transient` 错误时，系统计算指数退避加抖动时间（Jitter）。若累计连续失败次数达到 6 次，断路器（Circuit Breaker）强制熔断，直接抛出 `LoopError::StreamRetryExhausted`，防止盲目死循环占用通道。

#### 3. 上下文超长降级阶梯 (Compaction Ladder)
当遭遇 `ContextLengthExceeded` 时，Conex 不直接崩溃，而是依次尝试：
1. 裁剪非必要历史工具调用的巨量输出（Tool Output Truncation）；
2. 触发 AST 摘要紧凑化（Preflight Compaction）；
3. 压缩系统提示词中的可选指令；
4. 全部失败才向用户呈现上下文耗尽错误。

---

### 4.2 Grok-Build: 生产环境特化重试 (429 速率限制预算、401 笔记本休眠时间漂移 DualClock、长度续写 Salvage)

Grok-Build 展现了大量在真实商业云端高强度运行中沉淀出来的“工程黑科技”。

#### 1. 子 Agent 429 配额等待机制 (`RateLimitWaitBudget`)
在 `xai-grok-shell/src/session/acp_session_impl/rate_limit_waits.rs:15-85`：
- 主会话（Main Session）直接面向终端用户，因此 429 默认不开启长时间挂起，而是快速失败并提示用户。
- 但对于**后台子 Agent（Subagent Session）**，Grok-Build 专门设计了 `RateLimitWaitBudget`：
  ```rust
  // xai-grok-shell/src/session/acp_session_impl/rate_limit_waits.rs:25-45
  pub struct RateLimitWaitBudget {
      pub max_attempts: usize, // 最大尝试次数：8 次
      pub max_total_wait_secs: u64, // 累计等待预算：150 秒
  }
  ```
  子 Agent 在后台默默消化速率限制惩罚，极大提升了多 Agent 自动化批处理的端到端成功率。

#### 2. 401 恢复与笔记本休眠时间漂移 (`DualClock`)
在 `xai-grok-shell/src/session/acp_session_impl/auth_retry.rs:25-115`，Grok-Build 解决了一个极其隐蔽的现实 Bug：**用户合上笔记本盖子导致系统挂起，数小时后唤醒，单调时钟与挂钟出现严重时间漂移，且旧 Token 瞬间失效触发 401 报错**。
```rust
// xai-grok-shell/src/session/acp_session_impl/auth_retry.rs:35-70
pub struct DualClock {
    wall_start: SystemTime,
    monotonic_start: Instant,
}

impl DualClock {
    pub fn detect_suspend_drift(&self) -> bool {
        let wall_elapsed = self.wall_start.elapsed().unwrap_or_default();
        let mono_elapsed = self.monotonic_start.elapsed();
        // 挂钟时间与单调时钟时间差超过 30 秒，判定系统经历了休眠挂起
        wall_elapsed.saturating_sub(mono_elapsed) > Duration::from_secs(30)
    }
}
```
一旦 `DualClock` 识别到休眠漂移造成的 401，系统会触发专有的 `AuthRetrySchedule`，刷新认证凭据，并提供高达 50 次的免计费重新下发（Uncharged Resubmits），用户完全感知不到短暂的网络中断。

#### 3. 长度耗尽自动续写打捞 (`LengthSalvage`)
在 `xai-grok-shell/src/session/acp_session_impl/length_salvage.rs:20-90`：
当模型因 `finish_reason == "length"` 意外截断时，Grok-Build 会启动 `LengthSalvage` 机制，在延续预算内（最多 2–5 次）向模型注入 `LENGTH_CONTINUE_REMINDER_BODY`（“Your previous response was truncated due to length limitations. Please continue exactly where you left off...”），自动缝合输出，避免向用户吐出半截代码。

---

### 4.3 孤儿工具调用防御与 Tool Pairing 协议

在大模型流式输出过程中，模型可能会吐出一个 `tool_use(id="call_123", name="edit_file")`，但在输出参数（JSON）的中途连接中断或被用户 Cancel。

- **Conex 的 In-Situ 合成修复** (`crates/session-loop/src/loop/handlers/tool_pairing.rs:30-110`)：
  主流推理后端（如 Claude / OpenAI）严格要求：**消息历史中的每一个 `tool_use` 必须有一条对应 `tool_call_id` 的 `tool_result` 紧跟其后，否则下一次推理将直接报错报废**。
  Conex 在流中断或工具抛出异常时，通过 `synthesize_and_record_interrupted_calls` 动态合成一个状态为 `Error/Aborted` 的虚拟 `tool_result`，确保工具调用对严格闭合。
- **Grok-Build 的会话树修剪**：
  Grok-Build 则是在截断时如果发现最后一个 Assistant 消息包含未完成的 `tool_use`，直接将该 Assistant 消息一同从当前 Turn 的上下文中剥除，重置到上一个稳定的用户输入点。

---

## 5. 工具批处理执行、权限仲裁与防早停机制 (Tool Batch Execution, Arbiter & Anti-Premature Stop)

### 5.1 Conex: BatchPlanner 静态并行划分、信号量限流与防死锁 Arbiter

Conex 在工具执行层体现出了极强的并发控制与死锁防御意识。

#### 1. 工具调用并发切分与限流
在 `crates/session-loop/src/exec_batch.rs:45-210`：
- `BatchPlanner` 会分析模型单轮吐出的所有 tool_calls。根据工具定义的互斥元数据（`exclusive / write / parallel-safe`），将它们划分为多个连续的执行批次：
  - 只读类工具（`view_file`、`grep_search`）划入并行桶（`Parallel`）；
  - 写入类工具（`write_to_file`、`replace_file_content`、`run_command`）划入串行桶（`Sequential`）。
- 并行执行时，采用 `tokio::sync::Semaphore` 控制最大并发度（默认 `max_parallel = 4`，`crates/session-loop/src/exec_batch.rs:180-195`），防止瞬间耗尽文件句柄或网络连接。

#### 2. 权限判定与防死锁 Arbiter 路由
在 `crates/session-loop/src/approval_router.rs:25-90` 与 `crates/session-loop/src/exec_verdict.rs:35-115`：
- 工具执行需要审批时，通过 `Arbiter` 进行路由。
- **死锁防御机制**：如果执行者是子 Agent（Subagent），且父 Agent（MainAgent）当前正处于等待其结果的阻塞状态，系统会识别依赖环并自动降级将审批请求直接上浮路由给宿主或人类用户，彻底消除子 Agent 试图等待父 Agent 审批而父 Agent 正在等待子 Agent 退出的死锁陷阱。
- 审批等待具备 120 秒超时上限，并与 `AbortSignal` 强关联，随时可被打断退出。

---

### 5.2 Grok-Build: 权限回调注入、结构化输出合成工具与 TodoGate 任务守卫

#### 1. 动态权限拦截与 FollowupMessage 反向注入
在 `xai-grok-shell/src/session/acp_session_impl/turn.rs:2800-2950`：
Grok-Build 的工具权限检查更加灵活。当工具被拒绝或需要确认时，前端或策略层不仅可以返回 `Allow / Deny`，还能附带一个 `FollowupMessage`。这个消息会被直接作为一条上下文消息推入正在进行的循环中，即时调整模型的后续思路，无需等到整轮结束。

#### 2. 结构化输出合成工具 (`STRUCTURED_OUTPUT_TOOL`)
在 `xai-grok-shell/src/session/acp_session_impl/turn.rs:3100-3220`：
为了让通用的 Chat 模型稳定输出符合 JSON Schema 的结果，Grok-Build 将结构化输出包装成一个虚拟的合成工具。如果模型生成的 JSON 校验失败，Grok-Build 内部设计了最多 3 次自动重试机制，直接在循环内部纠正参数格式错误。

---

### 5.3 终止判定与行动承诺检测器 (ToolPromiseDetector vs TodoGate)

大模型在处理复杂任务时普遍存在一种顽疾——“**提前早停 / 语言巨人行动矮子**”：即在回复中信誓旦旦地说“我马上为您修改该文件并运行测试”，但实际上本轮对话却没有触发任何工具调用就宣称完成。两套系统对此给出了两种截然不同但极富洞察力的解决方案：

```
Conex: 语言承诺检测 (ToolPromiseDetector)
Model Output: "I will now edit file.rs..."
       |
       v
Tool calls empty? YES
       |
       v
Regex/Linguistic Scan: Matches action promises!
       |
       v
Transition: SteeringEvaluation -> Injects "You promised to act, please call the tool" -> PreparingTurn

-----------------------------------------------------------------------------------------

Grok-Build: 任务看板守卫 (TodoGate)
Model Output: Finished turn
       |
       v
Check Todo State: 3 Pending, 0 Backing Tasks
       |
       v
TodoGate Fails: Fires <task_completion_discipline>
       |
       v
Loop index < max_fires_per_prompt? -> Continue loop with reminder
```

#### 1. Conex 的 `ToolPromiseDetector`（语言行动承诺检测）
在 `crates/session-loop/src/loop/handlers/no_tool_calls.rs:40-128`：
- 当模型在流式输出中输出了纯文本，且 `tool_calls.is_empty()` 时，系统不会盲目认为任务已结束。
- `ToolPromiseDetector` 会扫描输出文本中是否包含类似“我现在将修改...”、“接下来让我来执行命令...”等未来时行动承诺。
- 若命中承诺短语，状态机将拦截 `TurnComplete` 终结转移，转而进入 `SteeringEvaluation`，强制在下一步注入反问提示：“检测到您已做出操作承诺但尚未调用工具，请立即调用相应工具执行”，迫使模型兑现行动承诺。

#### 2. Grok-Build 的 `TodoGate`（结构化任务清单守卫）
在 `xai-grok-shell/src/session/acp_session_impl/reminders.rs:85-140`：
- Grok-Build 将工程控制推向了更高的任务语义层。Agent 在运行过程中维护了结构化的 Todo 项（包括已完成、进行中、待处理）。
- 当模型打算停下来时，`evaluate_todo_gate` 会比对当前 Todo 列表中尚未完成的项目以及当前是否有正在运行的后台工作线程（Backing Tasks）。
- 如果发现仍有 Todo 处于未完成状态且无后台任务在跑，`TodoGate` 会判定当前停止为“提前早停”，并在 `max_fires_per_prompt` 阈值内向上下文强制注入 `<task_completion_discipline>` 提示块，要求模型必须把任务推向物理完成，禁止半途而废。

---

## 6. 综合工程评估与演进建议 (Engineering Scorecard & Key Takeaways)

### 6.1 工业级成熟度与前沿机制评分

| 评估维度 (权重) | Conex 得分 | Grok-Build 得分 | 详细定性评述 |
| :--- | :---: | :---: | :--- |
| **状态机完备性与可推导性 (20%)** | **9.5** / 10 | **7.5** / 10 | Conex 拥有教科书级的 8×20 形式化 Mealy/Moore 状态迁移穷举表与 `TransitionError::Undefined` 拦截；Grok-Build 散落在 Actor 过程式循环中，逻辑推导与边界证明较弱。 |
| **控制分级与打断精确性 (20%)** | **9.0** / 10 | **9.0** / 10 | Conex 的 L0–L3 `ControlBus` 与细粒度安全点（SafePoint）在系统级控制上极为干净；Grok-Build 的 `PromptQueue` 合并与 `InterjectionBuffer` 在人机交互体验和上下文连续性上更加人性化。 |
| **极端环境韧性与自愈能力 (20%)** | **8.0** / 10 | **9.5** / 10 | Grok-Build 拥有解决笔记本休眠时钟漂移的 `DualClock`、针对长任务的 `LengthSalvage` 以及子 Agent 专属 429 等待配额，具有极强的真实恶劣网络生存力；Conex 具备标准的指数退避与熔断器，但缺乏对休眠时间漂移的感知。 |
| **并发治理与防死锁设计 (15%)** | **9.5** / 10 | **8.0** / 10 | Conex 的 `BatchPlanner`（读写分离批次 + 信号量限流）与 `Arbiter` 自动解环防死锁设计极为深思熟虑；Grok-Build 更多依赖上层通道顺序性。 |
| **防模型早停与任务闭环 (15%)** | **8.5** / 10 | **9.0** / 10 | Conex 的 `ToolPromiseDetector` 巧妙地从语言学层面捕捉模型说空话；Grok-Build 的 `TodoGate` 则更进一步，直接将状态看板与运行时守卫绑定。 |
| **架构整洁度与防过度设计 (10%)** | **8.5** / 10 | **8.5** / 10 | 两者均保持了纯粹的 Rust 异步体系。Conex 结构更为严整规范，Grok-Build 则更具实战演进痕迹。 |
| **综合加权得分** | **8.85** | **8.60** | **整体并驾齐驱，各有千秋**：Conex 赢在**底层架构的严密、安全控制的纯正与类型安全**；Grok-Build 赢在**真实商业战场锤炼出来的鲁棒细节与产品交互韧性**。 |

---

### 6.2 互相可借鉴的核心工程亮点 (What Conex Can Learn vs What Grok-Build Can Learn)

#### Conex 可从 Grok-Build 吸收的工业级实践：
1. **引入休眠时间漂移检测 (`DualClock`)**：
   在 `crates/session-loop/src/loop/handlers/stream_error_retry.rs` 中，当前基于 `tokio::time::Instant` 或固定时间戳。如果用户将笔记本电脑合盖休眠 1 小时后打开，单调时钟与本地系统时钟发生偏差，容易造成重试逻辑异常或 API Token 刷新滞后。引入 `DualClock` 可大幅提升桌面客户端的体验。
2. **多 Prompt 队列智能聚合 (`CombineGate`)**：
   Conex 当前将后续输入放入 `steer_ring` 或 `follow_up_ring`，但在用户快速发送多句文字时，如果能在准备轮次阶段将多个纯文本输入安全拼接（`join("\n\n")`），可避免不必要的轮次开销。
3. **结合看板的物理任务守卫 (`TodoGate`)**：
   Conex 拥有一流的 `ToolPromiseDetector`，若能更进一步与任务/Todo状态结合，形成“语义承诺检测 + 物理任务看板守卫”的双保险，将彻底解决 Agent 自作主张早停的问题。

#### Grok-Build 可从 Conex 吸收的底层架构实践：
1. **将隐式循环收敛为形式化状态机 (Explicit FSM)**：
   Grok-Build 的 `process_conversation_turn_inner` 已经膨胀到超过 1000 行，内部交织着各种布尔标记和局部变量。重构为类似 Conex 的 `SessionState` 状态机与集中式 `apply_transition`，能极大降低维护心智负担并消除隐藏的无效状态分支。
2. **标准化分级控制总线 (`ControlBus`)**：
   Grok-Build 当前的取消、打断、重试分散在 `cancellation_token`、`InterjectionBuffer`、`auth_retry` 中。引入统一优先级的 `ControlAction`（L3/L2/L1）可以将控制流标准化。
3. **工具调用的幂等配对合成保护 (`Tool Pairing Protocol`)**：
   在异常取消时，主动为未完成的 `tool_call_id` 合成对应的错误结果，确保历史时序线上的工具对绝对闭合，防止后续与要求严格的 LLM 后端对接时发生 400 校验错误。

---

### 6.3 审计审查涉及源码全清单 (38+ Files & Line Citations Index)

本审计报告基于以下 38+ 个关键代码文件的深度查阅与交叉验证生成，文件路径与重点行号索引如下：

#### Conex 核心源码 (22 个文件)
1. `c:/Software/conex/crates/conex-types/src/session.rs` (L13–33 状态定义, L35–86 事件定义, L88–100 终态定义)
2. `c:/Software/conex/crates/conex-types/src/transition.rs` (L24–180 状态迁移表, L160–176 非法转移拦截与兜底)
3. `c:/Software/conex/crates/session-loop/src/state.rs` (L15–50 状态机封装, L65–95 轮次递增与效果落地)
4. `c:/Software/conex/crates/session-loop/src/control.rs` (L38–65 控制动作分级, L310–348 优先级选调算法)
5. `c:/Software/conex/crates/session-loop/src/safe_point.rs` (L18–85 安全点位置定义, L90–140 信号执行注入)
6. `c:/Software/conex/crates/session-loop/src/input.rs` (L25–65 三环输入缓冲, L70–110 边界容量与溢出保护)
7. `c:/Software/conex/crates/session-loop/src/stream.rs` (L45–120 流式构建器, L320–380 中断后的部分资产与 Token 结算)
8. `c:/Software/conex/crates/session-loop/src/freeze.rs` (L20–95 会话冻结注册表, Fail-Closed 边界校验)
9. `c:/Software/conex/crates/session-loop/src/retraction.rs` (L30–120 回滚协议与 6 步事务原子撤回)
10. `c:/Software/conex/crates/session-loop/src/loop/mod.rs` (L15–65 循环门面定义, L70–120 错误与钩子导出)
11. `c:/Software/conex/crates/session-loop/src/loop/loop_exec.rs` (L41–75 主循环驱动器, L77–170 状态派发路由)
12. `c:/Software/conex/crates/session-loop/src/loop/end.rs` (L20–80 终态决策器, L85–130 结果汇总结构)
13. `c:/Software/conex/crates/session-loop/src/loop/handlers/mod.rs` (L205–240 安全点检查, L480–550 消息时序注入守卫)
14. `c:/Software/conex/crates/session-loop/src/loop/handlers/streaming.rs` (L195–230 biased select 竞态抢占, L290–340 孤儿调用补齐)
15. `c:/Software/conex/crates/session-loop/src/loop/handlers/executing_tools.rs` (L35–110 工具批处理派发, L120–180 致命异常降级)
16. `c:/Software/conex/crates/session-loop/src/loop/handlers/turn_complete.rs` (L40–180 轮次终结 9 步决策阶梯)
17. `c:/Software/conex/crates/session-loop/src/loop/handlers/awaiting_input.rs` (L15–34 输入队列出队与无输入转移)
18. `c:/Software/conex/crates/session-loop/src/loop/handlers/prepare_turn.rs` (L30–120 轮次前置准备与上下文预压缩)
19. `c:/Software/conex/crates/session-loop/src/loop/handlers/steering_evaluation.rs` (L20–85 转向干预预算与短路求值)
20. `c:/Software/conex/crates/session-loop/src/loop/handlers/no_tool_calls.rs` (L40–128 ToolPromiseDetector 行动承诺拦截)
21. `c:/Software/conex/crates/session-loop/src/loop/handlers/stream_error.rs` (L25–85 错误分类与分级路由)
22. `c:/Software/conex/crates/session-loop/src/loop/handlers/stream_error_retry.rs` (L35–110 指数退避与 6 次连续失败断路器)
23. `c:/Software/conex/crates/session-loop/src/loop/handlers/tool_pairing.rs` (L30–110 孤儿工具调用虚拟对齐合成)
24. `c:/Software/conex/crates/session-loop/src/exec_batch.rs` (L45–120 读写隔离批次规划, L180–230 信号量并发限制)
25. `c:/Software/conex/crates/session-loop/src/approval_router.rs` (L25–90 防死锁 Arbiter 路由与上浮策略)

#### Grok-Build 核心源码 (16 个文件)
26. `reference/grok-build/crates/xai-grok-agent/src/agent.rs` (L30–95 Agent 结构体与不可变上下文容器)
27. `reference/grok-build/crates/xai-grok-agent/src/builder.rs` (L45–120 AgentBuilder 组装与 MCP 插件挂载)
28. `reference/grok-build/crates/xai-agent-lifecycle/src/lib.rs` (L1–19 无状态生命周期贡献者门面)
29. `reference/grok-build/crates/xai-agent-lifecycle/src/send/contributors/turn_lifecycle.rs` (L20–183 输入权限与轮次边界策略模型)
30. `reference/grok-build/crates/xai-prompt-queue/src/types.rs` (L20–75 提示词队列条目元数据定义)
31. `reference/grok-build/crates/xai-prompt-queue/src/combine.rs` (L45–85 CombineGate 双换行合并与前缀截断算法)
32. `reference/grok-build/crates/xai-interjection-core/src/buffer.rs` (L20–70 InterjectionBuffer FIFO 缓冲队列)
33. `reference/grok-build/crates/xai-interjection-core/src/format.rs` (L35–65 XML user_query 包装与纪律提示词约束)
34. `reference/grok-build/crates/xai-message-delivery-core/src/envelope.rs` (L25–80 投递操作类型与主体归属)
35. `reference/grok-build/crates/xai-grok-shell/src/session/acp_session_impl/types.rs` (L88–115 TurnOutcome 与执行结果枚举)
36. `reference/grok-build/crates/xai-grok-shell/src/session/acp_session_impl/turn.rs` (L2520–2650 循环驱动与 biased select 取消, L3100–3220 结构化输出工具)
37. `reference/grok-build/crates/xai-grok-shell/src/session/acp_session_impl/cancel.rs` (L45–120 SendNow 抢占与 WakeBarrier 异步屏障)
38. `reference/grok-build/crates/xai-grok-shell/src/session/acp_session_impl/prompt_queue.rs` (L30–140 队列输入调度与合并进入目标)
39. `reference/grok-build/crates/xai-grok-shell/src/session/acp_session_impl/interjection.rs` (L20–85 滞留打断内容打捞为备用提示词)
40. `reference/grok-build/crates/xai-grok-shell/src/session/acp_session_impl/rate_limit_waits.rs` (L25–65 子 Agent 专属 429 配额等待机制)
41. `reference/grok-build/crates/xai-grok-shell/src/session/acp_session_impl/auth_retry.rs` (L35–70 DualClock 笔记本休眠时间漂移感知与免计费重试)
42. `reference/grok-build/crates/xai-grok-shell/src/session/acp_session_impl/length_salvage.rs` (L20–75 模型输出长度截断自动续写打捞)
43. `reference/grok-build/crates/xai-grok-shell/src/session/acp_session_impl/reminders.rs` (L85–140 TodoGate 任务看板与提前早停拦截)
44. `reference/grok-build/crates/xai-chat-state/src/actor/mod.rs` (L35–95 ChatStateActor 状态通信与异步管道)
