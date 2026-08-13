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

---

## 主控裁决（2026-08-11，D-02/D-04/D-05 归档）

| #    | 差异                                                            | 裁决                                                                                                                       | 影响   |
| ---- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| D-02 | 桌面端不下发 activeRuns/pendingApprovals（P-7 预留）            | 移动端容忍缺省（注册表可选字段）；首拉对账走 mobile_list_pending_approvals（C13 已实现）；P-7 桌面端装配随 R2 桌面增强排期 | 无阻塞 |
| D-04 | readSessionEvents direction=backward 解析但不生效（恒 forward） | v1 契约 = forward-only；backward 回看排期（R2-05 会话回看增强，需求驱动）                                                  | 无阻塞 |
| D-05 | includeLastMessage 接受不生效                                   | 会话列表预览用本地已缓存最后消息；includeLastMessage 语义留增强                                                            | 无阻塞 |

依据：效果锁（不为 v1 砍契约字段，语义降级显式登记）+ 注册表为准（R2-07 对拍总原则）。

---

## B6 设备域命令批（R2-12）：C33-C37 5 条 ↔ 桌面端多端互通命令语义核对

> 批次：R2-12（Z0:1386）；移动端实现见
> `apps/crish-mobile/src/domain/repositories/deviceCommands.ts`，对拍测试见
> `deviceCommands.test.ts`（§4 桌面端对应表断言 = 本表可测纯函数面）。
> 纪律：本轮不修改任何桌面端代码（只读核对）；差异判定以
> `crates/conex-types/contracts/device-protocol.json`（注册表唯一真源）为准。

### B6-1. queryPresence 归属判定（B5 还是 B6；注册表真源裁决）

| 维度         | 事实                                                                                                                                                     | 出处                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 功能域标注   | C32 queryPresence `domain=settings`                                                                                                                      | device-protocol.json commands 段（2883 行）            |
| 文档总表归属 | M6 §4.5.0 F6 设置域总表第 5 条（C32）；§4.6 设备域总表仅 C33-C37                                                                                         | M6-protocol-messages.md:867,951                        |
| 批次分配     | Z0:1386 / AU3 §4.2 把 queryPresence 列入 B6 批次清单；B5 清单仅 getSettings/setSettings/settingsConfirm/pauseAutomation 4 条                             | Z0-master-plan.md:1384 / AU3-executability.md:293-294  |
| **裁定**     | **queryPresence 归 B5 设置批**（以注册表 domain=settings 真源为准；`settingsCommands.ts` 已实现 `buildQueryPresenceRequest`，deviceCommands 不重复实现） | 本批裁决（任务书「以 device-protocol.json 真源为准」） |

### B6-2. 总表：M6 设备域命令 → 桌面多端互通命令面 → 差异

| #   | M6 命令      | kind                | 桌面对应命令（multi_device_commands.rs）                 | 注册表 tauriCommand（新增面，registered=false） | 差异     |
| --- | ------------ | ------------------- | -------------------------------------------------------- | ----------------------------------------------- | -------- |
| C33 | listDevices  | remote.listDevices  | multi_device_list_devices（:58，返回 Vec\<DeviceInfo\>） | device_registry_query                           | **D-08** |
| C34 | renameDevice | remote.renameDevice | multi_device_rename_device（:76，hash + new_label）      | device_registry_update                          | **D-09** |
| C35 | revokeDevice | remote.revokeDevice | multi_device_revoke_device（:64，hash）                  | device_registry_delete                          | **D-10** |
| C36 | getPairState | remote.getPairState | multi_device_pair_status（:42，PairStatus）              | pairing_service_query                           | **D-11** |
| C37 | unlink       | remote.unlink       | （无直映；语义对照 multi_device_pair_cancel :52）        | device_registry_unlink                          | **D-12** |

### B6-3. 差异清单（D-08 ~ D-12）与判定

| 编号 | 命令         | 桌面端事实（代码证据）                                                                                                                                                                                                                                                  | 注册表/移动端面                                                                                                                                                     | 判定                                                                                                                                                                                                                                                                                               |
| ---- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-08 | listDevices  | multi_device_list_devices 返回 `Vec<DeviceInfo>`（pairing.rs:79-85：`id`=令牌哈希截断 12、`label`、`issued_at_ms`、`revoked`）；命令面以令牌哈希为设备身份                                                                                                              | ListDevicesResult.devices 条目 = `DeviceEntry{deviceId(移动端 UUID)/name/type/role/channel/online/lastActiveAt/pairedAt/needsReauth}`，必填 deviceId/name/type/role | 注册表为准：身份键与字段名完全不同——服务端新增面 device_registry_query 须按 DeviceEntry 输出（deviceId 为移动端生成 UUID，pairProtocol.generateDeviceId），不能直接复用桌面 DeviceInfo 形状                                                                                                        |
| D-09 | renameDevice | multi_device_rename_device(hash, new_label)：hash 须 64 位令牌哈希、label 1-40 字符（multi_device_commands.rs:76-89）                                                                                                                                                   | RenameDeviceParams{deviceId*, name*}（name ≤64）                                                                                                                    | 注册表为准：身份键 hash→deviceId（服务端新增面按 deviceId 路由）；名称上限 40→64（注册表 name ≤64，桌面 label ≤40 为旧面约束，新增面按注册表校验）                                                                                                                                                 |
| D-10 | revokeDevice | multi_device_revoke_device(hash)：令牌失效→落盘→WS 踢出→REST 鉴权 401（multi_device_commands.rs:64-72、:47-49 注释）；撤销已撤销返回 Ok(true)（幂等）                                                                                                                   | RevokeDeviceParams{deviceId*}；write=true；idempotencyKey=natural（撤销已撤销=成功）；错误码 cmd.not_found                                                          | 注册表为准：身份键 hash→deviceId；**401 语义对齐**——撤销后本设备令牌立即失效，后续请求 401（注册表 errors 段 auth.device_revoked/auth.unknown_device，retryable=false，需重新配对）                                                                                                                |
| D-11 | getPairState | multi_device_pair_status 返回 PairStatus{state,pairing_enabled,bind_mode,code_remaining_ms,failed_attempts,token_count}（pairing.rs:68-75）；state 为桌面状态机 5 态 idle/waiting-input/key-verify/establishing/established（pair.rs:31-42，pairing.rs:186-187 序列化） | PairStateResult{state*, desktopId?}；state 枚举 6 态 none/scanning/inputting/handshaking/done/failed（F6 §6.4）                                                     | 注册表为准：两套状态词汇（桌面状态机态 vs 协议态）——服务端新增面 pairing_service_query 须做状态映射；移动端本地 pairMachine（idle/waiting-input/sending-hello/waiting-verify/paired/error/locked）与协议 PairState 亦为两套词汇，getPairState 用于配对页多端一致性核对，接线层做映射（本批不接线） |
| D-12 | unlink       | 无直映命令；语义最接近 multi_device_pair_cancel（:47-54）= 关闭配对/撤销**全部**设备（清空全部令牌 + WS 全部踢出 + 状态机重置回 Loopback 重绑）                                                                                                                         | UnlinkParams 空；write=true；错误码 cmd.not_found；响应 UnlinkResult{ok}                                                                                            | 注册表为准：unlink 为**单设备解除**（删除本设备表条目 + 广播 device.revoked，令牌立即失效 401），粒度不同于 pair_cancel 全撤销——服务端新增面 device_registry_unlink 承载单设备解除语义                                                                                                             |

### B6-4. 判定总则

