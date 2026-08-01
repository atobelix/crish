# PE-03 — IPC 接口面收束与三端适配边界（任务书）

> 性质：方案设计（只读研究 + 本文档，不含任何代码改动）。
> 日期：2026-08-01。
> 域：IPC 接口面收束（对应 23-architecture-hardening-plan.md E3.1-E3.6、E7.1-E7.2）。
> 输入事实：
> - 25-ipc-contract-audit.md（79 命令注册面、四类调用方式、幽灵条目 9、不可用调用点 22、错误协议不统一）
> - audits/AA-02-tauri-shell-review.md（W-1 core_check_command 恒失败、W-5 commandMap 幽灵、死面 20、core_*/perf_* 双注册）
> - 代码：apps/crish-desktop/src/api/transport/commandMap.ts、apps/crish-desktop/src/api/tauriInvoke.ts、
>   apps/agent-workbench/src-tauri/src/main.rs（make_handlers! 全清单）、core_error.rs、error_bridge.rs
> 关联：21-phase-c-migration-log.md（③ 类 22 处调用点清单）、03-frontend-contract.md §5.3-5（错误协议）、
>       23-architecture-hardening-plan.md（E3 系列任务）、00-master-plan.md（多 Agent 章程与轮次规则）。
> 执行规则：沿用 00 主方案 §1 多 Agent 章程；每轮 ≤12 Agent；R4 零兼容原则（删即删，不保过渡）。
> 计数口径说明：main.rs make_handlers! 逐行计数为 **78 个注册命令**；25 号审计的 79 含 perf_encoding_encode
> （已定义 #[tauri::command] 但未注册，AA-02 S-19）。下文一律以 78 为基线。

---

## 修订记录

| 版本 | 日期 | 修订依据 | 要点 |
|---|---|---|---|
| v1 | 2026-08-01 | — | 初版 |
| v2 | 2026-08-01 | **AU-04 接口冻结裁决** | ① T03.1 验收改「返回条数 == 当前注册面」（删硬编码 64，F12-C13），吸收 PE-01 的 `'update-config'`→`config_update`（C19）；② §2.2 core_get_status 字段集与 F2 冻结表一致（providerStatus 名、activeRuns/pendingApprovals/mcpStatus 形状）；③ §2.2-C 配置族 = F5 终态表（新增 config_profile_apply / config_secret_reveal 两行，config_secret_get 默认仅 {hasKey, apiKeyLast4}，K-02）；④ T03.3 增加 fs 分页上限/spawn_blocking 动作（认领表 #8）、error_bridge 删除注明 PE-04 迁移时序（F8）、Q30 映射边界声明（D8）；⑤ 新增 T03.10 事件载荷版本化（F11）；⑥ 9 条新增命令登记表（F12-C13），T03.9 契约冻结排在命令面稳定后；⑦ main.rs 六方串行声明（PE-01 → PE-03 → PE-04 → PE-08 → PE-09 → PE-07） |

---

## 0. 结论摘要

| 项 | 现状 | 目标（本任务书落地后） |
|---|---|---|
| 注册命令数 | 78（另 1 个定义了未注册） | **当前注册面**（公式化验收，AU-04 F12-C13：冻结日基线 64，9 条新增命令登记后 ≈73；一律以 `core_list_commands` 实计数为准） |
| commandMap 幽灵条目 | 9 条映射到已删除命令 | 0（清单驱动，Rust 侧为唯一真源） |
| 不可用调用点（③ 类） | 22 处（Tauri 下必抛「命令不可用」） | 回补 1（list-capabilities 并入 core_get_status）、删除+显式路径 21 |
| 错误协议 | 4 套并存（CoreError / String / FileCommandError / HostOpenerError） | 唯一协议 CoreError `{kind, detail}` + 77 码映射表成文 |
| 死面命令 | 20（前端 src 零引用） | 逐一裁决：删除注册 15、更名接线 5（配置族） |
| 直调 invokeResult/invokeCmd | 25+ 处绕过 commandMap | 0（全部收敛 transport 单通道） |
| daemon 残留 | update_daemon_config / sentToDaemon / active_runs 死代码 / error_bridge 中间态 | 全部清除 |
| 契约可测性 | 无命令级契约测试 | 命令签名/响应/错误 golden 全量覆盖（与界面解耦，TUI 复用） |

**目标架构**（23 号方案 §2 的落地）：引擎契约面（core_*/config_*/session_*/workbench-run-event/CoreError）
为 web/gui/tui 三端共用；workbench_*（fs/pty/process/power/host/http/update）为 GUI 专属面；TUI 只依赖
契约面。本文档 §2 即为 TUI 开发输入契约（初稿，T03.9 固化为独立文档）。

---

## 1. 现状基线（事实速览）

### 1.1 注册面构成（main.rs make_handlers!，共 78）

