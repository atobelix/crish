# DIM-02 专项分析：同心几何标尺与 Apple 物理动效

> **战役定位**：`UI-UNIFICATION-REDESIGN` 战役阶段一 · 维度二（DIM-02）专项深度分析报告  
> **设计依据**：  
> - `C:\Software\conex\skill\design\apple-design.md`（WWDC 2018 *Designing Fluid Interfaces*、WWDC 2020 *Depth and Translucency*、WWDC 2026 *Principles of Great Design*）  
> - `C:\Software\conex\skill\design\jakub-skills\skills\better-ui\surfaces.md`（同心圆角几何公理、阴影代边框、光学对齐）  
> - `C:\Software\conex\skill\design\jakub-skills\skills\better-ui\animations.md`（可中断过渡、按压 scale(0.96) 物理触感、静态逃逸属性、主题切换动画冻结门闩、动效克制律）  
> **核心使命**：全面推行数学级同心几何公理 $R_{outer} = R_{inner} + padding$，根除全仓散落的 5px/7px/10px/11px/13px 随意圆角；纠正伪弹簧 1.5 过冲抖动贝塞尔；为原子与关键控件注入 `scale(0.96)` 触感压缩与可中断响应；重塑 Dialog 16px/20px 景深磨砂与模态 Scrim；构建主题切换瞬态过渡冻结门闩，彻底消除色彩涂抹，实现工程级优雅与代码**净负产出（Net-Negative LOC）**。

---

## 一、维度现状与物理断层总述

在前期 `desktop-ui-repair` 与 `PE-05` 建设中，项目尝试规范圆角与动画，但由于历史包袱与局部临时修补，导致当前工程在**几何逻辑**与**物理动效**上出现了五大系统性断层：

1. **同心几何撕裂与「7px」圆角硬编码锁残留**：
   - 历史上为防止业务层随意使用 `9999px` 胶囊圆角盖过按钮，曾硬性引入 `--button-radius: 7px` 并强制锁定；
   - 该 7px 奇数脱离了 4px/8px 的原子网格，且引发了连环次生灾害：为了与 7px 配合，下层组件衍生出 5px（$7 - 2$）、11px（$14 - 3$）、13px 等一系列碎片化奇数；
   - 全仓大量嵌套卡片（如 `ModelsSettingsTab`、`ToastStackModern`、`ChatComposer`）完全无视 $R_{outer} = R_{inner} + padding$，出现「内角比外角更圆」的严重视觉畸变。
2. **离散选择被误配高弹簧过冲（$y_2 = 1.5$ 伪物理晃荡）**：
   - 在 `Tabs.module.css` 与 `PreviewCard.module.css` 中，定义了 `--tab-spring-bezier: cubic-bezier(0.175, 0.885, 0.32, 1.5)`；
   - $y_2 = 1.5$ 意味着滑块和卡片在位移时会越过目标边界达 50% 再强行拉回，产生令人眩晕的「果冻摇晃」。违背 Apple WWDC 物理流体准则：无惯性投掷的离散交互必须使用临界阻尼（$\zeta = 1.0$，0 overshoot）。
3. **触控反馈缺失（触感真空）**：
   - 核心原子控件 [`Button.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css) 在 `:active` 状态下仅改变伪元素 `::before` 的微光不透明度，完全缺乏物理形变反馈；
   - 缺少 Apple 规范中标准的 `scale(0.96)` 微按压压缩触感，用户点击犹如触碰僵硬的死塑料片；同时缺乏 `static` 属性逃逸机制。
4. **模态材质极浅模糊（1.5px 毛刺磨砂）**：
   - [`Dialog.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css) 的遮罩层仅配置 `backdrop-filter: blur(1.5px)` 与 4% 不透明度底色；
   - 1.5px 模糊度在 Retina/高分屏上仅表现为微弱的边缘锯齿，背景文本与杂乱界面依然清晰锐利，无法提供模态对话框必备的景深沉浸感（Depth & Focus Isolation）。
5. **主题翻转色彩涂抹（缺少切换动画门闩）**：
   - 全站元素挂载了大量 `transition: background 150ms, color 150ms, border-color 150ms`；
   - 当用户在浅色/深色模式间切换时，由于无瞬时门闩，全屏成百上千个 DOM 节点同时在 150ms~250ms 内异步差速过渡，呈现脏灰过渡态、文字与底色对比度瞬间失序的「色彩涂抹」泥潭。

---

## 二、核心缺陷深度审计与现场代码证据

### 2.1 缺陷 1：原子 Button 触感真空与 7px 硬编码锁

