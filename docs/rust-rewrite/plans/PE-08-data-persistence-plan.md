# PE-08 数据持久化加固任务书（方案文档）

> 日期：2026-08-01 · 域：数据持久化加固（conex-db + orchestrator 持久化 + 前端会话缓存）
> 性质：**只读研究 + 方案文档**。本任务书不修改任何代码；实现由后续执行轮按 T08.x 逐项落实。
> 输入事实：
> - `audits/AA-07-data-persistence-review.md`（P01–P18，其中阻塞 2 项：P01/P02）
> - `audits/AA-01-rust-core-code-review.md`（Q24/Q26，重要）
> - 代码：`crates/conex-db/src/lib.rs`、`crates/orchestrator/src/persist.rs / restore.rs / events.rs / run.rs / normalize.rs`、
>   `apps/agent-workbench/src-tauri/src/session_commands.rs / core_run_commands.rs / core_query_commands.rs / main.rs`、
>   `apps/crish-desktop/src/api/session-persistence/*`（sessionRustDb.ts / migrateFromLocalStorage.ts / sessionLocalStorage.ts）
> 引用格式：`AA-07 P01` = AA-07 审计问题 P01；`lib.rs:834` = conex-db lib.rs 第 834 行；`20 C1.1` = 20 号文档任务。

---

## 修订记录

| 版本 | 日期 | 修订依据 | 要点 |
|---|---|---|---|
| v1 | 2026-08-01 | — | 初版 |
| v2 | 2026-08-01 | **AU-04 接口冻结裁决** | ① 声明本域为 sessionRustDb.ts / migrateFromLocalStorage.ts / 会话持久化域**唯一 owner**（PE-01 T06 组收编，D2–D5）；② T08.1：`upsert_session_entry(entry: SessionIndexEntry)` 签名冻结（F3，session 族第 12 个命令）；吸收来源 PE-01 T06.1；③ T08.2：cleanup 签名冻结 = F4（`confirm_empty: bool` + 空 keepIds 返回 `Err(InvalidInput, "cleanup_orphan_empty_keep")` + 宽限期 5 分钟 `ORPHAN_GRACE_MS = 300_000`，session_meta 键 `orphan_grace_ms` 可配）；hydrationComplete 门闩依赖 PE-01 T04.4（声明前置）；persistAllSessionsRust 终态顺序定稿（C16）；吸收来源 PE-01 T06.2/T06.3；④ T08.3 新增事件 payload 256KB 上限 + 截断标记子项（认领表 #7，AA-05 D-02）；⑤ T08.7 样本来源指定（认领表 #17）+ schema_version 计数值修正（v4 迁移后写 '4'，`schema_version_is_three` 断言改 v4）；⑥ T08.8：Q25 子项升级为必做（认领表 #10）；⑦ T08.10 与 PE-09 T09.4 串行声明（写模型 = 全量替换保留，F7；append_session_messages 命令归 PE-09 T09.4.1 第 1 条，本域提供底层增量 API 并登记 manifest）；⑧ 新增 T08.12（Q23 会话级 sequence 原子分配，认领表 #2，依赖 T08.7）；⑨ core_get_status 字段扩展（restore/snapshot）排在 PE-01/PE-03/PE-04 之后（F2 串行序） |

---

## 〇、现状定稿（研究结论摘要）

> **唯一 owner 声明（AU-04 PE-08 修订指令 1）**：本域为 `sessionRustDb.ts` / `migrateFromLocalStorage.ts` /
> 会话持久化域（upsert/cleanup/清理核对/spawn_blocking 化）**唯一实现 owner**。PE-01 T06 组
> （T06.1/T06.2/T06.3/T06.4）已收编本域（AU-04 D2–D5）：PE-01 只保留引用与域内特有部分（前端回灌守卫、
> hydrationComplete 门闩等），实现责任全部在本任务书。session_commands.rs 的会话命令面以本域为终态
> （F3/F4/F7 冻结），PE-09 仅在其上新增 append 命令（第 13 个，见 T08.10）。

### 0.1 存储面现状

唯一 SQLite 文件为 `app_dir()/sessions.db`（main.rs:145-148），由 `LocalDb`（`Arc<Mutex<Connection>>`，单连接）
承载 9 张表（sessions / events / metadata / session_messages / session_agents / session_agent_messages /
session_meta / runs / pending_inputs）。前端侧不存在第二个 SQLite；"前端 sessions.db" 实为
localStorage 的 `crish_session_*` key 镜像 + 内存 zustand store，构成
**SQLite（Rust 真源候选）↔ localStorage（索引真相源）↔ 内存 store** 三态双写（AA-07 §四）。

写入所有权分裂（AA-07 §四 风险 1）：
- **前端**写 sessions / session_messages / session_agents / session_agent_messages（全量替换写模型，P08）；
- **引擎**（orchestrator）写 events / runs / pending_inputs（增量追加，sequence 连续）；
- 两者对"一条消息"各持一半事实，一致性只靠前端 350ms debounce 的 persist 收敛。

### 0.2 问题 → 任务映射总表

| 编号 | 严重度 | 一句话 | 归属任务 |
| --- | --- | --- | --- |
| P01 | 阻塞 | 无命令建会话行，save_session_body FK 失败→LS 回退，新会话永不落库 | T08.1 |
| P02 | 阻塞 | 空 keepIds → `DELETE FROM sessions` 全表清空（级联 messages/agents）+ LS 索引清空 | T08.2 |
| P03 | 重要 | events 无 FK、无清理，会话删除后事件残留且无上限增长 | T08.3 / T08.7 |
| P04 | 重要 | runs.cursor 恒 0 死列，终态快照游标错误 | T08.4 |
| P05 | 重要 | LocalDbStore 同步直调阻塞 tokio worker（8 个方法） | T08.5 |
| P06 | 重要 | B4.3 恢复/快照仅测试运行，main.rs 未接线 | T08.6 |
| P07 | 重要 | 迁移非版本化，schema_version 写死 3，v3→v4 不存在，DROP 无备份零测试 | T08.7 |
| P08 | 重要 | session_messages 全量替换写模型，双写互覆盖风险 | T08.10 |
| P09 | 重要 | 30 天 LS 清理与"LS 索引是真相源"自相矛盾 | T08.2 / T08.10 |
| P10 | 重要 | 懒壳剪枝与会话清理冲突：空壳正文被级联删除 | T08.2 / T08.10 |
| P11 | 建议 | 时间戳三套格式并存 | 范围外（见 §五） |
| P12 | 建议 | metadata 死表 | T08.7（v4 删除） |
| P13 | 建议 | idx_events_session_seq 冗余索引 | T08.7（v4 删除） |
| P14 | 建议 | events.id AUTOINCREMENT 冗余 | T08.7（v4 组合主键） |
| P15 | 建议 | 未开 WAL / busy_timeout | T08.7（v4 前置 PRAGMA） |
| P16 | 建议 | 快照保存失败无显式标记 | T08.6 |
| P17 | 建议 | beforeunload LS 镜像与 SQLite 双写分叉 | T08.10 |
| P18 | 建议 | 协作 agent 40 条静默截断 | 范围外（见 §五） |
| Q24 | 重要 | 恢复后审计事件与 R2 首个事件 sequence 冲突（base=1） | T08.8 |
| Q26 | 重要 | MaxTurns 终态映射两处互斥（Failed vs Completed） | T08.9 |
| Q23 | 重要 | 同会话并发 run sequence 冲突（两 run 并发 base=max+1） | T08.12（v2 新增，AU-04 认领表 #2） |

