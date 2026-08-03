# LiteLLM 模型定价目录结构分析（R1 调研）

> 专项：「模型目录与定价 v2」　|　轮次：R1　|　调研日期：2026-08-03
> 调研对象：`reference/litellm/model_prices_and_context_window.json`（**2974 条**，1.7MB，主文件）
> 配套代码：`reference/litellm/litellm/cost_calculator.py`（2446 行，四指标计费）、`reference/litellm/litellm/__init__.py`（目录加载）、`litellm/litellm_core_utils/get_model_cost_map.py`（同步机制，git commit `257ada8` 完整存在，工作区被裁剪但仓库中可读）
> 既有分析：`docs/cache-optimization/01-reference-research/litellm-cache-analysis.md`（机制层面，本文专注目录结构与字段设计，二者互补）
> 产出用途：为 `catalog.json` v2 字段设计（`10-model-catalog-v2/00-gap-audit.md` §4.2）提供 LiteLLM 侧证据与对齐建议
> 性质：只读调研，未修改任何代码

## 0. 结论先行

1. **目录是全量模型元数据单文件**：2974 条 = 模型条目，145 个不同字段，无嵌套深度；每条独立记录"单价 + 窗口 + 能力位 + 出处"，成本计算/窗口钳制/缓存判定全部读这一张表。
2. **币种：无 currency 字段，全部隐式 USD**。非 USD 厂商（Kimi 官方 CNY）在提交时被换算成 USD 写入（证据：moonshot/kimi-k2.5 = $0.6/$3.0 per 1M，官方 CNY ¥3/¥15 折算隐含汇率 0.2）；换算汇率不落盘、不可追溯。
3. **四指标字段名**：`input_cost_per_token` / `output_cost_per_token` / `cache_read_input_token_cost` / `cache_creation_input_token_cost`，**单位全部 per-token USD**（与我们的 per_1M 差 1e6 倍）。抽样 5 厂商 24 模型：input+output 100% 覆盖；cacheRead 79%（deepseek-r1/coder、glm-4.5 缺）；cacheWrite 显式 0 或省略两种形态并存，**"缺字段"≠"无写价"，而是"写免费"或"未录入"两义混淆**——这是我们要在 v2 里消除的语义缺陷。
4. **同步机制**：启动时从 GitHub raw URL 拉取（env 可覆盖）→ 完整性校验（非空 + 模型数 ≥50 + 较 backup 缩水 ≤50%）→ 失败回退随包 backup JSON；`register_model` 支持运行时热注册。
5. **对 v2 建议**：字段命名对齐 litellm（camelCase 映射已定，gap-audit §4.3），单位统一 per_1M；**写免费必须显式 `cacheWritePrice: 0` + `cacheWriteFree: true`**（消除 litellm 省略形态歧义）；Anthropic 双档对应 litellm 原生 `cache_creation_input_token_cost_above_1hr`；豆包分段价用 litellm `tiered_pricing` 的 `range: [min, max)` 结构表达；GLM/豆包存储费、MiniMax 1h 写入档 litellm 目录均未覆盖，属 v2 扩展字段（`storagePricePer1mHour`、`cacheWritePrice1h`）。

---

## 1. 目录总体结构

### 1.1 文件规模

- 单文件 1.7MB JSON，**2974 个 key**，扁平 dict（model name → 条目 dict），无嵌套层。
- 1 个保留 key：`sample_spec`（不是模型，是**字段文档**——用注释字符串描述每个字段的含义与合法值，等于"JSON 内的 schema 说明"）。
- 仓库同时维护 3 个配套文件：`litellm/model_prices_and_context_window_backup.json`（2969 条，随包快照）、根目录 `model_prices_and_context_window.json`（GitHub 源）、`provider_endpoints_support.json`（端点支持）。

### 1.2 key 命名规则

| 形态                        | 示例                                                                       | 说明                                              |
| --------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| `model`                     | `gpt-5`、`claude-sonnet-4-6`、`deepseek/deepseek-chat`                     | 官方 API 标识                                     |
| `provider/model`            | `moonshot/kimi-k2.5`、`zai/glm-5`、`volcengine/doubao-seed-2-0-pro-260215` | 主站以外的通道                                    |
| `region.model`              | `anthropic.claude-sonnet-4-6`、`moonshotai.kimi-k2.5`                      | Bedrock/区域变体（仅计价用途，`__init__.py:667`） |
| `bedrock/<region>/<model>`  | `bedrock/ap-northeast-1/moonshotai.kimi-k2-thinking`                       | 区域级条目（仅计价，不进模型清单）                |
| `azure_ai/...`、`azure/...` | `azure_ai/gpt-5.5`                                                         | Azure 通道                                        |

