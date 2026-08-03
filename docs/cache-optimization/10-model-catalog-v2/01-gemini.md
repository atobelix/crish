# Google Gemini 模型清单与定价调研（R1，模型目录与定价 v2 专项）

- 撰写日期：2026-08-03
- 任务：R1 调研子代理，产出 Gemini 全量在售模型清单 + 四指标价格（input / output / cache_read / 显式缓存存储费）+ 上下文窗口 + 缓存机制说明
- 数据口径：**USD / 1M tokens**（存储费为 USD / 1M tokens / 小时）
- 来源与获取日期：
  1. https://cloud.google.com/vertex-ai/generative-ai/pricing —— 官方定价表（2026-08-03 抓取成功，含标准 / Priority / Flex-Batch 三档与 Context Cache Storage 存储费表；Gemini API 与 Vertex AI 定价一致）
  2. https://models.dev/api.json —— 模型清单与窗口交叉验证（2026-08-03 抓取成功，google 厂商 41 条目 + openrouter 渠道 32 条 google 条目，双方价格一致）
  3. https://ai.google.dev/gemini-api/docs/models 与 /docs/pricing —— **本次 4 次抓取均 transport error，未获取**（缓存机制要点沿用 `docs/cache-optimization/01-reference-research/vendor-cache-mechanisms.md` §6 已确认条目，R0 调研记录）
- 与 `00-vendor-model-pricing-catalog.md` §8.1（R0）的关系：下表以 2026-08-03 官方数据为准，与 §8.1 冲突处已在文末「与 R0 目录的差异修正」节逐条标注

---

## 1. 在售文本模型主表（$/1M tokens，官方标准档）

命中价统一为「未缓存输入价 × 10%」（官方定价表逐行确认）；「>200K」列仅在有长上下文加价时填写。

| 模型（API 名）                     | 上下文    | 输出上限 | input（≤200K） | input（>200K） | output（≤200K） | output（>200K） | cache_read（≤200K） | cache_read（>200K） | 显式缓存存储费（/1M tok·h） | 备注                                                                 |
| ---------------------------------- | --------- | -------- | -------------- | -------------- | --------------- | --------------- | ------------------- | ------------------- | --------------------------- | -------------------------------------------------------------------- |
| gemini-3.6-flash                   | 1,048,576 | 65,536   | $1.50          | 同左           | $7.50           | 同左            | $0.15               | 同左                | 未获取（见 §5）             | 2026-07-21 发布；多模态含音频输入；effort 档 minimal/low/medium/high |
| gemini-3.5-flash                   | 1,048,576 | 65,536   | $1.50          | 同左           | $9.00           | 同左            | $0.15               | 同左                | 未获取（见 §5）             | 2026-05-19 发布；当前 flash 主力档                                   |
| gemini-3.5-flash-lite              | 1,048,576 | 65,536   | $0.30          | 同左           | $2.50           | 同左            | $0.03               | 同左                | 未获取（见 §5）             | 2026-07-21 发布；低成本档                                            |
| gemini-3.1-pro-preview             | 1,048,576 | 65,536   | $2.00          | $4.00          | $12.00          | $18.00          | $0.20               | $0.40               | $4.50                       | 长上下文加价 2x；effort 档 low/medium/high                           |
| gemini-3.1-pro-preview-customtools | 1,048,576 | 65,536   | $2.00          | $4.00          | $12.00          | $18.00          | $0.20               | $0.40               | $4.50                       | 3.1 Pro 专用自定义工具变体，价格同源                                 |
| gemini-3-pro-preview               | 1,048,576 | 65,536   | $2.00          | $4.00          | $12.00          | $18.00          | $0.20               | $0.40               | $4.50                       | 2025-11-18 发布；旗舰档；effort 档 low/high                          |
| gemini-3-flash-preview             | 1,048,576 | 65,536   | $0.50          | 同左           | $3.00           | 同左            | $0.05               | 同左                | $1.00                       | 2025-12-17 发布；音频输入 $1.00/命中 $0.10                           |
| gemini-3.1-flash-lite              | 1,048,576 | 65,536   | $0.25          | 同左           | $1.50           | 同左            | $0.025              | 同左                | $1.00                       | 2026-05-07 发布；音频输入 $0.50/命中 $0.05                           |
| gemini-2.5-pro                     | 1,048,576 | 65,536   | $1.25          | $2.50          | $10.00          | $15.00          | $0.13               | $0.25               | $4.50                       | 长上下文加价 2x；仍为稳定 GA 档                                      |
| gemini-2.5-flash                   | 1,048,576 | 65,536   | $0.30          | 同左           | $2.50           | 同左            | $0.03               | 同左                | $1.00                       | 音频输入 $1.00/命中 $0.10                                            |
| gemini-2.5-flash-lite              | 1,048,576 | 65,536   | $0.10          | 同左           | $0.40           | 同左            | $0.01               | 同左                | $1.00                       | 音频输入 $0.30/命中 $0.03                                            |
| gemini-2.0-flash                   | 1,048,576 | 8,192    | $0.10          | 同左           | $0.40           | 同左            | $0.025              | 同左                | 未获取                      | 旧档，仅作归档参考                                                   |
| gemini-2.0-flash-lite              | 1,048,576 | 8,192    | $0.075         | 同左           | $0.30           | 同左            | 未获取              | 同左                | 未获取                      | 旧档，仅作归档参考                                                   |

