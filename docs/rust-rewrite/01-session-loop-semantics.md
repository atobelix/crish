# 01 — Session-Loop 期望行为规范（Rust 重写实现契约）

> 状态：已建立（Phase A 知识采集，Round 1 / A1）
> 依据：`packages/agent-core`（Round 5 拷贝，简称 **core**）与 `packages/agent-runtime`（原始单体，简称 **runtime**）两份活跃分叉的全量对比；参考语义取自 `reference/pi`（agent-loop.ts）与 `reference/grok-build`（turn.rs / sampler_turn.rs）。
> 引用格式：`core:index.ts:696` = `packages/agent-core/src/session-loop/index.ts:696`；未加前缀的 `agent-session.ts` 两包内容逐字节一致（已核对 264 行全同）。
> 决策原则（来自 00-master-plan.md §3 与参考项目调研）：正常文字回复永不导致 run 失败；模型输出与传输错误分离；steering 有硬上限但不以 error 收场；run 内不自注入 nudge，nudge 注入下一条用户消息。

---

## 一、状态机规范

### 1.1 状态（`agent-session.ts:10-18`）

`idle` → `awaiting-input` → `preparing-turn` → `streaming`（→ `steering-evaluation` ｜→ `executing-tools`）→ `turn-complete` → `done`。共 8 个状态。

### 1.2 事件（`agent-session.ts:20-40`）

`INITIALIZED`、`INPUT_READY`、`NO_INPUT`、`TURN_PREPARED`、`HAS_TOOL_CALLS`、`NO_TOOL_CALLS`、`NO_PROGRESS_CONTINUE`、`TOOLS_COMPLETE`、`INPUT_AVAILABLE`、`NEXT_TURN`、`SHOULD_STOP`、`ABORT`、`ERROR`、`MAX_TURNS_REACHED`、`INTERVENTION_REQUIRED`、`PROVIDER_ERROR`、`FINISH`、`STEERING_NEEDED`、`STEERING_COMPLETE`、`STEERING_BUDGET_EXHAUSTED`，共 20 个。

### 1.3 上下文（`agent-session.ts:44-52, 61-68`）

`{ sessionId, turnIndex, maxTurns, endReason, toolCallCount, steeringCount, abortReason? }`。初始 `endReason='stop'`，`turnIndex/steeringCount/toolCallCount=0`。

### 1.4 转移表（`agent-session.ts:69-232`，两拷贝逐字节一致）

| 当前状态 | 事件 | 目标状态 | 上下文 effect / endReason |
|---|---|---|---|
| idle | INITIALIZED | awaiting-input | — |
| idle | ERROR | done | endReason=error |
| awaiting-input | INPUT_READY | preparing-turn | — |
| awaiting-input | NO_INPUT | done | （默认 stop） |
| awaiting-input | ABORT | done | endReason=aborted |
| awaiting-input | ERROR | done | endReason=error |
| preparing-turn | TURN_PREPARED | streaming | turnIndex+1，toolCallCount=0 |
| preparing-turn | INTERVENTION_REQUIRED | done | endReason=error |
| preparing-turn | ABORT | done | endReason=aborted |
| preparing-turn | ERROR | done | endReason=error |
| streaming | HAS_TOOL_CALLS | executing-tools | toolCallCount=payload.count |
| streaming | NO_TOOL_CALLS | turn-complete | — |
| streaming | STEERING_NEEDED | steering-evaluation | **不 bump steeringCount**（注释：由 RecoveryStrategy/coordinator 掌管预算，`agent-session.ts:120-121`） |
| streaming | NO_PROGRESS_CONTINUE | preparing-turn | — |
| streaming | INTERVENTION_REQUIRED | turn-complete | endReason=error |
| streaming | ABORT | turn-complete | endReason=aborted |
| streaming | PROVIDER_ERROR | turn-complete | endReason=error |
| streaming | ERROR | turn-complete | endReason=error |
| steering-evaluation | STEERING_COMPLETE | preparing-turn | —（注入后必须重新进入 provider 循环） |
| steering-evaluation | STEERING_BUDGET_EXHAUSTED | turn-complete | endReason=error |
| steering-evaluation | INTERVENTION_REQUIRED | turn-complete | endReason=error |
| steering-evaluation | ABORT | done | endReason=aborted |
| steering-evaluation | ERROR | done | endReason=error |
| executing-tools | TOOLS_COMPLETE | turn-complete | — |
| executing-tools | INPUT_AVAILABLE | preparing-turn | — |
| executing-tools | ABORT | turn-complete | endReason=aborted |
| executing-tools | ERROR | turn-complete | endReason=error（fatalOnError 等工具级致命错误，`agent-session.ts:194`） |
| turn-complete | INPUT_AVAILABLE | awaiting-input | turnIndex/toolCallCount/steeringCount 归零（`agent-session.ts:211-219`） |
| turn-complete | NEXT_TURN | preparing-turn | — |
| turn-complete | MAX_TURNS_REACHED | done | endReason=max-turns |
| turn-complete | SHOULD_STOP | done | （默认 stop） |
| turn-complete | ABORT | done | endReason=aborted |
| turn-complete | FINISH | done | — |
| done | — | — | 终态，无转移 |

