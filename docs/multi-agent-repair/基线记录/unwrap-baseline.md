# unwrap 计数基线（I8 G3 · panic 面量化）

> 归属：I8 G3（治理收尾）· 日期：2026-08-04 · 维护：`node scripts/check-unwrap-baseline.mjs [--update]`
> 语义：统计 crates/** 生产代码（src 内非 `#[cfg(test)]` 块；tests/、benches/、
> tests.rs 等测试文件除外）的 `.unwrap(` / `.expect(` 计数，按 crate 汇总。
> 门禁：任一 crate 生产 unwrap/expect 计数 > 基线 → 脚本 exit 1（新增 > 阈值即失败）；
> 存量下降即通过（ratchet 只许降不许升）；提升基线必须显式 `--update`。
> 本文件为量化数据文件，标记区由脚本维护；正文表格为验收时点口径，以标记区为准。

## 生产代码计数（门禁口径，2026-08-04 建线）

| crate            | unwrap | expect | 合计 |
| ---------------- | ------ | ------ | ---- |
| agent-provider   | 0      | 8      | 8    |
| agent-tools      | 0      | 2      | 2    |
| conex-compaction | 0      | 1      | 1    |
| conex-db         | 0      | 0      | 0    |
| conex-diff       | 0      | 0      | 0    |
| conex-fs         | 0      | 0      | 0    |
| conex-markdown   | 1      | 27     | 28   |
| conex-net        | 0      | 0      | 0    |
| conex-sandbox    | 0      | 0      | 0    |
| conex-search     | 0      | 0      | 0    |
| conex-stream     | 0      | 0      | 0    |
| conex-telemetry  | 0      | 0      | 0    |
| conex-test-utils | 0      | 13     | 13   |
| conex-types      | 0      | 0      | 0    |
| orchestrator     | 0      | 2      | 2    |
| session-loop     | 10     | 5      | 15   |

合计：生产 unwrap **11**、expect **58**、共 **69**（16 个 crate）。

## 测试代码计数（仅观察，不设门禁）

| crate            | unwrap | expect |
| ---------------- | ------ | ------ |
| agent-provider   | 124    | 213    |
| agent-tools      | 300    | 48     |
| conex-compaction | 9      | 10     |
| conex-db         | 159    | 3      |
| conex-diff       | 1      | 0      |
| conex-fs         | 62     | 0      |
| conex-markdown   | 0      | 0      |
| conex-net        | 0      | 0      |
| conex-sandbox    | 0      | 0      |
| conex-search     | 0      | 0      |
| conex-stream     | 15     | 0      |
| conex-telemetry  | 16     | 1      |
| conex-test-utils | 0      | 1      |
| conex-types      | 47     | 0      |
| orchestrator     | 322    | 25     |
| session-loop     | 119    | 85     |

合计：测试 unwrap **1174**、expect **386**（仅观察）。

## 与既有记录的关系

- T13 §1 记载「存量 unwrap() 约 1900 处（含测试 1100+）」为粗略口径；
  本基线为脚本机器口径（生产 69 / 测试 1560），作为后续 `unwrap_used`/
  `expect_used` 增量打开（G12 pedantic 子集流程）的下降曲线起点。
- 生产 expect 集中在：conex-markdown（sanitizer/renderer 的 `Regex::new(...).expect`
  静态初始化，27 处）、conex-test-utils（断言助手 13 处）、session-loop
  （invariants/streaming/testing 域 5 处）。
- session-loop `src/testing/mod.rs` 为无条件编译的测试基建模块（`pub mod testing`），
  按 Rust 编译语义计入生产侧。

## 维护注记

- 2026-08-04（I8 G3 建线）：按 crate 登记生产/测试计数；门禁阈值 = 各 crate
  生产计数；`--update` 只刷新标记区（git diff 可复核）。

<!-- BASELINE_START -->
agent-provider 9 41
agent-tools 85 62
conex-agents 0 0
conex-browser 0 16
conex-browser-tools 0 0
conex-compaction 0 2
conex-computer 0 39
conex-computer-tools 0 3
conex-db 0 2
conex-diff 0 0
conex-doc-collab 95 18
conex-fs 38 5
conex-markdown 0 25
conex-md-ast 0 0
conex-note-runtime 60 15
conex-relay 0 0
conex-run 3 8
conex-sandbox 0 0
conex-search 0 0
conex-shared 0 0
conex-telemetry 0 0
conex-test-utils 0 13
conex-types 0 7
conex-workspace-store 99 8
orchestrator 79 11
session-loop 46 24
<!-- BASELINE_END -->
