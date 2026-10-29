# EC · 错误码单一真源

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. 彻底改进。不留手写镜像、不留 `pub use` 转发、不用「未知码回退」掩盖未注册码。
> 2. 禁止作弊：不加 `allow` / `ignore` / `eslint-disable` / `@ts-ignore` / `@ts-expect-error`；不调基线；不放宽 `check:i18n`；不删断言。
> 3. 测试只在 EC-P4 与 EC-P6。每阶段一个提交：`refactor(EC-P<n>): <摘要> [BATCH-ERROR-CODES-SSOT]`。无 BOM。
> 4. worktree `C:\Users\orange\rf-error-codes`，分支 `refactor/error-codes-ssot`。不 stash、不 push、不在主仓库改代码。
> 5. 进度写 `C:\Users\orange\conex-review\plans\X-04错误码单一真源.progress.md`。
> 6. Rust 1.99.1，clippy `-D warnings`，Node 24。`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\error-codes`。
> 7. 行号是 `bf3d60fa3` 快照。开工前按码字符串和函数名重定位。

| 项 | 值 |
|---|---|
| 方案代号 | `EC` |
| 波次 | W4：EC-P1～P4（W2 合并后）；W5：EC-P5～P6（门控 G-EC） |
| 已决 | **D10 = A**：真源是 `crates/conex-types/contracts/error-codes.json`。生成器是独立的 `scripts/generate-error-codes.mjs`。不另起 CI 作业，塞进现有 `engine-bindings-drift` 步骤。不为此改根 `package.json`（在写） |
| 作废 | 旧稿「Rust `macro_rules!` 声明表为源」以及代号 `X04`。不得执行 |

依据：`plans\X-04错误码单一真源.md`、ROADMAP §9.2 D10。

## a. 范围

### a.1 现状：同一份表有 4 份手工维护

| 份 | 文件 | 编写时规模 |
|---|---|---|
| R1 | `crates/conex-types/src/error/codes.rs` | 约 166 行，105 个 `pub const`。头注释称以 codes.ts 为源 |
| R2 | `crates/conex-types/src/error/registry/{agent_runtime,tool,infra}.rs` | 105 条。`registry/mod.rs` 注释和 `with_capacity` 仍写 102 |
| T1 | `packages/shared-types/src/errors/codes.ts` | 105 个联合成员。头注释写 102 |
| T2 | `packages/shared-types/src/errors/info.ts` | `CRISH_ERROR_REGISTRY` |

`codes-drift.test.ts` 只比较码集合，不比较 title / category / retryable / public / action。TS 消费方是 `apps/crish-desktop/src/utils/error-translation.ts` 的 `getErrorInfo`。Rust 消费方在 `error/mod.rs`。

### a.2 可改文件

上表 4 份；`codes-drift.test.ts`；`scripts/generate-error-codes.mjs`（新建）与 `scripts/check-error-code-literals.mjs`（新建）；`.github/workflows/ci.yml` 只在 engine-bindings-drift 步骤里加一步；`crates/conex-types/contracts/error-codes.json`（新建）；b 表里的字面量和镜像所在文件。W5 的 src-tauri 文件除外，直到 G-EC 满足。

不改 `generate-engine-bindings.mjs` 的生成逻辑（它已有一千多行）。不改根 `package.json`。

## b. 问题清单（编写时已核实，开工前重跑）

**E1 Rust 与 TS 元数据已漂移。** 按 code 对齐，13 条不一致（第 14 条因写法不同没被比对脚本吃到，EC-P1 手工核对）：

| code | 差异 |
|---|---|
| `subagent.nesting_denied` | title：Rust「子代理嵌套禁止」 / TS「子代理不允许派发子代理」 |
| `tool.aborted_before_dispatch`、`tool.cancelled`、`tool.outcome_unknown` | action：Rust 是中文句子，TS 是 `action.*` 键 |
| `tool.browser.cancelled` | action 键不同，title 不同 |
| `tool.browser.capability_disabled` | title 不同 |
| `tool.browser.eval_forbidden` | action：`check_eval_policy` / `check_whitelist`，title 不同 |
| `tool.browser.gate_blocked` | action：`check_domain` / `check_target` |
| `tool.browser.node_gone`、`tool.browser.stale_snapshot` | action：`refresh_snapshot` / `resnapshot` |
| `tool.browser.not_ready` | action：`wait_recovery` / `wait_ready`，title 不同 |
| `tool.browser.tab_limit_exceeded` | title 不同 |
| `tool.browser.unwired` | action：`check_supported` / `check_version`，title 不同 |

