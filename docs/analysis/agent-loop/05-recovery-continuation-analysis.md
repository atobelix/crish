# conex 错误恢复与续轮策略不可信根因分析

> 本文通过实际阅读 conex（`packages/agent-runtime`、`packages/agent-orchestrator`）、pi（`reference/pi`）、grok-build（`reference/grok-build`）三个项目的源码，对比其错误恢复与续轮策略，定位 conex "AI 回复一句即断开、`Runtime intervention required` 频繁出现、续轮机制不可信" 的根本原因，并给出系统性重构建议。
>
> 所有结论均附具体文件路径与行号引用，便于复核。文中不使用 emoji，所有图示采用 SVG。

---

## 1. 问题陈述

conex 的 agent loop 在实际运行中暴露出三类核心症状：

1. **单轮即断**：AI 回复一句文本后就结束 run，无法连续调用工具完成多步任务。
2. **干预风暴**：`Runtime intervention required` 频繁出现，一次 steering 即可能触发 intervention。
3. **续轮与恢复互相阻断**：`TaskContinuationStrategy` 试图让 AI 继续，但被 runtime 层的 intervention 机制提前终结；新 run 又可能被历史错误消息污染。

这些问题不是孤立 bug，而是 **续轮语义、错误恢复、控制流三个层面机制冲突** 的表象。下文通过横向对比定位根因。

---

## 2. 三项目机制总览

### 2.1 架构定位差异

| 维度 | conex | pi | grok-build |
|------|-------|----|------------|
| 语言 | TypeScript | TypeScript | Rust |
| 循环结构 | 状态机驱动 + orchestrator 续轮 | 双层 while 循环 | 单层 loop + sampler 子任务 |
| 错误恢复分层 | runtime steering / orchestrator 续轮两层 | 单层 + 回调策略 | 三层（sampler retry / turn loop / session actor） |
| 续轮入口 | orchestrator `assessRound` 决策 | `getFollowUpMessages` 回调 | turn 内 `continue` + TodoGate nudge |
| 控制流等级 | L1/L2/L3 ControlBus | AbortSignal + shouldStopAfterTurn | CancellationToken + HookDenied/PermissionReject |

