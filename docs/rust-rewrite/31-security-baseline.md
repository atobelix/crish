# 31 — 安全基线（Security Baseline）

> 状态：✅ 已发布（初版，PE-07 T07.7 产出；随 E5 批 6 定稿）
> 日期：2026-08-01 · 依据：`audits/AA-05-security-review.md`（24 项，严重 2 / 高 3 / 中 9 / 低 10）、
> `audits/AA-01-rust-core-code-review.md`（Q16/Q17 锁中毒 panic 面）、`plans/PE-07-security-hardening-plan.md`（T07.1–T07.8）
> 定位：本仓**所有新代码与既有代码改动**的安全硬性要求。后续所有 PR 必须满足本文件十条基线，
> 合并前逐项勾选 PR 检查表（§4）；例外必须走豁免流程登记（§5），禁止静默偏离。

---

## 1. 适用范围与判定表

**适用对象**：全部 Rust crate（conex-sandbox / agent-tools / conex-db / conex-markdown /
conex-telemetry / session-loop / agent-provider / orchestrator 等）、Tauri 壳
（apps/agent-workbench/src-tauri）、前端（apps/crish-desktop、apps/agent-workbench）。

**安全面判定表**：任一改动触达下表任一「面」，即视为安全面改动——

| 面 | 判定（改动是否涉及） | 触达后必须满足 |
| --- | --- | --- |
| IPC 签名 | 新增/修改 Tauri 命令、跨进程消息、命令参数形状 | B1 信任锚、B5 IPC 暴露面 |
| 进程执行 | 任何 `Command`/spawn/`run_shell`/shell 串拼 | B1 门禁与执行、B2 路径 |
| 路径解析 | 文件读写、遍历、符号链接、cwd 解析 | B2 路径校验 |
| 凭据 | API key/token 的存、取、传、显、序列化 | B3 凭据处理、B4 日志脱敏 |
| 网络监听 | bind/listen、dev 调试服务、出站 HTTP | B5 IPC 暴露面、B9 依赖安全 |
| 锁 | 运行时 `Mutex`/`RwLock` 上锁与 panic 路径 | B8 panic 面 |
| 数据落库 | SQL、事件 payload、持久化文件 | B7 SQL 参数化、B4 日志脱敏 |
| 渲染边界 | HTML/markdown 渲染、`dangerouslySetInnerHTML`、window 全局暴露 | B10 webview 注入面 |
| 依赖变更 | Cargo.toml / lockfile / package.json 变更 | B9 依赖安全 |
| MCP 面 | MCP server 配置、远端工具注册、call_tool 透传 | B6 MCP 配置 |

触达即必须满足对应基线并**附带对应测试**（Rust 单测 / vitest / 脚本验证）；未触达的在 PR
描述中显式声明「未触达安全面」即可跳过基线勾选（仍须过 §4 检查表第 1 项）。

---

## 2. 已修复项清单（本轮 E0–E5 安全加固）

> 本表记录 PE-07 安全加固轮（E0–E5）对 AA-05 严重/高危五项及连带项的处置。
> **状态列为 2026-08-01 对工作区代码的核实结果**：✅ 已落地 / ⏳ 部分落地（随 main.rs
> 串行合并或后续批补齐）/ ⬜ 未落地（本批或后续批排期）。E8 基线发布前由 E5 批次补齐。