1. **身份键统一**：设备域 5 条命令（除 getPairState 外）身份键一律 `deviceId`（移动端生成 UUID，8-64 字符）；桌面旧命令面的 64 位令牌哈希仅存于桌面命令面，不进协议面——服务端新增面负责 deviceId ↔ 令牌映射。
2. **撤销 401 语义**：revokeDevice/unlink 成功后本设备令牌立即失效 → 后续任何请求 401（auth.device_revoked / auth.unknown_device）；移动端须在本地清空凭据并回到配对态（接线层职责，本批只构造/解析）。
3. **状态词汇两套**：桌面 PairStateMachine 5 态 ↔ 协议 PairState 6 态 ↔ 移动端 pairMachine 5+ 态；getPairState 的响应只按注册表枚举解析，跨态映射在接线层（本批不接线）。
4. _\*mobile_* 8 条新增_*：`mobile_list_pending_approvals` / `mobile_approval_sync_state` / `mobile_get_workspace_state` / `mobile_search_files` / `mobile_asset_url` / `mobile_settings_confirm` / `mobile_pause_automation` / `mobile_search_sessions` 属各自功能域批次（approval/files/settings/sessions），不在本 B6 设备域批范围（R2-12 为「部分」——本批仅设备域 5 条 + queryPresence 归属裁定）。
5. **上报主控裁决项**：D-09 名称上限（桌面 40 vs 注册表 64）与 D-11 状态映射是否需要服务端新增面双向映射表（桌面态→协议态），由服务端实现轮次确认。

### B6-5. 证据索引（只读核对引用的代码位置）

- multi_device_commands.rs：pair_start（23-37）、pair_status（42-45）、pair_cancel（52-54，全撤销语义）、list_devices（58-60）、revoke_device（64-72）、rename_device（76-89）
- server/pairing.rs：PairStatus（68-75）、DeviceInfo（79-85）
- server/pair.rs：PairState 枚举 5 态（31-42）
- crates/conex-types/contracts/device-protocol.json：C33-C37 commands 段（2893-2976）、types 段 DeviceEntry/ListDevicesParams/ListDevicesResult/RenameDeviceParams/RevokeDeviceParams/PairStateParams/PairStateResult/UnlinkParams/UnlinkResult/GenericOkResult（5666-5744）、errors 段 auth.device_revoked/auth.unknown_device（3607-3617）
- packages/shared-types/src/generated/device/errors.ts：DEVICE_ERROR_PROTOCOL（auth.device_revoked / auth.unknown_device）

---

## B6 主控裁决（R2-12 设备域批，D-08 ~ D-12 待归档）

---

# R2-10 命令批 B4：F5 会话域 4 条命令 ↔ 桌面端 REST 端点对应表

> 追加日期：2026-08-13（R2-10 B4 会话批，本文件第 2 批次节）
> 移动端实现：`apps/crish-mobile/src/domain/repositories/sessionCommands.ts`，
> 对拍测试：`sessionCommands.test.ts`（§4 桌面端对应表断言 = 本表可测纯函数面）。
> 桌面端只读核对面：router.rs 写面常量路径（139-145）与 handler（384-425）、
> core_backend.rs（C24-C26 直调，505-610）。真源：device-protocol.json
> commands 段 C24-C27（注册表唯一真源）；Rust 同构体
> `crates/conex-types/src/device/commands.rs:1076-1168`。

## 6. B4 总表：M6 会话域命令 → 桌面 REST 端点 → 数据面

| #   | M6 命令        | kind                  | REST 端点（router.rs 常量）                              | 数据面（直调体）                                                | 响应形状             | 差异               |
| --- | -------------- | --------------------- | -------------------------------------------------------- | --------------------------------------------------------------- | -------------------- | ------------------ |
| C24 | runTask        | remote.runTask        | `POST /v1/runs`（RUNS_PATH:140）                         | core_backend.rs:531-577 → run_task_impl（core_run_commands.rs） | `{runId, sessionId}` | 无（见 §7 语义注） |
| C25 | runControl     | remote.runControl     | `POST /v1/runs/{id}/control`（RUN_CONTROL_PATH:143）     | core_backend.rs:581-599 → run_control_impl                      | `{ok}`               | **D-08 / D-09**    |
| C26 | cancelRun      | remote.cancelRun      | `POST /v1/runs/{id}/cancel`（RUN_CANCEL_PATH:145）       | core_backend.rs:602-610 → cancel_run_impl                       | `{ok, runId}`        | **D-10**           |
| C27 | searchSessions | remote.searchSessions | **v1 无端点**（mobile_search_sessions registered=false） | —（P2 预留，v1 未接线）                                         | —（cmd.unknown）     | **D-11**           |

## 7. B4 参数承载（注册表 paramsType ↔ REST body / 路径参数）

| 命令           | 注册表参数（device-protocol.json types 段）                                               | REST 侧承载                                                                                        | 差异                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| runTask        | sessionId?、prompt*、promptRef?、mode?、cwd?、permissionMode?、history?、clientMessageId? | body = RunTaskParams 全量（POST /v1/runs；sessionId 缺省 → 桌面新建会话，core_backend.rs:508-526） | 无（构造侧全值域透传；permissionMode 降级语义见 §8）                                                          |
| runControl     | level*、runId*、sessionId*、reason?、payload?                                             | body = RunControlParams（**路径 runId 优先覆盖 body 值**，router.rs:405 `params.run_id = run_id`） | 无字段冲突；body 携带的 runId 以路径为准（D-08）；payload 仅 soft_inject {text} / continue {message?}（D-09） |
| cancelRun      | runId*、reason?                                                                           | body 仅解析 `{reason?}`（router.rs:419-422）；**runId 只能走路径**（body 中 runId 被忽略）         | 承载面差异（D-10）：注册表 runId 为 body 字段；REST 侧 runId 为路径字段                                       |
| searchSessions | query*、limit?（limit 缺省 50 上限 50）                                                   | —（无端点）                                                                                        | 无承载面（D-11）：v1 未注册，移动端本地标题过滤 + 已加载消息搜索兜底（F5 §2.6）                               |

**幂等与夹紧语义（无差异面）**：

- `runTask`：**clientMessageId 幂等**（注册表 idempotencyKey；同 id 重发 →
  返回首次 runId，不重复开 run，F5 §1.8）；prompt 超 256 KiB 由桌面端拒绝
  （core_backend.rs:503-507），构造侧原样透传不重算（M6 §2.4 原则 1）；
  流上传 `promptRef` 为后续增强（M6 §7.4）。
- `runControl` / `cancelRun`：控制面幂等（ControlBus / 终态拒绝
  TerminalImmutable）——重复 cooperative_stop/force_cancel/cancel 无副作用。
- `searchSessions`：limit 夹紧归属桌面端（缺省 50 上限 50），构造侧透传。

## 8. B4 差异清单（D-08 ~ D-11）与判定

| 编号 | 命令           | 桌面端事实（代码证据）                                                                                                                                                   | 注册表/移动端面                                                                           | 判定                                                                                                                                                                                |
| ---- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-08 | runControl     | REST handler 路径 runId **覆盖 body 携带的 runId**（router.rs:405）；`session_id` 为 body 必填（Rust RunControlParams commands.rs:1115-1128 无 default）                 | 注册表 runId/sessionId 均必填；body 全量透传                                              | 注册表为准：构造侧仍携带 runId/sessionId（协议面与 REST 面共用参数形状）；移动端经 WsGateway 直连时 runId 以信封 body 为准，REST 直连时以路径为准——两承载面语义等价，无冲突         |
| D-09 | runControl     | `payload` 语义约束：L1 soft_inject 需 `{text}`、L0 continue 需 `{message?}`（core_backend.rs:588-595 透传 run_control_impl；缺失 → cmd.invalid）                         | 注册表 payload 可选 JsonValue（无结构约束字段）                                           | 注册表为准：构造层不校验 payload 内部形状（Jsonschema 宽容）；语义约束由 UI 层（L1/L0 表单）与桌面端裁决，移动端不得依赖 payload 任意形状合法                                       |
| D-10 | cancelRun      | REST body **仅解析 reason**（router.rs:419-422 `body.get("reason")`），runId 恒走路径；返回 `{ok, runId}`（core_backend.rs:602-610）                                     | 注册表 CancelRunParams {runId*, reason?}；CancelRunResult {ok, runId}                     | 注册表为准：构造侧 runId 仍为参数（WsGateway 信封面使用）；REST 承载面差异（路径真键）属桌面实现细节，不改变协议形状；移动端 REST 直连时须将 runId 置于路径                         |
| D-11 | searchSessions | **v1 无端点**：mobile_search_sessions registered=false（注册表 C27；命令执行面白名单未登记 → cmd.unknown）；`/v1/search` 不存在（C10 为 GET /v1/search/index，另一命令） | 注册表 SearchSessionsParams {query*, limit?}；resultType 为 {results: SearchSessionHit[]} | 注册表为准：协议面预留（P2）；v1 调用必得 cmd.unknown——移动端搜索功能走**本地标题过滤 + 已加载消息内搜索**兜底（F5 §2.6），构造层照常提供（能力发现后按 registered=false 降级展示） |

