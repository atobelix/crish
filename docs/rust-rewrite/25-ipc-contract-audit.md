# 25 — 前后端启动状态逻辑与 IPC 接口面审计

> 性质：只读研究（无代码改动）。日期：2026-08-01。
> 范围：apps/crish-desktop/src（前端）+ apps/agent-workbench/src-tauri/src（Rust IPC 壳）。
> 背景：用户反馈「启动就显示本地引擎待同步到密钥，明显是不适配现在的逻辑」——
> 系统已从 WS daemon 切换为 Tauri IPC 进程内引擎（C4.4）。后续要做 TUI，
> 需要前后端接口收束、后端适配 web/gui/tui。

---

## 一、「本地密钥待同步到引擎」问题根因

### 1.1 文案来源（唯一出处）

| 文件:行号 | 内容 |
|---|---|
| apps/crish-desktop/src/components/ChatStatusRibbons.tsx:290 | `'本地密钥待同步到引擎'`（空态短句） |
| apps/crish-desktop/src/components/ChatStatusRibbons.tsx:291 | `'本地已有密钥，点击下方模型名称同步到引擎'`（非空态） |
| apps/crish-desktop/src/components/ChatStatusRibbons.tsx:110 | 优先级注释：`密钥 → 模型 → 本地密钥待同步` |
| apps/crish-desktop/src/components/ChatStatusRibbons.tsx:149-155 | 触发条件：`engineOk===true && engineHasApiKey===false && localHasKey===true` → `'sync-engine'` |
| apps/crish-desktop/src/components/ChatStatusRibbons.tsx:310-311 | 动作按钮「选择模型」 |

`resolveSetupHintKind`（ChatStatusRibbons.tsx:116-157）是**唯一**出口：四种互斥 soft-hint
（engine-down / needs-key / needs-model / sync-engine），`sync-engine` 只在上述三条件同时成立时出现。
测试文件 ChatStatusRibbons.setupHint.test.ts:174-184 固化了该行为（「sync-engine only when engine ok,
engine key missing, local has key」）。

### 1.2 状态链（谁驱动它）

```
ChatStatusRibbons.tsx:487-494  resolveSetupHintKind({ needsKeySetup, needsModelSetup, engineOk, engineHasApiKey, localHasKey })
  ├─ engineOk / engineHasApiKey ← engineHint（组件 props，ChatStatusRibbons.tsx:40,393）
  │     └─ engineHint ← useChatCardState.ts:180-186 getProviderSetupStatus({ engineOk: engineHint.ok, engineHasApiKey: engineHint.hasApiKey, engineModel })
  │           └─ engineHint ← useModelSelection（components/chat-card/ChatHeaderControls.tsx:34-96）
  │                 └─ useState<EngineStatus|null>(null)，ChatHeaderControls.tsx:61 fetchEngineStatus().then(setEngineHint)
  │                       └─ fetchEngineStatus（api/engineConfig.ts:498-534）
  │                             ├─ transport.waitUntilConnected(12_000) → core_get_status 轮询（engineReady/dbReady）
  │                             └─ transport.request('get-status') → core_get_status
  │                                   └─ parseEngineStatusFromRaw(res)（engineConfig.ts:402-456）
  │                                         └─ hasApiKey ← provider.apiKey.hasApiKey ?? src.hasApiKey ?? Boolean(root.hasApiKey) —— 全缺失时 = false
  └─ localHasKey ← needsKeySetup 上游 getProviderSetupStatus（api/provider-profiles/profileStore.ts:217-247）
        └─ anyProfileHasKey()（profileStore.ts:193-195）→ localStorage crish_provider_profiles_v1（明文 apiKey 在 profile 内）
```

**关键事实（双缺口叠加，恒真条件）：**

1. **Rust `core_get_status` 返回结构不含 provider/apiKey/model/baseUrl**：
   - core_query_commands.rs:49-62 `CoreStatus` 仅 `initialized / version / engineReady / searchIndexReady / dbReady / compactionReady`；
   - 该缺口已被 21-phase-c-migration-log.md:72-81 文档化（①②形状缺口：「需 Rust 侧回补」），前端 engineConfig.ts:507-509 注释亦自认「core_get_status 暂缺 provider/model/baseUrl 等字段，Tauri 路径 model/baseUrl 为空」。
