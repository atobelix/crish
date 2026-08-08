# DEEPCHECK-12：记忆韧性方案（05-memory-resilience）实现质量与入库准备检查

> 检查人：E8（只读质量检查子 Agent）
> 日期：2026-08-09
> 对象：`docs/cache-optimization/05-memory-resilience/`（并行方案，轮次 1-7 声称已实施完成，**全部停留在未提交工作区**）
> 方法：方案全量通读（7 份文档）+ git status/diff 逐项核对 + `cargo check --workspace` + `cargo test --workspace`（89 块）+ 全量文件编码扫描 + clippy 抽查 + stash/reflog 可恢复性勘察
> 性质：只读分析，不修改任何源码与方案文档；本报告为唯一产出

---

## 0. 结论先行

| 维度 | 结论 |
|---|---|
| 方案与实现一致性 | **高度一致**：T-01~T-47 任务清单与工作区代码逐项对应，方案 v1.1 的实施状态登记（轮次 1-7 完成、89 块全绿）**实测属实** |
| P0 修复 | **9/10 完整落地，1/10 部分落地**（评审 02 P0-5 generation 单源：消费面已接线，引擎侧代数硬编码 1，真源注入挂 V2） |
| 编译/测试 | `cargo check --workspace` 通过（仅 1 条无关 unsafe 告警）；`cargo test --workspace` **89 块全绿 0 失败**（与方案声称完全一致） |
| 编码质量 | 38 个改动文件全部 UTF-8 无 BOM、无替换字符；中文注释规范 |
| 可提交性 | **源码+测试+文档自身自洽可提交**，但存在 **7 个文件与 90-final 阵营重叠**、1 个文件与 05-浏览器协同重叠，且同工作区混有 4 个其他阵营的在途改动（provider-profiles / editor / stability-closure / browser）——需按文件域分批、协商合并顺序 |
| 丢失风险 | **极高（同 2026-08-07 事故形态）**：约 4800 行新增源码（12 个新文件）+ 34 个修改文件（+3309/-457 行）+ 7 份方案文档**零备份**——stash（含 lint-staged 自动备份）与 reflog 均无本方案任何文件 |

---

## 1. 方案概览表

### 1.1 方案定位

**解决的问题**：上下文压缩的两大损失——(a) 记忆不可追溯：被丢弃消息原文仅存内存、无块语义、无检索入口（残留在 events 表但不可寻址）；(b) 缓存命中率坍塌：每次压缩重写摘要占位符 = 请求前缀全变 = 服务端前缀缓存每压缩一次全作废。

**核心机制**：压缩产物升级为 **append-only 冻结折叠链（fold chain）**——链消息（`compacted-summary` 前缀）紧邻 system 一经写入永不修改/丢失/折叠（B1-B4 不变量），切割点钳制在链后（find_cut_point_inner 五处），使跨压缩的前缀 LCP 从「0（system 后全换）」变为「逐层累计的链总字节」。

### 1.2 技术方案构成（对应交付物）

