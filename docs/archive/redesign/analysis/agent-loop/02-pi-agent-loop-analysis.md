# Pi / Oh-My-Pi Agent Loop 架构分析

> 本文通过实际阅读 `reference/pi` 与 `reference/oh-my-pi` 两个项目的 `packages/agent/src/agent-loop.ts`（及其 `types.ts`、`stream-fn.ts` 等周边文件）源码，提取其 agent loop 设计模式，并与 conex 现有 `packages/agent-runtime/src/session-loop/index.ts` 实现做对比，给出可借鉴的系统性改进建议。
>
> 所有结论均附带具体文件路径与行号引用，便于复核。文中 "pi" 指代 `reference/pi`，"oh-my-pi" 指代 `reference/oh-my-pi`（pi 的下游 fork，在原架构上叠加了 telemetry、harmony-leak 防护、intent tracing、append-only context 缓存等能力）。两者 `runLoop` 主干同源，oh-my-pi 在关键终止语义上有一处重要差异（见 §3.2）。

---

## 1. Pi Agent Loop 架构概述

Pi 的 agent loop 是一个**纯函数式 + 流式事件**的轻量编排器，核心设计原则：

1. **AgentMessage 与 LLM Message 在边界处分离**
   内部全程使用 `AgentMessage[]`（可被应用层通过 declaration merging 扩展自定义消息类型），仅在调用 LLM 前通过 `config.convertToLlm` 转换为 provider 可识别的 `Message[]`。
   - 文件：`reference/pi/packages/agent/src/agent-loop.ts:1-3` 头部注释
   - 转换点：`streamAssistantResponse` 内 `reference/pi/packages/agent/src/agent-loop.ts:294-295`

2. **入口分两类：`agentLoop`（新 prompt）与 `agentLoopContinue`（续轮/重试）**
   - `agentLoop`：把 prompts 追加到 context 后启动循环（`reference/pi/packages/agent/src/agent-loop.ts:95-118`）
   - `agentLoopContinue`：不从 assistant 消息续轮（显式校验最后一跳不能是 assistant，`reference/pi/packages/agent/src/agent-loop.ts:74-76`），用于 retry 场景
   - 两者最终都汇入同一个 `runLoop`（`reference/pi/packages/agent/src/agent-loop.ts:155-275`）

3. **双层 while 循环驱动多轮工具调用**
   - 外层：处理"agent 本应停止时新到达的 follow-up 消息"
   - 内层：处理"当前 turn 的工具调用 + steering 消息"
   - 这是 pi 避免单轮就结束的核心结构（详见 §3.1）

4. **事件流（EventStream）作为对外契约**
   `agentLoop` 返回 `EventStream<AgentEvent, AgentMessage[]>`（`reference/pi/packages/agent/src/agent-loop.ts:37-54`），消费方按 `agent_start` / `turn_start` / `message_start` / `message_update` / `message_end` / `tool_execution_*` / `turn_end` / `agent_end` 顺序消费。`agent_end` 事件同时承载最终 `AgentMessage[]` 作为 `result()`（`reference/pi/packages/agent/src/agent-loop.ts:145-150`）。

5. **配置即策略（AgentLoopConfig）**
   所有可插拔点都通过 `AgentLoopConfig`（`reference/pi/packages/agent/src/types.ts:144-287`）暴露为回调：
   - `convertToLlm`：消息格式转换（必填，契约禁止抛错）
   - `transformContext`：上下文压缩/裁剪
   - `getApiKey`：动态凭证解析（解决短时 OAuth token 过期）
   - `getSteeringMessages` / `getFollowUpMessages`：消息注入分两环
   - `beforeToolCall` / `afterToolCall`：工具执行前后 hook
   - `shouldStopAfterTurn` / `prepareNextTurn`：终止与下一轮配置覆盖
   - `toolExecution`：`"sequential" | "parallel"`

oh-my-pi 在此基础上扩展（`reference/oh-my-pi/packages/agent/src/types.ts:31-242`）：
- `interruptMode: "immediate" | "wait"`：steering 何时打断工具批
- `maxToolCallsPerTurn`：单轮工具调用上限（流式截断）
- `intentTracing`：在工具 schema 注入 `_i` 字段做意图追踪
- `appendOnlyContext`：append-only 上下文管理器（命中 provider prefix cache）
- `telemetry`：OpenTelemetry instrumentation（`invoke_agent` / `chat` / `execute_tool` span）
- `onHarmonyLeak`：GPT-5 Harmony 协议泄露防护
- `getToolChoice` / `getReasoning`：每轮动态覆盖
- `syncContextBeforeModelCall`：每轮模型调用前刷新 prompt/tool 上下文

