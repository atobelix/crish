# Cross-04: Tab 拖拽系统审计

> 日期：2026-07-22
> 审计范围：useTabDrag、collisionDetection、DropIndicatorLayer、Workspace.tsx、store/types 中的 DropPreviewState

---

## 1. useTabDrag 当前实现

### 1.1 文件概况
- 路径：`apps/crish-desktop/src/hooks/useTabDrag.ts`（1706 行）
- 入口：`useTabDrag({ wsId, groupId, cardsLength })` → 返回 `{ handleTabPointerDown }`
- 架构：单体 hook，所有状态封装在闭包局部变量中（非引用 ref），依赖 `pointerId` 隔离多点触控

### 1.2 实时碰撞检测

| 检查项 | 状态 | 证据 |
|--------|------|------|
| `collectLiveCardTargets` | ✅ 已使用 | 第 1448 行：`collectLiveCardTargets(wsRoot)` |
| 排除 ghost/placeholder | ✅ | 第 1158 行：`.workspace-card:not(.placeholder-card-group):not(.drag-overlay-preview-card)` |
| 排除 `.is-dragging-ghost` | ✅ | 第 1164 行：`if (el.classList.contains('is-dragging-ghost')) continue` |
| 实时 `getBoundingClientRect` | ✅ | 第 1165 行：每次 move 调用 `el.getBoundingClientRect()` |
| `cardTargetFromElementMeta` 建 target | ✅ | 第 1167-1175 行 |
| 旧 `cardSnapshots` 引用 | ✅ 已清除 | grep 显示 0 处匹配 |

### 1.3 wsId 作用域限定

| 检查项 | 状态 | 证据 |
|--------|------|------|
| `resolveWorkspaceHitTestRoot(wsId)` | ✅ | 第 1440 行：`const wsRoot = resolveWorkspaceHitTestRoot(wsId)` |
| `workspaceHitTestRootSelector` | ✅ | 第 1099-1104 行：`[data-ws-id="${safe}"]` |
| 根缺失处理 | ✅ | 第 1441-1446 行：根缺失 → 清 preview、清插入线、return |
| 区外点处理 | ✅ | `resolveScopedCardHit` 第 1144-1145 行：`!isPointInRect` → return null |
| WS 间串扰（跨 ws 同 document） | ✅ | `collectLiveCardTargets` 只扫 `root.querySelectorAll` 而非 `document` |

### 1.4 rAF 节流

| 检查项 | 状态 | 证据 |
|--------|------|------|
| `rafPending` 模式 | ❌ **缺失** | grep `rafPending` 在 useTabDrag.ts 中 0 处匹配 |
| `requestAnimationFrame` 用于 move | ❌ **无** | `requestAnimationFrame` 仅出现在 `animateOverlayAway`（第 1579 行） |
| move 事件挂载方式 | ❌ 裸 listener | 第 1689 行：`window.addEventListener('pointermove', handlePointerMove)` — 每个指针事件直接触发，无 RAF 批处理 |
| 高频 move 影响 | ⚠️ 每次 move 执行完整碰撞链：`getBoundingClientRect` + `collectLiveCardTargets` + `resolveScopedCardHit` + `resolveTabDrop` + `setDropPreview` 比较 |

**结论**：rAF 节流未实现。handlePointerMove 在每一个 pointermove 事件中同步执行完整碰撞检测链路。虽 `dropPreviewEquals` 和 `safeSetDropPreview` 减少了不必要的 store 通知，但 DOM 读取（`getBoundingClientRect` × N）和 `collectLiveCardTargets` 的开销未受控。

### 1.5 dropPreview 更新逻辑

```
handlePointerMove:
  → resolveWorkspaceHitTestRoot(wsId)       // 根 DOM 查询
  → wsRoot.getBoundingClientRect()           // 1 次 getBBox
  → collectLiveCardTargets(wsRoot)           // N 次 getBBox（每张卡片）
  → resolveScopedCardHit(...)                // 命中检测（精确→最近中心）
  → matchedSnapshot.rect / relX/relY         // 实时几何
  → findGroupIndicesInWorkspace              // store 遍历
  → isOnlyCardInSourceColumn                 // store 遍历
  → showTabInsertLine / removeInsertLine     // DOM 写入 fixed 竖线
  → resolveTabDrop(...)                      // 纯函数决策树（950+ 行 switch）
  → safeSetDropPreview(resolved.preview)     // store 写入（浅相等防护）
```

