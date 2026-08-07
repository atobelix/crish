# PERSIST-03 持久化体系并发 / 迁移 / 边界严格审计

- 审计类型：只读代码审计（并发控制 / schema 迁移 / 边界情况）
- 审计范围：conex-db（LocalDb / migrate / schema / sessions / messages / events / runs / agents / import）、orchestrator（persist / restore / events）、agent-workbench（core_run_commands / core_query_commands / session_commands / subagent_spawner）、crish-desktop（sessionRustDb / store-persistence / cacheMetricsCompute）
- 审计日期：2026-08-07
- 结论速览：**新发现 P0×0、P1×2、P2×9、P3×2**（P1 中第 1 条建议按 P0 处理，见 §8 说明）

---

## 1. 并发写竞态

### 1.1 单写者模型与结果语义

- 全部写路径共享同一把 `Arc<Mutex<Connection>>`（`crates/conex-db/src/lib.rs:41-44`），每个公开方法以 `self.conn.lock()` 开头并**持有锁至方法返回**（sessions.rs:10/30/80/125/141/160/178、messages.rs:57/116、events.rs:15/39/73/104、runs.rs:120/150/194/233/289/317/332/363、agents.rs:45/168/264/287/309）。
- **结果 = 锁获取顺序的「最后写者胜」，无交错**：`save_session_body` 的先删后插在同一事务内（messages.rs:62-101），`append_session_messages` 的 max(seq) 读取与插入在同一事务内（messages.rs:121-162）；同会话并发 save/append/upsert 被 Mutex 完全串行化，不存在半状态。
- 证据：`stress_write.rs:145-211`（8 线程 × 500 事件 + 8 次 upsert，无 failure latch、行数准确、序列唯一）；`tests.rs:86-108`（10 线程并发 append）。
- 边界：`upsert_session_entry` 用 `ON CONFLICT DO UPDATE` 而非 REPLACE，避免级联清空消息（sessions.rs:27-29，tests.rs:161-179 锚定）——同会话并发 upsert 是逐字段覆盖，无丢失级联风险。

### 1.2 死锁风险分析（未发现结构性死锁）

- 锁序一致：**tokio `handle` → tokio `queue` → spawn_blocking 闭包内 std `Mutex<Connection>`**（drive_run_loop 于 core_run_commands.rs:2219-2223 同时持 handle+queue；finalize_failed 于 :2489-2490；cancel 于 :3298-3307；approval resolve 于 :240-249）。
- 反向路径不存在：std Mutex 从不跨 await 持有（AA-02 并发模型注释，core_run_commands.rs:1907、:2251-2256、:2311-2316；subagent_spawner.rs:293-294）；`blocking_db_call` 闭包在阻塞线程上运行且不 await（persist.rs:559-568）。
- 结论：锁方向单射，无循环等待。审计范围内未发现死锁路径。

### 1.3 blocking_db_call 线程池语义

- `spawn_blocking` 只解决「不占用 tokio worker」；**所有 DB 操作仍串行化于单 Mutex<Connection>**，并发请求只是排队执行，无并行收益（persist.rs:564、lib.rs:41-44）。设计即单写者，压测验证吞吐可接受（stress_write.rs:207-210）。
- **例外（P2-4）**：`CoreRunState::run_usage`（core_run_commands.rs:1507-1523）在 async 命令线程上**同步直调** `db.get_run_usage`，不经 spawn_blocking（core_query_commands.rs:628 经 `core.run_usage` 调用）——与 P05 模式（session_commands.rs:5、persist.rs:552-558）不一致，会短暂阻塞 Tauri async worker。
- **串行化副作用（P2-5）**：`core_run_commands.rs:2148` 的 `spawn_blocking(save_run_usage)` 与 drive 收口的 `update_run_status` 都排队于同一 Mutex；两者写 runs 不同列，无丢失更新，但写放大期（前端 5000 条 save_session_body 全量重写，见 §4.2）会拖长所有 DB 操作的排队时间，包括 run 状态机写点。

### 1.4 前端层的乱序窗口（P1-2）