---

## 2. 核心循环流程图（文字描述）

### 2.1 主循环结构（pi 与 oh-my-pi 同构）

```
agentLoop(prompts, context, config, signal, streamFn)
  │
  ├─ emit agent_start, turn_start
  ├─ emit message_start/end for each prompt
  │
  └─ runLoop(currentContext, newMessages, config, signal, emit, streamFn)
       │
       ├─ pendingMessages = getSteeringMessages()   // 启动前先查一次
       │
       └─ OUTER while(true):                          // follow-up 环
            │
            ├─ hasMoreToolCalls = true
            │
            └─ INNER while(hasMoreToolCalls || pendingMessages.length>0):  // tool+steer 环
                 │
                 ├─ if !firstTurn: emit turn_start
                 │
                 ├─ 注入 pendingMessages 到 context + newMessages
                 │  （每条 emit message_start/end）
                 │
                 ├─ [oh-my-pi only] syncContextBeforeModelCall()
                 │
                 ├─ message = streamAssistantResponse(...)   // 流式拉取 assistant 回复
                 │  └─ 内部：transformContext → convertToLlm → streamFn(model, ctx, opts)
                 │     └─ start / text_delta / thinking_delta / toolcall_delta / done|error
                 │
                 ├─ newMessages.push(message)
                 │
                 ├─ if message.stopReason in (error|aborted):
                 │    emit turn_end; emit agent_end; return    // 早退
                 │
                 ├─ toolCalls = message.content.filter(type==='toolCall')
                 │
                 ├─ [pi]      执行条件：toolCalls.length>0
                 │  [oh-my-pi] 执行条件：runnableStop && toolCalls.length>0
                 │              其中 runnableStop = stopReason in (toolUse|stop)
                 │
                 ├─ if 有 toolCalls 且可执行：
                 │    ├─ [pi]      stopReason==='length' → failToolCallsFromTruncatedMessage
                 │    │             （不执行，全部标记为 error，提示模型重新发起）
                 │    │  [oh-my-pi] stopReason==='length' 且非 runnable → 生成 placeholder
                 │    │             toolResult（保持 tool_use/tool_result 配对，附 actionable hint）
                 │    │
                 │    └─ 否则 executeToolCalls（sequential 或 parallel）
                 │       ├─ prepareToolCall：找工具 + 参数校验 + beforeToolCall hook
                 │       │  （失败 → immediate error result，不抛错）
                 │       ├─ executePreparedToolCall：tool.execute(id, args, signal, onUpdate)
                 │       │  （失败 → catch → errorToolResult，isError=true，不抛错）
                 │       └─ finalizeExecutedToolCall：afterToolCall hook 可覆盖 result
                 │
                 │    for each toolResult: context.messages.push + newMessages.push
                 │    hasMoreToolCalls = !terminate   // 全批都 terminate=true 才停
                 │
                 ├─ emit turn_end(message, toolResults)
                 │
                 ├─ [pi only] prepareNextTurn → 可替换 context/model/thinkingLevel
                 ├─ [pi only] shouldStopAfterTurn → true 则 emit agent_end; return
                 │
                 └─ pendingMessages = getSteeringMessages()   // 本轮结束后再查
                 │
            │  // 内层退出：hasMoreToolCalls=false 且无 pendingMessages
            │
            ├─ [pi]      (无 onBeforeYield)
            ├─ [oh-my-pi] onBeforeYield()
            │
            ├─ followUpMessages = getFollowUpMessages()
            │  ├─ 有 → pendingMessages = followUp; continue 外层
            │  └─ 无 → break 外层
            │
       emit agent_end(newMessages)
```

### 2.2 工具执行路径（pi sequential / parallel 两种）

- **sequential**（`reference/pi/packages/agent/src/agent-loop.ts:433-487`）：逐个 prepare → execute → finalize，每个工具完成后立即 emit `tool_execution_end` 与 toolResult 消息；`signal.aborted` 中途 break。
- **parallel**（`reference/pi/packages/agent/src/agent-loop.ts:489-554`）：先逐个 prepare（顺序），可并发的工具收集为 thunk，再 `Promise.all` 并发执行；`tool_execution_end` 按完成顺序 emit，但 toolResult 消息按 assistant 源序 emit。
- oh-my-pi 改为**统一并发调度**（`reference/oh-my-pi/packages/agent/src/agent-loop.ts:1026-1357`），按 `tool.concurrency: "shared"|"exclusive"` 分组：`exclusive` 工具串行，`shared` 工具并发；并在批内实时检查 `getSteeringMessages` 触发中断（`immediate` 模式）。

