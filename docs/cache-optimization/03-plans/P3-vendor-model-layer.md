# P3：厂商/模型层缓存适配与模型目录数据驱动

- 撰写日期：2026-08-03
- 文档性质：优化方案（只读分析 + 只写本文件，未修改任何源代码）
- 方案主题（单一维度）：**厂商/模型层缓存适配与模型目录（Model Catalog）数据驱动**
  - A. 模型目录数据结构与数据源（借鉴 LiteLLM `model_prices_and_context_window.json` 与 jcode 内置 catalog）
  - B. 厂商缓存行为矩阵落地（按厂商/协议族/模型确定缓存参数开关）
  - C. 会话亲和与缓存键推导（prompt_cache_key 统一推导、x-grok-conv-id 等 header 注入数据与开关）
  - D. DeepSeek v4 专用适配（reasoning_content 回放、Responses 开关、effort 参数）
  - E. 模型级 TTL 路由表（300s / 1h / 24h 数据与查询接口，参考 jcode `cache_ttl_for_provider_model`）
- 输入材料：
  - `docs/cache-optimization/00-vendor-model-pricing-catalog.md`（模型+定价 catalog 权威来源）
  - `docs/cache-optimization/01-reference-research/` 的 vendor-cache-mechanisms / vendor-cache-gaps / litellm-cache-analysis / deepseek-reasonix-cache-analysis / jcode-cache-analysis
  - `docs/cache-optimization/02-comparison/comparison.md`（差距总览）
  - crish 实际代码（全部经本代理实读核实，行号以实读为准）

---

## ① 目标与范围

### 1.1 目标

为 crish 建立**"模型元数据目录 + 缓存行为矩阵 + 缓存键推导 + TTL 路由表"四件套**，使所有"这个模型支不支持 X / 缓存怎么开 / 键怎么推 / 缓存多久冷"的判定收敛到**数据表 + 纯函数**，而不是散落在各 provider 分支的硬编码。核心诉求与 comparison.md 第 2.12/2.5/2.6 节的差距一一对应：

1. **模型目录（A）**：Rust 侧只读模型元数据目录（context_window / max_output / cache_read_price / cache_write_price / prompt_cache_min_tokens / supports_* 能力位等），借鉴 LiteLLM 单文件聚合 + 启动拉取 + 打包快照兜底 + 热注册（litellm-cache-analysis.md:431-435、464-467）。
2. **缓存行为矩阵（B）**：把 vendor-cache-mechanisms.md 第 10 节汇总表落地成数据表（DeepSeek 自动缓存仅需前缀稳定 + usage 解析、不加 cache_control；Anthropic 断点；MiniMax Anthropic 轨可开主动缓存；OpenAI prompt_cache_key + retention；Kimi prompt_cache_key；Grok x-grok-conv-id + prompt_cache_key；Gemini 隐式），并设计查询接口，供 P2 的请求注入框架消费。
3. **会话亲和与缓存键（C）**：prompt_cache_key 统一推导（sessionId → 64 字符钳制）与 `x-grok-conv-id` 等 header 注入的**数据与开关**（注入位置由 P2 提供框架）。
4. **DeepSeek v4 专用适配（D）**：reasoning_content 回放（对齐 Reasonix：tool_calls turn 必带该 key 防 400）、v4-flash 的 Responses API 支持开关、effort 参数映射。
5. **TTL 路由表（E）**：各厂商/模型的缓存 TTL（300s / 1h / 24h）数据与查询接口（参考 jcode `cache_ttl_for_provider_model`，jcode-cache-analysis.md:2774-2799），供冷缓存预警等测量层消费。

### 1.2 边界（本方案不做）

- **不做请求注入实现本身**：cache_control 断点注入、header 注入、请求体字段注入的**框架**属于 P2（"P2 提供注入框架，P3 提供数据与开关"）。本方案只交付：注入**决策所需的数据结构、枚举、矩阵表、查询接口签名**，以及 P2 消费这些接口的契约说明。P2 计划文档已落盘（2026-08-03）。【A1 审计修正】经 A1 交叉审计：本方案的 `CacheBehavior`/`cache_behavior_for`、`derive_prompt_cache_key`、`session_affinity_headers`、`CacheTtl`（models/ 侧）与 P2 §3.1 的 `CacheCapability`/`build_cache_policy`、`CacheKey::from_session_id`、`affinity_header`、`CacheTtl`（request/cache.rs 侧）存在同名/同职责重复与字段不一致；按本句契约以 P2 为准并回写，具体合并规则见 §3.2.1 / §3.3.1 / §3.3.2 标注。
- **不做成本计算**：价格字段由本方案建模与提供，但**成本计算、节省金额估算、命中率统计属于 P5**（P5 消费价格字段做成本计算；P3 只负责数据与开关）。`pricingStore.ts` 是 UI 展示层，本方案不动其编辑能力，只为其提供 Rust 侧数据源（见 3.1.4）。
- **不做 usage 解析字段补齐**：DeepSeek 顶层 `prompt_cache_hit_tokens` / Kimi 顶层 `cached_tokens` 的解析补齐属 **P2**（通用格式层 D 子主题，P2 §3.3 D / §2.3 缺口①），本方案仅在依赖处标注。【A2 审计修正：原稿"（可能是 P1 或其他计划）"为落盘前猜测，P2 已明确拥有该缺口，删去模糊表述】
- **不做测量/审计**：命中率展示、miss 归因、冷缓存预警 UI 属测量层 **P5**（comparison.md 2.10/2.11；P5-cache-telemetry.md），本方案只交付它们依赖的 TTL 查询接口（E）。【A2 审计修正：原稿"测量层"未落计划号，已按最终编号标注 P5】
- **不做历史回流/前缀稳定**：comparison.md 2.1-2.3、2.13 的通用基础层不在本方案范围（本方案假设前缀稳定由其他计划解决；但目录的 `supports_prompt_caching` / `prompt_cache_min_tokens` 字段为其提供判定依据）。

### 1.3 文件域

本方案的实施将触及（仅列文件，实施时由相应实现任务书执行）：

| 类别 | 文件                                                    | 本方案动作                                                                         |
| ---- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 新增 | `crates/agent-provider/src/models/mod.rs`               | 新模块声明（catalog / behavior / cache_key / ttl）                                 |
| 新增 | `crates/agent-provider/src/models/catalog.rs`           | 模型目录结构 + 内置表 + 查询接口                                                   |
| 新增 | `crates/agent-provider/src/models/catalog.json`         | 内置静态目录（include_str! 打包）                                                  |
| 新增 | `crates/agent-provider/src/models/behavior.rs`          | 厂商缓存行为矩阵 + 查询接口                                                        |
| 新增 | `crates/agent-provider/src/models/cache_key.rs`         | prompt_cache_key 推导 + 会话亲和 header 表                                         |
| 新增 | `crates/agent-provider/src/models/ttl.rs`               | 模型级 TTL 路由表                                                                  |
| 扩展 | `crates/agent-provider/src/request/vendor.rs`           | ReasoningVendor 扩展为 VendorId 或新增映射；DeepSeek 省略 cache_control 的断言辅助 |
| 扩展 | `crates/agent-provider/src/request/messages.rs`         | reasoning_content 回放模式接线（D）                                                |
| 扩展 | `apps/agent-workbench/src-tauri/src/engine.rs`          | provider_url 按 catalog `supports_responses` 判定（D）                             |
| 扩展 | `apps/agent-workbench/src-tauri/src/config/provider.rs` | vendor 显式声明字段透传（可选）                                                    |
| 扩展 | `apps/crish-desktop/src/api/modelCatalog.ts`            | scanProviderModels 结果可选合并到 Rust 目录（只读消费）                            |

---

## ② 现状证据（全部实读核实）

### 2.1 provider 识别与 vendor 推断

- `crates/agent-provider/src/request/vendor.rs` 已有 `ReasoningVendor` 枚举（Openai/Anthropic/Deepseek/Gemini/Qwen/Glm/Kimi/Auto，vendor.rs:14-41）与 `infer_reasoning_vendor`（vendor.rs:277-310，baseUrl 关键字 → model 前缀，未命中 → Auto）。
- 已有"最长前缀匹配静态表"先例：`MODEL_SERIES_CAPABILITIES`（vendor.rs:219-257）+ `infer_thinking_capability`（vendor.rs:260-271），用于思考能力推断——**P3 的缓存行为矩阵直接复用这套模式**（模型系列 → 能力结构）。
- 缺口：`ReasoningVendor` 面向"思考参数"设计，无 MiniMax / Grok / Anthropic 系断点 / 百炼等缓存相关维度；baseUrl 不含关键词的自建网关（如 `https://gw.example.com/v1`）推断为 Auto，缓存行为只能回退保守默认。

### 2.2 模型配置来源

- `crates/agent-provider/src/config.rs`：`ProviderConfig`（config.rs:93-110）含 `provider_id`（默认 `openai-compatible`，config.rs:116）/ `base_url` / `model` / `endpoint` / `api_key_ref` / `extra`（透传 BTreeMap）。`extra` 是 vendor 显式声明字段的现成落点。
- 壳侧 `apps/agent-workbench/src-tauri/src/config/provider.rs`：`config_update`（provider.rs:501-553）只接受 `base_url / model / credential_mode / endpoint / stream` 五参数——**无 provider_id / vendor 显式字段**（引擎实际只支持单 OpenAI-compatible provider，provider.rs 文件头注释与 clientApi.ts:798 "真实配置轨 = providerProfiles + update-config；引擎仅 OpenAI-compatible"）。
- `engine.rs`：`EngineProviderConfig`（engine.rs:128-139）只有 base_url/api_key/model/endpoint/stream 五字段；`load_provider_endpoint`（engine.rs:146-163）三件套齐备才就绪。

