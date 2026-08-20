# 全仓级联菜单浮层架构、LayerStack 调度中枢与生命周期解耦方案

> **文档标识**：`docs/cascade-menu-repair/independent-plans/03-layer-architecture-plan.md`  
> **角色定位**：浮层架构与系统解耦专家（LayerStack & Architecture Specialist）  
> **权威遵循**：`AGENTS.md`（反退避与架构优雅铁律）、`.agents/LOGIC_PLAN_NO_RETREAT.md`、`docs/rust-rewrite/31-security-baseline.md`  
> **目标范围**：`ModelBadgePickerMenu`、`ProjectPickerMenu`、`ContextMenuFlyout`、`ModelsCascadeSelect` 及全仓级联浮层调度基础设施

---

## 1. 执行摘要与架构现状洞察

在 Conex / Crish 桌面端应用中，浮层（Floating Layers）是用户进行上下文交互、会话管理、模型切换、设置配置的核心载体。随着应用交互复杂度的提升，浮层体系已演化出 **多层级、多形态、高频动态切换** 的特性。

### 1.1 核心基础设施现状

当前前端工程中已沉淀了关键的浮层调度基建：
1. **单核调度中枢（`LayerStackManager`）**：
   - 位于 `apps/crish-desktop/src/components/ui/internal/layer-stack/LayerStackManager.ts`；
   - 统一管理全局浮层的 LIFO 拓扑退栈、按优先级权重稳定排序（`LAYER_TYPE_PRIORITY`）；
   - 提供 50ms 冷却防重入锁（Anti-Reentry Cooldown Lock）与单手势防 Double-Toggle 机制（`dismissedByPointer`）；
   - 广播 `data-floating-active` 属性与 Tooltip 150ms 焦点静默窗口；
   - 守卫 CJK IME（中文输入法 229 / Process / isComposing）按键绝对放行；
   - 基于 `descendants` 子孙树提供 Branch-Aware 外点判定。
2. **菜单统一基座（`Menu.tsx`）**：
   - 位于 `apps/crish-desktop/src/components/ui/Menu/Menu.tsx`；
   - 基于 `@radix-ui/react-popover` 封装，提供自动碰撞避让（floating-ui）、受控/非受控双模开关、键盘漫游；
   - 接入了 `useLayerRegistration`（`type: 'dropdown-menu'`，层级权重 40）；
   - 支持通过 `DialogOverlayContext` 挂载至顶层 Portal。

### 1.2 架构核心矛盾与缺陷爆发

在 `ModelBadgePickerMenu`（模型徽标下拉菜单）以及全仓其它级联菜单（如 `ProjectPickerMenu`、`ContextMenuFlyout`、`ModelsCascadeSelect`）的演进中，暴露出深层次的架构断层：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 现状架构缺陷：DOM 内联导致 BFC 裁剪                                          │
│                                                                             │
│ [ Menu / Popover.Portal ]                                                   │
│   └── Popover.Content (overflow-y: auto, max-height: 360px)                 │
│         └── RowContainer (position: relative)                               │
│               ├── Row Button                                                │
│               └── SubMenu (position: absolute) ───► [被父容器滚动条截断裁剪]  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                         若盲目直接 Portal 挂载
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 潜在架构灾难：DOM 脱节导致 LayerStack / Radix 外点拓扑断裂                  │
│                                                                             │
│ [ Document.Body / DialogOverlay ]                                           │
│   ├── Parent Menu (Popover.Content) ─── 未感知子层 ───┐                      │
│   │     └── Row Button (Anchor)                       │ (误判为外部点击)     │
│   │                                                   ▼                      │
│   └── Child Submenu (Portal) ◄─── 用户点击 ───► [父级菜单瞬间被误杀关闭！]   │
│         (未注册 LayerStack，孤儿节点)                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

1. **DOM 内联嵌套导致 BFC 裁剪**：`ModelBadgePickerMenu` 与 `ModelsCascadeSelect` 等将二级菜单直接内联在父菜单行中。父菜单声明了 `overflow-y: auto` 与 `max-height`，一旦菜单项较多或屏幕较小，绝对定位的二级菜单立即被父级的滚动容器裁剪不可见，或强行撑大 Y 轴引发父菜单滚动条抖动。
2. **Portal 挂载与浮层栈（LayerStack）拓扑脱节**：若仅简单将二级菜单改为 Portal 挂载到 `document.body`，二级菜单在 DOM 树上脱离了父菜单容器。由于二级菜单未向 `LayerStackManager` 注册 `parentId`，也未与父级 Radix Popover 建立外点豁免关联，用户点击二级菜单时，父级 Radix Popover 与 `LayerStackManager` 会同时判定为“外部点击”，导致父菜单及整个级联链条瞬间崩溃关闭。
3. **Esc 与焦点退栈断层**：未注册的子菜单无法参与 `LayerStackManager` 的倒序退栈（LIFO），用户按下 Esc 时会直接关闭整个父菜单，破坏了 W3C WAI-ARIA 规定的“子菜单展开时 Esc 仅关闭子菜单并归还焦点给父菜单项”的标准行为。

