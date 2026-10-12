# Wave 3 - Task W3-C：单轨测高收敛、私有 RO 清退与树状数组 NaN 刚性守门执行报告

> **任务编号**：Wave 3 - Task W3-C  
> **所属战役**：`stream-jitter-and-order-repair`（流式渲染卡顿跳动与时序重排系统性治理）  
> **遵循基准**：`docs/stream-jitter-and-order-repair/01-规范-执行波通用.md`、`docs/stream-jitter-and-order-repair/plan-reviews/00-主控最终决断书.md`（裁决 5 与 裁决 6）、`docs/stream-jitter-and-order-repair/plan-reviews/review-02-structural-convergence-and-deletion.md`、`docs/stream-jitter-and-order-repair/plan-reviews/review-05-defensive-testing-and-guardrails.md`、根目录 `AGENTS.md`

---

## 一、完成度总结

| 子项                                               | 要求概述                                                                                               | 状态          | 说明                                                                                                                                                                                                                                              |
| :------------------------------------------------- | :----------------------------------------------------------------------------------------------------- | :------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1.1 物理删除 `MessageToolCallsSection` 私有 RO** | 删除第 120-132 行私有 `ResizeObserver` 监听与注销 `useLayoutEffect` 及 `sectionRef`                    | ✅ **已完成** | 彻底清退 `ResizeObserverManager` 导入、`sectionRef` 与 `useLayoutEffect` 私有监听，收敛至外层宿主单轨测高。                                                                                                                                       |
| **1.2 物理删除 `invalidateActual` 越权调用**       | 删除 `handleToggleTool` 与 `handleToggleThinking` 中的 `virtualScrollManager?.invalidateActual(msgId)` | ✅ **已完成** | `handleToggleTool` 仅保留 `toolStackProps.onToggleTool` 通知；`handleToggleThinking` 空壳回调整体移除。                                                                                                                                           |
| **1.3 物理删除死属性 `virtualScrollManager`**      | 删除 `MessageToolCallsSectionProps` 接口与组件解构中的 `virtualScrollManager`                          | ✅ **已完成** | 移除 `VirtualScrollManager` 类型导入、接口字段及组件入参解构。                                                                                                                                                                                    |
| **1.4 核查 `ProcessItemRenderer` 透传清理**        | 确保 `ProcessItemRenderer.tsx` 无 `virtualScrollManager` 死属性及向 `<MessageToolCallsSection>` 的透传 | ✅ **已核销** | 核查真实物理路径 `apps/crish-desktop/src/components/chat-message/ProcessItemRenderer.tsx`（第 23-52 行 Props 与第 157-162 行调用点），已处于零 `virtualScrollManager` 属性与零透传净收敛状态。                                                    |
| **2. 树状数组 `NaN` 与负数刚性守门**               | 在 `VirtualScrollManager.ts` 的 `setActual`、批量更新入口及底层 BIT 原语最顶部增加刚性数学守门         | ✅ **已完成** | 在真实物理路径 `apps/crish-desktop/src/api/VirtualScrollManager.ts` 的 `setActual`、`preloadEstimates`、`setEstimated`、`hydrateHeightMap`、`invalidateActual`、`syncOrder` 及 `bitAdd`/`bitQuery` 最顶部固化 `Number.isFinite` 与正数/非负守门。 |
| **3. 魔鬼用例单测与门禁核验**                      | 新增 `NaN`、`Infinity`、`-Infinity`、`-50` 魔鬼用例并运行 Vitest 与 `check-line-counts.mjs`            | ✅ **已完成** | `VirtualScrollManager.test.ts` 39/39 全绿通过；行数门禁 0 Warnings / 0 Violations / 0 Hard blocks。                                                                                                                                               |

> **路径勘误记录（遵循三原则“诚实与负责”）**：
>
> - 任务书引用的 `apps/crish-desktop/src/components/chat-message-row/ProcessItemRenderer.tsx` 在仓库中的真实物理路径为 `apps/crish-desktop/src/components/chat-message/ProcessItemRenderer.tsx`（与 `review-02` §3.2 第 171 行一致）；
> - 任务书引用的 `apps/crish-desktop/src/hooks/VirtualScrollManager.ts` 及 `.test.ts` 在仓库中的真实物理路径为 `apps/crish-desktop/src/api/VirtualScrollManager.ts` 及 `apps/crish-desktop/src/api/VirtualScrollManager.test.ts`（与 `review-05` §3.2 第 99 行及 §5.1 第 219 行一致）；`VirtualScrollManager` 的总高与偏移查询方法名为 `getTotalHeight()` 与 `getOffset()`。严格遵循 SSOT 原则就地修改真实模块，绝不新建平行文件。

---

## 二、代码修改清单