- 同一物理模型多通道多条目（openai 主站 + azure_ai + bedrock + fireworks 等），`litellm_provider` 字段标明归属厂商。
- 全库无 `aliases` 字段实例（同步层 `_expand_model_aliases` 支持但当前数据未用）。

### 1.3 厂商 / mode 分布（provider top 10）

fireworks_ai 293、bedrock 267、openai 219、azure 219、bedrock_converse 138、vercel_ai_gateway 101、azure_ai 96、openrouter 96、novita 85、gemini 73。
mode：chat 2275、image_generation 209、embedding 124、responses 85、audio_transcription 62 等。

---

## 2. 字段全集与单位

145 个不同字段。按用途分组如下（出现次数为全库统计）：

### 2.1 四指标核心价格字段（本专项重点）

| 字段                                            | 出现次数 | 单位            | 语义                                                        |
| ----------------------------------------------- | -------- | --------------- | ----------------------------------------------------------- |
| `input_cost_per_token`                          | ~2500    | **USD / token** | 未缓存输入价（per-token 小数，`2.8e-07` = $0.28/1M）        |
| `output_cost_per_token`                         | ~2500    | USD / token     | 输出价                                                      |
| `cache_read_input_token_cost`                   | **700**  | USD / token     | 缓存命中（读）价                                            |
| `cache_creation_input_token_cost`               | **233**  | USD / token     | 缓存写入（创建）价——Anthropic 系为主                        |
| `cache_creation_input_token_cost_above_1hr`     | **114**  | USD / token     | 1 小时以上留存写价（Anthropic 1h 档，5m 档即上一条）        |
| `cache_read_input_token_cost_above_200k_tokens` | 部分     | USD / token     | 超长上下文读价档                                            |
| `input_cost_per_token_cache_hit`                | 31       | USD / token     | **历史字段名**（deepseek 系仍用），与 cache_read 并存且同值 |

**单位证据**：无单位字段、无注释；`sample_spec` 中 `input_cost_per_token: 0.0` 无单位说明；成本计算返回注释明确 "USD dollars"（`cost_calculator.py:345`）。数值量级验证：`moonshot/kimi-k2.5` 输入 `6e-07` = $0.6/1M，与官方 USD 价 $0.6/1M 一致（§3）。

### 2.2 分档 / 变体价格字段（tiered）

| 字段                                          | 次数 | 语义                                             |
| --------------------------------------------- | ---- | ------------------------------------------------ |
| `input_cost_per_token_above_128k_tokens`      | 14   | Gemini 128K 档                                   |
| `input_cost_per_token_above_200k_tokens`      | 49   | Anthropic/Bedrock 200K 档                        |
| `input_cost_per_token_above_272k_tokens`      | 46   | OpenAI 272K 档                                   |
| `input_cost_per_token_above_512k_tokens`      | 1    | MiniMax-M3 512K 档                               |
| `*_above_256k_tokens`                         | 1    | openrouter/qwen3.5-plus                          |
| `*_flex` / `*_priority`                       | ~100 | OpenAI service tier（flex 半价 / priority 双倍） |
| `*_batches`                                   | ~100 | 批量半价                                         |
| `tiered_pricing`（**数组**）                  | 20   | 通用分段结构，见下                               |
| `regional_processing_uplift_multiplier_eu/us` | 少数 | 数据驻留加价乘数                                 |
| `deprecation_date`                            | 部分 | `"2026-02-19"` 弃用日期                          |

**`tiered_pricing` 数组结构**（豆包分段价的官方表达，`volcengine/doubao-seed-2-0-pro-260215`）：

```json
"tiered_pricing": [
  { "input_cost_per_token": 4.6e-07, "output_cost_per_token": 2.3e-06, "range": [0, 32000.0] },
  { "input_cost_per_token": 7e-07,   "output_cost_per_token": 3.5e-06, "range": [32000.0, 128000.0] },
  { "input_cost_per_token": 1.4e-06, "output_cost_per_token": 7e-06,   "range": [128000.0, 256000.0] }
]
```

- `range: [min, max)` 半开区间；每档只有 input/output 两价（**tiered_pricing 内不支持 cacheRead/cacheWrite 分档**）。
- MiniMax-M3 是唯一用 `*_above_512k_tokens` 后缀表达超长档的（minimax/MiniMax-M3：`input_cost_per_token_above_512k_tokens: 6e-07`，且 cacheRead 也有 `cache_read_input_token_cost_above_512k_tokens: 1.2e-07`——**长上下文档覆盖 cacheRead 是本目录中罕见的一例**）。

### 2.3 窗口字段

