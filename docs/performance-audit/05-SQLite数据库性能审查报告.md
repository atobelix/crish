# 05-SQLite 数据库性能审查报告

> **战役**：全面性能审查（performance-audit），方向 05 / 共 16 方向
> **总纲**：`docs/performance-audit/00-性能审查总纲.md`
> **日期**：2026-09-12
> **检查对象**：`crates/conex-db/` 全量（schema / events / messages / sessions / blocks / runs / group_commit / reader_pool / cas_gc / lease_guard / migrate / import / usage_analytics / preferences / agents）+ 调用方（orchestrator persist、session_commands、shell）
> **方法**：静态代码走读 + 全仓 PRAGMA/open 扫描 + 调用链交叉验证；全部结论带 `文件路径:行号`；未实测项在 §8 单列。
> **与 03 的关系**：03 报告 I1（save_session_body 先删后插+CAS 丢弃）、I4（query_all_runs 全表）、R3（NoPersist 白付取号）已覆盖 IPC/命令面表象；本文聚焦 **DB 内核接线与 schema/查询** 侧根因，交叉引用不重复展开。

---

## 0. 阅读指南

- 编号规则：**S**=Schema/连接配置、**W**=写路径、**Q**=查询/索引、**R**=读路径/恢复、**G**=GC/迁移/导入。
- 严重度：**高**=热路径写放大或全局锁串行化随会话规模线性恶化为用户可感知卡顿；**中**=固定场景可测量浪费或架构旁路；**低**=局部开销/隐患。
- 每条问题统一模板：**位置 → 现象 → 代码现场 → 调用链与触发时机 → 根因 → 影响量化 → 修复方案 → 回归风险与测试锚点**。
- 正面发现（§3）是已验证防线，禁止回潮。

## 1. 执行摘要

**一句话结论：conex-db 的 schema 设计（WAL + WITHOUT ROWID + 复合主键 + 时序索引）与基础设施（ReaderPool 8 槽、Group Commit 5ms/50-item、迁移幂等链）明显优于平均水平，但生产写路径几乎全部旁路组提交 Actor——所有域写仍经单一 `Mutex<Connection>` 串行执行；叠加 `save_session_body` 先删后插 + 双触发器 message_count 写放大，以及 `reserve_sequence` 三连自动提交，构成 DB 侧三个结构性热点。**

- **连接拓扑（S1）**：`open()` 建 1 主连接 + 1 组提交写连接 + 8 只读池（共 10 连接）；组提交写连接在生产中 **零调用**——`append_event` / `save_session_body` / `upsert_session_entry` 等 100+ 域方法全部 `self.conn.lock()` 直写主连接。
- **写放大（W1/W2）**：`save_session_body` 全表 DELETE + 逐条 INSERT + 双触发器各 N 次 `UPDATE sessions`；`reserve_sequence` 三条语句各自自动提交（3×fsync 级别成本，WAL 下仍多轮写日志）。
- **读旁路（R1）**：events / runs / blocks / usage 全部读持主 Mutex，与写互相阻塞；ReaderPool 仅覆盖 `load_session_body` / `list_sessions` / agents / preferences 部分读。
- **PRAGMA 缺口（S2）**：主/写连接无 `cache_size` / `mmap_size` 调优；`foreign_keys=ON` 仅在 migrate 会话内对主连接设置一次，组提交写连接 **从未开 FK**。
- **架构债（G1）**：v3→v4 事件表重建在大库启动时全表拷贝；CAS GC 全程持主锁 + 4×NOT IN 反连接。

**发现计数**：6 高（S1 W1 W2 R1 Q1 G2）/ 14 中 / 12 低，共 **32** 项问题条目；另 3 项与 03/07 的交叉登记（§5）。

**修复性价比最高**：批次 **A**（域写统一改道 `db.write()` 组提交 + FK/PRAGMA 对齐）——单点接线即可消化 100+ 串行写点。

## 2. 检查范围与方法

### 2.1 对象与规模

| 维度 | 数值 |
| ---- | ---- |
| conex-db 源文件 | 35 个 .rs（含 tests/benches） |
| schema 版本 | LATEST=11（v1→v11 迁移链） |
| 域表 | sessions / events / runs / pending_inputs / session_messages / session_agents / session_agent_messages / session_sequence / session_meta / compression_blocks / imported_* / usage_records / app_preferences / blob_cas / 附件引用表 / active_blob_leases |
| 打开连接 | 主 1 + 写 Actor 1 + 读者 8（文件库） |
| 组提交默认 | 5ms 窗口 / 50 条上限 / 通道 1024 |

### 2.2 四路检查

| 路 | 主题 | 覆盖面 |
| -- | ---- | ------ |
| A | 连接与 PRAGMA | `open` / `open_in_memory` / ReaderPool 默认 PRAGMA / migrate 内 PRAGMA / foreign_keys / cache_size / mmap 全仓 grep |
| B | 写路径 | events append/reserve、messages save、sessions upsert、runs、blocks、agents、import、usage insert、cas/lease 写；group_commit 调用面全仓 grep |
| C | 查询与索引 | schema DDL 索引清单 vs 高频 WHERE；query_* 方法 SQL 走读；N+1；SELECT 列裁剪 |
| D | 迁移 / GC / 恢复 | migrate 链、backup 时序、cas_gc 循环、lease、import 分批、restore 事件分页 |

### 2.3 证据链示例（组提交未接线）

```text
LocalDb::open
  → DbWriteHandle::spawn(write_conn)          // lib.rs:134 —— Actor 已启动
  → 但 append_event:
       conn = self.conn.lock()                // events.rs:21 —— 主 Mutex，非 writer
       conn.execute("INSERT INTO events ...") // 自动提交
  → 全仓生产路径 db.write( / writer().write 命中数 = 0（orchestrator persist / session_commands / run_*）
  → 仅 tests_concurrency.rs / stress_*.rs 调用 writer
```

## 3. 正面发现（禁止回潮）

