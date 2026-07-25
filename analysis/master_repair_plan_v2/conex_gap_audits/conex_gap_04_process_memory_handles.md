# Conex Architecture Gap Audit Report 04: Process, Memory, SQLite & Handle Lifecycle Domain
**文档编号**: `CONEX-GAP-AUDIT-04`  
**审计模块**: `crates/conex-sandbox`, `crates/conex-db`, `crates/conex-compaction`, `packages/agent-runtime`, `packages/agent-daemon`, `apps/crish-desktop`  
**基准对照**: `C:\Software\conex\analysis\reference_patch_audits\` (标杆补丁报告 01~06)  
**审计状态**: Complete  

---

## 1. Executive Summary & Audit Scope

本报告针对 Conex 代码库在 **进程树治理（Process Tree & Job Objects）**、**SQLite 数据库锁与持久化（WAL & Lock Backoff）**、**长会话内存回收与垃圾 GC 回调（Memory & GC Leaks）** 以及 **命令行/PTY 交互卡死防护（Non-Interactive Env Injection）** 四大核心底层工程领域进行了全量审计。

对照 VS Code、Claude Code、Cline、OpenCode、Coder 等标杆开源项目及 6 份标杆补丁报告，Conex 架构在资源生命周期管理方面暴露出了多项严重的设计缺陷与隐患：

1. **Windows 进程树泄漏**：Rust `conex-sandbox` 中的 `attach_to_job_object` 处于**彻底未被调用的死代码状态**，且存在 Handle 泄漏；Node.js `process-executor.ts` 的 Windows 进程终止逻辑缺乏两阶段优雅降级（直喷 `taskkill /F`），而 `background-command.ts` 的 `BoundedMap` 在容量满淘汰旧任务时**完全未清理/未终止底层正在运行的子进程**。
2. **SQLite 锁死与死锁隐患**：`crates/conex-db` 虽配置了 `WAL` 与 `busy_timeout = 5000`，但**全库缺少 `SQLITE_BUSY` 指数退避重试机制**；同时事务使用默认的 `BEGIN TRANSACTION`（Deferred 模式），在多并发写场景下极易触发 `SQLITE_BUSY_SNAPSHOT` 升级死锁。
3. **长会话内存与 GC 机制缺失**：TypeScript `agent-runtime` 缺乏工具原始输出（如大文件 `read_file`、Shell stdout）的 LRU 剥离与 Payload 外部化机制；每一轮 Session Loop 均深度深拷贝重复的 Message 数组；缺乏显式的垃圾回收回调（`global.gc?.()`）；Rust `conex-compaction` 在压缩时对整个消息列表做全量 `Message.clone()`，且未调用 `shrink_to_fit()` 释放 Capacity。
4. **命令行交互卡死隐患**：`process-executor.ts` 的 `createGuardedProcessEnv` 与 `buildWindowsPowerShellScript` **完全未注入 `CI=true`、`GIT_TERMINAL_PROMPT=0`、`PIP_NO_INPUT=1` 等非交互环境变量**，导致 `git clone` / `npm` / `pip` 等工具遇到凭据或确认提示时在非交互 Stdin 下永久挂起。

---

## 2. Audit Domain 1: Windows Subprocess & PTY Cleanup (Job Objects & 2-Phase ProcessTreeKiller)

### 2.1 缺陷诊断与现场代码分析

#### 缺陷 1.1: `attach_to_job_object` 处于未调用死代码状态且 Handle 逻辑有误
* **源码位置**: [`crates/conex-sandbox/src/process_tree.rs:5-57`](file:///C:/Software/conex/crates/conex-sandbox/src/process_tree.rs#L5-L57)
* **现场代码**:
```rust
#[cfg(target_os = "windows")]
pub fn attach_to_job_object(
    process_handle: std::os::windows::io::RawHandle,
) -> Result<()> {
    unsafe {
        let job = windows_sys::Win32::System::JobObjects::CreateJobObjectW(ptr::null_mut(), ptr::null_mut());
        // ... 配置 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE ...
        let ret = windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(job, process_handle);
        // ...
        Ok(())
    }
}
```
* **缺陷剖析**:
  1. **代码完全未接入**: 全库 Grep 结果显示 `attach_to_job_object` 仅存在于 `process_tree.rs` 声明中，在 `pty.rs` 或 `agent-daemon` / `agent-runtime` 中**零调用**。
  2. **Raw Handle 泄漏与生命周期错位**: 函数内部创建了 `job` 句柄（`HANDLE`），在成功时直接返回 `Ok(())`，未将 `job` 保存至结构体中，也未返回给调用方。在 Windows API 中，若 Job Object 句柄在父进程中被隐式关闭，且没有其他句柄维持，Job Object 限制将失效；若不关闭则造成句柄泄漏。
  3. **后果**: 当 Conex 宿主进程崩溃、被任务管理器强制结束或异常退出时，其派生的 Node/Python/Git 等所有子进程树无法依靠 Windows OS 自动回收，成为系统孤儿进程（Orphan Processes），继续占用端口与文件句柄。

#### 缺陷 1.2: 缺乏两阶段 ProcessTreeKiller 优雅降级机制
* **源码位置**: [`packages/agent-runtime/src/process-lifecycle/process-executor.ts:370-417`](file:///C:/Software/conex/packages/agent-runtime/src/process-lifecycle/process-executor.ts#L370-L417)
* **现场代码**:
```typescript
function terminateProcessTree(child: ChildProcess): ProcessTerminationDiagnostic[] {
  if (process.platform === "win32") {
    const diagnostics = [terminateWindowsProcessTree(child.pid)];
    const taskkill = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5_000
    });
    return diagnostics;
  }
  // Unix 路径...
}
```
* **缺陷剖析**:
  1. **Windows 下直接硬杀死 (`/F`)**: 当 `killProcessTree` 为 true 时，Windows 分支先启动 PowerShell 遍历 `Win32_Process`，紧接着直接执行 `taskkill.exe /PID <pid> /T /F`（强制终止）。完全没有给子进程（如正在写入磁盘的 git / node / compiler 进程）发送 `SIGINT` / `WM_CLOSE` / `CTRL_BREAK_EVENT` 优雅退出的时间。
  2. **PowerShell 遍历性能极差**: `terminateWindowsProcessTree` 每次终止进程都会硬弹一个 `powershell.exe` 子进程去运行 `Get-CimInstance Win32_Process`，在 Windows 上消耗 1.5 ~ 3 秒，造成系统卡顿。
  3. **Unix 下缺乏进程组防护降级**: Unix 分支调用 `process.kill(-child.pid, "SIGTERM")`，但若 `child.pid` 不是 process group leader（未设置 `detached: true`），`process.kill` 会直接抛错并回退到仅 kill 单子进程，遗留孙子进程。

#### 缺陷 1.3: `BackgroundCommandManager` 的 `BoundedMap` 容量淘汰导致后台进程无限泄漏
* **源码位置**: [`packages/agent-runtime/src/background-command.ts:111-145`](file:///C:/Software/conex/packages/agent-runtime/src/background-command.ts#L111-L145) 及 [`packages/shared-utils/src/bounded-map.ts:48-58`](file:///C:/Software/conex/packages/shared-utils/src/bounded-map.ts#L48-L58)
* **现场代码**:
```typescript
// background-command.ts
private readonly tasks = new BoundedMap<string, BackgroundCommandRecord>(MAX_BACKGROUND_TASKS); // 200

