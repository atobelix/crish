# 05 — TS 测试资产盘点与 Rust 测试映射

> 状态：完成（Phase A 步骤 A5）
> 依据：00-master-plan.md A5（docs/rust-rewrite/00-master-plan.md:89）
> 范围：agent-core / agent-runtime / agent-model / agent-orchestrator / agent-daemon / crish-desktop 的 TS 测试资产盘点，映射为 Rust 测试清单。
> 说明：所有结论附 `文件:行号` 依据。本次 bug（模型正常回复一句话后 run 以 error 收场，见 00-master-plan.md:25）相关的"run 失败/文字回复/steering/intervention/工具调用"语义在第三节单独列出。

---

## 一、测试资产总览（按主题分组统计）

### 1.1 文件数量与拷贝关系

| 包 | 测试文件数 | 说明 |
|---|---|---|
| packages/agent-core/src | 36 | Round 5 拷贝，当前主维护版本 |
| packages/agent-runtime/src | 135 | 原始单体，含大量与 core 同路径的拷贝测试（如 session-loop/、state-machine/、runtime-components/ 全套） |
| packages/agent-model/src | 47 | provider 层 |
| packages/agent-orchestrator/src | 10 | 编排层 |
| packages/agent-daemon/src/__tests__ | 4 | e2e（WS 链路，将被删除） |
| apps/crish-desktop/src/api | 103 | 前端（保留复用） |
| apps/crish-desktop/src/utils | 8 | 含 error-translation.test.ts |

统计依据：agent-core 36（packages/agent-core/src 递归 glob）；agent-runtime 135（同上）；agent-model 47；agent-orchestrator 10；agent-daemon `__tests__` 4（daemon 另在 src 根 27 个、handlers 3 个、protocol 2 个）；crish-desktop api 103、utils 8。

**关键事实**：
1. **agent-runtime 与 agent-core 是两份分叉拷贝**：`agent-session-loop.test.ts` 两包各一份，内容几乎一致（runtime 561 行 vs core 557 行），但存在**语义分歧**（见 1.2）。
2. **`provider-openai-chat.test.ts` 不存在**：agent-model 中只有实现 `src/provider-openai-chat.ts`，对应测试是 `src/provider-openai-compatible.test.ts`（2500+ 行，覆盖 chat-completions 与 Responses 两条路径）。
3. **`error-translation.test.ts` 位于 `apps/crish-desktop/src/utils/`**（不在 src/api/），属于前端保留层。
4. `packages/agent-model/src/provider/__tests__/e2e/` 有 5 个被 `describe.skip` 的旧 e2e（依赖未创建的 AgentRuntime），其中 `steering-injection.test.ts` 语义价值高，需在 Rust 侧复活。

### 1.2 核心分歧点（决定测试预期前必须先决策）

| 分歧 | core 版本断言 | runtime 版本断言 | 证据 |
|---|---|---|---|
| D1: cooperative_stop 的 endReason | `stop`（L2 非 abort） | `aborted`（用户发起） | core: packages/agent-core/src/session-loop/control-check.test.ts:28-37 与 agent-session-loop.test.ts:193-205；runtime: packages/agent-runtime/src/session-loop/control-check.test.ts:28-37 与 agent-session-loop.test.ts:197-209 |
| D2: tool-promise steering | 仅 core 有 regex nudge 注入 | — | 00-master-plan.md:133；core runtime.test.ts:411-521（write_file/edit 参数 steering） |

### 1.3 按主题分组统计（高价值文件，含两拷贝）

| 主题 | 文件（以 core 为主，runtime 同名拷贝不再重复列） |
|---|---|
| Session loop / run 生命周期 | agent-session-loop.test.ts（core:117 / runtime:121）、state-machine/run-lifecycle.test.ts:12、state-machine/core.test.ts:29、session-loop/index.test.ts:4、session-loop/provider-call.test.ts:4、session-loop/control-check.test.ts:11 |
| Steering / control / 输入三环 | steering/steering-input-queue.test.ts:20、__tests__/steering-input-queue.test.ts:21、agent-input-queue.test.ts:10、control/control-bus.test.ts:7、session-loop/control-check.test.ts:11 |
| 工具执行与工具流 | runtime-components/tool-executor.test.ts:70、tool-executor-timeout.test.ts:5、tool-stream/tool-stream.test.ts:4、__tests__/integrations/tool-stream.test.ts:4、runtime-components/provider-response-consumer.test.ts:15（tool args delta 部分） |
| Provider 调用与响应消费 | runtime-components/provider-call-gateway.test.ts:50、provider-response-consumer.test.ts:15、recovery-pipeline.test.ts:44、fallback-chain/engine.test.ts:25 |
| 错误分类 / 重试 / 恢复 | __tests__/error-classifier.test.ts:5、recovery/stream-recovery.test.ts:22、openai-retry.test.ts（agent-model）、exponential-backoff（agent-model __tests__）、pricing-engine.adversarial（agent-model） |
| 请求构建与流解析（model 层） | openai-request-build.test.ts:21、__tests__/thinking-intensity.test.ts:13、openai-stream-parse.test.ts、provider-openai-compatible.test.ts:42、provider-gateway.test.ts:29、provider/__tests__/base-engine.test.ts、provider/__tests__/auth.test.ts、provider/__tests__/factory.test.ts、provider/__tests__/registry.test.ts |
| 事件协议 / 投影 | event-protocol/core-event-projector.test.ts:46、event-queue/index.test.ts:18 |
| 上下文 / 压缩 / 钩子 | runtime-components/context-manager.test.ts:14、context-compression-gate.test.ts:38、conversation-engine.test.ts:15、hooks/lifecycle-hooks.test.ts:4、hooks/health-hook-pack.test.ts:48、hooks/compact-lifecycle.test.ts:27 |
| Orchestrator | orchestrator.test.ts（2232 行）、state-machine.test.ts:4、event-store.test.ts:16、session-tree.test.ts:6、artifact-store.test.ts:9、conversation-rewind.test.ts:13、task-assessment.test.ts:10、protocol.test.ts:5 |
| Daemon e2e（将删除，语义迁移） | __tests__/error-propagation.e2e.test.ts:141、agent-protocol.e2e.test.ts:174、agent-real-workflow-e2e.test.ts:40、live-provider.e2e.test.ts:4 |
| 前端保留（不迁移，参考） | api/StreamRenderBuffer.framing.test.ts:39、utils/error-translation.test.ts:43 |
| 测试替身自身 | testing/__tests__/faux-provider.test.ts:5（core 与 runtime 各一份） |


---

## 二、高价值测试语义清单（文件名:测试名 → 语义）

> 规则：runtime 与 core 同名拷贝仅列一次（标注"两拷贝同"）；行号为该测试所在文件的断言位置。

### 2.1 Session loop / run 生命周期（两拷贝同，core 为引用）

