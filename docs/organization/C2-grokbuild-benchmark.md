# C2 grok-build 基准调研（reference/grok-build）

> 调研员产出 · 只读调研 · 2026-08-03
> 对象：`reference/grok-build`（xAI Grok Build CLI/TUI 的 Rust 源码镜像，由 SpaceXAI 内部 monorepo 周期同步，本地 16 条 "Synced from monorepo" 提交）
> 目的：为 conex/crish 与 grok-build 的水平对比提供事实依据，产出可借鉴点清单

---

## 0. 结论速览

| 维度 | 评级 | 一句话理由 |
| --- | --- | --- |
| 功能完成度 | **A+** | 商业级完整产品：TUI / headless / ACP agent 三形态 + 子代理 / 目标系统 / 计划模式 / 记忆 / 沙箱 / hooks / 插件 / skills / MCP / BYOK / OIDC 全覆盖 |
| 架构成熟度 | **A+** | 依赖反转的叶子 crate 分层 + 统一工具运行契约（流式不变量）+ leader-follower IPC + actor 会话循环 + wire 稳定性纪律 |
| 工程质量 | **A+** | 约 2.95 万个测试标注 + 进程内 ACP e2e 测试具 + PTY e2e 平台 + soak/内存/性能基准 + 硬化发布 profile + 依赖纪律（CVE 记录在案） |
| 工程规范 | **A** | 生成文件只读纪律、changelog 分层、lint 豁免书面化、安全加固极强；但镜像无 CI、不接受外部贡献、提交粒度为单条 sync |

**总评：A+（行业顶级商业产品水平，grok-build 与 opencode 同处第一梯队；conex 与它的差距是数量级上的，但可借鉴点高度集中）。**

核心差距（对 conex 而言）：conex crates/ 约 8.2 万行 Rust，grok-build crates/ 约 **148 万行（18 倍）**；差距不在"会话循环有没有"，而在**会话循环之上的产品层**——目标系统（goal classifier/orchestrator）、计划模式、laziness 检测、子代理编排、leader-follower 多客户端架构、事件驱动的 hook 系统、工作流引擎、沙箱、以及配套的 2.95 万测试与 e2e 基建。

---

## 1. 规模与结构

### 1.1 仓库总览

- 规模：crates/ 下 **81 个 workspace 成员**（`crates/build/` 1 个、`crates/codegen/` 64 个、`crates/common/` 11 个、`prod/mc/` 1 个、`third_party/` 4 个）；Cargo.lock 357KB；THIRD-PARTY-NOTICES 781KB。
- 行数：crates/ 共 **2,375 个 .rs 文件、约 147.9 万行**；third_party（mermaid 栈）另加约 2.6 万行。单文件最大 468KB 级（pager 的 reducer 测试模块）。
- 工具链：edition 2024；`rust-toolchain.toml` 钉住 stable 1.92.0 + rustfmt/clippy 组件 + 双架构 targets；`[profile]` 定义 release-dist（thin LTO + codegen-units=1 + debug=1 + 保留符号）、x-prod、release-dist-jemalloc 别名，dev 用 panic=abort + 128 CGU。
- 仓库性质：**内部 monorepo 的周期性导出**——根 Cargo.toml 首行即声明"Auto-generated workspace root. Prefer editing per-crate Cargo.toml files"；`SOURCE_REV` 记录上游完整 commit SHA；git 历史只有 16 条 "Synced from monorepo"。README 明确"不接受外部贡献"（CONTRIBUTING.md）。
- 源码许可 Apache-2.0；内置 openai/codex 与 sst/opencode 的工具实现移植，附 crate 级 THIRD_PARTY_NOTICES（含 Apache §4(b) 变更声明）。

### 1.2 分层结构

| 层 | 目录 | 代表 crate | 职责 |
| --- | --- | --- | --- |
| 构建 | `crates/build/` | xai-proto-build | protoc 定位与 proto 代码生成（配合 `bin/protoc` dotslash 密封工具） |
| 应用 | `crates/codegen/` | xai-grok-shell / xai-grok-tools / xai-grok-pager / xai-grok-agent / xai-grok-workspace / xai-grok-config / xai-grok-mcp / xai-grok-sandbox / xai-acp-lib …… | 产品全部实现（64 个 crate） |
| 公共叶子 | `crates/common/` | xai-tool-runtime / xai-tool-protocol / xai-tool-types / xai-computer-hub-core / xai-computer-hub-sdk / xai-tracing / xai-test-utils / xai-circuit-breaker …… | 无应用依赖的共享契约，供下游"依赖反转" |
| 服务端类型 | `prod/mc/` | cli-chat-proxy-types | chat proxy 的会话/反馈/部署配置等 wire 类型（与 shell 共享） |
| 内置第三方 | `third_party/` | mermaid-to-svg / dagre_rust / graphlib_rust / ordered_hashmap | 上游源码 vendored（Mermaid 图渲染栈） |