| 域 | 数量 | 命令 | 错误协议现状 |
|---|---|---|---|
| A 引擎核心查询 core_query_commands | 4 | core_get_status / core_get_run_snapshot / core_read_run_events / core_read_session_events | CoreError（get_status 字段形状缺口） |
| B run 生命周期 core_run_commands | 5 | core_run_task / core_run_control / core_cancel_run / core_approve_tool / core_deny_tool | CoreError（run_control 部分 level no-op，S-10） |
| C 会话持久化 session_commands | 11 | list_sessions / load_session_body / save_session_body / delete_session / load_session_agents / save_session_agents / get_session_meta / set_session_meta / cleanup_orphan_sessions / import_from_localstorage / touch_session | CoreError |
| D Markdown markdown_commands | 5 | md_render / md_render_batch / md_render_stream / highlight_code / md_clear_cache | CoreError |
| E1 工具旧组 core_commands | 6 | core_check_command（恒失败 W-1）/ core_search_files / core_rebuild_search_index / core_compact_messages / core_count_tokens / core_compute_diff | **String** |
| E2 工具新组 core_commands | 9 | core_hash_compute / core_base64_encode / core_base64_decode / core_detect_encoding / core_decode_text / core_parse_diff / core_messages_to_jsonl / core_jsonl_to_messages / core_text_encode | CoreError |
| F 配置 config/* | 7 | save_api_config / get_api_config / update_daemon_config / workbench_profile_secret_set/get/has/clear | **String**；**前端零调用全死面** |
| G 文件系统 fs_commands | 5 | select_folder / list_directory / read_file_content / write_file_content / workbench_discover_skills | String 或 FileCommandError |
| H host_openers | 4 | workbench_list_host_openers / workbench_open_host_target / workbench_open_path_default / workbench_list_file_openers | HostOpenerError |
| I PTY pty/mod | 4 | workbench_pty_create / workbench_pty_write / workbench_pty_resize / workbench_pty_kill | **String** |
| J 进程/电源 | 2 | workbench_run_shell / workbench_set_keep_awake（死面） | **String** |
| K perf 别名 | 13 | perf_hash_compute…perf_fs_watch_stop（12 个死面，唯一活调用 perf_jsonl_append） | **String**；core_* 双注册（S-2） |
| L 杂项 commands | 2 | workbench_http_request / workbench_apply_update（恒 ok stub，S-4） | **String** |
| M 事件通道（非命令） | — | workbench-run-event（emit）/ workbench://pty-output / workbench://pty-exit | — |

### 1.2 前端调用方式（四类不统一）

| 方式 | 位置 | 问题 |
|---|---|---|
| ① transport.request(WS-type) 经 commandMap | engineConfig / engineStatus / gitApi / mcpApi / clientApi / sessionDaemonSync / conversationRewindApi / subagentApi / workflowApi / schedule / SessionSyncService | 22 条映射里 9 条指向已删除命令、若干条映射为 null |
| ② 直接 invokeResult/invokeTyped/invokeCmd 绕过 commandMap | rustCore.ts 25 处、sessionRustDb.ts 11 处、workspaceFsApi / hostOpenersApi / ptySessionApi / terminalShellApi / skillsApi / modelCatalog / updateStore / TelemetryMonitor / importFsHost / windowApi | 最大头：不经映射表，无 manifest 校验 |
| ③ @tauri-apps/api 插件直调 | windowApi.ts（window 控制） | 非 invoke_handler 面，不在收束范围 |
| ④ transport 内部直调 | tauriTransport.ts:211 waitUntilConnected 直调 core_get_status | 等价直连 |

### 1.3 错误协议（四套并存）

| 协议 | 使用面 | JS 侧识别 |
|---|---|---|
| CoreError `{kind, detail}`（6 kinds） | 查询/run/session/markdown/Stream E | invokeTyped.extractErrorKind → InvokeError{kind,message} |
| String | 工具旧组 6、perf 13、pty、process、power、fs(部分)、host_openers、config 7、commands 2 | kind='Unknown'（信息丢失） |
| FileCommandError{code,message} | fs list/read/write | 前端自行读 code |
| HostOpenerError | host_openers 4 | 前端自行处理 |

> 附带事实：invokeResult（tauriInvoke.ts:127-141）把 missing/error 全部吞成 null，调用方无法区分
> 「命令不存在」与「命令报错」；invokeCmd 已 @deprecated 但 rustCore.ts 等仍大量使用。

### 1.4 三类问题面汇总（收束对象）

| 问题面 | 规模 | 依据 |
|---|---|---|
| 幽灵条目 | commandMap.ts:31-39 共 9 条 | AA-02 W-5、25 §3.2 |
| 死面命令 | 20 个（前端 src 零引用） | AA-02 S-1（清单见 §3.5 判定表） |
| 不可用调用点 | 22 处（③ 类） | 21-phase-c-migration-log.md §1 |
| 双注册 | core_* 与 perf_* 同功能 6 对 | AA-02 S-2 |
| 恒失败命令 | core_check_command（SharedGatekeeper 未注入） | AA-02 W-1 |
| 错误协议不统一 | 4 套 | 25 §3.4 |

---

## 2. 契约面定义（目标态）

### 2.1 分面原则与三端边界

| 面 | 组成 | 消费端 | TUI 接入 |
|---|---|---|---|
| **引擎契约面** | core_* + config_* + session_* + workbench-run-event + CoreError | web / gui / tui 共用 | ✓ 直接复用（TUI 经 IPC 客户端或 CLI 子命令暴露同一契约） |
| **GUI 专属面** | workbench_*（fs / pty / process / power / host_openers / http / update） | 仅 GUI | ✗ 不接入（TUI 用原生库替代） |

边界原则（25 §4.4 固化）：
1. 引擎命令一律返回 CoreError；GUI 命令同样收敛 CoreError（唯一协议，不分面）。
2. 契约面命令不允许依赖 Tauri webview / DOM / 前端存储；TUI 直连不得触发任何前端降级。
3. 契约面变更必须走版本化 changelog（T03.9），TUI 以 `core_list_commands` 清单做运行时探测。

### 2.2 引擎契约面正式清单（冻结日基线 48，随 §7.2 登记表增量）

> 命名设计决定：session_* 与 config_* 作为契约面内的**独立族**保留（避免 17 个纯前缀重命名）；
> md_* 并入 core_*（core_md_*，5 个重命名，与工具域前缀一致）。若后续要求严格 core_* 全前缀，
> 追加重命名 session_*→core_*（11 个）成本已列在 §3.4 备选。目标名格式：**新名（旧名）**。
> 接口签名凡涉 AU-04 冻结项，一律标注「冻结 v1，见 AU-04 Fx」，实现唯一负责方见各条目。

#### A. 查询与运行（9 个，错误 = CoreError）

| 命令 | 输入 | 输出 | 错误要点 |
|---|---|---|---|
| core_get_status | （无） | CoreStatus { initialized, version, engineReady, searchIndexReady, dbReady, compactionReady, **providerStatus**, **activeRuns**, **pendingApprovals**, **mcpStatus** } | **字段集冻结 v1，见 AU-04 F2**：字段名 `providerStatus`（含 hasApiKey 三态）、activeRuns/pendingApprovals 为 number、mcpStatus 形状 `{ enabled, configured }`；logLevel/logDir/diagnostics/lastError 由 PE-04、restore/snapshot 由 PE-08 按 F2 串行序增量并入（core_query_commands.rs：PE-01 → PE-03 → PE-04 → PE-08） |
| core_get_run_snapshot | runId | RunSnapshot { runId, sessionId, status, cursor, endReason?, error?, createdAt, updatedAt, terminal } | 空 runId → InvalidInput（S-16） |
| core_read_run_events | runId, afterSequence?, limit? | EventPage { events, nextAfterSequence, hasMore } | 同上；limit ≤ 1000 |
| core_read_session_events | sessionId, afterSequence?, limit? | EventPage { events, nextAfterSequence, hasMore } | 空 sessionId → InvalidInput |
| core_run_task | runId, sessionId, prompt?, mode?, cwd?, permissionMode?, clientMessageId?, **assistantClientMessageId?** | RunTaskResponse { runId, sessionId } | assistantClientMessageId 回补（21-log §5.2） |
| core_run_control | runId, level(continue/soft_inject/cooperative_stop/force_cancel), message? | () | 未接线 level 返回明确错误（S-10，删除假成功） |
| core_cancel_run | runId, mode?(cooperative/force/cooperative-fallback-force) | CancelRunResponse { ok, runId, pid? } | pid 语义重定义或置 null（进程内无 sidecar pid） |
| core_approve_tool | runId, toolCallId, decision?(approved/denied/expired) | ApproveResponse { ok, toolCallId, decision } | runId 校验（S-15） |
| core_deny_tool | runId, toolCallId, reason? | ApproveResponse { ok, toolCallId, decision } | 同上 |

#### B. 会话持久化（11 + 2 新增，族名 session_*，错误 = CoreError，SQLite）

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
| cleanup_orphan_sessions | activeIds, confirmEmpty | usize \| Err(InvalidInput, "cleanup_orphan_empty_keep") |
| import_from_localstorage | indexJson, bodies, agents, activeSessionId?, folderOrder | ImportStats |
| touch_session | sessionId | () |
| upsert_session_entry（PE-08 T08.1 新增） | entry: SessionIndexEntry | () |
| append_session_messages（PE-09 T09.4.1 第 1 条新增） | sessionId, messages: Vec\<SessionMessage\> | () |

> **冻结注记（v1）**：`cleanup_orphan_sessions` 签名/语义冻结 = AU-04 F4（空集且 confirm_empty=false →
> 不执行 DELETE，返回 Err；宽限期 5 分钟 ORPHAN_GRACE_MS=300_000，session_meta 键 `orphan_grace_ms` 可配）；
> `upsert_session_entry` 对象签名冻结 = AU-04 F3（ON CONFLICT(id) DO UPDATE，不级联删消息）；
> `save_session_body` 全量替换写模型保留 + `append_session_messages` 增量路径 = AU-04 F7
> （写者所有权：session_messages/agents 前端唯一拥有，引擎只写 events/runs/pending）。

#### C. 配置与密钥（6 + 2 新增，族名 config_*，错误 = CoreError；命名终态 = AU-04 F5 冻结表 v1）

| 命令 | 输入 | 输出 | 处置 |
|---|---|---|---|
| config_get（get_api_config） | （无） | 配置快照 { ok, providerId?, baseUrl, model, credentialMode, endpoint, stream, source, **hasApiKey** } | 更名 + 接线（T03.5） |
| config_update（update_daemon_config） | apiKey?, baseUrl?, model?, credentialMode?, endpoint?, stream? | 快照 { ok, ... } | 更名 + **删除 sentToDaemon 字段**（S-6） |
| config_secret_set（workbench_profile_secret_set） | profileId, apiKey | { ok, profileId, hasKey, persistence } | 更名 + 接线（T03.5） |
| config_secret_get（workbench_profile_secret_get） | profileId | { ok, profileId, hasKey, apiKey } | 更名 + 接线；**默认仅回 { hasKey, apiKeyLast4 }**（K-02，语义由 PE-07 T07.4-C 定稿，本任务不定义第二形状） |
| config_secret_has（workbench_profile_secret_has） | profileId | { ok, profileId, hasKey } | 更名 + 接线 |
| config_secret_clear（workbench_profile_secret_clear） | profileId | { ok, profileId, hasKey, persistence } | 更名 + 接线 |
| config_profile_apply（PE-07 T07.4 新增） | （profile 参数） | { ok, apiKeyLast4, model } | **登记**（F5）：进程内读 DPAPI 直写 ApiConfigStore，实现归 PE-07 T07.4 |
| config_secret_reveal（PE-07 T07.4-C 新增） | profileId, 一次性 UI 确认参数 | 明文 apiKey | **登记**（F5）：实现归 PE-07 T07.4-C |
| ~~save_api_config~~ | — | — | **删除**（写路径与 config_update 重叠，AA-02 S-1） |

> **冻结注记（v1，AU-04 F5）**：配置与密钥族一律 `config_*`；`config_profile_apply` / `config_secret_reveal`
> 不得保留 workbench_profile_ 原名；前端唯一薄封装 = PE-01 T03.2 的 rustProfileStore.ts
> （方法名对应本终态表）；PE-07 新增两条密钥命令全部登记 manifest/契约（C13）。

#### D. Markdown（5 个，并入 core_*，错误 = CoreError）

| 命令 | 输入 | 输出 |
|---|---|---|
| core_md_render（md_render） | text | String(HTML) |
| core_md_render_batch（md_render_batch） | texts | Vec\<String\> |
| core_md_render_stream（md_render_stream） | text, streamMode | String(HTML)（E2.5 待裁决：若 E2 轮删除则同步从契约剔除） |
| core_highlight_code（highlight_code） | code, lang? | String(HTML 片段) |
| core_md_clear_cache（md_clear_cache） | （无） | () |

#### E. 工具 / Worker 下沉（17 个，错误 = CoreError）

| 命令 | 输入 | 输出 | 备注 |
|---|---|---|---|
| core_check_command | cmd, args | GatekeeperResult | **W-1 修复**（T03.6） |
| core_search_files | query, limit? | Vec\<FileHit\> | String → CoreError |
| core_rebuild_search_index | root | RebuildSearchIndexResponse { fileCount } | String → CoreError |
| core_compact_messages | messages, maxTokens | CompactionResult | String → CoreError |
| core_count_tokens | text | usize | String → CoreError |
| core_compute_diff | oldText, newText | DiffResult | String → CoreError |
| core_hash_compute | data, algorithm? | String(hex) | 已 CoreError |
| core_base64_encode | data, config? | String | 已 CoreError |
| core_base64_decode | encoded, config? | Vec\<u8\> | 已 CoreError |
| core_detect_encoding | data | EncodingDetectResult { encoding, confidence, hasBom } | 已 CoreError |
| core_decode_text | data, encoding? | String | 已 CoreError |
| core_parse_diff | unifiedDiff, maxLines? | DiffResult | 已 CoreError |
| core_messages_to_jsonl | messages | String(JSONL) | 已 CoreError |
| core_jsonl_to_messages | text | Vec\<Value\> | 已 CoreError |
| core_text_encode | text, encoding? | Vec\<u8\> | 已 CoreError |
| **core_jsonl_append**（perf_jsonl_append） | path, data | () | 迁移 + 去 fsync 语义待定（T03.3） |
| **core_list_commands** | （无） | CommandManifest { version, commands: [...] } | **新增**（T03.1） |

### 2.3 GUI 专属面正式清单（16 + PE-07 新增 5，错误 = CoreError）

> 冻结日基线 16 个；PE-07 新增 5 个（workbench_git_run / workbench_fs_delete_file /
> workbench_open_workspace / workbench_list_workspaces / workbench_dev_mcp_enabled）按 §7.2 登记表
> 增量并入，仅登记 manifest/契约，本域不定义其签名。

| 命令 | 输入 | 输出 | 处置 |
|---|---|---|---|
| workbench_run_shell | request { command, cwd?, timeoutMs? } | WorkbenchRunShellResult { ok, stdout, stderr, shell, cwd, durationMs, truncated } | String → CoreError |
| workbench_pty_create | sessionKey, cols, rows, cwd? | PtyCreateResult { ptyId } | String → CoreError；cwd 语义对齐（S-12） |
| workbench_pty_write | ptyId, data（≤64KiB） | () | 同上 |
| workbench_pty_resize | ptyId, cols, rows | () | 同上 |
| workbench_pty_kill | ptyId | () | 同上 |
| workbench_list_host_openers | （无） | Vec\<HostOpener\> | HostOpenerError → CoreError |
| workbench_open_host_target | openerId, target | HostOpenResult | 同上 |
| workbench_open_path_default | path | HostOpenResult | 同上 |
| workbench_list_file_openers | path | Vec\<HostOpener\> | 同上 |
| workbench_select_folder（select_folder） | （无） | SelectFolderResult { path } | 更名（前缀统一） |
| workbench_list_directory（list_directory） | path, workspaceRoot? | ListDirectoryResult（items…） | 更名 + FileCommandError → CoreError |
| workbench_read_file_content（read_file_content） | path, maxLines?, workspaceRoot? | ReadFileContentResult { content, lineCount, truncated } | 更名 + 错误收敛 |
| workbench_write_file_content（write_file_content） | path, content, workspaceRoot? | WriteFileContentResult | 更名 + 错误收敛 |
| workbench_discover_skills | workspacePath?, extraDirs | Vec\<RustSkill\> | String → CoreError |
| workbench_http_request | url, method(GET/POST/HEAD), headers?, body? | { ok, status, body } | String → CoreError；加长度限制（S-14） |
| workbench_apply_update | （无） | { ok } 或显式不可用错误 | **改 stub 语义**（S-4）：未配置 updater 时返回 NotFound，前端不得展示「更新成功」 |

> GUI 专属事件通道：workbench://pty-output { ptyId, data }、workbench://pty-exit { ptyId, exitCode? }。

### 2.4 事件通道与错误协议规范

#### 2.4.1 事件通道（引擎契约面）

| 通道 | 载荷 | 语义 |
|---|---|---|
| workbench-run-event（emit） | 完整事件 JSON { type, runId, sessionId, sequence, ...事件字段 } | 03 §5.1 16 类事件；背压缓冲（buffer.rs Delta→Soft→Critical 三级丢帧）；TUI 订阅同一通道 |

#### 2.4.2 错误协议（唯一协议）

- **IPC invoke 同步错误 = CoreError `{kind, detail}`**（conex-types/src/lib.rs:245-258，6 kinds），
  serde 序列化为 `{kind: "InvalidInput"|"Encoding"|"Io"|"NotFound"|"Cancelled"|"Internal", detail: string|null}`。
- 全部 64 个命令 `Result<_, CoreError>`；String / FileCommandError / HostOpenerError 一律收敛。
- **error_bridge.rs 裁决（AU-04 F8，冻结 v1）**：整个模块删除。理由：03 §5.3-5 已定 CoreError 为 IPC 协议，
  tauriInvoke.extractErrorKind 已对齐；CrishErrorPayload（77 码）仅用于未来 web 网关 HTTP 层映射，
  不在 IPC 面引入。**执行时序（F8）**：PE-04 T04.1-4 先把 `safe_invoke_sync` 的 catch_unwind 防爆语义
  迁入 `core_error.rs`（命令层包装），迁移完成后本任务（T03.3 动作 3）整体删除模块——同一提交链，禁止并行。
- **Q30 边界（AU-04 D8）**：`From<CoreError> for CrishError` 的有损实现删除归 **PE-06 T06.5.4**（类型边界），
  本任务只负责 `core_error_code` 显式映射（T03.3 动作 1，映射边界），PE-04 不落 conex-types/error.rs。
- **77 码对齐**：在 conex-types 新增 `pub fn core_error_code(err: &CoreError) -> &'static str`，
  映射表成文（单一真源，禁止散落 map_err）：

| CoreError kind | 77 码 registry 主码 | 说明 |
|---|---|---|
| InvalidInput | common.invalid_input（注册缺失则新增并登记） | 参数校验 |
| Encoding | common.encoding | 编解码失败 |
| Io | store.io | 存储/IO 失败（携带操作名） |
| NotFound | common.not_found | 资源缺失 |
| Cancelled | runtime.aborted | 取消 |
| Internal | common.unknown | 兜底（detail 必填原始错误） |

- 前端 InvokeError{kind,message,raw} 不变；`invokeResult` 删除后调用方必须显式处理 missing/error。

### 2.5 契约文档格式规范（TUI 输入文档标准）

T03.9 产出的独立契约文档 `docs/rust-rewrite/contracts/engine-ipc-contract.md`，每命令条目格式：

```
## <命令名>  <族> <版本:since|changed|removed>

输入：
| 字段 | 类型 | 必填 | 默认 | 约束/校验 |
输出（JSON 示例）：
```json
{ ... }
```
错误：
| kind | 触发条件 | detail 示例 |
事件关联：<该命令触发的 workbench-run-event 事件列表>
```

配套约束：
1. 契约文档内容 = core_list_commands manifest 的人工可读投影，两者必须一致（T03.8 契约测试断言）。
2. 契约版本号 semver；变更记录表（版本 | 命令 | 变更类型 | 说明 | 依据文档）。
3. 契约冻结后，TUI 只依赖契约文档 + manifest；GUI 专属面条目在文档中标记 `gui-only`。
4. 机器可读 manifest 结构：

```json
{
  "contractVersion": "1.0.0",
  "commands": [
    { "name": "core_run_task", "family": "core", "surface": "engine",
      "version": "1.0.0", "inputs": ["runId","sessionId","prompt?..."],
      "output": "RunTaskResponse", "errorKinds": ["InvalidInput","NotFound","Io"] }
  ]
}
```

---

## 3. 任务分解（T03.x）

> 编号沿用 23 号方案 E3 系列（T03.x 为本域细化）；每任务含 输入/动作/验收/依赖。
> 全部重命名/删除前必须先 grep 消费方，grep 零残留为删除验收门槛（23 §4）。

### T03.1 命令注册表单一化（E3.1）

- **目标**：Rust 侧为命令面唯一真源；前端 commandMap 由清单驱动；幽灵条目消失。
- **动作**：
  1. Rust：把 make_handlers! 的注册表改造为「注册 = 声明清单」——每个命令声明 { name, family, surface, version, inputs }；
     生成 `CommandManifest` 常量（编译期，含当前注册面全部命令，条数随面稳定，公式化断言见验收）。
  2. Rust：新增 `core_list_commands` 命令返回 manifest JSON（启动即可用，无状态依赖）。
  3. 前端：commandMap.ts 重构——`WS_TYPE_TO_TAURI_COMMAND` 改为由 manifest 驱动：
     - 启动时 `core_list_commands` 拉取清单并缓存；失败回退内置 snapshot（编译期生成的 commands.generated.ts）；
     - `resolveTauriCommand` 校验命令名必须在清单内，不在 → 返回 null（显式 missing）；
     - 删除 9 条幽灵条目（workbench_git_status / workbench_git_diff / workbench_list_mcp_servers /
       workbench_start_mcp_server / workbench_stop_mcp_server / workbench_preview_conversation_rewind /
       workbench_apply_conversation_rewind / workbench_send_to_subagent / workbench_get_subagent_status）；
     - RUN_LIFECYCLE_COMMANDS 与 KNOWN_COMMAND_PREFIX 白名单删除（清单校验取代前缀正则）；
     - **吸收 PE-01 原定的 `'update-config'` → `config_update` 映射变更**（AU-04 C19：本任务重构先行，
       PE-01 T03.1 已改引用本任务，不再自行改 commandMap）。
  4. 生成物：`apps/agent-workbench/src-tauri` 下新增 `command_manifest.rs`（含测试：清单与 make_handlers! 注册一致）。
  5. 新增命令登记：9 条新增命令（§7.2 登记表：upsert_session_entry / append_session_messages /
     config_profile_apply / config_secret_reveal / workbench_git_run / workbench_fs_delete_file /
     workbench_open_workspace / workbench_list_workspaces / workbench_dev_mcp_enabled）全部登记 manifest
     （实现方各自负责，登记先行）。
- **验收**：`core_list_commands` 返回条数 == **当前注册面**，且与 make_handlers! 一致（公式化表述，
  AU-04 F12-C13，删除硬编码 64）；前端无幽灵条目；commandMap.test.ts 改为 mock 清单后全绿；
  grep `workbench_git_status|workbench_send_to_subagent` 前端零命中；9 条新增命令 manifest 登记齐备。
- **依赖**：无（本轮首任务）。

### T03.2 调用方式统一（E3.2）

- **目标**：25+ 处直接 invoke 收敛单通道；旧 invokeResult/invokeCmd 删除。
- **动作**：
  1. transport 层新增唯一入口 `transport.call<T>(cmd, args): Promise<InvokeTypedResult<T>>`
     （tauriTransport.ts 内实现：manifest 校验 → invoke → 错误提取 → 暂态重试一次，与现有 request 行为合并）；
     `request(wsType, payload)` 保留为 WS 语义薄包装（内部调 call）。
  2. 直调点迁移（全部改为 transport.call 或经 commandMap 的 request）：
     - rustCore.ts 25 处（core_*/md_* 直调）→ `transport.call`；
     - sessionRustDb.ts 11 处（list_sessions 等）→ 同上；
     - workspaceFsApi / hostOpenersApi / ptySessionApi / terminalShellApi / skillsApi / modelCatalog /
       updateStore / TelemetryMonitor / importFsHost → 同上（命令名进 manifest 白名单）；
     - tauriTransport.ts:211 waitUntilConnected 内部直调 → 复用 call（消除第 ④ 类）。
  3. tauriInvoke.ts：删除 `invokeResult`、`invokeCmd`、`tryInvokeTauri`；`invokeTyped` 改为 transport.call
     的内部实现（禁止页面代码直接 import）；`invokeCmdStrict` 保留（严格抛错语义）。
  4. 类型收益：以 manifest 生成 TS 命令名联合类型，直调点获得编译期命令名检查。
