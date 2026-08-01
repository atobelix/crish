# 21 — Phase C 杂项 RPC 迁移日志（C1.5）

> 状态：已建立（Round 3 / C1.5 执行轮）
> 依据：20-phase-c-tasks.md C1.5（76-83 行）、03-frontend-contract.md §3.2 C / §3.3
> 范围：clientApi / engineStatus / engineConfig / gitApi / mcpApi / modelCatalog /
> rulesApi / skillsApi / subagentApi / sessionDaemonSync / conversationRewindApi /
> schedule / SessionSyncService / workflowRunner 共 **38 处** daemonClient.request 调用点。
> 迁移通道：`apps/crish-desktop/src/api/transport/commandMap.ts`（集中映射表，
> 消息 type → 命令名）；TauriTransport 经 `resolveTauriCommand` 分派，
> DaemonWsTransport 经 `resolveWsType`/`deriveWsExpectedType` 分派回旧协议。

## 一、调用点迁移清单（文件:行号 + WS 消息 type + 分类）

| # | 文件:行号 | WS type | 期望响应（WS） | 分类 | Tauri 命令 | 处置 |
|---|---|---|---|---|---|---|
| 1 | clientApi.ts:848 | list-workflows | workflows-listed | ③ | — | 需 Rust 侧回补（Tauri 路径降级空表） |
| 2 | clientApi.ts:863 | create-workflow | workflow-created | ③ | — | 需 Rust 侧回补 |
| 3 | clientApi.ts:873 | delete-workflow | workflow-deleted | ③ | — | 需 Rust 侧回补 |
| 4 | clientApi.ts:887 | list-mcp-servers | mcp-servers-listed | ② | workbench_list_mcp_servers | 已迁移（Tauri 返回裸数组，调用点兼容） |
| 5 | clientApi.ts:902 | start-mcp-server | mcp-server-started | ② | workbench_start_mcp_server | 已迁移 |
| 6 | clientApi.ts:912 | stop-mcp-server | mcp-server-stopped | ② | workbench_stop_mcp_server | 已迁移 |
| 7 | engineStatus.ts:52 | get-status | status-response | ①（形状缺口） | core_get_status | 已迁移（③ 字段缺口见下） |
| 8 | engineConfig.ts:516 | get-status | status-response | ①（形状缺口） | core_get_status | 已迁移（③ 字段缺口见下） |
| 9 | engineConfig.ts:567 | update-config | config-updated | ② | update_daemon_config | 已迁移（payload 剥离 type） |
| 10 | gitApi.ts:459 | git-status | git-status-response | ② | workbench_git_status | 已迁移 |
| 11 | gitApi.ts:520 | git-diff | git-diff-response | ② | workbench_git_diff | 已迁移 |
| 12 | mcpApi.ts:229 | list-capabilities | capabilities-response | ③ | — | 需 Rust 侧回补（Tauri 路径降级 null） |
| 13 | mcpApi.ts:262 | get-status | status-response | ①（形状缺口） | core_get_status | 已迁移（mcpStatus 缺口见下） |
| 14 | mcpApi.ts:306 | list-mcp-servers | mcp-servers-listed | ② | workbench_list_mcp_servers | 已迁移（裸数组兼容） |
| 15 | mcpApi.ts:433 | start-mcp-server | mcp-server-started | ② | workbench_start_mcp_server | 已迁移 |
| 16 | mcpApi.ts:488 | stop-mcp-server | mcp-server-stopped | ② | workbench_stop_mcp_server | 已迁移 |
| 17 | modelCatalog.ts:706 | probe-provider-models | provider-models-probed | ③ | — | 需 Rust 侧回补（Tauri 路径走 HTTP 直连兜底） |
| 18 | modelCatalog.ts:843 | probe-provider-chat | provider-chat-probed | ③ | — | 需 Rust 侧回补（同上） |
| 19 | rulesApi.ts:50 | delete-scoped-context | scoped-context-deleted | ③ | — | 需 Rust 侧回补（Tauri 路径降级 daemonSynced=false） |
| 20 | rulesApi.ts:60 | upsert-scoped-context | scoped-context-upserted | ③ | — | 需 Rust 侧回补 |
| 21 | skillsApi.ts:547 | delete-scoped-context | scoped-context-deleted | ③ | — | 需 Rust 侧回补 |
| 22 | skillsApi.ts:554 | upsert-scoped-context | scoped-context-upserted | ③ | — | 需 Rust 侧回补 |
| 23 | subagentApi.ts:34 | send-to-subagent | subagent-message-sent / error | ② | workbench_send_to_subagent | 已迁移 |
| 24 | subagentApi.ts:58 | get-subagent-status | subagent-status / error | ② | workbench_get_subagent_status | 已迁移 |
| 25 | sessionDaemonSync.ts:260 | list-sessions | sessions-listed | ② | list_sessions（壳本地命令） | 已迁移（返回裸数组，调用点兼容） |
| 26 | conversationRewindApi.ts:42 | preview-conversation-rewind | conversation-rewind-preview | ② | workbench_preview_conversation_rewind | 已迁移（payload 整形 {request}） |
| 27 | conversationRewindApi.ts:75 | apply-conversation-rewind | conversation-rewind-applied | ② | workbench_apply_conversation_rewind | 已迁移（payload 整形 {request}） |
| 28 | schedule.ts:26 | cron.list_tasks | cron.list_tasks_response | ③ | — | 需 Rust 侧回补（Tauri 路径降级空表） |
| 29 | schedule.ts:42 | cron.upsert_task | cron.upsert_task_response | ③ | — | 需 Rust 侧回补 |
| 30 | schedule.ts:53 | cron.delete_task | cron.delete_task_response | ③ | — | 需 Rust 侧回补 |
| 31 | SessionSyncService.ts:182 | sync-pull | sync-pulled | ③ | — | 需 Rust 侧回补（Tauri 路径触发 pullUnsupported 停表） |
| 32 | SessionSyncService.ts:182 | sync-push | sync-pushed | ③ | — | 需 Rust 侧回补 |
| 33 | workflowRunner.ts:40 | list-workflows | workflows-listed | ③ | — | 需 Rust 侧回补（Tauri 路径降级空表） |
| 34 | workflowRunner.ts:77 | create-workflow | workflow-created | ③ | — | 需 Rust 侧回补 |
| 35 | workflowRunner.ts:108 | update-workflow | workflow-updated | ③ | — | 需 Rust 侧回补 |
| 36 | workflowRunner.ts:129 | delete-workflow | workflow-deleted | ③ | — | 需 Rust 侧回补 |
| 37 | workflowRunner.ts:152 | trigger-workflow | workflow-triggered | ③ | — | 需 Rust 侧回补 |
| 38 | workflowRunner.ts:205 | list-workflow-runs | workflow-runs-listed | ③ | — | 需 Rust 侧回补 |

