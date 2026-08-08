# 记忆韧性与缓存命中（Memory Resilience & Cache Hit）一体化实施方案 v1.1

> 目录：`docs/cache-optimization/05-memory-resilience/20-plan/00-integrated-plan.md`
> 版本：v1.1（整合双评审意见修订稿：评审 01 一致性/落地性 + 评审 02 架构/不变量）
> 输入：`10-analysis/01~04` 四份分析 + `30-review/01`、`30-review/02` 两份评审
> 性质：纯方案文档；评审通过后按轮次派发实现 Agent
> **实施状态：v1.1 已实施完成（轮次 1-7）**——轮次 1-6 代码全部落地并全量门禁绿
> （`cargo test --workspace` 89 块 EXIT=0），轮次 7 回归/文档登记完成（2026-08-08）；
> 剩余 V2 挂账与外部验证见文末「实施状态」小节。

---

## 0. 一页总览

| 维度 | 结论 |
|---|---|
| 核心机制 | 压缩产物升级为 **append-only 冻结折叠链**（fold chain），B1-B4 不变量；压缩只破坏"链尾之后新增区"，system+链成为跨压缩稳定可命中的长前缀 |
| 记忆在线 | 压缩块（block）落库 `compression_blocks` 表 + 事件流原文回放；`decompress_context` / `search_context` 只读工具，可追溯可恢复 |
| 摘要层 | L1 占位符删除，改中性句柄 stub（永不改写）；摘要以 JSON 为规范面落表、markdown 投影一次性进链（同步成功路径）；后台单飞+指数退避，会话级生命周期 |
| 缓存命中 | 折叠链冻结 + 切割点链下界钳制 + 压缩后签名重建 + 前缀差异定位（prefix_diff）+ generation 单源 |
| 注入卫生 | 时间戳/时间线只进尾部 user 消息；目录树一律工具化（project_tree） |
| 新能力 | project_tree 工具（懒构建+mtime 失效+共享缓存）；clean_output 清洗（送 AI 前脱 ANSI/压空行/去重/JSON 压缩，wire 面统一应用） |
| DB | v7 迁移新增 `compression_blocks` 单表（R-A 合列）；PRIMARY KEY (session_id, block_id) |

---

## 2. 目标与验收（用户需求映射）

| 用户需求 | 落点 |
|---|---|
| 可追溯/可恢复（decompress + search） | §5 压缩块 + §7 两工具 |
| 结构化摘要改 AI 可扩展 | §6.1 JSON Schema（required 骨架 + custom 自由扩展 + paths/signatures/counts 结构化） |
| 去 AI 思考、保正文+工具链路 | §4 折叠链（正文+tool 对是稳定前缀）；AI 仅控制"是否把某工具输出并入摘要"（dropped 权重） |
| L1 占位符不必要 → 达阈值一直尝试 AI 压缩 | §6.4 重试策略（同步先试+会话级后台退避+跨轮续试）；stub 只是确定性句柄 |
| 用户消息时间线 | §9 注入卫生（时间线=最新 user 消息尾部或追加新 user 消息，绝不进 system） |
| 记忆始终在线+命中率足够高 | 折叠链冻结=记忆字节永久命中；块+工具=记忆语义在线 |
| 目录树工具（排除/深度/多 agent） | §8.1 project_tree |
| 命令输出清洗省 token | §8.2 clean_output（R1-R6，清洗在 wire 面统一应用） |

---

## 3. 主控交叉点裁决（v1.1 含评审修订）

