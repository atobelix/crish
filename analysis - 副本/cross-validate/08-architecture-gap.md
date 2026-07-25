# Cross-08: 架构差距审计

> 交叉验证 Agent-06 的六层统一架构目标与当前 Crish 实现之间的差距。
> 审计日期：2026-07-22 | 审计范围：`apps/crish-desktop/src`

---

## 1. 目标架构回顾

### 1.1 六层统一架构（来自 ULTIMATE-REFACTOR-PLAN）

| 层 | 名称 | 核心组件 | 职责 |
|----|------|---------|------|
| L0 | CSS Token System | `tokens.css` | 拖拽/布局/动画变量，零 fallback |
| L1 | Global Freeze Service | `WindowResizeBridge`, `layoutAnimationStore`, `ResizeObserverManager` | 统一冻结信号 |
| L2 | Drag Infrastructure | `DragOverlayContext`, `CollisionDetection`, `DropIndicatorLayer` | 纯视觉浮层，不碰 DOM |
| L3 | Layout Engine | `CrishGrid`, `CrishSplitView`, `CrishSash` | 树状嵌套 + 约束系统 + 序列化 |
| L4 | Virtual Scroll | `VirtualScrollManager v2` | 防御性 syncOrder |
| L5 | React Components | 纯展示组件 | CSS Modules，零 !important |

### 1.2 VS Code 参考约束接口（Agent-06 核心推荐）

```typescript
interface IView {
  element: HTMLElement;
  minimumSize: number;       // 最小宽度/高度
  maximumSize: number;       // 最大宽度/高度
  priority?: LayoutPriority; // Low | Normal | High
  proportionalLayout?: boolean;
  snap?: boolean;            // 到达最小尺寸时吸边
}
```

---

## 2. 当前实现差距

### 2.1 Layer 0: CSS Token System — 部分完成

| 要求 | 状态 | 证据 |
|------|------|------|
| 拖拽专用 token | ⚠️ 部分 | `shell-dragdrop.css` 定义 `--dnd-insert-line-width`, `--dnd-merge-bg` 等 |
| 零 fallback | ❌ 未达标 | `color-mix(in srgb, var(--accent-color, #1a73e8) ...)` 仍有硬编码 fallback |
| 冻结动画 token | ⚠️ 部分 | `tokens.css` L679-690 有 `--transition-*: 0ms !important` 但含 !important |
| `data-layout-frozen` 属性 | ✅ 已实现 | `layoutAnimationStore.ts:155` 设置 `data-layout-frozen` |

### 2.2 Layer 1: Global Freeze Service — 接近完成

| 组件 | 状态 | 文件/行 | 细节 |
|------|------|---------|------|
| `WindowResizeBridge` | ✅ 已实现 | `src/services/WindowResizeBridge.ts` | 单例、Tauri onResize/onMoved、Web fallback、watchdog 5s、rAF 双帧解冻 |
| `layoutAnimationStore` | ✅ 已实现 | `src/store/layoutAnimationStore.ts` | Set-based active、独立 type 隔离、MAX_FREEZE_MS 30s watchdog、catchup queue |
| `ResizeObserverManager` | ✅ 已实现 | `src/services/ResizeObserverManager.ts` | 单例、suspended 挂起、pending queue、flushBatch |
| `useResizeFreeze` 重构 | ✅ 已完成 | `src/hooks/useResizeFreeze.ts` | 从 MutationObserver 改为直接订阅 store |
| iframe 屏蔽 CSS | ✅ 已实现 | `shell-dragdrop.css:124-135,144-153` | `is-layout-frozen iframe { pointer-events: none !important }` |

**差距**：L1 是完成度最高的层，但 ResizeObserverManager 尚未被 12 个 `new ResizeObserver` 调用点使用（见 §4.3）。

### 2.3 Layer 2: Drag Infrastructure — 部分完成

| 组件 | 状态 | 文件 | 细节 |
|------|------|------|------|
| `DropIndicatorLayer` | ✅ 已实现 | `src/components/DropIndicatorLayer.tsx` | Portal 到 body、fixed、pointer-events none、支持 merge/split/col-preview |
| `DragOverlayContext` | ❌ 不存在 | — | 无 `src/contexts/` 目录，无 Provider |
| 统一碰撞检测 | ❌ 不存在 | — | 只有 `dropPreview` 静态位置，无 `collisionDetection.ts` |
| DOM splice 废弃 | ⚠️ 声明完成 | `Workspace.tsx:58` | 注释声明"不 splice"，但需验证 |
| 五区域碰撞检测 | ❌ 不存在 | — | DnD Kit 风格的 leftEdge/top/center/bottom/rightEdge 未实现 |

