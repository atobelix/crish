# 模型目录与定价 v2：catalog.json v2 字段 Schema（权威定义）

> 专项：「模型目录与定价 v2」　|　轮次：R2 Schema 设计　|　设计日期：2026-08-03
> 输入（R1 全部成果）：`00-gap-audit.md`（R0 缺口盘点，§4.2 字段建议 46 个）、`02-litellm-catalog-structure.md`（litellm 145 字段与四指标覆盖率）、`02-model-catalog-sources.md`（models.dev / OpenRouter 三源调研与冲突裁决）、`01-glm.md`（§3.5 命中价 + 存储费结构、§7 tiered 与 storage_price_per_1m_hour 设计）、`01-doubao.md`（分段价、存储费 0.017）、`01-minimax.md`（1h 写入档、highspeed 变体、M3 长上下文 2x）、`01-kimi.md`、`01-qwen.md`。
> 现状实现：`crates/agent-provider/src/models/catalog.rs`（v1 `ModelCatalogEntry`，catalog.rs:24-104）、`catalog.json`（28 条）、`behavior.rs`（行为矩阵消费）、`ttl.rs`（TTL 路由消费）、`apps/crish-desktop/src/api/pricingStore.ts`（CATALOG_CACHE_RATES 28 键）。
> 产出用途：R3 落地与后续所有消费方（行为矩阵 / TTL 路由 / P5 成本域 / 前端费率表 / catalog_refresh 远程源）的唯一字段契约。
> 性质：只读设计，未修改任何代码。

---

## 0. 结论先行

1. **字段全集 59 个**（必填 9 + 条件必填 12 + 可选 38），分组：标识 8 / 窗口 2 / 四指标 7 / 扩展价格 9 / 缓存语义 12 / 能力位 16 / 溯源与生命周期 7。
2. **四指标价格显式化三原则**（litellm 教训，02-litellm-catalog-structure.md §6.2）：
   - 写免费 = `cacheWritePrice: 0` + `cacheWriteFree: true` 双字段齐出，消除「缺字段」双义（写免费 vs 未收录）；
   - 价格未获取 = `null` + `priceStatus: "unavailable"`，**禁止 0 占位**（litellm 反模式 #3）；
   - 币种显式必填（USD/CNY），目录内**不做汇率换算**（litellm 反模式：换算汇率不落盘、不可追溯）。
3. **长度分档统一为「基础四价 + tieredPricing 增量档」**：基础四价 = 未命中任何档时的价格；`tieredPricing[]` 每档 `minTokens`（半开上界 `maxTokens`，null = 无上界）承载 32K/128K/200K/512K 边界，`minOutputTokens`/`maxOutputTokens` 承载输出分档（GLM-4.7 组合档），只写 `minTokens` 的档 = 长上下文档 2x 档（Grok ≥200K / MiniMax >512K / gpt-5.6 272K）——一套结构对齐 litellm `tiered_pricing.range`、models.dev `cost.tiers`/`context_over_200k`、OpenRouter `overrides` 三源（02-litellm §6.3、02-sources §5.4）。
4. **TTL 值域扩为四档** `"5m" / "30m" / "1h" / "24h"`（新增 30m 承载 gpt-5.6 系），消费侧 `ttl.rs` 的 `CacheTtl` 三档枚举需同步扩档（R3 域）。
5. **版本与冲突裁决**：顶层包装 `{ version, schema, updatedAt, entries }`；远程源条目以 `dataSource: "remote:models.dev"` 等标记；冲突优先级 = 静态人工 > models.dev 官方 > OpenRouter 渠道价（仅 openrouter 类 provider 条目），**禁止跨渠道覆盖**（02-sources §5.3，deepseek read 价差 10 倍实证）。
6. **推导价显式标注**：qwen 系官方只给比例 → `priceStatus: "derived"` + `derivation` 对象（01-qwen.md §6 建议的 `cache_price_derived` 标记的结构化落地）。
7. **新增消费衔接点**：`supportsPromptCacheKey`、`supportsImplicitCaching` 两字段进入 v2 目录，behavior.rs 的模型级覆盖需扩消费（当前这两位的真源在 vendor 矩阵）。

---

## 1. 设计原则

### 1.1 命名与单位（对齐 litellm，映射定稿于 00-gap-audit.md §4.3）

- 字段命名：camelCase（与现 serde `rename_all = "camelCase"` 一致，Rust 侧 snake_case）。
- 价格单位唯一化：**全部 per_1M tokens**；litellm 的 per-token（差 1e6 倍）、per-second、per-query、per-GB·day 混合形态不复制（02-litellm §6.2.2）。
- 非 token 计费项若收录，字段名必须带单位后缀（如 `storagePricePer1mHour`），消费侧无需猜单位。
- 窗口字段只用 `contextWindow`（输入）+ `maxOutputTokens` 两个语义明确的字段；litellm 遗留 `max_tokens`（LEGACY）一律不收（02-litellm 反模式 #5）。

### 1.2 币种与汇率（litellm 教训 §3）

- `currency` 必填，值域 `"USD" | "CNY"`，**禁止隐式 USD**（litellm 全库无 currency 字段、Kimi 被按隐含汇率换算落盘且不可追溯）。
- 目录不保存汇率、不做换算；同一模型双币种 = 双条目（`glm::glm-5-2` provider=zai 走 USD、provider=bigmodel 走 CNY，01-glm.md §7）。
- 前端如需 USD 口径，由前端汇率配置处理（见 §8），目录只标币种。

### 1.3 写免费 / 未收录 / 有写价三态（消除 litellm 双义）

| 语义                     | v2 表达                                                                          | litellm 对照（歧义源）                    |
| ------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------- |
| 写免费（厂商无写价概念） | `cacheWritePrice: 0` + `cacheWriteFree: true`                                    | OpenAI 系省略字段、zai 显式 0（两义混淆） |
| 有写价                   | `cacheWritePrice: n`（n>0）+ `cacheWriteFree: false`                             | `cache_creation_input_token_cost`         |
| 未收录 / 未获取          | `cacheWritePrice: null` + `cacheWriteFree: false` + `priceStatus: "unavailable"` | glm-4.5 缺字段（与免费同形）              |

### 1.4 键形态与标识（00-gap-audit.md §4.1）

- 目录顶层键 = `vendor::model`；vendor 段与 `behavior.rs` `VendorId::as_str()` 对齐（behavior.rs:49-63）。
- `model` 字段 = 目录内模型标识（横线形态为主）；当 API 真实标识为点号等异形（`qwen3.7-max`、`MiniMax-M2.7`、`glm-4.7`）时，由可选 `apiModel` 字段承载，请求构造层使用 `apiModel ?? model`。
- `id` = 条目稳定唯一 ID（缺省派生 `vendor::model`），供前端费率表键统一与跨源合并锚点（§4.2）。
- highspeed 变体（MiniMax M2.x-highspeed，输入/输出 2x、缓存读写价不变，01-minimax.md §7.1）= **独立条目**，不建模为 tiered（非长度分档）。

---

## 2. 字段全集（59 个）

> 必填 = 条目不满足即视为转录错误（serde 全量解析测试钉死）；条件必填 = 触发条件成立时必须提供；可选 = 无则省略 / null。
> 全部字段 `#[serde(default)]`，缺字段条目仍可解析（catalog.rs:618-635 A3 P2-10 测试钉死的不变量延续到 v2）。

### A. 标识（8：必填 4 + 条件必填 1 + 可选 3）

| 字段       | 级别     | 类型 / 值域                       | 说明                                                                                  |
| ---------- | -------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| `model`    | **必填** | string                            | 目录内模型标识（顶层键 `vendor::model` 组成部分；横线形态为主）                       |
| `provider` | **必填** | string                            | 通道/网关标识（dashscope / volcengine / qianfan / bigmodel / zai；直连 = 官方厂商名） |
| `vendor`   | **必填** | string                            | 官方厂商（转售场景区分通道价与官方直连价；决定行为矩阵取哪个 vendor）                 |
| `currency` | **必填** | `"USD" \| "CNY"`                  | 计价币种，禁止隐式                                                                    |
| `apiModel` | 条件必填 | string                            | 当 API 真实请求标识 ≠ model 时必填（如 qwen3-7-max → `qwen3.7-max`）；缺省 = model    |
| `id`       | 可选     | string                            | 条目稳定唯一 ID；缺省派生 `vendor::model`。用途：前端费率表键统一、跨源合并锚点       |
| `mode`     | 可选     | `"chat" \| "responses" \| "both"` | 协议模式                                                                              |
| `unit`     | 可选     | `"per_1M"`                        | 计价单位（v2 唯一单位；值非法即校验失败）                                             |