- `agent-session-loop.test.ts:122` `emits agent-start and agent-end for a full run` → 完整 run 必须发出 agent-start/agent-end 事件对
- `agent-session-loop.test.ts:134` `records user input message` → 用户输入以 message-start（role=user, text block）事件发出
- `agent-session-loop.test.ts:147` `abort signal cancels session` → 预置 AbortSignal → agent-end.reason=aborted
- `agent-session-loop.test.ts:177` `reaches done state via max turns` → maxTurns 用尽 → endReason=max-turns（非 aborted，budget 语义）
- `agent-session-loop.test.ts:193` `cooperative_stop yields endReason=stop (L2, not abort)`（core）→ L2 协作停 → stop；**runtime 同测试断言 aborted（agent-runtime/src/agent-session-loop.test.ts:197）——分歧 D1**
- `agent-session-loop.test.ts:207` `force_cancel yields endReason=aborted (L3)` → L3 强停 → aborted
- `agent-session-loop.test.ts:221` `L2 cooperative_stop keeps partial assistant text for continue` → 协作停保留已流出的部分文字，后续可继续
- `agent-session-loop.test.ts:244` `L3 force_cancel keeps partial assistant text (continue-after-abort)` → mid-stream 强停（pauseAfterIndex 注入）保留部分文字且不以空回复失败
- `agent-session-loop.test.ts:292` `after L2 stop, a fresh loop accepts a new user prompt (continue)` → 新 loop 可承接 stop 后的继续
- `agent-session-loop.test.ts:321` `after L3 abort, a fresh loop accepts a new user prompt (continue)` → 新 loop 可承接 abort 后的继续
- `agent-session-loop.test.ts:346` `lifecycle turn.end observe fires once per turn` → 每 turn 恰好一次 turn.end
- `agent-session-loop.test.ts:377` `lifecycle tool.pre block prevents tool execute; tool.post still skipped` → tool.pre 返回 block 时工具不执行、tool.post 不触发、tool-end.isError=true 且输出含 block 原因
- `agent-session-loop.test.ts:467` `lifecycle tool.post receives output; turn + tool hooks coexist` → 顺序 turn.start → tool.pre → tool.post → turn.end；tool-end 携带执行输出
- `session-loop/index.test.ts:5` `should detect length stopReason and auto-continue` → finishReason=length → 动作 escalated
- `session-loop/index.test.ts:14` `should expand maxTokens on length truncation` → 连续两次 length 截断：maxTokens 8192→16384→32768（倍增）
- `session-loop/provider-call.test.ts:5` `should trigger continue prompt on length finish reason` → escalated 的 nudgeText 含 "truncated"，并 reset steering 计数
- `state-machine/run-lifecycle.test.ts:19` `should follow normal lifecycle: queued → initializing → running → completing → completed` → run 生命周期状态机主路径
- `state-machine/run-lifecycle.test.ts:40` `should handle approval flow: running → awaiting-approval → running` → 审批挂起/恢复不终结 run
- `state-machine/run-lifecycle.test.ts:52` `should handle cancellation from running` → CANCEL_REQUESTED → cancelling → cancelled（终态）
- `state-machine/run-lifecycle.test.ts:75` `should handle init error` / `:84` `should handle runtime error from running` → 错误路径 → failed 终态
- `state-machine/run-lifecycle.test.ts:93` `should handle max turns` → MAX_TURNS_REACHED → endReason=max-turns
- `state-machine/run-lifecycle.test.ts:116` `should reject invalid transitions from terminal states` → 终态拒绝再转移
- `state-machine/run-lifecycle.test.ts:155` `mapEndReasonToOutcomeReason` → endReason+state → outcome reason 映射表（error→runtime-error 等）

### 2.2 Steering / control / 输入三环（本次 bug 高相关）

- `control/control-bus.test.ts:8` `request 入队并补齐 id/level/createdAt` → ControlBus L3 队列入队规范
- `control/control-bus.test.ts:44` `drainAsAction: force_cancel 优先于 cooperative_stop` → 冲突时 force 优先
- `control/control-bus.test.ts:56` `drainAsAction: cooperative_stop 带 pending soft messages` → L2 与 soft 注入的合并语义
- `control/control-bus.test.ts:83` `drainAsAction: steer 与 follow_up 分环` → steer/followUp 分环消费
- `agent-input-queue.test.ts:10` `默认 enqueue 为 force，可 hasForcePending` → 输入队列三环（force/soft/steer）语义
- `agent-input-queue.test.ts:90` `enqueueFollowUp 不进入 dequeue / hasRunnablePending` → followUp 环不阻塞当前 run
- `agent-input-queue.test.ts:101` `dequeue 顺序 force > steer，永不自动取 followUp` → 取数优先级
- `agent-input-queue.test.ts:123` `promoteFollowUp 将 followUp 提升为 steer（idle 路径）` → idle 时 followUp 提升
- `agent-input-queue.test.ts:153` `pi 场景：tool 批后可取 steer，followUp 仍挂起直至 idle promote` → 工具批次后的安全点取 steer
- `session-loop/control-check.test.ts:17` `force_cancel → aborted 语义` → 安全点检查返回 force_cancel + endReason=aborted
- `session-loop/control-check.test.ts:28` `cooperative_stop → stop（L2，非 abort）`（core）/ `→ aborted`（runtime）→ 分歧 D1
- `session-loop/control-check.test.ts:39` `soft_inject 写入 inputQueue steer 通道` → soft_inject 只进 steer 通道
- `session-loop/control-check.test.ts:53` `steer → steer 环；follow_up → followUp 环（pi 分环）` → 安全点只消费 steer；idle promoteFollowUp
- `steering/steering-input-queue.test.ts:22` `enqueues and returns all entries in FIFO order` → 跨 run steering 队列 FIFO
- `steering/steering-input-queue.test.ts:39` `dequeueByGroup` → 按 groupId 提取（用于同组 steering 合并）
- `steering/steering-input-queue.test.ts:74` `replaceOrEnqueue` → 同 groupId 替换旧条目
- `steering/steering-input-queue.test.ts:161` `steering message evicts oldest non-steering when full` → 容量策略：steering 优先于普通输入
- `steering/steering-input-queue.test.ts:203` `transferTo` → 跨 run 迁移（含容量限制与 steering 优先级）
- `__tests__/steering-input-queue.test.ts:62` `transferTo migrates all entries across runs` → 同前，core 拷贝

### 2.3 工具执行 / 工具流

- `runtime-components/tool-executor.test.ts:71` `executes a single tool call successfully` → 单工具执行与输出
- `runtime-components/tool-executor.test.ts:82` `emits tool-batch-start and tool-batch-end events` → 批次事件
- `runtime-components/tool-executor.test.ts:92` `executes parallel tools concurrently` → 并行工具并发执行
- `runtime-components/tool-executor.test.ts:126` `returns error for unknown tool` → 未知工具 → 类型化错误
- `runtime-components/tool-executor.test.ts:134` `returns error for invalid tool input` → 校验失败 → 类型化错误（不执行）
- `runtime-components/tool-executor.test.ts:159` `partitions parallel and exclusive tools correctly` → 并行/互斥分区
- `runtime-components/tool-executor.test.ts:192` `handles tool execution error gracefully` → 执行抛错 → isError=true
- `runtime-components/tool-executor.test.ts:212` `cancels sibling tools on failure when policy is cancel-siblings` → 失败策略：cancel-siblings
- `runtime-components/tool-executor.test.ts:300` `continues draining on failure when policy is continue-drain` → 失败策略：continue-drain（默认）
- `runtime-components/tool-executor.test.ts:319` `executes sequential tools (allowParallel=false) in order` → 顺序执行
- `runtime-components/tool-executor.test.ts:378` `cancels sequential execution when abort signal is already aborted` → abort 提前中断
- `runtime-components/tool-executor-timeout.test.ts:6` `honors timeoutMs on the default executeSingleWithEvents path` → 工具超时
- `tool-stream/tool-stream.test.ts:5` `accumulates arguments across multiple deltas` → OpenAI 风格 tool args 增量累积
- `tool-stream/tool-stream.test.ts:46` `accumulates text across multiple appends` → Anthropic 风格 start/append/finish
- `tool-stream/tool-stream.test.ts:94` `repairs trailing comma before closing brace` → JSON 修复（尾逗号/未闭合）
- `tool-stream/tool-stream.test.ts:160` `reset` → 清空挂起工具
- `__tests__/integrations/tool-stream.test.ts:5` `accumulates a large valid JSON payload across many deltas` → 大 JSON 跨帧累积
- `__tests__/integrations/tool-stream.test.ts:116` `handles OpenAI-style function call deltas` / `:133` Anthropic / `:159` Gemini（index 式）→ 跨厂商格式兼容

### 2.4 Provider 调用与响应消费

