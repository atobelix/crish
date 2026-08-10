# 04 Provider 层重试与流中断处理（传输语义审计）

> 域：Provider 层重试与流中断（最底层传输语义）
> 范围：crates/agent-provider（retry / error 分类 / sse reader / transport）、conex-types error.rs、apps/agent-workbench engine.rs（生产接线）、crates/session-loop stream_error（生产重试路径）、crates/orchestrator recovery.rs（镜像语义）
> 结论日期：2026-08-10

## 1. 结论先行

1. **分类完备、重试判定正确**：ProviderErrorKind 13 类（conex-types/src/error.rs:866-895），分类管线"状态码优先 → transport 源 → 消息模式兜底"（agent-provider/src/error.rs:203-314）；可重试集 = RateLimit / ServerError / Timeout / Network 四类瞬态（agent-provider/src/retry.rs:149-155），与 02 §4.2 分类表逐行对齐。
2. **Provider 层指数退避重试已实现但未接入生产**：`provider_stream`（750ms 起、8s 封顶、60s 总预算、Retry-After 支持、abort 可中断、流已产出不重试）只在 agent-provider 测试中使用（tests/retry.rs），生产 HttpProviderCall 直接 `stream_frames` 裸流（engine.rs:503）。
3. **生产重试实际在 session-loop 层**：瞬态错误立即重试、上限 3 次/run（`transient_retry_limit: 3`，session-loop/src/loop/mod.rs:281；stream_error.rs:81-95）——**无退避、无预算、不消费 Retry-After**（`retry_after_ms` 全仓无生产读取方）。
4. **流中断语义安全，不会重复输出**：已产出内容 → 部分保留 + 错误降级为 metadata 标注（01 D6），不重试（streaming.rs:116-129、consume/mod.rs:252-273）；未产出内容 → 才进重试阶梯。三层（agent-provider `produced_content` → session-loop `builder.is_empty()` → orchestrator `ladder1_decision`）语义镜像一致。
5. **连接层配置薄弱**：生产客户端为裸 `reqwest::Client::new()`（engine.rs:1093）——无请求总超时、无显式 connect_timeout、无 TCP keepalive、无 HTTP/2 ping、无重定向定制；流式读超时 = 首字节 30s / 空闲 60s（engine.rs:93-95）。
6. **无自动重连 / 无多端点故障转移 / 无断点续传**：单 base_url 单端点；orchestrator 四级恢复阶梯（含镜像退避）设计完成但 F2-08 确认**未接线**（recovery.rs:57-62）。
7. **总体容忍度**：对"秒级瞬时波动"容忍度中上（分类 → 3 次立即重试 → 部分保留）；对"长时断网 / 半开连接挂起"容忍度低（60s idle 才探测、无心跳、无换端点）；对"重复输出"零风险（语义杜绝）。最大价值缺口 = **把已实现的退避重试接入生产**。

## 2. 分类表 / 退避表（文件:行号证据）

### 2.1 ProviderErrorKind 13 类分类表

权威表：`crates/conex-types/src/error.rs:866-895`；判定优先级：`crates/agent-provider/src/error.rs:203-314`（状态码 → transport 源 → 消息模式，与 TS ErrorClassifier.classify 一致）。

