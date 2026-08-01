# AA-07 数据持久化审查（conex-db + orchestrator 持久化 + 前端会话缓存）

> 日期：2026-08-01 · 范围：crates/conex-db（全量）、crates/orchestrator（persist/restore/events）、crates/conex-compaction、apps/agent-workbench/src-tauri（session_commands/core_run_commands/main）、apps/crish-desktop（session-persistence / store-persistence）· 只读审查，未改代码
> 结论摘要：SQLite 单库（app_dir()/sessions.db）承载 9 张表，事件/run/会话索引同库；前端以 localStorage 索引为真相源、SQLite 为主存储的过渡架构存在两个**数据丢失级**缺陷（新会话永不落 SQLite；boot 窗口孤儿清理可全表清空），事件表无 FK/无清理策略持续膨胀，B4.3 恢复/快照机制仅存在于测试、生产未接线。

---

## 一、总览

| 存储面 | 现状 | 问题数 |
| --- | --- | --- |
| conex-db schema（9 表） | 单连接 `Arc<Mutex<Connection>>`，FK 开启，无 WAL/无 busy_timeout | 6 |
| 事件持久化（events/EventQueue） | 单语句原子 INSERT + UNIQUE(session_id,sequence)；delta 不落库；失败 latch | 3 |
| 恢复/快照（restore.rs） | 快照双文件+checksum+回退，测试覆盖全；**生产未接线** | 2 |
| run 生命周期（runs/pending_inputs） | 9 态状态机落库；cursor 列死列；pending FIFO | 2 |
| 前端会话缓存（sessions.db ↔ localStorage） | SQLite 主存储 + LS 索引真相源 + 30 天清理 | 5 |
| conex-compaction | 纯内存压缩算法（max_tokens 预算 + 摘要占位），不涉及持久化，无问题 | 0 |

问题合计：阻塞 2、重要 9、建议 7（共 18 项）。

---

## 二、问题清单

