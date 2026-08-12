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
4. _*mobile_* 8 条新增_*：`mobile_list_pending_approvals` / `mobile_approval_sync_state` / `mobile_get_workspace_state` / `mobile_search_files` / `mobile_asset_url` / `mobile_settings_confirm` / `mobile_pause_automation` / `mobile_search_sessions` 属各自功能域批次（approval/files/settings/sessions），不在本 B6 设备域批范围（R2-12 为「部分」——本批仅设备域 5 条 + queryPresence 归属裁定）。
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