依赖纪律亮点：`xai-grok-config-types` 的 description 明写"extracted from xai-grok-shell for dependency inversion"——叶子 crate 是**为反转依赖而抽取**的，不是自然长出来的；`xai-tool-runtime` 注释自述"This crate is upstream of every concrete impl"。

### 1.3 关键 crate 规模（LOC / 文件数 / 测试标注数）

| crate | 职责 | 文件 | LOC | 测试标注 |
| --- | --- | --- | --- | --- |
| xai-grok-pager | TUI 前端（scrollback/输入/弹窗/渲染/headless reducer） | 689 | 468,715 | ~9,100 |
| xai-grok-shell | agent 运行时 + 会话循环 + leader 入口 | 478 | 366,603 | ~6,200 |
| xai-grok-tools | 工具实现（grok_build / concise / hashline / codex / opencode 移植） | 233 | 131,489 | ~2,900 |
| xai-grok-workspace | 宿主文件系统 / VCS / 执行 / 权限 / checkpoint / worktree | 90 | 89,473 | ~1,640 |
| xai-grok-agent | Agent 定义解析 / 构建 / 系统提示词组装 | 30 | 22,599 | 576 |
| xai-grok-config | 配置读取与分层 | 24 | 11,156 | 187 |
| xai-grok-mcp | MCP 客户端/服务端封装（rmcp 隔离舱） | 10 | 11,045 | 167 |
| xai-grok-sandbox | OS 级沙箱（nono/Landlock/Seatbelt + 子进程网络策略） | 14 | 6,432 | 80 |

（LOC 用 `Get-Content` 行数统计；测试标注为 `#[test]`/`#[tokio::test` 行匹配数，方向性可靠。）

---

## 2. 架构

### 2.1 ACP（Agent Client Protocol）实现

- **协议本体不在仓库内**：直接依赖 crates.io 上游 `agent-client-protocol` **0.10.4 + unstable features**（ACP 规范官方 Rust SDK，含 `Agent`/`Client` trait、消息类型、`SessionId`/`SessionUpdate` 等）。
- **自有封装 `xai-acp-lib`**（8 个文件，21 个测试）：在协议之上提供
  - `channel.rs`：agent/client 双端 mpsc 信道 + `AcpResult` 统一错误；
  - `gateway.rs`：**网关收发器**——`AcpGatewaySender/Receiver`，把"请求-响应 + 通知"统一转发到连接，支持 `forward_with_completion`（等 handler 结束）与 `forward_fire_and_forget`（不等响应），并用宏把 11 种 agent 消息 / 9 种 client 消息路由到 trait 方法；
  - `message.rs`：`AcpAgentMessage`/`AcpClientMessage` 枚举（Boxed/Unboxed 存储标记，`?Send` 与 Send 双面）；
  - 关键工程决策（有注释）：`session_notification`/`ext_notification` 故意 **fire-and-forget**——注释记录了真实事故：blocking 等待 ACK 会在 relay 链路退化时（Slack 会话 WebSocket 死掉）冻结终端流循环，整个会话挂起（gateway.rs:447-457）。
- **生命周期**：`initialize → authenticate → new_session / load_session → prompt → cancel`，外加 `set_session_mode / set_session_model / ext_method / ext_notification`，全部对齐 ACP 规范；`load_session` 支持恢复本地持久化会话。

### 2.2 agent 核心（xai-grok-agent）

