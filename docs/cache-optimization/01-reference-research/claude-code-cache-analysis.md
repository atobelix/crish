# Claude Code 缓存优化实现深度分析报告

> 分析对象：`reference/claudeCode`（Claude Code 官方源码的展平副本）
> 分析维度：cache_control 断点放置 / 上下文压缩 / 上下文编辑 / usage 解析 / 模型元数据 / 本地缓存 / 第三方厂商适配 / 缓存命中率测量
> 分析方法：全部结论均附 `文件路径:行号` 证据
> 版本特征：代码注释中出现 2026 年 3 月的 BQ 分析日期，属于 2026 年前后的较新版本（含 cache_edits 缓存编辑、global scope 缓存、1h TTL、prompt cache break 检测等特性）

---

## 一、结论先行：该软件在缓存优化上最值得借鉴的 5 点

**1. 断点放置策略成熟且克制："恰好一个"消息级断点 + system prompt 静态/动态分块**
- 整个请求只放**一个**消息级 `cache_control` 断点（最后一条消息；`skipCacheWrite` 的"即发即忘"fork 移到倒数第二条），而不是堆满断点（`services/api/claude.ts:3078-3108`）。注释解释了深层原因：Anthropic 的 mycro 推理侧对"非断点位置"的 KV 页会做 turn-to-turn 驱逐，两个断点反而会多保护一段永远不会被续接的尾巴。
- system prompt 被拆成"attribution 头（不缓存）+ CLI 前缀（org 级）+ 静态内容（global 级）+ 动态内容（不缓存）"的多块结构，靠 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 边界标记定位（`utils/api.ts:296-435`、`constants/prompts.ts:105-115`）。
- 断点不放 thinking/redacted_thinking 块上（`services/api/claude.ts:656-666`）。

**2. "缓存键字节稳定性"被当作一等公民工程化对待**
Claude Code 的核心洞见是：**服务端缓存键是请求字节的前缀匹配，任何字节抖动都会废掉整个 ~50-70K token 的缓存**。为此它做了大量"冻结"工作：
- 工具 schema 会话级缓存：schema 首轮渲染后锁定字节，GrowthBook 开关翻转、MCP 重连、`tool.prompt()` 动态内容都不再影响序列化字节（`utils/toolSchemaCache.ts:3-8`、`utils/api.ts:136-151`）；
- 1h TTL 的 eligibility 与 allowlist 在 bootstrap state 里 latch，防止会话中途 overage 状态翻转改变 `cache_control.ttl`（`services/api/claude.ts:403-424`、`bootstrap/state.ts:220-225`）；
- 多个 beta 头（AFK、fast mode、cache editing）做 sticky-on latch：一旦启用整个会话持续发送，避免开关切换 double-bust 缓存（`services/api/claude.ts:1405-1456`、`bootstrap/state.ts:226-242`）；
- `cache_control` 本身（scope/TTL 组合）被单独哈希进缓存断裂检测，专门抓"内容没变但 scope/TTL 翻转"这类隐形断裂（`services/api/promptCacheBreakDetection.ts:276-281`）。

**3. 两阶段"缓存断裂检测"：hash 快照归因 + 实际 cache_read 验证，把缓存事故变成可诊断的工程问题**
- 阶段一（请求前）对 system prompt / 工具 / 模型 / betas / effort / extraBody 等所有影响缓存键的因素做哈希快照，并记录 pendingChanges（`promptCacheBreakDetection.ts:247-430`）；
- 阶段二（请求后）对比实际 `cache_read_input_tokens` 下降 >5% 且绝对下降 >2000 token 才算断裂，再结合 pendingChanges 归因到"具体哪个工具 schema 变了 / 哪个 beta 头变了 / TTL 到期 / 服务端路由"（`promptCacheBreakDetection.ts:437-666`）；
- 精心处理误报：haiku 排除、`cache_edits` 删除导致的预期下降（`notifyCacheDeletion`）、压缩后基线重置（`notifyCompaction`）、并发子代理按 agentId 隔离状态（`promptCacheBreakDetection.ts:149-158, 453-481, 673-698`）。

**4. 压缩机制是"缓存感知"的：fork 复用主前缀、冷缓存时才清理、服务端 cache 编辑**
- compact 摘要请求通过 `runForkedAgent` + `cacheSafeParams`（system/user/systemContext/tools/messages 前缀全对齐）**复用主对话的 prompt cache**，且 `skipCacheWrite: true` 不给 fork 写新缓存条目；实验数据：关闭该路径 3P 场景 98% 缓存未命中（`services/compact/compact.ts:431-438, 1136-1230`）；
- 时间基 microcompact：空闲 >1h（缓存必然已过期）时才清除旧工具结果——"既然要全量重写，先缩小再写"（`microCompact.ts:261-270`、`timeBasedMCConfig.ts:18-28`）；
- cached microcompact 用服务端 `cache_edits` API 删除工具结果而**不失效缓存前缀**，本地消息内容完全不动（`microCompact.ts:295-399`、`services/api/claude.ts:3052-3211`）；
- 压缩后调用 `notifyCompaction` 重置断裂检测基线，避免"压缩导致 cache_read 下降"被误报为断裂（`compact.ts:697-703`）。

**5. 成本模型把 cache read/write 分开计价，且贯穿统计、持久化与 UI**
- `tokensToUSDCost` 对 input/output/cache_read/cache_creation/web_search 分别乘不同单价（Sonnet 档：读 $0.3、写 $3.75 / Mtok）（`utils/modelCost.ts:131-142`）；
- usage 解析正确处理了流式语义（message_start 累积值不被 message_delta 的 0 覆盖，`claude.ts:2914-2987`），并在 `updateUsage`/`accumulateUsage` 中逐轮聚合；
- 缓存 token 统计进入会话成本状态、项目配置持久化（`cost-tracker.ts:143-175`、`setup.ts:463-465`）、状态栏（`utils/context.ts:130-133`）、分析事件（`services/api/logging.ts:482-483`）。

---

## 二、项目结构概览与技术栈

### 2.1 结构形态

本副本不是标准 monorepo（无根 `package.json` / README / `packages/` 目录），而是一个**展平、去重的 TypeScript 源码目录**，顶层目录直接对应 Claude Code 的 `src/` 内部模块划分：

```
assistant/ bootstrap/ bridge/ buddy/ cli/ commands/ components/ constants/
context/ coordinator/ entrypoints/ hooks/ ink/ keybindings/ memdir/ migrations/
moreright/ native-ts/ outputStyles/ plugins/ query/ remote/ schemas/ screens/
server/ services/ skills/ state/ tasks/ tools/ types/ upstreamproxy/ utils/
vim/ voice/
```

关键入口与主循环：
- `main.tsx`：CLI 主入口
- `screens/REPL.tsx`（895KB，最大文件）：REPL 主界面/会话管理
- `QueryEngine.ts` + `query.ts`：查询引擎与查询循环（缓存断点、压缩编排都在这里）
- `Task.ts` / `tasks/`：任务抽象