| # | Kind | 触发（状态码 / 消息模式 / transport 源） | 分类层 retryable | 重试循环是否重试 | 证据 |
|---|------|------|------|------|------|
| 1 | Aborted | signal.aborted / 消息含 aborted/cancelled；transport 源 Aborted | 否 | 否（一律直接传播） | error.rs:213-216；retry.rs:444-447 |
| 2 | PayloadTooLarge | HTTP 413（先排除 Anthropic "4130" 服务端码） | 否 | 否（上层压缩阶梯） | error.rs:218-220、426-439；stream_error.rs:74 |
| 3 | GatewayChallenge | cf_chl / challenge-platform / "just a moment" / enable javascript | 否 | 否 | error.rs:222-224、488-493 |
| 4 | Auth | HTTP 401/403；unauthorized/forbidden/invalid api key | 否 | 否 | error.rs:226-228、396-405 |
| 5 | Quota | HTTP 402；insufficient quota/balance/credit、out of credits | 否 | 否 | error.rs:230-232、408-414 |
| 6 | EndpointUnavailable | HTTP 404/405/415 | 否 | 否 | error.rs:234-236 |
| 7 | ContextLengthExceeded | HTTP 400/422 + context/length/exceed 字样 | **是**（分类层） | **否**（由上层压缩处理，00 D5 分类与收口分离） | error.rs:238-246；retry.rs:140-142、551-552 |
| 8 | InvalidRequest | HTTP 400/422 其余（含 payload too large 消息） | 否 | 否 | error.rs:238-246 |
| 9 | RateLimit | HTTP 429（解析 Retry-After）；rate limit / too many requests 字样 | 是 | 是（尊重 Retry-After） | error.rs:248-251、417-422；retry.rs:116-133 |
| 10 | ServerError | HTTP 500/502/503/504/520/522/523/524；bad gateway / server error / overloaded 等字样 | 是 | 是 | error.rs:442-460 |
| 11 | Timeout | 消息含 timeout/timed out；transport 源 Timeout（FirstByte/Idle/Request 三子类） | 是 | 是 | error.rs:264、300-304；error.rs:19-27 |
| 12 | Network | transport 源 Connection（DNS/建连/TLS 失败）/ StreamInterrupted（流中断）；econnreset/enotfound/fetch failed/socket hang up 字样；Stream 协议错误（分帧/UTF-8）折叠归入 | 是（02 §五 #11 裁决必须可重试） | 是 | error.rs:253-268、347-355、474-485；error.rs:165-167 |
| 13 | Unknown | 兜底 | 否 | 否 | error.rs:311-313 |

`default_retryable` 矩阵（13 类收敛后的唯一真源）：`crates/conex-types/src/error.rs:899-908`（ContextLengthExceeded / RateLimit / ServerError / Timeout / Network = true）。

### 2.2 重试决策（should_retry）与预算

权威：`crates/agent-provider/src/retry.rs`。

- **判定顺序**（retry.rs:143-180）：① 仅瞬态四类（rate-limit/5xx/网络/超时）→ ② `retries >= max_retries` 停止 → ③ `elapsed >= total_budget_ms` 停止（严格小于，对齐 withinRetryBudget）→ ④ 计算退避。
- **默认策略**（retry.rs:44-53）：`max_retries: 0`（显式开启才重试，对齐 TS maxAttempts=1）、`base_delay_ms: 750`、`max_delay_ms: 8_000`、`total_budget_ms: 60_000`。
- **退避公式**（retry.rs:107-112）：`min(max_delay, base * 2^(attempt-1))`，指数上限 62（saturating 防溢出）。
- **Retry-After 合并**（retry.rs:116-133）：`wait = max(退避, Retry-After)` → 再钳 `min(wait, max_delay)` → 再钳剩余预算；Retry-After 支持秒数 / HTTP-date（IMF-fixdate / RFC850 / asctime 三种格式），上限 `MAX_RETRY_AFTER_MS = 5 分钟`（retry.rs:29、188-213），极端年份钳制防溢出（retry.rs:740-768）。

### 2.3 退避序列（精确数字，测试锁定）

`backoff_sequence_exponential_then_capped`（retry.rs:503-514）锁定：750 → 1500 → 3000 → 6000 → 8000 → 8000（8s 封顶）。

| attempt | 退避 | 累计等待 |
|---|---|---|
| 1 | 750ms | 0.75s |
| 2 | 1500ms | 2.25s |
| 3 | 3000ms | 5.25s |
| 4 | 6000ms | 11.25s |
| 5+ | 8000ms（封顶） | … |

