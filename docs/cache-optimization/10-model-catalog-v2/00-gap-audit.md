# 模型目录与定价 v2：R0 缺口盘点审计（Gap Audit）

> 专项：「模型目录与定价 v2」　|　轮次：R0 盘点　|　盘点日期：2026-08-03
> 数据基准：`crates/agent-provider/src/models/catalog.json`（28 条内置目录，2026-08-02 转录）；
> 权威文档：`docs/cache-optimization/00-vendor-model-pricing-catalog.md`（下称 **00-catalog**，§x.x 引用）；
> 机制参考：`docs/cache-optimization/01-reference-research/vendor-cache-mechanisms.md`（下称 **机制文档**）；
> 历史纠正：`docs/cache-optimization/90-final/R0.5-model-era-audit.md`（下称 **R0.5 审计**）；
> 行为矩阵：`crates/agent-provider/src/models/behavior.rs`；前端费率表：`apps/crish-desktop/src/api/pricingStore.ts`。
> 产出用途：为 R1 各厂商调研派单定靶（第 5 节任务书要点）。

## 0. 审计口径约定

- **四指标** = input（未缓存输入价）/ output（输出价）/ cacheRead（缓存命中价）/ cacheWrite（缓存写入价）。
- 写价形态分三种：`cacheWritePrice`（通用写价，OpenAI GPT-5.6+ / MiniMax 主动轨）、
  `cacheWritePrice5m` + `cacheWritePrice1h`（Anthropic 双档）、写免费（`cacheWriteFree: true` 或无写价字段，DeepSeek / Kimi / Grok / GLM / Gemini / MiniMax M3 / OpenAI 旧轨）。
- 「完整四指标」判定：input、output、cacheRead、cacheWrite 四者皆有明确值；写价为 `0.0` 或显式 `cacheWriteFree: true` 视为「有写价语义」而非「缺字段」。
- 价格币种以条目 `currency` 字段为准（USD/CNY），单位统一 `per_1M`。
- 诚实边界：本盘点只复核已有文档与目录的转录关系；未获取的官方数字一律标「待 R1 调研」，不编造。

---

## 1. 现有 28 条逐条清单

数据来源：实读 `catalog.json` 全量（2026-08-03）。价格单位 per_1M tokens，币种见条目。