- **Agent 是头等对象**：`Agent` 聚合工具集、系统提示词、system-reminder 策略、compaction 策略、模型配置，任何 host 都能消费（shell / 进程内 host / headless 批跑器）。
- **Agent 定义 = Markdown + YAML frontmatter**（`.grok/agents/*.md`，项目级优先于用户级，按名去重）：`promptMode: extend|full`、`tools` 白名单 / `disallowedTools` 黑名单、`permissionMode`（default/acceptEdits/dontAsk/plan）、`completionRequirement`（编排模式下必须调用某工具才能结束回合，含 recovery 重试策略）、`toolConfig.*.retry`、`toolNameOverrides`/`paramNameOverrides`（对模型重命名工具）。未知 frontmatter 字段静默忽略（前向兼容）。
- **提示词组装**：MiniJinja 模板（`${{ }}`/`${% %}` 自定义定界符避开散文里的字面花括号），extend 模式 = 基础模板（工具约定/格式化规则/user_info）+ 正文 + AGENTS.md + skills；full 模式 = 正文即完整提示词。
- **system_reminder 策略**（system_reminder.rs：nudge/gate 分离、可配置、默认值有测试锁定）：
  - `TodoNudge`：模型超过 N 回合没写 todo 时注入提醒（默认 3 回合）；
  - `TodoGate`：回合结束若仍有 pending/unbacked todos，注入 `<system-reminder>` 强制再跑一轮，**默认关闭、远程/CLI 显式开启**，每 prompt 最多 fire 2 次封顶（防无限推理成本）——"懒模型"治理的具体机制。
- **laziness（偷懒）检测在 shell 层**：`session/acp_session_impl/laziness.rs`（39KB）+ `laziness_classifier.rs`（41KB）+ 专门测试目录（laziness_detector / debug / integration 共 78KB）——检测模型重复相同动作、未进展即停止等行为（changelog 中称为"action-stationarity nudge"）。

### 2.3 shell / UI（xai-grok-shell + xai-grok-pager）

- **SessionActor 会话状态机**（`session/acp_session_impl/`，33 个模块）：
  - `run_loop.rs`（135KB）：session actor 主循环——命令分发、idle 分支、唤醒准入（任务完成/子代理完成/通知排空等 10 种 `PromptOrigin` 合成 prompt，`is_synthetic()` + 滚动回显策略按来源区分）；
  - `turn.rs`（133KB）+ `sampler_turn.rs`（69KB）：单回合执行；
  - `tool_calls.rs`（150KB）+ `tool_dispatch.rs`：工具调用生命周期；
  - `spawn.rs`（122KB）：会话/工作区启动；
  - `stop_gate.rs`：回合结束 gate（stop hooks 可续回合，每回合上限 8 次续接）+ 任务/子代理/定时任务的停止条目收集；
  - `reminders.rs` / `recap.rs` / `rewind.rs` / `interjection.rs` / `notification_drain.rs` / `updates.rs`：提醒、阶段小结、回退、插话、通知批量排干、流式更新。
- **目标系统（goal system）**：`goal_classifier.rs`（285KB）/ `goal_planner` / `goal_orchestrator` / `goal_strategist` / `goal_stop_detector` / `goal_summarizer` / `goal_tracker`——模型驱动地把大任务分类 → 规划 → 分阶段执行 → 验证 → 总结，配合 `plan_mode.rs`（计划模式，enter/exit_plan_mode 工具）与 `workflow/` 引擎（xai-workflow：engine.rs 66KB + journal.rs 23KB，**带 journal 的可续执行工作流引擎**）。
- **leader-follower 架构**（`leader/`）：单 leader 进程持有 agent 状态，TUI/IDE/headless 多客户端经 Unix socket IPC（`leader.rs 模块文档有 ASCII 架构图`）；版本化协议（LEADER_PROTOCOL_VERSION）、锁文件、僵尸 leader 驱逐（30s 判定）、按版本收敛（新客户端替换旧 leader，防抖）、重连指数退避（TUI 无限重试 / headless 有界 5 次）。`server.rs` 317KB 是 shell 内最大文件。
- **TUI（xai-grok-pager）**：ratatui 0.29 + crossterm + syntect 语法高亮；自研 xai-ratatui-textarea / xai-ratatui-inline 补丁 crate；pager-render 独立渲染 crate（1057 个测试）；pager-minimal（轻量模式）；pager-pty-harness + ptyctl（**PTY e2e 测试平台**，派生真实终端环境跑 TUI 测试）。

### 2.4 工具系统

- **统一契约三层**（crates/common/）：
  - `xai-tool-types`：工具 schema / 参数校验 / 输出 / serde 宽容解析；
  - `xai-tool-runtime`：`Tool` trait（非 object-safe，携带关联 Args/Output）+ **object-safe 的 `ToolDispatch`**（JSON 边界编解码）+ `ToolStream` **流式不变量：Progress 块流 + 恰好一个 Terminal 收尾**（缺 Terminal 是协议违规，默认实现报 `stream_no_terminal`）+ `ToolNotification` / `ToolCallContext`（Cancellation/Cwd/BehaviorVersion/WorkspaceBindMetadata）；
  - `xai-tool-protocol`：对进程外工具连接者的帧/握手/注册协议（frames/handshake/registration/error_wire/turn_hook）。
