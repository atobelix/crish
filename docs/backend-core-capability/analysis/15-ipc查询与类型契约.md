# IPC 查询与类型契约

> 日期：2026-10-13
> 范围：`core_query_commands`、`core_commands`、`session_commands`、`session_title_commands`、`command_manifest`，以及 `conex-types` 的事件 / 消息 / 错误 / 上下文契约与 `contracts/engine-events.json`。
> 不重审 `core_run` 启动与事件桥投递。

## 能力结论

查询命令、会话命令、命令清单这三层的**名字**是对齐的：`command_manifest` 里本范围的 `registered = true` 条目，都能在 `main.rs` 的 `command_registry!` 里找到同名实现，没有「清单写已注册但函数不存在」。事件**类型名**也对齐：`AgentEvent` 57 个 wire 名与 `engine-events.json` 的 `eventCount`、顺序一致。

对不齐的是返回值被谁当真。侧栏索引写在 localStorage，正文写在 SQLite，而且没有把索引写回 `sessions` 表的命令。`list_sessions` 在 Tauri 上是裸数组，在本机服务上是 `{ sessions }`，桌面引擎同步按后者读，结果恒为空。`core_get_status` 仍缺调用方在读的 `traceId` / `mcpStatus`，诊断条目的 `level` 也不是日志级别。`core_get_run_snapshot` 和撤回定位仍全表/全事件扫描，尽管库已经有按主键和按类型的读。`core_compact_messages` 用占位句压缩并返回成功；`core_compact_now` 成功只替换内存对话，不改 `load_session_body` 读到的正文。

## 问题清单

### BC15-1 会话列表与正文不在同一个库

- 现象：侧栏元数据的写入真相是 localStorage。正文和 agents 进 SQLite。`sessions` 表会被正文自愈插进空标题行，但标题、文件夹、置顶不会随持久化更新。刷新时只要 localStorage 里还有索引，就不会读 SQLite 的 `list_sessions`。
- 证据：`apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts:338-345` 索引只 `lsSaveSessionIndex`；同文件 `:152-154` 先读 localStorage，空了才 `listSessions()`。`apps/agent-workbench/src-tauri/src/session_commands.rs:10-11` 仍把 `upsert_session_entry` 写成第 12 个会话命令，但 `command_manifest.rs` 与 `main.rs` 的 `command_registry!` 都没有这条，源码里也没有对应的 `#[tauri::command]`。库函数在 `crates/conex-db/src/sessions.rs:38`。正文自愈插入空标题：`crates/conex-db/src/messages.rs:111-118`（`INSERT OR IGNORE ... title ''`），`session_commands.rs:108-115` 同样先 `insert_session(session_id, "")`。
- 机制：`save_session_body` 只保证 `sessions` 里有一行能挂外键，不写索引字段。`upsert_session_entry` 会 `ON CONFLICT` 更新标题等字段，但 IPC 没暴露。于是列表与正文分属两个库：列表在浏览器存储，正文在 SQLite。
- 影响：换机、清掉 localStorage、或只信 `list_sessions` 的调用方，看到的是空标题占位，对不上用户正在看的侧栏。引擎侧 `core_compact_now` 用 `list_sessions()` 判断「会话是否存在」（`apps/agent-workbench/src-tauri/src/run/run_launch.rs:1293-1297`），和侧栏是否有这个会话不是同一条记录。

### BC15-2 `list_sessions` 有三套形状，桌面引擎同步恒得到空列表

