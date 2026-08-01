# 10 — Phase B 任务分解：Rust 核心实现

> 状态：已建立（Round 2 / A6 计划补全）
> 依据：00-master-plan.md §2 Phase B 表（:92-102）、§3 分歧点表（:130-137）、§1.3 质量门槛（:73）
> 输入文档：01-session-loop-semantics.md（01）、02-provider-semantics.md（02）、03-frontend-contract.md（03）、04-crates-inventory.md（04）、05-test-mapping.md（05）
> 粒度：任务 = 一个 crate 或 crate 内模块边界；"依赖"字段表达逻辑顺序，允许并行。
> 引用格式：`01 §1.4` = 01 文档第 1.4 节；`00 D3` = 主方案 §3 分歧点 D3；`04 G7` = 04 文档缺口 G7；`05 §5.3` = 05 文档第 5.3 节。

---

## 一、执行顺序总览（依赖列表）

```
主线（关键路径）：
B1.1/B1.2/B1.3（并行起点）→ B2.1 → B2.3 → B2.5 → B2.8 → B3.4 → B4.1/B4.2 → B6.1/B6.3 → B7.x

并行支线：
① B2.2（配置/凭据）→ B2.6/B2.7，与主线并行
② B2.9（Responses/Anthropic/Gemini 三项解析器），B2.5 后并行
③ B5.1（工具注册表，B1 后即可启动）→ B5.2 → B5.3；B5.1 同时喂给 B3.5
④ B3.1 与 B3.2 并行 → B3.3 → B3.4（最大汇聚点）
⑤ B4.4（B3.3 后）→ B6.1；B4.3（B4.1+B4.2 后）→ B6.2

各任务依赖明细：
【B1】起点：B1.1、B1.2、B1.3 并行（互不依赖）
     B1.1+B1.3 → B1.4、B1.5
【B2】起点：B2.1（依赖 B1.1/B1.3）、B2.2（依赖 B1.3）、B2.4（依赖 B1.1），三者并行
     B2.1 → B2.3；B2.3+B2.4 → B2.5
     B2.2 → B2.6、B2.7（与 B2.5 并行）
     B2.5+B2.6+B2.7 → B2.8；B2.5+B2.6 → B2.9（三项内部并行）
     B2.8+B2.9 → B2.10
【B5】B5.1 → B5.2 → B5.3；B5.4（MCP 桥）依赖 B5.1 可后置；B5.5 依赖 B5.2+B5.3
【B3】B3.1、B3.2 并行 → B3.3 → B3.4；B3.1+B5.1 → B3.5
     B3.4 = B3.1+B3.2+B3.3+B3.5+B2.8+B5.1（关键路径最大汇聚点）
     B3.4+B3.5 → B3.6
【B4】B3.4+B1.4 → B4.1、B4.2 并行；B3.3+B3.4 → B4.4（与 B4.1 并行）
     B4.1+B4.2 → B4.3；B4.1~B4.4 → B4.5
【B6】B4.1+B4.4 → B6.1；B4.2+B4.3 → B6.2；B4.2+B1.5 → B6.3（三者并行）
     B6.1+B6.2+B6.3 → B6.4
【B7】B6.1+B6.3 → B7.1、B7.2 并行；B7.1+B7.2 → B7.3；B7.1+B7.2+B7.3 → B7.4
```

---

## 二、B1 — conex-types 扩展（单一类型源）

### B1.1 事件与消息类型域
- 目标：新增 AgentEvent（24 种域事件）与 AgentMessage/Block/ToolCall/ToolResult 全量类型，成为所有 crate 的事件唯一源。
- 输入：01 §1.2/§2.4（事件名与字段）、01 §五.1/6；03 §1.1-1.7（前端消费字段硬依赖）、03 §5.1 表；04 §1.2（现有 SessionMessage 缺口）
- 产出：`crates/conex-types/src/events.rs`（AgentEvent tagged enum，serde camelCase）、`message.rs`（AgentMessage/AgentMessageBlock/text/thought/tool block）、`tool.rs`（ToolBatchCall/ToolBatchResult/ToolProgressUpdate）、`run.rs`（runId/sessionId/sequence 字段）；lib.rs re-export
- 验收：事件枚举与 03 §1 清单一一对应；serde_json 序列化字段名逐项匹配 03 §5.1 表 16 项硬依赖；`cargo test -p conex-types` 通过
- 依赖：无（B1 起点）
- 复用：04 §1.2 conex-types 现有 serde camelCase 模式与 CoreError；语义来源：03 §5.1（结构硬依赖）、03 §5.3-1（schema 唯一真源）
- 分歧约束：01 D4（自终止诊断 = 新增非 error 语义诊断事件，字段含 toolCallCount/turnIndex/maxTurns/promisedToolsWithoutCall）

### B1.2 会话状态机类型域
- 目标：AgentSessionState（8 态）/AgentSessionEvent（20 事件）/AgentSessionContext/AgentEndReason 作为一等类型，转移表穷举。
- 输入：01 §1.1-1.6、§五.1-2
- 产出：`src/session.rs`（状态/事件/上下文/endReason 枚举）、`src/transition.rs`（转移表穷举 match，未定义转移返回显式错误）
- 验收：8 态 × 20 事件与 01 §1.4 转移表逐行一致；endReason 与 01 §1.5 语义注释对应；非穷尽 match 即编译失败（01 §五.1 显式失败约束）
- 依赖：无（与 B1.1 并行）
- 复用：04 §1.2 serde 模式；语义来源：01 §1.1-1.6、§五.1-2
- 分歧约束：00 D1/01 D1（endReason 增加独立 'stopped' 候选，与前端对齐后定稿；实现约束：cooperative_stop ≠ aborted ≠ error，01 §四 D1 + 01 遗留问题 1）