| #   | 目录键（vendor::model）       | 厂商                   | input  | output | cacheRead | cacheWrite                       | 币种 | 四指标                        |
| --- | ----------------------------- | ---------------------- | ------ | ------ | --------- | -------------------------------- | ---- | ----------------------------- |
| 1   | deepseek::deepseek-v4-flash   | DeepSeek               | 0.14   | 0.28   | 0.0028    | 0.0（写免费，cacheWriteFree）    | USD  | **完整**（写=0）              |
| 2   | deepseek::deepseek-v4-pro     | DeepSeek               | 0.435  | 0.87   | 0.003625  | 0.0（写免费，cacheWriteFree）    | USD  | **完整**（写=0）              |
| 3   | anthropic::claude-fable-5     | Anthropic              | 10.0   | 50.0   | 1.0       | 5m 12.5 / 1h 20.0                | USD  | **完整**（双档）              |
| 4   | anthropic::claude-mythos-5    | Anthropic              | 10.0   | 50.0   | 1.0       | 5m 12.5 / 1h 20.0                | USD  | **完整**（双档）              |
| 5   | anthropic::claude-opus-5      | Anthropic              | 5.0    | 25.0   | 0.5       | 5m 6.25 / 1h 10.0                | USD  | **完整**（双档）              |
| 6   | anthropic::claude-opus-4-5    | Anthropic              | 5.0    | 25.0   | 0.5       | 5m 6.25 / 1h 10.0                | USD  | **完整**（双档）              |
| 7   | anthropic::claude-sonnet-5    | Anthropic              | 2.0    | 10.0   | 0.2       | 5m 2.5 / 1h 4.0                  | USD  | **完整**（双档，促销价钉死）  |
| 8   | anthropic::claude-sonnet-4-5  | Anthropic              | 3.0    | 15.0   | 0.3       | 5m 3.75 / 1h 6.0                 | USD  | **完整**（双档）              |
| 9   | anthropic::claude-haiku-4-5   | Anthropic              | 1.0    | 5.0    | 0.1       | 5m 1.25 / 1h 2.0                 | USD  | **完整**（双档）              |
| 10  | openai::gpt-5.6               | OpenAI                 | 5.0    | **缺** | 0.5       | 6.25（1.25x）                    | USD  | 3/4（**缺 output**）          |
| 11  | openai::gpt-5.5               | OpenAI                 | 5.0    | **缺** | 0.5       | 写免费（cacheWriteFree）         | USD  | 2/4（缺 output + 无写价字段） |
| 12  | kimi::kimi-k3                 | Kimi                   | 20.0   | 100.0  | 2.0       | 写免费（cacheWriteFree）         | CNY  | 3/4（无写价字段）             |
| 13  | grok::grok-4.5                | Grok                   | 2.0    | 6.0    | 0.3       | 写免费（无写价字段）             | USD  | 3/4（无写价字段）             |
| 14  | grok::grok-4.3                | Grok                   | 1.25   | 2.5    | 0.2       | 写免费（无写价字段）             | USD  | 3/4（无写价字段）             |
| 15  | minimax::minimax-m2-7         | MiniMax                | 2.1    | 8.4    | 0.42      | 2.625（1.25x）                   | CNY  | **完整**                      |
| 16  | minimax::minimax-m2-5         | MiniMax                | 2.1    | 8.4    | 0.21      | 2.625（1.25x）                   | CNY  | **完整**                      |
| 17  | minimax::minimax-m3           | MiniMax                | 4.2    | 16.8   | 0.84      | 写免费（cacheWriteFree）         | CNY  | 3/4（无写价字段）             |
| 18  | gemini::gemini-3-6-flash      | Gemini                 | 1.5    | **缺** | 0.15      | 写免费（存储费 1.0/1M·h）        | USD  | 2/4（缺 output + 无写价字段） |
| 19  | gemini::gemini-3-5-flash      | Gemini                 | 0.75   | **缺** | 0.075     | 写免费（无写价字段）             | USD  | 2/4（缺 output + 无写价字段） |
| 20  | gemini::gemini-3-5-flash-lite | Gemini                 | 0.3    | **缺** | 0.03      | 写免费（无写价字段）             | USD  | 2/4（缺 output + 无写价字段） |
| 21  | gemini::gemini-3-1-pro        | Gemini                 | 1.25   | **缺** | 0.125     | 写免费（存储费 4.5/1M·h）        | USD  | 2/4（缺 output + 无写价字段） |
| 22  | glm::glm-5-2                  | GLM                    | 1.4    | 4.4    | 0.26      | 写免费（无写价字段）             | USD  | 3/4（无写价字段）             |
| 23  | glm::glm-5                    | GLM                    | 1.0    | 3.2    | 0.2       | 写免费（无写价字段）             | USD  | 3/4（无写价字段）             |
| 24  | glm::glm-4-7                  | GLM                    | 0.6    | 2.2    | 0.11      | 写免费（无写价字段）             | USD  | 3/4（无写价字段）             |
| 25  | glm::glm-4-5-air              | GLM                    | 0.2    | 1.1    | 0.03      | 写免费（无写价字段）             | USD  | 3/4（无写价字段）             |
| 26  | qwen::qwen3-max               | Qwen（dashscope 通道） | **缺** | **缺** | **缺**    | **缺**（全部留空，§11.3 未获取） | CNY  | 0/4（仅缓存机制字段）         |
| 27  | qwen::qwen3-7-max             | Qwen（dashscope 通道） | **缺** | **缺** | **缺**    | **缺**（全部留空）               | CNY  | 0/4（仅缓存机制字段）         |
| 28  | qwen::qwen3-coder-plus        | Qwen（dashscope 通道） | **缺** | **缺** | **缺**    | **缺**（全部留空）               | CNY  | 0/4（仅缓存机制字段）         |

逐条备注（与既有文档的转录关系，§12.4 已核销项不再重复）：

- #3~#9：Anthropic 7 条，价格对齐 00-catalog §1.1；#6 claude-opus-4-5 对应官方 Opus 4.5 行（Opus 4.6/4.7/4.8 同价未收录）；#7 钉死 2026-08-31 前促销价（§12.4.2 #2），9/1 涨价归 P5 日期切换。
- #10/#11：litellm 本地副本口径（00-catalog §2.2），**两者均缺输出价**（R0.5 表 3 #8：gpt-5.6 输出价 $30 未转录）；#11 gpt-5.5 写免费（旧轨 24h 保留）。
- #12：Kimi 仅 K3 有价（§5.1）；K2.x 全系无价未收录（§12.4.2 #5）。
- #13/#14：#13 带 `longContextThreshold: 200000` + `longContextInputPrice: 4.0`（§6.1）；#14 grok-4.3 长上下文价未获取。
- #18~#21：Gemini 4 条**全缺输出价**且**全无 contextWindow**（R0.5 表 3 #3 风险维持）；#18/#21 有 `storagePricePer1mHour`，#19/#20 存储费未获取。
- #22~#25：GLM 4 条，命中折扣 15%~18.6%（00-catalog §4.1）；cache_control 行为未实测 → behavior.rs 保守关。
- #26~#28：Qwen 3 条价格为**空**（§11.3：官方只给折扣比例 10%/20%/125%，绝对单价未获取）；条目仅含缓存机制字段（断点 4 / TTL 5m / 支持 cache_control）。

---

## 2. 四指标缺口审计（汇总）

### 2.1 完整性分布

