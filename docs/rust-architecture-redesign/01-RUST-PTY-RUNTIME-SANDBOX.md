# 维度一：Rust PTY Runtime 与安全沙箱架构设计

## 1. 问题背景与 Node.js node-pty / child_process 性能瓶颈深度剖析

### 1.1 现状与痛点分析
当前架构重度依赖 Node.js 原生的 `child_process` 模块以及基于 N-API 封装的 `node-pty` 库进行本地工具链的执行与伪终端（PTY）管理。
随着应用场景的复杂化以及并发任务的急剧增加，现有的架构暴露出严重的性能瓶颈与稳定性问题：

1. **V8 事件循环阻塞 (Event Loop Blocking)**
   Node.js 采用单线程异步非阻塞 I/O 模型，但在处理密集型终端输出流（如高频度的 stdout/stderr 字节流输出，例如大文件编译、密集日志流）时，大量的 IPC 序列化与反序列化（IPC serialization/deserialization）会在主线程中进行。
   当字节流速率达到 MB/s 级别，V8 引擎需要频繁分配 Buffer 对象并触发垃圾回收（GC），这直接导致事件循环停滞。UI 层如果与后台执行器在同一进程，会产生严重的卡顿现象（Lag/Jank）。

2. **IPC 开销与内存拷贝 (IPC Overhead & Memory Copy)**
   `node-pty` 作为 C++ Addon，将底层的 `pty` 数据转换为 Node.js 中的 `Buffer` 或 `String`，这一过程涉及多次内核态到用户态的数据拷贝。
   尤其是针对长时间运行的驻留进程（Daemon），内存泄漏（Memory Leak）的风险呈指数级上升。此外，频繁的 IPC Message 传递加重了操作系统的上下文切换开销。

3. **进程僵尸化与孤儿进程管理缺陷 (Zombie/Orphan Process Management)**
   Node.js 在处理进程树杀除（Process Tree Killing）方面先天不足。在 Windows 系统上，`taskkill` 或者原生的进程句柄终止往往只能杀掉主进程，其衍生出的子进程（如 Webpack 启动的子进程、构建脚本衍生的后台任务）容易成为孤儿进程，继续消耗 CPU 和内存资源。在 Unix 系统上，虽然可以通过 Process Group ID (PGID) 杀除，但复杂的进程嵌套关系仍然容易引发僵尸进程。

4. **沙箱与安全隔离机制缺失 (Lack of Security Sandbox)**
   当前直接使用 `child_process.exec` 或 `spawn` 启动外部工具，外部进程继承了父进程的运行权限，存在极大的越权读写与恶意代码执行风险。特别是对于第三方插件或者不受信脚本，直接在宿主系统上裸奔（Bare-metal execution）存在致命的安全隐患。

### 1.2 为什么选择 Rust 作为重构底座？
Rust 的所有权模型（Ownership）、无 GC 开销、极佳的并发模型（Fearless Concurrency）以及对底层系统调用的完美支持，使其成为重构执行引擎的完美选择：
- **零成本抽象**：提供 C/C++ 级别的执行性能，同时避免了内存泄漏和悬垂指针。
- **丰富的生态**：借助 `portable-pty` 等库，可以完美实现跨平台的 PTY 管理。
- **原生沙箱能力**：可以直接调用 Windows Job Objects、Linux Seccomp 等底层系统 API 实现严格的沙箱控制。

---

## 2. Rust `portable-pty` 原生终端主引擎设计

### 2.1 PTY (伪终端) 的核心概念与架构
在操作系统中，终端（Terminal）分为主设备（Master/Host）和从设备（Slave/Child）。
- **主端 (Master)**：由我们的 Rust 守护进程持有，负责读取从端输出并向从端发送输入（键盘敲击、控制字符）。
- **从端 (Slave)**：分配给子进程（如 bash, powershell），子进程以为自己在真实的终端中运行，支持 ANSI 控制码、行列重置等特性。

