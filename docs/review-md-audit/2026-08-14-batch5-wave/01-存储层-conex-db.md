# 存储层审计 · conex-db（审计波 BATCH-1~5，范围 9b53c40e 起含未提交）

> 审计 Agent：只读。审计模式：只针对自己（严格对照 `docs/agent-roles/review/review.md`，不参考外部软件）。
> 文件域（已提交 b84127c5..HEAD）：`crates/conex-db/src/` 的 lib.rs、schema.rs、agents.rs、agents_ops.rs、cas_gc.rs、group_commit.rs、lease_guard.rs、migrate.rs、migrate_steps.rs、reader_pool.rs、tests.rs、tests_cas_gc.rs、tests_concurrency.rs、tests_migrations.rs。
> 命令统一 pwsh7。区分「本会话真跑测」vs「源码形状判断」。

---

## ① 总判色

**黄（Yellow）**

拆分（agents→agents_ops、migrate→migrate_steps）质量好、测试语义强、无注水、无新增跳过、编译干净。扣分集中在「新存储层能力（组提交 / 读池 / CAS GC / 租约）**只有测试使用，无任何生产接线**」——构成半拆未接线 / 功能未装；叠加 `GcScanStats` 三字段恒 0 的误导统计、`group_commit` actor 无 panic 防护、GC 全表扫描且全程单锁、`blob_cas` 双 schema 定义 + 跨 crate 平行 CAS 实现等黄项。

---

## ② 逐发现项

### R-1（黄）存储层新模块全部「工具在库、产品未装」——半拆未接线 / 假交付风险

- **证据**：
  - `crates/conex-db/src/lib.rs:27,35`（`pub mod group_commit;` / `pub mod reader_pool;`）与 `lib.rs:24,31,45-57`（`pub mod cas_gc; pub mod lease_guard;` + re-export）。
  - `grep -rn "DbWriteHandle|ReaderPool|run_cas_gc|acquire_blob_lease|put_blob|cas_gc|group_commit|lease_guard" crates/orchestrator apps/` → **0 命中**。
  - 组提交/读池/GC/租约的引用**只存在于** `crates/conex-db/src/tests_concurrency.rs` 与 `tests_cas_gc.rs`（自测）。
  - `LocalDb` 实际仍以 `Arc<Mutex<Connection>>`（`lib.rs:68`）单连接串行化**所有**读写；`migrate.rs:107-110` 也仍走这条单锁路径。
- **缺陷机制**：commit `4dca50cb feat(storage): BATCH-2-00 implement atomic write, inflight guard, CAS GC and SQLite group commit with adaptive reader pool` 宣称「implement」的 L3/L4 架构（`CODE_MODIFICATION_SYSTEMIC_DISCIPLINE.md:76-77`：DbWriteActor 独占写通道 / ReaderPool 无阻塞读池）**未接到任何生产调用方**。产品仍用单 Mutex 串行化——「并发无阻塞」宣称对真实运行无效果。对比 `conex-workspace-store/src/cas.rs:1-17` 明确写了 `-S 骨架 ≠ GC 满关 ≠ 生产就绪` 的诚实边界，conex-db 侧 `cas_gc.rs` / `group_commit.rs` / `reader_pool.rs` **没有任何 `-S` / `≠ 生产接线` 边界声明**，却随 commit 宣称 implement——欠声明（真实未接线）与假关（误抬完成）必居其一。
- **修复建议**：a) 若本批目标是库层先行，必须在各模块文件头与 commit 补诚实边界（`≠ 生产接线 / ≠ 满关`）；b) 若声称存储改造完成，需把 `DbWriteHandle` / `ReaderPool` 接入 orchestrator 的真实读/写路径（或接入 `LocalDb`），否则删除/标记该能力为 un-wired。同 `review.md §5 半拆分未接线`、§15.2「工具在库、产品未装」。

### R-2（黄）`GcScanStats` 三字段恒 0——误导统计 / 假指标

- **证据**：`crates/conex-db/src/cas_gc.rs:576-584`
  ```rust
  Ok(GcScanStats {
      total_blobs_scanned: total_blobs_scanned as usize,
      reference_protected: 0,   // 恒 0
      lease_protected: 0,       // 恒 0
      pinned_protected: pinned_protected as usize,
      grace_protected: 0,       // 恒 0
      quarantined_hashes,
      purged_hashes,
  })
  ```
