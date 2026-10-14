# run 生命周期与会话树

> 日期：2026-10-13
> 范围：`crates/orchestrator/src/run.rs`、`events.rs`、`persist.rs`、`blocks.rs`、`normalize.rs`、`session.rs`（`lib.rs` 只作地图）
> 性质：只读审查。问题同权。以当前代码为准。

## 能力结论

用户消息进入 orchestrator 之后，run 能走通「登记 queued → running → 事件入队 → 一条 run-terminal → 终态落库」这条主路径。这条主路径被测试锁住了，不是下面的问题。

对不齐的是终态的第二套账、取消的三条路径、序号在失败和冻结时的去向、叶子指针和事件写路径、以及 Store 的两套实现。会话树能在内存里分叉和移动叶子，但 run 不按叶子写，叶子移动事件也没有生产写点。pending 的「FIFO」按写入时刻排序，不按入队顺序。

## 问题清单

### BC06-1 同一 run 有两套终态，写失败后对不齐

- 现象
  - 状态机把 `completed` / `failed` / `cancelled` 当成终态，拒绝再转移。句柄上另外有 `terminal_sent`、`status` 字段、runs 行、事件流里的 `run-terminal`。这四套可以各说各的。
  - `AgentEndReason::Stopped` 在权威映射里是 `completed`，用户取消后再收口却变成 `cancelled` / `aborted`。逆映射把这两种结果都抹回 `Stop` 或 `Error`。
- 证据（path:line）
  - 状态机终态只认三态：`crates/orchestrator/src/run.rs:130-134`。`transition` 先改机器再写库，库失败时 `status` 不跟进：`run.rs:357-365`。下一步 `is_terminal()` 看的是机器，直接 `TerminalImmutable`：`run.rs:354-356`。
  - `drive_outcome` 在 `finalize` 之前就 `mark_terminal_emitted`：`crates/orchestrator/src/events.rs:574-585`。`finalize` 自己也先把 `terminal_sent` 置上，再写带 `end_reason` 和 cursor 的那一次：`run.rs:474-488`。中间转移写库时 cursor 和 end_reason 都是 `None`：`run.rs:361-363`。
  - 已终态分支不走状态机，把 `completed` / `cancelled` 改写成 `failed`，只改 `status` 和库，不改机器：`run.rs:521-535`。
  - 终态事件没写上时 `drive_outcome` 仍返回 `Ok`：`events.rs:525-544`、`events.rs:605-628`。调用方要自己看 `persisted == false`。
  - `map_agent_end_to_terminal`：`Stopped` → `Completed`（`run.rs:640-646`）。`map_outcome_to_terminal` 只要 `cancel_requested` 就改成 `Cancelled` / `"aborted"`（`run.rs:664-666`）。`normalize` 的 `terminal_status_for_end_reason` 只委托前一个函数（`normalize.rs:169-170`）。逆映射 `end_reason_for_terminal` 把 `Completed` 映回 `Stop`、`Failed` 映回 `Error`（`normalize.rs:175-180`），`Stopped` 和 `MaxTurns` 都回不来。
- 机制
  - 成功收口的顺序是：先把 `run-terminal` 写入事件流并打上「终态已发」，再走状态机，最后才把 end_reason 和 cursor 写进 runs 行。中间任一次库写失败，机器、`status`、runs 行、事件流不再是同一终态，而 `terminal_sent` 已经挡住下一次 `drive_outcome`（`events.rs:452-454`），这条 run 不能再收口。
  - 持久化失败路径先 `fail_event_store` 把 runs 行打成 `failed`，再尽力写终态事件。尽力写失败时事件流里没有 `run-terminal`，函数却当成功返回。重启后看行是失败，看事件流没有终态。
  - L2 取消一定会先置 `cancel_requested`（`run.rs:407-412`）。协作停止在安全点给出的 `Stopped`，权威映射是 `completed`，收口却改成 `cancelled` / `aborted`。`allows_auto_continue` 只放行原始 `Stop`，`Stopped` 本身不续轮（`normalize.rs:205-207`），它不读这次覆盖。会和取消覆盖对着干的是原始 reason 仍为 `Stop`、取消标志已经置上的那一次：终态文案是 `aborted`，若调用方把原始 `Stop` 送进续轮函数，函数仍返回 true。壳层另有 `user_stopped` 短路，是否真的续上归 14，这里只记两个函数不看同一面。
