# Conex 反过度设计硬性红线指南 (Anti-Overengineering Guardrails)

> 本文档规定了 Conex 项目在架构设计、后端 Rust、运行时引擎、前端 UI 及 CI/CD 方面的**反过度设计（Anti-Overengineering）硬性红线**。
> 所有人类开发者及 AI Coding Agent 在阅读、修改或新增代码时，**必须严格遵守本文档的 10 项明确禁令**，严禁将已剔除的过度设计抽象重新引入代码库。

---

## 1. 沙盒与内核隔离 (Sandboxing & OS Isolation)

### 🚫 禁令 1：严禁编写跨平台 OS 内核级沙盒
- **原则**：禁止试图通过 `macOS Seatbelt/sandbox_init` 或 `Linux seccomp-bpf/cgroups` 等操作系统内核 C 绑定来实现底层容器级隔离。
- **允许且仅保留 3 项**：
  1. **指令级防爆网 (`CommandGatekeeper`)**：基于 Rust `RegexSet` 的 11 条毁灭性指令硬拦截（如 `rm -rf /`, `format C:`, `dd` 等）。
  2. **进程树生命周期保护 (`process_tree`)**：Windows `Job Object` (`KILL_ON_JOB_CLOSE`) 与 Unix `pgid` 进程组，确保主进程退出时子进程零孤儿泄露。
  3. **用户审批与信任区 (Approval Pipeline T0-T4)**：由无状态决策引擎与弹窗交互授权。

### 🚫 禁令 2：严禁编写 Rust 端无锁环形缓冲区 (`sab_ring_buffer`) 与极致零拷贝
- **原则**：桌面端文本传输的数据量极小（仅 2 KB/s 左右），Rust 语言原生 Channel 和 String Buffer 的 CPU 占用几乎为 0%。
- **硬性约束**：彻底禁止在 Rust 端编写 C 语言级别的 SharedArrayBuffer 无锁 RingBuffer。文本传输统一使用标准 Tokio `mpsc` 通道。

---

## 2. 模型路由、网络与安全 (Model Routing, Network & Security)

### 🚫 禁令 3：严禁后台自动切换模型 (废弃 `DynamicModelRouter` / `FallbackChain` 模型切换)
- **原则**：不同模型（如 Claude 3.5 vs DeepSeek vs GPT-4o）的 Reasoning、Prompt 遵循及 Tool Call 能力差异巨大，后台无感知自动切模型会导致输出质量崩溃或非预期扣费。
- **硬性约束**：
  1. 用户在 UI 界面选择了什么模型，请求就**固定使用该模型**。
  2. 发生网络超时、5xx 服务端错误或 429 限流时，**仅在当前选定模型上做指数退避重试 (Exponential Backoff Retry)**。
  3. 严禁自动为用户降级/切换至其他模型。

### 🚫 禁令 4：严禁出站请求前发起 DNS A/AAAA 异步解析与公有后缀检查
- **原则**：在 API 请求前发 DNS 解析极易误杀本地 Ollama (`http://localhost:11434`) 或企业内网 LLM 网关，且增加网络延迟。
- **硬性约束**：取消请求前的 DNS A/AAAA 域名解析与公有后缀校验。仅保留基础的 `http:` / `https:` 语法格式校验。

### 🚫 禁令 5：严禁设计复杂的 3 层 API 密钥 CLI 降级链
- **原则**：桌面应用无需 CLI `stdin` 命令行交互式输入逻辑。
- **硬性约束**：统一采用双层结构：“OS Keychain 为主；若 OS Keychain 不可用，由 UI 弹出设置界面让用户填写或存入本地加密文件”。

---

## 3. 架构组件与状态机 (Architecture & State Machines)

### 🚫 禁令 6：严禁使用微服务级滑动窗口断路器 (`CircuitBreaker`)
- **原则**：单体桌面端使用滑动窗口熔断器会导致用户在网络恢复后仍被锁死在 `Circuit Open` 状态，极度影响体验。
- **硬性约束**：彻底移除 `CircuitBreaker` 状态机。遇到错误直接抛出明确提示，配合指数退避重试，由用户手动决定是否重发。

### 🚫 禁令 7：严禁设计 Tool 执行的 6 阶段洋葱 Hook 链 (`MiddlewarePipeline`)
- **原则**：过长的生命周期钩子链（`beforeRegister` 到 `onError`）导致工具执行跟踪极其繁琐。
- **硬性约束**：精简 Tool 执行 Hook 链，仅保留 **`beforeExecute`（防爆网与审批）** 与 **`onResult/onError`（结果与日志）**。

### 🚫 禁令 8：严禁在 Rust Tauri Command 内部二次套娃 `IpcRouter`
- **原则**：Tauri 原生自带高效 IPC Command 派发系统 (`#[tauri::command]`)。
- **硬性约束**：Tauri Command 处理函数必须直调 Rust 底层业务函数，严禁在内部再套一层 HashMap 字符串匹配 Router 造成二次/三次 JSON 序列化消耗。

---

## 4. 前端 UI、渲染与性能 (Frontend UI, Rendering & Metrics)

### 🚫 禁令 9：严禁盲目包裹 `React.memo` 与追求 95% 强指标 CI 断言脚本
- **原则**：盲目给只有 2 行 JSX 的简单组件包裹 `React.memo`，额外的浅比较开销反而降低性能。
- **硬性约束**：
  1. 严禁编写要求 95% `React.memo` 覆盖率的 CI 断言脚本。
  2. `React.memo` 只能精准施加给**高频更新的重度叶子组件**（如消息行 `ChatMessageRow`、虚拟列表项、卡片面板 `CardPanel`）。

---

## 5. 执行纪律 (Enforcement)

1. 所有新的重构、Feature 开发及 Bug 修复必须对照本文档的 10 项红线。
2. 发现任何试图重新加入上述 10 项过度设计的 Plan 或代码，**必须立即拒绝并清理**。