### 2.3 模型列表获取（无缓存）

- 前端 `apps/crish-desktop/src/api/modelCatalog.ts`：`scanProviderModels`（modelCatalog.ts:688-771）每次调用直接 `GET {base}/models`（modelsListUrl，modelCatalog.ts:539-546），**无 TTL / ETag / 缓存**；解析 `data[].context_length / max_model_len` 后写 `crish_model_meta_v1`（localStorage，modelCatalog.ts:16）；未知模型走猜测函数 `guessContextLength / guessModelCapabilities`（modelCatalog.ts:760-765）。
- `ModelMeta`（modelCatalog.ts:32-49）只有 profileId/model/displayName/enabled/contextLength/capabilities（tools|vision|reasoning 三键）/lastTest——**无 max_output、无缓存价、无 cache 能力位**。
- `clientApi.ts` 的 `fetchLatestModels` 是 DEAD 方法（恒返回 `[]`，clientApi.ts:822-824，注释"@deprecated DEAD formal — use providerProfiles"）。

### 2.4 定价现状（2D + 全局乘数，无 per-model 缓存价）

- `apps/crish-desktop/src/api/pricingStore.ts`：`DEFAULT_PRICES` 仅 8 个模型、每模型只有 input/output 两价（pricingStore.ts:31-40）；cache 价用**全局乘数** `DEFAULT_CACHE_READ_MULTIPLIER = 0.1` / `DEFAULT_CACHE_WRITE_MULTIPLIER = 1.25`（pricingStore.ts:26-28）叠加到 inputPerMTok 上——与厂商真实 per-model 缓存价不符（如 DeepSeek flash 命中价是未命中的 2%，即乘数 0.02；Grok 0.15；Kimi 0.10；MiniMax M2.7 0.20）。4D 计算逻辑本身正确（estimateCostUsd4d，pricingStore.ts:99-121）。
- 结论：pricingStore 是"用户可编辑的展示层"，P3 不在其中做文章，但 Rust 侧目录的 per-model `cache_read_price` 是它未来取值的更优数据源（供 P5）。

### 2.5 请求构造现状（无任何缓存字段）

- `crates/agent-provider/src/request/build.rs`：`build_chat_completions_request_body`（build.rs:102-177）只处理 model/stream/temperature/top_p/max_tokens/reasoning/thinking/messages/tools/stream_options——**无 prompt_cache_key、无 prompt_cache_options、无 cache_control 注入点**。
- `messages.rs`：`ChatMessage`（messages.rs:62-104）无 cache_control 字段，content part（ChatContentPart，messages.rs:38-59）也无。
- `apps/agent-workbench/src-tauri/src/engine.rs`：请求仅 `Authorization` 头（engine.rs:250-256）；`provider_url` 只支持 chat-completions / responses 两个端点（engine.rs:168-174），无 Anthropic Messages 端点；`build_context` 的 `system_prompt` 恒 None（engine.rs:220）。
- `reasoning_content` 已具备载体：`ReasoningContentMode`（messages.rs:19-28，Omit/Include/Require）与 `ChatMessage.reasoning_content` 字段（messages.rs:69、96-98）——D 的回放接线是现成接口，只差"按 vendor/model 自动选择 Require"的驱动（P3 提供开关，P2 或 D 步骤接线）。

### 2.6 会话循环与历史

- `core_run_task`（core_run_commands.rs:919-929）签名：run_id/session_id/prompt/mode/cwd/permission_mode/client_message_id/assistant_client_message_id——**有 session_id 可作为 prompt_cache_key 源，无 history / system_prompt 参数**（comparison.md 2.3/2.13 的缺口属其他计划）。
- `SessionLoopProducer::new`（core_run_commands.rs:1037-1048）每次 run 重建 loop、对话为空——跨轮前缀不存在（comparison.md 4.1），P3 的缓存键推导在该约束下仍成立（key 是会话维度而非前缀内容维度）。

### 2.7 usage 解析

- `parse/chat.rs` `parse_usage`（chat.rs:251-267）：`prompt_tokens_details.cached_tokens ?? input_tokens_details.cached_tokens` → cacheRead；**未解析 DeepSeek Chat 顶层 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`、Kimi 顶层 `usage.cached_tokens`、cache_write 别名**（comparison.md 表注；属格式层计划，P3 不实施，但 catalog 的计量字段表为其提供字段清单参考）。

### 2.8 参考文档要点（本方案数据的依据）

- **LiteLLM 目录**（litellm-cache-analysis.md:431-435）：单文件聚合"单价 + 缓存价 + 窗口 + 能力位"；`get_prompt_cache_min_tokens` 三级解析（环境变量 → 模型目录 → 默认 1024，litellm-cache-analysis.md:169-183）；多级模型名兜底（`provider/model` → 去版本 → 去微调后缀，litellm-cache-analysis.md:5223-5312 区域）；"内置快照 + 可热替换 + 变更计数"（litellm-cache-analysis.md:464-467）。
- **jcode TTL 路由表**（jcode-cache-analysis.md:2774-2799）：anthropic 300s/3600s、openai 300s/86400s、openrouter 300s、gemini 300s、无缓存厂商 None——"表只依赖供应商/模型能力，不依赖 UI 层"。
- **jcode 能力判定**（jcode-cache-analysis.md:2704-2745）：OpenRouter 按定价数据判定缓存能力（`input_cache_read > 0 || supports_implicit_caching`），否则断点白加甚至被拒——P3 矩阵的"默认保守"原则。
- **Reasonix DeepSeek 适配**（deepseek-reasonix-cache-analysis.md:100-114、212-222）：省略 cache_control（测试钉死）；tool_calls turn 必带 reasoning_content key（空串也发，openai.go:658-680）；thinking disabled 时保持历史字节；effort 映射（deepseek-reasonix-cache-analysis.md:220）。
- **jcode DeepSeek**（jcode-cache-analysis.md:393-396）：内置 deepseek profile（在线模型目录不可用时硬编码 v4-flash/v4-pro 可选）——crish 目录对 DeepSeek 内置同样必要。
- **00-vendor-model-pricing-catalog.md §12**：字段结构草案（§12.1 JSON Schema）与 LiteLLM 字段映射（§12.2）、刷新清单（§12.3）——本方案 A 部分直接采用其字段草案并缩窄到"实现层必须字段"。

---

## ③ 设计

### 3.1 A. 模型目录（Model Catalog）

#### 3.1.1 模块布局

```
crates/agent-provider/src/models/
├── mod.rs          # 模块声明 + 公共 re-export
├── catalog.rs      # ModelCatalogEntry / ModelCatalog / 查询接口
├── catalog.json    # 内置静态目录（include_str! 编译期打包）
├── behavior.rs     # VendorId / CacheBehavior / 厂商缓存行为矩阵
├── cache_key.rs    # derive_prompt_cache_key / 会话亲和 header 表
└── ttl.rs          # CacheTtl / cache_ttl_for_provider_model
```

依赖方向：`catalog.rs` 不依赖 request/parse 层；`behavior.rs` / `ttl.rs` / `cache_key.rs` 依赖 `catalog.rs`（模型级覆盖优先于 vendor 级默认）；上层（P2 注入框架、P5 成本计算）只依赖 `models::` 的公共接口。**禁止各 provider 分支直接读 catalog.json 之外的散落判定**。

#### 3.1.2 数据结构（ModelCatalogEntry）

字段集采用 `00-vendor-model-pricing-catalog.md §12.1` 草案，按"实现层必须/可选"缩窄（serde `#[serde(default)]` 保证旧数据与未知字段兼容）：

