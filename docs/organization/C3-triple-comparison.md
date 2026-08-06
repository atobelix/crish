# C3 — 三方对比：conex/crish vs opencode vs grok-build

> 评审产出（只读，未修改任何项目代码）
> 日期：2026-08-03
> 输入：C1（opencode 调研）、C2（grok-build 调研）未就绪时以**项目自身证据**复核；本报告全部数据为本次实测（行数/文件数/测试数均为本机统计），结论可复核。
> 方法：定位差异优先——三者为三种定位（桌面工作台 / CLI 编程工具 / 终端 shell），按"各自定位下的完成度"对比，不直接比功能数量。

---

## 一、定位对比表

| 维度 | conex/crish | opencode | grok-build |
|---|---|---|---|
| 定位 | **桌面 AI 工作台**（GUI/Tauri/React），多会话、工具审批、MCP、markdown 流式渲染；规划 Web/TUI 三端 | **开源 CLI AI 编程工具**（终端 TUI + Web + Desktop BETA），主打代码库理解与编辑 | **终端 AI 编程代理**（full-screen TUI + headless/CI + 编辑器内嵌 via ACP） |
| 核心形态 | Tauri 进程内 Rust 引擎 + React 前端（`apps/agent-workbench/src-tauri` + `apps/crish-desktop`） | TS monorepo：core 引擎 + 客户端 SDK + TUI/Web/Desktop 多壳 | Rust workspace 77 crates：pager（TUI）+ shell（agent runtime + leader/stdio/headless 入口） |
| 规模实测 | Rust 195 文件 / 74,106 行（crates）+ 51 文件 / 16,482 行（Tauri 壳）；TS src 864 文件 / 177,423 行（含 271 个测试文件）；git 341 commits | 32 packages；3,056 个 TS/TSX 文件 / 539,171 行；699 个测试文件 | 77 crates；2,375 个 rs 文件 / 1,377,016 行；22,828 个 `#[test]` |
| 用户场景 | 桌面会话式工作台（会话列表/审批流/流式渲染/状态诊断） | 终端内跑代码任务：`build`/`plan` 双 agent（README.md:100-112），Tab 切换 | 终端内长任务代理：plan mode、goal 编排、subagent、worktrees、后台任务（user-guide/20-background-tasks.md） |
| 生态姿态 | 自研单产品（无发布渠道、无社区入口） | 开源社区产品（npm/brew/scoop/choco/nix 多渠道，README.md:46-62） | 公司产品源码透明（README.md:31-35：定期从 SpaceXAI monorepo 同步，`SOURCE_REV` 记录 SHA） |
| 完成度判断 | 内核完成度高、产品外壳未完成 | 成熟产品（下载量自追踪，STATS.md） | 成熟公司产品（内部开发） |

**结论**：三者不是同台竞争关系。conex 的"水平线"应对比的是**桌面 AI 工作台定位**（如 cherry-studio / cline 的桌面形态 / opencode Desktop BETA），opencode 与 grok-build 是它**引擎契约面的对标物**（会话状态机、事件、持久化、契约管理），而非前端形态的对标物。

---

## 二、架构成熟度对比（四维证据）

### 2.1 状态机 / 会话语义

