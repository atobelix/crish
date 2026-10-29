# conex-compaction · 压缩 crate 单面化与死代码清理（Rust 核心）

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md` §2，开工前必须先读 README）
> 1. 彻底改进：简洁、架构清晰、抽象合理、符合项目规范；非必要不兼容——不打补丁，不加别名、垫片、转发、双轨开关。
> 2. 禁止作弊：不加 `allow`/`expect(lint)`/`#[ignore]`/`eslint-disable`/`@ts-ignore`/`@ts-expect-error`/`.skip`/`.only`；不调基线、不放宽阈值；不用 `continue-on-error`、`--no-verify`；不删测试、不弱化断言。
> 3. 改完一大块再集中测试；每阶段单独提交，提交信息前缀 `refactor(<方案代号>-P<阶段>): `，提交信息不带 BOM。
> 4. 在独立分支或 worktree 上工作；不 stash、不 push、不覆盖他人改动；主仓库的未提交改动一律不碰。
> 5. 进度写入与本方案同名的 `.progress.md`（同目录），每阶段写：完成项、探针命令输出、偏差与理由。
> 6. 工具链：Rust 1.99.1，`cargo clippy --workspace --all-targets -- -D warnings`；Node 24（^24.3.0）、npm ^11.6.2。
> 7. 文中行号是编写时（2026-10-29，HEAD `bf3d60fa3` + 当时工作区）的快照，**开工前必须用文中给出的 `rg` 命令重新定位**，以符号名为准。

| 项 | 值 |
|---|---|
| 方案代号 | `CP` |
| 严重度 / 规模 | P2 / 中（P1 crate 内部；P2 跨 types/tauri/前端删死链；P3–P5 涉及 session-loop、conex-run 调用方） |
| 能否立即开工 | **P1 可以**（`crates/conex-compaction` 当前 git 干净）；P2–P6 门控（见 a.3） |
| 来源 | g1 CP-01…CP-07、TY-02；本次核实：CP-02 **确认**（此前「部分误报」结论作废），新增 CP-08（`parse_legacy_summary` 生产死代码）、CP-09（`CompactionEngine.max_tokens` 与方法参数 `budget` 双真源） |
| 关联方案 | `conex-types.md`（TY-02 的 `Message`/`CompactionResult` 由本方案 P2 删除）、`agent-provider.md`（CP-05 迁入 `clean_output` 的接收方）、`x03-time-utils.md`（`parse_iso8601_epoch_ms`）、`session-loop-residual.md`、`conex-run.md` |

## a. 范围与前置

### a.1 纳入
- `crates/conex-compaction/**`（src 与 tests）。
- 死链 `core_compact_messages` 全链路：`crates/conex-types/src/lib.rs` 的 `Message`/`CompactionResult`；`apps/agent-workbench/src-tauri/src/{core_commands.rs, core_commands/tests.rs, command_registry.rs, command_manifest.rs, main.rs(注释)}`；`apps/agent-workbench/src/core/tauri-command-registry.ts`；`apps/crish-desktop/src/api/{rustCore.ts, transport/commandManifest.ts}`、`apps/crish-desktop/src/test-setup.test.ts`。
- 调用方 `use` 路径与构造方式迁移：`crates/session-loop/src/loop/{compaction_dispatch.rs, handlers/stream_error_recover.rs, summary_dispatch/**, stage_summary.rs, stage_summary_tests.rs}`、`crates/conex-run/src/run/{mod.rs, run_core.rs, run_history.rs, run_launch.rs, run_idle.rs}`、`crates/orchestrator/tests/multi_agent.rs`、`crates/agent-provider/src/request/**`（仅 `clean_output` 导入路径）。

### a.2 不纳入
- 压缩**算法行为**（切割点、usage 优先估算、stub 句柄、折叠链规则）一律不变；本方案只做结构收敛与死代码删除。
- `session-loop` 的压缩触发策略（何时压缩）——属模块 2 / `session-loop-residual.md`。
- 前端压缩事件消费（`compressionHandlers.ts`、`store/sessionCompressionApply.ts`）只做 wire 兼容验证，不改。

### a.3 门控
「模块 2 已合并」判据：`git merge-base --is-ancestor refactor/provider-loop main; $LASTEXITCODE` 为 `0`，或 `Test-Path crates/agent-provider/src/consume` 为 `False`。分支若已删除，以后者为准。「模块 1 已合并」：`git merge-base --is-ancestor refactor/session-stream main; $LASTEXITCODE` 为 `0`。时间函数的最终归宿见 `x03-time-utils.md`（代号 TM，D11）。

