# 05 · 组件 API 契约与 React 19 纯函数方案

> **方案代号**：`05-api-contract-and-react19-pure-functions`  
> **方案定性**：原子组件契约重构、React 19 纯函数范式升级与多程渲染彻底根治方案  
> **上游依据**：`docs/ui-infra-evolution/00-调度与导航.md`（战役总纲）、`AGENTS.md`（协作铁律与反退避）  
> **核心使命**：彻底清除 Conex / Crish 组件 API 中的历史反模式与妥协补丁；拔除 `Button` 的 `bare` 参数欺诈代码异味并解耦纯样式 `buttonVariants`；剔除 `Dialog` 运行期 AST 探测与 `registerTitle` 状态倒灌引发的多程二次渲染；全量清退全仓 15+ 核心组件冗余的 `forwardRef`、`displayName` 与防御性 ref 合并样板代码，全面对齐 React 19 纯函数标准；确立复合组件 Group 架构二分法则与极小公共导出表面。  
> **五大铁律红线**：纯底层改动，视觉零变化；坚决避免双轨（No Dual-Track）；坚决避免硬编码（Zero Hardcoding）；无障碍（a11y）暂时不管；唯一单产出文档。

---

## 一、现状复盘与核心根因深度剖析

### 1.1 历史妥协模式的累积与反模式现状

在 Conex / Crish 项目的快速演进过程中，原子组件库（`apps/crish-desktop/src/components/ui/`）承担了高密度的交互诉求。然而，由于历史架构包袱、渐进式功能打补丁以及早期 React 18 的 API 限制，组件层累积了大量严重的代码异味与脆弱的设计妥协：

```
┌────────────────────────────────────────────────────────────────────────┐
│                      组件层三大核心反模式拓扑                            │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  [异味一：Button bare 妥协]          [异味二：Dialog 运行时 AST 探测]     │
│   ┌──────────────────────────┐        ┌───────────────────────────┐    │
│   │ ButtonProps:             │        │ Dialog Controller:        │    │
│   │ • variant/size/icon/load │        │ • Children.toArray(child) │    │
│   │ • bare: boolean          │        │ • c.type === DialogHeader │    │
│   └────────────┬─────────────┘        └─────────────┬─────────────┘    │
│                │ 传入 bare=true                     │ 探测失效/状态倒灌   │
│                ▼                                    ▼                  │
│   ┌──────────────────────────┐        ┌───────────────────────────┐    │
│   │ 参数欺诈 (Prop Fraud)：   │        │ • Fragment 击穿探测       │    │
│   │ 内部 early return 原生    │        │ • registerTitle 状态倒灌  │    │
│   │ button，全部样式/参数静默 │        │ • 挂载期强制触发二次重绘  │    │
│   │ 丢弃！                    │        │ • aria 关联跳跃抖动       │    │
│   └──────────────────────────┘        └───────────────────────────┘    │
│                                                                        │
│  [异味三：React 18 样板滞留 (全仓 15+ 核心组件)]                         │
│   ┌──────────────────────────────────────────────────────────────┐     │
│   │ • React.forwardRef<HTMLElement, Props> 冗长包裹               │     │
│   │ • Component.displayName = 'Component' 冗余声明                │     │
│   │ • 各组件手写 8~15 行脆弱防御性 setCombinedRef 合并样板       │     │
│   │ • 未利用 React 19 Ref Cleanup 标准与原生 ref prop 特性       │     │
│   └──────────────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────────────┘
```

这些问题在日常开发与多 Agent 协同中引发了严重的质量隐患：类型系统无法真实反映运行时行为，DOM 树出现意外的多层嵌套或样式丢失，挂载期无谓的重绘降低了界面响应速度。

---

### 1.2 三大核心反模式深度解构与现场证据

#### 1.2.1 反模式一：Button 的 `bare` 妥协模式与“参数欺诈”

- **现场证据**：`apps/crish-desktop/src/components/ui/Button/Button.tsx:32-39, 86-101`
```tsx
// Button.tsx:86-101 现场真实代码
if (bare) {
  return (
    <button
      ref={ref}
      type={type}
      className={className}
      data-align={align}
      data-static={staticProp ? 'true' : undefined}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...restProps}
    >
      {children}
    </button>
  );
}
```
- **深层机理与“参数欺诈（Prop Fraud）”代码异味**：
  1. **将组件硬劈为两套逻辑**：`bare: boolean` 将一个原本精简的原子按钮强行分裂为两个截然不同的组件。`bare=false` 渲染具备同心几何、伪元素 hover 遮罩、标准间距与文字排版的原子按钮；`bare=true` 则直接短路为一个无样式的裸原生 `<button>`。
  2. **静默丢弃参数的严重不诚实性**：当调用方传入 `<Button bare variant="primary" size="lg" icon={<SearchIcon />} loading={true}>搜索</Button>` 时，组件内部的 early return 会**静默丢弃** `variant`（主色丢失）、`size`（尺寸丢失）、`icon`（图标完全不渲染）、`iconPosition`、`block`、`active`、以及 `loading` 对应的 `styles.spinner` 旋转动画！只有 `disabled` 和 `aria-busy` 得到保留。调用方在类型系统上通过了校验，运行时却发现绝大多数 Props 凭空蒸发。
  3. **全仓污染现状**：在 `apps/crish-desktop/src/` 中，存在 30 余处 `<Button bare>` 的调用（例如 `ComposerEmbeddedNotice.tsx:106, 120, 132`, `ExtensionsSidebar.tsx:32, 44, 56, 68`, `DiffCardGitActions.tsx:125`, `ComposerField.tsx:119`, `WizardKeyStep.tsx:137, 155, 191` 等）。审查发现，绝大多数调用点仅仅是为了借用 `<button type="button">` 的原生语义，并挂载外层自建的业务 class（如 `className={styles.ghostBtn}` 或 `styles.actionBtn`），与 `Button` 组件的设计初衷背道而驰。

#### 1.2.2 反模式二：Dialog 运行时 AST 探测与挂载期多程渲染

