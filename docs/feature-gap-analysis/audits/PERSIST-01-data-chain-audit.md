# PERSIST-01 会话/消息/run 数据链路严格审计（持久化与恢复域）

> 日期：2026-08-07 · 审计代理：A1（数据链路域，只读）· 范围：`crates/conex-db`（全量）＋ `apps/agent-workbench/src-tauri`（session_commands / core_run_commands / main）＋ `apps/crish-desktop/src/api/session-persistence` ＋ `store/layout-helpers/store-persistence.ts` ＋ `crates/orchestrator`（persist/restore/run）· 对照：`docs/rust-rewrite/audits/AA-07-data-persistence-review.md`（18 项逐项核销）
> 审计态度：从严。凡可能造成数据丢失、损坏、不一致、不可恢复的路径一律列报，宁可多报。

---

## 一、Schema 完整性（表 / 约束 / PRAGMA / 迁移链）

### 1.1 表结构与约束现状（v6 目标形态）

| 表                     | 关键约束                                                                                       | 证据                       | 评注                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| sessions               | PK(id) WITHOUT ROWID；message_count 由触发器维护                                               | schema.rs:123-139、255-265 | 索引行元数据（title/folder/pinned）生产侧从不写入 → 见新问题 N1-1                                    |
| events                 | 组合 PK (session_id, sequence) + FK→sessions CASCADE；无 AUTOINCREMENT                         | schema.rs:141-149          | P03 的 FK 部分已修；无 retention 策略 → 见 P2-3                                                      |
| runs                   | PK(run_id) + FK→sessions CASCADE；v5 usage/cache 9 列 + warm_until_ms                          | schema.rs:151-169、171     | FK 已修（AA-07 P03 部分核销）                                                                        |
| pending_inputs         | PK(id) + FK→sessions CASCADE                                                                   | schema.rs:173-180、182     | FK 已修                                                                                              |
| session_sequence       | PK(session_id)，**无 FK**                                                                      | schema.rs:184-187          | 会话删除后行残留（无界小泄漏）→ P2-4                                                                 |
| session_messages       | PK(session_id,seq) + FK CASCADE + sender/status CHECK + usage_json                             | schema.rs:189-206、208     | 完整                                                                                                 |
| session_agents         | PK(session_id,agent_id) + FK CASCADE；v6 三列 task_type/display_label/allowed_write_paths_json | schema.rs:210-229          | 完整                                                                                                 |
| session_agent_messages | 复合 FK→session_agents CASCADE + CHECK                                                         | schema.rs:231-248          | 完整                                                                                                 |
| session_meta           | PK(key) KV 表                                                                                  | schema.rs:250-253          | 无 FK（全局 KV 设计使然）；会话删除后键残留（tests 已注明可接受，session_commands.rs:795-801）→ P2-4 |

### 1.2 PRAGMA 开关

- `PRAGMA foreign_keys = ON`：迁移入口强制开启（migrate.rs:104，错误检查不忽略）；单一连接全生命周期生效。
- `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`：migrate.rs:107 开启，**但错误被 `let _` 静默吞掉**——只读介质/受限目录下 WAL 开启失败会无告警退化为 journal 模式（单进程仍可用，P2 级）。
- WAL 下未显式设置 `synchronous`（默认 FULL，WAL 下偏保守但更安全，非问题）。

### 1.3 迁移链 v1→v6 逐版本核对（migrate.rs）

| 版本  | 动作                                                                                                                                | 证据               | 数据保留                                                    | 幂等                   | 评注                                                             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| v1→v2 | sessions 补 9 列（纯 ADD COLUMN，col-check 判定）                                                                                   | migrate.rs:220-242 | 保留                                                        | 幂等                   | 刻意避免 RENAME+DROP 父表触发级联清空（注释 migrate.rs:218-219） |
| v2→v3 | session_agent_messages 重建补 CHECK（RENAME→CREATE→COPY→DROP）                                                                      | migrate.rs:245-274 | 全量拷贝                                                    | 重跑安全（表名已恢复） | DROP 前备份由调用方时序保障                                      |
| v3→v4 | events 重建为组合 PK+FK；metadata 删除；runs/pending 重建加 FK（孤儿行过滤）；session_messages 加 updated_at；session_sequence 对齐 | migrate.rs:279-380 | 孤儿行丢弃**但计数写入 session_meta**（migrate.rs:296-299） | 幂等                   | 孤儿丢弃有可观测记录，裁决合理                                   |
| v4→v5 | runs 补 9 列 + session_messages 补 usage_json（纯 ADD COLUMN）                                                                      | migrate.rs:399-421 | 保留（旧行补 0/NULL）                                       | 幂等（col-check）      | 无备份（纯 ADD COLUMN 无 DROP，合理）                            |
| v5→v6 | session_agents 补 3 列；表缺失守卫跳过                                                                                              | migrate.rs:437-459 | 保留                                                        | 幂等                   | 守卫兼容极简库                                                   |