分类统计：① 3 处（get-status ×3，均为形状缺口）、② 13 处、③ 22 处。
③ 类 22 处均为「需 Rust 侧回补」：WS 路径经 transport 分派行为不变；
Tauri 路径抛「Tauri command not available」并由各调用点既有 catch/兜底降级
（空表 / HTTP 直连 / daemonSynced=false / pullUnsupported），无崩溃路径。

## 二、③ 类未覆盖项（需 Rust 侧回补，回补落点 B6.2）

| WS type | 语义 | 建议命令名 | 前端降级行为（Tauri 路径） |
|---|---|---|---|
| list-workflows / create-workflow / delete-workflow | workflow 增删查 | core_list_workflows / core_create_workflow / core_delete_workflow | 空表 + console.error |
| update-workflow / trigger-workflow / list-workflow-runs | workflow 更新/触发/历史 | core_update_workflow / core_trigger_workflow / core_list_workflow_runs | 空表 / {ok:false} |
| list-capabilities | 能力快照（mcp.lifecycle） | core_get_capabilities（或并入 core_get_status） | probeMcpControl 降级 canStartStop=true |
| probe-provider-models / probe-provider-chat | /models 探测 / chat 连通测试 | core_probe_provider_models / core_probe_provider_chat | 自动走 HTTP 直连兜底 |
| upsert-scoped-context / delete-scoped-context | 规则/技能 scoped-context 同步 | core_upsert_scoped_context / core_delete_scoped_context | daemonSynced=false（本机仍保存） |
| cron.list_tasks / cron.upsert_task / cron.delete_task | 定时任务 | core_list_cron_tasks / core_upsert_cron_task / core_delete_cron_task | 空表（调度功能不可用） |
| sync-pull / sync-push | 会话增量同步 | core_session_sync_pull / core_session_sync_push | pullUnsupported 停表（本地-only 同步） |

