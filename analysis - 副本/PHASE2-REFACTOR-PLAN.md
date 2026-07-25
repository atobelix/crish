# Phase 2：深度重构执行计划

> 基于 8 个交叉验证 Agent 的深度审计（分析文档总计 ~2,000 行）
> 覆盖 4 个 Wave 修改后的代码库现状，定位 8 大类 24 个剩余问题
> 生成日期：2026-07-22

---

## 目录

1. [交叉验证总矩阵](#1-交叉验证总矩阵)
2. [P0 剩余问题详解](#2-p0-剩余问题详解)
3. [P1 剩余问题详解](#3-p1-剩余问题详解)
4. [P2 剩余问题详解](#4-p2-剩余问题详解)
5. [Round 1：核心 Bug 修复（P0）](#5-round-1核心-bug-修复p0)
6. [Round 2：基础设施加固（P1）](#6-round-2基础设施加固p1)
7. [Round 3：功能完备化（P1/P2）](#7-round-3功能完备化p1p2)
8. [Round 4：架构演进（P2）](#8-round-4架构演进p2)
9. [Round 5：测试门闩与发布（P2）](#9-round-5测试门闩与发布p2)
10. [文件变更总清单](#10-文件变更总清单)
11. [依赖关系与并行策略](#11-依赖关系与并行策略)

---

## 1. 交叉验证总矩阵

### 1.1 8 个 Cross-Agent 发现汇总

| Cross-Agent | 专注领域 | P0 问题 | P1 问题 | P2 问题 | 已确认正确 |
|------------|---------|---------|---------|---------|-----------|
| **Cross-01** | 虚拟滚动 | 2 (generation 死代码、缺接线测) | 1 (initial值碰撞) | 0 | 6项 |
| **Cross-02** | 冻结桥 | 0 | 2 (死代码文件、frozen 缺 finally) | 1 (缺测试) | 5项 |
| **Cross-03** | RO 管理 + 性能 | 3 (RO单例零消费者、11实例残留、useBubbleShrinkWidth) | 1 (contain 缺消息行) | 0 | 3项 |
| **Cross-04** | Tab 拖拽 | 4 (collisionDetection死代码、rAF缺失、DropIndicator不可见、双渲染) | 1 (wsId 限定) | 0 | 4项 |
| **Cross-05** | CSS 架构 | 0 | 3 (硬编码白、z-index回退、polish important) | 2 (命名不一致) | 4项 |
| **Cross-06** | 拖拽基础设施 | 0 | 2 (catch缺清理、try/catch非finally) | 0 | 5项 |
| **Cross-07** | 测试覆盖 | 0 | 3 (3个新建模块零测试) | 6 (9个预存失败) | 2项 |
| **Cross-08** | 架构差距 | 0 | 2 (L3布局引擎缺失、L5反模式) | 3 (无串行化、无核心目录、613 important) | 3项 |

### 1.2 优先级分类

```
P0（本轮必须修复 - 功能 Bug/死代码/性能杀手）：
┌─────────────────────────────────────────────────────────────────────┐
│ F01: generation 守卫死代码 — ChatMessageRow.setActual 未传 callerGen│
│ F02: collisionDetection 零导入死代码 — 模块写了但无人用              │
│ F03: ResizeObserverManager 零消费死代码 — 11 个独立 RO 实例仍活跃   │
│ F04: useBubbleShrinkWidth 仍活跃 — 1573 次强制重排                   │
│ F05: DropIndicatorLayer 渲染不可见 — 可选字段无人填充                 │
│ F06: DropIndicatorLayer + WorkspaceDropIndicator 双渲染              │
│ F07: useTabDrag 缺 rAF 节流 — 每次 pointermove 全量碰撞检测         │
│ F08: endResize catch 块缺 cleanup — iframe 永久禁用风险              │
└─────────────────────────────────────────────────────────────────────┘

P1（本轮重要修复 - 代码质量/测试/架构）：
┌─────────────────────────────────────────────────────────────────────┐
│ F09: useWindowLayoutFreeze.ts 死代码文件 — 127 行零引用             │
│ F10: WindowResizeBridge.frozen 缺 finally — 异常时永久阻塞          │
│ F11: expectedGenerationRef 初始值 0 歧义 — 与 manager.generation 碰撞│
│ F12: 11 个 RO 实例中仅 3/11 有 isLayoutFrozen 守卫                  │
│ F13: 3 个新建模块零测试覆盖 (collisionDetection / dragOverlay /    │
│       WindowResizeBridge / ResizeObserverManager)                    │
│ F14: CSS shell-layout.css:283 硬编码 #ffffff                        │
│ F15: 拖拽 z-index 回退硬编码 1000 而非 token                        │
│ F16: L3 布局引擎完全缺失（CrishSash / CrishSplitView / IView 约束） │
└─────────────────────────────────────────────────────────────────────┘

P2（后续轮次 - 持续优化/演进）：
┌─────────────────────────────────────────────────────────────────────┐
│ F17: 613 个 !important 需降至 200 以下                              │
│ F18: CSS contain 覆盖从 8 处扩展到 30+ 处                           │
│ F19: 无布局序列化/反序列化                                          │
│ F20: 无 DragOverlay Context Provider                                │
│ F21: 9 个预存测试失败需修复（超时/工作流问题）                      │
│ F22: 全局 CSS → Modules 迁移                                        │
│ F23: 无键盘无障碍拖拽                                               │
│ F24: global-drag-overlay z-index 99999 硬编码                        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. P0 剩余问题详解

### F01: generation/version 守卫是死代码

**文件:** `apps/crish-desktop/src/api/VirtualScrollManager.ts` `setActual()` 方法
**Cross-Agent:** Cross-01
**影响:** Critical — 声称的「generation 防回填」保护从未生效

**数据流追踪:**
```
ChatMessageRow:
  useEffect(() => {
    if (!msg.id || !virtualScrollManager) return;
    if (msg.text) {
      // rAF 批量 flush
      pendingInvalidations.current.add(msg.id);
      if (!rafScheduled.current) {
        rafScheduled.current = true;
        requestAnimationFrame(() => {
          rafScheduled.current = false;
          pendingInvalidations.current.forEach((id) => {
            virtualScrollManager.invalidateActual(id);  // ← 不传 generation！
          });
          pendingInvalidations.current.clear();
        });
      }
    }
  }, [msg.text, msg.id, virtualScrollManager]);
```

`VirtualScrollManager.setActual(id, height, callerGeneration?)` 的第 3 个参数 `callerGeneration` 从**没有任何调用点**传递。无论是 `ChatMessageRow` 的 `invalidateActual`(委托到 `setActual`) 还是 `useVirtualScroll` 的 `setActual` 回调，均不传 generation。

**根本原因:** generation 机制在 plan 中设计，代码中实现，但接线被遗漏。

**修复方案:**
1. `useVirtualScroll.ts` 的 `setActual` 回调需捕获当前 `manager.generation` 传入
2. `ChatMessageRow.tsx` 的 invalidation 需通过 `useVirtualScroll` 的包装方法而非直接调用 `manager`
3. 或采用更简单的方案：在 `ChatMessageRow` 中传递 `expectedGenerationRef.current`

### F02: collisionDetection.ts 零导入死代码

**文件:** `apps/crish-desktop/src/utils/collisionDetection.ts`
**Cross-Agent:** Cross-04
**影响:** High — 碰撞检测模块写了但 never used

**证据:**
```bash
grep -rn "collisionDetection" apps/crish-desktop/src/ --include="*.ts" --include="*.tsx"
# 仅输出：定义文件自身 + package.json（不存在）
```

`nestedCollisionDetection` 和 `computeDropIndicatorRect` 从未被 `useTabDrag` 或任何文件引用。

**根本原因:** Wave 1 创建了模块但未在 Wave 3 完成集成。

**修复方案:**
1. 在 `useTabDrag.ts` 的 `handleTabPointerMove` 中引用 `nestedCollisionDetection`
2. 将碰撞检测结果映射为 `DropPreviewState`
3. 调用 `setDropPreview()` 触发 `DropIndicatorLayer` 更新

### F03: ResizeObserverManager 零消费死代码

**文件:** `apps/crish-desktop/src/services/ResizeObserverManager.ts`
**Cross-Agent:** Cross-03
**影响:** High — 单例创建了但无任何组件使用

**证据:**
```bash
grep -rn "ResizeObserverManager" apps/crish-desktop/src/ --include="*.ts" --include="*.tsx"
# 仅输出：定义文件自身
```

**12 个独立 RO 实例仍然活跃:**
| # | 文件 | 创建方式 | isLayoutFrozen 守卫 |
|---|------|---------|-------------------|
| 1 | ChatMessageList.tsx | `new ResizeObserver` | ✅ 有 |
| 2 | ChatMessageRow.tsx | `useBubbleShrinkWidth` | ❌ 无 |
| 3 | FilesCard.tsx | `new ResizeObserver` | ✅ 有 |
| 4 | TerminalCard.tsx | `fitAddon.fit()` | ❌ 无 |
| 5 | ChatToolCallBlock.tsx | `new ResizeObserver` | ❌ 无 |
| 6 | Sidebar.tsx | `new ResizeObserver` | ❌ 无 |
| 7 | DiffCard.tsx | `new ResizeObserver` | ❌ 无 |
| 8 | OverviewCard.tsx | `new ResizeObserver` | ❌ 无 |
| 9 | SettingsPanel.tsx | `new ResizeObserver` | ❌ 无 |
| 10 | PreviewCard.tsx | `new ResizeObserver` | ❌ 无 |
| 11 | VirtualList.tsx | `new ResizeObserver` | ❌ 无 |
| 12 | ChatMessageRow.tsx | `ResizeObserver` (另一个) | ✅ 有 |

**修复方案:**
1. 迁移每个使用点到 `ResizeObserverManager.observe(el, cb)`
2. 在 `layoutAnimationStore` 订阅中连接 `setSuspended`

### F04: useBubbleShrinkWidth 仍活跃

**文件:** `apps/crish-desktop/src/components/ChatMessageRow.tsx` (L307, L569)
**Cross-Agent:** Cross-03
**影响:** High — 1573 次强制同步重排

**证据:**
```typescript
// ChatMessageRow.tsx L307 附近
const { ref: bubbleRef, width: bubbleWidth } = useBubbleShrinkWidth();
// ← 每次 React commit 后测量 bubbleRef.current.clientWidth
// ← clientWidth 读取触发强制同步重排
```

**修复方案:**
1. 使用 CSS `flex-shrink: 1; min-width: 0; overflow: hidden;` 替代 JS 测量
2. 或使用 `ResizeObserverManager` 挂起友好方式
3. 或仅在 `!isLayoutFrozen` 时测量，冻结时跳过

### F05: DropIndicatorLayer 渲染不可见

**文件:** `apps/crish-desktop/src/components/DropIndicatorLayer.tsx`
**Cross-Agent:** Cross-04
**影响:** High — Portal 浮层渲染了但用户看不到

**证据:**
```typescript
// DropIndicatorLayer.tsx 读取 dropPreview
const dropPreview = useLayoutStore((s) => s.dropPreview);
// DropPreviewState 中 left/top/width/height 是可选字段
// useTabDrag 写入的 dropPreview 只有 { colIdx, groupIdx, direction }
// → left=undefined, top=undefined, width=undefined, height=undefined
// → <div style={{position:'absolute', left:undefined, top:undefined,
//               width:undefined, height:undefined}} />
// → 浏览器渲染为 width:0; height:0; → 不可见！
```

**修复方案:**
1. 在 `useTabDrag` 中调用 `computeDropIndicatorRect` 计算几何
2. 将计算结果写入 `DropPreviewState`
3. 或 `DropIndicatorLayer` 自行调用 `computeDropIndicatorRect`

### F06: DropIndicatorLayer + WorkspaceDropIndicator 双渲染

**文件:** `apps/crish-desktop/src/components/Workspace.tsx`
**Cross-Agent:** Cross-04
**影响:** Medium — 两个浮层同时渲染，浪费性能

**证据:**
```tsx
// Workspace.tsx ~L508
<WorkspaceDropIndicator dropPreview={dropPreview} />
// Workspace.tsx ~L519
<DropIndicatorLayer wsId={ws.id} />
```

`WorkspaceDropIndicator` 是旧版实现（基于 DOM 的指示器），`DropIndicatorLayer` 是新版 Portal 实现。两者同时渲染。

**修复方案:**
1. 确认 `WorkspaceDropIndicator` 是否可移除
2. 如果可移除，删除它并只保留 `DropIndicatorLayer`
3. 如果兼容期需要，通过特性开关控制

### F07: useTabDrag 缺 rAF 节流

**文件:** `apps/crish-desktop/src/hooks/useTabDrag.ts` `handleTabPointerMove`
**Cross-Agent:** Cross-04
**影响:** Medium — 每次 pointermove（60fps）执行全量碰撞检测

**证据:**
```typescript
// useTabDrag.ts handleTabPointerMove
// 直接响应 pointermove 事件，无 rAF 节流
// 每次触发都执行 querySelectorAll + getBoundingClientRect
```

在卡片数 > 20 时，每帧多次执行 `querySelectorAll('.workspace-card')` + 遍历 `getBoundingClientRect` + 碰撞检测计算，造成不必要的性能开销。

**修复方案:**
```typescript
let rafPending = false;
const handlePointerMove = (e: PointerEvent) => {
  if (rafPending) return;
  rafPending = true;
  const x = e.clientX, y = e.clientY;
  requestAnimationFrame(() => {
    rafPending = false;
    performCollisionDetection(x, y);
  });
};
```

### F08: endResize catch 块缺 cleanup

**文件:** `apps/crish-desktop/src/hooks/useColumnResize.ts`
**Cross-Agent:** Cross-06
**影响:** Medium — 异常时 iframe 指针永久禁用

**证据:**
```typescript
const endResize = (upEvent: PointerEvent) => {
  if (ended) return; ended = true;
  try {
    overlay.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', endResize);
    window.removeEventListener('pointercancel', endResize);
    removeDragOverlay(overlay);
    restoreIframes();           // ← 恢复 iframe 指针
    removeGlobalCursorStyle(cursorStyle); // ← 移除全局光标
    // ...
  } catch (err) {
    console.error('[useColumnResize] endResize error', err);
    endLayoutInteraction('workspace-resizing');
    document.body.style.cursor = '';
    removeDragOverlay(overlay);
    // ❌ 缺少 restoreIframes() 和 removeGlobalCursorStyle(cursorStyle)!
  }
};
```

**修复方案:** 在 catch 块中补充遗漏的 cleanup 调用。

---

## 3. P1 剩余问题详解

### F09: useWindowLayoutFreeze.ts 死代码

**文件:** 存在但未被引用的 127 行 hook 文件
**Cross-Agent:** Cross-02
**修复:** 确认零引用后删除文件和相关测试引用

### F10: frozen 标志位缺 finally

**文件:** `apps/crish-desktop/src/services/WindowResizeBridge.ts`
**Cross-Agent:** Cross-02
**修复:** `handleWindowChange` 中使用 `try/finally { this.frozen = false }`

### F11: expectedGenerationRef 初始值碰撞

**文件:** `apps/crish-desktop/src/components/ChatMessageList.tsx`
**Cross-Agent:** Cross-01
**修复:** 初始值设为 -1 或 `Symbol()`

### F12: 仅 3/11 RO 有冻结守卫

**Cross-Agent:** Cross-03
**修复:** 逐步迁移剩余 8 个 RO 使用点到 `ResizeObserverManager`

### F13: 4 个新建模块零测试

**Cross-Agent:** Cross-07
**修复:** 为 collisionDetection / dragOverlay / WindowResizeBridge / ResizeObserverManager 添加单元测试

### F14-F16: CSS + 架构遗留

详见各 Cross-Agent 的报告。

---

## 4. P2 剩余问题详解

(略，见各 Cross-Agent 文档)

---

## 5. Round 1：核心 Bug 修复（P0）

### 5.1 概述

**目标:** 修复 8 个 P0 问题中直接导致功能异常或性能问题的
**参与 Agent:** 7 个
**并行度:** 7 个 Agent 完全并行（无文件冲突）

| Agent | 任务 | 文件 | 依赖 |
|-------|------|------|------|
| A-R1-01 | 修复 generation 死代码 + 补接线级测试 | ChatMessageRow.tsx + useVirtualScroll.ts + VirtualScrollManager.ts | 无 |
| A-R1-02 | 修复 endResize catch 块缺 cleanup | useColumnResize.ts | 无 |
| A-R1-03 | 修复 frozen 缺 finally + 删除死代码文件 | WindowResizeBridge.ts + useWindowLayoutFreeze.ts 删除 | 无 |
| A-R1-04 | 集成 collisionDetection 到 useTabDrag + rAF 节流 | useTabDrag.ts + collisionDetection.ts | 无 |
| A-R1-05 | 修复 DropIndicatorLayer 双渲染 + 不可见 | DropIndicatorLayer.tsx + Workspace.tsx + store/types.ts | 无 |
| A-R1-06 | 迁移 11 个 RO 到 ResizeObserverManager 单例 | 12 个组件文件 + ResizeObserverManager.ts | 无 |
| A-R1-07 | 移除 useBubbleShrinkWidth | ChatMessageRow.tsx | 无 |

### 5.2 Agent A-R1-01：修复 generation 守卫死代码

**文件:**
- `apps/crish-desktop/src/hooks/useVirtualScroll.ts` — 修改 setActual 回调传递 generation
- `apps/crish-desktop/src/api/VirtualScrollManager.ts` — 确认接口
- `apps/crish-desktop/src/components/ChatMessageRow.tsx` — 修改 invalidation 路径
- `apps/crish-desktop/src/components/ChatMessageList.tsx` — 修复 expectedGenerationRef 初始值

**具体修改:**

1. `useVirtualScroll.ts`:
```typescript
// 在返回的 setActual 回调中捕获当前 generation
const setActual = useCallback((id: string, height: number) => {
  manager.setActual(id, height, manager.getGeneration());
  setHeightTick(t => t + 1);
}, [manager]);
```

2. `ChatMessageRow.tsx`:
```typescript
// invalidation 通过 useVirtualScroll 的 setActual 而非直接 manager
// 如果 ChatMessageRow 直接持有 manager 引用
// 则需要在 invalidation 时获取当前 generation
// 简单方案：从 props 传入 expectedGenerationRef.current
// 或在 virtualScrollManager 调用时传 generation

// 修改前：
virtualScrollManager.invalidateActual(id);
// 修改后：
virtualScrollManager.setActual(id, undefined, virtualScrollManager.getGeneration());
```

3. `ChatMessageList.tsx`:
```typescript
// 修改 expectedGenerationRef 初始值避免歧义
const expectedGenerationRef = useRef(-1);
// 在 clearHeights 后同步
expectedGenerationRef.current = manager.getGeneration();
```

### 5.3 Agent A-R1-02：修复 endResize catch 块

**文件:**
- `apps/crish-desktop/src/hooks/useColumnResize.ts`

**具体修改:**
```typescript
// 在 catch 块中补充：
} catch (err) {
  console.error('[useColumnResize] endResize error', err);
  endLayoutInteraction('workspace-resizing');
  document.body.style.cursor = '';
  removeDragOverlay(overlay);
  restoreIframes();              // ← 新增
  removeGlobalCursorStyle(cursorStyle); // ← 新增
}
```

同时对 `handleGroupResizerPointerDown` 的 endResize 做相同修复。

### 5.4 Agent A-R1-03：修复 frozen + 清理死代码

**文件:**
- `apps/crish-desktop/src/services/WindowResizeBridge.ts` — 修改 handleWindowChange
- 删除 `apps/crish-desktop/src/hooks/useWindowLayoutFreeze.ts`（如果存在）

**具体修改:**

1. `WindowResizeBridge.ts`:
```typescript
private handleWindowChange(): void {
  if (this.frozen) return;
  this.frozen = true;
  try {
    beginLayoutInteraction('window-resizing');
    this.cancelTimers();
    this.watchdogTimer = setTimeout(() => {
      console.warn('[WindowResizeBridge] watchdog fired — forced thaw');
      endLayoutInteraction('window-resizing');
      this.frozen = false;
    }, this.WATCHDOG_MS);
    this.debounceTimer = setTimeout(() => {
      this.cancelTimers();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          endLayoutInteraction('window-resizing');
          this.frozen = false;
        });
      });
    }, this.DEBOUNCE_MS);
  } catch (err) {
    console.error('[WindowResizeBridge] handleWindowChange error', err);
    endLayoutInteraction('window-resizing');
    this.frozen = false;  // finally 确保
  }
}
```

2. 搜索 `useWindowLayoutFreeze` 的引用，确认零引用后删除文件。

### 5.5 Agent A-R1-04：集成 collisionDetection + rAF 节流

**文件:**
- `apps/crish-desktop/src/hooks/useTabDrag.ts` — 核心修改
- `apps/crish-desktop/src/utils/collisionDetection.ts` — 确认接口

**具体修改:**

在 `useTabDrag.ts` 的 `handleTabPointerMove` 中：

```typescript
import { nestedCollisionDetection, computeDropIndicatorRect } from '../../utils/collisionDetection';

// rAF 节流变量
const rafPendingRef = useRef(false);
const lastPointerRef = useRef({ x: 0, y: 0 });

const handlePointerMove = useCallback((e: PointerEvent) => {
  lastPointerRef.current = { x: e.clientX, y: e.clientY };
  
  if (rafPendingRef.current) return;
  rafPendingRef.current = true;
  
  requestAnimationFrame(() => {
    rafPendingRef.current = false;
    const { x, y } = lastPointerRef.current;
    
    // wsId 作用域限定
    const scope = `[data-ws-id="${wsId}"]`;
    const cardElements = document.querySelectorAll(
      `${scope} .workspace-card:not(.placeholder-card-group)`
    );
    const cardRects = Array.from(cardElements).map((el) => ({
      id: el.getAttribute('data-card-id') || '',
      rect: el.getBoundingClientRect(),
    }));
    
    if (cardRects.length === 0) {
      setDropPreview(null);
      return;
    }
    
    const result = nestedCollisionDetection({ x, y }, cardRects);
    
    if (result) {
      const canvasEl = document.querySelector(`${scope} .workspace-canvas`);
      const canvasRect = canvasEl?.getBoundingClientRect();
      
      if (canvasRect) {
        const indicatorRect = computeDropIndicatorRect(
          {
            type: mapZoneToDropType(result.zone),
            wsId,
            colIdx: parseInt(cardElements[0]?.getAttribute('data-col-idx') || '0'),
            groupIdx: parseInt(cardElements[0]?.getAttribute('data-group-idx') || '0'),
            rect: result.rect,
          },
          {
            left: canvasRect.left, top: canvasRect.top,
            right: canvasRect.right, bottom: canvasRect.bottom,
            width: canvasRect.width, height: canvasRect.height,
          },
        );
        
        setDropPreview({
          colIdx: 0,
          groupIdx: 0,
          direction: mapZoneToDirection(result.zone),
          left: indicatorRect.left,
          top: indicatorRect.top,
          width: indicatorRect.width,
          height: indicatorRect.height,
          className: indicatorRect.className,
        });
      }
    } else {
      setDropPreview(null);
    }
  });
}, [wsId]);
```

辅助函数：
```typescript
function mapZoneToDropType(zone: FiveZone): DropTarget['type'] {
  switch (zone) {
    case 'leftEdge': return 'insert-col-left';
    case 'rightEdge': return 'insert-col-right';
    case 'top': return 'insert-group-top';
    case 'bottom': return 'insert-group-bottom';
    case 'center': return 'merge-to-group';
  }
}

function mapZoneToDirection(zone: FiveZone): string {
  switch (zone) {
    case 'leftEdge': return 'left';
    case 'rightEdge': return 'right';
    case 'top': return 'top';
    case 'bottom': return 'bottom';
    case 'center': return 'merge';
  }
}
```

### 5.6 Agent A-R1-05：修复 DropIndicatorLayer

**文件:**
- `apps/crish-desktop/src/components/DropIndicatorLayer.tsx`
- `apps/crish-desktop/src/components/Workspace.tsx`
- `apps/crish-desktop/src/store/types.ts`

**具体修改:**

1. 在 Workspace.tsx 中移除旧 `WorkspaceDropIndicator` 或二选一：
```tsx
// 只保留新版 DropIndicatorLayer
// <WorkspaceDropIndicator dropPreview={dropPreview} />  ← 删除
<DropIndicatorLayer wsId={ws.id} />
```

2. 如果 `DropPreviewState` 中 left/top/width/height 是可选字段，改为必填：
```typescript
export interface DropPreviewState {
  colIdx: number;
  groupIdx: number;
  direction: string;
  left: number;      // ← 改为必填
  top: number;       // ← 改为必填
  width: number;     // ← 改为必填
  height: number;    // ← 改为必填
  className: string; // ← 改为必填
}
```

### 5.7 Agent A-R1-06：迁移 11 个 RO 到单例

**文件:** 逐个迁移

**迁移模式（每个文件）:**

```typescript
// 修改前：
const observer = new ResizeObserver((entries) => {
  for (const entry of entries) handleResize(entry);
});
observer.observe(ref.current);

useEffect(() => {
  return () => observer.disconnect();
}, []);

// 修改后：
import { ResizeObserverManager } from '../../services/ResizeObserverManager';

useEffect(() => {
  const mgr = ResizeObserverManager.getInstance();
  mgr.observe(ref.current, handleResize);
  return () => mgr.unobserve(ref.current, handleResize);
}, []);

// isLayoutFrozen 挂起自动生效（由 layoutAnimationStore 订阅控制）
```

**迁移顺序（按风险评估）：**
1. TerminalCard.tsx (fitAddon.fit() — 固定宽度，低风险)
2. FilesCard.tsx (setContainerHeight — 已有守卫，低风险)
3. ChatToolCallBlock.tsx (测量 — 已部分挂起)
4. Sidebar.tsx (宽度测量 — 中风险)
5. DiffCard.tsx (宽度测量 — 低风险)
6. OverviewCard.tsx (宽度测量 — 低风险)
7. SettingsPanel.tsx (设置面板 — 低风险)
8. PreviewCard.tsx (预览面板 — 低风险)
9. VirtualList.tsx (虚拟列表 — 需谨慎)
10. ChatMessageRow.tsx (useBubbleShrinkWidth 替代)
11. ChatMessageList.tsx (setContainerWidth — 已有守卫)

### 5.8 Agent A-R1-07：移除 useBubbleShrinkWidth

**文件:**
- `apps/crish-desktop/src/components/ChatMessageRow.tsx`

**具体修改:**

1. 查找 `useBubbleShrinkWidth` 的使用方式
2. 分析其作用是动态计算气泡的收缩宽度
3. 替代方案：
   - 如果用于 flex 布局中的收缩控制 → 使用 CSS `flex-shrink: 1; min-width: 0`
   - 如果用于动态宽度计算 → 使用 `ResizeObserverManager` 挂起友好方式
   - 如果仅用于视觉对齐 → 使用 `max-width: 100%` + `overflow: hidden`
4. 删除 `useBubbleShrinkWidth` 的 import 和调用
5. 应用 CSS 替代方案

### 5.9 Round 1 验证清单

```
P0 修复验证：
[ ] F01: generation 守卫 — setActual 调用传递 callerGeneration
[ ] F01: ChatMessageRow invalidation 使用 generation 校验
[ ] F01: expectedGenerationRef 初始值改为 -1
[ ] F02: collisionDetection 在 useTabDrag 中被引用
[ ] F02: useTabDrag 碰撞检测使用 nestedCollisionDetection
[ ] F03: 11 个 RO 实例全部迁移到 ResizeObserverManager
[ ] F03: ResizeObserverManager 至少有一个消费者
[ ] F04: useBubbleShrinkWidth 引用全部移除
[ ] F04: 强制重排从 ~1573 降至 0
[ ] F05: DropPreviewState left/top/width/height/className 为必填
[ ] F05: DragPreview 在 useTabDrag 中填充几何字段
[ ] F06: DropIndicatorLayer 或 WorkspaceDropIndicator 只有一个渲染
[ ] F07: useTabDrag handlePointerMove 有 rAF 节流
[ ] F08: endResize catch 块包含 restoreIframes + removeGlobalCursorStyle

编译与测试：
[ ] TypeScript 编译无错误
[ ] VirtualScrollManager 全部 27 测试通过
[ ] useVirtualScroll 全部 7 测试通过
[ ] useTabDrag 全部 41 测试通过
```

---

## 6. Round 2：基础设施加固（P1）

### 6.1 概述

**目标:** 修复 P1 问题（F09-F16），补充测试，加固架构
**参与 Agent:** 5 个
**并行度:** 5 个 Agent 完全并行

| Agent | 任务 | 文件 |
|-------|------|------|
| A-R2-01 | 删除 useWindowLayoutFreeze 死代码 + WindowResizeBridge 测试 | useWindowLayoutFreeze.ts 删除 + WindowResizeBridge.test.ts 新建 |
| A-R2-02 | collisionDetection + dragOverlay + ResizeObserverManager 单元测试 | 3 个 .test.ts 新建 |
| A-R2-03 | CSS 硬编码修复 + z-index 治理 | shell-layout.css + shell-dragdrop.css + tokens.css |
| A-R2-04 | CSS contain 批量注入（从 8 处到 30+） | 多个 .module.css + shell-*.css |
| A-R2-05 | useBubbleShrinkWidth 的 CSS 替代方案验证 | 确认 CSS 替代生效 |

### 6.2 Agent A-R2-01：死代码删除 + 测试

**删除文件：**
- `apps/crish-desktop/src/hooks/useWindowLayoutFreeze.ts`（确认无引用后删除）

**新建测试文件：**
- `apps/crish-desktop/src/services/WindowResizeBridge.test.ts`

测试用例：
```
1. 构造实例后 connect → 应注册 Tauri 事件（mock）
2. Tauri API 不可用时 → 降级到 Web fallback
3. handleWindowChange → beginLayoutInteraction 被调用
4. 200ms debounce → endLayoutInteraction 被调用
5. 5s watchdog → 强制解冻
6. 连续快速事件 → 防重入
7. disconnect → 所有清理运行
```

### 6.3 Agent A-R2-02：新建模块测试

**文件：**
- `apps/crish-desktop/src/utils/collisionDetection.test.ts`
- `apps/crish-desktop/src/utils/dragOverlay.test.ts`
- `apps/crish-desktop/src/services/ResizeObserverManager.test.ts`

collisionDetection 测试用例（纯函数，简单）：
```
1. isPointerInRect → 在/不在矩形内
2. rectIntersection → 排序正确
3. closestCenter → 距离正确
4. fiveZoneDetection → 五区域正确
5. edgeDetection → 边界正确
6. nestedCollisionDetection → 级联正确
7. computeDropIndicatorRect → 位置正确
```

### 6.4 Agent A-R2-03：CSS 硬编码修复

**修复项：**
1. `shell-layout.css:283` — `color: #ffffff` → `color: var(--text-primary)`
2. `shell-dragdrop.css` 中的 `z-index: 99999` → `z-index: var(--z-drag-overlay-max, 99999)`
3. `global-drag-overlay` 的 `z-index: 99999` → 同上

### 6.5 Agent A-R2-04：CSS contain 批量注入

从 Round 5 的注入清单中选择剩余容器注入 `contain: layout style`。优先注入高频变化区域：
- `.chat-message-row` — 消息行
- `.chat-doc-flow` — 文档流
- `.card-body` — 卡片体
- `.diff-panel` — diff 面板
- `.files-card .file-item` — 文件项

### 6.6 Round 2 验证清单

```
[ ] useWindowLayoutFreeze.ts 删除（确认无引用）
[ ] WindowResizeBridge.test.ts 新建且通过
[ ] collisionDetection.test.ts 新建且通过
[ ] dragOverlay 无法在 Node 中测试（DOM 依赖）— 记录为手动测试
[ ] ResizeObserverManager.test.ts 新建且通过
[ ] shell-layout.css 无硬编码颜色
[ ] 拖拽 z-index 使用 token
[ ] CSS contain 从 8 处增加到 15+ 处
[ ] TypeScript 编译无错误
```

---

## 7. Round 3：功能完备化（P1/P2）

### 7.1 概述

**目标:** 实现延迟的功能模块，推进 !important 治理
**参与 Agent:** 6 个
**并行度:** 6 个 Agent 完全并行

| Agent | 任务 | 文件 |
|-------|------|------|
| A-R3-01 | 实现 DragOverlay Context Provider | dragContext.tsx (new) + GlobalDragOverlay.tsx (new) |
| A-R3-02 | !important 第二阶段治理（目标 300） | 多 CSS 文件 |
| A-R3-03 | ColumnResizeHandle 组件提取 | ColumnResizeHandle.tsx (new) + Workspace.tsx |
| A-R3-04 | 列约束系统 + CrishSplitView 原型 | layoutStore.ts + crishSplitView.ts (new) |
| A-R3-05 | 9 个预存测试失败修复 | server.test.ts / background-command.test.ts / workbench-runner.test.ts |
| A-R3-06 | keyboard 无障碍拖拽 | useTabDrag.ts + useKeyboardSensor.ts (new) |

### 7.2 Agent A-R3-01：DragOverlay Context

参考 DnD Kit 的 DragOverlay 架构，创建 Context Provider + GlobalDragOverlay 组件。

```typescript
// src/contexts/dragContext.tsx
interface DragOverlayContextValue {
  active: boolean;
  setOverlay: (node: React.ReactNode, position: { x: number; y: number }) => void;
  clearOverlay: () => void;
  updatePosition: (x: number, y: number) => void;
}

// src/components/drag/GlobalDragOverlay.tsx
// 通过 createPortal 渲染到 document.body
// 跟随鼠标位置
// 拖拽卡片克隆 + 半透明 + 阴影
```

### 7.3 Agent A-R3-02：!important 第二阶段

目标：从 398 降至 300。
重点文件：shell-polish.css (146处)、shell-workspace.css (83处)

策略：
1. 增加选择器特异性替代 !important
2. 对已迁移到 Module 的组件，删除全局 CSS 中的冗余定义
3. 使用 @layer 控制级联

### 7.4 Agent A-R3-03：ColumnResizeHandle 组件

从 Workspace.tsx 中提取列拖拽手柄为独立组件。

```typescript
// src/components/workspace/ColumnResizeHandle.tsx
interface ColumnResizeHandleProps {
  orientation: 'vertical' | 'horizontal';
  onResizeStart: (e: React.PointerEvent) => void;
  // ... 其他 props
}
```

### 7.5 Round 3 验证清单

```
[ ] DragOverlayContext 创建且可用
[ ] GlobalDragOverlay 渲染拖拽预览卡片
[ ] !important 从 398 降至 300 以下
[ ] ColumnResizeHandle 组件提取
[ ] 预存测试失败从 9 降至 5 以下
[ ] keyboard 拖拽基本可用
[ ] TypeScript 编译无错误
```

---

## 8. Round 4：架构演进（P2）

### 8.1 概述

**目标:** 布局引擎演进、CSS 模块化迁移
**参与 Agent:** 5 个
**并行度:** 5 个 Agent 完全并行

| Agent | 任务 | 文件 |
|-------|------|------|
| A-R4-01 | 布局序列化/反序列化 | layoutSerializer.ts (new) + layoutStore.ts |
| A-R4-02 | CrishGrid 树状结构 | crishGrid.ts (new) + layoutHelpers.ts |
| A-R4-03 | CSS Modules 迁移（chat.css → ChatCard.module.css） | 多 CSS 文件 |
| A-R4-04 | !important 第三阶段治理（目标 200） | 多 CSS 文件 |
| A-R4-05 | CSS contain 完全覆盖（目标 30+） | 多 CSS 文件 |

### 8.2 Agent A-R4-01：布局序列化

```typescript
// src/utils/layoutSerializer.ts
interface ISerializableLayout {
  version: number;
  root: ISerializableNode;
}

interface ISerializableNode {
  type: 'branch' | 'leaf';
  direction?: 'horizontal' | 'vertical';
  children?: ISerializableNode[];
  sizes?: number[];
  panelType?: string;
  tabs?: string[];
  activeTab?: string;
}

export function serializeLayout(ws: WorkspaceState): ISerializableLayout
export function deserializeLayout(data: ISerializableLayout): WorkspaceState
export function takeLayoutSnapshot(): void
export function restoreLayoutSnapshot(): void
```

### 8.3 Round 4 验证清单

```
[ ] 布局可序列化为 JSON 并恢复
[ ] 序列化/反序列化单元测试通过
[ ] CrishGrid 树状结构定义完成
[ ] chat.css 逐步迁移到 ChatCard.module.css
[ ] !important 从 300 降至 200 以下
[ ] CSS contain 从 15 处增加到 30+ 处
[ ] TypeScript 编译无错误
```

---

## 9. Round 5：测试门闩与发布（P2）

### 9.1 概述

**目标:** 全量回归测试 + 性能基准 + 发布准备
**参与 Agent:** 6 个

| Agent | 任务 | 文件 |
|-------|------|------|
| A-R5-01 | 全量回归测试 + 性能基准 | 所有 .test.ts |
| A-R5-02 | ChatMessageList 接线级测试 | ChatMessageList.test.tsx (new) |
| A-R5-03 | 9 个预存失败最终修复 | server.test.ts / background-command.test.ts / workbench-runner.test.ts |
| A-R5-04 | CSS 最终审计 + 基线建立 | 所有 CSS 文件 |
| A-R5-05 | TypeScript strict 检查 + 清理 | 所有 .ts/.tsx |
| A-R5-06 | 文档更新 + 变更日志 | CHANGELOG.md / docs/ |

### 9.2 Round 5 验证清单

```
[ ] 全量测试通过率 > 99%
[ ] 性能基准建立（FPS、内存、加载时间）
[ ] 接线级测试覆盖 ChatMessageList 关键路径
[ ] CSS !important 最终统计 < 200
[ ] CSS contain 覆盖 > 30 处
[ ] TypeScript strict 模式无新错误
[ ] 文档更新完成
```

---

## 10. 文件变更总清单

### Round 1 文件变更

```
Round 1（P0 - 7 Agent 并行）：
├── Modified:
│   ├── src/hooks/useVirtualScroll.ts          — setActual 传 generation
│   ├── src/components/ChatMessageRow.tsx      — invalidation 传 generation, 移 bubble
│   ├── src/components/ChatMessageList.tsx     — expectedGenerationRef 初始值
│   ├── src/hooks/useColumnResize.ts           — catch 块补充 cleanup
│   ├── src/services/WindowResizeBridge.ts     — try/finally frozen
│   ├── src/hooks/useTabDrag.ts               — 集成 collisionDetection + rAF 节流
│   ├── src/components/Workspace.tsx           — DropIndicatorLayer 二选一
│   ├── src/store/types.ts                    — DropPreviewState 字段必填
│   ├── src/components/DropIndicatorLayer.tsx  — 使用必填字段渲染
│   └── 11 个 RO 使用者文件                   — 迁移到 ResizeObserverManager
├── Deleted:
│   └── src/hooks/useWindowLayoutFreeze.ts     — 死代码
└── New:
    └── (无新增文件)
```

### Round 2-5 文件变更（简略）

见各 Round 详细说明。

---

## 11. 依赖关系与并行策略

### 11.1 Round 依赖图

```
Round 1 (P0) ← 无依赖，立即执行
  │
  ├──→ Round 2 (P1: 测试 + 加固) ← 依赖 R1 修复后的代码
  │
  ├──→ Round 3 (P1/P2: 功能完备) ← 依赖 R1 修复（特别是 RO 迁移和 collisionDetection 集成）
  │
  ├──→ Round 4 (P2: 架构演进) ← 依赖 R1+R2+R3 的基础
  │
  └──→ Round 5 (P2: 门闩) ← 依赖 R1-R4 全部完成
```

### 11.2 并行执行策略

```
第一波（7 Agent 完全并行）：
  A-R1-01, A-R1-02, A-R1-03, A-R1-04, A-R1-05, A-R1-06, A-R1-07

第二波（5 Agent 完全并行）：
  A-R2-01, A-R2-02, A-R2-03, A-R2-04, A-R2-05

第三波（6 Agent 完全并行）：
  A-R3-01, A-R3-02, A-R3-03, A-R3-04, A-R3-05, A-R3-06

第四波（5 Agent 完全并行）：
  A-R4-01, A-R4-02, A-R4-03, A-R4-04, A-R4-05

第五波（6 Agent 完全并行）：
  A-R5-01, A-R5-02, A-R5-03, A-R5-04, A-R5-05, A-R5-06
```

### 11.3 关键风险

1. **RO 迁移风险**（A-R1-06）：同时修改 11 个文件，需要确保每个迁移的测试覆盖。建议先在 3 个低风险组件（TerminalCard / FilesCard / ChatToolCallBlock）上验证模式，再逐步推广。
2. **useBubbleShrinkWidth 移除风险**（A-R1-07）：如果 CSS 替代方案不完美，UI 可能出现错位。建议先在开发环境验证，确认无误后再部署。
3. **collisionDetection 集成风险**（A-R1-04）：修改 useTabDrag 的核心拖拽逻辑，可能影响现有拖拽行为。建议充分测试后再合并。

---

> 本计划基于 8 个交叉验证 Agent 的深度审计（分析文档总计 ~2,000 行）
> 覆盖 24 个剩余问题（8 P0 + 8 P1 + 8 P2）
> 分 5 个 Round，每轮 5-7 个 Agent 并行执行
> 文件变更涉及 ~30 个文件修改 + ~5 个新建