- `safeSetDropPreview`（第 1274-1285 行）封装了 `dropPreviewEquals` 检查，避免无意义 setState ✅
- `removeInsertLine` 在非 merge-like drop 时主动清理 ✅

### 1.6 提交路径

| 落点类型 | 提交函数 | 护栏 |
|---------|----------|------|
| merge | `mergeTab(wsId, cardId, sourceGroupId, targetGroupId, tabInsertIdx)` | `canCommitTabDrop` 要求 target !== source |
| self-reorder | `mergeTab(…, sameGroupId, tabInsertIdx)` | `canCommitTabDrop` 要求 `Number.isFinite(tabInsertIdx)` |
| split-card-top/bottom | `detachTabToStandalone(…, placement)` | `canCommitTabDrop` 直接 true |
| split-col-left/right | `detachTabToStandalone(…, 'new-col')` | `canCommitTabDrop` 直接 true |

---

## 2. collisionDetection 集成状态

### 2.1 文件现状
- 路径：`apps/crish-desktop/src/utils/collisionDetection.ts`（143 行）
- 导出函数：
  - `rectIntersection` — 矩形相交排序
  - `closestCenter` — 最近中心
  - `fiveZoneDetection` — 五区判定（leftEdge/top/center/bottom/rightEdge）
  - `edgeDetection` — 最近边缘检测
  - `nestedCollisionDetection` — 级联碰撞（level 1: 命中→2: 最近→3: 边缘）
  - `computeDropIndicatorRect` — 按 DropTarget 类型计算指示器几何
  - `isPointerInRect` — 点-矩形判定

### 2.2 导入审计

```
grep -r "from.*collisionDetection" src/
  → 0 results
grep -r "nestedCollisionDetection" src/
  → 只在 collisionDetection.ts 自身定义 (1 match)
grep -r "computeDropIndicatorRect" src/
  → 只在 collisionDetection.ts 自身定义 + types.ts 注释引用 (2 matches)
```

**结论**：`collisionDetection.ts` 是**完全孤立的死代码**。没有任何模块导入它。

### 2.3 Dead Code 影响

| 函数 | 调用者 | 状态 |
|------|--------|------|
| `nestedCollisionDetection` | 无 | ❌ 死代码 |
| `computeDropIndicatorRect` | 无 | ❌ 死代码 |
| `fiveZoneDetection` | 仅在内部被 `nestedCollisionDetection` 调用 | ❌ 死代码 |
| `rectIntersection` | 仅在内部被 `nestedCollisionDetection` 调用 | ❌ 死代码 |
| `edgeDetection` | 仅在内部被 `nestedCollisionDetection` 调用 | ❌ 死代码 |
| `DropTarget` 类型 | 无 | ❌ 死类型 |
| `CascadeResult` 类型 | 无 | ❌ 死类型 |

`DropPreviewState` 注释（`types.ts:358`）说「预计算几何由 collisionDetection.computeDropIndicatorRect 写入」，但这个函数从未被调用。这是一个**过时的注释**。

### 2.4 useTabDrag 的等效实现

useTabDrag 使用了自己独立的碰撞检测体系，不依赖 collisionDetection.ts：

| useTabDrag 函数 | 等价 collisionDetection 函数 |
|----------------|------------------------------|
| `findCardSnapshotAtPoint`（精确命中+最近中心） | `rectIntersection` + `closestCenter` |
| `resolveScopedCardHit`（ws 限域版 findCardSnapshot） | `isPointerInRect` + `findCardSnapshotAtPoint` |
| `collectLiveCardTargets`（DOM 采集） | 无等价（collisionDetection 假定 rects 已准备好） |
| `resolveTabDrop`（五区+边缘+上下+中心决策） | `fiveZoneDetection` + 自定义逻辑 |
| `computeDropIndicatorBox`（几何计算） | `computeDropIndicatorRect` |

