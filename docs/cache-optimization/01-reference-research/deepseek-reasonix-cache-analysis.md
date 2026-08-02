# DeepSeek-Reasonix 缓存优化调研分析

> 调研对象：`reference/DeepSeek-Reasonix`（Go 项目，AI coding agent，下文简称 Reasonix）
> 文档性质：参考代码库缓存优化手段的核实与整理，供 crish 借鉴
> 核实方式：逐条对照源码文件路径:行号（2026-08 实读核实，行号若与调研初稿有出入，以本文件标注的为准）

---

## 1. 总体架构

Reasonix 的缓存策略可以概括为一句话：**本地不做任何 LLM 响应级缓存，全靠 LLM 服务端的 context cache（DeepSeek 自动前缀缓存 / Anthropic ephemeral cache_control），而本地的全部工程努力都投向"让服务端缓存尽可能命中"**。

- 客户端每轮请求都**重发完整的历史消息**（`internal/provider/openai/openai.go` 的 `buildRequest` 无条件序列化全部 `req.Messages`，无本地截断缓存），服务端按"前缀字节相同则命中"的规则结算。
- 因此本地唯一的优化目标是：**前缀字节稳定 + 会话 append-only 增长**。任何会改写历史消息的操作（compaction、记忆变更、工具结果裁剪）都必须是一次"刻意、低频的 cache-reset 点"，而不是常态行为。
- 两个传输协议各有对应机制：
  - **DeepSeek（OpenAI 兼容端点）**：服务端自动做前缀缓存，客户端**必须完全省略** `cache_control` 字段（官方端点会忽略它，发出去反而有害）。
  - **Anthropic（Messages API）**：客户端用 `cache_control: {type: "ephemeral"}` 显式声明缓存断点，最多 4 个断点，Reasonix 只用 ≤2 个。

设计哲学在代码注释中有直接表述（`internal/agent/compact.go:19-23`）：

> "Compaction is a low-frequency cache-reset point: the prompt grows append-only (high cache hits) until a turn nears compactRatio of the window, then it is compacted down to a tail budget."

以及 `docs/SPEC.md:318-321`：

> "This is the **only** point where the prompt prefix changes — a deliberate, rare 'cache-reset point'. Between compactions the session grows prepend-only and stays cache-friendly, so cache hit rate (the key observability signal) stays high."

---

## 2. 优化手段清单（含文件:行号）

| # | 手段 | 关键位置 |
|---|------|---------|
| 1 | 前缀 append-only 设计 + 低频压缩（cache-reset point） | `internal/agent/compact.go:19-36`、`docs/SPEC.md:242-321` |
| 2 | 记忆折叠进 system 前缀一次、中途不碰前缀 | `internal/memory/doc.go:9-13`、`internal/memory/memory.go:175-188` |
| 3 | 双模型分离 session 防前缀破坏 | `docs/SPEC.md:201-240` |
| 4 | 前缀形状哈希诊断（CaptureShape/CompareShape） | `internal/agent/cache_shape.go:36-94` |
| 5 | 门禁不破坏成功路径前缀的回归测试 | `internal/recovery/cache_shape_test.go:18-61` |
| 6 | e2e 缓存命中率测试套件（无压缩/病态窗口/成本对比/聚合） | `internal/agent/cachehit_e2e_test.go:154-477` |
| 7 | Anthropic cache_control 断点放置（tools→system→messages） | `internal/provider/anthropic/anthropic.go:377-395` |
| 8 | DeepSeek 完全省略 cache_control（含测试钉死） | `internal/provider/anthropic/anthropic.go:384`、`internal/provider/anthropic/anthropic_test.go:452-461` |
| 9 | reasoning_content 回放（tool_calls turn 总是发该 key） | `internal/provider/openai/openai.go:658-680` |
| 10 | reasoning 回放策略接口（provider 能力协商） | `internal/provider/provider.go:734-764` |
| 11 | usage 归一化（三形状 → 统一 Usage） | `internal/provider/openai/openai.go:1030-1083`、`internal/provider/provider.go:587-595` |
| 12 | 断流重连（缓存下重放便宜） | `internal/provider/openai/openai.go:576-611` |
| 13 | DeepSeek Beta 前缀续写（/beta/chat/completions + prefix:true + mergeUsage） | `internal/provider/openai/openai.go:478-549`、`internal/provider/openai/host.go:45-58` |
| 14 | compaction 分级（soft 0.5 / snip 0.6 / compact 0.8 / force 0.9） | `internal/agent/compact.go:24-147` |
| 15 | 工具结果先截断后裁剪（Snip/PruneStaleToolResults） | `internal/agent/prune.go:35-47`、`internal/agent/compact.go:100-130` |
| 16 | compactStuck 锁存防每轮重写前缀 | `internal/agent/compact.go:116-118,140-146` |
| 17 | 记忆自动召回尾部注入（<memory-recall> 块） | `internal/memory/auto_recall.go:16-28,411-444`、`docs/SPEC.md:287-291` |
| 18 | 缓存计费（hit×cache_hit + miss×input + output） | `internal/provider/provider.go:607-621`、`internal/provider/resolver.go:17` |
| 19 | 真实 API 探测测试（live tag + env 门控） | `internal/provider/openai/realcache_test.go:33-175`、`internal/provider/anthropic/realdeepseek_test.go:19-79` |
| 20 | sync.Pool 请求体缓冲池 | `internal/provider/openai/openai.go:422-424`、`internal/provider/anthropic/anthropic.go:246-248` |
| 21 | 会话列表 .jsonl.meta sidecar 免解码 | `internal/agent/branch.go:376-395,427-451`、`internal/agent/listsessions_bench_test.go:43-70` |