| 编号 | 文件:行号 | 严重度 | 描述 | 建议 |
| --- | --- | --- | --- | --- |
| P01 | apps/agent-workbench/src-tauri/src/session_commands.rs:73-238（11 命令无 upsert_session_entry）；crates/conex-db/src/lib.rs:70,144-159（foreign_keys=ON + session_messages FK） | **阻塞** | 迁移后 UI 新建的会话不在 sessions 表（无任何 Tauri 命令创建会话行，`upsert_session_entry`/`insert_session` 均未暴露）。save_session_body 向 session_messages INSERT 时 FK 校验失败 → 前端静默回退 localStorage。后果：全新装机/迁移后新会话**永远只存在于 localStorage**，SQLite 变成死库；30 天后 runMigrationCleanupIfNeeded 清理 LS（migrateFromLocalStorage.ts:187-233）会把这些"仅 LS 存在"的会话连索引带正文永久删除。 | 暴露 `upsert_session_entry` Tauri 命令，persistAllSessionsRust 先 upsert 索引再写 body；或 save_session_body 内对缺失会话行做 `INSERT OR IGNORE INTO sessions(id,title)` 自愈；清理 LS 前按 SQLite 会话集合核对。 |
| P02 | apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts:818-845；crates/conex-db/src/lib.rs:834-836；store-persistence.ts:115-132 | **阻塞** | 孤儿清理以内存 store 的 keepIds 为准且无条件执行：`active_ids` 为空时 Rust 侧 `DELETE FROM sessions` 全表删除（级联 messages/agents）；同一调用还会 `lsSaveSessionIndex([])` 清空 LS 索引真相源。触发条件：LS 已被 30 天清理清空、SQLite 有数据、boot 窗口内（hydrate 完成前）发生任何会话域变更 → 350ms debounce 触发 persist → 全库清空且无重建路径（events/runs 无 FK 无法反推 sessions）。 | Rust 侧对空 active_ids 拒绝全删（或要求显式 `confirm=true`）；前端 persist 前守卫 `hydrationComplete && list.length > 0`；LS 索引清空同样加守卫；清理与写入合并为单事务顺序。 |
| P03 | crates/conex-db/src/lib.rs:126-134（events 无 REFERENCES） | 重要 | events 表无 FK 且 delete_session/cleanup_orphan_sessions 均不清理事件 → 会话删除后事件永久残留；无 retention、无 VACUUM，长会话事件表无上限增长，增量查询（query_events）与快照保存随 DB 体积劣化。 | events 加 `REFERENCES sessions(id) ON DELETE CASCADE`（或 delete_session 显式清事件）；引入事件保留策略（保留 run-terminal + 近 N 条，或按快照裁剪）；定期 `PRAGMA incremental_vacuum`。 |
| P04 | crates/conex-db/src/lib.rs:1313-1334（update_run_status 不写 cursor）；apps/agent-workbench/src-tauri/src/core_query_commands.rs:213-228 | 重要 | runs.cursor 仅在 insert_run 时写一次（恒 0），终态 run 的 core_get_run_snapshot 返回 cursor=0（真实游标只存在于内存 next_sequences 缓存与事件表）。该列当前是死列，且会让依赖它的消费方（快照/前端）拿到错误游标。 | 终态回写 cursor（update_run_status 增加 cursor 参数，finalize 时写入最后 sequence）；或删除该列，快照 cursor 改为查事件表 max(sequence)。 |
| P05 | crates/orchestrator/src/persist.rs:396-472 | 重要 | LocalDbStore 全部方法为同步直调（`self.db.append_event(...)`），未包 spawn_blocking，与 session_commands.rs 的模式不一致：append_event 持 Mutex 阻塞 tokio worker 线程，磁盘 I/O 期间占用线程池；run 事件追加与前端 11 个命令并发争用同一把锁，慢盘场景（InMemoryStore 测试已模拟 40ms/条）会拖慢前端保存与查询。 | LocalDbStore 各方法内部包 `tokio::task::spawn_blocking`（或集中到专用阻塞线程池）。 |
| P06 | crates/orchestrator/src/restore.rs:489-623；apps/agent-workbench/src-tauri/src/main.rs:136-206 | 重要 | B4.3 恢复/快照机制（in-flight→interrupted、previousStatus 审计、pending 恢复、快照回退）**只在测试中运行**：生产 main.rs setup 仅建库建 RunManager，从未调用 RestoreManager::restore，也从未 save_snapshot。崩溃重启后 runs 表残留 in-flight 行（running）永不标记 interrupted，快照文件从不产生。 | main.rs setup 接线：open 后 `RestoreManager::restore(&store, &SnapshotFileStore::new(app_dir()/orchestrator-snapshot.json))`，恢复成功后保存快照；把恢复结果注入 CoreRunState。 |
| P07 | crates/conex-db/src/lib.rs:63-266 | 重要 | 迁移非版本化：每次 open 无条件执行；旧表检测靠"缺 folder 列 / SQL 缺 CHECK(status IN"字符串判断，命中即 DROP（无备份、无回滚）；schema_version 用 `INSERT OR IGNORE` 写入 '3'，一旦写入永不更新（无法演进 v4）；任务书 v3→v4 迁移在当前代码中**不存在**；DROP 分支（sessions_old / agent_messages_old）**零测试覆盖**（唯一相关测试 schema_version_is_three 只断言版本号）。 | 改为基于 `PRAGMA user_version` 或 session_meta 版本检查的逐步迁移（每版本一个迁移函数 + 幂等标记）；为 v2→v3、旧表 DROP 路径补迁移测试（构造旧库 → open → 断言结构与数据）；DROP 前备份或改 ALTER 重建。 |
| P08 | apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts:780-845；crates/conex-db/src/lib.rs:490-541 | 重要 | 双写冲突风险：save_session_body 为全量"先删后插"替换；当前唯一写者是前端（引擎只写 events），一旦引擎水合路径（hydratedFromEngine 列已预留）开始写 session_messages 即互相覆盖；且前端 Promise.all 并发 per-session invoke + 350ms debounce，快照间若引擎事件落地与新消息写入交错，全量替换会吞掉对方刚写入的内容。 | 为 session_messages 引入 updated_at/版本乐观锁或增量 append（append_session_messages 已存在）；双写启用前先定义 writer 所有权；全量替换仅限"前端拥有"的会话。 |
| P09 | apps/crish-desktop/src/api/session-persistence/migrateFromLocalStorage.ts:187-233；sessionRustDb.ts:706-710 | 重要 | 30 天清理与"LS 索引是真相源"自相矛盾：清理删除全部 crish_session_* key 后，hydrate 回退 SQLite 索引——但若期间 SQLite 未同步（P01 的新会话、P02 的误删），会话列表永久缺失；清理时不校验 SQLite 是否已有对应数据。 | 清理前按 SQLite 会话集合核对，仅删除 SQLite 中已存在的会话对应 key；把索引真相源切换为 SQLite（list_sessions 优先），LS 降级为纯回退。 |
| P10 | apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts:816-831 | 重要 | 空 body 跳过写入的防护（防懒壳擦除）与孤儿清理存在张力：prepareSessionsForUi 剪枝的非活动空壳不在 keepIds，其 SQLite body/agents 会被 cleanup_orphan_sessions 级联删除——恰好打中"懒壳正文尚未 hydrate 进内存"的场景（正文在 SQLite、内存为空壳 → 被剪枝 → 被删）。 | 清理排除 updated_at 近期的会话；或清理前对 keepIds 之外的行做"内存确认为空"二次校验；或干脆把清理延迟到 hydration 完成后的显式时机。 |
| P11 | crates/conex-db/src/lib.rs:107-123（sessions 表）、126-134、219-230、235-241 | 建议 | 时间戳格式三套并存：sessions.timestamp 为 ISO-8601 TEXT（带 T）、events.created_at 为 `datetime('now')` TEXT（无 T、无毫秒、UTC）、runs/pending_inputs/session_messages 为 epoch ms INTEGER。跨表排序/比较需逐列特判，前端 coerceSessionTimestamp 为兼容补丁。 | 统一为 epoch ms INTEGER（或全表 ISO-8601 带 T+毫秒）。 |
| P12 | crates/conex-db/src/lib.rs:139-142 | 建议 | `metadata` 表创建后从未使用（真实表是 session_meta），死 schema。 | 删除或并入 session_meta。 |
| P13 | crates/conex-db/src/lib.rs:133,136-137 | 建议 | `idx_events_session_seq` 与 `UNIQUE(session_id, sequence)` 隐式索引完全重复，冗余索引造成写放大。 | 删除显式索引，仅保留 UNIQUE 约束。 |
| P14 | crates/conex-db/src/lib.rs:126-127 | 建议 | events.id `INTEGER PRIMARY KEY AUTOINCREMENT`：有 UNIQUE(session_id,sequence) 组合键后自增主键冗余，AUTOINCREMENT 额外维护 sqlite_sequence 表。 | 改 `INTEGER PRIMARY KEY`（去 AUTOINCREMENT）或改用组合主键。 |
| P15 | crates/conex-db/src/lib.rs:33-37 | 建议 | open 时未配置 `journal_mode=WAL` 与 `busy_timeout`：当前单进程单连接无碍，但一旦 daemon 与壳双进程打开同一 sessions.db（或未来多窗口），缺 WAL 会造成锁竞争、缺 busy_timeout 会立即 SQLITE_BUSY 失败。 | open 时执行 `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`（migrate 前）。 |
| P16 | crates/orchestrator/src/restore.rs:422-446 | 建议 | 快照保存失败（轮转后 rename 失败）无显式标记：主文件缺失/损坏时回退 .prev 旧快照，增量重放依赖 session-leaf-moved 幂等性（apply_leaf_move 覆盖赋值，可接受），但 last_sequence 回退可能使同一批事件被重放两次（对叶子移动无害，对其它事件类型无重放逻辑——当前快照仅含会话树/run/pending，安全）。边界正确，建议补日志与状态暴露。 | save_snapshot 失败时写审计日志/状态字段，并在下一次启动 restore 的 snapshot_note 中体现。 |
| P17 | apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts:903-957 | 建议 | beforeunload 同步路径与 SQLite 主路径双写：崩溃时 LS 镜像与 SQLite 可能分叉（LS 有、SQLite 无，或反之），依赖下次 persist 收敛；过渡设计可接受，但 30 天清理后该镜像失效。 | 30 天清理后移除 LS 镜像写（仅保留 SQLite 单写路径）。 |
| P18 | apps/crish-desktop/src/api/session-persistence/sessionPersistenceTypes.ts:15；sessionRustDb.ts:573 | 建议 | 协作 agent 落盘上限 `SESSION_AGENTS_SAVE_CAP = 40`：第 41 个起的 agent 及其消息在保存时被静默截断（LS 与 SQLite 两侧一致），超出部分数据丢失无提示。 | 上限改为软提示（UI 警告）或分页存储；至少写入 session_meta 记录截断事实。 |