---

## 2. 浮层拓扑与 LayerStack 架构冲突深度剖析

为从架构根源上解决级联浮层问题，必须深入剖析 `LayerStackManager`、Radix Popover 事件分发机制与浏览器 DOM 拓扑之间的交互时序。

### 2.1 冲突一：Radix Popover `onPointerDownOutside` 与 Portal 容器的拓扑断裂

#### 机制剖析：
`Menu.tsx` 内部使用 `@radix-ui/react-popover`。Radix 的 `Popover.Content` 内部封装了 `DismissableLayer`，其在 `document` 的捕获阶段（Capture Phase）监听 `pointerdown` 事件，判定点击目标（`event.target`）是否包含在当前的 `Popover.Content` 节点内部。

```tsx
// apps/crish-desktop/src/components/ui/Menu/Menu.tsx:375-385
<Popover.Content
  onPointerDownOutside={(e) => {
    if (onPointerDownOutside) {
      onPointerDownOutside(e);
      return;
    }
    const target = e.detail.originalEvent.target as Node | null;
    const triggerEl = anchor?.current ?? triggerRef.current;
    if (triggerEl && target && triggerEl.contains(target)) {
      e.preventDefault();
    }
  }}
  ...
>
```

#### 断层证据：
当二级子菜单通过 `createPortal(..., document.body)` 挂载到宿主顶层时：
- 子菜单 DOM 节点不再位于父级 `Popover.Content` 内部；
- 子菜单 DOM 节点也不在父级的 `triggerEl` 内部；
- 当用户在子菜单上按下鼠标（`pointerdown`）时，父级 Radix Popover 的 `onPointerDownOutside` 触发；
- 由于当前代码仅检查了 `triggerEl.contains(target)`，条件不成立，未调用 `e.preventDefault()`；
- Radix 判定为合法的外部点击，直接派发 `onOpenChange(false)`，**导致父菜单被强制卸载，连带导致正在交互的子菜单瞬间消失**。

### 2.2 冲突二：LayerStackManager 外部点击（Branch-Aware）判定断链

#### 机制剖析：
`LayerStackManager` 在 `window`/`document` 上绑定了全局单一捕获器 `handleGlobalPointerDown`：

```typescript
// apps/crish-desktop/src/components/ui/internal/layer-stack/LayerStackManager.ts:519-571
private handleGlobalPointerDown = (event: PointerEvent): void => {
  ...
  // 1. 检查点击是否位于容器内部
  const topEl = resolveElement(targetLayer.elementRef);
  if (topEl && topEl.contains(target)) return;

  // 2. 检查点击是否位于关联的 Anchor 内部
  const anchorEl = resolveElement(targetLayer.anchorRef);
  if (anchorEl && anchorEl.contains(target)) return;

  // 3. 检查点击是否位于任何子孙 Branch 浮层内部
  const descendants = this.getDescendants(targetLayer.id);
  for (const child of descendants) {
    const childEl = resolveElement(child.elementRef);
    if (childEl && childEl.contains(target)) return;
  }

  // 4. 确认属于外部点击，关闭目标浮层
  this.dismissLayer(targetLayer.id, 'outside-pointer');
};
```

#### 断层证据：
1. 若子菜单没有调用 `useLayerRegistration`，它在 `LayerStackManager` 中是一个**未登记的孤儿节点**；
2. 当点击子菜单时，`targetLayer` 为父菜单（`type: 'dropdown-menu'`）；
3. 父菜单的 `topEl`（父级 Content）不包含子菜单；
4. 父菜单的 `anchorEl`（模型徽标按钮）不包含子菜单；
5. `this.getDescendants(targetLayer.id)` 查询结果为 `[]`（空数组），因为子菜单从未注册 `parentId`；
6. `LayerStackManager` 判定该点击为外部点击，立即调用 `this.dismissLayer(targetLayer.id, 'outside-pointer')`，**父菜单被中枢强制注销并关闭**。

### 2.3 冲突三：层级权重（Priority）与逐级退栈（Stepwise Dismiss）失效

#### 机制剖析：
`layerStackTypes.ts` 中定义了清晰的语义权重：

```typescript
// apps/crish-desktop/src/components/ui/internal/layer-stack/layerStackTypes.ts:70-81
export const LAYER_TYPE_PRIORITY: Record<LayerType, number> = {
  'modal-dialog': 10,
  'confirm-dialog': 15,
  drawer: 20,
  popover: 30,
  'dropdown-menu': 40,
  'context-menu': 40,
  'cascade-submenu': 50, // 级联子菜单拥有更高优先级
  tooltip: 60,
  toast: 70,
  'virtual-interceptor': 100,
};
```

`LayerStackManager.register` 会根据该权重对 `layers` 数组进行稳定排序：

