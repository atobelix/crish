# LiteLLM 缓存机制深度分析

> 分析对象：`reference/litellm`（LiteLLM 最新版参考代码，git 分支 `litellm_internal_staging`，commit `257ada8`）
> 分析目的：为 crish（Rust 引擎 + Tauri + React 的 AI 桌面工作台）的 `crates/agent-provider` 多厂商解析层提供缓存与成本计算的可借鉴设计
> 分析性质：只读分析，未修改任何源代码

## 重要前置说明：参考库是裁剪版

本次 checkout 的 `litellm/` 包**不含 `caching/` 子包**（`caching.py`、`redis_cache.py`、`dual_cache.py`、`caching_handler.py`、`in_memory_cache.py`），也不含 `litellm_core_utils/`、`integrations/`、`proxy/`、`vertex_ai/`。证据：

- `litellm/utils.py:399-406` 直接导入 `from .caching.caching import Cache, RedisCache, RedisSemanticCache, S3Cache, QdrantSemanticCache, AzureBlobCache`，但该模块不在 checkout 中
- `litellm/main.py:183` 导入 `from .caching.caching import disable_cache, enable_cache, update_cache`
- `litellm/scheduler.py:8` 导入 `from litellm.caching.caching import DualCache, RedisCache`
- `litellm/llms/gemini/context_caching/README.md:1` 指向 `litellm/vertex_ai/context_caching/`（同样被裁剪）

因此本文对"响应缓存的 key 构造/命中流程"这类只存在于 `caching/` 包内的实现细节，只能基于**类型定义、调用点、架构文档**做推演性描述，并明确标注证据级别；对可读源码的部分（prompt caching 透传、usage 归一化、定价目录、路由亲和性）给出精确行号。

---

## 结论先行：最值得借鉴的 5 点

1. **模型定价目录（`model_prices_and_context_window.json`）是一个"按模型聚合一切元数据"的单文件数据源**。每个模型条目同时携带：输入/输出单价、缓存读/缓存写单价（含分档 `above_1hr`、service tier 变体）、`prompt_cache_min_tokens`（缓存最小前缀长度）、`max_input_tokens`/`max_output_tokens`、能力位（`supports_prompt_caching` 等）。成本计算、上下文窗口钳制、缓存可用性判定全部读这一张表，且支持 URL 远程拉取 + 本地 backup 兜底。**crish 的多厂商适配层应建立同样的"模型元数据目录"概念，而不是把成本/窗口/能力散落在各家 provider 代码里。**
2. **usage 归一化采用"双命名空间 + 不变量调整"**：OpenAI 系走 `prompt_tokens_details.cached_tokens`（`prompt_tokens` 已含缓存 token），Anthropic 系走 `cache_read_input_tokens`/`cache_creation_input_tokens`（`prompt_tokens` 不含缓存 token）。`cost_per_token`（`litellm/cost_calculator.py:363-411`）在计算前把两套语义统一到"`prompt_tokens` 包含缓存 token"这一不变量上，缓存 token 按各自单价（`cache_read_input_token_cost`/`cache_creation_input_token_cost`）单独计价。这是多厂商成本核算最值得抄的设计。
3. **prompt caching 采用"透传 + 判定"双模式，完全不拦截厂商语义**：Anthropic 的 `cache_control`（message 级、content block 级、tool 级、system 级）原样透传，网关只做"是否已设置 cache_control"的布尔检测来决策 header 与校验；同时用 `is_prompt_caching_valid_prompt`（`litellm/utils.py:9074`）按模型级 `prompt_cache_min_tokens` 判定"前缀是否够长值得缓存"。**透传不重建、判定不强制**，是 crish 在 agent-provider 层做多厂商缓存支持的正确姿态。
4. **缓存计价信息随定价目录下发（`cache_read_input_token_cost`/`cache_creation_input_token_cost` 字段）**，并且 OpenAI 兼容厂商的 cache-write token 有 `cache_write_tokens`（kimi-k2）与 `cache_creation_tokens` 两种别名（`litellm/cost_calculator.py:377-382`），归一化时做别名兜底。这类"厂商字段别名表"模式对 crish 的 usage 解析层有直接价值。
5. **缓存命中与成本是"可观测的"**：Prometheus 指标区分三类——网关自身响应缓存（`litellm_cache_hits/misses_metric`）、网关缓存的 token 数（`litellm_cached_tokens_metric`）、厂商侧 prompt caching 的 token 数（`litellm_provider_cache_read_input_tokens_metric`/`cache_creation`），且细粒度 token 指标与总 token 指标共享 label 集以便 join。**"厂商缓存收益"与"网关缓存收益"分开计量**的思路值得 crish 借鉴。

---

## 一、项目结构概览：缓存分层

LiteLLM 是 LLM 网关（AI Gateway）＋ SDK 双形态：SDK 负责厂商调用与转换，网关在 SDK 之上加认证/限流/预算/路由（`ARCHITECTURE.md:9-18`）。缓存分成四层，职责边界清晰（`ARCHITECTURE.md:208-216` 的组件职责表）：

| 层 | 职责 | 实现 |
|---|---|---|
| **LLM 响应缓存** | SDK 层缓存完整响应（chat/embedding/rerank 等） | `caching/caching.py`（`Cache`）＋ `caching/caching_handler.py`（`LLMCachingHandler`），后端支持 local/redis/s3/disk 等 |
| **InternalUsageCache** | 网关层限流计数 + API key 缓存 | `proxy/utils.py`（被裁剪，`ARCHITECTURE.md:212`） |
| **Router.cache** | TPM/RPM 追踪、部署冷却、HTTP 客户端缓存、会话亲和 | `router.py`（`DualCache`，`ARCHITECTURE.md:213`） |
| **预算/配额** | 全局与按 key/用户/团队预算 | `budget_manager.py`、`__init__.py:430-441` |

