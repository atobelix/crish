# catalog.json v2 全量转录质量审计报告（R4）

> 专项：「模型目录与定价 v2」　|　轮次：**R4 审计**　|　审计日期：2026-08-04
> 审计对象：`crates/agent-provider/src/models/catalog.json`（**151 条**御十家目录，schema 2.0）
> 权威数据源：`04-master-model-list.md`（R2 汇总唯一数据源）；抽查回源：`01-deepseek.md` / `01-gemini.md` / `01-glm.md` / `01-minimax.md` / `01-kimi.md`
> 字段语义：`03-catalog-v2-schema.md`（59 字段）；消费结构：`crates/agent-provider/src/models/catalog.rs` + `behavior.rs`
> 审计方式：只读。全量逐条核对价格/窗口/币种/能力位 + 脚本结构性检查（键一致性/重复键/derivation/tieredPricing 重叠/三态互斥）+ 01-*.md 抽查。
> 本报告只列结论与修正建议；**catalog.json 修正由主 Agent 另行派单**，本报告不落任何代码改动。

---

## 1. 审计结论总览

| 维度                          | 结果                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 总条目                        | **151**（anthropic 11 / cursor 2 / deepseek 2 / gemini 22 / glm 31 / grok 6 / kimi 4 / minimax 16 / openai 34 / qwen 23）                    |
| 与 master 转录范围            | 一致：183 行 - 32 行不转录（已下线/退役/unavailable/非对话/促销价行），逐厂商差额全部对上（§2.1）                                            |
| 键结构（id=model / 无重复键） | **通过**：151 键全部 = `vendor::model`，零重复，无 `id` 字段（缺省派生，schema §1.4 允许）                                                   |
| derivation 完备性             | **通过**：21 条 `priceStatus:"derived"` 全部带 `derivation`，无「有 derivation 非 derived」反例                                              |
| tieredPricing 合法性          | **通过**：42 条含分档，零区间重叠；GLM 边界 32K/128K/200K、Grok/Gemini 200K、OpenAI 272K、MiniMax 512K、Qwen 32K/128K/256K 均与 master 一致  |
| cacheWriteFree 三态           | **通过**：98 条写免费（0+true）+ 38 条有写价（>0+false）+ 4 条未收录（null+false）+ 11 条 Anthropic 通用写价 null/5m-1h 有值；**零异常组合** |
| 币种                          | **通过**：Kimi/Qwen 全 CNY，其余全 USD，GLM/MiniMax 双币种正确区分（§4）                                                                     |
| 能力位                        | 基本通过，**2 处不一致**（deepseek-v4-pro effort、cyber/search 缓存断言），**1 类结构张力**（pro 档 cacheType/read null，§5/§7）             |
| 数据不一致（逐条核对）        | **8 项**：1 项价值类（v4-pro effort）+ 2 项断言类（cyber/search）+ 5 项 apiModel 缺项（GLM USD 视觉 4 条 + 待核实 1 类）（§2.2）             |
| 裁决点（A1b 上报 6 项）       | 接受 5 项、接受但需补动作 1 项（⑤ GLM apiModel 缺口）（§6）                                                                                  |
| 四指标完整性                  | **135 / 151 完整（89.4%）**，16 条缺项全部有 notes 诚实标注，与 master 分厂商完整数逐一对上（§3）                                            |

**总评：转录质量高，主体数据与权威表一致；需修正项集中于「GLM USD 视觉条目 apiModel 缺失」（请求层会拿到错误模型 ID）与 2 处越过 master 的缓存断言，均属局部修正，无全局性漂移。**

---

## 2. 数据正确性抽查

### 2.1 转录范围核对（151 vs master 183 行）