### B1.3 错误与输出分类类型域
- 目标：错误体系扩展（ProviderError 分类、run 收口决策类型）与模型输出分类（Message/Empty/StreamError），支撑 D5/D6 裁决。
- 输入：02 §四（分类 kind/retryable）、02 §五.12（error 一票否决裁决）、01 §1.6（错误收场最小集合）、01 §五.2-3
- 产出：`src/error.rs` 扩展（ProviderErrorKind 对齐 02 §4.2 分类表 13 行、`RunTerminal { reason, error? }` 收口决策类型）、`src/response.rs`（`ProviderOutput = Message{text, tool_calls} | Empty | StreamError{classified}`）
- 验收：ProviderErrorKind 与 02 §4.2 表 13 类一一对应；RunTerminal 只允许 01 §1.6 的 4 事件产生 error；错误码复用 04 §1.2 error.rs 77 码（provider 17 码）
- 依赖：无（与 B1.1/B1.2 并行）
- 复用：04 §1.2 error.rs（CrishError builder/77 码/from_unknown）；语义来源：02 §四、01 §1.6、§五.2-3
- 分歧约束：00 D5/01 D6（响应含文字或 tool-call 即 Message，不标 error）；01 §五.3（纯文字回复永不失败）

### B1.4 conex-db schema 扩展
- 目标：新增 run/checkpoint/pending 输入/provider 配置持久化（schema_version 3→4）。
- 输入：04 §1.3（现有 7 表与 API）、04 §四 G7、04 遗留问题 #4；05 §5.4（run::restore/store::pending/event-store）
- 产出：`crates/conex-db` 新表 run（run_id/session_id/status/end_reason/cursor/created_at）、checkpoint、pending_inputs、provider_configs；v3→v4 迁移；新 API（insert_run/update_run_status/query_runs/save_checkpoint/load_pending_inputs 等）
- 验收：`PRAGMA user_version=4`；旧 v3 库迁移不丢数据（有迁移测试）；run 状态枚举与 B1.2 对齐；05 §5.4 store::pending 语义可落库
- 依赖：B1.1、B1.3
- 复用：04 §1.3 现有 API（insert_session/append_event/query_events 等）；语义来源：05 §5.4、03 §1.8（read-session-events 查询语义）
- 分歧约束：无

### B1.5 序列化契约测试
- 目标：事件/消息/错误 payload 的 camelCase JSON 往返测试，锚定 03 §5.1 硬依赖表。
- 输入：03 §5.1（16 项硬依赖）、03 §5.3-1/4；05 §5.1（types::events/error 测试）
- 产出：`crates/conex-types/tests/events_roundtrip.rs`、`tests/error_payload.rs`（cause 链 8 层上限、旧码迁移 NO_PROVIDER→config.missing）
- 验收：24 事件穷举 roundtrip 通过（05 §5.1，对齐 core-event-projector.test.ts:457）；cause 链深度上限 8（对齐 error-propagation.e2e.test.ts:309）；错误 payload 结构 {kind, detail} 与 03 §5.3-5 对齐
- 依赖：B1.1、B1.3
- 复用：04 §1.14 conex-test-utils（assert_json_roundtrip）；语义来源：03 §5.1、05 §5.1
- 分歧约束：无

---

## 三、B2 — agent-provider crate（provider 协议层）

### B2.1 crate 基建与 workspace 调整
- 目标：建立 `crates/agent-provider`（改造自 packages/agent-provider-http），修正 workspace 依赖缺口。
- 输入：04 §〇、§二（agent-provider-http 评估与建议）、§五.3-4、04 遗留问题 #1/#3
- 产出：`crates/agent-provider/Cargo.toml` + lib.rs 骨架；根 Cargo.toml：members 补 conex-telemetry、reqwest 加 stream feature、新增 tokio-stream 与 uuid 直接依赖（04 §5.3）；packages/agent-provider-http 移除
- 验收：`cargo build -p agent-provider` 与 `cargo build -p conex-telemetry`（随 workspace 解析）通过；reqwest bytes_stream 可用；grep 无 packages/agent-provider-http 残留引用
- 依赖：B1.1、B1.3
- 复用：04 §1.13 conex-telemetry（补入 members）、04 §二 agent-provider-http 的 reqwest 配置示范；语义来源：02 §六.1-2（传输层规范）
- 分歧约束：无

### B2.2 配置与凭据模块
- 目标：从 Tauri 壳 config/ 抽取 ApiConfigStore + CredentialStore（DPAPI）为 agent-provider 内配置模块。
- 输入：04 §3.2 config 保留行、04 §四 G8；00 §3 D3（API key 直连）
- 产出：`src/config.rs`（provider 端点/模型/API key 配置结构）、`src/credentials.rs`（DPAPI 凭据读写 + env 合并 + 内存 zeroize）
- 验收：config 模块单测通过（env 覆盖、DPAPI 读写、错误路径）；不引入 oauth2 依赖（04 §4.2 推迟）
- 依赖：B1.3
- 复用：04 §3.2 apps/agent-workbench/src-tauri/src/config/{provider.rs,credentials.rs} 抽取；语义来源：04 §4.2（OAuth 推迟）
- 分歧约束：00 D3（端点默认值 chat-completions 在本模块提供默认）

