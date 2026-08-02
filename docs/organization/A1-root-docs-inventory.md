# A1 根目录 Markdown 文档清单分类报告

> 生成日期：2026-08-02
> 范围：仓库根目录 53 个 .md 文档（只读分析）
> 方法：20 个文档抽样精读（头部 60–100 行 + 尾部 20 行），其余按文件名与全量标记 grep 推断
> 判定基准：
> - commit `967e7846`（2026-08-02）已删除旧 TS 后端包 `packages/agent-runtime|agent-orchestrator|agent-daemon`，由 Rust crates（`crates/*`）接管 → 凡引用这些路径、`sidecar.rs`、`web-ui`、workbench Preact UI、`daemon/WebSocket` 旧命名的文档均视为过时
> - commit `3a6081fd`（2026-08-02）完成 daemon/WS 命名债务清理 → "daemon / WebSocket" 措辞在新代码中已改名
> - 当前真相源：根目录 `README.md`、`ARCHITECTURE.md`（两者本身也待同步到 Rust 架构）与 `docs/rust-rewrite/`

## 一、完整清单表

| # | 文件名 | 大小 | 摘要 | 类型 | 时效 | 建议处置 | 方法 |
|---|--------|------|------|------|------|----------|------|
| 1 | .AGENT-IMPLEMENTATION-RULES.md | 1KB | 多 Agent 轮次执行的实现规则（只读总纲、自包含、轮次纪律） | 规范 | 过时（面向旧 IMPROVEMENT-PLAN-MASTER 执行批次） | 保留根目录或并入 docs/ | 精读 |
| 2 | 0613-0055-plan.md | 19KB | Crish 架构彻底重构方案（@crish/schema / decision-engine / 纯状态机分层） | 方案 | 过时（引用 agent-runtime、web-ui、WS、daemon） | 归档 docs/archive/ | 精读 |
| 3 | 0613-0553.md | 44KB | 前端系统性架构演进方案（设计系统根基、空间语言、组件现代化） | 方案 | 过时（UI 目标栈为旧 workbench/Preact 样式体系） | 归档 docs/archive/ | 精读 |
| 4 | ANTI_OVERENGINEERING_GUARDRAILS.md | 5KB | 反过度设计硬性红线 10 项禁令（沙盒、模型路由、安全等） | 规范 | 基本有效（指向现有 Rust crates 与产品策略，2026-07-30） | 保留根目录 | 精读 |
| 5 | APPROVAL-TOOL-PIPELINE-REFACTOR.md | 29KB | 审批工具管道重构方案 | 方案 | 过时（引用 WebSocket/daemon 旧架构） | 归档 docs/archive/ | 推断 |
| 6 | ARCHITECTURE-IMPROVEMENT.md | 18KB | 架构改进方案（daemon/orchestrator/runtime 层重组） | 方案 | 过时（引用已删 TS 后端包与 Preact） | 归档 docs/archive/ | 推断 |
| 7 | ARCHITECTURE.md | 5KB | 产品架构真相文档（进程拓扑、包边界、控制面） | 架构 | 过时（2026-07-31 版仍描述已删 TS 包；需同步 Rust crates 真相） | 保留根目录但必须更新 | 精读 |
| 8 | CHANGELOG.md | 1KB | 变更日志（0.1.0 单条，列出已删 TS 包） | 开源文档 | 过时（列表含已删包） | 保留根目录，内容待更新 | 精读 |
| 9 | CODE_OF_CONDUCT.md | 3KB | Contributor Covenant 行为准则 | 开源文档 | 有效 | 保留根目录 | 精读 |
| 10 | compaction_summary_output.md | 2KB | 上下文压缩摘要的运行产物样例（Token 阈值模拟输出） | 其他 | 一次性运行产物 | 删除候选（或归档 docs/archive/） | 精读 |
| 11 | COMPREHENSIVE-REFACTOR-PLAN.md | 44KB | 综合重构方案（TS 后端全套重组） | 方案 | 过时 | 归档 docs/archive/ | 推断 |
| 12 | COMPUTATION-LAYER-DESIGN.md | 18KB | 计算层设计（agent-runtime 内部分层） | 架构 | 过时 | 归档 docs/archive/ | 推断 |
| 13 | CONTRIBUTING-PROVIDERS.md | 14KB | Provider 贡献指南（JSON Schema、认证、测试） | 开源文档 | 部分过时；与 docs/provider-dx/CONTRIBUTING-PROVIDERS.md 重复 | 合并到 docs/provider-dx/ 后删根目录副本 | 精读 |
| 14 | CONTRIBUTING.md | 2KB | 项目贡献指南（monorepo 结构、开发流程） | 开源文档 | 过时（结构列表含已删 TS 包） | 保留根目录，内容待更新 | 精读 |
| 15 | conversation_flow_design.md | 41KB | 对话流界面系统设计（组件拓扑、时间线管线、双 store 方案） | 架构 | 基本有效（指向现行 crish-desktop，仅 WS 措辞过时）；与 docs/conversation_flow_plan/conversation_flow_design.md 近重复 | 合并到 docs/ 下对应目录，根目录留指针或删除 | 精读 |
| 16 | CORE-ARCHITECTURE-IMPROVEMENT.md | 24KB | 核心架构改进方案 | 方案 | 过时（引用 Preact/sidecar/daemon） | 归档 docs/archive/ | 推断 |
| 17 | CRISH_UI_SYSTEMIC_OVERHAUL_MASTER_PLAN.md | 32KB | UI 系统性整改总方案（503 条审计问题拆解主计划） | 方案 | 过时（面向旧前端体系，与 TOKEN/EVENT 系列同批） | 归档 docs/archive/（保留为同批子方案主索引） | 推断 |
| 18 | DEVELOPMENT_LOG.md | 160KB | 产品需求与实现进度长程日志（2026-06 起） | 开发日志 | 历史记录（大量引用已删 TS 包，价值在需求溯源） | 归档 docs/archive/（或迁 docs/logs/） | 精读 |
| 19 | EVENT-SYSTEM-ARCHITECTURE.md | 46KB | 统一事件系统与组件间通信架构（503 审计中的通信断裂修复） | 架构 | 过时（事件路由面向 daemon/WS 旧架构） | 归档 docs/archive/ | 精读 |
| 20 | FINAL-COMPREHENSIVE-REFACTOR-PLAN.md | 36KB | "最终"综合重构方案（07-23 批次，与 11/39 号重叠） | 方案 | 过时 | 归档 docs/archive/ | 推断 |
| 21 | FINAL-REFACTORING-ROADMAP.md | 23KB | 重构最终路线图 | 路线图 | 过时（agent-runtime 目标已由 Rust 重写取代） | 归档 docs/archive/ | 推断 |
| 22 | FRONTEND-DESIGN-PLAN.md | 97KB | 前端设计系统改进方案（token/排版/组件详表） | 方案 | 过时（文件顶部已自带【已废弃/非产品真相】标记） | 归档 docs/archive/ | 精读 |
| 23 | FULL_CHECK_COMMANDS.md | 4KB | 全量门禁与质量检查命令集（10 大关卡） | 规范 | 过时（`check:core` 等脚本指向已删 TS 包；Rust 侧门禁见 docs/rust-rewrite/） | 归档 docs/archive/ 或按新栈重写 | 精读 |
| 24 | HARDCODED-TOKEN-AUDIT.md | 5KB | 硬编码 Token 体系审计报告（92 CSS / 65 TSX） | 审计分析 | 过时（旧前端样式体系） | 归档 docs/archive/（随同批 UI 方案） | 精读 |
| 25 | IMPROVEMENT-PLAN-MASTER.md | 31KB | 改进总方案（多 Agent 批次总纲） | 方案 | 过时 | 归档 docs/archive/ | 推断 |
| 26 | IMPROVEMENT-PLAN.md | 16KB | 改进方案（早期版） | 方案 | 过时 | 归档 docs/archive/ | 推断 |
| 27 | multi_agent_execution_guide.md | 44KB | 性能重构多 Agent 多轮执行总提示词（Round 1-4 分工） | 执行记录 | 部分过时（crates/conex-db 等仍存在，但引用已删 packages/agent-runtime） | 归档 docs/archive/ | 精读 |
| 28 | multi_agent_round10_chat_bundle_plan.md | 16KB | Round 10 chat bundle 执行方案 | 执行记录 | 过时 | 归档 docs/archive/ | 推断 |
| 29 | multi_agent_round7_9_guide.md | 8KB | Round 7-9 执行指南 | 执行记录 | 过时（引用 agent-daemon） | 归档 docs/archive/ | 推断 |
| 30 | multi_agent_session_lifecycle_guide.md | 4KB | 会话生命周期执行指南 | 执行记录 | 过时（引用 daemon） | 归档 docs/archive/ | 推断 |
| 31 | multi_agent_session_lifecycle_phase2_guide.md | 7KB | 会话生命周期 Phase2 指南 | 执行记录 | 过时（引用 daemon） | 归档 docs/archive/ | 推断 |
| 32 | new.md | 175KB | 系统化完善方案（深度思考全文，shared-types/运行时/编排全层方案） | 方案 | 过时（引用 agent-runtime/daemon/web-ui，2026-06-15） | 归档 docs/archive/（历史决策参考） | 精读 |
| 33 | PANEL-SYSTEM-REFACTOR-PLAN.md | 14KB | 面板系统重构方案 | 方案 | 过时 | 归档 docs/archive/ | 推断 |
| 34 | PERFORMANCE-AND-ARCHITECTURE-FULL-OPTIMIZATION-PLAN.md | 32KB | 性能与架构全面优化方案 | 方案 | 过时（引用已删 TS 包） | 归档 docs/archive/ | 推断 |
| 35 | PERFORMANCE-AND-UI-SYSTEMIC-OVERHAUL-PLAN.md | 26KB | 性能与 UI 系统性整改方案 | 方案 | 过时（引用 daemon） | 归档 docs/archive/ | 推断 |
| 36 | PRETEXT-INTEGRATION-ANALYSIS.md | 3KB | Pretext 文本测量库集成分析（5 个场景可行性） | 审计分析 | 过时（结论未落地，库未引入） | 归档 docs/archive/ | 精读 |
| 37 | R4-MULTI-AGENT-EXECUTION-PLAN.md | 27KB | Round 4 多 Agent 执行方案 | 执行记录 | 过时（引用已删 TS 包） | 归档 docs/archive/ | 推断 |
| 38 | README.md | 2KB | 产品路径唯一真相说明（UI/壳/引擎路径、开发命令） | 开源文档 | 过时（产品路径表仍列已删 TS 包；需同步 Rust 真相） | 保留根目录但必须更新 | 精读 |
| 39 | REFACTOR-PLAN.md | 29KB | 重构方案（TS 栈全量重构，与 11/20 号重叠） | 方案 | 过时 | 归档 docs/archive/ | 推断 |
| 40 | ROADMAP.md | 3KB | 项目架构与路线图（8 层架构） | 路线图 | 过时（顶部已自带【已废弃/非产品真相】标记） | 归档 docs/archive/ | 精读 |
| 41 | runtime_telemetry_report.md | 2KB | 运行时遥测与验证报告（Token/工具调用统计快照） | 审计分析 | 一次性运行产物（2026-07-22） | 删除候选（或归档） | 精读 |
| 42 | SECURE-ARCHITECTURE.md | 24KB | 安全架构方案 | 方案 | 过时（引用 sidecar/WS/daemon 旧架构） | 归档 docs/archive/（安全基线见 docs/rust-rewrite/31-security-baseline.md） | 推断 |
| 43 | SECURITY.md | 1KB | 安全漏洞报告政策 | 开源文档 | 有效 | 保留根目录 | 精读 |
| 44 | suggestions-v2.md | 40KB | 系统化完善方案 v2（29 项清单：A 类遗留 + B 类新增） | 方案 | 过时（引用 agent-runtime/daemon/web-ui/sidecar） | 归档 docs/archive/ | 精读 |
| 45 | suggestions.md | 108KB | L1-L4 阶段完成度审查 + 系统化完善方案（阶段七结论） | 方案 | 过时（引用已删 TS 包全部路径） | 归档 docs/archive/ | 精读 |
| 46 | SYSTEMATIC-OPTIMIZATION-MASTER-PLAN.md | 29KB | 系统化优化总方案 | 方案 | 过时（引用 agent-runtime） | 归档 docs/archive/ | 推断 |
| 47 | SYSTEMIC-CACHE-REUSE-AND-PERFORMANCE-OPTIMIZATION-PLAN.md | 30KB | 缓存复用与性能优化方案 | 方案 | 过时（引用已删 TS 包） | 归档 docs/archive/ | 推断 |
| 48 | TECH_DEBT.md | 11KB | 技术债登记册（63 项，TD-001~TD-063，按严重性分级） | 审计分析 | 部分过时（大量条目指向已删 TS 包路径，2026-07-31 仍维护） | 保留根目录，按 Rust 栈重审条目 | 精读 |
| 49 | TOKEN-SYSTEM-REFACTOR-PLAN.md | 18KB | Token 体系系统性重构方案（三层 Token 体系） | 方案 | 过时（旧前端体系） | 归档 docs/archive/ | 精读 |
| 50 | TOKEN-SYSTEM-REFACTOR-PROMPT.md | 11KB | Token 重构执行提示词（多 Agent 用） | 方案 | 过时 | 归档 docs/archive/ | 推断 |
| 51 | UI-FLOW-AUDIT-COMPLETE.md | 55KB | UI 流程审计报告（完整版） | 审计分析 | 过时（引用 web-ui/WS/daemon） | 归档 docs/archive/ | 推断 |
| 52 | UI-INTERACTION-AUDIT.md | 35KB | UI 交互审计报告 | 审计分析 | 过时（引用 sidecar/daemon） | 归档 docs/archive/ | 推断 |
| 53 | VERIFICATION_CHECKLIST.md | 4KB | 5 层递进检查指南（tsc/cargo/vite/dev/vitest） | 规范 | 过时（引用已删 check:daemon/runtime/orchestrator；Rust 侧自有核对矩阵） | 归档 docs/archive/，职责并入 rust-rewrite 验证文档 | 精读 |