| 厂商      | master 行 | catalog | 差额构成（全部命中 §13.4 不转录清单）                                                                            |
| --------- | --------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| OpenAI    | 40        | 34      | gpt-5.4-cyber（unavailable）、gpt-5.1-codex×3 / gpt-5-codex（未上定价页）                                        |
| Anthropic | 17        | 11      | mythos-preview（unavailable）、opus-4-1/4-0/sonnet-4-0/haiku-3.5（退役）、sonnet-5 标准价行（P5 日期切换不收录） |
| Kimi      | 11        | 4       | k2.5 + moonshot-v1×6（8/31 全平台下线）                                                                          |
| GLM       | 34        | 31      | 4.5-Flash USD/CNY（即将下线）、GLM-OCR（非对话，建议不转录）                                                     |
| Qwen      | 23        | 23      | —                                                                                                                |
| Grok      | 6         | 6       | —                                                                                                                |
| MiniMax   | 18        | 16      | M2-her×2（unavailable）                                                                                          |
| Gemini    | 31        | 22      | 2.0-flash×2（归档）、CodeMender、tts×2、embedding×2、lyria×2（非对话/输出缺）                                    |
| DeepSeek  | 2         | 2       | legacy×2 不计行                                                                                                  |
| Composer  | 1         | 2       | Standard/Fast 两档各 1 条（master 表 A 同 2 行）                                                                 |

### 2.2 数据不一致清单（catalog vs master / 01-*.md）

| #   | 位置（键）                             | 字段                                         | 期望值（权威源）                                                                                                                           | 实际值（catalog）                | 影响                                                             | 级别           |
| --- | -------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ---------------------------------------------------------------- | -------------- |
| D1  | `deepseek::deepseek-v4-pro`            | supportsReasoningEffort                      | `true`——01-deepseek.md §4（models.dev 交叉确认）：「两模型 reasoning_options 均为 toggle + effort（high/max）」；master §9.2 v4-pro 行 RE✔ | `false`                          | 请求层可能拒绝下发 effort 参数；v4-flash 为 true，两模型不一致   | 建议修正       |
| D2  | `openai::gpt-5.5-cyber`                | cacheType / supportsPromptCaching / cacheTtl | master §1.2：缓存语义**未获取**（TTL 未获取、R— CC— PK— IM—）                                                                              | 断言 `"auto"` / `true` / `"24h"` | 越过 master 采用了旧轨推断（5.5 系 24h），非权威值               | 建议修正       |
| D3  | `openai::gpt-5-search-api`             | 同上                                         | 同上（master §1.2 未获取）                                                                                                                 | 同上                             | 同上                                                             | 建议修正       |
| D4  | `glm::glm-4-6v`                        | apiModel                                     | `glm-4.6v`（master §4 核心结论：API 名称为点号形态 + apiModel 承载；同模型 CNY 条目 `glm-4-6v-cny` 已带 `"glm-4.6v"`）                     | 缺省 = `"glm-4-6v"`（横线）      | 请求层 `apiModel ?? model` 会以横线名直连 API → **模型 ID 错误** | **必须修正**   |
| D5  | `glm::glm-4-6v-flashx`                 | apiModel                                     | `glm-4.6v-flashx`（CNY 条目已带）                                                                                                          | 缺省横线                         | 同上                                                             | **必须修正**   |
| D6  | `glm::glm-4-6v-flash`                  | apiModel                                     | `glm-4.6v-flash`（CNY 条目已带）                                                                                                           | 缺省横线                         | 同上                                                             | **必须修正**   |
| D7  | `glm::glm-4-5v`                        | apiModel                                     | `glm-4.5v`（CNY 条目已带）                                                                                                                 | 缺省横线                         | 同上                                                             | **必须修正**   |
| D8  | `glm::glm-4-5-x` / `glm::glm-4-5-airx` | apiModel                                     | 未确证（master/01-glm.md 均未标注 API ID 形态）                                                                                            | 缺省横线                         | 若官方 ID 为 `glm-4.5-x` 点号形态则同 D4                         | 建议核实后修正 |

> 非不一致确认（抽查回源一致）：deepseek 四价与峰谷（01-deepseek §1/§3）、gemini 3.6-flash 存储费未获取与 omni read 未获取（01-gemini §5/§79/§109）、GLM 4.5-X 价 $2.20（01-glm §3.2）、MiniMax M2.7 写价 2.625/0.375 与 M3 永久五折 2.10/8.40/0.42（01-minimax §3）、Kimi K3 20/100/2.0 命中 10%（01-kimi §3）——**全部与 catalog 一致**。

---

## 3. 四指标完整性统计

定义：input / output / cacheRead 齐全 + 写价齐全（通用 cacheWritePrice 或 5m/1h 任一；写免费 = 0+true 视为完整）。

### 3.1 汇总

