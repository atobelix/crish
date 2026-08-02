# P2 方案：通用格式层（Wire 协议层）缓存参数注入与 usage 归一化

> 撰写日期：2026-08-03
> 文档性质：方案设计（只读分析 + 文档产出，未修改任何源代码）
> 所属计划：`docs/cache-optimization/` 计划族第 2 项（P1 前缀稳定 → **P2 通用格式层** → P3 厂商/模型开关与数据 → P4 历史回流/上下文管理 → P5 测量层/遥测 → P6 TS 侧协同）【A1 审计修正】原稿"→ P4 测量层"归属错误：测量层是 P5（P5-cache-telemetry），P4 是历史回流/上下文管理；本文中所有"归 P4"的测量/命中率/归因/展示表述均已改为 P5。
> 输入材料：
>
> - `docs/cache-optimization/02-comparison/comparison.md`（第 2.4/2.5/2.6/2.7 节与第 5 节第二层 4/5/6 项）
> - `docs/cache-optimization/01-reference-research/` 的 opencode / pi / litellm / kimi-code 四份缓存分析
> - `docs/cache-optimization/00-vendor-model-pricing-catalog.md`（厂商缓存机制与计量字段数据基准）
> - crish 实际代码（全部实读核实，行号以实读为准，见第 2 节证据清单）

---

## 1. 目标与范围

### 1.1 结论先行

**P2 在 crish 的 Rust 引擎请求构造层（`crates/agent-provider/src/request/`）与解析层（`crates/agent-provider/src/parse/`）建立"协议无关的缓存参数注入框架 + 全厂商 usage 归一化不变量"**，覆盖四个子主题：

- **A. Anthropic 系 `cache_control` 断点注入**：载体结构、注入条件、≤4 断点预算的层级分配（tools→system→messages）、TTL 桶（5m/1h）、`supportsCacheControlOnTools` 类模型开关、DeepSeek 省略分支与 MiniMax 主动缓存开关。
- **B. OpenAI 系 `prompt_cache_key` / `prompt_cache_retention` / GPT-5.6+ `prompt_cache_options`**：sessionId 推导规则（64 字符钳制）、retention 两档、显式断点是否做（结论：与 Anthropic 断点统一策略源，一期仅 implicit 键路由）。
- **C. Gemini 隐式缓存适配 + explicit `cachedContents` 评估**：结论：一期不做显式缓存，仅确认隐式路径依赖 P1 前缀稳定，预留二期挂点。
- **D. usage 归一化补全**：统一不变量（input = miss + hit + write 按协议族归一）、hit 字段优先级链、write 字段别名链、分片流式合并的 max 语义、事件/遥测输出字段。
- **E. 厂商门控矩阵**：数据表 + 存放位置（`request/cache.rs` 内置默认表，P3 负责数据覆盖）。

### 1.2 范围

**做**（P2 交付）：

1. `crates/agent-provider` 新增 `request/cache.rs` 模块：缓存参数载体、能力推断、断点预算分配、wire 注入、键派生——全部纯函数、可单测。
2. `request/messages.rs`：`ChatContentPart` / `ChatMessage` 增加可选的 `cache_control` 载体字段（序列化仅在 Some 时出现，不影响既有 wire）。
3. `request/build.rs`：`ChatCompletionsRequestOptions` 增加缓存参数选项；请求体注入 `prompt_cache_key` / `prompt_cache_retention` / `prompt_cache_options` / 消息与工具级 `cache_control`。
4. `parse/chat.rs` usage 解析补全（顶层 hit/miss、Kimi 顶层 cached_tokens、write 别名）+ `parse/gemini.rs` 补 `total_cached_tokens` 别名 + `events.rs` `ProviderUsage` 增补 `cache_miss_tokens` 字段与归一化派生函数。
5. `session-loop` 契约面：`ProviderRequest` 增 `session_id` 透传；`ConsumeBuilder` 增 usage 口径提示（为归一化派生提供协议族信息）。
6. `apps/agent-workbench/src-tauri/src/engine.rs` 适配层接线：仅调用 `build_cache_policy` 完成能力判定 + 参数组装（唯一真实调用面；能力判定收敛于 `build_cache_policy` 内部，见 §3.1.2【调度者裁决】）。

**不做**（明确排除，分属其他计划）：

- 前缀稳定性工程（tools 排序、system prompt 透传、历史回流）→ **P1**。
- 按厂商/模型的开关数据、模型目录、配置 UI、实测校准 → **P3**。
- 命中率测量、miss 审计、成本展示 → **P5**（本计划只保证"字段解析完整 + 归一化口径唯一"，消费端归 P5）。【A1 审计修正】原稿"P4"归属错误（P4=历史回流/上下文管理，测量层=P5）。
- Anthropic Messages 原生端点（`/v1/messages`）的完整接入（端点枚举、URL、SSE 事件消费接线）→ 不在本计划（本计划只提供该端点未来复用的断点注入与 usage 解析框架；P2 的注入先作用于 chat-completions 兼容线路上可承载 `cache_control` 的厂商，如 MiniMax/百炼/GLM 的 Anthropic 兼容端点与未来原生端点）。

### 1.3 设计原则

1. **协议无关的策略源**：断点"放不放、放几个、放哪"由一份 `BreakpointPlan` 决策，Anthropic 块级 `cache_control` 与 OpenAI GPT-5.6+ 显式断点共用同一生成器（对齐 opencode cache-policy 思想，opencode-cache-analysis.md:83-99）。
2. **透传不重建、判定不强制**（litellm-cache-analysis.md:24）：请求层只负责"按门控矩阵注入/省略"，不重写厂商语义；无缓存配置时请求字节与现状完全一致（compactObject 等价，None 字段一律省略）。
3. **默认保守**：一切显式缓存参数默认关闭，DeepSeek 强制省略；只有命中断点能力的厂商/模型才注入。写入费用（Anthropic 1.25x/2x、GPT-5.6+ 1.25x）高于命中折扣，宁缺毋滥（00-vendor-model-pricing-catalog.md 第 1.3/2.1 节）。
4. **与既有约定对齐**：camelCase 序列化、`finite_u64` 防御、覆盖式/合并式解析语义（02 §2.5、§六.6）、中文注释（UTF-8 无 BOM）。

---

## 2. 现状证据（全部实读核实）

### 2.1 请求构造层（`crates/agent-provider/src/request/`）

| 位置                  | 现状                                                                                                                                           | 与本计划的关系                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `vendor.rs:14-41`     | `ReasoningVendor` 枚举（Openai/Anthropic/Deepseek/Gemini/Qwen/Glm/Kimi/Auto）                                                                  | 厂商识别基准，但**无 MiniMax/Moonshot 变体**；缓存能力表不扩它，另建                                |
| `vendor.rs:277-310`   | `infer_reasoning_vendor(base_url, model)`：baseUrl 关键字（anthropic/deepseek/gemini/openai）→ model 前缀（claude/gpt/o1/o3/o4/qwen/glm/kimi） | 缓存能力推断 `infer_cache_capability` 的模板（同构）                                                |
| `vendor.rs:219-257`   | `MODEL_SERIES_CAPABILITIES` 最长前缀命中表                                                                                                     | 缓存能力表 `CACHE_CAPABILITY_TABLE` 的模板                                                          |
| `vendor.rs:437-452`   | `reasoning_effort_headers`：vendor=anthropic 才发 `anthropic-beta` 头                                                                          | 会话亲和头/断点头的注入模式可复用（P2 默认不做头）                                                  |
| `messages.rs:62-72`   | `ChatMessage { role, content: Option<ChatContent>, tool_call_id, reasoning_content, tool_calls }`                                              | **无 cache_control 字段**（比较文档第 2.4 节判定的缺口）                                            |
| `messages.rs:38-42`   | `ChatContentPart` 仅 Text{text} / ImageUrl{url,detail}                                                                                         | 需扩展 Text 变体承载 `cache_control`                                                                |
| `messages.rs:318-395` | `to_chat_messages` 纯映射（0 深拷贝借用，PE-09 T09.3）                                                                                         | 保持纯函数，断点注入做独立后处理 pass（见 3.2）                                                     |
| `tools.rs:12-19`      | `ToolDefinition { name, description, input_schema }`；`to_openai_tool` 序列化                                                                  | 工具级 cache_control 在序列化处附加，不污染定义                                                     |
| `build.rs:44-63`      | `ChatCompletionsRequestOptions`（model/stream/temperature/max_tokens/reasoning_effort/vendor/thinking_intensity…）                             | 缓存参数选项挂在此结构（对齐既有的 reasoning 注入模式）                                             |
| `build.rs:102-177`    | `build_chat_completions_request_body`：compactObject 等价（None 省略）、messages 内联映射、tools+tool_choice、`stream_options.include_usage`   | 缓存字段注入点：body 顶层（prompt_cache_key/retention/options）+ messages/tools 级（cache_control） |
| `config.rs:44-53`     | `Endpoint` 仅 Auto/Responses/ChatCompletions                                                                                                   | 无 Anthropic Messages 端点（原生端点接线非本计划）                                                  |
| `config.rs:108-110`   | `ProviderConfig.extra: BTreeMap<String, Value>`                                                                                                | 厂商私有参数透传通道（P3 开关数据的落点）                                                           |