| 模块 | 落地文件 | 关键内容 |
|---|---|---|
| 折叠链引擎 | conex-compaction lib.rs / recovery.rs | B1-B4 不变量、fold_start 钳制（T-01~T-05）、链排除/组装/新 id 格式 `compacted-summary-{gen}-{fold}`（T-06~T-10）、CompactionBlockMeta + 块引用行（T-11） |
| 摘要规范面 | summary_document.rs | Schema V1 JSON（required 12 字段 + additionalProperties）、确定性 md 渲染、旧格式兼容解析（T-12） |
| 中性 stub | lib.rs / ai_summary.rs | L1 占位符删除改中性 stub（无「生成中」措辞），metadata 快照 `{summary:{blockId,state,droppedIds,height,generation}}`，永不改写（T-13/R-C） |
| 输出清洗 | clean_output.rs + agent-provider wire 面 | R1-R6 纯函数；接线在 `to_chat_messages` wire 投影面（R-J），落库/事件/工具返回保持 raw（T-14/T-34） |
| 持久层 | conex-db migrate.rs v7 + blocks.rs | `compression_blocks` 单表，**PRIMARY KEY (session_id, block_id)** 复合主键（评审 01 P0-3 修复）；两阶段写协议 INSERT OR IGNORE + UPDATE（P0-4）；缺表降级空集+警告（R12/P2-1） |
| 事件扩展 | conex-types tool.rs + orchestrator events.rs | details 五键 camelCase 扩展（blockId/generation/prevBlockId/droppedAtMs/summaryState）；**不新增事件类型**（R-H，41 变体基线不变） |
| 块持久化 | orchestrator blocks.rs | persist_compression_block（压缩事件→块行，details 优先+兜底推导）+ update_compression_block_summary（调度器回调推进） |
| 测量增强 | telemetry signature.rs + cache_tracker.rs | prefix_diff_index 三态定位（T-25）；pending_compaction/rebuild_signature/capture_post_compaction（T-26~T-29）；apply_external_generation（R-K，T-30） |
| 摘要调度 | session-loop summary_dispatch.rs + summary_coordinator.rs | 同步裸 Summarizer 单次（60s 墙钟）+ 后台退避 1s/3s/9s±20%、attempts 累计含同步、retired 阈值 4（R-F/P0-5）；**会话级协调器**（跨 run 单飞 + 全局上限 2 + 注册表由壳层 CoreRunState 持有，P0-C/P0-2 修复） |
| 壳层接线 | core_run_commands.rs + engine.rs | SummarizerFactory 注入通道（T-43）、session_meta 三配置键（T-44）、CoreRunState 装配 |
| 只读工具 | agent-tools compression_store.rs + search_context/decompress_context/project_tree | CompressionContextStore **trait 注入**（叶子纪律，P0-6/P1-5 修复）；只读集 6→9；子 agent 默认 inline（P1-6 修复）；SKIP_DIRS 提 pub(crate) |
| 注入卫生 | handlers/mod.rs + prepare_turn.rs + stream_error.rs | 时间线只进尾部 user（debug 断言，T-35）；协议形状护栏 compaction_shape_ok（无 system 会话链后首条非 user → 跳过压缩 warn，T-36）；首尾双约束 |
| 文档登记 | 33-event-schema-changelog 1.7 行 / UPGRADING v7 / 00-index §7 | T-46 完成 |

### 1.3 轮次 1-7 交付物清单（与工作区核对）

| 轮次 | 内容 | Task | 工作区证据 | 状态 |
|---|---|---|---|---|
| 1 | 引擎核心（折叠链/块结构/JSON 摘要/stub/clean_output） | T-01~T-14 | lib.rs +706/-…、recovery.rs、summary_document.rs、clean_output.rs；B1-B4 六个不变量测试 + stub 确定性测试 | ✅ 实测存在 |
| 2 | 持久层（v7 迁移 + blocks + details 扩展 + orchestrator 落块） | T-15~T-19 | migrate.rs v7、db/blocks.rs（5 单测）、db/tests/blocks.rs（4 集成）、orchestrator/blocks.rs（420 行）、tool.rs | ✅ 实测存在 |
| 3 | 测量增强（prefix_diff_index + cache_tracker pending/rebuild） | T-25~T-30 | signature.rs +113 行（6 单测）、cache_tracker.rs +289 行（4 新测试） | ✅ 实测存在 |
| 4 | 执行层接线（apply_compaction + summary_dispatch + wire 清洗 + 护栏） | T-31~T-36 | handlers/mod.rs +634 行、summary_dispatch.rs（578 行 10 测试）、agent-provider messages.rs +99 行（3 wire 清洗测试）、prepare_turn/stream_error | ✅ 实测存在 |
| 5 | 工具面（project_tree/search_context/decompress_context/只读集 9/计数 20） | T-37~T-41 | compression_store.rs、project_tree.rs（838 行 18 测试）、search_context.rs（10 测试）、decompress_context.rs（11 测试）、readonly.rs 6→9 | ✅ 实测存在 |
| 6 | 会话级调度器 + 壳层 | T-42~T-44 | summary_coordinator.rs（444 行 5 测试）、engine.rs SummarizerFactory、core_run_commands.rs +247 行 | ✅ 实测存在 |
| 7 | 回归与收尾 | T-45~T-47 | 89 块全绿复跑、三份文档登记；T-47 真机验证挂账待外部 | ✅ T-45/T-46 实测；T-47 未做（外部依赖） |