缓存相关代码集中在：
- `services/api/claude.ts`：API 请求构造、`getCacheControl`、`addCacheBreakpoints`、usage 解析（本报告最核心文件，3419 行）
- `services/api/promptCacheBreakDetection.ts`：缓存断裂检测（727 行）
- `services/compact/`：压缩体系（`compact.ts` 1705 行、`autoCompact.ts`、`microCompact.ts`、`prompt.ts`、`sessionMemoryCompact.ts`、`timeBasedMCConfig.ts` 等）
- `utils/modelCost.ts`、`utils/model/`：定价与模型元数据
- `utils/toolSchemaCache.ts`、`utils/model/modelCapabilities.ts`、`utils/statsCache.ts`、`services/vcr.ts`：本地缓存

### 2.2 技术栈

| 技术 | 证据 | 用途 |
|---|---|---|
| TypeScript（Bun 运行时） | `bun:bundle` 宏随处可见，如 `services/compact/autoCompact.ts:1`；`Bun.hash` 用于缓存断裂检测哈希 `promptCacheBreakDetection.ts:172-178` | 主语言；Bun 构建期做 feature 死代码消除（`feature('...')` 字符串在外部构建中被剔除） |
| `@anthropic-ai/sdk` | `utils/modelCost.ts:1` 等 | Anthropic API 客户端 |
| ink（React 终端渲染） | `ink/ink.tsx`、`main.tsx` | 终端 UI |
| lodash-es / zod / lru-cache / diff | `utils/fileStateCache.ts:1`、`services/api/promptCacheBreakDetection.ts:3` | 工具库；diff 用于生成缓存断裂诊断文件 |
| GrowthBook（Statsig 风格）feature flag | `getFeatureValue_CACHED_MAY_BE_STALE(...)` 遍布各处，如 `services/compact/autoCompact.ts:15` | 服务端远程配置；注意后缀 `_CACHED_MAY_BE_STALE` 本身就承认"磁盘缓存可能过期" |

值得注意：所有"会改变请求字节"的配置读取都刻意使用 `CACHED_MAY_BE_STALE` 变体——**宁愿用过期配置，也不要在会话中途翻转导致缓存键变化**。这是贯穿全库的设计哲学。

---

## 三、cache_control 断点放置策略

### 3.1 断点形态：`getCacheControl`

断点统一由 `getCacheControl` 生成（`services/api/claude.ts:358-374`）：

```ts
export function getCacheControl({ scope, querySource }) {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}
```

- 基础形态永远是 `{type: 'ephemeral'}`（5 分钟 TTL 隐含默认）；
- 1h TTL 是**条件性**的：用户 eligible（ant 或订阅用户且未超量）+ querySource 命中 GrowthBook allowlist（`claude.ts:393-434`）。Bedrock 用户可用 `ENABLE_PROMPT_CACHING_1H_BEDROCK` 自行 opt-in（`claude.ts:396-401`）；
- `scope: 'global'` 只对 1P（firstParty）且未禁用实验 beta 时可用（`utils/betas.ts:227-232`）。

**关键防抖设计**：TTL 的 eligibility 与 allowlist 都"latch 进 bootstrap state"——首次求值后整个会话固定，防止会话中途的 overage 翻转/GrowthBook 磁盘缓存刷新改变 `cache_control` 的 TTL 值。注释明确写道：TTL 翻转会打爆服务端缓存（约 2 万 token/次）（`claude.ts:403-424`、`bootstrap/state.ts:220-225`）。

### 3.2 全局开关

`getPromptCachingEnabled`（`claude.ts:333-356`）支持：
- `DISABLE_PROMPT_CACHING`（全局禁用）
- `DISABLE_PROMPT_CACHING_HAIKU / SONNET / OPUS`（按模型档位禁用）

### 3.3 system prompt 上的断点：多块 + 静态/动态分界

`buildSystemPromptBlocks`（`claude.ts:3213-3237`）对每个块按其 `cacheScope` 挂 `cache_control`。分块逻辑在 `splitSysPromptPrefix`（`utils/api.ts:296-435`）：

三种模式（由 `shouldUseGlobalCacheScope()` + 是否有 MCP 工具决定）：

| 模式 | 块结构 | cacheScope |
|---|---|---|
| 默认（3P / 无 boundary） | attribution 头 / CLI 前缀 / 其余合并 | null / org / org |
| MCP 工具存在（`skipGlobalCacheForSystemPrompt=true`） | attribution 头 / CLI 前缀 / 其余合并（跳过 boundary 标记） | null / org / org |
| global 缓存 + 找到 boundary | attribution 头 / CLI 前缀 / **静态内容** / 动态内容 | null / null / **global** / null |

- boundary 标记常量：`__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`（`constants/prompts.ts:105-115`），放在 system prompt 数组中，静态侧（跨组织可复用内容）用 `global` scope，动态侧（用户/会话特定内容）完全不缓存；
- attribution 头（`x-anthropic-billing-header` 开头）**永不缓存**，按内容而非位置识别（`utils/api.ts:339-341, 376-378`）；
- CLI 前缀块按内容集合 `CLI_SYSPROMPT_PREFIXES` 识别（`constants/system.ts:14-28`）。

注释警告：加新的缓存块会触发 API 400（"Do not add any more blocks for caching or you will get a 400"，`claude.ts:3221`）；另有证据显示 API 对断点数有硬限制（"API limit of 4 cache_control blocks"，`utils/permissions/yoloClassifier.ts:1101`）。

### 3.4 消息级断点：恰好一个 + 位置策略

`addCacheBreakpoints`（`claude.ts:3063-3211`）是断点放置的核心，规则：

1. **整个请求最多一个消息级断点**，放在**最后一条消息**上；`skipCacheWrite` 模式（即发即忘的 fork：compact、side query、away summary 等）放在**倒数第二条**——那是与父会话最后一个共享前缀点，写缓存是无操作合并，fork 不会在 KV 缓存里留下自己的尾巴（`claude.ts:3078-3089`）。mycro 推理侧的驱逐语义注释详见 `claude.ts:3078-3088`。

2. 断点放在消息的**最后一个 content block**上（数组内容时 `i === content.length - 1`）；assistant 消息跳过 thinking / redacted_thinking / connector_text 块（`claude.ts:656-666`）——thinking 块在服务端可被改写（签名机制），不能承载断点。

3. **user 消息的数组内容会被克隆**（`claude.ts:622-630`），防止 `insertCacheEditsBlock` 的 splice 污染原始消息——字节稳定性要求（"mutating it would break prompt caching (byte mismatch)"，`query.ts:742-746`）。

4. cached microcompact 模式下（`useCachedMC`）：
   - 把历史 pinned 的 `cache_edits` 块按原位置重新插入（`claude.ts:3127-3139`）；
   - 把新的 `cache_edits` 插入最后一个 user 消息的工具结果之后，并 pin 位置（`claude.ts:3141-3162`）；
   - 给**位于最后 cache_control 之前的**所有 `tool_result` 块加 `cache_reference`（等于其 `tool_use_id`），供服务端定位要删除的 KV 内容（`claude.ts:3164-3208`）。API 约束：`cache_reference` 必须出现在"最后一个 cache_control 之前或之上"，实现用严格的"之前"规避 cache_edits splice 引起的下标漂移（`claude.ts:3180-3183`）。
   - 该函数专门导出供测试（`claude.ts:3062`："Exported for testing cache_reference placement constraints"）。

