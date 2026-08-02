# 子计划 02：Layer B — Rust & Tauri 后端 (Rust Core Backend & Tauri IPC)

> **层级编号**：Layer B（Round 2，依赖 Layer A 完成后启动；B-15~B-21 在 Round 0 可先行配置）
> **建议 Agent 数量**：8-10 个（按文件/模块互斥划分）
> **涉及维度**：D1（架构耦合与单一职责）、D3（逻辑重复）、D4（并发安全 — std::sync::Mutex 跨 await）、D5（IPC 边界）、D6（资源泄漏）、D7（进程安全）、D14（Rust 工程纪律）
> **下游依赖方**：Layer C (Runtime Engine) 消费 conex-stream 解析器、Layer D (Daemon) 通过 IPC 与 Tauri 命令交互

---

## 一、层级目标

Layer B 的核心使命是重构 Rust 后端的上帝文件群、修复并发安全隐患、消除 Stream Parser 的重复模式：

1. 拆分 `sidecar/connection.rs`（1,227 行）为 4-5 个职责单一的子模块。
2. 拆分 `sidecar/commands.rs`（1,939 行）为按领域分组的命令模块。
3. 将 `sidecar/types.rs` 中的 `std::sync::Mutex` 全局静态变量评估为是否需要迁移到 `tokio::sync::Mutex`。
4. 提取 `conex-stream` 三个 Parser（Anthropic/Gemini/OpenAI）的 `feed()`/`finish()`/`reset()` 重复样板代码。
5. 拆分 `anthropic.rs` 的 `process_event()` 高圈复杂度方法。
6. 修复 `process.rs` 的 fire-and-forget 进程终止孤儿隐患。
7. 拆分 `fs_commands.rs`（1,114 行）、`host_openers.rs`（1,019 行）、`config/mod.rs`（819 行）。

---

## 二、任务总表

| 任务 ID | 目标文件 | 当前行数 | 核心问题 | 修复策略 | 来源维度 | 分配 Agent |
|---------|---------|---------|---------|---------|---------|-----------|
| B-1 | `sidecar/connection.rs` | 1,227 | 混合连接辅助、查询发送、断线处理、进程管理、生命周期管理、WS 读写循环 | 拆分为 5 个子模块 | D1 | Agent B1 |
| B-2 | `sidecar/commands.rs` | 1,939 | 50+ 个 `#[tauri::command]` 处理函数全堆在一个文件 | 按领域拆分为 5-6 个命令子模块 | D1 | Agent B1 |
| B-3 | `sidecar/types.rs` 全局静态 | 302 | 11 个 `OnceLock<Mutex<>>` 使用 `std::sync::Mutex`，需评估跨 await 风险 | 审计每个锁点的 await 上下文 | D4 | Agent B2 |
| B-4 | `conex-stream/parser/*.rs` | 3×(400-624) | `feed()`/`finish()`/`reset()` 在 3 个 Parser 中结构 100% 重复 | 提取到 trait 默认方法或宏 | D3 | Agent B3 |
| B-5 | `conex-stream/parser/anthropic.rs` | 624 | `process_event()` 方法 CC≈29，单方法 240+ 行 | 拆分为按事件类型的子方法 | D1, D8 | Agent B3 |
| B-6 | `process.rs` 进程终止 | 773 | `fire_and_forget` 不等待 `taskkill` 完成，孤儿进程泄漏 | 引入 Windows Job Object 绑定 | D7 | Agent B4 |
| B-7 | `fs_commands.rs` | 1,114 | 上帝文件：文件读写、目录列举、编码检测、安全守卫混杂 | 按职责拆分 | D1 | Agent B5 |
| B-8 | `host_openers.rs` | 1,019 | 上帝文件：发现候选者、解析目标、执行打开、跨平台逻辑混杂 | 按职责拆分 | D1 | Agent B5 |
| B-9 | `config/mod.rs` | 819 | 配置读取、API 密钥管理、Provider 解析、环境变量过滤混杂 | 按子领域拆分 | D1 | Agent B6 |
| B-10 | `sidecar/connection.rs` oneshot 泄漏 | — | `PendingSidecarResponse.sender` 在超时路径中被移除但未被 drop-send | 确保所有路径显式 send 或 drop | D4 | Agent B2 |
| B-11 | 跨 crate workspace lint 统一 | 根 `Cargo.toml` | 无 `[workspace.lints]` 配置 | 添加 `[workspace.lints.clippy]` 段 | D14 | Agent B7 |
| B-12 | 创建 `clippy.toml` | 新建 | clippy 自定义规则缺失 | 创建配置文件，定义 `allow-unwrap-in-tests` 等 | D14 | Agent B7 |
| B-13 | 创建 `deny.toml` | 新建 | 依赖审计缺失 | 配置 `cargo-deny`（许可证 + advisory + 版本） | D14 | Agent B7 |
| B-14 | 添加 `[profile.*]` 优化配置 | 根 `Cargo.toml` | 构建 profile 单一化 | 添加 release/profiling/dev-small profile | D14 | Agent B7 |
| B-15 | 审计 `#[allow]` + 添加 SAFETY 注释 | 跨全部 `*.rs` | unsafe 块无 safety 注释 | 逐 unsafe 块添加 SAFETY 注释 | D14 | Agent B8 |
| B-16 | 替换 `.unwrap()`/`.expect()` 为 Result | 跨全部 `*.rs` | 15+ 处 unwrap | 使用 `anyhow::Context` + `thiserror` 逐步替换 | D14 | Agent B8 |
| B-17 | 替换 `eprintln!` 为 tracing 日志 | 跨全部 `*.rs` | 模块级 eprintln! | 引入 `tracing` crate 替代 | D14 | Agent B8 |
| B-18 | `version.workspace = true` 版本号继承 | 跨各 crate `Cargo.toml` | 子 crate 硬编码版本号（如 conex-stream 0.1.0） | 统一使用 `version.workspace = true` 从 workspace 继承 | D14 | Agent B7 |
| B-19 | `rustfmt.toml` `imports_granularity = "Item"` 配置 | 新建 `rustfmt.toml` | 缺少统一 imports 分组规范 | 创建 `rustfmt.toml` 配置 `imports_granularity = "Item"` | D14 | Agent B7 |
| B-20 | `PendingToolCall` 共享结构体提取 | `crates/conex-stream/src/parser/` | anthropic.rs 与 openai_chat.rs 中 100% 重复的 `PendingToolCall` 结构体 ($S=1.00$) | 提取到公共模块统一引用 | D3 | Agent B3 |