- **缺陷机制**：`GcScanStats`（`cas_gc.rs:77-86`）把 `reference_protected / lease_protected / grace_protected` 声明为真实计数并随 `LocalDb::run_cas_gc`（`cas_gc.rs:294`）公开返回，但实现从不统计——即使有 lease/reference/grace 保护，返回仍 0。消费方读这些字段会得到**确定错误**的结果。属「兜底/伪造统计值误导」（`review.md §6`、`§13`）。注：现有 `tests_cas_gc.rs` 只用 `quarantined/purged`，未断言这三个字段，故未暴露。
- **修复建议**：在 `mark_quarantine_orphans_conn` / `purge_expired_quarantined_conn` 内对 NOT IN 命中的已保护项计数，真实填回；或从 `GcScanStats` 删除未实现字段。切勿保留恒 0 的「语义占位」。

### R-3（黄）`group_commit` actor：写闭包 panic 永久杀死写通道，无 catch_unwind / 无重启

- **证据**：`crates/conex-db/src/group_commit.rs:236`（`process_batch(&mut conn, ...)` 在 `run_actor_loop` 同步调用）、`group_commit.rs:319`（`(task.op)(conn)` 直接执行用户闭包）、`group_commit.rs:110-117`（`tokio::spawn` 单任务）。
- **缺陷机制**：任何写闭包 panic（调用方逻辑 bug）会沿 async task 栈展开，`receiver` 与 `conn` 被 drop，`mpsc` 通道关闭。此后所有 `DbWriteHandle::write` 返回 `"Single writer actor channel is closed"`（`group_commit.rs:161-164`），**写路径在进程内永久死亡，无重启/恢复**。等待方拿到的是「通道关闭」错误而非 panic，故障被静默降级为可观测但不可自愈。违反 `review.md §6` 韧性、`CODE_MODIFICATION_SYSTEMIC_DISCIPLINE.md`「静默吞错」反向。
- **修复建议**：用 `std::panic::catch_unwind`（`AssertUnwindSafe`）包住 `(task.op)(conn)` 与批量事务；panic 时将该任务回 `Err`、继续 actor 循环，并在结构上提供 actor 重启/监督。

### R-4（黄）CAS GC 全表扫描 + 全程持单连接锁，且无生产调度器

- **证据**：`crates/conex-db/src/cas_gc.rs:482-526`（`mark_quarantine_orphans_conn` 两次全表 `NOT IN` 子查询 + 逐行 UPDATE）、`cas_gc.rs:528-565`（`purge_expired_quarantined_conn` 同样全表 + 逐行 DELETE）、`cas_gc.rs:294-300`（`run_cas_gc` 全程持有 `self.conn` 互斥锁）。
- **缺陷机制**：GC 运行期间**整个进程的读写（同 `LocalDb`）被同一把 `Mutex<Connection>` 阻塞**，`blob_cas` 越大扫描越慢——与「读池无阻塞」宣称矛盾；逐行 UPDATE/DELETE 非事务批处理，无批量 `IN` 优化。且整个 GC/lease 链**没有任何生产调度器调用**（配合 R-1）。7 天隔离 + 30 分钟租约的防护链仅存在于测试。
- **修复建议**：GC 需在专用写路径（`DbWriteHandle`）上、分批 LIMIT 扫描并限制单次持锁时长；或在没有生产消费者前，明确标注为未接线实验能力（见 R-1）。

### R-5（黄）`blob_cas` 双 schema 定义 + 跨 crate 平行 CAS 实现（重复实现）

- **证据**：
  - 同 crate 双 DDL：`crates/conex-db/src/schema.rs:275-330`（`create_v5_schema` 内含 blob_cas/block_attachments/…/active_blob_leases）**与** `schema.rs:334-392`（`create_cas_schema` 重复同样 6 张表 DDL）。
  - 跨 crate 平行实现：`crates/conex-workspace-store/src/cas.rs:24-28` 用 `sha2`/`hex` 的 `content_hash`；`crates/conex-db/src/cas_gc.rs:89-138` 手写 SHA-256 `compute_sha256_hex`。两处 `put_blob_conn` 写同一 `blob_cas` 表名：workspace-store 写 `created_at = strftime('%s','now')`（**epoch 秒 INTEGER**），conex-db 用 `DEFAULT (datetime('now'))`（**TEXT**）。
