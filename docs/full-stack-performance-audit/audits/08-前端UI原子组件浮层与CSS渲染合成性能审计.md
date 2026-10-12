# 08 — 前端 UI 原子组件、浮层调度与 CSS 渲染合成性能审计报告

> **审计维度**：Dim-08（UI 原子组件库 `src/components/ui/**`、浮层栈 `LayerStack`、几何/安全瞄准引擎 `SafeAimEngine`/`SafeTriangle`、全局与模块级 CSS 渲染合成管线 `src/styles/**` + 全量 `*.module.css`）
> **审计准则**：严格遵循 `AGENTS.md`、`.agents/LOGIC_PLAN_NO_RETREAT.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md`、`docs/agent-roles/general_task/三原则.md` 与 `docs/full-stack-performance-audit/00-DISCIPLINE.md`
> **排序原则**：纯逻辑拓扑与渲染管线分层同权展开（不设 P0/P1/P2 业务优先级砍项；按「CSS 样式匹配 → 布局与重绘合成 → 浮层与几何瞄准引擎 → 复合选择器与列表组件 → 滚动容器、图标与基础原子控件」五层递进）

---

## 一、审计全景与问题总览

本维度对 `apps/crish-desktop/src/components/ui/**`（共 78 个源码与样式文件）、`apps/crish-desktop/src/styles/**`（共 15 个全局样式文件）进行了 100% 逐行精读，并对 `apps/crish-desktop/src/**` 下全部 157 个 `.css` / `.module.css` 样式表执行了全量渲染管线扫描（覆盖 `transition`、`animation`、`backdrop-filter`、`filter`、`box-shadow`、`will-change`、`contain`、`content-visibility`、`[class*=...]`、`:has(...)`、通配选择器与字体整形属性）。

全量审计共定位 **26 项** 根因级性能缺陷，按渲染管线与组件架构归纳如下：

| 编号           | 所属子域                          | 问题摘要                                                                                                                                                                               | 核心代码锚点                                                                                                                                                                                                | 影响的渲染/运行时阶段                                          |
| :------------- | :-------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------- |
| **PERF-UI-01** | 全局 CSS 选择器                   | `[class*='...']` 子串属性选择器击穿 Blink 类名哈希桶，引发全树 $O(N \times M)$ 字符串扫描                                                                                              | `src/styles/overlay-scrollbar.css:137-356`、`focus-visible.css:83-89`、`shell-reset.css:87-89`、`reduced-motion.css:17,61`                                                                                  | Blink `RuleSet` / `ElementRuleCollector` (`Recalculate Style`) |
| **PERF-UI-02** | 全局 CSS 选择器                   | `::-webkit-scrollbar-*` 前置空格构成后代通配伪元素规则，滚动容器样式重算开销倍增                                                                                                       | `src/styles/overlay-scrollbar.css:238-336`                                                                                                                                                                  | Blink Pseudo-Element Style Resolution                          |
| **PERF-UI-03** | 全局排版与字体管线                | `html, body` 全局强开 `text-rendering: optimizeLegibility` 与连字特性，流式输出高频触发 HarfBuzz 慢路径                                                                                | `src/styles/shell/shell-reset.css:20,39,41-42`                                                                                                                                                              | HarfBuzz Text Shaping / Inline Layout                          |
| **PERF-UI-04** | 全局与模块 CSS 选择器             | 右端通配符 `*`、`:first-child`/`:last-child` 与高频容器 `:has(...)` 破坏样式失效局部性                                                                                                 | `src/styles/shell/shell-reset.css:140-143`、`markdown-typography.css:35-39,340-342,389,581-583`、`ChatMessageRow.module.css:42,300,369`、`DiffCard.module.css:490-559`、`Button.module.css:261-267`         | Blink Style Invalidation (`SubtreeStyleChange`)                |
| **PERF-UI-05** | CSS 布局与过渡动画                | 非合成属性（`width`/`height`/`max-height`/`flex-grow`/`padding`/`top`/`left`/`grid-template-rows`/`all`）过渡引发 60–120fps 连续重排（Layout Thrashing）                               | `Tabs.module.css:120-126`、`SegmentedControl.module.css:127-134`、`Switch.module.css:164,182-211`、`Slider.module.css:50`、`SmartPanel.module.css:161` 及业务模块 `.module.css`                             | Main Thread Layout + Paint                                     |
| **PERF-UI-06** | CSS 合成层与显存管理              | 常驻静态节点滥用 `will-change` 与 `backdrop-filter: blur()` 引发合成层爆炸（Layer Explosion）与 GPU 显存膨胀                                                                           | `ScrollArea.module.css:173,224`、`Tabs.module.css:120`、`SegmentedControl.module.css:127`、`Switch.module.css:164`、`ChatCard.module.css:109`、`FlowScrubber.module.css:79,179`、`Menu.module.css:34-36` 等 | Compositor Layer Tree / GPU VRAM / Backdrop Readback           |
| **PERF-UI-07** | CSS 布局隔离与渲染跳过            | 长列表、离屏卡片与浮层面板缺失 `contain` / `content-visibility` 边界，局部 DOM 变更向上击穿整树                                                                                        | `markdown-typography.css`、`ScrollArea.module.css`、`SmartExpandablePanel.module.css`、`Menu.module.css`、`SelectContent.module.css`                                                                        | Layout Containment & Display Locking                           |
| **PERF-UI-08** | Tooltip 全局中枢                  | `tooltipController` 在每次 `scroll`/`pointerdown`/`click` 无条件遍历全量注册表并执行 `document.body.querySelectorAll` 全树扫描                                                         | `src/components/ui/Tooltip/tooltipController.ts:82-105,128-158`、`Tooltip.tsx:133-144`                                                                                                                      | Event Loop + React State Dispatch + DOM Query                  |
| **PERF-UI-09** | Tooltip 存活检测                  | 浮层可见期每帧 rAF 轮询 `matches(':hover')` + `getBoundingClientRect()` 并叠加全局 `pointermove` 监听                                                                                  | `src/components/ui/Tooltip/Tooltip.tsx:166-240`                                                                                                                                                             | 60–120Hz Forced Synchronous Layout + Style Check               |
| **PERF-UI-10** | Tooltip 实例开销                  | 单实例重型 Hook 栈（5 State + 8 Ref + 6 Effect）、`content` 引用抖动误关与未记忆化 `cloneElement` 闭包分配                                                                             | `src/components/ui/Tooltip/Tooltip.tsx:89-163,261-265,477-492`                                                                                                                                              | React Fiber Mount/Re-render Memory & CPU                       |
| **PERF-UI-11** | 安全瞄准引擎（全局单例）          | `SafeAimEngine` 在面板闭合挂载及 `SafeTriangle.reset()` 时即注入全屏 `<svg>` 并永久挂载 `window` `mousemove` 监听，非调试态仍高频写 SVG DOM                                            | `src/components/ui/internal/SafeAimEngine.ts:52-62,94-98,151-159,207-267`、`SmartExpandablePanel.tsx:72-75`、`SafeTriangle.ts:201-215`                                                                      | 120–1000Hz Mousemove Handler + SVG DOM Attribute Mutation      |
| **PERF-UI-12** | SmartPanel 独立瞄准 Hook          | `useSafeAim` 无视 `open` 状态为每个实例泄露全屏 `<svg>` 与独立 `window` `mousemove` 监听，且 `setSubmenu` 未接线导致死算                                                               | `src/components/ui/SmartPanel/hooks/useSafeAim.ts:40-75`、`SmartPanel.tsx:35,113-124`                                                                                                                       | $O(K)$ Global Mousemove Listeners + Fullscreen SVG Overlays    |
| **PERF-UI-13** | PreviewCard 浮层基座              | `PreviewCardTrigger` 闭合挂载时在 `useLayoutEffect` 强制 `getBoundingClientRect()` 触发二次渲染，每次渲染新建 `SafeTriangleTracker`，Context 未记忆化                                  | `src/components/ui/PreviewCard/PreviewCard.tsx:254-276,308-325,342-347`                                                                                                                                     | Mount-time Forced Synchronous Layout + Cascade Re-render       |
| **PERF-UI-14** | LayerStack 浮层调度中枢           | `window` + `document` 双重捕获监听导致每次点击/按键双倍执行，空栈缺快速短路，退栈重复记录 Trace 并多次写根 DOM 属性                                                                    | `src/components/ui/internal/layer-stack/LayerStackManager.ts:365-386,458-463,541-644`                                                                                                                       | Global Input Event Latency + Root DOM Attribute Mutation       |
| **PERF-UI-15** | Dialog 焦点圈定管理器             | `FocusTrapIsolationManager.isWhitelisted` 对 `document.body` 顶层子节点（含 `#root`）执行深度 `querySelector` 全树扫描；每次 `Tab` 循环调用 `getComputedStyle`                         | `src/components/ui/Dialog/focusTrap.tsx:35-42,63-87,142-148,214-222`                                                                                                                                        | Full-App DOM Traversal + Forced Style Calculation              |
| **PERF-UI-16** | Menu 与 SmartExpandablePanel      | 鼠标滑过菜单项触发 `setFocusedIndex` 全列表重渲染，并在 `useEffect` 内执行 `querySelectorAll` + `.focus()` + `.scrollIntoView()`                                                       | `src/components/ui/Menu/Menu.tsx:195-204,399`、`SmartExpandablePanel/adapters/MenuAdapter.tsx:135-144,363`                                                                                                  | Hover-driven Full List Re-render + Layout Thrashing            |
| **PERF-UI-17** | Menu 键盘导航                     | `handleMenuKeyDown` 在校验按键前无条件对所有子项执行 `offsetParent` 与 `getComputedStyle` 强制同步回流                                                                                 | `src/components/ui/Menu/menuKeyNavigation.ts:127-147`                                                                                                                                                       | Keydown Latency + Forced Synchronous Layout                    |
| **PERF-UI-18** | SmartExpandablePanel 定位引擎     | `PositionEngine.measureNaturalHeight` 采用「写样式 → 读 `scrollHeight`/`offsetHeight` → 写样式 → 读 `offsetWidth`/`getBoundingClientRect`」交替读写导致同步强制重排                    | `src/components/ui/SmartExpandablePanel/PositionEngine.ts:33-65`、`SmartPanel/hooks/usePanelPosition.ts:38-46`                                                                                              | Write-Read-Write Layout Thrashing                              |
| **PERF-UI-19** | SmartExpandablePanel 适配器       | `MenuAdapter` / `SelectAdapter` 执行死代码 Schema 转换分配，且 `SelectAdapter` 每次渲染映射新数组击穿 `React.memo(MenuAdapter)`                                                        | `src/components/ui/SmartExpandablePanel/adapters/MenuAdapter.tsx:147-149`、`SelectAdapter.tsx:125-127,140`                                                                                                  | Wasted Allocations + Memoization Invalidation                  |
| **PERF-UI-20** | Select / Combobox 复合根与子项    | 展开瞬间 $N$ 个 Item 逐个 `setItems` 形成 $O(N^2)$ 挂载风暴；渲染期 `items.findIndex` 形成 $O(N^2)$ 查找；`highlightedIndex` 耦合单 Context 导致悬停全量重渲染                         | `src/components/ui/Select/SelectRoot.tsx:83-147,197-241`、`SelectItem.tsx:27-56`、`ComboboxRoot.tsx:104-144,224-285`、`ComboboxItem.tsx:31-60`                                                              | $O(N^2)$ Mount & Hover Re-render Cascade                       |
| **PERF-UI-21** | Combobox 关键词高亮与定位         | `ComboboxItem` 未缓存 `highlightMatches`，每次悬停重渲染为每项新建 2 个 `RegExp`；`useFloatingPosition` 双阶段 `setPosition` 造成首帧二次 Commit                                       | `src/components/ui/Select/ComboboxItem.tsx:72-74`、`internal/comboboxHighlight.tsx:21-36`、`useFloatingPosition.ts:75-153`                                                                                  | Regex Compilation Storm + Double Commit on Open                |
| **PERF-UI-22** | ScrollArea 自定义滚动容器         | `onMouseEnter`/`onMouseLeave` 与 `isScrolling` 在非对应 `type` 下仍触发无意义重渲染；`metrics.scrollTop`/`progress` 状态陈旧失步；`ScrollAreaScrollBar` 未记忆化且每次渲染分配新闭包   | `src/components/ui/ScrollArea/ScrollArea.tsx:184-213,310-339,370,400-404`、`ScrollAreaScrollBar.tsx:32-182`                                                                                                 | Unnecessary React Commits + Stale State                        |
| **PERF-UI-23** | 图标系统 (`AppIcon` & `CopyIcon`) | `CopyIcon` 为单个 24px 图标挂载完整 Framer Motion `LazyMotion` + `useAnimation` + `useReducedMotion` + 4 个 `VisualElement`；`AppIcon` 自定义图标分支每次渲染新建两层内联 `style` 对象 | `src/components/ui/animated-icons/CopyIcon.tsx:41-183`、`icons/AppIcon.tsx:65-78`、`icons/customIcons.tsx:17-40`                                                                                            | Heavy Per-Icon JS Runtime & Object Allocation                  |
| **PERF-UI-24** | SegmentedControl 与 Tabs 滑块     | `SegmentedControl` 在 `useEffect`（绘制后）测量 DOM 触发二次渲染与滑块闪烁；`Tabs` 维护从不读取的 `triggerMapRef` 却每次走 `querySelector`                                             | `src/components/ui/SegmentedControl/SegmentedControl.tsx:88,107-141`、`Tabs/Tabs.tsx:53-65,170-172,345-348`                                                                                                 | Post-Paint Layout Read + Second Commit                         |
| **PERF-UI-25** | Slider 拖拽与布局更新             | `handlePointerMove` 在拖拽期间（120–1000Hz）每帧调用 `getBoundingClientRect()`，且 `.filledTrack` 宽度更新与 CSS `transition: width` 发生帧间搏斗                                      | `src/components/ui/Slider/Slider.tsx:74-105,176-185`、`Slider.module.css:46-51`                                                                                                                             | 120–1000Hz Forced Layout Read + Transition Lag                 |
| **PERF-UI-26** | SmartModelBadge 容器查询          | `.badgeContainer` 同时声明 `display: inline-flex` 与 `container-type: inline-size` 且无显式宽度，触发内联轴尺寸折叠并产生冗余容器查询上下文与三份文本 DOM                              | `src/components/ui/SmartModelBadge.tsx:50-71`、`SmartModelBadge.module.css:7-13,49-88`                                                                                                                      | CSS Inline-Size Containment Collapse + 3x Text DOM Nodes       |