注意：**turn-complete 没有 ERROR 转移**；此时致命错误经 `recovery.dispatchFatalError` 映射为 FINISH（`core:recovery.ts:96`）。同样地，`executing-tools` 的 ABORT/ERROR 只推进到 turn-complete（保留已产出内容），而 `preparing-turn`/`awaiting-input`/`idle`/`steering-evaluation` 的 ABORT/ERROR 直接到 done。

### 1.5 endReason 语义（`agent-session.ts:42`）

`type AgentEndReason = 'stop' | 'max-turns' | 'aborted' | 'error'`

- **stop**：默认收场。NO_INPUT、SHOULD_STOP、FINISH 等不带 patch 的转移。
- **max-turns**：仅 `MAX_TURNS_REACHED`（`agent-session.ts:223-225`）。语义是「预算用尽」，可观测但**不是错误**（`core:index.ts:593-608` 显式注释「非 silent abort」并 emit `runtime-error` 事件仅用于观测）。
- **aborted**：仅 `ABORT` 事件（用户取消 / L3 force_cancel / AbortSignal）。streaming/executing-tools 中先转 turn-complete（抢救已产出内容），其余状态直落 done。
- **error**：「错误收场」**最小集合**，仅由 4 个事件产生（见 1.6）。

### 1.6 「错误收场」最小集合（Rust 实现必须保证的唯一 error 来源）

| 事件 | 产生状态 | 触发点（handler） | 依据 |
|---|---|---|---|
| ERROR | 任意状态 | 工具致命错误 `findFatalToolError`（`core:index.ts:556`）；run 主循环 catch 兜底（`core:index.ts:191`） | `agent-session.ts:72,80,101,151,176,196` |
| INTERVENTION_REQUIRED | preparing-turn / streaming / steering-evaluation | steering apply 返回 `interventionRequired`（`core:index.ts:245,534`） | `agent-session.ts:97,125,172` |
| PROVIDER_ERROR | streaming | stopReason=error（`core:index.ts:371`）；stream 错误重试/恢复均失败（`core:index.ts:472`） | `agent-session.ts:140` |
| STEERING_BUDGET_EXHAUSTED | steering-evaluation | 预算超限或无策略响应（`core:index.ts:520,531`） | `agent-session.ts:168` |

除上述 4 事件外，**任何路径不得以 endReason='error' 收场**。特别是：纯文字回复（无 tool-call）、max-turns、cooperative_stop、steering 注入完成，均不得产生 error（现状违反点见第四章 D6/D7/D8）。

---

## 二、各 handler 期望行为清单

（行为描述取两拷贝并集；分歧处以「仅 core / 仅 runtime」标注，裁决见第四章。）

### 2.1 run 主循环（`core:index.ts:148-208`，runtime:143-203 相同）

- 触发：外部调用 `run(userInput)`。行为：sessionMutex 串行化（`core:index.ts:149`）→ 用户消息入队 → `INITIALIZED` → `agent-start` 事件 → while(!done) 按当前状态分派 handler。
- handler 返回 `{endReason?, endError?}` 即终止循环；**catch 兜底路径**：abort/cancel 类错误 → aborted；否则 `recovery.handleErrorWithHook`（hook.onError 裁决 retry/skip/abort，`core:recovery.ts:27-40`）→ retry 继续循环 / skip 走 `dispatchErrorRecovery`（状态→继续事件映射，`core:recovery.ts:81-91`）/ 否则 endReason='error' + `dispatchFatalError`（`core:recovery.ts:93-99`）。
- 产出：`agent-end` 事件（含 reason、可选 error），返回会话消息列表。
- 期望语义：**纯文字回复路径永不进入 catch**；传输错误按分类进入瞬态重试而非 error（见 2.4 handleStreamError）。

