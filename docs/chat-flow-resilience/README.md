# 对话流状态韧性与错误自愈战役 (chat-flow-resilience)

## 1. 战役背景与核心目标

根据用户明确指令与现场问题审计，本战役聚焦彻底根治聊天系统中的状态死锁、假思维链折叠、以及将网络重试与错误自愈深度做进对话流中：
1. **解除用户手动发送打回死锁**：不论历史残留何种错误标记或僵尸 `processing` 状态，只要用户手动发送，必须自愈清空阻塞并重新尝试发起。
2. **切除假思维链与调度污染**：严禁将系统排队提示（`当前会话上一轮任务仍在收尾中，已自动为您排队…`）注入 `onThought`；严禁在思维链折叠卡中塞入 `正在处理…` 与虚假的 125 秒假思考计时。
3. **对话流内生重试与错误自愈（参考 DeepSeek Harness 架构）**：
   - 彻底废除底栏横幅/浮动条的黑盒设计；
   - 将网络重试（`model-retry`）、重连倒计时（带扫光微交互与可折叠错误详情）、终态错误（`turn-error`）以及过程状态（`turn-process`）作为第一公民结构化融入对话流（`target: 'chat'`）内部。

## 2. 战役目录结构（严格遵循 AGENTS.md 规范）

```
docs/chat-flow-resilience/
├── README.md                                          # 本纪律与导航总览
├── analysis/                                          # 一级子文件夹：调研与深度分析
│   ├── 01-deepseek-harness-conversation-nodes-survey.md # DeepSeek Harness 对话节点分类与实现详析
│   └── 02-conex-chat-stream-resilience-architecture.md  # Conex 现状差距与对话流韧性解耦分析
├── independent-plans/                                 # 一级子文件夹：独立方案与设计
│   ├── 01-conversation-flow-retry-error-nodes-plan.md  # 对话流内生重试与错误节点设计方案
│   └── 02-deadlock-elimination-and-self-healing-plan.md # 用户发送死锁自愈与思维链纯洁性方案
└── 00-总方案-对话流状态韧性与端到端自愈实施方案.md       # 根目录：后续多 Agent 汇聚后的统一总方案
```

## 3. 工作流纪律与验收要求

1. **纯逻辑规划与反退避**：所有步骤按纯逻辑依赖排布，问题同权；严禁退避自研或使用魔术补丁。
2. **单层子目录红线**：所有调研、分析、方案严格放置于 `analysis/` 与 `independent-plans/`，禁止嵌套二级子文件夹。
3. **探索类 Agent 配额**：每个 Agent 仅产出分配给自己的单一指定文档，UTF-8 无 BOM，中文编写。