**permissionMode 降级语义（runTask，非差异）**：桌面 `apply_remote_mode`
（core_backend.rs:107-112）对 `full-access` **恒降级 ask**（远程不存在
full-access，R1-10 T-08 / D5 §4.6.1 / TH-12 直接缓解）并发射
remote-mode-downgrade 审计（core_backend.rs:527-539）；ask/plan 原样；
不申报（None）原样（桌面端装配 ask 缺省）。移动端构造层允许全值域
（注册表 PermissionMode 三值），但**默认申报 ask，UI 不提供 full-access
选项**（可提供 ask/plan 选择）——申报 full-access 只会被桌面降级并记审计。

## 9. B4 证据索引（只读核对引用的代码位置）

- router.rs：写面常量路径（139-145）、R1-04 写面路由挂载（200-207）、
  handler（384-425：run_task / run_control / run_cancel）
- core_backend.rs：apply_remote_mode（107-112）、REMOTE_MODE_DOWNGRADE
  审计（114-118）、run_task（505-577，含 256 KiB 拒绝 / sessionId 缺省
  新建 / 权限降级）、run_control（581-599）、cancel_run（602-610）
- crates/conex-types/src/device/commands.rs：RunTaskParams（1076-1100）、
  RunTaskResult（1102-1110）、RunControlParams（1112-1128）、
  RunControlResult（1130-1136）、CancelRunParams（1138-1147）、
  CancelRunResult（1149-1157）、SearchSessionsParams（1159-1168）
- crates/conex-types/contracts/device-protocol.json：C24-C27 commands 段与
  types 段（paramsType/resultType 字段表 + PermissionMode/RunControlLevel
  枚举，唯一真源）

---

# R2-11 命令批 B5：F6 设置域 5 条命令 ↔ 桌面端 REST 端点对应表

> 追加日期：2026-08-13（R2-11 B5 设置批，本文件第 3 批次节）
> 移动端实现：`apps/crish-mobile/src/domain/repositories/settingsCommands.ts`，
> 对拍测试：`settingsCommands.test.ts`（§4 桌面端对应表断言 = 本表可测纯函数面）。
> 桌面端只读核对面：router.rs 常量路径（156 SETTINGS_PATH）与路由挂载
> （207）、handler（505-531）、core_backend.rs（settings_get 674-696 /
> settings_set 698-714）、core_run_commands.rs（settings_update_impl
> 7085-7119）。真源：device-protocol.json commands 段 C28-C32。
> **B5 条数裁定**：queryPresence（C32）注册表 commands 段 domain=settings
> （device-protocol.json:2883），归本批 B5——共 **5 条**（与 M6 §4.5.0 总表
> 一致，任务书「若属设备域则只做 4 条」分支不触发）。

## 10. B5 总表：M6 设置域命令 → 桌面 REST 端点 → 数据面

| #   | M6 命令         | kind                   | REST 端点（router.rs 常量）                               | 数据面（直调体）                                                                          | 响应形状                                           | 差异            |
| --- | --------------- | ---------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------- |
| C28 | getSettings     | remote.getSettings     | `GET /v1/settings`（SETTINGS_PATH:156）                   | core_backend.rs:674-696 → settings_get_impl（config_get，core_run_commands.rs:7085-7087） | `{settings: JsonValue}`（脱敏快照，apiKey 恒空串） | 无              |
| C29 | setSettings     | remote.setSettings     | `PUT /v1/settings`（SETTINGS_PATH:156）                   | core_backend.rs:698-714 → settings_update_impl（core_run_commands.rs:7094-7119）          | `{settings: JsonValue}`（全量快照回显）            | **D-12 / D-13** |
| C30 | settingsConfirm | remote.settingsConfirm | **v1 无端点**（mobile_settings_confirm registered=false） | —（[新增] 待接线，M6 §12.4）                                                              | —（{status} 待接线后生效）                         | **D-14**        |
| C31 | pauseAutomation | remote.pauseAutomation | **v1 无端点**（mobile_pause_automation registered=false） | —（[新增] 待接线，M6 §12.4）                                                              | —（{ok, pausedUntil} 待接线后生效）                | **D-14**        |
| C32 | queryPresence   | remote.queryPresence   | **v1 无端点**（device_presence_query registered=false）   | —（[新增] 待接线，M6 §12.4）                                                              | —（{desktopOnline, ...} 待接线后生效）             | **D-14**        |

## 11. B5 参数承载（注册表 paramsType ↔ REST 查询参数 / body）

| 命令            | 注册表参数（device-protocol.json types 段）            | REST 侧承载                                                                                            | 差异                                                                                               |
| --------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| getSettings     | keys?（string[]，白名单子集 8 键）                     | `keys` 查询参数**逗号分隔**（router.rs:513-519 手写 split；缺失键静默忽略不过滤报错）                  | 承载面差异（非差异项）：协议数组 ↔ REST 逗号串，跨端网关接线时做形状映射                           |
| setSettings     | key*（SettingsKey 恒 3 键）、value*（string\|boolean） | body = SettingsUpdateParams{baseUrl?, model?, credentialMode?, endpoint?, stream?}（backend.rs:38-54） | **面形状不同**（D-12）：协议 {key, value} ↔ REST 平铺字段；拒绝字段显式 cmd.invalid（fail-closed） |
| settingsConfirm | confirmRequestId*、action*（withdraw/query）           | —（无端点）                                                                                            | 无承载面（D-14）：registered=false 待接线                                                          |
| pauseAutomation | durationSec?（默认 3600、上限 86400）                  | —（无端点）                                                                                            | 无承载面（D-14）：registered=false 待接线                                                          |
| queryPresence   | （空）                                                 | —（无端点）                                                                                            | 无承载面（D-14）：registered=false 待接线                                                          |

**幂等与语义（无差异面）**：

- `setSettings`：**设置键幂等**（同 key 同 value 重发无害；注册表
  idempotencyKey = key + value / confirmRequestId）；两态响应——
  直接生效 `{ok, applied:true}` / 待桌面确认 `{ok, applied:false,
pending:true, confirmRequestId}`（60s 超时视为拒绝，settings.confirm_timeout）。
- `pauseAutomation`：**msgId 幂等**（outbox 重发不重复执行）；一次性指令
  不改变持久化配置（F6 §8.2「受限触发」）；重复暂停刷新 pausedUntil。
- `settingsConfirm`：confirmRequestId 幂等（撤回已撤回 = 成功，天然）。
- **fail-closed 铁律（R1-04 直调面）**：PUT /v1/settings 对
  credentialMode / endpoint / stream 任一出现 → **显式 `cmd.invalid`**，
  不静默忽略（core_run_commands.rs:7102-7106「请求成功但未生效」禁止）；
  协议层 setSettings 的 key 白名单恒 3 键（SettingsKey：responseStyle /
  enableAnalytics / enableCrashTelemetry），其余 settings.key_denied。

## 12. B5 差异清单（D-12 ~ D-14）与判定

