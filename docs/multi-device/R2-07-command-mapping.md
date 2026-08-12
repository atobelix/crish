# R2-07 命令批 B1：F1 监控域 10 条命令 ↔ 桌面端 REST 端点对应表

> 文档编号：R2-07（命令映射表，只读核对结论）
> 日期：2026-08-13
> 产出：apps/agent-workbench/src-tauri/src/server/router.rs（端点表）与
> core_backend.rs / core_run_commands.rs（响应数据面）的**只读核对**结论；
> 移动端实现见 `apps/crish-mobile/src/domain/repositories/monitorCommands.ts`，
> 对拍测试见 `monitorCommands.test.ts`（§4 桌面端对应表断言 = 本表可测纯函数面）。
> 纪律：本轮不修改任何桌面端代码（只读核对）；差异判定以
> `crates/conex-types/contracts/device-protocol.json`（注册表唯一真源）为准，
> 差异清单上报主控裁决。

## 1. 总表：M6 命令 → 桌面 REST 端点 → 数据面

| #   | M6 命令             | kind                       | REST 端点（router.rs 常量）                              | 数据面（直调体）                                                                       | 响应形状                                  | 差异            |
| --- | ------------------- | -------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------- | --------------- |
| C01 | getStatus           | remote.getStatus           | `GET /v1/status`（STATUS_PATH:67）                       | core_backend.rs:293-340（build_status）                                                | CoreStatus 序列化 JSON                    | **D-01 / D-02** |
| C02 | getRunSnapshot      | remote.getRunSnapshot      | `GET /v1/runs/{id}/snapshot`（RUN_SNAPSHOT_PATH:69）     | core_backend.rs:343-354 → get_run_snapshot_impl（core_run_commands.rs:6970-7008）      | `{snapshot: JsonValue}`                   | 无              |
| C03 | readSessionEvents   | remote.readSessionEvents   | `GET /v1/sessions/{id}/events`（SESSION_EVENTS_PATH:71） | core_backend.rs:357-382 → read_session_events_impl（core_run_commands.rs:6880-6912）   | EventPageResult                           | **D-03 / D-04** |
| C04 | readRunEvents       | remote.readRunEvents       | `GET /v1/runs/{id}/events`（RUN_EVENTS_PATH:73）         | core_backend.rs:385-404 → read_run_events_impl（core_run_commands.rs:6916-6966）       | EventPageResult（latestSequence 恒 None） | 无              |
| C05 | listSessions        | remote.listSessions        | `GET /v1/sessions`（SESSIONS_PATH:75）                   | core_backend.rs:407-413 → list_sessions_impl（core_run_commands.rs:7012-7019）         | `{sessions: SessionIndexEntry[]}`         | **D-05 / D-06** |
| C06 | listBackgroundTasks | remote.listBackgroundTasks | `GET /v1/tasks`（TASKS_PATH:77）                         | core_backend.rs:416-424 → list_background_tasks_impl（core_run_commands.rs:7168-7187） | `{tasks: JsonValue[]}`                    | 无              |
| C07 | getTaskOutput       | remote.getTaskOutput       | `GET /v1/tasks/{id}/output`（TASK_OUTPUT_PATH:79）       | core_backend.rs:427-439 → get_task_output_impl（core_run_commands.rs:7191-7212）       | TaskOutputResult                          | 无              |
| C08 | getFlowSnapshot     | remote.getFlowSnapshot     | `GET /v1/sessions/{id}/flow`（SESSION_FLOW_PATH:82）     | core_backend.rs:442-449 → get_flow_snapshot_impl（core_run_commands.rs:7025-7062）     | `{flow: JsonValue}`                       | 无              |
| C09 | listCommands        | remote.listCommands        | `GET /v1/commands`（COMMANDS_PATH:84）                   | core_backend.rs:452-479（manifest 映射 ManifestEntry）                                 | ListCommandsResult                        | 无              |
| C10 | getSearchIndex      | remote.getSearchIndex      | `GET /v1/search/index`（SEARCH_INDEX_PATH:87）           | core_backend.rs:483-488                                                                | `{ready, state}`                          | **D-07**        |

## 2. 查询参数对应（注册表 paramsType ↔ REST 查询参数/路径参数）

