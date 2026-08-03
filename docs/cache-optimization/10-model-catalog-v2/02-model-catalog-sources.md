# 模型目录与定价 v2：R1 模型目录数据源调研（models.dev / OpenRouter / LiteLLM）

> 专项：「模型目录与定价 v2」　|　轮次：R1 数据源调研　|　调研日期：2026-08-03
> 实测方式：`curl` 拉取三源实时响应（models.dev/api.json ≈ 3.4 MB；openrouter.ai/api/v1/models ≈ 530 KB；litellm model_prices_and_context_window.json ≈ 1.7 MB），本文所有 JSON 片段均为 2026-08-03 抓取的真实响应（长片段已截断，截断处标注 `…`）。
> 消费参考：`reference/jcode/crates/jcode-base/src/model_pricing.rs`（jcode 的 models.dev 消费实现）、`reference/opencode/packages/core/src/models-dev.ts`（opencode 的 models.dev 消费实现）、`docs/cache-optimization/03-plans/P3-vendor-model-layer.md`（crish `catalog_refresh` 现状）。
> 产出用途：为 crish 运行时目录更新（`catalog_refresh` 远程源）选型与落地定靶。

---

## 0. 结论速览

1. **推荐主源 = models.dev**：无鉴权单 URL（`https://models.dev/api.json`），179 厂商 / 6044 模型，四指标（input/output/cache_read/cache_write）字段齐备，DeepSeek / Kimi / GLM 的缓存价格覆盖在三个候选源中**最好**（LiteLLM 缺 Kimi K3 / GLM 5.x，OpenRouter 是折扣价），且有 jcode（24h 磁盘缓存）与 opencode（60min 周期刷新）两个成熟消费先例可抄。
2. **增强源 = OpenRouter**：唯一带 **1h 写价档**（`input_cache_write_1h`，21 个 Anthropic 模型）与 **reasoning 档位**（`reasoning.supported_efforts` / `default_effort`）的目录；`/endpoints` 详情提供 `supports_implicit_caching`（jcode 判定隐式缓存能力的事实来源）。
3. **不推荐 LiteLLM 作远程源**：字段最全（含 `cache_creation_input_token_cost_above_1hr`、`prompt_cache_min_tokens`、13+ `supports_*` 位），但 CN 厂商滞后严重——**无 kimi-k3 / glm-5.x 条目；doubao、qwen3-max 有条目却无价格**；deepseek-v4-flash 的 `max_output_tokens` 仍是过时的 8192。
4. **四指标覆盖**：三源均为 USD 隐式（无 currency 字段）；cache_read 覆盖 models.dev 2874/6044 模型、cache_write 1065/6044（其中 194 条显式 `0` = 写免费语义）；OpenRouter 337 模型中 182 条有 `input_cache_read`、58 条有 `input_cache_write`、150 条无任何缓存价。
5. **关键发现**：
   - models.dev **没有豆包/方舟、Qwen/百炼、千帆/ERNIE 的官方 provider**——这些厂商的绝对单价（00-gap-audit §3.9/3.10/3.11 缺口）无法从任何远程目录补齐，只能走官方定价页人工转录。
   - models.dev 的 Anthropic 条目**没有 1h 写价档**（只有 5m 档 `cache_write`），与 OpenRouter 的 `input_cache_write_1h`、LiteLLM 的 `above_1hr` 构成三源间唯一结构性字段差。
   - 目录里的"推理计价"信号（`cost.reasoning`、`reasoning.supported_efforts`、`output_cost_per_reasoning_token`）与"上下文分档价"信号（`cost.tiers` / `context_over_200k` / `pricing.overrides` / `above_272k_tokens` 系）是 v2 特化字段的直接来源（第 6 节）。

---

## 1. models.dev（推荐主源）

### 1.1 接口形态

- **地址**：`GET https://models.dev/api.json`——无鉴权、无查询参数、无分页，一次拉取全量。**注意：models.dev 并没有 `/api/models` 路径，实际为 `/api.json`**；另有 `https://models.dev/model-schema.json`（JSON Schema，opencode 的 `packages/opencode/script/schema.ts:9` 引用 `#/$defs/Model`）。
- **顶层结构**：`{ "<provider-id>": Provider }`，`Provider = { id, name, env[], models{} }`（可选 `api` / `npm`）。实测 179 个 provider、6044 个模型。
- **更新机制**：数据由 GitHub 仓库（anomalyco/models.dev）社区 PR 维护，站点无公开刷新周期声明；每个模型带 `release_date` / `last_updated` 时间戳可自证新鲜度。opencode 的刷新策略见 1.4。
- **币种**：USD（隐式，无 currency 字段；models.dev 全目录统一按美元计）。

### 1.2 字段结构（实测样例）

DeepSeek 官方 provider（`deepseek-v4-flash`，注意**无 `cache_write` 字段 = 写免费**，另有 `cost.reasoning` 推理计价字段）：

