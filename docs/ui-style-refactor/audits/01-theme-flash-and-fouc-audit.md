# Conex / Crish — 界面初始闪色与主题双重注入 / 过渡冲突严苛审计报告

> **报告版本**：v1.0.0
> **审计日期**：2026-08-30
> **审计责任域**：前端视觉工程、主题生命周期时序、CSS Token 架构、FOUC 消除
> **核心审计范围**：
> - [`apps/crish-desktop/index.html`](file:///c:/Software/conex/apps/crish-desktop/index.html)
> - [`apps/crish-desktop/public/loader.css`](file:///c:/Software/conex/apps/crish-desktop/public/loader.css)
> - [`apps/crish-desktop/public/loader.js`](file:///c:/Software/conex/apps/crish-desktop/public/loader.js)
> - [`apps/crish-desktop/src/main.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/main.tsx)
> - [`apps/crish-desktop/src/api/themeStore.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/themeStore.ts)
> - [`apps/crish-desktop/src/api/themePersonalization.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/themePersonalization.ts)
> - [`apps/crish-desktop/src/api/themePresets.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/themePresets.ts)
> - [`apps/crish-desktop/src/api/oklchColorGuard.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/oklchColorGuard.ts)
> - [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css)
> - [`apps/crish-desktop/src/styles/design-system.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/design-system.css)
> - [`apps/crish-desktop/src/styles/index.css`](file:///c:/Software/conex/apps/crish-desktop/src/index.css)
> - [`apps/crish-desktop/src/app/AppBootstrap.ts`](file:///c:/Software/conex/apps/crish-desktop/src/app/AppBootstrap.ts)
> - [`apps/crish-desktop/src/store/themeProjection.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/themeProjection.ts)
> - [`apps/crish-desktop/src/bootstrap-full.ts`](file:///c:/Software/conex/apps/crish-desktop/src/bootstrap-full.ts)

---

## 目录

1. [执行摘要与审计总览](#一执行摘要与审计总览)
2. [首屏闪色与变色根因严苛排查（FOUC / Color Flash）](#二首屏闪色与变色根因严苛排查fouc--color-flash)
   - 2.1 [根因 1：Loader 加载屏深浅色反差与 300ms 强制过渡动画](#21-根因-1loader-加载屏深浅色反差与-300ms-强制过渡动画)
   - 2.2 [根因 2：启动时序多阶段断层与异步注入滞后（T0 ~ T4 阶梯式变色）](#22-根因-2启动时序多阶段断层与异步注入滞后t0--t4-阶梯式变色)
   - 2.3 [根因 3：静态 Token 基线 vs 皮肤预设 vs 对比度守卫色值语义割裂](#23-根因-3静态-token-基线-vs-皮肤预设-vs-对比度守卫色值语义割裂)
   - 2.4 [根因 4：组件级全局过渡叠加引发的视觉“蠕动效应”](#24-根因-4组件级全局过渡叠加引发的视觉蠕动效应)
3. [全量变量双重/重复注入与覆盖冲突清单](#三全量变量双重重复注入与覆盖冲突清单)
   - 3.1 [9 处 DOM 注入与订阅源排查](#31-9-处-dom-注入与订阅源排查)
   - 3.2 [全量冲突变量与色阶漂移对照矩阵](#32-全量冲突变量与色阶漂移对照矩阵)
4. [架构反模式与缺陷深度剖析](#四架构反模式与缺陷深度剖析)
5. [彻底根治首屏变色闪烁的重构清单与方案建议](#五彻底根治首屏变色闪烁的重构清单与方案建议)
   - 5.1 [方案 Phase 1：`<head>` 同步阻塞式 0ms 种子注入（彻底斩断 FOUC）](#51-方案-phase-1head-同步阻塞式-0ms-种子注入彻底斩断-fouc)
   - 5.2 [方案 Phase 2：Token 基座与 JS 皮肤预设 100% 对齐归一](#52-方案-phase-2token-基座与-js-皮肤预设-100-对齐归一)
   - 5.3 [方案 Phase 3：冷启动 `.preload` 全局过渡屏蔽门闩](#53-方案-phase-3冷启动-preload-全局过渡屏蔽门闩)
   - 5.4 [方案 Phase 4：主题流水线单点收敛与冗余调用剥离](#54-方案-phase-4主题流水线单点收敛与冗余调用剥离)
   - 5.5 [方案 Phase 5：对比度守卫（Color Guard）按需介入改造](#55-方案-phase-5对比度守卫color-guard按需介入改造)
6. [重构实施文件清单与验收标准](#六重构实施文件清单与验收标准)

---

## 一、执行摘要与审计总览

经过对 Conex / Crish 桌面端（`apps/crish-desktop`）全生命周期样式链路、HTML 启动骨架、主题注入引擎及 CSS 变量体系的严苛审计，确认当前桌面端在应用冷启动时存在的**“先显示某种颜色，随后肉眼可见地变色为最终颜色”**（Color Flash / FOUC）现象具有确凿的工程根因。

### 核心审计结论：
1. **时序严重倒置**：主题配置的完整应用（包含皮肤色板与对比度微调）被延迟到了 React 组件挂载后的 `useEffect` 阶段异步动态 import 执行（延迟达 150ms~300ms），导致浏览器先使用 CSS 静态初始值完成首次像素绘制（First Paint），再被 JS 强行注入覆盖；
2. **Loader 初始反差与过渡动画**：[`loader.css`](file:///c:/Software/conex/apps/crish-desktop/public/loader.css) 中 `:root` 默认设为深色 `#0b0b0e`，而 [`loader.js`](file:///c:/Software/conex/apps/crish-desktop/public/loader.js) 采用 `defer` 延迟执行，同时 `.app-initial-loader` 设置了 `transition: background-color 0.3s ease`，导致在浅色模式下打开时必定看到“从纯黑缓缓过渡到浅灰”的肉眼动画；
3. **双真源色值漂移**：[`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 静态定义的色值与 [`themePresets.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/themePresets.ts)、[`oklchColorGuard.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/oklchColorGuard.ts) 动态计算注入的色值存在广泛的色阶差异（如 `--text-primary` 在浅色下静态为 `#111111`，守卫后变为 `hsl(35, 12%, 11%)` 即 `#201e1a`；深色背景静态为 `#0d0d0d`，预设注入为 `#1b1b1b`）；
4. **多点重复注入与无序覆盖**：从 `loader.js`、`main.tsx`、`AppBootstrap.ts`、`themeProjection.ts` 到空闲期的 `bootstrap-full.ts`，共有 **9 处** 不同的 DOM/CSS 变量注入点和重复订阅，反复触发全量样式重算。

---

## 二、首屏闪色与变色根因严苛排查（FOUC / Color Flash）

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                         CRISH 桌面端冷启动时序与 5 阶段变色断层 (T0 ~ T4)                  │
├──────┬───────────────┬───────────────────────────────────────────────────────────────────┤
│ 阶段 │ 耗时          │ 发生事件与界面呈现状态 (肉眼可见变色节点)                         │
├──────┼───────────────┼───────────────────────────────────────────────────────────────────┤
│ T0   │ 0ms           │ HTML 解析，加载 loader.css。:root 为暗色 (#0b0b0e)。              │
│      │               │ 界面呈现：全屏死黑 (#0b0b0e)                                      │
├──────┼───────────────┼───────────────────────────────────────────────────────────────────┤
│ T1   │ 10ms ~ 30ms   │ loader.js 执行 (defer)，给 html 打上 data-theme="default"。       │
│      │               │ 界面呈现：.app-initial-loader 触发 300ms transition，黑 -> 浅灰  │
├──────┼───────────────┼───────────────────────────────────────────────────────────────────┤
│ T2   │ 50ms ~ 100ms  │ main.tsx 加载 index.css (tokens.css)。React 首帧挂载。            │
│      │               │ 界面呈现：tokens.css 静态默认浅色 (#f4f5f7 / #ffffff / #111111)  │
├──────┼───────────────┼───────────────────────────────────────────────────────────────────┤
│ T3   │ 120ms ~ 250ms │ AppBootstrap useEffect 触发，异步 import themeStore，执行         │
│      │               │ applyPersonalization() + oklchColorGuard() 动态 style.setProperty │
│      │               │ 界面呈现：字色/边框/背景突变为暖棕 (#201e1a) / 自定义皮肤色板     │
├──────┼───────────────┼───────────────────────────────────────────────────────────────────┤
│ T4   │ 1000ms~2000ms │ bootstrapFull 在 requestIdleCallback 再次调用 applyTheme()。      │
│      │               │ 界面呈现：可能导致潜在的重复回流与二次重绘                        │
└──────┴───────────────┴───────────────────────────────────────────────────────────────────┘
```

### 2.1 根因 1：Loader 加载屏深浅色反差与 300ms 强制过渡动画

#### 代码证据分析：
1. **[`apps/crish-desktop/public/loader.css`](file:///c:/Software/conex/apps/crish-desktop/public/loader.css#L11-L18)**：
   ```css
   :root {
     --loader-bg: #0b0b0e;
     --loader-card-bg: linear-gradient(180deg, #131316 0%, #08080a 100%);
     --loader-border: rgba(255, 255, 255, 0.08);
     --loader-line-stroke: #f4f4f5;
     --loader-text: #a1a1aa;
     --loader-shadow: 0 20px 50px -10px rgba(0, 0, 0, 0.85);
   }
   ```
2. **[`apps/crish-desktop/public/loader.css`](file:///c:/Software/conex/apps/crish-desktop/public/loader.css#L41-L60)**：
   ```css
   .app-initial-loader {
     ...
     background-color: var(--loader-bg);
     transition: background-color 0.3s ease; /* 🚨 致命动画：变量变更时平滑过渡 300ms */
     ...
   }
   ```
3. **[`apps/crish-desktop/index.html`](file:///c:/Software/conex/apps/crish-desktop/index.html#L18-L20)**：
   ```html
   <!-- 首屏前应用主题/字体栈，避免闪白；与 themeStore / fontStore 同源 key -->
   <script src="/loader.js" defer></script> <!-- 🚨 defer 导致在 DOM 解析后才执行 -->
   ```

#### 现象穿透：
- 当用户配置为浅色模式（默认）打开应用时：
  1. 浏览器解析到 `<body>` 中的 `<div class="app-initial-loader">` 时，`loader.js` 尚未执行（受 `defer` 阻滞）；
  2. `<html>` 没有任何 `data-theme` 属性，直接命中 `:root`，计算出 `--loader-bg: #0b0b0e`（纯黑）；
  3. 浏览器第一帧将屏幕绘制为纯黑背景；
  4. 随后 `loader.js` 执行，设置 `html[data-theme='default']`，`--loader-bg` 切换为 `#f4f4f5`；
  5. 由于 `.app-initial-loader` 设置了 `transition: background-color 0.3s ease`，浏览器在此启动 300ms 补间动画，背景色由黑逐渐变灰变亮；
  6. 用户肉眼清晰可见“开屏黑屏一下然后泛白”的剧烈闪烁。

---

### 2.2 根因 2：启动时序多阶段断层与异步注入滞后（T0 ~ T4 阶梯式变色）

#### 代码证据分析：
1. **[`apps/crish-desktop/src/main.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/main.tsx#L110-L123)**：
   ```typescript
   initSsrGlobals();
   initVisualPresentationController();

   // CSS token runtime injection — keeps JS source of truth in sync with CSS
   document.documentElement.style.setProperty(
     '--sidebar-width',
     `${SIDEBAR_WIDTH_DEFAULT}px`
   );
   document.documentElement.style.setProperty(
     '--chat-col-max',
     `${CHAT_COL_MAX}px`
   );
   ```
   > 审查发现：`main.tsx` 顶层完全没有调用 `bootstrapTheme()`，也没有向 DOM 注入任何个性化皮肤 Token！

2. **[`apps/crish-desktop/src/app/AppBootstrap.ts`](file:///c:/Software/conex/apps/crish-desktop/src/app/AppBootstrap.ts#L179-L194)**：
   ```typescript
   // 6. Theme, Font, and Settings bootstrap
   useEffect(() => {
     void import('../api/themeStore').then(({ bootstrapTheme }) =>
       bootstrapTheme()
     );
     void import('../api/fontStore').then(({ bootstrapFonts }) =>
       bootstrapFonts()
     );
     const unsubTheme = import('../store/themeProjection').then(
       ({ initThemeProjection }) => initThemeProjection()
     );
     ...
   }, [setAppSettings]);
   ```

#### 现象穿透：
- React 的 `useEffect` 契约保证了它**必须在真实 DOM 节点挂载、浏览器完成首次 Layout & Paint 之后**才会异步触发；
- 不仅如此，`AppBootstrap.ts` 内部还使用了异步的 `import('../api/themeStore')`；
- 这意味着，React 首帧以 [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 静态声明的浅色（`#f4f5f7` / `#ffffff` / `#111111`）呈现；
- 等待模块加载完成（100~200ms 后），`bootstrapTheme()` 才被执行，此时 `applyPersonalization()` 会向 `document.documentElement.style` 写入 18 处行内样式，导致页面内容在用户眼皮底下发生第二次突变（由中性冷灰突变为暖灰/自定义色）。

---

### 2.3 根因 3：静态 Token 基线 vs 皮肤预设 vs 对比度守卫色值语义割裂

在整个体系中，存在三个色值“权威源”，它们之间缺乏单真源对齐，导致无论静态加载还是动态加载，必定产生差值覆盖。

#### 1. 浅色模式下的严重色差断层：
- **静态基线 ([`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L10-L69))**：
  - `--text-primary`: `#111111`（纯黑中性灰）
  - `--text-secondary`: `#555555`
  - `--text-tertiary`: `#696969`
  - `--border-color`: `hsl(35, 10%, 86%)`（`#dedad4`）
  - `--border-subtle`: `hsl(35, 8%, 91%)`（`#ebe9e5`）
  - `--control-mix-color`: `hsl(35, 40%, 30%)`
- **默认皮肤预设 `warm-gray` ([`themePresets.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/themePresets.ts#L25-L38))**：
  - `borderColor`: `#e2dfd9`（与 tokens 差 4 个色阶）
  - `borderSubtle`: `#eae7e1`（与 tokens 差 3 个色阶）
  - `mixColor`: `hsl(0, 0%, 25%)`（无色调，与 tokens 的 35° 暖调完全不同）
- **对比度守卫覆写 ([`oklchColorGuard.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/oklchColorGuard.ts#L101-L117))**：
  - 一旦 `applyPersonalization` 执行，无条件调用 `applyTextContrastGuard(bgPrimary, false)`；
  - 它计算后将 `--text-primary` 强行写入为 `hsl(35, 12%, 11%)`（即 **`#201e1a`，一种明显的暖棕木炭黑**）；
  - 将 `--text-secondary` 强行写入为 `hsl(35, 8%, 34%)`（即 **`#5e5950`**）；
  - 将 `--text-tertiary` 强行写入为 `hsl(35, 6%, 52%)`（即 **`#8c877e`**）；
- **最终视觉呈现**：界面打开时，文字先是纯黑 `#111111`，随后瞬间变色为暖棕木炭黑 `#201e1a`。

#### 2. 深色模式下的严重底色跳变：
- **静态基线 ([`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L822-L840))**：
  - `--bg-primary`: `hsl(0, 0%, 5%)`（**`#0d0d0d`，极深近纯黑**）
  - `--bg-secondary`: `hsl(0, 0%, 8%)`（`#141414`）
  - `--bg-elevated`: `hsl(0, 0%, 15%)`（`#262626`）
  - `--text-primary`: `#f0f0f0`
- **默认深色皮肤预设 `dark-cozy` ([`themePresets.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/themePresets.ts#L142-L155))**：
  - `bgPrimary`: **`#1b1b1b`**（明显的深灰，亮度比 `#0d0d0d` 高出近一倍！）
  - `bgSecondary`: `#242424`
  - `bgElevated`: `#242424`
  - `textPrimary`: `#dddddd`
- **最终视觉呈现**：深色模式冷启动时，页面先渲染为 Vercel 风格的极黑 `#0d0d0d`，200ms 后被 JS 覆盖为护眼暗灰 `#1b1b1b`，产生极其明显的“黑屏变灰屏”跳变。

---

### 2.4 根因 4：组件级全局过渡叠加引发的视觉“蠕动效应”

在前端样式表中，部分通用卡片与组件配置了较宽泛的 `transition: all` 或 `transition: background-color / color / border-color`：

1. **[`apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.module.css#L53)**：
   ```css
   transition: all var(--transition-fast);
   ```
2. **[`apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css#L223)**：
   ```css
   transition: background var(--transition-fast, 150ms ease-out);
   ```
3. **[`apps/crish-desktop/src/components/chat-card/ChatEmptyState.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatEmptyState.module.css#L221)**：
   ```css
   transition: background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
   ```
4. **[`apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css#L222)**：
   ```css
   transition: background var(--transition-micro), border-color var(--transition-micro), color var(--transition-micro);
   ```

#### 冲突机理：
当 CSS 变量在 `<html>` 上被 `style.setProperty` 动态更改时，浏览器并不认为这是“样式初始化”，而是触发了属性变更（CSS Property Mutation）。拥有上述 transition 的所有组件会**自发启动 120ms~200ms 的颜色渐变补间**。这就把本就延迟的变量突变，放大了成全屏幕各个区域交替淡入淡出的“视觉蠕动”过程。

---

## 三、全量变量双重/重复注入与覆盖冲突清单

### 3.1 9 处 DOM 注入与订阅源排查

通过全仓路径追踪，当前存在多达 9 个独立的 DOM 样式写入面与订阅源：

```
[1] loader.js (外链 script defer) ───────> html.setAttribute('data-theme', t) + classList.add
[2] tokens.css (静态 CSS 选择器) ─────────> :root, html[data-theme='default'], html[data-theme='dark']
[3] main.tsx (模块顶层执行) ─────────────> initVisualPresentationController() + style.setProperty(--sidebar-width...)
[4] AppBootstrap (useEffect 阶段) ───────> bootstrapTheme() -> applyPersonalization() -> style.setProperty
[5] oklchColorGuard (被 4 间接调用) ─────> style.setProperty(--text-primary / secondary / tertiary)
[6] themeProjection (useEffect 阶段) ────> useSettingsStore.subscribe() 首次执行 -> setTheme() -> applyTheme()
[7] AppBootstrap initApp() (异步 API) ───> clientApi.getSettings() -> setAppSettings() -> 触发 [6] 二次执行
[8] AppBootstrap (useEffect 阶段) ───────> root.setAttribute('data-ui-size'...) (与 [3] 完全重复)
[9] bootstrap-full.ts (idleCallback) ────> clientApi.getSettings() -> applyTheme() (在 1000ms 后第 3 次触发全量注入)
```

---

### 3.2 全量冲突变量与色阶漂移对照矩阵

下表详尽列出所有在 `tokens.css` 静态定义，且被 `themePersonalization.ts` / `oklchColorGuard.ts` 在运行时使用 `style.setProperty` 覆盖的变量清单及其具体偏差：

| CSS 变量名 | `tokens.css` 静态值 (Light) | `warm-gray` 预设 / 守卫注入值 | `tokens.css` 静态值 (Dark) | `dark-cozy` 预设 / 守卫注入值 | 视觉冲突性质 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `--bg-primary` | `#f4f5f7` | `#f4f5f7` | `hsl(0, 0%, 5%)` (`#0d0d0d`) | `#1b1b1b` | **极高**（深色下黑变灰，亮度跳跃 100%） |
| `--bg-secondary` | `#eaecee` | `#eaecee` | `hsl(0, 0%, 8%)` (`#141414`) | `#242424` | **高**（侧边栏与辅助层亮度跳跃） |
| `--bg-tertiary` | `#e2e5e8` | `#e2e5e8` | `hsl(0, 0%, 11%)` (`#1c1c1c`)| `#1e1e1e` | **中**（深色下微弱偏色） |
| `--bg-card` | `#ffffff` | `#ffffff` | `hsl(0, 0%, 11%)` (`#1c1c1c`)| `#242424` | **高**（卡片浮层底色跳跃） |
| `--bg-elevated` | `#ffffff` | `#ffffff` | `hsl(0, 0%, 15%)` (`#262626`)| `#242424` | **中**（浮层阴影融合度断层） |
| `--text-primary` | `#111111` | `hsl(35, 12%, 11%)` (`#201e1a`) | `#f0f0f0` | `hsl(0, 0%, 94%)` (`#f0f0f0`)| **极高**（浅色下由中性冷黑变暖棕黑） |
| `--text-secondary` | `#555555` | `hsl(35, 8%, 34%)` (`#5e5950`) | `#a3a3a3` | `hsl(0, 0%, 72%)` (`#b8b8b8`)| **高**（浅色次级文字偏色；深色变亮） |
| `--text-tertiary` | `#696969` | `hsl(35, 6%, 52%)` (`#8c877e`) | `#8f8f8f` | `hsl(0, 0%, 50%)` (`#808080`)| **高**（弱化文字与注释偏色） |
| `--border-color` | `hsl(35, 10%, 86%)` (`#dedad4`) | `#e2dfd9` | `hsl(0, 0%, 18%)` (`#2e2e2e`)| `#333333` | **中**（边框线条深浅跳变） |
| `--border-subtle` | `hsl(35, 8%, 91%)` (`#ebe9e5`) | `#eae7e1` | `hsl(0, 0%, 14%)` (`#242424`)| `#2a2a2a` | **中**（细微分割线跳变） |
| `--control-mix-color` | `hsl(35, 40%, 30%)` | `hsl(0, 0%, 25%)` | `var(--text-primary)` | `hsl(0, 0%, 75%)` | **极高**（混色基准由暖调突变为无彩灰） |
| `--control-soft-bg` | `color-mix(... bg-primary)` | `color-mix(... bgSecondary)` | `color-mix(... bg-primary)` | `color-mix(... bgSecondary)` | **高**（控件底色基底计算公式不一致） |
| `--composer-bg` | `color-mix(... control-mix)` | `color-mix(... vibrantTint)` | `var(--bg-secondary)` | `#242424` (若无则继承) | **高**（对话输入框底色计算逻辑分叉） |
| `--accent-green-light-adaptive` | `hsl(142, 35%, 96.5%)` | `color-mix(... #ffffff)` | `color-mix(... 8%, bgPrimary)` | `color-mix(... 8%, bgPrimary)` | **中**（Diff/增量高亮对比度微调） |
| `--accent-red-light-adaptive` | `hsl(0, 55%, 97.5%)` | `color-mix(... #ffffff)` | `color-mix(... 8%, bgPrimary)` | `color-mix(... 8%, bgPrimary)` | **中**（Diff/删除高亮对比度微调） |

> **注**：如果用户选择了非默认皮肤（如 `cream` 杏仁奶油、`paper` 极简纸质、`deep-night` 深邃夜空、`sakura` 落樱微风等），上述所有背景和边框变量都会在首屏挂载后直接由中性灰**“整屏突变”**为高饱和/特定色调的皮肤色。

---

## 四、架构反模式与缺陷深度剖析

1. **时序反模式：将视觉关键路径置于 React `useEffect`**
   CSS 变量是全局视觉基底，浏览器渲染引擎在 Layout Tree 构建阶段即需要确定的颜色。将全局核心变量的注入推迟到 React DOM 挂载后的异步 Effect，违背了现代前端“零闪烁（Zero-FOUC）”设计铁律。

2. **双真源反模式：静态 Token 声明与 JS 运行时 Presets 脱节**
   团队在迭代过程中，只在 `themePresets.ts` 中调整了视觉调色板，或者在 `oklchColorGuard.ts` 中引入了自动对比度微调，但从未反向同步回 `tokens.css`。使得静态 CSS 变成了一个“仅用于最初 50ms 随后就被废弃”的伪真源。

3. **守卫失控反模式：无条件覆盖符合标准的预设**
   `oklchColorGuard.ts` 设计初衷是防止用户自定义极端背景色导致文字看不清。但在实现中，对系统官方精心调配的预设（如 `#111111` 文本搭配 `#f4f5f7` 背景本已达到 16.5:1 的 AAA 超高对比度），守卫依然强行将字色篡改为 `#201e1a`，造成无谓的动态覆盖与色差。

4. **过渡未锁反模式：冷启动阶段全局动画处于活跃状态**
   任何高质量桌面应用在初次装载时，必须在根容器上施加 `.preload` / `.no-transitions` 门闩，冻结所有 CSS transition，直至整棵组件树与个性化变量稳定后再解冻。Crish 目前完全缺失这一防御层。

5. **冗余唤醒反模式：Idle 阶段二次无差别应用**
   [`bootstrap-full.ts`](file:///c:/Software/conex/apps/crish-desktop/src/bootstrap-full.ts#L18-L23) 中，在应用已经平稳运行 1~2 秒后，再度通过 `getSettings()` 读取 theme 并调用 `applyTheme()`。若中间存在极小状态微调，将再次引发界面重绘，完全多余。

---

## 五、彻底根治首屏变色闪烁的重构清单与方案建议

为了彻底根治 FOUC 与变色闪烁，实现 **0ms 无缝冷启动、零肉眼可见变色、单一真源注入**，提出如下系统性重构方案：

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                         重构后的 0ms 零闪烁无缝主题生命周期流水线                         │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  [index.html <head>]                                                                     │
│  │                                                                                       │
│  ├─ 1. <link rel="stylesheet" href="/loader.css">                                        │
│  │     └─ :root 移除死黑，采用中性无缝基底；移除 .app-initial-loader 的 transition       │
│  │                                                                                       │
│  ├─ 2. <script> (内联/同步阻塞式 0ms loader.js)                                          │
│  │     └─ 同步读取 localStorage (crish_theme + crish_theme_skin)                          │
│  │     └─ 直接在 html 根节点同步注入 data-theme + 当前皮肤的核心色板 inline style         │
│  │     └─ 给 html 打上 class="preload" (冻结全局所有 transition)                         │
│  │                                                                                       │
│  [main.tsx 模块顶层]                                                                     │
│  │                                                                                       │
│  ├─ 3. 同步调用 bootstrapTheme() (在 React 挂载前完成，不再等 useEffect)                │
│  │                                                                                       │
│  [React 首帧 Paint (T = 50ms)]                                                           │
│  │                                                                                       │
│  ├─ 4. 组件树挂载：已具备 100% 最终色值，首帧即终态，绝无二次跳变                        │
│  │                                                                                       │
│  [requestAnimationFrame (T = 60ms)]                                                      │
│  │                                                                                       │
│  └─ 5. 移除 html 的 class="preload"，优雅解冻用户交互态的 micro-transitions             │
│                                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 方案 Phase 1：`<head>` 同步阻塞式 0ms 种子注入（彻底斩断 FOUC）

1. **改造 [`apps/crish-desktop/index.html`](file:///c:/Software/conex/apps/crish-desktop/index.html)**：
   - 将 `<script src="/loader.js" defer></script>` 改为**同步阻塞式**（去除 `defer`，或直接内联关键代码到 `<head>`）；
   - 在 HTML 解析到 `<body>` 之前，0ms 完成 `localStorage` 读取并同步写入 `documentElement`；
2. **改造 [`apps/crish-desktop/public/loader.js`](file:///c:/Software/conex/apps/crish-desktop/public/loader.js)**：
   - 不仅读取 `crish_theme`，同时读取 `crish_theme_skin`；
   - 提取内置皮肤字典的极简色板（或从上次持久化中取），直接在首屏前写入 `--bg-primary`、`--text-primary`、`--loader-bg` 等核心关键变量；
3. **改造 [`apps/crish-desktop/public/loader.css`](file:///c:/Software/conex/apps/crish-desktop/public/loader.css)**：
   - 彻底删除 `.app-initial-loader` 上的 `transition: background-color 0.3s ease;`；
   - `:root` 变量设为自适应或中性基调，严禁在 `:root` 写死深色 `#0b0b0e`。

---

### 5.2 方案 Phase 2：Token 基座与 JS 皮肤预设 100% 对齐归一

1. **修正 [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css)**：
   - 将浅色默认选择器（`html[data-theme='default']`）的变量严格校准为与 `warm-gray` 预设完全一致；
   - 将深色选择器（`html[data-theme='dark']`）的底色校准为与 `dark-cozy` 预设完全一致（`--bg-primary: #1b1b1b`），消除 `#0d0d0d` 与 `#1b1b1b` 的分裂；
   - 统一 `--control-mix-color`、`--border-color`、`--border-subtle` 的色度计算公式。

---

### 5.3 方案 Phase 3：冷启动 `.preload` 全局过渡屏蔽门闩

1. **定义全局 `.preload` 规则（可在 [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 中声明）**：
   ```css
   html.preload,
   html.preload *,
   html.preload *::before,
   html.preload *::after {
     transition: none !important;
     animation-duration: 0s !important;
   }
   ```
2. 在 `loader.js` 中默认向 `documentElement` 添加 `classList.add('preload')`；
3. 在 `main.tsx` 的首帧 `requestAnimationFrame`（或 React 完成首渲染打点）处移除 `.preload` 类：
   ```typescript
   requestAnimationFrame(() => {
     document.documentElement.classList.remove('preload');
   });
   ```
   > 确保在任何变量注入、样式重算期间，绝对没有任何组件发生补间动画。

---

### 5.4 方案 Phase 4：主题流水线单点收敛与冗余调用剥离

1. **前移 `bootstrapTheme()`**：
   - 从 `AppBootstrap.ts` 的 `useEffect` 中剔除；
   - 移入 [`main.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/main.tsx) 顶层同步执行区间（在 `createRoot` 执行前）；
2. **清除重复调用与多头写入**：
   - 删除 [`bootstrap-full.ts`](file:///c:/Software/conex/apps/crish-desktop/src/bootstrap-full.ts#L18-L23) 中闲时重复调用的 `applyTheme()`；
   - 删除 `AppBootstrap.ts` 中重复的 `root.setAttribute('data-ui-size'...)`（统一由 `visualThemeController` 独占管辖）；
   - 在 `themeProjection.ts` 中增加色值防抖与全等快照拦截，状态未变时绝不调用 `setTheme()`。

---

### 5.5 方案 Phase 5：对比度守卫（Color Guard）按需介入改造

1. **重构 [`apps/crish-desktop/src/api/oklchColorGuard.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/oklchColorGuard.ts)**：
   - 增加“是否为预设皮肤”判定门禁；
   - 只有在 `p.skin === 'custom'`（用户自定义 RGB）或用户强行调整了极端亮度档位（`themeBrightnessAdjust !== 0`）时才介入计算；
   - 对于预设皮肤，如果既有配色方案已经满足 WCAG AA（对比度 $\ge 4.5:1$），守卫保持静默，禁止覆写 `--text-primary`、`--text-secondary` 和 `--text-tertiary`。

---

## 六、重构实施文件清单与验收标准

### 1. 拟修改文件与重构任务分配

| 序号 | 目标文件路径 | 核心修改任务与整改点 | 风险等级 |
| :--- | :--- | :--- | :--- |
| 1 | [`apps/crish-desktop/index.html`](file:///c:/Software/conex/apps/crish-desktop/index.html) | 去除 loader.js 的 `defer`；给 html 添加初始 `preload` 类 | 低 |
| 2 | [`apps/crish-desktop/public/loader.css`](file:///c:/Software/conex/apps/crish-desktop/public/loader.css) | 移除 `.app-initial-loader` 的 `transition`；`:root` 调整为中性浅灰/安全基调 | 低 |
| 3 | [`apps/crish-desktop/public/loader.js`](file:///c:/Software/conex/apps/crish-desktop/public/loader.js) | 同步解析 `crish_theme_skin`，0ms 写入核心背景/文字变量 | 中 |
| 4 | [`apps/crish-desktop/src/main.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/main.tsx) | 顶层同步引入 `bootstrapTheme()`；在首帧 rAF 中移除 `preload` 门闩 | 中 |
| 5 | [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) | 添加 `.preload` 规则；深浅色默认基线与 JS 皮肤预设 100% 对齐 | 中 |
| 6 | [`apps/crish-desktop/src/api/oklchColorGuard.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/oklchColorGuard.ts) | 改造为按需守卫，官方预设达标时不篡改基础文本色 | 中 |
| 7 | [`apps/crish-desktop/src/app/AppBootstrap.ts`](file:///c:/Software/conex/apps/crish-desktop/src/app/AppBootstrap.ts) | 剥离 `useEffect` 中的延迟 `bootstrapTheme()` 与重复属性写入 | 低 |
| 8 | [`apps/crish-desktop/src/bootstrap-full.ts`](file:///c:/Software/conex/apps/crish-desktop/src/bootstrap-full.ts) | 彻底删除 idleCallback 中的多余 `applyTheme()` 触发逻辑 | 低 |

### 2. 最终验收标准（Acceptance Criteria）

1. **0ms 零闪烁（Zero Flash）**：
   - 在任何主题（默认浅色、深色、自定义皮肤）下冷启动应用，录屏分析首帧（T0）至完全可交互（Interactive Ready）的全过程，**背景色与文字色无任何色阶跳变（ΔE = 0）**；
2. **0 补间动画（Zero Unwanted Transitions）**：
   - 应用加载期间，`.preload` 门闩生效，没有任何组件因变量注入触发 120ms~300ms 的肉眼可见变色动画；
3. **单真源对齐（Token-Preset Parity）**：
   - 静态 `tokens.css` 与 `themePresets.ts` 的基准值达到 100% 一致性；
4. **测试套件全绿（100% Tests Pass）**：
   - 现有的 `style-contract.test.ts` 与 `a11y-contrast.test.ts` 测试用例全部通过，无任何回归。