### 1.4 验收标准与实测对照

| 验收标准（方案 §11/§14.4） | 实测 |
|---|---|
| `cargo test --workspace` 89 块全绿 EXIT=0 | ✅ 2026-08-09 复跑：**89 块，全部 0 failed** |
| `cargo build --workspace` 通过 | ✅（cargo check 全通过，build 由测试编译隐含验证） |
| clippy 基线：本方案轮次引入告警清零；剩余 11 条为并行域产物 | ⚠️ 基本属实：13 条警告中仅 cache_tracker.rs:289 位于本方案 diff 区（`unnecessary_map_or`，为重构搬迁的**既有表达式**，非本轮新引入）；其余 12 条（semantics.rs/mod.rs/approval_router/tool_events/tool_exec/lifecycle）均在本方案未触碰的代码 |
| 事件 41 变体基线不变（R-H） | ✅ changelog 1.7 登记「41→41」；测试全绿 |
| reference/markdown-editor 门禁不受影响 | ✅ 本方案未触碰该目录源码（仅 docs/ 属 editor 阵营在途） |
| 编码约定（中文注释、UTF-8 无 BOM） | ✅ 38 个改动文件扫描：全部无 BOM、无 0xFF/0xFE 字节、UTF-8 解码零替换字符 |

---

## 2. 30-review 的 10 个 P0 清单核对表（9 已修 / 1 部分）

> 评审 01（一致性+可落地性）5 项 + 评审 02（架构+不变量）5 项，合计 10 项。修复证据均为 2026-08-09 实读。

### 2.1 评审 01 的 5 项 P0

| # | 问题 | 修复方案（v1.1） | 声称状态 | 实测核对 | 结论 |
|---|---|---|---|---|---|
| P0-1 | §10 Task 全局唯一重编号（T-25~T-30 双号冲突） | v1.1 重编号为 T-01~T-47 全局唯一 | 已修 | 00-integrated-plan.md v1.1 §10 编号唯一，T-01~T-47 单次出现；代码注释锚点（T-01/T-06/T-11…T-44）与编号一致 | ✅ 已修 |
| P0-2 | 轮次依赖缺陷（轮次 3 T-19 依赖轮次 5 的方法） | 轮次重排：1→2→3→4→5/6 并行→7；测量增强合并为轮次 3 独立串行 | 已修 | v1.1 轮次 3 只含 T-25~T-30（signature/cache_tracker），工具面轮次 5 并行；§10 执行序注明「5/6 可并行」 | ✅ 已修 |
| P0-3 | 块表主键漏洞：R-B fold_index 派生 id 仅会话内唯一，单列 PK 会跨会话静默吞块 | 改 **PRIMARY KEY (session_id, block_id)** 复合主键 | 已修 | migrate.rs v7 DDL `PRIMARY KEY (session_id, block_id)`；blocks.rs 测试 `insert_ignore_idempotent_same_key_and_cross_session_isolation`（s1/s2 同 block_id 各成行）实测通过 | ✅ 已修 |
| P0-4 | 块表两阶段写协议二义（INSERT OR IGNORE vs upsert；重放幂等） | 阶段一压缩时 INSERT OR IGNORE（幂等键 (session_id, block_id)）+ 阶段二调度器成功 UPDATE（state/summary_json/height/attempts） | 已修 | blocks.rs `insert_block`（INSERT OR IGNORE）+ `update_block_state`（UPDATE，行不存在 Ok 无操作）；两测试覆盖幂等与状态推进；orchestrator/blocks.rs 接线两阶段 | ✅ 已修 |
| P0-5 | 同步先试一次误用 RetryGuardSummarizer → run 阻塞 300s；attempts 口径未定义 | 同步路径用裸 Summarizer 单次调用 + 新短墙钟包装 ≈60s 不重试；attempts = 总尝试（含同步），retired 阈值 4 | 已修 | 引擎 `compact_agent_messages` 直接调 `summarizer.summarize()` 单次（无重试包装）；summary_dispatch.rs `LOOP_SUMMARY_MAX_WALL_MS=60_000` + `summarize_once`（spawn_blocking + timeout）；`MAX_SUMMARY_ATTEMPTS=4`；测试 `attempts_includes_sync_attempt`/`wall_clock_cap_times_out_hung_call` 实测通过 | ✅ 已修 |

