# DEEPCHECK-04：文档资产域深查报告

> 子代理：D4（文档资产域深查）　|　检查日期：2026-08-09　|　性质：只读分析
> 检查范围：`docs/cache-optimization`（00-index/05-memory-resilience/10-model-catalog-v2/90-final）、`docs/feature-gap-analysis`、`docs/guides`、`docs/plans/progress`、`docs/schemes`、`docs/stability-closure`、`reference/markdown-editor` 资产、相关 git 跟踪状态
> 方法：目录实扫 + 索引逐条比对 + `git ls-files`/`git status --short --untracked-files=all`/`git log` 只读核验
> 口径说明：git 状态为检查时点快照（会话中工作区有外部变更，markdown-editor 目录由检查初期 1 个 M 变为后续 0 个，结论以资产存在性为准）

---

## 一、疑点清单表

### 疑点 1：00-index 失真（`docs/cache-optimization/00-index.md`）

| # | 结论 | 证据 | 影响 | 修复方向 |
|---|------|------|------|----------|
| 1-1 | **索引未登记但存在：`10-model-catalog-v2/` 全目录（14 份）** | 目录实扫 14 个文件（00-gap-audit / 01-anthropic~openai×11 / 02-*×3 / 03-catalog-v2-schema / 04-master-model-list / 05-audit-report / 99-project-closure）；00-index.md 七节无任何 model-catalog 条目 | 模型目录专项（含 99-project-closure 遗留 7 项登记）在索引外，后续 P3 数据核对/终验找不到入口 | 补第 8 节登记 10-model-catalog-v2（与 03-plans/P3 关联标注；99-project-closure.md 是模型目录专项遗留登记权威） |
| 1-2 | **索引未登记但存在：`90-final/` 目录全部 15 份轮次报告** | 目录实扫：R0-baseline×3 + R0-report + R0.5-model-era-audit + R1-contract-registration + R1~R7-report + R7-audit-leftover + 99-closure-check = 15 份，全部存在且已跟踪（`git ls-files`=15，status 干净）；索引第 6 节标题写"最终方案（1 份，90-final/）"但登记的是**根目录**的 `90-final-multi-agent-repair-plan.md`——节标题路径标注错误 | 执行主线文档在根目录、轮次报告在 90-final/，两者都无索引导航；`90-final-multi-agent-repair-plan.md` 被"90-final/"节标题误导 | 第 6 节标题改为"最终方案（1 份，根目录）"，另开小节登记 90-final/ 轮次报告 15 份（或声明"轮次报告见 90-final/，不逐份登记"并给文件清单） |
| 1-3 | **索引登记但已删：0 个** | 索引登记全部文件（00-catalog、10 份参考调研、comparison、P1-P6、A1-A3、90-final-multi-agent-repair-plan、05 七份）逐一 Test-Path，全部存在 | 无（索引无悬空条目） | 无需修复 |
| 1-4 | **05-memory-resilience 已在索引（第 7 节，7 份全登记）**——主 Agent 记忆"不在索引"**已过时** | 00-index.md:64-77 第 7 节完整登记 7 份（10-analysis×4 + 20-plan/00 + 30-review×2）；git diff 显示该节为**未提交新增**（00-index.md 状态 M） | 索引与目录一致 ✓；但见 1-5：登记的是未入库文件 | 随 30-review 入库一起提交（见疑点 4/7） |
| 1-5 | **索引登记了未跟踪文件：30-review 两份** | 00-index.md:76-77 登记 `30-review/01/02`；`git status` 显示 `?? docs/cache-optimization/05-memory-resilience/30-review/`（两份均未跟踪） | 索引指向 git 之外的文件——文档丢失即索引失真 | 立即提交 30-review（见疑点 7，与源码一起） |
| 1-6 | **索引第 7 节状态声明失真："实施完成（轮次 1-7，2026-08-08）"** | 索引与 20-plan §14 均声称完成；但 05 实现 12 个源码文件全部 `??`、~30 个相关文件 M（见疑点 7） | 调度者据索引判断"该专项已收口"是错误结论 | 修正索引措辞为"文档完成、代码未提交"，与疑点 7 一并处理 |

