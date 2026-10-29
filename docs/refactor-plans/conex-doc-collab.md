# DC · conex-doc-collab

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. 只留一种撤销、一种生产互推编码。不留 deprecated 的全树 undo。
> 2. 禁止作弊：不加 `allow`、不加 `#[path]`、不删断言。测试改到留下的 API 上。
> 3. 测试只在 DC-P4。提交：`refactor(DC-P<n>): <摘要> [BATCH-DOC-COLLAB]`。无 BOM。
> 4. worktree `C:\Users\orange\rf-doc-collab`，分支 `refactor/doc-collab`。不在主仓库改代码。
> 5. 进度写同目录 `conex-doc-collab.progress.md`。
> 6. Rust 1.99.1，clippy `-D warnings`。`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\doc-collab`，`-j 3`。磁盘余量须 ≥ 25 GB。
> 7. 行号会过期。开工用 `rg` 重定位。

| 项 | 值 |
|---|---|
| 方案代号 | `DC` |
| 波次 | W5。`session.rs` 的 `#[path]` 归 MP-P1，本方案在 MP 之后改撤销与编码 |
| 不重做 | MP 的文件搬迁；MD 的 HTML 引擎与 pulldown |

依据：g3 DC-01..06。2026-10-29 确认 `session_undo.rs` 的 `undo` 仍带 `deprecated` 注记「use text_undo」，`harness.rs` 的 `SimplifiedEncodedOps` 仍从 `lib.rs` 公开导出。

## a. 范围

纳入：`crates/conex-doc-collab` 的双撤销、harness 的 JSON 重放、死 API、flavour 单一映射、验收常量的公共面。

不纳入：
- `session.rs` 的 `#[path]`（MP-P1）。等它合入后在新文件上改逻辑。
- 把 pulldown 换成 md-ast（MD）。`ir.rs` 的 flavour 表若 MD 没有改，由本方案收成唯一映射。
- 笔记存储的 SQL（WS）。

**G-DC**：`git -C C:\Software\conex status --porcelain -- crates/conex-doc-collab` 为空。

## b. 问题清单

| # | 核实 | 证据 |
|---|---|---|
| DC-01 | **确认** | `session_undo.rs` 的 `pub fn undo` 标注 `deprecated(note = "legacy full tree undo; use text_undo ...")`。测试若仍 `allow(deprecated)`，改测 `text_undo` 后删除 allow |
| DC-02 | **确认** | `harness.rs` 定义 `SimplifiedEncodedOps`，`lib.rs` `pub use`。`a_col_skeleton.rs` 写明不得把它当成终局。生产互推不得再走这条 JSON 重放 |
| DC-03 | 仍在，P0 重测 | `text_engine.rs` 超长，并有 `allow(dead_code)`。零调用的项删除。文件拆分不使用 `#[path]`；若 MP 已拆，沿用新文件 |
| DC-04 | 仍在，且不能并进 `from_flavour` | `store_plan_ops.rs` 的 `parse_block_kind` 用 `heading:`，并识别 table / math / ordered_task。`from_flavour` 把 `heading:2` 收成 level 1。存储标签在 `block_kind_to_store_str`。线格式放新文件 `kind_wire.rs`，不改 `ir.rs` |
| DC-05 | 归 MP | 不重复搬 `session.rs` |
| DC-06 | 仍在 | `lib.rs` 导出骨架包与「≠ EL」一类验收常量。迁到 `#[cfg(test)]` 或 `tests/`。不新建 dev crate，除非常量被别的 crate 的测试引用——那种情况放到 `conex-doc-collab` 的 `test_support` feature（D9：feature 只在 `[features]` 与 dev-dependencies，生产代码不包含） |

## c. 目标架构

1. 撤销只有 `text_undo`（CRDT 因果）。删除 `undo`、全树快照栈、以及只为旧栈存在的测试。redo 本来就没有，不要补一个空 redo。
2. 生产路径交换的字节是真实 CRDT update（yrs 已在依赖里）。`SimplifiedEncodedOps` 若只被测试使用，移入 `#[cfg(test)]` 并停止从 `lib.rs` 公开。若生产代码仍调用它，改为 `EncodedUpdate`，然后删除该类型。不要两套都留在公开 API。
3. `text_engine.rs` 按热集、检查点、撤销分成子模块。删除 `registered_ids` 一类「保留供外部兼容」且零调用的字段。`unsafe impl Send` 只保留有安全注释、且类型确实跨线程的那一处；能改成安全封装就删 unsafe。净增 `allow` 为 0。
4. 纸面 flavour 与工具/存储线是两套字符串。`BlockKind::from_flavour`（`ir.rs`）认 `heading` 前缀，后缀只剥 `-` 和 `_`。`heading:2` 解析失败后变成 `Heading { level: 1 }`，而且没有 table、math、callout、footnote、ordered_task。不要让 NR / WS 改调 `from_flavour`，也不要改 `ir.rs`（markdown 批次可能占用它）。新文件 `src/kind_wire.rs` 放 `from_tool_wire` 与 `to_wire_label`。`from_tool_wire` 接受现有并集：`heading:N` 按十进制得到 level 2（1..=6，解析失败才是 1），同时接受 `heading-N`、`heading_N`、`h1`..`h6`、table、math、`callout:` 前缀、footnote、`ordered_task` / `ordered_task_item`。未识别进 `Unknown`，保留原始大小写。`to_wire_label` 与 `block_kind_to_store_str` 逐字相同，空 flavour 返回 `"unknown"`。纸面 `from_flavour` 保持 `heading-N` 行为不动。
5. 验收常量离开公共 `lib.rs`。

