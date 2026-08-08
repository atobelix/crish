# 记忆韧性与缓存命中（Memory Resilience & Cache Hit）一体化实施方案

> 目录：`docs/cache-optimization/05-memory-resilience/20-plan/00-integrated-plan.md`
> 状态：v0.1 整合稿（待评审 Agent 审阅改进）
> 输入：`10-analysis/01-compression-recoverable.md`（277 行）、`02-cache-hit-prefix.md`（305 行）、`03-project-tree-and-cleanup.md`（307 行）、`04-summary-evolution.md`（486 行）
> 目标：AI 记忆始终在线（可追溯/可恢复/可搜索）+ 缓存命中率最大化，两者由"冻结折叠链"统一
> 性质：纯方案文档，不含代码；评审通过后按轮次派发实现 Agent

---

## 0. 一页总览

| 维度 | 结论 |
|---|---|
| 核心机制 | 压缩产物升级为 **append-only 冻结折叠链**（fold chain）：摘要消息一旦写入永不修改，压缩只破坏"链尾之后新增区"，system+链成为跨压缩稳定可命中的长前缀 |
| 记忆在线 | 压缩块（block）落库：块元数据表 + 事件流原文回放；新增 `decompress_context` / `search_context` 两个只读工具，模型可主动取回被压缩历史 |
| 摘要层 | L1 静态占位符删除，改"句柄 stub"；摘要 JSON 为规范面（AI 可扩展字段）、对话槽为 markdown 投影；后台单飞 + 指数退避重试（1s/3s/9s） |
| 缓存命中 | 折叠链冻结（B1-B4 不变量）+ 切割点链下界钳制 + 压缩后签名重建（rebuild_signature）+ 首个差异定位（prefix_diff_index） |
| 注入卫生 | 时间戳/时间线只进尾部 user 消息；目录树一律工具化（project_tree），永不注入 |
| 新能力 | project_tree 工具（懒构建 + mtime 失效 + 进程内共享缓存）；clean_output 输出清洗模块（送 AI 前脱 ANSI/压空行/去重/JSON 压缩） |
| DB | v7 迁移新增 `compression_blocks` 单表（合并两份草案的 compression_blocks + summary_documents，见 §2 裁决 R-A） |

---

## 1. 目标与验收（用户需求映射）

| 用户需求 | 本方案落点 |
|---|---|
| 可追溯/可恢复（decompress + search） | §4 压缩块 + §6 两工具 |
| 结构化模板改 AI 可扩展 | §5.1 JSON Schema（required 骨架 + custom 自由扩展 + paths/signatures/counts 结构化） |
| 去 AI 思考、保正文+工具链路、结果是否进摘要由 AI 控 | §3 折叠链（正文+tool 对是稳定前缀）；工具输出折叠归属由摘要调度语义覆盖（consumed tool 输出自然落链外） |
| L1 占位符没必要 → 达阈值一直尝试 AI 压缩 | §5.4 重试策略（同步先试一次 + 后台退避 + 跨轮 existing 合并重试）；stub 只是"确定性句柄"非"信息丢弃" |
| 用户消息时间线 | §8 尾部注入卫生清单（时间线 = 最新 user 消息尾部或追加新 user 消息，绝不进 system） |
| 记忆始终在线 + 命中率足够高 | 折叠链冻结 = 记忆字节永久可命中；块 + 工具 = 记忆语义在线 |
| 目录树工具（智能排除 node_modules、深度控制、多 agent 并发） | §7 project_tree（懒缓存 + SKIP_DIRS 复用 + mtime 失效） |
| 命令输出清洗省 token | §7 clean_output（R1-R6 规则，清洗在前截断在后，原始落库） |

---

## 2. 交叉点裁决（四份草案冲突统一）

> 四份分析存在 6 处交叉/冲突，主控裁决如下（评审 Agent 需重点核验）：