- **版本记录**：`PRAGMA user_version` 权威 + session_meta `schema_version` 字符串（migrate.rs:203-215 每次 open 更新，不再只写一次——AA-07 P07 已修）。注意 `user_version=N` 在版本事务 **commit 之后**单独执行（migrate.rs:188-191）：commit 与版本号落盘之间有崩溃窗口，重跑时各步幂等（RENAME 目标名已恢复），无数据风险。
- **备份时序**：每版本「wal_checkpoint(TRUNCATE) → 整库拷贝 .bak-vN」先于事务 commit（migrate.rs:145-167），备份内容确定；保留最近 2 份（lib.rs:57）。备份失败 → 告警 + session_meta 可观测键 `migration_backup_failed`，**不阻断迁移**（裁定案，migrate.rs:70-89）。残余风险：备份失败后 v2→v3/v3→v4 的重建型 DROP 仍会执行，此时旧表结构无任何备份（数据行虽拷贝走，但失败即毁库）——裁定案可接受，但值得在告警文案中提示用户立即停止写入。
- **测试覆盖**：tests/migrations.rs 全套（v1/v2/v3/生产 v0/v5 fixture → v6、幂等、备份黄金字节、备份含未 checkpoint 的 WAL 数据、backup 失败继续迁移）；upgrade_e2e.rs（v3→v4 全 API 可用、import 后迁移）；tests.rs v4→v5 专项。迁移链测试密度充足。

### 1.4 Schema 层结论

- 9 表约束与 v5/v6 目标形态一致，FK/CHECK/触发器齐备；孤儿数据在迁移时被显式过滤并记账。
- 主要残留：**session_sequence 无 FK**（P2-4）；**events 无 retention**（P2-3）；**索引行元数据无生产写入方**（N1-1，严重）。

---

## 二、写路径原子性

| 写路径                              | 事务                                                       | 失败语义                            | 证据                                  | 评注                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------- | ----------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| save_session_body（先删后插全量）   | 单事务 DELETE+INSERT                                       | 任一步失败回滚，库保持旧正文        | messages.rs:52-104                    | 原子性正确；seq=枚举下标，以调用方数组顺序为准                                                          |
| save_session_body 前置自愈          | 非事务（两条独立语句）                                     | 自愈失败 → save 不执行，返回错      | session_commands.rs:103-113           | 自愈行 title=''、**updated_at=0**（sessions.rs:9-22）→ 宽限期对其无效（N1-1 关联）                      |
| append_session_messages             | 单事务（MAX(seq)+1 查询 + 插入）                           | 回滚                                | messages.rs:107-165                   | 未接线任何 Tauri 命令（command_manifest.rs:181 registered=false）                                       |
| upsert_session_entry                | 单语句 ON CONFLICT DO UPDATE                               | 失败返回错                          | sessions.rs:30-76                     | 不覆盖 message_count/created_at（触发器/创建时维护）；**生产无调用方**（N1-1）                          |
| save_session_agents（全量先删后插） | 单事务                                                     | 回滚                                | agents.rs:163-247                     | **级联清空 session_agent_messages + 与引擎 upsert 竞态**（N1-3）                                        |
| upsert_session_agent（单行）        | 单语句 ON CONFLICT DO UPDATE                               | 失败返回错                          | agents.rs:308-358                     | 引擎侧专用，防 REPLACE 级联（agents.rs:300-307）                                                        |
| insert_run                          | **INSERT OR REPLACE**                                      | 失败返回错                          | runs.rs:112-140                       | REPLACE 命中冲突时 = 删+插（runs 无子表，无级联风险）；重复调用会重置 created_at/updated_at（理论边界） |
| update_run_status                   | 单语句，end_reason/cursor COALESCE 保留                    | 失败返回错                          | runs.rs:143-171                       | 缺行不报错（affected=0）                                                                                |
| save_run_usage                      | 单语句 UPDATE                                              | **缺行静默跳过**                    | runs.rs:193-225                       | run 行随会话删除后，收口写入静默丢失 → P2-5                                                             |
| append_event                        | 单语句 INSERT（UNIQUE 保证序列唯一）                       | 失败 latch                          | events.rs:8-27                        | 原子                                                                                                    |
| reserve_sequence                    | 两语句（读 next_sequence → +1），Mutex 串行化              | 崩溃在两步之间 → 序列 gap（无冲突） | events.rs:72-99                       | 非 SQLite 级原子，但单连接模型下无并发窗口；gap 语义无害                                                |
| cleanup_orphan_sessions             | 单事务 DELETE+COUNT                                        | 回滚                                | sessions.rs:177-241                   | 级联删除 bodies/agents/events/runs/pending；**宽限期对 updated_at=0 行无效**（N1-1 关联）               |
| delete_session                      | 单语句，级联                                               | 回滚                                | sessions.rs:124-137                   | session_meta/session_sequence 键残留（P2-4）                                                            |
| import_from_localstorage            | **单事务整体**                                             | 任一会话失败全回滚                  | import.rs:41-43、221-222              | 工程质量高；但 messages 插入仅 13 列（不写 usage_json）→ N2-2                                           |
| run.finalize（终态）                | update_run_status 单语句；**run-terminal 事件另行 append** | 两步之间崩溃 → runs=终态但事件缺失  | run.rs:429-460；事件发出在 drive loop | 非原子 → P2-6                                                                                           |
| 恢复打断（restore）                 | update_run_status + 审计事件（sequence 分配后）            | 崩溃重试幂等（next_sequence 锚点）  | restore.rs:565-589                    | 合理                                                                                                    |

