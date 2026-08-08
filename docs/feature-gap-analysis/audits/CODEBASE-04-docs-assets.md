# CODEBASE-04 文档体系与资产现状审计（只读）

> 子代理：A4（文档体系与资产）｜性质：只读分析｜日期：2026-08-08
> 范围：未跟踪文档探查、docs 体系盘点、reference 资产状态、索引完整性、问题清单
> 方法与证据：`git status --porcelain`、`git ls-files`、`git check-ignore -v`、目录/文件实盘统计、关键文档头部抽查；所有结论均带可复核证据。

---

## 一、未跟踪文档探查

### 1.1 全仓未跟踪清单（git ls-files --others --exclude-standard，共 4 项）

| # | 路径 | 大小 | 修改时间 | 性质 |
|---|------|------|----------|------|
| 1 | `docs/cache-optimization/05-memory-resilience/30-review/01-integrated-plan-review.md` | 27 KB | 2026-08-08 17:30 | 方案评审（结论：不可执行，5 个 P0） |
| 2 | `docs/cache-optimization/05-memory-resilience/30-review/02-integrated-plan-review.md` | 48 KB | 2026-08-08 17:45 | 架构/代码/数据流评审（P0 清单 4 处） |
| 3 | `reference/markdown-editor/tests/test-scroll-bug.cjs` | — | — | 编辑器调试脚本（测试资产） |
| 4 | `reference/markdown-editor/tests/unit/table-parser-ast.test.ts` | — | — | 单元测试（受保护资产，门禁文件） |

排除项说明：`git status` 顶部仅 3 项修改（`messageWindow.ts`、`layout.ts`、`main.tsx` 均已有对应 diff，见 §3.2）；已用 `git check-ignore -v` 验证 4 项均**不是**被 .gitignore 排除，而是纯未 `git add`（`.gitignore:361-363` 的 `!docs/**/*.md`、`!docs/**/*.txt` 白名单放行 docs 文档）。

### 1.2 `docs/cache-optimization/05-memory-resilience/` 是什么

- **内容主题**（8-08 当日生成，6 份文件）：内存韧性 / 缓存命中专题，与缓存优化既有方案 P1/P4/P5 直接关联：
  - `10-analysis/01-compression-recoverable.md`（277 行）：压缩可恢复性——压缩丢原文、仅存 `context-compression-end` 事件 id 清单（证据：`crates/session-loop/src/loop/handlers/mod.rs:360-382`）；
  - `10-analysis/02-cache-hit-prefix.md`（305 行）：缓存命中前缀稳定性（代码实读 `find_cut_point_inner`，lib.rs:544-639）；
  - `10-analysis/03-project-tree-and-cleanup.md`（307 行）：project_tree 超时上传与清理；
  - `10-analysis/04-summary-evolution.md`（486 行）：摘要演化（折叠链）；
  - `20-plan/00-integrated-plan.md`（v0.1，364 行）："append-only 折叠链 + 摘要进缓存"一体化实施计划，T-01~T-31 任务；
  - `30-review/01、02` 两份评审：**01 结论"不可执行，v0.1 需重写"（5 个 P0，如 R-A 合并到 01 DDL、`block_id` 全局唯一约束缺失 → 会话内 id 碰撞），02 结论"架构契合但 4 处关键位置存在数据流正确性缺陷"（P0-A 块 id 与消息 id 冲突等）**。
- **谁建的 / 何时入库**：`git log --diff-filter=A` 证实该目录由提交 `37153189`（消息为 "fix(editor): resolve HR click jumping bug..."，8-08）引入——即 10-analysis 与 20-plan 被**编辑器修复任务的提交顺手带入**，与提交消息主题无关。
- **与既有方案的关系**：02 评审明示评审对象引用 `03-plans/P1-prefix-stability.md`、`P4-history-context-management.md`、`P5-cache-telemetry.md` 及 `reference/billion-context-pi`（ACP compress/decompress 验收基准）——是缓存优化主线的延伸专题，但 **00-index.md 未登记、全仓无任何文档引用它（grep 0 命中）**，属"孤岛方案"。

### 1.3 其他未跟踪状态

- `reference/` 其余项目（opencode/grok-build/codex-cli/pi/jcode/DeepSeek-Reasonix/claudeCode/kimi-code/litellm 等 37+ 个）均为**有意未跟踪的本地克隆**（`.gitignore:59 reference/*`，白名单仅 6 个：markdown-editor/ui-replica/ui-replica-refactored/newui/crish-desktop）——不属于异常。
- `docs/feature-gap-analysis/` 60 份文件全部已跟踪，无未跟踪项。

---

## 二、docs 体系盘点

### 2.1 顶层目录统计（2026-08-08 实盘）