| 阶段 | 门控（PowerShell，在仓库根执行） |
|---|---|
| P1 | `git status --short -- crates/conex-compaction` 为空 |
| P2 | P1 完成；模块 1 已合并（`rustCore.ts` 属模块 1）；`git status --short -- apps/agent-workbench crates/conex-types apps/crish-desktop/src/api/transport apps/crish-desktop/src/test-setup.test.ts` 为空；若 `conex-types.md` TY-P6/P7 正在进行，等其提交（同改 `conex-types/src/lib.rs`） |
| P3 | P1 完成；模块 2 已合并；`git status --short -- crates/session-loop crates/conex-run/src/run crates/orchestrator/tests` 为空 |
| P4 | P3 完成（同门控） |
| P5 | P4 完成；`git status --short -- crates/session-loop/src/loop/summary_dispatch crates/session-loop/src/loop/stage_summary.rs crates/conex-run/src/run` 为空。D-CP-2 已决为字符串数组，见 k |
| P6 | 模块 2 已合并；`git status --short -- crates/agent-provider` 为空；与 `agent-provider.md` 协调（同一时间只允许一方改 `agent-provider/src/request/**`） |
| P7 | P1–P6 完成 |

> 前置条件：在写改动已提交。开工前对每个阶段执行上表命令；任何一条非空即停，写入 `.progress.md` 后等待。

## b. 问题清单（已亲自核实）

定位一律用 `rg -n "<符号>" <路径>`，以下行号为快照。