两者的核心差异：
1. useTabDrag 的决策树更精细（isDragFromTabButton/isSelfHover/chat 列特判/冗余检测）
2. collisionDetection 的 cascade 模型（level 1→2→3）在 useTabDrag 中被扁平化为一次 `findCardSnapshotAtPoint`
3. useTabDrag 无 `fiveZoneDetection` 中 `rect.width > 200` 这一列宽条件——它通过 `relY/tabBarH` 做区域划分

---

## 3. DropIndicatorLayer 状态

### 3.1 文件概况
- 路径：`apps/crish-desktop/src/components/DropIndicatorLayer.tsx`（76 行）
- 类型：React.memo + createPortal
- Props: `{ wsId: string }`

### 3.2 实现审计

| 检查项 | 状态 | 证据 |
|--------|------|------|
| 使用 createPortal 到 body | ✅ | 第 71 行：`document.body` |
| wsId 作用域 | ✅ | 第 42 行：`draggedTab.workspaceId === wsId` |
| 从 layoutStore 读 dropPreview | ✅ | 第 38 行：`useLayoutStore((s) => s.dropPreview)` |
| direction→className 映射 | ✅ | 第 9-22 行：`directionToClassName` |
| 无 dropPreview 时返回 null | ✅ | 第 45 行：`if (!isActive) return null` |
| left/top/width/height 被使用 | ⚠️ | 第 47 行：`const { left, top, width, height, className, direction } = dropPreview!` |

### 3.3 严重问题：可选字段的强制解构

`DropPreviewState` 定义：

```typescript
export interface DropPreviewState {
  colIdx: number;
  groupIdx: number;
  direction: DropPreviewDirection;
  left?: number;        // 可选
  top?: number;         // 可选
  width?: number;       // 可选
  height?: number;      // 可选
  className?: string;   // 可选
}
```

`DropIndicatorLayer` 第 47 行：
```typescript
const { left, top, width, height, className, direction } = dropPreview!;
```

当 store 中的 `dropPreview` 是 `useTabDrag.ts:494` 创建的 `{ colIdx, groupIdx, direction }`（如 `splitCardResult` 生成的 preview），此时 `left/top/width/height/className` 均为 `undefined`，会导致：

```typescript
const indicatorStyle: React.CSSProperties = {
  position: 'absolute',
  left: left ?? 0,      // undefined → 0（但 0 是错误位置）
  top: top ?? 0,        // undefined → 0（但 0 是错误位置）
  width: width ?? 0,    // undefined → 0（渲染不可见）
  height: height ?? 0,  // undefined → 0（渲染不可见）
};
```

**结果**：`DropIndicatorLayer` 会渲染一个 `left: 0; top: 0; width: 0; height: 0` 的不可见 div，而 `WorkspaceDropIndicator`（同一文件内另一个组件）做了正确的几何计算。这两个指示器同时渲染，但 portal 版实际上**不工作**。

### 3.4 双渲染路径

Workspace.tsx 同时渲染了两个组件：

```tsx
{/* 行 508-517 */}
<WorkspaceDropIndicator ... />   {/* 行内，useLayoutEffect 读 DOM + computeDropIndicatorBox */}
{/* 行 519 */}
<DropIndicatorLayer wsId={ws.id} />  {/* Portal，但 left/top/width/height 为 undefined */}
```

- `WorkspaceDropIndicator`（行 60-141）：✅ 正确实现 —— useLayoutEffect 中实时读 DOM → `computeDropIndicatorBox` → fixed 几何
- `DropIndicatorLayer`（行 35-74）：❌ 无效 —— 解构 left/top/width/height 永远是 undefined

---

## 4. Workspace 集成状态

### 4.1 文件概况
- 路径：`apps/crish-desktop/src/components/Workspace.tsx`（524 行）
- 组件：`Workspace`（主输出）、`WorkspaceDropIndicator`（行内辅助）

### 4.2 审计矩阵

