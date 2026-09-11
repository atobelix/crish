# 02 — Post-R6 冻结协议 + 窗口桥 + Tab DnD 指示器审计

> Agent：R7-Audit-Freeze-Drag（A-Review 只读）
> 日期：2026-07-22
> 工作区：`C:\Software\conex`
> 契约：`docs/ui-jank-message-dnd-rootfix/01-contract.md`
> 对照实现：R2 · R3 · R4
> 落盘：Orchestrator（explore 只读无法写文件）

## 0. 结论摘要

| 维度 | 总评 |
|------|------|
| 冻结唯一写入源 | **基本达标**：业务经 `begin/endLayoutInteraction` |
| 窗口桥单一性 | **达标**：仅 App 调用 `useWindowLayoutFreeze` |
| sash 与 window 类型隔离 | **达标**：独立 Set 成员 + 单测 |
| Tab DnD 契约 §3 | **主路径达标**：实时几何、无 splice、无 dockOverlay、无假 tab |
| CSS §5 | **主路径达标**；死路径 CSS 残留为债 |
| 残留风险 | **Critical 0**；**High 2** / Medium 7 / Low 5 |

**门闩建议**：R2/R3/R4 主契约可过；R8 优先跨工作区 hit-test 作用域与冻结泄漏 hardening。

## 1. Critical

**（无）**

## 2. High

### H1. Tab hit-test 根为 `document`，多拆分工作区可串扰

- **证据**：`useTabDrag.ts` `collectLiveCardTargets(document)`；commit 固定闭包 `wsId`
- **建议**：限定 `[data-ws-id="${wsId}"]` 根；跨 ws 清空 preview / 禁 commit；补拆分模式测

### H2. 冻结无 watchdog；sash commit 无 try/finally → 理论永久 frozen

- **证据**：`layoutAnimationStore` Set 无 refcount/超时；Workspace sash 在 end 前 `resizeColumns` 无 finally
- **建议**：writers `try/finally`；可选 `MAX_FREEZE_MS` watchdog

## 3. Medium

| ID | 摘要 |
|----|------|
| M1 | Tab 先 end 再 commit → 落点帧 catch-up 抖动 |
| M2 | DropIndicator 仅在 dropPreview 引用变化时量几何 |
| M3 | pointermove 全量 query+rect 无 rAF |
| M4 | cursor / 双 rAF end 非原子 |
| M5 | 侧栏宽变更 260ms + 假 window resize 级联 |
| M6 | 整卡 `cloneNode(true)` 成本 |
| M7 | `panel-split-resizing` / `modal-animating` 闲置 |

## 4. Low

CSS 死路径/双份 iframe 规则、ghost 魔法阴影、注释乱码、Baseline 文档过时等。

## 5. 建议 R8 切片

1. R8-Drag-WsScope（H1）
2. R8-Freeze-Hardening（H2）
3. R8-Drag-CommitOrder（M1）
4. R8-List-SyncLayout（List 审计 H1：syncOrder useLayoutEffect）
5. R8-List-RegressionTests（List 审计 H2）
6. R8-CSS-Deadcode（L）
7. R8-Docs-Baseline

## 6. 已知边界

标题栏纯移动；跨浏览器窗口 DnD——契约 §6，不记缺陷。