- **现场证据**：`apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx:148-157, 299-301, 461-474, 529-580`
```tsx
// Dialog.tsx:529-545 现场真实代码
const childrenArray = React.Children.toArray(children);
const hasOverlay = childrenArray.some(
  (c) => React.isValidElement(c) && c.type === DialogOverlay
);
const hasContent = childrenArray.some(
  (c) => React.isValidElement(c) && c.type === DialogContent
);
const hasSections = childrenArray.some(
  (c) =>
    React.isValidElement(c) &&
    (c.type === DialogHeader ||
      c.type === DialogTitle ||
      c.type === DialogDescription ||
      c.type === DialogBody ||
      c.type === DialogFooter ||
      c.type === DialogClose)
);
```
- **三大致命架构缺陷剖析**：
  1. **缺陷 A：极其脆弱的 AST 探测失效（Fragile AST Inspection）**：
     `c.type === DialogHeader` 依赖直接子节点的引用绝对相等。一旦业务开发者或外部组件为了布局需要，使用了 `React.Fragment`（`<> <Dialog.Header /> <Dialog.Body /> </>`）、内联条件渲染（`{hasNotice && <Dialog.Header />}`）、自定义包装组件（`<CustomHeader />`）或高阶组件，`Children.toArray` 只能获取顶层单一节点，深层探测全部失效！`hasSections` 被误判为 `false`，导致逻辑走入渐进语法糖分支（`Dialog.tsx:560-580`），错误地将整个结构再次包裹在第二层 `<DialogOverlay><DialogContent><DialogBody>` 中，瞬间破坏布局与 DOM 结构。
  2. **缺陷 B：状态倒灌（State Inversion / Backflow）强发二次渲染**：
     ```tsx
     // DialogTitle 挂载时通过 useEffect 向 Dialog 倒灌状态
     useEffect(() => {
       return ctx.registerTitle();
     }, [ctx]);
     ```
     在 `DialogTitle` 挂载执行 `useEffect` 时，调用 `ctx.registerTitle()`，更新父级 `Dialog` 的 `titleCount` 状态（`setTitleCount(c => c + 1)`）。这一操作在组件挂载完成后**强制触发了父级 Dialog 的第二次完整渲染**！
     更为严重的是：在初次挂载渲染时，`titleCount` 为 0，`DialogContent` 的 `isLabelled = ctx.hasTitle` 为 `false`，此时 `aria-labelledby` 为 `undefined`；待 `useEffect` 执行并触发二次重绘后，`aria-labelledby` 才突变为 `titleId`。这种无谓的二次重绘与无障碍属性跳跃，既损耗性能，又违反了 React 纯函数单程渲染铁律。
  3. **缺陷 C：运行时 AST 遍历的性能损耗与 React 19 编译器违背**：
     在每次组件 render 时均调用 `React.Children.toArray(children)` 并多次线性遍历，制造了不必要的虚拟 DOM 数组与迭代开销，与 React 19 编译优化（React Compiler）全面拥抱纯函数静态拓扑的方向完全背离。

#### 1.2.3 反模式三：全仓 15+ 核心组件滞留 React 18 样板与防御性 Ref 冗余

- **现场证据**：全仓 15+ 个 UI 核心组件均充斥着如下机械样板：
```tsx
// 存量通用样板代码（Button, Card, Input, Row, Badge, Switch, Tabs 等）
export const Component = React.forwardRef<HTMLElement, ComponentProps>(
  function Component(props, ref) {
    // 组件实现...
  }
);
Component.displayName = 'Component';
```
- **手写防御性 ref 合并的脆弱性**：
  在 `Input.tsx:82-89`、`Dialog.tsx:148-157, 220-230`、`ScrollArea.tsx:39-48` 等组件中，由于需要同时持有内部 DOM 节点引用并对外暴露 `ref`，每个组件各自独立手写了一套 `setCombinedRef`：
  ```tsx
  // 各自手写的合并样板，重复且脆弱
  const setCombinedRef = (node: HTMLInputElement | null) => {
    internalInputRef.current = node;
    if (typeof ref === 'function') {
      ref(node);
    } else if (ref && 'current' in ref) {
      (ref as React.MutableRefObject<HTMLInputElement | null>).current = node;
    }
  };
  ```
  该写法存在三大问题：
  1. **无法支持 React 19 Ref Callback Cleanup 规范**：React 19 规范允许 ref 回调返回清理函数（`return () => cleanup()`），当节点卸载时自动调用。上述旧式写法未捕获并执行 cleanup 函数，存在潜在的监听与引用泄漏风险。
  2. **样板代码膨胀**：每个支持 ref 的组件多出 10~15 行防御性胶水代码。
  3. **类型认知落后**：React 19 正式将 `ref` 作为标准 prop 传递，`React.forwardRef` 已经进入 Deprecated 轨道，`Component.displayName` 也被现代编译工具自动推导替代。

---

## 二、架构设计原则与单一真理源契约

为彻底清除上述历史包袱，本方案确立五项核心底层架构原则：

```
┌────────────────────────────────────────────────────────────────────────┐
│                      P05 五大核心架构设计原则                            │
├────────────────────────────────────────────────────────────────────────┤
│  1. 语义绝对真实 (Semantic Honesty)                                     │
│     • Props 必须与实际渲染 100% 对应；                                 │
│     • 严禁任何传了参数却在底层静默丢弃的“参数欺诈”代码异味。             │
│                                                                        │
│  2. 纯函数单程渲染 (Pure Function & Single-Pass Render)                 │
│     • 组件渲染必须是自顶向下的纯计算；                                 │
│     • 严禁子组件通过 useEffect 挂载钩子向父级逆向倒灌状态造成二次重绘。  │
│                                                                        │
│  3. 单一真理源 API (Single Source of Truth)                            │
│     • 坚决杜绝“新旧双轨并行”，一步到位收敛至标准 API；                   │
│     • 复合组件通过正交的原语组合，不再进行黑盒 AST 猜测。               │
│                                                                        │
│  4. React 19 原生标准 (React 19 Native Conformance)                    │
│     • 全仓清退 forwardRef 与 displayName；                             │
│     • ref 作为普通 prop；统一引入兼容 Ref Cleanup 的 useMergedRefs。    │
│                                                                        │
│  5. 视觉排版 100% 零漂移 (Pixel-Perfect Zero Drift)                     │
│     • 重构仅限于组件内部调用契约与实现机制；                           │
│     • 最终渲染出的 HTML 标签、CSS 规则、尺寸矩阵与行为绝对零差异。     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 三、课题一：彻底干掉 Button 的 `bare` 妥协模式

### 3.1 纯样式解耦：`buttonVariants(...)` 纯函数设计

为解决“既要复用 Button 的标准化样式，又想在非 `<Button>` 标签上挂载外观”的根本诉求，本方案严格遵循 P02 确立的 `class-variance-authority` (CVA) + `cn` 架构，将样式计算从 React 组件渲染中彻底剥离，对外导出标准 `buttonVariants` 纯函数。

#### 3.1.1 `buttonVariants` 契约与 CVA 矩阵定义

对齐 P02 样式系统，废除手写字典与脆弱字符串拼接，采用类型安全的 CVA 矩阵：

文件位置：`apps/crish-desktop/src/components/ui/Button/buttonVariants.ts`
```ts
import { cva, type VariantProps } from 'class-variance-authority';
import styles from './Button.module.css';