别名（官方稳定别名，指向对应在售模型）：`gemini-flash-latest` → 3.5-flash；`gemini-flash-lite-latest` → 3.1-flash-lite。

### 1.1 长上下文（>200K）档位结论

- **有加价（2x）**：gemini-3.1-pro-preview（输入 $4、输出 $18）、gemini-3-pro-preview（同构）、gemini-2.5-pro（输入 $2.50、输出 $15）。
- **无加价**：3.6/3.5/3.5-lite flash、3-flash-preview、3.1-flash-lite、2.5-flash、2.5-flash-lite、2.0-flash。
- 官方口径：**超过 200K 时全部 token（含输出）按长上下文价计费**（非仅超出的部分）；缓存命中同样分 ≤200K / >200K 两档（见 3.1 Pro 行）。

---

## 2. 变体与特化模型表（非通用对话，$/1M 或按量另注）

| 模型                                                                                     | 上下文        | input               | output                                                   | cache_read | 备注                                                                         |
| ---------------------------------------------------------------------------------------- | ------------- | ------------------- | -------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------- |
| gemini-omni-flash-preview                                                                | 131,072       | $1.50               | $9.00（文本）；视频输出 $0.10/秒（$17.50/1M 视频 token） | 未获取     | 全模态（含视频输出）；输入按 2040 tok/图、32 tok/音频秒、5792 tok/视频秒折算 |
| deep-research-preview-04-2026 / deep-research-max-preview-04-2026（Deep Research Agent） | 131,072       | $2.00               | $12.00                                                   | $0.20      | 官方「Agents」分类独立定价                                                   |
| CodeMender（gemini-3.5-flash 驱动）                                                      | —             | $1.50               | —                                                        | $0.15      | 代码修复专用产品线                                                           |
| gemini-3.1-flash-image（Nano Banana 2）                                                  | 65,536        | $0.50               | $3.00 文本；图像输出 $60                                 | $0.05      | 输入按 1120 tok/图                                                           |
| gemini-3.1-flash-lite-image（Nano Banana 2 Lite）                                        | 65,536        | $0.25               | $1.50 文本；图像输出 $30                                 | $0.025     | 输入按 1120 tok/图                                                           |
| gemini-3-pro-image（Nano Banana Pro）                                                    | 131,072       | $2.00               | $12.00 文本；图像输出 $120                               | $0.20      | 输入按 560 tok/图                                                            |
| gemini-2.5-flash-image                                                                   | 32,768        | $0.30               | $2.50 文本；图像输出 $30                                 | $0.075     | 旧图像档                                                                     |
| gemini-3.1-flash-live-preview（Live API）                                                | 131,072       | $0.75（音频 $3.00） | $4.50                                                    | 未获取     | 实时流式接口                                                                 |
| gemini-3.1-flash-tts-preview / gemini-2.5-pro-preview-tts                                | 8,192         | $1.00 / $1.00       | $20.00                                                   | 未获取     | 语音合成                                                                     |
| gemini-2.5-pro-computer-use（Computer Use-Preview）                                      | 131,072       | $1.25               | $10.00（>200K $15.00）                                   | 未获取     | 同 2.5 Pro 价格                                                              |
| gemini-robotics-er-1.6-preview                                                           | 131,072       | $1.00               | $5.00                                                    | 未获取     | 机器人 ER 预览档（音频输入 $2.00）                                           |
| gemini-embedding-2 / gemini-embedding-001                                                | 8,192 / 2,048 | $0.20 / $0.15       | —                                                        | —          | 向量模型，无缓存                                                             |
| gemini-3.5-live-translate-preview                                                        | 16,384        | $3.50               | $21.00                                                   | 未获取     | 同传翻译                                                                     |
| lyria-3-pro-preview / lyria-3-clip-preview                                               | 1,048,576     | 价格未标注          | 价格未标注                                               | —          | 音乐生成（官方页未列价）                                                     |