```json
"deepseek": {
  "id": "deepseek", "name": "DeepSeek", "env": ["DEEPSEEK_API_KEY"],
  "models": {
    "deepseek-v4-flash": {
      "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash", "family": "deepseek-flash",
      "reasoning": true,
      "reasoning_options": [{"type": "toggle"}, {"type": "effort", "values": ["high", "max"]}],
      "interleaved": {"field": "reasoning_content"},
      "tool_call": true, "structured_output": true, "temperature": true,
      "release_date": "2026-07-31", "last_updated": "2026-07-31",
      "modalities": {"input": ["text"], "output": ["text"]}, "open_weights": true,
      "limit": {"context": 1000000, "output": 384000},
      "cost": {"input": 0.14, "output": 0.28, "reasoning": 0.28, "cache_read": 0.0028}
    }
  }
}
```

Anthropic 官方 provider（`claude-fable-5`，**有 `cache_write` = 5m 档写价**，1h 档缺失）：

```json
"anthropic": { "id": "anthropic", "name": "Anthropic", "env": ["ANTHROPIC_API_KEY"], "models": { "claude-fable-5": {
  "reasoning_options": [{"type": "effort", "values": ["low", "medium", "high", "xhigh", "max"]}],
  "limit": {"context": 1000000, "output": 128000},
  "cost": {"input": 10, "output": 50, "cache_read": 1, "cache_write": 12.5} } } }
```

GLM 官方 provider（`zai`，**`cache_write: 0` 显式写免费**）：`glm-5.2` → `cost: {"input": 1.4, "output": 4.4, "cache_read": 0.26, "cache_write": 0}`、`limit: {"context": 1000000, "output": 131072}`。

Kimi 官方 provider（`moonshotai`，只有 read 无 write）：`kimi-k3` → `cost: {"input": 3, "output": 15, "cache_read": 0.3}`、`limit: {"context": 1048576, "output": 131072}`；另有 `moonshotai-cn`（中国区同名模型）、`kimi-for-coding`（4 条全 0 价）。

OpenAI 官方 provider（`gpt-5.6`，**上下文分档价** `tiers` + `context_over_200k`，写价 1.25x）：

```json
"openai": { "id": "openai", "name": "OpenAI", "env": ["OPENAI_API_KEY"], "models": { "gpt-5.6": {
  "limit": {"context": 1050000, "input": 922000, "output": 128000},
  "cost": {"input": 5, "output": 30, "cache_read": 0.5, "cache_write": 6.25,
    "tiers": [{"input": 10, "output": 45, "cache_read": 1, "cache_write": 12.5,
      "tier": {"type": "context", "size": 272000}}],
    "context_over_200k": {"input": 10, "output": 45, "cache_read": 1, "cache_write": 12.5}} } } }
```

快速模式变体（`claude-opus-5` 的 `experimental.modes.fast`，带额外 body/header 与独立四价）：`"experimental": {"modes": {"fast": {"cost": {"input": 10, "output": 50, "cache_read": 1, "cache_write": 12.5}, "provider": {"body": {"speed": "fast"}, "headers": {"anthropic-beta": "fast-mode-2026-02-01"}}}}}`。

字段全集（对 models.dev Model 对象实测 key）：`id` `name` `description` `family` `attachment` `reasoning` `reasoning_options` `interleaved` `structured_output` `temperature` `tool_call` `knowledge` `release_date` `last_updated` `modalities` `open_weights` `limit{context,input?,output}` `cost{input,output,cache_read?,cache_write?,reasoning?,tiers?,context_over_200k?}` `status(alpha|beta|deprecated)` `experimental{modes{...}}` `provider{npm,api}`。其中 `status` 仅 229/6044 模型带（≈3.8%，可作退役/弃用信号的补充来源，不完整）。

### 1.3 缓存价格字段覆盖（四指标视角，实测统计）

| 维度                               | 实测数值                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 有 `cache_read` 的模型             | 2874 / 6044（47.6%）                                                                                                                 |
| 有 `cache_write` 的模型            | 1065 / 6044（17.6%），其中显式 `0` = 写免费 194 条                                                                                   |
| DeepSeek                           | v4-flash/v4-pro 有 read 价（input 的 2%），**无 write 字段**（写免费，与 00-gap-audit §1 `cacheWriteFree` 口径一致）                 |
| Kimi（moonshotai / moonshotai-cn） | kimi-k3 read = input 的 10%，无 write 字段                                                                                           |
| GLM（zai / zhipuai）               | read 价齐，`cache_write: 0` 显式写免费                                                                                               |
| Anthropic                          | read + write（5m 档，如 fable-5 12.5、sonnet-5 2.5）；**无 1h 档**                                                                   |
| OpenAI                             | gpt-5.6 系 read + write（1.25x）+ tiers 分档；gpt-5.5 无 write（旧轨写免费）                                                         |
| 豆包 / Qwen / 千帆                 | **无官方 provider**，仅转售商条目（豆包见 `nano-gpt`/`302ai`/`qiniu-ai`/`zenmux` 等 40+ 条；Qwen 只在 `opencode-go` 等网关条目出现） |
| 币种                               | 全目录 USD（隐式）                                                                                                                   |