### B. 窗口（2：必填 2）

| 字段              | 级别     | 类型         | 说明                                                                                               |
| ----------------- | -------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `contextWindow`   | **必填** | u64（token） | 输入上下文窗口；R1 已补全 gemini×4 与 fable/mythos/opus-5 缺口（00-gap-audit §2.2 附带缺口销账项） |
| `maxOutputTokens` | **必填** | u64（token） | 输出上限；官方未公布时取 models.dev 口径并在 `notes` 标注来源（01-minimax.md §8.2）                |

### C. 四指标价格（7：必填 2 + 条件必填 4 + 可选 1）

| 字段                | 级别     | 类型          | 说明                                                                                                                                                                                                                   |
| ------------------- | -------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inputPrice`        | **必填** | f64（per_1M） | 未缓存输入价；全价未获取时例外（见 `priceStatus`）                                                                                                                                                                     |
| `outputPrice`       | **必填** | f64（per_1M） | 输出价；gpt-5.6/gpt-5.5/gemini×4 的 5 条缺口由 R1 补录销账                                                                                                                                                             |
| `cacheReadPrice`    | 条件必填 | f64（per_1M） | `supportsPromptCaching=true` 时必填（可 0，如免费档模型）；厂商有缓存但官方未给绝对值时按 `priceStatus: "derived"` 标注                                                                                                |
| `cacheWritePrice`   | 条件必填 | f64（per_1M） | 通用写价（OpenAI GPT-5.6+ 1.25x / MiniMax 主动轨）；写免费 = `0` + `cacheWriteFree: true`；`supportsPromptCaching=true` 时必填                                                                                         |
| `cacheWritePrice5m` | 条件必填 | f64（per_1M） | Anthropic 系 5m TTL 写价（litellm `cache_creation_input_token_cost` 直抄）；Anthropic 条目必填                                                                                                                         |
| `cacheWritePrice1h` | 条件必填 | f64（per_1M） | Anthropic `above_1hr` 档（litellm `cache_creation_input_token_cost_above_1hr` 直抄）；MiniMax 官方「写入后 1h 窗口命中」口径**不**落此字段（用 `cacheWritePrice` + `cacheTtl` 表达，02-litellm §6.4）；1h 档存在时必填 |
| `cacheWriteFree`    | **必填** | bool          | 写免费显式位：true = 写免费（此时 `cacheWritePrice` 必须为 0 或 null）；false = 有写价或未收录（与 `cacheWritePrice: null` 区分）                                                                                      |

### D. 扩展价格（9：条件必填 4 + 可选 5）

| 字段                                             | 级别     | 类型 / 值域                                | 说明                                                                                                                                                                   |
| ------------------------------------------------ | -------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storagePricePer1mHour`                          | 条件必填 | f64（`/1M·h`）                             | 缓存存储费，按小时计时（GLM/豆包 0.017 元/1M·h、Gemini 1.0/4.5 $/1M·h，01-glm.md §3.5①、01-doubao.md §2C）；存储型缓存厂商（Gemini/方舟/GLM 国内站）必填；免费档 = `0` |
| `storagePriceFreeUntil`                          | 条件必填 | string（YYYY-MM-DD）                       | 存储费限时免费到期日（GLM 2026-08-31，01-glm.md §7）；`storagePricePer1mHour = 0` 且为限时免费时必填                                                                   |
| `tieredPricing`                                  | 条件必填 | TieredPriceTier[]                          | 长度分档模型（GLM 5.1/5-Turbo/5/5V-Turbo/4.7、doubao 2.0 系、MiniMax M3、grok 长档、gpt-5.6 272K 档）；结构见 §3.1                                                     |
| `derivation`                                     | 条件必填 | PriceDerivation                            | `priceStatus: "derived"` 时必填（推导依据与因子）；见 §3.2                                                                                                             |
| `priceStatus`                                    | 可选     | `"official" \| "derived" \| "unavailable"` | 价格形态；缺省 `"official"`。`"unavailable"` = 四价全 null 且无推导（要求 `notes` 说明，如早期 qwen 条目状态）                                                         |
| `reasoningPrice`                                 | 可选     | f64（per_1M）                              | 推理 token 计价（models.dev `cost.reasoning`，deepseek-v4-flash = 0.28 = 输出价）；P5 成本域消费，当前仅记录不计算（02-sources §5.4 映射表）                           |
| `peakPricing2x`                                  | 可选     | bool                                       | DeepSeek 峰谷 2x 标记（catalog.json 已录）                                                                                                                             |
| `peakPricingSchedule`                            | 可选     | PeakPricingSchedule                        | 峰谷时段与生效日期（北京 9:00-12:00 / 14:00-18:00；生效日期待官方公告，00-gap-audit §4.2 E）；`peakPricing2x=true` 时条件必填                                          |
| `longContextThreshold` / `longContextInputPrice` | **废弃** | —                                          | v1 遗留，v2 迁入 `tieredPricing`（§7.1 迁移表 #17/#18）；新条目禁用，R3 后从结构移除                                                                                   |

### E. 缓存语义（12：条件必填 3 + 可选 9）