- **验收**：grep `invokeResult|invokeCmd\b` 前端 src 零命中；git grep `invokeTyped` 仅 transport 内部；
  vitest transport 套件全绿。
- **依赖**：T03.1（manifest 校验）。

### T03.3 错误协议统一（E3.3）

- **目标**：全命令 CoreError；String 错误返回清零；77 码映射成文。
- **动作**：
  1. conex-types：新增 `core_error_code(&CoreError) -> &'static str`（§2.4.2 映射表）+ 单元测试
     （6 kind × 全码表存在性、主码唯一性）。`From<CoreError> for CrishError` 的类型删除归
     **PE-06 T06.5.4** 执行（AU-04 D8 边界：本任务只做显式映射函数，不落类型删除）。
  2. Rust 命令改造（String → CoreError），逐域：
     - core_commands 旧 6 个（search_files / rebuild_search_index / compact_messages / count_tokens /
       check_command / compute_diff）；
     - perf 迁移（core_jsonl_append 等，若保留 fsync 语义则改 spawn_blocking + 错误映射，S-9）；
     - config 命令按 **F5 终态表**改造（config_get/config_update/config_secret_*，T03.4/T03.5 同步执行）；
     - fs_commands 5 个（FileCommandError → CoreError：code 字段映射到 detail，如
       traversal-denied → InvalidInput）；
     - pty 4 / process 1 / power（若保留）/ host_openers 4（HostOpenerError → CoreError）/ commands 2。
  3. 删除 error_bridge.rs 整个模块（含 map_string_err/map_core_err/map_io_err/map_db_err/safe_invoke_sync），
     引用点全部改直接返回 CoreError。**时序（AU-04 F8）**：须在 PE-04 T04.1-4 完成
     catch_unwind 语义迁移进 `core_error.rs` 之后执行（同一提交链，禁止并行）。
  4. 参数校验 helper 落地（S-15/S-16）：trim + 长度上限 + 显式 InvalidInput，覆盖 run_id/session_id/
     api_key/url（sanitize 对齐 config/persistence.rs:87-104 既有模式）。
  5. **fs 命令治理（AU-04 认领表 #8）**：`workbench_list_directory` 增加分页上限；
     `read_file_content` / `write_file_content` 改 spawn_blocking（同步阻塞消除）。
  6. 前端：确认 extractErrorKind 兼容全部命令（String 分支删除或保留为防御）；perf_jsonl_append 调用点
     （TelemetryMonitor.ts:103）改 core_jsonl_append + invokeTyped 显式错误。