---

## 三、任务 B-1：connection.rs 领域拆分

### 3.1 问题现状

[connection.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/sidecar/connection.rs) 包含 1,227 行代码，混合了以下 **5 个完全不同的职责领域**：

| 领域 | 行号范围（约） | 核心职责 | 代表性函数 |
|------|-------------|---------|-----------|
| D1: 连接辅助 | L33-L85 | 获取/检查当前连接状态 | `current_sidecar_sender()`, `sidecar_connection_usable()`, `cached_sidecar_sender_or_disconnect()` |
| D2: 查询/命令发送 | L87-L395 | 发送 IPC 查询和命令到 Daemon | `send_sidecar_query()`, `send_sidecar_query_once()`, `send_sidecar_command()`, `send_sidecar_command_once()`, `send_current_sidecar_command()` |
| D3: 断线处理与端点管理 | L397-L490 | 断线处理、端点记录与清理 | `disconnect_sidecar_generation()`, `record_sidecar_daemon_endpoint()`, `active_sidecar_daemon_endpoint()` |
| D4: 进程管理 | L492-L643 | 子进程生命周期管理 | `clear_sidecar_process()`, `read_daemon_stdout_line_with_timeout()`, `collect_child_exit()`, `spawn_sidecar_output_drain()`, `cleanup_sidecar()` |
| D5: 连接生命周期与 WS 循环 | L664-L1227 | 连接建立、重试、WebSocket 读写循环、Daemon 启动 | `ensure_sidecar_connected()`, `connect_sidecar_websocket()`, `start_and_connect_sidecar()` |

### 3.2 目标文件结构

```
apps/agent-workbench/src-tauri/src/sidecar/
├── connection/
│   ├── mod.rs              # barrel 重导出（向后兼容 `use super::connection::*`）
│   ├── helpers.rs          # D1: 连接辅助函数
│   ├── query.rs            # D2: 查询/命令发送
│   ├── disconnect.rs       # D3: 断线处理与端点管理
│   ├── process_mgmt.rs     # D4: 子进程生命周期
│   └── lifecycle.rs        # D5: 连接建立、重试、WS 循环
├── commands.rs             # (由 B-2 拆分)
├── run_stream.rs           # (保持不变)
├── supervisor.rs           # (保持不变)
├── pending.rs              # (保持不变)
├── types.rs                # (由 B-3 审计)
└── mod.rs                  # 更新 `pub mod connection;`
```

### 3.3 逐步操作指引

**Step 1**：创建 `connection/` 子目录，将原始 `connection.rs` 移动为 `connection/mod.rs`（临时）。

**Step 2**：按上述领域表的行号范围，逐段将函数从 `mod.rs` 剪切到对应的子文件中。

**Step 3**：处理跨领域依赖。关键依赖分析：

| 被引用函数 | 定义在 | 被调用于 |
|-----------|-------|---------|
| `disconnect_sidecar_generation()` | `disconnect.rs` | `helpers.rs`, `lifecycle.rs`, WS 读循环 |
| `sidecar_connection()` | `types.rs`（外部） | `helpers.rs`, `lifecycle.rs` |
| `clear_sidecar_process()` | `process_mgmt.rs` | `disconnect.rs`, `lifecycle.rs` |
| `record_sidecar_daemon_endpoint()` | `disconnect.rs` | `lifecycle.rs` |

**Step 4**：创建 `connection/mod.rs` barrel 文件：
```rust
mod helpers;
mod query;
mod disconnect;
mod process_mgmt;
mod lifecycle;

pub(crate) use helpers::*;
pub(crate) use query::*;
pub(crate) use disconnect::*;
pub(crate) use process_mgmt::*;
pub(crate) use lifecycle::*;
```

**Step 5**：在 `sidecar/mod.rs` 中更新 `pub mod connection;`（应自动指向目录模块）。

### 3.4 关键约束