### 2.2 handleAwaitingInput（`core:index.ts:210-217`）

- 触发：awaiting-input。行为：abort 检查 → dequeue（force 优先、steer 次之，`core:agent-input-queue.ts:85-87`）→ 无输入 `NO_INPUT`（→ done，stop 收场）；有输入 recordMessage（message-start/message-end 事件 + 落盘）→ `INPUT_READY`。
- 产出事件：message-start、message-end。

### 2.3 handlePrepareTurn（`core:index.ts:219-265`）

- 触发：preparing-turn（含 NO_PROGRESS_CONTINUE 重进）。
- 行为：
  1. abort 检查；可选 readPendingInputs 回填。
  2. 消费 hasRunnablePending（force/steer；**不消费 followUp**，`core:index.ts:225`）→ recordMessage。
  3. `turn-start` 事件 + lifecycle `turn.start` emit（`core:index.ts:230-235`）。
  4. recovery.enabled!==false **且 steering_enabled=true**（PE-06 T06.2.1：Q03 接线，干预性 steering 可配置关闭；false 时跳过评估）时：对 `after-tools`、`before-turn` 两个 phase 依次 `steering.evaluate` → `steering.apply` → flushEvents（runtime-steering 事件）；`applied.interventionRequired` → `INTERVENTION_REQUIRED` + endReason='error'（`core:index.ts:238-247`）。
  5. 上下文压缩（**PE-06 T06.2.3 已删除**：CompressionHook 死配置无消费者；上下文压缩 = 未来任务，需真实压缩实现 + payload 阶梯一并恢复）。
  6. `TURN_PREPARED`。
- 产出事件：turn-start、message-start/end、runtime-steering。
- 期望语义：**prepare-turn 内干预性 steering 可配置关闭**（`steering_enabled=false` 跳过 AfterTools/BeforeTurn 评估，PE-06 T06.2.1），intervention-required 不因单次工具错误误触发（见第三章）。

### 2.4 handleStreaming（`core:index.ts:267-383`）

- 触发：streaming。
- 行为：
  1. buildProviderCall（systemPrompt/promptContext/maxTokens/thinkingIntensity 透传，`core:index.ts:268`、`core:provider-call.ts:40-79`）。
  2. delta 队列消费：`message-delta` 事件（thought/text block，`core:index.ts:275-282`）。
  3. 循环内抢占检查：**L3 force_cancel 可立即打断**（`core:index.ts:293-299`）；AbortSignal → abort；**force 环输入可打断 stream**（dequeueForce → INPUT_AVAILABLE，`core:index.ts:305-308`）；steer/followUp 不打断。
  4. consume 完成：diagnostics → `provider-diagnostic` 事件（`core:index.ts:343-345`）。
  5. 响应分类（**模型输出与传输错误分离的枢纽**）：
     - `ar.type==='error'` → streamAborted 则 endStreamingAborted；否则 handleStreamError（`core:index.ts:350-355`）。
     - abort 后 partial salvage：消息仍 commit（stopReason=aborted 标记）→ endStreamingAborted（`core:index.ts:357-363`）。
     - `empty-response` → `STEERING_NEEDED`（`core:index.ts:366`；**steering_enabled=false 时短路**为 stop + 诊断收场「steering 已禁用，空响应无法恢复」，PE-06 T06.2.1）。
     - message：commitAssistantMessage（落盘 + message-end + token 记账）→ 检查 stopReason==='error' → `PROVIDER_ERROR` + error（**D7 分歧点**，见第四章）。
  6. 安全点 applySafePointControl（stream 结束且消息已落盘，不丢本轮输出，`core:index.ts:374-375`）。
  7. 有 tool-call → `HAS_TOOL_CALLS(count)`；无 → handleNoToolCalls。
- 产出事件：message-delta、provider-diagnostic、message-start/end、runtime-error（错误路径）、runtime-intervention-required（steering 路径）。
- 期望语义：**有文字或有 tool-call 即视为有效模型输出**；纯文字回复直接进入 turn-complete 正常收场（对齐 pi `agent-loop.ts:196-200`——仅 stopReason=error/aborted 提前结束，其余全部视为正常；对齐 grok `turn.rs:2397`——tool_calls 为空即 finalize → Completed）。

### 2.5 handleStreamError（`core:index.ts:430-474`，runtime:425-469 相同）

