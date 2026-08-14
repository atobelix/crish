# 03 · 模型目录与配置/凭据层对比

> 战役：Conex 多模型适配战役（参考外部模式）
> 对比基线：Conex 现状 vs pi-ai（`@earendil-works/pi-ai`，DeepSeek Harness 选用的多供应商引擎）vs DeepSeek Harness（`llm-deepseek` / `llm-pi-ai` 适配器做法）
> 本文件只读内部源码 + 外部参考，不修改任何产品代码。
> 基线问题编号参照：**G3 = 单提供方配置层无多供应商注册**。

---

## 0. 摘要

Conex 的**模型目录数据模型**（`ModelCatalogEntry` 59 字段 v2 schema）在单一供应商视角下设得非常深——缓存语义、分档定价、峰谷、TTL、双层覆盖白名单均远超 pi-ai 的简单 `cost` 字段；**但供应商横向宽度是当前最大短板**：配置层（`ProviderConfigStore`）与凭据层都是单提供方、单文件、单默认凭据，环境变量也只有一个 `CRISH_*` 命名空间。这正好命中基线问题 **G3**。pi-ai / DSH 的做法是「35+ 内置提供方注册表 + 每方独立凭据引用 + 每方独立 env 名 + 运行时 profile 覆盖」，从目录、注册、凭据到 env 全链路都是按供应商分通道的。

好消息是：Conex 的 catalog 数据模型**已经按 provider 分通道**（`catalog.rs:211-213` 键 = `vendor::model`，多通道同模型按 provider 区分），这使 G3 改造获得了「数据模型层已就绪、配置/凭据/注册层需多供应商化」的有利起点。下文逐维展开。

---

## 1. 目录数据模型：Conex 59 字段 vs pi-ai 模型条目

### 1.1 pi-ai 模型条目字段（实测 opencode-go.json / deepseek.json）

pi-ai 的模型条目是扁平 JSON，层叠结构（`data/<provider>.json` → `*.models.js` `flattenModelCatalog` → `MODELS` 内置表）：

- `data/opencode-go.json:1` 与 `data/deepseek.json:1` 实例字段集合：`id` / `name` / `api` / `provider` / `baseUrl` / `reasoning` / `input` / `cost`（`{input, output, cacheRead, cacheWrite}`）/ `contextWindow` / `maxTokens` / `thinkingLevelMap` / `compat` /（`api-model` 缺省即 `id`）。
- `compat` 子对象（`opencode-go.json:1` DeepSeek 条目）：`supportsStore` / `supportsDeveloperRole` / `maxTokensField` / `requiresReasoningContentOnAssistantMessages` / `thinkingFormat`。
- `thinkingLevelMap`：`{minimal,low,medium,high,max}` → wire 拼写。
- 各字段语义与消费方：见 `models.js`（`calculateCost`:371-390、`getSupportedThinkingLevels`:391-403、`clampThinkingLevel`:404-422）。

标注：pi-ai 的 `cost` 中**没有**独立缓存写入 TTL 分档，`calculateCost`（models.js:371-390 ）用硬编码「Anthropic 1h 写价 = 输入价 2x」推导（models.js:381-382），没有模型级 5m/1h 写价分档；`reasoning` 只是一布尔位，档位集靠 `thinkingLevelMap` 表达；无货币/单位、无峰谷、无分档 tier、无溯源/生命周期、无能力位族（vision/function calling/audio/pdf…都靠 `input` 模态 + `compat` 散点表达）。

### 1.2 Conex `ModelCatalogEntry` 59 字段分组（`catalog.rs:47-172`）

| 组             | 字段                                                                                                                                                                                                                                            | 行号               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| A 标识         | id/model/api_model/provider/vendor/mode/currency/unit                                                                                                                                                                                           | catalog.rs:49-64   |
| B 窗口         | context_window / max_output_tokens                                                                                                                                                                                                              | catalog.rs:68-70   |
| C 四指标价格   | input/output/cache_read/cache_write/cache_write_5m/cache_write_1h/cache_write_free                                                                                                                                                              | catalog.rs:74-86   |
| D 扩展价格     | storage_price_per_1m_hour/storage_price_free_until/reasoning_price/price_status/derivation/peak_pricing_2x/peak_pricing_schedule/tiered_pricing                                                                                                 | catalog.rs:90-105  |
| E 缓存语义     | prompt_cache_min_tokens/cache_type/cache_mechanism/supports_prompt_caching/supports_implicit_caching/supports_prompt_cache_key/supports_cache_control/breakpoint_max/lookback_blocks/cache_ttl/cache_ttl_options                                | catalog.rs:110-132 |
| F 能力位       | supports_responses/reasoning/reasoning_effort/reasoning_effort_tiers/vision/function_calling/parallel_function_calling/system_messages/response_schema/tool_choice/web_search/audio_input/audio_output/pdf_input/assistant_prefill/computer_use | catalog.rs:136-153 |
| G 溯源生命周期 | source_url/data_verified_at/data_source/notes/promo_expires_at/promo_replaces_at/retired/deprecation_date                                                                                                                                       | catalog.rs:157-171 |