| 编号 | 命令                                              | 桌面端事实（代码证据）                                                                                                                                                                                                                                                                             | 注册表/移动端面                                                                             | 判定                                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-12 | setSettings                                       | REST PUT 面 wire 形状 = **SettingsUpdateParams 平铺字段**（backend.rs:38-54：baseUrl/model/credentialMode/endpoint/stream），与注册表 SetSettingsParams {key, value} **面形状不同**；credentialMode/endpoint/stream 显式拒绝 cmd.invalid（core_run_commands.rs:7102-7106，fail-closed 不静默忽略） | 注册表 SetSettingsParams {key*, value*}；key 白名单恒 3 键（SettingsKey 枚举）              | 注册表为准：移动端构造侧按协议面 {key, value} 构造；REST PUT 面为 R1-04 直调面（ConfigStore 直写 baseUrl/model 两键），两承载面无字段名冲突——跨端网关接线（M6 §12.4 [新增] 面）时由桌面适配层做 {key,value} → 平铺字段映射，**不改变协议形状** |
| D-13 | setSettings                                       | PUT /v1/settings 响应为 **GetSettingsResult 全量脱敏快照**（core_backend.rs:713 `{settings}`）；桌面端 v1 无确认通道（无 mobile_settings_confirm 接线，无 pending/confirmRequestId 下发）                                                                                                          | 注册表 SetSettingsResult 两态（ok/applied/pending/confirmRequestId）                        | 注册表为准：pending/confirmRequestId 缺省合法（可选字段），移动端以 `ok:true` 且无 pending 视为直接生效；桌面确认通道（F6 §8.3）待 [新增] 面接线后启用，接线前移动端不做 pending 分支依赖                                                      |
| D-14 | settingsConfirm / pauseAutomation / queryPresence | **v1 无端点**：三条均 registered=false（注册表 C30/C31/C32，[新增] 待接线，M6 §12.4）；`/v1/settings` 仅挂 GET/PUT（router.rs:207），无 confirm/pause/presence 路由                                                                                                                                | 注册表 SettingsConfirmParams/PauseAutomationParams/PresenceParams 完整登记；resultType 完整 | 注册表为准：协议面照常构造（能力发现后按 registered=false 降级/隐藏 UI 入口）；v1 调用将得 cmd.unknown/404 兜底，移动端不得依赖其可用——待桌面接线轮次（R2 桌面增强）落地                                                                       |

**keys 承载面备注（getSettings，非差异）**：协议 keys 为 string[]，REST 侧
逗号分隔字符串（router.rs:513-519）；网关接线时做数组 ↔ 逗号串形状映射；
请求键不在快照字段内静默忽略（core_backend.rs:684-690，非报错语义）。

## 13. B5 证据索引（只读核对引用的代码位置）

- router.rs：SETTINGS_PATH（156）、路由挂载 `get + put`（207）、
  handle_settings_get（505-521，keys 逗号分隔过滤）、handle_settings_set
  （523-531，body = SettingsUpdateParams）
- server/backend.rs：SettingsUpdateParams 结构（38-54，credentialMode /
  endpoint / stream 为 R1-04 拒绝字段）
- core_backend.rs：settings_get（674-696，keys 子集过滤）、settings_set
  （698-714，直调 settings_update_impl）
- core_run_commands.rs：settings_get_impl（7085-7087）、settings_update_impl
  （7094-7119：拒绝字段显式 cmd.invalid + store 写成功重载 provider）
- crates/conex-types/contracts/device-protocol.json：C28-C32 commands 段与
  types 段（GetSettingsParams/SetSettingsParams/SettingsConfirmParams/
  PauseAutomationParams/PresenceParams + 各 resultType）+ enums 段
  （SettingsKey 3 键 / SettingsConfirmAction / ConfirmStatus），唯一真源

---

# R2-08 命令批 B2：F2 审批域 5 条命令 ↔ 桌面端 REST 端点对应表

> 追加日期：2026-08-13（R2-08 B2 审批批，本文件第 4 批次节）
> 移动端实现：`apps/crish-mobile/src/domain/repositories/approvalCommands.ts`，
> 对拍测试：`approvalCommands.test.ts`（§4 桌面端对应表断言 = 本表可测纯函数面）。
> 桌面端只读核对面：router.rs 审批写面常量路径（148-154）与 handler（427-503）、
> core_backend.rs（approve 615-625 / deny 629-644 / list_pending_approvals 648-657 /
> approval_history 660-672）、core_run_commands.rs（approve_tool_impl 7214 /
> deny_tool_impl 7252 / list_pending_approvals_impl 7296-7329 /
> approval_history_impl 7361-7395）、server/error.rs（HTTP 状态映射 120-133）。
> 真源：device-protocol.json commands 段 C11-C15（注册表唯一真源）；
> Rust 同构体 `crates/conex-types/src/device/commands.rs`（ApproveParams 454-460 /
> DenyParams 462-470 / PendingApproval 717-753 / ApprovalHistoryItem 等）。

## 14. B2 总表：M6 审批域命令 → 桌面 REST 端点 → 数据面

| #   | M6 命令              | kind                        | REST 端点（router.rs 常量）                                                                     | 数据面（直调体）                                                         | 响应形状                                         | 差异     |
| --- | -------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ | -------- |
| C11 | approve              | remote.approve              | `POST /v1/approval/{toolCallId}/approve`（APPROVAL_APPROVE_PATH:148）                           | core_backend.rs:615-625 → approve_tool_impl（core_run_commands.rs:7214） | `{ok, toolCallId, decision:"approved"}`          | **D-16** |
| C12 | deny                 | remote.deny                 | `POST /v1/approval/{toolCallId}/deny`（APPROVAL_DENY_PATH:150）                                 | core_backend.rs:629-644 → deny_tool_impl（core_run_commands.rs:7252）    | `{ok, toolCallId, decision:"denied"}`            | **D-16** |
| C13 | listPendingApprovals | remote.listPendingApprovals | `GET /v1/approvals/pending`（APPROVALS_PENDING_PATH:152）                                       | core_backend.rs:648-657 → list_pending_approvals_impl（7296-7329）       | `{approvals: PendingApproval[], latestSequence}` | **D-17** |
| C14 | approvalHistory      | remote.approvalHistory      | `GET /v1/approvals/history`（APPROVALS_HISTORY_PATH:154）                                       | core_backend.rs:660-672 → approval_history_impl（7361-7395）             | `{items, nextAfterSequence, hasMore}`            | **D-18** |
| C15 | checkCommand         | remote.checkCommand         | **v1 无 REST 端点**（仅引擎命令面 core_check_command registered=true，command_manifest.rs:125） | —（REST 直调面无 check_command 路由；WsGateway 信封面可直接调用）        | `{decision, reason?}`                            | **D-15** |

## 15. B2 参数承载（注册表 paramsType ↔ REST body / 路径 / 查询参数）

| 命令                 | 注册表参数（device-protocol.json types 段）                               | REST 侧承载                                                                                  | 差异                                                                                               |
| -------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| approve              | toolCallId*、runId?（**无 decision 字段**——协议面恒 approved，M6 §4.2.1） | body = `{runId?}`（router.rs:430-441）；**toolCallId 路径真键**（body 中 toolCallId 不解析） | 承载面差异（D-16）：注册表 toolCallId 为 body 字段；REST 侧为路径字段（与 B4 D-10 cancelRun 同型） |
| deny                 | toolCallId*、runId?、reason?（reason ≤256，缺省 "user denied"）           | body = `{runId?, reason?}`（router.rs:445-468）；toolCallId 路径真键                         | 承载面差异（D-16）：同上；body 全量字段（runId/reason）与注册表一一对应                            |
| listPendingApprovals | afterSequence?（增量水位）                                                | `afterSequence` 查询参数（router.rs:470-484）                                                | 语义降级（D-17）：R1-04 实现为全量对账，latestSequence 恒 None——参数可传无害，增量水位未生效       |
| approvalHistory      | sessionId?、afterSequence?、limit?（limit 缺省 100 上限 500）             | `sessionId`/`afterSequence`/`limit` 查询参数（router.rs:486-503）                            | 夹紧归属桌面端（D-18）：limit clamp(1,500) 桌面保证（core_run_commands.rs:7367），构造侧透传不重算 |
| checkCommand         | command*、params?（JsonValue，如 shell:write 的 {script}）                | —（无端点）                                                                                  | 无承载面（D-15）：v1 仅引擎命令面，REST 直连不可用                                                 |

