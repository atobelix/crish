# 厂商缓存调研缺口补充（第二轮）

- 撰写日期：2026-08-02
- 调研方式：通过 webfetch 直接访问各厂商官方文档
- 文档性质：对上一轮厂商缓存调研（覆盖 DeepSeek/GLM/Kimi/Grok/MiniMax/Gemini/Anthropic/OpenAI/火山方舟/百度千帆）的三个缺口的补充核实
- 内容约定：所有条目标注「已确认」（原文可复核）或「未能获取/未确认」（不编造）；金额均为官方文档原值

---

## 一、阿里云百炼 Qwen 上下文缓存（缺口 1）

**来源 URL**：https://help.aliyun.com/zh/model-studio/context-cache
**获取时间**：2026-08-02
**结论**：百炼上下文缓存机制已完整确认。**提供「显式缓存」与「隐式缓存」两种互斥模式**，同时 Responses API 另有独立的「Session 缓存」机制。

### 1.1 两种缓存模式对比（已确认）

| 维度 | 显式缓存 | 隐式缓存 |
|---|---|---|
| 开启方式 | 需主动在 messages 的 content 块上加 `"cache_control": {"type": "ephemeral"}` | 自动开启，无需配置，无法关闭 |
| 缓存创建计费 | 输入 Token 标准单价的 **125%** | 输入 Token 标准单价的 **100%**（无额外费用） |
| 命中计费 | 输入 Token 标准单价的 **10%** | 输入 Token 标准单价的 **20%**（多数百炼部署模型） |
| 最低可缓存 Token | **1024** | 百炼部署模型 **256**；Qwen3.7 系列约 **2000**；智谱部署 GLM、稀宇 MiniMax 为 **512** |
| 有效期 | 5 分钟（命中后重置） | 不确定，系统定期清理长期未使用缓存 |
| 命中确定性 | 确定性命中 | 命中率不确定，即使完全一致也可能未命中 |
| 其他限制 | 单请求最多 4 个标记；回溯窗口 20 个 content 块 | 无手动控制 |

- 两模式互斥：单个请求只能应用其中一种。
- 显式缓存创建发生在**模型响应之后**（先请求、后建缓存，命中需等首次请求完成）。
- 缓存命中概率非 100%，属系统判定。

### 1.2 显式缓存（cache_control）细节（已确认）

- 支持协议：OpenAI Chat Completions、DashScope、Anthropic 兼容接口（三者计量字段不同，见 1.4）。
- 支持模型（华北2北京为例）：qwen3.7-max、qwen3.6-max-preview、qwen3.5/3.7 系列 Plus、qwen3.7-flash、qwen3-coder-plus/flash、qwen3-vl-plus/flash，以及第三方模型 deepseek-v3.2、kimi-k2.6/k2.5/k2.7-code、glm-5.1（其他地域模型列表详见原文）。
- 可缓存内容：`messages` 数组中 system / user / assistant / tool 消息的 content 块。
  - **tools 数组中的 cache_control 标记会被忽略**，工具定义作为系统消息的一部分参与缓存计算（工具定义不允许独立缓存）。
  - 若请求含 tools 参数，工具定义会序列化为 JSON 参与缓存，需保证每次请求的工具列表顺序、字段顺序、字段结构完全一致，否则缓存失效。
- 命中策略：以每个 cache_control 位置为终点**向前回溯最多 20 个 content 块**尝试命中；选取最长匹配前缀并重置有效期。
- 仅支持 `type: "ephemeral"`。
- 若标记数超过 4 个，仅最后 4 个生效。
- 建议：并行工具调用时把多个 tool 结果合并为一条消息 + 多个 content 块，避免超出 20 块回溯窗口。

### 1.3 隐式缓存细节（已确认）

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
- 提示：OpenAI 兼容 Batch（文件输入）方式无法享受缓存折扣。

### 1.4 计量字段（已确认）

| 协议 | 命中缓存计量字段 | 创建缓存计量字段 |
|---|---|---|
| OpenAI Chat Completions | `usage.prompt_tokens_details.cached_tokens` | `usage.prompt_tokens_details.cache_creation_input_tokens` |
| DashScope | `usage.prompt_tokens_details.cached_tokens` | `usage.prompt_tokens_details.cache_creation_input_tokens` |
| Anthropic 兼容 | `usage.cache_read_input_tokens`（不计入 input_tokens，单独报告） | `usage.cache_creation_input_tokens` |

### 1.5 Responses API 的 Session 缓存（已确认，另见来源）