- `runtime-components/provider-call-gateway.test.ts:51` `streams text-delta events and returns accumulated text` → 流式 delta → 累积文字 + 事件
- `runtime-components/provider-call-gateway.test.ts:65` `captures tool calls from provider events` → tool-call 事件 → 响应 toolCalls
- `runtime-components/provider-call-gateway.test.ts:99` `reports error when provider throws during streaming` → provider 抛错 → error 响应
- `runtime-components/provider-call-gateway.test.ts:126` `handles empty provider response gracefully` → 空响应不崩溃
- `runtime-components/provider-call-gateway.test.ts:135` `aborts early when signal is already aborted` → 预置 abort 提前退出
- `runtime-components/provider-call-gateway.test.ts:231` `retries with exponential backoff on network errors` → 网络错误指数退避重试
- `runtime-components/provider-call-gateway.test.ts:270` `abort during streaming returns aborted error` → 流中 abort → aborted
- `runtime-components/provider-response-consumer.test.ts:16` `abort mid-stream with text keeps partial message (stopReason=aborted)` → L3 中断保留部分消息
- `runtime-components/provider-response-consumer.test.ts:36` `abort with no content → error aborted` → 无内容 abort → 错误
- `runtime-components/provider-response-consumer.test.ts:51` `end with finishReason length, text only → metadata.stopReason === length` → stopReason 保真（length）
- `runtime-components/provider-response-consumer.test.ts:71` `end with finishReason length + tool-call block → stopReason === tool-call` → 有工具块时 stopReason=tool-call（**D5 相关：stopReason 判定优先级**）
- `runtime-components/provider-response-consumer.test.ts:104` `no finishReason, text → stopReason === stop` → 纯文字默认 stop
- `runtime-components/provider-response-consumer.test.ts:125` `error → stopReason === error` → **D5 核心：error 一票否决语义所在**
- `runtime-components/provider-response-consumer.test.ts:156` `sink receives partials when stream emits tool-call phase delta` → 工具参数增量流（onToolArgsDelta）
- `runtime-components/provider-response-consumer.test.ts:264` `sink throw must not break stream consume` → sink 异常隔离

### 2.5 请求构建 / 思考参数（agent-model）

- `openai-request-build.test.ts:22` `compactObject drops undefined` → 请求对象瘦身
- `openai-request-build.test.ts:34` `stringifyToolOutput prefers text then json then artifacts` → 工具输出序列化优先级
- `openai-request-build.test.ts:43` `auth and maxTokens helpers` → auth 头（authorization/api-key/x-api-key）与 max_tokens 生成
- `openai-request-build.test.ts:54` `reasoning effort normalization and wire shapes` → reasoning_effort 归一化（xhigh→high）与 responses/chat-completions 两形态
- `openai-request-build.test.ts:71` `reasoningEffortObject vendor 适配生成原生 reasoning 参数` → **vendor 分派：openai(推理参数)/anthropic(thinking+budget_tokens)/deepseek/gemini(thinking_level)；vendor 优先于 endpoint**
- `openai-request-build.test.ts:116` `reasoningEffortHeaders 仅 Anthropic 返回 anthropic-beta` → interleaved-thinking 头
- `openai-request-build.test.ts:129` `inferReasoningVendor 从 baseUrl 和 model 推断 vendor` → vendor 推断表（含 o1/o3/o4、deepseek-r1 等）
- `openai-request-build.test.ts:155` `tool choice and tool schemas` → toChatToolChoice / toResponsesToolChoice / toOpenAITool / toResponsesTool
- `openai-request-build.test.ts:183` `stripInlineDataUrls and normalizeContentParts` → 内联 data URL 脱敏与 content parts 归一化
- `__tests__/thinking-intensity.test.ts:14` `识别 OpenAI o3 系列` → 能力推断：format=reasoning-effort
- `__tests__/thinking-intensity.test.ts:29` `识别 Anthropic Claude Sonnet 4` → format=thinking-budget，levels 含 xhigh
- `__tests__/thinking-intensity.test.ts:37` `识别 Gemini 2.5` → format=thinking-level，不含 xhigh
- `__tests__/thinking-intensity.test.ts:63` `normalizeThinkingIntensity` → off/不支持返回 undefined；xhigh 在 Gemini 降级 high
- `__tests__/thinking-intensity.test.ts:85` `effortToBudgetTokens` → minimal=128 … xhigh=8192
- `__tests__/thinking-intensity.test.ts:101` `resolveThinkingParams` → 三厂商 + 两端点参数形态
- `__tests__/thinking-intensity.test.ts:155` `thinkingHeaders` → 仅 Anthropic 注入 anthropic-beta
- `__tests__/thinking-intensity.test.ts:171` `getAvailableThinkingLevels` → Claude 6 档 / Gemini 5 档 / 不支持仅 off

### 2.6 错误分类 / 恢复 / 重试

- `__tests__/error-classifier.test.ts:6` `401 status → CLIENT_AUTH, not retryable, does not trip breaker` → HTTP 状态 → 分类表（401/403/429/5xx/402/413…）
- `__tests__/error-classifier.test.ts:155` `400 status with context overflow → … subType context_length_exceeded` → context 溢出子类型
- `__tests__/error-classifier.test.ts:44` `AbortError (DOMException) → USER_ABORT with silent severity` → 取消类错误
- `__tests__/error-classifier.test.ts:344` `abort signal set → USER_ABORT even with status code` → abort 优先于状态码
- `__tests__/error-classifier.test.ts:273` `context_length_exceeded message → retryable true` → 消息文本启发式
- `recovery-pipeline.test.ts:60` `retries on transient network error (throw)` → 重试管道：抛错重试
- `recovery-pipeline.test.ts:76` `retries on transient error in stop event` → 重试管道：stop.reason=error 重试
- `recovery-pipeline.test.ts:92` `returns error when max retries exceeded` → 重试耗尽 → 错误
- `recovery-pipeline.test.ts:99` `calls onActionableError on non-retryable errors` → 不可重试 → onActionableError
- `recovery-pipeline.test.ts:115` `recovers from context length exceeded via contextHealer` → context 溢出 → 压缩后重试
- `recovery-pipeline.test.ts:133` `enforces max depth to prevent infinite recursion` → 恢复深度上限
- `recovery/stream-recovery.test.ts:62` `decideRetry` → 429/5xx/网络/中断 → retry；退避递增且有上限
- `recovery/stream-recovery.test.ts:188` `ToolIdempotencyGuard` → 工具幂等（去重已执行 id）

### 2.7 事件协议 / 上下文 / 钩子（简）

- `event-protocol/core-event-projector.test.ts:49-422` → 24 种 AgentEvent → core event 域/相位/严重度投影（agent/turn/message/tool/compression/diagnostic）
- `event-protocol/core-event-projector.test.ts:457` `maps all 24 AgentEvent types without error` → 穷举映射不遗漏
- `hooks/lifecycle-hooks.test.ts:55` `on(tool.pre) 可 block` → 生命周期钩子可阻断
- `hooks/health-hook-pack.test.ts:104` `toolBlockRate rises when pre has no post` → 健康指标
- `runtime-components/conversation-engine.test.ts:84` `processes a text-only provider response into a turn result` → 文字响应 → turn
- `runtime-components/conversation-engine.test.ts:99` `processes a tool-call provider response with tool_calls` → 工具响应 → turn
- `runtime-components/conversation-engine.test.ts:114` `stops when max turns is reached with tool calls remaining` → maxTurns 边界
- `runtime-components/conversation-engine.test.ts:208` `returns steering message when steering count is under budget` / `:216` `intervenes when steering count exceeds budget` → **steering 预算语义（D6 相关）**


### 2.8 Orchestrator（编排层）