### 疑点 2：feature-gap-analysis 体系

| # | 结论 | 证据 | 影响 | 修复方向 |
|---|------|------|------|----------|
| 2-1 | **整个目录无索引/README**（62 份文档无导航） | 根目录 10 份 REQ/调研 + `audit/` 23 份 + `audits/` 7 份 + `plans/` 8 份 + `plans/reports/` 14 份，无 README/00-index/目录说明 | 双套审计体系并存且互相不可见，新 Agent 无法定位"当前审计在哪个目录" | 建 README：audits/ 为现行体系（CODEBASE×4/PERSIST×3），audit/ 为历史战役（A1-A10，建议归档） |
| 2-2 | **`audit/` 与 `audits/` 双目录并存**（旧 A1-A10 战役 vs 新 CODEBASE/PERSIST 体系） | audit/ 含 A1-A10 + plans/00-40 + 终验报告（历史战役 2026-07）；audits/ 含 CODEBASE-01~04 + PERSIST-01~03（现役审计）；命名单复数差一个 s，极易混淆 | 检索歧义；旧战役 A1-A10 结论未被现行体系引用 | 将 audit/ 移入 docs/archive/（或 audit/ 内置 README 声明"历史战役，现行审计见 ../audits/"） |
| 2-3 | **audits/ 现有 7 份 = PERSIST×3 + CODEBASE×4**（与任务书预期一致；CODEBASE-04 = 本文档，将成第 8 份） | audits/ 实扫：PERSIST-01-data-chain / 02-restore / 03-concurrency-migration；CODEBASE-01-rust-engine / 02-frontend / 03-parallel-gates / 04-docs-assets | 无异常 | — |
| 2-4 | **REQ-agent-engine-capabilities.md:41 引用 `ANTI_OVERENGINEERING_GUARDRAILS.md` 相对路径不存在** | grep 命中 REQ-agent-engine-capabilities.md:41（无路径前缀 → 解析为 `docs/feature-gap-analysis/ANTI_OVERENGINEERING_GUARDRAILS.md`，不存在）；实际文件在 `docs/archive/legacy/ANTI_OVERENGINEERING_GUARDRAILS.md`（Test-Path=True） | REQ 引用悬空，"反过度设计"约束不可追溯 | 改为 `../archive/legacy/ANTI_OVERENGINEERING_GUARDRAILS.md` |
| 2-5 | **guides/ 三份指南 + error-handling.md 引用 `../ANTI_OVERENGINEERING_GUARDRAILS.md`（→ docs/ 根）不存在** | subagent-development.md:604、plugin-development.md:515、error-handling.md:484、hooks.md 均用 `../ANTI_OVERENGINEERING_GUARDRAILS.md`；`docs/ANTI_OVERENGINEERING_GUARDRAILS.md` Test-Path=False | 4 处指南引用悬空 | 统一改指 `../archive/legacy/ANTI_OVERENGINEERING_GUARDRAILS.md` |
| 2-6 | **根目录 ANTI_OVERENGINEERING_GUARDRAILS.md 不存在**，但治理文档 A1 声称"保留根目录 3 个" | `git ls-files ANTI_OVERENGINEERING_GUARDRAILS.md` 无输出；仓库根与 docs/ 根均无此文件；organization/A1-root-docs-inventory.md:18,97 说"保留根目录" | 治理文档与现状不符（文件实际已移入 archive/legacy，A1 未更新） | A1 标注已迁移；所有引用统一到 archive/legacy |
| 2-7 | **plans/05-浏览器协同与电脑操作方案.md 未跟踪**（plans/ 8 份中唯一未入库） | `git status` 显示 `?? docs/feature-gap-analysis/plans/05-浏览器协同与电脑操作方案.md`；00-04 + TOOLS-01 均已跟踪 | 方案缺失即与 REQ-EG 对应的执行文档丢失 | 提交入库 |