// bounded-map.ts
set(key: K, value: V): this {
  if (!this.map.has(key) && this.map.size >= this.capacity) {
    const oldestKey = this.map.keys().next().value;
    if (oldestKey !== undefined) {
      this.map.delete(oldestKey); // 仅从 Map 中 delete！
    }
  }
  this.map.set(key, value);
  return this;
}
```
* **缺陷剖析**:
  - `BoundedMap` 淘汰最旧 Key 时，**没有提供任何 `onEvict` 销毁回调**。
  - 当后台任务数超过 200 时，最旧的任务 Record 被从 `tasks` Map 中移除。如果该任务**处于 `running` 状态**，其 `record.child` 子进程**不会被终止**，`record.timeout` 定时器与 `record.heartbeat` 循环**不会被清除**，`child.stdout` 的事件监听器依然触发并往内存写入 buffer。
  - 该任务彻底失去引用后变成完全不可控的“僵尸后台进程”，持续消耗系统 CPU/内存。

### 2.2 标杆对比 (VS Code & Claude Code 进程治理)
根据标杆报告 `patch_analysis_06_sandboxes_and_heavy_ides.md`（VS Code `processes.ts` & Docker 守护机制）与 `patch_analysis_05_desktop_agent_runtimes.md`：
- VS Code 在 Windows 上使用 Native C++ Node Addon / Job Object (`Win32 Job Objects`) 绑定整个进程树，确保父进程崩溃时 OS 级强杀所有衍生子进程。
- 终止进程树采用 **Phase 1: Soft Kill (SIGTERM / WM_CLOSE / CTRL_C) -> 3000ms Timeout -> Phase 2: Hard Kill (`taskkill /T /F`)** 两阶段保护。

### 2.3 修复方案与代码实现

#### [Rust] 完善 `JobObject` 守护封装 (`crates/conex-sandbox/src/process_tree.rs`)
```rust
#[cfg(target_os = "windows")]
pub struct ScopedJobObject {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(target_os = "windows")]
impl ScopedJobObject {
    pub fn new() -> Result<Self> {
        unsafe {
            let handle = windows_sys::Win32::System::JobObjects::CreateJobObjectW(
                core::ptr::null_mut(),
                core::ptr::null_mut(),
            );
            if handle.is_null() {
                bail!("Failed to create job object");
            }
            let mut info: windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION =
                core::mem::zeroed();
            info.BasicLimitInformation.LimitFlags =
                windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            let ret = windows_sys::Win32::System::JobObjects::SetInformationJobObject(
                handle,
                9,
                &info as *const _ as *const core::ffi::c_void,
                core::mem::size_of::<windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ret == 0 {
                windows_sys::Win32::Foundation::CloseHandle(handle);
                bail!("Failed to set job object limit");
            }
            Ok(Self { handle })
        }
    }

    pub fn assign_process(&self, process_handle: std::os::windows::io::RawHandle) -> Result<()> {
        unsafe {
            let ret = windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(
                self.handle,
                process_handle,
            );
            if ret == 0 {
                bail!("Failed to assign process to job object");
            }
            Ok(())
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for ScopedJobObject {
    fn drop(&mut self) {
        unsafe {
            if !self.handle.is_null() {
                windows_sys::Win32::Foundation::CloseHandle(self.handle);
            }
        }
    }
}
```

#### [TypeScript] 增加 `BoundedMap` Eviction 回调与两阶段 ProcessTreeKiller
```typescript
// 1. bounded-map.ts 增加 onEvict 选项
export class BoundedMap<K, V> {
  constructor(
    private readonly capacity: number,
    private readonly onEvict?: (key: K, value: V) => void
  ) {}

  set(key: K, value: V): this {
    if (!this.map.has(key) && this.map.size >= this.capacity) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        const oldestVal = this.map.get(oldestKey);
        this.map.delete(oldestKey);
        if (oldestVal !== undefined && this.onEvict) {
          this.onEvict(oldestKey, oldestVal);
        }
      }
    }
    this.map.set(key, value);
    return this;
  }
}

// 2. background-command.ts 中接入 onEvict 清理僵尸进程
private readonly tasks = new BoundedMap<string, BackgroundCommandRecord>(
  MAX_BACKGROUND_TASKS,
  (_id, record) => {
    if (!isTerminalState(record.state) && record.child) {
      terminateChild(record.child, { scrubEnvironment: true, killProcessTree: true });
      if (record.timeout) clearTimeout(record.timeout);
      if (record.heartbeat) clearInterval(record.heartbeat);
    }
  }
);
```

---

## 3. Audit Domain 2: SQLite Database Resilience (WAL Mode, `busy_timeout` & Lock Backoff)

### 3.1 缺陷诊断与现场代码分析

#### 缺陷 2.1: `DbPool` 缺少 `SQLITE_BUSY` 指数退避重试机制
* **源码位置**: [`crates/conex-db/src/pool.rs:29-37`](file:///C:/Software/conex/crates/conex-db/src/pool.rs#L29-L37) 与 [`crates/conex-db/src/transaction.rs:15-42`](file:///C:/Software/conex/crates/conex-db/src/transaction.rs#L15-L42)
* **现场代码**:
```rust
// pool.rs
let manager = SqliteConnectionManager::file(&db_path).with_init(|conn| {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;
         PRAGMA foreign_keys = ON;",
    )
});

// transaction.rs
pub fn begin_transaction(&self) -> Result<Transaction<'_>> {
    let conn = self.get()?;
    conn.execute_batch("BEGIN TRANSACTION")?; // <-- 一旦锁竞争超时，直接抛出 Error
    Ok(Transaction { ... })
}
```
* **缺陷剖析**:
  1. **只有静态 `busy_timeout`，没有应用重试**：`PRAGMA busy_timeout = 5000` 仅让 SQLite 在 C 层等待最多 5000ms。如果在高并发写入（如多个 Agent worker 同时写入 Checkpoint、Audit log、Session message）或 WAL 刷盘（Checkpointing）时等待超过 5 秒，SQLite 会直接返回 `SQLITE_BUSY` (Code 5) 或 `SQLITE_LOCKED` (Code 6)。
  2. **错误直接穿透崩溃**: `conn.execute_batch(...)` 和 `tx.execute(...)` 没有包裹指数退避（Exponential Backoff with Jitter）重试循环。一旦抛出 `SqliteFailure`，整个数据库事务失败，导致 upper-layer 操作中断。

#### 缺陷 2.2: `BEGIN TRANSACTION` Deferred 模式引发锁升级死锁
* **源码位置**: [`crates/conex-db/src/transaction.rs:17`](file:///C:/Software/conex/crates/conex-db/src/transaction.rs#L17)
* **现场代码**:
```rust
conn.execute_batch("BEGIN TRANSACTION")?;
```
* **缺陷剖析**:
  - 在 SQLite WAL 模式下，默认的 `BEGIN TRANSACTION` 是 **DEFERRED**（延迟锁）事务。
  - 意味着事务在开始时不获取写锁，仅作为 Read Transaction。直到执行第一条 `INSERT` / `UPDATE` / `DELETE` 时，SQLite 才尝试将事务升级为 Write Transaction。
  - **死锁场景**:
    1. 连接 A 执行 `BEGIN TRANSACTION`（Deferred，获取 Shared Read Lock）。
    2. 连接 B 执行 `BEGIN TRANSACTION`（Deferred，获取 Shared Read Lock）。
    3. 连接 A 执行 `INSERT`，尝试将 Shared Lock 升级为 Reserved/Exclusive Write Lock -> 成功。
    4. 连接 B 执行 `INSERT`，也尝试升级为 Write Lock -> 此时连接 A 占有写锁，连接 B 被挂起。
    5. 连接 A 尝试提交或读取后续数据，如果 A/B 互相等待，或连接 B 升级失败，连接 B 抛出 `SQLITE_BUSY_SNAPSHOT`。
  - 标杆数据库实践要求：所有写事务**必须使用 `BEGIN IMMEDIATE`**，在事务开启的瞬间立即获取 Reserved Lock，阻止其他连接建立写事务，从而完全避免锁升级死锁。

### 3.2 标杆对比 (OpenCode & Coder 数据库锁治理)
参考标杆报告 `patch_analysis_01_opencode_opencodex.md` 及 `patch_analysis_04_coder_patch_engines.md` 中关于 SQLite / Embedded DB 的锁治理规范：
1. **写事务必须使用 `BEGIN IMMEDIATE`**。
2. **所有数据库写操作必须支持带随机抖动 (Jitter) 的指数退避重试**（如 50ms, 100ms, 200ms, 400ms, 800ms，最多重试 5 次）。

### 3.3 修复方案与代码实现

#### [Rust] 实现带退避重试与 `BEGIN IMMEDIATE` 的 `DbPool` 事务 (`crates/conex-db/src/transaction.rs`)
```rust
use std::thread::sleep;
use std::time::Duration;
use rand::Rng;