- `orchestrator.test.ts:19` `classifies streaming deltas as non-durable and lifecycle events as durable` → message-delta/thought-delta 非持久化；agent/message-start/end、approval 等持久化
- `orchestrator.test.ts:34` `wraps runtime events in sequenced run events` → run 事件序列（run-queued→run-started→goal-round→runtime-event→run-completed）且 sequence 连续
- `orchestrator.test.ts:93` `streams message-delta live without blocking the drive loop on event-store append` → 流式 delta 不等待慢速 store 追加（性能语义：120 delta 在 40ms/append 下 <2.4s）
- `orchestrator.test.ts:191` `still awaits durable runtime events so intermediate approval status is observed` → 持久化事件（approval-requested）仍同步等待 → 状态可见
- `orchestrator.test.ts:239` `fails a durable run when the event store append fails instead of advertising replayable history` → 写失败 → run-failed(event-store-write-failed)，不假装可回放
- `orchestrator.test.ts:291` `marks a run as awaiting approval while runtime waits` → awaiting-approval 中间态 → 批准后回 running → completed
- `orchestrator.test.ts:360` `persists and restores daemon-owned pending input records` → 待处理输入持久化与恢复（含 after-current-run 模式）
- `orchestrator.test.ts:404` `restores in-flight runs as interrupted terminal records with audit events` → 重启恢复：queued/running/awaiting-approval/cancelling → failed(daemon-restarted)/cancelled，带 previousStatus 审计
- `orchestrator.test.ts:640` `preserves blocked outcome and reason while restoring terminal records` → blocked 终态保真恢复
- `orchestrator.test.ts:702` `preserves completed failed and cancelled records while restoring terminal history` → 终态记录原样保留
- `orchestrator.test.ts:813` `moves the active session leaf through a durable session event` → conversation-rewind 叶子移动持久化
- `orchestrator.test.ts:885` `state snapshot restore` → 快照全量/增量/损坏回退（lastSequence 后增量流）
- `orchestrator.test.ts:1073` `aborts active runs through the registered run engine` → steerRun/cancelRun 到 engine 的接线
- `orchestrator.test.ts:1113` `cooperative cancel uses ControlBus injection and does not hard abort` → **L2：cooperative 取消不触发 abort；run 以 cancelled/aborted 收尾（注释：cooperative stop 语义为 aborted）**
- `orchestrator.test.ts:1151` `force cancel (L3) hard-aborts provider and emits mode=force` → **L3：强制取消 hard abort**
- `orchestrator.test.ts:1186` `cooperative cancel without ControlBus falls back to force abort` → 引擎不支持 L2 时回落 L3（mode=cooperative-fallback-force）
- `orchestrator.test.ts:1223` `marks max-turns agent endings as failed instead of completed` → agent-end(max-turns) → run-failed + error 文案
- `orchestrator.test.ts:1270` `marks runtime errors as failed and preserves provider detail` → provider-diagnostic(429 quota)+runtime-error → run-failed(provider-error) 且 outcomeDetail 保留 status/errorKind
- `orchestrator.test.ts:1337` `continues goal runs across runtime engines and completes from a continuation decision` → goal 续轮（CONEX_GOAL_DECISION tool 输出）
- `orchestrator.test.ts:1453` `blocks goal runs that stop without typed progress or continuation` → 无进展 → blocked(goal-blocked)
- `orchestrator.test.ts:1520` `blocks goal runs when continuation would exceed the round budget` → maxRounds → blocked(goal-max-rounds)
- `orchestrator.test.ts:1566` `keeps max-turns inside goal runs as a failed outcome` / `:1605` `keeps provider errors inside goal runs as failed outcomes without continuation` → goal 内错误不续轮
- `orchestrator.test.ts:1654` `does not increment completedRounds on provider rate-limit backoff/retry` → 429 退避轮不计入完成轮
- `orchestrator.test.ts:1773` `blocks stalled goal runs after repeated progress signatures` → 相同 progressSignature 连续 → stalled
- 其余：`state-machine.test.ts:5` run 状态机合法转移/终态拒绝重写；`event-store.test.ts:23` JSONL 事件存储（版本头/按 session/run/sequence 读取/坏行跳过/幂等 id/写失败 latch）；`session-tree.test.ts:7` 会话树追加/分叉/叶子移动/回滚；`artifact-store.test.ts:16` 内容寻址 blob 存储；`conversation-rewind.test.ts:14` rewind 计划顺序（取消 run→清审批→恢复检查点→移动叶子）；`task-assessment.test.ts:11` goal 决策映射（cancelled/failed→block，max-turns 优先）；`protocol.test.ts:6` 版本化信封与断点续传

### 2.9 Daemon e2e（WS 链路将删除，语义迁移至 Tauri IPC 层）

- `__tests__/error-propagation.e2e.test.ts:142` `NO_PROVIDER preflight error: legacy code at top-level, migrated code in payload (Path A)` → preflight 错误：顶层 code=NO_PROVIDER（旧码），payload.code=config.missing（新码映射），含 category/retryable/timestamp
- `__tests__/error-propagation.e2e.test.ts:181` `provider CrishError throw: error message preserved, RUN_ERROR mapped to runtime.unexpected_state (Path B)` → **provider 抛 CrishError → orchestrator 转 string → run-failed → 顶层 RUN_ERROR + payload runtime.unexpected_state；结构信息在 orchestrator 边界丢失（保留 message）**
- `__tests__/error-propagation.e2e.test.ts:225` `provider unknown Error throw: … (Path B)` → 普通 Error 同路径
- `__tests__/error-propagation.e2e.test.ts:265` `backward compatible: old consumers read type/code/message/runId without payload` → 旧消费者字段兼容
- `__tests__/error-propagation.e2e.test.ts:309` `toErrorPayload preserves nested cause chain up to max depth` → cause 链序列化（最多 8 层）
- `__tests__/error-propagation.e2e.test.ts:356` `toErrorPayload migrates legacy string codes via migrateErrorCode` → 旧码迁移（NO_PROVIDER→config.missing）
- `agent-protocol.e2e.test.ts:174-424` → run-task 主循环（run-started→stream-chunk→run-completed）、approve-tool 审批挂起、subagent 派发、断线重连、SIGTERM/SIGKILL 崩溃恢复
- `agent-real-workflow-e2e.test.ts:47-435` → 真实链路：审批授权/拒绝、multi_replace_file_content、子 Agent 级联取消、cancel-run 清理 pending、conversation rewind 文件回滚

### 2.10 前端保留层（不迁移，仅对齐语义）

- `api/StreamRenderBuffer.framing.test.ts:40` `超过 maxBytesPerFrame 的数据拆分为多帧` → 分帧不丢内容
- `api/StreamRenderBuffer.framing.test.ts:74` `换行符边界友好分割` → 分帧不拆换行
- `api/StreamRenderBuffer.framing.test.ts:89` `积压超过 maxBacklogBytes 时 degraded=true` → 背压降级（跳帧）
- `api/StreamRenderBuffer.framing.test.ts:157` `无视 maxBytesPerFrame 一次性刷完` → flush(true) 强制
- `api/StreamRenderBuffer.framing.test.ts:181` `不切断 surrogate pair` → UTF-8 安全截断
- `api/StreamRenderBuffer.framing.test.ts:220` `非 force 时 budget 耗尽后停止当前帧` → 帧预算
- `utils/error-translation.test.ts:44` `transient category maps to severity warning and retryable true` → 错误显示映射（severity/可见性）
- `utils/error-translation.test.ts:71` `runtime.aborted code maps to severity silent` → **aborted 类错误静默（不打扰用户）**
- `utils/error-translation.test.ts:127` `unknown code falls back to generic English message` → 未知码回退
- `utils/error-translation.test.ts:206` `wraps string with common.unknown code` → 非 CrishError 归一化
- `utils/error-translation.test.ts:262` `reconstructs CrishError from payload` / `:298` `truncates cause chain at depth 8` → payload 反序列化

---

## 三、run 生命周期 / 错误路径相关测试专节（本次 bug 相关语义）

> 背景（00-master-plan.md:25, 132-137）：模型正常回复一句话后 run 以 error 收场——stopReason=error 一票否决（D5）、empty-response 二次即 intervention-required（D6）、tool-promise regex steering 在同一 run 内注入（D2）。以下测试是这些语义的**唯一行为锚点**。

### 3.1 文字回复与 stopReason 判定（D5）

