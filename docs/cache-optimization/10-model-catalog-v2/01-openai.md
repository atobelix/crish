# OpenAI 模型目录与定价调研（v2 专项 R1）

> 本文件是「模型目录与定价 v2」专项 OpenAI 厂商调研产出，供主 Agent 与后续 R2/R3 使用。
> 数据获取日期：**2026-08-03**（全部为当日抓取）。价格单位为 **USD/百万 tokens**。
> 未核实条目一律标注「未获取」，**不编造数字**。

## 1. 来源 URL 清单（获取日期：2026-08-03）

| #   | 来源                               | URL                                                                   | 用途                                                 |
| --- | ---------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | OpenAI 官方模型目录（HTML）        | https://platform.openai.com/docs/models                               | 模型清单与推荐入口                                   |
| 2   | OpenAI 官方定价页（Markdown 版）   | https://developers.openai.com/api/docs/pricing.md                     | **标准/Batch/Flex/Fast 全档价格表（主数据源）**      |
| 3   | OpenAI 官方模型目录（Markdown 版） | https://developers.openai.com/api/docs/models.md                      | 全模型清单（含旧模型）                               |
| 4   | 官方文档 llms.txt                  | https://platform.openai.com/docs/llms.txt                             | Markdown 版文档索引                                  |
| 5   | GPT-5.6 Sol 模型页                 | https://developers.openai.com/api/docs/models/gpt-5.6-sol.md          | 上下文/快照/端点/长上下文规则                        |
| 6   | GPT-5.6 Terra 模型页               | https://developers.openai.com/api/docs/models/gpt-5.6-terra.md        | 同上                                                 |
| 7   | GPT-5.6 Luna 模型页                | https://developers.openai.com/api/docs/models/gpt-5.6-luna.md         | 同上                                                 |
| 8   | GPT-5.5 模型页                     | https://developers.openai.com/api/docs/models/gpt-5.5.md              | 同上                                                 |
| 9   | GPT-5.5 Pro 模型页                 | https://developers.openai.com/api/docs/models/gpt-5.5-pro.md          | 同上                                                 |
| 10  | GPT-5.4 模型页                     | https://developers.openai.com/api/docs/models/gpt-5.4.md              | 同上                                                 |
| 11  | GPT-5.4 mini 模型页                | https://developers.openai.com/api/docs/models/gpt-5.4-mini.md         | 同上                                                 |
| 12  | GPT-5.4 nano 模型页                | https://developers.openai.com/api/docs/models/gpt-5.4-nano.md         | 同上                                                 |
| 13  | GPT-5.4 Pro 模型页                 | https://developers.openai.com/api/docs/models/gpt-5.4-pro.md          | 同上                                                 |
| 14  | GPT-5.3-Codex 模型页               | https://developers.openai.com/api/docs/models/gpt-5.3-codex.md        | 同上                                                 |
| 15  | GPT-5.3 Chat 模型页                | https://developers.openai.com/api/docs/models/gpt-5.3-chat-latest.md  | 同上                                                 |
| 16  | Chat Latest 模型页                 | https://developers.openai.com/api/docs/models/chat-latest.md          | 同上                                                 |
| 17  | codex-mini-latest 模型页           | https://developers.openai.com/api/docs/models/codex-mini-latest.md    | 同上                                                 |
| 18  | **Prompt caching 官方指南**        | https://developers.openai.com/api/docs/guides/prompt-caching.md       | **缓存机制主数据源**                                 |
| 19  | Using GPT-5.6（最新模型指南）      | https://developers.openai.com/api/docs/guides/latest-model/gpt-5.6.md | 新命名体系/推理档位/缓存迁移                         |
| 20  | models.dev 目录                    | https://models.dev                                                    | 交叉验证（上下文窗口/发布日期）                      |
| 21  | OpenRouter 目录 API                | https://openrouter.ai/api/v1/models                                   | 交叉验证（价格含 cache_write/long-context override） |
| 22  | DuckDuckGo 网页检索                | https://html.duckduckgo.com/html/?q=%22composer+2.5%22+model+OpenAI   | composer 2.5 归属查证                                |