### 1.4 消费模式（两份可抄先例）

**jcode**（`reference/jcode/crates/jcode-base/src/model_pricing.rs`）：

- `API_URL = "https://models.dev/api.json"`（26 行）；磁盘缓存 `~/.jcode/cache/models_dev_pricing.json`、**TTL 24h**（27-28 行）；内存 `Arc<HashMap<provider, HashMap<model, ModelCost>>>` 全局缓存（57 行）。
- 查找链（15-17 行注释）：**静态审定表优先 → models.dev → provider 专属源（OpenRouter endpoints）→ 通用兜底**；`models_dev_provider_id`（102-141 行）把 jcode provider 键映射到 models.dev provider id（`kimi → kimi-for-coding`、`zai → zai`、`nvidia-nim → nvidia`、`azure → azure` 等）。
- 只解析 `input/output/cache_read/cache_write` 四值（258-272 行）；无缓存价 = `None`，不猜测。
- 防滥用：测试构建与 `JCODE_DISABLE_PRICING_REFRESH` 下不联网（190-196 行）；单飞刷新原子位 `REFRESH_IN_FLIGHT`（197-199 行）；无 Tokio 环境退线程（206-215 行）。

**opencode**（`reference/opencode/packages/core/src/models-dev.ts`）：

- `GET {source}/api.json`，UA `opencode/...`，10s 超时、2 次指数退避重试（144-176 行）；磁盘缓存 `Global.Path.cache/models.json`。
- **新鲜度检查 5 分钟**（159 行 `Duration.minutes(5)`）+ **后台每 60 分钟周期刷新**（251 行 `Schedule.spaced("60 minutes")`）；`opencode models --refresh` 强制刷新（`packages/opencode/src/cli/cmd/models.ts:22-30`）。
- 跨进程 Flock 锁防并发（219-222 行）；磁盘无缓存时回退**编译期内嵌快照**（192-194 行），再退配置/环境（`OPENCODE_MODELS_URL` / `OPENCODE_MODELS_PATH` / `OPENCODE_DISABLE_MODELS_FETCH`）。
- Schema（20-114 行）已覆盖 `cost.tiers` / `cost.context_over_200k` / `reasoning_options`（effort/toggle/budget_tokens）/ `interleaved` / `experimental.modes` / `status`；成本侧 reasoning 按输出价计费（`packages/opencode/src/session/session.ts:400-402`，注释"TODO: update models.dev to have better pricing model, for now: charge reasoning tokens at the same rate as output tokens"）。

---

## 2. OpenRouter 模型目录（推荐增强源）

### 2.1 接口形态

- **地址**：`GET https://openrouter.ai/api/v1/models`——无鉴权；返回 `{"data": [...], "total_count": 337, "links": {...}}`。另有每条模型的详情端点 `GET /api/v1/models/{author}/{slug}/endpoints`（见 2.3）。
- **币种**：USD（隐式）；`pricing` 值为 **per-token 美元字符串**（如 `"0.00000014"` = $0.14/1M，与 models.dev 的 per-1M 数值差 10⁶ 倍，换算必须显式）。
- **更新机制**：模型条目带 `created` unix 时间戳；别名模型（`~` 前缀）自动指向最新版；无公开刷新周期声明。

### 2.2 字段结构（实测样例）

`deepseek/deepseek-v4-flash`（**只有 `input_cache_read`，无 write**）：

```json
{
  "id": "deepseek/deepseek-v4-flash",
  "canonical_slug": "deepseek/deepseek-v4-flash-20260423",
  "name": "DeepSeek: DeepSeek V4 Flash",
  "created": 1777000666,
  "context_length": 1048576,
  "architecture": {
    "modality": "text->text",
    "input_modalities": ["text"],
    "output_modalities": ["text"],
    "tokenizer": "DeepSeek"
  },
  "pricing": {
    "prompt": "0.00000014",
    "completion": "0.00000028",
    "input_cache_read": "0.000000028"
  },
  "supported_parameters": [
    "frequency_penalty",
    "include_reasoning",
    "logit_bias",
    "max_tokens",
    "reasoning",
    "reasoning_effort",
    "response_format",
    "seed",
    "structured_outputs",
    "temperature",
    "tool_choice",
    "tools",
    "top_p",
    "…"
  ],
  "reasoning": {
    "mandatory": false,
    "default_enabled": true,
    "supported_efforts": ["max", "high", "low"],
    "default_effort": "high"
  },
  "top_provider": {
    "context_length": 1048576,
    "max_completion_tokens": 393216,
    "is_moderated": false
  },
  "…": "…"
}
```

`anthropic/claude-sonnet-5`（**带 `input_cache_write` + `input_cache_write_1h` 双档写价**）：