**来源 URL**：https://help.aliyun.com/zh/model-studio/compatibility-with-openai-responses-api
**获取时间**：2026-08-02

- Responses API 不走显式/隐式缓存，而是通过 Header `x-dashscope-session-cache: enable` 开启 **Session 缓存**（默认 `disable`）。
- 服务端自动缓存对话上下文（结合 `previous_response_id` 多轮关联），无需手动管理。
- 最小可缓存提示词 1024 Token，有效期 5 分钟；约束限制与显式缓存一致。
- 支持模型：qwen3-max / qwen3.7-max / qwen3.7-plus / qwen3.6-plus / qwen3.5-plus / qwen3.7-flash / qwen3.6-flash / qwen3.5-flash / qwen-plus / qwen-flash / qwen3-coder-plus / qwen3-coder-flash。
- 计量：`usage.input_tokens_details.cached_tokens`（Responses 响应中已出现该字段）。
- 百炼 Responses 端点：`POST {base}/compatible-mode/v1/responses`（旧路径 `/api/v2/apps/protocols/compatible-mode/v1/responses` 即将停用）。

### 1.6 未能获取

- **Qwen3-Max / Qwen3.7-Max 系列的缓存命中绝对单价**（如 X 元/百万 token）：官方文档只给出折扣比例（显式命中 10%、隐式命中 20%），绝对价格需查百炼控制台与按量计费页，本次未获取。
- `docs.qwen.ai` 与 `platform.qianwenai.com` 上的独立缓存文档：未找到（docs.qwen.ai 对应页面访问失败）。

---

## 二、DeepSeek v4 0731 Responses API 支持情况（缺口 2）

**来源 URL**：
- https://api-docs.deepseek.com/guides/responses_api
- https://api-docs.deepseek.com/guides/kv_cache
- https://api-docs.deepseek.com/quick_start/pricing
**获取时间**：2026-08-02

### 2.1 Responses API 支持范围（已确认）

- 当前**仅支持 `deepseek-v4-flash`**；`deepseek-v4-pro` **尚未支持**，官方计划 **2026 年 8 月初**加入支持。
- base_url：`https://api.deepseek.com`（OpenAI SDK `client.responses.create` 可直接调用）。
- 模型版本号确认：定价页标注 v4-flash 版本为 **DeepSeek-V4-Flash-0731**（与用户提到的 0731 正式版一致）；v4-pro 标注为 DeepSeek-V4-Pro（无版本号细节）。
- 无状态 API：`previous_response_id`、`conversation`、`store`、`background`、`include`、`prompt`、`truncation`、`service_tier`、`safety_identifier` 均不支持；不支持的参数**静默忽略**，不报错（兼容既有 Responses 客户端）。
- 上下文长度 1M；输出最大 384K。

### 2.2 Responses API 下缓存计量与 cache 参数（已确认）

- **缓存计量**：`usage.input_tokens` 中 `input_tokens_details.cached_tokens` 为命中上下文缓存的 token 数；`output_tokens_details.reasoning_tokens` 为思维链 token 数。
- **`prompt_cache_key` / `prompt_cache_retention` 不支持**——官方明确说明缓存由系统自动管理（与 OpenAI 不同，无手动缓存键），请走自动 KV 缓存。
- `reasoning` 参数：`effort` 支持（thinking 模式下 temperature/top_p 无效）；`summary` 被接受但不生成摘要。
- 工具：`function`、`web_search`/`web_search_2025_08_26` 支持；`custom` 仅支持 `apply_patch`（Codex 兼容）；`file_search`/`code_interpreter`/`computer_use`/`mcp` 被忽略。
- 流式事件：`response.reasoning_text.delta` / `response.reasoning_text.done` 提供思维链增量与全文；以 `response.completed` / `incomplete` / `failed` 结束（无 `data: [DONE]`）。

### 2.3 DeepSeek v4 自动缓存（KV 缓存）最新机制（已确认）

- 磁盘上下文缓存默认对所有用户开启，无需改代码。
- 由于滑动窗口注意力（SWA），缓存前缀以**独立的「缓存前缀单元」**为单位存储与匹配；后续请求必须**完整匹配某个缓存前缀单元**才能命中（不再与 OpenRouter/Anthropic 式的"任意前缀命中"相同）。
- 前缀单元持久化时机：
  1. 请求边界：每次请求在「用户输入末尾」和「模型输出末尾」各产生两个缓存前缀单元；
  2. 公共前缀检测：系统检测到多请求公共前缀时，将其持久化为独立单元（例：请求 A+B 与 A+C 共享前缀 A，第三次请求 A+D 可命中 A）；
  3. 固定 token 间隔：长输入/长输出按固定间隔切出单元，避免长前缀因永远到不了末尾而无法缓存。