- 防抖 350ms（store-persistence.ts:136-144）是**唯一**的串行化手段；`persistAllSessionsRust` 无批次版本戳、无 CAS：
  - 两次防抖触发的 persist 可同时在途；`bodyJobs` 以 `Promise.allSettled` 并发写每个会话（sessionRustDb.ts:929-941）。
  - 测试**明示并接受**该乱序：「旧批次（晚完成）会覆盖新批次（无 updated_at CAS 哨兵）」——sessionRustDbWriteModel.test.ts:278-308，final = 旧批次 2 条而非新批次 4 条。
- 结果语义 = 「**后完成者胜**」而非「后提交者胜」：同一会话两条 save_session_body（全量替换）交错时，旧状态的 IPC 若晚到达（spawn_blocking 排队、Tauri 通道延迟），会以旧消息集覆盖新消息集，**用户消息丢失**。`updated_at` 列（D4 乐观锁预留，schema.rs:203）从未在写路径使用。
- 真实触发路径：run 进行中连续 commit（350ms 内两次 persist），或「hydrate 后的对齐 persist」（store-persistence.ts:267-271）与订阅 persist 并发。

---

## 2. 孤儿 / 清理竞态

### 2.1 机制与守卫

- `cleanup_orphan_sessions`（sessions.rs:177-241）：事务内 DELETE，宽限期 `updated_at < now - grace`（sessions.rs:202，默认 5 分钟 `ORPHAN_GRACE_MS=300_000`，lib.rs:53，session_meta `orphan_grace_ms` 可配 lib.rs:55）。
- 壳层守卫：空 keepIds 默认拒绝（session_commands.rs:94-101，`cleanup_orphan_empty_keep`）——防 P02 全库清空。
- 前端每次 persist 都会触发清理（sessionRustDb.ts:954）。

### 2.2 最严重发现（P1-1，建议按 P0 处理）：引擎创建的子代理会话被当孤儿删除

证据链：

1. **引擎创建独立子代理会话**：`subagent_spawner.rs:289` `session_id = format!("sub-sess-{depth}-{n}")`；`:306-331` 以 `SessionIndexEntry`（`updated_at: now`、`hydrated_from_engine: Some(true)`、标题「子代理 …」）`upsert_session_entry` 落库，并**永不再 touch**。
2. **该会话不在前端 store**：前端 store 只有种子会话与用户创建的会话；hydrate 以 LS 索引为真相源（sessionRustDb.ts:804-808），引擎侧写入 SQLite 的 sub-sess-* 不会进入 store。
3. **keepIds 不含子代理会话**：`persistAllSessionsRust` 的 keepIds = store 内会话集合（sessionRustDb.ts:928-954）。
4. **清理在 run 期间也照常执行**：run 内消息增量触发 store 变更 → 350ms 防抖 → persist → cleanup。
5. 后果（级联 DELETE，schema.rs:148/168/179 的 ON DELETE CASCADE）：
   - **长于 5 分钟的子代理 run 被中途删除**：run 记录、事件流被级联清掉；后续 `append_event` 因 FK 失败（events.rs:20-24）→ drive_outcome 持久化失败 → run 标记 failed（core_run_commands.rs:2475-2565 的 finalize_failed 路径）。`update_run_status` 缺行静默成功（runs.rs:154-170），无告警。
   - **短 run 的审计底账在结束 5 分钟后被静默清除**：子代理 run 的 events 审计流、runs 行（含 v5 usage 列）全部消失；restore 的「run 派生会话」恢复面（restore.rs:612-623）失效。
   - run 内 `reserve_sequence` 计数行也被删（session_sequence），若 run 中途被删后重开新 run，sequence 会从 max(events)+1 重新续接（events.rs:78-83）——计数不冲突但审计断链。

修复建议：① 清理 SQL 排除 `hydrated_from_engine = 1` 的会话（或引擎创建会话不落 sessions 索引表）；② keepIds 前端侧并集 SQLite `list_sessions`；③ cleanup 后置校验「是否存在 running/queued run 属于被删会话」并回滚/告警。

