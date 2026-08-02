# Conex Agent Loop 当前问题分析

> 本文通过实际阅读 conex 仓库下列源码得出结论：
> - `packages/agent-runtime/src/session-loop/index.ts`（核心状态机）
> - `packages/agent-runtime/src/state-machine/agent-session.ts`（状态定义与转移）
> - `packages/agent-runtime/src/steering/`（恢复纠偏策略）
> - `packages/agent-runtime/src/provider-openai-chat.ts`、`provider-openai-class.ts`、`provider-stream-contract/`（Provider 调用与流解析）
> - `packages/agent-runtime/src/runtime-components/provider-response-consumer.ts`（响应消费）
> - `packages/agent-orchestrator/src/orchestrator/dispatcher/{task,goal}-executor.ts`、`task-continuation-strategy.ts`、`task-assessment.ts`（Orchestrator 续轮）
> - `apps/crish-desktop/src/app/useEngineBootstrap.ts`、`api/engineConfig.ts`、`api/provider-profiles/profileStore.ts`（桌面配置同步）
> - `packages/agent-daemon/src/handlers/config-handlers.ts`、`server-runtime-factory/{config-assembly,index}.ts`、`daemon-provider-gateway/index.ts`（Daemon 配置与 Provider 装配）
>
> 所有结论均附带具体文件路径与行号引用，便于复核。文中所有图示为纯文字流程图（遵循用户规则：不使用 emoji）。

---

## 1. 问题概述

### 1.1 现象

测试观察到的故障链：

1. 用户在桌面端发送消息后，AI 仅回复一次（且多为文本说明或"我将调用工具"的陈述），随后会话即告终态。
2. Daemon 日志出现 `Runtime intervention required`，且 `toolCount=0`（即整轮没有任何 `tool-call` block 进入执行）。
3. 即便 AI 在文本中"声称"已发起工具调用，`provider-openai-chat.ts` 的 streaming parser 也没有产出 `tool-call` 事件，下游 `ProviderResponseConsumer` 因此构造出 `empty-response` 或仅含文本的 `message`。
4. Daemon 日志同时出现 `Runtime config validation warnings`（`modelId`、`provider.baseUrl` 缺失）以及 `provider_factory_missing`。

### 1.2 业务后果

- 单条消息即触发 `runtime-intervention-required` → 上抛到 `task-assessment.ts:333` 直接转化为 `failed` 终态，run 立即结束，无法进入续轮。
- 用户感受到的"AI 失灵、不会连续调用工具"，根因不在 AI 模型本身，而在 loop 的状态机触发条件、steering 预算、provider parser 的静默丢弃、daemon 配置不持久化等多层缺陷的叠加。
- 这些缺陷相互耦合：任意单点修复（如把 `maxSteeringMessages` 调大）只能延缓 intervention，无法解决"AI 工具调用未被解析"的根本问题。

### 1.3 问题分层

按"上下游责任"分层：

| 层 | 文件 | 关键缺陷 |
| --- | --- | --- |
| L1 状态机 | `session-loop/index.ts`、`state-machine/agent-session.ts` | 无 tool_call 即 `SHOULd_STOP`；`STEERING_NEEDED` 路径在 `maxSteeringMessages=1` 下二次空响应即 `INTERVENTION_REQUIRED` |
| L2 纠偏 | `steering/recovery-steering-strategy.ts`、`steering-coordinator.ts` | 预算默认 1，预算耗尽即升级为 `intervention-required` 而非降级为 `block`；不区分"工具未解析"与"AI 真的没动作" |
| L3 Provider 解析 | `provider-openai-chat.ts`、`provider-stream-contract/normalizer.ts` | `function.name` 缺失的 `tool_calls` 被静默丢弃，无 `provider-diagnostic` 事件可观测 |
| L4 Orchestrator | `task-continuation-strategy.ts`、`task-assessment.ts` | Task 模式 `stalledRounds` 恒 0、`maxRounds=50`，AI 自然停止时永远 `continue`，掩盖了真实故障；intervention-required 直接 `failed`，不进入续轮挽救 |
| L5 配置同步 | `useEngineBootstrap.ts`、`engineConfig.ts`、`config-handlers.ts`、`config-assembly.ts` | Daemon 不持久化 Provider 配置，重启后内存丢失；`runtimeConfigFromDaemonConfig` 返回空对象，daemon 配置文件不承载 model/baseUrl |
| L6 可观测性 | `apps/crish-desktop/src/api/**` | 桌面端未识别 `runtime-intervention-required` 事件类型，用户只能看到通用失败 |

---

## 2. 状态机流程图

### 2.1 conex 当前状态机（文字流程图）

```
                    INITIALIZED
                        |
                        v
                  awaiting-input
                        | INPUT_READY
                        v
                  preparing-turn
                        | TURN_PREPARED (turnIndex++, toolCallCount=0)
                        v
                      streaming ──────[provider stream]──────► (consumeResult)
                        |                                            |
                        |   HAS_TOOL_CALLS                          |   NO_TOOL_CALLS
                        |       |                                   |       |
                        |       v                                   |       v
                        |   executing-tools                          |   turn-complete
                        |       |                                   |       |
                        |       | TOOLS_COMPLETE                     |       | SHOULD_STOP / NEXT_TURN
                        |       v                                   |       v
                        |   turn-complete <──────────────────────────┘   done
                        |
                        |   (ar.type === 'empty-response')
                        |       |
                        |       v
                        |   steering-evaluation ──[STEERING_COMPLETE]──> preparing-turn
                        |       |
                        |       | STEERING_BUDGET_EXHAUSTED / INTERVENTION_REQUIRED
                        |       v
                        |   turn-complete (endReason=error)
                        |
                        |   INTERVENTION_REQUIRED (直接转 turn-complete, endReason=error)
                        v
                    turn-complete ──[SHOULD_STOP]──> done
```

### 2.2 关键转移（`packages/agent-runtime/src/state-machine/agent-session.ts`）

- L122：`streaming` --`STEERING_NEEDED`--> `steering-evaluation`（注释明确："Do not bump steeringCount here"）
- L166：`steering-evaluation` --`STEERING_COMPLETE`--> `preparing-turn`（重新进入 provider loop）
- L168-173：`steering-evaluation` --`STEERING_BUDGET_EXHAUSTED`/`INTERVENTION_REQUIRED`--> `turn-complete`（endReason=error）
- L124-127：`streaming` --`INTERVENTION_REQUIRED`--> `turn-complete`（endReason=error）  ← **直接终止 run，不进入续轮**
- L221：`turn-complete` --`NEXT_TURN`--> `preparing-turn`（仅在 `toolCallCount > 0` 时由 `handleTurnComplete` 派发）