### 3.5 工具断点：schema 字节锁定 + 断点挂在最后一个工具

- 工具的 `cache_control` 经 `toolToAPISchema` 的 `cacheControl` 选项挂载（`utils/api.ts:119-134, 211-230`）；
- **工具 schema 会话级缓存**（`utils/toolSchemaCache.ts`，仅 26 行）：schema 首轮渲染后锁定，缓存键为 `name` 或 `name:jsonStringify(inputJSONSchema)`（结构化输出工具 schema 不同必须入键，否则 5.4%→51% 错误率，见 `utils/api.ts:142-150` 与 PR#25424 注释）。注释点明工具排在 system prompt 之前的"server position 2"，任何字节变化都会打爆整个约 1.1 万 token 的工具块及其下游（`toolSchemaCache.ts:3-8`）；
- 每请求的 `defer_loading`/`cache_control` 是**覆盖层**（overlay），显式字段拷贝避免污染缓存 base（`utils/api.ts:211-230`）；
- advisor 等追加 server 工具**追加在数组末尾**，"toggling /advisor only churns the small suffix, not the cached prefix"（`claude.ts:1386-1395`）——动态工具永远放尾巴，不碰缓存前缀；
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` 时所有非基础字段被剥离，但 `cache_control` 被明确 allowlist（`utils/api.ts:232-260`）。

### 3.6 断点与工具的交互细节

- 断点只挂在一个工具上（yoloClassifier 的 action 块，`utils/permissions/yoloClassifier.ts:1097-1105`），注释强调 4 块断点上限；
- `recordPromptState` 的快照把 `defer_loading` 工具剔除（API 会从 prompt 中剥离它们，不影响真实缓存键）以免误报（`claude.ts:1460-1467`）。

---

## 四、上下文压缩 / compact 机制

### 4.1 分级压缩管线（同一查询循环内的串行漏斗）

`query.ts:365-468` 展示了完整的上下文压力处理顺序，每级失败/不足才落到下一级：

```
messagesForQuery
  → 4.1 applyToolResultBudget（工具结果字节预算替换，query.ts:369-394）
  → 4.2 snip（HISTORY_SNIP，删旧消息，query.ts:396-410）
  → 4.3 microcompact（清旧工具结果，query.ts:412-426）
  → 4.4 context collapse（CONTEXT_COLLAPSE 投影式折叠，query.ts:428-447）
  → 4.5 autocompact（完整摘要压缩，query.ts:453-543）
```

- snip 先于 microcompact，两者可叠加；`snipTokensFreed` 会传给 autocompact 的阈值判断（因为基于"被保护尾部 assistant 的 usage"做估计时看不到 snip 省下的量）（`query.ts:396-400`）；
- microcompact 先于 autocompact：若 microcompact 后已低于阈值，autocompact 不再触发（`query.ts:428-431`）；
- autocompact 失败有**熔断器**：连续 3 次失败后本轮会话不再尝试（BQ 数据：曾有 1279 个会话单会话 50+ 次连续失败，浪费约 25 万次 API 调用/天）（`autoCompact.ts:67-70, 257-265`）。

### 4.2 auto-compact 触发条件

- **有效上下文窗口** = 模型上下文窗口 − 摘要预留输出（`min(maxOutputTokens, 20000)`，基于 p99.99 摘要输出 17,387 token）；支持 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 覆盖（`autoCompact.ts:28-49`）；
- **压缩阈值** = 有效窗口 − 13,000 buffer（`AUTOCOMPACT_BUFFER_TOKENS`，`autoCompact.ts:62, 72-91`）；
- 预警分级：warning（阈值−20K）/ error（阈值−20K）/ blocking（有效窗口−3K），并支持 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`、`CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` 测试覆盖（`autoCompact.ts:93-145`）；
- 禁用途径：`DISABLE_COMPACT` / `DISABLE_AUTO_COMPACT` / 设置项 `autoCompactEnabled`（`autoCompact.ts:147-158`）；
- **递归保护**：`session_memory`、`compact` 查询源不触发（它们是 fork 出来的，会死锁）（`autoCompact.ts:169-173`）；context-collapse 开启时也抑制（两套系统会竞争上下文头寸，`autoCompact.ts:201-223`）；
- token 计数用 `tokenCountWithEstimation`（基于最近 API usage 的估算，`utils/tokens.ts:159-261` 区域），而非纯字符估算。

### 4.3 compact 摘要请求的缓存感知设计（本报告最亮眼的设计之一）

`compactConversation`（`services/compact/compact.ts:387-763`）的全流程：

1. **pre_compact hooks**（用户可注入压缩指令，`compact.ts:411-425`）→ 2. **摘要请求**（`streamCompactSummary`，`compact.ts:440-491`）→ 3. 构造压缩边界消息与摘要消息（`compact.ts:596-624`）→ 4. **post_compact 附件重建**（文件状态快照、plan、skill、工具增量说明等，`compact.ts:517-585`）→ 5. post_compact hooks → 6. 返回。

缓存相关细节：

- **摘要请求复用主对话缓存前缀**：`streamCompactSummary` 默认走 `runForkedAgent({ promptMessages: [summaryRequest], cacheSafeParams, skipCacheWrite: true, maxTurns: 1, ... })`（`compact.ts:1179-1230`）。`cacheSafeParams` 携带与主对话完全一致的 system prompt / userContext / systemContext / tools / 消息前缀（`utils/forkedAgent.ts:60-68`），使 fork 的请求与主对话共享缓存键 → 摘要生成请求的输入大部分命中缓存（`tengu_compact_cache_sharing_success` 事件记录命中率，`compact.ts:1214-1227`）。
- **绝不设置 maxOutputTokens**：设置会经 `Math.min(budget, maxOutputTokens-1)` 钳制 thinking budget，导致 thinking config 与主对话不一致而**破坏缓存键**（`compact.ts:1181-1187`）。
- 该开关名为 `tengu_compact_cache_prefix`，3P 默认 true；实验数据（2026-01）：关闭时 98% 缓存未命中，耗费全舰队约 0.76% 的 cache_creation（约 380 亿 token/天），集中在冷缓存的临时环境（`compact.ts:431-438`）。
- 摘要失败（无文本/API 错误）时回退到常规流式路径（只有 FileRead 工具的最小工具集 + 独立 system prompt，`compact.ts:1250-1309`）——该路径不共享缓存，可以安全设置 maxOutputTokens。
- `prompt.ts` 的摘要模板是**无工具强指令**（`NO_TOOLS_PREAMBLE`，`prompt.ts:12-26`）+ 9 段结构（`BASE_COMPACT_PROMPT`，`prompt.ts:61-143`）+ `<analysis>` 草稿区剥离（`formatCompactSummary`，`prompt.ts:311-335`）；`<analysis>` 是模型输出质量脚手架，最终摘要只保留 `<summary>` 内容，减少写回上下文的 token。
- 摘要消息以 user 消息形式写回（`isCompactSummary: true`、`isVisibleInTranscriptOnly: true`），并提示可从转录文件读旧细节（`compact.ts:613-624`、`prompt.ts:337-374`）。