$$\text{Priority}(A) < \text{Priority}(B) \implies \text{Index}(A) < \text{Index}(B)$$

在 LIFO 退栈（`handleGlobalKeyDown` 响应 `Escape`）时，自顶向下遍历：

```typescript
for (let i = this.layers.length - 1; i >= 0; i--) {
  const layer = this.layers[i];
  if (layer.dismissible) {
    event.preventDefault();
    event.stopPropagation();
    this.dismissLayer(layer.id, 'escape');
    return; // 消费成功，终止传递
  }
}
```

#### 断层证据：
- 预期行为：二级菜单注册为 `'cascade-submenu'`（权重 50），排在父菜单（权重 40）之上。按第一次 Esc 时，命中子菜单（50），仅关闭子菜单并归还焦点给父菜单项；再次按 Esc 时，命中父菜单（40），关闭父菜单；
- 现状缺陷：子菜单未注册，按 Esc 时直接命中父菜单（40），父菜单被直接关闭，**无法实现级联菜单逐级退栈**。

### 2.4 冲突四：互斥驱逐（Exclusive Peer Eviction）的安全边界

#### 机制剖析：
`LayerStackManager` 支持同级菜单展开互斥（`evictExclusivePeers`）：
- `'dropdown-menu'` 与 `'context-menu'` 属于 `EXCLUSIVE_PEER_LAYER_TYPES`；
- 当打开一个新菜单时，自动驱逐栈中已有的同级菜单；
- 豁免规则（`LayerStackManager.ts:264-274`）：
  - 若 `incoming.parentId === peer.id`（新层是旧层的子级），**不驱逐**；
  - 若 `this.hasAncestor(incoming.parentId, peer.id)`（新层是旧层的子孙），**不驱逐**；
  - 若 `peerEl.contains(incomingAnchor)`（新层的锚点在旧层内部），**不驱逐**。

#### 架构要求：
二级级联子菜单必须明确声明 `type: 'cascade-submenu'` 与 `parentId: parentMenuId`：
1. `'cascade-submenu'` 不属于 `EXCLUSIVE_PEER_LAYER_TYPES`，打开子菜单绝不会误驱逐父级菜单；
2. 明确的 `parentId` 确保即便子菜单未来扩展为复杂菜单类型，也能被祖先链豁免算法精准保护。

---

## 3. 级联浮层标准接入模式（The Golden Standard Architecture）

为彻底根治全仓级联菜单问题，确立 **Conex / Crish 级联浮层标准架构规范**。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           LayerStackManager                                 │
│                                                                             │
│  Layer Stack (LIFO 排序):                                                   │
│    [0] 'dropdown-menu' (Parent Menu, id: "menu-1", priority: 40)            │
│         └── elementRef: <ParentPopoverContent>                              │
│         └── anchorRef:  <ModelBadgeButton>                                  │
│    [1] 'cascade-submenu' (Child Submenu, id: "sub-1", priority: 50)         │
│         ├── parentId:   "menu-1"  (显式父子指针)                            │
│         ├── elementRef: <SubmenuPortalContent>                              │
│         └── anchorRef:  <ProviderRowButton>                                 │
│                                                                             │
│  事件流协调 (Event Flow Coordination):                                      │
│  1. 点击 SubmenuPortalContent:                                              │
│     - LayerStack: 命中 targetLayer.descendants -> 判定内部点击放行          │
│     - Radix Popover: getDescendants 检查命中 -> e.preventDefault() 阻止误关 │
│  2. 按 Escape 键:                                                           │
│     - LayerStack: 自顶向下命中 [1] 子菜单 -> 仅关闭子菜单并归还焦点到行按钮   │
│  3. 点击视口空白处 (真正外部点击):                                          │
│     - LayerStack: dismissLayer("menu-1") -> 级联倒序关闭 [1] 子菜单与 [0]   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 核心架构要素一：Portal 容器与 React 上下文贯通

1. **Portal 挂载点策略**：
   - 优先挂载至 `DialogOverlayContext` 提供的容器（与主弹窗/工作区共享层叠上下文）；
   - 若不存在 `DialogOverlayContext`，平滑回退挂载至 `document.body`；
   - 挂载节点赋予 `data-layer-type="cascade-submenu"` 与 `no-drag` 属性。
2. **React 19 / Fiber 树状态安全**：
   - 使用 `createPortal` 保证 React Context（主题、状态、国际化）与事件冒泡在 React Virtual DOM 树中的完整传递，同时在宿主 DOM 树上脱离 BFC 裁剪容器。

### 3.2 核心架构要素二：LayerStack 注册契约（LayerRegistration Contract）

所有级联子菜单在挂载时必须履行如下注册契约：