### 2.3 失败路径示意

```
[AI 输出无 tool_call 事件]
     |
     |  blocks.length===0  → ar.type="empty-response"  → STEERING_NEEDED
     |                                                  |
     |                                                  v
     |                                       steering-evaluation (steeringCount=0)
     |                                                  |
     |                                                  | inject-message (steeringCount→1)
     |                                                  v
     |                                            preparing-turn → streaming
     |                                                  |
     |                                       (仍 empty-response)
     |                                                  |
     |                                                  v
     |                                       steering-evaluation (steeringCount=1)
     |                                                  |
     |                                                  | 1>=maxSteeringMessages(1)
     |                                                  | → intervention-required
     |                                                  v
     |                                           INTERVENTION_REQUIRED
     |                                                  |
     |                                                  v
     |                                        turn-complete (endReason=error)
     |                                                  |
     v                                                  v
  agent-end reason=error                  runtime-intervention-required event
     |                                                  |
     v                                                  v
  Orchestrator driveGoalRun: terminalAssessmentFromEvents() 检测到上述任一事件
     |
     v
  run.status=failed, outcome=failed, reason="intervention-required" / "agent-error"
```

---

## 3. 问题点逐一分析

### 3.1 问题 1：`maxSteeringMessages=1` 默认值过于严格，二次空响应即终止 run

**代码位置**

- `packages/agent-runtime/src/runtime-defaults.ts:61-66`
  ```ts
  recovery: {
    enabled: true,
    maxConsecutiveToolErrors: 2,
    maxRepeatedToolCalls: 3,
    maxSteeringMessages: 1
  },
  ```
- `packages/agent-runtime/src/session-loop/index.ts:115-119`
  ```ts
  this.steering = new SteeringDelegate(new SteeringCoordinator(conversation, [new RecoverySteeringStrategy({
    maxConsecutiveToolErrors: ro?.maxConsecutiveToolErrors, maxRepeatedToolCalls: ro?.maxRepeatedToolCalls,
    maxSteeringMessages: ro?.maxSteeringMessages ?? 1,
  })], { maxSteeringBudget: ro?.maxSteeringMessages ?? 1 }));
  ```
- `packages/agent-runtime/src/steering/recovery-steering-strategy.ts:46-54`
  ```ts
  evaluate(phase: SteeringPhase, context: SteeringContext): SteeringAction | null {
    if (phase === "empty-response") {
      if (context.steeringCount >= this.maxSteeringMessages) {
        return {
          type: "intervention-required",
          reason: "empty-response",
          message: "The agent did not recover after runtime steering."
        };
      }
      ...
  ```

**问题分析**

- `maxSteeringMessages=1` 意味着 `RecoverySteeringStrategy` 仅允许一次 `empty-response` 注入纠偏消息；第二次 `empty-response` 即返回 `intervention-required`。
- `intervention-required` 在 `session-loop/index.ts:240` 与 `:503` 立即 `dispatch('INTERVENTION_REQUIRED')` 并返回 `{ endReason: 'error', endError: 'Runtime intervention required' }`，状态机 L124-127 将 `streaming` 直接迁到 `turn-complete (endReason=error)`，整个 `run()` 退出。
- 上传到 orchestrator 的 `runtime-intervention-required` 事件被 `task-assessment.ts:333-340` 视为终态失败（`state="failed", runReason="intervention-required"`），`driveGoalRun` 在 `goal-executor.ts:170-173` 直接 `completeGoalRun` 并 break，**根本不进入续轮挽救**。

**根因**

- "一次纠偏后未恢复" 在语义上不等价于 "run 失败"。当前实现把"无法自救"的局部决策与"run 终态失败"耦合在一起。
- `maxSteeringMessages` 在产品默认值（1）、策略默认值（1）、coordinator 默认值（3 但被覆盖为 1）之间不一致，但最严格的产品默认值压倒了所有上层默认，导致生产行为最差。

---

### 3.2 问题 2：`handleSteeringEvaluation` 的 maxSteering 默认值与策略/Coordinator 不一致

**代码位置**

- `packages/agent-runtime/src/session-loop/index.ts:493-506`
  ```ts
  private async *handleSteeringEvaluation(): AsyncGenerator<AgentEvent, HandlerResult> {
    const ctx = this.machine.getContext();
    const maxSteering = this.options.recovery?.maxSteeringMessages ?? 3;
    if (ctx.steeringCount > maxSteering) { this.dispatch('STEERING_BUDGET_EXHAUSTED'); return { endReason: 'error', endError: 'Steering budget exhausted' }; }

    const sc = { ... };
    const evaluation = this.steering.evaluate('empty-response', sc);
    if (evaluation.actions.length === 0) { this.dispatch('STEERING_BUDGET_EXHAUSTED'); return { endReason: 'error', endError: 'No steering strategy handled empty response' }; }
    ...
  ```

**问题分析**

- 这里默认值是 `?? 3`，但 `RecoverySteeringStrategy` 默认是 `?? 1`（`recovery-steering-strategy.ts:43`），`SteeringCoordinator` 走 `maxSteeringBudget: ro?.maxSteeringMessages ?? 1`（`index.ts:119`）。
- 当 `recovery` 配置完全缺失时，三处默认值不一致；当 `recovery.maxSteeringMessages` 显式为 1 时，三处均被覆盖为 1（但 `handleSteeringEvaluation` 内的 `> maxSteering` 比较永远比 `>= maxSteeringMessages` 晚一拍，永远不会先于策略触发）。
- 后果：`handleSteeringEvaluation` 中的 `ctx.steeringCount > maxSteering` 检查实际上是死代码（dead code）—— `RecoverySteeringStrategy` 在 `steeringCount >= 1` 时已先返回 `intervention-required`，永远不会让 steeringCount 增长到 2 来触发 `STEERING_BUDGET_EXHAUSTED` 路径。
- 这进一步说明：当前 steering 模块的预算语义在三处独立维护，没有任何单一权威源（single source of truth），修复时易引入新不一致。

---

### 3.3 问题 3：Provider streaming parser 静默丢弃 `function.name` 缺失的 tool_call

**代码位置**

- `packages/agent-runtime/src/provider-openai-chat.ts:109-113`
  ```ts
  if (Array.isArray(delta.tool_calls)) { for (const raw of delta.tool_calls) mergeToolCallDelta(pending, raw); }
  ...
  for (const call of pending.values()) { if (call.name) yield { type: "tool-call", id: call.id, toolName: call.name, input: parseArguments(call.argumentsText) }; }
  yield { ...finishReason, ...(usage !== undefined ? { usage } : {}) };
  ```
