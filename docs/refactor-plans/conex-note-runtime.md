# NR · conex-note-runtime

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. 块类型只调用 `conex-doc-collab` 的映射。不留第三份 flavour 表。
> 2. 禁止作弊：不加 `allow`、不加 `#[path]`、不删断言。
> 3. 测试只在 NR-P3。提交：`refactor(NR-P<n>): <摘要> [BATCH-NOTE-RUNTIME]`。无 BOM。
> 4. worktree `C:\Users\orange\rf-note-runtime`，分支 `refactor/note-runtime`。不在主仓库改代码。
> 5. 进度写同目录 `conex-note-runtime.progress.md`。
> 6. Rust 1.99.1，clippy `-D warnings`。`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\note-runtime`，`-j 3`。磁盘余量须 ≥ 25 GB。
> 7. 行号会过期。开工用 `rg` 重定位。

| 项 | 值 |
|---|---|
| 方案代号 | `NR` |
| 波次 | W5。`store_plan_ops.rs` 的 `#[path]` 归 MP-P1。AT-P4 会把笔记实现从 agent-tools 迁入本 crate，本方案在那之后收口，避免两边各写一份映射 |
| 不重做 | MP 的布局；AT 的 `NoteBackend` trait 边界；MD 的解析引擎 |

依据：g3 NR-01..04。2026-10-29 确认 `store_plan_ops.rs` 仍有 `parse_block_kind` 与 `kind_label`，`hydrate_projection.rs` 仍有 `kind_to_flavour`。

## a. 范围与门控

```powershell
git -C C:\Software\conex status --porcelain -- crates/conex-note-runtime
```

必须为空，且 MP-P1 已合入（`store_plan_ops.rs` 不再靠 `#[path]` 挂测试），且 AT-P4 已把要迁入的类型迁完。任一不满足就停。

不改 `conex-workspace-store` 的 SQL（WS）。flavour 表的定义在 DC，本方案只删除本地拷贝。

## b. 问题清单

| # | 核实 | 证据 |
|---|---|---|
| NR-01 | **确认** | `parse_block_kind` 认 `heading:`。`from_flavour` 会把 `heading:2` 收成 level 1。删除本地函数，调用 DC 的 `from_tool_wire` / `to_wire_label`，不调用 `from_flavour` |
| NR-02 | 仍在，P0 重读 | `store_apply_md.rs`、`store_backend_apply.rs` 在 async 路径上 `lock()` `std::sync::Mutex`。持锁区间改成同步短临界区，里面不序列化大树；必须跨 await 的状态改用 `tokio::sync::Mutex`。不要两种锁包同一份数据 |
| NR-03 | 仍在，P0 重读 | `lib.rs` 同时暴露 doc-session hydrate 与 query-blocks hydrate。返回类型分开。产品打开只拿 session 类型。query 类型不能赋给 session 类型 |
| NR-04 | 归 MP | 不重复搬 `#[path]` |

## c. 目标架构

1. kind / flavour / 标签只有 DC 的函数。本 crate 没有 `parse_block_kind`、`kind_label`、`kind_to_flavour`。
2. 每个文档会话的锁：同步部分用 `std::sync::Mutex` 且不跨 `.await`；需要跨 await 的只用 `tokio::sync::Mutex`。锁内不做整树序列化。现有 SlowPathProbe 告警变成结构上不可能（把序列化移出锁），不是再加一条日志。
3. `hydrate_session` 与 `query_blocks` 返回不同的类型。删除能让调用方把检索结果当成打开文档的公共标签或同一结构体。

## d. 删除清单

- 三个本地映射函数
- 锁内的整树序列化
- 把两种 hydrate 收成一个返回类型的别名

## e. 分阶段步骤

**NR-P0** 门控与 AT-P4、MP-P1、DC flavour 单一来源都已合入。`rg` 三个函数名。

**NR-P1 · 删除本地映射**

调用 DC 的 `from_tool_wire` 与 `to_wire_label`。禁止改调 `from_flavour`（`heading:2` 会变成 level 1，table 会变成 Unknown）。空 flavour 的期望是 `"unknown"`，不是空串。不删测试。`callout:` 前缀必须仍能回到 `Callout`，不要落成 `Unknown { flavour: "callout:…" }`。

```powershell
rg -n "fn parse_block_kind|fn kind_label|fn kind_to_flavour" crates/conex-note-runtime
# 无匹配
```

**NR-P2 · 锁与两种 hydrate**

按 §c.2、§c.3。`rg "std::sync::Mutex" crates/conex-note-runtime/src` 的命中点逐个看是否跨 await。跨 await 的必须消失。

**NR-P3 · 验证**

```powershell
$env:CARGO_TARGET_DIR = "C:\Users\orange\conex-tgt\note-runtime"
cargo test -j 3 -p conex-note-runtime
cargo clippy -j 3 -p conex-note-runtime --all-targets -- -D warnings
```

## f. 禁止的捷径

- 不保留本地映射当 DC 函数的「兜底」。
- 不在 async 函数里 `lock()` 之后还 `.await`。
- 不用类型别名假装两种 hydrate 已经分开。
- 不加 `#[path]`。
- 不在 AT-P4 未合入时把 agent-tools 的笔记文件再搬一次。

## g. 规范

clippy `-D warnings`。函数 ≤ 150。模块行数服从仓库闸门。MP 已拆的文件不要合并回去。

## h. 测试集中点

只有 NR-P3。hydrate 与 apply 的现有测试保留。锁测试若能构造「await 期间不持 std 锁」，加上，不删旧场景。

## i. 审计

三个函数名为 0。progress 里有一列：每个 `std::sync::Mutex` 的临界区没有 `.await`。

## j. 冲突与门控

| 对方 | 关系 |
|---|---|
| MP-P1 | 先拆 `store_plan_ops.rs` |
| AT-P4 | 先迁入笔记实现。本方案删除迁入之后仍存在的重复映射 |
| DC | flavour 定义在 DC |
| WS | 不改 workspace-store 的 SQL |

## k. 已决事项

| 项 | 结论 |
|---|---|
| 映射 | 只调用 DC。删除本地三函数 |
| 锁 | std 锁不跨 await。不双锁同一数据 |
| hydrate | 两种返回类型，不能互换 |
| 顺序 | MP-P1 与 AT-P4 与 DC 之后 |