**get-status 形状缺口（① 但字段不齐）**：`core_get_status`（core_query_commands.rs
CoreStatus）仅返回 initialized/version/engine_ready/search_index_ready/db_ready/
compaction_ready，**缺** `activeRuns` / `pendingApprovals` / `mcpStatus` /
`providerStatus`（旧 WS status-response 全量字段，见
packages/agent-daemon/src/types/protocol-outbound-diagnostic.ts:9-24）。
前端消费点：engineStatus.ts:58-86（H2 运行条）、engineConfig.ts:402-456
（parseEngineStatusFromRaw）、mcpApi.ts:262-277（fetchMcpStatus）。
Tauri 路径当前降级：activeRuns/pendingApprovals 为空数组、model/baseUrl 为空、
mcpStatus 缺失 → {configured:false}。**回补**：core_get_status 扩展上述字段
（RunManager 已有活动 run 注册表，可直取）。

## 三、② 类形状适配记录（Tauri 路径与 WS 路径返回差异）

| WS type | Tauri 返回 | 调用点适配 |
|---|---|---|
| list-mcp-servers | workbench_list_mcp_servers 返回**裸数组**（run_commands.rs:160-178） | clientApi.ts:891 / mcpApi.ts:306 兼容 `Array.isArray(res) ? res : res.servers` |
| list-sessions | list_sessions 返回裸 `Vec<SessionIndexEntry>`（session_commands.rs:74） | sessionDaemonSync.ts:264 兼容数组 / {sessions} |
| preview/apply-conversation-rewind | 壳命令要求单一 `request` 参数（action_commands.rs:133-160） | commandMap shapeTauriPayload 整形为 `{request: payload}` |
| update-config | update_daemon_config 不接受 type 字段 | commandMap 剥离 type；响应为配置快照（调用点忽略） |

## 四、验证记录

- `npm run typecheck`：C1.5 涉及文件零错误（残留 11 处错误均为既有
  shared-types CrishError 重构半成品所致，与本次改动无关：error-payload-guard.ts /
  error-translation.ts / perfBenchmark.ts / FileViewerCard.tsx / useSidebarContextMenu.ts）。
- `npx vitest run src/api src/services`：2388 用例，2384 通过；4 失败均为
  adversarial「暴露 bug」套件（oklchColorGuard ×3 稳定失败为文档化已知 bug；
  applyFileDiff 属性测试种子相关，单独运行通过），与 C1.5 无关。
- 新增 commandMap.test.ts（14 用例）覆盖：映射/反查/③ 类 null/期望响应推导/payload 整形。
- 更新 mcpApi.test.ts / schedule.test.ts / skillsApi.test.ts 为 mock `./transport`。
- 残留 grep：生产代码 `daemonClient.request` 仅 1 处注释（daemonWsTransport.ts:69，
  WS transport 内部）——验收达标。

---

## 五、C2.5 hydrate 与稳定 id 对齐——Rust 回补单（clientMessageId 透传缺口）

