# 02 · 思考强度与 vendor 层——Conex vs pi-ai / DSH / opencode 对比

> 战役：多模型适配战役（参考外部模式）
> 范围：`crates/agent-provider/src/request/` 的思考强度（ThinkingIntensity）与 vendor 能力层
> 对比对象：pi-ai 0.82.1（`D:\software\DeepSeek Harness\resources\host\node_modules\@earendil-works\pi-ai`）、DeepSeek Harness（`reference/deepseek-harness`）、opencode（`reference/opencode`）
> 基线问题编号：G2=模型级档位白名单无消费端、G6=wire 改名语义缺失、G8=能力描述与请求校验分离

---

## 〇、结论速览

Conex 在**思考回传不变量**与 **Anthropic adaptive 思考形态**上已领先（有完整实现 + 测试钉死），但在**模型级档位白名单的消费**、**wire 改名**、**能力描述与请求校验分离**三类语义上与 pi-ai / DSH 存在结构性差距。六个维度逐项如下：

| 维度               | Conex 现状                                     | pi-ai / DSH / opencode                                                     | 差距                                                                      |
| ------------------ | ---------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1 档位体系         | 7 厂商 × 8 档，系列级能力表                    | pi-ai 7 档全序 + 模型级 `thinkingLevelMap`；DSH 仅 off/high/max            | 档位枚举完整，但消费以「系列级」而非「模型级」为主                        |
| 2 模型级档位白名单 | 有定义无消费端（**G2**）                       | pi-ai 每模型 `thinkingLevelMap`（档位→wire 拼写/隐藏）                     | **缺失：模型级白名单未接入请求构建**                                      |
| 3 wire 方言        | 4 格式固定 vendor                              | pi-ai 8 种 thinkingFormat（含 qwen enable_thinking 等）                    | 覆盖了主流 dict 型，缺开关型方言与 wire 改名                              |
| 4 归一化 vs 拒绝   | 纯降级式                                       | pi-ai clamp 升档回退；DSH 拒绝式 `UNSUPPORTED_REASONING_EFFORT`            | 语义不同：Conex 无拒绝面（**G8**）                                        |
| 5 Anthropic 思考   | adaptive + display:summarized + anthropic-beta | pi-ai adaptive + 对 forceAdaptive 跳 beta 头；opencode 强制 summarized     | Conex 已覆盖 adaptive，但 **anthropic-beta 头对新代际未跳过**（过度发送） |
| 6 思考回传         | Require 模式空串兜底 + 不变量测试钉死          | pi-ai `requiresReasoningContentOnAssistantMessages`；DSH serialize.ts drop | Conex 已领先（C1 唯一接线 + 空串兜底）                                    |

修复建议只谈逻辑改造点与验收断言，标注对应基线问题 G2/G6/G8。

---

## 一、档位体系对比

### 对比表

| 项       | Conex                                                                                                                                                                                                                                                                           | pi-ai/DSH                                                                                                                                                    | 差距结论                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 档位枚举 | `ReasoningVendor` 7 厂商（openai/anthropic/deepseek/gemini/qwen/glm/kimi + auto，vendor.rs:41-52）；`ReasoningEffort` 8 档（off/auto/minimal/low/medium/high/xhigh/max，vendor.rs:71-83）；`ThinkingIntensity` 7 档（off/minimal/low/medium/high/xhigh/max，vendor.rs:114-126） | pi-ai `EXTENDED_THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]`（models.js:391）；`getSupportedThinkingLevels`（models.js:392-403） | **档位枚举全集一致**（Conex 多 `auto` 档，语义为「未显式指定」）                                                                       |
| 全序     | `ThinkingIntensity` / `ReasoningEffort` 为 Rust 枚举，序由 `levels: &[ThinkingIntensity]` 数组承载（vendor_capability.rs:12-39）                                                                                                                                                | pi-ai 序由 `EXTENDED_THINKING_LEVELS` 常量固定                                                                                                               | **一致**；Conex 用数组序 + 手工降级映射表达全序                                                                                        |
| DSH 三档 | （不适用）                                                                                                                                                                                                                                                                      | DSH llm-deepseek 仅 `off/high/max` 三档（adapter.ts:98-102 `REASONING_EFFORTS`）；`thinking:disabled` 锁定仅 off（adapter.ts:103-105）                       | DSH 刻意收窄（DeepSeek 官方语义），Conex 档位面更宽（deepseek 用 LEVELS_NO_MINIMAL=low/medium/high/xhigh，vendor_capability.rs:79-84） |
| 能力来源 | `MODEL_SERIES_CAPABILITIES` 系列级前缀表（vendor_capability.rs:106-156）+ `infer_thinking_capability` 最长前缀命中（vendor_capability.rs:159-170）                                                                                                                              | pi-ai 每模型条目独立 `thinkingLevelMap` + `reasoning` 布尔                                                                                                   | **能力粒度不一致**：Conex 以「模型系列」为粒度，pi-ai 以「模型条目」为粒度                                                             |

