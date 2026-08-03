# 错误吞没统计基线（I8 G4 · swallowed errors）

> 归属：I8 G4（治理收尾）· 日期：2026-08-04 · 维护：`node scripts/check-swallowed-errors.mjs [--update]`
> 语义：统计 crates/** 生产代码（测试文件与 `#[cfg(test)]` 块除外，规则同
> check-unwrap-baseline.mjs）的两类吞错模式：① `let _ = ...`（含 `let _: T = ...`）
> 丢弃赋值；② `if let Ok(_)` / `Ok(_) =>` 忽略 Ok 值。
> 门禁：任一 crate 任一类计数 > 基线 → 脚本 exit 1（新增吞错必须消除或显式登记）；
> 存量下降即通过（ratchet）；提升基线必须显式 `--update`。
> 本文件为量化数据文件，标记区由脚本维护；正文表格为验收时点口径，以标记区为准。

## 生产代码计数（门禁口径，2026-08-04 建线）

| crate | let_= | Ok(_) | 合计 |
|---|---|---|---|
| agent-provider | 1 | 2 | 3 |
| agent-tools | 10 | 0 | 10 |
| conex-compaction | 0 | 1 | 1 |
| conex-db | 2 | 0 | 2 |
| conex-diff | 0 | 0 | 0 |
| conex-fs | 4 | 1 | 5 |
| conex-markdown | 0 | 0 | 0 |
| conex-net | 0 | 0 | 0 |
| conex-sandbox | 0 | 0 | 0 |
| conex-search | 0 | 0 | 0 |
| conex-stream | 0 | 0 | 0 |
| conex-telemetry | 4 | 0 | 4 |
| conex-test-utils | 2 | 0 | 2 |
| conex-types | 0 | 0 | 0 |
| orchestrator | 3 | 2 | 5 |
| session-loop | 17 | 1 | 18 |

合计：生产 `let _ =` **43**、`Ok(_)` 忽略 **7**、共 **50**（16 个 crate）。

## 测试代码计数（仅观察，不设门禁）

| crate | let_= | Ok(_) |
|---|---|---|
| agent-provider | 11 | 2 |
| agent-tools | 9 | 0 |
| conex-compaction | 0 | 0 |
| conex-db | 6 | 0 |
| conex-fs | 3 | 0 |
| conex-telemetry | 4 | 0 |
| conex-test-utils | 1 | 0 |
| orchestrator | 3 | 0 |
| 其余 | 0 | 0 |

## 关键路径审计（事件落库 / 审批落库）

- `crates/conex-db/src/migrate.rs`（2 处 `let _ =`）：迁移日志写忽略失败，属
  迁移过程容错路径，存量保留；后续轮次评估改显式上报（G4 关键路径候选）。
- `crates/session-loop/src/tool_exec.rs`（`let _ =` 3 处）：工具执行吞错面，
  均为已分类错误后处理路径，存量保留；候选改 `#[must_use]` 接口面（G4 候选硬门禁）。
- 并行域在途（session-loop 重构）使 session-loop `let _ =` 由 6 升至 16：
  门禁按基线登记放行（--update 显式刷新），重构收口后按新基线回落治理。
- 审批落库（session-loop approval / orchestrator events）未命中吞错模式：现网
  审批拒绝路径经 `ApprovalDecision::Denied` 结构化传播，无 `let _ =` 吞错。
- 候选硬门禁（G4 §2.3）：关键函数返回类型加 `#[must_use]` 或利用 clippy
  `let_underscore_must_use`——登记为后续轮次评估项，本轮只建计数基线。

## 维护注记

- 2026-08-04（I8 G4 建线）：按 crate 登记生产/测试计数；门禁阈值 = 各 crate
  生产计数；`--update` 只刷新标记区（git diff 可复核）。
- 2026-08-04（并行域在途）：session-loop 重构期间 `let _ =` 6 → 17，已随
  `--update` 显式刷新登记（重构收口后回落后可再 `--update` 降基线）。

<!-- BASELINE_START -->
agent-provider 1 2
agent-tools 10 0
conex-compaction 0 1
conex-db 2 0
conex-diff 0 0
conex-fs 4 1
conex-markdown 0 0
conex-net 0 0
conex-sandbox 0 0
conex-search 0 0
conex-stream 0 0
conex-telemetry 4 0
conex-test-utils 2 0
conex-types 0 0
orchestrator 3 2
session-loop 17 1
<!-- BASELINE_END -->
