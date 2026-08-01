# AA-05 安全审查（命令注入 / 路径安全 / 凭据 / MCP / IPC / 数据 / XSS）

> 日期：2026-08-01 · 范围：crates/agent-tools（shell/fs/search/mcp）、crates/conex-sandbox、crates/conex-db、crates/conex-markdown、apps/agent-workbench/src-tauri（pty/process/config/fs_commands/commands/core_*）、apps/crish-desktop（transport/gitApi/tauriInvoke/profileStore/markdown 渲染）· 只读审查，未改代码
> 结论摘要：agent-tools 侧（工具层）路径校验与 SQL 参数化扎实，但**权限边界整体依赖「webview 可信」假设**——Tauri 壳的 4 个文件命令把 workspace_root 作为调用方入参（任意文件读写）、红线门禁正则可被 `--`/分离 flag/-LiteralPath 变体绕过、前端把 API key 明文写入 localStorage、gitApi 以 shell 拼接执行 git（文件名/提交信息可注入）。另有 debug-only 的 TCP MCP 控制 socket（本机任意进程可 execute_js）。共 24 项问题（严重 2 / 高 3 / 中 9 / 低 10）。

---

## 一、总览

| 面 | 风险数 | 严重度分布 |
| --- | --- | --- |
| 1. 命令注入（门禁/壳/前端 git） | 4 | 严重 1、高 1、中 2 |
| 2. 路径安全（safe_canonicalize 覆盖面/沙箱根） | 3 | 严重 1、中 1、低 1 |
| 3. 凭据管理（DPAPI/localStorage/日志） | 5 | 高 1、中 1、低 3 |
| 4. MCP（server 配置/工具名前缀/入参） | 3 | 中 2、低 1 |
| 5. IPC 暴露面（Tauri 命令/权限模型一致性） | 5 | 高 1、中 3、低 1 |
| 6. 数据安全（conex-db SQL/完整性） | 2 | 低 2 |
| 7. 前端 XSS（markdown/innerHTML/存储暴露） | 2 | 低 2 |
| **合计** | **24** | **严重 2、高 3、中 9、低 10** |

---

## 二、问题清单

