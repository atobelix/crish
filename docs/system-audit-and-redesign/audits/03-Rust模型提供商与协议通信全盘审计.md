# 03-Rust 模型提供商与协议通信全盘审计报告

> **审计范围**：`crates/agent-provider/`、`crates/conex-types/`、`crates/conex-shared/`、`crates/conex-telemetry/`（含全部 `src/`, `tests/`, `benches/`, `contracts/`）
> **审计职责**：全盘代码与测试审计师 03: Rust 模型提供商与协议通信（只找问题、零废话、清理无用冗余、严禁修改业务代码与 Git 操作）
> **执行标准**：`docs/system-audit-and-redesign/00-战役通则与协同执行规范.md` 及反退避铁律
> **编码要求**：UTF-8 无 BOM

---

## 目录

1. [一、Provider 协议与 Prompt Caching 缺陷](#一provider-协议与-prompt-caching-缺陷)
   - 1.1 Anthropic 原生请求构造硬编码跳过多轮消息断点（`messages: false`）
   - 1.2 `AnthropicRequestOptions` 缺失缓存策略桥接，导致 `cache_control` 盲目注入
   - 1.3 `anthropic-beta` Headers 体系严重残缺与割裂（缺少 prompt caching / 128k / token-counting / 多头聚合）
   - 1.4 OpenAI / Responses 轨协议对缓存机制的过度假设与亲和字段遗漏
   - 1.5 Gemini 请求构造缺失缓存控制载体（`cachedContent` 资源引用断层）
2. [二、思考预算与 Token 映射缺陷](#二思考预算与-token-映射缺陷)
   - 2.1 Anthropic 极小思考预算越界（`Minimal` 映射 128 Token 违反官方 `budget_tokens >= 1024` 铁律）
   - 2.2 Anthropic 思考预算叠加导致 `max_tokens` 溢出模型物理上限（400 拒绝）
   - 2.3 Anthropic 非思考模式缺省 `max_tokens` 盲目回落 2048 导致长文本输出被腰斩
   - 2.4 Chat Completions 轨缺少 `max_tokens` / `max_completion_tokens` 思考预算抬升保障
   - 2.5 Gemini 思考强度参数与官方 API 结构/大小写契约严重违背（`thinking_level` vs `thinkingConfig`）
3. [三、死协议与冗余类型排查](#三死协议与冗余类型排查)
   - 3.1 `conex-types/src/lib.rs` 残留废弃 IPC 协议类型（`IpcEnvelope`, `IpcResponse`）
   - 3.2 `conex-types/src/lib.rs` 存在未序列化且重名冲突的死类型（`StreamChunk` vs `device::stream::StreamChunk`）
   - 3.3 扁平化旧消息契约 `Message` 与 `CompactionResult` 残留导致双重消息模型分裂
   - 3.4 `conex-types/src/events.rs` 中未发射死事件与冗余安全审计变体
   - 3.5 `conex-shared` 与 `conex-computer` / `conex-browser` 的重叠与死辅助代码
4. [四、测试有效性与遗漏的错误处理分支](#四测试有效性与遗漏的错误处理分支)
   - 4.1 虚假 Wire 协议测试：`wire_integration.rs` 仅为内存结构断言，完全缺失真实 HTTP/TCP 协议帧检验
   - 4.2 HTTP 529 (Anthropic Overloaded) 及扩展 5xx 状态码漏判导致指数退避降级为不可恢复崩溃
   - 4.3 `classify_provider_error` 字符串探测优先级过高导致常规 400 请求被误判为用户 `Aborted`
   - 4.4 SSE 分帧解析异常静默吞没（`push_frame` 畸形 JSON 帧被 `Ok(Vec::new())` 静默忽略造成坏数据截断）
   - 4.5 Responses API 思考流事件中 `redacted` 属性错误硬编码为 `Some(true)` 导致明文思考被遮蔽
5. [五、综合整改与重构行动建议清单](#五综合整改与重构行动建议清单)

---

## 一、Provider 协议与 Prompt Caching 缺陷

### 1.1 Anthropic 原生请求构造硬编码跳过多轮消息断点（`messages: false`）

- **缺陷位置**：
  - `crates/agent-provider/src/request/build_anthropic.rs:92`
  - `crates/agent-provider/src/request/build_anthropic.rs:276-325`
  - `crates/agent-provider/src/request/build_anthropic.rs:327-400`
- **代码证据**：
  ```rust
  // crates/agent-provider/src/request/build_anthropic.rs:92
  let has_system = context
      .system_prompt
      .as_deref()
      .map(str::trim)
      .filter(|s| !s.is_empty())
      .is_some();
  let bp_plan = allocate_breakpoints(context.tools.len(), has_system, false);
  ```
  以及消息映射函数 `to_anthropic_messages`、`user_anthropic_content`、`tool_result_anthropic_content`：
  ```rust
  // crates/agent-provider/src/request/build_anthropic.rs:328-336
  fn user_anthropic_content(message: &AgentMessage) -> Vec<Value> {
      message
          .blocks
          .iter()
          .filter_map(|block| match block {
              AgentMessageBlock::Text { text } => Some(json!({ "type": "text", "text": text })),
              _ => None,
          })
          .collect()
  }
  ```
- **严重性**：**CRITICAL 核心功能缺陷 / 成本浪费**
- **问题机理**：
  在 Anthropic Messages 官方 API（`/v1/messages`）的 Prompt Caching 规范中，为了让多轮对话复用历史上下文缓存，必须在**最后一条用户消息或工具结果消息的末尾文本块**上附加 `"cache_control": { "type": "ephemeral" }`（即第三个缓存锚点 `messages`）。
  但在 `build_anthropic.rs:92` 中，调用 `allocate_breakpoints` 时第三个参数被**硬编码为 `false`**。并且在 `to_anthropic_messages` 及其所有子函数（`user_anthropic_content`, `tool_result_anthropic_content`, `assistant_anthropic_content`）中，**完全没有施加任何 `cache_control` 的逻辑**！
- **架构危害**：
  在 Anthropic 原生协议线路上，**只有首轮的 system prompt 和 tools 能被缓存，所有后续轮次的会话上下文全部无法命中多轮历史缓存断点**。每一轮新对话都需要对整个会话历史重新创建缓存或全额计费，导致 Prompt Caching 在 Anthropic 官方 Messages API 上直接失效，造成巨大 Token 费用浪费与首 Token 延迟增加。

---

### 1.2 `AnthropicRequestOptions` 缺失缓存策略桥接，导致 `cache_control` 盲目注入

- **缺陷位置**：
  - `crates/agent-provider/src/request/build_anthropic.rs:56-72`
  - `crates/agent-provider/src/request/build_anthropic.rs:94-109`
  - `crates/agent-provider/src/request/build_anthropic.rs:176-181`
- **代码证据**：
  ```rust
  // crates/agent-provider/src/request/build_anthropic.rs:56-72
  #[derive(Debug, Clone, Default)]
  pub struct AnthropicRequestOptions {
      pub model: Option<String>,
      pub stream: Option<bool>,
      pub temperature: Option<f64>,
      pub max_tokens: Option<u64>,
      pub reasoning_effort: Option<ReasoningEffort>,
      pub thinking_intensity: Option<ThinkingIntensity>,
      pub thinking_budget: Option<u64>,
      pub tool_choice: Option<ToolChoice>,
  }
  ```
  `AnthropicRequestOptions` 中**完全没有 `cache: Option<CachePolicy>` 字段**！
- **严重性**：**HIGH 协议不一致 / 配置逃逸**
- **问题机理**：
  与 `ChatCompletionsRequestOptions`（包含完整 `cache: Option<CachePolicy>`）不同，`AnthropicRequestOptions` 根本无法传入由 `build_cache_policy` 计算出的缓存策略。
  在 `build_anthropic_request_body` 内部，只要有 `system_prompt` 或 `tools`，就会**无条件、强制地注入 `cache_control: {"type": "ephemeral"}`**，完全不检查：
  1. 用户是否在配置中明确设置了 `extra.cache.enabled = false`；
  2. 缓存保留档位是否为 `CacheRetention::None`（例如总结压缩请求要求强制禁用缓存）；
  3. 当前模型是否支持该 TTL 桶。
- **架构危害**：
  用户或系统配置的“禁用缓存”、“None 档缓存”在 Anthropic 原生请求上被完全无视，破坏了配置闭环与可控性。

---

### 1.3 `anthropic-beta` Headers 体系严重残缺与割裂（缺少 prompt caching / 128k / token-counting / 多头聚合）

- **缺陷位置**：
  - `crates/agent-provider/src/request/build_anthropic.rs:203-209`
  - `crates/agent-provider/src/request/vendor.rs:301-314`
  - `crates/agent-provider/tests/wire_integration.rs:197-198`
- **代码证据**：
  ```rust
  // crates/agent-provider/src/request/build_anthropic.rs:203-209
  pub fn anthropic_request_headers(api_key: &str) -> Vec<(&'static str, String)> {
      vec![
          ("x-api-key", api_key.to_string()),
          ("anthropic-version", ANTHROPIC_VERSION.to_string()),
          ("content-type", "application/json".to_string()),
      ]
  }

  // crates/agent-provider/src/request/vendor.rs:301-314
  pub fn reasoning_effort_headers_for_model(
      model: &str,
      vendor: Option<ReasoningVendor>,
      effort: Option<ReasoningEffort>,
  ) -> Option<(&'static str, &'static str)> {
      let active = effort.is_some_and(|e| !matches!(e, ReasoningEffort::Off | ReasoningEffort::Auto));
      if vendor == Some(ReasoningVendor::Anthropic) && active && !is_adaptive_thinking_model(model) {
          Some(("anthropic-beta", "interleaved-thinking-2025-05-14"))
      } else {
          None
      }
  }
  ```
- **严重性**：**HIGH 协议头缺失 / 特性被拒**
- **问题机理**：
  1. **Prompt Caching Beta 头缺失**：虽然请求体注入了 `cache_control`，但在官方 Anthropic API 及某些严格遵循协议的网关中，使用 Prompt Caching 需要携带 `anthropic-beta: prompt-caching-2024-07-31` 请求头。整个代码库中**零处定义或注入该头**；
  2. **Beta 头无法多特性聚合**：Anthropic 官方规定，当同时启用多个 Beta 特性（例如 Prompt Caching + Extended Thinking + 128k Output）时，必须将它们以逗号分隔合并在单个 `anthropic-beta` 头中（例如 `anthropic-beta: prompt-caching-2024-07-31,interleaved-thinking-2025-05-14,output-128k-2025-02-19`）。现有代码中 `reasoning_effort_headers_for_model` 仅返回孤立的单一静态元组，无法进行多特性 Beta 头合并。
  3. `tests/wire_integration.rs:197-198` 甚至把“基线头不得携带 anthropic-beta”作为断言锁定，反向阻止了协议头的正规化装配。

---

### 1.4 OpenAI / Responses 轨协议对缓存机制的过度假设与亲和字段遗漏

- **缺陷位置**：
  - `crates/agent-provider/src/request/build_responses.rs:30-35`
  - `crates/agent-provider/src/request/build_responses.rs:112-117`
- **代码证据**：
  ```rust
  // crates/agent-provider/src/request/build_responses.rs:30-35
  // - **不注入任何 chat 形状缓存字段**：prompt_cache_key / prompt_cache_retention /
  //   prompt_cache_options 对 /responses 属无效载荷（DEEPCHECK-05 #10 原文判定）；
  //   DeepSeek 官方不受支持且缓存自动管理（Context Caching，零参数），OpenAI 系
  //   store / background_store 原生缓存语义留待后续阶段（Responses 轨缓存矩阵）；
  ```
- **严重性**：**MEDIUM 协议适用性狭窄**
- **问题机理**：
  `build_responses_request_body` 将 `/responses` 协议完全等同于 DeepSeek 的 Responses API 变种，硬编码丢弃了所有缓存控制字段。但对于 OpenAI 官方原生 Responses API（支持 `prompt_cache_key` 会话路由）以及 xAI Grok 的 Responses 线路（支持 `x-grok-conv-id` 亲和头），虽然提供了 `affinity_http_headers` 辅助函数，但在请求体构建与参数验证阶段缺乏针对非 DeepSeek 厂商 Responses 协议的完备矩阵支持。

---

### 1.5 Gemini 请求构造缺失缓存控制载体（`cachedContent` 资源引用断层）

- **缺陷位置**：
  - `crates/agent-provider/src/request/build_gemini.rs:38-49`
  - `crates/agent-provider/src/request/build_gemini.rs:62-119`
- **严重性**：**MEDIUM 能力缺失**
- **问题机理**：
  在 Google Gemini API（generateContent / v1beta）中，显式 Context Caching 通过顶层 `cachedContent: "cachedContents/{id}"` 字段进行引用。现有 `GeminiRequestOptions` 和 `build_gemini_request_body` 完全没有定义 `cached_content` 字段，无法接入 Gemini 显式缓存。

---

## 二、思考预算与 Token 映射缺陷

### 2.1 Anthropic 极小思考预算越界（`Minimal` 映射 128 Token 违反官方 `budget_tokens >= 1024` 铁律）

- **缺陷位置**：
  - `crates/agent-provider/src/request/vendor_wire.rs:23`
  - `crates/agent-provider/src/request/vendor_wire.rs:38`
  - `crates/agent-provider/src/request/build_anthropic.rs:124-129`
  - `crates/agent-provider/tests/wire_integration.rs:96, 128`
- **代码证据**：
  ```rust
  // crates/agent-provider/src/request/vendor_wire.rs:21-27
  pub fn effort_to_budget_tokens(effort: ReasoningEffort) -> u64 {
      match effort {
          ReasoningEffort::Minimal => 128,  // 💥 致命错误：低于 Anthropic 官方最小硬约束 1024
          ReasoningEffort::Low => 1024,
          ReasoningEffort::Medium => 2048,
          ReasoningEffort::High => 4096,
          ReasoningEffort::Xhigh => 8192,
          ReasoningEffort::Max => 16384,
          ReasoningEffort::Off | ReasoningEffort::Auto => 2048,
      }
  }

  // crates/agent-provider/src/request/vendor_wire.rs:36-42
  pub fn thinking_to_budget_tokens(intensity: ThinkingIntensity) -> u64 {
      match intensity {
          ThinkingIntensity::Minimal => 128, // 💥 同样低于 1024
          ThinkingIntensity::Low => 1024,
          ...
  ```
- **严重性**：**CRITICAL 运行时请求必崩缺陷**
- **问题机理**：
  Anthropic Messages API（针对 Claude 3.7 Sonnet / extended thinking）官方规范明确规定：

  > `budget_tokens` must be greater than or equal to 1024.

  当用户在前端或配置中将思考强度设为 `Minimal`，或传入 `ReasoningEffort::Minimal` 时，`vendor_wire.rs` 将其换算为 `128`。
  随后 `build_anthropic.rs` 构造出：

  ```json
  {
    "thinking": {
      "type": "enabled",
      "budget_tokens": 128
    }
  }
  ```

- **架构危害**：
  Anthropic 线上 API 收到该请求后，**100% 立即返回 HTTP 400 Bad Request**：
  `"error": {"type": "invalid_request_error", "message": "thinking.budget_tokens: Input should be greater than or equal to 1024"}`。
  更严重的是，`wire_integration.rs:96` 等测试用例甚至把 `128` 当作正确值进行断言，锁死了这个必定导致线上报错的错误数值！

---

### 2.2 Anthropic 思考预算叠加导致 `max_tokens` 溢出模型物理上限（400 拒绝）

- **缺陷位置**：
  - `crates/agent-provider/src/request/build_anthropic.rs:146-157`
- **代码证据**：
  ```rust
  // crates/agent-provider/src/request/build_anthropic.rs:146-157
  let min_max_tokens = budget.map(|b| b.saturating_add(4096)).unwrap_or(2048);
  let final_max_tokens = match opts.max_tokens {
      Some(m) => {
          if budget.is_some() {
              m.max(min_max_tokens)
          } else {
              m
          }
      }
      None => min_max_tokens,
  };
  body.insert("max_tokens".to_string(), json!(final_max_tokens));
  ```
- **严重性**：**HIGH 极端边界崩溃**
- **问题机理**：
  1. 为了防止 `max_tokens <= budget_tokens` 导致 Anthropic 报错（Anthropic 要求 `max_tokens > budget_tokens`），代码采用了 `budget.saturating_add(4096)` 进行自动抬升；
  2. 但是，**没有任何向上钳制（clamping）逻辑**。如果用户或系统指定了一个较大的思考预算，例如 `thinking_budget = 64000`（Claude 3.7 Sonnet 的最大输出窗口上限）：
     `min_max_tokens = 64000 + 4096 = 68096`；
  3. 请求体发出的 `max_tokens` 将为 `68096`；
  4. Claude 3.7 Sonnet 在未开启 128k output Beta 时，支持的 `max_tokens` 上限严格为 `64000`。
- **架构危害**：
  Anthropic 校验 `max_tokens: 68096 > 64000`，立即返回 **HTTP 400 Bad Request**（`max_tokens must be less than or equal to 64000`）。自动抬升算法由于缺乏与模型目录（`ModelCatalogEntry.max_output_tokens`）的上限对齐，在极限思考预算下直接引发 API 拒绝。

---

### 2.3 Anthropic 非思考模式缺省 `max_tokens` 盲目回落 2048 导致长文本输出被腰斩

- **缺陷位置**：
  - `crates/agent-provider/src/request/build_anthropic.rs:146`
- **代码证据**：
  ```rust
  let min_max_tokens = budget.map(|b| b.saturating_add(4096)).unwrap_or(2048);
  ```
- **严重性**：**MEDIUM 体验劣化 / 输出截断**
- **问题机理**：
  当调用方未显式传递 `opts.max_tokens` 且未开启思考时，`min_max_tokens` 回落至固定常量 `2048`。
  Anthropic API 要求 `max_tokens` 必填。但现行 Claude 3.5 Sonnet / 3.7 Sonnet 的原生最大生成能力分别为 8192 和 64000。缺省强行填入 `2048` 导致模型在进行大文件重构、长代码输出或详细分析时，极易触发 `finish_reason: "max_tokens"`（`StopReason::Length`），生成内容被半路截断。

---

### 2.4 Chat Completions 轨缺少 `max_tokens` / `max_completion_tokens` 思考预算抬升保障

- **缺陷位置**：
  - `crates/agent-provider/src/request/build_chat.rs:42-44`
- **代码证据**：
  ```rust
  // crates/agent-provider/src/request/build_chat.rs:42-44
  if let (Some(field), Some(value)) = (opts.max_tokens_field, opts.max_tokens) {
      body.insert(field.as_str().to_string(), json!(value));
  }
  ```
- **严重性**：**HIGH 响应截断 / 网关报错**
- **问题机理**：
  在 OpenAI `o1`/`o3` 系列以及各类第三方 OpenAI 兼容网关（如 DeepSeek-R1、Claude-via-OpenAI-Proxy）中，`max_completion_tokens`（或 `max_tokens`）表示**思考 Token 与输出 Token 的总和**。
  如果客户端设置了 `max_tokens = 2048` 并且开启了高强度思考，模型可能在思考阶段就消耗了 1900 Token，导致输出正文只有 148 Token 就会截断；如果代理后端是 Anthropic 并要求 `max_tokens > budget`，直接返回 400 错误。
  `build_chat.rs` 完全没有像 `build_anthropic.rs` 那样针对思考参数对 `max_tokens` 进行安全抬升与校验。

---

### 2.5 Gemini 思考强度参数与官方 API 结构/大小写契约严重违背（`thinking_level` vs `thinkingConfig`）

- **缺陷位置**：
  - `crates/agent-provider/src/request/build_gemini.rs:91-97`
  - `crates/agent-provider/src/request/vendor.rs:266-272`
  - `crates/agent-provider/src/request/vendor_wire.rs:49-69`
- **代码证据**：
  ```rust
  // crates/agent-provider/src/request/build_gemini.rs:91-97
  if let Some(intensity) = opts.thinking_intensity {
      if intensity != ThinkingIntensity::Off {
          generation.insert(
              "thinking_level".to_string(),
              json!(thinking_to_gemini_thinking_level(intensity)),
          );
      }
  }
  ```
  生成 JSON 为：
  ```json
  {
    "generationConfig": {
      "thinking_level": "high"
    }
  }
  ```
- **严重性**：**CRITICAL 协议格式错误 / 思考参数被静默忽略或报错**
- **问题机理**：
  Google Gemini API（generateContent v1beta）对于思考模型的真实规范如下：
  1. Gemini 2.0 Flash Thinking / 2.5 系列使用的是 `generationConfig.thinkingConfig` 对象，而非根级 snake_case 的 `thinking_level`；
  2. 预算控制字段为 `thinkingBudget: 1024`（整数）；若使用级别控制，字段为 `thinkingLevel: "HIGH"`（大写枚举）；
  3. `build_gemini.rs` 产出的 `"generationConfig": { "thinking_level": "high" }` 是非标准的伪字段，发送给官方 Google Gemini API 时会被当作未知字段静默忽略，导致思考模型退化为默认行为或直接被 API 拦截。

---

## 三、死协议与冗余类型排查

### 3.1 `conex-types/src/lib.rs` 残留废弃 IPC 协议类型（`IpcEnvelope`, `IpcResponse`）

- **缺陷位置**：
  - `crates/conex-types/src/lib.rs:135-152`
  - `crates/conex-types/src/lib.rs:424-437`（仅在自身单元测试中引用）
- **代码证据**：
  ```rust
  // crates/conex-types/src/lib.rs:135-152
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
  #[serde(rename_all = "camelCase")]
  pub struct IpcEnvelope {
      pub id: String,
      pub method: String,
      pub payload: serde_json::Value,
      pub timestamp: u64,
  }

  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
  #[serde(rename_all = "camelCase")]
  pub struct IpcResponse {
      pub id: String,
      #[serde(default, skip_serializing_if = "Option::is_none")]
      pub result: Option<serde_json::Value>,
      #[serde(default, skip_serializing_if = "Option::is_none")]
      pub error: Option<String>,
  }
  ```
- **严重性**：**LOW 纯死代码 / 冗余垃圾**
- **问题机理**：
  根据文档 `docs/multi-device/plans/D3-protocol.md:1544` 记录，`IpcEnvelope` / `IpcResponse` 是早期 Round 2 遗留的试验性类型，在多端协议定稿时已被正式弃用，改用 `DeviceEnvelope`。在整个工作区（除 `lib.rs` 内部的两行自测代码外）没有任何代码引用该类型，属于应当彻底清除的死代码。

---

### 3.2 `conex-types/src/lib.rs` 存在未序列化且重名冲突的死类型（`StreamChunk` vs `device::stream::StreamChunk`）

- **缺陷位置**：
  - `crates/conex-types/src/lib.rs:156-160`
  - `crates/conex-types/src/device/stream.rs:51-60`
- **代码证据**：
  ```rust
  // crates/conex-types/src/lib.rs:156-160
  #[derive(Debug, Clone, PartialEq)]
  pub struct StreamChunk {
      pub data: Vec<u8>,
      pub is_final: bool,
  }
  ```
  对比真实的跨端协议类型：
  ```rust
  // crates/conex-types/src/device/stream.rs:51-60
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
  #[serde(rename_all = "camelCase")]
  pub struct StreamChunk {
      pub stream_id: String,
      pub seq: u64,
      pub data: String,
      pub bytes: u32,
      #[serde(default, skip_serializing_if = "Option::is_none")]
      pub chunk_hash: Option<String>,
  }
  ```
- **严重性**：**MEDIUM 类型污染与同名命名空间冲突**
- **问题机理**：
  `lib.rs:157` 中的 `StreamChunk` 甚至没有 derive `Serialize`/`Deserialize`，在整个仓库中完全无引用，且与 `conex_types::device::stream::StreamChunk` 重名，造成符号导出污染和潜在的类型引用混淆。

---

### 3.3 扁平化旧消息契约 `Message` 与 `CompactionResult` 残留导致双重消息模型分裂

- **缺陷位置**：
  - `crates/conex-types/src/lib.rs:115-131`
  - `crates/conex-compaction/src/engine.rs:6, 35-55`
- **代码证据**：
  ```rust
  // crates/conex-types/src/lib.rs:115-123
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
  #[serde(rename_all = "camelCase")]
  pub struct Message {
      pub id: String,
      pub role: String,
      pub content: String,
      #[serde(default, skip_serializing_if = "Option::is_none")]
      pub images: Option<Vec<String>>,
  }
  ```
- **严重性**：**MEDIUM 架构断层**
- **问题机理**：
  整个系统的主消息核心类型已经是块级结构的 `AgentMessage`（包含 `AgentMessageBlock::Text`, `Thought`, `ToolCall`, `ToolResult`）。
  而 `lib.rs:117` 中的 `Message` 和 `CompactionResult` 依然是旧时代的扁平化 `{ role, content, images }` 结构。这导致 `conex-compaction` 中存在两套压缩逻辑：一套针对旧 `Message`，另一套针对 `AgentMessage`，严重违反了领域模型的单一事实源原则。

---

### 3.4 `conex-types/src/events.rs` 中未发射死事件与冗余安全审计变体

- **缺陷位置**：
  - `crates/conex-types/src/events.rs:74`（`SecurityAuditOperation::GitRevert`）
  - `crates/conex-types/src/events.rs:117-120`（`SecurityAuditDecision::Restored / Purged`）
- **严重性**：**LOW 冗余枚举变体**
- **问题机理**：
  `SecurityAuditOperation::GitRevert` 注明为“预留供 S6 面积审计”，但目前全系统零发射点；`SecurityAuditDecision` 中的 `Restored` 和 `Purged` 与既有的 `TrashRestore` 和 `TrashPurge` 操作重叠。

---

### 3.5 `conex-shared` 与 `conex-computer` / `conex-browser` 的重叠与死辅助代码

- **缺陷位置**：
  - `crates/conex-shared/src/lib.rs:35`
  - `crates/conex-shared/src/test_support.rs:1-40`
- **代码证据**：
  ```rust
  // crates/conex-shared/src/lib.rs:35
  #[cfg(test)]
  pub(crate) mod test_support;
  ```
- **严重性**：**LOW 边界不清**
- **问题机理**：
  `conex-shared` 作为纯 leaf trait crate，只定义了 `frame.rs`、`gate.rs`、`input.rs` 三个小抽象文件，但在实际项目中，`PhysicalPoint` 等类型依然在 `conex-computer/src/coord.rs` 中被重新声明，未能完全发挥统一共享类型的作用。

---

## 四、测试有效性与遗漏的错误处理分支

### 4.1 虚假 Wire 协议测试：`wire_integration.rs` 仅为内存结构断言，完全缺失真实 HTTP/TCP 协议帧检验

- **缺陷位置**：
  - `crates/agent-provider/tests/wire_integration.rs:93-122`
  - `crates/agent-provider/tests/wire_integration.rs:125-165`
  - `crates/agent-provider/tests/wire_integration.rs:240-270`
- **代码证据**：
  ```rust
  // crates/agent-provider/tests/wire_integration.rs:108-115
  let body = anthropic_body(&opts, vec![Arc::new(user_msg("hi"))]);
  let thinking = body.get("thinking").expect("启用档位必须带 thinking 键");
  assert_eq!(thinking["type"], "enabled");
  assert_eq!(
      thinking["budget_tokens"],
      effort_to_budget_tokens(effort),
      "档位 {effort:?} 的 budget_tokens 必须与 vendor 换算一致"
  );
  ```
- **严重性**：**HIGH 测试虚假覆盖 / 假阳性**
- **问题机理**：
  虽然文件命名为 `wire_integration.rs`，但它**完全没有启动任何 Mock HTTP Server，没有向网络栈发送任何字节，也没有验证 HTTP Header 与 Body 的真实序列化形式**。
  它只是在内存中调用了 `build_anthropic_request_body` 并断言其内部的 `serde_json::Value` 字段。正因为如此，前述的：
  1. `ReasoningEffort::Minimal` 产生非法的 `budget_tokens: 128`；
  2. `anthropic_request_headers` 遗漏 `anthropic-beta` 头；
  3. `Gemini` 产出错误的 `thinking_level`；
     全都在这套“集成测试”中绿灯通过，导致核心协议错误在 CI 门禁中被彻底掩盖。

---

### 4.2 HTTP 529 (Anthropic Overloaded) 及扩展 5xx 状态码漏判导致指数退避降级为不可恢复崩溃

- **缺陷位置**：
  - `crates/agent-provider/src/error_classify.rs:80-82`
  - `crates/agent-provider/src/error.rs:198-312`
- **代码证据**：
  ```rust
  // crates/agent-provider/src/error_classify.rs:80-82
  pub(super) fn is_server_status(status: Option<u16>) -> bool {
      matches!(status, Some(500 | 502 | 503 | 504 | 520 | 522 | 523 | 524))
  }
  ```
- **严重性**：**CRITICAL 运行时容灾死穴**
- **问题机理**：
  1. **遗漏 HTTP 529**：Anthropic 官方在服务器负载过高时返回特有的 **`HTTP 529 Overloaded`** 状态码；
  2. **遗漏标准 5xx 与 CDN 错误码**：`is_server_status` 仅硬编码了 8 个状态码，遗漏了 521（Web Server Down）、525（SSL Handshake Failed）、526、529、530 以及 HTTP 507/508/511；
  3. **分类降级分析**：
     当 Anthropic 返回 `HTTP 529 {"error": {"type": "overloaded_error", "message": "Anthropic is overloaded"}}` 时：
     - 在 `classify_provider_error` 中，`status == 529` 不在 400/401/402/403/404/413/422/429 中；
     - 走到第 292 行 `if is_server_status(status)`：返回 `false`；
     - 走到第 295 行 `detect_server_message(&lower)`：虽然可能因包含 "overloaded" 救回，但如果第三方代理或 Anthropic 变体返回 `"529: temporarily rate limited"`（无 overloaded 关键词），则无法匹配；
     - 最终落入第 309 行 **`ProviderError::Unknown`**！
  4. **致命后果**：
     `ProviderError::Unknown` 的 `is_retryable()` 为 **`false`**。原本应当进行指数退避（Exponential Backoff）重试的瞬态服务器过载，被直接判定为不可重试的未知致命错误，导致正在运行的会话直接崩溃退出！

---

### 4.3 `classify_provider_error` 字符串探测优先级过高导致常规 400 请求被误判为用户 `Aborted`

- **缺陷位置**：
  - `crates/agent-provider/src/error.rs:209-211`
- **代码证据**：
  ```rust
  // crates/agent-provider/src/error.rs:209-211
  // 1. abort（signal.aborted / isAbortError 等价，error-classifier.ts:119-126）
  if source == ProviderSourceError::Aborted || lower.contains("aborted") {
      return ProviderError::Aborted;
  }
  ```
- **严重性**：**MEDIUM 错误分类假阳性**
- **问题机理**：
  `lower.contains("aborted")` 的检查被放在了整个分类管线的第一步（甚至先于任何 HTTP 状态码的检查）。
  如果用户的 Prompt 是“分析为什么脚本 aborted”，或者服务端返回一个带有说明的 HTTP 400 报错体（例如 `{"error": "Validation failed: action was aborted due to schema mismatch"}`），该报错体中的 `"aborted"` 字符串会直接命中第一行，将一个合法的 400 `InvalidRequest` 错误错误地分类为 `ProviderError::Aborted`（用户取消）。这会导致系统误以为是用户手动取消了任务，从而跳过所有的错误报警和重试诊断。

---

### 4.4 SSE 分帧解析异常静默吞没（`push_frame` 畸形 JSON 帧被 `Ok(Vec::new())` 静默忽略造成坏数据截断）

- **缺陷位置**：
  - `crates/agent-provider/src/parse/chat_core.rs:67-69`
  - `crates/agent-provider/src/parse/anthropic_core.rs:118-120`
  - `crates/agent-provider/src/parse/gemini_core.rs:91-93`
- **代码证据**：
  ```rust
  // crates/agent-provider/src/parse/chat_core.rs:67-69
  let Ok(payload) = serde_json::from_str::<Value>(data) else {
      return Ok(Vec::new());
  };
  ```
- **严重性**：**MEDIUM 静默数据丢失**
- **问题机理**：
  当网络传输发生分片丢包或网关返回非预期畸形数据块时，`data` 字段可能不是合法的 JSON。解析器直接执行 `let Ok(...) else { return Ok(Vec::new()); }`，**静默丢弃该帧并返回空事件列表，不记录任何警告也不上报协议错误**。
  如果流随后正常结束（收到 `[DONE]`），整个解析器会认为流已成功收尾，导致客户端悄无声息地丢失了部分生成文本或截断了关键的工具调用参数，而用户和审计日志完全不知情。

---

### 4.5 Responses API 思考流事件中 `redacted` 属性错误硬编码为 `Some(true)` 导致明文思考被遮蔽

- **缺陷位置**：
  - `crates/agent-provider/src/parse/responses_core.rs:99-107`
- **代码证据**：
  ```rust
  // crates/agent-provider/src/parse/responses_core.rs:99-107
  "response.reasoning_summary_text.delta"
  | "response.reasoning_text.delta"
  | "response.reasoning.delta" => {
      if let Some(delta) = non_empty_string(payload.get("delta")) {
          events.push(ProviderStreamEvent::ThoughtDelta {
              text: delta.to_owned(),
              redacted: Some(true), // 💥 错误硬编码为 redacted: Some(true)
          });
      }
  }
  ```
- **严重性**：**HIGH UI 渲染与可观测性缺陷**
- **问题机理**：
  在 OpenAI Responses 协议中：
  - `response.reasoning_text.delta` 和 `response.reasoning.delta` 传输的是**模型生成的真实明文思考内容**；
  - 只有在模型提供商明确对思考进行了安全加密或摘要哈希遮蔽时，才属于 `redacted` 状态。
    然而在 `responses_core.rs:105` 中，所有的 reasoning 事件被无差别硬编码为 `redacted: Some(true)`。
    前端接收到 `redacted: true` 后，会将这些本应完全可见的思考 Token 判定为“已打码/被脱敏的内容”，在 UI 界面上折叠甚至隐藏为遮罩占位符，导致用户无法正常查阅模型推理过程。

---

## 五、综合整改与重构行动建议清单

针对上述排查出的所有架构断层、协议缺陷、数值溢出与死代码，提出以下系统化整改行动项：

| 编号       | 模块                     | 缺陷摘要                                   | 整改行动方案                                                                                                                                                                   | 验证标准                                                           |
| ---------- | ------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| **ACT-01** | `agent-provider/request` | Anthropic 多轮消息缺少缓存断点             | 修改 `build_anthropic.rs`，在 `allocate_breakpoints` 中启用 `messages` 锚点，并在 `to_anthropic_messages` 的末尾用户/工具消息上正确附加 `cache_control: {"type": "ephemeral"}` | 单元测试验证多轮对话下最后一条 user 消息末块带有 `cache_control`   |
| **ACT-02** | `agent-provider/request` | `AnthropicRequestOptions` 缺失缓存策略支持 | 为 `AnthropicRequestOptions` 补齐 `pub cache: Option<CachePolicy>`，仅当策略启用且非 None 档时才注入断点                                                                       | 单元测试验证 `enabled=false` 时 Anthropic 请求体零 `cache_control` |
| **ACT-03** | `agent-provider/vendor`  | `Minimal` 思考预算输出 128 违规            | 将 `effort_to_budget_tokens` 与 `thinking_to_budget_tokens` 中 `Minimal` 的返回值修正为 `1024`，并对显式传入的 `budget` 进行 `max(1024)` 守卫                                  | 单元测试验证所有启用档位 budget 均 `>= 1024`                       |
| **ACT-04** | `agent-provider/request` | `max_tokens` 抬升未受模型上限钳制          | 在 `build_anthropic.rs` 中引入模型物理上限钳制：`final_max_tokens = min(final_max_tokens, catalog_max_output_tokens.unwrap_or(64000))`                                         | 单元测试验证在 64k 思考预算下 `max_tokens` 不超过 64000            |
| **ACT-05** | `agent-provider/request` | Gemini 思考参数格式错误                    | 重构 `build_gemini.rs`，将思考参数按官方规范装配为 `generationConfig.thinkingConfig.thinkingBudget` 或 `thinkingLevel: "HIGH"`                                                 | 契约测试验证 Gemini 请求体符合 Google v1beta 规范                  |
| **ACT-06** | `agent-provider/error`   | 遗漏 HTTP 529 及通用 5xx 状态码            | 将 `is_server_status` 重构为 `matches!(status, Some(500..=599))`，全面覆盖 529 Overloaded 及所有服务器错误                                                                     | 单元测试验证 529 状态码被正确判定为可重试的 `ServerError`          |
| **ACT-07** | `agent-provider/error`   | `aborted` 文本误判假阳性                   | 调整 `classify_provider_error` 优先级：仅在 `source == ProviderSourceError::Aborted` 时判定为取消，消息体内的 `"aborted"` 关键词回退至 400 状态码判定之后                      | 单元测试验证带 aborted 文案的 400 错误正确解析为 `InvalidRequest`  |
| **ACT-08** | `agent-provider/parse`   | Responses 思考流 `redacted` 误标           | 仅对 `response.reasoning_summary_text.delta` 或显式标记的脱敏块设置 `redacted: Some(true)`，明文 `reasoning_text.delta` 设置为 `None` 或 `Some(false)`                         | 单元测试验证 Responses 明文思考流事件 `redacted != Some(true)`     |
| **ACT-09** | `conex-types`            | 清理废弃 IPC 与重名类型                    | 彻底删除 `lib.rs` 中的 `IpcEnvelope`、`IpcResponse` 及未序列化的 `StreamChunk`，收敛领域模型                                                                                   | `cargo check --workspace` 零报错，消灭符号污染                     |
| **ACT-10** | `agent-provider/tests`   | 补充真实 HTTP Wire 协议测试                | 在 `tests/` 中基于 `MockServer` 编写真实收发 HTTP 请求体的集成测试，校验 HTTP Header（`anthropic-beta`）与 Wire 序列化数据                                                     | 测试覆盖真实的 HTTP POST + SSE 解析全链路                          |