```typescript
export interface CascadeSubmenuRegistrationProps {
  /** 子菜单唯一标识 */
  id: string;
  /** 浮层语义类型：必须为 'cascade-submenu'（权重 50） */
  type: 'cascade-submenu';
  /** 父级菜单 ID：通过 MenuContext 或 Props 显式注入 */
  parentId: string;
  /** 子菜单自身容器 DOM Ref */
  elementRef: React.RefObject<HTMLElement | null>;
  /** 触发当前子菜单的父级项 DOM Ref（用于坐标计算与外点豁免） */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** 是否允许外点/Esc 关闭 */
  dismissible: true;
  /** 关闭回调 */
  onDismiss: (reason: DismissReason) => void;
  /** Esc 按下定制拦截（可选） */
  onEscapeKeyDown?: (event: KeyboardEvent) => boolean | void;
  /** 焦点还原目标：默认精准还原至 anchorRef.current（父级菜单项按钮） */
  restoreFocusTarget?: HTMLElement | null;
}
```

### 3.3 核心架构要素三：双向生命周期级联矩阵（Bidirectional Lifecycle Matrix）

| 触发场景 | 作用对象 | LayerStack 行为 | 子菜单状态 | 父菜单状态 | 焦点落点 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **按 Esc 键 (第 1 次)** | 子菜单展开态 | 命中权重 50 的顶层子菜单 | **关闭 (escape)** | **保持打开** | 平滑归还至触发该子菜单的父级行按钮 |
| **按 Esc 键 (第 2 次)** | 仅父菜单打开态 | 命中权重 40 的父菜单 | 已销毁 | **关闭 (escape)** | 归还至父菜单 Trigger 徽标按钮 |
| **点击子菜单内部** | 子菜单项 | 判定为子孙内部交互 | 保持打开/触发选中 | **保持打开** | 聚焦在选中的子菜单项 |
| **点击父菜单其它行** | 父菜单其它项 | 子菜单判定为外部点击 | **关闭 (outside-pointer)** | **保持打开** | 响应父菜单其它项（或展开新子菜单） |
| **点击全屏外部区域** | 视口空白处 | 父层判定为外部点击，触发级联 | **级联销毁 (parent-dismissed)** | **关闭 (outside-pointer)** | 尊重用户外部点击聚焦目标 |
| **子菜单项点击选中** | 选定模型/操作 | 业务触发选择完成 | **关闭 (item-select)** | **关闭 (programmatic)** | 归还焦点或进入后续交互 |
| **父菜单组件卸载** | 路由切换/弹窗关闭 | 父菜单注销 | **级联注销 (parent-dismissed)** | 注销 | 清理并重置全局浮层状态 |

### 3.4 核心架构要素四：`Menu.tsx` 菜单基座解耦与 Context 注入

为消除各业务菜单手动传递 `parentId` 的繁琐和遗漏风险，在 `Menu.tsx` 基座中原生集成 `MenuContext` 与子孙外点放行逻辑。

#### 1. 导出 `MenuContext`：
```tsx
export interface MenuContextValue {
  /** 当前菜单在 LayerStack 中的注册 ID */
  menuId: string;
  /** 当前菜单是否处于打开状态 */
  isOpen: boolean;
  /** 命令式关闭当前菜单 */
  closeMenu: () => void;
  /** Portal 容器节点（来自 DialogOverlayContext 或 document.body） */
  dialogOverlay: HTMLElement | null;
}

export const MenuContext = React.createContext<MenuContextValue | null>(null);

export function useMenuContext(): MenuContextValue | null {
  return React.useContext(MenuContext);
}
```

#### 2. 在 `Menu.tsx` 中增强 Radix 外点防御：
```tsx
// 在 Popover.Content 的 onPointerDownOutside 与 onInteractOutside 中集成子孙检查
<Popover.Content
  ref={contentRef}
  ...
  onPointerDownOutside={(e) => {
    if (onPointerDownOutside) {
      onPointerDownOutside(e);
      return;
    }
    const originalEvent = e.detail?.originalEvent;
    const target = (originalEvent?.target || e.target) as Node | null;
    const triggerEl = anchor?.current ?? triggerRef.current;
    
    // 1. 触发源自身点击豁免
    if (triggerEl && target && triggerEl.contains(target)) {
      e.preventDefault();
      return;
    }

    // 2. 核心修复：检查点击是否落在任何已注册的子孙 Layer（如 cascade-submenu）内部
    const descendants = layerStackService.getDescendants(menuId);
    for (const desc of descendants) {
      const descEl = resolveElement(desc.elementRef);
      if (descEl && target && descEl.contains(target)) {
        e.preventDefault(); // 阻止 Radix 关闭父菜单！
        return;
      }
    }
  }}
  onInteractOutside={(e) => {
    if (onInteractOutside) {
      onInteractOutside(e);
      return;
    }
    const customEvent = e as CustomEvent<{ originalEvent?: Event }>;
    const target = (customEvent.detail?.originalEvent?.target || e.target) as Node | null;
    const triggerEl = anchor?.current ?? triggerRef.current;
    
    if (triggerEl && target && triggerEl.contains(target)) {
      e.preventDefault();
      return;
    }

    const descendants = layerStackService.getDescendants(menuId);
    for (const desc of descendants) {
      const descEl = resolveElement(desc.elementRef);
      if (descEl && target && descEl.contains(target)) {
        e.preventDefault();
        return;
      }
    }
  }}
>
  <MenuContext.Provider value={{ menuId, isOpen, closeMenu: () => handleOpenChange(false), dialogOverlay }}>
    {title != null ? <div className={styles.menuTitle}>{title}</div> : null}
    {children != null ? children : ...}
  </MenuContext.Provider>
</Popover.Content>
```