1. [`apps/crish-desktop/src/components/chat-message-row/MessageToolCallsSection.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/MessageToolCallsSection.tsx#L1-L169)
   - **第 7-16 行**：更新文件头注释以反映宿主单轨测高契约；从 `react` 导入中移除不再使用的 `useLayoutEffect` 与 `useRef`；物理删除 `VirtualScrollManager` 与 `ResizeObserverManager` 导入。
   - **第 46-60 行**：从 `MessageToolCallsSectionProps` 与组件参数解构中物理删除 `virtualScrollManager`，并移除 `sectionRef`。
   - **第 95-102 行**：从 `handleToggleTool` 中物理删除 `virtualScrollManager?.invalidateActual(msgId)` 及其依赖项；整段物理删除仅调用 `invalidateActual` 的 `handleToggleThinking` 与私有 `ResizeObserver` `useLayoutEffect`。
   - **第 137-154 行**：移除根容器 `<div className={styles.timelineTools}>` 上的 `ref={sectionRef}` 及 `<ReasoningRow>` 上的无用 `onToggle={handleToggleThinking}`。

2. [`apps/crish-desktop/src/api/VirtualScrollManager.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/VirtualScrollManager.ts#L92-L445)
   - **第 95-96 行（`syncOrder`）**：对初始写入 BIT 树的高度执行 `Number.isFinite(rawH) && rawH > 0 ? rawH : this.fallbackHeight` 守门。
   - **第 144 行（`preloadEstimates`）**：在批量预估循环最顶部前置 `if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0 || !id) continue;`。
   - **第 205-209 行（`setActual`）**：在方法第一行前置刚性数学守门 `if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return false;`，优先于代际与 ID 判定拦截一切 `NaN`、`Infinity`、`-Infinity`、负数与零高度。
   - **第 256 行（`setEstimated`）**：最顶部前置 `if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0 || !id) return;`。
   - **第 290-292 行（`invalidateActual`）**：加固过渡估计高度守门 `Number.isFinite(lastKnownHeight) && lastKnownHeight > 0`。
   - **第 302 行（`hydrateHeightMap`）**：在批量快照回灌循环最顶部前置 `if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0 || !id) continue;`。
   - **第 430-443 行（`bitAdd` / `bitQuery`）**：在 Fenwick Tree 底层原语 `bitAdd` 顶部增加 `if (!Number.isFinite(delta) || delta === 0) return;`，在 `bitQuery` 中增加 `if (Number.isFinite(val)) sum += val;`，从数学底层杜绝树状数组账本被污染的可能。

3. [`apps/crish-desktop/src/api/VirtualScrollManager.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/VirtualScrollManager.test.ts#L546-L614)
   - **第 546-614 行**：新增 `W3-C / Review 05：树状数组 NaN、无穷大与负数高度刚性守门魔鬼用例` 测试套件，覆盖向 `setActual`、`preloadEstimates`、`hydrateHeightMap`、`setEstimated` 连续注入 `NaN`、`Infinity`、`-Infinity`、`-50`、`0`、`-0.0001`，断言 `getTotalHeight()`、各项 `getOffset(i)`、`getHeightAt(i)` 及 `findIndexAtOffset()` 100% 保持有限合法数值与严格单调性，零 `NaN` 污染。

---

## 三、物理删除清单（Negative Output）

| 序号  | 所属文件                      | 物理删除内容                                                                                                                                                         | 对应裁决条款                   |
| :---- | :---------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------- |
| **1** | `MessageToolCallsSection.tsx` | 物理删除 `import type { VirtualScrollManager } from '../../api/VirtualScrollManager'` 与 `import { ResizeObserverManager } from '../ui/utils/ResizeObserverManager'` | Review 02 硬性删除项 2.1 / 2.3 |
| **2** | `MessageToolCallsSection.tsx` | 物理删除 `MessageToolCallsSectionProps.virtualScrollManager` 接口字段与组件入参解构                                                                                  | Review 02 硬性删除项 2.3       |
| **3** | `MessageToolCallsSection.tsx` | 物理删除 `sectionRef`、`handleToggleTool` 中的 `virtualScrollManager?.invalidateActual(msgId)`、以及整段 `handleToggleThinking`                                      | Review 02 硬性删除项 2.2       |
| **4** | `MessageToolCallsSection.tsx` | 物理删除私有 `ResizeObserver` `useLayoutEffect`（原第 120-131 行）                                                                                                   | Review 02 硬性删除项 2.1       |

---

## 四、测试验证结果

1. **虚拟滚动树状数组与魔鬼用例单元测试**：
   - 命令：`npx vitest run apps/crish-desktop/src/api/VirtualScrollManager.test.ts`
   - 结果：**1 passed (39 tests, 29ms) — 100% PASS**。
2. **代码行数预算门禁检查**：
   - 命令：`node scripts/check-line-counts.mjs apps/crish-desktop/src/components/chat-message-row/MessageToolCallsSection.tsx apps/crish-desktop/src/components/chat-message/ProcessItemRenderer.tsx apps/crish-desktop/src/api/VirtualScrollManager.ts`
   - 结果：**Scanned: 3 files | Warnings: 0 | Violations: 0 | Hard blocks: 0 — 100% PASS**。

---

## 五、行数预算自检

| 文件路径                                                                         | 类别           | 修改前有效行 | 修改后有效行 |   净变化   | 门禁上限 / 基线 |  状态   |
| :------------------------------------------------------------------------------- | :------------- | :----------: | :----------: | :--------: | :-------------: | :-----: |
| `apps/crish-desktop/src/components/chat-message-row/MessageToolCallsSection.tsx` | UI Component   |     154      |   **131**    | **-23 行** |       500       | ✅ PASS |
| `apps/crish-desktop/src/components/chat-message/ProcessItemRenderer.tsx`         | UI Component   |     182      |   **182**    |  **0 行**  |       500       | ✅ PASS |
| `apps/crish-desktop/src/api/VirtualScrollManager.ts`                             | Business Logic |     338      |   **336**    | **-2 行**  | 400 (基线 371)  | ✅ PASS |