### B2.3 SSE 分帧与传输层
- 目标：reqwest bytes_stream + 增量 UTF-8 分帧器 + 双段超时/abort。
- 输入：02 §二.1（分帧规范）、02 §六.1-2
- 产出：`src/transport/mod.rs`、`src/sse/frame.rs`（\n\n/\r\n\r\n 取更早合法边界、data: 行聚合、[DONE]、keep-alive 跳过、残留 buffer 解析）、`src/sse/reader.rs`（first-byte/idle 双段超时、abort 中断挂起 read、sse-first-byte/stream-end 诊断）
- 验收：02 §二.1 帧语义全测试（keep-alive 不炸流、MalformedSseFrameError 上抛、跨 chunk UTF-8 解码）；abort 可中断挂起 read 并 cancel；超时以错误上抛而非静默结束（02 §六.2）
- 依赖：B2.1
- 复用：04 §1.4 评估结论（conex-net 无流式，直接在 agent-provider 内用 reqwest）；语义来源：02 §二.1、§六.1-2
- 分歧约束：无

### B2.4 低级流事件与合同类型
- 目标：ProviderStreamEvent 5 种 + ProviderUsage + ProviderDiagnostic 归一类型。
- 输入：02 §一.1、§一.4（thinking 表达）、02 §六.9
- 产出：`src/events.rs`（text-delta/thought-delta{redacted?}/tool-call/provider-diagnostic/stop{reason: stop|tool-call|length|error}、ProviderUsage）
- 验收：每流恰好一个 stop 的类型约束；thought-delta 保留 redacted；tool-call 为完整调用一次性产出（无增量阶段，02 §六.9）
- 依赖：B1.1
- 复用：无（crate 内部类型）；语义来源：02 §一.1、§六.9-10
- 分歧约束：无

### B2.5 chat-completions 解析器
- 目标：chat-completions SSE 帧处理与 tool_call 增量收集（含 RU-06/08/09）。
- 输入：02 §二.2-2.3、§五 #4-#9（取 runtime 行为）、§六.3-5
- 产出：`src/parse/chat.rs`（帧处理顺序：错误帧→usage 覆盖→text/thought delta→tool_calls→finish_reason 覆盖，仅无 choice 跳过）、`src/parse/tool_call.rs`（index 分组、id/name 覆盖、arguments 追加、parseArguments 兜底 {__rawArguments,__parseError}）
- 验收：02 §六.3 兼容位置全探测（delta.tool_calls/delta.function_call/choice.message.tool_calls/choice.tool_calls/平铺字段）；RU-06 缺 name 上报诊断不静默丢；RU-08 有工具调用强制 tool-call；RU-09 零捕获诊断；finishReasonToStop 映射表逐行（02 §2.2 末）
- 依赖：B2.3、B2.4
- 复用：无；语义来源：02 §二.2-2.3、§五 #4-#9、§六.3-5
- 分歧约束：无（分歧已由 02 §五 #4-#9 裁决收敛）

### B2.6 请求构建（openai-compatible 先行）
- 目标：chat-completions/Responses 请求体构建、消息映射、vendor 机制、thinking 透传。
- 输入：02 §二.6、§一.4（思考回传）、§五 #1-#3、§六.11；01 §四 D5（thinkingIntensity 保留透传）
- 产出：`src/request/build.rs`（compactObject 等价、stream 必带 include_usage）、`request/messages.rs`（角色映射/user-prefix wireMode/tool 消息/多模态 contentParts）、`request/vendor.rs`（inferReasoningVendor + reasoningEffortObject + anthropic-beta 头）、`request/tools.rs`（toOpenAITool/toChatToolChoice/toResponsesTool）
- 验收：02 §五 #1（未显式指定恒 chat-completions）、#2（vendor 保留、auto 退化）、#3（anthropic-beta 仅 vendor=anthropic 且 effort 非 off/auto）全部落测试；thinkingIntensity 透传到请求（01 D5）；user-prefix 重写路径可测（02 §六.11）；消息转换不做 LruMap 缓存（02 §五.13）
- 依赖：B2.2、B2.4
- 复用：04 §1.2 CoreError；语义来源：02 §二.6、§五 #1-#3、§六.11；01 §四 D5
- 分歧约束：00 D3（endpoint 默认）、00 D4（vendor 机制）、01 D5（thinkingIntensity 透传）

### B2.7 错误分类与重试器
- 目标：ProviderErrorClassifier 等价分类管线 + 指数退避重试器。
- 输入：02 §四.1-4.3、§五 #11（transport 可重试）、§六.7-8
- 产出：`src/error/classify.rs`（13 行分类表：abort→unknown/413→payload/Cloudflare 质询/auth/quota/endpoint/context_length_exceeded 可重试/rate_limit+retryAfterMs/server 集合/消息模式兜底）、`src/error/retry.rs`（750ms 起、8s 封顶、Retry-After 与退避取大、60s 总预算、delay 可中断）
- 验收：02 §4.2 表 13 行逐行有测试；transport 错误（连接失败/流中断）retryable=true（02 §五 #11 取 runtime）；Retry-After 支持秒数与 HTTP-date、上限 5 分钟；429 优先尊重 Retry-After
- 依赖：B2.3（transport 错误源）、B1.3
- 复用：04 §1.2 error.rs provider 17 码（error.rs:75-91）；语义来源：02 §四、§五 #11、§六.7-8
- 分歧约束：00 D5（分类与收口分离，重试在预算内处理，不直接终结 run）

### B2.8 消费契约层（provider-response-consumer 等价）
- 目标：流事件→AssistantResponse 聚合 + stopReason 生成（按 D5/D6 裁决）+ abort 部分保留。
- 输入：02 §一.3、02 §五.12（裁决）；01 §2.4 步骤 5（响应分类枢纽）、01 §五.3
- 产出：`src/consume/mod.rs`（ConsumeResult { response, diagnostics }、thought block + metadata.thought + redacted 透传、仅 phase=end 的 tool-call 收集、finishAfterAbort 等价）
- 验收：stopReason 按 01 D6 裁决生成（有文字/tool-call → 正常 Message，error 降级为 metadata 标注）；abort 有内容 → stopReason='aborted' 保留部分；无内容 abort → 错误；空响应产出 {type:'empty-response'}（02 §一.3）
- 依赖：B2.5、B2.6、B2.7
- 复用：无；语义来源：02 §一.3、§五.12、§六.12；01 §2.4、§五.3
- 分歧约束：00 D5/01 D6（error 一票否决取消：模型输出与传输错误分离）