| 编号 | 文件:行号 | 严重度 | 漏洞描述 | 攻击场景 | 修复建议 |
| --- | --- | --- | --- | --- | --- |
| C-01 | crates/conex-sandbox/src/lib.rs:20-51（blocked_patterns）；调用点 crates/agent-tools/src/tools/shell.rs:106-123、apps/agent-workbench/src-tauri/src/process.rs:420-428、src/host_openers/execute.rs:60-71,131-142,203-213 | **严重** | 红线门禁为固定正则集合，可用参数语法变体绕过（已实测）：`rm -rf -- /`、`rm -r -f /`（分离 flag）、`Remove-Item -LiteralPath C:\Windows\win.ini -Force`（无 `-Recurse/-Path` 即不匹配）均判定 Allowed。门禁是 shell_command 工具与 workbench_run_shell 的唯一防线，绕过即完全失效。 | 恶意仓库（README/issue/构建脚本内容进入模型上下文，prompt injection）诱导模型执行 `shell_command(command:"rm -rf -- /")`——门禁放行 → bash 执行 → 根目录递归删除；或 `Remove-Item -LiteralPath C:\Users\me\.ssh\id_rsa -Force` 定向删文件。工作区内的恶意脚本被模型运行同样触发。 | 对 blocked 类命令改为「命令词 + 参数数组」解析式检查（解析出 argv 再逐项判定），覆盖 `--`、`-r -f` 分离形式、`-LiteralPath`、`cmd /c`/`pwsh -c` 包装变体；至少补入 `rm.*--`、`-LiteralPath`、`Invoke-Expression`、`Start-Process`、`iwr/curl \| iex` 模式；对无法可靠判定的高危词一律升级审批。 |
| C-02 | apps/crish-desktop/src/api/gitApi.ts:306-329（runLocalGit 拼接）、654-672（commitGitChanges）、675-706（stage/unstage/discardGitPath） | **高** | runLocalGit 用 `git -C ${q(cwd)} ${gitArgs.map(q).join(' ')}` 经 workbench_run_shell（PowerShell）执行，`q()` 仅对含空格的参数加引号，不转义 `; | & $ ( ) ` `` ` `` 等 PowerShell 元字符；参数（文件路径、提交信息）来自仓库内容或用户输入。 | 克隆含文件 `x;calc.exe` 或 `a$(whoami).txt` 的恶意仓库 → 变更面板点击「暂存该文件」（stageGitPath）→ 生成 `git -C "cwd" add -- x;calc.exe` → PowerShell 分号后执行 calc.exe。提交信息 `hello"; calc.exe"` 同理。 | 新增 Tauri 命令 `workbench_git_run(gitArgs: Vec<String>)`，Rust 侧 `std::process::Command::new("git").args(...)` 数组方式执行（不经 shell）；过渡期对每个参数做 PowerShell 强转义（`'`→`''`，`$`、`` ` ``、`;`、`|`、`&`、`(`、`)` 前缀反引号）。 |
| C-03 | apps/crish-desktop/src/api/reverseFileDiff.ts:44-64（deleteFileOnDisk） | 中 | Windows 分支 `Remove-Item -LiteralPath "${filePath.replace(/"/g,'""')}" -Force`：仅转义双引号，PowerShell 双引号内 `$(...)` 与反引号仍会被求值展开。 | 模型基于恶意仓库内容生成含 `$()` 的 diff 路径（如文件名 `a$(Start-Process calc).txt`）→ 撤回消息触发反向应用 → PowerShell 先执行 `$(...)` 内命令再拼路径。 | 删除文件改走新 Tauri 文件删除命令（`fs::remove_file` + 路径校验）；或改用单引号 PowerShell 字面量（`'` 翻倍转义），单引号内不做任何展开。 |
| C-04 | apps/agent-workbench/src-tauri/src/process.rs:408-428（workbench_run_shell 只查 blocked，不查 approval_patterns） | 中 | 终端面板命令只拦截 blocked 正则，审批类命令（`git push --force`、`sudo`、`npm publish`）直接放行；与 agent 侧 shell_command（越界→RequiresApproval）权限模型不一致。gitApi 本地 git（push 等）也走此通道。 | 终端面板输入 `git push --force origin main` 立即执行，无任何确认；`gitApi.pushGitChanges`（gitApi.ts:727-732）同样无审批。作为「用户主动输入」可接受，但被任何脚本（C-02 注入成功后）复用即成为无审批命令通道。 | 明确文档化终端=免审批通道（现状）；对 gitApi 的本地 git 执行改用 C-02 的新命令并限制参数集（禁用 `--force/-f` 类 flag 或转审批）；后续可在门禁层增加「审批模式开关」统一策略。 |
| P-01 | apps/agent-workbench/src-tauri/src/fs_commands/read.rs:13-20、write.rs:6-13、types.rs:93-98（from_optional_root）、mod.rs:17-41；perf/fs.rs:264-297（perf_fs_read_chunk/file_info/watch_start）；前端 workspaceFsApi.ts:91-103,148-180（workspaceRoot 取 localStorage `crish_workspace`） | **严重** | 沙箱根 `workspace_root` 完全由调用方（webview）传入：`read_file_content(path, workspaceRoot)`、`write_file_content(path, content, workspaceRoot)`、`perf_fs_read_chunk(path, offset, size, workspaceRoot)` 对任意根做 canonicalize+包含性检查——根本身可信，则**全盘任意文件读/写**。前端把 localStorage 的 `crish_workspace`（可由打开目录/设置决定）直接作为根传递。 | ① 任意 XSS 或 console 直调：`read_file_content({path:"C:\\Users\\me\\.ssh\\id_rsa", workspaceRoot:"C:\\"})` 读任意文件；`write_file_content({path:"C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\evil.bat", content:"...", workspaceRoot:"C:\\"})` 写启动项。② 恶意仓库诱导用户把 `crish_workspace` 指到系统目录后，前端自身逻辑即可越界读写。③ 与 K-01 明文 key 叠加：直接读 DPAPI 密文文件所在目录。 | workspace_root 改为服务端唯一真源：由 host_paths 派生（已打开项目集合），Tauri 命令签名去掉该参数；或在命令入口维护「已打开工作区路径白名单」校验入参根。perf_fs_* 同改。 |
| P-02 | crates/agent-tools/src/tools/mod.rs:128-183（resolve_workspace_path）覆盖面 | 低 | 工具层（read_file/write_file/list_dir/file_stat/grep_search/fuzzy_find/shell cwd）全部路径入参均过 resolve_workspace_path（`..` 拒绝 + safe_canonicalize + 符号链接解析后包含性 + 深度上限），**工具层无未校验路径面**。唯一残余：resolve_workspace_path 对 Windows drive-relative 路径（`C:foo`）会按 root 拼接处理，行为与 TS 端一致，非漏洞；Tauri 壳 `WorkspaceFsGuard::new`（types.rs:100-104）对根先 `canonicalize` 失败再 `safe_canonicalize` 失败再裸用——根不可达时守卫退化，但结合 P-01 根由调用方给，属次要。 | 无直接攻击场景（工具层路径安全已闭环）。残余为 P-01 的系统性修复后应删除 `from_optional_root` 的 caller 根路径。 | 修复 P-01 后删除 WorkspaceFsGuard 的 caller 根入口；增加「工具层路径校验」单测覆盖 drive-relative 与 UNC 变体。 |
| P-03 | apps/agent-workbench/src-tauri/src/process.rs:510-526（resolve_shell_cwd）、pty/session.rs:102-120 | 中 | 终端面板与 PTY 的 cwd 接受任意存在的目录（无工作区约束），且 workbench_run_shell 的 check_command 不带 context（cwd 越界不升级审批）。PTY 直接以该 cwd 启动交互 shell。 | 任意 XSS（或注入成功后）`workbench_pty_create({cwd:"C:\\"})` 获得系统根目录 shell；`workbench_run_shell({command:"dir", cwd:"C:\\Windows\\System32"})` 在任意目录执行（配合 C-01 门禁绕过 = 任意目录任意命令）。 | PTY/终端 cwd 收敛到工作区根集合（同 P-01 白名单）；check_command 改用 check_command_with_context 并把 cwd 传入。 |
| K-01 | apps/crish-desktop/src/api/provider-profiles/profileStore.ts:30,310-317（`crish_provider_profiles_v1` 存明文 apiKey）、store/provider/providerStore.ts:147-153（迁移仍读旧明文 key） | **高** | API key 明文写入 localStorage（`setProfileKey` → `saveProfiles` → JSON 含 `apiKey` 字段）。Rust 侧 DPAPI 加密存储形同虚设——同一份 key 同时明文躺在 localStorage。XSS 或任何注入脚本一条 `localStorage.getItem('crish_provider_profiles_v1')` 即得全部供应商密钥。 | 恶意仓库内容经 C-02 类注入或任意渲染面 XSS 后：`JSON.parse(localStorage.getItem('crish_provider_profiles_v1')).map(p=>p.apiKey)` 批量窃取密钥外传。 | setProfileKey 不再写明文：key 改经 `workbench_profile_secret_set`（DPAPI）保存，本地仅存 `hasKey:true`；迁移路径删除读明文旧 key 的逻辑；提供一次性「迁移旧明文 key 到 DPAPI 后清除」的升级步骤。 |
| K-02 | apps/agent-workbench/src-tauri/src/config/mod.rs:102-114（workbench_profile_secret_get 回传明文 apiKey） | 中 | 与 K-01 呼应：壳侧 get_api_config 快照已刻意只回 `apiKeyLast4`（provider.rs:276-301），但 `workbench_profile_secret_get` 仍把解密后的明文 key 整体回传 webview。前端 profile 页「显示密钥」功能依赖此，任何 webview 脚本可随时拉取明文。 | XSS 后 `invoke('workbench_profile_secret_get', {profileId:'openai'})` 直接拿明文 key，无需读 localStorage。 | 默认不回传明文：返回 last4 + 一次性「显示」按钮经独立命令临时放行（带 UI 确认参数）；或直接删除该命令，前端永不持有明文。 |
| K-03 | apps/agent-workbench/src-tauri/src/config/credentials.rs:177-185（fs::write 默认 ACL）、persistence.rs:35-47（config_dir 回退 `env::temp_dir()`） | 低 | DPAPI 密文文件写入无显式 ACL 收紧（依赖用户目录默认权限）；`CRISH_WORKBENCH_CONFIG_DIR`/APPDATA 缺失时配置落入 temp 目录，temp 目录策略更宽松，且密文文件名 `provider-direct-key.dpapi` 可被扫描定位。 | 同一机器低权限进程（或恶意软件）读取 temp 下 dpapi 密文文件后，以同用户上下文调用 CryptUnprotectData 解密——DPAPI 不防同用户进程，防的是明文散落；ACL 收紧可显著缩小暴露。 | 写入后用 `CreateFile` 显式 DACL（仅当前用户）或 `icacls` 收紧；config_dir 回退路径改为 `%LOCALAPPDATA%` 专用目录并保证目录已建。 |
| K-04 | apps/agent-workbench/src-tauri/src/config/credentials.rs:15-21,91（memory_key 普通 String）、engine.rs:86-95（ProviderEndpoint.api_key 普通 String，无 wipe） | 低 | 密钥在进程内以不可变 String 多处驻留（CredentialStore.memory_key / os_cache / runtime.api_key / ProviderEndpoint.api_key / reqwest bearer），无 SecretString 或 drop 时清零；进程崩溃转储/调试器可见。 | 崩溃转储（crash dump 上传/分析场景）中含明文 key；内存取证工具可提取。 | 引入 SecretString（drop 时 zeroize）承载 key 生命周期；engine/request 层用后即清引用；崩溃上报前过滤敏感字段。 |
| K-05 | apps/agent-workbench/src-tauri/src/config/provider.rs:417-499（update_daemon_config 把明文 key 塞入 cmd JSON）、crates/conex-telemetry（无全局脱敏层） | 低 | `update_daemon_config` 构建含明文 apiKey 的 `cmd` 对象（当前 `sentToDaemon=false` 未外发，但代码路径保留）；全仓无日志/事件脱敏层——若未来把 cmd 序列化进日志或事件（events payload 原样落库，见 D-02），key 会进 sessions.db。 | 未来接线（daemon 转发）时 cmd 经网络/日志通道即泄露；当前可利用面：把 `update_daemon_config` 返回的错误或调试日志打出来。 | 删除 cmd 中的明文 key 组装（进程内配置已直接生效）；增加全局 redaction（tracing layer 对 `sk-`/`api[_-]?key` 模式打码）；事件 payload 写入前做敏感字段过滤。 |
| M-01 | crates/agent-tools/src/mcp/servers.rs:33-47,76-104（McpServerConfig 任意 command/args/env，validate 仅查空串与 env 键 `=`） | 中 | MCP server 配置允许任意可执行命令 + 任意参数 + 任意环境变量（可覆盖 PATH）。当前壳未注册 mcp 管理命令（main.rs 无 workbench_add_mcp_server），但配置持久化钩子存在，未来暴露即成为「webview 拉起任意进程」通道。 | 配置面一旦暴露（如设置页添加 MCP server），恶意仓库可诱导用户添加 `command:"cmd", args:["/c","calc.exe"]` 的 server；或已受损配置文件中被注入命令。 | MCP server 命令加入白名单（npx/node/python/已知 CLI 路径）+ 首次启动确认；env 键白名单（PATH/HOME 等）；配置持久化文件加完整性校验（防篡改注入）。 |
| M-02 | crates/agent-tools/src/mcp/bridge.rs:645-664（mcp_tool_name 仅净化 server_id，远端 tool_name 原样拼接）、670-685（inputSchema 原样透传） | 中 | 远端工具名不净化：恶意/受损 MCP server 可声明 `shell_command`、`mcp_evil__write_file` 或含控制字符/换行的名称，进入注册表与模型工具列表，造成与内置工具的名称/语义混淆（模型可能被引导调用 mcp 代理执行内置工具行为）；inputSchema 无限大小与结构（可声明 `additionalProperties:true` 大对象）。 | 供应链场景：用户接入第三方 MCP server（如 npx 拉取的包）→ server 声明 `name:"shell_command"` 的恶意工具 → 模型看到 `mcp_<id>__shell_command` 误以为工作区命令工具 → 参数注入任意命令（tools/call 无本地校验）。 | 远端 tool_name 与 server_id 同样净化（sanitize_id_part）+ 长度/字符白名单；inputSchema 大小上限与 `additionalProperties` 收紧；注册前对声明描述做 prompt 注入敏感词提示。 |
| M-03 | crates/agent-tools/src/mcp/bridge.rs:358-369（call_tool 入参原样透传）、adapt_call_result 结果原样进事件 | 低 | tools/call 入参不做 schema 校验即透传远端；远端返回的 text/structuredContent 原样进入工具结果 → 进入会话事件与 SQLite（D-02）。 | 恶意 MCP server 返回含 prompt injection 的文本（「忽略之前指令…」）直接进入模型上下文；或返回敏感数据格式混淆。 | 本地对 input 按声明的 JSON schema 校验（或至少类型/大小校验）；结果 text 上限截断；MCP 结果标记来源（`mcp:` 前缀）便于上下文标注。 |
| I-01 | apps/agent-workbench/src-tauri/src/main.rs:126-134（debug 构建 tauri_plugin_mcp TCP 127.0.0.1:4000，含 execute_js/click/screenshot）、apps/crish-desktop/src/main.tsx:108-122（DEV 注册 setupPluginListeners） | **高** | debug 构建下开启本机 TCP:4000 MCP 控制服务，**无认证**：任何本机进程可连接并 execute_js/click/screenshot，等效获得完整 webview 控制权（进而调用全部 Tauri 命令，含 P-01 任意文件读写、workbench_run_shell）。 | 开发者日常以 dev 构建运行，本机任意进程（恶意 npm 包、网页触发的本机服务、其他用户的受限进程）连接 `127.0.0.1:4000` 发送 `execute_js("...")` → 在 webview 上下文执行任意 JS → 读取 localStorage 明文 key（K-01）、调用任意 Tauri 命令。 | debug-only 服务默认关闭（显式 env 开启）；加 token 握手（启动时生成随机 token，客户端需带）；仅允许 loopback 且限制命令集（去掉 execute_js 或加二次确认）；release 构建移除该插件（已通过 cfg 隔离，需确认未误开）。 |
| I-02 | apps/agent-workbench/src-tauri/src/core_run_commands.rs:614-658（resolve_tool_decision 不校验 tool_call_id 是否存在/是否在 awaiting-approval） | 中 | core_approve_tool/core_deny_tool 对任意 run_id + 任意 tool_call_id 直接落地 approval-resolved 事件：approve 仅在状态机 awaiting-approval 时恢复运行，但 deny/任意 id 都会伪造审计事件并落库（事件持久化）。无「该 tool_call_id 确有待审批请求」校验。 | XSS 或注入脚本批量 `core_approve_tool({runId:'r1', toolCallId:'任意'})` 伪造审批记录污染事件流/重放；或提前对未发出的工具调用 approve，使后续真实审批被跳过（审批门消费事件时）。 | resolve_tool_decision 前校验：该 run 状态为 awaiting-approval 且 tool_call_id 在待审批集合（session-loop 审批门登记）；不匹配返回 NotFound。 |
| I-03 | apps/agent-workbench/src-tauri/src/commands.rs:31-85（workbench_http_request：任意 http(s) URL + 自定义 headers + POST body） | 中 | SSRF 面：webview 可发起任意 GET/POST/HEAD 到内网/本机任意 TCP 端口（仅禁 host/content-length 头）。可用于探测内网服务、打本机 daemon（127.0.0.1:8765 在 CSP connect-src 白名单内）、访问云元数据端点。 | XSS/注入脚本 `workbench_http_request({url:"http://127.0.0.1:8765/...", method:"POST", body:"..."})` 对本地服务发送任意请求（CSRF 于本机服务）；或探测内网 10.x/192.168.x 端口开放情况后利用其它漏洞。 | URL 限制：禁止 loopback/链路本地/内网段（或改为仅允许调用方显式配置的 provider 域名）；headers 白名单（仅 Authorization 等必要头）；body 大小上限；如需连通性测试改走专用命令。 |
| I-04 | apps/agent-workbench/src-tauri/src/session_commands.rs:97-124（save_session_body/delete_session 仅校验非空，无会话存在性/所有权校验） | 低 | webview 可对任意 session_id 执行 save/delete/touch：不存在的 id 也会被写入（save_session_body 直接 INSERT 触发 FK 失败仅当 sessions 无该行——见 AA-07 P01），delete 任意 id 幂等。与 I-01/XSS 组合可清空/伪造会话数据。 | XSS 后 `list_sessions()` 枚举全部会话 → `delete_session` 逐条删除（数据丢失）；或 `save_session_body` 覆盖任意会话正文（篡改历史）。 | delete/save 前校验会话存在（或前端只允许对当前 store 持有的会话操作）；对 delete 增加 UI 确认 + 服务端二次确认参数。 |
| I-05 | apps/agent-workbench/src-tauri/src/pty/mod.rs:38-63（workbench_pty_create/write 无归属校验、cwd 任意） | 中 | PTY 会话注册表全局共享，任意 webview 调用方可创建任意 cwd 的交互 shell 并写入任意输入（无门禁、无审批）。 | XSS 后 `workbench_pty_create({cwd:"C:\\", cols:80, rows:24})` + `workbench_pty_write({ptyId, data:"whoami; whoami\r"})` → 以当前用户全权限执行任意命令（shell 为交互式 PowerShell，无红线检查）。 | pty_id 与会话创建者绑定（按 webview 来源/前端 token），写操作校验归属；PTY 创建纳入 cwd 白名单（P-03 同源）；必要时对 PTY 输入接门禁（交互场景可豁免并文档化）。 |
| D-01 | crates/conex-db/src/lib.rs:33-37（无 WAL/busy_timeout）、820-860（cleanup_orphan_sessions 空列表全删，与 AA-07 P02 重复） | 低 | 数据完整性残余（AA-07 已列 P02/P15，此处仅确认 SQL 注入面为零）：全部 SQL 经 `rusqlite::params!`/`query_map` 参数化，`cleanup_orphan_sessions` 动态 IN 子句用占位符构造（lib.rs:839-848），无字符串拼接注入点。 | 无 SQL 注入攻击场景；空 active_ids 全表删除的风险已由 AA-07 P02 覆盖，此处仅记录。 | 采纳 AA-07 建议（WAL + busy_timeout、空列表拒绝全删）。 |
| D-02 | crates/conex-db/src/lib.rs:285-304（append_event 对 payload 无大小/结构校验） | 低 | 事件 payload 原样落库（含工具输出、MCP 结果、错误消息），无大小上限与敏感字段过滤：长输出撑爆 DB；若 K-05 的明文 key 路径被接线，事件表成为 key 泄漏点。 | 恶意/异常工具输出（数 MB）写入 events 表无界增长；模型提示注入内容原样持久化污染后续重放。 | append_event 增加 payload 大小上限（如 256KB）+ 截断标记；事件写库前过敏感字段过滤层（与 K-05 共用）。 |
| X-02 | crates/conex-markdown/src/ammonia_config.rs:26-27（class 全局放行）、36-37（th/td 放行 style） | 低 | ammonia 白名单放行任意 class 与 td/th 的任意 style 值：class 可用于 CSS 选择器覆写（结合页面既有样式规则做 UI 欺诈）；style 可写 `position:fixed;z-index:99999` 等制作全屏钓鱼遮罩。非脚本执行，但为 UI redress/phishing 面。 | 模型输出（或恶意仓库内容经模型引用）构造 `| a |\n| --- |\n| <div style="position:fixed;inset:0;z-index:99999;background:white">... |` 遮罩聊天界面诱导用户授权/输入密钥。 | th/td 的 style 白名单仅允许 `text-align`（或整体移除）；class 改为前缀白名单（`md-`、`hljs-`、`language-`）。 |
| X-03 | apps/crish-desktop/src/main.tsx:31-34（`window.__CRISH_STORE__` 等全局 store 暴露） | 低 | 生产构建也把 zustand store（会话内容、布局、设置）挂到 window 全局，任何注入脚本可直接读写（篡改会话/注入伪造消息/读取本地内容）。 | XSS 后 `window.__CRISH_SESSION_STORE__.getState()` 读全部会话正文；或注入伪造的 assistant 消息诱导用户。 | 生产构建移除（仅 DEV/测试暴露）；如确需调试入口，用 `import.meta.env.DEV` 守卫。 |
| X-04 | apps/crish-desktop/src/components/files/FilePreview.tsx:141-153、settings-skills/SkillDetailPreview.tsx:151（dangerouslySetInnerHTML 使用 mdHtml） | 低 | 这两处 dangerouslySetInnerHTML 的 HTML 来自 Rust md_render（已 sanitize，见已验证项 X-01），本身安全；但若任一调用点误用未 sanitize 的路径（如直接透传文件内容）即 XSS。当前 FilePreview 对文本文件走 read_file_content 后渲染 markdown（经 Rust），skill 预览同理。 | 无直接攻击场景（当前链路已 sanitize）；属「高风险 API 使用点」登记，防止未来重构引入裸 innerHTML。 | 保留但加注释标记「必须经 md_render sanitize 后方可传入」；组件层可选加一次 DOMPurify 纵深防御（成本低）。 |