2. **前端 `parseEngineStatusFromRaw` 字段缺失时把 `hasApiKey` 缺省为 `false`**（engineConfig.ts:424-429）：
   - `provider`/`apiKey` 嵌套均取不到 → `hasApiKey = false` 恒成立；
   - 于是「引擎已通(ok:true) + 引擎侧无 key(hasApiKey:false) + 本地有 key(localHasKey:true)」三条件在**每次启动、每个已配 key 用户**上都成立 → sync-engine 恒展示。
3. **双配置真源 + 过期同步心智**：
   - 前端真源：localStorage `crish_provider_profiles_v1`（profileStore.ts:30，**明文 apiKey**）；
   - Rust 真源：`ApiConfigStore`（provider-config.json + provider-direct-key.dpapi，config/persistence.rs:11-14）+ profile 密钥 sidecar（secrets/{id}.dpapi，config/mod.rs:68-144）；
   - 前端启动即 `syncActiveProfileToEngine()`（AppBootstrap.ts:300-304 / useEngineBootstrap.ts:38-40）→ `updateEngineConfig` → `update_daemon_config`，把 localStorage key **推**进 Rust store（profileStore.ts:565-602）——这是 WS daemon 时代「本地 → 推送 daemon」的遗留；
   - **即使推送成功，core_get_status 仍不回报 hasApiKey → 提示永不消失**。用户观感即「不适配现在逻辑」。

### 1.3 为什么「现在还会出现」（结论）

- 引擎已进程内（main.rs:203「引擎为进程内直调，启动不拉起任何 daemon（C4.4）」），不存在「本地 vs 引擎」两份配置的物理基础，但前端 UI 状态机仍按双存储模型工作；
- `core_get_status` 的 provider 字段回补（21-phase-c-migration-log ①②）**未落地**，前端缺省 false 掩盖了「未知」与「确实无 key」的区别；
- 前端从未调用 Rust 配置读命令（grep `get_api_config|save_api_config|workbench_profile_secret_*` 在 crish-desktop/src **零命中**）——Rust 侧配置命令全是死面。

---

## 二、启动状态机现状

### 2.1 时序总览

```
应用启动
 ├─ AppBootstrap.ts effect3 (147-154)    transport.isReady() 快照 → setEngineReady(true)          [早置 true]
 ├─ AppBootstrap.ts effect7 (279-331)    initEngine()
 │    ├─ transport.isReady() 快照 → setEngineReady(true)
 │    ├─ transport.onStatus('connected') → setEngineReady(true)          [订阅]
 │    ├─ ensureDaemonConnected()（daemon-chat-bridge/ConnectionLifecycle.ts:47-70）
 │    │     = transport.waitUntilConnected(20s) + request('get-status')
 │    │        ├─ ok → setEngineReady(true) + syncActiveProfileToEngine() + syncSessionsFromDaemon()
 │    │        └─ !ok → console.warn（不阻塞；继续轮询）
 │    └─ gateTimer：productShell ? 12s : 0 后强制 setEngineReady(true)   [门闩掩盖真实状态]
 └─ useEngineBootstrap.ts (5-61)          与 effect7 **逐字重复**的实现副本（独立 hook，双份）
```

### 2.2 状态机各层职责

| 层 | 文件 | 职责 | 关键语义 |
|---|---|---|---|
| TauriTransport | api/transport/tauriTransport.ts | IPC 传输 + 就绪探测 | `waitUntilConnected` = core_get_status 每 250ms 轮询（200-230）；`isCoreReady` 检查 engineReady/dbReady/searchIndexReady **任一为 true 即就绪（OR 语义）**（46-62）；status：disconnected/connecting/connected/failed；`request()` 经 commandMap 解析 + 暂态错误重试一次（149-166） |
| ConnectionManager | services/ConnectionManager.ts | UI 投影（无 probe/心跳） | TransportStatus → ConnectionPhase（'disconnected'→disconnected / connecting / connected→ready / failed→recovering）；`connect()` 委托 transport.waitUntilConnected(15s)（108-117）；**不跑 probe、不跑重连退避**（C3.5 简化）；isReady() = phase==='ready' && transport.isReady() |
| useEngineBootstrap / AppBootstrap.effect7 | app/useEngineBootstrap.ts / app/AppBootstrap.ts | 启动门闩 | engineReady 布尔 = transport 就绪 + ensureDaemonConnected 成功 + 门闩超时兜底；就绪后触发同步（profile → engine、sessions ← SQLite） |
| engineStatus | api/engineStatus.ts | get-status 投影（H2 运行条） | `fetchEngineLiveStatus` = waitUntilConnected(6s) + get-status；Tauri 路径 activeRuns/pendingApprovals **恒空数组**（core_get_status 无此字段，53-55 注释自认） |
| engineConfig | api/engineConfig.ts | 配置读/写 + 就绪度纯函数 | `fetchEngineStatus` = waitUntilConnected(12s) + get-status；`updateEngineConfig` = update-config → update_daemon_config |
| 设置页 | components/SettingsProfileTab.tsx | 展示 | 192-193：`daemonOnline = transport.isReady() || status==='connected'`，仅「在线/离线」；**设置页不展示 key 状态**（key 提示只在 ChatStatusRibbons） |

