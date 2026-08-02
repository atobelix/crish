# LLM 厂商 Prompt Context Caching 机制调研（正式文档）

- 撰写日期：2026-08-02
- 素材来源：调度者原始调研草稿（`vendor-cache-research-draft.md`，覆盖 DeepSeek / 智谱 / Kimi / xAI / MiniMax / Gemini / Anthropic / OpenAI / 火山方舟 / 百度千帆）＋ 第二轮缺口补充核实（`vendor-cache-gaps.md`，覆盖阿里云百炼 Qwen、DeepSeek v4 Responses、GLM cache_control、MiniMax M3、xAI 粘性路由）
- 文档性质：两个素材的融合整理稿，作为 crish 多厂商缓存优化（`docs/cache-optimization/`）的参考依据；仅改动本文件，不涉及任何源代码
- 内容约定：所有条目标注「已确认」（官方文档可复核）或「未能获取 / 未确认」（不编造）；金额均为官方文档原值
- 冲突处理约定：以 draft 为主干，gaps 的核实结果以「补充核实（2026-08-02）」小节并入对应厂商章节；两处素材口径不一致处以 gaps 最新核实为准并显式标注

---

## 1. DeepSeek（deepseek-v4-flash / deepseek-v4-pro）

| 维度 | 内容 |
|---|---|
| 缓存类型 | 自动磁盘前缀缓存（Context Caching on Disk），全用户默认启用，零代码改动 |
| 最低缓存量 | 无明确下限（旧版 V3 时代为「64 token 块」表述，2026 版已改为「缓存前缀单元 + 固定 token 间隔」） |
| 计量字段 | Chat Completions：`usage.prompt_cache_hit_tokens` / `usage.prompt_cache_miss_tokens`；Responses API：`usage.input_tokens_details.cached_tokens`（OpenAI 兼容） |
| 缓存价格 | deepseek-v4-flash：命中 $0.0028 / 未命中 $0.14 / 输出 $0.28（命中为未命中的 2%）；deepseek-v4-pro：命中 $0.003625 / 未命中 $0.435 / 输出 $0.87（命中约 0.83%） |
| 显式断点支持 | 不支持，无任何手动断点参数（cache_control 无） |
| Responses 支持 | deepseek-v4-flash 已支持；deepseek-v4-pro 官方计划 2026 年 8 月初加入 |
| 来源 URL | https://api-docs.deepseek.com/guides/kv_cache、/guides/responses_api、/quick_start/pricing |

机制细节（已确认）：

- **SWA（滑动窗口注意力）下重构的缓存单元制**：缓存以独立完整的「cache prefix unit（缓存前缀单元）」为单位存储与匹配；后续请求必须**完整匹配某个缓存前缀单元**才能命中，不再逐 token 匹配（与 OpenRouter / Anthropic 式"任意前缀命中"不同）。
- 持久化时机三种：① 请求边界——每次请求在「用户输入末尾」与「模型输出末尾」各生成一个单元；② 多请求公共前缀检测——检测到多请求公共前缀时持久化为独立单元（例：请求 A+B 与 A+C 共享前缀 A，第三次请求 A+D 可命中 A）；③ 固定 token 间隔——长输入 / 长输出按固定间隔切出单元，避免长前缀因永远到不了末尾而无法缓存。
- 磁盘缓存构建需数秒；不再使用时数小时内到数天内自动清除；命中为 best-effort，不保证 100%；缓存只匹配输入前缀，输出仍按当前参数全新生成（保留随机性）。
- 即将实施峰谷定价：高峰时段（北京时区 9:00–12:00、14:00–18:00）价格 2 倍，生效日期待公告。
- 定价页标注 v4-flash 版本号为 DeepSeek-V4-Flash-0731；v4-pro 无版本号细节。

### 补充核实（2026-08-02）

- **Responses API 支持范围**：当前仅 `deepseek-v4-flash`；`deepseek-v4-pro` 尚未支持、官方计划 2026 年 8 月初加入；`base_url` 为 `https://api.deepseek.com`（OpenAI SDK `client.responses.create` 可直接调用）。
- **无状态 API**：`previous_response_id`、`conversation`、`store`、`background`、`include`、`prompt`、`truncation`、`service_tier`、`safety_identifier` 均不支持，不支持的参数**静默忽略、不报错**（兼容既有 Responses 客户端）；上下文长度 1M，输出最大 384K。
- **缓存参数**：`prompt_cache_key` / `prompt_cache_retention` 不支持——官方明确缓存由系统自动管理（与 OpenAI 不同，无手动缓存键），请走自动 KV 缓存。
- **定价比例口径修正**（与 draft 主文冲突，以 gaps 为准）：draft 主文写「命中价仅为未命中的 2%（50 倍差价）」仅适用于 **flash**；gaps 定价表确认 **pro 为 ≈0.83%**（$0.003625 / $0.435）。

### 对 crish 的接入要点

自动缓存，客户端只需保持提示词前缀稳定 + 解析 `prompt_cache_hit_tokens`（Chat）/ `input_tokens_details.cached_tokens`（Responses），无需实现任何缓存断点逻辑。

---

## 2. 智谱 GLM（z.ai / open.bigmodel.cn）