```json
{
  "id": "anthropic/claude-sonnet-5",
  "canonical_slug": "anthropic/claude-sonnet-5-20260630",
  "context_length": 1000000,
  "pricing": {
    "prompt": "0.000002",
    "completion": "0.00001",
    "web_search": "0.01",
    "input_cache_read": "0.0000002",
    "input_cache_write": "0.0000025",
    "input_cache_write_1h": "0.000004"
  },
  "reasoning": {
    "mandatory": false,
    "default_enabled": true,
    "supported_efforts": ["max", "xhigh", "high", "medium", "low"],
    "default_effort": "medium"
  },
  "top_provider": {
    "context_length": 1000000,
    "max_completion_tokens": 128000
  },
  "…": "…"
}
```

`openai/gpt-5.6-luna`（**`overrides` 上下文分档价**，128k/272k 档通过 `min_prompt_tokens` 表达）：

```json
{
  "id": "openai/gpt-5.6-luna",
  "context_length": 1050000,
  "pricing": {
    "prompt": "0.0000001",
    "completion": "0.0000006",
    "web_search": "0.005",
    "input_cache_read": "0.00000001",
    "input_cache_write": "0.000000125",
    "overrides": [
      {
        "min_prompt_tokens": 272000,
        "prompt": "0.0000002",
        "completion": "0.0000009",
        "input_cache_read": "0.00000002",
        "input_cache_write": "0.00000025"
      }
    ]
  },
  "reasoning": {
    "supported_efforts": ["max", "xhigh", "high", "medium", "low", "none"],
    "default_effort": "medium"
  },
  "…": "…"
}
```

`pricing` 子键全集（337 模型实测并集）：`prompt` `completion` `input_cache_read` `input_cache_write` `input_cache_write_1h` `input_audio_cache` `web_search` `image` `image_output` `audio` `audio_output` `internal_reasoning` `overrides`。分布：182 条有 `input_cache_read`，58 条有 `input_cache_write`，21 条有 `input_cache_write_1h`（全为 Anthropic），18 条有 `input_audio_cache`（全为 Gemini），150 条无任何缓存价。

### 2.3 cache_control 标注与隐式缓存判定

- **catalog 本身不标 cache_control**：337 个模型的 `supported_parameters` 中**没有任何一个包含 `cache_control`**（实测 0/337）。
- 隐式缓存能力在**详情端点**：`GET /api/v1/models/anthropic/claude-sonnet-5/endpoints` 返回按上游分列的路由，每路由含 `pricing`（含 cache 价）、`supports_implicit_caching`、`status`、`uptime_*`、`max_completion_tokens`：

```json
{ "data": { "id": "anthropic/claude-sonnet-5", "endpoints": [
    { "name": "Anthropic | anthropic/claude-sonnet-5-20260630", "provider_name": "Anthropic", "tag": "anthropic",
      "context_length": 1000000,
      "pricing": {"prompt": "0.000002", "completion": "0.00001", "web_search": "0.01",
        "input_cache_read": "0.0000002", "input_cache_write": "0.0000025", "input_cache_write_1h": "0.000004", "discount": 0},
      "supported_parameters": ["max_tokens", "stop", "reasoning", "include_reasoning", "tools", "tool_choice", "structured_outputs", "response_format", "verbosity", "reasoning_effort"],
      "status": 0, "uptime_last_30m": 100,
      "supports_implicit_caching": false }, "…": "…" ] } }
```

- jcode 的用法（`jcode-cache-analysis.md` §5.3，`jcode-provider-openrouter-runtime/src/lib.rs:2704-2745`）：`model_supports_cache` = 模型定价 `input_cache_read`/`input_cache_write` > 0 **或** 端点 `supports_implicit_caching == true` **或** 端点定价 cache_read > 0，才给请求加断点——即**"定价数据可查"就是断点门控**，这条判定逻辑可直接抄进 crish 的 `cache_behavior_for` 数据源。

### 2.4 与官方直连价的差异（冲突裁决必读）

OpenRouter 是转售渠道，价与官方不一致，且**折扣随渠道波动**（实测 2026-08-03）：

| 模型                               | OpenRouter 实测（USD/1M）              | models.dev 官方价（USD/1M）          |
| ---------------------------------- | -------------------------------------- | ------------------------------------ |
| deepseek/deepseek-v4-flash         | 0.14 / 0.28 / read 0.028               | 0.14 / 0.28 / read 0.0028            |
| ~deepseek/deepseek-v4-flash-latest | 0.09 / 0.18 / read 0.018               | —（别名）                            |
| z-ai/glm-5.2                       | 0.6958 / 2.1868 / read 0.12922         | 1.4 / 4.4 / 0.26（≈50% 折扣）        |
| moonshotai/kimi-k2.7-code          | 0.73 / 3.5 / read 0.15                 | 0.95 / 4 / 0.19（≈77% 折扣）         |
| anthropic/claude-sonnet-5          | 2 / 10 / read 0.2 / write 2.5 / 1h 4.0 | 2 / 10 / 0.2 / write 2.5（无 1h 档） |

注意 `deepseek-v4-flash` 的 read 价 0.028 vs 官方 0.0028 **差 10 倍**（OpenRouter 缓存折扣远小于官方），冲突时绝不能以 OpenRouter 价覆盖官方价。

---

## 3. LiteLLM 远程目录（不推荐作主源）