- 每个子文件 ≤ 400 行。
- `cargo build` 零新增错误。
- `cargo clippy --all-targets` 零新增 warning。
- 不改变任何函数签名或公开可见性。

---

## 四、任务 B-2：commands.rs 领域拆分

### 4.1 问题现状

[commands.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/sidecar/commands.rs) 包含 1,939 行，堆积了 50+ 个 `#[tauri::command]` 处理函数。通过对文件的审查，可识别以下领域分组：

| 领域 | 行号范围（约） | 命令数 | 代表性命令 |
|------|-------------|-------|-----------|
| 连接状态命令 | L10-L120 | 4 | `workbench_daemon_endpoint`, `workbench_connection_status`, `workbench_status`, `workbench_provider_diagnostics` |
| 会话管理命令 | L120-L500 | ~10 | `workbench_list_sessions`, `workbench_session_events`, `workbench_run_events` |
| 运行控制命令 | L500-L900 | ~10 | `workbench_run_task`, `workbench_cancel_run`, `workbench_approve_tool_call` |
| 配置与偏好命令 | L900-L1200 | ~8 | `workbench_update_config`, `workbench_update_api_key` |
| 计划文档命令 | L1200-L1600 | ~8 | `workbench_create_plan`, `workbench_update_plan`, `workbench_list_plans` |
| 杂项辅助命令 | L1600-L1939 | ~10 | `workbench_apply_session_action`, `workbench_conversation_rewind` |

### 4.2 目标结构

```
apps/agent-workbench/src-tauri/src/sidecar/commands/
├── mod.rs                   # barrel + build_read_run_events_command 等辅助函数
├── status_commands.rs       # 连接状态与诊断命令
├── session_commands.rs      # 会话管理命令
├── run_commands.rs          # 运行控制命令（start/cancel/approve）
├── config_commands.rs       # 配置更新命令
├── plan_commands.rs         # 计划文档 CRUD 命令
└── action_commands.rs       # Session Action / Rewind 等杂项
```

### 4.3 关键约束

- 每个子文件 ≤ 400 行。
- 所有 `#[tauri::command]` 函数的可见性保持 `pub(crate)`。
- 在 `lib.rs` / `main.rs` 的 `generate_handler![]` 宏中，需要更新 import 路径。
- `cargo build` 零新增错误。

### 4.4 Tauri Handler 注册更新

Agent 必须搜索 `generate_handler!` 宏的使用位置，确认所有拆分后的命令仍被正确注册：

```bash
grep -rn "generate_handler" apps/agent-workbench/src-tauri/src/
```

---

## 五、任务 B-3：std::sync::Mutex 并发安全审计

### 5.1 问题现状

[types.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/sidecar/types.rs) L203-L213 定义了 **11 个全局静态变量**，其中 9 个使用 `std::sync::Mutex`：

```rust
static SIDECAR: OnceLock<Mutex<Option<SidecarConnection>>> = OnceLock::new();
static SIDECAR_PROCESS: OnceLock<Mutex<Option<std::process::Child>>> = OnceLock::new();
static SIDECAR_DAEMON_ENDPOINT: OnceLock<Mutex<Option<SidecarDaemonEndpoint>>> = OnceLock::new();
static SIDECAR_PENDING_RESPONSES: OnceLock<Mutex<VecDeque<PendingSidecarResponse>>> = OnceLock::new();
static SIDECAR_STARTUP: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();  // ← 已经是 tokio Mutex
static SIDECAR_SUPERVISOR: OnceLock<Mutex<SidecarSupervisorSnapshot>> = OnceLock::new();
static SIDECAR_RUN_STREAMS: OnceLock<Mutex<HashMap<String, RunStreamRecoveryState>>> = OnceLock::new();
```

### 5.2 逐锁分析

| 锁名称 | 类型 | 是否跨 await 持有 | 风险评估 | 操作建议 |
|-------|------|----------------|---------|---------|
| `SIDECAR` | `Mutex<Option<SidecarConnection>>` | ⚠️ 在 `ensure_sidecar_connected()` 中 `conn.lock()` 后执行快速赋值然后立即 drop guard，**没有跨 await** | 低风险 | **保持 std::sync::Mutex** — guard 在 block scope 内快速释放 |
| `SIDECAR_PROCESS` | `Mutex<Option<Child>>` | ✅ 在 `clear_sidecar_process()` 中 lock 后调用 `child.wait()`（同步阻塞） | **中等风险** — `child.wait()` 会阻塞线程 | 将 `child.wait()` 移到 guard drop 之后，或使用 `spawn_blocking` |
| `SIDECAR_DAEMON_ENDPOINT` | `Mutex<Option<SidecarDaemonEndpoint>>` | 快速读/写，无 await | 低风险 | 保持 |
| `SIDECAR_PENDING_RESPONSES` | `Mutex<VecDeque<PendingSidecarResponse>>` | 快速 push/pop，无 await | 低风险 | 保持 |
| `SIDECAR_STARTUP` | `tokio::sync::Mutex<()>` | ✅ 已经是 tokio Mutex | 无风险 | 保持 |
| `SIDECAR_SUPERVISOR` | `Mutex<SidecarSupervisorSnapshot>` | 快速读/写，无 await | 低风险 | 保持 |
| `SIDECAR_RUN_STREAMS` | `Mutex<HashMap<...>>` | 快速读/写，无 await | 低风险 | 保持 |

