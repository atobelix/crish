# 维度五：多 Agent 协同与 ACP 生态协议对比

> **战役工作区**：`docs/deepseek-harness-comparison/`  
> **对比范围**：DeepSeek Harness subagent / Agent Teams / ACP / LSP vs Conex 子代理调度与死锁防护

---

## 一、对标核心源码路径

- **DeepSeek Harness (`dsh`)**：
  - `packages/subagent/subagent/src/index.ts` (子代理能力 Seam 与生命周期)
  - `packages/acp/acp/src/index.ts` (Agent Client Protocol 标准服务器)
  - `packages/lsp/tool-lsp/src/index.ts` (LSP 客户端工具：定义/引用/悬停)
  - `packages/experimental/agent-team/src/` (多 Agent 团队协作与邮箱)
- **Conex (Crish)**：
  - `crates/session-loop/src/approval_router.rs` (子代理申请路由与死锁解除)
  - `AGENTS.md` (§2 子 Agent 调度铁律与单层嵌套)
  - `crates/orchestrator/src/` (多会话树形追踪)

---

## 二、架构设计与机制对比

### 1. 协议生态
- **DSH**：实现了官方标准 ACP 协议，可直接被第三方标准化客户端纳管；内置专业 LSP 工具。
- **Conex**：私有 Tauri 命令集与本地事件通道，主要服务于自身桌面产品。

### 2. 死锁与并发协作
- **DSH**：基于 Continuation Manager 与 Mailbox 传递消息。
- **Conex**：针对“主 Agent 等待子代理，子代理请求权限”典型死锁场景，自研了智能转用户裁决机制（`route_approval_guarded`）与 120s 超时兜底，并在写路径上强制互斥（`WritePathRegistry`）。

### 3. 优劣裁判与高下判定
- **生态与协议**：**DSH 胜出**（ACP 与 LSP 是极具生产力的基建）。
- **执行安全与防死锁**：**Conex 胜出**（对子 Agent 权限传递与死锁防范考虑更周全）。
