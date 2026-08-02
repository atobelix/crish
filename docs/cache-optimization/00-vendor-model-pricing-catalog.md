# 厂商模型与定价 Catalog（crish 数据权威来源）

> 本文档是 crish 后续所有缓存/成本计算的数据权威来源，覆盖：模型清单、上下文窗口、输入/输出/缓存命中/缓存写入价格、最低可缓存 token、缓存机制与计量字段。

## 文档信息

- **用途**：成本计算（token 级）、缓存收益评估（命中价差、写入成本、存储费）、模型能力判断（上下文窗口、断点/Responses 支持）的数据基准
- **数据获取日期**：2026-08-02（各节价格抓取自当日各厂商官方文档/官方定价表）
- **维护规则**：
  - 模型与价格更新极快，本文档不适合长期手工维护，建议未来由 agent 按需刷新（见「定价模型设计建议」中的刷新清单）
  - 每节标注来源 URL，刷新时以官方文档为准并更新「数据获取日期」与条目级 `source_url`
  - 价格单位为 **USD/百万 tokens**（标注 `$`）或 **CNY/百万 tokens**（标注 `¥`），混用时逐表注明
  - 未核实的条目一律标注「未获取/未确认」，不编造数字
- **关联文档**：`docs/cache-optimization/01-reference-research/vendor-cache-gaps.md`（Qwen/DeepSeek v4 0731/GLM 缺口补充核实）；原始调研草稿见调度者素材

---

## 1. Anthropic（Claude）

**来源 URL**：
- https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching（缓存机制）
- 定价表由用户提供（官方定价页，2026-08-02，权威）

### 1.1 官方定价表（2026-08-02 用户提供，完整收录）

| 模型 | 基础输入 | 5m 缓存写入 | 1h 缓存写入 | 缓存命中与刷新 | 输出 |
|---|---|---|---|---|---|
| Claude Fable 5 | $10 / MTok | $12.50 / MTok | $20 / MTok | $1 / MTok | $50 / MTok |
| Claude Mythos 5 (limited availability) | $10 / MTok | $12.50 / MTok | $20 / MTok | $1 / MTok | $50 / MTok |
| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.7 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.6 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.1 (deprecated) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Opus 4 (retired, except Google Cloud) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Sonnet 5 (through August 31, 2026) | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
| Claude Sonnet 5 (starting September 1, 2026) | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Sonnet 4.6 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Sonnet 4.5 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Sonnet 4 (retired, except Bedrock/Google Cloud) | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |
| Claude Haiku 3.5 (retired, except Bedrock/Google Cloud) | $0.80 / MTok | $1 / MTok | $1.60 / MTok | $0.08 / MTok | $4 / MTok |

价格规律：5m 写 = 基础输入 × 1.25；1h 写 = × 2；命中与刷新 = × 0.1。

### 1.2 最低可缓存 token 明细（官方文档）

| 模型 | 最低可缓存 token |
|---|---|
| Opus 5 / Fable 5 / Mythos 5 | 512 |
| Mythos Preview / Opus 4.7 | 2048 |
| Opus 4.6 / 4.5 | 4096 |
| Opus 4.8 / Sonnet 5 / Sonnet 4.6 / 4.5 | 1024 |
| Haiku 4.5 | 4096 |

### 1.3 TTL 与断点规则

- **双模式**：
  - Automatic caching：请求顶层 `cache_control: {"type":"ephemeral"}`，系统自动把断点放在最后一个可缓存块，随对话增长自动前移（多轮对话推荐）
  - Explicit breakpoints：块级 `cache_control` 精细控制
- **断点上限**：最多 4 个断点；自动缓存占用 1 个槽位，超出/冲突返回 400
- **TTL**：默认 5 分钟（ephemeral，命中刷新免费）；1 小时需显式 `ttl:"1h"`（写入价 2x），且 1h 条目必须位于 5m 条目之前
- **回溯**：20 块 lookback 窗口；缓存前缀顺序 tools → system → messages（累计哈希，前缀内任何变更整体失效）
- **写入时机**：cache write 只在断点发生；缓存条目在首个响应开始后才可用（并发请求注意）
- **计量字段**：`cache_creation_input_tokens`（写入）、`cache_read_input_tokens`（读取）、`input_tokens`（断点后未缓存部分）；1h 缓存细分在 `usage.cache_creation.ephemeral_5m/1h_input_tokens`
- **Responses API**：无，仅 Messages API；自动缓存与显式断点可混用

### 1.4 上下文窗口（补充：本地 LiteLLM catalog 副本）