- `packages/agent-runtime/src/provider-openai-chat.ts:116-126`
  ```ts
  function mergeToolCallDelta(pending: Map<number, PendingToolCall>, raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const record = raw as Record<string, unknown>;
    const index = typeof record.index === "number" ? record.index : pending.size;
    const current = pending.get(index) ?? { id: `call_${index}`, name: "", argumentsText: "" };
    if (typeof record.id === "string") current.id = record.id;
    const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : undefined;
    if (typeof fn?.name === "string") current.name = fn.name;
    if (typeof fn?.arguments === "string") current.argumentsText += fn.arguments;
    pending.set(index, current);
  }
  ```

**问题分析**

- 解析器只识别 `record.function.name` / `record.function.arguments` 这种标准 OpenAI 嵌套结构。
- 一旦 provider（或上游代理）使用了变体字段（如 `function_name`、`name` 直接挂在 call 上、`function_call` 而非 `function`），`current.name` 永远停留在 `""`，循环末尾的 `if (call.name)` 过滤将其静默丢弃，**不产生任何 `tool-call` 事件，也不产生任何 `provider-diagnostic` 事件**。
- 后果：
  - 若 AI 文本块也缺失（部分 provider 仅返回 `tool_calls` 字段无 `content`），`ProviderResponseConsumer` 的 `blocks` 数组为空 → `ar.type="empty-response"` → 进入 §3.1 的 steering→intervention 死路。
  - 即便有少量文本，AI "声称"调用了工具，但 `toolCallCount=0`，用户与 daemon 都无法感知"工具调用被解析器丢了"。
- `parseChatCompletionsJsonResponse`（行 58-76）的非流式分支同样依赖 `parseFullToolCall`（行 128-134），`fn.name` 缺失即返回 `null`，同样是静默丢弃。

**根因**

- 解析器把"无法识别的 tool_call 结构"等同于"未发起 tool_call"，缺乏显式的 `provider-diagnostic` 上报通道，违反"无法自救的局部错误不得静默"原则。
- 现有 `provider-diagnostic` 通道仅用于 HTTP 错误与重试，未覆盖"语义级解析失败"。

---

### 3.4 问题 4：`detectRecoveryNeedFromMessages` 无法识别"AI 文本中提到工具调用但无 tool_call block"

**代码位置**

- `packages/agent-runtime/src/runtime-helpers.ts:49-67`、`:98-116`
  ```ts
  export function detectRecentToolErrorLoop(messages: AgentMessage[], minErrors: number): RuntimeRecoveryReason | undefined {
    let errors = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!;
      if (message.role === 'system' || message.role === 'assistant') continue;
      if (message.role === 'user') break;
      if (message.role !== 'tool') continue;
      ...
  }

  export function detectRepeatedToolCallLoop(messages: AgentMessage[], minRepeats: number): RuntimeRecoveryReason | undefined {
    const counts = new Map<string, number>();
    for (let index = messages.length - 1; index >= 0; index--) {
      ...
      if (message.role !== 'assistant') continue;
      for (const block of message.blocks) {
        if (block.type !== 'tool-call') continue;
        ...
  ```

**问题分析**

- 这两个检测函数只扫描结构化的 `tool-result` / `tool-call` block，从不检视 assistant 文本中是否出现"我调用了 X 工具"之类的语义线索。
- 当 §3.3 的 parser 丢弃了 tool_call 时，`detectRecoveryNeedFromMessages` 既看不到 `tool-call`（被丢了），也看不到 `tool-result`（从未执行），返回 `null`，steering 在 `after-tools` 阶段不会触发。
- 在 `empty-response` 阶段，`RecoverySteeringStrategy` 走的是分支 `if (phase === "empty-response")`（`recovery-steering-strategy.ts:47`），不依赖上述两个检测函数，但仍只机械注入"do not stop silently"类提示，无法引导 AI 把丢失的工具调用结构重新发起。

**根因**

- steering 策略对"故障"的认知仅基于结构化事件，缺少对"AI 期望行为 vs 实际事件流"的差异检测；当 parser 静默吞掉 tool_call 时，steering 也跟着失明。

---

### 3.5 问题 5：`ProviderResponseConsumer` 的 `empty-response` 判定过严

**代码位置**

- `packages/agent-runtime/src/runtime-components/provider-response-consumer.ts:125-133`
  ```ts
  const response: AssistantResponse =
    blocks.length === 0 && !error
      ? { type: "empty-response" }
      : error && blocks.length === 0
        ? { type: "error", error }
        : { type: "message", message: this.buildMessage(blocks, textBuffer, thoughtBuffer, error, usage, finishReasonFromStream) };
  ```

**问题分析**

- `blocks.length === 0` 即视为 `empty-response`，但 `blocks` 中既包含 text/thought delta，也包含 `tool-call` block（`provider-response-consumer.ts:81-95`，仅在 `event.phase === "end"` 时收集）。
- 由于 §3.3 中 parser 在 `function.name` 缺失时根本不 yield `tool-call` 事件，导致 `blocks` 为空。但即便有 `tool-call` 事件且 `phase` 不是 `"end"`（例如 sequencer/normalizer 没有补齐 phase），也不会被收集。
- 这个判定本身没有错，但它把上游所有"看似 AI 没动作"的歧义场景全部归一为 `empty-response`，缺乏 `diagnostic` 通道说明"为何 blocks 为空"。

**根因**

- Consumer 是被动的：它只看事件流，不感知上游 parser 的丢弃行为。可观测性需要 parser 主动发 diagnostic，但 parser 没有这能力（§3.3）。

---

### 3.6 问题 6：Orchestrator `TaskContinuationStrategy` 把所有"无显式 decision"的停止一律视为 `continue`

**代码位置**

- `packages/agent-orchestrator/src/task-continuation-strategy.ts:61-106`
  ```ts
  assessRound(input: { ... }): GoalContinuationDecision {
    const assessment = assessGoalRound({ ... });

    if (
      assessment.state === "cancelled" ||
      assessment.state === "failed" ||
      assessment.state === "completed" ||
      assessment.explicitDecision
    ) {
      return goalContinuationDecisionFromAssessment(assessment);
    }

    const messageMarkerDecision = goalContinuationDecisionFromEvents(input.events);
    if (messageMarkerDecision) {
      return messageMarkerDecision;
    }

    // AI 自然停止 → continue
    return {
      action: "continue",
      reason: "task-continuation",
      prompt: this.continuePrompt,
      ...
    };
  }
  ```
- `packages/agent-orchestrator/src/orchestrator/dispatcher/task-executor.ts:50-57`
  ```ts
  const DEFAULT_TASK_MAX_ROUNDS = 50;
  const DEFAULT_TASK_MAX_STALLED_ROUNDS = 1000;
  ```