| 类别                                       | 条数   | 明细                                                                                                                                                                                  |
| ------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 完整四指标（含写价字段或显式写免费）       | **11** | deepseek-v4-flash、deepseek-v4-pro、claude-fable-5、claude-mythos-5、claude-opus-5、claude-opus-4-5、claude-sonnet-5、claude-sonnet-4-5、claude-haiku-4-5、minimax-m2-7、minimax-m2-5 |
| 3/4，仅缺 cacheWrite（写免费，无写价字段） | **9**  | gpt-5.5、kimi-k3、grok-4.5、grok-4.3、minimax-m3、glm-5-2、glm-5、glm-4-7、glm-4-5-air                                                                                                |
| 3/4，仅缺 outputPrice                      | **1**  | gpt-5.6                                                                                                                                                                               |
| 2/4，缺 output + 缺 cacheWrite 字段        | **4**  | gemini-3-6-flash、gemini-3-5-flash、gemini-3-5-flash-lite、gemini-3-1-pro                                                                                                             |
| 0/4，四价全空                              | **3**  | qwen3-max、qwen3-7-max、qwen3-coder-plus                                                                                                                                              |
| 合计                                       | **28** |                                                                                                                                                                                       |

### 2.2 关键统计（R0 结论）

1. **完整四指标：11 条（39.3%）**——DeepSeek 2（写价显式 0）、Anthropic 7（5m/1h 双档写价）、MiniMax M2.x 2（写价 1.25x）。
2. **缺 cacheWrite 写价字段：13 条**（9 条写免费 + 4 条 gemini 无写价字段）；其中显式 `cacheWriteFree: true` 的 6 条：deepseek×2、gpt-5.5、kimi-k3、minimax-m3。
3. **缺 outputPrice：5 条**（gpt-5.6、gpt-5.5、gemini×4 中 gpt-5.6 单独计，gemini 4 条合计 5 条，互斥关系见 2.1）。
4. **价格全空：3 条（Qwen，占 10.7%）**——前端成本估算对这三条只能靠费率折算或全局乘数。
5. **币种标注：28/28（100%）**——全部条目含 `currency` 字段：USD 21 条、CNY 7 条（kimi-k3、minimax×3、qwen×3）。
6. **附带缺口**：Gemini 4 条无 `contextWindow`（R0.5 表 3 #3）；Fable/Mythos/Opus 5 无 `contextWindow`；grok-4.3 无长上下文价；gemini-3-5-flash/lite 无存储费。

### 2.3 前端费率表与目录的一致性（pricingStore.ts CATALOG_CACHE_RATES）

- 静态表 28 条与目录 28 条一一对应（费率 = read 价/input 价、write 价系数）。
- 已知形态差异：目录键 grok 用**点号**（`grok::grok-4.5`），前端表用**横线**（`grok-4-5`）——靠 `resolveCatalogRates` 的 includes 模糊匹配兜住，v2 建议统一键形态。
- 前端 `DEFAULT_PRICES` 8 条 USD 静态价不含 CNY 厂商（Kimi/MiniMax/豆包）与 Qwen（无价）——R0.5 表 3 #5 风险维持，v2 需引入 currency 感知的估算路径。

---

## 3. 按厂商的缺口清单（官方全量 vs 现有）

> 「官方全量」= 00-catalog / 机制文档 / 任务书已可确认的现行模型；「现有」= catalog.json 条数。
> 标注：🟥 价格与条目均缺　| 🟨 条目在、价格不全　| 🟩 已收录无缺口（仅剩日期/实测类待办）。

### 3.1 Anthropic（官方 16 行 / 15 模型 vs 现有 7）🟨

| 官方模型（00-catalog §1.1）                      | 现有 | 缺口说明                                                                     |
| ------------------------------------------------ | ---- | ---------------------------------------------------------------------------- |
| Claude Fable 5                                   | ✅   | —                                                                            |
| Claude Mythos 5（limited availability）          | ✅   | 状态字段（limited availability）未入目录                                     |
| Claude Opus 5                                    | ✅   | 无 contextWindow，待补                                                       |
| Claude Opus 4.8 / 4.7 / 4.6                      | 🟥   | 同 Opus 5 价（$5/$6.25/$10/$0.5/$25）与最低缓存 1024/2048/4096，**3 条全缺** |
| Claude Opus 4.5                                  | ✅   | —                                                                            |
| Claude Opus 4.1（deprecated）/ Opus 4（retired） | 🟥   | 退役价 $15 档，入不入目录由 v2 政策定（建议带 retired 标记收录）             |
| Claude Sonnet 5（8/31 前 $2 促销）               | ✅   | 促销价钉死；**9/1 涨价行未收录**（P5 日期切换域）                            |
| Claude Sonnet 4.6                                | 🟥   | 同 Sonnet 4.5 价，最低缓存 1024，缺                                          |
| Claude Sonnet 4.5                                | ✅   | —                                                                            |
| Claude Sonnet 4（retired）                       | 🟥   | 退役价 $3 档，同 Opus 4 政策                                                 |
| Claude Haiku 4.5                                 | ✅   | —                                                                            |
| Claude Haiku 3.5（retired）                      | 🟥   | 退役价 $0.8 档                                                               |

### 3.2 OpenAI GPT-5.x（官方 7 系 vs 现有 2）🟨

| 模型                          | 现有 | 缺口说明                                                                                                  |
| ----------------------------- | ---- | --------------------------------------------------------------------------------------------------------- |
| gpt-5.6                       | 🟨   | **缺 outputPrice**（R0.5 表 3 #8：litellm 副本口径 $30）；TTL 仅 30m、最低 1024 已录                      |
| gpt-5.5                       | 🟨   | **缺 outputPrice**；写免费已录（cacheWriteFree）                                                          |
| gpt-5.4 / 5.2 / 5.1 / 5 / 4.1 | 🟥   | 5 系价格未获取（00-catalog §2.2 只给 24h 保留语义与 1024-2048 最低档）；官方按量计费页**未抓取**，R1 必补 |