---

## 三、已验证安全项（正面）

| 编号 | 面 | 验证结论 |
| --- | --- | --- |
| V-01 | 工具层路径安全 | crates/agent-tools 全部路径入参（read_file/write_file/list_dir/file_stat/grep_search/fuzzy_find/shell cwd）均经 `resolve_workspace_path`（tools/mod.rs:128-183）：`..` 组件拒绝（tool.path_escape）、safe_canonicalize 深度上限 32、canonicalize 后符号链接解析再校验工作区包含性、Windows `\\?\` 前缀剥离。单测覆盖越界/控制字符/深度/符号链接语义。 |
| V-02 | SQL 注入面 | crates/conex-db 全部 20+ 条 SQL 均参数化（`rusqlite::params!` / `query_map`），`cleanup_orphan_sessions` 动态 IN 正确构造占位符（lib.rs:839-848），无一处字符串拼接用户输入进 SQL。 |
| V-03 | markdown XSS 双路径 | Rust 路径：pulldown-cmark 默认 escape + raw HTML 仅 `<img>` 透传 + is_safe_href/is_safe_img_src 白名单（含双重 percent-decode、零宽/bidi 走私字符清洗，sanitizer.rs:10-118）+ ammonia 兜底（strip onerror）；TS fallback 路径（markdownPlugins.ts/IncrementalInlineRenderer.ts）全部内容 escapeHtml，无 raw HTML 透传。parity 测试覆盖 `javascript:`、`data:`、编码走私变体。 |
| V-04 | PowerShell 包装 | shell.rs:196-224 与 process.rs:587-616 一致：用户命令 UTF-8→base64 包进 `[scriptblock]::Create`，再经 UTF-16LE→base64 `-EncodedCommand` 传递，原始命令不出现于外壳命令行（防二次解析注入）；`-NoProfile`（不加载用户 profile 脚本）。 |
| V-05 | DPAPI 使用 | credentials.rs:221-324：`CRYPTPROTECT_UI_FORBIDDEN`（无 UI 提示）、描述为空、`LocalFree` 释放、hex 编码落盘；`get_api_config` 快照仅回 last4+hasApiKey（provider.rs:276-301）不回传明文；clear 路径幂等。 |
| V-06 | 进程/孤儿保护 | PTY 与 shell 子进程：Windows Job Object `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（process.rs:733-815，主机崩溃自动杀树）、taskkill 树杀超时路径、`kill_on_drop(true)`、PTY 退出钩子 kill_all；PTY 输出只记字节数不记内容（session.rs:294-300）。 |
| V-07 | MCP 进程生命周期 | bridge.rs：子进程 stdin/stdout/stderr 全管道、崩溃双路检测（stdout EOF + try_wait 轮询）、stop/stop_all/Drop 兜底杀进程、会话表无泄漏路径；server_id 净化（sanitize_id_part）、env 键 `=` 拒绝（servers.rs:89-102）。 |
| V-08 | 前端 IPC 命令名收敛 | commandMap.ts:65-70：Tauri 命令经显式映射表或前缀白名单（core|workbench|md|perf）解析，未知 type 拒绝（「Tauri command not available」），无命令名注入面。 |
| V-09 | 工具输出预算 | shell 输出 200KB/400KB 头尾截断、命令长度 32KB 上限、超时 clamp（1-600s）；grep 匹配/文件/字节上限；read_file 256KB 字符上限 + 二进制检测（fs.rs:80-86）。 |
| V-10 | 写编码白名单 | write_file encoding 仅 utf-8/utf-8-bom/utf-16le/utf-16be（fs.rs:133,212-218）；profile 密钥文件名白名单（persistence.rs:87-103，ASCII alnum/-/_ ≤128，防路径穿越写文件）。 |