| 字段                | 次数 | 语义                                          |
| ------------------- | ---- | --------------------------------------------- |
| `max_input_tokens`  | 2555 | 输入窗口上限                                  |
| `max_output_tokens` | 2388 | 输出上限（新字段）                            |
| `max_tokens`        | 2490 | 旧字段，`sample_spec` 标注 "LEGACY parameter" |

窗口字段单位是 **token 整数**（`131072`），非价格字段。

### 2.4 supports 能力位（30+ 个）

`supports_prompt_caching`（644）、`supports_function_calling`（1717）、`supports_parallel_function_calling`、`supports_system_messages`、`supports_vision`、`supports_tool_choice`、`supports_response_schema`、`supports_reasoning`、`supports_native_streaming`、`supports_native_structured_output`、`supports_pdf_input`、`supports_audio_input/output`、`supports_web_search`、`supports_computer_use`、`supports_assistant_prefill`、`supports_adaptive_thinking`、`supports_max/minimal/xhigh/none_reasoning_effort`、`supports_multimodal`、`supports_video_input`、`supports_output_config` 等。全部 bool。

### 2.5 其他单位形态（非 token 计费字段）

| 字段                                                                | 单位                 | 说明                                                          |
| ------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------- |
| `input_cost_per_character` / `_above_128k_tokens`                   | USD/字符             | Gemini 系字符计费                                             |
| `input_cost_per_image` / `input_cost_per_pixel`                     | USD/张、USD/像素     | 图像生成                                                      |
| `input_cost_per_audio_token` / `input_cost_per_audio_per_second`    | USD/token、USD/秒    | 语音                                                          |
| `input_cost_per_second` / `output_cost_per_second`                  | USD/秒               | realtime                                                      |
| `input_cost_per_request` / `input_cost_per_query`                   | USD/次               | 固定单次                                                      |
| `code_interpreter_cost_per_session`                                 | USD/会话             | OpenAI                                                        |
| `search_context_cost_per_query`                                     | USD/查询             | 联网搜索（按 high/low/medium 三档，claude-sonnet-4-6 = 0.01） |
| `vector_store_cost_per_gb_per_day`                                  | USD/GB/天            | OpenAI 向量库存储费                                           |
| `file_search_cost_per_1k_calls` / `file_search_cost_per_gb_per_day` | USD/1k 次、USD/GB/天 | OpenAI                                                        |
| `citation_cost_per_token` / `ocr_cost_per_page`                     | USD/token、USD/页    | 特殊功能                                                      |
| `output_vector_size`                                                | 维度整数             | embedding 维数（doubao-embedding = 2560）                     |
| `prompt_cache_min_tokens`                                           | token 整数           | 最小可缓存前缀（claude-sonnet-4-6 = 1024）                    |
| `rpm` / `tpm`                                                       | 次/分、token/分      | 限流配额                                                      |

### 2.6 溯源与元数据

| 字段               | 出现次数 | 说明                                                                                           |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------- |
| `litellm_provider` | 2973     | 归属厂商（唯一近全量字段）                                                                     |
| `source`           | 921      | 定价出处官方 URL（如 `https://api-docs.deepseek.com/quick_start/pricing`）                     |
| `comment`          | 1        | azure_ai/model_router："Flat cost of $0.14 per M input tokens..."（唯一带显式 USD 字样的条目） |
| `metadata`         | 少数     | 自由 notes 对象                                                                                |
| `mode`             | 大部分   | chat/embedding/image_generation 等                                                             |

---

## 3. 币种处理

### 3.1 结论：目录无 currency 字段，全部隐式 USD

- 全库 2974 条中 `currency` 字段出现次数 = **0**（对全字段集合进行 `currency/cny/usd/yuan/rmb/gbp/eur` 文本扫描无命中）。
- 成本计算侧明确 USD：`cost_calculator.py:345` "a tuple containing the cost in **USD dollars**"；返回注释（§2.1 引用处）同。
- `source` 字段只给官方 URL，不给币种，也不给汇率。

### 3.2 非 USD 厂商（CNY）如何表达：提交时换算成 USD

Kimi（官方 CNY 计价）、GLM（Z.ai 国际站 USD + 智谱 CNY 双轨）、豆包（火山方舟 CNY）在目录中一律以 USD 记录：

| 模型                                    | 目录值（USD/1M）          | 官方值（来源）                 | 隐含汇率                        |
| --------------------------------------- | ------------------------- | ------------------------------ | ------------------------------- |
| `moonshot/kimi-k2.5`                    | input 0.6 / output 3.0    | ¥3 / ¥15（CNY，moonshot 官方） | **0.2 USD/CNY**（0.6/3 = 3/15） |
| `zai/glm-5`                             | input 1.0 / output 3.2    | Z.ai 国际站 USD 直接定价       | 无换算（USD 源）                |
| `volcengine/doubao-seed-2-0-pro-260215` | 分档 0.46~~1.4 / 2.3~~7.0 | 火山方舟 CNY 定价              | 有换算，汇率未记录              |