| 维度 | 内容 |
|---|---|
| 缓存类型 | 自动隐式缓存（官方："Implicit caching that intelligently identifies repeated context content without manual configuration"，基于内容相似度识别重复上下文） |
| 最低缓存量 | 官方未标注；阿里云百炼侧 GLM 最低缓存 Token 数为 512（见第 9c 节） |
| 计量字段 | `usage.prompt_tokens_details.cached_tokens`（OpenAI Chat Completions 兼容 v4 格式） |
| 缓存价格 | GLM-4.7 / 4.6 / 4.5：输入 $0.60 / 命中 $0.11 / 输出 $2.20；GLM-5：输入 $1.00 / 命中 $0.20 / 输出 $3.20；GLM-5.2（最新旗舰，1M ctx）：输入 $1.40 / 命中 $0.26 / 输出 $4.40；GLM-4.5-Air：输入 $0.20 / 命中 $0.03 / 输出 $1.10（命中价约为标准输入价的 18%，缓存存储限时免费） |
| 显式断点支持 | 官方缓存文档未提供 Anthropic 式 cache_control 手动断点；Claude Code 兼容端点（`api.z.ai/api/anthropic`）是否处理 cache_control **官方文档未确认，需实测** |
| Responses 支持 | 未在官方文档发现 Responses API 支持说明 |
| 来源 URL | https://docs.z.ai/guides/capabilities/cache、/guides/llm/glm-4.7.md、/guides/overview/pricing.md、/devpack/tool/claude |

机制细节：

- 命中基于内容相似性（相似内容匹配、非严格前缀哈希）；内容完全相同命中率最高，轻微格式差异即可能失效；缓存有合理时限，过期后重新计算。
- GLM-4.7：200K 上下文（GLM-4.7-Flash 免费版除外），支持 Thinking Mode 与「保留式推理」。

### 补充核实（2026-08-02）

- **官方缓存机制确认**：自动隐式缓存，基于内容相似度自动识别重复上下文，无手动配置、无缓存断点；支持模型为 GLM-5、GLM-4.7、GLM-4.6、GLM-4.5 系列等全部主流模型（文档原文）。
- **命中折扣口径差异（标注）**：gaps 记录官方缓存文档示例为「usually 50% of standard price」（0.005/0.01 示例），而 draft 记录的定价页实际价目 GLM-4.7 命中 $0.11 vs 输入 $0.60 约为 18%。两处口径不同——示例值仅说明优惠存在，**实际价目以定价页为准（约 18%）**；百炼侧 GLM 隐式缓存折扣为 20%~25%（智谱部署 ZHIPU/GLM-5.2/5.1/5 为 25%）。
- **cache_control 确认状态**：Anthropic 兼容端点 `https://api.z.ai/api/anthropic` 已确认存在（Claude Code 通过 `ANTHROPIC_BASE_URL` 接入）；但官方缓存文档只描述自动缓存，Claude Code 集成文档未提及 cache_control 行为——**结论：从官方文档无法确认，建议实测**（发带 cache_control 的请求，观察 `usage.cache_read_input_tokens` 等字段变化）。
- **GLM-4.7「保留式推理」（Retention-Based Reasoning）确认**：自动保留多轮对话中的推理块，从而提高缓存命中率、降低计算成本，适合长期复杂任务；另有交错推理（Interleaved Reasoning，GLM-4.5 引入）与轮级推理（Round-Level Reasoning）。

### 对 crish 的接入要点

自动缓存为主，客户端解析 `cached_tokens` 即可；若走 Anthropic 兼容端点，建议先实测 cache_control 行为再决定是否实现断点逻辑，短期按「纯自动缓存」处理。

---

## 3. 月之暗面 Kimi（platform.kimi.com / platform.moonshot.cn）

| 维度 | 内容 |
|---|---|
| 缓存类型 | 全自动 Context Caching，对所有模型（K2.5 / K2.6 / K2.7 / K3）自动启用；无需手动创建、无缓存 ID、无 TTL 管理 |
| 最低缓存量 | 前一请求 prompt tokens > 256 才会被缓存；≤256 的请求不被缓存而是被丢弃 |
| 计量字段 | `usage.cached_tokens`（OpenAI 兼容格式，顶层 usage 字段，非嵌套 details） |
| 缓存价格 | K3（¥/1M）：kimi-k3 命中 ¥2.00 / 未命中 ¥20.00 / 输出 ¥100.00，上下文 1,048,576；命中价仅为未命中的 10%（90% 折扣） |
| 显式断点支持 | 不支持（纯自动）；另有 `prompt_cache_key` 请求参数（session/task id 语义，Coding Plan 必填）用于提升命中率（路由辅助，非显式断点） |
| Responses 支持 | 未提及 |
| 来源 URL | https://platform.kimi.com/docs/guide/use-context-caching-feature-of-kimi-api.md、/docs/pricing/chat-k3.md、/docs/api/chat.md |

机制细节：

- 命中条件：检测到重复的初始上下文（system prompt、知识文档、工具定义、历史消息）自动复用。
- 命中场景：固定长上下文高频查询，首 Token 延迟平均 <5s，最高可降本 90%。

### 补充核实（2026-08-02）

- 第二轮未设 Kimi 专项核实；但百炼侧数据（gaps 第一节）交叉确认：月之暗面部署 kimi/kimi-k3 在百炼的隐式缓存折扣为 **10%**，kimi/k2.6 为 16.9%、kimi/k2.5 为 17.5%。

### 对 crish 的接入要点

纯自动缓存 + `prompt_cache_key`（session 语义）辅助路由，客户端解析顶层 `usage.cached_tokens`；注意请求前缀 >256 token 才有缓存资格。

---

## 4. xAI Grok（grok-4.5 等）

| 维度 | 内容 |
|---|---|
| 缓存类型 | 自动 prompt caching；连续请求共享相同开头消息时自动缓存；从 messages 数组开头做精确前缀匹配 |
| 最低缓存量 | 官方未标注 |
| 计量字段 | Chat Completions：`usage.prompt_tokens_details.cached_tokens`；Responses API：`usage.input_tokens_details.cached_tokens`（xAI 主推 Responses API /v1/responses） |
| 缓存价格 | grok-4.5：输入 $2.00 / 命中 $0.30 / 输出 $6.00（≥200k：$4.00 / $0.60 / $12.00）；grok-4.3：输入 $1.25 / 命中 $0.20 / 输出 $2.50；grok-4.20-0309 系列同 grok-4.3（命中价为标准输入价的 15%） |
| 显式断点支持 | 无（无 Anthropic 式断点；TTL 服务端管理，未公布具体值） |
| Responses 支持 | 支持，`prompt_cache_key` 字段原生支持（主推） |
| 来源 URL | https://docs.x.ai/prompt-caching、/developers/advanced-api-usage/prompt-caching/how-it-works、/maximizing-cache-hits、/usage-and-pricing |