- 影响
  - 进程停在半截收口时，活句柄拒绝再驱动，库里的 run 可能仍是 `running` / `completing`，或是没有 end_reason、cursor 仍停在终态事件之前的终态行。事件流里却已经有 `run-terminal`。
  - 反过来，终态事件没落库时，行已经是 `failed(event-store-write-failed)`。回放等不到终态事件，在线广播若照样把未落库事件发出去，在线和回放不是同一条 run。
  - `end_reason_for_terminal` 的注释写明供事件重放使用，当前生产调用点只有测试。一旦拿它做重放：`Completed` 一律变回 `Stop`（`Stopped` 的「不续轮」丢了，`allows_auto_continue` 会对这个 `Stop` 返回 true）；`Failed` 一律变回 `Error`（`MaxTurns` 和普通错误分不开，但 `Error` 本身不续轮，不会因此重新放行）。取消覆盖之后的 `Cancelled` 会映回 `Aborted`，协作者给出的 `Stopped` 同样回不来。

### BC06-2 取消三路径的结果对不齐

- 现象
  - 协作、强停、回落在「引擎配合且随后成功 drive」时都会收成 `cancelled` / `aborted`。这条是测试锁住的。对不齐的是：升级强停不会真正强停，无引擎的回落只改了一个标签，取消原因和路径不进库，`Unknown` 会被计划成可取消但状态机拒收。
- 证据（path:line）
  - 协作成功：只 `request_cooperative_stop`，转入 `cancelling`，不 `abort`：`run.rs:401-413`。
  - 强停和回落都走 `cancel_force`：先 `CancelRequested`，再 `abort`，最后才写入 `cancel` 标志：`run.rs:428-442`。`cancelling` 上没有 `CancelRequested` 这条边，只有 `CancelConfirmed` / `RuntimeError` / `ForceInterrupt`：`run.rs:166-168`。
  - 引擎为 `None` 时协作请求仍标成 `CooperativeFallbackForce`，但 `abort` 包在 `if let Some(engine)` 里，不会执行：`run.rs:416-418`、`run.rs:437-439`。
  - 收口不读 `CancelRequest.reason`，也不读 `CancelPath`，已取消一律 `"aborted"`：`run.rs:660-666` 与 `events.rs:548-549`。
  - `Unknown` 不是终态：`run.rs:128-134`、`run.rs:180-184`。rewind 计划把「非终态」都放进取消列表：`session.rs:964-980`。
- 机制
  - 第一次取消只把 run 放进 `cancelling`，终态要等后来的 `drive_outcome`。协作停住之后用户再强停，第二次 `cancel_run(Force)` 在 `transition(CancelRequested)` 失败返回，`abort` 排在这次转移之后，不会执行。run 停在 `cancelling`。
  - 无引擎的「回落 L3」和真的回落共用一个路径枚举，但没有强停动作，也没有协作停止。run 同样停在 `cancelling`，除非别处再 drive。
  - `cancel` 标志写在 `abort` 调用之后。当前壳层的 `abort` 只置信号、不在调用栈里同步 drive，所以这条还没在现引擎上拆开。标志和强停动作的顺序仍然是反的：同步收口的引擎会在标志落地前把 `Error` 收成 `failed`，而协作路径因为先置标志会收成 `cancelled`。
  - 计划阶段把 `Unknown` 当成还活着。执行取消时状态机拒绝一切事件，`execute_rewind` 遇错即停（`session.rs:1137-1142`），叶子移动不会发生。