### 差距结论

- **档位枚举与全序：已覆盖**。Conex 的 8 档 effort/7 档 intensity 与 pi-ai 的 7 档全集一致，系列级能力表能覆盖绝大多数模型。
- **缺口在粒度**：Conex 只有系列级（vendor_capability.rs:106），pi-ai 是模型级（thinkingLevelMap 逐条目）。系列级会把同一系列内的模型一视同仁，无法表达「同系列内该模型只支持某几档」的特例（如 qwen3-8-max 只支持 low/medium/xhigh，见问题基线 G2 引用）。

---

## 二、模型级档位白名单与 wire 映射对比

### 对比表

| 项                         | Conex                                                                                                                                                                      | pi-ai/DSH/opencode                                                                                                                                        | 差距结论                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 模型级档位数据载体         | `ModelCatalogEntry.reasoning_effort_tiers: Option<Vec<String>>`（catalog.rs:141）；文档注释「qwen3.8-max ["low","medium","xhigh"]」                                        | pi-ai 每模型 `thinkingLevelMap`（models 数据），键=档位，null=不提供，字符串=wire 拼写改名                                                                | 载体语义单一（仅白名单 Vec），无 wire 拼写维度                                                                                       |
| 模型级档位消费端           | **无**（全仓 grep `reasoning_effort_tiers` 仅 catalog.rs:141 定义 + catalog_tests.rs:586 解析断言 + catalog_override.rs 无此项，无 `supports_reasoning_effort` 消费）      | pi-ai 消费在 openai-completions.js:560-641 各方言分支（`model.thinkingLevelMap?.[options.reasoningEffort]`）                                              | **G2：模型级白名单无消费端**                                                                                                         |
| wire 拼写映射（改名/隐藏） | 无。effort→wire 由 vendor_wire.rs 硬编码换算（normalize_reasoning_effort 12-18 / effort_to_budget_tokens 21-33 / thinking_to_gemini_thinking_level 61-69）                 | pi-ai `thinkingLevelMap` 支持档位→wire 拼写改名（如 `max:"ultra"` 网关词汇，README.zh.md:84）与 null 隐藏                                                 | **G6：wire 改名语义缺失**                                                                                                            |
| 具体实例差异               | deepseek-v4-flash：Conex 走系列 `deepseek-v4 → DEEPSEEK_REASONING`（levels=low/medium/high/xhigh，vendor_capability.rs:79-84），与模型级白名单冲突时**系列级为准且不透明** | pi-ai deepseek-v4-flash `thinkingLevelMap{minimal:null,low:null,medium:null,high:"high",max:"max"}`（deepseek.json / opencode-go.json），仅 high/max 有效 | 隐私冲突：Conex 若用户选 medium，系列级会发 `reasoning_effort:"medium"` 而官方只认 high/max；pi-ai 遇不支持档位由 clamp/拒绝语义处理 |
| glm-5.2                    | Conex GLM_REASONING(levels=low/medium/high/xhigh)                                                                                                                          | pi-ai zai-coding-cn `thinkingLevelMap{minimal:null,low:"high",medium:"high",high:"high",max:"max"}`（多个档位改名到 high）                                | 冲突实例：Conex 会发 medium，pi-ai 改名发 high——**wire 改名真实影响请求**                                                            |

### 差距结论

- **模型级白名单（G2）**：`reasoning_effort_tiers` 只有定义与测试，无消费端。请求构建完全走系列级能力表，模型级特例（qwen3-8-max、deepseek-v4 仅 high/max）不生效。
- **wire 改名（G6）**：Conex 无「档位→wire 字符串改名」表达。如 GLM-5.2 把 low/medium 统一映射到 wire "high"、cerebras 的 `off:"none"`（cerebras.json）、openrouter 的 `reasoning:{effort}` 嵌套（openai-completions.js:598-609），Conex 都无法表达，只能硬编码换算或发规范名（可能被下游拒绝）。
- **G6 与 G2 的数据载体依赖**：问题基线明确 G6 依赖 G2 的数据载体（00-问题基线.md:65）。`reasoning_effort_tiers: Vec<String>` 扩展为「档位→Option<wire 拼写>」映射后可同时承载白名单与改名。

### 修复建议（G2 + G6）