| 字段                      | 级别     | 类型 / 值域                                                     | 说明                                                                                                                                                                                                                                        |
| ------------------------- | -------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promptCacheMinTokens`    | 条件必填 | u64                                                             | 最低可缓存前缀（Anthropic 512~4096 / Kimi 256 / 百炼 1024 / 豆包隐式 1024 显式 256）；`supportsPromptCaching=true` 时必填；官方未公布时用参考值 + `notes`（GLM 百炼 512，01-glm.md §6.5）                                                   |
| `cacheType`               | 可选     | `"auto" \| "explicit" \| "key" \| "both" \| "none"`             | 缓存轨分类（v2 值域：v1 `automatic` 更名 `auto`，新增 `key` = 显式 cache key 路由，OpenAI prompt_cache_options / Kimi prompt_cache_key 轨）；`"none"` = 不参与任何缓存                                                                      |
| `cacheMechanism`          | 可选     | `"prefix" \| "similarity" \| "disk_unit" \| "session" \| "key"` | 实现机制标注（v1 值域 + `key`）                                                                                                                                                                                                             |
| `supportsPromptCaching`   | **必填** | bool                                                            | 是否参与任何形式缓存（behavior.rs 与 TTL 路由的开关位）                                                                                                                                                                                     |
| `supportsImplicitCaching` | 可选     | bool                                                            | 自动隐式缓存能力（OpenRouter `/endpoints` `supports_implicit_caching` 语义，jcode 断点门控事实来源，02-sources §2.3）；缺省 = 与 `cacheType ∈ {auto, both}` 推断一致，显式 false = 自动轨存在但无法确认隐式命中（如 Kimi best-effort 口径） |
| `supportsPromptCacheKey`  | 可选     | bool                                                            | `prompt_cache_key` 请求字段支持（OpenAI / Kimi Coding Plan 必填语义，01-kimi.md §3.2）；behavior.rs `CacheBehavior::supports_prompt_cache_key` 的 v2 模型级覆盖来源                                                                         |
| `supportsCacheControl`    | 可选     | bool                                                            | Anthropic 式 `cache_control` 断点支持（GLM 未实测 = false，01-glm.md §6.1）                                                                                                                                                                 |
| `breakpointMax`           | 可选     | u8                                                              | 断点上限（Anthropic/MiniMax 4、百炼 4；OpenAI 写入上限 4 内 implicit 占 1）                                                                                                                                                                 |
| `lookbackBlocks`          | 可选     | u16                                                             | 回溯窗口（Anthropic/MiniMax/百炼 20）                                                                                                                                                                                                       |
| `cacheTtl`                | 可选     | `"5m" \| "30m" \| "1h" \| "24h"`                                | 默认 TTL 档（v2 值域扩 `"30m"`，gpt-5.6 系；官方未公布 = 省略，由 TTL 路由 vendor 默认兜底，ttl.rs:60-89）                                                                                                                                  |
| `cacheTtlOptions`         | 可选     | string[]                                                        | 可选 TTL 档位（Anthropic `["5m","1h"]`）；缺省 = `[cacheTtl]`                                                                                                                                                                               |

### F. 能力位（16：全部可选，缺省 false = 保守关闭）

> 分组：协议 3 / 推理 3 / 多模态 4 / 工具 3 / 其他 3。命名对齐 litellm `supports_*`（02-litellm §2.4）。

| 字段                                                          | litellm 对应                                                         | 说明                                                                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `supportsResponses`                                           | —（crish 扩展）                                                      | Responses API 支持（engine.rs `provider_url` 判定用）                                                |
| `supportsPromptCacheKey`                                      | —                                                                    | 见 E 组（v2 新增入目录）                                                                             |
| `supportsImplicitCaching`                                     | —                                                                    | 见 E 组（v2 新增入目录）                                                                             |
| `supportsReasoning`                                           | `supports_reasoning`                                                 | 思考模式支持                                                                                         |
| `supportsReasoningEffort`                                     | `supports_*_reasoning_effort`                                        | `reasoning_effort` 参数支持                                                                          |
| `reasoningEffortTiers`                                        | `reasoning_options`（models.dev）/ `supported_efforts`（OpenRouter） | effort 档位白名单（qwen3.8-max `["low","medium","xhigh"]`）；`supportsReasoningEffort=true` 时建议填 |
| `supportsVision`                                              | `supports_vision`                                                    | 视觉输入（GLM-5V-Turbo / kimi-k2.7-code 必须 true，01-glm.md §3.5③）                                 |
| `supportsAudioInput` / `supportsAudioOutput`                  | `supports_audio_input/output`                                        | 音频（OpenRouter `input_audio_cache` 18 条 Gemini 佐证，02-sources §6.2.3）                          |
| `supportsPdfInput`                                            | `supports_pdf_input`                                                 | PDF 输入                                                                                             |
| `supportsFunctionCalling` / `supportsParallelFunctionCalling` | 同名                                                                 | 函数调用（前端 `ModelCapabilityKey` 扫描合并面）                                                     |
| `supportsToolChoice`                                          | `supports_tool_choice`                                               | 工具选择                                                                                             |
| `supportsSystemMessages`                                      | `supports_system_messages`                                           | 系统消息                                                                                             |
| `supportsResponseSchema`                                      | `supports_response_schema`                                           | 结构化输出                                                                                           |
| `supportsWebSearch`                                           | `supports_web_search`                                                | 联网搜索（按查询计费价不收录，00-gap-audit §4.3）                                                    |
| `supportsAssistantPrefill` / `supportsComputerUse`            | 同名                                                                 | 预填充 / 电脑使用                                                                                    |

### G. 溯源与生命周期（7：必填 2 + 条件必填 2 + 可选 3）

| 字段                          | 级别     | 类型                                                                                                               | 说明                                                                                                                                        |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `sourceUrl`                   | **必填** | string                                                                                                             | 条目数据来源 URL（远程源条目 = 远程源 URL，如 `https://models.dev/api.json`）                                                               |
| `dataVerifiedAt`              | **必填** | string（YYYY-MM-DD）                                                                                               | 条目核实日期（v2 全量回填 2026-08-03，R1 复核日）                                                                                           |
| `dataSource`                  | 条件必填 | `"static" \| "official" \| "channel" \| "remote:models.dev" \| "remote:openrouter" \| "derived" \| "litellm-copy"` | 数据口径标注：官方转录 / 转售通道 / 远程源导入 / 比例推导 / litellm 本地副本（gpt-5.x 旧条目现状，00-gap-audit §4.2 G）；非官方直连口径必填 |
| `retired` / `deprecationDate` | 条件必填 | bool / string                                                                                                      | 退役标记 + 弃用日期（R0.5 表 3 #2 落地）；退役模型收录时必填（Opus 4.1 / Sonnet 4 / Haiku 3.5 收录政策由调度者裁决，00-gap-audit §5.2 A）   |
| `promoExpiresAt`              | 可选     | string（YYYY-MM-DD）                                                                                               | 促销价到期（Sonnet 5 `2026-08-31`；GLM-4.5-Air 5 折；qwen3.7-max 5 折）；到期后 P5 切 `promoReplacesAt` 指向价行（日期切换域）              |
| `promoReplacesAt`             | 可选     | string                                                                                                             | 促销到期后的替代价行日期（Sonnet 5 9/1 涨价行，00-gap-audit §4.2 G）                                                                        |
| `notes`                       | 可选     | string                                                                                                             | 自由备注（口径差异、参考值来源、未实测项、待复核项）                                                                                        |

---

## 3. 嵌套结构定义

### 3.1 `tieredPricing`（TieredPriceTier[]）

> 结构参考 litellm `tiered_pricing` 的 `range: [min, max)` 半开区间（02-litellm §2.2/§6.3），补充每档 cacheRead/cacheWrite 与输出长度组合约束；与 models.dev `cost.tiers` / `context_over_200k`、OpenRouter `pricing.overrides`（`min_prompt_tokens` 语义）等价。

```json
"tieredPricing": [
  {
    "minTokens": 32000,
    "maxTokens": null,
    "minOutputTokens": null,
    "maxOutputTokens": null,
    "inputPrice": 7.0,
    "outputPrice": 26.0,
    "cacheReadPrice": 1.8,
    "cacheWritePrice": null
  }
]
```

| 字段                                                                | 类型        | 语义                                                                                 |
| ------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------ |
| `minTokens`                                                         | u64         | 输入长度下界（半开区间下界，含）                                                     |
| `maxTokens`                                                         | u64 \| null | 输入长度上界（半开区间上界，不含）；`null` = 无上界（长上下文档档）                  |
| `minOutputTokens` / `maxOutputTokens`                               | u64 \| null | 输出长度组合约束（GLM-4.7 / 4.5-Air 的 200K 边界，01-glm.md §3.5②）；`null` = 无约束 |
| `inputPrice` / `outputPrice` / `cacheReadPrice` / `cacheWritePrice` | f64 \| null | 该档四价；`null` = 沿用基础四价（该字段不退场）                                      |

**匹配与约束规则**：

1. 档位命中 = `minTokens ≤ inputTokens < maxTokens`（maxTokens 为 null 恒命中）**且**输出约束（若存在）`minOutputTokens ≤ outputTokens < maxOutputTokens`；
2. 按数组顺序**首个命中**生效；档位区间不得重叠（转录校验约束；GLM-4.7 三档为输入 × 输出组合展开，01-glm.md §3.4）；
3. **基础四价（`inputPrice` 等条目字段）= 未命中任何档时的价格**；含 tieredPricing 的条目成本计算必须按档匹配，不得直接取基础价；
4. 长上下文档 2x 档 = 只有 `minTokens` 的档（Grok ≥200K、MiniMax M3 >512K、gpt-5.6 272K、GLM [32K, ∞)）；
5. doubao 官方分段按「千 token」表述（`[0,32]` = [0, 32000) token），转录时换算为 token 整数（01-doubao.md §1）；
6. highspeed 等速度变体**不得**建模为 tiered（价格 2x 非长度相关），独立条目（01-minimax.md §7.1）。

### 3.2 `derivation`（PriceDerivation，`priceStatus="derived"` 时必填）

```json
"derivation": {
  "note": "官方仅公布比例：显式命中 10%、显式创建 125%、隐式命中 20%；绝对价 = 官方比例 × 官方输入价（华北2 北京）",
  "cacheReadFactor": 0.1,
  "cacheWriteFactor": 1.25,
  "implicitCacheReadFactor": 0.2
}
```