- 现象：同一个名字，Tauri 命令返回会话数组；本机服务包成 `{ sessions }`；桌面 `fetchEngineSessions` 只读 `res.sessions`，并且传入 `includeArchived: false`。Tauri 函数没有这个参数，也不过滤 `is_archived`。
- 证据：`apps/agent-workbench/src-tauri/src/session_commands.rs:118-127` 返回 `Vec<SessionIndexEntry>`，无归档参数。`apps/agent-workbench/src-tauri/src/run/run_commands.rs:433-439` 的直调体同样返回裸 `Vec`，且 `local_db()` 为 `None` 时 `Ok(Vec::new())`。服务端再包一层：`apps/agent-workbench/src-tauri/src/server/core_backend.rs:473-478`，类型在 `crates/conex-types/src/device/commands.rs:911`。消费面 `apps/crish-desktop/src/api/sessionEngineSync.ts:260-266` 把响应当对象，取 `res.sessions`，不是数组就返回 `[]`。
- 机制：Tauri 成功载荷是 JSON 数组。数组没有 `sessions` 字段，所以这条同步每次都走「空远程」分支，不会把 SQLite 里的会话并进侧栏。`includeArchived` 被命令签名丢掉，即使改成读数组，归档会话也会全部出来。无 `LocalDb` 时直调体用空列表冒充成功。
- 影响：引擎会话列表这条查询对桌面是死的。侧栏继续只信 BC15-1 的 localStorage。服务端客户端如果按 `{ sessions }` 写，和 Tauri 调用方又不是同一份契约。

### BC15-3 `get_flow_snapshot` 两套返回，声明键还不是会话的

- 现象：Tauri 命令返回 `{ nodes: [...] }`，按子代理行算出节点状态。同名直调体返回 `{ flowDeclaration, flowState, agents }`，`depth` 恒为 1。两边读的流程声明都是全局 `session_meta` 键，不带 `session_id`；agents 却按传入的会话过滤。
- 证据：IPC 形状 `apps/agent-workbench/src-tauri/src/session_commands.rs:306-311`，读取 `apps/agent-workbench/src-tauri/src/session_commands.rs:472-479`（`FLOW_DECLARATION_KEY` / `FLOW_STATE_KEY` / `FLOW_ON_FAILED_KEY`，然后 `load_session_agents(&session_id)`）。直调体 `apps/agent-workbench/src-tauri/src/run/run_commands.rs:446-482`（`depth: 1` 写死）。键本身是字面量 `flow_declaration`：`crates/orchestrator/src/flow_graph_scheduler.rs:258`。表是全局 KV：`crates/conex-db/src/schema.rs:262-265`（`key TEXT PRIMARY KEY`，无会话列）。
- 机制：流程调度和这条查询共用一把全局钥匙。会话 A 的声明会覆盖会话 B。查询会话 B 时，用 A 的声明去套 B 的 agent 行：对不上的 run 在 IPC 路径被当成 `failed`（`session_commands.rs:401-407`）。服务路径连这层拼装都不做，只把原文和另一套 agents 投影交出去。
- 影响：多会话时 DAG 查询不是该会话的流程。两个调用面（桌面命令 / 本机服务 C08）也不能互换解析。

### BC15-4 `core_get_status` 与 run 快照有字段缺口，有的恒缺，有的含义被换掉

- 现象：
  - 调用方要的 `traceId`、`mcpStatus` 结构体里没有。`traceId` 因此恒为缺省；`mcpStatus` 缺失被当成「未配置」。
  - `diagnostics[].level` 被填成子系统名，`ready` 被丢掉。缓冲是新的在前，契约写的是最旧在前，组装时没有反转。
  - `lastError.kind` 放的是错误码字符串，不是 `CoreError` 的 kind。
  - `compactionReady` 在进程起来后恒为 true，依据只是旧的内存压缩命令已经注册。
  - `core_get_run_snapshot.snapshot.error` 恒缺。`usage` 有库可读，`error` 没有。