```rust
/// 模型目录条目（一个 provider 通道下一个模型的完整元数据）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelCatalogEntry {
    // ── 标识 ──
    /// API 模型标识（唯一键，如 deepseek-v4-flash）
    pub model: String,
    /// 通道/网关标识（dashscope / volcengine / qianfan；直连 = 官方厂商名）
    pub provider: String,
    /// 官方厂商（转售场景区分通道价与官方直连价；决定缓存行为矩阵取哪个 vendor）
    pub vendor: String,
    pub mode: String,            // "chat" | "responses" | "both"
    pub currency: String,        // USD / CNY
    pub unit: String,            // per_1M

    // ── 窗口 ──
    pub context_window: Option<u64>,
    pub max_input_tokens: Option<u64>,
    pub max_output_tokens: Option<u64>,

    // ── 价格（P3 只建模不计算；P5 消费）──
    pub input_price: Option<f64>,
    pub output_price: Option<f64>,
    pub cache_read_price: Option<f64>,        // 命中价（per_1M）
    pub cache_write_price: Option<f64>,       // 通用写入价（OpenAI GPT-5.6+ 1.25x 口径）
    pub cache_write_price_5m: Option<f64>,    // Anthropic 系 5m TTL 写入价
    pub cache_write_price_1h: Option<f64>,    // Anthropic 系 1h TTL 写入价
    pub storage_price_per_1m_hour: Option<f64>, // Gemini / 方舟存储费
    pub long_context_threshold: Option<u64>,  // Grok 200K / Gemini 3.1 Pro 200K
    pub long_context_input_price: Option<f64>,
    pub peak_pricing_2x: bool,                // DeepSeek 峰谷定价标记

    // ── 缓存语义 ──
    pub prompt_cache_min_tokens: Option<u64>, // 最低可缓存前缀（Anthropic 512~4096 / Kimi 256 …）
    pub cache_type: String,        // "automatic" | "explicit" | "both" | "none"
    pub cache_mechanism: String,   // "prefix" | "similarity" | "disk_unit" | "session"
    pub supports_cache_control: bool,   // Anthropic 式断点支持
    pub supports_prompt_caching: bool,  // 是否参与任何形式缓存
    pub breakpoint_max: Option<u8>,     // 断点上限（Anthropic/MiniMax 4、百炼 4）
    pub lookback_blocks: Option<u16>,   // 回溯窗口（Anthropic/百炼 20）
    pub cache_ttl: Option<CacheTtl>,    // 模型级 TTL（覆盖 vendor 级默认，见 3.5）
    pub cache_write_free: bool,         // 旧轨写免费（OpenAI 旧模型/Kimi/DeepSeek）

    // ── 协议/能力位 ──
    pub supports_responses: bool,       // Responses API 支持（DeepSeek 仅 v4-flash）
    pub supports_reasoning: bool,
    pub supports_vision: bool,
    pub supports_function_calling: bool,
    pub supports_parallel_function_calling: bool,
    pub supports_system_messages: bool,
    pub supports_response_schema: bool,

    // ── 溯源 ──
    pub deprecation_date: Option<String>,
    pub source_url: String,            // 条目数据来源（00 catalog 各节 URL）
    pub data_verified_at: String,      // 条目核实日期（2026-08-02）
}
```

#### 3.1.3 数据来源策略（内置静态 + 运行时获取 + 用户覆盖）

优先级（低 → 高）：

1. **内置静态目录**：`catalog.json` 用 `include_str!` 编译期打包（Rust 侧无运行时 IO、离线可用），首批条目从 `00-vendor-model-pricing-catalog.md` 转录（DeepSeek v4-flash/pro、Anthropic 全系、OpenAI gpt-5.6/5.5、Kimi K3、Grok 4.5/4.3、MiniMax M2.7/M2.5/M3、Gemini 3.x、GLM 5.x/4.7、Qwen 3.x 代表模型），每条保留 `source_url` / `data_verified_at`。**jcode 对 DeepSeek 的教训**（jcode-cache-analysis.md:393-396）：在线目录不可用也必须内置可选。
2. **运行时获取**：复用前端 `scanProviderModels`（modelCatalog.ts:688-771）的 `/models` 扫描结果，通过 Tauri 命令上送合并（`upsert_from_scan`，仅合并 `context_window / max_output / 能力位猜测`，**不覆盖内置价格与缓存价**——扫描无这些字段）。刷新频率与 ETag/TTL 由测量层计划（或前端现有点击触发）控制，P3 只提供合并入口。
3. **用户配置覆盖**：`provider-config.json` 的 `extra` 域（config.rs:109 已透传）或独立 `catalog-overrides.json`，只允许覆盖**白名单字段**（context_window / max_output_tokens / 五价格 / prompt_cache_min_tokens / supports_* 能力位），经 `merge_overrides` 校验后生效，并 bump 版本号。**禁覆盖** model/provider/vendor 三键（防键冲突）。

#### 3.1.4 存放位置与并发形态

```rust
/// 运行时目录（内置表 + 覆盖 + 扫描合并的单一真源）
pub struct ModelCatalog {
    entries: BTreeMap<String, ModelCatalogEntry>,  // 键 = "{vendor}::{model}"（同模型多通道按 provider 区分）
    version: u64,                                  // 单调递增，任何变更 +1
}

impl ModelCatalog {
    /// 内置表 + 空运行时表
    pub fn bundled() -> Self;
    /// 加载用户覆盖（catalog-overrides.json 或 config extra），失败不阻塞（仅记录）
    pub fn with_overrides(&mut self, overrides: &[Value]) -> Result<(), CatalogError>;
    /// 扫描结果合并（前端 /models 扫描）
    pub fn upsert_from_scan(&mut self, provider: &str, scan: Vec<ScannedModel>) -> u64;
    /// 当前版本号（下游 memoize 失效键）
    pub fn version(&self) -> u64;
}
```

壳侧以 `Arc<RwLock<ModelCatalog>>` 挂 Tauri state（与 `SharedDb` / `StatusDiagnostics` 同模式），engine 启动时加载；变更仅经命令入口（如 `catalog_get` / `catalog_refresh`）进行。**版本号对齐 litellm `_model_cost_mutation_generation`**（litellm-cache-analysis.md:272-273 区域）：下游任何按版本失效的缓存（如 P5 的成本 memoize）以它为键。

#### 3.1.5 查询接口签名

```rust
/// 解析入口（多级兜底，对齐 litellm `_get_model_info_helper` 顺序）
/// 查找顺序：精确 model → model 去版本后缀（-0731 / -20250826）→
///           vendor 级默认条目（model="*" 或 vendor 专用 fallback）→ None
pub fn lookup(&self, vendor: &str, model: &str) -> Option<&ModelCatalogEntry>;

/// 便捷：窗口钳制（P4/压缩层消费；窗口缺失 → None）
pub fn context_window_for(&self, vendor: &str, model: &str) -> Option<u64>;
/// 便捷：输出上限
pub fn max_output_for(&self, vendor: &str, model: &str) -> Option<u64>;
/// 便捷：最低可缓存前缀（缺省回退 1024，对齐 litellm DEFAULT_MINIMUM_PROMPT_CACHE_TOKEN_COUNT）
pub fn prompt_cache_min_tokens_for(&self, vendor: &str, model: &str) -> u64;
/// 便捷：缓存资格判定（is_prompt_caching_valid_prompt 的目录侧）
pub fn supports_prompt_caching_for(&self, vendor: &str, model: &str) -> bool;
/// 便捷：Responses 支持（engine.rs provider_url 判定用）
pub fn supports_responses_for(&self, vendor: &str, model: &str) -> bool;
```

多级兜底是**必须**：`deepseek-v4-flash-0731`（去版本后缀）必须命中 `deepseek-v4-flash`（Reasonix/jcode 均以 64-token 块与版本后缀做过此处理；vendor-cache-mechanisms.md:29 标注 v4-flash 官方版本号即 DeepSeek-V4-Flash-0731）。

### 3.2 B. 厂商缓存行为矩阵

#### 3.2.1 枚举（VendorId / CacheBehavior）

```rust
/// 缓存行为矩阵的厂商键（扩展自 ReasoningVendor，加入缓存维度厂商）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VendorId {
    Deepseek, Anthropic, MiniMax, Openai, Kimi, Grok, Gemini,
    Glm, Qwen, Dashscope,          // 百炼通道
    #[default]
    Auto,                          // 未识别 → 保守默认
}

/// 缓存行为开关集（P2 注入框架的决策输入）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheBehavior {
    pub vendor: VendorId,
    /// 是否参与任何自动缓存（无 → 不注入任何缓存字段、TTL=None）
    pub supports_prompt_caching: bool,
    /// 自动缓存（无需请求侧字段，只需前缀稳定 + usage 解析）
    pub auto_cache: bool,
    /// 是否支持 Anthropic 式 cache_control 断点
    pub supports_cache_control: bool,
    /// DeepSeek 强制省略 cache_control（注入框架必须跳过）
    pub omit_cache_control: bool,
    /// 是否支持 prompt_cache_key 请求字段
    pub supports_prompt_cache_key: bool,
    /// 是否支持 x-grok-conv-id 等会话亲和 header
    pub supports_conv_header: bool,
    /// 会话亲和 header 名（None = 无）
    pub conv_header_name: Option<&'static str>,
    /// 断点预算（Anthropic/MiniMax/百炼 = 4）
    pub breakpoint_max: Option<u8>,
    /// TTL 默认档（见 3.5）
    pub default_ttl: Option<CacheTtl>,
}
```

【A1 审计修正】与 P2 §3.1.2 `CacheCapability`（request/cache.rs，注入框架的决策类型真源）的合并规则：

- P3 的 `CacheBehavior` 保留为矩阵查询的返回类型，但需映射进 P2 `CacheCapability`——`omit_cache_control`、`auto_cache`、`supports_conv_header`、`conv_header_name`、`default_ttl` 是 P2 `CacheCapability` 未覆盖字段（并入）；`breakpoint_max` ↔ P2 `breakpoint_cap`；`supports_prompt_cache_key` ↔ P2 `prompt_cache_key`；`supports_cache_control` 两方案同名字段一致。
- `models/behavior.rs` 静态矩阵作为 P2 `CACHE_CAPABILITY_TABLE` 的数据源（P2 §3.4 存放位置建议 1），模型级覆盖经 P2 `build_cache_policy(.., overrides)` 的 `extra.cache` 通道生效（P2 §3.4 存放位置建议 2）。
- 两处 `CacheTtl` 同名枚举需合一：P2 的 `FiveMinutes/OneHour`（request/cache.rs）与 P3 的 `Short/Hour/Day`（models/ttl.rs）取一，serde 值域与 00-catalog §12.1 的 `"5m"/"1h"` 对齐（P3 的 kebab-case short/hour/day 需改为 5m/1h/24h 或增加映射）。