- **缺陷机制**：`review.md §17 dim 4` 重复实现 + `schema.rs` 双 DDL 双源漂移。两个 crate 各自定义同一表名不同列语义（尤其 `created_at` 格式），若未来共享库/迁移合并会直接冲突；workspace-store 侧 CAS 无 GC（其文件头已诚实 `≠ GC 满关`），而 conex-db 侧 GC 保护链无生产消费——两套都处于「有实现、无真收口」状态。
- **修复建议**：收敛到单一 SHA-256 实现（统一直用 `sha2` 或统一手写并共享）；`blob_cas` DDL 单一真源（删 `create_cas_schema` 或让它复用 `create_v5_schema` 的片段）；明确 workspace-store（workspace.db）与 conex-db（sessions.db）各自负责哪套 CAS，避免同表名双定义。

### R-6（黄）外置 `storage_type` blob 物理清除只删行不删文件

- **证据**：`crates/conex-db/src/cas_gc.rs:559-563`（purge 仅 `DELETE FROM blob_cas`）、`put_blob_with_options`（`cas_gc.rs:152`）允许 `storage_type`/`path` 外置文件。
- **缺陷机制**：若 `storage_type != "inline"` 且 `path` 指向外置文件，GC purge 删行后**磁盘文件泄漏**（孤儿文件永久残留）。当前无生产写外置类型，属设计缺口。
- **修复建议**：purge 对非 inline 行先删外置文件（原子：先 rename 到回收/临时再删），或文档明确外置类型不受 GC 管理。

### R-7（绿）内存 `BlobLeaseGuard` 与 GC 防护脱钩（设计断点）

- **证据**：`crates/conex-db/src/lease_guard.rs:51-120`（内存 `RwLock<HashMap>` 租约）、GC 只查 DB 表 `active_blob_leases`（`cas_gc.rs:503-505`）；`BlobLeaseGuard` 生产引用 0（仅 `tests_cas_gc.rs:150-158` 自测）。
- **缺陷机制**：若未来生产方只调用内存 `acquire_lease`（不落 `active_blob_leases` 表），GC 扫描不会识别该保护，会误隔离/清除正在上传的 blob。两套租约（内存 vs DB）无统一判定入口。
- **修复建议**：将内存 guard 作为 DB 租约的 read-through 缓存接入同一判定，或文档明确「GC 只认 `active_blob_leases` 表，内存 guard 须配合落表」；在接线前属无消费者断点。

### R-8（绿）`migrate.rs` 静默吞 `journal_mode=WAL` / `busy_timeout` 错误

- **证据**：`crates/conex-db/src/migrate.rs:110`：`let _ = conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");`
- **缺陷机制**：`journal_mode=WAL` 失败（如只读 FS / 并发占用）被 `let _` 静默吞掉，ReaderPool「WAL 无阻塞」前提悄悄丢失、退化为非 WAL；`busy_timeout=5000` 为内联魔术数字（未复用 `reader_pool::DEFAULT_SQLITE_BUSY_TIMEOUT_MS`）。违反 `review.md §6` 静默吞错。
- **修复建议**：`journal_mode` 返回非 `wal` 时 `tracing::warn!` 显式告警；`busy_timeout` 改为共享命名常量。

### R-9（绿）魔术数字 / 双常量 / 命名

- **证据**：`reader_pool.rs:22-26`（8 / 3000 / 5000 已命名）；`group_commit.rs:18-22`（5ms / 50 / 1024 已命名）；`lease_guard.rs:18-20`（`DEFAULT_LEASE_DURATION` Duration **与** `DEFAULT_LEASE_DURATION_SECS` i64 双常量同值 1800，有漂移风险）；`cas_gc.rs:23-25`（7 天 / 300 秒已命名）。整体命名良好，仅两处需收敛：`lease` 双常量、`migrate.rs:110` 内联 busy_timeout。

### 正面确认（拆分与测试）