| 字段                      | 类型        | 语义                                                                            |
| ------------------------- | ----------- | ------------------------------------------------------------------------------- |
| `note`                    | string      | 推导依据文字说明（必填）                                                        |
| `cacheReadFactor`         | f64 \| null | 显式命中比例（qwen 0.1）                                                        |
| `cacheWriteFactor`        | f64 \| null | 显式创建比例（qwen 1.25）                                                       |
| `implicitCacheReadFactor` | f64 \| null | 隐式命中比例（qwen 0.2；目录不存隐式绝对价，供 P5 按比例折算，01-qwen.md §8.3） |

> 推导价可入成本计算，但 P5 与前端须感知 `priceStatus="derived"`（估算可信度降级）；如需官方绝对价须登录控制台核对（01-qwen.md §6）。

### 3.3 `peakPricingSchedule`（PeakPricingSchedule）

```json
"peakPricingSchedule": {
  "windows": ["09:00-12:00", "14:00-18:00"],
  "tz": "Asia/Shanghai",
  "effectiveFrom": null,
  "note": "生效日期待官方公告"
}
```

`effectiveFrom`（YYYY-MM-DD | null）= 峰谷生效日期（DeepSeek 待公告，00-gap-audit §4.2 E / R1 DeepSeek 任务书 C）。

### 3.4 顶层文件包装

```json
{
  "version": 0,
  "schema": "2.0",
  "updatedAt": "2026-08-03",
  "entries": { "vendor::model": { ...条目... } }
}
```

| 字段        | 语义                                                                                                                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`   | 文件版本号（整数）。内置静态表起始 0；`catalog_refresh` 远程合并 / 覆盖回写后 +1（对齐 litellm `_model_cost_mutation_generation` 与运行时 `ModelCatalog::version()`，catalog.rs:177-180）。同版本幂等、新版本覆盖旧版本 |
| `schema`    | `"2.0"`（字段集版本，防止旧消费方误解析新字段集）                                                                                                                                                                       |
| `updatedAt` | 文件级更新时间（与条目级 `dataVerifiedAt` 互补：文件级管「批」，条目级管「条」）                                                                                                                                        |
| `entries`   | 条目映射（键 = `vendor::model`，与 v1 同构）                                                                                                                                                                            |

---

## 4. 版本与更新（远程源）

### 4.1 远程源字段映射（models.dev / OpenRouter → v2 条目）

> 结论基线：主源 models.dev、增强源 OpenRouter（仅 openrouter 类 provider 条目）、LiteLLM 不拉取（02-model-catalog-sources.md §5.1）。

| 远程字段                                                                 | v2 字段                              | 处理                                                                                                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cost.input` / `cost.output`                                             | `inputPrice` / `outputPrice`         | per-1M 数值直填（同单位）                                                                                                                                  |
| `cost.cache_read`                                                        | `cacheReadPrice`                     | 缺失 = null                                                                                                                                                |
| `cost.cache_write`                                                       | `cacheWritePrice` + `cacheWriteFree` | 缺失或 `0` → `0` + `true`（显式写免费）                                                                                                                    |
| `cost.tiers` / `context_over_200k`（OpenRouter `overrides`）             | `tieredPricing`                      | `tier.size` / `min_prompt_tokens` → `minTokens`；每档四价直填                                                                                              |
| `cost.reasoning`                                                         | `reasoningPrice`                     | 记入条目，消费在 P5                                                                                                                                        |
| `limit.context` / `limit.output`                                         | `contextWindow` / `maxOutputTokens`  | 直填                                                                                                                                                       |
| `reasoning_options[].values`（OpenRouter `reasoning.supported_efforts`） | `reasoningEffortTiers`               | 档位白名单                                                                                                                                                 |
| `status: "deprecated"`                                                   | `retired: true` + `deprecationDate`  | 覆盖率仅 3.8%，不作唯一依据（02-sources §1.2）                                                                                                             |
| `/endpoints` `supports_implicit_caching`                                 | `supportsImplicitCaching`            | 仅 openrouter 渠道条目 / 断点门控                                                                                                                          |
| OpenRouter `input_cache_write_1h`                                        | `cacheWritePrice1h`                  | 21 条 Anthropic（models.dev 无此字段，02-sources §6.2.1）                                                                                                  |
| provider id / model 名                                                   | `vendor` / `model`                   | 照抄 jcode `models_dev_provider_id` 映射（moonshotai→kimi、zai→glm）+ 去版本后缀兜底（`deepseek-v4-flash-0731` → `deepseek-v4-flash`，catalog.rs:470-476） |
| —                                                                        | `dataSource`                         | **必填** `"remote:models.dev"` / `"remote:openrouter"`                                                                                                     |
| —                                                                        | `sourceUrl`                          | `https://models.dev/api.json`（或 OpenRouter 端点 URL）                                                                                                    |
| —                                                                        | `dataVerifiedAt`                     | 抓取日期                                                                                                                                                   |

### 4.2 冲突裁决（优先级从高到低，02-sources §5.3 定稿）

1. **内置静态表 + 用户覆盖**（`catalog.json` + `catalog-overrides.json`）：人工审定条目（含 CNY、双档写价、存储费、推导标注）——**远程源永远不覆盖人工值**；P3 覆盖白名单（禁改 model / provider / vendor 三键，catalog.rs:357-364）对远程导入同生效。
2. **models.dev 官方价**：填充 / 更新静态表缺失的 USD 四指标，写入带 `dataSource: "remote:models.dev"` + 抓取日期。
3. **OpenRouter 价**：**仅当条目 provider 段是 openrouter 类渠道时**采用（`vendor=deepseek, provider=openrouter` 转售条目）；同模型直连官方价与 OpenRouter 折扣价差异巨大（glm-5.2 约五折、deepseek read 0.028 vs 0.0028 差 10 倍），**禁止跨渠道覆盖**（02-sources §2.4）。
4. **同键同源**：以 `dataVerifiedAt` 新者胜；**同键异源**：按 1 > 2 > 3 定夺，不合并均价。
5. 合并入口统一走 `catalog_refresh`（与 `upsert_from_scan` / `with_overrides` 同一合并链），任何变更 `version` +1。

---

## 5. JSON 示例（6 条完整条目）

> 示例为 v2 权威形态；数字来源已在 `sourceUrl` / `dataVerifiedAt` / `notes` 标注；标注「示例」的为键形态与结构演示（gpt-5.6-sol 为虚构模型名，价格基座 = gpt-5.6 系 R1 数据）。

### 5.1 Anthropic claude-opus-5（双档写价 5m/1h，USD）

```json
"anthropic::claude-opus-5": {
  "id": "claude-opus-5",
  "model": "claude-opus-5",
  "provider": "anthropic",
  "vendor": "anthropic",
  "mode": "chat",
  "currency": "USD",
  "unit": "per_1M",
  "contextWindow": 1000000,
  "maxOutputTokens": 128000,
  "inputPrice": 5.0,
  "outputPrice": 25.0,
  "cacheReadPrice": 0.5,
  "cacheWritePrice5m": 6.25,
  "cacheWritePrice1h": 10.0,
  "cacheWriteFree": false,
  "promptCacheMinTokens": 512,
  "cacheType": "both",
  "cacheMechanism": "prefix",
  "supportsPromptCaching": true,
  "supportsImplicitCaching": false,
  "supportsCacheControl": true,
  "breakpointMax": 4,
  "lookbackBlocks": 20,
  "cacheTtl": "5m",
  "cacheTtlOptions": ["5m", "1h"],
  "supportsResponses": false,
  "supportsReasoning": true,
  "supportsReasoningEffort": false,
  "supportsVision": false,
  "sourceUrl": "https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching",
  "dataVerifiedAt": "2026-08-03",
  "dataSource": "official"
}
```

要点：1h 档 = `cacheWritePrice1h`（litellm `_above_1hr` 直抄，02-litellm §4.2）；上下文窗口为 R1 补录值（models.dev 口径）；`cacheTtlOptions` 暴露 5m/1h 双档供 P2 wire 层 TTL 桶选择。

