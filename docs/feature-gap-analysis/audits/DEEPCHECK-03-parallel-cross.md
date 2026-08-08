# DEEPCHECK-03：并行阵营交叉域深查（只读）

- 子代理：D3（并行阵营交叉域深查，只读分析）
- 核对窗口：HEAD = 12208249（2026-08-09，fix(table) 系列）
- 性质：只读；未修改任何源码；仅产出本文档
- 日期：2026-08-09

---

## 一、疑点清单总表

| # | 疑点 | 结论 | 关键证据 | 影响 | 修复方向 |
|---|---|---|---|---|---|
| 1 | 30-review 两份评审（未入库、5+4 P0） | **成立，且与实现高度对应**：10 个 P0 中 9 个已修（工作区 WIP 实现）、1 个部分（逃生舱登记）；未入库 = 整个 05-memory-resilience 战役（方案修订 + 实现）都在未提交工作区，**非内容脱节** | 见 §二 详细分析 | 全部实现（39 个 crates 文件 + 2 新工具 + v7 迁移）**未入库**，一旦误清工作区即丢（与 2026-08-07 事故同型风险） | 战役收尾后立即 `git add` 提交（含 30-review 与 20-plan 修订稿） |
| 2 | I 系列子 agent 引擎 vs REQ-D08 | **部分成立**：REQ-D08 主体（list/kill/kill_all/resume/嵌套禁止三防线/完成唤醒/outputFiles）已实现；**缺口 = resume 之外的 F-018 死锁检测信号源与 F-017 恢复阶梯生产接线**（F 批次登记待接，至今未动） | `subagent.rs:498` max_depth=1；`core_run_commands.rs:2935-2939`（F-018 待接注释）；RecoveryCoordinator 生产零调用；`wait_subagents.rs:768-786` outputFiles | 子代理死锁仅靠 120s 超时兜底；C7 恢复阶梯（自动重试→主 agent 激活→fork→上报）生产形态不生效 | 落地 orchestrator 子代理跟踪器 await 态标记 → 注入 deadlock detector；壳层接线 RecoveryCoordinator |
| 3 | eslint 22 errors 明细 | **成立且恶化**：CI 同命令 `npx eslint .` 实测 **58 errors / 4 warnings**（62 problems），比审计时 22 errors 增 +36；knip 收敛批次删除导出后 import 残留是主增因 | 全文输出见 §三；`ci.yml` 确认 lint = `npx eslint .` | **CI lint job 必失败**；"全量门禁绿"声明仍未覆盖 eslint | 按 §三 分组清理：57 个 unused 手删 import；2 个 ban-ts-comment 改 `@ts-expect-error`（ast-block-tables 为保护 spec，改法安全）；1 个 prefer-const 可 `--fix` |
| 4 | AA-07 P11/P18 未修复 2 项 | **成立（均未修）**：P11 时间戳三套 = 有决议不做（PE-08 范围外，v5 候选）；P18 40 条截断 = 仍纯 `slice(0, CAP)` 静默截断，**连"记录截断事实"都未落地**（AU-02 登记与代码不符） | `sessionRustDb.ts:541/767`；`sessionPersistenceTypes.ts:15`；migrate.rs 无改动 | 第 41+ 个协作 agent 数据静默丢失（LS/SQLite 双侧一致）且不可感知 | P18：写 session_meta 截断事实（`agents_cap_truncated`）+ UI 软提示；P11：维持不做决议，文档标注 |
| 5 | PERSIST P2×32 残留 | **抽查 5 项：4 项仍存、1 项已随修复消失**——P2-9（touch 接线）已被 F-005 修复闭环；其余（N2-11 WAL 吞错 / P2-4 run_usage 同步 / P2-8 latch 永闩 / P2-1 快照代数）未动 | `run.rs:336-359`（touch 已接）；`migrate.rs:108`（let _ 仍在）；`core_run_commands.rs:1569`；`conex-db/lib.rs:106` clear_failure 零调用 | 死账比例低（1/5），但"登记=已修"的风险仍存在；P2-8 前端按 missing 整体回退 LS 掩盖真实 DB 状态是隐患 | 剩余 4 项逐一闭环或转"登记不做"；特别优先 P2-8 的 latch 分级清除 |
| 6 | subagent-development.md 引用已删除 TS 包 | **成立**：整篇引用已删除的 `@crish/agent-subagent`、`@crish/agent-core` 及不存在的 `docs/ARCHITECTURE.md`、`docs/analysis/iterative-repair/v2/`、`docs/ANTI_OVERENGINEERING_GUARDRAILS.md`；且内容（maxDepth=3、Node 调度器）与现行 Rust 引擎（maxDepth=1）直接矛盾 | `Test-Path` 实测 5 处 False；packages/ 现有 5 包无 agent-*；`subagent.ts:59` maxDepth:1 | 新开发者按旧文档理解子代理系统会得出错误结论（嵌套深度、架构归属） | 重写为 Rust 引擎版（run_subagent/wait_subagents/SubagentSpawner）或归档并链接 REQ-D 现状分析 |
| 7 | 写路径互斥（I4-M3）vs S1 流式 Progress | **不成立（无绕过）**：两者正交——写互斥只在写工具 execute 入口检查（越权→互斥串行叠加），Progress 是事件流（`AgentEvent::ToolUpdate`）不经注册表、不写文件；shell 删除重定向在预检面已被拦截 | `fs.rs:316-319`；`tool_exec.rs:968-984`；`shell.rs:296-297`；`write_paths.rs:465-476` | 无（机制面干净）；唯一注意点：Progress 回调用例（如 UI 展示）不得自行落盘工作区文件，否则绕开互斥 | 文档补充一句"Progress 回调禁止文件副作用"纪律 |
| 8 | F-017/018/019 knip 待接项 | **结论：待接未死（3/3 仍真未接线，登记诚实）**：F-017 RecoveryCoordinator 生产零调用（仅测试域构造）；F-018 deadlock detector 注入点已就绪但信号源缺失（引擎无 wait 态标记）；F-019 setLogRedactor 定义+导出、生产零调用 | `core_run_commands.rs:2935-2939`；rg 全仓验证；`shared-utils/src/logger.ts` | 恢复阶梯/死锁防护/日志脱敏在生产形态不生效；但非隐瞒（有登记） | 各自依赖基础设施落地后再接线；F-019 成本最低可先行 |