传输/服务端错误处理阶梯（**错误按瞬态分类重试，不误伤文字回复**）：
1. payload-too-large：**直接 fatal**（PE-06 T06.2.2 删除假恢复阶梯——请求体与 max_tokens 均不变时重试必然再次 PayloadTooLarge；原 scrubImagesOldestFirst / maybeCompress 恢复与 `MAX_PAYLOAD_IMAGE_RECOVERY=2` 描述作废；真实压缩落地后恢复本阶梯）。
2. 瞬态 provider 错误（`isTransientProviderError` = ErrorClassifier.retryable，`core:types.ts:60-62`）：重试上限 3（`core:provider-call.ts:24`），指数 sleep 600ms×retry，`provider-diagnostic` 事件，`NO_PROGRESS_CONTINUE`（`core:index.ts:452-457`）。
3. 已用工具且未 synthesis nudge：注入 nudge + `INPUT_AVAILABLE`（**run 内自注入，D8 分歧点**，`core:index.ts:459-462`）。
4. 恢复 hook：retry → `NO_PROGRESS_CONTINUE`；skip → dispatchErrorRecovery；否则 `PROVIDER_ERROR` + endReason='error'（`core:index.ts:464-473`）。

### 2.6 handleNoToolCalls（`core:index.ts:476-515`，runtime:471-491 除 tool-promise 外相同）

- 触发：streaming 中消息无 tool-call。
- 行为：
  1. stopReason==='length'：length 恢复阶梯——maxTokens 翻倍升级（8192→16384→32768，上限 2 次，`core:provider-call.ts:30-32,110-119`）→ 注入 length nudge（**run 内注入**）+ resetSteeringCount + `NO_PROGRESS_CONTINUE`；否则 continue-nudge 计数 <1 时再试一次（`core:recovery.ts:42-48`）。
  2. 非 length：重置 length 计数器。
  3. resetSteeringCount（`core:index.ts:493`）。
  4. **tool-promise steering（仅 core，D2）**：`tools>0 && !sawToolsThisRun && responsePromisesAction(msg) && turnIndex<maxTurns && count<3` → 注入 tool-promise nudge + `STEERING_NEEDED`（`core:index.ts:494-512`；`core:types.ts:38-47` regex 承诺检测）。
  5. 否则 `NO_TOOL_CALLS` → turn-complete。
- 期望语义：**无 tool-call 的纯文字回复 = 正常结束**（除非 length 恢复阶梯介入）；tool-promise steering 不做（D2 裁决）。

### 2.7 handleSteeringEvaluation（`core:index.ts:517-537`，runtime:493-506 无预注入短路）

- 触发：STEERING_NEEDED（empty-response）。
- 行为：
  1. 预算检查：`ctx.steeringCount > (ro.maxSteeringMessages ?? 3)` → `STEERING_BUDGET_EXHAUSTED` + error（注意 `ctx.steeringCount` 恒为 0，此为死检查，见第三章 3.3）。
  2. **预注入短路（仅 core）**：`inputQueue.hasRunnablePending()` → 直接 `STEERING_COMPLETE`，跳过策略评估避免重复注入（`core:index.ts:522-527`）。
  3. `evaluate('empty-response')`：无 action → `STEERING_BUDGET_EXHAUSTED` + error（`core:index.ts:530-531`）。
  4. apply：interventionRequired → `INTERVENTION_REQUIRED` + error；否则 `STEERING_COMPLETE` → preparing-turn（重进 provider 循环）。
- 产出事件：runtime-steering、runtime-intervention-required。
- 期望语义：**空响应处理有硬上限但不得以 error 收场**（D6/D9 裁决）；上限用尽 → 正常 stop（文字回复式收场），intervention 降级为可观测事件。

### 2.8 handleExecutingTools（`core:index.ts:539-569`，runtime:508-536 除 tool-promise 计数外相同）

