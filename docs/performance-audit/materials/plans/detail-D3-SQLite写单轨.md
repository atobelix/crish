# detail-D3 · SQLite 写单轨（组提交 + 增量 + CAS + 索引）

> **战役**：performance-fix  
> **创建**：2026-09-13  
> **上游**：`92-修复总方案.md` §4 D3 / §5 依赖序 / §6 删除面 / §9 模板；`materials/plans/independent-01-数据面收敛.md` Layer-2（T-L2-A/B）；CFL-02 / CFL-03 / CFL-11；`05-SQLite数据库性能审查报告.md`  
> **地位**：D3 分维执行详案。执行轮以 92 + 本详案为准；与 92 冲突时以 92 效果锁为准并回改本详案。  
> **原则**：仅逻辑依赖；先删后改；删除是完成方式。**禁止 git commit**（主 Agent 唯一提交权）。

---

## 0. 强制依赖声明（先绿闸门）

| 闸门 | 内容 | 裁决 |
| ---- | ---- | ---- |
| **U-NOPE / D1 NoPersist 先绿** | `orchestrator/events.rs` 中 `is_non_persistent` 前移至 `reserve` 之前；NoPersist 事件 `reserve` 调用次数 = 0（INV-2）；单测 mock store 上断言已绿 | **D3 组提交接线任务不得在 U-NOPE 绿前合入写路径 PR**。逻辑依据 CFL-03：组提交批内仍含 NoPersist 会「事务包白付取号」。 |
| CFL-02 拆票 | 前端 persist **出口切除**（票 A，D4/U-PERSIST-CUT）可与 D3 并行；**dirty+CAS 前端接线**（票 B）必须后于 D3 的 DB 侧增量+CAS | D3 只做 DB 侧 CAS 真消费与增量 UPSERT；**不碰** `sessionStore` partialize / dirty 集合（那是 D4 文件域）。 |
| CFL-11 | 引擎三连克隆 / thought 块合并（04-S1/S2）**不与组提交同 PR** | D3 文件域锁定 `conex-db/**` + `session_commands` save；不改 `session-loop` / `executing_tools`。 |

**路径收敛一句话**：会话 body 持久化路径 **3→1**（前端全量重发由 D4 dirty 收口；本维收 SQL 先删后插 → 增量 UPSERT）；写路径 **2→1**（主 Mutex 直写 + 空转组提交 Actor → 组提交唯一）；读路径主锁旁路 → ReaderPool 完备；取号 3 语句 → 1 语句；CAS 静默丢弃 → 真消费。

---

## 1. 做什么（映射 90 ID）

### 1.1 D3-1 · 组提交真接线 + 删 `conn.lock` 写旁路（05-S1 / 05-W5）

**现状**：`LocalDb::open` 已 `DbWriteHandle::spawn`（`lib.rs:134`），但生产写路径 100+ 域方法全部 `self.conn.lock()` 直写主连接；全仓生产 `db.write(` / `writer().write` 命中 **0**（仅 tests_concurrency / stress 调用 writer）。

**目标**：

1. 生产域写统一改道组提交 Writer（对外可保持同步外观）：
   - 提供阻塞桥（如 `write_blocking` / 扩展 `blocking_db_call` 适配层）：同步域方法内部 oneshot 等待 `writer.write`，**不改** `orchestrator/persist.rs` 对外 trait 签名（机械适配允许，见 §4）。
   - 迁移优先序（05 §7 / 01 T-L2-A）：
     1. `append_event` + `reserve_sequence`（合并为一次批提交，事件吞吐最大收益）
     2. `update_run_status` / `save_run_usage` / `touch_session` / `insert_run`
     3. `upsert_session_entry` / `insert_session` / `delete_session` / meta 写
     4. `preferences` / `usage` insert / `lease` 写 / `blocks` 写
     5. `save_session_body`（依赖 D3-4 增量后并入）
2. **删**：与 Writer 并行的全部生产 `self.conn.lock()` **写**分支（DEL-1）。跨表不变量方法（`cleanup_orphan_sessions`、`migrate`）保留主连接合理路径并注释豁免。
3. **PRAGMA 矩阵对齐**（05-S2，随接线同票）：
   - open 时主连接与 write_conn 统一 `foreign_keys=ON; journal_mode=WAL; synchronous=NORMAL`（busy_timeout 保留 API，删 PRAGMA 重复项 S4）。
   - 补 `cache_size`：写连接 `-8000` 起、读者可 `-4000`；数值从 D0 预算源取，禁散落魔数（若 D0 未落，本票用命名常量并登记待迁）。
   - `mmap_size` 评估接入（Windows 实测后决定；未通过则书面暂缓并保留 cache_size）。