| 模型 | 输入窗口 | 输出上限 |
|---|---|---|
| claude-sonnet-5 | 1,000,000 | 128,000 |
| claude-haiku-4-5 | 200,000 | 64,000 |

---

## 2. OpenAI（GPT-5.x）

**来源 URL**：
- https://platform.openai.com/docs/guides/prompt-caching（缓存机制）
- 定价页官方按量计费表本次调研未抓取；下表价格来自本地 LiteLLM catalog 副本 `reference/litellm/model_prices_and_context_window.json`（2026-08-02）

### 2.1 缓存机制要点

- 自动 prompt caching，gpt-4o 及更新模型默认启用，无需 cache_control
- **GPT-5.6 及以后模型族**引入显式断点机制：
  - `prompt_cache_options.mode`：`implicit`（默认，自动断点在最新 user/tool 消息；不回退找最长前缀——与旧模型关键差异）/ `explicit`（只用显式断点，避免为变化后缀付写入费）
  - `prompt_cache_breakpoint {"mode":"explicit"}`：Responses 支持 input_text/input_image/input_file 块；Chat Completions 支持 text/image_url/input_audio/file/refusal 块；每请求最多 4 个写入断点（implicit 占用 1 个，故显式最多 3 个）；读取考虑最近 50 个断点
- `prompt_cache_key`：路由优化（与前缀哈希结合）；GPT-5.6+ 需设置才能用更可靠的匹配；每 key 流量约 15 请求/分钟，超出可能 miss
- **最低缓存前缀**：GPT-5.6+ 严格 1024 tokens；GPT-5.5 及更早 1024-2048 依模型而定
- **TTL**：GPT-5.6+ `prompt_cache_options.ttl` 仅支持 30m（最小保留期）；旧模型 `prompt_cache_retention`：`in_memory`（5-10 分钟活跃、上限 1h）或 `24h extended`（gpt-5.5、gpt-5.4、gpt-5.2、gpt-5.1 系、gpt-5、gpt-4.1）
- **写入费用**：GPT-5.6+ 写 = 1.25x 未缓存输入价；旧模型写免费
- **计量字段**：Responses 用 `usage.input_tokens_details.cached_tokens`（读）+ `cache_write_tokens`（写）；Chat Completions 用 `usage.prompt_tokens_details.cached_tokens` + `cache_write_tokens`
- 缓存不影响输出生成与速率限制（TPM 含缓存 token）

### 2.2 模型清单与价格（litellm 本地副本口径，$/1M）

| 模型 | 输入窗口 | 输出上限 | 输入价 | 命中价 | 写入价 | 备注 |
|---|---|---|---|---|---|---|
| gpt-5.6 | 1,050,000 | 128,000 | $5.00 | $0.50 | $6.25（1.25x） | 写价 1.25x；TTL 仅 30m；最低 1024 |
| gpt-5.5 | 1,050,000 | 128,000 | $5.00 | $0.50 | 写免费（旧轨） | 支持 24h extended 保留 |
| gpt-5.4 / 5.2 / 5.1 / 5 / 4.1 | 未获取 | 未获取 | 未获取 | 未获取 | 写免费（旧轨） | 支持 24h extended 保留；最低 1024-2048 |

> 注：gpt-5.6/gpt-5.5 价格取自 litellm 副本（`input_cost_per_token=5e-06`、`cache_read_input_token_cost=5e-07`、`cache_creation_input_token_cost=6.25e-06`）；其余型号价格未获取，刷新时以 platform.openai.com 按量计费页为准。

---

## 3. DeepSeek

**来源 URL**：
- https://api-docs.deepseek.com/guides/kv_cache（KV 缓存）
- https://api-docs.deepseek.com/guides/responses_api（Responses API）
- https://api-docs.deepseek.com/quick_start/pricing（定价）

### 3.1 模型清单与价格（$/1M，2026-08-02 已确认）

| 模型 | 上下文窗口 | 输入（未命中） | 输入（命中） | 输出 | 命中/未命中比 |
|---|---|---|---|---|---|
| deepseek-v4-flash (0731) | 1,000,000 | $0.14 | $0.0028 | $0.28 | 2% |
| deepseek-v4-pro | 1,000,000 | $0.435 | $0.003625 | $0.87 | ≈0.83% |

- 输出最大 384K（Responses API 文档口径）
- 命中价仅为未命中的 2%（flash）/0.83%（pro），是全行业价差最大的厂商
- **峰谷定价（即将实施）**：高峰时段（北京时间 9:00-12:00、14:00-18:00）价格 2 倍，生效日期待官方公告——成本计算必须预留该因子
- 本地 litellm 副本中 deepseek-v4-flash 为 `input 1.4e-07/token`（$0.14/1M）、`cache_read 2.8e-09`（$0.0028/1M）、`cache_creation 0`，与官方一致