- 触发：executing-tools。
- 行为：
  1. abort 检查 → `ABORT`。
  2. 取最后 assistant 消息的 tool-call blocks → `executeToolBatch`（批量/并行、超时、tool.pre/post 生命周期、权限审批、validation/repair、materializeOutput、checkpoint 记录，`core:tool-execution.ts:64-78, 80-177`）。
  3. `sawToolsThisRun=true`；**promisedToolsWithoutCallCount=0（仅 core，`core:index.ts:548`）**。
  4. 结果全非 error → resetSteeringCount（`core:index.ts:549`）。
  5. 工具结果消息 recordMessage（tool 角色）。
  6. `findFatalToolError`（fatalOnError 工具且非软拒绝/超时/取消/审批否决，`core:types.ts:64-83`）→ `runtime-error` 事件 + `ERROR` + endReason='error'（`core:index.ts:555-556`）。
  7. 安全点 applySafePointControl；hasRunnablePending → `INPUT_AVAILABLE`（force/steer 消费，不消费 followUp）；否则 `TOOLS_COMPLETE`。
- 产出事件：tool-start/tool-end/tool-update、approval-requested/approval-resolved、message-start/end（tool 消息）、checkpoint-created/restored、runtime-error（致命路径）。

### 2.9 handleTurnComplete（`core:index.ts:571-643`，runtime:538-600 无自终止诊断）

- 触发：turn-complete。
- 行为（按优先级）：
  1. `turn-end` 事件 + lifecycle `turn.end`（可返回 `stop` 建议）。
  2. abortReason / abort signal → `FINISH` + aborted（若 ctx.endReason==='error' 则 error）。
  3. ctx.endReason==='error'/'aborted' → `FINISH` + 对应 reason。
  4. **maxTurns**（`shouldStopForMaxTurns` = turnIndex>=maxTurns，`agent-session.ts:262-263`）：条件注入 synthesis nudge（`sawToolsThisRun && needsSynthesis && !nudgeUsed`）→ `INPUT_AVAILABLE`；否则 emit `runtime-error`（retryable:true，纯观测）+ `MAX_TURNS_REACHED` + endReason='max-turns'（`core:index.ts:593-608`）。
  5. `turn.end` 返回 stop → `SHOULD_STOP`（cooperative，不 abort，`core:index.ts:611-614`）。
  6. `composedHooks.shouldStopAfterTurn`：true → `SHOULD_STOP`；toolCallCount>0 → `NEXT_TURN`；consumeIdlePendingInput（**followUp 仅在此 promote**，`core:index.ts:649-658`）→ `INPUT_AVAILABLE`；否则 `SHOULD_STOP`。
  7. 默认路径：toolCallCount>0 → `NEXT_TURN`；idle 输入 → `INPUT_AVAILABLE`；synthesis nudge 条件注入（**run 内自注入，D8**）→ `INPUT_AVAILABLE`；**自终止诊断（仅 core）**：tools>0 && !sawToolsThisRun && promisedToolsWithoutCallCount>0 → emit `runtime-error`（retryable:true，含完整上下文，`core:index.ts:631-640`）；`SHOULD_STOP`。
- 产出事件：turn-end、runtime-error（观测性）、message-start/end（nudge 注入时）。
- 期望语义：**nudge 不注入到当前 run**（注入到下一条用户消息，D8 裁决）；自终止诊断保留但事件类型与 retryable 语义需与「非错误收场」一致（D2 裁决）。

### 2.10 applySafePointControl（`core:index.ts:667-701`，runtime:624-659 仅 cooperative_stop 语义不同）

- 触发：stream 消费结束、tool 批处理后两个安全点。
- 行为（L3 drain 优先级：force_cancel > cooperative_stop > soft_inject，`core:control-bus.ts:270-315`）：
  - **force_cancel**（L3）：abortController.abort → `ABORT` → endReason='aborted'。
  - **cooperative_stop**（L2）：不触发 abort；按当前状态推 SM 到 done（streaming: NO_TOOL_CALLS+SHOULD_STOP；executing-tools: TOOLS_COMPLETE+SHOULD_STOP；turn-complete: SHOULD_STOP）→ endReason 分歧（**core='stop'，`core:index.ts:696`；runtime='aborted'，`runtime:index.ts:654`**，D1）。
  - soft_inject/steer → inputQueue.steer 环；follow_up → inputQueue.followUp 环（`core:control-check.ts:70-87`）；返回 null 继续。

---

## 三、steering 规范

### 3.1 组件职责