### 2.3 engineReady / dbReady 语义（Rust 侧真源）

| 字段 | 来源 | 语义 |
|---|---|---|
| initialized | core_query_commands.rs:51,174 | 恒 true（setup 构建 CoreRunState 成功即视为初始化） |
| engineReady | `EngineHandle.ready()`（engine.rs:150-152）| provider 配置（baseUrl/model/apiKey 三件套，load_provider_endpoint engine.rs:169-179，源 = config::effective_* 即 ApiConfigStore）齐备即可发起调用；加载失败仅降级未就绪（engine.rs:112-125） |
| dbReady | `SharedDb.db_ready()`（session_commands.rs:38-41）| sessions.db 打开成功且无 fatal failure；文件 DB 打开失败降级内存 DB 并置 false（main.rs:144-177） |
| searchIndexReady | SharedSearchState.files 非空（core_query_commands.rs:330-334）| 目录索引已构建 |

**注意**：前端 `isCoreReady` 是 OR——`engineReady=false` 但 `dbReady=true` 时前端也判定「核心已初始化」→ engineReady 语义被稀释。

### 2.4 现存结构问题

1. AppBootstrap.effect7 与 useEngineBootstrap 是**同一逻辑的两份副本**（逐字重复），易漂移；
2. `gateTimer` 12s 强制 ready（AppBootstrap.ts:316-321）与 `fetchEngineStatus` 的 15s 超时回退离线（ChatHeaderControls.tsx:68-75）是**互相矛盾的兜底**；
3. 启动即执行的 `syncActiveProfileToEngine` + `syncSessionsFromDaemon` 是 WS 时代「推配置/拉会话」遗留（见 §一）；
4. 「engineReady」布尔与「引擎可用（provider 配置齐备）」在 Tauri 下应合二为一（进程内无独立 daemon），但前端仍按「连接-重连」心智投影（recovering 等状态基本不会出现）。

---

## 三、IPC 命令面全清单

### 3.1 注册面（main.rs make_handlers!，共 79 个命令）

按域分组（输入/输出均为 serde camelCase；`R<T,E>` = `Result<T,E>`）：

#### A. 引擎核心查询 core_query_commands.rs（4 个，错误 = CoreError）

| 命令 | 输入 | 输出 | 错误协议 |
|---|---|---|---|
| core_get_status | （无） | CoreStatus { initialized, version, engineReady, searchIndexReady, dbReady, compactionReady } | CoreError |
| core_get_run_snapshot | runId | RunSnapshot { runId, sessionId, status, cursor, endReason?, error?, createdAt, updatedAt, terminal } | CoreError（NotFound） |
| core_read_run_events | runId, afterSequence?, limit? | EventPage { events, nextAfterSequence, hasMore } | CoreError（NotFound） |
| core_read_session_events | sessionId, afterSequence?, limit? | EventPage { events, nextAfterSequence, hasMore } | CoreError |

#### B. run 生命周期 core_run_commands.rs（5 个，错误 = CoreError）

| 命令 | 输入 | 输出 |
|---|---|---|
| core_run_task | runId, sessionId, prompt?, mode?, cwd?, permissionMode?, clientMessageId?, assistantClientMessageId? | RunTaskResponse { runId, sessionId } |
| core_run_control | runId, level(continue/soft_inject/cooperative_stop/force_cancel), message? | () |
| core_cancel_run | runId, mode?(cooperative/force/cooperative-fallback-force) | CancelRunResponse { ok, runId, pid? } |
| core_approve_tool | runId, toolCallId, decision?(approved/denied/expired) | ApproveResponse { ok, toolCallId, decision } |
| core_deny_tool | runId, toolCallId, reason? | ApproveResponse { ok, toolCallId, decision } |

