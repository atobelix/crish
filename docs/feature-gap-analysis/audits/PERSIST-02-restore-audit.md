# PERSIST-02 恢复与崩溃一致性严格审计

- 审计域：重启恢复（`orchestrator::restore`）与崩溃一致性
- 审计员：子代理 A2（持久化/恢复严格审计）
- 日期：2026-08-07
- 结论速览：崩溃矩阵 **8 个时机**；新发现问题 **P0 = 0 / P1 = 3 / P2 = 11**
- 审计方式：只读代码 + 逐行核对，未运行任何命令、未修改任何文件

---

## 1. 审计范围与方法

必读文件全部精读/核对：

| 文件                                                                | 用途                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `crates/orchestrator/src/restore.rs`（1620 行，全量）               | 恢复主流程、快照模型、恢复测试                                              |
| `crates/orchestrator/src/persist.rs`（1069 行，全量）               | Store trait / LocalDbStore / InMemoryStore / SessionSequencer               |
| `crates/orchestrator/src/events.rs`（1195 行，全量）                | EventQueue 持久化分流 / drive_outcome 收口                                  |
| `crates/orchestrator/src/session.rs`（关键段 140-340）              | SessionRecord / apply_leaf_move_event / apply_compression_end               |
| `crates/conex-db/src/events.rs`、`sessions.rs`                      | events 表、session_sequence、sessions 表                                    |
| `crates/conex-db/src/migrate.rs`（95-194）                          | 迁移事务 + 备份时序                                                         |
| `apps/agent-workbench/src-tauri/src/main.rs`（330-470）             | restore 接线、退出钩子                                                      |
| `apps/agent-workbench/src-tauri/src/core_run_commands.rs`（相关段） | run_restore / seed_sequences / build_and_save_snapshot / restore_ready 门禁 |
| `crates/conex-types/src/context.rs`（30-109）                       | SessionContextMeta                                                          |
| `crates/conex-types/src/events.rs`（306-910）                       | AgentEvent 41 变体 / type_name 注册表                                       |
| `crates/orchestrator/tests/crash_consistency.rs`                    | 崩溃一致性测试（8 用例）                                                    |
| `crates/conex-db/tests/upgrade_e2e.rs`、`migrations.rs`             | 迁移 e2e / 备份时序                                                         |
| `crates/orchestrator/src/flow_graph.rs`（941-1522 关键段）          | FlowScheduler::load / advance / is_ready                                    |

---

## 2. 恢复主链路（维度 1）

### 2.1 调用链与顺序

`main.rs:376-384` 在 `app.manage(CoreRunState)` **之前**经 `tauri::async_runtime::spawn` 异步执行 `run_restore`；`core_run_commands.rs:1720-1779` 内部分步：