| 维度 | conex | opencode | grok-build |
|---|---|---|---|
| 状态机 | 显式穷举转移表：`crates/conex-types/src/transition.rs` 的 `apply_transition`（01 文档 §1.4 全表逐行穷举），`crates/session-loop/src/state.rs:57-61` dispatch「先查表后变更」，未定义转移返回显式 `TransitionError`；终态 done 守卫（state.rs:48-51） | V2 无显式状态机枚举，以**事件溯源 + 投影**表达：SessionV2.prompt 先落 durable `session_input` 行再调度 `SessionExecution.wake`（AGENTS.md "V2 Session Core"）；projector 投影（packages/core/src/session/projector.ts） | session actor：`xai-grok-shell/src/session/acp_session.rs`（SessionCommand: prompt/cancel/shutdown + 通道路由）；impl 内 run_loop.rs / turn.rs / turn_end.rs / stop_gate.rs 组成轮次管线 |
| 轮次控制 | 9 个 handler 分域：prepare_turn/streaming/steering_evaluation/executing_tools/awaiting_input/turn_complete/no_tool_calls/stream_error/end（session-loop/src/loop/handlers/） | SessionRunner（session/runner/）+ SessionRunCoordinator 合并同会话 resume、coalesce prompt wakeups（AGENTS.md） | turn.rs + turn_end.rs + stop_gate.rs（MAX_STOP_HOOK_CONTINUATIONS_PER_TURN=8，stop_gate.rs:8）+ tasks_cancel.rs |
| 并发语义 | 会话级原子序列号 `SessionSequencer`（orchestrator/src/persist.rs:200，Q23/T08.12）；压力测试 10 run × 51 事件全序（orchestrator/tests/stress_concurrent_runs.rs:54） | EventSequenceTable + aggregateID/seq 事件溯源（core/src/event.ts:27-38）；并发 run 由 run-coordinator 合并 | actor + mpsc/oneshot 通道（acp_session.rs 头注释）；进程内 leader 语义，无显式跨会话序列化文档 |
| 恢复 | 崩溃恢复 + seed 预热（restore.rs:1244-1273）+ 写失败 latch 注入测试（persist.rs:232-240） | 崩溃后恢复需独立设计（AGENTS.md：post-crash continuation recovery 未实现） | session_setup.rs / restore_code.rs / rewind 机制 |

**结论**：conex 的状态机是三者中唯一"表驱动穷举 + 不变式文件"（loop/invariants.rs）的显式方案，可证明性强；opencode 走事件溯源投影（现代但依赖 Effect 纪律）；grok-build 走 actor 管线（扩展面大，靠测试兜底）。conex 在**状态机可验证性**上领先，在**并发宽度**（同会话多 run 已处理，多机/多进程未做）上与其他二者同属单机。

### 2.2 事件系统

| 维度 | conex | opencode | grok-build |
|---|---|---|---|
| 事件模型 | 28 事件 + 信封（type/runId/sequence/schemaVersion），`docs/rust-rewrite/33-event-schema-changelog.md`（v1 冻结 24 + cache-\* 3 + security-audit 1） | EventV2 durable 注册表：`Durable.get(type)` 校验 + Schema 解码 + 版本（core/src/event.ts:49-60）；public-event-manifest.ts | replay_events.rs（SessionEvent/SessionNotification）+ extensions/notification.rs（SessionUpdate/RetryState） |
| 版本化 | **信封 schemaVersion + changelog 硬约束**：新增事件须 changelog 登记 + `V1_EVENT_TYPES` 清单 + fixture 四者一一对应（33-changelog 变更门禁）；旧帧缺省视为 v1 向后兼容 | schema-changelog.md（specs/v2/）+ durable event manifest 内嵌版本字段 | 无显式版本化文档（内部同步，无外部契约承诺） |
| 测试锚定 | golden fixtures：`crates/conex-types/tests/fixtures/events-v1/`（24+1 帧）；16 项壳侧硬依赖（event_bridge_contract.rs）；28 变体 roundtrip 穷举 | 无 fixture 快照体系；以 Schema 类型编译期保证 | 无 |
| 前端消费 | 前端按字段白名单消费、未知键静默忽略（33-changelog） | 客户端 SDK 代码生成（packages/client，`bun run generate`） | TUI 直接订阅 session_notification 通道 |

**结论**：事件版本化与兼容门禁是 conex 相对二者**显著领先**的领域——opencode 有 schema 级版本但无 fixture/门禁链，grok-build 无对外版本承诺。

### 2.3 错误体系

