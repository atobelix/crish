# 全局架构与跨语言契约收敛方案

> **文件定位**：`docs/active-exploration-architecture/independent-plans/06-architecture-contract-convergence-plan.md`
> **方案职责**：对 Rust 内核（`crates/session-loop`, `crates/orchestrator`, `crates/conex-types`, `crates/conex-fs`, `crates/agent-tools`）与 Tauri 壳层（`apps/agent-workbench`）及前端契约（`apps/crish-desktop`, `packages/*`）进行跨层审查，彻底清理残留的跨层泄漏字段（如 `SessionLoopOptions.escape_watch`），建立单一清晰的 Run 配置契约与依赖倒置架构。

---

## 目录

1. [背景与架构现状诊断](#一背景与架构现状诊断)
2. [本方案要删掉什么 / 收敛什么](#二本方案要删掉什么--收敛什么)
3. [系统分层模型与依赖倒置图谱](#三系统分层模型与依赖倒置图谱)
4. [核心数据结构收敛详案](#四核心数据结构收敛详案)
   - [4.1 SessionLoopOptions 纯净化契约](#41-sessionloopoptions-纯净化契约)
   - [4.2 RunTaskOptions 与单一 Run 配置装配链](#42-runtaskoptions-与单一-run-配置装配链)
   - [4.3 ActiveRun 与 CoreRunState 运行时守卫收敛](#43-activerun-与-corerunstate-运行时守卫收敛)
   - [4.4 文件系统变更与安全审计契约收敛](#44-文件系统变更与安全审计契约收敛)
5. [跨语言契约（IPC / Wire Events）收敛与防漂移](#五跨语言契约ipc--wire-events收敛与防漂移)
6. [测试套件迁移与断言契约重构](#六测试套件迁移与断言契约重构)
7. [实施步骤与无损演进计划](#七实施步骤与无损演进计划)
8. [验收标准与架构不变量自检清单](#八验收标准与架构不变量自检清单)

---

## 一、背景与架构现状诊断

### 1.1 现状断层与泄漏分析

在 Conex / Crish 的架构演进中，工作区文件监视与逃逸追踪（Escape Watch / Undeclared Write Detection）被引入用于捕获 Agent 在工具调用外（如经由外部脚本或不受控进程）对工作区文件的未声明修改。然而在历史落地过程中，部分结构体与装配链条出现了**跨层职责泄漏与悬空契约**：

1. **`SessionLoopOptions.escape_watch` 悬空透传与悬空突变**：
   - 在 [`crates/session-loop/src/loop/loop_options.rs`](file:///c:/Software/conex/crates/session-loop/src/loop/loop_options.rs#L176) 中定义了 `pub escape_watch: Option<EscapeWatchConfig>`。
   - 在 [`crates/session-loop/src/loop/loop_runner.rs`](file:///c:/Software/conex/crates/session-loop/src/loop/loop_runner.rs#L146-L150) 的 `with_options()` 中，代码执行了拦截逻辑：
     ```rust
     if let Some(config) = options.escape_watch.take() {
         options.escape_watch = Some(
             config.with_detector(Arc::new(RegistryBackedDetector::new(Arc::clone(&registry)))),
         );
     }
     ```
   - **架构断层事实**：`AgentSessionLoop` 与 `LoopState` 在运行期间（`session_loop.run()`）**根本不消费、不启动、也不管理** `options.escape_watch`！
   - 真实的监视生命周期早在壳层 [`apps/agent-workbench/src-tauri/src/run/run_launch.rs`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run/run_launch.rs#L505) 中就已经调用 `spawn_escape_watch` 启动，其句柄直接交由 [`ActiveRun.escape_watch`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run/run_core.rs#L70) 持有，并在 [`apps/agent-workbench/src-tauri/src/run/run_idle.rs`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run/run_idle.rs#L1409) 中被 `take` 出并执行 `handle.shutdown().await`。
   - 这导致 `SessionLoopOptions.escape_watch` 沦为了纯粹的「悬空透传字段」，`with_options()` 内部的 `with_detector` 突变也是对一个从未被读取的字段进行无意义的写回。

2. **跨层概念倒置与职责错位**：
   - `SessionLoop` 的核心职责是 **单次 Run 内的 Prompt-to-Tool 推理与工具调用循环**（LLM 对话、中间件链、上下文预算、压缩、重试阶梯）。
   - `WorkspaceWatcher` / `EscapeWatch` 是 **宿主环境（Host Shell / Workbench Run Supervisor）级别的后台文件系统监视任务**。
   - 将宿主级别的监视器配置塞进内层核心推理循环的 `SessionLoopOptions` 中，违反了**单一职责原则（SRP）**与**依赖倒置原则（DIP）**。

3. **测试构造冗余与 Mock 散落**：
   - 由于 `SessionLoopOptions` 和 `ActiveRun` 中混杂了未解耦的字段，导致在 [`apps/agent-workbench/src-tauri/src/core_run_commands_tests.rs`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/core_run_commands_tests.rs) 以及 [`crates/session-loop/src/loop/loop_tests_exec.rs`](file:///c:/Software/conex/crates/session-loop/src/loop/loop_tests_exec.rs) 中，大量测试用例必须机械式地填充 `escape_watch: Mutex::new(None)` 或 `escape_watch: None`。

---

## 二、本方案要删掉什么 / 收敛什么

本节明确列出必须彻底移除的悬空字段、冗余契约及收敛目标。

### 2.1 要彻底删除的内容（Delete List）

| 序号     | 目标位置                                                                                                                                 | 删除项                                                                               | 删除理由                                                                     |
| :------- | :--------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------- | :--------------------------------------------------------------------------- |
| **D-01** | [`crates/session-loop/src/loop/loop_options.rs`](file:///c:/Software/conex/crates/session-loop/src/loop/loop_options.rs)                 | `SessionLoopOptions.escape_watch` 字段及注释                                         | `LoopState` 内部从不消费此配置；属于宿主层监视职责，不属于内核推理循环配置。 |
| **D-02** | [`crates/session-loop/src/loop/loop_options.rs`](file:///c:/Software/conex/crates/session-loop/src/loop/loop_options.rs)                 | `Default for SessionLoopOptions` 中的 `escape_watch: None`                           | 消除字段定义后的默认值初始化残留。                                           |
| **D-03** | [`crates/session-loop/src/loop/loop_runner.rs`](file:///c:/Software/conex/crates/session-loop/src/loop/loop_runner.rs)                   | `with_options` 中对 `options.escape_watch` 的 `take()` 与 `with_detector` 注入代码块 | 消除对未消费字段的悬空突变与无效赋值。                                       |
| **D-04** | [`apps/agent-workbench/src-tauri/src/run/run_launch.rs`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run/run_launch.rs) | `options` 构造块中的 `escape_watch: escape_config` 透传                              | 壳层不再向内核循环下发宿主层监视配置。                                       |
| **D-05** | 各模块测试用例中冗余字段构造                                                                                                             | 测试中所有 `SessionLoopOptions { escape_watch: ..., .. }`                            | 清理测试中对已删除字段的无意义显式构造。                                     |

### 2.2 要收敛与理顺的内容（Convergence List）

| 序号     | 目标模块                                   | 收敛契约与动作                                                                                                                                                                   | 达成效果                                     |
| :------- | :----------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------- |
| **C-01** | `crates/session-loop`                      | `SessionLoopOptions` 纯净化：专注于 LLM Provider、工具注册表、中间件、权限、上下文预算与压缩、控制总线。                                                                         | 内核循环配置语义高度内聚，零宿主监视副作用。 |
| **C-02** | `apps/agent-workbench`                     | `ActiveRun` 的监视器生命周期显式化：监视器作为 Run 级别的宿主伴生任务（`RunSupervisorTask`），由 `run_launch.rs` 启动、`ActiveRun` 托管句柄、`run_idle.rs` 统一 await shutdown。 | 宿主层资源生命周期闭环，不向内核渗透。       |
| **C-03** | `crates/session-loop::undeclared_detector` | `RegistryBackedDetector` 与 `UndeclaredWriteDetector` trait 保持与 `WritePathRegistry`（来自 `agent-tools`）的同源绑定，在壳层装配时直接注入 `EscapeWatchConfig`。               | 声明判定器单向依赖抽象，消除双重注入歧义。   |
| **C-04** | `crates/conex-fs` 与 `crates/conex-types`  | `FileChangeEvent`（数据面）与 `SecurityAuditOperation::UndeclaredWrite`（安全审计事件）保持严格的不可变线缆契约与 JSON Schema 对齐。                                             | 跨语言 IPC 与审计流零回归、零漂移。          |

---

## 三、系统分层模型与依赖倒置图谱

整个系统的依赖关系与契约流转必须遵循严格的单向分层，禁止任何逆向依赖或伪装透传。

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         apps/crish-desktop                               │
│        (React UI / Zustand / ChatBridge / SecurityAuditSection)          │
└────────────────────────────────────▲─────────────────────────────────────┘
                                     │  Tauri IPC (core_run_task / Events)
┌────────────────────────────────────┴─────────────────────────────────────┐
│                       apps/agent-workbench                               │
│      (Tauri Shell / CoreRunState / ActiveRun / Run Supervisor)           │
│  - 宿主装配：shared_registry, spawn_escape_watch, BridgeAuditSink         │
│  - 生命周期收口：drive_run_loop, shutdown_escape_watch, audit_persist      │
└──────────────┬─────────────────────────┬──────────────────────┬──────────┘
               │                         │                      │
┌──────────────▼────────────┐ ┌──────────▼──────────┐ ┌─────────▼──────────┐
│   crates/orchestrator     │ │ crates/session-loop │ │ crates/conex-fs    │
│  - RunManager / RunHandle │ │  - AgentSessionLoop │ │  - WorkspaceWatcher│
│  - EventQueue / Store     │ │  - SessionLoopOption│ │  - FileChangeEvent │
│  - Recovery / Restore     │ │  - UndeclaredDetect │ │  - UndeclaredWrite │
└──────────────┬────────────┘ └──────────┬──────────┘ └─────────┬──────────┘
               │                         │                      │
┌──────────────▼─────────────────────────▼──────────────────────▼──────────┐
│                          crates/agent-tools                              │
│   (WritePathRegistry / BackupMiddleware / ToolContext / AuditSink)       │
└────────────────────────────────────▲─────────────────────────────────────┘
                                     │
┌────────────────────────────────────┴─────────────────────────────────────┐
│                          crates/conex-types                              │
│    (AgentEvent / SecurityAudit / ContextBudget / Pure Wire Contracts)    │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.1 架构分层职责划分

1. **契约层（`crates/conex-types`）**：
   - 纯粹的领域数据模型、Wire JSON 契约、事件枚举（`AgentEvent`、`SecurityAuditOperation`、`SecurityAuditDecision` 等）。
   - **禁止**：包含任何 IO、Tokio 运行时或状态机逻辑。
2. **底层基础设施层（`crates/conex-fs`, `crates/conex-db`）**：
   - `conex-fs`：工作区文件操作、原子写入、回收站（Trash）、底层文件监视（`WorkspaceWatcher` 产出 `FileChangeEvent`）。
   - `conex-db`：SQLite 存储底账。
3. **工具与沙箱层（`crates/agent-tools`）**：
   - 核心工具定义、写路径注册表（`WritePathRegistry`）、写前备份中间件（`BackupMiddleware`）、探索文档配额上下文（`ExploreDocsQuotaContext`）。
4. **内核执行层（`crates/session-loop`, `crates/orchestrator`）**：
   - `session-loop`：专注于单 Run 内基于 LLM 的推理循环调度。`SessionLoopOptions` 仅包含推理所需的纯粹配置。提供 `RegistryBackedDetector` 用于根据 `WritePathRegistry` 判定文件变更。
   - `orchestrator`：会话树、Run 状态机转移、事件持久化序化。
5. **宿主应用层（`apps/agent-workbench`）**：
   - 组装核心：负责将 `conex-fs::WorkspaceWatcher`、`session_loop::RegistryBackedDetector`、`agent_tools::WritePathRegistry`、`BridgeAuditSink` 组装为宿主级监视任务，并在 Run 启动时挂载到 `ActiveRun`，在 Run 结束时优雅关闭。

---

## 四、核心数据结构收敛详案

### 4.1 SessionLoopOptions 纯净化契约

收敛后的 `SessionLoopOptions` 结构体移除 `escape_watch` 字段，严格保留循环执行期所需的配置项：

```rust
// crates/session-loop/src/loop/loop_options.rs

#[derive(Clone)]
pub struct SessionLoopOptions {
    // ── 实时事件与后台任务 ──
    pub live_sink: Option<Arc<dyn crate::provider::LiveEventSink>>,
    pub background: Option<Arc<dyn agent_tools::background::BackgroundTaskManager>>,
    pub log_root: Option<PathBuf>,

    // ── 错误重试与自愈策略 ──
    pub tool_promise_recovery_enabled: bool,
    pub max_tool_promise_heals: u32,
    pub transient_retry_limit: u32,
    pub retry_backoff: Option<RetryBackoffConfig>,
    pub provider_fail_streak: Option<u32>,
    pub length_upgrade_limit: u32,
    pub continue_nudge_limit: u32,
    pub steering_enabled: bool,

    // ── 循环钩子 ──
    pub turn_end_hook: Option<Arc<dyn TurnEndHook>>,
    pub should_stop_after_turn: Option<Arc<dyn TurnEndHook>>,
    pub recovery_hook: Option<Arc<dyn RecoveryHook>>,

    // ── 工具执行上下文与中间件 ──
    pub cwd: Option<String>,
    pub assistant_client_message_id: Option<String>,
    pub idempotency_enabled: bool,
    pub tool_middleware: Vec<Arc<dyn ToolMiddleware>>,
    pub hooks: Option<Arc<crate::hooks::HookRegistry>>,
    pub system_prompt: Option<String>,

    // ── 上下文预算与压缩 ──
    pub context_budget: Option<ContextBudget>,
    pub compaction_policy: Option<CompactionPolicy>,
    pub summarizer: Option<Arc<dyn Summarizer>>,
    pub max_auto_compactions_per_run: u32,
    pub compact_overflow_retries: u32,
    pub compact_require_llm: bool,
    pub compact_allow_stub_fallback: bool,
    pub compact_stage_ratios: Option<Vec<f64>>,
    pub cache_tracking: Option<CacheTrackingConfig>,

    // ── 权限与隔离上下文 ──
    pub write_claims: Option<Arc<WritePathRegistry>>,
    pub explore_docs_quota: Option<ExploreDocsQuotaContext>,
    pub output_dir: Option<Arc<dyn agent_tools::tools::output_dir::OutputDirResolver>>,
    pub parent_run_id: Option<String>,

    // ── 摘要调度与协调 ──
    pub summary_dispatch: Option<crate::r#loop::summary_dispatch::SummaryDispatchConfig>,
    pub compact_summary_max_attempts: u32,
    pub compact_summary_retry_window_ms: u64,
    pub summary_coordinator: Option<Arc<crate::r#loop::summary_coordinator::SessionSummaryCoordinator>>,
    pub compact_l1_placeholder: Option<bool>,

    // ── 笔记后端与待处理输入 ──
    pub note_backend: Option<NoteBackendHandle>,
    pub pending_input_store: Option<Arc<dyn crate::input::PendingInputStore>>,
    // 【清理】：彻底移除 escape_watch: Option<EscapeWatchConfig>
}
```

### 4.2 RunTaskOptions 与单一 Run 配置装配链

在 `apps/agent-workbench` 壳层中，`run_task_impl` 负责整体协调。装配链分为两路，各司其职：

1. **核心推理循环装配路**：
   - 构造 `WritePathRegistry`（`shared_registry`）。
   - 组装 `SessionLoopOptions`（传入 `write_claims: Some(shared_registry.clone())`、中间件、提示词、预算等）。
   - 组装 `SessionLoopProducer` 并绑定 `control_bus`、`abort_signal`、`delta_sink`。
2. **宿主监视伴生任务装配路**：
   - 构造 `EscapeWatchConfig`：
     - `root`: 工作区解析路径。
     - `session_id`, `run_id`。
     - `audit_sink`: `bridge_audit_sink`。
     - `injector`: `ControlBusInjector::new(control_bus.clone())`。
     - `detector`: `RegistryBackedDetector::new(shared_registry.clone())`。
   - 调用 `spawn_escape_watch(root, escape_config)` 启动监视任务。
   - 将返回的 `EscapeWatchHandle` 存入 `ActiveRun.escape_watch`。

```
[run_task_impl]
   │
   ├─► 1. 创建共享写路径注册表: shared_registry = Arc::new(WritePathRegistry::new(...))
   │
   ├─► 2. 构造宿主级监视器 (Host Supervisor):
   │       escape_config = EscapeWatchConfig::new(...)
   │                         .with_injector(ControlBusInjector)
   │                         .with_detector(RegistryBackedDetector(shared_registry))
   │       escape_handle = spawn_escape_watch(root, escape_config)
   │
   ├─► 3. 构造内核推理循环选项 (SessionLoopOptions):
   │       options = SessionLoopOptions {
   │           write_claims: Some(shared_registry), // 仅下发写声明沙箱
   │           system_prompt,
   │           context_budget,
   │           ... (无 escape_watch)
   │       }
   │
   ├─► 4. 注册活动 Run 状态 (ActiveRun):
   │       active = ActiveRun {
   │           escape_watch: Mutex::new(escape_handle), // 宿主直接持有监视句柄
   │           handle,
   │           queue,
   │           control_bus,
   │           abort_signal,
   │           ...
   │       }
   │
   └─► 5. 驱动执行 (drive_run_loop) 与优雅收口
```

### 4.3 ActiveRun 与 CoreRunState 运行时守卫收敛

在 `apps/agent-workbench/src-tauri/src/run/run_core.rs` 中：

- `ActiveRun` 维持对 `escape_watch: Mutex<Option<EscapeWatchHandle>>` 的持有。这属于宿主运行时的正常持有，代表宿主管理当前正在运行的伴生任务。
- 在 `run_idle.rs` 中的收口逻辑保持标准模式：
  ```rust
  // run 收口钩子：停止监视并 flush 剩余事件
  let escape_handle = active
      .escape_watch
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .take();
  if let Some(mut handle) = escape_handle {
      handle.shutdown().await;
  }
  ```
- 这种收口方式完全由宿主调度器闭环，不再与内核 `AgentSessionLoop` 发生任何接口耦合。

### 4.4 文件系统变更与安全审计契约收敛

1. **数据面事件**（`conex_fs::watch::FileChangeEvent`）：
   - 字段：`path: PathBuf`, `kind: ChangeKind`, `from: Option<PathBuf>`, `occurred_at_ms: i64`。
   - 序列化规则：`camelCase`，`from` 仅在 `Renamed` 时输出。
2. **判定与聚合报告**（`conex_fs::watch::UndeclaredWrite`）：
   - 字段：`session_id`, `run_id`, `changes`, `first_occurred_at_ms`, `last_occurred_at_ms`, `file_count`, `has_destructive`。
   - 聚合纯逻辑：由 `session_loop::escape_watch::EscapeAggregator` 执行同路径去重、批阈值（默认 10）与时间窗（默认 5000ms）限流。
3. **安全审计事件出口**（`conex_types::events::AgentEvent::SecurityAudit`）：
   - `operation`: `SecurityAuditOperation::UndeclaredWrite`（wire string: `"undeclared-write"`）。
   - `targets`: 变更绝对路径列表。
   - `decision`: `SecurityAuditDecision::Denied`（表示非引擎批准的工具外写入）。
   - `impact`: `ImpactAssessment`（`file_count` 为聚合文件数）。

---

## 五、跨语言契约（IPC / Wire Events）收敛与防漂移

### 5.1 Tauri IPC 命令面

| 命令名称           | 请求载荷（TypeScript -> Rust）                                                                                                              | 响应载荷（Rust -> TypeScript）              | 契约收敛断言                                                            |
| :----------------- | :------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------ | :---------------------------------------------------------------------- |
| `core_run_task`    | `RunTaskOptions`（包含 `runId`, `sessionId`, `prompt`, `cwd`, `permissionMode`, `history`, `contextWindow`, `visibleGoal`, `maxRounds` 等） | `RunTaskResponse`（`{ runId, sessionId }`） | 前端禁止出现任何 `escapeWatch` 字段；参数保持轻量透明。                 |
| `core_run_control` | `RunControlOptions`（`{ runId, level, reason }`）                                                                                           | `RunControlResponse`（`{ ok, runId }`）     | 控制信号经 `ControlBus` 与 `AbortSignal` 直达内核，与伴生监视任务独立。 |
| `core_cancel_run`  | `CancelRunOptions`（`{ runId, mode, reason }`）                                                                                             | `CancelRunResponse`（`{ ok, runId }`）      | L2/L3 级联取消，触发伴生监视器与驱动任务的优雅终止。                    |

### 5.2 事件线缆协议（Wire Protocol）

前端通过监听 `workbench-run-event` 获取 `AgentEventEnvelope`：

```typescript
export interface AgentEventEnvelope {
  event: AgentEvent;
  runId?: string;
  sequence?: number;
}
```

其中对于逃逸监视触发的未声明写入：

```json
{
  "type": "security-audit",
  "sessionId": "s-123456",
  "operation": "undeclared-write",
  "targets": ["C:\\Software\\conex\\src\\unexpected.ts"],
  "decision": "denied",
  "impact": {
    "fileCount": 1,
    "totalSizeBytes": 0,
    "crossDirectory": false,
    "sensitive": false
  },
  "occurredAtMs": 1723789000000
}
```

前端 UI 组件（如 [`apps/crish-desktop/src/components/workspace/SecurityAuditSection.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/SecurityAuditSection.tsx)）直接消费 `operation === 'undeclared-write'` 并渲染为「未声明写入」，全链路强类型对齐。

---

## 六、测试套件迁移与断言契约重构

清理 `SessionLoopOptions.escape_watch` 后，相关测试用例需进行精确定位与重构：

### 6.1 `crates/session-loop` 测试迁移

在 [`crates/session-loop/src/loop/loop_tests_exec.rs`](file:///c:/Software/conex/crates/session-loop/src/loop/loop_tests_exec.rs) 中：

- **现状测试**：原测试在 `SessionLoopOptions` 中传入 `escape_watch: Some(EscapeWatchConfig::new(...))` 并断言 `loop_.state.options.escape_watch` 中的 detector 是否就绪。
- **重构后测试**：
  1. `SessionLoopOptions` 构造块中移除 `escape_watch`。
  2. 验证 `write_claims` 正确注入工具上下文 `loop_.tool_ctx.write_claims`。
  3. `RegistryBackedDetector` 的单元测试直接使用 `RegistryBackedDetector::new(registry)` 测试 `is_declared` 逻辑（已在 `undeclared_detector.rs` 中具备完备覆盖）。
  4. 监视器聚合与限流测试直接针对 `EscapeAggregator` 和 `consume_loop`，不再经由 `SessionLoop` 伪装装配。

### 6.2 `apps/agent-workbench` 测试迁移

在 [`apps/agent-workbench/src-tauri/src/core_run_commands_tests.rs`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/core_run_commands_tests.rs) 中：

- 检查所有 Mock `ActiveRun` 构造点，保持 `escape_watch: Mutex::new(None)` 作为宿主字段的默认初始化。
- 保证 E2E 逃逸监视测试（`escape_watch_inject_reaches_main_agent`、声明覆盖静默测试等）全部通过，验证监视器启动、判定器命中、审计发射与主 Agent followUp 注入全链路完好无损。

---

## 七、实施步骤与无损演进计划

为了确保零回归与流水线门禁绿灯，代码清理应遵循以下精确顺序：

```
Step 1: 内核契约清理 (crates/session-loop)
  ├── 1.1 从 SessionLoopOptions 中删除 escape_watch 字段与 Default 实现中的 None
  ├── 1.2 从 loop_runner.rs 的 with_options 中移除 with_detector 拦截代码
  └── 1.3 调整 loop_tests_exec.rs 中对 SessionLoopOptions.escape_watch 的构造引用

Step 2: 壳层装配收敛 (apps/agent-workbench)
  ├── 2.1 调整 run_launch.rs：移除 options 构造中的 escape_watch: escape_config
  └── 2.2 确保 run_launch.rs 中的 spawn_escape_watch 与 ActiveRun.escape_watch 依然正常运转

Step 3: 契约与全量验证
  ├── 3.1 运行 cargo test --workspace 确保 Rust 全套件（73+ 套件）绿灯
  ├── 3.2 运行 npm run typecheck 确保前端 TypeScript 类型检查零报错
  └── 3.3 运行专项 E2E 与单元测试（vitest / registry_drift）
```

---

## 八、验收标准与架构不变量自检清单

### 8.1 架构不变量自检清单

| 检查项             | 验收断言                                                                                                       | 验证手段                                                      |
| :----------------- | :------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------ |
| **无悬空字段**     | `SessionLoopOptions` 中无任何未在 `session_loop.run()` 中消费的字段。                                          | 源码 grep 检查 `SessionLoopOptions` 所有字段的读写引用链。    |
| **无伪装透传**     | `SessionLoopRunner::with_options` 内部无对无用配置的二次包装或无效赋值。                                       | 审查 `loop_runner.rs` 中 `with_options` 的所有赋值操作。      |
| **单向依赖倒置**   | `conex-types` 零依赖；`session-loop` 仅依赖 `agent-tools` / `conex-types`；宿主 `agent-workbench` 组装各组件。 | `cargo tree -p session-loop` 验证依赖图谱。                   |
| **审计与注入完整** | 工具声明内的写操作保持静默；未声明的外部写操作产生 `undeclared-write` 审计并注入主 Agent。                     | 运行 `core_run_commands_tests.rs` 中的 E2E 逃逸监视测试套件。 |
| **跨语言契约对齐** | JSON Schema（`engine-events.json`）、Rust 类型（`conex-types`）与 TypeScript（`crish-desktop`）严格一致。      | 运行 `registry_drift.rs` 契约漂移测试。                       |
| **门禁零跳过**     | 严禁使用 `--no-verify`，全量类型检查与单元测试全部通过。                                                       | CI / 本地全量门禁检查绿灯。                                   |

### 8.2 最终结论

通过本方案的收敛实施，`SessionLoopOptions` 将回归其纯粹的推理循环职责，消除了历史残留的悬空配置与无效突变；同时，宿主级别的监视伴生任务被清晰收敛在 `agent-workbench` 运行期生命周期中。整个工作区的架构分层干净、依赖倒置合理，消除了潜在的状态漂移风险与认知负担。