### 5.2 OpenAI gpt-5.6-sol（30m TTL 档 + 272K 长上下文档）

```json
"openai::gpt-5.6-sol": {
  "id": "gpt-5.6-sol",
  "model": "gpt-5.6-sol",
  "provider": "openai",
  "vendor": "openai",
  "mode": "both",
  "currency": "USD",
  "unit": "per_1M",
  "contextWindow": 1050000,
  "maxOutputTokens": 128000,
  "inputPrice": 5.0,
  "outputPrice": 30.0,
  "cacheReadPrice": 0.5,
  "cacheWritePrice": 6.25,
  "cacheWriteFree": false,
  "promptCacheMinTokens": 1024,
  "cacheType": "both",
  "cacheMechanism": "prefix",
  "supportsPromptCaching": true,
  "supportsImplicitCaching": true,
  "supportsPromptCacheKey": true,
  "supportsCacheControl": false,
  "cacheTtl": "30m",
  "cacheTtlOptions": ["30m"],
  "tieredPricing": [
    {
      "minTokens": 272000,
      "maxTokens": null,
      "inputPrice": 10.0,
      "outputPrice": 45.0,
      "cacheReadPrice": 1.0,
      "cacheWritePrice": 12.5
    }
  ],
  "supportsResponses": true,
  "supportsReasoning": true,
  "supportsReasoningEffort": true,
  "sourceUrl": "https://platform.openai.com/docs/guides/prompt-caching",
  "dataVerifiedAt": "2026-08-03",
  "dataSource": "official",
  "notes": "示例条目（模型名虚构，价格基座 = gpt-5.6 系 R1 数据）；TTL 30m 为 v2 值域扩展档（ttl.rs CacheTtl 需扩档）；272K 档参考 models.dev cost.tiers"
}
```

要点：`cacheTtl: "30m"` 展示新档（v1 三档枚举外的第四档，gpt-5.6 系 TTL 仅 30m 语义，ttl.rs:93-97 现按 5m 保守预警，扩档后可销账）；长上下文档档 = 仅 `minTokens` 的半开无上界档。

### 5.3 DeepSeek deepseek-v4-flash（写免费显式 + USD + 峰谷 + 推理价）

```json
"deepseek::deepseek-v4-flash": {
  "id": "deepseek-v4-flash",
  "model": "deepseek-v4-flash",
  "provider": "deepseek",
  "vendor": "deepseek",
  "mode": "both",
  "currency": "USD",
  "unit": "per_1M",
  "contextWindow": 1000000,
  "maxOutputTokens": 384000,
  "inputPrice": 0.14,
  "outputPrice": 0.28,
  "cacheReadPrice": 0.0028,
  "cacheWritePrice": 0.0,
  "cacheWriteFree": true,
  "reasoningPrice": 0.28,
  "promptCacheMinTokens": 1024,
  "cacheType": "auto",
  "cacheMechanism": "disk_unit",
  "supportsPromptCaching": true,
  "supportsImplicitCaching": true,
  "supportsCacheControl": false,
  "cacheTtl": "5m",
  "peakPricing2x": true,
  "peakPricingSchedule": {
    "windows": ["09:00-12:00", "14:00-18:00"],
    "tz": "Asia/Shanghai",
    "effectiveFrom": null,
    "note": "生效日期待官方公告"
  },
  "supportsResponses": true,
  "supportsReasoning": true,
  "supportsReasoningEffort": true,
  "sourceUrl": "https://api-docs.deepseek.com/quick_start/pricing",
  "dataVerifiedAt": "2026-08-03",
  "dataSource": "official"
}
```

要点：写免费三件套（`0` + `true` + read 为 input 2%）齐出；`reasoningPrice = 0.28`（models.dev `cost.reasoning`，与输出价同值，02-sources §1.2）；`cacheType: "auto"`（v1 `automatic` 更名）；峰谷 `effectiveFrom: null` 表示生效日期待公告。

### 5.4 Kimi kimi-k2.7-code（CNY + 写免费 + prompt_cache_key 必填轨）

```json
"kimi::kimi-k2.7-code": {
  "id": "kimi-k2.7-code",
  "model": "kimi-k2.7-code",
  "provider": "kimi",
  "vendor": "kimi",
  "mode": "chat",
  "currency": "CNY",
  "unit": "per_1M",
  "contextWindow": 262144,
  "inputPrice": 6.5,
  "outputPrice": 27.0,
  "cacheReadPrice": 1.3,
  "cacheWritePrice": 0.0,
  "cacheWriteFree": true,
  "promptCacheMinTokens": 256,
  "cacheType": "auto",
  "cacheMechanism": "prefix",
  "supportsPromptCaching": true,
  "supportsImplicitCaching": true,
  "supportsPromptCacheKey": true,
  "supportsCacheControl": false,
  "supportsResponses": false,
  "supportsReasoning": true,
  "supportsVision": true,
  "supportsToolChoice": true,
  "sourceUrl": "https://platform.kimi.com/docs/pricing/chat-k27-code.md",
  "dataVerifiedAt": "2026-08-03",
  "dataSource": "official",
  "notes": "官方 TTL 系统管理未公布（省略 cacheTtl，TTL 路由按 vendor 默认 5m 预警）；maxOutputTokens 官方未公布（models.dev 口径未取，留空）；reasoningEffort 档位未确认（不声明）"
}
```

要点：CNY 币种显式；`supportsPromptCacheKey: true`（Coding Plan 必填语义，01-kimi.md §3.2）；`supportsVision` 必须 true（K2.7-Code 支持视觉与工具调用，01-kimi.md §4.2）；`maxOutputTokens` 未获取 = 省略 + `notes` 说明（诚实边界，不编造）。

### 5.5 智谱 GLM-5V-Turbo（CNY + 输入分档 + 存储费 + vision）

```json
"glm::glm-5v-turbo": {
  "id": "glm-5v-turbo",
  "model": "glm-5v-turbo",
  "provider": "bigmodel",
  "vendor": "glm",
  "mode": "chat",
  "currency": "CNY",
  "unit": "per_1M",
  "contextWindow": 200000,
  "maxOutputTokens": 131072,
  "inputPrice": 5.0,
  "outputPrice": 22.0,
  "cacheReadPrice": 1.2,
  "cacheWritePrice": 0.0,
  "cacheWriteFree": true,
  "storagePricePer1mHour": 0.0,
  "storagePriceFreeUntil": "2026-08-31",
  "promptCacheMinTokens": 512,
  "cacheType": "auto",
  "cacheMechanism": "similarity",
  "supportsPromptCaching": true,
  "supportsImplicitCaching": true,
  "supportsCacheControl": false,
  "cacheTtl": "5m",
  "tieredPricing": [
    {
      "minTokens": 32000,
      "maxTokens": null,
      "inputPrice": 7.0,
      "outputPrice": 26.0,
      "cacheReadPrice": 1.8,
      "cacheWritePrice": null
    }
  ],
  "supportsVision": true,
  "supportsResponses": false,
  "supportsReasoning": true,
  "sourceUrl": "https://open.bigmodel.cn/pricing",
  "dataVerifiedAt": "2026-08-03",
  "dataSource": "official",
  "notes": "基础价 = 输入 [0, 32K) 档，tieredPricing = 输入 [32K, ∞) 档（01-glm.md §3.2）；缓存存储费当前限时免费（2026-08-31 前复核恢复价）；cache_control 未实测保守 false；多模态输入按内容构成计量计费"
}
```

要点：国内站「命中价 + 存储费」双字段模型（01-glm.md §3.5①，无 cache_write 概念 → 写免费显式）；32K 输入分档（基础价 = 首档，增量档只列差异）；`storagePricePer1mHour: 0` + `storagePriceFreeUntil` 表达限时免费；`provider: "bigmodel"`（CNY 国内站）与 USD 站（`provider: "zai"`）双条目并列（01-glm.md §7）。

### 5.6 阿里 qwen3.8-max（CNY + 推导价标注 + 双轨缓存）