60s 总预算下（默认）最多约 8 次退避机会（750+1500+3000+6000+8000×5+… ≈ 60s），但**受 max_retries 双重约束**（两者取更严）。预算耗尽的钳制行为见 `total_budget_exhaustion_stops_retry`（retry.rs:770-796）。

### 2.4 生产实际重试路径（与设计对照）

| 维度 | 设计（agent-provider retry.rs，未接线） | 生产（session-loop stream_error.rs，实际生效） |
|---|---|---|
| 入口 | `provider_stream_with_observer` 循环 | `stream_error::handle`（streaming.rs:147 转） |
| 可重试集 | RateLimit/ServerError/Timeout/Network | 同（stream_error.rs:62-67） |
| 次数 | RetryPolicy.max_retries（默认 0） | `transient_retry_limit = 3`/run（loop/mod.rs:281） |
| 退避 | 指数 750ms→8s | **无**（立即 NO_PROGRESS_CONTINUE 重进 provider 循环，stream_error.rs:91） |
| 预算 | 60s 总预算 | **无** |
| Retry-After | 解析并合并（retry.rs:172） | **不消费**（`retry_after_ms` 全仓无生产读取方） |
| abort 中断 | TokioSleeper 竞速（retry.rs:316-323） | 每级决策前查 abort（Q40，stream_error.rs:52-55、82-85） |
| 流已产出 | produced_content=true 不重试（retry.rs:412-428） | builder.is_empty() 判定（streaming.rs:116-129） |
| 其他阶梯 | — | ContextLength→length 阶梯（8192→16384→32768，上限 2）+ 压缩阶梯；PayloadTooLarge→真实压缩重试 1 次（stream_error.rs:38、100-120、142-205） |

orchestrator 侧镜像：`RecoveryRetryPolicy`（750/8000/60000 三常量，recovery.rs:115-120）+ `ladder1_decision`（recovery.rs:205-243）逐条镜像 retry.rs，测试锁定同期望值防漂移；但 `RecoveryCoordinator` 生产无调用方（recovery.rs:57-62，F2-08 待接）。

## 3. 流中断语义分析

### 3.1 读取层：EOF 与错误的二分

- `ChunkReader::next_chunk`：`Ok(None)` = 流正常结束（EOF），`Err` = 传输失败（sse/reader.rs:30-31）。
- 读取错误五类：`SseReadError { Transport, Frame, Aborted, FirstByteTimeout, IdleTimeout }`（reader.rs:129-145）；超时/abort 一律以错误上抛，**绝不静默结束**（reader.rs:7、02 §六.2）。
- 双段超时在 `select_next_chunk`（reader.rs:214-248）：biased 顺序 abort 优先于数据、数据优先于超时。
- reqwest 错误归一（error.rs:347-355）：`is_timeout → Timeout(Request)`；`is_connect → Connection`；其余 → `StreamInterrupted`。SSE 读取错误归一（error.rs:317-327）：FirstByteTimeout/IdleTimeout → Timeout(FirstByte/Idle)；Frame → StreamProtocol；Transport 默认 → StreamInterrupted。
- 断流（连接被 RST/半开/代理掐断）在 reqwest 侧表现为 `bytes_stream` 的 `Err`（多数为"其余"分支 → StreamInterrupted → Network 可重试）。

### 3.2 流中断后的 partial content 三层语义

**第一层（agent-provider retry.rs）**：`StreamAttempt.produced_content`（retry.rs:327-336）——text/thought/tool-call 事件已产出即 true（诊断/usage 不算）；`provider_stream_with_observer` 对 `produced_content=true` 的中途错误**不重试、直接上抛**（retry.rs:412-428），注释明言"重试会重复已流出的内容"（retry.rs:334）。

**第二层（生产 engine + session-loop）**：HttpProviderCall 流中读取错误 → Err 条目终止流（engine.rs:603-609）；session-loop streaming.rs:116-129：
- `builder.is_empty()`（未产出任何事件）→ `stream_error` → 重试阶梯；
- 已产出内容 → 注入 `Stop{reason: Error}` 收尾，consume 侧按 Message 处理（内容保留、错误降级为 metadata.providerError 标注，streaming.rs:119-127）。

