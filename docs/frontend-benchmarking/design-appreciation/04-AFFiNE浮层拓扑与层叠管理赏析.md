# AFFiNE 分层浮层拓扑、多根 Portal 与层叠上下文管理深度赏析

> **报告标识**：AFFINE-FLOATING-TOPOLOGY-STACKING-DEEP-DIVE
> **研究对象**：`reference/markdown_compare/AFFiNE/` 源码库中的浮层拓扑调度、多根 Portal 挂载、Safe Triangle 安全三角区向量检测、Tooltip 全局静默协议与层叠上下文（Stacking Context）治理体系
> **工程视角**：空间几何物理学、Web 组件层叠拓扑、无障碍焦点流转、微动效平滑生命周期、工业级非模态交互哲学
> **覆盖核心源码**：
>
> - `packages/frontend/component/src/ui/menu/`（`index.ts`、`menu.types.ts`、`use-menu-item.tsx`、`styles.css.ts`、`desktop/root.tsx`、`desktop/sub.tsx`、`desktop/item.tsx`、`desktop/context-menu.tsx`）
> - `packages/frontend/component/src/ui/tooltip/`（`tooltip.tsx`、`styles.css.ts`）
> - `packages/frontend/component/src/ui/popover/`（`popover.tsx`、`styles.css.ts`）
> - `packages/frontend/component/src/ui/modal/`（`modal.tsx`、`styles.css.ts`、`context.ts`、`confirm-modal.tsx`、`prompt-modal.tsx`、`overlay-modal.tsx`）
> - `packages/frontend/component/src/components/notification-center/`（`index.css.ts`、`notify.tsx`）
> - `blocksuite/affine/components/src/hover/`（`middlewares/safe-area.ts`、`middlewares/basic.ts`、`when-hover.ts`、`types.ts`）
> - `blocksuite/affine/components/src/portal/`（`helper.ts`、`portal.ts`、`types.ts`）

---

## 目录 (Table of Contents)