---

## 一、目标

### 1.1 四条目标与验收口径

1. **数据不丢（新建会话必落库、无级联全删）**
   - 验收口径：全新安装或迁移后，UI 新建会话 → 刷新/重启后会话仍在（SQLite 可查 list_sessions）；
     sessions 表行数与前端列表一致；`cleanup_orphan_sessions` 在任何输入下都不产生全表删除。
2. **事件/会话清理策略明确**
   - 验收口径：events 表有 FK 与保留策略（数值可配置）；会话删除后事件级联清理；事件表有硬上限；
     清理与快照/重放机制不冲突（见 T08.3 时序约束）。
3. **迁移版本化**
   - 验收口径：`PRAGMA user_version` 驱动的逐步迁移；v1→v4 每版本一个函数；重复 open 幂等；
     旧库（v1/v2/v3 fixture）打开后结构与数据符合 v4 规格；DROP 前有备份文件。
4. **恢复机制上线**
   - 验收口径：main.rs 启动调用 `RestoreManager::restore`；崩溃重启后 in-flight run 标记
     interrupted（含审计事件）；快照文件按周期/终态生成；恢复完成后新 run 的 sequence 无冲突
     （Q24）；恢复结果可观测（core_get_status 暴露 restore 状态）。

### 1.2 非目标与范围外

- 不做 P11 时间戳全表统一（破坏面大，列为后续轮输入，见 §五）。
- 不做 P18 会话 agent 上限改造（保留 40 条上限，仅追加 session_meta 截断事实记录可选）。
- 不做双 SQLite/多进程并发读写（当前单进程单连接；WAL/busy_timeout 仅为未来双进程预置，P15）。
- 不做事件增量引擎水合（hydrated_from_engine 写路径保留预留，T08.10 只定所有权与乐观锁）。

### 1.3 关键裁决（实现前必须先确认，本任务书给出裁决）

| 编号 | 议题 | 裁决 | 依据 |
| --- | --- | --- | --- |
| D1 | Q26 MaxTurns 终态 | **MaxTurns → Failed**（run.rs 为权威，normalize.rs 收敛委托） | 见 T08.9 |
| D2 | P04 runs.cursor | **接线保留列**（不删列） | 删列波及快照格式/恢复/测试；接线同时修终态游标与 Q24 回填 |
| D3 | 事件保留策略数值 | 每会话保留 run-terminal + 最近 500 条；硬上限 5000 条/会话；终态会话 90 天 TTL；裁剪前归档 | 见 T08.3 |
| D4 | 写模型（P08） | **前端唯一拥有 session_messages/agents**（全量替换保留）；引擎只写 events；v4 加 updated_at 乐观锁列备用；同会话写入串行化 | 见 T08.10 |
| D5 | 真相源（P09/P02） | **SQLite 为唯一真相源**；LS 索引降级为回退镜像；LS 清理前按 SQLite 集合核对 | 见 T08.2 / T08.10 |
| D6 | 清理时机（P02/P10） | **hydration 完成前禁止清理**；keepIds 空时 Rust 侧拒绝（F4 冻结：`confirm_empty` 显式确认）；清理排除近 5 分钟更新的会话（`ORPHAN_GRACE_MS = 300_000`，F4） | 见 T08.2 |
| D7 | schema v4 定稿 | events 组合主键 + FK + 去冗余；metadata 删除；runs/pending 加 FK；session_messages 加 updated_at；open 前置 WAL/busy_timeout | 见 T08.7 |

---

## 二、任务分解（T08.1 – T08.12）

> 任务模板：现状（证据行号）→ 方案 → 产出 → 验收 → 风险。粒度：一个任务 = 一个可独立验证的改动集。

### T08.1 P01 修复：新建会话落库链路（阻塞）

> 吸收来源：PE-01 T06.1（AU-04 D2 收编，PE-01 已改引用本任务）。
> 命令签名冻结 v1，见 **AU-04 F3**：`upsert_session_entry(entry: SessionIndexEntry)`（对象签名，
> 与底层实现一致；PE-01 平铺参数方案作废）。

**现状**
- `session_commands.rs:73-238` 共 11 个命令，无 `upsert_session_entry` / `insert_session` 暴露；
  `save_session_body`（session_commands.rs:97-110）直调 `db.save_session_body`（lib.rs:490-541，
  DELETE+INSERT，事务），向 `session_messages` INSERT 时经 FK（lib.rs:145 `REFERENCES sessions(id)`）
  校验失败。
- 前端 `persistAllSessionsRust`（sessionRustDb.ts:780-845）：`list` 里新会话无 messages → 跳过
  save_session_body（sessionRustDb.ts:826），**连索引行都没有** → SQLite 无该会话；invoke 失败静默
  回退 LS（AA-07 §四 风险 4）。
- 后果：新会话只存在于 LS；30 天后 `runMigrationCleanupIfNeeded`（migrateFromLocalStorage.ts:187-233）
  连同索引与正文永久删除。

**方案（双层）**
1. **主路径：补建会话行**。在 `session_commands.rs` 新增 Tauri 命令 **`upsert_session_entry(entry:
   SessionIndexEntry) -> Result<(), CoreError>`**（**冻结 v1，AU-04 F3**：对象参数；包装 lib.rs:354-400
   既有实现；`SessionIndexEntry` 已 `#[serde(rename_all = "camelCase")]` 且全字段 default，
   conex-types/src/lib.rs:192-220，可直接 IPC；语义 = ON CONFLICT(id) DO UPDATE，不级联删消息，
   `upsert_does_not_cascade_delete_messages` 先例锚定）；在 main.rs `make_handlers!`（main.rs:27-118）
   注册为 **session 族第 12 个命令**。
2. **前端链路**：`persistAllSessionsRust` 第 0 步改为「对全部非 draft 会话先 upsert 索引
   （并发 invoke），再写 body/agents/meta，最后清理」（顺序固定 = C16 终态顺序，见 T08.2）；
   新建会话即使无消息也因 upsert 落库。
3. **防御自愈**：`save_session_body` 命令执行前若 `sessions` 无该行，先 `INSERT OR IGNORE
   INTO sessions (id, title) VALUES (?1, '')` 再写正文（等价自愈路径；upsert 主路径失败时的兜底，
   不改变"索引先行"语义）。
4. **LS 清理核对（P09 前置）**：`cleanupLegacyLocalStorageSessions`（migrateFromLocalStorage.ts:212-233）
   执行前先 `list_sessions` 取 SQLite 会话集合，仅删除「SQLite 中已存在」会话的 body/agents key；
   索引 key 仅在 SQLite 有该会话且 LS 值更新的前提下删除。

**产出**
- `session_commands.rs`：`upsert_session_entry` 命令 + 单测（含空字段缺省解析）；
- `main.rs`：handler 注册；
- `sessionRustDb.ts`：persist 第 0 步 + 清理核对函数；
- `migrateFromLocalStorage.ts`：清理核对改动；
- conex-db 测试：`save_session_body_fk_missing_session_self_heals`。