**第三层（consume 聚合）**：`finish`（consume/mod.rs:228-273）——有文字或 tool-call 且 error → Message + `stopReason` 正常值 + `providerError` 标注（01 D6"error 不一票否决"）；无内容且 error → StreamError（进重试阶梯）；abort 有内容 → Message + `stopReason=aborted` 部分保留（consume/mod.rs:279-301）。

**orchestrator 镜像**：`ladder1_decision` 对 `produced_content=true` 直接 `Escalate(ContentProduced)`（recovery.rs:205-217），不重试——与 retry.rs 语义逐条一致。

### 3.3 回答关键问题：重试会重复输出吗？

**不会。** 系统用两条互补规则从语义上杜绝重复：
1. **未产出内容** → 重试是安全的（服务端未返回任何可见内容，重试 = 全新请求）；
2. **已产出内容** → 绝不重试；已流出的 token 作为部分消息保留（可带 `providerError`/`aborted` 标注），错误本身进不了重试阶梯。
重复输出在会话层也不可能发生（部分消息已 commit 进 conversation，重试若发生也是基于完整对话的新请求）。

### 3.4 无续传：重试的代价

**没有断点续传机制**：重试 = 全量新请求（完整对话 + tools + max_tokens 重发，engine.rs:443-456 每次重进 streaming 都重新 build_request + send）。已流出内容在"未产出即重试"路径上没有任何残留（未产出自然无残留）。Provider 协议层无 resume 语义（OpenAI/Anthropic/Gemini 均无官方断点续传接口），当前架构以"部分保留 + 不再重试"换取正确性，以"3 次全量重试"吸收瞬时波动。

## 4. 缺口与风险

| # | 缺口 | 风险 / 后果 | 证据 |
|---|---|---|---|
| G1 | **provider 层退避重试未接线**（最大缺口） | 生产对 429/5xx/断流只有 3 次**立即**重试：429 重试过早（Retry-After 被忽略，`retry_after_ms` 无人消费）；瞬时波动下 3 次窗口内可能全部撞在故障上；60s 预算/8s 封顶的防抖能力全部闲置 | stream_error.rs:81-95；engine.rs:503 裸流；retry.rs 仅测试使用 |
| G2 | 会话循环重试无退避无预算 | 对持续 429/5xx 是"火焰重试"（3 次立即重发，实际都是必然失败）；对慢恢复的 provider 无等待窗口 | loop/mod.rs:281；stream_error.rs:91 |
| G3 | 客户端裸默认配置 | 无请求总超时（流式由双段超时兜底，OK）、无显式 connect_timeout（reqwest 默认 30s 建连）、无 TCP keepalive、无 HTTP/2 ping → **半开连接**（网络波动中 TCP 静默挂起）只能等 idle 60s 才被探测，期间 run 挂死无感知 | engine.rs:1093 `Client::new()` |
| G4 | idle 超时 60s 探测面粗 | "慢速但有数据"的流永不超时（每块 <60s）；真正挂死要等 60s 才诊断；无 per-chunk 心跳语义 | engine.rs:95；reader.rs:214-248 |
| G5 | 单端点无故障转移 | base_url 固定一个（provider_url 单 URL，engine.rs:226-233）；provider 侧故障（如 DeepSeek 网关 5xx 持续）无换端点路径；全仓无 fallback/failover 机制 | engine.rs:226-233；grep 无多端点实现 |
| G6 | 无断点续传 | 长输出中途断流后，已产出部分保留但**不会自动继续**（不重试），任务由上层（主 agent / 用户）决策；重试代价 = 全量 token 重发 | streaming.rs:119-127；consume/mod.rs:252-273 |
| G7 | orchestrator C7 四级阶梯未接线 | 子代理 run 失败时生产二进制不触发阶梯 1/2/3——恢复能力只存在于设计与测试面 | recovery.rs:57-62（F2-08） |
| G8 | 已产出内容的中断无用户级提示 | 部分消息带 providerError 标注 commit，用户看到"半截回答"但无"中断原因"强提示（仅 provider-diagnostic 事件） | streaming.rs:119-127；consume/mod.rs:340-342 |
| G9 | 重试计数跨 run 重置 | transient_retries 为 LoopState 字段（每 run 重建），跨 turn 的持续故障每 turn 都有 3 次配额 → 长会话可反复撞墙（无会话级熔断） | streaming.rs:338-340 注释；loop/mod.rs:281 |