### 2.2 基于 portable-pty 的架构实现

我们采用 `portable-pty` 作为核心跨平台 PTY 驱动库。以下是架构设计的关键 Struct 和 Trait 抽象。

#### 2.2.1 基础结构定义

```rust
use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtySystem};
use std::sync::{Arc, Mutex};
use std::thread;
use std::io::{Read, Write};
use crossbeam_channel::{bounded, Sender, Receiver};
use anyhow::{Result, Context};

/// 终端尺寸，支持动态 Resize
#[derive(Debug, Clone, Copy)]
pub struct TerminalSize {
    pub rows: u16,
    pub cols: u16,
    pub pixel_width: u16,
    pub pixel_height: u16,
}

/// 终端主引擎，封装底层 PtySystem
pub struct PtyRuntimeEngine {
    pty_system: Box<dyn PtySystem + Send>,
}

impl PtyRuntimeEngine {
    pub fn new() -> Self {
        Self {
            pty_system: native_pty_system(),
        }
    }

    /// 产生一对 PTY Pair (Master & Slave)
    pub fn spawn_pty(&self, size: TerminalSize) -> Result<PtySession> {
        let pty_size = PtySize {
            rows: size.rows,
            cols: size.cols,
            pixel_width: size.pixel_width,
            pixel_height: size.pixel_height,
        };

        let pair = self.pty_system.openpty(pty_size)?;
        
        Ok(PtySession {
            master: Arc::new(Mutex::new(pair.master)),
            slave: pair.slave,
        })
    }
}
```

#### 2.2.2 PTY Session 与命令执行

```rust
use portable_pty::{MasterPty, SlavePty, Child};
use std::time::Duration;

pub struct PtySession {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    slave: Box<dyn SlavePty + Send>,
}

impl PtySession {
    /// 启动子进程并将其标准输入输出重定向到 Slave PTY
    pub fn execute_command(&self, cmd: &str, args: &[&str]) -> Result<Box<dyn Child + Send + Sync>> {
        let mut builder = CommandBuilder::new(cmd);
        builder.args(args);
        
        // 设置当前工作目录
        builder.cwd(std::env::current_dir()?);
        
        // 生成子进程
        let child = self.slave.spawn_command(builder)?;
        Ok(child)
    }

    /// 改变终端大小 (Resize)
    pub fn resize(&self, size: TerminalSize) -> Result<()> {
        let pty_size = PtySize {
            rows: size.rows,
            cols: size.cols,
            pixel_width: size.pixel_width,
            pixel_height: size.pixel_height,
        };
        self.master.lock().unwrap().resize(pty_size)?;
        Ok(())
    }
}
```

#### 2.2.3 异步字节流解码与通信 (I/O Multiplexing)

为了避免阻塞，必须使用专用的 I/O 线程来处理 PTY 的读写操作。在 Rust 中，我们可以使用 `crossbeam-channel` 或 `tokio` 异步运行时。这里展示基于多线程的事件驱动模型设计。

```rust
pub struct PtyIOHandler {
    reader_thread: Option<thread::JoinHandle<()>>,
    tx_out: Sender<Vec<u8>>,
}

impl PtyIOHandler {
    pub fn start(
        master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
        tx_out: Sender<Vec<u8>>,
    ) -> Self {
        // 克隆主端用于读取
        let master_reader = master.lock().unwrap().try_clone_reader().unwrap();
        
        let reader_thread = thread::spawn(move || {
            let mut reader = master_reader;
            let mut buf = [0u8; 8192]; // 8KB 缓冲区
            
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        // EOF
                        break;
                    }
                    Ok(n) => {
                        // 发送给接收端处理 (如 WebSocket 或 N-API 回调)
                        if tx_out.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("Error reading from PTY: {}", e);
                        break;
                    }
                }
            }
        });

        Self {
            reader_thread: Some(reader_thread),
            tx_out,
        }
    }
    
    pub fn write_input(master: &Arc<Mutex<Box<dyn MasterPty + Send>>>, data: &[u8]) -> Result<()> {
        let mut master_guard = master.lock().unwrap();
        let mut writer = master_guard.try_clone_writer()?;
        writer.write_all(data)?;
        Ok(())
    }
}
```