1. **扩展 `reasoning_effort_tiers` 为映射载体**：类型从 `Option<Vec<String>>` 改为 `Option<BTreeMap<String, Option<String>>>`（或新增并列字段），键=规范档位，值=Some(wire 拼写) 或 None（隐藏不支持档）。保留向后兼容解析（旧 Vec 形式可接受，值同规范名）。
2. **接入请求构建**：在 `request/vendor.rs` / `vendor_wire.rs` 的 effort→wire 换算链前插入「模型级覆盖」解析——优先查模型级映射（若有），未命中回系列级 `ThinkingCapability`。改造点收敛在 `reasoning_effort_object`（vendor.rs:227-293）与 `normalize_reasoning_effort`（vendor_wire.rs:12-18）两处入口，避免散落。
3. **消费判定与归一化合并**：模型级映射存在时，其 null 项（隐藏档）应视为「不支持」参与归一化；规范化逻辑与现有 `normalize_thinking_intensity`（vendor.rs:319-346）同构，但数据源从系列级改为模型级优先。
4. **验收断言**（新增测试）：
   - `reasoning_effort_tiers={high:"high",max:"max",low:None}` 的模型选 low → 归一化后不发（或降级 high，语义待定，见维度四）；选 high → wire 发 `"high"`。
   - `{medium:"high"}` 改名映射 → 请求体 `reasoning_effort:"high"`（**wire 字节断言**，对齐 pi-ai GLM-5.2 实例）。
   - 模型级白名单存在但为空选项时，显式请求不支持档 → 归一化/拒绝语义与维度四对齐。

---

## 三、wire 方言对比

### 对比表（逐方言）

pi-ai `thinkingFormat` 分派位于 openai-completions.js:560-641，`detectCompat` 位于 1140-1160。Conex `ReasoningFormat` 定义位于 vendor.rs:144-156。逐方言对照：

| pi-ai 方言                                          | wire 形态                                                                                                                         | Conex ReasoningFormat                                                               | Conex 覆盖                                                                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| openai（兜底，openai-completions.js:632-641）       | `reasoning_effort` / responses `reasoning.effort` + `off` 翻译                                                                    | `ReasoningEffort`（vendor.rs:360-367 OpenAI 分支）                                  | **覆盖**                                                                                                                                 |
| deepseek（openai-completions.js:586-597）           | `thinking:{type:"enabled"}` + `reasoning_effort`（带档位时）；off → `thinking:{type:"disabled"}` + thinkingLevelMap.off≠null 判定 | `ReasoningEffort`（deepseek/qwen/glm/kimi → `reasoning_effort`，vendor.rs:266-269） | **部分覆盖**：Conex 只发 `reasoning_effort`，**不发 `thinking:{type}` 开关**；off 时省略 reasoning 参数而非发 `thinking.type:"disabled"` |
| zai（openai-completions.js:560-570）                | `thinking:{type:"enabled",clear_thinking:false}` + `reasoning_effort`                                                             | 无                                                                                  | **缺失**：GLM 系走 z.ai 编码 PaaS 需 `thinking` 开关                                                                                     |
| qwen（openai-completions.js:571-573）               | `enable_thinking: !!effort` 布尔开关                                                                                              | 无                                                                                  | **缺失**：qwen enable_thinking 开关型方言                                                                                                |
| qwen-chat-template（openai-completions.js:574-579） | `chat_template_kwargs{enable_thinking,preserve_thinking}`                                                                         | 无                                                                                  | **缺失**（DSH 明确不暴露 chat-template 变体，README.zh.md:90）                                                                           |
| chat-template（openai-completions.js:580-585）      | `buildChatTemplateKwargs(...)` 模板 kwargs                                                                                        | 无                                                                                  | **缺失**（同上）                                                                                                                         |
| openrouter（openai-completions.js:598-609）         | 嵌套 `reasoning:{effort}`，off → `reasoning:{effort:"none"}`                                                                      | 无（`ReasoningVendor` 无 OpenRouter 项，vendor.rs:41-52）                           | **缺失**                                                                                                                                 |
| ant-ling（openai-completions.js:610-615）           | `reasoning:{effort}`                                                                                                              | 无                                                                                  | **缺失**                                                                                                                                 |
| together（openai-completions.js:616-622）           | `reasoning:{enabled}` + `reasoning_effort`                                                                                        | 无                                                                                  | **缺失**                                                                                                                                 |
| string-thinking（openai-completions.js:623-631）    | `thinking:<string>` 直接字符串                                                                                                    | 无                                                                                  | **缺失**                                                                                                                                 |
| Anthropic（anthropic-messages.js）                  | `thinking:{type:adaptive/enabled}` + effort/budget_tokens                                                                         | `ThinkingBudget` + `ThinkingAdaptive`（vendor.rs:368-382）                          | **覆盖**                                                                                                                                 |
| Gemini                                              | `generation_config.thinking_level`                                                                                                | `ThinkingLevel`（vendor.rs:383-387）                                                | **覆盖**                                                                                                                                 |