- **验收**：grep `Result<_, String>` src-tauri 命令面零命中（内部非命令函数不受限）；
  cargo test 新增错误协议用例（每命令 1 成功 + 1 错误 golden，T03.8 统一）；
  error_bridge.rs 删除。
- **依赖**：T03.2（前端调用面已收敛，错误路径改动不炸面）；与 T03.4 同轮执行。

### T03.4 命名规范化（E3.4）

- **目标**：前缀统一（引擎契约面 core_*/config_*/session_*；GUI 面 workbench_*）；daemon 残留清除。
- **动作**（重命名总表，含前端调用点）：
  1. `update_daemon_config` → `config_update`（commandMap 'update-config' 映射同步改；engineConfig.ts）。
  2. `get_api_config` → `config_get`；`save_api_config` 删除（T03.5 判定）。
  3. `workbench_profile_secret_*` ×4 → `config_secret_*` ×4。
  4. `md_render` → `core_md_render`，`md_render_batch` → `core_md_render_batch`，
     `md_render_stream` → `core_md_render_stream`，`highlight_code` → `core_highlight_code`，
     `md_clear_cache` → `core_md_clear_cache`（调用点：rustCore.ts、markdownPreload.ts、
     codeHighlight.ts、AsyncMarkdownBlock.tsx）。
  5. `select_folder` → `workbench_select_folder`，`list_directory` → `workbench_list_directory`，
     `read_file_content` → `workbench_read_file_content`，`write_file_content` → `workbench_write_file_content`
     （调用点：workspaceFsApi.ts、importFsHost.ts、desktopNativeFeatures.ts）。
  6. `perf_jsonl_append` → `core_jsonl_append`；其余 perf_* 注册删除（T03.5）。
  7. daemon 残留字段/代码清理：`sentToDaemon` 字段（config/provider.rs:488-498）、`daemon_api_key_source`、
     `ApiKeySource::daemon_value`、`register_active_run`/`unregister_active_run`（process.rs:104-133，S-3）、
     core_commands.rs:157-172 旧 core_get_status 死代码（S-20）。