| 编号 | 问题 | 证据 |
|---|---|---|
| CP-01 | **双面结构**：旧 `Message` 面（三字段 id/role/content）与 `AgentMessage` 面并存。`lib.rs:3-12` 自述「旧面不再演进」但仍保留；旧面唯一生产入口是 IPC 命令 `core_compact_messages`，而前端唯一封装 `rustCore.ts:70 compactMessages` **全仓零调用**（`rg -n "compactMessages\(" apps` 仅命中定义） | `engine.rs:68 pub fn compact(&self, messages: &[Message]) -> CompactionResult`；`core_commands.rs:263-279`；`command_registry.rs:192`；`command_manifest.rs:206`；`tauri-command-registry.ts:414`；`commandManifest.ts:161`；`conex-types/src/lib.rs:131-150` |
| CP-09 | `CompactionEngine` 的 `max_tokens` 字段与方法参数双真源：生产全部 `CompactionEngine::new(0)`（`compaction_dispatch.rs:94/298/348/406`、`stream_error_recover.rs:159`），预算经方法参数传入；`run_launch.rs:1883` 同时 `new(budget)` 又在 `compact_agent_messages_with_stub_policy(&conversation, budget as usize, …)` 再传一次；`max_tokens` 只被旧面 `compact()` 读 | `engine.rs:17-25`（字段）、`:35 new`、`:68` |
| CP-04a | generation 有四种设置方式：`new_with_generation`(:43)、`with_generation`(:51)、`set_generation`(:57)、字段缺省时按消息链回退推导（:387-411）。生产只用 `new(0).with_generation(next_gen)`（`compaction_dispatch.rs:406`） | `rg -n "new_with_generation|set_generation|with_generation" crates apps -g "*.rs"` |
| CP-02 | **阈值死代码一整套**：`CompactionThresholds`、`ThresholdDecision`、`should_preheat/should_critical_defense/threshold_tokens`、`COMPACT_THRESHOLD_RATIO_DEFAULT`(0.85)、`COMPACT_CRITICAL_RATIO_DEFAULT`(0.95)、`SESSION_META_KEY_COMPACT_THRESHOLD_RATIO`、`SESSION_META_KEY_COMPACT_CRITICAL_RATIO`、`is_under_budget`、`adaptive_keep_recent_tokens`、`tool_output.rs:316-322 classify_after_truncation` 在 crate 外 **0 引用**；`conex-run run_core.rs:951` 附近注释自认阈值键「挂账」不消费。实际触发阈值在 session-loop 内另有一套 → 双真源 | `rg -n "CompactionThresholds|ThresholdDecision|COMPACT_(THRESHOLD|CRITICAL)_RATIO|is_under_budget|adaptive_keep_recent_tokens|classify_after_truncation" crates apps -g "*.rs"` 仅命中 conex-compaction 自身与其 tests |
| CP-02b | `thresholds.rs` 混装：死阈值 + 仍在用的 `EstimateContext`(:156，`compaction_dispatch.rs:33/93`)、`EstimateSource`(:147，`invariants.rs:21`)、`SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS`(:19，`run_history.rs:488`)、时间解析 `parse_iso8601_epoch_ms`(:277) | `rg -n "^pub " crates/conex-compaction/src/thresholds.rs` |
| CP-04 | 导出多路径：`lib.rs:36-41 pub mod compaction { pub use crate::{cut_point,engine,plan,thresholds}::* }` 与根 `pub use` 重复，同一类型可经 `conex_compaction::X`、`conex_compaction::compaction::X`、`conex_compaction::engine::X` 三条路径访问；`push_critical_context` 三处导出（`ai_summary`、根 `lib.rs:43`、`summary_document.rs:16`）；`tool_output.rs:26-29` 对 `conex_shared::perf_budget::G8_TOOL_OUTPUT_*` 做 `as` 改名再导出（别名） | `rg -n "conex_compaction::compaction::" crates apps -g "*.rs"`（`run_core.rs:958`、`run/mod.rs:56`、`run_history.rs:478-487`）；`tool_output.rs:21 use crate::compaction::{…}` |
| CP-03 | 摘要文档弱类型：`validate_summary_document` 返回 `serde_json::Value`，只校验 12 个 required 键存在（`SUMMARY_REQUIRED_FIELDS` :22）与 `droppedIds` 是数组；渲染层 `string_field(...).unwrap_or("")`、`decisions` 同时接受对象与纯字符串（:114-141）、`criticalContext`「兼容态：顶层对象键值直接作为 criticalContext」（`ai_summary/prompt.rs:159`）——同一字段多形态容错，错误被静默吞成空串 | `summary_document.rs:73-95, 97-145`；`prompt.rs:112-170`；生产消费 `session-loop summary_dispatch/run.rs:8/92/108`、`stage_summary.rs:22/212`、`conex-run run_idle.rs:1572` |
| CP-08 | `parse_legacy_summary`(:260，「旧格式文本 → 最低骨架文档」，`tier=legacy`) 生产 0 调用，仅 crate 内测试使用（`:319`）——兼容层已无读者 | `rg -n "parse_legacy_summary" crates apps -g "*.rs"` |
| CP-05 | `clean_output`（wire 投影时的工具输出清洗 R1–R6）放在压缩 crate，但只被 agent-provider 用：`request/build_gemini.rs:26`、`request/build_anthropic/messages.rs:5`、`request/messages.rs:25`；压缩 crate 内部除 `lib.rs` 外不用。导致 agent-provider 依赖 conex-compaction（层次反向）。`CleanupOptions::wire_safe()`(:42) 仅测试使用；`duplicate_fold_marker`(:71) 是 pub 但只内部用 | `clean_output.rs` 405 行，`use crate::count_tokens`(:14) 仅用于 `CleanupResult.tokens_saved`(:252) |
| CP-07 | 体积与长函数：`engine.rs` 869 行（MOD 上限 600），同时含旧面、估算、切割、stub/LLM 计划、emergency_preflight、preview；`tests/engine_tests.rs` 996 行 | `Get-Content crates/conex-compaction/src/engine.rs \| Measure-Object -Line` |

**误报/修正**：此前把 CP-02 判为「部分误报」不成立——阈值类型在生产链路无任何消费，确认为死代码；只有 `EstimateContext`/`EstimateSource`/`SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS` 需保留并迁出。`tool_output.rs` 截断本身（`truncate_tool_output` 等）有生产使用，不在删除之列。

## c. 目标架构

```
crates/conex-compaction/src/
  lib.rs            // 仅 mod 声明 + 一组根 pub use（唯一公开路径），不再有 pub mod compaction
  tokens.rs         // count_tokens / count_agent_message_tokens / …（不变）
  estimate.rs       // EstimateContext、EstimateSource、估算函数（从 engine.rs/thresholds.rs 迁入）
  cut_point.rs      // 不变（find_cut_point 若为无状态函数则从 engine 迁入）
  plan.rs           // CompactionPolicy / CompactionPlan / StubPolicy / Summarizer
                    // + SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS（与 MAX_SUMMARY_TOKENS_DEFAULT 同处）
  engine/           // CompactionEngine（只剩 AgentMessage 面），按职责拆：
    mod.rs          //   struct + 构造 + compact_agent_messages*
    stub.rs         //   stub/句柄与折叠链 block 生成
    preflight.rs    //   emergency_preflight / preview_compaction
  summary/          // 原 summary_document.rs + ai_summary/*（prompt、guard、details）
    document.rs     //   SummaryDocument 强类型（serde camelCase，wire 不变）
    render.rs       //   summary_to_markdown(&SummaryDocument)
  tool_output.rs    // 截断（直接使用 conex_shared::perf_budget::G8_TOOL_OUTPUT_*，不改名再导出）
  recovery.rs, template.rs
```