## 二、类型统计

| 类型 | 数量 | 占比 |
|------|------|------|
| 方案 | 23 | 43% |
| 审计分析 | 6 | 11% |
| 执行记录 | 6 | 11% |
| 开源文档 | 6 | 11% |
| 架构 | 4 | 8% |
| 规范 | 4 | 8% |
| 路线图 | 2 | 4% |
| 开发日志 | 1 | 2% |
| 其他 | 1 | 2% |
| 合计 | 53 | 100% |

## 三、时效统计

| 时效 | 数量 | 说明 |
|------|------|------|
| 过时（引用已删 TS 后端包 / daemon / WS / Preact / web-ui / sidecar） | 40 | 直接受 2026-08-02 Rust 重写收尾影响 |
| 部分过时（主体仍有效） | 4 | TECH_DEBT、multi_agent_execution_guide、conversation_flow_design、CONTRIBUTING-PROVIDERS |
| 有效（现行） | 5 | SECURITY、CODE_OF_CONDUCT、ANTI_OVERENGINEERING_GUARDRAILS、compaction_summary_output（运行产物）、runtime_telemetry_report（运行产物） |
| 需更新而非废弃 | 4 | README、ARCHITECTURE、CHANGELOG、CONTRIBUTING（根目录门面文档） |

## 四、处置建议汇总