| # | 设计 | 证据 |
| - | ---- | ---- |
| P1 | **WAL + synchronous=NORMAL + busy_timeout=5000** 打开即设——桌面单机最优默认组合 | `lib.rs:121-133` |
| P2 | **events 复合主键 (session_id, sequence) WITHOUT ROWID**——会话内顺序扫描无 B-tree 额外跳转，PK 即覆盖索引 | `schema.rs:146-155` |
| P3 | **idx_events_run(session_id, run_id, sequence)**——按 run 过滤 SQL 下推 O(log n) | `migrate_steps.rs:417-420`、`events.rs:81-126` |
| P4 | **session_messages / runs / pending 等热表 WITHOUT ROWID**；PK 与查询谓词对齐 | `schema.rs:157-212` |
| P5 | **max_sequence / query_events_by_type SQL 下推**（1C-1/1C-2）——恢复路径不再全量加载内存 max | `events.rs:129-197` |
| P6 | **query_events 分页 limit 下推**（DM-07）——默认 200/上限 1000 消灭无界读 | `events.rs:38-55`；交叉 03 P7 |
| P7 | **ReaderPool 8 槽 try_lock 自适应探测** + async 让渡——架构正确，已覆盖 body/agents/sessions 列表读 | `reader_pool.rs:205-340`、`lib.rs:223-264` |
| P8 | **Group Commit 实现完备**（5ms/50、SAVEPOINT 隔离、panic 隔离、stats、专用线程）——接线即可用，无实现债 | `group_commit.rs:1-396` + `tests_concurrency.rs` |
| P9 | **迁移链逐版本事务 + user_version 原子 + DROP 前 checkpoint(TRUNCATE) 备份**——崩溃安全与幂等 col-check | `migrate.rs:150-214`、`migrate_steps.rs` |
| P10 | **孤儿清理宽限期 + 引擎会话/活动 run/pending 豁免**——正确性护栏完整（非性能正面，防误删） | `sessions.rs:211-316` |
| P11 | **浏览器导入 1000 条/批事务 + INSERT OR IGNORE 幂等**——长导入不持长锁 | `imported.rs:19-20,125-167` |
| P12 | **usage_records 4 组时序复合索引**（v10）——时间范围查询可走索引 | `migrate_steps.rs:441-465` |
| P13 | **CAS 两阶段软删 + 内存租约快路径**——GC 语义安全优先于吞吐（设计正确） | `cas_gc.rs:1-17`、`lease_guard.rs:49-119` |
| P14 | **显式列 SELECT（无 SELECT \*）**——events/messages/agents 均列裁剪 | 全模块 |

## 4. 问题清单

### 4.1 连接与配置域（S）

---

#### S1.【高】组提交写 Actor 已启动但生产写路径零接线——全部域写串行在主 Mutex 上

- **位置**：`crates/conex-db/src/lib.rs:134`（spawn）；`lib.rs:214-221`（`write()` API）；各域 `self.conn.lock()`（events.rs:21、sessions.rs:16,38,163、runs.rs:120,150、messages.rs:55、blocks.rs:153、agents.rs:194、preferences.rs:67、usage_analytics.rs:191、cas_gc.rs:125、lease_guard.rs:132、import.rs:35、imported.rs:120…）
- **现象**：`DbWriteHandle::spawn` 在 `open` 时创建独占写连接与 5ms/50 聚合 Actor，但生产代码从不调用 `LocalDb::write` / `writer().write`。组提交管道空转，额外占用一条文件连接与一个后台任务。
- **代码现场**：

```rust
// lib.rs:134 —— Actor 已启动
let writer = DbWriteHandle::spawn(write_conn, GroupCommitConfig::default());

// events.rs:21-31 —— 实际写路径绕过 writer
let conn = self.conn.lock()...?;
conn.execute("INSERT INTO events ...", ...)?;

// 全仓生产：orchestrator/persist.rs 全部 blocking_db_call → db.append_event
// apps/.../session_commands.rs: db.save_session_body / list_sessions
// 命中 db.write( / writer().write 的生产调用：0
```

- **调用链与触发时机**：每一次事件落库、run 状态更新、会话 touch、偏好写入、CAS blob 写入都持全局主 Mutex；多会话并行 run / 后台任务 / usage 插入与前端 `save_session_body` 在同一把锁上排队。
- **根因**：架构演进中「引入组提交 Actor」与「域方法保持同步 API」两层并存；域方法为兼容既有 `blocking_db_call` 签名继续锁主连接，未切换到 `write(async)`。
- **影响量化**：
  - 写延迟：每次写至少一次 Mutex 持有 + 自动提交；无法把多条 INSERT 合并为单次 COMMIT。
  - 典型场景：3 个并行 run 各自收口期每 run 5–20 次 `update_run_status`/`append_event`/`save_run_usage`/`touch_session` → 与另一个会话的 `save_session_body`（见 W1）串行，收口抖动叠加。
  - 资源：1 条永远等不到任务的 write_conn + 1 个空转 Actor 线程。
- **修复方案**：
  1. 提供 `LocalDb::write_sync`（或在 `blocking_db_call` 内改为 `writer` 端 oneshot 等待）——把域写改道组提交，**对外同步 API 可保持**。
  2. 迁移优先级最高的写点：`append_event` + `reserve_sequence`（合并为一次批）→ `update_run_status`/`save_run_usage` → `upsert_session_entry`/`touch_session` → `save_session_body`。
  3. 组提交 Actor 连接在 spawn 前补 `PRAGMA foreign_keys=ON`（见 S2）。
  4. 压力测继续用 `stress_empirical_concurrency` 验证 stats.total_batches / max_batch_size_seen。
- **回归风险与测试锚点**：事务边界（SAVEPOINT 已覆盖单项失败）；与主 Mutex 读路径的死锁（读走 ReaderPool 即可避免）；`tests_concurrency.rs` 组提交用例扩到域方法冒烟；e2e 恢复/导入回归。

---

#### S2.【中高】组提交写连接与读者连接未开 foreign_keys；主连接 FK 仅 migrate 会话内设置

- **位置**：`lib.rs:115-133`（open 三连接 PRAGMA 批 **不含** FK）；`migrate.rs:109-110`（仅主连接在 migrate 内 `foreign_keys=ON`）；`reader_pool.rs:47-52`（读者 PRAGMA 无 FK——只读可接受）
- **现象**：`write_conn` 生命周期内 FK 始终 OFF；主连接在 `open()` 的 PRAGMA 批未设 FK，依赖后续 `migrate()`「顺带」打开。若未来某条写不经 migrate 直接在 open 后执行，FK 不保证。
- **代码现场**：