| # | 裁决 | 内容 |
|---|---|---|
| R-A | 单表合并 | `compression_blocks` 同时承载块元数据 + 摘要文档（summary_json/schema_version/height/tier/state/attempts 合列）；**PRIMARY KEY (session_id, block_id)**；写入 = INSERT OR IGNORE（压缩时创建，幂等）+ UPDATE 推进（调度器成功时） |
| R-B | 块 id 与消息 id 同名 | **统一为 `compacted-summary-{generation}-{fold_index}`**（消息 id 保持 `compacted-summary` 前缀兼容，starts_with 检测不断） |
| R-C | stub 永不改写 | 摘要就绪只写表+事件（不新增事件类型，见 R-H）；对话内 stub 文本冻结 |
| R-D | 工具命名 | `decompress_context` + `search_context` |
| R-E | L1 删除范围 | AgentMessage 面删、旧 Message 面保留 |
| R-F | 同步优先 | 同步裸 Summarizer 单次尝试（短墙钟 IC ）＋异步后台退避；见 §6.4 |
| R-G | 摘要语源唯一 | 链内文本 = 对应文档的 markdown 渲染（同步成功路径）/ stub 中性文本（未就绪 / 无注入）；`summary_json` 表为 JSON 规范面；existing 优先级 = 表文档（committed 时）> 链尾文本（stub 时） |
| R-H | 事件纪律 | **不新增事件类型**：摘要就绪不落新事件（压缩事件 details 增 summaryState）；清洗记录随 telemetry 内部统计，V2 再评估事件化 |
| R-I | 会话级调度器 | 摘要任务（JoinHandle/backoff/attempts）挂在**会话级容器**（与 SessionHistoryCache 同生命周期，壳层 CoreRunState），run 只触发/登记；run 收口不摧毁任务 |
| R-J | 接线点 | clean_output 在 **wire 序列化面**（build_request / to_chat_messages 映射），不在记录面；落库/事件 raw，wire 面清洗 |
| R-K | generation 单源 | 复用既有 `SessionContextMeta.last_compaction_generation`（conex-types/context.rs）为唯一代数源；tracker 消费不自增 |
| R-L | 逃生舱例外 | B1 声明"正常生命周内不可改写；唯一例外=计划级重建（res set）"，触发＝KPI 观测（链 token 窗口占比），reset 时 prev_block_id 指向旧链尾保留追溯 |

---

## 4. 折叠链引擎（core）

### 4.1 不变量（测试钉死）

- **B1 冻结**（含 R-L 登记）：
  - 正常路径：链消息（compacted-summary 前缀，含 stub）一经写入永不修改/丢失/折叠。
  - 唯一显式例外 = **逃生舱 chain reset**：窗口 60%（R-观测漏洞）由 KPI 观测触发；执行走专门代码路径（整链折叠为一条全量文档，prev_block_id 指向旧链尾）；与 compression_blocks 衔接（reset 块的 prev_block_id=旧链尾块，保留可追溯）。
- **B2 单调**：本次 cut ≥ 上次 cut，永不越过链尾；**适用域声明**：本不变式作用于"水合上下文含完整链"的主路径；前端兜底水合（无链冷启动）为已知降级（首压缩 id 从低位起，测试覆盖）。
- **B3 只增**：每次压缩至多新增 1 条摘要消息，fold_index=链长+1，id=`compaction-summary-{gen}-{fold}`（R-B）；统计状态从消息数推导，跨 run 天然恢复；fold_index 在 reset 后新代数 offset 重计（登记，不实现）。
- **B4 形状**：链紧邻 system；链后=保留区（以 user 收尾，P4 水合约束）。

压缩后前缀：`[system 冻结][摘要1][摘要2]…[摘要K][tail 原文]`

命中率：K 次压缩后任意相邻请求 LCP = system+全部链，链累计随记忆增长，不随压缩作废。

### 4.2 切割点钳制（find_cut_point_inner 五处）

| # | 位置 | 修正 |
|---|---|---|
| T-01 | lib.rs:544 体开头 | 计算 `fold_start`（system 后首个非 chain 下标） |
| T-02 | :559-568 尾部倒推 | 区间 `[fold_start, len)`；未达预算 → None |
| T-03 | :570-575 | `cut==0→None` 改 `cut<=fold_start→None` |
| T-04 | :577-592 min_recent_turns | 下界钳，`cut<=fold_start→None` |
| T-05 | :594-636 tool 配对回扫 | 下界 `fold_start`；`needed<=fold_start→None` |

### 4.3 compact_agent_messages 修正

| # | 位置 | 修正 |
|---|---|---|
| T-06 | :448-452 dropped_id | 排除 compacted-summary 前缀（链永不入 dropped） |
| T-07 | :459-464 existing | 链尾最后一条摘要文本（stub 或 md 渲染皆可） |
| T-08 | :496-516 组装 | system + 链全查 + 新摘要 + tail |
| T-09 | :502-503 摘要 id | 新格式（R-B）+ fold_index 链尾推导；删掉 dropped 数耦合 |
| T-10 | :524-533 CompactionPlan | 增链字段：fold_chain_prev/after/block_id/generation |