---

## 四、修复优先级建议（与功能解耦的纯安全项先行）

**P0（纯安全、不依赖功能重构，建议本周内合入）**
1. **红线门禁加固**（C-01）：blocked_patterns 补 `--` 变体、分离 flag、`-LiteralPath`、`cmd/pwsh -c` 包装、`iex`/`Start-Process`；长期改为 argv 解析式判定。
2. **workspace_root 服务端固定**（P-01）：4 个文件命令 + perf_fs_* 移除调用方根参数，改为 host_paths 白名单派生（顺带消除 P-03 的 shell cwd 越界的一半面）。
3. **前端密钥下线 localStorage**（K-01）：setProfileKey 改走 DPAPI 命令，本地仅存 hasKey；迁移逻辑清除旧明文 key。
4. **gitApi 改参数数组执行**（C-02/C-03）：新增 `workbench_git_run(gitArgs: Vec<String>)`，前端 git 全路径与文件删除改走它。
5. **dev MCP socket 关闭/加 token**（I-01）：默认关闭 + 随机 token + 仅 loopback。

**P1（安全加固，依赖少量接口调整）**
6. 审批命令校验待审批集合（I-02：tool_call_id 存在性 + awaiting-approval 状态）。
7. workbench_http_request URL/内网限制 + headers 白名单（I-03）。
8. workbench_profile_secret_get 默认回 last4、明文显示走一次性确认（K-02）。
9. PTY 创建/写入做来源归属 + cwd 白名单（I-05）。
10. ammonia 收紧：class 前缀白名单、th/td style 仅 text-align（X-02）。

**P2（与功能演进耦合，随架构重构合入）**
11. 凭据内存 zeroize + 日志/事件脱敏层（K-04/K-05/D-02）。
12. MCP 管理面暴露时的命令白名单与远端工具名净化（M-01/M-02/M-03）。
13. session 命令存在性校验（I-04）、`window.__CRISH_STORE__` 生产移除（X-03）、DPAPI 文件 ACL 收紧（K-03）。
14. conex-db WAL/busy_timeout 与事件 payload 上限（D-01/D-02，与 AA-07 P02/P15 合并实施）。

> 与既有文档的衔接：AA-07（数据持久化）已覆盖 P01/P02/P08/P15 等数据层问题，本审查不重复展开；本审查新增重点为命令门禁绕过、沙箱根调用方化、前端明文 key、git 注入与 dev MCP socket 五项，建议作为下一迭代安全合入批次。