后端类型枚举（`litellm/types/caching.py:8-17`）：

```python
class LiteLLMCacheType(str, Enum):
    LOCAL = "local"
    REDIS = "redis"
    REDIS_SEMANTIC = "redis-semantic"
    VALKEY_SEMANTIC = "valkey-semantic"
    S3 = "s3"
    DISK = "disk"
    QDRANT_SEMANTIC = "qdrant-semantic"
    AZURE_BLOB = "azure-blob"
    GCS = "gcs"
```

- 支持语义缓存（redis-semantic / qdrant-semantic / valkey-semantic）——证明语义缓存是 LiteLLM 的正式后端类型
- 可缓存的调用类型白名单：`completion/acompletion/embedding/aembedding/transcription/rerank/responses` 等（`litellm/types/caching.py:20-33`）
- 缓存控权参数（类 HTTP 缓存语义，`litellm/types/caching.py:74-89`）：

```python
DynamicCacheControl = TypedDict("DynamicCacheControl", {
    "ttl": Optional[int],          # 自定义缓存时长（秒）
    "namespace": Optional[str],    # 缓存命名空间
    "s-maxage": Optional[int],     # 共享缓存最大年龄
    "no-cache": Optional[bool],    # 不读缓存但写缓存
    "no-store": Optional[bool],    # 完全不写缓存
})
```

- 进程级缓存常量：`DEFAULT_IN_MEMORY_TTL = 5s`（`constants.py:329`）、`DEFAULT_MAX_REDIS_BATCH_CACHE_SIZE = 1000`（`constants.py:330-332`）——in-memory 层 TTL 极短（5 秒），redis 才是权威存储
- 健康检查：`/cache/ping` 返回 `CachePingResponse`（`types/caching.py:92-100`），含 `litellm_cache_params` 与脱敏后的 `health_check_cache_params`
- 预算控制：全局 `_current_cost`（`__init__.py:391`）、按用户/团队/标签的 `max_*_budget`（`__init__.py:427-441`）；`budget_manager.py:26-203` 的 `BudgetManager` 提供 `projected_cost`/`update_cost`/`reset_on_duration` 等；网关侧 `RouterBudgetLimiting` 挂在 Router 的 DualCache 上（`router.py:1657-1665`）

---

## 二、LLM 响应缓存（redis cache）

> 证据级别说明：`Cache.get_cache_key` 的具体实现位于被裁剪的 `litellm/caching/caching.py`，本文只能给出其调用契约与周边约束。

### 2.1 缓存 key 的构造（基于可用证据）

SDK 层缓存 key 的可验证输入包括：

- **`preset_cache_key`**：调用方可显式指定缓存 key，`litellm/main.py:5039` 从 kwargs 取出，`main.py:5317` 传入下游；默认值为 `None`（`main.py:7607, 7901`），类型定义在 `types/utils.py:2480`。这是"会话/任务级共享缓存"的官方入口——即**调用方自行决定 key 的语义**，网关默认不做隐式聚合
- **`DynamicCacheControl.namespace`**：命名空间维度（`types/caching.py:80`）
- 真实实现（LiteLLM 公开源码行为，`caching/caching.py` 的 `Cache.get_cache_key`）以 `model + messages + temperature + max_tokens + top_p + n + tools + ...` 的规范化序列为输入做确定性哈希；本 checkout 能佐证的是 `types/caching.py:20-33` 按调用类型区分缓存面，以及 `types/caching.py:115-123` 的 `CachedEmbedding`（embedding 响应缓存的结构化类型）

### 2.2 TTL 与失效

- 进程内 `DEFAULT_IN_MEMORY_TTL = 5`（`constants.py:329`）
- 缓存参数通过 `cache_kwargs` 透传给 `RedisCache`（`router.py:304, 367-369, 479-487`）
- 网关对健康检查类调用显式禁缓存：`model_params["cache"] = {"no-cache": True}`（`main.py:8328`）

### 2.3 命中统计

Prometheus 指标（`types/integrations/prometheus.py:247-253`）：

```python
# Cache metrics
"litellm_cache_hits_metric",
"litellm_cache_misses_metric",
"litellm_cached_tokens_metric",
```

### 2.4 路由层缓存（Router.cache）

路由层是缓存的最大消费者，key 模板集中在 `RouterCacheEnum`（`types/router.py:767-771`）：

```python
class RouterCacheEnum(enum.Enum):
    TPM = "global_router:{id}:{model}:tpm:{current_minute}"
    RPM = "global_router:{id}:{model}:rpm:{current_minute}"
    ITPM = "global_router:{id}:{model}:itpm:{current_minute}"
    OTPM = "global_router:{id}:{model}:otpm:{current_minute}"
```

- TPM/RPM 计数是**分钟级时间分片 key**，天然带 TTL 语义
- HTTP 客户端复用缓存：`{model_id}_client` / `{model_id}_stream_async_client` 等（`router.py:10009-10033`），仅读本地层 `local_only=True`（`router.py:10011, 10019`），`client_ttl=3600`（`router.py:306, 457`）
- 调度器队列也用缓存：`SchedulerCacheKeys.queue:{model_name}`（`scheduler.py:123-137`），redis 可用时优先轮询 redis 而非内存（`scheduler.py:36-39`）
- Redis 原子操作类型：`RedisPipelineIncrementOperation`（key + increment_value + ttl）、`RedisPipelineSetOperation`、`RPUSH/LPOP` 队列操作（`types/caching.py:36-72`）——路由层用 redis pipeline 做批量计数