### 差距结论

- **Conex 只覆盖「dict 型 effort」方言（reasoning_effort / budget_tokens / thinking_level / adaptive）**，对 pi-ai 的**开关型**（qwen `enable_thinking`、zai `thinking:{type}`、together `reasoning:{enabled}`）、**嵌套型**（openrouter/ant-ling `reasoning:{effort}`）、**字符串型**（string-thinking `thinking:"..."`）方言全部缺失。
- **off 语义缺失**：pi-ai 对 deepseek 方言 off → 显式 `thinking:{type:"disabled"}`（openai-completions.js:590-592）；Conex off → 省略所有参数（`normalize_reasoning_effort` 收 off→None，vendor_wire.rs:14），不发显式 disabled。这与 DSH llm-deepseek 的 `off → thinking.type:"disabled"`（README.md:44）不符。
- **方言分派方式是静态的**：Conex 由 `ReasoningVendor`（vendor.rs:41-52）+ `ReasoningFormat` 组合决定，无 pi-ai `detectCompat` 那种按 URL/provider → 宽 compat 面的运行时探测（G5 另案）。本维度聚焦 wire 方言覆盖矩阵。

### 修复建议（wire 方言，非基线编号内，G7/G5 关联）

> 提示：wire 方言集合本质是「vendor 能力表的一部分」，建议与 vendor_capability.rs 整合。

1. **新增 qwen/zai/openrouter/ant-ling/together 方言**：扩展 `ReasoningFormat`（vendor.rs:144-156）+ `ReasoningVendor`（vendor.rs:41-52）或在 `ThinkingCapability.format` 上增加变体。qwen 用 `enable_thinking` 布尔，zai 用 `thinking:{type:"enabled"}` + `reasoning_effort`，openrouter 用嵌套 `reasoning:{effort}`。
2. **补 off 显式 disabled 语义**：对 deepseek 方言，在 `reasoning_effort_object`（vendor.rs:227-293）增加 off → `thinking:{type:"disabled"}` 分支（对齐 pi-ai openai-completions.js:590-592 和 DSH README.md:44）。验收：DSH/deepseek 模型选 off → 请求体含 `thinking.type:"disabled"` 且无 `reasoning_effort`。
3. **验收断言**：对每种新方言各加一个请求体字节断言（qwen off=true 发 `enable_thinking`；zai 发 `thinking:{type}`；openrouter 发 `reasoning:{effort}`），对齐 pi-ai openai-completions.js 对应分支。

---

## 四、归一化与降级 vs 拒绝：语义差异

### 对比表

| 项                           | Conex                                                                                                                           | pi-ai `clampThinkingLevel` / DSH                                                                                                                                            | 差距                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 不支持的档位                 | 降级：`normalize_thinking_intensity`（vendor.rs:319-346）——xhigh→high、minimal→low、其余取最大支持档位；不支持模型→None（不发） | pi-ai `clampThinkingLevel`（models.js:404-422）——先向高找支持档、再向低找，找不到回退首个支持档                                                                             | 都降级，但**回退方向不同**：Conex xhigh→high（向低），pi-ai 从请求档向高找（如请求 xhigh 但无 → 向 high 找）。语义差异见下 |
| off 语义                     | off → None（省略所有 reasoning 参数），`normalize_reasoning_effort` vendor_wire.rs:14                                           | DSH：「off 翻译为*省略* reasoning 选项」（README.zh.md:115）；pi-ai deepseek off → `thinking.type:"disabled"`（openai-completions.js:590-592）                              | 省略式一致（DSH），但 deepseek `thinking.type:"disabled"` 显式化缺失（见维度三）                                           |
| 不支持的档位是否请求前拒绝   | **无拒绝面**。全仓无 `UNSUPPORTED_REASONING_EFFORT` / `resolveReasoningLevel` 之类拒绝路径（grep 无命中），只有降级函数         | DSH：**请求前拒绝**——不在确切模型能力中的档位让请求在网络 I/O 前以 `UNSUPPORTED_REASONING_EFFORT` 失败，绝不自动调整（README.zh.md:115）；llm-deepseek 同款（README.md:44） | **G8 语义差异**：Conex 纯降级式（静默改档位），DSH 拒绝式（显式报错）                                                      |
| 描述（resolveModel）是否抛错 | （不适用：Conex 描述能力走 catalog/系列级，无同步失败路径）                                                                     | DSH：`resolveModel` 描述能力**从不抛错**，模型拿不下的 profile 档位报告「没有默认值」（README.zh.md:115）；坏配置暴露在执行（请求）处而非描述处                             | **G8 关键语义**：请求路径拒绝，描述路径隐藏。Conex 无此分离                                                                |