> 状态：已建立（C2.5 执行轮）
> 依据：20-phase-c-tasks.md C2.5（125-132 行）、03-frontend-contract.md §1.8 / §5.3-4
> 核对结论：**前端下发链路完整，Rust 侧 message-end 未透传 clientMessageId（缺口确认）**；
> 前端已做兜底（见下「前端兜底」），Rust 回补后兜底自然失效，行为无冲突。

### 5.1 核对结论（两端一致性）

| 链路环节 | 位置 | 结论 |
|---|---|---|
| 前端生成 user clientMessageId | useSlashSend.ts:317/386、useChatHandlers.ts:214（`clientMessageId: userMsgId`） | ✓ |
| 前端生成 assistant clientMessageId | useStreamCallbacks.ts:261（`streamOptions?.assistantClientMessageId \|\| assistantMsgId`） | ✓ |
| run-task 下发（WS 路径） | ConnectionLifecycle.ts:410-413（`clientMessageId` + `assistantClientMessageId`） | ✓ |
| run-task 接收（Tauri `core_run_task`） | core_run_commands.rs:673（**仅声明 `client_message_id`，缺 `assistant_client_message_id`**）、:685（`let _ = (mode, permission_mode, client_message_id);` 丢弃） | ✗ 缺口 1 |
| 用户消息 clientMessageId | apps/agent-workbench/src-tauri/src/engine.rs:459 `user_message`（硬编码 `client_message_id: None`） | ✗ 缺口 2 |
| 助手消息 clientMessageId | crates/session-loop/src/loop/handlers/streaming.rs:218 `build_assistant_message`（硬编码 `client_message_id: None`） | ✗ 缺口 3 |
| message-end 透传 | AgentMessage.client_message_id（conex-types/src/message.rs:45）结构就绪但恒空 | ✗ 确认缺口 |
| pickStableMessageId 三字段 | message-identity.ts:142-163（clientMessageId / messageId / id + metadata 嵌套） | ✓ |
| hydrate maxSequence/lastRunId | sessionEventHydrate.ts（顶层 sequence/runId + payload.runId 兜底，双路径一致） | ✓ |

### 5.2 Rust 回补落点（回补时按 03 §5.3-4 执行）

1. `core_run_task`（core_run_commands.rs:665-711）：
   - 参数表补 `assistant_client_message_id: Option<String>`；
   - 透传 `client_message_id` 与 `assistant_client_message_id` 到 `SessionLoopProducer`（engine.rs:395-421 增参）。
2. `user_message`（engine.rs:449-462）：`client_message_id` 填 run-task 下发的 user id。
3. `build_assistant_message`（session-loop/src/loop/handlers/streaming.rs:178-221）：
   `client_message_id` 填 run-task 下发的 assistant id（经 RunProducer/输入携带）。
4. 验收：`message-end.message.clientMessageId` 与 run-task 下发 id 一致（03 §5.3-4）；
   30-verification-checklist.md:82 的「一致」结论在回补后变为事实成立。

### 5.3 前端兜底（回补前过渡，sessionEventHydrate.ts）

- `hydrateSessionMessagesFromDaemon(sessionId, { fallbackIds })`：fallbackIds 由本地
  乐观消息构造（`buildHydrateIdFallbacks`，sessionCrudActions.ts:197 调用点传入）——
  本地消息 id 即 run-task 下发过的 clientMessageId。
- `projectEventsToMessages` 中 message-end 无稳定 id 时，按**角色 + 文本**匹配
  fallbackIds（多轮同文本按序消费，角色不混配），命中即用本地 id，
  与热路径 stream final 同 id merge 不双气泡。
- Tauri 摊平信封（core_read_session_events 返回 `{type, runId, sequence, ...}`，
  非 runtime-event 包裹）下 `agentEventFromOrchestrator` 按 type 前缀放行
  message-*/tool-*；`fetchSessionEvents` 已换 transport（C1.4 依赖落地），
  参数名按 transport 分派（WS `maxEvents` / Tauri `limit`）。

### 5.4 C2.5 验证记录