---

## 二、30-review 详细分析

### 2.1 两份评审是什么

`docs/cache-optimization/05-memory-resilience/30-review/`（未入库、untracked）：
- **01-integrated-plan-review.md**（239 行）：评审 00-integrated-plan v0.1 的**一致性与可落地性**——5 个 P0（Task 重号 / 轮次依赖缺陷 / 块表主键漏洞 / 块表写协议二义 / 同步摘要阻塞风险）+ 行号核验（30+ 处高度吻合）。
- **02-integrated-plan-review.md**（256 行）：评审同一方案的**架构合理性与不变量安全**——5 个 P0（block_id 全局唯一缺失 / 摘要调度器跨 run 断裂 / 摘要面自相矛盾 / B1 与逃生舱冲突未登记 / 压缩代数双源未接线）+ B1-B4/I1 不变量核验 + 缓存机制正确性分析。

### 2.2 P0 清单与修复状态（对照 git log + 工作区代码）

**重要前提**：git log 显示 05-memory-resilience 的实现**全部未提交**（crates/ 39 个变更文件，含 blocks.rs / summary_coordinator.rs / recovery.rs / 2 个新工具；conex-db LATEST_VERSION 已到 v7）。以下"已修"指工作区 WIP 实现已落地，**未入库**。

| # | P0 内容（来源） | 修复状态 | 代码/方案证据 |
|---|---|---|---|
| 01-1 | §10 Task 全局唯一重编号（T-25~T-30 重号） | **已修**（方案修订） | 20-plan 未提交修订稿 341+/241-：T-01~T-10 重新编号、任务结构重构（出现 T-42 等新编号） |
| 01-2 | 轮次依赖修正（轮次 3 T-19 依赖轮次 5） | **已修**（方案修订） | 修订稿轮次表重构（新增轮次 4/5 拆分、工具面轮次自洽） |
| 01-3 | 块表主键改 (session_id, block_id) 复合（防跨会话碰撞丢块） | **已修**（实现） | `crates/conex-db/src/blocks.rs:146,166`：`INSERT OR IGNORE` 幂等键 (session_id, block_id)；`CompactionBlockMeta` 注释"R-A 复合主键 (session_id, block_id) 的一半" |
| 01-4 | 块表两阶段写协议（INSERT OR IGNORE 创建 + UPDATE 推进 + 幂等） | **已修**（实现） | `blocks.rs:146`（创建）+ `:223`（UPDATE 幂等，行不存在返 Ok 无操作）；recovery.rs 状态机 awaiting→committed\|retired |
| 01-5 | 同步先试一次禁复用 RetryGuardSummarizer（300s 阻塞）、定义 attempts 口径 | **已修**（实现） | `summary_dispatch.rs:46-47`：`LOOP_SUMMARY_MAX_WALL_MS = 60_000`（对齐评审 02 P1-10 建议）；`:28-31` 单次调用 tokio timeout 包裹；`:67-104` session_meta 可配 |
| 02-1 | block_id 全局唯一缺失（跨会话/链重建/混格式碰撞） | **已修**（实现） | 修订稿 `block_id = "compac-compact-{gen}-{fold}"`（带代数，评审建议方向"块 id 带代数"）；叠加复合主键双保险 |
| 02-2 | 摘要调度器任务与"会话级单飞"跨 run 断裂 | **已修**（实现） | `summary_coordinator.rs:1` 注释直接标注"评审 02 P0-2"；注册表由壳层 CoreRunState 持有（会话级），`Mutex<Option<JoinHandle>>` 跨 run 单飞；`MAX_CONCURRENT_SUMMARY_TASKS=2` |
| 02-3 | 摘要面自相矛盾（R-C stub 永驻 + §5.1 渲染投影 + existing 双语源） | **已修**（实现） | `lib.rs:21`"中性句法 stub（R-C 永不改写）"；`:511-513` existing = 链尾最后一条非空摘要文本（stub 或 md 渲染皆可）+ "由调用方按表优先仲裁"；`recovery.rs:14-20` 状态机含 Retired |
| 02-4 | B1 与逃生舱（计划级重建）冲突未登记 | **部分**：状态机/块衔接已实现；"逃生舱 = B1 唯一显式例外"的触发计算与执行路径仍为未来演进（修订稿是否登记需在 20-plan 修订稿 §12 确认） | `recovery.rs` 是块元数据面（非逃生舱实现）；无 chain-reset 代码路径 |
| 02-5 | 压缩代数双源未接线（tracker 自增 vs LoopState.compact_generation） | **已修**（实现） | `cache_tracker.rs:331-340`：`apply_external_generation` 用会话级权威代数（SessionContextMeta.last_compaction_generation / LoopState.compact_generation）校准内部 generation；修订稿 `generation: u32 // 会话级代数（R-K 单源）` |