- **实现分层**（xai-grok-tools，233 文件）：`implementations/` 下按套件分：`grok_build`（bash / read_file 多版本 / search_replace / grep(ripgrep) / list_dir / todo / task+task_output / kill_task / web_search / web_fetch(SSRF 防护 + 域策略 + 缓存) / image_gen / video_gen / image_edit / monitor / scheduler(定时任务) / workflow / ask_user_question / enter/exit_plan_mode / update_goal / lsp / memory / skills / use_tool）＋ `grok_build_concise`（精简要件）＋ `grok_build_hashline`（哈希锚点编辑方案）＋ **`codex/` 与 `opencode/` 的移植**（apply_patch / grep_files / read_file 等，README 与 NOTICE 声明）。
- **权限系统**（xai-grok-workspace/src/permission/）：`rules`（`Bash(...)`/`Edit(...)`/`Write(...)`/`Read(...)`/`Grep(...)`/`WebFetch(...)`/`MCPTool(...)` glob 规则，deny 优先，兼容 Claude Code `Bash(cmd:*)` 语法）、`manager`/`policy`/`auto_mode`/`exec_risk`（命令危险性分级）/`bash_command_splitting`（拆分检查绕过）/`gate_preflight`；CLI 侧 `--allow`/`--deny` 可重复，`--always-approve`（yolo）与 plan 模式共存。
- **终端/进程**：portable-pty + process-wrap（Win32 job object 杀进程树）；`xai-tty-utils::ProcessScope::enroll` 强制子进程登记——**clippy 直接 ban 裸 `Command::spawn`**（见 4.2）。

### 2.5 其他子系统（按 crate 扫读）

- **持久化**：会话目录（chat_history JSONL + prompt 文件 + summary）+ rusqlite bundled SQLite（FTS5 + sqlite-vec，注释记录 CVE-2025-29087 等升级动因）+ xai-sqlite-journal（同步日志）；`persistence.rs` 181KB（含会话迁移/relocation 视图）；checkpoint（workspace/session/checkpoint + file_state，支撑 `/rewind` `/undo` 恢复文件）；prompt_history / fork（会话分叉）/ share / export / claude_import（Claude Code 会话导入，83KB）+ foreign_sessions（codex 的 sqlite 解析）。
- **hook 系统**（xai-grok-hooks + xai-hooks-plugins-types，201 测试）：before/after turn、stop、session end、周期任务等事件钩子，写盘有沙箱化拒绝策略（hook_write_deny）。
- **MCP**：xai-grok-mcp（rmcp 2.1 + reqwest 0.13 **隔离在 crate 内**，对外只暴露模型类型——版本冲突的"隔离舱"做法）+ managed_mcp（托管服务端）+ mcp_dispatcher（74KB）+ mcp_restart + mcp_doctor（25KB 诊断）+ computer-hub MCP 适配器。
- **沙箱**（xai-grok-sandbox）：nono 内核强制（Linux Landlock / macOS Seatbelt），进程级网络留开（LLM API），**子进程网络按 seccomp 策略收口**；profiles 分级（workspace/等）。
- **可观测性**：fastrace + opentelemetry-otlp（trace）＋ xai-grok-telemetry unified_log + mixpanel（产品埋点）+ tdigests/prometheus 指标 + heap_profile/dhat + trace_classifier（回放 trace 分类）＋ `grok inspect` 内省命令。
- **更新/发布**：xai-grok-update（自更新，148 单元 + 141 集成测试）、xai-grok-version、announcements。

---

## 3. 功能全景（README + 用户指南提炼）