pub struct TransactionOptions {
    pub max_retries: u32,
    pub initial_backoff_ms: u64,
    pub max_backoff_ms: u64,
}

impl Default for TransactionOptions {
    fn default() -> Self {
        Self {
            max_retries: 5,
            initial_backoff_ms: 50,
            max_backoff_ms: 1000,
        }
    }
}

impl DbPool {
    /// 开启包含 BEGIN IMMEDIATE 与指数退避重试的写事务
    pub fn begin_immediate_transaction(&self) -> Result<Transaction<'_>> {
        self.begin_immediate_transaction_with_options(TransactionOptions::default())
    }

    pub fn begin_immediate_transaction_with_options(
        &self,
        opts: TransactionOptions,
    ) -> Result<Transaction<'_>> {
        let mut backoff = opts.initial_backoff_ms;
        let mut attempts = 0;

        loop {
            let conn = self.get()?;
            match conn.execute_batch("BEGIN IMMEDIATE") {
                Ok(_) => {
                    return Ok(Transaction {
                        conn,
                        active: true,
                        _marker: std::marker::PhantomData,
                    });
                }
                Err(err) => {
                    attempts += 1;
                    if attempts > opts.max_retries || !is_busy_error(&err) {
                        return Err(err.into());
                    }
                    // 增加 0~20ms 的 random jitter，防止多线程死锁雷暴
                    let jitter = rand::thread_rng().gen_range(0..20);
                    sleep(Duration::from_millis(backoff + jitter));
                    backoff = (backoff * 2).min(opts.max_backoff_ms);
                }
            }
        }
    }
}