### 2.5 Redis 连接层

`litellm/_redis.py` 提供统一 client 工厂：

- `get_redis_client` / `get_redis_async_client` / `get_redis_connection_pool`（`_redis.py:539, 561, 655`）
- 支持标准/集群/哨兵三种拓扑（`_redis.py:451, 489, 514`）
- 支持 GCP IAM（`create_gcp_iam_redis_connect_func`，`_redis.py:133`）与 Azure AD（`create_azure_ad_redis_connect_func`，`_redis.py:237`）认证
- `REDIS_SOCKET_TIMEOUT = 0.1s`（`constants.py:339`）——**Redis 访问超时极短**，缓存层不可用不拖垮主链路

---

## 三、Prompt caching 透传

### 3.1 Anthropic：cache_control 全链路透传

**判定**：`AnthropicModelInfo.is_cache_control_set`（`llms/anthropic/common_utils.py:108-123`）检测 message 级与 content block 级 `cache_control` 是否出现——仅用于 header 决策，不改写消息。

**header**：Anthropic 已取消 prompt-caching beta header，`get_cache_control_headers` 只返回版本头（`llms/anthropic/chat/transformation.py:580-586`）：

```python
def get_cache_control_headers(self) -> dict:
    # Anthropic no longer requires the prompt-caching beta header
    # Prompt caching now works automatically when cache_control is used in messages
    return {"anthropic-version": "2023-06-01",}
```

同样注释出现在 `common_utils.py:545-547`（`get_beta_headers`）与 `common_utils.py:590-592`（`get_anthropic_headers`）——**prompt caching 不再需要任何特殊 header，纯靠请求体内的 cache_control 标记**。

**透传点**（`llms/anthropic/chat/transformation.py`）：

| 位置 | 行号 | 行为 |
|---|---|---|
| 顶层参数 | 1538-1540 | `param == "cache_control"` 时原样进 `optional_params`（自动 prompt caching） |
| system 消息 | 1611-1612, 1631-1632 | `translate_system_message` 把 system 块上的 `cache_control` 复制到 Anthropic system content |
| tool 定义 | 747-761 | `_map_tool_helper` 透传 tool 级 `cache_control`（对 tool search 工具除外） |

**拦截器（可选）**：`AnthropicCacheControlHook.maybe_seed_default_injection_points`（`main.py:5071-5082`）支持"自动注入 cache_control 断点"（例如按 role/index 在 user/system/assistant 消息上打断点），注入点类型见 `types/integrations/anthropic_cache_control_hook.py:8-27`（`CacheControlMessageInjectionPoint` / `CacheControlToolConfigInjectionPoint`，含 `_litellm_judged` 回写标记）。这是可选的网关侧增强，默认不强制。

**透传代理路径**：`experimental_pass_through/adapters/transformation.py:289-319` 的 `_add_cache_control_if_applicable` 在 Claude/Bedrock ARN 模型上把 content block 的 `cache_control` 保留到新格式（text/image/doc/tool_result）；**当文本块带 cache_control 时强制用 list 格式而非字符串拼接**（`transformation.py:511-581`）——"格式选择受缓存标记约束"是个值得注意的细节。

**清理**：`messages/transformation.py:74-85` 移除 cache_control 的 `scope` 字段（跨请求缓存 `global` 作用域），说明透传并非 100% 原样，而是有平台差异化的裁剪。

### 3.2 缓存资格判定：min_tokens

真正的"值不值得缓存"由 token 数门槛决定（`utils.py:9050-9107`）：

```python
def get_prompt_cache_min_tokens(model: str) -> int:
    # 解析顺序：显式覆盖环境变量 MINIMUM_PROMPT_CACHE_TOKEN_COUNT
    #          → 定价目录中该模型的 prompt_cache_min_tokens
    #          → 厂商无关默认值 1024
    # 定价目录是真相来源：Anthropic 的阈值在 512~4096 之间随版本浮动，同一模型跨平台也不同
    if MINIMUM_PROMPT_CACHE_TOKEN_COUNT_OVERRIDE is not None:
        return MINIMUM_PROMPT_CACHE_TOKEN_COUNT_OVERRIDE
    try:
        min_tokens = get_model_info(model=model).get("prompt_cache_min_tokens")
    except Exception:
        return DEFAULT_MINIMUM_PROMPT_CACHE_TOKEN_COUNT   # 1024
    ...
```

（`utils.py:9050-9071`；常量定义 `constants.py:272-283`，含注释"最小缓存前缀是 per-model 的：Anthropic 512~4096，且同模型可因平台而异"）

```python
def is_prompt_caching_valid_prompt(model, messages, tools, custom_llm_provider, min_token_count=None) -> bool:
    token_count = token_counter(messages=messages, tools=tools, model=model, ...)
    if min_token_count is None:
        min_token_count = get_prompt_cache_min_tokens(model=model)
    return token_count >= min_token_count
```

（`utils.py:9074-9107`；OpenAI 的阈值是统一 1024，被默认值覆盖，见 `utils.py:9089` 注释）

路由层有 `prompt_caching` pre-call check（`PromptCachingDeploymentCheck`，`router.py:1655-1656`），即**在选路阶段就把缓存资格纳入部署选择**。

### 3.3 OpenAI 系：prompt_cache_key 透传