### 2.1 写路径结论

- 单写者 Mutex + 显式事务：**库内单条写路径全部原子**，没有「写一半」的状态——崩溃要么在事务前（旧数据完整），要么在 commit 后（新数据完整）。
- 真正的非原子面在**跨语句编排**：① 前端 self-heal（两条语句）→ 中间态无碍；② 引擎「run 状态更新」与「run-terminal 事件」分离（P2-6）；③ 前端全量替换 vs 引擎单行写（N1-3）。
- 孤儿行：runs/pending_inputs/events 有 FK 级联，迁移时过滤；session_sequence/session_meta 无 FK → 残留（P2-4）。

---

## 三、读路径一致性

| 读路径                           | 排序/游标语义                                                                   | 证据                               | 评注                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| load_session_body                | ORDER BY seq ASC                                                                | messages.rs:15-23                  | 正确；usage_json 一并回读                                                                  |
| list_sessions                    | updated_at DESC, id ASC                                                         | sessions.rs:87-92                  | 正确；updated_at=0 行排序任意（N1-1 关联）                                                 |
| query_events                     | sequence > after, ASC, limit 可选                                               | events.rs:44-49                    | restore 侧传 None → 无界查询（P2-11）                                                      |
| reserve_sequence / seed_sequence | MAX 语义只抬高不回退                                                            | events.rs:72-121                   | 崩溃恢复锚点一致（引擎 base_sequence 用 max+1 落库锚点，与 restore.rs next_sequence 一致） |
| get_run_usage                    | sample_count==0 → None（隐藏而非 0% 误导）                                      | runs.rs:232-285                    | 口径正确                                                                                   |
| load_pending_inputs              | created_at ASC, id ASC（FIFO 双实现一致）                                       | runs.rs:331-359                    | 正确                                                                                       |
| load_session_agents              | started_at ASC, agent_id ASC；消息逐 agent 查询                                 | agents.rs:44-75                    | 正确                                                                                       |
| 快照 restore                     | snapshot+增量重放；in-flight → interrupted（cancelling→cancelled，其余→failed） | restore.rs:517-589                 | 生产已接线（main.rs:382）                                                                  |
| cursor 列                        | 终态游标 = run-terminal 事件 sequence（T08.4）                                  | run.rs:447-458；restore.rs:586-588 | AA-07 P04 已修                                                                             |

### 3.1 读路径结论

读路径整体一致；主要风险点集中在**跨存储读**（LS 索引优先 vs SQLite 索引缺元数据，见第四节）与 restore 的**无界事件重放**（P2-11）。

---

## 四、前端双轨（SQLite ↔ localStorage ↔ 内存 zustand）一致性

> 注：任务书写的「30 分钟清理」实际代码为 **30 天**（LOCALSTORAGE_ROLLBACK_TTL_MS = 30 天，migrateFromLocalStorage.ts:40），下文按 30 天核对。

### 4.1 启动序列（store-persistence.ts:113-293）

1. `initStorePersistence` 挂 subscribe（**无 `hydrationComplete` 守卫**）→ 350ms debounce → `persistAllSessions`（store-persistence.ts:128-145）。
2. `ensureMigrated()` → `hydrateSessionsFromRust()` → `runMigrationCleanupIfNeeded()`（store-persistence.ts:148-154）。
3. hydrate 完成写 `hydrationComplete = true`（store-persistence.ts:280-286）。