**关键事实**：

- 汇率换算发生在**提交者写入目录时**，换算值一旦落盘即为静态数字；目录不保存原始 CNY、不保存汇率、无更新机制。
- 同一厂商不同条目的隐含汇率可能不同（不同提交批次），**无任何一致性保证**。
- 我们自己的 `catalog.json` 用 `currency` 字段保留币种（28/28 已标，gap-audit §2.2），比 litellm 更严谨；**建议在条目内同时保留 `sourceCurrency` 或换算说明**（可选），避免后续汇率重估无据。

---

## 4. 四指标完整性抽样（openai / anthropic / deepseek / kimi / zai）

口径：四指标 = input / output / cacheRead / cacheWrite；cacheWrite 显式 `0.0` 视为"有写价语义（免费）"。

### 4.1 openai（主站，全 5 条同构）

| 模型          | input    | output | cacheRead | cacheWrite |
| ------------- | -------- | ------ | --------- | ---------- |
| `gpt-5`       | 1.25e-06 | 1e-05  | 1.25e-07  | **缺字段** |
| `gpt-5.1`     | 1.25e-06 | 1e-05  | 1.25e-07  | **缺字段** |
| `gpt-5-mini`  | 2.5e-07  | 2e-06  | 2.5e-08   | **缺字段** |
| `gpt-4o`      | 2.5e-06  | 1e-05  | 1.25e-06  | **缺字段** |
| `gpt-4o-mini` | 1.5e-07  | 6e-07  | 7.5e-08   | **缺字段** |

结论：OpenAI 系全部"读有价、写缺字段"——写免费但**不写 0.0**（省略形态）。

### 4.2 anthropic（全 4 条同构）

| 模型                         | input | output  | cacheRead | cacheWrite(5m) | cacheWrite(1h) |
| ---------------------------- | ----- | ------- | --------- | -------------- | -------------- |
| `claude-sonnet-4-6`          | 3e-06 | 1.5e-05 | 3e-07     | 3.75e-06       | 6e-06          |
| `claude-opus-4-6`            | 5e-06 | 2.5e-05 | 5e-07     | 6.25e-06       | 1e-05          |
| `claude-sonnet-4-5-20250929` | 3e-06 | 1.5e-05 | 3e-07     | 3.75e-06       | 6e-06          |
| `claude-3-7-sonnet-20250219` | 3e-06 | 1.5e-05 | 3e-07     | 3.75e-06       | 6e-06          |

结论：Anthropic 是唯一**四指标双档完整**的厂商（5m/1h 两档写价 + `prompt_cache_min_tokens: 1024`）。

### 4.3 deepseek（写价显式 0 与省略并存）

| 模型                         | input   | output   | cacheRead  | cacheWrite      |
| ---------------------------- | ------- | -------- | ---------- | --------------- |
| `deepseek/deepseek-chat`     | 2.8e-07 | 4.2e-07  | 2.8e-08    | **0.0（显式）** |
| `deepseek/deepseek-v3`       | 2.7e-07 | 1.1e-06  | 7e-08      | **0.0（显式）** |
| `deepseek/deepseek-reasoner` | 2.8e-07 | 4.2e-07  | 2.8e-08    | 缺字段          |
| `deepseek/deepseek-r1`       | 5.5e-07 | 2.19e-06 | **缺字段** | 缺字段          |
| `deepseek/deepseek-coder`    | 1.4e-07 | 2.8e-07  | **缺字段** | 缺字段          |

结论：同一厂商内部形态都不统一（显式 0 vs 省略）；deepseek-chat 还保留历史字段 `input_cost_per_token_cache_hit: 2.8e-08` 与新字段并存同值。

### 4.4 kimi（moonshot 主站）

| 模型                             | input    | output  | cacheRead | cacheWrite |
| -------------------------------- | -------- | ------- | --------- | ---------- |
| `moonshot/kimi-k2.5`             | 6e-07    | 3e-06   | 1e-07     | 缺字段     |
| `moonshot/kimi-k2-turbo-preview` | 1.15e-06 | 8e-06   | 1.5e-07   | 缺字段     |
| `moonshot/kimi-k2-thinking`      | 6e-07    | 2.5e-06 | 1.5e-07   | 缺字段     |
| `moonshot/kimi-latest`           | 2e-06    | 5e-06   | 1.5e-07   | 缺字段     |
| `moonshot/kimi-thinking-preview` | 6e-07    | 2.5e-06 | 1.5e-07   | 缺字段     |