`prompt_cache_key` / `prompt_cache_retention` 是标准参数白名单成员（`constants.py:615-616`，默认值 `None` 见 `constants.py:678-679`），字段类型在 `types/llms/openai.py:1172-1173`（Responses API 请求模型）。即 OpenAI 兼容厂商的缓存键由**用户显式指定字符串**（prompt_cache_key），与 Anthropic 的"内容标记"模式完全不同——LiteLLM 对两套语义都是原样透传、不做翻译。

### 3.4 各厂商 prompt caching 支持矩阵

| 厂商 | 触发方式 | 网关行为 | 证据 |
|---|---|---|---|
| Anthropic | 消息内 `cache_control: {"type":"ephemeral"}` | 透传；无 beta header；usage 拆分 cache_read/creation | `transformation.py:580-586, 1538-1540, 1611-1632` |
| OpenAI 系 | `prompt_cache_key` 参数 | 透传 | `constants.py:615`, `types/llms/openai.py:1172-1173` |
| Gemini/Vertex | 消息内 cache_control（同一 `is_cached_message` 判定） | 由 `vertex_ai/context_caching/` 转换为 cachedContent（本 checkout 未含） | `utils.py:7195-7241`, `llms/gemini/context_caching/README.md:1` |
| Bedrock | 透传路径保留 cache_control | `_add_cache_control_if_applicable`（仅 Claude/Bedrock ARN） | `adapters/transformation.py:289-319` |

通用判定函数 `is_cached_message`（`utils.py:7195-7241`）同时服务 anthropic/gemini 两家的 context caching 转换，可被 `litellm.disable_anthropic_gemini_context_caching_transform` 全局关闭（`utils.py:7203, 7206`）。

### 3.5 成本侧字段

定价目录中 `supports_prompt_caching` 标记 644 个模型（见第四节统计）；Anthropic 的 usage 里还有 `cache_creation` 细分对象（`CacheCreationTokenDetails`：`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`，`types/utils.py:1502-1504`），配合定价目录的 `cache_creation_input_token_cost_above_1hr` 实现"5 分钟/1 小时缓存留存"两档计价（见 `anthropic/chat/transformation.py:2153-2157`）。

---

## 四、模型定价目录 model_prices_and_context_window.json

### 4.1 文件规模与结构

根目录单文件 1.7MB，**2974 个模型 key**（含 `provider/model` 前缀与 region 变体；`bedrock/<region>/` 与 `ft:` 前缀 key 仅用于计价、不进模型清单，`__init__.py:667, 687`）。每个条目的通用结构（JSON 字段统计）：

| 字段 | 出现次数 | 说明 |
|---|---|---|
| `litellm_provider` | 2973 | 归属厂商 |
| `max_input_tokens` | 2555 | 输入窗口上限 |
| `input_cost_per_token` / `output_cost_per_token` | ~2500 | 基础单价（美元/token） |
| `max_tokens` / `max_output_tokens` | ~2490 / 2388 | 输出上限（旧/新字段） |
| `supports_function_calling` | 1717 | 能力位 |
| **`cache_read_input_token_cost`** | **700** | 缓存读单价 |
| **`supports_prompt_caching`** | **644** | 支持 prompt caching 的能力位 |
| **`cache_creation_input_token_cost`** | **233** | 缓存写单价（Anthropic 系） |
| **`cache_creation_input_token_cost_above_1hr`** | **114** | 1 小时以上缓存留存单价 |
| **`prompt_cache_min_tokens`** | **114** | 该模型最小可缓存前缀 |
| `source` | 921 | 定价出处 URL |
| `input_cost_per_token_batches` / `_priority` | ~100 | 批量 / service tier 变体 |

典型条目（从仓库根 JSON 提取）：

- `gpt-4o`：`cache_read_input_token_cost: 1.25e-06`（读缓存约为输入价的 50%）、`cache_read_input_token_cost_priority: 2.125e-06`、`input_cost_per_token_batches: 1.25e-06`（批量半价）、`max_input_tokens: 128000`、`max_output_tokens: 16384`
- `deepseek-chat`：`cache_read_input_token_cost: 2.8e-08`（命中缓存仅 1/10 价格）、`source` 指向官方定价页
- `claude-3-7-sonnet-20250219`：`cache_creation_input_token_cost: 3.75e-06`、`cache_creation_input_token_cost_above_1hr: 6e-06`、`cache_read_input_token_cost: 3e-07`、`deprecation_date: "2026-02-19"`

### 4.2 用途

这张表是**成本、窗口、能力三合一的事实来源**，被四处消费：

1. **成本计算**：`cost_per_token` 内查找（`cost_calculator.py:422` 起，`model_cost_ref = litellm.model_cost`），`get_token_type_cost_breakdown` 直接读 `cache_read_input_token_cost` / `cache_creation_input_token_cost` 分项计价（`cost_calculator.py:2174-2177`）
2. **上下文窗口**：`get_max_tokens` 取 `max_output_tokens` 优先、`max_tokens` 兜底（`utils.py:4784-4843`）
3. **缓存资格**：`prompt_cache_min_tokens`（`utils.py:9066`）
4. **能力路由**：`supports_*` 位（`types/utils.py:138-168` 的 `ProviderSpecificModelInfo` 全是能力位）

类型定义：`ModelInfoBase`（`types/utils.py:191-288`）完整列出 cache 相关字段——`cache_creation_input_token_cost`（含 `_above_200k_tokens` / `_above_1hr` 分档）、`cache_read_input_token_cost`（含 `_flex` / `_priority` / `_above_200k_tokens` / `_above_272k_tokens` / `_above_512k_tokens` 变体，对应 OpenAI service tier 与超长上下文加价）、`prompt_cache_min_tokens`（`types/utils.py:200-213`）。自定义定价的 `CostPerToken` 也带 `cache_read_input_token_cost` / `cache_creation_input_token_cost`（`types/utils.py:122-128`）。