---

## 3. 关键设计决策及代码引用

### 3.1 双层循环：外层 follow-up + 内层 tool/steer

**文件**：`reference/pi/packages/agent/src/agent-loop.ts:170-272`

```ts
// 外层
while (true) {
  let hasMoreToolCalls = true;
  // 内层
  while (hasMoreToolCalls || pendingMessages.length > 0) {
    // ... 注入 pendingMessages、流式拉取、执行工具 ...
    pendingMessages = (await config.getSteeringMessages?.()) || [];
  }
  // agent 本应停止 → 查 followUp
  const followUpMessages = (await config.getFollowUpMessages?.()) || [];
  if (followUpMessages.length > 0) {
    pendingMessages = followUpMessages;
    continue;   // 重启内层
  }
  break;
}
```

**意义**：把"用户在 agent 工作期间发的消息"分成两类语义：
- **steering**（`getSteeringMessages`）：在 agent 还要继续工作时注入，**不打断当前 turn 的工具执行**（pi 在内层循环开头注入，oh-my-pi 在工具批内 `immediate` 模式可打断）。
- **follow-up**（`getFollowUpMessages`）：仅在 agent 本应停止时才查询，**避免抢占正在进行的工具批**。

这是 pi 避免"单轮就结束"问题的核心：循环退出前会主动询问"还有没有新消息"，而不是工具一结束就 return。

### 3.2 终止语义：oh-my-pi 的关键差异 —— `stop` 等同 `toolUse`

**文件**：`reference/oh-my-pi/packages/agent/src/agent-loop.ts:588-604`

```ts
// Run tools whenever the turn carries tool_use blocks AND was not truncated.
// `stop_reason` is provider metadata that never goes back on the wire...
// So treat `stop` (end_turn/pause_turn) the same as `toolUse`.
// `length` (max_tokens) is the one reason we must NOT run...
const runnableStop = message.stopReason === "toolUse" || message.stopReason === "stop";
hasMoreToolCalls = runnableStop && toolCalls.length > 0;
```

oh-my-pi 明确处理了一个真实的 provider 行为：**adaptive/interleaved-thinking Opus 经常在 `end_turn` 下携带 tool calls**。pi（`reference/pi/packages/agent/src/agent-loop.ts:203-222`）只看 `toolCalls.length > 0`，行为等价（只要 toolCalls 非空就执行），但 oh-my-pi 把"哪些 stopReason 才执行工具"显式化，并单独处理 `length` 截断的残留 toolCall（见 §3.3）。

> 与 conex 的对照：conex 在 `handleStreaming`（`packages/agent-runtime/src/session-loop/index.ts:372-377`）同样以 `toolCalls.length === 0` 作为 `NO_TOOL_CALLS` 判据，对 `stopReason` 不做执行门控，仅对 `length` 走 `handleNoToolCalls` 内的 length recovery 分支（`index.ts:472-483`）。语义上更接近 pi。

### 3.3 `length` 截断的处理 —— 两套不同哲学

**pi**：`reference/pi/packages/agent/src/agent-loop.ts:208-214, 381-406`
- `stopReason === "length"` 时，**全部工具调用标记为 error**（`failToolCallsFromTruncatedMessage`），不执行。
- error 文案明确告知模型"arguments may be truncated, re-issue with complete arguments"。
- `terminate: false`，循环继续，让模型重新发起。

**oh-my-pi**：`reference/oh-my-pi/packages/agent/src/agent-loop.ts:625-645`
- `length` 截断时同样不执行，但生成 **placeholder toolResult**（`createAbortedToolResult` reason="length"），保持 `tool_use/tool_result` 配对契约。
- placeholder 文案更激进：明确告诉模型 **"Do NOT retry by re-emitting the same large payload — split the work into several smaller tool calls"**，避免模型无限重发超大 payload 导致循环。
- 同时计数 `recordSkippedTool` 进 telemetry。

**对比 conex**：conex 在 `ProviderCallCoordinator.handleLengthFinishReason`（`packages/agent-runtime/src/session-loop/provider-call.ts:89-100`）走**第三条路**——升级 `maxTokens`（`tryEscalateMaxTokensForLengthRecovery`，最多 2 次，cap 32K）并注入 continue nudge；若升级到顶仍 length，再走 `RecoveryCoordinator.shouldRetryWithEscalation`。conex 没有"工具参数被截断"的概念，因为 conex 的 length recovery 关注的是 **assistant 文本被截断**，而非 toolCall 参数被截断。这是 conex 当前未覆盖的场景（见 §4）。

