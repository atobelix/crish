# A2 docs/ 目录树清点与分析

> 分析方式：只读。基于 `docs-dirs-list.txt`（清单）与 `Get-ChildItem` 实况核对，对 28 个子目录与 17 个根级 md 逐一抽样（每目录 1-2 个代表文件头部）。
> 分析日期：2026-08-02

## 0. 结论摘要

1. **规模**：docs/ 共 28 个子目录 + 17 个根级 md + 1 个根级 json（provider-index.json），递归文件总数约 **358**。
   - 注意：`docs-dirs-list.txt` 记录的是**顶层文件数**，与递归实况偏差大（如 `loading page` 记 20 实际 44、`rust-rewrite` 记 20 实际 48、`plans` 记 7 实际 30、`v2_plan_review` 记 25 实际 67）。
2. **活跃度分四类**：
   - **活跃（真源）**：`rust-rewrite/`（2026-08-02 仍在执行）、`architecture/`（2026-08 初规范）、`plans/`（2026-07-29 台账）、`organization/`（本次治理）。
   - **M4 交付产物**（Provider 系统，2026-07-23 前后收口）：根级 POST-M4 系列、`provider-dx/`、`audit/`、`security/`、`performance/`、`perf/`。
   - **历史多 Agent 修复战役**（2026-07-22~25）：`benchmark-evolution-plans/`、`system-completion-plans/`、`ui-jank-message-dnd-rootfix/`、`crish_desktop_architectural_remediation_plan/`、`round_12_audit/`、`refac/`、`refactor-guides/`、`v2_plan_review/`、`systematic_solution_plan/` 等。
   - **原型/草稿**：`loading page/`（含 node_modules 的完整 Vite 项目）、`new/`（HTML 副本）、`rust-architecture-redesign/` 与 `system-enhancement-plans/`（与 rust-rewrite 重叠的并行提案）。
3. **编码问题**（移动/归档时应一并处理，本次只读不动）：
   - 文件名为 GBK 乱码：`architecture-improvement/`、`architecture-review/`、`new/` 全部文件，`v2_plan_review/` 部分文件。
   - 文件内容为 UTF-16 错乱编码：`rust-rewrite/UPGRADING.md`（2026-08-02 活跃文档！）、`rust-rewrite/audits/AA-01~` 部分、`crish_desktop_architectural_remediation_plan/00_master_overview.md`、`security/FINAL-SECURITY-AUDIT-M4.md` 等。
4. **时效风险点**：`systematic_solution_plan/plan.md` 已在文首自标 **HISTORICAL (OPT-E8 / W4-2)**；`architecture/workbench-session-actions-and-split-view.md` 明确说明旧前端目录 `apps/crish-desktop/src/store/session-actions/` 已删除（OPT-E8 清理）；根级 `README.md` 仍是旧 "Crish Documentation Index"，未反映当前结构。

---

## 1. 清单核对（docs-dirs-list.txt vs 实况）

| 目录 | 清单记数 | 递归实况 | 差异原因 |
|---|---|---|---|
| analysis | 0 | 8 | 文件全部在 `agent-loop/` 子目录 |
| benchmark-evolution-plans | 3 | 10 | 有 `audits/`、`plans/` 子目录 |
| loading page | 20 | 44 | 含 node_modules（19 个） |
| plans | 7 | 30 | 有 `progress/` 子目录（23 个） |
| refactor-guides | 8 | 9 | 有 `reviews/` 子目录 |
| rust-rewrite | 20 | 48 | 有 `audits/`(13)、`plans/`(14)、`contracts/`(1) |
| system-completion-plans | 3 | 9 | 有 `audits/`、`plans/` |
| ui-jank-message-dnd-rootfix | 4 | 7 | 有 `audits/` |
| v2_plan_review | 25 | 67 | 有 `repair_plans/round_outputs/`（40 个中间 JSON/txt） |
| 其余 19 目录 | 一致 | 一致 | — |

---

## 2. 子目录逐一分析

格式：`名称 | 实况文件数 | 主题 | 时效判断 | 建议`