| # | 冲突 | 草案观点 | 主控裁决 |
|---|---|---|---|
| R-A | 新表数量 | 01 提案 `compression_blocks` 表；04 提案 `summary_documents` 表（两张 v7 新表） | **合并为一张 `compression_blocks`**：块即文档。列 = 01 的块元数据 + 04 的摘要文档字段（`summary_json`、`schema_version`、`height`、`tier`、`state`、`attempts`）。理由：块与其摘要文档是一对一生命周期，两表同 session 同 block_id 无独立意义 |
| R-B | 块 id 方案 | 01：复用 `record.id`（new_message_id("compaction")）；04：`run_id-uuid`；02：fold_index=链长+1 | **块 id = fold_index 派生**（消息 id `compacted-summary-{fold_index}` 与块身份合一，fold_index 会话内单调因链只增不减天然唯一）；record.id 保留既有语义（事件内唯一）不再兼任块 id，避免两套 id |
| R-C | stub 是否改写 | 04 D6：stub 就绪后由壳层收口"替换为完整 markdown"；02 B1：链消息永不修改 | **stub 永不改写**（B1 优先）。摘要就绪只写 `compression_blocks` 表 + 事件；对话内 stub 文本冻结为确定性句柄（"摘要已生成，可用 search_context 检索"）。模型需要内容走工具，下一轮压缩 existing 从表取文档。理由：跨 run 改写链消息 = 前缀改写 = B1 破坏，得不偿失 |
| R-D | 工具命名 | 01：`decompress_context`/`search_context`；03 无工具 | **`decompress_context` + `search_context`**（对齐 billion-context-pi 语义，用户认可"可解压+可搜索"） |
| R-E | L1 删除范围 | 04：AgentMessage 面删、旧 Message 面留 | **采纳 04**：旧 Message 面（UI 预览 `core_compact_messages`）保留文本占位符；AgentMessage 面删 L1 改 stub |
| R-F | 摘要同步性 | 04：全部异步后台；用户：达阈值就一直尝试 AI 压缩 | **同步先试一次 + 异步退避续试**：压缩触发时若 Summarizer 可用则同步尝试一次（成功即写入最终摘要，链冻结）；失败/无注入 → stub + 后台单飞退避（1s/3s/9s）→ 成功写表/事件；退避耗尽 state=retired，下一轮压缩 existing 通道续试。保证"临界线不依赖 AI"防线保留（stub 确定性） |

---

## 3. 总架构（五层）

```
┌─ 引擎层 conex-compaction（纯函数，无运行时依赖）─────────────────┐
│  · 折叠链不变量（B1-B4）：冻结/单调/只增/形状                     │
│  · 切割点链下界钳制（T-01~T-05）                                  │
│  · 块结构 + 摘要槽位文本（含块引用行）+ generation                 │
│  · summary_document（JSON Schema V1 校验/渲染/兼容解析）           │
│  · stub_placeholder（取代 L1）+ clean_output（R1-R6）              │
└───────────────────────────────────────────────────────────────┘
┌─ 执行层 session-loop ─────────────────────────────────────────┐
│  · apply_compaction 织入块元数据 / cache_boundary / 签名重建     │
│  · 摘要调度器（单飞 + 退避 + 状态机）                            │
│  · 时间线尾部注入卫生                                            │
│  · clean_output → truncate 接线（executing_tools.rs）            │
└───────────────────────────────────────────────────────────────┘
┌─ 持久层 conex-db / orchestrator ──────────────────────────────┐
│  · compression_blocks 表（v7 迁移）                             │
│  · 事件 details 扩展（blockId/generation/prevBlockId…）          │
│  · 原文恢复回放（message-end 事件流）                           │
└───────────────────────────────────────────────────────────────┘
┌─ 工具面 agent-tools ──────────────────────────────────────────┐
│  · search_context（搜压缩块摘要+块索引，不搜可见消息）            │
│  · decompress_context（回放原文，默认落文件不污染上下文）         │
│  · project_tree（懒构建树，mtime 失效，多 agent 共享缓存）       │
└───────────────────────────────────────────────────────────────┘
┌─ 测量面 conex-telemetry ──────────────────────────────────────┐
│  · prefix_diff_index（首个差异定位）                             │
│  · 压缩后签名重建（rebuild_after_compaction）                   │
│  · Compaction 归因真路径 + 恢复曲线 KPI                          │
└───────────────────────────────────────────────────────────────┘
```

