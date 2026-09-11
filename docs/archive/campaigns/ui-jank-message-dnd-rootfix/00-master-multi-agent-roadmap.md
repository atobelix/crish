# 多轮次多 Agent 并行根治路线图

> 综合：原方案 + 根因验证 Agent + 架构评审 Agent。
> Orchestrator 只分配任务与验收；执行 Agent 改代码。

## 角色

| 代号 | 职责 | 可写范围 |
|------|------|----------|
| A-List | 消息列表 / 虚拟滚动 | ChatMessageList、useVirtualScroll、VirtualScrollManager、相关测 |
| A-Freeze | 冻结唯一源 | layoutAnimationStore、useResizeFreeze、Workspace/Sidebar sash、冻结 CSS |
| A-Window | 窗口事件桥 | App、useWindowControls、Tauri window 订阅 |
| A-Drag | Tab DnD | useTabDrag、Workspace drop 预览、CardPanel overlay 移除 |
| A-Data | 消息幂等 | session/chat actions、useChatStream 投递 |
| A-CSS | 视觉收口 | shell-workspace / shell-dragdrop / Workspace.module / z-index |
| A-QA | 回归门禁 | 测试与验收清单 |
| A-Review | 交叉审查 / 审计 | 只读或仅修审查小问题 |
| Orchestrator | 分配与门闩 | **不写业务实现** |

## Round 0 — 契约与基线

| Agent | 任务 | 依赖 | 完成定义 |
|-------|------|------|----------|
| R0-Spec | 契约文档已落盘（本目录 `01-contract.md`） | 无 | 文档存在且被后续 prompt 引用 |
| R0-Baseline | 记录 before 基线：假重复/列拖/Tab 错位；确认现有绿测入口 | 无 | `EXECUTION-PROGRESS.md` 写入 Baseline |

## Round 1 — 消息列表正确性（Critical）

| Agent | 任务 | 依赖 | 完成定义 |
|-------|------|------|----------|
| R1-Core (A-List) | 删除 ChatMessageList 对 startIndex 的 clearHeights；会话切换 clear；窗口只 syncOrder | R0 契约 | 无错误 clear Effect；会话切有 clear |
| R1-Stream (A-List) | 收敛流式 invalidateActual 频率 | R1-Core | 策略落地或说明为何已足够 |
| R1-Test (A-QA) | 窗口 pan 同 id 高度保留；无 startIndex→clear 回归 | R1-Core | 测试绿 |
| R1-Review | 契约核对 | R1-Core+Test | Review 通过 |

**门闩 R1：** 发送/展开更早无假重复主因路径关闭。

## Round 2 — 冻结协议统一

| Agent | 任务 | 依赖 | 完成定义 |
|-------|------|------|----------|
| R2-Store | 强化 store/helper；begin/end 同步 body class 策略写死 | R0 | API 可用 |
| R2-Writers | Workspace 列/组 sash：startAnimation + pointer capture + 对称 end | R2-Store | 写入侧接线 |
| R2-Consumers | useResizeFreeze 订 store；Terminal fit 认冻结；评估 useSuspendedResizeObserver | R2-Store | 消费者统一 |
| R2-CSS | iframe pointer-events 全 class 覆盖 | R2-Store 命名 | CSS 齐 |
| R2-Leak-Test | cancel/卸载后 frozen 必 false | Writers+Consumers | 测绿 |

**门闩 R2：** 交互冻结唯一源；无永久 frozen。

## Round 3 — 窗口桥（∥ Round 4）

| Agent | 任务 | 依赖 | 完成定义 |
|-------|------|------|----------|
| R3-Bridge | onResized(+可选 onMoved) pulse；去掉 App/useWindowControls 双监听 | R2 | 单一 bridge |
| R3-Test | 非 Tauri fallback；单次 pulse | R3-Bridge | 测或自检通过 |

## Round 4 — DragSession + 浮层指示器

| Agent | 任务 | 依赖 | 完成定义 |
|-------|------|------|----------|
| R4-Session | 实时几何；tab-dragging 冻结；废弃静态 snapshot 唯一 hit-test | R2 | Session 可用 |
| R4-Layout | 废 Workspace splice placeholder；单一 DropIndicatorLayer | R4-Session | 拖期树结构不变 |
| R4-CardPanel | 移除 dockOverlay | R4-Layout | 无双轨 overlay |
| R4-DOM-Tab | 移除 tab bar 假 tab 插入；fixed 竖线 | R4-Session | 无假 tab 节点 |
| R4-CSS | 删双分块伪元素；统一 drop 样式与 token | R4-Layout | 暗色无黑灰古董 |
| R4-Test | 无 placeholder 节点；几何误差；边界矩阵 | R4 全 | 测绿 |

**门闩 R4：** 指示器与落点一致；无双分块。

## Round 5 — 消息幂等（可与 R1 并行，最迟 R6 前）

| Agent | 任务 | 依赖 | 完成定义 |
|-------|------|------|----------|
| R5-Upsert | addMessage 同 id upsert/拒绝；审计双投递；id 熵 | R0 | 真重复路径关 |
| R5-Test | 同 id 双 add 不增行 | R5-Upsert | 测绿 |

## Round 6 — 总装回归

| Agent | 任务 | 依赖 | 完成定义 |
|-------|------|------|----------|
| R6-Integration | typecheck + 相关 vitest + 手动清单 | R1–R5 | 清单过 |
| R6-Perf | 可选 FPS/长任务采样 vs 基线 | R6 主体 | 记录结果 |
| R6-Final-Review | 契约逐条勾选 | R6 | 签字 |

## Round 7 — 第二轮代码库审计（强制）

| Agent | 任务 | 依赖 | 完成定义 |
|-------|------|------|----------|
| R7-Audit-List | 只读审计虚拟滚动/消息路径 | R6 | `audits/01-post-r6-list.md` |
| R7-Audit-Freeze-Drag | 只读审计冻结 + DnD | R6 | `audits/02-post-r6-freeze-drag.md` |
| R7-Plan | 汇总 findings → 续作计划 `audits/03-followup-plan.md` | 两审计 | 计划可派发 |

若 R7 有 Critical/High：**进入 Round 8+**，按 followup-plan 再并行 Agent，直至审计通过或仅剩已知边界。

## 并行依赖图

```
R0 → R1 ──┐
   → R5 ──┼→ R6 → R7 → (R8+ if needed)
R0 → R2 → R3 ─┤
       └→ R4 ─┘
```

## 派发模板

```text
你是 {代号}。工作区 C:\Software\conex，主改 apps/crish-desktop。
分支 refactor/architecture。
必读：docs/ui-jank-message-dnd-rootfix/01-contract.md
本轮：Round {N} — {标题}
任务：...
依赖：...
禁止：违反契约；改范围外大重构；Orchestrator 未授权的 force push
完成定义：...
完成后在 docs/ui-jank-message-dnd-rootfix/EXECUTION-PROGRESS.md 追加你的小节（Agent 自报）。
```