| # | 名称 | 文件数 | 主题 | 时效 | 建议 |
|---|---|---|---|---|---|
| 1 | analysis | 8 | `agent-loop/`：外部参考（pi-agent、oh-my-pi、grok-build）agent loop 源码分析 + conex 问题分析 + 多 Agent 修复方案 A/B | 2026-07-24，研究参考性质，已完成使命 | **归档** → archive/redesign/analysis（保留作参考） |
| 2 | architecture | 12 | 活跃架构规范：system-map、run-control、daemon 协议、ADR、desktop composition、observability | **活跃**（2026-08 初，引用当前代码路径与 OPT-E8 术语） | **保留原位**（核心规范真源） |
| 3 | architecture-improvement | 4 | 全量问题总览（ARC/STATE/ERR/PERF…编号体系）+ 统一改进方案 | 2026-07-16 前后，问题清单已被后续战役吸收 | **归档**（GBK 文件名，移动时改名） |
| 4 | architecture-review | 10 | 10 个诊断方向（解耦、状态、恢复、安全、可观测性…） | 2026-07-16 前后，诊断性文档 | **归档** |
| 5 | audit | 1 | M1-M4 Provider 系统集成审计报告 | 2026-07-23，M4 战役收口 | **归档** → archive/provider-m4 |
| 6 | benchmark-evolution-plans | 10 | 基准演进多 Agent 战役（00 路线图 + 4 份 plans + audits） | 2026-07-22，战役已结束 | **归档** → archive/campaigns |
| 7 | conversation_flow_plan | 1 | 对话流界面系统设计（现状分析 + 改进方案） | 2026-07-30 前后，与 rust-rewrite 03-frontend-contract 重叠 | **归档**（可并入 design 类） |
| 8 | crish_desktop_architectural_remediation_plan | 11 | 系统性代码修复方案（00 总览 + 10 分册：foundation/rust/daemon/state/UI/perf…） | 2026-07-2x，部分文件 UTF-16 错乱 | **归档** → archive/campaigns（与 v2_plan_review 同源系列） |
| 9 | design | 1 | Tool-Level Circuit Breaker 设计 | 2026-07-23，已实现（`providerBreaker.ts`） | **归档** |
| 10 | loading page | 44 | Vite + React 加载页原型（6 套方案 TSX + 19 个 node_modules 文件） | 被放弃的原型项目，**非文档** | **移出 docs**：代码资产另置或删除 node_modules 后归档 |
| 11 | new | 4 | HTML 骨架副本（skeleton_*.html） | 原型副本 | **归档** → archive/prototypes（或删除） |
| 12 | organization | 2 | 本次文档治理工作（清单 txt） | **活跃** | **保留** |
| 13 | perf | 3 | Crish Desktop 性能整改多 Agent 方案 + 验证清单 + ps1 | 2026-07-2x，性能项已被 rust-rewrite PE-09 接替 | **归档** → archive/provider-m4 或 campaigns |
| 14 | performance | 1 | Provider 引擎 Rust benchmark（cargo bench -p conex-stream） | M4 交付资产 | **归档** → archive/provider-m4 |
| 15 | plans | 30 | 2026-07 计划系列 + `progress/` 台账（ledger、wave、opt-e8、hotfix） | **活跃**（progress/system-control-ledger 更新至 2026-07-29） | **保留原位** |
| 16 | provider-dx | 5 | Provider 系统开源文档（ARCHITECTURE/CONTRIBUTING/DEV-ENVIRONMENT/CATALOG/TROUBLESHOOTING，英文） | M4 交付，面向外部贡献者，仍具引用价值 | **移入** opensource/（或保留；若开源面独立则移出 docs） |
| 17 | refac | 15 | 重构执行计划 + P1-P12 逐域审计（error/session/tool/steering/…） | 2026-07-2x，审计结论已被 rust-rewrite 吸收 | **归档** → archive/campaigns |
| 18 | refactor-guides | 9 | 全局性能重构指导（00-MASTER + 6 维指南 + reviews + 2026-07-25 审计状态） | 2026-07-2x 战役文档（含当日会话记录） | **归档** → archive/campaigns |
| 19 | round_12_audit | 20 | Round 12 十二份审计 + R1-R9 落审 + 方案 A/B/C + 截图 | 2026-07-24 | **归档** → archive/campaigns |
| 20 | rust-architecture-redesign | 8 | Conex 架构重构提案（CX-ARCH-001 总览 + 7 维度：PTY 沙箱/模糊搜索/压缩/零拷贝 IPC/actor 调度/…） | 2026-07-21 提案，**与 rust-rewrite 高度重叠** | **归档**（00 总览可留作历史提案，余入 archive/redesign） |
| 21 | rust-rewrite | 48 | 当前 Rust 重构主战役：00-master-plan + 语义契约（01/02/03）+ PE-01~12 任务书 + audits（AA/AU/PE）+ 34-cleanup | **活跃**（30-phase-e、34-cleanup-closure 更新于 2026-08-02） | **保留原位**（当前唯一活跃重构真源） |
| 22 | security | 3 | M1M2/M4 安全审计 + DNS Rebinding 评估 | 2026-07-2x，结论已吸收进 rust-rewrite/31-security-baseline | **归档** → archive/provider-m4 |
| 23 | system-completion-plans | 9 | 系统补全战役（provider 网关/MCP 权限/目标循环/会话分叉/插件 UI） | 2026-07-22，战役已结束 | **归档** → archive/campaigns |
| 24 | system-enhancement-plans | 5 | Rust 内核下沉设计（native offloading/索引/存储/QA） | 2026-07-21，与 rust-architecture-redesign 同源，被 rust-rewrite 吸收 | **归档** → archive/redesign |
| 25 | systematic_solution_plan | 1 | 系统性改进方案 | 文首自标 **HISTORICAL** | **归档** → archive/campaigns |
| 26 | testing | 2 | 集成测试插件路线图（预研备忘）+ Tauri 2 L3 smoke 指南 | tauri-native-smoke-guide 描述当前架构（apps/agent-workbench + Rust），**仍有效** | **移入** guides/testing/（或保留原位） |
| 27 | ui-jank-message-dnd-rootfix | 7 | UI jank / 消息 DnD 根治战役（00 路线图 + contract + audits） | 2026-07-2x | **归档** → archive/campaigns |
| 28 | v2_plan_review | 67 | v2 终极多 Agent 协同修复方案评审（含 40 个 round_outputs 中间 JSON/raw_errors） | 2026-07-25，评审战役结束，中间产物占比高 | **归档** → archive/campaigns（md 全留，JSON/txt 中间产物可按需清理） |