- 影响
  - 协作取消之后无法升级成强停。三条路径在库里要么都是 `cancelling`（没有后续 drive），要么都是 `cancelled` / `aborted`。用户给出的原因、究竟走了哪一条，重启后都看不到。
  - 读到未知状态字面量的 run 会卡住整次 rewind，叶子停在原处。

### BC06-3 序号会重复；失败和冻结会留空洞或撞号

- 现象
  - 落库成功的持久化事件，会话内序号连续，这是对的。`message-delta` 不占号，但返回值和广播信封仍带着「上一条已取号」的同一个序号。冻结拒绝和终态尽力写会把没取到的号写成已分配，或把已取到的号留空。
- 证据（path:line）
  - 不落库事件直接返回 `last_reserved`，不调用 `reserve`：`events.rs:240-245`。队列新建时 `last_reserved = base - 1`，首批 delta 的序号是 0：`events.rs:144-148`。测试把 `[1, 1, 1, 1, 2]` 锁成预期：`events.rs:800-803`。`DriveOutcome` 的注释仍写「sequence 连续」：`events.rs:399`。
  - 冻结拒绝发生在取号之前，错误里的序号是 `last_reserved + 1`：`events.rs:247-260`。同文件写明调用方应按 `is_retraction_freeze` 处理且不要把 run 打成 failed：`events.rs:93-97`、`events.rs:250-252`。`drive_outcome` 不看这个判定，一律 `fail_event_store`，并且只要 kind 不是 `reserve_sequence` 就 `push_at_best_effort` 用这个号写终态：`events.rs:494-534`。`push_at_best_effort` 不取号、也不走冻结护栏：`events.rs:356-378`。
  - 取号成功、追加失败时，`push_terminal_best_effort` 不重试追加，号已经消耗，`persisted` 仍是 false：`events.rs:314-351`。追加失败的重试只有 `push_at_best_effort` 一次；再失败则该号永远空着。
  - 生产队列挂了冻结表：`apps/agent-workbench/src-tauri/src/run/run_launch.rs:640`。正常 outcome 里有 `agent-start` / `message-end` 这类非撤离事件，冻结期间一碰到就走进上面的失败分支。
- 机制
  - 计数器只给持久化事件取号，是为了不让 delta 把序号撑出空洞。代价是对外序号不再唯一。信封层把 sequence 定义成重放去重的依据（`crates/conex-types/src/events.rs:1448-1451`），delta 和它前面那条持久化事件序号相同。
  - 冻结路径的注释和实现相反：护栏没消耗槽位，收口却把「镜像 + 1」当成已分配槽去追加。这个号若已被别的 run 取走，追加撞 `UNIQUE(session_id, sequence)`；若落进空洞，终态会写到冻结边界之内。内存实现下一次 `reserve` 会用已落库最大号自愈（`persist.rs:550-563`），SQLite 的热路径只做 `+ 1`（`crates/conex-db/src/events.rs:325-331`），不会回头看最大号，下一号和这条终态相撞。
  - 全量写失败的内存测试把「追加失败闩」同时扣在取号上（`persist.rs:546-548`），走的是「取号失败、不落库」分支。生产库的取号和追加是分开的，这个测试覆盖不到「号已取出、终态没写上」的空洞。
- 影响
  - 按序号去重的消费方会把 delta 当成上一条事件的重复帧丢掉，或把序号 0 当成「还没有序号」。
  - 撤回进行中的 run 会被打成 `failed(event-store-write-failed)`，并可能占掉 `frozen_seq + 1`（本应留给 `timeline-truncate` 的槽），或在生产库上造成下一次取号永久冲突。之后这条会话的事件流要么断号，要么写不进去。

### BC06-4 pending 输入的恢复顺序不是入队顺序

