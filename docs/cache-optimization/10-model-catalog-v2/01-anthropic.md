# Anthropic（Claude）模型目录与定价 v2

> 「模型目录与定价 v2 专项」R1 调研产物：Anthropic 最新（2026-08）完整模型清单、四指标价格、最低可缓存 token、断点/TTL 规则与特化优化线索。
> 数据获取日期：**2026-08-03**。所有数字均来自下方官方来源 URL，未编造；未获取项明确标注。

## 0. 来源 URL

| 来源                   | URL                                                                                   | 用途                                               |
| ---------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 官方模型总览           | https://docs.anthropic.com/en/docs/about-claude/models/overview                       | 模型清单、上下文窗口、输出上限、能力表             |
| 官方定价页             | https://docs.anthropic.com/en/docs/about-claude/pricing                               | 四指标价格、批量/fast mode/长上下文等附加定价      |
| 官方缓存文档           | https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching                   | 最低可缓存 token、断点/回溯/TTL 规则、失效表       |
| 会话中 system 消息     | https://docs.anthropic.com/en/docs/build-with-claude/mid-conversation-system-messages | 特化优化线索（Opus 4.8 等）                        |
| effort 参数            | https://docs.anthropic.com/en/docs/build-with-claude/effort                           | 特化优化线索（effort 档位与缓存失效）              |
| models.dev（交叉验证） | https://models.dev/                                                                   | 模型 ID/上下文窗口交叉验证（价格未公布，不作价源） |

## 1. 完整模型表（2026-08-03 官方口径，USD/1M tokens）