---

## 3. 根级散落文档分析（17 个 md + 1 个 json）

### 3.1 M4 Provider 交付系列（9 个，建议整体归档 → archive/provider-m4/）
| 文件 | 判断 |
|---|---|
| AGENT-DISPATCH-MAP-POST-M4.md | M4 后 Agent 调度图谱，执行期已过 |
| CHANGELOG-PROVIDER.md | M4 交付变更日志 |
| PLAN-SYSTEMATIC-POST-M4.md | M4 后改进方案（46 条目） |
| EXECUTION-PLAYBOOK-POST-M4.md | M4 后执行手册 |
| FINAL-PROVIDER-SYSTEM-REPORT.md | M4 最终交付报告 |
| ROADMAP-PROVIDER-POST-M4.md | M4 后路线图 |
| test-report-M4.md | M4 测试报告（58+1 Rust 测试） |
| provider-compatibility-matrix.md | Provider 兼容矩阵（生成于 2026-07-23） |
| provider-index.json | Provider 清单数据 |

### 3.2 开发指南（4 个，建议移入 guides/）
| 文件 | 判断 |
|---|---|
| error-handling.md | `@crish/shared-types` 错误系统权威指南，引用当前包路径，**仍有效** |
| hooks.md | Lifecycle Hooks 规范，引用当前 runtime，**仍有效** |
| plugin-development.md | `@crish/plugin-sdk` 权威指南，**仍有效** |
| subagent-development.md | `@crish/agent-subagent` 权威指南，**仍有效** |

### 3.3 历史方案（3 个，建议归档）
| 文件 | 判断 |
|---|---|
| comprehensive_problem_analysis.md | 2026-07-24 综合分析（16 Agent + 57 TECH_DEBT），已过时 |
| systematic_solution_plan.md | 与目录 systematic_solution_plan/ 同题，根级副本冗余 |
| startup-optimization-plan.md | 启动优化方案，与 rust-rewrite PE-01（config-startup）重叠 |