---

## 二、逐项深度审计与根因修复方案

---

### 第一部分：全局与模块级 CSS 选择器匹配及排版管线（PERF-UI-01 ~ PERF-UI-04）

---

#### PERF-UI-01：全局样式表大量使用 `[class*='...']` 子串属性选择器，击穿 Blink 类名哈希索引

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/styles/overlay-scrollbar.css:137-235`（共 30+ 处 `[class*='...']` 规则）：

```css
/* overlay-scrollbar.css:137-156 */
.custom-scrollbar,
.settings-nav,
.settings-content,
[class*='sessionListScroll'],
[class*='treeContainer'],
[class*='virtualListContainer'],
[class*='commitsList'],
[class*='commitFilesList'],
[class*='fileTree'],
[class*='planBody'],
[class*='subAgentOutput'],
[class*='terminal Scroll'],
[class*='logViewer'],
[class*='outputContent'],
[class*='markdown-body'] pre,
[class*='codeBlockContent'],
[class*='diffContent'],
[class*='settingsMain'],
[class*='coverContent'],
[class*='shortcutList'],
[class*='rulesList'],
[class*='mcpList'],
[class*='skillsList'] {
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
}
```

- `apps/crish-desktop/src/styles/focus-visible.css:83-89`：

```css
[class*='modalBackdrop']:focus,
[class*='modalOverlay']:focus,
[class*='drawerBackdrop']:focus,
[class*='dialogBackdrop']:focus {
  outline: none;
}
```

- `apps/crish-desktop/src/styles/shell/shell-reset.css:87-89`：

```css
[class*='resizer'],
[class*='Resizer'],
.split-sash {
  transition: background-color var(--duration-fast) var(--ease-out);
}
```

- `apps/crish-desktop/src/styles/reduced-motion.css:17,61`：

```css
  [class*='skeleton'],
  [class*='shimmer'],
```

- `apps/crish-desktop/src/components/composer/ComposerFusedTrigger.module.css:46,119-125`：

```css
.pillTrigger:hover [class*="badgeContainer"] > div { ... }
.fusedCapsule:has([class*="trigger"][aria-expanded="true"]) { ... }
```

##### 2. 渲染管线与算法复杂度推导

在 Chromium / Blink 渲染引擎的 `RuleSet::FindBestRuleSetAndAdd`（`third_party/blink/renderer/core/css/rule_set.cc`）中：

- 类选择器（如 `.custom-scrollbar`）会被推入以 `AtomicString` 类名为键的 `class_rules_` 哈希表，匹配复杂度为 $O(1)$，只有携带该精确 class token 的 DOM 节点才会进入规则匹配。
- 属性子串选择器 `[class*='...']` **无法进入 `class_rules_` 哈希表**，而是全部退化归入 `attr_rules_` 中键名为 `"class"` 的桶（Bucket）。
- 页面上几乎每一个 React 渲染的 DOM 节点都带有 `class` 属性。每当任意节点触发 `Recalculate Style`（例如流式对话追加 Token、虚拟列表滚动挂载新行、鼠标悬停状态切换），Blink 的 `ElementRuleCollector` 必须将该节点的完整 `className` 字符串与 `"class"` 属性桶中的 **数十条 `[class*=...]` 规则逐一执行子串搜索（`String::Find`）**。
- 设单次样式重算涉及 $N$ 个带 `class` 的 DOM 节点、全局存在 $M$ 条 `[class*=...]` 规则（当前仅 `overlay-scrollbar.css` 就有 20 个不同子串词根 × 5 组伪元素变体 ≈ 100 条规则），匹配复杂度从 $O(1)$ 退化为 $O(N \times M \times L)$（$L$ 为 `className` 字符串长度）。

##### 3. 修复方案与代码示例

彻底废除为了绕过 CSS Modules 哈希后缀而编写的 `[class*='...']` 黑客写法：

1. 在 `overlay-scrollbar.css` 中仅保留语义类名 `.custom-scrollbar` 与 `[data-scrollbar='thin']` / `[data-scrollbar='overlay']` 精确属性选择器；各 CSS Module 滚动容器通过 `composes: custom-scrollbar from global;` 或挂载 `data-scrollbar="thin"` 接入。
2. 在 `focus-visible.css`、`shell-reset.css`、`reduced-motion.css` 中统一改用精确类名或 `data-slot` 属性（此时若属性不普遍存在于所有节点，Blink 的 Bloom Filter / 属性名哈希桶可 $O(1)$ 过滤绝大多数节点）。
3. 在 `ComposerFusedTrigger.module.css` 中通过显式传入 `className` prop 或子组件导出类变量替代 `[class*="badgeContainer"]`。

```css
/* 修复后：overlay-scrollbar.css 仅使用精确 class 哈希桶匹配 */
.custom-scrollbar,
.settings-nav,
.settings-content,
.markdown-body pre {
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
}
```

---

#### PERF-UI-02：`overlay-scrollbar.css` 中 `::-webkit-scrollbar-*` 前置空格形成后代通配伪元素选择器

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/styles/overlay-scrollbar.css:238-336`：

```css
/* overlay-scrollbar.css:238, 248, 258, 267, 277, 290, 318, 333 */
[class*='settingsMain'] [class*='coverContent'] ::-webkit-scrollbar { ... }
[class*='settingsMain'] [class*='coverContent'] ::-webkit-scrollbar-track { ... }
[class*='settingsMain'] [class*='coverContent'] ::-webkit-scrollbar-thumb { ... }
[class*='settingsMain'] [class*='coverContent'] ::-webkit-scrollbar-thumb:hover { ... }
[class*='settingsMain'] [class*='coverContent'] ::-webkit-scrollbar-thumb:active { ... }
[class*='settingsMain'] [class*='coverContent'] ::-webkit-scrollbar-button:single-button { ... }
```

##### 2. 渲染管线与算法复杂度推导

CSS 选择器从右向左（Right-to-Left）匹配：

- `.container::-webkit-scrollbar`（无空格）表示伪元素直接归属于 `.container` 自身，仅当 `.container` 产生滚动条时计算。
- `[class*='coverContent'] ::-webkit-scrollbar`（**中间有空格**）等价于 `[class*='coverContent'] *::-webkit-scrollbar`！这意味着页面上**任意**可滚动元素的滚动条伪元素在进行样式解析时，都必须沿着 DOM 树向上回溯全部祖先节点（$O(D)$，其中 $D$ 为 DOM 深度），逐层执行 `[class*='coverContent']` 与 `[class*='settingsMain']` 的子串匹配。

##### 3. 修复方案与代码示例

移除 `::-webkit-scrollbar*` 前的空格，并将选择器收敛至单一 `.custom-scrollbar::-webkit-scrollbar*`：

```css
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: var(--scrollbar-thumb);
}
```

---

#### PERF-UI-03：`shell-reset.css` 在 `html` 与 `body` 根节点全局强开 `text-rendering: optimizeLegibility` 与字体连字

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/styles/shell/shell-reset.css:15-43`：

```css
html {
  font-size: 16px;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}

body {
  font-family: var(--font-sans);
  font-size: var(--font-size-base);
  line-height: var(--line-height-base);
  color: var(--text-primary);
  background: var(--bg-primary);
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
  text-rendering: optimizeLegibility;
  font-feature-settings:
    'kern' 1,
    'liga' 1;
}
```

##### 2. 渲染管线与算法复杂度推导

`text-rendering` 与 `font-feature-settings` 是 CSS **可继承属性（Inherited Properties）**。在 `html` 与 `body` 上声明 `text-rendering: optimizeLegibility` 后，全应用所有文本节点（包括 60Hz 流式输出的 AI 消息正文、工具调用终端日志、数千行 Diff 视图、文件树列表）全部被强制推入 Blink / HarfBuzz 的复杂文本整形管线（Complex Text Shaping Path）：

- HarfBuzz 必须对每个字符序列解析字体 GPOS（字距微调）与 GSUB（连字替换）表，无法走快速字形宽度缓存（Simple Path / Glyph Width Cache）。
- 在流式 Markdown 渲染期间，每个新 Token 到达都会使当前段落文本重排（Inline Layout），`optimizeLegibility` 会将文本测量（`ShapeResult::ComputeInkBounds`）的 CPU 耗时放大 2～4 倍。

##### 3. 修复方案与代码示例

`html` 与 `body` 统一使用浏览器默认 `text-rendering: auto`（或 `optimizeSpeed`），仅在大字号静态标题（`h1`–`h3`、`.dialogTitle`）上按需启用 `optimizeLegibility`：

```css
/* shell-reset.css */
html {
  font-size: 16px;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: auto;
}