### 差距结论

- **Conex 是纯降级式**：任何不支持的档位都被静默归一化到最近档（vendor.rs:319-346），**没有「请求前拒绝」的拦截面**。
- **DSH 是拒绝式（针对明确档位请求）**：`UNSUPPORTED_REASONING_EFFORT` 在 I/O 前失败（README.zh.md:115 / README.md:44）。用户明确选择 `xhigh` 而模型只支持到 `high`——DSH 报错，Conex 静默降级。
- **语义取舍**：降级式无损但静默（用户以为是 xhigh，实际发 high）；拒绝式显式但用户必须改档。真实场景两者各有价值：**明确档位应拒绝**（防隐私降级），**默认/未指定档位可降级**。Conex 缺失的是「区分显式档位与默认档位」的语义。
- **回退方向差异**：pi-ai `clampThinkingLevel` 向高找（models.js:411-420），Conex xhigh→high 固定向低（vendor.rs:328-341）。对 xhigh 请求，两者最终都到 high，但 pi-ai 的「先向高再向低」在遇到「high 不存在但 max 存在」时（如自适应模型无 minimal）结果不同——Conex 的 `capability.levels.last()`（vendor.rs:342）取最大档。可接受但需确认对齐。

### 修复建议（G8）

> G8 依赖 G1（接线面语义），此处给逻辑改造点与验收断言。

1. **新增「显式档位请求」拒绝入口**：在请求构建面入口（`reasoning_effort_object` vendor.rs:227 之前，或 normalize 之前）增加 `resolve_reasoning_level`：若调用方显式传入档位且不在模型能力/模型级白名单内 → 返回错误（新增代码，与 DSH `UNSUPPORTED_REASONING_EFFORT` 对齐），且**发生在网络 I/O 之前**。
2. **保留降级通道仅用于默认档位**：`normalize_thinking_intensity`（vendor.rs:319-346）收敛为「仅默认/未指定档位可用」，显式档位走拒绝路径。这样默认档位仍可降级（无损），显式档位不可（防隐私）。
3. **能力描述不抛错**：确认 catalog/模型描述路径（resolveModel 对应面）在模型不支持某档位时不抛错，只报告「无默认值」，坏配置在执行处抛（README.zh.md:115 语义）。
4. **验收断言**：
   - 显式请求 deepseek 模型 `max`（官方支持）→ 通过；显式请求 `minimal`（官方不支持，thinkingLevelMap minimal:null）→ 请求前失败（错误码含 `UNSUPPORTED_REASONING_EFFORT` 语义），**无网络请求发出（单测 mock http 断言零调用）**。
   - 默认档位选模型不支持的档 → 正常降级（现有 vendor_tests.rs 218-224 断言保留）。
   - 描述路径（列出模型能力）永不抛错（mock resolveModel 对坏配置返回能力缺省而非异常）。

---

## 五、Anthropic 思考形态对比

### 对比表