### 3.1 拉取地址与格式

- **地址**：`https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`（实测可拉取，≈1.7 MB）；代码内默认 URL 见 `litellm/__init__.py:399-402`，支持环境变量覆盖（`litellm-cache-analysis.md` §四），包内还有 `model_prices_and_context_window_backup.json` 本地兜底（`utils.py:7551-7557`）。
- **格式**：扁平 `{ "<model_key>": ModelInfo }` 单文件（实测 2986 条），键含 `provider/model`、`azure/`、`vertex_ai/`、`bedrock_mantle/` 等前缀变体；文件首键为 `sample_spec`。随 GitHub main 分支 PR 合并即更新，无版本/时间戳字段（靠 `_model_cost_mutation_generation` 运行时计数，P3 §3.1.4 已对齐此概念）。
- **币种**：USD（隐式）；价格一律 **per-token**（`2.8e-09` = $0.0028/1M，与 00-gap-audit §4.3 的换算警告一致）。

### 3.2 字段结构（实测样例）

`deepseek/deepseek-v4-flash`（**per-token 价 + `cache_creation_input_token_cost: 0.0` 写免费 + 13 个能力位**）：

```json
"deepseek/deepseek-v4-flash": {
  "cache_creation_input_token_cost": 0.0, "cache_read_input_token_cost": 2.8e-09,
  "input_cost_per_token": 1.4e-07, "input_cost_per_token_cache_hit": 2.8e-09,
  "litellm_provider": "deepseek", "max_input_tokens": 1000000, "max_output_tokens": 8192,
  "mode": "chat", "output_cost_per_token": 2.8e-07,
  "source": "https://api-docs.deepseek.com/quick_start/pricing",
  "supported_endpoints": ["/v1/chat/completions"],
  "supports_assistant_prefill": true, "supports_function_calling": true,
  "supports_native_streaming": true, "supports_parallel_function_calling": true,
  "supports_prompt_caching": true, "supports_reasoning": true,
  "supports_response_schema": true, "supports_system_messages": true,
  "supports_tool_choice": true, "supports_vision": false }
```

`claude-sonnet-5`（**`cache_creation_input_token_cost_above_1hr` 1h 写价 + `prompt_cache_min_tokens` 最低缓存前缀**，124 条 Anthropic/Bedrock 条目有此字段）：

```json
"claude-sonnet-5": {
  "cache_creation_input_token_cost": 2.5e-06, "cache_creation_input_token_cost_above_1hr": 4e-06,
  "cache_read_input_token_cost": 2e-07, "input_cost_per_token": 2e-06,
  "litellm_provider": "anthropic", "max_input_tokens": 1000000, "max_output_tokens": 128000,
  "output_cost_per_token": 1e-05, "prompt_cache_min_tokens": 1024,
  "supports_prompt_caching": true, "supports_reasoning": true, "…": "…" }
```

字段全集（并集统计）：四价 per-token（`input/output_cost_per_token`、`cache_read_input_token_cost`、`cache_creation_input_token_cost`、`cache_creation_input_token_cost_above_1hr`、`input_cost_per_token_cache_hit`）；长上下文分档（`input/output_cost_per_token_above_128k/200k/256k/272k/512k_tokens`、`_priority`/`_flex`/`_batches` 变体）；`prompt_cache_min_tokens`；`max_input_tokens`/`max_output_tokens`；`mode`；`litellm_provider`；`source`；`supported_endpoints`；13+ `supports_*` 位，含推理档位五连（`supports_none/minimal/low/xhigh/max_reasoning_effort`）与 `output_cost_per_reasoning_token`。

### 3.3 CN 厂商覆盖问题（不推荐的决定性证据，实测）

| 模型                                  | LiteLLM 条目 | 价格                                             |
| ------------------------------------- | ------------ | ------------------------------------------------ |
| kimi-k3                               | **无条目**   | —                                                |
| glm-5.2 / glm-5.1                     | **无条目**   | —                                                |
| volcengine/doubao-seed-2-0-pro-260215 | 有条目       | **四价全空**（仅 provider/window/mode）          |
| dashscope/qwen3-max                   | 有条目       | **四价全空**                                     |
| deepseek-v4-flash / v4-pro            | 有条目       | 有价，但 `max_output_tokens` 仅 8192（明显滞后） |

即：**LiteLLM 对 crish 关心的 CN 厂商（Kimi/GLM/豆包/Qwen）要么缺失要么无价**，只对 Anthropic/OpenAI 的字段粒度（1h 写价、min_tokens、reasoning effort 位、长文分档）有价值，可作为**字段补丁参考**而不是远程源。

---

## 4. 三者对比表