### 2.2 评审 02 的 5 项 P0

| # | 问题 | 修复方案（v1.1） | 声称状态 | 实测核对 | 结论 |
|---|---|---|---|---|---|
| P0-1 (P0-A) | block_id 全局唯一性缺失：跨会话/链重建/旧格式混叠三类 id 碰撞 | 复合主键 (session_id, block_id) + id 格式 `compacted-summary-{gen}-{fold}`（generation 参与区分轮次，starts_with 前缀兼容不断）；链重建需代数维度区分 | 已修 | 复合主键落地（见上）；新 id 格式落地（lib.rs T-09、handlers block_id 推导）；旧格式兼容：链成员检测仍 starts_with("compacted-summary")；`summary_ids_increase_with_fold` 测试验证格式 | ✅ 已修 |
| P0-2 (P0-C) | 摘要调度器任务与「会话级单飞」跨 run 断裂（状态挂 run 级 LoopState，run 收口即丢） | 单飞状态/JoinHandle/backoff/attempts 挂**会话级容器**（与 SessionHistoryCache 同生命周期，壳层 CoreRunState）；run 收口不摧毁任务 | 已修 | summary_coordinator.rs：注册表持 `Mutex<Option<JoinHandle>>` + 全局 ACTIVE_SUMMARY_TASKS 上限 2 + last_outcome 快照；壳层 core_run_commands.rs CoreRunState 持有注册表；run 级 dispatch 仅作未注入时的回退 | ✅ 已修（V2 挂账：会话删除未接线 registry.remove()，见 §14.3 挂账 3） |
| P0-3 (P0-D) | 摘要面自相矛盾：R-C「stub 永不改写」× stub 文案「⏳ 生成中」× §5.1 md 渲染投影 × existing 双语源无仲裁 | 裁决 R-G：链文本 = 该块文档 md 渲染（同步成功）/ 中性 stub（未就绪）；summary_json 表为 JSON 规范面；existing 优先级 = 表文档 > 链尾文本；stub 文案中性化 | 已修 | stub 文案 `[Compacted({block_id}) N 条消息 · 摘要见块表]`（无「生成中」）；`stub_is_deterministic_and_neutral` 测试断言无「生成中/generating/失败」；同步成功走 `summary_to_markdown` 进链（R-G 场景 A）；existing 取链尾（T-07 next_back）+ 表 committed 优先（orchestrator update 面） | ✅ 已修 |
| P0-4 | B1 冻结与逃生舱（计划级重建）正向冲突未登记；无触发计算/执行路径 | R-L 登记：B1 唯一显式例外 = 计划级重建（chain reset，V2 实现）；触发 = KPI 观测（链 token 窗口占比 ≥60%）；reset 块 prev_block_id 指向旧链尾保留追溯 | 已修（登记级） | v1.1 §3 R-L + §4.1 B1 例外文字完备；CompactionBlockMeta.prev_block_id 字段承载 reset 链接语义；逃生舱本体明确挂 V2（§14.3 挂账 6）；测试未锁死逃生舱（B1 测试在正常路径断言） | ✅ 已修（登记级，实现挂 V2） |
| P0-5 | 压缩代数双源未接线（01 R4 悬空）：cache_tracker 自增 vs 会话级权威代数 | 新增接线任务：apply_compaction 把会话级代数注入 tracker（替代内部自增）；R-K 单源 | **部分** | 消费面已接线：handlers/mod.rs `tracker.apply_external_generation(plan.generation)` + `apply_external_generation` 实现 + 测试；orchestrator 兜底 `count_compression_events`（与 restore 重放 +1 语义同源）。**但引擎侧 `let generation: u32 = 1;` 硬编码**（lib.rs T-09，注释「V2 由 SessionContextMeta.last_compaction_generation 注入」）→ 生产路径块 id/details/表行的 generation 恒为 1，真源注入未落地 | ⚠️ **部分**（消费面+兜底面完成，真源注入挂 V2） |

