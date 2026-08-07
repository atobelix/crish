# R2 数据一致性复核报告（Round 1 审计独立验证）

- 复核日期：2026-08-07
- 复核人：数据一致性复核员（独立视角，不盲信原报告；只读验证，未改任何代码）
- 复核对象：F2 / F5 / F6 / F8 审计中的数据与并发类高严重度发现（共 8 项）
- 复核方式：逐项重新读取源代码与测试，推演崩溃/竞态窗口，核对测试断言语义；行号以本次读取为准
- 原始报告：`docs/organization/audit/F2-orchestrator-db-audit.md`、`F5-frontend-core-audit.md`、`F6-frontend-state-audit.md`、`F8-shared-generated-audit.md`

## 结论总览

| #   | 原报告编号    | 发现                                                              | 复核结论         | 严重度维持 | 关键修正/补充                                                                                                             |
| --- | ------------- | ----------------------------------------------------------------- | ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | F2-01/16      | 迁移崩溃重跑失败（user_version 事务外 + v3→v4 非幂等 ADD COLUMN） | **确认**         | P1         | 推演补齐：崩溃只可能在「commit 成功→PRAGMA 前」窗口致命；RENAME/CREATE/DROP 结构重跑恰好幂等，唯 line 350 ADD COLUMN 失败 |
| 2   | F2-28         | flow 重复 spawn（spawn 后持久化后置）                             | **确认**         | P1         | 补证据：load() 节点全量初始化为 Pending + is_ready 判定 + spawner 无 flow_node_id 去重                                    |
| 3   | F2-22         | 孤儿清理不查 in-flight                                            | **确认**         | P1         | 补充：`touch_session` 生产零调用（比原报告更弱——不存在独立 touch 链路）                                                   |
| 4   | F2-11         | 快照三触发无互斥                                                  | **确认**         | P1         | 补充：三触发同进程同 pid → tmp 文件同名，交叉写同一文件；generation 读-改-写非原子                                        |
| 5   | F5-02 / F6-F2 | 前端全量写无串行队列/批次戳                                       | **确认**         | P1         | 测试断言核实：`sessionRustDbWriteModel.test.ts:278-308` 确实显式断言「旧批次覆盖新批次」为契约                            |
| 6   | F6-F1         | 懒水合单页截断固化回写                                            | **确认**         | P1         | 补齐回写链：hydrate → store set → 350ms debounce → save_session_body 先删后插；`hasMore` 全仓无消费方                     |
| 7   | F8-01         | 生成 parser 递归无深度上限                                        | **确认（机制）** | P1         | 诚实边界：V8 `JSON.parse` 自身深度上限（约万级）限制了实际可触发性，但 8000+ 层嵌套已可令 parser 栈溢出，机制无上限是事实 |
| 8   | F8-04         | StreamingFileReader UTF-8 半字符跨块损坏                          | **确认**         | P1         | 表述修正：是「损坏」（U+FFFD 替换符）而非「截断」；每 64KB 边界命中                                                       |

**总体：原报告 8 项数据/并发类 P1 全部成立，无推翻项；无 P0 遗漏。** 以下逐项给出独立验证路径。

---

## 1. 迁移崩溃重跑失败（F2-01 / F2-16，P1）— 确认

### 原结论

`PRAGMA user_version` 在迁移事务外设置；v3→v4 的 `session_messages ADD COLUMN updated_at` 无幂等检查。commit 成功 → user_version 更新前崩溃 → 重跑必然 `duplicate column` 失败 → failure latch → 库不可打开。

### 独立验证

代码位置：`crates/conex-db/src/migrate.rs`。

1. **user_version 确在事务外**：migrate.rs:168-191——`tx.commit()`（:188）之后才执行 `PRAGMA user_version = {version}`（:190）。两者之间无任何屏障。
2. **v3→v4 确为唯一非幂等步骤**：
   - v1→v2：ADD COLUMN 前有 col-check（migrate.rs:221-231）；
   - v4→v5：`table_columns` col-check（:399-421）；
   - v5→v6：col-check（:437-459）；
   - **v3→v4：migrate.rs:300-350 整段 execute_batch，line 350 `ALTER TABLE session_messages ADD COLUMN updated_at INTEGER;` 无任何列存在性检查**。