- **三种运行形态**：全屏 TUI（`grok`）；headless（`grok -p`，输出 plain/json/streaming-json，`-s` 命名会话、`-r` 按 ID/标题恢复、`--max-turns`、`--tools`/`--disallowed-tools` 工具过滤、`--permission-mode`）；ACP agent 模式（`grok agent stdio`，及 WebSocket relay 远程接入）；另有 `grok ssh` 剪贴板透传。
- **认证全家桶**：浏览器登录（grok.com）、API key、**OIDC SSO（PKCE，企业）**、**外部认证二进制协议**（stdout 令牌契约 + `GROK_AUTH_EXPIRED` 静默刷新 + per-model 命名认证提供方，全部含安全边界说明）、token 提前失效刷新。
- **模型**：xAI 模型默认 + **BYOK/自定义端点**（Ollama/OpenAI/custom，`base_url`+`env_key`）、reasoning effort（none→max 分级）、per-session model 切换。
- **会话管理**：自动保存/恢复、`/load` `/resume` `-c` 续最近、`/rewind` `/undo`（回退文件+对话）、`/compact`（上下文压缩，支持工具选择）、fork、分享 URL、导出、Claude Code 会话导入、codex 会话导入。
- **人机交互**：`@` 文件引用（行区间、目录、`!` 显隐文件）、内联 diff、TODO 面板（`Ctrl+T`）、实时工具输出、计划模式（`y` 复制计划）、`Ctrl+G` 前台任务转后台、`Ctrl+R` 历史搜索。
- **任务与后台**：background tasks（bash/监控）、`/loop` 定时任务（scheduler）、monitor 事件 + **idle 通知排干**（用户空闲时批量合成一轮）。
- **扩展体系**：AGENTS.md 项目规则、Skills（可注入提示词包）、Agent Profiles（自定义 agent 定义）、Subagents（并行子会话、类型化 role、worktree 快照）、Plugins（工具/skills 打包 + 信任）、Hooks（生命周期脚本 + 信任 + 沙箱写盘拒绝）、MCP 服务端。
- **记忆与安全**：`--experimental-memory` 跨会话记忆（`/memory` `/flush`）；OS 级沙箱 profiles；权限规则 allow/deny；web_fetch SSRF 防护 + 域策略；卸载/二进制安装脚本。
- **产品面**：dashboard、usage 监控（24-monitoring-usage）、反馈上报、privacy 设置、telemetry 开关、`grok update` 自更新、`grok inspect` 内省、`mcp doctor`。
- 用户指南 24 章 + 入门教程 9 章（pager/docs/）。

---

## 4. 工程质量

### 4.1 测试

- **规模**：全仓约 **29,510 个 `#[test]`/`#[tokio::test` 标注**（pager 约 9.1K、shell 约 6.2K、tools 约 2.9K、workspace 约 1.6K；单 crate 最大 xai-grok-pager 源码内 7,991）。
- **单元测试**：与实现同文件内联（大量带"行为命名"的测试，如 `reports_actual_state_change_only`），测试模块紧随实现。
- **集成测试**（tests/ 目录）：shell 有 40 个集成测试文件，包括 `test_leader_stdio_integration.rs`（135KB，真实 leader 子进程 e2e）、`test_built_binary_e2e.rs`（73KB，**编译真实二进制再跑**）、`test_leader_soak.rs`（浸泡）、`test_session_load_memory.rs` / `test_session_load_perf.rs` / `session_fork_replay_memory.rs`（内存与性能回归）、`test_doom_loop_recovery.rs`（模型死循环恢复）、`test_mcp_integration` / `test_auth_provider_e2e` 等。
- **进程内 e2e 测试具（testkit）**：`session::testkit`（feature-gated）用 **ACP duplex pipes 在进程内把真实 MvpAgent 与客户端接线**跑完整 initialize/authenticate/load 流程——不需要子进程，可时间盒（180s 超时判定）；另有 testkit_synth_roundtrip（会话合成回放）。
- **PTY e2e 平台**：ptyctl（PTY 协议 codegen）+ xai-grok-pager-pty-harness，Cargo.toml 里 14 个 `pty_e2e_*` 测试目标（scroll/selection/persistence/clipboard/auto_mode……），派生真实终端环境测试 TUI。
- **性能**：criterion + benches（session_list 26KB、fork_copy）+ 内存测试（dhat-heap feature + heap_profile_monitor + 泄漏目标）+ 上传 harness trace 回合回放测试。
- 已知弱点（如实记录）：tests/ 需要 `test-support` feature 显式开启，默认不跑；部分 e2e 依赖真实模型/网络（有 mockito/wiremock 与 mock 后端对冲）。

### 4.2 依赖纪律与 lint

