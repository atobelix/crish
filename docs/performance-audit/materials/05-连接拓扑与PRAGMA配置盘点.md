# 05-素材：SQLite 连接拓扑与 PRAGMA 配置盘点

> 日期：2026-09-12 · 方向 05 · 只读静态走读

## 1. LocalDb 打开时的连接拓扑

`LocalDb::open`（`crates/conex-db/src/lib.rs:113-156`）打开 **最多 10 个** SQLite 连接：

| 槽位 | 用途 | 打开方式 | 生产写路径是否使用 |
| ---- | ---- | -------- | ------------------ |
| 主连接 `conn: Arc<Mutex<Connection>>` | 几乎全部域方法（events/sessions/runs/messages/blocks/…） | `Connection::open` | **是（全部）** |
| 写 Actor `writer: DbWriteHandle` | 组提交管道（5ms/50-item） | 独占 `write_conn` + 后台任务 | **否**（仅测试/压力测使用） |
| ReaderPool（默认 8 槽） | `LocalDb::read` / `read_async` 优先路径 | `SQLITE_OPEN_READ_ONLY \| URI \| NO_MUTEX` | 仅部分读方法 |

证据：

```113:156:crates/conex-db/src/lib.rs
pub fn open(path: impl AsRef<Path>) -> Result<Self, DbFailure> {
    let path_ref = path.as_ref();
    let conn = Connection::open(path_ref)...
    let _ = conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
    );
    let write_conn = Connection::open(path_ref)...
    let writer = DbWriteHandle::spawn(write_conn, GroupCommitConfig::default());
    let reader_pool = match ReaderPool::open(path_ref, ReaderPoolConfig::default()) { ... };
```

## 2. PRAGMA 清单

| PRAGMA | 主连接 | write_conn | ReaderPool | 备注 |
| ------ | ------ | ---------- | ---------- | ---- |
| journal_mode=WAL | ✅ | ✅ | 隐式（文件已是 WAL） | `lib.rs:122-123,131-132` |
| synchronous=NORMAL | ✅ | ✅ | ✅ custom_pragmas | `lib.rs:123` / `reader_pool.rs:49` |
| busy_timeout=5000 | ✅（API+PRAGMA 双设） | ✅ | ✅ | `lib.rs:119,123,130,132` |
| foreign_keys=ON | **仅 migrate() 会话内** | **未设** | **未设** | `migrate.rs:109`；write_conn 无 FK → 组提交若启用则 FK 约束不生效 |
| cache_size | **未设**（SQLite 默认 -2000） | 未设 | `-2000`（≈2MB 页缓存） | `reader_pool.rs:50` |
| mmap_size | **全链未设** | — | — | — |
| temp_store | — | — | MEMORY | `reader_pool.rs:51` |
| query_only | — | — | ON | `reader_pool.rs:48` |
| wal_autocheckpoint | 未显式配置（默认 1000 页） | — | — | — |

## 3. group_commit 是否真正启用

- **实现完整**：`group_commit.rs` 提供 5ms/50-item 窗口、SAVEPOINT 隔离、单条快速路径、panic 隔离、stats。
- **生产零调用**：`LocalDb::write` / `db.writer().write` 在 `apps/agent-workbench/src-tauri` 与 `crates/orchestrator` 生产路径中 **零命中**；仅 `tests_concurrency.rs`、`stress_*.rs` 使用。
- **域方法全部旁路**：`append_event` / `save_session_body` / `upsert_session_entry` / `insert_run` / `update_run_status` / `reserve_sequence` / `set_session_meta` / blocks / cas_gc / lease / import / agents 全部 `self.conn.lock()` 直写主连接（events.rs:21、sessions.rs:16、runs.rs:120、messages.rs:55 等 100+ 处）。

**结论：组提交管道是「已建未接线」的基础设施；生产写仍走 Mutex 串行 + 自动提交事务。**

## 4. 单语句自动提交与显式事务分布

| 方法 | 事务边界 | 说明 |
| ---- | -------- | ---- |
| append_event | 无显式 tx（单 INSERT 自动提交） | `events.rs:26-31` |
| reserve_sequence | **3 条语句各自自动提交** | INSERT OR IGNORE + SELECT + UPDATE，`events.rs:207-226` |
| save_session_body | 显式 transaction | DELETE + N×INSERT，`messages.rs:60-99` |
| save_session_agents | 显式 transaction | DELETE 级联 + 重插，`agents.rs:199+` |
| insert_run / update_run_status | 无显式 tx | 每次 1 次 UPDATE/INSERT |
| touch_session / set_session_meta | 无显式 tx | 每次 1 次写 |
| import_bookmarks / import_history | 每 1000 条一 tx | `imported.rs:125-167` |
| import_from_localstorage | 单大事务全量 | `import.rs:40-42` |
| cleanup_orphan_sessions | 显式 transaction | 含前后 COUNT(*) 对比 |

## 5. ReaderPool 旁路清单（读仍持主 Mutex）

下列读方法 **未走** `self.read()`，仍 `self.conn.lock()`：

- 全部 events 读：`query_events` / `query_events_by_run` / `query_events_by_type` / `max_sequence`（events.rs:46,94,136,163）
- 全部 runs 读：`get_run` / `get_run_usage` / `query_all_runs` / `load_pending_inputs`（runs.rs:169,227,294,337）
- blocks 全部读（blocks.rs:115,252,282,310,330）
- cas_gc / lease / preferences 写侧以外的 get_blob 等（cas_gc.rs:135+、lease_guard.rs:132+）
- usage_analytics 写与 dashboard（usage_analytics.rs:191,233,249,349）

已走 ReaderPool：`list_sessions`、`get_session_meta`、`load_session_body`、`load_session_agents*`、`get_preference`、`list_preferences`。

## 6. 触发器写放大

`session_messages` 上有 insert/delete 触发器各更新 `sessions.message_count`（schema.rs:262-272）。`save_session_body` 先 DELETE 再 N 次 INSERT：

- DELETE 段：N 次 trigger UPDATE sessions
- INSERT 段：N 次 trigger UPDATE sessions  
→ 1000 条消息会话 = 2000 次 sessions 行 UPDATE + 全表 DELETE/INSERT。