---

## 2. 核心结论（先读这里）

1. **GPT-5.6 是「系列名」而非单个模型**：官方新命名体系下，`gpt-5.6` 只是 **alias，路由到旗舰 `gpt-5.6-sol`**；完整系列为 `gpt-5.6-sol`（≈ 旧无后缀旗舰档）、`gpt-5.6-terra`（≈ 旧 mini 档）、`gpt-5.6-luna`（≈ 旧 nano 档）。**不存在 `gpt-5.6-codex` / `gpt-5.6-pro` / `gpt-5.6-chat` 这类官方模型 ID**（OpenRouter 上的 `gpt-5.6-*-pro` 是网关变体，对应官方 `reasoning.mode: "pro"` 请求参数，不是独立官方模型）。
2. **写入费 1.25x 仅 GPT-5.6 及以后家族生效**：sol $6.25 / terra $2.50 / luna $0.25（长上下文档 $12.50 / $5.00 / $0.50）；5.5 及更早模型缓存写入免费。
3. **TTL 两代语义完全不同**：5.6+ 用 `prompt_cache_options.ttl`，**唯一值 `30m`**（最小保留期，非上限）；旧模型用 `prompt_cache_retention`（`in_memory` 5-10 分钟活跃/上限 1 小时，或 `24h` extended，5.5/5.5-pro 仅支持 `24h`）。
4. **最低缓存前缀**：5.6+ 严格 1024 tokens；5.5 及更早 1024-2048 依模型而定（官方未公布逐模型精确值）。
5. **composer 2.5 不是 OpenAI 模型**：经官方文档、models.dev、OpenRouter 三方检索均无此名；网页查证为 **Cursor（Anysphere）2026-05-19 发布的编程模型**，基于 Moonshot Kimi K2.5 开源权重训练，与 OpenAI 目录无关（详见 §7）。
6. **codex 系列官方命名是 `gpt-5.x-codex`**：`gpt-5-codex` / `gpt-5.1-codex`（+`mini`/`max`）/ `gpt-5.2-codex` / `gpt-5.3-codex` / `codex-mini-latest`，**不存在 `codex-1/2/3` 命名**。

---

## 3. 完整模型表（主表：GPT-5.6 全系列 + 5.5 + 5.4 + 5.3 + 特化）

> 列说明：`input`=未缓存输入价；`output`=输出价；`cache_read`=缓存命中输入价；`cache_write`=缓存写入价（5.6+ 为 1.25x 实价，旧轨无写入费记「免费」，pro 档无缓存折扣记「—」）；TTL 档见 §5；`responses`=是否支持 Responses API。
> 价格全部来自官方定价页标准档（来源 2），上下文/端点来自对应模型页（来源 5-17）。

