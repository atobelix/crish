# DB · conex-db 写读面、缺表失败、CAS 命名

> **给执行 AI 的硬性规则**
> 1. 彻底改进：一种写路径、一种读路径；旧库要么一次迁完，要么打开失败。不留降级缓存和双写锁。
> 2. 禁止作弊：不加 `allow` / `#[ignore]`；不调基线、不放宽行数阈值；不删测试、不弱化断言。
> 3. 阶段提交：`refactor(DB-P<n>): <摘要> [BATCH-CONEX-DB]`，无 BOM。测试只在 DB-P4。
> 4. 只在 worktree。不 stash、不 push、不动主仓库脏文件。
> 5. 进度写 worktree 同目录 `conex-db.progress.md`，不写主仓库，不写审查目录的 `plans\`。
> 6. `RUSTUP_TOOLCHAIN=1.99.1`。验证前不跑 cargo。
> 7. 行号是快照。开工用 §e 的 `rg` 重定位。

| 项 | 值 |
|---|---|
| 代号 | DB |
| 分支 | `refactor/conex-db` |
| worktree | `C:\Users\orange\rf-db` |
| 批次标签 | `[BATCH-CONEX-DB]` |
| 波次 | W5。整 crate 在写 |

## a. 范围与门控

`crates/conex-db`。trait 下沉时允许改 `crates/conex-types`（或 `conex-shared`，见 k）里的新模块，以及 agent-tools / conex-run 里**仅**配额 trait 的路径。`get_run` 归 TD，本方案只交叉引用。

**门控 G-DB**：`git -C C:\Software\conex status --porcelain -- crates/conex-db` 为空。编写时 `explore_docs_quota_store.rs`、`group_commit.rs`、`lib.rs`、`messages.rs`、`migrate.rs`、`migrate_steps.rs`、`sessions/mod.rs`、`sessions/orphan.rs`、`usage_analytics.rs` 等为未提交修改，**未满足**。

另外：DB-P3 会改 `apps/agent-workbench/src-tauri/src/usage_commands.rs` 对 `import_legacy_usage_snapshot` 的调用。该文件所在树在写。P3 单独门控：`git status --porcelain -- apps/agent-workbench/src-tauri/src/usage_commands.rs crates/conex-db/src/usage_analytics.rs` 为空。失败则 P3 不做，不留双 API。

不碰：`runs.rs` 的 `get_run`（注释写「persist.rs 测试用」，TD-P4 / D7）。`blocks.rs` / `runs.rs` 里的毫秒时钟（TM-P4）——拆文件时整函数搬家，不改写。`#[path]` 本 crate 不在 MP 清单里，不要为了拆文件新加 `#[path]`。

## b. 问题表

| ID | 状态 | 符号 | 已跑的 rg |
|---|---|---|---|
| DB-01 | **仍存在** | `cas_gc.rs`、`group_commit.rs`、`agents_ops.rs`、`usage_analytics.rs`、`blocks.rs`、`reader_pool.rs`、`migrate_steps.rs`、`events.rs` 超过 MOD 600。基线挂账 | 开工用 `(Get-Content <file>).Count`，禁止靠改基线过门 |
| DB-02 | **仍存在** | `LocalDb::put_blob` / `get_blob` / `link_block_attachment` 在 `cas_gc.rs`；`WorkspaceStore` 同名方法在 `conex-workspace-store/src/cas.rs`，文件头写明「≠ 生产 / ≠ GC」。两套都没有壳层生产调用，只有各自测试 | `rg -n "fn put_blob\|fn link_block_attachment" crates/conex-db/src/cas_gc.rs crates/conex-workspace-store/src/cas.rs` |
| DB-03 | **仍存在** | `import_legacy_usage_snapshot`（`usage_analytics.rs`），壳 `usage_commands.rs` 仍调用。标记键 `legacy_usage_migrated_v10` | `rg -n "import_legacy_usage_snapshot" -g "*.rs"` |
| DB-04 | **仍存在** | `LocalDb` 同时持 `writer: DbWriteHandle` 与主 `conn`。`write_blocking` 走 writer；`blocks.rs` / `runs.rs` / `imported.rs` / `migrate.rs` 仍 `self.conn.lock()` | `rg -n "self\.conn\.lock\(\)" crates/conex-db/src -g "*.rs"` |
| DB-05 | **仍存在** | `sessions/orphan.rs` 把常量片段 `protected` 和动态 `IN` 占位插进 `format!`。占位值经参数绑定，当前没有用户列名 | `rg -n "format!\(.*protected" crates/conex-db/src/sessions/orphan.rs` |
| DB-06 | **仍存在** | `compression_blocks_present` / `imported_tables_present` 缺表时告警并返回空。`blocks.rs` `warn_missing_blocks_table` | `rg -n "fn compression_blocks_present\|fn warn_missing" crates/conex-db/src -g "*.rs"` |
| DB-07 | **仍存在** | `Cargo.toml` 生产依赖 `agent-tools`，为实现 `ExploreDocsQuotaStore`。注释承认环靠 dev 边合理化 | `rg -n "agent-tools" crates/conex-db/Cargo.toml` |
| DB-08 | **仍存在** | `src/tests*`、`tests_migrations`、`tests/*.rs` 三套布局；`tests/migrations.rs` 巨石 | 目录列举即可 |
| D7 `get_run` | **归 TD** | `runs.rs` `get_run` 注释「persist.rs 测试用」 | `rg -n "fn get_run" crates/conex-db/src/runs.rs` |