### 1.3 逐字段/逐域对照表

| 维度               | Conex 现状（证据）                                                                                                                                                                  | pi-ai / DSH 做法（证据）                                                                                                                                                  | 差距结论                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 标识               | `provider` + `vendor` 拆分（`catalog.rs:56-58`）                                                                                                                                    | `provider` 单键；`api` 传协议，`baseUrl` 每股点（`data/opencode-go.json:1`）                                                                                              | Conex 的 provider/vendor 双键在转售/网关场景更强（通道价 vs 官方直连价分离）；pi-ai 用「每提供方一个 baseUrl」表达，**无 vendor 概念**。Conex 已超越。            |
| 窗口/输出          | 显式 `contextWindow` + `maxOutputTokens`（`catalog.rs:68-70`），且 `max_output_for`/`context_window_for` 便捷查询（`catalog.rs:255-262`）                                           | 同名 `contextWindow`/`maxTokens`（`opencode-go.json:1`）                                                                                                                  | 字段等价。                                                                                                                                                        |
| **四指标价格**     | 7 字段：input/output/cacheRead/cacheWrite/cacheWrite5m/cacheWrite1h/cacheWriteFree（`catalog.rs:74-86`）                                                                            | `cost` 4 字段：input/output/cacheRead/cacheWrite（`opencode-go.json:1`）；1h 写价用硬编码 2x 推导（`models.js:381-382`）                                                  | **Conex 超越**：5m/1h 双档写价 + 写免费显式位，Anthropic 双档落在模型字段；pi-ai 只能推导、无法模型级表达。                                                       |
| **缓存语义**       | 11 字段：minTokens/cache_type/mechanism/supportsPromptCaching/…/breakpointMax/lookbackBlocks/cacheTtl/cacheTtlOptions（`catalog.rs:110-132`）                                       | pi-ai 无显式缓存语义字段；缓存读写价仅在 `cost` 内（`opencode-go.json:1`）                                                                                                | **Conex 大幅超越**：pi-ai 不建模缓存机制/TTL/断点/回溯窗口。                                                                                                      |
| **分档定价**       | `tieredPricing`（`TieredPriceTier`，`catalog_price.rs:16-35`；半开区间 `[min,max)`，无上界档），`input_price_for_tokens` 等四价变体（`catalog.rs:363-431`），catalog.json 43 条档位 | `cost.tiers`（`models.js:371-375`）`inputTokensAbove`，仅挡输入价、其它价无档                                                                                             | Conex 超越：每档四价全量 + 无上界长上下文档；pi-ai 仅输入价分档。                                                                                                 |
| **峰谷定价**       | `peakPricing2x` + `PeakPricingSchedule`（`catalog_price.rs:51-62`），`peak_pricing_2x_for`（`catalog.rs:442-447`）                                                                  | 无                                                                                                                                                                        | **Conex 独有**（DeepSeek 峰谷需求）。                                                                                                                             |
| 能力位             | 16 显式布尔位（`catalog.rs:136-153`）                                                                                                                                               | 靠 `input` 模态 + `compat` 散点（`opencode-go.json:1`）                                                                                                                   | Conex 超越：pi-ai 无统一能力位模型，`reasoning` 只是布尔。                                                                                                        |
| 溯源/生命周期      | source_url/data_verified_at/data_source/notes/promo/retired/deprecation（`catalog.rs:157-171`）                                                                                     | pi-ai 目录无；无来源核实、无退役                                                                                                                                          | **Conex 独有**（数据质量溯源）。                                                                                                                                  |
| **reasoning 档位** | `supportsReasoningEffort` + `reasoningEffortTiers` 白名单（`catalog.rs:139-141`）                                                                                                   | `thinkingLevelMap` 全档位 wire 拼写 + `getSupportedThinkingLevels`（`models.js:391-403`；`opencode-go.json:1`）                                                           | **pi-ai 更细**：`thinkingLevelMap` 把 `off/minimal/low/medium/high/xhigh/max` 七档各自 map 到 wire；Conex 只有白名单 + 未知档默认。Conex 需补档位→wire 映射语义。 |
| 输入模态           | 无显式字段（vision 仅布尔位 `supportsVision`，`catalog.rs:142`）                                                                                                                    | `input: ["text","image"]` 列表（`opencode-go.json:1`）；DSH 消费 `inputModalities`（`adapter.ts:242-247`）                                                                | **pi-ai 更细**：模态是多值列表；Conex 用布尔位表达，无法表达「仅 text 但支持某功能」的细粒度。                                                                    |
| 协议描述           | `mode`（chat/responses/both）（`catalog.rs:60`）                                                                                                                                    | `api`（`openai-completions`/`anthropic-messages`/`openai-responses`）+ `compat` 协议开关（`opencode-go.json:1`）；DSH 用 `compat.thinkingFormat` 等（README.zh.md:88-90） | pi-ai 用 `api` 逐条目指定协议与 `compat` 协议细节；Conex 用 `mode` + `supportsResponses` 布尔。pi-ai 更精确（协议开关可配置），Conex 需补 `compat` 面。           |
| 复杂度             | 59 字段、全可缺省（`catalog.rs:46`）                                                                                                                                                | 15 上下字段                                                                                                                                                               | —                                                                                                                                                                 |