---

## 3. 每个手段解决的问题与效果

### 3.1 前缀 append-only + 低频压缩（手段 1）

**问题**：服务端前缀缓存按"字节相同"结算。若每轮随意改写历史（比如每轮重写 system prompt、或把中间消息重排），缓存每轮全 miss，输入 token 成本回到全价。

**方案**：把"改写前缀"收敛为唯一的、低频的 compaction 动作，且 compaction 本身也被分级、被经济学检查、被锁存防循环（见 3.6）。其余一切操作（记忆、召回、工具结果维护）都设计为"绝不触碰稳定前缀"。

**效果**：e2e 测试证明无压缩路径前缀逐轮字节稳定（`cachehit_e2e_test.go:154-189`，逐请求断言 `hitChars[i] == reqChars[i-1]`，即第 i 轮的命中前缀等于第 i-1 轮完整请求）；命中率曲线随历史增长自然爬升（`cachehit_e2e_test.go:194-223`，14 轮后峰值 ≥90%，见 5.1）。

### 3.2 记忆折叠进前缀一次（手段 2）

**问题**：持久记忆（REASONIX.md / AGENTS.md / 自动记忆库）若在会话中途被当作消息追加或重发，会污染稳定前缀；而若每次会话都重新拼装 memory 块，块内容变化会导致整个前缀 hash 变化。

**方案**（`internal/memory/doc.go:9-13` + `internal/memory/memory.go:175-188`）：

- 所有记忆在**启动时一次性**折叠进 system prompt（`Compose`），此后该前缀在会话内不变。
- `Compose` 的拼接顺序：**base（最稳定的文本）永远在最前，memory 块跟在后面**——这样即使 memory 跨会话变化，base 部分仍然是合法的缓存前缀，最多损失 memory 段之后的命中（`memory.go:176-177`："Base stays first (it is the most stable text, so it remains a valid cache prefix even when memory changes between sessions)"）。
- 会话中途的记忆变更（`WriteDoc` 等）**立即落盘但不改前缀**，通过 controller 的"turn-tail 临时注入"生效，下个会话才折叠进前缀（`memory.go:112-117`）。
- 无记忆时 `Compose` 原样返回 base，保证字节不变（`memory.go:86-88` 的 `Empty` + `179-188`）。

**效果**：记忆以零每轮成本搭 DeepSeek 自动前缀缓存的车（doc.go:10-11 原文："so it rides DeepSeek's automatic prefix cache at zero per-turn cost"）。

### 3.3 双模型分离 session（手段 3）

**问题**：Reasonix 的协调器（Coordinator）跑两个模型（executor + planner）。若两个模型共享一个会话，各自的回合会互相插入消息，任何一方的前缀都会被对方破坏，缓存命中率双双暴跌。

**方案**（`docs/SPEC.md:201-240`）：每个模型持有**独立 session**，各自 append-only 增长。SPEC 原文："The sessions never mix, so neither model's prefix is disturbed by the other's turns; both grow prepend-only and stay cache-friendly. This reconciles 'cache-first' with 'two-model collaboration': switching models *inside one shared conversation* would break the prefix and tank cache hits, so we don't."（`SPEC.md:237-240`）

**效果**：多模型协作不牺牲缓存；每个模型的前缀在其自己的 session 内保持稳定。

