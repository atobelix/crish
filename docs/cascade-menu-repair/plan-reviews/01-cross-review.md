# Conex / Crish 级联菜单多 Agent 独立方案交叉评审与比对报告

> **文档标识**：`docs/cascade-menu-repair/plan-reviews/01-cross-review.md`  
> **评审发起**：主控 Agent（Orchestrator）  
> **评审对象**：
> 1. `docs/cascade-menu-repair/independent-plans/01-ui-geometry-plan.md`（UI & Geometry Architect）
> 2. `docs/cascade-menu-repair/independent-plans/02-interaction-keyboard-plan.md`（Interaction & A11y Specialist）
> 3. `docs/cascade-menu-repair/independent-plans/03-layer-architecture-plan.md`（LayerStack & Architecture Specialist）
> **遵循铁律**：`AGENTS.md`（反退避、纯逻辑规划、严禁打补丁）、`.agents/LOGIC_PLAN_NO_RETREAT.md`

---

## 1. 评审背景与核心问题

在 Conex / Crish 桌面端应用中，用户在底部工具栏激活 `ModelBadgePickerMenu`（模型徽标下拉菜单）后，鼠标 Hover 到服务商行（如「OpenCode Go 订阅」）时，出现了**二级级联子菜单不可见，而主菜单右侧异常出现垂直滚动条**的严重故障。

为了避免“改一处破其他处”的盲目打补丁行为，主控调度了三位不同领域的专业子代理进行了全方位独立分析。本报告对三份独立方案进行严格的横向交叉比对与冲突校验。

---

## 2. 方案横向交叉比对矩阵

| 比对维度 | Agent 1: UI & 几何布局专家 (`01-ui-geometry-plan.md`) | Agent 2: 交互与无障碍专家 (`02-interaction-keyboard-plan.md`) | Agent 3: 浮层架构专家 (`03-layer-architecture-plan.md`) | 交叉一致性与裁判结论 |
| :--- | :--- | :--- | :--- | :--- |
| **问题根本原因定位** | **CSS 包含块裁剪与 Scrollable Overflow Area 膨胀**：主菜单声明了 `overflow-y: auto; overflow-x: hidden;`，内联绝对定位的子菜单在 X 轴被强制截断，在 Y 轴撑大主菜单高度触发滚动条。 | **声明式 `autoFocus` 挂载抢焦与滚动联动**：子菜单按钮声明 `autoFocus`，Hover mount 时强制夺焦，触发浏览器原生 `scrollIntoView`，引发主菜单滚动抖动与失焦闪退。 | **DOM 内联脱节与 LayerStack 孤儿节点断层**：子菜单没有作为独立层向 `LayerStackManager` 注册，未与 Radix Popover 建立外点豁免关联。 | **完全互补、多因交织**：CSS 裁剪是子菜单不可见的物理主因；`autoFocus` 是滚动条跳变与焦点抢夺的交互主因；LayerStack 脱节是直接 Portal 化可能引发的外点误杀陷阱。三者共同构成了完整因果链。 |
| **DOM 挂载策略** | 采用 `Popover.Portal` 将子菜单从主菜单内联结构中剥离，挂载至 `document.body` 或 `#dialog-overlay`。 | 采用解耦的受控渲染，子菜单外挂不影响主列表 DOM 树。 | 采用 `createPortal` 挂载至 `DialogOverlayContext`（或 `document.body`），并通过 `MenuContext` 传递父层 `menuId`。 | **达成绝对共识**：必须彻底废弃内联 DOM 嵌套，统一采用 Portal 脱离父级滚动容器。挂载目标首选 `DialogOverlayContext`，回退 `document.body`。 |
| **几何定位与视口碰撞** | 在 `position.ts` 中封装 `calculateSubmenuPosition`，根据可用空间动态 Flip（左侧放不下向右翻折），并联动 Chevron 图标方向。 | 适配向左展开（`placement: 'left'`）与向右展开的几何布局。 | 支持 Portal 浮层的精确 Anchor 坐标映射与视口钳位。 | **达成绝对共识**：废弃硬编码 `right: calc(100% + 4px)`，引入几何算法实现视口边缘自动翻折，且指示图标与展开方向严格同步。 |
| **焦点管理与 autoFocus** | 移除子菜单内的 autoFocus，避免布局计算期间发生滚动。 | **模态感知（Modality-Aware）**：彻底清除声明式 `autoFocus`。Hover 展开只更新视觉，严禁转移焦点；键盘（ArrowLeft/Enter）展开才显式受控聚焦。 | 遵从 LIFO 焦点退栈，Esc 关闭子菜单时焦点精确归还父行。 | **达成绝对共识**：严禁在 JSX 中使用声明式 `autoFocus`。区分鼠标 Hover 与键盘操作，键盘由受控方法赋予焦点并带 `preventScroll: true`。 |
| **鼠标轨迹保护 (Safe Triangle)** | 集成 `SafeTriangleTracker`，提供 300ms 宽限期，防止斜向移动掠过相邻行时误触发关闭。 | 严格适配 `placement: 'left'` 与 `placement: 'right'` 的二维向量叉积判定，科学标定 80ms/300ms/150ms 人机工程学参数。 | 确保 SafeTriangle 在 Portal 脱离结构下依然能够基于 DOMRect 稳定运行。 | **达成绝对共识**：复用仓内既有基建 `SafeTriangle.ts`，为级联子菜单配备完整的三角区防抖保护。 |
| **浮层中枢与外点关闭** | 需确保子菜单 z-index 高于主菜单，不被其它层级遮挡。 | 支持 Esc 逐级退栈（先关子菜单，再关主菜单）。 | **核心关键**：子菜单调用 `useLayerRegistration` 注册为 `type: 'cascade-submenu'`（权重 50），声明 `parentId`；在父级 Radix Popover 的 `onPointerDownOutside` 中识别并放行子孙 Portal 点击。 | **达成关键深化**：Agent 3 揭示了直接 Portal 化可能被 Radix 和 LayerStack 误判为外点点击从而瞬间销毁父菜单的致命陷阱，补充了至关重要的架构级防护。 |
| **全仓影响与防回归** | 评估了 `ProjectPickerMenu` 和 `ModelsCascadeSelect` 的异同。 | 设计了包含 9 个场景的端到端交互与无障碍测试用例。 | 普查了全仓 14 个菜单组件，分类为 Class A（级联需改造）、Class B（扁平安全）、Class C（独立浮层），设计了防回归契约。 | **达成系统性闭环**：不仅修复当前组件，还建立通用的级联浮层标准模式，指导全仓类似组件的长期健康演进。 |