### 4.3 按时间自动更新的机制

```python
# litellm/__init__.py:399-402
model_cost_map_url: str = os.getenv(
    "LITELLM_MODEL_COST_MAP_URL",
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
)
# litellm/__init__.py:511-513
from litellm.litellm_core_utils.get_model_cost_map import get_model_cost_map
model_cost = get_model_cost_map(url=model_cost_map_url)
```

- **启动时拉取**：`get_model_cost_map`（`litellm_core_utils/`，本 checkout 未含）在 import 时按 URL 拉取最新定价（默认为 GitHub main 分支 raw 文件），支持环境变量覆盖
- **本地兜底**：`_get_bundled_model_cost_map`（`utils.py:7551-7557`）以 `lru_cache(maxsize=1)` 读取随包分发的 `litellm/model_prices_and_context_window_backup.json`（checkout 中存在该 backup 文件）——远程失败时回退到打包快照
- **热注册**：`register_model(model_cost)`（`utils.py:2675-2760`）接受 dict 或 URL 二次注册/覆盖；对未入库模型自动从"前缀/region 变体条目"继承缓存价字段（`_CACHE_PRICING_FIELDS`，`utils.py:2722-2736`，缺失缓存价时打 warning 并默认 0）
- **变更失效**：`_invalidate_model_cost_lowercase_map`（`utils.py:4909-4913`）在每次 `model_cost` 变更后重建大小写不敏感索引并清理依赖的 LRU 缓存；配套 `_model_cost_mutation_generation` 单调计数器（`utils.py:4900-4906`）供下游 memoize 失效
- **模型名解析多级兜底**：`_get_model_info_helper`（`utils.py:5223-5312`）按 `provider/model` → `model` → region 变体 → 去版本号 → 去微调后缀 的顺序查找（注释见 `utils.py:5303-5310`）

### 4.4 版本与一致性控制

- 仓库同时维护 `litellm/model_prices_and_context_window_backup.json`（SDK 包内快照）与根目录 `model_prices_and_context_window.json`（GitHub 源），并有 `license_cache.json` 等配套文件
- 测试用 `litellm/model_prices_and_context_window_backup.json` 与 `policy_templates_backup.json` 等 backup 文件保证离线可用

---

## 五、usage 归一化与成本计算

### 5.1 归一化目标

把三家字段统一进一个 `Usage` 结构（`types/utils.py:1573-1696`）：

| 语义 | OpenAI 系 | Anthropic 系 | 归一化后 |
|---|---|---|---|
| 缓存读 | `prompt_tokens_details.cached_tokens` | `usage.cache_read_input_tokens` | `prompt_tokens_details.cached_tokens`（`Usage._cache_read_input_tokens` 私有属性同步） |
| 缓存写 | `prompt_tokens_details.cache_write_tokens`（kimi-k2）或 `cache_creation_tokens` | `usage.cache_creation_input_tokens` | `prompt_tokens_details.cache_creation_tokens` |
| prompt_tokens 语义 | **已包含**缓存 token | **不包含**缓存 token（`input_tokens` 只算非缓存部分） | 统一为"包含" |

### 5.2 Anthropic 响应侧的转换（出方向）

`AnthropicConfig.calculate_usage`（`llms/anthropic/chat/transformation.py:2088-2198`）：

- `prompt_tokens += cache_creation_input_tokens + cache_read_input_tokens`（`transformation.py:2120, 2125, 2128`）——把 Anthropic 的"不含缓存"补成 OpenAI 的"包含"语义
- 多轮迭代（`iterations`）逐轮累加三项（`transformation.py:2115-2120`）
- `raw_input_tokens = prompt_tokens - cache_read - cache_creation`（`transformation.py:2159`）——**非缓存输入 = 总数减缓存两部分**
- 输出 `PromptTokensDetailsWrapper(cached_tokens=..., cache_creation_tokens=..., cache_creation_token_details=...)`（`transformation.py:2160-2165`）
- reasoning 用 `min(估算, completion_tokens)` 钳制（`transformation.py:2167-2174`）

`Usage` 类同时保留原始厂商字段：`cache_creation_input_tokens` / `cache_read_input_tokens` 作为显式字段（`transformation.py:2182-2183`），并从 `prompt_cache_hit_tokens`、`cache_read_input_tokens` 等入参自动回填 `cached_tokens`（`types/utils.py:1648-1668`）。

### 5.3 成本计算侧的归一化（入方向）

`cost_per_token`（`cost_calculator.py:296-417`）的归一化核心（`cost_calculator.py:363-411`）：

```python
## CUSTOM PRICING ##
# Normalize cache token counts across providers:
#   - OpenAI-compatible: usage.prompt_tokens_details.cached_tokens
#     (prompt_tokens already INCLUDES cached_tokens)
#   - Anthropic: usage.cache_read_input_tokens / cache_creation_input_tokens
#     (prompt_tokens does NOT include these — adjust before calling helper)
_cache_read_tokens: float = 0
_cache_creation_tokens: float = 0
_is_anthropic_style = False
...
if _pt_details is not None:
    _cache_read_tokens = float(getattr(_pt_details, "cached_tokens", 0) or 0)
    # OpenAI-compatible providers report cache-write tokens under
    # either `cache_write_tokens` (kimi-k2) or `cache_creation_tokens`.
    _cache_creation_tokens = float(
        getattr(_pt_details, "cache_write_tokens", 0) or getattr(_pt_details, "cache_creation_tokens", 0) or 0
    )
...
# Anthropic reports prompt_tokens as input_tokens (excluding cache tokens).
# Adjust so the helper's "prompt_tokens includes cache tokens" invariant holds.
_normalized_prompt_tokens = float(prompt_tokens)
if _is_anthropic_style:
    _normalized_prompt_tokens += _cache_read_tokens + _cache_creation_tokens
```