```json
"qwen::qwen3.8-max": {
  "id": "qwen3.8-max",
  "model": "qwen3.8-max",
  "provider": "dashscope",
  "vendor": "qwen",
  "mode": "both",
  "currency": "CNY",
  "unit": "per_1M",
  "contextWindow": 1000000,
  "inputPrice": 12.0,
  "outputPrice": 36.0,
  "cacheReadPrice": 1.2,
  "cacheWritePrice": 15.0,
  "cacheWriteFree": false,
  "priceStatus": "derived",
  "derivation": {
    "note": "官方仅公布比例：显式命中 10%、显式创建 125%、隐式命中 20%；绝对价 = 官方比例 × 官方输入价（华北2 北京）",
    "cacheReadFactor": 0.1,
    "cacheWriteFactor": 1.25,
    "implicitCacheReadFactor": 0.2
  },
  "promptCacheMinTokens": 1024,
  "cacheType": "both",
  "cacheMechanism": "prefix",
  "supportsPromptCaching": true,
  "supportsImplicitCaching": true,
  "supportsPromptCacheKey": false,
  "supportsCacheControl": true,
  "breakpointMax": 4,
  "lookbackBlocks": 20,
  "cacheTtl": "5m",
  "supportsResponses": true,
  "supportsReasoning": true,
  "supportsReasoningEffort": true,
  "reasoningEffortTiers": ["low", "medium", "xhigh"],
  "supportsVision": true,
  "sourceUrl": "https://help.aliyun.com/zh/model-studio/billing-for-model-studio",
  "dataVerifiedAt": "2026-08-03",
  "dataSource": "official",
  "notes": "cacheRead/cacheWrite 为官方比例推导值（非官方绝对价，控制台需登录核对）；隐式命中 20% 仅 P5 按比例折算；Session 缓存响应 id 有效 7 天"
}
```

要点：`priceStatus: "derived"` + `derivation` 结构化标注（01-qwen.md §6 建议落地）；显式缓存（10% 命中 / 125% 创建）+ 隐式（20%）+ Session 三轨并存 → `cacheType: "both"` + `supportsImplicitCaching: true` + `supportsResponses: true`（Session 缓存走 Responses，01-qwen.md §4.3）；`reasoningEffortTiers` 展示 effort 白名单；`supportsVision: true`（多模态输入，01-qwen.md §1.1）。

---

## 6. Rust 类型对应（ModelCatalogEntry v2 serde 草案）

> 与 v1 相同的不变量：全字段 `#[serde(default)]` 可缺省解析（A3 P2-10 测试钉死，catalog.rs:618-635）；serde `rename_all = "camelCase"`；顶层键 `vendor::model`。文件级包装新增 `ModelCatalogFile`。

```rust
/// v2 目录条目（catalog.json v2；全字段可缺省，`#[serde(default)]`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelCatalogEntry {
    // ── 标识（A 组）──
    /// 条目稳定唯一 ID（缺省派生 vendor::model；跨源合并锚点 / 前端键）
    pub id: Option<String>,
    /// 目录内模型标识（顶层键 vendor::model 组成部分）
    pub model: String,
    /// API 真实请求标识（点号异形；缺省 = model）
    pub api_model: Option<String>,
    /// 通道/网关标识
    pub provider: String,
    /// 官方厂商
    pub vendor: String,
    /// 协议模式："chat" | "responses" | "both"
    pub mode: Option<String>,
    /// 计价币种：USD / CNY（必填语义由校验层钉死）
    pub currency: Option<String>,
    /// 计价单位（v2 唯一值 "per_1M"）
    pub unit: Option<String>,

    // ── 窗口（B 组）──
    /// 输入上下文窗口（token）
    pub context_window: Option<u64>,
    /// 输出上限（token）
    pub max_output_tokens: Option<u64>,

    // ── 四指标价格（C 组）──
    pub input_price: Option<f64>,
    pub output_price: Option<f64>,
    pub cache_read_price: Option<f64>,
    /// 通用写价（写免费 = 0 + cache_write_free = true；null = 未收录）
    pub cache_write_price: Option<f64>,
    /// Anthropic 5m 档写价
    pub cache_write_price_5m: Option<f64>,
    /// Anthropic 1h 档写价（above_1hr）
    pub cache_write_price_1h: Option<f64>,
    /// 写免费显式位（true 时 cache_write_price 必须为 0 或 null）
    pub cache_write_free: bool,

    // ── 扩展价格（D 组）──
    /// 缓存存储费（/1M·h，小时计时）
    pub storage_price_per_1m_hour: Option<f64>,
    /// 存储费限时免费到期日（YYYY-MM-DD）
    pub storage_price_free_until: Option<String>,
    /// 推理 token 计价（models.dev cost.reasoning；P5 消费）
    pub reasoning_price: Option<f64>,
    /// 价格形态："official" | "derived" | "unavailable"
    pub price_status: Option<String>,
    /// 推导标注（price_status = "derived" 时必填）
    pub derivation: Option<PriceDerivation>,
    /// DeepSeek 峰谷 2x 标记
    pub peak_pricing_2x: bool,
    /// 峰谷时段与生效日期
    pub peak_pricing_schedule: Option<PeakPricingSchedule>,
    /// 长度分档（基础四价 + 增量档；长上下文 2x 档 = minTokens 单边档）
    pub tiered_pricing: Option<Vec<TieredPriceTier>>,

    // ── 缓存语义（E 组）──
    pub prompt_cache_min_tokens: Option<u64>,
    /// "auto" | "explicit" | "key" | "both" | "none"
    pub cache_type: Option<String>,
    /// "prefix" | "similarity" | "disk_unit" | "session" | "key"
    pub cache_mechanism: Option<String>,
    pub supports_prompt_caching: bool,
    /// 自动隐式缓存能力（OpenRouter endpoints 语义）
    pub supports_implicit_caching: bool,
    /// prompt_cache_key 请求字段支持
    pub supports_prompt_cache_key: bool,
    pub supports_cache_control: bool,
    pub breakpoint_max: Option<u8>,
    pub lookback_blocks: Option<u16>,
    /// "5m" | "30m" | "1h" | "24h"
    pub cache_ttl: Option<String>,
    pub cache_ttl_options: Option<Vec<String>>,

    // ── 能力位（F 组，缺省 false = 保守）──
    pub supports_responses: bool,
    pub supports_reasoning: bool,
    pub supports_reasoning_effort: bool,
    pub reasoning_effort_tiers: Option<Vec<String>>,
    pub supports_vision: bool,
    pub supports_function_calling: bool,
    pub supports_parallel_function_calling: bool,
    pub supports_system_messages: bool,
    pub supports_response_schema: bool,
    pub supports_tool_choice: bool,
    pub supports_web_search: bool,
    pub supports_audio_input: bool,
    pub supports_audio_output: bool,
    pub supports_pdf_input: bool,
    pub supports_assistant_prefill: bool,
    pub supports_computer_use: bool,

    // ── 溯源与生命周期（G 组）──
    pub source_url: Option<String>,
    pub data_verified_at: Option<String>,
    /// "static" | "official" | "channel" | "remote:models.dev" | "remote:openrouter" | "derived" | "litellm-copy"
    pub data_source: Option<String>,
    pub notes: Option<String>,
    pub promo_expires_at: Option<String>,
    pub promo_replaces_at: Option<String>,
    pub deprecation_date: Option<String>,
    pub retired: bool,
}

/// 长度分档（§3.1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TieredPriceTier {
    /// 输入长度下界（含）
    pub min_tokens: u64,
    /// 输入长度上界（不含）；null = 无上界（长上下文档）
    pub max_tokens: Option<u64>,
    /// 输出长度组合约束下界（null = 无约束）
    pub min_output_tokens: Option<u64>,
    pub max_output_tokens: Option<u64>,
    /// 档内四价；null = 沿用基础四价
    pub input_price: Option<f64>,
    pub output_price: Option<f64>,
    pub cache_read_price: Option<f64>,
    pub cache_write_price: Option<f64>,
}

/// 推导标注（§3.2）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PriceDerivation {
    pub note: String,
    pub cache_read_factor: Option<f64>,
    pub cache_write_factor: Option<f64>,
    pub implicit_cache_read_factor: Option<f64>,
}