### 4.4 压缩后的缓存清理与基线重置

- `postCompactCleanup.ts`：清理所有"内容缓存"（`getUserContext.cache.clear()`、内存文件缓存、skill 列表缓存等），并解释为什么**故意不清** `sentSkillNames`——压缩后重新注入完整 skill_listing（约 4K token）是纯 cache_creation 且收益微薄（`postCompactCleanup.ts:13-69`）；
- `notifyCompaction`：把缓存断裂检测的 cache_read 基线重置为 null，防止压缩后的自然下降被误报（`compact.ts:697-703`、`promptCacheBreakDetection.ts:689-698`）；
- 压缩事件 `tengu_compact` 携带完整 usage 指标（含 `compactionCacheReadTokens` / `compactionCacheCreationTokens`），用于成本与命中率分析（`compact.ts:650-695`）。

### 4.5 部分压缩（partial compact）与缓存

`partialCompactConversation`（`compact.ts:772-1106`）支持两个方向：
- `from`：总结 pivot 之后的消息，保留之前的（**之前的缓存前缀被保留**）；
- `up_to`：总结 pivot 之前的消息，保留之后的（摘要会插到保留消息之前，**缓存前缀必然失效**）。

对 `up_to`，摘要请求只发 `messagesToSummarize`（`forkContextMessages` 只带摘要部分）——"up_to 前缀直接命中缓存；from 发全量（尾部不会缓存）"（`compact.ts:852-858`）。`grouping.ts` 提供按 API 回合的分组（`groupMessagesByApiRound`），保证截断重试时只丢整组、不破坏工具配对。

### 4.6 microcompact（微压缩）——两种路径

`microCompact.ts:253-293` 的两条路径：

1. **时间基 microcompact**（`maybeTimeBasedMicrocompact`，触发阈值 GrowthBook 配置 `tengu_slate_heron`，默认禁用、60 分钟、保留 5 个）：若距上一条主循环 assistant 消息超过阈值，**服务端缓存几乎必然已过期**（1h TTL 对所有用户保证过期），此时直接内容清除旧工具结果——先缩小再重写，避免"反正要全量写缓存"时多写旧内容（`microCompact.ts:261-270`、`timeBasedMCConfig.ts:18-43`）。明确注释：cached MC（缓存编辑）假定缓存是热的，冷缓存时跳过（`microCompact.ts:264-266`）。
2. **cached microcompact**（feature `CACHED_MICROCOMPACT`，`cachedMicrocompactPath`，`microCompact.ts:305-399`）：按计数阈值（GrowthBook 的 `triggerThreshold`/`keepRecent`）决定删除哪些工具结果，但**本地消息内容完全不动**，只通过 `pendingCacheEdits`（`cache_edits` 块：`{type:'delete', cache_reference}` 列表）让 API 层在请求时携带删除指令——服务端删除 KV 内容，缓存前缀其余部分仍命中。这是"上下文编辑"与缓存共存的答案（见维度五）。

### 4.7 会话记忆压缩（session memory compact）

autocompact 触发后**先试** `trySessionMemoryCompaction`（`autoCompact.ts:287-310`）：基于记忆文件重写上下文，比全量摘要更省；成功同样要重置缓存断裂基线（否则 20% 的 `tengu_prompt_cache_break` 是误报，`autoCompact.ts:298-304`）。回退到 `compactConversation` 全量压缩（`autoCompact.ts:312-321`）。

### 4.8 API 原生 context management（第三种压缩通道）

`apiMicrocompact.ts` 生成 `context_management` 请求体（`getAPIContextManagement`）：
- `clear_thinking_20251015`：清理旧 thinking 块（保留策略为 `all` 或 1 轮；>1h 空闲＝缓存必然未命中时只保留最后 1 轮 thinking——`clearAllThinking`，`apiMicrocompact.ts:77-87`）；
- `clear_tool_uses_20250919`：触发阈 180K、目标保留 40K token，清除可清工具的结果或调用记录（ant 专属，`apiMicrocompact.ts:89-153`）。

### 4.9 摘要对缓存的影响小结

| 动作 | 对缓存的影响 | 缓解手段 |
|---|---|---|
| 完整压缩 | 前缀被摘要+边界消息替换，必然全量重写 | fork 复用主前缀生成摘要；压缩后重置断裂基线 |
| 部分压缩 `from` | 前缀保留 | 直接受益 |
| 部分压缩 `up_to` | 前缀失效（摘要插前） | 摘要请求只发被总结部分，命中摘要侧缓存 |
| microcompact（内容清除） | 前缀失效 | 时间基路径只在缓存已冷时触发 |
| cached microcompact | **前缀保持命中** | 服务端 cache_edits 删除 |
| snip / collapse | 前缀失效 | 冷缓存时执行；snip 有 tokensFreed 记账 |

---

## 五、上下文编辑（context edit）机制与缓存前缀稳定性

### 5.1 结论先行

本版本 Claude Code **没有"编辑历史消息内容"的用户级 context edit 命令**（搜索 `contextEdit`/`editMessage`/`rewrite` 均无对应实现）。它把"编辑上下文"全部搬到了**服务端缓存编辑**（cache_edits / cache_reference）与**追加式重建**（snip 投影、microcompact 内容清除、压缩重写）上。其核心约束在 `query.ts:742-746` 的注释里说得很直白：**对消息字节的任何就地修改都会破坏 prompt 缓存**。

### 5.2 服务端缓存编辑（cache editing）：编辑而不破坏前缀

- 类型定义：`CachedMCEditsBlock = { type: 'cache_edits'; edits: { type: 'delete'; cache_reference: string }[] }`（`claude.ts:3052-3055`）；
- 插入位置：**最后一个 user 消息的工具结果块之后**（`insertBlockAfterToolResults`，`claude.ts:3141-3162`），并"pin"记录（`pinCacheEdits(i, block)`），后续每次请求把历史 pin 的块按原位置**重新插入**（`claude.ts:3127-3139`）——因为缓存编辑是有状态的服务端操作，本地必须记住"之前删过什么"，请求时必须重放，否则服务端状态漂移；
- 去重：`deduplicateEdits` 按 `cache_reference` 去重（`claude.ts:3113-3125`）；
- `cache_reference` 标记：所有**早于最后一个 cache_control 标记**的 user 消息中的 `tool_result` 块，克隆后附上 `cache_reference: tool_use_id`（`claude.ts:3164-3208`）。必须克隆的理由：同一消息块会被"不支持缓存编辑的模型的二级查询"复用，不能污染（`claude.ts:3185-3186`）；
- 该能力仅 1P + 主线程 + 特定 beta 头（`cacheEditingBetaHeader`），且 header 做 sticky-on latch（`claude.ts:1431-1442, 1672-1689`）；
- usage 侧有配套字段 `cache_deleted_input_tokens`（API 返回删除的 KV token 数，非 SDK 类型，`claude.ts:2965-2982`），microcompact 用它计算实际删除量并生成边界消息（`microCompact.ts:369-393`、`query.ts:866` 附近"deferred microcompact boundary message using actual API-reported"）。