3. **崩溃窗口推演**（三种情形）：
   - commit 前崩溃：SQLite DDL 事务性保证整段回滚 → 库保持 v3 形态 + user_version=3 → 重跑干净。安全。
   - **commit 成功、PRAGMA 前崩溃（或 PRAGMA 执行失败走 latch_error）**：库为 v4 结构、user_version=3 → 重跑 v3→v4：
     - :300-314 events 重建（RENAME→CREATE→INSERT SELECT→DROP）——重跑时 events_v3 不存在、events 可改名、新表可建、数据自拷贝，**恰好幂等**；
     - :318-348 runs / pending_inputs 同理幂等（`CREATE INDEX IF NOT EXISTS` 亦幂等）；
     - 执行到 **:350 ADD COLUMN updated_at → `duplicate column name`** → Err 传播 → migrate.rs:179-186 `set_failure` + 返回 Err → `LocalDb::open` 处 `db.migrate()?`（lib.rs:72）失败。每次重开重演，**库永久不可迁移**（除非手工修 user_version）。
   - 结论：不是「幂等 CREATE 安全」而是「ADD COLUMN 重复执行失败」——与原报告一致。
4. **补充**：原报告只提「commit 与 PRAGMA 之间崩溃」，实际上 PRAGMA 自身失败（磁盘错误等）也进入同一死态（:190-191 latch_error），窗口略大于原描述。

### 确认结论

成立，P1 维持。v3→v4 是迁移链唯一薄弱环；除 ADD COLUMN 外整段结构重跑恰好幂等，与 F2-01 分析吻合。

### 修复建议

1. 将 `PRAGMA user_version = N` 移入迁移事务内（SQLite 的 user_version 参与事务回滚，事务内设置与 commit 原子）；
2. 对 :350 的 ADD COLUMN 加 col-check（对齐 v4→v5 的 `table_columns` 模式，一行探针即可整体幂等化）；
3. 补 F2-36 测试：构造「user_version=3 + 已完成的 v4 结构」库，断言重跑自愈或明确失败。

---

## 2. flow 重复 spawn / 孤儿双跑（F2-28，P1）— 确认

### 原结论

`advance` 中 spawn 成功后仅整轮循环结束才持久化 flow_state；「spawn 成功 → 崩溃」重启后节点重建为 Pending，被再次 spawn，旧 run 孤儿双跑。

### 独立验证

代码位置：`crates/orchestrator/src/flow_graph.rs`。

1. **持久化后置确认**：advance 内 spawn 成功路径只更新内存（:1045-1050 runtime 条目、:1044 states），`persist_runtime()` / `persist_budget()` 在**整轮循环结束后**（:1127-1130）才执行；spawn 成功后还有 `emit_started().await` 挂起点（:1061-1078），窗口被 await 放大。
2. **重启重建为 Pending 确认**：`load()`（:1327-1425）先把**所有节点**初始化为 `Pending`（:1359-1363），仅对 flow_state 键内有 runtime 条目且能在 session_agents 找到 run 行的节点改写状态（:1369-1392）。崩溃点（spawn 已落库、flow_state 未持久化）→ 该节点无 runtime 条目 → 保持 Pending。
3. **重跑条件确认**：`is_ready`（:1473-1488）要求状态 `== Pending` 且依赖满足——Pending 节点即通过；预算重算（:1393-1399）只统计 Running/终态节点，Pending 不计入 → 预算放行。
4. **无二次防线**：spawner 侧对 `flow_node_id` 只回显不查重（`crates/agent-tools/src/tools/subagent.rs:1348-1349`）——同节点第二次 spawn 不会发现已存在的 running run。旧 run 终态到达时 `run_node()` 无映射 → UnknownRun，无人收口。
5. **可触发性**：窗口 = spawn 落库成功 → persist_runtime 完成，含 emit_started await 与多节点循环的其余 await；真实存在但窄。现有测试 `crash_consistency.rs:710` 只覆盖「预算已持久化」的良性崩溃，未覆盖本窗口（F2-37 盲区属实）。