/**
 * CVA 按钮样式矩阵定义（单一真理源 SSOT）
 * 完全复用原生 CSS Modules 导出类名，通过 class-variance-authority 驱动矩阵计算
 */
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

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>;
export type ButtonVariantProps = VariantProps<typeof buttonVariants>;
```

#### 3.1.2 改造后的纯洁 `Button` 组件实现

清除了 `bare` 分支后，`Button` 组件回归纯粹的语义与行为：每一个 Prop 都得到忠实渲染，类型契约绝对真实，且采用 React 19 纯函数范式（Ref-as-prop）。

文件位置：`apps/crish-desktop/src/components/ui/Button/Button.tsx`
```tsx
import React from 'react';
import { cn } from '../utils/cn';
import styles from './Button.module.css';
import {
  buttonVariants,
  type ButtonVariant,
  type ButtonSize,
} from './buttonVariants';

export type { ButtonVariant, ButtonSize };

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  ref?: React.Ref<HTMLButtonElement>;
  /** 视觉变体：primary 主操作 / secondary 次操作 / plain 极简文字 / ghost 轻量 / danger 危险操作 */
  variant?: ButtonVariant;
  /** 尺寸：xs(24px) / sm(28px) / md(32px) / lg(40px) */
  size?: ButtonSize;
  /** 图标位（置于文字前/后） */
  icon?: React.ReactNode;
  /** 图标位置：left（默认）或 right */
  iconPosition?: 'left' | 'right';
  /** 加载态：自动 disabled + aria-busy，内容前置旋转指示 */
  loading?: boolean;
  /** 通栏按钮（宽度 100%） */
  block?: boolean;
  /** 激活态 */
  active?: boolean;
  /** 对齐方式：center（默认居中）| start（靠左对齐，专供通栏导航条目等） */
  align?: 'center' | 'start';
  /** 静态模式：禁用 :active 按压缩放微触感 */
  static?: boolean;
}

/**
 * 原子按钮（React 19 纯函数实现）
 * 彻底拔除 bare 补丁分支，全量 Props 语义诚实渲染。
 * 接入 CVA + cn 工具函数，确保外部 className 具备确定性覆盖优先级。
 */
export function Button({
  ref,
  variant = 'secondary',
  size = 'md',
  icon,
  iconPosition = 'left',
  loading = false,
  block = false,
  active = false,
  align,
  static: staticProp,
  disabled,
  className,
  children,
  type = 'button',
  ...restProps
}: ButtonProps) {
  const computedClassName = cn(
    buttonVariants({ variant, size, block, active, loading }),
    className
  );

  const iconNode =
    icon != null ? (
      <span className={styles.buttonIcon} aria-hidden="true">
        {icon}
      </span>
    ) : null;

  return (
    <button
      ref={ref}
      type={type}
      className={computedClassName}
      data-size={size}
      data-variant={variant}
      data-active={active || undefined}
      data-align={align}
      data-static={staticProp ? 'true' : undefined}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...restProps}
    >
      {loading ? (
        <span className={styles.spinner} aria-hidden="true" />
      ) : iconPosition === 'left' ? (
        iconNode
      ) : null}
      {children != null ? (
        typeof children === 'string' || typeof children === 'number' ? (
          <span className={styles.buttonLabel}>{children}</span>
        ) : (
          children
        )
      ) : null}
      {!loading && iconPosition === 'right' ? iconNode : null}
    </button>
  );
}
```

---

### 3.2 纯语义触点标准：原生 `<button>` 与极简 `BaseButton`

对于过去误用 `<Button bare>` 的场景，确立三级触点选型决策树：

```
┌────────────────────────────────────────────────────────────────────────┐
│                        触点选型决策树 (Decision Tree)                    │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  场景 1：标准操作触点（带背景、标准边框、四档同心规格）                    │
│  ───────────> 使用标准 <Button variant="..." size="...">               │
│                                                                        │
│  场景 2：正方形纯图标操作触点                                           │
│  ───────────> 使用 <IconButton icon={...} aria-label="..." />          │
│                                                                        │
│  场景 3：完全由外层 CSS 掌控的列表项、菜单项、树行折叠触点、内嵌提示条按钮 │
│  ───────────> 使用原生 <button type="button" className={...}>           │
│               或极简语义触点 <BaseButton className={...}>              │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

#### 极简 `BaseButton` 语义触点定义

文件位置：`apps/crish-desktop/src/components/ui/Button/BaseButton.tsx`
```tsx
import React from 'react';
import styles from './BaseButton.module.css';

export interface BaseButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  ref?: React.Ref<HTMLButtonElement>;
  /** 靠左对齐或居中对齐 */
  align?: 'center' | 'start';
  /** 静态模式：禁用任何按压动效 */
  static?: boolean;
}

/**
 * 极简语义按钮基元（BaseButton）
 * 彻底清除浏览器原生 button 默认边框、背景与内边距，提供 100% 诚实的裸按键能力。
 * 默认 type="button"，杜绝表单误提交风险。
 */
export function BaseButton({
  ref,
  type = 'button',
  align,
  static: staticProp,
  className,
  children,
  ...restProps
}: BaseButtonProps) {
  const classNames = [styles.baseButton, className].filter(Boolean).join(' ');

  return (
    <button
      ref={ref}
      type={type}
      className={classNames}
      data-align={align}
      data-static={staticProp ? 'true' : undefined}
      {...restProps}
    >
      {children}
    </button>
  );
}
```