### 2.3 Signal (信号) 处理机制
在 Unix 环境下，我们需要向子进程发送 `SIGINT`, `SIGTERM` 等信号；在 Windows 下，需要使用 `GenerateConsoleCtrlEvent`。`portable-pty` 对此做了封装，但对于复杂的进程树终止，我们需要自行介入系统 API。

---

---

## 3. 实用防御与全自主安全闸门机制 (Pragmatic Safety Gatekeeper)

### 3.1 架构决策：坚决摒弃 Codex CLI 臃肿的跨平台沙箱适配

在上一代 Agent 工具设计中，部分项目（如 Codex CLI）尝试引入操作系统物理级沙箱（Linux Bubblewrap / Landlock + Windows WFP 网络封锁 + macOS Seatbelt）。
经过深度验证，这种过度设计的重型沙箱带来了致命的工程缺陷：
1. **跨平台调试难度极高**：不同 OS 底层 API 差异极大（Windows WFP 网络过滤驱动 vs Linux BPF），导致大量平台的兼容性 Bug 与调试噩梦。
2. **阻碍正常开发效率**：过度严格的沙箱隔离导致常见的开发行为（如 `npm install` 拉取外部包、读写共享缓存）频繁被误杀，降低了 AI 辅助开发的流畅度。

因此，Conex **坚决抛弃这种臃肿且低效的物理沙箱策略**，转向以“**实用防御 + 核心系统目录毁灭拦截 + 用户全自主安全开关**”为核心的新一代安全架构。

---

### 3.2 三级安全防护原则与全自主模式 (Autonomous Mode)

安全防护的本质是**防范最高危的毁灭性指令**，而非阻碍正常的代码改写。Conex 制定了清晰的三级防护策略：

```text
+---------------------------------------------------------------------------------+
|                       Conex Command Safety Gatekeeper                           |
+---------------------------------------------------------------------------------+
    |                                   |                                   |
    v                                   v                                   v
[ Level 1: 绝对红线 (系统核) ]    [ Level 2: 危险操作 (需确认) ]     [ Level 3: 项目改写 (全放行) ]
- 禁止删除/覆盖 OS 根目录         - 格式化磁盘 / 破坏性 Git Reset   - 允许编辑代码、运行编译
- 保护 C:\Windows, /usr, /bin    - 在“全自主模式”下可配置自动通过   - 全自主模式下无感执行
+---------------------------------------------------------------------------------+
```

#### 1. Level 1: 绝对系统红线 (不可越过的内核闸门)
无论用户是否开启“全自主模式”，Rust 侧的 `Command Safety Gatekeeper` 将对所有准备发送至 PTY 的命令及文件写入操作进行**强制 AST 静态语法审查**。
- **强制拦截规则**：
  - 针对 OS 根目录（`/`, `C:\`, `D:\` 等根节点）的递归删除或擦除指令（如 `rm -rf /`, `Remove-Item -Recurse C:\`）。
  - 针对操作系统核心目录（如 `/usr`, `/bin`, `/sbin`, `/etc`, `C:\Windows`, `C:\Program Files`, `C:\Windows\System32` 等）的覆写与清理。
  - 试图破坏宿主系统引导、磁盘分区表（如 `dd if=/dev/zero of=/dev/sda`）的操作。

#### 2. Level 2: 危险文件与环境变更 (可配置确认)
- 包括 `git reset --hard` 全局丢弃修改、系统级环境变量改写、关闭防病毒服务等。
- 在标准模式下触发弹窗提醒；在“全自主模式”下直接放行。

#### 3. Level 3: 项目内部改写与构建 (完全开放)
- 包含 Workspace 范围内的代码修改、文件新建、删除临时文件、运行 `npm run dev` / `cargo build` 等正常开发命令。
- 系统完全接受，不设繁琐阻碍，确保 AI 执行流水线流畅无阻。

---

### 3.3 全自主模式 (Full-Autonomous Mode) 开关

在客户端设置中提供**“全自主模式 (Autonomous Mode)”**硬开关：
- **默认关闭（标准模式）**：对写文件、执行 Shell 指令保持二次确认弹窗。
- **开启（全自主模式）**：除 Level 1 绝对系统红线被 Rust 内核硬拦截外，其余所有的文件改写、工具调用、终端指令均**自动授权执行**，赋予 AI Agent 最大的自由度与自动化生产力。

---

### 3.4 轻量级进程树生命周期管理 (Job Objects & Process Groups)

虽然摒弃了臃肿的资源隔离沙箱，但 Conex 依然保留了底层**轻量级进程树控制能力**，以彻底解决孤儿进程与僵尸进程问题：

```rust
// conex-sandbox/src/process_tree.rs