**E2 未注册就使用的码**（生产字面量）：
- session-loop `tool_events.rs` 的 `error_code()`：`tool.timeout`、`tool.user_denied`、`tool.approval_expired`、`tool.requires_approval`、`tool.soft_deny`、`tool.policy_blocked`。`exec_verdict.rs` 的 `classify_tool_error` 是同一组的反向映射。
- session-loop `executing_tools.rs` 的回退值 `tool.error`；`streaming.rs` 的 `TOOL_STREAM_ERROR_BEFORE_DISPATCH = "tool.stream_error_before_dispatch"`。
- agent-tools `tools/shell.rs`：`tool.requires_approval`、`tool.command_blocked`、`tool.user_denied`、`tool.cd_blocked`；`fs.rs` 的 `tool.file_exists`；`note_stress_guard.rs` 的 `note.malicious_extension_forbidden_write`。
- conex-agents `fault.rs` 的 `pub mod codes`：`agent.capacity_pressure`、`agent.capability_denied`、`agent.model_unavailable`、`agent.comm_throttled`、`agent.config_invalid`、`agent.interrupted`、`agent.spawn_failed`。
- conex-telemetry `crash.rs` 的 `"common.panic"`。

**E3 镜像常量**：`conex-browser-tools/src/codes.rs`（9 个 `tool.browser.*`）；`conex-computer-tools/src/lib.rs` 里的 8 个外加 `tool.session.exclusive`；src-tauri `browser_commands/common.rs`（在写，W5）。两个 tools crate 已经依赖 conex-types。

**E4** `conex-agents/src/guard.rs` 在兄弟数、并发数超限时也用 `SUBAGENT_DEPTH_EXCEEDED`。语义修复（改用新码）由 `conex-agents.md` 做；本方案负责把新码登记进契约。新码名以执行时 `guard.rs` 的变体语义为准：`subagent.siblings_exceeded`、`subagent.concurrency_exceeded`。

**E5** `registry/mod.rs` 与 `codes.ts` 头注释写 102，实际 105。

误报：
- `conex-types/src/device/error.rs` 的 `"approval.expired"` 属于设备协议码空间（device-protocol.json），不纳入。
- `approval.rs` 里的 `tool.approval_expired` 已随 provider-loop 的 ApprovalChannel 删除。W1 合入后生产里应只剩 `tool_events.rs` 那一处。开工前 `rg -n "tool.approval_expired" crates apps -g "*.rs"` 复核；若已无生产使用，不注册。

## c. 目标架构

1. `crates/conex-types/contracts/error-codes.json` 是唯一真源。`scripts/generate-error-codes.mjs` 生成 4 个产物：`error/codes.rs`、`error/registry.rs`（可按 domain 拆文件，但不得为了躲限额登记基线）、`errors/codes.ts`、`errors/info.ts`。产物带 `GENERATED — do not edit` 头。
2. 条目字段：`code`、`const`（Rust 常量名）、`domain`、`title`、`category`、`retryable`、`public`、`action`（必须是 `action.*` 键，且该键在 i18n 资源里存在；生成器校验）、`description`。
3. CI：在 `ci.yml` 的 engine-bindings-drift 步骤里，先跑 `generate-engine-bindings.mjs`，再跑 `generate-error-codes.mjs`，然后一次 `git diff --exit-code`。不另起作业。本地验证同样两步。不改根 package.json。
4. 删除 `codes-drift.test.ts`。若它还有 `tool.write_path_conflict` 的行为断言（编写时约在该测试后半），迁到 info 的单测，断言一条不丢。
5. `scripts/check-error-code-literals.mjs`：从契约读全部 domain 前缀和 code。生产 Rust/TS（排除 generated、测试、i18n 资源）里，若出现已注册 code 的字符串字面量，或在含 `code` 的行 / `fn error_code` 体内出现 `"<domain>.<snake>"` 字面量，就报错。没有白名单。
6. E1 裁决：action 一律取 `action.*` 键（Rust 里那 3 句中文是错的）。两个键不同时，取 i18n 里存在的那个；两个都在时，取与 code 名语义一致的，逐条写入 progress。title 取 TS 版（UI 实际展示的是 TS），同样逐条记录。