**幂等与决策语义（无差异面，F2 决策语义快照）**：

- `approve` / `deny`：**I-02 天然幂等（状态机级）**——第二次命中同一 toolCallId →
  `cmd.approval_mismatch` 409，不改状态机（D3 §8.5 / M6 §1.3；router.rs:2416-2445
  测试：首次 200 → 重复 409 code=cmd.approval_mismatch，retryable=false）；
  叠加请求级幂等：同 msgId 重发回显缓存结果（TTL 5min）；**先到者胜**——双端
  并发决策时引擎 pending 集合原子移除（core_run_commands.rs:235-240），后到者
  NotFound/mismatch 收敛（F2 §11.2 冲突表）；冲突收敛以 `approval-resolved`
  事件为唯一裁决。决策走 outbox + toolCallId+msgId 幂等键（注册表 idempotencyKey）。
- `listPendingApprovals` / `approvalHistory` / `checkCommand`：只读天然幂等。
- **不可重试冲突码**（approvalWiring.ts PERMANENT_DECISION_ERROR_CODES 静态
  镜像）：`cmd.approval_mismatch` / `cmd.not_found` / `cmd.denied` /
  `cmd.invalid` / `approval.expired` / `approval.rejected` → 出队收敛
  （D6 §6.3 不自动重试 conflict/stale）；网络/超时瞬态错误才退避重试。

## 16. B2 差异清单（D-15 ~ D-18）与判定

| 编号 | 命令                 | 桌面端事实（代码证据）                                                                                                                                                                                                                             | 注册表/移动端面                                                                                                                                               | 判定                                                                                                                                                                                                                                                                                                          |
| ---- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-15 | checkCommand         | **v1 无 REST 端点**：core_check_command 在 manifest 登记 registered=true（command_manifest.rs:125），但 router.rs 无 check_command 路由（挂载面 188-207 无对应项）——REST 直连面不存在，仅引擎命令面可经 WsGateway/网关调用                         | 注册表 CheckCommandParams {command*, params?}；resultType {decision*, reason?}；错误码 cmd.unknown                                                            | 注册表为准：构造侧照常构造；v1 移动端若走 REST 直连不可用（404），须走 WsGateway 信封面（远程命令面）或本地预判定兜底；decision 三值（allowed/requires-approval/blocked）为只读预览，非安全判定（D3 §8.3，真实判定在引擎 gatekeeper/审批门）                                                                  |
| D-16 | approve / deny       | REST handler 以**路径 toolCallId 为真键**（router.rs:430-441 / 445-468 `Path(tool_call_id)`），body 仅解析 `{runId?}` / `{runId?, reason?}`；响应 decision **恒 approved / denied**（core_backend.rs:620-624 / 639-643 装配，不透传引擎 decision） | 注册表 ApproveParams {toolCallId*, runId?}；DenyParams {toolCallId*, runId?, reason?}；resultType 共用 ApproveResult；**协议面无 decision 字段**（M6 §4.2.1） | 注册表为准：构造侧 toolCallId 仍为 body 字段（WsGateway 信封面使用）；REST 直连时 toolCallId 走路径（与 B4 D-10 cancelRun 同型承载面差异，两承载面语义等价）；任务书草案「approve{toolCallId, decision?}」以注册表为准——**无 decision 字段**，恒 approved/denied 由桌面装配，移动端构造侧不得添加 decision 键 |
| D-17 | listPendingApprovals | R1-04 实现为**全量对账**：core_backend.rs:646-657 忽略 after_sequence（参数下划线命名 `_params`）+ `latest_sequence: None` 恒不返回；派生面 list_pending_approvals_impl（core_run_commands.rs:7296-7329）为 active_runs 待审批集合快照             | 注册表 ListPendingApprovalsParams {afterSequence?}；resultType {approvals*, latestSequence?}                                                                  | 注册表为准：afterSequence 照常透传（可传无害，桌面忽略）；**latestSequence 恒缺省合法**（可选字段）——移动端不得依赖增量水位与水位回读；对账语义 = 全量拉取 + 本地双向往收敛（F2 §4.1 / D6 §6.5）                                                                                                              |
| D-18 | approvalHistory      | limit 夹紧归属桌面端：approval_history_impl `limit.unwrap_or(100).clamp(1, 500)`（core_run_commands.rs:7367）；approval-resolved 事件白名单投影，不携带参数全量（同 C13 隐私红线）                                                                 | 注册表 ApprovalHistoryParams {sessionId?, afterSequence?, limit?}；resultType {items*, nextAfterSequence?, hasMore?}                                          | 注册表为准：构造侧 limit 原样透传不重算（M6 §2.4 原则 1）；响应分页字段 nextAfterSequence/hasMore 全可选（尾页缺省合法）——移动端按「有 hasMore 续拉、无则到尾」消费；历史条目 decision 三值含 expired（事件面）                                                                                               |

**decision 语义备注（非差异）**：协议面 approve/deny 不携带 decision 字段——
跨端消灭「传错决策」的可能性（M6 §4.2.1）；响应侧 decision 恒 approved/denied
（桌面装配，不透传引擎内部裁决）；ApprovalDecision 三值（approved/denied/expired）
中 expired 出现在事件面（approval-resolved）与历史补拉面，不出现在决策回执面。

## 17. B2 证据索引（只读核对引用的代码位置）

- router.rs：审批写面常量路径（148-154：APPROVAL_APPROVE_PATH /
  APPROVAL_DENY_PATH / APPROVALS_PENDING_PATH / APPROVALS_HISTORY_PATH）、
  写面路由挂载（203-206）、handler（427-503：handle_approve / handle_deny /
  handle_approvals_pending / handle_approvals_history）、重复决策 409 测试
  （2416-2445）
- core_backend.rs：approve（612-625）、deny（627-644）、resolve_approval_run_id /
  resolve_deny_run_id（717-746，toolCallId 不在待审批集合 → cmd.approval_mismatch）、
  list_pending_approvals（646-657，全量对账 latest_sequence 恒 None）、
  approval_history（659-672）
- core_run_commands.rs：approve_tool_impl（7214）、deny_tool_impl（7252）、
  list_pending_approvals_impl（7296-7329，pending_requests 快照 + derive_danger_level
  7337-7355）、approval_history_impl（7361-7395，limit clamp 7367）
- server/error.rs：HTTP 状态映射（120-133，cmd.approval_mismatch → 409 /
  cmd.denied → 403 / cmd.not_found → 404 / cmd.invalid → 400）
- command_manifest.rs：core_check_command（125，registered=true）、
  core_approve_tool / core_deny_tool（126-127）
- crates/conex-types/src/device/commands.rs：ApproveParams / DenyParams /
  ApproveResult / ListPendingApprovalsParams / PendingApproval（717-753，
  nullable 字段 skip_serializing_if=Option::is_none）/ ListPendingApprovalsResult /
  ApprovalHistoryParams / ApprovalHistoryItem / ApprovalHistoryResult /
  CheckCommandParams / CheckCommandResult
- crates/conex-types/contracts/device-protocol.json：C11-C15 commands 段与
  types 段（paramsType/resultType 字段表）+ enums 段（ApprovalDecision /
  CheckCommandDecision / ApprovalChannel / Arbiter），唯一真源