| 测试 | 语义 | 依据 |
|---|---|---|
| provider-response-consumer: end with finishReason length, text only → stopReason=length | 纯文字 + length → length | packages/agent-core/src/runtime-components/provider-response-consumer.test.ts:51 |
| provider-response-consumer: end with finishReason length + tool-call block → stopReason=tool-call | 有工具块时工具优先于 length | 同上 :71 |
| provider-response-consumer: no finishReason, text → stopReason=stop | 纯文字默认 stop | 同上 :104 |
| provider-response-consumer: error → stopReason=error | **error 一票否决的落点** | 同上 :125 |
| runtime.test: keeps assistant text and tool calls in source order while batching parallel tools | 文字与工具调用乱序不丢失、顺序保持 | packages/agent-core/src/core/runtime.test.ts:93 |
| runtime.test: yields assistant deltas before the provider stream finishes | 文字 delta 先于流结束流出 | 同上 :666 |
| runtime.test: yields tool progress before the tool completes | 工具进度先于工具完成流出 | 同上 :708 |

### 3.2 empty-response steering 与 intervention（D6）

| 测试 | 语义 | 依据 |
|---|---|---|
| runtime.test: steers once when the provider returns an empty assistant turn | **空回复 → 注入一次 runtime-steering（nudge 文案 "previous assistant turn produced no visible text"）→ 第二次请求** | packages/agent-core/src/core/runtime.test.ts:1587（runtime 拷贝 :1586） |
| runtime.test: pauses instead of repeatedly steering unrecovered empty assistant turns | **二次空回复不再 steering，发出 runtime-intervention-required 暂停，总请求数=2** | 同上 :1628（runtime :1627） |
| conversation-engine: returns steering message when steering count is under budget | steering 预算内返回 nudge | packages/agent-core/src/runtime-components/conversation-engine.test.ts:208 |
| conversation-engine: intervenes when steering count exceeds budget | 超预算 → intervention | 同上 :216 |

### 3.3 工具失败 steering 与 intervention（D2/D6 工具侧）

| 测试 | 语义 | 依据 |
|---|---|---|
| runtime.test: injects runtime steering for repeated tool failures, then pauses for intervention if unrecovered | 连续工具失败（maxConsecutiveToolErrors=2）→ 注入 runtime-steering → 仍失败 → runtime-intervention-required；请求数=2 | packages/agent-core/src/core/runtime.test.ts:1475（runtime :1474） |
| runtime.test: treats repeated non-zero terminal exit codes as recoverable tool failures | shell 退出码非零按可恢复工具失败处理（触发 steering，第三次恢复） | 同上 :1528（runtime :1527） |
| runtime-helpers: detectRecentToolErrorLoop | 工具错误环检测（softDeny+user_denied 不计入） | packages/agent-core/src/core/runtime-helpers.test.ts:76-128 |
| runtime.test: steers malformed long write_file arguments toward chunked edit calls | **tool-promise steering（core 独有）：坏 write_file 参数 → nudge 转向 edit/insert_tail** | packages/agent-core/src/core/runtime.test.ts:411 |
| runtime.test: steers malformed edit arguments toward numbered lines and snapshot tags | 坏 edit 参数 → nudge 转向 numbered lines + snapshotTag | 同上 :467 |
| runtime.test: repairs provider tool-call inputs before validation and execution | 工具输入修复先于校验执行 | 同上 :523 |

### 3.4 run 失败 / 收口语义

| 测试 | 语义 | 依据 |
|---|---|---|
| runtime.test: records provider startup failures as runtime errors without appending assistant messages | provider 启动抛错 → runtime-error 事件，不追加 assistant 消息 | packages/agent-core/src/core/runtime.test.ts:1658（runtime :1657） |
| orchestrator: marks max-turns agent endings as failed instead of completed | agent-end(max-turns) → run-failed(max-turns) | packages/agent-orchestrator/src/orchestrator.test.ts:1223 |
| orchestrator: marks runtime errors as failed and preserves provider detail | runtime-error+provider-diagnostic → run-failed(provider-error) 保留 429/quota | 同上 :1270 |
| orchestrator: fails a durable run when the event store append fails | store 写失败 → run-failed(event-store-write-failed) | 同上 :239 |
| provider-call-gateway: J-10 error injection & recovery | 注入错误/部分事件/backoff 重试/流中 abort 全路径 | packages/agent-core/src/runtime-components/provider-call-gateway.test.ts:169-270 |
| error-classifier: 全量分类表 | HTTP 状态/消息文本 → 分类、可重试、子类型 | packages/agent-core/src/__tests__/error-classifier.test.ts:5-416 |

### 3.5 中断与继续（L2/L3 与 abort）

| 测试 | 语义 | 依据 |
|---|---|---|
| agent-session-loop: L2/L3 停止语义与部分文字保留、继续（6 个用例） | 见 2.1 节清单 | packages/agent-core/src/agent-session-loop.test.ts:193-344 |
| provider-response-consumer: abort mid-stream with text keeps partial message | 中断保留已流文字 | packages/agent-core/src/runtime-components/provider-response-consumer.test.ts:16 |
| runtime.test: enqueueSteerInput soft vs enqueueForceInput | **steer 不打断流、force 可打断流、cooperative stop 与 pending steer 共存** | packages/agent-core/src/core/runtime.test.ts:1696-1850 |


---

## 四、测试替身基建说明（faux-provider / mock-tool 构造方式）

> 用途：为 Rust 侧 `TestProvider` / `TestTool` 设计提供直接参考。所有替身位于 `packages/agent-core/src/testing/`（agent-runtime 有同名拷贝）。

### 4.1 FauxAgentProvider（轻量，事件脚本式）— packages/agent-core/src/testing/faux-provider.ts:4-70

```ts
class FauxAgentProvider implements AgentProvider {
  setEvents(events: ProviderStreamEvent[]);  // 预置事件脚本（text-delta/stop 等）
  setError(error: Error);                     // 流开始即抛错
  setLatency(ms);                             // 首事件前延迟（测试超时/竞态）
  setFailAfter(n);                            // 只 yield 前 n 个事件后静默停止
  reset();
  async *stream(request) {
    if (this.error) throw this.error;
    if (this.latencyMs > 0) await sleep(...);
    for (i < min(failAfter ?? len, len)) yield events[i];
  }
}
```
- 语义要点：`error` 在 yield 前抛（模拟传输层失败）；`failAfter` 模拟中途断流；`stop(reason=error)` 事件后 break（模拟 stopReason=error）。:50-69
- 自身测试见 `testing/__tests__/faux-provider.test.ts:5-90`（顺序 yield、抛错、延迟、failAfter、reset）。

### 4.2 FauxProvider（全功能版，含生命周期/健康检查）— packages/agent-core/src/testing/faux-provider-full.ts:21-154

- 增加 `init()/dispose()/healthCheck()`、`setHealthStatus('healthy'|'degraded'|'unhealthy')`、`healthCheckCount`、`setFailAfter`。
- `stream()` 在 `request.signal.aborted` 时提前 return（**abort 协作语义**，:129,139）；`error` 事件或 `end(finishReason=error)` 后 break（:142-147）。
- 适用于需要 provider 生命周期/健康检查语义的测试（runtime 健康路由场景）。

### 4.3 createMockTool — packages/agent-core/src/testing/mock-tool.ts:25-65

```ts
createMockTool({
  name, label, description, category, inputSchema,
  concurrency, allowParallel, fatalOnError,
  output,          // 固定成功输出（默认 { text: `Mock output from ${name}` }）
  error,           // 固定抛错
  readOnly,        // isReadOnly 返回值
  executeHook,     // (input, context) => void，记录调用或按输入分支
})
```
- 语义要点：`executeHook` 是"分支行为"的注入点（可记录入参、按入参抛错/返回不同输出）；`summarize` 固定为 `name(JSON.stringify(input))`。

### 4.4 FauxProviderCallGateway — packages/agent-core/src/testing/faux-call-gateway.ts:23-129