#### 3.2.2 矩阵数据表（数据事实，转录自 vendor-cache-mechanisms.md §10 汇总 + 00 catalog）

| 厂商（VendorId）   | 缓存类型                                               | auto_cache | supports_cache_control                              | omit_cache_control | supports_prompt_cache_key                                | supports_conv_header                                    | breakpoint_max      | default_ttl   | 备注                                                                                                                   |
| ------------------ | ------------------------------------------------------ | ---------- | --------------------------------------------------- | ------------------ | -------------------------------------------------------- | ------------------------------------------------------- | ------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Deepseek           | 自动磁盘前缀缓存（前缀单元制）                         | ✅         | ❌                                                  | **✅ 强制**        | ❌（官方明确不支持，静默忽略，vendor-cache-gaps.md:104） | ❌                                                      | —                   | 300s          | 客户端只做前缀稳定 + 解析 hit/miss（vendor-cache-mechanisms.md:38-40）                                                 |
| Anthropic          | automatic + explicit 双模式                            | ✅         | ✅                                                  | ❌                 | ❌                                                       | ❌                                                      | 4                   | 300s / 3600s  | 顶层 ephemeral 自动缓存；块级断点；20 块回溯（vendor-cache-mechanisms.md:219-265）                                     |
| MiniMax            | 被动（自动）+ 主动（Anthropic 轨）双轨                 | ✅         | ✅（仅 M2.x）                                       | ❌                 | ❌                                                       | ❌                                                      | 4                   | 300s          | **M3 不支持主动缓存**（vendor-cache-gaps.md:186）；断点语义与 Anthropic 一致可复用同一实现                             |
| Openai             | 自动 + 显式断点（GPT-5.6+ prompt_cache_options）       | ✅         | ❌（自有断点参数体系，非 cache_control）            | ❌                 | ✅（GPT-5.6+ 建议设置）                                  | ❌                                                      | 4（5.6+，隐式占 1） | 300s / 86400s | retention 24h 仅 gpt-5.x 扩展保留模型（00 catalog §2.1）                                                               |
| Kimi               | 全自动 Context Caching                                 | ✅         | ❌                                                  | ❌                 | ✅（session/task id 语义，Coding Plan 必填）             | ❌                                                      | —                   | 300s          | 顶层 `usage.cached_tokens`；前置请求 >256 token 才缓存（vendor-cache-mechanisms.md:78-97）                             |
| Grok               | 自动前缀缓存 + 粘性路由                                | ✅         | ❌                                                  | ❌                 | ✅（Responses 原生）                                     | ✅（`x-grok-conv-id`，Chat 轨）                         | —                   | 300s          | 不设头/键则命中率不可靠（vendor-cache-mechanisms.md:113-127）                                                          |
| Gemini             | 隐式（默认）+ 显式 cachedContents                      | ✅         | ❌（无 cache_control，cachedContent 独立资源）      | ❌                 | ❌                                                       | ❌                                                      | —                   | 300s          | 隐式最低 4096（3.x）；显式走 API 资源非请求字段                                                                        |
| Glm                | 自动隐式缓存（相似度识别）                             | ✅         | ❓（Anthropic 端点存在但**未实测确认**，保守按 ❌） | ❌                 | ❌                                                       | ❌                                                      | —                   | 300s          | 矩阵该格标 unverified（vendor-cache-gaps.md:150-153）                                                                  |
| Dashscope（百炼）  | 显式 cache_control 与隐式互斥 + Responses Session 缓存 | ✅         | ✅（仅 ephemeral，≤4，20 块回溯）                   | ❌                 | ❌                                                       | ✅（`x-dashscope-session-cache: enable`，仅 Responses） | 4                   | 300s          | 显式命中 10% 优于隐式 20%；tools 中 cache_control 被忽略（vendor-cache-gaps.md:16-42）                                 |
| Auto（未识别网关） | 未知                                                   | ❌         | ❌                                                  | ❌                 | ❌                                                       | ❌                                                      | —                   | None          | **保守默认：不注入任何缓存字段**（对齐 jcode `model_supports_cache` 的"否则视为不支持"，jcode-cache-analysis.md:2744） |

#### 3.2.3 查询接口

```rust
/// 从 base_url / model 推断 VendorId（对齐 infer_reasoning_vendor 的优先级，补充 minimax/grok/dashscope 关键字）
pub fn infer_vendor(base_url: Option<&str>, model: Option<&str>) -> VendorId;

/// 行为矩阵判定（vendor 级默认 + catalog 模型级覆盖）
pub fn cache_behavior_for(catalog: &ModelCatalog, vendor: VendorId, model: Option<&str>) -> CacheBehavior;
```

- vendor 级默认来自静态矩阵表（3.2.2）；模型级覆盖来自 catalog 条目（`supports_cache_control` / `supports_prompt_caching` / `breakpoint_max` / `cache_ttl` 非默认时覆盖）。
- **模型系列覆盖**沿用 `MODEL_SERIES_CAPABILITIES` 的最长前缀模式（如 MiniMax 家族 `minimax-m3` → 主动缓存关；`minimax-m2` → 开），以静态表（`behavior.rs` 内）形式存在，catalog 条目优先级更高。
- 消费方契约（给 P2）：【调度者裁决】P2 注入框架的入口 `build_cache_policy`（engine.rs 唯一运行时判定/消费入口）在请求构造时内部调用 `cache_behavior_for` 取数据真源，据 `supports_cache_control` / `omit_cache_control` 决定是否注入断点；据 `supports_prompt_cache_key` 决定是否注入键；据 `supports_conv_header` + `conv_header_name` 决定是否注入 header。本接口是 models/ 层的数据层查询接口（不直接进 engine），**矩阵表是本方案对 P2 的唯一接口面（唯一数据真源）**。

> 【A3 审计修正】（2026-08-03，A3-executability.md P0-2）：**与 P2 的运行时合并链（唯一判定入口）**——P2（03-plans/P2-wire-cache-params.md §3.1.2）曾交付 `infer_cache_capability` + `CACHE_CAPABILITY_TABLE` 内置默认表 + `build_cache_policy(capability, session_id, overrides)`，与本方案 `cache_behavior_for` 存在双真源。裁决：**`cache_behavior_for` 是 engine.rs `request_options` 的唯一运行时判定入口**；P2 的 `infer_cache_capability` 降级为"无 catalog 注入时的内置保守默认"，作为本函数内部兜底（P2 表数据值以本方案 §3.2.2 矩阵为准转录）；`build_cache_policy` 输入改为消费本方案的 `CacheBehavior`（或等价序列化覆盖，二选一由实施任务书冻结）。P2 文档已同步修正。【A1 审计修正】P2 落盘后的实际调用链为 `infer_cache_capability` → `build_cache_policy`（P2 §3.2 接线）；本方案的矩阵数据经"内置默认表（CACHE_CAPABILITY_TABLE）+ `extra.cache` 覆盖"两条通道汇入 P2，`cache_behavior_for` 保留为 models/ 层查询接口（供 P2 数据映射与 P5 消费），不再作为注入框架的直接调用点。

> 【调度者裁决】（2026-08-03，A2 审计遗留项 P1-6 收敛；取代上方 A3/A1 两则注记中互相矛盾的入口表述）：
> 缓存能力判定的运行时入口收敛为：engine.rs 只调用 P2 的 build_cache_policy（唯一运行时判定/消费入口）；P3 models/ 层的 cache_behavior_for + CacheBehavior 矩阵（含 catalog 模型级覆盖）是唯一数据真源；P2 的 infer_cache_capability 与 CACHE_CAPABILITY_TABLE 降级为'无 catalog 可用时的内置保守兜底默认'，其数据值以 P3 矩阵为准转录；extra.cache 覆盖 JSON 的键名与 P3 的 CacheBehavior 结构字段对齐（或由 CacheBehavior 序列化得到）。
>
> 即：**`cache_behavior_for` 是 models/ 层的数据层查询接口（不直接进 engine）**，数据经 P2 `build_cache_policy` 消费（`build_cache_policy` 内部取数据真源；无 catalog 可用时回退 `infer_cache_capability` 内置保守兜底默认）。

### 3.3 C. 会话亲和与缓存键推导

#### 3.3.1 prompt_cache_key 统一推导

```rust
/// prompt_cache_key 推导（对齐 pi sessionId 64 字符钳制；kimi/opencode 直接取 sessionId）
/// 规则：trim → 按 Unicode 码点截断到 64 字符 → 原样返回（不哈希）。
/// 空 / 全空白 → None（不注入）。
pub fn derive_prompt_cache_key(session_id: &str) -> Option<String>;
```

- **取 sessionId 本身而非内容哈希**：Kimi（kimi-code-cache-analysis.md:95-107）、opencode（opencode-cache-analysis.md:110-121）均用 sessionID；Codex 默认 thread_id（codex-cli-cache-analysis.md:58-64）。TS 旧降级路径的 FNV-1a 前缀内容哈希（directFetchBridge.ts:79-87）**不迁移**——它耦合 systemPrompt+tools 字节，与"会话维度亲和"语义不同，且该路径已软废弃（comparison.md 2.6）。
- 64 字符钳制：pi 的 sessionId 按 Unicode 码点钳 64（pi-cache-analysis.md:141-143）。crish 的 session_id 为内部 UUID/自增形态（engine.rs:100-102 的 new_message_id 前缀形态），ASCII 时恒 ≤64，钳制是防御性约束。
- 注入条件：`cache_behavior_for(...).supports_prompt_cache_key == true`（DeepSeek 自动跳过）。**注：DeepSeek 明确不支持 prompt_cache_key（vendor-cache-gaps.md:104），发出去静默忽略——开关保证不发**。