- 计量字段（Chat Completions）：`usage.prompt_cache_hit_tokens`、`usage.prompt_cache_miss_tokens`。
- 构建耗时：**数秒级**；缓存不再被使用后自动清除，通常数小时到数天。
- 命中为 best-effort，不保证 100%；缓存只匹配输入前缀，输出仍按当前参数全新生成（保留随机性）。

### 2.4 DeepSeek v4 定价（已确认，2026-08-02 抓取）

| 模型 | 输入（缓存命中） | 输入（未命中） | 输出 | 命中/未命中比 |
|---|---|---|---|---|
| deepseek-v4-flash | $0.0028 / 1M | $0.14 / 1M | $0.28 / 1M | 2% |
| deepseek-v4-pro | $0.003625 / 1M | $0.435 / 1M | $0.87 / 1M | ≈0.83% |

- 注意：官方公告即将实行**高峰/低谷定价**，高峰时段（北京时区 9:00–12:00、14:00–18:00）价格 2 倍，生效日期待公告。

---

## 三、智谱 GLM 的 cache_control 支持确认（缺口 3）

**来源 URL**：
- https://docs.z.ai/guides/capabilities/cache（缓存机制）
- https://docs.z.ai/guides/llm/glm-4.7（GLM-4.7 保留式推理）
- https://docs.z.ai/devpack/tool/claude（Claude Code 集成，Anthropic 端点）
- https://docs.z.ai/devpack/tool/others（Coding Endpoint 表）
**获取时间**：2026-08-02

### 3.1 GLM 官方缓存机制（已确认）

- 缓存类型：**自动隐式缓存**——基于内容相似度自动识别重复上下文，无手动配置、无缓存断点（官方 v4 接口文档中的缓存页未提供任何 `cache_control` 手动机制）。
- 计量字段：`usage.prompt_tokens_details.cached_tokens`（OpenAI 兼容 v4 格式）。
- 命中价格：缓存命中 token 按优惠价计费，官方文档示例为**标准价的约 50%**（0.005/0.01 示例，"usually 50% of standard price"）。
- 支持模型：GLM-5、GLM-4.7、GLM-4.6、GLM-4.5 系列等全部主流模型（文档原文）。
- 注意：内容完全相同命中率最高，轻微格式差异可能影响缓存；缓存有合理时限，过期后重新计算。
- 补充（百炼侧数据，见第一节）：智谱 GLM 在阿里云百炼的隐式缓存折扣为 20%~25%，智谱部署模型（ZHIPU/GLM-5.2/5.1/5）为 25%，GLM 在百炼的最低缓存 Token 数为 512。

### 3.2 cache_control 是否被接受（未能确认，需实测）

- **已确认存在** Anthropic 兼容端点：`https://api.z.ai/api/anthropic`（Claude Code 等工具通过 `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` 接入 GLM，见 devpack/tool/claude.md 与 others.md 的 Coding Endpoint 表）。
- **未确认**该 Anthropic 端点是否接受/处理 Anthropic 式 `cache_control` 断点：官方缓存文档（cache.md）只描述自动缓存，Claude Code 集成文档未提及 cache_control 行为。结论：**从官方文档无法确认**，建议实测（发带 cache_control 的请求观察 `usage.cache_read_input_tokens` 等字段变化）。

### 3.3 GLM-4.7「保留式推理」机制（已确认）

GLM-4.7 引入三类推理机制（docs.z.ai/guides/llm/glm-4.7，2026-08-02）：

- **交错推理（Interleaved Reasoning）**：每次回复/工具调用前先推理，提升复杂指令遵从与代码质量（GLM-4.5 引入）。
- **保留式推理（Retention-Based Reasoning）**：**自动保留多轮对话中的推理块**，从而**提高缓存命中率、降低计算成本**，适合长期复杂任务——这正是本次调研要确认的机制，已确认存在。
- **轮级推理（Round-Level Reasoning）**：会话内按轮控制推理开销（简单任务关闭推理降延迟，复杂任务开启提稳定）。

上下文长度：GLM-4.7 系列 200K，最大输出 128K（含 Flash/FlashX）。

---

## 四、顺带核实：MiniMax M3 与 M2.x 缓存差异（补充项 4）

**来源 URL**：
- https://platform.minimaxi.com/docs/api-reference/text-prompt-caching（自动/被动缓存）
- https://platform.minimaxi.com/docs/api-reference/anthropic-api-compatible-cache（主动缓存）
**获取时间**：2026-08-02