### 确认结论

成立，P1 维持。机制与触发链完整，无推翻理由。

### 修复建议

1. 每次 spawn 成功后立即持久化该节点 runtime + budget（或 spawn 前先写「占位 + 预分配 run 映射」再落库启动）；
2. `load()` 增加反向校验：session_agents 存在 run、flow_state 无对应节点的 → 按 Failed 处理并 DataInconsistent 上报（现有 :1378-1391 只处理反方向：有映射无行）；
3. 补 F2-37 测试：真实 SQLite + DbSpawner 模拟 spawn 后立即 drop 调度器，重启断言不重复 spawn。

---

## 3. 孤儿清理不查 in-flight（F2-22，P1）— 确认（且比原报告更弱）

### 原结论

`cleanup_orphan_sessions` 只按 updated_at 宽限期判定，不检查 in-flight run；运行中会话超宽限期即被级联删除 runs/events/pending_inputs。

### 独立验证

代码位置：`crates/conex-db/src/sessions.rs` + `schema.rs`。

1. **删除条件确认**：sessions.rs:219-223——`DELETE FROM sessions WHERE id NOT IN (...) AND updated_at < grace_cutoff`。**无任何 run 状态 JOIN、无 pending 检查、无 events 检查**。宽限期默认 `ORPHAN_GRACE_MS = 300_000`（lib.rs:53），可被 session_meta 覆盖且无上下限钳制（F2-23 成立）。
2. **级联确认**：schema.rs:148（runs）、:168（events）、:179（pending_inputs）均 `ON DELETE CASCADE` → 删会话 = 清空全部子表，运行中 run 连同事件全灭。
3. **补充关键证据（比原报告更弱）**：`touch_session`（sessions.rs:244-257）**生产环境零调用**（grep 全仓仅 `crates/conex-db/src/tests.rs:415` 测试使用）。生产上 updated_at 只随前端 350ms persist 顺带刷新（upsert_session_entry，sessions.rs:43-66 带 entry.updated_at）——**不存在独立的运行期 touch 链路**，「touch 缺失」不是偶发延迟而是结构性缺位。
4. **触发路径**：cleanup 由前端每次 persist 调用（`sessionRustDb.ts:954`），active_ids = 前端 store 会话集合（:928-932）。风险面：
   - 引擎侧会话（不在前端列表）超 5 分钟即删；
   - **多窗口**：窗口 A 的清理会删掉窗口 B 的「安静会话」（updated_at 旧于 5 分钟且不在 A 列表）——各 webview 独立 JS 上下文、共享同一 SQLite；
   - F2-35 时钟回拨时 updated_at=0 立即命中。
5. 壳层 `confirm_empty` 守卫（session_commands.rs:94-95、:300）只拦「空列表全清」，不拦本风险。

### 确认结论

成立，P1 维持。in-flight 无保护是结构性的（无 status 检查），且 touch 链路缺位使窗口更宽。

### 修复建议

1. DELETE 条件增加「无中间态 run」子查询（`NOT EXISTS (SELECT 1 FROM runs WHERE session_id = sessions.id AND status IN ('running','cancelling','completing'))`）与「无未消费 pending」检查；
2. 运行期接线 touch：run 启动/事件写入/前端活跃会话心跳时刷新 updated_at；
3. 补 F2-40 测试：构造 in-flight run 会话，超宽限期后断言不删除。

---

## 4. 快照三触发无互斥（F2-11，P1）— 确认

### 原结论

`save_snapshot_now` 无互斥；终态/周期/退出三触发可并发；tmp 文件名固定（`{path}.{pid}.tmp`），并发写同一文件可致快照损坏（.prev 兜底降级）。

### 独立验证

代码位置：`apps/agent-workbench/src-tauri/src/core_run_commands.rs` + `crates/orchestrator/src/restore.rs`。