`classify_tool_error` 的匹配集合保持现有那 6 个码，只把字符串换成生成常量。不要为了「完整」把未在该函数里出现的变体加进去——那会把现在落成 `ExecutionFailed` 的码改成别的 kind，是行为变化，不在本方案。未知码继续落 `ExecutionFailed`。

## d. 删除清单

R1/R2/T1/T2 的手写内容（由生成物替换）；`codes-drift.test.ts`（行为断言先迁走）；`conex-browser-tools/src/codes.rs`；`conex-computer-tools` 里的镜像常量；E2 的全部裸字面量。调用点改用 `conex_types::error::codes::*`。不留 `pub use` 旧模块。

## e. 分阶段步骤

**EC-P1 · 建立契约**
- 从 R2 导出 105 条，按 c.6 裁决 E1，写入 `error-codes.json`。progress 里放裁决表。
- 判据：JSON 有 105 条且 `code` 唯一。用 `node -e` 统计，输出贴进 progress。此阶段不改生成物。
- 提交：`refactor(EC-P1): 以 error-codes.json 收口错误码契约 [BATCH-ERROR-CODES-SSOT]`

**EC-P2 · 生成器替换 4 份手写**
- 实现 c.1～c.4。
- 判据：

```powershell
rg -n "GENERATED" crates/conex-types/src/error packages/shared-types/src/errors
# 覆盖 codes.rs、registry、codes.ts、info.ts 四个产物
rg -n "\b102\b" crates/conex-types/src/error packages/shared-types/src/errors
# 期望：0
node scripts/generate-error-codes.mjs
git status --porcelain -- crates/conex-types/src/error packages/shared-types/src/errors
# 期望：空（再跑一次无差异）
```

**EC-P3 · 注册缺失码、去字面量、去镜像、登记 E4 的新码**
- 需要 W2 已合并：session-loop 由 PL 负责，`shell.rs` / `exec_verdict.rs` 由 SB 负责。
- E2 的码加入契约。每个都有 title、category、action。action 键同步加入 i18n 中英文件。`check:i18n` 必须通过。`tool.approval_expired` 若已无生产使用，不注册。
- E4 的两个新码只登记。`guard.rs` 改调用归 `conex-agents.md`。若 AG 还没做，本阶段可以改 `guard.rs` 的这两处调用（文件小、不在在写区），但不要顺手改能力表和端口。
- 判据：`node scripts/check-error-code-literals.mjs` 在 W4 范围内为 0。`Test-Path crates/conex-browser-tools/src/codes.rs` 为 False。

**EC-P4 · W4 验证**（§h）。

**EC-P5 · W5**（门控 G-EC）：src-tauri `browser_commands/common.rs` 的镜像改为生成常量。检查脚本覆盖全仓。

**EC-P6 · 全量验证**（§h，加上 `crish-agent-workbench`）。src-tauri 未提交前不要编这个包。

## f. 禁止事项

- 不得手改生成物。不得在检查脚本里加白名单或基线。
- 不得用「未知码回退 `common.unknown`」掩盖未注册码。所有生产码必须注册。
- 不得保留镜像常量或 `pub use` 转发。
- 不得把 Rust 宏表当作真源，再从 Rust 导出 TS。
- 不加 allow / ignore。不放宽 i18n 检查。不改根 package.json。
- 不扩大 `classify_tool_error` 的匹配集合。

## g. 项目规范