**逐字段盘点结论：**

- **Conex 有而 pi-ai 无**：5m/1h 双档写价、写免费位、存储费、峰谷、tiered 分档、完整缓存语义（TTL/断点/回调）、16 能力位、溯源/生命周期、promo、retired。影响：Conex 目录能支撑精确成本核算与缓存路由（上游 `request/cache.rs`、`ttl.rs` 消费），pi-ai 无法。
- **pi-ai 有而 Conex 无**：
  1. `thinkingLevelMap` 全档位 wire 映射（Conex 只有 `reasoningEffortTiers` 白名单，缺「档位→wire 拼写」）。
  2. `input` 模态多值列表（Conex 只有布尔能力位）。
  3. `compat` 协议细节（`supportsStore`/`maxTokensField`/`thinkingFormat`/`requiresReasoningContentOnAssistantMessages`）（Conex 无此面，DeepSeek 需要 `maxTokensField:"max_tokens"` 这类逐模型传输细节）。
  4. `baseUrl` 每条目端点（Conex 用 vendor/provider 从配置层取端点，条目内无端点）。

---

## 2. 目录查询与更新机制

### 2.1 对比表

| 维度            | Conex 现状（证据）                                                                                                                                                                                                   | pi-ai / DSH 做法（证据）                                                                                                                            | 差距结论                                                                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内置目录来源    | `include_str!("catalog.json")` 编译期打包，离线可用（`catalog.rs:224-227`）                                                                                                                                          | pi-ai `data/*.json` → `*.models.js` 生成内置表（`opencode-go.models.js:1-5`，`model-catalog.js` `flattenModelCatalog`），**随 npm 发版**            | Conex 内置表在 Rust 二进制内；pi-ai 在 npm 包里。均需发版更新。Conex 无「发版更新」机制，靠手工维护 catalog.json。                                                                                                    |
| 多级兜底查询    | 精确 `vendor::model` → 去版本后缀 → vendor 默认（`model="*"`）→ None（`catalog.rs:238-252`）                                                                                                                         | pi-ai 无多级兜底：`getModel` 精确匹配（`models.js:69-71`），无后缀剥离、无 vendor 通配默认                                                          | **Conex 超越**：版本后缀剥离（`strip_version_suffix`:452-458）+ vendor 默认条目。                                                                                                                                     |
| 网络/运行时刷新 | `upsert_from_scan` 合并前端 `/models` 扫描结果（窗口/输出/能力位，不覆盖价格，`catalog_override.rs:66-133`）                                                                                                         | pi-ai `refreshModels` 联网拉取并写 `modelsStore`（InMemory，`models.js:72-118,328-351`）；DSH：**catalog 不自我刷新**（README.zh.md:198）为已知限制 | 双方都有运行时模型发现；Conex 是「合并扫描」，pi-ai 是「整体替换 + 缓存恢复降级」。Conex 的合并语义更精细（价格保持真源）。                                                                                           |
| 覆盖白名单      | `OVERRIDE_WHITELIST` 窗口/价格族 + `OVERRIDE_BOOL_FIELDS` 能力位（`catalog_override.rs:244-278`），禁覆盖 model/provider/vendor 三键（`catalog_override.rs:143-147`），失败不阻塞仅记录（`catalog_override.rs:145`） | DSH `modelOverrides` 就地重塑单模型（README.zh.md:80）——同 id 逐字段继承，可写 contextWindow/maxTokens/reasoningEfforts/compat；模型未描述即拒绝    | 两者都是白名单语义；Conex 白名单**遍历键级**（键外字段整项拒绝，`catalog_override.rs:173-180`），DSH 是**字段级 schema 校验**。Conex 的「整项拒绝」更严格但缺乏 DSH 的「同一 list 整体替换 vs 就地 override」双模式。 |
| models 整体替换 | 无（仅 per-条目覆盖）                                                                                                                                                                                                | DSH `models` 列表**整体替换**该路由 catalog（README.zh.md:78）                                                                                      | **DSH 独有能力**：一条清单替换整目录，与 per-模型 override 并存。Conex 覆盖面只能逐条 upsert/覆盖，无法「整体替换」。                                                                                                 |
| 文件/版本管理   | `ModelCatalogFile` version/schema/updatedAt（`catalog.rs:185-194`），任何变更 version+1（`catalog.rs:216`, `catalog_override.rs:130,162`）                                                                           | pi-ai 无版本号；DSH 覆盖是 settings 文档，无 catalog 版本                                                                                           | **Conex 超越**：版本号驱动下游 memoize 失效（`catalog.rs:214,230-232`）。                                                                                                                                             |