机制细节：

- 推荐设置 `x-grok-conv-id` HTTP 头或 `prompt_cache_key` 提升命中率（粘性路由辅助，非显式断点）。
- 不保证 100% 命中：内存压力驱逐、请求路由到不同服务器都会导致 miss。
- 长上下文定价：≥200K prompt tokens（含缓存）按长上下文价计费（约 2x）。

### 补充核实（2026-08-02）

- **粘性路由确认**：`x-grok-conv-id` HTTP 头（Chat Completions / gRPC metadata）——相同会话 ID 的请求被路由到同一服务器，最大化缓存命中率，官方推荐设置；`prompt_cache_key`（Responses API，请求体中传 UUID 字段）功能等同，示例模型 grok-4.5。
- **命中判定方法**：`cached_tokens` 为 0 = 未命中（首次请求或缓存被逐出）；等于 `prompt_tokens` = 全命中；多轮对话中该值应随轮次递增。
- **价格数字说明（标注）**：gaps 未独立抓取定价页数字（官方指向 https://docs.x.ai/developers/pricing），draft 的 grok-4.5 等价格来自 usage-and-pricing 页，保留但建议以定价页复核。

### 对 crish 的接入要点

走 Responses API 必须传 `prompt_cache_key`（或 Chat 下传 `x-grok-conv-id`）启用粘性路由，否则命中率不可靠；解析 `cached_tokens` 并可用「等于 prompt_tokens」判定全命中。

---

## 5. MiniMax（M2 / M2.1 / M2.5 / M2.7 / M3）

MiniMax 是调研样本中双轨制最完整的厂商：被动（自动）缓存与 Anthropic 式主动缓存并行。

### A. Prompt 缓存（被动 / 自动，OpenAI 与 Anthropic 兼容端点均生效）

| 维度 | 内容 |
|---|---|
| 工作方式 | 自动识别重复上下文（工具定义 → 系统提示 → 历史消息顺序前缀匹配），无需改调用 |
| 最低缓存量 | ≥ 512 输入 token；写入无额外计费；过期时间随系统负载自动调整 |
| 支持模型 | MiniMax-M3、M2.7、M2.5、M2.1 系列 |
| 计量字段 | OpenAI 格式 `usage.prompt_tokens_details.cached_tokens`；Anthropic 格式 `usage.cache_read_input_tokens` |
| 命中价格 | 优惠价（M3 示例：命中 0.84 元/1M vs 标准输入 4.20 元/1M，即 20%） |

### B. Anthropic 主动缓存（显式 cache_control）

| 维度 | 内容 |
|---|---|
| 工作方式 | 完整复刻 Anthropic 语义：`cache_control {"type":"ephemeral"}`；最多 4 个断点（超出只取从后往前最近 4 个）；20 块回溯窗口；可缓存 tools / system / messages（含 tool_use / tool_result）；thinking 块不可直接标记 |
| TTL | 5 分钟，命中自动续期，续期免费；首次写入额外计费（1.25x 输入价） |
| 支持模型 | M2.7 / M2.5 / M2.1 / M2 系列（**M3 不支持主动缓存**） |
| 计量字段 | `usage.cache_creation_input_tokens` / `cache_read_input_tokens` / `input_tokens`（= 断点后 token） |

### 价格（¥ / 1M tokens）

- MiniMax-M2.7：输入 2.10 / 读取 0.42（20%）/ 写入 2.625（125%）/ 输出 8.40
- MiniMax-M2.5 / M2.1 / M2：输入 2.10 / 读取 0.21（10%）/ 写入 2.625 / 输出 8.40
- 被动缓存（M3 示例）：输入 4.20 / 命中 0.84（20%）/ 输出 16.80

来源 URL：https://platform.minimaxi.com/docs/api-reference/text-prompt-caching、/anthropic-api-compatible-cache

### 补充核实（2026-08-02）

- **M3 与 M2.x 差异确认**：MiniMax-M3 不支持主动缓存（cache_control 断点），只走自动被动缓存；M2.x（M2 / M2.1 / M2.5 / M2.7）支持主动缓存。
- 被动缓存写入无额外计费；主动缓存首次写入额外计费（M2.7 写入 2.625 元/1M；M2.5 / M2.1 写入 2.625 元/1M）。
- M3 输入 >512k 时适用长上下文价格（输入 token 含缓存命中部分）。
- 百炼侧交叉确认：MiniMax-M3、M2.7 在百炼隐式缓存折扣 20%，M2.5、M2.1 为 10%。

### 对 crish 的接入要点

用 M3 只能依赖自动缓存（解析 `cached_tokens` / `cache_read_input_tokens`）；要用显式 cache_control 需改用 M2.7 等 M2 系列，且断点语义（≤4 个、20 块回溯、TTL 5 分钟）与 Anthropic 完全一致，可在适配层复用同一套实现。

---

## 6. Google Gemini（Gemini 3.x）

双轨制（https://ai.google.dev/gemini-api/docs/generate-content/caching）：

### A. Implicit caching（隐式缓存）