### 4.4 块结构（conex-compaction recovery 模块）

```rust
CompactionBlockMeta {
    session_id: SessionId,
    block_id: String,                    // "compac-compact-{gen}-{fold}"
    sequence: u64,                       // context-compression-end 事件序列号
    generation: u32,                     // 会话级代数（R-K 单源）
    prev_block_id: Option<String>,       // 自动生成 / reset 链
    dropped_message_ids: Vec<String>,
    first_kept_message_id: Option<String>,
    summary: String,                     // 链内文本（md 渲染或 stub）
    summary_is_llm: bool,
    tokens_before: u64, tokens_after: u64,
    dropped_at_ms: i64,                  // eval 时
    state: SummaryState,                 // awaiting | committed | retired
    summary_json: Option<String>,        // 提交后 JSON letter
    schema_version: u32,
    height: u32,                          // 树高度，每次折叠 +1
    tier: Option<String>,
    attempts: u32,                        // 累计尝试（含同步）
    created_at: i64, updated_at: i64,
}
```

块引用行（链内机器可读）：
`[Compacted 12 earlier message(s) · block {block_id} · generation {g} · alias: decompress_context(blockId={block_id})]`

---

## 5. 缓存机制设计（测量面）

### 5.1 签名重建（cache_tracker + telemetry）

| # | 位置 | 内容 |
|---|---|---|
| T-25 | cache_tracker.rs:74-108 | 增 `pending_compaction: bool` / `rebuild_signature: Option<RequestSignature>` |
| T-26 | cache_tracker.rs:237-242 | on_compaction 置 pending（保留 generation+1 但单源化见 T-31） |
| T-27 | cache_tracker.rs:178-235 | record_usage（时序）判断 joined（rebuild + cur 前缀比对） |
| T-28 | cache_tracker.rs 新方法 | `capture_post_compaction(system, tools, messages)`（压缩后签名） |
| T-29 | cache_tracker.rs:178-235 | 首无基线后记录 usage：`prefix_diff_index(rebuild, cur)` 前缀型比对——**差异点仅在追加区（index ≥ rebuild 末）→ 正常；差异点在历史区 → PrefixChanged 诊断**；清 pending |
| T-30 | telemetry signature.rs | `prefix_diff_index(prev, cur) -> PrefixDiff{kind, index}`（首个差异定位，不动 classify 枚举） |
| T-31 | cache_tracker.rs | **R-K 单源化**：consume `LoopState.compact_generation`（或 SessionContextMeta）替代内部自增；保留 on_compaction 基线作废逻辑 |

**误报预防**：T-29 前缀型比对（T-30 提供仅首差异定位）＋"追加区豁免"，覆盖"压缩后首请求前对话被追加"场景（unique run 头部注入等）。

### 5.2 测量增强清理与 event 就绪

- v1.1 确认：pending_compaction 生命周期在 run 内；run 收口 pending 未消费时，下个 run tracker 新建 → pending 自然丢失 → 无挂起残留。
- 压缩后首请求的 wire 前缀 = 链消息字节（非 AgentMessage 本体：`content` 兜底不上 wire）——测试断言必须用 `TestProvider.requests()` 序列化字节。

---

## 6. 摘要层演化（AI 记忆在线）

### 6.1 规范面（JSON Schema V1）+ 投影

- required: schemaVersion/blockId/generation/droppedIds/height/tier/goal/constraints/progress/decisions/nextSteps/criticalContext
- structured：paths[]/signatures[]/fields{}；`additionalProperties: true`（AI 自由扩展），custom 自由面
- 渲染 `summary_to_markdown`：**确定性函数**（同文档同输出），用于：
  - R-G 场景 A（同步成功）：作为链文本写入对话（投影）
  - existing 合并时可读链文本（stub 或不完整）重建文档
- 兼容解析：旧格式文本（L1）可解析为最低骨架文档（legacy 兼容），**不删旧接口面**

### 6.2 L1 → 中性语义 stub（R-B/R-C/R-G）

- AgentMessage 面删除 `summary_placeholder`（lib.rs:750-752）；旧 Message 面（UI 预览）保留文本占位符
- 中性 stub（**无"生成中"设练**）：
  ```text
  > [Compacted(b{block_id}) N 条消息 · 摘要见块表]
  ```
  - where N = dropped 数；block 详情经 tool 可取；**永不改写**（R-C）
