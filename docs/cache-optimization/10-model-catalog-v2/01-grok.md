# 01 - xAI Grok 模型目录与定价（v2 专项 R1 调研）

> 「模型目录与定价 v2」专项 R1 调研产物。本文件为 Grok 单厂商调研稿，用于后续合并进 v2 目录（10-model-catalog-v2）。
> 调研时间：2026-08-03。所有价格单位 USD / 1M tokens（官方定价页标注「All prices are in USD」）。
> 旧版对照：`docs/cache-optimization/00-vendor-model-pricing-catalog.md` §6（grok-4.5 / grok-4.3 / grok-4.20-0309 三行，缺长上下文价与全模型清单，本次补全）。

## 来源清单

| #   | 来源                   | URL                                                                                  | 获取日期   | 用途                                     |
| --- | ---------------------- | ------------------------------------------------------------------------------------ | ---------- | ---------------------------------------- |
| 1   | xAI 官方模型页         | https://docs.x.ai/developers/models                                                  | 2026-08-03 | 模型清单 + 文本/Imagine/Voice 定价       |
| 2   | xAI 官方定价页         | https://docs.x.ai/developers/pricing                                                 | 2026-08-03 | 定价 + Batch/Priority/工具调用/存储费    |
| 3   | xAI 缓存机制           | https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works          | 2026-08-03 | 缓存原理（前缀匹配）                     |
| 4   | xAI 缓存计量与定价     | https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing     | 2026-08-03 | 计量字段 + 长上下文计费口径              |
| 5   | xAI 缓存最大化命中     | https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits | 2026-08-03 | x-grok-conv-id / prompt_cache_key / gRPC |
| 6   | xAI 缓存最佳实践与 FAQ | https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices        | 2026-08-03 | TTL / 强制 miss / 流式 / 工具调用        |
| 7   | xAI 什么破坏缓存       | https://docs.x.ai/developers/advanced-api-usage/prompt-caching/multi-turn            | 2026-08-03 | 推理模型 reasoning_content 回传规则      |
| 8   | xAI 模型详情 grok-4.5  | https://docs.x.ai/developers/models/grok-4.5                                         | 2026-08-03 | 别名 / 速率限制 / 区域                   |
| 9   | xAI 模型详情 grok-4.3  | https://docs.x.ai/developers/models/grok-4.3                                         | 2026-08-03 | 别名 / 速率限制 / 区域                   |
| 10  | models.dev API         | https://models.dev/api.json                                                          | 2026-08-03 | 交叉验证价格 + 输出上限（非官方口径）    |
| 11  | OpenRouter API         | https://openrouter.ai/api/v1/models                                                  | 2026-08-03 | 交叉验证价格                             |

## 1. 完整模型清单（2026-08-03 官方在售）

官方 models 页 Text API 共 **6 个文本模型**。无独立「fast/thinking」档命名；档位差异体现在：① `grok-4.20-0309` 拆为 reasoning / non-reasoning 两个模型；② `grok-build-0.1` 是官方定位「fast coding model」的快速档；③ grok-4.5 / 4.3 通过 reasoning effort 档（low/medium/high）控制思考深度。

| 模型 ID                        | 定位                                                 | 发布日     | 上下文窗口 | 输出上限                          | 别名                                   |
| ------------------------------ | ---------------------------------------------------- | ---------- | ---------- | --------------------------------- | -------------------------------------- |
| `grok-4.5`                     | 旗舰（官方推荐 code/chat 首选，知识截止 2026-02-01） | 2026-07-08 | 500,000    | 官方未公布（models.dev: 500,000） | `grok-4.5-latest`、`grok-build-latest` |
| `grok-4.3`                     | 上一代旗舰                                           | 2026-04-17 | 1,000,000  | 官方未公布（models.dev: 30,000）  | `grok-4.3-latest`、`grok-latest`       |
| `grok-4.20-0309-reasoning`     | 推理档（文档重分析/长周期工具调用）                  | 2026-03-09 | 1,000,000  | 官方未公布（models.dev: 30,000）  | 日期型无滚动别名                       |
| `grok-4.20-0309-non-reasoning` | 非推理档（agentic 工具调用/编码）                    | 2026-03-09 | 1,000,000  | 官方未公布（models.dev: 30,000）  | 日期型无滚动别名                       |
| `grok-4.20-multi-agent-0309`   | 多 Agent 档（effort 支持 xhigh）                     | 2026-03-09 | 1,000,000  | 官方未公布（models.dev: 30,000）  | 日期型无滚动别名                       |
| `grok-build-0.1`               | 快速编码档（fast coding）                            | 2026-04-16 | 256,000    | 官方未公布（models.dev: 256,000） | 无                                     |