### 2.2 核心循环结构对比图

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 420" font-family="sans-serif" font-size="11">
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#333"/>
    </marker>
    <style>
      .box { fill: #f7f7f7; stroke: #333; stroke-width: 1; }
      .conex { fill: #ffe8e8; stroke: #b22222; }
      .pi { fill: #e8f4ff; stroke: #1e6091; }
      .grok { fill: #eaffea; stroke: #2e7d32; }
      .lbl { font-weight: bold; font-size: 12px; }
    </style>
  </defs>

  <!-- conex -->
  <text x="160" y="22" class="lbl" text-anchor="middle">conex（状态机 + 双层）</text>
  <rect x="40" y="40" width="240" height="40" rx="6" class="box conex"/>
  <text x="160" y="64" text-anchor="middle">AgentSessionLoop.run()</text>
  <rect x="40" y="100" width="240" height="40" rx="6" class="box conex"/>
  <text x="160" y="124" text-anchor="middle">SM: streaming → executing-tools</text>
  <rect x="40" y="160" width="240" height="40" rx="6" class="box conex"/>
  <text x="160" y="184" text-anchor="middle">handleSteeringEvaluation</text>
  <rect x="40" y="220" width="240" height="40" rx="6" class="box conex"/>
  <text x="160" y="244" text-anchor="middle">turn-complete → SHOULD_STOP</text>
  <rect x="40" y="280" width="240" height="40" rx="6" class="box conex"/>
  <text x="160" y="304" text-anchor="middle">orchestrator assessRound → continue?</text>
  <line x1="160" y1="80" x2="160" y2="100" stroke="#333" marker-end="url(#arr)"/>
  <line x1="160" y1="140" x2="160" y2="160" stroke="#b22222" marker-end="url(#arr)"/>
  <line x1="160" y1="200" x2="160" y2="220" stroke="#333" marker-end="url(#arr)"/>
  <line x1="160" y1="260" x2="160" y2="280" stroke="#333" marker-end="url(#arr)"/>
  <text x="172" y="156" fill="#b22222" font-size="10">intervention 截断</text>

  <!-- pi -->
  <text x="480" y="22" class="lbl" text-anchor="middle">pi（双层 while）</text>
  <rect x="360" y="40" width="240" height="40" rx="6" class="box pi"/>
  <text x="480" y="64" text-anchor="middle">runLoop()</text>
  <rect x="360" y="100" width="240" height="40" rx="6" class="box pi"/>
  <text x="480" y="120" text-anchor="middle">外层: followUp 到达?</text>
  <text x="480" y="134" text-anchor="middle">内层: toolCalls|steering</text>
  <rect x="360" y="160" width="240" height="40" rx="6" class="box pi"/>
  <text x="480" y="184" text-anchor="middle">streamAssistantResponse</text>
  <rect x="360" y="220" width="240" height="40" rx="6" class="box pi"/>
  <text x="480" y="244" text-anchor="middle">executeToolCalls → hasMoreToolCalls</text>
  <rect x="360" y="280" width="240" height="40" rx="6" class="box pi"/>
  <text x="480" y="304" text-anchor="middle">shouldStopAfterTurn? → agent_end</text>
  <line x1="480" y1="80" x2="480" y2="100" stroke="#333" marker-end="url(#arr)"/>
  <line x1="480" y1="140" x2="480" y2="160" stroke="#333" marker-end="url(#arr)"/>
  <line x1="480" y1="200" x2="480" y2="220" stroke="#333" marker-end="url(#arr)"/>
  <line x1="480" y1="260" x2="480" y2="280" stroke="#333" marker-end="url(#arr)"/>
  <path d="M 480 230 Q 580 230 580 120 Q 580 110 600 110" fill="none" stroke="#1e6091" marker-end="url(#arr)"/>
  <text x="586" y="170" fill="#1e6091" font-size="10">hasMoreToolCalls=true</text>

  <!-- grok-build -->
  <text x="800" y="22" class="lbl" text-anchor="middle">grok-build（单层 loop）</text>
  <rect x="680" y="40" width="240" height="40" rx="6" class="box grok"/>
  <text x="800" y="64" text-anchor="middle">handle_prompt → turn loop</text>
  <rect x="680" y="100" width="240" height="40" rx="6" class="box grok"/>
  <text x="800" y="124" text-anchor="middle">run_turn_via_sampler</text>
  <rect x="680" y="160" width="240" height="40" rx="6" class="box grok"/>
  <text x="800" y="180" text-anchor="middle">sampler retry loop</text>
  <text x="800" y="194" text-anchor="middle">(15 次 + doom resample)</text>
  <rect x="680" y="220" width="240" height="40" rx="6" class="box grok"/>
  <text x="800" y="244" text-anchor="middle">execute_tool_calls → ToolLoop</text>
  <rect x="680" y="280" width="240" height="40" rx="6" class="box grok"/>
  <text x="800" y="304" text-anchor="middle">continue / TurnOutcome::Completed</text>
  <line x1="800" y1="80" x2="800" y2="100" stroke="#333" marker-end="url(#arr)"/>
  <line x1="800" y1="140" x2="800" y2="160" stroke="#333" marker-end="url(#arr)"/>
  <line x1="800" y1="200" x2="800" y2="220" stroke="#333" marker-end="url(#arr)"/>
  <line x1="800" y1="260" x2="800" y2="280" stroke="#333" marker-end="url(#arr)"/>
  <path d="M 800 230 Q 900 230 900 120 Q 900 110 920 110" fill="none" stroke="#2e7d32" marker-end="url(#arr)"/>
  <text x="906" y="170" fill="#2e7d32" font-size="10">tool_calls 非空</text>
</svg>
```

**关键差异**：pi 与 grok-build 的"继续"是循环内的 `continue`，由同一执行上下文维持；conex 的"继续"必须跨过 `turn-complete → SHOULD_STOP` 边界，再由 orchestrator 重新启动一个 run，状态边界天然割裂。

---

## 3. conex 错误恢复与续轮机制详析

### 3.1 状态机驱动的单循环

conex 的核心循环位于 `packages/agent-runtime/src/session-loop/index.ts:143-203`。它是一个状态机驱动循环：

```typescript
// packages/agent-runtime/src/session-loop/index.ts:154-192
while (!this.machine.is('done')) {
  const state = this.machine.getCurrent();
  try {
    let r: HandlerResult = {};
    switch (state) {
      case 'awaiting-input': r = yield* this.handleAwaitingInput(); break;
      case 'preparing-turn': r = yield* this.handlePrepareTurn(); break;
      case 'streaming': r = yield* this.handleStreaming(); break;
      case 'steering-evaluation': r = yield* this.handleSteeringEvaluation(); break;
      case 'executing-tools': r = yield* this.handleExecutingTools(); break;
      case 'turn-complete': r = yield* this.handleTurnComplete(); break;
    }
    if (r.endReason) { endReason = r.endReason; endError = r.endError; }
    if (endReason) break;
  } catch (cause) { /* ... */ }
}
```

状态机的转移语义决定了"继续"必须经过 `turn-complete → SHOULD_STOP/NEXT_TURN` 这一边界。当 `handleTurnComplete` 决定 `SHOULD_STOP` 时（`index.ts:598`），整个 `run()` 退出，控制权交还 orchestrator。

### 3.2 过严的 steering 预算与 intervention 截断

`RecoverySteeringStrategy` 的默认配置是问题核心之一：

```typescript
// packages/agent-runtime/src/steering/recovery-steering-strategy.ts:40-44
constructor(options?: RecoverySteeringStrategyOptions) {
  this.maxConsecutiveToolErrors = options?.maxConsecutiveToolErrors ?? 2;
  this.maxRepeatedToolCalls = options?.maxRepeatedToolCalls ?? 3;
  this.maxSteeringMessages = options?.maxSteeringMessages ?? 1;  // ← 仅允许 1 次
}
```

`maxSteeringMessages` 默认为 **1**，意味着只要注入过一次 steering 消息，下一次 `evaluate` 就会直接返回 `intervention-required`：

```typescript
// packages/agent-runtime/src/steering/recovery-steering-strategy.ts:47-54
if (phase === "empty-response") {
  if (context.steeringCount >= this.maxSteeringMessages) {
    return {
      type: "intervention-required",
      reason: "empty-response",
      message: "The agent did not recover after runtime steering."
    };
  }
  // ...
}
```

更严重的是，`AgentSessionLoop` 构造时把这个预算同时用作 `maxSteeringBudget`：

```typescript
// packages/agent-runtime/src/session-loop/index.ts:116-119
this.steering = new SteeringDelegate(new SteeringCoordinator(conversation, [new RecoverySteeringStrategy({
  maxConsecutiveToolErrors: ro?.maxConsecutiveToolErrors, maxRepeatedToolCalls: ro?.maxRepeatedToolCalls,
  maxSteeringMessages: ro?.maxSteeringMessages ?? 1,
})], { maxSteeringBudget: ro?.maxSteeringMessages ?? 1 }));
```

`maxSteeringBudget` 与 `maxSteeringMessages` 同源（均为 1），导致 `SteeringCoordinator.evaluate` 在第一次注入后就拒绝再注入：

```typescript
// packages/agent-runtime/src/steering/steering-coordinator.ts:80-83
if (action.type === "inject-message" && potentialSteeringCount >= this.maxSteeringBudget) {
  // 超预算时跳过注入消息
  continue;
}
```

而 `handleSteeringEvaluation` 在 `empty-response` 路径上一旦拿不到 action，就直接以 error 收尾：

```typescript
// packages/agent-runtime/src/session-loop/index.ts:499-503
const evaluation = this.steering.evaluate('empty-response', sc);
if (evaluation.actions.length === 0) { this.dispatch('STEERING_BUDGET_EXHAUSTED'); return { endReason: 'error', endError: 'No steering strategy handled empty response' }; }
const applied = this.steering.apply(evaluation.actions, this.sessionId);
yield* flushEvents(applied.events);
if (applied.interventionRequired) { this.dispatch('INTERVENTION_REQUIRED'); return { endReason: 'error', endError: 'Runtime intervention required' }; }
```

**结果**：第一次 empty-response 注入一条 steering → 第二次 empty-response 因预算=1 直接 `intervention-required` → run 以 `error` 终结。这就是 "Runtime intervention required" 频繁出现的直接原因。

### 3.3 prepare-turn 阶段的 steering 误触发

`handlePrepareTurn` 在每轮开始前会对 `after-tools` 和 `before-turn` 两个阶段都做 steering 评估：

```typescript
// packages/agent-runtime/src/session-loop/index.ts:236-242
for (const phase of ['after-tools', 'before-turn'] as const) {
  const evalResult = this.steering.evaluate(phase, sc);
  const applied = this.steering.apply(evalResult.actions, this.sessionId);
  yield* flushEvents(applied.events);
  if (applied.interventionRequired) { this.dispatch('INTERVENTION_REQUIRED'); return { endReason: 'error', endError: 'Runtime intervention required' }; }
}
```

`after-tools` 阶段的 `detectRecoveryNeedFromMessages` 会扫描"最近工具错误循环"。如果上一轮 run 以错误收尾、错误消息残留在 `conversation` 中，新一轮 run 在 `preparing-turn` 就可能再次检测到"工具错误循环"，立刻触发 intervention——**状态污染跨 run 传播**。

### 3.4 续轮策略与 intervention 的语义冲突

orchestrator 层的 `TaskContinuationStrategy` 试图在 AI 自然停止时注入续轮 prompt：

```typescript
// packages/agent-orchestrator/src/task-continuation-strategy.ts:95-106
// AI 自然停止 → continue，注入续轮 prompt 让 AI 继续工作。
return {
  action: "continue",
  reason: "task-continuation",
  prompt: this.continuePrompt,
  detail: compactJsonObject({
    assessmentState: assessment.state,
    roundIndex: input.roundIndex
  })
};
```

但这条续轮 prompt 是作为**新 run 的输入**注入的，新 run 进入 `preparing-turn` 时会先经过 §3.3 的 steering 评估。如果上一轮有工具错误或重复调用残留，新 run 在还没开始 stream 就被 `INTERVENTION_REQUIRED` 截断，`TaskContinuationStrategy` 的 `continue` 决策被 runtime 层架空。

**两层语义错位**：
- orchestrator 层认为"AI 自然停止 → 继续即可"
- runtime 层认为"出现过工具错误 → intervention"
- 两者没有共享状态语义，也没有优先级仲裁

### 3.5 错误恢复的单点决策

`RecoveryCoordinator` 的 `handleErrorWithHook` 默认行为是 `abort`：

```typescript
// packages/agent-runtime/src/session-loop/recovery.ts:34-40
handleErrorWithHook(...): ErrorAction {
  if (hooks.onError) {
    return hooks.onError(error, errorCtx);
  }
  return 'abort';  // ← 无 hook 时一律 abort
}
```

`dispatchErrorRecovery` 的状态恢复映射也是粗粒度的（`recovery.ts:81-91`），它只把状态机推到下一个"安全态"，不区分错误类型（transient / fatal / context-length），也没有 backoff。相比之下，`handleStreamError`（`index.ts:425-469`）有更细的分类（payload-too-large / transient / synthesis nudge），但这条路径与 `handleErrorWithHook` 是分裂的，没有统一的错误分类器。

### 3.6 length finish reason 的续轮陷阱

`handleNoToolCalls` 对 `stopReason === 'length'` 的处理依赖 `shouldRetryWithEscalation`，而它的计数上限是 `MAX_LENGTH_CONTINUE_NUDGES = 1`（`index.ts:75`）。一次 nudge 后若仍 truncated，直接 `NO_TOOL_CALLS` → `SHOULD_STOP`。这与 pi 的 `failToolCallsFromTruncatedMessage`（`agent-loop.ts:381-406`）形成对比：pi 把截断的工具调用全部标记为 error 并 **继续内层循环**，让模型重新发起，而不是终止。

---

## 4. pi 错误恢复与续轮机制详析

### 4.1 双层 while 循环天然支持多轮工具调用

pi 的核心循环位于 `reference/pi/packages/agent/src/agent-loop.ts:155-275`：

```typescript
// reference/pi/packages/agent/src/agent-loop.ts:170-272
while (true) {                              // 外层：follow-up
  let hasMoreToolCalls = true;
  while (hasMoreToolCalls || pendingMessages.length > 0) {  // 内层：工具+steering
    // ...
    const message = await streamAssistantResponse(...);
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      await emit({ type: "turn_end", ... });
      await emit({ type: "agent_end", ... });
      return;                               // 仅 error/aborted 才退出
    }
    const toolCalls = message.content.filter((c) => c.type === "toolCall");
    hasMoreToolCalls = false;
    if (toolCalls.length > 0) {
      const executedToolBatch = message.stopReason === "length"
        ? await failToolCallsFromTruncatedMessage(toolCalls, emit)
        : await executeToolCalls(...);
      hasMoreToolCalls = !executedToolBatch.terminate;  // ← 工具结果非 terminate 即继续
    }
    // ...
    pendingMessages = (await config.getSteeringMessages?.()) || [];
  }
  // agent 本应停止 → 检查 follow-up
  const followUpMessages = (await config.getFollowUpMessages?.()) || [];
  if (followUpMessages.length > 0) {
    pendingMessages = followUpMessages;
    continue;                               // ← 外层 continue 续轮
  }
  break;
}
```

**关键设计**：
- 内层循环以 `hasMoreToolCalls` 为条件，工具调用非 `terminate` 即继续，**不需要"续轮决策"**。
- 续轮（follow-up）是外层循环的职责，通过 `getFollowUpMessages` 回调注入，与内层工具循环解耦。
- `terminate` 语义由工具结果显式声明（`shouldTerminateToolBatch`，`agent-loop.ts:582-584`），而非由 stopReason 推断。

### 4.2 错误恢复策略：回调即策略

pi 没有内置的 steering budget 概念，错误恢复完全通过 `AgentLoopConfig` 回调暴露：

- `getSteeringMessages`：在每次内层循环开始前注入消息（`agent-loop.ts:167, 259`）
- `getFollowUpMessages`：在 agent 本应停止时注入续轮消息（`agent-loop.ts:263`）
- `shouldStopAfterTurn`：每轮结束后由调用方决定是否终止（`agent-loop.ts:247-257`）
- `prepareNextTurn`：每轮结束后可覆盖 model / reasoning / context（`agent-loop.ts:232-245`）

这种设计把"是否继续"的决策权完全交给上层，loop 本身只负责"执行 + 通知"。错误恢复没有预设的 intervention 门槛，上层可以无限注入 steering，也可以一次就停止。

### 4.3 length 截断的恢复语义

pi 对 `stopReason === "length"` 的处理是 **fail 所有工具调用并继续循环**（`agent-loop.ts:211-214`）：

```typescript
const executedToolBatch =
  message.stopReason === "length"
    ? await failToolCallsFromTruncatedMessage(toolCalls, emit)
    : await executeToolCalls(...);
```

`failToolCallsFromTruncatedMessage`（`agent-loop.ts:381-406`）把每个工具调用标记为 error，让模型重新发起。这保证了截断不会丢失轮次，模型有机会修正参数。

### 4.4 错误退出条件极简

pi 仅在两种情况下退出循环（`agent-loop.ts:196-200`）：
- `message.stopReason === "error"`
- `message.stopReason === "aborted"`

其余所有情况（包括 empty response、工具错误）都会继续内层循环或外层 follow-up。这与 conex "empty-response → steering → intervention" 的三段式截断形成鲜明对比。

---

## 5. grok-build 错误恢复与续轮机制详析

### 5.1 三层错误恢复架构

grok-build 的错误恢复分为三层，各层有独立预算与职责：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 280" font-family="sans-serif" font-size="11">
  <defs>
    <marker id="arr2" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#333"/>
    </marker>
    <style>
      .layer { fill: #eaffea; stroke: #2e7d32; stroke-width: 1.5; }
      .lbl { font-weight: bold; font-size: 12px; }
    </style>
  </defs>
  <rect x="20" y="20" width="720" height="60" rx="8" class="layer"/>
  <text x="40" y="44" class="lbl">Layer 1: Sampler Retry (xai-grok-sampler/actor/request_task.rs)</text>
  <text x="40" y="62">预算: DEFAULT_MAX_RETRIES=15, RATE_LIMIT_THRESHOLD=2, doom resample 独立预算</text>
  <text x="40" y="76">职责: 传输错误 / 5xx / 429 / empty / doom-loop / payload-too-large / context-length</text>

  <rect x="20" y="100" width="720" height="60" rx="8" class="layer"/>
  <text x="40" y="124" class="lbl">Layer 2: Turn Loop (xai-grok-shell/session/acp_session_impl/turn.rs)</text>
  <text x="40" y="142">预算: max_turns, MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS=16, NUDGE_AFTER=8, TRUE_NOOPS=4</text>
  <text x="40" y="156">职责: 工具循环 / TodoGate nudge / stationarity nudge / interjection drain</text>

  <rect x="20" y="180" width="720" height="60" rx="8" class="layer"/>
  <text x="40" y="204" class="lbl">Layer 3: Session Actor (xai-grok-shell/session)</text>
  <text x="40" y="222">预算: AuthRetrySchedule, compaction suppression, rewind/fork</text>
  <text x="40" y="236">职责: 跨 turn 状态 / 凭证刷新 / 压缩 / 子代理回收</text>

  <line x1="380" y1="80" x2="380" y2="100" stroke="#333" marker-end="url(#arr2)"/>
  <line x1="380" y1="160" x2="380" y2="180" stroke="#333" marker-end="url(#arr2)"/>
</svg>
```

### 5.2 Layer 1：纯函数错误分类器

`xai-grok-sampler/src/retry.rs` 的 `classify_error` 是一个 **纯函数**（`retry.rs:144-251`），无副作用，决策可单测。它的分类逻辑有严格优先级：

```rust
// reference/grok-build/crates/codegen/xai-grok-sampler/src/retry.rs:153-250
pub fn classify_error(err: &SamplingError, retry_count: u32, max_retries: u32, rate_limit_threshold: u32) -> RetryDecision {
    if err.is_auth_error() { return RetryDecision::EmitToSession(clone_error(err)); }       // 1. auth → 交给 session
    if err.is_encrypted_content_error() { return RetryDecision::EmitToSession(clone_error(err)); }
    if max_retries == 0 { return RetryDecision::Fatal(clone_error(err)); }

    if err.is_payload_too_large() { return RetryDecision::RetryWithImageStrip; }            // 2. 413 → 剥图重试
    if err.is_image_processing_error() { return RetryDecision::RetryWithImageStrip; }
    if let Some(false) = err.should_retry_header() { return RetryDecision::Fatal(...); }    // 3. server hint
    if err.is_context_length_error() { return RetryDecision::Fatal(...); }                  // 4. context-length → 致命
    if matches!(err, SamplingError::DoomLoopDetected { .. }) {                              // 5. doom → 立即重试
        return RetryDecision::Retry { backoff: doom_loop_backoff(retry_count + 1) };
    }
    if err.is_rate_limited() { /* 429 独立阈值 */ }                                         // 6. 429 → 限流阈值
    if err.is_retryable() { /* 5xx 首次 rebuild client */ }                                 // 7. 5xx → 重建 client
    RetryDecision::Fatal(clone_error(err))                                                  // 8. 兜底致命
}
```

**关键设计要点**：

1. **错误类型决定恢复策略，而非计数器**：auth 交给 session、payload-too-large 剥图、context-length 致命、doom-loop 立即重采样。每种错误有专属路径。
2. **429 独立阈值**（`RATE_LIMIT_RETRY_THRESHOLD = 2`，`retry.rs:43`）：避免在限流上浪费长 backoff。
3. **5xx 首次重建 HTTP client**（`retry.rs:243-245`）：逃离 HTTP/2 连接池中毒。
4. **doom-loop 独立预算**（`request_task.rs:129-133`）：与传输重试预算解耦，靠" disarm abort "机制在预算耗尽后接受当前响应。
5. **`retry_only_before_output`**（`request_task.rs:158-163`）：一旦观察到输出，传输重试预算归零，避免覆盖已生成内容。

### 5.3 Layer 2：turn 内循环与 stationarity 检测

grok-build 的 turn 循环位于 `turn.rs:2189-2619`。它是一个单层 `loop`，通过 `continue` 维持工具调用循环：

```rust
// reference/grok-build/.../turn.rs:2189-2238 (简化)
let (response, latency) = match self.run_turn_via_sampler(request.clone()).await {
    Ok(SamplerTurnOutcome::Response(r, latency)) => (r, latency),
    Ok(SamplerTurnOutcome::CompactAndResubmit) => { continue; }     // 压缩后重提交
    Ok(SamplerTurnOutcome::RefreshAuthAndResubmit) => { /* backoff + continue */ }
    Err(error) => return Err(error),
};
// ... 处理 tool_calls ...
let execute_tool_calls_result = self.execute_tool_calls(tool_call_responses).await;
match execute_tool_calls_result {
    Ok(ToolLoop::FollowupMessage(followup_message)) => {             // follow-up → 续轮
        self.add_followup_message_as_user_turn(&followup_message).await;
        continue;
    }
    Ok(ToolLoop::Cancelled) => return Ok(TurnOutcome::Cancelled { ... }),
    _ => {}
}
tool_turn_count = next_turn;
// ... 预检溢出 / 压缩 / continue ...
```

**关键续轮机制**：
- **`ToolLoop::FollowupMessage`**（`turn.rs:2588-2592`）：工具返回 follow-up 时，作为 user turn 注入并 `continue`，等价于 pi 的外层 follow-up，但在同一循环内完成。
- **`CompactAndResubmit`**（`turn.rs:2195-2198`）：sampler 层触发压缩后，turn 循环直接 `continue` 重提交，不结束 turn。
- **TodoGate nudge**（`turn.rs:2400-2450`）：turn 结束前检测待办，nudge 模型继续，有 `max_fires_per_prompt` 上限，耗尽后 fall through。

**stationarity 检测**（`turn.rs:2644-2683`）：

```rust
const MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS: u32 = 16;   // 硬停
const NUDGE_AFTER_IDENTICAL_TOOL_CALLS: u32 = 8;        // 先 nudge
const MAX_CONSECUTIVE_TRUE_NOOPS: u32 = 4;              // 真空操作硬停
```

`IdenticalToolCallRun::observe` 跟踪连续相同工具调用签名，先 nudge（8 次）再硬停（16 次）；true-noop 更早硬停（4 次）。**nudge 优先于硬停，渐进式恢复**，而非 conex 的"1 次 steering → intervention"。

### 5.4 Layer 1 与 Layer 2 的预算隔离

`request_task.rs:127-133` 显示 doom-loop 有独立预算：

```rust
let doom_policy = (max_retries > 0).then_some(config.doom_loop_recovery).flatten();
let doom_max_retries = doom_policy.map_or(0, |p| p.max_retries);
let mut doom_retry_count: u32 = 0;
```

`request_task.rs:234-268` 显示 doom 失败走单独路径，**不消耗传输预算**：

```rust
if let SamplingError::DoomLoopDetected { .. } = &error {
    // ...
    let backoff = retry_mod::doom_loop_backoff(doom_retry_count + 1);
    doom_retry_count += 1;
    // ... continue with own budget
}
```

这种"按错误类型分预算"的设计，确保一种错误不会耗尽全局预算。conex 的 `maxSteeringMessages=1` 是 **全局共享预算**，任何一次 steering 都会耗尽它。

### 5.5 跨 turn 状态清理

`turn.rs:1114-1126` 在 turn 结束时清理 doom tally：

```rust
let doom_tally = std::mem::take(&mut *self.doom_loop_turn_tally.lock());
if doom_tally.fired() {
    // ... 记录 telemetry
}
```

`std::mem::take` 保证下一个 turn 从零计数，**状态不跨 turn 污染**。这是 conex 缺失的关键：conex 的 `steeringCount` 虽有 `resetSteeringCount`，但 reset 时机分散（`index.ts:481, 488, 516`），且 `preparing-turn` 阶段的扫描会读取**当前 conversation 中残留的历史错误消息**，等价于跨 run 状态污染。

---

## 6. 对比表

| 维度 | conex | pi | grok-build |
|------|-------|----|------------|
| **循环结构** | 状态机 + orchestrator 续轮双层 | 双层 while，内层工具外层 follow-up | 单层 loop，sampler 子任务 |
| **续轮入口** | 跨 run，新 run 重启 | 外层 `getFollowUpMessages` | 循环内 `continue` / `ToolLoop::FollowupMessage` |
| **工具循环条件** | 状态机 `HAS_TOOL_CALLS` → `executing-tools` → `turn-complete` | `hasMoreToolCalls = !terminate` | `tool_calls` 非空即 `continue` |
| **empty-response 处理** | steering（预算=1）→ intervention → error | 无特殊处理，继续循环 | Layer 1 重试（计入 15 次预算） |
| **错误分类** | `ErrorClassifier` + `isTransientProviderError`，分散 | 无内置分类，靠回调 | `classify_error` 纯函数，8 类优先级 |
| **重试预算** | 全局 `maxSteeringMessages=1` 共享 | 无预算，上层决定 | 按错误类型分预算（传输 15 / 限流 2 / doom 独立） |
| **length 截断** | nudge 1 次后停止 | fail 所有工具调用并继续 | Layer 1 不重试 MaxTokensTruncation |
| **stationarity** | `maxRepeatedToolCalls=3` → steering → intervention | 无 | nudge@8 / 硬停@16 / true-noop@4 |
| **跨 run/turn 状态** | conversation 残留错误消息，scan 误触发 | 单次调用，无跨 run | `std::mem::take` 清理 tally |
| **intervention 语义** | 频繁触发，终结 run | 不存在该概念 | 不存在该概念 |
| **控制流等级** | L1/L2/L3 ControlBus | AbortSignal + shouldStopAfterTurn | CancellationToken + ToolLoop 枚举 |
| **错误恢复决策点** | `handleErrorWithHook` 默认 abort | 上层回调 | 纯函数 `classify_error` + actor 执行 |

---

## 7. 根因分析

综合上述对比，conex 续轮机制不可信的根因可归结为 **四层系统性缺陷**，而非单点配置问题。

### 7.1 根因一：续轮边界跨 run，状态边界割裂

conex 的"继续"必须经过 `turn-complete → SHOULD_STOP → run() 退出 → orchestrator assessRound → 新 run`。这条链路跨越了两个独立的执行上下文（runtime / orchestrator），而两者 **没有共享的状态视图**：

- runtime 的 `steeringCount` 在新 run 会被 reset（`index.ts:481, 488`），但 `conversation` 中的历史错误消息不会清理。
- orchestrator 的 `assessGoalRound` 只看 events（`task-continuation-strategy.ts:69-73`），看不到 runtime 的 `steeringCount` 或 intervention reason。
- 新 run 的 `preparing-turn` 会 scan `conversation.getMessages()`（`index.ts:235`），把上一 run 的错误残留当作本轮的"工具错误循环"。

pi 与 grok-build 的续轮都在同一循环内完成（pi 外层 while / grok-build `continue`），状态天然连续。conex 的跨 run 续轮是架构性的状态割裂。

### 7.2 根因二：全局共享 steering 预算，无错误类型分级

`maxSteeringMessages=1` 同时充当：
- `RecoverySteeringStrategy` 的单策略预算（`recovery-steering-strategy.ts:43`）
- `SteeringCoordinator` 的全局预算（`index.ts:119`）

任何一次 steering（empty-response / tool-error-loop / repeated-tool-call）都消耗同一预算。对比 grok-build 的 8 类错误分级 + 独立预算，conex 是"一刀切"的 1 次预算，必然导致：
- 普通工具错误耗尽预算后，empty-response 无法恢复
- 一次 transient 错误就触发 intervention

### 7.3 根因三：intervention 与续轮策略语义冲突，无优先级仲裁

`TaskContinuationStrategy.assessRound` 返回 `action: "continue"`（`task-continuation-strategy.ts:97-105`）的语义是"AI 自然停止，应继续"。但 runtime 层在 `preparing-turn` 阶段的 steering 评估（`index.ts:236-242`）可能基于历史残留直接返回 `INTERVENTION_REQUIRED`，**runtime 的 intervention 优先级高于 orchestrator 的 continue，且无仲裁**。

两层策略没有共享的"是否允许继续"决策：
- orchestrator 不知道 runtime 已经 intervention
- runtime 不知道 orchestrator 想要 continue
- 结果是 intervention 总是赢，续轮策略被架空

### 7.4 根因四：错误分类粗粒度，恢复决策分散

conex 的错误处理分散在三处：
1. `handleStreamError`（`index.ts:425-469`）：处理 payload-too-large / transient，有细分类但只覆盖 streaming 阶段
2. `RecoveryCoordinator.handleErrorWithHook`（`recovery.ts:27-40`）：通用错误，默认 abort
3. `RecoverySteeringStrategy.detectRecoveryNeedFromMessages`（`recovery-steering-strategy.ts:96-102`）：基于消息扫描的 loop 检测

三者没有统一的错误分类器，也没有共享的恢复决策。grok-build 的 `classify_error` 是单一真理源（`retry.rs:144-251`），所有错误走同一函数；conex 的分类逻辑分散且语义重叠。

### 7.5 症状与根因映射

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 360" font-family="sans-serif" font-size="11">
  <defs>
    <marker id="arr3" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#b22222"/>
    </marker>
    <style>
      .root { fill: #ffe0e0; stroke: #b22222; stroke-width: 1.5; }
      .symptom { fill: #fff8e0; stroke: #b8860b; stroke-width: 1; }
      .lbl { font-weight: bold; }
    </style>
  </defs>

  <!-- 根因 -->
  <rect x="20" y="20" width="200" height="50" rx="6" class="root"/>
  <text x="120" y="42" text-anchor="middle" class="lbl">根因一</text>
  <text x="120" y="58" text-anchor="middle" font-size="10">续轮跨 run，状态割裂</text>

  <rect x="20" y="90" width="200" height="50" rx="6" class="root"/>
  <text x="120" y="112" text-anchor="middle" class="lbl">根因二</text>
  <text x="120" y="128" text-anchor="middle" font-size="10">全局共享预算，无分级</text>

  <rect x="20" y="160" width="200" height="50" rx="6" class="root"/>
  <text x="120" y="182" text-anchor="middle" class="lbl">根因三</text>
  <text x="120" y="198" text-anchor="middle" font-size="10">intervention 与续轮无仲裁</text>

  <rect x="20" y="230" width="200" height="50" rx="6" class="root"/>
  <text x="120" y="252" text-anchor="middle" class="lbl">根因四</text>
  <text x="120" y="268" text-anchor="middle" font-size="10">错误分类粗，决策分散</text>

  <!-- 症状 -->
  <rect x="500" y="40" width="200" height="40" rx="6" class="symptom"/>
  <text x="600" y="64" text-anchor="middle">单轮即断</text>

  <rect x="500" y="110" width="200" height="40" rx="6" class="symptom"/>
  <text x="600" y="134" text-anchor="middle">intervention 风暴</text>

  <rect x="500" y="180" width="200" height="40" rx="6" class="symptom"/>
  <text x="600" y="204" text-anchor="middle">续轮策略被架空</text>

  <rect x="500" y="250" width="200" height="40" rx="6" class="symptom"/>
  <text x="600" y="274" text-anchor="middle">状态污染跨 run</text>

  <!-- 箭头 -->
  <line x1="220" y1="45" x2="500" y2="55" stroke="#b22222" marker-end="url(#arr3)"/>
  <line x1="220" y1="45" x2="500" y2="195" stroke="#b22222" marker-end="url(#arr3)"/>
  <line x1="220" y1="115" x2="500" y2="125" stroke="#b22222" marker-end="url(#arr3)"/>
  <line x1="220" y1="185" x2="500" y2="135" stroke="#b22222" marker-end="url(#arr3)"/>
  <line x1="220" y1="185" x2="500" y2="195" stroke="#b22222" marker-end="url(#arr3)"/>
  <line x1="220" y1="255" x2="500" y2="265" stroke="#b22222" marker-end="url(#arr3)"/>
  <line x1="220" y1="255" x2="500" y2="55" stroke="#b22222" marker-end="url(#arr3)"/>
</svg>
```

---

## 8. 系统性重构建议

针对四个根因，提出系统性重构方向。核心原则：**续轮应在同一执行上下文内完成，错误恢复应基于错误类型分级决策，intervention 应是最后兜底而非默认行为**。

### 8.1 重构方向一：消除跨 run 续轮，回归循环内 continue

**目标**：让"AI 自然停止后继续"成为循环内行为，而非跨 run 重启。

**具体改动**：
- 在 `handleTurnComplete`（`index.ts:538-600`）中，当 `ctx.toolCallCount === 0` 且无 pending input 时，**先咨询续轮策略**（而非直接 `SHOULD_STOP`）。
- 续轮策略返回 `continue` 时，注入续轮 prompt 到 `inputQueue` 并 dispatch `INPUT_AVAILABLE`，让循环回到 `preparing-turn`，**在同一 `run()` 内继续**。
- 仅当续轮策略返回 `stop` 或达到 `maxRounds` 时才 `SHOULD_STOP`。

这与 pi 的外层 while（`agent-loop.ts:262-271`）和 grok-build 的 `ToolLoop::FollowupMessage`（`turn.rs:2588-2592`）语义对齐：续轮是循环内 `continue`，状态天然连续。

### 8.2 重构方向二：错误类型分级预算，取代全局 maxSteeringMessages

**目标**：每种错误类型有独立预算与恢复路径，避免互相耗尽。

**具体改动**：
- 引入 grok-build 式的纯函数 `classifyRecoveryNeed(error, context): RecoveryDecision`，作为单一真理源。
- 按错误类型分预算：
  - `empty-response`：3 次 steering（对齐 grok-build 的 15 次重试语义，但更保守）
  - `tool-error-loop`：2 次 steering + 1 次 nudge
  - `repeated-tool-call`：nudge@3 / 硬停@6（对齐 grok-build 的 nudge@8 / 硬停@16 比例）
  - `transient-provider`：3 次重试 + backoff
  - `context-length`：致命，不重试
  - `payload-too-large`：剥图重试 1 次
- `maxSteeringBudget` 仅作为 **所有 steering 的总兜底**（如 10），而非每种错误的共享预算。
- 移除 `maxSteeringMessages ?? 1` 的默认值，改为按类型配置。

### 8.3 重构方向三：intervention 降级为兜底，引入续轮优先级仲裁

**目标**：intervention 仅在所有恢复手段耗尽后才触发，且不能覆盖 orchestrator 的 continue 决策。

**具体改动**：
- `intervention-required` 仅在 **某错误类型的专属预算耗尽 + 续轮策略返回 stop** 时才发射。
- 在 `preparing-turn` 阶段（`index.ts:232-242`）的 steering 评估前，先查询续轮策略意图。若续轮策略明确 `continue`，则 steering 评估应跳过 `intervention-required`，仅允许 `inject-message`（nudge）。
- orchestrator 与 runtime 共享一个 `ContinuationIntent` 状态：orchestrator 写入"期望继续"，runtime 读取后抑制 intervention。

这解决了 §3.4 的语义冲突：续轮策略与 steering 不再无仲裁对抗。

### 8.4 重构方向四：跨 run 状态清理，消除消息污染

**目标**：新 run 不应被上一 run 的错误消息误判。

**具体改动**：
- 在 `preparing-turn` 的 steering 扫描（`index.ts:235`）中，**仅扫描本轮 run 产生的消息**，而非整个 `conversation`。可通过在 run 开始时记录 `runStartMessageIndex`，扫描时切片 `[runStartMessageIndex:]`。
- 对齐 grok-build 的 `std::mem::take(&mut *self.doom_loop_turn_tally.lock())`（`turn.rs:1114`）：每个 run 开始时重置 `steeringCount`、`lengthContinueNudgeCount`、`payloadRecoveryRetries` 等所有计数器，且不依赖 `conversation` 内容做 loop 检测。
- `detectRecoveryNeedFromMessages`（`recovery-steering-strategy.ts:96-102`）应改为基于 **本轮 run 的结构化事件**（如 `tool-error` 事件计数），而非扫描消息文本。消息文本是给模型的，不是给状态机的。

### 8.5 重构方向五：统一错误分类器，消除分散决策

**目标**：所有错误走同一分类函数，恢复决策集中。

**具体改动**：
- 将 `handleStreamError`（`index.ts:425-469`）、`RecoveryCoordinator.handleErrorWithHook`（`recovery.ts:27-40`）、`RecoverySteeringStrategy.detectRecoveryNeedFromMessages`（`recovery-steering-strategy.ts:96-102`）三处的分类逻辑统一到一个 `ErrorRecoveryClassifier`。
- 该分类器输入：`error` / `state` / `context{steeringCount, toolCallCount, runMessages}`，输出：`RecoveryAction { kind: 'retry'|'steer'|'nudge'|'intervene'|'fatal', budget: per-type, backoffMs? }`。
- 对齐 grok-build 的纯函数设计（`retry.rs:144-251`），确保可单测、无副作用。

### 8.6 重构后的控制流

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 480" font-family="sans-serif" font-size="11">
  <defs>
    <marker id="arr4" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#333"/>
    </marker>
    <style>
      .step { fill: #e8f4ff; stroke: #1e6091; }
      .decision { fill: #fff8e0; stroke: #b8860b; }
      .recover { fill: #eaffea; stroke: #2e7d32; }
      .stop { fill: #ffe0e0; stroke: #b22222; }
      .lbl { font-weight: bold; }
    </style>
  </defs>

  <rect x="280" y="20" width="160" height="36" rx="6" class="step"/>
  <text x="360" y="42" text-anchor="middle">streaming</text>

  <rect x="280" y="80" width="160" height="36" rx="6" class="decision"/>
  <text x="360" y="102" text-anchor="middle">classifyRecoveryNeed</text>

  <rect x="40" y="150" width="140" height="36" rx="6" class="recover"/>
  <text x="110" y="172" text-anchor="middle">retry (per-type budget)</text>

  <rect x="200" y="150" width="140" height="36" rx="6" class="recover"/>
  <text x="270" y="172" text-anchor="middle">steer / nudge</text>

  <rect x="360" y="150" width="140" height="36" rx="6" class="step"/>
  <text x="430" y="172" text-anchor="middle">executing-tools</text>

  <rect x="520" y="150" width="160" height="36" rx="6" class="stop"/>
  <text x="600" y="172" text-anchor="middle">fatal (context-length)</text>

  <rect x="280" y="220" width="160" height="36" rx="6" class="step"/>
  <text x="360" y="242" text-anchor="middle">turn-complete</text>

  <rect x="280" y="280" width="160" height="36" rx="6" class="decision"/>
  <text x="360" y="302" text-anchor="middle">续轮策略? (循环内)</text>

  <rect x="160" y="350" width="160" height="36" rx="6" class="recover"/>
  <text x="240" y="372" text-anchor="middle">continue (同 run 内)</text>

  <rect x="360" y="350" width="160" height="36" rx="6" class="stop"/>
  <text x="440" y="372" text-anchor="middle">SHOULD_STOP → run 退出</text>

  <rect x="260" y="420" width="200" height="36" rx="6" class="stop"/>
  <text x="360" y="442" text-anchor="middle">intervention (仅兜底)</text>

  <line x1="360" y1="56" x2="360" y2="80" stroke="#333" marker-end="url(#arr4)"/>
  <line x1="290" y1="116" x2="110" y2="150" stroke="#333" marker-end="url(#arr4)"/>
  <line x1="330" y1="116" x2="270" y2="150" stroke="#333" marker-end="url(#arr4)"/>
  <line x1="390" y1="116" x2="430" y2="150" stroke="#333" marker-end="url(#arr4)"/>
  <line x1="420" y1="116" x2="600" y2="150" stroke="#333" marker-end="url(#arr4)"/>

  <line x1="110" y1="186" x2="320" y2="220" stroke="#333" marker-end="url(#arr4)"/>
  <line x1="270" y1="186" x2="340" y2="220" stroke="#333" marker-end="url(#arr4)"/>
  <line x1="430" y1="186" x2="380" y2="220" stroke="#333" marker-end="url(#arr4)"/>

  <line x1="360" y1="256" x2="360" y2="280" stroke="#333" marker-end="url(#arr4)"/>
  <line x1="320" y1="316" x2="240" y2="350" stroke="#2e7d32" marker-end="url(#arr4)"/>
  <line x1="400" y1="316" x2="440" y2="350" stroke="#b22222" marker-end="url(#arr4)"/>

  <line x1="240" y1="386" x2="340" y2="420" stroke="#b22222" marker-end="url(#arr4)" stroke-dasharray="4,2"/>
  <text x="250" y="410" font-size="10" fill="#b22222">仅当预算耗尽</text>
</svg>
```

### 8.7 重构优先级

| 优先级 | 改动 | 缓解症状 | 复杂度 |
|--------|------|----------|--------|
| P0 | 消除跨 run 续轮（§8.1） | 单轮即断、续轮被架空 | 中 |
| P0 | 跨 run 状态清理（§8.4） | 状态污染、intervention 误触发 | 低 |
| P1 | 错误类型分级预算（§8.2） | intervention 风暴 | 中 |
| P1 | intervention 降级 + 仲裁（§8.3） | intervention 风暴、续轮被架空 | 中 |
| P2 | 统一错误分类器（§8.5） | 错误恢复不可预测 | 高 |

---

## 9. 结论

conex 续轮机制不可信的根本原因不是 `maxSteeringMessages=1` 这一处配置，而是 **续轮跨 run 状态割裂 + 全局共享预算 + intervention 与续轮无仲裁 + 错误分类分散** 四层系统性缺陷的叠加。单独调大 `maxSteeringMessages` 只会延缓 intervention，无法解决状态污染与续轮被架空的问题。

pi 与 grok-build 的共同经验是：
1. **续轮在循环内完成**（pi 外层 while / grok-build `continue`），状态天然连续。
2. **错误恢复基于错误类型分级**（grok-build `classify_error`），每种错误有专属预算与路径。
3. **intervention 是最后兜底**，而非首次恢复失败就触发。
4. **跨 turn/run 状态显式清理**（grok-build `std::mem::take`），不依赖消息内容做状态推断。

conex 的重构应围绕这四条原则展开，而非在现有架构上打补丁。最关键的 P0 改动是 **让续轮回到循环内**（§8.1）与 **跨 run 状态清理**（§8.4），这两项能直接消除"单轮即断"与"状态污染"两个最严重的症状，且不引入新的抽象层。