### 2.3 次要竞态

- **boot 窗口部分索引（P2-7）**：hydrate（store-persistence.ts:148-154）与订阅 persist（:128-145）并发；若 LS 索引是**部分**状态（非空但不全，例如配额写失败过的旧镜像），persist 的 keepIds 只覆盖 LS 可见会话，SQLite-only 会话（>5 分钟）会在 hydrate 有机会展示前被删。
- **run 活动不推进 updated_at（P2-9）**：`touch_session`（sessions.rs:244-257）引擎与前端均无调用方（sessionPersistence.ts:68 注释：「touchSession … 移除且无消费方」）；run 引擎写 events 不刷新 sessions.updated_at。主会话靠 keepIds 保护不受影响，但「宽限期 vs 长 run」的实际防线只是 keepIds 集合，而非时间窗。
- 宽限期语义本身正确（orphan_grace_contract.rs 全用例锚定：宽限期内保留、keepIds 恒保留、空 keep 仍保护）。

---

## 3. 迁移正确性（v1→v6）

### 3.1 每步迁移要点与证据

| 步骤  | 操作                                                                                                                               | 幂等性                                    | 证据               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------ |
| v1→v2 | sessions 补 9 列（纯 ADD COLUMN）                                                                                                  | col-check 幂等                            | migrate.rs:220-242 |
| v2→v3 | session_agent_messages 重建补 CHECK（数据拷贝）                                                                                    | 重跑安全（已重建表再 RENAME 无冲突）      | migrate.rs:245-274 |
| v3→v4 | events 组合主键重建 + FK；metadata 删除；runs/pending 加 FK + 孤儿过滤；session_messages 加 updated_at；session_sequence 重建/建表 | 重跑安全（同 v2→v3 论证）；孤儿计数可观测 | migrate.rs:279-380 |
| v4→v5 | runs 补 9 个 usage 列 + session_messages 补 usage_json（纯 ADD COLUMN）                                                            | col-check 幂等                            | migrate.rs:399-421 |
| v5→v6 | session_agents 补 task_type / display_label / allowed_write_paths_json（纯 ADD COLUMN）                                            | col-check 幂等；缺表守卫                  | migrate.rs:437-459 |

- FK 开启时机：`PRAGMA foreign_keys = ON` 在 migrate() 开头、一切事务之前（migrate.rs:104）；重建时 INSERT…SELECT 已按存在性过滤（migrate.rs:311-313、329-331、344-346、366-368），FK 约束在拷贝期不炸。
- 备份时序确定化：每版本「wal_checkpoint(TRUNCATE) → 拷贝 .bak-vN」先于版本事务 commit（migrate.rs:146-167，11-T2）；备份失败告警不阻断（migrate.rs:74-89、tests/migrations.rs:883-903 锚定）；v5/v6 纯 ADD COLUMN 跳过备份（migrate.rs:149-153）。

### 3.2 迁移中断恢复（部分迁移状态）

- 每版本独立事务（migrate.rs:168-189）；**tx 内崩溃 → SQLite 回滚，无半状态**。
- **`PRAGMA user_version = N` 在事务之外执行**（migrate.rs:190-191）：commit 后、写版本前崩溃 → 重开时版本滞后一步，但所有步骤幂等（col-check / RENAME-重建），重跑安全。测试锚定：`migrate_v4_to_v5_idempotent_rerun`（tests.rs:712-743）、`second_open_idempotent_no_extra_backups`（tests/migrations.rs:615-637）。
- 唯一未锚定的窗口：**备份文件在 tx 外写入**（migrate.rs:156-165），checkpoint 后、拷贝完成前崩溃会留下半写 .bak 文件（best-effort 辅助文件，不影响主库正确性；P3-2）。
- 迁移期间持锁（migrate.rs:99-102 持 conn 锁全程），单写者下无并发迁移窗口；**多进程双开同一库文件**时两个进程可同时迁移（无进程级文件锁）——Tauri 单实例假设成立，P3-1 登记。

### 3.3 数据拷贝丢失面