### 3.4 工具失败恢复 —— 错误编码而非抛出

**文件**：`reference/pi/packages/agent/src/agent-loop.ts:600-707`

pi 的工具执行链路有**三道防线**，全部把异常编码为 `ToolResultMessage(isError=true)`，绝不抛出到主循环：

1. **`prepareToolCall`**（line 600-664）：
   - 工具找不到 → `immediate` error result
   - `validateToolArguments` 抛错 → `immediate` error result
   - `beforeToolCall` 返回 `{block:true}` → `immediate` error result
   - `signal.aborted` → `immediate` "Operation aborted" result

2. **`executePreparedToolCall`**（line 666-707）：
   - `tool.execute` 抛错 → `catch` → `createErrorToolResult(error.message)`，`isError=true`
   - 流式 `onUpdate` 回调在 settle 后被忽略（`acceptingUpdates=false`）

3. **`finalizeExecutedToolCall`**（line 709-754）：
   - `afterToolCall` hook 抛错 → 覆盖为 errorToolResult

**关键点**：错误结果被 push 进 `context.messages` 与 `newMessages`（line 218-221），下一轮 LLM 调用会看到 `isError=true` 的 tool result，模型自行决定重试或换路。**没有任何"工具失败 = 终止循环"的逻辑**。

oh-my-pi 进一步加了 `coerceToolResult`（`reference/oh-my-pi/packages/agent/src/agent-loop.ts:78-112`）：防御第三方工具（MCP、扩展）返回 malformed result（缺 `content` 数组等），在进入 agent loop 的单一边界处强制规范化，避免污染 session 文件。

### 3.5 Provider 适配 —— 在边界处完成所有转换

**文件**：`reference/pi/packages/agent/src/agent-loop.ts:281-372`

`streamAssistantResponse` 是唯一与 LLM 交互的地方，所有 provider 差异在此消化：

1. `transformContext(messages, signal)`：AgentMessage 层的压缩/裁剪（应用层实现）
2. `convertToLlm(messages)`：AgentMessage[] → Message[]（应用层实现，过滤 UI-only 消息等）
3. 构建 `Context { systemPrompt, messages, tools }`
4. `getApiKey(provider)` 动态解析凭证（`reference/pi/packages/agent/src/agent-loop.ts:305-306`），失败回退 `config.apiKey`
5. 调用 `streamFunction(model, llmContext, {...config, apiKey, signal})`
6. 消费 `AssistantMessageEventStream`，按事件类型更新 `context.messages` 末尾的 partial message

**oh-my-pi 增强**（`reference/oh-my-pi/packages/agent/src/agent-loop.ts:690-983`）：
- `normalizeMessagesForProvider`：cerebras provider 过滤 thinking 块（line 306-330）
- `normalizeTools` + `injectIntentIntoSchema`：在工具 schema 注入 `_i` intent 字段（line 332-385）
- `appendOnlyContext`：append-only 日志 + 系统提示/工具 schema 缓存，最大化 provider prefix cache 命中（line 714-723）
- `metadataResolver`：在 `getApiKey` 之后重新解析 metadata，确保 `account_uuid` 反映本次实际凭证（line 735）
- `AbortSignal.any([signal, harmonyAbortController.signal, toolCallCapAbortController.signal])`：多源 abort 合并（line 743-752）
- 流式 `toolcall_end` 计数，达到 `maxToolCallsPerTurn` 时 clone 当前 partial message 并 abort 流（line 917-925）

### 3.6 续轮 / 中断策略

**steering（工作期间纠偏）**：
- pi：`getSteeringMessages` 在内层循环开头（line 182-190）和每轮结束后（line 259）查询；注入不打断当前工具批。
- oh-my-pi：`interruptMode: "immediate"` 时，工具批内每个工具完成后调 `checkSteering`（line 1077-1096, 1318），若有 steering 消息则 `steeringAbortController.abort()`，剩余工具标记 `skipped`，本批返回的 `steeringMessages` 直接作为下一轮 `pendingMessages`（line 649）。

**abort（用户中断）**：
- pi：`signal.aborted` 在工具执行前/中检查（line 478, 516, 535, 629, 644），中断后 `stopReason="aborted"` 早退（line 196-200）。流式消费时 `streamAssistantResponse` 不显式 race abort（依赖 streamFn 内部）。
- oh-my-pi：`emitAbortedAssistantMessage`（line 985-1021）显式构造 `stopReason="aborted"` 的占位消息，保持消息序列完整；流式消费用 `Promise.race([iterator.next(), abortRacePromise])`（line 856-871）实现单次注册的 abort race。

