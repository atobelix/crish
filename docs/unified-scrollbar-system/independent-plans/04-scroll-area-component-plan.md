# 《ScrollArea》统一通用滚动条组件架构与分维实现详案

> **文档标识**：`docs/unified-scrollbar-system/independent-plans/04-scroll-area-component-plan.md`  
> **所属战役**：统一通用滚动条系统重构战役（Unified Scrollbar System）  
> **角色定位**：高级前端组件架构师（ScrollArea Component Architect）  
> **权威遵循**：`AGENTS.md`（反退避铁律、严禁打补丁、UI 原子层规范）、`ANTI_OVERENGINEERING_GUARDRAILS.md`  
> **关联规范**：`apps/crish-desktop/src/components/ui/README.md`、`src/styles/tokens.css`、`src/styles/overlay-scrollbar.css`

---

## 1. 执行摘要与架构动因（Executive Summary & Motivation）

在 Conex / Crish 桌面应用持续演进中，滚动条作为最高频的基础交互基建，长期存在以下深层次架构隐患与体验割裂：

1. **私有声明泛滥与平台渲染割裂**：全仓散落超过 100+ 处 `overflow-y: auto` 与私有 `scrollbar-width: thin`。而在 Windows WebView2 (Chromium) 宿主中，容器一旦声明 `scrollbar-width: thin`，Chromium 会主动关闭 `::-webkit-scrollbar` 细条伪元素，直接回退暴露带系统丑陋粗边框与灰色三角的 Windows 默认滚动条（见 `overlay-scrollbar.css` 铁律注释）；
2. **虚拟滚动容器的“零包装”刚性约束**：在虚拟列表（如 `WindowedSessionUl` 会话列表、聊天长流消息表）与侧边栏等极端注重重排重绘性能的场景下，**绝对无法容忍额外嵌套两三层 React DOM 包装节点**，否则会直接破坏 `renderRow` 的绝对定位基准、穿透失效或引发几何测量抖动；
3. **高频业务视口缺乏开箱即用的原子组件**：在弹窗（Dialog）、设置页（SettingsPanel）、模型选择器（ModelBadgePickerMenu）等常规视口中，每个模块都在重复手写滚动监听、自定义样式甚至私有 webkit 规则，违反 DRY 原则与设计系统一致性；
4. **步进按钮（Stepper Buttons）越界与圆角溢出痼疾**：当业务场景需要显示上下三角步进箭头时，业界普遍存在滑块（Thumb）滚动到 0% 或 100% 极限时粗暴覆盖在按钮上方、或是直角滑块刺穿外层容器圆角（Border Radius Clipping）的渲染事故。

本方案针对上述痛点，确立**“双轨统一（Dual-Tier Synergy）”**架构：
- **模式 1（React 组件 `<ScrollArea>`）**：开箱即用，专供常规视口、对话框、设置面板与各类浮层；
- **模式 2（纯 CSS 类名规范 `.scrollArea*`）**：零 DOM 包装开销、零 JS 运行时，通过标准化 CSS Utility 赋能虚拟列表与紧凑布局；
- **两模式在底座共享同一套 Design Tokens、相同的几何防越界数学契约与统一 Webkit 出口。**

---

## 2. 设计系统 Token 体系与尺寸映射契约（Design System Tokens）

遵循 `AGENTS.md` 铁律，**组件与样式层严禁内联硬编码裸像素**（如 `style={{ width: 7 }}`）。所有尺寸、颜色与圆角均收敛至 `tokens.css` 与 `overlay-scrollbar.css`。

### 2.1 CSS 变量契约定义

在 `apps/crish-desktop/src/styles/tokens.css` 中扩充标准滚动条 Token 簇：

```css
/* ==========================================================================
   Unified Scrollbar Tokens (ScrollArea System)
   ========================================================================== */
:root {
  /* 宽度 / 粗细档位 */
  --scrollbar-size-xs: 3px;  /* 极紧凑模式：横向 ToolTabStrip、Mini Scrubber */
  --scrollbar-size-sm: 5px;  /* 紧凑模式：二级下拉浮层、代码预览小卡片 */
  --scrollbar-size-md: 7px;  /* 标准默认：侧栏、设置面板、对话内容视口 */
  --scrollbar-size-lg: 10px; /* 大触控/宽幅：无障碍、宽表格数据视口 */

  /* 步进按钮尺寸（长宽等比方形） */
  --scrollbar-button-size-xs: 10px;
  --scrollbar-button-size-sm: 12px;
  --scrollbar-button-size-md: 14px;
  --scrollbar-button-size-lg: 16px;

  /* 几何安全与间距 */
  --scrollbar-track-margin: 2px;
  --scrollbar-stepper-gap: 2px;
  --scrollbar-thumb-radius: var(--radius-full, 9999px);

  /* 质感色彩（对齐现代 CSS 规范，走透明度与主题融合） */
  --scrollbar-track-bg: transparent;
  --scrollbar-thumb-bg: var(--tint-scrollbar-thumb, color-mix(in srgb, var(--text-primary) 18%, transparent));
  --scrollbar-thumb-hover-bg: var(--tint-overlay, color-mix(in srgb, var(--text-primary) 25%, transparent));
  --scrollbar-thumb-active-bg: var(--tint-highlight, color-mix(in srgb, var(--text-primary) 28%, transparent));
  
  --scrollbar-button-fg: var(--text-tertiary);
  --scrollbar-button-hover-fg: var(--text-primary);
  --scrollbar-button-hover-bg: var(--tint-hover, color-mix(in srgb, var(--text-primary) 3.5%, transparent));
}
```