**验收**
- 全新内存库：upsert 命令建行 → save body 成功 → list_sessions 有行 → message_count 由触发器维护。
- 前端集成：新建空会话（无消息）→ persist 一次 → SQLite 行存在；重启 hydrate 后会话在列表。
- FK 写路径验证：无会话行时 save_session_body 不再报 FK 错误（自愈）；有行时走正常事务。
- 回归：`upsert_does_not_cascade_delete_messages`（lib.rs:1623）等既有测试不破坏。

**风险**：upsert 与 save body 之间的窗口期另一进程删除会话 → FK 失败仍可能；单进程模型下可接受，
错误仍走 failure latch 上报而非静默。

---

### T08.2 P02 修复：孤儿清理安全化 + boot 窗口时序 + 双库一致性定稿（阻塞）

> 吸收来源：PE-01 T06.2/T06.3（AU-04 D3/D5 收编，PE-01 已改引用本任务）。
> 命令签名冻结 v1，见 **AU-04 F4**：
> `cleanup_orphan_sessions(active_ids: Vec<String>, confirm_empty: bool) -> Result<usize, CoreError>`；
> 宽限期冻结 = **5 分钟**（常量 `ORPHAN_GRACE_MS = 300_000`，session_meta 键 `orphan_grace_ms` 可配；
> PE-01 的 24h 常量作废）。
> 前置依赖：`hydrationComplete` 门闩变量由 **PE-01 T04.4** 产出（公共门闩声明），本任务声明依赖
> （PE-01 先行或门闩变量先落地）。

**现状**
- `cleanup_orphan_sessions`（lib.rs:820-860）：`active_ids.is_empty()` 时执行 `DELETE FROM sessions`
  （lib.rs:834-836），级联清空 session_messages/agents/agent_messages；events/runs 无 FK 无法反推。
- 前端 `persistAllSessionsRust` 末尾无条件调用 cleanup（sessionRustDb.ts:843-844）；同一批次先
  `lsSaveSessionIndex(entries)`（sessionRustDb.ts:798-805）覆盖 LS 索引。
- 触发链：LS 30 天清理 → hydrate 回退 SQLite（索引 LS 优先，sessionRustDb.ts:706-710，此时列表空）→
  boot 窗口内任何会话域变更 → debounce persist → keepIds=∅ → 全库清空（AA-07 P02 描述）。

**方案（三层防线）**
1. **Rust 侧拒绝空删（F4 冻结语义）**：`cleanup_orphan_sessions(active_ids, confirm_empty)`：
   - `active_ids` 非空：删除不在集合内的孤儿行，返回删除行数；
   - `active_ids` 为空 **且 `confirm_empty == false`**：**不执行任何 DELETE**，返回
     `Err(CoreError { kind: "InvalidInput", detail: "cleanup_orphan_empty_keep" })`（命令层映射，
     前端可见）；
   - `active_ids` 为空 **且 `confirm_empty == true`**：显式清空，返回删除行数（仅测试/显式用户清空
     入口使用；`L6` 无 UI 入口，产品需求驱动）。
2. **前端守卫（F4 联动）**：persist 前置守卫 **`hydrationComplete && list.length > 0`**（hydration
   完成前任何会话域变更只更新内存，不触发 persist/cleanup）；`lsSaveSessionIndex` 与
   `lsSaveSessionIndex([])` 同样加守卫（非空才写）。
3. **双库一致性定稿（D5/D6 + C16 终态顺序）**：
   - 持久化顺序固定为单事务序列（**C16 定稿：upsert 全部索引 → 写 body/agents → 写 meta → 清理孤儿
     → 写 LS 索引（非空）**）；清理与写入在同一批次内顺序完成，任一步失败则该批次标记并重试，
     不跨批次乱序。
   - 清理输入 keepIds 的来源改为「hydrate 后的完整会话列表」，不再用剪枝后列表（P10 联动：剪枝出的
     空壳会话仍在 keepIds 内，但其 body 是否删除由 T08.10 的懒壳规则决定）。
   - 清理排除 `updated_at` 距今 < **5 分钟**（`ORPHAN_GRACE_MS = 300_000`，session_meta 键
     `orphan_grace_ms` 可配；F4 宽限期冻结，PE-01 24h 常量作废）的会话（P10 防护窗口）。
   - 清理时机定稿：仅 hydration 完成后的显式时机（hydrate 流程末尾一次），boot 窗口内禁止。
   - LS 索引不再作为真相源：`hydrateSessionsFromRust`（sessionRustDb.ts:701-765）改为 SQLite
     `list_sessions` 优先，LS 仅当 SQLite 空时回退（D5）。

**产出**
- `lib.rs`：`cleanup_orphan_sessions` 签名扩展（`active_ids, confirm_empty`，F4 冻结）+ 空 keepIds 拒绝
  （`InvalidInput: cleanup_orphan_empty_keep`）+ 宽限期常量 `ORPHAN_GRACE_MS = 300_000`（session_meta
  键 `orphan_grace_ms` 可配）+ 测试（`cleanup_orphan_all_when_active_empty` 改为断言拒绝/需 confirm）；
- `session_commands.rs`：命令参数透传 + 错误映射（F4）；
- `sessionRustDb.ts` / `store-persistence.ts`：守卫（`hydrationComplete && list.length > 0`）、C16 顺序
  定稿、真相源切换；
- `migrateFromLocalStorage.ts`：30 天清理核对（T08.1 已含，此处验证联调）。

**验收**
- Rust 单测：空 keepIds 默认拒绝且库内容不变；`confirm_empty=true` 才允许清空（测试用）。
- 竞态测试：模拟"hydrate 前 persist 触发"（见 §三 竞态矩阵）→ 断言无任何 DELETE。
- 端到端：LS 被清空 + SQLite 有数据的场景 → hydrate 恢复列表 → 无清理动作 → 数据完整。

**风险**：`confirm_empty` 语义若被前端误用仍可清空；守卫在前端，Rust 侧以「空 keepIds 拒绝」为兜底，
双层设计下窗口极小。

---

### T08.3 事件表清理策略（保留/归档/上限）

**现状**
- events（lib.rs:126-134）无 FK、无保留策略、无 VACUUM；`delete_session`（lib.rs:604-617）不清理事件；
  `cleanup_orphan_sessions` 同样不清理 → 会话删除后事件永久残留（AA-07 P03）。
- 事件是重放/增量快照的数据源：`restore.rs` 增量流依赖 `lastSequence` 后事件（restore.rs:582-605）。

**方案（D3 定稿）**
1. **v4 FK（T08.7 提供）**：events `REFERENCES sessions(id) ON DELETE CASCADE`；`delete_session` 后事件
   级联清理；runs/pending_inputs 加 FK 后同会话删除自动一致。
2. **保留策略**（conex-db 新增 `prune_events` 方法 + 会话终态/启动扫描两处触发）：
   - 每会话保留 `run-terminal` 事件（不裁剪）+ 最近 `EVENTS_KEEP_PER_SESSION=500` 条（session_meta
     `events_retention_per_session` 可配）；
   - 硬上限 `EVENTS_HARD_CAP_PER_SESSION=5000`：超限即裁剪到保留策略；
   - 终态会话 `EVENTS_TTL_DAYS=90`（按 created_at）；活动会话不按 TTL 裁剪。
3. **归档方案**：裁剪前 best-effort 把被删事件 JSONL 追加到 `app_dir()/event-archive/<session_id>.jsonl`
   （与 `import_from_localstorage` 的 JSONL 兼容格式），并在 session_meta 记
   `events_archived_<session_id> = <count>:<max_sequence>`；归档失败不阻塞裁剪（日志告警）。
