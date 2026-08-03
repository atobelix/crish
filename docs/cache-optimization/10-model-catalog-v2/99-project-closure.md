# 模型目录与定价 v2：专项收尾总结报告（R5 Closure）

> 专项：「模型目录与定价 v2」　|　轮次：**R5 收尾**　|　报告日期：2026-08-04
> 报告性质：专项闭环总结（只读复核，不落代码改动；本次除本报告外未修改任何文件）
> 权威文档链：`00-gap-audit.md`（R0）→ `01-*.md` ×12（R1 调研）→ `02-*.md` ×3（litellm 结构 / 目录源 / 特化优化）→ `03-catalog-v2-schema.md`（R2 Schema）→ `04-master-model-list.md`（R2 汇总，唯一数据源）→ `05-audit-report.md`（R4 审计）
> 落地物：`crates/agent-provider/src/models/catalog.json`（151 条）、`crates/agent-provider/src/request/{vendor,cache,build}.rs`（G1/G2/G7）、`apps/crish-desktop/src/api/pricingStore.ts`（四指标 125 键）
> 实跑复核（本报告撰写时）：`cargo test --workspace` 78 套件全绿（0 失败）；`vitest run src/api/pricingStore.test.ts` 28/28 通过

---

## 0. 结论先行（速览）

1. **专项闭环达成**：R0 盘点（28 条起步）→ R1 十二厂商调研 → R2 汇总（183 条 / 145 条完整四指标）→ R3 落地（59 字段 schema + 前端四指标 125 键 + catalog.json 151 条 + G1/G2/G7 三条特化）→ R4 审计（135/151 完整，8 项不一致）→ R4.5 修正（M1-M4 + S1 + S2）→ R5 终验（cargo 全绿 + 前端专项用例 28/28）。
2. **目录规模**：151 条 / 御十家（anthropic 11、openai 34、qwen 23、gemini 22、glm 31、minimax 16、kimi 4、grok 6、deepseek 2、cursor 2），四指标完整 135 条（89.4%），16 条缺项全部带 `notes` 诚实标注，无 0 占位。
3. **币种**：USD 103 / CNY 48，双币种键后缀约定（GLM 次要站 `-cny`、MiniMax 次要站 `-usd`）已固化于 catalog.rs 测试；目录内不做汇率换算。
4. **特化优化**：30 条调研清单中落地 3 条（G1 Anthropic 1h 双桶、G2 x-grok-conv-id 接线、G7 adaptive thinking + display summarized），剩余 27 条已按价值分级登记（第 4 节）。
5. **遗留 7 项**：M5 apiModel 待核实、Gemini/GLM 存储费、DeepSeek 峰谷与 v4-pro Responses、schema 例外条款、models.dev 远程源（登记后续专项）——全部有触发条件与责任域（第 5 节）。

---

## 1. 专项闭环总结（R0 → R5 时间线）