**差距**：缺少全局 DragOverlay Context；碰撞检测仅依赖 store 中的 `dropPreview` 静态位置而非实时算法；拖拽跟随元素（drag ghost）只在 `SidebarSessionList.tsx` 中有独立实现。

### 2.4 Layer 3: Layout Engine — 严重不足

| 组件 | 状态 | 细节 |
|------|------|------|
| `CrishSash` | ❌ 不存在 | 无 `src/core/sash/` 目录 |
| `CrishSplitView` | ❌ 不存在 | 无约束系统、无 resize 算法 |
| `CrishGrid` | ❌ 不存在 | 无树状嵌套、无 BranchNode/LeafNode |
| `CrishLayoutSerializer` | ⚠️ 部分 | 已有 flat 序列化 (`serializeWorkspaceLayout`/`deserializeWorkspaceLayout` + `workspaceLayoutStore.ts`) |
| `ICrishView` 约束接口 | ❌ 不存在 | `ColumnState`/`CardGroupState` 无 `minimumSize`/`maximumSize`/`priority`/`snap` |
| 布局持久化 | ✅ 已实现 | `workspaceLayoutStore.ts` 完整：按项目路径持久化、会话自定义标记、恢复逻辑 |

**差距**：这是最大的架构缺口。Crish 的布局模型仍是 **flat**（`Workspace` → `Column[]` → `Group[]` → `Card[]`），完全没有树状嵌套能力。没有约束系统意味着用户可以拖拽列到负宽度。

### 2.5 Layer 4: Virtual Scroll Manager — 部分完成

| 要求 | 状态 | 细节 |
|------|------|------|
| syncOrder 升 useLayoutEffect | ❌ 待确认 | `useVirtualScroll.ts:94` 仍使用 `useEffect` |
| generation 机制 | ❌ 待确认 | 需检查 `VirtualScrollManager.ts` |
| order 空状态防御 | ❌ 待确认 | 需检查 |
| debug 模式 | ❌ 待确认 | 需检查 |

（L4 不在本审计主要范围之内，详见 Cross-01。）

### 2.6 Layer 5: Component Layer — 存在问题

| 要求 | 状态 | 细节 |
|------|------|------|
| 纯展示 + hooks 注入 | ⚠️ 部分 | `SidebarSessionList.tsx` 内含 inline drag overlay 逻辑 |
| CSS Modules + 零 !important | ❌ 严重 | **613 个 !important** 声明（见 §4.1） |
| `useBubbleShrinkWidth` 优化 | ❌ 未完成 | `useTextMeasure.ts:75` 仍存在，每次创建独立 ResizeObserver |

---

## 3. VS Code 参考模式差距

### 3.1 Sash System 差距

| VS Code 模式 | Crish 状态 | 影响 |
|-------------|-----------|------|
| `SashState` (Disabled/AtMinimum/AtMaximum/Enabled) | ❌ 无 | 拖拽到边界无状态反馈 |
| `ISashEvent` (startX/currentX/altKey) | ❌ 无 | 事件结构非标准化 |
| `IPointerEventFactory` 抽象 | ❌ 无 | Mouse/Touch 事件混用 |
| `globalSize = 4px` (可配置) | ❌ 硬编码 | Resize handle 大小不可配置 |
| 正交联动 (linkedSash) | ❌ 无 | 2x2 角部同步拖拽不可能 |
| 双击 reset | ❌ 无 | 无 `onDidReset` |
| `createGlobalStyleSheet` | ⚠️ CSS 方案 | 使用 CSS class 而非动态 style sheet |

### 3.2 IView 约束系统差距

| VS Code IView | Crish ColumnState/CardGroupState |
|---------------|----------------------------------|
| `minimumSize: number` | ❌ 缺失 |
| `maximumSize: number` | ❌ 缺失 |
| `priority?: LayoutPriority` | ❌ 缺失 |
| `proportionalLayout?: boolean` | ❌ 缺失 |
| `snap?: boolean` | ❌ 缺失 |
| `onDidChange: Event<number>` | ❌ 缺失 |
| `layout(size, offset)` | ❌ 缺失 |