**差距结论：** 目录数据层面 Conex 已相当成熟（版本化、多级兜底、白名单覆盖、扫描合并）。主要缺口在**更新通道**：pi-ai 靠 npm 发版 + `refreshModels` 联网拉取整体替换；Conex 靠手工维护 `catalog.json` 编译期打包，后台扫描合并**只能合前端扫描的三字段**，无法后台拉取远程价格源（models.dev / openrouter）——这使目录价格新鲜度依赖人工转录。DSH 的 `models` 整体替换 + `modelOverrides` 双模式 Conex 缺失。

---

## 3. 多供应商注册（G3 核心）

### 3.1 对比表

| 维度                 | Conex 现状（证据）                                                                           | pi-ai 做法                                                                                                                                  | DSH 做法                                                                                                                                                              | 差距结论                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 提供方注册           | 单 `ProviderConfig`：单 `provider_id`/`base_url`/`model`/`api_key_ref`（`config.rs:96-110`） | 35+ 内置提供方注册表：`builtinProviders()` 逐一构造（`all.js:65-106`），每方独立 id/name/auth/models/api（`providers/opencode-go.js:7-19`） | `llm-pi-ai` 多路由注册：`providerInfo`/`listModels`/`resolveModel` per-provider（`adapter.ts:227-274`）；`llm-deepseek` `registerAdapter([PROVIDER])`（index.ts:256） | **Conex 完全缺失**（G3）：`ProviderConfigStore` 只持有一份 `ProviderConfig`（`config.rs:181`），无法同时注册多供应商。          |
| 配置存储             | 单文件 `provider-config.json`（`config.rs:24,189`），`load` 只读一个文件                     | 无 config 文件，提供方定义即注册表                                                                                                          | profile 字典以 `providers.<provider>` 为键（README.zh.md:4-5），base + settings 按提供方分层合并（README.zh.md:107）                                                  | **G3**：Conex 需把 `provider-config.json` 单文件改为「多提供方映射」存储，或每提供方一文件。                                    |
| 仅一次提供方的语义   | 解析单主体 `resolve()` 返回 `ResolvedProviderConfig`（`config.rs:229-260`）                  | `createModels` + `setProvider` 注册全部（`models.js:31-33`; `all.js:108-114`）                                                              | snapshot 收集全部 provider 的 catalog/profile                                                                                                                         | **G3**：Conex 的 `resolve()` 只能出一个提供方最终态，无「按请求 provider 路由」概念。                                           |
| UI 提供方下拉        | —（前端有费率表但本层无 35+ 提供方清单）                                                     | pi-ai 自身无 UI                                                                                                                             | DSH 模型设置页下拉 35 个提供方（`apps/web/tests/snapshots/models-settings/empty.expected.md:24-60`）                                                                  | DSH 已把「提供方清单」暴露为 UI 一等公民；Conex 配置面是单一 openai-compatible 直觉。                                           |
| catalog 按通道分通道 | `ModelCatalog` 键 = `vendor::model`，同模型多通道按 provider 区分（`catalog.rs:211-213`）    | pi-ai 目录按 provider 分组（`MODELS[provider]`，`all.js`、`models.generated.js`）                                                           | DSH 每条路由一个 provider                                                                                                                                             | **Conex 数据层已就绪**：`ModelCatalogEntry.provider` 已是通道键，多供应商注册只需在「配置/凭据store」层补多份，目录层无需革命。 |

### 3.2 改造面评估（重点结论）

Conex 的目录数据模型**已经按 provider 分通道**（`catalog.rs:211-213` 键格式 vendor::model；同模型多通道可用），这是关键利好。但配置面到多供应商的改造面仍然较大，集中在**三个单例**：