要点：
1. **单一面**：只有 `AgentMessage` 面。`Message`/`CompactionResult` 与 `core_compact_messages` 整链删除。
2. **CompactionEngine 状态**只剩 `generation: Option<u32>`：构造 `CompactionEngine::new()`，唯一可选设置 `.with_generation(g)`；删除 `max_tokens`、`new_with_generation`、`set_generation`。预算只经方法参数传入。若删字段后某些方法不读 `self`（执行者用编译器 + 阅读确认，例如 `estimate_context_tokens`、`find_cut_point`、`should_compact`），改为对应模块的自由函数，`CompactionEngine` 只保留真正依赖 generation 的方法。
3. **阈值单真源**：conex-compaction 不再定义任何「何时压缩」的比例阈值；触发决策由 session-loop 现有实现负责（不在本方案移动）。
4. **公开路径唯一**：每个公开符号只有根路径 `conex_compaction::X` 一条（子模块改为私有 `mod`，必要时 `pub(crate)`）。`clean_output` 不再从本 crate 导出。
5. **摘要强类型**（P5）：
   ```rust
   #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
   #[serde(rename_all = "camelCase")]
   pub struct SummaryDocument {
       pub schema_version: u32,
       pub block_id: String,
       pub generation: u32,
       pub dropped_ids: Vec<String>,
       pub height: u32,
       pub tier: SummaryTier,           // 枚举，取值以现有生产者为准（执行者 rg "\"tier\"" 列全）
       pub goal: String,
       pub constraints: Vec<String>,
       pub progress: Vec<String>,       // 字段类型以生产者（prompt.rs / stage_summary.rs 构造处）为准
       pub decisions: Vec<String>,      // D-CP-2：只保留 prompt 里的字符串数组
       pub next_steps: Vec<String>,
       pub critical_context: Vec<CriticalContextItem>,
       #[serde(flatten)]
       pub extra: serde_json::Map<String, serde_json::Value>, // 对应现有 additionalProperties: true（custom/counts 等）
   }
   ```
   `validate_summary_document(json, max_bytes) -> Result<SummaryDocument, SummaryDocError>`：字节预算检查 → `serde_json::from_str::<SummaryDocument>`（缺字段/类型错由 serde 报，映射为 `SummaryDocError`）。`SUMMARY_REQUIRED_FIELDS` 常量删除（由类型表达）。wire（事件、checkpoint、前端 `criticalContext`/`droppedIds`）字段名与形态不变。
6. **clean_output 归属**（P6）：迁到 `crates/agent-provider/src/request/clean_output.rs`（私有于 request 层）。`tokens_saved` 字段：若 agent-provider 内无读者（执行者 `rg -n "tokens_saved|rules_applied|original_bytes|cleaned_bytes" crates/agent-provider`），`clean_output` 直接返回 `String`，`CleanupResult` 删除；若有读者，改用 agent-provider 已有的 token 估算（不得为此保留对 conex-compaction 的依赖）。完成后 `agent-provider/Cargo.toml` 若无其他使用即删除 `conex-compaction` 依赖。

## d. 删除清单