**问题分析**

- Task 模式 `stalledRounds` 恒为 0（注释明确：task 模式不跟踪 stall），`maxStalledRounds=1000` 仅作兜底。
- AI 自然停止（无 `CONEX_GOAL_DECISION` 标记）时一律注入 `DEFAULT_CONTINUE_PROMPT`（`task-continuation-strategy.ts:150-151`）继续下一轮。
- 但 §3.1 的 `intervention-required` 已经在 `assessment.state==="failed"` 路径上把 run 标记为失败，所以这条"continue"分支永远没有机会挽救 `intervention-required` 的 run——挽救只在 `state==="blocked"` 或 `"no-progress"` 时触发。
- 对真正"AI 不想做事"的场景，task 模式会无意义地循环 50 轮（每轮注入同一段 `Continue your work. ...`），直到 `goal.completedRounds >= goal.maxRounds`（`goal-executor.ts:76-82`）触发 `goal-max-rounds` blocked。
- `DEFAULT_CONTINUE_PROMPT` 的内容过于通用，对"工具调用被 parser 丢失"这种根因完全无效，AI 第二轮仍会重复同样的（被丢失的）工具调用。

**根因**

- 续轮策略与下游 runtime 的失败语义不对齐：runtime 把 `intervention-required` 视为终态错误，orchestrator 也把它视为终态错误，但 runtime 同时又把"AI 自然停止无显式 decision"留给 orchestrator 自行决定，两者对"AI 没动作"的判别口径不一致。
- "stalledRounds 恒 0"的设计假设了"AI 不动 = 不算 stall"，但当根因是 parser 丢弃 tool_call 时，AI 其实是"动了但没被记录"，stall 检测失真。

---

### 3.7 问题 7：Daemon 不持久化 Provider 配置，重启后配置丢失

**代码位置**

- `packages/agent-daemon/src/daemon-provider-gateway/index.ts:54-93`
  ```ts
  export class DaemonProviderGatewayController {
    private config: NormalizedDaemonProviderRuntimeConfig;
    ...
    update(update: DaemonProviderRuntimeConfigUpdate): void {
      const nextConfig = { ...this.config, ...definedConfigUpdate(update) } as DaemonProviderRuntimeConfig;
      ...
      this.config = normalizeConfig(nextConfig);
      this.gatewayValue = this.createGateway();
      ...
    }
  ```
  全部状态在内存 `this.config`，无持久化逻辑。
- `packages/agent-daemon/src/server-runtime-factory/config-assembly.ts:47-51`
  ```ts
  function runtimeConfigFromDaemonConfig(
    config: DaemonConfig
  ): Record<string, unknown> {
    return {};
  }
  ```
- `apps/crish-desktop/src/app/useEngineBootstrap.ts:25-37`
  ```ts
  const unsub = client.onState((s) => {
    if (s === 'connected' || client.hasEverConnected()) {
      setEngineReady(true);
    }
    if (s === 'connected') {
      // 重连后重新推送 provider 配置到 daemon，防止 daemon 重启后丢失 apiKey/baseUrl/model
      void import('../api/providerProfiles').then(
        ({ syncActiveProfileToEngine }) => {
          void syncActiveProfileToEngine();
        }
      );
    }
  });
  ```
- `apps/crish-desktop/src/api/provider-profiles/profileStore.ts:565-602`（`syncActiveProfileToEngine` 实现）

**问题分析**

- Daemon 的 `DaemonProviderGatewayController` 只持有内存态 `config`；重启进程后内存清零，回到 `unconfiguredProviderStatus()`（`server-runtime-factory/index.ts:294-303`），返回 `provider_factory_missing`。
- 桌面端 `useEngineBootstrap` 仅在 WebSocket 状态变为 `connected` 时才推送 `syncActiveProfileToEngine`，但：
  - daemon 进程重启后，旧 WebSocket 不会自动重连，需要等 keep-alive 触发新连接；
  - `syncActiveProfileToEngine` 内部 `await activateProfileModel(...)` 是异步的，期间任何 `startRun` 会拿到空配置装配出 `providerFactory_missing` 状态的 Provider，触发 `Runtime config validation warnings`。
- `runtimeConfigFromDaemonConfig` 故意返回 `{}`，意图是 daemon 配置文件不承载 provider 凭证（安全考虑），但副作用是 daemon 重启后完全没有任何兜底配置层，必须依赖桌面端实时推送。

**根因**

- "Daemon 不持久化 + 桌面端单点推送" 的设计假设了"桌面端总是先于用户的发送动作连上 daemon"。但用户在 daemon 重启后立即发消息是真实场景，特别是 keep-alive 重连窗口可能长达数秒到十几秒。
- 安全要求（不落盘 apiKey）与可用性要求（daemon 重启即可用）之间没有妥善折中——可以持久化 model/baseUrl/credentialMode 而不持久化 apiKey，重启后用 placeholder apiKey + credentialMode='account-center'/'auto' 触发凭证解析器重新拉取。

---

### 3.8 问题 8：Daemon runtime config 不读 `maxSteeringMessages`，无法 per-run 覆盖

**代码位置**

- `packages/agent-daemon/src/server-runtime-factory/config-assembly.ts:91-114`
  ```ts
  function runtimeConfigFromRunMetadata(metadata: JsonObject | undefined): Record<string, unknown> {
    if (!metadata) return {};
    const result: Record<string, unknown> = {};

    const maxRounds = numberMetadata(metadata, "maxRounds");
    if (maxRounds !== undefined) result.maxTurns = maxRounds;

    if (metadata.permissionMode !== undefined) { ... }
    const depth = numberMetadata(metadata, "subagentDepth");
    if (depth !== undefined) result.subagentDepth = depth;
    const timeout = numberMetadata(metadata, "timeoutMs");
    if (timeout !== undefined) result.timeoutMs = timeout;
    return result;
  }
  ```

**问题分析**

- `runtimeConfigFromRunMetadata` 只读 `maxRounds`/`permissionMode`/`subagentDepth`/`timeoutMs`，不读 `maxSteeringMessages`、`maxConsecutiveToolErrors`、`maxRepeatedToolCalls`。
- 即便桌面端或用户希望对某个 run 放宽 steering 预算（例如对长任务允许 5 次 steering），也没有 metadata 通道传入；只能改 `runtime-defaults.ts:65` 的全局默认值，但这会同时影响所有 run。
- 这导致 §3.1 的修复必须修改全局默认，而不能在 run 级别做精细化策略。

**根因**