- 现象
  - `load_pending_inputs` 按 `created_at` 升序、再按 `id` 字符串升序。`created_at` 是本次写入的当前时间，同一 id 再写会刷新这个时间。同一毫秒内的两条靠 id 的字典序决胜，不靠入队先后。
- 证据（path:line）
  - trait 写明 FIFO 是创建时间加 id 决胜：`persist.rs:248-249`。
  - 内存实现每次 `save` 都 `created_at: now_ms()`，按 id 删旧再追加：`persist.rs:747-755`。加载排序：`persist.rs:770-771`。
  - SQLite 实现同样在冲突更新里把 `created_at` 写成本次的 `now_millis()`：`crates/conex-db/src/runs.rs:349-356`。加载是 `ORDER BY created_at ASC, id ASC`：`runs.rs:374-376`。
  - 入队侧是异步写，完成顺序不必是入队顺序：`crates/session-loop/src/loop/loop_runner.rs:343-365`。载荷里的消息 `created_at` 不参与排序。
- 机制
  - 两条消息在同一毫秒落库时，`"m-10"` 会排在 `"m-2"` 前面。后入队但先写完的那条，`created_at` 更小，恢复时更早被消费。同一条消息因重试再 `save` 一次，会从队头挪到队尾，排到比它更晚入队的消息后面。
  - 两套 Store 在这一点上行为相同，不是内存和 SQLite 的分叉。分叉见 BC06-6。
- 影响
  - 崩溃后恢复出来的用户输入、steering 文本会换序。后一条先执行，或重试的那条被挤到更新消息之后。会话树和 run 都不再按用户当时的顺序往下走。

### BC06-5 分叉或 rewind 移动叶子后，run 仍往同一条会话事件流写

- 现象
  - 会话树的当前叶子能被 `append` / `fork` / `move_leaf` 改掉。run 句柄和事件队列没有叶子字段，事件只按 `session_id` + `sequence` 追加。叶子移动既不断开在途 run，也不改它的写入目标。`session-leaf-moved` 没有生产写入。
- 证据（path:line）
  - `RunHandle` 只有 `run_id` 和 `session_id`：`run.rs:269-273`。`append_event` 的参数同样没有叶子：`persist.rs:185-192`。
  - `fork` 把当前叶子推进到新节点：`session.rs:399-412`，实际赋值在 `session.rs:719-725`。`move_leaf` 只改指针：`session.rs:420-441`。两者都不碰 run。
  - rewind 的步骤顺序是先取消再移动叶子，但 `execute_rewind` 把 `from_leaf_id` 丢掉，执行器接口也没有「期望当前叶子」：`session.rs:1121-1125`、`session.rs:1151-1159`。取消本身只进入 `cancelling`（BC06-2），计划不会等 run 终态。
  - 叶子移动事件的类型是独立字符串，不是 `AgentEvent` 变体：`session.rs:31`。载荷只能表达非空 `toLeafId`：`session.rs:233-235`。应用到记录上时不做存在性检查，并且不能把叶子清回根：`session.rs:176-190`。全仓没有生产代码调用 `session_leaf_moved_payload` 或 `append_event(..., "session-leaf-moved", ...)`。
  - 树和记录互转丢掉压缩护栏：`to_session_record` 固定 `context_meta: None`（`session.rs:635-643`），`from_session_record` 不读记录上的 `context_meta`（`session.rs:647-648`）。`apply_leaf_move_event` 可以指向不在 `branches` 里的叶子，随后 `from_session_record` → `restore_leaf` 会因找不到该叶子失败（`session.rs:485-488`）。