| 删除项 | 位置 | 阶段 |
|---|---|---|
| `CompactionThresholds`、`ThresholdDecision` 及其方法、`COMPACT_THRESHOLD_RATIO_DEFAULT`、`COMPACT_CRITICAL_RATIO_DEFAULT`、`SESSION_META_KEY_COMPACT_THRESHOLD_RATIO`、`SESSION_META_KEY_COMPACT_CRITICAL_RATIO`、`is_under_budget`、`adaptive_keep_recent_tokens`、`classify_after_truncation`；`tests/threshold_tests.rs` 中只测这些的用例 | `thresholds.rs`（文件整体删除，存活项迁出）、`tool_output.rs` | P1 |
| `parse_legacy_summary` 及其测试；`summary_document.rs` 模块注释中的「兼容解析」段 | `summary_document.rs:251-280` | P1 |
| `summary_document.rs:16` 对 `push_critical_context` 的再导出 | 同左 | P1 |
| `CleanupOptions::wire_safe`（测试改为显式构造字段）；`duplicate_fold_marker` 降为私有 | `clean_output.rs` | P1 |
| `CompactionEngine::compact`（旧面）及 `engine_tests.rs` 中旧面用例（`:13/26/59/88/105` 一组） | `engine.rs:61-195` | P2 |
| `conex_types::Message`、`conex_types::CompactionResult` | `conex-types/src/lib.rs:131-150` | P2 |
| `core_compact_messages` 命令、注册、manifest 条目、测试 | `core_commands.rs:263-279`、`core_commands/tests.rs:245`、`command_registry.rs:192-193`、`command_manifest.rs:206`、`tauri-command-registry.ts:414` 条目、`commandManifest.ts:161` | P2 |
| `compactMessages` 及其专用 TS 类型（`Message`/`CompactionResult` 若只此处用） | `crish-desktop/src/api/rustCore.ts:70-82` | P2 |
| `max_tokens` 字段、`new(max_tokens)` 参数、`new_with_generation`、`set_generation` | `engine.rs:17-59` | P3 |
| `pub mod compaction { … }` | `lib.rs:36-41` | P4 |
| `tool_output.rs:26-29` 的 `as` 改名再导出 | 同左 | P4 |
| `SUMMARY_REQUIRED_FIELDS`、`string_field` 等 Value 取值辅助、`decisions`/`criticalContext` 的多形态分支（`summary_document.rs:114-141`、`prompt.rs:159` 兼容态） | `summary_document.rs`、`ai_summary/prompt.rs` | P5 |
| `clean_output` 模块与根导出；agent-provider 对 conex-compaction 的依赖（若无其他使用） | `conex-compaction/src/clean_output.rs`、`agent-provider/Cargo.toml` | P6 |

## e. 分阶段步骤

### P1 · crate 内死代码与 thresholds 拆分（可立即开工）
改动：
1. 新建 `estimate.rs`，迁入 `EstimateContext`、`EstimateSource` 及其 impl；`SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS` 迁到 `plan.rs`；`parse_iso8601_epoch_ms`：若 TM-P2 已把解析放进 `conex_shared::time`，改为调用 `parse_iso_utc_millis` 并删除本地实现；否则作为 `estimate.rs` 的私有 `fn`（它只服务 usage 时间戳护栏——执行者用 `rg -n "parse_iso8601_epoch_ms" crates apps` 确认 crate 外无使用后去掉根导出；若 crate 外有使用，保留到 TM 接手，在 `.progress.md` 记录，不留同名转发函数）。
2. 删除 d 表 P1 行全部条目；`thresholds.rs` 删除；`tool_output.rs:21` 不再 `use crate::compaction::{CompactionThresholds, ThresholdDecision}`。
3. `lib.rs` 根 `pub use` 同步：去掉已删符号；存活符号（`EstimateContext`、`EstimateSource`、`SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS`）根路径保持不变，因此本阶段**不触碰任何 crate 外文件**。
4. 更新 `lib.rs` 模块文档（去掉阈值描述）。

完成判据：`cargo test -p conex-compaction` 全绿；`cargo check --workspace --all-targets` 通过（证明外部无引用）；clippy 无警告。
探针：
```powershell
rg -n "CompactionThresholds|ThresholdDecision|COMPACT_(THRESHOLD|CRITICAL)_RATIO|is_under_budget|adaptive_keep_recent_tokens|classify_after_truncation|parse_legacy_summary|wire_safe" crates apps -g "*.rs"   # 期望：无输出
Test-Path crates/conex-compaction/src/thresholds.rs   # 期望：False
```

### P2 · 删除 `Message` 旧面与 `core_compact_messages` 死链（D-CP-1 已决：删除）
改动：按 d 表 P2 行逐项删除。不得改成 AgentMessage 上的第二入口。`test-setup.test.ts:138-140` 用 `core_compact_messages` 作 mock 示例——改用另一个仍存在的命令名（如 `core_count_tokens`），断言语义不变。`main.rs:375` 注释同步。`conex-compaction/src/engine.rs` 顶部 `use conex_types::{…, CompactionResult, Message}` 去掉。
完成判据：Rust 侧 `cargo check --workspace --all-targets` 通过；前端 `npm run typecheck`（或仓库对应脚本）与 `npx vitest run apps/crish-desktop/src/test-setup.test.ts` 通过；命令注册一致性测试（`tauri-command-registry.test.ts`、manifest 对齐测试）通过。
探针：
```powershell
rg -n "core_compact_messages|compactMessages|CompactionResult\b" apps crates packages -g "*.{rs,ts,tsx}" -g "!**/node_modules/**"   # 期望：无输出
rg -n "pub struct Message\b" crates/conex-types/src   # 期望：无输出
```