```rust
// lib.rs:122-124 —— 无 foreign_keys
"PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;"

// migrate.rs:109 —— 只主连接
conn.execute_batch("PRAGMA foreign_keys = ON;")?;
```

- **根因**：PRAGMA 迁移时分时设置；组提交引入后未复核连接级 PRAGMA 矩阵。
- **影响量化**：正确性隐患 > 性能；若 S1 接线后仍不设 FK，`events → sessions` / `runs → sessions` 级联删除语义在写 Actor 上失效（孤儿行只靠迁移期过滤与 GC）。
- **修复方案**：open 时对主连接与 write_conn 统一 `foreign_keys=ON; journal_mode=WAL; synchronous=NORMAL; busy_timeout=5000;`；migrate 内保留幂等重设。
- **回归风险**：低；注意内存库 `:memory:` 下 FK 语义已由迁移测试覆盖。

---

#### S3.【中】主/写连接未设 cache_size / mmap_size；读者 cache_size=-2000 偏保守

- **位置**：`lib.rs:119-133`；`reader_pool.rs:50`（`PRAGMA cache_size = -2000` ≈ 2MB）
- **现象**：SQLite 默认页缓存对大 events/messages 表偏小；无 mmap 映射辅助大范围顺序扫。
- **根因**：只做了 WAL/sync 调优，未按桌面内存预算调页缓存。
- **影响量化**：长会话恢复 / list_blocks / usage dashboard 跨表扫时页缓存未命中率升高（静态推断，待 V1 实测）。
- **修复方案**：写连接 `cache_size = -8000`（≈8MB）起，按会话 events 行数分位调；读者可 `-4000`；`mmap_size = 268435456`（256MB）在 64 位桌面安全（需在 Windows 上验证锁定范围行为）。
- **回归风险**：内存占用上升；`open_in_memory` 测试路径可跳过。

---

#### S4.【低】busy_timeout API 与 PRAGMA 双重设置

- **位置**：`lib.rs:119,123,130,132`
- **现象**：每连接先 `busy_timeout(Duration)` 再 `PRAGMA busy_timeout=5000`，语义重复。
- **影响**：可忽略；维护噪音。
- **修复**：保留 API 调用，PRAGMA 批中删除 busy_timeout 重复项。
- **回归**：无。

---

#### S5.【低】open_in_memory 不建 ReaderPool（pool_size=0）——测试与生产读路径形态不一致

- **位置**：`lib.rs:175-178`
- **现象**：内存库读一律回退主 Mutex；生产文件库走 8 槽池。
- **影响**：单测通过不代表 ReaderPool 旁路路径被覆盖；并发单测在 `tests_concurrency` 用文件库补，但业务单测多为内存库。
- **修复**：内存库可用 `from_connections` 建 1–2 槽内存 reader（同一 DB 不可行——内存库多连接不共享；文档化限制即可）。
- **回归**：无强制。

---

#### S6.【低】`compression_blocks_present` / `imported_tables_present` 探测缓存 Mutex 与主连接锁顺序

- **位置**：`blocks.rs:104-134`、`imported.rs:75-99`
- **现象**：先锁 present 缓存 Mutex，再锁主连接；若其它路径先锁连接再锁缓存则潜在锁序反转（当前未见反转调用）。
- **影响**：当前无实害；防御性记录。
- **修复**：探测函数内先 `conn.lock` 再更新缓存，或改 `OnceLock`/`AtomicU8` 状态位消除嵌套。
- **回归**：blocks 缺表降级测试 `blocks.rs:526-545`。

---

### 4.2 写路径域（W）

---

#### W1.【高】save_session_body 全量先删后插 + 双触发器 message_count 写放大——千条会话 2×N 次 sessions 行更新

- **位置**：`messages.rs:50-102`；触发器 `schema.rs:262-272`；bench 注释 `benches/db_write.rs:40-44`；IPC 调用 `session_commands.rs:141-153`
- **现象**：每次保存删除该会话全部 `session_messages` 再逐条 INSERT；每次 DELETE 触发 `message_count-1`，每次 INSERT 触发 `+1`——同一事务内 sessions 行被改 2N 次。
- **代码现场**：

```rust
// messages.rs:64-96
tx.execute("DELETE FROM session_messages WHERE session_id = ?1", ...)?;
for (seq, msg) in messages.iter().enumerate() {
    tx.execute("INSERT INTO session_messages (...)", ...)?;  // 每条触发 UPDATE sessions
}
// schema.rs:262-272
CREATE TRIGGER trg_session_messages_insert
AFTER INSERT ON session_messages
BEGIN UPDATE sessions SET message_count = message_count + 1 WHERE id = NEW.session_id; END;
```

- **调用链与触发时机**：前端 350ms debounce 全会话批次（03 I1）→ invoke `save_session_body` → spawn_blocking → 本方法。工具密集 run 每 350ms 一轮。
- **根因**：① 无增量/UPSERT 模式；② message_count 用触发器实时维护，与全量重写策略叠加放大；③ CAS `batch_version` 未接入 DB 层。
- **影响量化**（静态推演 + bench 路径自述）：
  - N=1000：DELETE N + INSERT N + 触发器 UPDATE sessions ×2N ≈ 4000 次表写（含索引维护）。
  - 全量 JSON 参数绑定：每条 5 个大 String（text/thinking/tool_*）序列化与拷贝。
  - 与 S1 叠加：此事务持主 Mutex 期间，**所有** events/runs/meta 写阻塞。
  - bench 目标已声明 O(n) 线性（100/1000/5000）。
- **修复方案**：
  1. **增量模式**：按消息 id 集合 diff——仅 INSERT 新 id、UPDATE 变更行、DELETE 消失 id（可按 seq 前缀优化）；CAS 比对 `session_sequence` 或元数据 `body_version`。
  2. **message_count**：改为保存路径结束后单条 `UPDATE sessions SET message_count = (SELECT COUNT(*)...)`，或改为读时计算+缓存；删除 insert/delete 双触发器（若无其它调用方依赖）。
  3. **写改道组提交**（依赖 S1）：增量后的多条 INSERT 可聚合同批。
  4. 前端 dirty 集合（交叉 03 I1 步骤 1）同步推进。