| 维度 | 内容 |
|---|---|
| 生效范围 | Gemini 2.5 及更新模型默认启用（含 Gemini 3.5 Flash、3.1 Pro Preview）；stateful（previous_interaction_id）与 stateless 均支持 |
| 最低缓存量 | Gemini 3.5 Flash / 3.1 Pro Preview = 4096；Gemini 2.5 Flash / Pro = 2048 |
| 计量 | `usage_metadata` 中的 `total_cached_tokens` |
| 命中保证 | 不保证命中（"no cost saving guarantee"） |

### B. Explicit caching（显式 cachedContents API）

| 维度 | 内容 |
|---|---|
| 工作方式 | POST /v1beta/cachedContents 创建缓存（contents + system_instruction + ttl），请求时以 `cachedContent: <name>` 引用；支持 list / get / update / delete |
| TTL | 默认 1 小时，无最小 / 最大限制；存储按「缓存 token 数 × 时长」计费 |
| 命中保证 | 有成本节省保证；OpenAI 库可通过 `extra_body: {cached_content: ...}` 启用 |
| 限制 | Interactions API（新推荐接口）仅支持隐式缓存，不支持显式缓存 |

### 价格（$ / 1M）

- Gemini 3.6 Flash：输入 $1.50 / 命中 $0.15 / 存储 $1.00/1M·h
- Gemini 3.5 Flash：输入 $0.75 / 命中 $0.075
- Gemini 3.5 Flash-Lite：输入 $0.30 / 命中 $0.03
- Gemini 3.1 Pro：输入 $1.25（≤200k）/ 命中 $0.125 / 存储 $4.50
- 命中价 ≈ 标准输入价的 10%

来源 URL：https://ai.google.dev/gemini-api/docs/caching、/docs/generate-content/caching、/docs/pricing

### 补充核实（2026-08-02）

第二轮未设 Gemini 专项核实（无新增条目）。

### 对 crish 的接入要点

隐式缓存默认生效、零配置，解析 `total_cached_tokens` 即可；长 TTL / 确定性场景用 cachedContents API 需单独核算「token 数 × 时长」存储费，且注意 Interactions API 不支持显式缓存。

---

## 7. Anthropic（Claude Opus 4.5–5 / Sonnet 4.5–5 / Haiku 4.5 等）

显式 cache_control 双模式（https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching）：

### 两种断点模式

- **Automatic caching（自动缓存）**：请求顶层 `cache_control {"type":"ephemeral"}`，系统自动把断点放在最后一个可缓存块，随对话增长自动前移（多轮对话推荐）。
- **Explicit breakpoints（显式断点）**：块级 `cache_control` 精细控制；最多 4 个断点（自动缓存占用 1 个槽位，冲突返回 400）。

### 关键数字

- 最低可缓存 token：
  - Opus 5 / Fable 5 / Mythos 5 = 512
  - Mythos Preview / Opus 4.7 = 2048
  - Opus 4.6 / 4.5 = 4096
  - Opus 4.8 / Sonnet 5 / Sonnet 4.6 / 4.5 = 1024
  - Haiku 4.5 = 4096
- TTL：默认 5 分钟（ephemeral，刷新免费）；1 小时需显式 `ttl:"1h"`（写入价 2x），且 1h 条目必须位于 5m 条目之前。
- 20 块 lookback 窗口；缓存前缀顺序 tools → system → messages（累计哈希，前缀内任何变更整体失效）；cache write 只在断点发生。
- 并发请求：缓存条目在首个响应开始后才可用。

### 计量字段

`cache_creation_input_tokens`（写入）、`cache_read_input_tokens`（读取）、`input_tokens`（断点后未缓存）；1h 缓存细分在 `usage.cache_creation.ephemeral_5m/1h_input_tokens`。

### 价格（$ / 1M，5m 写 = 1.25x，1h 写 = 2x，读 = 0.1x）

| 模型 | 基础输入 | 5m 缓存写入 | 1h 缓存写入 | 缓存命中与刷新 | 输出 |
|---|---|---|---|---|---|
| Claude Fable 5 | $10 | $12.50 | $20 | $1 | $50 |
| Claude Mythos 5 (limited availability) | $10 | $12.50 | $20 | $1 | $50 |
| Claude Opus 5 | $5 | $6.25 | $10 | $0.50 | $25 |
| Claude Opus 4.8 / 4.7 / 4.6 / 4.5 | $5 | $6.25 | $10 | $0.50 | $25 |
| Claude Opus 4.1 (deprecated) / 4 (retired) | $15 | $18.75 | $30 | $1.50 | $75 |
| Claude Sonnet 5（2026-08-31 前） | $2 | $2.50 | $4 | $0.20 | $10 |
| Claude Sonnet 5（2026-09-01 起） | $3 | $3.75 | $6 | $0.30 | $15 |
| Claude Sonnet 4.6 / 4.5 | $3 | $3.75 | $6 | $0.30 | $15 |
| Claude Haiku 4.5 | $1 | $1.25 | $2 | $0.10 | $5 |
| Claude Haiku 3.5 (retired) | $0.80 | $1 | $1.60 | $0.08 | $4 |

Responses API：Anthropic 无 Responses API，仅 Messages API；自动缓存与显式断点可混用。

### 补充核实（2026-08-02）

- 第二轮未设 Anthropic 专项核实；但素材第二部分的定价表为用户提供的官方权威值（含 Fable 5 / Mythos 5 新模型、Sonnet 5 两阶段价格），已并入上表，与 draft 第一部分的相应条目一致（Sonnet 5 9 月起 $3 与 draft 主文一致）。

### 对 crish 的接入要点

cache_control 断点机制必须实现：多轮对话用顶层 `{"type":"ephemeral"}` 自动缓存即可，静态块（system / 工具）可加显式断点省写入费；解析 `cache_creation_input_tokens` / `cache_read_input_tokens`，并处理 4 断点上限与 5m/1h TTL 语义。

---