**自然停止后的续轮**：
- 两者的 `getFollowUpMessages` 是唯一续轮来源（line 263-268）。**AI 返回纯文本无工具调用时，循环退出**，除非外部注入 follow-up。这是 pi 的明确设计：不自动续轮，把"是否继续"的决定权交给宿主。

### 3.7 早终止（terminate）信号

**文件**：`reference/pi/packages/agent/src/agent-loop.ts:582-584`

```ts
function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
  return finalizedCalls.length > 0 && finalizedCalls.every((f) => f.result.terminate === true);
}
```

工具可通过 `AgentToolResult.terminate=true`（`reference/pi/packages/agent/src/types.ts:355-369`）声明"本批应终止"。**仅当本批所有工具都 terminate=true 才真正终止**（line 216 `hasMoreToolCalls = !executedToolBatch.terminate`）。oh-my-pi 删除了 `terminate` 字段（`reference/oh-my-pi/packages/agent/src/types.ts:357-365` 无 `terminate`），改由宿主侧 `shouldStopAfterTurn` 控制。

---

## 4. 与 Conex 对比的差异点

### 4.1 架构范式：状态机 vs 双层循环

| 维度 | pi / oh-my-pi | conex |
|------|---------------|-------|
| 主循环结构 | 双层 while + 回调注入 | 显式状态机（`idle`/`awaiting-input`/`preparing-turn`/`streaming`/`steering-evaluation`/`executing-tools`/`turn-complete`/`done`） |
| 状态文件 | `reference/pi/packages/agent/src/agent-loop.ts:155-275` | `packages/agent-runtime/src/state-machine/agent-session.ts:54-232` |
| 主驱动 | `reference/pi/packages/agent/src/agent-loop.ts:170` | `packages/agent-runtime/src/session-loop/index.ts:154-192` |
| 终止判定 | 内层退出 + 查 followUp | 状态机 `SHOULD_STOP` / `MAX_TURNS_REACHED` / `ABORT` / `FINISH` 转移到 `done` |

conex 的状态机更**显式且可观测**（每个状态有独立 handler，`handleStreaming`/`handleExecutingTools`/`handleTurnComplete` 等），便于在状态边界挂 lifecycle hook（`turn.start`/`turn.end`，`index.ts:227-230, 543-550`）。pi 的双层循环更**紧凑**，所有逻辑在一个函数内，状态隐含在 `hasMoreToolCalls` / `pendingMessages` 两个变量里。

**评估**：conex 的状态机范式本身不劣于 pi，反而更适合多 agent 协同（ControlBus L1/L2/L3 控制层级、cooperative stop 等都需要显式状态）。差异不在范式，而在终止语义与恢复策略的完备性（见下）。

### 4.2 "AI 返回文本但无工具调用" 的处理

| 行为 | pi / oh-my-pi | conex |
|------|---------------|-------|
| 无 toolCalls 时是否续轮 | **否**，直接退出内层，查 followUp（`reference/pi/packages/agent/src/agent-loop.ts:203-222`） | **否**，`NO_TOOL_CALLS` → `turn-complete`（`packages/agent-runtime/src/session-loop/index.ts:489`） |
| `stopReason=length` 特殊处理 | pi: fail 所有 toolCalls；oh-my-pi: placeholder toolResult + 可操作提示 | length recovery：升级 maxTokens + continue nudge（`provider-call.ts:89-100`） |
| empty-response 处理 | pi: 无特殊处理（按无 toolCalls 走） | 专门 `STEERING_NEEDED` → `steering-evaluation` 状态，由 `RecoverySteeringStrategy` 决定注入（`index.ts:361, 493-506`） |

**评估**：conex 在 empty-response 与 length recovery 上**比 pi 更完备**。pi 的设计哲学是"模型说停就停，宿主用 followUp 接管"；conex 试图在 loop 内部主动纠偏（steering-evaluation、synthesisNudge）。两种哲学都成立，但 conex 的 steering-evaluation 在 `actions.length === 0` 时直接 `STEERING_BUDGET_EXHAUSTED` → `endReason: 'error'`（`index.ts:500`），比 pi 更容易因策略未覆盖而失败收场。

### 4.3 工具调用失败后的恢复