| 模型名（官方 ID）   | 上下文                       | input      | output     | cache_read               | cache_write | TTL 档          | 最低缓存     | responses    | 备注                                                                                                    |
| ------------------- | ---------------------------- | ---------- | ---------- | ------------------------ | ----------- | --------------- | ------------ | ------------ | ------------------------------------------------------------------------------------------------------- |
| gpt-5.6（alias）    | —                            | —          | —          | —                        | —           | 30m             | 1024         | 是           | **alias，路由到 gpt-5.6-sol**，不可用于模型参数列表                                                     |
| gpt-5.6-sol         | 1,050,000                    | $5.00      | $30.00     | $0.50                    | $6.25       | 30m             | 1024（严格） | 是           | 旗舰档；max input 922,000 / max output 128,000；cutoff 2026-02-16；>272K 输入 2x/1.5x（下详）           |
| gpt-5.6-terra       | 1,050,000                    | $2.00      | $12.00     | $0.20                    | $2.50       | 30m             | 1024（严格） | 是           | 平衡档（≈旧 mini）；max input 922,000 / output 128,000                                                  |
| gpt-5.6-luna        | 1,050,000                    | $0.20      | $1.20      | $0.02                    | $0.25       | 30m             | 1024（严格） | 是           | 成本档（≈旧 nano）；max input 922,000 / output 128,000                                                  |
| gpt-5.5             | 1,050,000                    | $5.00      | $30.00     | $0.50                    | 免费        | 24h（仅此档）   | 1024-2048    | 是           | cutoff 2025-12-01；快照 gpt-5.5-2026-04-23；>272K 2x/1.5x                                               |
| gpt-5.5-pro         | 1,050,000                    | $30.00     | $180.00    | —（无缓存折扣）          | 免费        | 24h（仅此档）   | 1024-2048    | 仅 Responses | Chat Completions 不支持；>272K 2x/1.5x；无 Batch 支持（来源 2 有价、来源 9 页面端点无 Batch 行=不支持） |
| gpt-5.4             | 1,050,000                    | $2.50      | $15.00     | $0.25                    | 免费        | in_memory / 24h | 1024-2048    | 是           | cutoff 2025-08-31；快照 gpt-5.4-2026-03-05；>272K 2x/1.5x                                               |
| gpt-5.4-mini        | 400,000                      | $0.75      | $4.50      | $0.075                   | 免费        | in_memory / 24h | 1024-2048    | 是           | max input 272,000；无长上下文价档                                                                       |
| gpt-5.4-nano        | 400,000                      | $0.20      | $1.25      | $0.02                    | 免费        | in_memory / 24h | 1024-2048    | 是           | max input 272,000；无长上下文价档                                                                       |
| gpt-5.4-pro         | 1,050,000                    | $30.00     | $180.00    | —（无缓存折扣）          | 免费        | in_memory / 24h | 1024-2048    | 仅 Responses | >272K 2x/1.5x；无 Batch                                                                                 |
| gpt-5.3-codex       | 400,000                      | $1.75      | $14.00     | $0.175                   | 免费        | in_memory / 24h | 1024-2048    | 仅 Responses | 编码专用；max input 272,000；Fast mode 档 $3.50/$0.35/$28（来源 2）                                     |
| gpt-5.3-chat-latest | 128,000（页面口径，见 §7-3） | $1.75      | $14.00     | $0.175                   | 免费        | in_memory / 24h | 1024-2048    | 是           | **已弃用**；ChatGPT Instant 快照；max output 16,384；页面「max input 272,000」疑似复制错误              |
| chat-latest         | 400,000                      | $5.00      | $30.00     | $0.50                    | 免费        | in_memory / 24h | 1024-2048    | 是           | 当前 ChatGPT Instant 模型；max input 272,000；无 Batch                                                  |
| codex-mini-latest   | 200,000                      | $1.50      | $6.00      | $0.375（**25% 非 10%**） | 免费        | in_memory / 24h | 1024-2048    | 仅 Responses | o4-mini 的 Codex CLI 微调版；cutoff 2024-06-01；max output 100,000                                      |
| gpt-5.5-cyber       | 未获取                       | $12.50     | $75.00     | $1.25                    | 免费        | 未获取          | 未获取       | 未获取       | 网络安全特化模型（定价页特化表）                                                                        |
| gpt-5.4-cyber       | 未获取                       | **未公布** | **未公布** | **未公布**               | —           | 未获取          | 未获取       | 未获取       | 定价页列为「—」（无价格）                                                                               |
| gpt-5-search-api    | 未获取                       | $1.25      | $10.00     | $0.125                   | 免费        | 未获取          | 未获取       | 未获取       | 搜索特化模型（定价页特化表）                                                                            |

### 3.1 长上下文（>272K 输入 token）价格档——仅 1.05M 窗口模型适用

> 官方规则：**prompts with >272K input tokens 按整请求 2x 输入价、1.5x 输出价计费**（5.6/5.5/5.4 系模型页原文），适用于 standard/batch/flex。缓存价同比例（read 2x、write 2x）。400K 窗口模型（5.4-mini/nano、5.3-codex、chat-latest 等）无此档。