---

## 3. 缓存机制说明（机制条目来源：vendor-cache-mechanisms.md §6「已确认」，2026-08-02）

### A. 隐式缓存（Implicit Caching，自动）

- **生效范围**：Gemini 2.5 及更新模型默认启用（含 3.5 Flash、3.6 Flash、3.1 Pro Preview）；stateful（previous_interaction_id）与 stateless 均支持。
- **最低缓存 token 档**：Gemini 3.x（3.5 Flash / 3.1 Pro Preview）= **4096**；Gemini 2.5 Flash / Pro = **2048**。
- **命中价 = 未缓存输入价 × 10%**（官方定价表逐行核对该比例成立）。
- **计量字段**：`usage_metadata.total_cached_tokens`。
- **命中保证**：无（best-effort，官方原文 "no cost saving guarantee"）。

### B. 显式缓存（cachedContents API）

- **创建方式**：`POST /v1beta/cachedContents`（contents + system_instruction + ttl），请求以 `cachedContent: <name>` 引用；支持 list / get / update / delete。
- **TTL**：默认 1 小时，无最小 / 最大限制；**存储按「缓存 token 数 × 时长」计费**，单位 USD / 1M tokens / 小时。
- **存储费官方表（Vertex，$/M Tok/hr）**：3.1 Pro（Preview）$4.50；3 Pro $4.50；3 Flash $1.00；3.1 Flash Lite $1.00；2.5 Pro $4.50；2.5 Flash $1.00；2.5 Flash Lite $1.00。
- **命中保证**：有成本节省保证（显式缓存确定性优于隐式）；OpenAI 库经 `extra_body: {cached_content: ...}` 启用。
- **限制**：Interactions API（新推荐接口）**仅支持隐式缓存**，不支持显式缓存。
- 无 Anthropic 式 `cache_control` 断点参数；显式缓存为独立资源管理。

### C. 其他计费档位（官方定价页，可作为成本优化参考）

- **Priority 档**（≈1.8x 标准价，命中同比 10%）：3.1 Pro Preview 输入 $3.60 / 输出 $21.60（>200K $7.20 / $32.40）；3.6 Flash $2.70 / $13.50；3.5 Flash $2.70 / $16.20；3.5 Flash-Lite $0.54 / $4.50；3 Flash Preview $0.90 / $5.40；3.1 Flash-Lite $0.45 / $2.70。
- **Flex/Batch 档**（≈0.5x 标准价，多数模型无缓存价）：3.1 Pro Preview $1.00 / $6.00；3.6 Flash $0.75 / $3.75；3.5 Flash $0.75 / $4.50（缓存 $0.075）；3.5 Flash-Lite $0.15 / $1.25（缓存 $0.015）；3 Flash Preview $0.25 / $1.50；3.1 Flash-Lite $0.125 / $0.75（缓存 $0.0125）。
- **Non-global 端点**（非 Global 区域）：2026-07-01 起 GA Gemini 3 系加价 10%（3.5 Flash $1.65 / $9.90，命中 $0.165）。
- **微调模型**：基础模型价 × 1.5。
- 已停免费档说明：Grounding with Google Search 免费额度为 5,000 次/月（Gemini 3 系合计），超出 $14/1,000 次。

---

## 4. 特化优化线索（针对 crish 缓存/成本建模）

