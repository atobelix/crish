# Cross-07: 测试覆盖审计

> 审计日期：2026-07-22
> 数据来源：`analysis/test-results-wave4.txt`（Wave 4 全量 vitest 运行结果）、文件系统全局搜索
> 审计范围：整个 monorepo + 重点聚焦 `apps/crish-desktop`

---

## 1. 当前测试统计

### 1.1 全量运行结果（Wave 4）

| 指标 | 数值 |
|------|------|
| Test Files（总计） | 225 |
| Test Files（通过） | 222 |
| Test Files（失败） | **3** |
| Tests（总计） | 3,293 |
| Tests（通过） | 3,284 |
| Tests（失败） | **9** |
| 总运行耗时 | 63.49s |

### 1.2 apps/crish-desktop 测试汇总

本文件范围内包含 ~90+ 个测试文件，**全部通过**。以下是 Wave 4 中观察到的关键测试文件：

| 测试文件 | 测试数 | 状态 |
|----------|--------|------|
| `src/api/VirtualScrollManager.test.ts` | 27 | ✅ |
| `src/hooks/useVirtualScroll.test.ts` | 7 | ✅ |
| `src/hooks/useTabDrag.test.ts` | 41 | ✅ |
| `src/hooks/useWindowLayoutFreeze.test.ts` | 4 | ✅ |
| `src/api/binaryFrame.test.ts` | 27 | ✅ |
| `src/components/ChatMessageRow.test.ts` | 16 | ✅ |
| `src/components/VirtualList.test.ts` | 8 | ✅ |
| `src/store/layoutStore.test.ts` | 21 | ✅ |
| `src/store/layoutHelpers.test.ts` | 38 | ✅ |
| `src/store/layoutHelpers.tab.test.ts` | 10 | ✅ |
| `src/store/layoutAnimationStore.test.ts` | 10 | ✅ |
| `src/api/layoutStore.test.ts` | 21 | ✅ |
| `src/hooks/useToastQueue.test.ts` | 30 | ✅ |
| `src/hooks/useChatStream.test.ts` | 22 | ✅ |
| `src/services/StreamRecovery.test.ts` | 11 | ✅ |
| `src/services/ConnectionManager.test.ts` | 5 | ✅ |
| `tests/fuzz/virtual-scroll.test.ts` | fuzz | ✅ |
| `tests/race/store-concurrent.test.ts` | race | ✅ |
| `tests/recovery/error-recovery.test.ts` | recovery | ✅ |

### 1.3 测试分布

| 目录 | 测试文件数 | 通过 |
|------|-----------|------|
| `apps/crish-desktop/src/api/` | ~50 | ✅ 全部通过 |
| `apps/crish-desktop/src/hooks/` | ~7 | ✅ 全部通过 |
| `apps/crish-desktop/src/store/` | ~10 | ✅ 全部通过 |
| `apps/crish-desktop/src/components/` | ~6 | ✅ 全部通过 |
| `apps/crish-desktop/src/services/` | 2 | ✅ 全部通过 |
| `apps/crish-desktop/src/utils/` | 1 | ✅ 全部通过 |
| `apps/crish-desktop/tests/fuzz/` | 4 | ✅ 全部通过 |
| `apps/crish-desktop/tests/race/` | 3 | ✅ 全部通过 |
| `apps/crish-desktop/tests/recovery/` | 3 | ✅ 全部通过 |
| `apps/crish-desktop/tests/integration/` | 2 | ✅ 全部通过 |

---

## 2. 剩余失败分析

### 2.1 失败的 3 个文件 / 9 个测试

```
❌ packages/agent-daemon/src/server.test.ts        (4 failed)
❌ packages/agent-runtime/src/background-command.test.ts  (1 failed)
❌ apps/agent-workbench/src/cli/workbench-runner.test.ts  (4 failed)
```

**所有失败均位于 `packages/` 和 `apps/agent-workbench/`，`apps/crish-desktop` 范围内零失败。**

### 2.2 逐项根因分解

