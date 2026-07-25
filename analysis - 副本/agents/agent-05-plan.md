# Agent-05: 同列内拖拽样式割裂问题 — 重构方案文档

> 计划日期：2026-07-22
> 目标版本：重构后统一样式架构，解决 7 大类样式问题

---

## 目录

1. [统一样式架构设计](#1-统一样式架构设计)
2. [Drop Indicator CSS 规范](#2-drop-indicator-css-规范)
3. [移除黑色/灰色古老样式](#3-移除黑色灰色古老样式)
4. [修复"双分块"问题](#4-修复双分块问题)
5. [CSS 变量加固](#5-css-变量加固)
6. [模块 CSS 与全局 CSS 的冲突解决方案](#6-模块-css-与全局-css-的冲突解决方案)
7. [CardPanel.tsx 修改](#7-cardpaneltsx-修改)
8. [动画性能](#8-动画性能)
9. [测试策略](#9-测试策略)
10. [迁移路线图](#10-迁移路线图)

---

## 1. 统一样式架构设计

### 1.1 设计原则

1. **单一职责**：每个拖拽交互状态（merge / top-split / bottom-split / left-split / right-split）的样式定义在唯一位置
2. **CSS 变量驱动**：所有颜色值通过 token 系统传递，禁止硬编码、禁止 fallback 依赖
3. **作用域收敛**：所有拖拽指示器样式统一在 `shell-dragdrop.css` 中定义，移除其他文件中的重复定义
4. **避免 `!important`**：除非绝对必要（覆盖第三方库），不使用 `!important`
5. **主题感知**：所有样式在亮色/暗色主题下都有对应的变量路径

### 1.2 文件职责重分配

| 文件 | 当前职责 | 重构后职责 |
|------|----------|-----------|
| `shell-dragdrop.css` | 基础指示器 + 预览卡片 | **所有**拖拽指示器、占位符、预览卡片、插入线 |
| `Workspace.module.css` | placeholderCardGroup + dropIndicator | 只保留布局相关样式（column/group splitter） |
| `shell-workspace.css` | placeholder-card-group + 伪元素 | 移除所有拖拽占位符样式 |
| `CardPanel.tsx` | dockOverlayStyle inline | 移除 inline style，改用 CSS class |
| `tokens.css` | 定义所有 CSS 变量 | 新增拖拽专用 token |

### 1.3 新增 CSS 变量

在 `tokens.css` 中新增拖拽专用变量：

```css
:root {
  /* Drag & Drop Indicator Tokens */
  --dnd-merge-bg: color-mix(in srgb, var(--accent-color) 8%, transparent);
  --dnd-merge-border: color-mix(in srgb, var(--accent-color) 30%, transparent);
  --dnd-merge-border-width: 1.5px;
  --dnd-merge-radius: var(--radius-md);
  --dnd-split-bg: color-mix(in srgb, var(--accent-color) 6%, transparent);
  --dnd-split-border: color-mix(in srgb, var(--accent-color) 35%, transparent);
  --dnd-split-border-style: solid;
  --dnd-split-radius: var(--radius-md);
  --dnd-insert-line-width: 3px;
  --dnd-insert-line-color: var(--accent-color);
  --dnd-overlay-shadow: 0 8px 24px color-mix(in srgb, var(--shadow-color) 15%, transparent);
  --dnd-overlay-border: 1.5px solid color-mix(in srgb, var(--accent-color) 35%, transparent);
  --dnd-blur: blur(4px);
}
```

```css
html[data-theme="dark"] {
  --dnd-merge-bg: color-mix(in srgb, var(--accent-color, #f8fafc) 10%, transparent);
  --dnd-merge-border: color-mix(in srgb, var(--accent-color, #f8fafc) 35%, transparent);
  --dnd-split-bg: color-mix(in srgb, var(--accent-color, #f8fafc) 8%, transparent);
  --dnd-split-border: color-mix(in srgb, var(--accent-color, #f8fafc) 40%, transparent);
  --dnd-overlay-shadow: 0 8px 24px color-mix(in srgb, var(--shadow-color) 35%, transparent);
}
```

---

## 2. Drop Indicator CSS 规范

### 2.1 统一使用 accent color 体系

所有指示器基于 `--accent-color` 派生，通过透明度区分状态：

| 状态 | 背景透明度 | 边框透明度 | 边框样式 |
|------|-----------|-----------|---------|
| merge (hover) | 8% | 30% | solid 1.5px |
| top/bottom split | 6% | 35% | solid 1.5px |
| left/right split | 5% | 30% | solid 1.5px |
| tab insert | 12% | 55% | solid 2px |

### 2.2 半透明背景 + 边框

新的指示器样式不使用虚线、不使用黑色：

```css
/* Merge Indicator — 同列内合并标签 */
.dnd-indicator-merge {
  background: var(--dnd-merge-bg);
  border: var(--dnd-merge-border-width) solid var(--dnd-merge-border);
  border-radius: var(--dnd-merge-radius);
  pointer-events: none;
  z-index: var(--z-drag-highlight);
  animation: dnd-merge-pulse 1.5s ease-in-out infinite;
}

/* Split Indicator — 上下拆分 */
.dnd-indicator-split {
  background: var(--dnd-split-bg);
  border: 1.5px solid var(--dnd-split-border);
  border-radius: var(--dnd-split-radius);
  pointer-events: none;
  z-index: var(--z-drag-highlight);
}
```

### 2.3 backdrop-filter 毛玻璃效果

当性能层级允许时（`data-perf-tier="high"`），启用毛玻璃：

```css
.dnd-indicator-merge,
.dnd-indicator-split {
  backdrop-filter: blur(0px); /* 默认关闭 */
  transition: backdrop-filter 0.15s ease;
}

/* High-spec 设备启用毛玻璃 */
html[data-perf-tier="high"] .dnd-indicator-merge,
html[data-perf-tier="high"] .dnd-indicator-split {
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
```

**注意 backdrop-root 问题**：如果父容器有 `opacity < 1`、`filter: none`、或 `isolation: isolate`，`backdrop-filter` 的作用域会被限制。需要在 Workspace 层面确保拖拽指示器容器不是 backdrop root。

### 2.4 平滑过渡动画

```css
.dnd-indicator-merge {
  animation: dnd-merge-pulse 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

.dnd-indicator-split {
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

@keyframes dnd-merge-pulse {
  0%, 100% {
    opacity: 0.75;
    background-color: color-mix(in srgb, var(--accent-color) 8%, transparent);
  }
  50% {
    opacity: 1;
    background-color: color-mix(in srgb, var(--accent-color) 16%, transparent);
  }
}
```

---

## 3. 移除黑色/灰色古老样式

### 3.1 删除暗色背景

需要**删除**的源码段：

1. **shell-workspace.css:1232-1249** — `.placeholder-card-group` 的 `background: color-mix(in srgb, var(--border-color) 10%, var(--bg-secondary, #f9f9fb))` — 使用 `--bg-secondary` 混合灰色背景
2. **shell-workspace.css:1267** — `::before` 的 `background: var(--bg-primary, #ffffff)` — 纯白背景
3. **shell-workspace.css:1282** — `::after` 的 `background: var(--bg-primary, #ffffff)` — 纯白背景
4. **CardPanel.tsx:263-301** — `dockOverlayStyle` 中的全部 inline style

替换后的统一方案：使用 `--dnd-split-bg` / `--dnd-merge-bg` 变量，这些变量在亮色/暗色主题下都有正确值。

### 3.2 删除虚线边框

需要**删除**的虚线边框：

1. `CardPanel.tsx:265` — `'1px dashed color-mix(...)'` — dockOverlayStyle 的虚线边框
2. `Workspace.module.css:239` — `.placeholderCardGroup` 的 `border: 1.5px dashed color-mix(...)`
3. `Workspace.module.css:221` — `.placeholderCol` 的 `border: 1.5px dashed color-mix(...)`
4. `shell-workspace.css:1308` — `.tab-placeholder-indicator` 的 `border: 1.2px dashed color-mix(...)`

替换为**实线**（solid）样式，所有虚线变实线。

### 3.3 新的 DropIndicator 样式定义

统一在 `shell-dragdrop.css` 中定义所有指示器样式：

```css
/* ============================================
   Drop Indicator System — Unified Styles
   All drag indicators use accent-color via
   CSS variables. No hardcoded colors.
   ============================================ */

/* --- Merge Indicator (within same column) --- */
.dnd-indicator-merge {
  position: absolute;
  top: 6px;
  left: 10px;
  right: 10px;
  height: 32px;
  background: var(--dnd-merge-bg);
  border: var(--dnd-merge-border-width) solid var(--dnd-merge-border);
  border-radius: var(--dnd-merge-radius);
  pointer-events: none;
  z-index: var(--z-drag-highlight);
  animation: dnd-merge-pulse 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

/* --- Split Indicator (top/bottom within column) --- */
.dnd-indicator-split-top,
.dnd-indicator-split-bottom {
  position: absolute;
  left: 10px;
  right: 10px;
  background: var(--dnd-split-bg);
  border: 1.5px solid var(--dnd-split-border);
  border-radius: var(--dnd-split-radius);
  pointer-events: none;
  z-index: var(--z-drag-highlight);
  transition: opacity var(--transition-fast);
}

.dnd-indicator-split-top {
  top: 48px;
  height: calc((100% - 58px) / 2);
}

.dnd-indicator-split-bottom {
  top: calc(48px + (100% - 58px) / 2);
  bottom: 10px;
}

/* --- Column Placeholder (left/right split) --- */
.dnd-placeholder-col {
  display: flex;
  flex-direction: column;
  height: 100%;
  justify-content: center;
  align-items: center;
  padding: var(--space-4);
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
  text-align: center;
  background: var(--dnd-split-bg);
  border: 1.5px solid var(--dnd-split-border);
  border-radius: var(--radius-lg);
  margin: var(--space-3);
  flex: 1;
}

/* --- Group Placeholder (top/bottom split in column) --- */
.dnd-placeholder-group {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1.5px solid var(--dnd-split-border);
  background: var(--dnd-merge-bg);
  backdrop-filter: var(--dnd-blur, blur(0px));
  justify-content: center;
  align-items: center;
  font-size: var(--font-size-xs);
  line-height: var(--line-height-tight);
  color: var(--text-secondary);
  margin: var(--space-1);
  border-radius: var(--radius-sm);
  box-sizing: border-box;
  gap: var(--space-1);
  padding: var(--space-2);
}

.dnd-placeholder-group svg {
  opacity: 0.8;
  color: var(--accent-color);
}

/* --- Tab Insert Line --- */
.dnd-insert-line {
  position: fixed;
  width: var(--dnd-insert-line-width, 3px) !important;
  border-radius: 999px;
  background: var(--dnd-insert-line-color, var(--accent-color)) !important;
  pointer-events: none;
  z-index: var(--z-drag-overlay);
  box-shadow: 0 0 10px color-mix(in srgb, var(--accent-color) 70%, transparent);
}

/* --- Tab Placeholder (inline in tabs-bar) --- */
.dnd-tab-placeholder {
  background: var(--dnd-merge-bg) !important;
  border: 1.5px solid var(--dnd-merge-border) !important;
  border-radius: var(--ws-row2-tab-radius, 6px) !important;
  min-width: 96px !important;
  height: var(--ws-row2-tab-h, 32px) !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  padding: 0 12px !important;
  margin: 0 !important;
  pointer-events: none !important;
  position: relative !important;
  opacity: 0.8 !important;
  z-index: var(--z-decorative) !important;
  box-sizing: border-box !important;
  font-size: var(--ws-row2-tab-font, 12px) !important;
  color: var(--accent-color) !important;
  animation: dnd-tab-pulse 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

/* --- Drag Overlay Preview Card --- */
.dnd-overlay-card {
  position: fixed;
  pointer-events: none;
  z-index: var(--z-drag-overlay);
  overflow: hidden;
  box-shadow: var(--dnd-overlay-shadow);
  border: var(--dnd-overlay-border);
  background: var(--bg-card, var(--bg-primary));
  opacity: 0.92;
  transition: opacity 0.12s ease-out;
  will-change: transform;
}

.dnd-overlay-card * {
  pointer-events: none !important;
}

/* --- Animations --- */
@keyframes dnd-merge-pulse {
  0%, 100% {
    opacity: 0.75;
    background-color: color-mix(in srgb, var(--accent-color) 8%, transparent);
  }
  50% {
    opacity: 1;
    background-color: color-mix(in srgb, var(--accent-color) 16%, transparent);
  }
}

@keyframes dnd-tab-pulse {
  0%, 100% {
    opacity: 0.6;
    background: var(--dnd-merge-bg);
  }
  50% {
    opacity: 0.95;
    background: color-mix(in srgb, var(--accent-color) 18%, transparent);
  }
}
```

---

## 4. 修复"双分块"问题

### 4.1 移除 ::before / ::after 伪元素方案

**方案**：完全删除 `.placeholder-card-group::before` 和 `.placeholder-card-group::after` 伪元素。

**理由**：
- 伪元素模拟的 Header/Body 骨架屏与实际的拖拽拆分语义不符
- 占位组应该表达"释放位置在此"的信息，而非"这里有一个空白面板"
- 伪元素在大容器下产生视觉上不美观的"双分块"

### 4.2 替代设计：轻量占位组

新的占位组不使用伪元素，而是使用简洁的居中图标 + 文案：

```css
.dnd-placeholder-group {
  /* 背景使用半透明 accent color */
  background: var(--dnd-split-bg);
  /* 实线边框，无虚线 */
  border: 1.5px solid var(--dnd-split-border);
  /* 柔化圆角 */
  border-radius: var(--radius-sm);
  /* 居中内容 */
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: var(--space-2);
  /* 轻量 padding，无 52px 预留 */
  padding: var(--space-3);
  /* 无多余伪元素 */
}
```

### 4.3 或根据容器大小条件渲染

如果需要保留骨架屏效果以提供更丰富的视觉反馈，可以在 Workspace.tsx 中通过 JS 条件渲染：

```tsx
// Workspace.tsx 中渲染占位组时，根据方向选择不同的样式
{isPlaceholderGroup && (
  <div className="dnd-placeholder-group">
    <Plus size={16} strokeWidth={1.75} aria-hidden />
    <span>{group.cards[0].title}</span>
  </div>
)}
```

JS 条件渲染的优势：
- 可以动态改变文案（方向不同文案不同）
- 可以添加动画效果（图标旋转、微动效）
- 可以根据容器宽度决定是否展示完整内容
- 完全避开了 CSS 伪元素的固有限制

---

## 5. CSS 变量加固

### 5.1 确保所有主题下 fallback 正常工作

**问题来源**：`var(--accent-color, #1a73e8)` 的 fallback `#1a73e8` 在暗色主题下产生蓝色效果。

**解决方案**：

1. **移除所有 fallback**：在拖拽相关样式中，不再依赖 fallback 值。改为在 `:root` / `html[data-theme="dark"]` 中**强制定义**所有拖拽相关变量

2. **定义无 fallback 变量链**：

```css
/* tokens.css */
:root {
  /* 基础变量 */
  --accent-color: hsl(35, 16%, 15%);

  /* 拖拽派生变量 — 不使用 fallback */
  --dnd-merge-bg: color-mix(in srgb, var(--accent-color) 8%, transparent);
  --dnd-merge-border: color-mix(in srgb, var(--accent-color) 30%, transparent);
  --dnd-split-bg: color-mix(in srgb, var(--accent-color) 6%, transparent);
  --dnd-split-border: color-mix(in srgb, var(--accent-color) 35%, transparent);
}

html[data-theme="dark"] {
  --accent-color: #f8fafc;
  /* 派生变量自动跟随，因为 color-mix 在定义时计算 */
}
```

> **注意**：CSS `color-mix()` 在自定义属性中的计算是惰性的 — 它在变量被使用时才求值，因此 `--dnd-merge-bg` 会自动跟随 `--accent-color` 在当前级联上的值。

3. **JS 层面的变量注入**：如果 `data-theme` 属性切换时某些组件无法感知变量变更，需要在 ThemeProvider 层确保：
   - 使用 React context 传递主题
   - 在 `useLayoutEffect` 中强制重绘受影响组件
   - 避免在 portal 中使用 inline style 引用 CSS 变量

### 5.2 暗色主题测试

**测试清单**：

| 测试项 | 预期结果 | 验证方法 |
|--------|----------|----------|
| 亮色 merge 指示器 | 暖炭色 8% 背景 + 30% 边框 | 截图对比 |
| 暗色 merge 指示器 | 白色 10% 背景 + 35% 边框 | 截图对比 |
| 亮色 split 占位组 | 暖炭色 6% 背景 + 35% 边框 | 截图对比 |
| 暗色 split 占位组 | 白色 8% 背景 + 40% 边框 | 截图对比 |
| 亮色插入线 | accent-color 3px | DOM 检查 |
| 暗色插入线 | accent-color 3px | DOM 检查 |
| data-perf-tier="eco" | 无 backdrop-filter、无动画 | 性能检查 |
| data-perf-tier="balanced" | 无 blur，但有颜色指示 | 性能检查 |

---

## 6. 模块 CSS 与全局 CSS 的冲突解决方案

### 6.1 统一使用一种作用域策略

**推荐方案**：全局 CSS + 沙箱命名空间

**理由**：
- 拖拽指示器是全局性 UI 状态（浮层、fixed 定位、portal 渲染）
- CSS Modules 作用域限制在组件树内，无法有效管理 portal 样式
- 全局 CSS 配合 BEM 命名空间同样可维护

**命名规范**：
- 所有拖拽样式前缀统一为 `dnd-`
- 公共类：`.dnd-indicator-merge`、`.dnd-indicator-split-top`、`.dnd-placeholder-group`
- 私有组件变量透传：通过 `data-*` 属性而非 class

### 6.2 从 Workspace.module.css 中移除的样式

从 `Workspace.module.css` 中删除以下 class 定义：

- `.placeholderCol`（行 210-226） — 迁移到 `.dnd-placeholder-col`
- `.placeholderCardGroup`（行 234-252） — 迁移到 `.dnd-placeholder-group`
- `.placeholderCardGroup svg`（行 254-257） — 迁移到 `.dnd-placeholder-group svg`
- `.dropIndicator`（行 259-268） — 迁移到合并的 drop-indicator

保留的样式：`.colSplitter`、`.groupSplitter` 等列/组拖动条样式（这些是布局功能，非拖拽指示器）。

### 6.3 从 shell-workspace.css 中移除的样式

从 `shell-workspace.css` 中删除以下部分：

- `.workspace-column--placeholder`（行 1216-1229） — 迁移到 `.dnd-placeholder-col`
- `.workspace-card.placeholder-card-group, .placeholder-card-group`（行 1232-1249） — 迁移到 `.dnd-placeholder-group`
- `.placeholder-card-group::before`（行 1260-1273） — **删除**，不再使用伪元素
- `.placeholder-card-group::after`（行 1275-1288） — **删除**，不再使用伪元素
- `.placeholder-card-group > svg, .placeholder-card-group > span`（行 1291-1301） — 迁移到 `.dnd-placeholder-group`
- `.placeholder-card-group svg`（行 1298-1301） — 迁移到 `.dnd-placeholder-group svg`
- `.tabs-bar .tab-placeholder-indicator, .tab-placeholder-indicator`（行 1305-1329） — 迁移到 `.dnd-tab-placeholder`
- `@keyframes tab-indicator-pulse`（行 1332-1345） — 迁移到 `@keyframes dnd-tab-pulse`
- `@keyframes pulse-merge-highlight`（行 1349-1358） — 迁移到 `@keyframes dnd-merge-pulse`

### 6.4 保留在 shell-dragdrop.css 中的样式

保留并扩展 `shell-dragdrop.css`：

- `.drop-indicator`（行 62-75） — 重构为 `.dnd-indicator-*`
- `.tab-insert-line, .tab-placeholder-indicator`（行 78-87） — 重构为 `.dnd-insert-line`
- `.drag-overlay-preview-card`（行 90-100） — 重构为 `.dnd-overlay-card`

移除的（迁移到 tokens 变量）：
- `.drag-ghost-hidden`（行 128-131） — 已由 `opacity: 0` 处理

### 6.5 优先级管理

**新优先级策略**：

| 层级 | 范例 | 优先级权重 |
|------|------|-----------|
| Token 变量 | `--dnd-merge-bg` | 全局可用 |
| 全局 class | `.dnd-indicator-merge` | (0,1,0) |
| 复合 class | `.workspace-card .dnd-indicator-merge` | (0,2,0) |
| 暗色覆盖 | `html[data-theme="dark"] .dnd-indicator-merge` | (0,2,0) |

**规则**：
1. 不使用 `!important`（除非覆盖第三方库样式）
2. 全局 class 直接作用于元素，不经过 CSS Modules hash 变换
3. 暗色覆盖使用 `html[data-theme="dark"]` 前缀提升优先级
4. 所有定义在单一文件中，按"基础 → 状态 → 主题"顺序排列

---

## 7. CardPanel.tsx 修改

### 7.1 移除独立 dockOverlayStyle

**当前**：CardPanel.tsx:252-305 定义了完整的 `dockOverlayStyle` 计算逻辑，包含 3 个方向的 inline style。

**修改后**：移除整个 `dockOverlayStyle` 相关代码，包括：
- `showDockOverlay` 条件变量
- `dockOverlayStyle` useMemo
- 渲染 `<div>` 的代码段（行 1002-1004）

### 7.2 统一由 Workspace 渲染浮层

**新方案**：
1. Workspace.tsx 中已经有一个 `drop-indicator` 容器（行 843-848）
2. 将此容器扩展为统一渲染拖拽指示器的宿主
3. Workspace 根据 `dropPreview` 的 `direction` 和坐标，在合适位置渲染指示器

**具体实现**：

```tsx
// Workspace.tsx 中已有 dropIndicator，扩展其样式处理
<div
  className={
    dropPreview && draggedTab?.isTabDrag
      ? `dnd-indicator-${dropPreview.direction}`
      : 'dnd-hidden'
  }
  id={`dnd-indicator-${ws.id}`}
  aria-hidden="true"
/>
```

但这里有一个问题：`position: fixed` 的指示器如何知道位置？需要 Workspace 根据 `dropPreview` 中的 `colIdx`、`groupIdx` 计算目标元素的 DOM 位置。

**更优的实现方式**：使用 `useLayoutEffect` + `getBoundingClientRect` 计算指示器位置：

```tsx
// Workspace.tsx
const indicatorRef = useRef<HTMLDivElement>(null);

useLayoutEffect(() => {
  if (!dropPreview || !draggedTab?.isTabDrag) {
    if (indicatorRef.current) indicatorRef.current.style.display = 'none';
    return;
  }

  const { colIdx, groupIdx, direction } = dropPreview;
  const targetCard = document.querySelector(
    `.workspace-card[data-col-idx="${colIdx}"][data-group-idx="${groupIdx}"]`
  ) as HTMLElement | null;
  if (!targetCard || !indicatorRef.current) return;

  const rect = targetCard.getBoundingClientRect();

  // 根据 direction 设置指示器的位置和尺寸
  switch (direction) {
    case 'merge':
      Object.assign(indicatorRef.current.style, {
        display: 'block',
        position: 'fixed',
        top: `${rect.top + 6}px`,
        left: `${rect.left + 10}px`,
        width: `${rect.width - 20}px`,
        height: '32px',
      });
      break;
    case 'top':
      // 上半部分
      Object.assign(indicatorRef.current.style, {
        display: 'block',
        position: 'fixed',
        top: `${rect.top + 48}px`,
        left: `${rect.left + 10}px`,
        width: `${rect.width - 20}px`,
        height: `${(rect.height - 58) / 2}px`,
      });
      break;
    case 'bottom':
      // 下半部分
      Object.assign(indicatorRef.current.style, {
        display: 'block',
        position: 'fixed',
        top: `${rect.top + 48 + (rect.height - 58) / 2}px`,
        left: `${rect.left + 10}px`,
        width: `${rect.width - 20}px`,
        height: `${(rect.height - 58) / 2}px`,
      });
      break;
    default:
      indicatorRef.current.style.display = 'none';
  }
}, [dropPreview, draggedTab]);
```

### 7.3 简化 CardPanel 中的判断逻辑

移除 dockOverlayStyle 后，CardPanel.tsx 中的相关代码大幅简化：

```tsx
// 移除以下变量
const showDockOverlay = !!(
  isTargetPanel &&
  draggedTab &&
  draggedTab.isTabDrag
);

// 移除 dockOverlayStyle useMemo
const dockOverlayStyle = React.useMemo<React.CSSProperties | null>(() => {
  // ... 全部移除
}, [showDockOverlay, dropPreview]);

// 移除渲染
{/* 移除 */}
{dockOverlayStyle && (
  <div style={dockOverlayStyle} aria-hidden="true" />
)}
```

---

## 8. 动画性能

### 8.1 GPU 加速

**当前问题**：
- 预览卡片使用 `left/top` 定位 — 每次 move 触发 layout → paint → composite
- 叠加层使用 `animation` 属性改变 `background-color` — 触发 paint

**优化方案**：

1. **预览卡片改为 transform 定位**：

```tsx
// useTabDrag.ts
// 改为使用 transform 移动
dragOverlay.style.transform = `translate(${moveEvent.clientX - clickOffsetX}px, ${moveEvent.clientY - clickOffsetY}px)`;
// 移除 left/top 设置
// dragOverlay.style.left = `${...}px`;
// dragOverlay.style.top = `${...}px`;

// 初始化时设置初始位置
dragOverlay.style.transform = `translate(${startX - clickOffsetX}px, ${startY - clickOffsetY}px)`;
dragOverlay.style.willChange = 'transform';
```

2. **指示器动画改为 opacity 动画**（只触发 composite）：

```css
.dnd-indicator-merge {
  /* 动画仅改变 opacity，不触发 layout/paint */
  animation: dnd-merge-pulse 1.5s ease-in-out infinite;
}

@keyframes dnd-merge-pulse {
  0%, 100% {
    opacity: 0.75;
  }
  50% {
    opacity: 1;
  }
}
/* background-color 保持静态，由 transition 处理而非 animation */
```

3. **归位动画使用 CSS transition**：

```tsx
// animateOverlayAway
const animateOverlayAway = (overlay: HTMLDivElement) => {
  overlay.style.transition = 'transform 0.28s cubic-bezier(0.19, 1, 0.22, 1), opacity 0.28s ease';
  overlay.style.transform = `translate(${destRect.left}px, ${destRect.top}px) scale(0.5)`;
  overlay.style.opacity = '0';
  setTimeout(() => overlay.remove(), 280);
};
```

### 8.2 transition 控制

| 属性 | 控制方式 | 触发时机 |
|------|----------|----------|
| 指示器显示 | `transition: opacity 150ms ease` | appear/disappear |
| 指示器 pulsing | `animation` 作用于仅 opacity | 拖拽整个期间 |
| 预览卡片跟随 | 无 transition（需即时响应） | pointermove |
| 预览卡片归位 | `transition: transform 0.28s spring` | pointerup |
| 占位组出现 | `transition: opacity 150ms ease, transform 150ms ease` | dropPreview 改变 |

### 8.3 性能层级适配

| 性能层级 | backdrop-filter | 动画 | blur |
|----------|----------------|------|------|
| high | blur(4px) | 完整 | 完整 |
| balanced | blur(0px) | 完整 | 完整 |
| eco | blur(0px) | 无 animation | 无 |

---

## 9. 测试策略

### 9.1 视觉回归测试

使用 Playwright 或 Storybook 进行截图对比：

| 测试场景 | 亮色主题预期 | 暗色主题预期 |
|----------|-------------|-------------|
| 拖拽 tab 到同组 | merge 指示器显示 | merge 指示器显示 |
| 拖拽 tab 到同列另一组上方 | top split 占位组 | top split 占位组 |
| 拖拽 tab 到同列另一组下方 | bottom split 占位组 | bottom split 占位组 |
| 拖拽 tab 到列边缘 | column placeholder | column placeholder |
| 松手前最后一帧 | 正确的方向指示器 | 正确的方向指示器 |

### 9.2 CSS 变量可用性测试

```typescript
// 测试 CSS 变量是否在每个主题下都有值
describe('CSS变量测试', () => {
  it('亮色主题下 --accent-color 应有正确值', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent-color').trim();
    expect(value).not.toBe('');
    expect(value).toBe('hsl(35, 16%, 15%)');
  });

  it('暗色主题下 --accent-color 应有正确值', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent-color').trim();
    expect(value).not.toBe('');
    expect(value).toBe('#f8fafc');
  });

  it('拖拽变量在所有主题下都不回退到 fallback', () => {
    for (const theme of ['light', 'dark']) {
      document.documentElement.setAttribute('data-theme', theme);
      const mergeBg = getComputedStyle(document.documentElement)
        .getPropertyValue('--dnd-merge-bg').trim();
      expect(mergeBg).not.toBe('');
      expect(mergeBg).not.toContain('#1a73e8'); // 不应包含 fallback
    }
  });
});
```

### 9.3 交互行为测试

```typescript
// 测试拖拽样式节点是否正确渲染
describe('拖拽指示器渲染', () => {
  it('merge 方向应渲染 dnd-indicator-merge class', () => {
    const { container } = render(<Workspace wsId="test" onShowToast={jest.fn()} />);
    // 模拟拖拽状态
    act(() => {
      useLayoutStore.getState().setDraggedTab({ ... });
      useLayoutStore.getState().setDropPreview({
        colIdx: 0, groupIdx: 0, direction: 'merge'
      });
    });
    expect(container.querySelector('.dnd-indicator-merge')).toBeTruthy();
  });

  it('top 方向应渲染 dnd-indicator-split-top class', () => {
    // ...
    expect(container.querySelector('.dnd-indicator-split-top')).toBeTruthy();
  });
});
```

### 9.4 浏览器兼容性测试

| 特性 | Chrome | Firefox | Safari | Edge |
|------|--------|---------|--------|------|
| `backdrop-filter` | 支持 | 支持 | 支持（需 -webkit-） | 支持 |
| `color-mix` | 111+ | 113+ | 16.2+ | 111+ |
| CSS custom properties | 49+ | 31+ | 9.1+ | 15+ |
| `:where()` | 88+ | 78+ | 14+ | 88+ |

**注意**：`color-mix` 在 2024 年 Baseline 可用，但需要确认用户的 Electron 版本是否支持。

---

## 10. 迁移路线图

### 阶段 1：CSS 抽象（预估 2 天）

1. 在 `tokens.css` 中定义 `--dnd-*` 变量体系
2. 在 `shell-dragdrop.css` 中编写新的 `.dnd-*` class 体系
3. 在 `theme-dark.css` 中添加暗色主题的 `--dnd-*` 覆盖
4. 确认 `--dnd-*` 变量在不同性能层级下的行为

### 阶段 2：代码重构（预估 1.5 天）

1. 修改 `Workspace.tsx` — 替换 CSS Modules class 引用为全局 `.dnd-*` class
2. 修改 `CardPanel.tsx` — 移除 `dockOverlayStyle` 及相关 inline style
3. 修改 `useTabDrag.ts` — 统一通过 Workspace 状态渲染指示器
4. 修改指示器位置计算逻辑为 `getBoundingClientRect` 方式

### 阶段 3：清理（预估 0.5 天）

1. 从 `Workspace.module.css` 中删除被迁移的 class
2. 从 `shell-workspace.css` 中删除被迁移的 placeholder 和伪元素样式
3. 清理 CardPanel.tsx 中不再需要的 import 和变量
4. 全局搜索 `pulse-merge-highlight`、`tab-indicator-pulse` 等旧 keyframe 引用

### 阶段 4：验证（预估 1 天）

1. 亮色/暗色主题下的所有拖拽场景验证
2. 列拆分（left/right）验证
3. 上下拆分（top/bottom）验证
4. 同列合并（merge）验证
5. 标签插入线（tab insert）验证
6. 不同性能层级（high/balanced/eco）验证
7. 窗口尺寸变化时的响应式验证

### 阶段 5：性能优化（可选，预估 0.5 天）

1. 将预览卡片从 `left/top` 改为 `transform` 定位
2. 将指示器动画改为仅 `opacity` 驱动
3. 添加 `will-change` 提示
4. 性能 Profiling 对比

---

## 附录 A：文件变更清单

| 文件 | 操作 |
|------|------|
| `src/styles/tokens.css` | 新增 `--dnd-*` 变量定义 |
| `src/styles/shell/shell-dragdrop.css` | 重写为完整 DnD 指示器系统 |
| `src/styles/shell/shell-workspace.css` | 删除 placeholder 相关样式（~120 行） |
| `src/styles/theme-dark.css` | 新增 `--dnd-*` 暗色覆盖 |
| `src/components/Workspace.module.css` | 删除 `.placeholderCol` `.placeholderCardGroup` `.dropIndicator` |
| `src/components/Workspace.tsx` | 修改占位组渲染、指示器逻辑 |
| `src/components/CardPanel.tsx` | 删除 `dockOverlayStyle` 及相关 inline style |
| `src/hooks/useTabDrag.ts` | 简化预览卡片样式（迁移到 CSS class） |

## 附录 B：风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| `backdrop-filter` 在低性能设备卡顿 | 毛玻璃效果导致丢帧 | 使用 `data-perf-tier` 控制系统做功能降级 |
| CSS 变量在旧浏览器中不支持 `color-mix` | --dnd-* 变量失效 | 使用 PostCSS 插件预先编译 `color-mix` 表达式 |
| `position: fixed` 在嵌套 transform 容器中偏移 | 指示器位置错误 | 确认 Workspace 中无 transform 祖先；改用 `getBoundingClientRect` 计算坐标 |
| React portal 撑破 CSS 变量级联 | 主题变量无法穿透 | 将 portal 元素渲染到 `document.body` 时同步 `data-theme` 属性 |

## 附录 C：设计参考

- DnD Kit: https://docs.dndkit.com/
- MDN backdrop-filter: https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter
- MDN color-mix: https://developer.mozilla.org/en-US/docs/Web/CSS/color-mix
- VS Code 拖拽指示器设计
- Material Design 3 拖拽指示器规范

---

*本文档为 Agent-05 重构方案，基于 agent-05-analysis.md 中识别的 7 大类问题逐项提出解决方案。*