1. **快照加载**：`RestoreManager::restore` → `snapshots.load_snapshot()`（checksum 校验、损坏回退 `.prev`，restore.rs:537）；
2. **runs 全量扫描**：`store.query_runs()`（restore.rs:545，**run 表为权威数据源**）；
3. **in-flight 打断**：6 态（queued/initializing/running/awaiting-approval/cancelling/**completing**）→ 终态 interrupted（cancelling → cancelled，其余 → failed），逐条写 `run-interrupted` 审计事件 + `update_run_status`（restore.rs:551-605，restore.rs:693-707 的 is_inflight 判定）；
4. **会话组装**：快照会话 ∪ run 派生会话（restore.rs:607-623）；
5. **增量重放**：lastSequence 后事件流，只重放 `session-leaf-moved` 与 `context-compression-end` 两类（restore.rs:625-658）；
6. **pending 恢复**：按会话 `load_pending_inputs`（FIFO：created_at 升序 + id 决胜，restore.rs:660-664）。

恢复成功后壳层继续：`seed_sequences`（按库内 max+1 预热会话级序列计数器，core_run_commands.rs:1688-1712）→ **会话注册表水合**（core_run_commands.rs:1730-1733）→ **`restore_ready` 门禁放行**（core_run_commands.rs:1735）→ 立即保存快照（core_run_commands.rs:1738）。

### 2.2 门闩

- `run_task` 在 `restore_ready` 置位前拒绝新 run（core_run_commands.rs:2674-2676："restore in progress"），杜绝「新 run 先算 base、restore 后写审计事件」的 Q24 竞态；
- 门禁在 seed 之后放行（顺序正确，core_run_commands.rs:1728-1735）；
- **失败路径也放行**（core_run_commands.rs:1775）：restore Err → `restore.state=failed` 可观测 + `base_sequence_for` 懒计算兜底（core_run_commands.rs:1662-1684），不阻塞启动（降级合理）。

### 2.3 恢复后一致性核对

- 恢复的 run：in-flight 已终态化（interrupted），终态记录原样保留（含 blocked 类 reason，restore.rs:722-730），未知字面量 `RunStatus::Unknown` 透传不打断不改写并显式上报（restore.rs:554-562，裁决 D3）；
- 恢复的会话：`RestoreOutcome.sessions` 快照会话 ∪ run 派生会话；**但派生会话的 branches 恒为空**（见 P2-4）；
- pending 输入：FIFO 恢复（restore.rs:1030-1060 测试锚定）。

---

## 3. 事件重放正确性（维度 2）

### 3.1 哪些事件进重放（41 变体 + 2 引擎事件）

事件注册表共 **41 个变体**（conex-types/src/events.rs:806-848，`ALL_TYPE_NAMES` 编号 1-41；任务书所述「27 变体」为旧计数）。重放面：

| 类别                                      | 事件                                                                                     | 行为                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **进重放（2 类，restore.rs:644-656）**    | `session-leaf-moved`                                                                     | 重放叶子移动 → `current_leaf_id`                                                         |
|                                           | `context-compression-end`                                                                | 折叠进 SessionContextMeta（T-34：护栏重建，restore.rs:647-655）                          |
| **恢复自产审计（不重放）**                | `run-interrupted`                                                                        | 落库可追溯；重放时被忽略（非上述两类，天然无害）                                         |
| **落库但不重放（39 类）**                 | agent-start/end、message-_、tool-_、run-terminal、subagent-_、task-_、timer-_、cron-_ 等 | events 表是前端投影源（B6.3 事件桥），**不是引擎恢复源**；引擎恢复只靠快照会话 + DB runs |
| **不落库（4 类 Delta，events.rs:47-57）** | message-delta、subagent-event.progress、task-output、task-heartbeat                      | 崩溃即丢（设计内「可丢增量」）                                                           |

### 3.2 幂等 / 乱序 / 重复

- **乱序**：`query_events` `ORDER BY sequence ASC`（conex-db/events.rs:48），无乱序；
- **重复**：`UNIQUE(session_id, sequence)` 约束 + 会话级原子取号（conex-db/events.rs:72-99），无重复行；
- **幂等**：`restore` 每进程只跑一次（main.rs 单点 spawn）；重复调用场景（非生产）下 `apply_compression_end` 的 generation +1 会重复累计（无幂等锚，restore.rs:213），leaf-move 重放天然幂等。**生产路径无二次 restore，不构成现实风险**，但同进程二次 restore 无防护（P3 备注）。
- **损坏载荷容错**：leaf-move 载荷坏 → `let _ =` 静默跳过（restore.rs:646）；压缩事件 JSON 坏/时间戳坏 → 保持既有护栏状态不写坏（restore.rs:651-655 + 测试 restore.rs:1584-1619）。容错存在但**无日志**（P2-10）。

### 3.3 重放锚点缺陷（P1-1，重点）

restore.rs:627-640 的增量重放锚点存在两个互相叠加的缺陷，测试仅覆盖单会话路径（restore.rs:1064-1145），多会话从未验证：

1. **全局 max 作会话 base**：`build_and_save_snapshot` 把 `last_sequence` 存为**全会话事件 max**（core_run_commands.rs:1808-1815），restore 却把它当**每个会话的增量起点**（restore.rs:631-640）。事件序列是**会话内独立**的（conex-db/events.rs:80 `session_sequence` 每会话一行）。若会话 B 的序列落后于全局 max（快照时 B=30、A=100），B 在快照后新增的事件（seq 31-100）**全部被跳过**——`query_events(B, 100)` 只返回 >100 的行，B 没有。
2. **snapshot_session_ids 取错集合**：该列表从**组装后**的 sessions 提取（restore.rs:627-630），而非快照自身会话 → 快照后新建的派生会话也命中 `base = base_sequence`（全局 max），与注释「新派生会话从 0 全量」（restore.rs:634-635）**实现不符** → 派生会话的全部历史 leaf-move/compression 事件（都在全局 max 之前）被跳过。

后果：多会话场景下 `current_leaf_id`（会话树叶子）与压缩护栏（last_compaction_*）恢复错误；事件本身仍在 DB（非物理丢失），但被跳过的 leaf-move 在**下一次快照后依旧不被重放**（新快照 global max 更大）——**永久粘性错误**，除非删除快照走全量重放。详见 §9 P1-1。

---

## 4. 崩溃时机矩阵（维度 3）

### 4.1 ① 消息追加中崩溃

- **append 前崩溃**：事件未提交（单条 INSERT 自动事务，conex-db/events.rs:20-24）；message-end 未落库 = 该消息全文未提交（消息体在事件流与 session_messages 是两条独立存储链，本域只保证 events 面）。
- **append 后崩溃**：事件在，run 状态 running → restore 打断为 failed。
- 恢复结果：未落库事件丢失（**设计内**：delta 可丢、message-end 未提交即丢弃）；run 不卡死；`cursor` 回填最后已落库序列（restore.rs:586-588，T08.4）；序列续接无冲突（恢复测试 restore.rs:1364-1428，Q24）。

### 4.2 ② run 进行中崩溃（provider 流中断）

- 落库到崩溃点的事件保留；provider 流**不续接**（无流式游标恢复，设计内——in-flight 一律打断）。
- `awaiting-approval` 同样被打断为 failed（审批决策随进程消失，设计内）。
- 恢复后新 run 从 `max(sequence)+1` 续接（seed_sequences，T08.8），无序列冲突。

### 4.3 ③ 快照保存中崩溃

`save_snapshot` 时序（restore.rs:441-465）：写 tmp → 轮转主→prev → tmp→主。三个崩溃窗口：

| 窗口              | 残留                  | 恢复行为                                                                |
| ----------------- | --------------------- | ----------------------------------------------------------------------- |
| tmp 写中途        | 主快照完好 + 半个 tmp | 加载主快照，**tmp 永不清理**（P2-6）                                    |
| 轮转后、rename 前 | 主缺失、prev=旧快照   | 回退 prev + 增量重放（restore.rs:427-433，不丢已提交事件——events 权威） |
| rename 后         | 主=新快照             | 正常                                                                    |

- 测试覆盖：`crash_consistency.rs:250-303`（半写快照回退 + 增量重放）、`restore.rs:1147-1212`（损坏回退 v1）。
- 结论：至多损失一个快照周期，事件流增量补足，**无数据丢失**。

### 4.4 ④ 迁移中崩溃

- 每版本迁移在**独立事务**内（migrate.rs:168-189），崩溃 → 事务回滚 → `user_version` 未更新 → 重启重试迁移；
- 版本事务 commit 前先「`wal_checkpoint(TRUNCATE)` + 整库备份 `.bak-v{n}`」（migrate.rs:145-167，11-T2 确定化时序），崩溃后备份文件保留迁移前完整旧库可回滚；
- 备份失败不阻断迁移（告警 + `migration_backup_failed` 键，migrate.rs:72-92，2026-08-06 裁定案）；
- 结论：**无数据丢失**；注意迁移失败会让 DB 进入 failure latch（migrate.rs:179-187）→ restore 的查询全失败 → 降级（P3 备注）。
- 测试：`upgrade_e2e.rs:424-473`（二次 open 幂等、备份含迁移前数据）、`migrations.rs:779-874`（黄金字节、WAL 数据入备份）。

### 4.5 ⑤ compaction 后崩溃

- `context-compression-end` 事件落库 → restore 重放重建护栏（last_compaction_at/sequence/generation，测试 restore.rs:1463-1521）；
- 事件落库**前**崩溃 → 护栏从零重建；`compression_retries`（重试计数）**没有任何事件载体，仅存在于快照 meta**，崩溃即丢（P2-9）；
- 压缩本身是引擎内存操作，已压缩内容不影响 events 表（历史事件保留）。

### 4.6 ⑥ 子 agent 运行时崩溃

- `runs` 表的子 run → restore 正常打断（interrupted）；
- **`session_agents` 行的子代理记录 restore 完全不处理**（restore.rs:551-605 只扫 runs 表）→ 崩溃时 status=running 的行**残留 running**；
- `FlowScheduler::load` 从行重建：running 行 → `FlowNodeState::Running`（flow_graph.rs:1373-1377），`is_ready` 要求 Pending（flow_graph.rs:1473-1476）→ `advance()` 不重派发、不打断 → **节点永久 Running，流程永不终态，需用户 kill_all 人工归一**（P1-3）；
- 测试只覆盖「kill_all 之后崩溃」路径（crash_consistency.rs:838-920，行已归一 failed）；「running 中崩溃」路径无测试覆盖。
- 预算重算正确（active 计入 in-flight，flow_graph.rs:1393-1399，防 double-charge）——但预算被残留 running 占住是另一面代价。

### 4.7 ⑦ restore 完成前退出 / restore 失败后退出

- `RunEvent::Exit` 钩子无条件调用 `save_snapshot_blocking`（main.rs:463-468），**不检查 restore 是否完成/成功**；
- 若退出发生在 run_restore 水合会话注册表**之前**（restore 进行中或失败后），`build_and_save_snapshot` 的 sessions 取自**空注册表**（core_run_commands.rs:1806）→ 保存出「0 会话 + 全部 runs + last_sequence=0」的**半水合快照并覆盖主快照**；
- 下次恢复：快照会话为空 → 全部会话走派生路径（branches 空、meta None）→ **会话树分支历史永久丢失**（事件流无法重建 branches，见 P2-4）。**P1-2**。

### 4.8 ⑧ restore 自身执行中崩溃（进程死于恢复流程内）

- 部分 run 已打断（update_run_status + 审计事件已落库），其余仍 in-flight → 下次 restore 续打断，幂等（已终态不再打断）；
- 窗口 1：`update_run_status` 成功、`append_event` 前崩溃 → 该 run 已 failed 但**审计事件永久缺失**（下轮 restore 不再触发，restore.rs:551-564 只处理 in-flight）；
- 窗口 2：`append_event` 成功、`update_run_status` 前崩溃 → run 仍 in-flight，下轮 restore **重复打断并追加第二条审计事件**（双审计，restore.rs:589-599 两步非原子）；
- 结论：可恢复（不自愈卡死），审计面有小概率缺失/重复（P2-2）。

### 4.9 崩溃矩阵总结表

| #   | 崩溃时机             | 恢复后状态                               | 丢失                          | 重复             | 卡死               | 关键证据                                       |
| --- | -------------------- | ---------------------------------------- | ----------------------------- | ---------------- | ------------------ | ---------------------------------------------- |
| ①   | 消息追加中           | run→interrupted；未提交事件丢            | 未落库事件（设计内）          | 无               | 无                 | restore.rs:551-605；events.rs:193-200          |
| ②   | run 进行中（流中断） | run→interrupted；流不续接                | 未 message-end 正文（设计内） | 无               | 无                 | restore.rs:689-707                             |
| ③   | 快照保存中           | 主/回退 prev + 增量补足                  | 至多一个快照周期（可补）      | 无               | 无                 | restore.rs:441-465                             |
| ④   | 迁移中               | 事务回滚 → 重启重试；备份可回滚          | 无                            | 无               | 无（latch 时降级） | migrate.rs:145-189                             |
| ⑤   | compaction 后        | 护栏按事件重放重建                       | compression_retries（P2-9）   | 无               | 无                 | restore.rs:647-655                             |
| ⑥   | 子 agent 运行中      | runs 打断；session_agents 行残留 running | 无                            | 无               | **卡死（P1-3）**   | restore.rs 仅 runs 表；flow_graph.rs:1473-1476 |
| ⑦   | restore 完成前退出   | 半水合快照覆盖主快照 → 会话树分支永久丢  | **会话树（P1-2）**            | 无               | 无                 | main.rs:463-468；core_run_commands.rs:1806     |
| ⑧   | restore 自身执行中   | 续打断自愈；审计事件缺/双                | 审计事件（P2-2）              | 审计事件（P2-2） | 无                 | restore.rs:589-599                             |

---

## 5. 快照机制（维度 4）

- **双文件 + checksum**：主文件 + `.prev` 备份（restore.rs:399-418）；FNV-1a 64 校验和（除 checksum 字段外的规范化 JSON，restore.rs:354-375）；`valid()` 校验 type/schema 版本/generation≠0/checksum 全通过（restore.rs:331-339）；损坏回退 prev，prev 不可用 → 全量重放（restore.rs:470-481）。
- **保存频率（三触发 + 一退出）**：① restore 成功后立即（core_run_commands.rs:1738）；② run 终态（drive_run_loop 收口，core_run_commands.rs:2344/2564）；③ 60s 周期、仅活动 run 存在时（core_run_commands.rs:1833-1857）；④ `RunEvent::Exit` 钩子（main.rs:463-468）。
- **权威源**：**DB（runs/events/pending）是权威**，快照只是「会话树 + 护栏 + 锚点」加速器；`StateSnapshot.runs/pending_inputs` 字段**序列化但恢复从不读取**（restore.rs:666-679 全部来自 store）——死数据（P2-3）。
- **原子性**：tmp + rename；Windows rename 不覆盖，先删旧备份（restore.rs:457-463）。
- **generation 跨重启不单调**（P2-1）：run_restore 未把 `outcome.snapshot_generation` 写回 `self.snapshot_generation` → 重启后首个快照 generation=1，且主/备新旧序反转（新主 1、旧备 N，备比主新）。

---

## 6. in-flight run 恢复（维度 5）

- **中断标记**：`reason=daemon-restarted` + `run-interrupted` 审计事件（previousStatus 落库，restore.rs:573-599）；cancelling → cancelled（`CANCEL_INTERRUPTED_ERROR`），其余 → failed（`INTERRUPTED_ERROR`，restore.rs:566-570）。
- **pending 输入重放**：按会话从 DB 恢复，FIFO（created_at 升序 + id 决胜，restore.rs:660-664；测试 restore.rs:1030-1060、crash_consistency.rs:469-511）。
- **游标续接（AA-07 P04 核对）**：AA-07 P04（runs.cursor 死列）已由 PE-08 T08.4 修复——三处终态写点携带 cursor：① 打断路径 `cursor = 审计事件序列 - 1`（restore.rs:586-588，T08.8 口径）；② 正常终态 `cursor = run-terminal 序列`（events.rs:418-425）；③ 失败路径 cursor=失败序列（events.rs:372-378）。恢复后 `seed_sequences` 按库内 max+1 预热（core_run_commands.rs:1688-1712），新 run 首事件不重置为 1（测试 restore.rs:1364-1428 全事件连续 1..=9）。
- **边界**：restore 的 `next_sequence`（restore.rs:710-718）是「读 max+1」而非原子取号，且不推进 `session_sequence` 计数器——门禁保证 restore 期间无并发写，正确性不受影响；与计数器的值差只造成序列号空洞（美容问题，无冲突）。

---

## 7. 护栏状态恢复（维度 6）

- **快照路径**：`SessionContextMeta` 随会话记录序列化（restore.rs:296-300），恢复后从快照 meta 续接增量（测试 restore.rs:1525-1580：代数 1→2 不重复累计）；
- **全量重放路径**：从 `context-compression-end` 事件重建（last_compaction_at/sequence/generation 逐事件累计、retries 归零；测试 restore.rs:1463-1521）；
- **损坏容错**：时间戳不可解析/载荷非压缩事件 → 保持既有状态（restore.rs:206-216 + 测试 restore.rs:1584-1619）；
- **缺口**：`compression_retries` 无事件载体（P2-9）；快照缺失时旧快照（serde default → None）从零开始（session.rs:157-159 兼容语义）；**P1-1 的多会话锚点缺陷同样破坏护栏续接**（见 §9）。

---

## 8. 锁与并发（维度 7）

- **DB 层**：单 `Mutex<Connection>` 串行化（conex-db/events.rs:15-18）；restore 的所有读写经 `blocking_db_call` 走 spawn_blocking（persist.rs:559-568，AA-07 P05 已消除），不占 tokio worker；
- **写期间并发防护**：`run_task` 门禁 restore_ready（core_run_commands.rs:2674）；restore 期间引擎无活动 run，无事件写入竞争；
- **恢复失败降级**：restore Err → `restore_ready=true` + `base_sequence_for` 懒计算（core_run_commands.rs:1771-1775），`restore.state=failed` 可观测（core_run_commands.rs:1442-1467）；代价：本次 in-flight run 未被打断，残留下一次恢复处理（可接受，P3）；
- **快照保存并发**：退出钩子（独立线程 block_on）与 60s 周期任务可并发触发 `save_snapshot`，**共用同一 tmp 路径（含 pid，restore.rs:449）**——两线程写同一 tmp 的竞争窗口（P2-7）；rename 原子性兜底，无数据损坏风险，但存在保存失败/轮转时序异常窗口。

---

## 9. 新发现问题清单（维度 8）

### P1（恢复后状态不一致）

**P1-1 增量重放锚点错误：全局 last_sequence 作会话级 base + snapshot_session_ids 集合取错 → 多会话场景 leaf-move/压缩护栏事件被永久跳过**

- 证据：`core_run_commands.rs:1808-1815`（快照 last_sequence = 全会话 max）；`restore.rs:631-640`（每会话 base = 全局 max，且 `snapshot_session_ids` 取自组装后 sessions，含派生会话，与注释「派生会话从 0 全量」不符）；事件序列为会话内独立（`conex-db/events.rs:80`）。
- 场景：会话 A 序列领先（快照 max=100）、会话 B 序列=30；快照后 B 追加 leaf-move（seq 31-40）→ 崩溃 → restore 对 B 只查 `>100` → 全部跳过 → B 叶子指针与护栏错误，且**粘性**（后续快照 global max 更大，永远不补）。
- 修复建议：快照增加每会话锚点（如 `session_last_sequence: HashMap<String,u64>`，serde default 兼容旧快照）；`snapshot_session_ids` 改从快照自身会话集合取；补多会话增量恢复测试（两个会话序列差 ≥ 1 的场景）。

**P1-2 restore 完成/成功前退出钩子保存「半水合快照」覆盖主快照 → 会话树分支历史永久丢失**

- 证据：`main.rs:463-468`（Exit 钩子无条件快照）；`core_run_commands.rs:1806`（sessions 取自注册表）；注册表仅在 run_restore 成功路径 extend（`core_run_commands.rs:1730-1733`）；restore 失败时同样未水合（`core_run_commands.rs:1763-1776`）。
- 场景：restore 失败（或进行中）→ 用户退出 → 快照覆盖为「0 会话 + 全部 runs + last_sequence=0」→ 下次恢复全走派生路径（branches 空、meta None），事件流无法重建分支（见 P2-4）。
- 修复建议：快照保存前检查 `restore_ready && !restore_failed`（或快照内容非空会话校验）；restore 失败/未完成时禁止覆盖既有快照文件。

**P1-3 崩溃后 session_agents 残留 running 行不被归一 → FlowScheduler 重建后节点永久 Running，流程卡死**

- 证据：`restore.rs:551-605`（只处理 runs 表）；`flow_graph.rs:1473-1476`（is_ready 要求 Pending，Running 节点既不重派发也不打断）；`crash_consistency.rs:838-920` 仅覆盖「kill_all 后崩溃」路径，running 中崩溃无测试。
- 场景：子代理运行中进程崩溃 → 重启 → 子代理行 running 残留，编排节点 Running，流程永不终态，需用户手动 kill_all。
- 修复建议：restore 增补 session_agents 行归一（running 行 → failed + ended_at，与主 run 打断对称）；或引擎启动装配时对 running 行执行一次 kill_all 语义归一；补「running 中崩溃重启」测试。

### P2（边界瑕疵）

- **P2-1 快照 generation 跨重启重置**：run_restore 未把 `outcome.snapshot_generation` 写入 `self.snapshot_generation`（core_run_commands.rs:1720-1762），与 restore.rs:104-106 文档意图（T08.6「generation+1 续接」）不符 → 重启后代数回 1，且主/备快照新旧序反转（新主旧、旧备新）。
- **P2-2 打断路径两步非原子**：`update_run_status` 与 `append_event` 之间崩溃 → 审计事件永久缺失或重复（restore.rs:589-599）；建议包事务或先写事件后改状态。
- **P2-3 快照 runs/pending_inputs 字段为死数据**：恢复从不读取（restore.rs:666-679 全来自 DB），序列化/IO 浪费且误导读者；建议快照只留会话 + 锚点。
- **P2-4 FullReplay 无法重建分支历史**：branches 只存在于快照（restore.rs:614-621 派生会话恒空）；事件流没有节点 append 持久化事件，全量重放只能恢复叶子指针与护栏 → 无快照时会话树结构降级。
- **P2-5 退出钩子保存不保证完成**：`std::thread::spawn` 后进程即开始退出（main.rs:463-468），线程可能被进程终止打断；尽力而为，靠 60s 周期与终态保存兜底。
- **P2-6 tmp 文件残留**：崩溃于 rename 前，`{path}.{pid}.tmp` 永不清理（restore.rs:449-456）。
- **P2-7 并发快照保存共用 tmp 路径**：退出钩子线程与周期任务共用 `{pid}.tmp`（restore.rs:449）；rename 原子兜底无损坏，但存在写竞争/轮转异常窗口。
- **P2-8 query_events 无 limit**：LocalDbStore 传 `None` → i64::MAX（persist.rs:688），大会话全量重放内存压力（性能面）。
- **P2-9 compression_retries 崩溃即丢**：无事件载体（session.rs:206-216 只在压缩事件时置 0；快照外无持久化），retries=1 的重试护栏跨重启丢失。
- **P2-10 重放损坏载荷静默跳过**：`let _ =`（restore.rs:646, 651）无日志，排查困难。
- **P2-11 快照复活已删除会话**：快照会话无过滤直接入 outcome（restore.rs:608-623），DB 已删会话（孤儿清理后）可能被快照重现。

### P3（备注）

- 迁移失败 latch → restore 全查询失败 → 降级启动（不阻塞，但本次不可恢复）；
- 同进程二次 restore 无防护（compression fold 非幂等），生产仅单次调用；
- restore 失败后残留 in-flight run 延后到下次重启才打断（`restore.state=failed` 可观测）。

---

## 10. 最严重 5 个问题

| 排名 | 编号 | 级别 | 问题                                              | 一句话影响                                                                |
| ---- | ---- | ---- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| 1    | P1-1 | P1   | 增量重放锚点：全局 max 作会话 base + 会话集合取错 | 多会话场景 leaf-move/压缩护栏事件被永久跳过，叶子指针与护栏错误且粘性不愈 |
| 2    | P1-2 | P1   | 退出钩子保存半水合快照覆盖主快照                  | 会话树分支历史永久丢失（事件流不可重建）                                  |
| 3    | P1-3 | P1   | session_agents running 行不被 restore 归一        | 崩溃后子代理编排卡死（节点永久 Running），需人工 kill_all                 |
| 4    | P2-1 | P2   | 快照 generation 跨重启重置                        | 代数回 1、主/备新旧序反转（恢复正确性不受影响，序不变量破坏）             |
| 5    | P2-2 | P2   | 打断路径两步非原子（状态 + 审计事件）             | 审计事件小概率永久缺失或重复，可追溯性受损                                |

---

## 附：核心证据行号索引

- 恢复主流程：`restore.rs:531-680`；打断判定 `restore.rs:689-707`；审计事件 `restore.rs:573-604`
- 增量重放：`restore.rs:625-658`；锚点计算 `restore.rs:631-640`
- 快照校验/回退：`restore.rs:331-339, 420-482`；保存时序 `restore.rs:441-465`
- 壳层接线：`main.rs:350-384, 443-469`；`core_run_commands.rs:1720-1864`
- 门禁：`core_run_commands.rs:2674-2676`；懒计算兜底 `core_run_commands.rs:1662-1684`
- 序列续接：`persist.rs:226-234`；`conex-db/events.rs:72-121`
- 崩溃测试：`crash_consistency.rs:122-592`（8 用例）；快照测试 `restore.rs:1064-1256`