### 3.2 缓存机制要点

- 自动磁盘前缀缓存（Context Caching on Disk），全用户默认启用，零代码改动
- 2026 版（SWA 滑动窗口注意力）下缓存单元为独立完整的「缓存前缀单元」（cache prefix unit），命中要求完全匹配某个前缀单元，不再逐 token 匹配
- 持久化时机 3 种：① 请求边界（用户输入末尾、模型输出末尾各一个单元）；② 多请求公共前缀检测后持久化；③ 长输入/长输出按固定 token 间隔切出单元
- 磁盘缓存构建需数秒；不再使用时数小时到数天内自动清除；best-effort 不保证 100% 命中
- cache_control：不支持，无任何手动断点参数；`prompt_cache_key` / `prompt_cache_retention` 不支持（静默忽略，缓存全自动管理）
- **Responses API**：v4-flash 已支持；v4-pro 官方口径「2026 年 8 月初」加入
- 计量字段：Chat Completions 用 `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；Responses API 用 `usage.input_tokens_details.cached_tokens`

---

## 4. 智谱 GLM（z.ai / open.bigmodel.cn）

**来源 URL**：
- https://docs.z.ai/guides/capabilities/cache（缓存）
- https://docs.z.ai/guides/llm/glm-4.7（GLM-4.7 保留式推理）
- https://docs.z.ai/guides/overview/pricing（定价）
- https://docs.z.ai/devpack/tool/claude（Claude Code 集成，Anthropic 端点）

### 4.1 模型清单与价格（$/1M，缓存存储限时免费）

| 模型 | 上下文窗口 | 输入 | 命中 | 输出 | 备注 |
|---|---|---|---|---|---|
| GLM-5.2（最新旗舰） | 1,000,000 | $1.40 | $0.26 | $4.40 | 命中 = 18.6% |
| GLM-5 | 未获取 | $1.00 | $0.20 | $3.20 | 命中 = 20% |
| GLM-4.7 / 4.6 / 4.5 | 200K（4.7，Flash 免费版除外） | $0.60 | $0.11 | $2.20 | 命中 ≈ 18%；4.7 最大输出 128K |
| GLM-4.5-Air | 未获取 | $0.20 | $0.03 | $1.10 | 命中 = 15% |

- 命中价约为标准输入价的 15%~20%（按定价页表格计算）；注意官方缓存文档另有示例口径「usually 50% of standard price」（0.005/0.01 示例）——两处口径并存，计算时以定价页数字为准
- GLM-4.7 支持 Thinking Mode 与「保留式推理」（自动保留多轮推理块以提高缓存命中率，适合长期复杂任务）

### 4.2 缓存机制要点

- 自动隐式缓存：官方「Implicit caching that intelligently identifies repeated context content without manual configuration」，基于内容相似度识别（非严格前缀哈希），轻微格式差异即可能失效，过期自动重算
- cache_control：官方缓存文档未提供 Anthropic 式断点支持；Anthropic 兼容端点 `https://api.z.ai/api/anthropic` 存在（Claude Code 通过 `ANTHROPIC_BASE_URL` 接入），**是否处理 cache_control 未确认，需实测**
- 计量字段：`usage.prompt_tokens_details.cached_tokens`（OpenAI Chat Completions 兼容 v4 格式）
- Responses API：官方文档未提及
- 百炼通道价格不同：GLM 在阿里云百炼隐式缓存折扣 20%~25%、最低缓存 token 512（见第 11 节）

---

## 5. 月之暗面 Kimi

**来源 URL**：
- https://platform.kimi.com/docs/guide/use-context-caching-feature-of-kimi-api.md（缓存）
- https://platform.kimi.com/docs/pricing/chat-k3.md（K3 定价）
- https://platform.kimi.com/docs/api/chat.md（API）

### 5.1 模型清单与价格（¥/1M）

| 模型 | 上下文窗口 | 输入（未命中） | 命中 | 输出 | 命中占比 |
|---|---|---|---|---|---|
| kimi-k3 | 1,048,576 | ¥20.00 | ¥2.00 | ¥100.00 | 10%（90% 折扣） |
| kimi-k2.7 / k2.6 / k2.5 | 未获取 | 未获取 | 未获取 | 未获取 | — |

### 5.2 缓存机制要点