【A1 审计修正】与 P2 §3.1.1 `CacheKey::from_session_id`（request/cache.rs）同一规则（trim → 按 Unicode 码点钳 64 → 空/全空白 → None；R3 禁止拆代理对，Rust `chars()` 天然安全）。实现取一：请求构造面用 P2 的 `CacheKey::from_session_id`，本函数作为 models/ 层等价委托（或删除重复实现），禁止两套独立实现漂移。引擎侧注入点 = P2 §3.2 的 `build_cache_policy(capability, request.session_id, overrides)`；`core_run_task.sessionId` → `ProviderRequest.session_id`（P2 步骤 4）→ engine 派生的链路与 P6 §3.4（前端不新增必传参数）闭合一致。

#### 3.3.2 会话亲和 header 注入表（数据与开关；注入位置由 P2 提供）

| header                                | 值                                    | 注入条件                                | 协议/厂商                                                 |
| ------------------------------------- | ------------------------------------- | --------------------------------------- | --------------------------------------------------------- |
| `x-grok-conv-id`                      | `derive_prompt_cache_key(session_id)` | vendor=Grok 且 endpoint=ChatCompletions | xAI Chat 轨粘性路由（vendor-cache-mechanisms.md:121）     |
| `x-dashscope-session-cache: enable`   | 固定值 enable                         | vendor=Dashscope 且 endpoint=Responses  | 百炼 Responses Session 缓存（vendor-cache-gaps.md:71-76） |
| `x-session-affinity` / `x-session-id` | session_id                            | 默认关闭（可配置开关，pi 默认 false）   | 通用兼容（pi-cache-analysis.md:141-143）                  |

- 数据结构：`pub fn session_affinity_headers(behavior: &CacheBehavior, session_id: &str) -> Vec<(String, String)>`（纯函数，返回注入对；空 Vec = 不注入）。
- 注入点契约：P2 在 `engine.rs:250-256`（仅 Authorization 处）扩展为"基础头 + 亲和头"合并；P3 只交付该函数的输出。

【A1 审计修正】与 P2 §3.1.2 `affinity_header`（request/cache.rs，默认全关）同职责：P2 提供判定入口与注入位置，P3 提供数据表（header 名/值/开关）；`session_affinity_headers` 与 `affinity_header` 取一实现（建议 P3 表数据 → P2 判定函数消费），避免两处同职责函数漂移。

### 3.4 D. DeepSeek v4 专用适配

#### 3.4.1 reasoning_content 回放（对齐 Reasonix openai.go:658-680）

**规则**（矩阵的 Deepseek 行派生）：

1. vendor=Deepseek 且 assistant 消息含 `tool_calls` → **无条件发送 `reasoning_content` key**，历史无该内容时也发**空串**（pointer 序列化保证 key 存在，API 接受空串；缺 key 直接 400——deepseek-reasonix-cache-analysis.md:118-122）。
2. thinking disabled（effort=off / ThinkingIntensity::Off）时：**只在该轮历史确实留有 reasoning 时发 key**，绝不为了"整洁"改变历史字节形状（deepseek-reasonix-cache-analysis.md:123、"字节稳定优先于整洁"）。
3. 载体复用：`ReasoningContentMode::Require`（messages.rs:25-27）已存在；由 P3 提供判定函数 `pub fn deepseek_reasoning_content_mode(vendor: VendorId, effort_off: bool) -> ReasoningContentMode`（vendor=Deepseek → Require / 按历史字节 → Include / 其余 → Omit），P2 或 D 实施步骤在 `build.rs` 的 `reasoning_content` 选项接线。

> 【A3 审计修正】（2026-08-03，A3-executability.md P0-1）：**规则 2 与 P1 C3 冲突，裁决以 P1 为准并删除本规则的第二套判定**。P1（03-plans/P1-prefix-stability.md §3.4 C3）已实现 engine.rs 侧 `reasoning_content_mode()`：DeepSeek 恒 Require（工具轮次必带 `reasoning_content` 键、空串兜底），并论证"恒在"恰好消除 thinking 开→关会话的前缀形态漂移（本规则 2 的"effort=off 按历史字节"会让开关漂移，与 P1 目标直接冲突）。修正后：
>
> - **不实现** `deepseek_reasoning_content_mode` 第二套判定函数；P1 C3 的 `reasoning_content_mode()` 是唯一接线点（engine.rs `request_options`）。
> - 本方案的 effort 维度降级为**数据输入**：catalog 条目的 `supports_reasoning` 位与 effort 档位（§3.4.3）供 P1 判定函数消费。
> - 步骤 4 与 P1 步骤 3.1（messages.rs Require 语义）同代码点，实施时**只由 P1 实现一次**，本方案不做第二遍接线。
> - 规则 2 的"字节稳定优先"精神保留为 P1 C3 的注释论据，不再作为独立行为。

**代价如实标注**：reasoning 回放计入 miss 输入，是 DeepSeek thinking 模式下缓存收益的天花板（deepseek-reasonix-cache-analysis.md:222），实施时接受并在 UI 如实显示（UI 属测量层）。

#### 3.4.2 v4-flash Responses API 支持开关

- catalog 条目：`deepseek-v4-flash` → `supports_responses: true`、`mode: "both"`；`deepseek-v4-pro` → `supports_responses: false`（官方计划 2026 年 8 月初加入，00 catalog §3.1 + vendor-cache-gaps.md:95——**刷新清单已登记，加入后改条目即可**）。
- 接线：`engine.rs` 的 `provider_url`（engine.rs:168-174）在 endpoint=Responses 且 `supports_responses_for(vendor, model) == false` 时**拒绝或降级 chat-completions**（降级策略由 P2/引擎裁决，本方案只提供判定）。
- DeepSeek Responses 计量字段差异（`input_tokens_details.cached_tokens` / `reasoning_tokens`，vendor-cache-gaps.md:103）属格式层计划。

#### 3.4.3 effort 参数

- DeepSeek 只发 `reasoning_effort` 单字段（vendor.rs:408 已有实现，`resolve_thinking_params` 的 ReasoningEffort 分支）。
- 档位映射：jcode 的 `DEEPSEEK_SELECTABLE_EFFORTS = [none, low, medium, high, max, swarm, swarm-deep]`（jcode-cache-analysis.md:348-355）中，crish 现有 `ThinkingIntensity`/`ReasoningEffort` 档位（off/minimal/low/medium/high/xhigh）只映射 **none→off、low/medium/high 原样**；`max / swarm / swarm-deep` 不在 crish 档位内，**本方案不引入**（如未来需要，扩 ThinkingIntensity 枚举属 01 D5 域）。catalog 条目 `supports_reasoning` 位提供"该模型是否接受 effort"的门控。

### 3.5 E. 模型级 TTL 路由表

```rust
/// 缓存 TTL 档（对齐 jcode cache_ttl_for_provider_model 的返回值语义）
///
/// 【A2 审计修正】名称与值域收敛裁决（P2 × P3 合并，承接 A1 标注的"取一"）：
/// - 名称：`CacheTtl` **保留在本模块（models/ttl.rs）**，承担模型级 TTL 路由语义；
///   P2（request/cache.rs）同名的 wire 桶类型（FiveMinutes/OneHour）已按 A2 裁决
///   更名 `TtlBucket`，避免同 crate 同名冲突（见 P2 §3.1.1 A2 注记）；
/// - 值域：serde 值对齐 00-catalog §12.1 的 `"5m" / "1h" / "24h"`（替代原 kebab-case
///   short/hour/day——A1 标注"需改为 5m/1h/24h 或增加映射"此处落地），
///   catalog.json 条目 `cache_ttl` 按此值域填写。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CacheTtl {
    /// 5 分钟（自动缓存通例；命中刷新免费）
    #[serde(rename = "5m")]
    Short,          // 300s
    /// 1 小时（Anthropic ttl:"1h" 显式；写入价 2x）
    #[serde(rename = "1h")]
    Hour,           // 3600s
    /// 24 小时（OpenAI 扩展保留模型）
    #[serde(rename = "24h")]
    Day,            // 86400s
}

impl CacheTtl {
    pub fn seconds(self) -> u64;   // 300 / 3600 / 86400
}

/// TTL 路由表（对齐 jcode provider/mod.rs:2774-2799；纯函数，不依赖 UI）
pub fn cache_ttl_for_provider_model(catalog: &ModelCatalog, vendor: VendorId, model: Option<&str>) -> Option<CacheTtl>;
```