- **验收**：grep `update_daemon_config|sentToDaemon|daemon_api_key_source|perf_|md_render\b` 前端与 src-tauri
  零命中（注释除外）；typecheck + vitest 全绿。
- **依赖**：T03.1（manifest 先行，重命名以 manifest 为真源）。备选（严格 core_* 全前缀）：另重命名
  session_* → core_*（11 个）与 config_* → core_config_*（6 个），成本约 +1 轮 Agent，非默认。

### T03.5 死面清理（E3.5）

- **目标**：20 个死面命令逐一裁决；7 个配置命令接入前端或删除。
- **裁决表**（20 死面 + 7 既有配置命令 + 2 新增登记；配置族命名终态 = AU-04 F5 冻结表 v1）：

| 命令 | 裁决 | 落点 |
|---|---|---|
| save_api_config | **删除** | 写路径并入 config_update |
| get_api_config | **更名 config_get + 接线** | engineConfig.fetchEngineStatus 消费 provider 详情（与 E1.1 互斥兼容：status 缺字段时以 config_get 补齐） |
| workbench_profile_secret_set | **更名 config_secret_set + 接线** | 设置页密钥保存（SettingsProfileTab / provider-profiles 保存路径改走命令） |
| workbench_profile_secret_get | **更名 config_secret_get + 接线** | 设置页展示 / 本地草稿迁移读取；**默认仅回 { hasKey, apiKeyLast4 }**（K-02，语义由 PE-07 T07.4-C 定稿，本任务不定义第二形状） |
| workbench_profile_secret_has | **更名 config_secret_has + 接线** | engineStatus/engineConfig 的 hasApiKey 判定改走命令（替代 localStorage 判定，25 §4.1.2 配合） |
| workbench_profile_secret_clear | **更名 config_secret_clear + 接线** | 设置页清除密钥 |
| config_profile_apply（workbench_profile_apply，PE-07 新） | **登记**（终态名，F5） | 进程内读 DPAPI 直写 ApiConfigStore，返回 { ok, apiKeyLast4, model }；实现归 **PE-07 T07.4**，本任务只登记 manifest/契约 |
| config_secret_reveal（workbench_profile_secret_reveal，PE-07 新） | **登记**（终态名，F5） | 带一次性 UI 确认参数回明文；语义由 **PE-07 T07.4-C** 定，本任务登记 |
| workbench_performance_snapshot | **删除** | H2 运行条改由 core_get_status.activeRuns 提供（T03.1 字段回补后）；删除 active_runs 注册表 |
| workbench_set_keep_awake | **删除注册** | power.rs 内部实现与测试保留（不挂 #[tauri::command]），无 UI 入口；TUI 不需要 |
| perf_hash_compute / perf_base64_encode / perf_base64_decode | **删除注册** | 实现降为内部 fn（core_* 复用），去 #[tauri::command]（S-2） |
| perf_encoding_detect / perf_encoding_decode | **删除注册** | 同上 |
| perf_diff_parse | **删除注册** | 同上 |
| perf_jsonl_read / perf_jsonl_write | **删除注册** | 实现降为内部 fn 或整体删除（无 core_* 对应，grep 确认零引用） |
| perf_fs_read_chunk / perf_fs_file_info / perf_fs_watch_start / perf_fs_watch_stop | **删除注册** | 同上 |
| perf_encoding_encode（未注册，S-19） | **删除定义** | 与 core_text_encode 重叠 |