**问题 A（boot 窗口）**：subscribe 在 hydrate 完成前即可触发 persist。触发源：hydrate 窗口内用户新建会话 / 引擎事件改 activeSessionId。此时内存可能只有部分会话（LS 30 天清理后 seed 为空、hydrate 未完成 → sessions=[]）。persist 会：

- `lsSaveSessionIndex([])` 无条件写空（sessionRustDb.ts:908-915）；
- `cleanupOrphanSessions([])` → Rust 侧 `guard_cleanup_keep` 拒绝（session_commands.rs:94-101，AA-07 P02 修复生效）→ **JS 回退分支无守卫**：keep=∅ 时删除 localStorage **全部** session body/agents key（sessionRustDb.ts:729-753）。
- 若内存只有「新会话」一个：keepIds={新会话} → Rust 放行 → `DELETE FROM sessions WHERE id NOT IN (…)`（sessions.rs:216-231）→ **删除 SQLite 中其余全部会话**（级联正文）。宽限期只保护 updated_at 近 5 分钟的行（sessions.rs:187-202）——自愈行 updated_at=0、导入行 updated_at=历史消息时间，**均不在保护范围**。

→ 详见 N0-2（P0 级）。

**问题 B（索引真相源单向漂移）**：`upsert_session_entry`（T08.1 冻结命令，session_commands.rs:353-364）与 `touch_session` 在**生产前端零调用**（全仓 grep 仅测试与 manifest）。persist 只写 LS 索引（sessionRustDb.ts:906-915）。后果：

- SQLite sessions 行永远 title=''、folder='常规会话'、pinned 丢失；
- 自愈行 updated_at=0 使孤儿宽限期形同虚设；
- LS 30 天清理后 hydrate 回退 SQLite（sessionRustDb.ts:804-808）→ 会话以「新会话」空标题 + 无文件夹展示，**元数据不可恢复**（N1-1）。

**问题 C（30 天清理无数据存在性校验）**：`runMigrationCleanupIfNeeded` 仅校验 `migration_completed_at` 距今 ≥30 天即删除全部 crish_session_* key（migrateFromLocalStorage.ts:187-233），**不校验 SQLite 是否实际持有对应数据**。当 `sessions.db` 打开失败降级内存库（main.rs:225-254）时：所有 save 对内存库「成功」（前端照常写 LS 镜像，sessionRustDb.ts:630-635）→ 降级期间数据**只存在于 LS**；磁盘恢复后 30 天到期 → 清理删除唯一副本 → 永久丢失（N0-1）。

### 4.2 双写防护核对（AA-07 P08/P10 现状）

- 「空 body 不写 SQLite」防护仍在（sessionRustDb.ts:926-940 只对有内容会话调 save_session_body；631-636 ok 分支空数组不写 LS）——**方向正确**；
- 但 error 分支无对称防护：`invoke 失败 → lsSaveSessionBody(sessionId, msgs)` 对空数组同样执行（sessionRustDb.ts:638-639）→ 真实 DB 故障 + 懒壳场景会把 LS 唯一正文副本刷成 []（N2-1）；
- `prepareSessionsForUi` prune 空壳仍存在（sessionTitle.ts:566-600）：被剪会话不在 keepIds → 下次 cleanup 级联删除其 SQLite 行。正文非空壳不会被剪，但**含子代理、正文为空**的会话会被剪 → agents 级联丢（N2-4）。

### 4.3 usage_json 回读

- 写入：`messageUsageToJson` 只落原始计数（read/write/miss/inputTotal），0/空 → null（sessionRustDb.ts:187-201，C15 语义正确）；
- 回读：`cacheStateFromUsageJson` → `computeCacheMetricsFromUsage` 重派生（sessionRustDb.ts:268-276），与 message-end 实时链同源；
- **契约注释过时**：sessionRustDb.ts:86-94 声称「Rust SessionMessage 尚未实现 usage 字段，前端按契约先行写入」——实际 conex-types/src/lib.rs:156-183 已实现 `usage: Option<String>` 并落库（messages.rs:94,155），注释误导维护者（N2-6）；
- **导入缺口**：import 写 session_messages 仅 13 列（import.rs:100-104），LS 存量 body 中的 cacheMetrics 不入库 → 30 天清理后徽标数据丢失（N2-2）。

### 4.4 崩溃窗口（beforeunload）