fn is_busy_error(err: &rusqlite::Error) -> bool {
    match err {
        rusqlite::Error::SqliteFailure(ffi_err, _) => {
            ffi_err.code == rusqlite::ErrorCode::DatabaseBusy
                || ffi_err.code == rusqlite::ErrorCode::DatabaseLocked
        }
        _ => false,
    }
}
```

---

## 4. Audit Domain 3: Long-running Session Memory & Garbage Collection (Memory Leaks)

### 4.1 缺陷诊断与现场代码分析

#### 缺陷 3.1: Raw Tool Payloads 无上限存留于内存且缺少 LRU 外部化
* **源码位置**: [`packages/agent-runtime/src/session.ts:81-102`](file:///C:/Software/conex/packages/agent-runtime/src/session.ts#L81-L102) 与 `provider-openai-compatible.ts`
* **现场代码**:
```typescript
export function buildSessionContextFromEntries(entries: SessionEntry[], leafId: string | null = findSessionLeafId(entries)): AgentMessage[] {
  // 遍历并返回包含所有 message.blocks 的完整数组
  return [createCompactionSummaryAgentMessage(compaction.record), ...keptBeforeCompaction, ...afterCompaction];
}
```
* **缺陷剖析**:
  1. **巨型 Block Payload 永久堆积**: 当 Agent 执行 `read_file`（读取 1MB 代码文件）或 `run_command`（输出几百 KB 的 stdout）时，这些大文本作为 `AgentMessage.blocks` 存入 Session 历史。
  2. **每次 Provider 调用做 N 次字符串复制**: 在 `provider-openai-compatible.ts` 的 `buildOpenAICompatiblePayload` 中，每轮循环都会遍历全量 `messages` 数组，将 block 内容深拷贝拼装为 JSON Request Body。随着 Round 增加到 50+，内存中会产生数十个几 MB 级的重叠字符串副本。
  3. **缺乏 Payload Eviction / Disc Offloading**: 历史消息中已经很久不用的工具输出（Raw Outputs）没有被剥离或置换到磁盘临时文件（Offloaded to Disk），导致 JS V8 堆内存快速突破 1GB~2GB。

#### 缺陷 3.2: 缺乏显式 GC 触发与内存监视器
* **源码位置**: [`packages/agent-runtime/src/session-loop/`](file:///C:/Software/conex/packages/agent-runtime/src/)
* **缺陷剖析**:
  - 在全库 TS 代码中，检索不到任何 `global.gc?.()` 的调用或内存监控逻辑（Memory Threshold Watchdog）。
  - 会话在经历 Context Compaction（上下文压缩）后，虽然在逻辑上删除了旧 Message 节点，但旧 Message 对象及关联的 Base64 图片数据仍然保留在 V8 老生代堆内存中，等待下一次 GC。如果不主动触发 `global.gc?.()`，内存峰值将长时间居高不下。

#### 缺陷 3.3: Rust 压缩模块做全量克隆且未释放 Capacity
* **源码位置**: [`crates/conex-compaction/src/compaction.rs:29-48`](file:///C:/Software/conex/crates/conex-compaction/src/compaction.rs#L29-L48)
* **现场代码**:
```rust
pub fn compact(&self, messages: &mut Vec<Message>) {
    let mut llm_messages: Vec<Message> = messages
        .iter()
        .filter(|m| !m.is_custom_ui_msg)
        .cloned() // <-- 全量 Clone 每一个 Message 及其 String 内容
        .collect();
    // ...
    if total_tokens > critical_limit {
        self.emergency_compaction(&mut llm_messages, critical_limit, &mut total_tokens);
    }
    *messages = llm_messages;
}
```
* **缺陷剖析**:
  - `messages.iter().cloned().collect()` 会对整条会话所有消息进行深拷贝，造成瞬间内存翻倍。
  - `emergency_compaction` 中使用 `messages.drain(1..end)` 删除了大部分旧消息，但更新后的 `Vec<Message>` **未调用 `.shrink_to_fit()`**，导致 Vec 内部仍保留初始的大容量 Buffer 空间，无法释放给操作系统。

### 4.2 标杆对比 (Coder & OpenCode 内存管理)
参考标杆报告 `patch_analysis_04_coder_patch_engines.md`（`release_retained_heap_if_excessive`）与 `patch_analysis_01_opencode_opencodex.md`：
- Coder 在高频 Patch 和长会话中引入了 Heap Retention Watchdog，在发现内存超过 threshold 时显式调用 `jemalloc` / `global.gc()` 释放内存。
- 对 Raw Tool Result 进行剪裁（Trimming / Disk Offloading），将大于 64KB 的工具输出替换为引用指针，只在 LLM 显式要求时加载。

### 4.3 修复方案与代码实现

#### [TypeScript] 工具输出剪裁与 GC 触发器 (`packages/agent-runtime/src/tool-payload-pruner.ts`)
```typescript
const RAW_PAYLOAD_LIMIT_BYTES = 32 * 1024; // 32KB 阈值