- **拆分是真职责分离，非行数搬运**：`git diff b84127c5..HEAD -- agents.rs` 显示 `update_session_agent_status / update_session_agent_path / upsert_session_agent` 从 `agents.rs:282-408` 原样移除，`agents.rs` 线数 494→404、`agents_ops.rs` 新增 513（其中约 425 行为独立 `mod tests`）；`map_agent_row` 提升为 `pub(crate)` 供 `agents_ops.rs` 复用（`agents.rs:15`）——共享真源，无双份查询口径。`migrate.rs` 433→195，DDL 步骤移至 `migrate_steps.rs`（425）。
- **测试语义强，无注水**：`tests_cas_gc.rs` / `tests_concurrency.rs` / `tests_migrations.rs` 均为值/状态/内容相等断言（如 `tests_cas_gc.rs:236` `assert_eq!(purged_hashes, vec![h])`、`tests_concurrency.rs:497` 写总数相等、`agents_ops.rs` kill/spawn 交错 `assert_eq!(rows.len(),3)`），无 `assert!(true)`、无 `as any`、无快乐路径独占（含缺行、语法错误隔离、租约释放、7 天隔离、反隔离自愈、幂等重跑等失败/边界分支）。`tests_cas_gc.rs:18-31` 含 SHA-256 已知向量（空串/hello/自定义）。
- **无新增跳过**：全 crate 无新 `#[ignore]`；3 个 `#[ignore]`（`tests/stress_write.rs:109,144,220`）为既有基线（最后改动 commit d46f42c1，早于本批基址 b84127c5）。
- **依赖无冗余**：`Cargo.toml` 依赖（rusqlite/serde/serde_json/tracing/conex-types/agent-tools/tokio）均有真实引用；`cargo check -p conex-db --all-targets` 零警告零错误。

---

## ③ 真跑测试清单（本会话实际执行，非源码形状判断）

| 命令                             | 退出码 | 结果                                  | 断言/用例数                                                                                             |
| -------------------------------- | ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `cargo test -p conex-db`（全量） | 0      | 全绿                                  | lib 单元 **99 passed**；4 passed；2 passed；17 passed；16 passed；upgrade_e2e **5 passed**；doc-tests 0 |
| 其中 `tests/stress_write.rs`     | 0      | 3 **ignored**（既有基线，本批未新增） | 0 passed / 3 ignored                                                                                    |

汇总：**143 passed / 0 failed / 0 measured**；3 ignored 均为既有 `#[ignore]` 基准压测（非本批引入）。`cargo check -p conex-db --all-targets` 0 warning / 0 error。

> 注：`run_cas_gc` 的恒 0 统计（R-2）未被现有测试覆盖，故测试绿不能证明其正确——与「源码形状判断」区分。

---

## ④ SD / CONN 债建议

- **SD-1（建议新 SD 包）**：存储层「接线/诚实边界」收口——`group_commit` / `reader_pool` / `cas_gc` / `lease_guard` 四模块现状为「库有产品零装」（`review.md §15.2` 半连通形态「工具在库、产品未装」）。二选一落地：接入 orchestrator 真读写路径（`DbWriteActor` 替代 `LocalDb` 单 Mutex 写、`ReaderPool` 替代读），或全部标注 `-S / ≠ 生产接线` 并撤回「implement」叙事。对应 R-1。
- **SD-2**：`cas_gc.rs` 566 行（含手写 SHA-256 约 50 行 + 15 个 LocalDb 方法 + 连接级实现）超 `review.md §1` 400 行门槛，且与 `schema.rs` 双 DDL、`conex-workspace-store/src/cas.rs` 平行实现纠缠——建议拆「blob CRUD」与「GC 扫描」两域、收敛单一 SHA-256 与单一 `blob_cas` DDL 真源。对应 R-5、§17 dim 4 重复实现。
- **SD-3**：GC 批处理与统计真实性——`mark/purge` 改批量 LIMIT + 单事务，`GcScanStats` 三恒 0 字段补齐或删除。对应 R-2、R-4。
- **CONN-1**：CAS 附件全链连通性（put/link/get + GC + 租约 + 反隔离自愈）缺一个**端到端集成测**——从「生产入口 → 附件上传 → 后台 GC → 恢复/Undo → 物理清除」走真实调用面，而不是仅模块内自测。当前所有 GC/租约测试均直接调 `LocalDb`（`tests_cas_gc.rs`），无 orchestrator 级集成，无法验证 R-1 的接线断点。

---

_审计结论：黄。存储层代码质量与测试扎实，但「新并发/GC 能力零生产接线」是最大结构债（R-1），叠加误导统计（R-2）与若干韧性/一致性缺口。_