| 轮次          | 产出                                                                                                                                                           | 关键数字与结论                                                                                                                                                                                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R0 盘点**   | `00-gap-audit.md`                                                                                                                                              | 既有 28 条逐条清点：完整四指标仅 11 条（39.3%）、缺写价字段 13 条、缺输出价 5 条、价格全空 3 条（Qwen）；缺口集中在 OpenAI 5 系、Kimi K2.x、Qwen 全系价格、豆包/ERNIE 整厂商 0 条、Composer 归属未知。输出 46 字段建议与 R1 十二厂商任务书模板（13 问）。                                   |
| **R1 调研**   | `01-*.md` ×12（anthropic / composer / deepseek / doubao / ernie / gemini / glm / grok / kimi / minimax / openai / qwen）+ `02-model-specific-optimizations.md` | 每家交付「四指标绝对价 + 最低可缓存 token + TTL + 币种 + 来源 URL + 抓取日期」六要素；确认 composer 2.5 为 Cursor 出品（基于 Kimi K2.5，非 OpenAI）；豆包/ERNIE 按用户指示降为存档不转录。特化调研产出 30 条编号清单 + 13 个缺口（G1-G13）。                                                |
| **R2 汇总**   | `03-catalog-v2-schema.md`（59 字段）+ `04-master-model-list.md`（183 行）+ `02-litellm-catalog-structure.md` + `02-model-catalog-sources.md`                   | 字段全集 59 个（必填 9 + 条件必填 12 + 可选 38）；四指标三原则（写免费双字段齐出、null + priceStatus 禁 0 占位、币种必填不换算）；长度分档统一为「基础四价 + tieredPricing 增量档」；TTL 扩为四档（新增 30m）；远程源优先级 = 静态人工 > models.dev > OpenRouter 渠道价（禁止跨渠道覆盖）。 |
| **R3 落地**   | catalog.rs 59 字段结构 + catalog.json 全量 + pricingStore.ts 四指标 + G1/G2/G7（commit `182052e5`）                                                            | 前端四指标 125 键（pricingStore.ts:126）；TTL 30m 档入 ttl.rs（`CacheTtl::HalfHour`）；G1 Anthropic 1h 双桶（cache.rs:420-425）、G2 x-grok-conv-id 接线（cache.rs:499-507 + build.rs:268-269）、G7 adaptive + display summarized（vendor.rs:468-475）。                                     |
| **R3E 补录**  | catalog.json 151 条全量（commit `57a6d4ad`）                                                                                                                   | 御十家全量转录；`bundled()` 包装解析修复；catalog.json gitignore 白名单（commit `126c6029`）。                                                                                                                                                                                              |
| **R4 审计**   | `05-audit-report.md`（只读）                                                                                                                                   | 151 条全量核对：转录范围与 master 183 行逐厂商对上（32 行不转录）；8 项数据不一致（1 项必修正级 4 条 + 3 项建议 + 1 项待核实）；6 项裁决点（5 接受 / 1 接受但需补动作）；四指标 135/151 与 master 口径逐厂商对账一致。                                                                      |
| **R4.5 修正** | catalog.json（commit `f8316a11`）                                                                                                                              | M1-M4：GLM USD 视觉 4 条补 apiModel 点号名；S1：deepseek-v4-pro `supportsReasoningEffort` true；S2：gpt-5.5-cyber / gpt-5-search-api 缓存断言改保守（supportsPromptCaching=false + 去 cacheType/cacheTtl + notes）。                                                                        |
| **R5 收尾**   | 本报告                                                                                                                                                         | 闭环总结、剩余特化登记、遗留项登记、关系说明、终验记录。                                                                                                                                                                                                                                    |

---

## 2. 成果清单

### 2.1 目录规模（151 条 / 厂商分布）

实读 `crates/agent-provider/src/models/catalog.json`（顶层包装 `{version:0, schema:"2.0", updatedAt:"2026-08-03", entries}`）：

| 厂商      | 条数 | 说明                                                                             |
| --------- | ---- | -------------------------------------------------------------------------------- |
| openai    | 34   | 现行主表 12 + 特化 2 + 旧轨 20（P1 备查）                                        |
| anthropic | 11   | 现役 11 条（Opus 4.8/4.7/4.6 同价收录；退役 4 款与 sonnet-5 9/1 标准价行不转录） |
| qwen      | 23   | 全系（19 文本 + 4 VL），21 条 `priceStatus:"derived"` 推导价                     |
| glm       | 31   | USD zai 站 18 + CNY bigmodel 站 13（键后缀 `-cny`）                              |
| gemini    | 22   | 主对话 11 + 变体 8 + image 系 3 等（归档 2.0 系与 tts/embedding/lyria 不转录）   |
| minimax   | 16   | CNY minimaxi 8 + USD minimax-io 8（键后缀 `-usd`），含 highspeed 独立条目        |
| grok      | 6    | 4.5 / 4.3 / 4.20-0309 三档 ×（reasoning/non-reasoning/multi-agent）+ build-0.1   |
| kimi      | 4    | K3 / K2.7-Code / K2.7-Code-HighSpeed / K2.6（V1 系 8/31 下线不转录）             |
| deepseek  | 2    | v4-flash / v4-pro（legacy 2026-07-24 停用不转录）                                |
| cursor    | 2    | composer-2.5 / composer-2.5-fast（存档级，不可直连，双币无缓存价）               |

转录范围与 master 183 行完全对齐：差额 32 行全部命中 §13.4 不转录清单（已下线 / 非对话 / 未获取 / 非官方 ID）。

### 2.2 四指标完整性（135 / 151，缺项分布与原因）

完整性口径 = input / output / cacheRead 齐全 + 写价齐全（通用写价或 5m/1h 任一；写免费 0+true 视为完整）。**135 条完整（89.4%）**，16 条缺项全部有 `notes` 说明，无 0 占位、无静默缺省：

| 厂商        | 缺项条目                                                                                                  | 缺什么                 | 原因                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------- |
| OpenAI（6） | gpt-5.5-pro / gpt-5.4-pro / gpt-5.2-pro / gpt-5-pro / o1-pro / o3-pro                                     | cacheReadPrice=null    | pro 档「no cached input discount」，读价官方未明确（P5 按全价） |
| Gemini（5） | omni-flash-preview / 3.1-flash-live-preview / 2.5-pro-computer-use / robotics-er-1.6 / 3.5-live-translate | cacheReadPrice=null    | 官方未获取                                                      |
| GLM（1）    | glm-4-32b-0414-128k                                                                                       | cacheReadPrice=null    | USD 站未列 read                                                 |
| Cursor（2） | composer-2-5 / composer-2-5-fast                                                                          | cacheRead + Write 双缺 | 官方未公开缓存单价                                              |
| Qwen（2）   | qwen3-8-max-preview / qwen3-5-omni-plus                                                                   | cacheRead + Write 双缺 | 缓存绝对价未给                                                  |