### 2.2 尺寸映射与属性映射矩阵

| 尺寸变体 (`size`) | 轨道/滑块宽度 (`width`) | 步进按钮高度 (`btnSize`) | 步进安全间隙 (`gap`) | 典型适用场景 |
| :--- | :--- | :--- | :--- | :--- |
| `'xs'` | `--scrollbar-size-xs` (3px) | 10px | 2px | 横向标签条、Mini 浮标、嵌入式 Badge 菜单 |
| `'sm'` | `--scrollbar-size-sm` (5px) | 12px | 2px | 下拉 Select、二级级联菜单、Code Block 卡片 |
| `'md'` (默认) | `--scrollbar-size-md` (7px) | 14px | 2px | 侧边栏主滚动区、设置弹窗内容、消息列常规容器 |
| `'lg'` | `--scrollbar-size-lg` (10px) | 16px | 3px | 宽屏表格视口、大触控无障碍阅读面板 |

---

## 3. 组件 API 契约与 TypeScript 类型规范（API Contract）

符合 `apps/crish-desktop/src/components/ui/README.md` 原子层要求，只依赖 React 原生能力与 Tokens，严禁向上依赖业务 store 或 hooks。

### 3.1 完整 TypeScript 接口定义

```typescript
import React from 'react';

export type ScrollAreaSize = 'xs' | 'sm' | 'md' | 'lg';
export type ScrollAreaOrientation = 'vertical' | 'horizontal' | 'both';
export type ScrollAreaGutter = 'auto' | 'stable';
export type ScrollAreaVisibility = 'auto' | 'always' | 'hover';

export interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: ScrollAreaSize;
  showButtons?: boolean;
  orientation?: ScrollAreaOrientation;
  scrollbarGutter?: ScrollAreaGutter;
  type?: ScrollAreaVisibility;
  stepSize?: number | 'auto';
  as?: React.ElementType;
  viewportClassName?: string;
  contentClassName?: string;
  viewportStyle?: React.CSSProperties;
  contentStyle?: React.CSSProperties;
  viewportRef?: React.Ref<HTMLDivElement>;
  onScroll?: (event: React.UIEvent<HTMLDivElement>) => void;
  onScrollIdle?: () => void;
  ariaLabel?: string;
  children?: React.ReactNode;
}

export interface ScrollAreaHandle {
  scrollToTop: (behavior?: ScrollBehavior) => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  scrollStep: (direction: 'up' | 'down' | 'left' | 'right', behavior?: ScrollBehavior) => void;
  getViewport: () => HTMLDivElement | null;
  getMetrics: () => {
    scrollTop: number;
    scrollLeft: number;
    scrollHeight: number;
    scrollWidth: number;
    clientHeight: number;
    clientWidth: number;
    isAtTop: boolean;
    isAtBottom: boolean;
  };
}
```

---

## 4. 边界防护与防越界机制（Boundary Guard & Anti-Overrun）

### 4.1 问题机理剖析

在带步进按钮的滚动条设计中，最严重的渲染缺陷就是**滑块侵入（Thumb Intrusion）**与**圆角泄露（Corner Leaking）**：
1. **侵入按钮**：当内容滚到 0%（Top）时，若滑块定位基于视口绝对 0 点，滑块会直接叠在“向上”箭头上方；当滚到 100%（Bottom）时，滑块叠在“向下”箭头上方，不仅视觉混乱，还会拦截用户的点击事件。
2. **圆角截断错位**：容器外部常带有 `border-radius: var(--radius-md, 8px)`，而滚动条直角物理端点在极限滚动位置会刺穿外层圆角边界。

### 4.2 解决方案：三段式物理隔离轨道架构（Decoupled 3-Stage Track）

在 `<ScrollArea>` 组件结构中，滚动条侧柱（Scrollbar Bar）采用物理分割的三段式 Flexbox/Grid 管道：