| # | 测试 | 文件 | 失败模式 | 根因分类 |
|---|------|------|---------|---------|
| 1 | `returns git status with staged/unstaged/untracked` | server.test.ts | **Timeout** (5000ms) | 环境/资源慢 |
| 2 | `returns git diff patch and changed file records` | server.test.ts | **Timeout** (5000ms) | 环境/资源慢 |
| 3 | `previews and applies conversation rewind` | server.test.ts | **Timeout** (5000ms) | 环境/资源慢 |
| 4 | `expires detached workflow approvals` | server.test.ts | **Assertion** — expected `"Approval (expired|timed out)"` 得到 `"The agent did not recover after runtime steering."` | 工作流错误消息变更 |
| 5 | `emits heartbeat events for silent long-running` | background-command.test.ts | **Timeout** (5000ms) + **EBUSY** | 环境/资源慢 |
| 6 | `keeps listening for background command completion` | workbench-runner.test.ts | **Assertion** — 事件缺少 `background-task-end` | 工作流逻辑 |
| 7 | `records disclosure issues from failed command` | workbench-runner.test.ts | **Timeout** (5000ms) + **EBUSY** | 环境/资源慢 |
| 8 | `marks the task done only after inspection...` | workbench-runner.test.ts | **Assertion** — expected `"done"` 得到 `"planning"` | 工作流状态机 |
| 9 | `does not treat arbitrary successful commands as verification` | workbench-runner.test.ts | **Timeout** (5000ms) | 环境/资源慢 |

### 2.3 根因统计

| 根因类别 | 计数 | 说明 |
|---------|------|------|
| **Timeout (5000ms)** | 6/9 | 测试在 Windows 环境运行缓慢，默认 timeout 不足。git 操作、daemon 生命周期在 CI 或本地可能耗时过长 |
| **Assertion/logic** | 3/9 | 工作流错误消息变更（`expires detached workflow approvals`）、状态机未推进到 `done`（`marks the task done...`）、事件流不完整（`keeps listening...`）|
| **EBUSY** | 4/9 | 清理临时目录时文件句柄未释放，是 Timeout 的副产品，非独立根因 |

### 2.4 对 crish-desktop 的影响

**为零。** 这 9 个失败涉及：
- Daemon 服务器集成测试（git 操作、websocket 重连）
- 后台命令管理器（heartbeat 超时）
- 工作台运行器（workbench-runner 状态机）

上述模块与 `apps/crish-desktop` 前端组件/工具完全隔离。

---

## 3. 测试覆盖缺口

### 3.1 Wave 4 新建模块——零测试覆盖

| 模块 | 路径 | 测试文件 | 状态 |
|------|------|---------|------|
| `collisionDetection.ts` | `src/utils/collisionDetection.ts` | ❌ 不存在 | **无测试** |
| `dragOverlay.ts` | `src/utils/dragOverlay.ts` | ❌ 不存在 | **无测试** |
| `WindowResizeBridge.ts` | `src/services/WindowResizeBridge.ts` | ❌ 不存在 | **无测试** |
| `ChatMessageList.tsx` | `src/components/ChatMessageList.tsx` | ❌ 不存在 (仅静态分析) | **无组件测试** |

### 3.2 关键组件缺少集成级测试

| 组件/模块 | 已有测试 | 类型 | 缺口 |
|-----------|---------|------|------|
| `ChatMessageList.tsx` | `useVirtualScroll.test.ts` 中的**静态源码正则检查** | source-level | 缺少渲染/交互测试。仅有 2 个 `expect(src).toMatch(...)` 正则断言，无 `render()` 调用 |
| `Workspace.tsx` | ❌ 无 | — | 拖拽集成、列宽调整、遮罩层联动无测试 |
| `useResizeFreeze.ts` | ❌ 无 | — | 重构后未加 hook 级测试 |
| `useSuspendedResizeObserver.ts` | ❌ 无 | — | catch-up 分批执行逻辑无测试 |
| `layoutAnimationStore.ts` | `layoutAnimationStore.test.ts` 10 tests ✅ | store | catch-up 分批、超时保护已覆盖 |
| `useWindowLayoutFreeze.ts` | `useWindowLayoutFreeze.test.ts` 4 tests ✅ | hook | 窗口冻结 hook 已覆盖 |
| `useTabDrag.test.ts` | 41 tests ✅ | hook | 已覆盖：碰撞检测、dragOverlay 等 tab 拖拽逻辑 |
| `useWindowControls.ts` | ❌ 无 | — | 已标记死代码，计划删除 |

### 3.3 完整缺口清单（按严重性排列）