- `metadata` 写 `{summary: {blockId, state, droppedIds, height, generation}}` 快照
- 同步成功时例外：直接写 md 渲染（一次性，冰环）

### 6.3 existing 迭代合并（唯一引用系，R-G）

- existing 输入：链尾文本（T-07）→ 语义判定：stub 文本 → 合并时退化为"新 dropped 增量直接新增"；seek 片段非 stub → 解析旧文档 + 增量折叠 → 新文档（height+1）
- 表 committed 行优先（R-G 仲裁）
- 失败不覆盖既有文档（state=retired 仍可从表读）

### 6.4 重试策略（R-F 落地）

```
压缩触发（Regular/overflow）
 ├ 同步：裸 Summarizer 单次尝试（短墙钟 60s，单次调用不重试）
 │   ├ 成功 → 链= md 渲染（冻结）＋表 committed
 │   └ 失败/超时 → 表 awaiting + 中性 stub
 ├ 失败/无让位 → 后台会话级单飞任务：
 │  退避 1s/3s/9s（±20% jitter），单次调用墙钟 60s
 │  成功 → UPDATE（summary_json/state=committed/height）
 │  失败 ×4（attempts 累计）→ retired（attempts 落表）
 ├ 无 Summarizer 注入 → 不 spawn（不写 retirement），纯 stub awaiting 永驻
全局并发上限 MAX_CONCURRENT_SUMMARY_TASKS=2；429 → 立即 retired
attempts 口径：**累计总尝试**（含同步那次）；retired 阈值=4；跨轮续试从 4 起
```

### 6.5 会话级调度器（R-I 落地，跨 run 不破）

- 状态容器（single-flight JoinHandle/backoff_seq/attempts/last_outcome）挂**会话级**（壳层 CoreRunState 或 orchestrator 会话上下文，与 SessionHistoryCache 同生命周期）
- run 内触发点（prepare_turn/overflow）只做"登记+触发"：会话任务器去重（unstarted）后执行
- 完成回调以会话元数据为目标（写表+事件 details 标记）；**关 run 不摧毁任务**

---

## 7. 可恢复/可搜索工具（agent-tools，只读）

### 7.1 search_context

- 只搜"已压缩块（compression_blocks 会话作用域）"，不搜上下文可见消息
- 命中返回：块索引条目（blockId / summary 片段 / dropped 数 / generation / height）+ 恢复指引
- 参数：`query`（必）+ `limit`（缺 20）+ `sessionId`（缺省当前会话，校验作用域）
- 排序 generation 降序；keyword 匹配 summary_json 全文

### 7.2 decompress_context

- **读操作**：按 block_id 从 compression_blocks（+抵抗事件流回放）提取原文，**不替换对话、不动前缀**（I1 兼容，与 R-G 语源对齐）
- 输出面：`full`（默认落文件，output_dir 面）/ `inline: true`（短内容返回）
- **子 agent 只读集**：默认 inline（无写文件权）；落文件仅主 agent（需要 output_dir 解析服务 + 写权限面）
- 返回原文 = **原始字节**（不经 clean）——语义 document 化，防模型认知差
- v6 缺表降级：查询缺表返回空集 + warn（不 SQL 报错）

### 7.3 依赖注入（trait 面，R-J）

- agent-tools 生产依赖**不引入 conex-db**（保持叶子纪律）
- 定义 trait（agent-tools 侧）：`CompressionContextStore`（query_blocks/search/decompress/原文回放），引擎侧（conex-db / orchestrator）实现并注入
- 注入点遵循既有 example（context.rs Option + dyn trait）模式
- 只读注册（dangerous=false）进子 agent 只读集；search/decompress 调用走既有 audit/middleware 审计面

---

## 8. 新能力

### 8.1 project_tree（参数契约 + 懒构建缓存）

| 参数 | 缺省 |
|---|---|
| path | workspace 根 |
| depth | 3（≤16） |
| includeFiles / dirsOnly / excludeGlobs / maxItems | 400 / 4 内置 exclude |
| maxDepthContent | 4 |

输出：树形（`├──/└──/│`）+ JSON 计数（root/depth/dirs/files/shown/collapsedNodes/truncated）