| 模型          | 长上下文 input | 长上下文 output | 长上下文 cache_read | 长上下文 cache_write |
| ------------- | -------------- | --------------- | ------------------- | -------------------- |
| gpt-5.6-sol   | $10.00         | $45.00          | $1.00               | $12.50               |
| gpt-5.6-terra | $4.00          | $18.00          | $0.40               | $5.00                |
| gpt-5.6-luna  | $0.40          | $1.80           | $0.04               | $0.50                |
| gpt-5.5       | $10.00         | $45.00          | $1.00               | 免费                 |
| gpt-5.5-pro   | $60.00         | $270.00         | —                   | 免费                 |
| gpt-5.4       | $5.00          | $22.50          | $0.50               | 免费                 |
| gpt-5.4-pro   | $60.00         | $270.00         | —                   | 免费                 |

### 3.2 旧轨补充表（gpt-5.2 及更早 / o 系列，价格来自官方定价页，仅收录有价条目）

> 用户要求 GPT 到 5.4/5.3 即可，此表为完整性补充；上下文窗口来自 models.dev 交叉验证（标来源），未验证者标「未获取」。旧轨全部：缓存写入免费、TTL in_memory/24h（依模型）、最低缓存 1024-2048、支持 Responses（o1-pro/o3-pro 除外，见下）。

| 模型名              | 上下文（models.dev） | input   | output  | cache_read | 备注                                                   |
| ------------------- | -------------------- | ------- | ------- | ---------- | ------------------------------------------------------ |
| gpt-5.2             | 400,000              | $1.75   | $14.00  | $0.175     |                                                        |
| gpt-5.2-pro         | 400,000              | $21.00  | $168.00 | —          | 无缓存折扣                                             |
| gpt-5.2-chat-latest | 128,000              | $1.75   | $14.00  | $0.175     | ChatGPT Instant 快照                                   |
| gpt-5.2-codex       | 400,000              | $1.75   | $14.00  | $0.175     | 官方模型页 quick comparison 确认（非定价表）           |
| gpt-5.1             | 400,000              | $1.25   | $10.00  | $0.125     |                                                        |
| gpt-5.1-codex       | 400,000              | 未获取  | 未获取  | 未获取     | 未上官方定价页                                         |
| gpt-5.1-codex-mini  | 400,000              | 未获取  | 未获取  | 未获取     | 未上官方定价页                                         |
| gpt-5.1-codex-max   | 400,000              | 未获取  | 未获取  | 未获取     | 未上官方定价页；支持 24h extended 保留（缓存文档列出） |
| gpt-5               | 400,000              | $1.25   | $10.00  | $0.125     |                                                        |
| gpt-5-mini          | 未获取               | $0.25   | $2.00   | $0.025     |                                                        |
| gpt-5-nano          | 未获取               | $0.05   | $0.40   | $0.005     |                                                        |
| gpt-5-pro           | 未获取               | $15.00  | $120.00 | —          | 无缓存折扣                                             |
| gpt-5-codex         | 未获取               | 未获取  | 未获取  | 未获取     | 未上官方定价页；支持 24h extended（缓存文档列出）      |
| o1                  | 未获取               | $15.00  | $60.00  | $7.50      | 旧 o 系列 reasoning 模型                               |
| o1-pro              | 未获取               | $150.00 | $600.00 | —          | 无缓存折扣                                             |
| o3                  | 未获取               | $2.00   | $8.00   | $0.50      |                                                        |
| o3-pro              | 未获取               | $20.00  | $80.00  | —          | 无缓存折扣                                             |
| o3-mini             | 未获取               | $1.10   | $4.40   | $0.55      |                                                        |
| o4-mini             | 未获取               | $1.10   | $4.40   | $0.275     |                                                        |
| gpt-4.1             | 未获取               | $2.00   | $8.00   | $0.50      | 缓存价 25%                                             |
| gpt-4.1-mini        | 未获取               | $0.40   | $1.60   | $0.10      |                                                        |
| gpt-4.1-nano        | 未获取               | $0.10   | $0.40   | $0.025     |                                                        |
| gpt-4o              | 未获取               | $2.50   | $10.00  | $1.25      | 缓存价 50%                                             |
| gpt-4o-mini         | 未获取               | $0.15   | $0.60   | $0.075     | 缓存价 50%                                             |

---