| 编号 | 严重度 | 修复任务 | 修复要点 | 测试载体 | 核实现状 |
| --- | --- | --- | --- | --- | --- |
| C-01 | 严重 | T07.1 命令门禁重设计 | 语句切分→token 化→危险模式库→动态内容升级审批；`--`/分离 flag/`-LiteralPath`/包装器变体全部覆盖 | `crates/conex-sandbox` 39 测试（三层管线 + 攻击/安全用例） | ✅ 已落地（`conex-sandbox/src/lib.rs` gatekeeper 子模块） |
| P-01 | 严重 | T07.2 沙箱根真源化 | `WorkspaceRegistry`（Rust 侧唯一真源）；文件命令签名删除 `workspace_root`（编译期强制）；`workbench_open_workspace`/`workbench_list_workspaces` 复授权 | `workspace.rs` 12 新测试；fs_commands 单测 | ✅ 主体落地（registry + fs 命令守卫已接线；两新命令注册随 main.rs 串行合并，见 main.rs:252-256 衔接注） |
| C-02 | 高 | T07.3 git 注入修复 | `workbench_git_run`：参数数组 exec + 子命令/flag 白名单 + `:(literal)` pathspec + 超时杀树 | T07.3 用例 1-11 | ⬜ 未落地（manifest `workbench_git_run` registered:false，无 `git.rs`） |
| C-03 | 中 | T07.3（连带） | `workbench_fs_delete_file`（registry 解析 + `std::fs::remove_file`），替代 `reverseFileDiff.ts` PowerShell 拼串 | T07.3 用例 10 | ⬜ 未落地（同上） |
| C-04 | 中 | T07.3（连带） | gitApi 本地 git 参数集限制（禁 force 类 flag，服务端 schema 兜底） | T07.3 用例 4 | ⬜ 未落地（同上） |
| K-01 | 高 | T07.4 密钥管理 | localStorage 明文 key 下线；DPAPI 存储 + last4 展示；一次性迁移（`migrateLegacyProfiles.ts`，幂等标记 `crish_profiles_secrets_migrated_v1`） | T07.4 用例 1-3、8 | ⏳ 部分落地（`config_secret_set/get/has/clear` 已注册（F5 终态名）；迁移与 `config_profile_apply` 未落地） |
| K-02 | 中 | T07.4-C 读取面收敛 | `config_secret_get` 默认仅回 `{hasKey, apiKeyLast4}`；明文显示走 `config_secret_reveal(profile_id, ui_confirm)` | T07.4 用例 4-5 | ⏳ 未完成（mod.rs:106-119 仍回明文 `apiKey`，待 T07.4-C 定稿） |
| K-05 | 低 | T07.4-D 日志脱敏 | `conex-telemetry::redact`（`sk-`/`apiKey`/`Bearer` 打码，last4 保留）；事件写库前过脱敏 | T07.4 用例 6-7 | ⬜ 未落地（无 `redact.rs`，K-05 后续） |
| I-01 | 高 | T07.5 MCP debug socket | 默认关闭 + env 开关 + token 握手 + 命令集收缩（`execute_js` 需二次 env）；release 零监听 | T07.5 用例 1-6 | ⬜ 未落地（main.rs:216-224 仍在 debug 构建无条件注册 `tauri_plugin_mcp` socket） |
| P-03 | 中 | T07.2（延伸） | PTY/终端 cwd 收敛到已授权根 + 门禁上下文（`evaluate_line_with_context`） | T07.2 用例 8 | ⏳ 随批 2 联调确认（registry 就绪后待接线） |
| Q16/17/18 | 重要 | T07.6 锁中毒 | agent-tools 三文件 37 处 `.expect(`（idempotency 12 / bridge 25 / middleware 2）改恢复式/错误返回 | T07.6 用例 1-4 | ⬜ 未落地（37 处全部仍在，F10 口径） |
| V-01~V-10 | — | 回归锁定 | 路径安全、SQL 参数化、md 双路径 sanitize、PowerShell 编码包装、DPAPI、Job Object、输出预算等不回退 | 各 crate 全量 `cargo test` | ✅ 保持（E0 门禁改动路径已回护） |

**防御目标（达成即视为严重/高危清零）**：webview 被完全攻陷时，攻击者仍无法——
执行红线命令（C-01）、越过工作区读写任意文件（P-01）、经 git 通道执行任意命令（C-02）、
批量窃取密钥（K-01）、无认证控制 webview（I-01）。

---

## 3. 十条基线（新代码安全要求）

> 每条格式：**要求** / **反例**（上轮审计实测实例）/ **验收测试要求**。

### B1 命令门禁与进程执行（信任锚）

- **要求**：所有 shell/exec 入口（shell_command 工具、终端 `workbench_run_shell`、host_openers、
  未来新增任何命令执行面）必须经 `CommandPolicy`（`evaluate_line`/`evaluate_line_with_context`）
  三层管线判定（语句切分 → token 化 → 策略匹配；动态内容升级审批；Blocked > Approval > Allowed）。
  任何外部命令必须**参数数组** `Command::args` 执行（禁止 shell 拼串）；唯一例外 = 用户终端
  （PowerShell `-EncodedCommand` 包装，V-04 语义，包装在门禁判定之后）。
  IPC 入参不得作为权限根（信任锚在 Rust 侧：命令合法性、工作区根均由服务端派生）。
- **反例（AA-05 C-01/C-02）**：`rm -rf -- /` 绕过固定正则 → Allowed；`git -C cwd add -- x;calc.exe`
  shell 拼接执行任意命令。