| 检查项 | 状态 | 行号 |
|--------|------|------|
| 导入 `DropIndicatorLayer` | ✅ | 行 15 |
| 导入 `computeDropIndicatorBox` | ✅ | 行 17-18 |
| 导入 `resolveTabBarHeight` | ✅ | 行 19 |
| `data-ws-id` 作用域属性 | ✅ | 行 274：`data-ws-id={ws.id}` |
| 渲染 `WorkspaceDropIndicator` | ✅ | 行 508-517 |
| 渲染 `DropIndicatorLayer` | ✅ | 行 519：`<DropIndicatorLayer wsId={ws.id} />` |
| `renderedColumns` 无 splice | ✅ | 行 224-235：直投 store columns，无 placeholder 拼接 |
| 搜索 `placeholderCol` | ✅ 无 | grep 仅在 CSS 选择器 `.placeholder-card-group` 中出现 |
| 搜索 `placeholderGroup` | ✅ 无 | 0 处匹配 |
| `dropPreview` 读取 | ✅ | 行 153：`useLayoutStore((s) => s.dropPreview)` |
| `draggedTab` 读取 | ✅ | 行 152：`useLayoutStore((s) => s.draggedTab)` |
| ws 作用域的 dropPreview 传递 | ✅ | 行 510-514：`draggedTab.workspaceId === ws.id` 条件判断 |
| `dropLiveMessage` 读屏 | ✅ | 行 238-247 |
| from `layoutStore` vs `workspaceStore` | ✅ | 两者是同一 store 实例（workspaceStore.ts:20 `useWorkspaceStore = useLayoutStore`） |

### 4.3 DOM Splice 残留确认

搜索 `placeholderCol`、`placeholderGroup`、`placeholder-card`：

| 模式 | 出现位置 | 性质 |
|------|---------|------|
| `.placeholder-card-group` | useTabDrag.ts:1158 | CSS 选择器参数（排除） |
| tab-placeholder-indicator | useTabDrag.ts:1303 | 防御性清理 |
| `placeholder` | Workspace.tsx | **全部**为 input 组件的 placeholder 属性，无关 DOM splice |

**结论：Workspace.tsx 中无 DOM splice 残留**。契约 §3（拖期不 splice placeholder 列/组）已遵守。

---

## 5. 剩余问题

### P0 — 功能缺陷

#### 5.1 `DropIndicatorLayer` 渲染不可见指示器

- **文件**：`DropIndicatorLayer.tsx:47`
- **根因**：`DropPreviewState.left/top/width/height` 为可选字段，useTabDrag 写入的 preview 对象不含这些字段
- **后果**：Portal 组件渲染 `width:0;height:0` 的不可见指示器，同时 `WorkspaceDropIndicator`（inline）正常工作。双渲染但 portal 版不工作，造成维护困惑
- **修复**：让 `DropIndicatorLayer` 回退到 `WorkspaceDropIndicator` 一样的 DOM 查询逻辑，或移除 `DropIndicatorLayer`，或让 useTabDrag 的 `resolveTabDrop` 写入几何字段

#### 5.2 `nestedCollisionDetection` 全系统死代码

- **文件**：`collisionDetection.ts`
- **根因**：重构到 useTabDrag 后未清理旧文件
- **后果**：143 行死代码，`DropPreviewState` 注释引用已不存在的调用方
- **修复**：删除或标记为废弃

### P1 — 性能

#### 5.3 缺乏 rAF 节流

- **文件**：`useTabDrag.ts:1359-1559`（`handlePointerMove`）
- **根因**：move 事件直接触发完整碰撞检测链路，无 RAF 批处理
- **影响**：每帧可能触发多次 `getBoundingClientRect`（N+1 次）、store 查找、DOM 写入
- **修复**：引入 `rafPending` 模式：pointermove 设置标志位，rAF 回调中执行一次碰撞检测

### P2 — 架构

#### 5.4 双 DropIndicator 渲染路径

- **文件**：`Workspace.tsx:508-519`
- **根因**：历史遗留的两个组件同时渲染，预期是迁移过程中的过渡态
- **建议**：统一为一条渲染路径（保留 `WorkspaceDropIndicator`，移除或修正 `DropIndicatorLayer`）

#### 5.5 `collisionDetection.ts` 与 useTabDrag 功能重复