### 5.3 关键修复：`SIDECAR_PROCESS` 的 `child.wait()` 阻塞

**代码现场**（[connection.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/sidecar/connection.rs) L494-L521）：

```rust
fn clear_sidecar_process(kill_child: bool) {
    // ...
    if let Some(proc_store) = sidecar_process().get()
        && let Ok(mut guard) = proc_store.lock()  // ← 获取 std::sync::Mutex lock
        && let Some(mut child) = guard.take()
    {
        let pid = child.id();
        if kill_child {
            match process::terminate_process_tree_fire_and_forget(pid) {
                Ok(()) => {}
                Err(error) => {
                    let _ = child.kill();
                }
            }
        }
        let _ = child.wait();  // ← 阻塞！在 Mutex guard 生命周期内调用同步阻塞的 wait()
    }
}
```

**修复方案**：将 `child` 从 guard 中 `take()` 出来后，**先 drop guard，再执行阻塞操作**：

```rust
fn clear_sidecar_process(kill_child: bool) {
    if kill_child {
        clear_sidecar_daemon_endpoint();
    }
    
    // 在 guard 生命周期内只做 take，不做阻塞操作
    let child = if let Some(proc_store) = sidecar_process().get()
        && let Ok(mut guard) = proc_store.lock()
    {
        guard.take()
    } else {
        None
    };
    // ↑ guard 已被 drop

    // ↓ 阻塞操作在 guard 之外执行
    if let Some(mut child) = child {
        let pid = child.id();
        if kill_child {
            println!(
                "[Sidecar][daemon.child-process] Terminating stale daemon process tree (PID: {})",
                pid
            );
            match process::terminate_process_tree_fire_and_forget(pid) {
                Ok(()) => {}
                Err(error) => {
                    eprintln!(
                        "[Sidecar][daemon.child-process] Process tree termination failed for PID {pid}: {error}; falling back to child.kill()"
                    );
                    let _ = child.kill();
                }
            }
        }
        let _ = child.wait();
    }
}
```

### 5.4 验证命令

```bash
cd apps/agent-workbench/src-tauri
cargo build
cargo clippy --all-targets -- -W clippy::await_holding_lock
```

---

## 六、任务 B-4：conex-stream Parser 重复模式提取

### 6.1 问题现状

三个 Parser 的 `StreamParser` trait 实现存在 **100% 结构重复**的 `feed()` 方法：

**GeminiStreamParser::feed()** (L190-L209)：
```rust
fn feed(&mut self, frame: &[u8]) -> Result<Vec<StreamEvent>, StreamError> {
    if self.finished { return Ok(Vec::new()); }
    let sse_outputs = self.sse.feed_bytes(frame)?;
    for output in &sse_outputs {
        match output {
            crate::parser::SseOutput::Frame(sse_frame) => {
                self.process_frame(&sse_frame.data)?;
            }
            crate::parser::SseOutput::FrameSkipped { size } => {
                self.events.push_back(StreamEvent::FrameSkipped { size: *size });
            }
        }
    }
    Ok(self.events.drain(..).collect())
}
```

**OpenAIChatStreamParser::feed()** (L261-L279) — **完全相同的结构**。

**AnthropicMessagesStreamParser::feed()** 稍有不同（使用 `process_event` 替代 `process_frame`，需要两个参数 `event_type` 和 `data`），但整体结构高度相似。

### 6.2 修复方案：提取辅助 trait 或宏

**方案 A：辅助 trait（推荐）**

```rust
// crates/conex-stream/src/parser/mod.rs 中新增

/// SSE-based stream parser 的通用实现辅助。
/// 实现此 trait 的类型自动获得标准的 feed/finish/reset 样板。
pub(crate) trait SseStreamParserCore {
    fn sse_parser(&mut self) -> &mut SseFrameParser;
    fn events_queue(&mut self) -> &mut VecDeque<StreamEvent>;
    fn is_finished(&self) -> bool;
    fn set_finished(&mut self, finished: bool);
    
    /// 处理单个 SSE 帧的 data payload。
    fn process_sse_frame(&mut self, data: &str) -> Result<(), StreamError>;
    
    /// 在 finish() 时执行额外的 flush 操作（如 close_text、flush_tool_calls）。
    fn flush_on_finish(&mut self);
    
    /// 在 reset() 时清理额外的内部状态。
    fn reset_extra(&mut self);
}

/// 为实现了 SseStreamParserCore 的类型提供 feed 的默认实现。
fn sse_feed<P: SseStreamParserCore>(parser: &mut P, frame: &[u8]) -> Result<Vec<StreamEvent>, StreamError> {
    if parser.is_finished() {
        return Ok(Vec::new());
    }
    let sse_outputs = parser.sse_parser().feed_bytes(frame)?;
    for output in &sse_outputs {
        match output {
            SseOutput::Frame(sse_frame) => {
                parser.process_sse_frame(&sse_frame.data)?;
            }
            SseOutput::FrameSkipped { size } => {
                parser.events_queue().push_back(StreamEvent::FrameSkipped { size: *size });
            }
        }
    }
    Ok(parser.events_queue().drain(..).collect())
}
```