结论：读价全有、写价全缺（Kimi 写免费，省略形态）。另注：`kimi-k2-thinking-251104`（volcengine 通道）**四价全部为 0.0**（占位条）。

### 4.5 zai（GLM）

| 模型          | input   | output  | cacheRead  | cacheWrite    |
| ------------- | ------- | ------- | ---------- | ------------- |
| `zai/glm-5`   | 1e-06   | 3.2e-06 | 2e-07      | **0（显式）** |
| `zai/glm-5.1` | 1.4e-06 | 4.4e-06 | 2.6e-07    | **0（显式）** |
| `zai/glm-4.7` | 6e-07   | 2.2e-06 | 1.1e-07    | **0（显式）** |
| `zai/glm-4.6` | 6e-07   | 2.2e-06 | 1.1e-07    | **0（显式）** |
| `zai/glm-4.5` | 6e-07   | 2.2e-06 | **缺字段** | 缺字段        |

结论：GLM 新版显式写 0，旧版（glm-4.5）连读价都缺——**新版有缓存支持、旧版未录**。

### 4.6 抽样汇总

| 厂商      | 模型数 | input            | output           | cacheRead         | cacheWrite（含显式 0）  |
| --------- | ------ | ---------------- | ---------------- | ----------------- | ----------------------- |
| openai    | 5      | 5/5              | 5/5              | 5/5               | 0/5（省略）             |
| anthropic | 4      | 4/4              | 4/4              | 4/4               | 4/4（双档，最完整）     |
| deepseek  | 5      | 5/5              | 5/5              | 3/5               | 2/5（显式 0）+ 3/5 省略 |
| kimi      | 5      | 5/5              | 5/5              | 5/5               | 0/5（省略）             |
| zai       | 5      | 5/5              | 5/5              | 4/5               | 4/5（显式 0）           |
| **合计**  | **24** | **24/24 (100%)** | **24/24 (100%)** | **21/24 (87.5%)** | **10/24 有写价字段**    |

**关键观察**（对 v2 设计影响最大）：

1. input/output 两价覆盖 100%——基础两指标永远不缺。
2. cacheRead 覆盖 87.5%，缺口都是"老模型未录"而非"厂商无缓存"。
3. cacheWrite 的"缺字段"同时混着"写免费（OpenAI/Kimi/DeepSeek/GLM 新系）"与"未录入（glm-4.5）"两种语义——**litellm 本身无法区分**。v2 必须用 `cacheWritePrice: 0` + `cacheWriteFree: true` 显式化（gap-audit §2.2 已定口径，本文提供 litellm 侧反证：不显式化就无法消歧）。
4. 全库统计：`cache_read_input_token_cost` 700 条、`cache_creation_input_token_cost` 233 条、`supports_prompt_caching` 644 条（覆盖 > 缓存价条数，即 644 个模型声称支持缓存但其中约 150 条无缓存价）。

---

## 5. 同步机制（目录如何更新）

> 注意：工作区 `litellm/litellm_core_utils/` 被裁剪，但 git commit `257ada8` 中完整存在，以下逻辑逐行自仓库版本。

### 5.1 加载链路（`__init__.py:399-402, 511-513`）

```python
model_cost_map_url: str = os.getenv(
    "LITELLM_MODEL_COST_MAP_URL",
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
)
from litellm.litellm_core_utils.get_model_cost_map import get_model_cost_map
model_cost = get_model_cost_map(url=model_cost_map_url)
```

- **import 时即加载**（模块级），URL 可用环境变量 `LITELLM_MODEL_COST_MAP_URL` 覆盖（自建镜像/离线源）。

### 5.2 `get_model_cost_map` 决策树（git `litellm/litellm_core_utils/get_model_cost_map.py`）

```
1. LITELLM_LOCAL_MODEL_COST_MAP=True → 直接用本地 backup（绕过网络）
2. 否则 httpx.get(url, timeout=5) 拉远程 JSON
3. 拉取异常（网络/解析） → 回退本地 backup，记录 fallback_reason
4. 完整性校验 validate_model_cost_map：
   a. 是 dict 且非空
   b. 模型数 ≥ MODEL_COST_MAP_MIN_MODEL_COUNT（env 可覆盖，默认 50）
   c. 模型数 ≥ backup 模型数 × MODEL_COST_MAP_MAX_SHRINK_RATIO（默认 0.5，
      即远程比本地快照缩水超过一半视为损坏）
   校验失败 → 回退本地 backup
5. 通过 → 使用远程版本
6. _finalize_model_cost_map：
   - 提取 fallback_generalizations 块（装进路由回退模块，从 map 移除）
   - _expand_model_aliases：把条目内 aliases 数组展开为顶层 key（同一 dict 引用，零拷贝；冲突跳过并 warning）
7. _cost_map_source_info 单例记录来源（local/remote + url + fallback_reason），
   供 get_model_cost_map_source_info() 查询
```