| 维度 | conex | opencode | grok-build |
|---|---|---|---|
| 结构 | CrishError 77 码 / 20 域 + 注册表（`crates/conex-types/src/error.rs:50-167` codes 模块，:169 registry）；category（transient/permanent/security/protocol）+ retryable + cause 链深限 8 | Effect Cause + Schema.TaggedErrorClass（event.ts:44-48），类型化但无统一码表 | 每 crate 独立 error.rs（auth/error.rs、conversation/error.rs 等），无统一码表 |
| IPC 协议 | CoreError {kind, detail} 统一 + 码与 77 码对齐（23 方案 E3.3，23-architecture-hardening-plan.md:99） | httpapi-codegen + Schema 解码错误类型 | ACP 协议错误映射（sampling::error::map_sampling_err_to_acp） |
| 消费纪律 | RecoveryHook::decide 基于码分类裁决而非文本匹配（契约矩阵 F6） | Effect 代数效应天然类型化 | 重试分级（auth_error_no_retry_tests.rs 等） |

**结论**：conex 是三者中唯一有**全链路统一错误码注册表**的项目；opencode 靠类型系统纪律，grok-build 靠 crate 内自治。conex 的码表对跨端（Rust↔TS）契约意义重大，这也是它 77 码/20 域设计（error.rs:50 注释"enum 不可维护"）的初衷。

### 2.4 数据持久化 / 契约管理

| 维度 | conex | opencode | grok-build |
|---|---|---|---|
| 存储 | conex-db（SQLite，v4 迁移 + v5 usage_json 迁移，R6 wave2）+ 孤儿宽限期 5 分钟 + 级联删除防护（30 方案 PE-08） | Drizzle ORM + SQLite durable 事件表（event.ts）+ session_input 行 + todo 事务（todo.ts） | xai-sqlite-journal + chat_persistence.rs + compaction_segments.rs + search_fts.rs；快照/checkpoints（workspace） |
| 契约管理 | **F1-F12 接口冻结表 + 契约测试矩阵**（contracts/contract-test-coverage-matrix.md：每冻结项 = 测试文件 + 断言要点 + 状态；含 4 条生产偏差记录与修复归属）；命令终态名注册（config_command_names_contract.rs 8 条终态名 + 旧名禁登） | specs/v2/ 文档化（session.md/todo.md/tools.md/config.md）+ 客户端生成代码（生成代码禁手改，AGENTS.md） | schema_contract.rs（workspace）+ ACP 协议文档；无跨 crate 冻结矩阵 |
| 并发一致性 | 同会话 sequence 唯一连续（stress 测试）+ 崩溃一致性测试（crash_consistency.rs） | EventV2 事件溯源保证 seq 单调 | 内部 actor 语义 |

**结论**：conex 的**冻结表→任务书→测试矩阵三层勾稽**（AU-04 → PE-01..12 → contract-test-coverage-matrix）在三个项目中独有，且矩阵内主动记录生产偏差（F2/F9 未落地字段）而非掩盖。这是工程治理深度上的明确领先点。

---

## 三、工程质量对比