4. **大小维护**：裁剪后执行 `PRAGMA incremental_vacuum(100)`；启动时若全库 page 数超阈值（如
   `PRAGMA freelist_count` > 10000）同样执行。
5. **时序约束（与重放安全联动）**：裁剪仅允许在**快照机制已上线（T08.6 完成）且该会话存在完好快照
   覆盖裁剪边界**（`snapshot.last_sequence >= 裁剪边界`）后执行；无快照会话的全量重放依赖早期事件，
   禁止裁剪（启动扫描时对无快照会话跳过，仅记录待裁剪数）。该约束保证"裁剪不破坏恢复"。
6. **事件 payload 上限（v2 新增子项，AU-04 认领表 #7 / AA-05 D-02）**：单事件 payload（序列化后 JSON）
   上限 **256KB**：写入侧（orchestrator append_event / append_events）超限时**截断到 256KB 并追加
   `"truncated": true` 标记字段**（重放解析不失败、前端可见截断事实）；恢复侧解析时对超长历史行
   （v4 之前无标记的存量数据）同样容错截断读取；上限常量 `EVENT_PAYLOAD_MAX_BYTES = 262_144`
   （conex-db 常量，可配性同保留策略）。与 T08.3 的条数上限（500/5000）互补：条数 + 单条大小双闸。

**产出**
- `lib.rs`：`prune_events(session_id, keep) -> PruneStats`、`prune_events_for_retention(ttl_days)`、
  `events_archive_path` 辅助；事件写入截断（`truncate_event_payload`，256KB + `truncated` 标记）；
- 触发点：orchestrator run 终态钩子（T08.6 的 snapshot 钩子同点）+ 启动扫描任务（main.rs 或
  core 初始化）；若 T08.6 未完成则启动扫描只统计不执行。

**验收**
- 单测：超限裁剪保留最近 N + run-terminal；TTL 裁剪不动活动会话；级联删除生效（delete_session →
  events 空）。
- 归档测试：裁剪产生 JSONL 文件且可被 parse_session_messages_flexible 反向解析（抽查）。
- 重放安全测试：有快照会话裁剪后 restore 增量正常；无快照会话不裁剪。
- payload 上限测试：写入 >256KB 事件 → 落库为截断体 + `truncated:true`；重放解析不失败；存量超长行
  读取容错。

**风险**：裁剪边界与快照 last_sequence 的竞态（快照保存失败后裁剪）→ 裁剪前重读快照并校验；
边界误差由保留策略余量（500/5000）兜底。

---

### T08.4 runs.cursor 死列：接线（D2）

**现状**
- `insert_run`（lib.rs:1285-1311）写 cursor（恒 0）；`update_run_status`（lib.rs:1313-1334）**不写
  cursor** → 终态 run cursor=0；`core_get_run_snapshot` 终态分支（core_query_commands.rs:213-228）
  从 store 读到 0（活动分支 195 行用内存实时值，正确）。
- 真实游标只在内存 `next_sequences` 缓存与事件表；restore 的 `SnapshotRun.cursor`（restore.rs:182-188）
  也取自库（恒 0）。

**方案（接线保留列）**
1. `update_run_status` 增加参数 `cursor: Option<i64>`（`Some` 时写入，`None` 保持）；`insert_run` 不变。
2. 写点覆盖三处终态路径：
   - `RunHandle::finalize`（run.rs:417-441）：落库终态时携带该 run 最后已分配 sequence
     （RunHandle.cursor 内存值）；
   - `RunHandle::fail_event_store`（run.rs:449-472）两分支同写；
   - restore 打断路径（restore.rs:530-545）：标记 interrupted 时写 `next_sequence-1`（审计事件前最大
     已落库序列，见 T08.8 的 sequence 口径）。
3. 快照/查询口径统一：`core_get_run_snapshot` 终态游标 = store 行 cursor（接线后即为真实值）；
   `SnapshotRun.cursor` 恢复时保留。
4. 既有测试锚点更新：`in_memory_store_run_roundtrip`（persist.rs:478-502）断言 cursor=0 的用例改为
   终态后 cursor=实际序列；`full_lifecycle_queued_to_completed`（events.rs:623-644）等补充断言。

**产出**：lib.rs / run.rs / restore.rs / core_query_commands.rs 改动 + 相关测试。

**验收**：终态 run 的 store cursor == 该 run 最后事件 sequence；恢复后被打断 run 的 cursor == 会话
最大已落库序列；快照 roundtrip 保留 cursor。

**风险**：低。cursor 语义统一为"已分配最大序列"，与 `base_sequence_for`（core_run_commands.rs:214-233）
的 max+1 口径一致（T08.8 联动）。

---

### T08.5 P05：DB 调用 spawn_blocking 包裹

> 吸收来源：PE-01 T06.4（AU-04 D4 收编，PE-01 已改引用本任务；逐方法清单一致，单执行者防重复）。

**现状（同步调用点清单）**：`LocalDbStore`（persist.rs:384-472）8 个 trait 方法全部同步直调，
阻塞 tokio worker 线程并与前端 11 个命令争用同一把 `Mutex<Connection>`（AA-07 P05 / AA-01 Q27）：

| # | 方法 | 行号 | 同步调用 |
| --- | --- | --- | --- |
| 1 | `insert_run` | persist.rs:397-408 | `db.insert_run` |
| 2 | `update_run_status` | persist.rs:410-419 | `db.update_run_status` |
| 3 | `append_event` | persist.rs:421-431 | `db.append_event` |
| 4 | `query_events` | persist.rs:433-447 | `db.query_events` |
| 5 | `query_runs` | persist.rs:449-451 | `db.query_all_runs` |
| 6 | `save_pending_input` | persist.rs:453-463 | `db.save_pending_input` |
| 7 | `load_pending_inputs` | persist.rs:465-467 | `db.load_pending_inputs` |
| 8 | `delete_pending_input` | persist.rs:469-471 | `db.delete_pending_input` |

**方案**：每个方法内部改为 `let db = self.db.clone(); tokio::task::spawn_blocking(move ||
db.xxx(...)).await.map_err(db_err)?` 模式（与 session_commands.rs:76-79 既有模式一致）。要点：
- 锁（`Mutex<Connection>`）只存在于 spawn_blocking 闭包内，await 边界外无锁（与 AA-01 正面发现 3 一致）；
- `restore.rs` 的 `restore()`（restore.rs:512-622）经 Store trait 调用自动受益；
- 测试环境：`LocalDbStore` 在 `block_on` runtime 中使用，spawn_blocking 可用（tokio 默认多线程
  runtime；若测试用 current_thread runtime 也支持 spawn_blocking）。
- 不引入专用阻塞线程池（系统默认 blocking pool 足够；文档注明单进程约束）。

**产出**：persist.rs 8 处改造 + 一个性能冒烟测试（慢盘模拟：InMemoryStore 40ms 延迟用例已存在，
新增 LocalDbStore 下 `tokio::task::block_in_place` 不可用场景的并发验证）。

**验收**：`cargo test` 全绿；`drive_outcome` 慢 store 测试（events.rs:570-618）时长不变；
clippy 无警告。

**风险**：spawn_blocking 容量（默认 512）在极端并发下排队；当前并发量（run 事件 + 11 命令）远低于
阈值，文档记录即可。

---

### T08.6 P06：恢复/快照机制生产接线