缓存：进程级 `LazyLock<Mutex<HashMap<CacheKey, Arc<CacheEntry>>>>`；键={(canonical_root, depth, includeFiles, dirsOnly, excludeGlobs 排序串)}；值=树节点+目录指纹表（dir mtime + entry_count）；指纹失效只 re-stat；**条目级锁**（自定义 key→lock 表）避免整表互斥

SKIP_DIRS 提 `pub(crate)`（search.rs:26-35）共用：node_modules/.git/target/dist/build/.next/.turbo/.cache

**注入禁令**：树只作为工具结果（历史消息）进入前缀；绝不注入 system/user 每轮文本中

### 8.2 clean_output（R1-R6 + 稳定性保障）

| 规则 | 内容 |
|---|---|
| R1 | ANSI/控制字符剥离（字节安全状态机） |
| R2 | 行尾空白 |
| R3 | 空行合并（至多 1） |
| R4 | 重复行折叠（3+ 连续 → `… 重复 N 行 …`） |
| R5 | 超长行截断（char 边界，line cap 120） |
| R6 | JSON 压缩（text 通道大 JSON）

管线：clean → truncate → 送 AI；**wire 面统一应用**（R-J；to_chat_messages / build_request 面可重复计算、幂等、确定性）→ 历史回放与新增消息同路径 → 不产生前缀漂移

**落库/事件/工具返回 = raw 原文**（decompress 为 raw，见 7.2）

**预期收益**：8-40%，上限 50%+（>2000 行工具输出场景）

接线点：**wire 序列化函数内**（agent-provider message 转换面，P1 §3.4 的单出口）——不是 modes not 记录点（会污染共享 Arc 落库）；R-J

---

## 9. 注入卫生

| 内容 | 允许位置 | 禁止位置 |
|---|---|---|
| 时间戳/时间线 | 最新 user 消息正文尾部 / 追加新 user 消息 | system/既有消息改写/链内 |
| 目录树 | project_tree 结果（=历史消息） | 每轮注入 user/system |
| 动态统计 | 尾部 user 块 | system |

龙活判据：被回放第二次字节完全一致，或位于 LCP 之外。

---

## 10. 统一 Task 清单（全局唯一编号，按轮次）

> 行号以 2026-08-08 实读为准；实施时以注释锚点复核。

### 轮次 1：引擎核心（crates/conex-compaction，单 Agent）
| # | 文件 | 动作 |
|---|---|---|
| T-01~T-05 | lib.rs find_cut_point_inner | 链钳制（§4.2） |
| T-06~T-10 | lib.rs compact_agent_messages | 链排除/组装/id/Plan 字段（§4.3） |
| T-11 | recovery 子模块（新文件） | CompactionBlockMeta + 块引用行 + generation/composition |
| T-12 | summary_document.rs（新文件） | Schema V1 校验/渲染/兼容解析 |
| T-13 | lib.rs + ai_summary.rs | 中性 stub 替换 L1（AgentMessage 面）+ existing 升级合并 |
| T-14 | clean_output.rs（新文件） | R1-R6 + CleanupOptions/Result/Record（纯函数） |

### 轮次 2：持久层（conex-db + orchestrator）
| # | 文件 | 动作 |
|---|---|---|
| T-15 | conex-db schema.rs + migrate.rs | v7：compression_blocks 单表（R-A；PK (session_id, block_id)，两阶段写协议 INSERT OR IGNORE + UPDATE） |
| T-16 | conex-db 新模块 | put/get/list/mark_state + 原文回放提取（sequence 关联事件行） |
| T-17 | conex-types tool.rs | ContextCompressionRecord.details 扩展（blockId/generation/prevBlockId/droppedAtMs/summaryState） |
| T-18 | orchestrator persist/restore.rs | 块行创建（压缩时）+ generation 持久化 + restore 护栏重放对接（restore.rs:728-744） |
| T-19 | orchestrator | SessionContextMeta.compact_generation 单源接线（R-K：traker 消费面） |

### 轮次 3：测量增强（cache_tracker + telemetry）
| # | 文件 | 动作 |
|---|---|---|
| T-25 | telemetry signature.rs | prefix_diff_index（三态：无漂移/追加/前缀） |
| T-26~T-29 | cache_tracker.rs | pending 字段 + capture_post_compaction + 前缀版比对 + 清理 |
| T-30 | cache_tracker.rs | generation 消费单源（R-K on_tracker_consumption） |