### 5.3 本地"编辑"一律走投影/重建，不碰源字节

- **snip**：REPL 保留完整历史供 UI 滚动，但模型视图用 `projectSnippedView` 投影（`utils/messages.ts:4643-4656`），边界消息标记已剪（`QueryEngine.ts:120-127`、`services/compact/snipCompact.ts` 由 `feature('HISTORY_SNIP')` 门控）；
- **rewind / tombstone**：同一头收缩操作被统一描述为 "Same-head shrink: tombstone filter, rewind, snip, partial-compact"（`hooks/useLogMessages.ts:48`）；
- **工具结果内容替换**：`applyToolResultBudget` 把超预算的工具结果替换为占位（对 cache 不可见，因为 cached MC 只认 tool_use_id，`query.ts:369-376`）。

### 5.4 API 侧上下文编辑（context management）

`ContextEditStrategy` 类型（`apiMicrocompact.ts:35-57`）是发给 API 的编辑指令：`clear_tool_uses_20250919`（清工具调用/结果）、`clear_thinking_20251015`（清 thinking）。这类编辑由服务端执行，同样不改变客户端字节（客户端不需要重发旧内容）。

---

## 六、usage 解析：cache_read / cache_creation 的处理与成本计算

### 6.1 流式 usage 解析的正确性处理

`updateUsage`（`claude.ts:2914-2987`）处理 Anthropic 流式语义：
- API 返回的是**累积值**而非增量：`message_start` 给出输入侧（input/cache_creation/cache_read），`message_delta` 可能对输入侧字段发**显式 0**——实现只在"非空且 >0"时才覆盖，防止把 message_start 的值抹掉（`claude.ts:2916-2945`）；
- `cache_creation.ephemeral_1h_input_tokens / ephemeral_5m_input_tokens` 细分字段被透传（`claude.ts:2956-2964`）；
- `cache_deleted_input_tokens`（缓存编辑删除量）在 `feature('CACHED_MICROCOMPACT')` 门控下解析——把字段名从外部构建中消除（死代码消除防泄露内部特性）（`claude.ts:2965-2982`）。

`accumulateUsage`（`claude.ts:2993-3030`）把多轮（含子代理）usage 逐字段累加，cache 字段同样累加。

### 6.2 成本计算模型

`utils/modelCost.ts`：
- 定价表结构 `ModelCosts = { inputTokens, outputTokens, promptCacheWriteTokens, promptCacheReadTokens, webSearchRequests }`（`modelCost.ts:27-33`）；
- 6 个定价档（`modelCost.ts:36-87`）：Sonnet 档 $3/$15（cache 写 $3.75、读 $0.3）；Opus 4/4.1 档 $15/$75；Opus 4.5/4.6 档 $5/$25；Opus 4.6 fast 档 $30/$150；Haiku 3.5 档 $0.8/$4；Haiku 4.5 档 $1/$5；
- `tokensToUSDCost`（`modelCost.ts:131-142`）：`input×单价 + output×单价 + cache_read×读价 + cache_creation×写价 + webSearch×0.01`——**缓存读写的价格差一个数量级**，这正是命中率优化的价值所在；
- 未知模型回退默认模型价（`DEFAULT_UNKNOWN_MODEL_COST = COST_TIER_5_25`）并上报 `tengu_unknown_model_cost`、标记 `hasUnknownModelCost`（UI 显示"costs may be inaccurate"）（`modelCost.ts:89, 144-173`）；
- `calculateCostFromTokens` 支持无完整 usage 对象的独立 token 成本计算（side query 用）（`modelCost.ts:186-202`）。

### 6.3 成本/用量统计与持久化

- `cost-tracker.ts`：`addToTotalSessionCost`（`cost-tracker.ts:278-323`）把单次 usage 的成本与 cache 字段累计进会话状态，并把 advisor 内嵌 usage 递归计入；`saveCurrentSessionCosts` 把 `lastTotalCacheCreationInputTokens` / `lastTotalCacheReadInputTokens` / 按模型的 `cacheReadInputTokens` / `cacheCreationInputTokens` 持久化到项目配置（`cost-tracker.ts:143-175`）；`restoreCostStateForSession` 恢复时校验 sessionId（`cost-tracker.ts:87-137`）；
- `setup.ts:463-465` 同样持久化 `last_session_total_cache_creation_input_tokens` 等，供恢复后状态栏展示；
- 状态栏上下文占用：`input + cache_creation + cache_read` 与窗口对比（`utils/context.ts:118-144`）——**缓存 token 计入"上下文占用"但只有 input 计入 API 账单**，两个口径并存；
- 分析事件：`tengu_api_success` 带 `cachedInputTokens`/`uncachedInputTokens`（`logging.ts:482-483`）、OTel `api_request` 带 `cache_read_tokens`/`cache_creation_tokens`（`logging.ts:722-723`）、LLM span 带 cache 字段（`logging.ts:768-769`）；
- `services/compact/compact.ts:672-680`、`query.ts:489-498`：压缩事件的缓存 token 指标（读/写/总）。

---

## 七、模型元数据：模型列表与定价

### 7.1 模型配置表

`utils/model/configs.ts`：每个模型按 4 个 provider 各有一组 ID（`ModelConfig = Record<APIProvider, ModelName>`）：
- `CLAUDE_SONNET_4_6_CONFIG`：firstParty `claude-sonnet-4-6` / bedrock `us.anthropic.claude-sonnet-4-6` / vertex / foundry（`configs.ts:79-84`），共 12 个模型常量（`configs.ts:9-99`）；
- `ALL_MODEL_CONFIGS` / `CANONICAL_MODEL_IDS` / `CANONICAL_ID_TO_KEY` 提供运行时遍历与规范名映射（`configs.ts:87-118`）。

### 7.2 定价表

`MODEL_COSTS`（`modelCost.ts:104-126`）把规范模型名映射到定价档（见维度六）。Opus 4.6 的定价随 fast mode 动态变化（`getOpus46CostTier`，`modelCost.ts:94-99`，`usage.speed === 'fast'` 时用 $30/$150 档，`modelCost.ts:148-153`）。

### 7.3 上下文窗口与输出上限