（`cost_calculator.py:364-404`，注意行内注释本身即设计文档）

### 5.4 计价公式

`_cost_per_token_custom_pricing_helper`（`cost_calculator.py:180-228`）：

```python
regular_prompt_tokens = max(prompt_tokens - cached_tokens - cache_creation_tokens, 0)
input_cost = (
    regular_prompt_tokens * input_cost_per_token
    + cached_tokens * cache_read_input_token_cost          # 缓存读按读价
    + cache_creation_tokens * cache_creation_input_token_cost  # 缓存写按写价
)
```

内置定价路径同理：`get_token_type_cost_breakdown` 从定价目录取 `cache_read_input_token_cost`（service tier 变体 key 由 `_get_service_tier_cost_key` 解析）与 `cache_creation_input_token_cost`（缺省回退到 `input_cost_per_token`）（`cost_calculator.py:2174-2177`）。

### 5.5 高层调用链

`completion_cost`（`cost_calculator.py:1108-1688`）：

1. 从响应取 usage：`cache_creation_input_tokens = _usage.get(...)`、`cache_read_input_tokens = _usage.get(...)`，并处理 `prompt_tokens_details.cached_tokens` 覆盖（`cost_calculator.py:1273-1284`）
2. 把 Responses API / transcription 的 usage 形状转换为 chat usage（`cost_calculator.py:1254-1269`）
3. 调用 `cost_per_token` 传入 `cache_creation_input_tokens`/`cache_read_input_tokens`/`usage_object`（`cost_calculator.py:1548-1572`）
4. 对 logging 对象存分项 breakdown：`cache_read_cost` / `cache_creation_cost` / `reasoning_cost`（`cost_calculator.py:1640-1675`）
5. 批量任务 `batch_cost_calculator` 显式扣除缓存 token 防重复计费：`base_input_tokens = get_billable_input_tokens(usage) - cache_creation_tokens`，缓存读/写分别半价计费（`cost_calculator.py:2168-2178`）

### 5.6 服务 tier / 区域变体

- `service_tier`（flex/priority）通过 `_get_service_tier_cost_key("cache_read_input_token_cost", ...)` 选择带后缀的价目（`cost_calculator.py:2174`），模型信息从 `optional_params`/响应/hidden_params 逐级提取（`cost_calculator.py:1188-1210, 1293-1301`）
- 数据驻留 uplift：`regional_processing_uplift_multiplier_eu/us`（`types/utils.py:235-240`），应用于批量成本（`cost_calculator.py:2186-2189`）

---

## 六、上下文截断与 max_tokens 处理

### 6.1 max_tokens 钳制

- `get_max_tokens(model)`：优先 `max_output_tokens`，兜底 `max_tokens`；未映射模型抛错并提示去定价目录补录（`utils.py:4784-4843`）
- Anthropic 强制默认值：`get_config` 在 `max_tokens` 缺失时用 `get_max_tokens_for_model(model)` 钳到模型上限，未命中则回退 `DEFAULT_ANTHROPIC_CHAT_MAX_TOKENS = 4096`（`llms/anthropic/chat/transformation.py:280-303`；`constants.py:361`）——**每个请求都有明确的 max_tokens 是 Anthropic 的硬性要求**
- 路由层：`_count_pre_call_check_tokens`（`router.py:10035-10049`）在选路前对 messages/input/instructions 统一计数做上下文窗口预检查

### 6.2 上下文窗口超限的降级路径

- `context_window_fallbacks`（`__init__.py:493`、`types/router.py:81`）——窗口超限时切换到备用模型组
- `DEFAULT_TRIM_RATIO = 0.75`（`constants.py:284-286`）——从 prompt 尾部按比例裁剪的默认值；`utils.py:6840-6863` 有 token 裁剪实现（失败时返回原始消息，非阻塞）
- 内容策略回退 `content_policy_fallbacks`（`__init__.py:494`）
- Anthropic 透传代理还有完整的 context 管理模块（compaction 编辑器等）：`llms/anthropic/experimental_pass_through/context_management/`（`editors/compact.py:725` 注释说明 compaction 摘要模型不需要 cache_control）

---

## 七、会话亲和性与缓存键对齐

### 7.1 部署亲和（session stickiness）

`router.py:1591-1634` 统一挂载 `DeploymentAffinityCheck`（使用 `Router.cache` DualCache）：

- `deployment_affinity`（按 user/key 亲和）、`session_affinity`（按 session_id 亲和）、`responses_api_deployment_check`（Responses API 亲和）三个开关合一（`router.py:1598-1600, 1625-1632`）
- TTL 由 `deployment_affinity_ttl_seconds` 控制（`router.py:1621`）
- 另有 `encrypted_content_affinity`（`router.py:1639-1641`）与 `model_group_affinity_config`
- 开关清单 `OptionalPreCallChecks`（`types/router.py:783-794`）：`prompt_caching` / `router_budget_limiting` / `deployment_affinity` / `session_affinity` / `encrypted_content_affinity` 等