- **回归风险**：崩溃恢复（事务原子已保证）；`tests_migrations` save 往返；`session_commands` 自愈补建会话行测试；触发器删除需确认无外部依赖 `message_count` 实时性（list_sessions 读该列）。

---

#### W2.【高】reserve_sequence 三语句各自自动提交——每次取号 3 轮写日志

- **位置**：`events.rs:199-228`
- **现象**：`INSERT OR IGNORE` + `SELECT` + `UPDATE` 三条独立 `execute`，无 `BEGIN` 包裹；SQLite 自动提交下每条可能独立 checkpoint 评估。
- **代码现场**：

```rust
conn.execute("INSERT OR IGNORE INTO session_sequence ...", ...)?;
let sequence = conn.query_row("SELECT next_sequence FROM session_sequence ...", ...)?;
conn.execute("UPDATE session_sequence SET next_sequence = next_sequence + 1 ...", ...)?;
```

- **调用链**：每条持久化事件（含收口批量事件）前 `store.reserve_sequence` → `blocking_db_call` → 本方法（persist.rs:880-886）。
- **根因**：注释写「单连接互斥下读+写等效单语句原子性」——用 Mutex 替代了显式事务，但未合并为 `UPDATE ... RETURNING` 或「单条 INSERT … ON CONFLICT DO UPDATE SET next=next+1 RETURNING」。
- **影响量化**：收口 N 条事件 = 3N 条 SQL；WAL 下每条仍写 redo 日志与页缓存脏页标记。中高事件吞吐会话（工具链 run）收口尖峰期明显。
- **修复方案**：
  1. 单语句：`UPDATE session_sequence SET next_sequence = next_sequence + 1 WHERE session_id=?1 RETURNING next_sequence-1`（需 SQLite 3.35+ RETURNING；rusqlite 版本核实）。
  2. 或显式 `transaction()` 包三条，纳入组提交（S1）。
  3. 首次 seed 的 `INSERT OR IGNORE` + MAX 子查询可保留在冷路径。
- **回归风险**：与 `seed_sequence` 的 MAX 校准语义；多会话并发取号测试；无 RETURNING 时的回退分支。

---

#### W3.【中】NoPersist / 非持久事件仍完整走取号+落库链（DB 侧确认）

- **位置**：`events.rs:13-34`；`orchestrator/persist.rs:96-97`（kind 列表含 reserve_sequence）；03 R3
- **现象**：persist 层若对 NoPersist 事件仍调用 reserve+append，DB 侧无过滤。
- **根因**：过滤应在 orchestrator EventQueue；DB API 本身合理（不知道 NoPersist 概念）。
- **影响量化**：token 流若有任何误入持久化轨，放大 3+1 条 SQL/事件（交叉 03：正常流 delta 为 NoPersist，应验证收口轨是否误持久化 delta）。
- **修复**：orchestrator 层保证 NoPersist 不进 store（03 K 批）；DB 侧无需改。登记交叉。
- **回归**：03 R3 修复后的持久化事件计数断言。

---

#### W4.【中】insert_run 使用 INSERT OR REPLACE——DELETE+INSERT 语义

- **位置**：`runs.rs:125-137`
- **现象**：`INSERT OR REPLACE INTO runs` 在 SQLite 中为冲突时删除旧行再插入，可能触发 FK 级联检查与额外写。
- **根因**：历史 API 选择。
- **影响量化**：run 创建频率低（每 run 一次），影响有限；但语义上会重置未列出的列为 DEFAULT（当前列较全）。
- **修复**：`INSERT ... ON CONFLICT(run_id) DO UPDATE SET ...` 显式列。
- **回归**：runs 往返测试；usage 列不被重置。

---

#### W5.【中】update_run_status / save_run_usage / touch_session 每次独立提交

- **位置**：`runs.rs:142-164,187-218`；`sessions.rs:318-331`
- **现象**：收口阶段连续多次单行 UPDATE，各自动提交。
- **根因**：同 S1——无组提交接线。
- **影响量化**：一次 run 收口约 3–6 次提交 × 并行会话数。
- **修复**：S1 组提交接线后自动合并窗口内请求；可选收口显式 `BEGIN` 打包。
- **回归**：stress_concurrent_runs。

---

#### W6.【中】upsert_session_entry 全列 ON CONFLICT UPDATE——列表刷新高频全行写

- **位置**：`sessions.rs:37-83`
- **现象**：任何索引字段变化都写全行 12 列；无脏字段检测。
- **根因**：前端会话索引整体序列化推送（交叉 07/前端）。
- **影响量化**：工具密集期每 350ms × 活跃会话数次全行 upsert（若前端每次保存都推索引）。
- **修复**：DB 层可保留；配合前端 dirty 集合减少调用次数；或拆 title/timestamp 小写 API。
- **回归**：`message_count`/`created_at` 不被覆盖的既有语义测试。

---

#### W7.【低】save_session_agents 同样先删后插 + FK 级联清空 agent 消息

- **位置**：`agents.rs:188-259`；注释明确「单行定点写已抽取至 agents_ops」
- **现象**：全量保存仍为快照面；级联 DELETE 再插入全部 agent 消息。
- **影响量化**：仅前端显式保存/导入路径触发（agents_ops 热路径已是单行）；频度低于 W1。
- **修复**：文档标注「勿在热路径调用」；导入场景保留事务。
- **回归**：agents 快照测试。

---

#### W8.【低】cleanup_orphan_sessions 事务内前后 COUNT(*) 全表

- **位置**：`sessions.rs:278-315`
- **现象**：为返回删除数做 COUNT before/after；会话表通常小。
- **影响**：可忽略；若 sessions 上万则多两次扫。
- **修复**：用 `DELETE` 的 changes() 返回值。
- **回归**：孤儿清理计数断言。

---

#### W9.【低】import_legacy_usage_snapshot 循环逐条 INSERT 无外层事务

- **位置**：`usage_analytics.rs:307-337`
- **现象**：天级条目逐条自动提交；成功后写迁移标记。
- **影响**：一次性、条目少；失败中断需重试（幂等标记未写）。
- **修复**：包一层 transaction；失败整批回滚。
- **回归**：usage 迁移测试。

---

### 4.3 查询与索引域（Q）

---