- **workspace 统一依赖**（约 230 个条目，单一版本源）；per-crate 用 `workspace = true` 引用，`[lints] workspace = true` 统一生效。
- **每条非默认选择都有书面理由**：`zip` 关默认 feature 防把 aes/bzip2/lzma/zstd 拖进发布二进制（tools/Cargo.toml:35-39）；rusqlite 升级注释挂 CVE 编号；rmcp 隔离舱注释（"quarantined inside xai-grok-mcp"）；`patch.crates-io` 钉 async-openai 内部 fork。
- **clippy.toml**：`disallowed-methods` **ban 裸 `std::fs::canonicalize`（Windows `\\?\` 前缀毒化路径）与裸 `Command::spawn`（未登记的孤儿进程会活得比会话长），并指明替代**（dunce::canonicalize / ProcessScope::enroll）——把跨平台正确性变成编译期强制；`large-error-threshold = 256`（tonic 上游 bug 待修）。
- **workspace lints 全部带理由**：prost 生成的 doc 列表、fastrace 宏的 useless_format、uninlined_format_args 有"merge 队列启用后改为 deny"的 TODO——豁免可审计、可复议。
- 扣分项：xai-grok-shell 与 xai-grok-sandbox 的 `lib.rs` 顶部有 crate 级 `#![allow(unused_imports, unused_variables, unreachable_code, dead_code)]`——monorepo 大仓的卫生妥协，放行死代码。

### 4.3 发布与安全

- `.cargo/config.toml` 按 target 钉 rustflags：Linux musl 加 **RELRO + noexecstack 加固**、全部平台 `force-unwind-tables`、Windows `+crt-static`、aarch64 `target-cpu`、jemalloc page size 按平台（注释解释 Apple Silicon 16KB 页）。
- profile：release-dist（thin LTO、CGU=1、保留符号 + debug 行表供 CI 抽 .debug/dSYM）、panic=abort、jemalloc；发布流程注释完整（alpha→stable 指针换二进制免重建）。
- 安全基座：obfstr（字符串混淆）、ring/rustls-tls-native-roots、extra-ca、secrets crate、SSRF 防护、sandbox、hook 写盘拒绝、权限 deny 优先。

### 4.4 文档

- crate 级 README 有"产品文档级"质量（xai-grok-agent README 含完整 frontmatter schema 表 + 模板变量表 + 发现规则 + crate 关系图）；
- 用户指南 24 章 + 教程 9 章；CHANGELOG 1886 行（0.2.113~0.2.116 连发）+ changelogs/ 按版本文件；
- 根 README 有仓库布局表 + 构建指引；SECURITY.md、THIRD-PARTY-NOTICES（781KB，含许可全文）；
- 不公开 CI（monorepo 内部，代码注释引用 Bazel lint aspect 与 `just lint-rs`；镜像内无 .github）。

---

## 5. 水平评估

### 5.1 功能完成度：A+

商业交付级：三种运行形态（TUI/headless/ACP）之外，子代理、目标系统（classify→plan→execute→verify→summarize）、计划模式、laziness 检测与 todo gate、记忆、沙箱、hooks/plugins/skills/agent profiles 四层扩展、MCP（含托管服务端与 doctor）、BYOK/OIDC/外部认证三套鉴权、会话 fork/rewind/undo/import、定时任务与监控、web 搜索与 SSRF 防护的 web_fetch、LSP、图片/视频生成、usage 仪表盘——每一项都有实现+UI+测试闭环，不是 demo 级。与 opencode（C1）同级，且额外多出"目标系统 + 计划模式 + 沙箱 + leader-follower"四个 opencode 没有或较弱的维度。

### 5.2 架构成熟度：A+

系统性设计过的分层：common 叶子 crate 明确为依赖反转而抽取；工具契约三层（types→runtime→protocol）带流式不变量；SessionActor 回合拆成 run_loop/turn/tool_calls/sampler_turn 且模块边界与测试目录一一对应；goal/workflow 引擎带 journal 可续跑；leader-follower 单 leader 多客户端是"多形态共享一个 agent 状态"的正确解法；wire 稳定性有纪律（PromptOrigin 变体注释"retain prefix for wire stability"、two_pass 兼容、wire_tags）。两个扣分点均属 monorepo 妥协（crate 级 allow 死代码；根 Cargo.toml 生成不可手编），不构成降级。

### 5.3 工程质量：A+

2.95 万测试标注 + 三层测试体系（内联单元 / tests/ 集成 / 进程内 ACP 测试具 + PTY e2e 平台）+ soak/内存/性能基准；依赖纪律把 CVE 与 feature 最小化的理由写进 Cargo.toml；clippy 用 disallowed-methods 把跨平台正确性编译期强制；发布 profile 硬化 + 符号保留供线上可调试。扣分点：e2e 需要 feature-gated（默认不跑）、Windows 为 best-effort 未测、镜像内无 CI 配置可见。