- **SteeringCoordinator**（`core:steering-coordinator.ts`）：预算持有者（`maxSteeringBudget` 默认 3，:50）、计数持有者（`steeringCount`，:42）、策略调度（按 phase 过滤，:69）、动作执行（:110-168）。
- **RecoverySteeringStrategy**（`core:recovery-steering-strategy.ts`）：唯一活跃策略，phases=['after-tools','empty-response']（:34）；`maxConsecutiveToolErrors` 默认 2、`maxRepeatedToolCalls` 默认 3、`maxSteeringMessages` 默认 1（:41-43）。
- **GoalAuditStrategy**（`core:goal-audit-strategy.ts:12-19`）：before-turn 占位，恒返回 null。
- **CompressionRecoveryStrategy**（`core:compression-recovery-strategy.ts:12-19`）：after-compaction 占位，恒返回 null。
- **SteeringDelegate**（`core:steering-delegate.ts`）：封装 evaluate/apply；`synthesisNudgeUsed` 标记；nudge 注入入口。

### 3.2 动作类型与执行（`core:steering-coordinator.ts:117-165`）

| 动作 | 执行 | 副作用 |
|---|---|---|
| inject-message | 消息 append 进对话 | steeringCount+1；emit `runtime-steering`（reason+message） |
| emit-diagnostic | 不修改对话 | emit `runtime-steering`（diagnostic 消息） |
| intervention-required | 置 interventionRequired | emit `runtime-intervention-required`（choices=[rollback,pause,user-instruction]） |

### 3.3 计数生命周期

- **增量**：唯一入口 = apply() 执行 inject-message（`core:steering-coordinator.ts:123`）。状态机转移**不** bump steeringCount（`agent-session.ts:120-121` 注释明确）。机器上下文 `ctx.steeringCount` 恒为 0（仅 INPUT_AVAILABLE 时归零，`agent-session.ts:216`），handleSteeringEvaluation 的预算检查是**死代码**（`core:index.ts:520`）——真实预算由 coordinator/策略持有。**Rust 实现必须单一计数源**。
- **重置**：① 工具批全部成功（`core:index.ts:549`）；② length 升级时（`core:provider-call.ts:98`）；③ 无 tool-call 正常结束时（`core:index.ts:493`）。
- **预算**：双层。coordinator 层 `maxSteeringBudget`（构造传 `ro.maxSteeringMessages ?? 1`，`core:index.ts:124`）；策略层 `maxSteeringMessages`（默认 1）。`evaluate()` 中 inject-message 在 `potentialSteeringCount >= maxSteeringBudget` 时被跳过（`core:steering-coordinator.ts:80-83`）；**intervention-required 不受预算限制**（:71）。
- **默认不一致（两拷贝共有潜在缺陷）**：handleSteeringEvaluation 预算检查默认 `?? 3`（`core:index.ts:519`）与 coordinator/策略默认 `?? 1` 不一致；且 handlePrepareTurn 用 `getSteeringCount()`（真实计数，`core:index.ts:240`），handleSteeringEvaluation 用 `ctx.steeringCount`（恒 0，由 coordinator 覆盖，`core:index.ts:529`）。**Rust 实现统一为单一配置源**。

### 3.4 intervention-required 触发条件

- **empty-response 二次即 intervention（D6）**：默认 `maxSteeringMessages=1` 时——第 1 次 empty-response → 策略见 steeringCount=0 < 1 → inject（计数→1）；第 2 次 empty-response → 策略见 1 >= 1 → intervention-required（`core:recovery-steering-strategy.ts:48-53`）→ handler 转 `INTERVENTION_REQUIRED` → **endReason='error'**（`core:index.ts:534`）。
- **after-tools**：`steeringCount >= maxSteeringMessages` 且检测到工具错误循环（detectRecentToolErrorLoop，连续错误≥2）或重复调用（detectRepeatedToolCallLoop，重复≥3）→ intervention-required（`core:recovery-steering-strategy.ts:70-78, 96-102`）。
- **期望语义（裁决）**：intervention-required 是「需要人工介入」信号，发射 `runtime-intervention-required` 事件后**正常收场**（stop），不终结为 error；或终结但保留为独立 reason（见 D9）。

### 3.5 steering 消息形态

- 注入消息为 system 角色，metadata：`{kind:'runtime-steering', reason, steeringCount}`（`core:recovery-steering-strategy.ts:56-60, 83-87`）。
- synthesis nudge：`kind:'synthesis-nudge'`，internal:true（`core:types.ts:20-24`）；tool-promise nudge（仅 core）：`kind:'tool-promise-nudge'`（`core:types.ts:26-31`）。

---

## 四、分歧点表