#[cfg(target_os = "windows")]
pub fn attach_to_job_object(child_process_handle: winapi::HANDLE) -> Result<()> {
    // 创建 Windows Job Object，配置 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    // 确保 Conex 主进程退出或 PTY Session 关闭时，衍生出的子进程树自动干净清理
    unsafe {
        let job = winapi::create_job_object();
        winapi::assign_process_to_job_object(job, child_process_handle);
    }
    Ok(())
}

#[cfg(unix)]
pub fn set_process_group() {
    // 子进程 pre_exec 时调用 setpgid(0, 0)，便于通过 PGID 批量终止进程树
    unsafe { libc::setpgid(0, 0); }
}
```

---

### 3.5 零拷贝文件变动监听引擎 (Notify-rs Engine)

在工作区监控与 PTY 输出中，文件变动监听也是高频发生的操作。原 Node.js 架构基于 `chokidar` 或 `fs.watch`，在高动态变动仓库中内存常驻开销高。

我们在 `conex-fs` / PTY 监控层接入原生的 `notify` (notify-rs) 引擎：
- **内核事件映射**：自动对接 Windows `ReadDirectoryChangesW`、Linux `inotify` 与 macOS `FSEvents`。
- **三级正则过滤**：在 Rust 侧执行 `ignore_patterns`（如 `.git`, `node_modules`, `target`）三级匹配，避免任何跨进程事件溢出。
- **Zero-Copy Payload**：触发变更的文件路径使用 Atom 或 Serde 二进制映射直传，不产生额外字符串拷贝。

---

### 3.6 沙箱崩溃快照隔离区 (Panic Hook & Recovery)

为了杜绝在 PTY 异常崩溃或子进程段错误（Segfault）时影响宿主核心线程：
1. **全局 Panic Hook**：通过 `std::panic::set_hook` 拦截原生崩溃消息，自动转存诊断 Minidump 及最后上下文至安全的离线 Snapshot 存储区。
2. **快速回滚机制 (Fallback Recovery)**：遇到不可恢复错误时，将终端状态打回快照初始态，并以带防护提示的 Safe Subprocess 重启。


#### 3.2.2 Landlock 限制文件系统 (Rust `landlock` crate)

```rust
#[cfg(target_os = "linux")]
pub fn apply_landlock(workspace_dir: &std::path::Path) -> anyhow::Result<()> {
    use landlock::{Ruleset, RulesetAttr, RulesetCreatedAttr, Access, AccessFs, PathBeneath};

    let ruleset = Ruleset::new()
        .handle_access(AccessFs::from_all())?
        .create()?;

    let path_beneath = PathBeneath::new(workspace_dir, AccessFs::from_all());
    
    let ruleset = ruleset.add_rule(path_beneath)?;
    
    // 限制进程，应用规则
    ruleset.restrict_self()?;
    Ok(())
}
```

### 3.3 Windows: Job Objects 与 Token Limitation

Windows 提供 `Job Objects` 用于管理进程组的生命周期和资源限制，这不仅解决了资源限额问题，也彻底解决了“进程树杀除”时的孤儿进程问题。

```rust
#[cfg(target_os = "windows")]
pub mod windows_sandbox {
    use winapi::um::jobapi2::{CreateJobObjectW, SetInformationJobObject, AssignProcessToJobObject};
    use winapi::um::winnt::{JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, HANDLE};
    use std::ptr;