### 3.3 DeepSeek（官方 2 vs 现有 2）🟩

- 模型无缺口；剩余待办：① 峰谷定价 2x 生效日期（`peakPricing2x: true` 已录，日期待公告）；② v4-pro `supportsResponses` 官方口径「2026 年 8 月初」加入——R1 需确认是否已生效并翻转字段。

### 3.4 Kimi（官方 ≥5 型号 vs 现有 1）🟥

| 模型                                | 现有 | 缺口说明                                                                                  |
| ----------------------------------- | ---- | ----------------------------------------------------------------------------------------- |
| kimi-k3                             | ✅   | —                                                                                         |
| kimi-k2.7 / k2.6 / k2.5             | 🟥   | 无价未收录（§12.4.2 #5 待补）；百炼侧命中折扣已知：k2.6 16.9%、k2.5 17.5%（机制文档 §9c） |
| kimi-k2.7-code                      | 🟥   | 百炼显式缓存支持清单含 kimi-k2.7-code（00-catalog §11.1）；价格与缓存轨待 R1              |
| kimi-for-code / kimi-k2.x-code 变体 | 🟥   | 任务书列为已知缺口，仓库内无数据，R1 核实官方型号命名                                     |

### 3.5 Grok（官方 3 型号 vs 现有 2）🟨

- grok-4.5 ✅；grok-4.3 缺长上下文价（≥200K 档，机制文档 §6.1 未获取）；grok-4.20-0309 🟥 未收录（机制文档标注「同 grok-4.3」，价格与 API 标识待确认）；命中价绝对值建议以官方定价页复核（机制文档 §11.6 #4）。

### 3.6 MiniMax（官方 5 型号 vs 现有 3）🟨

- M2.7 / M2.5 / M3 ✅；**M2.1 / M2 🟥 未收录**（机制文档 §7.1：价格同 M2.5 轨 ¥2.1/¥0.21/¥2.625/¥8.4，主动缓存支持，补录成本极低）；M3 长上下文价（>512K）未录。

### 3.7 Gemini（官方 4 条已录但全系有缺）🟨

- 3.6 Flash / 3.5 Flash / 3.5 Flash-Lite / 3.1 Pro 均：🟨 **缺 outputPrice** + **无 contextWindow**（R0.5 表 3 #3）；3.5 Flash / Flash-Lite 缺存储费；3.1 Pro 长上下文价缺（`longContextThreshold` 有值但无价格档）；Gemini 3.5 Pro / 2.5 系是否收录待 v2 政策定。

### 3.8 GLM（官方 ≥6 vs 现有 4）🟨

- GLM-5.2 / 5 / 4.7 / 4.5-Air ✅；**GLM-4.6 / 4.5 🟥**（00-catalog §4.1：价同 4.7 档 $0.6/$0.11/$2.2）；**GLM-5.1 🟥**（百炼显式缓存支持清单含 glm-5.1，00-catalog §11.1）；Anthropic 端点 cache_control 行为未实测（behavior.rs unverified 标记，R1 建议实测）；GLM-4.7 上下文 200K 已录。

### 3.9 Qwen / 百炼（官方全系 vs 现有 3 条且全无价）🟥

| 模型                                                                                                                        | 现有 | 缺口说明                                                         |
| --------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------- |
| qwen3-max / qwen3-7-max / qwen3-coder-plus                                                                                  | 🟨   | 3 条均在但**价格全空**（§11.3 绝对单价未获取）——R1 必补          |
| qwen3.8-max（任务书）                                                                                                       | 🟥   | 仓库内无数据，R1 核实是否现行旗舰及定价                          |
| qwen3.6-max-preview、qwen3.5/3.7 Plus 系列、qwen3.7-flash、qwen3-coder-flash、qwen3-vl-plus/flash、qwen-plus、qwen-flash 等 | 🟥   | 百炼显式缓存/Responses Session 支持清单已确认（§11.1），价格全缺 |

### 3.10 豆包 / 火山方舟（官方 ≥3 vs 现有 0）🟥

- doubao-seed-2.1-pro（¥6/¥1.2/¥30）、doubao-seed-2.1-turbo（¥3/¥0.6/¥15）、doubao-seed-2.0-mini（¥0.2/¥0.04/¥2）——00-catalog §9.1 已有价格但**未入目录**；存储费 0.017 元/1M·h；命中计量字段未获取；另有方舟转售 deepseek-v4-pro / glm-4.7（provider 维度条目策略，§13.4 保留，v2 定夺）。

### 3.11 百度千帆 / ERNIE（官方 ≥2 vs 现有 0）🟥

- ERNIE-4.5-Turbo（¥0.8/¥0.2/¥3.2）、ERNIE-4.5-Turbo-VL（¥3/¥0.75/¥9）——00-catalog §10.1 已有价格但**未入目录**；千帆转售 deepseek-v4-pro/flash 同 §3.10 策略；cache_control 支持未确认。