4. Writer 连接 spawn 前必须 FK ON——否则 S1 接线后 FK 级联在写 Actor 上失效（05-S2）。

### 1.2 D3-2 · `reserve_sequence` 单语句（05-W2 / DEL-13）

**现状**：三语句各自自动提交——`INSERT OR IGNORE` seed + `SELECT` + `UPDATE`（`events.rs:207-226`）。

**目标**：

1. 热路径单语句：`UPDATE session_sequence SET next_sequence = next_sequence + 1 WHERE session_id = ?1 RETURNING next_sequence - 1`（需 SQLite 3.35+ RETURNING；实现前核实 rusqlite/系统 SQLite 版本与 Windows 构建矩阵——独立-01 §7.1 诚实边界）。
2. 若 RETURNING 不可用：显式 `transaction()` 包三语句，且整事务经组提交批执行（与 1.1 同批）。
3. 冷路径 seed 保留：首次 `INSERT OR IGNORE` + `MAX(sequence)+1` 对齐逻辑迁入冷路径或单事务前置步骤；**热路径取号不得每次做 MAX 子查询**。
4. `seed_sequence`（导入/恢复校准）保持独立 API，走组提交即可。

### 1.3 D3-3 · ReaderPool 读路径完备（05-R1 / CNV-1）

**现状**：`load_session_body` / `list_sessions` / agents / preferences 部分读已走 `self.read()`；events / runs / blocks / usage / blob get 等大量纯读仍主 Mutex。

**目标**：

1. 纯读方法机械改 `self.read(|conn| …)`（与 `messages.rs` load 同模式）：
   - events：`query_events` / `query_events_by_run` / `query_events_by_type` / `max_sequence`
   - runs：`get_run` / `query_runs` / pending 列表读
   - blocks：`list_blocks` / `get_block` / `count_compression_events`
   - usage：`query_usage_dashboard` 读侧
   - cas：`get_blob` / peek 元数据（05-R6）
2. 需要事务一致性的读（迁移、跨表不变量、cleanup 前后 COUNT）保留主连接，注释豁免。
3. 异步调用方优先 `read_async`（已有 spawn_blocking）；`blocking_db_call` 读路径同步外观可继续用 `read()`。
4. 内存库 `open_in_memory` 无 ReaderPool（pool_size=0）回退主连接——文档化限制，不强制改。

### 1.4 D3-4 · `save_session_body` 增量 UPSERT + CAS 真消费 + 触发器退役（05-W1 / 03-I1 / DEL-2/3/8）

**现状**：

- `messages.rs:50-102`：事务内全表 `DELETE` + 逐条 `INSERT`。
- `schema.rs:262-272`：insert/delete 双触发器各维护 `sessions.message_count` → N=1000 时约 2N 次 sessions 行 UPDATE。
- 前端已传 `batchVersion`（`sessionRustDbSql.ts:142-146`），Rust 命令 `session_commands.rs:141-153` 签名**未接收**、静默丢弃。
- 触发器删除需确认无外部依赖 `message_count` 实时性（list_sessions 读该列——改路径末单次重算）。

**目标**：

1. **增量协议**（DB 侧）：
   - 按 `session_id` 读现有行 id 集合（或 seq+id 摘要）做 diff：仅 UPSERT 变更/新增 id，DELETE 消失 id（可按 seq 前缀优化）。
   - UPSERT 形态：`INSERT … ON CONFLICT(session_id, seq) DO UPDATE SET …`（列对齐现有 14 列；`idx_session_messages_id(session_id,id)` 已有可辅助 id 定位——注意 PK 是 `(session_id, seq)`，id 冲突语义以现有插入约定为准，实现时核对唯一约束）。
   - **批末单次**：`UPDATE sessions SET message_count = (SELECT COUNT(*) FROM session_messages WHERE session_id = ?1) WHERE id = ?1`（或读时计算+缓存，二选一写死，禁止触发器双轨）。
