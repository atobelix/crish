# Agent-05: 同列内拖拽样式割裂问题 — 深度分析文档

> 分析日期：2026-07-22
> 分析范围：CardPanel.tsx · shell-workspace.css · Workspace.module.css · shell-dragdrop.css · tokens.css · useTabDrag.ts

---

## 目录

1. [同列内拖拽样式分析](#1-同列内拖拽样式分析)
2. [shell-workspace.css 占位符样式](#2-shell-workspacecss-占位符样式)
3. [CSS 变量 fallback 分析](#3-css-变量-fallback-分析)
4. [模块 CSS 与全局 CSS 的冲突](#4-模块-css-与全局-css-的冲突)
5. [拖拽预览卡片的样式](#5-拖拽预览卡片的样式)
6. [参考设计对比](#6-参考设计对比)
7. [所有样式问题的根因总结](#7-所有样式问题的根因总结)

---

## 1. 同列内拖拽样式分析

### 1.1 CardPanel.tsx 的 dockOverlayStyle 计算

`dockOverlayStyle` 是 CardPanel.tsx 内部通过 `React.useMemo` 计算的一个 `React.CSSProperties` 对象，用于在同列内拖拽标签时渲染一个绝对定位的叠加层。该叠加层在 `showDockOverlay` 条件为真时渲染（见 CardPanel.tsx:252-305）。

**触发条件**（CardPanel.tsx:247-251）：
```tsx
const showDockOverlay = !!(
  isTargetPanel &&
  draggedTab &&
  draggedTab.isTabDrag
);
```
- `isTargetPanel`：当前 panel 的 `(colIdx, groupIdx)` 与 `dropPreview` 中的一致
- `draggedTab`：store 中存在拖拽状态
- `draggedTab.isTabDrag`：必须是标签拖拽（而非整组拖拽）

**方向类型**（CardPanel.tsx:255-303）：
- `direction === 'merge'`：合并到标签组 — 顶部 32px 指示条
- `direction === 'top'`：拆分到上方 — 上半部分 48px 起始，高度 `calc((100% - 58px) / 2)`
- `direction === 'bottom'`：拆分到下方 — 下半部分，从 `calc(48px + (100% - 58px) / 2)` 到距底 10px

### 1.2 黑色背景和黑色虚线边框的来源

`dockOverlayStyle` 使用了 `color-mix` 函数来生成透明颜色，但这里存在严重的一致性问题和暗色主题兼容性问题：

**亮色主题下的表现**（CardPanel.tsx:263-266）：
```tsx
backgroundColor:
  'color-mix(in srgb, var(--accent-color, #1a73e8) 6%, transparent)',
border:
  '1px dashed color-mix(in srgb, var(--accent-color, #1a73e8) 45%, transparent)',
```

亮色主题下 `--accent-color` 为 `hsl(35, 16%, 15%)`（深暖炭色），因此叠加层背景为 6% 透明度的深炭色，边框为 45% 透明度的深炭色虚线。

**暗色主题下的表现**：
暗色主题下 `--accent-color` 为 `#f8fafc`（近白色），理论上叠加层应该呈现极淡的白。但是问题在于：

1. 当 `data-theme` 属性加载顺序或作用域导致 fallback 生效时，`--accent-color` 无法正确获取，回退到 `#1a73e8`（蓝色）
2. 在暗色背景上叠加 6% 透明度的 `#1a73e8` 蓝色几乎不可见
3. border 使用 `1px dashed`，在暗色背景上虚线视觉效果极差，常呈现为断续的黑/灰斑点

**Root cause**：`dockOverlayStyle` 是 CardPanel.tsx 内部独立计算的 inline style，不经过 CSS 变量系统的作用域保护层。当 React 组件渲染时机早于 CSS 变量注入，或者 CSS 变量的级联被 Shadow DOM / portal 打断时，fallback 值 `#1a73e8` 被使用。

### 1.3 绝对定位叠加层的 CSS 属性

`dockOverlayStyle` 生成的 `<div>` 具有以下共同属性：

```css
position: absolute;
top: 48px;          /* merge 时为 6px; top 拆分时为 48px; bottom 拆分为 calc(...) */
left: 10px;
right: 10px;
border-radius: 6px;
pointer-events: none;
z-index: var(--z-drag-highlight);
animation: pulse-merge-highlight 1.5s infinite ease-in-out;
```

**定位逻辑分析**：
- `position: absolute` — 相对于最近的 `position: relative` 祖先（即 `.workspace-card`）
- `top` 值根据方向不同：
  - merge：`6px`（紧贴 card-header 下方）
  - top：`48px`（card-header + padding 下方，占据上半）
  - bottom：`calc(48px + (100% - 58px) / 2)`（card-header + 上半之后，占据下半）
- `height` 仅 merge 和 top 方向设置固定值；bottom 方向依赖 `top + bottom`
- `border-radius: 6px` — 硬编码，不与 CSS 变量 `--radius-md` 同步

**动画`pulse-merge-highlight`**（shell-workspace.css:1349-1358）：
```css
@keyframes pulse-merge-highlight {
  0%, 100% {
    opacity: 0.7;
    background-color: color-mix(in srgb, var(--accent-color, #1a73e8) 10%, transparent);
  }
  50% {
    opacity: 1.0;
    background-color: color-mix(in srgb, var(--accent-color, #1a73e8) 20%, transparent);
  }
}
```

此动画在 CSS 中定义但被 `dockOverlayStyle` 的 inline style 引用。这意味着动画中的 `color-mix` 使用了与 inline style 不同的 `10%` / `20%` 比例，导致动画过程中背景色突变。动画运行时在 6% 和 10~20% 之间跳变，视觉效果不连续。

### 1.4 指针事件处理

`pointerEvents: 'none'` 确保叠加层不会拦截鼠标事件，这是一个好的做法。但是：

**问题**：`dockOverlayStyle` 渲染的 `<div>` 位于 `card-body` 同级，且 `z-index` 为 `var(--z-drag-highlight)` = 1020。如果卡片内包含 iframe/webview 内容，叠加层无法覆盖这些内容（iframe 独立渲染上下文），导致指示器在某些工具面板（如预览/文件）上不可见。

---

## 2. shell-workspace.css 占位符样式

### 2.1 .placeholder-card-group 完整样式

`.placeholder-card-group` 是拖拽拆分时渲染的占位组容器，定义在 shell-workspace.css:1232-1249：

```css
.app-container .workspace-card.placeholder-card-group,
.placeholder-card-group {
  background: color-mix(in srgb, var(--border-color) 10%, var(--bg-secondary, #f9f9fb)) !important;
  border: none !important;
  border-radius: var(--radius-lg) !important;
  box-shadow: none !important;
  display: flex !important;
  flex-direction: column !important;
  justify-content: center !important;
  align-items: center !important;
  gap: var(--space-2) !important;
  padding: var(--space-4) !important;
  padding-top: 52px !important;
  box-sizing: border-box !important;
  transition: all var(--duration-normal) ease !important;
  position: relative !important;
  overflow: hidden !important;
}
```

**关键点**：
- 使用两层选择器确保高优先级覆盖（`.app-container .workspace-card.placeholder-card-group` + `.placeholder-card-group`）
- `background` 使用 `color-mix` 混合 `--border-color`（10%）和 `--bg-secondary`
- `padding-top: 52px` 为 `::before` 伪元素（Header 框）预留空间
- 大量使用 `!important`，总数超过 15 个

**暗色主题问题**：`var(--bg-secondary, #f9f9fb)` 的 fallback 是亮色灰白 `#f9f9fb`。暗色主题下 `--bg-secondary` 为 `hsl(0, 0%, 8%)`，正常情况下会被正确覆盖。但若 CSS 变量级联被破坏，fallback 值 `#f9f9fb` 会在暗色背景上产生刺眼的白色块。

### 2.2 ::before 和 ::after 的"双分块"

`.placeholder-card-group::before`（shell-workspace.css:1260-1273）和 `::after`（shell-workspace.css:1275-1288）被硬编码为两个内部小框，模拟"Header"和"Body"：

**::before — Header 框**：
```css
.placeholder-card-group::before {
  content: "" !important;
  position: absolute !important;
  top: 10px !important;
  left: 10px !important;
  right: 10px !important;
  height: 32px !important;
  background: var(--bg-primary, #ffffff) !important;
  border: 1px solid color-mix(in srgb, var(--border-color) 35%, transparent) !important;
  border-radius: var(--radius-md) !important;
  box-shadow: 0 1px 3px color-mix(in srgb, var(--shadow-color) 1%, transparent) !important;
  z-index: var(--z-decorative) !important;
  pointer-events: none !important;
}
```

**::after — Body 框**：
```css
.placeholder-card-group::after {
  content: "" !important;
  position: absolute !important;
  top: 52px !important;
  bottom: 10px !important;
  left: 10px !important;
  right: 10px !important;
  background: var(--bg-primary, #ffffff) !important;
  border: 1px solid color-mix(in srgb, var(--border-color) 35%, transparent) !important;
  border-radius: var(--radius-md) !important;
  box-shadow: 0 1px 3px color-mix(in srgb, var(--shadow-color) 1%, transparent) !important;
  z-index: var(--z-decorative) !important;
  pointer-events: none !important;
}
```

### 2.3 每个伪元素的具体尺寸和位置

**Header 框（::before）**：
- 距容器顶部 `10px`
- 距左右 `10px`
- 高度 `32px`（固定，模拟 tab bar 高度）
- `z-index: var(--z-decorative)` = 1

**Body 框（::after）**：
- 距容器顶部 `52px`（10px padding + 32px header + 10px gap）
- 距容器底部 `10px`
- 距左右 `10px`
- 高度自动填充剩余空间（`bottom: 10px`）
- `z-index: var(--z-decorative)` = 1

### 2.4 大号容器中为何显示"双分块"

"双分块"视觉问题的根因：

1. `::before` 和 `::after` 模拟了卡片占位的"骨架屏"结构，意在让用户看到"这是一个可以放置面板的区域"
2. 当 `.placeholder-card-group` 容器较大时（例如整个列仅此一个组占满全高），`::after` 占据除顶部 52px 和底部 padding 外的全部剩余空间，看起来像一个巨大的白色/浅色方块
3. `::before` 的 32px Header 框 + `::after` 的大 Body 框形成了鲜明的两块分割，视觉上像是两个独立的 UI 块，不符合"占位符"的轻量预期
4. 这两个伪元素没有条件渲染逻辑——无论容器大小、无论亮暗主题，始终显示
5. 容器自身的 `background: color-mix(...)` 与伪元素的 `var(--bg-primary, #ffffff)` 背景叠加，形成"三层"背景效果：
   - 最底层：容器背景（border-color 10% + bg-secondary 混合）
   - 中间层：::before / ::after 背景（bg-primary 白色）
   - 最上层：边框和阴影

---

## 3. CSS 变量 fallback 分析

### 3.1 主题系统如何工作

主题系统建立在 CSS 自定义属性（变量）之上：

```
tokens.css            → 定义 :root 和 html[data-theme="dark"] 的变量
theme-dark.css        → 组件级别的暗色覆盖
shell-workspace.css   → 使用 html[data-theme="dark"] 选择器覆盖 shell 变量
```

变量加载顺序：
1. `tokens.css` 中的 `:root` 定义亮色主题
2. `tokens.css` 中 `html[data-theme="dark"]` 定义暗色主题
3. `shell-workspace.css` 使用 `html[data-theme="dark"] .app-container[...]` 作 shell 级别覆盖
4. JS 在运行时切换 `data-theme` 属性

### 3.2 --accent-color 的 fallback 值

在整个拖拽相关样式中，`--accent-color` 的 fallback 值被广泛使用：

| 位置 | 属性 | 表达式 | Fallback |
|------|------|--------|----------|
| CardPanel.tsx dockOverlayStyle | background-color | `color-mix(..., var(--accent-color, #1a73e8) 6%, transparent)` | #1a73e8 |
| CardPanel.tsx dockOverlayStyle | border | `color-mix(..., var(--accent-color, #1a73e8) 45%, transparent)` | #1a73e8 |
| shell-dragdrop.css .drop-indicator | background-color | `color-mix(..., var(--accent-color, #1a73e8) 8%, transparent)` | #1a73e8 |
| shell-dragdrop.css .drop-indicator | border | `color-mix(..., var(--accent-color, #1a73e8) 40%, transparent)` | #1a73e8 |
| Workspace.module.css .placeholderCol | background | `color-mix(..., var(--accent-color, #1a73e8) 5%, transparent)` | #1a73e8 |
| Workspace.module.css .placeholderCardGroup | border | `color-mix(..., var(--accent-color, #1a73e8) 40%, transparent)` | #1a73e8 |
| shell-workspace.css .tab-placeholder-indicator | background | `color-mix(..., var(--accent-color, #1a73e8) 8%, transparent)` | #1a73e8 |
| shell-workspace.css @keyframes | background-color | `color-mix(..., var(--accent-color, #1a73e8) 10%, transparent)` | #1a73e8 |

Fallback `#1a73e8` 是一个蓝色（Google Blue），而亮色主题的 `--accent-color` 实际为 `hsl(35, 16%, 15%)`（暖炭色）。这意味着：
- 亮色主题下，如果变量正常加载，使用暖炭色 — 视觉效果尚可
- 如果变量加载失败或 fallback 生效，使用蓝色 — 与整体暖色调设计不协调
- **暗色主题下**，`--accent-color` 为 `#f8fafc`，与 fallback `#1a73e8` 差异巨大

### 3.3 暗色主题下的变量覆盖

暗色主题下，变量覆盖主要在 tokens.css:346-461 中定义。关键差异：

| 变量 | 亮色值 | 暗色值 | Fallback |
|------|--------|--------|----------|
| `--accent-color` | `hsl(35, 16%, 15%)` | `#f8fafc` | `#1a73e8` |
| `--bg-primary` | `hsl(35, 12%, 94.0%)` | `hsl(0, 0%, 5%)` | 无 |
| `--bg-secondary` | `hsl(35, 12%, 91.5%)` | `hsl(0, 0%, 8%)` | 无 |
| `--border-color` | `hsl(35, 10%, 86.0%)` | `hsl(0, 0%, 18%)` | 无 |
| `--border-subtle` | `hsl(35, 8%, 91.0%)` | `hsl(0, 0%, 14%)` | 无 |

暗色主题下，`--accent-color` 被设为 `#f8fafc`（近乎白色），这意味着：
- `color-mix(in srgb, var(--accent-color) 6%, transparent)` = 极淡的白色
- 在暗色背景（5% 黑）上几乎不可见
- merge 指示器基本等同于透明不可见

### 3.4 fallback 失效的根因

CSS 变量的 fallback 机制在以下情况触发：
1. **变量未定义**：CSS 自定义属性未在级联中任何位置设定
2. **变量值为 `initial`**：显式重置
3. **变量值为空**：`var(--x)` 且 `--x` 的值为空字符串
4. **级联被 Shadow DOM / portal 打断**

在 CardPanel.tsx 中，`dockOverlayStyle` 是 inline style，理论上 inline style 也能访问 CSS 变量（变量在 DOM 树级联）。但以下情况会导致 fallback 触发：

- **React Portal**：`dropPreview` 的 tab 插入线通过 `createPortal` 渲染到 `document.body`，脱离了 `.workspace-card` 的作用域。如果 `document.body` 上未设置相关 CSS 变量，fallback 被使用
- **iframe/webview**：预览面板内的 iframe 是完全独立的文档，CSS 变量不共享
- **CSS 变量未在组件根元素设置**：如果 React 树中某个节点设置了 `isolation: isolate` 或 `contain: style`，可能切断 CSS 变量的级联

---

## 4. 模块 CSS 与全局 CSS 的冲突

### 4.1 Workspace.module.css 的 :global 使用

Workspace.module.css 使用了 CSS Modules 的 `:global` 伪选择器来覆盖全局样式：

```css
:global(.is-resizing) .column,
:global(.resizing-active) .column,
:global(.window-resizing) .column,
.column[data-resizing="true"] {
  transition: none !important;
}
```

同时，Workspace.module.css 定义了 `.placeholderCardGroup` 类（Workspace.module.css:234-252），该 class 在 Workspace.tsx:806 中通过组合方式使用：

```tsx
className={`${styles.placeholderCardGroup} workspace-card placeholder-card-group`}
```

**这意味着 `.placeholderCardGroup`（模块 scope）和 `.placeholder-card-group`（全局）同时应用在同一个元素上**。

### 4.2 CSS Modules 的优先级

CSS Modules 的 class 在编译后会变成 hash 字符串（如 `_placeholderCardGroup_abc123`），而全局 class `.placeholder-card-group` 保持不变。

选择器优先级对比：

| 选择器 | 优先级 | 来源 |
|--------|--------|------|
| `._hash.workspace-card.placeholder-card-group` | (0,3,0) | CSS Module hash |
| `.app-container .workspace-card.placeholder-card-group` | (0,3,0) | shell-workspace.css |
| `.placeholder-card-group` | (0,1,0) | shell-workspace.css |
| `.placeholder-card-group::before` | (0,2,0) | shell-workspace.css |

当模块 CSS 与全局 CSS 优先级相同时，出现顺序决定覆盖结果：
- CSS Modules 通常最后加载（在 JS bundle 中动态注入）
- 全局 CSS（如 shell-workspace.css）在 HTML 中静态链接

### 4.3 覆盖冲突的具体表现

**冲突 1：border 属性**
- `.placeholderCardGroup`（模块）定义：`border: 1.5px dashed color-mix(...)` => 蓝色虚线边框
- `.placeholder-card-group`（全局）定义：`border: none !important`
- **结果**：全局的 `border: none !important` 胜出，模块的虚线边框被压掉

**冲突 2：background 属性**
- `.placeholderCardGroup`（模块）定义：`background: color-mix(in srgb, var(--accent-color, #1a73e8) 6%, transparent)` => 极淡的 accent-color 背景
- `.placeholder-card-group`（全局）定义：`background: color-mix(in srgb, var(--border-color) 10%, var(--bg-secondary, #f9f9fb)) !important`
- **结果**：全局的 `!important` 胜出

**冲突 3：backdrop-filter**
- `.placeholderCardGroup`（模块）定义：`backdrop-filter: blur(4px)`
- `.placeholder-card-group`（全局）定义：无 backdrop-filter
- **结果**：全局无 backdrop-filter，模块的毛玻璃效果不生效（因为全局覆盖了 background 后 backdrop-filter 视觉上被遮盖）

**冲突 4：padding / margin**
- `.placeholderCardGroup`（模块）：`margin: var(--space-1, 4px); padding: var(--space-2, 6px);`
- `.placeholder-card-group`（全局）：`padding: var(--space-4) !important; padding-top: 52px !important;`
- **结果**：全局的 `!important` 胜出

**最终效果**：`.placeholderCardGroup` 模块 CSS 中的绝大部分样式被 `!important` 覆盖，模块 CSS 实际仅贡献了 `backdrop-filter`（被遮盖）和 `svg` 相关样式。这是一个严重的**样式架构问题**：模块 CSS 和全局 CSS 的意图完全背离，互相覆盖。

---

## 5. 拖拽预览卡片的样式

### 5.1 .drag-overlay-preview-card

`drag-overlay-preview-card` 类定义在 shell-dragdrop.css:90-100：

```css
.drag-overlay-preview-card {
  position: fixed;
  pointer-events: none;
  z-index: var(--z-drag-overlay);
  border-radius: var(--radius-sm, 6px);
  overflow: hidden;
}
.drag-overlay-preview-card * {
  pointer-events: none !important;
}
```

该类仅设置定位和基本属性，实际样式由 useTabDrag.ts 中的 inline style 控制（useTabDrag.ts:1176-1198）：

```js
dragOverlay.style.cssText = `
  position: fixed;
  width: ${startWidth}px;
  height: ${startHeight}px;
  overflow: hidden;
  box-shadow: 0 0 16px rgba(0,0,0,0.12);
  border-radius: 0;
  border: 1.5px solid color-mix(in srgb, var(--accent-color, #1a73e8) 35%, var(--border-color));
  background: var(--bg-card, var(--bg-primary));
  opacity: 0.92;
  pointer-events: none;
  z-index: 10000;
  transition: opacity 0.12s ease-out;
  will-change: transform;
`;
```

### 5.2 拖拽半透明卡片的外观

拖拽预览卡片的视觉特征：
1. **全尺寸克隆**：克隆 CardPanel 整个 DOM 子树
2. **透明度**：`opacity: 0.92` — 轻微半透明
3. **边框**：`accent-color 35% + border-color` 混合 — 微妙的有色边框
4. **阴影**：`0 0 16px rgba(0,0,0,0.12)` — 环绕阴影
5. **固定定位**：跟随指针偏移（clickOffsetX/Y）
6. **过渡**：松手时有 `animateOverlayAway` 动画（缩放 + 淡出 280ms）

**暗色主题问题**：`var(--bg-card, var(--bg-primary))` 在暗色主题下为 `hsl(0, 0%, 11%)`（深灰色），与深色背景（5%）对比度不足。阴影 `rgba(0,0,0,0.12)` 在暗色主题上几乎不可见，因为没有使用 `color-mix` 和 `--shadow-color` 系统。

### 5.3 标签拖拽预览（card-tab 克隆）

当拖拽的是标签按钮时（`isDragFromTabButton`），预览是单个 tab 的克隆（useTabDrag.ts:1146-1172）：

```js
dragOverlay.style.cssText = `
  position: fixed;
  width: ${tabR.width}px;
  height: ${tabR.height}px;
  overflow: hidden;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12), 0 2px 4px rgba(0, 0, 0, 0.06);
  opacity: 0.95;
  pointer-events: none;
  z-index: 10000;
  box-sizing: border-box;
  border: 1px solid var(--border-color);
  background: var(--bg-primary, #ffffff);
  border-radius: var(--radius-sm, 6px);
  display: flex;
  align-items: center;
  justify-content: center;
`;
```

### 5.4 与现代 DnD 库的对比

**DnD Kit（参考）**：
- 使用 `<DragOverlay>` 组件，自动处理 portal 渲染
- 默认使用 `position: fixed` + `transform` 定位（GPU 加速）
- 松手时有平滑的 `transition` 回位动画
- 不直接操作 DOM，通过 React 状态驱动

**本项目实现**：
- 直接操作 DOM：`document.body.appendChild(dragOverlay)` — 绕过了 React 生命周期
- 使用 `left/top` 定位（触发 layout）而非 `transform`（仅触发 composite）
- 阴影使用固定颜色 `rgba(0,0,0,0.12)` — 不响应主题变量
- 标签克隆后移除关闭按钮，但保留了事件处理器的引用

---

## 6. 参考设计对比

### 6.1 现代拖拽指示器设计趋势

**趋势 1：薄线指示器**
- VS Code 风格：1-2px 的实色线条，极简不干扰
- 颜色使用主题 accent color，无虚线
- 圆角矩形取代连续线条

**趋势 2：毛玻璃背景**
- 使用 `backdrop-filter: blur()` 让指示器"穿透"底层内容
- 半透明背景（8-15% accent color）
- 适用于浮层覆盖内容场景

**趋势 3：accent color 统一**
- 现代设计系统中，拖拽指示器统一使用 accent/primary color
- 通过透明度（8-20%）表达不同的状态（hover / active / preview）
- 不使用黑色、灰色或任何非主题色

**趋势 4：无虚线边框**
- 虚线在现代 UI 中已经被逐步淘汰
- 使用实线 + 透明度变化替代
- 或使用内阴影（inset box-shadow）替代边框

**趋势 5：GPU 加速动画**
- `transform` + `opacity` 动画只触发 composite
- 使用 `will-change: transform` 提示浏览器
- `transition` 控制在 200-300ms，easing 使用 spring/emphasized

### 6.2 颜色体系对比

**本项目现状**：

| 元素 | 亮色 | 暗色 | Fallback |
|------|------|------|----------|
| merge 指示器 | 暖炭 6% + 虚框 | 白 6%（不可见） | 蓝 |
| top/bottom 占位符 | border+secondary 混合 | 同上 | #f9f9fb 白色 |
| 插入线 | accent-color | accent-color（白） | 蓝 |
| drop-indicator | accent-color 8% | 白 8%（不可见） | 蓝 |

**现代设计推荐**：

| 元素 | 亮色 | 暗色 |
|------|------|------|
| merge 指示器 | accent-color 8% + 实线 30% | accent-color 10% + 实线 35% |
| 拆分占位符 | accent-color 5% + blur(4px) | accent-color 8% + blur(4px) |
| 插入线 | accent-color 3px 圆角 | accent-color 3px 圆角 |
| drop-indicator | accent-color 8% + 实线 30% + blur(2px) | accent-color 10% + 实线 35% + blur(2px) |

### 6.3 backdrop-filter 的应用

`backdrop-filter` 在以下位置被使用，但受限于各种问题：

| 位置 | 表达式 | 是否生效 | 问题 |
|------|--------|----------|------|
| Workspace.module.css .placeholderCol | `backdrop-filter: blur(4px)` | 是 | 仅列占位符使用 |
| Workspace.module.css .placeholderCardGroup | `backdrop-filter: blur(4px)` | 否 | 被全局 CSS 覆盖 |
| Workspace.module.css .dropIndicator | `backdrop-filter: blur(2px)` | 是 | 单独的 drop-indicator |
| shell-dragdrop.css .drop-indicator | `backdrop-filter: blur(2px)` | 是 | 但未在所有指示器上统一 |

根因是 `backdrop-root` 机制：当元素有 `opacity < 1` 或 `filter/backdrop-filter` 非 none 时，它会成为 backdrop root，限制其后代元素的 backdrop-filter 作用范围。本项目中 `workspaces-stack` 设置了 `isolation: isolate`，可能进一步限制 backdrop-filter 的作用。

---

## 7. 所有样式问题的根因总结

### 问题一：样式架构碎片化

**根因**：整个拖拽指示系统横跨 4 个 CSS 作用域：
1. CardPanel.tsx 内联样式（dockOverlayStyle）
2. Workspace.module.css CSS Modules（placeholderCardGroup, dropIndicator, placeholderCol）
3. shell-workspace.css 全局样式（placeholder-card-group, ::before, ::after）
4. shell-dragdrop.css 全局样式（drop-indicator, drag-overlay-preview-card, tab-insert-line）

**后果**：同一交互（同列拖拽）的样式分布在 4 个不同来源中，互相覆盖、不一致。

### 问题二：CSS 变量 fallback 不可靠

**根因**：
- `--accent-color` 的 fallback 值 `#1a73e8` 与亮色/暗色主题的实际值完全不同
- fallback 在暗色主题下产生"蓝色"而非预期效果
- 变量级联可能被 React portal 或 Shadow DOM 打断

### 问题三：`!important` 滥用

**根因**：`.placeholder-card-group` 在 shell-workspace.css 中使用了 15+ 个 `!important` 声明，以覆盖 Workspace.module.css 中的模块样式。

**后果**：
- 模块 CSS 形同虚设
- 任何后续修改都需要同样使用 `!important`
- 主题覆盖变得困难（需要更高优先级的 `!important`）

### 问题四：伪元素"双分块"

**根因**：`::before` 和 `::after` 被固定为 Header 和 Body 两个框，在任何容器大小下都显示。

**后果**：
- 大容器显示两个巨大白块
- 颜色值无主题感知
- 无法通过增加文本/图标来传达更多信息

### 问题五：暗色主题测试缺失

**根因**：所有拖拽指示器相关样式在暗色主题下没有充分的测试覆盖：
- `color-mix` 在暗色背景上的对比度不足
- `--accent-color` 在暗色主题下为白色，6% 透明度近乎不可见
- 占位符背景的 fallback `#f9f9fb` 和 `#ffffff` 在暗色背景上刺眼

### 问题六：动画性能

**根因**：
- 预览卡片使用 `left/top` 定位（触发 layout）
- 叠加层使用 `animation` 动画（`pulse-merge-highlight`）而非 `transition`
- 动画 easing 使用 `ease-in-out` 而非 spring/emphasized

### 问题七：inline style 与 CSS 变量缺乏协同

**根因**：
- `dockOverlayStyle` 完全使用 inline style
- 无法通过 CSS 文件覆盖
- `color-mix` 表达式中变量路径硬编码
- 组件无法感知外部 CSS 变量的变更

---

*本文档由深度代码分析生成，旨在为后续重构方案提供完整依据。*