| 命令                | 注册表参数（device-protocol.json types 段）        | REST 侧承载                                                                                        | 差异                                                                                 |
| ------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| getStatus           | include（可选，聚合白名单）                        | —（R1-03 未实现 include 聚合，P-7 预留）                                                           | 见 D-02                                                                              |
| getRunSnapshot      | runId*、sessionId?                                 | 路径 `{id}` = runId；`sessionId` 查询参数（router.rs:251-257）                                     | 无（sessionId 仅校验辅助，mismatch → `cmd.invalid`，core_run_commands.rs:6987-6994） |
| readSessionEvents   | sessionId*、afterSequence?、maxEvents?、direction? | 路径 `{id}` = sessionId；`afterSequence` / `maxEvents` / `direction` 查询参数（router.rs:274-282） | direction 解析但**不生效**（见 D-04）                                                |
| readRunEvents       | runId*、sessionId?、afterSequence?、maxEvents?     | 路径 `{id}` = runId；`sessionId` / `afterSequence` / `maxEvents`（router.rs:298-303）              | 无（sessionId 缺省从 run 记录反查，core_run_commands.rs:6930-6942）                  |
| listSessions        | includeLastMessage?                                | `includeLastMessage` 查询参数（router.rs:318）                                                     | v1 接受但不生效（见 D-05）                                                           |
| listBackgroundTasks | （空）                                             | —                                                                                                  | 无                                                                                   |
| getTaskOutput       | taskId*、maxLines?、afterLine?                     | 路径 `{id}` = taskId；`maxLines` / `afterLine`（router.rs:342-346）                                | 无                                                                                   |
| getFlowSnapshot     | sessionId*                                         | 路径 `{id}` = sessionId（router.rs:355-361）                                                       | 无                                                                                   |
| listCommands        | （空）                                             | —                                                                                                  | 无                                                                                   |
| getSearchIndex      | （空）                                             | —                                                                                                  | 无                                                                                   |

**分页参数语义一致性**（无差异面）：

- `maxEvents` / `maxLines`：缺省 200、夹紧 [1, 1000]。router.rs:614-621
  `normalize_max_events`（clamp）与 core_run_commands.rs:7197（get_task_output）
  同口径；超限**截断不报错**（契约体优先于 M6 静态错误表，D2 §8.1 原则 1）。
  移动端构造侧原样透传不重算（M6 §2.4 原则 1）。
- EventPage 游标：`afterSequence` 开区间（`sequence > ?`，缺省 0 = 从头拉取）；
  `nextAfterSequence` = 本页最大序列（未取到页时 = 入参 after）；
  `hasMore` = 全量切前 max 条后仍有剩余（core_run_commands.rs:6905-6911,
  6959-6965, 7073-7079）。
- `latestSequence`：仅 readSessionEvents 下发 = 服务端该会话当前 max
  （core_backend.rs:369-381）；readRunEvents 恒 None（core_backend.rs:398-403）。
- getTaskOutput 偏移分页：`nextAfterLine` = end+1（续拉锚点）；
  `hasMore` = truncated || end < totalLines（core_run_commands.rs:7204-7211）；
  `afterLine` 缺省 = 尾部读取（read_log start_line=None 语义，
  core_run_commands.rs:7242-7254）。

## 3. 差异清单（D-01 ~ D-07）与判定