1. **配置单例**：`ProviderConfig`（`config.rs:96-110`）与 `ProviderConfigStore`（`config.rs:177-182`）只有一份。需改为「provider_id → ProviderConfig`映射」（如`BTreeMap<String, ProviderConfig>`），`resolve()` 需按 provider 参数解析。
2. **凭据引用单例**：`api_key_ref: Option<String>`（`config.rs:105`）单引用；每 provider 需独立引用。
3. **env 覆盖单例**：`first_env_value` 组（`config.rs:30-37`）只覆盖单提供方，多供应商下无法区分。

改造建议（逻辑点）见 §8。目录层本身（§1/§2 的多级兜底、白名单覆盖、版本化）**无需为多供应商重写**，只需把「默认 vendor/默认 provider」的查找从单个放宽到按 provider 分派。

**G3 结论：** `docs/provider-adapter-campaign` 基线 G3（单提供方配置层无多供应商注册）在本维度的落点 = `config.rs:96-110`（单 ProviderConfig）+ `config.rs:177-182`（单 store）+ `credentials.rs` / `config.rs:30-37`（单凭据、单 env）。目录模型层不归 G3。

---

## 4. 凭据管理

### 4.1 对比表

| 维度              | Conex 现状（证据）                                                                                                                               | pi-ai 做法                                                                                                                                 | DSH 做法                                                                                                  | 差距结论                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 凭据落盘          | Windows DPAPI 加密 hex（`credentials.rs:7,140-156,319-414`）；Unix 明文 0600（`credentials.rs:8-9,308-313`）；其它内存降级（`credentials.rs:10`) | pi-ai 本身无凭据落盘：`envApiKeyAuth` 只读环境变量（`auth/helpers.js:7-26`），credential 存 `InMemoryCredentialStore`（`models-store.js`） | `ctx.credentials` 按引用解析（`index.ts:229-232`）；凭据不进入 Models 集合（README.zh.md:137）            | **Conex 落盘安全远超 pi-ai**（DPAPI/0600/memory-wipe）；pi-ai 纯 env。Conex 已超越 pi-ai 的落盘面。                                     |
| 内存清零          | `SecretString` Drop 时覆写清零（`credentials.rs:19-58`，`wipe` 用 volatile 写）                                                                  | 无（pi-ai API key 是普通字符串）                                                                                                           | 无显式清零（凭据由 seam 保管）                                                                            | **Conex 超越**：显式堆内存清零 + Debug 脱敏（`credentials.rs:47-52`）。                                                                 |
| 按请求解析级      | 解析/合并一次性产出 API key（`config.rs:229-260` `resolve`）                                                                                     | `applyAuth`/`resolveRefreshCredential` 每次请求经 `apiKey.resolve` 解析（`models.js:119-143,242-262`）                                     | **每次请求** `resolveApiKey` 依据调用方 snapshot 的 `connection.apiKeyEnv` 解析（`index.ts:225-246`）     | **pi-ai/DSH 更细**：凭据按请求惰性解析；Conex 在 `resolve()` 一次性解析，不区分「每 provider、每请求」。                                |
| 缺凭据语义        | API key 缺失 → `ApiKeySource::Unset`（`config.rs:149,246`），上层自行处理                                                                        | pi-ai `applyAuth` 抛 `Provider is not configured`（`models.js:249`）                                                                       | `MISSING_CREDENTIAL` 显式错误（`index.ts:241-246`; README.zh.md:11）                                      | **DSH 更清晰**：显式 `MISSING_CREDENTIAL` code；Conex 只有 source 枚举，无类型化错误面。                                                |
| 多提供方独立凭据  | 单 `api_key_ref`（`config.rs:104,263-278` `secrets/{ref}.dpapi`），每 provider 无独立引用                                                        | 每 provider 独立 `envApiKeyAuth` env 名（`providers/opencode-go.js:11`），credential store 按 providerId 键控（`models-store.js:3-12`）    | profile 层级：每条路由 `apiKeyEnv` 引用（README.zh.md:11），一条凭据服务该路由全部模型（README.zh.md:11） | **G3 关键差距**：Conex 凭据存储技术（DPAPI/0600）很稳，但**引用键是单例**——多供应商下无法表达「openai 用 A 密钥、deepseek 用 B 密钥」。 |
| 凭据引用 sanitize | `sanitize_secret_ref` 仅 ASCII 字母数字/`-_`、长度≤128（`config.rs:311-331`），防路径穿越                                                        | pi-ai 无（env 名即为引用）                                                                                                                 | `credentialRef`（`index.ts`，`role('credential-ref')` schemastery）                                       | Conex 已有引用校验（防路径穿越），与 DSH schema 校验等价。                                                                              |

### 4.2 差距结论

Conex 的**凭据存储技术**（DPAPI/Unix 0600/内存降级/SecretString 清零/引用 sanitize）在安全面上已经超越 pi-ai（纯 env）；关键的且与多供应商相关的差距是**「单默认凭据」**——`ProviderConfig::api_key_ref: Option<String>` 单引用（`config.rs:105`），`secret_path_for` 只有一个引用（`config.rs:263-278`）+ 无引用时 `default.dpapi`（`config.rs:276`）。这与 pi-ai（per-provider credential store，`models-store.js:3-12`）和 DSH（per-route `apiKeyEnv`）的多凭据模式差距显著。改造需把 `api_key_ref` 从「单提供方配置字段」提升为「按 provider 路由的凭据平面」。

---

## 5. 环境变量约定

### 5.1 对比表

| 维度            | Conex 现状（证据）                                                                                                | pi-ai 做法                                                                                                                                                                                                                        | DSH 做法                                                                                                                               | 差距结论                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 单方 env 命名   | `CRISH_API_KEY`/`CRISH_API_BASE_URL`/`CRISH_MODEL`/`CRISH_ENDPOINT`（`config.rs:30-37`），兼容 FLOWBIT__/OPENAI__ | 每提供方独立 env 名映射表：`env-api-keys.js:63-110`（`opencode-go` → `OPENCODE_API_KEY`、`deepseek` → `DEEPSEEK_API_KEY`、`minimax` → `MINIMAX_API_KEY`…共 ~34 键）；`envApiKeyAuth` 按 env 名清单读取（`auth/helpers.js:18-23`） | `DEEPSEEK_API_KEY` + `DEEPSEEK_BASE_URL`（仅可信环境层，`index.ts:45,107,186`；README.zh.md）/ pip-ai profile `apiKeyEnv` 引用任意 env | **G3 关键差距**：Conex 只有一个固定 `CRISH_*` 命名空间，无法为多供应商各自命名 env；pi-ai 有完整的 per-provider env 映射表。 |
| env 信任层      | env 覆盖优先于持久化（`config.rs:8-9,226-228`，`ApiKeySource::Env`）                                              | env 即唯一来源                                                                                                                                                                                                                    | `DEEPSEEK_BASE_URL` 仅从**可信环境层**（launchEnvironmentOf）读取（`index.ts:186,236`）                                                | **DSH 更安全**：区分可信/不可信 env 层；Conex 的 `env::var`（config.rs:306）读取进程全环境，无信任分层。                     |
| provider 前缀化 | 无（固定前缀）                                                                                                    | `envMap` 每 provider 键（`env-api-keys.js:72-107`）                                                                                                                                                                               | `apiKeyEnv` 让用户自由指定 env 名（README.zh.md:11）                                                                                   | pi-ai/DSH 都支持 provider 前缀 env；Conex 需扩展。                                                                           |

**差距结论：** 多提供方下 Conex env 命名空间是**单点**（`CRISH_*`），无法表达「per-provider env」。`first_env_value`（`config.rs:303-308`）按名清单线性扫描、无 provider 维度。pi-ai 的 `env-api-keys.js` 提供**每提供方独立 env 名**的现成映射（可直接复制为参考模型）；DSH 更进一步让 `apiKeyEnv` 成为**用户方自由度**的引用，不绑定固定 env 名。

---

## 6. 汇总：Conex 已超越 vs 待补（一页结论）

### 6.1 Conex 已超越 pi-ai/DSH 项（改造不应回退）

1. **目录字段密度**：59 字段 vs pi-ai ~15 字段（§1.3）——尤其缓存语义（TTL/断点/回溯/机制）、分档定价、峰谷、写价 5m/1h 双档。
2. **目录版本化**：`ModelCatalogFile` version + 变更 version+1（`catalog.rs:185-216`）驱动 memoize 失效。
3. **多级兜底查询 + vendor 默认**：`lookup` 精确→去版本后缀→vendor 默认（`catalog.rs:238-252`，`strip_version_suffix`）。
4. **覆盖白名单**：键级白名单 + 禁改身份三键 + 失败不阻塞（`catalog_override.rs:143-180,244-278`）。
5. **凭据落盘安全**：DPAPI / Unix 0600 / 内存降级 / `SecretString::wipe` 清零 / Debug 脱敏（`credentials.rs`）。
6. **扫描合并细粒度**：只合三字段、价格保持真源（`catalog_override.rs:66-133`）。

### 6.2 待补差距（对应修复建议）

| #      | 差距                                                                            | 对应 §       |
| ------ | ------------------------------------------------------------------------------- | ------------ |
| D1     | `thinkingLevelMap` 全档位→wire 映射（Conex 只有 `reasoningEffortTiers` 白名单） | §7.1         |
| D2     | `input` 模态多值列表（Conex 只有布尔能力位）                                    | §7.1         |
| D3     | `compat` 协议细节（thinkingFormat/maxTokensField/supportsStore…）               | §7.1         |
| D4     | models 列表「整体替换」双模式（DSH）                                            | §7.5         |
| D5     | 网络化价格刷新（Conex 目前只能手工转录 catalog.json）                           | §7.6         |
| **G3** | 单提供方配置层无多供应商注册（配置/凭据/env 单例）                              | §7.2/7.3/7.4 |
| —      | 可信 env 分层（DSH 不信任任意 env）                                             | §7.7         |

---

## 7. 修复建议（逻辑改造点 + 验收断言）

> 只谈逻辑改造点与验收断言，不涉工期/人员/优先级。凡涉及多供应商注册的改造点标注「（G3）」。

### 7.1 目录模型补 pi-ai 缺失字段（不含 G3，纯数据层扩展）

- 在 `ModelCatalogEntry` 增加三组可选字段，全部 `#[serde(default)]` 保持向后兼容（对齐 `catalog.rs:46` 全缺省约定）：
  1. `thinking_level_map: Option<BTreeMap<String, String>>`——档位→wire 拼写（对齐 `opencode-go.json:1` 的 `thinkingLevelMap`、`getSupportedThinkingLevels` 消费）。消费方：`supports_reasoning_effort`/`reasoning_effort_tiers` 之外新增档位解析。验收断言：`lookup` 条目含该映射时，`reasoning_effort_tiers`（若缺）可由映射键推导；wire 拼写未知档位不参与选择。
  2. `input_modalities: Option<Vec<String>>`——多值模态（对齐 pi-ai `input`）。与现有 `supports_vision` 等布尔位并存（布尔位 = 便捷位）。验收断言：`supports_vision` 与 `input_modalities ⊇ {"image"}` 两来源在查询面收敛一致，`scan`/覆盖更新两处同时生效。
  3. `compat: Option<...>` 子结构——`supports_store`/`max_tokens_field`/`requires_reasoning_content_on_assistant`/`thinking_format`（对齐 pi-ai `compat`，`opencode-go.json:1`）。消费方：`request/build_*.rs` 传输面改用 `max_tokens_field` 而非硬编码。
