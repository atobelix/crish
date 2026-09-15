# Conex 吸收 DeepSeek Harness 架构精髓演进路线图 (Roadmap)

> **战役工作区**：`docs/deepseek-harness-comparison/`  
> **审计基线**：基于 `audits/` 目录下 6 份深入源码级的对比审计报告（总计 230KB+ 翔实代码证据）。

---

## 一、综合技术能力雷达图与终局裁判

经过对双方共计数十万行源码的逐行审计，双方在核心维度的真实得分如下（百分制）：

| 核心维度 | Conex (Crish) | DeepSeek Harness (DSH) | 胜出方 | 核心结论与技术高下 |
| :--- | :---: | :---: | :---: | :--- |
| **1. 状态机严密性与控制流** | **98** | 65 | 🏆 **Conex** | Conex 160 矩阵全穷举转移表 + L0-L3 安全点平滑收敛，远胜 DSH 松散三态与粗暴 Abort |
| **2. 运行时性能与桌面架构** | **95** | 68 | 🏆 **Conex** | Conex 进程内单进程 Rust+Tauri2（40MB 内存/0Hz 待机），碾压 DSH 笨重的 Electron+Node+pnpm（350MB+） |
| **3. 多任务并发文件安全** | **96** | 35 | 🏆 **Conex** | Conex 的 `WritePathRegistry` 细粒度互斥锁防脑裂，DSH 工具层完全无多 Agent 写互斥 |
| **4. 工具交互范式 (PTC)** | 40 | **98** | 🏆 **DSH** | DSH 独创 Program-The-Call 代码模式，节省 70%+ Token 与 RTT，领先 Conex 整整一代 |
| **5. 操作系统级内核沙箱** | 35 | **96** | 🏆 **DSH** | DSH 具备真正的 Win32 受限令牌/bwrap/Seatbelt 物理内核隔离；Conex 仅为应用态 AST 黑名单，底层裸机执行 |
| **6. 协议标准化与外部生态** | 10 | **96** | 🏆 **DSH** | DSH 拥有工业级 ACP 服务端与专业三层 LSP 客户端；Conex 零 ACP、零 LSP，高度私有封闭 |
| **7. 事件溯源与压缩自愈** | 80 | **94** | 🏆 **DSH** | DSH 单一事件源（SSOT）+ RFC 8878 Zstd 裸帧扫描 + 悬挂调用合成自愈（`repair.ts`），架构极度纯粹 |
| **8. 综合工程成熟度** | **84.5** | 77.4 | ⚖️ **各有千秋** | **做框架生态 DSH 赢，做桌面端生产力工具 Conex 赢** |

---

## 二、Conex 必须立即落地的四大核心架构升级

### 1. 落地 Win32 受限令牌（Restricted Token）物理内核沙箱（优先级：P0）
- **根因痛点**：`crates/agent-tools/src/tools/shell_invoke.rs:64-85` 显示，当前在 Windows 上直接以当前用户权限运行裸机 `powershell.exe -ExecutionPolicy Bypass`，应用层 AST 是典型的“马奇诺防线”。
- **吸收方案**：
  - 借鉴 DSH `packages/sandbox/sandbox-windows-acl/src/token.ts`；
  - 在 Rust 侧调用 Win32 原生 API `CreateRestrictedToken`，剥离 `Authenticated Users` 与 `INTERACTIVE` 权限，设置 `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`；
  - 为每个 Session 生成独立的临时目录 SID，并严格挂载工作区写入 ACE，彻底终结 Windows 裸机执行逃逸风险。

### 2. 引入 PTC (Program-The-Call) 代码调用范式（优先级：P0）
- **根因痛点**：Conex 仍使用单轮 ToolCall，在大型重构或海量文件搜索时频繁发生上下文 Token 爆炸和多轮往返等待。
- **吸收方案**：
  - 借鉴 DSH `packages/core/tools/src/ptc.ts` 与 `ts-types.ts`；
  - 增加 `run_code` 工具，动态为已注册的工具生成强类型声明注入 System Prompt；
  - 在轻量级沙箱中执行模型编写的脚本，中间海量过滤逻辑在沙箱内消耗，仅将最终精炼结果回填给模型上下文，大幅削减 70% 的 Token 开销。

### 3. 引入悬挂调用合成修复（Tool Abort Repair）（优先级：P1）
- **根因痛点**：Conex 在任务被打断（Abort）或崩溃重启时，未执行的工具调用块缺失成对的 ToolResult，导致会话历史残留孤儿 `tool_use_id`，容易引发上游模型 400 报错。
- **吸收方案**：
  - 借鉴 DSH `packages/core/agent-loop/src/tool-calls.ts`（`appendSkippedToolCall`）与 `packages/core/session/src/repair.ts`（`interruptedTurnClosers`）；
  - 当检测到批量工具中途被中断时，自动为剩余未派发的工具合成携带 `TOOL_ABORTED_BEFORE_DISPATCH` / `TOOL_OUTCOME_UNKNOWN` 的确定性结果块，保证历史严格成对。

### 4. 接入 ACP (Agent Client Protocol) 与三层 LSP 客户端（优先级：P1）
- **根因痛点**：Conex 缺乏外部协议标准互通能力，且代码分析完全依赖文本正则 grep。
- **吸收方案**：
  - 借鉴 DSH `packages/acp/`，在 Rust 侧暴露标准的 ACP stdio JSON-RPC 接口，使 Conex 能够被第三方客户端或上层编排系统直接调度；
  - 借鉴 DSH `packages/lsp/`，实现轻量级 LSP 客户端通道，为模型提供符号级的精准定义跳转与引用查找。

---

## 三、Conex 内部技术债务清理清单

1. **消除持久化三源漂移与写放大**：
   - 废除 `messages.rs` 中每次写入全量 `DELETE + INSERT` 的反模式；
   - 彻底收口 `events.rs` 与 `messages.rs`，消灭直接拿全局连接互斥锁 `self.conn.lock()` 的裸写，全量统一走 `DbWriteHandle` 组提交 Actor。
2. **注册表引入 RAII 撤销守卫**：
   - 为 `ToolRegistry` 与 `HookRegistry` 补充动态注销 API，并提供实现 `Drop` 的 `RegistrationGuard`，支持插件动态卸载。
3. **修复异步循环中同步 Mutex 中毒**：
   - 将 `handlers/executing_tools.rs` 中的同步 `Mutex` 替换为无死锁的并发容器或 Tokio 异步锁，消除锁中毒时使用脏数据的风险。