2. **CAS 真消费**（DEL-8）：
   - `session_commands::save_session_body` 签名扩展 `batch_version: i64`（Tauri invoke 参数名与前端 `batchVersion` 对齐）。
   - CAS 落点：`session_meta` 或 `sessions` 上 `body_version` 列（v12 迁移新增列或 meta 行）；`UPDATE … WHERE body_version < ?new` 或等价条件；过期写返回**可识别错误**（如 `CasConflict` kind），前端已有 `writtenBodyVersion` 守卫——Rust 侧是第二道防线，禁止静默 Ok。
   - 自愈补建路径（`self_heal_then_save_body`）同步接收 `batch_version`。
3. **写改道组提交**：增量后的多条语句包在单 write 闭包/单事务内，经 Writer 提交（依赖 1.1 + SAVEPOINT 隔离已有）。
4. **触发器 DROP**（v12 迁移）：`DROP TRIGGER IF EXISTS trg_session_messages_insert/delete`；`create_v5_schema` 同步删 DDL，防 ensure 路径重建。
5. **全量模式降为显式 rebase API**：`save_session_body_full`（或 `rebase_session_body`）仅供导入/损坏恢复/测试；**不走** 350ms debounce 热路径；调用点显式。

### 1.5 D3-5 · 索引补齐（05-Q1 / Q2；Q4 顺带）

**v12 迁移（与 D3-4 同迁移窗口，不与 D4 同 PR）**：

| 索引 | 语义 | 动作 |
| ---- | ---- | ---- |
| `idx_events_session_type ON events(session_id, event_type, sequence)` | `count_compression_events` / 按类型过滤（05-Q1） | 新建 |
| `idx_sessions_updated ON sessions(updated_at, id)` | `list_sessions ORDER BY updated_at DESC, id ASC`（05-Q2） | 新建（当前全表排序，会话数大时浪费） |
| `idx_blob_cas_pinned` | 低选择性（05-Q5） | 评估改 `WHERE pinned=1` 部分索引或删除；EXPLAIN 快照决定 |
| CAS mark 反连接（05-Q4） | 4× `NOT IN (SELECT DISTINCT …)` | 改 `NOT EXISTS` / 批量 `UPDATE … WHERE hash IN`；GC 出锁一并改 |

**禁止**：回退 WITHOUT ROWID / 复合主键（05 §10 正面）；重建 events 表冒充索引修复。

### 1.6 D3-6 · CAS GC 出锁（05-G2）

**现状**：`run_cas_gc` 全程持主 Mutex（`cas_gc.rs:290-296`）；后台 loop 阻塞全部会话写。

**目标**：

1. GC 扫描用**独立连接**（只读扫 + 短写事务标记/purge）或专用短临界区——**不得**在完整扫描期间持主 Mutex / 不得占用组提交 Writer 长窗口。
2. 标记批量化：`UPDATE … WHERE hash IN (…)`；purge 同理。
3. 顺带（05-G6）：purge 时 DELETE 过期 `active_blob_leases` 行。
4. 可选：降低默认频率或 idle 触发（不改效果锁，仅调度）。
5. 读侧 get/peek 已在 D3-3 迁 ReaderPool。

---

## 2. 删什么（删除/合并清单 + 负向断言）

| ID | 删除物 | 负向断言（验收探针） |
| -- | ------ | --------------------- |
| DEL-1 | 生产路径全部 `self.conn.lock()` **写**域方法（events/messages/sessions/runs/blocks/agents 写/usage/preference 写/lease 写…） | 静态扫描：`conex-db/src/**` 业务模块中「写语句 + 主锁」命中 = 0（豁免清单：migrate、cleanup_orphan、已注释跨表事务）；运行时 `writer.stats().total_batches > 0` 且并行场景 `max_batch_size_seen ≥ 2`（05-V2） |
| DEL-2 | `save_session_body` 全表 DELETE + 逐条 INSERT 循环形态 | 热路径 SQL 不含 `DELETE FROM session_messages WHERE session_id = ?1` 后无 id 限定的全表删；增量 bench：增量 < 20% 全量耗时、无变更 < 5%（05-V3） |
| DEL-3 | 双触发器 `trg_session_messages_insert` / `trg_session_messages_delete` | v12 后 `sqlite_master` 无这两条；`create_v5_schema` 无 DDL；list_sessions.message_count 仍正确 |
| DEL-8 | `batch_version` 在 Rust 签名中丢弃 | 命令接收参数；过期 CAS 返回可识别错误单测；静默 Ok = 红 |
| DEL-13 | `reserve_sequence` 三语句各自自动提交（热路径） | 单测/微基准：热路径取号 SQL 语句数 = 1（或 1 事务）；10k 取号延迟接近原 1/3（05-V6） |
| CNV-1 | 纯读主 Mutex 旁路（不整文件删） | `query_events` 等走 `self.read()` 代码审查 + 混合读写并发测试无死锁 |
| 附带 S4 | busy_timeout PRAGMA 与 API 双设 | PRAGMA 批中无重复 busy_timeout |