- 全自动 Context Caching：对所有模型（K2.5/K2.6/K2.7/K3）自动启用；无需手动创建、无缓存 ID、无 TTL 管理
- **最低缓存量**：前一请求 prompt tokens > 256 才会被缓存；≤256 的请求不被缓存
- 命中条件：检测到重复的初始上下文（system prompt、知识文档、工具定义、历史消息）自动复用
- 命中场景：固定长上下文高频查询，首 Token 延迟平均 <5s，最高可降本 90%
- cache_control：不支持（纯自动）；另有 `prompt_cache_key` 请求参数（session/task id 语义，Coding Plan 必填）提升命中率（路由辅助，非显式断点）
- 计量字段：`usage.cached_tokens`（OpenAI 兼容格式，顶层 usage 字段，非嵌套 details）

---

## 6. xAI Grok

**来源 URL**：
- https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works
- https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing
- https://docs.x.ai/developers/models
- https://docs.x.ai/prompt-caching（总览）

### 6.1 模型清单与价格（$/1M）

| 模型 | 标准输入 | 标准命中 | 标准输出 | ≥200K prompt 输入 | ≥200K 命中 | ≥200K 输出 |
|---|---|---|---|---|---|---|
| grok-4.5 | $2.00 | $0.30 | $6.00 | $4.00 | $0.60 | $12.00 |
| grok-4.3 | $1.25 | $0.20 | $2.50 | 未获取 | 未获取 | 未获取 |
| grok-4.20-0309 | 同 grok-4.3 | 同 grok-4.3 | 同 grok-4.3 | — | — | — |

- 命中价为标准输入价的 15%
- 长上下文定价：≥200K prompt tokens（含缓存）按长上下文价计费（约 2x）

### 6.2 缓存机制要点

- 自动 prompt caching：连续请求共享相同开头消息时自动缓存；从 messages 数组开头做精确前缀匹配
- 不保证 100% 命中：内存压力驱逐、请求路由到不同服务器都会导致 miss
- cache_control：无（无 Anthropic 式断点；TTL 服务端管理，未公布具体值）
- **命中率提升手段**：`x-grok-conv-id` HTTP 头（Chat Completions / gRPC metadata，粘性路由）或 `prompt_cache_key` 字段（Responses API，UUID，功能等同）
- 计量字段：Chat Completions 用 `usage.prompt_tokens_details.cached_tokens`；Responses API 用 `usage.input_tokens_details.cached_tokens`（xAI 主推 Responses API /v1/responses）

---

## 7. MiniMax

**来源 URL**：
- https://platform.minimaxi.com/docs/api-reference/text-prompt-caching（被动/自动缓存）
- https://platform.minimaxi.com/docs/api-reference/anthropic-api-compatible-cache（主动缓存）

### 7.1 模型清单与价格（¥/1M，双轨制）

| 模型 | 输入 | 缓存读取 | 缓存写入 | 输出 | 缓存轨 |
|---|---|---|---|---|---|
| MiniMax-M2.7 | ¥2.10 | ¥0.42（20%） | ¥2.625（125%） | ¥8.40 | 主动（Anthropic 式）+ 被动 |
| MiniMax-M2.5 / M2.1 / M2 | ¥2.10 | ¥0.21（10%） | ¥2.625（125%） | ¥8.40 | 主动（Anthropic 式） |
| MiniMax-M3 | ¥4.20 | ¥0.84（20%） | 无写入费 | ¥16.80 | 仅被动（**不支持主动缓存**） |

### 7.2 缓存机制要点（双轨制最完整的厂商）

**A. Prompt 缓存（被动/自动，OpenAI 与 Anthropic 兼容端点均生效）**
- 自动识别重复上下文（工具定义 → 系统提示 → 历史消息顺序前缀匹配）
- 最低缓存量：512 个输入 token；写入无额外计费；过期时间随系统负载自动调整
- 支持模型：M3、M2.7、M2.5、M2.1 系列
- 计量字段：OpenAI 格式 `usage.prompt_tokens_details.cached_tokens`；Anthropic 格式 `usage.cache_read_input_tokens`

**B. Anthropic 主动缓存（显式 cache_control）**
- 完整复刻 Anthropic 语义：`cache_control {"type":"ephemeral"}`；最多 4 个断点（超出只取从后往前最近 4 个）；20 块回溯窗口；可缓存 tools/system/messages（含 tool_use/tool_result）；thinking 块不可直接标记
- TTL 5 分钟，命中自动续期，续期免费；首次写入额外计费（1.25x 输入价）
- 支持模型：M2.7/M2.5/M2.1/M2 系列（**M3 不支持主动缓存**）
- 计量字段：`cache_creation_input_tokens` / `cache_read_input_tokens` / `input_tokens`（= 断点后 token）
- M3 输入 >512k 时适用长上下文价格（输入 token 含缓存命中部分）