```
┌────────────────────────────────────────────────────────────────────────┐
│ ScrollArea Root (relative, overflow: hidden, border-radius: 8px)       │
│ ┌─────────────────────────────────────────────────────────┐ ┌────────┐ │
│ │ Viewport (native scrollable, scrollbar-width: none)     │ │ [ ▲ ]  │ │ ← Top Stepper Button (H_btn)
│ │ ┌─────────────────────────────────────────────────────┐ │ ├────────┤ │
│ │ │ Content Container                                   │ │ │SafeGap │ │ ← 按钮安全隔离带 (2px)
│ │ │                                                     │ │ ├────────┤ │
│ │ │                                                     │ │ │ Track  │ │
│ │ │                                                     │ │ │ ┌────┐ │ │
│ │ │                                                     │ │ │ │    │ │ │ ← Thumb 严格被夹持在 Track 内
│ │ │                                                     │ │ │ │ Th │ │ │   移动区间：[0, TrackH - ThumbH]
│ │ │                                                     │ │ │ │    │ │ │
│ │ │                                                     │ │ │ └────┘ │ │
│ │ │                                                     │ │ ├────────┤ │
│ │ │                                                     │ │ │SafeGap │ │ ← 按钮安全隔离带 (2px)
│ │ │                                                     │ │ ├────────┤ │
│ │ │                                                     │ │ │ [ ▼ ]  │ │ ← Bottom Stepper Button (H_btn)
│ │ └─────────────────────────────────────────────────────┘ │ └────────┘ │
│ └─────────────────────────────────────────────────────────┘            │
└────────────────────────────────────────────────────────────────────────┘
```

#### 严格代数不变量证明（Mathematical Proof of Boundary Invariant）

设：
- 外层容器高度为 $H_{\text{root}}$；
- 顶部/底部按钮高度为 $H_{\text{btn}}$；
- 上下安全净空为 $G_{\text{safe}}$；
- 则物理独立轨道的有效空间高度：
  $$H_{\text{track}} = H_{\text{root}} - 2 \times (H_{\text{btn}} + G_{\text{safe}})$$
- 视口总高度为 $H_{\text{viewport}}$，内容总滚动高度为 $H_{\text{content}}$；
- 可滚动最大距离：$S_{\max} = H_{\text{content}} - H_{\text{viewport}}$；
- 滚动比例：$\rho = \frac{\text{scrollTop}}{S_{\max}} \in [0, 1]$；
- 滑块高度：$H_{\text{thumb}} = \max\left(\frac{H_{\text{viewport}}}{H_{\text{content}}} \times H_{\text{track}}, H_{\text{thumb,min}}\right)$；
- 滑块在轨道内的最大位移行程：$D_{\text{travel}} = H_{\text{track}} - H_{\text{thumb}}$；
- 滑块在整个容器纵坐标系下的顶部绝对坐标 $Y_{\text{thumb,abs}}$ 计算式为：
  $$Y_{\text{thumb,abs}} = (H_{\text{btn}} + G_{\text{safe}}) + \rho \times D_{\text{travel}}$$

**临界极限断言检验**：
1. **在顶端极限处 ($\rho = 0$)**：
   $$Y_{\text{thumb,abs}} = H_{\text{btn}} + G_{\text{safe}} > H_{\text{btn}}$$
   滑块顶部距离顶部按钮下沿始终恒有 $G_{\text{safe}} = 2\text{px}$ 的物理真空带，**绝对不可能发生像素重叠或侵入**。
2. **在底端极限处 ($\rho = 1$)**：
   滑块底部绝对坐标：
   $$Y_{\text{thumb,bottom}} = Y_{\text{thumb,abs}} + H_{\text{thumb}} = (H_{\text{btn}} + G_{\text{safe}}) + D_{\text{travel}} + H_{\text{thumb}} = H_{\text{btn}} + G_{\text{safe}} + H_{\text{track}} = H_{\text{root}} - (H_{\text{btn}} + G_{\text{safe}})$$
   距离底部按钮上沿的净空距离为：
   $$(H_{\text{root}} - H_{\text{btn}}) - Y_{\text{thumb,bottom}} = G_{\text{safe}} = 2\text{px}$$
   同样形成恒定安全间隔，**绝对不可能侵入底部按钮**。
3. **圆角保护证明**：
   由于滑块移动区间起始于 $Y = H_{\text{btn}} + G_{\text{safe}}$，终结于 $Y = H_{\text{root}} - (H_{\text{btn}} + G_{\text{safe}})$，当 $H_{\text{btn}} + G_{\text{safe}} \ge R_{\text{radius}}$（例如 $14\text{px} + 2\text{px} = 16\text{px} > 8\text{px}$）时，滑块在整个运动生命周期内**全部处于容器四角的直角平直边内侧**，数学上杜绝了刺穿圆角弧度的可能性。