### 3.12 其他（任务书指名）🟥

- **composer 2.5**：仓库内无任何本地数据，归属厂商未知——R1 需先确认官方厂商与定价页，再抓价格。
- **转售通道（provider 维度）**：方舟/千帆转售价与官方直连价量级差异大（00-catalog §13.4），v2 需定条目策略（同一 model 多 provider 条目）。

### 3.13 缺口汇总表

| 厂商       | 现有条数 | 已知缺口（现行模型）                                       | 已确认价格但未入目录  |
| ---------- | -------- | ---------------------------------------------------------- | --------------------- |
| Anthropic  | 7        | Opus 4.8/4.7/4.6、Sonnet 4.6、Sonnet 5 9/1 价行、退役 4 款 | —                     |
| OpenAI     | 2        | gpt-5.4/5.2/5.1/5/4.1；5.6/5.5 输出价                      | —                     |
| DeepSeek   | 2        | 无模型缺口（峰谷日期、Responses 待确认）                   | —                     |
| Kimi       | 1        | k2.7/k2.6/k2.5、k2.7-code、for-code 变体                   | 百炼侧命中折扣比例    |
| Grok       | 2        | grok-4.20-0309；grok-4.3 长上下文价                        | —                     |
| MiniMax    | 3        | M2.1/M2                                                    | 机制文档 §7.1 有价    |
| Gemini     | 4        | 3.5 Pro/2.5 系待政策；4 条缺 output/窗口/存储费            | —                     |
| GLM        | 4        | 4.6/4.5、5.1                                               | 00-catalog §4.1 有价  |
| Qwen       | 3        | 全系价格空；qwen3.8-max 待核实                             | 折扣比例（§11.3）     |
| 豆包/方舟  | 0        | seed 系全缺 + 转售条目                                     | 00-catalog §9.1 有价  |
| ERNIE/千帆 | 0        | 全缺 + 转售条目                                            | 00-catalog §10.1 有价 |
| Composer   | 0        | 归属厂商未知                                               | —                     |

---

## 4. 字段结构建议（catalog.json v2 完整字段集）

### 4.1 设计原则

- 键形态统一：v2 条目一律 `vendor::model`，vendor 段与 `behavior.rs` `VendorId::as_str()` 对齐；目录内模型名形态（横线/点号）与 API 真实标识的关系在条目内用 `model` 字段承载，**前端费率表键与目录键强制一致**（消除 §2.3 grok 形态差异）。
- 命名对齐 litellm `model_prices_and_context_window.json`：catalog.json 保持 camelCase（现行为 Rust serde 字段），映射关系见表 4.3。
- 价格绝对值优先：v2 以**绝对价**存储（per_1M），折扣比例/乘数只作派生数据，不再作为主要存储形态（Qwen 3 条缺口即因此产生）。
- 生命周期字段：促销价、退役、日期切换显式化（Sonnet 5 9/1 涨价、DeepSeek 峰谷日期、GPT-5.6 30m TTL 等不再靠文档注释记忆）。

### 4.2 完整字段集（46 字段；必填 15 + 条件必填 6 + 可选 25）

**A. 身份（必填 5）**

| 字段       | 说明                                               | litellm 对应       |
| ---------- | -------------------------------------------------- | ------------------ |
| `model`    | API 模型标识（条目唯一键之一）                     | 键名               |
| `provider` | 通道/网关标识（dashscope、volcengine、qianfan 等） | `litellm_provider` |
| `vendor`   | 官方厂商（转售场景区分通道价与官方直连价）         | —（需扩展）        |
| `mode`     | chat / completion / both                           | `mode`             |
| `currency` | USD / CNY（转售价多为 CNY）                        | —（需扩展）        |
| `unit`     | `per_1M`（统一单位，防 litellm per-token 换算错）  | —（需扩展）        |

**B. 上下文（必填 2 + 条件 1）**

| 字段              | 说明                                                                                       | litellm 对应        |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------------- |
| `contextWindow`   | 输入上下文窗口（token）；与 litellm `max_input_tokens` 同值，v2 建议两字段都出以对齐消费面 | `max_input_tokens`  |
| `maxOutputTokens` | 输出上限                                                                                   | `max_output_tokens` |
| `maxInputTokens`  | （可选冗余，对齐 litellm 直读；不设则由 contextWindow 派生）                               | `max_input_tokens`  |

**C. 价格（必填 3 + 条件 5）**