### P3 · CompactionEngine 状态收敛（门控模块 2）
改动：
1. 删 `max_tokens`；`new()` 无参；保留唯一 `with_generation`；删 `new_with_generation`、`set_generation`。
2. 逐个检查 `impl CompactionEngine` 的公开方法（`rg -n "^\s*pub fn" crates/conex-compaction/src/engine.rs`）：不读 `self` 的改为模块自由函数（估算类 → `estimate.rs`，切割 → `cut_point.rs`，`should_compact` → `plan.rs` 或 `estimate.rs`），并在根 `pub use`。
3. 迁移调用方：`compaction_dispatch.rs:94/298/348/406`、`stream_error_recover.rs:159`、`run_launch.rs:1883`（去掉重复传 budget）、`orchestrator/tests/multi_agent.rs:200/242/834`（字段 `compact: CompactionEngine` 随之调整）。
完成判据：`cargo test -p conex-compaction -p session-loop -p conex-run -p orchestrator` 全绿；压缩相关快照/fixture 测试输出逐字节不变。
探针：
```powershell
rg -n "CompactionEngine::new\(\S" crates apps -g "*.rs"           # 期望：无输出（new 无参）
rg -n "new_with_generation|set_generation|max_tokens" crates/conex-compaction/src   # 期望：无输出（max_tokens 若作为方法参数名存在，需改名为 budget_tokens 以免歧义）
```

### P4 · 公开路径唯一化
改动：删 `pub mod compaction`；`pub mod` 子模块改为私有 `mod`（外部若通过子模块路径访问，如 `conex_compaction::summary_document::…`、`conex_compaction::ai_summary::build_summarize_prompt`（`conex-run engine_channels.rs:159`）、`conex_compaction::clean_output::…`（P6 前暂保留该模块 pub，P6 删除），改为根路径导出并迁移调用方）；`tool_output.rs` 直接引用 `conex_shared::perf_budget::G8_TOOL_OUTPUT_MAX_{BYTES,LINES}_DEFAULT`，调用方同步改用该名。
调用方：`conex-run/src/run/{mod.rs:56, run_core.rs:894-958, run_history.rs:472-520}`、`conex-run/src/engine_channels.rs`、`session-loop` 所有 `conex_compaction::summary_document::` 导入、`src-tauri engine_tests.rs`。
完成判据：workspace 编译 + 上述 crate 测试全绿。
探针：
```powershell
rg -n "conex_compaction::(compaction|engine|thresholds|cut_point|plan|summary_document|ai_summary|tokens|tool_output)::" crates apps -g "*.rs"   # 期望：仅剩 clean_output（P6 处理）
rg -n "^pub mod" crates/conex-compaction/src/lib.rs   # 期望：至多 clean_output 一行
```

### P5 · SummaryDocument 强类型（D-CP-2 已决：字符串数组）
改动：按 c.5 定义类型；`decisions` / `criticalContext` 只保留 prompt 要求的字符串数组（`prompt.rs` 里发给模型的那一形态）。对象形态（topic/detail/reason）删除，不合规输出走现有校验失败降级，不得渲染成空行。`validate_summary_document` 返回 `SummaryDocument`；`summary_to_markdown(&SummaryDocument)`；`push_critical_context` 改吃强类型；删 d 表 P5 行；迁移 `summary_dispatch/run.rs`、`stage_summary.rs`（`stage_summary_to_markdown`）、`run_idle.rs` 的调用点、各测试。开工前先 `rg` 确认生产路径是否会重新校验已持久化摘要（编写时校验只发生在 LLM 新输出 `summary_dispatch` 的 run 函数，持久化后以 markdown 进链）。若发现回读解析，停工并写入 progress，不要静默改历史会话。
完成判据：现有摘要相关测试全绿；新增回归 R3/R4（见 h）通过；`summary_to_markdown` 对现有全部测试 fixture 的输出与改造前逐字节一致（形态被 D-CP-2 删除的 fixture 除外，需在 `.progress.md` 列出）。
探针：
```powershell
rg -n "serde_json::Value" crates/conex-compaction/src/summary   # 期望：仅 extra 字段与必要的边界解析
rg -n "SUMMARY_REQUIRED_FIELDS|兼容态" crates -g "*.rs"   # 期望：无输出
```