#### 1. 现状代码证据
在 [`Button.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css) 中：
```css
/* apps/crish-desktop/src/components/ui/Button/Button.module.css:11 */
.button {
  --btn-h: 32px;
  --btn-px: 12px;
  --btn-fs: var(--font-size-base, 14px);
  --btn-radius: var(--button-radius, 7px); /* ◀ 7px 硬编码 fallback */
  ...
  /* apps/crish-desktop/src/components/ui/Button/Button.module.css:43-46 */
  transition:
    border-color var(--transition-micro, 100ms) ease-out,
    box-shadow var(--transition-micro, 100ms) ease-out; /* ◀ 缺失 transform / scale 过渡 */
}

/* apps/crish-desktop/src/components/ui/Button/Button.module.css:64-67 */
.button:active:not(:disabled)::before {
  background-color: var(--btn-active-overlay);
  opacity: 1; /* ◀ 仅微光透明度变化，按钮本体尺寸毫无物理形变 */
}

/* apps/crish-desktop/src/components/ui/Button/Button.module.css:102, 112 */
.buttonSm, .button[data-size='sm'] {
  --btn-radius: var(--button-radius, 7px); /* ◀ 尺寸小了一档，圆角依然死锁 7px */
}
.buttonMd, .button[data-size='md'] {
  --btn-radius: var(--button-radius, 7px); /* ◀ 7px 与系统 6px/8px 体系割裂 */
}
```

#### 2. 物理与几何机理分析
- **触觉真空**：依据 `better-ui/animations.md` § Scale on press 与 `apple-design.md` § 1 Response：
  > "A subtle scale-down on click gives buttons tactile feedback. Always scale(0.96), never below 0.95, which feels exaggerated. Use CSS transitions so a release mid-press returns smoothly."  
  > "Feedback lives on the press, and it's instant: .button:active { transform: scale(0.96); transition: transform 100ms ease-out; }"
  现有实现仅有伪元素叠加暗色，在物理直觉上缺少向屏幕内「压下（Depress）」的位移，缺少手感反馈。
- **7px 几何断层**：标准系统的圆角遵循 4px 基数（`--radius-sm: 4px`, `--radius-md: 6px`, `--radius-lg: 8px`）。7px 既不是 6px 也不是 8px，导致 Button 嵌套在 12px 的 Card（如 `padding: 8px`）内部时，$12 - 8 = 4px \neq 7px$，外壳与内部按钮的同心圆弧必然错位变形。
- **静态逃逸缺位**：在密集列表拖拽把手、树状展开行等高频场景中，如果按压缩放不可关闭，会引起界面抖动。现有 [`Button.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.tsx) 缺少 `static` prop 支持。

---

### 2.2 缺陷 2：Tabs 滑块 1.5 过冲晃荡与亚像素几何失准

#### 1. 现状代码证据
在 [`Tabs.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css) 中：
```css
/* apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css:7-9 */
.root {
  --tab-spring-bezier: cubic-bezier(0.175, 0.885, 0.32, 1.5); /* ◀ 1.5 严重过冲 */
  --tab-duration: 250ms;
  --tab-press-duration: 100ms;
}

/* apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css:122-126 */
.indicator {
  transition:
    transform var(--tab-duration) var(--tab-spring-bezier),
    width var(--tab-duration) var(--tab-spring-bezier),
    height var(--tab-duration) var(--tab-spring-bezier),
    opacity 120ms ease;
}

/* apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css:84-85, 104-107 */
.sizeSm {
  --tab-outer-radius: var(--button-radius, 7px);
  --tab-inner-radius: calc(var(--tab-outer-radius) - var(--tab-pad)); /* 5px */
}
.sizeLg {
  --tab-pad: 3.5px; /* ◀ 亚像素 3.5px 内边距 */
  --tab-outer-radius: var(--radius-xl, 10px); /* ◀ 非标 10px */
  --tab-inner-radius: calc(var(--tab-outer-radius) - var(--tab-pad)); /* 6.5px 亚像素内圆角 */
}
```
在测试文件 [`Tabs.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tabs/Tabs.test.tsx#L314) 中：
```tsx
/* apps/crish-desktop/src/components/ui/Tabs/Tabs.test.tsx:314, 328 */
expect(CSS_SRC).toContain('cubic-bezier(0.175, 0.885, 0.32, 1.5)'); // ◀ 门禁硬编码固化了错误参数
expect(CSS_SRC).toContain('--tab-outer-radius: var(--button-radius, 7px)');
```

#### 2. 物理与几何机理分析
- **1.5 过冲晃荡数学模型**：
  在三次贝塞尔曲线 $B(t) = (1-t)^3 P_0 + 3(t)(1-t)^2 P_1 + 3(1-t)t^2 P_2 + t^3 P_3$ 中，$P_2$ 的纵坐标 $y_2 = 1.5$。
  当滑块从 Tab A 移动到 Tab B（距离 $\Delta x = 120px$）时：
  滑块最大位移将达到 $120px \times 1.5 = 180px$，严重冲出 Tab B 边界达 $60px$，随后再反向拉回！
  在离散点击场景下，没有手势释放的初始速度（$v_0 = 0$），该过冲属于「无源之水」，在用户视线中呈现失控的塑料晃荡感。
  依据 `apple-design.md` § 4 Behavior over animation：
  > "Start most UI at damping 1.0 (critically damped) — graceful and non-distracting.
  > Add bounce (damping ~0.8) only when the gesture itself carried momentum (a flick, a throw, a drag release). Overshoot on a menu that just faded in feels wrong; overshoot on a tab feels cheap."
- **亚像素偏心破框**：`--tab-pad: 3.5px` 与 `--tab-inner-radius: 6.5px` 在 100% / 125% Windows DPI 缩放下，会被 GPU 栅格化为不同像素（有的取 3px，有的取 4px），导致滑块白底卡片边缘与轨道边缘出现 `0.5px` 的锯齿毛边与偏心走样。

---

### 2.3 缺陷 3：Dialog 遮罩 1.5px 极浅磨砂与空间深度塌陷

#### 1. 现状代码证据
在 [`Dialog.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css) 中：
```css
/* apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css:14-20 */
.backdrop {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--shadow-color) 4%, transparent); /* ◀ 4% 不透明度极其通透 */
  backdrop-filter: blur(1.5px); /* ◀ 1.5px 极浅模糊 */
  -webkit-backdrop-filter: blur(1.5px);
}

/* apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css:33 */
.dialog {
  ...
  border-radius: 16px; /* ◀ 16px 外壳 */
}
/* apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css:156 */
.dialogClose {
  border-radius: var(--radius-sm); /* ◀ 4px 关闭按钮，与 16px 外壳和 16px 内边距无同心关联 */
}
```

#### 2. 物理与视觉机理分析
- **景深缺失**：依据 `apple-design.md` § 12 Materials & Depth：
  > "Dim to focus, separate to keep flow. A modal task pairs the surface with a dimming scrim and pushes the background back/down."  
  > "Bigger surfaces should read as thicker: stronger blur + deeper shadow."
  `blur(1.5px)` 在物理学上无法形成散射面（Diffusion Surface），无法将背后的复杂文字和代码折射为柔和色块。4% 的 scrim 几乎等同于完全透明，导致弹窗浮在杂乱界面之上，视线无法聚焦在弹窗内容上。
- **入场材质突变**：`.backdrop` 在入场时只有简单的 opacity 过渡，没有跟随弹窗的出现同步建立模糊散射，造成「硬切」闪烁感。

---

### 2.4 缺陷 4：主题切换全局 transition 缺少冻结门闩导致色彩涂抹

#### 1. 现状代码证据
在 [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L6-L16) 中：
```css
/* apps/crish-desktop/src/styles/tokens.css:6-16 */
/* 冷启动门闩仅对 html.preload 生效，运行时主题切换完全无保护 */
html.preload *:not(.app-initial-loader, .app-initial-loader *),
html.preload *:not(.app-initial-loader, .app-initial-loader *)::before,
html.preload *:not(.app-initial-loader, .app-initial-loader *)::after {
  transition: none !important;
  animation-duration: 0s !important;
}
```
在 [`themeStore.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/themeStore.ts#L74-L84) 与 [`themeProjection.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/themeProjection.ts#L24-L36) 中：
```typescript
/* apps/crish-desktop/src/api/themeStore.ts:74-84 */
export function applyTheme(theme: UiTheme | string): UiTheme {
  const t = normalizeTheme(theme);
  const html = document.documentElement;
  // ◀ 直接无缝变更 data-theme，没有任何过渡冻结屏障！
  html.setAttribute('data-theme', t);
  document.body.setAttribute('data-theme', t);
  html.classList.toggle('theme-dark', t === 'dark');
  ...
}
```

#### 2. 物理现象与视网膜冲击
- 当触发主题切换（如在设置中心从 Light 切换为 Dark），`data-theme` 的变更瞬间更新了上百个 CSS 变量：
  `--bg-primary`, `--bg-card`, `--text-primary`, `--border-color`, `--shadow-color` 等。
- 全站近百个组件均声明了局部过渡：
  - `.button` 声明 `transition: border-color 100ms, box-shadow 100ms`；
  - `.input` 声明 `transition: border-color 120ms, background 120ms`；
  - `.card` 声明 `transition: background 150ms, box-shadow 150ms`；
  - 侧边栏与窗格声明 `transition: background 200ms`。
- **色彩涂抹灾难（Color Smear）**：由于不同属性、不同组件的过渡时长不同（100ms ~ 250ms），在切换瞬间：
  - 深色文字与浅色背景同时向相反方向渐变，在 80ms 时文字与底色均为 `#777777` 灰色，内容瞬间失明不可读；
  - 按钮边框和阴影在半透明过渡中产生发绿、发紫的光学脏色过渡带；
  - 整个视口呈现明显的「色彩黏连与拉丝感」，破坏专业原生软件的精致感。