- runtime config 层级（default → daemon-config → env → run-metadata）虽设计为可叠加，但 `recovery` 子对象在 `runtimeConfigFromRunMetadata` 完全不读，等于 `recovery` 配置只能来自 `createProductRuntimeDefaults` 的硬编码默认或 daemon env，无法在 run 启动时按需调整。

---

### 3.9 问题 9：桌面端不识别 `runtime-intervention-required` 事件

**代码位置**

- 全工程搜索结果：
  ```
  c:\Software\conex\apps\crish-desktop\src  无任何 "intervention-required" / "intervention_required" / "interventionRequired" 匹配
  ```
- `packages/agent-runtime/src/event-architecture/canonical-event.ts:489-492` 把 `runtime-intervention-required` 列为合法事件类型。
- `packages/agent-orchestrator/src/orchestrator/agent-loop.ts:689-691` 把它转为 `RunCompletion { status: "failed", outcome: "failed", reason: "intervention-required" }`。

**问题分析**

- 桌面端没有针对 `runtime-intervention-required` 的专门 UI 处理，用户只能看到 run 失败，看不到 daemon 给出的 `choices: ["rollback", "pause", "user-instruction"]`（`steering-coordinator.ts:159`）。
- 这意味着即使 daemon 内部已经识别出"需要用户介入"，桌面端也无法把"介入请求"暴露给用户做选择，只能让用户重新发消息。
- 用户的重发消息进入新一轮 run，但根因（parser 丢 tool_call、steering 预算=1）未变，重复触发的概率极高。

**根因**

- 桌面端事件 schema 与 daemon 事件类型存在已知集合差，但缺一致性校验：daemon 新增事件类型时，桌面端没有对应的 lint/契约校验强制实现处理路径。

---

### 3.10 问题 10：`handlePrepareTurn` 在 `before-turn` 阶段也跑 `RecoverySteeringStrategy`，可能误触发 `intervention-required`

**代码位置**

- `packages/agent-runtime/src/session-loop/index.ts:232-242`
  ```ts
  if (ro?.enabled !== false) {
    const ctx = this.machine.getContext();
    const sc = { messages: this.conversation.getMessages(), turnIndex: ctx.turnIndex, steeringCount: this.steering.steeringCoordinator.getSteeringCount(), toolCallCount: ctx.toolCallCount, hasPendingInput: this.inputQueue.hasPending() };
    for (const phase of ['after-tools', 'before-turn'] as const) {
      const evalResult = this.steering.evaluate(phase, sc);
      const applied = this.steering.apply(evalResult.actions, this.sessionId);
      yield* flushEvents(applied.events);
      if (applied.interventionRequired) { this.dispatch('INTERVENTION_REQUIRED'); return { endReason: 'error', endError: 'Runtime intervention required' }; }
    }
  }
  ```

**问题分析**

- `RecoverySteeringStrategy.phases = ["after-tools", "empty-response"]`（`recovery-steering-strategy.ts:34`），所以 `before-turn` 阶段它返回 `null`，`evalResult.actions.length === 0`，`applied.interventionRequired === false`，不会触发。
- 但这段代码的脆弱性在于：未来如果新增一个声明 `phases: ["before-turn"]` 的策略且返回 `intervention-required`，会直接把 run 终态失败掉，没有任何"延后到下一安全点"的语义。
- 同时 `after-tools` 阶段也会在 `handlePrepareTurn` 内被跑一遍——这与 `handleExecutingTools` 完成后的语义重叠（`handleExecutingTools` 也通过 `applySafePointControl` 间接检查 controlBus，但不重新跑 steering），存在"steering 在 preparing-turn 内被重复评估"的隐患（参见 `recovery-steering-strategy.ts:70` 的 `if (context.steeringCount >= this.maxSteeringMessages)` 分支）。

**根因**

- `handlePrepareTurn` 把 `after-tools` 评估与 `before-turn` 评估放在同一个 for 循环里跑，没有区分"上一轮是否真的执行过工具"。即便 `toolCallCount=0`，`detectRecoveryNeedFromMessages` 也会扫一遍消息历史，开销与误检风险同时存在。

---

## 4. 根因分析

把上述 10 个问题点按因果链归纳，可以得到 3 条根因：

### 4.1 根因 A：steering 预算与"run 终态失败"耦合（架构性）

`maxSteeringMessages=1` 的产品默认值，叠加 `RecoverySteeringStrategy.evaluate('empty-response')` 在 `steeringCount >= maxSteeringMessages` 时直接返回 `intervention-required`，使 steering 失去"反复尝试"的语义，退化成"一次重试"。

`intervention-required` 在状态机层被映射为 `turn-complete(endReason=error)`，在 orchestrator 层被映射为 `run.status=failed`，**两层都把"runtime 无法自救"等同于"run 终态失败"**，没有任何"暂停等待用户介入"或"重置预算再试"的中间态。

正确的语义应当是：

- `intervention-required` 是一种"软失败"信号，应当让 run 进入 `awaiting-approval` 或 `paused` 状态，把 `choices: ["rollback", "pause", "user-instruction"]` 暴露给用户；
- 只有用户显式选择 `rollback` 或 `pause` 时才终止 run；选择 `user-instruction` 时把用户输入作为新的 steering message 注入并重置 steeringCount。

### 4.2 根因 B：Provider parser 的"静默丢弃"破坏了可观测性契约（实现性）

`parseChatCompletionsStreamingResponse` 在 `function.name` 缺失时静默丢弃 tool_call，违反了"无法识别的输入必须显式上报"的契约。

这导致：

- 下游 `ProviderResponseConsumer` 收到空事件流，构造 `empty-response`，但 `empty-response` 这个标签本身不携带"为何空"的诊断信息；
- `detectRecoveryNeedFromMessages` 也无法识别这种"AI 想调工具但 parser 丢了"的语义，因为消息历史中既无 `tool-call` 也无 `tool-result`；
- steering 注入的纠偏消息对 AI 是误导（"Do not stop silently"），AI 实际上"没有 silently stop"——它确实尝试了工具调用，只是被吞了。

正确的设计应当是：parser 任何"识别失败"都应 emit `provider-diagnostic { phase: "invalid-tool-call", reason: "function.name missing" }`，让下游能区分"AI 真的没动作"与"parser 丢了 AI 的动作"。

### 4.3 根因 C：Daemon 配置生命周期与 Run 生命周期未解耦（运维性）

`DaemonProviderGatewayController.config` 仅存在于内存，daemon 重启即清零。桌面端 `useEngineBootstrap` 在 WebSocket `connected` 事件时才推送 `syncActiveProfileToEngine`，存在"daemon 重启 → 用户立即发消息 → run 启动时 provider 还未到位"的窗口。