> 别名规则（官方）：`<modelname>` 指最新稳定版、`<modelname>-latest` 指最新版、`<modelname>-<date>` 钉死具体版本。模型窗口/速率限制与区域见详情页（4.5：150 RPS / 50M TPM，us-east-1、us-west-2；4.3：37 RPS / 10M TPM，us-east-1、eu-west-1、us-west-2）。
> 官方口径差异提示：models.dev 的 grok-4.20-multi-agent 上下文标 2M（OpenRouter 亦标 2M），官方文档标 1M——以官方为准。

非文本在售（成本计算如需覆盖，另行纳入）：`grok-imagine-image`（$0.02/图）、`grok-imagine-image-quality`（$0.05/图）、`grok-imagine-video`（$0.050/秒）、`grok-imagine-video-1.5`（$0.080/秒）；语音：`grok-voice-think-fast-1.0/2.0`（按分钟音频计费）、Speech to Text、Text to Speech（$15/1M 字符）。

## 2. 模型价格总表（USD / 1M tokens）

四指标：input / output / cache_read（官方称为「Cached input」）/ cache_write。**cache_write：官方定价结构无独立写入价列（模型页与定价页均为 input/cached input/output 三列），即缓存写入不单独计费**（写入免费为定价结构推断，官方未见「写免费」显式声明，见 §4 诚实边界）。

| 模型                         | 上下文 | 档位         | input | output | cache_read | cache_write | 备注                      |
| ---------------------------- | ------ | ------------ | ----- | ------ | ---------- | ----------- | ------------------------- |
| grok-4.5                     | 500K   | <200K prompt | $2.00 | $6.00  | $0.30      | 无写入费    | 命中 = 15%                |
| grok-4.5                     | 500K   | ≥200K prompt | $4.00 | $12.00 | $0.60      | 无写入费    | 长上下文 2x               |
| grok-4.3                     | 1M     | <200K prompt | $1.25 | $2.50  | $0.20      | 无写入费    | 命中 = 16%；Batch 20% off |
| grok-4.3                     | 1M     | ≥200K prompt | $2.50 | $5.00  | $0.40      | 无写入费    | 长上下文 2x               |
| grok-4.20-0309-reasoning     | 1M     | <200K prompt | $1.25 | $2.50  | $0.20      | 无写入费    | 价格同 4.3；Batch 20% off |
| grok-4.20-0309-reasoning     | 1M     | ≥200K prompt | $2.50 | $5.00  | $0.40      | 无写入费    |                           |
| grok-4.20-0309-non-reasoning | 1M     | <200K prompt | $1.25 | $2.50  | $0.20      | 无写入费    | 价格同 4.3；Batch 20% off |
| grok-4.20-0309-non-reasoning | 1M     | ≥200K prompt | $2.50 | $5.00  | $0.40      | 无写入费    |                           |
| grok-4.20-multi-agent-0309   | 1M     | <200K prompt | $1.25 | $2.50  | $0.20      | 无写入费    | 价格同 4.3；Batch 20% off |
| grok-4.20-multi-agent-0309   | 1M     | ≥200K prompt | $2.50 | $5.00  | $0.40      | 无写入费    |                           |
| grok-build-0.1               | 256K   | <200K prompt | $1.00 | $2.00  | $0.20      | 无写入费    | 命中 = 20%                |
| grok-build-0.1               | 256K   | ≥200K prompt | $2.00 | $4.00  | $0.40      | 无写入费    |                           |