- 路由层替身：`setPlan(model, plan)` / `setProvider(model, provider)` / `setDefaultPlan` / `setDefaultProvider`；`getDecisions()` 记录 planRoute/resolveProvider/recordRouteResult 调用序列。
- 未配置时抛 `ProviderGatewayPlanNotFoundError` / `ProviderGatewayProviderNotFoundError`（:77-89）——用于路由失败路径。
- 对应 Rust 侧 TestGateway：可断言"本次请求走了哪个 provider/plan"。

### 4.5 createMockGateway（session-loop 级事件网关）— packages/agent-core/src/agent-session-loop.test.ts:28-58（runtime 拷贝 :28-62）

- 用**事件数组**构造 ProviderCallGateway 子类：逐条 yield 事件（start/delta/tool-call/end/error），结束返回聚合 response（finishReason/text/toolCalls/error）。
- 支持 `pauseAfterIndex + pauseMs`：在第 N 个事件后 sleep——用于让 L3 force_cancel 在"mid-stream"落地（:34-39, 244-258 的 pauseAfterIndex:2/pauseMs:60）。
- 这是 Rust 侧 `TestProvider` 的"脚本 + 同步栅栏"模式的直接蓝本。

### 4.6 scripted provider（闭包计数分支）— packages/agent-core/src/core/runtime.test.ts 全文件

- 模式：`let requestCount = 0; provider.stream = async function* (req) { requestCount++; if (requestCount === 1) { yield ...tool-call... } else { yield ...text... } }`。
- 同时记录 `requests[]`（每次请求的 messages/tools），用于断言 **nudge 文案是否注入下一轮请求**（:1474-1525、:1586-1655）。
- 这是"按调用次数分叉脚本 + 请求记录断言"的标准写法，Rust 侧建议一等支持（TestProvider 记录 `requests: Vec<ProviderRequest>` 并暴露给断言）。

### 4.7 e2e mock server — packages/agent-model/src/provider/__tests__/e2e/mock-server.ts（被 steering-injection.test.ts:6 引用）

- 本地 HTTP mock（LlmApiMockServer + Scenarios）模拟 SSE 流，用于 provider 传输层 e2e。Rust 侧对应 `wiremock`/`httpmock` 或自建 tokio TcpListener mock。
- 注：`provider/__tests__/e2e/steering-injection.test.ts:13` 整文件 `describe.skip`（依赖未建成的 AgentRuntime），但其两个用例语义（工具执行中注入 steer 不打断当前工具、下一轮生效 :60-151；tool-args delta 窗口 steer :153-237）在 Rust 集成层必须复活。

### 4.8 其它基建

- `packages/agent-core/src/testing/fixture-loader.ts`：加载 fixture 文件（快照/录音）。
- `packages/agent-core/src/testing/index.ts`：测试工具包导出入口。
- InMemorySessionStore / SessionRecorder：agent-session-loop.test.ts:69-71 用于会话记录（Rust 侧对应内存版会话存储）。

### 4.9 Rust 侧 TestProvider / TestTool 设计建议（对应关系）

| TS 替身能力 | Rust 对应 |
|---|---|
| setEvents（事件脚本） | `TestProvider::with_script(Vec<ProviderEvent>)`，事件枚举对齐 AgentEvent 契约 |
| setError / failAfter / setLatency | `Error(String)` / `fail_after(n)` / `latency(Duration)` 构造参数 |
| requestCount + requests 记录 | `TestProvider` 内部 `Arc<Mutex<Vec<ProviderRequest>>>`，断言用快照 |
| 分叉脚本（第 N 次调用不同行为） | 脚本数组按调用序号取（`scripts: Vec<Vec<Event>>`，超出取最后一个或报错） |
| pauseAfterIndex 栅栏 | 事件间插入 `Sleep(Duration)` 或 channel 栅栏（配合 tokio::time） |
| abort 协作（signal.aborted 提前 return） | 每事件前检查 `CancellationToken`/`Notify` |
| createMockTool（output/error/executeHook） | `TestTool { name, output, error, hook: Arc<Mutex<Vec<Input>>> }` |
| FauxProviderCallGateway 决策记录 | `TestGateway { decisions: Vec<RoutingDecision> }` |
| healthCheck/健康状态 | `TestProvider::health(Status)`（供路由/退避测试） |

---

## 五、Rust 测试映射表（模块 | 测试目标 | TS来源 | 类型）

> 模块对齐 00-master-plan.md Phase B（B1-B7）。类型：unit=纯函数/单组件单测；integration=多组件组合；e2e=faux-provider 全流程；front=前端保留（不迁移）。

### 5.1 conex-types（B1：事件/消息/错误类型）

| 模块 | 测试目标 | TS 来源 | 类型 |
|---|---|---|---|
| types::events | 24 种 AgentEvent 结构穷举序列化往返 | packages/agent-core/src/event-protocol/core-event-projector.test.ts:457-521 | unit |
| types::events | 事件 → core event 域/相位/严重度投影 | 同上 :49-433、:584-653 | unit |
| types::error | CrishError payload 序列化：cause 链保留（8 层上限） | packages/agent-daemon/src/__tests__/error-propagation.e2e.test.ts:309 | unit |
| types::error | 旧字符串码迁移（migrateErrorCode：NO_PROVIDER→config.missing、RUN_ERROR→runtime.unexpected_state） | 同上 :356；:142-305 | unit |
| types::error | 错误显示映射：severity/visible/标题/动作/翻译钩子 | apps/crish-desktop/src/utils/error-translation.test.ts:44-191 | unit（front 语义固化） |
| types::error | 任意输入归一化为 payload（string/Error/null/undefined/CrishError） | 同上 :194-260 | unit |
| types::run | run 生命周期状态机：正常/审批/取消/init-error/runtime-error/max-turns/goal-complete/终态拒变 | packages/agent-core/src/state-machine/run-lifecycle.test.ts:12-152 | unit |
| types::run | endReason→outcomeReason 映射表 | 同上 :155-174 | unit |
| types::state | 通用状态机：转移/守卫/副作用/快照/销毁 | packages/agent-core/src/state-machine/core.test.ts:29-136 | unit |

### 5.2 agent-provider crate（B2：请求构建 / SSE 解析 / 错误分类 / 重试）

| 模块 | 测试目标 | TS 来源 | 类型 |
|---|---|---|---|
| request::build | 请求瘦身/auth 头/max_tokens/系统提示前缀/工具输出序列化 | packages/agent-model/src/openai-request-build.test.ts:22-52 | unit |
| request::reasoning | vendor 推断（baseUrl/model：anthropic/gemini/deepseek/openai/auto） | 同上 :129-153；packages/agent-model/src/__tests__/thinking-intensity.test.ts:191-207 | unit |
| request::reasoning | 思考参数三厂商+两端点形态、xhigh 降级、off/不支持→空 | 同上 :101-152；thinking-intensity.test.ts:63-98 | unit |
| request::reasoning | anthropic-beta 头仅 Anthropic 注入 | 同上 :155-169；openai-request-build.test.ts:116-127 | unit |
| request::thinking | 能力推断（o3/gpt-5/claude-sonnet-4/gemini-2.5/deepseek-reasoner）与档位表 | thinking-intensity.test.ts:13-61、:171-189 | unit |
| request::tools | tool choice/schema 转换（chat-completions 与 responses 两形态） | openai-request-build.test.ts:155-181 | unit |
| request::content | content parts 归一化与内联 data URL 脱敏 | 同上 :183-205 | unit |
| stream::parse | SSE 解析：流式文本/分段工具参数/非流式 JSON/错误帧/空流/截断 | packages/agent-model/src/provider-openai-compatible.test.ts:43-212、:1389-1467 | unit+integration |
| stream::parse | Responses API 流式解析（函数参数等待/错误帧/空流/部分文本中断） | 同上 :389-489、:1325-1467 | unit+integration |
| stream::tool_args | 工具参数增量累积（OpenAI/Anthropic/Gemini 三风格）与 JSON 修复 | packages/agent-core/src/tool-stream/tool-stream.test.ts:4-173；__tests__/integrations/tool-stream.test.ts:4-175 | unit |
| stream::recovery | 断流恢复：游标/去重/退避/429 Retry-After/5xx/幂等守卫 | packages/agent-core/src/recovery/stream-recovery.test.ts:22-229 | unit |
| error::classify | HTTP 状态/消息文本分类全表（401/403/429/402/413/4xx/5xx/abort/超时/连接类） | packages/agent-core/src/__tests__/error-classifier.test.ts:5-416 | unit |
| retry::backoff | 指数退避与重试（含 429 退避轮不计入 goal 完成轮） | packages/agent-model/src/__tests__/exponential-backoff.test.ts；packages/agent-orchestrator/src/orchestrator.test.ts:1654 | unit |
| retry::pipeline | 重试管道：抛错/stop.error/context 溢出 healer/深度上限 | packages/agent-core/src/recovery-pipeline.test.ts:44-133 | unit+integration |
| fallback::chain | 主备链：分类→选链→失败转移→不重试已试模型→耗尽抛错 | packages/agent-core/src/fallback-chain/engine.test.ts:25-208 | unit |
| transport::abort | SSE 取消（消费者早退取消连接）/abort 不重试 | provider-openai-compatible.test.ts:212-311 | unit |
| transport::system_role | 系统消息被拒 → user-prefix 重写重试（Responses/chat-completions/历史改写） | provider-openai-compatible.test.ts:593-1135 | integration |