### 2.2 调用面（`apps/agent-workbench/src-tauri/src/engine.rs`）

- `engine.rs:168-174` `provider_url`：只支持 `/responses` 与 `/chat/completions` 两个端点路径。
- `engine.rs:207-215` `request_options`：组装 `ChatCompletionsRequestOptions`，目前只有 model/stream/max_tokens。
- `engine.rs:218-233` `build_context`：`system_prompt: None`（**主路径 system prompt 恒为 None**，比较文档第 2.3 节）——断点注入的 system 锚点依赖 P1 的 system prompt 透传落地。
- `engine.rs:246-256`：`build_chat_completions_request_body` + 仅 Authorization 头。
- `session-loop/src/provider.rs:74-81`：`ProviderRequest { messages, tools, max_tokens }`——**无 session_id**（prompt_cache_key 的键来源缺失，需补契约字段）。

### 2.3 解析层（`crates/agent-provider/src/parse/`）

| 位置                                           | 现状                                                                                                                                                                               | 缺口                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat.rs:251-267` `parse_usage`                | `prompt_tokens??input_tokens`；`prompt_tokens_details.cached_tokens ?? input_tokens_details.cached_tokens` → cacheRead；`reasoning_tokens` 有；**`cache_write_tokens: None` 写死** | ①DeepSeek 顶层 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 未解析（比较文档表注，directFetchBridge.ts:271-278 有实现但主路径无）；②Kimi 顶层 `usage.cached_tokens` 未解析（00-catalog 第 5.2 节）；③write 别名 `cache_write_tokens` / `cache_creation_tokens` / `prompt_tokens_details.cache_creation_input_tokens` 未覆盖（litellm-cache-analysis.md:377-382） |
| `chat.rs` 同款                                 | 被 `responses.rs:33` 复用                                                                                                                                                          | 同上三缺口对 Responses 一并生效                                                                                                                                                                                                                                                                                                                                            |
| `anthropic.rs:308-339` `parse_anthropic_usage` | `cache_read_input_tokens` → cacheRead、`cache_creation_input_tokens` → cacheWrite，**完整**                                                                                        | 无缺口（1h 细分 `usage.cache_creation.ephemeral_1h_input_tokens` 未拆，属 P5 成本核算，本计划记录不拆）【A2 审计修正：原"P4 成本核算"为陈旧编号，成本核算=P5】                                                                                                                                                                                                             |
| `anthropic.rs:345-372` `merge_anthropic_usage` | message_start + message_delta 分片补全：next 显式字段优先、total 重算                                                                                                              | 分片合并语义待统一（见 3.4 的 max 语义裁决）                                                                                                                                                                                                                                                                                                                               |
| `gemini.rs:309-345` `parse_gemini_usage`       | `cachedContentTokenCount` → cacheRead、`thoughtsTokenCount` → reasoning                                                                                                            | 缺 `total_cached_tokens` 别名（00-catalog 第 8.2 节：隐式缓存计量字段为 `total_cached_tokens`）                                                                                                                                                                                                                                                                            |
| `gemini.rs:351-380` `merge_gemini_usage`       | 逐帧合并：next 优先、total 三级回退                                                                                                                                                | 与 anthropic 同需对齐 max 语义                                                                                                                                                                                                                                                                                                                                             |
| `events.rs:31-52` `ProviderUsage`              | 六字段 camelCase：prompt/completion/total/cache_read/cache_write/reasoning                                                                                                         | **无 cache_miss_tokens**；无归一化派生函数；无协议族口径标记                                                                                                                                                                                                                                                                                                               |

### 2.4 证据链结论

与比较文档第 1 节总览表一致：**crish 的 usage 解析是唯一"接近完备"维度（约 60%），请求侧缓存机制完全空白**。P2 的增量恰好落在比较文档第 5 节"第二层：通用格式层"的第 4/5/6 项（usage 字段补齐、cache_control 断点载体与策略、prompt_cache_key）。

---

## 3. 设计

### 3.1 新增模块：`crates/agent-provider/src/request/cache.rs`

本计划的核心新增文件，全部为纯函数/数据结构（无 HTTP、无 IO），单测驱动。

#### 3.1.1 缓存参数载体（对齐 TS/各厂商 wire 值）

```rust
/// 缓存保留档位（对齐 pi 的 CacheRetention 三档，pi-cache-analysis.md:126-131）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CacheRetention {
    /// 完全不参与缓存（不发任何缓存参数；摘要请求强制此档，对齐 pi compaction.ts:562-581）
    None,
    /// 短档：Anthropic 5 分钟 TTL 桶 / OpenAI in_memory
    #[default]
    Short,
    /// 长档：Anthropic 1 小时 TTL 桶（写价 2x）/ OpenAI 24h extended
    Long,
}

/// TTL 桶（对齐 opencode protocols/utils/cache.ts:12-16 的 5m/1h 双桶）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheTtl {
    /// `{"type":"ephemeral"}`（Anthropic 默认 5 分钟；命中刷新免费）
    FiveMinutes,
    /// `{"type":"ephemeral","ttl":"1h"}`（写价 2x，受模型开关 supportsLongCacheRetention 约束）
    OneHour,
}
```

> 【A2 审计修正】**命名冲突裁决（P2 × P3）**：P3 在 `crates/agent-provider/src/models/ttl.rs` 定义同名 `CacheTtl`（`Short/Hour/Day` 三档路由语义）。两者同处 `agent-provider` crate，同名导入必然冲突。**裁决（承接 A1 在 P3 §3.2.1 的"取一"标注）：本类型（wire 桶，5m/1h 双档）更名 `TtlBucket`，`CacheTtl` 名称留给 P3 的模型级 TTL 路由档**（P3 §3.5，serde 值域 `"5m"/"1h"/"24h"` 已在 P3 侧按 A2 落地）。实施时以 `TtlBucket` 落地，`apply_cache_controls`/`CachePolicy` 中的 `CacheTtl` 引用一并改名。**`CacheKey::from_session_id`（本文件）与 P3 `derive_prompt_cache_key`（models/cache_key.rs）同一规则：按 A1 裁决（P3 §3.3.1 标注），实现保留在本文件的 `CacheKey::from_session_id`（请求构造面真源），P3 的 `derive_prompt_cache_key` 作为 models/ 层等价委托（或删除重复实现），禁止两套独立实现漂移。**

```rust
/// 块级/消息级缓存控制标记（Anthropic 系 wire 值）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheControl {
    /// `{"type":"ephemeral"}`
    Ephemeral,
    /// `{"type":"ephemeral","ttl":"1h"}`
    Ephemeral1h,
}

impl CacheControl {
    /// 序列化为 wire 值
    pub fn to_value(self) -> Value {
        match self {
            Self::Ephemeral => json!({ "type": "ephemeral" }),
            Self::Ephemeral1h => json!({ "type": "ephemeral", "ttl": "1h" }),
        }
    }
}

/// 统一缓存键（OpenAI 系 prompt_cache_key 的语义载体）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheKey(pub String);

impl CacheKey {
    /// 会话 ID → 缓存键：按 Unicode 码点钳到 64 字符（对齐 pi
    /// openai-prompt-cache.ts:1-8 的 OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH=64）
    pub fn from_session_id(session_id: &str) -> Option<Self> {
        let trimmed = session_id.trim();
        if trimmed.is_empty() { return None; }
        Some(Self(trimmed.chars().take(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).collect()))
    }

    /// 显式不参与缓存时（摘要请求）返回 None 等价物：调用方用 CacheRetention::None 表达
}