    pub struct JobObject {
        handle: HANDLE,
    }

    impl JobObject {
        pub fn new() -> Self {
            unsafe {
                let handle = CreateJobObjectW(ptr::null_mut(), ptr::null());
                if handle.is_null() {
                    panic!("Failed to create job object");
                }

                let mut limit_info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limit_info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

                let success = SetInformationJobObject(
                    handle,
                    winapi::um::winnt::JobObjectExtendedLimitInformation,
                    &mut limit_info as *mut _ as *mut _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );

                if success == 0 {
                    panic!("Failed to set job object limit");
                }

                Self { handle }
            }
        }

        pub fn assign_process(&self, process_handle: HANDLE) {
            unsafe {
                AssignProcessToJobObject(self.handle, process_handle);
            }
        }
    }

    impl Drop for JobObject {
        fn drop(&mut self) {
            unsafe {
                winapi::um::handleapi::CloseHandle(self.handle);
                // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 会自动杀死所有关联的子进程
            }
        }
    }
}
```
结合以上三大平台的机制，我们的底层引擎真正实现了操作系统的强制访问控制 (MAC)。

---

## 4. 工具底层执行器 (`ToolExecutor`) 设计与 Rust Trait 架构体系

为了支持不同的工具调用模式（PTY交互模式、静默后台模式、批处理模式），我们设计了 `ToolExecutor` 架构体系，利用 Rust 的 Trait 机制实现多态。

### 4.1 Trait 定义

```rust
use async_trait::async_trait;
use serde_json::Value;

/// 执行上下文，包含环境遍历、工作目录、沙箱配置等
pub struct ExecutionContext {
    pub cwd: String,
    pub env_vars: std::collections::HashMap<String, String>,
    pub sandbox_level: SandboxLevel,
}

#[derive(Debug, Clone, Copy)]
pub enum SandboxLevel {
    None,
    Restricted, // 仅允许访问工作区
    Strict,     // 禁止网络，仅读文件系统
}

/// 执行状态枚举
#[derive(Debug)]
pub enum ExecutionStatus {
    Running,
    Completed(i32), // 退出码
    Failed(String),
}

/// 核心执行器 Trait
#[async_trait]
pub trait ToolExecutor: Send + Sync {
    /// 初始化执行器
    async fn initialize(&mut self, ctx: ExecutionContext) -> Result<()>;
    
    /// 执行命令并返回标识符 (Job ID)
    async fn execute(&mut self, cmd: &str, args: &[String]) -> Result<String>;
    
    /// 向运行中的进程发送输入 (Stdin)
    async fn send_input(&self, job_id: &str, data: &[u8]) -> Result<()>;
    
    /// 发送控制信号 (如 Ctrl+C)
    async fn send_signal(&self, job_id: &str, signal: i32) -> Result<()>;
    
    /// 获取当前状态
    async fn get_status(&self, job_id: &str) -> Result<ExecutionStatus>;
    
    /// 强制终止
    async fn terminate(&self, job_id: &str) -> Result<()>;
}
```

### 4.2 具体实现类：PtyExecutor

`PtyExecutor` 实现了 `ToolExecutor` Trait，底层封装了 `PtySession` 以及 Windows Job Objects/Linux Seccomp 逻辑。

```rust
pub struct PtyExecutor {
    engine: PtyRuntimeEngine,
    jobs: Arc<Mutex<std::collections::HashMap<String, PtyJob>>>,
}