**每票必须勾选**：上表对应 DEL 行 + 附「负产出行数/命中数」。无删除项的任务不得进入本维。

---

## 3. 依赖与逻辑序（先删后改）

```text
[U-NOPE 绿：NoPersist reserve=0]
    → D3-1a PRAGMA/FK 矩阵 + 组提交桥接骨架（无行为切换可先合）
    → D3-1b 热路径域写切 Writer：append_event + reserve → run/touch → upsert
         │  （依赖 D3-2 单语句可同票或紧前）
         ├→ D3-3 ReaderPool 纯读机械迁移（与写解耦，可与 1b 并行读侧）
         └→ D3-4 save 增量 + CAS + DROP 触发器（依赖 1b：写必须已走 Writer）
              └→ D3-5 索引（可与 1b 并行准备迁移，落地随 v12）
              └→ D3-6 GC 出锁（依赖 1b：不与主写路径抢同一锁形态）
```

**禁止顺序反例**（92 §5 + CFL）：

1. 未 U-NOPE 绿 → 不得宣称组提交完成。  
2. 未删 `conn.lock` 写旁路 → 不得只加 debounce 冒充 DB 修复。  
3. 未 DB 增量+CAS → 不得宣称 D3 完成（前端 dirty 是 D4 票 B）。  
4. D3 与 D4 **禁止同 PR**（CFL-02 拆票）；D3 不改 `sessionStore` / hydrate dirty。  
5. 引擎克隆/thought 合并不进 D3 PR（CFL-11）。  
6. 未裁决 PE-02 不影响本维（D3 只改落库，不改事件合并语义）。

---

## 4. 唯一文件域（与并行维互斥）

| 域 | 路径 | 主责 |
| -- | ---- | ---- |
| D3 唯一写域 | `crates/conex-db/**`（lib / events / messages / sessions / runs / blocks / agents / preferences / usage_analytics / cas_gc / lease_guard / group_commit / reader_pool / schema / migrate / migrate_steps / benches / tests*） | D3 |
| D3 机械适配 | `apps/agent-workbench/src-tauri/src/session_commands.rs`（save_session_body 签名 + CAS + self_heal） | D3 |
| D3 若需桥接 | `crates/orchestrator/src/persist.rs` **仅** blocking_db_call→writer 机械改道（签名不变）；不改事件语义 | D3 |

**明确不碰（并行互斥）**：

| 禁改 | 归属 |
| ---- | ---- |
| `orchestrator/events.rs` push 控制流（NoPersist） | D1 / U-NOPE |
| `sessionStore.ts`、`sessionRustDbHydrate.ts` dirty、partialize、LS 旧键 | D4 |
| `sessionRustDbSql.ts` 前端 CAS 守卫逻辑（已存在；D3 只保证 Rust 侧可识别冲突） | D4 票 B 接线时对齐 |
| `session-loop` / `executing_tools` / 引擎克隆 | D1 / CFL-11 后置 |
| 前端传输 / EventRouter | D6 |
| `engine_channels` 真缓冲 | D1 T-L4-C |

---

## 5. 验收：功能 + 负产出 + 五端物证

### 5.1 功能回归

- [ ] 长 run 收口 + 并行会话 `save_session_body` 往返：事件序连续、body 完整。
- [ ] 崩溃恢复 / 迁移 e2e（`tests_migrations` save 往返）。
- [ ] `save_session_body` 自愈补建会话行（既有 T08.1 测试扩展 batch_version）。
- [ ] 清空会话 / 僵尸复活防护语义不变。
- [ ] CAS：并发两批 batchVersion，旧批晚到不得覆盖；返回可识别冲突。
- [ ] list_sessions.message_count 在 DROP 触发器后仍正确。
- [ ] import / restore 分页事件读不阻塞（ReaderPool）。
- [ ] GC 与事件写并发：events 写延迟毛刺消失（05-V4）。

### 5.2 负产出（每票附证据）