body {
  /* 移除全局 text-rendering: optimizeLegibility 与强制 liga */
  font-kerning: normal;
}
```

---

#### PERF-UI-04：右端通配符 `*`、`:first-child`/`:last-child` 与高频容器 `:has(...)` 破坏样式失效局部性

##### 1. 精确代码锚点与原样摘录

1. **拖拽分隔条时全文档 `*` 强制重算**：
   - `apps/crish-desktop/src/styles/shell/shell-reset.css:140-143`：
   ```css
   body.leaf-dock-resizing,
   body.leaf-dock-resizing * {
     cursor: col-resize !important;
     user-select: none !important;
   }
   ```
2. **Markdown 容器下右端伪类/通用选择器**：
   - `apps/crish-desktop/src/styles/markdown-typography.css:35-39,340-342,389,581-583`：
   ```css
   :is(.conex-markdown, .md-rendered) > :last-child { margin-bottom: 0; }
   :is(.conex-markdown, .md-rendered) > :first-child { margin-top: 0; }
   :is(.conex-markdown, .md-rendered) .md-code-actions > * { pointer-events: auto; }
   :is(.conex-markdown, .md-rendered) code:not(pre code) { ... }
   :is(.conex-markdown, .md-rendered) blockquote > :first-child { margin-top: 0; }
   :is(.conex-markdown, .md-rendered) blockquote > :last-child { margin-bottom: 0; }
   ```
3. **原子按钮与高频业务容器 `:has(...)`**：
   - `apps/crish-desktop/src/components/ui/Button/Button.module.css:261-267`：
   ```css
   .button:has(> :is(.buttonIcon, .spinner):first-child):has(> .buttonLabel) {
     padding-inline-start: max(0px, calc(var(--btn-px) - 2px));
   }
   .button:has(> .buttonLabel):has(> :is(.buttonIcon, .spinner):last-child) {
     padding-inline-end: max(0px, calc(var(--btn-px) - 2px));
   }
   ```
   - `apps/crish-desktop/src/components/chat/ChatMessageRow.module.css:42,300-301,369`：
   ```css
   .messageRow:has(.editCard) .bubbleColumn { ... }
   .messageActions:has([aria-expanded='true']),
   .messageActions:has([data-state='open']) { ... }
   .codeBlockWrapper:has([data-expanded='true']) .codeToolbar { ... }
   ```
   - `apps/crish-desktop/src/components/cards/DiffCard.module.css:490-559`（6 处 `.diffRow:has(...)` / `.splitCell:has(...)`）
   - `apps/crish-desktop/src/components/workspace/BinaryTreeWorkspace.module.css:164-177`（4 处 `.splitContainer:has(> .sash:hover)`）

##### 2. 渲染管线与算法复杂度推导

1. **`body.leaf-dock-resizing *`**：当用户按下分栏拖拽条、向 `document.body` 添加/移除 `leaf-dock-resizing` 类名的瞬间，右端 `*` 通配符使整个 DOM 树（数千至上万个节点）全部标记为 `SubtreeStyleChange`，在拖拽起止帧产生 8～25ms 的主线程 `Recalculate Style` 尖峰。而实际上 `cursor` 和 `user-select` 也可在顶层透明拖拽遮罩（或仅 `body` 结合 `pointer-events: none` 子容器）上 O(1) 生效。
2. **`:is(.conex-markdown, .md-rendered) > :last-child` 与 `code:not(pre code)`**：在 AI 流式输出期间，Markdown 根容器不断追加或更新尾部块级子节点。`:last-child` 规则导致每次追加新块时，前一个尾节点必须触发样式失效（Style Invalidation）以重算 `margin-bottom`；而 `code:not(pre code)` 对每个 `<code>` 节点都需要向上遍历全部祖先检查是否存在 `<pre>`。
3. **高频组件中的 `:has(...)`**：在 `Button.module.css:261-267` 中，`<Button>` 组件本身在 TSX（`Button.tsx:115-149`）中已经明确知道 `icon != null && children != null` 以及 `iconPosition === 'left' | 'right'`！却舍近求远使用双重链式 `:has(> :is(.buttonIcon, .spinner):first-child):has(> .buttonLabel)`，迫使 Blink 为页面上数百个 `<Button>` 建立 `:has()` 伪类锚点并在子节点变更（如 `loading` 切换）时执行向上关系回溯。同理，`DiffCard.module.css:490-559` 在数千行 Diff 表格的每一行 `.diffRow` 上使用 `:has(.lineCommentTrigger:focus-visible)`，使每个单元格的焦点事件都向上触发行级 `:has()` 失效检查。

##### 3. 修复方案与代码示例

- **`shell-reset.css:140-143`**：移除 `body.leaf-dock-resizing *`，改为在 `body.leaf-dock-resizing` 上设置 `cursor: col-resize; user-select: none;`，并对工作区面板容器设置 `pointer-events: none`（仅保留拖拽手柄响应指针），将样式失效范围从 $O(\text{全树节点数})$ 降至 $O(1)$。
- **`Button.tsx` & `Button.module.css`**：在 `Button.tsx` 中根据 `(loading || icon != null) && children != null` 直接拼接 `.buttonWithLeftIcon` / `.buttonWithRightIcon` 类名，彻底删除 `Button.module.css:261-267` 的 `:has(...)` 规则。
- **`DiffCard.module.css`**：将 `:has(:focus-visible)` 替换为原生 `:focus-within`（浏览器内置祖先位标记，开销远低于 `:has()` 子树选择器匹配）。

---

### 第二部分：CSS 布局抖动（Layout Thrashing）、重绘与合成层（Compositing）管线（PERF-UI-05 ~ PERF-UI-07）

---

#### PERF-UI-05：全仓多处 CSS 过渡/动画直接驱动非合成几何属性（`width`/`height`/`max-height`/`flex-grow`/`padding`/`top`/`left`/`grid-template-rows`/`all`）

##### 1. 精确代码锚点与原样摘录

以下为全仓 `src/components/ui/**` 与业务 `.module.css` 中驱动非合成几何属性的完整清单：

**A. UI 原子组件层 (`src/components/ui/**`)**：

1. `apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css:120-126`：
   ```css
   will-change: transform, width, height, opacity;
   transition:
     transform var(--tab-duration) var(--tab-spring-bezier),
     width var(--tab-duration) var(--tab-spring-bezier),
     height var(--tab-duration) var(--tab-spring-bezier),
     opacity 120ms ease;
   ```
2. `apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css:127-134`：
   ```css
   will-change: transform, width, opacity;
   transition:
     transform var(--seg-duration) var(--seg-spring-bezier),
     width var(--seg-duration) var(--seg-spring-bezier),
     opacity 120ms ease;
   ```
3. `apps/crish-desktop/src/components/ui/Switch/Switch.module.css:164,182-211`：
   ```css
   will-change: transform, width;
   /* @keyframes thumb-stretch-on / thumb-stretch-off 在 0% -> 50% -> 100% 动画化 width */
   ```
4. `apps/crish-desktop/src/components/ui/Slider/Slider.module.css:50`：
   ```css
   .filledTrack {
     transition: width var(--transition-micro);
   }
   ```
5. `apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css:161`：
   ```css
   .collapsibleBody {
     transition:
       grid-template-rows 180ms cubic-bezier(0.22, 1, 0.36, 1),
       opacity 150ms ease;
   }
   ```

**B. 高频业务模块层 (`src/components/**`)**：6. `apps/crish-desktop/src/components/workspace/BinaryTreeWorkspace.module.css:82,197,271`：

- 第 82 行：`transition: flex-grow var(--duration-normal) var(--ease-emphasized), flex-basis var(--duration-normal) var(--ease-emphasized);`（分栏树节点动画化 `flex-grow`/`flex-basis`，导致整个工作区子树在 250ms 内每帧全量重排！）
- 第 197 行：`transition: width var(--duration-fast) var(--ease-out), height var(--duration-fast) var(--ease-out), background-color ...;`
- 第 271 行：`transition: opacity ..., transform ..., max-height var(--duration-normal) var(--ease-out);`

7. `apps/crish-desktop/src/components/workspace/PaneHeader.module.css:119,220` & `LeafToolTabStrip.module.css:150,255`：
   - 标签页 `transition: background-color ..., color ..., padding 120ms ease;` 与 `transition: max-width 150ms ease, opacity 120ms ease;`
8. `apps/crish-desktop/src/components/chat/ChatComposer.module.css:48,379,397,1522`：
   - 第 48 行：`transition: max-width 240ms cubic-bezier(0.22, 1, 0.36, 1), padding 240ms ...;`
   - 第 379 行：`transition: height 180ms cubic-bezier(0.22, 1, 0.36, 1), background-color 180ms ease;`
   - 第 397 行：`transition: grid-template-rows 180ms cubic-bezier(0.22, 1, 0.36, 1), opacity 150ms ease;`
   - 第 1522 行：`transition: width 200ms ease, background 200ms ease;`
9. `apps/crish-desktop/src/components/chat/ChatToolCallBlock.module.css:410,646,1019`：
   - 第 410、646 行：`transition: grid-template-rows var(--duration-fast) var(--ease-out), opacity ...;`
   - 第 1019 行：`transition: width 240ms var(--ease-out);`
10. `apps/crish-desktop/src/components/cards/FileViewerCard.module.css:71,193,273,412,502`、`DiffCard.module.css:691`、`GitTimelineView.module.css:352`、`SettingsShared.module.css:540`、`SettingsMcpTab.module.css:122,422`、`SettingsProviderCenterTab.module.css:464,1268`、`SkillCard.module.css:89`、`SubAgentGroupCard.module.css:128`：
    - **共计 14 处违规使用 `transition: all ...`**！
11. `apps/crish-desktop/src/components/layout/Sidebar.module.css:9`（`transition: width 150ms cubic-bezier(...)`）、`SidebarSessionList.module.css:676`（`transition: width 300ms ease`）、`ContextBar.module.css:138`（`transition: width 300ms ease, background-color 300ms ease`）、`SessionChangesPanel.module.css:123`（`transition: height 180ms ease-out`）。

##### 2. 渲染管线与算法复杂度推导

在 Chromium 渲染管线中，仅有 `transform`、`opacity`、`filter` 可在合成器线程（Compositor Thread）上以零主线程介入完成帧插值。

- 当对 `width`、`height`、`max-height`、`flex-grow`、`padding`、`grid-template-rows` 执行 CSS Transition/Animation 时，动画无法卸载至合成器线程（Blink 会产生 `CompositorAnimationFailureReason::kUnsupportedCSSProperty`）。
- 在 200ms～250ms 的过渡期内（120Hz 屏幕下连续 24～30 帧），**每一帧**都必须在主线程依次执行：`BeginMainFrame` → `UpdateAnimations` → `Recalculate Style` → **`Layout`（盒模型几何重排）** → `PrePaint` → **`Paint`（重新录制带圆角/阴影的 Skia DisplayItemList 并光栅化纹理）** → `Commit`。
- 特别是 `BinaryTreeWorkspace.module.css:82`（`flex-grow` 过渡）和 `Sidebar.module.css:9`（侧栏 `width` 过渡），它们位于应用布局树的顶层，每帧 `Layout` 都会向下级联传递至聊天虚拟列表、Markdown 代码块与编辑器面板，单帧主线程 Layout 耗时高达 12～35ms，直接造成掉帧卡顿。
- 而 `transition: all` 更是将节点上的所有几何属性（`width`/`height`/`padding`/`margin`/`inset`）全部纳入过渡监听，任何布局尺寸微调都会意外触发慢速主线程过渡动画。

##### 3. 修复方案与代码示例

1. **指示器滑块（`Tabs`、`SegmentedControl`）与进度条（`Slider`、`ContextBar`、`ChatToolCallBlock`）**：
   - 指示器滑块使用固定基准宽度（如 `width: 100px` 或目标尺寸）配合 `transform: translate3d(x, y, 0) scaleX(sx)`（若包含圆角需保持不变形，则在目标宽度相等时仅 `translate3d`，宽度不等时仅在切换瞬间同步应用目标 `width`，只对 `transform` 和 `opacity` 做过渡）。
   - **进度条（`.filledTrack`）**：将 `style={{ width: `${percentage}%` }}` + `transition: width` 彻底重构为固定 `width: 100%; transform-origin: left center; transform: scaleX(${percentage / 100}); transition: transform var(--transition-micro);`，实现 100% GPU 合成器线程动画：
   ```css
   /* Slider.module.css 修复后 */
   .filledTrack {
     width: 100%;
     height: 100%;
     background-color: var(--brand);
     border-radius: inherit;
     transform-origin: left center;
     transition: transform var(--transition-micro);
   }
   ```
2. **`Switch.module.css` 果冻拉伸动画**：
   - 移除 `will-change: transform, width` 中的 `width`，果冻拉伸改用 `transform: translateY(-50%) translateX(...) scaleX(1.35)`（合成器线程变换），避免 240ms 内每帧触发按钮内部 Layout + `box-shadow` 重绘。
3. **全面清退 14 处 `transition: all`**：全部显式枚举为 `transition: background-color ..., border-color ..., color ..., opacity ..., transform ...`。

---

#### PERF-UI-06：常驻静态节点滥用 `will-change` 与 `backdrop-filter: blur()` 引发合成层爆炸与 GPU 显存膨胀

##### 1. 精确代码锚点与原样摘录

**A. 静态常驻 `will-change` 列表**：

- `apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.module.css:173,224`：
  `.thumbIndicator` 与 `.thumbIndicatorHorizontal` 常驻 `will-change: transform;`（即便滚动条处于 `opacity: 0` 隐藏态或无溢出态）。
- `apps/crish-desktop/src/components/ui/Switch/Switch.module.css:164`：
  每个 `<Switch>` 的 `.thumb` 常驻 `will-change: transform, width;`。
- `apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css:127`：
  每个 `<SegmentedControl>` 的 `.activeSlider` 常驻 `will-change: transform, width, opacity;`。
- `apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css:120`：
  每个 `<Tabs>` 的 `.indicator` 常驻 `will-change: transform, width, height, opacity;`。
- `apps/crish-desktop/src/components/chat/ChatCard.module.css:83,109`：
  每个聊天卡片 `.chatCard` 常驻 `will-change: transform;`（第 83 行）与 `will-change: height;`（第 109 行）。
- `apps/crish-desktop/src/components/chat/FlowScrubber.module.css:79,179`：
  每个刻度点 `.tickButton` 常驻 `will-change: width, height, background-color, opacity;`，`.lensPopup` 常驻 `will-change: transform, opacity;`。

**B. 高频/大面积 `backdrop-filter: blur()` 列表**：

- `apps/crish-desktop/src/components/ui/Menu/Menu.module.css:34-35`（`backdrop-filter: blur(var(--glass-blur, 16px))`）
- `apps/crish-desktop/src/components/chat/ChatViewport.module.css:202-203`（`backdrop-filter: blur(10px)`，位于高频滚动的聊天视口上方！）
- `apps/crish-desktop/src/components/chat/FlowScrubber.module.css:174-175`（`backdrop-filter: blur(12px)`）
- `apps/crish-desktop/src/components/composer/ChatComposer.module.css:1244-1245`（`backdrop-filter: blur(12px)`）
- `apps/crish-desktop/src/components/cards/ImageGalleryCard.module.css:248-249,405-406`、`TerminalCard.module.css:154-155`、`CodeWindowModal.module.css:13-14`、`MermaidLightbox.module.css:26-27`、`Toast.module.css:40-41`、`ToastHistoryDrawer.module.css:121-122`、`Drawer.module.css:12-13`、`WorkspaceEmptyState.module.css:15-16`。

##### 2. 渲染管线与算法复杂度推导

1. **`will-change` 常驻显存代价**：
   - `will-change: transform` / `opacity` 会强制 Blink 的 `PaintArtifactCompositor` 为该 DOM 节点分配独立的 `cc::PictureLayer` 与 GPU 纹理贴图（Backing Store）。
   - 在设置面板或复杂工作区中，同时挂载数十个 `<Switch>`、`<SegmentedControl>`、`<Tabs>`、`<ScrollArea>` 以及数十个 `.tickButton` 和 `.chatCard`，会产生 **100+ 个毫无必要的常驻独立合成层**，且易引发隐式合成（Implicit Compositing / Layer Squashing 失败），耗费数十 MB GPU 显存并拉长每帧 `UpdateLayerTree` 与 `DrawLayers` 的遍历耗时。
   - 更严重的是 `will-change: width, height, background-color`（如 `FlowScrubber.module.css:79`、`ChatCard.module.css:109`）：这些属性根本不支持合成器加速，声明它们不仅没有任何正收益，反而干扰 Blink 的光栅化缓存策略。
2. **`backdrop-filter: blur()` 在滚动视口上的 GPU 读回（Readback）代价**：
   - `ChatViewport.module.css:202` 与 `ChatComposer.module.css:1244` 悬浮于聊天消息滚动层之上。当聊天列表以 60–120fps 滚动（或流式自动滚底）时，底部半透明模糊浮层覆盖的区域每一帧都在变化，GPU 合成器必须在每帧执行：`RenderPass` 纹理拷贝（Backdrop Readback）→ 双pass 高斯模糊着色器（Dual Kawase / Gaussian Blur Shader）→ Alpha 混合合成，在 4K/2K 高分屏（DPR=2）下极易成为 GPU 填充率（Fill-rate）瓶颈。

##### 3. 修复方案与代码示例

1. **按需激活 `will-change`**：
   - 移除所有非交互静止态上的 `will-change`。
   - 仅在交互激活期添加：例如 `ScrollArea.module.css` 仅在 `.stepperTrackColumn.visible .thumbIndicator` 或 `.thumbIndicator.dragging` 时声明 `will-change: transform`；`Switch.module.css` 仅在 `.hasInteracted:active .thumb` 或动画运行期声明 `will-change: transform`；彻底删除所有 `will-change: width / height / background-color`。
2. **收敛 `backdrop-filter: blur()`**：
   - 对齐 `Dialog.module.css:14` 的优秀实践（「全部弹窗共用一个轻压暗 token，不做模糊」），对悬浮在高频滚动区（`ChatViewport`、`ChatComposer`）上的浮层，改用高不透明度实色/微透明背景 token（如 `color-mix(in srgb, var(--bg-elevated) 96%, transparent)`），或在滚动进行时（`[data-scrolling='true']`）及 `html[data-perf-tier='eco']` 下自动关闭 `backdrop-filter: none`。

---

#### PERF-UI-07：浮层面板、滚动视口与 Markdown 渲染块缺失 CSS `contain` / `content-visibility` 布局与绘制隔离

##### 1. 精确代码锚点与原样摘录

通过对全仓 157 个样式文件的扫描，目前仅 `ChatMessageRow.module.css`、`VirtualMessageList.module.css`、`SubAgentCard.module.css` 少量文件使用了 `contain`；而在以下核心高频容器中完全缺失 CSS Containment：

- `apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.module.css:38-45`（`.viewport` 缺失 `contain: strict` 或 `contain: layout paint`）
- `apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css:19-40`（`.panel` 与 `.listContainer` 缺失 `contain: layout paint`）
- `apps/crish-desktop/src/components/ui/Menu/Menu.module.css:11-39`（`.content` 缺失 `contain: layout paint`）
- `apps/crish-desktop/src/components/ui/Select/SelectContent.module.css:3-25`（`.content` 缺失 `contain: layout paint`）
- `apps/crish-desktop/src/styles/markdown-typography.css:305-320,441-462`（Markdown 内的 `.md-code-block` 与 `.md-table-wrapper` 缺失 `contain: content`）

##### 2. 渲染管线与算法复杂度推导

当 `.viewport`（`overflow: auto`）或 `position: fixed` 的浮层面板（`Menu`、`SelectContent`、`SmartExpandablePanel`）未声明 `contain: layout paint`（或 `contain: content`）时：

- 浮层内部任何子项的尺寸或文本变更（如 `Combobox` 输入过滤、折叠区展开、滚动条滑块更新）在 Blink 的 `LayoutObject::MarkContainerChainForLayout` 中会沿着 DOM 树一直向上标记脏位直到 `LayoutView`（根节点），导致重排边界（Relayout Boundary）无法在浮层或滚动视口自身截断。

##### 3. 修复方案与代码示例

在所有定高/独立定位的滚动视口与浮层根容器上显式建立 CSS Containment 重排截断边界：

```css
/* ScrollArea.module.css */
.viewport {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  outline: none;
  scrollbar-width: none;
  overflow-anchor: none;
  contain: layout style paint;
}