- **动作**：
  1. 按上表执行 Rust 侧注册删除/更名（与 T03.4 同步）。
  2. 配置命令接线（6 个更名后的）：前端 provider-profiles 与设置页改走 config_get/config_update/config_secret_*；
     localStorage `crish_provider_profiles_v1` 明文字段降级为「本地草稿」（完整真源迁移归 E1.3，本任务只保证
     命令不再是死面，不做存储迁移）。
  3. 清理连带死代码：error_bridge.rs（T03.3）、WorkbenchRunTaskRequest（commands.rs:5-28，S-4）。
  4. workbench_apply_update：stub 恒 ok 改为显式不可用错误（未配置 updater → CoreError::NotFound），
     updateStore.ts 展示「更新不可用」而非成功提示。
- **验收**：main.rs 注册面无死面命令；grep `save_api_config|workbench_performance_snapshot|workbench_set_keep_awake|perf_` 
  注册面零命中；6 个配置命令均有前端调用点。
- **依赖**：T03.4（更名先行）。

### T03.6 core_check_command 修复（W-1）

- **目标**：命令可用；gatekeeper 单一实例；前端不再静默兜底。
- **动作**：
  1. main.rs setup 增加 `app.manage(core_commands::SharedGatekeeper::new())`（当前只 manage 了
     SharedSearchState / SharedDb / CoreRunState）。
  2. gatekeeper 单例化：process.rs:420、host_openers/execute.rs:60/131/203 三处 `CommandGatekeeper::new()`
     改为注入同一 SharedGatekeeper（经 State 读取），行为收敛为一份规则。
  3. core_check_command 错误协议随 T03.3 收敛 CoreError（GatekeeperResult 正常返回，内部失败 → Internal）。
  4. 前端 rustCore.ts:97-103：删除 `invokeCmd` 静默 `'Allowed'` 兜底，改 invokeTyped 显式处理——
     missing/error 时向调用方暴露真实状态（准予展示「命令检查不可用」），不得假装通过。
- **验收**：命令在 Tauri 环境实测返回 GatekeeperResult 而非 state 错误；前端无静默 Allowed 兜底；
  grep `'Allowed'` rustCore.ts 相关兜底删除。
- **依赖**：无（可最早并行；错误协议部分随 T03.3）。

### T03.7 不可用调用点最终裁决（E3.5 后半）

- **目标**：③ 类 22 处逐一裁决（回补 or 删除调用+降级），消除「静默降级」心智。
- **裁决表**（依据 21-phase-c-migration-log.md §1，38 处调用点中 ③ 类 22 处）：

| 调用点 | WS type | 裁决 | 落点 |
|---|---|---|---|
| mcpApi.ts:229 | list-capabilities | **回补**（并入 core_get_status.mcpStatus） | mcpApi.fetchMcpStatus 改读 core_get_status；删除 transport 'list-capabilities' 分支与降级壳 |
| clientApi.ts:848/863/873、workflowRunner.ts:40/77/108/129/152/205 | list/create/delete/update/trigger-workflow、list-workflow-runs（9 处） | **删除调用 + 删除降级壳** | Tauri 下无 workflow 引擎；删除 transport 分支与空表降级，UI 入口隐藏（产品确认后） |
| rulesApi.ts:50/60、skillsApi.ts:547/554 | upsert/delete-scoped-context（4 处） | **删除调用 + 显式本地-only** | scoped-context 仅前端本地保存；删除 daemonSynced 字段与降级逻辑 |
| modelCatalog.ts:706/843 | probe-provider-models / probe-provider-chat（2 处） | **删除调用 + 显式 HTTP 直连** | 既有 HTTP 兜底升为唯一路径（删除「先 transport 后兜底」双路径） |
| schedule.ts:26/42/53 | cron.list_tasks / upsert_task / delete_task（3 处） | **删除调用 + UI 标注不可用** | 删除空表降级；调度入口隐藏或标注（产品确认后） |
| SessionSyncService.ts:182 | sync-pull / sync-push（2 处） | **删除** | Tauri 下会话即本地 SQLite，同步概念不存在；删除 pullUnsupported 停表逻辑，SessionSyncService 收归 sessionRustDb 本地读写（或删除 service） |

- **动作**：
  1. 每处先 grep 确认调用方与降级分支行号；删除 transport 分支后，降级代码若成为死路径一并删除。
  2. 删除涉及 UI 入口的（workflow/cron/rewind/subagent）——需要时降级为「入口隐藏 + 控制台注明」，不做
     灰色展示。
  3. 回补项（list-capabilities）与 E1.1（core_get_status 字段回补）分工：**本任务只做 mcpStatus 并入**；
     providerStatus/activeRuns/pendingApprovals 回补归 E1 轮（23 方案 E1.1），两轮并行时以 25 §4.1 为准。
- **验收**：grep `list-workflows|cron\.|sync-pull|sync-push|scoped-context` transport/request 分支零命中；
  Tauri 路径无「静默降级」残留（显式 missing 处理或显式本机路径）。
- **依赖**：T03.1（manifest 使 missing 显式化）。

### T03.8 契约测试（E7.2）

- **目标**：命令签名/响应/错误 golden 测试，与界面完全解耦，TUI 复用。
- **动作**：
  1. Rust：`apps/agent-workbench/src-tauri/tests/ipc_contract/` 集成测试——命令函数直调
     （构造 State，不依赖 Tauri runtime），逐命令：
     - 成功路径 golden：请求参数 → 响应 JSON，快照比对 `tests/ipc_contract/golden/<cmd>.ok.json`；
     - 错误路径 golden：典型错误输入 → `{kind, detail}` 快照 `<cmd>.err.json`；
      - 覆盖：查询 4 / run 5 / session 11→13 / config 6→8 / core_md 5 / 工具 17 / GUI 面抽 8 代表命令
        （run_shell、pty_create、list_directory、read_file_content、host_openers×1、http_request、apply_update、discover_skills）；
        各域条数随注册面实计数调整（新增命令按 §7.2 登记表补齐 golden）；
     - 事件通道：core_run_task 冒烟 → 断言 workbench-run-event 载荷结构（复用 buffer.rs 既有测试基建）。
  2. 清单一致性断言：`core_list_commands` 输出与契约文档命令集一致（T03.9 联动）。
  3. 前端：golden fixture 复用 Rust 快照（vitest 读取同一 JSON 目录，双端单一真源）；
     commandMap/transport/tauriInvoke 测试按 manifest mock 重写。
  4. 冒烟（E7.3 前置）：契约面直连测试——不启动前端，直接 core_run_task + 订阅事件通道
     验证 run 全旅程（模拟 TUI 客户端行为）。