## d. 删除清单

- `session_undo.rs` 的 `undo` 与全树栈
- 公开的 `SimplifiedEncodedOps`（测试专用则 `cfg(test)`，不再 `pub use`）
- 零调用的 dead_code API 及其 allow
- `lib.rs` 里的骨架验收常量（移走，不是再导出）

## e. 分阶段步骤

**DC-P0** G-DC 为空。`rg "fn undo\b|SimplifiedEncodedOps|allow\(deprecated\)" crates/conex-doc-collab` 记入 progress。MP-P1 若未合入且要改的逻辑在 `#[path]` 目标文件里，等 MP。

**DC-P1 · 删除全树 undo**

测试改调用 `text_undo`。断言改成因果撤销的期望，不删除「撤销后文档回到上一步」这类用例。

```powershell
rg -n "fn undo\b|allow\(deprecated\)" crates/conex-doc-collab
# 无匹配
```

**DC-P2 · 生产编码与 flavour**

按 §c.2、§c.4。新增 `kind_wire.rs`，`lib.rs` 声明模块。不改 `ir.rs`。测试锁定 `from_tool_wire("heading:2")` 为 level 2，`to_wire_label` 对空 flavour 为 `"unknown"`，`table` 不是 Unknown。NR 与 WS 的调用在它们自己的方案里改；本阶段若必须改那两个 crate 的一行 import，先要求它们的目标文件 `git status --porcelain` 为空，否则只改本 crate 并把剩余调用点写进 progress，不要在脏文件上改。

```powershell
rg -n "SimplifiedEncodedOps" crates/conex-doc-collab/src/lib.rs
# 无匹配
rg -n "fn from_tool_wire|fn to_wire_label" crates/conex-doc-collab/src/kind_wire.rs
# 两个函数都在
rg -n "heading:2" crates/conex-doc-collab/src/ir.rs
# 无匹配（冒号格式不进 ir.rs）
```

**DC-P3 · 拆 text_engine、收验收常量**

不新增 `#[path]`。删除零调用 allow。

**DC-P4 · 验证**

```powershell
$env:CARGO_TARGET_DIR = "C:\Users\orange\conex-tgt\doc-collab"
cargo test -j 3 -p conex-doc-collab
cargo clippy -j 3 -p conex-doc-collab --all-targets -- -D warnings
```

## f. 禁止的捷径

- 不把 `undo` 留成 deprecated 转发到 `text_undo`。
- 不让 `SimplifiedEncodedOps` 继续从 crate 根公开「仅供测试」。
- 不在三个 crate 各留一份 flavour 表。
- 不加 `#[path]`，不调行数基线。
- 不把验收常量再导出成旧路径。

## g. 规范

clippy `-D warnings`。模块 ≤ 600，函数 ≤ 150。`yrs` 版本若要进 workspace，只在本 crate 的依赖行改成 `workspace = true`，且根 workspace 已有同一版本；没有就保持现版本，不要为了「对齐」升级 yrs。

## h. 测试集中点

只有 DC-P4。撤销测试数量不减少。harness 测试改断言真实 update 往返，不删场景。

## i. 审计

`lib.rs` 无 `SimplifiedEncodedOps`、无 `fn undo`、无骨架常量的 `pub use`。`allow(dead_code)` 数量不增加。

## j. 冲突与门控

| 对方 | 关系 |
|---|---|
| MP-P1 | 先拆 `session.rs`。本方案不抢文件 |
| NR / WS | 它们删除本地 kind 表，调用本 crate |
| MD | 不改 HTML 渲染，不删 `conex-md-ast` |
| D9 | `test_support` 仅当别的 crate 的测试需要验收常量。否则用 `cfg(test)`，不要开 feature |

## k. 已决事项

| 项 | 结论 |
|---|---|
| 撤销 | 只留 `text_undo`。删除全树 `undo` |
| 互推 | 生产只用 CRDT update。JSON 重放离开公开 API |
| flavour | 唯一映射在本 crate |
| path | 归 MP |