/* Menu.module.css / SelectContent.module.css / SmartExpandablePanel.module.css */
.content,
.panel {
  contain: layout style paint;
}
```

---

### 第三部分：浮层系统、Tooltip、LayerStack 与几何瞄准引擎（PERF-UI-08 ~ PERF-UI-18）

---

#### PERF-UI-08：`tooltipController` 在每次 `scroll`、`pointerdown` 与 `click` 事件无条件广播 $O(N)$ 实例并执行全文档 `querySelectorAll`

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/Tooltip/tooltipController.ts:82-105,128-158`：

```ts
// tooltipController.ts:82-105
export function purgeOrphanTooltipElements(keepId: string | null): void {
  if (typeof document === 'undefined' || !document.body) return;
  try {
    const portals = document.body.querySelectorAll(
      '[data-tooltip-portal="true"]'
    );
    portals.forEach((node) => { ... });
  } catch { ... }
}

// tooltipController.ts:128-158
export function hideAllTooltips(): void {
  activeId = null;
  const entries = [...registry.values()];
  for (const entry of entries) {
    entry.cancelPending();
    entry.hide();
  }
  purgeOrphanTooltipElements(null);
}

function ensureDismissListeners(): void {
  if (dismissListenersBound || typeof window === 'undefined') return;
  dismissListenersBound = true;
  const dismiss = () => {
    if (registry.size > 0) {
      hideAllTooltips();
    }
  };
  window.addEventListener('scroll', dismiss, true);
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') dismiss();
  }, true);
  document.addEventListener('pointerdown', dismiss, true);
  document.addEventListener('click', dismiss, true);
  document.addEventListener('contextmenu', dismiss, true);
}
```

- 配合 `apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx:133-144`：

```ts
const hideImmediate = useCallback(() => {
  clearTimers();
  if (rafRef.current) {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = undefined;
  }
  visibleRef.current = false;
  setVisible(false);
  setRect(null);
  setClampedPos(null);
  deactivateTooltip(tooltipId);
}, [clearTimers, tooltipId]);
```

##### 2. 渲染管线与算法复杂度推导

根据 `AGENTS.md` §12 铁律，全应用所有悬停提示均使用 `<Tooltip>` 组件包裹（顶栏按钮、侧边栏会话项、工具栏图标按钮 `IconButton`、模型徽标 `SmartModelBadge`、消息操作栏等），常驻挂载的 `<Tooltip>` 实例数 $N$ 通常在 **80～300 个** 之间。
然而看 `ensureDismissListeners` 的逻辑：

1. `window.addEventListener('scroll', dismiss, true)` 使用捕获阶段监听全窗口**任意容器的每一个滚动帧（60–120Hz）**！
2. 每次 `scroll` 事件（以及每次鼠标点击触发的 `pointerdown` + `click` **连续两次**）调用 `dismiss()` 时，它**只检查 `if (registry.size > 0)`（只要页面上有挂载任何 `<Tooltip>` 就恒为真！），完全不检查当前是否有任何正在显示或正在等待显示的 Tooltip（`activeId !== null`）**！
3. 于是，在用户滚动聊天列表、滚动文件树或点击页面任意空白处的**每一帧**：
   - `[...registry.values()]` 浅拷贝长度为 $N$ 的数组；
   - 循环调用全部 $N$ 个 `<Tooltip>` 实例的 `entry.cancelPending()` 和 `entry.hide()`（即 `hideImmediate`）；
   - 每个实例在 `hideImmediate()` 中调用 `setVisible(false)`、`setRect(null)`、`setClampedPos(null)` 和 `deactivateTooltip(tooltipId)` —— **单次滚动帧触发 $3N$（240～900 次）React `dispatchSetState` 调用**！
   - 紧接着调用 `purgeOrphanTooltipElements(null)`，执行 **`document.body.querySelectorAll('[data-tooltip-portal="true"]')` 全文档 DOM 树深度遍历**！

##### 3. 修复方案与代码示例

1. 在 `tooltipController.ts` 中维护 `pendingIds = new Set<string>()`（记录正处于 `delayShow` 倒计时的实例 ID）与 `activeId: string | null`。
2. 当 `activeId === null && pendingIds.size === 0` 时，`hideAllTooltips()` **O(1) 立即直接返回（Fast Return）**，零数组分配、零 React 状态派发、零 DOM 查询！
3. 即使 `activeId !== null` 或 `pendingIds.size > 0`，也**只需精确定位 `registry.get(activeId)` 和 `pendingIds` 中的 1～2 个实例调用 `hide()` / `cancelPending()`**，时间复杂度严格从 $O(N + \text{DOM\_SIZE})$ 降至 **$O(1)$**！
4. `Tooltip.tsx` 的 `hideImmediate` 增加 `if (!visibleRef.current) return;` 守卫，避免对已隐藏实例重复调用 `setVisible(false)`。

```ts
// tooltipController.ts 修复核心逻辑
const pendingIds = new Set<string>();

export function markTooltipPending(id: string): void {
  pendingIds.add(id);
}

export function unmarkTooltipPending(id: string): void {
  pendingIds.delete(id);
}

export function hideAllTooltips(): void {
  if (activeId === null && pendingIds.size === 0) {
    return; // O(1) 零开销快速短路！
  }
  if (activeId !== null) {
    const activeEntry = registry.get(activeId);
    activeId = null;
    activeEntry?.cancelPending();
    activeEntry?.hide();
  }
  if (pendingIds.size > 0) {
    for (const id of pendingIds) {
      const entry = registry.get(id);
      entry?.cancelPending();
    }
    pendingIds.clear();
  }
  purgeOrphanTooltipElements(null);
}
```

---