---

## 8. Google Gemini

**来源 URL**：
- https://ai.google.dev/gemini-api/docs/caching（缓存）
- https://ai.google.dev/gemini-api/docs/generate-content/caching
- https://ai.google.dev/gemini-api/docs/pricing（定价）

### 8.1 模型清单与价格（$/1M）

| 模型 | 输入 | 命中 | 存储费 | 备注 |
|---|---|---|---|---|
| Gemini 3.6 Flash | $1.50 | $0.15 | $1.00 / 1M·h | 命中 = 10% |
| Gemini 3.5 Flash | $0.75 | $0.075 | 未获取 | 隐式最低 4096 tokens |
| Gemini 3.5 Flash-Lite | $0.30 | $0.03 | 未获取 | 命中 = 10% |
| Gemini 3.1 Pro | $1.25（≤200k） | $0.125 | $4.50 / 1M·h | 超过 200k 另有长上下文价 |

- 命中价 ≈ 标准输入价的 10%

### 8.2 缓存机制要点（双轨制）

**A. Implicit caching（隐式缓存）**
- Gemini 2.5 及更新模型默认启用（含 Gemini 3.5 Flash、3.1 Pro Preview）；stateful（previous_interaction_id）与 stateless 均支持
- 不保证命中（no cost saving guarantee）
- 最低 token 数：Gemini 3.5 Flash / 3.1 Pro Preview = 4096；Gemini 2.5 Flash / Pro = 2048
- 计量：`usage_metadata` 中的 `total_cached_tokens`

**B. Explicit caching（显式 cachedContents API）**
- `POST /v1beta/cachedContents` 创建缓存（contents + system_instruction + ttl），请求时以 `cachedContent: <name>` 引用；支持 list/get/update/delete
- TTL 默认 1 小时，无最小/最大限制；**存储按「缓存 token 数 × 时长」计费**
- 有成本节省保证；OpenAI 库可通过 `extra_body: {cached_content: ...}` 启用
- Interactions API（新推荐接口）仅支持隐式缓存，不支持显式缓存

---

## 9. 火山方舟 / 豆包（ByteDance）

**来源 URL**：https://www.volcengine.com/docs/82379/1544106

### 9.1 模型清单与价格（¥/1M，含缓存存储费 0.017 元/百万 token/小时）

| 模型 | 输入 | 命中 | 输出 | 备注 |
|---|---|---|---|---|
| doubao-seed-2.1-pro | ¥6.00 | ¥1.20（20%） | ¥30.00 | |
| doubao-seed-2.1-turbo | ¥3.00 | ¥0.60 | ¥15.00 | |
| doubao-seed-2.0-mini | ¥0.20 | ¥0.04 | ¥2.00 | |
| deepseek-v4-pro（方舟转售） | ¥12.00 | ¥1.00 | ¥24.00 | 与 DeepSeek 官方直连价（$0.435/1M）差异巨大，见注意事项 |
| glm-4.7（方舟转售） | ¥2.0-4.0（分段） | ¥0.4-0.8 | ¥8.0-16.0 | |

### 9.2 缓存机制要点

- 透明前缀缓存：部分模型已支持，无需任何配置；显式缓存管理文档未找到
- 计量字段：本次调研未获取
- 有 Responses API 文档入口；存储费按 token×小时计费，长 TTL 场景需单独核算

---

## 10. 百度千帆 / 文心（ERNIE）

**来源 URL**：https://cloud.baidu.com/doc/qianfan/s/wmh4sv6ya

### 10.1 模型清单与价格（¥/1M，原文为元/千 tokens，已换算）

| 模型 | 输入 | 命中 | 输出 | 备注 |
|---|---|---|---|---|
| ERNIE-4.5-Turbo | ¥0.80 | ¥0.20（25%） | ¥3.20 | |
| ERNIE-4.5-Turbo-VL | ¥3.00 | ¥0.75 | ¥9.00 | |
| DeepSeek-V4-Pro（千帆转售） | ¥12.00 | ¥1.00 | ¥24.00 | 转售价，与官方直连价差异见注意事项 |
| DeepSeek-V4-Flash（千帆转售） | ¥1.00 | ¥0.20 | ¥2.00 | 转售价，与官方直连价差异见注意事项 |

### 10.2 缓存机制要点

- 自动缓存：计费页含「命中缓存」价目
- 平台提供 OpenAI 兼容与 Anthropic API 兼容端点；cache_control 断点支持与否未确认
- 计量字段：未获取（OpenAI 兼容 usage 结构）

---

## 11. 阿里云百炼 Qwen