**现状**
- `RestoreManager::restore`（restore.rs:512-622）与 `SnapshotFileStore`（restore.rs:389-463）测试覆盖
  齐全（restore.rs:739-1136），但生产 main.rs setup（main.rs:136-206）只建库建 CoreRunState，从未调用
  restore、从未 save_snapshot（AA-07 P06）。
- 生产侧无会话树维护：`session-leaf-moved` 事件在 orchestrator 有消费（session.rs），但 workbench
  生产路径无 SessionTree 注册表（grep 无命中）。

**方案**
1. **启动接线（main.rs setup，在 `app.manage(CoreRunState)` 之前）**：
   - 构建 `SnapshotFileStore::new(app_dir()/orchestrator-snapshot.json)`；
   - `RestoreManager::restore(&*store, &snapshots).await`；
   - 恢复成功后立即 `StateSnapshot::build(generation+1, outcome.last_sequence, outcome.sessions,
     outcome.runs, outcome.pending_inputs)` 保存（对齐 restore.rs 文档「恢复成功后写快照」）；
   - 恢复结果（RestoreOutcome）注入 CoreRunState：`seed_sequences(outcome)`（逐会话
     base = 库内 max(sequence)+1，预热 `next_sequences`，T08.8 主改动）；
   - 失败路径：restore 返回 Err → tracing error + core_get_status.restore.state=failed（不阻塞启动，
     run 命令照常可用，事件序列锚点由 base_sequence_for 懒计算兜底）。
2. **恢复完成前门禁**：`run_task_impl`（core_run_commands.rs:420-468）入口检查 restore 完成标记
   （`tokio::sync::OnceCell`/watch，restore 未完成返回 `CoreError::Internal("restore in progress")`），
   杜绝「新 run 先算 base、restore 后写审计事件」的 Q24 竞态。
3. **快照周期**：
   - 触发点 A：run 终态（drive_outcome 完成后钩子，与 T08.3 裁剪同点）；
   - 触发点 B：周期任务（tokio interval，默认 60s，session_meta `snapshot_interval_ms` 可配；
     仅在存在活动 run 或上次快照后有新事件时保存，避免空转写）；
   - 触发点 C：优雅退出（main.rs `RunEvent::Exit`，run.rs:215-218 现有钩子处追加 save）。
   - 快照内容组装：`sessions = session_tree_registry()`（见 4）+ `runs = store.query_runs()` +
     `pending = load_pending_inputs per session` + `last_sequence = max(events)`。
4. **会话树注册表（新增轻量组件）**：`SessionTreeRegistry`（orchestrator 或 workbench 层）：
   每个会话一个 `SessionTree`；drive_run_loop 的事件流中拦截 `session-leaf-moved`（
   `SESSION_LEAF_MOVED_EVENT`，restore.rs:29）apply 到注册表并 `to_session_record()` 供快照；
   注册表只增会话记录不删除（会话删除时移除）。若 B4.5 goal 模式未激活导致该事件生产不存在，
   注册表为空数组即可（快照结构不变）。
5. **P16 显式标记**：`save_snapshot` 失败 → tracing error + `CoreRunState.snapshot_last_error` 记录；
   `core_get_status` 扩展 `restore`/`snapshot` 字段（**F2 冻结形状，v1 见 AU-04 F2**）：
   `restore: {state: pending|done|failed, mode, snapshotNote, interruptedCount, lastSequence}`
   与 `snapshot: {generation, writtenAt, lastError}`。
   **串行序声明（F2）**：core_query_commands.rs 字段扩展排在 PE-01（字段基线）→ PE-03
   （activeRuns/pendingApprovals/mcpStatus）→ PE-04（logLevel/logDir/diagnostics/lastError）**之后**，
   本任务只以追加参数并入 restore/snapshot 两域，严禁并行改同一函数。

**产出**：main.rs 接线、CoreRunState 扩展（restore 标记 + snapshot 状态 + SessionTreeRegistry +
seed_sequences）、core_get_status 字段扩展、终态/周期/退出三处快照钩子。

**验收**
- Rust 集成测试：临时文件库 → 写 runs+events+pending → 模拟崩溃（drop 重建连接）→ 重新 restore →
  断言 interrupted 审计、快照生成、恢复后会话树与 pending 齐全。
- 生产路径冒烟：启动日志出现 restore 结果；崩溃重启后 core_get_status.restore 状态正确；
  `orchestrator-snapshot.json` 生成且 `.prev` 轮转正确。
- Q24 集成（T08.8 共享验收）：恢复后新 run 无 sequence 冲突。

**风险**：快照写入与并发 run 事件追加的窗口（快照读 store 时事件在写）→ 快照只是"近似一致"即可
（增量重放以 last_sequence 锚点补足，restore 设计如此）；session 树注册表为空时快照退化为
runs+pending（可恢复性下降但不丢 runs 状态）。

---

### T08.7 P07：迁移版本化 + schema v4 定稿

**现状**
- migrate()（lib.rs:63-266）每次 open 无条件执行；旧表检测靠字符串启发（lib.rs:76-105：缺 folder 列 /
  SQL 缺 CHECK 子串），命中即 DROP 无备份；`schema_version='3'` 用 `INSERT OR IGNORE`（lib.rs:259-263）
  写死一次，永不演进（AA-07 P07）。

**方案**
1. **迁移框架**：
   - 版本源改用 `PRAGMA user_version`（整数，SQLite 原生）；`session_meta.schema_version` 字符串
     同步维护（前端读取，set 为最新版本）。
   - **schema_version 计数值修正（v2）**：`LATEST_VERSION = 4`；v4 迁移完成后
     `session_meta.schema_version` 写入 **'4'**（原 `schema_version='3'` 写死为迁移前形态标记，
     v4 后更新，`schema_version_is_three` 测试改为断言 v4）；字符串与 `PRAGMA user_version` 两个
     源以 PRAGMA 为权威，字符串仅作前端只读展示。
   - `migrate()` 改为循环：`for v in current_version+1 ..= LATEST_VERSION { migrate_to_v(v)?; }`；
     每个 `migrate_to_v` 独立事务，成功后 `PRAGMA user_version = v`；整体幂等（重开跳过已执行版本）。
   - **DROP 前备份**：`app_dir()/sessions.db.bak-v{n}`（copy 或 rename 快照），保留最近 2 份；
     迁移失败 → 回滚事务 + 日志 + 恢复备份文件（若存在）。
   - 移除字符串启发式检测分支（lib.rs:73-105），替换为显式版本迁移。
2. **迁移脚本列表（定稿）**：
   | 版本 | 内容 | 数据策略 |
   | --- | --- | --- |
   | v1 | 初始：sessions(无 folder) + events + metadata + session_messages(FK) + session_agents + session_meta + 触发器 + runs + pending_inputs | — |
   | v2 | sessions 加 folder/is_pinned/is_archived/branch_parent_id/timestamp 等列（旧表备份后重建并拷贝 id/title/created_at） | 拷贝可拷贝列 |
   | v3 | session_agent_messages 重建加 `CHECK (status IN ...)`（现 lib.rs:92-105 逻辑正式化） | 备份后重建，拷贝数据；失败回退备份 |
   | v4 | 见下（D7 定稿） | 数据保留 |
   - v2→v3 与旧表 DROP 路径补迁移测试（AA-07 P07 缺口）：构造 v1/v2/v3 fixture → open → 断言到达
     v4 + 数据保留 + 备份文件存在 + 二次 open 幂等。