## 8. OpenAI（GPT-5.x，Responses API + Chat Completions）

| 维度 | 内容 |
|---|---|
| 缓存类型 | 自动 prompt caching，gpt-4o 及更新模型默认启用，无需 cache_control；GPT-5.6 及以后模型族引入显式断点机制 |
| 最低缓存量 | GPT-5.6+ 严格 1024 tokens；GPT-5.5 及更早 1024–2048 依模型而定 |
| 计量字段 | Responses：`usage.input_tokens_details.cached_tokens`（读）+ `cache_write_tokens`（写）；Chat Completions：`usage.prompt_tokens_details.cached_tokens` + `cache_write_tokens` |
| 缓存价格 | 读按 cached-rate 折扣（素材未列绝对单价）；写入费 GPT-5.6+ = 1.25x 未缓存输入价，旧模型写免费 |
| 显式断点支持 | 支持（自有断点参数体系，非 Anthropic cache_control） |
| Responses 支持 | 原生支持 |
| 来源 URL | https://platform.openai.com/docs/guides/prompt-caching |

机制细节：

- **`prompt_cache_options.mode`**：`implicit`（默认，自动断点在最新 user/tool 消息；不向前回退找最长前缀——与旧模型关键差异）/ `explicit`（只用显式断点，避免为变化后缀付写入费）。
- **`prompt_cache_breakpoint {"mode":"explicit"}`**：Responses 支持 input_text / input_image / input_file 块；Chat Completions 支持 text / image_url / input_audio / file / refusal 块；每请求最多 4 个写入断点（implicit 占用 1 个，故显式最多 3 个）；读取考虑最近 50 个断点。
- **`prompt_cache_key`**：路由优化（与前缀哈希结合）；GPT-5.6+ 需设置它才能用更可靠的匹配；每 key 流量约 15 请求/分钟，超出可能 miss。
- **TTL**：GPT-5.6+ `prompt_cache_options.ttl` 仅支持 30m（最小保留期）；旧模型 `prompt_cache_retention`：`in_memory`（5–10 分钟活跃、上限 1h）或 `24h extended`（gpt-5.5、gpt-5.4、gpt-5.2、gpt-5.1 系、gpt-5、gpt-4.1）。
- 缓存不影响输出生成与速率限制（TPM 含缓存 token）；Chat Completions 的断点机制两种 API 均可用。

### 补充核实（2026-08-02）

第二轮未设 OpenAI 专项核实（无新增条目）。

### 对 crish 的接入要点

原生走 Responses API，默认 implicit 模式 + 稳定前缀即可；省钱场景用显式断点（Responses 块级 breakpoint，最多 4 个）固定静态上下文；GPT-5.6+ 建议设置 `prompt_cache_key` 以获得更可靠匹配。

---

## 9. 国内厂商

### 9a. 火山方舟 / 豆包（ByteDance）

| 维度 | 内容 |
|---|---|
| 缓存类型 | 透明前缀缓存（部分模型已支持，无需任何配置）；显式缓存管理文档未找到 |
| 计量字段 | 本次未获取到 |
| 缓存价格（¥/1M） | doubao-seed-2.1-pro：输入 6.00 / 命中 1.20（20%）/ 输出 30.00；doubao-seed-2.1-turbo：输入 3.00 / 命中 0.60 / 输出 15.00；doubao-seed-2.0-mini：输入 0.20 / 命中 0.04 / 输出 2.00；deepseek-v4-pro（方舟转售）：输入 12.00 / 命中 1.00 / 输出 24.00；glm-4.7：输入 2.0–4.0（分段）/ 命中 0.4–0.8 / 输出 8.0–16.0 |
| 显式断点支持 | 否（自动缓存） |
| Responses 支持 | 有 Responses API 文档入口 |
| 来源 URL | www.volcengine.com/docs/82379/1544106 |

补充说明：含缓存存储费 0.017 元 / 百万 token / 小时（长 TTL 场景需单独核算）。

### 对 crish 的接入要点

零配置自动缓存，解析 OpenAI 兼容 `cached_tokens` 即可（计量字段本次未获取到，接入时需实测确认）。

### 9b. 百度千帆 / 文心（ERNIE）

| 维度 | 内容 |
|---|---|
| 缓存类型 | 自动缓存，计费页含「命中缓存」价目 |
| 计量字段 | 未获取到（平台提供 OpenAI 兼容 usage） |
| 缓存价格（¥/1M，原文为元/千 tokens） | ERNIE-4.5-Turbo：输入 0.8 / 命中 0.2（25%）/ 输出 3.2；ERNIE-4.5-Turbo-VL：输入 3.0 / 命中 0.75 / 输出 9.0；DeepSeek-V4-Pro（千帆转售）：输入 12 / 命中 1.0 / 输出 24；DeepSeek-V4-Flash（千帆转售）：输入 1 / 命中 0.2 / 输出 2 |
| 显式断点支持 | 平台提供 OpenAI 兼容与 Anthropic API 兼容端点；cache_control 断点支持与否未确认 |
| Responses 支持 | 未确认 |
| 来源 URL | cloud.baidu.com/doc/qianfan/s/wmh4sv6ya |

### 对 crish 的接入要点

零配置自动缓存，按 OpenAI 兼容 `cached_tokens` 解析；若走 Anthropic 兼容端点需实测 cache_control 行为（官方未确认）。

### 9c. 阿里云百炼 Qwen（第二轮完整核实，本厂商正文以 gaps 为准）

draft 第一轮未能核实（help.aliyun.com model-studio 文档 404 迁移、docs.qwen.ai 超时）；第二轮已完整确认，**正文以下内容即为「补充核实（2026-08-02）」结果**。

**来源 URL**：https://help.aliyun.com/zh/model-studio/context-cache、/compatibility-with-openai-responses-api