- 证据：`CoreStatus` 字段到 `last_crash` 为止，无 `trace_id` / `mcp_status`：`apps/agent-workbench/src-tauri/src/core_query_commands.rs:160-207`。诊断映射：同文件 `:365-378`（`level: entry.subsystem`，`kind: payload.code`）。契约注释写「最旧在前」和 level 为 trace/debug/info/warn/error：同文件 `:9-10`、`:72-73`、`:182`。实际环形缓冲新条目在前：`apps/agent-workbench/src-tauri/src/status_diagnostics.rs:101`、`:122-131`，条目形状含 `ready`：同文件 `:27-36`。`with_trace_id` 仍是 `dead_code`，注释写明要挂到 `CoreStatus.traceId` 但未接：`apps/agent-workbench/src-tauri/src/engine_channels.rs:596-604`。消费面读 `res.traceId`：`apps/crish-desktop/src/api/engineStatus.ts:202-208`；读 `status.mcpStatus`，没有就 `{ configured: false }`：`apps/crish-desktop/src/api/mcpApi.ts:130-137`。`compaction.set_ready(true)` 无条件：`apps/agent-workbench/src-tauri/src/main.rs:837-839`。`run_error` 忽略 `run_id` 并返回 `None`：`apps/agent-workbench/src-tauri/src/run/run_core.rs:628-631`，快照仍调用它：`core_query_commands.rs:865`。
- 机制：状态是多次追加字段叠出来的，组装函数没有把后加的追踪、MCP、诊断原字段接进冻结形状，而是把子系统名塞进 `level`。压缩就绪标记把「旧 IPC 能跑」当成「压缩能力已接线」。快照的错误文案函数留了空实现，失败 run 只能靠 `endReason`，`error` 这个键不会出现。
- 影响：排障关联键永远没有。MCP 状态查询恒报未配置，分不清「真没配」和「字段没做」。诊断面板若按「最旧在前」再反转，顺序是反的，级别也不是日志级别。`compactionReady: true` 不能推出 `core_compact_now` 可用（后者在没有 Summarizer 时拒绝）。失败 run 的快照没有错误正文。

### BC15-5 按主键、按页、按类型的读已经有了，命令仍全量扫

- 现象：查一条 run 会把全部 run 载入内存再 `find`。未带 `sessionId` 的 run 事件分页，先做同样的全表扫描才去按 run 过滤。会话列表命令不用已有的 keyset 分页。撤回要定位一条 `message-start` 时，从 sequence 0 起不带 limit 读出该会话全部事件，再在内存里滤类型。
- 证据：`LocalDb::get_run`：`crates/conex-db/src/runs.rs:178`。快照仍 `query_runs()` 后查找：`apps/agent-workbench/src-tauri/src/core_query_commands.rs:840-845`。缺 session 的 run 事件同样：`apps/agent-workbench/src-tauri/src/run/run_commands.rs:360-371`。`list_sessions_page`：`crates/conex-db/src/sessions.rs:120-124`；命令只调无 limit 的 `list_sessions`：`session_commands.rs:123` 对 `sessions.rs:92`。`query_events_by_type` 带 SQL limit：`crates/conex-db/src/events.rs:210`。撤回：`apps/agent-workbench/src-tauri/src/retraction_commands.rs:165-170`（`query_events(session_id, 0, None)`），再滤 `message-start`（`:172-174`）。
- 机制：Store 门面只有 `query_runs` / `query_events`，命令没有走已经落在 `LocalDb` 上的单行和按类型查询。分页参数只加在「读事件页」上，没加在「为了找一行而先读所有行」上。
- 影响：run 越多、会话事件越长，一次快照、一次补页、一次撤回的定位成本都是全历史。这不是样式问题：撤回和快照在热路径上把 limit 推倒了。

### BC15-6 压缩命令返回成功，并不等于引擎压缩写进了正文

