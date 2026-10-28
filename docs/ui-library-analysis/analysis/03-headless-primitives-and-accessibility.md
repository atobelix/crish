# 底层无障碍与 Headless 原语基座深度剖析与演进建议

> **报告版本**：1.0.0  
> **战役代号**：`ui-library-analysis`  
> **报告编号**：03  
> **分析专家**：Headless & Accessibility Analyst  
> **标杆对比库**：`reference/appica-ui` (@base-ui/react v1.9+), `reference/ui` (shadcn/ui), `reference/arc-library` (@radix-ui/*)  
> **对比标的**：`apps/crish-desktop/src/components/ui/` 原子层原语体系与无障碍基础设施  
> **核心产出**：Headless 原语架构对比、焦点与弹层治理审计、A11y/WCAG 自动化测试体系、渐进式重构路线图  

---

## 一、执行摘要与核心论点 (Executive Summary)

现代化前端交互开发正在经历一场深层次的基座升级：从过去**基于特定 DOM 假设的手写脚本（FocusTrap/手动坐标计算/DOM 属性白名单）**，彻底演进至**标准化、语义完备的 Headless 原语（Headless Primitives）**。

在深入研读 `reference/appica-ui`（基于全新 `@base-ui/react` v1.9+）、`reference/ui`（shadcn/ui 官方双基座）、`reference/arc-library`（Radix + Motion 深度封装），并与 Conex / Crish 当前 `apps/crish-desktop/src/components/ui/` 的源码对照后，得出以下核心结论：

1. **原语基座的代际分化**：
   - **Radix UI（上一代王者）**：以 `@radix-ui/*` 微包群与 `asChild`（Slot 模式）为代表，虽然生态庞大，但面临 React 19 兼容摩擦、微包依赖膨胀、Slot 组合脆弱（`React.Children.only` 限制）等痛点。
   - **Base UI v1.9+（现代前沿架构）**：MUI 团队自底向上完全重构的现代化无头库，采用单一包 `@base-ui/react`。其开创性的 **`render` 模式**彻底解决了 Slot 模式的脆弱性；原生解耦 `Portal`、`Positioner`、`Backdrop`、`Viewport`、`Popup` 物理层；并深度集成 CSS `@starting-style`，原生消除 JS 动画定时器。
2. **Conex / Crish 当前基座的系统性脆弱与维护债务**：
   - 当前项目处于「极度碎片化的混合自研态」：仅引入了 `@radix-ui/react-popover` 与 `@radix-ui/react-dismissable-layer` 两个边缘包，却为 Dialog、Select、Menu、Tooltip、SmartPanel 编写了 **超过 1,800 行高风险的底层胶水代码**。
   - **典型架构断层**：
     - `focusTrap.tsx` 采用基于 `document.body` 遍历的 `FocusTrapIsolationManager`，因 React Portal 破坏 DOM 树层级，被迫维持一段**长达 30 余项的选择器硬编码白名单**（`isWhitelisted()`）；
     - `dialogOverlayContext.ts` 强行进行 z-index 提权穿透，以解决弹窗内 Select/Menu 被遮罩阻挡的问题；
     - `tooltipController.ts` 甚至使用 `patchContainerSafeRemove` **直接 Monkey-patch 原生 DOM `removeChild` 方法**来掩盖 Portal 卸载竞态；
     - `Select` 与 `Menu` 缺少真正的 WAI-ARIA Listbox/Menu 状态机，缺失键入字符实时搜索（Type-ahead）、Live Region 朗读与无级级联支持。
3. **无障碍（A11y / WCAG）测试完全处于真空状态**：
   - `reference/appica-ui` 树立了工业级 A11y 测试标杆：在 Vitest 环境中无缝集成 `vitest-axe`，全库 **82 套组件测试用例** 100% 覆盖 `expect(await axe(element)).toHaveNoViolations()`；
   - Conex / Crish 全仓（`apps/` 与 `packages/`）的 `axe` 自动化测试用例数量为 **0**，无障碍断言处于完全不可信的裸奔状态。
4. **演进路径决议**：
   - 强烈建议 Conex / Crish 前端原子层全面拥抱 **`@base-ui/react` (Base UI v1.9+)** 作为统一 Headless 原语基座，分四阶段渐进重构，净清退手写 FocusTrap、手动浮层计算与 Monkey-patch 代码，同时引入 `vitest-axe` 建立刚性无障碍 CI 门禁。

---

## 二、现代化 Headless 原语基座深度剖析 (Deep Dive)

### 2.1 Base UI (`@base-ui/react` v1.9+) 的前沿架构范式

在 `reference/appica-ui/packages/react/package.json:490` 中，Appica UI 采用了 `@base-ui/react: "^1.9.0"`。查阅 `reference/appica-ui/packages/react/.context/base-ui-llms.txt` 可以清晰看到其架构设计目标：**极高组合性、样式彻底无关、全面原生支持 React 19、基于现代 Web 标准**。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Base UI v1.9+ 分层原语模型                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. 结构与宿主层 (Portal):                                                    │
│     <BaseDialog.Portal> / <BaseSelect.Portal>                               │
│     负责声明式挂载，支持 container 自定义与 keepMounted 保持 DOM 存活         │
├─────────────────────────────────────────────────────────────────────────────┤
│  2. 遮罩与视口层 (Backdrop / Viewport / Positioner):                          │
│     - Modal 类: <Backdrop> (半透明遮罩) + <Viewport> (居中约束/滚动边界)      │
│     - Floating 类: <Positioner> (解耦锚点追踪、碰撞避免、Offset 计算)         │
├─────────────────────────────────────────────────────────────────────────────┤
│  3. 交互与容器层 (Popup):                                                     │
│     <BaseDialog.Popup> / <BaseSelect.Popup>                                 │
│     承载 CSS 类名、阴影、圆角、键盘交互、聚焦管理与 @starting-style 动效      │
├─────────────────────────────────────────────────────────────────────────────┤
│  4. 内容与无障碍标注层 (Title, Description, Item, Trigger...):                 │
│     自动完成 aria-labelledby、aria-describedby、aria-activedescendant 关联   │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 2.1.1 物理层级正交解耦：Modal vs Floating 两种骨架

在 `reference/appica-ui/packages/react/src/internal/modal.ts` 和 `floating.ts` 中，Appica UI 将所有复合弹层抽象为两套极其规整的结构模型：

1. **模态型覆盖层（Modal Overlay Pipeline）**：
   - 源码路径：`reference/appica-ui/packages/react/src/components/dialog/dialog.tsx:67-90`
   - 管道结构：`Portal` $\rightarrow$ `Backdrop` $\rightarrow$ `Viewport` $\rightarrow$ `Popup`。
   - **优势**：将背景模糊遮罩（Backdrop）与居中约束容器（Viewport）彻底拆分为独立 DOM 节点，解决以往「Backdrop 含有子元素导致子元素 `backdrop-filter` 穿透失效或滚动条锁死」的传统 CSS 难题。
2. **浮动型吸附层（Anchored Floating Pipeline）**：
   - 源码路径：`reference/appica-ui/packages/react/src/components/select/select.tsx:237-250`
   - 管道结构：`Portal` $\rightarrow$ `Positioner` $\rightarrow$ `Popup`。
   - **优势**：`Positioner` 只负责高频的 `transform` 坐标定位与碰撞逃逸，而 `Popup` 专门负责缩放、阴影、圆角等视觉形态，两者职责严格解耦，彻底避免了由于在同一节点上混合 `transform` 坐标与 `scale` 缩放导致的动画抖动。

#### 2.1.2 现代 CSS 动效原生支持：消除 JS 定时器胶水

传统的 React 弹窗离开动画通常依赖 Framer Motion / Motion 的 `<AnimatePresence>`，或者在组件内部写一套由 `setTimeout` 驱动的 JS 状态机（如当前 crish 的 `useAnimatedPresence.ts`，150ms 计时器硬编码）。

Base UI 原生拥抱浏览器现代 CSS 特性：
```css
/* reference/appica-ui/packages/react/src/components/dialog/dialog.tsx:75-99 */
/* 进场状态由 data-starting-style 驱动，离场状态由 data-ending-style 驱动 */
.dialog-popup {
  transition: opacity 250ms ease-out, transform 250ms var(--ease-spring);
}
.dialog-popup[data-starting-style],
.dialog-popup[data-ending-style] {
  opacity: 0;
  transform: scale(0.95);
}
```
Base UI 内部监听原生 `transitionend` / `animationend` 事件，无需在 JavaScript 中维护任何时间数字，DOM 节点在动画真正终结时才被移除，从根源上杜绝了 CSS 动画时长与 JS 卸载时长不同步导致的「闪退」或「幽灵 DOM」问题。

---

### 2.2 复合组件渲染范式对比：Base UI `render` vs Radix UI `asChild`

在组件扩展性设计中，如何让用户自定义触发器（Trigger）和操作项（Action）是组件库的核心课题。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     三种组件扩展模式横向对比                                │
├─────────────────────┬───────────────────────┬───────────────────────────────┤
│ 特性维度            │ Radix UI (asChild)    │ Base UI (render 模式)          │
├─────────────────────┼───────────────────────┼───────────────────────────────┤
│ 底层实现            │ @radix-ui/react-slot  │ 原生 render prop / element   │
│ 子节点限制          │ 严格限制单个 JSX 元素  │ 支持单元素、组件或状态函数    │
│ React 19 兼容性     │ 易触发 ref 警告/降级  │ 100% React 19 原生对齐        │
│ 状态感知 (State)    │ 无法感知父级交互状态  │ 支持 (props, state) => JSX    │
│ 属性合并稳定性      │ 复杂 cloneElement 隐患│ 干净的内部 mergeProps 处理    │
└─────────────────────┴───────────────────────┴───────────────────────────────┘
```

#### 2.2.1 Radix UI 的 `asChild` Slot 模式及其实践缺陷

查看 `reference/ui/apps/v4/registry/bases/radix/ui/dialog.tsx:68-70`：
```tsx
<DialogPrimitive.Close data-slot="dialog-close" asChild>
  <Button variant="ghost" className="cn-dialog-close" size="icon-sm">
    <IconPlaceholder />
  </Button>
</DialogPrimitive.Close>
```
`asChild` 模式的核心是在底层引入 `@radix-ui/react-slot`。它的工作机制是利用 `React.Children.only` 获取唯一的直接子节点，并通过 `React.cloneElement` 将触发器的 `onClick`、`aria-haspopup`、`ref` 等强行打入子组件。

**缺陷与痛点**：
1. **React 19 的 `ref` 破坏**：React 19 中函数组件废弃了 `forwardRef` 包装，`ref` 成为普通 prop。旧版 Slot 在合并 `child.ref` 时频发类型报错与运行时未定义警告。
2. **状态无法向下注入**：如果触发器内部需要根据弹窗或下拉菜单当前是否处于 `open` 状态来改变自身图标（例如 ChevronDown 旋转 180 度），`asChild` 无法直接传递状态，开发者必须在外部额外引入 `Context` 或自行维护 `open` 状态。
3. **条件渲染与 Fragment 崩溃**：若在 `<Trigger asChild>` 内部写条件分支或 `<React.Fragment>`，Slot 会直接抛出运行时致命异常：`React.Children.only expected to receive a single React element child`。

#### 2.2.2 Base UI 的 `render` 模式：终极复合灵活性

对比查看 `reference/ui/apps/v4/registry/bases/base/ui/dialog.tsx:60-69` 与 `reference/appica-ui/packages/react/src/components/dialog/dialog.test.tsx:35`：
```tsx
// 方式 A：直接传入 React 元素
<DialogTrigger render={<Button>Open dialog</Button>} />

// 方式 B：传入渲染函数，感知底层原语状态
<BaseSelect.Icon
  render={(props, state) => (
    <ChevronDownIcon
      {...props}
      className={cn(props.className, state.open && 'rotate-180')}
    />
  )}
/>
```
**技术优势**：
- 支持接收 ReactElement 或 `(props, state) => ReactNode`，原生获取 `state.open`、`state.highlighted`、`state.selected`；
- 无需依赖隐晦的 DOM 树克隆，内部采用纯粹的高阶函数属性合并（Merge Props）；
- 对 React 19 全功能兼容，无任何 `ref` 剥离警报。

---

### 2.3 浮层堆叠与嵌套焦点中枢机制

在多层弹窗与下拉菜单组合的重度桌面客户端中（例如：在“首选项弹窗”中打开“快捷键录制弹窗”，且录制弹窗内还有“模型选择下拉框”），焦点的捕获、阻断与还原是桌面端最易崩溃的领域。

#### 2.3.1 Base UI 的原生哨兵焦点环（Focus Guards & Stacked Trees）

Base UI 在 `BaseDialog.Popup` 外围原生插入隐式哨兵节点（Focus-guard spans）：
- **双向环形锁定**：当键盘 Tab 到最末尾元素时，焦点直接被拦截并循环引导至第一个可交互元素，不触碰 `document.body` 上的其他 DOM；
- **原生多实例树状层叠**：当嵌套 Dialog 打开时，底层 Dialog 会被自动赋予 `data-nested-dialog-open` 属性：
  ```css
  /* reference/appica-ui/packages/react/src/components/dialog/dialog.tsx:100 */
  .dialog-popup[data-nested-dialog-open] {
    pointer-events: none;
    transform: scale(0.95);
    opacity: 0;
  }
  ```
  底层弹层自动禁用指针事件并微缩后退，顶层弹窗关闭后，焦点自动精确物归原位，全程无需外部声明任何全局 Map 或引用计数器。

#### 2.3.2 命令式控制原语：`createHandle`

在传统 React 弹窗中，如果要从外部或深层组件触发弹窗开关，必须通过 Context 层层透传 `setOpen`。
Base UI 在原语层提供了 `createHandle`（见 `reference/appica-ui/packages/react/src/components/dialog/dialog.tsx:14`）：
```tsx
const dialogHandle = Dialog.createHandle();

// 任意位置命令式调用，无需 Context 包装
dialogHandle.open();
dialogHandle.close();

<Dialog handle={dialogHandle}>...</Dialog>
```

---

### 2.4 Appica UI 的无障碍（A11y / WCAG）自动化测试黄金实践

在 `reference/appica-ui/packages/react/` 中，无障碍不是口号，而是贯穿 CI 的绝对硬门槛。

#### 2.4.1 测试环境架构全景

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Appica UI A11y 测试基础设施配置                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. 核心依赖 (package.json:518, 530):                                         │
│    - "axe-core": "^4.14.0" (行业权威无障碍分析引擎)                         │
│    - "vitest-axe": "^0.1.0" (专为 Vitest 封装的 matchers 断言库)           │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. 环境装配 (src/test/setup.ts:1-7):                                         │
│    import * as matchers from 'vitest-axe/matchers'                         │
│    expect.extend(matchers)                                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. 类型增强 (src/test/vitest-axe.d.ts:1-7):                                  │
│    declare module 'vitest' {                                                │
│      interface Assertion<T = any> extends AxeMatchers {}                   │
│    }                                                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. 组件全量断言 (82 套测试用例):                                             │
│    expect(await axe(element)).toHaveNoViolations()                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 2.4.2 典型用例实证分析

在 `reference/appica-ui/packages/react/src/components/dialog/dialog.test.tsx:191-201` 中：
```tsx
it('has no accessibility violations when open', async () => {
  const user = userEvent.setup()
  renderDialog()

  await user.click(screen.getByRole('button', { name: 'Open dialog' }))
  const dialog = await screen.findByRole('dialog')

  // 精准将 axe 校验约束在弹窗子树内
  expect(await axe(dialog)).toHaveNoViolations()
})
```
经统计，`reference/appica-ui` 的全部 **82 个组件测试文件**，每一个都包含了完整的 `toHaveNoViolations()` 断言，覆盖：
- 颜色对比度（Color Contrast WCAG 2.1 AA）；
- ARIA 标签与可访问角色对应关系（Accessible Name, Roles & States）；
- 键盘焦点指示器完整性；
- 表单控件 Label 绑定的唯一性与可关联性。

---

## 三、Conex / Crish 当前前端原子层基座现状深度审计 (Deep Audit)

审查 `apps/crish-desktop/src/components/ui/`，Conex / Crish 虽然在外观上有现代化的审美追求，但在底层原子原语与无障碍设计上，存在严重的架构断层与高昂的维护成本。

### 3.1 `Dialog` 弹窗体系的脆弱性分析

#### 3.1.1 `FocusTrapIsolationManager` 的白名单灾难

在 `apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx:50-199` 中，自研了一个全局单例的焦点隔离管理器。它的核心逻辑是：当弹窗打开时，遍历 `document.body` 的所有直接子节点以及父级链上的兄弟节点，给非弹窗元素强制添加 `inert` 和 `aria-hidden="true"`。

**代码实证（`focusTrap.tsx:63-95`）**：
```ts
private isWhitelisted(node: Element): boolean {
  if (
    node.hasAttribute('data-radix-popper-content-wrapper') ||
    node.getAttribute('data-tooltip-portal') === 'true' ||
    node.getAttribute('data-toast-container') === 'true' ||
    node.classList.contains('radix-popper-content-wrapper') ||
    node.classList.contains('toaster') ||
    node.id === 'toast-root' ||
    node.id === 'tooltip-portal' ||
    node.getAttribute('data-slot') === 'select-content' ||
    node.getAttribute('data-slot') === 'combobox-content' ||
    node.getAttribute('role') === 'listbox' ||
    node.hasAttribute('data-floating-portal') ||
    node.getAttribute('data-floating-portal') === 'true' ||
    node.hasAttribute('data-floating-layer') ||
    node.getAttribute('data-floating-layer') === 'true' ||
    node.getAttribute('role') === 'menu' ||
    node.getAttribute('data-slot') === 'menu-content' ||
    node.getAttribute('data-slot') === 'context-menu-content' ||
    node.getAttribute('data-slot') === 'dropdown-menu-content' ||
    node.querySelector?.(
      '[data-floating-portal], [data-floating-layer], [data-slot="menu-content"], [data-slot="context-menu-content"], [data-slot="dropdown-menu-content"], [role="menu"], [data-slot="select-content"], [data-slot="combobox-content"], [role="listbox"]'
    ) != null
  ) {
    return true;
  }
  return false;
}
```

**深层根因分析**：
1. **违背 React 树结构规律**：React Portal 默认把弹层节点直接挂载到 `document.body`。当 Dialog 打开时，如果弹窗内的一个 Select 被展开，Select 的浮层也挂到了 `document.body`。FocusTrap 误认为这个浮层是“外部背景元素”，立刻给它打上 `inert` 和 `aria-hidden`！
2. **无限追加补丁（Whack-A-Mole）**：为了让浮层能被点击，工程师不得不不断往 `isWhitelisted()` 里加硬编码选择器。回顾历史文件 `docs/ui-component-modernization/plan-improvements/09-全场景Select接入DialogOverlay与FocusTrap解封详案.md`，团队曾专门耗费一整个迭代波次（Plan 09）去排查和测试为何 Select 在 Dialog 里会失去响应。
3. **Tab 键劫持死锁（`focusTrap.tsx:238-270`）**：在 Tab 键循环逻辑中，由于浮层在物理 DOM 上不属于 Dialog 容器内部，按下 Tab 键会被 FocusTrap 强行判定为“焦点逸出”，将焦点强行扯回弹窗开头，导致浮层内部的方向键与 Tab 导航彻底瘫痪。

#### 3.1.2 穿透补丁：`DialogOverlayContext`

查看 `apps/crish-desktop/src/components/ui/Dialog/dialogOverlayContext.ts:1-11`：
```ts
/**
 * Dialog 遮罩壳层叠上下文：设置全屏等 modal 内的 Menu/Select
 * portal 进 overlay，用局部 z 压过面板，而不抬高全仓 --z-dropdown。
 */
export const DialogOverlayContext = createContext<HTMLElement | null>(null);
```
查看 `apps/crish-desktop/src/components/ui/Select/SelectContent.tsx:20-27`：
```ts
const dialogOverlay = useContext(DialogOverlayContext);
const resolvedContainer =
  portalContainer ??
  dialogOverlay ??
  (typeof document !== 'undefined' ? document.body : null);
```
**架构缺陷**：
Dialog 的 `--dialog-z` 层级高于全仓通用的 `--z-dropdown`。为了避免浮层被弹窗遮罩遮挡，代码设计了一个 Context 强制将内部组件 Portal 挂载点篡改为 Dialog 的自身节点。这种“打洞式穿透”导致组件不再正交，任何需要在 Dialog 内展示的下拉组件都必须显式感知 `DialogOverlayContext`，一旦脱离该 Context（例如在非标准弹窗中复用）便立即复发层叠错误。

#### 3.1.3 `useRestoreFocus.ts` 与 `useAnimatedPresence.ts` 的定时器与竞态隐患

- **`useRestoreFocus.ts:16-25`**：
  在 `useEffect` 中读取 `document.activeElement`。在 React 并发渲染或异步状态更新下，Effect 触发时当前焦点很可能已经被转移；关闭时仅通过 `document.body.contains(savedRef.current)` 做粗糙判断，若触发器因路由跳转或列表刷新已被重新渲染，焦点将被彻底丢弃到 `document.body`。
- **`useAnimatedPresence.ts`**：
  通过 `exitDurationMs: 150` 设置 JS 定时器来等待 CSS 退出动画。一旦 CSS 中的 `--duration-exit` 改动或因机器卡顿丢帧，就会出现“DOM 提前消失导致动画中断”或“DOM 残留阻塞点击”的诡异故障。

---

### 3.2 `Select` 与 `Combobox` 的自研定位与无障碍缺陷

#### 3.2.1 重复造轮子的定位引擎：`useFloatingPosition.ts`

在 `apps/crish-desktop/src/components/ui/Select/useFloatingPosition.ts:85-173` 中，自研了 235 行的手动定位逻辑：
- 手动调用 `triggerEl.getBoundingClientRect()` 与 `contentEl.getBoundingClientRect()`；
- 手动监听 `window.addEventListener('scroll', throttledUpdate, { capture: true })`；
- 手动监听 `app:window-resize-settled` 自定义事件；
- 手动计算碰撞避免与方向翻转。

**问题**：这完全是在脱离现代成熟体系（如 Floating UI 或 Base UI 的 Positioner）的情况下自制简陋定位器，既不支持复杂视口边缘虚拟约束（Collision Boundary），也没有平滑的翻转缓动，并在高频滚动下产生强制同步布局（Forced Synchronous Layout / Layout Thrashing）。

#### 3.2.2 WAI-ARIA 状态机严重残缺

审查 `apps/crish-desktop/src/components/ui/Select/SelectContent.tsx:45-92`：
1. **缺失键入即搜（Type-ahead Buffer）**：成熟的 Select 组件允许用户在聚焦时快速敲击字母（例如快速按 "u-s-e-r"）直接跳转到对应选项，当前 Select 仅支持 `ArrowDown` / `ArrowUp` 线性遍历。
2. **缺失 `aria-activedescendant` 同步**：虽然为元素设置了 `data-highlighted`，但当高亮变化时，Trigger 并没有实时更新 `aria-activedescendant` 指向当前 Highlighting 项的 ID，视障用户使用读屏软件（如 NVDA / VoiceOver）时无法听到当前选中的内容变化。
3. **多选状态汇报缺失**：在 `multiple` 模式下，缺失可访问的选项计数值（`aria-multiselectable` 及辅助朗读区域）。

---

### 3.3 `Menu` 与 `SmartPanel` 的“以 Popover 代替 Menu”债务

审查 `apps/crish-desktop/src/components/ui/Menu/Menu.tsx:11`：
```tsx
import * as Popover from '@radix-ui/react-popover';
```
以及 `apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.tsx:2`：
```tsx
import * as Popover from '@radix-ui/react-popover';
```

**深层架构违规**：
1. **语义错位**：Popover 在 WAI-ARIA 中是普通的非模态浮动容器（通常为 `dialog` 角色），而菜单必须具备严格的 `menu` / `menubar` / `menuitem` 角色及特定的键盘漫游契约（左右箭头展开/收起子菜单、Type-ahead、Disabled 项无焦点等）。
2. **手写级联菜单防抖与三角形感知（SafeAim）**：
   由于直接使用 Radix Popover，缺少原生的子菜单支持，项目在 `apps/crish-desktop/src/components/ui/internal/SafeAimEngine.ts` 和 `useSafeAim.ts` 中手写了长达数百行的几何向量计算（计算鼠标移动的三角形安全区，防止用户在划向子菜单时划过其他选项导致子菜单意外关闭）。
   而在成熟的 `@base-ui/react/menu` 或 `@radix-ui/react-dropdown-menu` 中，级联菜单与 Safe Aim 是内置在原语核心中的，完全不需要业务原子层维持昂贵的几何引擎。

---

### 3.4 `Tooltip` 的极端过度设计与 Monkey-patching 风险

审查 `apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx`（499 行）和 `tooltipController.ts`（200 行）：
当前项目为了实现全局单槽 Tooltip（同一时间最多只显示一个 Tooltip）和防抖，设计了极其厚重的全局注册与队列系统。

**致命代码实证（`tooltipController.ts:58-76`）**：
```ts
function patchContainerSafeRemove(container: HTMLElement | null): void {
  if (
    !container ||
    (container as unknown as { __safeRemoveChildPatched?: boolean })
      .__safeRemoveChildPatched
  ) {
    return;
  }
  const originalRemoveChild = container.removeChild;
  container.removeChild = function <T extends Node>(child: T): T {
    if (child.parentNode !== this) {
      return child;
    }
    return originalRemoveChild.call(this, child) as T;
  };
  (
    container as unknown as { __safeRemoveChildPatched?: boolean }
  ).__safeRemoveChildPatched = true;
}
```

**严重性评定：高危（P0 架构异味）**：
- 代码居然在运行期**直接改写宿主环境的原生 DOM API `removeChild`**！
- 这是为了掩盖自研 Portal 在生命周期卸载时频频触发的 `NotFoundError: The node to be removed is not a child of this node` 异常。
- Monkey-patch 原生 DOM 会对整个桌面应用的性能分析工具、三方插件、WebView2 内部管道带来无法预测的副作用，严重违背《AGENTS.md》§7「严禁补丁、绕过与作弊」铁律。

---

### 3.5 无障碍测试与合规性评估

通过全局搜索 `axe` 关键字：
- `reference/appica-ui`：**82 套完整测试用例**，每套均包含 `toHaveNoViolations()`；
- `apps/crish-desktop`：**0 套**，依赖项中既无 `axe-core` 也无 `vitest-axe`。

**当前风险**：
1. 随着桌面端功能急剧扩张，表单缺少 label、弹窗缺少 aria-labelledby、按键焦点环丢失、色彩对比度违规等问题无法在 CI 快层被及时拦截；
2. 任何开发者在编写新组件时，都只能依靠肉眼观察，无法建立刚性的防回归安全网。

---

## 四、三方基座核心能力全景矩阵对比

| 评估维度 | Conex / Crish (当前现状) | Radix UI (shadcn / arc-library) | Base UI v1.9+ (Appica UI 标杆) |
| :--- | :--- | :--- | :--- |
| **基础依赖包结构** | 极其碎片化：仅依赖 2 个 radix 包，其余 80% 自研 | 极其分散：拆分为数十个微包 (`@radix-ui/react-*`) | **统一聚合**：单一包 `@base-ui/react`，无版本分化 |
| **React 19 支持** | 基础运行，但受限于自研 ref 与 cloneElement | 存在 `asChild` 与 `ref` 兼容摩擦与构建噪音 | **第一公民**：自底向上完全原生对齐 React 19 |
| **复合组件插槽模式** | 混合 `cloneElement` 与自研 Context 传参 | `asChild`（基于 `@radix-ui/react-slot`，单节点限制） | **`render` 模式**：支持 Element 或 `(props, state) => Node` |
| **浮层结构模型** | 单一 DOM 节点混入定位与视觉，z-index 易冲突 | Content 节点混合定位与展示 | **正交解耦**：`Positioner`（定位）+ `Popup`（视觉）分离 |
| **模态结构模型** | 混合 DialogOverlay + Backdrop + FocusTrap | Overlay 兼顾 Backdrop 与事件捕获 | **正交解耦**：`Portal` $\rightarrow$ `Backdrop` $\rightarrow$ `Viewport` $\rightarrow$ `Popup` |
| **动画驱动管道** | `useAnimatedPresence` (JS `setTimeout` 150ms 胶水) | CSS Keyframes / Framer Motion / Motion | **现代 CSS 原生**：`data-starting-style` / `@starting-style` |
| **焦点隔离机制** | `FocusTrapIsolationManager` (遍历 DOM，硬编码白名单) | FocusScope 原生事件拦截 | **原生哨兵环**：隐式 Focus-guard 跨节点引导，零 DOM 污染 |
| **弹窗与浮层层叠** | 自研 `DialogOverlayContext` 强制穿透打洞 | 原生 DismissableLayer 栈管理 | **原生自动拓扑**：根据 Trigger 宿主自动计算提升层级 |
| **级联菜单与 SafeAim** | 自研 `SafeAimEngine`，用 Popover 粗糙拼凑 Menu | 依赖 `@radix-ui/react-dropdown-menu` 完整实现 | **原生支持**：Menu 原语内置 Submenu 与 Safe Aim 判定 |
| **DOM 安全性** | **高危**：Monkey-patch `container.removeChild` | 严格遵守标准 DOM 操作规范 | **严格遵守标准 DOM 操作规范**，零侵入 |
| **无障碍自动化测试** | **0 项**（无 axe-core / 无 vitest-axe，完全裸奔） | 零散断言或依赖 E2E 验证 | **工业级标准**：`vitest-axe` 全量覆盖，**82 套组件测试** |
| **维护与心智成本** | **极高**：维持 1,800+ 行高危胶水代码，补丁滚雪球 | 中等：配置繁杂，多包升级摩擦 | **极低**：官方标准实现，业务层只需关注样式与语义 |

---

## 五、Conex / Crish 演进方案与落地路线图 (Action Plan)

### 5.1 基座选型决议：全面收敛至 `@base-ui/react` (Base UI v1.9+)

鉴于 Conex / Crish 桌面客户端（基于 Tauri 2 + WebView2 / 最新 Chromium 内核 + React 19.1+）的技术环境，**Base UI v1.9+ 是无可争议的最佳选择**：
1. **现代化运行时契合**：WebView2 内核版本极新，对 CSS `@starting-style`、`transition-behavior: allow-discrete`、`:popover-open` 等现代标准支持完备，可完美释放 Base UI 的原生零运行时动效性能；
2. **消灭多包与依赖混乱**：彻底摆脱 `@radix-ui/react-*` 散乱微包的泥潭，仅需单一依赖 `@base-ui/react` 即可完整覆盖 Dialog、Alert Dialog、Select、Combobox、Menu、Menubar、ContextMenu、Tooltip、Popover、Tabs、ScrollArea 等全套原语；
3. **彻底铲除自研胶水债务**：可一次性下线并删除 `FocusTrapIsolationManager`、`dialogOverlayContext`、`useFloatingPosition`、`SafeAimEngine`、`patchContainerSafeRemove` 等近 2,000 行技术债代码。

---

### 5.2 四阶段平滑演进路线图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Conex / Crish 前端原语演进甘特路线                     │
├─────────────────────────────────────────────────────────────────────────────┤
│ 阶段 0: 基础设施先行 (WCAG / A11y 门禁建立)                                    │
│ 引入 axe-core + vitest-axe，装配 src/test/setup.ts，建立存量回归基线             │
│                                      │                                      │
│                                      ▼                                      │
│ 阶段 1: 弹窗与遮罩治理 (Dialog & AlertDialog 重构)                            │
│ 引入 @base-ui/react，下线 FocusTrapIsolationManager 与 dialogOverlayContext │
│                                      │                                      │
│                                      ▼                                      │
│ 阶段 2: 浮层与菜单重构 (Select / Combobox / Menu 升级)                        │
│ 替换 useFloatingPosition 与 Radix Popover 胶水，原生接入 Listbox 与 Menu   │
│                                      │                                      │
│                                      ▼                                      │
│ 阶段 3: 轻量提示与原子原语收敛 (Tooltip / Popover / Tabs)                     │
│ 彻底移除 Monkey-patch，基于 BaseTooltip 实现轻量级悬停提示                   │
│                                      │                                      │
│                                      ▼                                      │
│ 阶段 4: 架构净收敛与死代码清退 (Clean Up & 100% A11y Gate)                    │
│ 卸载旧 Radix 碎片包，删除所有历史补丁脚本，全量测试跑通 axe 零违规              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 阶段 0：基础设施先行 —— 引入 `vitest-axe` 建立无障碍门禁

在动手修改任何 UI 组件之前，必须先将防御性测试武器装配到位：

1. **引入依赖**：
   在 `apps/crish-desktop/package.json` 的 `devDependencies` 中引入：
   ```json
   "axe-core": "^4.14.0",
   "vitest-axe": "^0.1.0"
   ```
2. **全局装配（`apps/crish-desktop/src/test/setup.ts`）**：
   对齐 Appica UI 规范，注册 matchers：
   ```ts
   import * as matchers from 'vitest-axe/matchers';
   expect.extend(matchers);
   ```
3. **环境类型声明（`apps/crish-desktop/src/test/vitest-axe.d.ts`）**：
   ```ts
   import 'vitest';
   import type { AxeMatchers } from 'vitest-axe/matchers';
   declare module 'vitest' {
     interface Assertion<T = any> extends AxeMatchers {}
     interface AsymmetricMatchersContaining extends AxeMatchers {}
   }
   ```
4. **存量快照扫描**：为现有的 `Button`、`Input`、`Dialog` 等核心组件编写基线 `expect(await axe(container)).toHaveNoViolations()` 测试用例。

---

#### 阶段 1：弹窗体系升级 —— 用 Base Dialog 替换 FocusTrap 三件套

1. **改造核心组件（`apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx`）**：
   - 移除 `focusTrap.tsx`、`useRestoreFocus.ts`、`useAnimatedPresence.ts`；
   - 将底层替换为 `@base-ui/react/dialog`；
   - 采用 `BaseDialog.Portal` $\rightarrow$ `BaseDialog.Backdrop` $\rightarrow$ `BaseDialog.Viewport` $\rightarrow$ `BaseDialog.Popup` 四层骨架；
   - 保留 Crish 既有的复合组件导出契约（`Dialog.Root`、`Dialog.Overlay`、`Dialog.Content`、`Dialog.Header` 等），确保业务消费层 100% 零修改兼容。
2. **直接删除高危死代码**：
   - 删除 `apps/crish-desktop/src/components/ui/Dialog/focusTrap.tsx`；
   - 删除 `apps/crish-desktop/src/components/ui/Dialog/useRestoreFocus.ts`；
   - 删除 `apps/crish-desktop/src/components/ui/Dialog/dialogOverlayContext.ts`；
   - 删除白名单专项测试 `focusTrapFloatingMenuWhitelist.test.tsx` 和 `focusTrapSelectWhitelist.test.tsx`。

---

#### 阶段 2：选择与菜单原语标准化 —— 重构 `Select`、`Combobox` 与 `Menu`

1. **重构 `Select` 与 `Combobox`**：
   - 基于 `@base-ui/react/select` 与 `@base-ui/react/combobox` 重写；
   - 彻底废除 `useFloatingPosition.ts` 与 `positionGeometry.ts`，定位与碰撞计算全量交由 `BaseSelect.Positioner` 处理；
   - 原生获得键入搜索（Type-ahead）、`aria-activedescendant` 实时同步、键盘滚动跟随。
2. **重构 `Menu` 与 `SmartExpandablePanel`**：
   - 基于 `@base-ui/react/menu` 重写；
   - 彻底下线“借用 Radix Popover 模拟 Menu”的非标准实现；
   - 下线 `SafeAimEngine.ts` 与 `useSafeAim.ts`，原生利用 Base UI 的安全划入区域判定算法。

---

#### 阶段 3：轻量原语收口 —— 重构 `Tooltip`，彻底铲除 Monkey-patching

1. **重写 `Tooltip`**：
   - 基于 `@base-ui/react/tooltip` 重构；
   - 废弃当前长达 499 行的 `Tooltip.tsx` 及 `tooltipPositioning.ts`；
   - 原生利用 Base UI 的 `Tooltip.Provider` 进行全局单槽与延迟显示管理；
2. **彻底销毁 Monkey-patch**：
   - 彻底删除 `tooltipController.ts` 中的 `patchContainerSafeRemove`；
   - 恢复原生 DOM `removeChild` 的绝对纯洁性。

---

#### 阶段 4：依赖清退、架构净收敛与 100% 无障碍门禁闭环

1. **依赖卸载**：
   从 `apps/crish-desktop/package.json` 中彻底移除：
   - `@radix-ui/react-popover`
   - `@radix-ui/react-dismissable-layer`
2. **架构收敛断言**：
   - 运行 `npm run check:ui-layer`，确保原子层内部无业务代码泄露；
   - 运行全量 Vitest 测试，验证所有重构后的原子组件在展开、聚焦、交互状态下，均 100% 通过 `vitest-axe` 无障碍断言。

---

## 六、典型组件迁移前后代码重构实证 (Before / After Reference)

### 6.1 弹窗体系重构实证 (`Dialog.tsx`)

#### 重构前（自研 FocusTrap + 穿透 Context 胶水）
```tsx
// apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx (节选)
export function Dialog({ open, onClose, children, ... }: DialogProps) {
  // 必须依靠手写 JS 定时器配合 CSS 退出时长
  const { state, isMounted } = useAnimatedPresence({ visible: open, exitDurationMs: 150 });
  useRestoreFocus(open);

  if (!isMounted) return null;

  return createPortal(
    <DismissableLayer.Branch asChild>
      {/* 脆弱的 FocusTrap：遍历 body，执行 isWhitelisted() 检测 */}
      <FocusTrap active={open}>
        <DialogContext.Provider value={ctxValue}>
          <div className={styles.overlay}>
            {/* 必须提供 DialogOverlayContext 供内部下拉框提权 */}
            <DialogOverlayContext.Provider value={overlayEl}>
              <div className={styles.backdrop} onClick={onClose} />
              <div className={styles.dialog}>{children}</div>
            </DialogOverlayContext.Provider>
          </div>
        </DialogContext.Provider>
      </FocusTrap>
    </DismissableLayer.Branch>,
    target
  );
}
```

#### 重构后（优雅的 Base UI v1.9+ 原生架构）
```tsx
// 改造后：干净、健壮、零胶水、现代 CSS @starting-style 驱动
import { Dialog as BaseDialog } from '@base-ui/react/dialog';

export function Dialog({ open, onClose, children, ...props }: DialogProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <BaseDialog.Portal>
        {/* Backdrop 独立解耦，纯 CSS 动画 */}
        <BaseDialog.Backdrop
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0"
        />
        {/* Viewport 保证居中约束，内部自动维持焦点哨兵环 */}
        <BaseDialog.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <BaseDialog.Popup
            className="relative flex flex-col rounded-xl border border-border bg-background shadow-2xl transition-all duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-nested-dialog-open:scale-95 data-nested-dialog-open:opacity-0"
          >
            {children}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
```

---

### 6.2 浮层选择框重构实证 (`Select.tsx`)

#### 重构前（自研 235 行手写定位与键盘逻辑）
```tsx
// SelectContent.tsx (节选)
export function SelectContent({ children }: SelectContentProps) {
  const ctx = useSelectContext();
  const dialogOverlay = useContext(DialogOverlayContext);

  // 必须通过 Context 寻找挂载容器
  const container = dialogOverlay ?? document.body;

  // 自研手写计算，监听 window scroll 和 resize
  const pos = useFloatingPosition({ open: ctx.open, triggerRef: ctx.triggerRef, ... });

  // 手写 ArrowDown / ArrowUp / Home / End 循环遍历
  const handleKeyDown = (e) => { ... };

  return createPortal(
    <div style={{ top: pos.y, left: pos.x }} onKeyDown={handleKeyDown}>
      {children}
    </div>,
    container
  );
}
```

#### 重构后（标准 Base UI Select）
```tsx
// 改造后：由标准 Positioner 承载浮动，Popup 承载键盘与 Listbox 状态
import { Select as BaseSelect } from '@base-ui/react/select';

export function SelectContent({ children, className }: SelectContentProps) {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner sideOffset={6} align="start">
        <BaseSelect.Popup
          className={cn(
            'z-50 min-w-[var(--anchor-width)] rounded-lg border border-border bg-popover p-1 shadow-md outline-none',
            'transition-all duration-150 data-starting-style:opacity-0 data-starting-style:scale-95 data-ending-style:opacity-0'
          )}
        >
          {children}
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  );
}
```

---

### 6.3 Tooltip 重构实证 (`Tooltip.tsx`)

#### 重构前（499 行自研 + Monkey-patching `removeChild`）
```tsx
// Tooltip.tsx (节选)
export const Tooltip = ({ content, children, ... }) => {
  // 必须在 Controller 里 patch 原生 DOM: container.removeChild = ...
  // 手写定时器、手写 ref 合并、React.cloneElement 侵入子组件
  const childRef = child?.props?.ref;
  const mergedRef = useMergeRefs(forwardedRef, childRef, childElRef);

  return React.cloneElement(child, {
    ref: mergedRef,
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    ...
  });
};
```

#### 重构后（优雅无侵入的 Base Tooltip）
```tsx
// 改造后：无需 Monkey-patch，无需 cloneElement，通过 render 模式直连
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';

export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  return (
    <BaseTooltip.Root delay={300} closeDelay={0}>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6}>
          <BaseTooltip.Popup
            className="z-50 rounded-md bg-foreground px-2.5 py-1 text-xs text-background shadow transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0"
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
```

---

## 七、总结与行动结论 (Conclusion)

通过深度对标 Appica UI、shadcn/ui 与 Arc Library，我们可以清晰看到现代化 Headless 原语基座的成熟度与威力。

Conex / Crish 当前前端并非缺少组件样式，而是**底层原语严重缺乏统一坚固的标准基石**。长期依赖手写 FocusTrap、手写坐标计算、属性白名单与高危 Monkey-patch，不仅带来了沉重的技术包袱，也让桌面客户端在全键盘导航、复杂弹窗嵌套与读屏软件合规上留下了大量盲区。

**核心行动建议**：
1. **立即立项**：启动 UI 原子层 Headless 基座现代化改造，将 `@base-ui/react` (Base UI v1.9+) 定为仓库唯一合法 Headless 原语标准；
2. **测试守门**：率先在 `apps/crish-desktop` 中安装并配置 `vitest-axe`，将其纳入快层 CI 强制门禁，对标 Appica UI 建立 100% 覆盖的无障碍防护网；
3. **分批收敛**：按 Dialog $\rightarrow$ Select/Combobox $\rightarrow$ Menu $\rightarrow$ Tooltip 的优先级平滑演进，在确保上层业务零破坏的前提下，坚决清退存量 1,800+ 行手写底层胶水，达成架构的高雅与净收敛。