| 模型                         | API ID                      | 上下文窗口 | 输出上限   | input      | output     | cache_read (0.1x) | cache_write_5m (1.25x) | cache_write_1h (2x) | 最低缓存 | 备注                                                                                                                       |
| ---------------------------- | --------------------------- | ---------- | ---------- | ---------- | ---------- | ----------------- | ---------------------- | ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| Claude Fable 5               | `claude-fable-5`            | 1M         | 128K       | $10        | $50        | $1                | $12.50                 | $20                 | 512      | 最强已公开发布模型；新 tokenizer（同文本约多 30% tokens）；adaptive thinking 常开                                          |
| Claude Mythos 5              | `claude-mythos-5`           | 1M         | 128K       | $10        | $50        | $1                | $12.50                 | $20                 | 512      | 与 Fable 5 同规格同价；limited availability（Project Glasswing，防御性安全，邀请制）                                       |
| Claude Mythos Preview        | `claude-mythos-preview`     | **未获取** | **未获取** | **未获取** | **未获取** | **未获取**        | **未获取**             | **未获取**          | 2048     | 邀请制 preview；新 tokenizer；effort 支持；官方定价页无此行（limited availability）                                        |
| Claude Opus 5                | `claude-opus-5`             | 1M         | 128K       | $5         | $25        | $0.50             | $6.25                  | $10                 | 512      | 官方推荐默认旗舰；支持 fast mode（见 §6.4）；effort 默认 high                                                              |
| Claude Opus 4.8              | `claude-opus-4-8`           | 1M         | 128K       | $5         | $25        | $0.50             | $6.25                  | $10                 | 1024     | **支持会话中 system 更新**（§6.1）；fast mode 支持；effort 默认 high（所有面）                                             |
| Claude Opus 4.7              | `claude-opus-4-7`           | 1M         | 128K       | $5         | $25        | $0.50             | $6.25                  | $10                 | 2048     | 新 tokenizer（4.7 起）；官方建议编码/agentic 从 xhigh effort 起步                                                          |
| Claude Opus 4.6              | `claude-opus-4-6`           | 1M         | 128K       | $5         | $25        | $0.50             | $6.25                  | $10                 | 4096     | 4.6 代起模型 ID 为无日期 pinned snapshot                                                                                   |
| Claude Opus 4.5              | `claude-opus-4-5`（别名）   | 200K       | 64K        | $5         | $25        | $0.50             | $6.25                  | $10                 | 4096     | 唯一「extended-thinking-only 且支持 effort」的模型                                                                         |
| Claude Opus 4.1 (deprecated) | `claude-opus-4-1`（别名）   | 200K       | 32K        | $15        | $75        | $1.50             | $18.75                 | $30                 | 1024     | 已弃用，**2026-08-05 退役**                                                                                                |
| Claude Opus 4 (retired)      | `claude-opus-4-0`（别名）   | **未获取** | **未获取** | $15        | $75        | $1.50             | $18.75                 | $30                 | 1024     | 已退役，仅 Google Cloud 可用；官方总览页不再列窗口                                                                         |
| Claude Sonnet 5（促销价）    | `claude-sonnet-5`           | 1M         | 128K       | $2         | $10        | $0.20             | $2.50                  | $4                  | 1024     | **促销价有效期至 2026-08-31**                                                                                              |
| Claude Sonnet 5（标准价）    | `claude-sonnet-5`           | 1M         | 128K       | $3         | $15        | $0.30             | $3.75                  | $6                  | 1024     | **2026-09-01 起生效**；不支持会话中 system 更新                                                                            |
| Claude Sonnet 4.6            | `claude-sonnet-4-6`         | 1M         | 128K       | $3         | $15        | $0.30             | $3.75                  | $6                  | 1024     |                                                                                                                            |
| Claude Sonnet 4.5            | `claude-sonnet-4-5`（别名） | 200K       | 64K        | $3         | $15        | $0.30             | $3.75                  | $6                  | 1024     |                                                                                                                            |
| Claude Sonnet 4 (retired)    | `claude-sonnet-4-0`（别名） | **未获取** | **未获取** | $3         | $15        | $0.30             | $3.75                  | $6                  | 1024     | 已退役，仅 Bedrock/Google Cloud 可用                                                                                       |
| Claude Haiku 4.5             | `claude-haiku-4-5`（别名）  | 200K       | 64K        | $1         | $5         | $0.10             | $1.25                  | $2                  | 4096     | 支持 extended thinking（`thinking.type:"enabled"`）；**不支持 adaptive thinking 与 effort**                                |
| Claude Haiku 3.5 (retired)   | `claude-3-5-haiku-20241022` | **未获取** | **未获取** | $0.80      | $4         | $0.08             | $1                     | $1.60               | 2048     | 已退役；官方内部口径不一：缓存页写「except on Google Cloud」、定价页写「except on Bedrock and Google Cloud」，以定价页为准 |

共 **16 行在售/可见定价 + 1 行 Mythos Preview（价格未获取）**。

### 1.1 与 00-catalog §1.1 用户 15 行表的核对

- 用户 15 个模型名 = 官方定价页全部 16 个数据行（Sonnet 5 促销/标准双行），**逐行数字全部吻合，零差异**（含价格规律 5m 写 1.25x、1h 写 2x、命中 0.1x）。
- 官方 models overview 无其他「fable/mythos 系列档位」或「opus-5 变体」——Fable 5 与 Mythos 5 同规格同价仅一档；Opus 5 无变体（fast mode 是速度/价格档，不是模型档）。
- **补全项**：Mythos Preview（价格未获取，最低缓存 2048）；Haiku 3.5 最低缓存 2048（00-catalog §1.2 缺该行）；各模型上下文窗口/输出上限；fast mode、batch、长上下文、inference_geo 等附加定价。

## 2. 价格机制（乘数规律）

| 缓存操作            | 乘数             | 说明                                     |
| ------------------- | ---------------- | ---------------------------------------- |
| 5 分钟缓存写入      | 1.25x 基础输入价 | 首次存储时计费                           |
| 1 小时缓存写入      | 2x 基础输入价    | 首次存储时计费                           |
| 缓存命中/刷新（读） | 0.1x 基础输入价  | 后续请求检索计费；命中自动续期、续期免费 |
| 断点本身            | 0                | 增加 `cache_control` 断点不产生任何费用  |