/// 峰谷时段（§3.3）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PeakPricingSchedule {
    pub windows: Vec<String>,
    pub tz: String,
    pub effective_from: Option<String>,
    pub note: Option<String>,
}

/// v2 文件包装（§3.4）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelCatalogFile {
    pub version: u64,
    pub schema: String,
    pub updated_at: Option<String>,
    pub entries: BTreeMap<String, ModelCatalogEntry>,
}
```

### 6.1 与 behavior.rs / ttl.rs 的衔接（消费矩阵）

| v2 字段                                       | 消费方                                                            | 现状与 v2 变化                                                                                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supportsPromptCaching`                       | behavior.rs `apply_catalog_overrides`                             | 已消费（behavior.rs:425-427）                                                                                                                                                          |
| `cacheType`                                   | behavior.rs `apply_catalog_overrides`                             | 已消费，匹配 `"automatic" \| "both"` → `auto_cache`（behavior.rs:429-431）；**v2 值域更名 `auto`，匹配串需同步改**（R3）                                                               |
| `supportsCacheControl`                        | behavior.rs                                                       | 已消费（behavior.rs:432-434）                                                                                                                                                          |
| `breakpointMax`                               | behavior.rs                                                       | 已消费（behavior.rs:435-437）                                                                                                                                                          |
| `cacheTtl`                                    | behavior.rs `default_ttl` + ttl.rs `cache_ttl_for_provider_model` | 已消费（behavior.rs:438-440 / ttl.rs:44-57）；**v2 值域增 `"30m"`，`CacheTtl` 需扩第四档**（现三档枚举 behavior.rs:70-80；gpt-5.6 30m 现按 5m 保守预警的注释 ttl.rs:93-97 扩档后销账） |
| `supportsPromptCacheKey`                      | behavior.rs `CacheBehavior::supports_prompt_cache_key`            | **v2 新增消费点**：现该位真源仅 vendor 矩阵（OPENAI/KIMI 行 true，behavior.rs:180/193），建议 R3 在 `apply_catalog_overrides` 增加模型级覆盖（显式 false 可关）                        |
| `supportsImplicitCaching`                     | behavior.rs `auto_cache`                                          | **v2 新增消费点**：现 `auto_cache` 由 vendor 矩阵 + `cacheType` 推断（behavior.rs:429-431），R3 可改为 `supportsImplicitCaching` 模型级覆盖（OpenRouter 端点实测值）                   |
| `supportsResponses`                           | engine.rs `provider_url` 判定（`supports_responses_for`）         | 已消费（catalog.rs:227-230）                                                                                                                                                           |
| `contextWindow` / `maxOutputTokens`           | `context_window_for` / `max_output_for`（P4 压缩层）              | 已消费（catalog.rs:203-210）                                                                                                                                                           |
| `promptCacheMinTokens`                        | `prompt_cache_min_tokens_for`（回退 1024）                        | 已消费（catalog.rs:214-218）                                                                                                                                                           |
| 价格族 + `currency`                           | P5 成本域 + 前端 `catalog_get` 快照                               | v2 新增 `priceStatus`/`derivation`/`tieredPricing` 消费点在 P5；前端见 §8                                                                                                              |
| `dataSource` / `sourceUrl` / `dataVerifiedAt` | `catalog_refresh` 合并链与冲突裁决                                | v2 新增消费（§4）                                                                                                                                                                      |

> 兼容性红线：behavior.rs / ttl.rs 目前只消费 6 个目录字段（上表前六行），v2 字段扩展对这两个模块零破坏（除 `cacheType` 值域更名与 `CacheTtl` 扩档两项 R3 必改项）。

---

## 7. 迁移：v1 28 条 → v2 字段映射表

### 7.1 字段级映射（v1 字段全集 = catalog.rs:24-104）