#### PERF-UI-09：`Tooltip.tsx` 在浮层可见期启动 60–120fps `requestAnimationFrame` 死循环执行 `matches(':hover')` 与 `getBoundingClientRect()`

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx:166-240`：

```tsx
// Tooltip.tsx:166-240
useEffect(() => {
  if (!visible) return;
  let cancelled = false;

  const checkLiveness = () => {
    if (cancelled) return;
    const target = triggerRef.current;
    if (!target || !target.isConnected) {
      hideImmediate();
      return;
    }
    try {
      const isTriggerHovered =
        typeof target.matches === 'function' ? target.matches(':hover') : true;
      const tipEl = tooltipRef.current;
      const isTipHovered =
        interactive && tipEl && typeof tipEl.matches === 'function'
          ? tipEl.matches(':hover')
          : false;
      const isTriggerFocused = document.activeElement === target;

      if (!isTriggerHovered && !isTipHovered && !isTriggerFocused) {
        if (!hideTimerRef.current) {
          hideTimerRef.current = setTimeout(() => { ... }, effectiveDelayHide);
        }
      }
    } catch { ... }

    const newRect = target.getBoundingClientRect();
    if (!isValidDOMRect(newRect) || isTriggerOffscreen(newRect)) {
      hideImmediate();
      return;
    }

    rafRef.current = requestAnimationFrame(checkLiveness);
  };

  rafRef.current = requestAnimationFrame(checkLiveness);

  const onGlobalPointer = (e: PointerEvent) => { ... };
  window.addEventListener('pointermove', onGlobalPointer, { passive: true });
  ...
```

##### 2. 渲染管线与算法复杂度推导

只要用户把鼠标停在任意一个带 `<Tooltip>` 的按钮上（例如查看工具提示或模型 ID），`Tooltip.tsx` 就会启动一个**永不休眠的 `requestAnimationFrame` 循环（60～120Hz）**，同时还绑定了全局 `window.addEventListener('pointermove', onGlobalPointer)`：

1. 在每一帧 rAF 中调用 `target.matches(':hover')` 和 `target.getBoundingClientRect()`（第 208 行）。如果此时页面正在流式输出 AI 回复或运行动画（DOM 样式/布局处于 dirty 状态），`getBoundingClientRect()` 会**每帧强制触发一次同步回流（Forced Synchronous Layout）**！
2. 而且第 208 行读取的 `newRect` 甚至没有用于更新位置，仅仅用来判断 `isTriggerOffscreen(newRect)`，而滚动事件本就已经通过 `window.addEventListener('scroll', ..., true)` 被拦截了！
3. 当鼠标静止在按钮上时，每帧 rAF 轮询 `matches(':hover')` 与 `getBoundingClientRect()` 纯属 100% 空转浪费 CPU 并阻止渲染进程进入 Idle 节能态。

##### 3. 修复方案与代码示例

彻底移除 60–120fps 的 `requestAnimationFrame(checkLiveness)` 轮询循环：

- 指针离开判定：由现有的 `onMouseLeave` + 全局被动 `pointermove`（仅在浮层可见且指针移动时触发，静止时 0 开销）覆盖；
- 宿主卸载/尺寸归零判定：由 `ResizeObserverManager.getInstance().observe(target, ...)` 异步回调覆盖（当 `target` 被卸载或 `borderBoxSize` 变为 0 时立即调用 `hideImmediate()`，零主线程轮询回流）。

---

#### PERF-UI-10：`Tooltip` 单实例重型 Hook 栈、`content` Prop 引用抖动误关与未记忆化 `cloneElement` 闭包

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx:89-163,261-265,477-492`：

```tsx
// Tooltip.tsx:261-265
// 当 content 变为空时立即隐藏
useEffect(() => {
  if (content === null || content === undefined || content === '') {
    hideImmediate();
  }
}, [content, hideImmediate]);
```

```tsx
// Tooltip.tsx:477-492
const clonedChild = React.cloneElement(child, {
  ref: mergedRef,
  'aria-describedby': isOpen && visible ? tooltipId : undefined,
  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
    childProps.onMouseEnter?.(e);
    handleMouseEnter(e);
  },
  onMouseLeave: (e: React.MouseEvent<HTMLElement>) => { ... },
  onFocus: (e: React.FocusEvent<HTMLElement>) => { ... },
  onBlur: (e: React.FocusEvent<HTMLElement>) => { ... },
});
```

##### 2. 渲染管线与算法复杂度推导

1. **实例内存与 Fiber 挂钩膨胀**：每个 `<Tooltip>` 实例即使从未被悬停（99% 的生命周期处于 closed 态），在挂载时都初始化了 5 个 `useState`（含 `useAnimatedPresence` 内的 state）、8 个 `useRef`、`useId()` 以及 **6 个 `useEffect` / `useLayoutEffect`**（其中 `registerTooltip` effect 在挂载时即向全局 `registry` 注册）。200 个 `<Tooltip>` 即产生 1200 个 React Effect 节点。
2. **`content` JSX 引用变化导致依赖数组频繁触发**：第 261–265 行的 `useEffect` 依赖 `[content, hideImmediate]`。当父组件传入 JSX 节点（如 `<Tooltip content={<span>...</span>}>`）且父组件重渲染时，`content` 引用每次都变，导致该 `useEffect` 每次渲染都重新执行。
3. **`React.cloneElement` 内联函数破环子组件 `React.memo`**：第 477–492 行每次渲染都创建 4 个全新的内联箭头函数（`onMouseEnter`、`onMouseLeave`、`onFocus`、`onBlur`）注入 `child`，若 `child` 是 `React.memo` 组件，每次都会被击穿重渲染。

##### 3. 修复方案与代码示例

1. 将 `const isEmptyContent = content === null || content === undefined || content === '';` 提取为布尔值作为 `useEffect` 的依赖（`[isEmptyContent, hideImmediate]`），彻底消除 JSX 引用抖动。
2. `<Tooltip>` 在未激活态（`!visible && !isMounted`）无需向全局 `registry` 预先注册；仅在 `scheduleShow`（鼠标移入或聚焦）时将自身推入 `tooltipController` 的活动槽位（Singleton Active Slot），使全局注册表大小恒为 $\le 2$，彻底消除挂载期的 `useEffect(registerTooltip)`！
3. 使用 `useCallback` + `childPropsRef` 稳定化注入给 `React.cloneElement` 的 4 个事件处理器引用。

---

#### PERF-UI-11：`SafeAimEngine` 在面板闭合挂载及 `SafeTriangle.reset()` 时即创建全屏 `<svg>` 并永久挂载全局 `window` `mousemove` 监听器

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.tsx:72-75`：

```tsx
// SmartExpandablePanel.tsx:72-75（在 if (!isOpen) 之前无条件执行！）
const safeAim = useMemo(
  () => SafeAimEngine.getInstance({ enabled: enableTriangleAim }),
  [enableTriangleAim]
);
```

- `apps/crish-desktop/src/components/ui/internal/SafeTriangle.ts:201-215`：

```ts
// SafeTriangle.ts:201-215
reset(): void {
  this.active = false;
  this.targetRect = null;
  this.cursorOnLeave = null;
  this.points = [];
  this.stopCleanupTimer();
  try {
    SafeAimEngine.getInstance().clearPolygon();
  } catch {
    // ignore in non-DOM env
  }
}
```

- `apps/crish-desktop/src/components/ui/internal/SafeAimEngine.ts:52-62,94-98,114-120,151-159,207-267`：

```ts
// SafeAimEngine.ts:52-62
constructor(options?: SafeAimOptions) {
  this.enabled = options?.enabled ?? true;
  this.debug = options?.debug ?? false;
  if (typeof document !== 'undefined') {
    this.initDOM();
    this.attachEvents();
  }
}

// SafeAimEngine.ts:94-98
private attachEvents(): void {
  if (this.isListening || typeof window === 'undefined') return;
  window.addEventListener('mousemove', this.onMouseMove, { passive: true });
  this.isListening = true;
}

// SafeAimEngine.ts:114-120
private onMouseMove = (e: MouseEvent): void => {
  if (!this.enabled) return;
  const pt: Point = { x: e.clientX, y: e.clientY };
  this.recordMousePosition(pt);
  this.updatePolygon();
};
```

##### 2. 渲染管线与算法复杂度推导

这是一条极具隐蔽性的全局性能毒点链：

1. **未展开即激活全局监听**：只要页面上挂载了任何一个 `<SmartExpandablePanel>`（哪怕 `isOpen={false}` 处于关闭态），或者任何一个 `<Tooltip>` / `<PreviewCard>` 执行了 `safeAimTrackerRef.current.reset()`，都会调用 `SafeAimEngine.getInstance()`。
2. **构造函数立即污染 DOM 与全局事件**：`SafeAimEngine` 构造函数立即向 `document.body` 插入一个 **`100vw × 100vh`、`position: fixed; z-index: 500` 的全屏 `<svg id="sepSafeAimOverlay">` 节点**，并绑定 `window.addEventListener('mousemove', this.onMouseMove)`。
3. **永不解绑的 120–1000Hz 全局拦截**：`clearSubmenu()`（第 151–159 行）只清空 `this.targetSubmenu = null`，**从不调用 `detachEvents()`**！这意味着在应用整个运行生命周期内，用户的**每一次鼠标移动（高回报率鼠标下高达 500–1000Hz）**都会执行：
   - 分配新对象 `{ x: e.clientX, y: e.clientY }`；
   - `this.mouseHistory.push(pt)` 与 `this.mouseHistory.shift()`（数组头部移位）；
   - 调用 `this.updatePolygon()` → `this.clearPolygon()` → **`this.polygonEl.removeAttribute('points')`（每秒最多 1000 次 DOM 属性写操作）**！
4. **子菜单展开时的双重 `getBoundingClientRect()` 与无意义 SVG 写入**：当存在激活子菜单且 `this.debug === false`（生产默认态，此时 polygon 为 `fill: transparent; stroke: none` 完全不可见）时，每次 `mousemove` 仍在 `updatePolygon()`（第 217 行）和 `isPointerInSafeZone()`（第 253 行）中**连续两次调用 `this.targetSubmenu.getBoundingClientRect()`**，并拼接浮点坐标字符串调用 `this.polygonEl.setAttribute('points', pointsStr)`（第 229 行），在非调试模式下白白触发全屏 SVG 几何重算与重绘！

##### 3. 修复方案与代码示例

1. **惰性绑定与即时解绑**：构造函数中**不调用** `initDOM()` 与 `attachEvents()`。仅当 `setSubmenu(submenuEl, triggerEl)` 被调用且 `submenuEl !== null` 时才绑定 `window` `mousemove` 监听；当 `clearSubmenu()` 被调用时立即移除 `mousemove` 监听并清空 `mouseHistory`。
2. **非 Debug 模式零 DOM 创建**：当 `this.debug === false` 时，**完全不创建 `<svg id="sepSafeAimOverlay">` DOM 节点**，也不调用 `polygonEl.setAttribute('points', ...)`，所有三角形命中判定纯在内存数学向量（`isPointInTriangle`）中以 $O(1)$ 完成！
3. **`SafeTriangle.ts:212` 解耦**：删除 `SafeTriangleTracker.reset()` 中调用 `SafeAimEngine.getInstance().clearPolygon()` 的跨模块副作用代码。

```ts
// SafeAimEngine.ts 修复后核心逻辑
public setSubmenu(submenuEl: HTMLElement | null, triggerEl?: HTMLElement | null): void {
  this.targetSubmenu = submenuEl;
  this.triggerItem = triggerEl || null;
  if (submenuEl) {
    if (this.debug) this.initDOM();
    this.attachEvents();
    this.updatePolygon();
  } else {
    this.clearSubmenu();
  }
}

public clearSubmenu(): void {
  this.targetSubmenu = null;
  this.triggerItem = null;
  this.mouseHistory = [];
  this.detachEvents(); // 立即解绑全局 mousemove！
  this.clearPolygon();
}
```

---

#### PERF-UI-12：`SmartPanel/hooks/useSafeAim.ts` 无视 `open` 状态，为每个挂载实例泄露独立全屏 `<svg>` 与全局 `mousemove` 监听器

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.tsx:35,113-124`：

```tsx
// SmartPanel.tsx:35（在 if (!open) return null 之前调用！）
const { isPointerInSafeZone } = useSafeAim({
  enabled: enableSafeAim,
  gracePeriod,
});
```

- `apps/crish-desktop/src/components/ui/SmartPanel/hooks/useSafeAim.ts:40-75`：

```ts
// useSafeAim.ts:40-75
useEffect(() => {
  if (!enabled || typeof document === 'undefined') return;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('style', 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:99999;overflow:visible;');
  ...
  document.body.appendChild(svg);
  svgRef.current = svg;
  polygonRef.current = polygon;

  const handleMouseMove = (e: MouseEvent) => {
    const pt = { x: e.clientX, y: e.clientY };
    mouseHistoryRef.current.push(pt);
    if (mouseHistoryRef.current.length > 5) {
      mouseHistoryRef.current.shift();
    }
    if (debug && polygonRef.current && submenuStackRef.current.length > 0) { ... }
  };

  window.addEventListener('mousemove', handleMouseMove, { passive: true });
  return () => {
    window.removeEventListener('mousemove', handleMouseMove);
    if (svgRef.current && svgRef.current.parentNode) {
      svgRef.current.parentNode.removeChild(svgRef.current);
    }
  };
}, [enabled, debug, updateDebugPolygon]);
```

##### 2. 渲染管线与算法复杂度推导

1. **三套重复的 Safe-Aim 实现并存**：`src/components/ui/` 内同时存在 `internal/SafeAimEngine.ts`、`internal/SafeTriangle.ts` 和 `SmartPanel/hooks/useSafeAim.ts` 三套功能完全重叠的亚马逊安全三角算法，违背 `AGENTS.md` §7.1 单一真理路径（SSOT）铁律。
2. **每个闭合 `<SmartPanel>` 实例泄露一个全屏 `<svg>` + 一个全局 `mousemove` 监听器**：`SmartPanel.tsx:35` 将 `{ enabled: enableSafeAim }`（默认 `true`）传给 `useSafeAim`，而**未传入 `open` 状态**！因此页面上每挂载 $K$ 个 `<SmartPanel>`（即使全部处于 `open={false}` 关闭状态），`document.body` 下就会常驻挂载 $K$ 个 `100vw × 100vh`、`z-index: 99999` 的全屏 `<svg>` 节点，且 `window` 上会同时运行 $K$ 个 `mousemove` 监听器！
3. **`setSubmenu` 未接线导致死算 + `SmartPanel.tsx:119` 重复同步回流**：`SmartPanel.tsx:35` 只解构了 `{ isPointerInSafeZone }`，**根本没有解构和调用 `setSubmenu`**！因此 `useSafeAim` 内部的 `submenuStackRef.current` 永远是空数组 `[]`，`isPointerInSafeZone` 永远返回 `false`。然而在 `SmartPanel.tsx:118-120` 中，每次鼠标移入菜单项时却依然执行：
   ```ts
   const pt = { x: el.getBoundingClientRect().left, y: el.getBoundingClientRect().top };
   if (isPointerInSafeZone(pt)) { ... }
   ```
   不仅把菜单项左上角坐标误当成鼠标坐标传入，而且为了取 `.left` 和 `.top` **连续调用了两次 `el.getBoundingClientRect()`**，随后交给一个永远返回 `false` 的函数！

##### 3. 修复方案与代码示例

彻底废除 `SmartPanel/hooks/useSafeAim.ts`，统一收敛至修复后的无 DOM 纯内存数学引擎（或 `SafeTriangleTracker`），并在 `SmartPanel.tsx` 中仅当 `open && activeSubmenuId !== null` 时启用追踪；同时在 `handleItemEnter` 中直接使用 `React.MouseEvent` 的 `{ x: e.clientX, y: e.clientY }`，消除两次无意义的 `el.getBoundingClientRect()`。

---

#### PERF-UI-13：`PreviewCard` 在闭合挂载期强制执行 `getBoundingClientRect()` 触发二次 Commit，且每次渲染实例化 `SafeTriangleTracker`

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.tsx:254-276,308-325`：

```tsx
// PreviewCard.tsx:254-276 — Context value 未包裹 useMemo
const contextValue: PreviewCardContextValue = {
  isOpen,
  setIsOpen,
  triggerRect,
  setTriggerRect,
  ...
};

// PreviewCard.tsx:308-325 (PreviewCardTrigger)
const safeAimTrackerRef = useRef<SafeTriangleTracker>(
  new SafeTriangleTracker(300)
);
...
// 挂载时即注册 triggerEl 与 triggerRect
useLayoutEffect(() => {
  if (triggerRef.current) {
    setTriggerEl(triggerRef.current);
    const rect = triggerRef.current.getBoundingClientRect();
    if (isValidDOMRect(rect)) {
      setTriggerRect(rect);
    }
  }
}, [setTriggerEl, setTriggerRect]);
```

##### 2. 渲染管线与算法复杂度推导

1. **挂载期强制同步回流与二次 Commit**：每个 `<PreviewCardTrigger>` 在挂载时（此时 `isOpen === false`，浮层根本未打开），在 `useLayoutEffect` 中同步调用 `triggerRef.current.getBoundingClientRect()` 强制浏览器在 Commit 阶段执行同步 Layout，紧接着调用 `setTriggerEl` 与 `setTriggerRect`，迫使父组件 `<PreviewCard>` 及其整个子树在挂载同一帧内**立即同步触发第二次 React Render + Commit**！而当用户真正悬停打开时，`scheduleOpen`（第 355 行）本来就会重新调用 `el.getBoundingClientRect()`，挂载期的测量 100% 冗余。
2. **渲染期对象重复分配与未记忆化 Context**：`useRef(new SafeTriangleTracker(300))` 在每次渲染时都会求值 `new SafeTriangleTracker(300)`；且 `<PreviewCard>` 的 `contextValue` 未用 `useMemo` 包裹，父组件任何重渲染都会无条件穿透至 `PreviewCardTrigger` 与 `PreviewCardContent`。

##### 3. 修复方案与代码示例

1. 删除 `PreviewCardTrigger` 第 317–325 行在挂载期读取 `getBoundingClientRect()` 并 `setTriggerRect` 的逻辑（仅在 `triggerRef` 中保存 DOM 引用，待 `scheduleOpen` 时按需测量）。
2. 将 `safeAimTrackerRef` 改为惰性获取，并用 `useMemo` 包裹 `<PreviewCard>` 的 `contextValue`。

---

#### PERF-UI-14：`LayerStackManager` 在 `window` 与 `document` 双重绑定 6 个全局捕获监听器，且空栈缺快速短路

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/internal/layer-stack/LayerStackManager.ts:365-386,458-463,541-552,612-620`：

```ts
// LayerStackManager.ts:458-463
window.addEventListener('keydown', this.handleGlobalKeyDown, { capture: true });
document.addEventListener('keydown', this.handleGlobalKeyDown, {
  capture: true,
});
window.addEventListener('pointerdown', this.handleGlobalPointerDown, {
  capture: true,
});
document.addEventListener('pointerdown', this.handleGlobalPointerDown, {
  capture: true,
});
window.addEventListener('pointerup', this.handleGlobalPointerUp, {
  capture: true,
});
document.addEventListener('pointerup', this.handleGlobalPointerUp, {
  capture: true,
});
```

```ts
// LayerStackManager.ts:541-552
private handleGlobalPointerDown = (event: PointerEvent | MouseEvent): void => {
  if (PROCESSED_EVENTS.has(event)) return;
  PROCESSED_EVENTS.add(event);

  this.pointerDownTarget = (event.target as Node) ?? null;

  const now = this.now();
  const layersToDismiss: LayerRegistration[] = [];

  // 自顶向下遍历图层栈
  for (let i = this.layers.length - 1; i >= 0; i--) { ... }
```

```ts
// LayerStackManager.ts:365-386
private dismissLayer(layer: LayerRegistration, reason: ...): void {
  this.recordTrace(layer.id, layer.type, reason);
  ...
  this.unregister(layer.id, reason); // unregister 内部第 192 行再次调用 this.recordTrace！
}
```

##### 2. 渲染管线与算法复杂度推导

1. **全局输入事件双倍拦截与空栈开销**：
   - 在 DOM 事件流中，捕获阶段必然依次经过 `window` → `document` → 目标节点。同时在 `window` 和 `document` 上绑定同一个捕获监听器，导致应用中**每一次按键（`keydown`）、每一次鼠标按下（`pointerdown`）和抬起（`pointerup`）都会连续触发两次处理器**！
   - 更糟的是，`handleGlobalPointerDown`（第 541 行）没有像 `handleGlobalKeyDown` 那样在第一行写 `if (this.layers.length === 0) return;`。因此即使页面上没有任何浮层打开（95% 的日常操作时间），每次点击都会写入 `PROCESSED_EVENTS` `WeakSet`、调用 `performance.now()`、分配空数组 `layersToDismiss = []`；而 `handleGlobalPointerUp`（第 612 行）甚至连 `PROCESSED_EVENTS` 都没检查，每次鼠标抬起都无条件执行两遍！
2. **退栈重复记录 Trace 与高频根属性翻转**：`dismissLayer` 先调一次 `this.recordTrace`，随后调 `this.unregister` 又调一次 `this.recordTrace`，导致每次关闭浮层都在 `traceBuffer` 中产生两条重复记录；且级联关闭多层时，每层 `unregister` 都调用一次 `updateFloatingActiveState()`，对 `document.documentElement` 和 `document.body` 反复执行 `setAttribute`/`removeAttribute('data-floating-active')`。

##### 3. 修复方案与代码示例

1. 仅在 `window` 上绑定捕获监听器（移除 `document` 上的重复绑定），并在 `handleGlobalPointerDown` 与 `handleGlobalPointerUp` 首行立即判断 `if (this.layers.length === 0) return;`。
2. 还可以进一步按需绑定：仅当 `this.layers.length` 从 `0` 变为 `1` 时调用 `attachListeners()`，当 `this.layers.length` 归 `0` 时调用 `detachListeners()`，实现无浮层时 **0 全局事件监听器**！
3. 删除 `dismissLayer` 中冗余的首次 `this.recordTrace` 调用，统一由 `unregister` 记录。

---

#### PERF-UI-15：`FocusTrapIsolationManager` 在开关弹窗时对 `#root` 执行深度 `querySelector` 全树扫描，且每次 `Tab` 循环调用 `getComputedStyle`

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx:35-42,63-87,142-148`：

```tsx
// focusTrap.tsx:35-42
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ).filter((el) => {
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

// focusTrap.tsx:63-87
private isWhitelisted(node: Element): boolean {
  if (
    ...
    node.hasAttribute('data-floating-layer') ||
    node.querySelector?.(
      '[data-slot="select-content"], [data-slot="combobox-content"], [role="listbox"], [data-floating-layer]'
    ) != null
  ) {
    return true;
  }
  return false;
}
```

##### 2. 渲染管线与算法复杂度推导

1. **开关弹窗时的全应用 DOM 树扫描 + 隔离失效隐患**：
   - 当 `<Dialog>` 打开或关闭时，`applyIsolation()` 遍历 `document.body.children`（第 143 行），其中包括承载整个应用主界面的 `<div id="root">`！
   - 对 `#root` 调用 `this.isWhitelisted(child)` 时，由于 `#root` 本身不匹配前面的顶层属性，代码会执行第 80 行的 `node.querySelector('[data-slot="select-content"], [data-slot="combobox-content"], [role="listbox"], [data-floating-layer]')` —— **对整个 `#root` 下的数千个 DOM 节点执行深度优先全树扫描**！
   - 更致命的逻辑与性能双重缺陷：如果此时主界面 `#root` 内部恰好存在任何一个带有 `role="listbox"` 的内联列表（如侧边栏列表或模型列表），`#root.querySelector('[role="listbox"]')` 就会返回非空，导致整个 `#root` 被 `isWhitelisted` 误判放行，不仅全树扫描耗时，还导致背景主界面逃逸 `inert` 隔离！
2. **`getFocusableElements` 循环调用 `getComputedStyle`**：在弹窗打开聚焦（第 211 行）和每次按下 `Tab` 键（第 218 行）时，对弹窗内所有按钮/输入框逐一调用 `getComputedStyle(el)`（例如 `SettingsPanel` 内有上百个控件）。

##### 3. 修复方案与代码示例

1. 在 `isWhitelisted(node)` 中，**严禁对 `#root`（或包含大量子树的主应用根节点）执行无界 `node.querySelector(...)`**：若 `node.id === 'root'`，直接返回 `false`；对于 Portal 包装容器，仅检查 `node` 自身属性或其直接子元素（`:scope > [data-floating-layer], :scope > [role="listbox"]`），将复杂度从 $O(\text{DOM\_TOTAL})$ 降至 $O(1)$。
2. 在 `getFocusableElements` 中，优先使用 `typeof el.checkVisibility === 'function' ? el.checkVisibility() : ...`（Chromium 105+ 原生 C++ 快速可见性检测，避免为每个元素构建完整 `CSSStyleDeclaration` 包装对象）。

---

#### PERF-UI-16：`Menu` 与 `MenuAdapter` 在鼠标滑过菜单项时触发全列表 React 重渲染 + `querySelectorAll` + `.focus()` + 同步 `.scrollIntoView()`

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/Menu/Menu.tsx:195-204,399`：

```tsx
// Menu.tsx:195-204
useEffect(() => {
  if (!open || focusedIndex < 0 || !contentRef.current) return;
  const items = contentRef.current.querySelectorAll<HTMLElement>(
    '[role="menuitem"], [role="option"]'
  );
  const target = items[focusedIndex];
  if (target) {
    target.focus();
    target.scrollIntoView?.({ block: 'nearest' });
  }
}, [open, focusedIndex]);

// Menu.tsx:399
onMouseEnter={() => !opt.disabled && setFocusedIndex(idx)}
```

- 同样存在于 `apps/crish-desktop/src/components/ui/SmartExpandablePanel/adapters/MenuAdapter.tsx:135-144,363`。

##### 2. 渲染管线与算法复杂度推导

当用户移动鼠标快速划过打开的菜单列表时，每经过一个菜单项（`onMouseEnter`）：

1. 调用 `setFocusedIndex(idx)`，触发整个 `<Menu>` / `<MenuAdapter>` 组件及全部 $N$ 个菜单项的 React 重渲染；
2. 渲染提交后触发 `useEffect([open, focusedIndex])`：
   - 对菜单容器执行 `querySelectorAll('[role="menuitem"], [role="option"]')`；
   - 调用 `target.focus()`；
   - **调用 `target.scrollIntoView({ block: 'nearest' })`**！即使鼠标本来就已经在视口可见区域内的菜单项上悬停（根本不需要滚动！），`scrollIntoView` 也会强制浏览器同步计算滚动容器与目标项的布局盒几何，并在鼠标靠近上下边缘时产生非预期的菜单自动跳动！

##### 3. 修复方案与代码示例

区分变化来源（`focusSourceRef: 'keyboard' | 'pointer'`）：

- **仅当 `focusSourceRef.current === 'keyboard'`（上下方向键导航）时**才执行 `scrollIntoView({ block: 'nearest' })`；鼠标悬停（`'pointer'`）时菜单项天然在鼠标指针下方（必定在视口内），绝不调用 `scrollIntoView`！
- 用 `itemRefs.current[focusedIndex]` 直接索引 DOM 节点，消除每次悬停的 `querySelectorAll`。

---

#### PERF-UI-17：`menuKeyNavigation.ts` 在校验按键类型前无条件遍历全部子项读取 `offsetParent` 与 `getComputedStyle`

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/Menu/menuKeyNavigation.ts:127-147`：

```ts
// menuKeyNavigation.ts:127-147
// 2. JSX children 渲染模式：通过 DOM 查询焦点漫游
if (!contentEl) return;
const rawItems = Array.from(
  contentEl.querySelectorAll<HTMLElement>(
    '[role="menuitem"]:not([disabled]):not([aria-disabled="true"]), [role="option"]:not([disabled]):not([aria-disabled="true"])'
  )
);
// 过滤掉折叠区域内隐藏的节点 (display: none)
const items = rawItems.filter((el) => {
  if (typeof window === 'undefined') return true;
  if (el.hidden || el.closest('[hidden]')) return false;
  return (
    el.offsetParent !== null ||
    window.getComputedStyle(el).display !== 'none'
  );
});
if (items.length === 0) return;

const currentIndex = items.findIndex((el) => el === document.activeElement);

switch (e.key) {
  case 'ArrowDown': ...
```

##### 2. 渲染管线与算法复杂度推导

在 `children` 渲染模式下，当菜单打开且用户按下**任何键**（例如 `Shift`、`Control`、`Meta`、字母键、甚至与菜单无关的快捷键）时，`handleMenuKeyDown` **在进入 `switch (e.key)` 之前**，就无条件执行 `querySelectorAll` 并对每个节点读取 `el.offsetParent` 和 `window.getComputedStyle(el).display`（强制同步样式重算与回流 Layout）！

##### 3. 修复方案与代码示例

将按键白名单守卫提到函数最顶部：若 `!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape', 'Tab'].includes(e.key)`，立即 O(1) 返回，不做任何 DOM 查询或布局读取。

---

#### PERF-UI-18：`PositionEngine.measureNaturalHeight` 与 `usePanelPosition` 存在「写样式 → 读几何 → 写样式 → 读几何」同步布局抖动（Layout Thrashing）

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/SmartExpandablePanel/PositionEngine.ts:33-65`：

```ts
// PositionEngine.ts:33-65
export function measureNaturalHeight(
  panelEl: HTMLElement,
  listSelector = '[data-sep-list="true"]'
): number {
  const listEl = panelEl.querySelector<HTMLElement>(listSelector);
  if (!listEl) {
    return panelEl.scrollHeight || panelEl.offsetHeight || 240;
  }

  const prevMaxH = listEl.style.maxHeight;
  const prevOverflow = listEl.style.overflow;
  listEl.style.maxHeight = 'none';        // [WRITE 1] 标脏布局树
  listEl.style.overflow = 'visible';      // [WRITE 2]

  const naturalListH = listEl.scrollHeight; // [READ 1] 强制同步 Layout #1
  const nonListH = Math.max(0, panelEl.offsetHeight - listEl.offsetHeight); // [READ 2]

  listEl.style.maxHeight = prevMaxH;      // [WRITE 3] 再次标脏布局树
  listEl.style.overflow = prevOverflow;   // [WRITE 4]

  return naturalListH + nonListH;
}

export function computePosition(
  triggerEl: HTMLElement,
  panelEl: HTMLElement,
  options: PositionEngineOptions = {}
): PositionResult {
  ...
  const naturalHeight = measureNaturalHeight(panelEl);
  const panelWidth = panelEl.offsetWidth || 220; // [READ 3] 因 WRITE 3/4 再次强制同步 Layout #2！
  const triggerRect = triggerEl.getBoundingClientRect(); // [READ 4]
```

##### 2. 渲染管线与算法复杂度推导

1. 在 `measureNaturalHeight` 中，其实**根本不需要修改 `listEl.style.maxHeight = 'none'` 就能读取 `listEl.scrollHeight`**！因为在 DOM 标准中，元素的 `scrollHeight` 本来就返回其内部完整内容高度（不受 `max-height` 裁剪限制，只要 `overflow` 不是裁剪掉 scrollHeight 的特殊模式，`overflow-y: auto` 下的 `scrollHeight` 恒等于自然全高）！
2. 由于无必要地写入了 `listEl.style.maxHeight = 'none'`（WRITE 1/2），紧接着读 `scrollHeight` / `offsetHeight`（READ 1/2，触发第 1 次同步回流），然后又写回 `listEl.style.maxHeight = prevMaxH`（WRITE 3/4，再次标脏 Layout），紧接着在 `computePosition` 第 60 行读取 `panelEl.offsetWidth`（READ 3，**在同一函数内触发第 2 次强制同步回流**）！

##### 3. 修复方案与代码示例

直接读取 `listEl.scrollHeight`、`panelEl.offsetHeight`、`listEl.offsetHeight`、`panelEl.offsetWidth` 与 `triggerEl.getBoundingClientRect()`（纯连续读操作，0 样式写入，单次或零额外回流）：

```ts
export function measureNaturalHeight(
  panelEl: HTMLElement,
  listSelector = '[data-sep-list="true"]'
): number {
  const listEl = panelEl.querySelector<HTMLElement>(listSelector);
  if (!listEl) {
    return panelEl.scrollHeight || panelEl.offsetHeight || 240;
  }
  const naturalListH = listEl.scrollHeight;
  const nonListH = Math.max(0, panelEl.offsetHeight - listEl.offsetHeight);
  return naturalListH + nonListH;
}
```

---

#### PERF-UI-19：`MenuAdapter` 与 `SelectAdapter` 执行死代码 Schema 转换分配，且 `SelectAdapter` 每次渲染映射新数组击穿 `React.memo(MenuAdapter)`

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/SmartExpandablePanel/adapters/MenuAdapter.tsx:147-149`：

```tsx
// MenuAdapter.tsx:147-149（_smartItems 定义后从未被使用！）
const _smartItems = useMemo(
  () => (options ? convertMenuOptionsToSmartItems(options) : []),
  [options]
);
```

- `apps/crish-desktop/src/components/ui/SmartExpandablePanel/adapters/SelectAdapter.tsx:125-127,140`：

```tsx
// SelectAdapter.tsx:125-127（_smartItems 定义后从未被使用！）
const _smartItems = useMemo(
  () => convertSelectOptionsToSmartItems(options, value),
  [options, value]
);
...
// SelectAdapter.tsx:140（每次渲染调用 options.map(toMenuItem) 产生全新数组引用，且同时传入了 children 导致 options 在 MenuAdapter 内根本不渲染！）
return (
  <MenuAdapter
    ...
    options={options.map(toMenuItem)}
    ...
  >
```

##### 2. 渲染管线与算法复杂度推导

1. `MenuAdapter.tsx:147` 与 `SelectAdapter.tsx:125` 中的 `_smartItems` 是完全未使用的死代码，每次 `options` 或 `value` 变化时白白遍历递归构造整棵 `SmartItemSchema[]` 对象树。
2. `SelectAdapter.tsx:140` 在 JSX 属性上内联调用 `options={options.map(toMenuItem)}`：不仅每次渲染分配一个新数组并导致 `React.memo(MenuAdapter)` 的浅比较 `prevProps.options === nextProps.options` 恒为 `false`（100% 击穿 `React.memo`），而且由于 `SelectAdapter` 同时向 `MenuAdapter` 传递了 JSX `children`（第 149–243 行），`MenuAdapter`（第 344 行 `options && !children ? ... : children`）根本不会使用 `options`！

##### 3. 修复方案与代码示例

删除 `MenuAdapter.tsx:147-149` 与 `SelectAdapter.tsx:125-127` 的 `_smartItems` 死代码，并移除 `SelectAdapter.tsx:140` 中多余的 `options={options.map(toMenuItem)}` 属性传递。

---

### 第四部分：复合选择器组件 `Select` 与 `Combobox`（PERF-UI-20 ~ PERF-UI-21）

---

#### PERF-UI-20：`Select` 与 `Combobox` 展开瞬间触发 $O(N^2)$ 子项注册风暴，渲染期 $O(N^2)$ `findIndex`，且鼠标悬停引发全量 Context 级联重渲染

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/Select/SelectRoot.tsx:118-139,197-241`（及同构的 `ComboboxRoot.tsx:122-144,224-285`）：

```tsx
// SelectRoot.tsx:118-139
const registerItem = useCallback(
  (itemId: string, itemValue: string, itemDisabled = false, itemLabel = '') => {
    const newItem: RegisteredItemData = {
      id: itemId,
      value: itemValue,
      disabled: itemDisabled,
      label: itemLabel || itemValue,
      index: 0,
    };
    itemMapRef.current.set(itemValue, newItem);

    setItems((prev) => {
      const filtered = prev.filter((i) => i.id !== itemId);
      const next = [...filtered, newItem];
      return next.map((item, i) => ({ ...item, index: i }));
    });

    return () => {
      setItems((prev) => prev.filter((i) => i.id !== itemId));
    };
  },
  []
);
```

- `apps/crish-desktop/src/components/ui/Select/SelectItem.tsx:27-56`（及同构的 `ComboboxItem.tsx:31-60`）：

```tsx
// SelectItem.tsx:27-56
useEffect(() => {
  return registerItem(itemId, value, disabled, labelText);
}, [registerItem, itemId, value, disabled, labelText]);

const isSelected = ...;
const itemIndex = ctx.items.findIndex((i) => i.id === itemId);
const isHighlighted = ctx.highlightedIndex >= 0 && ctx.highlightedIndex === itemIndex;
...
const handleMouseEnter = useCallback(() => {
  if (!disabled && itemIndex >= 0) {
    ctx.setHighlightedIndex(itemIndex);
  }
}, [disabled, itemIndex, ctx]);
```

##### 2. 渲染管线与算法复杂度推导

当一个包含 $N$ 个选项（例如 80 个模型选项或语言选项）的 `<Select>` 或 `<Combobox>` 点击展开时：

1. **$O(N^2)$ 挂载期 `setItems` 函数式更新风暴**：
   - `SelectContent` 在 `open === true` 时挂载全部 $N$ 个 `<SelectItem>`；
   - $N$ 个 `<SelectItem>` 的 `useEffect` 在同一 Commit 后依次调用 `registerItem(...)`，入队 $N$ 个 `setItems((prev) => ...)` 函数式状态更新；
   - 第 $k$ 个更新执行 `prev.filter(...)`（$O(k)$）+ `[...filtered, newItem]`（$O(k)$）+ `next.map(...)`（分配 $k$ 个新对象，$O(k)$）。
   - $N$ 个子项挂载总共执行 $\sum_{k=1}^{N} 3k = \frac{3}{2}N(N+1) = O(N^2)$ 次数组遍历与对象克隆！当关闭浮层或 `Combobox` 输入过滤导致子项卸载时，又触发 $N$ 次 `setItems((prev) => prev.filter(...))` 的 $O(N^2)$ 卸载风暴！
2. **渲染期 $O(N^2)$ 的 `ctx.items.findIndex`**：
   - 在每一次渲染中，全部 $N$ 个 `<SelectItem>` / `<ComboboxItem>` 各自执行 `ctx.items.findIndex((i) => i.id === itemId)`（$O(N)$），全列表合算为 $O(N^2)$。
3. **鼠标滑过选项时的 $O(N)$ 全家桶级联重渲染**：
   - `SelectContext` / `ComboboxContext` 将高频瞬态 `highlightedIndex` 与静态配置、选中值 `value` 打包在同一个 `contextValue` 对象中（`SelectRoot.tsx:197-241`、`ComboboxRoot.tsx:224-285`）。
   - 用户移动鼠标每经过一个选项（`handleMouseEnter` → `ctx.setHighlightedIndex(itemIndex)`），`contextValue` 引用改变，迫使 **`<SelectTrigger>`、`<SelectValue>`、`<SelectContent>` 以及全部 $N$ 个 `<SelectItem>` 无条件重新渲染**（而实际上只有前一个高亮项和当前高亮项共 **2 个节点** 的 `isHighlighted` 布尔值发生了改变）！
4. **`staticMap` 每次父组件重渲染都遍历 JSX 树**：`SelectRoot.tsx:102-116` 与 `ComboboxRoot.tsx:104-120` 的 `useMemo` 依赖 `[options, children]`。由于 JSX `children` 在父组件每次渲染时都会生成新的 ReactElement 对象引用，`extractItemsFromChildren(children)` 在每次父组件渲染时都会递归遍历整棵 JSX 树。

##### 3. 修复方案与代码示例

1. **消除 `items` React State 与 $O(N^2)$ 注册风暴**：
   - 将已注册子项存储在可变引用 `itemsRef = useRef<RegisteredItemData[]>([])` 与索引表 `idToIndexMapRef = useRef<Map<string, number>>(new Map())` 中，或通过 microtask 批量合并更新，避免每个子项挂载时各自触发 $O(N)$ 的 `setItems` 数组重分配。
   - 建立 `idToIndexMap: Map<string, number>`，子项通过 `ctx.idToIndexMap.get(itemId) ?? -1` 以 **$O(1)$** 获取 `itemIndex`，消除 $O(N^2)$ 的 `findIndex`。
2. **拆分高频 `HighlightContext`（或外部订阅 Store）**：
   - 将 `SelectContext` / `ComboboxContext` 拆分为稳定的主 Context（不含 `highlightedIndex`）与轻量级高亮订阅（或通过 `useSyncExternalStore` 订阅 `highlightedIndex`，每个 `<SelectItem>` 选择器为 `() => store.getHighlightedIndex() === itemIndex`），使鼠标滑过选项时**仅重渲染旧高亮项与新高亮项 2 个组件（$O(1)$）**，其余 $N-2$ 个选项与 `<SelectTrigger>` 零重渲染！

---

#### PERF-UI-21：`ComboboxItem` 未缓存 `highlightMatches` 导致悬停时重复编译正则，且 `useFloatingPosition` 存在打开双 Commit

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/Select/ComboboxItem.tsx:72-74`：

```tsx
// ComboboxItem.tsx:72-74（未包裹 useMemo！）
const content =
  autoHighlight && typeof labelText === 'string'
    ? highlightMatches(children ?? labelText, ctx.query)
    : (children ?? labelText);
```

- `apps/crish-desktop/src/components/ui/Select/internal/comboboxHighlight.tsx:21-36`：

```tsx
// comboboxHighlight.tsx:21-36
const escaped = trimmed.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
const splitRegex = new RegExp(`(${escaped})`, 'gi');
const testRegex = new RegExp(`^${escaped}$`, 'i');

const parts = str.split(splitRegex);
if (parts.length <= 1) return str;

return parts.map((part, i) =>
  testRegex.test(part) ? (
    <span key={i} className={styles.highlightText}>
      {part}
    </span>
  ) : (
    part
  )
);
```

- `apps/crish-desktop/src/components/ui/Select/useFloatingPosition.ts:75-153`：
  浮层打开时初始 `isPositioned: false`（`visibility: hidden`），在 `useLayoutEffect` 中测量后再 `setPosition({ ..., isPositioned: true })` 触发第二次 React Render + Commit，同时把 `--anchor-width` 写入 `content.style.setProperty` 导致 `SelectContent.module.css:20-22` 的 `width: max(calc(var(--anchor-width) + 20px), 220px)` 在 `getBoundingClientRect()` **之后**才生效，造成首次测量的 `contentRect.width` 与设置 `--anchor-width` 后的实际宽度不一致！

##### 2. 渲染管线与算法复杂度推导

1. 在 `ComboboxItem.tsx:72-74` 中，由于 `content` 未用 `useMemo` 缓存，当鼠标在下拉列表中移动触发 `highlightedIndex` 变化时（见 PERF-UI-20），全部 $N$ 个 `<ComboboxItem>` 重新执行 `highlightMatches`：每次悬停都会编译 $2N$ 个 `RegExp` 实例、执行 $N$ 次正则 `split` 和 $N \times K$ 次 `testRegex.test(part)`！
2. 而在 `highlightMatches` 内部，当使用带单个捕获括号的 `str.split(new RegExp(`(${escaped})`, 'gi'))` 时，根据 ECMAScript `String.prototype.split` 规范，**所有奇数下标 `i % 2 === 1` 的元素必定是正则捕获组匹配到的子串**，根本不需要创建第二个 `testRegex` 并对每段调用 `testRegex.test(part)`！
3. 在 `useFloatingPosition.ts:95-103` 中，先调用了 `content.getBoundingClientRect()`（第 96 行），然后才在后面（第 102 行）执行 `content.style.setProperty('--anchor-width', `${triggerRect.width}px`)`！这不仅造成「读后写」测量失准（第 96 行测量的是未注入 `--anchor-width` 时的旧宽度），还在下一帧触发 ResizeObserver 二次修正重排。

##### 3. 修复方案与代码示例

1. 在 `ComboboxItem.tsx` 中用 `useMemo(() => ..., [autoHighlight, labelText, children, ctx.query])` 缓存 `content`。
2. 在 `comboboxHighlight.tsx` 中移除 `testRegex`，直接利用 `i % 2 === 1` O(1) 判定命中段：

```tsx
// comboboxHighlight.tsx 修复后
const escaped = trimmed.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
const parts = str.split(new RegExp(`(${escaped})`, 'gi'));
if (parts.length <= 1) return str;

return parts.map((part, i) =>
  i % 2 === 1 ? (
    <span key={i} className={styles.highlightText}>
      {part}
    </span>
  ) : (
    part
  )
);
```

3. 在 `useFloatingPosition.ts:94` 中，先读取 `trigger.getBoundingClientRect()`，立即写入 `content.style.setProperty('--anchor-width', `${triggerRect.width}px`)`，然后再读取 `content.getBoundingClientRect()`，保证单次测量精确到位。

---

### 第五部分：自定义滚动容器 `ScrollArea`、图标系统与基础原子控件（PERF-UI-22 ~ PERF-UI-26）

---

#### PERF-UI-22：`ScrollArea` 在非对应 `type` 下仍因悬停/滚动起止触发全组件重渲染，`getMetrics()` 返回陈旧状态，且 `ScrollAreaScrollBar` 未记忆化

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.tsx:184-213,326-336,370,400-404`：

```tsx
// ScrollArea.tsx:326-336
if (!isScrollingRef.current) {
  isScrollingRef.current = true;
  setIsScrolling(true);
}
if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
idleTimerRef.current = window.setTimeout(() => {
  isScrollingRef.current = false;
  setIsScrolling(false);
  onScrollIdle?.();
}, 150);

// ScrollArea.tsx:400-404
onMouseEnter={() => setIsHovered(true)}
onMouseLeave={() => {
  setIsHovered(false);
  rigidBrake();
}}
```

- `apps/crish-desktop/src/components/ui/ScrollArea/ScrollAreaScrollBar.tsx:32,68,103,134,169`：
  `ScrollAreaScrollBar` 未使用 `React.memo`，且每次渲染执行 `onButtonPointerDown('up')` / `onButtonPointerDown('down')` 分配新闭包。

##### 2. 渲染管线与算法复杂度推导

1. **无意义的 React 重渲染**：
   - 当 `type` 为默认的 `'hover'`、`'always'` 或 `'auto'` 时，`isScrolling` 状态根本不参与 `isBarVisibleY` / `isBarVisibleX`（第 375–388 行）的计算！然而 `handleScroll` 在每次滚动开始和停止后 150ms 依然无条件调用 `setIsScrolling(true)` 和 `setIsScrolling(false)`，导致每次滚动起止都无故触发整个 `<ScrollArea>` 重渲染！
   - 同理，当 `type` 为 `'always'`、`'auto'` 或 `'scroll'` 时，`isHovered` 根本不影响滚动条显隐，但鼠标每次进出 `<ScrollArea>` 仍无条件调用 `setIsHovered(true/false)` 触发重渲染！
2. **`metrics.scrollTop` / `progressY` 陈旧状态失步（Stale State Bug）**：
   - `updateMetrics`（第 184–213 行）为了避免 60Hz 重渲染，在中间滚动帧跳过了 `setMetrics`。但这也导致 React state 中的 `metrics.scrollTop` 和 `metrics.progressY` 停留在刚离开顶部那一帧的旧值（如 `scrollTop = 2px`）！
   - 于是：① 外部通过 `ref.current.getMetrics()`（第 370 行）读取到的 `scrollTop` 和 `progressY` 是完全错误的陈旧值；② 当滚动过程中 `scrollHeight` 动态增长（如流式对话输出触发 ResizeObserver）导致 `setMetrics` 真正触发重渲染时，或当 `useThumbDrag` 结束拖拽调用 `setIsDraggingY(false)` 重渲染时，需确保最新 `progressY` 同步，避免滑块位置回跳。

##### 3. 修复方案与代码示例

1. 仅当 `type === 'scroll'` 时才调用 `setIsScrolling(true/false)`；仅当 `type === 'scroll' || onScrollIdle !== undefined` 时才设置 150ms `idleTimerRef` 定时器！
2. 仅当 `type === 'hover'` 时才在 `onMouseEnter`/`onMouseLeave` 中调用 `setIsHovered(true/false)`！
3. 用 `metricsRef` 实时记录最新 `ScrollMetrics` 供 `getMetrics()` 同步返回；并在 `ScrollAreaScrollBar` 外包裹 `React.memo`，将步进按钮方向通过 `data-dir="up"` 属性配合单一稳定回调处理。

---

#### PERF-UI-23：`CopyIcon` 为单个 24px 图标挂载完整 Framer Motion 运行时与 4 个 `VisualElement`；`AppIcon` 自定义图标每次渲染创建双层内联 `style` 对象

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/animated-icons/CopyIcon.tsx:57-58,98-180`：

```tsx
// CopyIcon.tsx:57-58, 132-180
const controls = useAnimation();
const reduced = useReducedMotion();
...
return (
  <LazyMotion features={domMin} strict>
    <m.div ...>
      <m.svg ...>
        <m.rect variants={boxVariants} animate={controls} ... />
        <m.path variants={pathVariants} animate={controls} ... />
      </m.svg>
    </m.div>
  </LazyMotion>
);
```

- `apps/crish-desktop/src/components/ui/icons/AppIcon.tsx:65-78` 与 `customIcons.tsx:17-40`：

```tsx
// AppIcon.tsx:69-76
<Component
  size={px}
  className={className}
  strokeWidth={strokeWidth}
  style={{ color, fill, ...style }}
  {...a11y}
  {...testAttr}
/>
// customIcons.tsx:32-37
style: {
  display: 'inline-block',
  verticalAlign: 'middle',
  flexShrink: 0,
  ...style,
},
```

##### 2. 渲染管线与算法复杂度推导

1. **`CopyIcon` 过度运行时开销**：`<CopyIcon>` 被广泛挂载在聊天消息操作栏、代码块头部、工具调用卡片等高频位置。每一个 `<CopyIcon>` 实例都独立挂载 `<LazyMotion>` Context Provider、实例化 `useAnimation()` 控制器、调用 `useReducedMotion()` 监听媒体查询，并为单个小图标创建 `<m.div>`、`<m.svg>`、`<m.rect>`、`<m.path>` **4 个 Framer Motion `VisualElement` 实例**（其中 `<m.div>` 和 `<m.svg>` 甚至没有任何动画属性！），每次渲染还重新创建 `defaultTransition`、`boxVariants`、`pathVariants` 对象。
2. **`AppIcon` 自定义图标内联样式分配**：`AppIcon` 中 `entry.kind === 'custom'` 的 18 个高频图标（包括所有 `chevron-*`、`folder`、`edit`、`refresh`、`settings` 等）在每次渲染时都会新建两层 `{ ...style }` 对象。

##### 3. 修复方案与代码示例

1. 将 `CopyIcon.tsx` 的 `defaultTransition`、`boxVariants`、`pathVariants` 提升为模块级常量，并将无动画的 `<m.div>` 与 `<m.svg>` 降级为原生 `<div>` 与 `<svg>`（或直接改用纯 CSS `transition: transform` 驱动 `<rect>` 与 `<path>`，实现 0 Framer Motion 实例开销）。
2. 在 `customIcons.tsx` 中通过静态 CSS 类（或模块级冻结默认 `DEFAULT_CUSTOM_ICON_STYLE` 对象在无额外 `color`/`fill`/`style` 时直接复用引用）消除每次渲染的双层对象分配。

---

#### PERF-UI-24：`SegmentedControl` 在 `useEffect`（Paint 之后）测量 DOM 造成首帧闪烁与二次 Commit；`Tabs` 维护从不读取的 `triggerMapRef`

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx:88,107-141`：

```tsx
// SegmentedControl.tsx:88 — 每次渲染分配新数组
const options = rawOptions.map(normalizeOption);
...
// SegmentedControl.tsx:139-141 — 使用 useEffect 而非 useLayoutEffect！
useEffect(() => {
  updateSlider();
}, [currentValue, options.length, size, updateSlider]);
```

- `apps/crish-desktop/src/components/ui/Tabs/Tabs.tsx:53-65,170-172,345-348`：

```tsx
// Tabs.tsx:53-65 — triggerMapRef 写入但全文件从未读取！
const triggerMapRef = useRef<Map<string, HTMLElement>>(new Map());
```

##### 2. 渲染管线与算法复杂度推导

1. `SegmentedControl.tsx:139` 使用 `useEffect` 而非 `useLayoutEffect` 调用 `updateSlider()`。当用户点击切换分段项或组件首次挂载时：
   - 第 1 帧：React Commit 新选中态文字高亮，浏览器完成 Layout + Paint（此时滑块 `.activeSlider` 仍停留在旧位置或 `opacity: 0`）；
   - Paint 结束后：`useEffect` 异步执行，读取 `activeItem.offsetLeft` / `offsetWidth`（触发 Layout Read），然后调用 `setSliderStyle` + `setIsReady(true)`，触发**第 2 帧 React Render + Commit**，滑块才开始移动！
2. `Tabs.tsx` 中每个 `<TabsTrigger>` 在挂载/卸载时通过 `useEffect` 调用 `registerTrigger(itemValue, triggerRef.current)` 维护 `triggerMapRef`，但 `TabsList` 在 `updateIndicator`（第 170 行）中却弃之不用，反而每次调用 `listEl.querySelector('[data-tabs-trigger][data-value="..."]')`。

##### 3. 修复方案与代码示例

1. 将 `SegmentedControl.tsx:139` 的 `useEffect` 改为 `useLayoutEffect`，确保在浏览器首帧绘制前同步完成滑块几何测量与状态合并，并用 `useMemo` 缓存 `options = useMemo(() => rawOptions.map(normalizeOption), [rawOptions])`。
2. 在 `Tabs.tsx` 中让 `TabsList` 直接从 `triggerMapRef.current.get(value)` 以 $O(1)$ 获取 `activeTrigger` 节点，消除 `querySelector` DOM 查询。

---

#### PERF-UI-25：`Slider` 在拖拽期（120–1000Hz）每帧调用 `getBoundingClientRect()`，且 `.filledTrack` 宽度更新与 CSS `transition: width` 发生冲突

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/Slider/Slider.tsx:74-105`：

```tsx
// Slider.tsx:74-92
const updateFromPointer = useCallback(
  (clientX: number) => {
    if (!trackRef.current || disabled) return;
    const rect = trackRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const rawPercent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    ...
```

- `apps/crish-desktop/src/components/ui/Slider/Slider.module.css:46-51`：

```css
.filledTrack {
  height: 100%;
  background-color: var(--brand);
  border-radius: inherit;
  transition: width var(--transition-micro);
}
```

##### 2. 渲染管线与算法复杂度推导

1. 当用户按住滑块拖动时，`handlePointerMove` 在每次 `pointermove` 事件中都调用 `trackRef.current.getBoundingClientRect()`。由于每次 `pointermove` 都会通过 `onChange` 更新滑块及外部受控状态（弄脏 DOM），下一帧 `pointermove` 的 `getBoundingClientRect()` 就会强制触发同步回流（Forced Synchronous Layout）！
2. 同时，`.filledTrack` 带有 `transition: width var(--transition-micro)`（120ms），在连续拖拽期间每帧设置新的 `style={{ width: `${percentage}%` }}` 会不断打断并重启 120ms 的主线程 `width` 过渡动画，造成视觉跟手滞后（Rubber-banding Lag）与每帧连续 Layout。

##### 3. 修复方案与代码示例

1. 在 `handlePointerDown` 时测量一次 `trackRef.current.getBoundingClientRect()` 并缓存在 `dragRectRef.current` 中，`handlePointerMove` 直接读取 `dragRectRef.current`（拖拽过程 0 次 `getBoundingClientRect()` 调用！）。
2. 在拖拽状态（`data-dragging="true"`）下禁用 `.filledTrack` 的过渡（`transition: none`），并将 `.filledTrack` 改为 `transform: scaleX(...)` 合成器动画（同 PERF-UI-05）。

---

#### PERF-UI-26：`SmartModelBadge` 在 `inline-flex` 上无显式宽度启用 `container-type: inline-size` 导致内联尺寸折叠与三倍文本 DOM

##### 1. 精确代码锚点与原样摘录

- `apps/crish-desktop/src/components/ui/SmartModelBadge.module.css:7-13,49-88`：

```css
.badgeContainer {
  display: inline-flex;
  align-items: center;
  container-type: inline-size;
  container-name: modelBadge;
  max-width: 100%;
  vertical-align: middle;
}
```

- `apps/crish-desktop/src/components/ui/SmartModelBadge.tsx:62-66`：

```tsx
<>
  <span className={styles.standardSpan}>{abbr.standard}</span>
  <span className={styles.compactSpan}>{abbr.compact}</span>
  <span className={styles.microSpan}>{abbr.micro}</span>
</>
```

##### 2. 渲染管线与算法复杂度推导

1. **CSS Inline-Size Containment 折叠陷阱**：根据 W3C CSS Containment Module Level 3 规范，`container-type: inline-size` 会对元素施加内联轴尺寸遏制（Inline-Size Containment），使其在计算自身固有宽度（Intrinsic Inline Size）时表现为没有子内容（宽度坍缩为 `0px`）！由于 `.badgeContainer` 声明为 `display: inline-flex` 且没有设置 `width: 100%` 或 `flex: 1`，在任何非拉伸父容器中它的容器查询宽度恒为 `0px`，导致 `@container modelBadge (min-width: 130px)` 与 `(min-width: 220px)` 永远无法命中，且每个徽标都额外建立了一个 CSS Container Query 评估上下文和内部 `<Tooltip>` 实例（见 PERF-UI-08/10）。
2. **三倍 DOM 节点与文本复制污染**：即使在默认情况下，每个未传 `forceTier` 的 `<SmartModelBadge>` 都同时渲染 3 个 `<span>`（`standardSpan`、`compactSpan`、`microSpan`）。

##### 3. 修复方案与代码示例

- 若需使用容器查询自适应，容器查询宿主必须是外层具有确定块级/弹性宽度的父槽位（或 `.badgeContainer` 设置 `display: flex; width: 100%; min-width: 0`）；
- 在绝大多数固定紧凑槽位（如顶栏、消息头、卡片头）直接传入明确的 `forceTier="compact"` 或 `"standard"`，避免创建无意义的 `container-type: inline-size` 上下文与三份冗余 `<span>` DOM。

---

## 三、立体验证断言与防回归门禁设计（Verification & Guardrails）

为确保上述 26 项性能问题修复后实现架构净收敛且永不回潮，设计以下三层自动化验证与门禁断言：

### 1. 静态规范与 CSS 管线门禁断言（CI 快层守门）

1. **禁止全局 `[class*=...]` 子串选择器门禁**：
   - 断言规则：扫描 `apps/crish-desktop/src/styles/**/*.css`，断言 `[class*=` 与 `[class^=` 出现次数为 `0`。
2. **禁止 `transition: all` 与非合成几何属性 `will-change` 门禁**：
   - 断言规则：扫描 `apps/crish-desktop/src/**/*.css`，断言 `/transition\s*:[^;]*\ball\b/` 匹配数为 `0`；断言 `/will-change\s*:[^;]*(width|height|top|left|margin|padding|background)/` 匹配数为 `0`。
3. **禁止 `body *` 右端通配符规则**：
   - 断言规则：`shell-reset.css` 中不包含 `body.leaf-dock-resizing *`。

### 2. 单元与集成级性能契约测试（Vitest 确定性断言）

1. **`tooltipController` $O(1)$ 空闲短路测试**：
   - 挂载 100 个 `<Tooltip>` 实例（均未悬停打开），Spy `document.body.querySelectorAll` 与各实例 `setState`；触发 `window.dispatchEvent(new Event('scroll'))` 与 `document.dispatchEvent(new PointerEvent('pointerdown'))`；断言 `querySelectorAll` 调用次数为 `0`，未激活实例的 `hide()` 调用次数为 `0`。
2. **`SafeAimEngine` 与 `SmartPanel` 零泄露测试**：
   - 挂载 `<SmartExpandablePanel isOpen={false} />`、`<SmartPanel open={false} items={[]} onClose={vi.fn()} />` 与 `<PreviewCard>`；断言 `document.body.querySelectorAll('svg#sepSafeAimOverlay')` 数量为 `0`，断言 `window.addEventListener` 未被注册 `mousemove` 监听器。
3. **`LayerStackManager` 单次事件处理与空栈短路测试**：
   - 当图层栈为空时派发 `pointerdown` / `pointerup` / `keydown`，断言监听器在首行短路返回且不重复绑定 `window` + `document`。
4. **`Select` / `Combobox` 悬停局部更新测试**：
   - 挂载含 50 个选项的 `<Select>` 或 `<Combobox>` 并展开，模拟鼠标从第 1 项移入第 2 项（`fireEvent.mouseEnter`），通过渲染计数器断言 `<SelectTrigger>` 重渲染次数为 `0`，子项重渲染数量 $\le 2$（而非 50），且 `comboboxHighlight` 不在未变更 `query` 的项上重新创建 `RegExp`。

### 3. 真实桌面宿主现场验收指标（Tauri MCP 4000 通道）

- **滚动与点击帧耗基线**：在挂载 $\ge 150$ 个 `<Tooltip>` 与 50 条流式 Markdown 消息的会话视口中连续滚动，Performance 面板记录单帧 `Recalculate Style` $\le 1.2\text{ms}$、滚动期间 `Tooltip` 相关 JS 耗时为 `0ms`。
- **合成层数量基线**：打开 Settings 面板（含多个 `Switch`、`SegmentedControl`、`Tabs`、`ScrollArea`），静止态 GPU 合成层数相比修复前下降 $\ge 60\%$，无非交互态常驻 `will-change` 图层。