- **P2-6（潜在迁移失败面）**：v2→v3 的 INSERT…SELECT 若旧行 status 含新 CHECK 之外的值（v1/v2 时代该列无 CHECK，schema.rs:77），整条 INSERT 违反 CHECK → **迁移整体失败**（非静默丢行），需人工用 .bak 恢复。v3→v4 的过滤是「会话存在性」而非「值域校验」，同理会话行内非法值（如 sessions.title 无约束，无碍）。建议：v2→v3 前先做非法行计数，写入 session_meta 可观测（对齐 v4 的 `migration_v4_dropped_orphans` 手法，migrate.rs:296-299），或对非法行先行归一化。
- `record_schema_version` 两条语句（INSERT OR IGNORE + UPDATE）非事务（migrate.rs:203-215），崩溃窗口 JS 观测值可能滞后——纯观测用途，P3。

### 3.4 版本记录

- 双权威：`PRAGMA user_version`（migrate.rs:109-111）与 session_meta `schema_version`（migrate.rs:203-215）——有测试保证二者一致（tests.rs:374-381、migrations.rs:481-486）。

---

## 4. 边界数据

### 4.1 空会话 / 无消息

- `load_session_body` 空 vec（messages.rs:9-48）；前端 `loadSessionBody` 对空/哨兵 id 直接返回 []（sessionRustDb.ts:606）；persist 对空消息**不调用** save_session_body（sessionRustDb.ts:926-927、936-938，防懒壳空数组擦库，测试锚定 :424-443 区间）。
- `self_heal_then_save_body`（session_commands.rs:106-113）对空数组仍会补建会话行——空标题幽灵行，P2-3 登记。

### 4.2 超多消息 / 写放大

- 5000 事件顺序写、8×500 并发写、2000 条全量保存均有压测（stress_write.rs:110-137、145-211、220-252）。
- `save_session_body` 每 commit 全量重写整个会话（DELETE+INSERT，messages.rs:66-98），**逐行 execute（非批量）**；前端每次 persist 全量调用 → 5000 条消息的会话每次落盘 = 5000 次 INSERT + 触发器逐行 UPDATE message_count（schema.rs:255-265）。写放大已知（AA-06 P6），`append_session_messages` 增量路径存在但前端未使用。性能面非本次审计故障，登记为 P2-8（建议前端引入增量追加或批量绑定）。

### 4.3 超长消息 / 特殊字符 / 损坏 JSON

- TEXT 列无长度上限；rusqlite 参数化绑定防注入与编码问题（messages.rs:80-95 等）。
- 损坏 events payload：`parse_envelopes` 跳过、整页不中断（core_query_commands.rs:483-491，测试 :857-879）；分页游标基于**已解析**条目（:527-532），损坏行不会造成无限翻页。
- 损坏 usage_json：前端 `safeParseJson` + `computeCacheMetricsFromUsage` 全守卫（cacheMetricsCompute.ts:26-36、50-112，坏值 → null → undefined），测试锚定（sessionRustDb 回读路径）。
- 损坏 blocks_json / toolCallsJson：`parseJsonArray` 兜底 [] + `parseSessionMessage` 白名单守卫（sessionRustDb.ts:255-258、309）。
- 未知 run status 字面量：`RunStatus::Unknown` 保真透传，restore 不打断不改写（runs.rs:20-35、376-392；restore.rs:552-564）。
- **无崩溃路径确认**：全部读回侧均有容错；写侧 payload 不经解析直接落库（events.rs:20-24 原样字节），无二次编码问题。

---

## 5. 游标 / 序列

### 5.1 reserve_sequence 原子性