### 轮次 4：执行层接线（session-loop，依赖轮次 2/3）
| # | 文件 | 动作 |
|---|---|---|
| T-31 | handlers/mod.rs apply_compaction | 块元数据织入 + cache_boundary 填充 + capture_post_compaction 调用 |
| T-32 | handlers/mod.rs | 会话级摘要触发侧（登记/唤醒，不做 run 任务） |
| T-33 | 新文件 summary_dispatch.rs | 触发方：同步先试 + 失败 spawn（借 R_ 状态注入） |
| T-34 | wire 序列化面（build_request / to_chat_messages） | clean_output 统一应用（R-J），raw 不变 |
| T-35 | prepare_turn + overflow 点 | 时间线尾部注入卫生断言（普通注入） |
| T-36 | 水合/首尾双约束断言 | 无 system 会话链首条约束 + 引擎兜底（tail 首非 user 时跳过压缩报 warn） |

### 轮次 5：工具面（agent-tools，依赖轮次 4）
| # | 文件 | 动作 |
|---|---|---|
| T-37 | search.rs | SKIP_DIRS pub(crate) + walker_for_root 抽提 |
| T-38 | project_tree.rs（新） | 工具（参数契约 + 懒缓存 + 同键锁，防止式全表互斥） |
| T-39 | mod.rs 注册 | project_tree（计数 17→18） |
| T-40 | CompressionContextStore trait + dam规范search_context | 只读块检索（session 作用域） |
| T-41 | decompress_context | inline/fallback 参数化 + 原文回放（raw 字节） |

### 轮次 6：会话级调度器 + 壳层（跨会话，依赖 T-32/33 触发面）
| # | 文件 | 动作 |
|---|---|---|
| T-42 | 会话级容器（CoreRunState / orchestrator 会话上下文） | 摘要任务状态（JoinEvent/backoff/attempts）挂会话；run 收口不摧毁 |
| T-43 | 壳层 Summarizer 注入（apps/agent-workbench + SummarizerFactory 对齐） | 真实注入；无注入 → 不 spawn（纯 await stub） |
| T-44 | 配置面 | session_meta 可配键：compact_summary_backoff_ms / compact_l1_placeholder（回退开关，默认 new） / wallclock cap |

### 轮次 7：回归与收尾
| # | 动作 |
|---|---|
| T-45 | 全量测试门禁（cargo 各 crate + 集成 + events_schema_consistency） |
| T-46 | 事件/迁移/兼容文档（v7、details 字段、schema changelog 登记）；无新增事件类型确认（R-H） |
| T-47 | 手工验证（真机压缩 → 命令 cacheRead 恢复曲线观测） |

执行序：先进 1 独立（引擎纯函数，Rust 门禁），再 2（表/事件），再 3（测量），再 4（接线，依赖 2+3），5/6 可并行（5 依赖 2 的 trait 路径，6 依赖 4 触发面），7 收尾（观测 KPI（非阻断）。

---

## 11. 测试与门禁

### 引擎层（conex-compaction 内联测试）
1. `fold_chain_is_frozen_across_compactions`：二次压缩链消息字节不变（`wire 级`：two_compactions_keep_chain_bytes_stable_in_wire，用 requests() 序列化字节）
2. `cut_never_below_fold_start`：多轮压缩 first_kept 单调
3. `budget_scan_starts_after_chain`
4. `tool_pair_protection_clamps_to_chain`
5. `summary_ids_increase_with_gen`（含 generation 段格式正确）
6. `chain_never_in_dropped_ids`
7. `validate_summary_document` 骨架/合法/custom 扩展
8. `summary_to_markdown` ↔ 兼容解析往返
9. `stub_matches_file_text_deterministic`（确定性/预算截断/中性文案）
10. clean_output 7 项（ANSI/C0/空行/去重/长行/json/确定性）
11. project_tree 8 项（形状/SKIP/exclude/maxItems 折叠/mtime 失效/键隔离/深度钳/越界路径）