3. **schema v4 定稿（D7）**：
   - **events 重建**（数据拷贝，事务内）：`PRIMARY KEY (session_id, sequence)` 组合主键（替代
     AUTOINCREMENT id，P14；`StoredEvent.id` 无生产消费方——orchestrator 的 PersistedEvent 已丢弃
     id 列，core 层消费 PersistedEvent）；`REFERENCES sessions(id) ON DELETE CASCADE`（P03）；
     删除冗余 `idx_events_session_seq`（P13，组合主键即索引）；改 `WITHOUT ROWID`。
   - **metadata 表删除**（P12）：v4 迁移 `DROP TABLE metadata`。
   - **runs / pending_inputs 加 FK**：`REFERENCES sessions(id) ON DELETE CASCADE`（P03 同源）；
     风险控制：T08.1 保证会话行先于 run 存在（run_task_impl 前置 upsert 守卫）。
   - **session_messages 加列** `updated_at INTEGER NOT NULL DEFAULT 0`（D4 乐观锁预留；`ALTER TABLE
     ADD COLUMN` 即可）。
   - **open() 前置 PRAGMA**（P15）：`PRAGMA journal_mode=WAL;`（失败降级不回滚）+ `PRAGMA
     busy_timeout=5000;`（migrate 前，lib.rs:33-45 处）。
   - v4 迁移函数自带结构断言（每版本迁移后 `PRAGMA table_info` / `PRAGMA foreign_key_list` 校验）。
4. **迁移测试**：`tests/migrations.rs`（或 lib.rs 测试模块）：
   - fixture 构造：手工 SQL 建 v1/v2/v3 库（含脏数据）→ `LocalDb::open` → 断言 user_version=4、
     数据行数、FK 生效、events 组合主键、备份文件；
   - 幂等：同库二次 open 无副作用；迁移中断模拟（注入失败点）→ 重试成功。

**产出**：lib.rs migrate 重构 + v4 迁移 + PRAGMA 前置 + 备份工具 + 迁移测试。

**验收**：既有 3 个数据库文件样本（真实 v3 库）升级后数据完整；`schema_version_is_three` 测试改为
断言 v4；全量 `cargo test` 通过。

**真实样本来源（v2 指定，AU-04 认领表 #17）**：执行者从用户机器收集 **≥1 个真实 v3 库** 作为迁移验收
样本（隐私：脱敏后仅用于本地测试，不入库）；同时按 §三.3.1 构造法在 `tests/migrations.rs` 构造
v1/v2/v3 等价 fixture。无真实样本时以 fixture 为准并在验证记录中登记「无真实样本」。CE 阶段
（events 重建等破坏性迁移）的既有 v1/v2/v3 fixture 迁移测试全部保留为强制回归。

**风险**：events 重建期间连接中断 → 事务回滚，user_version 不推进 → 重启重试（幂等）；
WAL 在只读介质失败 → 降级 DELETE journal 并告警。

---

### T08.8 Q24：恢复后 sequence 续接（不重置）

**现状**
- 恢复审计事件用 `next_sequence = max(events)+1`（restore.rs:644-652）；若新 run 的 EventQueue 以
  `run.cursor+1`（cursor=0）为 base（AA-01 §3.2 描述的 events.rs:578 构造模式），base=1 与历史事件
  冲突 → UNIQUE 失败 → run 标记 event-store-write-failed。
- 生产路径实际已用 `base_sequence_for`（core_run_commands.rs:214-233，懒加载 max+1），**单看该函数
  正确**；剩余风险是**时序**：restore 未接线（P06）时无审计事件无冲突；一旦 T08.6 接线，若新 run
  在 restore 完成前算 base，审计事件后写 → 冲突。此外 RunHandle.cursor 与库 cursor 均为 0，恢复结果
  的 runs 无人消费（AA-01 §3.2 末句）。

**方案（不重置、续接）**
1. **门禁**（T08.6 已含）：restore 完成前 `run_task_impl` 拒绝新 run。
2. **预热锚点**：CoreRunState 新增 `seed_sequences(outcome: &RestoreOutcome)`——对 outcome.sessions
   中每会话，查 store 库内 max(sequence)+1 写入 `next_sequences`（审计事件已落库，口径自然含之）；
   之后 run 的 base = 预热值，**不重置为 1**。
3. **构造口径统一**：`run_task_impl`（core_run_commands.rs:447-452）的 EventQueue base 继续走
   `base_sequence_for`（预热后命中缓存）；删除任何以 `run.cursor+1` 构造 EventQueue 的生产路径
   （events.rs 测试内模式不改，加注释注明测试专用）。
4. **cursor 回填**（与 T08.4 联动）：restore 打断路径写库 cursor = 会话 max 序列；`RestoreOutcome.runs`
   消费点 = 快照保存（T08.6）与 core_get_run_snapshot，无其他消费方，回填仅保证一致性。
5. **Q25（v2 升级为必做，AU-04 认领表 #10；原「可选子项，若不接则记录决策」作废）**：
   events.rs:293-309 中途失败路径的终态用 `next_sequence` 产生空洞，**必做**改为复用失败 sequence
   （对齐 340-367 重发路径语义）；验收补「失败路径无序列空洞」断言（与 Q24 同文件区，串行实施）。

**产出**：seed_sequences、门禁联调、T08.4 回填联动、集成测试。

**验收（关键验收）**
- 集成测试：temp 库 → R1 跑至 seq=5 → 恢复（审计事件 seq=6）→ R2 base=7 → 全事件 1..=N 连续无冲突；
- 恢复后新 run 首个事件 sequence == 恢复后 max+1（不等于 1）；
- 重复恢复（同库二次 restore）幂等：无重复审计事件、无 sequence 冲突。

**风险**：低（门禁 + 预热 + 懒计算三重兜底）。

---

### T08.9 Q26：终态映射裁决（D1）

**现状**：两处互斥映射：
- run.rs:559-572 `map_outcome_to_terminal`：`MaxTurns → (Failed, "max-turns")`（有测试锚定 run.rs:680-701、
  events.rs:847-865）；
- normalize.rs:109-117 `terminal_status_for_end_reason`：`MaxTurns → Completed`（注释与测试锚定
  normalize.rs:450-472）。

**裁决：MaxTurns → Failed**。依据：
1. orchestrator 拥有 run 生命周期与终态落库，run.rs 是权威映射（run 状态机/events 驱动均走它）；
2. `allows_auto_continue`（normalize.rs:151-153）对 MaxTurns 裁决"不续轮"，语义与 goal 模式
   `goal-max-rounds` blocked（restore.rs:656-664）一致——预算耗尽属阻断而非自然完成；
3. TS 历史锚点 orchestrator.test.ts:1223 即 max-turns → failed（events.rs:860 注释引述）。

**方案**：
1. 收敛为单一权威函数：`map_agent_end_to_terminal(reason) -> RunTerminalStatus` 放 run.rs
   （与 `map_outcome_to_terminal` 同模块）；normalize.rs 的 `terminal_status_for_end_reason` 改为
   委托该函数（或二者合并，保留薄包装防破坏既有 import）。
2. 修 normalize.rs:450-472 锚定测试与注释：MaxTurns → Failed。
3. 一致性测试：两模块互引测试（normalize 调用 run.rs 的权威函数对全 reason 断言，run.rs 侧
   断言映射表 5 个 reason 唯一），防再次分叉。