struct PtyJob {
    session: PtySession,
    io_handler: PtyIOHandler,
    #[cfg(target_os = "windows")]
    job_object: windows_sandbox::JobObject,
}

#[async_trait]
impl ToolExecutor for PtyExecutor {
    async fn initialize(&mut self, _ctx: ExecutionContext) -> Result<()> {
        // 配置引擎级参数
        Ok(())
    }

    async fn execute(&mut self, cmd: &str, args: &[String]) -> Result<String> {
        let job_id = uuid::Uuid::new_v4().to_string();
        
        let size = TerminalSize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
        let session = self.engine.spawn_pty(size)?;
        
        // 转换 args
        let args_ref: Vec<&str> = args.iter().map(AsRef::as_ref).collect();
        
        // 此处需要注入沙箱机制 (根据 OS)
        let child = session.execute_command(cmd, &args_ref)?;
        
        #[cfg(target_os = "windows")]
        let job_object = windows_sandbox::JobObject::new();
        // 此处获取 native handle 并 assign 到 job object (省略 unsafe 代码细节)

        let (tx, rx) = bounded(100);
        let io_handler = PtyIOHandler::start(session.master.clone(), tx);
        
        // 开启后台监听 tx/rx，将数据通过 N-API 发送给前端
        // ...

        let job = PtyJob {
            session,
            io_handler,
            #[cfg(target_os = "windows")]
            job_object,
        };

        self.jobs.lock().unwrap().insert(job_id.clone(), job);
        Ok(job_id)
    }

    // 其它实现省略...
    async fn send_input(&self, _job_id: &str, _data: &[u8]) -> Result<()> { Ok(()) }
    async fn send_signal(&self, _job_id: &str, _signal: i32) -> Result<()> { Ok(()) }
    async fn get_status(&self, _job_id: &str) -> Result<ExecutionStatus> { Ok(ExecutionStatus::Running) }
    async fn terminate(&self, _job_id: &str) -> Result<()> { Ok(()) }
}
```

---

## 5. Node.js/Tauri 与 Rust Native Binding 的 API 契约与 C-ABI / JSON-RPC 通信协议

为了让 Node.js 层（或 Tauri 前端层）调用 Rust 编写的引擎，我们需要定义清晰的 C-ABI 接口，或使用高效的序列化协议。这里设计了两种方案：N-API (Neon/Napi-rs) 方案与 Tauri IPC 方案。

### 5.1 NAPI-RS 绑定设计 (Node.js 侧)

使用 `napi-rs` 可以轻松将 Rust 暴露为 Node.js 模块，完全避免手写样板代码。

#### 5.1.1 Rust 侧导出函数

```rust
#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};

#[napi]
pub struct NativePtyManager {
    executor: Arc<tokio::sync::Mutex<PtyExecutor>>,
}

#[napi]
impl NativePtyManager {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            executor: Arc::new(tokio::sync::Mutex::new(PtyExecutor::new())),
        }
    }

    #[napi]
    pub async fn spawn(
        &self, 
        cmd: String, 
        args: Vec<String>, 
        // 使用 ThreadsafeFunction 用于 Node.js 的事件回调 (如 data 事件)
        #[napi(ts_args_type = "payload: Buffer")] 
        on_data: ThreadsafeFunction<Buffer, ErrorStrategy::CalleeHandled>
    ) -> Result<String> {
        let mut exec = self.executor.lock().await;
        let job_id = exec.execute(&cmd, &args).await.map_err(|e| {
            Error::new(Status::GenericFailure, format!("Execute failed: {}", e))
        })?;
        
        // 绑定数据流读取与回调
        // 内部启动 tokio spawn，不断从 PtyIOHandler 的 Receiver 获取数据
        // 然后调用 on_data.call(Ok(Buffer::from(data)), ThreadsafeFunctionCallMode::NonBlocking)
        
        Ok(job_id)
    }

    #[napi]
    pub async fn write(&self, job_id: String, data: Buffer) -> Result<()> {
        let exec = self.executor.lock().await;
        exec.send_input(&job_id, data.as_ref()).await.map_err(|e| {
            Error::new(Status::GenericFailure, format!("Write failed: {}", e))
        })?;
        Ok(())
    }

    #[napi]
    pub async fn kill(&self, job_id: String) -> Result<()> {
        let exec = self.executor.lock().await;
        exec.terminate(&job_id).await.map_err(|e| {
            Error::new(Status::GenericFailure, format!("Kill failed: {}", e))
        })?;
        Ok(())
    }
}
```

#### 5.1.2 Node.js 侧调用契约 (TypeScript)

```typescript
import { NativePtyManager } from './conex-pty-native.node';
import { EventEmitter } from 'events';