| 维度 | conex | opencode | grok-build |
|---|---|---|---|
| 测试规模 | Rust 1,671 个 `#[test]`；75 个套件全绿（任务口径；AGENTS.md 基线 73；E1 轮后从 61 增长，30 方案 :130）；前端 271 测试文件 | 699 个测试文件（TS）；unit 矩阵 linux+windows 双平台（test.yml） | 22,828 个 `#[test]`（约 conex 的 14 倍，但代码量为 15 倍，密度相当） |
| 测试密度 | 测试文件 / 源码文件 = 271/864 ≈ **31%**（前端）；Rust 1,671 test / 74k 行 | 699/3056 ≈ 23% | 22,828 / 1.38M 行 ≈ 16.5 test/千行（≈ conex 22.5/千行 的 73%） |
| 契约/压力测试 | 契约矩阵 + 并发压力 + 崩溃一致性 + 流式锚点（无 `#[ignore]` 门禁） | 单元 + 集成（packages/core/integration）；无契约快照矩阵 | 大规模 e2e（persistence_tests / turn_end_guard_tests / plan_mode 系列） |
| 类型纪律 | TS strict + typecheck（npm run typecheck = 7 个 tsc 直跑，ci.yml 注释 G7）；Rust clippy 零 unsafe/style（commit 7f8bb639） | Effect Schema 全链解码 + AGENTS.md 风格规范（禁 any、禁别名导入、禁 else）+ bun typecheck | clippy.toml + rustfmt.toml + `#![allow(clippy::...)]` 局部豁免（acp_session.rs:1-2 有 2 处 allow） |
| CI 设施 | 4 个 workflow（ci 快层 / ci-mid 中层 / ci-slow 慢层 / perf-test）：typecheck + lint + eslint + depcruise + npm audit + cargo-deny + secret-scan + `--locked` | 35 个 workflow（test/typecheck/publish/release/storybook/stats/docs-locale-sync/issue 机器人/pr-standards 等） | 无 .github（内部 CI，源码树不可见） |
| 门禁细节 | 快/中/慢三层分层（PR 即时 ≤5min → 全量 → 压测/e2e） | 单 test.yml 多矩阵 + 单独 typecheck.yml | 未知（内部） |

**结论**：conex 的单测密度与契约门禁纪律高于 opencode 且显著高于 grok-build 平均密度；CI 分层设计合理但**自动化面窄**（4 vs 35 个 workflow）——缺发布、可视化、社区运维类流水线。

---

## 四、文档与治理对比

| 维度 | conex | opencode | grok-build |
|---|---|---|---|
| 文档规模 | `docs/` 405 个 md；rust-rewrite 体系 00-34 全序号（主方案/语义/审计/计划/冻结/基线/changelog/收尾清单） | 线上 docs（opencode.ai/docs）+ 仓库 specs/（v2 六篇 + storage 两篇 + project.md/tui-package.md）+ AGENTS.md 编码规则 | 仓库内 user-guide 24 章 + tutorial 9 章 + hooks-and-plugins（40 个 md）+ 线上 docs.x.ai/build |
| 文档性质 | **过程治理文档**：审计（AA-01..08）→ 计划（PE-01..12）→ 冻结（AU-04）→ 验证（矩阵/checklist）闭环；每轮 Agent 产出落盘 | 产品/协议文档：specs + 生成代码 + 下载统计（STATS.md） | 用户手册 + 开发者说明（README/CONTRIBUTING/clippy 配置） |
| 维护机制 | 副文档状态表登记（00 §4）+ 轮次闭环（计划→执行→验证→补全）；31-security-baseline 十基线 + 豁免流程 | AGENTS.md 约束编码/提交规范 + 分支命名；docs-locale-sync workflow 同步翻译 | SOURCE_REV 追踪同步源；根 Cargo.toml 生成只读 |
| 安全基线 | **31-security-baseline.md**：十面判定表 + 十条基线 + 反例 + 验收测试要求 + 豁免登记流程（独有） | SECURITY.md + .gitleaksignore + compliance-close workflow | SECURITY.md（17 行）+ 内部评审 |
| 中文 | 全中文注释/文档（编码护栏 skill 维护） | README 26 语言（含 zh），代码注释英文 | 仅英文 |

**结论**：conex 的文档体系在**开发过程可追溯性**（审计→计划→冻结→验证勾稽）上远超二者，这是多 Agent 协同开发的独特资产；opencode 的文档强在**对外产品文档与贡献者规范**；grok-build 强在**用户手册完备度**（24 章 user-guide）。conex 缺的是后两者的对外面。

---

## 五、开源成熟度对比