**已确认**：MiniMax 提供两套缓存体系，「主动缓存」（Anthropic 式 `cache_control`）与「被动缓存」（自动前缀缓存）。

| 维度 | 被动缓存（Prompt 缓存） | 主动缓存（Anthropic 式） |
|---|---|---|
| 使用方式 | 自动识别重复内容，无需改调用 | 显式 `cache_control` 断点（最多 4 个，20 块回溯） |
| 支持模型 | **MiniMax-M3**、M2.7、M2.5、M2.1 系列 | **M2.7、M2.5、M2.1、M2 系列（不含 M3）** |
| 写入计费 | 无额外写入费 | 首次写入额外计费（M2.7 写入 2.625 元/1M；M2.5/M2.1 写入 2.625 元/1M） |
| 读取计费 | 优惠价（M3 示例 0.84 元/1M vs 标准输入 4.20 元/1M，即 20%） | M2.7 读取 0.42 元/1M；M2.5/M2.1 读取 0.21 元/1M |
| 最低可缓存量 | ≥ **512** 输入 token | 无明确最小量（示例 18.8 万 token 大文本） |
| 过期 | 按系统负载自动调整 | 5 分钟，命中自动续期 |
| 计量字段 | `usage.cache_read_input_tokens`（Anthropic 格式）/ `usage.prompt_tokens_details.cached_tokens`（OpenAI 格式） | `usage.cache_creation_input_tokens` / `cache_read_input_tokens` / `input_tokens` |

关键结论：**MiniMax-M3 不支持主动缓存（cache_control 断点）**，只走自动缓存；M2.x（M2.1/M2.5/M2.7/M2）支持主动缓存。另：M3 输入 >512k 时适用长上下文价格（输入 token 含缓存命中部分）。

---

## 五、顺带核实：xAI Grok 的缓存键用法（补充项 5）

**来源 URL**：
- https://docs.x.ai/prompt-caching（总览）
- https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works
- https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits
- https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing
**获取时间**：2026-08-02

**已确认**：

- 缓存类型：**自动前缀缓存**——连续请求的开头消息完全一致时自动命中，无手动断点；不保证 100% 命中（内存压力逐出、路由到不同服务器都会导致失效）。
- **`x-grok-conv-id` HTTP 头（Chat Completions / gRPC metadata）**：相同会话 ID 的请求被路由到同一服务器（粘性路由），最大化缓存命中率——官方推荐设置。
- **`prompt_cache_key`（Responses API）**：请求体中直接传该字段（UUID），功能与 `x-grok-conv-id` 等同（同一服务器的缓存复用）。示例模型：grok-4.5。
- 计量字段：Chat Completions 用 `usage.prompt_tokens_details.cached_tokens`；Responses API 用 `usage.input_tokens_details.cached_tokens`。
- 命中判定：`cached_tokens` 为 0 = 未命中（首次请求或缓存被逐出）；等于 `prompt_tokens` = 全命中；多轮对话中该值应随轮次递增。
- 定价：缓存命中按「cached prompt token」价（大幅低于普通输入价，具体数值以 https://docs.x.ai/developers/pricing 为准，本次未抓取具体数字）；超长上下文阈值后，缓存与未缓存 token 均按各自的长上下文价计费。

---

## 六、厂商速查汇总表