### P6 · clean_output 迁入 agent-provider（与 agent-provider.md 协调）
改动：按 c.6 迁移；三处导入改为 `crate::request::clean_output`；规则 R1–R6 与测试原样迁移（测试随文件迁入 agent-provider，数量不减）。删除 conex-compaction 中的模块与 `pub mod`；agent-provider `Cargo.toml` 删 conex-compaction 依赖（`rg -n "conex_compaction" crates/agent-provider` 为空时）。
完成判据：`cargo test -p agent-provider`（含 `messages_tests/chat_wire.rs:157` 的 R-J 清洗用例）全绿；`cargo tree -p agent-provider -e normal | rg conex-compaction` 无输出。

### P7 · engine 拆分与长函数
改动：`engine.rs` 按 c 拆为 `engine/{mod,stub,preflight}.rs`（**不使用 `#[path]`**，遵守 `x05-path-attr-cleanup.md`）；单函数 > 80 行的拆为具名私有辅助函数；`tests/engine_tests.rs` 按主题拆为 `tests/engine_{plan,stub,preflight}_tests.rs`，用例一个不少。
完成判据：`node scripts/check-crate-size.mjs`、`node scripts/check-line-counts.mjs` 通过且**未改基线**；测试数量前后一致（`cargo test -p conex-compaction -- --list` 计数对比写入 `.progress.md`）。

## f. 禁止事项
- 不得保留 `Message` 面「以备 UI 将来用」，不得把 `core_compact_messages` 改成转调 AgentMessage 面的薄壳。
- 不得把删除的阈值常量搬到 session-loop 或 conex-shared「以防万一」；session-loop 现有触发阈值不动。
- 不得为 `CompactionEngine::new` 保留带参重载、`Default` 以外的第二构造器或 `#[deprecated]` 旧名。
- 不得新增 `pub use` 别名（含 `as` 改名）来维持旧路径。
- P5 不得用 `#[serde(untagged)]` 同时接受两种形态来规避 D-CP-2；不得用 `#[serde(default)]` 掩盖 required 字段缺失（required 字段缺失必须是校验错误，走既有降级路径）。
- P6 不得在 conex-shared 新建「text」杂物模块承接 clean_output（它是 provider wire 投影策略，归 agent-provider）。
- 通用：不加 `allow`、不 `#[ignore]`、不删/弱化测试断言、不调 crate-size/line-count 基线。

## g. 项目规范要点
- 子 crate `[lints] workspace = true`；`unsafe_code=warn`、`clippy::all=warn`（CI `-D warnings`）、`dbg_macro`/`unimplemented` deny；`clippy.toml` disallowed-methods 生效。
- 体积门禁 `scripts/check-crate-size.mjs`（LIB 800 / MOD 600 行）——`engine.rs` 869 行当前已超，P7 后必须达标而非调基线。
- 模块文件风格：本 crate 现用 `foo.rs` + `foo/` 混合（`ai_summary/mod.rs`），新目录按 `x05` D-X05-1 结论统一。
- 注释使用中文，保留「为什么」，删去引用已删除代码/阶段号的历史叙述（如 lib.rs:3-12）。
- TS 侧：`eslint --max-warnings 0`、`tsconfig strict`。

## h. 集中测试
每阶段结束集中跑一次（不要每改一文件跑一次）：
```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p conex-compaction -p session-loop -p conex-run -p orchestrator -p agent-provider -p conex-types
cargo test -p agent-workbench        # P2 后（src-tauri 包名以 Cargo.toml 为准）
npm run -w crish-desktop typecheck; npx vitest run --project crish-desktop   # P2 后（脚本名以 package.json 为准）
node scripts/check-crate-size.mjs; node scripts/check-line-counts.mjs
```
回归（新增或确认已有覆盖，写进对应 tests 文件）：
- **R1 压缩计划不变**：对 `tests/engine_tests.rs` 现有 AgentMessage 面 fixture，P3/P7 前后 `CompactionPlan`（dropped ids、cut 位置、生成的 summary block id `compacted-summary-{generation}-{fold_index}`）逐字段相等。P3 开工前先把这些断言补全为完整结构比较。
- **R2 generation 推导**：未调用 `with_generation` 时按消息链回退推导（`engine.rs:387-411` 逻辑）与调用后的取值，各一条用例。
- **R3 摘要 wire 不变**：一份完整 Schema V1 JSON（含 `custom`/`counts` 扩展键）`validate → serialize` 往返后与原 JSON 语义相等（`serde_json::Value` 比较），证明 `extra` flatten 不丢键。
- **R4 摘要校验**：缺任一 required 字段、`droppedIds` 非数组、超字节预算三类错误各一条；被 D-CP-2 删除的形态输入应返回错误（而非渲染成空行）。
- **R5 clean_output 迁移等价**：迁移前把 R1–R6 每条规则的输入/输出用例固定；迁移后同一组用例在 agent-provider 内通过。
- **R6 前端无引用**：P2 后 `rg` 探针为空，且命令注册表/manifest 一致性测试通过。