### 5.3 本地备份与热注册

| 机制        | 位置                                                             | 说明                                                                                                                                                                                                          |
| ----------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 随包 backup | `litellm/model_prices_and_context_window_backup.json`（2969 条） | `_get_bundled_model_cost_map`（`utils.py:7551-7557`）`lru_cache(maxsize=1)` 读取；作为 provider config 兜底与远程校验基准。**注意：当前 backup 比主文件少 5 条**（2974 vs 2969），主/备不同步是本目录已知状态 |
| 热注册      | `register_model`（`utils.py:2675-2760`）                         | 接受 dict 或 URL，运行时二次注册/覆盖；对未入库模型从 region 变体条目继承缓存价字段                                                                                                                           |
| 变更失效    | `_invalidate_model_cost_lowercase_map`（`utils.py:4909-4913`）   | 每次 model_cost 变更后重建小写索引并清理 LRU；`_model_cost_mutation_generation` 单调计数器供下游 memoize 失效                                                                                                 |
| 模型名解析  | `_get_model_info_helper`（`utils.py:5223-5312`）                 | 查找顺序：`provider/model` → `model` → region 变体 → 去版本号 → 去微调后缀                                                                                                                                    |

### 5.4 对 v2 的同步启示

litellm 是"**每次启动全量拉取 + 完整性校验 + 快照兜底**"，没有增量协议、没有版本号字段（靠模型数阈值防损坏）。v2 catalog.json 若要热更新，建议保留其"快照兜底 + 变更计数失效"（gap-audit §9.7 已有），但**用显式 version 字段 + 逐条 sourceUrl 溯源**补足 litellm 的两个弱点：无版本标识、汇率/币种不可追溯。

---

## 6. 对我们的字段设计建议（catalog.json v2）

### 6.1 命名与单位（对齐 litellm，映射已在 gap-audit §4.3 定稿）

| v2 字段                             | litellm 字段                                | 差异处理                                                                                              |
| ----------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `inputPrice`                        | `input_cost_per_token`                      | litellm per-token → v2 per_1M（**÷1e-6 换算，换算时注意浮点**：2.8e-07 → 0.28 精确，1.25e-06 → 1.25） |
| `outputPrice`                       | `output_cost_per_token`                     | 同上                                                                                                  |
| `cacheReadPrice`                    | `cache_read_input_token_cost`               | 同上                                                                                                  |
| `cacheWritePrice`                   | `cache_creation_input_token_cost`           | litellm 只存单一创建价（5m 口径）                                                                     |
| `cacheWritePrice1h`                 | `cache_creation_input_token_cost_above_1hr` | litellm 原生字段，Anthropic 114 条可直抄                                                              |
| `promptCacheMinTokens`              | `prompt_cache_min_tokens`                   | 同值直抄（claude-sonnet-4-6 = 1024）                                                                  |
| `contextWindow` / `maxOutputTokens` | `max_input_tokens` / `max_output_tokens`    | 直抄                                                                                                  |
| `supports*`                         | `supports_*`                                | 逐一对应                                                                                              |
| `sourceUrl`                         | `source`                                    | 921 条可直抄 URL                                                                                      |

### 6.2 必须显式化的语义（litellm 教训）

1. **写免费显式化**：`cacheWritePrice: 0` + `cacheWriteFree: true` 二字段齐出（gap-audit 已定）；litellm 的省略形态在 OpenAI/Kimi（免费）与 glm-4.5（未录）间不可区分，v2 不得复刻。
2. **单位唯一化**：v2 只用 per_1M；litellm 的 per-token/per-second/per-query/per-GB-day 混合形态不复制，非 token 计费项（若有）单独用带单位后缀的字段名。
3. **币种字段必填**：litellm 无 currency 字段导致"USD 假设"蔓延；v2 已 28/28 有 currency，保持。

### 6.3 分档价格（tiered）处理

- **Anthropic 5m/1h 双档**：直接映射 `cacheWritePrice5m` + `cacheWritePrice1h`（litellm `cache_creation_input_token_cost` + `_above_1hr`）。
- **豆包/分段计价厂商**：采用 litellm `tiered_pricing` 的 `range: [min, max)` 半开区间数组结构，但**每档补充 cacheRead 字段**（litellm 的 tiered_pricing 缺读价档，MiniMax-M3 用后缀字段补救——两套表达并存，v2 统一为 tiered_pricing 数组）。
- **长上下文档（Grok ≥200K / MiniMax >512K）**：v2 已有 `longContextThreshold` + 三价（input/read/output），litellm 的 `*_above_512k_tokens` 后缀是等价的扁平表达，v2 数组化更优（gap-audit §4.2 E 组已定）。