### B2.9 Responses / Anthropic / Gemini 解析器
- 目标：三家补充解析器（非关键路径，可并行实现）。
- 输入：02 §二.4（Responses）、§三.1（Anthropic）、§三.2（Gemini）、§三.3（差异速查表）、§六.6（usage 合并分家）
- 产出：`src/parse/responses.rs`、`src/parse/anthropic.rs`、`src/parse/gemini.rs`（含各自 usage 合并策略）
- 验收：Responses 终态映射（incomplete→length、failed/cancelled→error、sawToolCall 强制 tool-call、无终态事件→error，02 §二.4）；Anthropic 事件驱动 + 空流保护 + 同角色合并 + 首条空 user 前置；Gemini blockReason 无 candidates→error + 空流保护；usage 合并：OpenAI 覆盖式 / Anthropic 分片补全 / Gemini 逐帧合并（02 §六.6）
- 依赖：B2.5（解析样板）、B2.6（Responses 工具形状）
- 复用：无；语义来源：02 §二.4、§三、§六.6/9
- 分歧约束：无（02 §五 #14：三家语义与 runtime 等价）

### B2.10 provider 测试套件
- 目标：传输层与解析层测试全量落盘。
- 输入：05 §5.2（stream::parse/error::classify/retry::backoff/transport::abort/system_role）
- 产出：`crates/agent-provider/tests/` 下 mock server（tokio TcpListener 或 wiremock，对齐 05 §4.7）、`parse_chat.rs`、`parse_responses.rs`、`parse_anthropic.rs`、`parse_gemini.rs`、`classify.rs`、`retry.rs`、`abort.rs`（系统消息被拒→user-prefix 重写重试，05 §5.2 transport::system_role）
- 验收：05 §5.2 各模块测试目标逐项通过；chat+Responses 两路径覆盖 provider-openai-compatible.test.ts 等价语义（05 遗留问题 1：测试主体文件为 provider-openai-compatible.test.ts）
- 依赖：B2.8、B2.9
- 复用：04 §1.14 conex-test-utils；语义来源：05 §4.7、§5.2、§6.1
- 分歧约束：无

---

## 四、B3 — session-loop crate（状态机 + steering + control + 工具执行）

### B3.1 状态机内核
- 目标：AgentSession 状态机实现（转移表穷举、未定义转移显式失败）。
- 输入：01 §1.1-1.6、§五.1-2
- 产出：`crates/session-loop/src/state.rs`（转移函数，对应 agent-session.ts:69-232）
- 验收：01 §1.4 表 46 行转移逐行实现；未定义转移返回显式错误而非静默忽略（01 §五.1）；endReason 语义与 §1.5 一致（max-turns 独立预算 reason）
- 依赖：B1.1、B1.2
- 复用：无（新 crate）；语义来源：01 §1.1-1.6、§五.1-2
- 分歧约束：00 D1/01 D1（cooperative_stop 的转移与 reason 按裁决实现）

### B3.2 输入队列与控制总线
- 目标：三环输入队列（force/steer/followUp）+ ControlBus（L0-L3）+ 安全点检查。
- 输入：01 §2.10（applySafePointControl）、01 §五.5；05 §2.2（三环语义测试）
- 产出：`src/input.rs`（AgentInputQueue 等价：force>steer 取数、followUp 仅 idle promote、默认 enqueue 为 force）、`src/control.rs`（ControlBus：force_cancel>cooperative_stop>soft_inject 优先级、drainAsAction、L3 队列入队）、`src/safe_point.rs`
- 验收：05 §2.2 三环语义测试逐项通过（enqueue 默认 force、dequeue 顺序 force>steer、promoteFollowUp、工具批后取 steer）；force 环输入可打断 stream、steer/followUp 不打断（01 §2.4 步骤 3）
- 依赖：B1.1、B1.2
- 复用：04 §1.5 conex-stream 评估（事件队列状态语义可借鉴，去留由 B7.4 裁定，04 遗留 #2）；语义来源：01 §2.10、§五.5、05 §2.2
- 分歧约束：无

### B3.3 steering 子系统
- 目标：SteeringCoordinator/策略/预算（单一计数源）+ nudge 注入通道（下一条用户消息）+ intervention 降级。
- 输入：01 §三.1-3.5、§四 D2/D3/D8/D9/D10、§五.4；00 D2/D6
- 产出：`src/steering/mod.rs`（coordinator：maxSteeringBudget 单一配置源、apply 为唯一计数增量点、inject-message 预算内）、`strategy.rs`（RecoverySteeringStrategy：phases after-tools/empty-response、maxConsecutiveToolErrors=2、maxRepeatedToolCalls=3、错误环检测）、`nudge.rs`（nudge 文本生成→排入下一条用户消息队列）、`diagnostics.rs`（自终止诊断，非 error 语义）
- 验收：01 §3.3 单一计数源（删 ctx.steeringCount 死检查，D10，默认 maxSteeringMessages=1）；预算耗尽禁止 inject-message 且 run 以 stop 收场（D9）；run 内任何位置不注入 nudge（D8）；empty-response 预算内重试、耗尽正常 stop、intervention 事件照发（D7）；tool-promise 机制删除（D2）；预注入短路保留（D3）
- 依赖：B3.2
- 复用：无；语义来源：01 §三、§四 D2/D3/D7/D8/D9/D10、§五.4
- 分歧约束：00 D2/D6、01 D2/D3/D7/D8/D9/D10（本任务是 steering 分歧全部落点）