#### Q1.【中高】events 按 event_type 过滤无 (session_id, event_type) 辅助索引；count_compression_events 扫会话全部事件

- **位置**：`blocks.rs:329-343`（`WHERE session_id=? AND event_type='context-compression-end'`）；schema 无该组合索引
- **现象**：PK 前缀可用 session_id，但仍扫描该会话全部事件行（含大 payload）后过滤 event_type。
- **根因**：v7 压缩块表设计时以 events 计数为语义源，未加窄索引。
- **影响量化**：长会话（事件数千～万级）每次 count 扫全部 payload 行；压缩调度若频繁调用则中等成本。payload 越大，行宽越大，扫描越贵。
- **修复方案**：
  1. `CREATE INDEX idx_events_session_type ON events(session_id, event_type, sequence)`（v12 迁移，纯建索引）。
  2. 或压缩块表冗余 generation 列由写路径维护（已有 generation），`count_compression_events` 改为 `list_blocks MAX(generation)`——需确认语义一致（事件重放 vs 块表）。
- **回归**：`blocks.rs:548-560` 事件计数测试；迁移幂等。

---

#### Q2.【中】sessions 无 (updated_at, id) 索引——list_sessions 全表排序

- **位置**：`sessions.rs:87-125`（`ORDER BY updated_at DESC, id ASC`）；`schema.rs:128-144` 仅 PK(id)
- **现象**：每次列出会话全表扫 + 排序。
- **影响量化**：会话数 <1000 时 SQLite 排序极快；>5000 且每次 list 含全列宽行时可测。列表读走 ReaderPool（正面），不阻塞写，但 CPU/IO 浪费。
- **修复**：`CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC, id ASC)`。
- **回归**：排序稳定性测试。

---

#### Q3.【中】query_usage_dashboard 全量拉行 + Rust 内存聚合——无 SQL GROUP BY 下推

- **位置**：`usage_analytics.rs:405-530`
- **现象**：`SELECT ... WHERE timestamp BETWEEN` 全行进内存，HashMap 分桶。
- **根因**：时序聚合灵活（多 map 拆分）优先于 SQL 表达。
- **影响量化**：30d 高用量下数千～数万行仍可接受；若 usage 长期保留数年则线性恶化。
- **修复**：SQL `GROUP BY timestamp/bucket` 预聚合或物化日表；仪表盘读走 ReaderPool（当前持主锁——并入 R1）。
- **回归**：dashboard 快照测试 `tests_usage.rs`。

---

#### Q4.【中】CAS GC 标记查询 4× `NOT IN (SELECT DISTINCT ...)` 反连接

- **位置**：`cas_gc.rs:489-508`、`539-558`
- **现象**：对 blob_cas 每候选 hash 评估四个子查询；现代 SQLite 会优化为 anti-join，但 DISTINCT + 多子查询在 attachment 表膨胀时仍重。
- **影响**：GC 后台路径（低频）；与 S1 叠加时全程持主锁放大阻塞窗口（见 G2）。
- **修复**：改 `LEFT JOIN ... IS NULL` 或 `NOT EXISTS`；批量 UPDATE `WHERE hash IN (...)` 替代逐条。
- **回归**：`tests_cas_gc.rs` 两阶段语义。

---

#### Q5.【低】idx_blob_cas_pinned 选择性差

- **位置**：`schema.rs:288`（`idx_blob_cas_pinned ON blob_cas(pinned)`）
- **现象**：pinned 仅 0/1，低选择性索引。
- **影响**：查询规划器可能忽略；体积浪费小。
- **修复**：评估删除或改为部分索引 `WHERE pinned=1`。
- **回归**：GC 查询计划 EXPLAIN（V 项）。

---

### 4.4 读路径 / 恢复域（R）

---

#### R1.【高】events / runs / blocks / usage 等读全部持主 Mutex——与写串行；ReaderPool 旁路不完整

- **位置**：events.rs:46,94,136,163；runs.rs:169,227,294,337；blocks.rs:115+；usage_analytics.rs:191,349；lib.rs:223-239（read 优先池，但域方法多数不调 read）
- **现象**：`LocalDb::read` 已按 ReaderPool 设计，但大量读方法直接锁主连接。
- **代码现场**：

```rust
// messages.rs:11 —— 正面
self.read(|conn| { ... load_session_body ... })

// events.rs:46 —— 旁路
let conn = self.conn.lock()...?;
```

- **调用链**：恢复分页 `query_events`（restore_manager.rs:256）、`query_events_by_run`、run 快照 `query_all_runs`、压缩 `list_blocks`、用量面板。
- **根因**：读方法迁移 `self.read()` 不完整；部分写读混合方法（meta）保持主连接合理，纯读未迁。
- **影响量化**：WAL 本支持多读一写；旁路导致 `save_session_body`（W1）大事务期间，**读也排队**——恢复分页与 UI 列表加载尖峰时卡顿。
- **修复方案**：
  1. 纯读方法机械改 `self.read(|conn| ...)`（与 load_session_body 同模式）。
  2. 需要事务一致性的读（迁移、跨表不变量）保留主连接。
  3. `read_async` 已有 spawn_blocking，async 调用方优先。
- **回归**：`tests_concurrency` WAL 混合读写；确保 ReaderPool `query_only` 不被误写。

---

#### R2.【中】load_session_body 无 LIMIT——恢复会话全量消息进内存

- **位置**：`messages.rs:10-46`
- **现象**：`WHERE session_id ORDER BY seq` 全量。
- **根因**：UI 需要全史；虚拟化在前端（02 报告）。
- **影响量化**：超长会话（数千消息 × 大 text）单次 IPC + 内存尖峰（与 03 I2 交叉；DB 侧无法单方面分页而不改契约）。
- **修复**：可选 `load_session_body_page(session_id, after_seq, limit)` 供懒加载（交叉 07 启动方向）；全量 API 保留。
- **回归**：hydrate 行为变更需产品裁决。

---

#### R3.【中】load_session_agents N+1 消息查询

- **位置**：`agents.rs:67-71` + `load_agent_messages`（agents.rs:147-186）
- **现象**：先查 agents，再对每个 agent 单独 `WHERE session_id AND agent_id`。
- **影响量化**：子代理会话 20 agents = 1+20 次查询；单连接锁内完成，放大持锁时间。
- **修复**：单条 `LEFT JOIN` 或一次查出全部 agent_messages 按 agent_id 分组。
- **回归**：agents 加载测试。