- 验收断言：上述字段任一为 null/缺失时现有行为逐字段不变（透明补齐）；`catalog.json` 转录记录把这几组补进既有厂商条目。

### 7.2 配置层多供应商注册（G3）

- 把 `ProviderConfigStore::config` 从单 `ProviderConfig`（`config.rs:181`）改为 `BTreeMap<String, ProviderConfig>`（键 = provider_id）。`load`（`config.rs:187-197`）读 `provider-config.json` 顶层映射（旧单对象用 `{"openai-compatible": {...}}` 包装兼容）。
- `resolve()`（`config.rs:229-260`）新增 `resolve(provider_id)` 参数，per-provider 解析；保留无参 `resolve()` 默认 `openai-compatible` 语义（防破坏既有调用方，00 D3）。
- 验收断言：`load({a:{...},b:{...}})` 后 `resolve("a")`/`resolve("b")` 各自返回独立 `ResolvedProviderConfig`，base_url/model/api_key 互不串扰；`save()` 原子写回映射（`config.rs:208-210,291-300` 复用）。

### 7.3 凭据层 per-provider 引用（G3）

- 在 `ModelCatalogEntry` 无关的配置层，把 `api_key_ref` 单引用（`config.rs:104`）语义扩展到「每个 provider 路由一个引用」。改造点（逻辑）：
  - 沿用现有 `CredentialStore`（DPAPI/0600/内存，不动其实现，`credentials.rs` 全部保留）；
  - `secret_path_for`（`config.rs:263-278`）按 provider_id 求引用名：`secrets/{provider_id}/{ref}.dpapi` 或 `secrets/{provider_id}.dpapi`，缺省 `{provider_id}.dpapi`（替代单一 `default.dpapi`）。