**结论**：百炼提供「显式缓存」与「隐式缓存」两种**互斥**模式（单个请求只能应用其中一种），Responses API 另有独立的「Session 缓存」机制。

#### 显式缓存 vs 隐式缓存（已确认）

| 维度 | 显式缓存 | 隐式缓存 |
|---|---|---|
| 开启方式 | 需主动在 messages 的 content 块上加 `"cache_control": {"type": "ephemeral"}` | 自动开启，无需配置，无法关闭 |
| 缓存创建计费 | 输入 Token 标准单价的 **125%** | 输入 Token 标准单价的 **100%**（无额外费用） |
| 命中计费 | 输入 Token 标准单价的 **10%** | 输入 Token 标准单价的 **20%**（多数百炼部署模型；deepseek-v4-pro 例外） |
| 最低可缓存 Token | **1024** | 百炼部署模型 **256**；Qwen3.7 系列约 **2000**；智谱部署 GLM、稀宇 MiniMax 为 **512** |
| 有效期 | 5 分钟（命中后重置） | 不确定，系统定期清理长期未使用缓存 |
| 命中确定性 | 确定性命中 | 命中率不确定，即使完全一致也可能未命中 |
| 其他限制 | 单请求最多 4 个标记；回溯窗口 20 个 content 块 | 无手动控制 |

- 显式缓存创建发生在**模型响应之后**（先请求、后建缓存，命中需等首次请求完成）；缓存命中概率非 100%，属系统判定。

#### 显式缓存（cache_control）细节（已确认）

- 支持协议：OpenAI Chat Completions、DashScope、Anthropic 兼容接口（三者计量字段不同，见下）。
- 支持模型（华北2北京为例）：qwen3.7-max、qwen3.6-max-preview、qwen3.5/3.7 系列 Plus、qwen3.7-flash、qwen3-coder-plus/flash、qwen3-vl-plus/flash，以及第三方模型 deepseek-v3.2、kimi-k2.6/k2.5/k2.7-code、glm-5.1（其他地域模型列表详见原文）。
- 可缓存内容：`messages` 数组中 system / user / assistant / tool 消息的 content 块。**tools 数组中的 cache_control 标记会被忽略**，工具定义作为系统消息的一部分参与缓存计算（工具定义不允许独立缓存）；若请求含 tools 参数，工具定义会序列化为 JSON 参与缓存，需保证每次请求的工具列表顺序、字段顺序、字段结构完全一致，否则缓存失效。
- 命中策略：以每个 cache_control 位置为终点**向前回溯最多 20 个 content 块**尝试命中；选取最长匹配前缀并重置有效期。
- 仅支持 `type: "ephemeral"`；若标记数超过 4 个，仅最后 4 个生效。
- 建议：并行工具调用时把多个 tool 结果合并为一条消息 + 多个 content 块，避免超出 20 块回溯窗口。

#### 隐式缓存细节（已确认）

- 工作方式：前缀匹配（请求 messages 数组的公共前缀）；命中直接复用缓存结果。
- 计费折扣因模型来源而异（隐式缓存、百炼通道）：
  - 百炼部署模型（deepseek-v4-pro 除外）：命中单价为输入单价的 **20%**；**deepseek-v4-pro 不是 20%**（具体见百炼控制台）；
  - 快手万擎部署：vanchin/deepseek-v4-pro 为 **8.33%**、v3.2-think 10%、v3.1-terminus/r1/v3 40%；
  - 月之暗面部署：kimi/kimi-k3 为 **10%**、kimi/k2.6 16.9%、kimi/k2.5 17.5%；
  - GLM 百炼部署：glm-5.2 为 **25%**，其余 glm 系列 20%；
  - 智谱部署：ZHIPU/GLM-5.2/5.1/5 均为 **25%**；
  - MiniMax 稀宇部署：MiniMax-M3、M2.7 为 **20%**，M2.5、M2.1 为 **10%**。
- 隐式缓存支持面广：千问 Max/Plus/Flash/Turbo/Coder/VL 全系、百炼部署与快手万擎部署的 DeepSeek（含 **deepseek-v4-pro / deepseek-v4-flash**）、Kimi（百炼/月暗部署）、GLM（百炼/智谱部署）、MiniMax（百炼/稀宇部署，含 **MiniMax-M3**）、xiaomi/mimo-v2.5-pro、stepfun/step-3.7-flash 等（按地域列表详见原文）。
- 提升命中概率：将重复内容放提示词开头、差异内容放末尾；视觉模型对同一图像多次提问时图像放前面，对不同图像问同一问题时文本放前面。
- 提示：OpenAI 兼容 Batch（文件输入）方式**无法享受缓存折扣**。

#### 计量字段（已确认）

| 协议 | 命中缓存计量字段 | 创建缓存计量字段 |
|---|---|---|
| OpenAI Chat Completions | `usage.prompt_tokens_details.cached_tokens` | `usage.prompt_tokens_details.cache_creation_input_tokens` |
| DashScope | `usage.prompt_tokens_details.cached_tokens` | `usage.prompt_tokens_details.cache_creation_input_tokens` |
| Anthropic 兼容 | `usage.cache_read_input_tokens`（不计入 input_tokens，单独报告） | `usage.cache_creation_input_tokens` |

#### Responses API 的 Session 缓存（已确认）

- Responses API 不走显式/隐式缓存，而是通过 Header `x-dashscope-session-cache: enable` 开启 **Session 缓存**（默认 `disable`）；服务端自动缓存对话上下文（结合 `previous_response_id` 多轮关联），无需手动管理。
- 最小可缓存提示词 1024 Token，有效期 5 分钟；约束限制与显式缓存一致。
- 支持模型：qwen3-max / qwen3.7-max / qwen3.7-plus / qwen3.6-plus / qwen3.5-plus / qwen3.7-flash / qwen3.6-flash / qwen3.5-flash / qwen-plus / qwen-flash / qwen3-coder-plus / qwen3-coder-flash。
- 计量：`usage.input_tokens_details.cached_tokens`（Responses 响应中已出现该字段）。
- 百炼 Responses 端点：`POST {base}/compatible-mode/v1/responses`（旧路径 `/api/v2/apps/protocols/compatible-mode/v1/responses` 即将停用）。

