# WS · conex-workspace-store

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. 镜像落盘走 `conex-fs` 的原子写。不留第二套 tmp→bak→rename。
> 2. 禁止作弊：不加 `allow`、不加 `#[path]`、不调基线、不删断言。
> 3. 测试只在 WS-P4。提交：`refactor(WS-P<n>): <摘要> [BATCH-WORKSPACE-STORE]`。无 BOM。
> 4. worktree `C:\Users\orange\rf-workspace-store`，分支 `refactor/workspace-store`。不在主仓库改代码。
> 5. 进度写同目录 `conex-workspace-store.progress.md`。
> 6. Rust 1.99.1，clippy `-D warnings`。`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\workspace-store`，`-j 3`。磁盘余量须 ≥ 25 GB。
> 7. 行号会过期。开工用 `rg` 重定位。

| 项 | 值 |
|---|---|
| 方案代号 | `WS` |
| 波次 | W5。整 crate 门控。`#[path]` 归 MP-P4，本方案不搬那些文件 |
| 不重做 | MP-P4 的目录化；DB 的会话 CAS 与 GC；MD 的 parse 引擎 |

依据：g3 WSS-01..10。2026-10-29 对照 `mirror_export.rs`、`lib.rs`、`migrations.rs`。

## a. 范围与门控

**G-WS**：

```powershell
git -C C:\Software\conex status --porcelain -- crates/conex-workspace-store
```

必须为空。编写时 `note_documents.rs` 在写，未满足则不要开工。

纳入：镜像原子写、自建 watcher、迁移兼容枝、快照占位、块 kind 字符串、别名模块、动态 SQL 列名。

不纳入：
- `#[path]` 与测试文件搬迁（MP-P4）。本方案只改行为，不新增 `#[path]`。
- `conex-db` 的 `cas_gc`（DB 已决：两套库不合并）。本方案把笔记侧方法改名，避免和 `put_blob` 撞名。
- `conex-md-ast` 的解析（MD）。

## b. 问题清单（已对照当前代码）

| # | 核实 | 证据 |
|---|---|---|
| WSS-01 | 仍在 | `lib.rs` 同时覆盖 schema、snapshot、blocks、FTS、CAS、mirror、watcher。不在本方案拆成四个 crate（会和 MP、DB 抢边界）。职责用目录表达，crate 保持一个 |
| WSS-02 | **确认** | `mirror_export.rs` 约第 31 行注释写「Windows 3 阶段原子写」，实现是 `.tmp` → `sync_all` → 把目标 `rename` 成 `.bak` → 再 `rename` 临时文件。`conex-fs/src/atomic_write.rs` 用 `ReplaceFileW`，并且明确不提前移走原文件。本 crate 的 `Cargo.toml` 不依赖 conex-fs |
| WSS-03 | 仍在，P0 再对调用点 | `mirror_os_watch.rs`、`mirror_poll.rs` 自建 notify。`conex-fs` 已有 `WorkspaceWatcher`。`mirror_os_watch_path.rs` 另有一份 `fn strip_verbatim`，与 conex-fs 的三份并列，是第四份 |
| WSS-04 | 仍在，名称纠正 | 版本在表 `schema_version.version`，不是 SQLite `user_version`。`version < 8` 时调用 `backfill_legacy_doc_meta_v8`，然后抬到 `SCHEMA_VERSION`。`migrate_tests.rs` 把 version 写成 2 再打开，期望成功。`ensure_column` 在版本判断之前每次打开都跑。要删的是每次打开补列，不是 v8 回填 |
| WSS-05 | 仍在，P0 重读 | `lib.rs` 自述 snapshot 合并不是真实 CRDT encode，结构 update 用 rev 占位。生产 hydrate 必须走已有 `structure_codec`。占位字节路径删除 |
| WSS-06 | 仍在 | 块 kind 字符串在本 crate 与 note-runtime。存储线改调 DC 的 `from_tool_wire` / `to_wire_label`。不要改调 `from_flavour` |
| WSS-07 | 归 MP-P4 | 不在这里用 `#[path]` 或再拆一遍 |
| WSS-08 | **确认** | `migrations.rs` 只有 `pub use crate::migrate::*`。`lib.rs` 的 `document_meta` 模块体是 `pub use crate::note_documents::*` |
| WSS-09 | 仍在，P0 重读 | `query_blocks_sql_filters.rs` 把列名字符串插进 SQL。改成枚举，禁止 `&str` 列名 |
| WSS-10 | 归 MP-P4 | 测试布局不在这里搬 |

## c. 目标架构