1. **命中价杠杆恒定 10%**：所有在售 Gemini 3.x/2.5 模型 cache_read = input × 10%，与 Kimi K3、百炼显式同属第二档（10 倍杠杆），低于 Anthropic 的 0.1x 特殊档之外的中位水平。
2. **>200K 加价仅影响 Pro 档**：3.1 Pro / 3 Pro / 2.5 Pro 长上下文输入 2x、输出 1.5x；flash 系无加价——长文档场景优先 flash 系。
3. **显式缓存存储费差异 4.5x**：Pro 档 $4.50 vs flash 档 $1.00（$/M Tok/hr）；长 TTL 大缓存必须按「token × 时长」单独核算，存储费可能吃掉命中折扣。
4. **Flex/Batch 0.5x 且缓存价保留**：3.5 Flash 批处理输入 $0.75、命中 $0.075——与 00-catalog §8.1 记录的「3.5 Flash 输入 $0.75」数值吻合，说明 R0 目录实际混用了 Flex/Batch 档价（见 §6）。
5. **3.6 Flash 输出价下调**（$7.50 vs 3.5 Flash $9.00）：同输入价下新档更优，成本模型应区分 3.5/3.6 档。
6. **别名模型**：`gemini-flash-latest` / `gemini-flash-lite-latest` 应映射到具体版本计价（3.5-flash / 3.1-flash-lite）。
7. **effort 档位**（reasoning_options）：3.x 系支持 effort（minimal/low/medium/high），成本可按 effort 分级预估；2.5 系为 toggle + budget_tokens。

---

## 5. 未获取项（诚实边界，不编造）

1. **ai.google.dev/gemini-api/docs/pricing 与 /docs/models**：本次 4 次 webfetch 均 transport error，未获取。上表价格以 **Vertex AI 官方定价页**（Google Cloud 官方，Gemini API 同价）与 **models.dev + OpenRouter 双重交叉验证**为准。
2. **3.5 Flash / 3.6 Flash / 3.5 Flash-Lite 的显式缓存存储费**：Vertex 存储费表未列出这三个模型；00-catalog §8.1 记录的「3.6 Flash $1.00/1M·h」来源为 ai.google.dev（R0），本次无法复核——是否支持显式缓存存储或价格未公布，需官方 ai.google.dev 定价页确认。
3. **2.0-flash-lite 缓存命中价**：models.dev 未收录，官方定价页未逐项核对。
4. **模型清单完整性**：models.dev google 厂商共 41 条目（含音乐 lyria、视频 veo、Gemma 开源系等非 Gemini 文本模型），已筛选在售文本/特化模型收录；个别 preview（如 2.5-computer-use-preview-10-2025）无独立价格、按 2.5 Pro 计价，已归并。
5. **上下文窗口与输出上限**：以 models.dev / OpenRouter 交叉一致值 1,048,576 / 65,536 为准（3-flash-preview 输出上限记录为 65,535）；官方定价页不公布窗口，ai.google.dev docs/models 未能复核。

---

## 6. 与 R0 目录（00-vendor-model-pricing-catalog.md §8.1）的差异修正

| R0 §8.1 记录                        | 2026-08-03 核实                                              | 处置                     |
| ----------------------------------- | ------------------------------------------------------------ | ------------------------ |
| Gemini 3.5 Flash 输入 $0.75         | 标准档 $1.50；**$0.75 为 Flex/Batch 档价**                   | R0 混用批处理价，修正    |
| Gemini 3.1 Pro 输入 $1.25（≤200K）  | 标准档 $2.00（≤200K）/ $4.00（>200K）；$1.25 实为 2.5 Pro 价 | 修正                     |
| 四模型均无 output 价 / 无上下文窗口 | 已补全（见 §1 表）                                           | 补齐                     |
| 3.6 Flash 存储 $1.00/1M·h           | Vertex 存储表未列 3.6 Flash；3 Flash 为 $1.00                | 保留存疑，标注待官方复核 |
| 3.1 Pro 存储 $4.50/1M·h             | 确认（3.1 Pro 行 $4.5/M Tok/hr）                             | 确认                     |
| 命中 = 10%                          | 逐行确认成立                                                 | 确认                     |