- docs/multi-device/plans/F2-approval-center.md：§11.2 冲突场景表（先到者胜 /
  双端并发 / 已过期 NotFound 收敛）、§4.1 启动对账

**wiring 换用注记（本任务不修改 adapters/）**：`approvalWiring.ts`（既有域，
R2-04 已提交）现持有本地命令构造（buildApproveRequest / buildDenyRequest /
buildListPendingApprovalsRequest，approvalWiring.ts:97-141）与
gatewayListPendingApprovals 网关实现（151-163，复用生成面
parseListPendingApprovalsResult）。本批 approvalCommands.ts 为命令域规范化产物
（统一 kind 映射 + 响应分发 + 对拍门禁），与 wiring 本地信封键集完全等价
（测试 §5 wiring 快照断言）；接线层后续轮次换用本模块统一命令构造面，
本任务不动 adapters/。

---

# R2-12 命令批（部分 2）：mobile_* 8 条新增命令 → 桌面 manifest 登记核对

> 追加日期：2026-08-13（R2-12 部分 2，本文件第 5 批次节）
> 范围：确认 mobile_* 清单（device-protocol.json 真源）→ 去重既有批次 → 核对
> 桌面 manifest 登记状态（command_manifest.rs，只读）→ 产出登记表与缺口清单。
> 移动端核对面：`apps/crish-mobile/src/domain/repositories/` 各域命令文件
> （approvalCommands / filesCommands / sessionCommands / settingsCommands）；
> 横向对拍测试：`mobileCommands.test.ts`（§3 登记表断言 = 本表可测纯函数面）。
> 纪律：**桌面端只读**（不修改任何桌面端代码）；未登记缺口供桌面接线轮处理。

## M-1. mobile_* 8 条清单（真源口径）

真源 `device-protocol.json` commands 段 **tauriCommand 带 mobile\_ 前缀 = 7 条**
（C13/C14/C21/C22/C27/C30/C31）；第 8 条 `mobile_get_workspace_state` 非
tauriCommand 字段值，而是 C19 listWorkspaces 描述文本中的接线名
（device-protocol.json:2658「登记先行 + mobile_get_workspace_state 接线」；
注册表 tauriCommand = workbench_list_workspaces）——R2-07 B6-4.4 清单口径计入，
**合计 8 条**。

| #   | mobile_* 桌面实现名           | 注册表命令           | C 编号 | domain   | registered |
| --- | ----------------------------- | -------------------- | ------ | -------- | ---------- |
| 1   | mobile_list_pending_approvals | listPendingApprovals | C13    | approval | false      |
| 2   | mobile_approval_sync_state    | approvalHistory      | C14    | approval | false      |
| 3   | mobile_get_workspace_state    | listWorkspaces       | C19    | files    | false      |
| 4   | mobile_search_files           | searchFiles          | C21    | files    | false      |
| 5   | mobile_asset_url              | assetUrl             | C22    | files    | false      |
| 6   | mobile_search_sessions        | searchSessions       | C27    | sessions | false      |
| 7   | mobile_settings_confirm       | settingsConfirm      | C30    | settings | false      |
| 8   | mobile_pause_automation       | pauseAutomation      | C31    | settings | false      |

## M-2. 登记表（命令 / 桌面 manifest 登记状态 / 移动端实现状态）

核对结论（只读，command_manifest.rs 全文 124 条 = 注册面 119 + 登记先行 5，条数实测见
command_manifest.rs:283-287 断言——旧稿「128 条」为笔误）：
_\*8 条 mobile_* 桌面面全部未登记（缺失）\**——manifest 无任何 mobile__ 条目
（含登记先行 registered=false 均未落）；移动端侧 8 条**全部已实现**（跨既有批次）。

> ⚠️ **R2-12c 修正（2026-08-13，取代本 M-2 结论）**：本表第 3 行判定**有误**——
> C19 注册表 tauriCommand 真名为 `workbench_list_workspaces`（device-protocol.json:2648），
> 已在 command_manifest.rs:231 **登记**（registered=false 登记先行；实现体
> workspace.rs:393-402 已存在，未挂 invoke_handler——设计内状态，**非缺失**）；
> R2-12b 以「mobile_get_workspace_state」为名搜索造成误判。其余 7 条按真名
> 查确未登记，但「未登记」≠「无承载」：C13/C14 的功能承载面（REST 端点 +
> 引擎命令面 impl）**已实现可用**，C27 为 P2 预留 v1 设计内不实现（注册表
> device-protocol.json:2800 自注）——真实缺口仅 4 条（C21/C22/C30/C31）。
> 逐条承载面核实、修正项清单与真实缺口清单见本文件 **M-6 节**。

| mobile_* 桌面实现名           | 桌面 manifest 登记状态                                                                           | 移动端实现状态                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------ |
| mobile_list_pending_approvals | 缺失（未登记，桌面接线轮缺口）                                                                   | 已实现（B2 批，approvalCommands.ts） |
| mobile_approval_sync_state    | 缺失（未登记，桌面接线轮缺口）                                                                   | 已实现（B2 批，approvalCommands.ts） |
| mobile_get_workspace_state    | 已登记（登记先行，真名 workbench_list_workspaces，command_manifest.rs:231；R2-12c 修正，见 M-6） | 已实现（F4 批，filesCommands.ts）    |
| mobile_search_files           | 缺失（未登记，桌面接线轮缺口）                                                                   | 已实现（F4 批，filesCommands.ts）    |
| mobile_asset_url              | 缺失（未登记，桌面接线轮缺口）                                                                   | 已实现（F4 批，filesCommands.ts）    |
| mobile_search_sessions        | 缺失（未登记，桌面接线轮缺口）                                                                   | 已实现（B4 批，sessionCommands.ts）  |
| mobile_settings_confirm       | 缺失（未登记，桌面接线轮缺口）                                                                   | 已实现（B5 批，settingsCommands.ts） |
| mobile_pause_automation       | 缺失（未登记，桌面接线轮缺口）                                                                   | 已实现（B5 批，settingsCommands.ts） |

## M-3. 缺口清单（桌面接线轮，8 条全部）

> ⚠️ **R2-12c 修正（2026-08-13）**：本清单「8 条全部」判定已被 M-6 节修正——
> 真实缺口仅 4 条（C21/C22/C30/C31）；C13/C14 功能面已由 REST 承载（仅剩
> mobile_* 名登记面收尾）、C19 为登记先行设计内状态、C27 为 P2 预留设计内
> 不实现。下述 1-4 条登记路径要求（X-5）不变，缺口范围以 M-6 为准。

1. 桌面面实现（REST / WS 命令面）须按 Z0 X-5 登记路径**先登记 manifest 再暴露**
   （registered=false 登记先行 → 接线后翻 true，command_manifest.rs 维护规则）；
2. 登记锚点：上表 8 个 `mobile_*` 桌面实现名（family 建议 multi_device /
   engine 契约面；与注册表 tauriCommand 逐字一致）；
3. 桌面对照先例：multi_device_* 面（registered=true）、core_search_files
   （C10 索引就绪面，registered=true）已按 X-5 落地——mobile_* 为后续接线轮
   的同类登记；
4. 语义降级已定（各域批次映射表）：C27 searchSessions v1 无端点（D-11，
   P2 预留）、C30/C31/C32 v1 无端点（D-14）——移动端已按 registered=false
   降级展示，桌面接线不改变协议形状。

## M-4. 判定总则

1. **无新增构造**：8 条 mobile_* 全部由既有批次实现（B2/F4/B4/B5），本批不
   重复构造（反过度设计：不为空集新建 mobileCommands.ts 薄壳）——横向覆盖
   完整性由 `mobileCommands.test.ts` 锁定（注册表新增 mobile_* 命令而未实现
   时测试红）；