## i. 审计清单
- [ ] P1：`thresholds.rs` 不存在；d 表 P1 所列符号全仓 `rg` 为空；`cargo check --workspace --all-targets` 通过
- [ ] P1：`EstimateContext`/`EstimateSource`/`SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS` 根路径未变，crate 外文件零改动（`git diff --stat` 仅 conex-compaction）
- [ ] P2：`core_compact_messages`、`compactMessages`、`CompactionResult`、`conex_types::Message` 全仓 `rg` 为空（含 TS）
- [ ] P2：conex-types TY 方案审计项「TY-02 已删除」可勾选
- [ ] P3：`CompactionEngine` 只有 `generation` 状态；`new()` 无参；只有一种 generation 设置方式
- [ ] P3：`run_launch.rs` 不再重复传 budget
- [ ] P4：`lib.rs` 无 `pub mod compaction`；外部无子模块路径导入；无 `as` 改名再导出
- [ ] P5：`validate_summary_document` 返回 `SummaryDocument`；无多形态分支；R3/R4 通过
- [ ] P6：agent-provider 不依赖 conex-compaction（或仅剩经核实的其他用途，写明）；`clean_output` 测试数不减
- [ ] P7：`engine.rs`/`engine/` 每文件 ≤ 600 行；crate-size/line-count 基线文件 `git diff` 为空；测试计数前后一致
- [ ] 全程：无新增 `allow`/`#[ignore]`/`#[path]`/别名；每阶段一个提交，前缀 `refactor(CP-P<n>): `

## j. 风险、依赖与先后顺序
- **顺序**：P1 → P2（门控模块 1）；P1 → P3 → P4 → P5（门控模块 2 与 conex-run/src/run 在写）；P6 依赖 P4 且与 `agent-provider.md` 串行；P7 最后。P2 与 P3–P5 可并行（文件不相交：P2 只碰 types/tauri/前端与 engine.rs 的 `compact` 方法——若并行，P2 与 P3 都改 `engine.rs`，**须串行提交**，先 P2 后 P3 rebase）。
- **与 conex-types.md**：P2 改 `conex-types/src/lib.rs`，与 TY-P1/P6/P7 冲突，按「谁先开工谁先提交」串行；TY-P6（拆 lib.rs）若先完成，`Message`/`CompactionResult` 可能已被移入子文件，按符号名定位删除即可。
- **与 x05**：本 crate 当前无 `#[path]`（执行者 `rg -n "#\[path" crates/conex-compaction` 复核）；P7 新目录不得引入。
- **与 TM**（`x03-time-utils.md`）：`parse_iso8601_epoch_ms` 的最终归宿是 `conex_shared::time::parse_iso_utc_millis`。谁先做都可以，后做者按符号名接上，不留同名转发。
- **风险**：P5 可能改变运行时行为——历史会话里若存了被删形态，重新校验会失败。执行者必须先按 P5 的 `rg` 确认没有回读解析；有则停工。
- P3 改变 `CompactionEngine` 公开 API，orchestrator 集成测试（`tests/multi_agent.rs`）需同步，勿遗漏。

## k. 已决事项（2026-10-29）

| 编号 | 决定 | 理由 |
|---|---|---|
| D-CP-1 | 删除 `core_compact_messages` 整链，含 `Message` / `CompactionResult`、IPC 注册和前端零调用封装 | 前端 `compactMessages` 无调用方。真正的手动压缩走 `conex-run` 的 `run_launch` LlmRequired 路径。保留第二入口就是双轨。P2 仍受 src-tauri 与模块 1 门控 |
| D-CP-2 | `decisions` / `criticalContext` 只保留 prompt 里的字符串数组。不合规的 LLM 输出走校验失败降级 | prompt 是唯一模型契约。多形态容错会静默吞错。不使用 `#[serde(untagged)]` 同时接受两种形态 |
| D-CP-3 | P6 开工前 `rg` 复核：生产调用方若只取 `.cleaned`，删除 `tokens_saved` / `rules_applied` / `bytes`，函数改为返回 `String` | 编写时没有读者。若复核发现遥测已经在读这些字段，停工记 D13，不要自行接上遥测 |

没有剩余的「待用户决策」。