### 6.4 存储费与 MiniMax 1h 写入档（litellm 未覆盖，v2 扩展）

- **存储费**：litellm 目录只有 OpenAI 系 `vector_store_cost_per_gb_per_day` / `file_search_cost_per_gb_per_day`（GB/天单位）；**GLM/豆包的 per-1M·h 存储费（豆包 0.017 元/1M·h）在目录中完全缺席**（volcengine/doubao-seed-2-0-pro 条目仅 tiered_pricing，无存储费字段）。v2 的 `storagePricePer1mHour`（gap-audit §4.2 C 组）是必须的扩展字段，无 litellm 可抄。
- **MiniMax 1h 写入档**：litellm 中 minimax 条目只有单一 `cache_creation_input_token_cost`（3.75e-07），**没有 `_above_1hr` 变体**（MiniMax 官方"写入后 1h 内命中"语义被压平为单档）。v2 用 `cacheWritePrice1h` 表达，或按 MiniMax 官方口径直接落单档 + `cacheTtl` 注明 1h 窗口（gap-audit §4.2 D 组 `cacheTtl` 已备）。

### 6.5 建议的条目形态对照（以豆包 seed-2.0-pro 为例）

```jsonc
// v2 建议形态（示意）
{
  "model": "doubao-seed-2-0-pro-260215",
  "vendor": "doubao",
  "provider": "volcengine",
  "currency": "CNY",
  "unit": "per_1M",
  "inputPrice": 0.46, // = litellm 4.6e-07 × 1e6（第 1 档）
  "outputPrice": 2.3,
  "cacheReadPrice": null, // litellm 此条目无读价档，R1 需补官方值
  "cacheWritePrice": null,
  "cacheWriteFree": false,
  "tieredPricing": [
    { "range": [0, 32000], "inputPrice": 0.46, "outputPrice": 2.3 },
    { "range": [32000, 128000], "inputPrice": 0.7, "outputPrice": 3.5 },
    { "range": [128000, 256000], "inputPrice": 1.4, "outputPrice": 7.0 },
  ],
  "storagePricePer1mHour": 0.017, // 豆包官方，litellm 无
  "sourceUrl": "https://www.volcengine.com/docs/82379/1330310",
}
```

---

## 7. 反模式清单（从本目录观察，v2 规避）

1. **"缺字段"双义**：写价省略既可能是免费也可能是未录——必须显式化（§6.2.1）。
2. **新旧字段并存**：`input_cost_per_token_cache_hit` 与 `cache_read_input_token_cost` 同值并存（deepseek），`max_tokens` 与 `max_output_tokens` 并存——v2 单轨字段，不留别名。
3. **占位 0 条目**：`kimi-k2-thinking-251104`（volcengine 通道）四价全 0，会污染成本统计——v2 要求"未获取显式 null + 未获取标注"，禁止 0 占位。
4. **主/备快照不同步**：2974 vs 2969——v2 若做 backup，需同步校验。
5. **`max_tokens` 语义混乱**：sample_spec 承认它是 LEGACY，值有时取 output 有时取 input——v2 只用 `contextWindow` + `maxOutputTokens` 两个语义明确的字段。
6. **非 token 计费混排**：目录里 per-token/per-second/per-image/per-GB-day 同池混放——v2 命名带单位后缀，消费侧无需猜。

---

## 附录 A：引用条目 JSON（证据原文）

**sample_spec（字段文档，节选）**

```json
{
  "input_cost_per_token": 0.0,
  "litellm_provider": "one of https://docs.litellm.ai/docs/providers",
  "max_input_tokens": "max input tokens, if the provider specifies it. if not default to max_tokens",
  "max_tokens": "LEGACY parameter. set to max_output_tokens if provider specifies it. IF not set to max_input_tokens...",
  "mode": "one of: chat, embedding, completion, image_generation, audio_transcription, audio_speech, moderation, rerank, search",
  "supports_prompt_caching": true
}
```

**deepseek/deepseek-chat（显式写 0 + 历史 cache_hit 字段）**

```json
{
  "cache_creation_input_token_cost": 0.0,
  "cache_read_input_token_cost": 2.8e-8,
  "input_cost_per_token": 2.8e-7,
  "input_cost_per_token_cache_hit": 2.8e-8,
  "litellm_provider": "deepseek",
  "max_input_tokens": 131072,
  "max_output_tokens": 8192,
  "mode": "chat",
  "output_cost_per_token": 4.2e-7,
  "source": "https://api-docs.deepseek.com/quick_start/pricing",
  "supports_prompt_caching": true
}
```

**claude-sonnet-4-6（四指标双档最完整）**