1. **无互斥确认**：`save_snapshot_now`（core_run_commands.rs:1782-1800）→ `build_and_save_snapshot`（:1804-1829）——全程无 AsyncMutex/任何锁；且 generation 读-改-写非原子（:1823 `load + 1` 后 :1824 build、:1825-1827 save，其间无锁）。
2. **三触发点确认**：终态 :2344 与 :2564（事件 handler 路径）、周期 loop :1853（tokio interval 任务）、退出钩子 :1863 → main.rs:462-467（**独立 std::thread** 调 `save_snapshot_blocking`）。三路在同一进程可并发。
3. **tmp 同名确认**：restore.rs:449 `{path}.{pid}.tmp`——同进程三路 pid 相同 → **同一 tmp 文件**。并发交叉写同一 tmp → 内容混合；随后轮转序列交叉（:457-463）：A 的 `rename(main→backup)` 与 B 的 `remove_file(backup)` / `rename(tmp→main)` 相互干扰；Windows 上 `std::fs::rename` 目标存在即失败（:463 传播 Err，可观测）；最坏路径：损坏 tmp 被 rename 为主快照。
4. **兜底确认**：load 侧主快照校验失败 → 回退 `.prev`（restore.rs:421-435、:474-481）——存在兜底，故为 P1 而非 P0，与原报告一致。
5. **补充**：generation 两路同读 G、同写 G+1 → 值不回退但两次快照代数相同；若主快照损坏、.prev 恰好是另一路并发产物，恢复语义受影响（都有校验，损坏即弃）。

### 确认结论

成立，P1 维持。

### 修复建议

1. `save_snapshot_now` 加 `tokio::sync::Mutex`（或比较-交换）：build 与保存同一锁内完成，generation 读-改-写原子化；
2. tmp 文件名加随机后缀（如 generation）；
3. 补 F2-39 测试：并发两次 `save_snapshot_now`，断言文件完整且 generation 单调。

---

## 5. 前端写竞态（F5-02 / F6-F2，P1）— 确认，测试确固化「旧覆盖新」

### 原结论

sessionRustDb 全量写无串行队列/批次戳，旧批次晚完成覆盖新批次；且测试把回滚固化为契约。

### 独立验证

代码位置：`apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts` + `store/layout-helpers/store-persistence.ts` + `sessionRustDbWriteModel.test.ts`。

1. **写路径确认**：`persistAllSessionsRust`（sessionRustDb.ts:890-955）：probe（:918）→ bodyJobs 逐会话并发 invoke（:929-941）→ metaJobs（:944-951）→ cleanup（:954）。**批次间无队列、无版本戳、无 updated_at CAS**。调度侧 350ms debounce（store-persistence.ts:136-144）只保证「调度串行」，不保证「IPC 飞行期互斥」——store 高频变更时两个 persist 周期可并发飞行。
2. **Rust 侧无序保护**：`save_session_body` 为 DELETE + INSERT 全量替换（crates/conex-db/src/messages.rs:66-94），无更新序比对 → 旧批次晚到即整体覆盖新数据。
3. **测试断言核实（关键）**：`sessionRustDbWriteModel.test.ts:278-308`——构造 p1（旧 2 条）+ p2（新 4 条）并发，用 `saveDelayMs: 5, probeDelayMs: 40` 让旧批次晚完成，断言 `final = ['m1','m2']`（:307，旧内容），测试名自述「晚完成的批次覆盖先完成的批次（最后写者胜，无 CAS 哨兵）」。**原报告描述准确：测试确实把「旧覆盖新」固化为契约**，并非对测试的误读。
4. **触发面**：350ms 窗口内消息 upsert 引发的 persist 与上一周期 invoke 未返回并发；boot 回灌后显式 persist（store-persistence.ts:267-271）与 debounce 并发；多窗口独立 JS 上下文并发写同一 SQLite。

### 确认结论

成立，P1 维持。防回滚保证确实只依赖 debounce 调度的经验性串行，无契约级防线。

### 修复建议

1. 模块级写串行队列：新 persist 开始前 await 上一轮 promise，且排队中若已有更新批次则丢弃过期批次（每会话保留最新快照）；
2. 中期：批内带快照时间戳，Rust 侧 save_session_body 增加 updated_at CAS（旧戳拒绝）；
3. 改写测试：把「旧覆盖新」契约改为「最终 = 更新批次」+ 并发注入用例。