---

## 4. 外点关闭与 Double-Toggle 防御体系

在桌面端应用中，触发器（Trigger / Anchor）的点击状态机与浮层外点关闭存在固有的时间差与竞态条件。必须建立严密的判定树。

### 4.1 Branch-Aware 外点判定状态转移

```mermaid
flowchart TD
    Start[捕获到全局 PointerDown 事件] --> CheckProcessed{WeakSet 是否已处理?}
    CheckProcessed -- 是 --> Stop[终止]
    CheckProcessed -- 否 --> MarkProcessed[加入 WeakSet]
    
    MarkProcessed --> FindTop[倒序查找栈顶 dismissible=true 浮层 targetLayer]
    FindTop --> HasTarget{存在 targetLayer?}
    HasTarget -- 否 --> Stop
    HasTarget -- 是 --> CheckInside{target 是否在 targetLayer.elementRef 内部?}
    
    CheckInside -- 是 --> InsideAction[内部点击: 正常放行, 不关闭]
    CheckInside -- 否 --> CheckAnchor{target 是否在 targetLayer.anchorRef 内部?}
    
    CheckAnchor -- 是 --> AnchorAction[Anchor 自身点击: 记录 anchorPointerDownTarget, 阻止外点误关, 交给 trigger click 逻辑]
    CheckAnchor -- 否 --> CheckDescendants{target 是否在 targetLayer 的子孙 Layer 内部?}
    
    CheckDescendants -- 是 --> DescendantAction[子分支点击: 判定为合法内部交互, 严禁误关父层]
    CheckDescendants -- 否 --> OutsideDismiss[确认外部点击: 记录 dismissedByPointer, 调用 dismissLayer(targetLayer.id, 'outside-pointer')]
    
    OutsideDismiss --> CheckParent{targetLayer 是否有 parentId?}
    CheckParent -- 是 --> OnlyChildDismiss[仅注销子层, 父层保持存活!]
    CheckParent -- 否 --> ParentDismiss[注销该层及其全部子孙]
```

### 4.2 Double-Toggle（二次震荡翻转）防御机理

#### 故障场景：
用户在菜单已打开状态下再次点击 Anchor 按钮：
1. `pointerdown` 阶段：若判定为外点关闭，浮层被注销（`isOpen -> false`）；
2. 紧接着的 `click` 阶段：Anchor 按钮的 `onClick` 被触发，如果代码写了 `setOpen(prev => !prev)`，由于当前 `open` 已是 `false`，取反导致菜单**立即被重新打开**（即点击触发器无法关闭菜单，表现为高频闪烁）。

#### 架构防御措施（双锁保险）：
1. **第一道锁：单手势指针特征识别（`dismissedByPointer` & `wasTriggerClickAfterDismiss`）**：
   - 当 `handleGlobalPointerDown` 因外点关闭了某一层时，记录当前 `pointerId` 与 `anchor`；
   - 随后的 `click` 事件触发时，`shouldSuppressMenuReopen(triggerEl)` 检测到本次手势已用于外点关闭，立即返回 `true` 吞掉本次重开；
2. **第二道锁：绝对状态写回（`toggleExclusiveMenu`）**：
   - 严格禁止在触发器中使用 `setOpen(prev => !prev)`；
   - 必须使用 `toggleExclusiveMenu(open, setOpen, triggerEl)`：开着则写死 `false`，关着且未被吞掉时才写 `true`。

---

## 5. 全仓级联菜单现状普查与防回退影响分析

对 Conex / Crish 前端代码库中所有使用 `<Menu>`、浮层、选择器、下拉列表的组件进行全景普查与分级审计。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 全仓菜单与浮层架构健康度分布                                                │
│                                                                             │
│ [Class A] 存在级联/裁剪架构隐患（本次必须重构/标准对齐）                    │
│   ├── ModelBadgePickerMenu.tsx  (模型徽标：内联裁剪，无 LayerStack 注册)     │
│   ├── ProjectPickerMenu.tsx     (项目选择：内联二级菜单，overflow 隐患)      │
│   ├── ContextMenuFlyout.tsx     (侧栏排序：内联 Flyout，未解耦 Portal)      │
│   └── ModelsCascadeSelect       (设置页模型级联：内联绝对定位)              │
│                                                                             │
│ [Class B] 扁平一级菜单（架构健康，本次保持基座兼容，零破坏）                │
│   ├── ComposePlusMenu.tsx       (输入区「+」菜单：Anchor 模式，标准 options) │
│   ├── PermissionModeMenu.tsx    (权限药丸菜单：Anchor 模式，双模受控)        │
│   ├── SettingsQuickMenu.tsx     (设置快捷菜单：标准 Menu，焦点管理完善)      │
│   ├── ChatHeaderMore.tsx        (会话「⋯」菜单：标准 Menu)                  │
│   ├── SkillsMoreMenu.tsx        (技能设置菜单：标准 Menu)                    │
│   ├── FileActions.tsx           (文件卡片操作菜单：标准 Menu)                │
│   └── Select.tsx                (通用 Select 选择器：标准 Menu listbox)      │
│                                                                             │
│ [Class C] 独立右键菜单/全局模态（已独立接入 LayerStack，架构稳健）          │
│   ├── SessionContextMenu.tsx    (会话右键：createPortal + LayerStack 注册)   │
│   └── Dialog.tsx                (全局模态：DialogOverlayContext + LayerStack)│
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Class A 组件专项分析与改造方案