- 盈利点：5m 写入 1.25x，**1 次命中即可回本**（0.1x + 1.25x = 1.35x < 2x 全量处理）；1h 写入 2x，**2 次命中回本**。
- 乘数与 Batch 折扣（50%）、data residency（1.1x）、fast mode 价格**叠加**。
- **长上下文无溢价**：Claude 4.6+ 模型与 Mythos Preview 全 1M 窗口按标准价计费（900k 请求与 9k 请求同 rate），缓存与批量折扣也适用于全窗口。
- **data residency**：4.6+ 模型 `inference_geo:"us"` → 全部 token 类别（输入/输出/写/读）×1.1；更早模型传该参数返回 400。
- **batch**：全模型 50% 折扣（例：Opus 5 批量输入 $2.50、输出 $12.50）。

## 3. 最低可缓存 token（官方缓存文档 cache limitations，全平台一致）

| 最低缓存 | 模型                                                                   |
| -------- | ---------------------------------------------------------------------- |
| 512      | Opus 5、Fable 5、Mythos 5                                              |
| 1024     | Opus 4.8、Sonnet 5、Sonnet 4.6、Sonnet 4.5、Opus 4.1、Opus 4、Sonnet 4 |
| 2048     | Mythos Preview、Opus 4.7、Haiku 3.5                                    |
| 4096     | Opus 4.6、Opus 4.5、Haiku 4.5                                          |

- 不足最低值：**静默不缓存**（不报错）；判据：响应里 `cache_creation_input_tokens` 与 `cache_read_input_tokens` 均为 0 即未缓存。
- 距最低值只差一点时，扩内容到阈值通常划算（命中价远低于未缓存输入价）。

## 4. TTL 与断点规则

- **TTL 两档**：默认 5 分钟（ephemeral，命中刷新免费）；1 小时需显式 `"cache_control": {"type":"ephemeral","ttl":"1h"}`（写入价 2x）。
- **同请求混用 TTL**：1h 条目必须位于 5m 条目**之前**（长 TTL 在前，违反返回 400）。
- **断点上限 4 个**：automatic caching 占用 1 个槽位；4 个显式断点已满再加自动缓存 → 400。
- **回溯窗口 20 块**：从断点起算（断点本身为第 1 个）；每断点最多检查 20 个位置；找不到先前写入的条目即停止。写只发生在断点处、读只找先前写过的条目——**lookback 不找「稳定内容」，只找「先前请求写过的条目」**。
- **前缀顺序**：tools → system → messages（累计哈希；前缀内任一块变更整体失效）。
- **并发注意**：缓存条目在首个响应**开始后**才可用；并行请求想命中需等首个响应发出。
- **失效表（节选）**：工具定义变更 ✘✘✘；web search/citations 开关、speed fast↔标准 ✘✘（失效 system+messages）；tool_choice 变更 ✘（messages）；thinking 参数与 `output_config.effort` 变更 ✘✘✘（渲染进 prompt，模型相关）；images 增减 ✘（messages）。
- **workspace 级隔离**：Claude API / Claude Platform on AWS / Foundry 按 workspace 隔离缓存；Bedrock / Google Cloud 按组织隔离。不同组织/workspace 永不共享。
- **命中要求逐字节精确**（含图片），不保证 100% 命中。

## 5. Automatic vs Explicit caching