---

## 4. 折叠链引擎（core，一切的基础）

### 4.1 不变量（测试钉死）

- **B1 冻结**：摘要链消息一经写入永不修改/丢失/折叠——长期记忆的字节冻结层。
- **B2 单调**：第 K 次压缩的折叠点（cut）严格 ≥ 第 K-1 次；永不越过链尾。同一 block 永不二次压缩。
- **B3 只增**：每次压缩至多新增 1 条摘要消息，id 递增 `compacted-summary-{fold_index}`（fold_index = 链长+1，统计状态从消息数推导，跨 run 天然恢复）。
- **B4 形状**：链紧邻 system 之后；链后为保留区。

压缩后前缀结构：`[system 冻结] [摘要1][摘要2]…[摘要K] [tail 原文]`

命中率收益：K 次压缩后任意相邻请求的 LCP = system + 全部链（字节不变）；链总长随记忆增长而从不作废，对比现状（每次压缩 LCP 退回 system 后 0）是数量级提升。

### 4.2 切割点钳制（find_cut_point_inner 五处）

| # | 位置（lib.rs 2026-08-08 实读） | 修正 |
|---|---|---|
| T-01 | :544 函数体开头 | 计算 `fold_start`（system 后连续 compacted-summary 前缀段之后的首个下标） |
| T-02 | :559-568 尾部倒推 | 倒推区间 `[fold_start, len)`；区间内未达预算 → None |
| T-03 | :570-575 | `cut == 0 → None` 改为 `cut <= fold_start → None` |
| T-04 | :577-592 min_recent_turns | 下界钳 `cut > fold_start`；`cut <= fold_start → None` |
| T-05 | :594-636 tool 配对回扫 | 回扫下界 `fold_start`；`needed <= fold_start → None`（不拉链进保留区） |

### 4.3 compact_agent_messages 修正

| # | 位置 | 修正 |
|---|---|---|
| T-06 | :448-452 dropped_arcs | 排除 `compacted-summary` 前缀（链永不入 dropped） |
| T-07 | :459-464 existing | 取链尾最后一条摘要文本（非首个） |
| T-08 | :496-516 组装 | system + 链全查（按序）+ 新摘要 + messages[cut..] |
| T-09 | :502-503 摘要 id | `compacted-summary-{fold_index}`（链长+1，消除 dropped 数耦合碰撞） |
| T-10 | :524-533 CompactionPlan | 增 `fold_chain_prev` / `fold_chain_after` / `block_id` / `generation` |

### 4.4 块结构（recovery 模块，01 §2.1 采纳）

```rust
CompactionBlockMeta {
    block_id: String,              // "compacted-summary-{fold_index}" 同源
    generation: u32,               // 会话级单调，跨 run 持久化
    prev_block_id: Option<String>, // 迭代合并链上游
    dropped_message_ids: Vec<String>,
    first_kept_message_id: Option<String>,
    summary: String, summary_is_llm: bool,
    tokens_before/after: u64, dropped_at_ms: i64,
    state: SummaryState,           // awaiting | committed | retired（R-C）
    summary_json: Option<String>,  // committed 后的 JSON 文档
}
```

摘要槽位文本（对话内）追加机器可读引用行：
```
[Compacted 12 earlier message(s) · block {block_id} · generation {g} · 恢复: decompress_context(blockId="{block_id}")]
```

---

## 5. 摘要层演化（AI 记忆在线）

### 5.1 JSON 规范面 + markdown 投影（04 §3 采纳）