---

#### R4.【中】list_blocks 拉全宽行（summary + summary_json）

- **位置**：`blocks.rs:269-302`、`BLOCK_SELECT_SQL`（347-353）
- **现象**：列表场景可能只需 id/generation/state/tokens；却载入全文摘要 JSON。
- **影响**：压缩块较多时列表 IPC 膨胀（交叉前端 02）。
- **修复**：轻量 list（省略 summary_json）+ get_block 详情。
- **回归**：链尾取数 T-18 语义。

---

#### R5.【低】query_events limit=None 等价 i64::MAX

- **位置**：`events.rs:38-59`
- **现象**：API 允许无界；生产调用方应已传 limit（DM-07）。
- **影响**：误用即全量加载。
- **修复**：内部钳制硬上限（如 10000）并 warn。
- **回归**：分页测试。

---

#### R6.【低】get_blob / peek 元数据仍主 Mutex——附件读热路径

- **位置**：`cas_gc.rs:134-156`
- **现象**：块编辑附件读写与会话写抢锁。
- **影响**：note/块编辑高频保存时卡事件落库（反之亦然）。
- **修复**：只读 get/peek 改 ReaderPool；写 put 保留写连接/组提交。
- **回归**：cas 测试。

---

### 4.5 迁移 / GC / 导入域（G）

---

#### G1.【中】v3→v4 迁移重建 events/runs/pending 全表拷贝——大库启动一次性尖峰

- **位置**：`migrate_steps.rs:135-183`
- **现象**：`INSERT INTO ... SELECT ... WHERE session_id IN (SELECT id FROM sessions)` 重建三表。
- **根因**：加 FK 与无 AUTOINCREMENT 形态需要重建。
- **影响量化**：仅旧库升级；百 MB 级 events 可能秒级启动停顿（迁移期单次，可接受但需 UX 提示）。新库走 v5 直建跳过。
- **修复**：已发生的历史成本；记录用户可见「首次启动可能稍慢」；无需回改。
- **回归**：upgrade_e2e 已覆盖。

---

#### G2.【中高】CAS GC 全流程持主 Mutex——周期扫描阻塞全部会话写

- **位置**：`cas_gc.rs:290-296`、`spawn_cas_gc_loop`（656-695）；`run_cas_gc_conn` 多 COUNT + 标记 + 逐条 UPDATE/DELETE
- **现象**：后台每 interval 在 `run_cas_gc` 中锁主连接跑完整扫描。
- **根因**：GC 实现为同步连接级函数；调度器直接调 `db.run_cas_gc`。
- **影响量化**：blob_cas 上千时扫描期间 events 写延迟毛刺；与 W1 重叠则放大。
- **修复方案**：
  1. GC 使用 **独立连接**（可只读扫描 + 短写事务标记）或组提交通道。
  2. 标记批量 `UPDATE ... WHERE hash IN (...)`。
  3. 降低默认频率或改为 idle 时触发。
- **回归**：`tests_cas_gc`；GC 与写并发压测（V4）。

---

#### G3.【中】import_from_localstorage 单大事务——多会话体全部进一个事务

- **位置**：`import.rs:35-122+`
- **现象**：全部会话 body/agents 一次 BEGIN；失败全回滚（正确性好）但长事务锁库。
- **影响**：一次性导入；与运行中写并发时阻塞。
- **修复**：可改为每会话一事务或复用 imported 批模式；导入时暂停并行写。
- **回归**：导入统计测试。

---

#### G4.【低】ensure（已是 LATEST）只跑 create_v5_schema——v7–v11 表不在 ensure DDL 中

- **位置**：`migrate.rs:118-123,209-211`；`schema.rs:126-330`（create_v5_schema 不含 compression_blocks/usage_records/app_preferences）
- **现象**：依赖迁移链建新表；外部损坏删表时 ensure 不重建（有降级逻辑）。
- **影响**：正常路径无影响；备份恢复异常依赖 warn 降级。
- **修复**：把 v7–v11 建表 DDL 并入 ensure（IF NOT EXISTS 幂等）。
- **回归**：migrate 幂等测试。

---

#### G5.【低】迁移备份轮转按文件名排序——跨盘/路径异常时可能误删

- **位置**：`migrate.rs:52-70`
- **现象**：`backups.sort()` 字典序；bak-v10 < bak-v9 风险在多数字版本时（当前仅 bak-v{1-4} 实际产生）。
- **影响**：当前 BACKUP_KEEP=2 且仅 DROP 前版本产生备份，风险低。
- **修复**：解析版本号数值排序。
- **回归**：备份轮转测试。

---

#### G6.【低】lease 持久化行无批量 sweep API——过期行依赖 GC 扫描清理

- **位置**：`lease_guard.rs` 内存 sweep 有；DB 表 `active_blob_leases` 过期行由 GC 查询排除，未见 DELETE
- **现象**：过期租约行可能长期残留表中（逻辑上不再保护，仅占行）。
- **影响**：表膨胀缓慢。
- **修复**：GC purge 时顺带 DELETE 过期 lease 行。
- **回归**：lease 测试。

---

## 5. 交叉引用登记

| 本方向编号 | 对应 03 / 其它方向 | 关系 |
| ---------- | ------------------ | ---- |
| W1 | 03 **I1**（save_session_body 全量+CAS 丢弃） | 同根因；本文补触发器放大与事务细节 |
| W3 | 03 **R3**（NoPersist 白付取号） | DB API 无辜；过滤在 orchestrator |
| R2 | 03 **I2**（boot 2×N hydrate）+ 方向 07 | DB 提供分页 API 后可服务懒加载 |
| Q3/R1 | 方向 07 启动（用量面板） | 读池接线后改善 |
| W6 | 01 **M9** / 03 I1 前端侧 | dirty 集合需前端+DB 增量协同 |
| G2 | 方向 04 锁竞争 | 主 Mutex 单点是 DB 与引擎共享瓶颈 |

## 6. 修复路线图