### 集成与 DB
12. 二次压缩链字节稳定（wire 序列化断言）
13. 压缩事件 → 回放原文 → 与压缩前逐字节一致（golden，restore.rs 既有模式）
14. compression_blocks 幂等：同 (session_id, block_id) 重写不重复行；同 dropped 重放不重复（INSERT OR IGNORE 语义）
15. details 扩展 shape 回环（camelCase）
16. v7 迁移链（fresh v5→v7、v6→v7 幂等重跑）
17. 事件 schema 一致性回归 EVENTS_CHANGES（41 变体基线不变；详情只字段级扩展）→ R-H 验证
18. 会话级调度器：单飞（同会话双触发 1 任务）、退避序列、retired 转发、跨 run 任务存活
19. 摘要报告后 stub 字节不变（R-C 语义）
20. 多会话并发摘要 ≤2 上限 + 不串扰

### 手工验证
- 真机 DeepSeek 3 轮 + 压缩，观测 cacheRead 恢复曲线（T-47）

### 门禁铁律（AGENTS.md）
- reference/markdown-editor 全绿；tests/e2e 5 专项 spec 不删
- cargo test --workspace（73 套件基线）+ 前端 typecheck + 快层 unit coverage

---

## 12. 风险登记

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| 1 | 链无限增长 | 中 | max_summary_tokens=1024 钳制；逃生舱 R-L（KPI ≥60% 触发，reset 后可追溯） |
| 2 | 服务端 LRU 分层容量丢弃链 | 中 | 恢复曲线兜底 + generate 压缩档 |
| 3 | L2 非确定 → 链文本写一次冻结 | 低 | B1 测试 + existing 只读链尾 |
| 4 | 协议形状：无 system 链首条 | 中 | T-36 引擎兜底（跳过压缩 warn） |
| 5 | 旧格式混会话（compacted-summary-{N}） | 低 | starts_with 前缀兼容；`{gen}` 参与新格式；迁移单窗口 |
| 6 | nb 无线注入（生产默认 None） | 中 | 纯 stub（awaiting）不 spawn；壳层席位 T-43 |
| 7 | events 表原文依赖未来裁剪 | 中 | 裁剪立项时列入约束；V2 快照 |
| 8 | 回放性能（无消息 id 索引） | 低 | V1 接受（块级低频）；V2 message_seq 辅助索引 |
| 9 | 多会话并发摘要 | 中 | 上限 2 + jitter + 429 retired |
| 10 | clean 接线层设错（污染入 Arc） | 高 | R-J 强制 wire 单出口；golden 双请求测试 |
| 11 | 新事件类型注册失败 | 中 | R-H 不变；详情字段扩展齐套校验 |
| 12 | 旧库被新代码读（缺表） | 中 | 查询降级返回空+ warn（7.2） |
| 13 | 前端感知（stub vs md 展示） | 低 | 轮次 7 挂账 UI 展示路径（块表查询） |

---

## 13. 本轮执行路线（同意后执行）

1. 评审 01/02 意见已合入（→ v1.1）✅
2. 派发实现 Agent：按轮次 1→2→3→4→5/6→7（每轮一个 agent，串行；5/6 并行）——执行前通知用户并确认轮次批次
3. 每轮：实现 + 该 crate 测试 + 全量门禁（cargo test workspace + typecheck）
4. 收尾：测试补件 7 + 事件 changelog 登记（确认无新增事件）+ 00-index 登记 + 汇总报告

---

## 14. 实施状态（轮次 1-7 收尾登记，2026-08-08）

> 轮次 1-6 代码落地完成，`cargo test --workspace` 全绿；轮次 7（T-45 回归 / T-46 文档登记
> / T-47 手工验证）完成情况与 V2 挂账清单见下。本小节由收尾 Agent 维护，后续轮次更新时
> 同步修订版本注记。

### 14.1 轮次完成矩阵