- beforeunload 仅同步写 LS（sessionRustDb.ts:1015-1071，禁止 await IPC 的设计合理）；
- 350ms debounce 未落盘的变更在硬杀进程时双库皆失（store-persistence.ts:137-144）→ 有界丢失 ≤350ms + 未触发 persist 的变更（N2-5）。

---

## 五、数据丢失场景枚举（崩溃时机 × 写路径）

| #   | 崩溃时机                               | 路径                                                 | 后果                                                                                                      | 级别             |
| --- | -------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------- |
| S1  | save_session_body 事务中途             | DELETE/INSERT                                        | 回滚，旧正文完整                                                                                          | 无损失           |
| S2  | self-heal 第一条语句后                 | insert_session 已提交                                | 空会话行残留（updated_at=0）→ 可被后续孤儿清理删除，无正文可失                                            | 无实质损失       |
| S3  | finalize 与 run-terminal 事件之间      | run.rs:449-458 → 事件 append                         | runs=completed 但事件流缺终态 → 前端 replay 缺 terminal，run 面板显示已完成（不一致，可读性降级）         | P2-6             |
| S4  | reserve_sequence 两语句之间            | events.rs:72-99                                      | 序列 gap；restore 以落库锚点续接，无冲突                                                                  | 无损失           |
| S5  | commit 与 `user_version=N` 之间        | migrate.rs:188-191                                   | 下次 open 重跑该版本，各步幂等                                                                            | 无损失           |
| S6  | 备份失败 + 迁移进行中                  | migrate.rs:70-89 裁定案                              | v2→v3/v3→v4 重建型 DROP 无备份 → 迁移失败即旧表结构无备份（行数据在拷贝时已转移，风险集中在重建中途故障） | P2（告警已存在） |
| S7  | LS 30 天清理触发时 SQLite 为降级内存库 | migrateFromLocalStorage.ts:187-233 + main.rs:247-250 | **降级期数据仅存 LS → 清理 = 永久丢失**                                                                   | **P0（N0-1）**   |
| S8  | LS 清理后首次启动 hydrate 窗口内建会话 | store-persistence.ts:128-145 + sessions.rs:216-231   | keepIds 部分/空 → SQLite 全库会话级联删除 + LS 全清（JS 回退分支无守卫）                                  | **P0（N0-2）**   |
| S9  | 前端全量替换 agents 与引擎 upsert 交错 | agents.rs:163-247 vs 308-358                         | 引擎新落库的 agent 行（及其 messages）被前端过期快照整批删除                                              | P1（N1-3）       |
| S10 | save_session_body 失败 + 懒壳          | sessionRustDb.ts:638-639                             | error 分支空数组覆盖 LS 正文副本                                                                          | P2（N2-1）       |
| S11 | 硬杀进程                               | debounce 未触发                                      | ≤350ms 变更双库皆失                                                                                       | P2（N2-5）       |
| S12 | 并发多实例打开同一 sessions.db         | 单进程假设破坏                                       | WAL+busy_timeout 已缓解（migrate.rs:107）；无第二进程锁（文件锁未实现）                                   | P2（理论）       |

**结论**：库内事务原子性无懈可击；全部「可恢复性」风险集中在**前端编排层**（LS 清理、boot 窗口、双写竞态、降级模式）。

---

## 六、AA-07 18 项核销表