### 3.4 索引（README.md）
- 旧版 "Crish Documentation Index"（仍用 Crish 名、未覆盖当前结构）→ **重写**为 docs 索引（指向 architecture/、rust-rewrite/、plans/、organization/）。

---

## 4. 目标结构草案（推荐）

```
docs/
├── README.md                    # 重写索引（替代旧 Crish Documentation Index）
├── organization/                # 文档治理与盘点（保留）
├── architecture/                # 活跃规范真源（保留，12 文件）
├── rust-rewrite/                # 活跃重构真源（保留，48 文件）
├── plans/                       # 活跃计划与进度台账（保留，30 文件）
├── guides/                      # 内部开发/维护指南
│   ├── error-handling.md        # ← 根级移入
│   ├── hooks.md                 # ← 根级移入
│   ├── plugin-development.md    # ← 根级移入
│   ├── subagent-development.md  # ← 根级移入
│   └── testing/                 # ← testing/ 移入（smoke 指南仍有效）
├── opensource/                  # 对外协作面（可选；若开源面独立可移出 docs）
│   └── provider-dx/             # ← provider-dx/ 移入
└── archive/                     # 历史归档（只读）
    ├── provider-m4/             # M4 交付资产：9 个根级 POST-M4 文档 + audit/ + security/ + performance/ + perf/
    ├── campaigns/               # 多 Agent 修复战役（已结束）
    │   ├── benchmark-evolution-plans/  crish_desktop_architectural_remediation_plan/
    │   ├── round_12_audit/      refac/      refactor-guides/
    │   ├── system-completion-plans/      ui-jank-message-dnd-rootfix/
    │   └── v2_plan_review/      systematic_solution_plan/
    ├── redesign/                # 与 rust-rewrite 重叠的并行草案/诊断
    │   ├── rust-architecture-redesign/   system-enhancement-plans/
    │   ├── architecture-improvement/     architecture-review/
    │   ├── analysis/            design/   conversation_flow_plan/
    │   └── startup-optimization-plan.md  comprehensive_problem_analysis.md（根级移入）
    └── prototypes/              # 原型资产（或直接移除仓库）
        ├── loading page/        # 建议删 node_modules 后归档，或移出 docs
        └── new/
```

### 分组理由

1. **活跃真源（architecture / rust-rewrite / plans）原样保留**：三者互相引用（PE 任务书 ↔ 架构契约 ↔ 计划台账），是当前唯一仍在 2026-08 更新的文档面，动它们会破坏工作流。
2. **archive/ 按"批次/战役/草案"分层**：M4 是**交付批次**（一次性、已验收），campaigns 是**执行战役**（多轮多 Agent、有中间产物），redesign 是**方案演进**（与 rust-rewrite 重叠的草稿，留作决策溯源）。三者查询动机不同，分层便于回溯。
3. **guides/ 与 opensource/ 分离**：guides 面向内部开发者（引用 `@crish/*` 包的真源类型），opensource 面向外部贡献者（英文、含 CONTRIBUTING/CATALOG）；当前两者混在根级与 provider-dx/，难以区分受众。
4. **loading page/ 与 new/ 不属于文档**：含 node_modules（19 个依赖文件）的完整 Vite 项目不应存在于 docs/，建议移出仓库或按原型归档，避免 git 体积膨胀。
5. **根级清零**：17 个散落 md 全部归位（M4 系列 → archive、指南 → guides、历史方案 → archive），根级只留 README 索引，降低"根级即孤岛"的检索成本。
6. **编码修复纳入移动计划**：GBK 文件名（architecture-improvement 等）与 UTF-16 错乱内容（UPGRADING.md 等）在移动时统一转为 UTF-8 无 BOM 并改名，减少后续乱码排查。

### 执行建议（后续任务，本次未动）
- 移动仅使用 `git mv`（保留历史）。
- `v2_plan_review/` 的 40 个 round_outputs JSON/txt 中间产物按需清理，仅保留 md 方案与结论。
- 归档目录顶部各加一行 `> 已归档（日期）：内容可能引用已删除代码` 标注。