## 4. 定价档位（Batch / Flex / Fast，官方定价页确认）

| 档位                                          | 规则                                                                                      | 覆盖模型                                                                                                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Standard**                                  | 默认价（§3 主表）                                                                         | 全部                                                                                                                                                                                |
| **Batch**                                     | 标准价的 **50%**（含 cache_read 与 cache_write；5.6 写费 batch 档为 $3.125/$1.25/$0.125） | 5.6 全系、5.5、5.5-pro、5.4、5.4-mini/nano/pro、5.2 系、5.1、5 系、o1/o3/o4-mini 等；**gpt-5.3-codex / chat-latest / gpt-5.3-chat / codex-mini-latest 无 Batch 档**（模型页端点表） |
| **Flex**                                      | 约等于 Batch 价（异步降优先级处理；官方新增档位）                                         | 5.6 全系、5.5、5.5-pro、5.4 系、5.2、5.1、5、o3、o4-mini                                                                                                                            |
| **Fast mode**（原 Priority，2026-07-30 更名） | 标准价 **2x**（输入/输出/缓存均 2x；5.6 无写价例外）                                      | 5.6 全系（$10/$60、$4/$24、$0.4/$2.4）、5.5、5.4、5.4-mini、5.2、5.1、5、5-mini、4.1 系、4o 系、o3、o4-mini、gpt-5.3-codex（$3.5/$28）                                              |

> 另注：数据驻留（data residency）区域端点对 **2026-03-05 及之后发布**的模型收取 **10% 上浮**（5.6 全系、5.5、5.5-pro、5.4、5.4-mini/nano/pro 均适用）。

---

## 5. 缓存机制说明（Prompt Caching）

### 5.1 两代机制对照（GPT-5.6+ 新轨 vs 5.5 及更早旧轨）

| 维度                        | GPT-5.6 及以后家族（sol/terra/luna）                                                                                                                                          | GPT-5.5 及更早（旧轨）                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 默认行为                    | 自动缓存，隐式断点放在**最新 user/tool 消息**；**不回退找最长匹配前缀**（与旧模型关键差异）                                                                                   | 自动前缀缓存；无断点概念                                                                                                                                                                                 |
| 缓存写入费                  | **1.25x 未缓存输入价**（sol $6.25 / terra $2.50 / luna $0.25）                                                                                                                | **写入免费**                                                                                                                                                                                             |
| TTL 参数                    | `prompt_cache_options.ttl`，**唯一值 `30m`**（最小保留期，官方可能保留更久）；无 `prompt_cache_retention`                                                                     | `prompt_cache_retention`：`in_memory`（5-10 分钟活跃、上限 1 小时）或 `24h`（extended，KV 卸载到 GPU 本地存储）；**gpt-5.5 / gpt-5.5-pro 仅支持 `24h`**；无 ZDR 组织默认 `24h`，ZDR 组织默认 `in_memory` |
| 最低缓存前缀                | **1024 tokens（严格下限）**                                                                                                                                                   | 1024-2048 依模型而定（官方未公布逐模型值）                                                                                                                                                               |
| 显式断点                    | `prompt_cache_breakpoint {"mode":"explicit"}`：Responses 支持 input_text/input_image/input_file；Chat Completions 支持 text/image_url/input_audio/file/refusal                | **不支持**（传入 prompt_cache_options/breakpoint 报 400）                                                                                                                                                |
| 断点上限                    | 每请求最多 **4 个写入断点**（implicit 占 1 个，故显式最多 3 个）；读取考虑最近 **50 个断点**                                                                                  | —                                                                                                                                                                                                        |
| `prompt_cache_options.mode` | `implicit`（默认）/ `explicit`（仅显式断点，避免为变化后缀付写入费）                                                                                                          | 不支持                                                                                                                                                                                                   |
| `prompt_cache_key`          | **必须设置才能用更可靠匹配**（implicit/explicit 均需）；每 key 总流量约 **15 请求/分钟**，超出部分可能 miss；与路由前缀哈希（约前 256 tokens）结合                            | 可选，仅路由优化                                                                                                                                                                                         |
| 计量字段                    | Responses：`usage.input_tokens_details.cached_tokens`（读）+ `cache_write_tokens`（写）；Chat Completions：`usage.prompt_tokens_details.cached_tokens` + `cache_write_tokens` | 同左（无 cache_write_tokens，写免费）                                                                                                                                                                    |
| 路由哈希                    | 初始前缀哈希（通常前 256 tokens，依模型而异）                                                                                                                                 | 同左                                                                                                                                                                                                     |
| 速率限制                    | 缓存 token 计入 TPM 配额                                                                                                                                                      | 同左                                                                                                                                                                                                     |