export function pruneHistoricalToolOutputs(messages: AgentMessage[], activeWindowSize = 10): AgentMessage[] {
  const cutoffIndex = Math.max(0, messages.length - activeWindowSize);
  
  return messages.map((msg, idx) => {
    // 仅针对 cutoffIndex 之前的历史工具输出消息进行瘦身
    if (idx >= cutoffIndex || msg.role !== "tool") {
      return msg;
    }
    const prunedBlocks = msg.blocks.map((block) => {
      if (block.type === "text" && block.text.length > RAW_PAYLOAD_LIMIT_BYTES) {
        return {
          type: "text" as const,
          text: `${block.text.slice(0, 1024)}\n\n[... Historical Tool Payload Pruned: ${block.text.length} bytes omitted ...]`
        };
      }
      return block;
    });
    return { ...msg, blocks: prunedBlocks };
  });
}

export function tryTriggerGarbageCollection(): boolean {
  if (typeof globalThis.gc === "function") {
    try {
      globalThis.gc();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
```

#### [Rust] `compaction.rs` 零拷贝与 Capacity 释放
```rust
pub fn compact(&self, messages: &mut Vec<Message>) {
    // 移除 custom UI 消息（原地 retain 避免 clone）
    messages.retain(|m| !m.is_custom_ui_msg);
    self.strip_images_from_messages(messages);

    let mut total_tokens = self.calculate_total_tokens(messages);
    let warning_limit = (self.max_context as f64 * self.warning_threshold) as usize;
    let critical_limit = (self.max_context as f64 * self.critical_threshold) as usize;

    if total_tokens > critical_limit {
        self.emergency_compaction(messages, critical_limit, &mut total_tokens);
    } else if total_tokens > warning_limit {
        self.mild_compaction(messages, warning_limit, &mut total_tokens);
    }

    // 显式释放被 drain 清除后的多余 Capacity
    messages.shrink_to_fit();
}
```

---

## 5. Audit Domain 4: Anti-Hanging Environment Injection (`CI=true` & Non-Interactive)

### 5.1 缺陷诊断与现场代码分析

#### 缺陷 4.1: `createGuardedProcessEnv` 完全未注入防卡死非交互环境变量
* **源码位置**: [`packages/agent-runtime/src/process-lifecycle/process-executor.ts:223-233`](file:///C:/Software/conex/packages/agent-runtime/src/process-lifecycle/process-executor.ts#L223-L233)
* **现场代码**:
```typescript
export function createGuardedProcessEnv(): NodeJS.ProcessEnv {
  const guarded: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (isSensitiveEnvName(key)) continue;
    guarded[key] = value;
  }
  guarded.PYTHONUTF8 = "1";
  guarded.PYTHONIOENCODING = "utf-8";
  return guarded; // <-- 严重缺失 CI=true, GIT_TERMINAL_PROMPT=0 等！
}
```
* **缺陷剖析**:
  - `createGuardedProcessEnv` 是所有通过 `runProcessCommand` / `BackgroundCommandManager` 派生子进程时默认使用的环境变量构造函数。
  - 当前代码仅注入了 `PYTHONUTF8='1'` 与 `PYTHONIOENCODING='utf-8'`。
  - **缺失的关键非交互变量**:
    1. `CI=true`: 提示现代 CLI 工具（npm, vitest, git, python, nx, pnpm）当前运行在自动化 CI 环境下，禁止开启 TUI 交互菜单或等待用户按键。
    2. `GIT_TERMINAL_PROMPT=0`: 防止 `git clone` / `git fetch` / `git push` 在缺少凭据或 SSH key 错误时弹窗或在 Stdin 上等待用户名密码输入。
    3. `PIP_NO_INPUT=1`: 防止 `pip install` 在需要用户确认或依赖冲突时暂停等待输入。
    4. `DEBIAN_FRONTEND=noninteractive`: 防止在 WSL 或 Linux 容器下运行 `apt-get` 时弹出 dialog 界面卡死。
    5. `npm_config_yes=true` / `NPM_CONFIG_YES=true`: 防止 `npx` 弹出 `Need to install the following packages: (y/n)` 提示。
    6. `PAGER=cat` / `GIT_PAGER=cat`: 防止 `git log` / `git diff` 自动打开 `less` 或 `more` 交互式分页器。

#### 缺陷 4.2: PowerShell Prelude 亦未包含非交互环境变量
* **源码位置**: [`packages/agent-runtime/src/process-lifecycle/process-executor.ts:250-257`](file:///C:/Software/conex/packages/agent-runtime/src/process-lifecycle/process-executor.ts#L250-L257)
* **现场代码**:
```typescript
export function buildWindowsPowerShellScript(userCommand: string): string {
  const prelude = [
    "$OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "$env:PYTHONUTF8='1'",
    "$env:PYTHONIOENCODING='utf-8'"
  ].join("; ");
  // ...
}
```
* **缺陷剖析**:
  - 在 Windows 上，即使父进程设置了 `process.env`，PowerShell 在执行内嵌 `$script` 时，若未在脚本 Prelude 中显式设置 `$env:CI='true'`，部分 PowerShell Cmdlet 仍会进入交互提示模式。

### 5.2 标杆对比 (OpenCode & Claude Code 命令行防卡死)
根据标杆报告 `patch_analysis_01_opencode_opencodex.md` 及 `patch_analysis_05_desktop_agent_runtimes.md`：
- 所有面向 Agent 自动执行的 Shell 进程，**必须强制注入全套 Anti-Interactive 环境变量**，任何未注入非交互变量的 Shell 执行器均被视为高危缺陷。

### 5.3 修复方案与代码实现

#### [TypeScript] 注入全套 Anti-Hanging 环境变量 (`process-executor.ts`)
```typescript
export function createGuardedProcessEnv(): NodeJS.ProcessEnv {
  const guarded: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (isSensitiveEnvName(key)) continue;
    guarded[key] = value;
  }

  // 防卡死非交互环境变量注入
  guarded.CI = "true";
  guarded.CONTINUOUS_INTEGRATION = "true";
  guarded.GIT_TERMINAL_PROMPT = "0";
  guarded.GIT_PAGER = "cat";
  guarded.PAGER = "cat";
  guarded.PIP_NO_INPUT = "1";
  guarded.DEBIAN_FRONTEND = "noninteractive";
  guarded.npm_config_yes = "true";
  guarded.NPM_CONFIG_YES = "true";
  guarded.TERM = "dumb";
  guarded.PYTHONUTF8 = "1";
  guarded.PYTHONIOENCODING = "utf-8";

  return guarded;
}

export function buildWindowsPowerShellScript(userCommand: string): string {
  const prelude = [
    "$OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "$env:CI='true'",
    "$env:CONTINUOUS_INTEGRATION='true'",
    "$env:GIT_TERMINAL_PROMPT='0'",
    "$env:GIT_PAGER='cat'",
    "$env:PAGER='cat'",
    "$env:PIP_NO_INPUT='1'",
    "$env:npm_config_yes='true'",
    "$env:NPM_CONFIG_YES='true'",
    "$env:TERM='dumb'",
    "$env:PYTHONUTF8='1'",
    "$env:PYTHONIOENCODING='utf-8'"
  ].join("; ");
  
  const normalized = normalizePowerShellCommand(userCommand);
  const payload = Buffer.from(normalized, "utf8").toString("base64");
  return [
    prelude,
    "$global:LASTEXITCODE=$null",
    `$__conexCmd = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${payload}'))`,
    "& ([scriptblock]::Create($__conexCmd))",
    "$success=$?",
    "$exitCode=$LASTEXITCODE",
    "if ($exitCode -ne $null -and $exitCode -ne 0) { exit $exitCode }",
    "if (-not $success) { exit 1 }"
  ].join("; ");
}
```

---

## 6. Comprehensive Gap Matrix & Remediation Roadmap

### 6.1 缺陷差距对比矩阵 (Gap Matrix)

| 诊断领域 | 标杆最佳实践 (Reference Benchmark) | Conex 当前实现状态 (Current State) | 缺陷隐患等级 (Risk) | 涉及核心文件 (Affected Files) |
| :--- | :--- | :--- | :--- | :--- |
| **Windows 进程树清理** | OS 级 `Job Objects` 绑定 + 两阶段优雅终止 (`WM_CLOSE` -> `taskkill /F /T`) | `attach_to_job_object` 死代码未调用；无优雅降级直喷 `taskkill /F`；`BoundedMap` 淘汰任务泄漏后台子进程 | **CRITICAL (P0)** | `crates/conex-sandbox/src/process_tree.rs`<br>`packages/agent-runtime/src/process-lifecycle/process-executor.ts`<br>`packages/agent-runtime/src/background-command.ts`<br>`packages/shared-utils/src/bounded-map.ts` |
| **SQLite 数据库锁** | WAL 模式 + `BEGIN IMMEDIATE` + 带 Jitter 的指数退避重试 (Exponential Backoff) | 有 WAL / `busy_timeout`，但全库**无 retry 重试**；事务采用 `BEGIN TRANSACTION` (Deferred) 易导致死锁 | **HIGH (P1)** | `crates/conex-db/src/pool.rs`<br>`crates/conex-db/src/transaction.rs`<br>`crates/conex-db/src/query.rs` |
| **长会话内存与 GC** | Raw Tool Payloads LRU 剪裁/磁盘置换 + 堆内存 Watchdog + 显式 `gc()` + Rust 容量收缩 | 全量 Message 随 Round 无上限增长；多次深拷贝；无 GC 回调；Rust `compaction` 频繁 `.clone()` 且无 `shrink_to_fit()` | **HIGH (P1)** | `packages/agent-runtime/src/session.ts`<br>`packages/agent-runtime/src/provider-openai-compatible.ts`<br>`crates/conex-compaction/src/compaction.rs` |
| **命令防卡死注入** | 自动注入 `CI=true`, `GIT_TERMINAL_PROMPT=0`, `PIP_NO_INPUT=1` 等全套非交互变量 | `createGuardedProcessEnv` 与 PowerShell Prelude **零非交互环境变量**，`git`/`npm`/`pip` 极易死锁 | **CRITICAL (P0)** | `packages/agent-runtime/src/process-lifecycle/process-executor.ts` |

---

### 6.2 修复实施路线图 (Remediation Roadmap)

1. **Sprint 1: 防卡死与子进程资源回收（P0 级硬性拦截）**
   - [ ] 修改 `process-executor.ts` 中的 `createGuardedProcessEnv` 和 `buildWindowsPowerShellScript`，补全 `CI=true` 等 12 个非交互环境变量。
   - [ ] 为 `packages/shared-utils/src/bounded-map.ts` 添加 `onEvict` 回调机制，在 `background-command.ts` 中实现最旧任务淘汰时的 `terminateChild` 强收逻辑。
   - [ ] 在 `crates/conex-sandbox/src/process_tree.rs` 中重构 `ScopedJobObject`，并在 PTY / Daemon 启动子进程时强绑定 Job Object。

2. **Sprint 2: SQLite 锁退避与 `BEGIN IMMEDIATE` 重构（P1 级数据库健壮性）**
   - [ ] 将 `crates/conex-db/src/transaction.rs` 中的 `BEGIN TRANSACTION` 全部升级为 `BEGIN IMMEDIATE`。
   - [ ] 在 `DbPool` 事务和单条写 SQL 执行层引入 `begin_immediate_transaction_with_options` 指数退避重试循环（支持 5 次重试，带 0~20ms Random Jitter）。

3. **Sprint 3: 内存瘦身、工具输出剪裁与垃圾回收（P1 级内存治理）**
   - [ ] 实现 `pruneHistoricalToolOutputs`，对超过 10 轮前的 Raw Tool Results 进行 32KB 截断与离线标记。
   - [ ] 在 Context Compaction 结束和 Session 销毁钩子中加入 `tryTriggerGarbageCollection()` 显式 GC 调用。
   - [ ] 重构 `crates/conex-compaction/src/compaction.rs`，消除 `Message.clone()` 并添加 `messages.shrink_to_fit()`。
