# PR-PROGRESS · 工具 Progress 语义三选一会签

> **状态**：**待会签** — 未通过前禁止静默删除构造；禁止假接线传 `None`  
> **发现**：10-T3 / CFL-12  

## 现状锚点

- `crates/session-loop/src/loop/exec_single.rs` — progress 恒 `None`  
- `executing_tools.rs` — 批收口才广播事件；长批/审批期前端无 tool 卡片更新  
- 前端消费面：工具卡片流式输出（02 T2/T3）  

## 选项

| 选项 | 内容 | 契约 |
| ---- | ---- | ---- |
| **A 接线** | 执行器填充 ToolProgress；批内实时 emit；前端已消费 | 可能需 PR-SCHEMA / PR-ORDER |
| **B 停止构造** | 删除 ToolProgress 构造与死字段；文档明确不支持流式工具进度 | schema 清理 + 负向根除 |
| **C 部分接线** | 仅 shell 等已有 execute_stream 的工具接线；其余保持 B 语义 | 部分 T2 |

## 会签

| 角色 | 选项 A/B/C | 日期 |
| ---- | ---------- | ---- |
| 主控 | — | — |
| 用户/产品 | — | — |

**未会签前**：维持现状；修复不得伪装为 Progress 已优化。