#### 1. `ModelBadgePickerMenu.tsx`（本次核心）
- **文件路径**：`apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx`
- **现状缺陷**：
  - 二级菜单 `.mbSubMenu` 直接内联在 `.mbRowContainer`；
  - 父级 `.mbMenu` 声明了 `overflow-y: auto`，导致二级菜单在展示时被 BFC 强行裁剪；
  - 二级菜单未调用 `useLayerRegistration`，无 LayerStack 调度管理；
  - 依赖父级 `onEscapeKeyDown` 内部写死 `expandedProfileId != null` 进行分支拦截，耦合度高。
- **改造方案**：
  - 抽出独立子组件 `ModelBadgeSubmenu`；
  - 使用 `createPortal` 挂载至 `dialogOverlay ?? document.body`；
  - 接入 `useLayerRegistration`（`type: 'cascade-submenu'`, `parentId: menuContext.menuId`）；
  - 接入几何坐标计算（基于服务商行按钮 `getBoundingClientRect`，默认向右弹出，右边界溢出自动翻转至左侧）；
  - 集成 `SafeTriangleTracker` 确保光标斜向滑入时不闪退。

#### 2. `ProjectPickerMenu.tsx`
- **文件路径**：`apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.tsx`
- **现状缺陷**：
  - 「添加项目」二级菜单 `.cascadeSubmenu`（第 271-303 行）内联在 `.addCascadeWrapper` 中；
  - 样式使用 `left: 100%; top: 0; position: absolute;`；
  - 虽在父级配置了 `contentStyle: { overflow: 'visible' }`，但在视口右边缘时无法自适应向左翻转；
  - 二级菜单未接入 LayerStack，点击外部时由于 DOM 内联虽未报错，但不支持独立退栈与生命周期追踪。
- **改造方案**：
  - 对齐标准级联子菜单模式，将 `.cascadeSubmenu` 升级为 Portal 挂载；
  - 绑定 `parentId: menuId` 与 `anchorRef`，增加向左自适应翻转能力。

#### 3. `ContextMenuFlyout.tsx`
- **文件路径**：`apps/crish-desktop/src/components/sidebar/ContextMenuFlyout.tsx`
- **现状缺陷**：
  - 排序、分组、过滤的三行二级菜单（`FlyoutRow`）内联在父 `Menu` 中；
  - 使用了 `useLayoutEffect` 手动计算 `flipLeft`；
  - 键盘漫游（ArrowRight/ArrowLeft/Esc）在组件内部手工管理，未接入中枢 LayerStack。
- **改造建议**：
  - 当前测试覆盖完整（`SidebarContextMenus.flyout.test.tsx`）；
  - 保持现有键盘导航与宽限期语义，后续将其底层 DOM 挂载无损切换至标准 `CascadeSubmenu` 基件，消除对父级无 `overflow: hidden` 的隐式假设。

#### 4. `ModelsCascadeSelect`（`ModelProfileList.tsx`）
- **文件路径**：`apps/crish-desktop/src/components/settings-models/ModelProfileList.tsx:20-157`
- **现状缺陷**：
  - 服务商-模型二级选择器，`.cascadeFlyout` 绝对定位内联在 `cascadeRow` 中；
  - 虽然已经引入了 `SafeTriangleTracker`，但二级浮层内联于滚动区域，在设置面板缩小时存在视口边缘截断；
  - 未注册 LayerStack，Esc 键无法优雅逐级退栈。
- **改造方案**：
  - 采用标准 `useCascadeSubmenu` 改造，解耦挂载点至 Portal，保留其 `SafeTriangleTracker` 交互逻辑。

### 5.2 Class B & Class C 组件安全分析（零破坏保证）