#### C. 会话持久化 session_commands.rs（11 个，错误 = CoreError，SQLite）

| 命令 | 输入 | 输出 |
|---|---|---|
| list_sessions | （无） | Vec\<SessionIndexEntry\> |
| load_session_body | sessionId | Vec\<SessionMessage\> |
| save_session_body | sessionId, messages | () |
| delete_session | sessionId | () |
| load_session_agents | sessionId | Vec\<SessionAgent\> |
| save_session_agents | sessionId, agents | () |
| get_session_meta | key | Option\<String\> |
| set_session_meta | key, value | () |
| cleanup_orphan_sessions | activeIds | usize |
| import_from_localstorage | indexJson, bodies, agents, activeSessionId?, folderOrder | ImportStats |
| touch_session | sessionId | () |

#### D. Markdown markdown_commands.rs（5 个，错误 = CoreError）

| 命令 | 输入 | 输出 |
|---|---|---|
| md_render | text | String(HTML) |
| md_render_batch | texts | Vec\<String\> |
| md_render_stream | text, streamMode | String(HTML) |
| highlight_code | code, lang? | String(HTML 片段) |
| md_clear_cache | （无） | () |

#### E. Worker 下沉/工具 core_commands.rs 两代（11 个）

| 命令 | 输入 | 输出 | 错误协议 |
|---|---|---|---|
| core_search_files | query, limit? | Vec\<FileHit\> | **String**（旧组，未收敛） |
| core_rebuild_search_index | root | RebuildSearchIndexResponse { fileCount } | **String** |
| core_compact_messages | messages, maxTokens | CompactionResult | **String** |
| core_count_tokens | text | usize | **String** |
| core_check_command | cmd, args | GatekeeperResult | **String** |
| core_compute_diff | oldText, newText | DiffResult | **String** |
| core_hash_compute | data, algorithm? | String(hex) | CoreError（Stream E 新组） |
| core_base64_encode | data, config? | String | CoreError |
| core_base64_decode | encoded, config? | Vec\<u8\> | CoreError |
| core_detect_encoding | data | EncodingDetectResult { encoding, confidence, hasBom } | CoreError |
| core_decode_text | data, encoding? | String | CoreError |
| core_parse_diff | unifiedDiff, maxLines? | DiffResult | CoreError |
| core_messages_to_jsonl | messages | String(JSONL) | CoreError |
| core_jsonl_to_messages | text | Vec\<Value\> | CoreError |
| core_text_encode | text, encoding? | Vec\<u8\> | CoreError（Encoding） |

> 注：同一文件里新旧两组错误协议并存（旧 6 个 String / 新 9 个 CoreError），Stream E 注释自认「perf_* 别名保留兼容，新代码优先 core_*」（core_commands.rs:174-193）。

#### F. 配置 config/*.rs（7 个，错误 = String；**前端零调用，全为死面**）

| 命令 | 输入 | 输出 |
|---|---|---|
| save_api_config | apiKey, baseUrl, model | 配置快照（{ok:true, ...}） |
| get_api_config | （无） | 配置快照（含 apiKey？/baseUrl/model/credentialMode/endpoint/stream/source） |
| update_daemon_config | apiKey?, baseUrl?, model?, credentialMode?, endpoint?, stream? | 快照 { ok, sentToDaemon:false(恒), ... } |
| workbench_profile_secret_set | profileId, apiKey | { ok, profileId, hasKey, persistence } |
| workbench_profile_secret_get | profileId | { ok, profileId, hasKey, apiKey } |
| workbench_profile_secret_has | profileId | { ok, profileId, hasKey } |
| workbench_profile_secret_clear | profileId | { ok, profileId, hasKey, persistence } |

> 引擎进程内后 `sentToDaemon` 恒为 false（config/provider.rs:488-498 注释「C4.1：WS sidecar 转发已删除…C4.4 随 main.rs 清理再评估命令重命名」）——**命令名与字段仍是 daemon 时代残留**。

#### G. 文件系统 fs_commands/*.rs（5 个，错误 = FileCommandError{code,message} 或 String）