### 5.2 缓存命中价差（cache_read 占 input 比例，官方价算）

| 模型                                                                | cache_read / input                                  | 模型                                                     | cache_read / input |
| ------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------- | ------------------ |
| gpt-5.6-sol / terra / luna                                          | 10%                                                 | gpt-5.2 系 / 5.3-codex / 5.3-chat / 5.2-chat / 5.2-codex | 10%                |
| gpt-5.5 / gpt-5.4 / 5.4-mini / 5.4-nano / 5.1 / 5 / 5-mini / 5-nano | 10%                                                 | codex-mini-latest                                        | **25%**（异常值）  |
| chat-latest                                                         | 10%                                                 | gpt-4.1 系                                               | 25%                |
| gpt-5.5-cyber / gpt-5-search-api                                    | 10%                                                 | gpt-4o 系                                                | 50%                |
| o1 / o3 / o3-mini / o4-mini                                         | 10%~50%（o1 50%、o3 25%、o3-mini 50%、o4-mini 25%） | —                                                        | —                  |

> pro 档模型（gpt-5.5-pro / gpt-5.4-pro / gpt-5.2-pro / gpt-5-pro / o1-pro / o3-pro）**无缓存输入折扣**（模型页原文「does not offer a cached input discount」），计算时 cache_read 按未缓存输入价（无折扣）。

---

## 6. 特化优化线索（每系列已知特殊处理）

| 模型/系列                     | 特殊处理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPT-5.6 全系                  | ① `reasoning.effort`：`none/low/medium(默认)/high/xhigh/max`（**max 为 5.6 新增档**，旧系无）；② **Pro mode**：`reasoning.mode:"pro"`（同一模型 slug 开启，非独立模型；费用=该模型标准价聚合推理 token，官方明示不要换独立 Pro slug）；③ `text.verbosity`（low/medium/high）控制默认详略；④ **persisted reasoning**：`reasoning.context` 默认 `all_turns`（旧模型默认 current_turn），配合 `previous_response_id` 可跨轮复用推理并提升缓存效率；⑤ 新「leaner prompt」建议：减 prompt 可降 33-67% 成本（官方内部评测口径，方向性参考）；⑥ 默认输出比 5.5 更简洁 |
| GPT-5.5                       | `reasoning.effort`：none/low/medium(默认)/high/xhigh；仅 `24h` 保留档                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| GPT-5.5-pro / 5.4-pro         | 无缓存折扣；`reasoning.effort`：medium/high(默认)/xhigh（5.5-pro 默认 high，5.4-pro 默认 medium）；仅 Responses API；建议 background mode 防超时                                                                                                                                                                                                                                                                                                                                                                                                               |
| GPT-5.4 / 5.4-mini / 5.4-nano | `reasoning.effort`：none(默认)/low/medium/high/xhigh                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| GPT-5.3-codex                 | 编码专用；`reasoning.effort`：low/medium/high/xhigh；仅 Responses；无 Batch；官方专用提示指南（cookbook codex_prompting_guide）；Fast mode 档存在                                                                                                                                                                                                                                                                                                                                                                                                              |
| codex-mini-latest             | o4-mini 微调（Codex CLI 用）；缓存价 25% 异常档                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| gpt-5.6 系 / 5.5 / 5.4        | 长上下文（>272K 输入）整请求 2x 输入 / 1.5x 输出，**缓存价同比例放大**——长上下文场景缓存收益占比不变，但绝对价差扩大                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5.6 新轨缓存                  | 断点语义是成本管控关键：隐式断点不回溯找最长前缀，动态后缀会导致 `cached_tokens=0` 且反复写入付费；`mode:"explicit"` + `prompt_cache_key` 是官方推荐解法                                                                                                                                                                                                                                                                                                                                                                                                       |