## c. 目标架构

1. 写只经过 `DbWriteHandle::write_blocking`（或域方法已经包好的那一层）。读只经过 `ReaderPool`。`LocalDb.conn` 改为 crate 私有，且生产域方法不得再锁它。迁移在 open 的单线程阶段用 writer 跑完，不留第二把业务锁。
2. 打开数据库：`user_version` 低于代码能迁移的最小版本 → 返回错误，提示用离线工具。能迁移的版本跑 `migrate_steps` 一次。缺 `compression_blocks` 或导入表 = 迁移失败，删除 `*_present` 缓存和「返回空集」分支。
3. CAS 不合并库。会话附件与 GC 留在 conex-db，方法名保持 `put_blob`（会话库语义）。笔记附件留在 workspace-store，由 WS 改名（本方案不改 workspace-store 的文件，只在 progress 写「等待 WS 改名」）。禁止把笔记 blob 写入 sessions 库，也禁止把 `cas_gc` 搬进 workspace。
4. 配额 trait `ExploreDocsQuotaStore` 及快照/解析函数移到 `conex-types`（conex-types 已是 db 与 agent-tools 的共同下层；不要放进 conex-shared，避免 shared 再被业务类型撑大）。conex-db 实现 trait，agent-tools 依赖 conex-types 而不是反过来。生产 `Cargo.toml` 去掉 `agent-tools`。
5. `import_legacy_usage_snapshot` 在 P3 门控通过后删除。存量导入改由一次性离线调用（若壳仍需按钮，按钮直接执行与现在相同的 SQL，然后随壳的后续清理删除；本方案不在 db 保留永久 API）。若 P3 门控失败，函数保持原样，不加成 feature 开关。
6. 孤儿清理：`protected` SQL 变成文件内 `const`，用 `include` 进查询字面量，禁止 `format!` 拼这段。`active_ids` 写入临时表 `orphan_keep(id)`，查询 `NOT EXISTS`，删除动态 `IN` 占位。
7. 上帝文件按域拆目录，每文件 ≤600。基线条目只删。除 §c.2 与 §c.6 外不改 SQL 结果。

| 旧文件 | 拆成 | 不变量 |
|---|---|---|
| `cas_gc.rs` | `cas/blob.rs`（put/get/link）、`cas/gc.rs`（隔离与清扫）、`cas/scan.rs`（引用扫描） | 读路径仍禁止 `write_blocking` |
| `group_commit.rs` | `writer/handle.rs`、`writer/batch.rs`、`writer/thread.rs` | 对外仍是 `DbWriteHandle` 与 `write_blocking` |
| `agents_ops.rs` | `agents/crud.rs`、`agents/query.rs` | 不改表名 |
| `usage_analytics.rs` | `usage/query.rs`、`usage/write.rs` | P3 前导入函数原样待在 `write.rs` |
| `blocks.rs` | `blocks/row.rs`、`blocks/search.rs` | 时钟函数整段搬家 |
| `reader_pool.rs` | `reader/pool.rs`、`reader/conn.rs` | 读 API 名字不变 |
| `migrate_steps.rs` | `migrate/v6.rs` … 按现有 `vN` 函数边界 | 不重排已发布版本号 |
| `events.rs` | `events/append.rs`、`events/read.rs` | 不改事件 JSON |

`sessions/orphan.rs` 只改 SQL 拼法，不因为行数再拆。`runs.rs` 的 `get_run` 若随文件拆动，函数体一个字不改。

## d. 删除清单

- `compression_blocks_present`、`imported_tables_present`、`warn_missing_blocks_table`、`warn_missing_imported_tables` 及所有「缺表则 return Ok(空)」分支。
- 生产代码里的 `self.conn.lock()`（测试若直接检查 SQL，改为公开的只读方法或 `ReaderPool`，不把 `conn` 重新 `pub`）。
- P3 成功时：`import_legacy_usage_snapshot` 与壳上的调用。不留 `deprecated` 别名。
- `format!` 拼接 `protected` 的两处（SELECT 与 DELETE）。
- 拆完后空文件。不留 `pub use` 旧模块路径；调用点改新路径。
- 不删 `get_run`。不删 `cas_gc` 的 GC 行为测试。