- 规范形态：`summary_documents` → 合并进 `compression_blocks.summary_json`（R-A）；AI 输出 JSON（Schema V1）。
- 对话槽：`summary_to_markdown` 渲染投影（token 经济 + 历史兼容）。
- 校验：`validate_summary_document`（serde_json 解析 + required 校验 + budget 检查，不引入新依赖）；删除行前缀字符串匹配校验。
- Schema V1 要点：required = schemaVersion/blockId/tier/height/droppedIds/goal/constraints/progress/decisions/nextSteps/criticalContext；`additionalProperties: true`（AI 自由扩展）；结构化字段 paths[] / signatures[] / counts{}；`custom` 自由面；`height` 每轮合并 +1。

### 5.2 L1 → 句柄 stub（04 §4 采纳，R-E/R-F 修正）

- AgentMessage 面删除 `summary_placeholder`（lib.rs:749-752）；旧 Message 面保留。
- 新 `stub_placeholder`：确定性生成 `> ⏳ 摘要生成中 (block {id}) — 合并 N 条消息，可用 search_context 检索`；`metadata` 写 `{summary: {blockId, state, droppedIds, height}}`。
- stub 一旦生成永不改写（R-C）：摘要就绪 → 表 + 事件；模型经工具取。

### 5.3 existing 迭代合并升级（04 §6.3 采纳）

- existing 从"链尾文本"（T-07）解析优先 `compression_blocks`（height/state），stub 文本兜底；
- 合并语义 = 字段级（旧文档 + 新 dropped 增量 → 新 JSON height+1），非文本拼接；
- 失败不覆盖既有文档（state=retired 仍可从表读）。

### 5.4 重试策略（R-F 采纳）

```
压缩触发（Regular/overflow）
  → 同步尝试一次 Summarizer（可用时）
  → 成功：摘要文本写链（冻结）＋ summary_json 写表（committed）
  → 失败/无注入：stub + 后台单飞任务
     退避 1s/3s/9s（±20% jitter，session_meta 可配 compact_summary_backoff_ms）
     成功 → committed（写表 + context-summary-ready 事件，对话 stub 不动）
     失败 ×4 → retired（attempts=4 落表；下轮压缩 existing 续试）
全局并发上限 MAX_CONCURRENT_SUMMARY_TASKS=2；429 分类直 retired；临界线只 stub 不 spawn
```

### 5.5 摘要调度器（session-loop 新文件 summary.rs）

- 会话级单飞（`LoopState.summary_state: Option<SummaryTaskState>`）；
- Summarizer 按 session 实例化（避免 RetryGuardSummarizer 跨会话 Mutex 串扰）；
- 完成回调由壳层注入（写库钩子）；事件 `context-summary-ready`。

---

## 6. 可恢复/可搜索工具（agent-tools）

### 6.1 search_context（只读）

- 语义（对照 billion search-tool.ts:63-67）：只搜"已压缩消息 + 块摘要"（`compression_blocks`），不搜上下文可见消息；
- 命中返回：块索引条目（blockId/summary 片段/droppedIds 前 N/所属 generation）+ 恢复指令；
- 实现：session-loop 暴露只读"会话压缩上下文"查询（块索引 + 原文提取内部 API），agent-tools 经注入 LocalDb 访问（先例：wait_subagents.rs:1506、revert_guard.rs:21-23）。

### 6.2 decompress_context（只读）

- 语义（对照 billion decompress-tool.ts:36-37,186-199）：恢复是读操作回放，**不替换对话、不动上下文前缀**；
- 输出面：默认落文件（读工具再读），`inline: true` 显式接受上下文开销；`full`/`toFile` 参数化；
- 原文来源：`message-end` 事件流按 dropped_ids 回放提取（01 §1.4 关键事实：事件流 append-only，原文其实都在）。

### 6.3 注册与权限

- 只读注册（dangerous=false），进子 Agent 只读工具集（R9 裁决：是）；
- 经既有中间件审计（agent-tools middleware/permission）。

---

## 7. 新能力：project_tree 与 clean_output（03 采纳）

### 7.1 project_tree（agent-tools/src/tools/project_tree.rs 新建）