- 验收断言：provider `a`、`b` 各写密钥后落盘到各自文件互不覆盖；`clear` 只清当前 provider；`resolve` 用 provider 自己的密钥。

### 7.4 env 命名空间 per-provider（G3）

- 新增 per-provider env 映射（对齐 `env-api-keys.js`）。逻辑改造点：
  - `first_env_value`（`config.rs:303-308`）接受 provider 维度：对 provider `p`，按 `{P}_API_KEY`, `{P}_BASE_URL`, `{P}_MODEL`, `{P}_ENDPOINT` 扫描，再回退现有 `CRISH_*` 组（兼容）。
  - 不动现有 `CRISH_*`（保留旧行为）。
- 验收断言：设 `OPENAI_API_KEY` + `DEEPSEEK_API_KEY` 时，`resolve("openai")` 取前者、`resolve("deepseek")` 取后者；无 provider env 时回退到 `CRISH_*`。

### 7.5 models「整体替换 vs 就地 override」双模式（对齐 DSH）

- 在覆盖面（`catalog_override.rs`）增加一个覆盖容器语义：`models` 列表整体替换某路由 catalog（DSH README.zh.md:78-80）。改造点：`with_overrides`（`catalog_override.rs:149-165`）之外新增 `replace_models(provider, models)` 入口，与既有 `upsert_from_scan`（逐条合并）/`with_overrides`（条目覆盖白名单）并存。
- 验收断言：声明 `models` 列表后该路由只服务列表内模型；未声明时原 catalog 全量服务——三模式互不干扰。

### 7.6 网络化价格刷新（可选，非 G3）

- 当前 `upsert_from_scan` 只合窗口/输出/能力位、不碰价格（`catalog_override.rs:66-133`），`catalog.json` 靠手工转录。逻辑改造点：新增远程价格源合并器（对齐 pi-ai `refreshModels`，`models.js:72-118`），用 `source_url`/`data_source` 溯源字段（`catalog.rs:157-162`）标记远程合并条目，`version`+1 触发 memoize 失效（`catalog.rs:214,230-232`）。
- 验收断言：远程源更新价格后 `data_source = "remote:*"`，`input_price_for` 返回新价且 `version` 增量。