**汇总：10 个 P0 → 9 已修（方案或实现）、1 部分（02-4 逃生舱登记）**。评审意见全部被后续工作吸收，无一悬空。

### 2.3 与其他方案的关系

评审对象 = 20-plan/00-integrated-plan.md（v0.1，364 行，**已入库**，现为修订稿未提交）；输入 = 10-analysis/01~04（已入库）+ 03-plans/P1/P4/P5；实现产物 = conex-compaction（recovery/summary_document/clean_output）、session-loop（summary_coordinator/summary_dispatch/cache_tracker）、conex-db（blocks.rs + v7 迁移）、agent-tools（search_context/decompress_context/project_tree 新工具）、conex-telemetry（prefix_diff_index/signature 重建）。90-final（00-index 提及的最终方案）未单独成稿——实现直接消费修订后的 20-plan。

### 2.4 为什么未入库（内容是否与代码脱节）

- **未入库原因 = 战役在途，非内容问题**：`git check-ignore` 显示 `.gitignore:363` 的 `!docs/**/*.md` 白名单**放行** 30-review（不被忽略），但从未 `git add`（git status = `?? 30-review/`）；20-plan 修订稿同为 M 状态；39 个 crates 实现文件全部 M/??。整个战役文档与代码都停在未提交工作区。
- **内容与代码未脱节，反而高度对应**：实现代码注释直接引用评审编号（summary_coordinator.rs:1"评审 02 P0-2"、summary_dispatch.rs:46"评审 02 P1-10"、blocks.rs 幂等键即 P0-3/P0-4 建议原文），说明评审是实现的直接输入而非僵尸文档。
- **风险**：与 2026-08-07 事故同型（未入库资产差点丢失）。建议战役收尾时一次性提交（30-review + 20-plan 修订稿 + 实现）。

---

## 三、eslint 明细（58 errors / 4 warnings，`npx eslint .` 实测）

CI lint job 命令 = `npx eslint .`（ci.yml 确认），**当前必失败**。CODEBASE-03 审计时 22 errors → 现 58 errors（+36）。主增因：09 号 knip 收敛批次（3611f746 等 9 个提交）删除 unused exports 后，消费方 import 成为 unused；部分新测试文件自带 unused。

### 3.1 分组