| 行为 | pi / oh-my-pi | conex |
|------|---------------|-------|
| 工具异常是否终止循环 | **否**，编码为 isError toolResult 继续（`reference/pi/packages/agent/src/agent-loop.ts:666-707`） | 区分 fatal/non-fatal：`findFatalToolError` 命中则 `endReason='error'`（`index.ts:522-523`） |
| malformed result 防御 | oh-my-pi 有 `coerceToolResult`（`reference/oh-my-pi/packages/agent/src/agent-loop.ts:78-112`） | 无显式防御 |
| 连续工具错误 | 无专门计数 | `RecoverySteeringStrategy` 有 `maxConsecutiveToolErrors` / `maxRepeatedToolCalls` 预算（`index.ts:117-119`） |
| 工具后 steering | pi: 不打断批；oh-my-pi: `immediate` 模式可打断 | `applySafePointControl` 在工具批后检查（`index.ts:526-527`） |

**评估**：conex 的 fatal 错误提前终止是**合理的**（避免致命工具错误后继续空转），但 pi 的"永不终止、让模型看到 isError 自行决策"在**长任务韧性**上更优。oh-my-pi 的 `coerceToolResult` 是 conex 应当补上的防御层（MCP 工具返回 malformed result 会污染 session）。

### 4.4 Provider 配置缺失 / 失败时的降级

| 行为 | pi / oh-my-pi | conex |
|------|---------------|-------|
| API key 解析 | `getApiKey(provider)` 动态解析，回退 `config.apiKey`（`reference/pi/packages/agent/src/agent-loop.ts:305-306`） | 同（`provider-call.ts` 内 `providerGateway.call`） |
| 瞬时错误重试 | **无**（依赖 streamFn 内部） | `ProviderCallCoordinator.MAX_PROVIDER_TRANSIENT_RETRIES=3`，指数退避（`index.ts:447-452`） |
| payload-too-large 恢复 | **无** | `scrubImagesOldestFirst` 剥离图片 + 上下文压缩（`index.ts:429-444`） |
| Provider 切换降级 | **无** | **无** |
| harmony-leak 防护 | oh-my-pi 专有（`reference/oh-my-pi/packages/agent/src/agent-loop.ts:58-67, 932-941`），最多重试 2 次 | **无** |

**评估**：conex 在 provider 失败恢复上**显著优于 pi**（transient retry + payload recovery）。两者都**缺少 provider 级降级**（主 provider 不可用时切换到备选 provider），这是共同的改进空间。oh-my-pi 的 harmony-leak 防护是 GPT-5 专有问题，conex 若要支持 GPT-5 应考虑移植。

### 4.5 避免"单轮就结束"的机制对照

| 机制 | pi / oh-my-pi | conex |
|------|---------------|-------|
| 双层循环 + followUp | 核心（`reference/pi/packages/agent/src/agent-loop.ts:170-272`） | 状态机 + `consumeIdlePendingInput`（`index.ts:606-615`），followUp 仅在 idle 时 promote |
| steering 注入 | `getSteeringMessages` 回调 | `AgentInputQueue` 分环（force/steer/followUp）+ `ControlBus` L1/L2/L3 |
| maxTurns 将尽提示 | **无** | `synthesisNudge`（`index.ts:561-563, 594-597`）—— 注入"请总结"消息 |
| turn.end cooperative stop | **无** | lifecycle hook `turn.end` 可建议 stop（`index.ts:578-581`） |
| 工具批内 steering 打断 | pi: 否；oh-my-pi: `immediate` 可 | `applySafePointControl` 在工具批后（非批内） |

**评估**：conex 在"避免单轮结束"上**机制更丰富**（synthesisNudge、cooperative stop、分环 input queue），但 `consumeIdlePendingInput` 的 promote 时机（`index.ts:588-593`）要求先经过 `shouldStopAfterTurn` hook 判断，路径比 pi 的"内层退出即查 followUp"更长，存在 hook 未配置时漏续轮的风险。

---

## 5. 可借鉴的模式和建议

### 5.1 强烈建议借鉴

#### A. 工具失败的"编码而非抛出"原则（系统性改进）

**问题**：conex `findFatalToolError`（`packages/agent-runtime/src/session-loop/index.ts:522-523`）在工具批后扫描 fatal 错误并直接 `endReason='error'` 终止。这把"工具失败"与"run 失败"耦合，对长任务不友好。

**借鉴**：pi 的三道防线（prepare / execute / finalize）全部把异常编码为 `isError=true` 的 toolResult，循环继续，让模型看到错误后自行决策（`reference/pi/packages/agent/src/agent-loop.ts:600-707`）。