### 5.3 session-loop crate（B3：状态机 / steering / control / tool 执行）

| 模块 | 测试目标 | TS 来源 | 类型 |
|---|---|---|---|
| run::lifecycle | run 全事件：agent-start/agent-end、用户消息记录、max-turns 收口 | packages/agent-core/src/agent-session-loop.test.ts:122-188 | integration |
| run::stop | L2 cooperative_stop 与 L3 force_cancel 的 endReason（**按分歧 D1 决策后固定**） | core: agent-session-loop.test.ts:193-217；runtime: agent-session-loop.test.ts:197-221（分歧） | integration |
| run::stop | L2/L3 保留部分文字、continue-after-stop/abort、新 loop 承接继续 | agent-session-loop.test.ts:221-344 | integration |
| run::abort | abort 中途保留部分消息 / 无内容 abort → error | packages/agent-core/src/runtime-components/provider-response-consumer.test.ts:16-36 | integration |
| run::stop_reason | stopReason 保真（length/tool-call/stop/error 判定优先级，D5） | provider-response-consumer.test.ts:50-153 | unit+integration |
| control::bus | ControlBus 三环入队/优先级/分层订阅/错误隔离 | packages/agent-core/src/control/control-bus.test.ts:7-312 | unit |
| control::safe_point | 安全点检查：force/cooperative/soft_inject/steer/followUp 分环、idle promote | packages/agent-core/src/session-loop/control-check.test.ts:11-79 | unit |
| input::queue | AgentInputQueue 三环：force>steer>followUp、promote、tool 批后取 steer | packages/agent-core/src/agent-input-queue.test.ts:10-160 | unit |
| steering::queue | 跨 run steering 队列：FIFO/分组/替换/容量优先/迁移 | packages/agent-core/src/steering/steering-input-queue.test.ts:20-297 | unit |
| steering::empty | 空回复 steering 一次 + 二次 intervention（D6） | packages/agent-core/src/core/runtime.test.ts:1587-1655 | integration |
| steering::tool_fail | 工具连续失败 steering + intervention、退出码可恢复、错误环检测 | runtime.test.ts:1475-1584；runtime-helpers.test.ts:76-128 | integration |
| steering::args | 坏参数 steering（write_file→edit/insert_tail；edit→numbered lines+snapshotTag）（D2） | runtime.test.ts:411-521 | integration |
| steering::inject | 工具执行中注入 steer 不打断当前工具、下一轮生效；tool-args delta 窗口注入 | packages/agent-model/src/provider/__tests__/e2e/steering-injection.test.ts:60-237（当前 skip，需复活） | e2e |
| tool::executor | 单/并行/顺序执行、未知工具/非法输入、失败策略（cancel-siblings/continue-drain）、超时、abort | packages/agent-core/src/runtime-components/tool-executor.test.ts:70-415；tool-executor-timeout.test.ts:5 | unit+integration |
| tool::batch | 批次事件、并行分区、进度队列 | tool-executor.test.ts:82-186、:457-497 | unit |
| tool::hooks | tool.pre 阻断/工具不执行/tool.post 输出/顺序（turn.start→pre→post→turn.end） | agent-session-loop.test.ts:377-556；hooks/lifecycle-hooks.test.ts:55-130 | integration |
| tool::stream | 流式工具参数累积（三厂商）+ 大 JSON + 跨帧完整 | tool-stream.test.ts:4-173；__tests__/integrations/tool-stream.test.ts:4-175 | unit |
| provider::gateway | ProviderCallGateway：delta 累积/工具捕获/诊断/抛错/空响应/abort/backoff | packages/agent-core/src/runtime-components/provider-call-gateway.test.ts:50-270 | unit+integration |
| context::engine | ConversationEngine：系统消息/用户/assistant/工具批 append、maxTurns 边界、steering 预算 | packages/agent-core/src/runtime-components/conversation-engine.test.ts:15-216 | unit |
| context::manager | 上下文投影/脱敏/压缩开关/输出物化 | context-manager.test.ts:14-112 | unit |
| metrics::runtime | 流指标/工具错误率/隐私化 span/使用量聚合 | packages/agent-core/src/runtime-metrics.test.ts:40-412 | unit |

### 5.4 orchestrator crate（B4：会话/run 管理、事件持久化）

| 模块 | 测试目标 | TS 来源 | 类型 |
|---|---|---|---|
| run::drive | run 事件序列（queued→started→round→completed）与 sequence 连续 | packages/agent-orchestrator/src/orchestrator.test.ts:34-91 | integration |
| run::drive | delta 非持久化（不阻塞 drive loop）；持久化事件仍同步等待 | orchestrator.test.ts:93-237 | integration |
| run::fail | 事件存储写失败 → run-failed；max-turns → failed；provider-error 保留诊断 | orchestrator.test.ts:239-289、:1223-1335 | integration |
| run::cancel | L2 cooperative（不 hard abort）/L3 force/无 ControlBus 回落 | orchestrator.test.ts:1073-1221 | integration |
| run::approval | awaiting-approval 中间态与批准恢复 | orchestrator.test.ts:291-358 | integration |
| run::restore | 重启恢复：in-flight→interrupted 终态 + 审计；快照全量/增量/损坏回退 | orchestrator.test.ts:404-811、:885-1070 | integration |
| goal::rounds | goal 续轮/无进展 block/max-rounds block/stalled/429 退避不计轮 | orchestrator.test.ts:1337-1842 | integration |
| session::tree | 会话树：追加/分叉/叶子移动/回滚/环检测/重复 id | session-tree.test.ts:6-215 | unit |
| store::events | JSONL 事件存储：版本头/索引/坏行/幂等/写失败 latch | event-store.test.ts:16-657 | unit+integration |
| store::artifacts | 内容寻址 blob 存储与 URI 校验 | artifact-store.test.ts:9-109 | unit |
| store::pending | pending 输入持久化/恢复/取消 | orchestrator.test.ts:360-402 | integration |
| rewind::plan | conversation-rewind 计划顺序与校验 | conversation-rewind.test.ts:13-211 | unit |
| assess::goal | goal 决策映射（cancelled/failed→block、max-turns 优先、provider 错误分类） | task-assessment.test.ts:10-157 | unit |

### 5.5 agent-tools crate（B5：工具注册，简）