### 对 crish 的接入要点

百炼通道优先选显式缓存（命中 10%、确定性命中，比隐式 20% 更优），需把静态上下文放 messages content 块、遵守 4 标记 / 20 块回溯限制、保证工具定义 JSON 序列化稳定；若走 Responses API 则用 `x-dashscope-session-cache: enable` Header 的 Session 缓存。

---

## 10. 汇总对比表（融合版）

| 厂商/模型 | 缓存类型 | 最低缓存量 | 命中计量字段 | 命中价格 | cache_control | Responses 支持 |
|---|---|---|---|---|---|---|
| DeepSeek v4 | 自动磁盘前缀缓存（前缀单元制），无手动 | 无明确下限（旧版 64 tokens） | `prompt_cache_hit_tokens`/`miss_tokens`（Chat）；`input_tokens_details.cached_tokens`（Responses） | flash hit $0.0028 vs miss $0.14 /1M（**2%**）；pro ≈**0.83%** | ❌ 不支持 | ✅ v4-flash；v4-pro 2026-08 初；`prompt_cache_key` 不支持 |
| 智谱 GLM-4.7/5.x | 自动隐式缓存（相似度识别） | 官方未标注（百炼侧 512） | `prompt_tokens_details.cached_tokens` | $0.11 vs $0.60 /1M（定价页 ≈18%；官方文档示例 ≈50%，口径差异见第 2 节） | ❓ Anthropic 端点存在，是否处理未确认（需实测） | ❓ 未发现文档 |
| Kimi K3/K2.x | 全自动 Context Caching | 前置请求 > 256 tokens | `usage.cached_tokens`（顶层） | ¥2 vs ¥20 /1M（**10%**） | ❌ 否（有 `prompt_cache_key` 路由辅助） | ❓ 未提及 |
| xAI Grok 4.5 | 自动前缀缓存 + 粘性路由 | 未标注 | Chat `prompt_tokens_details.cached_tokens`；Responses `input_tokens_details.cached_tokens` | $0.30 vs $2 /1M（**15%**） | ❌ 无断点；`x-grok-conv-id` / `prompt_cache_key` 粘性路由 | ✅ 主推，`prompt_cache_key` 原生支持 |
| MiniMax M2.x/M3 | 被动（自动）+ Anthropic 主动双轨 | 被动 ≥512；主动无明确下限（4 断点 / 20 块回溯 / 5min TTL） | `cached_tokens`（OpenAI）；`cache_creation/read_input_tokens`（Anthropic） | 读 0.42 vs 输入 2.1 元/1M（M2.7 20%）；写 2.625（1.25x）；M3 被动 20% | ✅ 主动缓存仅 M2.x；**M3 不支持** | ✅ 有 Responses 兼容接口 |
| Google Gemini 3.x | implicit（自动）+ explicit（cachedContents API） | implicit 4096（3.x）/ 2048（2.5）；explicit 无下限 | `usage_metadata.total_cached_tokens` | $0.075 vs $0.75 /1M（3.5 Flash，**10%**）+ 存储 $1/1M·h | ❌ 无 cache_control（cachedContent 资源） | ❌ 无（Interactions 仅隐式缓存） |
| Anthropic Claude | automatic + explicit breakpoints | Opus5/Fable5/Mythos5 512；Opus4.7 2048；Sonnet5 1024；Opus4.5/Haiku4.5 4096 | `cache_read_input_tokens` / `cache_creation_input_tokens` | 读 = 0.1x，写 = 1.25x（5m）/ 2x（1h）；TTL 5m/1h | ✅ 最多 4 断点 | ❌ 无（Messages API） |
| OpenAI GPT-5.x | 自动 + 显式断点（`prompt_cache_breakpoint`） | GPT-5.6+ 严格 1024 | `cached_tokens` + `cache_write_tokens`（两 API details 字段） | 读按 cached-rate 折扣；写 = 1.25x（GPT-5.6+） | ❌ 否（自有断点参数体系） | ✅ 原生 |
| 阿里云百炼 Qwen | 显式（cache_control）+ 隐式（自动）双模式**互斥**；Responses 另有 Session 缓存 | 显式 1024；隐式 256（Qwen3.7 约 2000）；Session 1024 | `cached_tokens`/`cache_creation_input_tokens`（OpenAI/DashScope）；`cache_read_input_tokens`（Anthropic）；`input_tokens_details.cached_tokens`（Responses） | 显式命中 10%、创建 125%；隐式命中 20%（deepseek-v4-pro 例外，第三方部署 8.33%~40%） | ✅ 支持（仅 ephemeral，≤4 个，20 块回溯） | ✅ Session 缓存（Header `x-dashscope-session-cache: enable`） |
| 火山方舟/豆包 | 透明前缀缓存（自动） | 未公布 | 未获取到 | 命中 ≈ 20%（seed 系）；存储 0.017 元/1M·h | ❌ 否 | ✅ 有文档入口 |
| 百度千帆/文心 | 自动缓存 | 未公布 | 未获取到（OpenAI 兼容 usage） | ERNIE-4.5-Turbo 命中 = **25%** | ❓ 未确认 | ❓ 未确认 |

---

## 11. 跨厂商规律总结

### 11.1 通用规则（全行业统一，违反即 miss）