---

## 7. 交叉验证（models.dev / OpenRouter）与差异记录

### 7.1 上下文窗口交叉验证（models.dev 与官方模型页一致）

| 模型                                                                                     | 官方                                                | models.dev            | 一致                      |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------- | ------------------------- |
| gpt-5.6-sol / terra / luna                                                               | 1,050,000（max input 922,000 / max output 128,000） | 1,050,000 / 128,000   | ✔                         |
| gpt-5.5 / gpt-5.5-pro                                                                    | 1,050,000                                           | 1,050,000 / 128,000   | ✔                         |
| gpt-5.4 / gpt-5.4-pro                                                                    | 1,050,000                                           | 1,050,000 / 128,000   | ✔                         |
| gpt-5.4-mini / nano                                                                      | 400,000（max input 272,000）                        | 400,000 / 128,000     | ✔                         |
| gpt-5.3-codex                                                                            | 400,000                                             | 400,000 / 128,000     | ✔                         |
| gpt-5.2 / 5.2-codex / 5.2-pro / 5.1 / 5.1-codex / 5.1-codex-mini / 5.1-codex-max / gpt-5 | —                                                   | 400,000 / 128,000     | 补充值（models.dev 口径） |
| gpt-5.3-chat-latest                                                                      | 128,000（页面「max input 272,000」并存）            | 128,000 / 16,384 输出 | 官方页面数据疑似复制错误  |
| chat-latest                                                                              | 400,000                                             | —                     | —                         |

### 7.2 价格交叉验证（OpenRouter API 与官方定价页逐项一致）

| 模型          | input | output | cache_read | cache_write | 长上下文 override（≥272K） | 一致 |
| ------------- | ----- | ------ | ---------- | ----------- | -------------------------- | ---- |
| gpt-5.6-sol   | $5.00 | $30.00 | $0.50      | $6.25       | $10/$45/$1/$12.5           | ✔    |
| gpt-5.6-terra | $2.00 | $12.00 | $0.20      | $2.50       | $4/$18/$0.4/$5             | ✔    |
| gpt-5.6-luna  | $0.20 | $1.20  | $0.02      | $0.25       | $0.4/$1.8/$0.04/$0.5       | ✔    |
| gpt-5.5       | $5.00 | $30.00 | $0.50      | 无写费字段  | $10/$45/$1                 | ✔    |
| gpt-5.4       | $2.50 | $15.00 | $0.25      | 无写费字段  | $5/$22.5/$0.5              | ✔    |

> OpenRouter 对 5.6 系额外暴露 `gpt-5.6-sol-pro / terra-pro / luna-pro` 三个 slug（官方 `reasoning.mode:"pro"` 的网关封装，同一底层模型）及 `gpt-5.4-image-2`；这些**不是官方独立模型 ID**，catalog 落地时不应收录为独立条目。models.dev 上另有 `gpt-5.5-instant`（400K/$5-$30，2026-05-05 发布，仅 models.dev 收录），官方目录/定价页无此名——现役 Instant 模型官方名是 `chat-latest`。

### 7.3 用户提出名词的核实结论（重要，防误收录）