2. **桌面面缺失 ≠ 协议面缺失**：注册表 8 条命令完整登记（registered=false 新增
   面），桌面 manifest 缺失是**桌面接线轮缺口**，移动端构造侧先行已就绪；
3. **对照语义不混淆**：core_search_files（C10）与 mobile_search_files（C21）
   为不同命令（索引就绪查询 vs 文件名搜索），manifest 已登记前者不构成后者
   已登记。

## M-5. 证据索引（只读核对引用的代码位置）

- apps/agent-workbench/src-tauri/src/command_manifest.rs：全文（128 条；
  维护规则 10-15、登记先行 §7.2、multi_device_* 100-110、core_search_files 126）
- crates/conex-types/contracts/device-protocol.json：C13/C14/C19/C21/C22/C27/
  C30/C31 commands 段 + types 段（paramsType/resultType 字段表）+ enums 段，
  唯一真源
- apps/crish-mobile/src/domain/repositories/：approvalCommands.ts（C13/C14）、
  filesCommands.ts（C19/C21/C22）、sessionCommands.ts（C27）、
  settingsCommands.ts（C30/C31）、mobileCommands.test.ts（横向对拍）
- docs/multi-device/Z0-master-plan.md：§4.10（C 表 692-712）、R2-12 行（1384）、
  X-5 登记路径（406）

---

# R2-12c：mobile_* 8 条命令桌面承载面核实（M-6 节，修正 R2-12b 判定）

> 追加日期：2026-08-13（R2-12c 承载面核实轮，只读核对，未修改任何代码）
> 背景：R2-12b（本文件 M-1~M-5）以「mobile_get_workspace_state」为名在
> command_manifest.rs 搜索并判「缺失」——但注册表该命令的 tauriCommand 字段
> 真名为 `workbench_list_workspaces`（device-protocol.json:2648），已登记为
> 登记先行（registered=false）——属「登记先行」设计内状态，非缺口。本核实轮
> 改为**按注册表 tauriCommand 字段名逐条重查**，并区分承载面（Tauri invoke
> 面 / 引擎命令面 / REST 端点 / WS kind / 无承载），产出真实缺口清单。
>
> 范围：C13/C14/C19/C21/C22/C27/C30/C31 共 8 条（真源口径与 M-1 一致：
> 7 条 tauriCommand 带 mobile_ 前缀 + C19 真名 workbench_list_workspaces）。

## M-6.1 承载面核实总表（注册表真名口径）

| C#  | 注册表 tauriCommand 真名        | kind（remote.*）     | domain   | manifest 登记（按真名）                                                                                | 设计承载面（M6 §12.4 / 注册表）                                                                                                              | 实际承载面（代码证据）                                                                                                                                                                                                                             | 缺口判定                                                                                        |
| --- | ------------------------------- | -------------------- | -------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| C13 | `mobile_list_pending_approvals` | listPendingApprovals | approval | **未登记**（command_manifest.rs 全文无 mobile_* 条目，128 条 → 实测 124）                              | engine 面；M6 §12.4 sync_projection.rs（events 表派生）；注册表 surface=engine                                                               | **REST GET /v1/approvals/pending 已实现**（router.rs:152/205，handler 470-484）+ 引擎命令面 `list_pending_approvals_impl`（core_run_commands.rs:7296-7329）+ backend 直调接线（core_backend.rs:648-652）；WS kind 不处理（ws.rs:939-947 忽略分支） | **登记面缺口**（mobile_* 名未登记 manifest，X-5 待登记）；**功能承载面已完整可用（REST 直调）** |
| C14 | `mobile_approval_sync_state`    | approvalHistory      | approval | **未登记**                                                                                             | engine 面；M6 §12.4 sync_projection.rs（approval-resolved 投影）                                                                             | **REST GET /v1/approvals/history 已实现**（router.rs:154/206，handler 488-503）+ `approval_history_impl`（core_run_commands.rs:7361-7395）+ backend 接线（core_backend.rs:660-664）；WS 不处理                                                     | **登记面缺口**；**功能承载面已完整可用（REST 直调）**                                           |
| C19 | `workbench_list_workspaces`     | listWorkspaces       | files    | **已登记**（command_manifest.rs:231，registered=false 登记先行；前端快照 commandManifest.ts:219 同步） | gui 面（注册表 surface=gui）；M6 §12.4 mobile_get_workspace_state = workspace.rs 薄壳（M4-2，依赖本命令接线）                                | 实现体 `workbench_list_workspaces` 已存在（workspace.rs:393-402，#[tauri::command] 定义）；**Tauri invoke 未挂**（main.rs command_registry! 无，登记先行语义）；REST 无端点；WS 不处理                                                             | **非缺口（设计内：登记先行）**——R2-12b 误判项；接线轮挂 invoke_handler + 翻 true                |
| C21 | `mobile_search_files`           | searchFiles          | files    | **未登记**                                                                                             | engine 面；M6 §12.4 fuzzy_find 薄壳（M4-3）；注册表「薄壳封装 fuzzy_find，只返回 relPath+kind+size」                                         | **无承载**：无 REST 端点、无 Tauri invoke、WS 不处理、无实现体；注：core_search_files（C10，command_manifest.rs:126，registered=true）为索引就绪查询，**不同命令**（M-4.3 对照语义已述）                                                           | **真实缺口**（桌面接线轮：登记 + 实现）                                                         |
| C22 | `mobile_asset_url`              | assetUrl             | files    | **未登记**                                                                                             | engine 面；M6 §12.4 convertFileSrc 代理（M4-4）；依赖 HTTP 资源代理（开放问题 14.4-4，device-protocol.json:2709 自注「依赖 HTTP 资源代理」） | **无承载**：无 REST 端点、无 Tauri invoke、WS 不处理、无实现体                                                                                                                                                                                     | **真实缺口**（先决：HTTP 资源代理开放问题 14.4-4）                                              |
| C27 | `mobile_search_sessions`        | searchSessions       | sessions | **未登记**                                                                                             | engine 面；M6 §12.4 明确「P2 预留（v2）」；注册表「v1 未注册返回 cmd.unknown，移动端本地过滤兜底」                                           | **无承载（设计内）**：v1 不实现是协议设计（device-protocol.json:2800）；无 REST 端点、无 Tauri invoke、WS 不处理                                                                                                                                   | **非缺口（设计内：P2 预留 v2）**——v1 语义降级已定（R2-07 B4 批 D-11 记录，本文件 :489 行）      |
| C30 | `mobile_settings_confirm`       | settingsConfirm      | settings | **未登记**                                                                                             | engine 面；M6 §12.4 settings_bridge.rs（桌面确认通道；60s 超时拒绝语义）                                                                     | **无承载**：无 REST 端点、无 Tauri invoke、WS 不处理、无实现体                                                                                                                                                                                     | **真实缺口**（桌面接线轮：登记 + 实现）                                                         |
| C31 | `mobile_pause_automation`       | pauseAutomation      | settings | **未登记**                                                                                             | engine 面；M6 §12.4 settings_bridge.rs（一次性指令，重复刷新 pausedUntil）                                                                   | **无承载**：无 REST 端点、无 Tauri invoke、WS 不处理、无实现体                                                                                                                                                                                     | **真实缺口**（桌面接线轮：登记 + 实现）                                                         |

## M-6.2 R2-12b 修正项清单（与既有 M-1~M-5 的差异）

