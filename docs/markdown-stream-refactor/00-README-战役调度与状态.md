# 战役调度与状态：Markdown真流式渲染与正文退化根治战役

> **战役工作区**：`docs/markdown-stream-refactor/`  
> **权威纪律**：`AGENTS.md` / `.agents/LOGIC_PLAN_NO_RETREAT.md`  
> **当前阶段**：Phase Σ / Δ / Ω 并行推进（深度勘察、架构设计、独立总案推演）

---

## 1. 战役核心目标与效果锁

- **效果锁 1（无推理逃逸）**：所有工具调用前的规划思考内容、`<think>` / `<thought>` 标签内容在 Rust 实时流层精准分类为 `ThoughtDelta`，前端收口至折叠思考链面板，正文区 0 污染。
- **效果锁 2（真流式 Markdown）**：流式阶段实行 **Markdown-first 真流式分块渲染**（渐进封口编译），已封口段落即时呈现高品质排版（标题、代码块、列表、表格），消除纯文字到 Markdown 的全屏跳变与闪烁。
- **效果锁 3（绝对幂等零重复）**：彻底修复多轮会话（`turnIndex > 0`）与重试场景下的文本合并逻辑，消灭整段重复 bug。
- **效果锁 4（Blocks 结构不丢失）**：修复时间线更新时的破坏性覆盖，保证多轮工具卡片与思考链历史完整保全。

---

## 2. 轮次 1：深度勘察与方案细化 Agent 分工矩阵

| 子 Agent 角色 | 任务与产出文档 | 状态 |
|:---|:---|:---|
| **Rust Stream Parser Architect** | `analysis/01-rust-stream-think-tag-state-machine.md`：Rust 流式解析层 `<think>` 状态机与跨 chunk 分割边界算法 | 运行中 |
| **Streaming Markdown UI Architect** | `analysis/02-streaming-markdown-chunking-architecture.md`：真流式 Markdown 分块渲染架构与零视觉跳变机制 | 运行中 |
| **Message Stream Lifecycle Specialist** | `analysis/03-message-lifecycle-and-turn-idempotency.md`：消息生命周期、流式缓冲与多轮完全幂等合并 | 运行中 |
| **Timeline and Blocks State Engineer** | `analysis/04-timeline-normalization-and-block-merge.md`：Timeline 构建、Blocks 合并与前端防守层设计 | 运行中 |
| **QA and Verification Specialist** | `analysis/05-verification-and-anti-regression-suite.md`：全链路测试用例设计、反退避 Checklist 与 Tauri MCP 验收断言 | 运行中 |
| **Independent Architect - Contract Focus** | `independent-plans/01-end-to-end-contract-first-plan.md`：端到端事件流与数据契约优先实施总案 | 运行中 |
| **Independent Architect - Render Focus** | `independent-plans/02-progressive-chunk-render-plan.md`：渐进分块渲染引擎与极致平滑实施总案 | 运行中 |

---

## 3. 后续阶段路标

1. **Round 1 (当前)**：7 个子 Agent 完成深度勘察与独立方案编制。
2. **Round 2 (选型与定案)**：汇总 7 份文档，提炼收敛为《00-总方案-真流式Markdown与思考链彻底根治.md》与 5 个维度的分维详细实现方案（`01-` 至 `05-`）。
3. **Round 3 (维度评审与冻结)**：多 Agent 维度交叉评审，消灭逻辑漏洞，冻结实现契约。
4. **Round 4 (实现与验证)**：多 Agent 按文件域互斥分工实现代码与单元测试，Tauri MCP 实机端到端验收。