配套样式 `BaseButton.module.css`：
```css
.baseButton {
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: inherit;
  cursor: pointer;
  outline: none;
  display: inline-flex;
  align-items: center;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.baseButton:disabled {
  cursor: not-allowed;
}
```

---

### 3.3 全仓存量 `<Button bare>` 迁移对照与替换矩阵

全仓存量使用 `<Button bare>` 的 30+ 处调用点，按场景划分为两类，通过 Codemod 实施无损迁移，视觉排版 100% 保持零漂移：

| 业务文件路径 | 现有调用代码 | 迁移后目标代码 | 视觉与行为断言 |
| :--- | :--- | :--- | :--- |
| `components/chat-composer/ComposerEmbeddedNotice.tsx:105-140` | `<Button bare type="button" className={styles.ghostBtn} onClick={handleCopy}>` | `<button type="button" className={styles.ghostBtn} onClick={handleCopy}>` | 100% DOM 与 CSS 属性对等，零多余外层包装 |
| `components/extensions-surface/ExtensionsSidebar.tsx:32, 44, 56, 68` | `<Button bare type="button" className={styles.navItem} onClick={...}>` | `<button type="button" className={styles.navItem} onClick={...}>` | 原生侧栏导航触点，类名完全相同，无样式漂移 |
| `components/diff/DiffCardGitActions.tsx:125` | `<Button bare type="button" className={styles.actionBtn}>` | `<button type="button" className={styles.actionBtn}>` | 保持 Diff 操作按钮外层纯 CSS 控制 |
| `components/chat-card/SessionInlineRename.tsx:54` | `<Button bare className={styles.renameTrigger} onClick={...}>` | `<button type="button" className={styles.renameTrigger} onClick={...}>` | 内联重命名触点，原生按键语义对等 |
| `components/chat-composer/ComposerField.tsx:119` | `<Button bare className={styles.iconTrigger}>` | `<button type="button" className={styles.iconTrigger}>` | 保持输入框内部操作图标的精简渲染 |
| `components/WizardKeyStep.tsx:137, 155, 191` | `<Button bare className={styles.optionCard}>` | `<button type="button" className={styles.optionCard}>` | 卡片选择项保持全外层 CSS 驱动 |

---

## 四、课题二：剔除 Dialog 运行时 AST 探测与多程渲染反模式

### 4.1 声明式复合架构设计（Declarative Compound Dialog）

彻底摒弃在运行时把 children 转为数组探测类型的黑盒模式，全面拥抱标准的 React 复合组件模式（Compound Components Pattern）。

```
┌────────────────────────────────────────────────────────────────────────┐
│                   现代化声明式 Dialog 复合架构体系                        │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│   <Dialog.Root open={open} onClose={handleClose}>                      │
│     │                                                                  │
│     ├── Provider: 分发单一真理源状态与确定性 ID (useId)                   │
│     │   { open, onClose, dialogId, titleId, descriptionId, ... }       │
│     │                                                                  │
│     ├── <Dialog.Overlay> (遮罩外壳 + 进退场动画 + 点击关闭)              │
│     │     │                                                            │
│     │     └── <Dialog.Content size="md"> (面板实体 + 焦点限制)         │
│     │           │                                                      │
│     │           ├── <Dialog.Header>                                    │
│     │           │     ├── <Dialog.Title>标题内容</Dialog.Title>        │
│     │           │     └── <Dialog.Close />                             │
│     │           │                                                      │
│     │           ├── <Dialog.Description>描述正文</Dialog.Description>  │
│     │           ├── <Dialog.Body>主体内容...</Dialog.Body>             │
│     │           └── <Dialog.Footer>底部操作按钮...</Dialog.Footer>     │
│     │                                                                  │
│     └── (0 运行时 Children 探测、0 状态逆向倒灌、挂载期 1 次单程稳定渲染)  │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 4.2 根除运行时 AST 探测

在 `<Dialog.Root>` 中，彻底删除 `React.Children.toArray(children)` 及 `hasOverlay`, `hasContent`, `hasSections` 的多分支分支判断。

全面对齐 P03 的 `@base-ui/react/dialog` 现代化架构：
1. **单一真理生命周期**：由 `@base-ui/react/dialog` 原生接管 Portal 挂载、FocusTrap 焦点限制、Esc 拦截与点击外部退栈；
2. **纯 CSS 原生进出场**：彻底清退 `useAnimatedPresence.ts`（144行定时器胶水），出入场动效完全交由 CSS `@starting-style` 与 `transition-behavior: allow-discrete`，组件内部零 `isExiting` 或 `ctx.state === 'exiting'` 竞态状态机；
3. **确定性上下文分发**：根级分发静态生成的确定性 `useId()` 标识与尺寸变体配置；
4. **单程纯渲染**：组件自顶向下单向透传，彻底消除 Fragment 失效与 AST 探测黑盒。

透传渲染逻辑仅需极简的 Base UI 复合原语声明：
```tsx
return (
  <BaseDialog.Root open={open} onOpenChange={handleOpenChange} role={role}>
    <DialogContext.Provider value={ctxValue}>
      {children}
    </DialogContext.Provider>
  </BaseDialog.Root>
);
```
**技术断言**：由于不再检查 `c.type`，无论是 `React.Fragment`、自定义 `<MyModalHeader>` 包装、还是条件语句 `{open && <Dialog.Content>}`，均能完美正常渲染，彻底消除 Fragment 失效的隐藏 Bug！

---

### 4.3 根除状态倒灌与多程渲染：确定性 ID 契约

#### 4.3.1 状态倒灌消除前后流程对比

```
【原有流程：状态倒灌，2 次渲染】
挂载期第 1 程渲染：
  Dialog 初始 state: titleCount = 0
  DialogContent 读取 ctx.hasTitle = false
  -> 渲染 DOM，aria-labelledby 为 undefined

挂载期第 2 程渲染：
  DialogTitle 挂载完毕，触发 useEffect
  -> 执行 ctx.registerTitle()
  -> 父级 Dialog 状态突变: setTitleCount(1)
  -> 父级 Dialog 重绘！
  -> DialogContent 重绘！aria-labelledby 变为 "titleId"（属性跳跃）

