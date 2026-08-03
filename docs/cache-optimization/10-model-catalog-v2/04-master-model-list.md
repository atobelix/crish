# 模型目录 v2 权威全量表（R2 汇总）

> 专项：「模型目录与定价 v2」　|　轮次：**R2 汇总（本文件）**　|　汇总日期：2026-08-03
> 用途：**R3 转录 catalog.json（schema 2.0）的唯一数据源**。R3 不得越过本表直接从 R1 各厂商文档取数。
> 输入（R1 全部成果，均在本目录下）：`01-openai.md` / `01-anthropic.md` / `01-kimi.md` / `01-glm.md` / `01-qwen.md` / `01-grok.md` / `01-minimax.md` / `01-gemini.md` / `01-deepseek.md` / `01-composer.md` / `01-doubao.md` / `01-ernie.md`；字段契约：`03-catalog-v2-schema.md`（59 字段权威定义）。
> 数据日期：全部条目 `dataVerifiedAt = 2026-08-03`（R1 复核日）。
> 性质：只读文档，未修改任何代码。

---

## 目录

- [0. 收录标准与总则](#0-收录标准与总则)
- [1. OpenAI（御十家 1/10）](#1-openai御十家-110)
- [2. Anthropic（御十家 2/10）](#2-anthropic御十家-210)
- [3. Kimi 月之暗面（御十家 3/10）](#3-kimi-月之暗面御十家-310)
- [4. GLM 智谱（御十家 4/10，双币种）](#4-glm-智谱御十家-410双币种)
- [5. Qwen 阿里百炼（御十家 5/10）](#5-qwen-阿里百炼御十家-510)
- [6. Grok xAI（御十家 6/10）](#6-grok-xai御十家-610)
- [7. MiniMax（御十家 7/10，双币种）](#7-minimax御十家-710双币种)
- [8. Gemini Google（御十家 8/10）](#8-gemini-google御十家-810)
- [9. DeepSeek（御十家 9/10）](#9-deepseek御十家-910)
- [10. Composer Cursor（御十家 10/10，不可直连）](#10-composer-cursor御十家-1010不可直连)
- [11. 次要厂商存档（豆包 / ERNIE，仅存档不转录）](#11-次要厂商存档豆包--ernie仅存档不转录)
- [12. 完整性检查表（每厂商统计与缺项清单）](#12-完整性检查表每厂商统计与缺项清单)
- [13. 转录优先级建议](#13-转录优先级建议)

---

## 0. 收录标准与总则

### 0.1 收录判定三原则

1. **现役在售优先**：官方当前定价页/模型页在售且有价格的模型 → 转录（P0/P1 按 §13 分级）。
2. **已下线不转录**：官方明确下线/退役/弃用的模型一律不转录，仅在本表标注（供迁移参考）。已确认下线清单见 §13.4。
3. **只列对话模型**：TTS / Embedding / 3D / 视频 / 图像 / 音乐生成等非对话模型不列（Gemini embedding/lyria/tts、豆包 seedance/seedream/seed3d、xAI imagine/voice 等均排除）。

### 0.2 币种与双币种规则

- 每个价格必标 `currency`（USD / CNY），目录内**不做汇率换算**（schema §1.2）。
- 混币种厂商（GLM、MiniMax）**同一模型双币种 = 双条目**，provider 区分：GLM 国际站 `zai`（USD）/ 国内站 `bigmodel`（CNY）；MiniMax 国内站 `minimaxi`（CNY）/ 国际站 `minimax-io`（USD）。
- 转售通道价（豆包方舟/千帆转售 GLM、DeepSeek 等）不属于御十家官方直连口径，一律不并入官方条目，见 §11。

### 0.3 priceStatus 语义（schema §1.3 / §3.2）

| 值            | 含义                         | 表达                                              |
| ------------- | ---------------------------- | ------------------------------------------------- |
| `official`    | 官方公布绝对值               | 四价直填（写免费 = 0 + `cacheWriteFree: true`）   |
| `derived`     | 官方只给比例、绝对价为推导值 | 四价按比例计算 + `derivation` 对象（Qwen 全系 ※） |
| `unavailable` | 官方未公布/未获取            | 四价 `null` + `notes` 说明，**禁止 0 占位**       |

### 0.4 表结构说明

每厂商两到三张表，覆盖 schema 要求的全部字段：

- **表 A 四指标价格总表**：`model`（官方名）/ `apiModel`（异形时）/ `provider` / `vendor` / `currency` / `contextWindow` / `maxOutputTokens` / `inputPrice` / `outputPrice` / `cacheReadPrice` / `cacheWritePrice` / `cacheWritePrice5m` / `cacheWritePrice1h` / `priceStatus`。
- **表 B 缓存语义与能力**：`model` / `promptCacheMinTokens` / `cacheTtl`（+`cacheTtlOptions`）/ `storagePricePer1mHour` / `supports` 位摘要 / `tieredPricing` 摘要 / `sourceUrl` / `dataVerifiedAt` / 备注（含收录判定）。
- 表 C（仅部分厂商）：旧轨/特化补充表。

`supports` 位摘要图例：**R**=supportsResponses，**CC**=supportsCacheControl（Anthropic 式断点），**PK**=supportsPromptCacheKey，**IM**=supportsImplicitCaching，**V**=supportsVision，**RE**=supportsReasoning(+Effort)，**FC**=supportsFunctionCalling，**WS**=supportsWebSearch，**A**=supportsAudioInput。✔=支持，✘=不支持，—=未明确/未公布（保守按 false）。

### 0.5 全局统计速览（御十家）

- **条目总数：183 条**（含双币种条目与旧轨/特化备查行；已下线行仅标注、不计入转录）
- **四指标完整：145 条**（input/output/cacheRead/cacheWrite 齐全；写免费 = 0+true 视为完整；Qwen 推导价计完整）
- 币种：纯 USD 厂商 7 家（OpenAI/Anthropic/Grok/Gemini/DeepSeek/Composer + GLM 国际站），纯 CNY 厂商 2 家（Kimi/Qwen），双币种 2 家（GLM/MiniMax）
- 详细统计与缺项清单见 §12。

---

## 1. OpenAI（御十家 1/10）

> 概况：**40 个模型实体**（16 现行/特化 + 24 旧轨），另有 alias `gpt-5.6`（非独立模型，路由到 sol）；**四指标完整 29 条**；币种 USD。
> 数据日期 2026-08-03。价格来源官方定价页标准档；上下文/端点来自官方模型页；旧轨上下文为 models.dev 交叉验证口径。
> 核心结论：GPT-5.6 是「系列名」而非单模型，官方 ID 为 `gpt-5.6-sol/terra/luna`（alias `gpt-5.6` 路由到 sol）；5.6+ 写费 1.25x、TTL 仅 30m、最低缓存 1024 严格；5.5 及更早写免费、TTL in_memory/24h；pro 档无缓存折扣；不存在 `gpt-5.6-codex/pro/chat` 官方 ID（pro 档是 `reasoning.mode:"pro"` 请求参数）。
> 来源 URL：定价页 https://developers.openai.com/api/docs/pricing.md ｜ 模型目录 https://developers.openai.com/api/docs/models.md ｜ 缓存指南 https://developers.openai.com/api/docs/guides/prompt-caching.md

### 1.1 表 A：现行主表四指标价格（12 条 P0 转录 + 2 条特化 P1 备查 + 1 条价格未公布）

| model（官方 ID）  | provider/vendor | currency | contextWindow | maxOutputTokens | inputPrice | outputPrice | cacheReadPrice       | cacheWritePrice | cacheWrite5m/1h | priceStatus |
| ----------------- | --------------- | -------- | ------------- | --------------- | ---------- | ----------- | -------------------- | --------------- | --------------- | ----------- |
| gpt-5.6-sol       | openai/openai   | USD      | 1,050,000     | 128,000         | 5.00       | 30.00       | 0.50                 | 6.25            | —               | official    |
| gpt-5.6-terra     | openai/openai   | USD      | 1,050,000     | 128,000         | 2.00       | 12.00       | 0.20                 | 2.50            | —               | official    |
| gpt-5.6-luna      | openai/openai   | USD      | 1,050,000     | 128,000         | 0.20       | 1.20        | 0.02                 | 0.25            | —               | official    |
| gpt-5.5           | openai/openai   | USD      | 1,050,000     | 128,000         | 5.00       | 30.00       | 0.50                 | 0（写免费）     | —               | official    |
| gpt-5.5-pro       | openai/openai   | USD      | 1,050,000     | 128,000         | 30.00      | 180.00      | 无缓存折扣（未明确） | 0（写免费）     | —               | official    |
| gpt-5.4           | openai/openai   | USD      | 1,050,000     | 128,000         | 2.50       | 15.00       | 0.25                 | 0（写免费）     | —               | official    |
| gpt-5.4-mini      | openai/openai   | USD      | 400,000       | 128,000         | 0.75       | 4.50        | 0.075                | 0（写免费）     | —               | official    |
| gpt-5.4-nano      | openai/openai   | USD      | 400,000       | 128,000         | 0.20       | 1.25        | 0.02                 | 0（写免费）     | —               | official    |
| gpt-5.4-pro       | openai/openai   | USD      | 1,050,000     | 128,000         | 30.00      | 180.00      | 无缓存折扣（未明确） | 0（写免费）     | —               | official    |
| gpt-5.3-codex     | openai/openai   | USD      | 400,000       | 128,000         | 1.75       | 14.00       | 0.175                | 0（写免费）     | —               | official    |
| chat-latest       | openai/openai   | USD      | 400,000       | 未获取          | 5.00       | 30.00       | 0.50                 | 0（写免费）     | —               | official    |
| codex-mini-latest | openai/openai   | USD      | 200,000       | 100,000         | 1.50       | 6.00        | 0.375（25% 异常档）  | 0（写免费）     | —               | official    |
| gpt-5.5-cyber     | openai/openai   | USD      | 未获取        | 未获取          | 12.50      | 75.00       | 1.25                 | 0（写免费）     | —               | official    |
| gpt-5-search-api  | openai/openai   | USD      | 未获取        | 未获取          | 1.25       | 10.00       | 0.125                | 0（写免费）     | —               | official    |
| gpt-5.4-cyber     | openai/openai   | USD      | 未获取        | 未获取          | **未公布** | **未公布**  | **未公布**           | —               | —               | unavailable |

> 备注：① `gpt-5.6` 为 alias（路由到 gpt-5.6-sol），不建独立条目，作别名记录。② `gpt-5.3-chat-latest`（128K / maxOutput 16,384 / $1.75-$14-$0.175）**已弃用**，不转录（见 §1.4）。③ chat-latest 的 maxOutputTokens 官方未给（models.dev 口径未核实）；codex-mini-latest = 100,000（官方模型页）；5.6 系 max input 922,000 / max output 128,000。④ 5.5-pro / 5.4-pro 仅支持 Responses API、无 Batch；5.3-codex 仅 Responses。⑤ 数据驻留区域端点对 2026-03-05 后发布模型收取 10% 上浮（5.6 全系/5.5/5.5-pro/5.4 系适用）。

### 1.2 表 B：缓存语义与能力（现行主表）

| model             | promptCacheMinTokens      | cacheTtl（cacheTtlOptions）               | storagePricePer1mHour | supports 摘要                                                                                                    | tieredPricing 摘要                                                                                                 | sourceUrl  | dataVerifiedAt | 备注/收录判定                                                  |
| ----------------- | ------------------------- | ----------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------- | -------------- | -------------------------------------------------------------- |
| gpt-5.6-sol       | 1024（严格下限）          | 30m（[30m]）                              | —（无存储费）         | R✔ CC✘（非 Anthropic 式；自有 prompt_cache_breakpoint 显式断点，上限 4 写/50 读） PK✔ IM✔ RE✔（effort none~max） | >272K 档：minTokens 272000、maxTokens null，input 10.00 / output 45.00 / read 1.00 / write 12.50（整请求 2x/1.5x） | pricing.md | 2026-08-03     | P0 转录                                                        |
| gpt-5.6-terra     | 1024（严格）              | 30m（[30m]）                              | —                     | 同 sol                                                                                                           | >272K：4.00 / 18.00 / 0.40 / 5.00                                                                                  | pricing.md | 2026-08-03     | P0 转录                                                        |
| gpt-5.6-luna      | 1024（严格）              | 30m（[30m]）                              | —                     | 同 sol                                                                                                           | >272K：0.40 / 1.80 / 0.04 / 0.50                                                                                   | pricing.md | 2026-08-03     | P0 转录                                                        |
| gpt-5.5           | 1024-2048（未逐模型公布） | 24h（仅此档）                             | —                     | R✔ CC✘ PK✔（可选，路由优化） IM✔ RE✔（none~xhigh）                                                               | >272K：10.00 / 45.00 / 1.00（写免费）                                                                              | pricing.md | 2026-08-03     | P0 转录；快照 gpt-5.5-2026-04-23                               |
| gpt-5.5-pro       | 1024-2048                 | 24h（仅此档）                             | —                     | R✔（仅 Responses） CC✘ PK— IM— RE✔（medium/high 默认/xhigh）                                                     | >272K：60.00 / 270.00（read 无折扣）                                                                               | pricing.md | 2026-08-03     | P0 转录；无缓存折扣；Batch 支持冲突存疑（见缺项）              |
| gpt-5.4           | 1024-2048                 | in_memory/24h（≈5m/24h）                  | —                     | R✔ CC✘ PK✔ IM✔ RE✔（none 默认~xhigh）                                                                            | >272K：5.00 / 22.50 / 0.50                                                                                         | pricing.md | 2026-08-03     | P0 转录；快照 gpt-5.4-2026-03-05                               |
| gpt-5.4-mini      | 1024-2048                 | in_memory/24h（24h 支持未官方证实，存疑） | —                     | R✔ CC✘ PK✔ IM✔ RE✔                                                                                               | 无长上下文档（400K 窗口）                                                                                          | pricing.md | 2026-08-03     | P0 转录                                                        |
| gpt-5.4-nano      | 1024-2048                 | in_memory/24h（存疑同 mini）              | —                     | R✔ CC✘ PK✔ IM✔ RE✔                                                                                               | 无长上下文档                                                                                                       | pricing.md | 2026-08-03     | P0 转录                                                        |
| gpt-5.4-pro       | 1024-2048                 | in_memory/24h                             | —                     | R✔（仅 Responses） CC✘ PK— IM— RE✔                                                                               | >272K：60.00 / 270.00                                                                                              | pricing.md | 2026-08-03     | P0 转录；无缓存折扣；无 Batch                                  |
| gpt-5.3-codex     | 1024-2048                 | in_memory/24h                             | —                     | R✔（仅 Responses） CC✘ PK✔ IM✔ RE✔ FC✔（编码专用）                                                               | 无长上下文档                                                                                                       | pricing.md | 2026-08-03     | P0 转录；无 Batch；Fast mode 档 2x 存在                        |
| chat-latest       | 1024-2048                 | in_memory/24h（存疑同 mini）              | —                     | R✔ CC✘ PK✔ IM✔ RE—                                                                                               | 无长上下文档                                                                                                       | pricing.md | 2026-08-03     | P0 转录；ChatGPT Instant 现役；无 Batch                        |
| codex-mini-latest | 1024-2048                 | in_memory/24h                             | —                     | R✔（仅 Responses） CC✘ PK— IM— RE— FC✔                                                                           | 无长上下文档                                                                                                       | pricing.md | 2026-08-03     | P0 转录；**cache_read = input 25% 异常档**，保留原始比值防误算 |
| gpt-5.5-cyber     | 未获取                    | 未获取                                    | —                     | R— CC— PK— IM—                                                                                                   | —                                                                                                                  | pricing.md | 2026-08-03     | P1 备查；网络安全特化                                          |
| gpt-5-search-api  | 未获取                    | 未获取                                    | —                     | R— CC— PK— IM— WS✔                                                                                               | —                                                                                                                  | pricing.md | 2026-08-03     | P1 备查；搜索特化                                              |
| gpt-5.4-cyber     | 未获取                    | 未获取                                    | —                     | —                                                                                                                | —                                                                                                                  | pricing.md | 2026-08-03     | 价格未公布（unavailable），不转录                              |

> 缓存机制要点：5.6+ 新轨 = 自动缓存、隐式断点放最新 user/tool 消息、不回退找最长前缀、`prompt_cache_options.ttl` 唯一值 30m（最小保留期）、断点上限每请求 4 个写入/读取考虑最近 50 个、`prompt_cache_key` 必须设置才能用更可靠匹配（每 key 约 15 请求/分钟）。旧轨 = 自动前缀缓存、写免费、`prompt_cache_retention`（in_memory 5-10 分钟活跃/上限 1 小时，或 24h extended）。5.6+ 长上下文（>272K 输入）按整请求 2x 输入/1.5x 输出，缓存价同比例。

### 1.3 表 C：旧轨补充表（24 条，P1 备查；用户口径「GPT 到 5.4/5.3 即可」，此表为完整性补充）

> 旧轨共同语义：缓存写入免费、TTL in_memory/24h、最低缓存 1024-2048、支持 Responses（o1-pro/o3-pro 除外，仅 Chat Completions）。上下文为 models.dev 交叉验证口径（400K / 128K 输出）；未验证者标「未获取」。

| model               | contextWindow | maxOutputTokens | inputPrice | outputPrice | cacheReadPrice | cacheWritePrice | priceStatus | 备注                              |
| ------------------- | ------------- | --------------- | ---------- | ----------- | -------------- | --------------- | ----------- | --------------------------------- |
| gpt-5.2             | 400,000       | 128,000         | 1.75       | 14.00       | 0.175          | 0（写免费）     | official    |                                   |
| gpt-5.2-pro         | 400,000       | 128,000         | 21.00      | 168.00      | 无缓存折扣     | 0（写免费）     | official    | pro 档 read 语义未明确            |
| gpt-5.2-chat-latest | 128,000       | 16,384          | 1.75       | 14.00       | 0.175          | 0（写免费）     | official    | ChatGPT Instant 快照              |
| gpt-5.2-codex       | 400,000       | 128,000         | 1.75       | 14.00       | 0.175          | 0（写免费）     | official    | 官方模型页确认（非定价表）        |
| gpt-5.1             | 400,000       | 128,000         | 1.25       | 10.00       | 0.125          | 0（写免费）     | official    |                                   |
| gpt-5.1-codex       | 400,000       | 128,000         | 未获取     | 未获取      | 未获取         | —               | unavailable | 未上官方定价页                    |
| gpt-5.1-codex-mini  | 400,000       | 128,000         | 未获取     | 未获取      | 未获取         | —               | unavailable | 未上官方定价页                    |
| gpt-5.1-codex-max   | 400,000       | 128,000         | 未获取     | 未获取      | 未获取         | —               | unavailable | 支持 24h extended（缓存文档列出） |
| gpt-5               | 400,000       | 128,000         | 1.25       | 10.00       | 0.125          | 0（写免费）     | official    |                                   |
| gpt-5-mini          | 未获取        | 未获取          | 0.25       | 2.00        | 0.025          | 0（写免费）     | official    |                                   |
| gpt-5-nano          | 未获取        | 未获取          | 0.05       | 0.40        | 0.005          | 0（写免费）     | official    |                                   |
| gpt-5-pro           | 未获取        | 未获取          | 15.00      | 120.00      | 无缓存折扣     | 0（写免费）     | official    |                                   |
| gpt-5-codex         | 未获取        | 未获取          | 未获取     | 未获取      | 未获取         | —               | unavailable | 支持 24h extended                 |
| o1                  | 未获取        | 未获取          | 15.00      | 60.00       | 7.50（50%）    | 0（写免费）     | official    | 旧 o 系 reasoning                 |
| o1-pro              | 未获取        | 未获取          | 150.00     | 600.00      | 无缓存折扣     | 0（写免费）     | official    | 仅 Chat Completions               |
| o3                  | 未获取        | 未获取          | 2.00       | 8.00        | 0.50（25%）    | 0（写免费）     | official    |                                   |
| o3-pro              | 未获取        | 未获取          | 20.00      | 80.00       | 无缓存折扣     | 0（写免费）     | official    | 仅 Chat Completions               |
| o3-mini             | 未获取        | 未获取          | 1.10       | 4.40        | 0.55（50%）    | 0（写免费）     | official    |                                   |
| o4-mini             | 未获取        | 未获取          | 1.10       | 4.40        | 0.275（25%）   | 0（写免费）     | official    |                                   |
| gpt-4.1             | 未获取        | 未获取          | 2.00       | 8.00        | 0.50（25%）    | 0（写免费）     | official    |                                   |
| gpt-4.1-mini        | 未获取        | 未获取          | 0.40       | 1.60        | 0.10           | 0（写免费）     | official    |                                   |
| gpt-4.1-nano        | 未获取        | 未获取          | 0.10       | 0.40        | 0.025          | 0（写免费）     | official    |                                   |
| gpt-4o              | 未获取        | 未获取          | 2.50       | 10.00       | 1.25（50%）    | 0（写免费）     | official    |                                   |
| gpt-4o-mini         | 未获取        | 未获取          | 0.15       | 0.60        | 0.075（50%）   | 0（写免费）     | official    |                                   |

### 1.4 缺项清单（诚实边界，不编造）

1. **gpt-5.4-cyber 价格**：官方定价页列为「—」，未公布（unavailable）。
2. **pro 档缓存语义**：官方仅声明「no cached input discount」，pro 模型能否读缓存（按全价）或完全不可缓存**未明确**。
3. **旧轨逐模型最低缓存前缀精确值**：官方只给「1024-2048 依模型而定」，未公布逐模型数值。
4. **5.4-mini / 5.4-nano / chat-latest 的 24h extended 支持**：官方 24h 名单未含，主表按「in_memory/24h」标注系推断，**存疑**。
5. **gpt-5.5-pro Batch 支持冲突**：定价页 Batch 表有价（$15/$90）与模型页端点「Batch 不支持」冲突，以模型页为准存疑，落地前建议实测。
6. **gpt-5.1-codex / mini / max、gpt-5-codex 价格**：未上官方定价页（可能仅 Codex 产品内提供），unavailable。
7. **gpt-5.5-instant**：仅 models.dev 收录，官方目录无此名，未核实。
8. **o 系 / gpt-4.x 旧模型上下文窗口**：未逐页抓取，标未获取。
9. **gpt-5.3-chat-latest**：**已弃用**，不转录；其模型页「max input 272,000」疑似复制错误（官方口径 128K）。

### 1.5 转录建议

- P0 转录 12 条现行（表 A 前 12 行）；pro 档不单独转录（用 `reasoning.mode:"pro"` 表达，**禁止收录 OpenRouter `-pro` 网关 slug**）。
- P1 备查：gpt-5.5-cyber / gpt-5-search-api（特化）；表 C 旧轨 24 条按需。
- 不转录：gpt-5.3-chat-latest（弃用）、gpt-5.4-cyber（未公布）、gpt-5.1-codex×3 / gpt-5-codex（unavailable）。
- 缓存字段：5.6+ `cacheTtl:"30m"`（v2 值域第四档，R3 需扩 CacheTtl 枚举）；旧轨写免费 = `cacheWritePrice: 0` + `cacheWriteFree: true`；`promptCacheMinTokens: 1024`（5.6+ 严格；旧轨标 1024-2048 范围未定值）。

---

## 2. Anthropic（御十家 2/10）

> 概况：**17 条**（16 行四指标完整 + Mythos Preview 价格未获取）；币种 USD。
> 数据日期 2026-08-03。来源：官方模型总览 https://docs.anthropic.com/en/docs/about-claude/models/overview ｜ 定价页 https://docs.anthropic.com/en/docs/about-claude/pricing ｜ 缓存文档 https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
> 核心结论：写价双档（5m = 1.25x / 1h = 2x 基础输入价）、命中 0.1x、断点上限 4、回溯 20 块、最低缓存四档（512/1024/2048/4096）；**长上下文无溢价**（1M 全窗口标准价）；Sonnet 5 促销价 2026-08-31 到期、9/1 涨标准价；Opus 4.1 于 2026-08-05 退役；Fable 5 / Mythos 5 同规格同价仅一档。

### 2.1 表 A：四指标价格总表（USD / 1M tokens）

| model（官方 ID）                 | provider/vendor     | currency | contextWindow | maxOutputTokens | inputPrice | outputPrice | cacheReadPrice | cacheWritePrice（通用） | cacheWritePrice5m | cacheWritePrice1h | priceStatus                                                     |
| -------------------------------- | ------------------- | -------- | ------------- | --------------- | ---------- | ----------- | -------------- | ----------------------- | ----------------- | ----------------- | --------------------------------------------------------------- |
| claude-fable-5                   | anthropic/anthropic | USD      | 1,000,000     | 128,000         | 10.00      | 50.00       | 1.00           | —                       | 12.50             | 20.00             | official                                                        |
| claude-mythos-5                  | anthropic/anthropic | USD      | 1,000,000     | 128,000         | 10.00      | 50.00       | 1.00           | —                       | 12.50             | 20.00             | official                                                        |
| claude-mythos-preview            | anthropic/anthropic | USD      | 未获取        | 未获取          | 未获取     | 未获取      | 未获取         | —                       | 未获取            | 未获取            | unavailable                                                     |
| claude-opus-5                    | anthropic/anthropic | USD      | 1,000,000     | 128,000         | 5.00       | 25.00       | 0.50           | —                       | 6.25              | 10.00             | official                                                        |
| claude-opus-4-8                  | anthropic/anthropic | USD      | 1,000,000     | 128,000         | 5.00       | 25.00       | 0.50           | —                       | 6.25              | 10.00             | official                                                        |
| claude-opus-4-7                  | anthropic/anthropic | USD      | 1,000,000     | 128,000         | 5.00       | 25.00       | 0.50           | —                       | 6.25              | 10.00             | official                                                        |
| claude-opus-4-6                  | anthropic/anthropic | USD      | 1,000,000     | 128,000         | 5.00       | 25.00       | 0.50           | —                       | 6.25              | 10.00             | official                                                        |
| claude-opus-4-5                  | anthropic/anthropic | USD      | 200,000       | 64,000          | 5.00       | 25.00       | 0.50           | —                       | 6.25              | 10.00             | official                                                        |
| claude-opus-4-1                  | anthropic/anthropic | USD      | 200,000       | 32,000          | 15.00      | 75.00       | 1.50           | —                       | 18.75             | 30.00             | official（retired 2026-08-05）                                  |
| claude-opus-4-0                  | anthropic/anthropic | USD      | 未获取        | 未获取          | 15.00      | 75.00       | 1.50           | —                       | 18.75             | 30.00             | official（retired）                                             |
| claude-sonnet-5（促销，8/31 前） | anthropic/anthropic | USD      | 1,000,000     | 128,000         | 2.00       | 10.00       | 0.20           | —                       | 2.50              | 4.00              | official（promoExpiresAt 2026-08-31）                           |
| claude-sonnet-5（标准，9/1 起）  | anthropic/anthropic | USD      | 1,000,000     | 128,000         | 3.00       | 15.00       | 0.30           | —                       | 3.75              | 6.00              | official（promoReplacesAt 2026-09-01；价行不收录，P5 日期切换） |
| claude-sonnet-4-6                | anthropic/anthropic | USD      | 1,000,000     | 128,000         | 3.00       | 15.00       | 0.30           | —                       | 3.75              | 6.00              | official                                                        |
| claude-sonnet-4-5                | anthropic/anthropic | USD      | 200,000       | 64,000          | 3.00       | 15.00       | 0.30           | —                       | 3.75              | 6.00              | official                                                        |
| claude-sonnet-4-0                | anthropic/anthropic | USD      | 未获取        | 未获取          | 3.00       | 15.00       | 0.30           | —                       | 3.75              | 6.00              | official（retired）                                             |
| claude-haiku-4-5                 | anthropic/anthropic | USD      | 200,000       | 64,000          | 1.00       | 5.00        | 0.10           | —                       | 1.25              | 2.00              | official                                                        |
| claude-3-5-haiku-20241022        | anthropic/anthropic | USD      | 未获取        | 未获取          | 0.80       | 4.00        | 0.08           | —                       | 1.00              | 1.60              | official（retired）                                             |

> 备注：Anthropic 条目写价走 `cacheWritePrice5m` + `cacheWritePrice1h` 双档（通用 `cacheWritePrice` 不适用，置空）；`cacheWriteFree: false`（有写价）。乘数：5m 写 1.25x、1h 写 2x、命中 0.1x；与 Batch 50%、data residency 1.1x（4.6+ 模型 `inference_geo:"us"`）、fast mode 2x 叠加。API ID：4.6 代起为无日期 pinned snapshot（`claude-opus-4-6`）；4.5 及更早为日期 ID + 别名指针（`claude-opus-4-5` = 别名）。

### 2.2 表 B：缓存语义与能力

| model                     | promptCacheMinTokens | cacheTtl（cacheTtlOptions） | storagePricePer1mHour | supports 摘要                                                 | tieredPricing 摘要    | sourceUrl | dataVerifiedAt | 备注/收录判定                                                                 |
| ------------------------- | -------------------- | --------------------------- | --------------------- | ------------------------------------------------------------- | --------------------- | --------- | -------------- | ----------------------------------------------------------------------------- |
| claude-fable-5            | 512                  | 5m（[5m, 1h]）              | —（无存储费概念）     | R✘ CC✔（断点 4/回溯 20） IM✘ RE✔（effort max/xhigh 可用）     | 无（1M 全窗口标准价） | pricing   | 2026-08-03     | P0 转录；最强已发布；新 tokenizer 同文本约多 30% tokens                       |
| claude-mythos-5           | 512                  | 5m（[5m, 1h]）              | —                     | 同 Fable 5                                                    | 无                    | pricing   | 2026-08-03     | P0 转录；limited availability（Project Glasswing，邀请制）                    |
| claude-mythos-preview     | 2048                 | 5m（[5m, 1h]）              | —                     | CC✔ RE✔（effort）                                             | 无                    | pricing   | 2026-08-03     | 价格 unavailable；邀请制 preview；不转录（若收录须 priceStatus: unavailable） |
| claude-opus-5             | 512                  | 5m（[5m, 1h]）              | —                     | R✘ CC✔ IM✘ RE✔（effort 默认 high；xhigh/max 不可关 thinking） | 无                    | pricing   | 2026-08-03     | P0 转录；官方推荐默认旗舰；fast mode（输入 $10/输出 $50）                     |
| claude-opus-4-8           | 1024                 | 5m（[5m, 1h]）              | —                     | R✘ CC✔ RE✔（effort 默认 high 全面）                           | 无                    | pricing   | 2026-08-03     | P0 转录；支持会话中 system 更新；fast mode 支持                               |
| claude-opus-4-7           | 2048                 | 5m（[5m, 1h]）              | —                     | R✘ CC✔ RE✔（官方建议编码/agentic 从 xhigh 起步）              | 无                    | pricing   | 2026-08-03     | P0 转录；新 tokenizer                                                         |
| claude-opus-4-6           | 4096                 | 5m（[5m, 1h]）              | —                     | R✘ CC✔ RE✔                                                    | 无                    | pricing   | 2026-08-03     | P0 转录；4.6 代起无日期 pinned snapshot                                       |
| claude-opus-4-5           | 4096                 | 5m（[5m, 1h]）              | —                     | R✘ CC✔ RE✔（唯一 extended-thinking-only 支持 effort）         | 无                    | pricing   | 2026-08-03     | P0 转录；走 extended thinking 轨道                                            |
| claude-opus-4-1           | 1024                 | 5m（[5m, 1h]）              | —                     | R✘ CC✔                                                        | 无                    | pricing   | 2026-08-03     | **已弃用（2026-08-05 退役）**，不转录                                         |
| claude-opus-4-0           | 1024                 | 5m（[5m, 1h]）              | —                     | R✘ CC✔                                                        | 无                    | pricing   | 2026-08-03     | 已退役（仅 Google Cloud），不转录                                             |
| claude-sonnet-5           | 1024                 | 5m（[5m, 1h]）              | —                     | R✘ CC✔ RE✔                                                    | 无                    | pricing   | 2026-08-03     | P0 转录；促销 8/31 到期 → 9/1 标准价；**不支持会话中 system 更新**            |
| claude-sonnet-4-6         | 1024                 | 5m（[5m, 1h]）              | —                     | R✘ CC✔ RE✔                                                    | 无                    | pricing   | 2026-08-03     | P0 转录                                                                       |
| claude-sonnet-4-5         | 1024                 | 5m（[5m, 1h]）              | —                     | R✘ CC✔                                                        | 无                    | pricing   | 2026-08-03     | P0 转录；extended thinking 轨道                                               |
| claude-sonnet-4-0         | 1024                 | 5m（[5m, 1h]）              | —                     | R✘ CC✔                                                        | 无                    | pricing   | 2026-08-03     | 已退役（仅 Bedrock/Google Cloud），不转录                                     |
| claude-haiku-4-5          | 4096                 | 5m（[5m, 1h]）              | —                     | R✘ CC✔ RE✘（不支持 effort/adaptive thinking）                 | 无                    | pricing   | 2026-08-03     | P0 转录；唯一支持 extended thinking 的现行轻量模型                            |
| claude-3-5-haiku-20241022 | 2048                 | 5m（[5m, 1h]）              | —                     | R✘ CC✔                                                        | 无                    | pricing   | 2026-08-03     | 已退役，不转录                                                                |

> 缓存要点：TTL 两档（默认 5 分钟，1 小时需显式 `cache_control ttl:"1h"`，1h 条目必须位于 5m 条目之前，违反返回 400）；断点上限 4（automatic caching 占 1 槽）；回溯窗口 20 块；最低缓存不足**静默不缓存**（`cache_creation_input_tokens` 与 `cache_read_input_tokens` 均为 0 即未缓存）；命中要求逐字节精确（含图片）、best-effort；effort/thinking 参数变更会失效缓存前缀（长会话应固定 effort）；前缀顺序 tools → system → messages；同请求混用 TTL 时 1h 在前。

### 2.3 缺项清单

1. **Mythos Preview 四指标价格**：limited availability 邀请制，官方定价页无此行（unavailable）。
2. **Opus 4 / Sonnet 4 / Haiku 3.5 上下文窗口与输出上限**：已退役，官方总览页不再列出。
3. **Bedrock / Google Cloud 平台价格**：未抓取（注意 Bedrock 有 global/regional 10% 溢价机制）。
4. **每模型 TPM/RPM 限速**：属 rate limits 文档域，未抓。
5. Fable 5 / Mythos 5 无其他档位（官方仅各一档，同规格同价）；models.dev 对 Anthropic 价格列为 $0.00（未公布），不作价源。

### 2.4 转录建议

- P0 转录 11 条现役：claude-fable-5 / claude-mythos-5 / claude-opus-5 / claude-opus-4-8 / claude-opus-4-7 / claude-opus-4-6 / claude-opus-4-5 / claude-sonnet-5 / claude-sonnet-4-6 / claude-sonnet-4-5 / claude-haiku-4-5。
- Sonnet 5 按促销价行收录 + `promoExpiresAt: "2026-08-31"` + `promoReplacesAt: "2026-09-01"`（9/1 标准价行不收录）。
- 不转录：claude-opus-4-1（2026-08-05 退役）、claude-opus-4-0 / claude-sonnet-4-0 / claude-3-5-haiku-20241022（retired）。
- 每模型 `promptCacheMinTokens` 四档（512/1024/2048/4096）是成本计算最低拦截线，R3 必须逐条落值。

---

## 3. Kimi 月之暗面（御十家 3/10）

> 概况：**11 条**（现行 5 + moonshot-v1 6；任务书口述 12 条，差额为遗留别名 `moonshot-v1-auto`——OpenAPI 有映射、列表页无收录，状态未确认，不收录）；**四指标完整 5 条**（现行 5 系；V1 系定价表无命中列）；币种 **CNY**（官方仅人民币计价，无 USD）。
> 数据日期 2026-08-03。来源：模型列表 https://platform.kimi.com/docs/models.md ｜ 定价总览 https://platform.kimi.com/docs/pricing/chat.md ｜ 各模型定价页（chat-k3 / chat-k27-code / chat-k26 / chat-k25 / chat-v1）｜ 缓存指南 https://platform.kimi.com/docs/guide/use-context-caching-feature-of-kimi-api.md
> 核心结论：缓存全自动（无断点、无 TTL 管理、写免费）；最低缓存 **256 tokens**（前一请求 prompt tokens > 256 才缓存）；`prompt_cache_key` 请求参数（**Coding Plan 必填**）；命中比例 k3=10% / k2.7-code=20% / k2.6≈16.9% / k2.5=17.5%（与百炼通道口径完全一致）；k2.5 与 moonshot-v1 系 8/31 全平台下线。

### 3.1 表 A：四指标价格总表（CNY / 1M tokens）

| model（官方 ID）                | provider/vendor | currency | contextWindow | maxOutputTokens                     | inputPrice | outputPrice | cacheReadPrice           | cacheWritePrice | cacheWrite5m/1h | priceStatus                       |
| ------------------------------- | --------------- | -------- | ------------- | ----------------------------------- | ---------- | ----------- | ------------------------ | --------------- | --------------- | --------------------------------- |
| kimi-k3                         | kimi/kimi       | CNY      | 1,048,576     | 131,072（默认；最大可设 1,048,576） | 20.00      | 100.00      | 2.00（10%）              | 0（写免费）     | —               | official                          |
| kimi-k2.7-code                  | kimi/kimi       | CNY      | 262,144       | 未公布                              | 6.50       | 27.00       | 1.30（20%）              | 0（写免费）     | —               | official                          |
| kimi-k2.7-code-highspeed        | kimi/kimi       | CNY      | 262,144       | 未公布                              | 13.00      | 54.00       | 2.60（20%）              | 0（写免费）     | —               | official                          |
| kimi-k2.6                       | kimi/kimi       | CNY      | 262,144       | 未公布                              | 6.50       | 27.00       | 1.10（≈16.9%）           | 0（写免费）     | —               | official                          |
| kimi-k2.5                       | kimi/kimi       | CNY      | 262,144       | 未公布                              | 4.00       | 21.00       | 0.70（17.5%）            | 0（写免费）     | —               | official（2026-08-31 全平台下线） |
| moonshot-v1-8k                  | kimi/kimi       | CNY      | 8,192         | 未获取                              | 2.00       | 10.00       | 未提供（定价表无命中列） | —               | —               | official（命中价未确认）          |
| moonshot-v1-32k                 | kimi/kimi       | CNY      | 32,768        | 未获取                              | 5.00       | 20.00       | 未提供                   | —               | —               | official（命中价未确认）          |
| moonshot-v1-128k                | kimi/kimi       | CNY      | 131,072       | 未获取                              | 10.00      | 30.00       | 未提供                   | —               | —               | official（命中价未确认）          |
| moonshot-v1-8k-vision-preview   | kimi/kimi       | CNY      | 8,192         | 未获取                              | 2.00       | 10.00       | 未提供                   | —               | —               | official（命中价未确认）          |
| moonshot-v1-32k-vision-preview  | kimi/kimi       | CNY      | 32,768        | 未获取                              | 5.00       | 20.00       | 未提供                   | —               | —               | official（命中价未确认）          |
| moonshot-v1-128k-vision-preview | kimi/kimi       | CNY      | 131,072       | 未获取                              | 10.00      | 30.00       | 未提供                   | —               | —               | official（命中价未确认）          |

### 3.2 表 B：缓存语义与能力

| model                    | promptCacheMinTokens           | cacheTtl（cacheTtlOptions）  | storagePricePer1mHour | supports 摘要                                                                                   | tieredPricing 摘要                    | sourceUrl                | dataVerifiedAt | 备注/收录判定                                                       |
| ------------------------ | ------------------------------ | ---------------------------- | --------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------ | -------------- | ------------------------------------------------------------------- |
| kimi-k3                  | 256                            | 未公布（省略，TTL 系统管理） | —（无存储费）         | R✘ CC✘ PK✔（路由辅助） IM✔（自动 best-effort） RE✔（reasoning_effort low/high/max 默认 max） V✔ | 无（1M 单档；官方未提及超长段阶梯价） | pricing/chat-k3.md       | 2026-08-03     | P0 转录；始终推理 + Preserved Thinking；**effort 切换破坏前缀命中** |
| kimi-k2.7-code           | 256                            | 未公布                       | —                     | R✘ CC✘ PK✔（**Coding Plan 必填**） IM✔ RE✔（仅思考模式） V✔ FC✔                                 | 无                                    | pricing/chat-k27-code.md | 2026-08-03     | P0 转录；Preserved Thinking 固定开启；temperature/top_p/n 固定      |
| kimi-k2.7-code-highspeed | 256                            | 未公布                       | —                     | 同 k2.7-code                                                                                    | 无                                    | pricing/chat-k27-code.md | 2026-08-03     | P0 转录；同模型价格 2x，输出约 180 token/s（短上下文 260）          |
| kimi-k2.6                | 256                            | 未公布                       | —                     | R✘ CC✘ PK✔ IM✔ RE✔（thinking 可开关，keep:"all"） V✔                                            | 无                                    | pricing/chat-k26.md      | 2026-08-03     | P0 转录                                                             |
| kimi-k2.5                | 256                            | 未公布                       | —                     | R✘ CC✘ PK✔ IM✔ RE✔ V✔                                                                           | 无                                    | pricing/chat-k25.md      | 2026-08-03     | **即将下线（2026-08-31 全平台下线）**，建议不转录                   |
| moonshot-v1 ×6           | 256（指南口径；V1 命中未确认） | 未公布                       | —                     | R✘ CC✘ PK— IM—（是否命中未确认）                                                                | 无                                    | pricing/chat-v1.md       | 2026-08-03     | **已下线不转录**（8/31 全平台下线）                                 |

> 缓存要点：全自动 Context Caching，无缓存 ID、无 TTL 管理、无 `cache_control`；命中 = 检测重复初始上下文（system prompt/知识文档/工具定义/历史消息），多轮对话把固定大段放 messages 最前；best-effort 不保证 100%；计量字段 = OpenAI 兼容**顶层 `usage.cached_tokens`**（非嵌套 details，适配层需单独处理）；K3/K2.7-Code 的 reasoning_content 必须原样回传（推理块是缓存前缀一部分）。

### 3.3 缺项清单

1. **moonshot-v1 系是否有缓存命中价**：定价表仅「输入/输出」两列、无命中列；缓存指南称全模型自动缓存——两处口径并存，V1 命中折扣**未确认**，建议实测（对比 `usage.cached_tokens` 计费）。
2. **moonshot-v1-auto**：OpenAPI 有映射、列表页无收录，状态与可调用性未确认。
3. **K3 的 1M 上下文计费细分**：官方只给 1M 总窗口单一价，超长段阶梯价未提及。
4. **缓存 TTL / 命中率**：官方未公布（生命期系统管理、首 token 延迟平均 <5s）。
5. **k2.5 / V1 下线后 API 行为**：8/31 后是否可用、价格是否维持，官方未公告。
6. 全系无官方 USD 定价（如需 USD 须按汇率换算，目录不换算）。

### 3.4 转录建议

- P0 转录 4 条：kimi-k3 / kimi-k2.7-code / kimi-k2.7-code-highspeed / kimi-k2.6；k2.5 建议不转录（8/31 下线）。
- `supportsPromptCacheKey: true`（Coding Plan 必填语义）；`promptCacheMinTokens: 256`；写免费三件套（`0` + `cacheWriteFree: true`）；`cacheType: "auto"`；`cacheTtl` 省略（官方未公布，TTL 路由按 vendor 默认兜底）。
- Batch API 仅支持 k2.7-code / k2.6 / k2.5，为标准价 60%（k2.7-code ¥0.78/¥3.90/¥16.20）。

---

## 4. GLM 智谱（御十家 4/10，双币种）

> 概况：**USD 站（provider=zai）20 条**（14 文本 + 6 视觉）；**CNY 站（provider=bigmodel）14 条**（9 文本 + 5 视觉）；双币种合计 **34 条**；四指标完整 **32 条**（USD 缺 2：GLM-4-32B 与 GLM-OCR 未列 cache_read）。
> 数据日期 2026-08-03。来源：z.ai 定价页 https://docs.z.ai/guides/overview/pricing（USD）｜ 国内站定价页 https://open.bigmodel.cn/pricing（CNY，前端 i18n「旗舰模型」区块，经用户提供结构化数据双源交叉确认）｜ 缓存文档 https://docs.z.ai/guides/capabilities/cache
> 核心结论：**命中价 + 存储费**双字段（无 Anthropic 式 cache_write 写价）；存储费按小时计时（元/百万 tokens/小时）、**当前限时免费（至 2026-08-31）**；国内站按输入长度分档（32K/128K/200K 边界），GLM-4.7/4.5-Air 另有输出 200K（0.2M）档；cache_control 未实测；USD 站命中 ≈ 输入价 14%~20.6%，CNY 站 20%~25.7%；GLM-4.7 保留式推理（Preserved Thinking）；官方 Anthropic 兼容端点存在（模型名 `glm-5.2` 式）。API 名称为点号形态（如 `glm-5.2`），目录键建议横线形态 + `apiModel` 承载。

### 4.1 表 A1：USD 站（zai）文本模型四指标价格

| model（官方名）     | provider/vendor | currency | contextWindow          | maxOutputTokens | inputPrice | outputPrice | cacheReadPrice | cacheWritePrice | cacheWrite5m/1h | priceStatus                          |
| ------------------- | --------------- | -------- | ---------------------- | --------------- | ---------- | ----------- | -------------- | --------------- | --------------- | ------------------------------------ |
| GLM-5.2             | zai/glm         | USD      | 1,000,000              | 128,000         | 1.40       | 4.40        | 0.26（18.6%）  | 0（写免费）     | —               | official                             |
| GLM-5.1             | zai/glm         | USD      | 200,000                | 131,072         | 1.40       | 4.40        | 0.26（18.6%）  | 0（写免费）     | —               | official                             |
| GLM-5               | zai/glm         | USD      | 200,000                | 131,072         | 1.00       | 3.20        | 0.20（20%）    | 0（写免费）     | —               | official                             |
| GLM-5-Turbo         | zai/glm         | USD      | 200,000                | 131,072         | 1.20       | 4.00        | 0.24（20%）    | 0（写免费）     | —               | official                             |
| GLM-4.7             | zai/glm         | USD      | 200,000                | 128,000         | 0.60       | 2.20        | 0.11（≈18%）   | 0（写免费）     | —               | official                             |
| GLM-4.7-FlashX      | zai/glm         | USD      | 200,000                | 131,072         | 0.07       | 0.40        | 0.01（≈14%）   | 0（写免费）     | —               | official                             |
| GLM-4.6             | zai/glm         | USD      | 200,000                | 131,072         | 0.60       | 2.20        | 0.11（≈18%）   | 0（写免费）     | —               | official                             |
| GLM-4.5             | zai/glm         | USD      | 128,000                | 96,000          | 0.60       | 2.20        | 0.11（≈18%）   | 0（写免费）     | —               | official                             |
| GLM-4.5-X           | zai/glm         | USD      | 未获取（推测 128K 系） | 未获取          | 2.20       | 8.90        | 0.45           | 0（写免费）     | —               | official                             |
| GLM-4.5-Air         | zai/glm         | USD      | 128,000                | 96,000          | 0.20       | 1.10        | 0.03（15%）    | 0（写免费）     | —               | official                             |
| GLM-4.5-AirX        | zai/glm         | USD      | 未获取（推测 128K 系） | 未获取          | 1.10       | 4.50        | 0.22（20%）    | 0（写免费）     | —               | official                             |
| GLM-4-32B-0414-128K | zai/glm         | USD      | 128,000                | 未获取          | 0.10       | 0.10        | 未列出（—）    | 0（写免费）     | —               | official（cache_read 缺）            |
| GLM-4.7-Flash       | zai/glm         | USD      | 200,000                | 128,000         | 免费       | 免费        | 免费           | 0（写免费）     | —               | official（免费档）                   |
| GLM-4.5-Flash       | zai/glm         | USD      | 128,000                | 96,000          | 免费       | 免费        | 免费           | 0（写免费）     | —               | official（免费档；国内站标即将下线） |

### 4.2 表 A2：USD 站（zai）视觉模型

| model（官方名） | provider/vendor | currency | contextWindow           | maxOutputTokens | inputPrice | outputPrice | cacheReadPrice | cacheWritePrice | cacheWrite5m/1h | priceStatus                         |
| --------------- | --------------- | -------- | ----------------------- | --------------- | ---------- | ----------- | -------------- | --------------- | --------------- | ----------------------------------- |
| GLM-5V-Turbo    | zai/glm         | USD      | 200,000                 | 131,072         | 1.20       | 4.00        | 0.24           | 0（写免费）     | —               | official（V✔）                      |
| GLM-4.6V        | zai/glm         | USD      | 128,000                 | 32,768          | 0.30       | 0.90        | 0.05           | 0（写免费）     | —               | official（V✔）                      |
| GLM-4.6V-FlashX | zai/glm         | USD      | 128,000                 | 未获取          | 0.04       | 0.40        | 0.004          | 0（写免费）     | —               | official（V✔）                      |
| GLM-4.6V-Flash  | zai/glm         | USD      | 128,000                 | 未获取          | 免费       | 免费        | 免费           | 0（写免费）     | —               | official（免费档，V✔）              |
| GLM-4.5V        | zai/glm         | USD      | 未获取（推测 64K~128K） | 未获取          | 0.60       | 1.80        | 0.11           | 0（写免费）     | —               | official（V✔）                      |
| GLM-OCR         | zai/glm         | USD      | 单图≤10MB / PDF≤50MB    | 未获取          | 0.03       | 0.03        | 未列出（—）    | —               | —               | official（OCR 特化，按 token 计费） |

### 4.3 表 A3：CNY 站（bigmodel）四指标价格（含分档）

| model（官方名） | provider/vendor | currency | contextWindow           | inputPrice（档）                                                    | outputPrice（档） | cacheReadPrice（档） | cacheWritePrice | cacheWrite5m/1h | priceStatus                             |
| --------------- | --------------- | -------- | ----------------------- | ------------------------------------------------------------------- | ----------------- | -------------------- | --------------- | --------------- | --------------------------------------- |
| GLM-5.2         | bigmodel/glm    | CNY      | 1,000,000               | 8（单档）                                                           | 28                | 2（25%）             | 0（写免费）     | —               | official                                |
| GLM-5.1         | bigmodel/glm    | CNY      | 200,000                 | [0,32K) 6 / [32K+) 8                                                | 24 / 28           | 1.3 / 2              | 0（写免费）     | —               | official                                |
| GLM-5-Turbo     | bigmodel/glm    | CNY      | 200,000                 | [0,32K) 5 / [32K+) 7                                                | 22 / 26           | 1.2 / 1.8            | 0（写免费）     | —               | official                                |
| GLM-5           | bigmodel/glm    | CNY      | 200,000                 | [0,32K) 4 / [32K+) 6                                                | 18 / 22           | 1 / 1.5              | 0（写免费）     | —               | official                                |
| GLM-4.7         | bigmodel/glm    | CNY      | 200,000                 | [0,32K)+输出[0,200K) 2 / [0,32K)+输出[200K+) 3 / [32K,200K) 4       | 8 / 14 / 16       | 0.4 / 0.6 / 0.8      | 0（写免费）     | —               | official                                |
| GLM-4.5-Air     | bigmodel/glm    | CNY      | 128,000                 | [0,32K)+输出[0,200K) 0.8 / [0,32K)+输出[200K+) 0.8 / [32K,128K) 1.2 | 2 / 6 / 8         | 0.16 / 0.16 / 0.24   | 0（写免费）     | —               | official（**限时 5 折**，恢复价未获取） |
| GLM-4.7-FlashX  | bigmodel/glm    | CNY      | 200,000                 | 0.5（单档）                                                         | 3                 | 0.1                  | 0（写免费）     | —               | official                                |
| GLM-4.7-Flash   | bigmodel/glm    | CNY      | 200,000                 | 免费                                                                | 免费              | 免费                 | 0（写免费）     | —               | official（免费档）                      |
| GLM-4.5-Flash   | bigmodel/glm    | CNY      | 128,000                 | 免费                                                                | 免费              | 免费                 | 0（写免费）     | —               | official（免费档；**即将下线**）        |
| GLM-5V-Turbo    | bigmodel/glm    | CNY      | 200,000                 | [0,32K) 5 / [32K+) 7                                                | 22 / 26           | 1.2 / 1.8            | 0（写免费）     | —               | official（V✔）                          |
| GLM-4.6V        | bigmodel/glm    | CNY      | 128,000                 | [0,32K) 1 / [32K,128K) 2                                            | 3 / 6             | 0.2 / 0.4            | 0（写免费）     | —               | official（V✔）                          |
| GLM-4.6V-FlashX | bigmodel/glm    | CNY      | 128,000                 | [0,32K) 0.15 / [32K,128K) 0.3                                       | 1.5 / 3           | 0.03 / 0.03          | 0（写免费）     | —               | official（V✔）                          |
| GLM-4.6V-Flash  | bigmodel/glm    | CNY      | 128,000                 | 免费                                                                | 免费              | 免费                 | 0（写免费）     | —               | official（免费档，V✔）                  |
| GLM-4.5V        | bigmodel/glm    | CNY      | 未获取（推测 64K~128K） | [0,32K) 2 / [32K,64K) 4                                             | 6 / 12            | 0.4 / 0.8            | 0（写免费）     | —               | official（V✔）                          |

> CNY 分档语义（schema §3.1）：tieredPricing 每档 = `minTokens`（32,000 / 128,000 / 200,000）半开区间、`maxTokens` null 表示无上界；GLM-4.7 与 4.5-Air 的「输出 [0.2M) / [0.2M+)」档用 `minOutputTokens`/`maxOutputTokens` 表达；**基础价 = 首档（[0,32K) 组合）**，增量档只列差异。GLM-5.1 CNY [32K+) 档命中价用户数据未提供，取 §3.1 值（¥2）时须标注来源。

### 4.4 表 B：缓存语义与能力（两站通用语义）

| model                                                    | promptCacheMinTokens            | cacheTtl（cacheTtlOptions） | storagePricePer1mHour                           | supports 摘要                                                                               | tieredPricing 摘要                                                   | sourceUrl                                                    | dataVerifiedAt | 备注/收录判定                                             |
| -------------------------------------------------------- | ------------------------------- | --------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------ | -------------- | --------------------------------------------------------- |
| GLM-5.2（双币种 2 条）                                   | 512（参考百炼通道；官方未标注） | 未公布（省略）              | 0（限时免费，storagePriceFreeUntil 2026-08-31） | R✘（大概率不支持，未确认） CC✘（**未实测**） IM✔（相似度自动缓存） RE✔（thinking 默认开启） | 无分档（1M 单档）                                                    | open.bigmodel.cn/pricing / docs.z.ai/guides/overview/pricing | 2026-08-03     | P0 转录；USD 与 CNY 各 1 条                               |
| GLM-5.1                                                  | 512（参考）                     | 未公布                      | 0（free until 2026-08-31）                      | 同上                                                                                        | CNY 2 档：[32K,∞) minTokens 32000                                    | 同上                                                         | 2026-08-03     | P0 转录（双币种）                                         |
| GLM-5-Turbo                                              | 512（参考）                     | 未公布                      | 0                                               | 同上                                                                                        | CNY 2 档：[32K,∞)                                                    | 同上                                                         | 2026-08-03     | P0 转录（双币种）；OpenClaw 场景优化                      |
| GLM-5                                                    | 512（参考）                     | 未公布                      | 0                                               | 同上                                                                                        | CNY 2 档：[32K,∞)                                                    | 同上                                                         | 2026-08-03     | P0 转录（双币种）                                         |
| GLM-4.7                                                  | 512（参考）                     | 未公布                      | 0                                               | 同上；保留式推理（thinking type enabled + clear_thinking:false，Coding Plan 默认开）        | CNY 3 档（输入 [32K,200K) × 输出 0.2M 边界组合）                     | 同上                                                         | 2026-08-03     | P0 转录（双币种）                                         |
| GLM-4.5-Air                                              | 512（参考）                     | 未公布                      | 0                                               | 同上                                                                                        | CNY 3 档（输入 [32K,128K) × 输出 200K 边界）                         | 同上                                                         | 2026-08-03     | P0 转录（双币种）；CNY 限时 5 折                          |
| GLM-4.7-FlashX                                           | 512（参考）                     | 未公布                      | 0                                               | 同上                                                                                        | 无（单档）                                                           | 同上                                                         | 2026-08-03     | P1 转录                                                   |
| GLM-4.7-Flash / GLM-4.5-Flash                            | 512（参考）                     | 未公布                      | 0                                               | 同上                                                                                        | 无                                                                   | 同上                                                         | 2026-08-03     | P1 转录（免费档）；4.5-Flash 即将下线                     |
| GLM-4.6 / GLM-4.5 / GLM-4.5-X / GLM-4.5-AirX / GLM-4-32B | 512（参考）                     | 未公布                      | 0                                               | 同上                                                                                        | 无（USD 单档）                                                       | docs.z.ai/guides/overview/pricing                            | 2026-08-03     | P1 备查；4.5-X / AirX 窗口未确认                          |
| GLM-5V-Turbo / 4.6V / 4.6V-FlashX / 4.6V-Flash / 4.5V    | 512（参考）                     | 未公布                      | 0                                               | V✔（多模态输入按内容构成计费）                                                              | CNY 2 档（5V-Turbo [32K,∞)；4.6V/FlashX [32K,128K)；4.5V [32K,64K)） | 同上                                                         | 2026-08-03     | P1 转录（多模态 Agent 场景必需，标 supportsVision: true） |
| GLM-OCR                                                  | —                               | —                           | —                                               | V✔（OCR 特化）                                                                              | 无                                                                   | docs.z.ai                                                    | 2026-08-03     | 非标准对话模型，建议不转录                                |

> 存储费字段：`storagePricePer1mHour: 0` + `storagePriceFreeUntil: "2026-08-31"`（两站一致，到期恢复价未获取，9/1 前复核）。命中价两站口径并存：USD 站命中 ≈ 输入价 14%~20.6%（推荐口径），CNY 站 20%~25.7%（5.2 = 25%）；缓存文档示例「usually 50%」不采用，以定价页数字为准。

### 4.5 缺项清单

1. **Anthropic 兼容端点（/api/anthropic）的 cache_control 断点行为**：官方文档（国际/国内两站）未说明，需实测 → `supportsCacheControl: false`（保守）。
2. **Responses API 支持**：官方文档无条目，大概率不支持（未确认）。
3. **GLM-4.5-X / GLM-4.5-AirX 上下文窗口**：z.ai 有价但模型页未标注（推测 128K 系，未确认）；CNY 站未收录这两款。
4. **GLM-4.5V 上下文窗口**：两站未标注（CNY 有 [0,32K)/[32K,64K) 档，推测 64K~128K，未确认）。
5. **最低可缓存 token**：官方未标注；仅百炼通道 GLM = 512 可参考（表内按 512 参考值 + notes）。
6. **缓存存储费恢复价**：限时免费至 2026-08-31，恢复价未获取。
7. **GLM-4.5-Air 限时 5 折的恢复原价**：折扣到期日与恢复价未获取。
8. **GLM-4-32B / GLM-OCR cache_read**：USD 站未列出（缺项）。
9. **国内站运营接口旧表（GLM-4 时代）**：与旗舰区块不一致，以 i18n 旗舰区块为准。

### 4.6 转录建议

- 双币种建条目：USD（provider=zai）+ CNY（provider=bigmodel），`vendor` 均为 `glm`，行为矩阵 vendor 不受 provider 影响。
- 缓存字段：`cacheWritePrice: 0` + `cacheWriteFree: true`；`cacheMechanism: "similarity"`（内容相似度，非严格前缀哈希）；`supportsCacheControl: false`（未实测）；`supportsResponses: false`。
- tieredPricing 按「输入档 × 输出档」组合展开（GLM-4.7 为 3 条、4.5-Air 为 3 条）；基础价 = 首档。
- 促销标记：GLM-4.5-Air CNY 限时 5 折；缓存存储限时免费（2026-08-31）——两者均需刷新清单跟踪。
- GLM-5V-Turbo 用户口径「新品」与 models.dev「2026-04 上线」并存备查。

---

## 5. Qwen 阿里百炼（御十家 5/10）

> 概况：**23 条**（19 文本 + 4 视觉）；**四指标完整 21 条**（qwen3.8-max-preview 与 qwen3.5-omni-plus 缺缓存价）；币种 **CNY**（华北2 北京基准；国际地域另价：新加坡≈北京×1.25，东京/法兰克福与北京同价，弗吉尼亚有 -us 版）。
> 数据日期 2026-08-03。来源：百炼模型广场 https://help.aliyun.com/zh/model-studio/models ｜ 定价页 https://help.aliyun.com/zh/model-studio/billing-for-model-studio ｜ 缓存文档 https://help.aliyun.com/zh/model-studio/context-cache ｜ Responses API https://help.aliyun.com/zh/model-studio/compatibility-with-openai-responses-api
> 核心结论：**cache_read/cache_write 全系为推导值（※）**：官方只公布比例（显式命中 10%、显式创建 125%、隐式命中 20%），定价页明示「输入单价不含缓存单价」，绝对价 = 比例 × 官方输入价 → `priceStatus: "derived"` + `derivation`。三套缓存并存：显式 cache_control（最低 1024、TTL 5m、4 断点 20 回溯）+ 隐式自动（最低 256、命中 20%）+ Responses Session 缓存（header `x-dashscope-session-cache: enable`，响应 id 有效 7 天）。最新旗舰 **`qwen3.8-max`**（12/36、1M、effort low/medium/xhigh 默认 xhigh）；不存在 `qwen3-coder-ultra`；`qwen3.7-max` 为官方点号名（目录旧键 `qwen3-7-max` 须映射 apiModel）。

### 5.1 表 A：四指标价格总表（CNY / 1M tokens，※ = 推导价）

| model（官方 ID）    | apiModel                                | provider/vendor | currency | contextWindow | inputPrice（档）             | outputPrice（档）                          | cacheReadPrice（显式 10%）※ | cacheWritePrice（显式 125%）※ | cacheWrite5m/1h | priceStatus                             |
| ------------------- | --------------------------------------- | --------------- | -------- | ------------- | ---------------------------- | ------------------------------------------ | --------------------------- | ----------------------------- | --------------- | --------------------------------------- |
| qwen3.8-max         | —                                       | dashscope/qwen  | CNY      | 1,000,000     | 12（无阶梯）                 | 36                                         | 1.2                         | 15                            | —               | **derived**                             |
| qwen3.8-max-preview | —                                       | dashscope/qwen  | CNY      | 1,000,000     | 12（Token Plan 口径）        | 36                                         | —（未给）                   | —（未给）                     | —               | official（仅 Token Plan 可用）          |
| qwen3.7-max         | 旧键 qwen3-7-max → apiModel qwen3.7-max | dashscope/qwen  | CNY      | 1,000,000     | 12（**限时 5 折** = 6）      | 36（折后 18）                              | 1.2（折后 0.6）             | 15（折后 7.5）                | —               | derived（促销未标期）                   |
| qwen3.6-max-preview | —                                       | dashscope/qwen  | CNY      | 256,000       | 9 / 15（≤128K / >128K）      | 54 / 90                                    | 0.9 / 1.5                   | 11.25 / 18.75                 | —               | derived                                 |
| qwen3-max           | —                                       | dashscope/qwen  | CNY      | 256,000       | 2.5 / 4 / 7                  | 10 / 16 / 28                               | 0.25 / 0.4 / 0.7            | 3.125 / 5 / 8.75              | —               | derived                                 |
| qwen3.7-plus        | —                                       | dashscope/qwen  | CNY      | 1,000,000     | 2 / 6（≤256K / >256K）       | 8 / 24                                     | 0.2 / 0.6                   | 2.5 / 7.5                     | —               | derived（**限时 8 折**）                |
| qwen3.6-plus        | —                                       | dashscope/qwen  | CNY      | 1,000,000     | 2 / 8                        | 12 / 48                                    | 0.2 / 0.8                   | 2.5 / 10                      | —               | derived                                 |
| qwen3.5-plus        | —                                       | dashscope/qwen  | CNY      | 1,000,000     | 0.8 / 2 / 4                  | 4.8 / 12 / 24                              | 0.08 / 0.2 / 0.4            | 1 / 2.5 / 5                   | —               | derived                                 |
| qwen3.7-flash       | —                                       | dashscope/qwen  | CNY      | 1,000,000     | 0.2 / 0.6 / 1.2              | 0.8 / 2.4 / 4.8                            | 0.02 / 0.06 / 0.12          | 0.25 / 0.75 / 1.5             | —               | derived                                 |
| qwen3.6-flash       | —                                       | dashscope/qwen  | CNY      | 1,000,000     | 1.2 / 4.8                    | 7.2 / 28.8                                 | 0.12 / 0.48                 | 1.5 / 6                       | —               | derived                                 |
| qwen3.5-flash       | —                                       | dashscope/qwen  | CNY      | 1,000,000     | 0.2 / 0.8 / 1.2              | 2 / 8 / 12                                 | 0.02 / 0.08 / 0.12          | 0.25 / 1 / 1.5                | —               | derived                                 |
| qwen3-coder-plus    | —                                       | dashscope/qwen  | CNY      | 1,000,000     | 4 / 6 / 10 / 20              | 16 / 24 / 40 / 200                         | 0.4 / 0.6 / 1 / 2           | 5 / 7.5 / 12.5 / 25           | —               | derived（Batch 半价）                   |
| qwen3-coder-flash   | —                                       | dashscope/qwen  | CNY      | 1,000,000     | 1 / 1.5 / 2.5 / 5            | 4 / 6 / 10 / 25                            | 0.1 / 0.15 / 0.25 / 0.5     | 1.25 / 1.875 / 3.125 / 6.25   | —               | derived                                 |
| qwen3-coder-next    | —                                       | dashscope/qwen  | CNY      | 256,000       | 1 / 1.5 / 2.5                | 4 / 6 / 10                                 | 0.1 / 0.15 / 0.25           | 1.25 / 1.875 / 3.125          | —               | derived（开源权重托管）                 |
| qwen-plus           | —                                       | dashscope/qwen  | CNY      | 1,000,000     | 0.8 / 2.4 / 4.8              | 2 / 20 / 48（非思考）；8 / 24 / 64（思考） | 0.08 / 0.24 / 0.48          | 1 / 3 / 6                     | —               | derived                                 |
| qwen-flash          | —                                       | dashscope/qwen  | CNY      | 1,000,000     | 0.15 / 0.6 / 1.2             | 1.5 / 6 / 12                               | 0.015 / 0.06 / 0.12         | 0.1875 / 0.75 / 1.5           | —               | derived                                 |
| qwen-turbo          | —                                       | dashscope/qwen  | CNY      | 128,000       | 0.3                          | 0.6（非思考）/ 3（思考）                   | 0.03                        | 0.375                         | —               | derived                                 |
| qwen-long           | —                                       | dashscope/qwen  | CNY      | 10,000,000    | 0.5                          | 2                                          | 0.05                        | 0.625                         | —               | derived（超长文档，无思考/工具）        |
| qwq-plus            | —                                       | dashscope/qwen  | CNY      | 128,000       | 1.6                          | 4                                          | 0.16                        | 2                             | —               | derived（仅思考模式，Batch 半价）       |
| qwen3-vl-plus       | —                                       | dashscope/qwen  | CNY      | 256,000       | 1 / 1.5 / 3                  | 10 / 15 / 30                               | 0.1 / 0.15 / 0.3            | 1.25 / 1.875 / 3.75           | —               | derived（V✔）                           |
| qwen3-vl-flash      | —                                       | dashscope/qwen  | CNY      | 256,000       | 0.15 / 0.3 / 0.6             | 1.5 / 3 / 6                                | 0.015 / 0.03 / 0.06         | 0.1875 / 0.375 / 0.75         | —               | derived（V✔）                           |
| qwen3.5-omni-plus   | —                                       | dashscope/qwen  | CNY      | 未获取        | 文本/图/视频 7；音频 53      | 文本 40；文本+音频 213                     | —（未获取）                 | —（未获取）                   | —               | official（千问平台口径）                |
| qwen2.5-omni-7b     | —                                       | dashscope/qwen  | CNY      | 32,000        | 文本 0.6；音频 38；图/视频 2 | 文本 2.4；音频 76；图/视频 6               | 0.06                        | 0.75                          | —               | derived（V✔，Qwen2.5 系仅存多模态在售） |

> 计费口径：官方计价单位「元/千 tokens」已 ×1000 换算为「元/百万 tokens」；阶梯档 = 整请求按落档全量计费（多档用「/」分隔，tieredPricing 按各档 minTokens 展开）；思考 token 按输出计费；qwen3.8-max / qwen3.7-max / qwen3.7-flash 思考与非思考同价（旧商业版 qwen-plus/flash/turbo 与 qwen3.7-plus 思考档另有差价）；图像 token 换算：每 32×32 像素 1 token（1024×1024 ≈ 256 token）。

### 5.2 表 B：缓存语义与能力

| model                                                      | promptCacheMinTokens      | cacheTtl（cacheTtlOptions） | storagePricePer1mHour | supports 摘要                                                                                                | tieredPricing 摘要                               | sourceUrl                | dataVerifiedAt | 备注/收录判定                                              |
| ---------------------------------------------------------- | ------------------------- | --------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ------------------------ | -------------- | ---------------------------------------------------------- |
| qwen3.8-max                                                | 1024（显式）；256（隐式） | 5m（显式）                  | —                     | R✔（Session 缓存） CC✔（4 断点/20 回溯） PK✘ IM✔（20%） RE✔（low/medium/xhigh 默认 xhigh） V✔（图/视频输入） | 无（单档）                                       | billing-for-model-studio | 2026-08-03     | P0 转录；思考/非思考同价；derivation 三因子齐出            |
| qwen3.8-max-preview                                        | 1024（Token Plan 下）     | 5m                          | —                     | R— CC✔ IM✔（仅 Token Plan 下） RE✔（仅思考模式）                                                             | 无                                               | 同上                     | 2026-08-03     | 仅 Token Plan 可用（按量计费不可用），标注后 P1            |
| qwen3.7-max                                                | 1024/256                  | 5m                          | —                     | R✔ CC✔ IM✔ RE✔（混合思考默认开启）                                                                           | 无                                               | 同上                     | 2026-08-03     | P0 转录；apiModel 修正；限时 5 折                          |
| qwen3.6-max-preview                                        | 1024/256                  | 5m                          | —                     | R✔ CC✔ IM✔ RE✔                                                                                               | 2 档：[128K,∞) minTokens 128000                  | 同上                     | 2026-08-03     | P1                                                         |
| qwen3-max                                                  | 1024/256                  | 5m                          | —                     | R✔ CC✔ IM✔ RE✔（混合思考默认关闭）                                                                           | 3 档：minTokens 32000/128000（[128K,256K)）      | 同上                     | 2026-08-03     | P1；快照 2026-01-23 同价（2025-09-23 快照为 6/10/15 元档） |
| qwen3.7-plus                                               | 1024/256                  | 5m                          | —                     | R✔ CC✔ IM✔ RE✔                                                                                               | 2 档：[256K,∞) minTokens 256000                  | 同上                     | 2026-08-03     | P0 转录（AI 编程/Agent 综合推荐）；限时 8 折               |
| qwen3.6-plus / qwen3.5-plus                                | 1024/256                  | 5m                          | —                     | R✔ CC✔ IM✔ RE✔                                                                                               | 2 档（3.6 [256K,∞)）/ 3 档（3.5：32K/128K/256K） | 同上                     | 2026-08-03     | P1                                                         |
| qwen3.7-flash / qwen3.6-flash / qwen3.5-flash              | 1024/256                  | 5m                          | —                     | R✔ CC✔ IM✔ RE✔（3.7/3.6 flash thinking_budget 上限 256K/128K）                                               | 3 档（3.7）/ 2 档（3.6）/ 3 档（3.5）            | 同上                     | 2026-08-03     | P0（3.7-flash 高性价比推荐）/ P1（3.6/3.5）                |
| qwen3-coder-plus / coder-flash / coder-next                | 1024/256                  | 5m                          | —                     | R✔ CC✔ IM✔ FC✔（编程特化）                                                                                   | 4 档（plus/flash：32K/128K/256K/∞；next 3 档）   | 同上                     | 2026-08-03     | P0（coder-plus）/ P1；不存在 qwen3-coder-ultra             |
| qwen-plus / qwen-flash / qwen-turbo / qwen-long / qwq-plus | 1024/256                  | 5m                          | —                     | R✔（plus/flash） CC✔ IM✔                                                                                     | 3 档（plus/flash）；turbo/long/qwq 单档          | 同上                     | 2026-08-03     | P1 备查（旧商业版）                                        |
| qwen3-vl-plus / qwen3-vl-flash                             | 1024/256                  | 5m                          | —                     | R— CC✔ IM✔ V✔（图像/视频按 token 计费）                                                                      | 3 档                                             | 同上                     | 2026-08-03     | P1（VL 视觉理解）                                          |
| qwen3.5-omni-plus                                          | —                         | —                           | —                     | V✔ A✔                                                                                                        | —                                                | 千问平台定价页           | 2026-08-03     | 缓存价未获取；百炼价以控制台为准                           |
| qwen2.5-omni-7b                                            | 1024/256                  | 5m                          | —                     | V✔ A✔                                                                                                        | 无                                               | 同上                     | 2026-08-03     | P1                                                         |

### 5.3 缺项清单

1. **官方绝对缓存价**：官方始终只公布比例（定价页明示「输入单价不含缓存单价」）；表内绝对价为**推导值（※）**，控制台模型市场可查单模型缓存价（登录墙，webfetch 不可达）。`priceStatus: "derived"` + `derivation`（cacheReadFactor 0.1 / cacheWriteFactor 1.25 / implicitCacheReadFactor 0.2）。
2. **qwen3.8-max-preview**：显式/隐式缓存仅 Token Plan 下可用，缓存绝对价未给；仅思考模式。
3. **qwen3.5-omni-plus**：百炼侧价格以控制台为准（当前为千问平台口径），缓存价未获取。
4. **限时折扣到期日**：qwen3.7-max 5 折、qwen3.7-plus 8 折为活动价，到期日官方未标注（promoExpiresAt 未获取）。
5. **maxOutputTokens**：官方未公布（表内省略，R3 按 models.dev 口径补时可标注来源）。
6. **docs.qwen.ai**：传输错误不可达（已用 help.aliyun.com + platform.qianwenai.com + models.dev 三源替代）。
7. 第三方部署模型（deepseek-v3.2、kimi-k2.6/2.5/2.7-code、glm-5.1 等经百炼通道）折扣不同，不并入 Qwen 官方条目。
8. qwen3.8-max 官方发布时间公告未标注（models.dev 记 preview 2026-07-19）。

### 5.4 转录建议

- 全系 `priceStatus: "derived"` + `derivation`；P5 与前端须感知推导降级（估算可信度降级，官方绝对价需登录控制台核对）。
- `supportsCacheControl: true`（显式轨）＋ `breakpointMax: 4` + `lookbackBlocks: 20` + `cacheTtl: "5m"`；`supportsResponses: true`（Session 缓存走 Responses）；`supportsImplicitCaching: true`（隐式 20% 仅 P5 按比例折算，目录不存隐式绝对价）。
- `cacheWritePrice` 有推导值（如 15）且 `cacheWriteFree: false`（Qwen 有写价概念——显式创建 125%）。
- apiModel 修正：qwen3-7-max（目录旧键）→ `qwen3.7-max`；新增 qwen3.8-max 条目。
- 促销按原价收录 + 促销标记（同 Sonnet 5 处理策略）。

---

## 6. Grok xAI（御十家 6/10）

> 概况：**6 个文本模型，全部双档位（<200K / ≥200K）**；四指标完整 **6 条**；币种 USD。
> 数据日期 2026-08-03。来源：模型页 https://docs.x.ai/developers/models ｜ 定价页 https://docs.x.ai/developers/pricing ｜ 缓存文档 https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works
> 核心结论：**长上下文规则 = 阈值 200,000 prompt tokens，超过后整请求全部 token（含缓存命中部分）按长档计费**（官方原文「billed at the higher rate for all tokens」）；缓存全自动前缀、无断点参数；粘性路由 `x-grok-conv-id`（Chat）/ `prompt_cache_key`（Responses，官方第一建议）；写免费（官方定价结构无写价列，**推断**）；Batch 仅 4.3/4.20 系 8 折（4.5/build 无）；Priority Processing 标准价 2x。

### 6.1 表 A：四指标价格总表（USD / 1M tokens）

| model（官方 ID）             | provider/vendor | currency | contextWindow | maxOutputTokens                   | inputPrice（<200K / ≥200K） | outputPrice（<200K / ≥200K） | cacheReadPrice（<200K / ≥200K） | cacheWritePrice   | cacheWrite5m/1h | priceStatus                         |
| ---------------------------- | --------------- | -------- | ------------- | --------------------------------- | --------------------------- | ---------------------------- | ------------------------------- | ----------------- | --------------- | ----------------------------------- |
| grok-4.5                     | xai/xai         | USD      | 500,000       | 未公布（models.dev 500,000 参考） | 2.00 / 4.00                 | 6.00 / 12.00                 | 0.30 / 0.60（15%）              | 0（写免费，推断） | —               | official                            |
| grok-4.3                     | xai/xai         | USD      | 1,000,000     | 未公布（models.dev 30,000 参考）  | 1.25 / 2.50                 | 2.50 / 5.00                  | 0.20 / 0.40（16%）              | 0（写免费，推断） | —               | official（Batch 8 折）              |
| grok-4.20-0309-reasoning     | xai/xai         | USD      | 1,000,000     | 未公布（models.dev 30,000 参考）  | 1.25 / 2.50                 | 2.50 / 5.00                  | 0.20 / 0.40（16%）              | 0（写免费，推断） | —               | official（Batch 8 折）              |
| grok-4.20-0309-non-reasoning | xai/xai         | USD      | 1,000,000     | 未公布（models.dev 30,000 参考）  | 1.25 / 2.50                 | 2.50 / 5.00                  | 0.20 / 0.40（16%）              | 0（写免费，推断） | —               | official（Batch 8 折）              |
| grok-4.20-multi-agent-0309   | xai/xai         | USD      | 1,000,000     | 未公布（models.dev 30,000 参考）  | 1.25 / 2.50                 | 2.50 / 5.00                  | 0.20 / 0.40（16%）              | 0（写免费，推断） | —               | official（Batch 8 折；多 Agent 档） |
| grok-build-0.1               | xai/xai         | USD      | 256,000       | 未公布（models.dev 256,000 参考） | 1.00 / 2.00                 | 2.00 / 4.00                  | 0.20 / 0.40（20%）              | 0（写免费，推断） | —               | official                            |

> 别名：grok-4.5 有 `grok-4.5-latest` / `grok-build-latest`；grok-4.3 有 `grok-4.3-latest` / `grok-latest`；4.20 系为日期型无滚动别名。4.20 系上下文官方 1M（models.dev/OpenRouter 标 2M，**以官方为准**）。

### 6.2 表 B：缓存语义与能力

| model                        | promptCacheMinTokens | cacheTtl（cacheTtlOptions） | storagePricePer1mHour | supports 摘要                                                                                         | tieredPricing 摘要                                                                                          | sourceUrl | dataVerifiedAt | 备注/收录判定                                 |
| ---------------------------- | -------------------- | --------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------- | -------------- | --------------------------------------------- |
| grok-4.5                     | 未公布               | 未公布                      | —                     | R✔（主推） CC✘ PK✔（x-grok-conv-id / prompt_cache_key） IM✔（自动前缀） RE✔（effort low/medium/high） | ≥200K 档：minTokens 200000、maxTokens null，input 4.00 / output 12.00 / read 0.60（**整请求全量 2x 计费**） | pricing   | 2026-08-03     | P0 转录；无 Batch 折扣                        |
| grok-4.3                     | 未公布               | 未公布                      | —                     | 同 4.5                                                                                                | ≥200K 档：2.50 / 5.00 / 0.40                                                                                | pricing   | 2026-08-03     | P0 转录；Batch 8 折                           |
| grok-4.20-0309-reasoning     | 未公布               | 未公布                      | —                     | R✔ PK✔ IM✔（推理档）                                                                                  | 同 4.3                                                                                                      | pricing   | 2026-08-03     | P1；推理模型必须回传 reasoning_content 保命中 |
| grok-4.20-0309-non-reasoning | 未公布               | 未公布                      | —                     | R✔ PK✔ IM✔                                                                                            | 同 4.3                                                                                                      | pricing   | 2026-08-03     | P1                                            |
| grok-4.20-multi-agent-0309   | 未公布               | 未公布                      | —                     | R✔ PK✔ IM✔（effort 支持 xhigh）                                                                       | 同 4.3                                                                                                      | pricing   | 2026-08-03     | P1                                            |
| grok-build-0.1               | 未公布               | 未公布                      | —                     | R✔ PK✔ IM✔ FC✔（fast coding）                                                                         | ≥200K 档：2.00 / 4.00 / 0.40                                                                                | pricing   | 2026-08-03     | P0 转录；无 Batch 折扣                        |

> 缓存要点：命中 = 前缀逐 token 精确匹配（编辑/删除/重排早期消息整体失效）；best-effort 不保证 100%（内存驱逐/跨服务器路由 miss）；TTL 官方仅「随时可能驱逐」；`prompt_cache_key` 与 OpenAI 同名但**语义不同**（粘性路由而非断点路由，无 15 req/min 流控）；`previous_response_id` 有状态续接可免手动回传 reasoning_content。

### 6.3 缺项清单

1. **最低可缓存 token 数**：官方未公布（无 Anthropic 512/OpenAI 1024 式阈值）。
2. **缓存 TTL**：官方未公布具体时长。
3. **缓存写入价**：官方定价结构无写价列 → 写免费为**推断**（官方未显式声明「写免费」），转录时 notes 标注。
4. **输出上限**：官方未公布（models.dev 口径 4.5=500K / 4.3 与 4.20 系=30K / build=256K，仅参考）。
5. **grok-4.20 系历史版本（0309 之前）价格**：官方已不在售清单。
6. **multi-agent 档实际使用限制**（tool_call 官方标 false）：仅能力标注。

### 6.4 转录建议

- 四价直填 + `tieredPricing: [{minTokens: 200000, maxTokens: null, ...}]`（长档语义 = **整请求全量计费**，P5 必须按档匹配，不得只对超出部分计算）。
- 写免费推断 → `cacheWritePrice: 0` + `cacheWriteFree: true` + notes「官方无写价列，写免费为推断」。
- `supportsPromptCacheKey: true`（行为矩阵 PK 轨）；`promptCacheMinTokens` / `cacheTtl` 省略（官方未公布，TTL 路由按 vendor 默认兜底）。

---

## 7. MiniMax（御十家 7/10，双币种）

> 概况：**9 个模型**（8 有价 + M2-her 无价），双币种条目 = **CNY 9 + USD 9 = 18 条**；四指标完整 **16 条**（8 CNY + 8 USD；M2-her 无价）；币种 CNY + USD。
> 数据日期 2026-08-03。来源：国内站按量计费 https://platform.minimaxi.com/docs/guides/pricing-paygo（CNY）｜ 国际站 https://platform.minimax.io/docs/guides/pricing-paygo（USD）｜ 被动缓存文档 https://platform.minimaxi.com/docs/api-reference/text-prompt-caching ｜ Anthropic 主动缓存文档 https://platform.minimaxi.com/docs/api-reference/anthropic-api-compatible-cache
> 核心结论：双轨缓存（被动自动 ≥512 token；主动 Anthropic 式复刻：4 断点 / 20 回溯 / TTL 5 分钟 / 写价 1.25x）；**M3 仅被动缓存（无写价）、永久五折现行价**（CNY 2.10/8.40/0.42，原价 4.20/16.80/0.84）；M2.x 主动轨写价 1.25x（CNY 2.625 / USD 0.375）；highspeed 变体输入/输出 2x 但**缓存读写价不变**；M3 >512K 长上下文 2x（输入 token 含缓存命中部分）；M3 支持 image_url/video_url 多模态输入；不存在 M2.5.1 与 M3 系列变体。

### 7.1 表 A：四指标价格总表（CNY 国内站，元/1M）

| model（官方 ID）       | provider/vendor  | currency | contextWindow | maxOutputTokens            | inputPrice（档）                                  | outputPrice（档） | cacheReadPrice（档）     | cacheWritePrice     | cacheWrite5m/1h | priceStatus                        |
| ---------------------- | ---------------- | -------- | ------------- | -------------------------- | ------------------------------------------------- | ----------------- | ------------------------ | ------------------- | --------------- | ---------------------------------- |
| MiniMax-M3             | minimaxi/minimax | CNY      | 1,000,000     | 128,000（models.dev 口径） | ≤512K: 2.10（原 4.20，**永久五折**）/ >512K: 4.20 | 8.40 / 16.80      | 0.42 / 0.84（20%）       | 0（写免费，仅被动） | —               | official                           |
| MiniMax-M2.7           | minimaxi/minimax | CNY      | 204,800       | 131,072（models.dev 口径） | 2.10                                              | 8.40              | 0.42（20%）              | 2.625               | —               | official                           |
| MiniMax-M2.7-highspeed | minimaxi/minimax | CNY      | 204,800       | 131,072（models.dev 口径） | 4.20                                              | 16.80             | 0.42（**缓存读价不变**） | 2.625               | —               | official                           |
| MiniMax-M2.5           | minimaxi/minimax | CNY      | 204,800       | 131,072（models.dev 口径） | 2.10                                              | 8.40              | 0.21（10%）              | 2.625               | —               | official（官方定价页折叠区）       |
| MiniMax-M2.5-highspeed | minimaxi/minimax | CNY      | 204,800       | 131,072（models.dev 口径） | 4.20                                              | 16.80             | 0.21                     | 2.625               | —               | official                           |
| MiniMax-M2.1           | minimaxi/minimax | CNY      | 204,800       | 131,072（models.dev 口径） | 2.10                                              | 8.40              | 0.21（10%）              | 2.625               | —               | official                           |
| MiniMax-M2.1-highspeed | minimaxi/minimax | CNY      | 204,800       | 131,072（models.dev 口径） | 4.20                                              | 16.80             | 0.21                     | 2.625               | —               | official                           |
| MiniMax-M2             | minimaxi/minimax | CNY      | 204,800       | 128,000（models.dev 口径） | 2.10                                              | 8.40              | 0.21（10%）              | 2.625               | —               | official                           |
| M2-her                 | minimaxi/minimax | CNY      | 64,000        | 未获取                     | 未获取                                            | 未获取            | 未获取                   | —                   | —               | unavailable（独立 text-chat 接口） |

> 优先服务档（`service_tier=priority`，标准价 1.5x，仅 M3 列示）：≤512K 3.15 / 12.60 / 0.63；>512K 6.30 / 25.20 / 1.26。

### 7.2 表 A2：USD 国际站（同构，$ / 1M）

| model（官方 ID）                 | provider/vendor    | currency | inputPrice（档）                    | outputPrice（档） | cacheReadPrice（档） | cacheWritePrice     | priceStatus |
| -------------------------------- | ------------------ | -------- | ----------------------------------- | ----------------- | -------------------- | ------------------- | ----------- |
| MiniMax-M3                       | minimax-io/minimax | USD      | ≤512K: 0.30（原 0.60）/ >512K: 0.60 | 1.20 / 2.40       | 0.06 / 0.12（20%）   | 0（写免费，仅被动） | official    |
| MiniMax-M2.7                     | minimax-io/minimax | USD      | 0.30                                | 1.20              | 0.06（20%）          | 0.375               | official    |
| MiniMax-M2.7-highspeed           | minimax-io/minimax | USD      | 0.60                                | 2.40              | 0.06                 | 0.375               | official    |
| MiniMax-M2.5（Legacy）           | minimax-io/minimax | USD      | 0.30                                | 1.20              | 0.03（10%）          | 0.375               | official    |
| MiniMax-M2.5-highspeed（Legacy） | minimax-io/minimax | USD      | 0.60                                | 2.40              | 0.03                 | 0.375               | official    |
| MiniMax-M2.1（Legacy）           | minimax-io/minimax | USD      | 0.30                                | 1.20              | 0.03（10%）          | 0.375               | official    |
| MiniMax-M2.1-highspeed（Legacy） | minimax-io/minimax | USD      | 0.60                                | 2.40              | 0.03                 | 0.375               | official    |
| MiniMax-M2（Legacy）             | minimax-io/minimax | USD      | 0.30                                | 1.20              | 0.03（10%）          | 0.375               | official    |
| M2-her                           | minimax-io/minimax | USD      | 未获取                              | 未获取            | 未获取               | —                   | unavailable |

> 双站互验：CNY/USD 约 7:1（M2.7 输入 ¥2.10 ≈ $0.30、写入 ¥2.625 ≈ $0.375）。上下文/输出上限同 §7.1。models.dev 差异：M2.5-highspeed cache_read 记 0.06（官方 0.03，**疑误，以官方为准**）；M2 上下文 196,608（官方 204,800，旧口径）。

### 7.3 表 B：缓存语义与能力

| model                             | promptCacheMinTokens                | cacheTtl（cacheTtlOptions）    | storagePricePer1mHour | supports 摘要                                                                                             | tieredPricing 摘要                                                                           | sourceUrl     | dataVerifiedAt | 备注/收录判定                                     |
| --------------------------------- | ----------------------------------- | ------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------- | -------------- | ------------------------------------------------- |
| MiniMax-M3                        | 512（被动）                         | 5m（被动未公布；主动轨不适用） | —                     | R— CC✘（**M3 不支持主动缓存**） PK✘ IM✔（被动自动） RE✔（Interleaved Thinking） V✔（image_url/video_url） | >512K 档：minTokens 512000、maxTokens null，input 2x / output 2x / read 2x（含缓存命中部分） | pricing-paygo | 2026-08-03     | P0 转录（双币种）；**永久五折现行价**；仅被动缓存 |
| MiniMax-M2.7                      | 512（被动）                         | 5m（主动轨）                   | —                     | CC✔（4 断点/20 回溯） IM✔（被动 20%） PK✘ RE✔                                                             | 无                                                                                           | 同上          | 2026-08-03     | P0 转录（双币种）；主动+被动                      |
| MiniMax-M2.7-highspeed            | 512                                 | 5m                             | —                     | 同 M2.7                                                                                                   | 无（**速度变体非 tiered，独立条目**）                                                        | 同上          | 2026-08-03     | P0 转录；读/写价与基础版相同                      |
| MiniMax-M2.5 / M2.1（+highspeed） | 512                                 | 5m                             | —                     | CC✔ IM✔（被动 10%）                                                                                       | 无                                                                                           | 同上          | 2026-08-03     | P1（历史档）                                      |
| MiniMax-M2                        | 512（被动列表不含 M2 → 被动不适用） | 5m                             | —                     | CC✔（**仅主动**） IM✘                                                                                     | 无                                                                                           | 同上          | 2026-08-03     | P1（历史档）                                      |
| M2-her                            | —                                   | —                              | —                     | 对话/角色扮演专用（独立接口）                                                                             | 无                                                                                           | 同上          | 2026-08-03     | 价格 unavailable；不转录                          |

> 被动缓存：前缀匹配顺序「工具定义 → 系统提示词 → 历史对话内容」，任意模块内容变更都可能影响命中；最低 ≥512 输入 token；写入无额外计费；过期随系统负载自动调整。主动缓存：`cache_control {"type":"ephemeral"}` 最多 4 断点、20 块回溯、TTL 5 分钟、写入 1.25x；thinking 块不可直接标记；M2.7/M2.5/M2.1 支持主动+被动，M2 仅主动，M3 仅被动。

### 7.4 缺项清单

1. **M2-her 价格未获取**：按量计费页未收录（走 text-chat 接口，非 chat-completions 计费体系）。
2. **输出上限官方未公布**：仅 models.dev 口径（M3 128,000 / M2.7、M2.5、M2.1 及 highspeed 131,072 / M2 128,000）。
3. **主动缓存页 highspeed 输入价冲突**：Anthropic 兼容缓存页列 M2.7-highspeed 输入 2.1 元，按量计费页为 4.2 元（USD $0.60 印证）——**以按量计费页为准**，主动缓存页疑为旧值。
4. **被动缓存 TTL**：官方未公布（「随系统负载自动调整」）。
5. **M2.5.1 不存在**：官方清单 / models.dev / GitHub 均无（开源权重为 M2.5 与 M2.5-Lightning 两版，后者 = 平台 highspeed）。
6. 历史模型 M1（2025-06-16，推理模型）已不在官方支持模型表。

### 7.5 转录建议

- 双币种条目（provider=minimaxi / minimax-io）；M3 写免费三件套（0 + true，仅被动）；M2.x 有写价（`cacheWritePrice: 2.625` CNY / `0.375` USD，`cacheWriteFree: false`）。
- MiniMax 的「1h 窗口」语义**不落** `cacheWritePrice1h`（用 `cacheWritePrice` + `cacheTtl` 表达，schema §2 C 组）。
- highspeed 为独立条目（速度变体不得建模为 tiered）；M3 长档 tiered `minTokens: 512000`。
- 00-catalog §7 记录的 M3 4.20/0.84/16.80 为**原价**，迁移必须更新为五折现行价。
- M3 OpenAI 兼容接口需 `reasoning_split=True`（思考进 reasoning_details）或保留 `<think>` 标签，多轮必须完整回传 assistant 消息含 thinking 块。

---

## 8. Gemini Google（御十家 8/10）

> 概况：**31 条**（主表 13 在售/归档文本 + 变体 18 条，含非对话特化）；在售主对话 **11 条**；四指标完整 **18 条**（主表 12 + 变体 6，写免费语义）；币种 USD。
> 数据日期 2026-08-03。来源：Vertex AI 官方定价表 https://cloud.google.com/vertex-ai/generative-ai/pricing（Gemini API 与 Vertex 定价一致）｜ models.dev 交叉验证；**ai.google.dev 本次 4 次抓取均 transport error 未获取**（缓存机制沿用 vendor-cache-mechanisms.md §6 已确认条目）。
> 核心结论：命中价恒 = 未缓存输入价 **10%**；>200K 长上下文加价 2x **仅 Pro 档**（3.1 Pro / 3 Pro / 2.5 Pro，输入 2x/输出 1.5x，全 token 按长档计费）；显式缓存 = cachedContents API 独立资源（默认 TTL 1 小时、按「token × 时长」收存储费，无 Anthropic 式 cache_control）；隐式缓存默认启用（最低 4096（3.x）/ 2048（2.5））；别名：`gemini-flash-latest` → 3.5-flash、`gemini-flash-lite-latest` → 3.1-flash-lite。

### 8.1 表 A：在售主对话模型四指标价格（USD / 1M tokens；存储费 $/1M·h）

| model（API 名）                    | provider/vendor | currency | contextWindow | maxOutputTokens                | inputPrice（≤200K / >200K） | outputPrice（≤200K / >200K） | cacheReadPrice（≤200K / >200K） | cacheWritePrice | cacheWrite5m/1h | storagePricePer1mHour     | priceStatus |
| ---------------------------------- | --------------- | -------- | ------------- | ------------------------------ | --------------------------- | ---------------------------- | ------------------------------- | --------------- | --------------- | ------------------------- | ----------- |
| gemini-3.6-flash                   | google/google   | USD      | 1,048,576     | 65,536                         | 1.50（无加价）              | 7.50                         | 0.15                            | 0（写免费）     | —               | 未获取（R0 记 1.00 存疑） | official    |
| gemini-3.5-flash                   | google/google   | USD      | 1,048,576     | 65,536                         | 1.50                        | 9.00                         | 0.15                            | 0（写免费）     | —               | 未获取                    | official    |
| gemini-3.5-flash-lite              | google/google   | USD      | 1,048,576     | 65,536                         | 0.30                        | 2.50                         | 0.03                            | 0（写免费）     | —               | 未获取                    | official    |
| gemini-3.1-pro-preview             | google/google   | USD      | 1,048,576     | 65,536                         | 2.00 / 4.00                 | 12.00 / 18.00                | 0.20 / 0.40                     | 0（写免费）     | —               | 4.50                      | official    |
| gemini-3.1-pro-preview-customtools | google/google   | USD      | 1,048,576     | 65,536                         | 2.00 / 4.00                 | 12.00 / 18.00                | 0.20 / 0.40                     | 0（写免费）     | —               | 4.50                      | official    |
| gemini-3-pro-preview               | google/google   | USD      | 1,048,576     | 65,536                         | 2.00 / 4.00                 | 12.00 / 18.00                | 0.20 / 0.40                     | 0（写免费）     | —               | 4.50                      | official    |
| gemini-3-flash-preview             | google/google   | USD      | 1,048,576     | 65,536（models.dev 记 65,535） | 0.50                        | 3.00                         | 0.05                            | 0（写免费）     | —               | 1.00                      | official    |
| gemini-3.1-flash-lite              | google/google   | USD      | 1,048,576     | 65,536                         | 0.25                        | 1.50                         | 0.025                           | 0（写免费）     | —               | 1.00                      | official    |
| gemini-2.5-pro                     | google/google   | USD      | 1,048,576     | 65,536                         | 1.25 / 2.50                 | 10.00 / 15.00                | 0.13 / 0.25                     | 0（写免费）     | —               | 4.50                      | official    |
| gemini-2.5-flash                   | google/google   | USD      | 1,048,576     | 65,536                         | 0.30                        | 2.50                         | 0.03                            | 0（写免费）     | —               | 1.00                      | official    |
| gemini-2.5-flash-lite              | google/google   | USD      | 1,048,576     | 65,536                         | 0.10                        | 0.40                         | 0.01                            | 0（写免费）     | —               | 1.00                      | official    |

> 旧档归档（**已下线不转录**）：gemini-2.0-flash（1,048,576 / 8,192 输出，0.10 / 0.40 / 0.025）；gemini-2.0-flash-lite（0.075 / 0.30 / 命中价未获取）。音频输入价：3.6-flash / 3.5-flash $1.00（命中 $0.10）、3.1-flash-lite $0.50、2.5-flash $1.00、2.5-flash-lite $0.30。其他计费档：Priority ≈1.8x、Flex/Batch ≈0.5x（缓存价多数保留）、Non-global 端点 +10%、微调模型 ×1.5。

### 8.2 表 B：在售主对话模型缓存语义与能力

| model                              | promptCacheMinTokens | cacheTtl（cacheTtlOptions）         | storagePricePer1mHour | supports 摘要                                                                          | tieredPricing 摘要                                                                                         | sourceUrl         | dataVerifiedAt | 备注/收录判定                                  |
| ---------------------------------- | -------------------- | ----------------------------------- | --------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------- | -------------- | ---------------------------------------------- |
| gemini-3.6-flash                   | 4096（3.x 档）       | 1h（显式默认 TTL；隐式 TTL 未公布） | 未获取                | IM✔ CC✘（cachedContents 资源，非断点） PK✘ V✔ A✔ RE✔（effort minimal/low/medium/high） | 无（flash 系无长档加价）                                                                                   | vertex-ai pricing | 2026-08-03     | P0 转录；2026-07-21 发布；输出价低于 3.5-flash |
| gemini-3.5-flash                   | 4096                 | 1h                                  | 未获取                | 同 3.6-flash                                                                           | 无                                                                                                         | 同上              | 2026-08-03     | P0 转录；当前 flash 主力档                     |
| gemini-3.5-flash-lite              | 4096                 | 1h                                  | 未获取                | 同 3.6-flash                                                                           | 无                                                                                                         | 同上              | 2026-08-03     | P0 转录；低成本档                              |
| gemini-3.1-pro-preview             | 4096                 | 1h                                  | 4.50                  | IM✔ CC✘ PK✘ V✔ A✔ RE✔（low/medium/high）                                               | >200K 档：minTokens 200000、maxTokens null，input 4.00 / output 18.00 / read 0.40（2x/1.5x 全 token 计费） | 同上              | 2026-08-03     | P0 转录                                        |
| gemini-3.1-pro-preview-customtools | 4096                 | 1h                                  | 4.50                  | 同 3.1-pro（自定义工具变体）                                                           | 同 3.1-pro                                                                                                 | 同上              | 2026-08-03     | P1；专用变体，价格同源                         |
| gemini-3-pro-preview               | 4096                 | 1h                                  | 4.50                  | 同 3.1-pro（effort low/high）                                                          | 同 3.1-pro                                                                                                 | 同上              | 2026-08-03     | P0 转录；2025-11-18 发布                       |
| gemini-3-flash-preview             | 4096                 | 1h                                  | 1.00                  | IM✔ CC✘ V✔ A✔（音频 $1.00/命中 $0.10）                                                 | 无                                                                                                         | 同上              | 2026-08-03     | P0 转录；2025-12-17 发布                       |
| gemini-3.1-flash-lite              | 4096                 | 1h                                  | 1.00                  | IM✔ CC✘ V✔ A✔（音频 $0.50/命中 $0.05）                                                 | 无                                                                                                         | 同上              | 2026-08-03     | P0 转录；2026-05-07 发布                       |
| gemini-2.5-pro                     | 2048（2.5 档）       | 1h                                  | 4.50                  | IM✔ CC✘ V✔ A✔                                                                          | >200K 档：minTokens 200000，input 2.50 / output 15.00 / read 0.25                                          | 同上              | 2026-08-03     | P0 转录；稳定 GA 档                            |
| gemini-2.5-flash                   | 2048                 | 1h                                  | 1.00                  | IM✔ CC✘ V✔ A✔（音频 $1.00/命中 $0.10）                                                 | 无                                                                                                         | 同上              | 2026-08-03     | P0 转录                                        |
| gemini-2.5-flash-lite              | 2048                 | 1h                                  | 1.00                  | IM✔ CC✘ V✔ A✔（音频 $0.30/命中 $0.03）                                                 | 无                                                                                                         | 同上              | 2026-08-03     | P0 转录                                        |

> 缓存要点：隐式缓存 2.5 及更新默认启用（stateful previous_interaction_id 与 stateless 均支持），命中价 = 输入 × 10%，计量 `usage_metadata.total_cached_tokens`，best-effort 无成本节省保证；显式缓存 cachedContents API（contents + system_instruction + ttl，默认 TTL 1 小时，无最小/最大限制），存储费按「缓存 token 数 × 时长」计（$ / 1M·h），有成本节省保证；Interactions API 仅支持隐式缓存；无 Anthropic 式 cache_control 断点参数。

### 8.3 表 C：变体与特化模型（P1 备查；非通用对话标注）

| model | contextWindow | inputPrice | outputPrice | cacheReadPrice | 备注 | 收录判定 |
| --- | --- | --- | --- | --- | --- |
| gemini-omni-flash-preview | 131,072 | 1.50 | 文本 9.00；视频输出 $0.10/秒（$17.50/1M 视频 token） | 未获取 | 全模态（含视频输出）；输入按 2040 tok/图、32 tok/音频秒、5792 tok/视频秒折算 | P1 备查 |
| deep-research-preview-04-2026 | 131,072 | 2.00 | 12.00 | 0.20 | Deep Research Agent | P1 备查 |
| deep-research-max-preview-04-2026 | 131,072 | 2.00 | 12.00 | 0.20 | Deep Research Agent（max） | P1 备查 |
| CodeMender | — | 1.50 | —（未给） | 0.15 | gemini-3.5-flash 驱动的代码修复产品线；输出价未公布 | P1 备查（输出价缺） |
| gemini-3.1-flash-image（Nano Banana 2） | 65,536 | 0.50 | 文本 3.00；图像输出 $60 | 0.05 | 输入按 1120 tok/图 | P1 备查 |
| gemini-3.1-flash-lite-image（Nano Banana 2 Lite） | 65,536 | 0.25 | 文本 1.50；图像输出 $30 | 0.025 | 同上 | P1 备查 |
| gemini-3-pro-image（Nano Banana Pro） | 131,072 | 2.00 | 文本 12.00；图像输出 $120 | 0.20 | 输入按 560 tok/图 | P1 备查 |
| gemini-2.5-flash-image | 32,768 | 0.30 | 文本 2.50；图像输出 $30 | 0.075 | 旧图像档 | P1 备查 |
| gemini-3.1-flash-live-preview（Live API） | 131,072 | 0.75（音频 3.00） | 4.50 | 未获取 | 实时流式接口 | P1 备查 |
| gemini-3.1-flash-tts-preview | 8,192 | 1.00 | 20.00 | 未获取 | 语音合成（TTS，**非对话，不转录**） | 不转录 |
| gemini-2.5-pro-preview-tts | 8,192 | 1.00 | 20.00 | 未获取 | 语音合成（TTS） | 不转录 |
| gemini-2.5-pro-computer-use（Computer Use-Preview） | 131,072 | 1.25 | 10.00（>200K 15.00） | 未获取 | 同 2.5 Pro 价格 | P1 备查（read 缺） |
| gemini-robotics-er-1.6-preview | 131,072 | 1.00 | 5.00 | 未获取 | 机器人 ER 预览档（音频输入 $2.00） | P1 备查（read 缺） |
| gemini-3.5-live-translate-preview | 16,384 | 3.50 | 21.00 | 未获取 | 同传翻译 | P1 备查（read 缺） |
| gemini-embedding-2 / gemini-embedding-001 | 8,192 / 2,048 | 0.20 / 0.15 | — | — | 向量模型，无缓存（**Embedding，不转录**） | 不转录 |
| lyria-3-pro-preview / lyria-3-clip-preview | 1,048,576 | 价格未标注 | 价格未标注 | — | 音乐生成（**非对话，不转录**） | 不转录 |

### 8.4 缺项清单

1. **ai.google.dev/gemini-api/docs/pricing 与 /docs/models**：本次 4 次 webfetch 均 transport error；上表价格以 **Vertex AI 官方定价页**（Gemini API 同价）与 models.dev + OpenRouter 双重交叉验证为准。
2. **3.5 Flash / 3.6 Flash / 3.5 Flash-Lite 的显式缓存存储费**：Vertex 存储费表未列此三模型；R0 记「3.6 Flash $1.00/1M·h」来源为 ai.google.dev，本次无法复核——**保留存疑，待官方复核**。
3. **2.0-flash-lite 缓存命中价**：models.dev 未收录，官方定价页未逐项核对（该模型已归档不转录，不影响）。
4. **模型清单完整性**：models.dev google 厂商 41 条目（含 lyria/veo/Gemma 等非 Gemini 文本模型），已筛选；个别 preview（如 2.5-computer-use-preview-10-2025）无独立价格、按 2.5 Pro 计价已归并。
5. **上下文窗口与输出上限**：以 models.dev / OpenRouter 交叉一致值 1,048,576 / 65,536 为准（3-flash-preview 输出上限记录为 65,535）；官方定价页不公布窗口。
6. **lyria 系列价格**：官方页未列价。

### 8.5 转录建议

- P0 转录 11 条在售主对话（表 A）；`cacheReadPrice` = input × 10% 恒等可推导但按官方逐行值直填；写免费三件套。
- `storagePricePer1mHour`：Pro 档 4.50 / flash 档 1.00（3.5/3.6 flash 系未获取标 null + notes）。
- 长档 tiered `minTokens: 200000` 仅 Pro 档；flash 系不设。
- `promptCacheMinTokens`：3.x = 4096、2.5 = 2048；`cacheTtl: "1h"`（显式默认）；`supportsCacheControl: false`（无 Anthropic 式断点，显式走 cachedContents 资源）。
- 与 R0 目录差异修正：3.5 Flash 标准价 $1.50（R0 的 $0.75 实为 Flex/Batch 档）；3.1 Pro 标准价 $2.00（R0 的 $1.25 实为 2.5 Pro 价）。

---

## 9. DeepSeek（御十家 9/10）

> 概况：**在售 2 条**（deepseek-v4-flash / deepseek-v4-pro），**四指标完整 2 条**（写免费语义）；币种 USD。legacy 2 条（deepseek-chat / deepseek-reasoner）**已停用不转录**。
> 数据日期 2026-08-03。来源：官方定价页 https://api-docs.deepseek.com/quick_start/pricing ｜ 缓存文档 https://api-docs.deepseek.com/guides/kv_cache ｜ Responses 文档 https://api-docs.deepseek.com/guides/responses_api ｜ Change Log https://api-docs.deepseek.com/updates
> 核心结论：自动磁盘前缀缓存（**前缀单元制**，缓存写免费、无断点、无 TTL 管理）；命中价差全行业最大（flash 50 倍 / pro 120 倍）；峰谷定价「即将生效」（北京时间 9:00-12:00 / 14:00-18:00 全计费项 2x，生效日期待公告）；v4-pro 的 Responses API 官方计划 2026 年 8 月初加入（抓取日未上线）；deepseek-chat / deepseek-reasoner 已于 2026-07-24 停用。

### 9.1 表 A：四指标价格总表（USD / 1M tokens）

| model（API ID）   | provider/vendor   | currency | contextWindow | maxOutputTokens | inputPrice | outputPrice | cacheReadPrice                 | cacheWritePrice | cacheWrite5m/1h | priceStatus |
| ----------------- | ----------------- | -------- | ------------- | --------------- | ---------- | ----------- | ------------------------------ | --------------- | --------------- | ----------- |
| deepseek-v4-flash | deepseek/deepseek | USD      | 1,000,000     | 384,000         | 0.14       | 0.28        | 0.0028（2%，50 倍差价）        | 0（写免费）     | —               | official    |
| deepseek-v4-pro   | deepseek/deepseek | USD      | 1,000,000     | 384,000         | 0.435      | 0.87        | 0.003625（≈0.83%，120 倍差价） | 0（写免费）     | —               | official    |

> 备注：版本号 DeepSeek-V4-Flash-0731（public beta，2026-07-31 发布）/ DeepSeek-V4-Pro（2026-04-24）；`reasoningPrice`：v4-flash = 0.28（models.dev cost.reasoning，= 输出价；P5 记录不计算），v4-pro 未获取。并发：flash 2500 / pro 500。

### 9.2 表 B：缓存语义与能力

| model             | promptCacheMinTokens                              | cacheTtl（cacheTtlOptions）             | storagePricePer1mHour | supports 摘要                                                                                            | tieredPricing 摘要 | sourceUrl           | dataVerifiedAt | 备注/收录判定                                                               |
| ----------------- | ------------------------------------------------- | --------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------- | ------------------ | ------------------- | -------------- | --------------------------------------------------------------------------- |
| deepseek-v4-flash | 未公布（官方无数字；旧「64 token 块」表述已废弃） | 未公布（省略；schema 示例暂按 5m 兜底） | —                     | R✔（Responses 支持中） CC✘ PK✘（无状态参数静默忽略） IM✔（自动前缀单元） RE✔（toggle + effort high/max） | 无（1M 单档）      | quick_start/pricing | 2026-08-03     | P0 转录；peakPricing2x: true + schedule（effectiveFrom null）；写免费三件套 |
| deepseek-v4-pro   | 未公布                                            | 未公布                                  | —                     | R✘（2026 年 8 月初计划加入，**抓取日未上线**） CC✘ PK✘ IM✔ RE✔                                           | 无                 | 同上                | 2026-08-03     | P0 转录；peakPricing2x: true；supportsResponses 待 8 月中旬刷新翻转         |
| deepseek-chat     | —                                                 | —                                       | —                     | —                                                                                                        | —                  | —                   | 2026-07-24     | **已停用（2026-07-24）**，不转录；过渡期指向 v4-flash 非思考模式            |
| deepseek-reasoner | —                                                 | —                                       | —                     | —                                                                                                        | —                  | —                   | 2026-07-24     | **已停用（2026-07-24）**，不转录；过渡期指向 v4-flash 思考模式              |

> 缓存要点：磁盘缓存构建需数秒、数小时到数天内自动清除、best-effort 不保证 100%；**前缀单元制**——SWA 下以独立完整「缓存前缀单元」匹配，后续请求必须完整匹配某单元才能命中（不再逐 token 任意前缀）；三种持久化时机（请求边界 / 公共前缀检测 / 固定 token 间隔）；缓存只匹配输入前缀，输出按当前参数全新生成；无 cache_control / prompt_cache_key / prompt_cache_retention（静默忽略）；计量字段 Chat = `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（DeepSeek 专用），Responses = `usage.input_tokens_details.cached_tokens`。峰谷定价规则：高峰时段（北京时间 9:00-12:00、14:00-18:00）价格 2 倍，**适用于所有计费项**（输入/输出/缓存命中均含）。

### 9.3 缺项清单

1. **峰谷定价生效日期**：官方仍为「soon」+「生效日期待公告」，无法落值（peakPricingSchedule.effectiveFrom = null）。
2. **v4-pro Responses API 实际上线时间**：官方为「2026 年 8 月初」计划态，截至抓取日未上线；8 月内需再次刷新翻转 `supportsResponses`。
3. **最低可缓存 token 下限**：官方 kv_cache 文档无数字（旧「64 token 块」表述已废弃）。
4. **legacy 模型停用后调用行为**：changelog 仅预告停用，404 或报错语义未说明、未实测。
5. **每模型 RPM/TPM 限速明细**：只确认并发限制（flash 2500 / pro 500），速率限额属 rate_limit 文档域未抓。
6. **思考块缓存失效规则**：v4 系列是否随轮次保留思考块、有无失效条件，官方文档未提及（未确认）。
7. **DeepSeek-V4-Pro-Preview 细节**：changelog 提及同架构重后训练，但版本细节未公布（models.dev 亦无）。

### 9.4 转录建议

- 两条在售四指标完整、币种 USD、`cacheWritePrice: 0` + `cacheWriteFree: true` + `cacheType: "auto"` + `cacheMechanism: "disk_unit"`。
- `peakPricing2x: true` + `peakPricingSchedule {windows:["09:00-12:00","14:00-18:00"], tz:"Asia/Shanghai", effectiveFrom:null}`。
- legacy 模型名不可再用于新接入（存量配置需迁移到 v4-flash）。
- 命中价差 50x/120x 是全行业最大缓存杠杆，自动缓存零成本，只需保持前缀稳定。

---

## 10. Composer Cursor（御十家 10/10，不可直连）

> 概况：**现役 1 条**（composer-2.5，Standard / Fast 两档）；**四指标完整 0 条**（cache_read/cache_write 单价官方未公开）；币种 USD；**无独立第三方 API**。
> 数据日期 2026-08-03。来源：官方定价与模型文档 https://cursor.com/docs/models-and-pricing ｜ Composer 2.5 模型页 https://cursor.com/docs/models/cursor-composer-2-5 ｜ SDK 文档 https://cursor.com/docs/sdk/typescript ｜ 发布公告 https://cursor.com/blog/composer-2-5
> 核心结论：**composer 2.5 不是 OpenAI 模型**（三方交叉排除），是 Cursor（Anysphere）自研编程模型线，基于 Moonshot Kimi K2.5 开源权重继续预训练 + RL；**仅 Cursor 生态内可用**（IDE/Web/CLI/移动端/Cursor SDK），不开放独立 API；定价形态 =「订阅额度池（Generous included usage，官方未公布数字）+ on-demand 按量」双轨；SDK 是 agent SDK 而非 chat-completions API；Composer 2 已退役（请求自动重路由到 2.5）；上下文窗口官方未公布（社区口径固定 200K、Max Mode 不可扩展）。

### 10.1 表 A：模型规格与按量费率（USD / 1M tokens）

| model（官方 ID）               | provider/vendor | currency | contextWindow                                | maxOutputTokens | inputPrice | outputPrice | cacheReadPrice | cacheWritePrice | cacheWrite5m/1h | priceStatus                 |
| ------------------------------ | --------------- | -------- | -------------------------------------------- | --------------- | ---------- | ----------- | -------------- | --------------- | --------------- | --------------------------- |
| composer-2.5（Standard）       | cursor/cursor   | USD      | 官方未公布（社区口径 200,000，未经官方确认） | 未获取          | 0.50       | 2.50        | 未公开         | 未公开          | 未公开          | official（仅 input/output） |
| composer-2.5（Fast，产品默认） | cursor/cursor   | USD      | 同左                                         | 未获取          | 3.00       | 15.00       | 未公开         | 未公开          | 未公开          | official（仅 input/output） |

> 版本演进：Composer 1（2025-10-29，自研基座）→ 1.5（2026-02-09）→ 2（2026-03-19，**已退役**，SDK 认证时自动重路由到 2.5）→ **2.5（2026-05-18，现役）**。基座 = Moonshot Kimi K2.5 开源 checkpoint（1T MoE）；推理由 Cursor 自托管（Fireworks/Colfax 合作），**不经 Moonshot API，Moonshot 缓存价/命中率/TTL 语义不成立**。Cursor Models 池（Composer 2.5 + Grok 4.5）订阅内「慷慨用量」不按 token 计费；超量 on-demand 按上表费率后付结算；Cursor Token Rate（Teams/Enterprise 第三方模型 +$0.25/M）对第一方 Cursor 模型豁免。

### 10.2 表 B：缓存语义与能力

| model        | promptCacheMinTokens | cacheTtl（cacheTtlOptions） | storagePricePer1mHour | supports 摘要                                                                                                                                                     | tieredPricing 摘要 | sourceUrl                                  | dataVerifiedAt | 备注/收录判定                                                                                       |
| ------------ | -------------------- | --------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------ | -------------- | --------------------------------------------------------------------------------------------------- |
| composer-2.5 | 未公开               | 未公开                      | —                     | 平台层缓存计量存在（SDK TokenUsage.cacheReadTokens/cacheWriteTokens、定价政策 Total Tokens 含 cache read/write），但 **Composer 缓存单价/TTL/最低前缀官方未公开** | 无                 | cursor.com/docs/models/cursor-composer-2-5 | 2026-08-03     | 转录为「Cursor 生态内模型」+ **不可直连**标记；订阅额度池内缓存无成本概念，on-demand 段缓存计价不明 |

> 能力与特化：coding 特化（两阶段训练：K2.5 继续预训练 + Cursor 真实会话 RL）；effort 自动校准（按任务复杂度调节工作量）；fast 档产品默认；实时 RL 管线（每日可多次发布改进 checkpoint → **版本漂移风险**，目录条目时效性需注意）；基准（官方自报）：CursorBench 3.2 56.1%（$0.44/任务、14,286 tokens、33 步）、Terminal-Bench 2.0 69.3%、SWE-bench Multilingual 79.8%。

### 10.3 缺项清单

1. **上下文窗口官方数字**：官方文档/博客均未公布；仅论坛社区口径 200K 固定（Max Mode 不可扩展）；llmreference.com 声称 1M 与基座/论坛矛盾，判定不可信不采信。
2. **Composer 缓存单价（cache_read / cache_write）**：官方未公开；额度池内无缓存价概念，on-demand 段缓存计价方式不明。
3. **缓存 TTL / 最低前缀 / 缓存开关参数**：Cursor 平台未披露（仅 SDK 计量字段存在）。
4. **「Generous included usage」额度数字**：官方只写「generous」，无 token/美元数字。
5. **输出上限（max output tokens）**：官方未公布。
6. **实际 API 端点 / API base**：官方未公开（仅能确认非 Moonshot API、自托管）。
7. **Composer 1 / 1.5 定价**：无官方定价记录（早期为请求制/池内）。

### 10.4 转录建议

- 厂商归属：独立厂商 **Cursor（Anysphere）**，不并入 Moonshot/Kimi、不并入 OpenAI。
- 收录形态：「Cursor 生态内模型」`composer-2.5`（fast 变体作参数 `{id:"fast", value:"true"}` 或独立档），计费语义 = 订阅额度池 + on-demand，**不要**按通用 API 四指标建模（cache 两价未公开）。
- `contextWindow` 缺省不可写死；若必须落值标注「社区口径 200,000，未经官方确认」或留空由 R3 实测。
- 可用性：仅 Cursor 订阅内可用（IDE/Web/CLI/mobile/SDK），**无独立第三方 API → 标记不可直连**；若本专项目录用于「可接入代理的 API 模型」，Composer 应排除在可直连列表之外。

---

## 11. 次要厂商存档（豆包 / ERNIE，仅存档不转录）

> 用户指示：**ERNIE 忽略、豆包无需在意**——本节仅存档 R1 调研要点，**不进入 R3 转录范围**（如需转录须另行裁决）。转售通道价（方舟/千帆转售 GLM、DeepSeek 等）与官方直连口径差异巨大，禁止并入官方条目。

### 11.1 豆包（火山方舟 Volcengine Ark，CNY）

> 数据日期 2026-08-03。来源：官方模型价格页 https://docs.volcengine.com/docs/82379/1544106 ｜ 模型列表页 https://docs.volcengine.com/docs/82379/1330310 ｜ 缓存文档 https://docs.volcengine.com/docs/82379/1398933 ｜ 计费说明 https://docs.volcengine.com/docs/82379/1544681

**自研大语言模型 26 条目**（在售/下线预告），现行主力：

| 模型                              | API ID                              | 上下文 | input / cache_read / output（¥/1M） | 备注                                    |
| --------------------------------- | ----------------------------------- | ------ | ----------------------------------- | --------------------------------------- |
| doubao-seed-evolving              | doubao-seed-evolving                | 1024k  | 6.00 / 1.20 / 30.00                 | 快速迭代模型；单档                      |
| doubao-seed-2.1-pro               | doubao-seed-2-1-pro-260628          | 256k   | 6.00 / 1.20 / 30.00                 | 单档 [0,256]；思维链 256k               |
| doubao-seed-2.1-turbo             | doubao-seed-2-1-turbo-260628        | 256k   | 3.00 / 0.60 / 15.00                 | 单档；低延迟档 = 常规 2x                |
| doubao-seed-2.0-pro / lite / mini | -2-0-pro-260215 等                  | 256k   | 3.2/4.8/9.6 等三档；命中 20%        | 分段 [0,32]/(32,128]/(128,256] 千 token |
| doubao-seed-2.0-code              | doubao-seed-2-0-code-preview-260215 | 256k   | 同 2.0-pro                          |                                         |
| doubao-seed-1.8 / 1.6 系          | -1-8-251228 等                      | 256k   | 命中价恒 0.16/0.06/0.03             | **即将下线**                            |

转售第三方 8 条：glm-5.2（8.00/2.00/28.00，命中 25%）、glm-4.7（2.0-4.0 三档，**即将下线**）、deepseek-v4-pro（12.00/1.00/24.00，**官方直连 $0.435，转售溢价约 4 倍**）、deepseek-v4-flash（1.00/0.20/2.00）、deepseek-v3.2/v3.1/v3/r1（**即将下线**）。

缓存要点：双轨（隐式透明前缀缓存：最低 **1024 tokens**、命中 = 输入价 20%（批量 40%）、存储不计费、不可关闭；显式 Session/前缀缓存：最低 256、存储费 **0.017 元/百万 token/小时**、TTL 最长 7 天）；计费公式 = 输入 + 命中 + 存储费（按自然小时最大 token 数）+ 输出；命中准实时出账（5 分钟级）。非对话模型（seedance 视频 / seedream 图片 / seed3d / embedding / 语音）不列。

**存档结论（不转录）**：现行主力为 seed-evolving / 2.1-pro / 2.1-turbo（单档 256K 优于 2.0 系分段）；如需转录注意命中折扣（在线 20% / 批量 40%）、存储费 0.017、转售通道价与官方直连差异（deepseek read 价差量级大）。

### 11.2 ERNIE（百度千帆，CNY）

> 数据日期 2026-08-03。来源：模型服务计费页 https://cloud.baidu.com/doc/qianfan/s/wmh4sv6ya（2026-07-13 更新）｜ 模型列表页 https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j ｜ Anthropic 兼容公告 empm33i0q

**ERNIE 自研 12 条 + 转售 13 条**，要点：

| 模型                                      | 上下文     | 输入 / 输出（¥/1M）                         | 命中缓存        | 备注                       |
| ----------------------------------------- | ---------- | ------------------------------------------- | --------------- | -------------------------- |
| ernie-5.1                                 | 128k       | ≤32k: 4.00 / 18.00；32k~128k: 6.00 / 22.00  | **无该子项**    | 最新旗舰（2026-07 更新）   |
| ernie-5.0（+thinking-preview/latest/exp） | 128k       | ≤32k: 6.00 / 24.00；32k~128k: 10.00 / 40.00 | 无该子项        | 全模态原生                 |
| ernie-4.5-turbo-32k / 128k / 20260402     | 32k / 128k | 0.80 / 3.20                                 | **0.20（25%）** | 唯一有命中缓存子项的自研系 |
| ernie-4.5-turbo-vl（+vl-32k）             | 128k / 32k | 3.00 / 9.00                                 | 0.75（25%）     | 视觉理解                   |
| ernie-x1.1（+preview）                    | 64k        | 1.00 / 4.00                                 | 无该子项        | 深度思考；思维链上限 64k   |

转售 13 条：deepseek-v4-pro（12.00/1.00/24.00）、deepseek-v4-flash（1.00/0.20/2.00）、deepseek-v3.2(-think)、glm-5.2（8.00/2.00/28.00，25%）、glm-5.1、glm-5、kimi-k2.6（6.50/1.10/27.00，≈16.9%）、qwen3.5-397b-a17b / 122b-a10b / 27b / 35b-a3b（深度思考类目）、internvl3-38b。

缓存要点：自动上下文缓存存在；命中折扣因模型而异（4.5-Turbo 25% / v4-flash 20% / glm-5.2 25% / kimi-k2.6 ≈16.9%）；全系无 cache_write 子项（写免费）；Anthropic 兼容端点返回 `cache_read_input_tokens`（2026-06-01 起 `input_tokens = prompt_tokens - cache_read_input_tokens`）；**ERNIE 5.x / X1.1 无命中缓存价目**（官方未给折扣，成本计算须保守按无缓存折扣处理）；Responses API 支持 deepseek/glm/qwen 系、**不含 ERNIE**；cache_control 断点支持未确认；最低缓存 token / TTL 官方未公布。

**存档结论（不转录）**：ERNIE 自研仅 4.5-Turbo 系有缓存折扣；千帆转售命中折扣远不如官方直连（v4-flash ¥0.2 vs 官方 $0.0028≈¥0.02，约 10 倍）；若本项目接入千帆通道须按 provider=qianfan 建独立条目。

---

## 12. 完整性检查表（每厂商统计与缺项清单）

> 统计口径：条目数 = 本表收录行（含双币种条目、旧轨/特化备查行、unavailable 行；已下线行仅标注不计数）；「四指标完整」= input/output/cacheRead/cacheWrite 齐全（写免费 = 0 + cacheWriteFree:true 视为完整；Anthropic 双档 5m/1h 有值；Qwen 推导价计完整）；缺项逐条列出，不编造。

### 12.1 汇总表（御十家）

| 厂商      | 条目数                                             | 四指标完整             | 币种      | 现行转录建议                                                                           | 缺项要点                                                                                                                                                                              |
| --------- | -------------------------------------------------- | ---------------------- | --------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI    | 40（16 现行/特化 + 24 旧轨；alias gpt-5.6 备注）   | 29                     | USD       | P0 12 条现行                                                                           | 5.4-cyber 价格未公布；pro 档 read 语义未明确；旧轨最低缓存前缀未逐模型公布；5.4-mini/nano/chat-latest 24h 存疑；5.5-pro Batch 冲突；5.1-codex×3/5-codex 未上定价页；o 系/4.x 窗口未抓 |
| Anthropic | 17                                                 | 16                     | USD       | P0 11 条现役                                                                           | Mythos Preview 价格 unavailable；Opus 4/Sonnet 4/Haiku 3.5 窗口（退役）；Bedrock/GCloud 平台价；TPM/RPM                                                                               |
| Kimi      | 11（现行 5 + V1 6；moonshot-v1-auto 未确认不计数） | 5                      | CNY       | P0 4 条现行                                                                            | V1 命中价未确认；moonshot-v1-auto 状态；K3 1M 分段价未提及；TTL/命中率未公布；k2.5/V1 下线后行为                                                                                      |
| GLM       | 34（USD 20 + CNY 14）                              | 32                     | USD + CNY | P0 14 条（主力 5 文本 × 2 币种 + 5V-Turbo/4.6V 视觉 × 2 币种）；免费档与 4.6/4.5 系 P1 | cache_control 未实测；Responses 大概率不支持；4.5-X/AirX 与 4.5V 窗口未确认；最低缓存未标注（参考 512）；存储费恢复价与 4.5-Air 5 折恢复价未获取；4-32B/OCR cache_read 缺             |
| Qwen      | 23（19 文本 + 4 VL）                               | 21                     | CNY       | P0：qwen3.8-max / 3.7-max / 3.7-plus / 3.7-flash / coder-plus                          | 官方绝对缓存价未公布（全系推导 ※）；max-preview 缓存价未给；omni-plus 百炼价待控制台；限时折扣到期日未标；maxOutputTokens 未公布                                                      |
| Grok      | 6                                                  | 6                      | USD       | P0 3 条（4.5/4.3/build）+ P1 3 条                                                      | 最低缓存 token 未公布；TTL 未公布；写免费为推断；输出上限官方未公布（models.dev 口径）；multi-agent 限制                                                                              |
| MiniMax   | 18（CNY 9 + USD 9）                                | 16（8+8）              | CNY + USD | P0：M3 / M2.7（+highspeed）双币种                                                      | M2-her 价格 unavailable；输出上限官方未公布；主动缓存页 highspeed 输入价冲突（以按量计费页为准）；被动 TTL 未公布                                                                     |
| Gemini    | 31（主表 13 + 变体 18）                            | 18（主表 12 + 变体 6） | USD       | P0 11 条在售主对话                                                                     | ai.google.dev 不可达；3.5/3.6 flash 存储费未获取（R0 1.00 存疑）；2.0-flash-lite 命中价未核对；lyria 无价；preview 输出上限 models.dev 口径                                           |
| DeepSeek  | 2（+legacy 2 不计数）                              | 2                      | USD       | P0 2 条                                                                                | 峰谷生效日期待公告；v4-pro Responses 未上线（8 月初计划）；最低缓存下限未公布；legacy 停用行为未实测；思考块失效规则未确认                                                            |
| Composer  | 1（现役；历史 3 代标注）                           | 0                      | USD       | 存档/不可直连                                                                          | 上下文官方数字缺失（社区 200K）；缓存两价未公开；TTL/最低前缀未披露；额度数字未公布；输出上限未公布；推理端点未公开                                                                   |
| **合计**  | **183**                                            | **145**                | —         | —                                                                                      | 详见各厂商缺项清单                                                                                                                                                                    |

### 12.2 次要厂商（存档不转录）

| 厂商          | 条目数                  | 四指标完整                                 | 币种 | 备注                                           |
| ------------- | ----------------------- | ------------------------------------------ | ---- | ---------------------------------------------- |
| 豆包（方舟）  | 34（自研 26 + 转售 8）  | ≈24（translation / 1.5-vision-pro 无缓存） | CNY  | 用户指示无需在意；存储费 0.017；命中 20%/40%   |
| ERNIE（千帆） | 25（自研 12 + 转售 13） | 按条计（5.x/X1.1 无命中价目）              | CNY  | 用户指示忽略；4.5-Turbo 系唯一有命中折扣的自研 |

### 12.3 全局缺口汇总（跨厂商共性，R3 需标注或实测）

1. **写免费推断**：Grok（官方无写价列，推断）——notes 标注；其余写免费均为官方结构确认。
2. **推导价**：Qwen 全系（官方只给比例）——`priceStatus: "derived"` + `derivation`。
3. **TTL 未公布**：Kimi / GLM / Grok / DeepSeek / Composer —— cacheTtl 省略，TTL 路由按 vendor 默认兜底。
4. **最低缓存未公布**：Grok / DeepSeek / GLM（参考百炼 512）/ Qwen 隐式（256）——省略或参考值 + notes。
5. **官方窗口缺失**：OpenAI o 系/4.x、Grok 输出上限、MiniMax 输出上限、Composer 上下文、Gemini lyria——models.dev 口径仅参考。
6. **登录墙未获取**：Qwen 控制台单模型缓存价、豆包控制台账单、千帆控制台——官方绝对价需登录核对。
7. **存疑待复核**：OpenAI 5.5-pro Batch、Gemini 3.6-flash 存储费、MiniMax 主动缓存页 highspeed 输入价、GLM 运营接口旧表。

---

## 13. 转录优先级建议

### 13.1 P0 必转录（现行主力对话模型，御十家全量核心）

| 厂商      | 条数 | 条目                                                                                                                                                                                                    |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI    | 12   | gpt-5.6-sol / terra / luna、gpt-5.5、gpt-5.5-pro、gpt-5.4、gpt-5.4-mini、gpt-5.4-nano、gpt-5.4-pro、gpt-5.3-codex、chat-latest、codex-mini-latest                                                       |
| Anthropic | 11   | claude-fable-5、claude-mythos-5、claude-opus-5、claude-opus-4-8、claude-opus-4-7、claude-opus-4-6、claude-opus-4-5、claude-sonnet-5、claude-sonnet-4-6、claude-sonnet-4-5、claude-haiku-4-5             |
| Kimi      | 4    | kimi-k3、kimi-k2.7-code、kimi-k2.7-code-highspeed、kimi-k2.6                                                                                                                                            |
| GLM       | 14   | USD 站：GLM-5.2 / 5.1 / 5 / 5-Turbo / 4.7（5 条）+ CNY 站同 5 条（provider=bigmodel）；视觉 5V-Turbo（USD+CNY）、4.6V（USD+CNY）按多模态 Agent 场景必需收录；免费档（4.7-Flash 等）与 4.6/4.5 系列入 P1 |
| Qwen      | 5+   | qwen3.8-max、qwen3.7-max、qwen3.7-plus、qwen3.7-flash、qwen3-coder-plus（其余 18 条 P1 全量转录建议）                                                                                                   |
| Grok      | 3    | grok-4.5、grok-4.3、grok-build-0.1                                                                                                                                                                      |
| MiniMax   | 6    | MiniMax-M3、MiniMax-M2.7、MiniMax-M2.7-highspeed（3 模型 × 双币种各 1 条）                                                                                                                              |
| Gemini    | 11   | gemini-3.6-flash、3.5-flash、3.5-flash-lite、3.1-pro-preview、3-pro-preview、3-flash-preview、3.1-flash-lite、2.5-pro、2.5-flash、2.5-flash-lite（customtools 并入 P1）                                 |
| DeepSeek  | 2    | deepseek-v4-flash、deepseek-v4-pro                                                                                                                                                                      |
| Composer  | 1    | composer-2.5（**不可直连**标记，存档级转录）                                                                                                                                                            |

### 13.2 P1 备查转录（旧轨 / 特化 / preview，按需）

- OpenAI 旧轨 24 条（表 C：5.2 系 / 5.1 / 5 系 / o 系 / 4.1 / 4o，四指标完整 16 条）+ gpt-5.5-cyber / gpt-5-search-api 特化。
- Gemini 变体：3.1-pro-preview-customtools、deep-research×2、image 系×4、2.5-pro-computer-use、live-preview、robotics、live-translate（read 缺失条目以 null + notes 落值）。
- Qwen 其余 18 条（3.6/3.5 系、VL 系、旧商业版）。
- MiniMax M2.5 / M2.1 / M2（含 highspeed）、GLM 4.6/4.5 系、Grok 4.20 三档。
- Claude mythos-preview（`priceStatus: "unavailable"`）。

### 13.3 P2 仅存档不转录（次要厂商）

- **豆包（方舟）**、**ERNIE（千帆）**：用户指示不作为重点；如需接入须按 provider=volcengine/qianfan 建独立条目，与官方直连价严格隔离。

### 13.4 明确不转录清单（已下线 / 非对话 / 未获取）

1. **已下线**：deepseek-chat / deepseek-reasoner（2026-07-24 停用）；moonshot-v1 全系与 kimi-k2.5（2026-08-31 全平台下线）；gemini-2.0-flash / 2.0-flash-lite（旧档归档）；gpt-5.3-chat-latest（弃用）；claude-opus-4-1（2026-08-05 退役）/ claude-opus-4-0 / claude-sonnet-4-0 / claude-3-5-haiku-20241022；GLM-4.5-Flash（即将下线）；豆包 1.8/1.6/1.5 系与转售 v3 系（即将下线）。
2. **非对话模型**：TTS（gemini-3.1-flash-tts-preview 等）、Embedding（gemini-embedding-2/001、qwen2.5-vl-embedding、doubao-embedding）、3D / 视频 / 图像 / 音乐（seedance、seedream、seed3d、lyria、xAI imagine/voice）。
3. **未获取价格**：gpt-5.4-cyber、gpt-5.1-codex×3 / gpt-5-codex、M2-her、claude-mythos-preview、lyria 系（可存档为 `priceStatus: "unavailable"` 备查）。
4. **非官方 ID 不收录**：OpenRouter `gpt-5.6-*-pro` 网关 slug（官方 `reasoning.mode:"pro"` 表达）；models.dev 独有 gpt-5.5-instant（未核实）；moonshot-v1-auto（遗留别名未确认）；qwen3-coder-ultra / codex-1/2/3 / composer 并入 OpenAI（均不存在或归属错误）。

### 13.5 R3 落地红线提醒

1. **唯一数据源**：R3 转录一律以本表为据；本表与 R1 文档冲突时以本表（R2 汇总口径）为准并向调度者报告。
2. **写价三态互斥**（schema §9.1）：写免费 = `0` + `true`；有写价 >0 + `false`；未获取 = null + `unavailable`。
3. **禁止 0 占位**：价格未获取一律 null + priceStatus 标注（schema §9.2）。
4. **tieredPricing 约束**：区间不得重叠；长上下文档 2x 档 = 仅 minTokens 半开无上界档；highspeed 变体不得建模为 tiered（独立条目）。
5. **双币种双条目**：GLM（zai/bigmodel）、MiniMax（minimaxi/minimax-io）不合并；转售通道价不并入官方条目。
6. **能力位保守缺省 false**；`supportsCacheControl` 未实测厂商一律 false（GLM 等）。
7. **dataVerifiedAt 全部 2026-08-03**；`cacheTtl:"30m"` 为 v2 值域新档（ttl.rs CacheTtl 需扩第四档）；`cacheType:"automatic"` 更名 `"auto"`（behavior.rs 匹配串同步改）。
8. **促销/退役日期入生命周期字段**：Sonnet 5（promoExpiresAt 2026-08-31 / promoReplacesAt 2026-09-01）、GLM 存储费 free until 2026-08-31、GLM-4.5-Air 5 折、qwen3.7-max 5 折、qwen3.7-plus 8 折、MiniMax M3 永久五折（无到期）。
9. **待刷新项**：DeepSeek v4-pro `supportsResponses`（2026 年 8 月初计划）、Gemini 3.5/3.6 flash 存储费、GLM 存储费恢复价（9/1 前）、豆包/千帆如需接入。

---

> 本文档为 R2 汇总终稿，全部数字可回溯至 R1 各厂商调研文档（见 §0 输入清单）与官方来源 URL。未获取项一律显式标注，未编造任何数字。