```json
{
  "cache_creation_input_token_cost": 3.75e-6,
  "cache_creation_input_token_cost_above_1hr": 6e-6,
  "cache_read_input_token_cost": 3e-7,
  "input_cost_per_token": 3e-6,
  "output_cost_per_token": 1.5e-5,
  "litellm_provider": "anthropic",
  "max_input_tokens": 1000000,
  "max_output_tokens": 64000,
  "prompt_cache_min_tokens": 1024,
  "supports_prompt_caching": true
}
```

**zai/glm-5（显式写 0）**

```json
{
  "cache_creation_input_token_cost": 0,
  "cache_read_input_token_cost": 2e-7,
  "input_cost_per_token": 1e-6,
  "output_cost_per_token": 3.2e-6,
  "litellm_provider": "zai",
  "max_input_tokens": 200000,
  "max_output_tokens": 128000,
  "supports_prompt_caching": true,
  "source": "https://docs.z.ai/guides/overview/pricing"
}
```

**moonshot/kimi-k2.5（读有价、写省略）**

```json
{
  "cache_read_input_token_cost": 1e-7,
  "input_cost_per_token": 6e-7,
  "output_cost_per_token": 3e-6,
  "litellm_provider": "moonshot",
  "max_input_tokens": 262144,
  "max_output_tokens": 262144,
  "source": "https://platform.moonshot.ai/docs/guide/kimi-k2-5-quickstart"
}
```

**volcengine/doubao-seed-2-0-pro-260215（tiered_pricing 三档 + 无存储费字段）**

```json
{
  "litellm_provider": "volcengine",
  "max_input_tokens": 256000,
  "max_output_tokens": 128000,
  "source": "https://www.volcengine.com/docs/82379/1330310",
  "tiered_pricing": [
    {
      "input_cost_per_token": 4.6e-7,
      "output_cost_per_token": 2.3e-6,
      "range": [0, 32000.0]
    },
    {
      "input_cost_per_token": 7e-7,
      "output_cost_per_token": 3.5e-6,
      "range": [32000.0, 128000.0]
    },
    {
      "input_cost_per_token": 1.4e-6,
      "output_cost_per_token": 7e-6,
      "range": [128000.0, 256000.0]
    }
  ]
}
```

**minimax/MiniMax-M3（512K 长上下文档 + 读价分档唯一例）**

```json
{
  "input_cost_per_token": 3e-7,
  "input_cost_per_token_above_512k_tokens": 6e-7,
  "output_cost_per_token": 1.2e-6,
  "output_cost_per_token_above_512k_tokens": 2.4e-6,
  "cache_read_input_token_cost": 6e-8,
  "cache_read_input_token_cost_above_512k_tokens": 1.2e-7,
  "litellm_provider": "minimax",
  "max_input_tokens": 1000000,
  "max_output_tokens": 128000
}
```

**azure_ai/model_router（唯一显式 USD 字样的 comment）**

```json
{
  "comment": "Flat cost of $0.14 per M input tokens for Azure AI Foundry Model Router infrastructure. Use pattern:..."
}
```

---

## 附录 B：代码位置索引

| 主题                                        | 文件                                                              | 位置                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 目录 URL 与环境变量                         | `litellm/__init__.py`                                             | 399-402                                                                                |
| 目录加载入口                                | `litellm/__init__.py`                                             | 511-513                                                                                |
| 同步决策树/校验/回退                        | `litellm/litellm_core_utils/get_model_cost_map.py`（git 257ada8） | 全文件                                                                                 |
| 校验常量                                    | `litellm/constants.py`                                            | MODEL_COST_MAP_MIN_MODEL_COUNT（默认 50）、MODEL_COST_MAP_MAX_SHRINK_RATIO（默认 0.5） |
| 本地 backup 读取                            | `litellm/utils.py`                                                | 7551-7557                                                                              |
| 热注册与缓存价继承                          | `litellm/utils.py`                                                | 2675-2760                                                                              |
| 变更失效计数                                | `litellm/utils.py`                                                | 4900-4913                                                                              |
| 四指标计费公式                              | `litellm/cost_calculator.py`                                      | 180-228                                                                                |
| usage 归一化（OpenAI/Anthropic 双命名空间） | `litellm/cost_calculator.py`                                      | 363-411                                                                                |
| 分项成本 breakdown                          | `litellm/cost_calculator.py`                                      | 1640-1675                                                                              |
| 批量防重复计费                              | `litellm/cost_calculator.py`                                      | 2168-2178                                                                              |
| USD 说明                                    | `litellm/cost_calculator.py`                                      | 345                                                                                    |
| ModelInfoBase 类型（cache 字段全集）        | `litellm/types/utils.py`                                          | 191-288                                                                                |