写价三态核查（零异常组合）：写免费 `0 + true` 98 条、有写价 `>0 + false` 38 条、未收录 `null + false` 4 条（cursor×2 + qwen preview 2）+ Anthropic 11 条通用写价 null / 5m-1h 有值（双档语义）。

### 2.3 币种覆盖（USD/CNY 双币种键约定）

- 币种分布：**USD 103 条 / CNY 48 条**，误标 0 条。纯 USD：anthropic/openai/grok/gemini/deepseek/cursor + GLM 国际站；纯 CNY：kimi×4、qwen×23；双币种：GLM（USD 18 + CNY 13）、MiniMax（CNY 8 + USD 8）。
- **键后缀约定**：GLM 主站 = zai/USD（原名），次要站 bigmodel/CNY 加 `-cny`；MiniMax 主站 = minimaxi/CNY（原名），次要站 minimax-io/USD 加 `-usd`。方向相反但自洽，`vendor::model` 无碰撞，已固化于 catalog.rs 测试注释（裁决点①接受；文档化建议见遗留项 6）。
- 前端配套：pricingStore.ts 不做汇率折算，`currency` 必填标注，`getModelCurrency()` 供展示层标注（pricingStore.ts:1265）。

### 2.4 分档价格（tieredPricing 43 条）

- **GLM 32K/128K 分档**：CNY 站输入分档 `[0, 32K)` 为基础价、`[32K, ∞)` 为增量档（如 glm-5-turbo-cny：¥5/22 → ¥7/26，catalog.json `glm::glm-5-turbo-cny`）；GLM-4.7 为输入 × 输出组合档（32K 输入 × 200K 输出，2 档）；Qwen 全系 32K/128K/256K 分段（qwen3-coder-plus 三档 32K/128K/256K）。
- **长上下文 2x 档**（仅 `minTokens` 的无上界档）：Grok ≥200K（input 2x：grok-4.5 $2.0→$4.0）、Gemini 3.1 Pro ≥200K、MiniMax M3 >512K（2.1→4.2）、gpt-5.6 272K（input 2x / output 1.5x：$5/$30 → $10/$45）。结构对齐 litellm `tiered_pricing.range`、models.dev `cost.tiers`、OpenRouter `overrides` 三源。
- 实跑 43 条含分档（gemini 4 / glm 9 / grok 6 / minimax 2 / openai 7 / qwen 15），零区间重叠；R4 审计报 42 条，差额 1 为审计脚本统计口径（不影响合法性结论，本次以实跑为准）。

### 2.5 特化优化落地（G1 / G2 / G7）

对应 `02-model-specific-optimizations.md` 三个高优先缺口，均在 R3 落地并有专项测试钉死：

| 缺口   | 内容                                               | 落地位置                                                                                                                                                                                                                        | 效果                                                                                                                                                                                                                             |
| ------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1** | Anthropic 1h 长档在 catalog 路径不可达             | `request/cache.rs:420-425`（`capability_from_behavior` 双桶判定：`default_ttl==Hour` **或** `vendor==Anthropic && supports_cache_control` → 5m+1h 双桶）                                                                        | 1h 长档不再被矩阵 `default_ttl=Short` 永久关闭；`cacheWritePrice1h` 定价与请求侧恢复接线；厂商限定防止 MiniMax M2.x / 百炼误入 1h 桶（反例测试 `build_cache_policy_short_config_keeps_five_minutes_only`）                       |
| **G2** | x-grok-conv-id 会话亲和头未接线                    | `models/cache_key.rs:41-67`（数据表）+ `request/cache.rs:499-507`（`affinity_header` 消费）+ `request/build.rs:268-269`（`affinity_http_headers` 提取）+ `models/behavior.rs:214`（`conv_header_name: Some("x-grok-conv-id")`） | Grok Chat 轨粘性路由恢复（同会话路由同服务器）；值 = 键推导结果（64 码点钳制）；其他厂商矩阵 `conv_header` 关 → 不注入；P2 留下的判定入口正式接线                                                                                |
| **G7** | Anthropic adaptive thinking + display:"summarized" | `request/vendor.rs:416-432`（`is_adaptive_thinking_model` 按系列前缀 Opus 4.7+ / Sonnet 5+ / Fable 5 / Mythos 5）+ `vendor.rs:468-475` + `build.rs` 三处测试                                                                    | 新代际发 `thinking{type:"adaptive",display:"summarized"}` + 顶层 `effort`（xhigh/max 直发）；display 强制 summarized 防止默认 omitted 吐空 thinking 块破坏缓存前缀；minimal 不在档位集 → 降级 low；旧代际维持 budget_tokens 回退 |

