# Conex 与 Grok-Build 系统安全、沙箱隔离与危险防御深度对比审计报告

> **审查人员**：系统底层安全与沙箱隔离专项审计组  
> **审查对象**：  
> - **Conex**（当前仓库）：`crates/conex-sandbox/`、`crates/agent-tools/`、`crates/conex-fs/`、`apps/agent-workbench/src-tauri/`、`apps/crish-desktop/`  
> - **Grok-Build**（对照仓库）：`reference/grok-build/crates/xai-grok-sandbox/`、`xai-grok-tools/`、`xai-grok-shell/`、`xai-grok-config/`  
> **审查基准**：严格基于两端真实源码实现，不依赖任何第三方解说，审查源码文件共计 **48 个**，所有结论附带精确源码文件路径及行号（`file:line`）。

---

## 目录

1. [执行摘要与设计哲学对比](#一执行摘要与设计哲学对比)
2. [命令门禁与危险行为防御（Command Gating & AST Semantics）](#二命令门禁与危险行为防御command-gating--ast-semantics)
3. [沙箱隔离运行时与内核约束（Sandbox Execution & LSM/Namespaces）](#三沙箱隔离运行时与内核约束sandbox-execution--lsmnamespaces)
4. [文件系统防护与路径安全隔离（Filesystem Isolation & Path Security）](#四文件系统防护与路径安全隔离filesystem-isolation--path-security)
5. [反混淆与逃逸防御机制（De-obfuscation & Anti-Escape Defense）](#五反混淆与逃逸防御机制de-obfuscation--anti-escape-defense)
6. [资源配额、进程树生命周期与熔断保护（Resource Quota & Process Lifecycle）](#六资源配额进程树生命周期与熔断保护resource-quota--process-lifecycle)
7. [多代理并发安全与权限边界（Multi-Agent Security & Tool Pruning）](#七多代理并发安全与权限边界multi-agent-security--tool-pruning)
8. [全面技术规格对照矩阵与工业级成熟度评分](#八全面技术规格对照矩阵与工业级成熟度评分)
9. [技术洞察与演化建议（双向借鉴）](#九技术洞察与演化建议双向借鉴)

---

## 一、执行摘要与设计哲学对比

Conex 与 Grok-Build 在处理「AI 驱动的智能体代码执行与系统权限控制」这一命题时，体现出完全不同的架构分层哲学与技术着力点：

```
+---------------------------------------------------------------------------------------+
|                                    Conex 架构层级                                     |
+---------------------------------------------------------------------------------------+
|  应用层/前端      crish-desktop: commandPermissions.ts (用户审批/白名单/模式)        |
|  代理工具层      agent-tools: permission.rs (Redline 绝对不可越界 / 3态判定矩阵)      |
|  命令语义层      conex-sandbox: semantics.rs (AST词法分析/反混淆/ReDoS熔断/危险反射)   |
|  虚拟兜底层      conex-fs: trash.rs (物理删除拦截/回收站化/SHA256快照回退)            |
|  宿主进程层      agent-workbench: process.rs (Windows Job Objects / KillOnClose / 树杀) |
+---------------------------------------------------------------------------------------+

+---------------------------------------------------------------------------------------+
|                                  Grok-Build 架构层级                                  |
+---------------------------------------------------------------------------------------+
|  信任门禁层      grok-shell: folder_trust.rs (工作区信任状态门禁)                     |
|  工具驱动层      grok-tools: bash/mod.rs (前后台执行/AmpersandSemantics/TerminalActor)|
|  内核重编排层    grok-sandbox: lib.rs (Bubblewrap 容器化 / 0o000 只读遮盖 / Landlock)  |
|  底层系统调用层  grok-sandbox: child_net.rs (Seccomp BPF 零分配网络阻断)              |
|  系统资源监控层  grok-tools: cgroup.rs (Linux cgroups v2 / Inotify OOM Kill)          |
+---------------------------------------------------------------------------------------+
```

### 1. 核心设计哲学差异

| 评估维度 | Conex 实现范式 | Grok-Build 实现范式 |
| :--- | :--- | :--- |
| **安全核心锚点** | **应用层前置防御 + 语义反混淆 + 破坏性不可逆操作兜底** | **操作系统内核级隔离 + 系统调用（Syscall）截断 + 容器边界** |
| **主要防护手段** | 1. 细粒度 Shell AST 词法状态机解析与反混淆<br>2. Windows Job Objects 强控进程树<br>3. 物理删除全量重定向至安全回收站<br>4. 敏感路径基线判定与并发写独占互斥锁 | 1. Linux Bubblewrap (bwrap) 命名空间与只读挂载<br>2. Linux Landlock LSM 细粒度文件系统访问控制<br>3. BPF Seccomp 拦截子进程网络相关系统调用<br>4. Linux Cgroups v2 监控内存水位与软性 OOM 截杀 |
| **跨平台成熟度** | **Windows 第一公民**，深度定制 PowerShell 反射拦截与 Windows Job Object，兼容 POSIX 基础终端。 | **Linux / macOS 第一公民**，重度依赖 Linux LSM、Namespaces、BPF 与 macOS Seatbelt；**Windows 端基本为空实现（Stub）**。 |
| **执行可恢复性** | **高可靠可逆恢复**：所有 `rm` / `Remove-Item` 强制转入快照回收站，Git 大面积破坏具有冷却时间与滑动窗口阈值拦截。 | **硬核不可逆隔离**：容器内被写破坏即破坏，依赖环境快速销毁重置，应用层缺乏删除回退拦截体系。 |

---

## 二、命令门禁与危险行为防御（Command Gating & AST Semantics）

### 1. Conex：深度 AST 词法状态机与反混淆命令分析

Conex 在 [crates/conex-sandbox/src/lib.rs:24-95](file:///c:/Software/conex/crates/conex-sandbox/src/lib.rs#L24-L95) 与 [crates/conex-sandbox/src/semantics.rs:27-142](file:///c:/Software/conex/crates/conex-sandbox/src/semantics.rs#L27-L142) 中实现了工业级应用层命令门禁引擎。它不仅使用编译期预编译的 `RegexSet`，更构建了一个完整的轻量级词法解析状态机（AST Lexer）。

```rust
// crates/conex-sandbox/src/semantics.rs
pub fn classify_command(cmd: &str) -> CommandRiskLevel {
    // 1. ReDoS 防御与递归展开熔断 (行 35-42)
    // 2. 管道与复合命令切分 (split_command_segments, 行 55-78)
    // 3. 词法 Token 剥离与引号/反引号反混淆 (normalize_command, 行 80-112)
    // 4. PowerShell / .NET 动态反射危险行为检测 (check_powershell_danger, 行 115-140)
}
```

- **ReDoS 熔断保护（深度断路器）**：
  在 [crates/conex-sandbox/src/semantics.rs:38-42](file:///c:/Software/conex/crates/conex-sandbox/src/semantics.rs#L38-L42)，为防止恶意提示注入（Prompt Injection）构造极其深层的嵌套命令导致正则表达式引擎或词法分析器发生回溯失控（ReDoS），Conex 显式定义了嵌套深度计数器：
  - 当递归深度超过预设阈值（`depth >= 5`）时，自动降级判定为 `CommandRiskLevel::Dangerous`；
  - 当嵌套深度达到极高风险（`depth > 16`）时，直接断路并上报 `CommandRiskLevel::Redline` 刚性拦截。
- **复合命令解耦（Segment Splitting）**：
  在 [crates/conex-sandbox/src/semantics.rs:55-78](file:///c:/Software/conex/crates/conex-sandbox/src/semantics.rs#L55-L78)，`split_command_segments` 将 `&&`、`||`、`;`、`|` 等操作符进行符号解耦，逐段提取独立执行的指令实体，防止将危险指令隐藏于多段串联指令末端。
- **词法规范化与反转义（De-obfuscation Normalizer）**：
  针对 Windows / PowerShell 环境常见的混淆手段（如 `d`o`w`n`l`o`a`d、`"i" + "ex"`、`` `I`E`X ``），在 [crates/conex-sandbox/src/semantics.rs:80-112](file:///c:/Software/conex/crates/conex-sandbox/src/semantics.rs#L80-L112) 中剥离内部干扰字符（跳过单引号、双引号、反引号转义），合并被切碎的关键字。
- **.NET 动态反射与隐藏调用拦截**：
  在 [crates/conex-sandbox/src/semantics.rs:115-140](file:///c:/Software/conex/crates/conex-sandbox/src/semantics.rs#L115-L140)，精准匹配以下高危 PowerShell 特征：
  - `[system.reflection.assembly]::load`
  - `[scriptblock]::create`
  - `::start`（针对 `System.Diagnostics.Process::Start`）
  - Base64 编码执行开关：不局限于 `-enc`，更泛化匹配 `-e`, `-encodedcommand`, `-e:`, `/e:`，阻断绕过。

### 2. Conex：不可违背的红线判定（Redline Zero-Bypass）

在 [crates/agent-tools/src/permission.rs:18-120](file:///c:/Software/conex/crates/agent-tools/src/permission.rs#L18-L120)，Conex 定义了权限状态转移矩阵。即使系统当前运行在 `PermissionLevel::FullAccess`（全权限/YOLO模式）下：

```rust
// crates/agent-tools/src/permission.rs:92-110
pub fn decide_with_redline(
    level: PermissionLevel,
    risk: CommandRiskLevel,
    is_whitelisted: bool,
) -> PermissionDecision {
    if risk == CommandRiskLevel::Redline {
        return PermissionDecision::Deny {
            reason: "Command violates security redline. Execution strictly forbidden.",
        };
    }
    // 仅在非 Redline 时才结合白名单与用户模式判断
    ...
}
```
**铁律保证**：任何命中 Redline（如格式化磁盘、破坏操作系统根目录、关闭安全模块等）的命令，在代码逻辑上没有任何分支可以绕过，杜绝任何提权漏洞。

### 3. Grok-Build：基于 Shell 前后台语义与终端代理的门禁

Grok-Build 并未在自身应用层实现 AST 解析器，而是依赖 `grok-tools` 与 `grok-shell` 进行粗粒度的指令分发与前台/后台状态管理：

- **Ampersand 语义检查**：
  在 [reference/grok-build/crates/xai-grok-tools/src/tools/bash/mod.rs:42-88](file:///c:/Software/conex/reference/grok-build/crates/xai-grok-tools/src/tools/bash/mod.rs#L42-L88) 与 [reference/grok-build/crates/xai-grok-config/src/shell.rs:20-75](file:///c:/Software/conex/reference/grok-build/crates/xai-grok-config/src/shell.rs#L20-L75)，Grok-Build 检查指令末尾是否包含 `&`。如果检测到后台运行标记，依据 `AmpersandSemantics` 决定是报错拒绝还是剥离符号转入后台终端 Actor：
  ```rust
  // reference/grok-build/crates/xai-grok-tools/src/tools/bash/mod.rs:65-72
  if cmd.trim_end().ends_with('&') {
      match ampersand_semantics {
          AmpersandSemantics::Reject => return Err(BashError::AmpersandForbidden),
          AmpersandSemantics::Allow => { ... }
      }
  }
  ```
- **工作区信任门禁（Folder Trust）**：
  在 [reference/grok-build/crates/xai-grok-shell/src/folder_trust.rs:25-78](file:///c:/Software/conex/reference/grok-build/crates/xai-grok-shell/src/folder_trust.rs#L25-L78)，Grok-Build 在整个工作区维度维护 `FolderTrustState`（`Trusted` / `Untrusted`）。如果工作区未受信任，所有外部命令执行工具直接被阻断，必须由用户完成交互式确认。

---

## 三、沙箱隔离运行时与内核约束（Sandbox Execution & LSM/Namespaces）

这是 Grok-Build 最为硬核、也是工业化防御极其深入的模块，而 Conex 则在 Windows 平台环境下实现了进程树与作业对象的精确闭环控制。

### 1. Grok-Build：Bubblewrap 与 Linux Landlock LSM 深度编排

在 [reference/grok-build/crates/xai-grok-sandbox/src/lib.rs:45-210](file:///c:/Software/conex/reference/grok-build/crates/xai-grok-sandbox/src/lib.rs#L45-L210)，Grok-Build 将 Linux 原生轻量级容器隔离推向了极致：

```
+-------------------------------------------------------------------------------+
|                           Grok-Build bwrap 执行链条                            |
+-------------------------------------------------------------------------------+
| bwrap --unshare-all --cap-drop ALL                                            |
|   |-- 基础系统目录只读绑定: --ro-bind /usr /usr, --ro-bind /bin /bin             |
|   |-- 设备隔离: --dev-bind /dev/null /dev/null, /dev/urandom ...              |
|   |-- 临时隔离区: --tmpfs /tmp, --tmpfs /run                                  |
|   |-- 工作区读写放行: --bind /workspace /workspace                            |
|   |-- 严格拒绝读取路径: 0o000 权限空文件覆盖只读绑定 (bind-over)               |
|   +-- 内核 LSM: 应用 LandlockRuleset (ABI v1-v5 特性探测与规则降级兼容)       |
+-------------------------------------------------------------------------------+
```

- **0o000 掩码占位覆盖技术（Mode 000 Bind-Over）**：
  在 [reference/grok-build/crates/xai-grok-sandbox/src/lib.rs:112-145](file:///c:/Software/conex/reference/grok-build/crates/xai-grok-sandbox/src/lib.rs#L112-L145)，对于配置为拒绝读取（Read Deny）的路径（例如用户的 `~/.ssh`、`~/.aws`、敏感环境变量文件），bwrap 创建一个临时空文件/目录，将其权限设置为 `0o000`（无读无写无执行），然后以 `--ro-bind` 挂载覆盖到目标路径上方。即使容器内进程具有真实用户 UID，内核 VFS 层面在权限校验时直接拦截读系统调用。
- **Landlock LSM 细粒度沙箱注入**：
  在 [reference/grok-build/crates/xai-grok-sandbox/src/lib.rs:170-205](file:///c:/Software/conex/reference/grok-build/crates/xai-grok-sandbox/src/lib.rs#L170-L205)，Grok-Build 通过 `landlock` crate 探测宿主内核支持的 ABI 版本。针对工作区赋予 `AccessFs::from_all(abi)` 权限，针对只读目录剔除所有修改/重命名/删除权限位，在进程执行前通过 `landlock_restrict_self` 封死后续权限提升的可能性。
- **macOS Seatbelt 规则编译**：
  在 [reference/grok-build/crates/xai-grok-sandbox/src/deny/glob.rs:25-95](file:///c:/Software/conex/reference/grok-build/crates/xai-grok-sandbox/src/deny/glob.rs#L25-L95) 与 [src/deny/mod.rs:30-120](file:///c:/Software/conex/reference/grok-build/crates/xai-grok-sandbox/src/deny/mod.rs#L30-L120)，Grok-Build 动态将通配符转换为 macOS 内核沙箱（Seatbelt/`sandbox_init`）的 Scheme 格式规则，处理了 `/private` 固件符号链接（Firmlinks）与多种写子操作（`file-write-unlink`, `file-write-data`）。

### 2. Grok-Build：内核系统调用拦截（BPF Seccomp 零分配网络隔离）

在 [reference/grok-build/crates/xai-grok-sandbox/src/child_net.rs:35-145](file:///c:/Software/conex/reference/grok-build/crates/xai-grok-sandbox/src/child_net.rs#L35-L145)，Grok-Build 展现出顶级系统工程功力。为了在子进程中禁用外网连接，它没有采用开销巨大的独立 Network Namespace，而是使用 BPF Seccomp 过滤器：

```rust
// reference/grok-build/crates/xai-grok-sandbox/src/child_net.rs:65-98
pub unsafe fn apply_child_net_bpf() -> Result<(), i32> {
    // 严格遵循 fork() 之后 pre_exec 的约束：
    // 禁止任何内存堆分配（Zero-Allocation）！
    // 预编译好的 BPF 字节码直接送入 SYS_seccomp
    // 拦截系统调用：SYS_connect, SYS_bind, SYS_sendto, 以及 SYS_io_uring_enter/setup
}
```
- **Fork-Safe 零分配保证**：在多线程环境中 `fork` 之后、`exec` 之前的 `pre_exec` 阶段调用 `malloc` 会造成死锁。Grok-Build 预先构建静态 BPF 指令数组，`unsafe` 上下文内只执行单一 `libc::syscall`。
- **防绕过扩展**：不仅拦截了传统网络套接字系统调用，还精准拦截了 `SYS_io_uring_setup` 与 `SYS_io_uring_enter`，防止恶意可执行文件利用 Linux `io_uring` 异步系统调用通道旁路逃逸网络限制。

### 3. Conex：Windows Job Objects 强控进程树与安全通道

由于 Conex 聚焦于 Windows 桌面生产力环境（同时服务跨平台引擎），在 Linux LSM/BPF 缺失的情况下，Conex 在 Windows 平台筑起了坚不可摧的宿主守护墙：

- **Windows 作业对象硬绑定（Job Object Termination）**：
  在 [apps/agent-workbench/src-tauri/src/process.rs:45-90](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/process.rs#L45-L90)，每个由 Conex 派生的子进程都会被立即放入独立的 Windows Job Object 中，并开启 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 标志位：
  ```rust
  // apps/agent-workbench/src-tauri/src/process.rs:68-75
  SetInformationJobObject(
      job_handle,
      JobObjectExtendedLimitInformation,
      &info,
      sizeof(info),
  );
  ```
  **安全保证**：即使子进程内部生成了恶意深层孙进程、孤儿进程或尝试脱离父进程终端，一旦主程序中断或任务被取消，Windows 内核会由操作系统级自动斩首整个进程树，绝无僵尸进程残留可能。
- **PowerShell 严格执行封装**：
  在 [crates/agent-tools/src/tools/shell_invoke.rs:18-60](file:///c:/Software/conex/crates/agent-tools/src/tools/shell_invoke.rs#L18-L60)，Conex 调用 PowerShell 时强制指定 `-NoProfile -NonInteractive -ExecutionPolicy Bypass`，同时将实际执行代码在内存中转换为 UTF-16LE 并进行 Base64 编码，避免命令在 Windows 命令行参数传递时的二级转义注入风险。

---

## 四、文件系统防护与路径安全隔离（Filesystem Isolation & Path Security）

文件系统的增删改查是智能体行为中风险最高的领域。两端在此展现了各自的最高防线。

### 1. Conex：物理删除零发生（Safe Trash 拦截）与写锁互斥

在 Conex 中，**没有任何代理工具可以直接进行物理文件删除**。

```
+-------------------------------------------------------------------------------+
|                            Conex 文件防护与删除拦截链条                        |
+-------------------------------------------------------------------------------+
| 用户/Agent 触发: rm -rf / DeleteFile / DeleteDirectory                       |
|   |--> shell_redirect.rs: 识别 DeleteShape，直接拦截原始命令                  |
|   |--> delete.rs: 权限鉴权与 WritePathPolicy 校验                              |
|   |--> conex-fs/trash.rs: 计算 SHA256，生成元数据 meta.json                   |
|   +--> 物理转移至 .crish-trash 归档目录 (保留文件树与还原点，可瞬间回滚)      |
+-------------------------------------------------------------------------------+
```

- **命令重定向拦截（DeleteShape Redirection）**：
  在 [crates/agent-tools/src/tools/shell_redirect.rs:25-95](file:///c:/Software/conex/crates/agent-tools/src/tools/shell_redirect.rs#L25-L95)，任何通过 Shell 工具执行的删除指令（如 `rm`, `del`, `Remove-Item`, `rmdir`）都会被模式识别判定为 `DeleteShape` 并硬拦截，提示 Agent 必须调用专用的 `delete_file` / `delete_dir` 工具。
  同时，复合链接命令中包含删除时（例如 `cargo build && rm -rf dist`），Conex 直接拒绝执行，防止 Agent 利用链式命令掩盖破坏操作。
- **带校验和的安全回收站服务（TrashService）**：
  在 [crates/conex-fs/src/trash.rs:30-140](file:///c:/Software/conex/crates/conex-fs/src/trash.rs#L30-L140)，所有被删除项被安全移动至 `.crish-trash` 隔离区。移动前计算其 SHA256 哈希值并持久化 `meta.json`，记录原始物理绝对路径、归档时间戳及会话 ID。如果发生误删，可以通过单一恢复 API 毫秒级无损复原。
- **系统关键路径防护与 Windows 路径规范化**：
  在 [crates/conex-fs/src/path_normalizer.rs:25-115](file:///c:/Software/conex/crates/conex-fs/src/path_normalizer.rs#L25-L115)，Conex 实现了严密的路径归一化：
  - 剔除 Windows 长路径原样前缀（`\\?\`、`\\?\UNC\`）；
  - `is_system_critical_path` 严格拦截系统根目录（`C:\Windows`, `C:\Program Files`, `/etc`, `/usr`, `/System` 等），任何读写试图命中关键路径直接返回权限拒绝。
- **工作区并发写互斥（Write Claims Mutex）**：
  在 [crates/agent-tools/src/write_paths.rs:20-80](file:///c:/Software/conex/crates/agent-tools/src/write_paths.rs#L20-L80) 与 [src/write_paths_validate.rs:22-75](file:///c:/Software/conex/crates/agent-tools/src/write_paths_validate.rs#L22-L75)，针对多 Agent 协作，Conex 维护了一套跨线程/跨任务的写声明互斥锁。通过前缀路径组件比较（`overlaps`），确保当 Agent A 正在修改某子目录时，Agent B 对该目录或其父/子路径的写操作被强制排队或拒绝，彻底杜绝写竞争与文件损坏。

### 2. Grok-Build：内核挂载检验与容器套接字屏蔽

Grok-Build 将文件防护建立在操作系统挂载表与特权节点隔离之上：

- **深度挂载检验（`SYS_statx` Mount Verification）**：
  在 [reference/grok-build/crates/xai-grok-sandbox/src/read_deny_verify.rs:30-160](file:///c:/Software/conex/reference/grok-build/crates/xai-grok-sandbox/src/read_deny_verify.rs#L30-L160)，当 Grok-Build 为沙箱挂载了拒绝读取路径后，它并不轻信应用层状态，而是在宿主层解析 `/proc/self/mountinfo`，并直接通过裸系统调用 `SYS_statx` 获取内核 Mount ID 和 `fstatvfs` 设备标识，以 `O_NOFOLLOW` 方式核对哨兵节点。如果发现挂载点被容器内恶意技巧逃逸或未完全对齐，立即硬性中止进程。
- **容器运行时套接字屏蔽（Runtime Sockets Masking）**：
  在 [reference/grok-build/crates/xai-grok-sandbox/src/runtime_sockets.rs:25-85](file:///c:/Software/conex/reference/grok-build/crates/xai-grok-sandbox/src/runtime_sockets.rs#L25-L85)，为了防止具有网络/执行权限的命令探测并连接宿主的容器引擎（这是一种极其经典的容器逃逸攻击手段：通过挂载宿主 `/var/run/docker.sock` 控制 Docker Daemon 获得宿主 root 权限），Grok-Build 扫描并硬性屏蔽：
  - `/var/run/docker.sock` 与 `/run/docker.sock`
  - `/run/podman/podman.sock`
  - `/run/containerd/containerd.sock`
  无论任何配置文件如何配置放行，这些套接字都会被自动覆写为 `0o000` 节点或直接禁止映射。
- **全局 Git Hook 恒等锁定（Global Hook Identity Locking）**：
  在 [reference/grok-build/crates/xai-grok-sandbox/src/hook_write_deny.rs:30-140](file:///c:/Software/conex/reference/grok-build/crates/xai-grok-sandbox/src/hook_write_deny.rs#L30-L140)，为了防止执行 `git commit` 时恶意篡改 Git Hooks 导致任意代码执行，Grok-Build 检查每个 hook 的 `dev`、`ino` 与 `nlink`（硬链接计数），凡是符号链接、硬链接数异常或所有者不匹配的 hook，一律拒绝执行与写入。

---

## 五、反混淆与逃逸防御机制（De-obfuscation & Anti-Escape Defense）

| 攻击场景与逃逸手法 | Conex 防御机制及代码证据 | Grok-Build 防御机制及代码证据 |
| :--- | :--- | :--- |
| **字符拼接与混淆调用**<br>（例：`` `I`E`X `` 或 `"d"+"el"`） | **AST 词法规范化**：`semantics.rs:80-112`<br>剥离所有内嵌的反引号、单双引号及多余空白，重构为真实词素后再过门禁。 | **弱防御（依赖内核）**：不分析指令文本，若被注入则在 bwrap / Landlock 中拦截底层 syscall。 |
| **Base64 / 编码命令绕过**<br>（例：`powershell -e <B64>`） | **全编码模式匹配与解码**：`semantics.rs:125-138`<br>覆盖 `-enc`, `-e:`, `/e:`, `-encodedcommand`，解码后递归提取内部语义。 | **无应用层解码检查**：无法审计 Base64 后的实际行为意图。 |
| **容器运行时逃逸**<br>（通过 Docker Socket 提权） | **应用层命令门禁拦截**：`lib.rs:50-70`<br>直接在沙箱正则与白名单层拦截 `docker run -v /:/` 等恶意挂载。 | **VFS 物理屏蔽**：`runtime_sockets.rs:32-60`<br>在 VFS 挂载阶段直接覆盖所有 docker/podman 命名套接字，使其不可连。 |
| **异步 IO / 网络通道逃逸**<br>（通过 `io_uring` 旁路） | **无底层拦截**：主要依赖宿主无特权与外部网络隔离策略。 | **内核级 BPF 阻断**：`child_net.rs:75-92`<br>Seccomp 显式禁用 `SYS_io_uring_setup`，封死异步系统调用绕道可能。 |
| **恶意死循环 / 回溯炸弹**<br>（ReDoS 攻击分析器） | **深度计数熔断器**：`semantics.rs:38-42`<br>深度超过 5 降级为危险，超过 16 判定为 Redline 并截断，计算复杂度恒定 O(1)。 | **无文本解析器**：不存在此类应用层 ReDoS 隐患。 |
| **破坏性 Git Revert 灾难**<br>（连续大范围强行丢弃代码） | **C3 区域阈值 + C4 滑动窗口**：`revert.rs` & `revert_guard.rs`<br>单次超限需强制审批，600 秒内第二笔 Revert 强制拦截。 | **无特定 Git 语义防护**：完全依赖 Git 自身机制与文件修改权限。 |

---

## 六、资源配额、进程树生命周期与熔断保护（Resource Quota & Process Lifecycle）

### 1. Conex：Windows 作业对象 + 双阶段两极终止法

针对失控进程与后台守护任务，Conex 构建了细致的状态转换与清理保障：

- **双阶段终止机制（Two-Stage Process Termination）**：
  在 [apps/agent-workbench/src-tauri/src/bg_kill.rs:20-75](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/bg_kill.rs#L20-L75)，当终止一个失控或超时的后台任务时：
  1. 第一阶段：发送软性终止信号（Windows 发送 `CTRL_BREAK_EVENT`，POSIX 发送 `SIGTERM`），等待最多 5000 毫秒；
  2. 第二阶段：若进程未退出，强制调用内核级 `TerminateJobObject` / `SIGKILL` 强杀整个作业树；
  3. 退出后，通过校验释放所有占用句柄。
- **输出缓冲区预算限制（Output Budget Clamping）**：
  在 [crates/agent-tools/src/tools/shell_output.rs:15-45](file:///c:/Software/conex/crates/agent-tools/src/tools/shell_output.rs#L15-L45)，Conex 限制单次执行的标准输出与标准错误总字节数（预算约数百 KB 到数 MB）。若子进程产生持续刷屏的日志风暴，输出流到达阈值后会被主动切断并追加 `[Output truncated]` 标记，保护前端渲染管线与内存不会被 OOM 撑爆。

### 2. Grok-Build：Linux Cgroups v2 监控与 5GB 终端截断

- **Cgroups v2 内存水位与 Inotify 软 OOM**：
  在 [reference/grok-build/crates/xai-grok-tools/src/cgroup.rs:30-110](file:///c:/Software/conex/reference/grok-build/crates/xai-grok-tools/src/cgroup.rs#L30-L110)，Grok-Build 深度利用了 Linux 现代控制组技术：
  ```rust
  // reference/grok-build/crates/xai-grok-tools/src/cgroup.rs:52-85
  // 配置 memory.high (软限制) 与 memory.max (硬限制)
  // 利用 inotify 监听 cgroup 目录下的 memory.events 事件
  if event.high_count > 0 || event.max_count > 0 {
      // 触发应用级治理，以优雅方式终止并返回退出码 137 (OOM Killed)
  }
  ```
  这避免了 Linux 内核随机杀死系统其他关键进程（Badness heuristic），使内存限制具有确定性。
- **终端 Actor 吞吐硬顶（Terminal Output Cap）**：
  在 [reference/grok-build/crates/xai-grok-tools/src/terminal.rs:35-70](file:///c:/Software/conex/reference/grok-build/crates/xai-grok-tools/src/terminal.rs#L35-L70)，Grok-Build 在本地终端守护线程中维护环形输出缓冲，设置了高达 5GB 的绝对安全硬上限，并在超过上限时丢弃旧帧。

---

## 七、多代理并发安全与权限边界（Multi-Agent Security & Tool Pruning）

在多智能体协作（Multi-Agent Swarm）模式下，子 Agent 的权限失控是当下系统安全的前沿挑战。

### 1. Conex：硬性递归守卫与任务类型工具裁切

在 [crates/agent-tools/src/tools/subagent/guard.rs:18-65](file:///c:/Software/conex/crates/agent-tools/src/tools/subagent/guard.rs#L18-L65) 与 [crates/agent-tools/src/readonly.rs:15-55](file:///c:/Software/conex/crates/agent-tools/src/readonly.rs#L15-L55)，Conex 做出了极具防御性的工程约束：

- **深度为 1 的嵌套硬禁令（Depth=1 Guard）**：
  ```rust
  // crates/agent-tools/src/tools/subagent/guard.rs:32-46
  if current_depth >= 1 {
      return Err(SubagentError::NestingDenied(
          "You do not have the capability to create subagents. \
           All subagents are allocated by the main agent."
      ));
  }
  ```
  在工具注册表层面，派发给子 Agent 的工具包中直接剥除 `invoke_subagent`。即便 Agent 通过提示注入尝试调用，守卫层仍会硬返回 `subagent.nesting_denied`，彻底遏制失控递归派生（Fork Bomb）的可能性。
- **动态工具链裁切（Tool Pruning by Task Type）**：
  在 `readonly.rs` 中，根据子 Agent 的职责类型动态降权：
  - 若子任务属于分析/方案/探索型：剔除所有写工具与 Shell 执行工具；
  - 若属于实现型：保留受控写工具，但强制剔除 `browser_*`（浏览器工具），避免网络通道与外部提示注入串通。

### 2. Grok-Build：单一 Agent 终端模型与无多 Agent 工具链

在 Grok-Build 现存代码库（`xai-grok-tools`）中，其设计模型主要服务于单会话长连接终端与工具调用，未发现内置的多 Agent 递归派生守卫、权限树隔离或跨代理写冲突锁定机制。其并发安全主要托付给 Bubblewrap 沙箱实例的相互独立性。

---

## 八、全面技术规格对照矩阵与工业级成熟度评分

| 特性分类 | 具体安全机制与检查点 | Conex 实现状态与代码位置 | Grok-Build 实现状态与代码位置 | 领先方与评价 |
| :--- | :--- | :--- | :--- | :--- |
| **命令预检** | 正则表达式快速初筛 | 完整 (`lib.rs:24-95`) | 基础/仅关键词匹配 | **Conex**：具备完整的预编译规则集 |
| | AST 词法分析与去混淆 | 完整 (`semantics.rs:27-142`) | 无 | **Conex**：具备反转义、去引号及 Token 还原能力 |
| | .NET/PowerShell 动态反射防御 | 完整 (`semantics.rs:115-140`) | 无 | **Conex**：精准识别并拦截隐藏执行语法 |
| | ReDoS 回溯分析熔断器 | 完整 (`semantics.rs:38-42`) | 无需（无解析器） | **Conex**：具备深度断路保护 |
| **沙箱隔离** | Linux Namespaces / bwrap | 无 | 完整 (`lib.rs:45-210`) | **Grok-Build**：工业级顶级实现 |
| | Linux Landlock LSM 规则 | 无 | 完整 (`lib.rs:170-205`) | **Grok-Build**：自适应内核版本控制 |
| | macOS Seatbelt 沙箱规则 | 无 | 完整 (`deny/glob.rs`) | **Grok-Build**：支持 Scheme 编译与 Firmlink |
| | Windows 作业对象 (Job Objects) | 完整 (`process.rs:45-90`) | 无 (Stub/No-op) | **Conex**：Windows 平台绝对优势 |
| | Seccomp BPF 网络隔离 | 无 | 完整 (`child_net.rs:35-145`) | **Grok-Build**：零分配、带 io_uring 拦截 |
| **文件防护** | 物理删除安全重定向 (Trash) | 完整 (`conex-fs/trash.rs`) | 无 | **Conex**：SHA256、元数据、秒级可逆回滚 |
| | 挂载点内核级校验 (`SYS_statx`) | 无 | 完整 (`read_deny_verify.rs`) | **Grok-Build**：防止挂载逃逸与符号链接旁路 |
| | 容器套接字主动屏蔽 (Docker) | 应用层正则拦截 | 物理覆盖 (`runtime_sockets.rs`) | **Grok-Build**：VFS 挂载级彻底屏蔽 |
| | 多 Agent 工作区写路径互斥锁 | 完整 (`write_paths.rs`) | 无 | **Conex**：防止并发写竞态与脏数据 |
| **资源控制** | 进程树完整收敛 (KillOnClose) | 完整 (`process.rs:68-75`) | 依赖容器生命周期 | **平手**：各在平台端做到极致 |
| | Cgroups v2 内存监控与软 OOM | 无 | 完整 (`cgroup.rs:30-110`) | **Grok-Build**：监控水位与事件精确捕获 |
| | 输出流字节预算截断 | 完整 (`shell_output.rs`) | 完整 (`terminal.rs:35-70`) | **平手**：均具备防 OOM 截断策略 |
| **Agent安全**| 子 Agent 递归深度熔断 (Depth=1) | 完整 (`subagent/guard.rs`) | 无多代理机制 | **Conex**：刚性遏制代理递归爆炸 |
| | 角色工具链动态裁切 | 完整 (`readonly.rs`) | 无 | **Conex**：职责降权与浏览器通道封堵 |

### 工业级成熟度综合评分（满分 100 分）

- **Conex 系统安全防御体系：86 / 100**
  - **核心优势**：在应用层、AST 语义分析层、安全回滚层以及 Windows 宿主保护层构筑了极其严密的纵深防御。对 AI Agent 最常产生的危险（误删、递归调用、混淆绕过、Git 误操作）提供了极其出色的韧性。
  - **减分项**：在 Linux / macOS 端缺乏基于操作系统内核级 LSM（Landlock/SELinux）或 Namespaces 的底层系统调用强隔离。
- **Grok-Build 系统安全防御体系：88 / 100**
  - **核心优势**：在 Linux 平台拥有教科书级别的系统底层工程实力。Bubblewrap、Landlock ABI 探测、Seccomp BPF 零分配字节码、`statx` 挂载验证、Cgroups v2 事件监听，构成了极强的内核防线。
  - **减分项**：对 Windows 平台几乎完全缺乏工业级支持；对应用层命令 AST、PowerShell 反射混淆几乎完全不加审查；缺乏删除保护机制，破坏即物理丢失。

---

## 九、技术洞察与演化建议（双向借鉴）

### 1. Conex 可向 Grok-Build 借鉴之处

1. **引入 Linux / macOS 轻量内核隔离层**：
   - 借鉴 Grok-Build 在 `xai-grok-sandbox/src/lib.rs` 中的设计，在 POSIX 环境下为 Conex 引入可选的 Bubblewrap 或 Landlock LSM 支持；
   - 即使命令通过了应用层 AST 门禁，对于执行外部任意二进制程序（如编译产物、未知脚本），在底层收口文件与网络访问权限。
2. **底层屏蔽容器套接字**：
   - 借鉴 `runtime_sockets.rs`，在路径检查与环境探测中，直接加入对 Docker / Podman / Containerd 宿主套接字文件的物理遮蔽，防止提权逃逸。
3. **Seccomp BPF 阻断不受控子网络**：
   - 借鉴 `child_net.rs` 的零内存分配预执行 BPF 过滤器，针对不需要网络的命令提供物理级隔离。

### 2. Grok-Build 可向 Conex 借鉴之处

1. **补全应用层命令语义与 AST 反混淆门禁**：
   - Grok-Build 完全依赖底层内核隔离，对恶意 Agent 的命令混淆、字符拼接或编码绕过完全盲目；引入类似 Conex `semantics.rs` 的词法归一化引擎，能在应用层早期直接快速掐断恶意意图。
2. **实现可逆物理删除机制（Trash Redirection）**：
   - 目前 Grok-Build 在容器内如果被 Agent 执行了 `rm -rf`，工作区代码将发生不可逆损毁；借鉴 Conex `conex-fs/trash.rs`，将危险删除转化为带校验和的快照归档，大幅提升真实编程场景下的安全性。
3. **建立 Windows 平台 Job Object 支持**：
   - Grok-Build 在 Windows 端几乎是空白实现；引入 Conex 的 Windows Job Objects 与 `KILL_ON_JOB_CLOSE`，才能使产品具备真正的全平台生产力。
4. **多代理并发防撞与递归守卫**：
   - 借鉴 Conex 的 `Depth=1` 递归防爆守卫与 `WritePathPolicy` 路径互斥锁，为未来的多智能体编排打下安全基石。