| 编号 | 原问题                                 | 现状证据                                                                                                                                                                                                                                                       | 结论                                                     |
| ---- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| P01  | 新会话永不落 SQLite（FK 失败静默回退） | save_session_body 自愈补建会话行（session_commands.rs:103-113，INSERT OR IGNORE）；upsert_session_entry 命令已冻结（session_commands.rs:353-364）；测试 save_session_body_self_heals_missing_session_row（session_commands.rs:654-671）                        | **已修复**（残留：索引元数据无生产写入方 → 新问题 N1-1） |
| P02  | boot 窗口孤儿清理全表清空              | Rust 空 keepIds 默认拒绝（session_commands.rs:94-101 guard_cleanup_keep）；宽限期 5 分钟（sessions.rs:187-202，测试 orphan_grace_contract.rs 全绿）；**但前端 subscribe 无 hydrationComplete 守卫、JS 回退清理无守卫、宽限期对 updated_at=0 行无效**           | **部分修复**（残余窗口 = N0-2）                          |
| P03  | events 无 FK、无清理策略               | v3→v4 重建 events 加 FK CASCADE（migrate.rs:300-314，schema.rs:141-149）；孤儿行迁移计数落 session_meta（migrate.rs:296-299）；**retention/VACUUM 仍未实现**                                                                                                   | **部分修复**（FK 已修；retention 缺 → P2-3）             |
| P04  | runs.cursor 死列                       | 终态写 cursor（run.rs:447-458 update_run_status 带 cursor）；update_run_status COALESCE 支持（runs.rs:143-171）；T08.4 语义 = 终态游标 = run-terminal sequence                                                                                                 | **已修复**                                               |
| P05  | LocalDbStore 同步直调阻塞 tokio worker | 全部方法包 `blocking_db_call`（spawn_blocking）（persist.rs:610-699）；测试慢盘模拟在 spawn_blocking 闭包内（persist.rs:593-599）                                                                                                                              | **已修复**                                               |
| P06  | B4.3 恢复/快照生产未接线               | main.rs:382 `run_restore`（manage 之前）；main.rs:445 `spawn_snapshot_loop`（60s）；main.rs:463-467 `RunEvent::Exit → save_snapshot_blocking`；restore_ready 门禁（core_run_commands.rs:1218、1586）；restore 域状态完整暴露（core_run_commands.rs:1441-1478） | **已修复**                                               |
| P07  | 迁移非版本化、v3→v4 缺失、无备份       | `PRAGMA user_version` 驱动 v1→v6 逐版本事务（migrate.rs:98-200）；record_schema_version 每次 open 更新（migrate.rs:203-215）；备份时序确定化 + 黄金字节测试（migrate.rs:145-167、tests/migrations.rs:778-883）；全部版本 fixture 覆盖（migrations.rs:516-717） | **已修复**                                               |
| P08  | save_session_body 全量替换双写冲突     | session_messages 仍为全量先删后插（messages.rs:52-104），但引擎当前**不写** session_messages（事件流与正文表分离现状未变）→ 冲突休眠；**session_agents 双写竞态实际存在**（前端全量替换 vs 引擎 upsert，agents.rs:3-11 注释自认）                              | **部分修复/休眠**（agents 面竞态 = N1-3）                |
| P09  | 30 天清理与 LS 真相源自相矛盾          | hydrate 已支持 SQLite 回退（sessionRustDb.ts:804-808）；**清理仍不校验 SQLite 数据存在性**（migrateFromLocalStorage.ts:187-233）                                                                                                                               | **部分修复**（残余 = N0-1）                              |
| P10  | 清理与懒壳剪枝张力                     | 空 body 不写防护保留（sessionRustDb.ts:926-940、631-636）；prepareSessionsForUi prune 仍在（sessionTitle.ts:566-600）；自愈行宽限期失效使清理仍可命中                                                                                                          | **部分修复**（残余并入 N0-2/N2-4）                       |
| P11  | 时间戳三套格式并存                     | sessions.timestamp ISO TEXT / events.created_at `datetime('now')` 无毫秒 TEXT / 其余 epoch ms——未改动                                                                                                                                                          | **未修复**                                               |
| P12  | metadata 死表                          | v3→v4 DROP TABLE IF EXISTS metadata（migrate.rs:316）                                                                                                                                                                                                          | **已修复**                                               |
| P13  | idx_events_session_seq 冗余索引        | v4 重建 events 为组合 PK 后不再建显式索引（schema.rs:141-149）；v1 起点形态仍含（schema.rs:27，仅历史形态）                                                                                                                                                    | **已修复**                                               |
| P14  | events AUTOINCREMENT 冗余              | v4 重建为组合主键 (session_id, sequence)（schema.rs:141-149）                                                                                                                                                                                                  | **已修复**                                               |
| P15  | 无 WAL/busy_timeout                    | migrate.rs:107 开启（错误静默吞，P2）                                                                                                                                                                                                                          | **已修复**                                               |
| P16  | 快照保存失败无显式标记                 | snapshot_last_error 域 + core_get_status.snapshot.lastError 数据源（core_run_commands.rs:1227、1653、1481-1492）                                                                                                                                               | **已修复**                                               |
| P17  | beforeunload LS 镜像与 SQLite 分叉     | 镜像仍在写（sessionRustDb.ts:630-635）；30 天清理后镜像失效问题未消除                                                                                                                                                                                          | **未修复**（设计期接受，风险并入 N0-1）                  |
| P18  | 40 条 agent 静默截断                   | SESSION_AGENTS_SAVE_CAP=40 截断仍在（sessionRustDb.ts:674-676；sessionLocalStorage.ts:148），无提示、无 session_meta 记录                                                                                                                                      | **未修复**                                               |

**核销汇总：完全修复 10（P01、P04、P05、P06、P07、P12、P13、P14、P15、P16）；部分修复 6（P02、P03、P08、P09、P10、P17）；未修复 2（P11、P18）。**

---