### 7.7 可信 env 分层（对齐 DSH 安全面）

- 对 `DEEPSEEK_BASE_URL` 这类端点 env，DSH 只从可信层读（index.ts:186,236; README.zh.md）。Conex 改造点：`first_env_value` 对 build 面 env 区分可信/不可信来源（进程 env 全读 vs 白名单），端点 env 只认可信层。
- 验收断言：不可信 env 中的 `*_BASE_URL` 不覆盖持久化端点（Conex 当前 env 优先语义收紧）。

---

## 8. 与基线问题编号的对账

- **G3（单提供方配置层无多供应商注册）** 在本维度的具体落地证据：
  - `config.rs:96-110`：`ProviderConfig` 单提供方字段（单 provider_id/base_url/model/api_key_ref）。
  - `config.rs:177-182,187-197`：`ProviderConfigStore` 持单 `ProviderConfig`、单文件 `provider-config.json`。
  - `config.rs:229-260`：`resolve()` 产单一 `ResolvedProviderConfig`，无 provider 路由。
  - `config.rs:263-278`：`secret_path_for` 单凭据引用 + `default.dpapi`。
  - `config.rs:30-37`：固定 `CRISH_*` env 命名空间。
  - 修复：见 §7.2（配置）、§7.3（凭据）、§7.4（env）三改造点。
- 目录模型层（§1/§2）不归 G3，是 Conex 相对外部参考已超越的域。

---

## 9. 附 · 关键证据行号索引

| 主题                                            | 文件                                                                                                                  | 行号                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| ModelCatalogEntry 59 字段                       | `crates/agent-provider/src/models/catalog.rs`                                                                         | 47-172                 |
| 多级兜底 lookup                                 | 同上                                                                                                                  | 238-252                |
| include_str! 内置表                             | 同上                                                                                                                  | 224-227                |
| 四价/分档/峰谷查询                              | 同上                                                                                                                  | 284-447                |
| 覆盖白名单                                      | `crates/agent-provider/src/models/catalog_override.rs`                                                                | 244-278                |
| 扫描合并 upsert                                 | 同上                                                                                                                  | 66-133                 |
| 覆盖应用白名单校验                              | 同上                                                                                                                  | 149-237                |
| 分档类型/峰谷类型                               | `crates/agent-provider/src/models/catalog_price.rs`                                                                   | 16-62                  |
| ProviderConfig 单例                             | `crates/agent-provider/src/config.rs`                                                                                 | 95-110                 |
| ProviderConfigStore 单文件                      | 同上                                                                                                                  | 177-197                |
| resolve 单主体                                  | 同上                                                                                                                  | 229-260                |
| CRISH_* env                                     | 同上                                                                                                                  | 30-37                  |
| 凭据引用 sanitize                               | 同上                                                                                                                  | 311-331                |
| DPAPI/0600/内存降级                             | `crates/agent-provider/src/credentials.rs`                                                                            | 124-272                |
| SecretString Drop 清零                          | 同上                                                                                                                  | 19-58                  |
| pi-ai 模型字段实例                              | `D:\software\DeepSeek Harness\resources\host\node_modules\@earendil-works\pi-ai\dist\providers\data\opencode-go.json` | 1                      |
| pi-ai 内置提供方注册                            | `...\pi-ai\dist\providers\all.js`                                                                                     | 65-106                 |
| pi-ai per-provider env 映射                     | `...\pi-ai\dist\env-api-keys.js`                                                                                      | 63-110                 |
| pi-ai envApiKeyAuth                             | `...\pi-ai\dist\auth\helpers.js`                                                                                      | 7-26                   |
| pi-ai createModels/setProvider/refresh          | `...\pi-ai\dist\models.js`                                                                                            | 31-33,72-118,328-351   |
| pi-ai credential store per-provider             | `...\pi-ai\dist\models-store.js`                                                                                      | 1-13                   |
| DSH resolveApiKey / MISSING_CREDENTIAL          | `reference/deepseek-harness/packages/llm/llm-deepseek/src/index.ts`                                                   | 225-246                |
| DSH providerInfo/listModels/resolveModel        | `reference/deepseek-harness/packages/llm/llm-pi-ai/src/adapter.ts`                                                    | 227-274                |
| DSH models 整体替换 / modelOverrides            | `reference/deepseek-harness/packages/llm/llm-pi-ai/README.zh.md`                                                      | 78-90                  |
| DSH 模型设置页 35 提供方下拉                    | `reference/deepseek-harness/apps/web/tests/snapshots/models-settings/empty.expected.md`                               | 24-60                  |
| Conex catalog vendor 覆盖（10 vendor/151 模型） | `crates/agent-provider/src/models/catalog.json`                                                                       | 1-5（顶层 entries 键） |