| #   | 修正项                              | R2-12b 旧判定                                          | R2-12c 修正后判定                                                                                                                                                                                    | 证据                                                                               |
| --- | ----------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | C19 登记状态                        | 「缺失（未登记，桌面接线轮缺口）」（M-2 表第 3 行）    | **已登记（登记先行）**：按注册表真名 workbench_list_workspaces 查 manifest 命中 command_manifest.rs:231（registered=false）；实现体 workspace.rs:393-402 存在未挂 invoke_handler——登记先行设计内状态 | device-protocol.json:2648；command_manifest.rs:231；workspace.rs:393-402           |
| 2   | M-2 结论「8 条全部未登记」          | 8 条全部缺失                                           | 7 条 mobile_* 名未登记 + C19 已登记（登记先行）；且 C13/C14 功能面已由 REST 承载、C27 设计内 P2 预留——「未登记」≠「无承载/缺口」                                                                     | 本 M-6.1 表                                                                        |
| 3   | M-2/M-5 条数口径                    | 「全文 128 条 = 注册面 119 + 登记先行 5」              | **124 条 = 119 + 5**（旧稿 128 为笔误；command_manifest.rs:283-287 测试断言 total=124/registered=119/pending=5）                                                                                     | command_manifest.rs:282-288                                                        |
| 4   | M-3 缺口清单范围                    | 缺口清单 8 条全部                                      | **真实缺口 4 条**（C21/C22/C30/C31）+ C13/C14 登记面收尾 + C19 接线翻 true + C27 非缺口（P2 预留）                                                                                                   | 本 M-6.1 表                                                                        |
| 5   | 「桌面面缺失 ≠ 协议面缺失」结论细化 | 桌面 manifest 缺失即缺口                               | C13/C14 的实际承载面（REST /v1/approvals/* + 引擎 impl）已实现可用——移动端经 REST 即可消费，缺口仅限 mobile_* 名登记面（X-5 路径要求）                                                               | router.rs:152/154/205/206；core_backend.rs:648-664；core_run_commands.rs:7296/7361 |
| 6   | 搜索口径错误根因                    | 以「mobile_get_workspace_state」为名搜 manifest 判缺失 | 该名不是注册表 tauriCommand 字段值（只是 C19 描述文本中的接线名，device-protocol.json:2658）；**须按 tauriCommand 字段名搜索**                                                                       | device-protocol.json:2648/2658                                                     |

## M-6.3 真实缺口清单（桌面接线轮，按优先序）

1. **C21 mobile_search_files**：command_manifest.rs 登记（registered=false 登记先行 → 实现后翻 true）+ 实现（fuzzy_find 薄壳，复用 conex-search）+ REST 端点（如需移动端 REST 直调）。
2. **C30 mobile_settings_confirm**：登记 + 实现（settings_bridge 桌面确认通道：withdraw 幂等、60s 超时拒绝语义——M6 T-M6-14 锚点）。
3. **C31 mobile_pause_automation**：登记 + 实现（settings_bridge 一次性指令，msgId 幂等）。
4. **C22 mobile_asset_url**：登记 + 实现（convertFileSrc 代理）——**先决**：HTTP 资源代理（F4 §5.4 / 开放问题 14.4-4，device-protocol.json:2709 自注依赖），网络域评审后再接线。
5. **C13/C14 登记面收尾**：功能承载面（REST）已可用，仅需按 X-5 把 mobile_* 名登记进 command_manifest.rs（registered=false 登记先行）——若移动端全走 REST 直调，登记仅为协议对齐收尾，不阻塞功能。
6. **C19 workbench_list_workspaces 接线**：挂入 main.rs command_registry! + manifest 翻 true（登记先行语义完成）；M6 §12.4 的 mobile_get_workspace_state 薄壳（M4-2）是否新建由接线轮按反过度设计红线评估（复用本命令即可）。

**非缺口（不需接线）**：C27 mobile_search_sessions（P2 预留 v2，v1 移动端本地过滤兜底）。

## M-6.4 判定总则（R2-12c）

1. **真名口径**：所有桌面面查询一律以注册表 tauriCommand 字段值（真名）为键，
   不以文档描述名/移动端命令名为键——R2-12b 误判根因即混用描述名搜索。
2. **登记先行语义**：manifest registered=false = 已登记未接线（设计内状态），
   非缺口；接线轮挂 invoke_handler 后翻 true（X-5 登记路径的唯一出口）。
3. **承载面分级**：移动端消费面 = REST（网关直调面，router.rs 路由表）+ WS
   kind（当前仅 events/pair/heartbeat，remote.* 全部忽略分支 ws.rs:939-947）；
   桌面 GUI 消费面 = Tauri invoke（main.rs command_registry!）。mobile_* 命令
   的「缺失」判定须三面分别确认：manifest 登记（已查）+ invoke_handler 挂载
   （已查）+ REST 端点（已查）——任一存在即算有承载。
4. **白名单 vs 路由**：remote_whitelist.rs 已含 8 条 kind（listPendingApprovals:78 /
   approvalHistory:79 / listWorkspaces:85 / searchFiles:87 / assetUrl:88 /
   searchSessions:94 / settingsConfirm:98 / pauseAutomation:99，共 32 条 C01-C32
   冻结）——白名单面已齐（设计在），缺口在路由/实现面，接线轮只需补端点与
   实现，无需动白名单。

## M-6.5 证据索引（R2-12c 只读核对引用）

- crates/conex-types/contracts/device-protocol.json：C13（:2533）、C14（:2550）、
  C19（:2648，tauriCommand=workbench_list_workspaces；:2658 描述含
  mobile_get_workspace_state 接线名）、C21（:2682）、C22（:2699）、C27（:2790，
  :2800 P2 预留自注）、C30（:2846）、C31（:2863）——tauriCommand 真名/kind/
  surface/registered=false 全量
- apps/agent-workbench/src-tauri/src/command_manifest.rs：全文（124 条 =
  119 + 5，测试断言 282-288）；workbench_list_workspaces 登记先行（:231）；
  _*无任何 mobile_* 条目_*（全文检索）
- apps/agent-workbench/src-tauri/src/main.rs：command_registry!（139-303）——
  无 mobile_*、无 workbench_list_workspaces（登记先行不挂 invoke_handler）
- apps/agent-workbench/src-tauri/src/workspace.rs：workbench_list_workspaces
  实现体（393-402，#[tauri::command] 定义 + #[allow(dead_code)] 待接线）
- apps/agent-workbench/src-tauri/src/server/router.rs：路由表（176-217，22 端点；
  无 workspaces/search_files/asset_url/settings_confirm/pause_automation 端点）；
  C13/C14 端点常量（:152/:154）+ 注册（:205/:206）+ handler（470-503）；
  handle_not_found（581-598，未注册路径 → 404 cmd.not_found / secret → 403）
- apps/agent-workbench/src-tauri/src/server/ws.rs：kind 分发 match（920-948）——
  remote.* 全部落入 `_ =>` 忽略分支（939-947，R1-05 范围外宽容忽略）
- apps/agent-workbench/src-tauri/src/server/remote_whitelist.rs：32 条白名单
  （63-101；8 条 mobile_* kind 全部在列 78-99）
- apps/agent-workbench/src-tauri/src/server/core_backend.rs：list_pending_approvals
  （648-652）、approval_history（660-664）——REST 直调接线
- apps/agent-workbench/src-tauri/src/core_run_commands.rs：list_pending_approvals_impl
  （7296-7329）、approval_history_impl（7361-7395）——引擎命令面实现
- apps/agent-workbench/src-tauri/src/server/backend.rs：ApiBackend 契约
  list_pending_approvals/approval_history（180-199，缺省未接线 internal）
- apps/crish-desktop/src/api/transport/commandManifest.ts：前端快照
  workbench_list_workspaces（:219，registered=false）——双端镜像一致
- docs/multi-device/plans/M6-protocol-messages.md：§12.4 桌面壳侧新增接线清单
  （2686-2714，mobile_* 各命令实现位置与依赖）
- docs/multi-device/Z0-master-plan.md：§3.4 X-5 登记路径（:406）、§4.10 C 表
  （690-714，C13/C14/C19/C21/C22/C27/C30/C31 行）、R2-12 行（:1384）

_2026-08-13 R2-12c 承载面核实完成 · 修正 R2-12b M-2/M-3 判定 · 真实缺口 4 条 + C13/C14 登记面收尾 + C19 接线翻 true_