### 2.6 其余落地物

- **Schema 59 字段**（03 §2）：标识 8 / 窗口 2 / 四指标 7 / 扩展价格 9 / 缓存语义 12 / 能力位 16 / 溯源与生命周期 7；全字段 `#[serde(default)]` 可缺省解析。
- **TTL 四档**：ttl.rs 新增 `CacheTtl::HalfHour`（"30m"，承载 gpt-5.6 系，catalog 中 3 条）；全库分布 5m 47 / 1h 22 / 30m 3 / 24h 29。
- **推导价结构**：21 条 Qwen `priceStatus:"derived"` + `derivation`（cacheReadFactor 0.1 / cacheWriteFactor 1.25 / implicitCacheReadFactor 0.2 三因子齐出），绝对价 = 比例 × 官方输入价计算无误（A8 确认）。
- **存储费**：39 条带 `storagePricePer1mHour`（Gemini 1.0/4.5、GLM 0 限时免费至 2026-08-31、豆包 0.017 存档）。
- **能力位**：supportsResponses true 52 / false 92 / 缺省 7；supportsVision=true 37 条；cacheType 值域 `auto` 89 / `both` 59 / `none` 2（cursor），与 behavior.rs:440 自动缓存轨判定完全对应。
- **前端四指标**：pricingStore.ts `CATALOG_CACHE_RATES` 125 键（123 引号键 + o1/o3 裸键），回退链 = 运行时快照 → 目录静态表 → 用户扩展字段 → 全局乘数（pricingStore.ts:1398 `resolve4dPrices`）；`estimateCostUsd4d` 四指标估算 + `estimateSavingsUsd`；Anthropic 1h 档写价由 `saveCacheTtlMode('1h')` 切换（pricingStore.ts:1438-1443）；tieredPricing 档位匹配明确不入前端（基础价）。

---

## 3. 关键事实修正（对比 v1）

以下为 v2 专项对 v1 知识基线的重大事实修正（R1 调研实证，非估计）：

| #   | 事实                                 | v1 口径                                                                                 | v2 修正（依据）                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **composer 不是 OpenAI 模型**        | 归属未知/曾被怀疑并入 OpenAI（master §13.4 #4 明言「composer 并入 OpenAI 属错误归属」） | Composer 2.5 为 Cursor（Anysphere）自研编程模型线，基于 Moonshot Kimi K2.5 开源 checkpoint 继续预训练 + RL；仅 Cursor 内可用、不开放独立 API（01-composer.md：官方 FAQ「Composer 2.5 is only available in Cursor」）；推理自托管（Fireworks 合作），不经 Moonshot API → Moonshot 缓存价不适用 |
| 2   | **gpt-5.6 是三档系列而非单模型**     | v1 录单条 gpt-5.6（缺输出价，litellm 副本口径 $30）                                     | 官方 ID 为 `gpt-5.6-sol/terra/luna` 三档（alias `gpt-5.6` 路由到 sol）；不存在 `gpt-5.6-codex/pro/chat` 官方 ID（pro 档是 `reasoning.mode:"pro"` 请求参数）；写价 1.25x（6.25/2.5/0.25）、TTL 30m、最低缓存 1024 严格；5.5 及更早写免费（01-openai.md §1.1）                                  |
| 3   | **kimi-k2.7-code 官方命名**          | 任务书猜测「kimi-for-code / k2.x-code 变体」                                            | 官方 Coding 特化模型名就是 `kimi-k2.7-code`（+高速版 `-highspeed`）；不存在 `kimi-k2.7` 通用版、不存在「kimi-for-coding」；仅思考模式 + Preserved Thinking 固定开启 + prompt_cache_key 必填（01-kimi.md §3.4 官方命名核实）                                                                   |
| 4   | **qwen3.8-max 现行旗舰**             | v1 目录无此模型（qwen 3 条价格全空）                                                    | 官方最新旗舰 ID 即 `qwen3.8-max`（三源一致：百炼模型广场 / 千问平台 / models.dev）；¥12/¥36（思考与非思考同价）、上下文 1M、effort low/medium/xhigh；`qwen3.7-max` 为 2026-05/06 快照名；`qwen3-7-max` 非官方名（01-qwen.md §1 用户指正确认）                                                 |
| 5   | **GLM-5V-Turbo 多模态**              | v1 无视觉条目                                                                           | 智谱首个多模态 Agent 基座模型（图像/视频/文本/文件四类输入），`supportsVision` 必须 true，多模态输入按内容构成计量、不能按纯文本 token 等价折算（01-glm.md §2.2）；GLM 4.6V / 4.6V-FlashX / 4.6V-Flash / 4.5V 同族收录并补 apiModel 点号名（M1-M4）                                           |
| 6   | **deepseek-chat/reasoner 停用**      | v1 无 legacy 概念                                                                       | 2026-04-24 changelog 预告「三个月后停用」，2026-07-24 已停用；官方定价页（2026-08-03）仅 v4-flash / v4-pro 两个模型；存量配置须迁移（过渡期映射 v4-flash 非思考/思考模式已失效）→ 不转录（master §13.4 #1、01-deepseek.md §1.1）                                                              |
| 7   | **DeepSeek v4-pro Responses 待上线** | v1 无该字段                                                                             | 官方计划「2026 年 8 月初」加入，截至抓取日（8-03）未上线 → `supportsResponses:false` + notes 标注翻转计划；8 月中旬刷新确认后翻转（01-deepseek.md §2/§4）                                                                                                                                     |