1. **静态在前、动态在后**：system prompt、工具定义、知识文档等静态内容放提示词最前，动态内容（用户输入、轮次消息）放最后。
2. **前缀 100% 一致才命中**：所有自动缓存都基于前缀匹配（DeepSeek 更进一步要求完整匹配缓存前缀单元）；任意格式差异（换行、字段顺序、JSON 序列化）都可能整体失效——典型例：百炼要求工具定义的列表顺序、字段顺序、字段结构完全一致。
3. **保持稳定请求流**：同一前缀需要持续请求才留在缓存里（各厂商 TTL 5 分钟到数小时不等）；冷启动或缓存逐出后首轮无命中属正常（best-effort 是全行业通例，仅百炼显式 / Gemini explicit 提供确定性承诺）。

### 11.2 两套计量字段标准

行业计量字段按**协议族**而非按厂商划分，crish 多厂商适配层应按协议族做字段映射：

| 协议族 | 命中（读） | 创建（写） | 未命中/其他 | 采用厂商 |
|---|---|---|---|---|
| OpenAI 系（Chat Completions） | `usage.prompt_tokens_details.cached_tokens` | `usage.prompt_tokens_details.cache_creation_input_tokens` | — | 智谱、百炼、MiniMax（OpenAI 端点）、方舟、千帆 |
| OpenAI 系（Responses） | `usage.input_tokens_details.cached_tokens` | `usage.input_tokens_details.cache_write_tokens` | — | OpenAI、DeepSeek（v4-flash）、xAI、百炼 Session 缓存 |
| Anthropic 系（Messages） | `usage.cache_read_input_tokens` | `usage.cache_creation_input_tokens` | `input_tokens`（断点后未缓存） | Anthropic、MiniMax（Anthropic 轨）、百炼（Anthropic 兼容端点） |
| 其他 | DeepSeek Chat 专用：`usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；Gemini：`usage_metadata.total_cached_tokens`；Kimi：顶层 `usage.cached_tokens` | — | — | DeepSeek、Gemini、Kimi |

### 11.3 显式断点 vs 自动缓存阵营

- **纯自动（免配置）阵营**：DeepSeek、智谱 GLM、Kimi、xAI、火山方舟、百度千帆、Gemini implicit、百炼隐式——命中质量依赖前缀稳定，无任何手动控制。
- **显式断点阵营**：Anthropic（automatic + explicit 双模式）、MiniMax（Anthropic 轨，仅 M2.x）、OpenAI（GPT-5.6+，自有 breakpoint 参数）、百炼显式（Anthropic 式 cache_control）、Gemini explicit（cachedContents 独立资源，非 cache_control）——提供确定性 / 精细控制，但需付写入费（1.25x–2x）。
- 需要实测的灰色地带：智谱 Anthropic 端点是否处理 cache_control（官方文档未确认）。

### 11.4 价格杠杆排序（命中价 / 标准输入价，越低越好）

| 档位 | 厂商/模型 | 杠杆 |
|---|---|---|
| 第一档 | DeepSeek v4-pro（≈0.83%）、DeepSeek v4-flash（2%） | 50–120 倍差价 |
| 第二档 | Kimi K3（10%）、Gemini（≈10%）、百炼显式（10%） | 10 倍 |
| 第三档 | xAI Grok（15%） | 约 6.7 倍 |
| 第四档 | MiniMax M2.5/M2.1（10%）/ M2.7、M3（20%）、百炼隐式（20%）、方舟（20%）、智谱（≈18%）、千帆（25%） | 4–10 倍 |
| 特殊 | Anthropic 读 = 0.1x（10 倍杠杆），但写 = 1.25x（5m）/ 2x（1h） | 读写分账 |
| 附加成本 | Gemini 存储 $1/1M·h、Gemini 3.1 Pro 存储 $4.50/1M·h、方舟存储 0.017 元/1M·h | 长 TTL 场景单独核算 |

### 11.5 prompt_cache_key 等免费增益手段（不花钱提升命中率）

1. **`prompt_cache_key`**：OpenAI（GPT-5.6+ 建议设置以获得更可靠匹配；路由优化，约 15 请求/分钟/key）、xAI（Responses API 下应传 UUID 字段，与粘性路由等效）、Kimi（session/task id 语义，Coding Plan 必填）。注意：DeepSeek 不支持、静默忽略。
2. **`x-grok-conv-id` HTTP 头**（xAI）：相同会话 ID 请求路由到同一服务器，最大化命中率。
3. **`x-dashscope-session-cache: enable` Header**（百炼 Responses）：开启 Session 缓存，自动结合 `previous_response_id` 多轮关联。
4. **`previous_interaction_id`**（Gemini stateful 隐式缓存）：跨请求关联上下文。
5. **GLM-4.7 保留式推理**：自动保留多轮推理块，提高缓存命中率、降低计算成本（零配置）。
6. **通用零成本手段**：前缀稳定 + 静态在前动态在后 + 稳定请求流（对纯自动阵营免费但有效）；视觉场景按「同一图像反复问→图像在前，不同图像同一问题→文本在前」排列（百炼官方建议）。

### 11.6 尚未核实事项（诚实边界）

1. 百炼 Qwen3-Max 系列缓存命中**绝对单价**：官方文档只给折扣比例（显式 10%、隐式 20%），需查百炼控制台 / 按量计费页。
2. 智谱 Anthropic 端点是否处理 cache_control 断点：需向 `https://api.z.ai/api/anthropic` 实测，观察 `usage.cache_read_input_tokens`。
3. 智谱 GLM Responses API 支持情况：docs.z.ai 未发现相关文档。
4. xAI 缓存命中具体价格数字：官方指向 pricing 页，gaps 未独立抓取（draft 价格来自 usage-and-pricing 页）。
5. 方舟 / 千帆的命中计量字段：本次未获取到，接入时需实测。