---

## 三、schema 现状表（conex-db，9 表）

| 表 | 列（要点） | 索引/约束 | 用途 | 问题 |
| --- | --- | --- | --- | --- |
| sessions | id(PK) title folder is_pinned is_archived branch_parent_id timestamp(TEXT ISO) timestamp_source updated_at(ms) message_count pinned_message_ids engine_cursor engine_last_run_id hydrated_from_engine created_at(ms) | PK(id) WITHOUT ROWID；触发器维护 message_count | 会话索引（侧栏元数据） | 无 FK 被引用方问题；新行仅 import/upsert 路径可建（P01）；timestamp ISO vs ms 混用（P11） |
| events | id(INT AUTOINCREMENT PK) session_id sequence event_type payload created_at(datetime('now') TEXT) | UNIQUE(session_id,sequence)；idx_events_session_seq（重复，P13） | 会话事件流（run 事件、审计事件） | 无 FK（P03）；无清理/无上限（P03）；自增主键冗余（P14）；created_at 无 T 无毫秒（P11） |
| metadata | key(PK) value | PK | 遗留，从未使用 | 死表（P12） |
| session_messages | session_id(→sessions CASCADE) seq id sender(CHECK) text thinking timestamp status(CHECK) stream_text_offset thinking_time tool_calls_json blocks_json tool_call_results_json | PK(session_id,seq)；idx_session_messages_id；FK CASCADE | 会话正文消息 | FK 阻塞新会话写入（P01）；全量替换写模型（P08）；status CHECK 不含 'stopped'/'aborted'（前端 4 态：queued/processing/completed） |
| session_agents | session_id(→sessions CASCADE) agent_id subagent_run_id parent_* description mode status(CHECK) summary started_at ended_at depth subagent_path_json | PK(session_id,agent_id)；FK CASCADE | 协作子 agent | 同 P01 FK 阻塞；40 条截断（P18） |
| session_agent_messages | session_id agent_id seq id sender(CHECK) text thinking timestamp status(CHECK) … | PK(session_id,agent_id,seq)；复合 FK→session_agents CASCADE | 子 agent 消息 | 级联依赖正确；写路径仅 save_session_agents 全量替换 |
| session_meta | key(PK) value | PK WITHOUT ROWID | schema_version / active_session_id / folder_order / migration 标记 | schema_version 只写一次（P07） |
| runs | run_id(PK) session_id status(CHECK 9 态) end_reason cursor created_at updated_at | PK；idx_runs_session | run 生命周期镜像 + 事件游标 | 无 FK（P03 同源）；cursor 死列（P04）；终态永久保留、无清理（设计如此但需 retention 策略） |
| pending_inputs | id(PK) session_id run_id payload created_at | PK；idx_pending_inputs_session(session_id,created_at) | after-current-run 待恢复输入 | 无 FK；按消费删除（delete_pending_input），孤儿随会话删除残留 |