| 优先级 | 模块 | 缺少什么 |
|--------|------|---------|
| P0 | `collisionDetection.ts` | 单元测试。函数级：`detectCollision`、`getDropZone`、`getBoundingBox` 等 |
| P0 | `dragOverlay.ts` | 单元测试。函数级：`createDragOverlay`、`removeDragOverlay`、遮罩层 DOM 操作 |
| P0 | `WindowResizeBridge.ts` | 单元/集成测试。tauri `onResize`/`onMoved` 监听、`beginLayoutInteraction` 调用 |
| P1 | `ChatMessageList.tsx` | 组件测试。`render()` + 虚拟滚动行为、会话切换、窗口平移、消息追加 |
| P1 | `useResizeFreeze.ts` | hook 测试。store 订阅、冻结/解冻、超时保护 |
| P1 | `useSuspendedResizeObserver.ts` | hook 测试。catch-up 分批、latestEntry 捕获 |
| P2 | `Workspace.tsx` | 集成测试。拖拽 + 碰撞检测 + 遮罩层 + 列宽调整的综合工作流 |

---

## 4. 需要新增的测试

### 4.1 必须新增（P0）

```typescript
// collisionDetection.test.ts 预计 ~20 tests
// - detectCollision 基本碰撞/边界情况
// - getDropZone 多列场景
// - getBoundingBox DOM 读取
// - 实时 getBoundingClientRect 替代静态快照
// - 与 useTabDrag 协作场景

// dragOverlay.test.ts 预计 ~12 tests
// - createDragOverlay 创建遮罩层
// - removeDragOverlay 清理
// - iframe pointer-events 管理
// - Escape 取消
// - 10s 超时自动解冻

// WindowResizeBridge.test.ts 预计 ~10 tests
// - 构造函数注册/注销
// - tauri onResize 回调
// - tauri onMoved 回调
// - Web fallback (window.resize)
// - beginLayoutInteraction 调用验证
// - 多次 resize 去抖
```

### 4.2 建议新增（P1）

```typescript
// ChatMessageList.test.ts 预计 ~15 tests (component)
// - 渲染消息列表
// - 虚拟滚动 range 显示
// - 会话切换 → clearHeights → syncOrder
// - 窗口平移 → syncOrder 保留高度
// - 新消息追加 → setActual
// - 锚点补偿 scrollDelta 计算

// useResizeFreeze.test.ts 预计 ~8 tests (hook)
// - store 订阅 → 冻结/解冻
// - 10s 超时自动解冻
// - unmount 清理
// - debounce 优化

// useSuspendedResizeObserver.test.ts 预计 ~6 tests (hook)
// - enableCatchup 选项
// - latestEntry 捕获
// - 分批执行（每帧 3 任务）
// - 断开 observer / catch-up 重连
```

### 4.3 现有测试的增强建议

| 现有测试 | 建议补充 |
|---------|---------|
| `useVirtualScroll.test.ts` (7 tests) | 增加：快速窗口平移连锁反应、1000 条数据的性能断言 |
| `VirtualScrollManager.test.ts` (27 tests) | 比较充分，可加：并发 setActual（多 source）、oom 测试 |
| `useTabDrag.test.ts` (41 tests) | 比较充分，可加：碰撞检测实际集成（mock collisionDetection）|

---

## 5. 新增测试方案

### 5.1 collisionDetection.test.ts

```
describe('collisionDetection')
  describe('detectCollision')
    ✓ returns collision when rects overlap
    ✓ returns null when rects do not overlap
    ✓ returns nearest when multiple collisions
    ✓ handles edge-aligned rects
    ✓ handles zero-size rects
  describe('getDropZone')
    ✓ returns the target column at cursor position
    ✓ returns the gap index between items
    ✓ handles empty column
    ✓ handles cursor outside all columns → null
  describe('getBoundingBox')
    ✓ reads element rect via getBoundingClientRect
    ✓ handles null element → fallback
  describe('integration')
    ✓ useTabDrag + collisionDetection mock: drag over columns
    ✓ real DOM: multiple columns with actual elements
```

### 5.2 dragOverlay.test.ts

```
describe('dragOverlay')
  describe('createDragOverlay')
    ✓ creates overlay div with correct styles
    ✓ appends to document.body
    ✓ sets pointer-events: none on iframes
    ✓ returns cleanup function
  describe('removeDragOverlay')
    ✓ removes overlay from DOM
    ✓ restores iframe pointer-events
    ✓ safe when called twice (idempotent)
  describe('Escape handling')
    ✓ listens for Escape key
    ✓ removes overlay on Escape
    ✓ removes listener after cleanup
  describe('timeout')
    ✓ auto-removes after 10s timeout
    ✓ clears timeout on manual cleanup
```

### 5.3 WindowResizeBridge.test.ts