**151 条中 135 条完整（89.4%）；16 条不完整**（全部有 `notes` 说明缺项原因，无 0 占位、无静默缺省）。

### 3.2 缺项分布（16 条）

| 厂商        | 缺项条目                                                                                                  | 缺什么               | 原因（master 依据）                                              |
| ----------- | --------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------- |
| OpenAI（6） | gpt-5.5-pro / gpt-5.4-pro / gpt-5.2-pro / gpt-5-pro / o1-pro / o3-pro                                     | cacheReadPrice=null  | pro 档「no cached input discount」，读价未明确（master §1.4 #2） |
| Gemini（5） | omni-flash-preview / 3.1-flash-live-preview / 2.5-pro-computer-use / robotics-er-1.6 / 3.5-live-translate | cacheReadPrice=null  | 官方未获取（master §8.3 read 缺）                                |
| GLM（1）    | glm-4-32b-0414-128k                                                                                       | cacheReadPrice=null  | USD 站未列 read（master §4.5 #8）                                |
| Cursor（2） | composer-2-5 / composer-2-5-fast                                                                          | cacheRead+Write 双缺 | 官方未公开缓存单价（master §10.3 #2）                            |
| Qwen（2）   | qwen3-8-max-preview / qwen3-5-omni-plus                                                                   | cacheRead+Write 双缺 | 缓存绝对价未给（master §5.3 #2/#3）                              |

### 3.3 与 master 口径对账（分厂商完整数）

| 厂商      | catalog 完整  | master 完整（对应口径）                           | 一致 |
| --------- | ------------- | ------------------------------------------------- | ---- |
| OpenAI    | 28 / 34       | 29 / 40（35 有价行 - 6 pro - 1 cyber 未转录）= 28 | ✓    |
| Anthropic | 11 / 11       | 16 / 17 - 5 退役 = 11                             | ✓    |
| Kimi      | 4 / 4         | 5 / 11 - 1（k2.5 不转录）= 4                      | ✓    |
| GLM       | 30 / 31       | 32 / 34 - OCR 不转录 - 4-32B read 缺 = 30         | ✓    |
| Qwen      | 21 / 23       | 21 / 23                                           | ✓    |
| Grok      | 6 / 6         | 6 / 6                                             | ✓    |
| MiniMax   | 16 / 16       | 16 / 18（M2-her×2 不转录）                        | ✓    |
| Gemini    | 17 / 22       | 18 / 31（主表 12 + 变体 6，未转录 9 行去除）= 17  | ✓    |
| DeepSeek  | 2 / 2         | 2 / 2                                             | ✓    |
| Composer  | 0 / 2         | 0 / 1（两档均缺缓存价）                           | ✓    |
| **合计**  | **135 / 151** | **145 / 183**（口径差 = 32 行不转录行）           | ✓    |

### 3.4 cacheWriteFree 三态核查

| 语义     | 表达             | 条数  | 核查                                                                                                                                                |
| -------- | ---------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 写免费   | `0` + `true`     | 98    | gemini/glm/kimi/grok/deepseek/openai 旧轨与 5.4 系/minimax-m3——全部与 master「0（写免费）」一致 ✓                                                   |
| 有写价   | `>0` + `false`   | 38    | openai 5.6 系（6.25/2.5/0.25）、minimax m2.x 系（2.625/0.375）、qwen 推导价（15 等）；另 Anthropic 11 条通用写价 null + 5m/1h 有值（双档写价语义）✓ |
| 未收录   | `null` + `false` | 4     | cursor×2、qwen3-8-max-preview、qwen3-5-omni-plus ✓                                                                                                  |
| 异常组合 | —                | **0** | 无「0+false」「null+true」等二义条目 ✓                                                                                                              |

---

## 4. 币种核查表