| vendor          | 默认档                                    | 模型级覆盖（catalog `cache_ttl`）                                                                                                                                      | 依据                                                                                   |
| --------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Deepseek        | Short                                     | —                                                                                                                                                                      | 自动磁盘缓存，不再使用数小时到数天清除（vendor-cache-gaps.md:118）；客户端按 300s 预警 |
| Anthropic       | Short（`ttl_1h` 开关开时 Hour）           | 1h 档模型（如需要）                                                                                                                                                    | jcode 2776-2780：300s 或 3600s                                                         |
| Openai          | Short（gpt-5.5 及更早扩展保留模型 → Day） | 模型前缀 `gpt-5.5/5.4/5.2/5.1/5` 支持 24h（**gpt-5.6 除外**：TTL 仅 30m，00-catalog §2.1【A1 审计修正：原稿含 gpt-5.6，与 00-catalog §2.1"GPT-5.6+ TTL 仅 30m"矛盾】） | jcode 2781-2790；00 catalog §2.1                                                       |
| Kimi            | Short                                     | —                                                                                                                                                                      | 全自动无 TTL 管理，按 300s 预警                                                        |
| Grok            | Short                                     | —                                                                                                                                                                      | 服务端管理未公布值，按 300s                                                            |
| MiniMax         | Short                                     | —                                                                                                                                                                      | 主动缓存 TTL 5 分钟（vendor-cache-mechanisms.md:150）                                  |
| Gemini          | Short                                     | —                                                                                                                                                                      | 隐式缓存无公开 TTL；显式 cachedContents 默认 1h（有存储费，另行核算）                  |
| Glm             | Short                                     | —                                                                                                                                                                      | 自动缓存"有合理时限"（vendor-cache-mechanisms.md:58）                                  |
| Dashscope       | Short                                     | —                                                                                                                                                                      | 显式 5 分钟（命中重置）（vendor-cache-gaps.md:23）                                     |
| Auto/无缓存厂商 | **None**                                  | —                                                                                                                                                                      | 不支持前缀缓存 → 永不预警（jcode 2794-2796：copilot/cursor 类返回 None）               |

- 消费方：冷缓存预警（jcode app.rs:1810-1814 模式，属测量层）、摘要请求缓存隔离（pi cacheRetention:"none"，属 P4 压缩层）。P3 只交付表 + 查询函数。
- 覆盖优先级：catalog 条目 `cache_ttl` > vendor 默认 > None。

---

## ④ 实施步骤（建议顺序，每步独立可验证）

### 步骤 1：catalog 骨架 + 内置 JSON

- 建 `crates/agent-provider/src/models/{mod,catalog}.rs` + `catalog.json`。
- 条目转录自 `00-vendor-model-pricing-catalog.md`（DeepSeek 2、Anthropic 6+、OpenAI 2、Kimi 1、Grok 2、MiniMax 3、Gemini 4、GLM 4、Qwen 3 ≈ 27 条起步；条目数不设上限）。
- 实现 `bundled()` / `lookup`（多级兜底：精确 → 去版本后缀 → vendor 默认 → None）/ `version()`。
- 测试：精确命中、`deepseek-v4-flash-0731` 兜底命中 `deepseek-v4-flash`、未知模型 None、catalog.json 可被 serde 全量解析（防转录错误）。

### 步骤 2：VendorId 与行为矩阵

- `models/behavior.rs`：`VendorId` / `infer_vendor`（在 `infer_reasoning_vendor` 基础上补 minimax/grok/dashscope 关键字，vendor.rs:277-310 不动，新增独立函数）`/ CacheBehavior` / 静态矩阵表 / 模型系列覆盖表（最长前缀）/ `cache_behavior_for`。
- 测试：每家至少 2 条（baseUrl 命中 + model 前缀命中 + Auto 保守回退）；DeepSeek `omit_cache_control` 恒 true；MiniMax M3 与 M2.x 断点差异；Grok `conv_header_name == Some("x-grok-conv-id")`。

### 步骤 3：缓存键推导与 TTL 表

- `models/cache_key.rs`：`derive_prompt_cache_key`（64 码点钳制）+ `session_affinity_headers`。
- `models/ttl.rs`：`CacheTtl` + `cache_ttl_for_provider_model` + 表。
- 测试：中文 sessionId 按码点截断不 panic；空串 → None；DeepSeek 键不注入（矩阵联动）；TTL 表每 vendor 断言；catalog 条目覆盖 vendor 默认。

### 步骤 4：DeepSeek 专用适配

- `messages.rs` 接线 `ReasoningContentMode::Require` 语义（工具回合必带 reasoning_content key、空串兜底）；`build.rs` 按 `deepseek_reasoning_content_mode` 驱动。
- `engine.rs` `provider_url`（engine.rs:168-174）接入 `supports_responses_for` 判定。
- 测试钉死（对齐 Reasonix anthropic_test.go:452-461）：DeepSeek 请求体任意消息块不得出现 `cache_control`；DeepSeek 带 tool_calls 的 assistant 消息必含 `reasoning_content`（空串也含）；v4-pro 在 endpoint=responses 下被判定拒绝/降级。

> 【A3 审计修正】（2026-08-03，A3-executability.md P0-1）：本步骤的 `ReasoningContentMode::Require` 接线与 P1 §3.4 C3 / 步骤 3.1 **同代码点且 P1 已承担**（`messages.rs::reasoning_content_object` + engine.rs `reasoning_content_mode()`）。修正：**本步骤只保留测试钉死**（DeepSeek 不变量断言），**不再实现第二遍接线**；`deepseek_reasoning_content_mode` 判定函数不实现，effort/supports_reasoning 数据由步骤 5 的 catalog 提供，供 P1 判定函数消费。实施顺序：P1 先行，本步骤仅在其后补测试。

【A1 审计修正】本步与 P1 重叠：`messages.rs` 的 Require 落地与 `engine.rs` 的 vendor 推断驱动由 **P1 阶段 2 步骤 2.3 / 阶段 3 步骤 3.1 先行实现**（P1 的 `reasoning_content_mode()`：vendor=Deepseek → Require，其余 Omit）；P3 的增量只保留 `deepseek_reasoning_content_mode(vendor, effort_off)` 的 effort_off 细分规则（thinking disabled 时按历史字节 Include，P3 §3.4.1 规则 2），实现时并入 P1 的 `reasoning_content_mode`，不在 P1 之后另写第二套驱动。`build.rs` 与 P1 步骤 2.1（build_system_prompt）、P2 步骤 3（cache 注入）同文件，按 P1 → P2 → P3 串行。

### 步骤 5：用户覆盖与运行时合并（可选，配合 P5/前端）

- `merge_overrides`（白名单字段校验 + 版本号 bump）；`upsert_from_scan`（前端 scanProviderModels 结果上送）。
- 壳侧 `catalog_get` / `catalog_refresh` 命令（挂在 Tauri state，`Arc<RwLock<ModelCatalog>>`）。
- 前端 `modelCatalog.ts` 只读消费：扫描完成后上送合并；`fetchLatestModels`（clientApi.ts:822-824，DEAD）不改（保持 DEAD 声明，不复活）。

> 【A3 审计修正】（2026-08-03，A3-executability.md P1-3）：新增 `catalog_get` / `catalog_refresh` 两个 Tauri 命令，必须同步三处登记（缺一即命令面审计/mock 层失败）：
>
> 1. `apps/agent-workbench/src-tauri/src/command_manifest.rs`：按既有模式登记 `entry("catalog_get", "core", "engine", true)`（参照 :104 `core_compact_messages` 行）；
> 2. `apps/agent-workbench/src-tauri/src/main.rs`：invoke_handler 注册（参照 :108/:117 模式）；
> 3. `tests/e2e/mock-engine.ts`：`BUILTIN_COMMAND_MANIFEST` 快照（:30、:98）随命令面同步（P6 §6.2 已提醒同类约束；mock 对未登记命令抛 missing）。

### 步骤 6：文档回写

- `00-vendor-model-pricing-catalog.md` §12.3 刷新清单核销（Sonnet 5 九月涨价 / DeepSeek v4-pro Responses 支持时间 / 峰谷定价生效日期）。
- 本文件按实施结果更新"矩阵未确认项"（GLM Anthropic 端点 cache_control 实测结果）。

---

## ⑤ 验收标准

1. **编译与回归**：`cargo test --workspace` 全绿（73 套件基线不退步）；新增 `models/` 模块测试全绿；前端若改动则 `npm run typecheck` + `npx vitest run src` 基线不退步（当前基线集中在 oklchColorGuard / userFacingErrors / sessionRustDbWriteModel / DiffCard.perf，不在本方案域）。
2. **矩阵行为**（单元测试钉死）：
   - DeepSeek：`omit_cache_control == true`；`supports_prompt_cache_key == false`；TTL = Short。
   - MiniMax：`minimax-m3` 无主动缓存（supports_cache_control=false）；`minimax-m2.7` 有（=4 断点）。
   - Grok：`conv_header_name == Some("x-grok-conv-id")`；Chat 轨 `session_affinity_headers` 返回该头且值为 session_id 前 64 码点。
   - 百炼 Dashscope：Responses 轨返回 `x-dashscope-session-cache: enable`。
   - 未知网关（baseUrl 无关键字 + model 无前缀）：Auto → 全开关 false、TTL None（保守默认）。
3. **目录解析**：`lookup("deepseek", "deepseek-v4-flash")` 精确命中；`deepseek-v4-flash-0731` 兜底命中；未知模型 None 且行为回退 vendor 级默认；`supports_responses_for` 对 v4-flash=true / v4-pro=false。
4. **键推导**：`derive_prompt_cache_key` 对 64+ 字符 sessionId 输出恰好 64 码点；中文/emoji 输入不 panic、不破坏 UTF-8；空输入 None。
5. **DeepSeek 请求体不变量**（测试钉死）：任意组合下 DeepSeek 请求体不含 `cache_control` 键；tool_calls 回合含 `reasoning_content` 键（空串可）。
6. **TTL 表**：每家厂商的默认档与 jcode/调研表一致；catalog 条目覆盖 vendor 默认生效。
7. **无越界**：本方案落地后 `git grep -n "cache_control" crates/agent-provider/src` 仅出现在测试断言与 P2 注入框架代码中（即：断点注入决策必须经过 `cache_behavior_for`，不允许新出现绕过矩阵的散落判定）。