- 现象：`core_compact_messages` 仍注册着。它走旧的三字段 `Message` 面：超预算就丢掉较早消息，塞进一句英文占位，然后 `Ok`。未超预算时 `cacheHitRateOptimized` 为 true，这个字段不表示缓存被优化过。`core_compact_now` 会走真正的 `CompactionEngine`，但成功条件只是内存里的 `session_history` 被替换；事件入队失败、压缩块落库失败都只跳过，仍然 `Ok`。它不调用 `save_session_body`。
- 证据：命令 `apps/agent-workbench/src-tauri/src/core_commands.rs:245-260`。占位与返回值：`crates/conex-compaction/src/engine.rs:44-64`（未压缩却 `cache_hit_rate_optimized: true`）、`:123-152`（`summary_placeholder`）。占位文案：`crates/conex-compaction/src/plan.rs:164-165`。客户端把这次返回当作压缩结果：`apps/crish-desktop/src/api/rustCore.ts:64-82`；命令失败时客户端再造一份 `tokensConsumed: 0` 的成功形结果（同文件 `:80-82`）。手动压缩只 `session_history.store`：`apps/agent-workbench/src-tauri/src/run/run_launch.rs:1389-1395`。事件失败变 `None` 且不中断：同文件 `:1462`、`:1498-1511`。块表失败只 `warn`：`:1465-1479`。然后 `Ok(CompactNowResult)`：`:1490-1495`。正文读的是另一张表：`session_commands.rs:131-141`。
- 机制：两条压缩命令都不是「压缩计划提交到会话正文」。旧命令用占位句冒充摘要。新命令把结果放在进程内缓存和尽力而为的事件里；`load_session_body` 的真相仍是压缩前的 `session_messages`。重启后缓存空了，下一次从正文装回的是原文。
- 影响：调用方看到 token 下降和 `dropped > 0`，刷新或重启后对话还在。旧命令还会把占位句当成已压缩消息交回去。`compactionReady`（BC15-4）因此也不能当这条链路的就绪信号。

### BC15-7 `core_check_command` 的裁决字面量和客户端契约不是同一套

- 现象：命令把 `GatekeeperResult` 原样作为成功载荷。枚举是 `Allowed` / `Blocked` / `RequiresApproval`，并且 `rename_all = "camelCase"`。客户端类型是 `'Allowed' | 'NeedsConfirmation' | 'Blocked'`。中间态名字不同，大小写也不同。
- 证据：返回点 `apps/agent-workbench/src-tauri/src/core_commands.rs:272-284`。枚举 `crates/conex-sandbox/src/lib.rs:14-19`。客户端 `apps/crish-desktop/src/api/rustCore.ts:94-100`。同文件注释（`core_commands.rs:303-305`）写「对齐前端 `rustCore.ts` 的 GatekeeperResult」，实际对不齐。serde 的 camelCase 会把变体收成 `allowed`、`blocked`、`requiresApproval`（首字母小写；`RequiresApproval` 不会变成 `NeedsConfirmation`）。
- 机制：IPC 成功值是这个枚举的字符串，没有再映射成客户端那三个字面量。`CommandVerdict.requires_approval` 是另一套内部结构，注释写明不走 IPC（`core_commands.rs:301-308`）。
- 影响：按 `NeedsConfirmation` 或 `Allowed` 做全等判断的调用方，不会命中闸门的真实返回。需要审批和放行会被当成未知字符串。

### BC15-8 事件类型名对齐，可选字段没有进 `engine-events.json`

- 现象：`turn-end` 在枚举里有可选 `usage`（`TurnUsage` 六字段），注册表的 `turn-end.fields` 只有 `sessionId` / `turnIndex` / `timestamp` / `toolCallCount`。`tool-start` 有可选 `turnIndex`，注册表没有。`tool-end` 有可选 `attempt`、`deduplicated`、`executedInput`，注册表没有。全文件没有 `"name": "usage"`、`executedInput`、`deduplicated`。
- 证据：`TurnUsage` 与 `turn-end.usage`：`crates/conex-types/src/events.rs:350-368`、`:423-432`。`tool-start.turn_index`：同文件 `:472-473`。`tool-end` 三字段：`:485-490`。注册表：`crates/conex-types/contracts/engine-events.json:100-130`（turn-end）、`:229-258`（tool-start）、`:264-294`（tool-end）。漂移测试只对「必填字段样本」做往返，样本里这些 `Option` 是 `None`，序列化时被 `skip_serializing_if` 丢掉，所以不会报「注册表外字段」：`crates/conex-types/tests/registry_drift.rs:344-375`。
- 机制：注册表被说成字段事实源，生成脚本用它产 TS。后加的可选字段只改了枚举。护栏用缺省样本，看不见表里少了的键。描述文字还写「57 → 58」，机器字段 `eventCount` 仍是 57（`engine-events.json:4-5`）；条数本身与枚举一致，漂的是字段和这段说明。
- 影响：按注册表生成的类型不认识轮次 usage、工具轮次号、实际执行入参。这些值一旦出现在事件 JSON 里，生成面当未知字段丢掉或无法类型化。设备协议事件段与这 57 个名字锁定在同一张表上，字段缺口会一起传过去（见已核对）。