- 单进程内**原子**：seed（INSERT OR IGNORE + MAX(sequence)+1 对齐）→ SELECT → UPDATE 三步（events.rs:72-99）全程持 conn Mutex，读-改-写串行化；InMemory 镜像语义对齐（persist.rs:393-417）。
- **P2-2（跨连接非原子）**：三步并非 SQLite 单语句原子——同一库文件被第二个连接/进程打开（测试探针连接、多实例、外部工具）时，两次并发取号可能读到相同 next_sequence（TOCTOU 复现：SELECT N → 双方 UPDATE N+1 → 双发 N）。生产单实例假设下不触发，但修复成本低：bump 改单语句 `UPDATE … SET next_sequence = next_sequence + 1 WHERE session_id=? RETURNING next_sequence - 1`，seed 合并为 `INSERT … ON CONFLICT DO UPDATE SET next_sequence = MAX(next_sequence, excluded…)`。
- 注释声称「单语句原子性」（events.rs:84）与实现（3 语句）不符——文档偏差，P3。

### 5.2 restore 续接 / 并发取号

- 恢复预热：`seed_sequences`（core_run_commands.rs:1688-1712）按 `max(sequence)+1` 预热缓存 + store seed（MAX 语义幂等，events.rs:103-121）；**门禁**：`restore_ready` 在 seed 之后才放行（core_run_commands.rs:1735、2674-2676），Q24 竞态已封。
- 取号失败兜底：本地镜像 +1 且返回错误（events.rs:151-157、171-177）——不产生重复号，可能产生空洞（空洞无害，恢复锚点为 max 而非连续性）。
- 会话内串行守卫（core_run_commands.rs:2686-2693）+ 子代理用独立会话（subagent_spawner.rs:289）→ 同会话无双 run 取号。
- 审计 worker 与 drive 共用同一 `Arc<Mutex<EventQueue>>`（core_run_commands.rs:497-514、2818-2822）→ 取号+落库按队列锁序串行，无同号竞争。

---

## 6. 事务边界

### 6.1 有事务的操作（中途失败不留半状态）

`save_session_body`（messages.rs:62-101）、`append_session_messages`（:121-162）、`save_session_agents`（agents.rs:173-244）、`cleanup_orphan_sessions`（sessions.rs:183-238）、`import_from_localstorage`（import.rs:41-222，单事务全量回滚）、迁移每步（migrate.rs:168-189）。

### 6.2 多语句无事务 / 事务外副作用

| 位置                                                   | 问题                                                                   | 级别      |
| ------------------------------------------------------ | ---------------------------------------------------------------------- | --------- |
| session_commands.rs:106-113 `self_heal_then_save_body` | 自愈 INSERT（自动提交）与正文事务分离：正文保存失败 → 幽灵空会话行残留 | P2-3      |
| migrate.rs:190 版本 pragma 在 tx 外                    | commit 后崩溃 → 版本滞后，靠幂等兜底（已论证安全）                     | 设计内    |
| migrate.rs:146-167 备份在 tx 外                        | 崩溃窗口可能半写备份文件（best-effort）                                | P3-2      |
| migrate.rs:203-215 schema_version 两语句               | 非事务，观测值可能滞后                                                 | P3        |
| sessionRustDb.ts:630-639 双轨写                        | SQLite 成功后再镜像 LS；LS 配额失败静默 → 双轨不一致（见 §7.3）        | P2-7 同源 |
| runs.rs:154-170 `update_run_status` 缺行静默           | 行被级联删除后状态更新无感知（与 P1-1 同源）                           | P1-1 子项 |

### 6.3 内存 / DB 顺序一致性

- run usage 双源：引擎内存态（`engine.update_cache_session`，core_run_commands.rs:2435-2437）与 runs 表 v5 列（DB，:2444-2466）——前端查询以 DB 为准（core_query_commands.rs:628），收口顺序为「先内存后 DB」，读侧无强一致要求，未发现顺序破坏。
- 快照是**近似一致**（build_and_save_snapshot 注释，core_run_commands.rs:1802-1804）：快照期间并发 append 的事件由恢复增量流补足（restore.rs:631-658），设计内。

---

## 7. 前端并发

### 7.1 防抖 persist 与 hydrate 竞态