### B3.4 主循环与 handler 集
- 目标：run 主循环 + 8 个 handler + 收口决策 + 安全点集成。
- 输入：01 §2.1-2.9（各 handler 行为清单）、§2.10、§五.3/5/7/9/10
- 产出：`src/loop/mod.rs`（run 主循环：sessionMutex 串行化、while 按状态分派、catch 兜底→recovery hook retry/skip/abort）、`handlers/`（awaiting_input/prepare_turn/streaming/stream_error/no_tool_calls/steering_evaluation/executing_tools/turn_complete）、`src/end.rs`（run 结束决策收敛 {reason, error?}，01 §五.2）
- 验收：01 §2.1-2.9 各 handler 行为逐项实现；错误收场仅由 01 §1.6 的 4 事件产生；turn 边界决策顺序按 §2.9 优先级（stop 建议→maxTurns→shouldStopAfterTurn→NEXT_TURN→idle 输入→SHOULD_STOP）；length 恢复阶梯（8192→16384→32768，上限 2 次）；安全点只读消费 steer；事件序列契约 §五.6；shouldStopAfterTurn 合并策略以 lifecycle turn.end 为准（01 遗留问题 3）
- 依赖：B3.1、B3.2、B3.3、B3.5、B2.8、B5.1
- 复用：无；语义来源：01 §2.1-2.10、§五
- 分歧约束：00 D1（cooperative_stop 推 SM 到 done、不 abort）、00 D5/01 D6（streaming 分类：Message 直接 commit 走正常收场）、01 D8（nudge 注入一律发生在下一条用户消息边界）

### B3.5 工具执行器
- 目标：executeToolBatch（并行/顺序/超时/审批事件/validation-repair/materializeOutput/checkpoint/fatalOnError）。
- 输入：01 §2.8、§五.8；05 §2.3（tool-executor 测试语义）
- 产出：`src/tool_exec.rs`（批量执行、并行/互斥分区、失败策略 cancel-siblings/continue-drain、超时、abort 提前中断）、`src/tool_events.rs`（tool-batch-start/end、tool-start/end、approval-requested 先于等待防死锁、checkpoint 记录）
- 验收：05 §2.3 测试语义逐项（单/并行/顺序执行、未知工具、非法输入、超时、cancel-siblings、continue-drain、abort 已就绪提前退出）；fatalOnError 判定排除 softDeny/timedOut/cancelled/approval_expired/user_denied（01 §五.8）；工具结果落盘后才进 turn-complete（01 §五.8 末）
- 依赖：B3.1、B5.1
- 复用：04 §1.8 conex-sandbox（审批联动）、04 §1.11 conex-diff（diff 输出）；语义来源：01 §2.8、§五.8、05 §2.3
- 分歧约束：无

### B3.6 session-loop 测试基建与语义测试
- 目标：TestProvider/TestTool 一等公民 + P0 语义测试（本次 bug 锚点）。
- 输入：05 §4.1-4.6、§4.9（替身设计）、§6.2、§5.3（P0 优先级）、§6.3（分歧测试策略）
- 产出：`crates/session-loop/src/testing/`（TestProvider：事件脚本/按调用序号分叉脚本/requests 记录/栅栏 Sleep、TestTool、TestGateway）、`tests/`（run::lifecycle、run::stop、control::bus、input::queue、steering::empty/tool_fail/args、tool::executor、provider::gateway、run::stop_reason）
- 验收：05 §6.2 能力表全部支持（脚本数组取末、requests: Vec<ProviderRequest> 暴露、pauseAfterIndex 栅栏）；05 §6.5 P0 清单（steering::empty/steering::tool_fail/run::stop_reason）通过；断言助手 assert_request_text_contains 可用
- 依赖：B3.4、B3.5
- 复用：04 §1.14 conex-test-utils（TempWorkspace/setup_test_env）；语义来源：05 §4、§5.3、§6.2-6.3
- 分歧约束：D1-D10 与本 crate 相关的按裁决断言（05 §6.3 决策后只保留一份语义）

---

## 五、B4 — orchestrator crate（会话/run 管理、事件持久化）

### B4.1 run 生命周期管理
- 目标：run 注册/状态机（queued→running→awaiting_approval→completed/failed/cancelled）/runId 生命周期。
- 输入：05 §5.4 run::drive/cancel/approval；03 §3.2 A 组命令契约
- 产出：`crates/orchestrator/src/run.rs`（RunHandle/run 状态机/审批挂起恢复/cancel 三路径：L2 协作、L3 强制、回落）
- 验收：05 §2.8 语义：L2 cooperative 不 hard abort、L3 force hard-abort、引擎不支持 L2 回落 L3（mode=cooperative-fallback-force）；awaiting-approval 中间态批准后回 running→completed；终态拒绝再转移
- 依赖：B3.4、B1.4
- 复用：04 §1.3 conex-db（run 表落库）；语义来源：05 §5.4、03 §3.2
- 分歧约束：00 D1（cooperative stop 的 run 终态不触发自动续轮）

### B4.2 事件序列与持久化
- 目标：事件 sequence 连续、持久化分流（delta 非持久化）、conex-db 写失败 latch。
- 输入：05 §5.4 run::drive/fail；03 §5.2-1/2（终态别名收敛）
- 产出：`src/events.rs`（事件队列：持久化/非持久化分流、sequence 分配、delta 不阻塞 drive loop）、`src/persist.rs`（append_event 失败→run-failed(event-store-write-failed)，不假装可回放）
- 验收：05 §2.8 语义：message-delta 非持久化且不阻塞；approval-requested 等持久化事件同步等待；store 写失败→run-failed；run-terminal 为唯一终态事件（删 run-completed/run-failed/run-cancelled/run-ended 别名，03 §5.2-2）
- 依赖：B3.4、B1.4
- 复用：04 §1.3 conex-db append_event/query_events（events 表做事件源）；语义来源：05 §5.4、03 §5.2
- 分歧约束：无