- **验收测试**：conex-sandbox 用例 1-37 全绿；新执行面必须带「攻击输入 → 期望三态」单测；
  4 个既有调用点（shell.rs / process.rs / execute.rs）不得回退为双查或裸正则。

### B2 路径校验

- **要求**：一切文件路径入参必须：拒绝 NUL / 空串；`canonicalize` + 符号链接解析后做
  工作区**组件边界**包含性校验（不得用 `starts_with` 裸前缀）；Windows `\\?\` 前缀剥离
  （V-01 语义）；根与路径**双重防线**（根由注册表派生 + 路径包含校验）；drive-relative
  （`C:foo`）与 UNC（`\\server\share`）变体按注册表判定，不得误放行到系统盘；
  根不可达时拒绝并报错，不裸用传入根（P-02 关闭）。
- **反例（AA-05 P-01）**：`read_file_content({path:"C:\\Users\\me\\.ssh\\id_rsa", workspaceRoot:"C:\\"})`
  全盘任意读；`/home/proj` 前缀匹配 `/home/proj2`（starts_with 缺陷）。
- **验收测试**：越界/符号链接逃逸/`..`/控制字符/深度上限/drive-relative/UNC/根不可达
  均须有单测断言拒绝路径；工具层（agent-tools）与壳层（fs_commands）各保持一套。

### B3 凭据处理

- **要求**：API key / token 禁止明文进 localStorage、日志、事件、序列化产物；存储一律
  DPAPI（`config_secret_set`）；展示一律 last4（`config_secret_get` 默认形状）；明文回传
  仅限 `config_secret_reveal(profile_id, ui_confirm=true)` 一次性通道；前端引擎同步路径
  不携带明文（`config_profile_apply` 进程内直写）；新结构体若承载密钥必须用 drop 清零
  类型（K-04 后续）；凭据文件写入收紧 ACL（K-03 后续）。
- **反例（AA-05 K-01/K-02）**：`localStorage.getItem('crish_provider_profiles_v1')` 批量窃取；
  `workbench_profile_secret_get` 解密后整体回传 webview。
- **验收测试**：vitest 断言 localStorage JSON 字符串不含 `sk-` 明文；`config_secret_get`
  返回无全量 `apiKey`；Rust 单测断言配置序列化产物无 key 字段。

### B4 日志脱敏与安全审计

- **要求**：全局脱敏钩子（`conex-telemetry::redact`：`sk-[A-Za-z0-9_-]{8,}`、`apiKey`/`api_key`/
  `authorization` 字段值、`Bearer <base64ish>` 打码为 `***`；展示场景保留 last4）——
  事件写库前（append_event 前置钩子）、错误消息序列化前、tracing 输出前必经脱敏；
  安全相关事件（门禁拦截、越界拒绝、密钥迁移失败）必须落事件/日志（脱敏后），可检索。
- **反例（AA-05 K-05/D-02）**：`update_daemon_config` 组装含明文 key 的 cmd JSON；
  事件 payload 原样落库（若明文路径接线即泄漏）。
- **验收测试**：`redact_secret` 单测覆盖三种模式 + last4 保留；事件写库断言无明文；
  门禁/越界拒绝路径有日志断言。

### B5 IPC 暴露面（含网络监听）

- **要求**：新 Tauri 命令签名**不得**含 `workspace_root` 类权限根参数；命令注册走
  `make_handlers!` 单一清单 + `command_manifest.rs` 双向断言，无幽灵/死面命令；
  网络监听**默认无**：dev 调试服务仅 loopback + token 握手 + 显式 env 开启（`CRISH_DEV_MCP`
  类），release 构建零监听；审批类命令（`core_approve_tool`/`core_deny_tool`）必须校验
  会话/工具调用存在性与状态（I-02 后续）；HTTP 出站面限制目标网段与头白名单（I-03 后续）；
  会话写删除命令校验存在性（I-04）。
- **反例（AA-05 I-01/I-02/I-03）**：debug 构建 `127.0.0.1:4000` 无认证 socket，任意本机
  进程 `execute_js` 全控 webview；伪造 `tool_call_id` 的审批事件落库；任意内网 URL 的
  SSRF 探测。
- **验收测试**：`core_list_commands` 与 manifest 一致性测试；MCP 默认关闭断言
  （端口不监听 + release 冒烟）；审批校验测试（不存在 tool_call_id → NotFound）。

### B6 MCP 配置

- **要求**：MCP server 配置（command/args/env）暴露管理面时必须白名单化（可执行命令
  白名单 + env 键白名单 + 配置完整性校验，M-01 后续）；远端工具名与 `inputSchema` 注册
  前净化（长度/字符白名单、schema 大小上限、`additionalProperties` 收紧，M-02 后续）；
  call_tool 入参本地 schema 校验 + 结果 text 截断 + `mcp:` 来源标记（M-03 后续）。
  本方案阶段保证**不引入新的同型面**（管理命令未暴露前无新增通道）。
- **反例（AA-05 M-01/M-02/M-03）**：配置任意 `command:"cmd", args:["/c","calc.exe"]`；
  远端声明 `name:"shell_command"` 与内置工具语义混淆；恶意结果文本原样进模型上下文。
- **验收测试**：`McpServerConfig::validate` 扩展用例（白名单拒绝）；`mcp_tool_name`
  净化用例覆盖控制字符/超长/换行；schema 超限拒绝用例（落地批次后补）。

### B7 SQL 参数化与数据落库

- **要求**：全部 SQL 必须 `rusqlite::params!`/`query_map` 参数化（V-02 语义），动态 IN
  子句用占位符构造，禁止字符串拼接用户输入；事件 payload 写库前必须过脱敏 + 大小上限
  （256KB 截断标记，D-02 后续）；数据库启用 WAL + busy_timeout（D-01，随 PE-08 合并）。
- **反例（AA-05 D-02）**：append_event 对 payload 无大小/结构校验，数 MB 输出无界增长。
- **验收测试**：新增 SQL 必须参数化（code review 硬检查）；payload 超限截断单测。

### B8 panic 面（锁与运行时错误）

- **要求**：运行时锁（`Mutex`/`RwLock`）禁用 `.expect("...")` 中毒路径——统一
  `unwrap_or_else(|e| e.into_inner())`（恢复式）或 `map_err(...)?`（向调用方传播）；
  结果型 `expect`（Ok 分支必有值）必须显式 match/ok_or；锁内不 await、不扩大临界区；
  Q19 类已前置校验的合理 expect 除外（登记为正面）；新锁代码一律不写 expect。
- **反例（AA-01 Q16/Q17，PE-07 T07.6）**：agent-tools 三文件 37 处锁/结果 expect——
  MCP server 回调 panic 毒化请求表锁 → 进程不可恢复 DoS。
- **验收测试**：T07.6 用例 1-4（毒化后公开 API 正常返回）；新锁用例（panic 线程 +
  恢复后继续工作）必须附带；`rg "\.lock\(\).*expect"` grep 断言归零。

### B9 依赖安全

- **要求**：Cargo.lock 恢复跟踪（CI `--locked`，T10.1）；外部 git 依赖必须 rev 锁定
  （tauri-plugin-mcp 锁 `rev=c7d271a06469bdf4744bfdeadca7458a1f3d02e5`，T10.10 会签）；
  新依赖引入前评审（维护活跃度、许可、安全公告）；同一依赖双版本必须收敛（reqwest
  已收敛单版本）；前端依赖同步走 lockfile；生产构建禁用 updater 面（已禁用）。
- **反例**：`tauri-plugin-mcp` 未锁 rev 的漂移风险（供应链注入面）。
- **验收测试**：CI lock 检查通过；`Cargo.toml` 变更 PR 必须附依赖评审说明；
  双版本 grep 断言（如 `reqwest = "0.13"` 单版本）。

### B10 webview 注入面（渲染边界与全局暴露）

- **要求**：HTML/markdown 渲染一律经 Rust `md_render` sanitize 边界（V-03 双路径语义）：
  pulldown-cmark 默认 escape + 白名单 + ammonia 兜底；`dangerouslySetInnerHTML` 使用点
  必须标注「来源=md_render sanitize 输出」且不得透传未 sanitize 内容（X-04 登记面）；
  ammonia class 前缀白名单（`md-`/`hljs-`/`language-`）+ th/td style 仅 `text-align`
  （X-02 后续）；zustand store 等全局 window 暴露仅限 DEV（`import.meta.env.DEV` 守卫，
  X-03 已落地）；生产构建不暴露调试入口。
- **反例（AA-05 X-02/X-03）**：`<div style="position:fixed;inset:0;z-index:99999">` 钓鱼遮罩；
  生产构建 `window.__CRISH_STORE__` 任意注入脚本读写会话。
- **验收测试**：ammonia 收紧后单测（恶意 class/style 被剥离）；X-03 vitest
  （DEV=false 不写 window 全局）；新渲染路径必须过 sanitize 断言（`onerror`/`javascript:` 剥离）。

---

## 4. PR 检查表（合并前逐项勾选）

> 每个 PR 必须完成本表并随 PR 附上；任何一项不适用须注明原因（见 §5 豁免流程）。

| # | 检查项 | 结果 |
| --- | --- | --- |
| 1 | 声明是否触达安全面（§1 判定表）？触达 → 全表必勾；未触达 → 说明并跳过 2-10 | ☐ |
| 2 | B1：新 shell/exec 入口经 `CommandPolicy` 三态判定；外部命令为参数数组 exec（无拼串）；无新权限根入参 | ☐ |
| 3 | B2：新路径面完成 canonicalize + 符号链接 + 组件边界包含性 + NUL 拒绝 + `\\?\` 剥离 + 双重防线 | ☐ |
| 4 | B3：无明文 key 进 localStorage/日志/事件/序列化；存 DPAPI、显 last4；明文通道有 UI 确认 | ☐ |
| 5 | B4：新增日志/事件/错误输出过脱敏钩子；安全事件（拦截/越界/迁移失败）落日志 | ☐ |
| 6 | B5：新命令无 `workspace_root` 参数并登记 manifest；无新增默认监听；审批/HTTP 面校验存在性与白名单 | ☐ |
| 7 | B6：MCP 面无新增透传通道；配置/工具名/schema 校验按基线扩展 | ☐ |
| 8 | B7：新增 SQL 全参数化；事件 payload 大小上限 + 脱敏前置 | ☐ |
| 9 | B8：新增锁代码无 expect（恢复式/错误返回）；grep `\.lock\(\).*expect` 无新增命中 | ☐ |
| 10 | B9/B10：依赖变更附评审 + lockfile 更新；渲染面过 sanitize 边界、无新增裸 innerHTML；无新增 window 全局（或 DEV 守卫） | ☐ |

---

## 5. 例外豁免流程

1. 需偏离基线的改动必须登记本表（含理由、范围、负责人、到期日）；到期未销须重新评审。
2. 豁免登记同步到 `30-verification-checklist.md`（安全豁免登记段）；审批人 = 安全基线评审人。
3. 已登记豁免（本表 v1）：

| # | 基线条 | 豁免内容 | 理由（不擅扩范围） | 负责人 | 到期日 |
| --- | --- | --- | --- | --- | --- |
| 1 | B6 | MCP server 配置白名单未实施（M-01） | AA-05 决议「暂缓」：壳未暴露 mcp 管理命令，无即时利用面；依赖功能演进（PE-07 T07.8 项 4） | PE-07 T07.8 | 随 MCP 管理面暴露前必须完成 |
| 2 | B5 | `core_approve_tool`/`core_deny_tool` 未校验 tool_call_id 存在性（I-02） | AA-05 决议：随 PE-09 T09.6 审批改造后复评（T07.8 项 1）；本方案保证不引入新同型面 | PE-09 T09.6 | T09.6 落地后复评 |
| 3 | B5 | `workbench_http_request` 未限内网段（I-03） | AA-05 决议「暂缓」：需产品确认 http_request 工具是否保留（T07.8 项 2） | 产品 + T07.8 | 后续批次 |
| 4 | B8 | 既有 37 处锁 expect（T07.6 未落地） | 排期在本批之后（E5 批次内）；清单口径 = AU-04 F10 | PE-07 T07.6 | E5 批次 |
| 5 | B3 | `config_secret_get` 当前仍回明文（K-02 未落地） | T07.4-C 未实施；E5 批次内补齐 last4 语义 | PE-07 T07.4 | E5 批次 |

---

## 6. 验证命令（基线回归）

```powershell
cargo test -p conex-sandbox            # B1 门禁用例
cargo test -p agent-tools              # B6/B7/B8（MCP 净化、SQL、锁）
cargo test --manifest-path apps/agent-workbench/src-tauri/Cargo.toml   # B2/B3/B5（注册表/凭据/IPC）
cargo clippy --workspace --all-targets # 无新增告警
pnpm --filter crish-desktop test -- --run   # B3/B10（凭据 vitest、store 暴露）
cargo test --workspace                 # E8 全量（§5 验收序列引用 30-phase-e §5）
```