**设计意图**（`exceptions.py:1197` 注释）：同一会话后续请求路由到同一模型/部署，**最大化厂商侧 prompt caching 的命中率**——会话亲和是缓存对齐的手段，而非目的。

### 7.2 其他缓存键对齐手段

- `caching_groups`：跨模型组共享缓存 key（`router.py:305, 369, 618`；`types/router.py:73`），允许"同一提示词在多个部署间共享缓存"
- `preset_cache_key`：调用方自定义 key 语义（`main.py:5039`），典型用法是"同一任务的多次调用共享一个缓存键"
- `DynamicCacheControl.namespace`：命名空间隔离（`types/caching.py:80`）
- 客户端缓存 key 按 `model_id` 稳定复用（`router.py:10010-10032`），避免每次请求重建 HTTP 连接，间接稳定网络路径

---

## 八、缓存命中率统计与 metrics 输出

### 8.1 指标清单

Prometheus 指标（`types/integrations/prometheus.py:247-253`）分两组：

1. **网关自身响应缓存**：`litellm_cache_hits_metric` / `litellm_cache_misses_metric`（命中/未命中计数）、`litellm_cached_tokens_metric`（命中的 token 量）
2. **厂商侧 prompt caching**：`litellm_provider_cache_read_input_tokens_metric` / `litellm_provider_cache_creation_input_tokens_metric`（`types/integrations/prometheus.py:252-253, 707-708`）——label 明确标注"由厂商 usage 填充"（如 Anthropic `cache_read_input_tokens`、OpenAI `prompt_tokens_details.cached_tokens`，`prometheus.py:500-504` 注释）

### 8.2 可观测性设计细节

- 细粒度 token 指标（cached/creation/reasoning/audio）**复用**总 input/output 指标的 label 集（`prometheus.py:505-509`），保证可以按模型/API key/团队做 join
- 只有厂商填充了明细时才发对应序列（`prometheus.py:500-504` 注释"Only emitted when the underlying usage detail is populated by the provider"）
- `litellm_cached_tokens_metric` 单独存在，意味着网关缓存层有独立的 token 级计量（不只是 hit/miss 计数）
- 缓存健康检查 `/cache/ping`（`types/caching.py:92-100`）与 `CachePingResponse` 提供运维可观测性

---

## 九、对我们 crish 的可借鉴点

背景：crish = Rust 内核（`crates/`：session-loop / orchestrator / agent-provider / agent-tools）+ Tauri 壳 + React 前端；`crates/agent-provider` 是多厂商解析层。以下是按优先级排列的可借鉴设计：

### 9.1 建立"模型元数据目录"（最高优先）

- **借鉴**：`model_prices_and_context_window.json` 单文件聚合"单价 + 缓存价 + 窗口 + 能力位"（第四节）；`ModelInfoBase` 类型集中定义（`types/utils.py:191-288`）
- **落地**：`agent-provider` 层增加 `models/catalog`（可先做内存内置表 + 可热更新），字段集：`input/output/cache_read/cache_creation` 单价、`max_input/max_output`、`prompt_cache_min_tokens`、`supports_prompt_caching`。解析层所有"这个模型支不支持 X / 窗口多大 / 缓存多便宜"的判定统一查目录，禁止散落在各 provider 实现里
- **注意**：LiteLLM 连"模型名解析"都做成了多级兜底（`provider/model` → region → 去版本 → 去微调后缀，`utils.py:5223-5312`），crish 的模型别名/路由也应对齐这套解析顺序

### 9.2 usage 归一化照抄"双命名空间 + 不变量"模式

- **借鉴**：`cost_per_token` 的归一化（`cost_calculator.py:363-411`）：先探测是 OpenAI 系（`cached_tokens`，已含缓存）还是 Anthropic 系（`cache_read_input_tokens`，不含缓存），再把后者的 `prompt_tokens` 补齐缓存部分，统一到同一不变量后计价
- **落地**：`agent-provider` 的 `Usage` 结构直接采用 `prompt_tokens`（含缓存）+ `cached_tokens` + `cache_creation_tokens` 三字段；各家解析层只做"厂商字段 → 三字段"映射（含 `cache_write_tokens`/`cache_creation_tokens` 别名兜底，`cost_calculator.py:377-382`）
- **收益**：会话历史中的 token 消耗、成本统计、prompt caching 收益计算三件事共用同一套归一化，避免 crish 各 provider 各自为政

### 9.3 缓存成本要算进"会话成本"里

- **借鉴**：LiteLLM 把缓存读/写按不同单价计入成本（`cost_calculator.py:217-221`），并输出分项 breakdown（`cache_read_cost`/`cache_creation_cost`，`cost_calculator.py:1643-1674`）；批量任务显式防重复计费（`cost_calculator.py:2168-2178`）
- **落地**：crish 的成本模型至少区分"输入/输出/缓存读/缓存写"四类；当用户同一会话多次发送相同前缀时，缓存命中带来的费用下降应真实反映在会话成本曲线里，这是 prompt caching 优化效果的量化基础

### 9.4 prompt caching 采用"透传 + 判定"，且按模型阈值判定

- **借鉴**：cache_control 全链路透传不改写（第三节）；`get_prompt_cache_min_tokens` 三级解析（环境变量 → 模型目录 → 默认值，`utils.py:9050-9071`）；`is_prompt_caching_valid_prompt` 用 token 数做资格判定（`utils.py:9074-9107`）
- **落地**：`agent-provider` 对 Anthropic 请求原样保留 cache_control（消息级/块级/工具级/system 级都要覆盖，参考 `transformation.py:747-761, 1538-1540, 1611-1632`）；对 OpenAI 系透传 `prompt_cache_key`；是否值得缓存由模型目录的 `prompt_cache_min_tokens` 判定，而不是写死 1024
- **收益**：桌面工作台场景下用户反复编辑同一系统提示词/工具定义，"系统提示词带 cache_control + 工具定义带 cache_control"的透传会让用户直观看到成本下降