### B4.3 会话树与重启恢复
- 目标：会话树（追加/分叉/叶子移动）+ 重启恢复 interrupted + 快照。
- 输入：05 §5.4 run::restore/session::tree/store::pending/rewind
- 产出：`src/session.rs`（会话树）、`src/restore.rs`（in-flight→interrupted 终态 + previousStatus 审计、pending 输入持久化恢复、快照全量/增量/损坏回退）
- 验收：05 §2.8 恢复语义逐项（restore in-flight as interrupted、blocked 终态保真、终态记录原样保留、lastSequence 增量流）；conversation-rewind 计划顺序（取消 run→清审批→恢复检查点→移动叶子）
- 依赖：B4.1、B4.2
- 复用：04 §1.3 conex-db（sessions/events/新 pending_inputs 表）；语义来源：05 §5.4
- 分歧约束：无

### B4.4 跨 run 输入注入与事件归一
- 目标：steering 跨 run 队列（transferTo）+ 事件统一注入 runId/sessionId + 终态收敛。
- 输入：05 §2.2 steering-input-queue transferTo；03 §5.3-2（runId 注入）、03 §5.2-2（终态收敛）
- 产出：`src/steering_queue.rs`（跨 run steering 队列 FIFO/分组 replaceOrEnqueue/容量 evicts-oldest-non-steering/transferTo）、`src/normalize.rs`（emit 前 runId/sessionId 统一注入、run-terminal 判据统一）
- 验收：transferTo 容量限制与 steering 优先级（05 §2.2）；run-terminal 判据不再依赖别名（03 §5.2-2，原 is_terminal_run_event 需替换）；cooperative stop 的 agent-end reason 与 run 终态一致
- 依赖：B3.3、B3.4
- 复用：无；语义来源：05 §2.2、03 §5.2-2、§5.3-2
- 分歧约束：00 D1（orchestrator 层 cooperative stop 不自动续轮）

### B4.5 orchestrator 测试
- 目标：编排层测试全量落盘。
- 输入：05 §5.4（run::drive/fail/cancel/approval/restore/goal::rounds/session::tree/store::pending/rewind/assess::goal）
- 产出：`crates/orchestrator/tests/`（drive.rs、cancel.rs、approval.rs、restore.rs、tree.rs、rewind.rs、goal.rs、store_pending.rs）
- 验收：05 §5.4 各模块测试目标通过；goal 续轮/无进展 blocked/max-rounds blocked/stalled/429 退避不计完成轮（orchestrator.test.ts:1337-1842 语义）
- 依赖：B4.1-B4.4
- 复用：04 §1.3 conex-db（内存库）、04 §1.14 conex-test-utils；语义来源：05 §5.4
- 分歧约束：无

---

## 六、B5 — agent-tools crate（工具执行，可与 B2/B3 并行推进）

### B5.1 工具注册表与工具 trait
- 目标：Tool trait（name/description/inputSchema/execute/fatalOnError/readOnly/concurrency）与注册表 + schemars 入参校验。
- 输入：04 §四 G6；01 §2.8（executeToolBatch 消费面）；05 §5.5 tools::registry
- 产出：`crates/agent-tools/src/registry.rs`、`tool.rs`（Tool trait 与 ToolDefinition）、`validate.rs`（schemars JSON Schema 校验）
- 验收：注册/发现/校验单测通过（未知工具、非法入参→类型化错误，对齐 05 §2.3 tool-executor 语义）；ToolDefinition 序列化对齐 02 §二.6 工具定义兜底形状（缺 schema → {type:'object',properties:{},additionalProperties:true}）
- 依赖：B1.1、B1.3
- 复用：04 §5.3 建议的 schemars（已在 Cargo.lock，转直接依赖）；语义来源：02 §二.6、01 §2.8
- 分歧约束：无

### B5.2 fs / shell / search 内置工具实现
- 目标：读/写/搜索/shell 执行等内置工具，复用 conex-* 能力。
- 输入：04 §1.8-1.11（sandbox/search/fs/diff）、04 §四 G6；05 §5.5 tools::shell
- 产出：`src/tools/fs.rs`（读/写/哈希/路径校验，复用 conex-fs）、`search.rs`（复用 conex-search）、`shell.rs`（复用 conex-sandbox 门禁 + Tauri 壳 process.rs workbench_run_shell 语义的进程执行）、`diff.rs`（复用 conex-diff）
- 验收：shell 工具先过 CommandGatekeeper（check_command_with_context 越界→RequiresApproval）；Windows 命令包装（cmd 管道/PowerShell EncodedCommand，05 §5.5）；路径 safe_canonicalize 全程使用（conex-fs）
- 依赖：B5.1
- 复用：04 §1.8 conex-sandbox、§1.9 conex-search、§1.10 conex-fs、§1.11 conex-diff、04 §3.2 process.rs；语义来源：05 §5.5
- 分歧约束：无

### B5.3 工具输出结构化与幂等守卫
- 目标：输出序列化（text 优先）、预算截断、工具幂等（去重已执行 id）。
- 输入：05 §2.3（输出预算）、05 §5.5 tools::idempotency；02 §二.6（stringifyToolOutput 优先级）
- 产出：`src/output.rs`（summarize/output budget/截断）、`src/idempotency.rs`（ToolIdempotencyGuard 等价）
- 验收：stringifyToolOutput 优先级 text→json→artifacts（对齐 05 §2.5）；幂等守卫测试对齐 stream-recovery.test.ts:188-229
- 依赖：B5.2
- 复用：04 §1.7 conex-compaction（输出预算评估）；语义来源：05 §2.5、§5.5
- 分歧约束：无