### 3.4 前缀形状哈希诊断（手段 4、5）

**问题**：缓存 miss 时无法快速回答"为什么 miss"——是 system prompt 变了、工具 schema 变了，还是别的？

**方案**（`internal/agent/cache_shape.go`）：

- `PrefixShape` 记录四组指纹：`SystemHash`、`ToolsHash`（schema 排序归一化后哈希）、`PrefixHash`（system+tools 联合哈希）、`LogRewriteVersion`（日志重写版本号），外加 `ToolSchemaTokens` 估算（`cache_shape.go:16-49`）。
- `CaptureShape` 在回合间快照前缀状态；`CompareShape` 对比前后快照，输出 `PrefixChanged` + `PrefixChangeReasons`（"system" / "tools" / "log_rewrite"），并与当轮 usage 的 hit/miss 关联（`cache_shape.go:67-94`）。
- 配套回归测试 `TestRecoveryWiringPreservesSuccessPathCacheShape`（`internal/recovery/cache_shape_test.go:18-61`）：钉死"启用 Auto Guard（失败自愈门禁）**不得改变成功路径**的 system prompt 或工具 schema"——只允许失败路径的动态 user-tail 和独立 reviewer session 增加 token。baseline 与 with-recovery 的 `SystemHash/ToolsHash/PrefixHash` 逐一断言相等。

**效果**：缓存 miss 从"玄学"变成可诊断；任何新功能引入前缀变化都会被门禁测试抓住。

### 3.5 Anthropic cache_control 断点（手段 7、8）

**问题**：Anthropic 不自动缓存，需要显式声明 `cache_control: {"type": "ephemeral"}`，且最多 4 个断点；断点放错位置会导致缓存段无法复用。

**方案**（`internal/provider/anthropic/anthropic.go:377-395`，注释即规范）：

- 渲染顺序为 tools → system → messages。断点放置规则：
  1. **有 system** → 在最后一个 system block 上打点（同时缓存 tools+system，因为它们物理上相邻且 tools 在 system 之前）；
  2. **无 system** → 在最后一个 tool 上打点；
  3. **最后一条消息的最后一个 block** 上也打点——这会缓存整个会话前缀，随轮次追加而增量命中（每次请求最后一条消息不同，但前面的部分都被缓存）。
- 总断点数 ≤2（上限 4），因为第一个断点已经覆盖 tools+system，无需在中间重复。
- **DeepSeek 分支完全省略 cache_control**：`if !c.deepseek { ... }` 包裹整个打点逻辑（`anthropic.go:384`）。注释（377-379）明确："DeepSeek ignores cache_control and manages prefix caching automatically, so keep those fields off its wire entirely."
- 测试钉死（`anthropic_test.go:452-461`）：DeepSeek 请求的 system/tools/messages 任意 block 出现 cache_control 即测试失败。

**效果**：Anthropic 端点拿到稳定断点复用；DeepSeek 端点请求体保持最小、不被无意义字段污染（字段本身也可能改变字节布局）。

### 3.6 reasoning_content 回放（手段 9、10）

**问题**（`internal/provider/openai/openai.go:658-668` 注释）：DeepSeek thinking 模式下，assistant tool_calls 回合**缺少 `reasoning_content` key 会直接 400**（"reasoning_content … must be passed back"）。而 reasoning 文本每轮回放会增大 miss 输入，拖低命中率（见 5.3 成本量化）。

**方案**：

- **总是发送该 key**：对 DeepSeek 且 `len(ToolCalls) > 0` 的 assistant 消息，无条件发送 `reasoning_content` 字段，**空串也发**（pointer 序列化保证 key 存在值为 ""）——API 接受空串，比上游丢失 reasoning 后直接 400 强（`openai.go:669-680`、`openai.go:1161-1165` 的 `ReasoningContent *string` 字段注释）。
- **thinking disabled 时保持精确旧字节**：`thinking.type=disabled` 时 API 容忍任何形状，此时只在该轮历史确实留有 reasoning 时才发 key（"dropping it would invalidate the prompt-cache prefix of mixed thinking-on→off sessions for no gain"，`openai.go:664-668`）——即**不为了"更规范"而改变线上字节**，字节稳定性优先于整洁。
- 策略接口：`ToolCallReasoningPolicy`（`provider.go:734-736`）与 `ReasoningRoundTripPolicy`（`provider.go:748-754`）由 provider 按需实现；agent 侧据此决定是否归档原始 reasoning、是否告警缺失（`provider.go:726-746`）。DeepSeek 实现前者（`openai.go:281-283`），Kimi K3 实现后者（`openai.go:285-287`）。
- Anthropic 侧对应实现：DeepSeek Anthropic 端点用 **unsigned** thinking 块回放（`anthropic.go:341-350`），与 Anthropic 官方的 signed 回放（`ReasoningSignature`）区分；真实 API 契约由 `realdeepseek_test.go` 验证（见 5.4）。