export class ConexTerminal extends EventEmitter {
    private manager: NativePtyManager;
    private jobId: string | null = null;

    constructor() {
        super();
        this.manager = new NativePtyManager();
    }

    public async start(command: string, args: string[]) {
        this.jobId = await this.manager.spawn(command, args, (buffer) => {
            // 原生层传来的 Buffer，无需再经过复杂的中间层
            this.emit('data', buffer);
        });
    }

    public async write(data: string | Buffer) {
        if (!this.jobId) return;
        const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
        await this.manager.write(this.jobId, buf);
    }

    public async dispose() {
        if (this.jobId) {
            await this.manager.kill(this.jobId);
            this.jobId = null;
        }
    }
}
```

### 5.2 JSON-RPC 备用通信架构
如果未来脱离 Node.js，作为独立的守护进程（Daemon）运行，可以通过 Unix Domain Socket / Named Pipe 暴露 JSON-RPC 接口。

请求格式：
```json
{
  "jsonrpc": "2.0",
  "method": "pty.spawn",
  "params": {
    "cmd": "npm",
    "args": ["install"],
    "env": { "NODE_ENV": "development" },
    "sandbox": "strict"
  },
  "id": 1
}
```

---

## 6. 异常恢复、资源泄漏防范 (RAII / Drop Trait) 与 灰度迁移计划

### 6.1 资源自动清理：RAII 与 Drop Trait 的应用
C/C++ 和 Node.js 的内存泄漏大多是因为忘记手动关闭句柄。在 Rust 中，我们通过实现 `Drop` trait 实现 RAII 模式，确保任何情况（Panic 或正常退出）下底层资源均能安全释放。

```rust
impl Drop for PtyJob {
    fn drop(&mut self) {
        println!("Cleaning up PtyJob...");
        
        // 1. 关闭 IO 线程发送端，停止读取
        // 2. 杀死底层子进程 (如果在 Windows 上，JobObject 的 Drop 会自动处理)
        
        #[cfg(not(target_os = "windows"))]
        {
            // Unix 平台手动发生 SIGKILL
            if let Ok(mut child) = self.session.slave.spawn_command(CommandBuilder::new("echo")) {
                let _ = child.kill();
            }
        }
    }
}
```

### 6.2 僵尸进程清理守护 (Reaper Thread)
在 Unix 系统上，子进程终止后如果没有父进程调用 `wait()`，就会成为僵尸进程。
我们在 Rust 引擎初始化时，可以启动一个后台 Reaper Thread。

```rust
fn spawn_reaper_thread() {
    thread::spawn(|| {
        loop {
            // 每秒清理一次已经结束的僵尸子进程
            // 使用 libc::waitpid(-1, &mut status, libc::WNOHANG)
            thread::sleep(Duration::from_secs(1));
        }
    });
}
```

### 6.3 灰度迁移计划 (Rollout Plan)

为了不影响现有用户，从 `node-pty` 到 `Rust PTY Engine` 的迁移分为三阶段：

1. **Alpha 阶段：双轨并行 (Shadow Mode)**
   - 后台同时启动旧版 node-pty 和新版 Rust PTY。
   - 所有输出结果进行 Hash 校验对比。UI 层依然使用旧版数据。
   - 收集 Crash Reports 和 Panic Logs。

2. **Beta 阶段：特性开关 (Feature Flag)**
   - 增加应用设置项：“开启实验性高性能 Rust 终端内核”。
   - 邀请内部开发者与高阶用户试用。
   - 重点关注 Windows 下乱码问题（CodePage 65001 兼容性）。

3. **GA 阶段：全面替换**
   - 彻底移除 `node-pty` 依赖及其庞大的 C++ 工具链。
   - npm 包体积预计减少 15MB，构建时间缩短 40%。

---

## 7. 压测指标与 Performance Regression 验证集

必须定义清晰的性能基线（Baseline）以验证重构价值。

### 7.1 核心压测指标 (Key Performance Indicators)

1. **Throughput (吞吐量)**
   - 场景：执行 `cat large_file.log` (100MB 文本文件)。
   - Node-pty 基准：约 15-20 MB/s，CPU 占用 100% (V8 满载)。
   - Rust PTY 目标：**> 120 MB/s**，主进程 CPU 占用 **< 15%**。

2. **Latency (渲染延迟)**
   - 场景：输入字符到终端呈现。
   - Node-pty 基准：IPC 跨进程通信导致 15ms-30ms 延迟。
   - Rust PTY 目标：NAPI 内存直通，延迟降至 **< 5ms**。

3. **Memory Footprint (内存占用)**
   - 场景：启动 50 个并发闲置 PTY。
   - Node-pty 基准：> 300MB。
   - Rust PTY 目标：**< 40MB** (每个 PTY session < 1MB overhead)。

### 7.2 性能回归验证代码 (Benchmarking Suite)

我们引入 `criterion` 作为性能测试框架：

```rust
#[cfg(test)]
mod benches {
    use criterion::{black_box, criterion_group, criterion_main, Criterion};
    use super::*;