**P0 总结论：10 项中 9 项完整落地（代码+测试可复核），1 项（评审 02 P0-5 generation 单源）部分落地——tracker 消费面与事件计数兜底已完成，但引擎硬编码 1 使会话级真代数尚未生效（会话内唯一性由 fold_index 增长保证，无功能缺陷，仅代数语义未达 R-K 全量）。**

---

## 3. 实现核对（git diff 逐项）

### 3.1 改动面统计

| 类别 | 数量 | 明细 |
|---|---|---|
| 新增源码文件（未跟踪） | 12 个 / **4800 行** | compression_store.rs(49)、decompress_context.rs(443)、project_tree.rs(838)、search_context.rs(398)、clean_output.rs(309)、recovery.rs(193)、summary_document.rs(425)、db/blocks.rs(478)、db/tests/blocks.rs(225)、orchestrator/blocks.rs(420)、summary_coordinator.rs(444)、summary_dispatch.rs(578) |
| 修改文件（本方案归属） | 34 个 | 含 Cargo.lock；Rust 源码 26 个 + 文档 5 个（00-index/00-integrated-plan/33-changelog/UPGRADING）+ Cargo.toml 2 个 |
| 修改行数（git diff --stat 全体） | +3309 / -457 | 本方案占绝大部分；其中 conex-compaction/lib.rs +706、handlers/mod.rs +634、cache_tracker.rs +289 为三大件 |
| 新增测试 | ~95 项（含集成） | B1-B4 不变量 6、stub 3、clean_output 8、project_tree 18、search_context 10、decompress_context 11、summary_dispatch 10、summary_coordinator 5、db blocks 9、migrations 15、wire 清洗 3、handlers 集成 4 等 |
| 同工作区非本方案改动 | 5 处 | migrateLegacyProfiles.ts(+test)（provider-profiles 阵营）、TiptapEditorField.tsx（editor 阵营）、sessions.db(.shm/.wal/.pre-fix)（运行时产物）、docs/stability-closure/（7 文件，stability 阵营）、05-浏览器协同方案.md + reference/markdown-editor/docs/（browser/editor 阵营） |

### 3.2 逐项核对结论

**(a) 评审修复是否真实实现**：10 项 P0 中 9 项有直接代码证据（§2 表格已列文件:测试）；P0-5 部分实现。轮次 1-7 的 T-01~T-44 全部有对应代码与注释锚点，无「文档声称、代码缺失」的空头项。方案 §14.3 的 10 项挂账（V2/外部验证）与代码现状一致（含「已核实」的 2 项：默认回调落库、审计面）。

**(b) 编译**：`cargo check --workspace` 通过，仅 1 条 `unsafe` 告警（host_openers/execute.rs:393，非本方案文件）。`cargo test --workspace` 89 块全绿（0 失败），与方案声称的「89 块 EXIT=0」完全一致。

