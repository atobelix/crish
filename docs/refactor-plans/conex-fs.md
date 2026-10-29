# FS · conex-fs

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. 路径规范化、回收站、监听、窗口读各留一套实现。不留三份 `strip_verbatim`。
> 2. 禁止作弊：不加 `allow`、不加 `#[path]`、不调基线、不删断言。
> 3. 测试只在 FS-P3。提交：`refactor(FS-P<n>): <摘要> [BATCH-CONEX-FS]`。无 BOM。
> 4. worktree `C:\Users\orange\rf-conex-fs`，分支 `refactor/conex-fs`。不在主仓库改代码。
> 5. 进度写同目录 `conex-fs.progress.md`。
> 6. Rust 1.99.1，clippy `-D warnings`。`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\conex-fs`，`-j 3`。磁盘余量须 ≥ 25 GB。
> 7. 行号会过期。开工用 `rg` 重定位。

| 项 | 值 |
|---|---|
| 方案代号 | `FS` |
| 波次 | W5。`path_normalizer.rs` 在写时，FS-P1 不做规范化合并 |
| 不重做 | WS 调用 `atomic_write` 时不要改状态机语义；TM 的时间函数 |

依据：g3 FS-01..04。2026-10-29 确认本 crate 三处剥离函数都在：`lib.rs` 的 `path_utils::strip_verbatim_prefix`、`path_normalizer.rs` 的 `ConexPathNormalizer::strip_verbatim_prefix`、`watch.rs` 的 `strip_verbatim`。`trash.rs` 已经调用 `path_utils` 那一份，不是第四个函数体。`conex-workspace-store` 的 `mirror_os_watch_path.rs` 另有一份，归 WS，本方案不改那个 crate。

## a. 范围与门控

```powershell
git -C C:\Software\conex status --porcelain -- crates/conex-fs
```

整 crate 为空才开工。ROADMAP 记录 `path_normalizer.rs` 在写。非空则停止。

纳入：超长文件按状态机拆开、三处 verbatim 剥离、`windowed_read` 的旧版计数双路径、测试从文件尾部挪走。

不纳入：把原子写改成 mirror 那套 rename（WS 要反过来调用这里）。不改 `ReplaceFileW` 的「不提前移走原文件」这一条。

## b. 问题清单

| # | 核实 | 证据 |
|---|---|---|
| FS-01 | 仍在，行数开工重测 | g3 记录 `trash`、`windowed_read`、`watch`、`atomic_write` 都超过 600。按状态拆文件，不靠基线 |
| FS-02 | **确认** | 上面三个 `strip_verbatim*`。行为必须收成 `ConexPathNormalizer` 的一个方法，另外两处改为调用 |
| FS-03 | 仍在，P0 重读 | `windowed_read.rs` 为对齐旧版保留 `\r` 剥离与两套计数。钉死一种：按 Unicode scalar 计数，换行统一成 `\n` 再计数。删除「对齐旧版」的第二套分支 |
| FS-04 | 仍在 | 测试堆在超长文件末尾，把 `allow(disallowed_methods)` 留在生产文件附近。测试迁到 `tests/` 或文件内 `#[cfg(test)]` 子模块，生产函数上的 allow 只保留原子写文件头已经写明的那一类，且不得新增 |

## c. 目标架构

1. `strip_verbatim_prefix` 只有 `ConexPathNormalizer` 一处。`lib.rs` 与 `watch.rs` 调用它。删除另外两个函数体。UNC 与本地路径的现有测试仍然通过。
2. `trash` 拆成索引、清除、平台差异。`watch` 拆成状态与平台事件。`windowed_read` 拆成窗口与 UTF 边界。`atomic_write` 若仍超 600，按阶段函数拆，不改变 ReplaceFileW 顺序。
3. 窗口读只保留一套字符与换行契约。破坏性变更接受：调用方看到的列号按新契约。测试更新期望，不保留旧计数开关。
4. 生产源码不再为了测试而 `allow`。

## d. 删除清单

- `lib.rs` 与 `watch.rs` 里独立的 strip 函数体
- `windowed_read` 的旧版双路径
- 只为测试存在、且能随测试挪走的 allow

不删除：`atomic_write` / `AtomicWriteTx` 的公开入口（WS 要调用）。

## e. 分阶段步骤

**FS-P0** 门控为空。记录四个文件的行数。

**FS-P1 · 一处规范化 + 删双路径**

`path_normalizer.rs` 必须在本阶段的 diff 里只做「留下唯一实现」。若开工时该文件又脏了，停。

```powershell
rg -n "fn strip_verbatim" crates/conex-fs
# 只剩 Normalizer 上的一个方法
rg -n "对齐旧版" crates/conex-fs/src
# 无匹配
```

**FS-P2 · 拆超长文件、挪测试**

移动即拆分。不准 `#[path]`。每个新文件对应一个状态或平台，而不是按行数对半切。

**FS-P3 · 验证**

```powershell
$env:CARGO_TARGET_DIR = "C:\Users\orange\conex-tgt\conex-fs"
cargo test -j 3 -p conex-fs
cargo clippy -j 3 -p conex-fs --all-targets -- -D warnings
```

## f. 禁止的捷径

- 不保留三个 strip 函数互相调用还都 `pub`。
- 不给窗口读加 `legacy_count: bool`。
- 不改 `atomic_write` 去迁就 mirror 的提前 rename。
- 不加 `#[path]`，不调基线。
- 门控非空不写。

## g. 规范

clippy `-D warnings`。模块 ≤ 600，函数 ≤ 150。`disallowed_methods` 的既有豁免若还在原子写里，保持函数级理由，不扩大到整文件。

## h. 测试集中点

只有 FS-P3。UNC、只读位、跨卷这些原子写测试必须还在。

## i. 审计

`rg fn strip_verbatim` 只有一处。`atomic_write.rs` 仍描述 ReplaceFileW，且没有「先 rename 走原文件」的新步骤。

## j. 冲突与门控

| 对方 | 关系 |
|---|---|
| WS | 调用本 crate。FS 先稳定 `atomic_write` 签名，WS 再删除手写拷贝。不要并行改这个函数的参数 |
| 在写 | `path_normalizer.rs` 脏则整模块停 |

## k. 已决事项

| 项 | 结论 |
|---|---|
| 剥离前缀 | 只留 Normalizer |
| 窗口计数 | Unicode scalar，换行先归一。不留旧版开关 |
| 原子写 | 保持 ReplaceFileW，不改成提前 rename |