- 机制
  - 事件流是会话级的一条序号，不是按叶子分叉的日志。叶子指针挪到祖先或新分叉之后，未结束的 run 继续 `drive_outcome` / `append_event`，新事件落在这条共享流里。新叶子再按会话回放，会读到本应留在旧叶子上的续写。
  - 收口采集检查点时读的是「当时的 `current_leaf`」，不是 run 开始时的叶子。中途 `fork` 或 `move_leaf` 之后，检查点写到新叶子上。
  - rewind 执行器若自己再调 `move_leaf`，调用方没有把计划里的 `from_leaf_id` 传进去，`expected_current_leaf` 不会生效。并发的另一次分叉会被盖掉。
  - 回到根（`target_leaf_id = None`）在计划里合法，在持久化载荷里表达不了。即便将来有人写这条事件，重放也变不回「根前」。
  - 壳层在 `from_session_record` 失败时会改用空树（`apps/agent-workbench/src-tauri/src/run/run_snapshot.rs:201-210`）。叶子指向树外节点时，内存里的树变成空树，之后的 fork 和检查点都写在这棵空树上。
- 影响
  - 分叉、rewind、恢复 fork 移动叶子之后，旧 run 的后续消息、工具事件和终态仍进原会话事件流。新叶子不是一条干净分支。
  - 重启恢复等 `session-leaf-moved` 重放叶子（恢复逻辑在 07），但本模块从不写出这种事件。叶子位置只存在于还没被 `to_session_record` 盖掉的那份记录里；一来回转换，压缩护栏也被清掉。

### BC06-6 Store 的内存实现和 conex-db 实现语义分叉

- 现象
  - 同一个 `Store` trait，测试用的 `InMemoryStore` 和生产用的 `LocalDbStore` 在「缺行、冲突插入、取号对齐、查询顺序、事件时间戳格式」上不是同一契约。表结构本身不在这里展开。
- 证据（path:line）
  - `update_run_status`：内存找不到 run 就返回错误（`persist.rs:525-529`）。SQLite 是 `UPDATE ... WHERE run_id = ?`，不看改了几行，缺行也 `Ok`：`crates/conex-db/src/runs.rs:160-172`，经 `persist.rs:864-877` 原样返回。
  - `insert_run` 冲突：内存先删后插，`created_at` 换成现在（`persist.rs:495-510`）。SQLite 的冲突更新不改 `created_at`：`runs.rs:124-129`（同文件测试 `insert_run_upsert_preserves_created_at` 把「保留 created_at」锁成库的契约）。
  - `query_runs`：trait 要求按创建时间升序（`persist.rs:235-236`）。内存返回 `Vec` 的插入顺序，不排序（`persist.rs:729-734`）。库是 `ORDER BY created_at ASC`，没有第二排序键：`runs.rs:321-322`。同一毫秒插入的两条，库的顺序不稳定，内存是插入序。
  - 取号：内存每次 `reserve` 都先把计数器抬到「已落库最大序号」再 `+ 1`（`persist.rs:550-563`）。库只在计数器行不存在时用最大序号播种，之后只 `+ 1`：`crates/conex-db/src/events.rs:313-331`。`seed_sequence` 在库侧是 `MAX(next_sequence, 参数)`，不看事件表：`events.rs:267-288`。参数小于已有事件最大号时，内存的下一次 `reserve` 会抬上去，库不会。
  - 事件 `created_at`：内存写成 epoch 毫秒的十进制字符串（`persist.rs:623-630`）。库写成 `strftime('%Y-%m-%d %H:%M:%f','now')`（`events.rs:302-303`）。trait 只说「毫秒精度、只展示、不参与排序」（`persist.rs:143-145`），没固定格式。
- 机制
  - 内存实现用一把 `Mutex` 里的 `Vec` 模拟表，冲突语义是「整行替换」。库实现是 `ON CONFLICT DO UPDATE` 的列级更新，并且把「0 行更新」当成成功。取号的自愈只写在内存路径的每次 `reserve` 里，没有写进 trait，库的热路径也没有这一步。
  - `touch_session` 的默认空实现是 trait 写明的可选能力（`persist.rs:270-276`），`InMemoryStore` 不覆盖。这是测试替身的边界，不算漏实现。它带来的后果是：靠内存 Store 的测试看不出「会话 `updated_at` 没被刷新」。