| 命令 | 输入 | 输出 |
|---|---|---|
| select_folder | （无） | SelectFolderResult { path } |
| list_directory | path, workspaceRoot? | ListDirectoryResult（items...） |
| read_file_content | path, maxLines?, workspaceRoot? | ReadFileContentResult { content, lineCount, truncated } |
| write_file_content | path, content, workspaceRoot? | WriteFileContentResult |
| workbench_discover_skills | workspacePath?, extraDirs | Vec\<RustSkill\>（String 错误） |

#### H. host_openers（4 个，错误 = HostOpenerError）

| 命令 | 输入 | 输出 |
|---|---|---|
| workbench_list_host_openers | （无） | Vec\<HostOpener\> |
| workbench_open_host_target | openerId, target | HostOpenResult |
| workbench_open_path_default | path | HostOpenResult |
| workbench_list_file_openers | path | Vec\<HostOpener\> |

#### I. PTY pty/mod.rs（4 个，错误 = String）

| 命令 | 输入 | 输出 |
|---|---|---|
| workbench_pty_create | sessionKey, cols, rows, cwd? | PtyCreateResult { ptyId } |
| workbench_pty_write | ptyId, data（≤64KiB） | () |
| workbench_pty_resize | ptyId, cols, rows | () |
| workbench_pty_kill | ptyId | () |

#### J. 进程/电源 process.rs + power.rs（2 个，错误 = String）

| 命令 | 输入 | 输出 |
|---|---|---|
| workbench_run_shell | request { command, cwd?, timeoutMs? } | WorkbenchRunShellResult { ok, stdout, stderr, shell, cwd, durationMs, truncated } |
| workbench_set_keep_awake | enabled | ()（**前端零调用**） |

#### K. perf 别名（13 个，错误 = String；core_* 的兼容别名）

perf_hash_compute / perf_base64_encode / perf_base64_decode / perf_encoding_detect / perf_encoding_decode /
perf_encoding_encode / perf_diff_parse / perf_jsonl_read / perf_jsonl_write / perf_jsonl_append /
perf_fs_read_chunk / perf_fs_file_info / perf_fs_watch_start / perf_fs_watch_stop（14 个，其中
perf_encoding_encode / perf_fs_watch_start / perf_fs_watch_stop 无 core_* 对应）。
前端唯一直接调用：TelemetryMonitor.ts:103 `perf_jsonl_append`。

#### L. 杂项 commands.rs（2 个，错误 = String）

| 命令 | 输入 | 输出 |
|---|---|---|
| workbench_http_request | url, method(GET/POST/HEAD), headers?, body? | { ok, status, body } |
| workbench_apply_update | （无） | { ok: true }（stub，updateStore.ts:62 调用） |

#### M. 事件通道（非命令）

| 通道 | 载荷 |
|---|---|
| workbench-run-event（emit） | 完整事件 JSON { type, runId, sessionId, sequence, ...事件字段 }（core_event_bridge.rs） |
| workbench://pty-output / workbench://pty-exit | { ptyId, data } / { ptyId, exitCode? } |

### 3.2 前端 commandMap.ts 映射表（WS type → 命令名）与实际注册对照

commandMap.ts:19-40 共 22 条映射，分三类：

| 类别 | 条目 | 现状 |
|---|---|---|
| ① core_* 已注册 | get-status→core_get_status / get-run-snapshot→core_get_run_snapshot / read-run-events→core_read_run_events / read-session-events→core_read_session_events / approve-tool→core_approve_tool / deny-tool→core_deny_tool | ✓ 全部存在，但 get-status 形状缺口（§一） |
| ② 壳命令「已迁移」 | update-config→update_daemon_config / list-sessions→list_sessions / git-status→workbench_git_status / git-diff→workbench_git_diff / list-mcp-servers→workbench_list_mcp_servers / start/stop-mcp-server→workbench_start/stop_mcp_server / preview/apply-conversation-rewind→workbench_preview/apply_conversation_rewind / send-to-subagent→workbench_send_to_subagent / get-subagent-status→workbench_get_subagent_status | **9 个 workbench_* 在 main.rs 已不再注册**（整个 src-tauri/src grep 零命中，run_commands.rs / action_commands.rs 等文件已随重构删除）→ invoke 抛「command not found」→ invokeTyped 判 missing → transport 抛「Tauri command not available」→ 前端各自降级（gitApi 回落本机 git；mcpApi 空表+configured:false；rewind/subagent 失败） |
| ③ 映射表无条目 | list-workflows / create-workflow / delete-workflow / update-workflow / trigger-workflow / list-workflow-runs / list-capabilities / probe-provider-models / probe-provider-chat / upsert/delete-scoped-context / cron.* / sync-pull / sync-push（共 22 处调用点，见 21-phase-c-migration-log.md 一） | resolveTauriCommand 返回 null → 抛「Tauri command not available」→ 各调用点 catch 降级（空表 / HTTP 直连 / daemonSynced=false / pullUnsupported） |