- 依据 `better-ui/animations.md` § Suppress transitions on theme switch：
  > "Flipping the theme changes color, background-color, border-color and box-shadow on nearly every element at once. Everything carrying a transition on those properties animates together, so the switch reads as a slow smear rather than an instant change. Disable transitions for the swap and restore them right after."

---

### 2.5 缺陷 5：全仓嵌套容器圆角违反 $R_{outer} = R_{inner} + padding$ 同心几何全景排查清单

依据 `better-ui/surfaces.md` § Concentric border radius：
> **Concentric border radius rule**:  
> `outerRadius = innerRadius + padding`  
> The rule matters most when nested surfaces sit close together. Past 24px of padding, treat the layers as separate surfaces.

对全工程容器及内部控件进行地毯式扫描，发现以下严重违背同心几何公理的组件清单：

| 序号 | 所在文件与行号 | 容器组件与外角 $R_{outer}$ | 内部留白 Padding $P$ | 嵌套子元素与内角 $R_{inner}$ | 理论同心内角 ($R_o - P$) | 现状缺陷现象与断层原因 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | [`tokens.css:29-30`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L29-L30) | `--seg-outer-radius: 7px` | 约 2px ~ 3px | `--seg-inner-radius: 7px` | 4px ~ 5px | **内外半径完全相等**。滑块卡片四角紧贴轨道时产生明显的外弧挤压，几何彻底失真。 |
| **2** | [`Tabs.module.css:84-85`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css#L84-L85) | `.sizeSm`: 7px (外角) | 2px | `.trigger`: 5px (内角) | 5px (虽满足差值但引入非标 5px/7px) | 引入非 4/8 标尺奇数 7px 与 5px，与周围全局 6px/8px 控件格格不入。 |
| **3** | [`Tabs.module.css:104-107`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css#L104-L107) | `.sizeLg`: 10px (外角) | 3.5px | `.trigger`: 6.5px (内角) | 6.5px | **亚像素小数违规**。3.5px pad 与 6.5px radius 导致屏幕光栅化偏心与模糊。 |
| **4** | [`ModelsSettingsTab.module.css:18,60,72`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css#L18) | `.modelsSplit`: 12px | 8px (`.mrlList`) | `.mrlItem`: 8px | 4px ($12 - 8 = 4px$) | **内角（8px）严重大于理论值（4px）**。导致内项看起来比外壳还要圆，呈现视觉折角冲突。 |
| **5** | [`ModelsSettingsTab.module.css:374,410`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css#L374) | `.mrdAddForm`: 8px | 12px 14px | 同列 `.modelConfigPanel`: 7px | 统一样式标尺 | 并列卡片出现 8px 对 7px 的「圆角互搏」，没有任何设计道理。 |
| **6** | [`SettingsUI.module.css:81,91,147`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsUI.module.css#L81) | `.settingsUiCard`: 12px | 10px 14px | 内部 input: 7px 锁 | 8px / 6px | 外壳 12px，内嵌输入框与控件死锁 7px，未对齐 6px/8px 控件体系。 |
| **7** | [`ToastStackModern.module.css:79,80,348,362`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/ToastStackModern.module.css#L79) | `.toastCard`: 8px | 10px 14px | `.undoButton` / `.actionButton`: 4px | 8px - 10px < 0 | 外壳 8px 偏小（通知卡片偏硬），内边距 10px 导致角隅过窄，内按钮 4px 呈直角感。应外 12px、内 6px。 |
| **8** | [`ChatComposer.module.css:58,60,207`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L60) | `.flowPermissionBar`: 12px | 6px 12px | `.flowPermissionBarMore`: 4px | 6px ($12 - 6 = 6px$) | 内部胶囊 tag 设为 4px，小于理论同心值 6px，角隅同心失谐。 |
| **9** | [`ChatComposer.module.css:322,357,368`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L322) | `.planProgressBar`: 16px | 10px 14px | `.planExpandedStep`: 6px | 6px ($16 - 10 = 6px$) | 水平 padding 为 14px 时与 6px 产生非对称偏心（$16 - 14 = 2px$）。 |
| **10** | [`Input.module.css:30,107`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Input/Input.module.css#L107) | Regular `.input`: 6px / 8px | — | `.inputSearch`: 7px 锁 | 统一 6px/8px | 仅因带 search 属性就强制改写为 7px，破坏原子组件的尺寸正交性。 |
| **11** | [`Sidebar.module.css:169`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L169) | `.userProfileCard`: 12px | 4px 8px | 内嵌头像与文本 | 6px | 高度仅约 32px 的小卡片赋予 12px 大圆角，视觉呈近乎胶囊状，与侧栏其他 6px/8px 项失调。 |

---

## 三、精确改造方案与数学标尺推导

### 3.1 标尺系统一：全域同心几何圆角矩阵推导（Concentric Geometry Scale）

为彻底消除 5px、7px、10px、11px、13px 以及亚像素等杂乱值，严格基于 4px/8px 标尺网格，建立清晰规范的**四阶同心矩阵**：

$$\mathbf{R_{outer} = R_{inner} + Padding} \quad (\text{当 } Padding \le 24px)$$

```
┌─────────────────────────────────────────────────────────────┐
│ 阶梯 1 (Micro 紧凑控件): 轨道高度 24px                      │
│ R_outer = 6px (--radius-md)                                 │
│ └── Padding = 2px ──> R_inner = 4px (--radius-sm)           │
├─────────────────────────────────────────────────────────────┤
│ 阶梯 2 (Standard 标准控件): 控件高度 28px/32px              │
│ R_outer = 8px (--radius-lg)                                 │
│ └── Padding = 2px ──> R_inner = 6px (--radius-md)           │
│ └── 或 Padding = 4px ──> R_inner = 4px (--radius-sm)        │
├─────────────────────────────────────────────────────────────┤
│ 阶梯 3 (Elevated 悬浮卡片/弹层): Toast / PreviewCard        │
│ R_outer = 12px (--radius-xl)                                │
│ └── Padding = 4px ──> R_inner = 8px (--radius-lg)           │
│ └── 或 Padding = 6px ──> R_inner = 6px (--radius-md)        │
├─────────────────────────────────────────────────────────────┤
│ 阶梯 4 (Macro 结构大卡片/模态): SmartPanel / Dialog         │
│ R_outer = 14px (--sep-radius-outer) / 16px (Dialog)        │
│ └── Padding = 6px ──> R_inner = 8px (--sep-radius-inner)   │
│ └── Padding = 8px ──> R_inner = 8px                         │
└─────────────────────────────────────────────────────────────┘
```

#### 标准尺寸矩阵映射表
| 规格档位 | 控件外高 | 推荐外圆角 $R_{outer}$ | 内边距 Padding | 内部滑块/控件内圆角 $R_{inner}$ | 适用典型组件 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **xs** | 24px | `var(--radius-md, 6px)` | 2px (整像素) | `calc(var(--radius-md) - 2px) = 4px` (`--radius-sm`) | `SegmentedControl xs`, `Tabs xs`, `Button xs` |
| **sm** | 28px | `var(--radius-lg, 8px)` | 2px (整像素) | `calc(var(--radius-lg) - 2px) = 6px` (`--radius-md`) | `SegmentedControl sm`, `Tabs sm`, `Button sm` |
| **md (默认)**| 32px | `var(--radius-lg, 8px)` | 2px (紧凑) / 3px | `calc(var(--radius-lg) - 2px) = 6px` (`--radius-md`) | `Button md`, `Input md`, `Tabs md`, `SegmentedControl md` |
| **lg** | 40px | `var(--radius-xl, 12px)` | 4px (整像素) | `calc(var(--radius-xl) - 4px) = 8px` (`--radius-lg`) | `Button lg`, `Input lg`, `Tabs lg`, `SegmentedControl lg` |
| **panel/card**| 自适应 | `var(--sep-radius-outer, 14px)`| 6px (整像素) | `var(--sep-radius-inner, 8px)` | `Menu`, `SmartPanel`, `SelectContent` |
| **dialog** | 自适应 | `16px` | 16px (视口解耦层) | 内部操作按钮采用标准 6px / 8px | `Dialog`, `ConfirmDialog` |

---

### 3.2 标尺系统二：Apple 物理流体与按压动效体系（Fluid Motion & Physics）

#### 1. 按压触感参数方程（Scale on Press）
依据 `better-ui/animations.md` 与 `apple-design.md`，为所有原子操作注入物理压缩手感：
- **压缩比率**：严格锁定为 `scale(0.96)`（标准按钮）与 `scale(0.97)`（小面积标签项），**绝不允许低于 0.95**（低于 0.95 会呈现弹簧过度变形的廉价感）；
- **时间参数**：
  - 按下（Press In / Pointer Down）：`80ms ~ 100ms`，采用 `ease-out`，实现「零感知迟滞、触碰即凹陷」；
  - 释放（Release / Snap Back）：`140ms ~ 160ms`，采用 Apple 临界减速曲线 `cubic-bezier(0.16, 1, 0.3, 1)`，平滑归位；
- **React 静态逃逸契约**：在 `<Button>` 中引入 `static` 属性，当 `static={true}` 时不注入 active 缩放，满足密集操作与特殊嵌入场景。

```css
/* 标准按钮原子按压物理层 */
.button {
  transform: scale(1);
  will-change: transform;
  transition:
    transform 140ms cubic-bezier(0.16, 1, 0.3, 1),
    border-color var(--transition-micro, 100ms) ease-out,
    box-shadow var(--transition-micro, 100ms) ease-out;
}

.button:active:not(:disabled):not([data-static='true']) {
  transform: scale(0.96);
  transition-duration: 80ms;
}

/* 减弱动态适配 */
@media (prefers-reduced-motion: reduce) {
  .button, .button:active:not(:disabled) {
    transform: none !important;
  }
}
```

#### 2. 贝塞尔曲线全面纯正化（移除 1.5 过冲抖动）
废除 `--tab-spring-bezier: cubic-bezier(0.175, 0.885, 0.32, 1.5)` 与 `--transition-spring` 中的过冲参数，全面归一为 Apple 流体标准曲线：

| 用途场景 | 现有缺陷参数 | 重构规范参数 | 物理阻尼机理与特性 |
| :--- | :--- | :--- | :--- |
| **Tabs / SegmentedControl 滑块位移** | `cubic-bezier(0.175, 0.885, 0.32, 1.5)` (过冲 50%) | **`cubic-bezier(0.2, 0, 0, 1)`** | **临界阻尼（$\zeta = 1.0$）**。前 20% 时间完成 80% 位移，后段极其柔顺地滑入停点，0 抖动，与 Apple macOS 系统分段控制完全一致。 |
| **弹窗 / 浮层进入（Modal Enter）** | `cubic-bezier(0.16, 1, 0.3, 1) 220ms` | **`cubic-bezier(0.16, 1, 0.3, 1) 200ms`** | 纯粹的自然减速曲线，快速冲出并在目标位置精准制动。 |
| **浮层退出（Modal Exit）** | `ease-in` / `cubic-bezier(0.4, 0, 1, 1)` | **`cubic-bezier(0.4, 0, 0.2, 1) 140ms`** | 快速加速离场，避免阻碍用户下一步操作。 |
| **手势投掷（Flick / Momentum Throw）** | （若有连续手势拖拽场景） | `bounce: 0.2, duration: 0.4s` | 仅在检测到正向 Pointer Velocity 时注入轻微回弹（$\zeta \approx 0.8$）。离散点击禁止启用。 |

---

### 3.3 标尺系统三：Dialog 景深磨砂与模态 Scrim 重塑

针对 `Dialog.module.css` 的 1.5px 极浅毛刺与 4% 不透明度塌陷问题，重构为符合 WWDC Depth & Translucency 的真实物理材质：

```css
/* 重塑 Dialog 景深磨砂层 */
.backdrop {
  position: absolute;
  inset: 0;
  /* 柔和暗化 Scrim：浅色模式 22% 混入，深色模式 48% 混入，产生压低背景的空间感 */
  background: color-mix(in srgb, var(--shadow-color, #000000) 22%, transparent);
  backdrop-filter: blur(16px) saturate(180%);
  -webkit-backdrop-filter: blur(16px) saturate(180%);
  transition:
    opacity var(--duration-enter, 200ms) ease-out,
    backdrop-filter var(--duration-enter, 200ms) ease-out;
}

:global(html[data-theme='dark']) .backdrop {
  background: color-mix(in srgb, #000000 48%, transparent);
  backdrop-filter: blur(20px) saturate(190%);
  -webkit-backdrop-filter: blur(20px) saturate(190%);
}

/* 减弱透明度模式无障碍退化 */
@media (prefers-reduced-transparency: reduce) {
  .backdrop {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    background: color-mix(in srgb, var(--shadow-color, #000000) 65%, transparent);
  }
}
```

---

### 3.4 标尺系统四：主题切换无感冻结门闩（Zero-Smear Theme Latch）

依据 `better-ui/animations.md` § Suppress transitions on theme switch，在切换主题时必须阻断所有 `transition`，在同一渲染帧内让新主题的 Tokens 瞬间生效并完成 GPU 重绘，随后安全归还过渡能力：

#### 1. 核心执行机制与算法
```typescript
/**
 * apps/crish-desktop/src/api/themeTransitionLatch.ts
 * 主题切换瞬态动画冻结门闩 (Zero-Smear Theme Transition Latch)
 * 
 * 机制：
 * 1. 创建高优先级内联 <style>，向整个 DOM 注入 `*, *::before, *::after { transition: none !important; }`；
 * 2. 执行主题变更（DOM 属性、Class 翻转、个性化 Token 注入）；
 * 3. 读取 `document.body.offsetHeight` 强制触发浏览器同步回流（Reflow），迫使新颜色在无过渡状态下即刻落盘；
 * 4. 利用嵌套的双重 requestAnimationFrame，在下一次真正重绘后安全移除门闩，恢复控件正常的交互微过渡。
 */
export function withThemeTransitionFreeze<T>(fn: () => T): T {
  if (typeof document === 'undefined') {
    return fn();
  }

  const style = document.createElement('style');
  style.setAttribute('data-latch', 'theme-transition-freeze');
  style.appendChild(
    document.createTextNode('*, *::before, *::after { transition: none !important; }')
  );
  document.head.appendChild(style);

  let result: T;
  try {
    result = fn();
  } finally {
    // 关键副作用：强制同步 Style Flush / Layout，使新主题 Tokens 立即生效且不触发任何 transition
    const _flushReflow = document.body.offsetHeight;

    // 双重 rAF 确保在下一帧 Paint 完成后才撕掉封条
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        style.remove();
      });
    });
  }

  return result;
}
```

#### 2. 在 `themeStore.ts` 中的刚性装配
在 [`themeStore.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/themeStore.ts) 的 `applyTheme` 与 `setTheme` 中进行包裹：
```typescript
export function applyTheme(theme: UiTheme | string): UiTheme {
  return withThemeTransitionFreeze(() => {
    const t = normalizeTheme(theme);
    const html = document.documentElement;
    html.setAttribute('data-theme', t);
    document.body.setAttribute('data-theme', t);
    html.classList.toggle('theme-dark', t === 'dark');
    html.classList.toggle('theme-light', t !== 'dark');
    document.body.classList.toggle('theme-dark', t === 'dark');
    document.body.classList.toggle('theme-light', t !== 'dark');

    try {
      const p = readStoredPersonalization();
      applyPersonalization(p, t);
    } catch {}

    return t;
  });
}
```
通过该机制，全站轻/暗模式与肤色预设的切换将呈现**干净利落的原生瞬间切换**，彻底根除 200ms 的色彩混浊泥潭。

---

## 四、物理删除与改造清单（净负产出目标）

为严格践行「先删后改，强制负产出」的主控原则，以下为 DIM-02 维度的明确删除与改造清单：

### 4.1 物理删除面（Delete Manifest）
1. **删除 `tokens.css` 中的废弃与破坏同心圆角的变量**：
   - 物理删除 `tokens.css:26`：`--button-radius: 7px;`（清除 7px 毒瘤源头）；
   - 物理删除 `tokens.css:29-30`：`--seg-outer-radius: var(--button-radius, 7px); --seg-inner-radius: var(--button-radius, 7px);`；
   - 物理删除 `tokens.css:234`：`--sep-ease-spring: cubic-bezier(0.22, 1.25, 0.36, 1);`（1.25 假弹簧过冲）；
   - 物理删除 `tokens.css:420`：`--transition-spring: 500ms cubic-bezier(0.175, 0.885, 0.32, 1.275);`（1.275 假弹簧过冲）；
   - 物理删除 `tokens.css:457-458`：`/* 设置/按钮圆角锁：默认档 7px... */ --button-radius: 7px;`。
2. **删除各组件中硬编码的 7px 与 5px/10px 畸变值**：
   - 删除 `Button.module.css:11, 102, 112` 中的 `var(--button-radius, 7px)` fallback 与私设；
   - 删除 `Tabs.module.css:7` 中的 `cubic-bezier(0.175, 0.885, 0.32, 1.5)`；
   - 删除 `Tabs.module.css:84-85` 中的 `--tab-outer-radius: var(--button-radius, 7px)` 与 5px 内圆角；
   - 删除 `Tabs.module.css:104-107` 中的 3.5px 亚像素 pad 与 6.5px 亚像素 radius；
   - 删除 `PreviewCard.module.css:48` 中的 `cubic-bezier(0.175, 0.885, 0.32, 1.5)`；
   - 删除 `SettingsUI.module.css:147, 201, 225` 中的 `var(--button-radius, 7px)`；
   - 删除 `Input.module.css:107` 中的 `.inputSearch { border-radius: var(--button-radius, 7px); }`；
   - 删除 `ModelsSettingsTab.module.css:410` 中的 `.modelConfigPanel { border-radius: var(--button-radius, 7px); }`。

### 4.2 改造清单（Refactor Manifest）
| 文件路径 | 现存代码/参数 | 目标改造代码/参数 | 改造理由与预期成效 |
| :--- | :--- | :--- | :--- |
| [`Button.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css) | 无 scale，--btn-radius: 7px | `--btn-radius: var(--radius-md, 6px);`，`:active` 注入 `transform: scale(0.96);` | 接入 4/8 网格标尺，赋予实体按压触感。 |
| [`Button.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.tsx) | 无 static 属性 | 扩展 `static?: boolean`，透传 `data-static={static \|\| undefined}` | 提供特殊高频列表的静态防抖动逃逸通道。 |
| [`Tabs.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css) | 1.5 过冲，7px/5px/3.5px 几何 | `--tab-spring-bezier: cubic-bezier(0.2, 0, 0, 1);`，sm 档改用 8px/6px，lg 档改用 12px/8px (pad 4px) | 消除 50% 果冻晃荡，根除亚像素偏心走样。 |
| [`Tabs.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tabs/Tabs.test.tsx) | 断言 `1.5` 与 `7px` | 断言 `cubic-bezier(0.2, 0, 0, 1)` 与 `var(--radius-lg, 8px)` | 修正测试门禁契约，防止 CI 误报。 |
| [`Dialog.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css) | `blur(1.5px)`，4% 极浅背景 | `blur(16px) saturate(180%)`，22%~48% scrim 遮罩 | 恢复模态弹窗的高级景深感与专注沉浸感。 |
| [`themeStore.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/themeStore.ts) | 裸调 `setAttribute('data-theme')` | 经由 `withThemeTransitionFreeze(...)` 执行 | 注入切换门闩，彻底消灭全页色彩涂抹。 |
| [`PreviewCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.module.css) | `1.5` 晃荡过冲动画 | `cubic-bezier(0.16, 1, 0.3, 1) 180ms` | 弹层入场自然减速降落，无越位震颤。 |
| [`ModelsSettingsTab.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css) | 外壳 12px / 内项 8px (pad 8px) | 外壳 14px / pad 6px / 内项 8px（或外壳 12px / pad 4px / 内项 8px） | 严谨满足 $R_o = R_i + P$，内项不再比外壳更圆。 |
| [`ToastStackModern.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/ToastStackModern.module.css) | 外壳 8px / pad 10px / 按钮 4px | 外壳 12px (`--radius-xl`) / pad 8px / 按钮 6px (`--radius-md`) | $12px = 6px + 6px$ 刚性同心，通知卡片饱满高级。 |

---

## 五、立体验证与门禁护栏方案

根据 `AGENTS.md` § 7.1 立体验证纪律，DIM-02 的所有改进在实现阶段必须通过三层刚性门禁：

1. **静态代码契约断言（Static AST / Regex Lint）**：
   - 编写专项测试 `tests/ui/motion-concentric-contract.test.ts`：
     - 正则扫描所有 CSS 文件，**严禁再次出现** `cubic-bezier(*, *, *, 1.1+)`（禁止 $y_2 > 1.0$ 的过冲曲线）；
     - 扫描全仓 CSS，**严禁再次出现** `--button-radius: 7px` 或 `--btn-radius: 7px`；
     - 扫描主要嵌套组件（Tabs, SegmentedControl, SmartPanel, SelectContent），验证其 CSS 中声明的 `R_outer` 与 `R_inner` 及 `padding` 必须满足整像素同心等式。
2. **自动化组件交互测试（Vitest / Testing Library）**：
   - 验证 `Tabs.test.tsx`：更新为 Apple 临界阻尼曲线断言，验证不同尺寸档位同心几何完整性；
   - 验证 `Button.test.tsx`：新增对 `data-static` 属性的测试，验证 active 状态下 transform 样式的产生与抑制；
   - 验证 `themeTransitionLatch.test.ts`：模拟 `applyTheme` 调用，断言内联 `<style>` 门闩的注入、`document.body.offsetHeight` 的触发以及下一帧 rAF 的自动清理。
3. **现场端到端视觉与性能验收（Tauri MCP 4000 端口）**：
   - 启动 `npm run dev:workbench`，通过 `127.0.0.1:4000` 连接应用；
   - 检查高分屏下 Tabs 滑块位移，确认 0 抖动、0 过冲破框；
   - 触发浅/深主题切换，录屏核验全页零色彩涂抹、零 FOUC 蠕动；
   - 打开设置与模态 Dialog，确认背景文本产生纯净的毛玻璃景深模糊（`blur(16px)`）。

---

## 六、与其它维度的协同接口

- **与 DIM-01（Token 碎片收敛）协同**：
  DIM-02 废除的 `--button-radius: 7px` 与过冲贝塞尔变量，由 DIM-01 从 `tokens.css` 根源彻底抹除并更新 token 导引图。
- **与 DIM-03（原子组件收敛与光学平衡）协同**：
  DIM-03 在为 `<Button>` 引入 `-2px` 图标侧光学内边距补正的同时，DIM-02 为其注入 `scale(0.96)` 触感压缩与 `static` 属性，共同交付完全体 Apple 级原子按钮。
- **与 DIM-04（色彩角色与焦点无障碍）协同**：
  DIM-02 的 Dialog Scrim 调光与主题动画冻结门闩，为 DIM-04 的一屏一主色和 WCAG 对比度提供干净稳定的物理渲染底板。