| 字段                        | 说明                                                                                          | litellm 对应                                |
| --------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `inputPrice`                | 未缓存输入价 /1M                                                                              | `input_cost_per_token`                      |
| `outputPrice`               | 输出价 /1M（**5 条现有缺口在此**）                                                            | `output_cost_per_token`                     |
| `cacheReadPrice`            | 缓存命中价 /1M                                                                                | `cache_read_input_token_cost`               |
| `cacheWritePrice`           | 通用写价（OpenAI GPT-5.6+ 1.25x / MiniMax 主动轨；写免费厂商填 `0` + `cacheWriteFree: true`） | `cache_creation_input_token_cost`           |
| `cacheWritePrice5m`         | Anthropic 系 5m TTL 写价                                                                      | `cache_creation_input_token_cost`           |
| `cacheWritePrice1h`         | Anthropic 系 1h TTL 写价（无则省略）                                                          | `cache_creation_input_token_cost_above_1hr` |
| `storagePricePer1mHour`     | 缓存存储费（Gemini / 方舟；无则省略）                                                         | —（需扩展）                                 |
| `longContextInputPrice`     | 长上下文输入价（阈值见 `longContextThreshold`）                                               | —（需扩展）                                 |
| `longContextCacheReadPrice` | 长上下文命中价（Grok ≥200K 档 $0.60 现有条目未录，v2 补）                                     | —（需扩展）                                 |
| `longContextOutputPrice`    | 长上下文输出价（Grok ≥200K 档 $12.00）                                                        | —（需扩展）                                 |

**D. 缓存语义（必填 2 + 条件 6）**

| 字段                    | 说明                                                                      | litellm 对应              |
| ----------------------- | ------------------------------------------------------------------------- | ------------------------- |
| `supportsPromptCaching` | 是否参与任何缓存                                                          | `supports_prompt_caching` |
| `cacheType`             | automatic / explicit / both / none                                        | —（需扩展）               |
| `cacheMechanism`        | prefix / similarity / disk_unit / session                                 | —（需扩展）               |
| `cacheWriteFree`        | 写免费标记（DeepSeek / Kimi / Grok / GLM / Gemini / M3 / 旧轨）           | —（需扩展）               |
| `promptCacheMinTokens`  | 最低可缓存 token（Anthropic 官方字段同名）                                | `prompt_cache_min_tokens` |
| `supportsCacheControl`  | Anthropic 式 cache_control 断点支持                                       | —（需扩展）               |
| `breakpointMax`         | 断点上限（Anthropic / MiniMax / 百炼 = 4）                                | —（需扩展）               |
| `lookbackBlocks`        | 回溯窗口（20）                                                            | —（需扩展）               |
| `cacheTtl`              | 字符串或对象：`"5m"` / `{"default":"5m","options":["5m","1h"]}` / `"24h"` | —（需扩展）               |

**E. 定价修饰（条件 2）**

| 字段                   | 说明                                                                | litellm 对应 |
| ---------------------- | ------------------------------------------------------------------- | ------------ |
| `longContextThreshold` | 长上下文价格阈值（Grok 200K、Gemini 3.1 Pro 200K、MiniMax M3 512K） | —（需扩展）  |
| `peakPricing2x`        | DeepSeek 峰谷 2x 标记                                               | —（需扩展）  |
| `peakPricingSchedule`  | 峰谷时段（北京 9:00-12:00、14:00-18:00；生效日期待公告）            | —（需扩展）  |

**F. supports 能力位（条件 14，对齐 litellm）**

| 字段                                                          | litellm 对应                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `supportsResponses`（crish 扩展，litellm 无）                 | —                                                                                 |
| `supportsReasoning` / `supportsReasoningEffort`               | `supports_reasoning`（effort 系 litellm 有 `supports_xhigh_reasoning_effort` 等） |
| `supportsVision`                                              | `supports_vision`                                                                 |
| `supportsFunctionCalling` / `supportsParallelFunctionCalling` | `supports_function_calling` / `supports_parallel_function_calling`                |
| `supportsSystemMessages`                                      | `supports_system_messages`                                                        |
| `supportsResponseSchema`                                      | `supports_response_schema`                                                        |
| `supportsWebSearch`                                           | `supports_web_search`                                                             |
| `supportsAudioInput` / `supportsAudioOutput`                  | `supports_audio_input` / `supports_audio_output`                                  |
| `supportsPdfInput`                                            | `supports_pdf_input`                                                              |
| `supportsToolChoice`                                          | `supports_tool_choice`                                                            |
| `supportsAssistantPrefill`                                    | `supports_assistant_prefill`                                                      |
| `supportsComputerUse`                                         | `supports_computer_use`                                                           |

**G. 生命周期与溯源（必填 2 + 条件 3）**

| 字段                          | 说明                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `sourceUrl`                   | 条目数据来源 URL（必填）                                                                         |
| `dataVerifiedAt`              | 条目核实日期（必填，2026-08-02 现值为基准）                                                      |
| `dataSource`                  | 直连官方 / 转售通道 / 本地 litellm 副本口径标注（gpt-5.x 当前为 litellm 副本口径，必须显式标注） |
| `promoExpiresAt`              | 促销价到期（Sonnet 5 `2026-08-31`；到期后 P5 切 `promoReplacesAt` 指向的 9/1 价行）              |
| `retired` / `deprecationDate` | 退役 / 弃用标记（litellm `deprecation_date`；R0.5 表 3 #2 建议的「已退役标记」落地）             |

### 4.3 litellm 字段映射速查