| 分组 | 数量 | 文件 | 处理方式 |
|---|---|---|---|
| 可 `--fix` 自动修 | 1 error + 1 warning | messageSnapshotsBridge.ts:31（prefer-const `_ops`）；packages/plugin-sdk/plugin-fs.ts:113（unused eslint-disable） | `npx eslint . --fix` 或手改 |
| unused import/变量（需手删） | 55 error | 见 3.2 明细 | 删除未用 import/变量；streamState.ts 7 个 import、ChatMessageRow.tsx 6 个、sessionStore.ts 4 个、store/types.ts 3 个为重灾区 |
| ban-ts-comment | 2 error | tests/e2e/ast-block-tables.spec.ts:12,33（`@ts-ignore` → `@ts-expect-error`） | 改注释形式（**保护 spec，禁止删除，仅改规则合规写法**） |

### 3.2 明细（58 errors 分布，按域）

**apps/crish-desktop/src（48 error）**
- api 域（20）：binaryFrame.ts:23（BINARY_FRAME_MAGIC）；streamState.ts:1,2×2,4,5,6,7（7 个 import）；codeHighlight.ts:169；collectRewindScope.ts:14；markdownRender.ts:17；mcpApi.ts:12；sessionLocalStorage.ts:446；sessionPersistenceTypes.ts:18；skillsApi.ts:573；storeAccessCore.ts:43,48；streamDiag.ts:69；subagentApi.ts:59；workspaceChromeTabs.ts:88
- components 域（16）：BgTaskActions.test.tsx:212；bgTaskCardLib.ts:211；composerTypes.ts:11；MessageVirtualizer.memo.test.tsx:15×2；useScrollAnchor.ts:15；ChatMessageRow.tsx:37,38,42,43,47,48（6 个类型/组件 import）；useSkillsSettingsState.test.tsx:2；SessionTabDragContext.tsx:71；sessionListUtils.ts:14；usePreviewNavigation.ts:26
- services 域（1）：ShortcutPlatformAdapt.ts:21
- store 域（11）：ui-tool-column.ts:40；treePanelAccess.ts:21；messageSnapshotsBridge.ts:31；sessionStore.ts:17,24,25,26（4）；types.ts:126,129,417（3）；layoutRestorePolicy.ts:18

**apps/crish-desktop/tests/visual（3 error）**：helpers.ts:17,18,19（fullJourneyRunEvents/fenceRunEvents/tableRunEvents）

**tests/e2e（6 error）**：ast-block-tables.spec.ts:12,33（ban-ts-comment，保护 spec）；debug-style.spec.ts:1（expect 未用）；matrix-ime-selection.spec.ts:39（textLenAfter）；mock-engine.ts:449,845（emitEngineEvent/cacheStatsUpdatedEvent）

**packages（1 error + 3 warning）**：shared-types/session-workspace.ts:17（SESSION_PANE_ROLES，仅用作类型）；warning：AgentTeamBoard.tsx:93（react-refresh）、TiptapEditorField.tsx:300（hooks deps）、TiptapSlashMenu.tsx:89（no-explicit-any）、plugin-fs.ts:113（unused disable）

**归属**：crish-desktop 前端域 51（48+3）、e2e 保护 spec 域 6、packages 1。其中 ast-block-tables/debug-style/matrix-ime-selection 属 5 个受保护 e2e spec 集合，清理时只允许改 lint 合规写法，不得删用例。

---

## 四、各疑点证据要点（补充）

### 4.1 疑点 2：I 系列 vs REQ-D08 逐条

| REQ-D08 项 | 状态 | 证据 |
|---|---|---|
| 嵌套禁止（仅主 Agent 可派发） | ✅ 已实现（三防线） | `subagent.rs:498` max_depth=1 + `:593` NestingDenied；`subagent.ts:59` 双侧同值；filter_out_subagent_spawner 工具面剔除（F4 T-D-01/02 已入库） |
| 结构化错误 subagent.nesting_denied | ✅ | SUBAGENT_NESTING_DENIED 码 + 指引文案（F4 轮次报告） |
| list | ✅ | orchestrator agents.rs（REQ-D-现状分析 §8 确认） |
| kill | ✅ | L3 force_cancel 链路（control.rs:43-67） |
| kill_all | ✅ | engine.rs / control.rs / process.rs / subagent_spawner.rs / main.rs 均有接线；orchestrator/tests/kill_all.rs 断言清零+产出保留 |
| resume | ✅ | orchestrator/lifecycle.rs + core_run_commands.rs（fork 三态 + ForkRecord 落库） |
| 完成唤醒（子代理终态 → 主 agent） | ✅ | `core_run_commands.rs:1759-1767` on_subagent_run_terminal：记账释放/行更新/subagent-ended/等待通道 feed/steering 通知 + last_wakeup mark；A9 审计确认 e2e 覆盖 |
| 输出落盘重取（outputFiles） | ✅ | `wait_subagents.rs:768-786` 终态载荷 path/summary/bytes + persist_outputs；g02_collab_outputs.rs 测试（其模块头"T-EG-10 未落地"注释已过时） |
| **缺口：deadlock detector 信号源** | ❌ 待接 | `core_run_commands.rs:2935-2939`：引擎侧无 orchestrator 子代理跟踪器 await 态标记；缺省 None 恒走 120s 超时兜底 |
| **缺口：C7 恢复阶梯生产接线** | ❌ 待接 | RecoveryCoordinator 生产零调用（仅测试域构造）；recovery.rs 库实现就绪但壳层无装配点 |