| 用户提出                                | 核实结果                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPT-5.6 多个系列（codex/chat/pro 变体） | **部分成立**：官方系列为 sol/terra/luna 三档 + alias `gpt-5.6`；**没有** `gpt-5.6-codex`、`gpt-5.6-chat`、`gpt-5.6-pro` 官方 ID。codex 专精模型停在 5.3 代（gpt-5.3-codex）；chat 专精模型（Instant）停在 5.3 代且已弃用（gpt-5.3-chat-latest），现役 Instant 为 `chat-latest`；pro 档是 `reasoning.mode:"pro"` 请求参数，非模型 ID                                     |
| composer 2.5                            | **不是 OpenAI 模型**。官方文档、models.dev、OpenRouter 均无。网页查证：Cursor（Anysphere）2026-05-19 发布，基于 Moonshot Kimi K2.5 开源权重训练，公开价 $0.50/$2.50（Standard，cursor.com/changelog），另有 Fast 档 $3.00/$15.00；SWE-Bench Multilingual 79.8% 对标 Opus 4.7/GPT-5.5。**如需收录应归入独立厂商（Cursor），且其价格/API 未在本轮专项范围，建议另行调研** |
| codex 系（codex-1/2/3）                 | **命名不成立**。官方命名 `gpt-5-codex` → `gpt-5.1-codex(+mini/max)` → `gpt-5.2-codex` → `gpt-5.3-codex` → `codex-mini-latest`，无「codex-N」数字系列                                                                                                                                                                                                                    |

---

## 8. 未获取 / 未核实项（诚实边界清单）

1. **composer 2.5**：确认非 OpenAI 模型（§7.3），其官方价格/上下文/缓存行为未在本轮核实（来源 22 搜索结果口径：Standard $0.50/$2.50、Fast $3.00/$15.00，未经 Cursor 官方文档二次验证）。
2. **gpt-5.4-cyber 价格**：官方定价页列为「—」，未公布。
3. **pro 档模型缓存语义**：官方仅声明「no cached input discount」，pro 模型是否仍可读缓存（以无折扣价计费）或完全不可缓存，**未在官方文档中明确**。
4. **旧轨逐模型最低缓存前缀精确值**：官方只给「1024-2048 依模型而定」范围，未公布逐模型数值。
5. **5.4-mini / 5.4-nano / 5.3-codex / 5.3-chat / chat-latest / codex-mini-latest 的 24h extended 支持**：官方 24h 模型名单（见 §5.1 附注）未含 5.4-mini/nano 与 chat-latest 系，但其 TTL 档位写在主表中为「in_memory/24h」系推断——**5.4-mini/nano 与 chat-latest 的 24h 支持未官方证实**，标注存疑。
6. **gpt-5.5-pro 无 Batch 支持**：来源 2 定价页 Batch 表含 gpt-5.5-pro 行（$15/$90），与模型页端点表「Batch 不支持」冲突；**以模型页为准标注不确定**，落地前建议实测。
7. **gpt-5.1-codex / mini / max、gpt-5-codex、gpt-5.1-chat-latest 价格**：未上官方定价页（可能仅通过 Codex 产品提供），未获取。
8. **gpt-5.6 系 Chat Completions 支持**：模型页确认「Supported」（与 5.3-codex/pro 系不同），但官方文档多处建议 Responses API——两者端点均支持，已确认。
9. **gpt-5.5-instant**：仅 models.dev 收录（§7.2），官方目录无此名，未核实其是否为官方旧快照或第三方通道名。
10. **o 系列 / gpt-4.x 旧模型上下文窗口**：未逐页抓取（超出任务范围），表中标「未获取」。

---

## 9. 对 catalog 落地的直接建议（供 R2/R3 参考）

1. OpenAI 条目建议按「官方 ID」收录：`gpt-5.6-sol/terra/luna` 三条（alias `gpt-5.6` 作为别名字段而非独立条目），`gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini/nano`、`gpt-5.3-codex`、`chat-latest`、`codex-mini-latest` 为现行有价可选收录；pro 档与 `-pro` 网关 slug 不单独收录（用 `reasoning.mode` 表达）。
2. 四指标价格按标准档录入 + `long_context_threshold: 272000` 与 override 数组（OpenRouter pricing.overrides 结构可直接参考）。
3. 缓存字段：`cache_write_price`（5.6 三档实价；旧轨 0 + `cache_write_free: true`）、`cache_ttl: {default:"30m", options:["30m"]}`（5.6+）或 `{in_memory, "24h"}`（旧轨）、`prompt_cache_min_tokens: 1024`（5.6+ 严格；旧轨标 1024-2048 范围未定值）。
4. 注意 codex-mini-latest 的 cache_read 为 input 的 25%（非 10%），异常条目需保留原始比值防误算。