`runtimeConfigFromDaemonConfig` 故意返回 `{}` 把 provider 凭证完全排除在 daemon 配置文件之外（安全考虑），但没有任何替代的"非凭证字段（model/baseUrl/credentialMode）从磁盘恢复"的路径——daemon 重启后即使 model/baseUrl 也丢失，这超出了安全要求（安全只要求不落盘 apiKey）。

`runtimeConfigFromRunMetadata` 不读 `maxSteeringMessages` 等恢复参数，使得 run 启动时无法按需放宽 steering 预算。这把 §3.1 的修复逼到只能改全局默认值，无法做 per-run 精细化。

### 4.4 三条根因的耦合关系

```
   [根因 C: daemon 配置丢失] ──┐
                               │ provider_factory_missing
                               v
                        [run 以空 Provider 启动]
                               │
                               │ AI 调用工具 → 上游因 baseUrl 缺失返回错误
                               v
                        [AI 改为只发文本 / 工具调用结构非标准]
                               │
   [根因 B: parser 静默丢弃] ──┤
                               │ tool_call 被吞 → empty-response
                               v
                        [steering 注入纠偏]
                               │
   [根因 A: 预算=1 + 终态耦合] ─┤
                               │ 二次空响应 → intervention-required
                               v
                        [run 终态失败: Runtime intervention required]
                               │
                               v
                        [桌面端只看到通用失败，无介入选项]
```

任一单点修复（如只调大 `maxSteeringMessages`、只修 parser、只持久化 daemon 配置）都只能延缓或绕过部分症状，无法根治。

---

## 5. 修复建议（系统化）

按"先解决根因，再解耦耦合，最后补可观测性"的顺序给出系统化改进方案。所有建议都要求做"结构化重构"，而不是补丁式修改。

### 5.1 建议 1：把 `intervention-required` 重定义为软失败状态（解耦根因 A）

**目标**：steering 预算耗尽不再直接终止 run，而是把 run 推入 `awaiting-intervention` 状态，等待用户决策。

**改动范围**

1. `packages/agent-runtime/src/state-machine/agent-session.ts` 新增状态 `awaiting-intervention`：
   ```
   streaming/steering-evaluation --INTERVENTION_REQUIRED--> awaiting-intervention
   awaiting-intervention --USER_ROLLBACK--> done (endReason=aborted)
   awaiting-intervention --USER_PAUSE--> done (endReason=stop)
   awaiting-intervention --USER_INSTRUCTION--> preparing-turn (重置 steeringCount=0)
   ```
2. `packages/agent-runtime/src/session-loop/index.ts:240`、`:503` 不再返回 `endReason: 'error'`，而是 emit `runtime-intervention-required` 事件后让状态机停在 `awaiting-intervention`，并通过 `ControlBus` 注册一个 `pendingApproval`-style 的等待队列。
3. `packages/agent-runtime/src/steering/steering-coordinator.ts:152-163` 的 `intervention-required` action 不再发 `choices` 字段，改为发 `requestId`，由桌面端 ApprovalPipeline 走与 `approval-requested` 同构的 UI 路径（已存在 `approval-handlers.ts`）。
4. `packages/agent-orchestrator/src/orchestrator/dispatcher/task-executor.ts:225-263` `applyRuntimeEventStatus` 把 `runtime-intervention-required` 映射为 `run.status="awaiting-approval"`（已存在状态），而不是 `failed`。
5. `packages/agent-orchestrator/src/task-assessment.ts:333-340` 不再把 `runtime-intervention-required` 视为 `failed` terminal 事件；改为 `state="blocked"`，让 `TaskContinuationStrategy.assessRound` 走显式 `block` 路径。

**收益**：根因 A 解耦。即使用户碰到 intervention，也能在 UI 上选择"重新指令"或"回滚"，而不是被迫重发消息。

### 5.2 建议 2：统一 steering 预算语义为单一权威源（消除 §3.1、§3.2、§3.10 的不一致）

**目标**：消除三处独立 `maxSteeringMessages` 默认值，集中到 `SteeringCoordinator` 一处。

**改动范围**

1. `packages/agent-runtime/src/steering/recovery-steering-strategy.ts` 删除 `maxSteeringMessages` 字段，策略不再持有预算；改为只判定"是否需要纠偏"，由 `SteeringCoordinator` 在 `apply()` 时检查预算。
2. `packages/agent-runtime/src/steering/steering-coordinator.ts` 把 `evaluate()` 改为返回 `actions` 后由 `apply()` 统一检查预算：超预算时把 `inject-message` 转换为 `intervention-required`，而不是让每个策略各自判断。
3. `packages/agent-runtime/src/session-loop/index.ts:495` 的 `handleSteeringEvaluation` 删除本地 `maxSteering` 检查（已成为死代码），完全委托给 `SteeringCoordinator`。
4. `packages/agent-runtime/src/runtime-defaults.ts:65` 把 `maxSteeringMessages` 从 1 提升到 3（与 `SteeringCoordinatorOptions.maxSteeringBudget` 默认值 3 对齐），同时引入"恢复预算"语义：每成功执行一次工具调用，`steeringCount` 减 1（而非完全 reset），允许长任务有更多纠偏空间。
5. `packages/agent-daemon/src/server-runtime-factory/config-assembly.ts:91-114` `runtimeConfigFromRunMetadata` 增加 `maxSteeringMessages`/`maxConsecutiveToolErrors`/`maxRepeatedToolCalls` 读取，允许 run-metadata 覆盖。

**收益**：消除默认值不一致带来的死代码与误判；引入按需预算调整能力。

### 5.3 建议 3：Provider parser 必须对无法识别的 tool_call 上报 `provider-diagnostic`（解耦根因 B）

**目标**：任何"识别失败"不再静默丢弃，全部通过 `provider-diagnostic` 事件可观测，并被 `ProviderResponseConsumer` 转化为对 steering 的差异化提示。

**改动范围**

1. `packages/agent-runtime/src/provider-openai-chat.ts:109-113` 在 `for (const call of pending.values())` 循环中，对 `!call.name` 的 pending 调用 emit：
   ```ts
   yield { type: "provider-diagnostic", diagnostic: {
     phase: "invalid-tool-call",
     reason: "function.name missing in streamed tool_call",
     partial: { id: call.id, argumentsText: call.argumentsText.slice(0, 200) }
   }};
   ```