- 参数：path（resolve_workspace_path 校验）/ depth（≤MAX_WALK_DEPTH=16，缺省 3）/ includeFiles / dirsOnly / excludeGlobs / maxItems(缺省 400) / maxDepthContent(缺省 4)；
- 输出：树形文本（`├──/└──/│` 前缀，目录优先 + 字母序）+ JSON 计数 {root,depth,dirs,files,shown,collapsedNodes,truncated}；
- 懒构建缓存：进程级 `LazyLock<Mutex<HashMap<CacheKey, Arc<CacheEntry>>>>`；键=(canonical_root, depth, includeFiles, dirsOnly, excludeGlobs 排序串)；值=树节点+目录指纹表（dir mtime+entry_count）；指纹校验只 re-stat（毫秒级）；失效=目录级重建；同键并发持锁去重；
- SKIP_DIRS 提为 `pub(crate)` 复用（search.rs:26-35，node_modules/.git/target/dist/build/.next/.turbo/.cache）；
- token 约束：maxItems 折叠 `+N 项` 标记、超深目录折叠行、maxLineChars=120 字符边界截断；折叠不变量：被折叠信息量 = collapsedNodes 计数（AI 可据计数加深）；
- **绝不注入**：树作为工具结果=历史消息进入前缀，之后每轮 0.1x 命中；注入则每轮全价 miss + 注意力分散 + 前缀变异（02 §4.3 论证）；
- "最近改动文件周边树"（focus 参数 + 近 N 小时 mtime 高亮）列为**独立演进项不排期**（02 §2.7 不确定性：时间窗口未定/指纹耦合/收益未量化）。

### 7.2 clean_output（conex-compaction/src/clean_output.rs 新建，纯函数）

- R1-R6 规则：脱 ANSI/控制字符（状态机字节安全）→ 行尾空白 → 空行合并（至多 1）→ 重复行折叠（完全相等；3+ 连续 → `… 重复 N 行 …`）→ 超长行截断（char 边界）→ JSON 压缩（text 通道大 JSON 重 compact；json 通道不动）；
- 管线序：`clean → truncate → 发 AI`（清洗在前截断在后，唯一正确序）；
- **原始输出永远落库**：tool-result 消息/事件保持原始字节；清洗只作用 wire 副本（确定性，防前缀漂移）；
- 留痕：`ToolOutputCleanupRecord`（cleaned/originalBytes/cleanedBytes/tokensSaved/rulesApplied），随截断记录并行落 events；
- token 量化口径：N=100 采样 count_tokens(raw) vs count_tokens(clean)，分量估算法；预期 8-40%，上限场景 50%+；
- 接线：executing_tools.rs:142-176（tool_result_message/tool_output_from_result，与 G8 截断接线同点）。

---

## 8. 注入卫生清单（02 §四 采纳，写死为纪律）

| 内容 | 允许位置 | 禁止位置 |
|---|---|---|
| 时间戳/时间线 | 最新 user 消息正文尾部 / 追加为对话末尾新 user 消息 | system prompt 任何位置 / tools schema / 既有消息改写 / 链内 |
| 目录树 | 仅 project_tree 工具（结果=历史消息） | 每轮 user 文本注入 / system / 首条消息 |
| 动态统计/会话上下文 | 尾部 user 注入块 | system |

判据：内容被回放第二次时字节必须完全一致，或位于 LCP 之外。

---

## 9. 测量增强（conex-telemetry + cache_tracker，02 §五采纳）

| # | 位置 | 改动 |
|---|---|---|
| T-25 | telemetry signature.rs 新增 | `prefix_diff_index(prev, cur) -> Option<PrefixDiff{kind, index}>`（首个差异定位，不动 classify 8 变枚举） |
| T-26 | cache_tracker.rs:74-108 | 增 `pending_compaction: bool` / `rebuild_signature: Option<RequestSignature>` |
| T-27 | cache_tracker.rs:237-242 | on_compaction 置 pending（保留代数+1/基线作废） |
| T-28 | cache_tracker.rs 新方法 | `rebuild_after_compaction(system, tools, messages)`：压缩后签名 → rebuild_signature |
| T-29 | cache_tracker.rs:178-234 | record_usage 首无基线+pending → 签名比对（同=正常归因 Compaction；异=harness 二次改写诊断 warn + PrefixChanged）→ 清 pending |
| T-30 | handlers/mod.rs:379-381 | cache_boundary 填充（stable_prefix_hash = 压缩后签名 messages_hash，类型已存在 tool.rs:433-450 无需事件 changelog） |