### 疑点 3：90-final 归档完整性

| # | 结论 | 证据 | 影响 | 修复方向 |
|---|------|------|------|----------|
| 3-1 | **轮次报告链无缺口：R0→R0.5→R1→R2→R3→R4→R5→R6→R7 完整** | 15 份文件全部存在、全部已跟踪、status 干净（ls-files=15）；R0 含 4 份（baseline×3 + report），R0.5 为模型时代审计，R1 含 contract-registration，R7 含 audit-leftover | 无异常 | 补登记 00-index（见 1-2） |
| 3-2 | **99-closure-check 登记项 C14-C20 与实际提交对应：ac554c99 / d1b0dde2 / 74243f7d 全部存在**（2026-08-04） | `git cat-file -e` 三个 commit 全部 True；log 确认：ac554c99=T-40 core_run 合并+10 节补标+cacheMetrics 回放面+x-grok-conv-id；d1b0dde2=SessionMessage.usage 闭环；74243f7d=TDZ 修复+boot 窗口 | 关闭登记可信 ✓ | — |
| 3-3 | **文档内部矛盾：§四遗留项 4（R5-D3 T-40 core_run 合并）标"待办触发条件"，批次 2 C14 又标"已关闭（ac554c99）"** | 99-closure-check.md:69 遗留 4 vs :92 C14；两处未交叉更新 | 终验引用时两态并存，判定歧义 | C14 关闭后回写 §四遗留 4 状态为"已关闭（ac554c99）" |
| 3-4 | **R0.5 未在 99-closure-check 与 00-index 中被提及** | 99-closure-check 依据仅列 R7-audit-leftover + 99-project-closure；索引第 6 节无 90-final 清单 | 轻微：R0.5 属 R0 阶段中间产物，不影响链完整性；但索引补登记时应一并列入 | 随 1-2 补登记 |

### 疑点 4：markdown-editor 资产（reference/markdown-editor）

| # | 结论 | 证据 | 影响 | 修复方向 |
|---|------|------|------|----------|
| 4-1 | **git 跟踪：146 个文件入库；工作区（排除 node_modules/dist）168 个 → 22 个未跟踪且全部被 .gitignore 忽略** | `git ls-files`=146；实扫=168；差异清单 22 项（perf.mjs、store.txt、test_table_ast.ts、ui_screenshot.png、scratch/diagnostic.js + test-heading-click.cjs/js、test-results/ 6 个 error-context.md、tests/ 8 个 png/html）；check-ignore 命中：`*.png`(361)、`*.mjs`(362)、`*.txt`(358)、`test_*.ts`(306)、`scratch/`(386)、`test-results/`(387) | 目录整体已入库 ✓（2026-08-07 事故后白名单生效）；但 22 个被忽略文件中有调试脚本类（test_table_ast.ts、scratch/ 三件、perf.mjs、store.txt）——处于"被忽略=不可见=易丢"形态 | test_table_ast.ts 等调试脚本按 AGENTS.md 铁律应入库（加白名单例外或改名规避 test_*.ts）；截图/error-context 属运行产物可保持忽略 |
| 4-2 | **table-operations.test.ts 已被跟踪（b00951c3）**——任务书"未跟踪"记忆**已过时** | `git log -- tests/unit/table-operations.test.ts` = b00951c3（feat(markdown-editor): implement modern Excel-like table cell selection...）；ls-files tests/unit=25，工作区=25，全一致 | 无异常 | — |
| 4-3 | **测试套件完整：tests/unit 25 个文件全部跟踪，门禁 4 件套（grapheme/undo/parser-redos/chunk）齐备** | 25 文件清单逐一核对；package.json `"test": "vitest run tests/unit"` 与 AGENTS.md 门禁一致 | 门禁可跑 ✓ | — |
| 4-4 | **dirty 状态：检查初期 1 个 M（HiddenInput.tsx），检查后期目录变干净**（任务书"8 个 dirty"记忆已过时） | 会话内两次 status：先 ` M HiddenInput.tsx`，后无输出；期间外部进程有改动（stash 列表有 20 条 lint-staged 自动备份） | 无（已入库文件均在） | 提交纪律恢复后正常 |
| 4-5 | **历史风险点已修复：f772eb99 删除的 28 个根目录测试已恢复** | git log 可回溯（commit f772eb99 存在，恢复基线已在）；当前根目录测试文件在位 | 无异常 | — |