| 厂商                                                   | catalog 币种    | 期望（master §0.2/§12.1）                                              | 结论                                            |
| ------------------------------------------------------ | --------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| Kimi                                                   | CNY 4 / 4       | 纯 CNY（官方仅人民币计价）                                             | ✓                                               |
| Qwen                                                   | CNY 23 / 23     | 纯 CNY（百炼华北2 北京基准）                                           | ✓                                               |
| Anthropic / OpenAI / Grok / Gemini / DeepSeek / Cursor | USD 全量        | 纯 USD                                                                 | ✓                                               |
| GLM                                                    | USD 18 + CNY 13 | 双币种：zai=USD 主站 18 条（4.5-Flash/OCR 不转录）+ bigmodel=CNY 13 条 | ✓ 键后缀 `-cny` 全部落在 CNY 次要站条目，无错标 |
| MiniMax                                                | CNY 8 + USD 8   | 双币种：minimaxi=CNY 8 + minimax-io=USD 8（M2-her 不转录）             | ✓ 键后缀 `-usd` 全部落在 USD 次要站条目         |
| **误标币种**                                           | —               | —                                                                      | **0 条**                                        |

双币种键后缀方向说明（见裁决点①）：GLM 主站为 zai/USD（原名）、次要站 bigmodel/CNY 加 `-cny`；MiniMax 主站为 minimaxi/CNY（原名）、次要站 minimax-io/USD 加 `-usd`。方向相反但自洽，`vendor::model` 无碰撞。

---

## 5. 能力位一致性

### 5.1 supportsResponses（重点复核）

| 检查点                                                           | 期望                                                                   | catalog                    | 结论         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------- | ------------ |
| deepseek-v4-pro                                                  | `false`（官方 2026 年 8 月初计划加入，抓取日未上线；8 月中旬刷新翻转） | false + notes 标注翻转计划 | ✓ 符合任务书 |
| deepseek-v4-flash                                                | true                                                                   | true                       | ✓            |
| gpt-5.6 系 / 5.5 / 5.4 系 / 5.3-codex / chat-latest / codex-mini | true（现行 Responses 轨）                                              | 全 true                    | ✓            |
| o1-pro / o3-pro                                                  | false（仅 Chat Completions，master §1.3）                              | false                      | ✓            |
| gpt-5.5-cyber / gpt-5-search-api                                 | false（R—，master §1.2）                                               | false                      | ✓            |
| Qwen 15 条（3.8-max 至 qwen-flash）                              | true（master §5.2 R✔ 范围）                                            | true                       | ✓            |
| Qwen turbo/long/qwq/vl 系 / preview                              | false（R—/仅 Token Plan）                                              | false                      | ✓            |
| Kimi / Gemini / GLM / MiniMax 全系                               | false（R—/✘）                                                          | false                      | ✓            |

### 5.2 supportsVision

| 检查点                                                                 | 期望                        | catalog  | 结论 |
| ---------------------------------------------------------------------- | --------------------------- | -------- | ---- |
| GLM 5V-Turbo / 4.6V / 4.6V-FlashX / 4.6V-Flash / 4.5V（USD 5 + CNY 5） | true（master §4.2/4.3 V✔）  | 全 true  | ✓    |
| Qwen3-VL plus/flash、qwen3.5-omni-plus、qwen2.5-omni-7b、qwen3.8-max   | true                        | 全 true  | ✓    |
| Kimi k3 / k2.7-code / k2.7-code-highspeed / k2.6                       | true（master §3.2 V✔）      | 全 true  | ✓    |
| Gemini 主表 11 + image 系 4                                            | true                        | 全 true  | ✓    |
| MiniMax-M3（双币种）                                                   | true（image_url/video_url） | true     | ✓    |
| 纯文本模型（anthropic/openai/deepseek/grok）                           | false                       | 全 false | ✓    |

### 5.3 cacheType 值域与行为矩阵消费

- 值域使用：`auto` 89 / `both` 59 / `none` 2（cursor）/ 缺失 1（qwen3-5-omni-plus，supportsPromptCaching=false，保守可接受）。无 `explicit`/`key` 使用（schema 允许，非必用）。
- 消费一致性：behavior.rs:440 `matches!(cache_type, Some("automatic"|"auto"|"both"))` 开启自动缓存轨，`explicit`/`none`/缺失不开启——与目录值域完全对应（v1 `automatic` 兼容保留，v2 值域 `auto` 已同步）。
- **结构张力（需裁决）**：6 条 OpenAI pro 档（5.5-pro/5.4-pro cacheType `both`；5.2-pro/5-pro/o1-pro/o3-pro cacheType `auto`）在 `supportsImplicitCaching=false` + `supportsPromptCacheKey=false` + `supportsCacheControl=false` 三能力位全关、且 cacheReadPrice=null 的情况下仍标 `supportsPromptCaching=true` + 参与缓存轨。语义上「可读缓存但无折扣」与「完全无缓存」官方未明确（master §1.4 #2），当前表达与 notes（P5 按全价）自洽，但 `both`/`auto` 与能力位存在表面矛盾，建议 schema 侧补例外条款（§7-建议 3）。