可选：恢复曲线 KPI（压缩后第 1/5/10 请求命中率）→ RunCacheStats 备选字段（后置，不阻塞）。

---

## 10. 统一 Task 清单（全局编号，评审后派发）

> 行号基于 2026-08-08 实读；实施时以 `P7 fold chain` 等注释锚点复核。

### 轮次 1：引擎核心（crates/conex-compaction，单 Agent 串行）
| # | 文件 | 动作 |
|---|---|---|
| T-01~T-05 | lib.rs find_cut_point_inner | 折叠链钳制（§4.2） |
| T-06~T-10 | lib.rs compact_agent_messages | 链排除/existing/组装/id/Plan 字段（§4.3） |
| T-11 | lib.rs 新 recovery 子模块 | 块结构 + 槽位文本（块引用行）+ generation |
| T-12 | summary_document.rs 新建 | JSON Schema V1 校验/渲染/兼容解析 |
| T-13 | lib.rs + ai_summary.rs | stub_placeholder 替换 L1（AgentMessage 面）；existing 升级 |
| T-14 | clean_output.rs 新建 | R1-R6 + CleanupOptions/Result/Record |

### 轮次 2：持久层（conex-db + orchestrator，单 Agent）
| # | 文件 | 动作 |
|---|---|---|
| T-15 | conex-db schema.rs + migrate.rs | v7：`compression_blocks` 单表（R-A 合并列） |
| T-16 | conex-db 新模块 | put/get/list/mark_state + 原文提取（事件回放） |
| T-17 | conex-types tool.rs | ContextCompressionRecord.details 扩展（blockId/generation/prevBlockId/droppedAtMs） |
| T-18 | orchestrator persist/restore | 块写入接线 + generation 持久化恢复（对齐 last_compaction_at 模式） |

### 轮次 3：执行层接线（session-loop，单 Agent）
| # | 文件 | 动作 |
|---|---|---|
| T-19 | handlers/mod.rs apply_compaction | 块元数据织入 + T-30 cache_boundary + rebuild_after_compaction 调用 |
| T-20 | summary.rs 新建 | 摘要调度器（单飞+退避+状态机） |
| T-21 | handlers/mod.rs LoopState | summary_state 字段 |
| T-22 | prepare_turn.rs + stream_error.rs | Regular/overflow 接线（同步先试一次 + spawn 单飞；临界线只 stub） |
| T-23 | executing_tools.rs:142-176 | clean → truncate 接线（wire 副本，原始落库） |
| T-24 | 时间线注入点 | 尾部 user 消息卫生断言（首尾双约束） |

### 轮次 4：工具面（agent-tools，单 Agent）
| # | 文件 | 动作 |
|---|---|---|
| T-25 | search.rs | SKIP_DIRS 提 pub(crate)；walker_for_root 抽取 |
| T-26 | project_tree.rs 新建 | 工具 + TreeCache（懒构建/mtime/并发） |
| T-27 | mod.rs | 注册 project_tree（17→18 计数同步） |
| T-28 | search_context 工具新建 | 只读，查 compression_blocks |
| T-29 | decompress_context 工具新建 | 只读，事件流回放 |

### 轮次 5：测量增强（conex-telemetry + cache_tracker，单 Agent）
| # | 文件 | 动作 |
|---|---|---|
| T-30 | telemetry signature.rs | prefix_diff_index |
| T-31 | cache_tracker.rs | pending_compaction/rebuild_signature/比对逻辑 |

> 轮次间依赖：1→2→3 强依赖（链→表→接线）；4 的 T-25~T-27 与 5 可并行；T-28/T-29 依赖轮次 2。每轮实现后跑对应 crate 测试 + `cargo test --workspace` 全量。