| 项                | Conex                                                                                                                                                                                                                            | pi-ai / opencode                                                                                                                                                                                                                       | 差距结论                                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| adaptive 形态     | `thinking{type:"adaptive",display:"summarized"}` + 顶层 `effort`（vendor.rs:248-256、374-382；`resolve_thinking_params` ThinkingAdaptive 分支）；display 强制 summarized（vendor.rs:251 注释对齐 opencode transform.ts:791-794） | pi-ai anthropic-messages：`params.thinking={type:"adaptive",display}`（anthropic-messages.js:755-760），display 由 `options.thinkingDisplay ?? "summarized"`；opencode 强制 `display:"summarized"`（transform.ts:794, 952-955）        | **Conex 已领先/对齐**：display:summarized 强制语义与 opencode 完全一致；pi-ai 默认 summarized                                                                                                                         |
| adaptive 档位集   | `LEVELS_ADAPTIVE=[low,medium,high,xhigh,max]`（vendor_capability.rs:33-39），无 minimal                                                                                                                                          | opencode `anthropicAdaptiveEfforts`；pi-ai `mapThinkingLevelToEffort` minimal/low→"low"（anthropic-messages.js:598-600）                                                                                                               | 一致：adaptive 档位集无 minimal，minimal 请求降级 low（Conex vendor.rs:334-340、adaptive_effort_wire vendor_wire.rs:82-87）                                                                                           |
| xhigh/max 支持    | adaptive 模型 xhigh/max 直发（vendor.rs:248-256；vendor_wire.rs:79-81）                                                                                                                                                          | pi-ai 注释：max 所有 adaptive 模型可用，xhigh 仅 Opus 4.7+/Sonnet 5/Fable 5（anthropic-messages.js:590-591）                                                                                                                           | **Conex 需要细粒度**：Conex 把所有 adaptive 模型（含 claude-4-7/4-8 兼容、fable/mythos）统一 LEVELS_ADAPTIVE 含 xhigh，而 pi-ai 对部分模型 xhigh:null 隐藏（如 github-copilot claude-opus-4.6 仅 max，opencode.json） |
| anthropic-beta 头 | `reasoning_effort_headers`（vendor.rs:298-314）：vendor=anthropic 且 effort 非 off/auto → 恒发 `interleaved-thinking-2025-05-14`，**adaptive 模型也发**                                                                          | pi-ai `INTERLEAVED_THINKING_BETA="interleaved-thinking-2025-05-14"`（anthropic-messages.js:111）；**adaptive 模型跳过 beta 头**（`model.compat?.forceAdaptiveThinking !== true` 才 `needsInterleavedBeta`，anthropic-messages.js:641） | **Conex 过度发送**：对 adaptive 模型仍发 interleaved-thinking beta 头，pi-ai 对 forceAdaptiveThinking 模型明确跳过（interleaved built-in）；opencode 同家族也有 SAP/cap 判定。存在被上游忽略或误解析风险              |
| DSH 直连          | （不适用：Conex 有 anthropic vendor）                                                                                                                                                                                            | DSH **无 anthropic 直连**——战役目标里 anthropic 走 pi-ai 多供应商（llm-pi-ai）而非 DSH 官方（README.zh.md 覆盖 anthropic-messages 协议经 catalog 抵达）                                                                                | Conex 已覆盖 DSH 未直连的协议                                                                                                                                                                                         |

### 差距结论

- **已覆盖（领先）**：`display:"summarized"` 强制 + adaptive 档位集 + xhigh/max 直发，与 opencode transform.ts:791-794 / anthropic-messages.js:755-760 语义对齐，且有测试钉死（vendor_tests.rs:336-381 adaptive_effort_object/adaptive_thinking_params）。
- **遗漏 1（xhigh 细粒度）**：pi-ai 对部分 adaptive 模型隐藏 xhigh（仅 Opus 4.7+ 等真支持），Conex 对所有 adaptive 统一暴露 xhigh。若某新代际模型（如 claude-opus-4-8 某些形态）实际不支持 xhigh，Conex 会发出被忽略的 effort。
- **遗漏 2（anthropic-beta 头过度发送）**：`reasoning_effort_headers`（vendor.rs:298-314）对 adaptive 模型也发 interleaved-thinking beta 头，pi-ai 对 forceAdaptiveThinking 模型跳过（anthropic-messages.js:641）。这属于 wire 层副作用，应随 adaptive 判定一并收敛。
- **遗漏 3（无 DSH 参考）**：DSH 无 anthropic 直连，anthropic 走 pi-ai。因此 Conex 的 anthropic 实现是**唯一参考源**，应以 pi-ai/opencode 为基准（opencode 是本战役首选参考，transform.ts 有最全的 anthropic 家族分派）。

### 修复建议（anthropic/beta，非基线编号，可并入 G6 wire 层）

1. **anthropic-beta 头随 adaptive 判定跳过**：`reasoning_effort_headers`（vendor.rs:298-314）增加「adaptive 模型不返头」分支（对齐 pi-ai anthropic-messages.js:641）。验收：`is_adaptive_thinking_model` 为真的模型 + effort=high → headers 返回 None（不再发 interleaved-thinking beta）；旧代际 + effort=high → 仍返头。
2. **xhigh 档位按模型细粒度核验**：把 adaptive 模型的 xhigh 支持从「统一 LEVELS_ADAPTIVE」改为「按模型判定」（区分 Opus 4.7/4.8 等），对齐 pi-ai anthropic-messages.js:590-591 注释。验收：claude-sonnet-5 选 xhigh → 若模型级 marked 不支持 → 走维度四拒绝/降级；Opus 4.7 选 xhigh → 直发。
   - 注：此项依赖 G2 模型级档位白名单消费（见维度二修复），xhigh 细粒度本质是模型级能力描述。

---

## 六、思考回传（reasoning_content）对比

### 对比表