- 影响
  - 对已消失的 `run_id` 做状态转移，测试失败，生产静默成功。调用方以为 runs 行已经是新状态。
  - 重复 `insert_run` 之后，测试里的创建时间和 `query_runs` 顺序跟生产不一致。恢复扫描（07）若依赖「按创建时间稳定升序」，两套实现给出的 run 顺序可以不同。
  - 直接 `append_event` 写出一个比计数器更大的序号，或 `seed` 种子偏低时，内存测试仍能继续取号，生产库会在下一个号上撞上已有行。BC06-3 的冻结终态就是这条分叉的一个触发面。
  - 把事件 `created_at` 解析成整数的代码，在内存测试里能过，对生产行会失败。

### BC06-7 压缩块没写上也被当成成功

- 现象
  - `context-compression-end` 落进事件流之后，块行写入失败只打日志，run 继续收口。没有 SQLite 连接时函数直接 `Ok`。块表缺失时底层插入也返回 `Ok`。前驱块在没有 `details.prevBlockId` 时取「当前块表里 generation 最大的那一行」。
- 证据（path:line）
  - 写入点在事件已经落库之后，错误被吞掉：`events.rs:475-490`。
  - 非压缩事件、没有 `result`、或 `as_local_db()` 为 `None`，都 `Ok` 返回：`blocks.rs:42-52`。
  - 代数兜底是事件表里 `context-compression-end` 的行数，前驱兜底是 `list_blocks(limit 1)` 的第一行：`blocks.rs:123-144`。`list_blocks` 按 `generation DESC, sequence DESC`：`crates/conex-db/src/blocks.rs:273-293`。
  - 块表不存在时 `insert_block` 警告后返回 `Ok`：`crates/conex-db/src/blocks.rs:149-152`。本模块因此不会把「没写上」变成 `Err`。
  - 模块注释写明 restore 不重写块表，块只靠这次实时写入：`blocks.rs:19-21`。
- 机制
  - 块表被定义成事件流的索引。索引写失败不阻断 run，这个选择和「失败了还有回放能补上」并不配套：回放路径按注释不插块。缺表、内存 Store、真实写失败，三条最后都是「事件在、块不在」，调用方看到的都是成功或一条 warn。
  - 两次压缩若在对方插入之前都读到同一个链尾，两条新块的 `prev_block_id` 会指向同一行。没有 `details` 时没有别的前驱来源。
- 影响
  - 下一回合若按块表而不是按事件流取摘要，这次压缩等于没发生。摘要完成回调对缺行是空操作（`blocks.rs:69-70`），补写也不会出现。
  - 内存 Store 上的 drive 测试不会发现块没写上。生产缺表时同样静默。

## 已核对闭合或不是问题