---

## 四、双库关系分析（前端 sessions.db vs Rust conex-db）

> 澄清：**不存在两个 SQLite 文件**。唯一 SQLite 是 Rust 侧 `app_dir()/sessions.db`（apps/agent-workbench/src-tauri/src/main.rs:145-148）；"前端 sessions.db"实为 localStorage 的 crish_session_* key 镜像 + 内存 zustand store。因此是"SQLite（Rust 真源候选）↔ localStorage（索引真相源）↔ 内存 store"三态双写。

```
┌───────────────────────────── 前端 (crish-desktop) ─────────────────────────────┐
│ 内存 store (zustand)  ──350ms debounce──▶ persistAllSessionsRust               │
│   │  ▲                                     ├─ lsSaveSessionIndex(entries) ① 索引→LS│
│   │  │ hydrateSessionsFromRust             ├─ probe list_sessions               │
│   │  │  （索引：LS 优先 ② → 回退 SQLite）    ├─ save_session_body/agents（per-    │
│   │  │  （正文：SQLite 优先 → 回退 LS）      │    session 并发 invoke）→ Rust     │
│   │  │                                     ├─ setSessionMeta(active/folder)     │
│   │  │                                     └─ cleanup_orphan_sessions(keepIds)  │
│  localStorage (crish_session_*)          （P02：空 keepIds = 全删）             │
│  ├─ index_v1（真相源）  ◀──── ① 每次 persist 覆盖                              │
│  ├─ body_v1:<id>（镜像，非空才写）                                              │
│  ├─ agents_v1:<id>（镜像，≤40 条）                                              │
│  └─ 30 天后整体清理 ──▶（P09：与真相源身份冲突）                                 │
└──────────────────────────────────────────┬─────────────────────────────────────┘
                                           │ Tauri invoke（11 命令，spawn_blocking）
┌──────────────────────────────────────────▼─────────────────────────────────────┐
│ Rust (agent-workbench src-tauri)  app_dir()/sessions.db（唯一 SQLite）          │
│  SharedDb(LocalDb: Arc<Mutex<Connection>>)  ── 与 orchestrator 共用同一连接     │
│  ├─ session_commands（11 命令：list/load/save/delete/meta/cleanup/import/touch）│
│  ├─ CoreRunState → LocalDbStore → events/runs/pending_inputs（run 事件流）      │
│  └─ restore/快照（B4.3）── 仅测试使用（P06）                                    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

数据一致性风险（按严重度排序）：
1. **写入所有权分裂**：sessions/messages/agents 表由前端写（且新会话 FK 失败→LS 回退，P01），events/runs 由 Rust 引擎写；两者对"一条消息"各持一半事实（事件流有 message-end、正文表可能没有），一致性只靠前端 persist 收敛。
2. **真相源漂移**：索引真相源在 LS（②），正文真相源在 SQLite；30 天清理/崩溃/双写任何一处分叉，hydrate 策略（LS 优先索引 + SQLite 优先正文）都可能读到互相矛盾的组合。
3. **并发清空**：P02 的 keepIds 空删 + LS 索引覆盖，是唯一的"双库同时清空"路径，且无恢复手段（events 表无法重建 sessions）。
4. **回退掩盖错误**：invoke 返回 error 时前端一律静默回退 LS（sessionRustDb.ts:19-25 设计如此），导致 SQLite 的 FK 失败（P01）等真实故障被吞掉，用户无感知、运维无日志。

---

## 五、正面发现

1. **append_event 原子性**：单条 INSERT + `UNIQUE(session_id, sequence)` 保证会话内序列唯一，并发测试（concurrent_access，lib.rs:1549）与 InMemoryStore 同构约束（persist.rs:290-300）双重覆盖；失败 latch（DbFailure）一旦置位持续可见，`db_ready()` 真实反映状态（main.rs:145-176 降级内存库并标记 not-ready）。
2. **跨 run 序列连续性设计正确**：会话内 run 串行守卫（core_run_commands.rs:431-435 `has_active_run_in_session`）+ `base_sequence_for`（max 落库序列+1，崩溃后以落库锚点重算）+ `publish_run_cursor`（收口回写），与 restore 的 `next_sequence`（max+1）一致；delta 占位序列不落库但在分配上连续，重启后以落库锚点续接无冲突。
3. **message-delta 非持久化语义正确**：delta 不落库不阻塞 drive loop（测试实测 120 条 delta 不受 40ms/条慢 store 拖累），持久化事件同步等待保证中间态可观测；终态事件唯一（run-terminal 只发一次，终态拒绝再转移）。
4. **持久化失败语义严谨**：写失败 → run-failed(event-store-write-failed)，不假装可回放；终态事件落库失败时以原序列号尽力重发（events.rs:345-367），保持序列连续与终态唯一。
5. **upsert 避免级联误删**：`ON CONFLICT DO UPDATE` 而非 `INSERT OR REPLACE`（lib.rs:350-353），专门测试 `upsert_does_not_cascade_delete_messages` 覆盖。
6. **触发器维护 message_count**：insert/delete 双向触发器（lib.rs:206-216），全量替换/增量追加/级联删除后计数一致（测试 trigger_maintains_message_count）。
7. **快照机制工程到位**：双文件（主+.prev）+ tmp/rename 原子写 + FNV-1a 64 checksum + 四类回退测试（全量/增量/损坏回退/无备份全量重放）全覆盖；`apply_leaf_move_event` 幂等（覆盖赋值）保证重放安全；恢复时叶子移动事件载荷损坏跳过不中断。
8. **pending_inputs FIFO 双实现一致**：InMemoryStore 与 SQLite 均为 (created_at, id) 排序，测试断言乱序注入→顺序恢复。
9. **import_from_localstorage 工程质量高**：单事务、幂等（ON CONFLICT UPDATE + 先删后插）、JSON 数组/JSONL 双格式兼容、坏行跳过不整体失败、3 个专项测试覆盖（含幂等重复导入）。
10. **前端懒壳防护意识**：空 body 不写 SQLite（防远程懒壳擦正文）、hydrate 补正文逻辑（store-persistence.ts:183-222）、I-DRAFT 哨兵永不持久化——这些防护方向正确，只是被 P02/P10 的清理路径部分抵消。