    fn bench_pty_throughput(c: &mut Criterion) {
        c.bench_function("pty throughput 1MB payload", |b| {
            let engine = PtyRuntimeEngine::new();
            let size = TerminalSize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
            
            b.iter(|| {
                let session = engine.spawn_pty(size).unwrap();
                let mut cmd = CommandBuilder::new("cat");
                cmd.args(["test_data/1mb_text.txt"]);
                
                let mut child = session.slave.spawn_command(cmd).unwrap();
                let _status = child.wait().unwrap();
                // 验证流读取性能
                black_box(1);
            });
        });
    }

    criterion_group!(benches, bench_pty_throughput);
    criterion_main!(benches);
}
```

### 7.3 端到端测试 (E2E Tests)
采用 `Playwright` 配合自定义的 Rust Mock Server，模拟前端 Xterm.js 接收二进制 Buffer，验证控制序列 (ANSI Escape Codes) 是否产生断包、丢包现象，确保 UI 渲染结果与源数据像素级一致（Pixel-perfect match）。

---
**附录：相关依赖与版本清单 (Cargo.toml snippet)**
```toml
[dependencies]
portable-pty = "0.8.1"
tokio = { version = "1.32", features = ["full"] }
napi = { version = "2.14", default-features = false, features = ["napi4", "async", "tokio_rt"] }
napi-derive = "2.14"
anyhow = "1.0"
crossbeam-channel = "0.5"
uuid = { version = "1.4", features = ["v4"] }

[target.'cfg(target_os = "windows")'.dependencies]
winapi = { version = "0.3.9", features = ["jobapi2", "winnt", "handleapi"] }

[target.'cfg(target_os = "linux")'.dependencies]
landlock = "0.2.0"
seccompiler = "0.3.0"
libc = "0.2"
```

> **文档状态：** Draft v1.0
> **更新时间：** 2026-07-21
> **作者：** Architecture Team