Crish 当前仅存储 `widthRatio`（列宽比例）和 `heightRatio`（组高比例），缺少像素级约束。

### 3.3 SerializableGrid 差距

| VS Code | Crish |
|---------|-------|
| `ISerializedBranchNode` (type: 'branch', data: ISerializedNode[]) | ❌ 只有 flat 列/组 |
| `ISerializedLeafNode` (type: 'leaf', data: unknown, size, visible) | ❌ 只有 CardState |
| `ISerializedGrid` (root, orientation, width, height) | ❌ 无 orientation |
| 递归 serialize/deserialize | ❌ flat 序列化 |
| `sanitizeGridNodeDescriptor` | ⚠️ 有 `normalizeLayoutSnapshot` 但不同 |

### 3.4 SplitView resize 算法差距

VS Code `resize()` 核心：
1. 按 priority 排序（High 优先调整）
2. 计算 minDelta/maxDelta 约束范围
3. 处理 snap（隐藏/显示）
4. 分配 delta 给两侧

Crish 当前 `resizeColumns` (`workspaceActions.ts`): 直接修改 `widthRatio`，**无约束校验**，**无 snap 处理**，**无 proportionalLayout**。

---

## 4. 架构反模式

### 4.1 CSS !important 泛滥（严重）

**计数**：**613 个 !important**（远超 ULTIMATE-REFACTOR-PLAN 报告的 300+）

**主要来源**：
- `shell-workspace.css`：大量 `!important` 用于 `.workspace-card .card-tab`、`.card-header`、`.card-body`
- `shell-dragdrop.css`：`transition: none !important`、`pointer-events: none !important`
- `tokens.css`：11 个 `--transition-*: 0ms !important`
- `theme-dark.css`：`border-color`、`background` 等覆盖

**根因**：全局 CSS（`.workspace-card .card-tab`）与 Module CSS（`:global(.card-tab)`）同名类名冲突，导致必须用 `!important` 覆盖。冲突对：
- `.card-header` — `shell-workspace.css` vs `CardPanel.module.css`
- `.card-tab` — `shell-workspace.css` vs `CardPanel.module.css`
- `.card-body` — `shell-workspace.css` vs `CardPanel.module.css`
- `.tabs-bar` — `shell-workspace.css` vs `CardPanel.module.css`
- `.placeholder-card` — `shell-workspace.css` vs `Workspace.module.css`
- `.drop-indicator` — `shell-dragdrop.css` vs `Workspace.module.css`

### 4.2 ResizeObserver 碎片化（中等）

**12 个直接 `new ResizeObserver` 调用点**（除了 `ResizeObserverManager` 自身）：

| 文件 | 用途 |
|------|------|
| `ChatMessageList.tsx:663` | container resize |
| `ChatMessageList.tsx:746` | scroll area resize |
| `ChatToolCallBlock.tsx:232` | tool block measure |
| `FilesCard.tsx:92` | file list measure |
| `VirtualList.tsx:54` | virtual scroll container |
| `SidebarSessionList.tsx:268` | session list |
| `useVirtualScroll.ts:94` | virtual scroll |
| `useVirtualDiffScroll.ts:12` | diff scroll |
| `useAutoGrowTextarea.ts:140` | textarea |
| `useSuspendedResizeObserver.ts:41` | general purpose |
| `useTextMeasure.ts:127` | bubble shrink width |
| `useResizeFreeze.ts:8` | (已重构，但仍有潜在隐藏) |

其中仅 `useSuspendedResizeObserver.ts` 和 `ResizeObserverManager.ts` 实现了挂起逻辑。另外 **10 个**在拖拽/resize 期间无条件执行测量。

### 4.3 useBubbleShrinkWidth 性能问题（中等）

`useTextMeasure.ts:75-141` — `useBubbleShrinkWidth`：
- 每次调用创建独立的 `new ResizeObserver`
- 在 React commit 阶段同步调用 `prepareWithSegments` + `measureLineStats`（强制同步重排）
- 300ms debounce 无法避免连续测量
- 被 `ChatMessageRow.tsx:307` 和 `:569` 各调用一次