- **`ComposePlusMenu.tsx`**：扁平一级菜单，使用 `anchor={restoreFocusRef}`，完全托管于 `Menu.tsx` 基座，无二级级联，本次基座改造对其完全透明，100% 安全；
- **`PermissionModeMenu.tsx`**：扁平一级菜单，使用 `toggleExclusiveMenu` 与 `anchor={pillBtnRef}`，完全兼容，100% 安全；
- **`SettingsQuickMenu.tsx`**：扁平一级菜单，独立实现了 `onInteractOutside` 与 `onCloseAutoFocus` 焦点策略，本次基座增强不会干扰其现有逻辑，100% 安全；
- **`SessionContextMenu.tsx`**：独立注册为 `type: 'context-menu'`，使用 `createPortal(..., document.body)`，无二级子菜单，与本次级联架构天然正交，100% 安全。

---

## 6. 架构级落地规范与通用基件设计

为保证全仓级联菜单实现的高度一致性、零重复代码与极致可维护性，设计如下通用级联基件与 Hook。

### 6.1 通用 Hook：`useCascadeSubmenu`

```typescript
// apps/crish-desktop/src/components/ui/internal/cascade-menu/useCascadeSubmenu.ts

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useMenuContext } from '../../Menu/Menu';
import { useLayerRegistration } from '../layer-registration/useLayerRegistration';

export interface UseCascadeSubmenuOptions {
  /** 显式指定的父菜单 ID（若未提供，则自动从 MenuContext 获取） */
  parentId?: string;
  /** 触发子菜单的行按钮 DOM Ref */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** 子菜单是否处于展开状态 */
  isOpen: boolean;
  /** 关闭子菜单回调 */
  onClose: () => void;
  /** 选中项后的全链条关闭回调 */
  onSelectAndCloseAll?: () => void;
  /** 子菜单宽度（用于视口翻转碰撞预判，默认 190px） */
  submenuWidth?: number;
  /** 偏移量（默认 4px） */
  offset?: number;
}

export interface SubmenuPosition {
  x: number;
  y: number;
  placement: 'left' | 'right';
}

export function useCascadeSubmenu({
  parentId: explicitParentId,
  anchorRef,
  isOpen,
  onClose,
  submenuWidth = 190,
  offset = 4,
}: UseCascadeSubmenuOptions) {
  const menuContext = useMenuContext();
  const parentId = explicitParentId ?? menuContext?.menuId ?? 'root-menu';
  const submenuId = useId();
  const submenuRef = useRef<HTMLDivElement | null>(null);
  
  const [position, setPosition] = useState<SubmenuPosition>({
    x: 0,
    y: 0,
    placement: 'right',
  });

  // 1. 视口自适应几何坐标计算
  const updatePosition = useCallback(() => {
    if (!anchorRef.current || typeof window === 'undefined') return;
    const rect = anchorRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 默认向右，若右侧超出视口则翻转至左侧
    let placement: 'left' | 'right' = 'right';
    let x = rect.right + offset;
    
    if (x + submenuWidth > vw - 8) {
      x = Math.max(8, rect.left - submenuWidth - offset);
      placement = 'left';
    }

    // 垂直对齐与贴底防溢出
    let y = rect.top - 4;
    const estimatedHeight = submenuRef.current?.offsetHeight || 240;
    if (y + estimatedHeight > vh - 8) {
      y = Math.max(8, vh - estimatedHeight - 8);
    }

    setPosition({ x, y, placement });
  }, [anchorRef, offset, submenuWidth]);

  useLayoutEffect(() => {
    if (isOpen) {
      updatePosition();
    }
  }, [isOpen, updatePosition]);

  // 监听窗口尺寸变化与父级滚动
  useEffect(() => {
    if (!isOpen) return;
    const handleScrollOrResize = () => updatePosition();
    window.addEventListener('resize', handleScrollOrResize);
    window.addEventListener('scroll', handleScrollOrResize, true);
    return () => {
      window.removeEventListener('resize', handleScrollOrResize);
      window.removeEventListener('scroll', handleScrollOrResize, true);
    };
  }, [isOpen, updatePosition]);

  // 2. 注册 LayerStackManager（type: 'cascade-submenu', 权重 50）
  useLayerRegistration(
    {
      id: submenuId,
      type: 'cascade-submenu',
      parentId,
      elementRef: submenuRef,
      anchorRef,
      dismissible: true,
      onDismiss: (reason) => {
        onClose();
      },
      onEscapeKeyDown: (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        // 精准归还焦点至父菜单行按钮
        anchorRef.current?.focus();
        return true;
      },
      restoreFocusTarget: anchorRef.current,
    },
    isOpen
  );

  return {
    submenuId,
    submenuRef,
    position,
    dialogOverlay: menuContext?.dialogOverlay ?? null,
  };
}
```

### 6.2 `ModelBadgePickerMenu.tsx` 无损重构实现方案