- `npx vitest run src/api/sessionEventHydrate.test.ts --coverage.enabled=false`：
  32 用例全过（新增：messageId 三字段兼容、摊平信封投影、广播 vs hydrate
  maxSequence/lastRunId 一致、fallbackIds 兜底 6 项、run 级事件不投影）。

## 六、遗留失败清单（C4.6 前端全量验证）

> 验证时间：C4.6 轮。命令：`npx vitest run src`（213 文件 / 3679 用例）、
> `npm run typecheck`、`npx vite build`。结论：**transport 切换零回归**——
> 全部失败项均为基线既有（相关文件在本轮切换 diff 中均未修改，可复现于 HEAD）。

### 6.1 vitest 失败（40 项，全部基线，与 transport 切换无关）

| 文件 | 测试名 | 数量 | 原因 | 是否基线 |
|---|---|---|---|---|
| src/api/oklchColorGuard.adversarial.test.ts | parseColorToOklch — hex 解析「8 位 hex 丢弃 alpha」 | 1 | 已知颜色解析 bug（8 位 #RRGGBBAA 产生 NaN） | 基线 |
| src/api/oklchColorGuard.adversarial.test.ts | parseColorToOklch — HSL 解析「现代 slash alpha 语法不匹配」 | 1 | 已知颜色解析 bug（hsl(.../50%) 被当新颜色解析） | 基线 |
| src/api/oklchColorGuard.adversarial.test.ts | getContrastGuardedText — 对比度阈值「阈值附近选择敏感」 | 1 | 已知对比度阈值 bug（#bebebe 应取深色文字却取浅色） | 基线 |
| src/components/chat-image/ImageGallery.test.tsx | isImageProducingTool（11 真值 + 7 假值用例） | 18 | 测试导入 `isImageProducingTool`，`src/api/toolFeedback.ts` 无此导出（HEAD 即无） | 基线 |
| src/components/chat-image/ImageGallery.test.tsx | resolveToolImages（9 用例） | 9 | 测试导入 `resolveToolImages`，`src/api/toolFeedback.ts` 无此导出（HEAD 即无） | 基线 |
| src/components/chat-image/ImageGallery.test.tsx | sanitizeSvgContent（10 用例） | 10 | 测试导入 `sanitizeSvgContent`，`src/api/markdown-render/markdownSanitizer.ts` 无此导出（HEAD 即无） | 基线 |
| src/store/workspace-shell/multiUnitDock.test.ts | openToolInSession(A) 不改 B 的 rightDock | 1 | `syncShellDocksFromTree`（layoutRestorePolicy.ts:137）在任一树变化时对所有 session 重推 dock；B 的 unit 尚未投影工具区（chat-only）→ 被重置为默认。openTool 与树同步回调的设计冲突 | 基线 |
| src/store/workspace-shell/openTool.test.ts | does not mutate neighbor when opening on active session | 1 | 同上（同根因） | 基线 |

说明：
- 以上 40 项所在源码/测试文件在本轮 `git status` diff 中**零改动**（可 `git diff HEAD` 复核），
  失败逻辑与 daemonClient → Tauri IPC transport 切换无任何依赖关系，判定基线。
- ImageGallery 37 项为「测试引用不存在的导出」（Round 6 计划的功能未落地），
  属功能缺口而非回归；修复需实现 isImageProducingTool / resolveToolImages / sanitizeSvgContent，
  超出「小修」范围，留待后续功能轮。
- 两个 workspace-shell 失败为 `syncShellDocksFromTree` 树→shell 同步语义问题，
  改动会波及 adapterShape / layoutRestorePolicy 系列既有绿测（unitTabPlacement /
  conversationUnitBinding / layoutRestorePolicy 等），不做冒险小修，留待架构轮。

### 6.2 已修复的 flaky（本轮顺手小修，非遗留）

- src/api/applyFileDiff.adversarial.test.ts「apply 后再分析应返回 already_applied」：
  fast-check 种子依赖 flaky。根因：`newStr` 包含 `oldStr` 时（反例 `" "`→`"  "`），
  替换后 oldStr 仍存在，二次分析合法返回 ambiguous，属性假设不成立。
  修复：谓词内 `fc.pre(!newStr.includes(oldStr))` 过滤该类输入对（测试侧小修）。