### 4.2 疑点 5：PERSIST P2 抽查明细

| 抽查项 | 状态 | 证据 |
|---|---|---|
| PERSIST-03 P2-9（run 活动不推进 updated_at，touch 零调用） | ✅ **已随修复消失** | `run.rs:336-359` F-005 touch 接线（非终态转移落库即 touch）；9457cfaf 红测试闭环 |
| PERSIST-01 N2-11（WAL/busy_timeout 错误被 `let _` 吞） | ❌ 未修 | `migrate.rs:108` `let _ = conn.execute_batch("PRAGMA journal_mode=WAL; ...")` 原样仍在 |
| PERSIST-03 P2-4（run_usage 同步直调阻塞 async 线程） | ❌ 未修 | `core_run_commands.rs:1569` `run_usage()` 内直接 `db.get_run_usage(run_id)`，无 spawn_blocking |
| PERSIST-03 P2-8（failure latch 置位后永不清除） | ❌ 未修 | `conex-db/lib.rs:106` clear_failure 定义后**全仓零调用**；前端按 missing 整体回退 LS 的掩盖面仍在 |
| PERSIST-02 P2-1（快照 generation 跨重启重置、主备新旧序反转） | ❌ 未修 | restore 完成路径只写 interrupted_count/last_sequence（core_run_commands.rs:1905 处为 tracing 日志字段），未将 outcome.snapshot_generation 写回 self.snapshot_generation（仅 save_snapshot_now:1940 写入新代数） |

**结论**：死账比例低（5 项中 1 项已闭环），但 4 项"登记存在"经代码复核仍真实存在，无虚记。

### 4.3 疑点 7：写路径互斥与 S1 流式（详细）

- 写路径检查链路：写工具 execute 入口先 `check_write_allowance_for_ctx`（越权拒绝 `tool.write_not_allowed`）→ 再 `claim_write_guard`（冲突拒绝 `tool.write_path_conflict`），一先一后串行（`fs.rs:316-319`，write_paths.rs:465-476 注释明示挂接顺序）。未接线（write_claims=None）不强制。
- S1 流式（TOOLS-01 §3.1）：`ToolProgress` 回调 → tool_exec.rs:968-984 映射 `ToolEvent::ToolProgress` 入进度缓冲 → :1424-1443 `tool_progress_update` 出站 `ToolProgressUpdate`（Text/Custom/Content 映射）。**纯事件流，不落盘、不经写路径注册表**。
- shell 删除重定向：预检面 `redirect_or_intercept_delete` 拦截（shell.rs:296-297），shell.rs:24 引用 claim_write_guard 同面。
- **判定**：无绕过路径。Progress 与写互斥是正交的两面（事件面 vs 写路径面）；Progress 发射必然发生在写工具 execute 检查之后（execute 内部回调），不存在"先发射 Progress 再检查"的时序漏洞。唯一注意点：Progress 回调用例（UI 展示）若有文件副作用应视为写操作走注册表（现状无此用例）。

### 4.4 疑点 8：F-017/018/019 现状（死 vs 待接）

- **F-017（C7 恢复阶梯）**：RecoveryCoordinator 在 crates/orchestrator 定义 + 测试域构造（recovery_ladder.rs / multi_agent.rs / kill_all.rs / crash_consistency.rs），**生产（apps/agent-workbench + session-loop）零调用** → 待接，非死。
- **F-018（deadlock detector）**：注入面已就绪（core_run_commands.rs:210-214 with_deadlock_detector、:4010-4011 装配），但 :2935-2939 注释明示信号源（主 agent wait 态标记）未落地，缺省 None → 待接，非死。
- **F-019（logger 脱敏）**：packages/shared-utils/src/logger.ts 定义 + index.ts 导出，**生产零调用** → 待接，非死。
- 三者均经 CODEBASE-03 审计 grep 验证"登记诚实"，本深查复核一致；无"登记后悄然实现"的反例。

---

（完）