| 模块 | 测试目标 | TS 来源 | 类型 |
|---|---|---|---|
| tools::registry | 工具发现/规范化/输出预算与截断 | packages/agent-runtime/src/tool-discovery.test.ts、tool-output-budget.test.ts、canonicalize-tools.test.ts | unit |
| tools::shell | Windows 命令包装（cmd 管道/PowerShell EncodedCommand） | packages/agent-core/src/process-lifecycle/process-executor.test.ts:11-77 | unit+integration |
| tools::idempotency | 工具幂等守卫（恢复/快照/去重） | packages/agent-core/src/recovery/stream-recovery.test.ts:188-229 | unit |

### 5.6 Tauri 集成层（B6：命令/事件桥）

| 模块 | 测试目标 | TS 来源 | 类型 |
|---|---|---|---|
| ipc::error | 错误出站结构：顶层旧码 + payload 新码 + category/retryable；cause 链 | packages/agent-daemon/src/__tests__/error-propagation.e2e.test.ts:142-305 | integration（e2e） |
| ipc::run | run-task 主循环事件序列（run-started→stream-chunk→run-completed） | agent-protocol.e2e.test.ts:174 | e2e |
| ipc::approval | approve-tool 审批挂起与响应 | agent-protocol.e2e.test.ts:215 | e2e |
| ipc::reconnect | 断线重连与进程崩溃恢复语义 | agent-protocol.e2e.test.ts:376-424 | e2e（冒烟） |
| ipc::error_silent | aborted 类错误静默（前端不打扰） | apps/crish-desktop/src/utils/error-translation.test.ts:71-91 | unit（front） |

### 5.7 集成 / e2e（B7：faux provider 全流程）

| 模块 | 测试目标 | TS 来源 | 类型 |
|---|---|---|---|
| e2e::full_run | 消息→文字流→工具调用→正常收口（agent-start/end、文字与工具顺序） | packages/agent-core/src/core/runtime.test.ts:36-135；agent-session-loop.test.ts:122-135 | e2e |
| e2e::empty_reply | 纯文字回复后 run 正常收口（回归本次 bug，D5/D6 联合） | runtime.test.ts:1586-1655 + provider-response-consumer.test.ts:104-125 | e2e |
| e2e::tool_fail_recover | 工具失败→steering→恢复（退出码场景） | runtime.test.ts:1527-1584 | e2e |
| e2e::steer_mid_tool | 工具执行中 steer 不打断、下一轮生效 | steering-injection.test.ts:60-237（复活） | e2e |
| e2e::approval_flow | 审批请求→awaiting-approval→批准→工具执行→收口 | orchestrator.test.ts:291-358；agent-real-workflow-e2e.test.ts:47-124 | e2e |
| e2e::cancel_paths | L2/L3/fallback 三种取消路径端到端 | orchestrator.test.ts:1073-1221；agent-session-loop.test.ts:193-344 | e2e |
| e2e::restore | 崩溃重启后 run 恢复为 interrupted 终态 | orchestrator.test.ts:404-638 | e2e |


---

## 六、测试策略建议（Rust 侧分层测试结构）

### 6.1 分层结构（自底向上）

```
crates/conex-types/tests/           # unit：类型/状态机/错误映射（对应 5.1）
crates/agent-provider/tests/        # unit+integration：请求构建、SSE 解析、分类、重试（5.2）
                                    #   - 网络 mock 用 wiremock 或自建 tokio 监听
crates/session-loop/tests/          # unit：control/queue/steering/stopReason 判定（5.3）
                                    # integration：TestProvider + TestTool 组合
crates/orchestrator/tests/          # integration：run 驱动/恢复/快照（5.4）
tests/ (workspace 根)               # e2e：faux-provider 全流程（5.7），对应 TS 集成测试
```

建议按"**函数纯逻辑 unit → 组件 integration → faux-provider 全流程 e2e**"三层落盘，与 00-master-plan.md:73 质量门槛（关键语义必须有单测，faux provider）一致。

### 6.2 TestProvider / TestTool 一等公民

- 放 `crates/session-loop/src/testing/`（或独立 `crates/test-support`），对齐 4.9 节能力表。
- 必须支持：事件脚本、按调用序号分叉脚本、请求记录（供 nudge 断言）、failAfter/error/latency、abort 栅栏（mid-stream 打断，对应 TS 的 pauseAfterIndex 模式，agent-session-loop.test.ts:28-58）。
- 建议提供 `assert_request_text_contains(n, "Runtime steering: ...")` 之类的断言助手，直接承载 runtime.test.ts:1474-1655 的 nudge 文案校验。

### 6.3 分歧点测试策略（D1-D6）

| 分歧 | 测试处理 |
|---|---|
| D1 cooperative_stop endReason（aborted vs stop） | 决策后**只保留一份语义**；把 core/runtime 两个断言都写进文档留痕（本文件 1.2），Rust 测试按决策结果实现；相关用例：control-check 安全点、agent-session-loop L2、orchestrator cooperative cancel（orchestrator 侧已统一为 aborted，orchestrator.test.ts:1143-1148） |
| D2 tool-promise steering | 仅 core 有；Rust 侧按 00-master-plan 决策（nudge 注入下一条用户消息）实现并保留 runtime.test.ts:411-521 语义 |
| D5 stopReason=error 一票否决 | 本次 bug 根因；Rust 侧应把"模型输出错误"与"传输错误"分离（00-master-plan.md:136），测试按新语义重写 provider-response-consumer.test.ts:125 的对应用例 |
| D6 empty-response 二次 intervention | 本次 bug 根因；按 pi 对齐（纯文字/空响应不导致 run 失败）重写 runtime.test.ts:1628 语义 |

### 6.4 保留 / 删除 / 迁移清单

- **删除**（WS 链路）：daemon 的 WS e2e 全部（agent-protocol、agent-real-workflow、live-provider、error-propagation 的 WS 部分）；StreamRecovery、zod 协议层相关测试。
- **迁移语义**：error-propagation 的结构化错误出站（顶层旧码 + payload 新码）迁移到 Tauri IPC 错误通道；StreamRenderBuffer 分帧/背压语义由前端保留（不进 Rust）。
- **复活**：agent-model provider/__tests__/e2e/steering-injection.test.ts（当前 skip，其语义是 steer 与工具执行并发的唯一锚点）。
- **保留复用**：crates/conex-* 已有能力与测试（04-crates-inventory.md）。

### 6.5 覆盖优先级（按本次 bug 修复价值）

1. **P0**：5.3 steering::empty / steering::tool_fail / run::stop_reason + 5.7 e2e::empty_reply、e2e::full_run——直接锚定本次 bug（文字回复后 error 收场）。
2. **P1**：5.3 run::stop（L2/L3 与继续语义）、tool::hooks；5.2 error::classify、retry::pipeline。
3. **P2**：5.4 全部 orchestrator 恢复/快照；5.2 stream::parse 三厂商。
4. **P3**：5.6 ipc::error；5.5 工具注册。

---

## 附：本盘点发现的遗留问题

1. `provider-openai-chat.test.ts` 不存在——agent-model 中 openai provider 的测试主体是 `provider-openai-compatible.test.ts`（2500+ 行），且 `src/provider-openai-chat.ts` 与 `src/provider-openai-compatible.ts` 并存（00-master-plan.md:23 提及 openai 5 文件冗余），Rust 侧只需实现兼容层 + Responses 分支。
2. agent-runtime 与 agent-core 的测试重复率极高（session-loop/state-machine/runtime-components 全套同路径拷贝），映射表只按 core 引用一次，实现时以 core 为准、runtime 仅作分歧对照。
3. `apps/crish-desktop/src/api/` 的 103 个测试绝大多数为前端保留层（store/渲染/UI 状态机），不属于 Rust 重写范围；仅 StreamRenderBuffer 分帧与 error-translation 的错误显示语义需要 Rust 侧输出兼容结构（见 2.10、5.1、5.6）。
4. 本文件第五节映射的是"测试目标"级清单（约 60 条），实现时可继续按 5.3/5.2 的单元粒度展开；各 TS 测试文件内的完整用例清单见第二节行号引用。

---

*文档生成依据：只读盘点 2026-07-31；文件路径与行号均可在仓库中复核。*