/// OpenAI prompt_cache_key 最大长度（码点）
pub const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH: usize = 64;
```

> 键推导规则（B 子主题核心）：**`prompt_cache_key` 一律由会话 ID 派生**（Kimi `profileService.ts:451`、opencode `transform.ts:1163-1171` 同源语义）；opencode V2 runner 对 `ses_` 前缀的剥离（`core/src/session/runner/llm.ts:204-207`）在 crish 语境下**不剥**——crish 的 sessionId 形态由 session-loop 生成（`loop/mod.rs:87`），不做厂商侧前缀假设，直接整串入键；钳制按码点而非字节（对齐 pi，避免多字节 UTF-8 会话 ID 被截成半字符）。

#### 3.1.2 能力声明与推断（E 子主题的决策源）

```rust
/// 缓存机制分类（00-catalog 第 12.1 节 cache_type/cache_mechanism 的 Rust 形态）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheMechanism {
    /// 自动缓存（DeepSeek/Kimi/GLM 隐式/Gemini 隐式）：客户端零参数，只保前缀稳定
    Auto,
    /// Anthropic 式显式断点（官方 Anthropic / MiniMax M2.x / 百炼显式 / GLM 待实测）
    Explicit,
    /// OpenAI 系键路由（prompt_cache_key + retention；GPT-5.6+ 可叠加 options）
    Key,
    /// 不支持缓存（本地模型等）
    None,
}

/// 缓存能力声明（对齐 pi types.ts:621 的 supportsCacheControlOnTools 等模型开关）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheCapability {
    /// 机制分类（决定走哪条注入路径）
    pub mechanism: CacheMechanism,
    /// 是否支持块级/消息级 cache_control（Anthropic 系）
    pub supports_cache_control: bool,
    /// 工具定义上能否携带 cache_control（Fireworks 反例：拒绝未知字段，
    /// pi-cache-analysis.md:314；DeepSeek 忽略但强制省略）
    pub supports_cache_control_on_tools: bool,
    /// 断点预算上限（Anthropic/MiniMax/百炼 = 4）
    pub breakpoint_cap: usize,
    /// 可用的 TTL 桶（默认仅 5m；长档受 supports_long_retention 约束）
    pub ttl_buckets: &'static [CacheTtl],
    /// 是否发送 prompt_cache_key（OpenAI/Kimi/xAI/百炼 Responses）
    pub prompt_cache_key: bool,
    /// prompt_cache_retention 可用档（in_memory / 24h）
    pub retention: CacheRetention,
    /// 是否支持 GPT-5.6+ prompt_cache_options.mode（显式/隐式开关）
    pub supports_explicit_prompt_cache_mode: bool,
}

/// 断点层级分配的预算（对齐 opencode ANTHROPIC_BREAKPOINT_CAP=4，opencode-cache-analysis.md:96）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BreakpointPlan {
    /// 是否在 system 上打断点
    pub system: bool,
    /// 是否在最后一个工具上打断点
    pub tools: bool,
    /// 是否在最后一条 user/tool 消息末块打断点（工具循环内每轮请求锚点稳定）
    pub messages: bool,
}
```

推断函数（对齐 `infer_reasoning_vendor` / `MODEL_SERIES_CAPABILITIES` 同构，vendor.rs:219-310）：

```rust
/// 内置能力表：model 名前缀（不区分大小写）→ CacheCapability，最长前缀命中
/// 覆盖顺序参考 CACHE_CAPABILITY_TABLE 注释；未命中按 base_url 关键字二次推断
/// 【调度者裁决】本函数与 CACHE_CAPABILITY_TABLE 降级为"无 catalog 可用时的
/// 内置保守兜底默认"，仅由 build_cache_policy 内部兜底调用（engine.rs 不再直接调用），
/// 数据值以 P3 §3.2.2 矩阵为准转录
pub fn infer_cache_capability(base_url: Option<&str>, model: Option<&str>) -> CacheCapability;

/// 会话亲和头判定（x-grok-conv-id / x-session-id / session_id 等，pi-cache-analysis.md:141-143、
/// 181）——P2 只提供判定入口，默认全关（门控矩阵见 3.5）
pub fn affinity_header(capability: &CacheCapability, session_id: &str) -> Option<(&'static str, String)>;
```

> 【A3 审计修正】（2026-08-03，A3-executability.md P0-2）：**本模块与 P3 的运行时合并链裁决**——P3（models/behavior.rs）交付 `cache_behavior_for(catalog, vendor, model)`（静态矩阵 + catalog 模型级覆盖），并声明"矩阵表是 P2 的唯一接口面"。为避免双真源，裁决如下：**运行时唯一判定入口 = P3 的 `cache_behavior_for`**（engine.rs `request_options` 调它）；本模块的 `infer_cache_capability` + `CACHE_CAPABILITY_TABLE` 降级为"无 catalog 注入时的内置保守默认"（`cache_behavior_for` 内部兜底调用），**不再在 engine.rs 直接暴露**；`build_cache_policy` 的输入改为消费 P3 的 `CacheBehavior`（或 P3 将 `CacheBehavior` 序列化为本函数 `overrides` 接受的 JSON——二选一，实施任务书定稿前冻结）。本表数据值以 P3 §3.2.2 矩阵为准转录。P3 文档已同步修正。

> 【调度者裁决】（2026-08-03，A2 审计遗留项 P1-6 收敛；取代上方 A3 注记中"cache_behavior_for 为 engine.rs 唯一运行时判定入口"的表述，以及下方 §3.2 / 步骤 4 中 engine.rs 直接调用 `infer_cache_capability` 的写法）：
> 缓存能力判定的运行时入口收敛为：engine.rs 只调用 P2 的 build_cache_policy（唯一运行时判定/消费入口）；P3 models/ 层的 cache_behavior_for + CacheBehavior 矩阵（含 catalog 模型级覆盖）是唯一数据真源；P2 的 infer_cache_capability 与 CACHE_CAPABILITY_TABLE 降级为'无 catalog 可用时的内置保守兜底默认'，其数据值以 P3 矩阵为准转录；extra.cache 覆盖 JSON 的键名与 P3 的 CacheBehavior 结构字段对齐（或由 CacheBehavior 序列化得到）。

#### 3.1.3 断点预算分配与放置（A 子主题核心）

```rust
/// 断点预算常量（Anthropic 每请求最多 4 个显式断点，00-catalog 第 1.3 节）
pub const ANTHROPIC_BREAKPOINT_CAP: usize = 4;

/// 按失效层级分配：tools → system → messages（opencode anthropic-messages.ts:511-514）。
/// 工具在缓存层级最高处（调用方标记优先保留工具），超限先丢 messages 尾部，
/// 绝不报错（dropped 计数供日志与未来 P5 归因消费，P5 §3.4.3）。
pub fn allocate_breakpoints(
    cap: usize,
    has_tools: bool,
    has_system: bool,
    has_messages: bool,
    tools_ok: bool,      // supports_cache_control_on_tools
) -> BreakpointPlan {
    let mut plan = BreakpointPlan { system: false, tools: false, messages: false };
    let mut left = cap;
    if has_tools && tools_ok && left > 0 { plan.tools = true; left -= 1; }
    if has_system && left > 0 { plan.system = true; left -= 1; }
    if has_messages && left > 0 { plan.messages = true; left -= 1; }
    plan
}

/// 放置结果（供日志与未来 P5 归因，P5 §3.4.3 MissAttribution）
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BreakpointReport {
    pub placed: usize,
    pub dropped: usize,
}

/// 在 wire 消息序列上施加断点（A 子主题的注入执行面）
///
/// 锚点规则（对齐 pi 三锚点 anthropic-messages.ts:991-1000/1256-1278/1320、
/// Kimi 三锚点 kimi-code-cache-analysis.md:109-117）：
/// - system：第一条 role=system 消息（或 user-prefix 模式下的首条 user 消息），
///   文本内容改写为 parts 数组形态（string content 无法携带 cache_control，
///   pi-cache-analysis.md:139）；
/// - messages：最后一条 role=user 或 role=tool 消息的最后一个文本块（工具循环内
///   tool_result 承载历史缓存；OpenAI 兼容线路上 tool 结果落在 role=tool 消息）；
/// - 可缓存类型白名单：text 块（image/document/tool_result 等块类型随 wire 扩展）。
pub fn apply_cache_controls(
    messages: &mut [ChatMessage],
    plan: &BreakpointPlan,
    ttl: CacheTtl,
    supports_message_cache_control: bool,   // 部分兼容端点只认 content part 级
) -> BreakpointReport;
```

实现要点：

- `apply_cache_controls` 是**纯后处理 pass**，与 `to_chat_messages`（messages.rs:318-395）解耦——既有的 0 深拷贝映射保持纯函数，断点逻辑独立可测。
- 工具级注入不做进本函数：工具在 `build.rs` 序列化时按 `plan.tools` 在最后一个工具对象附加 `cache_control`（`to_openai_tool` 包装，见 3.2）。
- 消息级 `cache_control` 载体同时支持"顶层自动模式"（Anthropic 官方 Messages 端点 `cache_control` 挂在请求顶层 `{"type":"ephemeral"}`，00-catalog 第 1.3 节）——本计划提供字段与序列化，**默认走显式三锚点**；顶层自动模式作为 `supports_cache_control` 厂商的备选（留待原生 Messages 端点接线时启用）。

### 3.2 载体字段与序列化改动

#### `request/messages.rs`

```rust
/// 多模态 content part（对齐 ChatContentPart：text / image_url / 可选 cache_control）
#[derive(Debug, Clone, PartialEq)]
pub enum ChatContentPart {
    Text {
        text: String,
        /// Anthropic 系块级断点标记（仅 Some 时序列化）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheControl>,
    },
    ImageUrl { url: String, detail: Option<String> },
}

/// wire 消息（对齐 ChatMessage）——新增消息级断点载体（原生 Messages 端点用）
#[derive(Debug, Clone, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub content: Option<ChatContent>,
    pub tool_call_id: Option<String>,
    pub reasoning_content: Option<String>,
    pub tool_calls: Vec<Value>,
    /// 消息级 cache_control（Anthropic 原生端点；chat-completions 兼容端点用 part 级）
    pub cache_control: Option<CacheControl>,
}