- `message-delta` 不落库。`is_non_persistent` 只看 `event_policy`（`events.rs:42-44`），`MessageDelta` 是 `NoPersist`（`crates/conex-types/src/events.rs:1322-1326`）。思考增量没有单独的 `AgentEvent`，折进 `MessageDelta` 的 thought 块（`crates/session-loop/src/loop/handlers/streaming.rs:737-748`）。全文在 `message-end` 的 `AgentMessage` 上，`message-end` 走默认落库。不是「delta 被写进库」，也不是「思考只有 delta、终态丢了」。
- 成功路径上持久化事件的序号连续，跨 run 不重置，同会话并发取号不重复。这是 `reserve_sequence` 加上 `UNIQUE(session_id, sequence)` 的主路径，测试有覆盖。问题在 BC06-3 的失败和冻结分支，不在这条主路径。
- 成功收口时 `run-terminal` 只发一次，第二次 `drive_outcome` 返回 `TerminalImmutable`（`events.rs:1488-1528` 所锁的行为）。`agent-end` 会同时落库，但 `is_terminal_event` 只认 `run-terminal`（`normalize.rs:148-150`）。这是「结束原因」和「终态事件」两件事，不是两个终态事件别名。
- 协作取消在引擎返回 true 时不调用 `abort`；引擎返回 false 时会 `abort`；强停会 `abort`。三者在标志已经置上、并且后来 `drive_outcome` 成功时，都收成 `cancelled` / `aborted`。这是当前测试的预期。BC06-2 说的是升级、无引擎、原因丢失和 `Unknown`，不是这条已经对齐的主路径。
- `touch_session` 默认空实现是 trait 写明的可选能力，不是生产路径漏接线。`LocalDbStore` 有覆盖（`persist.rs:1040-1046`）。
- `goal-*` 落库时 `run_id` 列和信封都是 `None`（`events.rs:175-184`、`events.rs:199-203`）。这是写明的轮次域，不是 run 归属丢了。
- `RunStore` / `EventStore` 是空 trait，注释写明还没合并（`persist.rs:311-324`）。没有第二套被调用的方法，不算双轨实现。

## 覆盖与未覆盖

覆盖了 `run.rs`、`events.rs`、`persist.rs`、`blocks.rs`、`normalize.rs`、`session.rs` 的当前实现，以及它们为了对照契约所调用的 `conex-db` 函数（只看返回值和排序，不看表结构）。`lib.rs` 只用来确认模块边界。

未深挖 `recovery` / `restore` / `flow_graph` / `goal_state` / `subagent` / `lifecycle`。那些归 07。runs / events / pending 的表、索引和迁移归 13。壳层命令归 14。

交接一条：壳层 `drive_run_loop`（`apps/agent-workbench/src-tauri/src/run/run_idle.rs:1392-1451`）把 `drive_outcome` 的 `Ok` 当成收口成功，不看 `persist_failure` 和 `persisted`，未落库的 `run-terminal` 仍会广播，并把 run 移出活动表；`finalize_failed`（`run_launch.rs:30-47`）在 `fail_event_store` 之后还会再发一次终态。恢复重放、goal 是否按原始 `Stop` 续轮、撤回协议本身，不在本文件展开。

## 给主控的摘要

1. 终态有两套账：状态机、`terminal_sent`、runs 行、`run-terminal` 事件。库写失败后它们会拆开，而且 `drive_outcome` 往往已经拒绝再收口。
2. `Stopped` 在映射里是 `completed`，一旦走过取消就变成 `cancelled` / `aborted`。逆映射把 `Stopped` 和 `MaxTurns` 都丢了。
3. 取消不能从协作升级到强停：已经是 `cancelling` 时第二次 `CancelRequested` 失败，`abort` 不会执行。无引擎的「回落强停」只改标签。
4. 取消路径和用户原因不进 runs 行。三条路径最后要么都卡在 `cancelling`，要么都是 `aborted`。
5. `message-delta` 确认不落库，全文在 `message-end`。但 delta 对外序号等于上一条已取号，和「序号唯一」冲突。
6. 冻结拒绝没有取号，`drive_outcome` 却把它当成持久化失败，并用那个未分配序号写终态。生产取号不会像内存实现那样按最大序号自愈，下一号会撞车。
7. pending 的 FIFO 按写入时刻和 id 字典序，不按入队顺序；同一 id 再写会把旧消息挪到队尾。
8. 会话树移动叶子不改 run 的写入目标，事件仍按会话追加。`session-leaf-moved` 没有生产写点，回到根也写不出来。
9. 树和 `SessionRecord` 互转会丢掉 `context_meta`。叶子指向树外节点时，记录还原失败。
10. 内存 Store 和生产库在缺行更新、冲突插入的 `created_at`、`query_runs` 顺序、取号是否自愈、事件时间格式上不是同一契约。压缩块写失败或库没有块表时，调用方看到的是成功。
