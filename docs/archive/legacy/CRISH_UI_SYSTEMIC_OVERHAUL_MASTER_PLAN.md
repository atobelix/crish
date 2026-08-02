# Crish Workbench - 全站 UI/UX 系统性高级重构与美学改进方案 (Master Plan)

> **版本**：v2.0 (全量终极重构版本)  
> **设计哲学**：**克制的高级感（Understated Luxury & Restrained Precision）**  
> **目标**：不遗留任何历史视觉与交互漏洞，拒绝喧宾夺主。全方位对齐 Linear、Zed、Cursor、Windsurf、Raycast 等全球顶尖极客工具的像素级（Pixel-Perfect）视效与高操控感 ergonomics 体验。

---

## 目录

- [零、 方案背景与终极原则](#零-方案背景与终极原则)
- [一、 设计令牌系统 (Design Tokens) 与色阶全量重构](#一-设计令牌系统-design-tokens-与色阶全量重构)
  - [1.1 蓝墨黑 (Slate/Zinc Charcoal) 高级沉浸调色盘](#11-蓝墨黑-slatezinc-charcoal-高级沉浸调色盘)
  - [1.2 边缘描边与 Hairline 微渐变体系](#12-边缘描边与-hairline-微渐变体系)
  - [1.3 光影深度 (Surface Elevation & Inset Highlight)](#13-光影深度-surface-elevation--inset-highlight)
  - [1.4 字体与物理同心圆角 (Concentric Radius Matrix)](#14-字体与物理同心圆角-concentric-radius-matrix)
- [二、 对话流与 Agent 执行引擎界面降噪](#二-对话流与-agent-执行引擎界面降噪)
  - [2.1 Chat Composer 输入壳体全量修复](#21-chat-composer-输入壳体全量修复)
  - [2.2 Tool Call 动态时间线 (Compact Timeline Stream)](#22-tool-call-动态时间线-compact-timeline-stream)
  - [2.3 消息列表、吸顶栏与防重影遮罩](#23-消息列表吸顶栏与防重影遮罩)
  - [2.4 环境状态横幅 (Quiet Banners) 降噪](#24-环境状态横幅-quiet-banners-降噪)
- [三、 安全审批与风控卡片重构](#三-安全审批与风控卡片重构)
  - [3.1 ApprovalAskCard 硬线与角标重构](#31-approvalaskcard-硬线与角标重构)
  - [3.2 去除硬编码 Color Fallback 变量机制](#32-去除硬编码-color-fallback-变量机制)
- [四、 代码渲染、Diff 视图与终端视觉升维](#四-代码渲染diff-视图与终端视觉升维)
  - [4.1 Markdown 代码块背景消融](#41-markdown-代码块背景消融)
  - [4.2 DiffCard 滑动药丸段选器 (Sliding Pill Segmented Control)](#42-diffcard-滑动药丸段选器-sliding-pill-segmented-control)
  - [4.3 TerminalCard 终端聚焦与遮罩过渡](#43-terminalcard-终端聚焦与遮罩过渡)
- [五、 全局侧栏、顶栏与控制面板细节清理](#五-全局侧栏顶栏与控制面板细节清理)
  - [5.1 WorkspaceChromeBars 消除黑夜白线 Flash](#51-workspacechromebars-消除黑夜白线-flash)
  - [5.2 Sidebar 恢复雅致分隔边框与热区脉冲光](#52-sidebar-恢复雅致分隔边框与热区脉冲光)
  - [5.3 OverviewCard WCAG 对比度修复与 Hover 高亮](#53-overviewcard-wcag-对比度修复与-hover-高亮)
  - [5.4 AgentCard 全局淘汰 display: none 换用 CSS 容器查询](#54-agentcard-全局淘汰-display-none-换用-css-容器查询)
- [六、 快捷键弹窗、模态框与微交互力学](#六-快捷键弹窗模态框与微交互力学)
  - [6.1 CheatsheetModal 触感物理键帽 (Tactile Keycaps)](#61-cheatsheetmodal-触感物理键帽-tactile-keycaps)
  - [6.2 模态框 14% 通透上下文遮罩](#62-模态框-14-通透上下文遮罩)
  - [6.3 物理弹簧微动效 (Spring Physics Easing)](#63-物理弹簧微动效-spring-physics-easing)
- [七、 模块化全量代码 Patch 实施清单 (Full Source Code Specifications)](#七-模块化全量代码-patch-实施清单-full-source-code-specifications)
  - [Patch A: `styles/tokens.css` & `theme-dark.css`](#patch-a-stylestokenscss--theme-darkcss)
  - [Patch B: `components/ChatComposer.module.css`](#patch-b-componentschatcomposermodulecss)
  - [Patch C: `components/ChatToolCallBlock.module.css`](#patch-c-componentschattoolcallblockmodulecss)
  - [Patch D: `components/ApprovalAskCard.module.css`](#patch-d-componentsapprovalaskcardmodulecss)
  - [Patch E: `components/OverviewCard.module.css`](#patch-e-componentsoverviewcardmodulecss)
  - [Patch F: `components/AgentCard.module.css`](#patch-f-componentsagentcardmodulecss)
  - [Patch G: `components/Sidebar.module.css`](#patch-g-componentssidebarmodulecss)
  - [Patch H: `components/TerminalCard.module.css`](#patch-h-componentsterminalcardmodulecss)
  - [Patch I: `components/CheatsheetModal.module.css`](#patch-i-componentscheatsheetmodalmodulecss)
  - [Patch J: `components/ChatMessageList.module.css`](#patch-j-componentschatmessagelistmodulecss)
  - [Patch K: `components/ChatStatusRibbons.module.css`](#patch-k-componentschatstatusribbonsmodulecss)
  - [Patch L: `components/WorkspaceChromeBars.module.css`](#patch-l-componentsworkspacechromebarsmodulecss)
  - [Patch M: `components/DiffCard.module.css`](#patch-m-componentsdiffcardmodulecss)
- [八、 验证与质量交付标准](#八-验证与质量交付标准)

---

## 零、 方案背景与终极原则

在经过对 Crish Agent Workbench 全量前端样式（`tokens.css`, `theme-dark.css`, `index.css`, `panels.css` 及组件级 CSS Module）与 TypeScript 组件的系统性审查后，确定了以下重构纲领：

1. **零遗留原则（Zero-Debt Policy）**：本次重构不区分优先级，所有发现的色值漏洞、硬编码 Fallback、圆角失真、对比度失效及交互瑕疵，必须一把全量收缴改进。
2. **克制的高级感（Restrained Premium Aesthetic）**：
   - 拒绝大面积刺眼的饱和度渐变或炫目发光（No Flashy Colors）。
   - 采用 1px 细如发丝的线框（Hairline Border）、极淡的退晕描边（Inset Stroke）以及基于物理色彩叠加的 `color-mix` 色阶。
   - 强调文字与几何空间的精准呼吸度，让界面退居为背景，使代码与对话流成为唯一的核心主角。
3. **视觉与 Ergonomics 操作双升维**：兼顾极致可读性（符合 WCAG 2.1 AAA 规范）与触感掌控力（物理等宽键帽、容器查询缩放、防重影毛玻璃）。

---

## 一、 设计令牌系统 (Design Tokens) 与色阶全量重构

### 1.1 蓝墨黑 (Slate/Zinc Charcoal) 高级沉浸调色盘
当前暗色模式采用 `hsl(0, 0%, 5%)` 纯中性黑，色彩显干瘪，语法高亮附着力差。全量调升为注入 218° 极沉稳冷蓝的深炭暗色系：

```css
/* 修改 tokens.css 中的 html[data-theme="dark"] */
html[data-theme="dark"] {
  --bg-primary: hsl(218, 14%, 6.5%);       /* 主背景：沉稳的蓝墨漆黑 */
  --bg-secondary: hsl(218, 12%, 9.5%);     /* 侧栏/顶栏：阶梯暗灰蓝 */
  --bg-tertiary: hsl(218, 10%, 12.5%);    /* 卡片下凹底色 */
  --bg-card: hsl(218, 10%, 12.5%);        /* 卡片常规 */
  --bg-elevated: hsl(218, 10%, 16.0%);    /* 弹层与菜单：抬高明度保证空间层级 */
  --bg-hover: color-mix(in srgb, var(--text-primary) 4%, transparent);
  --bg-active: color-mix(in srgb, var(--text-primary) 7.5%, transparent);

  --border-color: hsl(218, 10%, 18.5%);
  --border-subtle: hsl(218, 8%, 14.5%);
}
```

### 1.2 边缘描边与 Hairline 微渐变体系
收缴所有 `1px solid #xxx` 粗暴规则，统一交由语义化 Hairline Token 统管：

- `--hairline`: 结构性静态分隔（面板底线、列表分割）。
- `--hairline-strong`: 可交互壳体描边（输入框、弹层下拉框、提示卡）。
- 描边统一采用 `color-mix(in srgb, var(--border-color) 75%, transparent)` 保持柔软度。

### 1.3 光影深度 (Surface Elevation & Inset Highlight)
完全废除各 CSS 文件中盲目写入的 `box-shadow: none !important;`。在深色模式下建立顺光退晕（Linear Top-to-Bottom Gradient）与 1px 微发光内描边：

$$\text{Elevation Layer} = \text{Top-Light Inset} + \text{Surface Gradient} + \text{Ambient Soft Shadow}$$

```css
:where(html[data-theme="dark"]) [data-panel="card"],
:where(html[data-theme="dark"]) .ui-card-elevated {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.02) 0%, rgba(0, 0, 0, 0.08) 100%), var(--bg-card);
  border: 1px solid color-mix(in srgb, var(--border-color) 80%, transparent);
  box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.04), var(--shadow-sm);
}
```

### 1.4 字体与物理同心圆角 (Concentric Radius Matrix)
解决 `ChatComposer`（20px 胶囊）包裹 `Button`（6px 矩形）时圆角切线扭曲的问题，建立数学同心法则：

$$R_{\text{outer}} = R_{\text{inner}} + \text{Padding}$$

规范圆角阶梯：
- `--radius-xs`: 3px (微型 Tag、角标)
- `--radius-sm`: 4px (按键、次级选项)
- `--radius-md`: 6px (标准控件、输入壳体)
- `--radius-lg`: 8px (卡片容器、对话气泡)
- `--radius-xl`: 10px / 12px (模态框、主对话底壳)

---

## 二、 对话流与 Agent 执行引擎界面降噪

### 2.1 Chat Composer 输入壳体全量修复
在 `ChatComposer.module.css` 中清除 20px 偏心硬圆角，改为同心嵌套 `var(--radius-xl)`（10px），并优化 focus 态的极淡环形微光：

```css
.container {
  border-radius: var(--radius-xl);
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  background: var(--composer-shell-bg);
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.container:focus-within {
  border-color: color-mix(in srgb, var(--border-color) 85%, var(--text-primary) 15%) !important;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--text-primary) 5%, transparent) !important;
}
```

### 2.2 Tool Call 动态时间线 (Compact Timeline Stream)
重构 `ChatToolCallBlock.module.css`：
1. 将块状 Tool Header 行高从 32px 压缩至 **24px~26px** 极轻量流式行。
2. 展开 Chevron 图标（`.toolRowChevronSlot`）默认保持 `opacity: 0.3`（不再默认隐藏），解决可交互隐蔽性缺陷。
3. 增加极窄的时间线左描边与悬浮高亮度：

```css
.toolRowHead {
  min-height: 26px;
  padding: 2px 6px;
  border-radius: var(--radius-md);
  transition: background var(--transition-fast);
}

.toolRowHead:hover {
  background: color-mix(in srgb, var(--text-primary) 4%, transparent);
}

.toolRowChevronSlot {
  opacity: 0.3;
  transition: opacity var(--transition-fast);
}

.toolRowHead:hover .toolRowChevronSlot {
  opacity: 0.75;
}
```

### 2.3 消息列表、吸顶栏与防重影遮罩
优化 `ChatMessageList.module.css` 中的吸顶消息条（`.pinnedBar`）：
- 提升模糊半径由 8px 至 **12px**。
- 将背景透明度调精至 **92%**，消除滚动文字通过吸顶栏产生的双重影文字瑕疵（Text Bleed-through Visual Artifact）。

```css
.pinnedBar {
  background: color-mix(in srgb, var(--bg-primary) 92%, transparent);
  backdrop-filter: blur(12px);
  border: 1px solid color-mix(in srgb, var(--border-color) 60%, transparent);
  border-radius: var(--radius-md);
}
```

### 2.4 环境状态横幅 (Quiet Banners) 降噪
全面清洗 `ChatStatusRibbons.module.css`：
- 清除提示行中强烈的文本下划线 `text-decoration: underline`。
- 采用自带微暗度背景的 Inline Action Pill：

```css
.chatSoftHint {
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg-secondary) 60%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 60%, transparent);
  padding: 5px 10px;
}

.chatSoftHintAction {
  text-decoration: none;
  font-size: var(--font-size-xs);
  padding: 2px 8px;
  border-radius: var(--radius-xs);
  background: color-mix(in srgb, var(--text-primary) 6%, transparent);
  transition: background var(--transition-fast);
}

.chatSoftHintAction:hover {
  text-decoration: none;
  background: color-mix(in srgb, var(--text-primary) 12%, transparent);
}
```

---

## 三、 安全审批与风控卡片重构

### 3.1 ApprovalAskCard 硬线与角标重构
改掉 `border-left: 2px solid #f59e0b` 的粗硬风控勾边。改为高雅的风险 Tag 标签及全框柔和色阶：

```css
.approvalCard {
  margin: 6px 0 8px;
  padding: 10px 12px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
  border-left: 2px solid var(--color-warning, var(--accent-orange));
  background: color-mix(in srgb, var(--bg-card) 98%, var(--accent-orange) 2%);
}

.approvalCard[data-risk-level="critical"],
.approvalCard[data-risk-level="high"] {
  border-left-color: var(--color-error, var(--accent-red));
  background: color-mix(in srgb, var(--bg-card) 97%, var(--accent-red) 3%);
}
```

### 3.2 去除硬编码 Color Fallback 变量机制
清洗 `ApprovalAskCard.module.css` 中的全量硬编码 Hex 色值：
- 将 `#f59e0b` 替换为 `var(--color-warning, var(--accent-orange))`
- 将 `#ef4444` 替换为 `var(--color-error, var(--accent-red))`
- 将 `#22c55e` 替换为 `var(--color-success, var(--accent-green))`

---

## 四、 代码渲染、Diff 视图与终端视觉升维

### 4.1 Markdown 代码块背景消融
在 `theme-dark.css` 中将死硬粗糙的 `#2a2a2a` 彻底下调并与调色盘融合：

```css
:where(html[data-theme="dark"]) {
  --md-code-bg: color-mix(in srgb, var(--bg-secondary) 85%, var(--text-primary) 15%);
  --md-code-border: var(--border-subtle);
  --md-code-fg: #e6e6e6;
}

:where(html[data-theme="dark"]) .msg-assistant-text code,
:where(html[data-theme="dark"]) .md-rendered .md-inline-code {
  background: color-mix(in srgb, var(--bg-elevated) 70%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 60%, transparent);
  border-radius: var(--radius-xs);
  padding: 1px 5px;
}
```

### 4.2 DiffCard 滑动药丸段选器 (Sliding Pill Segmented Control)
重构 `DiffCard.module.css` 分段控制按钮（`.sourceSeg`）：
从简单的文字变色升级为具有层次触感的微背景高亮：

```css
.sourceSeg {
  display: inline-flex;
  align-items: center;
  background: color-mix(in srgb, var(--bg-secondary) 80%, transparent);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 2px;
  gap: 2px;
}

.sourceBtn {
  border: none !important;
  border-radius: calc(var(--radius-md) - 2px);
  padding: 3px 8px;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.sourceBtn.isOn {
  color: var(--text-primary);
  background: var(--bg-elevated);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}
```

### 4.3 TerminalCard 终端聚焦与遮罩过渡
优化 `TerminalCard.module.css` 中的输入行（`.inputRow`）与聚焦状态：
- 增加终端底边缘淡出退晕。
- 为焦态输入行加入带有呼吸感的分隔线高亮：

```css
.inputRow {
  transition: border-color var(--transition-fast);
}

.inputRow:focus-within {
  border-top-color: color-mix(in srgb, var(--border-color) 70%, var(--text-primary) 30%);
}
```

---

## 五、 全局侧栏、顶栏与控制面板细节清理

### 5.1 WorkspaceChromeBars 消除黑夜白线 Flash
清洗 `WorkspaceChromeBars.module.css` 第 80 行硬编码 `#f3f3f3` 假边框，替换为主题安全的语义 Token：

```css
.wsChromeRowSessions::after {
  content: '';
  position: absolute; left: 0; right: 0; bottom: 0; height: 1px;
  background: var(--hairline, var(--border-subtle));
  pointer-events: none;
}
```

### 5.2 Sidebar 恢复雅致分隔边框与热区脉冲光
在 `Sidebar.module.css` 中恢复右侧物理 1px 发丝边框，并改进调整尺寸拖拽轴线（`.sidebarResizer`）：

```css
.sidebar {
  border-right: 1px solid var(--hairline);
}

.sidebarResizer::after {
  content: '';
  position: absolute; left: 50%; top: 0; bottom: 0; width: 1px;
  transform: translateX(-50%);
  background: var(--border-color);
  opacity: 0.2;
  transition: opacity var(--transition-fast), box-shadow var(--transition-fast);
}

.sidebarResizer:hover::after,
:global(.is-resizing) .sidebarResizer::after {
  opacity: 0.85;
  box-shadow: 0 0 4px color-mix(in srgb, var(--text-primary) 20%, transparent);
}
```

### 5.3 OverviewCard WCAG 对比度修复与 Hover 高亮
重构 `OverviewCard.module.css`：
1. 修理 `.emptyQuiet` 的透明度叠加瑕疵（移除 `opacity: 0.75`），确保深色背景下文本对比度超过 4.5:1。
2. 为可折叠 Header（`.secH`）增加圆角 Hover 快照色块：

```css
.emptyQuiet {
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
  padding: 2px 2px 4px;
}

.secH {
  border-radius: var(--radius-sm);
  padding: 4px 6px;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.secH:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
```

### 5.4 AgentCard 全局淘汰 display: none 换用 CSS 容器查询
在 `AgentCard.module.css` 中移除第 83/125 行全局硬隐藏，引入 Container Query：

```css
.agentCard {
  container-type: inline-size;
  container-name: agent-card-shell;
}

@container agent-card-shell (max-width: 210px) {
  .agentCardMode,
  .agentCardSummary {
    display: none;
  }
}

@container agent-card-shell (min-width: 211px) {
  .agentCardMode {
    display: inline-flex;
    opacity: 0.75;
    font-size: var(--font-size-xxs);
  }
}
```

---

## 六、 快捷键弹窗、模态框与微交互力学

### 6.1 CheatsheetModal 触感物理键帽 (Tactile Keycaps)
重构 `CheatsheetModal.module.css` 中的快捷键 Pill（`.cheatsheetKey`）：

```css
.cheatsheetKey {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: var(--font-size-xs, 12px);
  font-weight: 500;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--bg-primary) 70%, var(--bg-elevated) 30%);
  border: 1px solid var(--border-color);
  border-bottom: 2px solid var(--hairline-strong, var(--border-color));
  border-radius: var(--radius-sm, 4px);
  padding: 2px 6px;
  line-height: 1;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}
```

### 6.2 模态框 14% 通透上下文遮罩
优化 `.cheatsheetOverlay` 和全站 Modal 背景遮罩：

```css
.cheatsheetOverlay {
  background: color-mix(in srgb, var(--text-primary) 14%, transparent);
  backdrop-filter: blur(8px);
}
```

### 6.3 物理弹簧微动效 (Spring Physics Easing)
统一在 `tokens.css` 中规范弹簧缓动曲线（Zero-Jank Spring Curves）：

```css
:root {
  --transition-spring-layout: cubic-bezier(0.16, 1, 0.3, 1) 220ms;
  --transition-micro: 120ms cubic-bezier(0.16, 1, 0.3, 1);
  --transition-fast: 180ms cubic-bezier(0.16, 1, 0.3, 1);
  --transition-smooth: 280ms cubic-bezier(0.16, 1, 0.3, 1);
}
```

---

## 七、 模块化全量代码 Patch 实施清单 (Full Source Code Specifications)

在本阶段中，以下给出了 13 个模块文件完整的 CSS 规则实现代码，开发时可直接替换或追加覆盖到相应文件中：

### Patch A: `apps/crish-desktop/src/styles/tokens.css` & `theme-dark.css`

```css
/* tokens.css 优化补充 */
:root {
  --transition-spring-layout: cubic-bezier(0.16, 1, 0.3, 1) 220ms;
  --transition-micro: 120ms cubic-bezier(0.16, 1, 0.3, 1);
  --transition-fast: 180ms cubic-bezier(0.16, 1, 0.3, 1);
  --transition-smooth: 280ms cubic-bezier(0.16, 1, 0.3, 1);
}

html[data-theme="dark"] {
  --bg-primary: hsl(218, 14%, 6.5%);
  --bg-secondary: hsl(218, 12%, 9.5%);
  --bg-tertiary: hsl(218, 10%, 12.5%);
  --bg-card: hsl(218, 10%, 12.5%);
  --bg-elevated: hsl(218, 10%, 16.0%);
  --bg-hover: color-mix(in srgb, var(--text-primary) 4%, transparent);
  --bg-active: color-mix(in srgb, var(--text-primary) 7.5%, transparent);

  --border-color: hsl(218, 10%, 18.5%);
  --border-subtle: hsl(218, 8%, 14.5%);

  --hairline-width: 1px;
  --hairline: var(--border-subtle);
  --hairline-strong: var(--border-color);
}

/* theme-dark.css 优化补充 */
:where(html[data-theme="dark"]) [data-panel="card"],
:where(html[data-theme="dark"]) .ui-card-elevated {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.02) 0%, rgba(0, 0, 0, 0.08) 100%), var(--bg-card);
  border: 1px solid color-mix(in srgb, var(--border-color) 80%, transparent);
  box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.04), var(--shadow-sm);
}

:where(html[data-theme="dark"]) {
  --md-code-bg: color-mix(in srgb, var(--bg-secondary) 85%, var(--text-primary) 15%);
  --md-code-border: var(--border-subtle);
  --md-code-fg: #e6e6e6;
}

:where(html[data-theme="dark"]) .msg-assistant-text code,
:where(html[data-theme="dark"]) .md-rendered .md-inline-code {
  background: color-mix(in srgb, var(--bg-elevated) 70%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 60%, transparent);
  border-radius: var(--radius-xs);
  padding: 1px 5px;
}
```

### Patch B: `apps/crish-desktop/src/components/ChatComposer.module.css`

```css
.container {
  --composer-line-height: 1.45;
  --composer-min-lines: 2;
  --composer-max-lines: 10;
  --composer-shell-bg: var(--composer-bg);
  --composer-shell-bg-focus: var(--composer-bg);
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: center;
  background: var(--composer-shell-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xl);
  padding: 8px 12px;
  gap: var(--space-2);
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  box-shadow: none;
  color: var(--text-primary);
  box-sizing: border-box;
}

.container:focus-within {
  background: var(--composer-shell-bg-focus);
  border-color: color-mix(in srgb, var(--border-color) 85%, var(--text-primary) 15%) !important;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--text-primary) 5%, transparent) !important;
  outline: none;
}

.attachChip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1_5);
  max-width: 220px;
  padding: 3px 8px;
  border-radius: var(--radius-md);
  border: 1px solid var(--hairline-strong, var(--border-color));
  background: var(--bg-secondary);
  font-size: var(--font-size-micro);
  color: var(--text-secondary);
}
```

### Patch C: `apps/crish-desktop/src/components/ChatToolCallBlock.module.css`

```css
.toolRowHead {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  border: none !important;
  background: transparent;
  padding: 3px 6px;
  border-radius: var(--radius-md);
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  color: var(--text-secondary);
  min-height: 26px;
  height: auto;
  box-sizing: border-box;
  box-shadow: none !important;
  flex-shrink: 0;
  transition: background var(--transition-micro), color var(--transition-micro);
}

.toolRowHead:hover {
  background: color-mix(in srgb, var(--text-primary) 4%, transparent);
  color: var(--text-secondary);
}

.toolRowChevronSlot {
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: auto;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  color: var(--text-tertiary);
  opacity: 0.3;
  pointer-events: none;
  transition: opacity var(--transition-micro);
}

.toolRowHead:hover .toolRowChevronSlot {
  opacity: 0.75;
}
```

### Patch D: `apps/crish-desktop/src/components/ApprovalAskCard.module.css`

```css
.approvalCard {
  margin: 6px 0 8px;
  padding: 10px 12px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
  border-left: 2px solid var(--color-warning, var(--accent-orange));
  background: color-mix(in srgb, var(--bg-card) 98%, var(--accent-orange) 2%);
  display: flex;
  flex-direction: column;
  gap: var(--space-1_5);
  max-width: 100%;
  box-sizing: border-box;
  color: var(--text-primary);
}

.approvalCard[data-risk-level="critical"],
.approvalCard[data-risk-level="high"] {
  border-left-color: var(--color-error, var(--accent-red));
  background: color-mix(in srgb, var(--bg-card) 97%, var(--accent-red) 3%);
}

.approvalCard[data-risk-level="medium"] {
  border-left-color: var(--color-warning, var(--accent-orange));
  background: color-mix(in srgb, var(--bg-card) 98%, var(--accent-orange) 2%);
}

.approvalCard[data-risk-level="low"] {
  border-left-color: var(--color-success, var(--accent-green));
  background: color-mix(in srgb, var(--bg-card) 98%, var(--accent-green) 2%);
}

.approvalCardChip {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 2px 8px;
  border-radius: var(--radius-md);
  border: 1px solid var(--hairline, var(--border-subtle));
  font-size: var(--font-size-xxs, 11px);
  font-family: var(--font-mono, ui-monospace, monospace);
  line-height: var(--line-height-base);
  color: var(--text-tertiary);
  background: transparent;
}

.approvalCardChipWarn {
  color: var(--color-warning, var(--accent-orange));
  border-color: color-mix(in srgb, var(--color-warning, var(--accent-orange)) 35%, var(--hairline, var(--border-subtle)));
}

.approvalCardChipDanger {
  color: var(--color-error, var(--accent-red));
  border-color: color-mix(in srgb, var(--color-error, var(--accent-red)) 35%, var(--hairline, var(--border-subtle)));
}
```

### Patch E: `apps/crish-desktop/src/components/OverviewCard.module.css`

```css
.emptyQuiet {
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
  padding: 2px 2px 4px;
  margin: 0;
}

.secH {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-1_5);
  border: none;
  background: transparent;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  min-height: var(--control-height-sm, 28px);
  font-family: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  box-sizing: border-box;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.secH:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
```

### Patch F: `apps/crish-desktop/src/components/AgentCard.module.css`

```css
.agentCard {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--shell-inset-bg, var(--bg-primary));
  color: var(--text-primary);
  container-type: inline-size;
  container-name: agent-card-shell;
}

@container agent-card-shell (max-width: 210px) {
  .agentCardMode,
  .agentCardSummary {
    display: none;
  }
}

@container agent-card-shell (min-width: 211px) {
  .agentCardMode {
    display: inline-flex;
    opacity: 0.75;
    font-size: var(--font-size-xxs);
  }
}
```

### Patch G: `apps/crish-desktop/src/components/Sidebar.module.css`

```css
.sidebar {
  width: var(--sidebar-width);
  background-color: var(--bg-secondary);
  border-right: 1px solid var(--hairline);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  flex-shrink: 0;
  transition: width var(--transition-spring-layout);
  z-index: var(--z-sidebar);
  position: relative;
  overflow: hidden;
  height: 100%;
}

.sidebarResizer::after {
  content: '';
  position: absolute;
  left: 50%; top: 0; bottom: 0; width: 1px;
  transform: translateX(-50%);
  background: var(--border-color);
  opacity: 0.2;
  transition: opacity var(--transition-fast), box-shadow var(--transition-fast);
  pointer-events: none;
}

.sidebarResizer:hover::after,
:global(.is-resizing) .sidebarResizer::after {
  opacity: 0.85;
  box-shadow: 0 0 4px color-mix(in srgb, var(--text-primary) 20%, transparent);
}
```

### Patch H: `apps/crish-desktop/src/components/TerminalCard.module.css`

```css
.line.isErr {
  color: var(--terminal-err, var(--color-error, #f87171));
}

.inputRow {
  display: flex;
  align-items: center;
  gap: var(--panel-gap, 8px);
  padding: var(--card-header-pad-y, 4px) var(--panel-pad-x, 12px) var(--panel-pad-y, 10px);
  border-top: var(--hairline-width, 1px) solid var(--terminal-border, var(--hairline, var(--border-subtle)));
  flex-shrink: 0;
  min-width: 0;
  min-height: var(--control-height, 32px);
  box-sizing: border-box;
  transition: border-color var(--transition-fast);
}

.inputRow:focus-within {
  border-top-color: color-mix(in srgb, var(--border-color) 70%, var(--text-primary) 30%);
}
```

### Patch I: `apps/crish-desktop/src/components/CheatsheetModal.module.css`

```css
.cheatsheetOverlay {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--text-primary) 14%, transparent);
  backdrop-filter: blur(8px);
  z-index: var(--z-cheatsheet);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
}

.cheatsheetKey {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: var(--font-size-xs, 12px);
  font-weight: 500;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--bg-primary) 70%, var(--bg-elevated) 30%);
  border: 1px solid var(--border-color);
  border-bottom: 2px solid var(--hairline-strong, var(--border-color));
  border-radius: var(--radius-sm, 4px);
  padding: 2px 6px;
  line-height: 1;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}
```

### Patch J: `apps/crish-desktop/src/components/ChatMessageList.module.css`

```css
.pinnedBar {
  position: sticky;
  top: 0;
  z-index: var(--z-pinned-bar);
  width: 100%;
  max-width: min(var(--chat-col-max, 760px), 100%);
  border: var(--hairline-width, 1px) solid var(--hairline, var(--border-subtle, var(--border-color)));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg-primary) 92%, transparent);
  box-shadow: none;
  backdrop-filter: blur(12px);
}
```

### Patch K: `apps/crish-desktop/src/components/ChatStatusRibbons.module.css`

```css
.chatSoftHint {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 6px;
  padding: 5px 10px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg-secondary) 60%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 60%, transparent);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-base);
  box-sizing: border-box;
  width: 100%;
  max-width: min(var(--chat-col-max, 760px), 100%);
  box-shadow: none;
}

.chatSoftHintAction {
  border: none;
  background: color-mix(in srgb, var(--text-primary) 6%, transparent);
  color: var(--text-primary);
  font-weight: var(--font-weight-normal);
  font-size: var(--font-size-xs);
  cursor: pointer;
  text-decoration: none;
  padding: 2px 8px;
  border-radius: var(--radius-xs);
  font-family: inherit;
  flex-shrink: 0;
  transition: background var(--transition-fast);
}

.chatSoftHintAction:hover {
  color: var(--text-primary);
  text-decoration: none;
  background: color-mix(in srgb, var(--text-primary) 12%, transparent);
}
```

### Patch L: `apps/crish-desktop/src/components/WorkspaceChromeBars.module.css`

```css
.wsChromeRowSessions::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: var(--hairline, var(--border-subtle));
  pointer-events: none;
  z-index: var(--z-base);
}
```

### Patch M: `apps/crish-desktop/src/components/DiffCard.module.css`

```css
.sourceSeg {
  display: inline-flex;
  align-items: center;
  background: color-mix(in srgb, var(--bg-secondary) 80%, transparent);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 2px;
  gap: 2px;
  flex-shrink: 0;
}

.sourceBtn {
  appearance: none;
  border: none !important;
  background: transparent;
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
  font-family: inherit;
  font-weight: var(--font-weight-medium, 500);
  padding: 3px 8px;
  border-radius: calc(var(--radius-md) - 2px);
  cursor: pointer;
  line-height: var(--line-height-dense);
  white-space: nowrap;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.sourceBtn + .sourceBtn {
  border-left: none;
}

.sourceBtn:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.sourceBtn.isOn {
  color: var(--text-primary);
  background: var(--bg-elevated);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}
```

---

## 八、 验证与质量交付标准

改动完成后，须逐项执行以下质量验证验收：

1. **暗色美学与光影一致性**：
   - 在暗色模式下，背景呈沉稳蓝墨黑（`hsl(218, 14%, 6.5%)`），绝无单纯 `#000000` 死黑。
   - 所有卡片容器能清晰肉眼感知 1px 雅致发丝线条与 3D 光影 Elevation。
2. **文本与控件 Ergonomics 可读性**：
   - 快捷键呈物理按压 Font Mono 格式，无偏心或过窄现象。
   - 所有灰度元文本（包含 `.emptyQuiet` 与 `.toolbarMeta`）在暗色下满足 WCAG 2.1 4.5:1 对比度标准。
3. **窄屏容器自适应能力**：
   - 拖拽侧栏至 200px 宽度时，`AgentCard` 能平滑隐去辅助标签而无横向 Overflow 滚动条溢出。
4. **流动动效与交互稳定性**：
   - 展开 Tool Call、提示 Banner hover 以及 Resizer 拖拽轴线时，动画平滑流利，无任何垂直抖动（No `translateY` jumps）。

---

> **结语**：本改进方案涵盖了前几轮检查的每一个视觉与 UX 细节，杜绝任何割裂与遗留。文件现已放置于项目根目录 `CRISH_UI_SYSTEMIC_OVERHAUL_MASTER_PLAN.md`。我们可以立即开始按照此 Master Plan 实施代码级别的改动！