每个 Parser 的 `impl StreamParser for XxxParser` 中改为调用 `sse_feed(self, frame)`。

### 6.3 验证命令

```bash
cd crates/conex-stream
cargo test
cargo clippy
```

---

## 七、任务 B-5：anthropic.rs process_event 拆分

### 7.1 问题现状

[anthropic.rs](file:///c:/Software/conex/crates/conex-stream/src/parser/anthropic.rs) 的 `process_event()` 方法（L103-L343）共 **240 行**，圈复杂度 CC ≈ 29。包含 7 个一级 match arm（`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `error`），其中 `content_block_delta` 内又嵌套 4 个子 match arm（`text_delta`, `thinking_delta`, `signature_delta`, `input_json_delta`）。

### 7.2 修复方案

将每个一级 match arm 提取为独立的私有方法：

```rust
impl AnthropicMessagesStreamParser {
    fn process_event(&mut self, event_type: &str, data: &str) -> Result<(), StreamError> {
        if data.is_empty() || self.finished {
            return Ok(());
        }
        let v: serde_json::Value = serde_json::from_str(data)?;
        match event_type {
            "message_start" => self.handle_message_start(&v),
            "content_block_start" => self.handle_content_block_start(&v),
            "content_block_delta" => self.handle_content_block_delta(&v),
            "content_block_stop" => self.handle_content_block_stop(&v),
            "message_delta" => self.handle_message_delta(&v),
            "message_stop" => self.handle_message_stop(),
            "error" => self.handle_error(&v),
            "ping" | _ => Ok(()),
        }
    }

    fn handle_message_start(&mut self, v: &serde_json::Value) -> Result<(), StreamError> { /* L111-L121 */ }
    fn handle_content_block_start(&mut self, v: &serde_json::Value) -> Result<(), StreamError> { /* L123-L190 */ }
    fn handle_content_block_delta(&mut self, v: &serde_json::Value) -> Result<(), StreamError> { /* L192-L280 */ }
    fn handle_content_block_stop(&mut self, v: &serde_json::Value) -> Result<(), StreamError> { /* L282-L285 */ }
    fn handle_message_delta(&mut self, v: &serde_json::Value) -> Result<(), StreamError> { /* L287-L309 */ }
    fn handle_message_stop(&mut self) -> Result<(), StreamError> { /* L311-L321 */ }
    fn handle_error(&mut self, v: &serde_json::Value) -> Result<(), StreamError> { /* L323-L334 */ }
}
```

对于 `handle_content_block_delta` 内部的嵌套 match，可进一步提取：
```rust
fn handle_content_block_delta(&mut self, v: &serde_json::Value) -> Result<(), StreamError> {
    let index = v["index"].as_u64().unwrap_or(0) as u32;
    let delta = &v["delta"];
    let delta_type = delta["type"].as_str().unwrap_or("");
    match delta_type {
        "text_delta" => self.handle_text_delta(index, delta),
        "thinking_delta" => self.handle_thinking_delta(index, delta),
        "signature_delta" => self.handle_signature_delta(index),
        "input_json_delta" => self.handle_input_json_delta(index, delta),
        _ => Ok(()),
    }
}
```

### 7.3 质量门槛

- 拆分后 `process_event()` 方法 ≤ 30 行。
- 每个子方法 CC ≤ 8。
- 通过 `cargo test` 所有现有测试。

---

## 八、任务 B-6：进程终止与孤儿进程防护

### 8.1 问题现状

[process.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/process.rs) 包含两组进程终止函数：

1. **异步版** `terminate_process_tree()` (L713-L741)：使用 `TokioCommand::new("taskkill")` + `.output().await`，等待 taskkill 完成。
2. **同步版** `terminate_process_tree_fire_and_forget()` (L751-L773)：使用 `Command::new("taskkill")` + `.spawn()`，**不等待完成**。

`connection.rs` 中的 `clear_sidecar_process()` 使用了同步版（fire-and-forget），因为它在非 async 上下文中运行。问题在于：

- `taskkill /F /T /PID {pid}` 是异步的——子进程可能在 `taskkill` 完成前已经 fork 出新的孙子进程。
- `fire_and_forget` 不检查 `taskkill` 的退出码，无法得知终止是否成功。
- 如果 `taskkill` 失败（如权限不足），孤儿 Daemon 进程会继续占用端口。

### 8.2 修复方案

**Windows 平台：引入 Job Object 绑定**

在 Daemon 子进程启动时，将其加入一个 Windows Job Object，配置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。这样当 Tauri 进程退出（正常或异常）时，操作系统会自动终止所有子进程：

```rust
// process.rs 或 sidecar/connection.rs 中新增
#[cfg(windows)]
pub(crate) fn create_daemon_job_object() -> Result<windows::Win32::System::JobObjects::HANDLE, String> {
    use windows::Win32::System::JobObjects::*;
    use windows::Win32::Foundation::*;
    
    unsafe {
        let job = CreateJobObjectW(None, None)
            .map_err(|e| format!("CreateJobObject failed: {e}"))?;
        
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ).map_err(|e| format!("SetInformationJobObject failed: {e}"))?;
        
        Ok(job)
    }
}
```

在 `start_and_connect_sidecar()` 中，子进程 spawn 后立即调用 `AssignProcessToJobObject(job, child_handle)`。

**非 Windows 平台**：使用 `libc::setpgid` + `libc::killpg` 确保进程组级别的清理。

### 8.3 注意事项

- 需要在 `Cargo.toml` 中添加 `windows` crate 依赖（仅 Windows target）。
- Job Object 句柄需要存储在全局变量中，与 `SIDECAR_PROCESS` 一起管理。
- 如果已经有 `windows` 依赖，复用现有的。

### 8.4 验证

```bash
cargo build --target x86_64-pc-windows-msvc
# 手动测试：启动 Daemon → 强制 kill Tauri 进程 → 检查 Daemon 是否被自动终止
```

---

## 九、任务 B-7/B-8：fs_commands.rs 与 host_openers.rs 拆分

### 9.1 fs_commands.rs 拆分方案

[fs_commands.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/fs_commands.rs) 1,114 行，可分为：

| 子模块 | 行号范围 | 内容 |
|-------|---------|------|
| `fs_commands/types.rs` | L1-L50 | 错误类型、常量、WorkspaceFsGuard |
| `fs_commands/directory.rs` | L68-L200 | `list_directory`, `list_directory_with_guard` |
| `fs_commands/read.rs` | L200-L700 | `read_text_file`, `read_text_file_range`, 编码检测, 二进制检测 |
| `fs_commands/write.rs` | L700-L900 | `write_text_file`, `create_directory` |
| `fs_commands/dialog.rs` | L55-L66 | `select_folder` |
| `fs_commands/mod.rs` | — | barrel 重导出 |

### 9.2 host_openers.rs 拆分方案

[host_openers.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/host_openers.rs) 1,019 行，可分为：

| 子模块 | 行号范围 | 内容 |
|-------|---------|------|
| `host_openers/types.rs` | L1-L110 | 所有类型定义（`HostOpener`, `HostOpenerKind`, `HostOpenTarget` 等） |
| `host_openers/discovery.rs` | L112-L500 | 候选者发现逻辑（`discover_host_openers`, `OpenerCandidate`） |
| `host_openers/resolve.rs` | L500-L700 | 命令解析与目标解析 |
| `host_openers/execute.rs` | L700-L1019 | `workbench_open_host_target`, 打开执行逻辑 |
| `host_openers/mod.rs` | — | barrel 重导出 + Tauri command 函数 |

### 9.3 关键约束

- 每个子文件 ≤ 400 行。
- `#[tauri::command]` 函数保持 `pub(crate)` 可见性。
- `cargo build` 零错误。

---

## 十、任务 B-9：config/mod.rs 拆分

### 10.1 问题现状

`config/mod.rs`（819 行）已有 `credentials.rs`（12,910 字节）、`persistence.rs`（3,850 字节）、`resolution.rs`（3,946 字节）三个子模块。`mod.rs` 中仍然混杂了配置读取、Provider 解析、环境变量过滤等逻辑。

### 10.2 修复方案

从 `mod.rs` 中进一步提取：

| 新子模块 | 要提取的职责 |
|---------|------------|
| `provider.rs` | Provider 选择与 endpoint 解析逻辑 |
| `env_filter.rs` | API key 环境变量名称列表与过滤逻辑 |

目标：`mod.rs` 仅保留公共 API 重导出和 `init_config()` 函数，≤ 300 行。

---

## 十一、任务 B-10：oneshot channel sender 泄漏修复

### 11.1 问题现状

在 `send_sidecar_query_once()` 中（[connection.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/sidecar/connection.rs) L146-L293），创建了 `oneshot::channel()` 并将 `sender` 存入 `PendingSidecarResponse`。

在超时路径（L272-L291）中，调用了 `remove_pending_sidecar_response(request_id)` 来清理 pending 记录。但 `remove` 只是从 `VecDeque` 中移除了 entry，**`sender` 被 drop 时会隐式关闭 channel**——这恰好是正确行为。

**然而**，在正常响应路径中（L219-L229），`resolve_pending_sidecar_response()` 通过 `sender.send(Ok(value))` 完成 channel。如果这个 send 在 `Ok(Ok(value))` 分支中失败（receiver 已被 drop），错误被默默忽略。

**修复**：在 `resolve_pending_sidecar_response()` 中，对 `sender.send()` 的失败路径添加诊断日志，而非静默丢弃。

---

## 十二、任务 B-11~B-17：Rust 工程纪律工具化

### 12.1 B-11：workspace lints 统一

**目标文件**：根 `Cargo.toml`

**配置示例**：
```toml
[workspace.lints.clippy]
unwrap_used = "deny"
expect_used = "deny"
await_holding_lock = "deny"
redundant_clone = "warn"
uninlined_format_args = "warn"
panic = "deny"
print_stdout = "warn"
print_stderr = "warn"
```

然后在每个 crate 的 `Cargo.toml` 中添加：
```toml
[lints]
workspace = true
```

### 12.2 B-12：clippy.toml

**新建文件**：`clippy.toml`

```
allow-unwrap-in-tests = true
allow-expect-in-tests = true
```

### 12.3 B-13：deny.toml

**新建文件**：`deny.toml`

工具链：`cargo install cargo-deny`

配置覆盖三个维度：
- **advisories**：安全漏洞数据库，阻断`high`和`critical`级别
- **licenses**：允许 MIT、Apache-2.0、BSD-2-Clause、BSD-3-Clause、ISC、Unlicense、Zlib；禁止 AGPL、GPL
- **bans**：禁止多版本、重复依赖

### 12.4 B-14：Profile 优化

**目标文件**：根 `Cargo.toml`

添加 profile 配置：
```toml
[profile.release]
lto = "fat"
codegen-units = 1
strip = "symbols"

[profile.profiling]
inherits = "release"
debug = 1

[profile.dev-small]
inherits = "dev"
opt-level = 1
debug = false
```

### 12.5 B-15：SAFETY 注释审计

**操作方式**：`grep -rn "unsafe" crates/ --include="*.rs" | grep -v "test" | grep -v "#\[allow"`

SAFETY 注释模板：
```rust
// SAFETY：<前提条件。例如：调用者保证 bytes 来自有效的 UTF-8 源>
// POST：<后置条件。例如：返回的 &str 的生命周期不超过输入 bytes>
// PANICS：<何时会 panic。例如：当 mmap 文件在读取中被截断时>
```

当前需要添加的有：`conex-search/src/index.rs:25`（from_utf8_unchecked）、`conex-sandbox/src/process_tree.rs:11`（CreateJobObjectW）。

### 12.6 B-16：unwrap 替换

**量化目标**：清零生产代码中的 `.unwrap()` 和 `.expect()`。

排除测试代码（clippy.toml 已配置 `allow-unwrap-in-tests = true`）。

替换模式：
```rust
// 替换前
let val = map.get("key").unwrap();
// 替换后
let val = map.get("key").context("key must exist in config map")?;
```

验证命令：`cargo clippy --all-targets -- -D clippy::unwrap_used -D clippy::expect_used`

### 12.7 B-17：tracing 替代 eprintln!

在根 `Cargo.toml` 中统一引入：
```toml
tracing = { version = "0.1", features = ["attributes"] }
```

替换模式：
```rust
// 替换前
eprintln!("[Sidecar] Error: {}", error);
// 替换后
tracing::error!(target: "sidecar", error = %error, "Daemon process error");
```

验证：`cargo build` 零 warning + GREP 确认生产代码中无 `eprintln!/println!`。

### 12.8 B-18：`version.workspace = true` 版本号继承

**问题**：conex-stream、conex-sandbox、conex-net、conex-fs、conex-db 等子 crate 各自硬编码 `version = "0.1.0"`，与 workspace 根版本不同步。

**修复**：
1. 在根 `Cargo.toml` 的 `[workspace.package]` 中定义 `version = "0.1.0"`
2. 在每个子 crate 的 `Cargo.toml` 中将 `version = "0.1.0"` 替换为 `version.workspace = true`
3. 同时统一 `edition`、`authors`、`license` 等元数据字段

```toml
# 根 Cargo.toml 新增
[workspace.package]
version = "0.1.0"
edition = "2021"
authors = ["Crish Team"]
license = "MIT"
```

```toml
# 各子 crate Cargo.toml 中
[package]
name = "conex-stream"
version.workspace = true
edition.workspace = true
authors.workspace = true
license.workspace = true
```

**验证**：
```bash
cargo metadata --format-version 1 --no-deps | jq '.packages[] | {name, version}'
# 确认所有 crate 版本一致
```

### 12.9 B-19：`rustfmt.toml` `imports_granularity = "Item"` 配置

**新建文件**：`rustfmt.toml`

```toml
imports_granularity = "Item"
group_imports = "StdExternalCrate"
```

强制 Rust 导入格式为每行一个导入项（而非 `use a::{b, c}` 的合并格式），便于代码审查和 Git diff。

**验证**：
```bash
cargo fmt --check
```

### 12.10 B-20：`PendingToolCall` 共享结构体提取

**问题**：`anthropic.rs` 和 `openai_chat.rs` 中各定义了一个语义完全相同的 `PendingToolCall` 结构体 ($S=1.00$)，字段包括 `id`、`name`、`input` 等，用于在流式解析过程中暂存未完成的 Tool Call。

**修复**：将 `PendingToolCall` 提取到 `crates/conex-stream/src/parser/types.rs` 或一个公共模块中，两个 Parser 统一引用。

```rust
// crates/conex-stream/src/parser/types.rs [NEW 或追加]
/// 流式解析中暂存未完成的 Tool Call。
#[derive(Debug, Default, Clone)]
pub(crate) struct PendingToolCall {
    pub id: String,
    pub name: String,
    pub input: String,        // 累积的 JSON 片段
    pub is_complete: bool,
}
```

**验证**：
```bash
cargo build
cargo test -p conex-stream
```

---

## 十三、多 Agent 并行分配方案

```
┌─────────────────────────────────────────────────────────────────┐
│                    Round 2: Layer B                              │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  Agent B1    │  │  Agent B2    │  │  Agent B3    │          │
│  │  connection  │  │  Mutex 审计  │  │  conex-stream│          │
│  │  + commands  │  │  + oneshot   │  │  parser 重构 │          │
│  │  拆分        │  │  修复        │  │              │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  Agent B4    │  │  Agent B5    │  │  Agent B6    │          │
│  │  process.rs  │  │  fs_commands │  │  config/mod  │          │
│  │  Job Object  │  │  + host_open │  │  拆分        │          │
│  │              │  │  拆分        │  │              │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐                             │
│  │  Agent B7    │  │  Agent B8    │                             │
│  │  Cargo.toml  │  │  SAFETY/     │                             │
│  │  clippy.toml │  │  unwrap/     │                             │
│  │  deny.toml   │  │  tracing     │                             │
│  └──────────────┘  └──────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
```

### Agent 互斥边界

| Agent | 独占文件/目录 | 不得修改 |
|-------|-------------|---------|
| B1 | `sidecar/connection.rs`, `sidecar/commands.rs`, `sidecar/mod.rs` | `sidecar/types.rs`, `process.rs`, `conex-stream/` |
| B2 | `sidecar/types.rs`, `sidecar/pending.rs` | `sidecar/connection.rs`, `sidecar/commands.rs` |
| B3 | `crates/conex-stream/src/parser/` 全部文件 | `sidecar/`, `process.rs` |
| B4 | `process.rs` | `sidecar/`, `conex-stream/` |
| B5 | `fs_commands.rs`, `host_openers.rs` | `sidecar/`, `process.rs` |
| B6 | `config/` 目录 | `sidecar/`, `process.rs` |
| B7 | `Cargo.toml`, 新建 `clippy.toml`, 新建 `deny.toml` | 所有业务 `.rs` 文件 |
| B8 | 跨全部 `*.rs` | `Cargo.toml`, `clippy.toml`, `deny.toml` |

---

## 十四、验收标准总表

| 编号 | 检查项 | 验证方式 | 通过条件 |
|-----|--------|---------|---------|
| V-1 | connection.rs 已拆分 | `wc -l sidecar/connection/*.rs` | 每个子文件 ≤ 400 行 |
| V-2 | commands.rs 已拆分 | `wc -l sidecar/commands/*.rs` | 每个子文件 ≤ 400 行 |
| V-3 | std::sync::Mutex 审计完成 | `cargo clippy -- -W clippy::await_holding_lock` | 零 warning |
| V-4 | clear_sidecar_process 修复 | 代码审查确认 `child.wait()` 在 guard drop 之后 | guard scope 不包含阻塞调用 |
| V-5 | Parser feed 去重 | `grep -c "fn feed" crates/conex-stream/src/parser/*.rs` | 仅 trait 定义 + 3 个一行调用 |
| V-6 | anthropic process_event CC | `process_event()` 方法行数 | ≤ 30 行 |
| V-7 | process.rs Job Object | Windows 构建通过 | `cargo build --target x86_64-pc-windows-msvc` |
| V-8 | fs_commands 已拆分 | `wc -l fs_commands/*.rs` | 每个 ≤ 400 行 |
| V-9 | host_openers 已拆分 | `wc -l host_openers/*.rs` | 每个 ≤ 400 行 |
| V-10 | config/mod.rs 瘦身 | `wc -l config/mod.rs` | ≤ 300 行 |
| V-11 | 全局编译 | `cargo build` | 零新增错误 |
| V-12 | Clippy 清洁 | `cargo clippy --all-targets` | 零新增 warning |
| V-13 | Tauri 命令注册 | `grep "generate_handler"` 检查 | 所有拆分后的命令仍被注册 |

---

## 十五、风险与缓解

| 风险 | 概率 | 影响 | 缓解策略 |
|-----|------|------|---------|
| connection.rs 拆分破坏 WS 生命周期 | 中 | 高 | 所有函数签名不变；barrel `pub(crate) use *` 保证消费者零修改 |
| commands.rs 拆分遗漏 generate_handler 注册 | 高 | 高 | Agent B1 必须在拆分后搜索 `generate_handler!` 并更新 import |
| Job Object 方案引入 Windows 特定依赖 | 低 | 中 | 使用 `#[cfg(windows)]` 条件编译，非 Windows 平台使用 `setpgid` 方案 |
| Parser 重构引入 trait 方法调用开销 | 极低 | 低 | `sse_feed` 是 inline 候选函数，编译器会自动内联 |
| Mutex 迁移改变锁公平性语义 | — | — | 审计结论：大部分锁无需迁移，仅修复 `clear_sidecar_process` 的 guard scope |

### 执行顺序建议

```
B2 (Mutex 审计) ───── 独立，可立即启动（仅审计 + 修复 guard scope）
B3 (Parser 重构) ──── 独立，可立即启动（conex-stream crate 无 sidecar 依赖）
B4 (process.rs) ───── 独立，可立即启动
B5 (fs + host) ────── 独立，可立即启动
B6 (config) ────────── 独立，可立即启动
B7 (配置) ──────────── 独立，可立即启动（只改 Cargo.toml/clippy.toml/deny.toml）
B8 (.rs 审计) ──────── 独立，可立即启动（只改 *.rs 文件）
B1 (connection + commands) ─ 依赖 B2 完成后启动（types.rs 可能有 accessor 变更）
```

即 B2/B3/B4/B5/B6/B7/B8 可完全并行，B1 在 B2 完成后启动。