## 七、新发现问题清单

### P0（数据丢失或不可恢复）

**N0-1 — 30 天 LS 清理不校验 SQLite 数据存在性，降级模式数据永久丢失**

- 证据：migrateFromLocalStorage.ts:187-233（仅按 `migration_completed_at` 满 30 天即清）；main.rs:225-254（sessions.db 打开失败 → 内存库 + db_ready=false，**命令照常成功**）；sessionRustDb.ts:630-635（invoke ok 时仍写 LS 镜像）。
- 场景：迁移完成（T0 落 `migration_completed_at`）→ 磁盘故障期（T1..Tn）所有写入落在内存库 + LS 镜像（SQLite 文件无数据）→ 磁盘恢复后 T0+30d 到期 → 清理删除 LS 唯一副本 → 降级期全部会话/正文永久丢失。
- 修复建议：清理前逐 key 校验 SQLite 存在对应会话与正文（或校验 `db_ready` + 数据行数）；至少把「LS 中无 SQLite 对应」的 key 保留或迁移回 SQLite 后再删。

**N0-2 — boot 窗口部分 keepIds 孤儿清理仍可全库清空（P02 残余）**

- 证据：store-persistence.ts:128-145（subscribe 无 `hydrationComplete` 守卫，350ms 后 persist）；sessions.rs:216-231（`id NOT IN (keepIds)` 删除）；宽限期只保护 updated_at 近 5 分钟行（sessions.rs:187-202），而自愈行 updated_at=0（sessions.rs:9-22）、导入行 updated_at=历史时间 → **宽限期形同虚设**；JS 回退清理无守卫（sessionRustDb.ts:729-753）；`lsSaveSessionIndex([])` 无条件写空（sessionRustDb.ts:908-915）。
- 场景：LS 30 天清理后首次启动（seed 空、hydrate 在途）→ hydrate 完成前用户新建会话（或引擎事件改 activeSessionId）→ persist keepIds={新会话} → Rust 放行 → SQLite 其余全部会话级联删除；同时 LS 索引与镜像被清空。无任何恢复路径。
- 修复建议：① subscribe 内加 `if (!state.hydrationComplete) return`；② cleanup 前对「不在 keepIds 且 updated_at 过期」的行做二次确认（或一律要求 active_ids 非空 + 与 SQLite 行数比对）；③ JS 回退清理加 `keep.size > 0` 守卫；④ 自愈/upsert 时写真实 updated_at。

### P1（不一致或降级）

**N1-1 — SQLite 索引行元数据无生产写入方（upsert_session_entry / touch_session 零调用）**

- 证据：全仓 grep 仅测试与 command_manifest.ts:130 引用；persist 只写 LS 索引（sessionRustDb.ts:906-915）；sessionLocalStorage.ts:17 注释「未来增补 upsert_session_entry 命令后…」已过时（命令已存在）。
- 后果：SQLite sessions 行 title='' / folder 默认 / pinned 丢失 / updated_at=0；LS 30 天清理后 hydrate 回退 SQLite → 全部会话标题、文件夹、置顶、归档元数据不可恢复（正文仍在）。
- 修复建议：persistAllSessionsRust 中调用 upsert_session_entry 同步索引元数据（F3 已冻结）；orphan 清理触发前 touch 会话。

**N1-2 — JS 回退清理绕过 Rust 空 keep 守卫，boot 窗口清空 LS 真相源**

- 证据：cleanupOrphanSessions 的 JS 分支 keep=∅ 全删（sessionRustDb.ts:729-753）——Rust 侧 guard（session_commands.rs:94-101）拒绝后错误码触发此分支，等于「守卫被绕过」；配合 lsSaveSessionIndex([])（sessionRustDb.ts:908-915），一次 boot 窗口 persist 即清空 LS 全部会话数据。
- 修复建议：JS 回退分支同样要求 `activeIds.length > 0`；persist 前置守卫（见 N0-2）。

**N1-3 — session_agents 双写竞态未消（前端 350ms 全量替换 vs 引擎单行 upsert）**

- 证据：前端每次 persist 对每个会话全量 save_session_agents（sessionRustDb.ts:939、659-683）→ agents.rs:163-247 先删后插（级联清空 session_agent_messages）；引擎 spawn 走 upsert_session_agent（agents.rs:308-358）。11-T3 注释自认「后写者覆盖先写者新增行」竞态（agents.rs:4-11）；kill_spawn_interleave 测试仅覆盖引擎侧交错（agents.rs:654-694），**不含前端全量替换 vs 引擎 upsert**。
- 后果：引擎刚落库的新 agent 行被前端过期快照整批删除，子代理消息级联丢失。
- 修复建议：前端 persist 改为按 agent 逐行 upsert（或跳过「内存中无变化」会话的 agents 写入）；为 session_agents 引入 updated_at 乐观锁。