impl ChatContentPart {
    /// 文本 part 挂断点（供 apply_cache_controls 改写；返回自身或新 part）
    pub fn with_cache_control(self, cc: CacheControl) -> Self { ... }
}

/// 文本消息 → parts 数组形态（对齐 pi：string content 无法挂 cache_control 时改写，
/// pi-cache-analysis.md:139；kimi-code-cache-analysis.md:113-117）
pub fn text_to_parts_with_cc(text: &str, cc: CacheControl) -> ChatContent { ... }
```

兼容性约束（必须守住）：

- `ChatContentPart::Text` 增加字段后，`to_value`（messages.rs:46-58）仅在 `cache_control` 为 Some 时输出 `"cache_control"` 键；既有测试的相等断言需同步构造（机械修改）。
- `ChatMessage` 同理：`to_value`（messages.rs:76-103）仅在 Some 时输出。
- 现有 `ChatMessage` 构造点共 5 处（messages.rs:336-342、368-378、384-390、400-413），新增字段后需在构造处补 `cache_control: None`；或为 `ChatMessage` 提供 `Default` 派生减轻改动面（评审时二选一，倾向后者）。

#### `request/build.rs`

```rust
/// chat-completions 请求构建选项（新增缓存字段，None 一律省略）
pub struct ChatCompletionsRequestOptions {
    // ……既有字段……
    /// 统一缓存策略（None = 完全不参与缓存；DeepSeek 等自动缓存厂商由能力表归 None）
    pub cache: Option<CachePolicy>,
}

/// 协议无关的缓存策略（单一决策输入，P3 开关数据覆盖此结构）
#[derive(Debug, Clone, PartialEq)]
pub struct CachePolicy {
    pub retention: CacheRetention,
    /// 显式断点放置计划（Anthropic 系与 OpenAI 5.6+ 显式断点共用）
    pub breakpoints: Option<BreakpointPlan>,
    /// OpenAI 系缓存键（由会话 ID 派生并钳 64；厂商能力表决定是否发送）
    pub cache_key: Option<CacheKey>,
    /// GPT-5.6+ prompt_cache_options.mode（None = 不发 options 字段）
    pub prompt_cache_options: Option<PromptCacheOptions>,
}

/// GPT-5.6+ 显式/隐式模式（00-catalog 第 2.1 节）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptCacheMode { Implicit, Explicit }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptCacheOptions { pub mode: PromptCacheMode }
```

`build_chat_completions_request_body`（build.rs:102-177）的注入逻辑（在既有字段后追加）：

```rust
// 缓存顶层字段（compactObject：None 一律省略）
if let Some(policy) = &opts.cache {
    if let Some(key) = &policy.cache_key { body.insert("prompt_cache_key", json!(key.0)); }
    if let Some(retention) = retention_wire_value(&policy.retention) {
        body.insert("prompt_cache_retention", json!(retention));
    }
    if let Some(options) = &policy.prompt_cache_options {
        body.insert("prompt_cache_options", json!({ "mode": options.mode.as_str() }));
    }
}
// messages 级断点：先映射，后 post-pass 施加（保持 to_chat_messages 纯函数）
let mut wire = to_chat_messages(...);
if let Some(plan) = policy.breakpoints {
    report = apply_cache_controls(&mut wire, &plan, ttl, ...);
}
// tools 级断点：序列化时按 plan.tools 在最后工具附加 cache_control
let tools_json: Vec<Value> = context.tools.iter().enumerate()
    .map(|(i, tool)| to_cache_aware_tool(tool, plan.map(|p| p.tools && i == len-1)))
    .collect();