| 维度                                  | models.dev                                                                                        | OpenRouter                                                                                                       | LiteLLM                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 拉取地址                              | `models.dev/api.json`                                                                             | `openrouter.ai/api/v1/models`（+ `/endpoints` 详情）                                                             | `raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`                                   |
| 鉴权 / 体积                           | 无 / ≈3.4 MB                                                                                      | 无 / ≈530 KB                                                                                                     | 无 / ≈1.7 MB                                                                                                            |
| 覆盖规模                              | 179 provider / 6044 模型                                                                          | 337 模型（单渠道）                                                                                               | 2986 条（含渠道前缀变体）                                                                                               |
| 四指标字段                            | `cost.input/output/cache_read/cache_write`（cache_read 2874、cache_write 1065 条）                | `pricing.prompt/completion/input_cache_read/input_cache_write`（182/58 条）+ **`input_cache_write_1h`**（21 条） | `input/output_cost_per_token`、`cache_read_input_token_cost`、`cache_creation_input_token_cost`（+ `above_1hr` 124 条） |
| 上下文/输出上限                       | `limit.context/input/output`                                                                      | `context_length` + `top_provider.max_completion_tokens`                                                          | `max_input_tokens`/`max_output_tokens`                                                                                  |
| 能力位                                | `reasoning/tool_call/structured_output/temperature/modalities/open_weights/status`                | `supported_parameters` 列表 + `reasoning.{mandatory,default_enabled,supported_efforts,default_effort}`           | 13+ `supports_*` 位（含 5 档 effort 位）                                                                                |
| 币种                                  | USD（隐式，per-1M 数值）                                                                          | USD（隐式，per-token 字符串，差 10⁶ 倍）                                                                         | USD（隐式，per-token，差 10⁶ 倍）                                                                                       |
| 更新机制                              | GitHub 社区 PR；模型带 `last_updated`；无官方周期声明                                             | 渠道侧维护；`created` 时间戳；`~` 别名自动跟随最新                                                               | GitHub main 分支 PR 合并即生效；无时间戳                                                                                |
| 已知消费先例                          | jcode（24h 磁盘缓存）、opencode（5min 新鲜度 + 60min 周期刷新）                                   | jcode（断点门控用 `supports_implicit_caching` + cache 价判定）                                                   | 无（litellm 自身 import 时拉取 + backup 兜底）                                                                          |
| CN 厂商覆盖                           | DeepSeek/Kimi/GLM 官方 provider 齐；**无豆包/Qwen/千帆官方条目**                                  | 有 z-ai/kimi/bytedance-seed 折扣条目；非官方价                                                                   | **kimi-k3/glm-5.x 缺失；豆包/qwen 无价**                                                                                |
| 特殊字段                              | `cost.reasoning`、`cost.tiers`/`context_over_200k`、`experimental.modes`、`status`、`interleaved` | `overrides` 分档、`input_audio_cache`、`internal_reasoning`、`~` 别名                                            | 长文分档 `above_128k~512k`、`_priority/_flex/_batches`、`prompt_cache_min_tokens`、`output_cost_per_reasoning_token`    |
| 能否作 crish `catalog_refresh` 远程源 | **✅ 主源**（无鉴权、四指标齐、CN 相对最好、双先例）                                              | **✅ 增强源**（1h 写价、reasoning 档位、隐式缓存判定；折扣价只能给 OpenRouter 渠道条目用）                       | **❌ 不作源**（CN 缺失/无价；仅字段补丁参考）                                                                           |

---

## 5. crish 运行时目录更新策略建议

### 5.1 源选择（三层）

1. **主源：models.dev**——`catalog_refresh` 的远程导入来源。理由：唯一同时覆盖 DeepSeek/Kimi/GLM 官方四指标的无鉴权目录；jcode 与 opencode 的消费实现可直接对照落地；全量 3.4 MB 对 Rust 侧磁盘缓存完全可接受（jcode 已证明）。
2. **增强源：OpenRouter**——仅在**用户配置的 channel/provider 是 openrouter**（或其网关）时启用，补两类数据：① Anthropic 模型的 `input_cache_write_1h` → crish `cacheWritePrice1h`（models.dev 无此字段，00-gap-audit §4.2 双档写价只能靠它/LiteLLM）；② 断点门控判定（`input_cache_read/write > 0` 或 endpoints 的 `supports_implicit_caching`，照抄 jcode `model_supports_cache` 逻辑）。
3. **LiteLLM：不拉取**。其 `prompt_cache_min_tokens` / `above_1hr` / effort 位等只作**人工转录时的字段对照表**（00-gap-audit §4.3 映射表已覆盖），不进运行时。

### 5.2 刷新周期（参照双先例收敛）

| 参数         | 建议值                                                          | 依据                                                                       |
| ------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 磁盘缓存 TTL | **24h**                                                         | jcode `model_pricing.rs:28`（24h 磁盘缓存 + 同步查询不阻塞网络）           |
| 启动行为     | 缓存未过期直接加载；过期则**后台**刷新（同步查询永不打网络）    | jcode `ensure_cache_fresh` + opencode 启动即后台 refresh                   |
| 周期后台刷新 | 进程空闲时每 **60min** 检查一次新鲜度                           | opencode `models-dev.ts:251`                                               |
| 手动强制     | `catalog_refresh` 命令带 `force` 参数全量重拉                   | opencode `models --refresh`；crish 命令面已存在（`catalog_commands.rs`）   |
| 并发防护     | 单飞原子位 + 跨进程文件锁                                       | jcode `REFRESH_IN_FLIGHT`；opencode Flock                                  |
| 失败语义     | 刷新失败仅记日志，继续用旧缓存；无缓存时退回内置 `catalog.json` | jcode 失败 `warn` 不阻断；P3「内置表 include_str! 离线可用」不变量不受影响 |