| 批次 | 目标 | 条目 | 依赖 | 验证 |
| ---- | ---- | ---- | ---- | ---- |
| **A** | 写路径接线与 PRAGMA 对齐 | S1 组提交接线（events/reserve 优先）、S2 FK、S3 cache | SQLite RETURNING 版本核实 | tests_concurrency 扩域冒烟；stress stats.total_batches>0 |
| **B** | save_session_body 增量化 | W1 增量+message_count 单更新；契约 CAS | A；前端 dirty（03） | db_write bench 改增量场景；e2e 保存往返 |
| **C** | 读路径全面 ReaderPool | R1 机械迁移、R6 blob 读、Q3 读池 | 池饱和策略（acquire 超时） | WAL 混合读写；恢复分页延迟 |
| **D** | 索引与查询下推 | Q1 event_type 索引、Q2 sessions updated_at、Q4 anti-join、R3 N+1 | v12 迁移窗口 | EXPLAIN QUERY PLAN 快照；迁移 e2e |
| **E** | GC/迁移边角 | G2 GC 独立连接、G4 ensure DDL、G6 lease 清理、W9 事务 | — | cas 并发；备份轮转 |
| **F** | 可观测 | 组提交 stats / ReaderPool stats 接入 tracing 或 perf 面板 | — | 运行时 V 项回填 |

批次 A→B→C 为性价比主链；D 可与 C 并行。

## 7. 建议修复顺序（逻辑依赖，不谈工期）

1. **A2 FK/PRAGMA 矩阵**（无行为风险，正确性先行）
2. **A1 append_event + reserve_sequence 接组提交**（最大事件吞吐收益）
3. **C1 纯读迁 ReaderPool**（与写解耦，恢复体验）
4. **B1 save_session_body 增量**（依赖前端 dirty 时收益最大；可先做 DB 侧 diff）
5. **D 索引** 随迁移版本插入
6. **E GC 连接隔离** 在附件功能活跃前完成

## 8. 域方法 → 连接路径对照总表（接线审计底账）

> 说明：下表覆盖 `LocalDb` 主要公共方法在生产路径上的实际连接选择。「主锁」= `self.conn.lock()`；「池」= `self.read()` / ReaderPool；「组提交」= `writer.write`（生产 0 命中）。

| 模块 | 方法 | 写/读 | 实际路径 | 建议路径 | 备注 |
| ---- | ---- | ---- | -------- | -------- | ---- |
| events | append_event | W | 主锁 | 组提交 | S1 |
| events | reserve_sequence | W | 主锁×3 语句 | 组提交+单语句 | S1+W2 |
| events | seed_sequence | W | 主锁×2 | 组提交 | 冷路径 |
| events | query_events / by_run / by_type | R | 主锁 | 池 | R1 |
| events | max_sequence | R | 主锁 | 池 | R1 |
| messages | load_session_body | R | **池** | 池 | 已合规 |
| messages | save_session_body | W | 主锁+事务 | 增量+组提交 | W1+S1 |
| sessions | list_sessions | R | **池** | 池 | 已合规 |
| sessions | get_session_meta | R | **池** | 池 | 已合规 |
| sessions | insert/upsert/delete/touch | W | 主锁 | 组提交 | S1 |
| sessions | set/update_session_meta | W | 主锁 | 组提交 | 需原子读改写，可短事务 |
| sessions | cleanup_orphan_sessions | W | 主锁+事务 | 主锁（跨表不变量） | 合理 |
| runs | insert/update/get/query/pending | W/R | 主锁 | 写组提交/读池 | S1+R1 |
| runs | save_run_usage | W | 主锁 | 组提交 | S1 |
| agents | load_session_agents* | R | **池** | 池 | 已合规（N+1 见 R3） |
| agents | save_session_agents | W | 主锁+事务 | 快照专用 | 热路径已定点化 |
| blocks | insert/update/get/list/count | W/R | 主锁 | 写组提交/读池 | S1+R1 |
| blocks | count_compression_events | R | 主锁 | 池+索引 | R1+Q1 |
| cas_gc | put/get/meta/pin/link… | W/R | 主锁 | 读池/写隔离 | R6+G2 |
| cas_gc | run_cas_gc | W | 主锁长事务 | 独立连接 | G2 |
| lease | acquire/renew/release | W | 主锁 | 组提交 | 低频 |
| lease | is_leased（内存） | — | 内存 | 内存 | 已合规 |
| usage | insert_usage_record | W | 主锁 | 组提交 | S1 |
| usage | query_usage_dashboard | R | 主锁 | 池+SQL 聚合 | R1+Q3 |
| preferences | get/list | R | **池** | 池 | 已合规 |
| preferences | set/delete | W | 主锁 | 组提交 | S1 |
| import | import_from_localstorage | W | 主锁+大事务 | 导入期专用 | G3 |
| import | import_bookmarks/history | W | 主锁+分批 | 可保持 | 已分批 |
| migrate | migrate / user_version | — | 主锁 | 主锁 | 启动一次 |

## 9. 事件写路径成本模型（收口尖峰）

设一次 run 收口持久化 K 条事件（不含 NoPersist）：

| 步骤 | 语句数（现状） | 语句数（W2 修复后） | 锁 |
| ---- | -------------- | ------------------- | -- |
| reserve_sequence | 3 | 1 | 主 Mutex |
| append_event | 1 | 1 | 主 Mutex |
| 单事件小计 | 4 | 2 | |
| K 事件合计 | 4K | 2K | |
| update_run_status × R | R | R（可并组提交） | 主 Mutex |
| touch_session × S | S | S | 主 Mutex |

若同时另一会话 `save_session_body` N=1000：

| 步骤 | 操作数 |
| ---- | ------ |
| DELETE | 1 |
| INSERT | 1000 |
| 触发器 UPDATE sessions | 1000（delete）+1000（insert） |
| 持锁期间阻塞的读（R1 旁路方法） | 全部 events/runs/blocks 读 |

→ 尖峰期「K×4 写 + N×2000+ 触发器写」全部挤在同一连接互斥域内。

## 10. 正面发现补充：为何这些设计值得锁死