```

`retention_wire_value`（OpenAI 官方值域，00-catalog 第 2.1 节）：Short → `"in_memory"`、Long → `"24h"`（受 `supports_long_retention` 约束）、None → 不发。

#### `session-loop` 契约面（`provider.rs` / `stream.rs`）

```rust
/// provider 调用请求——新增会话 ID 透传（prompt_cache_key 的键来源）
pub struct ProviderRequest<'a> {
    pub messages: &'a [Arc<AgentMessage>],
    pub tools: Vec<ToolSchema>,
    pub max_tokens: Option<u32>,
    /// 会话 ID（engine.rs 适配层据此派生 prompt_cache_key；None = 不派生）
    pub session_id: Option<String>,
}
```

> 补充说明：`ProviderRequest` 冻结于 PE-02 §3.1 的 v1 契约，本计划新增字段属**契约扩展**（默认值 None 保持既有调用兼容），需在 P2 实施时走 PE-02/PE-09 的接口变更登记（见 6.2 风险）。`stream.rs` 的 `ConsumeBuilder` 增加 `usage_accounting` 提示（见 3.4）。

#### `engine.rs` 接线（唯一真实调用面）

```rust
// request_options（engine.rs:207-215）扩展：
fn request_options(&self, request: &ProviderRequest<'_>) -> ChatCompletionsRequestOptions {
    // 【调度者裁决】engine.rs 只调用 build_cache_policy（唯一运行时判定/消费入口）；
    // 能力判定收敛在其内部：数据真源 = P3 cache_behavior_for（矩阵 + catalog 模型级覆盖），
    // 无 catalog 可用时回退内置保守兜底默认（infer_cache_capability，数据值以 P3 矩阵为准转录）
    let cache = build_cache_policy(Some(&self.catalog),           // P3 ModelCatalog（无 → None）
                                   self.config.base_url.as_deref(),
                                   Some(&self.config.model),
                                   request.session_id.as_deref(),
                                   self.config.extra.get("cache"));  // P3 开关数据入口
    ChatCompletionsRequestOptions { cache, /* ……既有字段…… */ }
}
```

`build_cache_policy`（cache.rs 内的纯函数，也是"能力判定 + 门控矩阵 → 参数"的唯一运行时判定/消费入口；engine.rs 只调用本函数）：

```rust
pub fn build_cache_policy(catalog: Option<&ModelCatalog>, base_url: Option<&str>, model: Option<&str>,
                          session_id: Option<&str>, overrides: Option<&Value>) -> Option<CachePolicy> {
    // 0. 能力判定：catalog 可用 → 数据真源 cache_behavior_for(catalog, vendor, model) 得 CacheBehavior；
    //    无 catalog 可用 → infer_cache_capability(base_url, model) 内置保守兜底（数据值以 P3 矩阵为准转录）
    // 1. extra.cache.enabled == false / retention == "none" → None（摘要请求同款）
    // 2. mechanism == Auto（DeepSeek/Kimi/GLM 隐式）→ 除 retention=Short 外零参数
    //    （DeepSeek 不发送 prompt_cache_key：00-catalog 第 3.2 节"静默忽略"，P2 仍省略）
    // 3. mechanism == Explicit（Anthropic/MiniMax M2.x/百炼显式）→
    //    breakpoints = Some(allocate_breakpoints(...))，TTL 桶按 retention 选 5m/1h
    // 4. mechanism == Key（OpenAI/Kimi/xAI）→
    //    cache_key = CacheKey::from_session_id(session_id)?，retention 按档
    // 5. GPT-5.6+ 且 retention==None → prompt_cache_options = Explicit（"none 也须被尊重"，
    //    pi openai-responses.ts:278-285）
}
```

### 3.3 各子主题的协议注入细则

#### A. Anthropic 系 `cache_control` 断点

| 项              | 设计                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 载体            | part 级（`ChatContentPart::Text.cache_control`，chat-completions 兼容端点与原生端点均用）+ 消息级（`ChatMessage.cache_control`，原生端点）/ 工具级（序列化时附加）/ system（文本改写为 parts）                                 |
| 放置条件        | `supports_cache_control` 为真、`retention != None`、对应锚点存在（有 system / 有 tools / 有 messages）                                                                                                                         |
| 预算            | 4 断点上限（常量 `ANTHROPIC_BREAKPOINT_CAP`），分配层级 tools→system→messages，超限丢 messages 尾部、`dropped` 计数不报错（opencode-cache-analysis.md:92-99 同款"记账 + 降级日志"）                                            |
| TTL 桶          | 默认 5m（`{"type":"ephemeral"}`）；长档 1h（`ttl:"1h"`，写价 2x）仅 `retention=Long` 且 `supports_long_retention` 时启用；**同请求不混用 5m/1h 桶**（00-catalog 第 1.3 节"1h 条目必须位于 5m 条目之前"，统一桶规避排序问题）   |
| 模型开关        | `supports_cache_control_on_tools`：工具数组末尾工具的 cache_control 仅在此开关为真时附加（Fireworks 反例；pi-cache-analysis.md:314）                                                                                           |
| DeepSeek 分支   | vendor=deepseek / base_url 含 deepseek → `mechanism=Auto` → **整个 cache 参数组不出现**（DeepSeek 自动缓存 + 忽略 cache_control，比较文档 2.4 与 00-catalog 3.2；用测试钉死省略行为）                                          |
| MiniMax 分支    | model 前缀 `minimax-m2` → 主动缓存可开（`mechanism=Explicit`）；`minimax-m3` → 仅被动（`mechanism=Auto`，00-catalog 第 7.2 节"M3 不支持主动缓存"）；MiniMax 断点语义"超出只取从后往前最近 4 个"与 Anthropic 相同，预算逻辑复用 |
| 未知/未实测厂商 | GLM z.ai Anthropic 端点（00-catalog 第 4.2 节"是否处理 cache_control 未确认"）→ 默认 `mechanism=Auto`，由 P3 数据/实测后翻转                                                                                                   |

#### B. OpenAI 系 `prompt_cache_key` / retention / GPT-5.6+ options

| 项            | 设计                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 键来源        | `CacheKey::from_session_id`（码点钳 64）；`session_id` 经 `ProviderRequest.session_id` 透传；会话内所有请求共享同键（同轮工具循环 + 跨轮）                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 键门控        | `prompt_cache_key` 为真的厂商发送；DeepSeek 明确不发（00-catalog 3.2）；官方 OpenAI（api.openai.com）非 none 即发（pi-cache-analysis.md:160-171）                                                                                                                                                                                                                                                                                                                                                                                                                   |
| retention     | Short → `"in_memory"`；Long → `"24h"`（仅 `supports_long_retention`）；None → 不发。GPT-5.6+ 的 TTL 只支持 30m（00-catalog 2.1）——本计划按厂商能力表收敛为"官方 OpenAI 5.6+ 不发 retention"（用 `prompt_cache_key` 即可获得可靠匹配）                                                                                                                                                                                                                                                                                                                               |
| GPT-5.6+ mode | 一期：`prompt_cache_options` 只在"明确不缓存"时发 `{"mode":"explicit"}`（pi 语义：none 档必须被协议级尊重）；其余不发（默认 implicit）。**显式断点（`prompt_cache_breakpoint`）一期不做**：见下方裁决                                                                                                                                                                                                                                                                                                                                                               |
| 显式断点裁决  | **统一策略源**：若二期做 OpenAI 显式断点，直接复用 `allocate_breakpoints` 产出的同一 `BreakpointPlan`，翻译为 `prompt_cache_breakpoint`（Chat Completions：text/image_url 块；Responses：input_text/input_image/input_file 块，00-catalog 2.1）并配套 `mode:"explicit"`。**一期关闭**的理由：①GPT-5.6+ 断点行为（implicit 不回退找最长前缀）与旧模型差异大，前缀漂移风险高；②写价 1.25x + TTL 仅 30m，工具循环场景收益不确定；③P1 前缀稳定未落地前，显式断点无命中对象。留 `PromptCacheMode::Explicit` 与翻译函数签名的挂点（P2 交付代码框架 + 单元测试，不发请求） |
| Responses     | `store: false` 与 `prompt_cache_key` 一并注入（pi openai-responses.ts:287 对齐）；Responses 的 usage 解析复用 chat 的 `parse_usage`（现状即如此，D 节补齐后自动生效）                                                                                                                                                                                                                                                                                                                                                                                               |

#### C. Gemini：隐式缓存适配 + explicit cachedContents 评估

| 项                      | 设计                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 隐式路径                | 无请求侧参数（Gemini 隐式缓存默认启用，00-catalog 8.2）；**前缀稳定由 P1 负责**——P2 只保证 usage 侧 `total_cached_tokens` 别名解析（见 3.4），命中率观测归 P5（【A1 审计修正】原稿"归 P4"归属错误，测量层=P5）                                                                                                                                                                                                                                                                                                                                                          |
| explicit cachedContents | **一期不做**。评估结论：①需管理 cachedContent 生命周期（create/list/update/delete + TTL + 存储费按 token×小时计费，00-catalog 8.2/13-3），桌面单机会话形态下收益不确定；②`cachedContent: <name>` 注入使请求依赖外部状态，任何会话历史变化即失效；③Gemini 隐式最低 4096 tokens 已覆盖长会话场景；④Kimi Code 也明确不实现客户端 cachedContent（kimi-code-cache-analysis.md:299）。**二期可选**：`GeminiCachedContentManager`（crates/agent-provider 内独立模块），请求体 `generateContent` 构建处预留 `cached_content: Option<String>` 注入位（本计划仅记录挂点，不实现） |
| 挂点记录                | `request/build.rs` 若未来新增 `build_gemini_request_body`，缓存参数面仅 `cached_content` 一个字段；`parse/gemini.rs` 的 `cachedContentTokenCount` 解析已就绪（gemini.rs:316-317），补别名即可闭环                                                                                                                                                                                                                                                                                                                                                                       |

#### D. usage 归一化补全

**统一不变量**（LiteLLM 双命名空间 + 不变量，litellm-cache-analysis.md:23、306-334；opencode 恒等式，opencode-cache-analysis.md:193-205）：

```
input_total = miss + hit + write          // 归一化后的统一口径（所有协议族）
OpenAI 系（chat/responses）：prompt_tokens 已含缓存 → miss = prompt - hit - write，input_total = prompt
Anthropic 系（Messages）：input_tokens 不含缓存 → miss = input_tokens，input_total = input + hit + write
Gemini：promptTokenCount 不含缓存（cachedContentTokenCount 单独报告）→ 同 Anthropic 系
```

**hit 字段优先级链**（单链，`parse_usage` 与 `parse_anthropic_usage` 各自实现）：

```
prompt_cache_hit_tokens（DeepSeek 顶层）→ cached_tokens（OpenAI/Kimi 顶层与 details）
→ cache_read_input_tokens（Anthropic 系）
→ cachedContentTokenCount ?? total_cached_tokens（Gemini）
```

**write 字段别名链**：

```
cache_write_tokens（OpenAI/OpenRouter 系）→ cache_creation_tokens（OpenAI 兼容变体）
→ cache_creation_input_tokens（Anthropic 系）
→ prompt_tokens_details.cache_creation_input_tokens（百炼，00-catalog 11.2）
```

`parse_usage`（chat.rs:251-267）补全后的关键段落：

```rust
pub fn parse_usage(raw: Option<&Value>) -> Option<ProviderUsage> {
    let usage = raw?.as_object()?;
    let prompt_details = nested_details(usage, &["prompt_tokens_details", "input_tokens_details"]);
    let completion_details = nested_details(usage, &["completion_tokens_details", "output_tokens_details"]);
    // hit 链：顶层 prompt_cache_hit_tokens（DeepSeek）→ details.cached_tokens
    // （OpenAI/Responses）→ 顶层 cached_tokens（Kimi）——顺序与 P6 R4、TS 降级路径
    // directFetchBridge.ts:272-275 一致（【A1 审计修正】原稿代码片段把 details
    // 排在顶层 hit 之前，与本方案文字链及 P6 R4 冲突，已修正为顶层优先）
    let cache_read = finite_u64(usage.get("prompt_cache_hit_tokens"))
        .or_else(|| details_cached(prompt_details))
        .or_else(|| finite_u64(usage.get("cached_tokens")));
    // write 链：details.cache_write_tokens → details.cache_creation_tokens →
    // 顶层 cache_write_tokens / cache_creation_tokens → details.cache_creation_input_tokens
    let cache_write = details_alias(prompt_details, &["cache_write_tokens", "cache_creation_tokens",
                                                    "cache_creation_input_tokens"])
        .or_else(|| finite_u64(usage.get("cache_write_tokens")))
        .or_else(|| finite_u64(usage.get("cache_creation_tokens")));
    Some(ProviderUsage {
        prompt_tokens: ..., completion_tokens: ..., total_tokens: ...,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        // DeepSeek 顶层 prompt_cache_miss_tokens：唯一"直接报告 miss"的字段，落入统一契约
        cache_miss_tokens: finite_u64(usage.get("prompt_cache_miss_tokens")),
        reasoning_tokens: ...,
    })
}
```

`events.rs` 增补：

```rust
/// 用量统计（对齐 shared:tool.ts 的 ProviderUsage；新增 cacheMissTokens 需与 TS 侧同步）
pub struct ProviderUsage {
    // ……既有六字段……
    /// 缓存未命中输入（DeepSeek 顶层 prompt_cache_miss_tokens；其余协议族推导）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_miss_tokens: Option<u64>,
}