| 编号 | 命令              | 桌面端事实（代码证据）                                                                                                                                                                                         | 注册表/移动端面                                                              | 判定                                                                                                                                                |
| ---- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01 | getStatus         | `/v1/status` 实际**携带 `logDir`**：CoreStatus.log_dir 字段序列化无 `skip_serializing_if`（core_query_commands.rs CoreStatus 结构），core_backend.rs:307-309 注入后全量 to_value                               | StatusResult **未登记** logDir（M6 §4.1.1「logDir 默认不下发」未在桌面落地） | 注册表为准：生成解析器按注册表字段抽取、宽容忽略 logDir，无冲突；桌面多发送属超集，无碍                                                             |
| D-02 | getStatus         | 桌面端**不下发** `activeRuns` / `pendingApprovals`：CoreStatus 结构无此二字段（include 聚合 P-7 预留，R1-03 未实现；router.rs:235-237 注释）                                                                   | 注册表标记二者**可选**（JsonValue[]）                                        | 注册表为准：可选字段缺省合法，解析成功；移动端不得依赖首拉即得 activeRuns（需经事件流重建）                                                         |
| D-03 | readSessionEvents | 桌面端响应**不携带 `sessionId`**：core_backend.rs:376-381 构造 EventPageResult 仅 events/nextAfterSequence/hasMore/latestSequence 四字段                                                                       | 注册表 EventPageResult.sessionId **可选**                                    | 注册表为准：可选字段缺省合法，解析成功（测试 §3 已锁定该场景）                                                                                      |
| D-04 | readSessionEvents | `direction` 参数 v1 **解析但无效**：router.rs:281 `get_enum("direction")` 后传入 EventPageParams，但 core_backend.rs:357-382 的 read_session_events 不消费 direction（backward 查询面未实现，恒 forward 语义） | 注册表 direction 可选枚举（forward/backward）                                | 注册表为准：参数透传合法；**语义降级**——UI 历史倒序浏览在 v1 不可用（backward 为 M6 §4.1.3.1 新增面，桌面端未接线），移动端侧不得依赖 backward 结果 |
| D-05 | listSessions      | `includeLastMessage` v1 **接受但不生效**：router.rs:318 解析参数，list_sessions_impl（core_run_commands.rs:7012-7019）直读索引不实现 ≤80 字符预览（R1-04 直调面缺省语义）                                      | 注册表 includeLastMessage 可选                                               | 注册表为准：可传无害；移动端列表不得依赖 lastMessage 预览字段（注册表也未登记该字段）                                                               |
| D-06 | listSessions      | 桌面端 wire 可能**多携带** `branchParentId` / `pinnedMessageIds`：Rust SessionIndexEntry（crates/conex-types/src/lib.rs:239-265）序列化 `skip_serializing_if=Option::is_none`，非 None 时下发                  | 注册表 SessionIndexEntry 未登记此二字段                                      | 注册表为准：生成解析器裁剪忽略（测试 §3 已锁定键集 = 注册表字段集）                                                                                 |
| D-07 | getSearchIndex    | 桌面端 `state` **恒 None**：core_backend.rs:483-488 `state: None`（就绪事实仅由装配面注入 ready 布尔；全文搜索不暴露，M6 §4.1.10 / AU1 P2-12）                                                                 | 注册表 SearchIndexResult.state 可选                                          | 注册表为准：可选字段缺省合法；移动端不得依赖 state.totalFiles/lastBuiltAt 有值                                                                      |

## 4. 判定总则与上报主控的裁决项

1. **命名面零冲突**：双端字段名 camelCase 全一致（serde rename_all = camelCase ×
   注册表生成 camelCase）；无字段名/类型错位，全部差异集中在「多发送被忽略」
   与「可选字段缺省/参数不生效」两类。
2. **移动端权威**：解析器一律以注册表字段为抽取面（生成解析器），桌面端多余
   字段宽容忽略；「桌面端少发送」的可选字段缺省即合法——移动端消费侧不得
   把这些字段当必填。
3. **语义降级记录**：D-04（direction=backward 不生效）与 D-05
   （includeLastMessage 不生效）为「参数可传、效果缺省」——后续实现波如需要
   首屏倒序拉取 / 会话预览，须在桌面端扩展（backward 查询面 / list_sessions
   预览），本轮不修桌面端代码。
4. **上报主控裁决项**：
   - D-02：`activeRuns`/`pendingApprovals` 首拉缺省是否可接受（移动端需经
     事件流/订阅重建活动 run 与待审批列表），或需要在后续轮次扩展
     `/v1/status?include=` 聚合面；
   - D-04：backward 方向是否为 v1 必达（会话详情首屏从尾部拉取依赖它）；
   - D-05：会话列表预览 `includeLastMessage` 是否为 v1 必达（F5 §5.3 层 L1）。

## 5. 证据索引（只读核对引用的代码位置）

- router.rs：端点映射表与查询参数表 `//!` 头（8-19）、常量路径（66-87）、
  handler 组（235-380）、`normalize_max_events`（614-621）
- core_backend.rs：C01-C10 直调方法（293-488）
- core_run_commands.rs：read_session_events_impl（6880-6912）、
  read_run_events_impl（6916-6966）、get_run_snapshot_impl（6970-7008）、
  list_sessions_impl（7012-7019）、get_flow_snapshot_impl（7025-7062）、
  list_background_tasks_impl（7168-7187）、get_task_output_impl（7191-7212）、
  normalize_remote_page_size / paginate_remote（7064-7079）
- core_query_commands.rs：CoreStatus / ProviderStatus / DiagnosticEntry 结构
  （camelCase 序列化）、DEFAULT_PAGE_SIZE=200 / MAX_PAGE_SIZE=1000
- crates/conex-types/src/lib.rs：SessionIndexEntry（239-265）
- crates/conex-types/contracts/device-protocol.json：C01-C10 commands 段与
  types 段（paramsType/resultType 字段表，唯一真源）
