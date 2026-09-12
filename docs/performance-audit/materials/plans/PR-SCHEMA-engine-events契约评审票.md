# PR-SCHEMA · engine-events 载荷与双发治理（契约评审票）

> **状态**：**待评审** — 未通过前禁止改 wire 载荷形状  
> **阻塞**：03-R2 双发消除、03-C1 message-start 瘦身、10-T3 Progress-A、tool-batch 摘要化  

## 议题包

| ID | 变更 | 依赖 |
| -- | ---- | ---- |
| A | 非增量事件收口改回执/单发；旁路 WS/push 保留完整事件 | CFL-16 铁律 |
| B | `message-start` 载荷降摘要（前端 live/replay 零消费已核） | 消费端回归 |
| C | tool-batch-* 降 NoPersist 或摘要化 | EV-09 已部分摘要 |
| D | ToolProgress 语义 | 见 PR-PROGRESS |

## 通过后必做

1. `engine-events.json` + `events.rs` + 生成 parser + `registry_drift` + golden  
2. schemaVersion 策略  
3. 旧字段根除负向断言  
4. wire 体积对比（INV-1）  

## 会签

| 角色 | 决定 | 日期 |
| ---- | ---- | ---- |
| 主控 | — | — |
| 架构 | — | — |