/// 协议族口径标记（LiteLLM 双命名空间：prompt 是否已含缓存）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheAccounting {
    /// OpenAI 系：prompt 已含缓存
    Included,
    /// Anthropic/Gemini 系：prompt 不含缓存
    Excluded,
}

/// 归一化派生（唯一口径入口，P5 测量/成本直接消费）【A2 审计修正：原"P4 测量/成本"为陈旧编号，测量层=P5】
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CacheBreakdown {
    pub read: u64,
    pub write: u64,
    /// 未缓存输入（= 计费输入；DeepSeek 顶层 miss 存在时优先）
    pub miss: u64,
    /// 归一化后的输入总量 = miss + read + write
    pub input_total: u64,
}

impl ProviderUsage {
    pub fn cache_breakdown(&self, accounting: CacheAccounting) -> Option<CacheBreakdown> {
        let read = self.cache_read_tokens.unwrap_or(0);
        let write = self.cache_write_tokens.unwrap_or(0);
        let prompt = self.prompt_tokens?;
        let miss = self.cache_miss_tokens.unwrap_or_else(|| match accounting {
            CacheAccounting::Included => prompt.saturating_sub(read + write),
            CacheAccounting::Excluded => prompt,
        });
        let input_total = match accounting {
            CacheAccounting::Included => prompt,
            CacheAccounting::Excluded => prompt + read + write,
        };
        Some(CacheBreakdown { read, write, miss, input_total })
    }
}
```

**分片流式合并的 max 语义**（02 §六.6 的延续裁决）：

- 现状：chat/responses 是**覆盖式**（快照式 usage 后帧覆盖前帧，chat.rs:85-88 注释"覆盖式"）——OpenAI 流只在末帧带完整 usage，覆盖语义正确，**保持不变**。
- anthropic/gemini 是**分片合并**（anthropic.rs:345-372、gemini.rs:351-380，next 显式字段优先）。**裁决：输入侧三字段（prompt/cacheRead/cacheWrite）在分片间出现时取 max 而非覆盖**——防代理用 0/部分值覆盖 message_start 的完整 input（pi anthropic-messages.ts:716-739 只覆盖非 null 字段的同类防御）；total 恒由最终合并结果重算（现有逻辑已如此）。`merge_anthropic_usage` / `merge_gemini_usage` 的合并函数收敛为共享 helper：

```rust
/// 分片合并的 max 语义（仅输入侧字段；completion 侧维持"后到优先 + total 重算"）
pub fn merge_usage_shards(prev: &ProviderUsage, next: &ProviderUsage) -> ProviderUsage {
    // prompt/cache_read/cache_write：next 存在且 > prev 时取 next（防 0 覆盖）
    // completion：next 存在时取 next
    // total：prompt/completion 任一存在时重算，否则回退显式 total
}
```

**事件/遥测输出字段**：

- `ProviderStreamEvent::Stop.usage` 透传 `ProviderUsage`（现状即有，不动 wire 形状）。
- 消息元数据（session-loop stream.rs build_assistant_message 的 metadata.usage）在 D 落地后增加 `cacheBreakdown`（camelCase）派生块，由 `ConsumeBuilder` 新增的 `usage_accounting` 提示计算；`CacheAccounting` 的默认值 = `Included`（chat-completions 主路径），anthropic/gemini 解析路径由适配层显式传 `Excluded`。
- 前端 `shared:tool.ts` 的 ProviderUsage 镜像需同步新增 `cacheMissTokens`（缺失为 undefined，兼容既有消息）；本计划给出字段契约，前端改动可随 P5 展示一并落地（P2 不阻塞，序列化默认省略 None）。【A1 审计修正】原稿"随 P4 展示"归属错误（P4 不做展示，展示=P5 S6/S7）。

### 3.4 厂商门控矩阵（E 子主题）

**数据表**（【调度者裁决】P2 内置保守兜底默认表：供 `infer_cache_capability` 在无 catalog 可用时兜底，数据值以 P3 §3.2.2 矩阵为准转录；P3 `cache_behavior_for` + `CacheBehavior` 矩阵是唯一数据真源，P3 负责以模型目录/配置覆盖）：

| 厂商/协议族                    | 判定依据（base_url 关键字 / model 前缀）                | 机制                                   | 块级 cache_control    | 工具级 cache_control  | 断点预算                        | TTL 桶      | prompt_cache_key                                                                                                                                                       | retention                    | GPT-5.6+ options         | 会话亲和头                  |
| ------------------------------ | ------------------------------------------------------- | -------------------------------------- | --------------------- | --------------------- | ------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------ | --------------------------- |
| Anthropic 官方（Messages）     | url 含 anthropic / model 以 claude 开头                 | Explicit                               | ✅                    | ✅（claude 系全支持） | 4                               | 5m/1h       | ❌（可用 metadata.user_id，二期）                                                                                                                                      | —                            | —                        | ❌                          |
| DeepSeek                       | url 含 deepseek / model 以 deepseek 开头                | Auto                                   | ❌ **强制省略**       | ❌                    | 0                               | —           | ❌（官方不支持，静默忽略也发不得）                                                                                                                                     | ❌                           | ❌                       | ❌                          |
| MiniMax M2.x（Anthropic 兼容） | model 以 minimax-m2 开头                                | Explicit                               | ✅                    | ✅                    | 4（超出只取后 4，同 Anthropic） | 5m          | ❌                                                                                                                                                                     | —                            | —                        | ❌                          |
| MiniMax M3                     | model 以 minimax-m3 开头                                | Auto                                   | ❌（不支持主动缓存）  | ❌                    | 0                               | —           | ❌                                                                                                                                                                     | —                            | —                        | ❌                          |
| OpenAI 官方（Chat/Responses）  | url 含 openai / model 以 gpt/o1/o3/o4 开头              | Key                                    | 二期（5.6+ 显式断点） | 二期                  | （4 上限，implicit 占 1）       | 5.6+ 仅 30m | ✅ sessionId→64                                                                                                                                                        | in_memory / 24h（5.6+ 不发） | 二期；none 档发 explicit | ❌                          |
| Kimi                           | model 以 kimi 开头                                      | Auto（缓存键辅助）                     | ❌（纯自动）          | ❌                    | 0                               | —           | ✅ sessionId→64                                                                                                                                                        | —                            | —                        | ❌                          |
| GLM z.ai / 百炼                | model 以 glm 开头                                       | Auto（默认，Anthropic 端点行为未实测） | 待实测（默认关）      | 待实测                | （4）                           | 5m          | 待实测（00-catalog §4/§11 未确认百炼 OpenAI 兼容端点的 key 语义，保守按 ❌，与 P3 矩阵一致【A1 审计修正】原稿"✅（百炼 OpenAI 兼容）"无 catalog 依据且与 P3 矩阵冲突） | —                            | ❌                       | ❌                          |
| Gemini                         | url 含 generativelanguage/gemini / model 以 gemini 开头 | Auto                                   | ❌                    | ❌                    | 0                               | —           | ❌（不适用）                                                                                                                                                           | —                            | —                        | ❌                          |
| xAI Grok                       | model 以 grok 开头                                      | Key                                    | ❌                    | ❌                    | 0                               | —           | ✅（Responses）                                                                                                                                                        | —                            | —                        | ✅ x-grok-conv-id（默认关） |
| 未知/本地（Ollama 等）         | 未命中                                                  | None                                   | ❌                    | ❌                    | 0                               | —           | ❌                                                                                                                                                                     | ❌                           | ❌                       | ❌                          |

**存放位置建议**：

1. **内置默认表**：`crates/agent-provider/src/request/cache.rs` 的 `CACHE_CAPABILITY_TABLE: &[(&str, CacheCapability)]`（model 前缀）+ `infer_cache_capability`（base_url 关键字优先，与 `infer_reasoning_vendor` 的判定顺序完全同构，vendor.rs:277-310）。
2. **每请求覆盖**：`build_cache_policy` 的 `overrides: Option<&Value>` 读 `ProviderConfig.extra.cache`（config.rs:108-110 的透传通道，`{ "enabled": bool, "retention": "short"|"long"|"none", "breakpoints": bool, "cacheKey": bool }`）——**P3 的开关数据最终落在这一层**，P2 只定义键名与语义。【调度者裁决】覆盖 JSON 的键名与 P3 `CacheBehavior` 结构字段对齐（或由 `CacheBehavior` 序列化得到）。
3. **不落入**：`endpoint` 枚举（不加 MiniMax 等新端点）、`ReasoningVendor`（不扩变体）——缓存能力独立于推理能力推断，避免两套枚举互相污染。

---

## 4. 实施步骤

按"可独立交付"排序（D → A 载体 → E 门控 → B 键路由 → 接线）：

### 步骤 1（D 子主题，零依赖、先行）

- `events.rs`：`ProviderUsage` 增 `cache_miss_tokens`；新增 `CacheAccounting` / `CacheBreakdown` / `cache_breakdown` / `merge_usage_shards`（含测试：两种口径、miss 优先值、max 合并、total 重算）。
- `parse/chat.rs` `parse_usage`：补 hit 链（顶层 `prompt_cache_hit_tokens`、顶层 `cached_tokens`）与 write 链（details 三别名 + 顶层两别名）与 `prompt_cache_miss_tokens`；补测试用例（DeepSeek 顶层形状、Kimi 顶层形状、OpenAI details 形状各一）。
- `parse/gemini.rs` `parse_gemini_usage`：补 `total_cached_tokens` / `total_cached_tokens` 别名（camel/snake 双形），回退于 `cachedContentTokenCount` 之后。
- `parse/anthropic.rs`：`parse_anthropic_usage` 的合并收敛到 `merge_usage_shards`（行为等价改造，既有测试全绿为验收）。
- 文件域：`events.rs` / `parse/chat.rs` / `parse/gemini.rs` / `parse/anthropic.rs`（与 P3 无冲突；`responses.rs` 复用 `parse_usage` 自动受益）。

### 步骤 2（A 子主题：载体 + 预算 + 放置）

- 新建 `request/cache.rs`：`CacheRetention` / `CacheTtl` / `CacheControl` / `CacheKey` / `CachePolicy` / `PromptCacheMode` / `PromptCacheOptions` / `BreakpointPlan` / `BreakpointReport` / `allocate_breakpoints` / `apply_cache_controls` / `text_to_parts_with_cc` / `build_cache_policy`（含测试：预算分配四象限、超限丢尾、string→parts 改写、锚点定位、DeepSeek 省略）。
- `request/messages.rs`：`ChatContentPart::Text` 与 `ChatMessage` 增 `cache_control` 字段 + 序列化（Some 才输出）+ 构造点补齐。
- 文件域：`request/cache.rs`（新）/ `request/messages.rs`（【A1 审计修正】原稿"与 P1 的 tools 排序改动面不同文件"判断有误：P1 在 messages.rs 的改动面是 C2/C3 消息构造确定性（messages.rs:335-360 的 id 消毒/arguments 规范化、:298-308 的 reasoning Require 落地），与 P2 的载体字段（ChatContentPart::Text / ChatMessage 增 `cache_control`）**同文件**；P3 步骤 4 也接线 messages.rs 的 Require 语义——三方串行（P1 → P2 → P3），构造点补齐与 Require 改动合并时注意冲突；`to_chat_messages` 签名不动）。

### 步骤 3（B 子主题 + E 门控）

- `request/build.rs`：`ChatCompletionsRequestOptions.cache` + `build_chat_completions_request_body` 注入（body 顶层三字段 + messages post-pass + tools 附加）；`CACHE_CAPABILITY_TABLE` 与 `infer_cache_capability`。
- 文件域：`request/build.rs` / `request/tools.rs`（仅加 `to_cache_aware_tool` 纯函数）。

### 步骤 4（契约面 + 接线）

- `session-loop/src/provider.rs`：`ProviderRequest` 增 `session_id: Option<String>`（走接口变更登记，见 6.2）。【A1 审计修正】与 P1 步骤 2.2 的 `ProviderRequest.system_prompt`（provider.rs:74-81 同 struct）重叠——两字段建议与 P1 合并一次提交（P1 先行），避免同一 struct 两次契约变更登记。`session-loop/src/stream.rs`：`ConsumeBuilder` 增 `usage_accounting` 提示与 metadata `cacheBreakdown` 派生。
- `apps/agent-workbench/src-tauri/src/engine.rs`：`request_options` 组装 `cache`（【调度者裁决】仅调用 `build_cache_policy`，能力判定收敛在其内部：P3 `cache_behavior_for` 数据真源，无 catalog 时回退 `infer_cache_capability` 内置保守兜底）；`stream()` 中把 `AgentSessionContext.session_id` 注入 `ProviderRequest.session_id`。
- 文件域：`session-loop/src/provider.rs` / `session-loop/src/stream.rs` / `engine.rs`（`engine.rs` 与 P1 的 system_prompt 透传同文件，**与 P1 串行，P1 先行**；`session-loop/src/provider.rs` 与 P1 步骤 2.2 同文件——P1 加 `system_prompt`、P2 加 `session_id`，**同样串行，P1 先行**）。

### 步骤 5（收尾）

- 全量回归（见第 5 节）；`docs/cache-optimization/02-comparison/comparison.md` 的相关维度标记"已落地"（第 2.4/2.5/2.6/2.7 节）；P5 计划引用 `CacheBreakdown` 为消费契约（【A2 审计修正：原"P4 计划引用"为陈旧编号，消费 `CacheBreakdown` 的是 P5 测量层）。

---

## 5. 验收标准

### 5.1 新增单元测试（必须全绿）

| 测试组                      | 关键断言                                                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allocate_breakpoints`      | 有 tools+system+messages → (true,true,true)；tools_ok=false → tools 不占预算；cap=1 只保 tools；超限不 panic、dropped 计数正确                                                         |
| `apply_cache_controls`      | 三锚点落位：首条 system、最后 user/tool 消息末块；string content 被改写为 parts 形态且只发生在被打断点处；plan 全 false → 请求字节与未施加时完全一致                                   |
| DeepSeek 省略               | vendor=deepseek → `build_cache_policy` 返回 None（或全字段 None），请求体不含任何 cache 键（对齐 deepseek-reasonix-cache-analysis.md:111-112 的"测试钉死省略"）                        |
| `CacheKey::from_session_id` | 中文/emoji 会话 ID 按码点钳 64 不截半字符；空串 → None                                                                                                                                 |
| `parse_usage` 补全          | DeepSeek 顶层 `{prompt_cache_hit_tokens, prompt_cache_miss_tokens}`；Kimi 顶层 `{cached_tokens}`；OpenAI `{prompt_tokens_details: {cached_tokens, cache_write_tokens}}` 各形状归一正确 |
| `merge_usage_shards`        | 输入侧 max 语义：next 传 0 不覆盖 prev 的 100；completion 后到优先；total 重算                                                                                                         |
| `cache_breakdown`           | Included：miss = prompt - read - write；Excluded：miss = prompt、input_total = prompt + read + write；DeepSeek miss 字段优先                                                           |