**(c) 测试**：新增测试量与本方案 §11 清单吻合（引擎 6 不变量、clean_output 7-10、project_tree 8、集成 12-20 各面）；关键断言走 wire 级（TestProvider.requests 序列化字节、wire_cleaning_is_deterministic_and_byte_stable）与 golden 模式（events 回放）；`chain_never_in_dropped_ids`、`fold_chain_is_frozen_across_compactions` 直接钉死 B1/B2 语义。

**(d) 代码质量**：38 个改动文件编码全部 UTF-8 无 BOM、零替换字符（字节级扫描）；中文注释规范且信息密度高（每个 T-xx 锚点带方案出处）；无 TODO/FIXME 残留标记的半成品；`#[cfg(test)]` 测试辅助函数与生产路径隔离清晰（reset_active_summary_tasks_for_test 等）。

---

## 4. 入库准备评估

### 4.1 当前可提交性（本方案文件自身）

**结论：自洽、无编译中断、无半成品，源码+测试+文档作为一个整体可以安全提交。** 证据：

- 全量编译与 89 块测试绿灯（跨所有改动文件一起）；
- 无「只写了一半」的文件（12 个新文件均带完整模块文档注释 + 测试）；
- 文档登记链完整（changelog 1.7 / UPGRADING v7 / 00-index §7），与代码事实一致；
- 编码、注释、clippy 状态符合仓库门禁。

### 4.2 提交前的冲突面与注意事项（按风险排序）

| # | 事项 | 风险 | 建议 |
|---|---|---|---|
| 1 | **与 90-final（本阵营）重叠 7 个文件**：`agent-provider/src/request/messages.rs`、`conex-compaction/src/lib.rs`、`conex-telemetry/src/cache/`（mod.rs+signature.rs）、`session-loop/src/cache_tracker.rs`、`loop/handlers/mod.rs`、`loop/handlers/stream_error.rs`、`loop/mod.rs` | 高——两边都在改同一批核心文件，先提交者会给后提交者造成巨大 merge 冲突；若 90-final 在旧基线写，语义还可能互相覆盖 | 提交前必须与 90-final 协调合并顺序与文件域分工；建议按「引擎层（conex-compaction）→ 测量层（telemetry/cache_tracker）→ 执行层（handlers）→ wire 层（messages.rs）」串行归并，每层归并后重跑全量门禁 |
| 2 | **与 05-浏览器协同重叠 1 个文件**：`agent-tools/src/lib.rs`（本方案 +5 行注册 compression_store 模块；浏览器方案也引用该文件） | 中——均为小改动，但同文件并发需串行 | 提交时确认浏览器方案的 lib.rs 改动尚未入库或已协商 |
| 3 | **同工作区混有其他阵营在途改动**：migrateLegacyProfiles.ts（provider-profiles）、TiptapEditorField.tsx（editor）、docs/stability-closure/（stability）、05-浏览器协同方案.md、reference/markdown-editor/docs/ | 中——`git add -A` 会连带提交他人未完成的工作 | **必须按文件白名单分批提交**，禁止 `git add -A`；先提交本方案文件，其余阵营文件保持未跟踪/未暂存 |
| 4 | **sessions.db 二进制被改动**（Bin 352256→499712）+ `.shm/.wal/.pre-fix-20260808` 三个运行时文件 | 低——运行时产物误入库会污染仓库 | 提交时排除 sessions.db*（含 .pre-fix 备份，属本地恢复保险）；确认其在 .gitignore 或手动排除 |
| 5 | **migrate.rs v3→v4 的 runs/pending_inputs 缺失表硬化**（现场库 user_version=3 缺两表导致迁移崩溃的修复，属本方案附带发现） | 中——该修复与记忆韧性无直接关系，但已混入 migrate.rs 同一 diff | 建议随本方案提交并注明（或单独小提交），不可丢弃——它修复了真实用户库的迁移崩溃问题 |
| 6 | **generation 硬编码 1 的 V2 挂账** | 低——不影响可提交性（会话内唯一性由 fold_index 保证），但提交时应保持挂账清单同步 | 提交信息或文档中保留 V2 挂账标记，避免后续误以为 R-K 已全量 |

