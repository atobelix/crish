# 03 — R7 汇总后续计划（R8+）

> Orchestrator 根据 `01-post-r6-list.md` + `02-post-r6-freeze-drag.md` 合并。
> 日期：2026-07-22

## 总原则

- R6 门闩已 **pass**（主因路径根治可宣称）。
- R7 无 Critical；R8 修 **High**，有余力吃 Medium。
- 仍遵守 `01-contract.md`；Orchestrator 不写业务实现。

## 优先级队列

| 优先级 | 切片 ID | 来源 | 级别 | 目标 | 可并行 |
|--------|---------|------|------|------|--------|
| P0 | R8-Drag-WsScope | Freeze H1 | High | hit-test 限本 `wsId` | ∥ Freeze |
| P0 | R8-Freeze-Hardening | Freeze H2 | High | try/finally + 可选 watchdog | ∥ Drag |
| P0 | R8-List-SyncLayout | List H1 | High | ids→syncOrder 用 useLayoutEffect | ∥ 上两者 |
| P1 | R8-List-RegressionTests | List H2 | High | 接线级回归测防 clear 回潮 | 依赖 SyncLayout |
| P1 | R8-Drag-CommitOrder | Freeze M1 | Medium | commit 仍在 frozen 窗口内 | 依赖 WsScope 后或并行小心 |
| P2 | R8-List-WidthInvalidate | List M1 | Medium | 宽变阈值 invalidateAllActual | 独立 |
| P2 | R8-Drag-RafMove | Freeze M3 | Medium | move 几何 rAF 合并 | 独立 |
| P2 | R8-CSS-Deadcode | Freeze L1 | Low | 删死 placeholder/双份规则 | 独立 |
| P2 | R8-Docs-Baseline | 双方 L | Low | 刷新 Baseline 当下列 | Orchestrator 可做文档 |

## 本轮 R8 立即派发（P0 并行）

1. **R8-Drag-WsScope**
2. **R8-Freeze-Hardening**
3. **R8-List-SyncLayout**（含尽量补 hook 测）

## R8 完成门闩

- 三切片自报 + 相关 vitest 绿
- Orchestrator 抽查：
  - `collectLiveCardTargets` 不再默认 `document` 全树（或等价 scope）
  - sash end 有 finally 路径
  - syncOrder 不在 paint 后 effect 才跑（layout 或同步）
- 然后可选 R9 吃 P1/P2 或再开一轮审计

## 宣称口径（更新）

| 宣称 | 状态 |
|------|------|
| 消息假重复主因路径根治 | **可宣称**（R6+R7 Critical 0） |
| 冻结/DnD 主契约根治 | **可宣称主路径**；跨 ws 串扰与冻结泄漏 hardening 前不宣称「生产拆分模式完美」 |
| expand 零跳动 / 60fps 拖满 | **不可宣称** 直至 List H1 + Freeze M1/M3 处理 |