---

## 6. 裁决点复核（A1b 上报 6 项）

| #   | 裁决点                                   | 结论                                           | 依据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | 双币种键后缀约定（-cny/-usd）            | **接受**                                       | GLM 13 条 `-cny`（provider=bigmodel）+ MiniMax 8 条 `-usd`（provider=minimax-io），全部落在次要站条目，`vendor::model` 无碰撞；catalog.rs 测试注释（2026-08-03）已固化该约定。建议：将后缀约定写入 03-schema.md §1.4 或 04 文档作为命名契约（本次仅存在于 catalog.rs 注释）。                                                                                                                                                                                                          |
| ②   | pro 档 cacheReadPrice null 语义          | **接受（语义层）**；**需补充 schema 例外条款** | null + notes（P5 按全价）+ priceStatus official 与 master §1.4 #2（官方仅声明 no cached input discount，能否读缓存未明确）完全一致，诚实边界正确。但 6 条 pro 档 + qwen3-8-max-preview 共 7 条处于「supportsPromptCaching=true 且 cacheReadPrice=null」，违反 03-schema §2 C 组「条件必填」字面条款（§2 审计确认 13 条命中此冲突，含 gemini 变体 5 + glm-4-32b 1）。结论：null 语义保留，schema 需加「读价未明确 = null + notes 例外」条款，否则校验层若按条件必填加严会误杀合法条目。 |
| ③   | vendor 段契约（xai→grok、google→gemini） | **接受**                                       | catalog provider=xai/google、vendor=grok/gemini 与 behavior.rs `VendorId::as_str()`（grok/gemini，behavior.rs:56-57）及 catalog.rs 测试键（grok::/gemini::）一致；master 表 A 写 xai/xai、google/google 为 R2 文档口径，契约以行为矩阵键为准，无消费断裂。                                                                                                                                                                                                                             |
| ④   | catalog.json gitignore（已加白名单）     | **接受（已正确落地）**                         | `.gitignore` 全局 `*.json` 忽略下已有 `!crates/agent-provider/src/models/catalog.json` 白名单（§5 行），catalog.json 不会被忽略。                                                                                                                                                                                                                                                                                                                                                      |
| ⑤   | GLM apiModel 点号形态                    | **接受但存在缺口（需修正）**                   | 文本系（glm-5-2→glm-5.2 等）与 CNY 视觉系已正确；**USD 视觉 4 条（glm-4-6v / glm-4-6v-flashx / glm-4-6v-flash / glm-4-5v）缺 apiModel**（D4-D7），请求层将构造错误模型 ID，必须补齐；glm-4-5-x / glm-4-5-airx 形态未确证（D8），建议核实。                                                                                                                                                                                                                                             |
| ⑥   | Gemini 存储费未获取/null                 | **接受**                                       | 3.6/3.5/3.5-lite flash 3 条无 `storagePricePer1mHour`（null 语义）+ notes 标注「R0 记 1.00 存疑待复核」，与 master §8.4 #2、01-gemini.md §5/§109 完全一致；其余 8 条（Pro 4.5 / flash 系 1.0）与 01-gemini.md §79 存储费表逐项一致。                                                                                                                                                                                                                                                   |

---

## 7. 修正清单（供主 Agent 派单；本报告不落地）

### 7.1 必须修正（4+1 条，均为 apiModel 缺项）

| #   | 位置                                   | 改法                                                                                 |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| M1  | `glm::glm-4-6v`                        | 补 `"apiModel": "glm-4.6v"`（参照同模型 CNY 条目 `glm-4-6v-cny`）                    |
| M2  | `glm::glm-4-6v-flashx`                 | 补 `"apiModel": "glm-4.6v-flashx"`                                                   |
| M3  | `glm::glm-4-6v-flash`                  | 补 `"apiModel": "glm-4.6v-flash"`                                                    |
| M4  | `glm::glm-4-5v`                        | 补 `"apiModel": "glm-4.5v"`                                                          |
| M5  | `glm::glm-4-5-x` / `glm::glm-4-5-airx` | 核实 z.ai 官方 API ID 形态后补 apiModel；若确为横线名则加 notes 说明已核实（防误判） |