1. **归档 docs/archive/（约 38 个）**：全部方案/审计/执行记录/路线图类文档。理由：所描述的技术栈已被 Rust crates 取代，且其中多份互相重叠（07-23 多 Agent 批次的 master/final/plan 三连）。建议按批次子目录归档：`docs/archive/2026-06-refactor/`（new、suggestions、suggestions-v2、0613-0055-plan、0613-0553）、`docs/archive/2026-07-ui-overhaul/`（FRONTEND-DESIGN-PLAN、EVENT-SYSTEM-ARCHITECTURE、UI-FLOW-AUDIT-COMPLETE、UI-INTERACTION-AUDIT、HARDCODED-TOKEN-AUDIT、TOKEN-SYSTEM-REFACTOR-*、CRISH_UI_SYSTEMIC_OVERHAUL_MASTER_PLAN、PANEL-SYSTEM-REFACTOR-PLAN、PERFORMANCE-AND-UI-SYSTEMIC-OVERHAUL-PLAN、0613-0553）、`docs/archive/2026-07-multi-agent/`（multi_agent_* 全部 + R4-MULTI-AGENT-EXECUTION-PLAN + .AGENT-IMPLEMENTATION-RULES）、`docs/archive/2026-07-refactor/`（*REFACTOR-PLAN、FINAL-*、COMPREHENSIVE-*、APPROVAL-TOOL-PIPELINE-REFACTOR、ARCHITECTURE-IMPROVEMENT、CORE-ARCHITECTURE-IMPROVEMENT、COMPUTATION-LAYER-DESIGN、SECURE-ARCHITECTURE、IMPROVEMENT-PLAN*、SYSTEMATIC-*、SYSTEMIC-*、FULL_CHECK_COMMANDS、VERIFICATION_CHECKLIST、PRETEXT-INTEGRATION-ANALYSIS、ROADMAP、FINAL-REFACTORING-ROADMAP、DEVELOPMENT_LOG）。
2. **保留根目录（4 个，需更新）**：README.md、ARCHITECTURE.md、CONTRIBUTING.md、CHANGELOG.md —— 产品路径与包列表需同步为 Rust crates + 现存 packages（agent-provider-http、decision-engine、plugin-sdk、shared-* 等）。
3. **保留根目录（3 个，基本不需动）**：SECURITY.md、CODE_OF_CONDUCT.md、ANTI_OVERENGINEERING_GUARDRAILS.md。
4. **保留但按新栈重审（1 个）**：TECH_DEBT.md —— 与 rust-rewrite 审计（AU-01~04）合并维护。
5. **删除候选（2 个）**：compaction_summary_output.md、runtime_telemetry_report.md —— 一次性运行产物，无长期价值。
6. **合并去重（3 组）**：
   - `CONTRIBUTING-PROVIDERS.md`（根）→ 合并入 `docs/provider-dx/CONTRIBUTING-PROVIDERS.md`；
   - `conversation_flow_design.md`（根）→ 与 `docs/conversation_flow_plan/conversation_flow_design.md` 内容核对后保留 docs 版；
   - `VERIFICATION_CHECKLIST.md`（根）→ 与 `docs/rust-rewrite/30-verification-checklist.md` 职责重叠，根目录版失效，删除或归档。