- **长上下文规则**（关键计费语义）：阈值 **200,000 prompt tokens**；官方原文「requests whose prompt reaches the listed token threshold are billed at the higher rate for **all tokens** in the request」——超过阈值后**整请求全部 token**（含缓存命中部分）按长上下文档计费，不是只对超出部分计价。缓存文档确认：`total prompt tokens (including cached tokens)` 计入阈值判断。
- 交叉验证：models.dev（input/cache_read/output 与官方逐值一致，含 `context_over_200k` 档）与 OpenRouter（input/output 一致，cache_read/cache_write 未发布）均无冲突。

## 3. 缓存机制说明

### 3.1 自动前缀缓存（核心语义）

- 全自动、所有 grok 语言模型默认启用，无任何手动断点参数（**无 Anthropic 式 `cache_control`**，官方缓存文档未提供该参数）。
- 缓存键 = **messages 数组开头的精确前缀**：首次请求全量处理并缓存；后续请求若开头消息与既往请求逐条完全一致，匹配部分从缓存服务（hit），仅新增部分重新计算。
- **不保证 100% 命中**：内存压力驱逐、请求被路由到不同服务器都会 miss（官方明示，无确定性承诺）。
- 命中判定只看前缀是否逐 token 一致：编辑 / 删除 / 重排任何早期消息都使整个前缀失效（多轮文档有 4 组 curl 对照示例验证）。

### 3.2 命中率提升手段（粘性路由，非断点）

| 通道                   | 手段                                        | 语义                                                                              |
| ---------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| Chat Completions       | HTTP 头 `x-grok-conv-id: <conversation-id>` | 把同一会话的请求路由到同一服务器（缓存按服务器存放，粘性路由最大化命中率）        |
| Responses API          | 请求体字段 `prompt_cache_key: <UUID>`       | 功能等同 `x-grok-conv-id`（官方原文「functions identically」），官方示例值为 UUID |
| gRPC（Python xAI SDK） | metadata 传 `x-grok-conv-id`                | 同上                                                                              |
| 任意                   | `previous_response_id`（有状态续接）        | 自动续接对话并维持缓存（推理模型场景推荐，见 3.3）                                |

- 官方最佳实践原文第 1 条：「**Always set `x-grok-conv-id`**（或 Responses 的 `prompt_cache_key`）」——官方将其列为提升命中率的第一手段。
- 强制 miss：换用不同会话 ID 或省略该头即可（路由到无缓存的服务器）。
- 官方命名提示：`cached_tokens` 持续为 0 时，优先检查是否设置 `x-grok-conv-id` / `prompt_cache_key`，以及是否改动过早期消息。

### 3.3 推理模型的特殊规则（重要）

- **必须回传 `reasoning_content`**：推理模型（如 grok-4.5）多轮续聊时，若省略上一轮的 `reasoning_content`（加密推理内容），是官方点名的**缓存 miss 头号原因**；回传加密 reasoning 内容即可维持前缀命中。
- 替代方案：用 `previous_response_id` 有状态续接，免手动回传。
- 缓存前缀包含 tool call 结果：只要前缀不变，工具调用场景同样受益于缓存。

### 3.4 未公布项（不得编造）

| 项                  | 状态                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 最低可缓存 token 数 | **官方未公布**（缓存文档与 FAQ 均未给出阈值，与 Anthropic 512/OpenAI 1024 不同，xAI 无此数值）                                                                  |
| 缓存 TTL            | **官方未公布具体时长**（FAQ 仅说明「Cache entries can be evicted at any time due to server load or restarts」，建议用粘性路由最大化留存；无服务端保留时长声明） |
| 缓存写入价格        | 官方定价表无写入价列 → 推断无写入费（未见到「写免费」显式声明，标注为推断）                                                                                     |
| 输出上限            | 官方模型页未公布；models.dev 口径 4.5=500K / 4.3、4.20 系=30K / build=256K，仅作参考                                                                            |

### 3.5 计量字段