────────────────────────────────────────────────────────────────────────

【本方案标准流程：静态确定性 ID，1 次单程渲染】
挂载期第 1 程渲染（唯一的一程）：
  DialogRoot 由 useId() 初始化稳定 titleId 与 descriptionId
  Context 直接向下静态分发 { titleId, descriptionId }
  DialogContent 直接静态绑定:
    aria-labelledby={ariaLabel ? undefined : ctx.titleId}
    aria-label={ariaLabel}
  DialogTitle 默认渲染 <h2 id={ctx.titleId}>
  -> 一步到位渲染出完整且正确的 DOM 与无障碍关联，0 额外重绘！
```

#### 4.3.2 重构后的 DialogTitle 与 DialogContent 实现

文件位置：`apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx`（局部核心原语）
```tsx
/* 复合子原语：DialogTitle（彻底删除 registerTitle 与 useEffect） */
export interface DialogTitleProps
  extends React.HTMLAttributes<HTMLHeadingElement> {
  ref?: React.Ref<HTMLHeadingElement>;
  as?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'div' | 'span';
}

export function DialogTitle({
  ref,
  as: Comp = 'h2',
  id,
  className,
  children,
  ...props
}: DialogTitleProps) {
  const ctx = useDialogContext();
  // 静态消费 Context 稳定的 titleId，完全杜绝 useEffect 状态倒灌
  const titleId = id ?? ctx.titleId;

  const classNames = [styles.dialogTitle, className].filter(Boolean).join(' ');

  return (
    <Comp ref={ref} id={titleId} className={classNames} {...props}>
      {children}
    </Comp>
  );
}

/* 复合子原语：DialogContent（直接静态消费 aria 关联） */
export interface DialogContentProps
  extends React.HTMLAttributes<HTMLDivElement> {
  ref?: React.Ref<HTMLDivElement>;
  size?: DialogSize;
  role?: DialogRole;
  ariaLabel?: string;
}

export function DialogContent({
  ref,
  size: explicitSize,
  role: explicitRole,
  ariaLabel: explicitAriaLabel,
  className,
  children,
  ...props
}: DialogContentProps) {
  const ctx = useDialogContext();
  const mergedRef = useMergedRefs(ctx.panelRef, ref);

  const resolvedSize = explicitSize ?? ctx.size;
  const resolvedRole = explicitRole ?? ctx.role;
  const resolvedAriaLabel = explicitAriaLabel ?? ctx.ariaLabel;

  const panelClasses = [
    styles.dialog,
    SIZE_CLASS[resolvedSize],
    ctx.classNames?.panel,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={mergedRef}
      role={resolvedRole}
      aria-modal="true"
      aria-label={resolvedAriaLabel}
      aria-labelledby={resolvedAriaLabel ? undefined : ctx.titleId}
      aria-describedby={ctx.descriptionId}
      className={panelClasses}
      {...props}
    >
      {children}
    </div>
  );
}
```

---

### 4.4 便利语法糖组件独立封装（StandardDialog）

为了兼顾开发效率，针对项目中 20 余处无需自定义复杂布局、仅需传入 `title`、`footer`、`children` 的标准模态弹窗，提供独立的纯函数便捷组件 `<StandardDialog>`。该组件在内部直接调用上述复合原语组合，绝对不在运行时做任何 `Children.toArray` 探测，实现 100% 声明式且零黑盒。

文件位置：`apps/crish-desktop/src/components/ui/Dialog/StandardDialog.tsx`
```tsx
import React from 'react';
import {
  DialogRoot,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  DialogClose,
  type DialogProps,
} from './Dialog';

export interface StandardDialogProps extends DialogProps {
  /** 弹窗标题 */
  title?: React.ReactNode;
  /** 描述文字 */
  description?: React.ReactNode;
  /** 底部操作栏插槽 */
  footer?: React.ReactNode;
}

/**
 * 标准便捷模态弹窗（StandardDialog）
 * 专为常规“标题+主体+底部操作”弹窗设计。
 * 内部静态组装复合原语，彻底清除运行时 AST 探测，性能更优、排版 100% 确定。
 */
export function StandardDialog({
  title,
  description,
  footer,
  children,
  showCloseButton = true,
  dismissible = true,
  ...rootProps
}: StandardDialogProps) {
  return (
    <DialogRoot dismissible={dismissible} {...rootProps}>
      <DialogOverlay>
        <DialogContent>
          {title != null || (dismissible && showCloseButton) ? (
            <DialogHeader>
              {title != null ? <DialogTitle>{title}</DialogTitle> : null}
              {dismissible && showCloseButton ? <DialogClose /> : null}
            </DialogHeader>
          ) : null}

          {description != null ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}

          <DialogBody>{children}</DialogBody>

          {footer != null ? <DialogFooter>{footer}</DialogFooter> : null}
        </DialogContent>
      </DialogOverlay>
    </DialogRoot>
  );
}
```

---

## 五、课题三：全量组件 React 19 原生化升级方案

### 5.1 React 19 纯函数组件契约标准

在 React 19 中，`ref` 已作为常规 prop 传递给组件，官方已将 `forwardRef` 标记为弃用（Deprecated）。全面升级后，组件定义由繁琐的高阶包装回归至 JavaScript 原生纯函数：

```tsx
// 改造前（React 18 历史样板）
export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  function Card({ padding = 'md', className, children, ...restProps }, ref) {
    return <div ref={ref} className={...} {...restProps}>{children}</div>;
  }
);
Card.displayName = 'Card';

// 改造后（React 19 原生纯函数）
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  ref?: React.Ref<HTMLDivElement>;
  padding?: CardPadding;
}