---

## ⑥ 风险与依赖

### 6.1 依赖

| 依赖                                  | 说明                                                                                                                                                                                            | 缓解                                                                                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P2（注入框架）**                    | P2 提供 cache_control / prompt_cache_key / header 的**注入位置**；P3 只提供数据与开关（`CacheBehavior` / `derive_prompt_cache_key` / `session_affinity_headers`）。P1/P2 均已落盘（2026-08-03） | 接口签名在本文件冻结；按 A1 审计合并规则回写（见 §3.2.1 / §3.3.1 / §3.3.2 标注，接口以 P2 的 request/cache.rs 为真源）【A1 审计修正：原稿"写本文档时 03-plans/ 为空"已过时】 |
| **通用基础层（历史回流 / 前缀稳定）** | 无跨轮前缀时缓存命中恒为 0（comparison.md 4.1），矩阵与目录的收益无法兑现                                                                                                                       | 本方案只交付"开关与数据"，收益验证依赖基础层计划；矩阵的 `auto_cache` 语义在无回流时仍成立（工具循环内同 run 多轮也可命中）                                                  |
| **usage 解析补齐（格式层）**          | DeepSeek 顶层 hit/miss / Kimi 顶层 cached_tokens 未解析时，命中数据不可见                                                                                                                       | 属其他计划；catalog 的计量字段表（§11.2 两套标准）为其提供字段清单                                                                                                           |
| **数据时效**                          | 目录数据截至 2026-08-02；Sonnet 5 九月涨价、DeepSeek 峰谷定价、v4-pro Responses 时间待公告                                                                                                      | catalog 版本号 + 刷新清单（00 catalog §12.3）+ `source_url/data_verified_at` 溯源字段                                                                                        |

### 6.2 风险

| 风险                                                                         | 等级             | 应对                                                                                                                                    |
| ---------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 自建网关 vendor 推断失败（baseUrl 无关键字）→ 全保守默认，缓存字段全部不注入 | 中               | Auto 保守是刻意设计（jcode 教训：不确定就视为不支持）；提供 `provider-config.json extra.vendor` 显式声明字段作为精确路径（步骤 5 可选） |
| GLM Anthropic 端点 cache_control 行为未实测                                  | 中               | 矩阵标记 unverified，行为按"不发断点"；实测后改一行表数据（步骤 6 回写）                                                                |
| 转售通道价与官方直连价差异（方舟/千帆 DeepSeek 量级不同，00 catalog §13.4）  | 中               | 目录按 `provider` 区分条目（键 = `{vendor}::{model}`），价格按通道取；P5 计算时必须区分 channel                                         |
| 模型名版本后缀/微调后缀漂移导致 miss                                         | 低               | 多级兜底（去版本后缀）在 `lookup` 内实现，测试钉死                                                                                      |
| reasoning_content 回放放大 miss 输入                                         | 低（已量化认知） | Reasonix 实测为命中率天花板（deepseek-reasonix-cache-analysis.md:222）；接受并在 UI 如实显示（测量层）                                  |
| 内置 JSON 转录错误（价格/能力位）                                            | 低               | serde 全量解析测试 + `source_url` 溯源 + 刷新清单核销                                                                                   |
| catalog.json 体积增长                                                        | 低               | 起步 ~27 条（几十 KB）；即使扩到 LiteLLM 量级（1.7MB）也仅为 include_str! 内存常驻，可接受；后续可拆 lazy 加载                          |

### 6.3 与其他计划边界（责任矩阵）

| 计划                  | 负责                                                                                       | 不负责                                    |
| --------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------- |
| **P2**                | 注入框架（断点/键/header 的写入位置、engine.rs:250-256 扩展、Anthropic Messages 端点接线） | 不决定"哪个厂商注入什么"（决策数据在 P3） |
| **P3（本方案）**      | 目录数据结构与数据源、行为矩阵、键推导规则、DeepSeek 适配开关、TTL 表                      | 不写请求注入逻辑、不算成本、不做命中率 UI |
| **P4（压缩/恢复层）** | CompactionEngine 接线、窗口钳制                                                            | 窗口值从 P3 `context_window_for` 读取     |
| **P5（成本/测量）**   | 价格计算（消费 catalog 价格字段）、命中率统计、冷缓存预警（消费 P3 TTL 表）                | 不定义价格数据结构（在 P3）               |
| **通用基础层**        | 历史回流、tools 排序、system prompt 透传                                                   | —                                         |

---

## 附：本方案引用的关键文件行号索引

| 主题                                     | 位置                                                             |
| ---------------------------------------- | ---------------------------------------------------------------- |
| ReasoningVendor / infer_reasoning_vendor | crates/agent-provider/src/request/vendor.rs:14-41、277-310       |
| MODEL_SERIES_CAPABILITIES 最长前缀表     | crates/agent-provider/src/request/vendor.rs:219-271              |
| ProviderConfig（provider_id/extra 透传） | crates/agent-provider/src/config.rs:93-125                       |
| config_update 五参数                     | apps/agent-workbench/src-tauri/src/config/provider.rs:501-553    |
| build_chat_completions_request_body      | crates/agent-provider/src/request/build.rs:102-177               |
| ChatMessage 无 cache_control             | crates/agent-provider/src/request/messages.rs:62-104             |
| ReasoningContentMode                     | crates/agent-provider/src/request/messages.rs:19-28              |
| 请求仅 Authorization 头 / provider_url   | apps/agent-workbench/src-tauri/src/engine.rs:250-256、168-174    |
| system_prompt 恒 None                    | apps/agent-workbench/src-tauri/src/engine.rs:220                 |
| core_run_task 签名（有 session_id）      | apps/agent-workbench/src-tauri/src/core_run_commands.rs:919-929  |
| scanProviderModels 无缓存                | apps/crish-desktop/src/api/modelCatalog.ts:688-771               |
| ModelMeta / crish_model_meta_v1          | apps/crish-desktop/src/api/modelCatalog.ts:16、32-49             |
| fetchLatestModels DEAD                   | apps/crish-desktop/src/api/clientApi.ts:822-824                  |
| pricingStore 全局乘数                    | apps/crish-desktop/src/api/pricingStore.ts:22-51、99-121         |
| parse_usage 缺 DeepSeek/Kimi 字段        | crates/agent-provider/src/parse/chat.rs:251-267                  |
| jcode TTL 路由表                         | jcode-cache-analysis.md:2774-2799（provider/mod.rs）             |
| Reasonix reasoning_content 回放          | deepseek-reasonix-cache-analysis.md:116-127（openai.go:658-680） |
| Reasonix DeepSeek 省略 cache_control     | deepseek-reasonix-cache-analysis.md:100-114（anthropic.go:384）  |
| LiteLLM 目录三件套                       | litellm-cache-analysis.md:464-467                                |
| 字段结构草案                             | 00-vendor-model-pricing-catalog.md §12.1                         |
| 厂商矩阵事实                             | vendor-cache-mechanisms.md §10；vendor-cache-gaps.md §六         |

---

## ⑦ 实施核销（R3 完成，2026-08-03）

> 核销范围：R3 轮 T-18~T-25（代码面）+ T-26（本文档回写）。逐节核对本方案 ④ 实施步骤与
> ⑤ 验收标准在 `crates/agent-provider/src/models/`、`request/`、`engine.rs`、壳层命令面的实际
> 落地情况，以及实施中与方案正文的差异裁决。全部结论基于 2026-08-03 实读代码。
> 转录数据面核销（28 条落地条目与转录差异）见 `00-vendor-model-pricing-catalog.md §12.4`。

### 7.1 步骤 1-6 完成状态

| 步骤 | 内容                                | 状态                                         | 落地证据（文件:行号）                                                                                                                                                                                                                                                  |
| ---- | ----------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | catalog 骨架 + 内置 JSON            | **完成**                                     | `models/catalog.rs`（ModelCatalogEntry 全字段 Option/Default 满足 A3 P2-10；`bundled()` 以 include_str! 打包；`lookup` 多级兜底 精确→去版本后缀→vendor 默认→None）、`models/catalog.json`（28 条）、`models/mod.rs`                                                    |
| 2    | VendorId 与行为矩阵                 | **完成**                                     | `models/behavior.rs`（VendorId 11 变体 / `infer_vendor` / `CacheBehavior` / 静态矩阵 / `MODEL_SERIES_CACHE_BEHAVIOR` 系列表 / `cache_behavior_for`）                                                                                                                   |
| 3    | 缓存键推导与 TTL 表                 | **完成（含一处定义位裁决，见 7.2.1）**       | `models/cache_key.rs`（`derive_prompt_cache_key` 等价委托 C4 / `session_affinity_headers`）、`models/ttl.rs`（`cache_ttl_for_provider_model`）                                                                                                                         |
| 4    | DeepSeek 专用适配                   | **完成（只补测试 + engine 判定）**           | `request/deepseek_invariants.rs`（6 个测试钉死，不实现第二遍接线，C1）；`engine.rs:193-242`（`provider_url` 降级 + `responses_supported` + `BUNDLED_CATALOG`）                                                                                                         |
| 5    | 用户覆盖与运行时合并 + 命令三处登记 | **命令侧完成；前端上送面未接线（见 7.2.3）** | `catalog.rs:232-466`（`with_overrides` / `upsert_from_scan`）、`catalog_commands.rs`（catalog_get / catalog_refresh）、`command_manifest.rs:150-151`、`main.rs:155-156`、`main.rs:319-323`（`Arc<RwLock<ModelCatalog>>` 挂 Tauri state）、`commandManifest.ts:135-137` |
| 6    | 文档回写                            | **完成**                                     | 本文件 ⑦ 节 + 00-catalog §12.4（T-26）                                                                                                                                                                                                                                 |