- Chat Completions：`usage.prompt_tokens_details.cached_tokens`（同容器内另有 `text_tokens` / `audio_tokens` / `image_tokens` 细分）
- Responses API：`usage.input_tokens_details.cached_tokens`
- gRPC（xAI SDK）：`usage.cached_prompt_text_tokens`
- 命中判定：`cached_tokens = 0` → 完全 miss；`> 0` → 部分/全部命中；`= prompt_tokens` → 全量命中（重复发同一请求时罕见）
- **Responses API：官方支持并主推**（`/v1/responses`，缓存/工具/批量文档均以其为主接口）；Chat Completions 与 gRPC 并存

## 4. 附加计费项（成本计算需知晓）

- **Batch API**：grok-4.3 / 4.20-0309-reasoning / 4.20-0309-non-reasoning / 4.20-multi-agent-0309 打 8 折（全部 token 类型）；**grok-4.5 与 grok-build-0.1 无批量折扣**。
- **Priority Processing**：标准价 **2x**（Chat Completions / Responses 专属，缓存折扣先算、乘数后乘；仅响应确认 `service_tier: "priority"` 才按 2x 计费）。
- **服务器端工具调用费**（$ / 1K calls）：web_search $5、x_search $5、code_execution $5、attachment_search $10、collections_search $2.50；view_image / view_x_video 按 token 计；MCP 远程工具按 token 计。
- **存储费**：文件 $0.025/GiB/天、集合 $0.10/GiB/天；下载 $0.20/GiB。
- 违规生成照常计费；Responses 生成前拦截收 $0.05/请求违规费。

## 5. 特化优化线索（opencode / crish 侧）

- 外部线索：opencode 项目（非本仓库）曾在 xAI provider 的 transform.ts 对 `promptCacheKey` 默认开启（AI SDK `providerOptions.xai.promptCacheKey`），对应本文 §3.2 的 Responses API `prompt_cache_key` 粘性路由语义——xAI 官方将其定位为**路由辅助键而非显式断点**，设置稳定值（会话 ID / UUID）即可提升命中，不存在 OpenAI GPT-5.6+ 那样的 key 流量限制（15 请求/分钟）声明。
- crish 现状对照：`packages/shared-utils/src/cache/usage-parse.ts:228`（`resolveCacheAffinity`）由 sessionId 派生 `promptCacheKey` 的 R3 设计（`cacheAffinity === false` 强制新域）与 xAI 语义吻合：会话 ID 稳定 → 粘性路由稳定 → 命中率最大化；注意 xAI 侧**无显式断点概念**，任何会话内早期消息改动都会 miss，压缩/摘要等重写历史消息的操作必然牺牲前缀命中。
- 交叉厂商注意：xAI 的 `prompt_cache_key` 与 OpenAI 同名但语义不同（OpenAI 为断点路由优化且有 15 req/min 流控），适配层需按厂商区分。

## 6. 未获取项汇总

1. 最低可缓存 token 数：官方未公布。
2. 缓存 TTL：官方未公布（仅「随时可能驱逐」）。
3. 缓存写入价：无官方定价列，写入免费为推断。
4. 各模型输出上限：官方未公布（models.dev 口径仅作参考）。
5. grok-4.20 系列其他历史版本（0309 之前）价格：官方已不在 models 页在售清单，未获取（如 00-catalog 旧文提到的「grok-4.20-0309 价格同 4.3」口径已由本次官方定价页确认覆盖）。
6. 多 Agent 档（multi-agent）的实际使用限制（tool_call 官方标 false）：仅作能力标注，未进一步核实其 API 用法。

## 7. 与 00-catalog §6 的差异修正

| 项                  | 00-catalog §6 原状 | 本次核实                                                                                |
| ------------------- | ------------------ | --------------------------------------------------------------------------------------- |
| grok-4.3 长上下文价 | 未获取             | $2.50 / $0.40 / $5.00（≥200K 全量计费）                                                 |
| 模型清单            | 3 行               | 6 个文本模型 + 4 imagine + 语音；4.20 系分 reasoning/non-reasoning/multi-agent 三个模型 |
| grok-4.5 上下文     | 未写明             | 500K（官方）                                                                            |
| 命中比例            | 15%（4.5）         | 15%（4.5）/ 16%（4.3、4.20 系）/ 20%（build-0.1）                                       |
| 缓存写入费          | 未提及             | 无独立写入价列（推断免费）                                                              |