export function Card({
  ref,
  padding = 'md',
  className,
  children,
  ...restProps
}: CardProps) {
  return <div ref={ref} className={...} {...restProps}>{children}</div>;
}
```

---

### 5.2 全仓 15+ 核心组件全景升级清单与改造对照

本次演进覆盖 `apps/crish-desktop/src/components/ui/` 下的全部核心组件，清退 100% 的 `forwardRef` 与 `displayName`：

| 组件名称 | 源码所在文件路径 | 存量 forwardRef 位置 | 升级后纯函数形态 | 内部 Ref 合并处理 |
| :--- | :--- | :--- | :--- | :--- |
| **Button** | `components/ui/Button/Button.tsx` | Line 65 | `export function Button({ ref, ... }: ButtonProps)` | 单节点直传原生 `<button ref={ref}>` |
| **IconButton** | `components/ui/Button/IconButton.tsx` | Line 55 | `export function IconButton({ ref, ... }: IconButtonProps)` | 直传内部 `<Button ref={ref}>` |
| **Input** | `components/ui/Input/Input.tsx` | Line 45 | `export function Input({ ref, ... }: InputProps)` | `useMergedRefs(internalInputRef, ref)` |
| **Textarea** | `components/ui/Input/Textarea.tsx` | Line 35 | `export function Textarea({ ref, ... }: TextareaProps)` | `useMergedRefs(internalTextareaRef, ref)` |
| **DialogOverlay** | `components/ui/Dialog/Dialog.tsx` | Line 136 | `export function DialogOverlay({ ref, ... }: DialogOverlayProps)` | `useMergedRefs(handleOverlayRef, ref)` |
| **DialogContent** | `components/ui/Dialog/Dialog.tsx` | Line 193 | `export function DialogContent({ ref, ... }: DialogContentProps)` | `useMergedRefs(ctx.panelRef, ref)` |
| **DialogHeader** | `components/ui/Dialog/Dialog.tsx` | Line 269 | `export function DialogHeader({ ref, ... }: DialogHeaderProps)` | 直传 `<div ref={ref}>` |
| **DialogTitle** | `components/ui/Dialog/Dialog.tsx` | Line 292 | `export function DialogTitle({ ref, ... }: DialogTitleProps)` | 直传 `<Comp ref={ref}>` |
| **DialogDescription** | `components/ui/Dialog/Dialog.tsx` | Line 324 | `export function DialogDescription({ ref, ... }: DialogDescriptionProps)` | 直传 `<p ref={ref}>` |
| **DialogBody** | `components/ui/Dialog/Dialog.tsx` | Line 353 | `export function DialogBody({ ref, ... }: DialogBodyProps)` | 直传 `<div ref={ref}>` |
| **DialogFooter** | `components/ui/Dialog/Dialog.tsx` | Line 375 | `export function DialogFooter({ ref, ... }: DialogFooterProps)` | 直传 `<div ref={ref}>` |
| **DialogClose** | `components/ui/Dialog/Dialog.tsx` | Line 398 | `export function DialogClose({ ref, ... }: DialogCloseProps)` | 直传 `<button ref={ref}>` |
| **Card** | `components/ui/Card/Card.tsx` | Line 32 | `export function Card({ ref, ... }: CardProps)` | 直传 `<div ref={ref}>` |
| **Badge** | `components/ui/Badge/Badge.tsx` | Line 64 | `export function Badge({ ref, ... }: BadgeProps)` | 直传 `<span ref={ref}>` |
| **Row** | `components/ui/Row/Row.tsx` | Line 39 | `export function Row({ ref, ... }: RowProps)` | 直传 `<div ref={ref}>` |
| **ScrollArea** | `components/ui/ScrollArea/ScrollArea.tsx` | Line 38 | `export function ScrollArea({ ref, ... }: ScrollAreaProps)` | `useMergedRefs(viewportRef, ref)` |
| **SegmentedControl** | `components/ui/SegmentedControl/SegmentedControl.tsx`| Line 69 | `export function SegmentedControl({ ref, ... }: SegmentedControlProps)` | 直传 `<div ref={ref}>` |
| **SelectTrigger** | `components/ui/Select/SelectTrigger.tsx` | Line 8 | `export function SelectTrigger({ ref, ... }: SelectTriggerProps)` | `useMergedRefs(triggerRef, ref)` |
| **ComboboxInput** | `components/ui/Select/ComboboxInput.tsx` | Line 7 | `export function ComboboxInput({ ref, ... }: ComboboxInputProps)` | `useMergedRefs(inputRef, ref)` |
| **Slider** | `components/ui/Slider/Slider.tsx` | Line 34 | `export function Slider({ ref, ... }: SliderProps)` | 直传 `<div ref={ref}>` |
| **Switch** | `components/ui/Switch/Switch.tsx` | Line 61 | `export function Switch({ ref, ... }: SwitchProps)` | 直传 `<button ref={ref}>` |
| **Tabs 系列** | `components/ui/Tabs/Tabs.tsx` | Line 35, 137, 329 | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | 分别直传对应容器节点 |
| **Tooltip** | `components/ui/Tooltip/Tooltip.tsx` | Line 73 | `export function Tooltip({ ref, ... }: TooltipProps)` | `useMergedRefs(triggerRef, ref)` |
| **ContextMenu 系列**| `components/ui/ContextMenu/ContextMenu.tsx` | 多处 | 各子原语纯函数化 | 分别直传对应菜单节点 |
| **AnimatedIcons** | `components/ui/animated-icons/*.tsx` | 4 文件 | `CopyIcon`, `PencilIcon`, `PinIcon`, `PinOffIcon` | 直传 `<svg ref={ref}>` |

---

### 5.3 统一的 React 19 Ref 合并工具：`mergeRefs` 与 `useMergedRefs`

为淘汰各组件内部手写 8~15 行分散、不兼容 React 19 Cleanup 的 `setCombinedRef`，在 `components/ui/utils/` 下确立标准合并工具。

文件位置：`apps/crish-desktop/src/components/ui/utils/mergeRefs.ts`
```ts
import React, { useCallback } from 'react';

type PossibleRef<T> = React.Ref<T> | undefined;

/**
 * 纯函数：合并多个 Ref，完全遵照 React 19 Ref Callback Cleanup 规范。
 * 若子 Ref 回调返回了清理函数，在节点卸载时自动依次执行清理。
 */
export function mergeRefs<T>(...refs: PossibleRef<T>[]): React.RefCallback<T> {
  return (value: T | null) => {
    const cleanups: Array<() => void> = [];

    for (const ref of refs) {
      if (!ref) continue;

      if (typeof ref === 'function') {
        const cleanup = ref(value);
        if (typeof cleanup === 'function') {
          cleanups.push(cleanup);
        }
      } else {
        try {
          (ref as React.MutableRefObject<T | null>).current = value;
        } catch {
          // 容错处理：部分不可变 ref 对象防护
        }
      }
    }

    if (cleanups.length > 0) {
      return () => {
        for (const cleanup of cleanups) {
          try {
            cleanup();
          } catch {
            // 确保单个 cleanup 异常不阻断其余清理
          }
        }
      };
    }
  };
}