### 疑点 5：docs/guides 引用健康

| # | 结论 | 证据 | 影响 | 修复方向 |
|---|------|------|------|----------|
| 5-1 | **subagent-development.md（现行"权威开发指南"）引用路径全部断裂**：`packages/agent-subagent/`、`packages/agent-core/` 不存在 | Test-Path 均 False；guides 目录实扫只有 6 个跟踪文件（4 指南 + testing/ 2 份）；packages/ 现有：plugin-import-claude-codex/plugin-sdk/shared-types/shared-utils/test-utils（无 agent-subagent/agent-core/agent-runtime） | 指南是死文档：子代理系统的权威描述指向已删除的 TS 包（Rust 化后子代理在 crates/agent-tools 等实现）；读者按图索骥必然落空 | 重写为 Rust 侧真源（crates/ 实际实现），或标注废弃移入 archive；至少头部加"已过时"声明 |
| 5-2 | **hooks.md 已自标注【已废弃】**（packages/agent-runtime 已删）但仍在 guides/ 顶层 | hooks.md:3-6 明确"已废弃……本文仅作历史参考"；引用 packages/agent-runtime 全部不存在 | 废弃文档占用现行 guides/ 位置，误导检索 | 移入 docs/archive/（保留自述即可） |
| 5-3 | **plugin-development.md 引用健康**：packages/plugin-sdk、packages/shared-types/src/plugin.ts 均存在 | Test-Path 全 True | 无异常 | — |
| 5-4 | **四份指南的 ANTI_OVERENGINEERING_GUARDRAILS 引用悬空**（见 2-5，不重复） | 同上 | 见 2-5 | 见 2-5 |

### 疑点 6：plans-progress / schemes 孤岛

| # | 结论 | 证据 | 影响 | 修复方向 |
|---|------|------|------|----------|
| 6-1 | **`docs/plans/progress/` 23 份 = 已完成战役的波次跟踪，无索引、无归属，与 docs/archive/campaigns 下同性质文档（benchmark-evolution-plans 等）构成平行孤岛** | 23 文件全部已跟踪、status 干净；optimization-wave-board.md 头部显示 OPT-A~H 全部 "complete/landed"（2026-07-29）；A2-docs-tree-inventory.md（治理文档）未覆盖该目录（grep 无 plans/progress 命中）；同性质历史战役已入 archive/campaigns | 检索噪音：完成战役的波次台账在 docs/plans/ 活目录下，与新方案（feature-gap-analysis/plans、cache-optimization/03-plans）混置 | 整体移入 docs/archive/campaigns/optimization-waves/（git mv 保留历史） |
| 6-2 | **`docs/schemes/` 8 份 = Tiptap Chat Composer 迁移（Round 2）方案产物，已跟踪、无索引** | 8 文件：MASTER_PLAN/FINAL_REPAIR_SCHEME/SCHEME_*/SRS_REQUIREMENTS/SUBAGENT_TASK_GUIDE；头部确认对象 `reference/chat-composer-tiptap → apps/crish-desktop`（迁移已完成）；git 跟踪齐全 | chat-composer-tiptap 迁移已完成（2026-07），方案文档占 docs/schemes 活位置 | 移入 docs/archive/campaigns/（与 v2_plan_review 等并列）；SRS_REQUIREMENTS 若仍被 TIPTAP_MIGRATION_REQUIREMENTS 引用需同步改指 |
| 6-3 | **`docs/stability-closure/` 3 份全部未跟踪（ls-files=0）** | git status：`?? docs/stability-closure/10-analysis/01-data-migration-stability.md`、02-runtime-health-observability、03-boot-noise-logging-governance | 新战役文档完全未入库——与 2026-08-07 事故同形态 | 提交入库；补 README 或并入现行文档体系索引 |