| # | 分歧 | core 现状 | runtime 现状 | 建议决策 |
|---|---|---|---|---|
| D1 | cooperative_stop 的 endReason | `'stop'`（`core:control-check.ts:26,64`；`core:index.ts:696`；测试断言 stop，`core:control-check.test.ts:28-33`） | `'aborted'`（`runtime:control-check.ts:26,66`；`runtime:index.ts:654`，注释「避免被 task 续轮策略误判为可继续」） | 用户协作停止 ≠ 错误也不等于取消：**新增独立 reason（如 'stopped'）**；若沿用四值枚举则取 `'stop'`，并在 orchestrator 层明确「cooperative stop 不自动续轮」。参考 grok：Cancelled 有独立 category（`turn.rs:997-1027`），MaxTurnsReached 独立（`turn.rs:1028-1062`） |
| D2 | tool-promise steering（MAX_PROMISED_TOOLS_WITHOUT_CALL=3、regex 承诺检测、run 内注入、自终止诊断） | 有（`core:index.ts:76-80,494-512,548,631-640`；`core:types.ts:26-47`；`core:steering-delegate.ts:58-64`） | 无 | **删除 run 内注入**：模型承诺调用但未调用 → 正常结束；把「你承诺了 X 但未执行」的 nudge 附到下一条用户消息（grok 的 recovery 也是注入 user 消息后重试，`turn.rs:1616-1625`）。自终止观测保留，但事件改为非 error 语义（如新增 `agent-self-terminated` 诊断事件） |
| D3 | handleSteeringEvaluation 预注入短路 | 有：hasRunnablePending → 直接 STEERING_COMPLETE（`core:index.ts:522-527`） | 无：总是评估策略（`runtime:index.ts:493-506`） | **保留短路**（避免对已注入 nudge 重复 steering），并推广为「inputQueue 有 steer 待消费即跳过策略评估」 |
| D4 | 自终止诊断事件 | 有（`core:index.ts:631-640`，runtime-error + retryable:true） | 无 | 保留为**诊断事件**（非 error 收场、不 retryable），字段含 toolCallCount/turnIndex/maxTurns/promisedToolsWithoutCall |
| D5 | thinkingIntensity 透传 | 透传（`core:index.ts:268`；`core:provider-call.ts:43,75`；选项声明 `core:runtime-options.ts:53,84`） | 不透传（`runtime:index.ts:263`；`runtime:provider-call.ts:42`；选项已声明 `runtime:types.ts:83,129`） | **保留透传**（选项已声明，缺透传是缺陷）；细节归 provider 语义文档（02-provider-semantics.md） |
| D6 | stopReason='error' 一票否决（D5@master-plan） | 有（`core:index.ts:371`；runtime:366 同） | 同 core | **模型输出与传输错误分离**：响应含文字/tool-call 即 Completed（grok `turn.rs:2397-2484`；pi `agent-loop.ts:196-200` 仅 error/aborted 提前结束）；仅「无文字且无 tool-call 且 stopReason=error」走错误路径 |
| D7 | empty-response 二次即 intervention（D6@master-plan） | 有（`core:index.ts:530-534`；`core:recovery-steering-strategy.ts:48-53`） | 同 core | 空响应 = 模型输出异常而非任务失败：**预算内重试（瞬态分类），预算耗尽正常 stop 收场**；intervention 事件照发但 run 不以 error 终结（pi：空/纯文字回复直接正常结束 run） |
| D8 | run 内自注入 nudge（synthesis/length/tool-promise/provider-failure 五处） | 有：`core:index.ts:459-462,480-482,485-487,505-509,595-597,627-630` | 有（除 tool-promise 外全部同 core） | **run 内一律不注入**；nudge 文本排入下一条用户消息（task 层注入）。对齐 pi：steering 消息来自 `getSteeringMessages()`（`agent-loop.ts:167,182-190,259`），循环自身不产生 nudge |
| D9 | steering 预算耗尽的收场 | STEERING_BUDGET_EXHAUSTED → endReason='error'（`core:index.ts:520,531`；`agent-session.ts:168`） | 同 core | **steering 有硬上限但不以 error 收场**：预算耗尽 → 正常 stop（可带独立 reason 字段）；保留 runtime-intervention-required 事件供 UI 展示 |
| D10 | 预算/计数双轨与默认不一致 | `ctx.steeringCount` 死检查 + `?? 3` vs coordinator `?? 1`（`core:index.ts:519,529` vs `core:index.ts:124`） | 同 core | 单一计数源（coordinator 持有）、单一配置源（recovery.maxSteeringMessages 默认 1）；机器上下文 steeringCount 删除或仅镜像 |