其他附带修正：Gemini 3.5/3.6 flash 与 3.1 Pro 输出价补齐（R0 缺 4 条 outputPrice 销账）；GLM 4.6/4.5 价同 4.7 档；MiniMax M2.1/M2 补录（同 M2.5 轨）；grok-4.20-0309 三档确认现行；OpenRouter `gpt-5.6-*-pro` slug 与 models.dev 独有 `gpt-5.5-instant` 明确不收录（非官方 ID）。

---

## 4. 剩余特化优化清单登记（27 条）

### 4.1 口径说明

`02-model-specific-optimizations.md` 共 30 条编号特化清单（#1-#30）。专项已落地 **3 条特化**（G1↔#10、G2↔#22、G7↔#7/#8，其中 #7 与 #8 为同一实现的两个侧面，合并计一条特化），剩余 **27 条**按价值分级登记如下。另有 7 条为 v1 时期已覆盖且钉死良好（#4 部分收尾、#5 部分、#6、#13、#17、#23、#27），不重复回改（见 4.5）。

### 4.2 高价值待做（进入后续排期，按影响排序）

| 编号      | 特化内容                                                                                                                       | 缺口 | 触发条件 / 前置                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1 + #2   | gpt-5 版本子族 effort 档位集 + release_date 门控（none/xhigh/chat/pro/codex 分支，家族正则防误匹配）                           | G10  | 触发：前端模型配置面需要按模型页展示精确档位（隐藏超范围档 + 请求层兜底降级）。前置：目录条目增 `release_date` 字段（数据面）                                           |
| #11 + #14 | DeepSeek effort 梯子加 max + 低档位门控（effort=low 仅 v4-flash 允许）                                                         | G3   | 触发：DeepSeek 官方文档确认 max 档 wire 值。前置：ReasoningEffort 枚举扩 `Max`（vendor.rs:44-69）                                                                       |
| #12 + #28 | DeepSeek/GLM 的 thinking.type + reasoning_effort 双旋钮口径（官方 2025 末起支持；Zhipu 恒 binary）                             | G4   | 触发：以官方 API 文档复核后对齐（Reasonix 口径 vs crish 注释 vendor.rs:373 存在版本差异）；对齐后 deepseek_invariants.rs 补新不变量                                     |
| #3        | gpt-5 默认档位 + reasoningSummary:"auto" + include 加密推理 + textVerbosity:"low"                                              | G11  | 触发：Responses 构建面（build.rs:48-71）接入无状态多轮推理回放需求（store:false 场景）                                                                                  |
| #20 + #21 | Mistral toolCallId 9 位填充 + tool 后禁止紧邻 user（补 "Done." 序列）                                                          | G8   | 触发：Mistral 系模型接入 crish（当前目录无 Mistral 条目）；注意会话持久化回放一致性                                                                                     |
| #26       | MiniMax M3 二进制 thinking.type（adaptive\|disabled），省略 reasoning_effort                                                   | G5   | 触发：M3 用量进入主线；前置：vendor.rs 增 minimax 前缀分支（M2.x 维持 effort 语义）                                                                                     |
| #24       | Gemini gemini-3 档位细分（flash-image minimal/high、pro-image high、flash minimal-low-medium-high）+ 2.5-pro budget 上限 32768 | G12  | 触发：Gemini 3 系档位展示需求（与 #1/#2 同属 UI 档位联动）；前置：能力表补 gemini-3 前缀细分行                                                                          |
| #19       | Kimi K3 固定采样省略 + max_completion_tokens 字段                                                                              | G13  | 触发：K3 配置默认化（当前 K3 在目录但非默认模型）；前置：build.rs:28-44 增 K3 分支                                                                                      |
| #5        | gpt-5.6 显式模式位在 catalog 路径恒 false（`capability_from_behavior` 无该位）                                                 | G6   | 触发：随 catalog_refresh 远程源专项数据面一次补齐（supportsImplicitCaching / supportsPromptCacheKey / explicit 模式位进目录）；当前兜底表路径行为正确，仅为表达能力缺口 |