**来源 URL**：
- https://help.aliyun.com/zh/model-studio/context-cache（上下文缓存）
- https://help.aliyun.com/zh/model-studio/compatibility-with-openai-responses-api（Responses API Session 缓存）

### 11.1 缓存机制要点（三套并存）

**A. 显式缓存（cache_control，与隐式互斥）**
- 需在 messages 的 content 块加 `"cache_control": {"type": "ephemeral"}`（仅 ephemeral）
- 缓存创建计费：输入标准单价的 **125%**；命中计费：**10%**
- 最低可缓存 token：**1024**；有效期 5 分钟（命中后重置）；确定性命中
- 单请求最多 4 个标记；回溯窗口 20 个 content 块；缓存创建发生在模型响应之后
- 支持协议：OpenAI Chat Completions、DashScope、Anthropic 兼容接口（计量字段不同）
- 支持模型（华北2北京为例）：qwen3.7-max、qwen3.6-max-preview、qwen3.5/3.7 系列 Plus、qwen3.7-flash、qwen3-coder-plus/flash、qwen3-vl-plus/flash，以及第三方 deepseek-v3.2、kimi-k2.6/k2.5/k2.7-code、glm-5.1（其他地域见原文）
- **tools 数组中的 cache_control 标记被忽略**：工具定义作为系统消息的一部分参与缓存计算；含 tools 参数时工具定义序列化为 JSON 参与缓存，字段顺序/结构变化即失效
- 建议：并行工具调用时合并 tool 结果为一条消息 + 多个 content 块，避免超出 20 块回溯窗口

**B. 隐式缓存（自动，无法关闭）**
- 前缀匹配（messages 数组公共前缀）；创建无额外费用（100%）；命中为输入单价的 **20%**（多数百炼部署模型）；无手动控制；命中率不确定
- 最低可缓存 token：百炼部署模型 **256**；Qwen3.7 系列约 **2000**；智谱部署 GLM、稀宇 MiniMax 为 **512**
- 计费折扣因模型来源而异（第三方程式部署）：
  - 快手万擎部署：vanchin/deepseek-v4-pro **8.33%**、v3.2-think 10%、v3.1-terminus/r1/v3 40%
  - 月之暗面部署：kimi/kimi-k3 **10%**、kimi/k2.6 16.9%、kimi/k2.5 17.5%
  - GLM 百炼部署：glm-5.2 **25%**，其余 glm 系列 20%
  - 智谱部署：ZHIPU/GLM-5.2/5.1/5 均 **25%**
  - MiniMax 稀宇部署：MiniMax-M3、M2.7 **20%**，M2.5、M2.1 **10%**
- OpenAI 兼容 Batch（文件输入）无法享受缓存折扣

**C. Responses API Session 缓存**
- Header `x-dashscope-session-cache: enable` 开启（默认 disable）；服务端自动缓存对话上下文（结合 previous_response_id 多轮关联）
- 最小可缓存提示词 1024 Token，有效期 5 分钟
- 支持模型：qwen3-max / qwen3.7-max / qwen3.7-plus / qwen3.6-plus / qwen3.5-plus / qwen3.7-flash / qwen3.6-flash / qwen3.5-flash / qwen-plus / qwen-flash / qwen3-coder-plus / qwen3-coder-flash
- 计量：`usage.input_tokens_details.cached_tokens`
- 端点：`POST {base}/compatible-mode/v1/responses`（旧路径 `/api/v2/apps/protocols/compatible-mode/v1/responses` 即将停用）

### 11.2 计量字段（已确认）

| 协议 | 命中缓存计量字段 | 创建缓存计量字段 |
|---|---|---|
| OpenAI Chat Completions | `usage.prompt_tokens_details.cached_tokens` | `usage.prompt_tokens_details.cache_creation_input_tokens` |
| DashScope | 同 OpenAI | 同 OpenAI |
| Anthropic 兼容 | `usage.cache_read_input_tokens`（不计入 input_tokens，单独报告） | `usage.cache_creation_input_tokens` |
| Responses | `usage.input_tokens_details.cached_tokens` | — |

### 11.3 价格说明（诚实边界）

- **Qwen 系列缓存命中绝对单价未获取**：官方文档只给折扣比例（显式命中 10%、创建 125%；隐式命中 20%），绝对价格需查百炼控制台与按量计费页
- 提升命中概率：重复内容放提示词开头、差异内容放末尾；视觉模型对同一图像多次提问时图像放前面，对不同图像问同一问题时文本放前面

---

## 12. 定价模型设计建议（参考 LiteLLM catalog 结构）