| crish v2 字段                   | litellm 字段                                     | 备注                                                          |
| ------------------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| inputPrice / outputPrice        | `input_cost_per_token` / `output_cost_per_token` | litellm 存 per-token（2e-06=$2/1M），v2 统一 per-1M           |
| cacheReadPrice                  | `cache_read_input_token_cost`                    | 同名语义                                                      |
| cacheWritePrice5m               | `cache_creation_input_token_cost`                | litellm 只存单一创建价（5m 口径）                             |
| cacheWritePrice1h               | `cache_creation_input_token_cost_above_1hr`      | litellm 已原生支持该字段（本地副本 claude-sonnet-5 条目可证） |
| promptCacheMinTokens            | `prompt_cache_min_tokens`                        | litellm 部分厂商才有                                          |
| contextWindow / maxOutputTokens | `max_input_tokens` / `max_output_tokens`         | v2 建议双出                                                   |
| supports* 位                    | `supports_*`                                     | 逐一对应                                                      |
| 无对应                          | `search_context_cost_per_query`                  | 联网搜索按查询计费的模型（litellm 有，crish 暂可不收）        |

### 4.4 缺口字段对现有 28 条的回填建议（R1 产出物）

| 现有缺口                 | 涉及条目                                                                                     | 回填责任轮              |
| ------------------------ | -------------------------------------------------------------------------------------------- | ----------------------- |
| outputPrice              | gpt-5.6、gpt-5.5、gemini×4                                                                   | R1 OpenAI / Gemini 调研 |
| cacheWritePrice 全量确认 | 13 条无写价字段（写免费厂商建议显式 `cacheWritePrice: 0` + `cacheWriteFree: true` 统一语义） | R1 各厂商               |
| 绝对单价                 | qwen×3                                                                                       | R1 Qwen 调研            |
| contextWindow            | gemini×4、claude-fable-5/mythos-5/opus-5                                                     | R1 Gemini / Anthropic   |
| 长上下文价格档           | grok-4.3、gemini-3-1-pro、minimax-m3                                                         | R1 各厂商               |
| storagePricePer1mHour    | gemini-3-5-flash/lite、豆包系                                                                | R1 Gemini / 豆包        |
| 生命周期字段             | 全部 28 条（补 dataSource；sonnet-5 补 promoExpiresAt）                                      | v2 落地轮统一回填       |

---

## 5. R1 各厂商调研任务书要点（每厂商需回答的问题清单模板）

### 5.1 通用问题模板（每家必答，输出统一成表）

1. **模型清单**：官方按量计费页现行模型全量（含 API 标识与别名）；新发布/退役/弃用型号及日期。
2. **四指标绝对价**：input / output / cacheRead / cacheWrite 单价（每模型；注明币种 USD/CNY 与单位 per_1M）。
3. **写价语义**：写免费？1.25x？2x？双档（5m/1h）？有无 `cache_creation_input_token_cost_above_1hr` 对应值。
4. **最低可缓存 token**：每模型（或按系列）的 `promptCacheMinTokens`。
5. **TTL 档位**：默认值、可选值（5m / 1h / 24h / 30m / in_memory / 服务端管理未知）。
6. **断点机制**：cache_control 支持？自有断点参数？上限（4）？回溯窗口？写入时机？
7. **上下文窗口 / 输出上限**：`contextWindow`、`maxOutputTokens`（来源 URL 直引）。
8. **长上下文价格档**：threshold + input/read/output 三价（无则明确「无」）。
9. **存储费**：per-1M·h 存储费（存储型缓存厂商必答，无则明确「无」）。
10. **计量字段**：读/写/未命中三字段名（协议族归类，机制文档 §11.2）。
11. **supports 位**：Responses、reasoning、reasoningEffort、vision、function calling、system messages、web search、audio（对照 litellm 同名位）。
12. **特殊定价**：促销与到期日、日期区间价、峰谷价、转售价（附 `promoExpiresAt` / `dataSource` 建议值）。
13. **来源 URL + 抓取日期**：每个数字可复核。

### 5.2 各厂商专项问题（派单靶点）

**A. Anthropic（补齐 4 现行 + 政策）**

- Opus 4.8 / 4.7 / 4.6、Sonnet 4.6 四价与最低缓存 token（对照 §1.2：4096/2048/1024 已记录，验证）；Opus 5 / Fable 5 / Mythos 5 的 `contextWindow`。
- Sonnet 5 9/1 涨价行（$3/$3.75/$6/$0.3/$15）与促销到期日，供 `promoExpiresAt` 落值。
- 退役模型（Opus 4.1 / 4、Sonnet 4、Haiku 3.5）收录政策建议：带 `retired: true` 收录或排除（给调度者裁决输入）。
- Mythos 5 limited availability 状态字段取值。

**B. OpenAI（官方按量计费页全量）**

- 首次抓取官方按量计费页：gpt-5.6 / 5.5 输出价（R0.5 表 3 #8 销账）+ gpt-5.4 / 5.2 / 5.1 / 5 / 4.1 全价。
- 写价适用范围确认：1.25x 是否仅 GPT-5.6+；5.5 写免费确认。
- TTL 档：5.6 仅 30m？旧轨 24h extended 模型清单（§2.1 已列，验证）；`promptCacheMinTokens` 每模型值（1024 vs 1024-2048）。
- `prompt_cache_options` implicit/explicit 断点与 `prompt_cache_key` 路由（机制文档 §8）的行为确认（供 supports 位）。