### 7.2 建议修正（3 项）

| #   | 位置                                                 | 改法                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `deepseek::deepseek-v4-pro`                          | `supportsReasoningEffort: false → true`（01-deepseek.md §4：两模型 reasoning_options 均为 toggle + effort high/max；与 v4-flash 对齐）。若保守起见，至少在 notes 标注与 01 调研的差异。                                                                                 |
| S2  | `openai::gpt-5.5-cyber` / `openai::gpt-5-search-api` | 缓存语义与 master §1.2「未获取」冲突：改保守（supportsPromptCaching=false、cacheType 省略、去 cacheTtl）或保留现断言但 notes 标注「按 5.5 系旧轨推断，官方未公布」。                                                                                                    |
| S3  | schema 例外条款（03-catalog-v2-schema.md §2 C 组）   | 补充「pro 档无缓存折扣、官方未给读价 → cacheReadPrice=null + notes（P5 按全价）」与「读价未获取 → null + notes」两类例外，消解 13 条「supportsPromptCaching=true 且 read=null」与条件必填的字面冲突（OpenAI pro 6 + gemini 变体 5 + glm-4-32b + qwen3-8-max-preview）。 |

### 7.3 可接受（无需修改，记录在案）

| #   | 事项                                                                                                                  | 说明                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A1  | 16 条四指标不完整条目                                                                                                 | 全部有 notes 诚实标注，无 0 占位，符合 schema「禁止 0 占位」红线                                          |
| A2  | cursor×2 缺 contextWindow / maxOutputTokens                                                                           | schema 标必填，但 master §10.1 明确「社区口径未经官方确认，留空由实测」，文档化例外成立                   |
| A3  | apiModel==model 冗余 5 条（gemini-3-pro-preview / gemini-3-flash-preview / gemini-3-pro-image / glm-5 / glm-5-turbo） | 自描述无害；如需严格可在下轮转录清理                                                                      |
| A4  | qwen3-5-omni-plus 无 cacheType 字段                                                                                   | supportsPromptCaching=false 保守表达，行为矩阵不受影响                                                    |
| A5  | 双币种后缀方向不对称（GLM 加 -cny / MiniMax 加 -usd）                                                                 | 契约已固化（catalog.rs 测试），建议文档化（见裁决点①建议）                                                |
| A6  | Anthropic 11 条 cacheWriteFree=false + 通用写价 null                                                                  | 5m/1h 双档写价语义，schema 明确允许                                                                       |
| A7  | Sonnet 5 促销价 + promoExpiresAt/promoReplacesAt                                                                      | 与 master §2.1 促销策略完全一致（9/1 标准价行不收录）                                                     |
| A8  | 21 条 Qwen derived 价                                                                                                 | cacheReadFactor 0.1 / cacheWriteFactor 1.25 / implicit 0.2 三因子齐出，绝对价 = 比例 × 官方输入价计算无误 |

---

## 8. 审计边界与遗留

1. 价格值核对方式：catalog 全量四价 vs master 表 A 逐条人工比对 + 关键项回 01-*.md；未做外部网络复核（master 即权威，01 文档抽查佐证）。
2. `glm-4-5-x / glm-4-5-airx` 官方 API ID 形态（D8/M5）：master 与 01-glm.md 均无明确值，需 z.ai 侧核实，本报告不下定论。
3. Gemini 3.5/3.6 flash 存储费（裁决点⑥）：维持 null 待官方 ai.google.dev 复核（9/1 前 GLM 存储费恢复价同理需刷新）。
4. deepseek-v4-pro `supportsResponses` 翻转已入 notes（8 月中旬刷新），非本次修正范围。

---

> 本报告全部数字可回溯至 catalog.json 原文、04-master-model-list.md 与 01-*.md 调研文档；未编造任何测试结果。审计结论：**通过（主体）＋ 8 项数据不一致（1 项必修正级 4 条 + 3 项建议 + 1 项待核实）＋ 6 项裁决点（5 接受 / 1 接受但有缺口）**。