### 5.4 工程规范：A

内部工程规范顶级：生成文件只读纪律、changelog 分层、lint 豁免书面化、"行为命名"测试、代码注释记录事故根因（fire-and-forget 的会话挂起事故）、安全加固。但作为外部参照物：不接受外部贡献（CONTRIBUTING 明说）、git 历史 16 条 sync 提交无粒度、无公开 CI/发布流水线可见——"开源运营"维度不适用，工程规范给 A 而非 A+。

**总评：A+。** 与 C1 的 opencode（A+）同一梯队；差异是路径不同——opencode 赢在开源治理与事件溯源契约，grok-build 赢在商业产品纵深（目标系统/沙箱/leader-follower/测试基建）。

---

## 6. 与 conex/crish 的相关性

- **规模差**：conex crates/ 8.2 万行 vs grok-build 148 万行（约 1:18）；但 conex 是 Rust 内核 + TS 壳的分层，TS 侧 40 万+ 行承担了 UI 职责，grok-build 的 TUI 层（pager 46.9 万行）是纯 Rust 写的。功能覆盖面 conex 已有"会话循环/工具/权限/压缩/记忆"骨架，缺的是**产品层纵深**。
- **会话循环对照**：grok 的 SessionActor ≈ conex 的 crates/session-loop（B3 已对比过循环与状态机）；本次看到的关键增量是回合级机制——laziness 检测、todo gate/nudge、goal 注入轮次、plan-resume 合成 prompt、idle 通知排干、stop hooks 续回合，这些是"循环跑得稳"之外的"循环跑得对"。
- **工具执行对照**：grok 的 ToolStream（Progress + 恰好一个 Terminal 不变量）对应 conex 工具执行的正确性边界；grok 用统一 ToolDispatch 支持进程外工具与 computer-hub 适配，conex 的 agent-tools 仍是进程内。
- **测试基建对照**：conex 的 73 套件基线 vs grok 的 2.95 万标注 + 进程内 ACP 测试具 + PTY e2e——这是最容易直接借鉴的一层（见 7.2）。

---

## 7. 可借鉴点清单（对 conex/crish）

### 7.1 架构层

1. **统一工具运行契约 + 流式不变量**：把工具执行定义成"Progress 块流 + 恰好一个 Terminal 收尾"的 `ToolStream`，缺少 Terminal 即协议违规；`ToolDispatch` 用 object-safe + JSON 边界，进程内/进程外/MCP 工具统一走同一契约（conex 的 agent-tools 目前是进程内专用）。
2. **叶子 crate 依赖反转**：把"谁都不依赖的类型"抽成独立 crate（如 grok 的 xai-tool-types / xai-grok-config-types），打破 shell→tools→agent 的循环；conex 的 conex-types 已迈出一步，可继续向工具类型层推进。
3. **leader-follower 单 leader 多客户端**：conex 若要做 TUI+桌面多形态，与其每端各跑一个会话，不如单 leader + 版本化 IPC（含僵尸驱逐与按版本收敛），这是 grok 对 opencode 的差异化解法。
4. **回合级机制三件套**：todo nudge（N 回合没写 todo 就提醒）、todo gate（回合末有未决 todo 强制续轮，默认关 + fire 上限防成本爆炸）、laziness/动作停滞检测（重复动作或零进展的 nudge）——直接对应 conex 的"模型偷懒"治理需求。
5. **目标系统（goal classify→plan→execute→verify→summarize）**：把"todo 面板"升级为模型参与的目标生命周期，配 plan_mode 的 enter/exit 工具对；可先做 classifier + stop_detector 两个最小件。
6. **进程登记纪律编译期化**：clippy `disallowed-methods` ban 裸 `Command::spawn`/`canonicalize`，强制走 `ProcessScope::enroll`/`dunce`——conex 若在 Windows 上做工具执行，这是低成本高收益的一条。
7. **持久化 session 的 checkpoint + rewind/undo**：按回合记录文件状态（workspace/session/checkpoint），`/rewind` 恢复文件+对话；conex 已有存储写模型，可加"文件状态快照"层。

### 7.2 工程层