- **验收**：`cargo test --workspace` 含新增契约套件全绿；golden 变更必须显式更新快照文件
  （拒绝隐式改动）；前端契约相关 vitest 全绿。
- **依赖**：T03.1-T03.5、T03.7 全部落地（契约冻结前置）。

### T03.9 契约文档固化（E7.1）

- **目标**：§2 契约面定义固化为独立文档 + 版本化 changelog，作为 TUI 开发输入。
- **动作**：
  1. 产出 `docs/rust-rewrite/contracts/engine-ipc-contract.md`（§2.5 格式规范逐命令展开）。
  2. 契约版本 `1.0.0` 冻结；changelog 段建立（版本 | 命令 | 变更类型 | 说明 | 依据）。
  3. 与 core_list_commands manifest 一致性由 T03.8 测试断言；后续任何命令变更必须同步
     manifest + 契约文档 + changelog（列入 00 主方案轮次验收标准）。
  4. **冻结时序（AU-04 F12-C13）**：契约冻结排在全部命令面稳定之后——含 9 条新增命令（§7.2 登记表）
     登记齐备、error_bridge 删除（F8）、config 终态表（F5）落地之后；
     事件载荷版本化作为同一契约文档扩展，见 T03.10（AU-04 F11，不新建第二套机制）。
- **验收**：契约文档覆盖全部当前注册面命令 + 事件通道 + 错误协议；TUI 团队凭文档可独立实现客户端。
- **依赖**：T03.8。

### T03.10 事件 schema 版本化（AU-04 F11，新增任务）

- **目标**：补 AgentEvent wire 形状 / SQLite payload 的版本化空白（AU-02 §五-5）；
  与 T03.9 的 manifest + changelog 同一契约文档扩展，**不新建第二套机制**（F11）。
- **动作**：
  1. 在 `docs/rust-rewrite/contracts/engine-ipc-contract.md` 增加「事件载荷版本化」章节：
     AgentEvent 形状演进 changelog（版本 | 事件类型 | 字段变更 | 说明）；
  2. 旧事件 JSON 兼容解析测试：历史版本事件样本（v1/v2/v3 fixture）经 `serde` 可解析，
     未知字段策略（忽略或显式 reject）成文并单测锁定；
  3. 双端 golden：前端解析层与持久化层（conex-db events 表 payload）各一套事件样本快照，
     双端一致（wire 不变守门）；
  4. 协作声明：PE-08 提供 v3 旧事件 fixture 样本（历史库反代）；
     PE-09 T09.2/T09.3.2 roundtrip 测试作 wire 不变守门（协作任务书，不改签名）。
- **验收**：changelog 覆盖 AgentEvent 形状演进；旧事件 JSON 兼容解析测试全绿；
  双端 golden 一致；PE-09 roundtrip 回归不破。
- **依赖**：T03.9（同一契约文档扩展，可同轮或后置）；协作依赖 PE-08（fixture）、PE-09（roundtrip）。

---

## 4. 风险与缓解

| # | 风险 | 影响面 | 缓解 |
|---|---|---|---|
| R1 | **删除影响面**：perf/配置/进程命令删除前若调用点漏迁移，运行时直接报错 | TelemetryMonitor（perf_jsonl_append）、H2 运行条（performance_snapshot 字段）、updateStore（apply_update stub） | 删除顺序固定：先迁移消费方（T03.2/T03.5 动作 2）后删注册；每轮 grep 零残留门禁 |
| R2 | **前端降级路径破坏**：manifest 校验使 missing 从「静默 catch 兜底」变「显式错误」，既有降级分支触发条件改变 | gitApi 本机 fallback、mcpApi configured:false、subagent/rewind 静默失败、workflow/cron 空表 | T03.7 逐点重写降级为显式路径；CI 增加「missing 不再静默」的断言用例；UI 入口隐藏需产品确认 |
| R3 | **invokeResult 三态→两态语义变化**：调用方原本靠 null 合并 missing/error | rustCore/sessionRustDb 等 25+ 处 | T03.2 迁移时逐点确认错误语义；typecheck + vitest 门禁 |
| R4 | **重命名回归**：38 个命令名变更若前端漏改调用点 | 全部前端调用面 | manifest 白名单编译期检查（T03.1）；grep 总表（§3.4 每行列调用点）；T03.8 golden 兜底 |
| R5 | **契约冻结与并行轮冲突**：E2.5 可能删除 md_render_stream；E1.1 与 T03.7 的 status 字段回补重叠 | core_md_render_stream golden、core_get_status 形状 | core_md_render_stream 标记「E2.5 待裁决」不进契约文档主表（附录）；status 回补按 §3.7 分工边界 |
| R6 | **77 码映射有损**（InvalidInput→common.unsupported 语义存疑，AA-01 Q30） | web 网关未来接入 | 映射表成文 + detail 保留原始信息；conex-types 单测强制映射总覆盖 |
| R7 | **error_bridge 删除方向冲突**：26 号审计 §5.3.2 建议接线 error_bridge，本方案裁决删除 | 可观测性改造（E4） | 本方案以 03 §5.3-5 + AA-02 S-5 为准：IPC 面 CoreError，77 码只经 core_error_code 显式映射；与 E4.3 的 CrishError 下沉分工明确 |
| R8 | **配置命令接线后双真源竞争**：localStorage 草稿 vs Rust ApiConfigStore | 设置页/密钥状态 | 本任务只接线不改真源；真源迁移归 E1.3；接线期间以 Rust 侧为读优先，localStorage 降级为草稿 |
| R9 | **workflow/cron/sync UI 移除的用户可见影响** | 产品功能面 | 产品确认表（§3.7 标注处）；确认前一律「隐藏入口」而非「删除功能文件」（保留前端本地实现文件） |

---

## 5. 执行顺序

> 每轮 ≤12 Agent（00 主方案 §1）；轮内并行任务互不依赖；每轮结束跑验证门槛。

| 轮 | 任务 | 并行 Agent | 验证门槛 |
|---|---|---|---|
| P0 | T03.6 core_check_command 修复（独立小改） | 1 | cargo test；前端 checkCommand 显式错误路径 vitest |
| P1 | T03.1 注册表单一化（manifest + core_list_commands + 前端清单驱动） | 2（Rust / 前端） | cargo test；commandMap/transport vitest；typecheck |
| P2 | T03.2 调用统一（前端）+ T03.4 命名定稿表（文档先行，供 T03.4 落地引用） | 2 | grep 零残留（invokeResult/invokeCmd）；vitest |
| P3 | T03.3 错误协议统一（Rust）+ T03.4 命名落地（Rust+前端，与 T03.3 同轮合并批量改） | 3（错误收敛 / 重命名 / 前端适配） | cargo test（含新增错误用例）；grep 总表零残留；typecheck；vitest |
| P4 | T03.5 死面清理 + T03.7 不可用调用点裁决（并行两个 Agent） | 4（配置接线 / 死面删除 / ③ 类前端 / ③ 类 Rust） | grep 零残留清单（§3.5/§3.7 验收）；UI 隐藏项截图确认 |
| P5 | T03.8 契约测试（Rust golden + 前端 fixture + 直连冒烟） | 2 | cargo test 契约套件；vitest 契约相关；快照目录 diff 审查 |
| P6 | T03.9 契约文档固化 + changelog 建立 | 1 | 文档 ↔ manifest 一致性测试通过；契约版本 1.0.0 冻结 |
| P7 | T03.10 事件 schema 版本化（T03.9 契约文档扩展） | 1 | 旧事件兼容解析测试全绿；双端 golden 一致 |