| 维度     | Automatic caching                                                                                | Explicit breakpoints                             |
| -------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| 用法     | 请求顶层 `cache_control: {"type":"ephemeral"}`                                                   | 块级 `cache_control`（tools/system/messages 内） |
| 断点位置 | 系统自动放在最后一个可缓存块，随对话增长自动前移                                                 | 用户精确控制                                     |
| 适用     | 多轮对话（历史消息自动缓存）                                                                     | 不同变化频率的静态段（工具定义、system、上下文） |
| 混用     | 可混用；自动断点占 4 槽之一；自动断点需与末块显式断点 TTL 一致，否则 400                         | —                                                |
| 边角     | 末块不可缓存时静默向前找最近可缓存块；无则跳过                                                   | 无自动前移                                       |
| 平台     | **Amazon Bedrock 不支持 automatic caching**（Claude API/AWS Platform/Google Cloud/Foundry 支持） | 全平台                                           |

- 推荐：静态前缀 + 变化后缀的场景，断点放**最后一个跨请求不变的块**（常见陷阱：断点放在带时间戳/每条请求变化的块上 → 永远 miss、每次全价重写）。
- 多轮增长对话：只要每轮新增 < 20 块，末块断点即可持续命中。

## 6. 特化优化线索（成本/缓存相关）

### 6.1 会话中 system 更新（mid-conversation system messages，GA）

- **支持模型**：Claude Fable 5、Mythos 5、Opus 4.8、Opus 5。**Sonnet 5 不支持**（改用顶层 `system` 字段）。
- 语义：向 `messages` 数组**追加** `{"role":"system"}` 消息（字符串或 content 块），新指令从该点起生效，且**不改变缓存前缀哈希**——顶层的 system 字段一改就全量失效，追加则历史全部继续命中。
- 放置规则：必须紧跟 user 轮（含 `tool_result` 的 user 轮算）或「以 server tool result 结尾的 assistant 轮」，且须位于数组末尾或紧接 assistant 轮；在 `tool_use` 与对应 `tool_result` 之间放置返回 400；不能是 messages 首条。
- 与缓存配合：自身也可缓存（下一轮可把断点移过它）；后续指令演化时追加新 system 消息而非改写旧的（改旧的会失效）。
- 典型用途：agentic 循环中途注入状态变化（磁盘文件变化、授权开关、预算告警）、会话中模式切换授予常驻权限、用户中途输入转发。

### 6.2 会话中工具变更（mid-conversation tool changes，beta）

- 需 beta 头 `mid-conversation-tool-changes-2026-07-01`；支持 Fable 5、Mythos 5、Opus 4.8、Opus 5（Claude API/Bedrock/Google Cloud）。
- `tools` 数组全程不变，用 system 消息中的 `tool_addition` / `tool_removal` 块按名称引用工具（`tool_reference` / `mcp_tool_reference` / `mcp_toolset_reference`）——`tools` 位于哈希前缀最前端，此设计保住缓存。
- `defer_loading: true` 可在会话开始时不展示工具，直到 `tool_addition` 出现。

### 6.3 effort 档位（`output_config.effort`，无 beta 头）

- 档位：`max` / `xhigh` / `high`（默认，= 省略参数）/ `medium` / `low`。
- 支持模型：Fable 5、Mythos 5、Opus 5、Opus 4.8、Mythos Preview、Opus 4.7、Opus 4.6、Sonnet 5、Sonnet 4.6、**Opus 4.5**（唯一 extended-thinking-only 支持 effort 的模型）。Haiku 4.5 不支持。
  - `max` 可用：Fable 5 / Mythos 5 / Opus 5 / 4.8 / Mythos Preview / 4.7 / 4.6 / Sonnet 5 / 4.6（4.6 及以后）。
  - `xhigh` 可用：Fable 5 / Mythos 5 / Opus 5 / 4.8 / 4.7 / Sonnet 5。
- **缓存影响（关键）**：effort 被渲染进 prompt，**请求间变更 effort 会失效缓存前缀**——依赖缓存的长会话应从头固定 effort；显式设为模型默认值等价于省略、不失效。
- 默认值：Opus 4.8 全部面（API/Claude Code/claude.ai）为 high；Opus 5 / Sonnet 5 在 API 与 Claude Code 为 high。
- Opus 5 在 xhigh/max 下不可禁用 thinking（`thinking:{"type":"disabled"}` 返回 400）；xhigh/max 运行建议 `max_tokens` 从 64k 起步。