4. 消费方核对：`end_reason_for_terminal`（normalize.rs:121-127）逆映射保持（Failed→Error 不变）；
   restore 的终态保真（restore.rs:830-875）不涉及该映射，无改动。

**产出**：run.rs / normalize.rs 改动 + 互引测试。

**验收**：MaxTurns 事件经 drive_outcome → Failed + "max-turns" + MAX_TURNS_FAILED_MESSAGE
（events.rs:847-865 既有断言保持）；normalize 侧投影同一输入 → Failed；全 reason 两处一致。

**风险**：低。若未来产品语义改为"预算用尽视为自然收场"，只改权威函数一处即可。

---

### T08.10 前端写模型定稿（P08 / P09 / P10）

> 写模型冻结 v1，见 **AU-04 F7**：`save_session_body` 全量替换语义**保留不变**（事务内 DELETE 全表 +
> 逐条 INSERT；产品语义 = 可删除/编辑历史消息）。PE-09 T09.4.1「改 ON CONFLICT upsert」条目**已删除**
> （R6 撤销）。`append_session_messages`（session 族第 13 个命令）唯一负责 = **PE-09 T09.4.1 第 1 条**；
> 本域提供底层增量 API（lib.rs:543-601）并登记 manifest/契约（F7）。**串行声明**：sessionRustDb.ts 由
> 本任务写模型定稿先行 → PE-09 T09.4.2 增量接线在后（AU-04 附录串行表）。

**现状**
- P08：`save_session_body` 全量"先删后插"（lib.rs:490-541）；前端 persist 并发 per-session invoke
  （sessionRustDb.ts:815-831，Promise.allSettled）+ 350ms debounce；引擎只写 events，`hydrated_from_engine`
  列（lib.rs:122）已预留但无写路径 → 当前单一写者，风险在"未来引擎写消息"与"同会话并发替换"。
- P10：`prepareSessionsForUi`（hydrate 时剪枝非活动空壳）→ 剪枝会话不在 keepIds → 被
  cleanup_orphan_sessions 级联删除，恰好命中"懒壳正文在 SQLite、内存为空壳"场景。
- P09/P17：30 天 LS 清理与索引真相源矛盾；beforeunload 双写镜像。

**方案（D4/D5 + F7）**
1. **写者所有权定稿**：`session_messages` / `session_agents` / `session_agent_messages` 由**前端唯一**
   拥有（全量替换保留，事务原子）；引擎只写 events/runs/pending_inputs。未来引擎水合写消息必须：
   先经 upsert 索引（T08.1）再走 `append_session_messages`（lib.rs:544-601，增量语义；命令与前端
   接线由 PE-09 T09.4 承担）或 CAS（读 updated_at → 写 → 校验，v4 列）。文档在 03-frontend-contract.md
   对应节登记该所有权。
2. **同会话写入串行化**：`persistAllSessionsRust` 改为 per-session 串行队列（或保留并发但按会话
   分组排队），杜绝同会话两个 debounce 批次的"先删后插"交错；批次间以 session 级别 version 递增
   校验（updated_at CAS 哨兵）。
3. **懒壳防护（P10）**：清理规则改为「keepIds 之外的会话，若其 SQLite `updated_at` 距今 < 5 分钟
   （`ORPHAN_GRACE_MS = 300_000`，F4 宽限期）或 `message_count > 0`，跳过删除并告警」；空 body
   不写 SQLite 的既有防护（sessionRustDb.ts:816-817）保留。
4. **真相源切换（P09）**：hydrate 改为 SQLite 优先（T08.2 已定）；30 天清理核对（T08.1 已定）；
   beforeunload（beforeunloadFlush.ts）在 `legacy_localstorage_cleaned='1'` 后移除 LS 镜像写
   （仅 SQLite 单写路径，P17）。
5. **截断事实（P18 轻量）**：`SESSION_AGENTS_SAVE_CAP=40` 截断时写 session_meta
   `agents_truncated_<sessionId>`（仅记录，不改上限）。

**产出**：sessionRustDb.ts / sessionLocalStorage.ts / migrateFromLocalStorage.ts / beforeunloadFlush.ts
改动 + 前端测试（persist 顺序、懒壳、清理守卫）。

**验收**
- 前端单测：两个连续 persist 批次同一会话不交错；剪枝空壳会话不被删除（近 5 分钟窗口）；
- hydrate：LS 为空 + SQLite 有数据 → 列表完整；
- 回归：既有持久化测试（sessionLocalStorage.test 等）全绿。

**风险**：串行化降低并发写吞吐（可接受：350ms debounce 下每批次 per-session 串行）；
updated_at CAS 在无引擎写者时是纯预留，不影响现网。

---

### T08.11 验证与回归汇总

见 §三。本任务 = 汇总执行验证矩阵、修复验证期暴露的问题、更新 05-test-mapping.md 与
30-verification-checklist.md 的持久化条目。

---

### T08.12 Q23：会话级 sequence 原子分配（v2 新增，AU-04 认领表 #2）

**现状与问题**
- `base_sequence_for`（core_run_commands.rs:214-233）以「库内 `max(sequence)+1`」懒计算事件序列基点；
  **同一会话两个 run 并发**时，各自读 max+1 得到相同 base → 后续 append 事件 sequence 冲突
  （UNIQUE(session_id, sequence) 失败）→ run 标记 event-store-write-failed（Q23，重要）。
- 现状单进程模型下并发面来自：同会话手动连发 + 恢复/快照路径（T08.6 接线后 restore 与新 run 并发）。
- 与 T08.8（Q24）的边界：Q24 是「restore 完成前」的时序竞态（门禁 + 预热解决）；Q23 是「restore
  完成后、同会话多 run 并发 append」的分配原子性问题，两者互补。

**方案（二选一，取定后登记）**
1. **首选：conex-db 提供 `reserve_sequence(session_id) -> Result<i64, CoreError>`（单行原子自增）**：
   - `session_meta` 表（或新建 `session_sequence` 表）以会话为行，`INSERT ... ON CONFLICT DO UPDATE
     SET next_seq = next_seq + 1 RETURNING next_seq`（SQLite 单语句事务天然原子，无需外部锁）；
   - 事件写路径（orchestrator LocalDbStore::append_event / append_events）统一改经
     `reserve_sequence` 取号，彻底替代「读 max+1 再插」的两步窗口；
   - T08.8 的 `seed_sequences` 预热逻辑并入：恢复完成后按库内 max(sequence) 对齐
     `session_sequence` 表初值（一次校准，避免跳过/重复）。
2. 备选：orchestrator 每会话 `AtomicU64` 缓存 + store 校验兜底（不新增表，但进程内缓存与库内 max
   需一致性维护，跨重启首次需校准）——仅在方案 1 的 RETURNING 受限（旧 SQLite 版本）时启用。

**产出**：conex-db `reserve_sequence` + 迁移（v4 内，T08.7 落地后新增表/列）+ orchestrator 事件写路径
改号源 + T08.8 预热校准 + 并发集成测试。

**依赖**：T08.7（schema v4 定稿后加表/列）、T08.8（预热锚点共享）。

**验收**
- 并发测试：同会话**双 run 并发**各 append 50 事件 → 全序列号唯一连续、无 UNIQUE 冲突、无
  event-store-write-failed；