## 5. 建议：传输层增强（按优先级）

### P0-1 把退避重试接入生产（最大价值，改动最小）

**方案 A（推荐，改动集中）**：在 engine 侧把 `HttpProviderCall::stream` 的"发送 + 分类"逻辑外包给 agent-provider 的 `provider_stream_with_observer`（它已是完整实现：循环 → 分类 → should_retry → TokioSleeper 退避 → produced_content 保护 → abort 竞速）。改动点：
- engine.rs:456-489（send + 非 2xx 分类）与 retry.rs `StreamAttempt` 闭包对接；`RetryPolicy { max_retries: 3, ..Default }` 实例化并注入（保留默认 750/8000/60000）。
- 验收断言：mock 429 带 Retry-After=30s → 单次等待 ≥ 30s（retry.rs:650-668 既有测试语义）；连续 5xx → 退避序列 750/1500/3000…；流中已产出 → 不重试（retry.rs:902-929 既有测试语义）。

**方案 B（备选）**：session-loop `transient_retry` 内加退避 + Retry-After + 预算，常量镜像 recovery.rs:115-120（750/8000/60000），避免拉 reqwest 依赖（G5 分层约束）。改动点：stream_error.rs:81-95；`state` 增加重试预算字段。验收断言：`rate_limit_with_retry_after_backs_off_then_succeeds`（agent-provider/tests/retry.rs:154）语义在 session-loop 层复现。

### P0-2 消费 Retry-After

`ClassifiedStreamError.retry_after_ms`（conex-types/src/response.rs:24）已透传至 session-loop（consume/mod.rs:370），但 stream_error.rs 未读取。接入：瞬态重试等待 = `max(退避, retry_after_ms)`，并钳到预算（镜像 retry.rs:116-133）。验收：429 + Retry-After=30s → 下一次请求在 30s 后发出（测试注入时钟）。

### P1-1 显式客户端配置（对抗半开连接与挂起）

engine.rs:1093 改为 `reqwest::Client::builder()` 显式配置（不改协议栈，均系 reqwest/hyper 既有能力）：
- `connect_timeout(10s)`（默认 30s 过长）；**不设总 `.timeout()`**（流式长输出会误杀），请求级超时继续由双段超时承担；
- `tcp_keepalive(30s)`（TCP 层探活，半开连接在 ~2-3 个探针周期内被 RST）；
- `http2_keep_alive_interval(30s)` + `http2_keep_alive_timeout(5s)`（HTTP/2 ping，provider 支持 h2 时对抗静默挂起）；
- 保留连接池默认（idle 90s 回收）并显式 `pool_idle_timeout` 注明。
- 验收：`cargo test -p agent-workbench`（壳层）编译绿 + 本地 TCP 挂起流在 keepalive 窗口内以错误收场（复用 transport/mod.rs:124-140 的 serve_sse_headers_only 模式）。

### P1-2 超时可配置 + 诊断增强

- `first_byte_timeout`（30s）/`idle_timeout`（60s）从常量改为 EngineProviderConfig 可配（engine.rs:93-95、339-340），默认值不变；
- idle 超时命中时诊断已含 elapsed/chunks/bytes（reader.rs:251-270），建议在 engine.rs:603-609 处附加最后活动时间与已产出 token 数，便于定位"挂死 vs 慢流"。

### P2-1 部分中断后的恢复决策面（不重试，但要可见）