---

## 五、Rust 实现契约要点

1. **类型契约**：`AgentSessionState`（8 态）、`AgentSessionEvent`（20 事件）、`AgentSessionContext`、`AgentEndReason`（四值，见 §1.5）作为 conex-types 一等类型；转移表按 §1.4 穷举实现，**未定义转移必须显式失败**（对应 TS 的 INVALID_TRANSITION 抛错，`core:index.ts:768-771`），不得静默忽略。
2. **错误收场唯一性**：endReason='error' 仅可由 ERROR / INTERVENTION_REQUIRED / PROVIDER_ERROR / STEERING_BUDGET_EXHAUSTED 四个事件产生（§1.6）；任何 handler 不得直接构造 error 收场绕过状态机。Rust 侧用单一 `run 结束决策` 类型（`{reason, error?}`）收敛所有收场路径。
3. **模型输出 / 传输错误分离**：provider 响应分类为 `Message(text|tool-call|both)` / `Empty` / `StreamError(分类)`；`Message`（含纯文字）直接 commit 并走正常 turn-complete；`StreamError` 进入分类重试阶梯（瞬态 3 次、length 升级 2 次；**payload 2 次已删除**——PE-06 T06.2.2 假恢复阶梯作废，PayloadTooLarge 直接 fatal），全部用尽才允许 error。**纯文字回复永不失败**（D6/D7）。
4. **steering 硬上限**：`maxSteeringMessages`（默认 1）为唯一预算；耗尽后禁止 inject-message；intervention-required 事件照发但 run 以 stop 收场（D9）。nudge 注入一律发生在下一条用户消息边界（D8）；`tool-promise` 机制删除（D2）。
5. **安全点与三环输入**：仅 force_cancel（abort）与 force 环输入可打断 stream；steer 在安全点（stream 结束 / tool 批后）消费；followUp 仅 idle（本将 SHOULD_STOP）时 promote（`core:index.ts:649-658`）；cooperative_stop 独立 reason（D1）。
6. **事件序列契约**：agent-start/end、turn-start/end、message-start/end（每条消息必成对）、message-delta（流式）、tool-start/end（每工具成对）、provider-diagnostic、runtime-steering、runtime-intervention-required、context-compression-start/end；`agent-end` 必含 reason（与 error 可选）。
7. **turn 边界**：turn.start 前完成输入消费与 steering 评估；turn.end 后按 `stop 建议 → maxTurns → shouldStopAfterTurn → toolCallCount>0(NEXT_TURN) → idle 输入 → SHOULD_STOP` 顺序决策（§2.9 优先级）；`max-turns` 是独立预算 reason，非 error 非 aborted（§1.5）。
8. **工具执行边界**：批量执行、权限审批（approval-requested 事件必须先于等待，防死锁，`core:tool-execution.ts:327-366`）、validation/repair、materializeOutput、checkpoint；fatalOnError 判定必须排除 softDeny/timedOut/cancelled/approval_expired/user_denied（`core:types.ts:64-83`）；工具结果落盘后才进 turn-complete。
9. **并发与中断**：run 级互斥串行化（sessionMutex，`core:index.ts:149`）；stream 中断后 bounded wait（1500ms）抢救部分内容（`core:index.ts:314-328`）；abort 路径 partial 消息以 stopReason=aborted 落盘（`core:index.ts:388-408`）。
10. **观测性**：max-turns、自终止、steering 行为均 emit `runtime-error`/`runtime-steering` 事件但**不改变收场 reason**（retryable 标志只表「可重试」，与 endReason 正交）；Rust 实现为每个收场决策附带诊断字段（turnIndex/toolCallCount/steeringCount/errors），保证可复现调试。

---

## 遗留问题（下轮消化）

- D1 的 reason 命名：`'stopped'` 新值 vs 沿用 `'stop'`，需与前端 EventRouter 消费端（03-frontend-contract.md）对齐后定稿。
- D9 若引入「stop + 附加 reason 字段」，需要 agent-end 事件结构扩展（`reason` 之外加 `stopReason`），与前端契约联调。
- handleTurnComplete 中 `shouldStopAfterTurn` hook 存在两份互斥逻辑（lifecycle turn.end.stop vs composedHooks.shouldStopAfterTurn，`core:index.ts:611-623`），Rust 实现需确认二者合并策略（建议：以 lifecycle turn.end 为准，composedHooks 兼容层删除）。