依赖链：T03.6 无依赖（可并入 P0）；T03.1 → T03.2 → T03.3/T03.4 → T03.5/T03.7 → T03.8 → T03.9 → T03.10。
**跨域主执行顺序（AU-04 附录冻结）**：main.rs 六方串行 **PE-01 → PE-03 → PE-04 → PE-08 → PE-09 → PE-07**；
core_query_commands.rs 串行 PE-01（字段基线）→ PE-03（activeRuns/pendingApprovals/mcpStatus）→
PE-04（logLevel/logDir/diagnostics/lastError）→ PE-08（restore/snapshot）；commandMap.ts 本域 T03.1
重构先行（C19，吸收 PE-01 映射变更）；tauriTransport.ts 由 PE-01 T02.3 先行（C20）。
跨域协作：与 E1 轮（E1.1 core_get_status 字段回补、E1.3 真源迁移）按 §3.7 分工；与 E2 轮（E2.5
md_render_stream 裁决）冲突按 R5 处理；E7.3 冒烟由 T03.8 承接，E5.5 命名债务中与 daemon 相关的
前端文件重命名不属本域（前端文件重命名归 E5）。

---

## 6. 验收与验证（总门禁）

1. **注册面**：`core_list_commands` 返回条数 == **当前注册面**，且与 make_handlers! 一致（公式化表述，
   AU-04 F12-C13，删除硬编码 64；冻结日基线 64 + 新增 9 条命令登记后 ≈73，契约测试断言）。
2. **grep 零残留**：
   - 幽灵条目：`workbench_git_status|workbench_git_diff|workbench_list_mcp_servers|workbench_start_mcp_server|workbench_stop_mcp_server|workbench_preview_conversation_rewind|workbench_apply_conversation_rewind|workbench_send_to_subagent|workbench_get_subagent_status`（前端 src 零命中）；
   - 死面：`save_api_config|workbench_performance_snapshot|workbench_set_keep_awake|perf_`（注册面零命中）；
   - 旧调用：`invokeResult|invokeCmd\b`（前端 src 零命中）；
   - daemon 残留：`update_daemon_config|sentToDaemon|daemon_api_key_source`（前后端零命中，注释除外）。
3. **错误协议**：src-tauri 命令签名 grep `Result<[^,]+(, )?String>` 零命中（命令面）；error_bridge.rs 删除。
4. **测试**：`cargo test --workspace`（含 ipc_contract golden + core_error_code 映射）全绿；
   `npx vitest run src/api/transport src/api/sessionRustDb` 等涉及套件全绿；`npm run typecheck` 通过。
5. **契约**：engine-ipc-contract.md 与 core_list_commands manifest 一致（T03.8 断言）；契约 1.0.0 冻结，
   变更走 changelog。

---

## 7. 附录

### 7.1 重命名总表（38 个变更，含删除）

| 旧名 | 新名 | 处置 | 前端调用点 |
|---|---|---|---|
| update_daemon_config | config_update | 更名 | commandMap 'update-config'、engineConfig.ts |
| get_api_config | config_get | 更名+接线 | engineConfig.ts（新增） |
| save_api_config | — | 删除 | 无 |
| workbench_profile_secret_set/get/has/clear | config_secret_set/get/has/clear | 更名+接线 | SettingsProfileTab / profileStore（新增） |
| workbench_profile_apply（PE-07 新） | config_profile_apply | 新增登记（F5） | provider-profiles（PE-01 T03.4 用户主动路径引用） |
| workbench_profile_secret_reveal（PE-07 新） | config_secret_reveal | 新增登记（F5） | 设置页密钥展示（PE-07 T07.4-C） |
| md_render / md_render_batch / md_render_stream | core_md_render / core_md_render_batch / core_md_render_stream | 更名 | rustCore.ts、markdownPreload.ts、AsyncMarkdownBlock.tsx |
| highlight_code | core_highlight_code | 更名 | codeHighlight.ts |
| md_clear_cache | core_md_clear_cache | 更名 | rustCore.ts |
| select_folder / list_directory / read_file_content / write_file_content | workbench_select_folder / workbench_list_directory / workbench_read_file_content / workbench_write_file_content | 更名 | workspaceFsApi.ts、importFsHost.ts、desktopNativeFeatures.ts |
| perf_jsonl_append | core_jsonl_append | 更名 | TelemetryMonitor.ts:103 |
| perf 其余 12 + perf_encoding_encode | — | 删除注册/定义 | 无 |
| workbench_performance_snapshot / workbench_set_keep_awake | — | 删除注册 | 无 |

### 7.2 命令数核算（公式化验收，AU-04 F12-C13）

> 验收一律以「`core_list_commands` 返回条数 == 当前注册面」公式化判定；下述数字为冻结日
> （2026-08-01）基线推算，仅作计划使用，**不作为硬编码断言**。

- 现状：78（§1.1 逐组计数）。
- 删除 15：save_api_config、workbench_performance_snapshot、workbench_set_keep_awake、
  perf 组 13 个（perf_jsonl_append 以 core_jsonl_append 更名复活，见下，故 perf 组注册面整体清零）。
- 新增 2（冻结日）：core_list_commands、core_jsonl_append（自 perf 迁移）。
- 复算：78 − 12（perf 组净删）− 3（save/performance/keep_awake）+ 1（core_list_commands）= **64**。
- **新增命令登记表（9 条，AU-04 F12-C13，全部登记 manifest + 契约 changelog，T03.9 冻结排在其后）**：

| 命令 | 终态名（v1） | 唯一负责 | 族 |
|---|---|---|---|
| upsert_session_entry | 同左 | PE-08 T08.1（F3） | session |
| append_session_messages | 同左 | PE-09 T09.4.1 第 1 条（F7） | session |
| config_profile_apply | 同左 | PE-07 T07.4（F5） | config |
| config_secret_reveal | 同左 | PE-07 T07.4-C（F5） | config |
| workbench_git_run | 同左 | PE-07 | GUI |
| workbench_fs_delete_file | 同左 | PE-07 | GUI |
| workbench_open_workspace | 同左 | PE-07 | GUI |
| workbench_list_workspaces | 同左 | PE-07 | GUI |
| workbench_dev_mcp_enabled | 同左（GUI 面保留 workbench_ 前缀） | PE-07 T07.5 | GUI |

- 冻结日推算终态 ≈ 64 + 9 = **73（以当前注册面实测为准）**。
- 分布（冻结日基线）：引擎契约面 48（查询 4 + run 5 + session 11→13 + config 6→8 + core_md 5 + 工具 17），
  GUI 专属面 16（process 1 + pty 4 + host 4 + fs 5 + 杂项 2 + PE-07 新增 5）。