生成器风格参照 `generate-engine-bindings.mjs`：失败时非零退出。i18n 键要对称（`check:i18n:symmetry`）。Rust 改动遵守 clippy、crate-size、line-counts。生成的 registry 每条一行，保证文件在行数限制内。

## h. 集中测试

```powershell
node scripts/generate-error-codes.mjs
git diff --exit-code -- crates/conex-types/src/error packages/shared-types/src/errors crates/conex-types/contracts/error-codes.json
$env:RUSTUP_TOOLCHAIN="1.99.1"
$env:CARGO_TARGET_DIR="C:\Users\orange\conex-tgt\error-codes"
cargo clippy -j 3 -p conex-types -p session-loop -p agent-tools -p conex-agents -p conex-telemetry -p conex-browser-tools -p conex-computer-tools --all-targets -- -D warnings
cargo test -j 3 -p conex-types -p session-loop -p agent-tools -p conex-agents -p conex-telemetry -p conex-browser-tools -p conex-computer-tools
npm run typecheck
npm run lint
npm run check:i18n
npm run test -- packages/shared-types apps/crish-desktop/src/utils
node scripts/check-error-code-literals.mjs
npm run check:line-counts
node scripts/check-crate-size.mjs
```

另按 ROADMAP §7.2：`node scripts/generate-engine-bindings.mjs` 与错误码生成器在同一次 drift 检查里先后运行，`git diff --exit-code`。

## i. 审计清单

- [ ] A1 progress 里有 E1 裁决表。抽查 3 条 action 键，i18n 资源里存在
- [ ] A2 `rg -n "\"(tool|agent|common|note|subagent)\.[a-z0-9_.]+\"" crates -g "*.rs" -g "!**/tests/**" -g "!*_tests.rs"` 的每一条命中，要么在生成物中，要么在测试中
- [ ] A3 `codes-drift.test.ts` 里的行为断言已迁移。对比删除前后的 `expect(` 数量
- [ ] A4 `rg -n "generate-error-codes" .github/workflows/ci.yml` 有输出，且位于 engine-bindings-drift 步骤内，不在新作业里
- [ ] A5 `git diff <base>..refactor/error-codes-ssot | rg "^\+.*(#\[allow|@ts-ignore|@ts-expect-error|eslint-disable|continue-on-error)"` 为 0
- [ ] A6 根 `package.json` 无本方案造成的 diff

## j. 风险、依赖、并行

依赖 W2 合并（PL 改 session-loop，SB 改 `exec_verdict.rs` / `shell.rs`）。检测：

```powershell
git -C C:\Software\conex log --oneline -E main --grep "PL-P2|SB-P4|BATCH-PROVIDER-CONTRACT-SSOT|BATCH-SANDBOX-ASSESS-SSOT"
```

门控 **G-EC**（EC-P5）：

```powershell
git -C C:\Software\conex status --porcelain -- apps/agent-workbench/src-tauri
# 必须为空
```

与 ST 都碰 `packages/shared-types` 与生成器周边。ST 不改错误码文件，本方案不改 `generated/engine`。仍建议串行合并：EC-P2 先落地生成物，ST 基于该结果开分支，避免 `index.ts` 冲突。

与 `conex-types.md`：TY 不碰 `error/`（TY-P1 删除 `error/migrate.rs` 除外）。TY-P1 放在 EC-P2 之后，避免两边同时改 `error/mod.rs`。

风险：action 键改名会改变前端文案。progress 里写清每一条用户可见的变化。验证以 `check:i18n` 和 error-translation 测试为准。

cargo 不与其他 Rust 模块同时跑。

## k. 已决事项

| 编号 | 决定 |
|---|---|
| D10 | JSON 契约为源，独立生成器，与 engine-bindings 共用一个 CI drift 步骤 |
| E1 | action 用 `action.*` 键；title 用 TS 版；逐条记在 progress |
| `classify_tool_error` | 只把现有 6 个码的字符串换成常量，不扩大匹配 |
| E4 | 本方案登记新码；`guard.rs` 的调用替换若在本阶段做，只改这两处 |

没有剩余的「待用户决策」。新增码的 title / action 由执行者按同域风格拟定，写进 progress，不单独阻塞阶段。