```tsx
// 重构后的 ModelBadgePickerMenu 架构示意（完全解耦 Portal 与 LayerStack）

export const ModelBadgePickerMenu: React.FC<Props> = ({
  activeModel,
  onClose,
  onOpenChange,
  open = false,
  side = 'bottom',
  anchor,
}) => {
  const [expandedProfileId, setExpandedProfileId] = useState<string | null>(null);
  const rowRefsRef = useRef<Record<string, HTMLButtonElement | null>>({});

  return (
    <Menu
      openState={{
        open,
        onOpenChange: (nextOpen) => {
          if (!nextOpen) {
            onOpenChange?.(false);
            onClose();
          }
        },
      }}
      anchor={anchor}
      position={{ side, align: 'start', sideOffset: 4 }}
      panel={{ contentClassName: styles.mbMenu }}
    >
      {profiles.map((p, profileIndex) => {
        const isExpanded = expandedProfileId === p.id;
        const hasModels = (p.models || []).length > 0;

        return (
          <div key={p.id} className={styles.mbRowContainer}>
            <button
              ref={(el) => { rowRefsRef.current[p.id] = el; }}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={hasModels ? isExpanded : undefined}
              className={`${styles.mbRow}${isExpanded ? ` ${styles.isExpanded}` : ''}`}
              onClick={() => {
                if (!hasModels) return;
                setExpandedProfileId(isExpanded ? null : p.id);
              }}
            >
              <span className={styles.mbRowText}>{p.name}</span>
              {hasModels && (
                <Lucide.ChevronRight size={14} className={styles.mbChevron} />
              )}
            </button>

            {/* Portal 挂载的独立子菜单浮层 */}
            {isExpanded && hasModels && (
              <ModelBadgeSubmenuPortal
                profile={p}
                activeModel={activeModel}
                anchorRef={{ current: rowRefsRef.current[p.id] }}
                onClose={() => setExpandedProfileId(null)}
                onSelectModel={async (modelId) => {
                  await activateProfileModel(p.id, modelId);
                  setExpandedProfileId(null);
                  onClose(); // 整体关闭
                }}
              />
            )}
          </div>
        );
      })}
    </Menu>
  );
};
```

---

## 7. 实施路线与质量门禁（Verification & Quality Gates）

### 7.1 阶段化实施路线（Four-Phase Implementation）

```
Phase 1: 基础设施增强 (LayerStack & Menu 基座)
  ├── 在 Menu.tsx 中构建 MenuContext，暴露 menuId 与 Portal 容器
  └── 在 Menu.tsx 的 onPointerDownOutside / onInteractOutside 中接入 getDescendants 放行守卫
        │
Phase 2: 通用级联基件封装
  ├── 实现 useCascadeSubmenu Hook 与 SubmenuPortal 通用容器
  └── 编写 LayerStack 级联父子拓扑与退栈单元测试
        │
Phase 3: ModelBadgePickerMenu 首发落地与验证
  ├── 将 .mbSubMenu 拆解为 Portal 挂载组件
  ├── 验证 BFC 裁剪彻底消除、滚动条抖动消除、向左/向右翻转自适应
  └── 跑通 ModelBadgePickerMenu.test.tsx 全量用例
        │
Phase 4: 全仓级联组件标准化推广
  ├── 对齐 ProjectPickerMenu 的添加项目级联
  ├── 对齐 ModelsCascadeSelect 与 ContextMenuFlyout
  └── 执行全量 CI 门禁检查
```

### 7.2 质量门禁与测试断言

在完成实现后，必须运行并全部通过以下质量验证套件：

1. **类型安全门禁**：
   ```powershell
   npm run typecheck
   ```
2. **单元测试与退栈断言套件**：
   ```powershell
   npx vitest run src/components/provider/ModelBadgePickerMenu.test.tsx
   npx vitest run src/components/ui/Menu/Menu.test.tsx
   npx vitest run src/components/sidebar/SidebarContextMenus.flyout.test.tsx
   npx vitest run src/components/chat-card/ProjectPickerMenu.test.tsx
   npx vitest run src/components/ui/internal/SafeTriangle.test.ts
   ```
3. **架构与解耦断言检查**：
   - 确保 `ui/internal/` 不反向依赖上层业务组件（零循环依赖 `no-circular`）；
   - 验证单文件行数符合行数基线门禁（UI 组件 $\le 500$ 行）；
   - 严禁使用 `--no-verify` 跳过任何钩子。

---

## 8. 总结与专家建议

本方案从 **浮层拓扑、事件调度中枢、DOM 渲染上下文、生命周期状态机** 四个维度，彻底穿透并解决了 `ModelBadgePickerMenu` 及全仓级联菜单的深层架构缺陷。

- **拒绝打补丁**：不采用 `overflow: visible` 破坏父级滚动容器，也不采用硬编码绝对坐标；
- **架构级解耦**：通过 `createPortal` 消除 BFC 裁剪，通过 `LayerStackManager` 维护虚拟父子指针（`parentId` 与 `descendants`），通过 `MenuContext` 贯通 Radix Popover 外部点击放行链；
- **用户体验飞跃**：完美支持 WAI-ARIA 阶梯式 Esc 退栈、方向键漫游、SafeTriangle 向量防闪退、以及高精度视口边缘翻转。