**结论：commandMap 是一份「过期的幽灵清单」**——② 类中 9 条映射到已删除的壳命令，③ 类 22 条
是「需回补」占位。Tauri 路径下 git/mcp/rewind/subagent/workflow/cron/scoped-context/sync 全部
实际不可用，靠前端降级静默运转。

### 3.3 前端调用方式（四类，不统一）

| 方式 | 调用点 | 说明 |
|---|---|---|
| ① transport.request(WS-type) 经 commandMap | engineConfig.ts / engineStatus.ts / gitApi.ts / mcpApi.ts / clientApi.ts(scheduled/MCP) / sessionDaemonSync.ts / conversationRewindApi.ts / subagentApi.ts / workflowApi / schedule / SessionSyncService | 「新约定」但其中 9 条映射到未注册命令、若干条映射到 null |
| ② 直接 invokeResult/invokeTyped/invokeCmd('core_*'/'md_*'/壳名) **绕过 commandMap** | rustCore.ts（25 处：core_*/md_*）、sessionRustDb.ts（11 处 list_sessions/load_session_body...）、workspaceFsApi.ts、hostOpenersApi.ts、ptySessionApi.ts、terminalShellApi.ts（workbench_run_shell）、skillsApi.ts（workbench_discover_skills）、modelCatalog.ts（workbench_http_request）、updateStore.ts、TelemetryMonitor.ts（perf_jsonl_append）、importFsHost.ts、windowApi.ts | 最大头：直接命令名直调，不经映射表（映射表只服务 transport.request 一条线） |
| ③ @tauri-apps/api 插件直调 | windowApi.ts（window 控制）等 | 非 invoke_handler 面 |
| ④ transport 内部 | tauriTransport.ts:211 waitUntilConnected 直调 invokeTyped('core_get_status') | 不经 commandMap（等价直连） |

### 3.4 错误协议（不统一）

| 协议 | 使用者 | JS 侧识别 |
|---|---|---|
| CoreError `{kind, detail}`（serde tagged enum，conex-types/src/lib.rs:245-258：InvalidInput/Encoding/Io/NotFound/Cancelled/Internal） | core_query_commands / core_run_commands / session_commands / markdown_commands / Stream E 9 个 core_* | invokeTyped.extractErrorKind（tauriInvoke.ts:74-104）识别 kind/detail → InvokeError{kind,message} |
| String | core_commands 旧 6 个、perf_* 14、pty、process、power、fs(部分)、host_openers、config 7、commands 2 | 字符串错误 → kind='Unknown'（信息丢失） |
| FileCommandError{code,message} | fs_commands list/read/write | 前端自行读 code |
| HostOpenerError | host_openers | 前端自行处理 |

> 前端 `invokeResult`（旧 API）把 missing/error 全部吞成 null（tauriInvoke.ts:183-190），调用方无法区分
> 「命令不存在」与「命令报错」；新代码用 invokeTyped 但 rustCore.ts 等仍大量用 invokeCmd/invokeResult。

---

## 四、接口面规范化改造要点

### 4.1 「待同步」问题修复（按优先级）

1. **回补 `core_get_status` 形状**（根因）：扩展 CoreStatus 增加 `providerStatus`/`provider` 字段
   （hasApiKey/model/baseUrl/credentialMode，直读 ApiConfigStore + workbench_profile_secret_has），
   或新增 `core_get_config_status` 命令；落实 21-phase-c-migration-log.md:72-81 的 ①②回补单。
2. **前端缺省语义修正**：`parseEngineStatusFromRaw` 在字段缺失时 `hasApiKey` 应为 `undefined`
   （未知）而非 `false`（已知无）——与 `engineHint==null 不展示` 的既有 null 语义一致；
   同时删除 `resolveSetupHintKind` 的 sync-engine 分支与文案（进程内引擎不存在「同步」概念）。