**系统化改进**：把 `findFatalToolError` 的"致命"判定收敛到一个显式的 `terminate` 语义（如 pi 的 `AgentToolResult.terminate`），仅当工具**主动声明** terminate 时才终止，而非由 loop 侧黑名单判定。这样 fatal 工具仍可由模型重试或换路，避免单点工具错误拖垮整个 run。

#### B. malformed tool result 防御层（补丁式漏洞）

**问题**：conex 直接信任 `tool.execute` 返回的 result 结构，MCP/扩展工具返回缺 `content` 数组的 result 会污染 session。

**借鉴**：oh-my-pi 的 `coerceToolResult`（`reference/oh-my-pi/packages/agent/src/agent-loop.ts:78-112`）在结果进入 loop 的单一边界处强制规范化：缺 content → error result；非法 block → 过滤；同时保留工具自带的 `isError` 标记。

**系统化改进**：在 `ToolExecutionCoordinator`（`packages/agent-runtime/src/session-loop/tool-execution.ts`）的 execute 返回点统一加 `coerceToolResult` 等价层，所有下游消费者（recorder、conversation、provider input）都依赖规范化后的结构。

#### C. tool_use/tool_result 配对契约的显式维护

**问题**：conex 在 `stopReason=length` 时走 length recovery（升 maxTokens + nudge），但**未处理 length 截断导致 toolCall 参数不完整**的场景——此时若 assistant message 含半截 toolCall，下游 provider 重放该 turn 会因 tool_use 无配对 tool_result 而拒绝。

**借鉴**：oh-my-pi 在 `length` 截断且 toolCall 残留时，为每个 toolCall 生成 placeholder toolResult（`reference/oh-my-pi/packages/agent/src/agent-loop.ts:625-645`），保持配对契约，并在文案里给出**可操作提示**（"split the work into smaller tool calls"），避免模型重发同样的大 payload 死循环。

**系统化改进**：在 `handleNoToolCalls`（`index.ts:471-491`）的 `stopReason=length` 分支里，除了现有的 maxTokens 升级，额外检查 assistant message 是否含 toolCall block；若有，为每个生成 placeholder toolResult 并入 conversation，文案采用 oh-my-pi 的"拆分 payload"提示。

### 5.2 可选借鉴

#### D. oh-my-pi 的 stopReason 执行门控显式化

**现状**：conex `handleStreaming`（`index.ts:372-377`）以 `toolCalls.length === 0` 作 `NO_TOOL_CALLS`，对 stopReason 不做执行门控。

**借鉴**：oh-my-pi（`reference/oh-my-pi/packages/agent/src/agent-loop.ts:603-604`）显式定义 `runnableStop = stopReason in (toolUse|stop)`，把"哪些 stopReason 才执行工具"写成单一布尔表达式，注释说明 adaptive-thinking Opus 在 `end_turn` 下携带 toolCall 的真实行为。

**建议**：conex 当前行为等价（toolCalls 非空即执行），但显式化后更易维护与排错。可在 `handleStreaming` 加一行注释或一个 `runnableStop` 局部变量，把隐式契约显式化。

#### E. 流式 abort race 的单次注册模式

**现状**：conex 的 abort 处理依赖 `consumePromise` + `deltaWaiters`（`index.ts:270-329`），在 stream 中途检查 `controlBus.hasPending()` 与 `abortController.signal.aborted`，逻辑分散在 while 循环多个分支。

**借鉴**：oh-my-pi（`reference/oh-my-pi/packages/agent/src/agent-loop.ts:838-871`）用 `Promise.withResolvers` 注册一次 abort listener，整个流消费期间复用同一个 `abortRacePromise`，每个 `iterator.next()` 与之 `Promise.race`。代码更紧凑，abort 响应延迟更低（不依赖下一次 delta 才发现）。

**建议**：conex 的 `handleStreaming` 可在 `consume` 调用前注册单次 abort race，把分散的 `if (this.abortController.signal.aborted)` 检查收敛到 race 退出后的单一处理点。

#### F. intent tracing（仅当需要工具调用归因时）

**现状**：conex 无工具调用意图追踪。

**借鉴**：oh-my-pi（`reference/oh-my-pi/packages/agent/src/agent-loop.ts:332-400`）在工具 schema 注入 `_i` 字段，让模型在调用工具时显式声明意图，执行前剥离。对 telemetry 与工具调用质量分析有价值。