## e. 分阶段与探针

**DB-P0**  
G-DB 为空才继续。

**DB-P1 · 打开失败与孤儿 SQL**  
§c.2、§c.6。补测试：缺表的库 `open` 返回错误；临时表路径与旧 `IN` 列表删同一组行（用现有 orphan 测试改断言，不删用例）。  
探针：`rg -n "compression_blocks_present|imported_tables_present|warn_missing" crates/conex-db/src -g "*.rs"` → 0。`rg -n "format!\(" crates/conex-db/src/sessions/orphan.rs` 不再包含 `protected`。

**DB-P2 · 单写单读 + 拆文件 + 配额 trait**  
§c.1、§c.4、§c.7。  
探针：`rg -n "self\.conn\.lock\(\)" crates/conex-db/src -g "*.rs"` → 0（`src/tests` 若仍锁，改为 0 才算过；测试走只读 API）。`rg -n "agent-tools" crates/conex-db/Cargo.toml` 的 `[dependencies]` 段为 0，dev-dependencies 若测试仍需要工具类型才允许保留并在 progress 说明。`rg -n "trait ExploreDocsQuotaStore" crates` 只命中 conex-types。超 600 的旧路径基线条目在 diff 里是删除。

**DB-P3 · 用量旧导入（单独门控）**  
门控失败则跳过，progress 写明。成功则删 API，壳改掉调用；若没有离线工具的落点（壳文件不能改），本阶段取消，不部分删除。  
探针：`rg -n "import_legacy_usage_snapshot" -g "*.rs"` → 0。

**DB-P4 · 测试布局与验证**  
`src/tests*`、`tests_migrations` 移到 `tests/`，按迁移版本分文件。`migrations.rs` 巨石按版本切开，断言不改。然后 §h。  
探针：`rg --files crates/conex-db/src -g "*test*"` 为空。

## f. 禁止捷径

不把缺表降级改成 `allow` 日志后继续。不把 `conn` 改成 `pub(crate)` 又在五个文件里锁。不用 `#[path]` 拆 `cas_gc.rs`。不把两套 CAS 合成一个 crate。不删除 `get_run`（TD）。不在 P3 门控失败时加 `cfg` 双实现。不调 `check-conex-db-size` / `check-crate-size` 基线，只允许删除已拆掉的路径条目。

## g. 规范

workspace lints，clippy `-D warnings`。SQL 只用参数绑定或本文件 `const` 片段。新依赖不允许；配额 trait 移动不增加 crate。函数 ≤150 行。

## h. 测试

```powershell
$env:RUSTUP_TOOLCHAIN="1.99.1"
$env:CARGO_TARGET_DIR="C:\Users\orange\conex-tgt\db"
cargo clippy -j 3 -p conex-db -p agent-tools -p conex-run --all-targets -- -D warnings
cargo test -j 3 -p conex-db -p agent-tools -p conex-run
node scripts/check-crate-size.mjs
```

必须仍绿：`tests_cas_gc`、`orphan_grace_contract`、迁移升级测试。新增：构造缺 `compression_blocks` 的文件，`open` 为 Err。`get_run` 的现有测试保持，留给 TD 搬 `cfg`。

## i. 审计

- [ ] G-DB 与 P3 门控原文
- [ ] 基线 diff 无新增路径、无数值上升
- [ ] `git diff -U0 | rg "^\+.*#\[allow|^\+.*#\[path"` → 0
- [ ] `get_run` 仍在，签名不变
- [ ] 生产依赖树无 conex-db → agent-tools（`cargo tree -p conex-db --no-dev-dependencies` 贴进 progress）
- [ ] 删除的断言都有「随缺表降级分支删除」或等价更严断言

## j. 冲突与门控

与 TM-P4 共享 `blocks.rs`、`runs.rs`：DB 先拆目录的话，TM 改新路径上的时钟函数；不要并行。与 TD-P4 共享 `runs.rs` 的 `get_run`：本方案移动文件时保持函数原文。与 AT 的产出目录 store：AT 实现放在 conex-run，不往本 crate 加 `OutputDirStore`。与 WS 的 CAS 改名：本方案不编辑 workspace-store。src-tauri 用量命令在写则跳过 P3。

## k. 已决

- 两套 CAS 不合并。会话库保留 GC；笔记库不接收 sessions blob。改名由 WS 执行。
- 配额 trait 放 `conex-types`，不放 `conex-shared`。
- 缺表即打开失败，不保留运行期探测。
- `get_run` 不在本方案门控或移动到 `cfg`。
- P3 不能安全落地就整段取消，不留永久导入 API 的第二开关。
- 无待决项。若开工时 `self.conn.lock()` 已为 0，P2 只做拆文件与 trait，progress 记录。
