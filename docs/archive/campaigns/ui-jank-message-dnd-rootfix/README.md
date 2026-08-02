# UI 卡顿 / 消息重复 / Tab 拖拽指示器 — 根治执行包

## 范围

`apps/crish-desktop` 内三类问题：

1. 聊天消息假重复（虚拟滚动高度契约被破坏）
2. 列宽 / 窗口缩放卡顿（冻结协议双轨、未统一写入）
3. Tab 拖拽指示器错位与样式割裂（预览期 layout reflow + 多套指示器）

## 文档索引

| 文件 | 用途 |
|------|------|
| [00-master-multi-agent-roadmap.md](./00-master-multi-agent-roadmap.md) | 多轮次多 Agent 总路线与任务卡 |
| [01-contract.md](./01-contract.md) | 高度 / 冻结 / 拖拽「宪法」，所有实现 Agent 必须遵守 |
| [EXECUTION-PROGRESS.md](./EXECUTION-PROGRESS.md) | 执行进度、门闩、审计记录 |
| [audits/](./audits/) | 第二轮及后续审计报告与跟进计划 |

## 编排原则

- **主会话（Orchestrator）**：只做任务分配、门闩验收、冲突裁决、审计调度；**不写业务实现**。
- **执行 Agent**：按 Round 任务卡改代码与测试。
- **审计 Agent**：全量合入后只读审计，出具问题与续作计划；有问题则开新 Round 继续并行修复。

## 总序（硬依赖）

```
R0 契约与基线
 → R1 消息列表正确性（可与 R5 并行）
 → R2 冻结协议统一（R3/R4 硬依赖）
 → R3 窗口桥  ∥  R4 DragSession + 浮层指示器
 → R5 消息幂等（最迟 R6 前合入）
 → R6 总装回归
 → R7 第二轮代码库审计 → 若有问题进入 R8+ 续作
```

## 完成定义

见 `00-master-multi-agent-roadmap.md` 各 Round 门闩，以及 `01-contract.md` 无违反项。