- src/api/applyFileDiff.adversarial.test.ts「规范化幂等」：
  fast-check 种子依赖 flaky。根因：`normalizeApplyPath` 去尾斜杠后残留尾随空白
  （反例 `"! /"` 一次 → `"! "`，二次 → `"!"`），不满足幂等契约。
  修复：applyFileDiff.ts:78 改为剥尾部 `[\/\s]+`（`p.length > 1` 时），
  保留单个 `/` 绝对根语义；`isSafeApplyPath` 中间段校验行为不受影响。
- src/api/sessionTitle.property.test.ts ST-P1「sanitize 幂等」：
  fast-check 种子依赖 flaky。根因：sanitize 的顺序清洗（slash → 标题符 → 列表符 →
  引号/句末标点）可能互相暴露新的首尾噪声（反例 `"*/#"` 剥 `*` 后变 `/#`，
  第二次才被当 slash 剥掉），而稳定化循环只覆盖引号/标点，未覆盖前缀剥离；
  列表符正则不吸收连续标记（`*****` 需多轮）。
  修复：sessionTitle.ts `sanitizeSessionTitleText` 将 slash/标题符/列表符并入
  稳定化循环（轮数上限 4 → 8），列表符正则改为 `(?:...)+` 吸收连续重复标记；
  每次迭代要么 break 要么严格变短，终止性有界。
- src/api/sessionTitle.property.test.ts ST-P6「无冲突时结果 === base.trim()」：
  fast-check 种子依赖 flaky。根因：属性断言与文档契约矛盾——空白 base 依契约
  （sessionTitle.ts:404-406）回落 `EMPTY_SESSION_TITLE`（`" "` → `"新会话"`），
  并非 `base.trim()`（`""`），反例 `[" "]`。
  修复：断言改为 `result === base.trim() || EMPTY_SESSION_TITLE`（测试侧小修）。
- 验证：两处修复后 applyFileDiff / sessionTitle 全部套件连续 15+ 轮全过；
  全量 213 文件 3679 用例（无 coverage）稳定为 40 失败，不再出现以上 flaky 项。
  注：带 coverage 插桩跑分会额外触发 `MessageVirtualizer` 的
  FPS 帧预算性能断言（<16ms/frame）失败——v8 插桩开销所致，无 coverage 时通过，
  属环境性 flaky，与 transport 切换无关。

### 6.3 typecheck（tsc -b）残余 6 错误，全部基线

| 位置 | 错误 | 判定 |
|---|---|---|
| src/api/markdown-render/perfBenchmark.ts:25 | `workspaceFsApi` 无导出 `assetUrlCache` | 基线（两文件均未改） |
| src/components/FileViewerCard.tsx:110 | `SessionState` 无 `workspacePath` 属性 | 基线（store/types.ts 未改） |
| src/components/FileViewerCard.tsx:184 / 187 | `string \| undefined` 不可赋给 `string` | 基线（同上，手写类型与调用不匹配） |
| src/components/sidebar/useSidebarContextMenu.ts:215 | `compositionRoot.SessionFacade` 无 `deleteSession` | 基线（compositionRoot.ts 手写门面接口未含 deleteSession） |

以上 6 错误在 HEAD（切换前）即可复现：涉及文件与引用模块（workspaceFsApi /
store/types.ts / compositionRoot.ts / sessionActions.ts）在本轮 diff 中均零改动。

### 6.4 生产构建

- `npm run build`（= `tsc -b && vite build`）：**tsc 阶段被 6.3 的 6 个基线错误阻断**，
  与 transport 切换无关。
- `npx vite build`：**成功**（11.39s，产出 dist/ 129 文件，
  含 daemon-bridge 分包 325.78 kB / gzip 96.01 kB，transport 代码正常打包）。