3. **删除启动同步**：移除 AppBootstrap.ts:300-304 / useEngineBootstrap.ts:38-40 的
   `syncActiveProfileToEngine` 调用；`updateEngineConfig → update_daemon_config` 改名 `update_config`，
   `sentToDaemon` 字段删除。
4. **配置真源归一**：统一为 Rust `ApiConfigStore`（get_api_config / workbench_profile_secret_* 接入
   前端；localStorage `crish_provider_profiles_v1` 明文 key 迁移到 DPAPI sidecar，降级为「本地草稿」）。

### 4.2 命令面收束

1. **清理 commandMap 幽灵条目**：删除 9 条已注销的 workbench_* 映射（git/mcp/rewind/subagent）；
   git/mcp 能力明确两个出口之一——Rust 侧回补（core_git_status/core_git_diff/core_list_mcp_servers...）
   或前端显式只走本地实现（gitApi 已具备本机快路径，MCP 已具备 mcpClientManager 直连）。
2. **③ 类 22 处收敛**：workflow/cron/scoped-context/session-sync 在 Tauri 下是死代码——
   要么回补（建议命令名已列于 21-phase-c-migration-log.md 二），要么删除调用点与降级壳。
3. **命名统一**：引擎域一律 `core_*`（进程内引擎），壳域一律 `workbench_*`；删除
   `update_daemon_config`/`save_api_config`/`get_api_config` 的 daemon 残留命名
   （`config_update`/`config_get`/`config_snapshot`），`perf_*` 别名只保留给兼容期后删除。
4. **错误协议全命令收敛到 CoreError `{kind, detail}`**：core_commands 旧 6 个、perf_*、pty、
   process、fs、host_openers、config、commands 全部改为 `Result<_, CoreError>`；
   前端删除 `invokeResult`/`invokeCmd`（或重定义为 invokeTyped 薄包装），错误一律结构化。
5. **参数/返回 camelCase 统一**：config/fs/pty 等老命令已 camelCase，但 `core_get_status` 等
   用 `rename_all="camelCase"`、perf 用 snake 内部字段——以 serde rename_all 统一为输出 camelCase。

### 4.3 启动状态机收敛

1. AppBootstrap.effect7 与 useEngineBootstrap 合并为单一 `useEngineBootstrap`；
2. 删除 12s gateTimer 强制 ready 与 15s 超时离线回退的互相矛盾兜底——Tauri 进程内核心
   ready 判定 = `core_get_status.engineReady`（provider 齐备）单一来源；失败投影 recovering 而非 ready；
3. `isCoreReady` 的 OR 语义改为明确聚合：`engineReady` 为「引擎可用」主判据，
   `dbReady` 独立暴露给会话层（不参与引擎可用性）；
4. ConnectionManager 的 disconnected/connecting/authenticating/recovering 相在 IPC 下可简化为
   ready/not-ready 两态（进程内无断连、无重连、无认证握手）。

### 4.4 web/gui/tui 三端适配边界

| 域 | 建议归属 | TUI 接入 |
|---|---|---|
| 引擎核心（查询/run/事件/审批）core_* | IPC 公共层 | ✓ 直接复用（TUI 用 IPC 客户端或 CLI 子命令暴露同一契约） |
| 配置 config_*（重命名后） | IPC 公共层 | ✓ 直接复用（TUI 读配置必须走同一真源） |
| 会话 SQLite session_* | IPC 公共层 | ✓ 直接复用 |
| Markdown/worker 下沉 md_*/core_* | IPC 公共层 | △ 按需（TUI 可能自渲染） |
| 壳专用 workbench_*（fs/pty/process/power/host_openers/http/update） | GUI 专用 | ✗ 不接入；TUI 用原生库替代 |
| 事件通道 workbench-run-event | IPC 公共层 | ✓（TUI 订阅同一通道） |

> 边界原则：**core_* + config_* + session_* + 事件通道 = 引擎契约面（web/gui/tui 共用）；
> workbench_* = 桌面壳面（仅 GUI）**。TUI 对接时以前者为契约，后端按此分层组织模块
> （引擎域从 tauri 壳中抽成可独立 crate 调用的命令层，或至少保持命令名/参数/错误协议与 GUI 完全一致）。