### BC15-9 无版本号的空正文保存，在库里已有消息时返回成功但不清空

- 现象：`save_session_body` 在 `batch_version` 缺省且 `messages` 为空时，如果该会话已有正文或已有 `message-start` / `message-end` 事件，函数 `return Ok(())`，不删行。命令层把这个 `Ok` 原样返回给调用方。
- 证据：守卫 `crates/conex-db/src/messages.rs:141-169`。命令 `apps/agent-workbench/src-tauri/src/session_commands.rs:146-161` 只在 `Err` 时失败。
- 机制：这是防未水合空壳误删的拦截，但拦截后的协议是成功，不是「拒绝清空」。有 CAS 版本号的空数组不走这个分支，缺省版本号的空数组会。
- 影响：把「保存空正文」当成清空的调用方（尤其首批 `batchVersion = null`）会以为 SQLite 已经空了，库里的消息还在。下一次 `load_session_body` 把旧正文读回来。

## 已核对闭合或不是问题

- `append_session_messages`：当前 `conex-db`、`session_commands.rs`、`command_manifest.rs` 都没有这个函数或条目。旧文档里的「已登记未接线」已经不成立，不记成现存问题。生产落正文的命令是 `save_session_body`。
- `Store::query_events` 的 SQL `LIMIT` 已在：`crates/conex-db/src/events.rs:99-112`。`core_read_session_events` 传入 `page_size + 1`：`core_query_commands.rs:759-765`。`core_read_run_events` 委托的 `read_run_events_impl` 对事件行同样下推 limit：`run/run_commands.rs:373-376`。这两条分页命令不再「读全量再内存切页」。全量读留在 BC15-5 的快照、缺 session 反查和撤回定位。
- 事件类型名没有整表漂移。`AgentEvent::ALL_TYPE_NAMES` 与 `engine-events.json` 都是 57，含 `timeline-truncate`，由 `registry_drift.rs:218-244` 锁定。`device-protocol.json` 的事件段与这 57 个名字同序（`registry_drift.rs:2452-2476`），本机引擎没有另用一套设备事件枚举。未把设备命令表整份再审一遍。
- 本范围命令清单与注册表同名：`core_check_command`、`core_search_files`、`core_rebuild_search_index`、`core_compact_messages`、`core_count_tokens`、`core_compute_diff`、`core_get_status`、`core_get_run_snapshot`、`core_read_session_events`、`core_read_run_events`、`core_session_retract`、`core_compact_now`、`core_generate_session_title`、会话九条（`list_sessions` 到 `get_flow_snapshot`）、`core_md_render` / `core_md_render_batch`、hash/base64/encoding/diff/jsonl 六条、`core_list_commands`。`command_manifest.rs` 当前没有 `registered: false` 条目。`commands.rs` 不注册这组命令，注册在 `main.rs` 的 `command_registry!`。
- `core_get_run_snapshot.usage` 会读 `runs` 表用量（`run/run_core.rs:641-663`），不是恒 `None`。恒空的是 `error`（BC15-4）。
- `engineReady` 的实现和心跳消费面都写明它只表示 provider 三件套齐全，不是崩溃探针：`core_query_commands.rs:347-351`，`run/run_core.rs:550-552`。崩溃走心跳失败和 `lastCrash`。不把这个已写明的语义再算成「假就绪」。`EngineStatus` 类型注释仍写「session-loop 就绪」，和实现不一致，已并进 BC15-4 的形状问题，不单列。
- `core_session_retract` 在回滚 IO 失败时返回 `Err`（`retraction_commands.rs:115-117`），不是回滚失败仍 `Ok`。`RollbackOutcome` 只有 `Restored` 和 `Skipped`（`crates/conex-fs/src/trash.rs:153-161`），响应里的 `failed` 计数没有第三态可加，恒 0 是枚举里没有失败变体，失败走 `Err`。不单列。
- `save_session_body` 的 CAS 冲突会变成 `Err`，detail 以 `cas_conflict` 开头（`session_commands.rs:79-80` 加上 `crates/conex-db/src/error.rs:45`）。不是静默 `Ok`。库层版本纪元是否还错，留给会话库审查。
- `context.rs` 的 `ContextBudget` / `SessionContextMeta` 没有被本范围查询命令投影。`core_generate_session_title` 在无 provider 或无正文时返回 `InvalidInput`，不返回空标题成功（`session_title_commands.rs:58-69`）。