- 订阅 350ms 防抖（store-persistence.ts:128-145）与 boot hydrate（:148-154）并发；hydrate 完成后有对齐 persist（:267-271）；「只补空正文、不覆盖已有消息」保护内存态（:195-239）。
- **乱序覆盖窗口（P1-2）**：详见 §1.4。防抖只降低频率，不保证顺序；测试明示无 CAS 哨兵（sessionRustDbWriteModel.test.ts:278-308）。

### 7.2 LS 配额满降级

- 全部 `ls*` 写 try/catch 静默（sessionRustDb.ts:424-433、505-517、531-543 等）；invoke 失败（含配额无关的 error）一律回退 LS（:22-25、593-612 等三态协议）。
- **真相源 = LS 索引**（sessionRustDb.ts:804-808）——LS 索引一旦因配额/损坏缺失部分会话，SQLite 侧对应会话「不可见 + 5 分钟后被 cleanup 删除」（P2-7，§2.3）。

### 7.3 双轨不一致窗口

- 正常路径：SQLite 主存 + LS 镜像（invoke 成功后镜像，sessionRustDb.ts:630-635）；hydrate 正文以 SQLite 为准、索引以 LS 为准——镜像只读于「invoke 缺失」降级路径。
- beforeunload 同步 flush 只写 LS（sessionRustDb.ts:1015-1071）：重启后正文走 SQLite 读，**LS flush 的数据不保证被回读**——最后一批 LS-only 数据仅在降级路径可见（P2-10，方向=LS 较新、SQLite 较旧，重启后 SQLite 回读丢最后窗口；触发条件是退出时恰有未完成 persist 的变更）。

---

## 8. 新发现问题清单