---

## 3. 关键架构裁决与共识合并

通过对三份方案的深度交叉审视，主控做出以下最终技术裁决：

### 裁决 1：必须三管齐下，绝不单点击穿
仅改 CSS 无法解决 `autoFocus` 抢焦与闪退；仅改 Portal 挂载会导致 Radix 外点事件误杀父菜单；仅改焦点无法解决 overflow 裁剪。因此，**必须将「Portal 脱截 + 几何计算 Flip + 模态感知焦点控制 + SafeTriangle 保护 + LayerStack 拓扑注册」作为一个原子方案同时落地**。

### 裁决 2：几何定位与 Chevron 图标动态联动
- 当左侧可用空间足够（`spaceLeft >= 194px`）时：朝左弹出（`side: 'left'`），图标显示 `<Lucide.ChevronLeft />`；
- 当左侧可用空间不足且右侧空间更大时：朝右翻折（`side: 'right'`），图标动态切换为 `<Lucide.ChevronRight />`；
- 垂直方向：以父级服务商行顶部为基准对齐，当下边缘超出视口时向上自适应钳位，保证子菜单完整可见。

### 裁决 3：LayerStack 拓扑注册与外点保护
- 子菜单通过 `useLayerRegistration` 注册为 `type: 'cascade-submenu'`（优先级 50），显式传入 `parentId: parentMenuId`；
- 主菜单 `Menu.tsx` 在 `Popover.Content` 的 `onPointerDownOutside` 与 `onInteractOutside` 中，结合 `layerStackService.getDescendants(menuId)` 检查点击目标是否属于子孙层，若属于则立即 `e.preventDefault()`，彻底杜绝误杀父菜单。

### 裁决 4：彻底清除 JSX 声明式 `autoFocus`
- 父菜单服务商行与子菜单模型项中的 `autoFocus` 属性全部移除；
- 鼠标 Hover 展开时保持焦点静默；
- 键盘操作展开（`ArrowLeft` / `ArrowRight` / `Enter` / `Space`）时，通过受控 ref 显式调用目标项的 `.focus({ preventScroll: true })`；
- Esc 或反向箭头键关闭子菜单时，焦点精准归还给父级服务商行按钮。

---

## 4. 结论与下一步

三位专业子代理从不同维度产出的方案逻辑严密、证据确凿、相互印证，无任何本质冲突。评审结论为 **一致通过（Approved with Full Consensus）**。

主控将依据上述共识编制并发布最终的总实施方案 `docs/cascade-menu-repair/00-总方案.md`。