### 4.3 登记不做（触发条件未到 / 协议域立项）

| 编号 | 特化内容                                                    | 登记原因 / 触发条件                                                                                                                       |
| ---- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| #9   | Opus 4.8 原生会话中 system 更新（`<system-update>` 兜底）   | 属协议/消息语义域（非缓存专项）；触发：**等原生 Anthropic Messages 轨建设立项**时一并实现                                                 |
| #18  | Kimi Anthropic 兼容轨 adaptive + display summarized         | crish 无 Kimi Anthropic 轨（仅 OpenAI 兼容轨）；触发：**等 Kimi Anthropic 兼容轨立项**（opencode 同构：transform.ts:723-729 / 1198-1205） |
| #25  | Gemini stateful interactions（previous_interaction_id）     | 属协议域建设；触发：**等 Gemini interactions API 专项立项**；R1 阶段仅目录记录能力标记                                                    |
| #16  | NVIDIA NIM DeepSeek-V4 `chat_template_kwargs.thinking` 注入 | openai-compatible 的 vendor 分支；触发：**NVIDIA NIM 部署接入时**（低优先级）                                                             |
| #29  | Copilot nanoAIU 计费回退                                    | Copilot 通道不在 crish 支持面；触发：**随 Copilot 支持立项**（backlog）                                                                   |
| #30  | OpenRouter `anthropic/*` 自动切 cache_control 透传          | crish 无 OpenRouter 通道特化；触发：**随 OpenRouter 支持立项**（低优先级）                                                                |

### 4.4 待数据刷新 / 维持现状（含收尾）

| 编号              | 特化内容                                                         | 状态与触发条件                                                                                       |
| ----------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| #4                | 24h 扩展缓存保留白名单（gpt-5.5 及更早 → Day、5.6 → Short 已对） | 已覆盖；仅剩收尾：**gpt-4.1 归属判定**（00-catalog §2.1 与 jcode 口径差异点）确认后冻结              |
| #15               | DeepSeek 模型系警告策略细分（requires-tool-call-reasoning 名单） | 维持现状（crish 恒 Require 比名单更宽，行为等价且更安全）；触发：**缩窄需先评估工具轮 400 风险闭环** |
| #12 / #28         | DeepSeek / GLM thinking 形态口径                                 | 待官方文档复核后对齐（见 4.2 高价值待做 G4）                                                         |
| #24 存储/预算部分 | Gemini thinking budget 上限（2.5-pro 32768 / 其余 24576）        | 触发：budget_tokens 换算处特判（与档位细分同批）                                                     |

### 4.5 已覆盖且钉死良好（无需回改，记录在案）

#6（prompt_cache_key 路由辅助，配额属 P5 观测层）、#13（reasoning_content 契约三不变量）、#17（Kimi prompt_cache_key，catalog 数据真源恒在）、#23（cache hit 归因解析）、#27（MiniMax M2/M3 缓存开关分流）、#5 兜底表路径（OPENAI_CACHE_56）、#4 TTL 分档（除 gpt-4.1 收尾外）。

---

## 5. 遗留项登记（7 项）