`utils/context.ts`：
- 默认 200K（`context.ts:9`）；`[1m]` 后缀 → 1M；ant-only 覆盖 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`；`getModelCapability`（远程拉取的磁盘缓存，见维度八）可提供精确值（`context.ts:51-98`）；
- `getModelMaxOutputTokens`：按模型家族给出 default/upperLimit（opus-4-6 64K/128K、sonnet-4-6 32K/128K、claude-3-opus 4K/4K 等）（`context.ts:149-210`）；
- 插槽预留优化：p99 输出 4911 token，32K/64K 默认值过度预留 8-16 倍插槽容量，故默认被压到 8K（`CAPPED_DEFAULT_MAX_TOKENS`），触顶后以 64K 干净重试一次（`context.ts:18-25`、`claude.ts:3399-3419`、`query.ts:1204-1217` 的 `tengu_max_tokens_escalate`）。

### 7.4 模型选项/别名/营销名

- `modelOptions.ts`：按用户分层（ant / Max / Team Premium / Pro / Team Standard / PAYG 1P / PAYG 3P）构建 `/model` 选择器列表（`modelOptions.ts:271-376`），3P 用 `ANTHROPIC_DEFAULT_*_MODEL` 环境变量注入自定义模型并展示价格（`modelOptions.ts:76-92`）；
- `model.ts`：默认模型解析（3P 默认 Sonnet 4.5 而 1P 默认 4.6——"3P providers may lag so keep defaults unchanged"，`model.ts:119-128`）、`getCanonicalName` 规范名映射、`[1m]` 解析；
- `antModels.ts`：ant 专属模型覆盖配置（GrowthBook `tengu_ant_model_override`，含 contextWindow/defaultMaxTokens/alwaysOnThinking 等字段）（`antModels.ts:4-42`）；
- `aliases.ts` / `modelStrings.ts`：别名集合与模型字符串；
- `validateModel.ts`：模型校验先查内存缓存 `validModelCache`，未缓存才发最小请求（`validateModel.ts:49-78`），请求里就带 `cache_control: {type:'ephemeral'}`（`validateModel.ts:69`）。

---

## 八、本地缓存（磁盘与内存）

### 8.1 磁盘缓存

| 缓存 | 路径/位置 | 内容 | 证据 |
|---|---|---|---|
| 模型能力缓存 | `~/.claude/cache/model-capabilities.json` | `models.list` API 结果（id/max_input_tokens/max_tokens），memoize 加载、isEqual 跳过写、0600 权限 | `utils/model/modelCapabilities.ts:38-118` |
| 启动数据缓存 | 全局配置 `clientDataCache` / `additionalModelOptionsCache` | bootstrap API 的客户端数据与额外模型选项，未变化不写盘 | `services/api/bootstrap.ts:114-141` |
| 统计缓存 | `~/.claude/stats-cache.json` | 每日活动/每日模型 token/按模型 usage/最长会话等，版本迁移（v1→v3）、原子写（temp+fsync+rename）、内存锁 | `utils/statsCache.ts:14-46, 107-254` |
| 会话转录 | 项目目录 JSONL | 会话持久化；`readLiteMetadata` 只读**头尾 64KB**（`LITE_READ_BUF_SIZE = 65536`）来加速会话列表；>5MB（`SKIP_PRECOMPACT_THRESHOLD`）跳过分隔预计算 | `utils/sessionStoragePortable.ts:17, 209-271, 480`；`utils/sessionStorage.ts` |
| 成本状态 | 项目配置 `lastCost`/`lastModelUsage` 等 | 会话成本与 cache token 持久化 | `cost-tracker.ts:143-175` |
| VCR 夹具 | `fixtures/*.json`（cwd 下） | **LLM 请求级录制/回放**（仅 NODE_ENV=test 或 ant + FORCE_VCR）：sha1(messages) 为键，重放时按 usage 补记成本；CI 缺夹具直接报错 | `services/vcr.ts:23-161, 382-406` |

### 8.2 内存缓存

| 缓存 | 键 | 说明 | 证据 |
|---|---|---|---|
| 工具 schema 缓存 | `name` 或 `name:inputJSONSchema` | 会话级字节锁定，防 GB 翻转/动态内容抖动 | `utils/toolSchemaCache.ts:13-26` |
| 文件状态缓存 | 规范化路径 | LRU，100 条 / 25MB 上限，压缩前 `cacheToObject` 快照、压缩后重建附件 | `utils/fileStateCache.ts:18-22, 30-106` |
| 缓存断裂检测状态 | querySource/agentId | `previousStateBySource` Map，上限 10 源（每条约 300KB diffableContent），超限逐出最旧 | `promptCacheBreakDetection.ts:101-115, 298-303` |
| 1h TTL latch | 全局 | eligibility + allowlist 会话固定 | `bootstrap/state.ts:220-225` |
| beta header sticky latch | 全局 | AFK/fast/cache-editing/thinking-clear 头会话固定 | `bootstrap/state.ts:226-242` |
| 模型校验缓存 | 模型名 | `validModelCache` | `validateModel.ts:50` |
| system prompt section 缓存 | 段名 | `systemPromptSectionCache` | `bootstrap/state.ts:202-203` |

### 8.3 设计要点

- **原子写**：stats 缓存 temp 文件 + fsync + rename（`statsCache.ts:214-254`）；
- **跳过写**：modelCapabilities / bootstrap 都用 `isEqual` 检测未变化则不写盘（`modelCapabilities.ts:101-104`、`bootstrap.ts:124-130`）；
- **权限**：0600（`modelCapabilities.ts:107-110`）；
- **会话级 vs 磁盘级**：影响请求字节的缓存（tool schema、TTL latch）一律会话级、永不落盘，因为"字节稳定性"是缓存命中的前提；统计类缓存落盘但带版本迁移。

---

## 九、对 DeepSeek、Kimi 等非 Anthropic 厂商的适配

### 9.1 事实核查

全库搜索 `deepseek` / `kimi` / `moonshot` / `glm` / `qwen` **零命中**。Claude Code 不支持非 Anthropic 模型 API 的直连；第三方接入只有两条路径：

1. **官方云**：`getAPIProvider()` 返回 `'firstParty' | 'bedrock' | 'vertex' | 'foundry'`（`utils/model/providers.ts:4-14`），由 `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY` 环境变量切换；
2. **代理网关**：`ANTHROPIC_BASE_URL` 指向 LiteLLM 等转发层（`isFirstPartyAnthropicBaseUrl` 判定是否为官方端点，`providers.ts:25-40`）。对这类网关，`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` 是兜底杀器（`utils/api.ts:232-260`）。

### 9.2 缓存能力按 provider 降级的完整清单

| 能力 | 1P | 3P（Bedrock/Vertex/代理） | 证据 |
|---|---|---|---|
| `scope: 'global'` | 可用 | 不可用（`shouldUseGlobalCacheScope` 仅 firstParty） | `utils/betas.ts:227-232` |
| 1h TTL | GrowthBook allowlist | Bedrock 需 `ENABLE_PROMPT_CACHING_1H_BEDROCK` opt-in | `claude.ts:393-401` |
| cache_edits / cache_reference（缓存编辑） | 可用（beta） | 不可用（`useCachedMC` 仅 firstParty + 主线程） | `claude.ts:1675-1678` |
| 请求级断点（ephemeral） | 可用 | 可用（基础能力，Bedrock/Vertex 支持） | `utils/api.ts:238-241` |
| 工具 schema 缓存 | 有 | 有（provider 无关，字节稳定性通用） | `utils/toolSchemaCache.ts` |
| compact 缓存前缀共享 | 有 | 有，且**默认开启**（3P 无 GrowthBook 门控） | `compact.ts:431-438` |
| 1m context beta 头 | 有 | 无（按 `[1m]` 后缀走 1M 窗口） | `utils/context.ts:69-72` |
| 模型能力远程缓存 | 仅 ant+1P | 无（`isModelCapabilitiesEligible`） | `modelCapabilities.ts:46-51` |

### 9.3 对 crish 的启示

Claude Code 的答案是：**把缓存降级路径做成显式的 provider 门控矩阵**，而不是为每个厂商写适配器。DeepSeek/Kimi 等厂商的 KV cache 语义（DeepSeek 的 context caching 是自动的、无 cache_control 断点、命中 10 倍折扣；Kimi 的 moonshot 缓存策略也不同）要求 crish 自己做"断点放置 → 厂商语义映射"层：Claude 式 `cache_control` 断点在 DeepSeek 上应翻译为"保持前缀稳定"（自动缓存只认字节前缀），在 Kimi 上可能完全无操作。

---

## 十、缓存命中率测量、统计与测试

### 10.1 两阶段缓存断裂检测（核心测量设施）

文件：`services/api/promptCacheBreakDetection.ts`（727 行），feature 门控 `PROMPT_CACHE_BREAK_DETECTION`。

**阶段一** `recordPromptState`（请求前，`claude.ts:1460-1486` 调用）：
- 对 system（剥离 cache_control 后哈希，另**单独哈希 cache_control 数组**抓 scope/TTL 翻转）、工具（剥离后哈希 + **per-tool 哈希**定位具体哪个工具变了）、模型、fastMode、betas（排序）、autoMode、overage、cachedMC、effort、extraBody 全部哈希比对（`promptCacheBreakDetection.ts:247-430`）；
- per-tool 哈希的价值：77% 的工具断裂是"工具集没变但 schema 内容变了"（AgentTool/SkillTool 嵌动态 agent/命令列表）（`promptCacheBreakDetection.ts:35-38, 369-378`）；
- 状态按 `getTrackingKey(querySource, agentId)` 隔离：compact 与主线程共享状态（同一缓存键），子代理按 agentId 隔离，未跟踪源（speculation 等短命 fork）不检测（`promptCacheBreakDetection.ts:133-158`）。

**阶段二** `checkResponseForCacheBreak`（请求后，`claude.ts:2382-2392` 调用）：
- 判定：`cacheReadTokens` 较上次**下降 >5% 且绝对下降 >2000 token**（`MIN_CACHE_MISS_TOKENS`，`promptCacheBreakDetection.ts:117-120, 485-492`）；
- 归因：pendingChanges 里逐项列出（model/system/tools/fastMode/globalCacheStrategy/cache_control scope-TTL/betas/autoMode/overage/cachedMC/effort/extraBody），无客户端变化时按时间间隔归因到 TTL 到期（>1h / >5min）或服务端路由（`promptCacheBreakDetection.ts:494-588`）；
- 产出：`tengu_prompt_cache_break` 分析事件（30+ 字段）+ 临时目录下的 `cache-break-*.diff` 文件（`createPatch` 对比前后可 diff 内容，ant 调试用）（`promptCacheBreakDetection.ts:590-660`）；
- **防误报协议**：`notifyCacheDeletion`（cache_edits 删除导致的预期下降，`promptCacheBreakDetection.ts:470-481, 673-682`）、`notifyCompaction`（压缩后重置基线，`689-698`）、`resetPromptCacheBreakDetection`/`cleanupAgentTracking`（`700-706`）。

### 10.2 命中率计算点

- compact 摘要 fork：`cacheHitRate = cache_read / (read + creation + input)`（`compact.ts:1220-1226`，事件 `tengu_compact_cache_sharing_success`）；
- extractMemories 侧查询：`hitPct = cache_read / totalInput`，并打印 `cache: read=… create=… (xx% hit)`（`services/extractMemories/extractMemories.ts:442-452`）；
- forkedAgent 完成日志：cacheRead/cacheCreate 明细与命中率（`utils/forkedAgent.ts:649-653`）；
- autoDream：`cache: read=… created=…`（`services/autoDream/autoDream.ts:250-254`）。

### 10.3 分析与统计

- `tengu_api_success` 事件的 `cachedInputTokens`/`uncachedInputTokens`（`logging.ts:482-483`）+ `timeSinceLastApiCallMs` 关联（`bootstrap/state.ts:249-252`）用于区分"空闲超时未命中"与"内容变化未命中"；`pendingPostCompaction` 标记压缩后首次调用（`bootstrap/state.ts:253-256`）；
- 压缩事件 `tengu_compact` / `tengu_auto_compact_succeeded` 带 cache read/write token（`compact.ts:650-695`、`query.ts:478-498`）；
- 每日统计：`dailyModelTokens`（按日×模型的 token 聚合，含缓存口径由 ModelUsage 结构携带）持久化于 stats-cache（`statsCache.ts:60-61, 289-303`）；
- 上下文构成分析 `analyzeContext`：逐块统计输入构成（`utils/analyzeContext.ts`，`compact.ts:687-694` 延迟到压缩后同步执行，避免卡渲染循环）。

### 10.4 测试设施

- **VCR**：`withVCR` / `withStreamingVCR` / `withTokenCountVCR` 把真实 LLM 请求录制为哈希键夹具，测试时回放（成本按 usage 补记），CI 无夹具即失败、`VCR_RECORD=1` 重新录制（`services/vcr.ts:23-161, 349-406`）；
- `addCacheBreakpoints` 专为测试导出（`claude.ts:3062`）；
- 压缩相关单元测试钩子：`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`、`CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE`（`autoCompact.ts:78-87, 127-134`）。

---

## 十一、对我们 crish 的可借鉴点

crish 是 Rust 内核 + Tauri + React 的 AI 桌面工作台，厂商目标包括 DeepSeek、Kimi 等非 Anthropic 模型。以下按优先级给出可落地的借鉴项：

### 11.1 借鉴一：把"请求字节稳定性"做成基础设施（最高优先级）

Claude Code 的一切缓存优化都建立在"**除了增长的消息尾部，请求字节逐轮完全一致**"之上。crish 应立即落地：

- **会话级工具 schema 缓存**（对应 `toolSchemaCache.ts`）：工具定义（Rust 侧序列化后的 JSON）首轮渲染后锁定字节，任何配置翻转不改变序列化输出；缓存键包含 schema 内容（对应 `utils/api.ts:142-150` 的教训）；
- **请求头/参数冻结**：会话中途可能翻转的一切请求字段（模型元数据、beta 头、超时参数）要么加入缓存键要么 latch 固定——对应 Claude Code 的 sticky-on latch（`claude.ts:1405-1456`）；
- **动态内容放尾巴**：追加式工具/上下文（advisor、会话记忆）永远 append 在数组末尾，绝不插入前缀（`claude.ts:1386-1395`）；
- 全链路使用字节比较（哈希）而非字段比较来检测"是否变了"。

### 11.2 借鉴二：断点放置策略（对应第三节）

- **单断点原则**：整个请求只放一个消息级断点（最后一条消息），而非每个工具/每条消息都挂 `cache_control`（`claude.ts:3078-3089`）；DeepSeek 自动缓存同样只认前缀，单断点=前缀最长=命中最多；
- **system prompt 静态/动态分块**：attribution/前缀/静态指令/动态上下文分离，动态部分不放缓存区（对应 `splitSysPromptPrefix`，`utils/api.ts:296-435`；crish 无 org/global 概念，但"哪些块跨会话稳定"的判定直接适用）；
- 断点避开 thinking 类块；消息数组先克隆再附加标记（字节稳定性）（`claude.ts:622-630, 656-666`）；
- **TTL/scope 决策要 latch**：一旦会话开始，缓存参数（TTL、是否写缓存）不许中途变化——对应 `bootstrap/state.ts:220-242` 的三处 latch。

### 11.3 借鉴三：两阶段缓存命中检测（对应第十节）

crish 可做一个轻量版 `prompt_cache_break_detection`：

- 阶段一：每次请求前对 system/tools/model/参数做哈希快照（Rust 侧成本极低）；
- 阶段二：对比响应 usage 的 cache_read 下降（>5% 且 >2K token），结合快照 diff 归因；
- 三件事让它值得做：①DeepSeek 的缓存命中价差达 10 倍，命中率直接进成本模型；②它是**发现自身 bug 的传感器**（比如某个动态字段悄悄进入了请求前缀）；③配合日志能回答"为什么这轮没命中"——Claude Code 把它做成了 30 字段的分析事件 + diff 文件（`promptCacheBreakDetection.ts:590-660`）。
- 防误报协议照抄：压缩/删除缓存内容后重置基线（`promptCacheBreakDetection.ts:470-481, 689-698`）。

### 11.4 借鉴四：压缩与缓存联动（对应第四节）

- **压缩摘要请求复用主对话前缀**：crish 的 compact 摘要调用可以复用主对话的消息前缀发送（对应 `cacheSafeParams` + fork 机制，`compact.ts:1136-1230`），摘要请求本身的输入几乎全部命中缓存——这一条在 DeepSeek 上同样成立（自动缓存）；
- **冷缓存时才清理**：判断距上次请求时间超过厂商缓存 TTL（DeepSeek 缓存 TTL 较长，需按厂商配置）后，才执行"清除旧工具结果"这类破坏前缀的操作（对应 `timeBasedMCConfig.ts`）；
- **压缩后重置命中率基线**，并把压缩自身的缓存用量记录进统计（对应 `compact.ts:697-703`）；
- **分级压缩漏斗**：snip（删旧消息）→ microcompact（清工具结果）→ 摘要压缩，逐级试（对应 `query.ts:396-468`）；熔断器防连续失败浪费 API（`autoCompact.ts:67-70`）；
- 摘要模板用"无工具强指令 + 结构化 9 段 + 草稿区剥离"（`prompt.ts`）——对 crish 的会话摘要质量与成本都有直接收益。

### 11.5 借鉴五：厂商感知的缓存语义层（对应第九节）

- 建立 provider 能力矩阵（支持缓存断点？TTL？缓存编辑？命中折扣比例？），DeepSeek（自动缓存、长 TTL、命中 10 折）、Kimi（moonshot 缓存语义）各自适配；Claude Code 的教训是：**能力差异用门控矩阵表达，不为厂商写特例代码**；
- 定价表把 cache read/write 分开建模（`modelCost.ts:27-33`），未知模型回退默认价并显式标记"成本可能不准"（`modelCost.ts:144-173`）；
- usage 解析学 `updateUsage` 的累积值语义（`claude.ts:2914-2987`）：非空且 >0 才覆盖，避免厂商把缓存字段发 0 时抹掉真实值。

### 11.6 借鉴六：本地缓存工程细节

- 会话转录用"头尾窗口读取"（64KB 窗口读元数据）加速会话列表（`sessionStoragePortable.ts:17, 209-271`）；
- 统计缓存原子写（temp + fsync + rename）+ 版本迁移（`statsCache.ts:107-254`）；
- 测试侧做 LLM 请求录制/回放（VCR，`services/vcr.ts`）——Rust 侧等价物是请求夹具哈希键 + 回放，这对 DeepSeek/Kimi 多厂商回归测试尤其有价值。

### 11.7 不建议借鉴的

- **cache_edits / cache_reference 服务端缓存编辑**：这是 Anthropic 私有 API 能力，DeepSeek/Kimi 均不提供；crish 应把"清除工具结果"设计为**可破坏前缀的内容清除**（仅在冷缓存时执行），而不是追求热缓存下的服务端编辑；
- **scope: global / org 跨会话缓存**：1P 专属能力，crish 无此概念；
- **GrowthBook 远程配置驱动的缓存策略**：对桌面单机应用过重，但"配置变化不中途翻转"的 latch 语义仍值得保留。

---

## 附录：证据索引表

| 主题 | 位置 |
|---|---|
| `getCacheControl` / 1h TTL latch | `services/api/claude.ts:358-434` |
| 缓存开关（环境变量） | `services/api/claude.ts:333-356` |
| system prompt 分块 | `utils/api.ts:296-435`；`constants/prompts.ts:105-115`；`constants/system.ts:14-28` |
| 单断点 + cache_edits + cache_reference | `services/api/claude.ts:3063-3211` |
| 消息级断点（user/assistant） | `services/api/claude.ts:588-674` |
| 工具 schema 缓存 | `utils/toolSchemaCache.ts`；`utils/api.ts:119-266` |
| 分级压缩管线 | `query.ts:365-543` |
| auto-compact 阈值/熔断 | `services/compact/autoCompact.ts:28-91, 147-158, 241-351` |
| 完整压缩 + 缓存前缀共享 | `services/compact/compact.ts:387-763, 1136-1309`；`utils/forkedAgent.ts:60-113` |
| 部分压缩方向与缓存 | `services/compact/compact.ts:772-899` |
| microcompact 两路径 | `services/compact/microCompact.ts:253-399`；`timeBasedMCConfig.ts` |
| 压缩后清理/基线 | `services/compact/postCompactCleanup.ts`；`compact.ts:697-703` |
| API context management | `services/compact/apiMicrocompact.ts` |
| usage 累积值解析 | `services/api/claude.ts:2914-3030` |
| 成本模型 | `utils/modelCost.ts`；`cost-tracker.ts`；`utils/tokens.ts:46-53` |
| 模型元数据 | `utils/model/configs.ts`；`model.ts`；`modelOptions.ts`；`antModels.ts`；`utils/context.ts` |
| 本地缓存 | `modelCapabilities.ts`；`bootstrap.ts`；`statsCache.ts`；`fileStateCache.ts`；`sessionStoragePortable.ts:17,480` |
| VCR 录制/回放 | `services/vcr.ts` |
| 断裂检测 | `services/api/promptCacheBreakDetection.ts`（全文件） |
| provider 门控 | `utils/model/providers.ts`；`utils/betas.ts:215-232`；`claude.ts:1672-1689` |
| 分析事件字段 | `services/api/logging.ts:482-483, 722-723, 768-769` |