| 厂商 | 缓存类型 | 最低缓存量 | 计量字段 | 命中价格 | cache_control | Responses API |
|---|---|---|---|---|---|---|
| 阿里云百炼 Qwen | 显式（手动断点）+ 隐式（自动）双模式，互斥 | 显式 1024；隐式 256（Qwen3.7 约 2000）；Responses Session 缓存 1024 | `prompt_tokens_details.cached_tokens` / `cache_creation_input_tokens`（OpenAI/DashScope）；`cache_read_input_tokens`（Anthropic）；`input_tokens_details.cached_tokens`（Responses） | 显式命中 10%、创建 125%；隐式命中 20%（deepseek-v4-pro 例外，部分第三方部署 8.33%~40%） | ✅ 支持（仅 ephemeral，≤4 个，20 块回溯） | ✅ 支持（Session 缓存，Header `x-dashscope-session-cache: enable`） |
| DeepSeek v4 | 自动磁盘缓存（前缀单元制），无手动 | 无明确下限（单元式持久化） | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（Chat）；`input_tokens_details.cached_tokens`（Responses） | flash $0.0028/1M（=2%）；pro $0.003625/1M（≈0.83%） | ❌ 不支持 | ✅ v4-flash 支持；**v4-pro 2026 年 8 月初**；`prompt_cache_key` 不支持 |
| 智谱 GLM（z.ai） | 自动隐式缓存（相似度识别） | 未标注（百炼侧 GLM 为 512） | `prompt_tokens_details.cached_tokens` | 约标准价 50%（官方示例） | ❓ 官方缓存文档无断点机制；Anthropic 端点存在（api.z.ai/api/anthropic）但**是否处理 cache_control 未确认** | ❓ 未在官方文档发现 Responses API 支持说明 |
| MiniMax | 被动自动缓存 + 主动 cache_control 缓存 | 被动 ≥512；主动无明确下限 | `prompt_tokens_details.cached_tokens` / `cache_read_input_tokens`、`cache_creation_input_tokens` | M3 被动命中 20%（0.84 vs 4.20 元/1M）；M2.7 主动读取 0.42 元/1M | ✅ 主动缓存仅 **M2.x**（M2.1/2.5/2.7/M2）；**M3 不支持** | ✅ 有 Responses 兼容接口（responses-create 文档） |
| xAI Grok | 自动前缀缓存 + 粘性路由 | 未标注 | Chat：`prompt_tokens_details.cached_tokens`；Responses：`input_tokens_details.cached_tokens` | cached prompt token 价（大幅折扣，具体见定价页） | ❌ 无断点；用 `x-grok-conv-id` 头 / `prompt_cache_key` 字段提升命中 | ✅ 支持，`prompt_cache_key` 字段原生支持 |

---

## 七、未能获取 / 待办事项清单（诚实边界）

1. **百炼 Qwen3-Max 系列缓存命中绝对单价**：文档仅给折扣比例，绝对价格需查百炼控制台/按量计费页（未获取）。
2. **智谱 GLM Anthropic 端点是否处理 cache_control 断点**：官方文档未说明（z.ai 缓存页无断点机制、Claude Code 集成页未提）。**需实测**：向 `https://api.z.ai/api/anthropic` 发送带 cache_control 的请求，观察 `usage.cache_read_input_tokens`。
3. **智谱 GLM Responses API 支持情况**：本次未在 docs.z.ai 发现 Responses API 文档（llms.txt 无相关条目）。
4. **DeepSeek Responses API 下 `prompt_cache_key` 之外的手动缓存控制**：官方确认不支持、缓存全自动；v4-pro 的 Responses 支持时间官方口径为"2026 年 8 月初"（本次文档未写具体日期，按"早期"表述）。
5. **xAI 缓存命中具体价格数字**：定价页未抓取（官方指向 https://docs.x.ai/developers/pricing），仅确认"大幅折扣"与长上下文规则。
6. 未能访问的路径：`docs.qwen.ai/guides/capabilities/prompt-caching`（传输错误）、`docs.bigmodel.cn/cn/guide/develop/anthropic_api`（404）、`docs.x.ai/guides/prompt-caching` 与 `docs.x.ai/docs/prompt-caching`（404，正确路径为 `/prompt-caching` 与 `/developers/advanced-api-usage/prompt-caching/*`）、`https://help.aliyun.com/zh/model-studio/context-caching`（404，正确路径为 `/context-cache`）。

---

## 八、对 Conex 项目的直接启示（调研结论引申）

1. **百炼通道**：qwen3.7-max 等走 OpenAI 兼容时可用显式缓存（命中 10%，比隐式 20% 更优），需把静态上下文放 messages content 块（工具定义放 tools 但会随系统消息参与缓存），遵守 4 标记/20 块回溯限制；若走 Responses API 则用 `x-dashscope-session-cache: enable` Header 的 Session 缓存。
2. **DeepSeek 通道**：v4-flash 已支持 Responses API 且缓存命中价仅 2%（$0.0028/1M），但无 prompt_cache_key——缓存全自动，命中质量依赖"完整匹配缓存前缀单元"，建议保持提示词前缀稳定。
3. **智谱通道**：官方接口为自动缓存（约 50% 折扣），无断点控制；GLM-4.7 保留式推理机制可提高多轮缓存命中（在 Claude Code 兼容端点下需实测 cache_control 行为）。
4. **MiniMax**：若用 M3 只能依赖自动缓存；要用主动 cache_control 需改用 M2.7 等 M2 系列。
5. **xAI**：Responses API 下记得传 `prompt_cache_key`（或 Chat Completions 下传 `x-grok-conv-id`）以启用粘性路由，否则缓存命中率不可靠。