| 探针 | 成功标准 |
| ---- | -------- |
| 生产 `conn.lock()` 写命中 | 豁免清单外 = 0 |
| `db.write(` / writer 生产命中 | > 0（append_event 路径必 > 0） |
| 热路径 reserve 语句数 | 1（或 1 事务） |
| session_messages 全表 DELETE | 热路径 0 |
| 触发器 | sqlite_master 0 |
| batch_version 静默丢弃 | 0 |
| GC 持主锁全程 | 0（扫描不在主 Mutex 临界区内） |

### 5.3 五端物证模板

| 端 | D3 项 |
| -- | ----- |
| 触发 | 工具密集 run 收口；并行 3 run + 另一会话 save；附件 GC 周期 |
| 传输 | n/a（库内）；IPC 侧 save_session_body 含 batchVersion |
| 介质 | WAL；组提交 stats；session_messages 增量行；v12 user_version |
| 消费 | list_sessions / 恢复分页 / 前端 hydrate（只读验证） |
| 负向 | §5.2 探针全绿 + 运行时 05-V2/V3/V4/V6 |

### 5.4 运行时验证（05 §11 摘录）

| ID | 项 | 成功标准 |
| -- | -- | -------- |
| V2 | 组提交批率 | 并行写 max_batch ≥ 2 |
| V3 | 增量 save | 增量 < 20% 全量；无变更 < 5% |
| V4 | GC 与写共存 | events 延迟毛刺消失 |
| V6 | reserve 单语句 | 10k 取号 ≈ 1/3 原耗时 |
| V8 | write_conn FK | 故意插孤儿 events 应失败 |

---

## 6. 路径 N→M（概念收敛表，任务内必答）

| 概念 | 现路径 | 目标 | 维内任务 |
| ---- | ------ | ---- | -------- |
| 会话/事件写 | 2（主 Mutex 直写 + 空转 Actor） | 1（组提交 Writer） | D3-1 |
| reserve_sequence | 3 语句自动提交 | 1 语句 / 1 事务 | D3-2 |
| 纯读（events/runs/blocks/usage） | 主 Mutex | ReaderPool | D3-3 |
| save_session_body | 全量 DELETE+INSERT | 增量 UPSERT + 显式 rebase | D3-4 |
| message_count | 双触发器 2N 更新 | 批末 1 次 UPDATE | D3-4 |
| batch_version | 签名丢弃 | 真 CAS + 可识别冲突 | D3-4 |
| events_type / sessions 排序 | 无辅助索引 | v12 索引 | D3-5 |
| CAS GC | 持主锁全程 | 独立连接/短临界区 | D3-6 |

---

## 7. 防御脚本 / 守护测试增量

1. **conn.lock 写旁路扫描**（扩展或新增 `check-db-write-bypass` 类脚本，或并入现有 check 体系）：AST/正则扫 `conex-db/src` 写语句与 `self.conn.lock` 共现；豁免表显式登记（migrate/cleanup）。  
2. **tests_concurrency 扩域**：组提交用例覆盖 append_event / reserve / save_session_body 增量 / touch；stats.max_batch。  
3. **CAS 单测**：batch_version 过期拒绝；自愈路径同断言。  
4. **触发器回归**：迁移后 message_count；list_sessions 快照。  
5. **bench**：`benches/db_write.rs` 增量场景（100/1000/5000 + 无变更）。  
6. **EXPLAIN QUERY PLAN 快照**：v12 新索引命中 count_compression_events / list_sessions。  
7. 若 D0 `check-perf-budgets` 已落：cache_size 等 DB 常量 re-export 预算源。

---

## 8. 迁移策略（v11 → v12）

| 步骤 | 内容 |
| ---- | ---- |
| 版本 | `LATEST_VERSION = 11 → 12`（`lib.rs` + migrate 链 + `SCHEMA_VERSION_STRING`） |
| DDL | DROP 双触发器；CREATE `idx_events_session_type`；CREATE `idx_sessions_updated`；（可选）部分索引替换 pinned；`body_version` 列或 session_meta 约定登记 |
| 事务 | 每版本独立事务 + `user_version` 事务内（既有 P9/P5 正面，不得回退） |
| 备份 | v12 纯索引+DROP+ADD 可走轻量路径（对齐 v5–v11 无 DROP TABLE 策略）；若含表重建则 checkpoint 备份 |
| ensure | 已 LATEST 库 ensure 路径：确认 DROP 触发器幂等 + 新索引 IF NOT EXISTS；**不得**在 ensure 重建触发器 |
| 回滚 | 迁移失败回滚依赖事务原子；不提供反向迁移（索引/DROP 可前滚修复） |
| 兼容 | 迁移期间旧触发器若仍在，message_count 可能短暂旧语义——迁移原子切换后立即走批末重算路径；首次 save 全量 rebase 可校准 count |