### 疑点 7：05-memory-resilience 与 90-final 关系

| # | 结论 | 证据 | 影响 | 修复方向 |
|---|------|------|------|----------|
| 7-1 | **定位清晰：05 是缓存优化主战役（90-final，R0-R7，2026-08-03~04，T-01~T-48）之后的深化专项"记忆韧性与缓存命中"（轮次 1-7，2026-08-08）**，两者轮次体系独立、非并行方案 | 90-final R7-report（2026-08-03）收口；05 20-plan §14（2026-08-08 收尾登记）自称 v1.1 唯一实施主线；00-index 第 7 节并列登记；02-review 明确"与 P1/P4/P5 自洽、是 P1 的增强" | 无（关系可追溯） | 在 00-index 第 7 节补一句与第 6 节/90-final 的承接关系说明 |
| 7-2 | **30-review 的 P0 修复：实现存在于工作区但没有任何提交**——12 个实现源码文件全部 `??`（未跟踪），~30 个相关文件 M（未提交） | `git status` ?? 清单：conex-compaction（clean_output/recovery/summary_document）、conex-db（blocks.rs + tests/blocks.rs）、orchestrator/blocks.rs、agent-tools（compression_store/decompress_context/project_tree/search_context）、session-loop（summary_coordinator/summary_dispatch）；M 清单：conex-db（lib/migrate/migrations.rs 测试）、conex-compaction（lib/ai_summary）、conex-telemetry（cache/mod/signature）、session-loop（cache_tracker/lib/handlers 3 件/tool_exec）、orchestrator（events/lib/session）、agent-tools（context/lib/middleware/readonly/tools）等 | **最严重资产风险**：声称"轮次 1-7 全部完成、cargo 89 块全绿"的整套实现停留在未提交工作区——磁盘损坏/清理/误操作即整体丢失（2026-08-07 事故同形态），且 37153189 提交的只有文档，实现零提交 | **立即分批复刻提交**：① 05 实现批（12 ?? + 相关 M + Cargo.toml/Cargo.lock）；② 30-review + 00-index + 20-plan 文档批；③ stability-closure 批；跑通门禁（cargo test --workspace）后逐批提交 |
| 7-3 | **P0 修复方向与工作区代码一一对应**（文档裁决 → 代码已实现，均未提交） | P0-1/01（Task 重号）→ 20-plan v1.1 §10 全局唯一编号 ✓；P0-2（轮次依赖）→ 轮次 1→2→3→4→5/6→7 ✓；P0-3/P0-A（块表主键跨会话冲突）→ conex-db/src/blocks.rs:4,146 复合主键 (session_id, block_id) + INSERT OR IGNORE 幂等键 ✓；P0-4（两阶段写协议）→ blocks.rs:146 同处 ✓；P0-5（同步阻塞 300s）→ 20-plan §14.2 R-F 仲裁 ✓；P0-C（调度器跨 run）→ summary_coordinator.rs 存在（含 registry.remove，20-plan §14.3 挂账 3）✓；P0-D（R-C 死锁）→ R-C"stub 永不改写"裁决 ✓ | 评审闭环完整，但"无提交"使 P0 修复形同虚设（见 7-2） | 提交后回填"修复提交号"到 20-plan §14 |
| 7-4 | **37153189 是 05 文档的唯一提交，且是混入 commit（主题为 markdown-editor 修复 + .agents 批）** | `git log -- docs/cache-optimization/05-memory-resilience` 仅 37153189（2026-08-08）；diff-tree 确认其含 05 文档 5 份（10-analysis×4 + 20-plan/00），但 commit 标题/主体为 markdown-editor 修复 | 05 文档无独立提交记录，审计追溯困难 | 不做历史改写；后续文档变更独立提交 |