**C. DeepSeek（小任务）**

- 峰谷定价生效日期公告跟踪；v4-pro Responses API 是否已上线（已到「2026 年 8 月初」窗口）→ 决定翻转 `supportsResponses`。

**D. Kimi（官方定价页全量）**

- K2.7 / K2.6 / K2.5 四价（¥/1M）；k2.7-code / for-code 变体的官方命名、价格、缓存轨（直连 vs 百炼折扣 16.9%/17.5%）。
- 命中折扣直连口径（K3 = 10%）验证；输出价；`prompt_cache_key` Coding Plan 语义确认。

**E. Grok（定价页绝对值）**

- 官方定价页（docs.x.ai/developers/pricing）绝对值复核：grok-4.5 / 4.3 / 4.20-0309 四价 + 长上下文档（≥200K input/read/output 三价）。
- grok-4.3 长上下文价补录；grok-4.20-0309 是否现行、API 标识确认。

**F. MiniMax（低价补录）**

- M2.1 / M2 四价补录（预计同 M2.5 轨）；M3 长上下文价（>512K）与分段阈值。
- 主动/被动双轨 per-model 确认（M2.x 主动 + 被动、M3 仅被动）→ 校对 `cacheType` 与行为矩阵。

**G. Gemini（官方定价页补齐）**

- 3.6 Flash / 3.5 Flash / 3.5 Flash-Lite / 3.1 Pro 的 outputPrice（4 条缺口）+ `contextWindow` 官方值（R0.5 表 3 #3 销账）。
- 3.5 Flash / Flash-Lite 存储费（storagePricePer1mHour）；3.1 Pro 长上下文价格档。
- 隐式最低 token（3.x = 4096、2.5 = 2048）验证；3.5 Pro / 2.5 系收录政策。

**H. GLM（官方定价页 + 实测）**

- GLM-4.6 / 4.5 四价补录（预计同 4.7 档）；GLM-5.1 价格与显式缓存支持（百炼侧已确认支持 cache_control）。
- **cache_control 实测**：向 `https://api.z.ai/api/anthropic` 发带 cache_control 请求，观察 `cache_read_input_tokens`（机制文档 §11.6 #2）→ 结果回写 behavior.rs 矩阵。
- Responses API 支持确认（§11.6 #3）。

**I. Qwen / 百炼（绝对单价攻坚）**

- **qwen3.8-max 核实**：是否存在、是否现行旗舰、四价（任务书指名缺口）。
- qwen3-max / qwen3-7-max / qwen3-coder-plus 绝对单价（§11.3 缺口销账；来源 = 百炼控制台按量计费页）。
- 全系现行模型清单（§11.1 支持清单 + 增量）；显式 10% / 创建 125% / 隐式 20% 的绝对价折算表（供 v2 折扣换算）。
- Session 缓存（`x-dashscope-session-cache`）价格是否与显式一致。

**J. 豆包 / 方舟（补录 + 实测）**

- seed 2.1-pro / 2.1-turbo / 2.0-mini 四价补录（00-catalog §9.1 已有价，核实后入目录）+ 现行新 seed 系。
- 存储费 0.017 元/1M·h 确认；命中计量字段实测（§11.6 #5）。
- 转售条目（deepseek-v4-pro ¥12、glm-4.7 分段 ¥2-4）收录策略：provider 维度条目建议。

**K. ERNIE / 千帆（补录 + 实测）**

- ERNIE-4.5-Turbo / ERNIE-4.5-Turbo-VL 四价补录（00-catalog §10.1）+ 现行新模型。
- cache_control 断点支持实测（OpenAI/Anthropic 兼容端点）；计量字段实测。
- 千帆转售 deepseek-v4-pro / v4-flash 条目策略。

**L. Composer 2.5（摸底）**

- 确认归属厂商与官方定价页 URL；API 模型标识、四价、缓存机制（是否支持缓存、写价、最低可缓存 token）——无本地数据，属全新摸底。

---

## 6. R0 结论与 R1 输出契约

1. **结论**：现有 28 条中完整四指标仅 11 条（39%）；价格全空 3 条（Qwen）；缺写价字段 13 条；缺输出价 5 条；币种标注 28/28 无缺口。模型覆盖缺口集中在 Anthropic 现行 4 型号、OpenAI 5 系、Kimi K2.x、Qwen 全系价格、豆包/ERNIE 整厂商（各 0 条）与 Composer 2.5（未知归属）。
2. **R1 产出物**：每厂商一份「调研结果表」（§5.1 模板 13 问全答）+ 可复核来源 URL 清单；新目录条目标准格式（§4.2 字段集）；已确认价格但未入目录的存量（豆包/ERNIE/MiniMax M2.x/GLM 4.6）优先转录。
3. **R1 验收**：每厂商交付值必须满足「四指标绝对价 + 最低可缓存 token + TTL + 币种 + 来源 URL + 抓取日期」六要素；无法获取的显式标「未获取」，不编造。
4. **遗留移交**：峰谷生效日期、Sonnet 5 涨价日期切换、GLM cache_control 实测结果，属跨轮跟踪项，入 §4.2 生命周期字段后由 P5 定价域消费。
