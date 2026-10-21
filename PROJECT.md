# Project: Conex Tiptap Composer Migration Blueprint Series

## Architecture
- **Target Project**: Conex (Rust kernel + Tauri shell + React desktop frontend `apps/crish-desktop`).
- **Core Objective**: Execute a 4-round multi-agent collaboration process to design and generate a massive, multi-file Tiptap Composer migration scheme blueprint series in `C:\Software\conex\docs\schemes`.
- **Target Deliverable Directory**: `C:\Software\conex\docs\schemes/`

## Feature Inventory
| # | Feature | Description | Milestone | Target Deliverable | Source |
|---|---------|-------------|-----------|--------------------|--------|
| 1 | Baseline SRS Requirements | Baseline Software Requirements Specification defining explicit red lines (5% UI mix limit, line-count guardrails, IPC interceptors, anti-overengineering rules, etc.) | M0 | `SRS_REQUIREMENTS.md` | Survey |
| 2 | Round 1 Draft Blueprint | Initial logical dispatch blueprint, migration architecture, 6-stage repair lifecycle, and stub strategy | M1 | `DRAFT_BLUEPRINT.md` | SRS & Codebase |
| 3 | Round 2 Master Plan | Conflict-prevention review, anti-collision stub phase design, single source of truth definition, and overall master plan | M2 | `MASTER_PLAN.md` | Round 1 & SRS |
| 4 | Round 3 Frontend Scheme | Detailed Frontend Component Layer scheme: Tiptap integration in `apps/crish-desktop`, visual guidelines, editor extensions, keymaps, custom tooltips, line limits, focus states | M3 | `SCHEME_FRONTEND.md` | Master Plan |
| 5 | Round 3 IPC Bridge Scheme | Detailed IPC Bridge Layer scheme: Tauri command map, message serialization/deserialization, IPC interceptors, security boundaries, rate limiting, async streams | M3 | `SCHEME_IPC.md` | Master Plan |
| 6 | Round 3 Data Model Scheme | Detailed Data Model Layer scheme: Session storage, Rust DB write model, Zustand/React store facade, draft persistence, attachment metadata, conflict resolution, memory explosion protection | M3 | `SCHEME_DATA.md` | Master Plan |
| 7 | Round 4 Subagent Task Guide | Decoupled pure subagent task guidance, prompt templates, operational rules, role constraints, and task cards for max 6 parallel subagents | M4 | `SUBAGENT_TASK_GUIDE.md` | Round 3 Schemes |

## Milestones
> 状态更新于 2026-10-20（统一修复战役 T-DOC-01 / GAP-06：M0–M4 按仓库现状核实，取代原五个里程碑全部「未开始」的旧口径）。三列口径：**方案已产出** = 交付文件在 `docs/schemes/` 实际存在（`ls` + `wc -l` 实测）；**代码已接入** = 方案对应的迁移代码在仓库可验证；**验收已通过** = 门禁/审计证据现状。证据命令见各格括号。

| # | Name | Scope | Dependencies | Status | 方案已产出 | 代码已接入 | 验收已通过 |
|---|------|-------|-------------|--------|-----------|-----------|-----------|
| M0 | Baseline Requirements Documentation | Generate SRS requirements in `docs/schemes/SRS_REQUIREMENTS.md` | Survey | COMPLETED | ✅ `SRS_REQUIREMENTS.md`（425 行，`wc -l` 实测） | —（需求文档轮，无直接代码面） | ⚠️ 部分：M0 门禁第 1 轮 FAIL → 修复迭代已执行（`.agents/orchestrator/GATE_STATUS.md`、`progress.md` Phase 4–5） |
| M1 | Round 1 — Initial Draft Blueprint | Draft initial blueprint in `docs/schemes/DRAFT_BLUEPRINT.md` | M0 | COMPLETED | ✅ `DRAFT_BLUEPRINT.md`（836 行） | —（蓝图轮） | ⚠️ 部分：同上，审计驱动迭代（Phase 4–5） |
| M2 | Round 2 — Master Plan Synthesis | Produce conflict-prevention review & `docs/schemes/MASTER_PLAN.md` | M1 | COMPLETED | ✅ `MASTER_PLAN.md`（783 行） | —（总案轮） | ⚠️ 部分：同上 |
| M3 | Round 3 — Dimension Detailing | Output `SCHEME_FRONTEND.md`, `SCHEME_IPC.md`, `SCHEME_DATA.md` | M2 | COMPLETED | ✅ 三文件（836 / 778 / 788 行） | ✅ Tiptap 迁移代码已落地：`@tiptap/* ^3.31.4` 在 `apps/crish-desktop/package.json`；`apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx` 等组件存在（`rg -l TiptapEditorField` 实测）；`progress.md` Phase T0–T3 completed | ⚠️ 部分：Phase 4 三审计 REJECTED → Phase 5 修复执行完毕；Phase 6 复审记录截至 2026-08-04（`progress.md` last visited） |
| M4 | Round 4 — Final Audit & Task Guide | Output `SUBAGENT_TASK_GUIDE.md` & execute final audit | M3 | COMPLETED | ✅ `SUBAGENT_TASK_GUIDE.md`（555 行）；另有合并终案 `FINAL_REPAIR_SCHEME.md`（3782 行） | ✅ 按任务指南实际派工执行：`progress.md` 15 个子 Agent 派工记录（T0–T5 worker + 修复轮） | ⚠️ 部分：终审「全绿」记录缺失——Phase 6 复审 in-progress 后未留终态门禁记录；终态验收须按当前 HEAD 复跑 `FULL_CHECK_COMMANDS.md` 门禁 |

## Interface Contracts & Governance Rules
- All output blueprint files must be placed directly in `C:\Software\conex\docs\schemes/`.
- Must produce at least 5 independent core markdown files totaling thousands of lines.
- Refuse single-file aggregation or over-simplification; retain all low-level technical details, API contracts, stub designs, error codes, and test matrices.
- Enforce strict Conex Anti-Overengineering rules (no kernel-level sandboxes, no SharedArrayBuffer ring buffers, no sliding-window CircuitBreaker, no sliding background model switching).
- Enforce Red Lines: UI color contrast limits (max 5-10% focus mix), line-count limits (UI components <= 500 lines, logic <= 400 lines, types <= 800 lines), custom Tooltips only (no native HTML title attributes), no heavy box-shadows on input fields, zero circular dependencies, layer decoupling.
- Max 6 parallel subagents in task allocation guidelines.
- Decouple pure subagent task guidance into `SUBAGENT_TASK_GUIDE.md`.

## Document Layout
- `.agents/orchestrator/`: Orchestrator metadata (`BRIEFING.md`, `plan.md`, `progress.md`, `DISPATCH.md`, `GATE_STATUS.md`).
- `docs/schemes/SRS_REQUIREMENTS.md`: Baseline SRS requirements specification.
- `docs/schemes/DRAFT_BLUEPRINT.md`: Round 1 logical dispatch blueprint.
- `docs/schemes/MASTER_PLAN.md`: Round 2 conflict-prevention master plan.
- `docs/schemes/SCHEME_FRONTEND.md`: Round 3 Frontend Component Layer detailed scheme.
- `docs/schemes/SCHEME_IPC.md`: Round 3 IPC Bridge Layer detailed scheme.
- `docs/schemes/SCHEME_DATA.md`: Round 3 Data Model Layer detailed scheme.
- `docs/schemes/SUBAGENT_TASK_GUIDE.md`: Round 4 Decoupled subagent task guidance & prompt manual.