crish 未来模型目录建议参考 `reference/litellm/model_prices_and_context_window.json` 的结构（每模型一个条目、全字段扁平、per-token 或 per-1M 统一单位），但按其不足做扩展。LiteLLM 的 `sample_spec` 关键字段：`input_cost_per_token`、`output_cost_per_token`、`cache_read_input_token_cost`、`cache_creation_input_token_cost`、`max_input_tokens`、`max_output_tokens`、`mode`、`supports_prompt_caching`、`supports_reasoning`、`supports_function_calling`、`supports_parallel_function_calling`、`supports_vision`、`supports_system_messages`、`supports_response_schema`、`supports_web_search`、`supports_audio_input`、`supports_audio_output`、`deprecation_date`、`supported_regions`、`litellm_provider`。

### 12.1 建议字段结构（JSON Schema 草案）

```jsonc
{
  "model": "claude-sonnet-5",            // API 模型标识（唯一键）
  "provider": "anthropic",               // 通道/网关标识（如 dashscope、volcengine、qianfan）
  "vendor": "anthropic",                 // 官方厂商（转售场景用于区分通道价与官方直连价）
  "mode": "chat",
  "currency": "USD",                     // USD / CNY（务必随币种切换，转售价多为 CNY）
  "unit": "per_1M",                      // 计价单位：per_1M tokens
  "context_window": 1000000,             // 输入上下文窗口（token）
  "max_input_tokens": 1000000,           // 与 litellm 对齐
  "max_output_tokens": 128000,
  "input_price": 3.0,                    // 未缓存输入价
  "output_price": 15.0,
  "cache_read_price": 0.3,               // 缓存命中价（read/refresh）
  "cache_write_price": 3.75,             // 通用缓存写入价（OpenAI GPT-5.6+ 1.25x / 智谱等）
  "cache_write_price_5m": 3.75,          // Anthropic 系 5m TTL 写入价
  "cache_write_price_1h": 6.0,           // Anthropic 系 1h TTL 写入价（无则省略）
  "storage_price_per_1m_hour": null,     // 缓存存储费（$/1M·h 或 ¥/1M·h，Gemini/方舟有值）
  "prompt_cache_min_tokens": 1024,       // 最低可缓存 token（Anthropic 官方字段同名）
  "cache_type": "explicit",              // automatic | explicit | both | none
  "cache_mechanism": "prefix",           // prefix | similarity | disk_unit | session
  "supports_cache_control": true,        // 是否支持 Anthropic 式 cache_control 断点（litellm 无此字段，需扩展）
  "supports_responses": false,           // Responses API 支持（litellm 无此字段，需扩展）
  "supports_prompt_caching": true,
  "breakpoint_max": 4,                   // 断点上限（Anthropic/MiniMax/百炼显式）
  "lookback_blocks": 20,                 // 回溯窗口（Anthropic/百炼）
  "cache_ttl": {"default": "5m", "options": ["5m", "1h"]},
  "cache_write_free": false,             // 旧轨模型写免费（OpenAI 旧模型/Kimi/DeepSeek）
  "long_context_threshold": 200000,      // 长上下文价格阈值（Grok 200K、Gemini 3.1 Pro 200K）
  "long_context_input_price": 4.0,       // 长上下文输入价（有则填）
  "peak_pricing_2x": true,               // DeepSeek 峰谷定价标记（9:00-12:00/14:00-18:00 北京）
  "supports_reasoning": true,
  "supports_vision": true,
  "supports_function_calling": true,
  "supports_parallel_function_calling": true,
  "supports_system_messages": true,
  "supports_response_schema": true,
  "supports_web_search": false,
  "supports_audio_input": false,
  "supports_audio_output": false,
  "deprecation_date": null,
  "source_url": "https://docs.anthropic.com/...",   // 条目数据来源
  "data_verified_at": "2026-08-02"                  // 条目核实日期
}
```

### 12.2 与 LiteLLM 字段映射

| crish 建议字段 | LiteLLM 对应字段 | 差异说明 |
|---|---|---|
| input_price / output_price | `input_cost_per_token` / `output_cost_per_token` | LiteLLM 按 per-token 存（2e-06 = $2/1M），建议统一存 per-1M 避免换算错误 |
| cache_read_price | `cache_read_input_token_cost` | 同名语义 |
| cache_write_price_5m | `cache_creation_input_token_cost` | LiteLLM 只存单一创建价（Anthropic 5m 口径），1h 价需扩展 |
| cache_write_price_1h | 无 | 需扩展（Anthropic 1h = 2x；OpenAI 无 1h 概念） |
| prompt_cache_min_tokens | `prompt_cache_min_tokens` | 同名；注意 litellm 仅部分厂商有 |
| context_window / max_* | `max_input_tokens` / `max_output_tokens` | 建议加总 context_window 便于展示 |
| supports_cache_control / supports_responses | 无 | 需扩展 |
| currency / unit | 无（隐含 USD per-token） | 需扩展，转售价格是 CNY |

