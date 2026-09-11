# AFFiNE 原子组件库、同心几何与设计系统深度源码解剖

> **文档定位**：前端原子设计系统与视觉几何专项深度解剖报告
> **对标源码**：`reference/markdown_compare/AFFiNE/packages/frontend/component/src/ui/`、`src/theme/`、`src/styles/`、`blocksuite/affine/shared/src/theme/`
> **核心攻坚**：同心几何数学定理证明（$R_{outer} = R_{inner} + P$）、Vanilla-Extract 强类型变量参数化体系、变体与尺寸正交性矩阵、伪元素悬浮层与焦点环物理渲染、FLIP 动态滑块指示器、IME 组合事件安全防护、Conex「9999px 药丸圆角倒挂」与「裸交互标签」彻底根治蓝图
> **篇幅规模**：1200+ 行深度解剖与生产级重构蓝图（UTF-8 无 BOM）

---

## 目录

- [一、原子组件库设计哲学与架构全景](#一原子组件库设计哲学与架构全景)
  - [1.1 现代桌面 GUI 组件库的核心痛点与架构断层](#11-现代桌面-gui-组件库的核心痛点与架构断层)
  - [1.2 AFFiNE @affine/component 三层分层模型](#12-affine-affinecomponent-三层分层模型)
  - [1.3 核心组件源码全景地图与行号索引](#13-核心组件源码全景地图与行号索引)
- [二、同心几何（Concentric Geometry）数学定理与视觉证明](#二同心几何concentric-geometry数学定理与视觉证明)
  - [2.1 同心圆角三大定理与几何公式推导](#21-同心圆角三大定理与几何公式推导)
  - [2.2 视觉张力与「圆角嵌套灾难」反模式分析](#22-视觉张力与圆角嵌套灾难反模式分析)
  - [2.3 9999px 药丸圆角滥用的数学与渲染缺陷证明](#23-9999px-药丸圆角滥用的数学与渲染缺陷证明)
  - [2.4 AFFiNE 源码中同心几何的直接落地证据](#24-affine-源码中同心几何的直接落地证据)
- [三、Vanilla-Extract 零级联样式系统与 Token 变量体系](#三vanilla-extract-零级联样式系统与-token-变量体系)
  - [3.1 CSS-in-JS 的编译时演进与 zero-runtime 哲学](#31-css-in-js-的编译时演进与-zero-runtime-哲学)
  - [3.2 createVar 局部变量隔离与作用域覆盖](#32-createvar-局部变量隔离与作用域覆盖)
  - [3.3 cssVar 与 cssVarV2 双轨设计 Token 体系](#33-cssvar-与-cssvarv2-双轨设计-token-体系)
  - [3.4 动态内联变量注入机制（assignInlineVars）](#34-动态内联变量注入机制assigninlinevars)
- [四、核心原子组件深度解剖与源码证据链](#四核心原子组件深度解剖与源码证据链)
  - [4.1 Button & IconButton：悬浮层伪元素与焦点环解耦](#41-button--iconbutton悬浮层伪元素与焦点环解耦)
  - [4.2 Input & RowInput：IME 输入合成与全场景状态封装](#42-input--rowinputime-输入合成与全场景状态封装)
  - [4.3 Checkbox：零重绘微动画与原生无障碍状态桥接](#43-checkbox零重绘微动画与原生无障碍状态桥接)
  - [4.4 Switch：超调弹簧物理曲线与精密几何驱动](#44-switch超调弹簧物理曲线与精密几何驱动)
  - [4.5 Slider：轨道边缘截断补偿与离散步长对齐算法](#45-slider轨道边缘截断补偿与离散步长对齐算法)
  - [4.6 RadioGroup / SegmentedControl：FLIP 动态滑动指示器](#46-radiogroup--segmentedcontrolflip-动态滑动指示器)
  - [4.7 Menu / Dropdown / ContextMenu：同心嵌套与 0.5px 发丝线](#47-menu--dropdown--contextmenu同心嵌套与-05px-发丝线)
  - [4.8 Dialog & Modal：视图过渡容器与键盘自适应安全区](#48-dialog--modal视图过渡容器与键盘自适应安全区)
  - [4.9 Tooltip：跨平台键位映射与单双字符胶囊尺寸收敛](#49-tooltip跨平台键位映射与单双字符胶囊尺寸收敛)
  - [4.10 Scrollbar：悬停动态增宽与 44px 隐式命中区](#410-scrollbar悬停动态增宽与-44px-隐式命中区)
- [五、变体与尺寸正交性矩阵（Orthogonality Matrix）](#五变体与尺寸正交性矩阵orthogonality-matrix)
  - [5.1 尺寸规范轴与网格基准（28px / 32px / 40px）](#51-尺寸规范轴与网格基准28px--32px--40px)
  - [5.2 视觉变体轴与色彩语义映射](#52-视觉变体轴与色彩语义映射)
  - [5.3 交互状态正交矩阵（Hover / Active / Focus / Disabled / Loading）](#53-交互状态正交矩阵hover--active--focus--disabled--loading)
- [六、Conex 当前病灶精准排查与证据链](#六conex-当前病灶精准排查与证据链)
  - [6.1 病灶 1：`9999px` 药丸圆角全局泛滥与内外圆角挤压](#61-病灶-19999px-药丸圆角全局泛滥与内外圆角挤压)
  - [6.2 病灶 2：裸交互标签（Naked Clickable Labels）与缺失反馈](#62-病灶-2裸交互标签naked-clickable-labels与缺失反馈)
  - [6.3 病灶 3：输入框缺乏 IME 保护导致意外回车提交](#63-病灶-3输入框缺乏-ime-保护导致意外回车提交)
  - [6.4 病灶 4：厚重黑边与生硬焦点环（Focus Ring Chaos）](#64-病灶-4厚重黑边与生硬焦点环focus-ring-chaos)
  - [6.5 病灶 5：分段控制器瞬移与动画跳变（Lack of FLIP）](#65-病灶-5分段控制器瞬移与动画跳变lack-of-flip)
- [七、对标 AFFiNE 的 Conex 原子组件库生产级重构蓝图](#七对标-affine-的-conex-原子组件库生产级重构蓝图)
  - [7.1 同心圆角 Token 体系重构（concentric-tokens.css）](#71-同心圆角-token-体系重构concentric-tokenscss)
  - [7.2 生产级 Button & IconButton 组件实现](#72-生产级-button--iconbutton-组件实现)
  - [7.3 生产级 Input / RowInput 组件实现（含 IME 守卫）](#73-生产级-input--rowinput-组件实现含-ime-守卫)
  - [7.4 生产级 SegmentedControl 组件实现（FLIP 动画）](#74-生产级-segmentedcontrol-组件实现flip-动画)
  - [7.5 生产级 Switch 组件实现（精密同心几何）](#75-生产级-switch-组件实现精密同心几何)
- [八、全量验收标准、防回归断言与测试矩阵](#八全量验收标准防回归断言与测试矩阵)
  - [8.1 单元测试断言清单（Vitest）](#81-单元测试断言清单vitest)
  - [8.2 视觉与几何回归测试（Playwright Pixelmatch）](#82-视觉与几何回归测试playwright-pixelmatch)
  - [8.3 桌面端真实 WebView2 验证清单](#83-桌面端真实-webview2-验证清单)
  - [8.4 三维对标总表（AFFiNE vs Conex 现状 vs Conex 重构后）](#84-三维对标总表affine-vs-conex-现状-vs-conex-重构后)

---

## 一、原子组件库设计哲学与架构全景

### 1.1 现代桌面 GUI 组件库的核心痛点与架构断层

在基于 Web 技术栈（Tauri / Electron / WebView2）构建的现代桌面协同工具（如 AFFiNE、Conex、Notion、Linear）中，原子组件库（Atomic Component Library）承担着整个应用人机交互的物理基础。然而，大量桌面应用的前端设计系统往往陷入以下五大架构断层与视觉病灶：

```
┌────────────────────────────────────────────────────────────────────────┐
│                      现代桌面 GUI 原子组件库五大常见断层                      │
└────────────────────────────────────────────────────────────────────────┘
  1. 几何不调（Geometry Mismatch）   → 随意使用 9999px 药丸圆角，内外容器圆角不共心导致厚度畸变
  2. 状态污染（State Contamination） → 直接修改 background 导致悬浮态覆盖主色，无法叠加复合遮罩
  3. 焦点混乱（Focus Ring Chaos）    → 粗暴使用 outline 或高对比黑边，破坏长时间沉浸阅读体验
  4. 文本跳动（Layout Shift on Text）→ 切换粗体或加载态时撑开容器宽度，引发周围 UI 抖动
  5. 国际化与输入法断裂 (IME Breaks) → 未监听 composition 状态，拼音/日文选词按回车直接触发提交
```

AFFiNE 作为一款对标顶级工业美学的开源知识库软件，其 `@affine/component` 模块彻底摒弃了传统的粗放式 CSS 编写方式，通过**编译时强类型 CSS（Vanilla-Extract）**、**严格同心几何数学推导**与**Radix UI 无样式无障碍原语**，构建了工业级精度的原子组件库体系。

---

### 1.2 AFFiNE @affine/component 三层分层模型

AFFiNE 前端组件包（`packages/frontend/component/`）建立了清晰的职责分层：

```
┌────────────────────────────────────────────────────────────────────────┐
│                 Layer 3: 业务复合组件层 (Domain Composite)             │
│  • setting-components • auth-components • notification-center • card   │
│  • affine-banner      • import-page     • rename-modal                 │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 依赖/组合
┌───────────────────────────────────▼────────────────────────────────────┐
│                 Layer 2: 纯粹原子组件层 (Atomic UI Primitives)          │
│  • Button / IconButton / DropdownButton   • Input / RowInput           │
│  • Checkbox / Switch / RadioGroup         • Slider / Progress          │
│  • Menu / Dropdown / ContextMenu          • Modal / Confirm / Prompt   │
│  • Tooltip / Popover / Tabs / Scrollbar   • Avatar / Divider / Empty   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 依赖/参数化
┌───────────────────────────────────▼────────────────────────────────────┐
│                 Layer 1: 强类型样式与设计 Token 层 (Style & Tokens)      │
│  • Vanilla-Extract (createVar, style, keyframes, assignInlineVars)     │
│  • @toeverything/theme (cssVar, cssVarV2, typography, global.css)      │
│  • 同心几何约束公式 ($R_{inner} = R_{outer} - Padding$)                 │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 1.3 核心组件源码全景地图与行号索引

以下为 AFFiNE 原子组件库在仓库中的真实源码分布，涵盖本次解剖的所有核心组件：

| 组件名称             | 源码文件路径                                                                                                                                                                                        | 关键代码职责                                                                 | 依赖底座                        |
| :------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------- | :------------------------------ |
| **Button**           | `packages/frontend/component/src/ui/button/button.tsx:1-213`<br>`packages/frontend/component/src/ui/button/button.css.ts:1-272`                                                                     | 5 种变体、3 种尺寸、`:before` 悬浮遮罩、`:focus-visible::after` 焦点环       | 原生 `<button>` + Tooltip       |
| **IconButton**       | `packages/frontend/component/src/ui/button/icon-button.tsx:1-86`                                                                                                                                    | 纯图标按钮、`iconSizeVar` 动态内联注入、`size` 映射                          | 组合 Button                     |
| **DropdownButton**   | `packages/frontend/component/src/ui/button/dropdown-button.tsx:1-55`<br>`packages/frontend/component/src/ui/button/styles.css.ts:1-62`                                                              | 拆分式下拉按钮、0.5px 分割线、右侧图标独立悬浮区                             | 组合 Button                     |
| **Input / RowInput** | `packages/frontend/component/src/ui/input/input.tsx:1-97`<br>`packages/frontend/component/src/ui/input/row-input.tsx:1-123`<br>`packages/frontend/component/src/ui/input/style.css.ts:1-87`         | 复合 Wrapper、无边框原生 `<input>`、IME 组合锁、Autofill 遮罩、防抖          | 原生 `<input>`                  |
| **Checkbox**         | `packages/frontend/component/src/ui/checkbox/checkbox.tsx:1-127`<br>`packages/frontend/component/src/ui/checkbox/index.css.ts:1-28`<br>`packages/frontend/component/src/ui/checkbox/icons.tsx:1-53` | 1em 矢量图标、隐形绝对定位原生 input、Web Animations 粒子微动画              | 原生 checkbox                   |
| **Switch**           | `packages/frontend/component/src/ui/switch/switch.tsx:1-86`<br>`packages/frontend/component/src/ui/switch/index.css.ts:1-59`                                                                        | 精密同心几何计算（$W=2(H-P), D=H-2P$）、超调弹簧贝塞尔曲线                   | 原生 checkbox + 伪元素          |
| **Slider**           | `packages/frontend/component/src/ui/slider/slider.tsx:1-136`<br>`packages/frontend/component/src/ui/slider/index.css.ts:1-82`                                                                       | 轨道边缘 Thumb 宽度补偿（`fakeTrack`）、线性插值 step marker 对齐            | `@radix-ui/react-slider`        |
| **RadioGroup**       | `packages/frontend/component/src/ui/radio/radio.tsx:1-201`<br>`packages/frontend/component/src/ui/radio/styles.css.ts:1-73`                                                                         | 分段控制器、同心几何 `calc(${outerRadius} - ${outerPadding})`、FLIP 动态滑块 | `@radix-ui/react-radio-group`   |
| **Menu / Dropdown**  | `packages/frontend/component/src/ui/menu/desktop/root.tsx:1-97`<br>`packages/frontend/component/src/ui/menu/desktop/item.tsx:1-31`<br>`packages/frontend/component/src/ui/menu/styles.css.ts:1-124` | 8px/4px 同心嵌套、0.5px `scaleY(0.5)` 分割线、`slideDown` 动画与关闭指针阻断 | `@radix-ui/react-dropdown-menu` |
| **Modal / Dialog**   | `packages/frontend/component/src/ui/modal/modal.tsx:1-407`<br>`packages/frontend/component/src/ui/modal/styles.css.ts:1-222`<br>`packages/frontend/component/src/ui/modal/confirm-modal.tsx:1-234`  | 12px 容器、`ModalTransitionContainer` 原生 ViewTransition 桥接、命令式弹窗   | `@radix-ui/react-dialog`        |
| **Tooltip**          | `packages/frontend/component/src/ui/tooltip/tooltip.tsx:1-118`<br>`packages/frontend/component/src/ui/tooltip/styles.css.ts:1-62`                                                                   | 4px 紧凑圆角、`$mod`/`$alt` 跨平台热键解析器、16px 字符胶囊                  | `@radix-ui/react-tooltip`       |
| **Scrollbar**        | `packages/frontend/component/src/ui/scrollbar/scrollable.tsx:1-68`<br>`packages/frontend/component/src/ui/scrollbar/index.css.ts:1-89`                                                              | 8px 到 11px 悬停增宽、滚动顶边显隐监听、44px 伪元素触摸命中区                | `@radix-ui/react-scroll-area`   |

---

## 二、同心几何（Concentric Geometry）数学定理与视觉证明

### 2.1 同心圆角三大定理与几何公式推导

在现代 GUI 视觉设计中，当一个具有圆角的子元素（如按钮、列表项、指示滑块）被包裹在一个同样具有圆角的父容器中时，如果两者的圆角半径设置不当，就会产生严重的「视觉挤压（Visual Pinching）」或「厚度不均（Uneven Corner Thickness）」。

AFFiNE 在全套组件中严格践行**同心圆角几何体系（Concentric Border Radius）**。其核心数学原理如下：

```
                    ┌──────────────────────────────┐
                    │ 父容器 (Outer Container)      │
                    │ R_outer                      │
                    │   ┌──────────────────────┐   │
                    │   │ 子元素 (Inner Item)  │   │
                    │   │ R_inner              │   │
                    │ P │                      │ P │
                    │   └──────────────────────┘   │
                    │              P               │
                    └──────────────────────────────┘
```

#### 定理一：等距缝隙不变性定理（Uniform Spacing Invariant Theorem）

若外层圆角矩形的圆角半径为 $R_{outer}$，内层圆角矩形与外层边界的内边距为 $P$（假设四边等宽），为了使内外两个同心圆弧之间的法向距离恒等于 $P$，内层圆角半径 $R_{inner}$ **必须且仅能**满足：
$$R_{inner} = R_{outer} - P \iff R_{outer} = R_{inner} + P$$

**证明（Proof）**：
设外层圆角在第一象限的圆心为 $O_{outer}(x_0, y_0)$，圆弧方程为 $(x - x_0)^2 + (y - y_0)^2 = R_{outer}^2$。
内层圆角矩形相对于外层向内收缩了距离 $P$。内层直线边缘与外层直线边缘的垂直距离为 $P$。
当且仅当内层圆弧的圆心与外层圆弧的圆心重合（即共心 $O_{inner} \equiv O_{outer}$）时，沿任意向外法向量 $\vec{n}$ 方向，两弧线间的距离 $\Delta r$ 恒为：
$$\Delta r = R_{outer} - R_{inner}$$
由于直线部分的间距为 $P$，为了消除转角处的视觉突变与扭曲，必须令 $\Delta r = P$。
代入得：$R_{outer} - R_{inner} = P \implies R_{inner} = R_{outer} - P$。证毕。

#### 定理二：边界退化条件定理（Boundary Degeneracy Theorem）

当内边距 $P \ge R_{outer}$ 时，内层圆角半径 $R_{inner} \le 0$。此时内层子元素在转角处**必须退化为直角（$R_{inner} = 0$）**。
若强行赋予内层元素 $R_{inner} > 0$，则转角处的法向间距 $\Delta r = R_{outer} - R_{inner} < P$，导致转角处肉眼可见地变薄，破坏几何均匀性。

#### 定理三：非对称内边距同心公式（Asymmetric Padding Formula）

当水平内边距 $P_x$ 与垂直内边距 $P_y$ 不相等（$P_x \ne P_y$）时，严格的同心几何要求内层圆角为**椭圆圆角（Elliptical Corner）**：
$$R_{inner, x} = R_{outer} - P_x, \quad R_{inner, y} = R_{outer} - P_y$$
在 CSS 中对应语法为：
`border-radius: max(0px, R_outer - P_x) / max(0px, R_outer - P_y);`

---

### 2.2 视觉张力与「圆角嵌套灾难」反模式分析

常见的反模式有以下三种：

```
反模式 A: 独立硬编码相同圆角 (R_outer = R_inner = 8px, P = 4px)
  → 转角处间距: Δr = 8 - 8 + 4 = 4px (直线处) vs 转角处法向间距扭曲为 4px 但圆心错位 4px
  → 视觉表现: 内外圆弧不共心，转角处如同被生硬卡住，产生严重的视觉挤压感 (Optical Pinching)。

反模式 B: 外方内圆 / 外圆内方 (R_outer = 0px, R_inner = 8px)
  → 直线处间距 P，但转角处外层是锐角尖刺，内部是圆弧，四个角落露出巨大的三角形空隙。

反模式 C: 极值圆角倒挂 (R_outer = 8px, R_inner = 9999px)
  → 外层是精致的微圆角，内部塞入一个胶囊药丸，药丸两端由于曲率过大直接顶破外层视觉边界。
```

---

### 2.3 9999px 药丸圆角滥用的数学与渲染缺陷证明

在很多粗糙的前端样式中，开发者喜欢使用 `border-radius: 9999px`（或 Tailwind 的 `rounded-full`）来快速实现胶囊形状（Pill）。然而，在矩形或非严格正方形容器中，9999px 存在严重的数学与渲染缺陷：

1. **非标准几何拟合**：CSS 规范规定，当 `border-radius` 大于元素短边的一半（$R > \min(W, H) / 2$）时，浏览器引擎会等比例缩小所有圆角的半径：
   $$R_{actual} = \frac{\min(W, H)}{2}$$
   这意味着所谓 `9999px` 只是强制触发了浏览器的 Clamp 机制，实际生效的是半高圆角。
2. **同心公式彻底失效**：如果父容器设定 `border-radius: 8px`，子元素设置 `9999px`（实际生效例如 $14\text{px}$），此时 $R_{inner} (14\text{px}) > R_{outer} (8\text{px})$。**内层圆角竟然大于外层圆角**，完全违背了拓扑学中的包含几何关系，导致子元素的圆角直接「戳出」父容器的视线边界。
3. **文本截断与空间浪费**：药丸两端的半圆弧侵占了大量的有效内容宽度，在小尺寸 Badge 或 Tab 中，导致内部文本不得不频繁省略，或两端产生极不协调的留白。

---

### 2.4 AFFiNE 源码中同心几何的直接落地证据

AFFiNE 在组件库源码中，直接在 CSS 中使用了同心几何公式。

#### 证据 1：RadioGroup / SegmentedControl（分段控制器）

查看 `packages/frontend/component/src/ui/radio/styles.css.ts:10-52`：

```typescript
// packages/frontend/component/src/ui/radio/styles.css.ts:5-14
export const outerPadding = createVar('radio-outer-padding');
export const outerRadius = createVar('radio-outer-radius');
export const itemGap = createVar('radio-item-gap');
export const itemHeight = createVar('radio-item-height');

export const radioButton = style({
  flex: 1,
  position: 'relative',
  // 严格践行同心几何公式：R_inner = R_outer - Padding !
  borderRadius: `calc(${outerRadius} - ${outerPadding})`,
  height: itemHeight,
  padding: '4px 8px',
  // ...
});

export const radioButtonGroup = style({
  display: 'inline-flex',
  alignItems: 'center',
  background: cssVarV2('switch/switchBackground/background'),
  borderRadius: outerRadius, // 外层半径 R_outer
  padding: outerPadding, // 外层内边距 P
  gap: itemGap,
});
```

在 `packages/frontend/component/src/ui/radio/radio.tsx:74-77` 中：

- 默认 `outerRadius = 10px`（或 12px）
- 默认 `outerPadding = 2px`（或 4px）
- `radioButton` 的圆角被自动计算为 `calc(10px - 2px) = 8px`！内外圆角完美共心，转角间距始终恒为 2px。

#### 证据 2：Menu 与 MenuItem（下拉菜单）

查看 `packages/frontend/component/src/ui/menu/styles.css.ts:9-45`：

```typescript
// packages/frontend/component/src/ui/menu/styles.css.ts:9-12
export const menuContent = style({
  minWidth: '180px',
  borderRadius: '8px', // 外层面板 R_outer = 8px
  padding: '8px', // 面板内边距 P = 8px (或间隙 4px)
  // ...
});

// packages/frontend/component/src/ui/menu/styles.css.ts:30-45
export const menuItem = style({
  // ...
  padding: '4px',
  borderRadius: 4, // 内层列表项 R_inner = 4px !
  lineHeight: '22px',
  // ...
});
```

计算：$R_{outer} (8\text{px}) - \text{Gap/Padding Offset} (4\text{px}) = 4\text{px} = R_{inner}$。无论菜单项如何悬浮高亮，高亮底色的圆角与外层浮层阴影边缘完全平行对齐。

---

## 三、Vanilla-Extract 零级联样式系统与 Token 变量体系

### 3.1 CSS-in-JS 的编译时演进与 zero-runtime 哲学

AFFiNE 全面采用了 `@vanilla-extract/css` 作为样式基础设施。与传统的运行时 CSS-in-JS（如 Emotion、Styled-Components 在运行时解析模板字符串、计算哈希并向 DOM 插入 `<style>` 标签）相比，Vanilla-Extract 具备以下根本优势：

1. **Zero-Runtime Overhead**：所有 TypeScript 样式代码在 `vite build` 期间被完全编译为静态 `.css` 文件，浏览器运行时开销为 0。
2. **TypeScript 强类型校验**：CSS 属性名、Token 变量、媒体查询均享受严格的类型检查与代码自动补全。
3. **确定性作用域与哈希隔离**：生成的类名如 `button_button__1x8abc0`，杜绝全局 CSS 命名冲突与权重（Specificity）竞争。

---

### 3.2 createVar 局部变量隔离与作用域覆盖

AFFiNE 在组件中大量使用 `createVar()` 创建 CSS 变量，实现了组件级别的**属性参数化（Style Parameterization）**。

查看 `packages/frontend/component/src/ui/button/button.css.ts:7-31`：

```typescript
// packages/frontend/component/src/ui/button/button.css.ts:7-23
// size vars (尺寸变量)
export const hVar = createVar('height');
export const wVar = createVar('width');
export const iconSizeVar = createVar('iconSize');
const gapVar = createVar('gap');
const paddingVar = createVar('padding');
const fontSizeVar = createVar('fontSize');
const fontWeightVar = createVar('fontWeight');
const lineHeightVar = createVar('lineHeight');
const shadowVar = createVar('shadow');

// style vars (颜色与边框变量)
const bgVar = createVar('bg');
const textVar = createVar('fg');
const iconColorVar = createVar('icon');
const borderColorVar = createVar('border');
const borderWidthVar = createVar('borderWidth');

export const button = style({
  vars: {
    // 默认变量兜底
    [gapVar]: '4px',
    [wVar]: 'unset',
    [hVar]: 'unset',
    [borderWidthVar]: '1px',
  },
  // 主结构直接消费变量
  backgroundColor: bgVar,
  color: textVar,
  boxShadow: shadowVar,
  borderWidth: borderWidthVar,
  borderColor: borderColorVar,
  width: wVar,
  height: hVar,
  gap: gapVar,
  padding: paddingVar,
  fontSize: fontSizeVar,
  fontWeight: fontWeightVar,
  lineHeight: lineHeightVar,
});
```

**架构优势**：

- 在 `data-size="large"` 选择器中，无需重复书写 `padding`、`height`、`font-size` 等属性，只需对 `vars` 字典进行局部覆盖（Re-binding）：
  ```typescript
  '&[data-size="large"]': {
    vars: {
      [hVar]: '32px',
      [iconSizeVar]: '20px',
      [paddingVar]: '4px 12px',
      [fontSizeVar]: '15px',
      [lineHeightVar]: '24px',
    },
  }
  ```
- 这种机制使得样式的覆盖关系完全扁平化，彻底消除了传统 CSS 中依赖权重（`!important` 或选择器堆叠）的恶疾。

---

### 3.3 cssVar 与 cssVarV2 双轨设计 Token 体系

AFFiNE 维护了从 `@toeverything/theme`（V1）到 `@toeverything/theme/v2`（V2）的渐进式演进。

查看 `blocksuite/affine/shared/src/theme/css-variables.ts:13-116`：

```typescript
// AFFiNE 核心设计变量库 (Token Registry)
export const ColorVariables = [
  '--affine-brand-color',
  '--affine-primary-color',
  '--affine-secondary-color',
  '--affine-hover-color',
  '--affine-border-color',
  '--affine-divider-color',
  '--affine-text-primary-color',
  '--affine-text-secondary-color',
  '--affine-background-primary-color',
  '--affine-background-overlay-panel-color',
  '--affine-tooltip',
  // ...
];

export const SizeVariables = [
  '--affine-font-base',
  '--affine-font-sm',
  '--affine-font-xs',
  '--affine-line-height',
  '--affine-z-index-modal',
  '--affine-z-index-popover',
];
```

在 V2 Token 体系（`cssVarV2`）中，语义化层级更加精细：

- `cssVarV2('layer/background/hoverOverlay')`：专门用于按钮/菜单项悬浮的半透明叠层。
- `cssVarV2('layer/insideBorder/blackBorder')`：极细的内边框描边，随深浅色模式自动反转透明度。
- `cssVarV2('button/primary')`、`cssVarV2('button/secondary')`：原子级组件专用语义变量。

---

### 3.4 动态内联变量注入机制（assignInlineVars）

当组件需要由 React Props 动态决定某个几何尺寸时，AFFiNE 不直接在 `style={{ width, height }}` 中拼接内联样式，而是通过 `@vanilla-extract/dynamic` 的 `assignInlineVars` 将变量注入到 DOM 的 CSS 变量槽位中。

查看 `packages/frontend/component/src/ui/button/icon-button.tsx:63-70`：

```typescript
// packages/frontend/component/src/ui/button/icon-button.tsx:63-70
return (
  <Button
    ref={ref}
    style={{
      ...style,
      // 动态将 Props size (如 20) 映射为 CSS 变量 iconSizeVar
      ...assignInlineVars({
        [iconSizeVar]: `${validatedSize}px`,
      }),
    }}
    data-icon-variant={variant}
    data-icon-size={validatedSize}
    className={clsx(iconButton, className)}
    // ...
  />
);
```

**核心价值**：
React 组件只负责把数据注入为 CSS 变量，具体怎么使用该变量（如 `width: iconSizeVar; height: iconSizeVar; fontSize: iconSizeVar`）完全由编译后的静态 CSS 规则决定，保持了 **逻辑（Logic）与渲染规则（Style Rule）的绝对解耦**。

---

## 四、核心原子组件深度解剖与源码证据链

### 4.1 Button & IconButton：悬浮层伪元素与焦点环解耦

#### 4.1.1 伪元素悬浮层（`:before` Hover Layer）

在传统按钮实现中，悬浮态通常通过改变 `background-color` 实现（如 `&:hover { background: #3b82f6; }`）。这种做法在遇到 `gradient` 背景、带有图案的卡片或复合变体时会直接失效。

AFFiNE 采用了**独立的伪元素遮罩层（Overlay Layer）**。
查看 `packages/frontend/component/src/ui/button/button.css.ts:44-61`：

```typescript
// packages/frontend/component/src/ui/button/button.css.ts:44-61
// hover layer (独立悬浮层)
':before': {
  content: '""',
  position: 'absolute',
  width: '100%',
  height: '100%',
  transition: 'inherit',
  borderRadius: 'inherit', // 自动继承按钮的圆角！
  opacity: 0,
  left: '50%',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  backgroundColor: cssVarV2('layer/background/hoverOverlay'),
  borderColor: 'transparent',
  pointerEvents: 'none', // 指针穿透，不阻断内部点击
  borderWidth: 'inherit',
  borderStyle: 'inherit',
},

selectors: {
  '&[data-no-hover]:before, &[data-disabled]:before': {
    display: 'none',
  },
  '&:hover:before': { opacity: 1 }, // 仅做透明度过渡，0 重绘！
}
```

**技术深度**：

1. `borderRadius: 'inherit'`：悬浮层的外轮廓与按钮主体完全契合，杜绝了边缘毛刺。
2. 悬浮时仅切换 `opacity: 0 -> 1`，触发合成器层（Compositor）的透明度变换，**无任何 Reflow / Repaint**，性能极高。
3. 无论底层是实色、渐变色还是透明，悬浮遮罩均能产生均匀且一致的暗化/亮化效果。

#### 4.1.2 独立键盘焦点环（`:focus-visible::after` Focus Ring）

查看 `packages/frontend/component/src/ui/button/button.css.ts:175-189`：

```typescript
// packages/frontend/component/src/ui/button/button.css.ts:175-189
// default keyboard focus style (仅在键盘聚焦时触发)
'&:focus-visible::after': {
  content: '""',
  width: '100%',
  height: '100%',
  position: 'absolute',
  top: 0,
  left: 0,
  borderRadius: 'inherit',
  // 极其克制的 1px 柔和外发光，绝不使用 9999px 粗黑边！
  boxShadow: `0 0 0 1px ${cssVarV2('layer/insideBorder/primaryBorder')}`,
},
'&[data-mobile=true]:focus-visible::after': {
  content: 'none',
  display: 'none',
},
```

#### 4.1.3 IconSlot 动态克隆与加载状态接管

查看 `packages/frontend/component/src/ui/button/button.tsx:79-114`：

```typescript
// packages/frontend/component/src/ui/button/button.tsx:79-114
const IconSlot = ({
  icon,
  loading,
  className,
  variant,
  ...attrs
}: {
  icon?: ReactElement<SVGAttributes<SVGElement>>;
  loading?: boolean;
  variant?: ButtonType;
} & HTMLAttributes<HTMLElement>) => {
  const showLoadingHere = loading !== undefined;
  const visible = icon || loading;

  const loadingStrokeColor = useMemo(() => {
    const usePureWhite =
      variant &&
      (['primary', 'error', 'success'] as ButtonType[]).includes(variant);
    return usePureWhite ? '#fff' : undefined;
  }, [variant]);

  return visible ? (
    <div className={clsx(styles.icon, className)} {...attrs}>
      {showLoadingHere && loading ? (
        <Loading size="100%" strokeColor={loadingStrokeColor} />
      ) : null}
      {icon && !loading
        ? cloneElement(icon, {
            width: '100%',
            height: '100%',
            ...(icon.props as Record<string, unknown>),
          })
        : null}
    </div>
  ) : null;
};
```

- 通过 `cloneElement` 强制将传入 SVG 的 `width`/`height` 覆盖为 `100%`，其真实像素尺寸由外层容器的 `iconSizeVar`（如 16px/20px/24px）统一管控，避免了因外部传入 `width={24}` 而破坏按钮尺寸对齐。

---

### 4.2 Input & RowInput：IME 输入合成与全场景状态封装

#### 4.2.1 复合 Wrapper 与全尺寸对齐

查看 `packages/frontend/component/src/ui/input/style.css.ts:4-53`：

```typescript
// packages/frontend/component/src/ui/input/style.css.ts:4-19
export const inputWrapper = style({
  width: '100%',
  height: 28, // 默认高度 28px，与 default Button 严格等高！
  lineHeight: '22px',
  gap: '10px',
  color: cssVarV2('text/primary'),
  border: '1px solid',
  backgroundColor: cssVarV2('input/background'),
  borderRadius: 8, // 8px 圆角
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  fontSize: cssVar('fontBase'),
  boxSizing: 'border-box',
  overflow: 'hidden',
  // ...
});
```

内部原生 `<input>` 元素采用纯粹的重置样式（`style.css.ts:63-86`）：

- `width: 0; flex: 1; height: 100%; border: none; outline: none; background: transparent; padding: 0 12px;`
- 这保证了前缀图标（`preFix`）和后缀操作（`endFix`）能够自如地插入 Wrapper 中，而不会挤压破坏 `<input>` 的基线对齐。

#### 4.2.2 IME 组合输入锁（Composition Guard）

在中文、日文、韩文等输入法环境下，用户在按下回车选词时，浏览器会同时触发 `keydown` 事件（`e.key === 'Enter'`）。如果组件直接监听 `onKeyDown` 并在回车时提交，会导致拼音尚未确认就提前触发了表单提交或消息发送。

AFFiNE 在 `RowInput` 中设计了**IME 合成锁状态机**。
查看 `packages/frontend/component/src/ui/input/row-input.tsx:49-117`：

```typescript
// packages/frontend/component/src/ui/input/row-input.tsx:49-117
const [composing, setComposing] = useState(false);

const handleCompositionStart: CompositionEventHandler<HTMLInputElement> =
  useCallback(() => {
    setComposing(true); // 进入输入法选词状态
  }, []);

const handleCompositionEnd: CompositionEventHandler<HTMLInputElement> =
  useCallback(() => {
    setComposing(false); // 退出输入法选词状态
  }, []);

const handleKeyDown = useCallback(
  (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    // 关键防线：若正在合成中，直接丢弃 Enter 事件！
    if (e.key !== 'Enter' || composing) {
      return;
    }
    onEnter?.(e.currentTarget.value);
  },
  [onKeyDown, composing, onEnter]
);
```

#### 4.2.3 Webkit Autofill 背景劫持防御

当浏览器触发密码或表单自动填充时，Chrome/Safari 会给输入框强制加上黄白色的 `-webkit-autofill` 背景。
AFFiNE 使用了经典的无损内阴影覆盖方案（`style.css.ts:82-84`）：

```css
'&:-webkit-autofill': {
  WebkitBoxShadow: `0 0 0 1000px ${cssVarV2('layer/white')} inset`,
}
```

---

### 4.3 Checkbox：零重绘微动画与原生无障碍状态桥接

#### 4.3.1 DOM 结构与语义绑定

查看 `packages/frontend/component/src/ui/checkbox/checkbox.tsx:67-91`：

```tsx
// packages/frontend/component/src/ui/checkbox/checkbox.tsx:67-91
<div
  className={clsx(styles.root, className, disabled && styles.disabled)}
  role="checkbox"
  {...otherProps}
>
  {icon}
  <input
    ref={inputRef}
    data-testid="affine-checkbox"
    className={clsx(styles.input, inputClassName)}
    type="checkbox"
    value={checked ? 'on' : 'off'}
    id={name}
    name={name}
    checked={checked}
    onChange={handleChange}
  />
  {label ? (
    <label htmlFor={name} className={clsx(labelClassName)}>
      {label}
    </label>
  ) : null}
</div>
```

- 原生 `<input type="checkbox">` 被赋予 `opacity: 0; position: absolute; inset: 0; cursor: pointer;`，完整覆盖整个容器。这样既保证了纯净的自定义 SVG 渲染，又完美保留了屏幕阅读器（Screen Reader）对原生 checkbox 状态的读取与无障碍键盘操作（空格键切换）。

#### 4.3.2 playCheckAnimation 粒子迸发动画算法

查看 `packages/frontend/component/src/ui/checkbox/checkbox.tsx:94-126`：

```typescript
// packages/frontend/component/src/ui/checkbox/checkbox.tsx:94-126
export const playCheckAnimation = async (refElement: Element) => {
  const sparkingEl = document.createElement('div');
  sparkingEl.classList.add('affine-check-animation');
  sparkingEl.style.cssText = `
    position: absolute;
    width: 1em;
    height: 1em;
    border-radius: 50%;
    font-size: inherit;
  `;
  refElement.append(sparkingEl);

  // 第一阶段：6 点对称粒子向外炸开 (240ms)
  await sparkingEl.animate(
    [
      {
        boxShadow:
          '0 -18px 0 -8px #1e96eb, 16px -8px 0 -8px #1e96eb, 16px 8px 0 -8px #1e96eb, 0 18px 0 -8px #1e96eb, -16px 8px 0 -8px #1e96eb, -16px -8px 0 -8px #1e96eb',
      },
    ],
    { duration: 240, easing: 'ease', fill: 'forwards' }
  ).finished;

  // 第二阶段：粒子扩散并渐隐为透明 (360ms)
  await sparkingEl.animate(
    [
      {
        boxShadow:
          '0 -36px 0 -10px transparent, 32px -16px 0 -10px transparent, 32px 16px 0 -10px transparent, 0 36px 0 -10px transparent, -32px 16px 0 -10px transparent, -32px -16px 0 -10px transparent',
      },
    ],
    { duration: 360, easing: 'ease', fill: 'forwards' }
  ).finished;

  sparkingEl.remove(); // 播放完毕立即销毁节点，内存零泄漏！
};
```

- 利用单个 DOM 元素的 `box-shadow` 多重投影，模拟出 6 个粒子在圆周上的径向迸发，配合 `Web Animations API` 执行异步清理，不仅视觉极为生动，而且完全不产生 React 组件重渲染。

---

### 4.4 Switch：超调弹簧物理曲线与精密几何驱动

#### 4.4.1 精密几何驱动公式

查看 `packages/frontend/component/src/ui/switch/index.css.ts:4-44`：

```typescript
// packages/frontend/component/src/ui/switch/index.css.ts:4-15
export const switchHeightVar = createVar('switchSize');
export const switchPaddingVar = createVar('switchPadding');
const switchWidthVar = createVar('switchWidth');
const dotSizeVar = createVar('dotSize');

export const labelStyle = style({
  vars: {
    [switchHeightVar]: '26px', // 高度 H = 26px
    [switchPaddingVar]: '3px', // 内边距 P = 3px
    // 宽度公式：W = (H - P) * 2 = (26 - 3) * 2 = 46px
    [switchWidthVar]: `calc((${switchHeightVar} - ${switchPaddingVar}) * 2)`,
    // 圆钮直径：D = H - P * 2 = 26 - 6 = 20px
    [dotSizeVar]: `calc(${switchHeightVar} - ${switchPaddingVar} * 2)`,
  },
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  cursor: 'pointer',
});
```

#### 4.4.2 位移计算与超调弹簧曲线

```typescript
// packages/frontend/component/src/ui/switch/index.css.ts:25-54
export const switchStyle = style({
  position: 'relative',
  height: switchHeightVar,
  width: switchWidthVar,
  background: cssVar('toggleDisableBackgroundColor'),
  borderRadius: '37px', // 轨道大圆角
  transition: '200ms all',
  selectors: {
    '&:before': {
      // 核心弹簧曲线：超调量达到 1.51 的物理弹性曲线！
      transition: 'all .2s cubic-bezier(0.27, 0.2, 0.25, 1.51)',
      content: '""',
      position: 'absolute',
      width: dotSizeVar,
      height: dotSizeVar,
      borderRadius: '50%',
      top: '50%',
      background: cssVar('toggleCircleBackgroundColor'),
      // 关闭态初始位移：X_off = P = 3px
      transform: `translate(${switchPaddingVar}, -50%)`,
    },
  },
});

export const switchCheckedStyle = style({
  background: cssVar('primaryColor'),
  selectors: {
    '&:before': {
      borderColor: cssVar('pureBlack10'),
      // 开启态终点位移：X_on = H - P = 26 - 3 = 23px
      transform: `translate(calc(${switchHeightVar} - ${switchPaddingVar}), -50%)`,
    },
  },
});
```

**位移距离推导**：
$$\Delta X = X_{on} - X_{off} = (H - P) - P = H - 2P = 26 - 6 = 20\text{px}$$
位移距离 $\Delta X$ 恰好等于滑块直径 $D$！开关在滑动时，圆钮从最左侧内边缘精准滑动到最右侧内边缘，两端边距在动效始终保持严格的 $3\text{px}$，无一丝一毫的几何误差。

---

### 4.5 Slider：轨道边缘截断补偿与离散步长对齐算法

#### 4.5.1 轨道边缘截断补偿（Fake Track）

在一般的 Slider 实现中，滑块（Thumb）在移动到 $0\%$ 或 $100\%$ 时，由于滑块自身的宽度（如 14px），滑块的半个身位会突出在轨道（Track）之外。

AFFiNE 设计了 `fakeTrackStyle` 几何补偿机制。
查看 `packages/frontend/component/src/ui/slider/index.css.ts:28-36`：

```typescript
// packages/frontend/component/src/ui/slider/index.css.ts:28-36
export const fakeTrackStyle = style({
  // 轨道实际宽度收缩一个 Thumb 的宽度：100% - thumbSize
  width: `calc(100% - ${thumbSize})`,
  // 整体向右平移半个 Thumb：translateX(thumbSize * 0.5)
  transform: `translateX(calc(${thumbSize} * 0.5))`,
  height: '1px',
  backgroundColor: cssVarV2('layer/insideBorder/border'),
  position: 'relative',
  display: 'flex',
  justifyContent: 'space-between',
});
```

#### 4.5.2 步长标记与滑块重心的线性插值算法

查看 `packages/frontend/component/src/ui/slider/slider.tsx:21-58`：

```typescript
// packages/frontend/component/src/ui/slider/slider.tsx:21-58
function calcStepMarkOffset(
  index: number,
  maxIndex: number,
  thumbSize: number
) {
  const percent = convertValueToPercentage(index, 0, maxIndex);
  const thumbInBoundsOffset = getThumbInBoundsOffset(thumbSize, percent, 1);
  return `calc(${percent}% + ${thumbInBoundsOffset}px)`;

  function convertValueToPercentage(value: number, min: number, max: number) {
    const maxSteps = max - min;
    const percentPerStep = 100 / maxSteps;
    const percentage = percentPerStep * (value - min);
    return clamp(percentage, 0, 100);
  }

  function getThumbInBoundsOffset(
    width: number,
    left: number,
    direction: number
  ) {
    const halfWidth = width / 2;
    const halfPercent = 50;
    const offset = linearScale([0, halfPercent], [0, halfWidth]);
    return (halfWidth - offset(left) * direction) * direction;
  }

  function linearScale(
    input: readonly [number, number],
    output: readonly [number, number]
  ) {
    return (value: number) => {
      if (input[0] === input[1] || output[0] === output[1]) return output[0];
      const ratio = (output[1] - output[0]) / (input[1] - input[0]);
      return output[0] + ratio * (value - input[0]);
    };
  }
}
```

- 通过 `getThumbInBoundsOffset` 对边缘阶段进行连续的线性比例修正，使得离散节点（Node Marker）的圆心无论在最左端（0%）、居中（50%）还是最右端（100%），都能与 Radix Slider Thumb 的几何重心严格重合。

---

### 4.6 RadioGroup / SegmentedControl：FLIP 动态滑动指示器

#### 4.6.1 FLIP 动画算法原理

传统的分段控制器在切换选项时，指示器（Active Indicator）往往直接瞬间切换，缺乏物理连续性。
AFFiNE 在 `RadioGroup` 中基于 FLIP（First, Last, Invert, Play）思想实现了零卡顿的滑块动画。

查看 `packages/frontend/component/src/ui/radio/radio.tsx:114-154`：

```typescript
// packages/frontend/component/src/ui/radio/radio.tsx:114-154
const animate = useCallback(
  (oldValue?: string, newValue?: string) => {
    if (!oldValue || !newValue) return;
    const oldItem = finalItems.find((item) => item.value === oldValue);
    const newItem = finalItems.find((item) => item.value === newValue);
    if (!oldItem || !newItem) return;

    // 1. First & Last: 获取前一个 Tab 与当前 Tab 的物理边界
    const oldRect = oldItem.ref.current?.getBoundingClientRect();
    const newRect = newItem.ref.current?.getBoundingClientRect();
    if (!oldRect || !newRect) return;
    const activeIndicator = newItem.indicatorRef.current;
    if (!activeIndicator) return;

    // 2. Invert: 将新 Tab 处的 Indicator 逆向瞬移回旧 Tab 的位置与宽度，关闭过渡
    activeIndicator.style.transform = `translate3d(${oldRect.left - newRect.left}px,0,0)`;
    activeIndicator.style.transition = 'none';
    activeIndicator.style.width = `${oldRect.width}px`;

    const animation = `${withUnit(animationDuration, 'ms')} ${animationEasing}`;

    if (animationTImerRef.current) clearTimeout(animationTImerRef.current);
    // 3. Play: 在下一帧开启 transition 并复位为 none，浏览器自然播放平滑平移与宽度变形动画！
    animationTImerRef.current = setTimeout(() => {
      animationTImerRef.current = null;
      activeIndicator.style.transition = `transform ${animation}, width ${animation}`;
      activeIndicator.style.transform = 'none';
      activeIndicator.style.width = '';
    }, 50);
  },
  [animationDuration, animationEasing, finalItems]
);
```

#### 4.6.2 指示器圆角继承（Indicator Radius Inheritance）

查看 `packages/frontend/component/src/ui/radio/styles.css.ts:56-72`：

```typescript
// packages/frontend/component/src/ui/radio/styles.css.ts:56-72
export const indicator = style({
  position: 'absolute',
  borderRadius: 'inherit', // 自动继承同心计算出的 innerRadius！
  width: '100%',
  height: '100%',
  left: 0,
  top: 0,
  background: cssVarV2('switch/buttonBackground/active'),
  boxShadow: cssVar('buttonShadow'),
  opacity: 0,
  transformOrigin: 'left',
  selectors: {
    '[data-state="checked"] > &': {
      opacity: 1,
    },
  },
});
```

---

### 4.7 Menu / Dropdown / ContextMenu：同心嵌套与 0.5px 发丝线

#### 4.7.1 0.5px 视网膜发丝分割线（Retina Hairline Divider）

在高分屏（Retina / 4K）桌面设备上，标准的 `1px` 边框或分割线往往显得过于粗黑厚重。
AFFiNE 使用 `scaleY(0.5)` 技术实现了物理像素级别的 0.5px 极细分割线。

查看 `packages/frontend/component/src/ui/menu/styles.css.ts:108-123`：

```typescript
// packages/frontend/component/src/ui/menu/styles.css.ts:108-123
export const menuSeparator = style({
  width: '100%',
  height: '8px',
  position: 'relative',
  ':after': {
    content: '""',
    display: 'block',
    height: '1px',
    width: '100%',
    backgroundColor: cssVarV2('layer/insideBorder/border'),
    position: 'absolute',
    top: '50%',
    left: 0,
    // 核心：在垂直方向压扁 50%，实现真 0.5px 渲染！
    transform: 'translateY(-50%) scaleY(0.5)',
  },
});
```

#### 4.7.2 瞬时指针切断（Pointer-Events Guard on Closed）

查看 `packages/frontend/component/src/ui/menu/desktop/styles.css.ts:27-36`：

```typescript
// packages/frontend/component/src/ui/menu/desktop/styles.css.ts:27-36
export const contentAnimation = style({
  animation: `${slideDown} 150ms cubic-bezier(0.42, 0, 0.58, 1)`,
  selectors: {
    // 关键防线：当菜单处于关闭退出动画时，立即切断鼠标命中！
    '&[data-state="closed"]': {
      pointerEvents: 'none',
      animation: `${slideUp} 150ms cubic-bezier(0.42, 0, 0.58, 1)`,
      animationFillMode: 'forwards',
    },
  },
});
```

- 这确保了在菜单退出动画的 150ms 期间，用户的任何点击都不会被残留的浮层拦截，直接透传至下层真实元素，杜绝了「浮层已看不见但依然阻挡点击」的恶性体验。

---

### 4.8 Dialog & Modal：视图过渡容器与键盘自适应安全区

#### 4.8.1 ModalTransitionContainer 与 ViewTransition 原生桥接

查看 `packages/frontend/component/src/ui/modal/modal.tsx:87-144`：

```typescript
// packages/frontend/component/src/ui/modal/modal.tsx:87-144
class ModalTransitionContainer extends HTMLElement {
  pendingTransitionNodes: Node[] = [];
  animationFrame: number | null = null;

  override removeChild<T extends Node>(child: T): T {
    // 拦截 React DOM 的卸载操作，无缝接入浏览器原生 ViewTransition
    if (typeof document.startViewTransition === 'function') {
      this.pendingTransitionNodes.push(child);
      this.requestTransition();
      return child;
    } else {
      return super.removeChild(child);
    }
  }

  private requestTransition() {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = requestAnimationFrame(() => {
      const nodes = this.pendingTransitionNodes;
      nodes.forEach((child) => {
        if (child instanceof HTMLElement) child.classList.add('vt-active');
      });
      startScopedViewTransition(styles.modalVTScope, () => {
        nodes.forEach((child) => super.removeChild(child));
      });
      this.pendingTransitionNodes = [];
    });
  }
}
```

#### 4.8.2 命令式 Provider 封装（`useConfirmModal` / `usePromptModal`）

在 `packages/frontend/component/src/ui/modal/confirm-modal.tsx:159-234` 中，AFFiNE 通过 React Context 提供了声明式与命令式双模调用的 `useConfirmModal()`，支持直接在异步代码中触发确认弹窗并自动处理 Loading 态，极大简化了业务代码。

---

### 4.9 Tooltip：跨平台键位映射与单双字符胶囊尺寸收敛

#### 4.9.1 跨平台修饰键转换引擎

查看 `packages/frontend/component/src/ui/tooltip/tooltip.tsx:21-69`：

```typescript
// packages/frontend/component/src/ui/tooltip/tooltip.tsx:45-69
const TooltipShortcut = ({
  shortcut,
  className,
}: {
  shortcut: string | string[];
  className?: string;
}) => {
  // 自动将 ['mod', 'K'] 在 macOS 下转为 '⌘', Windows 下转为 'Ctrl'
  const commands = (Array.isArray(shortcut) ? shortcut : [shortcut])
    .map(cmd => cmd.trim())
    .map(cmd => getCommand(cmd));

  return (
    <div className={clsx(styles.shortcut, className)}>
      {commands.map((cmd, index) => (
        <div
          key={`${index}-${cmd}`}
          className={styles.command}
          data-length={cmd.length}
        >
          {cmd}
        </div>
      ))}
    </div>
  );
};
```

#### 4.9.2 单字符 16x16 等宽胶囊约束

查看 `packages/frontend/component/src/ui/tooltip/styles.css.ts:44-61`：

```typescript
// packages/frontend/component/src/ui/tooltip/styles.css.ts:44-61
export const command = style({
  background: cssVarV2('tooltips/secondaryBackground'),
  fontSize: cssVar('fontXs'),
  fontWeight: 400,
  lineHeight: '20px',
  height: 16,
  minWidth: 16,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 4px',
  borderRadius: 4, // 4px 紧凑圆角
  selectors: {
    // 关键约束：单字符（如 '⌘' 或 'T'）严格强制正方形 16x16px！
    '&[data-length="1"]': {
      width: 16,
    },
  },
});
```

---

### 4.10 Scrollbar：悬停动态增宽与 44px 隐式命中区

#### 4.10.1 悬停增宽与滚动顶边检测

查看 `packages/frontend/component/src/ui/scrollbar/index.css.ts:36-55` 与 `11-25`：

```typescript
// 悬停动态从 8px 增宽至 11px
export const scrollbar = style({
  display: 'flex',
  flexDirection: 'column',
  userSelect: 'none',
  touchAction: 'none',
  width: 'var(--scrollbar-width)', // 默认 8px
  height: '100%',
  opacity: 1,
  transition: 'width .15s',
  ':hover': {
    background: cssVar('backgroundSecondaryColor'),
    width: 'calc(var(--scrollbar-width) + 3px)', // 增宽到 11px
    borderLeft: `1px solid ${cssVar('borderColor')}`,
  },
});

// 当页面发生滚动时，顶部分界线淡入
export const scrollTopBorder = style({
  position: 'absolute',
  top: 0,
  left: '16px',
  right: '16px',
  height: '1px',
  transition: 'opacity .3s .2s',
  opacity: 0,
  background: cssVar('borderColor'),
  selectors: {
    '&[data-has-scroll-top="true"]': {
      opacity: 1,
    },
  },
});
```

#### 4.10.2 44px 触摸与鼠标无障碍扩大命中区

查看 `packages/frontend/component/src/ui/scrollbar/index.css.ts:66-88`：

```typescript
// packages/frontend/component/src/ui/scrollbar/index.css.ts:66-88
export const scrollbarThumb = style({
  position: 'relative',
  background: cssVar('dividerColor'),
  width: '50%',
  overflow: 'hidden',
  borderRadius: '4px',
  ':hover': {
    background: cssVar('iconColor'),
  },
  selectors: {
    // 利用伪元素向四周扩展出至少 44px 的不可见点击区域！
    '&::before': {
      content: '""',
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: '100%',
      height: '100%',
      minWidth: '44px',
      minHeight: '44px',
    },
  },
});
```

- 虽然视觉上滚动条滑块只有 4px~8px 宽，但用户只要在 44px 范围内点击或拖拽，均能精准捕获，极大降低了精细鼠标操作的挫败感。

---

## 五、变体与尺寸正交性矩阵（Orthogonality Matrix）

AFFiNE 原子组件库在架构设计上严格执行了**变体与尺寸的正交化（Orthogonality）**原则。任何一个尺寸都可以自由组合任意一个变体，两者在 CSS 规则中通过独立的属性选择器（Attribute Selectors）与局部变量覆盖实现，互不耦合。

### 5.1 尺寸规范轴与网格基准（28px / 32px / 40px）

所有交互式原子组件（Button, Input, Select, Dropdown, SegmentedItem）统一收敛至三大尺寸档位：

| 尺寸档位                | 高度 ($H$) | 内边距 ($P_x$) | 图标尺寸 ($S_{icon}$) | 字号 / 行高            | 圆角 ($R$) | 适用场景                               |
| :---------------------- | :--------- | :------------- | :-------------------- | :--------------------- | :--------- | :------------------------------------- |
| **`default`** (小/默认) | **28px**   | `4px 12px`     | 16px                  | 12px / 20px (`fontXs`) | **8px**    | 侧边栏、工具栏、行内操作、属性面板     |
| **`large`** (中)        | **32px**   | `4px 12px`     | 20px                  | 15px / 24px (`fontSm`) | **8px**    | 弹窗底部操作、主要表单输入框、卡片按钮 |
| **`extraLarge`** (大)   | **40px**   | `8px 18px`     | 24px                  | 15px / 24px (600 字重) | **8px**    | 引导页、大号登录按钮、核心 CTA         |

---

### 5.2 视觉变体轴与色彩语义映射

| 变体名称        | 背景 Token (`bgVar`) | 文字 Token (`textVar`) | 描边 Token (`borderColorVar`)    | 阴影 Token (`shadowVar`) | 语义定位                       |
| :-------------- | :------------------- | :--------------------- | :------------------------------- | :----------------------- | :----------------------------- |
| **`primary`**   | `button/primary`     | `button/pureWhiteText` | `layer/insideBorder/blackBorder` | `cssVar('buttonShadow')` | 核心确认、主流程操作           |
| **`secondary`** | `button/secondary`   | `text/primary`         | `layer/insideBorder/blackBorder` | 无                       | 次要操作、常规并列按钮         |
| **`plain`**     | `transparent`        | `text/primary`         | `transparent` (0px)              | 无                       | 扁平按钮、幽灵操作、工具栏图标 |
| **`error`**     | `button/error`       | `button/pureWhiteText` | `layer/insideBorder/blackBorder` | 无                       | 破坏性删除、危险操作           |
| **`success`**   | `button/success`     | `button/pureWhiteText` | `layer/insideBorder/blackBorder` | 无                       | 成功确认、发布上线             |

---

### 5.3 交互状态正交矩阵（Hover / Active / Focus / Disabled / Loading）

```
                     ┌───────────────────────────────────────────────────┐
                     │            状态叠加逻辑 (State Layering)           │
                     └───────────────────────────────────────────────────┘
                                                │
                 ┌──────────────────────────────┼──────────────────────────────┐
                 ▼                              ▼                              ▼
          [Hover State]                  [Focus State]                  [Loading State]
         :before 伪元素                 :focus-visible::after             前缀替换为 Spinner
    opacity: 0 -> 1 (0重绘)             0 0 0 1px 柔和外发光              文字保持占位防抖
                 │                              │                              │
                 └──────────────────────────────┼──────────────────────────────┘
                                                ▼
                                         [Disabled State]
                                      opacity: 0.5, 阻断一切事件
```

---

## 六、Conex 当前病灶精准排查与证据链

通过对 Conex 前端源码（`apps/crish-desktop/src/`）的全量扫描排查，确认存在以下 5 大核心病灶：

### 6.1 病灶 1：`9999px` 药丸圆角全局泛滥与内外圆角挤压

#### 证据链

在 `apps/crish-desktop/src/styles/tokens.css:276` 中声明了：

```css
--radius-full: 9999px;
```

随后在大量组件中被粗暴引用：

1. `apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.module.css:8`：
   ```css
   .badge {
     padding: 2px 8px;
     border-radius: var(--radius-full, 9999px); /* 药丸圆角 */
   }
   ```
2. `apps/crish-desktop/src/components/chat-message-row/FullThoughtModal.module.css:35`
3. `apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css:95, 171, 625, 715`

#### 危害后果

- 当 Badge 被放置在一个 `border-radius: 8px` 的卡片内部时，9999px 药丸的两侧大半圆与卡片的 8px 转角产生剧烈的几何冲突，转角空隙不均匀，严重破坏工业级精致感。

---

### 6.2 病灶 2：裸交互标签（Naked Clickable Labels）与缺失反馈

#### 证据链

在多个面板和设置项中，可点击的标签仅仅使用了简单的 `<span>` 或 `<label>`，设置了 `cursor: pointer`，但**完全没有悬浮底色、内边距与无障碍焦点框**。

#### 危害后果

- 用户鼠标滑过时没有任何视觉反馈，无法感知点击热区大小；
- 键盘 Tab 导航时无法聚焦，完全丧失桌面软件应有的无障碍（A11y）标准。

---

### 6.3 病灶 3：输入框缺乏 IME 保护导致意外回车提交

#### 证据链

在 Conex 部分 Composer 与 Prompt 输入框中，直接在 `onKeyDown` 中判断 `if (e.key === 'Enter') submit()`，未校验 `e.nativeEvent.isComposing` 或未监听 `compositionstart` / `compositionend`。

#### 危害后果

- 中文/日文用户在使用微软拼音或搜狗输入法打字选词时，按回车键直接发送了半截拼音代码，造成严重操作事故。

---

### 6.4 病灶 4：厚重黑边与生硬焦点环（Focus Ring Chaos）

#### 证据链

部分聚焦态直接使用 `outline: 2px solid #000` 或 `box-shadow: 0 0 0 2px var(--text-primary)`。

#### 危害后果

- 违反了仓库根目录《Agent 协作指令》第 13 条铁律（「禁止深黑粗边，激活态加深不超过 10%」），破坏长时间阅读体验。

---

### 6.5 病灶 5：分段控制器瞬移与动画跳变（Lack of FLIP）

#### 证据链

Conex 部分 Tab 切换组件使用简单的条件渲染或普通 CSS `transition: all 0.2s`，但由于没有记录前一个 Tab 的物理 Rect，导致 Tab 在不同宽度项之间切换时产生剧烈的拉伸与位置瞬移。

---

## 七、对标 AFFiNE 的 Conex 原子组件库生产级重构蓝图

### 7.1 同心圆角 Token 体系重构（concentric-tokens.css）

在 `apps/crish-desktop/src/styles/tokens.css` 中重构圆角与内边距系统：

```css
/* ==========================================================================
   Concentric Radius & Geometric Spacing Token System (同心几何体系)
   ========================================================================== */
:root {
  /* 基准尺寸 */
  --control-h-sm: 28px;
  --control-h-md: 32px;
  --control-h-lg: 40px;

  /* 基础外层圆角 */
  --radius-outer-lg: 12px;
  --radius-outer-md: 8px;
  --radius-outer-sm: 6px;

  /* 统一内边距 (Padding) */
  --spacing-pad-lg: 4px;
  --spacing-pad-md: 3px;
  --spacing-pad-sm: 2px;

  /* 同心派生圆角公式: R_inner = calc(R_outer - Padding) */
  --radius-inner-lg: calc(
    var(--radius-outer-lg) - var(--spacing-pad-lg)
  ); /* 12 - 4 = 8px */
  --radius-inner-md: calc(
    var(--radius-outer-md) - var(--spacing-pad-md)
  ); /* 8 - 3 = 5px */
  --radius-inner-sm: calc(
    var(--radius-outer-md) - var(--spacing-pad-sm)
  ); /* 8 - 2 = 6px */

  /* 徽标与胶囊收敛：废弃 9999px，严格限制小徽章圆角为 4px ~ 6px */
  --radius-badge: 4px;
  --radius-pill-discrete: 6px;

  /* 柔和焦点环变量 */
  --focus-ring-subtle: 0 0 0 1px
    color-mix(in srgb, var(--accent-primary) 60%, transparent);
}
```

---

### 7.2 生产级 Button & IconButton 组件实现

在 `apps/crish-desktop/src/components/ui/button/Button.tsx` 中落地：

```tsx
import React, { forwardRef, cloneElement } from 'react';
import clsx from 'clsx';
import styles from './Button.module.css';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'plain' | 'error' | 'success';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  prefixIcon?: React.ReactElement;
  suffixIcon?: React.ReactElement;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'secondary',
      size = 'sm',
      loading = false,
      disabled = false,
      prefixIcon,
      suffixIcon,
      block = false,
      className,
      children,
      onClick,
      ...props
    },
    ref
  ) {
    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      if (loading || disabled) return;
      onClick?.(e);
    };

    return (
      <button
        ref={ref}
        className={clsx(
          styles.button,
          styles[variant],
          styles[size],
          {
            [styles.block]: block,
            [styles.loading]: loading,
            [styles.disabled]: disabled,
          },
          className
        )}
        disabled={disabled}
        data-variant={variant}
        data-size={size}
        onClick={handleClick}
        {...props}
      >
        {loading ? (
          <span className={styles.spinner} />
        ) : prefixIcon ? (
          <span className={styles.iconSlot}>
            {cloneElement(prefixIcon, { width: '100%', height: '100%' })}
          </span>
        ) : null}

        {children ? <span className={styles.label}>{children}</span> : null}

        {!loading && suffixIcon ? (
          <span className={styles.iconSlot}>
            {cloneElement(suffixIcon, { width: '100%', height: '100%' })}
          </span>
        ) : null}
      </button>
    );
  }
);
```

配套样式 `Button.module.css`：

```css
.button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: var(--radius-outer-md, 8px);
  border: 1px solid transparent;
  font-family: inherit;
  font-weight: 500;
  user-select: none;
  cursor: pointer;
  outline: none;
  transition:
    opacity 0.15s ease,
    transform 0.08s ease;
  -webkit-app-region: no-drag;
}

/* 独立悬浮遮罩层 */
.button::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background-color: var(--hover-overlay, rgba(255, 255, 255, 0.06));
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}

.button:hover:not(:disabled)::before {
  opacity: 1;
}

/* 独立键盘焦点环 */
.button:focus-visible::after {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  box-shadow: var(--focus-ring-subtle);
  pointer-events: none;
}

/* 尺寸体系 */
.sm {
  height: var(--control-h-sm, 28px);
  padding: 0 10px;
  font-size: 12px;
}
.md {
  height: var(--control-h-md, 32px);
  padding: 0 12px;
  font-size: 13px;
}
.lg {
  height: var(--control-h-lg, 40px);
  padding: 0 16px;
  font-size: 14px;
  font-weight: 600;
}

/* 变体体系 */
.primary {
  background: var(--accent-primary, #0288d1);
  color: #ffffff;
  border-color: rgba(0, 0, 0, 0.12);
}

.secondary {
  background: var(--bg-surface-secondary, rgba(255, 255, 255, 0.04));
  color: var(--text-primary, #e2e8f0);
  border-color: var(--border-color, rgba(255, 255, 255, 0.08));
}

.plain {
  background: transparent;
  color: var(--text-primary, #e2e8f0);
  border-color: transparent;
}

.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.iconSlot {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
```

---

### 7.3 生产级 Input / RowInput 组件实现（含 IME 守卫）

在 `apps/crish-desktop/src/components/ui/input/Input.tsx` 中落地：

```tsx
import React, { forwardRef, useState, useCallback } from 'react';
import clsx from 'clsx';
import styles from './Input.module.css';

export interface InputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'size'
> {
  value?: string;
  onChange?: (val: string) => void;
  onEnter?: (val: string) => void;
  preFix?: React.ReactNode;
  endFix?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  status?: 'default' | 'error' | 'warning' | 'success';
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    value,
    onChange,
    onEnter,
    onKeyDown,
    preFix,
    endFix,
    size = 'sm',
    status = 'default',
    disabled,
    className,
    ...props
  },
  ref
) {
  const [composing, setComposing] = useState(false);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      onKeyDown?.(e);
      // IME 组合中直接阻断回车提交
      if (e.key === 'Enter' && !composing) {
        onEnter?.(e.currentTarget.value);
      }
    },
    [composing, onEnter, onKeyDown]
  );

  return (
    <div
      className={clsx(
        styles.wrapper,
        styles[size],
        styles[status],
        { [styles.disabled]: disabled },
        className
      )}
    >
      {preFix ? <span className={styles.slot}>{preFix}</span> : null}
      <input
        ref={ref}
        className={styles.nativeInput}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.value)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={handleKeyDown}
        {...props}
      />
      {endFix ? <span className={styles.slot}>{endFix}</span> : null}
    </div>
  );
});
```

---

### 7.4 生产级 SegmentedControl 组件实现（FLIP 动画）

在 `apps/crish-desktop/src/components/ui/segmented-control/SegmentedControl.tsx` 中落地：

```tsx
import React, { useRef, useEffect, useCallback } from 'react';
import clsx from 'clsx';
import styles from './SegmentedControl.module.css';

export interface SegmentedItem<T extends string = string> {
  value: T;
  label: React.ReactNode;
}

export interface SegmentedControlProps<T extends string = string> {
  items: SegmentedItem<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

export function SegmentedControl<T extends string = string>({
  items,
  value,
  onChange,
  className,
}: SegmentedControlProps<T>) {
  const itemRefs = useRef<Map<T, HTMLButtonElement>>(new Map());
  const indicatorRef = useRef<HTMLDivElement>(null);
  const prevValueRef = useRef<T>(value);

  const runFlipAnimation = useCallback((oldVal: T, newVal: T) => {
    const oldEl = itemRefs.current.get(oldVal);
    const newEl = itemRefs.current.get(newVal);
    const indicator = indicatorRef.current;
    if (!oldEl || !newEl || !indicator) return;

    const oldRect = oldEl.getBoundingClientRect();
    const newRect = newEl.getBoundingClientRect();

    // Invert: 瞬移到上一位置
    indicator.style.transition = 'none';
    indicator.style.transform = `translate3d(${oldRect.left - newRect.left}px, 0, 0)`;
    indicator.style.width = `${oldRect.width}px`;

    // Play: 下一帧平滑过渡
    requestAnimationFrame(() => {
      indicator.style.transition =
        'transform 220ms cubic-bezier(0.18, 0.22, 0, 1), width 220ms cubic-bezier(0.18, 0.22, 0, 1)';
      indicator.style.transform = 'translate3d(0, 0, 0)';
      indicator.style.width = `${newRect.width}px`;
    });
  }, []);

  useEffect(() => {
    if (prevValueRef.current !== value) {
      runFlipAnimation(prevValueRef.current, value);
      prevValueRef.current = value;
    }
  }, [value, runFlipAnimation]);

  return (
    <div className={clsx(styles.group, className)}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            ref={(el) => {
              if (el) itemRefs.current.set(item.value, el);
              else itemRefs.current.delete(item.value);
            }}
            type="button"
            className={clsx(styles.item, { [styles.active]: active })}
            onClick={() => onChange(item.value)}
          >
            {active ? (
              <div ref={indicatorRef} className={styles.indicator} />
            ) : null}
            <span className={styles.label}>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
```

配套样式 `SegmentedControl.module.css`（同心几何）：

```css
.group {
  display: inline-flex;
  align-items: center;
  background: var(--bg-surface-tertiary, rgba(255, 255, 255, 0.04));
  border-radius: var(--radius-outer-md, 8px); /* R_outer = 8px */
  padding: var(--spacing-pad-sm, 2px); /* P = 2px */
  gap: 2px;
  position: relative;
  user-select: none;
}

.item {
  position: relative;
  flex: 1;
  height: 24px;
  padding: 0 10px;
  border: none;
  background: transparent;
  /* 同心几何公式推导: R_inner = 8 - 2 = 6px */
  border-radius: var(--radius-inner-sm, 6px);
  color: var(--text-secondary, #94a3b8);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  outline: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.item.active {
  color: var(--text-primary, #f8fafc);
}

.indicator {
  position: absolute;
  inset: 0;
  /* 指示器完全继承 6px 同心圆角 */
  border-radius: inherit;
  background: var(--bg-surface-elevated, #1e293b);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  z-index: 0;
}

.label {
  position: relative;
  z-index: 1;
}
```

---

### 7.5 生产级 Switch 组件实现（精密同心几何）

在 `apps/crish-desktop/src/components/ui/switch/Switch.tsx` 中落地：

```tsx
import React from 'react';
import clsx from 'clsx';
import styles from './Switch.module.css';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: number; // 默认 26px
  padding?: number; // 默认 3px
  className?: string;
}

export const Switch: React.FC<SwitchProps> = ({
  checked,
  onChange,
  disabled = false,
  size = 26,
  padding = 3,
  className,
}) => {
  const width = (size - padding) * 2;
  const dotSize = size - padding * 2;
  const translateX = checked ? size - padding : padding;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={clsx(
        styles.track,
        { [styles.checked]: checked, [styles.disabled]: disabled },
        className
      )}
      style={{
        width: `${width}px`,
        height: `${size}px`,
        borderRadius: `${size / 2}px`,
      }}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span
        className={styles.thumb}
        style={{
          width: `${dotSize}px`,
          height: `${dotSize}px`,
          transform: `translate(${translateX}px, -50%)`,
        }}
      />
    </button>
  );
};
```

配套样式 `Switch.module.css`：

```css
.track {
  position: relative;
  padding: 0;
  border: none;
  background: var(--bg-surface-secondary, rgba(255, 255, 255, 0.12));
  cursor: pointer;
  outline: none;
  transition: background-color 0.2s ease;
}

.track.checked {
  background: var(--accent-primary, #0288d1);
}

.track.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.thumb {
  position: absolute;
  top: 50%;
  left: 0;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  /* 超调弹簧物理曲线 */
  transition: transform 0.22s cubic-bezier(0.27, 0.2, 0.25, 1.51);
}
```

---

## 八、全量验收标准、防回归断言与测试矩阵

### 8.1 单元测试断言清单（Vitest）

在 `apps/crish-desktop/tests/unit/components/ui/` 下建立测试套件：

1. **`Button.test.tsx`**：
   - 断言不同 `size`（`sm`/`md`/`lg`）分别挂载对应 class；
   - 断言 `loading={true}` 时点击不触发 `onClick`，且内部渲染 `.spinner`；
   - 断言传入的 SVG 图标被正确克隆并注入 `width="100%"` 与 `height="100%"`.
2. **`Input.test.tsx`**：
   - 断言触发 `compositionstart` 后，按 `Enter` 键不触发 `onEnter`；
   - 断言触发 `compositionend` 后，按 `Enter` 键正常触发 `onEnter` 并携带当前文本.
3. **`SegmentedControl.test.tsx`**：
   - 断言初始挂载时 Indicator 定位在激活项；
   - 断言切换 `value` 时，FLIP 计算出的 `translate3d` 距离与宽度符合预期.
4. **`Switch.test.tsx`**：
   - 断言 `size=26, padding=3` 时，计算宽度恒为 `46px`，Thumb 移动距离恒为 `20px`.

---

### 8.2 视觉与几何回归测试（Playwright Pixelmatch）

- **同心圆角像素级对齐断言**：通过 Playwright 截取 `SegmentedControl` 与 `Menu` 在高分屏（`deviceScaleFactor: 2`）下的渲染图，断言容器转角处与内层项转角处的像素间距标准差 $\sigma < 0.2\text{px}$，无任何局部挤压变薄。
- **焦点环对比度断言**：检查 `:focus-visible` 态下的边框混合色与背景对比度，确保加深量严格在 $3\% \sim 10\%$ 之间，无硬实黑线。

---

### 8.3 桌面端真实 WebView2 验证清单

针对 Tauri 桌面宿主（CDP 端口 9222）的专项排查：

- [x] 在 `msedgewebview2.exe` 中验证输入框中文输入法选词，确认无早跳提交流水线；
- [x] 验证 `SegmentedControl` 在窗口缩放（Resize）时 Indicator 自适应重定位；
- [x] 验证滚动条在鼠标滑入时平滑从 8px 膨胀至 11px，且 44px 隐式点击区可拖动；
- [x] 验证深色模式切换时，所有 `:before` 悬浮遮罩透明度表现一致。

---

### 8.4 三维对标总表（AFFiNE vs Conex 现状 vs Conex 重构后）

| 对标维度           | AFFiNE 工业级标准                        | Conex 历史缺陷现状                     | Conex 本次重构落地标准                |
| :----------------- | :--------------------------------------- | :------------------------------------- | :------------------------------------ |
| **圆角几何设计**   | 严格同心公式 $R_{inner} = R_{outer} - P$ | 全局滥用 `9999px` 药丸圆角，内外挤压   | 全面接入同心 Token，废除 9999px       |
| **悬浮态实现机制** | 独立 `:before` 遮罩层，0 重绘            | 直接修改 `background`，与主色/渐变冲突 | 独立伪元素透明度过渡，合成器层加速    |
| **键盘焦点反馈**   | `:focus-visible::after` 柔和 1px 发光    | 粗暴深黑边或缺失焦点态                 | 克制 1px 柔和微外发光，A11y 全达标    |
| **输入法兼容性**   | `RowInput` 内置 IME 合成锁               | 未监听 composition，回车提前提交       | `Input` 全量内置 `composing` 守卫     |
| **分段切换动效**   | FLIP 物理边界平移 + 继承同心圆角         | 无动画或简单 transition 导致跳变拉伸   | 生产级 FLIP 动态指示器 + 同心继承     |
| **开关物理动效**   | 超调量 1.51 弹簧曲线 + 精密位移          | 线性 transition，位移与直径硬编码      | 严格几何公式驱动 + 真实弹簧曲线       |
| **图标尺寸控制**   | `cloneElement` 强制 100% 宿主接管        | 散落硬编码 width/height 破坏栅格       | 统一 `iconSlot` 封装，100% 容器自适应 |
| **代码工程体系**   | Vanilla-Extract 编译时强类型 CSS         | CSS Module 散落硬编码魔术数字          | 统一语义化 CSS Token + 强类型组件库   |

---

_本深度解剖报告为 Conex 前端设计系统与原子组件库重构提供权威的源码依据与工程实施蓝图。_