## 五、特别标记

1. **与 docs/rust-rewrite/ 职责重叠的旧文档**：
   - 根 `VERIFICATION_CHECKLIST.md` ↔ `docs/rust-rewrite/30-verification-checklist.md`（同名主题；根版为旧 TS 栈检查指南，已失效）
   - 根 `SECURE-ARCHITECTURE.md` ↔ `docs/rust-rewrite/31-security-baseline.md`（安全基线职责重叠）
   - 根 `FULL_CHECK_COMMANDS.md` ↔ rust-rewrite 验证命令集（01~11、PE-09-regression-report）
2. **自带废弃标记的文档（直接归档，无需讨论）**：FRONTEND-DESIGN-PLAN.md、ROADMAP.md（顶部均有【已废弃 / 非产品真相】横幅）。
3. **多份同批重复方案（07-23 批次）**：REFACTOR-PLAN.md / COMPREHENSIVE-REFACTOR-PLAN.md / FINAL-COMPREHENSIVE-REFACTOR-PLAN.md / FINAL-REFACTORING-ROADMAP.md / IMPROVEMENT-PLAN.md / IMPROVEMENT-PLAN-MASTER.md 内容高度重叠，归档时仅保留一份作为代表即可。
4. **文档与现状矛盾的边界情形**：README.md 与 ARCHITECTURE.md 自称"产品真相"，但产品路径表仍列 2026-08-02 已删除的 packages/agent-daemon 等包；git 提交 `967e7846` 为删除依据。二者必须在同步 Rust 架构后继续担任门面真相文档。