| 维度 | conex | opencode | grok-build |
|---|---|---|---|
| 贡献入口 | 无 CONTRIBUTING / LICENSE / 社区渠道（docs/opensource 有 A3 规划，未落地） | CONTRIBUTING.md（设计评审门禁 + issue label 体系）+ CODEOWNERS + TEAM_MEMBERS + PR 模板 + issue 模板 | CONTRIBUTING.md 明示**不接受外部 PR**（源码透明，Apache-2.0） |
| 发布流程 | 无 release/publish workflow；updater 显式禁用（T10.10）；bundle 体积已优化（T10.7：App chunk -42.5%） | publish.yml + publish-vscode.yml + release-github-action.yml + install 脚本 + 多渠道安装（brew/scoop/choco/aur/nix） | 官方安装脚本（install.sh/install.ps1）+ 预编译二进制三平台 + 线上 changelog |
| 国际化 | 无（单中文） | README 26 语言 + docs-locale-sync 自动化 | 无（单英文） |
| 社区资产 | 无 issue/PR/下载统计 | STATS.md 下载量自追踪（2025-08-04 累计 ~29 万）；Discord/npm badge（README.md:12-14） | 无（公司产品） |
| 合规资产 | 无 LICENSE 文件（仓库根未见） | LICENSE + SECURITY.md | Apache-2.0 LICENSE + THIRD-PARTY-NOTICES 781KB + SECURITY.md + .gitleaksignore |

**结论**：开源成熟度排序 opencode > grok-build（透明度式开源）> conex（未开源）。conex 的 docs/opensource 目录已有 A3 规划（`docs/organization/A3-opensource-docs-plan.md`），说明方向明确、执行未开始。

---

## 六、差距分析

### 6.1 conex 领先的地方（做得好的）

1. **契约管理工程化**：F1-F12 冻结表 + 契约测试矩阵 + 偏差记录，三项目独有（contracts/contract-test-coverage-matrix.md）。
2. **事件 schema 版本化门禁**：信封 schemaVersion + changelog + fixture 四者勾稽（33-event-schema-changelog.md），opencode/grok 均无此链。
3. **状态机可证明性**：表驱动穷举 + 不变式 + 显式 TransitionError（session-loop/src/state.rs、loop/invariants.rs）。
4. **统一错误码体系**：77 码 / 20 域注册表，跨 Rust↔TS 契约（conex-types/src/error.rs:50）。
5. **过程文档治理**：405 篇 md、审计→计划→冻结→验证闭环、安全基线十条 + 豁免流程（docs/rust-rewrite/31）。
6. **测试密度与门禁纪律**：前端测试文件占比 31%、流式契约锚点禁 `#[ignore]`、CI 快/中/慢三层。
7. **并发一致性实证**：SessionSequencer + 10-run 压力测试 + 崩溃恢复测试（orchestrator/tests/）。

### 6.2 conex 落后/缺失的地方（按优先级排序）

| 优先级 | 差距 | 现状证据 | 建议方向 |
|---|---|---|---|
| P0 | **发布/打包** | 无 release/publish workflow、updater 禁用（T10.10）、无安装渠道；有 bundle 优化成果（T10.7）无产物管线 | 建立 release 流水线（tauri bundle + 自动更新签名 + changelog 生成） |
| P0 | **开源门面** | 根无 LICENSE/CONTRIBUTING/CODEOWNERS；docs/opensource A3 规划未落地 | 补 LICENSE、SECURITY.md、CONTRIBUTING、issue/PR 模板（照 opencode 模式） |
| P1 | **国际化** | 单中文；opencode README 26 语言 + locale-sync | 若开源则补英文 README/UI i18n 基建（至少 docs 双语文档） |
| P1 | **CI 自动化宽度** | 4 vs 35 个 workflow；无 publish/storybook/PR 机器人/issue 自动分类 | 按开源节奏补齐，或至少加发布 + 依赖更新机器人 |
| P2 | **插件/生态** | 只有 plugin 域 3 个错误码（error.rs）；无插件市场；grok-build 有 plugin-marketplace + hooks 体系（user-guide/09-plugins.md），opencode 有 plugin package | 定义插件契约（钩子面），作为开源后生态入口 |
| P2 | **多端落地** | 引擎契约面已冻结（23 方案 E7），TUI/Web 仅规划 | TUI 是复用契约面的首个验证端（E7.3 模拟 TUI 客户端已规划） |
| P2 | **用户文档** | 无 user-guide/快速上手类文档；grok-build 24 章手册可参照 | 待产品化阶段补，与 P0 发布配套 |
| P3 | **下载/用量追踪** | STATS.md 类资产缺失（opencode 有） | 发布后接入 |