- 与 T08.8 集成：恢复后新 run 首事件 sequence == 预热值（非 1），随后并发 run 无冲突；
- 既有序列连续性测试（events.rs）全绿；clippy 无新告警。

---

## 三、验证

### 3.1 迁移测试（T08.7 交付）

| 用例 | 断言 |
| --- | --- |
| v1 fixture → open | user_version=4；sessions 列含 folder 等 v2+ 列；数据（id/title/created_at）保留 |
| v2 fixture（session_agent_messages 无 CHECK）→ open | 表重建含 CHECK；数据保留或备份存在 |
| v3 fixture（当前生产形态）→ open | events 组合主键 + FK；metadata 不存在；runs/pending 有 FK；session_messages 有 updated_at |
| 二次 open | 幂等：无重复迁移、无备份堆积（最多 2 份）、user_version 不变 |
| 迁移中断注入 | 事务回滚，user_version 不推进，重试成功 |
| 备份存在性 | `sessions.db.bak-v{n}` 可读且含迁移前数据 |

### 3.2 竞态测试（T08.2 / T08.5 / T08.10 交付）

| 场景 | 构造 | 断言 |
| --- | --- | --- |
| boot 窗口清理 | hydrate 未完成时触发 persist（keepIds=[]） | Rust 侧拒绝；库行数不变；LS 索引未被清空 |
| 并发事件 + 全量替换 | 引擎 append_event 与 save_session_body 并发 100 轮 | 无 FK 失败；events 与 messages 各自完整；无锁死 |
| spawn_blocking 吞吐 | LocalDbStore 慢盘模拟下并发 run+命令 | 无 worker 饥饿（drive 不阻塞）；时长与 InMemory 基线同量级 |
| 同会话双批次替换 | 两个 debounce 批次交错 | 串行化后最终一致，message_count 正确 |
| 空 keepIds 显式确认 | confirm_empty=true 路径 | 仅测试/显式清空可用，默认拒绝 |
| 同会话双 run 并发 append（Q23，T08.12） | 双 run 并发各 append 50 事件 | 序列唯一连续、无 UNIQUE 冲突、无 event-store-write-failed |

### 3.3 重启恢复 e2e（T08.6 / T08.8 交付）

1. **Rust 集成**：临时文件库 → 引擎跑 run 至中途 → drop 连接模拟崩溃 → 重新 open + restore →
   断言：in-flight 标记 interrupted（previousStatus 审计事件落库，restore.rs:548-564）；
   快照文件生成；新 run base = max+1 无冲突；pending 输入 FIFO 恢复。
2. **进程级（可选脚本）**：启动 Tauri 壳 → 发起 run → 强杀进程 → 重启 → 检查
   `core_get_status.restore` 状态、`core_read_session_events` 含 run-interrupted、新 run 正常。
3. **快照回退**：手动损坏 snapshot.json → 重启 → snapshot_note 含"回退"，恢复至 .prev 版本
   （restore.rs:406-420 既有语义生产路径复验）。
4. **清理联动**：会话删除 → events/runs/pending 级联清理（v4 FK）→ 快照重建后不残留。

### 3.4 回归清单

- `cargo test` 全量（conex-db / orchestrator 重点）+ `cargo clippy`；
- 前端 `npm test`（session-persistence 相关）；
- 既有锚点不破坏：`upsert_does_not_cascade_delete_messages`、`trigger_maintains_message_count`、
  `run_terminal_is_emitted_exactly_once`、restore 全量/增量/回退 4 类测试（restore.rs:913-1101）；
- T08.12 新增：`reserve_sequence` 原子性 + 并发双 run 无冲突测试；
- 30-verification-checklist.md 持久化条目更新。

---

## 四、执行顺序

### 4.1 依赖关系

```
T08.5（spawn_blocking）           —— 无依赖，最先（低风险环境改造）
   │
T08.1（P01 落库链路）             —— 无依赖（阻塞级，优先）
   │
T08.2（P02 清理安全化）           —— 无依赖（阻塞级，优先）
   │
T08.7（迁移版本化 + v4）          —— 依赖 T08.1/T08.2 的写路径稳定（v4 的 FK 需要会话行先存在）
   │
   ├──▶ T08.3（事件清理）         —— 依赖 T08.7（events FK）+ T08.6（快照上线才激活裁剪）
   ├──▶ T08.4（cursor 接线）      —— 依赖 T08.7（schema 稳定）
   │
T08.6（恢复/快照接线）            —— 依赖 T08.5、T08.7（迁移后连接模型稳定）
   │
T08.8（Q24 sequence 续接）        —— 依赖 T08.6（门禁 + 审计事件真实存在）
   │
T08.12（Q23 原子分配，v2 新增）   —— 依赖 T08.7（v4 加 session_sequence 表/列）+ T08.8（预热校准共享）
   │
T08.9（Q26 映射裁决）             —— 独立（可并行）
   │
T08.10（前端写模型）              —— 依赖 T08.1、T08.2（前端链路已定）；T08.3 之后联调清理；与 PE-09 T09.4 串行（F7：本任务定稿先行，PE-09 增量接线在后）
   │
T08.11（验证汇总）                —— 依赖全部
```

### 4.2 推荐执行批次

| 批次 | 任务 | 理由 |
| --- | --- | --- |
| 第 1 批（数据不丢，阻塞） | T08.5 → T08.1 → T08.2 | 先清环境噪音（spawn_blocking），再修两个数据丢失级缺陷；T08.1/T08.2 无相互依赖可并行 |
| 第 2 批（schema 与游标） | T08.7 → T08.4 → T08.9 | 迁移定稿是一切 schema 依赖的基础；cursor 接线与映射裁决独立小改 |
| 第 3 批（恢复上线） | T08.6 → T08.8 → T08.3 | 恢复接线后才有审计事件与快照；Q24 门禁与预热随接线交付；事件裁剪依赖快照安全网 |
| 第 4 批（并发序列） | T08.12 | v2 新增（Q23）；依赖第 2 批的 v4 schema 与第 3 批的预热锚点，与 T08.10 并行 |
| 第 5 批（前端收敛） | T08.10 | 依赖第 1 批链路定稿，最后联调清理与真相源；与 PE-09 T09.4 串行（F7） |
| 第 6 批 | T08.11 | 全量验证 + 文档更新 |

### 4.3 并行支线

- T08.9 与第 2 批并行（独立模块）；
- T08.4 与 T08.3 在 T08.7 后并行；
- 每批结束跑 §三 对应验证矩阵，问题回填本节。

---

## 五、遗留问题与后续轮次输入

| 编号 | 内容 | 建议去向 |
| --- | --- | --- |
| L1（P11） | 时间戳三套格式统一（sessions.timestamp ISO vs events datetime('now') vs epoch ms） | 后续 PE 域（v5 迁移候选），本域不做 |
| L2（P18） | 会话 agent 40 条截断（本域仅记录截断事实） | 后续 PE 域或 UI 提示 |
| L3（Q25） | 中途持久化失败路径终态序列空洞 | T08.8 子项（v2 升必做，AU-04 认领表 #10） |
| L4 | 引擎水合写 session_messages 的未来路径（updated_at CAS 激活） | 引擎水合域（B4.5/Phase C） |
| L5 | 多进程并发打开 sessions.db（daemon+壳） | WAL/busy_timeout 已预置（T08.7），双进程接线待 daemon 域规划 |
| L6 | `confirm_empty` 显式清空的 UI 入口 | 产品需求驱动，默认无入口 |