1. 镜像文件只通过 `conex_fs::atomic_write`（或 `AtomicWriteTx`）写入。删除 `mirror_export.rs` 里手写的三阶段 rename。依赖 `conex-fs`。不把 ReplaceFileW 再抄一份。
2. 目录监听只订阅 `conex-fs` 的 `WorkspaceWatcher`。按文档 id 过滤。删除 `mirror_os_watch` / `mirror_poll` 里重复的 notify 循环，并删掉 `mirror_os_watch_path.rs` 的 `strip_verbatim`，改调 `ConexPathNormalizer`。若缺的只是排除规则，把规则加进 conex-fs 已有参数。在同一临时目录比较一次 rename：`WorkspaceWatcher` 必须给出 mirror 今天实际消费的 Create / Remove / Rename / Modify，且 `safe_doc_id` 过滤后事件还在。给不出则本阶段的监听替换取消，保留现有 `RecommendedWatcher`，progress 贴两边事件。不要发明第三种防抖。
3. 版本列是 `schema_version.version`。`version < 8` 的库仍走一次 `backfill_legacy_doc_meta_v8`，不拒绝打开。每次打开的 `ensure_column` 收进这一次迁移，打开已是当前版本的库不再补列。回填函数里的 `SystemTime::now` 本方案不改，归 TM。
4. 持久化的协作更新使用已有结构 codec 的字节。删除 rev 占位写入。compact 与 hydrate 使用同一种 framing。
5. 存储线调用 DC 的 `from_tool_wire` 与 `to_wire_label`（`kind_wire.rs`）。禁止改调 `from_flavour`。空 flavour 的存储标签保持 `block_kind_to_store_str` 今天的 `"unknown"`。`heading:2` 必须仍是 level 2。本地函数删除。
6. 删除 `migrations` 与 `document_meta` 两个别名模块。调用方改 `migrate` 与 `note_documents`。
7. 笔记 CAS 方法改名为 `put_note_blob` / `get_note_blob`（或同等不含 `put_blob` 的名字）。不把数据搬进 conex-db。DB 方案不改本 crate。
8. SQL 列名用枚举匹配到字面量常量。`json_extract` 的 key 只来自白名单表的固定字符串，不拼接调用方传入的 `&str`。

## d. 删除清单

- `mirror_export.rs` 内联原子写
- 重复的 watcher 实现（订阅留下）
- 每次打开都跑的 `ensure_column`。`backfill_legacy_doc_meta_v8` 留在 `version < 8` 的那一次迁移里
- `mirror_os_watch_path.rs` 的 `strip_verbatim` 函数体
- rev 占位写入
- 本地 kind 字符串表
- `migrations.rs`、`document_meta` 模块
- 动态列名参数

不删除：笔记库本身、`cas_gc`（那是 conex-db）、MP 尚未搬走的 `#[path]` 文件。

## e. 分阶段步骤

**WS-P0** 只读。G-WS 为空才继续。把 WSS-04/05/09 的函数名重新记进 progress。

**WS-P1 · 原子写、别名、列名**（不碰 MP 将要拆的大文件时，若那些逻辑就在大文件里，等 MP-P4 合入再改新路径）

1. 换原子写，加 `conex-fs` 依赖。
2. 删两个别名模块，改调用点。
3. 列名改枚举。

```powershell
rg -n "pub use crate::migrate::\*|pub mod document_meta" crates/conex-workspace-store
# 无匹配
rg -n "3 阶段原子写|conex-bak-" crates/conex-workspace-store/src
# 无匹配
```

**WS-P2 · watcher、迁移下限、codec、kind**

等 DC 的 `BlockKind` 单一映射合入。删除本地表。watcher 改订阅。`open` 对过低版本返回错误。删除占位 rev。

**WS-P3 · 笔记 CAS 改名**

只改本 crate 与它的测试。不改 `conex-db` 的 `put_blob`。

```powershell
rg -n "fn put_blob|fn get_blob" crates/conex-workspace-store
# 无匹配
```

**WS-P4 · 验证**

```powershell
$env:CARGO_TARGET_DIR = "C:\Users\orange\conex-tgt\workspace-store"
cargo test -j 3 -p conex-workspace-store -p conex-fs
cargo clippy -j 3 -p conex-workspace-store --all-targets -- -D warnings
```

## f. 禁止的捷径

- 不把 mirror 的 rename 状态机留着，只在注释里写「以后改用 fs」。
- 不合并进 conex-db 的 CAS。
- 不加 `#[path]`。
- 不保留 `document_meta` 再导出。
- 不把未知 kind 同时保留 `"unknown"` 和空串两个行为。
- 门控非空不写。尤其不要改主仓库里脏的 `note_documents.rs`。

## g. 规范

clippy `-D warnings`。模块 ≤ 600。函数 ≤ 150。本方案不靠拆文件过线；过线的文件等 MP-P4。若 MP 已拆完仍超限，按域再拆目录，仍不准 `#[path]`。

## h. 测试集中点

只有 WS-P4。原子写测试断言崩溃后目标路径要么是旧内容要么是新内容，不出现被提前 rename 走的空窗（这是改用 ReplaceFileW 的原因）。kind 测试改成与 `BlockKind` 一致的期望，不删用例。

## i. 审计

核对别名模块消失、`put_blob` 不在本 crate、`cargo tree -p conex-workspace-store` 含 conex-fs、不含对 conex-db CAS 的新调用。

## j. 冲突与门控

| 对方 | 关系 |
|---|---|
| MP-P4 | 先做布局。本方案在新路径上改行为 |
| DB | 不改 `cas_gc`。只改本 crate 的方法名 |
| DC / NR | kind 字符串以 DC 的 `BlockKind` 为准。NR 删除自己的拷贝 |
| MD | 不改 parse 引擎 |
| FS | 使用 `atomic_write` 与 `WorkspaceWatcher`。缺的过滤参数加在 fs 的现有 API 上，且 `conex-fs` 该文件须干净 |

## k. 已决事项

| 项 | 结论 |
|---|---|
| 原子写 | 删除手写 rename，调用 conex-fs |
| CAS | 不并库。笔记方法改名，避免与会话 `put_blob` 冲突 |
| 别名 | 删除 `migrations` 与 `document_meta` |
| path | 归 MP-P4 |
| 过低版本 | 打开失败，不在每次 open 里补列 |
