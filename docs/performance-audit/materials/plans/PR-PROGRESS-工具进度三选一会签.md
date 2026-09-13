# PR-PROGRESS · 工具 Progress 语义三选一会签

> **状态**：**主控已裁决选项 B**（wire 无 Progress；终值 tool-end）  
> **发现**：10-T3 / CFL-12  

## 现状锚点

- `crates/session-loop/src/loop/exec_single.rs` — progress 恒 `None`（内部流仍可有 ToolStreamItem::Progress）  
- `executing_tools.rs` — 批收口才广播事件；长批/审批期前端无 tool 卡片更新  
- 前端消费面：工具卡片流式输出（02 T2/T3）；**无 wire Progress 消费**  
- R1 战役已删除 `tool-update` / `ToolEvent::ToolProgress` AgentEvent  

## 选项

| 选项 | 内容 | 契约 |
| ---- | ---- | ---- |
| **A 接线** | 执行器填充 ToolProgress；批内实时 emit；前端已消费 | 可能需 PR-SCHEMA / PR-ORDER |
| **B 停止构造** | 删除 ToolProgress 构造与死字段；文档明确不支持流式工具进度 | schema 清理 + 负向根除 |
| **C 部分接线** | 仅 shell 等已有 execute_stream 的工具接线；其余保持 B 语义 | 部分 T2 |

## 会签

| 角色 | 选项 A/B/C | 日期 |
| ---- | ---------- | ---- |
| 主控 | **B** | 2026-09-13 |
| 用户/产品 | —（主控裁决落地；用户可改票） | — |

## 主控裁决说明

- wire 层 **明确无 Progress 事件**；终值由 `tool-end` 承载。  
- 内部 `ToolStreamItem::Progress` 仅执行器内部流，**不映射 AgentEvent**。  
- 选项 A 需另开 PR-SCHEMA 子票；禁止静默恢复 tool-update。  

