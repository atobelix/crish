# Conex 反过度设计硬性红线指南 (Anti-Overengineering Guardrails v2.0)

> 本文档规定了 Conex / Crish 项目在架构设计、后端 Rust、运行时引擎、前端 UI、移动多端及工程治理方面的**反过度设计（Anti-Overengineering）硬性红线**。
> 所有人类开发者及 AI Coding Agent 在阅读、修改或新增代码时，**必须严格遵守本文档的 13 项明确禁令**，严禁将已剔除的过度设计抽象重新引入代码库。

---

## 一、系统底座与持久化安全 (Core System & Persistence)

### 🚫 禁令 1：严禁编写跨平台 OS 内核级沙盒 (Seatbelt / Seccomp / Cgroups)

- **原则**：桌面端应用无须引入操作系统内核 C 绑定（如 `macOS Seatbelt/sandbox_init` 或 `Linux seccomp-bpf/cgroups`）来实现底层容器级隔离，此类设计维护成本高昂且极易因系统补丁而崩溃。
- **允许且仅保留 3 项实效防护**：
  1. **指令级防爆网 (`CommandGatekeeper`)**：基于 Rust `RegexSet` 与 AST 语义解析的毁灭性指令硬拦截（如 `rm -rf /`, `format C:`, `dd` 等）。
  2. **进程树生命周期保护 (`process_tree`)**：Windows `Job Object` (`KILL_ON_JOB_CLOSE`) 与 Unix `pgid` 进程组，确保主进程退出时子进程零孤儿泄露。
  3. **用户审批与权限隔离 (UIPI / Approval)**：无状态决策引擎与前台弹窗授权。

### 🚫 禁令 2：严禁编写 Rust 端无锁环形缓冲区 (`sab_ring_buffer`) 与极端零拷贝

- **原则**：桌面端大模型文本传输速率极低（仅 10~50 Token/s，约 2 KB/s 级别），Rust 语言原生 Channel 和 String Buffer 的 CPU 占用趋近于 0%。
- **硬性约束**：彻底禁止在 Rust 端编写 C 语言级别的 SharedArrayBuffer 无锁 RingBuffer。文本传输统一使用标准 Tokio `mpsc` 通道与 `Arc<AgentMessage>` 不可变共享。

### 🚫 禁令 3：严禁在单机桌面端引入分布式共识协议与两阶段提交 (2PC / Raft / Paxos)

- **原则**：单机本地存储（SQLite + WorkspaceStore）绝非分布式集群，严禁将分布式数据库的共识算法往本地套用。
- **硬性约束**：本地存储一致性一律基于**「单写者模式 + Windows 3 阶段原子重命名写入 + SQLite WAL Group Commit + CAS 乐观版本号 (`WHERE rev = ?`)」**，严禁自制两阶段提交（2PC）或 Paxos/Raft 共识网络。

---

## 二、大模型协议与上下文治理 (LLM Protocols & Context Governance)

### 🚫 禁令 4：严禁后台自动切换模型 (废弃 `DynamicModelRouter` / `FallbackChain`)

- **原则**：不同模型（如 Claude 3.7 vs Gemini 2.5 vs DeepSeek-R1 vs GPT-4o）的推理深度、Prompt 遵循度及 Tool Call 格式差异巨大，后台无感知自动切模型会导致输出质量崩溃、上下文污染或非预期扣费。
- **硬性约束**：
  1. 用户在 UI 选定了什么模型，请求就**固定使用该模型**。
  2. 发生网络超时、5xx 服务端错误或 429 限流时，**仅在当前选定模型上做指数退避重试 (Exponential Backoff Retry)**。
  3. 严禁在用户未明确授权的情况下，自动为用户降级/切换至其他模型。

### 🚫 禁令 5：严禁出站请求前发起 DNS A/AAAA 异步解析与公有后缀检查

- **原则**：在 API 请求前发 DNS 解析极易误杀本地 Ollama (`http://localhost:11434`)、局域网私有网关或内网代理，且增加无谓的请求往返延迟。
- **硬性约束**：取消请求前的 DNS A/AAAA 域名解析与公有后缀校验。仅保留基础的 `http:` / `https:` 语法格式校验。

### 🚫 禁令 6：严禁在 LLM 请求链路中加入黑盒「Prompt 意图重写与动态拦截链」

- **原则**：严禁在用户输入与模型之间插入未声明的黑盒 Agent 或拦截器来篡改用户提示词，这会破坏输入输出的确定性并导致调试灾难。
- **硬性约束**：用户输入的指令必须如实、透明传入模型；所有上下文切片注入、系统提示词拼接与工具定义必须在 UI/Trace 中完全可见且可复现。

### 🚫 禁令 7：注入到上下文的一切链路都必须可审计、可追踪，且保证单一真相源 (Single Source of Truth)