### 9.5 命中率与成本可观测性分开计量

- **借鉴**：`litellm_cache_hits/misses`（网关缓存）与 `litellm_provider_cache_read_input_tokens`（厂商缓存）分开（`prometheus.py:247-253`），细粒度指标与总量共享 label（`prometheus.py:505-509`）
- **落地**：crish 的会话/成本统计里分两个字段记录：`cache_read_input_tokens`（厂商侧命中）与"本地响应缓存命中数"（如有）；UI 上分别展示"厂商缓存省了多少钱"与"本地缓存省了多少请求"

### 9.6 会话亲和是缓存对齐的手段

- **借鉴**：session 亲和（`router.py:1591-1634`）本质是为提高厂商侧 prompt caching 命中率；`caching_groups` 跨模型组共享缓存 key（`router.py:618`）
- **落地**：crish 在多模型路由/回退时尽量保持同一会话同一模型（模型切换会打断 Anthropic 前缀缓存）；若支持"模型组内切换"，考虑按 `caching_groups` 思想让同组部署共享 prompt_cache_key 语义

### 9.7 目录热更新与兜底

- **借鉴**：URL 拉取 + 打包快照兜底（`__init__.py:399-402`、`utils.py:7551-7557`）、`register_model` 热注册与 cache 价字段继承（`utils.py:2675-2736`）、变更后索引失效（`utils.py:4909-4913`）
- **落地**：crish 的模型目录如果将来要支持"厂商定价更新"，直接采用"内置快照 + 可热替换 + 变更计数"三件套；Rust 侧可用 `Arc<RwLock<Catalog>>` + 版本号让下游缓存按版本失效

### 9.8 需要注意的坑（反模式清单）

- Anthropic 的 `prompt_tokens` 语义与 OpenAI 不同，**任何把两家 usage 直接相加/直接比较的代码都是错的**（必须走 5.3 的归一化）
- Anthropic 缓存读价远低于普通输入价（claude-3-7-sonnet：读 3e-07 vs 写 3.75e-06，约 8%），**把缓存读 token 按输入价计费会高估成本 10 倍以上**——crish 若暂不做缓存价，至少应把缓存读按输入价的常见折扣（如 10%）处理，而不是全价
- `prompt_cache_min_tokens` 是 per-model 的且会变（Anthropic 512~4096），**不要全局写死**
- OpenAI 系缓存写 token 有 `cache_write_tokens`/`cache_creation_tokens` 两种别名，解析时要两个都试（`cost_calculator.py:377-382`）

---

## 附：证据文件索引

| 主题 | 文件 | 关键行 |
|---|---|---|
| 缓存类型枚举 / 调用类型白名单 | `litellm/types/caching.py` | 8-33 |
| 动态缓存控权参数 | `litellm/types/caching.py` | 74-89 |
| 缓存后端导入清单 | `litellm/utils.py` | 399-406 |
| 缓存处理器懒加载 | `litellm/utils.py` | 116-141 |
| 响应缓存开关（网关层） | `litellm/router.py` | 281, 303-305, 479-487 |
| 缓存 key 预设 | `litellm/main.py` | 5039, 5317 |
| TPM/RPM 缓存 key 模板 | `litellm/types/router.py` | 767-771 |
| 客户端缓存 key | `litellm/router.py` | 10009-10033 |
| Redis 客户端工厂 | `litellm/_redis.py` | 539, 561, 655 |
| cache_control 判定 | `litellm/llms/anthropic/common_utils.py` | 108-123 |
| cache_control 透传（参数/系统消息/工具） | `litellm/llms/anthropic/chat/transformation.py` | 580-586, 747-761, 1538-1540, 1611-1632 |
| 缓存资格判定 | `litellm/utils.py` | 9050-9107 |
| 最小缓存前缀常量 | `litellm/constants.py` | 272-283 |
| prompt_cache_key 白名单 | `litellm/constants.py` | 615-616 |
| 定价目录字段类型 | `litellm/types/utils.py` | 191-288 |
| 定价目录加载 | `litellm/__init__.py` | 399-402, 511-513 |
| 定价目录备份兜底 | `litellm/utils.py` | 7551-7557 |
| 模型注册与 cache 价继承 | `litellm/utils.py` | 2675-2736 |
| usage 归一化（入方向） | `litellm/cost_calculator.py` | 363-411 |
| 缓存计价公式 | `litellm/cost_calculator.py` | 180-228 |
| usage 转换（Anthropic 出方向） | `litellm/llms/anthropic/chat/transformation.py` | 2088-2198 |
| 成本 breakdown 输出 | `litellm/cost_calculator.py` | 1640-1675 |
| 批量成本防重复计费 | `litellm/cost_calculator.py` | 2168-2178 |
| max_tokens 钳制 | `litellm/llms/anthropic/chat/transformation.py` | 280-303；`litellm/utils.py` 4784-4843 |
| 会话/部署亲和 | `litellm/router.py` | 1591-1634 |
| 缓存指标 | `litellm/types/integrations/prometheus.py` | 247-253, 500-509 |
| 架构分层总览 | `litellm/ARCHITECTURE.md` | 208-216 |