---

## 6. 懒水合单页截断固化回写（F6-F1，P1）— 确认

### 原结论

只拉一页 800 events，hasMore 无人消费，hydratedFromEngine=true 封死重试；截断态被 350ms persist 固化回写 SQLite。

### 独立验证

代码位置：`apps/crish-desktop/src/api/sessionEventHydrate.ts` + `store/sessionCrudActions.ts` + `store/layout-helpers/store-persistence.ts`。

1. **单页确认**：`hydrateSessionMessagesFromEngine`（sessionEventHydrate.ts:411-442）只调一次 `fetchSessionEvents(sessionId, 0, 800)`（:414），无分页循环；`hasMore` 仅在返回对象中透出（:439），**无任何续拉逻辑**。
2. **hasMore 无消费方确认**：全仓 grep——hasMore 仅出现在 sessionEventHydrate.ts 自身、类型定义与 `sessionActivateHydrate.test.ts:151`（测试夹具）；`sessionCrudActions.ts:198-219` 消费 hydrate 结果时**完全不读 res.hasMore**。
3. **封死重试确认**：hydrate 成功即 `s.hydratedFromEngine = true`（sessionCrudActions.ts:216）；`needsEngineMessageHydrate` 对 `hydratedFromEngine` 真值永久返回 false（sessionSharedHelpers.ts:54）→ 截断态无法重拉。
4. **固化回写链确认（完整链条）**：store set（sessionCrudActions.ts:200-219）→ subscription 触发（store-persistence.ts:128-144）→ 350ms debounce → `persistAllSessionsRust` → `saveSessionBody`（msgs.length>0 才写，sessionRustDb.ts:936-937）→ `save_session_body` DELETE+INSERT 全量替换（messages.rs:66-94）→ **SQLite 中长会话被 800 事件截断态覆盖**；重启后 hydrateSessionsFromRust 从 SQLite 读到的即截断正文 → 不可逆。
5. **规模判断**：800 事件 ≈ 400 条消息（每消息约 2 事件），长会话/多轮协作会话轻松超过 → 现实触发面。

### 确认结论

成立，P1 维持。截断 → 落库 → 重启读截断，三环闭环确认。

### 修复建议

1. 按 `nextAfterSequence` 分页循环直至 `hasMore=false`（消费方侧 `Math.max` 保护游标）；
2. 落库前熔断：`hydratedFromEngine && hasMore` 的会话跳过正文 persist（或持久化"未完整"标记）；
3. 补测试：>800 事件会话、hasMore=true 分支、engineCursor 续拉。

---

## 7. 生成 parser 递归栈溢出（F8-01，P1）— 确认（含可触发性边界）

### 原结论

checkJsonValue / parseArrayOf 递归无深度上限，深层载荷抛 RangeError 逃逸 ParseResult；消费侧 EventRouter.ts:111 无 try/catch。

### 独立验证

代码位置：`packages/shared-types/src/generated/engine/parser.ts` + `apps/crish-desktop/src/api/chat-bridge/`。

1. **递归无上限确认**：`checkJsonValue`（parser.ts:56-80）对数组/对象逐元素递归，无深度计数器、无 try/catch；`parseArrayOf`（:82-94）无上限；类型级递归如 `parseAgentMessage`（:262-287）→ `parseArrayOf(parseAgentMessageBlock)` → block 内 tool_call input/metadata 等 `checkJsonValue`（:270-273）——多层递归叠加。
2. **异常逃逸契约确认**：`parseBridgeEvent`（handlers/eventParser.ts:864-898）直接调用 `parseEngineEvent(raw)`（:874）无 try/catch 包裹；消费侧 `EventRouter.ts:111` 直调 parseBridgeEvent 无 try/catch；`dataPlaneRouter.ts:113` 同。深嵌套输入 → RangeError 而非 ParseResult → 破坏 fail-closed 契约。
3. **可触发性诚实边界**：V8 的 `JSON.parse` 自身有递归深度上限（约万级，取决于栈参数），IPC 反序列化层会先于 parser 拒绝超深嵌套——「<4MB 编码 10 万层嵌套」的说法在 JSON.parse 层即被拦截，**实际可达深度约为 JSON.parse 上限之内的层级**（万级以内）。但该深度（数千~上万层）对 parser 每层数帧的递归已足以栈溢出（RangeError 在 parser 内发生是现实的，因为 JSON.parse 的栈消耗按层也接近上限）。机制上「无深度上限」是事实，修复价值不因边界收窄而降低（parser 是可直接被单测/桥接产物驱动的纯函数面）。
4. 补充：F8-07（浮点/负数整数字段）与 F8-08（null 可选字段）不在本复核清单，不展开。