### 4.3 提交批次建议

1. 批次 A（引擎纯算法）：conex-compaction 全部（lib.rs/recovery/summary_document/clean_output/ai_summary）+ conex-types/tool.rs + Cargo 变更；
2. 批次 B（持久层）：conex-db 全部（migrate/blocks/tests）+ orchestrator 全部（blocks.rs/events.rs/session.rs/lib.rs）；
3. 批次 C（测量层）：conex-telemetry 全部 + cache_tracker.rs；
4. 批次 D（执行层）：session-loop 全部（handlers/prepare_turn/stream_error/loop/mod/lib/summary_*）+ agent-provider（messages.rs/Cargo.toml）；
5. 批次 E（工具面）：agent-tools 全部；
6. 批次 F（壳层+文档）：core_run_commands.rs/engine.rs + 5 份文档。

每批提交前跑对应 crate 测试；全部完成后复跑 89 块全量 + typecheck。

---

## 5. 与 90-final（缓存方案）交叉分析

| 交叉点 | 关系 | 结论 |
|---|---|---|
| **blocks.rs 复合主键影响** | `compression_blocks` 是全新表（v7 迁移），90-final 若涉及 conex-db schema/migrate 需在其迁移链上叠加，但**表自身与 90-final 既有表（runs/session_messages/session_agents/events）无耦合**；复合主键 (session_id, block_id) 与 90-final 的 events 组合主键 (session_id, sequence) 模式同构，不冲突 | 低冲突——仅需注意 v7 之后若 90-final 再增迁移版本，版本号递增链要串行接 |
| **逃生舱与 compaction 关系** | 逃生舱（chain reset）在 V1 未实现（挂 V2）；90-final 的 compaction 相关任务（若有切割/前缀任务）与折叠链语义已由本方案 B1-B4 覆盖；逃生舱的「prev_block_id 指向旧链尾」链接语义与块表设计兼容，不会阻塞 90-final 的压缩路径 | 无实际冲突——逃生舱是未来演进，90-final 执行期不需要它 |
| **cache_tracker/telemetry 测量面** | 90-final 涉及 `conex-telemetry/src/cache/`、`cache_tracker.rs`（P5 域）——本方案已在同一文件加 prefix_diff_index/pending/rebuild 语义；90-final 若在其上继续加 stable_prefix_tokens/KPI 观测（02 分析阶段 C T-19），**必须在本方案之后串行叠加**，否则 rebase/merge 冲突大且可能覆盖语义 | **最高冲突点**——7 个重叠文件中此域最敏感，强烈建议 90-final 以本方案为基线再开工 |
| **wire 清洗（R-J）** | clean_output 在 `to_chat_messages` 统一应用——90-final 若改动 wire 序列化面（P1 §3.4 单出口），两边会碰同一函数 | 中——串行归并，先本方案后 90-final |
| **事件纪律（R-H）** | 本方案确认 41 变体不变；90-final 若新增事件类型会改 `V1_EVENT_TYPES` 基线——互不冲突，但注册时序需在 changelog 顺序上衔接 | 低 |
| **生成代数（R-K）** | 本方案引擎侧硬编码 1（V2 注入 SessionContextMeta）；90-final 若依赖真实代数（如 KPI 观测按代数分桶），会拿到恒 1 的值 | **需知晓的语义缺口**——90-final 的恢复曲线/KPI 若按 generation 分桶，在 V2 落地前只能按 fold_index 近似 |

---

## 6. 丢失风险评估

### 6.1 量化损失