**效果**：thinking 模式的 tool loop 不 400、不丢思维链上下文；代价（每轮多回放一份 reasoning 的 miss token）被显式量化并接受——`TestReasoningRoundTripCost`（`cachehit_e2e_test.go:282-319`）对比 with/without round-trip 的命中率曲线，报告每轮差异与到达 90% 所需轮数。

### 3.7 usage 归一化（手段 11）

**问题**：三种兼容端点返回三种完全不同的 usage 缓存字段形状，下游（命中率显示、计费）需要统一口径。

**方案**（`internal/provider/openai/openai.go:1030-1083`，`normaliseUsage`）：

- **DeepSeek 形状**：顶层 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`。
- **OpenAI/MiMo 形状**：嵌套 `prompt_tokens_details.cached_tokens`。
- **Anthropic 兼容形状**：`input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`（此时 `prompt = input + cache_read + cache_creation`，因为 Anthropic 的 input_tokens 本身不含缓存读写；`cache_creation` 对计费口径按未缓存输入计入 miss，`openai.go:1037-1070`）。
- 统一落到 `provider.Usage{CacheHitTokens, CacheMissTokens, ...}`（`provider.go:587-595`，`FinishReason` 也一起带出供 agent 识别 length/content_filter 等异常终止）。

**效果**：命中率显示（`hit/(hit+miss)`，`cachehit_e2e_test.go:129-139`）与计费对所有端点口径一致。

### 3.8 断流重连与 Beta 前缀续写（手段 12、13）

**问题**：
1. SSE 流中途断线（半开连接）会让整轮白费；重发请求在无缓存时成本高。
2. DeepSeek 官方 API 有输出长度上限（`finish_reason=length`），长输出被截断后用户拿不到完整结果。

**方案**：

1. **断流重连**（`openai.go:576-611`）：`maxStreamReconnects = 3`，连接在**尚未发出任何模型输出**前断开则整请求重放（注释原文："each replay re-runs the whole request (cheap under prompt caching, but not free)"，`openai.go:578-579`）；一旦已有输出则立即报 `StreamInterruptedError`，避免重复输出。另有 120s 空闲看门狗（`openai.go:48`、`openai.go:822-854`）把半开连接变成可恢复错误。
2. **Beta 前缀续写**（`openai.go:478-549`）：当 `finish_reason=length` 且未产生 tool call 时，自动向官方 Beta 端点 `/beta/chat/completions` 发起 `prefix: true` 的续写请求——把已生成的文本+reasoning 作为 assistant 前缀消息（`buildPrefixRequest`，`openai.go:798-806`），服务端在其后继续生成。两个请求的 usage 用 `mergeUsage` 合并（`openai.go:558-574`），对上层看起来就是一个普通流。续写上限 `maxPrefixContinuations = 1`（`openai.go:53`），防止无界（且计费）的续写循环。
3. **仅官方端点启用**（`host.go:41-58`）：`deepSeekPrefixChatURL` 只有在 chatURL 是官方 `api.deepseek.com`（或 `*.deepseek.com` 子域）时才派生 Beta 地址；自定义网关即使借用 DeepSeek 的 reasoning 线形，也绝不能被自动请求打到厂商直连 API（`host.go:42-44`）。

**效果**：弱网下整轮不白费（缓存让重放便宜）；长输出自动续写补齐，且 usage/计费口径不受影响。

### 3.9 compaction 分级（手段 14、15、16）

**问题**：一次压缩 = 一次缓存重置。压缩太频繁则命中率崩溃；压缩太激进（动第一轮用户事实）则丢信息；窗口太小还会出现"每轮都压、每轮都破缓存"的循环。

**方案**（`internal/agent/compact.go:24-36` 常量 + `maybeCompact` 决策链，`compact.go:85-147`）：

| 阈值（窗口占比） | 常量 | 动作 |
|---|---|---|
| 0.5 | `defaultSoftCompactRatio` | 只发一次 Notice 通知"上下文在增长"，**不压缩**（保住缓存前缀） |
| 0.6 | `defaultToolResultSnipRatio` | `SnipStaleToolResults`：对 recent tail 之前的陈旧工具结果做**确定性截断**（带 head/tail 标记，存档原文），不调总结模型 |
| 0.8 | `defaultCompactRatio` | 先 `PruneStaleToolResults`（裁剪为更短的占位符）；若裁剪后已低于阈值则**跳过付费的 summarize 调用**；否则执行总结式压缩 |
| 0.9 | `defaultCompactForceRatio` | 强制压缩：即使 fold 经济学（`foldEconomics`，收益 <400 token 就不值得调 summarize，`compact.go:149-156`）不通过也执行 |

配套约束（SPEC.md:245-262 与 compact.go）：

- 压缩只折叠 assistant/tool 工作；**每个小 user turn 和每个既有 digest 逐字保留**（`partitionFold`，`compact.go:451-465`），用户陈述的事实永不"被总结没"。
- 裁剪永不删消息，tool_calls/tool_result 配对不受影响（`prune.go:11-14`："the free half of context management"——工具结果可重新派生，重写它们不需要 summarize 调用）。
- **compactStuck 锁存**（`compact.go:116-118, 140-146`）：连续两次压缩后仍高于阈值（说明"system prompt + 一轮对话"本身就超出窗口），则暂停自动压缩并发 Notice 解释原因，直到 prompt 自然降下来。这是"病态小窗口每轮重写前缀"的直接防线。
- 尾部预算：保留的 recent tail 是**固定 token 预算**（默认 16384，且不超过窗口 50%），不是固定条数——几个大工具输出不能把尾部顶在阈值上每轮触发压缩（`compact.go:566-579`）。
- 压缩边界向后退对齐，尾部绝不以孤儿 tool 消息开头（`tailStart`，`compact.go:604-627`）。

**效果**：常态下完全不碰前缀；缓存重置是"稀有、刻意、带经济学检查"的事件；病态配置下锁存兜底，命中率恢复（见 5.2）。

### 3.10 记忆自动召回尾部注入（手段 17）

**问题**：相关记忆（全局偏好、项目事实）每轮全量塞进前缀会膨胀前缀且难以维护；不放则模型不知道历史事实。

**方案**（`internal/memory/auto_recall.go` + `docs/SPEC.md:287-291`）：

- 每轮真实 user turn 前，用 BM25 从自动记忆库召回相关事实，组装 `<memory-recall>…</memory-recall>` 块**追加到该轮 user turn 尾部**（`auto_recall.go:411-444` 的 `buildRecallBlock`）。
- 预算：**默认最多 4 条 / 2400 字符 / 单条 snippet 520 rune**（`auto_recall.go:16-21`）；generic 提问（"继续"、"好的"等）不召回；陈旧事实降权；项目事实覆盖全局等价事实（`auto_recall.go:250-258, 187-193, 77-114`）。
- 关键：块在 **user turn 尾部**而非 system 前缀——"This never mutates the stable system prompt or tool schemas"（`SPEC.md:291`）。它只构成每轮新增的后缀字节，前缀缓存完全不受影响。

**效果**：召回的事实以"低权威背景"姿态进入上下文（preamble 明示可能过期、不得覆盖当前请求），且不污染缓存前缀；错过/超预算的事实被显式计数（`Omitted`）。

### 3.11 缓存计费（手段 18）

**方案**（`internal/provider/provider.go:607-621`）：

```go
cost = (hit * p.CacheHit + miss * p.Input + completion * p.Output) / 1e6
```

- 兜底：`hit+miss == 0` 时按 `prompt` 全量计 miss；`miss == 0 && hit < prompt` 时差值补 miss（`provider.go:611-617`）。
- `Pricing` 三费率字段（CacheHit/Input/Output）+ 币种显示（`provider.go:599-604`）；`CacheHitPerMillion` 等费率经 `provider.Descriptor` 跨远程工作台传递（`internal/provider/resolver.go:17`）。
- Anthropic 端口的 usage 组装同口径：`CacheMissTokens = input + cache_creation`（"uncached input + cache writes (billed ≥1×)"，`anthropic.go:631-637`）。

**效果**：无论端点返回哪种缓存字段形状，计费都按"命中 token 打 cache 折扣价、写入 token 全价、输出全价"统一估算，命中率显示（`hit/(hit+miss)`）与账单同源。

### 3.12 工程优化（手段 20、21）

- **sync.Pool 请求体缓冲池**（`openai.go:422-424`）：每轮序列化请求体后把 buffer 还池，避免 10-100KB 级别的反复分配 GC 抖动；provider 级而非全局（OpenAI 与 Anthropic 各自独立，互不竞争）。Anthropic 侧同样实现（`anthropic.go:246-248`）。
- **会话列表 .jsonl.meta sidecar**（`internal/agent/branch.go:376-395, 427-451`）：会话列表界面需要的字段（model、preview、turn 数、自定义标题）写入每个会话文件旁的 `.jsonl.meta` sidecar；列会话时 `LoadBranchMeta` 只读 sidecar，**不必解码整个 .jsonl 正文**（`branch.go:427-428` 注释："the sidebar and pickers read without decoding the .jsonl"）。基准测试 `listsessions_bench_test.go:43-70` 实测 warm（sidecar）路径比 cold（整文件解码）快约 2-3 个数量级。

---

## 4. DeepSeek 特有适配（专题）

以下约束是 DeepSeek 官方端点独有、crish 若接 DeepSeek 必须照做的：

1. **省略 cache_control**：DeepSeek 自动管理前缀缓存，`cache_control` 字段在 Anthropic 兼容端点也会被忽略；Reasonix 在 anthropic 与 openai 两条 provider 路径上都对 DeepSeek 完全省略（`anthropic.go:384`、`anthropic_test.go:452-461`）。多写字段既无收益又可能改变请求字节。
2. **tool_calls 回合必须回放 reasoning_content key**（thinking 模式下缺 key 400）：永远发送（空串兜底），且 thinking disabled 时只保留历史已有的字节形状（`openai.go:658-680`）。
3. **自动前缀缓存按 64-token 块粒度结算**：`realcache_test.go:90-93` 的探测头刻意超过 64 token 块，保证命中判定无歧义。
4. **前缀续写 Beta 端点**：`/beta/chat/completions` + `prefix: true` 仅对官方 `api.deepseek.com` 启用（`host.go:45-58`），自定义网关绝不自动打到厂商直连（防绕过网关鉴权/计费）。
5. **thinking 控制线形**：DeepSeek 用 `thinking.type` + `reasoning_effort`（深度提示）双字段；`effort=disabled` 路由到 `thinking.type=disabled`（`openai.go:121-141, 744-752`）。
6. **字符串 content 约束**：官方端点只接受字符串消息 content（`openai.go:91-96`），vision 默认关闭（模型级显式 opt-in 才开）。
7. **reasoning 回放成本是"放大器"**：tool loop 中每轮回放的 reasoning 计入 miss 输入，直接压低命中率曲线（`cachehit_e2e_test.go:282-319`）——这是 DeepSeek thinking 模式下缓存收益的天花板来源，需接受并在 UI 上如实显示。

---

## 5. 测试与数据

### 5.1 无压缩路径：前缀字节稳定 + 命中率自然爬升

- `TestCacheHitPrefixStable`（`cachehit_e2e_test.go:154-189`）：mock DeepSeek 端点按"与前一次会话请求的字节相同前缀"推导 hit token；逐请求断言 `hitChars[i] == reqChars[i-1]`（第 i 轮命中前缀 = 第 i-1 轮完整请求），同时断言 `hit + miss == prompt`（显示口径数学正确）。
- `TestCacheHitClimbsWithoutCompaction`（`cachehit_e2e_test.go:194-223`）：14 轮无压缩对话，命中率逐轮爬升，**峰值 ≥90%**（注意：`peak < 90` 在该测试里是 `t.Logf` NOTE 提示而非失败断言，见 219-222 行；硬性门禁在 `TestReleaseCacheHitGuard`）。
- `TestReleaseCacheHitGuard`（`cachehit_e2e_test.go:378-477`）：发布门禁，8 个场景（对话/长对话/混合长度/工具循环/有无 reasoning 组合），默认阈值 90%（`REASONIX_CACHE_GUARD_THRESHOLD`）、取尾部 3 轮均值，允许 1 个低分场景（`REASONIX_CACHE_GUARD_MAX_LOW_CASES`），`REASONIX_CACHE_GUARD_STRICT=1` 时硬失败。

### 5.2 病态小窗口：锁存兜底，命中率恢复

- `TestCacheHitSurvivesTooSmallWindow`（`cachehit_e2e_test.go:231-276`）：900-token 病态窗口 + 30 轮工具循环。断言：
  - 命中率崩塌次数 **≤2**（`collapses > 2` 即失败，263-265 行）——即锁存把"每轮重写前缀"压成"至多两三次";
  - 出现 "Automatic context cleanup paused" 通知（266-268 行）;
  - 锁存生效后前缀恢复 append-only，**尾部 5 轮平均命中率 ≥85%**（271-275 行）。

### 5.3 reasoning 回放成本量化

- `TestReasoningRoundTripCost`（`cachehit_e2e_test.go:282-319`）：同一 mock 下对比 with/without reasoning round-trip 两条命中率曲线，报告每轮 delta 与到达 90% 所需轮数差异。真实 API 侧（`realcache_test.go:125-174`，Probe 2）：`prompt_tokens 回放成本 = p2withR.prompt - p2noR.prompt`（173 行）。

### 5.4 真实 API 探测（build tag `live` + env 门控）

- `internal/provider/openai/realcache_test.go`（`TestRealDeepSeekCacheProbe`，33 行）：直接打 `https://api.deepseek.com`（deepseek-v4-flash）。三个探测：
  1. **重复前缀是否有命中**：大稳定头 + 两次相同请求，中间 `time.Sleep(3 * time.Second)` 等异步缓存填充（104、161 行）；64-token 块粒度感知（90-93 行）。
  2. **v4-flash 是否真的返回 reasoning_content**（117-123 行）——确认回放放大器是否真实存在。
  3. **tool-call reasoning 回放的成本与缓存兼容**：带/不带 reasoning 的两条历史分别 warm 后测量，命中率与回放成本（173 行）。