**与 D4 边界**：v12 只改 DB schema；前端 hydrate/dirty 不在本迁移 PR。前端传 batchVersion 已存在，Rust 接收后旧前端（未传）参数缺失时命令返回明确错误或兼容默认（**禁止静默当 CAS 通过**——兼容策略二选一写死并测试）。

---

## 9. 与 90 / 05 编号映射

| D3 任务 | 90 / 05 ID | 独立-01 |
| ------- | ---------- | ------- |
| D3-1 组提交接线 | 05-S1、05-S2、05-S4、05-W5 | T-L2-A |
| D3-2 reserve 单语句 | 05-W2 | T-L2-A ③ |
| D3-3 ReaderPool | 05-R1、05-R6 | T-L2-A ④ / CNV-1 |
| D3-4 增量+CAS+触发器 | 05-W1、03-I1 | T-L2-B |
| D3-5 索引 | 05-Q1、05-Q2、05-Q5、05-Q4 | T-L2-A/D 批 |
| D3-6 GC 出锁 | 05-G2、05-G6 | T-L2-A ⑥ |
| 池化统计接线 | 05-V2/V5/F 批观测 | 可挂 D13，D3 只暴露 stats |

---

## 10. 执行切片建议（逻辑单元，非工期）

| 单元 | 内容 | 依赖 |
| ---- | ---- | ---- |
| U-DB-COMMIT | 组提交接线 + 删写旁路 + FK/PRAGMA + reserve 单语句 | **U-NOPE 绿** |
| U-DB-READER | ReaderPool 纯读完备 | 可与 U-DB-COMMIT 并行（只读域） |
| U-DB-INC | save 增量 + CAS + DROP 触发器 + session_commands 签名 | U-DB-COMMIT |
| U-DB-IDX | v12 索引 + Q4 GC SQL | 可与 INC 同迁移窗口或紧随 |
| U-DB-GC | GC 独立连接/短临界区 | U-DB-COMMIT |

92 §10 首轮：`U-DB-COMMIT` 依赖 `U-NOPE`；第二波 `U-DB-INC`。与 `U-PERSIST-CUT`（D4）**不同 PR**。

---

## 11. 诚实边界（实现前必核）

1. rusqlite / 系统 SQLite **RETURNING** 支持与 Windows 构建矩阵（独立-01 §7.1）。  
2. `session_messages` id 与 seq 冲突的 UPSERT 键选择（PK `(session_id,seq)` vs `id` 语义）。  
3. `save_session_agents`（05-W7）是否并入本维——默认：**不**并热路径增量，文档标注勿在 350ms 热路径调用；若实现期证实热路径高频再登记 DEL。  
4. 组提交 SAVEPOINT 与增量 UPSERT 嵌套事务边界（独立-01 §7.10）——write 闭包内单事务设计定稿。  
5. batch_version 缺参兼容策略（见 §8）。  
6. mmap_size Windows 锁定范围实测。  
7. `query_all_runs` 全表（03-I4）在 ReaderPool 后是否仍需分页——本维只迁读池，分页归观测/D5 若需要。

---

## 12. 报告用摘要（主 Agent 回传）

| 项 | 结论 |
| -- | ---- |
| **路径** | 写 2→1（组提交唯一）；save 全量→增量；reserve 3→1；读主锁→ReaderPool；GC 出主锁；索引补 v12 |
| **迁移策略** | schema v11→v12：DROP 双触发器 + 事件/会话索引 + body_version（或 meta CAS）+ 批末 message_count；纯 DDL 事务 + user_version；不与 D4 同 PR |
| **负向断言** | 生产 conn.lock 写=0；writer 生产命中>0；全表 DELETE=0；触发器=0；batch_version 静默丢弃=0；reserve 热路径=1 语句；max_batch≥2；增量<20% 全量 |
| **硬依赖** | U-NOPE/D1 NoPersist 先绿（CFL-03）；前端 dirty 后于本维（CFL-02 票 B） |
| **禁止** | 与 D4 同 PR；git commit；引擎克隆同 PR（CFL-11）；只 debounce 冒充修复 |

---

*D3 详案完。未 git commit。评审轮对齐 review-detail 后进入实现派发。*