| v1 字段                                                                                                                                                                                                        | v2 状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 迁移说明                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`                                                                                                                                                                                                        | 保留 → `model`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 值不变；qwen3-7-max 等横/点异形条目补 `apiModel: "qwen3.7-max"`（01-qwen.md §6）                                                                               |
| `provider`                                                                                                                                                                                                     | 保留 → `provider`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 值不变                                                                                                                                                         |
| `vendor`                                                                                                                                                                                                       | 保留 → `vendor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 值不变                                                                                                                                                         |
| `mode`                                                                                                                                                                                                         | 保留 → `mode`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 可选                                                                                                                                                           |
| `currency`                                                                                                                                                                                                     | 保留 → `currency`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 28/28 已标（USD 21 / CNY 7），值不变                                                                                                                           |
| `unit`                                                                                                                                                                                                         | 保留 → `unit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 28/28 已标 `"per_1M"`                                                                                                                                          |
| `contextWindow`                                                                                                                                                                                                | 保留 → `contextWindow`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | gemini×4、fable-5/mythos-5/opus-5 缺口用 R1 值回填后全条目必填                                                                                                 |
| `maxInputTokens`                                                                                                                                                                                               | **删除**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | v1 结构字段但 28 条 0 实例、无消费方；litellm `max_tokens` LEGACY 教训（02-litellm 反模式 #5）                                                                 |
| `maxOutputTokens`                                                                                                                                                                                              | 保留 → `maxOutputTokens`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 值不变；缺条目按 R1/models.dev 口径补                                                                                                                          |
| `inputPrice` / `outputPrice`                                                                                                                                                                                   | 保留 → 同名                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 值不变（R1 复核一致，02-sources §附）；gpt-5.6/gpt-5.5/gemini×4 缺 outputPrice 按 R1 补录销账                                                                  |
| `cacheReadPrice`                                                                                                                                                                                               | 保留 → `cacheReadPrice`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 值不变                                                                                                                                                         |
| `cacheWritePrice`                                                                                                                                                                                              | 保留 → `cacheWritePrice`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | DeepSeek×2 显式 0 已齐；**9 条「写免费但无写价字段」补 `0` + `cacheWriteFree: true`**（gpt-5.5、kimi-k3、grok×2、minimax-m3、glm×4，00-gap-audit §4.4 回填项） |
| `cacheWritePrice5m`                                                                                                                                                                                            | 保留 → `cacheWritePrice5m`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Anthropic 7 条，值不变                                                                                                                                         |
| `cacheWritePrice1h`                                                                                                                                                                                            | 保留 → `cacheWritePrice1h`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Anthropic 7 条，值不变；MiniMax 1h 窗口语义不迁此字段（§2 C 组）                                                                                               |
| `storagePricePer1mHour`                                                                                                                                                                                        | 保留 → `storagePricePer1mHour`                                                                                                                                                                                                                                                                                                                                                                                                                                                                | gemini-3-6-flash / gemini-3-1-pro 有值；gemini-3-5-flash/lite 按 R1 补录；GLM 国内站条目 = `0` + `storagePriceFreeUntil`                                       |
| `longContextThreshold`                                                                                                                                                                                         | **废弃 → `tieredPricing[].minTokens`**                                                                                                                                                                                                                                                                                                                                                                                                                                                        | grok-4.5（200000）+ gemini-3-1-pro（200000）；消费方无，仅结构迁移                                                                                             |
| `longContextInputPrice`                                                                                                                                                                                        | **废弃 → `tieredPricing[].inputPrice`**                                                                                                                                                                                                                                                                                                                                                                                                                                                       | grok-4.5 = 4.0；gemini-3-1-pro 无长档价 = 档内价格 null（或 notes 标注）                                                                                       |
| `peakPricing2x`                                                                                                                                                                                                | 保留 → `peakPricing2x`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | deepseek×2 = true；新增 `peakPricingSchedule`（时段已知、生效日期 null）                                                                                       |
| `promptCacheMinTokens`                                                                                                                                                                                         | 保留 → `promptCacheMinTokens`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 值不变                                                                                                                                                         |
| `cacheType`                                                                                                                                                                                                    | 保留，值域更名 → `cacheType`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `"automatic"` → `"auto"`（约 20 条）；`"both"` 不变；behavior.rs 匹配串同步改（§6.1）                                                                          |
| `cacheMechanism`                                                                                                                                                                                               | 保留 → `cacheMechanism`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 值不变；值域新增 `"key"`                                                                                                                                       |
| `supportsCacheControl`                                                                                                                                                                                         | 保留 → `supportsCacheControl`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 值不变（GLM 未实测 = false 维持）                                                                                                                              |
| `supportsPromptCaching`                                                                                                                                                                                        | 保留 → `supportsPromptCaching`                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 值不变                                                                                                                                                         |
| `breakpointMax` / `lookbackBlocks`                                                                                                                                                                             | 保留 → 同名                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Anthropic 7 / minimax-m2 2 / qwen 3 条，值不变                                                                                                                 |
| `cacheTtl`                                                                                                                                                                                                     | 保留，值域扩展 → `cacheTtl`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `"5m"`/`"24h"` 值不变；新增 `"30m"` 档供 gpt-5.6 系                                                                                                            |
| `cacheWriteFree`                                                                                                                                                                                               | 保留 → `cacheWriteFree`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 已显式 6 条；v2 补全 13 条缺写价字段条目（见上 `cacheWritePrice` 行）                                                                                          |
| `supportsResponses` / `supportsReasoning` / `supportsReasoningEffort` / `supportsVision` / `supportsFunctionCalling` / `supportsParallelFunctionCalling` / `supportsSystemMessages` / `supportsResponseSchema` | 保留 → 同名                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 值不变；DeepSeek v4-pro `supportsResponses` 按 R1 官方窗口（2026 年 8 月初）复核翻转                                                                           |
| `deprecationDate`                                                                                                                                                                                              | 保留 → `deprecationDate`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | v1 28 条均空；退役模型收录时使用                                                                                                                               |
| `sourceUrl` / `dataVerifiedAt`                                                                                                                                                                                 | 保留 → 同名                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `dataVerifiedAt` 28 条 `2026-08-02` → **`2026-08-03`**（R1 复核日；catalog.rs:499-503 测试钉死值同步改，R3 域）                                                |
| —（新增 23）                                                                                                                                                                                                   | `id` / `apiModel` / `tieredPricing` / `reasoningPrice` / `priceStatus` / `derivation` / `peakPricingSchedule` / `storagePriceFreeUntil` / `cacheTtlOptions` / `supportsImplicitCaching` / `supportsPromptCacheKey` / `reasoningEffortTiers` / `supportsToolChoice` / `supportsWebSearch` / `supportsAudioInput` / `supportsAudioOutput` / `supportsPdfInput` / `supportsAssistantPrefill` / `supportsComputerUse` / `dataSource` / `notes` / `promoExpiresAt` / `promoReplacesAt` / `retired` | 缺省 false / null，不阻塞迁移（R3 回填按 §4.1 规则）                                                                                                           |

### 7.2 数据级注意事项（28 条）

1. 价格绝对值与 R1 三源抽查一致（deepseek-v4-flash 0.14/0.28/0.0028、claude-fable-5 10/50/1/12.5、glm-5.2 1.4/4.4/0.26 均吻合，02-sources §附）→ **价格不重录，只补缺**。
2. Sonnet 5 促销价钉死（$2/$10，8/31 前）→ 补 `promoExpiresAt: "2026-08-31"` + `promoReplacesAt: "2026-09-01"`（9/1 价行不收录，P5 日期切换域）。
3. MiniMax M3 现目录价 4.2/16.8/0.84 为**原价**，R1 确认现行价 = 永久五折 2.1/8.4/0.42（01-minimax.md §8.4）→ 迁移时更新四价。
4. qwen 3 条（qwen3-max / qwen3-7-max / qwen3-coder-plus）价格全空 → R1 已拿到官方价（01-qwen.md §2 主表），迁移时按推导口径落 `priceStatus: "derived"`；**新增 qwen3.8-max 条目**。
5. 目录键形态差异（grok 点号 `grok-4.5` vs 前端横线 `grok-4-5`）→ v2 以 `model`/`id` 字段统一，前端费率表键对齐（§8）。
6. GLM 4 条现为 USD（zai 直连口径）→ v2 新增 CNY 双条目（provider=bigmodel）后按 provider 区分，行为矩阵 vendor 仍为 `glm` 不变。

---

## 8. 与 pricingStore CATALOG_CACHE_RATES 的字段对齐（前端）

### 8.1 现状（pricingStore.ts:60-92）

- `CATALOG_CACHE_RATES`：28 键 ↔ 目录 28 条一一对应；形态为**费率**（readMultiplier = read/input、writeMultiplier = 写价系数，写免费 = 0），非绝对值。
- 键形态差异：目录 grok 点号（`grok::grok-4.5`）、前端横线（`'grok-4-5'`）→ 靠 `resolveCatalogRates` 的 includes 模糊匹配兜住（pricingStore.ts:95-108，00-gap-audit §2.3）。
- 已有绝对值优先路径：`resolveCatalogCachePrices` 三级费率第 1 级 = `catalog_get` 快照（pricingStore.ts:147-165）优先于静态费率表。

### 8.2 v2 对齐规则

| 项           | v2 处理                                                                                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 静态表键     | 改为与目录条目 `id`（= `vendor::model` 规范化）完全一致：`grok-4-5` → `grok-4.5`；includes 模糊匹配降级为兜底（保留）                                                                                                         |
| 费率表定位   | 费率（readMultiplier / writeMultiplier）在 v2 是**派生数据**，不再人工维护：read = `cacheReadPrice / inputPrice`，write = `cacheWriteFree ? 0 : cacheWritePrice / inputPrice`（双档厂商取通用档或 5m 档）；绝对值优先原则不变 |
| 快照下发     | `catalog_get` 快照条目增加 `currency`、`priceStatus`、`tieredPricing` 感知字段；CNY 条目按币种原值下发                                                                                                                        |
| CNY 估算路径 | R0.5 表 3 #5 风险维持（DEFAULT_PRICES 8 条 USD 静态价不含 Kimi/MiniMax/Qwen）→ v2 建议前端估算层按 `currency` 感知：CNY 条目按 ¥ 标注显示或经**前端汇率配置**换算，目录不做隐式换算（litellm 教训）；属 P5 成本域             |
| 写价双档     | 前端 `writePerMTok` 取目录 `cacheWritePrice ?? cacheWritePrice5m ?? 0`；1h 档写价前端不消费（P2 wire 层 TTL 桶语义）                                                                                                          |
| 30m TTL 档   | 前端不消费（TTL 为 Rust 侧行为）                                                                                                                                                                                              |

---

## 9. 校验规则清单（R3 转录/解析必执行）

1. **写价三态互斥**：`cacheWriteFree=true` ⇒ `cacheWritePrice ∈ {0, null}`；`cacheWritePrice > 0` ⇒ `cacheWriteFree=false`；`supportsPromptCaching=true` ⇒ 四价（input/output/read/write）不得全 null。
2. **禁止 0 占位**：价格未获取一律 `null` + `priceStatus` 标注；`0` 只允许表示「免费」（写免费、免费档模型、存储费限时免费）——litellm 占位 0 污染成本统计的教训（02-litellm 反模式 #3）。
3. **tieredPricing 档位**：区间不得重叠；`minTokens` 必填；`maxTokens < minTokens` 或档内全 null 即转录错误。
4. **能力位缺省 false**：扫描合并（`upsert_from_scan`）不得写入价格族与缓存语义（catalog.rs:279-292 不变量延续）。
5. **覆盖白名单**：model / provider / vendor 三键禁覆盖（catalog.rs:357-364）；v2 新字段 `tieredPricing`/`priceStatus`/`derivation` 若开放覆盖需先扩白名单（R3 裁决）。
6. **远程源约束**：`dataSource` 以 `remote:` 前缀的条目不得覆盖静态人工值；跨渠道价不得互相覆盖（§4.2）。
7. **键一致性**：顶层键 = `vendor::model` 且与条目 `model`/`vendor` 字段一致（catalog.rs:484-504 测试钉死的防转录漂移校验延续）。
8. **dataVerifiedAt 格式**：YYYY-MM-DD；缺失即校验失败（v1 测试钉死项，catalog.rs:499-503）。