### 确认结论

成立，P1 维持（机制确认；「任意 <4MB 载荷」的普遍可触性需按运行时栈参数评估，建议按上限 256 防御）。

### 修复建议

1. 生成器 PARSER_PREAMBLE 中为 checkJsonValue / parseArrayOf 增加 depth 参数（如 256），超限返回 `parseErr("nesting too deep")`（一处改、全量生成）；
2. EventRouter.onMsg / dataPlaneRouter 外层 try/catch 兜底（异常转 registerUnknownEvent）；
3. 补 F8-41 对抗性单测：深层嵌套回归用例。

---

## 8. StreamingFileReader UTF-8 半字符损坏（F8-04，P1）— 确认

### 原结论

`chunk.toString("utf8")` 把跨块不完整 UTF-8 字节序列替换为 U+FFFD，中文在每 64KB 边界损坏。

### 独立验证

代码位置：`packages/shared-utils/src/file/streaming-file-reader.ts`。

1. **机制确认**：readLines 路径 :95 `const text = this.remainder + chunk.toString("utf8")`；async 迭代器路径 :122 同。`Buffer.toString("utf8")` 对不完整多字节序列产生 U+FFFD 替换符；`remainder` 只按 `\n` 切行保留（:98、:124），**不保留不完整 UTF-8 字节** → 跨块字符（如「中」= E4 B8 AD 被切成 E4 | B8 AD 两块）各自解码为两个 U+FFFD，内容损坏且无错误信号。
2. **命中面确认**：`highWaterMark` 默认 65536（:19、:35），大文件（session JSONL、diff 输出）只要有多字节字符恰好跨界即命中——中文文件每 64KB 边界概率性出现。
3. **表述修正**：原报告称「半字符截断」，实际是「半字符损坏」（U+FFFD 替换，字符错乱而非整段丢失）——性质更接近污染，严重度不变（行数据被污染且不可观测）。
4. 继承面：`streaming-jsonl-reader.ts` 若复用本读取器同样受影响（F8-04 已注明，本复核未深挖其实现，标注为转引）。

### 确认结论

成立，P1 维持。

### 修复建议

1. 改用 `node:string_decoder.StringDecoder`（`decoder.write(chunk)` 保留跨块字节，按 UTF-8 序列边界输出）；
2. 同步修复 `streaming-jsonl-reader.ts`（若共用本类则一次修复覆盖）；
3. 补含中文/emoji 的大文件跨界用例（构造字符恰好跨 64KB 边界）。

---

## 汇总与优先级

1. **本轮 8 项全部确认**，其中 3 项获得比原报告更强的证据或更宽的窗口（#3 touch 链路零接线、#1 PRAGMA 失败同死态、#5 测试契约核实）。
2. 修复顺序建议：**#1（库不可打开，最严重）→ #6（截断不可逆）→ #3（静默删数据）→ #5（消息回滚）→ #2（双跑）→ #4（快照）→ #8 → #7**。
3. 测试盲区核实：F2-36 / F2-37 / F2-40 / F2-39 / F5 改写契约 / F6 分页用例 / F8-41 对抗性单测均属实缺，建议随修复补入。
4. 复核范围声明：本次只覆盖清单内 8 项；F2 的 C7 生产接线（F2-08）、F2-03 终态错位等其余发现不在本复核清单，未做独立验证。
