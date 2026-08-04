# 模块 A（命令执行与进程生命周期）+ 模块 B（后台任务管理）需求现状分析

> **文档版本**：v1.0
> **创建日期**：2026-08-04
> **文档性质**：需求现状分析（Feature Gap Analysis）
> **输入需求文档**：`docs/feature-gap-analysis/REQ-agent-engine-capabilities.md` 第二章（模块 A，REQ-A01~A05）与第三章（模块 B，REQ-B01~B04）
> **分析范围**：Rust 内核（`crates/`）命令执行链、Tauri 壳层（`apps/agent-workbench/src-tauri/`）进程管理、React 前端（`apps/crish-desktop/`）后台任务残留面
> **结论摘要**：模块 A 仅完成「同步等待 + 超时树杀」这一种模式（REQ-A01 部分）；禁 `cd` 完全未实现；输出防溢的**截断算法已完备但截断后完整日志无落盘**；资源监控完全缺失；后台任务系统（模块 B 全部四条）在 R1 重构中随 sidecar daemon 一并删除，Rust 侧无任何残留实现，前端残留一批调用已删除命令的死代码。整体判定：**模块 A 约 25% 已实现（且集中在同步路径），模块 B 约 0%**。

---

## 目录

- [一、调查范围与方法](#一调查范围与方法)
- [二、总体现状：从 sidecar daemon 到 Rust 内核的演进与能力断层](#二总体现状从-sidecar-daemon-到-rust-内核的演进与能力断层)
- [三、REQ-A01 命令执行三模式](#三req-a01-命令执行三模式)
- [四、REQ-A02 工作目录显式指定（禁止 cd）](#四req-a02-工作目录显式指定禁止-cd)
- [五、REQ-A03 命令输出防溢出控制](#五req-a03-命令输出防溢出控制)
- [六、REQ-A04 基于资源监控的进程健康判定](#六req-a04-基于资源监控的进程健康判定)
- [七、REQ-A05 命令日志持久化与按需读取](#七req-a05-命令日志持久化与按需读取)
- [八、REQ-B01 后台任务列表查询](#八req-b01-后台任务列表查询)
- [九、REQ-B02 任务状态与日志检查](#九req-b02-任务状态与日志检查)
- [十、REQ-B03 交互式标准输入注入](#十req-b03-交互式标准输入注入)
- [十一、REQ-B04 任务终止](#十一req-b04-任务终止)
- [十二、模块总结：判定表、真 gap 清单与优先级建议](#十二模块总结判定表真-gap-清单与优先级建议)
  - [12.1 整体判定表](#121-整体判定表)
  - [12.2 真 gap 清单](#122-真-gap-清单按依赖序)
  - [12.3 优先级建议与实施顺序](#123-优先级建议与实施顺序)
  - [12.4 架构一致性自检](#124-架构一致性自检对照-req-1213-设计原则)
  - [12.5 测试策略与验收锚点](#125-测试策略与验收锚点)
  - [12.6 关键依赖与前置修复汇总](#126-关键依赖与前置修复汇总)
---

## 一、调查范围与方法

### 1.1 本次调查的代码事实源

| 代码区域 | 路径 | 关注点 |
| :--- | :--- | :--- |
| 命令工具 | `crates/agent-tools/src/tools/shell.rs` | `shell_command` 工具：同步执行、超时、输出截断 |
| 工具上下文 | `crates/agent-tools/src/context.rs` | `ToolContext`：workspace_root / ask / abort_token |
| 命令门禁 | `crates/conex-sandbox/src/lib.rs` | `CommandGatekeeper`：红线 / 审批 / 语义层 |
| 输出预算 | `crates/agent-tools/src/output.rs` | `stringify` / `budget_text_for_context` / `summarize` |
| 截断算法 | `crates/conex-compaction/src/tool_output.rs` | G8 截断：2000 行 / 50KB，head+标记+tail |
| 壳层进程执行 | `apps/agent-workbench/src-tauri/src/process.rs` | `workbench_run_shell`、Job Object、树杀 |
| 性能工具 | `apps/agent-workbench/src-tauri/src/perf/` | fs / jsonl / hash / encoding / diff |
| 命令注册面 | `apps/agent-workbench/src-tauri/src/main.rs` | `command_registry!` 编译期真源 |
| run 生命周期 | `apps/agent-workbench/src-tauri/src/core_run_commands.rs` | `CoreRunState` / `ActiveRun` / `drive_run_loop` |
| 会话循环 | `crates/session-loop/src/` | `SessionLoopOptions` / `ToolBatchOptions` / 控制总线 / nudge |
| PTY | `apps/agent-workbench/src-tauri/src/pty/` | portable-pty 会话（终端面板专用） |
| 前端残留 | `apps/crish-desktop/src/api/backgroundTasksApi.ts` 等 | 后台任务 API 死代码面 |
| 历史 | git 提交 `6e2e180e`、`docs/multi-agent-repair/reports/R1-轮次报告.md` | sidecar daemon 删除、background-command-bridge 删除 |

### 1.2 调查方法

1. 逐文件通读上述代码，抽取数据结构（struct / enum / trait）与关键函数签名，标注 `文件:行号`；
2. 用 git 历史确认后台任务系统（sidecar daemon → R1 重构）的删除过程与遗留痕迹；
3. 全仓库 grep 确认「资源监控（CPU/内存/IO）」「PAGER」「后台任务命令」等能力的存在性；
4. 对每条 REQ 按「现状证据 → 判定 → 差距 → 应该怎么做」四段式展开，建议一律落位到现有架构组件（工具注册表 / ToolContext / 门禁 / 壳层 State / 控制总线 / nudge 通道），不另起炉灶。

---

## 二、总体现状：从 sidecar daemon 到 Rust 内核的演进与能力断层

### 2.1 历史演进脉络（git 证据）

- **旧时代（TS 时代）**：后台任务能力由两部分承载：
  - `apps/agent-workbench/src/shared/background-command-bridge.ts`：前端与命令执行桥接的 TS 模块；
  - `packages/agent-daemon`（`background-task-manager.ts`）：sidecar daemon 内的后台任务管理器，提供 `list-background-tasks` / `cancel-background-task` 等 WS 协议命令。
  - 壳层侧对应三个 Tauri 命令：`workbench_list_background_tasks` / `workbench_get_background_task_output` / `workbench_cancel_background_task`（删除前的实现见 `git show 6e2e180e -- src/sidecar/commands/run_commands.rs`）。
- **R1 重构（提交 `6e2e180e`，2026-08-02，「rewrite src-tauri core shell (R1-R4), drop sidecar daemon」）**：
  - 整目录删除 `src-tauri/src/sidecar/`（WS daemon 桥），其中 run_commands.rs 里上述三个后台任务命令一并删除；
  - R1-T5a 任务同时删除 `src/shared/background-command-bridge.ts`（+test）与 CLI 面（证据：`docs/multi-agent-repair/reports/R1-轮次报告.md:14`、`docs/rust-rewrite/22-phase-d-cleanup-plan.md:37/43`）；
  - 自此 Rust 侧**没有任何后台任务注册表、任务 ID、日志文件、stdin 管道、kill 命令**。
- **遗留**：`apps/crish-desktop/src/api/backgroundTasksApi.ts`（557 行）+ `useBackgroundTaskPolling.ts` + `useEngineState.ts` / `updateStore.ts` / `useOverviewState.ts` 仍在调用已删除的命令（见 §2.3），构成前端死代码面。

### 2.2 当前命令执行链全景（Rust 内核）

当前唯一的命令执行路径是**同步等待 + 超时树杀**，全链路如下：

```
AI 模型 ──tool call──▶ shell_command（crates/agent-tools/src/tools/shell.rs:120 execute）
    │ 1. 参数校验：command 非空 / ≤32KB（:125-133）
    │ 2. cwd 解析：resolve_workspace_path 校验工作区内 + is_dir（:135-144）
    │ 3. timeoutMs 解析并 clamp 到 [1ms, 600s]（:145-147）
    │ 4. 命令门禁 CommandGatekeeper：Blocked / RequiresApproval（:151-196）
    │    - 红线 → tool.command_blocked（:157-171）
    │    - 越界 → 审批通道 ctx.ask 或 tool.requires_approval（:172-196）
    │ 5. 删除形态重定向：semantics DeleteShape → 回收站接管（:198-213）
    ▼ 6. run_command（:624-707）
       - build_shell_invocation：Windows PowerShell -EncodedCommand（UTF-16LE→base64，
         命令体再 base64 包进 scriptblock，:509-533）；Unix bash -lc
       - tokio::process::Command：cwd 设置、stdin=null、stdout/stderr=piped、
         kill_on_drop(true)、CREATE_NO_WINDOW（:633-651）
       - wait_with_output + timeout(Duration::from_millis(timeout_ms))（:660-661）
       ├─ 成功：clamp_output_bytes 截断（默认 200KB，head/tail 各半，:666-681）
       └─ 超时：terminate_process_tree（Windows taskkill /T /F，:687-705）→ timedOut=true
    ▼ 结果回 AI：{command, cwd, exitCode, stdout, stderr, timedOut, truncated, durationMs, text}
```

壳层终端面板另有同源同步路径 `workbench_run_shell`（`apps/agent-workbench/src-tauri/src/process.rs:57-157`），语义相同但不经审批（用户主动输入），默认 60s 超时、400KB 输出上限。两条路径都不具备任何「后台化」能力。

### 2.3 前端后台任务残留面（死代码确认）

- `backgroundTasksApi.ts:511-557`：`listBackgroundTasks()` → `invokeCmd('workbench_list_background_tasks')`、`getBackgroundTaskOutput()` → `invokeCmd('workbench_get_background_task_output', …)`、`cancelBackgroundTask()` → `invokeCmd('workbench_cancel_background_task', …)`；
- 三个命令在 Tauri 注册面（`main.rs:76-164` 的 `command_registry!`）与整个 `src-tauri/src` 中 **0 命中**（grep 验证）；
- `invokeCmd` 为宽松语义：命令缺失/失败一律返回 `null`（`tauriInvoke.ts:185-192`）→ `parseBackgroundTaskList(null)` 返回 `[]` → UI 静默显示空列表；
- `useBackgroundTaskPolling.ts:33` 每 3 秒轮询一次空结果，`useEngineState.ts:99` 用 `.catch(() => EMPTY_BG_TASKS)` 兜底。

**结论**：前端后台任务 UI 与 API 层是「调用已删除命令的死代码」，不产生运行时报错但完全失效；修复方向不是删前端，而是在 Rust 侧重建后台任务系统并恢复这三条命令（见 §八~§十一）。

### 2.4 旧系统遗产盘点（git 历史恢复的设计资产，勿重复发明）

R1 删除的旧 TS 后台任务系统不是「无价值死代码」，其中蕴含**已验证的设计语义**。本次调查从 `967e7846^` 父提交恢复了四个关键实现，作为新 Rust 实现的设计参照（**只借鉴语义与数据结构，不复活 WS 协议**）：

#### 2.4.1 `BackgroundCommandManager`（packages/agent-tools TS 侧，任务本体）

- **快照字段**（`BackgroundCommandSnapshot`）：`id / command / cwd / state / pid / startedAt / updatedAt / finishedAt / durationMs / timeoutMs / exitCode / signal / timedOut / cancelled / truncated / outputPreview / stdoutPreview / stderrPreview / stdoutBytes / stderrBytes / terminationDiagnostics / error`——与 REQ-B01/B02 要求字段几乎一一对应，前端 `backgroundTasksApi.ts` 的解析层（`parseBackgroundTask`，`:231-276`）就是按这套形状写的（`outputPreview` 字段在前端仍有解析逻辑，`:259-266`）；
- **状态机**：`running | succeeded | failed | cancelled | timed-out`——前端 `normalizeBackgroundTaskState`（`backgroundTasksApi.ts:126-180`）的全部别名映射（`done/completed/active/expired` 等）都服务于这套状态；
- **事件面**（`BackgroundCommandEvent`）：`task-start / task-heartbeat / task-output / task-end`，其中 `task-output` 做了 **60ms 节流**（`handleData` 内 `throttleTimeout`）——事件驱动的输出推送有现成先例，模块 C（REQ-C04 反应式唤醒）的 `task.output` topic（REQ-D06 事件总线）可以直接继承这四类事件语义；
- **内存边界**：`BoundedProcessOutput(maxOutputBytes)`（默认 500KB）有界输出缓冲——「预览 + 全量落盘」的分工（预览在内存、全量在文件）是正确设计，新实现保留；
- **容量上限**：`MAX_BACKGROUND_TASKS = 200` 有界 Map，**FIFO 淘汰且淘汰时若仍在运行先终止**（`BoundedMap` 的 evict 回调）——比需求「30 分钟归档」更硬的兜底，新实现两者结合（30 分钟归档为主 + 200 条硬上限兜底）；
- **run 关联**：`runIndex: runId → Set<taskId>`，支持 `cancelAllForRun` 批量取消——「任务与 run 生命周期关联」的旧语义；新实现建议保留 runId 关联字段（审计与批量终止用），但**默认不自动级联杀**（§11.4 第 4 点），由 AI 显式决定。

#### 2.4.2 `DaemonBackgroundTaskManager`（agent-daemon 侧，多工作区编排）

- 按 workspace 分组管理（`BoundedMap<workspaceRoot, BackgroundCommandManager>`，上限 50），`getManagerForWorkspace` 懒创建——多工作区隔离语义；
- `list / history / get / cancel / dispose` 五操作 + 诊断快照（`BACKGROUND_TASK_SNAPSHOT_READY` 等）——**dispose（daemon 关停时逐个终止所有任务）语义对应新实现的「应用退出 → Job Object 兜底全杀」**；
- 错误码三态：`BACKGROUND_TASK_NOT_FOUND / START_FAILED / CANCEL_FAILED`——新实现 `KillResult` 三态（§11.4）与 `ToolError::NotFound` 的错误协议可对齐。

#### 2.4.3 `ScriptWaitPolicy`（agent-runtime 侧，等待策略——REQ-A01 模式 2 的直接参照）

- `ScriptRunMode = "wait" | "continue"` + `suggestRunMode(command, avgDurationMs)`：命令家族（`commandFamily`：package-test / package-build / package-install / native-build / python-test…）判定 + 每家族最近 20 次平均时长滚动统计（>90s → continue，<15s → wait）；
- 阈值常量：`PARALLEL_SOFT_LIMIT_MS = 120_000`（超过 2 分钟建议真等而非继续开新轮）、`NOISY_POLL_GAP_MS = 20_000` / `NOISY_POLL_THRESHOLD = 3`（AI 频繁轮询判噪）；
- 设计目标注释原文：**「Never kill scripts just so the model can keep talking」**——与 REQ 1.2 设计原则 3（不误杀正常进程）完全同源；
- **对照**：REQ-A01 的 `WaitMsBeforeAsync=3000` 是「单命令等待窗口」的**下限**语义，旧 `ScriptWaitPolicy` 是「跨轮次等待策略」的**上层**语义——两者互补；新实现第一阶段只做等待窗口（A01），`ScriptWaitPolicy` 的家族时长统计与噪询检测建议在模块 C（REQ-C05 AI 等待策略自动选择）落地时移植（P2）。

#### 2.4.4 `ProcessManager`（agent-core 侧，两阶段终止——REQ-B04 的直接参照）

- **两阶段终止已是旧系统已验证的设计**：状态机 `spawning → running → terminating（已发 SIGTERM）→ force-killing（SIGTERM 超时发 SIGKILL）→ exited`，`gracefulTimeoutMs` 默认 5000ms（与 REQ-B04「等待 5 秒」一致）；
- 退出分类：`clean-exit / error-exit / signal-exit / timeout-kill / spawn-error`——对应 `terminationDiagnostics` 数组（daemon 快照字段），前端 `backgroundTasksApi.ts` 的 `BackgroundTaskInfo` 虽未带该字段，但 `daemonTaskFromRuntimeTask` 的映射先例可参考；
- 生命周期钩子：`onSpawn / onExit / onError / onTimeout / onForceKill`——新实现经 Rust 侧事件（`AgentEvent` 或 hook 注册表）承担同类职责。

#### 2.4.5 遗产处置结论

| 旧资产 | 处置 | 落点 |
| :--- | :--- | :--- |
| 快照字段形状 | ✅ 语义继承 | `BackgroundTaskInfo` / `BackgroundTaskStatus`（§3.4/§9.4） |
| 状态机五态 + 前端归一映射 | ✅ 直接复用 | 前端 `backgroundTasksApi.ts` 原样保留 |
| task-output 节流事件 | ✅ 语义继承 | 模块 C/D 事件总线（本模块只留事件面） |
| BoundedProcessOutput 内存预览 | ✅ 继承 | `TaskHandle` 内存预览 + 文件全量 |
| runIndex / cancelAllForRun | 🟡 保留 runId 关联，不自动级联杀 | registry 元数据 |
| 多工作区分组 | 🟡 简化：会话级单注册表 + 工作区字段 | registry |
| ScriptWaitPolicy | 🟡 移植到模块 C（REQ-C05） | 本模块只做等待窗口 |
| ProcessManager 两阶段终止 | ✅ 移植为 `kill` 实现 | `background.rs`（§11.4） |
| WS 协议（list-background-tasks 等） | ❌ 不复活 | 新 Tauri 命令直连 registry |

### 2.5 判定总表（先行结论，细节见各节）

| 需求 | 优先级 | 现状判定 | 一句话理由 |
| :--- | :---: | :--- | :--- |
| REQ-A01 三模式 | P0 | **部分实现**（仅模式 1） | 同步等待+超时树杀已完备；转后台/守护进程/任务 ID 全部缺失 |
| REQ-A02 禁 cd | P0 | **未实现** | cwd 参数与门禁越界检查已有，但 `cd` 不被任何一层拦截 |
| REQ-A03 输出防溢 | P1 | **部分实现** | 截断算法三层齐备且尾部保留；PAGER=cat、完整日志落盘、高输出命令建议缺失 |
| REQ-A04 资源监控 | P1 | **未实现** | 全仓库无 CPU/RSS/IO 采集（perf 模块是文件性能工具，非进程监控） |
| REQ-A05 日志持久化 | P1 | **未实现** | 无后台任务则无日志文件；同步输出截断即丢弃 |
| REQ-B01 任务列表 | P0 | **未实现** | R1 随 sidecar 删除，Rust 侧无注册表 |
| REQ-B02 状态与日志 | P0 | **未实现** | 同上 |
| REQ-B03 stdin 注入 | P1 | **未实现** | shell 工具 stdin=null；PTY 仅终端面板使用，AI 工具侧不可达 |
| REQ-B04 任务终止 | P0 | **未实现** | 仅有同步路径的强制树杀（taskkill /F），无任务概念、无两阶段优雅终止 |

---

## 三、REQ-A01 命令执行三模式

### 3.1 现状证据

**模式 1（同步等待）——已实现且质量较好**：

- `shell.rs:120-216`：`execute()` 全流程为阻塞等待：`run_command` 内 `child.wait_with_output()` + `timeout()`（`shell.rs:660-661`），命令完成返回 `exitCode / stdout / stderr / timedOut / durationMs`（`shell.rs:670-681`）；
- 超时语义与「树杀」配套：`terminate_process_tree`（Windows `taskkill /PID x /T /F`，`shell.rs:774-785`），测试 `shell_timeout_kills_and_marks`（`shell.rs:950-964`）覆盖；
- 默认超时 30s（`BuiltinToolConfig.default_shell_timeout_ms`，`agent-tools/src/tools/mod.rs:63`），入参 `timeoutMs` clamp 到 `[1, 600_000]`（`shell.rs:145-147`）；
- abort 协作：工具级执行在 `tool_exec.rs:816-828` 有 abort-aware 竞速（`tokio::select!` 超时 vs 中止信号），超时参数来自 `ToolBatchOptions.timeout`（默认 60s，`tool_events.rs:199-226`）。

**模式 2（超时自动转后台异步）——不存在**：

- 超时分支唯一动作是「树杀 + 返回 timedOut=true」（`shell.rs:687-705`），没有「升级为后台任务、分配 Task ID、释放 AI 线程」的任何代码路径；
- `ShellCommandTool` 的 input_schema 只有 `command / cwd / timeoutMs / maxOutputBytes`（`shell.rs:88-98`），无 `WaitMsBeforeAsync` / `mode` / `IsDaemon` / `ResourceMonitor` 参数；
- 壳层 `workbench_run_shell` 同样只有同步+超时杀（`process.rs:114-155`）。

**模式 3（守护进程）——不存在**：

- 无任何「不回收的常驻进程」管理；进程回收手段（Job Object）只用于孤儿保护（进程挂掉时杀进程树），方向相反：`create_kill_on_close_job_object` + `init_pty_job_object`（`process.rs:366-479`），语义是「宿主崩溃 → 杀全部 PTY 子进程」，不是「守护进程托管」；
- 无守护进程日志文件、无按需读取最新日志的通道（A05 的底座为空）。

### 3.2 判定

**部分实现**。模式 1 完整（同步 + 超时 + 树杀 + abort 协作）；模式 2、3 完全缺失，且超时语义与「不误杀正常进程」原则（REQ 1.2 设计原则 3）存在直接冲突——当前实现超时即杀，正是需求文档明令禁止的「强制硬超时杀进程」。

### 3.3 差距清单

1. 无后台任务注册表 / 任务 ID 生成 / 状态机（running/completed/failed/killed）；
2. 超时分支是「杀死」而非「转后台」，与 REQ-A04 防误杀原则矛盾；
3. 无守护进程语义（不回收、日志累积、随时读尾部）；
4. `ToolContext` 无任何任务管理通道（对照：写路径互斥 `write_claims`、审批 `ask` 都是经 `ToolContext` 注入的现成模式，`context.rs:100-118`）；
5. tokio `kill_on_drop(true)`（`shell.rs:640`）意味着一旦超时放弃 `wait_with_output`，child 会在 drop 时被杀——**转后台需要把 Child 所有权转移给后台管理器**，当前架构未预留此接口；
6. 无「守护进程在 AI 对话结束后继续运行」的存活管理（run 结束 → 进程去向未定义）。

### 3.4 应该怎么做（落地到现有架构）

**总原则**：采用与 `run_subagent` / `wait_subagents` 完全相同的「agent-tools 定义契约 trait → 壳层实现并注入」模式（`BuiltinToolConfig.subagent_spawner`，`agent-tools/src/tools/mod.rs:53-57`；`RunSubagentTool::with_spawner`，`mod.rs:107-108`）。后台任务管理器在壳层实现（进程 / Job / 日志路径原语都在壳层），工具侧只持 trait 引用。

**（1）新增 trait（agent-tools 侧，新文件 `crates/agent-tools/src/background.rs`）**：

```rust
/// 后台任务管理器契约（AI 侧工具与壳层实现的解耦边界）
#[async_trait]
pub trait BackgroundTaskManager: Send + Sync + std::fmt::Debug {
    /// 把已 spawn 的 child 转交给后台托管（模式 2 / 3 共用入口）
    async fn adopt(&self, req: BackgroundAdoptRequest) -> Result<BackgroundTaskRef, ToolError>;
    /// 查询任务列表（REQ-B01）
    async fn list(&self, include_finished: bool) -> Result<Vec<BackgroundTaskInfo>, ToolError>;
    /// 查询单任务状态与尾部日志（REQ-B02）
    async fn status(&self, task_id: &str) -> Result<BackgroundTaskStatus, ToolError>;
    /// 向任务 stdin 写入（REQ-B03）
    async fn send_input(&self, task_id: &str, text: &str) -> Result<(), ToolError>;
    /// 两阶段终止（REQ-B04）
    async fn kill(&self, task_id: &str) -> Result<KillResult, ToolError>;
    /// 按行范围读取日志（REQ-A05）
    async fn read_log(&self, task_id: &str, start_line: u64, max_lines: u64)
        -> Result<LogSlice, ToolError>;
}

pub struct BackgroundAdoptRequest {
    pub child: tokio::process::Child,   // kill_on_drop 已关闭，所有权转移
    pub command: String,
    pub cwd: PathBuf,
    pub is_daemon: bool,                // 模式 3：run 结束不回收
    pub resource_monitor: bool,         // REQ-A04
}
```

**（2）`ShellCommandTool` 扩展（`shell.rs`）**：

- input_schema 增加 `mode`（`"sync" | "auto-background" | "daemon"`，缺省 `"sync"`）、`waitMsBeforeAsync`（缺省 3000）、`resourceMonitor`（缺省 false）、`isDaemon`（模式 3 专用）四个参数；
- 结构体新增 `background: Option<Arc<dyn BackgroundTaskManager>>` 字段（`BuiltinToolConfig` 增加同名字段，注册面 `mod.rs:92-97` 透传；None = 未接线，保持现状行为：超时即杀）；
- 执行流改造：模式 1 走现有 `run_command`；模式 2 走新的 `run_command_maybe_background`：**spawn 前设置 `kill_on_drop(false)`**，`timeout(wait_ms, wait_fut)` 窗口内完成 → 正常返回（行为等同模式 1，满足「短命令不浪费后台开销」）；窗口超时 → **不杀**，把 `Child`（stdout/stderr 管道仍在）交给 `manager.adopt(...)`，立即返回 `{ "mode": "background", "taskId": "...", "logPath": "...", "text": "命令已转后台（task <id>），可随时查询状态" }`，AI 执行线程即释放；
- 模式 3：spawn 后立即 adopt（`is_daemon=true`），返回 taskId 与 logPath；托管方不因 run 结束而回收（回收策略见 §八）。

**（3）壳层实现（新文件 `apps/agent-workbench/src-tauri/src/background.rs`）**：

- `BackgroundTaskRegistry`：`Mutex<HashMap<String, Arc<TaskHandle>>>`，与 `CoreRunState.active_runs`（`core_run_commands.rs:699`）同构；
- `TaskHandle`：`child: tokio::process::Child`（所有权在托管方）+ `writer: JoinHandle<()>`（stdout/stderr 读取 → 日志文件 append，边写边数行数）+ 元数据（`status / started_at / line_count / last_output_at / log_path / exit_code / prompt: Option<String>`）；
- 依赖注入：`app.manage(Arc::new(BackgroundTaskRegistry::new(app_dir))`（参照 `CoreRunState` 的 `app.manage` 接线，`main.rs:244`），`CoreRunState` / 工具执行器装配 `ToolContext.background`（参照 `write_claims` 的注入路径）；
- **回收语义**：应用退出 → 复用 `create_kill_on_close_job_object`（`process.rs:391-421`）为后台任务单独建 Job（现注释 `process.rs:356` 已预留「daemon/sidecar job series was orphaned after sidecar removal」，正好是恢复该 Job 系列的位置）；run 结束不杀、会话级存活。

**（4）验收对齐**：模式 2 中 `WaitMsBeforeAsync` 窗口语义、模式 3 中「AI 对话结束后守护进程仍运行且日志持续累积」均由 registry 的会话级存活保证（对话结束 = run 终态，见 `core_run_commands.rs:1133-1183` 的 `drive_run_loop` 收口路径——终态只清理 `active_runs`，不触碰 registry）。

**风险与边界条件**：

1. **Child 所有权转移竞态**：tokio `Child` 在 drop 时若 `kill_on_drop=true` 会杀子进程（`shell.rs:640`）——模式 2 的 spawn 路径必须**在 spawn 前**设置 `kill_on_drop(false)`，等待窗口超时后把 `Child` 经 `adopt` 转移给 registry；若等待窗口内完成，则同步路径自己负责回收（wait 后 drop 即可，无泄漏）；
2. **管道缓冲死锁**：模式 2 等待窗口期间若命令大量输出，stdout 管道缓冲（64KB）可能写满阻塞子进程——等待窗口内必须**持续读取**（流式读取，§12.2 G2），不能干等 `wait_with_output`；这是「短命令不浪费后台开销」与「不因缓冲卡死」的平衡点；
3. **超时语义回归**：模式 2 落地后「默认超时即杀」成为历史——但 `timeoutMs` 参数仍应保留（AI 显式设置长跑防护的合法用途），与「等待窗口」是两个维度：`timeoutMs`（绝对上限，超过仍可转为后台）与 `waitMsBeforeAsync`（转后台窗口，默认 3000ms）；两者关系需在工具 description 中写明，避免 AI 混淆；
4. **审批与后台化的顺序**：门禁（`shell.rs:151-196`）与审批必须发生在 spawn 之前（现状已如此）；不得出现「已转后台的命令事后被审批拒绝」的竞态——adopt 前完成全部判定；
5. **守护进程的孤儿语义**：模式 3 的 Job 分配必须使用**独立 Job**（不是 PTY Job，`process.rs:451` 的 `PTY_JOB_OBJECT` 是终端面板专用），否则守护进程会被终端面板的 kill_all 连带误杀；恢复 `process.rs:356` 注释预留的 daemon Job 系列时注意与 PTY Job 隔离。

---

## 四、REQ-A02 工作目录显式指定（禁止 cd）

### 4.1 现状证据

**cwd 显式指定——已实现**：

- `shell.rs:135-144`：`resolve_workspace_path(workspace_root, cwd 参数)` 解析绝对路径，`!cwd.is_dir()` 直接拒绝（`shell.rs:139-144`），测试 `shell_cwd_must_be_valid`（`shell.rs:967-981`）覆盖「不存在目录」与「工作区外目录（tool.path_escape）」两种拒绝；
- 门禁层有工作区上下文检查：`check_command_with_context`（`conex-sandbox/src/lib.rs:114-136`）在 cwd 位于工作区外时把命令升级为 `RequiresApproval`；
- `TokioCommand::current_dir(cwd)`（`shell.rs:636`）保证每个进程在指定目录下启动，进程内 `cd` 只影响该进程自身，不会污染其他工具调用。

**禁止 cd——未实现**：

- `CommandGatekeeper` 的 blocked_patterns（`conex-sandbox/src/lib.rs:21-42`）与 approval_patterns（`:44-57`）均无 `cd` / `Set-Location` / `pushd` 相关条目；
- 语义层（`conex-sandbox/src/semantics.rs` 的 `SemanticAnalysis`）只有 `DeleteShape` / `Dangerous` / `Redline` 等类别，无 `CdShape`；
- `shell.rs` 执行前只做「长度、cwd、门禁、删除形态」四项检查（`:125-213`），`cd` 命令原样放行执行；
- 壳层 `workbench_run_shell`（`process.rs:57-77`）同样只做红线检查，不拦 `cd`。

### 4.2 判定

**未实现**（cwd 显式指定部分已实现且健壮，禁止 `cd` 部分 0%）。

### 4.3 差距清单

1. `cd`（及 PowerShell `Set-Location` / `pushd` / `popd` 变体）可自由执行，Agent 可能写出「cd 链」导致路径状态混乱——虽然进程级隔离使状态不泄漏到其他调用，但**命令内后续段**（`cd sub && git status`）的行为依赖执行时的目录状态，语义不透明；
2. 需求要求的拒绝文案「请使用 `Cwd` 参数指定工作目录，而非 `cd` 命令」不存在；
3. `cd` 与删除形态（DeleteShape）的处理模式可完全同构（语义分类 → 拦截 + 引导），但语义层未扩展。

### 4.4 应该怎么做

**在 conex-sandbox 语义层扩展 `CdShape`，拦截逻辑放在 shell 工具（与删除形态重定向完全同构）**：

1. `crates/conex-sandbox/src/semantics.rs`：`CommandClass` 新增 `CdShape`；段分类器识别 `cd` / `Set-Location` / `pushd` 前缀段（含 `cd /d`、`cd ..` 变体）；
2. `shell.rs` 在现有删除形态检查之后（`shell.rs:198-213` 附近）增加对称逻辑：
   - 纯 `cd` 命令（`overall_class == CdShape`）→ 返回结构化错误：`"请使用 Cwd 参数指定工作目录，而非 cd 命令"`（错误码可复用 `tool.command_blocked` 或新增 `tool.cd_blocked`）；
   - 复合链含 `cd` 段（复用 `analysis.segments` 判断，参照 `:276-293` 的整链拦截模式）→ 整链拦截 + 引导（链内其他段依赖目录状态，语义不可控，不代为执行）；
3. 注意与现有删除形态逻辑的关系：`cd` 段不会触发 DeleteShape，两条路径互不干扰，判定顺序为「门禁 → 删除形态 → cd 形态 → 执行」；
4. 壳层 `workbench_run_shell`（`process.rs:70-77`）同步增加同样的 `cd` 检查（用户终端面板的 cd 是合法的交互操作——**但** `workbench_run_shell` 是单命令执行面板，保留允许 cd 属产品决策；如需求要求全路径禁 cd，则此处也拦）。

**验收**：`shell_command({command: "cd sub"})` 返回拦截提示；`shell_command({command: "cd sub && git status", cwd: <root>})` 整链拦截；`shell_command({command: "git status", cwd: <sub>})` 正常执行。

**风险与边界条件**：

1. **误拦面控制**：拦截必须基于语义层段分类（`cd` 作**段首**），不能简单字符串包含——`git -C`、`npm --prefix`、`python -m` 等不依赖进程内目录状态的命令形态不得误拦；`cd` 出现在引号字符串内（`echo "cd x"`）同样不得误拦——语义层段解析已具备此类区分能力（DeleteShape 的同类处理先例，`conex-sandbox/src/semantics.rs`）；
2. **Windows 变体覆盖**：PowerShell 的 `Set-Location` / `sl` / `pushd` / `popd` 与 cmd 的 `cd /d`；壳层 `workbench_run_shell` 走 `powershell -EncodedCommand`（`process.rs:177-201`），`cd` 判断需覆盖 PowerShell 语法；
3. **工作区外 cwd 已由门禁升级审批**（`conex-sandbox/lib.rs:114-136`），本需求拦截的是「命令内 cd 改变目录」——两者正交，实现时不要合并，保持职责单一；
4. **删除形态重定向的交互顺序**：`cd x && rm -rf y` 同时命中 CdShape 与复合链 DeleteShape 时，删除形态判定优先（先删除后 cd，理由：删除拦截是安全红线，`shell.rs:202-213` 的执行序保持不动）。

---

## 五、REQ-A03 命令输出防溢出控制

### 5.1 现状证据

**截断算法——三层齐备，且尾部保留语义全部成立**：

| 层 | 位置 | 阈值 | 截断形态 |
| :--- | :--- | :--- | :--- |
| L1 工具内 | `shell.rs:710-724` `clamp_output_bytes` | `maxOutputBytes` 默认 200KB（`mod.rs:64`） | head 半 + `[output truncated: N bytes omitted]` + tail 半 |
| L2 执行器 | `output.rs:112-162` `budget_text_for_context` | `DEFAULT_INLINE_BYTES=24KB`，head 占比 0.4 | head + `[... N chars omitted ...]` + tail；`summarize`（`output.rs:186-231`）重组 ToolOutput 并写 `json.contextBudget` 标记 |
| L3 压缩前置 | `conex-compaction/src/tool_output.rs:178-288` `truncate_tool_output` | 2000 行 / 50KB 双阈值（`:25-27`） | head + 计数标记 + tail（`:244-259`）；`ToolOutputTruncationRecord` 留痕进 events（`:91-127`）；`tokens_saved` 联动压缩水位（`:305-321`） |

- 尾部保留（需求核心：「错误信息和摘要通常在末尾」）在全部三层均已实现，并有测试锚定（`tool_output.rs:368-405`、`output.rs:341-358`）；
- 超限告知 AI：L1 在结果 `text` 中带「output truncated」标记（`shell.rs:718-720`），L3 在注入上下文时带「输出已截断」标记（`tool_output.rs:264-273`）。

**缺失部分**：

- **PAGER=cat 未设置**：`shell.rs:650-651` 只设置 `PYTHONUTF8` / `PYTHONIOENCODING`；Windows 包装脚本（`shell.rs:559-578`）与 Unix 分支均无 PAGER 相关设置（全仓库 grep `PAGER` 仅命中文档，0 处代码）；
- **截断后完整日志无落盘路径**：L1 截断即丢弃超限字节（`shell.rs:710-724` 没有写盘分支），L3 截断发生在注入上下文前（`session-loop` 侧，`tool_exec.rs:782-786` 透传 `output_budget_bytes`），均无「完整日志保存在 <日志路径>」能力；
- **高输出命令自动附加限制参数**（如 `git log -n 50`）：无任何实现；
- 告知识别：需求要求的文案「输出已截断，完整日志保存在 <日志路径>，可通过文件读取工具查看完整内容」无法满足（没有日志路径可告知）。

### 5.2 判定

**部分实现**。截断算法本体（阈值、head+tail、UTF-8 安全、留痕、水位联动）已完备且领先于需求；防溢三件套中「截断 + 保尾」已实现，「PAGER=cat」「完整日志落盘 + 路径告知」「高输出命令建议参数」缺失。

### 5.3 差距清单

1. 交互式分页器风险：`git log` / `git diff` 在无 PAGER 环境变量时可能进入分页器，命令挂起直至超时被杀（与 A01 超时问题叠加）；
2. 截断 = 信息永久丢失，AI 无法续读完整输出（违反 REQ 1.2 设计原则 4 的精神——文档保留，此处是输出保留）；
3. 无日志路径可返回，AI 无法「用文件读取工具查看完整内容」。

### 5.4 应该怎么做

1. **PAGER=cat**：`run_command` 的 env 注入处（`shell.rs:650-651`）追加 `PAGER=cat`；Windows 包装脚本（`shell.rs:562-564` 附近）追加 `$env:PAGER='cat'`；壳层 `workbench_run_shell`（`process.rs:105-106`）同步追加。一行级改动，风险为零；
2. **截断落盘 + 路径回填**（核心改动，与 A05 联动）：
   - 给 `run_command` 增加「超限即落盘」语义：`clamp_output_bytes` 返回 `truncated=true` 时，把**原始完整字节**写入会话日志目录 `<app_dir>/logs/sessions/<session_id>/<时间戳>-<序号>.log`（路径经 `ToolContext` 可得的宿主路径解析，或由壳层注入 `log_root`）；
   - 结果 JSON 增加 `logPath` 字段，`text` 尾部追加「输出已截断，完整日志保存在 <logPath>，可通过 read_file 查看」；
   - 若已接线后台任务管理器（A01），任务日志天然全量保留（§七），同步命令只需复用同一目录约定，保证「同步截断 → logPath 指向任务日志」与「后台任务 → 同一 logPath」两条路径统一；
   - L3 层（`conex-compaction`）为纯函数不改动；其截断发生在上下文组装期，此时工具原始结果仍在 `tool-end` 事件流中（`events.rs:365-371`），**完整输出已随事件落库**——可作为「完整日志」的另一个来源（SQL 可查），但按行号读取不如文件方便，建议以文件落盘为主；
3. **高输出命令建议**（P1 可选增强）：在截断标记文案中检测已知高输出命令形态（`git log` 无 `-n`、`git diff` 无 `--stat` 等），追加「建议添加 -n <N> 限制参数」提示——放 L1 工具层一个纯函数（模式匹配命令串），不引入新的调度逻辑；
4. 验收自检：`shell_command({command: "git log", timeoutMs: 5000})` 不挂起（PAGER=cat 生效）；`shell_command({command: <产出 1MB 输出的命令>})` 返回 truncated=true 且 logPath 可读、文件内容完整。

**风险与边界条件**：

1. **三层截断阈值关系**：L1（200KB，`mod.rs:64`）> L3（50KB，`tool_output.rs:27`）> L2（24KB，`output.rs:17`）——截断逐层生效且互不感知，落盘时以 **L1 的原始输出为准**（最完整）；不要在 L2/L3 层重复落盘（文件系统垃圾）；
2. **落盘失败语义**：日志目录不可写（磁盘满/权限）时**不得让命令执行失败**——落盘为 best-effort，失败仅记录诊断（对齐 `perf/jsonl.rs:49-72` 的错误返回风格，由调用方降级为「仅截断 + 无 logPath」）；
3. **PAGER 的 Windows 语义**：`PAGER=cat` 对 git for Windows 有效（git 自带 `cat` 概念会经分页器协议），但 PowerShell 原生分页（`Out-Host -Paging`）不受影响——需求仅要求防交互式分页器挂起，PowerShell 的 `-Paging` 参数形态可在 CdShape 同款语义层加一条「分页参数引导」（P2 可选，不阻塞验收）；
4. **行数口径**：L3 的行数阈值（2000 行）按 `split('\n')` 计数（`tool_output.rs:160-165`），与「读取最后 N 行」（A05）的行口径必须一致，避免「截断保尾 20 行」与「日志读尾 20 行」数量对不上（建议两处共用同一个行拆分工具函数）。

---

## 六、REQ-A04 基于资源监控的进程健康判定

### 6.1 现状证据

**进程资源采集——全仓库缺失**：

- `apps/agent-workbench/src-tauri/src/perf/` 的五个模块（`perf/mod.rs:1-5`）是**文件系统/文本性能工具**，不是进程监控：`fs.rs`（分块读取 `read_chunk` `:48-99`、文件信息 `file_info` `:103-130`）、`jsonl.rs`（JSONL 行读写）、`hash.rs`、`encoding.rs`、`diff.rs`；
- grep 全 `crates/`：无 `sysinfo` / `psutil` / `getrusage` / `QueryInformationJobObject` 的 CPU / RSS 采集代码（仅命中 `in-memory` 数据库字样与 `revert_guard.rs` 的内存计数器，与进程资源无关）；
- 壳层 `process.rs` 的 Job Object 只使用 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 一个限位（`process.rs:406`），未启用 `QueryInformationJobObject` 统计读取；
- `shell.rs` 输出收集用 `wait_with_output()` 一次性收口（`:660`），**没有流式读取**——即使要记「最近输出时间」也无现成 hook（需要改为流式 `ChildStdout` 循环读取）；
- 退出码通知：`run_command` 返回 `exitCode`（`:668`），非零退出码附带 `(exit N)` 尾部标注（`format_command_result`，`:734-770`）——**异常退出时的「最后 N 行日志」**恰好可由现有 `tail` 保留语义天然满足（截断保尾），但无「立即通知 AI」的事件通道。

**健康判定逻辑——不存在**：无任何周期性采样、无「疑似卡死」判定、无通知。

### 6.2 判定

**未实现**（0%）。且现状超时即杀（`shell.rs:687-705`）与需求「不得强制硬超时杀进程」的 4.3 节禁止行为直接冲突——这是 A01 修复后自然消解的依赖项。

### 6.3 差距清单

1. 无 CPU / RSS / I/O / 最近输出时间的采集原语（Windows 侧可零依赖用 Job Object + 进程句柄，Unix 侧需 /proc 或 libc）；
2. `wait_with_output` 的收口式读取无法支撑「最近输出时间」与「日志持续累积」——**必须先改流式读取**（A01/A05 的共同前置）；
3. 无结构化资源快照数据结构与落库/落盘通道；
4. 无「疑似卡死 / 异常退出」通知通道（会话内通知可复用 nudge 通道，`steering/nudge.rs:172-238`，见下）。

### 6.4 应该怎么做

**（1）数据结构（放壳层 background.rs 或 agent-tools 契约层）**：

```rust
/// 单次采样快照（REQ-A04 4.1 四指标）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSample {
    pub sampled_at_ms: u64,
    /// 进程树 CPU 使用率（周期差值 / 墙钟差值）
    pub cpu_percent: f64,
    /// RSS / 工作集内存（字节）
    pub rss_bytes: u64,
    /// 最近一次 stdout/stderr 输出时间（epoch ms；无输出则 = 启动时间）
    pub last_output_at_ms: u64,
    /// 磁盘 I/O 读字节（可选）
    pub io_read_bytes: u64,
    /// 磁盘 I/O 写字节（可选）
    pub io_write_bytes: u64,
}

/// 健康判定（REQ-A04 4.2 三态）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessHealth {
    Healthy,      // CPU/IO 活跃，或最近 N 秒内有输出
    Suspicious,   // 疑似卡死：CPU 近零 + 无 I/O + 超过 M 秒无输出
    Crashed,      // 异常退出（exitCode != 0）
}
```

**（2）采集实现（零新依赖，贴合现有进程原语）**：

- **Windows**：任务在 Job Object 内运行（A01 建议恢复 daemon Job 系列，`process.rs:356`），用 `QueryInformationJobObject`（`JobObjectBasicAccountingInformation`：`TotalUserTime/TotalKernelTime` 周期差值算 CPU%；`JobObjectExtendedLimitInformation`：`PeakJobProcessUsedMemory` 近似 RSS）——与现有 `windows_sys` FFI 风格一致（`process.rs:391-443` 已有同族 unsafe FFI 先例）；I/O 可经 `GetProcessIoCounters`（进程树需遍历，P2 可选）；
- **Unix**：`/proc/<pid>/stat`（utime+stime 差值 / 墙钟差）+ `/proc/<pid>/io`（可选）；进程树累加需遍历 `/proc/<pid>/task/*/children` 或退化为「仅主进程 + RUSAGE_CHILDREN」近似（文档标注近似口径）；
- 采样周期建议 2s（可配），由 `TaskHandle` 内嵌的采样 loop（`tokio::time::interval`，参照 `spawn_snapshot_loop` 的写法，`core_run_commands.rs:1084-1108`）驱动，采样结果以 JSONL 追加写入任务日志（**复用 `perf/jsonl.rs:49-72` 的 `append_jsonl_lines`**）或独立 `.samples.jsonl`；
- 最近输出时间：stdout/stderr 流式转发器（A01/A05 改造后的读取循环）每次读到字节即刷新 `last_output_at_ms`——天然事件驱动，无需轮询。

**（3）健康判定与通知**：

- 采样循环内做三态判定：`Healthy` → 静默；`Suspicious` → 经 `PendingNudgeChannel`（`nudge.rs:172-238`，D8 语义：nudge 排入下一条用户消息边界，不打断当前 run）投递「任务 <id> 疑似卡死（<M> 秒无输出），请确认是否终止」；`Crashed` → 同通道投递「任务 <id> 异常退出（exit code N），附最后 20 行日志」——尾部日志直接复用截断保尾语义取 `status.tail`；
- 严格不做的事：不自动杀、不自动降级超时（对齐 REQ 4.3 禁止清单）。

**（4）AI 读取路径**：`status` 返回最新 `ResourceSample`（REQ-B02 的「资源快照摘要」字段由此获得），AI 被唤醒时无需重跑命令。

**风险与边界条件**：

1. **CPU 百分比的采样口径**：单次瞬时采样无意义，必须「周期差值 / 墙钟差值」（Job 的 `TotalUserTime+TotalKernelTime` 差值，`process.rs:391-443` 同族 FFI）；首采样无基线（丢弃或标记 `null`）；进程树统计在 Windows 上经 Job 自动聚合（子进程继承 Job），Unix 上需自遍历进程树或标注近似口径（§12.2 G5 诚实边界）；
2. **采样开销**：2s 周期的 `QueryInformationJobObject` / `/proc` 读为微秒级，可忽略；但**不要**对每个任务开独立 OS 定时器之外的线程——采样 loop 与转发器共用一个 tokio task（`interval.tick()` 模式，参照 `core_run_commands.rs:1094-1107`）；
3. **「静默卡死」的误报面**：`M` 秒无输出阈值需可配（默认建议 60s），且**仅对启用 `resourceMonitor` 的任务**判定——编译类命令（cargo build 长时间无输出属正常）会被误报，这类场景 AI 看到通知后自行裁决，系统不自动杀（对齐 REQ 4.3 禁止清单）；
4. **健康判定与超时转后台的竞态**：任务转后台后（A01 模式 2），`timeoutMs` 绝对上限不再适用（否则与「转后台」矛盾）——转后台任务默认无限运行，仅靠健康判定 + AI 决策终止；这是对旧 TS 语义（`BackgroundCommandManager` 仍带 `timeoutMs` 且 `timed-out` 是合法终态）的有意偏离，需在工具 description 中显式说明；
5. **I/O 采集可选性**：Windows `GetProcessIoCounters` 与 Job 内多进程聚合较繁琐，建议 I/O 列为 P2 可选字段（数据结构预留 `io_read_bytes/io_write_bytes`，首版可恒为 0），CPU/RSS/最近输出时间三项先交付验收。

---

## 七、REQ-A05 命令日志持久化与按需读取

### 7.1 现状证据

- **无后台任务 → 无任务日志文件**（R1 后 Rust 侧无任何日志文件管理）；
- 同步命令：stdout/stderr 只在内存中收口（`shell.rs:660-661` `wait_with_output`），超限即丢弃（`shell.rs:710-724`），**没有任何日志文件**；
- 可复用的现成零件：
  - 追加写文件：`perf/jsonl.rs:49-72` `append_jsonl_lines`（create+append+可选 flush）——生产路径已被 `core_jsonl_append` 复用（`jsonl.rs:4` 变更记录）；
  - 按偏移读文件：`perf/fs.rs:48-99` `read_chunk(path, offset, size)`（≥64KB 走 mmap）+ `file_info`（`fs.rs:103-130`）可拿文件 size——**「读最后 100 行」的基础设施已经存在**（先 size 再回退 offset），只是当前无消费方（`fs.rs:4-9` 变更记录明言「等待 core_* 迁移时复用」）；
  - 会话级目录：`host_paths::app_dir()`（`process.rs:168-174` 已用）可作日志根；
- 行号范围读取的缺失件：**行数索引**——`read_chunk` 只能按字节偏移读，读「第 N 行到第 M 行」需要先知道行边界；转发器边写边数行数即可补齐（见下）。

### 7.2 判定

**未实现**（0%）。所有前置（追加写、偏移读、会话目录）零件存在但无组装者；「任务创建时返回日志路径」「任务终止后日志保留」「行号范围读取」均不存在。

### 7.3 差距清单

1. 无日志文件生命周期（创建 / append / 保留）；
2. 无行数索引，无法按行号范围读取；
3. 同步命令截断后的完整输出也丢（与 A03 共享此 gap，A03 的落盘方案即本需求的前置子集）；
4. 无任务摘要信息生成（「任务 <ID> 已运行 <耗时>，日志已累积 <行数> 行，最近输出时间 <timestamp>」）。

### 7.4 应该怎么做

**目录与文件约定**：

```
<app_dir>/logs/tasks/<task_id>.log        # 后台任务完整输出（append 模式，UTF-8）
<app_dir>/logs/tasks/<task_id>.meta.json  # 任务元数据（status/startedAt/lineCount/lastOutputAt/exitCode/prompt）
<app_dir>/logs/sessions/<session_id>/<ts>-<seq>.log  # 同步命令截断落盘（A03）
```

**实现要点**：

1. **转发器**（`TaskHandle.writer`，A01 的 adopt 产物）：两个 `tokio::io::BufReader`（stdout/stderr）循环 `read_line` → `append_jsonl_lines`（或直接 `OpenOptions append`，`jsonl.rs:57-61` 的模式）+ 行计数 + 刷新 `last_output_at_ms` → 进程退出后写终态到 `.meta.json`；
2. **行号范围读取**：`read_log(task_id, start_line, max_lines)` 实现：
   - 尾部读取（`start_line` 缺省）：`file_info` 拿 size → `read_chunk` 从文件尾回退预算（如 64KB）→ 本地拆行取最后 N 行——**无需全文件扫描**；
   - 精确行号：用 `.meta.json` 的行数索引（转发器每写 512 行记录一次 offset checkpoint）二分定位起始 offset，再 `read_chunk` 顺序读——避免 O(文件行数) 扫描；
3. **日志保留**：任务终止（killed / completed / failed）不删除文件；registry 的 30 分钟归档只清理内存条目与 `.meta.json`，`.log` 保留（对齐 REQ「任务完成后日志文件保留」）；
4. **摘要生成**：`status()` 由 meta 组装「任务 <id> 已运行 <duration>，日志已累积 <line_count> 行，最近输出时间 <timestamp>」，作为 AI 唤醒时注入摘要的模板（该注入时机属模块 C REQ-C04 的范围，本模块只负责数据可得）；
5. **验收自检**：任务创建即返回 `logPath`；`read_log(task_id, None, 100)` 返回最后 100 行；任务被杀后 `logPath` 仍可读。

**风险与边界条件**：

1. **stdout/stderr 交错顺序**：两条管道独立读取，日志文件中的两流顺序不代表真实交错顺序——如需保序必须合并单管道（`2>&1` 包装，但会改变命令行为）或接受「按到达序」的近似；建议默认「stdout 与 stderr 分文件或带前缀标记」，并在 status 中说明口径（诚实边界）；
2. **行数索引一致性**：`.meta.json` 的 checkpoint 由转发器维护，进程崩溃（应用被杀）时索引滞后——`read_log` 读到索引末尾后需回退到文件实际末尾继续（索引只做「快速定位」不做「精确断言」）；
3. **日志轮转**：单任务日志无限增长（守护进程跑数天）——需上限（如 100MB）后**截断头部**（保留尾部，与 A03 保尾语义一致）或按大小分片（`.log.1/.log.2`）；REQ 未要求，但属长期运行守护进程的必做护栏（P2，首版可只做大小上限 + 告警）；
4. **编码**：转发器按 `decode_console_bytes`（`shell.rs:727-732`）先 UTF-8 后 lossy 的口径写入，保证日志文件本身始终是合法 UTF-8（对齐项目编码基线：UTF-8 无 BOM）。

---

## 八、REQ-B01 后台任务列表查询

### 8.1 现状证据

- **Rust 侧：无任何后台任务注册表**。壳层仅有的注册表是 `CoreRunState.active_runs`（run_id → ActiveRun，`core_run_commands.rs:699`），语义为「引擎 run 生命周期」，不是命令任务；其中 `ActiveRun` 条目结构（`core_run_commands.rs:271-290`：session_id / handle / queue / control_bus / approval / bridge）可作为任务条目的设计参照；
- 命令注册面（`main.rs:76-164`）无任何 background / task 命令；旧命令 `workbench_list_background_tasks` 随 sidecar 删除（`git show 6e2e180e`，见 §2.1）；
- **前端：API 与 UI 层仍在**（`backgroundTasksApi.ts:511-514` 的 `listBackgroundTasks()`、`useBackgroundTaskPolling.ts:19-48` 的 3s 轮询、`useEngineState.ts:99` / `updateStore.ts:35` / `useOverviewState.ts:213` 的消费），但命令缺失 → `invokeCmd` 返回 null（`tauriInvoke.ts:185-192`）→ 静默空列表；
- 前端状态契约（`backgroundTasksApi.ts:10-58`）反而是现成的需求规格：状态 `queued/running/succeeded/failed/cancelled/timed-out`、活跃/终态划分、中文标签——与 REQ-B01 的 `running/completed/failed/killed` 高度兼容（归一函数 `normalizeBackgroundTaskState` `:126-180` 可容忍字段别名）；
- 时间/过滤/排序/去重纯函数（`backgroundTasksApi.ts:206-395`）可直接复用（纯函数无 invoke 依赖，测试面 149-237 行已锚定）。

### 8.2 判定

**未实现**（Rust 侧 0%；前端保留 30% 可复用资产）。

### 8.3 差距清单

1. 无任务注册表、无 task_id 生成、无状态机；
2. 无 list 命令（AI 侧工具 + 前端侧 Tauri 命令都没有）；
3. 无 30 分钟保留/归档策略；
4. 前端轮询与「反应式唤醒」理念冲突（REQ-C04 严禁轮询）——但前端轮询是 UI 展示层行为，与 AI 侧的事件驱动不矛盾，可保留或改为事件订阅（模块 C 范畴，此处仅记录）。

### 8.4 应该怎么做

**（1）壳层注册表（`background.rs`，承接 A01 的 trait 实现）**：

```rust
pub struct BackgroundTaskRegistry {
    inner: Mutex<HashMap<String, Arc<TaskHandle>>>,
    log_root: PathBuf,
    task_seq: AtomicU64,          // task-<seq> id 生成（对齐 pty id 风格，pty/mod.rs:104-111）
    retention: Duration,          // 终态保留时长，默认 30 分钟
}

pub struct TaskHandle {
    pub info: Arc<RwLock<BackgroundTaskInfo>>,   // 状态机字段
    pub child: tokio::process::Child,            // None = 已退出
    pub writer: JoinHandle<()>,                  // 输出转发（A05）
    pub sampler: Option<JoinHandle<()>>,         // 资源采样（A04，可选）
}
```

- 状态机字段（`BackgroundTaskInfo`，对齐 REQ-B01 字段 + 前端契约）：`task_id / command 摘要（前 64 字符）/ started_at / duration / status(running|completed|failed|killed) / log_path / exit_code: Option<i32> / line_count / last_output_at_ms / resource: Option<ResourceSample>`；
- 终态保留：list 时过滤 `finished_at + retention` 之前的条目并清理内存（.log 保留，§7.4 第 3 点）；清理任务可挂到现有周期任务模式（参照 `spawn_snapshot_loop`，`core_run_commands.rs:1084-1108`）；
- `app.manage(Arc::new(BackgroundTaskRegistry::new(app_dir)))` 独立托管（不并入 CoreRunState，职责单一；CoreRunState 需要时经 `state()` 取）。

**（2）命令面（两条路径都要）**：

- AI 侧：新增 `background_task` 工具（action = `list`），注册进 `register_builtin_tools_with_config`（`mod.rs:79-108`），经 `ToolContext.background` 访问 registry——工具语义与 `run_subagent`（`mod.rs:107-108`）一致；
- 前端侧：恢复 `workbench_list_background_tasks` Tauri 命令（注册进 `main.rs:76-164` 的 `command_registry!`），实现为薄包装 `registry.list(include_finished=true)`，返回形状对齐前端 `extractBackgroundTaskArray` 的 `{ tasks: [...] }`（`backgroundTasksApi.ts:285-304`）——前端解析层原样复用。

**（3）与 run 生命周期整合**：

- 任务属**会话级**而非 run 级：run 终态（`drive_run_loop` 收口，`core_run_commands.rs:1133-1183`）不清理 registry；会话切换/应用退出按 §3.4(3) 的 Job 策略处理（退出全杀）；
- 主 agent 工具调用链上，任务工具与 `run_subagent` / `wait_subagents`（`mod.rs:107-110`）并列——主控 Agent 可「派发任务 → 并行做其他事 → 轮询/被唤醒检查」。

**（4）验收**：`background_task({action:"list"})` 返回全部活跃 + 30 分钟内终态任务，字段含 taskId/command/startedAt/duration/status/logPath。

**风险与边界条件**：

1. **多 run 并发可见性**：registry 是会话级共享，主 agent 与其派发的子 agent run（I4-M2 `run_subagent`，`mod.rs:107-108`）可能看到同一批任务——list 结果建议带 `owner_run_id` 字段（继承旧 `runIndex` 语义，§2.4.1），AI 可按来源过滤，避免主/子 agent 互相误解任务归属；
2. **终态归档的竞态**：list 的清理动作（30 分钟归档）与正在执行的 status/read_log 并发——清理只移除注册表条目，`.log` 文件保留（§7.4 第 3 点），status 对已归档 taskId 返回 NotFound 并附「已归档，日志文件仍在 <path>」的可恢复指引；
3. **前端轮询与容量**：`useBackgroundTaskPolling.ts:33` 的 3s 轮询在大量终态任务时产生无谓 IPC——前端侧建议只在「有活跃任务」时轮询（`filterActiveBackgroundTasks` 已存在，`useBackgroundTaskPolling.ts:44-48`），终态后停止；此为 UI 优化，不阻塞验收；
4. **id 生成唯一性**：`task-<seq>` 与 pty id（`pty/mod.rs:104-111`）命名风格一致但**命名空间独立**，两端不得共用计数器（防前缀冲突）。

---

## 九、REQ-B02 任务状态与日志检查

### 9.1 现状证据

- 无任务 → 无状态查询（同 §8.1）；
- 可复用零件：
  - 尾部日志读取链路：`perf/fs.rs` 的 `file_info` + `read_chunk`（`:48-130`）具备「从文件尾回退读取」的全部原语；
  - 截断保尾语义：`clamp_output_bytes` / `truncate_tool_output` 已证明「保留最后 N 行」的算法可用（`shell.rs:710-724` / `tool_output.rs:244-259`）；
  - 前端 `getBackgroundTaskOutput`（`backgroundTasksApi.ts:516-523`）契约：返回输出文本或 `outputPreview`——UI 只需「尾部文本」，不需要行号；
  - 前端 `useOverviewState.ts:213` 消费 getBackgroundTaskOutput 展开详情。

### 9.2 判定

**未实现**（0%），前端契约保留。

### 9.3 差距清单

1. 无 `status(task_id)` 语义（状态 / 退出码 / 日志位置 / 运行时长 / 资源快照）；
2. 无「仍在运行 → 附带最近 20 行 stdout 尾部」的组装；
3. 无「任务不存在」的错误协议（可复用 `CoreError::NotFound`，`core_run_commands.rs:186-190` 已有先例）；
4. 无资源快照摘要字段（依赖 A04）。

### 9.4 应该怎么做

1. `BackgroundTaskManager::status(task_id)` 实现（§3.4 trait）：
   - registry 查条目 → 组装 `BackgroundTaskStatus { task_id, status, exit_code, log_path, duration_ms, line_count, last_output_at_ms, resource: Option<ResourceSample>, tail: String }`；
   - `tail`：`read_log(task_id, None, 20)`（§7.4 尾部读取实现）——**运行中任务同样可读**（转发器持续 append，读文件尾不阻塞写入，天然满足「检查进展」）；
   - 未找到 → `ToolError::NotFound` 风格错误（对齐审批门 `resolve` 的 NotFound 处理，`core_run_commands.rs:180-190`）；
2. 命令面：AI 侧 `background_task({action:"status", taskId})` + 前端 `workbench_get_background_task_output`（返回 `{ status, tail, ... }`，前端 `parseBackgroundTaskOutput` 取 `output`/`outputPreview` 字段直接兼容，`backgroundTasksApi.ts:403-419`）；
3. 异常退出任务：status 中 exit_code != 0 时 `tail` 自动携带最后 20 行（配合 A04 的 crashed 通知，AI 醒来即拿到上下文，无需二次调用）；
4. 验收：运行中任务 status.tail 非空且随输出增长；终态任务 status 带 exitCode；未知 taskId 返回 NotFound。

**风险与边界条件**：

1. **tail 读取的锁竞争**：`status` 读 `.log` 文件尾与转发器 append 并发——文件读（`read_chunk`，`perf/fs.rs:48-99`）与写（append 模式）互不阻塞（OS 级），但读到半行属正常（append 未完），`read_log` 需容忍行尾残缺（按「截断到完整行」处理，对齐 `take_suffix_bytes` 的字符边界语义，`tool_output.rs:144-157`）；
2. **状态与退出码的时序**：进程退出瞬间 `child.wait()` 与转发器 flush 之间，`line_count` 可能滞后——status 组装时若 `status=completed/failed/killed`，需先 await 转发器 JoinHandle 收尾（或记录「flush 中」位），保证终态快照的 `tail` 与 `line_count` 自洽；
3. **资源快照字段为空**：未启用 `resourceMonitor` 的任务 `resource: None`（REQ 语义如此）——前端渲染需容忍缺失（前端 `BackgroundTaskInfo` 的 `summary?` 可选字段已体现该容忍度，`backgroundTasksApi.ts:66-74`）。

---

## 十、REQ-B03 交互式标准输入注入

### 10.1 现状证据

- **shell 工具：stdin 被显式关闭**——`shell.rs:637` `.stdin(Stdio::null())`；`workbench_run_shell` 同样 `Stdio::null()`（`process.rs:92`）；
- **PTY 能力存在但不可达**：`portable-pty = "0.9"`（`apps/agent-workbench/src-tauri/Cargo.toml:59`）；`workbench_pty_write(pty_id, data)`（`pty/mod.rs:66-74`）具备向会话写入数据的能力，且 `pty/session.rs` 在 Windows 走 ConPTY；但 PTY 是**终端面板专用**（`pty/mod.rs:1-18`），由用户交互创建（`workbench_pty_create`），**AI 工具链无法触达**（无 pty_id → AI 调用面）；
- 提示检测：无任何「stdout 中检测 `[Y/n]` / `Press Enter`」逻辑（grep 无命中）；
- 通知通道：nudge 通道（`nudge.rs:172-238`）存在但仅 steering 子系统使用，无任务事件接入（见 §10.4 建议 3 的说明）。

### 10.2 判定

**未实现**（0%）。PTY/写入原语已具备但属于另一产品面（终端面板）；AI 侧 stdin 注入需要**新建**非 PTY 管道方案（管道 stdin 对多数交互 CLI 已足够，`[Y/n]` 提示走 stdin/stdout 字符流即可，不需要 TTY 终端模拟——只有需要光标控制/彩色输出的全屏 TUI 才必须 PTY，这类命令建议引导用户用终端面板）。

### 10.3 差距清单

1. 后台任务 spawn 时 stdin 必须改为 `Stdio::piped()`（`shell.rs:637` / `process.rs:92` 现状 null）；
2. 无 `send_input(task_id, text)` 写入通道（需要持有 stdin 句柄：`ChildStdin` 所有权在 TaskHandle）；
3. 无交互提示模式检测（`[Y/n]` / `[y/N]` / `Press Enter to continue` / `(yes/no)`）；
4. 无「检测到提示 → 通知 AI」的注入通道；
5. 自动追加换行语义（REQ：input_text 末尾自动加 `\n` 除非显式不追加）无实现。

### 10.4 应该怎么做

1. **stdin 管道化**：`run_command_maybe_background`（§3.4）在模式 2/3 下 `.stdin(Stdio::piped())`，`ChildStdin` 随 adopt 转移给 `TaskHandle`（`tokio::process::Child::stdin.take()` 后存入 handle，`Arc<tokio::sync::Mutex<Option<ChildStdin>>>`——stdin 可能被子进程提前关闭，写入时遇 `BrokenPipe` 返回「进程已退出/已关闭输入」的明确错误）；
2. **send_input 语义**：默认末尾追加 `\n`；参数 `appendNewline: false` 可显式关闭（对齐 REQ）；写入失败分类：`task_not_found` / `stdin_closed`（进程已退出或命令不读输入）/ 成功；
3. **提示检测**：转发器（§7.4 第 1 点）对每行输出做轻量正则匹配（常量数组：`[Y/n]`、`[y/N]`、`Press Enter to continue`、`(yes/no)`、`请输入`——可配），命中 → 更新 `TaskHandle.info.prompt = Some(命中行)` + 触发通知：
   - 通知通道建议：**复用 `PendingNudgeChannel`**（`nudge.rs:172-238`）——`enqueue` 语义为「排入下一条用户消息，不打断当前 run」（D8，`nudge.rs:10-22`），完美契合「任务在后台，AI 在其他轮次被通知」；但注意 nudge 是「用户消息边界」注入，若需求要求**立即唤醒**（AI 无事可做时），则属模块 C REQ-C04 的范围（需要新的唤醒事件通道），本模块只保证「检测 + 排队」两件事就位，唤醒时机由模块 C 消费；
   - 同时写入任务 meta（`prompt` 字段），AI 调 status 也能看到；
4. **AI 工具面**：`background_task({action:"send_input", taskId, text, appendNewline})`；PTY 路线**不引入**（避免把终端面板的 ConPTY 生命周期耦合进任务系统——架构纯洁性优先，REQ 1.3）；
5. **验收**：spawn `npm install`（或等价交互命令）→ status.prompt 出现提示 → send_input("y") → 命令继续执行不阻塞、最终 completed。

**风险与边界条件**：

1. **非 PTY 管道的能力边界**：管道 stdin 对「逐字符响应」的 TUI 无效（`fzf`、`vi` 等需要 TTY）；`send_input` 的 description 必须写明「适用于 [Y/n] 确认与逐行输入，全屏 TUI 请用终端面板」（PTY 面与任务面保持隔离，§10.2）；
2. **提示检测的误报**：`[Y/n]` 正则可能命中**非提示行**（如文档里打印 `(yes/no)` 说明）——检测结果只作为「候选提示」写入 `prompt` 字段并通知 AI，由 AI 判断是否发送输入（对齐「减少人工干预」原则但不剥夺 AI 判断）；误报率控制：仅匹配**行尾**而非行中；
3. **stdin 双写竞态**：同一任务的多个并发 `send_input`（AI 多轮重发）——用 `Arc<tokio::sync::Mutex<Option<ChildStdin>>>` 串行化写入，写入失败（BrokenPipe）后清空 Option，后续调用返回 `stdin_closed`；
4. **孤儿 stdin 句柄**：子进程从不读 stdin 时管道缓冲可能堆积——`send_input` 使用 tokio 写入（非阻塞）即可，堆满时写入端背压，不影响子进程执行；任务终止时 stdin 句柄随 child drop 关闭（`kill_on_drop(false)` 只影响杀进程语义，句柄所有权在 TaskHandle，drop 时自然关闭）。

---

## 十一、REQ-B04 任务终止

### 11.1 现状证据

- 现有终止原语**只有强制树杀**：
  - `terminate_process_tree`（`process.rs:322-348`）：Windows `taskkill /PID <pid> /T /F`（`/F` = 无条件强制，无优雅阶段）；Unix `kill -TERM`（单一信号，无升级）；
  - `shell.rs:774-800` 有一份同构副本（`terminate_process_tree`，超时路径用）；
- 无「优雅 → 等待 → 强制」两阶段：Windows 侧没有任何发 `CTRL_BREAK` / `WM_CLOSE` 的路径；Unix 侧无 `SIGTERM → 5s → SIGKILL` 的升级逻辑；
- 无「任务」概念：终止操作只存在于同步超时路径（`shell.rs:689-691` / `process.rs:140-142`），没有按 task_id 终止的入口；
- 无终止结果三态（成功 / 已不存在 / 失败附原因）——现状 `terminate_process_tree` 只返回 `Result<(), String>`（`process.rs:323`）；
- 孤儿保护相反方向已具备：Job Object KILL_ON_JOB_CLOSE（`process.rs:391-421`）+ PTY 分配（`pty/session.rs:221`）保证宿主崩溃时进程树被杀——**这个原语可复用为后台任务的兜底回收**（§3.4 第 3 点）。

### 11.2 判定

**未实现**（0%）。强制树杀原语存在但无两阶段语义、无任务维度、无结果协议。

### 11.3 差距清单

1. 无两阶段终止（优雅 → 5s 等待 → 强制）；
2. 无 kill 结果三态返回；
3. `taskkill /F` 对需要清理现场（保存文件、释放锁）的程序不友好；
4. 无「终止后日志保留」的保证（A05 的 .log 不删已覆盖，但需要显式测试锚定）；
5. Unix 侧 `kill -TERM` 单发无升级。

### 11.4 应该怎么做

1. **两阶段终止实现**（`background.rs` 的 `kill`，改造 `process.rs:322-348` 增加优雅变体）：
   - 阶段一（优雅）：Windows `taskkill /PID <pid> /T`（**去掉 /F**，向进程树发送关闭请求）；Unix `kill -TERM <pid>`（沿用现有调用）；
   - 等待窗口：`timeout(5s, child.wait())`（tokio 已有 `kill_on_drop(false)` 的 child 在 handle 里，直接 `child.wait()`）；
   - 阶段二（强制）：窗口超时 → `terminate_process_tree`（现有 /F 原语，`process.rs:322-334`）；
   - 进程已退出（`child.try_wait()` 或 wait 立即返回）→ 直接返回「进程已不存在」；
2. **结果协议**：

```rust
pub enum KillResult {
    Killed { task_id: String },        // 成功终止（含两阶段升级后的成功）
    AlreadyExited { task_id: String, exit_code: Option<i32> },  // 进程已不存在
    Failed { task_id: String, reason: String },   // 终止失败附原因
}
```

3. **状态机联动**：kill 后 `TaskHandle.info.status = Killed`，meta 落盘（.log 保留，A05 已定义）；registry 终态保留 30 分钟（B01）后内存清理；
4. **与 run 生命周期的关系**：`core_cancel_run`（`core_run_commands.rs:120`）只取消引擎 run，**不级联杀后台任务**（除非任务声明了 `isDaemon=false` 且需求演进要求联动——默认不联动，保持职责单一，避免误杀）；应用退出经 Job Object 兜底全杀（§3.4 第 3 点）；
5. **验收**：spawn 一个 `Start-Sleep` 类命令 → kill → 5s 内优雅退出返回 `Killed`；对忽略优雅信号的命令 → 两阶段升级后仍返回 `Killed`（附「强制终止」标注）；已退出任务 → `AlreadyExited`；kill 后 `read_log` 仍可用。

**风险与边界条件**：

1. **Windows 优雅终止的可用性**：`taskkill /T`（无 /F）发送 `WM_CLOSE`，仅对带窗口/消息循环的进程有效，纯控制台进程可能直接忽略——优雅阶段超时后升级 `/T /F` 是正确兜底，但**不要期待优雅阶段在 Windows 上普遍成功**（文档标注，测试以「两阶段路径可执行」而非「优雅一定成功」为准）；
2. **kill 与进程自然退出的竞态**：`child.wait()` 5s 窗口内进程自行退出——按 `AlreadyExited`（携带自然退出码）处理，不强行升级；`try_wait()` 先查一次可省 5s；
3. **树杀与 Job 的叠加**：两阶段终止用 `taskkill /T` 树杀即可，**不要**同时关闭 daemon Job 句柄（Job 是应用级兜底，`process.rs:391-421`，关闭会影响其他任务）——两条路径职责分离：Job 管「宿主崩溃」，kill 管「任务终止」；
4. **批量终止需求**：REQ-B04 只要求单任务；旧系统有 `cancelAllForRun`（§2.4.1）——首版不实现，但 `KillResult` 与 registry 结构预留 `owner_run_id` 过滤字段，后续加批量命令不破坏形状；
5. **已归档任务的 kill**：任务 30 分钟归档（B01）后 kill 返回 NotFound（日志保留，可人工清理）。

---

## 十二、模块总结：判定表、真 gap 清单与优先级建议

### 12.1 整体判定表

| 需求 | 优先级 | 判定 | 已具备的可复用资产 | 需新建 |
| :--- | :---: | :---: | :--- | :--- |
| REQ-A01-1 同步等待 | P0 | ✅ 已实现 | `run_command`（`shell.rs:624-707`）、abort 竞速（`tool_exec.rs:816-828`）、树杀（`shell.rs:774-800`） | 无 |
| REQ-A01-2 超时转后台 | P0 | ❌ 未实现 | `kill_on_drop` 开关位、`ToolContext` 注入模式（`context.rs:100-118`）、subagent spawner 契约先例（`mod.rs:53-57`） | 后台任务管理器（trait + 壳层实现）、等待窗口执行路径 |
| REQ-A01-3 守护进程 | P0 | ❌ 未实现 | Job Object 原语（`process.rs:391-421`）、预留注释（`process.rs:356`） | 会话级存活语义、日志累积（A05） |
| REQ-A02 禁 cd | P0 | ❌ 未实现（cwd 半完成） | `resolve_workspace_path`（`shell.rs:135-144`）、门禁上下文检查（`conex-sandbox/lib.rs:114-136`）、DeleteShape 拦截范式（`shell.rs:198-213`） | 语义层 `CdShape` + 工具层拦截 |
| REQ-A03 输出防溢 | P1 | 🟡 部分（算法全，落盘无） | 三层截断（`shell.rs:710-724` / `output.rs:112-162` / `tool_output.rs:178-288`）、留痕（`tool_output.rs:91-127`） | PAGER=cat、截断落盘 + logPath 回填、高输出命令建议 |
| REQ-A04 资源监控 | P1 | ❌ 未实现 | Job Object 句柄（`process.rs:368-382`）、周期任务范式（`core_run_commands.rs:1084-1108`）、nudge 通道（`nudge.rs:172-238`） | 采集原语、`ResourceSample`、健康判定三态 |
| REQ-A05 日志持久化 | P1 | ❌ 未实现 | `append_jsonl_lines`（`perf/jsonl.rs:49-72`）、`read_chunk`/`file_info`（`perf/fs.rs:48-130`）、`app_dir`（`process.rs:168-174`） | 日志生命周期、行数索引、摘要生成 |
| REQ-B01 任务列表 | P0 | ❌ 未实现 | 前端 API/UI 契约（`backgroundTasksApi.ts:10-58` 等）、ActiveRun 条目范式（`core_run_commands.rs:271-290`） | 注册表、list 命令（AI 工具 + Tauri 命令） |
| REQ-B02 状态与日志 | P0 | ❌ 未实现 | 尾部读取原语（`perf/fs.rs`）、前端解析函数（`backgroundTasksApi.ts:403-419`） | status 组装、tail 附带 |
| REQ-B03 stdin 注入 | P1 | ❌ 未实现 | `Stdio::piped` 开关、PTY 写入先例（`pty/mod.rs:66-74`）、nudge 通道 | stdin 托管、send_input、提示检测 |
| REQ-B04 任务终止 | P0 | ❌ 未实现 | 树杀原语（`process.rs:322-348`）、Job 兜底（`process.rs:391-421`） | 两阶段终止、KillResult 三态 |

### 12.2 真 gap 清单（按依赖序）

1. **G1（底座）后台任务管理器缺失**——注册表 / task_id / 状态机 / TaskHandle（stdin+stdout+stderr 三管道托管）/ 会话级存活。阻塞 A01-2/3、A04、A05、B01~B04 全部条目；
2. **G2（底座）同步执行路径流式化缺失**——`wait_with_output` 收口式读取（`shell.rs:660`）无法支撑「转后台接管管道」「最近输出时间」「日志持续累积」，必须先改为流式读取（Child 拆分 stdout/stderr 读取循环）；
3. **G3（A02）cd 拦截缺失**——语义层无 CdShape，工具层无引导拦截；
4. **G4（A03）输出落盘缺失**——截断算法完备但完整日志无路径；PAGER=cat 一行改动未做；
5. **G5（A04）资源采集缺失**——全仓库无 CPU/RSS/IO 采集；健康判定与通知依赖 G1；
6. **G6（A05）日志生命周期缺失**——目录约定、行数索引、摘要生成，依赖 G1/G2；
7. **G7（B03）stdin 注入缺失**——依赖 G1（TaskHandle 持有 ChildStdin）；
8. **G8（B04）两阶段终止缺失**——依赖 G1（按 task_id 操作）与 process.rs 优雅变体改造。

### 12.3 优先级建议与实施顺序

**第一阶段（P0 基础，G1/G2/G3）——「把后台任务底座立起来」**：

1. `process.rs` 补充优雅终止变体（`terminate_process_tree_graceful`，无 /F）+ 恢复 daemon Job 系列（`process.rs:356` 预留位）；
2. 新文件 `apps/agent-workbench/src-tauri/src/background.rs`：`BackgroundTaskRegistry` / `TaskHandle` / `BackgroundTaskManager` trait 实现；
3. `agent-tools` 新增 `background.rs` 契约（trait + 数据结构）+ `BuiltinToolConfig.background_manager` 字段 + `ToolContext.background` 注入（对照 `write_claims` 接线）；
4. `shell.rs` 改造：流式读取 + `run_command_maybe_background`（等待窗口语义）+ 模式参数（mode / waitMsBeforeAsync / isDaemon / resourceMonitor）——**这一条同时交付 A01 全部三模式**；
5. `conex-sandbox` 语义层 `CdShape` + `shell.rs` 拦截引导——A02 交付；
6. `main.rs` 恢复 `workbench_list_background_tasks` / `workbench_get_background_task_output` / `workbench_cancel_background_task` 三条命令（薄包装 registry）——B01/B02 的查询面立即打通前端（前端解析层复用）。

**第二阶段（P1 核心体验，G4/G6/G8 + B03）**：

7. PAGER=cat（一行）+ 截断落盘 + logPath 回填——A03 交付；
8. 日志生命周期（转发器 + 行数 checkpoint + read_log 尾部/行号）+ 摘要——A05 交付；
9. 两阶段 kill + KillResult——B04 交付；
10. stdin 管道化 + send_input + 提示检测（nudge 排队）——B03 交付。

**第三阶段（P1 增强，G5）**：

11. 资源采集（Windows Job Object 统计 / Unix /proc）+ `ResourceSample` + 健康判定三态 + Suspicious/Crashed 通知——A04 交付；通知的「立即唤醒」语义随模块 C（REQ-C04 反应式唤醒）接线，本阶段只保证数据与事件面就位。

**依赖关系图**：

```
G1 后台任务管理器（A01-2/3 底座）
 ├─ G2 流式化（A01-1 改造） ── G6 日志生命周期（A05） ── G4 截断落盘（A03）
 ├─ G5 资源采集（A04）── 健康判定通知
 ├─ G7 stdin 注入（B03）── 提示检测
 └─ G8 两阶段终止（B04）
G3 cd 拦截（A02）独立，可随时并行
```

### 12.4 架构一致性自检（对照 REQ 1.2/1.3 设计原则）

- **不另起炉灶**：所有建议复用现有组件——trait 注入模式（subagent_spawner 先例）、注册表模式（active_runs 先例）、周期任务模式（snapshot_loop 先例）、文件原语（perf/fs.rs + jsonl.rs）、通知通道（nudge）、孤儿保护（Job Object）；
- **无兼容包袱**：后台任务命令恢复时直接以 `core_background_*` / `workbench_*` 新契约实现，不恢复 sidecar WS 协议（旧协议随 daemon 删除是正确决定，不应复活）；
- **防误杀原则**（REQ 1.2-3 / 4.3）：模式 2 替代「超时即杀」是核心修复；资源监控通知默认不自动杀；
- **诚实边界**：Unix 侧资源采集口径（RUSAGE 近似 vs 精确进程树）需在实现文档标注；PTY 路线明确不引入（保持终端面板与任务系统解耦）；
- **遗产继承**（§2.4）：状态机五态、快照字段形状、两阶段终止、输出节流事件均有旧系统已验证语义，新实现直接继承，避免重复发明。

### 12.5 测试策略与验收锚点

**Rust 侧（`cargo test --workspace`，对齐项目 73+ 套件基线风格）**：

| 测试面 | 落点 | 要点 |
| :--- | :--- | :--- |
| 语义层 CdShape | `conex-sandbox`（同族测试先例：`lib.rs:229-393` 的 S2/S6 段） | `cd x` / `Set-Location` / `pushd` 命中；`git -C`、引号内 cd 不命中 |
| 工具层 cd 拦截 | `shell.rs` tests（同族：`shell_blocked_command_rejected` `:928-936`） | 纯 cd 拦截文案含「Cwd 参数」；复合链整链拦截 |
| 等待窗口转后台 | `agent-tools` 集成测试 + 壳层测试 | 窗口内完成=同步结果（timedOut=false 且无 taskId）；窗口超时=返回 taskId + 进程存活 + stdout 仍可读 |
| 输出落盘 | 壳层（临时 app_dir 注入） | 1MB 输出 → truncated=true + logPath 文件完整；磁盘满降级不失败 |
| 资源采样 | 壳层（真实 spawn + 2s 采样） | CPU/RSS 数值有限且单调（采样期间进程在跑）；无输出 M 秒 → Suspicious |
| 日志读尾/读行号 | 壳层 | 1000 行日志 → read_log(None, 100) 返回行号 901-1000；行数 checkpoint 二分定位正确 |
| 两阶段终止 | 壳层（忽略优雅信号的测试程序） | 5s 内退出 → Killed；超时升级 → Killed（标注）；自然退出 → AlreadyExited |
| stdin 注入 | 壳层（读 stdin 的测试程序） | send_input("y") → 程序收到带换行输入；stdin_closed 错误路径 |
| 注册表归档 | 壳层 | 30 分钟归档（注入短 retention 便于测试）；归档后 status NotFound、log 保留 |

**前端侧（`npx vitest run src`，对齐现有基线）**：

- `backgroundTasksApi.test.ts`（已存在 557 行测试面）：**恢复真实 invoke 契约**后更新 mock 形状（现有测试 `:473-535` 的 `listBackgroundTasks`/`getBackgroundTaskOutput`/`cancelBackgroundTask` 断言可复用，只需把 mock 返回值对齐新 Rust 形状——`outputPreview` 与 `status.tail` 的映射）；
- `useBackgroundTaskPolling.test.ts`（已存在）：轮询行为不变；
- 新增：任务卡片渲染终态（含 resource 快照缺失容忍）。

**E2E 验收路径**（对齐项目 e2e 风格）：spawn `npm run dev`（守护进程）→ 返回 taskId/logPath → list 可见 → read_log 尾部增长 → send_input 不可用（dev server 无交互，验证不阻塞）→ kill → 日志保留可读。

### 12.6 关键依赖与前置修复汇总

实施顺序中两个**必须先行的技术债**（不属于 REQ 本身但阻塞全部后台化改造）：

1. **`wait_with_output` 收口式读取改造为流式读取**（`shell.rs:660`）：阻塞 G2/G4/G5/G6/G7 的全部实现，是所有「后台化」的共同前置——建议作为独立任务单元先行；
2. **`process.rs:356` 的 daemon Job 系列恢复**：`create_kill_on_close_job_object`（`process.rs:391-421`）已具备原语，仅需为后台任务建独立 Job 并接线，独立小任务可并行。

其余条目按 §12.3 三阶段推进，各阶段验收锚点见 §12.5。

---

> **文档结束**
> 本文档为模块 A + 模块 B 的现状分析，供任务书拆解（PE 计划）与实现排期使用；文中所有 `文件:行号` 引用以本仓库当前 HEAD（`62ed2a61`）为准；旧系统设计资产引用自 git 历史提交 `967e7846^` 与 `6e2e180e^`（仅作语义参照，不复活已删除协议）。