| 轮次 | 内容 | 状态 |
|---|---|---|
| 1 | 引擎核心（conex-compaction 折叠链/块结构/JSON 摘要/stub/clean_output） | ✅ 完成（98 测试绿） |
| 2 | 持久层（conex-db v7 migration + blocks.rs；conex-types details 扩展；orchestrator persist/restore） | ✅ 完成（conex-db 99 / conex-types 168 / orchestrator 299 绿） |
| 3 | 测量增强（telemetry prefix_diff_index；cache_tracker pending/rebuild/比对） | ✅ 完成（telemetry 全绿） |
| 4 | 执行层接线（session-loop apply_compaction + summary_dispatch + agent-provider wire 清洗 + 护栏） | ✅ 完成（session-loop 344+67 / agent-provider 512+29 绿） |
| 5 | 工具面（agent-tools project_tree/search_context/decompress_context/CompressionContextStore/只读集 9/计数 20） | ✅ 完成（agent-tools 556+14 绿） |
| 6 | 会话级调度器 + 壳层（summary_coordinator + orchestrator update_compression_block_summary + CoreRunState 装配 + engine SummarizerFactory） | ✅ 完成（`cargo test --workspace` 89 块全绿 EXIT=0） |
| 7 | 回归与收尾（T-45 全量门禁 / T-46 文档登记 / T-47 手工验证） | ✅ T-45/T-46 完成；T-47 待外部验证（见 14.3） |

### 14.2 收尾登记（T-46）

- **事件纪律（R-H）**：无新增事件类型——events_schema_version.rs 基线 41 变体未变；
  `ContextCompressionRecord.details` 仅字段级 camelCase 扩展（blockId/generation/
  prevBlockId/droppedAtMs/summaryState），已登记 `docs/rust-rewrite/33-event-schema-changelog.md` §四。
- **DB 迁移**：v7 `compression_blocks` 单表（PRIMARY KEY (session_id, block_id)）已登记
  `docs/rust-rewrite/UPGRADING.md` §3.2（补 v5/v6/v7 三行）。
- **文档索引**：05-memory-resilience 目录已登记 `docs/cache-optimization/00-index.md` §7。

### 14.3 挂账清单（V2 / 外部验证）

| # | 挂账项 | 归属 | 说明 |
|---|---|---|---|
| 1 | 摘要任务表写入经回调落库 | **已核实**（V1 闭环） | 壳层 CoreRunState 默认回调已装配 orchestrator::blocks 面（update_compression_block_summary），
   实测 T-42 会话级默认回调落库面（summary_coordinator.rs 测试 registry_default_callback_receives_outcome）；无缺口 |
| 2 | compact_l1_placeholder 仅文档化 | V2 | session_meta 读取面已接线（core_run_commands.rs T-44），运行时双态切换需引擎支持，V1 不实现 |
| 3 | 会话删除清理协调器注册表 | V2 | registry.remove() 已实现（summary_coordinator.rs:259），壳层会话删除路径未接线 |
| 4 | 后台回调同步 DB 写 → 异步化 | V2 | V1 回调内同步写表（或经 orchestrator 面）；异步化（队列/批量）列为 V2 |
| 5 | 真实 provider Summarizer 产品实现 | V2 | 壳层注入通道（set_summarizer_factory / SummarizerFactory）已打通；生产装配点
   （session.start / provider 配置加载）与真实 provider 调用实现属产品功能 |
| 6 | 逃生舱 chain reset | V2 | R-L 已登记（B1 唯一显式例外，KPI ≥60% 窗口触发）；prev_block_id 指向旧链尾保留追溯 |
| 7 | 旧格式混会话迁移窗口 | 风险 5 | starts_with 前缀兼容 + `{gen}` 参与新格式；迁移单窗口，V1 已做兼容解析 |
| 8 | 前端水合展示 stub 路径 | P1-9 | UI 从块表查询展示（前端需求），已挂账 |
| 9 | decompress/search 审计面 | P2-7 | **已核实**：search_context/decompress_context 经既有 audit/middleware 审计面（工具执行统一
   middleware 审计）；无缺口 |
| 10 | T-47 真机 provider 验证 | 外部 | 真机 DeepSeek 3 轮 + 压缩，观测 cacheRead 恢复曲线——需真实 provider key，外部环境，
   **待外部验证**（不执行） |

### 14.4 轮次 7 门禁结果

- `cargo test --workspace`：**89 块全绿，0 失败**（T-45 最终复跑）。
- `cargo build --workspace`：通过。
- clippy 基线（`scripts/check-clippy-baseline.mjs`）：本方案轮次 1-6 引入告警全部清零；
  剩余 11 条新增告警均为**并行域在途产物**（F-009/安全审计域，git blame 确认），挂账由并行域归账
  （清单见收尾报告）。

（完）