| 项 | 数值 |
|---|---|
| 新增源码 | **12 个文件 / 4800 行**（含 4 个工具、3 个引擎模块、2 个调度模块、2 个 DB 模块、1 个契约） |
| 修改文件 | **34 个**（+3309/-457 行，净增约 2850 行），其中 conex-compaction lib.rs +706、handlers/mod.rs +634 为核心 |
| 修复价值 | **10 项 P0（9 完整+1 部分）**、B1-B4 不变量体系、两阶段写协议、复合主键（防跨会话吞块的数据级 bug）、60s 墙钟调度、trait 注入架构 |
| 测试资产 | **约 95 项新增测试**（B1-B4 冻结/单调、幂等、三态前缀、退避/墙钟/单飞、wire 字节稳定、迁移链 15 项） |
| 文档资产 | **7 份方案文档**（4 分析 + 1 方案 v1.1 + 2 评审），其中 30-review 两份（2 份未跟踪）与 00-integrated-plan v1.1 修订（M 状态）未入库 |
| 编译/门禁证据 | 89 块全绿基线（本方案承载的增量测试）；方案自身宣称的「89 块」基线也将随丢失退化为旧基线 |

### 6.2 可恢复性（关键结论）

| 备份面 | 检查结果 |
|---|---|
| git reflog | **无**——HEAD 为 679bde5b（我方 deepcheck 文档提交），最近 5 条 reflog 均不含本方案；方案文件最后一次入库是 37153189（editor 提交，仅为 00-integrated-plan 的早期版本，代码零提交） |
| git stash | **无**——stash@{0..19} 全部为 lint-staged 自动备份与旧 WIP，逐一核验**不含**任何 memory-resilience 文件（blocks.rs/summary_*/compression_store/fold_chain/compression_blocks/clean_output 均无命中） |
| 其他保险 | 仅 `apps/agent-workbench/sessions.db.pre-fix-20260808`（DB 运行时备份，不含源码） |

**可恢复性 = 0。** 与 2026-08-07 事故（reference/* 忽略致测试资产近乎丢失）**完全同形态**：大量高价值工作在未提交工作区，一旦误执行 `git checkout .` / `git clean -fd` / 磁盘故障 / 分支切换暴力操作，**全部损失且无任何恢复通道**。

### 6.3 丢失重做成本估算

- 引擎层（折叠链+不变量+测试）：约 0.5-1 人日；
- 持久层（v7+blocks+复合主键+迁移硬化）：约 0.5 人日；
- 测量/执行/工具/调度/壳层接线：约 1-1.5 人日；
- P0 修复的重新推导（复合主键、两阶段协议、60s 墙钟、trait 注入）风险自含——重做者未必能还原全部 10 项修复；
- 合计约 **2.5-3 人日**，且存在「修复遗漏」的隐性风险（评审教训未留存则复发）。

### 6.4 风险定级与建议

**风险等级：极高（P0 级，与 2026-08-07 事故同形态）。**

建议（交由主 Agent 裁决）：
1. **立即动作**：在本轮 deepcheck 收敛后，优先协调两阵营完成 §4.3 的分批提交（至少先提交批次 A/B 引擎+持久层，这是最容易与 90-final 冲突的部分）；
2. 提交前按 §4.2 排除 sessions.db* 与其他阵营文件；
3. 提交时保留 14.3 挂账清单（generation 注入 V2、逃生舱 V2、compact_l1_placeholder 运行时切换等）到提交说明；
4. 与 90-final 建立文件域互斥：7 个重叠文件在本方案入库前，90-final 不落子代理任务。

---

## 7. 一句话总结

> 方案与实现高度一致、编译与 89 块测试全绿、编码规范达标，P0 修复 **9/10 完整 + 1/10 部分（评审02 P0-5 generation 真源挂 V2）**；**当前可提交**（需按文件域分批、排除 sessions.db 与其他 4 阵营在途改动、与 90-final 协调 7 个重叠文件的合并顺序）；**丢失风险极高（同 2026-08-07 事故形态）——约 4800 行新增 + 34 个修改 + 95 项测试零备份（stash/reflog 均无），重做成本约 2.5-3 人日，建议优先安排入库**。

（完）