2. `packages/agent-runtime/src/provider-openai-chat.ts:116-126` `mergeToolCallDelta` 增加对 `record.function_name`、`record.name`（部分 provider 把 name 直接挂在 call 上）的兼容识别；识别成功才填充 `current.name`，识别失败不静默吞掉，而是保留 pending 并在循环末尾由 §3.3-1 的 diagnostic 上报。
3. `packages/agent-runtime/src/provider-openai-chat.ts:128-134` `parseFullToolCall`（非流式分支）同样：识别失败时 yield `provider-diagnostic` 而非返回 `null`。
4. `packages/agent-runtime/src/runtime-components/provider-response-consumer.ts:75-78`（处理 `delta.type === "diagnostic"` 分支）把 invalid-tool-call 类 diagnostic 收集到 `diagnostics` 数组，并在 `ConsumeResult` 中暴露 `sawInvalidToolCall: boolean`。
5. `packages/agent-runtime/src/session-loop/index.ts:362-373` 在 `ar.type === 'empty-response'` 分支前优先检查 `consumeResult.diagnostics` 中是否有 `invalid-tool-call`，若有则走专门路径：注入 steering 消息 `"上游解析器未识别上一轮 tool_call 结构，请用标准 OpenAI tool_calls 字段重新发起调用"`，并重置 steeringCount（因为这不是 AI 的错）。

**收益**：根因 B 解耦。AI "声称调工具但被丢"与"AI 真的没动作"在事件流上可区分，steering 可以给出针对性提示，而不是机械重复"do not stop silently"。

### 5.4 建议 4：Daemon 持久化非凭证 Provider 配置（解耦根因 C 的可用性部分）

**目标**：daemon 重启后 model/baseUrl/credentialMode/endpoint 立即可用，仅 apiKey 通过桌面端推送或凭证解析器重新拉取。

**改动范围**

1. `packages/agent-daemon/src/daemon-provider-gateway/types.ts` 新增 `DaemonProviderPersistentConfig` 类型，仅包含 `providerId`/`routeId`/`model`/`upstreamModel`/`baseUrl`/`endpoint`/`stream`/`credentialMode`/`systemPromptWireMode`，不包含 `apiKey`/`accountId`。
2. `packages/agent-daemon/src/daemon-provider-gateway/index.ts` `DaemonProviderGatewayController` 增加 `loadPersistent(path)` / `savePersistent(path)` 方法，在 `update()` 时同步写盘（与现有 `lastStatusAt` 一起更新）。
3. `packages/agent-daemon/src/server-runtime-factory/config-assembly.ts:47-51` `runtimeConfigFromDaemonConfig` 改为从 `DaemonConfig` 读 model/baseUrl 等非凭证字段，填充到 `runtimeConfigLayers` 的 `daemon-config` 层（priority 150）。
4. `packages/agent-daemon/src/daemon-lifecycle.ts` 启动时调用 `DaemonProviderGatewayController.loadPersistent()`；找不到文件时降级为 `unconfigured` 状态（保持现有行为）。
5. `apps/crish-desktop/src/api/provider-profiles/profileStore.ts` 在 `activateProfileModel` 成功后追加一步：等待 daemon `status-response` 中 `providerStatus.gateway.ready=true` 才返回成功，避免桌面端认为已同步但 daemon 仍为空。

**收益**：daemon 重启后非凭证配置立即就绪，桌面端只需补推 apiKey（或通过 credentialMode='account-center' 走凭证解析器）。消除"重启后立即发消息失败"的窗口。

### 5.5 建议 5：桌面端识别 `runtime-intervention-required` 并暴露给用户（解耦 §3.9）

**目标**：用户能看到 daemon 提供的 `choices`，并主动选择 `rollback`/`pause`/`user-instruction`。

**改动范围**

1. `apps/crish-desktop/src/api/daemonEventZod.ts` 增加 `runtime-intervention-required` 事件 schema。
2. `apps/crish-desktop/src/api/daemonChatBridge/handlers/eventType.ts` 把 `runtime-intervention-required` 路由到与 `approval-requested` 同构的处理路径，弹出对话框展示 `message`/`choices`。
3. `apps/crish-desktop/src/api/runControlClient.ts` 增加 `respondIntervention(runId, choice, userInstruction?)` 方法，发送 `respond-intervention` 消息到 daemon。
4. `packages/agent-daemon/src/handlers/run-handlers/lifecycle/run-handler.ts` 增加 `respond-intervention` handler，根据 choice 派发到 `ControlBus.requestCooperativeStop`（pause）、`abort`（rollback）或 `AgentRuntime.enqueueSteerInput`（user-instruction）。
5. `packages/agent-runtime/src/session-loop/index.ts` 的 `applySafePointControl` 增加 `intervention-response` 控制类型，把用户选择转换为对应的 dispatch 事件。

**收益**：用户从"看到失败"升级为"看到介入请求并可选择"，与 §5.1 的软失败状态机构成完整闭环。

### 5.6 建议 6：TaskContinuationStrategy 引入"无进展 stall 检测"（解耦 §3.6）

**目标**：task 模式也跟踪 stall，避免在根因未解决时空转 50 轮。

**改动范围**

1. `packages/agent-orchestrator/src/task-continuation-strategy.ts:108-122` `computeProgressSignature` 改为：若 progressSignature 与上一轮相同，stalledRounds++，否则重置为 0。
2. `packages/agent-orchestrator/src/orchestrator/dispatcher/task-executor.ts:50-57` `DEFAULT_TASK_MAX_STALLED_ROUNDS` 从 1000 改为 3（与 goal 模式对齐），允许 task 模式在 3 轮无进展后 blocked。
3. `packages/agent-orchestrator/src/goal-continuation.ts` `advanceGoalStallState` 在 task 模式也启用 stall 跟踪，blocked 时发出 `goal-stalled` run-failed。
4. `packages/agent-orchestrator/src/task-continuation-strategy.ts:97-105` 在 `return { action: "continue", ... }` 前检查 `stalledRounds >= 2`，若是则改为 `block`，提示用户介入。

**收益**：避免在 parser 丢 tool_call 时无意义循环 50 轮，把"AI 真的没动作"与"系统故障"区分开。

### 5.7 建议 7：`handlePrepareTurn` 拆分 `after-tools` 与 `before-turn` 评估（消除 §3.10 重叠）

**目标**：steering 评估不再在 `handlePrepareTurn` 内重复跑 `after-tools`，避免与 `handleExecutingTools` 完成后的语义重叠。

**改动范围**

1. `packages/agent-runtime/src/session-loop/index.ts:232-242` 删除 `for (const phase of ['after-tools', 'before-turn'])` 循环，只保留 `before-turn` 评估；`after-tools` 评估移到 `handleExecutingTools` 的 `TOOLS_COMPLETE` 派发前（在工具结果 commit 之后立即评估）。
2. `packages/agent-runtime/src/steering/recovery-steering-strategy.ts:34` `phases` 保持 `["after-tools", "empty-response"]`，新增 `GoalAuditStrategy`/`CompressionRecoveryStrategy` 显式声明 `["before-turn"]`，避免无策略关注 `before-turn` 时浪费评估。