### 5.3 冲突裁决（优先级从高到低）

1. **内置静态表 + 用户覆盖**（`catalog.json` + `catalog-overrides.json`）：人工审定条目，含 CNY 与 CN 专属字段（豆包/Qwen/千帆转售价、双档写价、`dataSource` 口径）——远程源**永远不覆盖**人工值，且 P3 的覆盖白名单（禁改 model/provider/vendor 三键）对远程导入同样生效。
2. **models.dev 官方价**：填充/更新静态表缺失的 USD 四指标（DeepSeek/Kimi/GLM/Anthropic/OpenAI 全系），写入时带 `sourceUrl = https://models.dev/api.json` + `dataVerifiedAt = 抓取日期`。
3. **OpenRouter 价**：**仅当条目 provider 段是 openrouter 类渠道时**采用（如 `vendor=deepseek, provider=openrouter` 的转售条目）；同模型直连官方价与 OpenRouter 折扣价差异巨大（实测 glm-5.2 打约五折、deepseek read 价差 10 倍），**禁止跨渠道覆盖**（对应 00-gap-audit §13.4 转售条目策略）。
4. **冲突判定原则**：同键同源以 `dataVerifiedAt` 新者胜；同键异源以优先级 1 > 2 > 3 定夺，不合并均价。

### 5.4 落地路径（对 P3 的增量）

- **阶段一（主源接入）**：`catalog_refresh` 增加远程导入分支——fetch `models.dev/api.json` → 白名单字段映射（下表）→ 与现有 `upsert_from_scan` / `with_overrides` 同一合并链、版本号 +1。
- **阶段二（增强源）**：模型锁定时按需查 OpenRouter `/api/v1/models/{slug}/endpoints` 补 `supports_implicit_caching` 与 1h 写价（仅 openrouter 渠道启用时触发，避免无谓网络）。
- **不实施项**：不做成本计算（P5 域）、不引入 LiteLLM 运行时拉取。

**字段映射表（models.dev → crish `ModelCatalogEntry`）**：