- useTabDrag 内部有 `findCardSnapshotAtPoint`（精确命中+最近中心）≈ `rectIntersection` + `closestCenter`
- useTabDrag 的 `resolveTabDrop`（五区+边缘决策）≈ `fiveZoneDetection`
- useTabDrag 的 `computeDropIndicatorBox` ≈ `computeDropIndicatorRect`
- **建议**：如果未来需要统一的碰撞检测库，应提取 useTabDrag 的纯函数到 `collisionDetection.ts`；否则删除 `collisionDetection.ts`

---

## 6. 修复方案

### 6.1 P0 修复：DropIndicatorLayer 几何缺失

**方案 A**（推荐）：让 `DropIndicatorLayer` 从 DOM 实时计算几何，与 `WorkspaceDropIndicator` 一致：

```typescript
// DropIndicatorLayer.tsx 修改：当 left 缺失时回退到 DOM 查询
const indicatorStyle: React.CSSProperties = {
  position: 'absolute',
  left: left ?? 0,
  top: top ?? 0,
  width: width ?? 0,
  height: height ?? 0,
  ...
};
```

改为使用 `useLayoutEffect` + `computeDropIndicatorBox` + `createPortal` 统一实现。或简化为：直接删除 `DropIndicatorLayer`，因为 `WorkspaceDropIndicator` 已完成相同工作。

**方案 B**：让 `resolveTabDrop` 的 preview 输出包含几何字段：
- 但这需要传入 `canvasRect`/`colRect` 等信息到 `resolveTabDrop`
- 当前 `resolveTabDrop` 是 pure 函数，不依赖 DOM，引入几何违背了其设计意图

### 6.2 P1 修复：rAF 节流

```typescript
// 在 handlePointerMove 中引入 rafPending 模式
let rafPending = false;
let lastMoveEvent: PointerEvent | null = null;

const handlePointerMove = (moveEvent: PointerEvent) => {
  if (finished) return;
  if (moveEvent.pointerId !== pointerId) return;
  lastMoveEvent = moveEvent;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (!lastMoveEvent || finished) return;
    processCollision(lastMoveEvent);
  });
};

// 将原碰撞检测逻辑提取到 processCollision
```

### 6.3 P2 修复：清理死代码

- 删除或标记 `collisionDetection.ts` 为废弃
- 统一 DropIndicator 渲染路径

---

## 7. 优先级

| 优先级 | 问题 | 影响 | 工作量 |
|--------|------|------|--------|
| **P0** | DropIndicatorLayer 渲染不可见指示器 | 盲区：portal 路径从未工作过；代码误导维护者 | 小（删除或统一） |
| **P1** | 缺乏 rAF 节流 | 性能：高频 pointermove 每帧多次 getBoundingClientRect + 碰撞检测 | 中（~30 行改动） |
| **P2** | collisionDetection.ts 死代码 | 维护成本：143 行未使用代码 | 小（清理） |
| **P2** | 双 DropIndicator 渲染 | 架构：同一功能两条路径 | 小（统一） |

### 总结评分

| 维度 | 评分 | 说明 |
|------|------|------|
| wsId 作用域 | ✅ 完整 | `data-ws-id` 选择器 + `resolveWorkspaceHitTestRoot` 完全实现 |
| collectLiveCardTargets | ✅ 完整 | 替代旧 cardSnapshots，排除 ghost/placeholder |
| 碰撞检测集成 | ⚠️ 部分 | 使用自家逻辑而非 `nestedCollisionDetection`；后者是死代码 |
| rAF 节流 | ❌ 未实现 | hot path 无 RAF 防护 |
| DropIndicatorLayer | ⚠️ 有缺陷 | 渲染不可见，因几何字段缺失 |
| DOM splice 清除 | ✅ 完整 | 无 placeholderCol/placeholderGroup 残留 |
| store 更新优化 | ✅ 完整 | `dropPreviewEquals` + `safeSetDropPreview` |
| 提交护栏 | ✅ 完整 | `canCommitTabDrop` 覆盖所有分支 |

**总体状态**：核心拖拽流程可用，但 portal 渲染路径（`DropIndicatorLayer`）实际无效，`collisionDetection.ts` 是孤立的死代码，性能关键路径缺乏 rAF 节流。建议在后续迭代中清理死代码、统一 DropIndicator 渲染、添加 RAF 节流。