- **原则**：大模型上下文是决定系统行为的核心生命线，任何隐式注入、未留痕切片或多源状态分裂均属于严重架构缺陷。
- **硬性约束**：
  1. **全链路可审计与可追踪**：所有注入到上下文的消息、System Prompt、文件引用、历史摘要、工具调用入参/出参，必须具备全局 Trace 留痕（精确绑定 `run_id`、`tool_call_id`、`occurred_at_ms` 与物理时戳）。
  2. **单一真相源 (SSOT)**：同一份会话状态与上下文在内存中只能存在唯一权威真源，严禁维护多套平行的状态树并在各层之间手动修补对齐。

### 🚫 禁令 8：多 Provider 凭据零残留与安全隔离

- **原则**：桌面应用无须设计复杂的 3 层 CLI 命令行交互式降级链；多 Provider 凭据必须强隔离以防串扰。
- **硬性约束**：
  1. 凭据存储统一基于 OS Keychain / Windows DPAPI 加密存储与环境变量隔离，严禁将明文 API Key 写入普通 LocalStorage 或日志文件；
  2. 运行时内存中的 `SecretString` 在 `Drop` 时必须执行 volatile 内存覆写清零；
  3. 各 Provider 环境变量（`OPENAI_*`, `ANTHROPIC_*`, `GEMINI_*`）严格分立，严禁降级串扰劫持。

---

## 三、架构状态机与并发通信 (Architecture, State & Concurrency)

### 🚫 禁令 9：严禁使用全系统滑动窗口断路器 (`CircuitBreaker`)

- **原则**：单体桌面端使用全系统级的滑动窗口熔断器会导致用户在网络偶发抖动后被长时间锁死在 `Circuit Open` 状态。
- **硬性约束**：彻底移除全局滑动窗口熔断器。仅保留针对单个 Provider API 的标准 HTTP 429 `Retry-After` 退避阶梯与指数重试，遇到不可恢复错误抛出明确提示，由用户决定重试。

### 🚫 禁令 10：严禁设计 Tool 执行的 6 阶段洋葱 Hook 链 (`MiddlewarePipeline`)

- **原则**：过长且嵌套的生命周期钩子链导致工具执行路径极其难以排查和追踪。
- **硬性约束**：精简 Tool 执行 Hook 链，仅保留 **`beforeExecute`（防爆网拦截与用户审批）** 与 **`onResult / onError`（执行结果与日志留痕）** 两大明确锚点。

### 🚫 禁令 11：严禁同进程微服务套娃与 Tauri IPC 嵌套字符串路由

- **原则**：Tauri 原生自带高效 IPC Command 派发系统 (`#[tauri::command]`)，同进程内部无须进行虚假解耦。
- **硬性约束**：
  1. Tauri Command 处理函数必须直调 Rust 底层业务函数，严禁在内部再套一层 HashMap 字符串匹配 Router 造成多重 JSON 序列化消耗；
  2. 同进程内禁止设计 4~5 层逐级转发的虚假 Store/Service Facade（如 `layoutStore -> sessionCoordinator -> chatStore -> streamStore`）。

---

## 四、前端渲染、算法与多端协同 (Frontend, Algorithms & Multi-Device)

### 🚫 禁令 12：严禁高频流式状态穿透全局 Store 与盲目包裹 `React.memo`

- **原则**：高频流式输出与输入状态频繁打入根状态树会导致整个 React 虚拟 DOM 树发生灾难性重渲染。
- **硬性约束**：
  1. 严禁将大模型逐字流式 Token、按键高频输入或光标位置写入全局 Zustand Store；
  2. 大模型流式文本输出统一采用 `StreamingTextBlock` 原生增量 TextNode 追加（`appendChild` / `textContent`），规避虚拟 DOM Diff；
  3. 严禁编写要求 95% `React.memo` 覆盖率的虚假 CI 门禁脚本；`React.memo` 只能精准施加于消息行（`ChatMessageRow`）、虚拟列表项等重度叶子组件。

### 🚫 禁令 13：严禁移动端全量 CRDT 状态向量下沉与无界同步

- **原则**：轻量级移动设备与后台推送环境无法承担全量富文本状态树与复杂向量合并的高内存与 CPU 开销。
- **硬性约束**：
  1. 多端互通严格收敛为**「轻量级 Frame 协议 + 增量事件推送 + 24h 本地去重 + 读时拉取」**，严禁将重型协同算法引擎全量下沉到移动端后台；
  2. **【明确放行与鼓励的自研核心资产】**：自研因果 Undo、IME 组合对抗缓冲（`ImeCompositionBuffer`）、`diffToReplace` 差量算法、Unicode 标量坐标体系、Block 块模型抽象与 FTS 检索分词，属于 Conex 的核心护城河资产，严格受保护并不受本禁令限制。

---

## 五、执行与 CI 门禁纪律 (Enforcement)

1. 所有架构设计方案、Feature 开发、代码重构及 Bug 修复必须严格对照本文档的 **13 项红线** 进行自检与互审。
2. 任何引入上述 13 项过度设计的代码提交均视为严重违规，门禁与审计 Agent 必须予以阻断并限期整改。