**收益**：消除 steering 在 preparing-turn 内被重复评估的开销与误检风险。

### 5.8 建议 8：增加 agent-loop 端到端契约测试覆盖上述路径

**目标**：把 §3.1-§3.10 的每个故障路径都固化为契约测试，防止回归。

**改动范围**

1. `packages/agent-runtime/src/__tests__/integrations/state-machine.test.ts` 增加：
   - "maxSteeringMessages=1 + 二次 empty-response → 进入 awaiting-intervention（而非 done）"
   - "intervention-required + user-instruction → 重置 steeringCount 后继续 run"
2. `packages/agent-runtime/src/provider/__tests__/e2e/stream-parser.test.ts` 增加：
   - "streaming tool_call 缺失 function.name → emit provider-diagnostic{phase:'invalid-tool-call'}"
   - "non-standard function_name 字段 → 兼容识别成功"
3. `packages/agent-orchestrator/src/orchestrator.test.ts` 增加：
   - "task 模式连续 3 轮相同 progressSignature → blocked（goal-stalled）"
   - "runtime-intervention-required 事件 → run.status=awaiting-approval（而非 failed）"
4. `packages/agent-daemon/src/server.test.ts` 增加：
   - "daemon 重启后从持久化文件恢复 model/baseUrl（无 apiKey）"
   - "runtimeConfigFromRunMetadata 读取 maxSteeringMessages 覆盖默认值"

**收益**：把系统化改进的语义固化为可执行断言，避免后续重构回归。

---

## 6. 修复优先级与依赖关系

按"先解耦、再修复、最后增强"的顺序：

| 阶段 | 建议 | 解耦根因 | 依赖 |
| --- | --- | --- | --- |
| P0 | 建议 1（intervention 软失败） | A | 无 |
| P0 | 建议 3（parser diagnostic） | B | 无 |
| P0 | 建议 4（daemon 持久化非凭证） | C（可用性） | 无 |
| P1 | 建议 2（steering 预算单一源） | A | 建议 1 |
| P1 | 建议 5（桌面端介入 UI） | 可观测性 | 建议 1 |
| P1 | 建议 6（task stall 检测） | A | 建议 2 |
| P2 | 建议 7（拆分 steering 评估） | 实现性 | 建议 2 |
| P2 | 建议 8（契约测试） | 防回归 | 建议 1-7 |

P0 三项任一缺失都会让"AI 一句话就断"问题在某个场景复发：
- 不做建议 1，则 parser 修复后任何二次空响应仍会触发 intervention 终态失败；
- 不做建议 3，则 steering 修复后 parser 仍会静默丢工具调用，无法定位根因；
- 不做建议 4，则 daemon 重启场景下连 provider 都装配不出来，前两项修复都无意义。

---

## 7. 附录：关键文件与行号速查

| 主题 | 文件 | 行号 |
| --- | --- | --- |
| 状态机定义 | `packages/agent-runtime/src/state-machine/agent-session.ts` | 54-232 |
| 状态机入口（dispatch） | `packages/agent-runtime/src/session-loop/index.ts` | 726-729 |
| `handleStreaming` | `packages/agent-runtime/src/session-loop/index.ts` | 262-378 |
| `handleNoToolCalls` | `packages/agent-runtime/src/session-loop/index.ts` | 471-491 |
| `handleSteeringEvaluation` | `packages/agent-runtime/src/session-loop/index.ts` | 493-506 |
| `handleTurnComplete` | `packages/agent-runtime/src/session-loop/index.ts` | 538-600 |
| steering 装配 | `packages/agent-runtime/src/session-loop/index.ts` | 115-120 |
| RecoverySteeringStrategy | `packages/agent-runtime/src/steering/recovery-steering-strategy.ts` | 32-102 |
| SteeringCoordinator | `packages/agent-runtime/src/steering/steering-coordinator.ts` | 41-183 |
| streaming tool_call 解析 | `packages/agent-runtime/src/provider-openai-chat.ts` | 78-126 |
| 非流式 tool_call 解析 | `packages/agent-runtime/src/provider-openai-chat.ts` | 58-76、128-134 |
| ProviderResponseConsumer | `packages/agent-runtime/src/runtime-components/provider-response-consumer.ts` | 23-200 |
| runtime 默认值 | `packages/agent-runtime/src/runtime-defaults.ts` | 36-69 |
| detectRecoveryNeed | `packages/agent-runtime/src/runtime-helpers.ts` | 49-116 |
| TaskContinuationStrategy | `packages/agent-orchestrator/src/task-continuation-strategy.ts` | 40-141 |
| driveGoalRun | `packages/agent-orchestrator/src/orchestrator/dispatcher/goal-executor.ts` | 50-214 |
| completionFromRuntimeEvent | `packages/agent-orchestrator/src/orchestrator/agent-loop.ts` | 666-694 |
| assessGoalRound | `packages/agent-orchestrator/src/task-assessment.ts` | 41-180 |
| daemon config handler | `packages/agent-daemon/src/handlers/config-handlers.ts` | 160-208 |
| DaemonProviderGatewayController | `packages/agent-daemon/src/daemon-provider-gateway/index.ts` | 54-319 |
| runtimeConfigFromDaemonConfig | `packages/agent-daemon/src/server-runtime-factory/config-assembly.ts` | 47-51 |
| runtimeConfigFromRunMetadata | `packages/agent-daemon/src/server-runtime-factory/config-assembly.ts` | 91-114 |
| 桌面端 syncActiveProfileToEngine | `apps/crish-desktop/src/api/provider-profiles/profileStore.ts` | 565-602 |
| 桌面端 useEngineBootstrap | `apps/crish-desktop/src/app/useEngineBootstrap.ts` | 5-68 |

---

## 8. 结论

conex agent loop 的"AI 一句话就断"问题不是单点 bug，而是 steering 预算与 run 终态失败耦合（根因 A）、provider parser 静默丢弃（根因 B）、daemon 配置不持久化（根因 C）三条根因相互放大导致的系统性故障。

任何补丁式修复（如调大 `maxSteeringMessages`、给 parser 加 if 分支）都只能在特定场景缓解，无法根治。必须按 §5 的系统化建议，先把 `intervention-required` 从硬失败改为软失败（建议 1），再让 parser 暴露识别失败（建议 3），最后让 daemon 持久化非凭证配置（建议 4），才能彻底解耦三条根因。建议 2、5、6、7 在 P0 之上进一步完善语义一致性与可观测性，建议 8 把改进固化为防回归契约。