**建议**：非必需，仅在 conex 需要做工具调用归因分析时考虑。实现成本不低（需在所有 provider 的 schema 路径处理）。

#### G. append-only context（prefix cache 优化）

**现状**：conex 的 `ContextManager.projectForProvider`（`provider-call.ts:50`）每轮重新投影，prefix bytes 不稳定。

**借鉴**：oh-my-pi 的 `appendOnlyContext`（`reference/oh-my-pi/packages/agent/src/agent-loop.ts:714-723`，类型定义 `reference/oh-my-pi/packages/agent/src/types.ts:166-174`）缓存 system prompt + tools 的稳定字节前缀，append-only 维护消息日志，最大化 provider prefix cache 命中。

**建议**：conex 的 `prompt-assembly` 已有 `stablePrefixHash` / `toolSchemaHash`（`index.ts:704`），可在此基础上做 append-only 缓存。属于性能优化，非正确性问题。

### 5.3 不建议借鉴

#### H. pi 的"无瞬时错误重试"

pi 把 provider 瞬时错误的重试完全外包给 streamFn，agent loop 层不感知。conex 的 `ProviderCallCoordinator.MAX_PROVIDER_TRANSIENT_RETRIES=3` + 指数退避（`index.ts:447-452`）是更优设计，应保留。

#### I. pi 的"无 payload recovery"

pi 无 payload-too-large 恢复。conex 的 `scrubImagesOldestFirst` + 上下文压缩（`index.ts:429-444`）是更优设计，应保留。

### 5.4 Conex 应保留的自身优势

conex 相对 pi 的以下设计是**系统性优势**，不应在借鉴 pi 时丢失：

1. **状态机驱动**：显式状态边界使 lifecycle hook、ControlBus L1/L2/L3、cooperative stop 等能力成为可能，pi 的双层循环无法支撑这些。
2. **ControlBus 三级控制**：`soft_inject`（不杀 stream）/ `cooperative_stop`（L2 协作终止，不 abort）/ `force_cancel`（L3 立即 abort）的分层语义（`index.ts:624-659`）远超 pi 的单一 abort signal + steering 二分。
3. **transient retry + payload recovery**：provider 失败恢复更完备。
4. **synthesisNudge**：maxTurns 将尽时主动注入总结提示，避免 run 在 budget 耗尽时静默 abort。
5. **input queue 分环**：force/steer/followUp 三类消息有不同的注入时机，比 pi 的 steering/followUp 二分更精细。

### 5.5 改进路线优先级

| 优先级 | 项 | 类型 | 理由 |
|--------|-----|------|------|
| P0 | A. 工具失败编码而非终止 | 系统性 | 直接影响 run 成功率 |
| P0 | B. malformed tool result 防御 | 补丁式漏洞 | 影响正确性 |
| P1 | C. length 截断 toolCall placeholder | 契约维护 | 防 provider 重放失败 |
| P2 | D. stopReason 执行门控显式化 | 可维护性 | 当前行为已等价 |
| P2 | E. 流式 abort race 单次注册 | 性能与可读性 | 优化 |
| P3 | F. intent tracing | 可观测性 | 非必需 |
| P3 | G. append-only context | 性能 | 非正确性 |

---

## 附录：关键文件索引

### Pi
- `reference/pi/packages/agent/src/agent-loop.ts`（主循环，775 行）
- `reference/pi/packages/agent/src/types.ts`（AgentLoopConfig / AgentContext / AgentTool 定义）
- `reference/pi/packages/agent/src/stream-fn.ts`（默认 streamFn 注册）

### Oh-My-Pi
- `reference/oh-my-pi/packages/agent/src/agent-loop.ts`（主循环，1418 行，含 telemetry / harmony-leak / intent）
- `reference/oh-my-pi/packages/agent/src/types.ts`（扩展的 AgentLoopConfig）
- `reference/oh-my-pi/packages/agent/src/harmony-leak.ts`（GPT-5 Harmony 协议泄露防护）
- `reference/oh-my-pi/packages/agent/src/telemetry.ts`（OTEL instrumentation）
- `reference/oh-my-pi/packages/agent/src/append-only-context.ts`（prefix cache 优化）

### Conex（对照）
- `packages/agent-runtime/src/session-loop/index.ts`（AgentSessionLoop 主类，730 行）
- `packages/agent-runtime/src/session-loop/provider-call.ts`（ProviderCallCoordinator，length recovery）
- `packages/agent-runtime/src/state-machine/agent-session.ts`（状态机定义）
- `packages/agent-runtime/src/runtime-components/provider-response-consumer.ts`（流式消费）