| 项              | Conex                                                                                                                                                                       | pi-ai / DSH                                                                                                                                                                                         | 差距结论                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 回传模式枚举    | `ReasoningContentMode`（messages.rs:44-54）：Omit / Include / Require，Require 无思考也回传空串（键存在性，P1 C3）                                                          | pi-ai `requiresReasoningContentOnAssistantMessages` compat 布尔（openai-completions.js:1155，detectCompat deepseek 为 true）；DSH serialize.ts:99                                                   | **Conex 枚举更细**，且 Require 空串兜底对齐 Reasonix 先例                                                                                          |
| DeepSeek 必带键 | engine 对 DeepSeek 恒 `Require`（deepseek_invariants.rs:9-12 C1 唯一接线）；不变量 2 测试钉死「tool_calls 回合必带 reasoning_content 键」（deepseek_invariants.rs:221-305） | pi-ai detectCompat deepseek → `requiresReasoningContentOnAssistantMessages:true`（openai-completions.js:1155）；DSH 官方 passback 规则 reasoning_content 必返 tool-call 回合（serialize.ts:96-100） | **Conex 已领先**：有独立不变量测试文件钉死请求体级行为，超出 pi-ai 的 compat 布尔                                                                  |
| 思考内容拼接    | `reasoning_content_object`（messages.rs:174-193）+ `to_value` 序列化（messages.rs:153-155）                                                                                 | pi-ai openai-completions.js:868-875：从非空 thinking blocks 取 signature `reasoning_content`/`reasoning`，`blocks.map(join)`；DSH serialize.ts:73-76 `flatten / map(text).join`                     | 一致：Conex 用 `thought_content` + 单字符串序列化（MessagesMessage 单 reasoning_content 字段）                                                     |
| 无思考空串      | `ReasoningContentMode::Require` 空串也发（messages.rs:187-191；deepseek_invariants:235-237 断言 `reasoning_content` 存在且为空串）                                          | DSH serialize.ts:99 `toolCalls>0 && reasoning>0 ? {reasoning_content} : {}`（空思考则整个键省略）                                                                                                   | **语义不同**：Conex Require 连空串也发键（防 DeepSeek 400 键缺省）；DSH 空思考直接省略键（不依赖空串）。Conex 语义更保守（对齐 Reasonix 400 先例） |
| Responses 轨    | `to_responses_input_items` assistant → reasoning item 仅非空才发（messages.rs:358-365、384-387）                                                                            | pi-ai 无涉（openai-responses 另协议）；DSH 无 Responses                                                                                                                                             | Conex 对 chat/completions 与 responses 两轨的思考回传差异显式处理                                                                                  |

### 差距结论

- **已覆盖（领先）**：Conex 的 `ReasoningContentMode::Require` + 空串兜底 + 请求体级不变量测试（deepseek_invariants.rs:221-305）是六维中最成熟的一项，语义比 pi-ai 的 compat 布尔 / DSH 的空思考省略键都更保守稳健。
- **语义差异需文档化**：Conex Require 连空串也发键（deepseek_invariants.rs:235-237），DSH 空思考省略键（serialize.ts:99）。两者对付 DeepSeek 400 有一致目标（键存在性），但 Conex 用空串保键，DSH 依赖思考非空才发。Conex 方案与 Reasonix openai.go:669-680 先例一致，可保留。
- **Conex 的非对称性是有意分歧**：responses 轨非空才发（messages.rs:358-365「与 chat 轨 Require 空串键存在性有意分歧」），注释明确。

### 修复建议（回传，无需改造，仅验收/文档化）

1. **无需逻辑改造**：当前实现成熟且测试钉死。建议在主方案中明确「Conex 用空串保键 vs DSH 用省略」的取舍理由（Reasonix 400 先例），作为后续维护不变量。
2. **验收断言（保留 + 补二轨一致性）**：现有 deepseek_invariants.rs:221-305 已钉死 chat 轨；建议补一条 Responses 轨下带 tool_calls 的 assistant 是否也应保证非空思考的断言（当前 `to_responses_input_items` 非空才发 rationale 已注明）。

---

## 七、汇总：三类结论标注

### 已覆盖项（Conex 领先/完整）

- **档位枚举与全序**（维度一）：7 厂商 × 8/7 档，与 pi-ai 全集一致。
- **Anthropic adaptive 形态**（维度五，除 xhigh 细粒度与 beta 头）：display:summarized 强制 + adaptive 档位集 + 测试，对齐 opencode。
- **思考回传不变量**（维度六）：Require 空串兜底 + 请求体级测试，六维中最成熟。

### 缺失项

- **模型级档位消费端**（维度二，G2）：`reasoning_effort_tiers` 只有定义与测试。
- **wire 改名**（维度二/三，G6）：档位→wire 拼写改名缺失（GLM-5.2 low→high、cerebras off→"none"、openrouter 嵌套）。
- **开关型/嵌套型 wire 方言**（维度三）：qwen enable_thinking、zai thinking:{type}、openrouter/ant-ling reasoning:{effort}、together、string-thinking 全缺。
- **off 显式 disabled**（维度三）：deepseek off 应发 `thinking.type:"disabled"`（pi-ai openai-completions.js:590-592），Conex 仅省略。
- **anthropic-beta 过度发送**（维度五）：adaptive 模型仍返头，应跳过。