| 目录 | md 数 | 最后修改 | 说明 |
|------|------|----------|------|
| cache-optimization | 64 | 08-08 17:30 | 活跃（05-memory-resilience 当日新增） |
| organization | 48 | 08-08 17:28 | 活跃（audit/plan/99-EXECUTION-FINDINGS.md） |
| composer-preview | 528 | 08-06 13:51 | **项目源码目录混入 docs/**（190 文件被 git 跟踪） |
| feature-gap-analysis | 60 | 08-07 20:39 | 活跃（audits/ 3 份 PERSIST 审计） |
| multi-agent-repair | 54 | 08-06 16:33 | 活跃 |
| rust-rewrite | 48 | 08-05 14:45 | 已进入收尾期（33 事件 changelog） |
| plans | 23 | 08-02 13:47 | 停滞（progress/ 全为 07-29 执行记录） |
| archive | 208 | 08-02 21:22 | 归档（正常，六类齐全） |
| architecture | 12 | 08-02 21:22 | 停滞（ADR 类，8-02 后无更新） |
| schemes | 8 | 08-04 14:34 | 历史方案（Tiptap 迁移） |
| requirements | 6 | 08-04 20:57 | WYSIWYG_LIVE_PREVIEW_SPEC 等 |
| guides | 6 | 08-02 21:22 | **内容引用已删除的 TS 包（见 §5）** |
| opensource | 6 | 08-02 13:47 | 正常 |
| markdown-editor | 2 | 08-03 17:11 | 孤岛（ux-readiness/ 2 份，无索引） |

### 2.2 孤岛文档（无索引引用、无其他文档引用）

| 孤岛 | 文件数 | 证据 |
|------|--------|------|
| `cache-optimization/05-memory-resilience/` | 6 | 00-index.md 无登记；全仓 grep "05-memory-resilience" 0 命中 |
| `cache-optimization/10-model-catalog-v2/` | 20 | 已闭环（99-project-closure.md，8-04），00-index.md 无登记 |
| `cache-optimization/90-final/` 轮次报告 | 15 | 索引 §6 仅列 1 份，R0~R7 报告 + 99-closure-check 未登记 |
| `markdown-editor/ux-readiness/` | 2 | 8-03 编辑器调研，无任何索引 |
| `plans/progress/` | 15+ | 07-29 执行记录，停滞且无索引 |
| `schemes/` | 8 | 历史方案无索引 |
| `architecture/` | 12 | ADR 无索引，8-02 后停滞 |
| `organization/audit/` | 28 | 8-08 当日执行审计（F1-F10/PS-01~05/R1-R3），无索引 |

### 2.3 过期文档抽查（与代码现状对比，5 份）

1. **`docs/guides/subagent-development.md`**：引用 `@crish/agent-subagent`、`agent-core/tools/mcp/orchestrator/daemon` 全部包——`packages/` 现仅剩 plugin-import-claude-codex/plugin-sdk/shared-types/shared-utils/test-utils（Test-Path 均 False）。子 Agent 机制已迁移 Rust 侧（AGENTS.md 载明 session-loop/orchestrator），此指南整篇失效。
2. **`docs/rust-rewrite/00-master-plan.md`**：状态行"进行中，Phase A 知识采集"——实际 8-02 已执行到 34-cleanup-closure（收尾清单），状态行未更新。
3. **`docs/rust-rewrite/34-cleanup-closure.md`**：清理清单状态列仍为"？已改/？已删"待确认（如 `is-danger` 类、`AgentContextMenuState` 4 props 删除），未闭合。
4. **`docs/cache-optimization/00-index.md`**：最后更新 8-03 01:45，目录实态 7 个子目录但索引仅登记 01-04/90 顶层一份；05/10/90-final 轮次全漏。
5. **`docs/organization/A1-root-docs-inventory.md`**：8-02 清单 53 份根目录文档处置表，状态多为"归档/删除"待办——现状根目录仅剩 9 份规范文档（AGENTS/ARCHITECTURE/CHANGELOG 等），处置已大体完成但清单未闭合。

---

## 三、reference 资产状态

### 3.1 总览

- 43 个参考项目目录，git 跟踪白名单仅 6 个：markdown-editor（128 文件）、ui-replica-refactored（73）、crish-desktop（13）、ui-replica（7）、newui（3）。
- 其余 37+（opencode/grok-build/codex-cli/pi/jcode/DeepSeek-Reasonix/claudeCode/kimi-code/litellm/billion-context-pi 等）为未跟踪本地克隆（嵌套 .git），符合 `.gitignore:58-84` 设计意图，非异常。

### 3.2 markdown-editor 受保护资产状态（铁律门禁）

- **测试门禁完好**：`package.json` 仍含 `"test": "vitest run tests/unit"`；tests/unit 20 个测试文件齐（grapheme/undo/parser-redos/chunk/table-operations 等），tests/e2e 13、legacy 32、截图资产均已入库。
- **风险 1（未入库）**：`tests/unit/table-parser-ast.test.ts`、`tests/test-scroll-bug.cjs` 未跟踪（见 §1.1）。
- **风险 2（工作区脏）**：8 个文件有未提交修改——`src/components/{BlockRenderer,HiddenInput,InlineRenderer,MarkdownEngine}.tsx`、`src/core/{EditorStore,TableOperations}.ts`、`src/index.css`、`tests/e2e/matrix-tables-excel.spec.ts`（git diff 198+/223-）。当前为"编辑器修复"会话进行中状态（对应 37153189 提交序列），若被误 clean/checkout 将丢失进展。
- 无新加入的白名单项目；其余目录（chat-composer-component/chat-composer-tiptap/conex-workbench-prototype/oh-my-pi/readable-stream 等）仍按 2026-07-31 清单保持未跟踪。

---

## 四、索引完整性

| 项 | 状态 | 证据 |
|----|------|------|
| `cache-optimization/00-index.md` vs 目录实态 | **不一致** | 01/02/03/04 与索引吻合（10/1/6/3）；但 05-memory-resilience（6 份）、10-model-catalog-v2（20 份）未登记；§6"最终方案（1 份，90-final/）"仅列 `90-final-multi-agent-repair-plan.md`（该文件实际位于 `docs/cache-optimization/` 顶层而非 90-final/），90-final/ 实际 15 份轮次报告（R0~R7 + closure）零登记（00-index.md:58-62） |
| `feature-gap-analysis` 索引 | **无** | 60 份文件（REQ-* 10 份 + plans 6 + audit 28 + audits 3）无 00-index/README/导航文档；audits/ 现有 PERSIST-01/02/03（8-07），本文档为第 4 份 |
| `multi-agent-repair` | 有 | 00-方案总览.md 等齐（AGENTS.md 亦引用） |
| `rust-rewrite` | 有 | 00-master-plan.md 为总纲（但状态行过期，见 §2.3） |
| `organization` | 部分 | audit/ 目录 28 份无索引（00-REMEDIATION-PLAN.md 为执行计划，非导航索引） |

---

## 五、问题清单

### P0（资产风险）

| # | 问题 | 证据 |
|---|------|------|
| P0-1 | **05-memory-resilience 两份评审（含 5+4 个 P0 结论）未入库**：评审是"方案不可执行、需重写"的裁决依据，若丢失，v0.1 重写失去审计基线 | git ls-files --others 第 1-2 项；01 评审"5 个 P0"、02 评审 P0-A~C |
| P0-2 | **markdown-editor 2 个新测试资产未入库**（table-parser-ast.test.ts 属门禁 unit 套件），违反"测试是资产不是杂物"铁律 | §1.1 第 3-4 项 |

### P1（文档与代码脱节）

| # | 问题 | 证据 |
|---|------|------|
| P1-1 | **00-index.md 索引失真**：05/10-model-catalog-v2/90-final 轮次未登记，且 §6 文件位置标注错误 | §4 首行 |
| P1-2 | **markdown-editor 8 个文件未提交修改**：进行中工作区脏，跨会话风险 | git diff 198+/223- |
| P1-3 | **subagent-development.md 整篇引用已删除 TS 包**（agent-subagent 等 6 包），指南失效且未指向 Rust 侧新机制 | §2.3-1；packages/ 实盘 |
| P1-4 | **05-memory-resilience 与提交 37153189 主题错配**：记忆韧性方案文档被"编辑器修复"提交顺手带入，提交历史无法回溯其归属与配套评审 | git log --diff-filter=A |

### P2（整洁度）

| # | 问题 | 证据 |
|---|------|------|
| P2-1 | docs/ 顶层混入项目源码：composer-preview 190 文件被跟踪（含 node_modules/dist 之外全部 src），与"docs 是文档目录"约定冲突 | git ls-files docs/composer-preview = 190 |
| P2-2 | 8 个孤岛目录无索引（05/10-model-catalog-v2/90-final 轮次/markdown-editor/plans-progress/schemes/architecture/organization-audit） | §2.2 |
| P2-3 | rust-rewrite 00-master-plan 状态行与 34-cleanup-closure 未闭合（状态列"？已改/？已删"） | §2.3-2/3 |
| P2-4 | A1-root-docs-inventory 处置清单未闭合（处置已实质完成） | §2.3-5 |

---

## 六、最值得关注 5 项

1. **P0-1：05-memory-resilience/30-review 两份评审未入库**——评审裁定 v0.1 不可执行（5+4 个 P0），是后续重写方案的唯一审计基线，应立即 `git add` 提交。
2. **P0-2：markdown-editor 门禁测试 table-parser-ast.test.ts 未入库**——受保护资产红线，缺一不可。
3. **P1-2：markdown-editor 8 个源文件未提交修改**——编辑器修复进行中状态，工作区脏是跨会话丢失风险源。
4. **P1-1/P1-4：05-memory-resilience 孤岛化**——索引未登记、提交归属错配，方案延续性差；建议补登记并（或）迁移至 90-final 系列编号。
5. **P1-3：docs/guides/subagent-development.md 引用已删除 TS 包**——子 Agent 机制文档与 Rust 侧现状完全脱节，需要重写或标注废弃。