### 6.3 定位下"水平线"判断

- **conex（桌面 AI 工作台定位）**：**工程上已到产品级**（状态机/契约/持久化/安全基线的成熟度超过多数开源工作台），**产品外壳上处于原型到早期产品之间**（无发布、无安装、无 i18n、无社区）。综合判断：**"产品级内核 + 原型级外壳"**——即"可运行的工程样品"，距"可交付给用户的产品"差发布管线与文档面（P0 项）。
- **opencode（CLI 编程工具定位）**：成熟产品（社区 + 多渠道发布 + 26 语言 + 下载追踪 + 35 CI）。
- **grok-build（终端代理定位）**：成熟公司产品（特性面最广、测试体量最大、文档完备），但非开源协作模式。

---

## 七、总评

三个项目不在同一竞争面：opencode 与 grok-build 是 conex 引擎契约面的对标物，conex 在**状态机可验证性、事件版本化、契约冻结矩阵、统一错误码、过程文档治理**五个维度上实际领先；落后面全部集中在**产品化与开源化**（发布、国际化、社区、CI 宽度），且这些落后面已经有明确规划（A3、E7 三端、T10.7 bundle 优化）但未执行。

**建议的下一步优先序**：P0 发布管线 → P0 开源门面（LICENSE/贡献指南）→ P1 英文文档/README → P2 TUI 落地验证契约面 → P2 插件契约。完成 P0+P1 后，conex 在"桌面 AI 工作台"定位下可升格为"早期产品"，届时与 cherry-studio/cline 桌面形态具备可比性。

---

### 附：证据引用清单（本次实测）

- conex：`crates/conex-types/src/error.rs:50`（77 码/20 域）、`crates/session-loop/src/state.rs:57`、`crates/orchestrator/src/persist.rs:200`（SessionSequencer）、`docs/rust-rewrite/33-event-schema-changelog.md`（28 事件）、`docs/rust-rewrite/contracts/contract-test-coverage-matrix.md`（F1-F12）、`docs/rust-rewrite/30-phase-e-master-execution.md:101-150`（E0-E2）、`docs/rust-rewrite/23-architecture-hardening-plan.md:99`（E3.3）、`docs/rust-rewrite/31-security-baseline.md`、`.github/workflows/ci.yml`、统计：195+51 个 rs / 90,588 行；864 个 ts(x) / 177,423 行；1,671 个 #[test]；341 commits；docs 405 md
- opencode：`packages/core/src/event.ts`（EventV2 durable）、`packages/core/src/session.ts`、`packages/core/src/session/todo.ts`、`packages/opencode/src/index.ts`（CLI 命令含 ACP）、`AGENTS.md`（V2 Session Core）、`specs/v2/`、`CONTRIBUTING.md`、`.github/workflows/`（35）、`STATS.md`、`README.md:46-62`（安装）、统计：3,056 ts(x) / 539,171 行；699 测试文件
- grok-build：`crates/codegen/xai-grok-shell/src/session/acp_session.rs`（actor）、`.../acp_session_impl/stop_gate.rs:8`、`crates/codegen/xai-acp-lib/src/gateway.rs`、`crates/codegen/xai-grok-pager/docs/user-guide/`（24 章）、`CONTRIBUTING.md`（不接受 PR）、`README.md:31-35`（SOURCE_REV）、统计：2,375 rs / 1,377,016 行；22,828 个 #[test]；77 crates