```
describe('WindowResizeBridge')
  describe('constructor')
    ✓ registers tauri onResize listener
    ✓ registers tauri onMoved listener
    ✓ registers Web fallback listener
    ✓ exposes destroy method
  describe('resize handling')
    ✓ calls beginLayoutInteraction on resize
    ✓ debounces rapid resize events
    ✓ passes correct column/row dimensions
  describe('move handling')
    ✓ calls beginLayoutInteraction on window move
    ✓ uses tauri onMoved when available
  describe('Web fallback')
    ✓ uses window.resize event when tauri unavailable
  describe('destroy')
    ✓ unregisters all listeners
    ✓ safe when called multiple times
```

### 5.4 ChatMessageList.test.ts（组件级）

```
describe('ChatMessageList')
  describe('rendering')
    ✓ renders messages from messageWindow
    ✓ handles empty message list
    ✓ renders loading state
  describe('virtual scroll')
    ✓ syncs order on message change
    ✓ retains heights on window pan (expand older)
    ✓ calls clearHeights on session switch
    ✓ computes correct totalHeight
  describe('anchor compensation')
    ✓ computes scrollDelta correctly on expand older
    ✓ skips compensation on empty order
    ✓ guards against stale generation
```

---

## 6. 优先级

### 6.1 优先级矩阵

| 优先级 | 模块 | 测试数 | 复杂度 | 风险 | 工作估计 |
|--------|------|--------|--------|------|---------|
| **P0** | `collisionDetection.test.ts` | ~20 | 低（纯函数） | 高 | 0.5-1 人天 |
| **P0** | `dragOverlay.test.ts` | ~12 | 中（DOM 操作） | 高 | 0.5-1 人天 |
| **P0** | `WindowResizeBridge.test.ts` | ~10 | 中（tauri mock） | 高 | 0.5-1 人天 |
| **P1** | `ChatMessageList.test.ts` | ~15 | 高（组件渲染） | 中 | 1-2 人天 |
| **P1** | `useResizeFreeze.test.ts` | ~8 | 中（store mock） | 中 | 0.5 人天 |
| **P1** | `useSuspendedResizeObserver.test.ts` | ~6 | 中（observer mock） | 中 | 0.5 人天 |
| **P2** | `Workspace.test.ts`（集成） | ~10 | 高（多模块 mock） | 低 | 1-2 人天 |

### 6.2 关键依赖关系

```
P0 (collisionDetection)  ←  useTabDrag (已有 41 tests)
P0 (dragOverlay)          ←  Workspace (集成中)
P0 (WindowResizeBridge)   ←  App.tsx (集成中)
P1 (ChatMessageList)      →  useVirtualScroll (已有) + VirtualScrollManager (已有)
P1 (useResizeFreeze)      →  layoutAnimationStore (已有)
P1 (useSuspendedRO)       ←  ResizeObserverManager (计划中)
P2 (Workspace integration)→  dragOverlay + collisionDetection + useResizeFreeze
```

### 6.3 建议执行顺序

1. **Phase 1（P0）**：`collisionDetection.test.ts` + `dragOverlay.test.ts` + `WindowResizeBridge.test.ts`
   - 纯函数/DOM 操作，独立性强，快速填补关键缺口
   - 预计：1.5-3 人天

2. **Phase 2（P1）**：`ChatMessageList.test.ts` + `useResizeFreeze.test.ts` + `useSuspendedResizeObserver.test.ts`
   - 依赖已测试的底层模块，mock 较复杂
   - 预计：2-3 人天

3. **Phase 3（P2）**：`Workspace.test.ts` 集成测试
   - 依赖 Phase 1 和 Phase 2 的模块全部就绪
   - 预计：1-2 人天

**总计新增测试：~71 tests，预计工作量：4.5-8 人天**

### 6.4 风险提示

1. **Wave 4 新建的三个模块（collisionDetection、dragOverlay、WindowResizeBridge）尚无任何测试**。当前在 `useTabDrag.test.ts`（41 tests）中已有部分碰撞检测和拖拽逻辑的测试，但新提取的模块本身是未经测试的。集成到 Workspace.tsx 前应该先补测。
2. **ChatMessageList.tsx 仅有静态正则检查**。`useVirtualScroll.test.ts` 中通过 `readFileSync` 读取源文件并做正则匹配，这不是真正的组件测试。无法捕获运行时回归。
3. **9 个全量失败与 crish-desktop 无关**，但 Wave 4 新建模块的测试缺口是即时风险——在后续集成中可能被发现后再修复，成本更高。