### 7.2 与实现在代码中的差异（裁决记录）

#### 7.2.1 CacheTtl 定义位：behavior.rs 而非 ttl.rs

- 方案 §3.5 计划 `CacheTtl` 定义在 `models/ttl.rs`（T-21）；实际 **T-19 在 `behavior.rs` 定义了 `CacheTtl` 本体**（含 serde 值域 `"5m"/"1h"/"24h"`、`seconds()`、`parse()`，behavior.rs:66-101），`ttl.rs` 经 `pub use super::behavior::CacheTtl` re-export（ttl.rs:19）并按任务书契约在固有 impl 补 `as_str()`（ttl.rs:23-34）。
- 裁决记录：C3 的实质目标（同 crate 单一类型 + serde 值域对齐 + 与 P2 wire 桶 `TtlBucket` 无同名冲突）已满足；分工为 behavior.rs 持有类型本体、ttl.rs 提供 TTL 路由查询；behavior.rs:66-68 注释明示「TTL 路由表（T-21 models/ttl.rs）如需本类型应 re-export 而非重定义，避免同 crate 两套同名枚举漂移」。

#### 7.2.2 build_cache_policy 仍用 PlaceholderCatalog（待接线记录）

- P2 `request/cache.rs:254-306`：`build_cache_policy` 签名仍为 `catalog: Option<&PlaceholderCatalog>`；占位实现恒 None，等价「无 catalog」→ 回退内置保守兜底表 `infer_cache_capability`；`engine.rs:294-300` 实传 None（C2 唯一运行时入口不变）。
- **待接线**：R3 数据真源（`cache_behavior_for` + catalog 模型级覆盖）尚未接入 `build_cache_policy`。engine.rs:290-293 注释明示「catalog 传 None：R3 T-18/T-19 交付后替换为真实 ModelCatalog」。接线 = 以 `models::ModelCatalog` 替换占位（或按 C2 把 `CacheBehavior` 映射归并进 `CacheCapability`），归 R3 收尾/R2 数据真源完整化（T-17 验收用例复验）。
- 行为等价性说明：占位期间 DeepSeek 直判省略（cache.rs:319-327）与内置表转录值（以本方案 §3.2.2 矩阵为准）已由 T-22 `deepseek_invariants.rs` 测试钉死，无行为漂移风险。
- engine.rs:145-149 `extra` 通道恒空表（overrides=None），配置面透传待后续接入。

#### 7.2.3 T-25 前端扫描上送未接线

- `catalog_refresh` 命令（catalog_commands.rs:52-58）与三处登记（command_manifest.rs / main.rs / commandManifest.ts）均完成，但 `modelCatalog.ts` 的 `scanProviderModels`（modelCatalog.ts:725-819）**未调用 `catalog_refresh`**——前端上送消费侧缺失，列为待接线项（命令面已就绪，消费面补齐即可闭合步骤 5b）。

#### 7.2.4 engine.rs Responses 判定的目录形态

- T-23 用 `BUNDLED_CATALOG` OnceLock 静态实例（engine.rs:204-213），未使用 main.rs:319-323 挂的运行时 `Arc<RwLock<ModelCatalog>>` 实例；engine.rs:207-208 注释注明「T-24 壳侧挂 Arc<RwLock> 后此处可换为运行时实例，内置表即当前数据真源」。
- `responses_vendor`（engine.rs:231-242）经 `infer_reasoning_vendor` 映射目录 vendor 字符串；Grok/MiniMax/Dashscope 不在 `ReasoningVendor` 内 → 一律 None（保留现状不降级，避免对未识别网关臆断）。

#### 7.2.5 C7 三处登记实现方式

- ③ 的 mock-engine.ts 快照未直接编辑，而是经 mock-engine.ts:30 从共享清单 `apps/crish-desktop/src/api/transport/commandManifest.ts` 导入 `BUILTIN_COMMAND_MANIFEST`（该清单 :135-137 新增 `catalog_get` / `catalog_refresh` 两条，commandManifest.test.ts:35 断言接线）——与任务书「编辑 mock-engine.ts 快照行」的表述有实现方式差异，效果等价（mock 对未登记命令抛 missing 的约束同样成立）。

#### 7.2.6 A1-13 计数表述核销

- 实读计数：`ChatMessage` 生产构造点 = **4 组**（messages.rs:400 Tool / :434 Assistant / :451 User 三处 + `system_prompt_message` 辅助函数 :466 一处，其中 NativeSystemRole 与 UserPrefix 两个 wire 变体 :468/:476 属同一组函数）；各构造点均已补 `cache_control: None`。
- P2 §3.2 原表述「现有 ChatMessage 构造点共 5 处（4 处区间）」计数不符 → 按 A1-13 裁决以实读为准，核销为 **「4 组构造点」**（测试辅助构造 cache.rs:1231/1436/1491、messages.rs:1045 不计入生产构造点）。

#### 7.2.7 R0.5 表 3 #1 部分消化

- kimi-k3 / glm-4.7 的**缓存行为维度**已由 `MODEL_SERIES_CACHE_BEHAVIOR` 系列表显式收录（behavior.rs:371-394，测试 `kimi_k3_resolves_to_kimi_family_behavior` / `glm_4_7_resolves_to_conservative_glm_behavior` 钉死）；
- **vendor.rs `MODEL_SERIES_CAPABILITIES` 思考能力表未改行**（kimi → NO_THINKING、glm → NO_THINKING 维持）——behavior.rs:15-17 注释明示「vendor.rs 思考能力表缺行属其文件域，补全需求经轮末汇总物移交主 Agent 协调」→ 标注移交后续。

### 7.3 ⑤ 验收标准核销

| 验收项                             | 结果           | 证据（测试/代码）                                                                                                                                                                                                                                                                  |
| ---------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 编译与回归                       | 由轮末门禁记录 | `cargo test --workspace`（73 套件基线不退步，以轮次报告为准）                                                                                                                                                                                                                      |
| 2 矩阵行为                         | 通过           | behavior.rs 测试：`deepseek_always_omits_cache_control` / `minimax_m3_disables_active_caching_while_m2_keeps_breakpoints` / `grok_exposes_conv_header_and_prompt_cache_key` / `dashscope_exposes_session_cache_header_and_breakpoints` / `auto_falls_back_to_conservative_all_off` |
| 3 目录解析                         | 通过           | catalog.rs 测试：`lookup_exact_match_hits_bundled_entry` / `lookup_strips_version_suffix` / `lookup_unknown_model_and_vendor_yield_none`；`supports_responses_for` v4-flash=true / v4-pro=false                                                                                    |
| 4 键推导                           | 通过           | cache_key.rs 测试：`derive_prompt_cache_key_clamps_codepoints_without_panic`（中文/emoji 不截半字符）/ `grok_chat_track_injects_conv_header_with_codepoint_64_value` / 空输入 None                                                                                                 |
| 5 DeepSeek 请求体不变量            | 通过           | deepseek_invariants.rs 6 个测试（cache_control 键全省略 / tool_calls 回合必带 reasoning_content / 矩阵 omit 联动）                                                                                                                                                                 |
| 6 TTL 表                           | 通过           | ttl.rs 测试：`vendor_defaults_without_catalog` / `openai_ttl_tiers_gpt55_day_gpt56_short`（A1-11）/ `catalog_entry_overrides_vendor_default`                                                                                                                                       |
| 7 无越界（cache_control 落点审计） | 通过           | `git grep "cache_control"` 落点 = behavior.rs/catalog.rs（矩阵数据与注释）、cache.rs/build.rs/tools.rs/messages.rs（P2 注入框架）、deepseek_invariants.rs（测试断言）——无绕过矩阵的新散落判定                                                                                      |

### 7.4 遗留与移交清单

| #   | 项                                                                      | 归属                                                              |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | `build_cache_policy` 接入真实 `ModelCatalog`（PlaceholderCatalog 替换） | R3 收尾/R2 数据真源完整化（T-17 验收用例复验）                    |
| 2   | T-25 前端 `modelCatalog.ts` 扫描上送接线（调用 `catalog_refresh`）      | 前端侧待接线                                                      |
| 3   | vendor.rs 思考能力表 kimi-k3/glm-4.7 行（R0.5 表 3 #1 思考能力维度）    | 移交主 Agent 协调                                                 |
| 4   | GLM Anthropic 端点 cache_control 实测                                   | 实测后改 behavior.rs 矩阵 + 本文件 §3.2.2 表格（步骤 6 回写约定） |
| 5   | 目录条目 `cache_ttl` 与行为矩阵 `default_ttl` 双轨一致性维护            | 后续数据刷新时同步                                                |
| 6   | 峰谷定价生效日期 / v4-pro Responses 加入时间 / Sonnet 5 九月涨价        | 00-catalog §12.3 刷新清单跟踪（catalog.json 条目随官方公告更新）  |