### 5.2 回归命令

```powershell
# Rust 全量（基线 73 套件，agent-provider 全量含新增用例）
cargo test --workspace

# 仅 agent-provider（快速迭代用）
cargo test -p agent-provider

# 前端类型检查与单测（shared:tool.ts 增补 cacheMissTokens 后）
npm run typecheck
npx vitest run src
```

### 5.3 行为验收（手动/录制级）

- 配置 DeepSeek 厂商跑一轮：请求体 `messages`/`tools` 无任何 cache 键；usage 落库含 `cacheReadTokens`（顶层 hit 字段解析生效）。
- 配置 MiniMax M2.x（Anthropic 兼容端点）跑一轮：请求体最后工具与最后 user 消息末块携带 `cache_control: {"type":"ephemeral"}`，总数 ≤ 4。
- 无缓存配置（默认）：请求字节与 P2 前逐字节一致（compactObject 兜底）。

---

## 6. 风险与依赖

### 6.1 依赖

| 依赖                      | 说明                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P1 前缀稳定（硬依赖）** | 断点/键注入是"命中手段"而非"命中保证"：tools 排序、system prompt 透传、历史回流未落地前，注入的断点无命中对象，`cache_read_tokens` 恒为 0。P2 交付框架后可先行验证"请求字节正确性"，收益验证在 P1 之后 |
| PE-02/PE-09 接口冻结      | `ProviderRequest` 增字段属契约扩展（默认 None 兼容），需按 AU-04 F1 流程登记                                                                                                                           |
| 前端 `shared:tool.ts`     | `cacheMissTokens` 字段镜像同步（缺失不阻塞，P2 序列化默认省略）                                                                                                                                        |