- `internal/provider/anthropic/realdeepseek_test.go`（`TestRealDeepSeekAnthropicToolLoop`，19 行）：验证 DeepSeek Anthropic 端点（`https://api.deepseek.com/anthropic`）的 **unsigned thinking 回放契约**——第一轮必须产出可回放的 reasoning，第二轮带 reasoning 回放必须成功且记录 cache_hit。

---

## 6. 对我们 crish 的可借鉴点

### 原则层

1. **缓存优先级排序**：把"服务端前缀缓存命中"作为第一级优化目标，本地缓存（如果有）只做第二级。Reasonix 的收益模式是"免费、自动、无需管理"的，且所有成本优化（compaction、recall、snip）都围绕"少写前缀、少改前缀"展开。
2. **把"改写前缀"收敛成唯一的低频事件**：任何会改写历史的操作（压缩、剪枝、记忆变更）都必须过一道"这是 cache-reset 点吗？值得吗？"的闸门。Reasonix 的对应物：soft 通知 → snip → prune → compact 分级 + fold 经济学 + compactStuck 锁存。
3. **字节稳定优先于"整洁"**：thinking disabled 时宁可发"不必要"的 reasoning_content key 也不改变历史字节（`openai.go:664-668`）；空串兜底保证 key 存在。凡是"线上字节不变"与"代码更漂亮"冲突，选前者。