1. **WITHOUT ROWID + 复合主键**：`events(session_id, sequence)` 与 `session_messages(session_id, seq)` 把「按会话扫」变成聚簇顺序读，避免回表——这是桌面会话库最优形态，重构时禁止回退到 AUTOINCREMENT id 表（v1 旧形态已在 v4 废除）。
2. **idx_events_run 三列索引**：按 run 过滤恢复/重放时可同时用 session 前缀与 run 等值，limit 下推后不必碰会话其余事件 payload。
3. **max_sequence SQL 下推**：避免「全量读 events 再 iter.max」的 O(n) 内存恢复路径（1C-1），这是恢复冷启动的关键正面。
4. **ReaderPool try_lock 探测**：饱和时不阻塞调度线程地短暂自旋/yield，async 变体用 tokio sleep——与项目「锁不跨 await」纪律一致。
5. **迁移 user_version 入事务**：消除「commit 成功 → PRAGMA 前崩溃」死态（PS-03），属正确性+运维正面。
6. **导入分批 1000**：浏览器书签/历史可能数万条，分批避免单事务锁库数秒。

## 11. 运行时验证建议（静态分析，待回填）

| ID | 项 | 方法 | 成功标准 |
| -- | -- | ---- | -------- |
| V1 | 页缓存命中 | `PRAGMA cache_size` 调参前后，EXPLAIN + 压测 save/load | 主路径 p95 下降或持平 |
| V2 | 组提交批率 | 接线后 `writer.stats()`：total_batches / total_operations | 并行写时 max_batch_size_seen ≥ 2 |
| V3 | save_session_body 增量收益 | bench：全量 vs 增量 @1000 消息 | 增量 < 20% 全量耗时（无变更时 < 5%） |
| V4 | GC 与写共存 | 压测中触发 run_cas_gc | events 写延迟毛刺消失（接独立连接后） |
| V5 | ReaderPool 饱和 | stats.timeouts / probe_retries 在恢复风暴下 | timeouts 可解释；无死锁 |
| V6 | reserve_sequence 单语句化 | 微基准 10k 取号 | 延迟接近 1/3 原三语句 |
| V7 | 大库迁移启动 | 合成 v3 库含 50k events 走 upgrade_e2e | 完成时间可报告；有进度日志更佳 |
| V8 | FK 在 write_conn | 接线后故意插孤儿 events | 应失败（FK ON） |

## 12. 覆盖面附录

### 12.1 已扫文件清单（conex-db）

| 文件 | 覆盖 |
| ---- | ---- |
| lib.rs | open / read / write / PRAGMA |
| schema.rs | v1/v5 DDL、触发器、索引 |
| events.rs | append/query/reserve/seed/max |
| messages.rs | load/save body |
| sessions.rs | CRUD / orphan / meta / touch |
| runs.rs | run CRUD / pending / usage |
| agents.rs / agents_ops.rs | 加载 N+1 / 快照写 / 定点写 |
| blocks.rs | 压缩块读写 / 计数 |
| group_commit.rs | Actor 实现 |
| reader_pool.rs | 池实现与 PRAGMA |
| cas_gc.rs / lease_guard.rs | GC 与租约 |
| migrate.rs / migrate_steps.rs | v1–v11 |
| import.rs / imported.rs | localStorage / 浏览器导入 |
| usage_analytics.rs | 插入与仪表盘 |
| preferences.rs | 偏好 CRUD |
| benches/db_write.rs | O(n) 基准意图 |
| tests/* | 迁移/并发/CAS/blocks |

### 12.2 调用方抽样

| 调用方 | 关系 |
| ------ | ---- |
| orchestrator persist.rs | Store 适配层 → blocking_db_call |
| restore_manager.rs | 事件分页恢复 |
| session_commands.rs | invoke 读写 body/sessions |
| stress_empirical_concurrency.rs | 组提交真实压力（生产未接） |

### 12.3 明确不在本文范围

- SQLite 引擎二进制版本与 Windows 文件锁细节（需 V 项）
- 磁盘 fsync 实测
- connex-workspace-store（独立 SQLite 库，非 conex-db）

## 13. 总结表

| 严重度 | 数量 | 编号 |
| ------ | ---- | ---- |
| 高 | 6 | S1 W1 W2 R1 Q1 G2 |
| 中 | 14 | S2 S3 W3 W4 W5 W6 Q2 Q3 Q4 R2 R3 R4 G1 G3 |
| 低 | 12 | S4 S5 S6 W7 W8 W9 Q5 R5 R6 G4 G5 G6 |
| **合计** | **32** | +3 交叉登记（03-I1/I2/I4、03-R3、07） |

（精确计数以正文 `####` 标题为准：高 6 · 中 14 · 低 12 · 合计 32 项。）

**最终一句话**：把已经建好的组提交与读者池真正接到域方法上，再消掉 save_session_body 与 reserve_sequence 的写放大，SQLite 层即可从「设施先进、接线落后」回到与 WAL 设计意图一致的状态。

## 14. 附录 B · PRAGMA 连接矩阵速查

| PRAGMA | 主连接 | write_conn | ReaderPool | 缺口编号 |
| ------ | ------ | ---------- | ---------- | -------- |
| journal_mode=WAL | ✅ | ✅ | 文件级继承 | — |
| synchronous=NORMAL | ✅ | ✅ | ✅ | — |
| busy_timeout=5000 | ✅ API+PRAGMA | ✅ | ✅ | S4 双重 |
| foreign_keys=ON | migrate 内一次 | ❌ | ❌（只读可） | S2 |
| cache_size | ❌ 默认 | ❌ | -2000 | S3 |
| mmap_size | ❌ | ❌ | ❌ | S3 |
| temp_store | — | — | MEMORY | — |
| query_only | — | — | ON | — |
| wal_autocheckpoint | 未显式（默认 1000 页） | — | — | 记录项 |

## 15. 附录 C · 与 01–04 报告的编号对照

| 05 编号 | 外部编号 | 主题 |
| ------- | -------- | ---- |
| W1 | 03-I1 / 01-M9 | save_session_body 全量重写 |
| W3 | 03-R3 | NoPersist 取号 |
| R2 | 03-I2 / 07 | load_session_body 全量 |
| （未单列） | 03-I4 | query_all_runs 全表——本文在 R1 读旁路与 runs.rs:293 证据链登记，修复同批 C |
| S1 | 04 锁竞争 | 主 Mutex 单写连接 |

---

*报告完 · 方向 05 · 2026-09-12 · 素材：`materials/05-连接拓扑与PRAGMA配置盘点.md`、`materials/05-写路径与查询索引证据.md`*