/**
 * Hook 封装：在组件生命周期内稳定返回合并后的 Ref Callback
 */
export function useMergedRefs<T>(...refs: PossibleRef<T>[]): React.RefCallback<T> {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback(mergeRefs(...refs), refs);
}
```

---

## 六、复合组件（Group）架构设计规范与导出收缩

### 6.1 Group 架构严格二分法则（The Two-Track Law for Groups）

项目中存在多处类似 `ButtonGroup`、`RadioGroup`、`ContextMenuGroup` 等容器型组件。为防止过度设计或在纯表现组件中滥用 Context，制定严格的 Group 二分法则：

```
┌────────────────────────────────────────────────────────────────────────┐
│                   Group 复合组件二分法则 (The Two-Track Law)            │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  【类别 A：轻量级表现型 Group（cloneElement 型）】                      │
│   • 典型代表：ButtonGroup, IconButtonGroup, TagGroup                  │
│   • 职责范围：纯视觉排版、边缘圆角缝合、相邻边框合并（-1px margin）   │
│   • 架构纪律：                                                         │
│     1. 同文件紧凑内聚，严禁单独拆目录与设立 Context Provider；         │
│     2. 使用 React.Children.map + React.cloneElement 仅向子组件注入     │
│        纯视觉布局标记（data-position="first"|"middle"|"last"）；        │
│     3. 严禁改写子节点的业务 props、onClick 或内部逻辑。                │
│                                                                        │
│  【类别 B：高内聚状态型 Group（Context 型）】                          │
│   • 典型代表：RadioGroup, SelectGroup, TabGroup, ContextMenuGroup       │
│   • 职责范围：键盘导航（Roving Focus TabIndex）、受控单选值共享        │
│   • 架构纪律：                                                         │
│     1. 独立目录组织，必须配备专属强类型 Context 与 useXxxGroupContext； │
│     2. 状态自顶向下单向流动，严禁使用 cloneElement 强行覆盖私有 props； │
│     3. 子组件（如 RadioItem）通过 Hook 安全消费上下文。               │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

#### 类别 A 典范实现：`ButtonGroup`
```tsx
export interface ButtonGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: ButtonSize;
  orientation?: 'horizontal' | 'vertical';
}

export function ButtonGroup({
  size,
  orientation = 'horizontal',
  className,
  children,
  ...props
}: ButtonGroupProps) {
  const validChildren = React.Children.toArray(children).filter(React.isValidElement);
  const total = validChildren.length;

  return (
    <div
      role="group"
      className={[styles.buttonGroup, className].filter(Boolean).join(' ')}
      data-orientation={orientation}
      {...props}
    >
      {validChildren.map((child, index) => {
        const position =
          index === 0 ? 'first' : index === total - 1 ? 'last' : 'middle';
        return React.cloneElement(child, {
          ...(size ? { size } : {}),
          'data-position': position,
        } as React.Attributes);
      })}
    </div>
  );
}
```

---

### 6.2 极小公共导出表面（Minimal Public Surface / Opaque Exports）

为杜绝组件库实现细节被外部业务深度偶合，在 `apps/crish-desktop/src/components/ui/index.ts` 建立极小导出表面：

1. **白名单允许导出（Public Surface）**：
   - 组件纯函数：`Button`, `IconButton`, `BaseButton`, `Input`, `Dialog`, `StandardDialog` 等；
   - 样式生成器纯函数：`buttonVariants`；
   - 公共类型契约：`ButtonProps`, `ButtonVariant`, `ButtonSize`, `DialogProps` 等；
   - 复合子组件绑定命名空间：`Dialog.Root`, `Dialog.Content`, `Dialog.Header` 等。
2. **严禁导出（Opaque Private Implementation）**：
   - 内部 DOM Refs 句柄与底层 `internalInputRef`；
   - 内部 CVA / CSS Modules 映射字典（如 `VARIANT_CLASS_MAP`, `SIZE_CLASS_MAP`）；
   - 私有几何与定位纯函数（`computeClampedPosition`, `isTriggerOffscreen`）；
   - 私有注册中枢与监听器。
3. **与 P01 包拓扑方案无缝对接**：
   所有业务模块只允许从 `@/components/ui` 统一导入，严禁使用深层相对路径（如 `../../ui/Button/Button.tsx`）进行越权访问。

---

## 七、迁移实施路线与自动化 Codemod 方案

### 7.1 四阶段平滑演进管道（Four-Phase Execution Pipeline）

为确保上万行前端业务代码平稳升级、零运行时中断，迁移分四步严格推进：

```
┌────────────────────────────────────────────────────────────────────────┐
│                   P05 四阶段平滑迁移流水线                             │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  [Phase 1: 基础设施与契约先行]                                         │
│  • 落地 mergeRefs / useMergedRefs 纯工具；                             │
│  • 落地 buttonVariants 与 BaseButton；                                 │
│  • 落地声明式 Dialog 复合架构与 StandardDialog；                       │
│  • 保持现有业务代码 100% 正常运行。                                    │
│                                                                        │
│  [Phase 2: 全仓 Codemod 自动化批量替换]                                │
│  • 执行 forwardRef -> React 19 纯函数批量替换脚本；                    │
│  • 执行全仓 <Button bare> -> <button type="button"> 批量迁移；         │
│  • 移除全部组件冗余的 displayName。                                    │
│                                                                        │
│  [Phase 3: Dialog 业务调用点收敛与 AST 探测彻底移除]                    │
│  • 批量替换存量简易 Dialog 为 StandardDialog；                         │
│  • 复合 Dialog 移除全部 AST 探测代码与 registerTitle 状态倒灌；        │
│  • 彻底清除 Dialog.tsx 中的历史兼容分支。                              │
│                                                                        │
│  [Phase 4: 全量类型验证与测试套件守护]                                  │
│  • 运行 npm run typecheck（确保 0 类型报错）；                         │
│  • 运行 vitest 全量前端单元测试；                                      │
│  • 验证 100% 样式像素零漂移。                                          │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 7.2 生产级 Codemod 脚本实现方案

#### 7.2.1 脚本一：`scripts/codemod/migrate-forwardref-to-react19.ts`
基于 TypeScript AST（ts-morph），全自动将 `React.forwardRef` 包装的组件改写为 React 19 纯函数组件，并自动将 `ref` 提升为组件首个解构参数。

```ts
import { Project, SyntaxKind } from 'ts-morph';