| models.dev 字段                    | crish 字段（00-gap-audit §4.2）      | 处理                                                                                                                                              |
| ---------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cost.input` / `cost.output`       | `inputPrice` / `outputPrice`         | per-1M 数值直填（同单位，无需换算）                                                                                                               |
| `cost.cache_read`                  | `cacheReadPrice`                     | 缺失 = None                                                                                                                                       |
| `cost.cache_write`                 | `cacheWritePrice` + `cacheWriteFree` | 缺失或 `0` → 显式写免费（与 00-gap-audit §0 口径一致）                                                                                            |
| `cost.tiers` / `context_over_200k` | `longContextThreshold` + 长文三价    | 与 OpenRouter `overrides`、LiteLLM `above_272k` 交叉验证                                                                                          |
| `cost.reasoning`                   | （P5 成本域）                        | 记入条目备用字段，消费在 P5                                                                                                                       |
| `limit.context` / `limit.output`   | `contextWindow` / `maxOutputTokens`  | 直填                                                                                                                                              |
| `reasoning_options[].type/values`  | `supportsReasoning` + effort 档位    | effort values → crish `ThinkingIntensity` 可选档（00-gap-audit §4.4 映射面）                                                                      |
| `status`（alpha/beta/deprecated）  | `retired` / `deprecationDate`        | 仅当为 deprecated 时写 retired 标记；覆盖率 3.8%，不作唯一依据                                                                                    |
| `interleaved.field`                | 行为矩阵（reasoning 内容键）         | 供 P1 判定函数参考（reasoning_content 键存在性）                                                                                                  |
| provider id 映射                   | `vendor` 键                          | 照抄 jcode `models_dev_provider_id` 映射表（`moonshotai→kimi`、`zai→glm` 等，模型名再做 `deepseek-v4-flash-0731 → deepseek-v4-flash` 去版本兜底） |

---

## 6. 特化优化线索（三源独有字段清单）

### 6.1 reasoning 档位（三个源各有一份正交信息）

| 源         | 字段                                                                                       | 实测样例                                                                                       | crish 用途                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| models.dev | `cost.reasoning`                                                                           | deepseek-v4-flash `reasoning: 0.28`（= 输出价）；89 模型带此字段                               | 推理 token 计价（opencode 目前按输出价计费，注释自认待改进 `session.ts:400-402`）；v2 可入条目供 P5 精确计费 |
| models.dev | `reasoning_options`                                                                        | `[{type:"toggle"},{type:"effort",values:["high","max"]}]`；另有 `budget_tokens` 型             | effort 档位白名单 → 直接约束 crish `ThinkingIntensity` 可选档                                                |
| OpenRouter | `reasoning.{mandatory,default_enabled,supported_efforts,default_effort}`                   | sonnet-5：`supported_efforts:["max","xhigh","high","medium","low"]`, `default_effort:"medium"` | 断点/请求构造时的 effort 默认值与可用档；`mandatory` 可门控 reasoning 开关                                   |
| LiteLLM    | `supports_none/minimal/low/xhigh/max_reasoning_effort` + `output_cost_per_reasoning_token` | claude-sonnet-5 等条目带                                                                       | 能力位补丁参考                                                                                               |

### 6.2 特殊缓存语义

1. **1h 写价档**：OpenRouter `input_cache_write_1h`（21 条全为 Anthropic；sonnet-5 写价 2.5 / 1h 4.0，与 00-gap-audit §1 sonnet-5 双档 2.5/4.0 **完全吻合**）；LiteLLM `cache_creation_input_token_cost_above_1hr`（124 条，含 fable-5 的 1.25e-05/2e-05）。**models.dev 无此字段**——crish 的 `cacheWritePrice1h` 运行时源只能取这两个。
2. **上下文分档价（长上下文三价缺口直接答案）**：models.dev `cost.tiers[{tier:{type:"context",size}},input,output,cache_read,cache_write]` + `context_over_200k`（gpt-5.6 272k 档 10/45/1/12.5）；OpenRouter `pricing.overrides[{min_prompt_tokens, ...}]`；LiteLLM `input/output_cost_per_token_above_128k/200k/256k/272k/512k_tokens`。00-gap-audit §3.5/3.7/3.8 的 grok-4.3（200K）、gemini-3-1-pro（200K）、minimax-m3（512K）长文档可用此结构对号入座（models.dev 对 grok/gemini/minimax 均有官方条目）。
3. **音频输入缓存**：OpenRouter `input_audio_cache`（18 条全为 Gemini：3.6-flash/3.5-flash/3.1-pro 系）——Gemini 音频输入按独立缓存价计，v2 可加 `supportsAudioInput` 对应缓存语义。
4. **快速模式变体**：models.dev `experimental.modes.fast`（claude-opus-5：`{input:10, output:50, cache_read:1, cache_write:12.5}` + `provider.body/headers` 注入）——对应 OpenRouter `anthropic/claude-opus-5-fast` 独立条目；crish 若支持"快速档"可直接消费。
5. **隐式缓存能力**：OpenRouter `/endpoints` 的 `supports_implicit_caching` + 端点级 cache 价——jcode 断点门控的事实来源（`lib.rs:2724-2742`），crish 的 `cache_behavior_for` 对 OpenAI 兼容网关（豆包/千帆等隐式缓存厂商）的判定可照抄。
6. **写免费语义**：models.dev 缺 `cache_write` 或显式 `0`（DeepSeek/Kimi/GLM/旧轨，194 条显式 0）、LiteLLM `cache_creation_input_token_cost: 0.0`——统一归一为 00-gap-audit §0 的"写免费"口径，与现有 `cacheWriteFree` 字段兼容。
7. **别名/版本跟随**：models.dev openrouter 段的 `~deepseek/deepseek-v4-flash-latest`（0.09/0.18/0.018 促销价）；OpenRouter `alias_target`/`canonical_slug`——目录合并时的"最新版跟随"语义，对应 jcode 的去版本后缀兜底（`model_pricing.rs:145-147,162-164`）。
8. **web_search 按查询计费**：OpenRouter `pricing.web_search`（如 sonnet-5 0.01/查询、gpt-5.6 系 0.005-0.01）——对应 00-gap-audit §4.3 提到的 `search_context_cost_per_query` 字段，v2 可选收录。

---

## 附：实测记录与验证方法

- **抓取命令**（2026-08-03，全部成功）：
  - `curl -sL https://models.dev/api.json`（3 452 228 B）
  - `curl -sL https://openrouter.ai/api/v1/models`（529 986 B）
  - `curl -sL https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`（1 670 646 B）
  - `curl -sL https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5/endpoints`（详情端点样例）
- **数值统计口径**：以 Python 3.10 解析后计数（provider/模型数、cache 字段覆盖数、reasoning 相关字段并集）；所有价格为抓取时刻快照，厂商随时可能调整，`dataVerifiedAt` 以本文日期为准。
- **诚实边界**：三个源均无公开"更新频率"官方文档（models.dev 靠 PR、OpenRouter 靠渠道维护、LiteLLM 靠 main 分支合并），"更新频率"列为实测推断；豆包/Qwen/千帆官方价三源均缺，只能人工转录官方定价页；models.dev 的 `status` 覆盖率仅 3.8%，退役判定不可单独依赖。
- **复验方式**：下载后本地 `python -m json.tool` 校验 JSON 合法；四指标数值与 00-gap-audit §1 既有 28 条抽查一致（deepseek-v4-flash 0.14/0.28/0.0028、claude-fable-5 10/50/1/12.5、glm-5.2 1.4/4.4/0.26 均吻合），说明既有目录转录正确、三源口径可比。