| #   | 遗留项                                         | 当前状态                                                                                                                                                                                         | 触发条件 / 责任域                                                                                                                                                             |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **M5：glm-4-5-x / glm-4-5-airx apiModel 形态** | 缺省横线（catalog.json），master 与 01-glm.md 均未标注 API ID 形态；若官方为点号 `glm-4.5-x` 则请求层会构造错误模型 ID（与 D4-D7 同类）                                                          | 触发：**z.ai 官方核实**（01-glm.md 侧无值，需外部确认）；确认后补 apiModel 或加 notes「已核实为横线」                                                                         |
| 2   | **Gemini 3.5/3.6 flash 存储费**                | 3 条无 `storagePricePer1mHour` + notes「R0 记 1.00 存疑待复核」（裁决点⑥接受）                                                                                                                   | 触发：**ai.google.dev 官方页复核**（R1 期间不可达）                                                                                                                           |
| 3   | **GLM 存储费恢复价 9/1 复核**                  | 存储费 0 限时免费（`storagePriceFreeUntil: "2026-08-31"`），恢复价未获取                                                                                                                         | 触发：**2026-08-31 到期前复核**并回填 `storagePricePer1mHour`（P5 定价域）                                                                                                    |
| 4   | **DeepSeek 峰谷定价生效**                      | `peakPricing2x: true` + `peakPricingSchedule.effectiveFrom: null`（北京 9:00-12:00 / 14:00-18:00，生效日期待官方公告）                                                                           | 触发：**官方公告生效日期**后回填 `effectiveFrom`（P5 定价域）                                                                                                                 |
| 5   | **DeepSeek v4-pro `supportsResponses` 翻转**   | false + notes「8 月中旬刷新翻转」；官方 8 月初窗口已开、抓取日未上线                                                                                                                             | 触发：**2026-08-15 前后刷新官方定价页**确认后翻 true                                                                                                                          |
| 6   | **schema 例外条款落地（S3）**                  | 13 条「supportsPromptCaching=true 且 cacheReadPrice=null」与条件必填字面条款冲突（OpenAI pro 6 + gemini 变体 5 + glm-4-32b + qwen3-8-max-preview）；另双币种后缀约定仅存在于 catalog.rs 测试注释 | 触发：**03-catalog-v2-schema.md §2 C 组补例外条款**（「pro 档无缓存折扣 → null + notes（P5 按全价）」「读价未获取 → null + notes」）+ §1.4 补后缀命名契约（防校验层加严误杀） |
| 7   | **models.dev 远程源接入**                      | schema §4.1/§4.2 已定字段映射与冲突裁决（静态人工 > models.dev > OpenRouter 渠道价，禁止跨渠道覆盖）；`catalog_refresh` 合并链入口已定义（version +1）                                           | 登记为**后续专项**：运行时 `catalog_refresh` 扩展（含 G6 数据位、reasoningEffortTiers 等远程字段消费）；触发：远程源项目立项                                                  |

另附（非本专项直接责任）：GLM cache_control 实测结果（behavior.rs 保守 false 待实测）、Anthropic Sonnet 5 9/1 涨价切换（P5 日期切换域，`promoReplacesAt` 已就绪）。

---

## 6. 与既有方案的关系

### 6.1 对 90-final 方案 R3 缺口的补全

90-final R3（T-18）落地了 `ModelCatalog + catalog.json 28 条起步集`（deepseek×2 / anthropic×7 / openai×2 / kimi×1 / grok×2 / minimax×3 / gemini×4 / glm×4 / qwen×3，其中 qwen 3 条价格全空）。该 28 条是 90-final 方案的「起步集」，四指标完整仅 11 条（39.3%），且存在结构级缺陷：

| 维度       | 90-final R3（v1，28 条）                    | v2 专项（151 条）                                                                       |
| ---------- | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| 厂商覆盖   | 9 家（无 cursor/composer；豆包/ERNIE 0 条） | 10 家（新增 cursor×2；豆包/ERNIE 按用户指示存档不转录）                                 |
| 四指标完整 | 11 条（39.3%）                              | 135 条（89.4%）                                                                         |
| 价格全空   | 3 条（Qwen 全空）                           | 0 条（Qwen 全系以官方比例推导绝对价，21 条 derived）                                    |
| 缺输出价   | 5 条（gpt-5.6/5.5 + gemini×4）              | 0 条（R1 全部销账）                                                                     |
| 币种       | 无显式契约                                  | USD/CNY 必填 + 双币种键后缀约定                                                         |
| 写价语义   | 缺字段双义（写免费 vs 未收录）              | 三态互斥（0+true / >0+false / null+false）                                              |
| 生命周期   | 靠文档注释记忆                              | promoExpiresAt / promoReplacesAt / peakPricingSchedule / storagePriceFreeUntil 显式字段 |
| 长度分档   | 无                                          | tieredPricing 43 条（32K/128K/200K/272K/512K 边界）                                     |
| 数据结构   | 28 条裸条目                                 | `{version, schema, updatedAt, entries}` 包装 + 远程源合并锚点                           |

v2 不推翻 v1 的消费架构（catalog.rs 解析、behavior.rs 矩阵、ttl.rs 路由、前端三级费率），而是以**数据契约升级**方式补全缺口：行为矩阵仍为 vendor 级兜底真源，v2 目录在其上叠加模型级覆盖；`cacheType` 值域改名（`automatic`→`auto`）保持 v1 兼容保留（behavior.rs:440 同时认 `automatic|auto|both`）。