---

## 11. 测试与门禁（评审 Agent 重点核验）

### 单元测试（引擎）
1. `fold_chain_is_frozen_across_compaction`：二次压缩后链内消息逐字节相同、均在 kept_ids
2. `cut_never_goes_below_fold_start`：多轮压缩 first_kept 单调
3. `budget_scan_starts_after_chain`：链 token 超 keep_recent_tokens 仍正常压缩
4. `tool_pair_protection_clamps_to_chain`：孤儿 ToolCall 在链内 → None
5. `summary_ids_increase_monotonically`：ids = -1/-2/-3
6. `chain_never_in_dropped_ids`
7. `validate_summary_document`（合法/缺字段/custom 扩展）+ `summary_to_markdown`↔兼容解析往返
8. `stub_placeholder` 确定性 + 预算截断
9. clean_output 7 项（ANSI/C0/空行/去重/超长/json/确定性）
10. project_tree 8 项（形状/SKIP/exclude/maxItems 折叠/mtime 失效/键隔离/深度钳/路径越界）

### 集成测试
11. `two_compactions_keep_chain_bytes_stable_in_wire`（P1 E2 codex 断言模式）
12. `compaction_end_carries_cache_boundary`
13. 压缩 → 事件流回放原文 → 与压缩前逐字节一致（golden）
14. search_context 只返回块索引不返回可见消息
15. 摘要调度器：单飞（两触发 1 任务）、退避序列、retired 转发、existing 带 stub 文本
16. v7 迁移链（fresh v5→v7、旧库 v6→v7 幂等重跑）

### 门禁铁律（AGENTS.md）
- `reference/markdown-editor` 的 `npm test` 必须保持全绿（本方案不触碰该目录）
- 主仓库 tests/e2e 5 个 markdown-editor 专项 spec 禁止删除
- `cargo test --workspace`（73 套件基线）+ 前端 `npm run typecheck` + 快层 unit coverage 不回归
- 中文注释、UTF-8 无 BOM

---

## 12. 风险登记

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| 1 | 链无限增长（长会话 100 次压缩 ≈ 100K token 链） | 中 | max_summary_tokens=1024 钳制；链占窗口 60% 触发"计划级重建"（整链折叠为一条全量摘要，受控一次性 break，列为未来演进）；恢复曲线 KPI 观测 |
| 2 | 服务端 LRU 容量丢弃链头部 | 中 | 恢复曲线兜底；链过长主动降 keep_recent_tokens |
| 3 | L2 非确定性 → 链文本写一次冻结 | 低 | B1 测试 + dropped 断言 + existing 只读链尾文本 |
| 4 | 协议形状：无 system 消息时链 = 消息间首条 | 中 | P4 "以 user 收尾"扩展为"首尾双约束"水合断言 |
| 5 | 旧格式 `compacted-summary-{n}` 混会话 | 低 | starts_with 前缀兼容；迁移期单一运行窗口 |
| 6 | 摘要异步 → 首轮压缩后立即继续看不到全文 | 中 | stub 明确"生成中"；同步先试一次最大化首轮即成功概率 |
| 7 | events 表原文依赖未来事件裁剪 | 中 | 裁剪策略立项时列入约束；V2 块表落原文快照 |
| 8 | 事件回放提取性能（无消息 id 索引） | 低 | V1 接受（块级低频）；V2 message_seq 辅助索引 |
| 9 | 多会话并发摘要打爆 provider | 中 | 全局上限 2 + jitter + 429 分类 retired |

---

## 13. 本轮执行路线（评审通过后）

1. 评审 Agent 2 名（并行，只读 + 各自一份评审文档到 `30-review/`）
2. 主控整合评审意见 → 本文件 v1.0
3. 派发实现：轮次 1（引擎）→ 轮次 2（持久层）→ 轮次 3（接线）串行；轮次 4/5 视依赖并行
4. 每轮：实现 + 该 crate 测试 + 全量门禁
5. 收尾：00-index.md 登记 + 事件 changelog 登记 + 汇总报告

（完）