8. **进程内 e2e 测试具**：用 ACP duplex pipes（或 conex 自己的 IPC）在进程内接线真实内核跑完整 initialize/load/prompt 流程，带超时断言——不依赖子进程，CI 友好，conex 的 session-loop 测试可直接套用此模式。
9. **PTY e2e 平台**：独立 pty-harness crate + pty_e2e_* 测试目标矩阵（滚动/选择/剪贴板/持久化……），是 TUI/终端类功能唯一的可靠测试方式。
10. **依赖理由入注**：Cargo.toml 里每条非默认 feature/版本选择都挂原因（CVE 编号、二进制体积、版本冲突隔离舱）——conex 现在 73 套件基线，依赖注释习惯可立刻建立。
11. **发布 profile 硬化**：release-dist（thin LTO + CGU=1 + 保留符号 + 行表）+ RELRO/NX 链接参数 + panic=abort dev——发布时照抄即可。
12. **soak/内存基准**：leader soak + session_load_memory + heap_profile 目标，专门防"跑一天内存涨"和"加载慢"两类回归。

### 7.3 产品层

13. **模型端自定义（BYOK/自定义端点 + reasoning effort 分级）**：conex 目前依赖 provider 层，可加 per-model `base_url`/`env_key` 与 effort 透传。
14. **计划模式与 plan-resume 合成轮**：审批/修订后注入合成 prompt 续跑（不进 prompt 历史），比"继续对话"语义更准。
15. **idle 通知排干**：后台任务完成事件不即时打断，积压到用户空闲时批量合成一轮——后台任务的 UX 细节。
16. **子代理的 worktree 快照 + 孤儿回收**：子代理跑在独立 worktree，崩溃后按快照回收文件（`test_subagent_orphan_reconcile`）。

> 排序建议：先做 1（工具契约）、8（进程内 e2e）、6（spawn/canonicalize 禁令）——三者都是低成本、立刻提升正确性与可测性的项；4（回合级机制）与 5（目标系统）在会话循环稳定后再上。

---

## 8. 附录：调研证据索引（抽查文件）

| 证据 | 位置 |
| --- | --- |
| workspace 成员/依赖/profile/lints | `Cargo.toml`（自动生成，只读）、`clippy.toml`、`rustfmt.toml`、`rust-toolchain.toml`、`.cargo/config.toml` |
| ACP 封装 | `crates/codegen/xai-acp-lib/src/{gateway,channel,message,lib}.rs` |
| agent 核心 | `crates/codegen/xai-grok-agent/src/{builder.rs(108KB),config.rs(105KB),discovery.rs,system_reminder.rs}` + `README.md`（frontmatter schema） |
| 会话循环 | `crates/codegen/xai-grok-shell/src/session/acp_session_impl/{run_loop.rs(135KB),turn.rs(133KB),tool_calls.rs(150KB),sampler_turn.rs,stop_gate.rs,laziness.rs,laziness_classifier.rs}` |
| 目标系统 | `src/session/{goal_classifier.rs(285KB),goal_tracker.rs,goal_orchestrator.rs,goal_planner.rs,plan_mode.rs}` |
| leader-follower | `src/leader/{mod.rs,server.rs(317KB),protocol.rs,lock.rs}` |
| 工具契约 | `crates/common/xai-tool-runtime/src/{dispatch.rs,tool.rs,streaming.rs}`、`xai-tool-protocol/src/`、`xai-tool-types/src/` |
| 工具实现 | `crates/codegen/xai-grok-tools/src/implementations/{grok_build,codex,opencode,lsp}/`（233 文件） |
| 权限 | `crates/codegen/xai-grok-workspace/src/permission/{rules.rs,manager.rs,exec_risk.rs,bash_command_splitting.rs}` |
| 持久化/checkpoint | `src/session/{persistence.rs(181KB),chat_persistence.rs}`、`xai-grok-workspace/src/session/checkpoint*.rs`、`xai-sqlite-journal` |
| e2e/测试基建 | `xai-grok-shell/tests/`（40 文件）、`src/session/testkit/e2e.rs`、`xai-grok-pager-pty-harness`、`crates/codegen/ptyctl` |
| 文档 | 根 `README.md`、`crates/codegen/xai-grok-pager/docs/user-guide/`（24 章）、`CHANGELOG.md`（1886 行）、`THIRD-PARTY-NOTICES` |
| 版本与同步 | `SOURCE_REV`、git 日志（16 条 "Synced from monorepo"） |

> 备注：镜像为 monorepo 周期导出（16 条 sync 提交），评级基于代码与配置的静态质量；测试标注数为 `#[test]`/`#[tokio::test` 行匹配统计，方向性可靠但非精确测试计数。