### 语义差异项

- **降级 vs 拒绝**（维度四，G8）：Conex 纯降级式，无 `UNSUPPORTED_REASONING_EFFORT` 请求前拒绝面；DSH 明确档位拒绝、描述隐藏。
- **归一化回退方向**（维度四）：Conex xhigh→high 向低（vendor.rs:328-341），pi-ai clampThinkingLevel 先向高找（models.js:411-420）。
- **空串保键 vs 省略键**（维度六）：Conex Require 空串发键（deepseek_invariants.rs:235-237），DSH 空思考省略键（serialize.ts:99）——两者目标一致、实现不同，Conex 保留。

---

## 八、基线问题编号映射

| 问题编号 | 标题                             | 本维度对应证据与修复落点                                                                                                                    |
| -------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| G2       | 模型级思考档位白名单无消费端     | 维度二：`reasoning_effort_tiers`（catalog.rs:141）无消费；修复=扩展为映射载体 + 接入 `reasoning_effort_object`/`normalize_reasoning_effort` |
| G6       | wire 改名语义缺失                | 维度二/三：无档位→wire 拼写改名；修复=模型级映射承载 wire 拼写（依赖 G2 载体），并覆盖 qwen/zai/openrouter 等方言                           |
| G8       | 能力描述与请求校验分离语义待核查 | 维度四：Conex 纯降级无拒绝面；修复=新增显式档位 `resolve_reasoning_level` 拒绝 + 描述路径不抛错，依赖 G1 接线面语义                         |

---

## 九、文件证据索引（供复核）

Conex 内部：

- `crates/agent-provider/src/request/vendor.rs`：档位枚举 41-140、ReasoningFormat 144-156、infer_reasoning_vendor 180-213、reasoning_effort_object 227-293、anthropic-beta 298-314、normalize_thinking_intensity 319-346、resolve_thinking_params 351-390
- `crates/agent-provider/src/request/vendor_capability.rs`：档位集 12-39、能力表 106-156、infer_thinking_capability 159-170
- `crates/agent-provider/src/request/vendor_wire.rs`：normalize_reasoning_effort 12-18、effort_to_budget_tokens 21-33、thinking_to_gemini_thinking_level 61-69、is_adaptive_thinking_model 75-77、adaptive_effort_wire 82-87
- `crates/agent-provider/src/request/messages.rs`：ReasoningContentMode 44-54、reasoning_content_object 174-193、to_chat_messages 207-308、to_responses_input_items 329-431
- `crates/agent-provider/src/request/deepseek_invariants.rs`：C1 Require 接线 9-12、不变量 2 测试 221-305
- `crates/agent-provider/src/models/catalog.rs`：reasoning_effort_tiers:141、supports_reasoning_effort:139
- `crates/agent-provider/src/models/catalog_tests.rs`：586（解析断言，非消费）
- `crates/agent-provider/src/request/vendor_tests.rs`：anthropic-beta 165-184、adaptive 301-404

外部参考：

- pi-ai `dist/models.js`：EXTENDED_THINKING_LEVELS 391、getSupportedThinkingLevels 392-403、clampThinkingLevel 404-422
- pi-ai `dist/api/openai-completions.js`：thinkingFormat 方言 560-641、requiresReasoningContentOnAssistantMessages 1155、detectCompat 1146-1160
- pi-ai `dist/api/anthropic-messages.js`：INTERLEAVED_THINKING_BETA 111、mapThinkingLevelToEffort 589-608、adaptive 跳过 beta 头 641、thinking 构造 753-785
- pi-ai provider 数据：deepseek.json / opencode-go.json（v4-flash 白名单）、zai-coding-cn.json（glm-5.2 改名）、cerebras.json（off:"none"）
- DSH `reference/deepseek-harness/packages/llm/llm-deepseek/`：adapter.ts 三档 98-105（+REASONING_EFFORTS/OFF_ONLY）、README.md:44（off→thinking.type:disabled、UNSUPPORTED）
- DSH `reference/deepseek-harness/packages/llm/llm-deepseek/src/serialize.ts`：99（空思考省略键）
- DSH `reference/deepseek-harness/packages/llm/llm-pi-ai/README.zh.md`：档位/改名 84-90、UNSUPPORTED/resolveModel 语义 113-115
- opencode `reference/opencode/packages/opencode/src/provider/transform.ts`：adaptive+display 强制 784-796、938-955