### B5.4 MCP 桥
- 目标：MCP 工具接入（tauri-plugin-mcp 或等价客户端桥）。
- 输入：00 §2 B5（MCP 桥）、04 §四 G6（MCP 部分）；03 §3.2 C 组（list/start/stop-mcp-server）
- 产出：`src/mcp/bridge.rs`（MCP 客户端生命周期 + 工具注册桥接）、`src/mcp/servers.rs`（server 配置管理）
- 验收：MCP server 启动/停止/工具枚举可用；MCP 工具经统一 Tool trait 进入工具执行器；与 core_list_mcp_servers 等命令对接（03 §3.2 C）
- 依赖：B5.1（可后置，不与关键路径耦合）
- 复用：04 §3.2 保留壳能力；语义来源：03 §3.2 C、00 §2 B5
- 分歧约束：无

### B5.5 工具测试
- 目标：工具层测试落盘。
- 输入：05 §5.5（tools::registry/shell/idempotency）
- 产出：`crates/agent-tools/tests/`（registry.rs、shell.rs、idempotency.rs、fs_search.rs）
- 验收：05 §5.5 测试目标通过；门禁/越界升级 RequiresApproval 路径有断言
- 依赖：B5.2、B5.3
- 复用：04 §1.14 conex-test-utils（TempWorkspace）；语义来源：05 §5.5
- 分歧约束：无

---

## 七、B6 — Tauri 集成（命令桥 + 事件 emit 桥）

### B6.1 run 生命周期命令桥
- 目标：core_run_task / core_run_control / core_cancel_run / core_approve_tool / core_deny_tool 五个命令。
- 输入：03 §3.2 A 组（参数/返回契约）、03 §2.5（取消路径）
- 产出：`apps/agent-workbench/src-tauri/src/core_run_commands.rs`（Tauri command + CoreError 返回）；参数沿用 camelCase 与现有 WS 消息字段一致
- 验收：core_run_task 返回 {runId, sessionId}（前端 runId 自管零改动，03 §3.1）；core_run_control 覆盖 level 全枚举（continue/soft_inject/cooperative_stop/force_cancel）；approve/deny 返回 {ok, toolCallId, decision}
- 依赖：B4.1、B4.4
- 复用：04 §3.1 make_handlers! 注册模式（保留原则，04 §3.3 注）；语义来源：03 §3.2 A、03 §2.5
- 分歧约束：无

### B6.2 查询与杂项 RPC 桥
- 目标：查询类命令 + 杂项 RPC 的进程内实现。
- 输入：03 §3.2 B/C 组（命令清单）
- 产出：`core_query_commands.rs`（core_get_status/core_get_run_snapshot/core_read_run_events/core_read_session_events）、`core_misc_commands.rs`（workflow/mcp/settings/git 等，04 §3.3 语义面重实现）
- 验收：core_read_session_events 返回 {events, nextAfterSequence, hasMore}（03 §5.2-7）；core_get_status 支撑"核心已初始化"布尔（03 §3.3）；错误协议 CoreError {kind, detail}（03 §5.3-5）
- 依赖：B4.2、B4.3
- 复用：04 §3.2 保留模块（config/session_commands/core_commands 等）；语义来源：03 §3.2 B/C、03 §5.2-7
- 分歧约束：无

### B6.3 事件 emit 桥
- 目标：workbench-run-event 事件通道 + 序列化对齐 + runId 注入 + 背压缓冲。
- 输入：03 §3.1（emit 模式）、§5.1（结构硬依赖）、§5.3-2/6（runId 注入与缓冲策略）
- 产出：`core_event_bridge.rs`（app.emit("workbench-run-event", event)）、`buffer.rs`（按 runId 事件队列：高水位丢 message-delta 旧帧，不丢 terminal/审批/工具事件）
- 验收：emit 载荷为完整事件 JSON（顶层 {type, runId, sessionId, ...}，不做二次包装，03 §3.1）；事件 JSON 与 03 §5.1 表 16 项逐项比对通过（可用 B1.5 的 golden 测试驱动）；message-delta 可丢但 message-end 全文兜底可用（03 §5.3-6）
- 依赖：B4.2、B1.5
- 复用：04 §3.3 删除清单为参照（原 lifecycle.rs:287-303 的 emit 模式）；语义来源：03 §3.1、§5.1、§5.3
- 分歧约束：无

### B6.4 错误协议与启动接线
- 目标：invoke 错误协议统一 + 初始化顺序（db→config→engine）+ 退出清理。
- 输入：03 §5.3-5、§2.4（四源失败）；04 §3.1（main.rs setup 现状）
- 产出：`core_error.rs`（CoreError 归一：invoke 同步错误 vs run 期事件错误分流）、main.rs setup 重写（删除 sidecar 自启循环 04 §3.1:238-277，改引擎初始化）
- 验收：run 运行期错误只走事件通道（四源失败，03 §2.4），invoke 仅返回同步错误；startup 失败→CoreError 而非 panic（04 §1.13 catch_unwind 包装）；退出钩子保留 PTY kill（04 §3.1:289-291）
- 依赖：B6.1、B6.2、B6.3
- 复用：04 §1.13 conex-telemetry（catch_unwind）、04 §3.2 config；语义来源：03 §2.4、§5.3-5
- 分歧约束：无

---

## 八、B7 — 集成测试（faux provider 全流程）