---

## 二、索引修正建议清单（按优先级）

| 优先级 | 动作 | 对象 | 备注 |
|--------|------|------|------|
| P0 | **提交 05 实现 + 文档批**（12 ?? + ~30 M + 30-review×2 + 00-index + 20-plan） | crates/ ×5、docs/cache-optimization/ | 先跑 `cargo test --workspace` 门禁再提交；提交后 20-plan §14 回填提交号 |
| P0 | **提交 stability-closure 3 份** | docs/stability-closure/ | 与 05 同形态未入库 |
| P1 | **提交 plans/05-浏览器协同与电脑操作方案.md** | docs/feature-gap-analysis/plans/ | 唯一未入库方案 |
| P1 | **00-index 补登记**：第 6 节标题改"根目录"；新增 90-final/ 15 份清单节；新增 10-model-catalog-v2 节（14 份 + 99-project-closure） | docs/cache-optimization/00-index.md | 与 05 节同期提交 |
| P1 | **feature-gap-analysis 建 README**：audits/ 现行 vs audit/ 历史声明 | docs/feature-gap-analysis/ | 消除双目录歧义 |
| P1 | **修复 ANTI_OVERENGINEERING_GUARDRAILS 引用**（6 处）：REQ-agent-engine-capabilities:41、guides 4 份、organization/A1 状态注 | 5 文件 | 统一指 `../archive/legacy/ANTI_OVERENGINEERING_GUARDRAILS.md` |
| P2 | **归档**：plans/progress 23 份 → archive/campaigns/optimization-waves/；schemes 8 份 → archive/campaigns/（git mv） | docs/plans/progress、docs/schemes | 全部已完成战役；A2 清单同步 |
| P2 | **guides 收束**：subagent-development 改指 Rust 真源或标注废弃；hooks.md 移 archive | docs/guides/ | 5-1/5-2 |
| P2 | **99-closure-check 内部一致性**：遗留 4 状态回写"已关闭（ac554c99）" | docs/cache-optimization/90-final/99-closure-check.md | 3-3 |
| P2 | **markdown-editor 调试脚本入库**：test_table_ast.ts、scratch/ 三件（perf.mjs/store.txt 可议） | reference/markdown-editor/ | 规避 .gitignore `test_*.ts`(306)/`scratch/`(386) 规则，或加白名单例外 |

---

## 三、总结

- **索引失真项数**：3 类（10-model-catalog-v2 14 份未登记；90-final 15 份未登记 + 第 6 节路径错标；05 节登记了未入库文件），另 4 个目录（feature-gap-analysis / plans / schemes / stability-closure）整体无索引。
- **资产风险数**：21 个未入库文件（05 实现源码 12 + 30-review 2 + plans-05 1 + stability-closure 3 + 会话 db 产物 3）+ ~30 个未提交修改 + markdown-editor 22 个被忽略调试/产物文件。
- **最严重一项**：05-memory-resilience 的"轮次 1-7 已实施完成"整套实现（12 个新源码 + ~30 个修改文件，含 blocks.rs 复合主键等 P0 修复）**全部停留在未提交工作区**，文档却已登记完成态——与 2026-08-07 参考目录资产事故同形态的丢失风险，须最先处理。

（检查时点：2026-08-09；依据文件实扫与 git 只读命令，未做任何写操作）