## 覆盖与未覆盖

- 已读：`core_query_commands.rs` 的状态组装、事件分页、run 快照；`core_commands.rs` 的压缩与闸门；`session_commands.rs` 十条命令与 `get_flow_snapshot`；`session_title_commands.rs`；`command_manifest.rs` 与 `main.rs` 的 `command_registry!` 对照；`commands.rs`（确认它不注册 core/session）。`conex-types` 的 `events.rs`、`error.rs` 的 `CoreError`、`lib.rs` 的 `SessionMessage` / `SessionIndexEntry`、`context.rs`。`engine-events.json` 与 `registry_drift.rs` 的锁定方式。`device-protocol` 只核对了「事件段与引擎事件同名」这一条复用。
- 为判断「返回值被谁当真」，对照了契约消费类型：`engineStatus.ts`、`mcpApi.ts`、`engineConfigTypes.ts`、`rustCore.ts`、`sessionEngineSync.ts`、`sessionRustDbHydrate.ts`。没有审 UI 组件。
- 未覆盖：`core_run_*` 启动、事件桥投递、流式落库。57 个事件没有逐字段穷尽，只查了枚举注释标明后加、且注册表样本护栏看不见的可选字段。`message.rs` 的 `AgentMessage` 块结构没有逐字段对注册表（载荷往返测试覆盖必填面）。压缩引擎内部策略、会话库迁移，分别不在本份。

## 给主控的摘要

1. 清单和 `command_registry!` 的 core/session 名字对齐；`append_session_messages` 已从代码和清单消失，不是未接线命令。
2. 事件类型名 57 条与 `engine-events.json`、设备协议事件段一致；漂的是可选字段，不是整表枚举。
3. 会话索引在 localStorage，正文在 SQLite；`upsert_session_entry` 没有 IPC，自愈只会插入空标题行（BC15-1）。
4. Tauri `list_sessions` 是裸数组，服务端是 `{ sessions }`；桌面引擎同步读 `.sessions`，恒为空（BC15-2）。
5. `get_flow_snapshot` 桌面与服务两套形状，声明存在全局 `session_meta`，不按会话分（BC15-3）。
6. `core_get_status` 没有 `traceId` / `mcpStatus`；诊断 `level` 是子系统名且顺序与契约相反；`snapshot.error` 恒空；`compactionReady` 被无条件置 true（BC15-4）。
7. 快照和缺 session 的 run 事件仍 `query_runs()` 全表；撤回定位 `query_events(..., None)`；`list_sessions_page` / `get_run` / `query_events_by_type` 没被这些命令用（BC15-5）。
8. `core_compact_messages` 用占位句返回成功；`core_compact_now` 失败的事件和块表不改变 `Ok`，且不写 `load_session_body` 的表（BC15-6）。
9. `core_check_command` 的 wire 是 `allowed` / `blocked` / `requiresApproval`，客户端契约是 `Allowed` / `Blocked` / `NeedsConfirmation`（BC15-7）。
10. `turn-end.usage`、`tool-start.turnIndex`、`tool-end` 的 `attempt` / `deduplicated` / `executedInput` 在枚举里，不在 `engine-events.json`；漂移测试用缺省样本看不出来（BC15-8）。无版本号的空 `save_session_body` 在已有消息时 `Ok` 但不删（BC15-9）。