### 机制层（可直接抄的组件级设计）

4. **前缀形状哈希 + 门禁测试**：`CaptureShape/CompareShape` 把"前缀为什么变"变成可诊断输出；配套测试钉死"新功能不得改变成功路径前缀"。crish 若做 compaction/记忆/恢复功能，应先建这套哈希与门禁。
5. **usage 三形状归一化**：DeepSeek 顶层 / OpenAI 嵌套 / Anthropic 兼容三套字段统一进一个 `Usage{CacheHitTokens, CacheMissTokens}`，命中率显示与计费同源。crish 的 session 状态行、计费模块都应基于同一口径。
6. **compaction 分级 + 免费裁剪优先**：先做不花钱的（工具结果 snip/prune，确定性、无 summarize 调用），再做付费的（总结式压缩）；且"裁剪后已低于阈值就跳过付费调用"。尾部预算按 token 而非条数，防大输出顶高阈值造成每轮压缩循环。
7. **病态配置锁存**：连续两次压缩无效就暂停自动压缩并告知用户（窗口太小、system+一轮已超窗口），而不是无限循环。
8. **断流重连基于缓存便宜性**：`maxStreamReconnects=3`、零输出前可重放。接 DeepSeek 的 crish 可直接采用该策略与 120s 空闲看门狗。
9. **Beta 前缀续写**：DeepSeek 官方端点 `finish_reason=length` 时自动走 `/beta/chat/completions` + `prefix:true` 续写，usage 合并、上限 1 次、仅官方域名启用。若 crish 计划支持超长输出，这是官方唯一干净的解。
10. **记忆折叠一次 + 召回尾部注入**：持久记忆进 system 前缀（base 在前、memory 在后，保证跨会话变化只损失部分命中）；会话内变更走尾部注入；相关事实用 `<memory-recall>` 块按预算（条数/字符/rune）追加到 user turn 尾部。crish 的 memory 功能可直接复用此分层。
11. **会话列表 sidecar**：`.jsonl.meta` 免解码列出 model/preview/turns/标题。crish 已有 session JSONL 存储，加 sidecar 是低成本高收益的列表优化。
12. **sync.Pool 请求体缓冲**：低成本 GC 优化，两条 provider 路径都在用。
13. **真实 API 探测测试**：live tag + env 门控 + 3 秒异步填充等待 + 64-token 块粒度意识——CI 不花钱、需要时一键真实验证。crish 接新端点时应保留这类"契约探测"测试。