### 6.2 四指标字段对 P2 / P5 消费方的意义

- **P2（请求层 wire / 缓存机制）**：
  - `cacheTtlOptions`（5m/1h 双档）供 P2 wire 层 TTL 桶选择（schema §5.1 要点）；G1 修复即 P2 域（1h 长档桶在 catalog 路径恢复）。
  - `supportsCacheControl` / `breakpointMax` / `lookbackBlocks` / `promptCacheMinTokens`：显式断点注入参数来源；G7 adaptive 形态按模型代际切换也读目录/矩阵。
  - `cacheType` 值域直接驱动 `capability_from_behavior` 的自动/显式/键轨选择（behavior.rs:440 判定）。
  - `supportsPromptCacheKey` / `supportsImplicitCaching` 两字段为 v2 新增的模型级覆盖来源（此前真源在 vendor 矩阵）。
- **P5（定价 / 成本域）**：
  - 四指标绝对价（input/output/cacheRead/cacheWrite + 5m/1h 双档写价）：成本估算的唯一真源；pro 档 null 语义 =「P5 按全价」。
  - `tieredPricing`：长度分档匹配归 P5/服务端 catalog 层（前端明确不做档位匹配）。
  - `priceStatus:"derived"` / `derivation`：推导价可入成本计算但可信度降级（P5 与前端须感知）。
  - 生命周期字段：`promoExpiresAt`/`promoReplacesAt`（Sonnet 5 9/1 切换）、`peakPricingSchedule.effectiveFrom`（峰谷）、`storagePricePer1mHour` + `storagePriceFreeUntil`（存储费，前端不估、服务端核算）。
  - `reasoningPrice`：推理 token 计价（deepseek-v4-flash = 0.28），当前仅记录不计算，消费在 P5。
- **前端（crish-desktop）**：`catalog_get` 运行时快照 + 静态表 125 键 → `estimateCostUsd4d` 四指标估算与节省展示；`currency` 感知标注（不换算）；1h TTL 档切换写价（仅 Anthropic 有独立 1h 写价字段）。

---

## 7. 收尾核验记录（本子代理实跑，2026-08-04）

| 核验项                                    | 结果                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cargo test --workspace`                  | **78 套件全绿，0 失败**（agent-provider 526 用例含 G1/G2/G7 专项测试：`build_cache_policy_anthropic_catalog_path_enables_one_hour_bucket`、`build_cache_policy_grok_injects_affinity_header`、`adaptive_effort_object_injects_display_summarized` 等） |
| `vitest run src/api/pricingStore.test.ts` | **28/28 通过**（四指标回退链、1h 档切换、币种标注、estimateCostUsd4d）                                                                                                                                                                                 |
| 全量前端套件                              | 4239 用例，仅 3 条既有失败（Menu.lowViewport 相关，与专项无关，符合 AGENTS.md 记录的前端基线失败特征）                                                                                                                                                 |
| catalog.json 结构脚本核验                 | 151 键零重复；写价三态零异常；derived 21 条全部带 derivation；tieredPricing 零区间重叠；币种误标 0；16 条缺项全部带 notes                                                                                                                              |

诚实边界：任务书载明终验口径「vitest 167」未能从仓库文档/提交中定位出处，本报告以实跑数字为准（pricingStore 28/28 + 专项相关套件全绿）；未编造任何测试结果。

---

## 8. 交接与下一步建议

1. **后续专项一：catalog_refresh 远程源**（models.dev 主源 + OpenRouter 渠道增强）——schema §4 映射与冲突裁决已就绪，落地时一并补齐 G6 数据位与 `reasoningEffortTiers` 远程消费。
2. **P5 定价域消费**：tieredPricing 档位匹配、promoExpiresAt/promoReplacesAt 日期切换、峰谷、存储费核算、derived 价可信度降级——全部字段已入目录，等待 P5 排期接线。
3. **schema 例外条款与后缀契约文档化**（遗留项 6）：避免校验层按条件必填加严误杀合法条目。
4. **日期驱动刷新项**（第 5 节）：9/1 复核 GLM 存储费与 Sonnet 5 切换、8 月中旬刷新 DeepSeek v4-pro Responses、峰谷生效日期公告跟踪。
5. **高价值特化排期**（第 4.2 节）：优先 G10（gpt-5 effort 档位门控，影响 UI 与 400 风险）与 G3（DeepSeek effort max），两者前置均为数据面小改 + 枚举扩展。

---

> 本报告全部数字可回溯至 catalog.json 原文（实读 151 条）、04-master-model-list.md、01-_.md / 02-_.md 调研文档与 05-audit-report.md；实跑结果为本报告撰写时执行；未编造任何测试结果。