### B7.1 faux-provider 全流程 e2e（主路径）
- 目标：消息→文字流→工具调用→正常收口全旅程。
- 输入：05 §5.7 e2e::full_run；00 §1.3（质量门槛）
- 产出：`tests/`（workspace 根或会话 crate 内）e2e/full_run.rs（agent-start/end、文字与工具顺序、工具结果落盘、turn-end 计数）
- 验收：agent-start/end 事件对齐全；run-terminal(completed) 发出；纯文字+tool-call 混合顺序保持（runtime.test.ts:93 语义）
- 依赖：B6.1、B6.3
- 复用：B3.6 TestProvider；语义来源：05 §5.7、01 §2.1
- 分歧约束：无

### B7.2 错误路径与取消 e2e
- 目标：本次 bug 回归（纯文字收口）+ 空回复/工具失败/L2/L3 取消路径。
- 输入：05 §5.7（e2e::empty_reply/tool_fail_recover/steer_mid_tool/approval_flow/cancel_paths）、01 §1.6
- 产出：tests/e2e/empty_reply.rs、tool_fail_recover.rs、steer_mid_tool.rs、approval_flow.rs、cancel_paths.rs
- 验收：纯文字回复后 run 以 stop 收场（D5/D6 联合回归，05 §5.7 e2e::empty_reply）；空回复预算耗尽 stop 收场且 intervention 事件照发；工具失败→steering→恢复（退出码场景）；L2 保留部分文字、新 loop 可继续；L3 保留部分正文且 endReason=aborted
- 依赖：B6.1、B6.3
- 复用：B3.6 TestProvider；语义来源：05 §5.7、01 §2.5-2.10
- 分歧约束：00 D5/D6、01 D6/D7/D8/D9（全部经 e2e 断言）

### B7.3 分歧点 D1-D10 全覆盖核对
- 目标：以 01 §四 + 00 §3 分歧表为核对清单，逐项断言实现正确性。
- 输入：01 §四（D1-D10）、00 §3（D1-D6）、05 §6.3
- 产出：tests/divergence.rs（每分歧一条显式命名测试，注释附裁决依据）；核对矩阵同步写入 30-verification-checklist.md（00 §4 预留）
- 验收：主方案 D1-D6 与 01 D1-D10 去重后每项至少一个正向断言（裁决后行为）+ 一个反向断言（旧行为不复现）
- 依赖：B7.1、B7.2
- 复用：无；语义来源：01 §四、00 §3、05 §6.3
- 分歧约束：全部（本任务是分歧收敛的总闸）

### B7.4 质量门槛与清场
- 目标：cargo test/clippy 全绿 + 遗留决策落盘（conex-stream 去留、schema 版本确认）。
- 输入：00 §1.3（质量门槛）、04 遗留问题 #1/#2/#4
- 产出：工作区 `cargo test` + `cargo clippy -D warnings` 全绿；04 遗留问题逐条结论（conex-telemetry members 确认、conex-stream 删除或保留理由、schema v4 确认）
- 验收：B1-B7 全部任务验收标准可复现；clippy 无 warning；00 §4 副文档状态表更新
- 依赖：B7.1、B7.2、B7.3
- 复用：无；语义来源：00 §1.3、04 遗留
- 分歧约束：无

---

## 九、分歧点决策归属总表（01 D1-D10 / 主方案 D1-D6 → 任务）

| 决策 | 裁决 | 落点任务 |
|---|---|---|
| 00 D1 / 01 D1 | cooperative_stop → 独立 reason（候选 'stopped'），orchestrator 不续轮 | B1.2、B3.1、B3.4、B4.4、B7.3 |
| 00 D2 / 01 D2 | 删除 tool-promise run 内注入；nudge 附下一条用户消息；自终止诊断非 error | B1.1（诊断事件类型）、B3.3、B3.4、B7.3 |
| 00 D3 | 端点默认恒 chat-completions | B2.2（默认值）、B2.6、B7.3 |
| 00 D4 | 保留 vendor 推理机制（取 model 行为） | B2.6、B7.3 |
| 00 D5 / 01 D6 | 模型输出与传输错误分离；有文字/tool-call 即非 error | B1.3、B2.8、B3.4、B7.2、B7.3 |
| 00 D6 / 01 D7 | empty-response 预算内重试；耗尽 stop；intervention 照发 | B3.3、B3.4、B7.2、B7.3 |
| 01 D3 | 预注入短路保留并推广 | B3.3、B7.3 |
| 01 D4 | 自终止诊断保留为非 error 语义事件 | B1.1、B3.3、B7.3 |
| 01 D5 | thinkingIntensity 透传 | B2.6、B7.3 |
| 01 D8 | run 内一律不注入 nudge | B3.3、B3.4、B7.3 |
| 01 D9 | steering 预算耗尽 → 正常 stop 收场 | B3.3、B7.3 |
| 01 D10 | 单一计数源、单一配置源 | B3.3、B7.3 |

---

## 十、遗留问题（下轮消化）

1. **D1 reason 命名定稿**（01 遗留 1）：'stopped' 新值 vs 沿用 'stop'，需与前端 EventRouter 消费端（03）对齐——由 Phase C 的 C2.4 联调定稿，B1.2 实现时预留扩展点。
2. **agent-end 结构扩展**（01 遗留 2）：D9 若引入 stop 之外的附加 reason 字段，需 agent-end 事件加 stopReason 字段——C2.4 联调。
3. **shouldStopAfterTurn 合并**（01 遗留 3）：B3.4 已按"以 lifecycle turn.end 为准"约束，执行时确认 composedHooks 兼容层删除无副作用。
4. **provider 默认值细节**：B2.6 执行时需确认 max_tokens 默认值（chat 8192 等）与 TS 端对齐（02 §二.6）。
5. **Phase C 前置**：B6.1/B6.3 验收后即可启动 Phase C（C1.1），无需等 B7 全绿。