export function migrateForwardRefToReact19(project: Project, filePath: string) {
  const sourceFile = project.getSourceFileOrThrow(filePath);

  // 1. 查找所有 React.forwardRef 调用表达式
  const forwardRefCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter(call => {
      const expr = call.getExpression().getText();
      return expr === 'React.forwardRef' || expr === 'forwardRef';
    });

  for (const call of forwardRefCalls) {
    const parentVar = call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    if (!parentVar) continue;

    const componentName = parentVar.getName();
    const renderFn = call.getArguments()[0];
    if (!renderFn || !renderFn.isKind(SyntaxKind.FunctionExpression)) continue;

    const params = renderFn.getParameters();
    const propsParam = params[0]?.getText() ?? 'props';
    const refParam = params[1]?.getText() ?? 'ref';

    // 提取类型实参
    const typeArgs = call.getTypeArguments();
    const refType = typeArgs[0]?.getText() ?? 'HTMLElement';
    const propsType = typeArgs[1]?.getText() ?? `${componentName}Props`;

    const bodyText = renderFn.getBody()?.getText() ?? '{}';

    // 重新生成 React 19 纯函数组件
    const newFnText = `export function ${componentName}({ ref, ...${propsParam.replace(/^\{|\}$/g, '')} }: ${propsType}) ${bodyText}`;

    const statement = parentVar.getFirstAncestorByKind(SyntaxKind.VariableStatement);
    statement?.replaceWithText(newFnText);
  }

  // 2. 移除冗余的 Component.displayName = '...' 语句
  sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression).forEach(bin => {
    if (bin.getLeft().getText().endsWith('.displayName')) {
      bin.getFirstAncestorByKind(SyntaxKind.ExpressionStatement)?.remove();
    }
  });

  sourceFile.saveSync();
}
```

#### 7.2.2 脚本二：`scripts/codemod/migrate-button-bare.ts`
全自动扫描所有 JSX 文件，将 `<Button bare ...>` 一键转换为 `<button type="button" ...>`，若含有 `static` 或 `align` 则转换为 `data-static` 与 `data-align`，类名与事件 100% 无损透传。

```ts
import { Project, SyntaxKind } from 'ts-morph';

export function migrateButtonBare(project: Project) {
  project.getSourceFiles().forEach(sourceFile => {
    let hasChanges = false;
    const jsxElements = sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement);

    for (const el of jsxElements) {
      if (el.getTagNameNode().getText() !== 'Button') continue;

      const bareAttr = el.getAttribute('bare');
      if (!bareAttr) continue;

      // 存在 bare 属性，进行原子级替换为原生语义 <button type="button">
      el.getTagNameNode().replaceWithText('button');

      // 1. 确保存在 type="button"
      if (!el.getAttribute('type')) {
        el.addAttribute({ name: 'type', initializer: '"button"' });
      }

      // 2. 移除 bare 属性
      bareAttr.remove();

      // 3. 剥离原生 <button> 不支持的自定义 Props（防止 TS2322 编译报错）
      const PROPS_TO_STRIP = [
        'variant',
        'size',
        'icon',
        'iconPosition',
        'loading',
        'block',
        'active',
      ];
      for (const propName of PROPS_TO_STRIP) {
        el.getAttribute(propName)?.remove();
      }

      // 4. 将 align 与 static 平滑转为标准 data-* 属性
      const alignAttr = el.getAttribute('align');
      if (alignAttr) {
        const alignVal = alignAttr.getText().replace(/^align=/, '');
        el.addAttribute({ name: 'data-align', initializer: alignVal });
        alignAttr.remove();
      }

      const staticAttr = el.getAttribute('static');
      if (staticAttr) {
        el.addAttribute({ name: 'data-static', initializer: '"true"' });
        staticAttr.remove();
      }

      // 5. 同步替换闭合标签
      const parent = el.getParent();
      if (parent.isKind(SyntaxKind.JsxElement)) {
        parent.getClosingElement().getTagNameNode().replaceWithText('button');
      }

      hasChanges = true;
    }

    if (hasChanges) {
      sourceFile.saveSync();
    }
  });
}
```

---

## 八、验收断言矩阵与门禁守护（Acceptance Assertions）

本方案的实施必须通过以下刚性断言矩阵验证：

| 校验维度 | 验收断言条件（Acceptance Assertion） | 验证方法与自动化门禁 |
| :--- | :--- | :--- |
| **契约真实性断言** | `ButtonProps` 中不存在 `bare` 字段；全仓 0 处 `<Button bare>`；传给 `Button` 的所有 Props 100% 渲染生效。 | `npm run typecheck` + `npm run check:button-contract` |
| **单程渲染断言** | `Dialog` 挂载期间重绘次数恒等于 1；初次渲染即正确绑定 `aria-labelledby`；0 处 `registerTitle`。 | `vitest run Dialog.test.tsx`（新增单程挂载监听断言） |
| **AST 探测清零断言** | `Dialog.tsx` 中 `Children.toArray`、`c.type ===` 探测代码行数恒等于 0；Fragment 包装 100% 正常渲染。 | `npm run check:dialog-purity` |
| **React 19 原生化断言** | `src/components/ui/` 目录下 `forwardRef` 出现次数为 0；`displayName` 赋值次数为 0；Ref 合并统一走 `useMergedRefs`。 | `npm run check:react19-hygiene` |
| **视觉与排版零漂移断言** | 全仓页面与弹窗在替换前后 DOM 几何尺寸、类名解析、外边距、内边距 100% 保持一致。 | 自动化快照对比 + E2E 视觉回归 |
| **测试资产保护铁律** | 仓库既有全部核心单元测试、集成测试原样保持 100% 绿灯。 | `npm run test` + `cargo test --workspace` |