### 6.4 其他

- **adaptive thinking**（Claude 自主决定何时/多深思考）：Fable 5（always on）、Mythos 5、Opus 5/4.8/4.7/4.6、Sonnet 5/4.6 支持；Opus 4.5/4.1、Sonnet 4.5、Haiku 4.5 走 extended thinking（`thinking.type:"enabled"`）轨道，其中 **Haiku 4.5 是唯一支持 extended thinking 的现行轻量模型**。
- **fast mode**（research preview，Claude API 独家）：Opus 5 / Opus 4.8 输出显著加速，**输入 $10、输出 $50**（2x）；缓存乘数在其上叠加；切换 speed 会失效 system/message 缓存；4.7 传 `speed:"fast"` 报错、4.6 静默按标准处理；不可与 Batch 同用。
- **tokenizer 断层**：Opus 4.7+（含 Fable 5、Mythos 5）与 Mythos Preview 用新 tokenizer，**同文本约多 30% tokens**（内容相关）——预算与缓存量估算必须按模型代际计。
- **模型 ID 版本化**：4.6 代起 ID 为无日期 pinned snapshot（如 `claude-opus-4-6`）；更早模型（如 `claude-opus-4-5-20251101`）有日期 ID，别名（`claude-opus-4-5`）是指针。
- **thinking 块缓存**：不能直接标记 `cache_control`，但随历史轮次被缓存、读回时按输入 token 计费；Opus 4.5+ / Sonnet 4.6+ 默认保留历史 thinking 块（缓存有效），更早 Opus/Sonnet 与全部 Haiku 在加入非 tool_result 用户内容时会剥离历史 thinking 块并失效。

## 7. 未获取项（诚实边界）

| 项                                                 | 说明                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Mythos Preview 四指标价格                          | limited availability 邀请制，官方定价页无此行；仅最低缓存 2048 与 tokenizer/effort 支持已确认            |
| Opus 4 / Sonnet 4 / Haiku 3.5 上下文窗口与输出上限 | 已退役，官方总览页不再列出                                                                               |
| Bedrock / Google Cloud 平台价格                    | 官方指引至 AWS/Google 定价页，本次未抓取（注意 Bedrock 有 global/regional 端点 10% 溢价机制，4.5+ 模型） |
| Fable 5 / Mythos 5 系列其他档位                    | **不存在**（官方仅各一档；Mythos 5 与 Fable 5 同规格同价）                                               |
| 每模型 API 限速（TPM/RPM）                         | 属 rate limits 文档域，本次未抓                                                                          |
| models.dev 上的 Anthropic 价格                     | models.dev 对 Anthropic 模型价格列为 $0.00（未公布），仅用于 ID/窗口/能力交叉验证，不作价源              |

## 8. crish 落地的关键提示（数据面）

1. **Sonnet 5 双价区间**：2026-08-31 前 $2/$10，2026-09-01 起 $3/$15（写价同步 1.25x/2x），成本计算必须带日期切换。
2. **Opus 4.1 退役**：2026-08-05 后不可用，若目录含该条目需标记 deprecation。
3. **每模型最低缓存档（512/1024/2048/4096）** 是成本计算的最低拦截线：低于阈值的断点不生效也不报错，容易造成「以为在缓存、实际全价」的静默浪费。
4. **1h 缓存 2x 写入**：仅「命中间隔 5m~1h」或「长会话跨 5m」场景值得；5m 内高频复用一律用 5m（续期免费）。
5. **effort/thinking 变更失效缓存**：长会话缓存策略需把 effort 视为请求级常量。
6. **新 tokenizer 30% 膨胀**：Fable 5 / Opus 4.7+ / Sonnet 5 等模型的 token 预算不能照搬旧模型经验值。