这与 ULTIMATE-REFACTOR-PLAN R12 描述的 ~1573 次强制同步重排问题一致。

### 4.4 contain 覆盖不足（中等）

**17 处 `contain:`**（含 `shell-dragdrop.css` 的 8 处在冻结期间动态添加）：

| 位置 | contain 值 |
|------|-----------|
| `ChatMessageRow.module.css:446` | `layout style` |
| `ChatToolCallBlock.module.css:26` | `layout style` |
| `Sidebar.module.css:15` | `layout paint style` |
| `Workspace.module.css:96` | `layout style` |
| `SidebarSessionList.module.css:29` | `layout style` |
| `shell-dragdrop.css:164` | `strict` (global-drag-overlay) |
| `shell-dragdrop.css:191` | `strict` (drop-indicator-layer) |

目标应有 30+ 处。特别是 `chat-message-list`, `workspace-column`, `card-body` 等高频变化区域应该添加。

### 4.5 缺少 DragOverlayContext Provider

没有 `src/contexts/` 目录，拖拽相关逻辑分散在：
- `SidebarSessionList.tsx:1158-1221` — 独立的 inline drag overlay（克隆 DOM + positioned fixed）
- `Workspace.tsx` — 列宽拖拽
- `DropIndicatorLayer.tsx` — 仅接收 `dropPreview`，不管理拖拽会话

这导致拖拽状态无法跨组件共享，代码重复且难以维护。

### 4.6 缺少核心模块目录

`src/core/` 目录不存在。VS Code 式分层（Sash → SplitView → Grid）未启动。当前布局逻辑全部在 `store/workspaceActions.ts` 和 `store/layoutHelpers.ts` 中。

---

## 5. 已实现部分 — 不低估进展

以下部分已正确实现，无需重复建设：

### ✅ 冻结基础设施（Round 1 核心产出）
- `WindowResizeBridge` — 单例、Tauri + Web 双模式、watchdog 5s 防永久冻结
- `layoutAnimationStore` — `window-resizing` vs `workspace-resizing` 类型隔离、30s watchdog、catchup queue
- `useResizeFreeze` — 已从 MutationObserver 重构为直接订阅 store

### ✅ 拖拽指示器（Round 4 部分产出）
- `DropIndicatorLayer` — Portal 渲染、fixed 定位、支持 merge/split/col-preview 三种视觉
- `shell-dragdrop.css` — 完整的拖拽指示器 CSS（插入线、合并区、拆分高亮、列预览）

### ✅ iframe/event 保护（Round 1/3 部分产出）
- `shell-dragdrop.css:124-135` — 冻结期间 iframe/webview `pointer-events: none`
- `shell-dragdrop.css:144-153` — object/embed 补充屏蔽

### ✅ 布局持久化（Round 8 部分产出）
- `workspaceLayoutStore.ts` — 按项目路径持久化、会话自定义标记、项目切换自动保存/恢复
- `serializeWorkspaceLayout` / `deserializeWorkspaceLayout` — Flat 序列化
- `applyWorkspaceLayout` — 从快照重建

### ✅ ResizeObserver 管理（Round 6 部分产出）
- `ResizeObserverManager` — 单例、suspended 挂起、rAF 批处理刷新
- **但未被全部调用点使用**（见 §4.2）

### ✅ CSS 冻结优化（Round 5 部分产出）
- `shell-dragdrop.css:167-183` — 冻结期间给 `.workspace-canvas`, `.workspace-column`, `.workspace-card`, `.chat-message-list`, `.sidebar-content` 添加 `contain`

---

## 6. 剩余工作路线图

### Phase A — 补齐核心基础设施（P0，预估 3-5 天）

| 任务 | 说明 | 优先级 |
|------|------|--------|
| 统一 12 个 ResizeObserver 到 Manager | 逐个替换 `new ResizeObserver` 为 `ResizeObserverManager.observe()` | P0 |
| 消除 DOM splice 遗留 | 验证 Workspace.tsx 确实无 splice 逻辑，删除 placeholder 相关 CSS | P0 |
| useBubbleShrinkWidth 优化 | 改用 `ResizeObserverManager` + 节流测量频率 | P0 |

### Phase B — CrishSash + 约束系统（P0，预估 4-6 天）