### P2（边界瑕疵）

- **N2-1** — save_session_body error 分支无空数组防护：invoke 失败时 `lsSaveSessionBody(sessionId, msgs)` 对空数组同样执行，把 LS 唯一正文副本刷成 []（sessionRustDb.ts:638-639 vs ok 分支 631-636 不对称）。
- **N2-2** — import 不迁移 cacheMetrics：session_messages 插入仅 13 列，usage_json 恒 NULL（import.rs:100-104）→ LS 存量正文的缓存徽标 30 天后永久丢失。
- **N2-3** — events 无 retention/VACUUM：长会话事件表无上限增长（schema.rs:141-149 仅 FK 无裁剪策略）；query_events limit=None 无界（persist.rs:687-689，restore 全量重放面）。
- **N2-4** — prepareSessionsForUi 剪壳连带删 agents：正文空但有子代理的会话被 prune（sessionTitle.ts:591-593）→ 不在 keepIds → cleanup 级联删 agents 行（sessions.rs:216-231）。
- **N2-5** — 350ms debounce + beforeunload 仅 LS：硬杀进程丢失 ≤350ms 双库变更（store-persistence.ts:137-144；sessionRustDb.ts:1015-1071）。
- **N2-6** — 契约注释过时：sessionRustDb.ts:86-94 声称 Rust 未实现 usage 字段，实际 conex-types/src/lib.rs:156-183 已实现并落库（messages.rs:94,155）——误导后续维护。
- **N2-7** — save_run_usage 缺行静默（runs.rs:193-225）：run 随会话删除（级联）后收口 usage 写入无提示丢失；insert_run 用 INSERT OR REPLACE 重复调用重置时间列（runs.rs:112-140）。
- **N2-8** — 终态 run 状态与 run-terminal 事件非单事务（run.rs:449-458 与事件 append 分离）→ 崩溃窗口「runs=completed 但终态事件缺失」，restore 只打断 in-flight，终态 run 不补发事件。
- **N2-9** — session_sequence / session_meta 孤儿行无 FK 残留（schema.rs:184-187、250-253；sessions.rs:124-137 不清理）——小泄漏，长期累积。
- **N2-10** — 时间戳三格式并存（AA-07 P11 未修）+ 40 条 agent 静默截断（AA-07 P18 未修，sessionRustDb.ts:674-676）。
- **N2-11** — WAL/busy_timeout PRAGMA 错误被 `let _` 吞掉（migrate.rs:107），只读介质上无告警退化。
- **N2-12** — 单进程假设：无第二实例文件锁，双实例打开同一 sessions.db 时 WAL 缓解但不防逻辑竞态（S12，理论）。

---

## 八、最严重 5 个问题摘要

1. **N0-1：30 天 LS 清理不校验 SQLite 数据存在性**——降级内存库窗口期的数据只存在于 LS，清理即永久丢失（migrateFromLocalStorage.ts:187-233 + main.rs:225-254）。
2. **N0-2：boot 窗口部分 keepIds 孤儿清理仍可全库清空**——subscribe 无 hydrationComplete 守卫、宽限期对 updated_at=0 行失效、JS 回退清理无守卫，三处叠加（store-persistence.ts:128-145、sessions.rs:216-231、sessionRustDb.ts:729-753）。
3. **N1-1：SQLite 索引元数据无生产写入方**——upsert_session_entry/touch_session 零调用，LS 清理后标题/文件夹/置顶不可恢复（sessionRustDb.ts:906-915）。
4. **N1-3：session_agents 双写竞态**——前端 350ms 全量替换可整批删除引擎新落库的子代理行及其消息（agents.rs:163-247 vs 308-358）。
5. **N1-2：JS 回退清理绕过 Rust 空 keep 守卫**——一次 boot 窗口 persist 同时清空 LS 索引与全部 LS 正文/agents 镜像（sessionRustDb.ts:729-753 + 908-915）。

> 正面确认：库内 9 表约束齐备、v1→v6 迁移链工程化到位（备份时序确定化、幂等、测试密度高）、全部单表写路径事务原子、AA-07 中 10 项完全修复（P01/P04/P05/P06/P07/P12/P13/P14/P15/P16）。剩余风险集中于**前端编排层**（清理、boot 窗口、双写），建议优先落地 N0-2 的 subscribe 守卫与 N1-1 的 upsert 接线。