| 编号  | 级别                     | 问题                                                                                                                                                                                                                             | 证据                                                                                                                                                    | 修复建议                                                                                             |
| ----- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| P1-1  | **P1（建议按 P0 处理）** | 引擎创建的子代理会话（sub-sess-*）不在前端 keepIds，宽限期（5 分钟）后被每次 persist 触发的孤儿清理级联删除：>5 分钟的子代理 run 中途 FK 失败被打断标记 failed，审计事件流 / runs 记录（含 usage）静默清除，restore run 派生失效 | subagent_spawner.rs:289/306-331；sessionRustDb.ts:928-954；sessions.rs:215；schema.rs:148/168/179；events.rs:20-24；runs.rs:154-170；restore.rs:612-623 | 清理排除 hydrated_from_engine=1 会话；keepIds 并集 SQLite list；cleanup 后校验被删会话无 running run |
| P1-2  | **P1**                   | 前端 persist 无批次版本戳：同会话两次全量保存并发在途时，后完成的旧批次覆盖新批次 → 用户消息丢失（测试明示接受该行为）                                                                                                           | sessionRustDbWriteModel.test.ts:278-308；store-persistence.ts:136-144；sessionRustDb.ts:929-941；schema.rs:203（updated_at 列闲置）                     | 写路径启用 updated_at 乐观锁（CAS）；或 persist 层串行化/丢弃过期批次                                |
| P2-1  | P2                       | reserve_sequence 三步读-改-写依赖进程内单 Mutex，跨连接/进程不原子（注释与实现不符）                                                                                                                                             | events.rs:72-99（注释 :84）                                                                                                                             | 单语句 UPDATE…RETURNING 合并 seed                                                                    |
| P2-2  | P2                       | boot 窗口部分 LS 索引 + 静默配额失败 → SQLite-only 会话不可见且被 cleanup 删除（LS 真相源设计的丢失路径）                                                                                                                        | sessionRustDb.ts:804-808/906-915；store-persistence.ts:148-154                                                                                          | cleanup 前并集 SQLite 索引；LS 索引写失败显式降级 SQLite 为真相源                                    |
| P2-3  | P2                       | self_heal 与正文保存非同一事务：正文失败残留幽灵空会话行                                                                                                                                                                         | session_commands.rs:106-113                                                                                                                             | 合并到同一事务或成功后清理空壳                                                                       |
| P2-4  | P2                       | run_usage 同步直调 get_run_usage 阻塞 async 命令线程（违反 P05 模式）                                                                                                                                                            | core_run_commands.rs:1507-1523；core_query_commands.rs:628                                                                                              | 改 spawn_blocking                                                                                    |
| P2-5  | P2                       | 前端全量 save_session_body 写放大（逐行 INSERT + 触发器逐行计数），5000 条会话每次 persist 全量重写；与 run 状态写点共用 Mutex 排队                                                                                              | messages.rs:66-98；schema.rs:255-265；stress_write.rs:213-252                                                                                           | 前端接入增量追加 / 批量绑定 / 增量计数触发器                                                         |
| P2-6  | P2                       | v2→v3 重建 INSERT…SELECT：旧行 status 违反新 CHECK → 迁移整体失败（无可观测、无自动恢复）                                                                                                                                        | migrate.rs:245-274；schema.rs:77                                                                                                                        | 迁移前非法值计数入 session_meta / 归一化                                                             |
| P2-7  | P2                       | 孤儿清理与进行中 run 无联动校验（updated_at 由前端 persist 驱动，引擎写事件不 touch；防线只有 keepIds）                                                                                                                          | sessions.rs:244-257；sessionPersistence.ts:68；sessionRustDb.ts:954                                                                                     | cleanup 前后校验 running run；引擎 touch_session                                                     |
| P2-8  | P2                       | failure latch 一旦置位永不清除（clear_failure 无生产调用方），单次瞬时错误后 db_ready 恒 false，且前端按「missing」语义整体回退 LS（掩盖真实 DB 状态）                                                                           | lib.rs:92-108；session_commands.rs:55-58；tests.rs:79-83                                                                                                | latch 分级/超时自动清除；前端区分 missing 与 error                                                   |
| P2-9  | P2                       | 快照会话注册表 self.sessions 仅在 restore 时填充，运行期新建会话不入注册表 → 快照缺失无 run 会话的树状态（快照内 sessions 与 DB 漂移）                                                                                           | core_run_commands.rs:1806/1729-1733；run_task_impl 无注册点                                                                                             | 运行期注册会话树变更 / 快照并集 DB sessions                                                          |
| P2-10 | P2                       | beforeunload 同步 flush 只写 LS，重启后正文以 SQLite 为准 → 最后一批 LS-only 变更不保证回读                                                                                                                                      | sessionRustDb.ts:1015-1071                                                                                                                              | flush 前 await 在途 persist（事件循环内先清防抖再退出）                                              |
| P3-1  | P3                       | 多进程双开同一 DB 无进程级文件锁（迁移/取号假设单实例）                                                                                                                                                                          | migrate.rs:99-102；events.rs:72-99                                                                                                                      | 启动时文件锁                                                                                         |
| P3-2  | P3                       | 备份文件在 tx 外写入，崩溃窗口可能半写（best-effort 辅助文件）                                                                                                                                                                   | migrate.rs:146-167                                                                                                                                      | 临时文件 + rename 原子落盘                                                                           |

---

## 竞态场景表