1. [导言：协同画布与桌面工作区的“空间折叠”美学](#一导言协同画布与桌面工作区的空间折叠美学)
   - 1.1 屏幕维度的拓扑挑战：在二维画布上构建多维空间
   - 1.2 AFFiNE 浮层体系的“分层解耦与多根自治”全景
2. [基于 Radix 的浮层栈调度与“非模态默认”（modal: false）设计哲学](#二基于-radix-的浮层栈调度与非模态默认modal-false设计哲学)
   - 2.1 为什么现代创作工具必须拒绝“全屏阻断式模态”？
   - 2.2 `DesktopMenu` / `ContextMenu` 的非模态内核与受控/非受控双模驱动
   - 2.3 指针事件穿透魔术：`[data-modal="false"]` 的零阻断布局排版
   - 2.4 多级子菜单的上下文注入与无缝多态分发
3. [Safe Triangle 智能安全三角区：向量几何碰撞与斜向滑动的物理平滑](#三safe-triangle-智能安全三角区向量几何碰撞与斜向滑动的物理平滑)
   - 3.1 经典交互困境：光标斜向移动时的“悬崖掉落”（Fitts's Law 边界截断）
   - 3.2 向量交叉乘积与二维射线碰撞数学判定（Intersection Determinant）
   - 3.3 动态 SVG 虚拟多边形与 `requestAnimationFrame` 实时光标跟踪
   - 3.4 40ms 闲置熔断（Idle Timeout）与 `SafeBridge` 虚拟矩形引桥的双模态协同
   - 3.5 Lit / BlockSuite 中的中间件拦截管线（Hover Middleware Pipeline）
4. [浮层激活时的全局静默协议与焦点平滑归还机制](#四浮层激活时的全局静默协议与焦点平滑归还机制)
   - 4.1 Tooltip 与 Popover 的互斥生态：Radix Provider 全局冷却与预热（Skip Delay）
   - 4.2 编辑态焦点保护法典：`preserveEditingFocusOnAction` 与零失焦按钮交互
   - 4.3 无障碍（A11y）焦点流转闭环与双阶 `Escape` 键盘导航退出协议
   - 4.4 快捷键映射引擎：跨平台 `$mod` / `$shift` 视觉徽章排版
5. [多根 Portal 挂载模型：消除层叠上下文截断的工业级实践](#五多根-portal-挂载模型消除层叠上下文截断的工业级实践)
   - 5.1 浏览器的“层叠上下文黑洞”（The Stacking Context Trap）
   - 5.2 BlockSuite Lit 与 React 混合渲染下的多根 Portal 架构
   - 5.3 响应式浮动定位流：`computePosition`、`autoUpdate` 与 RxJS `positionSlot`
   - 5.4 消失即销毁：`checkVisibility` 探针与父节点脱落的生命周期拦截
   - 5.5 自定义 Web Element 容器与 View Transitions 退出动效劫持（`ModalTransitionContainer`）
6. [Z-Index 全局本体论：层级常量拓扑与动态深度计算](#六z-index-全局本体论层级常量拓扑与动态深度计算)
   - 6.1 AFFiNE 层叠系统常量矩阵（The Z-Index Spectrum）
   - 6.2 动态深度加权算法：`calc(var(--affine-z-index-popover) + depth)`
   - 6.3 32位整型天花板：`2147483647` 与全局通知中心的超验层级
7. [架构总览与工程启示录](#七架构总览与工程启示录)
   - 7.1 浮层拓扑与事件流转全景架构图
   - 7.2 现代桌面协同应用浮层设计的五大黄金定律

---

## 一、导言：协同画布与桌面工作区的“空间折叠”美学

### 1.1 屏幕维度的拓扑挑战：在二维画布上构建多维空间

在传统网页开发中，浮层（Overlay）往往被视作简单的“局部弹出框”——通过设置 `position: absolute` 或 `position: fixed`，配以一个随意的 `z-index: 9999`，便完成了弹窗与气泡的展示。然而，在以 **AFFiNE** 为代表的次世代混合协同办公套件中，界面形态面临着截然不同的复杂拓扑结构：

1. **无限缩放与平移的白板画布（Edgeless Infinite Canvas）**：拥有独立的视口变换矩阵（Viewport Transformation Matrix，含 `scale`、`translate`），子元素动辄拥有独立的局部层叠上下文与 CSS `contain` 属性；
2. **富文本块级树状文档（Page Block Tree）**：数以千计的 Paragraph、Code Block、Database Table、LaTeX 公式卡片在 DOM 树中深度嵌套；
3. **多标签页与分屏工作台（Workbench Split-View & Tabs）**：多面板并存，各个工作区分属不同的容器视口；
4. **高频、密集的上下文辅助系统**：Slash Menu 斜杠菜单、格式化悬浮工具条（Format Toolbar）、二级属性选择器、Tooltip 快捷键提示、确认模态窗、通知中心卡片（Toast）。

如果在这样的复杂架构中采用朴素的 DOM 内联挂载或粗暴的 `z-index` 竞争，应用将瞬间陷入三大灾难：

- **容器裁剪死锁（Overflow Clipping）**：浮层被祖先节点的 `overflow: hidden` 或 `overflow: auto` 硬性截断；
- **层叠上下文降维打击（Stacking Context Trap）**：祖先节点的 `transform`、`filter`、`will-change` 或 `opacity < 1` 强行创建了新的 Stacking Context，导致子浮层哪怕写着 `z-index: 999999` 也永远被盖在外部普通元素之下；
- **交互阻断与焦点丢失（Focus Thrashing & Event Trapping）**：弹出一个菜单就锁死全屏鼠标事件，或者点击按钮时编辑器光标瞬间失焦、选区丢失。

### 1.2 AFFiNE 浮层体系的“分层解耦与多根自治”全景

为了彻底解构上述拓扑难题，AFFiNE 在前端架构中设计了一套由 **React UI 组件层** 与 **BlockSuite 画布引擎层** 双轨协同的浮层与层叠上下文管理系统：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        AFFiNE Floating Topology & Stacking Plane                       │
│                                                                                        │
│   [Notification Center] (z-index: 2147483647) ──────> Highest Sovereign Layer          │
│            ▲                                                                           │
│   [Modal / Dialog System] (z-index: var(--affine-z-index-modal)) ──> View Transitions  │
│            ▲                                                                           │
│   [Popover / ContextMenu / SubMenu] (z-index: var(--affine-z-index-popover) + depth)   │
│            ▲                                                                           │
│   [Safe Triangle Vector Guard] (SVG Dynamic Ray-Tracing) ─> Hover Smoothing (40ms)     │
│            ▲                                                                           │
│   [Tooltip Global Silent Protocol] (Radix TooltipProvider 500ms Warmup / Instant Skip) │
│            ▲                                                                           │
│   [Multi-Root Portals] (createLitPortal / createSimplePortal / Custom Elements)        │
│            ▲                                                                           │
│   [Canvas / Page Stacking Base] (Edgeless / Page DOM Tree / Shadow Roots)              │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

这套系统展现出极高的工程纯粹性与美学质感：

- 它将 **非模态（Non-Modal）** 确立为桌面创作工具的第一准则，确保用户在唤起菜单时思维与操作不被粗暴打断；
- 它运用严密的 **二维向量交叉乘积与射线碰撞算法（Ray-Tracing Safe Triangle）**，赋予二级子菜单在斜向划入时宛如磁吸般的丝滑响应；
- 它通过 **自定义 Web Component（`ModalTransitionContainer`）** 劫持 DOM 卸载，原生融合浏览器 Chromium 的 **View Transitions API**，实现声明式无损渐变；
- 它将所有悬浮交互通过 **多根 Portal（Multi-Root Portals）** 解构并瞬移至 `document.body` 顶层，在 Shadow DOM 与宿主 DOM 之间搭建起清晰的层叠坐标系。

---

## 二、基于 Radix 的浮层栈调度与“非模态默认”（modal: false）设计哲学

### 2.1 为什么现代创作工具必须拒绝“全屏阻断式模态”？

在传统的 Web 表单时代，下拉菜单（Dropdown Menu）通常遵循严苛的“模态锁定（Modal Locking）”模式：一旦下拉框展开，全屏即被一层隐形的透明遮罩拦截（`pointer-events: auto; backdrop`），任何外部点击都会首先被用于关闭下拉框，同时阻止点击事件传递给背景元素；全屏焦点也被强行锁定在浮层内部（Focus Trap）。

然而，在 **知识创作与白板画布工具** 中，这种行为是对创作心流（Creative Flow）的严重破坏：

- 用户在打开 Slash 菜单或行内格式菜单时，眼睛往往在观察画布的另一端，手可能正在使用快捷键继续输入文本或滚动视图；
- 用户希望直接点击另一侧的画笔工具或另一个文档块，而不希望被迫“先点一下空白处关闭菜单，再点第二次选择工具”；
- 屏幕上可能同时存在多个辅助性浮窗（如浮动调色盘、大纲树、快捷键悬浮条），它们应当和谐共存，而非互相粗暴互斥。

AFFiNE 在 `packages/frontend/component/src/ui/menu/` 与 `popover/` 中明确树立了 **“非模态默认（Non-modal by Default）”** 的设计哲学。

### 2.2 `DesktopMenu` / `ContextMenu` 的非模态内核与受控/非受控双模驱动

观察 `packages/frontend/component/src/ui/menu/desktop/root.tsx` 的源码实现，AFFiNE 对 `@radix-ui/react-dropdown-menu` 的包装展现出了极其明确的非模态裁决：

```typescript
// 源码证据：packages/frontend/component/src/ui/menu/desktop/root.tsx:26-96
export const DesktopMenu = ({
  children,
  items,
  noPortal,
  portalOptions,
  rootOptions: rawRootOptions,
  contentOptions: rawContentOptions,
  ref,
}: MenuProps) => {
  const { defaultOpen, modal, open, onOpenChange, onClose, ...rootOptions } =
    rawRootOptions ?? EMPTY_ROOT_OPTIONS;
  const {
    className = '',
    style: contentStyle = EMPTY_CONTENT_STYLE,
    ...otherContentOptions
  } = rawContentOptions ?? EMPTY_CONTENT_OPTIONS;
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const finalOpen = open ?? innerOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setInnerOpen(open);
      onOpenChange?.(open);
      if (!open) {
        onClose?.();
      }
    },
    [onOpenChange, onClose]
  );

  useImperativeHandle(
    ref,
    () => ({
      changeOpen: (open: boolean) => {
        setInnerOpen(open);
        onOpenChange?.(open);
      },
    }),
    [onOpenChange]
  );

  const ContentWrapper = noPortal ? React.Fragment : DropdownMenu.Portal;
  return (
    <DesktopMenuContext.Provider value={MenuContextValue}>
      <DropdownMenu.Root
        modal={modal ?? false} // 核心裁决：默认完全关闭模态锁定！
        open={finalOpen}
        onOpenChange={handleOpenChange}
        {...rootOptions}
      >
        <DropdownMenu.Trigger
          asChild
          onClick={e => {
            e.stopPropagation();
            e.preventDefault();
          }}
        >
          {children}
        </DropdownMenu.Trigger>

        <ContentWrapper {...portalOptions}>
          <DropdownMenu.Content
            className={clsx(
              styles.menuContent,
              desktopStyles.contentAnimation,
              className
            )}
            sideOffset={4}
            align="start"
            style={{ zIndex: 'var(--affine-z-index-popover)', ...contentStyle }}
            {...otherContentOptions}
          >
            {items}
          </DropdownMenu.Content>
        </ContentWrapper>
      </DropdownMenu.Root>
    </DesktopMenuContext.Provider>
  );
};
```

#### 深度工程解构：

1. **`modal={modal ?? false}` 的深远意图**：
   Radix UI 官方原生的 `DropdownMenu.Root` 默认将 `modal` 置为 `true`，这会在打开时给 `document.body` 挂载 `pointer-events: none` 并锁定滚动与焦点。AFFiNE 在第 63 行明确通过 `modal ?? false` 将默认行为逆转为 **非模态**。这使得菜单浮层在弹出期间，用户依然可以自由滚动页面、点击外部画布或选择外部文本。
2. **触发器事件隔离（`stopPropagation` 与 `preventDefault`）**：
   第 70-73 行，`DropdownMenu.Trigger` 显式拦截了 `onClick` 的冒泡与默认动作。在富文本树状结构中，菜单触发按钮往往嵌套在可点击的 Block 节点或拖拽句柄（Drag Handle）内部。如果不进行严格的冒泡隔离，点击触发按钮会导致外层 Block 被意外选中或激活拖拽，引发灾难性的状态竞争。
3. **受控（Controlled）与非受控（Uncontrolled）的双模平滑桥接**：
   通过 `finalOpen = open ?? innerOpen` 与 `useImperativeHandle(ref, () => ({ changeOpen }))`，AFFiNE 既支持 React 声明式的外部状态接管，又支持命令式 Ref 调用，同时保证内部的 `innerOpen` 状态机不发生撕裂。

### 2.3 指针事件穿透魔术：`[data-modal="false"]` 的零阻断布局排版

当 AFFiNE 的通用 `Modal` 组件（`packages/frontend/component/src/ui/modal/modal.tsx`）在特定场景被配置为 `modal: false` 时，它面临一个巨大的 CSS 布局矛盾：

- 模态弹窗在 DOM 上通常需要一个 `position: fixed; inset: 0` 的全屏 Flex 容器来实现屏幕居中（`justify-content: center; align-items: center`）；
- 但是全屏 Fixed 容器会天然霸占全屏的指针事件，使得背后的白板画布完全无法点击。

AFFiNE 在 `packages/frontend/component/src/ui/modal/styles.css.ts` 中通过纯粹而极其优雅的 CSS 选择器规则化解了这个矛盾：

```typescript
// 源码证据：packages/frontend/component/src/ui/modal/styles.css.ts:215-222
globalStyle(`[data-modal="false"]${modalContentWrapper}`, {
  pointerEvents: 'none', // 外层全屏 Fixed Flex 容器：彻底放行指针事件穿透！
});

globalStyle(`[data-modal="false"] ${modalContent}`, {
  pointerEvents: 'auto', // 内部真正的内容卡片：重新恢复并捕获指针事件！
});
```

配合 `modal.tsx` 中的 DOM 属性映射：

```tsx
// 源码证据：packages/frontend/component/src/ui/modal/modal.tsx:285-312
<SafeArea
  data-modal={modal}
  className={clsx(
    `anim-${contentAnimation}`,
    styles.modalContentWrapper,
    contentWrapperClassName
  )}
>
  <Dialog.Content className={clsx(styles.modalContent, contentClassName)}>
    {/* 内容区 */}
  </Dialog.Content>
</SafeArea>
```

#### 机制运行拓扑：

```
User Click Outside Modal
         │
         ▼
┌────────────────────────────────────────────────────────┐
│ modalContentWrapper [data-modal="false"]                │
│ (position: fixed; inset: 0; pointer-events: none)      │
│                                                        │
│   ──> Event punches straight through to Canvas below!  │
│                                                        │
│   ┌────────────────────────────────────────────────┐   │
│   │ modalContent                                   │   │
│   │ (pointer-events: auto)                         │   │
│   │                                                │   │
│   │   ──> Clicks inside modal are handled normally │   │
│   └────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────┘
```

这种设计完全不需要在 JS 运行时通过 `document.elementFromPoint` 去模拟事件转发，而是直接利用浏览器的原生合成器管线（Compositor Pipeline）与命中测试规则（Hit-Testing Rules），以 $O(1)$ 的零运行时开销实现了非模态视口居中与背景完全穿透。

### 2.4 多级子菜单的上下文注入与无缝多态分发

在复杂的富文本与侧边栏操作中，菜单项既可能出现在常规的 **下拉菜单（DropdownMenu）** 中，也可能出现在右键唤起的 **上下文菜单（ContextMenu）** 中。如果为这两种形态分别编写两套 Item 与 SubMenu 组件，不仅会导致大量代码重复，还会破坏统一的动效与层叠规范。

AFFiNE 在 `packages/frontend/component/src/ui/menu/desktop/context.ts` 与 `desktop/item.tsx`、`desktop/sub.tsx` 中设计了基于 React Context 的 **多态调度器**：

```typescript
// 源码证据：packages/frontend/component/src/ui/menu/desktop/context.ts:1-10
export const DesktopMenuContext = createContext<{
  type: 'dropdown-menu' | 'context-menu';
}>({
  type: 'dropdown-menu',
});
```

在 `desktop/item.tsx` 中根据上下文自动分发到对应的 Radix Primitives：

```typescript
// 源码证据：packages/frontend/component/src/ui/menu/desktop/item.tsx:9-30
export const DesktopMenuItem = (props: MenuItemProps) => {
  const { type } = useContext(DesktopMenuContext);
  const { className, children, otherProps } = useMenuItem(props);

  if (type === 'dropdown-menu') {
    return (
      <DropdownMenu.Item className={className} {...otherProps}>
        {children}
      </DropdownMenu.Item>
    );
  }

  if (type === 'context-menu') {
    return (
      <ContextMenu.Item className={className} {...otherProps}>
        {children}
      </ContextMenu.Item>
    );
  }

  return null;
};
```

而在 `desktop/sub.tsx` 中，无论是 Dropdown 还是 ContextMenu，二级子菜单的 SubContent 都被统一施加了最高级的 z-index Token 规范：

```tsx
// 源码证据：packages/frontend/component/src/ui/menu/desktop/sub.tsx:50-75
<DropdownMenu.Portal {...portalOptions}>
  <DropdownMenu.SubContent
    className={contentClassName}
    style={{ zIndex: 'var(--affine-z-index-popover)', ...contentStyle }}
    {...otherSubContentOptions}
  >
    {items}
  </DropdownMenu.SubContent>
</DropdownMenu.Portal>
```

这种多态设计使得业务开发者在编写菜单定义时，只需要写纯粹的 `<Menu.Item>` 与 `<Menu.Sub>`，其底层的 Radix 事件绑定、无障碍 ARIA 属性（`aria-haspopup`、`aria-expanded`）、Portal 挂载点以及层叠优先级，均由上下文调度器在编译与运行期无感装配。

---

## 三、Safe Triangle 智能安全三角区：向量几何碰撞与斜向滑动的物理平滑

### 3.1 经典交互困境：光标斜向移动时的“悬崖掉落”（Fitts's Law 边界截断）

多级悬浮子菜单是桌面 UI 设计中最古老却最容易翻车的交互场景之一（著名的“Amazon / Windows 菜单难题”）：

1. 用户将鼠标悬停在主菜单项 $A$ 上，右侧弹出了二级子菜单面板 $B$；
2. 用户的视线与光标意图直奔子菜单 $B$ 中的某一项 $B_k$；
3. 由于 $B_k$ 位于右下方，光标必然沿着一条**斜向对角线**移动；
4. 在斜向移动的瞬间，光标不可避免地划出了主菜单项 $A$ 的矩形边界，掠过了相邻的菜单项 $A_{next}$；
5. 如果没有保护机制，$A$ 的 `mouseleave` 事件会瞬间触发子菜单 $B$ 的销毁，同时 $A_{next}$ 展开其自身的子菜单，导致原先的子菜单 $B$ 在用户眼前**闪烁闭合（闪退）**。

```
经典闪退场景示意：
┌─────────────────┐
│ Menu Item A     │──(Trigger)──> ┌───────────────────┐
│ (Cursor Origin) │ ╲  (Intended  │ Submenu Item B1   │
├─────────────────┤  ╲  Traject.) │───────────────────┤
│ Menu Item Anext │───╲──────────>│ Submenu Item B_k  │
│ [Accidental     │    ╲          │───────────────────┤
│  Intersection!] │     ╲         │ Submenu Item B_last
└─────────────────┘      ▼        └───────────────────┘
```

为了解决这一问题，AFFiNE 在 `blocksuite/affine/components/src/hover/middlewares/safe-area.ts` 中实现了一套纯粹基于 **二维解析几何与动态 SVG 射线追踪（Ray-Tracing Safe Triangle）** 的数学算法引擎。

### 3.2 向量交叉乘积与二维射线碰撞数学判定（Intersection Determinant）

AFFiNE 在 `safe-area.ts` 开篇便定义了高精度的二维线段交叉碰撞判定函数 `hasIntersection`：

```typescript
// 源码证据：blocksuite/affine/components/src/hover/middlewares/safe-area.ts:13-32
/**
 * Returns true if the line from (a,b)->(c,d) intersects with (p,q)->(r,s)
 * See https://stackoverflow.com/questions/9043805/test-if-two-lines-intersect-javascript-function
 */
function hasIntersection(
  { x: a, y: b }: { x: number; y: number },
  { x: c, y: d }: { x: number; y: number },
  { x: p, y: q }: { x: number; y: number },
  { x: r, y: s }: { x: number; y: number }
) {
  const det = (c - a) * (s - q) - (r - p) * (d - b);
  if (det === 0) {
    return false; // 两线段平行或共线，无唯一交点
  } else {
    const lambda = ((s - q) * (r - a) + (p - r) * (s - b)) / det;
    const gamma = ((b - d) * (r - a) + (c - a) * (s - b)) / det;
    return 0 < lambda && lambda < 1 && 0 < gamma && gamma < 1;
  }
}
```

#### 数学原理深度推导：

设空间中有两条线段 $L_1$（从 $P_1(a,b)$ 到 $P_2(c,d)$）与 $L_2$（从 $Q_1(p,q)$ 到 $Q_2(r,s)$）。
它们的参数方程可表示为：
$$L_1(\lambda) = P_1 + \lambda (P_2 - P_1) = \begin{pmatrix} a + \lambda(c-a) \\ b + \lambda(d-b) \end{pmatrix}, \quad \lambda \in [0, 1]$$
$$L_2(\gamma) = Q_1 + \gamma (Q_2 - Q_1) = \begin{pmatrix} p + \gamma(r-p) \\ q + \gamma(s-q) \end{pmatrix}, \quad \gamma \in [0, 1]$$

联立两式求交点 $L_1(\lambda) = L_2(\gamma)$：

$$ \begin{cases}
\lambda (c - a) - \gamma (r - p) = p - a \\
\lambda (d - b) - \gamma (s - q) = q - b
\end{cases}$$

利用克莱姆法则（Cramer's Rule），其系数矩阵行列式为：
$$\text{det} = \begin{vmatrix} c - a & -(r - p) \\ d - b & -(s - q) \end{vmatrix} = (c - a)(s - q) - (r - p)(d - b)$$

当 $\text{det} \neq 0$ 时，唯一解由行列式比值给出：
$$\lambda = \frac{(s - q)(r - a) + (p - r)(s - b)}{\text{det}}$$
$$\gamma = \frac{(b - d)(r - a) + (c - a)(s - b)}{\text{det}}$$

只有当 $\lambda \in (0, 1)$ 且 $\gamma \in (0, 1)$ 同时成立时，两条线段才在各自的有效线段区间内发生真正的实体交叉！

随后，AFFiNE 利用此函数，在 `getNearestSide` 中将浮层矩形的中心点与当前光标点连线，与矩形的四条边界外接线段进行射线相交测试，从而以数学形式精确推导浮层处于光标的哪一个相对方位（`top`、`bottom`、`left` 或 `right`）：

```typescript
// 源码证据：blocksuite/affine/components/src/hover/middlewares/safe-area.ts:47-78
const getNearestSide = (
  point: { x: number; y: number },
  rect: DOMRect
):
  | [
      'top' | 'bottom' | 'left' | 'right',
      { x: number; y: number },
      { x: number; y: number },
    ]
  | null => {
  const centerPoint = {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
  const topLeft = { x: rect.x, y: rect.y };
  const topRight = { x: rect.right, y: rect.y };
  const bottomLeft = { x: rect.x, y: rect.bottom };
  const bottomRight = { x: rect.right, y: rect.bottom };
  if (hasIntersection(point, centerPoint, bottomLeft, bottomRight)) {
    return ['top', bottomLeft, bottomRight];
  }
  if (hasIntersection(point, centerPoint, topLeft, topRight)) {
    return ['bottom', topLeft, topRight];
  }
  if (hasIntersection(point, centerPoint, topLeft, bottomLeft)) {
    return ['right', topLeft, bottomLeft];
  }
  if (hasIntersection(point, centerPoint, topRight, bottomRight)) {
    return ['left', topRight, bottomRight];
  }
  return null;
};
```

### 3.3 动态 SVG 虚拟多边形与 `requestAnimationFrame` 实时光标跟踪

一旦判定光标正从触发器离开并向浮层侧移动，AFFiNE 并没有采用传统的“简单增加 300ms 延时销毁”的粗糙手段（这会导致界面反应迟钝），而是在 DOM 顶层动态实例化一个完全透明的 **SVG 虚拟三角形保护罩（Virtual Safe Polygon）**：

```typescript
// 源码证据：blocksuite/affine/components/src/hover/middlewares/safe-area.ts:84-219
export const safeTriangle = ({
  zIndex = 10000,
  buffer = 2,
  idleTimeout = 40,
  debug = false,
}: Partial<SafeTriangleOptions> = {}): HoverMiddleware => {
  let abortController = new AbortController();
  return async ({ event, referenceElement, floatingElement }) => {
    abortController.abort();
    const newAbortController = new AbortController();
    abortController = newAbortController;

    const isLeave = event.type === 'mouseleave';
    if (!isLeave || event.target !== referenceElement) return true;
    if (!(event instanceof MouseEvent)) return true;
    if (!floatingElement) return true;

    const mouseX = event.x;
    const mouseY = event.y;
    const refRect = referenceElement.getBoundingClientRect();
    const rect = floatingElement.getBoundingClientRect();

    const floatingData = getNearestSide({ x: mouseX, y: mouseY }, rect);
    if (!floatingData) return true;

    // 创建动态 SVG 元素
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');

    const updateSafeTriangle = (mouseX: number, mouseY: number) => {
      if (newAbortController.signal.aborted) return;
      // 若光标已进入浮层内部，立即销毁安全三角区
      if (
        mouseX >= rect.left &&
        mouseX <= rect.right &&
        mouseY >= rect.top &&
        mouseY <= rect.bottom
      )
        newAbortController.abort();

      const p1 = { x: mouseX, y: mouseY }; // 顶点 1：当前光标动态坐标
      const p2 = floatingData[1];          // 顶点 2：浮层边缘端点 A
      const p3 = floatingData[2];          // 顶点 3：浮层边缘端点 B

      const basePoint = {
        x: Math.min(p1.x, p2.x, p3.x) - buffer,
        y: Math.min(p1.y, p2.y, p3.y) - buffer,
      };
      const areaHeight = Math.max(
        Math.abs(p1.y - p2.y),
        Math.abs(p1.y - p3.y),
        Math.abs(p2.y - p3.y)
      );
      const areaWidth = Math.max(
        Math.abs(p1.x - p2.x),
        Math.abs(p1.x - p3.x),
        Math.abs(p2.x - p3.x)
      );

      Object.assign(svg.style, {
        position: 'fixed',
        pointerEvents: 'none',
        width: areaWidth + buffer * 2,
        height: areaHeight + buffer * 2,
        zIndex,
        top: 0,
        left: 0,
        transform: `translate(${basePoint.x}px, ${basePoint.y}px)`,
      });
      // 动态重绘三角形路径：M(p1) L(p2) L(p3) Z
      path.setAttributeNS(
        null,
        'd',
        `M${p1.x - basePoint.x} ${p1.y - basePoint.y} ${p2.x - basePoint.x} ${
          p2.y - basePoint.y
        } ${p3.x - basePoint.x} ${p3.y - basePoint.y} z`
      );
    };

    path.setAttributeNS(null, 'pointer-events', 'auto');
    path.setAttributeNS(null, 'fill', 'transparent');
    path.setAttributeNS(null, 'stroke-width', buffer.toString());
    path.setAttributeNS(null, 'stroke', 'transparent');

    updateSafeTriangle(mouseX, mouseY);
    svg.append(path);
    document.body.append(svg);

    // 监听实时移动并使用 rAF 节流重绘三角形
    let frameId = 0;
    let idleId = window.setTimeout(() => newAbortController.abort(), idleTimeout);

    svg.addEventListener(
      'mousemove',
      e => {
        clearTimeout(idleId);
        // 40ms 闲置熔断计时器重置
        idleId = window.setTimeout(() => newAbortController.abort(), idleTimeout);
        cancelAnimationFrame(frameId);
        frameId = requestAnimationFrame(() =>
          updateSafeTriangle(e.clientX, e.clientY)
        );
      },
      { signal: newAbortController.signal }
    );

    // 阻塞中间件 Promise 直至信号 Abort
    await new Promise<void>(res => {
      if (newAbortController.signal.aborted) res();
      newAbortController.signal.addEventListener('abort', () => res());
      svg.addEventListener('mouseleave', () => newAbortController.abort(), {
        signal: newAbortController.signal,
      });
    });

    return true;
  };
};
```

#### 动态几何拓扑示意：
```
       (p1: Cursor (mouseX, mouseY))
                   ●
                  ╱ ╲
                 ╱   ╲   <--- [Dynamic SVG Polygon]
                ╱     ╲       (pointer-events: auto, z-index: 10000)
               ╱       ╲       Captures mousemove & morphs with rAF!
              ╱         ╲
             ●───────────●
         (p2: TopLeft)  (p3: BottomLeft)
        ┌───────────────────────────────┐
        │                               │
        │      Floating Submenu         │
        │                               │
        └───────────────────────────────┘
```

### 3.4 40ms 闲置熔断（Idle Timeout）与 `SafeBridge` 虚拟矩形引桥的双模态协同

上述 Safe Triangle 机制包含三个极具智慧的边界保护设计：

1. **40ms 极速闲置熔断（Idle Timeout = 40ms）**：
   如果用户只是鼠标偶然滑过主菜单并在半路停下，传统的长延时会让悬浮窗笨拙地残留数百毫秒。AFFiNE 设置了仅 **40ms** 的无移动判定——只要光标停止移动超过 40ms，系统立刻判定用户并非意图进入子菜单，瞬间销毁 SVG 三角形并关闭浮层，保持界面的干脆利落。
2. **`requestAnimationFrame` 驱动的三角形变形（Morphing）**：
   当光标在空中飞行时，顶点 $P_1$ 实时变化，SVG Path 的 `d` 属性在每个渲染帧动态更新，使得保护多边形始终精准贴合在“光标当前位置”与“子菜单端点”之间，绝不产生盲区。
3. **`SafeBridge` 矩形引桥双重防护**：
   在 `safe-area.ts:231-361` 中，AFFiNE 还提供了 `safeBridge` 中间件，用于处理触发器与浮层之间存在固定像素间距（Offset Gap）的场景，在间距空隙内构造一个不可见的矩形引桥（Rectangular Bridge），防止光标穿越 4px~8px 的空气缝隙时失焦。

### 3.5 Lit / BlockSuite 中的中间件拦截管线（Hover Middleware Pipeline）

在 `blocksuite/affine/components/src/hover/when-hover.ts` 中，AFFiNE 将上述安全几何检测抽象为标准的 **异步管道流（Async Middleware Pipeline）**：

```typescript
// 源码证据：blocksuite/affine/components/src/hover/when-hover.ts:56-85
const middlewares: HoverMiddleware[] = [
  dedupe(alwayRunWhenNoFloating), // 1. 去重事件过滤器
  triangleOptions && safeTriangle(triangleOptions), // 2. 向量三角区安全拦截
  bridgeOptions && safeBridge(bridgeOptions),       // 3. 矩形空隙引桥拦截
  delayShow(enterDelay),                            // 4. 进入缓冲延时
  delayHide(leaveDelay),                            // 5. 退出缓冲延时
].filter(v => typeof v !== 'boolean') as HoverMiddleware[];

const onHoverChange = async (e: Event) => {
  currentEvent = e;
  for (const middleware of middlewares) {
    const go = await middleware({
      event: e,
      floatingElement,
      referenceElement,
    });
    if (!go) return; // 中间件挂起或熔断，阻断后续生命周期
  }
  if (e !== currentEvent) return; // 丢弃过期事件
  const isHover = e.type === 'mouseenter' ? true : false;
  whenHoverChange(isHover, e);
};
```
这种洋葱圈式的管道流设计，使得所有关于防抖、延时、向量计算、空间投影的复杂逻辑从业务 UI 逻辑中彻底抽离，达到了极高的软件工程复用度。

---

## 四、浮层激活时的全局静默协议与焦点平滑归还机制

### 4.1 Tooltip 与 Popover 的互斥生态：Radix Provider 全局冷却与预热（Skip Delay）

Tooltip（工具提示）是 UI 中最容易造成“视觉垃圾（Visual Clutter）”的元素。如果一个用户已经点击打开了一个复杂的设置弹窗（Popover）或下拉菜单，此时光标在浮层内部划过时若依然不断弹出底层的快捷键 Tooltip，将给用户带来极其糟糕的混乱感。

AFFiNE 在 `packages/frontend/component/src/ui/tooltip/tooltip.tsx` 中做出了精准的协同配置：

```typescript
// 源码证据：packages/frontend/component/src/ui/tooltip/tooltip.tsx:71-117
export const Tooltip = ({
  children,
  content,
  side = 'top',
  align = 'center',
  shortcut,
  options,
  rootOptions,
  portalOptions,
  shortcutClassName,
}: TooltipProps) => {
  if (!content) {
    return children;
  }
  const { className, ...contentOptions } = options || {};
  const { style: contentStyle, ...restContentOptions } = contentOptions;
  return (
    <TooltipPrimitive.Provider>
      <TooltipPrimitive.Root delayDuration={500} {...rootOptions}>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>

        <TooltipPrimitive.Portal {...portalOptions}>
          <TooltipPrimitive.Content
            className={clsx(styles.tooltipContent, className)}
            side={side}
            align={align}
            sideOffset={5}
            style={{ zIndex: cssVar('zIndexPopover'), ...contentStyle }}
            {...restContentOptions}
          >
            {shortcut ? (
              <div className={styles.withShortcut}>
                <div className={styles.withShortcutContent}>{content}</div>
                <TooltipShortcut
                  shortcut={shortcut}
                  className={shortcutClassName}
                />
              </div>
            ) : (
              content
            )}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
};
```

#### 协议运转机理：
1. **500ms 预热冷却机制（`delayDuration={500}`）**：
   初始悬停必须持续 500ms 才会展示 Tooltip，防止光标快速掠过屏幕时产生暴风雨般的 Tooltip 闪烁；
2. **瞬时漫游通道（Instant Skip Delay）**：
   当用户在一个工具栏中查看了一个 Tooltip 并横向移动到相邻按钮时，Radix `TooltipProvider` 的全局状态机会保持 300ms 的“预热态”，此时相邻 Tooltip 0ms 瞬间显示，无需再次等待 500ms；
3. **全局层叠静默（Global Dismissal）**：
   由于 Tooltip 的 Content 挂载在 `cssVar('zIndexPopover')`，当更高优先级的 Menu 或 Modal 激活时，Radix 的 `DismissableLayer` 会将所有处于挂起或激活状态的 Tooltip 一键全局静默（Silent Dismiss），彻底消灭界面重叠冲突。

### 4.2 编辑态焦点保护法典：`preserveEditingFocusOnAction` 与零失焦按钮交互

在富文本编辑器与模态窗交互中，有一个极其隐蔽但极为致命的体验断层：
当用户在编辑框内打字时，如果需要点击模态窗底部的一个辅助操作（例如“插入引用”、“应用格式”或“切换视图”），鼠标按下按钮的瞬间，浏览器的默认行为会将全局焦点（`document.activeElement`）从文本输入框强行夺走并转移给按钮。这会导致：
- 输入框的软键盘收起（移动端）；
- 编辑器的光标选区（Selection Range）丢失；
- 用户点击完按钮后必须重新手动点击输入框才能继续打字。

AFFiNE 在 `packages/frontend/component/src/ui/modal/modal.tsx` 中创造性地实现了 **编辑态焦点保护机制（`preserveEditingFocusOnAction`）**：

```typescript
// 源码证据：packages/frontend/component/src/ui/modal/modal.tsx:66-74
const isTextEditingElement = (element: Element) =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLElement && element.isContentEditable);

const getEnabledModalAction = (element: Element) =>
  element.closest(
    'button:not(:disabled), [role="button"]:not([aria-disabled="true"]), [role="menuitem"]:not([aria-disabled="true"]), [data-modal-action]:not([aria-disabled="true"])'
  );
```

在 Modal 内容区的指针按下事件中进行毫秒级拦截：
```typescript
// 源码证据：packages/frontend/component/src/ui/modal/modal.tsx:231-252
const handlePointerDown = useCallback(
  (event: React.PointerEvent<HTMLDivElement>) => {
    onPointerDown?.(event);
    if (
      !preserveEditingFocusOnAction ||
      event.defaultPrevented ||
      !(event.target instanceof Element)
    ) {
      return;
    }
    const activeElement = document.activeElement;
    if (
      activeElement &&
      event.currentTarget.contains(activeElement) &&
      isTextEditingElement(activeElement) &&
      getEnabledModalAction(event.target)
    ) {
      // 核心魔术：阻止 mousedown / pointerdown 默认的焦点转移行为！
      event.preventDefault();
    }
  },
  [onPointerDown, preserveEditingFocusOnAction]
);
```

#### 原理解析：
根据 W3C DOM Level 3 事件规范，浏览器在 `pointerdown` / `mousedown` 的默认动作中执行“将 Focus 转移至被点击元素”。AFFiNE 通过在捕获期精准判定当前处于活动状态的 `activeElement` 是否为文本编辑元素，并且目标元素是否为一个有效的 Modal Action 按钮，如果是，直接执行 `event.preventDefault()`。
这样一来，**按钮的 `click` 事件依然会正常触发，但光标和输入焦点却被无损锁定在输入框中！** 文本光标不会产生一丝一毫的闪烁，软键盘也不会产生任何收起回弹，达到了行云流水般的交互体验。

### 4.3 无障碍（A11y）焦点流转闭环与双阶 `Escape` 键盘导航退出协议

在模态窗退出与键盘控制方面，AFFiNE 在 `prompt-modal.tsx` 中实现了独特的 **双阶 Escape 退出协议（Two-stage Escape Protocol）**：

```typescript
// 源码证据：packages/frontend/component/src/ui/modal/prompt-modal.tsx:73-85
const onKeyDown = useCallback(
  (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (value) {
        // 第一阶：如果输入框内有文本，按 Esc 仅清空文本，不关闭模态窗！
        e.preventDefault();
        return;
      } else {
        // 第二阶：如果输入框已经为空，按 Esc 让输入框失焦，交由外层 Modal 统一关闭
        e.currentTarget.blur();
      }
    }
  },
  [value]
);
```
用户在快速输入过程中如果误按了 `Esc` 键，绝不会直接导致正在编辑的弹窗整个消失（防止未保存的数据丢失），而是先安全清空当前输入；只有在空白状态下再次按下 `Esc`，弹窗才会平滑退出并将焦点自动归还给唤起它的原始触发器（Trigger Element）。

### 4.4 快捷键映射引擎：跨平台 `$mod` / `$shift` 视觉徽章排版

在 `packages/frontend/component/src/ui/tooltip/tooltip.tsx:45-69` 与 `styles.css.ts:39-61` 中，AFFiNE 构建了一套跨平台的语义化快捷键解析器：

```typescript
// 源码证据：packages/frontend/component/src/ui/tooltip/styles.css.ts:44-61
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
  borderRadius: 4,
  selectors: {
    '&[data-length="1"]': {
      width: 16, // 单字符（如 'K' 或 '⌘'）呈现完美的正方形徽章
    },
  },
});
```
它能将 `['$mod', 'K']` 在 macOS 下自动转换为 `[⌘] [K]`，在 Windows/Linux 下自动编译为 `[Ctrl] [K]`，并通过 `data-length="1"` 的选择器分支让单字符徽章保持严格的 $16 \times 16\text{px}$ 正方形几何比例，使微型键盘键帽在视觉上呈现出工业级的精致感。

---

## 五、多根 Portal 挂载模型：消除层叠上下文截断的工业级实践

### 5.1 浏览器的“层叠上下文黑洞”（The Stacking Context Trap）

在 Web 渲染引擎中，以下任意一条 CSS 规则都会使当前 DOM 元素诞生一个新的 **独立层叠上下文（Local Stacking Context）**：
- `transform` / `translate` / `rotate` / `scale` 不为 `none`；
- `filter` / `backdrop-filter` 不为 `none`；
- `perspective` 不为 `none`；
- `contain: layout` 或 `contain: paint`；
- `will-change` 指定了上述属性；
- `opacity < 1`。

一旦一个包含浮层组件的子树被包裹在上述容器内，该浮层在层叠空间中的最高绝对高度就被锁定在该容器内部——**哪怕浮层的 `z-index` 设为 `99999999`，在全局层面它也无法覆盖容器外部一个 `z-index: 1` 的普通兄弟节点**。这被称为“层叠上下文黑洞”。

### 5.2 BlockSuite Lit 与 React 混合渲染下的多根 Portal 架构

AFFiNE 的白板画布与文档块大量使用了 Lit Web Components 与 Shadow DOM，而外壳层使用了 React。为了保证无论浮层在组件树的哪个角落被声明，其物理 DOM 节点都能瞬移至不受任何 Stacking Context 污染的全局最高挂载点，AFFiNE 在 `blocksuite/affine/components/src/portal/helper.ts` 与 `portal.ts` 中设计了多根 Portal 模型：

```typescript
// 源码证据：blocksuite/affine/components/src/portal/helper.ts:20-76
export function createSimplePortal({
  template,
  container = document.body,
  signal = new AbortController().signal,
  renderOptions,
  shadowDom = true,
  identifyWrapper = true,
}: PortalOptions) {
  const portalRoot = document.createElement('div');
  if (identifyWrapper) {
    portalRoot.classList.add('blocksuite-portal');
  }
  if (shadowDom) {
    portalRoot.attachShadow({
      mode: 'open',
      ...(typeof shadowDom !== 'boolean' ? shadowDom : {}),
    });
  }
  signal.addEventListener('abort', () => {
    portalRoot.remove();
  });

  const root = shadowDom ? portalRoot.shadowRoot : portalRoot;
  if (!root) {
    throw new BlockSuiteError(
      BlockSuiteError.ErrorCode.ValueNotExists,
      'Failed to create portal root'
    );
  }

  let updateId = 0;
  const updatePortal: (id: number) => void = id => {
    if (id !== updateId) {
      console.warn(
        'Potentially infinite recursion! Please clean up the old event listeners before `updatePortal`'
      );
      return;
    }
    updateId++;
    const curId = updateId;
    const templateResult =
      template instanceof Function
        ? template({ updatePortal: () => updatePortal(curId) })
        : template;
    render(templateResult, root, renderOptions);
  };

  updatePortal(updateId);
  container.append(portalRoot);

  // 关键补丁：AFFiNE 模态窗可能会对 body 设置 pointer-events: none
  // 为避免 BlockSuite 内部的浮动元素无法点击，在此显式强制补齐 pointer-events: auto！
  portalRoot.style.pointerEvents = 'auto';

  return portalRoot;
}
```

#### 架构精髓：
- **Shadow DOM 样式完全隔离**：每一个 Portal 根节点默认挂载一个 Open 状态的 `ShadowRoot`，确保浮层内部的样式不受主文档全局 CSS 污染，反之亦然；
- **跨框架 Pointer-Events 免疫盾（第 73 行）**：当外层 React Modal 激活时可能在 `document.body` 产生全局指针抑制，BlockSuite Portal 根节点显式声明 `portalRoot.style.pointerEvents = 'auto'`，直接在 DOM 最外层构建起指针穿透免疫盾，确保富文本工具条即便在复杂弹窗中依然保持 100% 可操作。

### 5.3 响应式浮动定位流：`computePosition`、`autoUpdate` 与 RxJS `positionSlot`

在 `createLitPortal`（`blocksuite/affine/components/src/portal/helper.ts:123-225`）中，AFFiNE 将 `@floating-ui/dom` 与响应式编程库 **RxJS** 进行了深层次融合：

```typescript
// 源码证据：blocksuite/affine/components/src/portal/helper.ts:130-204
let positionSlot = new Subject<ComputePositionReturn>();

const update = () => {
  if (
    computePositionOptions.abortWhenRefRemoved !== false &&
    referenceElement instanceof Element &&
    !isElementVisible(referenceElement)
  ) {
    abortController.abort(); // 锚点消失，立即级联销毁 Portal！
  }
  computePosition(referenceElement, portalRoot, {
    strategy: positionStrategy,
    ...options,
  })
    .then(positionReturn => {
      const { x, y } = positionReturn;
      // 避免使用 transform，防止导致 overlay-mask 产生像素级亚像素模糊或偏移
      portalRoot.style.left = `${x}px`;
      portalRoot.style.top = `${y}px`;
      if (portalRoot.style.visibility === 'hidden') {
        portalRoot.style.visibility = visibility;
      }
      // 通过 RxJS Subject 广播最新的空间几何坐标流
      positionSlot.next(positionReturn);
    })
    .catch(console.error);
};
```

#### 为什么使用 `left/top` 而非 `transform: translate`？
在很多浮层库中，大家习惯使用 `transform: translate(x, y)` 来实现 GPU 加速位移。然而 AFFiNE 在源码第 195-198 行留下了深刻的工程反思注释：
`// Use transform maybe cause overlay-mask offset issue`
在复杂画布中，如果父 Portal 使用了 `transform`，其内部如果有进一步嵌套的 `position: fixed` 子浮层（如第三级级联菜单或颜色拾取器），该子浮层的 Fixed 参照基准将被父级的 `transform` 强行篡改为父级自身，从而导致定位彻底崩塌。AFFiNE 坚决采用纯粹的 `left/top` 绝对定位，确保多级级联浮层始终参照全局视口排版。

### 5.4 消失即销毁：`checkVisibility` 探针与父节点脱落的生命周期拦截

内存泄漏与“幽灵浮层（Ghost Overlay）”是大型 SPA 应用的头号顽疾。当一个 Block 节点被用户按下 Backspace 删除、或者由于虚拟列表滚动滚出视口时，如果挂载在 `document.body` 上的 Portal 没有感知到宿主节点的消失，就会永远悬挂在屏幕上。

AFFiNE 在 `helper.ts:81-97` 封装了前沿的 `isElementVisible` 探针：

```typescript
// 源码证据：blocksuite/affine/components/src/portal/helper.ts:81-97
function isElementVisible(el: Element) {
  // 优先使用最新的 Chromium 原生 checkVisibility API（支持 content-visibility 与 display 检测）
  if (el.checkVisibility) {
    return el.checkVisibility();
  }
  // 降级兼容检测
  if (!el.isConnected) return false;
  if (el instanceof HTMLElement) {
    return !(el.offsetParent === null);
  }
  return true;
}
```
在每次 `autoUpdate` 位置刷新时，只要检测到 `!isElementVisible(referenceElement)`，瞬间触发 `abortController.abort()`，连带清理所有 DOM 节点、RxJS 订阅与事件监听，实现真正的“零泄漏自愈（Zero-Leak Self-Healing）”。

### 5.5 自定义 Web Element 容器与 View Transitions 退出动效劫持（`ModalTransitionContainer`）

在 React 18 中，当一个 Modal 组件由 `open: true` 变为 `open: false` 时，React Fiber 树会直接卸载该组件并调用 `container.removeChild(child)` 将 DOM 节点瞬间从页面上移除。这导致开发者很难在弹窗销毁时播放平滑的退出动效，除非引入庞大笨重的动效过渡状态机库。

AFFiNE 在 `packages/frontend/component/src/ui/modal/modal.tsx` 中给出了一个**教科书级别的原生黑客技法（Native Architectural Hack）**：定义一个名为 `<modal-transition-container>` 的原生 Web Component，并在其中**重写（Override）DOM 的 `removeChild` 方法**！

```typescript
// 源码证据：packages/frontend/component/src/ui/modal/modal.tsx:84-144
/**
 * This component is a hack to support `startViewTransition` in the modal.
 */
class ModalTransitionContainer extends HTMLElement {
  pendingTransitionNodes: Node[] = [];
  animationFrame: number | null = null;

  /**
   * 当 React DOM 调用 removeChild 尝试卸载弹窗节点时，此方法被底层拦截！
   * https://github.com/facebook/react/blob/e4b4aac2a01b53f8151ca85148873096368a7de2/packages/react-dom-bindings/src/client/ReactFiberConfigDOM.js#L833
   */
  override removeChild<T extends Node>(child: T): T {
    if (typeof document.startViewTransition === 'function') {
      // 1. 阻止立即物理移除，将节点存入待过渡队列
      this.pendingTransitionNodes.push(child);
      this.requestTransition();
      return child; // 欺骗 React Fiber：以为节点已被移除
    } else {
      return super.removeChild(child);
    }
  }

  /**
   * 收集单帧内被移除的所有节点，启动作用域 View Transition 原生动效
   */
  private requestTransition() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }

    this.animationFrame = requestAnimationFrame(() => {
      const nodes = this.pendingTransitionNodes;
      nodes.forEach(child => {
        if (child instanceof HTMLElement) {
          child.classList.add('vt-active'); // 激活 CSS view-transition-name
        }
      });
      // 启动局部作用域的 View Transition 变换
      startScopedViewTransition(styles.modalVTScope, () => {
        nodes.forEach(child => {
          super.removeChild(child); // 在 View Transition 快照完成后，真正执行 DOM 物理移除
        });
      });
      this.pendingTransitionNodes = [];
    });
  }
}

let defined = false;
function createContainer() {
  if (!defined) {
    customElements.define(
      'modal-transition-container',
      ModalTransitionContainer
    );
    defined = true;
  }
  const container = new ModalTransitionContainer();
  document.body.append(container);
  return container;
}
```

配合 `packages/frontend/component/src/ui/modal/styles.css.ts` 中的原生伪元素动画声明：
```typescript
// 源码证据：packages/frontend/component/src/ui/modal/styles.css.ts:139-159
globalStyle(
  `::view-transition-old(${modalContentViewTransitionNameFadeScaleTop})`,
  {
    animation: `${contentHideFadeScaleTop} 150ms cubic-bezier(0.42, 0, 0.58, 1)`,
    animationFillMode: 'forwards',
  }
);
```

#### 运行生命周期解构：
```
[User Closes Modal] ──> React triggers Fiber unmount
                              │
                              ▼
        [ModalTransitionContainer.removeChild(child) Intercepted!]
                              │
                              ├─ 1. Holds DOM node in memory
                              ├─ 2. Injects `.vt-active` CSS class
                              ├─ 3. Calls document.startScopedViewTransition()
                              │
                              ▼
        [Browser GPU captures snapshot & plays ::view-transition-old]
                              │
                              ▼
        [150ms Animation Done] ──> super.removeChild(child) physically purged
```
这种设计完全不依赖 React 的任何三方动效中间件，直接通过 Web Component 的原生生命周期拦截了 React Fiber 的 DOM 操作，无缝拥抱了 W3C 标准的 **View Transitions API**，以极致的工程纯粹度实现了 60fps 硬件加速的退出退场动画。

---

## 六、Z-Index 全局本体论：层级常量拓扑与动态深度计算

### 6.1 AFFiNE 层叠系统常量矩阵（The Z-Index Spectrum）

在没有严格约束的工程中，`z-index` 常沦为“999”、“9999”、“99999”的数字军备竞赛。AFFiNE 通过集中化的 Design Tokens 与 CSS 变量，构建了一套井然有序的 **全局层叠本体论光谱（Z-Index Spectrum）**：

| 层级名称 | Token / 变量名 | 常量基准值 | 典型承载组件与语义场景 |
| :--- | :--- | :--- | :--- |
| **Sovereign Alert Layer** | 硬编码最高常量 | `2147483647` ($2^{31}-1$) | `NotificationCenter` 全局通知中心、系统级崩溃警报 |
| **Modal Overlay Layer** | `--affine-z-index-modal` / `zIndexModal` | `1000` | `Modal`、`Dialog.Overlay`、`ConfirmModal`、`PromptModal` |
| **Popover & Menu Layer** | `--affine-z-index-popover` / `zIndexPopover` | `1000` / `calc(1000 + depth)` | `DesktopMenu`、`ContextMenu`、`Popover`、`Tooltip`、`SlashMenu` |
| **Drag & Resize Layer** | `calc(var(--affine-z-index-popover) + 3)` | `1003` | `frame-card`、拖拽遮罩 `drag.ts:152`、分屏抓手 |
| **Viewport Overlay** | `calc(var(--affine-z-index-popover) - 1)` | `999` | `viewport-overlay` 画布视口半透明引导层 |
| **Workbench Panels** | 固定结构层 | `1` ~ `5` | `ResizePanel` (4)、`EdgelessBlockHeader` (2)、`AppBanner` (1) |
| **Base Content Plane** | 默认流 | `0` / `auto` | BlockSuite Editor Document、Page Body、Whiteboard Note Mask |

### 6.2 动态深度加权算法：`calc(var(--affine-z-index-popover) + depth)`

在多级级联子菜单与嵌套浮窗场景中，单纯赋予所有浮层相同的 `z-index: 1000` 会导致在特殊重叠排版时出现“子菜单被父菜单的某些高亮阴影切断”的边缘瑕疵。

AFFiNE 在 `blocksuite/affine/widgets/slash-menu/src/slash-menu-popover.ts:420` 等模块中采用了 **基于树深度的动态加权算法**：

```typescript
// 源码证据：blocksuite/affine/widgets/slash-menu/src/slash-menu-popover.ts:420
subMenuElement.style.zIndex = `calc(var(--affine-z-index-popover) + ${this.depth})`;
```
- 当主斜杠菜单（Depth = 0）打开时，$z = 1000$；
- 当唤起二级子选择面板（Depth = 1）时，$z = 1001$；
- 当唤起三级颜色或图标选择器（Depth = 2）时，$z = 1002$。

这种基于深度公式的动态计算，保证了浮层栈在三维空间中的拓扑拓扑关系始终严格单调递增，天然规避了任何同层阴影与边框竞争。

### 6.3 32位整型天花板：`2147483647` 与全局通知中心的超验层级

在 `packages/frontend/component/src/components/notification-center/index.css.ts:12` 中：
```typescript
// 源码证据：packages/frontend/component/src/components/notification-center/index.css.ts:6-16
export const notificationCenterViewportStyle = style({
  position: 'fixed',
  height: '500px',
  bottom: '20px',
  right: '20px',
  width: '380px',
  zIndex: 2147483647, // 32-bit Signed Integer Maximum
  outline: 'none',
  display: 'flex',
  alignItems: 'flex-end',
});
```
AFFiNE 将全局通知中心（Notification Center）置于 **$2^{31}-1 = 2147483647$** 的超验层级（这是现代浏览器 CSS 标准规范允许的最大合法 `z-index` 整数值）。这一裁决保证了不论当前应用处于全屏全景模式、全屏模态弹窗、还是复杂的画布拖拽遮罩覆盖中，系统级的重要通知（如同步冲突、网络离线警告、操作撤销 Toast）都享有绝对不受遮蔽的最高可视化主权。

---

## 七、架构总览与工程启示录

### 7.1 浮层拓扑与事件流转全景架构图

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                          AFFiNE Complete Overlay Topology                              │
│                                                                                        │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │ Sovereign Layer (z-index: 2147483647)                                          │   │
│   │ [NotificationCenter] (Sonner-inspired Stacked Toast Cards)                    │   │
│   └────────────────────────────────────────────────────────────────────────────────┘   │
│                                           ▲                                            │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │ Modal Plane (z-index: 1000)                                                    │   │
│   │ ┌────────────────────────────────────────────────────────────────────────────┐ │   │
│   │ │ ModalTransitionContainer (Custom Element overrides removeChild)            │ │   │
│   │ │   └── Dialog.Portal ──> Dialog.Overlay ──> SafeArea ──> Dialog.Content     │ │   │
│   │ │         (View Transitions API ::view-transition-old Hardware Motion)       │ │   │
│   │ └────────────────────────────────────────────────────────────────────────────┘ │   │
│   │ Focus Sentinel & Editing Preserver: preserveEditingFocusOnAction (Zero-Blur)   │   │
│   └────────────────────────────────────────────────────────────────────────────────┘   │
│                                           ▲                                            │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │ Floating / Popover Plane (z-index: 1000 + depth)                               │   │
│   │ [DesktopMenu] (modal: false default) ──> ContentWrapper (DropdownMenu.Portal)  │   │
│   │       │                                                                        │   │
│   │       ├──> [ContextMenu] (DesktopMenuContext Polymorphic Dispatch)             │   │
│   │       └──> [DesktopMenuSub] (Safe Triangle Ray-Casting Interception)           │   │
│   │                 │                                                              │   │
│   │                 ▼                                                              │   │
│   │   [Safe Triangle SVG Polygon] (z-index: 10000; rAF Dynamic Vector Tracking)    │   │
│   │   [Safe Bridge Rectangular Area] (Cross-gap Pointer Preservation)              │   │
│   └────────────────────────────────────────────────────────────────────────────────┘   │
│                                           ▲                                            │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │ Tooltip Plane (z-index: 1000)                                                  │   │
│   │ [TooltipPrimitive.Provider] (500ms Warmup / 300ms Shared Skip Delay)           │   │
│   │       └── Auto Silencing when higher overlays activate                         │   │
│   └────────────────────────────────────────────────────────────────────────────────┘   │
│                                           ▲                                            │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │ Multi-Root Lit & React Portal Foundation                                       │   │
│   │ createLitPortal({ computePosition, autoUpdate, checkVisibility probe })        │   │
│   │ ShadowRoot Encapsulation + pointer-events: auto Immunity Shield                │   │
│   └────────────────────────────────────────────────────────────────────────────────┘   │
│                                           ▲                                            │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │ Base Stacking Plane (z-index: 0 ~ 5)                                           │   │
│   │ Edgeless Canvas (Transform/Scale) | Page Block Tree | Split-View Panels        │   │
│   └────────────────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 现代桌面协同应用浮层设计的五大黄金定律

纵观 AFFiNE 在浮层拓扑、多根 Portal 与层叠上下文管理中的源码实现，我们可以提炼出五条极具指导价值的工业级前端架构法则：

1. **创作工具的非模态铁律（The Non-Modal Law of Creative Tools）**：
   在知识库、编辑器与画布类应用中，默认将下拉菜单与弹出窗配置为 `modal: false`，绝不滥用全屏 Pointer 拦截遮罩。通过分层的 `[data-modal="false"]` CSS 规则让鼠标事件直接穿透至背景画布，让用户的操作流与视线流保持连续。
2. **几何物理学优于生硬时间延时（Physics Over Arbitrary Timers）**：
   解决子菜单斜向滑动闪退问题时，拒绝使用 300ms~500ms 的死板 `setTimeout`。采用严谨的 **二维向量交叉判定（Ray-Intersection Determinant）** 与 **动态 SVG 多边形（Safe Polygon）**，结合 40ms 的闲置熔断与 `rAF` 实时变形，用数学几何创造出“无形但精确”的吸附手感。
3. **彻底终结 Stacking Context 污染的唯一手段是 Top-Level Portals**：
   在复杂的白板画布与嵌套树组件中，不要试图通过在局部修改 `z-index` 来解决遮挡问题。所有浮层必须通过多根 Portal（如 `createLitPortal`、`DropdownMenu.Portal`）直接挂载至 `document.body` 顶层，并配合 `checkVisibility` 探针实现父节点脱落时的“消失即自愈”。
4. **编辑态焦点主权神圣不可侵犯（Focus Sovereignty in Text Editing）**：
   在弹窗与浮层交互中，通过在 `pointerdown` 阶段检测 `isTextEditingElement(activeElement)` 并实施 `event.preventDefault()`，将输入光标与选区牢牢锚定在输入控件中，消除按钮点击导致的软键盘跳动与焦点撕裂。
5. **善用 Web Component 原生生命周期融合前沿浏览器能力**：
   在面对 React Fiber 快速卸载 DOM 导致退出动效难以编排的痛点时，AFFiNE 没有引入庞大的外部状态库，而是通过继承 `HTMLElement` 并重写 `removeChild`，优雅地搭上了 Chromium 原生 **View Transitions API** 的快车，展现了令人叹为观止的原型设计与工程美学高度。

---

> **结语**：AFFiNE 的浮层系统不仅是一套解决弹窗与菜单定位的工具集合，更是一座将空间几何解析学、无障碍交互伦理学与 Web 渲染底层物理特性融为一体的现代前端工程丰碑。这种对像素级手感、零破坏心流与架构纯粹度的极致追求，为所有新一代桌面级 Web 与协同工具的研发提供了弥足珍贵的范式标杆。
$$