### 风险提示（借鉴时的反面清单）

- 命中率显示口径要统一（`hit/(hit+miss)`，分母不可为 0 时回退 prompt），否则"显示数学"会误导优化决策（`cachehit_e2e_test.go:184-187` 专门断言口径）。
- cache_creation（Anthropic 写入）对计费按全价 miss 计入——写缓存也是要花钱的，别把"写入"当成免费。
- reasoning 回放在 DeepSeek thinking 模式下是命中率的天花板放大器，预算与 UI 显示要如实反映（实测成本 = 回放 prompt 差）。
- 自定义网关/代理场景：Beta 端点、厂商专属行为都要"仅官方域名"门控，防止绕过网关（安全与计费双重原因）。

---

## 附：调研初稿行号与核实结果对照

| 调研初稿引用 | 核实结果 |
|---|---|
| `compact.go` 注释 "the prompt grows append-only (high cache hits)" | ✅ `compact.go:19-23` |
| `memory/doc.go` 记忆折叠注释 | ✅ `doc.go:9-13` |
| `memory/memory.go:175-188` Compose base 最前 | ✅ 精确（`memory.go:176-177` 为注释核心） |
| `docs/SPEC.md` 双模型分离 session | ✅ `SPEC.md:201-202, 237-240` |
| `cache_shape.go` CaptureShape/CompareShape | ✅ `cache_shape.go:36 / 67` |
| `recovery/cache_shape_test.go` 门禁 | ✅ `cache_shape_test.go:18-61` |
| `cachehit_e2e_test.go` 四项指标 | ✅ 154/194/231/282/325 全部存在（另补 378 发布门禁） |
| `anthropic.go:377-395` cache_control | ✅ 精确 |
| `anthropic_test.go:452-461` DeepSeek 省略 | ✅ 精确 |
| `openai.go:658-679` reasoning_content 回放 | ✅ 实际 `openai.go:658-680` |
| `provider.go:735-794` 策略接口 | ⚠️ 小漂移：实际 `provider.go:734-764`（ToolCallReasoningPolicy 自 734 起；RequiresToolCallReasoning 740-746；ReasoningRoundTripPolicy 748-764） |
| `openai.go:1030-1083` normaliseUsage | ✅ 精确 |
| `provider.go:580-595` Usage 结构 | ✅ 结构体 `provider.go:587-595`（注释自 580 起） |
| `openai.go:576-579` maxStreamReconnects | ✅ 精确（`=3`） |
| `openai.go:473-549` 前缀续写 | ✅ 函数体 `openai.go:478-549`（473-477 为注释） |
| `host.go:41-58` 仅官方启用 | ✅ 函数体 `host.go:45-58`（41-44 为注释） |
| compact 分级 0.5/0.6/0.8/0.9 | ✅ `compact.go:24-36`；soft~snip 只通知 `92-99`；compactStuck `116-118, 140-146` |
| SnipStaleToolResults | ✅ 定义 `prune.go:38-40`，调用 `compact.go:102` |
| `auto_recall.go` 预算 4 条/2400 字符/520 rune | ✅ `auto_recall.go:16-21`；块构造 `411-444` |
| `provider.go:607-621` Pricing.Cost | ✅ 精确 |
| `resolver.go:17-19` CacheHitPerMillion | ✅ 字段 `resolver.go:17`（该行即为声明行） |
| `realcache_test.go` 三要素 | ✅ 33（测试）/ 90-93（64-token 块）/ 104,161（3 秒等待）/ 173（回放成本公式） |
| `realdeepseek_test.go` unsigned thinking | ✅ `realdeepseek_test.go:19-79` |
| `openai.go:422-424` sync.Pool | ✅ 精确（注释 418-421） |
| `.jsonl.meta` sidecar | ✅ `branch.go:376-395, 427-451` + `listsessions_bench_test.go:43-70` |