| #   | 场景                                | 参与方                                     | 竞态窗口                           | 结果                                                                | 现防护                             | 级别           |
| --- | ----------------------------------- | ------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------- | ---------------------------------- | -------------- |
| R1  | 长子代理 run vs 前端 persist 清理   | 子代理 run（引擎）↔ persistAllSessionsRust | run 持续 > 5 分钟                  | 子代理会话级联删除 → append FK 失败 → run failed；审计/run 记录丢失 | 仅宽限期（引擎不 touch，防线失效） | P1-1           |
| R2  | 同会话两次全量 save 交错            | persist 批次 A（旧）↔ 批次 B（新）         | 两批同时在途                       | 旧批次后完成 → 覆盖新批次 → 消息丢失                                | 350ms 防抖（不保证顺序）           | P1-2           |
| R3  | boot hydrate vs 订阅 persist        | hydrateSessionsFromRust ↔ 350ms persist    | LS 索引部分/陈旧                   | SQLite-only 会话不可见且被 cleanup 删除                             | 空 keepIds 守卫（部分索引时失效）  | P2-2           |
| R4  | reserve_sequence vs 第二连接        | LocalDb 主连接 ↔ 探针/多实例               | SELECT 与 UPDATE 之间              | 双发同号（生产单实例不触发）                                        | 进程内单 Mutex                     | P2-1           |
| R5  | save_session_body vs cleanup_orphan | 前端写正文 ↔ 前端清理                      | 不同会话并行                       | 各自事务原子，互不交错                                              | Mutex + 事务                       | 安全           |
| R6  | drive 收口 vs save_run_usage        | drive_run_loop ↔ write_back_cache_stats    | spawn_blocking 排队                | 串行执行、写不同列，无丢失更新                                      | Mutex 排队                         | 安全           |
| R7  | 审计 worker vs drive 事件落库       | spawn_audit_persistence ↔ drive_outcome    | 共享 EventQueue                    | 序列按队列锁序分配，无同号                                          | Arc<Mutex<EventQueue>>             | 安全           |
| R8  | 迁移崩溃重开                        | migrate 各步                               | tx commit 与 user_version 写入之间 | 版本滞后，步骤幂等重跑，无数据损坏                                  | 每步幂等 + 事务                    | 安全（设计内） |
| R9  | 宽限期窗口内新建会话                | cleanup_orphan_sessions                    | 新建会话 updated_at 距今 < 5 分钟  | 保留                                                                | 宽限期 + keepIds                   | 安全           |
| R10 | restore 预热 vs 新 run              | run_restore ↔ run_task_impl                | restore 未完成                     | 新 run 拒绝（Q24 门禁）                                             | restore_ready                      | 安全           |

---

## 最严重 5 个问题

1. **（P1，建议升级 P0）子代理会话被孤儿清理级联删除**：`subagent_spawner.rs:289/306-331` 引擎创建 sub-sess-* 会话且永不刷新 updated_at；前端每次 persist 的 `cleanup_orphan_sessions`（sessionRustDb.ts:954）在 5 分钟宽限期后将其级联删除（schema.rs:148/168/179）——长于 5 分钟的子代理 run 中途 FK 失败被标记 failed，全部子代理审计事件与 run 记录（含 usage）静默清除，重启恢复的 run 派生面（restore.rs:612-623）失效。
2. **（P1）前端 persist 无批次版本戳的乱序覆盖**：`sessionRustDbWriteModel.test.ts:278-308` 明示「旧批次晚完成覆盖新批次」且无 CAS 哨兵；`updated_at` 乐观锁列（schema.rs:203）闲置。同会话两条全量保存交错时后完成的旧状态覆盖新状态，用户消息丢失。
3. **（P2）LS 索引真相源 + 静默配额失败 → SQLite-only 会话不可见并被清理删除**：`sessionRustDb.ts:804-808` 以 LS 索引为唯一真相源，写失败静默（:906-915）；索引缺失的会话对用户不可见，且 5 分钟后被 cleanup 删除（boot 窗口 R3 路径）。
4. **（P2）reserve_sequence 三步读-改-写仅靠进程内 Mutex 原子**：`events.rs:72-99` 注释声称单语句原子（:84）与实现不符；跨连接/多进程并发取号存在 TOCTOU 双发同号窗口（生产单实例假设，修复成本低）。
5. **（P2）run_usage 同步直调 + failure latch 永久闩死**：`core_run_commands.rs:1507-1523` 在 async 线程同步查 DB（违反 P05 模式）；`lib.rs:92-108` 的 latch 一旦置位永不自动清除（`clear_failure` 无生产调用方），`db_ready` 恒 false 且前端按「missing」整体回退 localStorage，掩盖真实 DB 状态。

---

## 审计方法说明

- 全部结论基于只读代码审查与现有测试锚点；未运行任何测试（子 Agent 只读约束）。
- 证据均以 `文件路径:行号` 标注，可复核。
- 边界说明：`cleanup_orphan_sessions` 的任务描述口径「30 分钟保留窗口」与代码常量不符——实际为 5 分钟（lib.rs:53，`ORPHAN_GRACE_MS=300_000`），文档注释与实现一致，仅任务描述口径差异。
