# 06-Tauri 桌面壳层与原生终端宿主全盘代码与测试审计报告

> **审计执行人**：全盘代码与测试审计师 06（Tauri Desktop Shell & Native ConPTY Host Auditor）  
> **审计范围**：
>
> - `apps/agent-workbench/src-tauri/src/`（`pty/`, `engine_channels.rs`, `process.rs`, `dev_mcp.rs`, `command_manifest.rs`, `core_event_bridge.rs`, `config/`, `run/`, `engine_provider/`, `fs_commands/`, `main.rs`, `lib.rs` 等）
> - `apps/agent-workbench/src-tauri/tests/`（`config_command_names_contract.rs`, `event_bridge_contract.rs`, `lr_t1_memory_prod_ban.rs`, `server_integration.rs` 等）
> - 前端 IPC 交互边界（`apps/crish-desktop/src/api/transport/commandMap.ts`, `commandManifest.ts`, `ptySessionApi.ts`, `ptyRegistry.ts`, `TerminalCard.xterm.tsx`, `command-contract-drift.test.ts` 等）  
>   **审计准则**：`docs/system-audit-and-redesign/00-战役通则与协同执行规范.md`、反过度设计红线、只读审计、零废话、直击根因与代码事实。

---

## 目录

1. [执行概要与系统健康度总评](#一执行概要与系统健康度总评)
2. [Windows 原生 ConPTY 终端宿主全盘深度审计](#二windows-原生-conpty-终端宿主全盘深度审计)
3. [Tauri IPC 通信与权限门禁全盘审计](#三tauri-ipc-通信与权限门禁全盘审计)
4. [死代码、未接线命令与废弃配置接口专项排查](#四死代码未接线命令与废弃配置接口专项排查)
5. [壳层集成测试有效性与盲区批判性审计](#五壳层集成测试有效性与盲区批判性审计)
6. [根因穿透分析与架构重构治理蓝图](#六根因穿透分析与架构重构治理蓝图)

---

## 一、执行概要与系统健康度总评

本次审计对 Conex/Crish 桌面端 Tauri 壳层（`apps/agent-workbench/src-tauri/`）以及前端原生终端适配层（`TerminalCard.xterm.tsx` / `ptySessionApi.ts`）进行了全量源码走查、字节流调度分析与测试有效性穿透审计。

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              Tauri 桌面壳层与原生终端宿主全盘审计总览                                     │
├──────────────────────────────┬───────────────────┬──────────────┬──────────────────────────────────────┤
│ 审计维度                     │ 当前状态          │ 评级         │ 核心缺陷与隐患摘要                   │
├──────────────────────────────┼───────────────────┼──────────────┼──────────────────────────────────────┤
│ 1. Windows 原生 ConPTY 宿主  │ 字节流与生命周期  │ ❌ 严重隐患  │ ① 读线程 8KB chunk 跨边界 UTF-8 截断  │
│    (`pty/session.rs`)        │ 存在截断与失联    │              │    乱码（from_utf8_lossy 注入  乱码）│
│                              │                   │              │ ② resolve_cwd 非法路径未降级致崩溃   │
│                              │                   │              │ ③ workbench_pty_write 同步阻塞主线程 │
│                              │                   │              │ ④ 前端与后端 3 态保活脱节致 2h 误杀  │
│                              │                   │              │ ⑤ process.rs 硬编码 PS 5.1 违背 pwsh │
├──────────────────────────────┼───────────────────┼──────────────┼──────────────────────────────────────┤
│ 2. Tauri IPC 与权限门禁      │ 存在锁抖动与      │ ⚠️ 架构缺陷  │ ① BridgeLiveSink 逐帧双重锁 Mutex     │
│    (`engine_channels.rs`,    │ 假白名单残留      │              │    加剧高频 Token 流调度开销         │
│     `commandMap.ts`)         │                   │              │ ② COMMAND_NAME_ALLOWLIST 仅 13 条    │
│                              │                   │              │    属 WS 遗留假白名单，与 127 命令脱节│
│                              │                   │              │ ③ with_trace_id 仅限 test 编译面     │
│                              │                   │              │ ④ MCP 调试命令未接线（dead_code）    │
├──────────────────────────────┼───────────────────┼──────────────┼──────────────────────────────────────┤
│ 3. 死代码与未接线命令        │ 存在多处僵尸登记  │ ⚠️ 冗余累赘  │ ① 5 条 registered=false 登记先行死命令│
│    (`command_manifest.rs`,   │ 与未用 RPC 接口   │              │ ② core_highlight_code / text_encode  │
│     `config/`, `dev_mcp.rs`) │                   │              │    等 8+ 条命令注册但前端 0 调用     │
│                              │                   │              │ ③ ptyDetach/Attach/Ping 前端全空转   │
├──────────────────────────────┼───────────────────┼──────────────┼──────────────────────────────────────┤
│ 4. 测试套件有效性与盲区      │ 静态文本假安全    │ ⚠️ 虚假覆盖  │ ① pty/mod.rs 仅 NoopMock，0 真实 PTY │
│    (`tests/*.rs`,            │ 缺乏真机集成      │              │ ② contract 测经 #[path] 孤岛编译     │
│     `engine_provider_tests`) │                   │              │ ③ lr_t1 测试仅文本 grep，无持久验证  │
│                              │                   │              │ ④ 缺乏高频并发 IPC 背压 Fuzz 模糊测试 │
└──────────────────────────────┴───────────────────┴──────────────┴──────────────────────────────────────┘
```

---

## 二、Windows 原生 ConPTY 终端宿主全盘深度审计

### 2.1 读线程 8KB Chunk 跨边界 UTF-8 截断导致中文字符与 ANSI 转义乱码

#### 代码事实与位置

- `apps/agent-workbench/src-tauri/src/pty/session.rs:424-462`

```rust
// session.rs:427-460
thread::Builder::new()
    .name(format!("pty-read-{pty_id}"))
    .spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => { ... break; }
                Ok(n) => {
                    if let Ok(reg) = registry().lock() {
                        if let Some(sess) = reg.get(&emit_id) {
                            sess.touch();
                        }
                    }
                    // ❌ 缺陷位置：单次 chunk 直接 lossy 转 String
                    let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app_reader.emit(
                        "workbench://pty-output",
                        PtyOutputEvent {
                            pty_id: emit_id.clone(),
                            data,
                        },
                    );
                }
                Err(e) => { ... break; }
            }
        }
    })
```

#### 缺陷根因与时序危害

1. **多字节 UTF-8 边界切断**：标准中文字符（3 字节，如 `你` = `0xE4 0xBD 0xA0`）、Emoji（4 字节）或复杂的 24-bit TrueColor ANSI 转义序列在高速滚屏输出（如 `cargo build`, `npm install`, `git log`）时，极易被 `reader.read(&mut buf)` 恰好在第 8191 或 8192 字节处切断。
2. **`from_utf8_lossy` 永久损坏**：当一个 3 字节字符的前 2 个字节落在当前 chunk 末尾时，`String::from_utf8_lossy` 判定其为非法 UTF-8，立即替换为 `\u{FFFD}`（``）并作为字符串 emit 到前端；下一个 chunk 读取剩下的 1 个字节时，又再次被判定为孤立非法字节并替换为第二个 `\u{FFFD}`！
3. **不可逆的数据破坏**：一旦被转为 ``，前端 xterm.js 接收到的即为损坏字符，终端出现大量乱码黑块。
4. **架构治理要求**：
   - 方案 A（标准方案）：读线程维持一个 1~~4 字节的跨帧残存缓冲（Incomplete UTF-8 Carry Buffer），使用 `std::str::from_utf8` 仅将完整字符转为 String，将尾部截断的 1~~3 字节保留至下次拼合。
   - 方案 B（终极原生方案）：输出事件改为二进制或 Base64 字节流直接下发，交由前端 `@xterm/xterm` 原生状态机直接解析二进制字节流。

---

### 2.2 `resolve_cwd` 非法路径未降级导致 Windows 子进程拉起崩溃

#### 代码事实与位置

- `apps/agent-workbench/src-tauri/src/pty/session.rs:215-234`

```rust
// session.rs:215-234
fn resolve_cwd(cwd: Option<&str>) -> PathBuf {
    if let Some(raw) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(raw);
        if p.is_dir() {
            return p;
        }
        // ❌ 缺陷位置：若传入的路径不存在（!p.is_dir()），此处竟然无条件直接 return p！
        if !raw.is_empty() {
            return p;
        }
    }
    if let Ok(app) = crate::host_paths::app_dir() {
        let root = crate::host_paths::workspace_root(&app);
        if root.is_dir() {
            return root;
        }
    }
    // FIN-07: 无工作区启动时安全降级为用户目录 (~)，严禁回退到 src-tauri 或 panic
    dirs::home_dir().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}
```

#### 缺陷根因与时序危害

1. **静默旁路回退逻辑**：当前端传入一个不存在的路径（例如用户删除了某项目文件夹，但打开了残留终端 Tab `cwd = "D:\\deleted_workspace"`），第 218 行 `p.is_dir()` 判定为 `false`，但紧接着第 222-224 行 `if !raw.is_empty() { return p; }` 直接将此无效路径返回！
2. **底层 CreateProcessW 失败**：在 `create_session` 中调用 `cmd.cwd(&cwd_path)`，随后 `pair.slave.spawn_command(cmd)` 调用 Windows 原生 `CreateProcessW`。因传入了不存在的 `lpCurrentDirectory`，Windows 报 `ERROR_DIRECTORY_NAME (267)` 或 `ERROR_FILE_NOT_FOUND (2)` 错误。
3. **违背 FIN-07 铁律契约**：代码行注释自称遵守 `FIN-07: 无工作区启动时安全降级为用户目录 (~)`，但上述逻辑彻底击穿了降级链路，导致终端创建直接报错 `pty spawn shell failed`，UI 呈现红色死亡状态。
4. **修复标准**：当 `p.is_dir()` 校验失败时，应记录 warning 并落入下方的 `workspace_root` 或 `dirs::home_dir()` 降级流，严禁直接返回非法路径。

---

### 2.3 `workbench_pty_write` 同步阻塞持有双锁加剧 IPC 调度饥饿

#### 代码事实与位置

- `apps/agent-workbench/src-tauri/src/pty/mod.rs:73-82`
- `apps/agent-workbench/src-tauri/src/pty/session.rs:519-536`

```rust
// mod.rs:73-82
#[tauri::command]
pub(crate) fn workbench_pty_write(pty_id: String, data: String) -> Result<(), CoreError> {
    if data.len() > MAX_WRITE_BYTES {
        return Err(CoreError::InvalidInput(format!(
            "write too large: {} bytes (max {MAX_WRITE_BYTES})",
            data.len()
        )));
    }
    session::write_session(&pty_id, data.as_bytes())
}

// session.rs:519-536
pub(crate) fn write_session(pty_id: &str, data: &[u8]) -> Result<(), CoreError> {
    let reg = registry()
        .lock()
        .map_err(|e| CoreError::Internal(format!("pty registry lock: {e}")))?;
    let session = reg.get(pty_id).ok_or_else(|| not_found_error(pty_id))?;
    session.touch();
    let mut writer = session
        .writer
        .lock()
        .map_err(|e| CoreError::Internal(format!("pty writer lock: {e}")))?;
    writer
        .write_all(data) // 👈 阻塞式 IO
        .map_err(|e| CoreError::Internal(format!("pty write failed: {e}")))?;
    writer
        .flush() // 👈 阻塞式 Flush
        .map_err(|e| CoreError::Internal(format!("pty flush failed: {e}")))?;
    Ok(())
}
```

#### 缺陷根因与时序危害

1. **同步阻塞系统调用**：`workbench_pty_write` 声明为同步 `fn`（非 `async fn`），在 Tauri 的同步命令线程池中执行。
2. **多重锁嵌套与背压阻塞**：函数首先获取全局 `REGISTRY` 互斥锁，接着获取 `session.writer` 互斥锁，最后在持锁状态下调用 `writer.write_all` 和 `writer.flush`。当 Windows ConPTY 管道写缓冲区满（例如子进程处于挂起、正在处理密集计算或暂停读取 stdin），`write_all`/`flush` 将发生系统级阻塞。
3. **全局命令饥饿**：由于持有 `REGISTRY` 锁，期间其他线程发起的任何 `workbench_pty_create`、`workbench_pty_resize`、`workbench_pty_kill` 或 30s GC 协程全部被无辜级联阻塞！

---

### 2.4 前端组件失联：3 态保活状态机与前端 React 钩子彻底脱节

#### 代码事实与位置

- `apps/agent-workbench/src-tauri/src/pty/session.rs:145-162`
- `apps/crish-desktop/src/api/ptySessionApi.ts:170-205`
- `apps/crish-desktop/src/components/workspace/TerminalCard.xterm.tsx:389-402`

#### 缺陷根因与时序分析

1. **Rust 侧的设计意图**：
   - 会话支持 `Active`、`Detached`、`Dead` 三态。
   - 前台 120 秒无活动（`ACTIVE_IDLE_TIMEOUT_MS`）自动降为 `Detached`。
   - `Detached` 态 2 小时（`DETACHED_GC_GRACE_MS = 7,200,000ms`）无 stdout 输出且无连接则 GC 强杀。
   - 暴露了 `workbench_pty_detach`、`workbench_pty_attach`、`workbench_pty_ping` 供前端切换 Tab 和保持心跳。
2. **前端实现的彻底缺位**：
   - 搜索前端全量源码，`ptyDetach`、`ptyAttach`、`ptyPing` 仅在 `ptySessionApi.ts` 进行了空洞封装，**在实际 UI 组件（`TerminalCard.xterm.tsx`）中调用次数为 0**！
   - 当用户在前端打开终端，但超过 2 分钟未按键且无子进程输出时，Rust GC 会直接将状态自动改为 `Detached`。
   - 此时用户依然在看着这个终端 Tab（以为是 Active），若 2 小时内没有产生新输出，30 秒周期的 GC 协程会直接将其强杀，并抛出 `workbench://pty-gc-killed`。
3. **危害总结**：状态机在 Rust 侧“自作多情”，前端“毫不知情”，导致用户终端会话在正常开窗静置状态下发生非预期猝死。

---

### 2.5 `process.rs` 单命令执行器硬编码 Windows PowerShell 5.1 违背全仓 pwsh7 铁律

#### 代码事实与位置

- `apps/agent-workbench/src-tauri/src/process.rs:230-275`
- 对比：`apps/agent-workbench/src-tauri/src/pty/session.rs:238-269`

```rust
// process.rs:257-275
fn resolve_system_powershell() -> Result<String, CoreError> {
    if let Ok(root) = std::env::var("SystemRoot") {
        let candidate = Path::new(&root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe"); // ❌ 优先硬编码 Windows PowerShell 5.1
        if candidate.is_file() {
            return Ok(candidate.display().to_string());
        }
    }
    // PATH 探测
    if which_on_path("powershell.exe") {
        return Ok("powershell.exe".into());
    }
    Err(CoreError::Internal("system powershell.exe not found".into()))
}
```

#### 缺陷根因与架构冲突

1. **口径分裂**：在 `pty/session.rs` 中，交互式终端优先查找 `pwsh` / `pwsh.exe`（PowerShell 7+）；而在 `process.rs` 的单命令执行器（`workbench_run_shell`）中，`resolve_system_powershell` 却优先写死了 `System32\WindowsPowerShell\v1.0\powershell.exe`（PowerShell 5.1）。
2. **GBK 乱码与插值陷阱**：PowerShell 5.1 默认编码受 Windows 区域控制面板（GBK / CP936）支配，对 UTF-8 管道支持极其脆弱，且缺少 PowerShell 7+ 的现代语法特性与跨平台一致性，直接违背了 `AGENTS.md` 和战役通则中“执行环境统一使用 pwsh7”的硬性铁律。

---

## 三、Tauri IPC 通信与权限门禁全盘审计

### 3.1 `BridgeLiveSink` 实时通道逐帧加锁与高频流抖动

#### 代码事实与位置

- `apps/agent-workbench/src-tauri/src/engine_channels.rs:605-670, 695-727`

```rust
// engine_channels.rs:712-720
impl LiveEventSink for BridgeLiveSink {
    fn push_live(&self, event: AgentEvent) {
        let envelope = AgentEventEnvelope::new(event, Some(self.run_id.clone()), None);
        // ① 锁 buffer Mutex，入队
        self.bridge.emit(&envelope);
        // ② 再次锁 buffer Mutex，出队并立即 emit
        self.bridge.flush();
    }
}
```

#### 缺陷根因与性能损耗

1. **伪缓冲架构抖动**：`BufferedRunEventBridge` 本是为低频/批处理设计的带背压缓冲桥（`buffer: Mutex<EventBuffer>`）。但 `BridgeLiveSink` 作为实时双轨（DIM-01）的直接载体，在处理 LLM 输出的每个增量 Token 时，竟然采用“入队立即冲刷”的生硬套用模式。
2. **锁争用放大**：每个 Token 的发射都会经历两次 `Mutex<EventBuffer>` 的获取与释放，伴随一次序列化慢告警检查（`warn_slow_event_serialize`），在高并发或多 Agent 并行运行时产生严重的 CPU 锁争用和微秒级延迟抖动。
3. **架构整洁度违背**：实时流本应通过 `EventBridge` 直接序列化后直投 `Emitter`，强行经过 `EventBuffer` 属于过度设计的历史包袱。

---

### 3.2 前端 `commandMap.ts` 存在 WS 时代遗留的假白名单与漂移风险

#### 代码事实与位置

- `apps/crish-desktop/src/api/transport/commandMap.ts:29-51, 59-61`

```ts
// commandMap.ts:29-51
export const COMMAND_NAME_ALLOWLIST: ReadonlySet<string> = new Set([
  // ── 查询类（core_*）──
  'core_get_status',
  'core_get_run_snapshot',
  'core_read_session_events',
  // ── 审批类（core_*）──
  'core_approve_tool',
  'core_deny_tool',
  'resume_subagent',
  'kill_all',
  'kill_subagent',
  'core_compact_now',
  'core_run_task',
  'core_cancel_run',
  'config_update',
  'list_sessions',
]); // 👈 仅 13 条！

// commandMap.ts:59-61
export function resolveTauriCommand(cmd: string): string | null {
  return isRegisteredCommand(cmd) ? cmd : null; // 👈 实际上使用的是 commandManifest 里的 127 条！
}
```

#### 缺陷根因与认知混淆

1. **形式主义白名单**：`COMMAND_NAME_ALLOWLIST` 中只硬编码了 13 条命令，但真正的命令分发函数 `resolveTauriCommand` 却完全忽略了该集合，直接调用 `isRegisteredCommand(cmd)`（对齐 127 条已注册命令）。
2. **门禁逻辑割裂**：`checkCommandMapConsistency()` 仅用于检查这 13 条白名单是否在 127 条内，导致该文件充斥着大量淘汰的旧注释（如提及“双命名空间已删除”、“WS 消息 type”），给后续维护者造成严重的权限误导。

---

### 3.3 分布式链路追踪 `with_trace_id` 仅存在于测试编译面

#### 代码事实与位置

- `apps/agent-workbench/src-tauri/src/engine_channels.rs:599-603`

```rust
// engine_channels.rs:599-603
#[cfg(test)]
pub(crate) fn with_trace_id(mut self, trace_id: Option<String>) -> Self {
    self.trace_id = trace_id;
    self
}
```

#### 缺陷根因与生产盲区

1. **代码假接线**：`BufferedRunEventBridge` 内部设计了完整的 `trace_id` 注入机制（`self.trace_id` 用于给所有发往前端的信封注入链路追踪 ID），但构造它的 `with_trace_id` 方法被标记为 `#[cfg(test)]`。
2. **生产环境永远为 None**：在所有生产运行路径中，`trace_id` 恒为 `None`，导致所谓“S2 分布式追踪”在生产环境下完全处于断路空转状态。

---

### 3.4 MCP 调试套接字命令处于未接线死代码状态

#### 代码事实与位置

- `apps/agent-workbench/src-tauri/src/dev_mcp.rs:91-98`
- `apps/agent-workbench/src-tauri/src/main.rs:146-463`
- `apps/agent-workbench/src-tauri/src/command_manifest.rs:246`

#### 缺陷还原

1. 在 `dev_mcp.rs` 中定义了 `workbench_dev_mcp_enabled()`，但带有 `#[allow(dead_code)]` 属性。
2. 在 `main.rs` 的 `command_registry!` 宏中，**并未注册** `workbench_dev_mcp_enabled`。
3. 在 `command_manifest.rs` 中，该命令标记为 `registered: false`。
4. 前端代码没有任何业务逻辑调用该接口，该命令纯属未闭环的半成品。

---

## 四、死代码、未接线命令与废弃配置接口专项排查

### 4.1 编译期与运行时死代码清单（只找问题、清理冗余）

经过对 `src-tauri/` 与前端 `crish-desktop/` 的双向交叉比对，识别出以下典型的死代码与冗余接口：

| 序号 | 符号 / 命令名称                       | 文件位置                              | 当前状态                                                | 审计处置建议                        |
| ---- | ------------------------------------- | ------------------------------------- | ------------------------------------------------------- | ----------------------------------- |
| 1    | `workbench_dev_mcp_enabled`           | `dev_mcp.rs:91-98`                    | `#[allow(dead_code)]`，未在 `main.rs` 注册，前端 0 调用 | 彻底拔除或完成实际功能接线          |
| 2    | `core_highlight_code`                 | `markdown_commands.rs`, `main.rs:343` | Rust 注册但前端 Wrapper 已删，列于 `GHOST_EXEMPTIONS`   | 彻底清理 Rust 端实现与注册          |
| 3    | `core_text_encode`                    | `core_commands.rs`, `main.rs:359`     | Rust 注册但前端已由 Web Worker 承接，0 调用             | 彻底拔除或收拢至 Worker 适配器      |
| 4    | `upsert_session_entry`                | `session_commands.rs`, `main.rs:328`  | Rust 注册但前端已全面转向 SQLite/IDB，0 生产调用        | 彻底拔除                            |
| 5    | `workbench_http_request`              | `commands.rs`, `main.rs:211`          | Rust 注册但业务侧无调用点，列于 `GHOST_EXEMPTIONS`      | 彻底拔除                            |
| 6    | `append_session_messages`             | `command_manifest.rs:243`             | `registered: false`，无 Rust 实现，无前端调用           | 从 Manifest 清单中移除              |
| 7    | `workbench_open_workspace`            | `command_manifest.rs:244`             | `registered: false`，无 Rust 实现，无前端调用           | 从 Manifest 清单中移除              |
| 8    | `workbench_list_workspaces`           | `command_manifest.rs:245`             | `registered: false`，无 Rust 实现，无前端调用           | 从 Manifest 清单中移除              |
| 9    | `core_resume_run`                     | `command_manifest.rs:250`             | `registered: false`，无 Rust 实现，无前端调用           | 从 Manifest 清单中移除              |
| 10   | `ptyDetach` / `ptyAttach` / `ptyPing` | `ptySessionApi.ts:170-205`            | 前端导出 TS 方法但在所有 UI 组件中 0 引用               | 完成前端生命周期挂接或简化后端 3 态 |

---

## 五、壳层集成测试有效性与盲区批判性审计

### 5.1 契约测试通过 `#[path]` 孤岛编译制造“虚假绿灯”

#### 代码事实与位置

- `apps/agent-workbench/src-tauri/tests/config_command_names_contract.rs:19-21`
- `apps/agent-workbench/src-tauri/tests/event_bridge_contract.rs:30-31`

```rust
// config_command_names_contract.rs:19-21
#[path = "../src/command_manifest.rs"]
mod command_manifest;

// event_bridge_contract.rs:30-31
#[path = "../src/core_event_bridge.rs"]
mod core_event_bridge;
```

#### 批判性评估

1. **非真实 Crate 集成**：集成测试本应作为外部调用方消费编译好的 `crish-agent-workbench` 库/二进制，但上述测试通过 `#[path]` 强制将单个源文件拉入测试 target 中单独编译。
2. **掩盖装配级缺陷**：这种测试只能验证单文件语法或静态数据结构，无法覆盖 `main.rs` 的状态管理（`app.manage`）、Tauri IPC 宏生成（`__cmd__*`）以及多线程运行时装配的真实问题。

---

### 5.2 缺乏 Windows 原生 ConPTY 真实 I/O 与 Job Object 回归测试

#### 批判性评估

1. **Mock 假象**：`pty/mod.rs` 内部的测试（`adversarial_pty_detached_and_output_keepalive` 等）全部使用 `NoopKiller`、`NoopMaster` 和 `std::io::sink()` 内存模拟。
2. **核心场景零覆盖**：
   - 真实 Windows 下拉起 `pwsh.exe`/`powershell.exe` 是否成功？
   - ConPTY 窗口大小动态调整（`resize`）是否触发 Win32 API 报错？
   - 宿主进程崩溃时 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 是否能 100% 连带杀死子进程树？
   - 多字节 UTF-8 跨 8KB 缓冲区截断是否乱码？
     上述最为关键的原生终端物理行为，在当前的测试矩阵中**覆盖率为 0%**。

---

### 5.3 `lr_t1_memory_prod_ban.rs` 仅为静态文本 Grep 门禁，缺乏运行时持久化断言

#### 批判性评估

1. `lr_t1_memory_prod_ban.rs` 的本质是一个基于代码文本扫描的防君子测试（扫描源码中是否出现字符串 `MemoryNoteBackend`）。
2. 它无法验证在真实运行环境中，当笔记库（`workspace.db`）打开失败时，系统降级到未接线状态的行为是否符合预期，属于低密度的静态防御手段。

---

## 六、根因穿透分析与架构重构治理蓝图

### 6.1 核心架构根因穿透

1. **终端与宿主之间的双向契约断层**：Rust 实现了 3 态生命周期和 GC，前端 React 组件却沿用单向无状态思维，导致保活协议形同虚设；
2. **字节流解码过早介入**：在最底层的 OS 读线程中草率使用 `from_utf8_lossy` 字符串化，破坏了终端字节流的无损性；
3. **命令注册面的历史膨胀与过渡遗留**：从 WebSocket 迁移到 Tauri IPC 后，残留大量未清理的幽灵命令与豁免清单，缺乏单一真源的自动化代码生成机制。

---

### 6.2 综合重构治理路线图（逻辑单元）

#### 任务单元 1：ConPTY 无损字节流与鲁棒降级重构

- **文件域**：`apps/agent-workbench/src-tauri/src/pty/session.rs`, `apps/agent-workbench/src-tauri/src/pty/mod.rs`
- **改造内容**：
  1. **UTF-8 边界缓冲器**：在 `pty-read` 线程中引入 `Utf8ChunkBuffer`，拦截不完整的尾部字节拼合至下一帧，或直接改为二进制分派；
  2. **修复 `resolve_cwd`**：严格执行 `p.is_dir()` 校验，非法路径无条件安全降级为 `workspace_root` 或 `dirs::home_dir()`；
  3. **异步化 `workbench_pty_write`**：写入与 Flush 移入 `spawn_blocking` 或异步通道，消除对 IPC 命令主线程的潜在阻塞；
  4. **对齐 pwsh7**：将 `process.rs` 的单命令执行器重构为与 `pty/session.rs` 一致的 `pwsh.exe` 优先探测逻辑。

#### 任务单元 2：前端 TerminalCard 生命周期与保活协议闭环

- **文件域**：`apps/crish-desktop/src/components/workspace/TerminalCard.xterm.tsx`, `apps/crish-desktop/src/api/ptyRegistry.ts`
- **改造内容**：
  1. 在 `TerminalCard` 卸载/切 Tab 时调用 `ptyDetach(ptyId)`；
  2. 在重新挂载/聚焦时调用 `ptyAttach(ptyId)`；
  3. 挂载期间维持轻量级心跳定时器（例如 60s `ptyPing`），杜绝前台静置会话被 2 小时 GC 误杀。

#### 任务单元 3：Tauri IPC 命令面大扫除与单一真源收敛

- **文件域**：`apps/agent-workbench/src-tauri/src/command_manifest.rs`, `apps/agent-workbench/src-tauri/src/main.rs`, `apps/crish-desktop/src/api/transport/commandMap.ts`
- **改造内容**：
  1. **剔除 5 条先行死命令**：从 Manifest 中彻底移除 `append_session_messages`、`workbench_open_workspace` 等占位符；
  2. **清理 8+ 条幽灵命令**：拔除 `core_highlight_code`、`core_text_encode`、`workbench_http_request` 的 Rust 注册与实现；
  3. **重构 `commandMap.ts`**：废除仅 13 条的旧 `COMMAND_NAME_ALLOWLIST`，统一以 `commandManifest` 为唯一真源。

#### 任务单元 4：高保真原生 ConPTY 集成测试套件建设

- **文件域**：`apps/agent-workbench/src-tauri/tests/pty_integration_tests.rs` (新增)
- **改造内容**：
  1. 编写基于真实 Windows 环境的 ConPTY 集成测试，拉起真实 PowerShell 子进程，验证中文输出、ANSI 颜色、Tab 补全无乱码；
  2. 验证进程崩溃与正常退出时 Windows Job Objects 连带销毁的有效性；
  3. 验证超大吞吐量下的内存与缓冲区背压表现。