已产出内容的断流（G8）：保留现状"不重试"语义（正确性优先），但把 StreamError/部分消息情况接入 orchestrator `on_subagent_run_failure`（阶梯 2/4，recovery.rs:914-978）——即完成 F2-08 接线：provider 流错误处调用 `RecoveryCoordinator`，`produced_content=true` 时以 `EscalateReason::ContentProduced` 上行（ladder1_decision 已支持，recovery.rs:212-217），主 agent 决定继续/补发/取消。

### P2-2 会话级熔断（G9）

在 session_meta 维护 `provider_fail_streak`（连续瞬态失败计数 + 时间窗），达阈值（如 3 个 turn 内 ≥6 次）后本会话暂停自动重试、直接上报用户——防止跨 run 反复撞墙，且与 C7 Episode 预算（recovery.rs:266-336）复用同款"指纹 + 预算"模式。

### P3-1 多端点故障转移（结构性增强，依赖配置面）

- 配置扩展：`base_url` 支持主/备列表（用户可配，如自建网关 + 官方端点双备）；
- 策略：Network / Timeout / ServerError（不换 Auth/Quota/InvalidRequest）时按 `should_retry` 次数在端点间切换（首次失败用主端点重试，≥2 次失败切备端点）；
- 注意：① cache 亲和头（x-grok-conv-id 等，engine.rs:426-430）跨端点失效 → 切换端点后应放弃亲和头并接受缓存 miss；② 幂等性：重试请求体不变，安全；③ 诊断事件携带 endpoint（StreamDiagnosticContext.endpoint 已支持，engine.rs:496-501）。
- 验收：`attempt_chat_stream`（agent-provider/tests/retry.rs:25-81）扩展为双端点 mock，主端点 5xx 时请求落备端点。

### P3-2 断点续传（明确不做协议级）

OpenAI/Anthropic/Gemini 均无官方 resume 接口，协议级续传不可行；且 produced_content 语义已保证"不重复"。低成本等价方案：断流保留部分 + 主 agent 经 C7 阶梯 2/4 决策补发（P2-1 已覆盖），**不建议**把已产出文本注入重试请求（语义污染 + token 浪费）。

### 总体优先级

P0（接线既有资产，收益最大）：P0-1 退避重试接线 + P0-2 Retry-After 消费 → P1（客户端配置与超时）→ P2（恢复决策面 + 会话熔断）→ P3（多端点 / 续传）。

## 附：关键文件索引

| 文件 | 角色 |
|---|---|
| crates/conex-types/src/error.rs:866-928 | ProviderErrorKind 13 类 + default_retryable 矩阵 + 错误码映射 |
| crates/agent-provider/src/error.rs:203-314 | classify_provider_error 分类管线（状态码 → transport → 消息模式） |
| crates/agent-provider/src/retry.rs:107-180 | 退避公式 / should_retry / Retry-After 合并 / 预算 |
| crates/agent-provider/src/retry.rs:327-463 | StreamAttempt.produced_content + provider_stream 高层封装 |
| crates/agent-provider/src/sse/reader.rs:101-248 | 双段超时 / abort 竞速 / 绝不静默结束 |
| crates/agent-provider/src/consume/mod.rs:228-301 | partial salvage / error 降级标注 / abort 保留 |
| apps/agent-workbench/src-tauri/src/engine.rs:322-519 | HttpProviderCall（生产裸流接线） |
| apps/agent-workbench/src-tauri/src/engine.rs:93-95、1093 | 超时常量 + 裸 Client::new() |
| crates/session-loop/src/loop/handlers/stream_error.rs:47-269 | 生产重试阶梯（3 次立即 / length / 压缩） |
| crates/session-loop/src/loop/handlers/streaming.rs:69-148 | 流中错误二分（is_empty → 重试 / 已产出 → 保留） |
| crates/orchestrator/src/recovery.rs:113-243 | 镜像退避 + ladder1_decision（F2-08 未接线） |