### 12.3 需要定期刷新的模型清单

| 优先级 | 模型 | 刷新原因 |
|---|---|---|
| 高 | Claude Sonnet 5 | **2026-09-01 起涨价**（$2→$3 输入、$0.20→$0.30 命中、$10→$15 输出） |
| 高 | DeepSeek v4-flash / v4-pro | 峰谷定价生效日期待公告；v4-pro 的 Responses API 支持「2026 年 8 月初」 |
| 高 | OpenAI GPT-5.x | 断点机制与写价随版本变化（写 1.25x 仅 5.6+）；官方按量计费页本次未抓取 |
| 高 | Anthropic 全系 | 模型迭代快（Fable/Mythos 为新系列），价格表以用户提供为准，刷新时对照官方定价页 |
| 中 | GLM 全系 | 旗舰迭代快（5.2 为最新）；Anthropic 端点 cache_control 行为需实测 |
| 中 | Kimi K2.x 系列 | 本次仅 K3 有价格，K2.5/2.6/2.7 待补 |
| 中 | Grok | 长上下文价格细节、命中价数值（本次部分未抓取） |
| 中 | Gemini / MiniMax / 火山方舟 / 百度千帆 | 价格表相对稳定，随发布刷新 |
| 低 | 百炼 Qwen 系列 | **缓存命中绝对单价未获取**（官方仅给折扣比例），刷新时查百炼控制台按量计费页 |

---

## 13. 注意事项

1. **价格可能随时变动**：本文档所有价格以 2026-08-02 官方文档为准；模型价格、折扣比例、促销（如 Sonnet 5 八月促销价）会变，成本计算前建议对照来源 URL 复核
2. **DeepSeek 峰谷定价**：官方公告即将实行高峰时段（北京 9:00-12:00、14:00-18:00）2 倍价格，生效日期待公告；对全天候服务的成本估算影响显著，预留该因子
3. **存储费按 token×小时计费**：Gemini 显式缓存（$1.00~$4.50/1M·h）与火山方舟（0.017 元/1M·h）在长 TTL/大缓存场景下必须单独核算，不能只看命中折扣
4. **转售价格 ≠ 官方直连价**：方舟/千帆转售 DeepSeek/GLM 与官方直连价差异巨大，例如：
   - DeepSeek-V4-Pro 官方直连 $0.435/1M 输入（命中 $0.003625），方舟/千帆转售 ¥12/1M（命中 ¥1.00）——**量级完全不同**，计算时必须区分通道与厂商
   - DeepSeek-V4-Flash 官方直连 $0.14/1M 输入，千帆转售 ¥1/1M（≈$0.14），命中 ¥0.2 与官方 $0.0028（≈¥0.02）相差约 10 倍
   - 转售渠道通常是人民币计价且含平台溢价/折扣，catalog 中同一模型名可能有多个条目（按 provider 区分）
5. **同模型不同通道的缓存折扣不同**：GLM 命中价 z.ai 官方约 18%、百炼隐式 20%、智谱部署 25%；Kimi K3 百炼通道 10%、月暗直连 10%（一致）；成本计算需按实际接入通道取价
6. **命中不保证 100%**：DeepSeek（前缀单元匹配）、Grok（路由/驱逐）、Gemini 隐式缓存（no cost saving guarantee）、百炼隐式缓存均为 best-effort；只有 Anthropic 显式断点与 Gemini 显式 cachedContents 有确定性
7. **计量字段两套标准**：OpenAI 系（`cached_tokens` / `prompt_tokens_details`）与 Anthropic 系（`cache_read_input_tokens` / `cache_creation_input_tokens`）；crish 多厂商适配层应按「协议族」而非按厂商做字段映射（详见 `vendor-cache-gaps.md` 第八节）
8. **最低可缓存 token 差异大**：Anthropic 512~4096、Kimi 256、MiniMax 被动 512、百炼显式 1024/隐式 256、DeepSeek 未公布（前缀单元制）、OpenAI GPT-5.6+ 严格 1024——短提示词缓存收益评估必须查对应模型下限
9. **部分条目未核实**：OpenAI 官方按量计费页、Qwen 命中绝对单价、GLM Anthropic 端点 cache_control 行为、方舟/千帆计量字段等标注「未获取/未确认」，使用前需实测或刷新
