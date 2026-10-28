# 样式系统与 Design Tokens 体系深度剖析与演进方案

> **专项领域**：样式架构、Design Tokens 体系、类名处理与变体管理  
> **报告作者**：样式系统与 Design Tokens 体系分析专家（Style System & Tokens Analyst）  
> **标杆对标**：`reference/appica-ui`（Tailwind CSS v4 + `@theme inline` + Role-based Tokens + CVA + Modern Variants）、`reference/prose-ui`（TypeScript 强类型 DesignSpec + Token-based CSS 体系）  
> **对照标的**：当前仓库 `apps/crish-desktop` 样式基础设施与原子组件体系（`src/styles/` 与 `src/components/ui/`）  
> **报告日期**：2026-10-27  

---

## 目录

1. [战役背景与执行摘要](#1-战役背景与执行摘要)
2. [标杆深度解构一：Appica UI 的现代样式架构与 Token 哲学](#2-标杆深度解构一appica-ui-的现代样式架构与-token-哲学)
   - 2.1 [Tailwind CSS v4 架构与 `@theme inline` 机制](#21-tailwind-css-v4-架构与-theme-inline-机制)
   - 2.2 [Role-based 语义色彩与 Token 模型（去色相化与 OKLCH 色彩空间）](#22-role-based-语义色彩与-token-模型去色相化与-oklch-色彩空间)
   - 2.3 [前沿原生变体语法（彻底终结 `[&_...]` 脆弱嵌套与选择器拼接）](#23-前沿原生变体语法彻底终结-_-脆弱嵌套与选择器拼接)
   - 2.4 [CVA + `cn` (clsx + tailwind-merge) 变体管理与冲突消解范式](#24-cva--cn-clsx--tailwind-merge-变体管理与冲突消解范式)
3. [标杆深度解构二：Prose UI 的类型驱动 Design Tokens 体系](#3-标杆深度解构二prose-ui-的类型驱动-design-tokens-体系)
   - 3.1 [TypeScript 强类型 DesignSpec 与自动化 CSS 生成管道](#31-typescript-强类型-designspec-与自动化-css-生成管道)
   - 3.2 [三层核心分级模型（Core, Colors, Components）](#32-三层核心分级模型core-colors-components)
4. [Conex / Crish 当前样式基础设施现状与深层痛点审查](#4-conex--crish-当前样式基础设施现状与深层痛点审查)
   - 4.1 [现有 Token 资产与契约防护体系（优势与积淀）](#41-现有-token-资产与契约防护体系优势与积淀)
   - 4.2 [纯 CSS Modules 架构的六大瓶颈与痛点剖析](#42-纯-css-modules-架构的六大瓶颈与痛点剖析)
5. [标杆与当前系统全景维度对比矩阵](#5-标杆与当前系统全景维度对比矩阵)
6. [Conex / Crish 样式系统现代化演进路线与实施方案](#6-conex--crish-样式系统现代化演进路线与实施方案)
   - 6.1 [阶段一：Token 体系重塑与去色相化收敛（Role-based & OKLCH 规范）](#61-阶段一token-体系重塑与去色相化收敛role-based--oklch-规范)
   - 6.2 [阶段二：引入 CVA + clsx + tailwind-merge，标准化组件变体引擎](#62-阶段二引入-cva--clsx--tailwind-merge标准化组件变体引擎)
   - 6.3 [阶段三：引入 Tailwind CSS v4 与 `@theme inline`（平滑渐进迁移策略）](#63-阶段三引入-tailwind-css-v4-与-theme-inline平滑渐进迁移策略)
   - 6.4 [阶段四：自动化门禁改造与《样式系统编码宪章》](#64-阶段四自动化门禁改造与样式系统编码宪章)

---

## 1. 战役背景与执行摘要

在桌面端现代化 AI Agent 工作台的演进中，UI 呈现的专业度、响应性能与长期可维护性高度依赖于底层样式基础设施。现代化前沿 UI 标杆库（以 `reference/appica-ui` 与 `reference/prose-ui` 为代表）展现了当今前端样式架构的两大巅峰方向：
1. **Appica UI**：代表了 **Tailwind CSS v4 + `@theme inline` + Role-based Tokens + CVA + Modern Variants** 的现代化原子与语义驱动架构。其彻底摒弃了以具体色相命名的浅层 Token，实现了 100% 角色语义驱动；采用 Tailwind v4 革命性的子代选择符（`*:`、`**:`）与否定属性选择符（`not-data-*:`），彻底消灭了以往充满转义字符的脆弱嵌套（`[&_...]`）；并通过 CVA 与 `tailwind-merge` 实现了类型安全与类名冲突消解。
2. **Prose UI**：代表了 **TypeScript 驱动的单源设计规范（DesignSpec）**，通过纯函数管道将编译期强类型 Token 树编译为具有响应式能力的 CSS 变量字典，保证了从类型定义到 CSS 呈现的绝对同构。

反观 Conex / Crish 当前架构（`apps/crish-desktop`），虽然在工程治理上建立了极其严苛的 CI 门禁（如 `check:color-ssot`、`check:token-consistency` 等）以及 9 模块物理拆分的 `tokens-*.css`，但由于历史技术选型停留在**纯 CSS Modules + 手写字符串拼接**，随着组件体系复杂化，暴露出日益严峻的六大瓶颈：
- **变体组合爆炸与样板代码泥潭**：每个原子组件均充斥着 `VARIANT_CLASS`、`SIZE_CLASS` 字典与 `[...].filter(Boolean).join(' ')` 手动拼接，复合变体规则臃肿且缺乏编译期类型保障；
- **外部 `className` 覆盖冲突与特异度不可控（Specificity Hazard）**：CSS Modules 生成的哈希类名无法感知 CSS 属性冲突，外部样式覆盖完全依赖样式打包级联顺序，导致诡异的覆盖失效或生产环境样式错位；
- **样式冗余膨胀与体积浪费（Bundle Bloat）**：每个组件重复书写 flex 居中、focus 环、disabled 遮罩与过渡动画，无法享受原子化 CSS 的边际体积递减红利；
- **复杂状态组合选择器脆弱繁杂**：手写冗长的 `:where(:hover:not(:disabled):not([aria-disabled='true']))::before`，缺乏现代原子状态变体组合能力；
- **Token 命名碎片化与历史别名债务**：单一语义角色（如 Danger/Error）散落 7 种别名，裸 Hex、HSL 与 OKLCH 混杂，大量 `[WAVE2-DEPRECATED-ALIAS]` 长期滞留；
- **原子复用缺失与组件边界僵化**：无原子类支持，微调边距或排版要么新建 `.module.css`，要么冒着违规风险内联样式。

本报告对标 Appica UI 与 Prose UI 的精妙架构，逐层深挖其设计哲学与技术实现，对照 Crish Desktop 现有代码深入诊断，并给出平滑、可靠且符合本仓严苛门禁纪律的现代化演进路线。

---

## 2. 标杆深度解构一：Appica UI 的现代样式架构与 Token 哲学

### 2.1 Tailwind CSS v4 架构与 `@theme inline` 机制

在 `reference/appica-ui/packages/react/styles.css` 中，Appica UI 采用了全新一代的 Tailwind CSS v4 规范。与 Tailwind v3 相比，v4 发生的最根本变革是**全面回归 CSS 原生标准**，消除了庞大的 JavaScript 运行时配置文件（`tailwind.config.js`），转而在原生 CSS 语法层完成主题配置与变体拓展。

#### 1. 原生 `@import` 与 `@custom-variant`
在 `styles.css` 第 8–29 行中，代码展现了极简且强大的原生接入方式：
```css
/* reference/appica-ui/packages/react/styles.css:8-29 */
@import 'tailwindcss';

@custom-variant dark (&:is(.dark *));

@custom-variant motion-reduce {
  @media (prefers-reduced-motion: reduce) {
    @slot;
  }
  &:is([data-disable-animations] *) {
    @slot;
  }
}

@custom-variant motion-safe {
  @media (prefers-reduced-motion: no-preference) {
    &:not([data-disable-animations] *) {
      @slot;
    }
  }
}

@custom-variant hover-none (@media (hover: none));
```
**深度剖析**：
- **`@custom-variant dark`**：通过 `(&:is(.dark *))` 实现灵活的暗色作用域匹配，不仅支持根节点 `.dark`，还天然支持局部容器的暗色主题岛（Dark Island）。
- **`@custom-variant motion-reduce / motion-safe`**：将系统级媒体查询 `prefers-reduced-motion` 与业务级 DOM 标记 `[data-disable-animations]` 统一绑定在一个变体槽（`@slot`）中。组件编写时只需声明 `motion-safe:transition` 或 `motion-reduce:transition-none`，就能同时响应系统级无障碍设置和应用层全局动效开关。

#### 2. `@theme inline` 的设计精髓
在 `styles.css` 第 31–179 行，Appica UI 声明了庞大的 `@theme inline` 映射块：
```css
/* reference/appica-ui/packages/react/styles.css:31-60 */
@theme inline {
  --color-foreground: var(--foreground);
  --color-foreground-subtle: var(--foreground-subtle);
  --color-foreground-muted: var(--foreground-muted);
  --color-foreground-strong: var(--foreground-strong);
  --color-foreground-emphasis: var(--foreground-emphasis);
  --color-foreground-intense: var(--foreground-intense);
  --color-foreground-inverse: var(--foreground-inverse);

  --color-background: var(--background);
  --color-background-subtle: var(--background-subtle);
  --color-background-muted: var(--background-muted);
  --color-background-strong: var(--background-strong);
  --color-background-inverse: var(--background-inverse);

  --color-border: var(--border);
  --color-border-muted: var(--border-muted);
  --color-border-strong: var(--border-strong);
  --color-border-emphasis: var(--border-emphasis);
  --color-border-intense: var(--border-intense);
  --color-border-inverse: var(--border-inverse);
  --color-border-overlay: var(--border-overlay);

  --color-primary: var(--primary);
  --color-primary-subtle: var(--primary-subtle);
  --color-primary-soft: var(--primary-soft);
  --color-primary-muted: var(--primary-muted);
  --color-primary-strong: var(--primary-strong);
  --color-primary-foreground: var(--primary-foreground);
  ...
}
```
**关键机制解密**：
- **为什么使用 `inline`**：普通 `@theme` 会在构建时由 Tailwind 注入静态工具类映射，如果 `:root` 中的 CSS 变量仅被生成的工具类消费，可能会在某些摇树优化中被误删。而 `@theme inline` 强制 Tailwind 将生成的工具类直接内联引用原生 CSS 变量（例如生成 `.bg-background-muted { background-color: var(--background-muted); }`）。
- **动静解耦（Static-Dynamic Decoupling）**：构建期工具类名（如 `text-foreground-muted`）在编译时生成，而具体颜色值完全由运行时 `:root` 与 `.dark` 的 CSS 变量实时提供（`styles.css:181-381`）。这意味着修改主题、调整亮度模式甚至运行时注入动态换肤，都**完全不需要重新编译 CSS 样式表**！

---

### 2.2 Role-based 语义色彩与 Token 模型（去色相化与 OKLCH 色彩空间）

#### 1. 严格的 Role-based 语义化（绝不使用色相命名）
在 Appica UI 的体系中（见 `styles.css` 与 `AGENTS.md:27`），**严禁出现任何色相具象命名**（如 `gray-100`、`blue-500`、`zinc-800` 等），也严禁直接书写裸十六进制。全部 Token 均按**职责角色（Semantic Role）与层级深度（Hierarchy）** 命名：

| 语义层级 | 角色 Token 阶梯 | 视觉用途与语义意图 |
| :--- | :--- | :--- |
| **Foreground 前景** | `foreground` (基准)<br>`subtle` (微弱/占位)<br>`muted` (静音/辅助)<br>`strong` (较强)<br>`emphasis` (强调)<br>`intense` (最强/标题)<br>`inverse` (反色) | 用于文本排版与图标。从轻描淡写到高对比标题建立严密的信息层级阶梯，彻底替代散乱的数字梯度。 |
| **Background 背景** | `background` (基底画布)<br>`subtle` (微弱层次)<br>`muted` (静音衬底)<br>`strong` (厚实表面)<br>`inverse` (反色实心) | 严格区分表面层次。从基准画布到悬浮卡片、输入坞，通过语义明度差建立空间秩序。 |
| **Border 描边** | `border` (常规分隔)<br>`muted` (极淡发丝线)<br>`strong` (明显边界)<br>`emphasis` (聚焦前边缘)<br>`intense` (高对比外框)<br>`inverse` (反色边界)<br>`overlay` (弹层轮廓) | 约束描边预算。避免粗黑线条破坏视觉纯净感，形成柔和细腻的界面轮廓。 |
| **Semantic Status** | `primary` / `secondary` / `error` / `success` / `warning` / `info`<br>统一子阶梯：`subtle` / `soft` / `muted` / `strong` / `emphasis` / `intense` / `foreground` | 任何功能性颜色域均具备完整的明暗与衬底系列，例如 `bg-error-subtle`（柔和背景）、`border-error`（边框）、`text-error-foreground`（反白文字）。 |

#### 2. 全面采用 OKLCH 感知均匀色彩空间
在 `styles.css` 第 181–381 行中，无论浅色还是深色主题，全部色值统一声明为 `oklch(L C H)` 格式：
```css
/* reference/appica-ui/packages/react/styles.css:181-196 (Light) */
:root,
.light {
  --foreground: oklch(0.446 0.03 256.802);
  --foreground-subtle: oklch(0.707 0.022 261.325);
  --foreground-muted: oklch(0.551 0.027 264.364);
  --foreground-strong: oklch(0.373 0.034 259.733);
  --foreground-emphasis: oklch(0.278 0.033 256.848);
  --foreground-intense: oklch(0.21 0.034 264.665);
  --foreground-inverse: oklch(1 0 0);

  --background: oklch(1 0 0);
  --background-subtle: oklch(0.985 0.002 247.839);
  --background-muted: oklch(0.967 0.003 264.542);
  --background-strong: oklch(0.928 0.006 264.531);
  --background-inverse: oklch(0.13 0.028 261.692);
  ...
}

/* reference/appica-ui/packages/react/styles.css:294-307 (Dark) */
.dark {
  --foreground: oklch(0.872 0.01 258.338);
  --foreground-subtle: oklch(0.551 0.027 264.364);
  --foreground-muted: oklch(0.707 0.022 261.325);
  --foreground-strong: oklch(0.928 0.006 264.531);
  --foreground-emphasis: oklch(0.967 0.003 264.542);
  --foreground-intense: oklch(1 0 0);
  --foreground-inverse: oklch(0.21 0.034 264.665);

  --background: oklch(0.13 0.028 261.692);
  --background-subtle: oklch(0.551 0.027 264.364 / 8%);
  --background-muted: oklch(0.21 0.034 264.665);
  --background-strong: oklch(0.278 0.033 256.848);
  --background-inverse: oklch(1 0 0);
  ...
}
```
**OKLCH 的划时代优势**：
1. **感知线性（Perceptual Uniformity）**：传统 sRGB/HSL 空间中，相同明度数值（Lightness）在黄色和蓝色下的人眼感知亮度差异极大（例如 HSL 下的黄色极刺眼而纯蓝极昏暗）。OKLCH 的 $L$ 分量真实反映人眼视觉亮度，这使得浅色与深色主题切换时，只需按比例调整 $L$ 分量，即可保证无障碍对比度（WCAG Contrast Ratio）在所有色相下完全均匀一致。
2. **现代斜杠透明度语法**：`oklch(0.551 0.027 264.364 / 8%)` 提供了无损透明度通道，取代了过去破坏色彩常量的非标准混色手段。

#### 3. 基于比例尺度的同心圆角 Token（Concentric Radius Scaling）
在 `styles.css` 第 273–285 行中，圆角并不是散乱的硬编码，而是以基准圆角 `--radius: 0.875rem` 为基础，通过乘数因子系统性派生：
```css
/* reference/appica-ui/packages/react/styles.css:273-284 */
--radius: 0.875rem;
--radius-4xs: calc(var(--radius) * 2 / 7); /* 0.25rem = 4px */
--radius-3xs: calc(var(--radius) * 3 / 7); /* 0.375rem = 6px */
--radius-2xs: calc(var(--radius) * 4 / 7); /* 0.5rem = 8px */
--radius-xs:  calc(var(--radius) * 5 / 7); /* 0.625rem = 10px */
--radius-sm:  calc(var(--radius) * 6 / 7); /* 0.75rem = 12px */
--radius-md:  var(--radius);               /* 0.875rem = 14px */
--radius-lg:  calc(var(--radius) * 8 / 7); /* 1rem = 16px */
--radius-xl:  calc(var(--radius) * 9 / 7); /* 1.125rem = 18px */
--radius-2xl: calc(var(--radius) * 12 / 7);/* 1.5rem = 24px */
--radius-3xl: calc(var(--radius) * 16 / 7);/* 2rem = 32px */
--radius-4xl: calc(var(--radius) * 20 / 7);/* 2.5rem = 40px */
```
该数学模型确保了整个组件库在修改基准 `--radius` 时，所有层级的子组件圆角能够保持严格的同心几何比例协同缩放，避免了局部圆角失真。

---

### 2.3 前沿原生变体语法（彻底终结 `[&_...]` 脆弱嵌套与选择器拼接）

在传统的 Tailwind v3 或普通 CSS 中，针对后代、兄弟或属性状态的样式定制往往需要依赖复杂的任意选择器（如 `[&_svg]:size-4`、`[&>[data-slot='indicator']]:opacity-0` 等）。此类选择器存在三大硬伤：
- 字符串充满括号与下划线转义，阅读体验极差；
- 增加了 CSS 选择器特异度，极易引发难以预期的层叠覆盖故障；
- 无法被 Tailwind 的静态分析器进行属性重叠去重。

在 `reference/appica-ui/packages/react/AGENTS.md` 第 29 行中，项目设立了刚性铁律：
> *"Prefer the v4 variant shorthand over arbitrary-selector escape hatches. Use `*:` for direct children, `**:` for descendants, and `data-[attr=value]:` / `data-attr:` for data attributes... The arbitrary `[&_...]` form is only acceptable when no built-in variant can express the selector (e.g. tag-name descendants like `[&_svg]:`)."*

让我们查看其真实代码中的前沿语法实践：

#### 1. 直接子元素 `*:` 与任意后代 `**:`
- **头像组边框穿透**（`avatar.tsx:147`）：
  ```tsx
  '*:data-[slot=avatar]:ring-background *:data-[slot=avatar]:ring-[calc(1em/12)]'
  ```
  直接将所有子代 Avatar 插槽注入环形边框，无需在子组件中手动写判断，也不用写脆弱的 `[&>[data-slot=avatar]]`。
- **组合输入框后代内边距**（`combobox.tsx:156`）：
  ```tsx
  "flex h-full min-w-0 flex-1 flex-wrap items-center gap-1 **:data-[slot=combobox-input-field]:px-1"
  ```
  `**:` 代表任意层级的深层后代选择，直观且无需逃逸选择器。
- **网格单点重合布局**（`copy-button.tsx:125`）：
  ```tsx
  <span className="grid place-items-center *:[grid-area:1/1]">
  ```
  直接将所有直接子元素全部锁进同一个网格单元（`grid-area: 1/1`），一行原子类直接完成传统 CSS 需要 10 行绝对定位的图标叠放！

#### 2. 数据属性驱动与否定变体 `not-*:` 的多维正交
在 Headless UI（如 Base UI / Radix UI）中，状态由 `data-*` 属性驱动（`data-checked`、`data-disabled`、`data-invalid`、`data-popup-open`）。现代变体语法支持**无限链式组合与否定筛选**：
- **按钮微触感排斥弹层状态**（`button-variants.ts:16`）：
  ```ts
  "not-data-popup-open:active:scale-[0.97] not-data-popup-open:active:duration-100"
  ```
  **语义**：仅当按钮在未打开弹出菜单（`not-data-popup-open`）且被激活按下（`:active`）时，才触发缩小 `scale-[0.97]` 微触感；若弹层已打开，则点击关闭时不发生形变。传统 CSS 需编写繁琐的 `:active:not([data-popup-open])`，而此处完全以原子变体前缀解决！
- **复选框的四维状态互斥**（`checkbox.tsx:139`）：
  ```ts
  'hover:not-data-checked:not-data-indeterminate:not-data-disabled:not-data-invalid:border-border-emphasis'
  ```
  **语义**：悬停时，当且仅当未选中（`not-data-checked`）、未处于半选（`not-data-indeterminate`）、非禁用（`not-data-disabled`）、非校验错误（`not-data-invalid`）时，边框才呈现高亮。这种极度严密的逻辑判定，在传统 CSS Modules 中需要写极其庞杂的组合伪类选择器，而现代变体以一行清晰声明彻底解决。

#### 3. 关系查询 `:has()` 的原子化（`has-data-[slot=...]:`）
在 `dropdown-menu.tsx:87-88` 中：
```ts
'has-data-[slot=dropdown-menu-input]:gap-2 has-data-[slot=dropdown-menu-input]:*:data-[slot=dropdown-menu-list]:pt-0'
```
当菜单内部包含搜索输入框插槽时，动态将间距设为 `gap-2` 并将菜单列表的顶边距清零。纯 CSS 原子化关系查询，彻底摆脱了过去必须通过 React Context 在运行时传递状态控制类名的繁琐模式。

---

### 2.4 CVA + `cn` (clsx + tailwind-merge) 变体管理与冲突消解范式

#### 1. 自定义扩展 `tailwind-merge` 保证绝对消重
在 `reference/appica-ui/packages/react/src/internal/utils.ts` 中：
```ts
/* reference/appica-ui/packages/react/src/internal/utils.ts:1-11 */
import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';
import * as React from 'react';

// Custom theme keys must be registered, or `ease-linear` would sit beside `ease-spring` instead of replacing it.
const twMerge = extendTailwindMerge({ extend: { theme: { ease: ['spring'] } } });

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```
**关键洞察**：
标准的 `tailwind-merge` 仅内置 Tailwind 默认键值。如果项目自定义了 `@theme` 属性（如 Appica UI 自定义的 `ease-spring` 弹簧曲线），必须使用 `extendTailwindMerge` 进行注册。否则当外部传入 `className="ease-linear"` 时，由于 `tailwind-merge` 不认识 `ease-spring`，两者会并排渲染到同一个 DOM 上，引发浏览器层叠竞争。注册后，外部传入的 `ease-linear` 能够精准覆盖内部的 `ease-spring`！

#### 2. CVA 变体标准声明
在 `button-variants.ts` (L15-67) 与 `button.tsx` (L10-36) 中：
```ts
/* reference/appica-ui/packages/react/src/components/button/button-variants.ts:15-67 */
const buttonVariants = cva(
  "relative isolate inline-flex shrink-0 transform-gpu cursor-pointer items-center justify-center font-medium whitespace-nowrap outline-offset-1 transition duration-250 ease-spring select-none not-data-popup-open:active:scale-[0.97] not-data-popup-open:active:duration-100 not-data-popup-open:active:ease-in-out not-data-popup-open:active:translate-y-px data-disabled:opacity-disabled data-disabled:pointer-events-none motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='stroke-'])]:stroke-[1.85]",
  {
    variants: {
      variant: {
        primary: cn(
          backgroundLayer,
          'text-primary-foreground bg-primary before:bg-[radial-gradient(138.15%_78.13%_at_52.05%_50%,var(--primary)_0%,var(--primary-muted)_80%)] before:opacity-0 hover:before:opacity-100 outline-ring-primary data-popup-open:before:opacity-100 data-pressed:before:opacity-100',
        ),
        secondary: cn(
          backgroundLayer,
          'text-secondary-foreground bg-secondary outline-ring-secondary before:bg-[radial-gradient(138.15%_78.13%_at_52.05%_50%,var(--secondary)_0%,var(--secondary-muted)_95%)] before:opacity-0 hover:before:opacity-100 data-popup-open:before:opacity-100 data-pressed:before:opacity-100',
        ),
        soft: '...',
        outline: '...',
        ghost: '...',
        destructive: '...',
      },
      size: {
        sm: "h-8 gap-1 rounded-sm px-4 text-xs has-data-[icon=end]:pe-3 has-data-[icon=start]:ps-3 [&_svg:not([class*='size-'])]:size-4",
        md: "h-10 gap-1.5 rounded-md px-5 text-sm has-data-[icon=end]:pe-3.5 has-data-[icon=start]:ps-3.5 [&_svg:not([class*='size-'])]:size-4.5",
        lg: "h-12 gap-2 rounded-lg px-6 text-base has-data-[icon=end]:pe-4.5 has-data-[icon=start]:ps-4.5 [&_svg:not([class*='size-'])]:size-5",
        'icon-sm': "size-8 rounded-sm [&_svg:not([class*='size-'])]:size-4",
        'icon-md': "size-10 rounded-md [&_svg:not([class*='size-'])]:size-4.5",
        'icon-lg': "size-12 rounded-lg [&_svg:not([class*='size-'])]:size-5",
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);
```
在组件中使用（`button.tsx:28-35`）：
```tsx
<BaseButton
  data-slot="button"
  disabled={resolvedDisabled}
  className={cn(buttonVariants({ variant: resolvedVariant, size: resolvedSize }), className)}
  {...props}
/>
```
**技术优势**：
1. **天然类型推导**：`VariantProps<typeof buttonVariants>` 自动提取 `variant` 与 `size` 的联合类型（`'primary' | 'secondary' | ...`），无需手动声明重复的 TypeScript 接口。
2. **外部类名完全确定性覆盖**：当外部调用 `<Button className="px-2 h-7 bg-error">` 时，`twMerge` 会在运行时自动判定：
   - `px-2` 替代默认的 `px-5`；
   - `h-7` 替代默认的 `h-10`；
   - `bg-error` 替代 `bg-primary`。
   没有任何特异度竞争（无需使用 `!important`），最终输出干净且无冲突的类名列表。

---

## 3. 标杆深度解构二：Prose UI 的类型驱动 Design Tokens 体系

如果说 Appica UI 展示了基于 Tailwind v4 编译时工具类的最佳形态，那么 `reference/prose-ui` 则为**纯 CSS 变量体系提供了最严谨的 TypeScript 强类型驱动模型**。

### 3.1 TypeScript 强类型 DesignSpec 与自动化 CSS 生成管道

在 `reference/prose-ui/packages/style/src/ds/types.ts` 与 `ds.ts` 中，整个设计系统的变量集不是靠散落的 `.css` 文件手写维护，而是由严格的 TypeScript 类型结构声明：

```ts
/* reference/prose-ui/packages/style/src/ds/types.ts:45-137 */
export type Core = {
  spacing: {
    'none': CssValue
    'px': CssValue
    'space0-5': CssValue
    'space1': CssValue
    'space2': CssValue
    'space4': CssValue
    ...
  }
  font: {
    family: { base: CssValue; heading: CssValue; mono: CssValue }
    size: { base: CssValue; sm: CssValue }
    weight: { normal: CssValue; medium: CssValue; semiBold: CssValue; bold: CssValue }
    height: { base: CssValue; sm: CssValue }
  }
  letterSpacing: { base: CssValue; sm: CssValue }
  border: { radius: CssValue }
}

export type Colors = {
  color: {
    text: {
      strong: CssValue
      base: CssValue
      muted: CssValue
      xmuted: CssValue
      disabled: CssValue
      accent: CssValue
      note: CssValue
      info: CssValue
      warning: CssValue
      success: CssValue
      danger: CssValue
      syntax1: CssValue
      ...
    }
    bg: {
      base: CssValue
      surface1: CssValue
      surface1Hover: CssValue
      surface2: CssValue
      surface2Hover: CssValue
      accent: CssValue
      ...
    }
    border: {
      base: CssValue
      subtle: CssValue
      outline: CssValue
    }
  }
}
```

在 `reference/prose-ui/packages/style/src/ds/ds.ts` 中，通过纯函数转换引擎自动生成 CSS 变量与使用字典：
```ts
/* reference/prose-ui/packages/style/src/ds/ds.ts:20-71 */
export const cssSystem = <T>(
  input: DesignSpec<T>,
  prefix: string,
  valueWrapper?: (value: CssVar) => ColorValue,
): T => {
  const transform = (obj: any, parentKey: string = ''): any => {
    const result: any = {}
    for (const key in obj) {
      if (MEDIA_QUERIES.includes(key)) return result
      const newKey = `${parentKey}-${key}`
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        result[key] = transform(obj[key], newKey)
      } else {
        let value: CssValue = `var(${cssVarName(newKey)})`
        if (valueWrapper) value = valueWrapper(value)
        result[key] = value
      }
    }
    return result
  }
  return transform(input, prefix)
}
```
**关键价值**：
- **TS 即 CSS 变量**：通过 `camelToDash` 递归将嵌套对象拍平（例如 `color.text.muted` 自动转为 `--color-text-muted`），开发者在 TypeScript 中享受完全的代码补全与静态拼写拦截。
- **响应式媒体查询内联**：在规范定义树中支持直接定义 `[MEDIA_ABOVE_LARGE]: { ... }`，由 `cssVariables` 自动提取为 `@media (min-width: 1024px)` 包装的 CSS 规则，杜绝了多文件间响应式变量错位的隐患。

### 3.2 三层核心分级模型（Core, Colors, Components）
Prose UI 将设计体系划分为三层清晰边界：
1. **Core**：排版尺度（字号、字重、行高）、空间尺度（间距、网格）、边框圆角基数；
2. **Colors**：排除了具象调色板，完全由 `text.*`、`bg.*`、`border.*` 构成角色定义；
3. **Components**：组件级的槽位绑定（如 `body.color.bg` 指向 `color.bg.base`）。
这种三层架构保证了从全局基础度量到具体业务呈现的清晰溯源。

---

## 4. Conex / Crish 当前样式基础设施现状与深层痛点审查

### 4.1 现有 Token 资产与契约防护体系（优势与积淀）

必须公正指出，Conex / Crish 在样式资产治理上有着扎实的工程积淀，绝非毫无规范：
1. **物理拆分的 9 模块 Token 树**：
   在 `apps/crish-desktop/src/styles/tokens.css` 中，系统将原本混乱的单文件拆分为 9 个具有严格级联依赖顺序的子文件：
   - `tokens-base.css`（动效时长、缓动曲线、冷启动门闩）
   - `tokens-palette.css`（色彩底板与身份色）
   - `tokens-surface.css`（六级表面阶梯 e0~e5、三档底色）
   - `tokens-text.css`（四级文字阶梯、墨色角色）
   - `tokens-type.css`（字号排版）
   - `tokens-space.css`（空间与间距）
   - `tokens-radius.css`（同心圆角、描边预算）
   - `tokens-state.css`（交互状态叠加）
   - `tokens-components.css`（组件专用度量）
2. **严密的自动化契约测试防回归**：
   - `semanticColors.contract.test.ts`：以 250 行自动化测试锁定 20 个关键语义色（`--danger-fg`、`--success-fg`、`--status-modified` 等）在亮暗两套主题下必须为固定纯色，严禁混底或透明；
   - `threeTierSurface.contract.test.ts`：强制断言外通底（`--surface-outer`）、主矩形（`--surface-main`）、输入框（`--surface-input`）三档底色必须互不相同，严禁在不同层级复用相同底色；
   - `concentric-radius.contract.test.ts`：强制断言同心圆角公理 $R_{inner} = \max(0, R_{outer} - P)$，锁定顶级容器 `--radius-2xl: 20px` 与浮层外角 `--radius-menu-outer: 18px`，严禁圆角坍塌；
   - `dual-source-values.test.ts`：保证 TypeScript 测量常量（如 `chatScrollGeometry.ts` 中的视口参数）与 CSS 变量无缝同步，杜绝 2px 错位。
3. **CI 门禁守卫硬拦截**：
   `package.json` 中的 `check:color-ssot`（拦截裸 Hex/RGB 与假 fallback）、`check:token-consistency`（拦截未定义引用与死 Token）、`check:layout-tokens` 等保证了已有约束不被劣化。

---

### 4.2 纯 CSS Modules 架构的六大瓶颈与痛点剖析

尽管拥有强大的 Token 契约，但在**组件消费层**，由于完全采用 **CSS Modules + 手写拼接**，暴露出严重制约开发效率与体验的六大瓶颈：

#### 瓶颈一：变体组合爆炸与样板代码泥潭
检查当前原子组件的实现方式：
- **`apps/crish-desktop/src/components/ui/Button/Button.tsx` (L46-60, L103-113)**：
  ```tsx
  const VARIANT_CLASS: Record<ButtonVariant, string | undefined> = {
    primary: styles.buttonPrimary,
    secondary: styles.buttonSecondary,
    plain: styles.buttonPlain,
    ghost: styles.buttonGhost,
    danger: styles.buttonDanger,
  };

  const SIZE_CLASS: Record<ButtonSize, string | undefined> = {
    xs: styles.buttonXs,
    sm: styles.buttonSm,
    md: styles.buttonMd,
    lg: styles.buttonLg,
  };
  ...
  const classNames = [
    styles.button,
    VARIANT_CLASS[variant],
    SIZE_CLASS[size],
    block ? styles.buttonBlock : null,
    active ? styles.buttonActive : null,
    loading ? styles.buttonLoading : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  ```
- **`apps/crish-desktop/src/components/ui/Badge/Badge.tsx` (L47-63, L82-90)**：
  ```tsx
  const TONE_CLASS_MAP: Record<BadgeTone, string | undefined> = { ... };
  const SIZE_CLASS_MAP: Record<BadgeSize, string | undefined> = { ... };
  ...
  const classNames = [
    styles.badge,
    TONE_CLASS_MAP[rawTone],
    SIZE_CLASS_MAP[size],
    className,
  ].filter(Boolean).join(' ');
  ```
- **`apps/crish-desktop/src/components/ui/Card/Card.tsx` (L25-30, L65-74)**：
  ```tsx
  const PADDING_CLASS_MAP: Record<CardPadding, string | undefined> = { ... };
  ...
  const classNames = [
    styles.card,
    PADDING_CLASS_MAP[padding],
    rim && styles.rim,
    isInteractive && styles.interactive,
    className,
  ].filter(Boolean).join(' ');
  ```
**痛点分析**：
1. **样板代码高度重复**：每个组件都在手写一遍 `Record<Variant, string>` 字典映射与 `filter(Boolean).join(' ')`。全仓数十个组件均充斥着此模板，维护繁重；
2. **复合变体（Compound Variants）实现极其丑陋**：如果某种 `variant="danger"` 在 `size="xs"` 下需要特殊的内边距补偿，CSS Modules 必须写组合选择器（如 `.buttonDanger.buttonXs`），如果再叠加 `active` 或 `loading`，组合数急剧膨胀，容易出现漏写或伪类匹配优先级错乱。

#### 瓶颈二：外部 `className` 覆盖冲突与特异度不可控（Specificity Hazard）
在纯 CSS Modules 中，组件内部的类名被编译为 `_button_10q5a_7 _buttonPrimary_10q5a_136`。
当外部调用者传递自定义类名时：
```tsx
<Button className={styles.myCustomButton} variant="secondary">
```
- 外部类名与内部类名本质上都是单类选择器（CSS 特异度均为 `0-1-0`）；
- 最终哪一个样式生效，**不取决于 JSX 中谁写在后面，而是取决于 Vite/Rollup 打包时 CSS 文件的引入顺序（Chunk Cascading Order）**！
- 如果 `myCustomButton` 所在的 CSS 文件被打包在 `Button.module.css` 之前，外部传入的 `padding: 16px` 或 `background-color` 就会**静默失效**！为了解决这种失效，开发者往往被迫写出 `!important`，彻底破坏了样式的可维护性。反观 Appica UI 中的 `twMerge`，是在属性层面进行语义判断并精准剔除冲突属性，天然不存在这种特异度陷阱。

#### 瓶颈三：样式冗余膨胀与体积浪费（Bundle Bloat）
查看 `Button.module.css` (L22-46) 与其他组件的 CSS：
```css
/* apps/crish-desktop/src/components/ui/Button/Button.module.css:22-46 */
.button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  height: var(--btn-h);
  padding: 0 var(--btn-px);
  gap: var(--btn-gap);
  font-size: var(--btn-fs);
  border-radius: var(--btn-radius);
  background-color: var(--btn-bg);
  color: var(--btn-fg);
  border: var(--hairline-width) solid var(--btn-border);
  box-shadow: var(--btn-shadow);
  font-family: var(--font-sans);
  font-weight: var(--font-weight-normal);
  line-height: 1;
  user-select: none;
  white-space: nowrap;
  cursor: pointer;
  outline: none;
  ...
}
```
**痛点分析**：
在 `Button.module.css`、`IconButton.module.css`、`Badge.module.css`、`Card.module.css`、`SegmentedControl.module.css` 中，诸如 `display: inline-flex; align-items: center; justify-content: center; user-select: none; white-space: nowrap; cursor: pointer;` 等基础排版声明被重复书写了数十次！
- 在 CSS Modules 模式下，**组件越多，CSS 体积线性增长**；
- 而在现代原子化（Tailwind）模式下，`inline-flex items-center justify-center select-none` 永远只在全局 CSS 样式表中出现一次，组件越多，新增代码对 CSS 总产物大小的边际贡献几乎为零。

#### 瓶颈四：状态伪类与复杂交互选择器极其脆弱繁琐
比较当前 `Button.module.css` 中的伪类写法：
```css
/* apps/crish-desktop/src/components/ui/Button/Button.module.css:61-80 */
.button:where(:hover:not(:disabled):not([aria-disabled='true']))::before {
  opacity: 1;
}

.button:where(:active:not(:disabled):not([aria-disabled='true']))::before {
  background-color: var(--btn-active-overlay);
  opacity: 1;
}

/* 焦点环：严格遵循 AGENTS.md §13 (3%~10% 克制软灰) */
.button:where(:focus-visible) {
  outline: none;
  box-shadow: 0 0 0 1.5px
    color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
  border-color: color-mix(
    in srgb,
    var(--border-color) 90%,
    var(--text-primary) 10%
  );
}
```
与 `reference/appica-ui/packages/react/src/components/button/button-variants.ts` 的写法对比：
Appica UI 借助 Tailwind v4 变体，将状态直接内联表达为：
```ts
"not-data-popup-open:active:scale-[0.97] data-disabled:opacity-disabled motion-reduce:transition-none hover:before:opacity-100"
```
当前 Crish Desktop 的写法必须大量使用 `:where(...)`、`:not(:disabled)`、`[aria-disabled='true']` 组合，不仅书写极其容易漏掉某个状态条件（例如忘记 `not([aria-disabled='true'])` 导致禁用按钮在 hover 时仍然触发遮罩），而且代码量翻倍，阅读负担沉重。

#### 瓶颈五：Token 命名碎片化与历史别名债务（Alias Proliferation）
仔细审查当前仓库的 `tokens-palette.css` 与 `tokens-text.css`，可以发现严重的别名冗余与格式混乱：
1. **一个危险色，存在 7 种别名！**
   在 `tokens-palette.css` L38–76 中：
   - `--danger-fg: hsl(0 72% 51%);`
   - `--color-error: var(--accent-red);`
   - `--color-danger: var(--accent-red);`
   - `--danger-color: var(--danger-fg);`
   - `--accent-danger: var(--danger-fg);`
   - `--text-danger: var(--danger-fg);`
   - `--ui-text-danger: var(--danger-fg);`
   开发者在编写组件时，有人引用 `--danger-fg`，有人引用 `--color-danger`，还有人引用 `--text-danger`。尽管底层可能最终指向相近色彩，但心理心智模型被彻底割裂。
2. **色彩格式异构共存**：
   - 十六进制：`--brand-primary: #10b981;`、`--diff-add: #1a7f37;`
   - HSL 语法：`--accent: hsl(160 84% 36%);`、`--danger-fg: hsl(0 72% 51%);`
   - OKLCH 语法：`--accent-orange: oklch(0.7 0.16 65);`、`--agent-hue-1: oklch(0.50 0.16 25);`
   三种色彩格式混杂在同一个文件中，缺乏统一的标准。
3. **`[WAVE2-DEPRECATED-ALIAS]` 长期未清理**：
   在 `tokens-text.css` (L46-55) 与 `tokens-radius.css` (L53-73) 中，标有 `[WAVE2-DEPRECATED-ALIAS]` 的废弃别名（如 `--user-text-primary`、`--text-muted`、`--text-quiet`、`--text-faint`、`--radius-xs`、`--radius-sm`）多达数十个，长期未能真正完成收敛退役。

#### 瓶颈六：原子复用缺失与组件边界僵化
在日常业务开发中，开发者经常需要微调一个 4px 的内边距，或者让某个容器以 flex 靠左对齐。由于当前项目没有引入原子工具类系统：
- 方案 A（规范做法）：为当前视图单独新建一个 `xxx.module.css`，声明一个专门的 class。结果导致项目中出现了数百个只有 2 行样式的碎片化 CSS 文件；
- 方案 B（偷懒做法）：直接写内联 `style={{ paddingLeft: 4 }}`，结果触碰了 `check:inline-style-hardcode` 门禁，被 CI 拦截报错。
这种原子能力的缺失，使得组件层与样式层边界僵化，极大地拖慢了高频迭代速度。

---

## 5. 标杆与当前系统全景维度对比矩阵

| 评估维度 | Appica UI (`reference/appica-ui`) | Prose UI (`reference/prose-ui`) | Conex / Crish (`apps/crish-desktop`) |
| :--- | :--- | :--- | :--- |
| **基础样式框架** | **Tailwind CSS v4**（基于原生 CSS AST 解析，无需 JS 配置文件） | **纯 CSS 变量**（基于 TypeScript 脚本自动生成） | **纯 CSS Modules**（Vite 原生编译，传统 CSS 规则） |
| **主题扩展机制** | **`@theme inline`**：将 CSS 变量双向映射为原子工具类，动态与构建解耦 | **`DesignSpec<T>`**：TS 类型树驱动，自动编译为变量声明与使用表 | **手动 `@import` 9 模块**：静态 `:root` / `html[data-theme='*']` 声明 |
| **Token 色彩模型** | **100% Role-based 语义化**（Foreground / Background / Border 深度阶梯），绝无色相名 | **Role-based 三层模型**（Core, Colors, Components），语义角色化 | **混合模型**：存在语义色，但混入调色盘名与 7 种功能别名并存 |
| **色彩空间支持** | **全量 OKLCH**（感知亮度绝对线性均匀），统一斜杠透明度 | **HSL 封装**（`hsl(var(--...))`） | **Hex + HSL + OKLCH 混杂**，未完全实现空间标准化 |
| **变体管理方案** | **CVA (class-variance-authority)** 强类型变体声明，自动派生 Props | 不涉及（专注排版与内容样式） | **手写 `VARIANT_CLASS` 字典** + 数组 filter(Boolean).join 手动拼接 |
| **外部类名冲突消解** | **`twMerge` (extendTailwindMerge)**：属性级识别，后入必胜，0 特异度冲突 | 外部通过级联覆盖（依赖 CSS 顺序） | **纯字符串拼接**：特异度均为 `0-1-0`，完全受制于打包引入顺序（容易覆盖失效） |
| **原生变体语法** | **`*:` (子代), `**:` (后代), `data-*:` (属性), `not-*:` (否定)**，彻底消灭 `[&_...]` | 无（使用常规嵌套选择器） | **手写复杂伪类**：`:where(:hover:not(:disabled):not([aria-disabled='true']))`，代码冗长 |
| **样式体积曲线** | **平滑对数曲线**：原子类全局复用，组件越多增量体积越趋近于零 | **线性适中**：由 TS 生成，无多余冗余 | **线性陡峭增长**：每个组件独立编写布局与基础样式，样板代码数十次重复 |
| **无障碍防抖动机制** | `@custom-variant motion-safe / motion-reduce` 与系统级/应用级双绑定 | 依赖外部媒体查询 | `tokens-base.css` 定义 `--transition-*`，有零 FOUC 门闩 |
| **自动化契约与守卫** | `vitest-axe` 无障碍测试，`AGENTS.md` 规范约束 | TS 编译器类型守护 | **极强契约测试套件**（`semanticColors`, `concentric-radius`, `threeTierSurface` 等），CI 硬拦截 |

---

## 6. Conex / Crish 样式系统现代化演进路线与实施方案

针对当前 Conex / Crish 的架构现状与沉重历史包袱，样式的演进必须遵循《AGENTS.md》中的反退避准则与防回归铁律：**禁止大拆大建破坏现存 73 套测试与严格 CI 门禁，必须采取分阶段、渐进式的精准落地策略**。

```
┌────────────────────────────────────────────────────────────────────────┐
│                   Conex / Crish 样式系统演进四阶段                      │
└────────────────────────────────────────────────────────────────────────┘
       │
       ▼
【阶段一：Token 体系重塑与去色相化收敛】
  ├─ 统一采用 OKLCH 色彩空间（感知线性，亮暗平滑）
  ├─ 建立标准的 Role-based 深度阶梯（Foreground / Surface / Border / Semantic）
  └─ 一键收口并清除 [WAVE2-DEPRECATED-ALIAS] 与 7 种重复别名
       │
       ▼
【阶段二：引入 CVA + clsx + tailwind-merge，标准化组件变体引擎】
  ├─ 封装项目统一的 `cn` 引擎（extendTailwindMerge 注册弹簧缓动等私有 token）
  ├─ 改造核心原子组件（Button, Badge, Card, Input），消灭手写字典与 join(' ')
  └─ 彻底根除外部 className 覆盖失效与特异度竞争顽疾
       │
       ▼
【阶段三：引入 Tailwind CSS v4 与 `@theme inline`（平滑渐进共存）】
  ├─ 配置 `@tailwindcss/vite`，接入原生 CSS AST 编译管道
  ├─ 使用 `@theme inline` 将现有 `tokens-*.css` 映射为标准原子工具类
  ├─ 全面启用 `*:`, `**:`, `data-*:`, `not-*:` 前沿变体，废弃手写嵌套伪类
  └─ 现存 CSS Modules 与新原子系统双轨运行，增量业务采用新语法
       │
       ▼
【阶段四：自动化门禁改造与《样式系统编码宪章》】
  ├─ 升级 `check:color-ssot` 与 `check:token-consistency` 支持 CVA 与新 Token
  └─ 确立严禁裸 Hex、严禁手写拼接、严禁 `[&_...]` 的代码审查红线
```

---

### 6.1 阶段一：Token 体系重塑与去色相化收敛（Role-based & OKLCH 规范）

#### 1. 全量统一为 OKLCH 感知均匀色彩
废除当前散落的裸 Hex（`#10b981`、`#1a7f37` 等）和 HSL（`hsl(160 84% 36%)`），将全局色彩基底统一在 OKLCH 空间下。
在 `tokens-palette.css` 与 `tokens-surface.css` 中建立标准化映射：
```css
/* 建议重构后的 tokens-palette.css 架构示范 */
:root,
html[data-theme='light'] {
  /* 品牌核心 Accent */
  --accent-base: oklch(0.60 0.16 150);
  --accent-subtle: oklch(0.60 0.16 150 / 10%);
  --accent-soft: oklch(0.60 0.16 150 / 20%);
  --accent-muted: oklch(0.75 0.10 150);
  --accent-strong: oklch(0.48 0.15 150);
  --accent-foreground: oklch(1 0 0);

  /* 危险状态 Error / Danger（单一真源） */
  --error-base: oklch(0.61 0.19 31.8);
  --error-subtle: oklch(0.61 0.19 31.8 / 10%);
  --error-soft: oklch(0.61 0.19 31.8 / 20%);
  --error-muted: oklch(0.75 0.12 31.8);
  --error-strong: oklch(0.50 0.18 31.8);
  --error-foreground: oklch(1 0 0);

  /* 成功状态 Success */
  --success-base: oklch(0.62 0.17 145);
  --success-subtle: oklch(0.62 0.17 145 / 10%);
  --success-soft: oklch(0.62 0.17 145 / 20%);
  --success-foreground: oklch(1 0 0);

  /* 警告状态 Warning */
  --warning-base: oklch(0.70 0.18 65);
  --warning-subtle: oklch(0.70 0.18 65 / 10%);
  --warning-soft: oklch(0.70 0.18 65 / 20%);
  --warning-foreground: oklch(0.20 0.03 65);
}
```

#### 2. 清退别名债务，建立统一命名契约
执行一次全面的 Codemod 迁移计划，彻底清退 `[WAVE2-DEPRECATED-ALIAS]`：
- 将 `--danger-fg`、`--color-danger`、`--accent-danger`、`--text-danger`、`--ui-text-danger` 全部统一收敛为标准语义 Token：
  - 文本/前景用途 → `--text-error`（或 `--color-error-foreground`）
  - 容器/背景用途 → `--bg-error`（或 `--color-error`）
  - 边框用途 → `--border-error`
- 同步更新 `semanticColors.contract.test.ts`，确保所有契约测试直接断言新规范 Token。

---

### 6.2 阶段二：引入 CVA + clsx + tailwind-merge，标准化组件变体引擎

在引入完整的构建时工具类之前，首先在**运行时组件层**引入现代变体管理三件套：
- `clsx`
- `tailwind-merge`
- `class-variance-authority` (CVA)

#### 1. 建立共享工具模块 `src/components/ui/internal/utils.ts`
参考 Appica UI 的成熟设计，在 Crish Desktop 中建立标准类名合并器：
```ts
// apps/crish-desktop/src/components/ui/internal/utils.ts
import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// 注册 Conex / Crish 独有的缓动曲线与自定义尺度
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      ease: ['spring', 'standard', 'emphasized'],
      spacing: ['row-h-control', 'row-h-list', 'row-h-dense'],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

#### 2. 改造 `Button` 组件变体引擎
将 `apps/crish-desktop/src/components/ui/Button/` 彻底重构为现代 CVA 模式：
新建 `Button.variants.ts`：
```ts
// apps/crish-desktop/src/components/ui/Button/Button.variants.ts
import { cva, type VariantProps } from 'class-variance-authority';
import styles from './Button.module.css';

export const buttonVariants = cva(styles.button, {
  variants: {
    variant: {
      primary: styles.buttonPrimary,
      secondary: styles.buttonSecondary,
      plain: styles.buttonPlain,
      ghost: styles.buttonGhost,
      danger: styles.buttonDanger,
    },
    size: {
      xs: styles.buttonXs,
      sm: styles.buttonSm,
      md: styles.buttonMd,
      lg: styles.buttonLg,
    },
    block: {
      true: styles.buttonBlock,
    },
    active: {
      true: styles.buttonActive,
    },
    loading: {
      true: styles.buttonLoading,
    },
  },
  defaultVariants: {
    variant: 'secondary',
    size: 'md',
  },
});

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;
```
在 `Button.tsx` 中直接消费：
```tsx
// apps/crish-desktop/src/components/ui/Button/Button.tsx
import React from 'react';
import { cn } from '../internal/utils';
import { buttonVariants, type ButtonVariantProps } from './Button.variants';

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    Omit<ButtonVariantProps, 'active' | 'loading' | 'block'> {
  icon?: React.ReactNode;
  iconPosition?: 'left' | 'right';
  loading?: boolean;
  block?: boolean;
  active?: boolean;
  bare?: boolean;
  align?: 'center' | 'start';
  static?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant,
      size,
      block,
      active,
      loading,
      className,
      children,
      disabled,
      ...restProps
    },
    ref
  ) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(buttonVariants({ variant, size, block, active, loading }), className)}
        {...restProps}
      >
        {children}
      </button>
    );
  }
);
```
**改造收益**：
1. 消除了每个组件中手写字典与手动 `filter(Boolean).join(' ')` 的模板代码；
2. 即使目前仍引用 CSS Modules 类名，`cn(...)` 也能提供统一的参数合并能力，为后续向纯原子类平滑过渡奠定了接口基础。

---

### 6.3 阶段三：引入 Tailwind CSS v4 与 `@theme inline`（平滑渐进迁移策略）

在工程构建层面，逐步引入 Tailwind CSS v4：

#### 1. 构建接入与 `@theme inline` 桥接
在 `apps/crish-desktop/vite.config.ts` 中引入 `@tailwindcss/vite` 插件。
在 `apps/crish-desktop/src/styles/design-system.css` 头部配置：
```css
@import 'tailwindcss';

@theme inline {
  /* 桥接 Conex / Crish 原有 9 模块 Token */
  --color-brand: var(--brand);
  --color-accent: var(--accent);
  
  --color-foreground: var(--text-primary);
  --color-foreground-secondary: var(--text-secondary);
  --color-foreground-tertiary: var(--text-tertiary);
  
  --color-surface-sunken: var(--surface-sunken-e0);
  --color-surface-canvas: var(--surface-canvas);
  --color-surface-card: var(--surface-card);
  --color-surface-raised: var(--surface-raised);
  --color-surface-overlay: var(--surface-overlay);
  
  --color-border: var(--border-color);
  --color-border-subtle: var(--border-subtle);
  
  --radius-row: var(--radius-row);
  --radius-control: var(--radius-control);
  --radius-card: var(--radius-card);
  --radius-menu-outer: var(--radius-menu-outer);
  --radius-2xl: var(--radius-2xl);
  
  --ease-spring: var(--ease-spring);
  --duration-snappy: var(--duration-snappy);
}
```

#### 2. 全面应用原生变体语法
在新建组件与重构组件中，全面拥抱 `*:`, `**:`, `data-*:`, `not-*:`：
- **消灭深层选择器**：禁止在样式表中书写 `[&_[data-slot=...]]`，改用 `**:data-[slot=...]:...`；
- **规范无障碍与交互状态**：凡依赖状态属性的组件（如 `data-active`、`data-disabled`、`data-state`），一律使用 `data-active:...` 或 `not-data-disabled:...` 变体表达。

#### 3. 双轨共存演进策略
- **存量稳定组件**（如复杂编辑器、Xterm 终端宿主）：继续保留其专属的 `.module.css`，不受任何强制改动干扰；
- **核心原子组件与新业务页面**：优先使用 `CVA + Tailwind v4 原子类` 编写，享受极致开发效率与自动样式去重。

---

### 6.4 阶段四：自动化门禁改造与《样式系统编码宪章》

#### 1. 门禁检查脚本升级
在 `scripts/` 下同步升级现存守卫：
- **`check-color-ssot.mjs`**：除了拦截裸 Hex/RGB 之外，增加对 Tailwind v4 工具类的色彩合规扫描，确保工具类仅使用语义化命名（如放行 `text-foreground`, `bg-surface-card`，拦截 `text-gray-500`, `bg-[#fff]`）；
- **`check-token-consistency.mjs`**：将 `@theme inline` 中声明的变量自动计入定义集与消费集，杜绝误报。

#### 2. 前端《UI 样式与 Token 编码宪章》（Style & Token Constitution）
在 `AGENTS.md` 附录及前端团队规范中确立四条硬性纪律：
1. **【语义单一真源铁律】**：严禁在组件中使用色相（如 `gray-100`、`red-500`）或裸 Hex，一律使用 Role-based 语义 Token（Foreground, Surface, Border, Accent/Status）；
2. **【变体管理统一铁律】**：禁止手写 `Record<Variant, string>` 字典与手动 `join(' ')`，所有组件变体必须通过 `cva` 声明，并通过 `cn(...)` 合并；
3. **【原生变体优先铁律】**：禁止书写任意嵌套选择器 `[&_...]` 或 `[&>*]`，必须使用 Tailwind v4 规范的 `*:`、`**:`、`data-*:`、`not-*:` 变体语法；
4. **【外部类名冲突防护铁律】**：向子组件传递样式覆盖时，必须依靠 `cn` 内部的 `twMerge` 机制实现确定性覆盖，严禁使用 `!important` 暴力提权。

---

## 7. 总结与后续实施建议

通过对 `reference/appica-ui` 与 `reference/prose-ui` 的全景拆解，我们可以清晰地看到现代化 UI 基础设施的演进趋势：**从散乱的 CSS Modules 孤岛走向基于 Role-based Tokens、OKLCH 感知均匀色彩空间、原生变体语法与 CVA 类型化调度的现代化样式架构**。

Conex / Crish 当前并不缺少对设计品质的追求，其丰富的契约测试和 Token 规范已在业界处于严谨前列。当前的真正瓶颈在于**工具链层面的代际差距**——纯 CSS Modules 带来的样板膨胀、特异度冲突与原子复用缺失正在成为阻碍系统进一步扩展的绊脚石。

实施本报告提出的四个演进阶段，不仅能彻底清退历史遗留的别名债务，根除外部类名覆盖失效的隐患，还能在保持现存 73 套测试全绿的前提下，使 Conex / Crish 的前端开发体验、样式运行性能与界面视觉精致度迈向全新高度。