| 任务 | 说明 |
|------|------|
| 创建 `src/core/sash/` 目录 | CrishSash 类 + event factory + 状态枚举 |
| 创建 `src/core/splitview/` 目录 | CrishSplitView + IView 约束接口 + resize 算法 |
| 向 ColumnState/CardGroupState 添加约束字段 | `minimumSize`, `maximumSize`, `priority`, `snap` |
| 替换现有 `resizeColumns` 实现 | 从直接修改 `widthRatio` 改为约束校验 resize 算法 |

### Phase C — CrishGrid 嵌套布局（P1，预估 5-7 天）

| 任务 | 说明 |
|------|------|
| 创建 `src/core/grid/` 目录 | BranchNode + LeafNode + GridLocation |
| 树状序列化 | 递归 serialize/deserialize 替代 flat 方案 |
| GridLocation 寻址 | 支持 `number[]` 路径定位视图 |

### Phase D — DragOverlay Context + 碰撞检测（P1，预估 3-5 天）

| 任务 | 说明 |
|------|------|
| 创建 `src/contexts/dragContext.tsx` | DragOverlayContext + Provider |
| 创建 `src/utils/collisionDetection.ts` | 五区域级联碰撞检测 |
| 统一 SidebarSessionList 拖拽 | 从 inline 实现迁移到 DragOverlayContext |
| 统一 CSS 光标覆盖 | 使用 `createGlobalStyleSheet` 替代 body class |

### Phase E — CSS 架构重组（P1，预估 3-4 天）

| 任务 | 说明 |
|------|------|
| !important 治理 | 从 613 降至 < 50：清理冲突对、改用 CSS 变量 |
| contain 补全 | 从 17 处增至 30+ 处 |
| fallback 清除 | 硬编码 `#1a73e8` fallback 全部替换为 CSS 变量 |

### Phase F — 工作区/多标签增强（P2，预估 3-5 天）

| 任务 | 说明 |
|------|------|
| linkedSash 2x2 联动 | 角部同步拖拽 |
| snap 支持 | 面板隐藏/显示 |
| proportionalLayout | 窗口缩放按比例恢复 |

---

## 7. 优先级

### P0（立即——影响核心功能）
1. **ResizeObserver 统一** — 12 个独立实例导致拖拽/resize 期间无条件测量（$4.2）← 已阻塞 Round 3 验证
2. **CSS !important 危机** — 613 个 !important 预示严重冲突（§4.1）← 长期维护性杀手
3. **DOM splice 验证清理** — 确保纯视觉浮层方案落地 ← 依赖 Round 4

### P1（短期——影响用户体验和代码质量）
4. **CrishSash + 约束系统** — minimumSize/maximumSize/priority/snap 缺失（§3.2）← 核心布局可靠性
5. **DragOverlayContext** — 消除拖拽逻辑碎片化（§4.5）← 拖拽统一前提
6. **碰撞检测** — 五区域实时碰撞（§2.3）← Tab 拖拽精度
7. **useBubbleShrinkWidth 重构** — 强制同步重排（§4.3）← 性能

### P2（中期——影响架构完整性）
8. **CrishGrid 树状嵌套** — BranchNode/LeafNode 体系（§2.4）← 嵌套布局
9. **GridLocation 寻址** — number[] 定位（§3.3）← 多视图精确定位
10. **contain 补全** — 17→30+ 处（§4.4）← 布局性能
11. **CSS fallback 清除** — 硬编码颜色替换（§2.1）← 主题化

---

## 8. 总结

**L1（冻结层）和布局持久化**已接近完成，说明 Round 1/8 的执行到位。

**最大缺口在 L3（Layout Engine）**：无树状嵌套、无约束系统、无 VS Code 式 Sash/SplitView/Grid 分层。当前架构本质上是 flat 的列-组-卡模型，无论从可扩展性（嵌套布局）还是可靠性（约束校验）都达不到"六层统一架构"目标。

**CSS 反模式严重**：613 个 !important 是所有层中最紧迫的技术债务。这个问题随新功能开发只会恶化。

**ResizeObserver 碎片化**是性能瓶颈：虽然单例 Manager 已创建，但未被使用。迁移 12 个调用点是 Round 6 的核心交付。

**依赖版本健康**：React 19.1.1 ✓、Tauri API 2.8.0 ✓、Zustand 5.0.14 ✓、TypeScript 5.9.2 ✓ — 无需升级。