### 6.2 风险

| 风险                                                                                                                                                      | 等级 | 缓解                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MiniMax/GLM/百炼的 Anthropic 兼容端点对 `cache_control` 位置/字段的接受度未实测（00-catalog 4.2/11.1"tools 数组中的 cache_control 标记被忽略"等平台差异） | 中   | 默认保守：GLM 默认 Auto；MiniMax 按型号前缀精准开；注入位置（part 级 vs 消息级 vs 工具级）按能力表逐厂商收敛；P3 实测数据翻转                                                                                                                                                                                                                      |
| Anthropic 断点上限冲突（超出 4 返回 400）                                                                                                                 | 低   | `allocate_breakpoints` 内置 cap，超限丢尾不报错（opencode 同款）；单元测试钉死                                                                                                                                                                                                                                                                     |
| 1h 与 5m TTL 桶混用违反"1h 条目必须位于 5m 条目之前"（00-catalog 1.3）                                                                                    | 低   | 同请求统一 TTL 桶；`CachePolicy` 只持单一 `CacheTtl`                                                                                                                                                                                                                                                                                               |
| usage 口径误判（Included/Excluded 反了）导致 miss 虚高/成本失真                                                                                           | 中   | `CacheAccounting` 默认 Included（主路径 chat-completions）；anthropic/gemini 路径由适配层显式传 Excluded；`parse_usage` 顶层 miss 字段优先直接取服务端报告值，不依赖推导                                                                                                                                                                           |
| 写入费用高于折扣（Anthropic 1.25x/2x、GPT-5.6+ 1.25x）                                                                                                    | 中   | 默认 retention=Short（5m 桶、无额外 1h 写价）；长档显式开启；显式断点默认关闭                                                                                                                                                                                                                                                                      |
| 与 P1/P3 同文件冲突                                                                                                                                       | 中   | `engine.rs` 与 P1 串行（P1 先行）；`messages.rs` 与 P1 阶段 3 串行（P1 先行，改动面 C2/C3 与 P2 载体同文件，见步骤 2 文件域注）；`provider.rs` 的 `ProviderRequest` 与 P1 步骤 2.2 同 struct（两字段一次合并）；P3 只消费 `extra.cache` 数据层，不改 cache.rs 的 API【A1 审计修正：原稿仅登记 engine.rs 一处串行，已补 messages.rs / provider.rs】 |

### 6.3 与 P3 的边界（明确切分）

- **P2 负责**：注入与解析的**框架本身**——载体结构、预算分配、锚点放置、键派生、usage 归一化函数、内置默认能力表（保守值）。
- **P3 负责**：按厂商/模型的**开关与数据**——模型目录（`supports_cache_control` / `prompt_cache_min_tokens` / 断点上限等，00-vendor-model-pricing-catalog.md 第 12.1 节草案）、配置 UI、实测校准、`extra.cache` 覆盖值的真源。
- **契约面**：【调度者裁决】数据真源 = P3 `cache_behavior_for` + `CacheBehavior` 矩阵（含 catalog 模型级覆盖），由 P2 `build_cache_policy` 内部消费（engine.rs 只调 `build_cache_policy`，唯一运行时判定/消费入口）；`extra.cache` 覆盖经 `build_cache_policy` 的 `overrides` 通道生效（键名与 `CacheBehavior` 字段对齐）。P3 不得改写 `parse/*` 的归一化逻辑（口径唯一）。

---

## 附：证据文件索引

| 主题                          | 位置                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 现状缺口汇总                  | `docs/cache-optimization/02-comparison/comparison.md` 第 1 节总览表（维度 4/5/6/7）、第 2.4/2.5/2.6/2.7 节                                                                                                                                                                                                                     |
| 断点预算与层级分配            | `docs/cache-optimization/01-reference-research/opencode-cache-analysis.md` 第 3.3 节（cap=4、tools→system→messages、dropped 不报错）与第 9 节第 2/3 条                                                                                                                                                                         |
| 三锚点与省略分支              | `pi-cache-analysis.md` 第 4.2 节（system/最后工具/最后 user 消息末块、string→parts 改写）、第 8.2 节（supportsCacheControlOnTools、Fireworks 关闭）；`kimi-code-cache-analysis.md` 第 3.2 节（三锚点 + 可缓存白名单 + 合并后注入）                                                                                             |
| prompt_cache_key 与 retention | `pi-cache-analysis.md` 第 5.1/5.3 节（64 码点钳制、in_memory/24h、api.openai.com 门控）；`opencode-cache-analysis.md` 第 4.1 节（sessionID→键）；`kimi-code-cache-analysis.md` 第 3.1 节（三 dialect 键）                                                                                                                      |
| GPT-5.6+ options              | `pi-cache-analysis.md` 第 5.3 节（explicit = 禁止隐式缓存）；`00-vendor-model-pricing-catalog.md` 第 2.1 节                                                                                                                                                                                                                    |
| usage 归一化                  | `litellm-cache-analysis.md` 第 5 节（双命名空间 + 不变量 + 别名兜底）；`pi-cache-analysis.md` 第 5.4 节（input = prompt - read - write）；`opencode-cache-analysis.md` 第 7.1 节                                                                                                                                               |
| 分片合并防御                  | `pi-cache-analysis.md` 第 4.4 节（message_start 不被 message_delta 的 0 覆盖）；`comparison.md` 第 2.7 节（anthropic.rs:308-372 现状）                                                                                                                                                                                         |
| 厂商缓存机制数据              | `00-vendor-model-pricing-catalog.md`：Anthropic 第 1 节、OpenAI 第 2 节、DeepSeek 第 3 节、MiniMax 第 7 节、Gemini 第 8 节、Kimi 第 5 节、GLM 第 4 节                                                                                                                                                                          |
| crish 代码证据                | `crates/agent-provider/src/request/vendor.rs:277-310`、`request/messages.rs:62-72`、`request/build.rs:44-63`、`request/tools.rs:12-19`、`config.rs:44-53`、`parse/chat.rs:251-267`、`parse/gemini.rs:309-345`、`events.rs:31-52`、`session-loop/src/provider.rs:74-81`、`apps/agent-workbench/src-tauri/src/engine.rs:207-233` |
