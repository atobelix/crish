# Conex / Crish 级联菜单重构方案红蓝对抗最终裁判报告

> **文档标识**：`docs/cascade-menu-repair/plan-reviews/04-final-verdict.md`
> **裁判发起**：主控 Agent（Orchestrator）
> **对抗双方**：
> - **红方（Red Team Challenger）**：[02-red-team-critique.md](file:///c:/Software/conex/docs/cascade-menu-repair/plan-reviews/02-red-team-critique.md)
> - **蓝方（Blue Team Defender）**：[03-blue-team-defense.md](file:///c:/Software/conex/docs/cascade-menu-repair/plan-reviews/03-blue-team-defense.md)
> **权威遵循**：`AGENTS.md`（反退避、纯逻辑规划、严禁打补丁）、`ANTI_OVERENGINEERING_GUARDRAILS.md`（反过度设计 13 项硬性红线）

---

## 1. 对抗复盘与裁判核心结论

经过红方（极限边界穿透质询）与蓝方（生产级韧性防御加固）的激烈对抗，双方不仅彻底摸清了问题的所有维度，更将方案打磨到了**数学级确定、零冗余抽象、百分百可验证**的极高水准。

### 裁判核心结论：
主控裁决采纳 **「吸收红方 4 项极简边界修复后的蓝方终极防御方案（Blue Team Hardened Solution + Red Team Fixes）」** 作为全仓最终实施方案。

---

## 2. 核心对抗焦点与裁判裁决对照表

| 对抗焦点 | 红方攻击与质疑 (`02-red-team-critique.md`) | 蓝方防御与加固 (`03-blue-team-defense.md`) | 主控最终裁判与落地实施标准 |
| :--- | :--- | :--- | :--- |
| **焦点 1：几何计算与视口双向受限** | 揭露原算法在左侧空间狭小但 $>0$（如 88px）且右侧同样不足时，`else if (spaceLeft <= 0)` 失效，依然输出负坐标 $X=-74\text{px}$；且右翻折缺少 `maxX` 钳位。 | 给出严格的数学级双向硬性钳位公式：$X_{\text{clamped}} = \min(\max(X_{\text{min}}, X_{\text{target}}), \max(X_{\text{min}}, X_{\text{max}} - W_{\text{sub}}))$。 | **完全采纳蓝方数学不变量**：消除所有经验分支，纯用刚性数学 Clamp 算子确保坐标永不为负（$X \ge 8\text{px}$）且永不向右越界。 |
| **焦点 2：父菜单滚动与子菜单脱节** | 父菜单长列表触发滚轮滚动时，`position: fixed` 的子菜单留在原地悬空漂移。批评了方案 03 试图引入全局 window capture scroll 监听的过度设计做法。 | 提出 Anchor 可视区溢出自动收起守卫；红方进一步提出更极简解法：在父容器原生 `onScroll` 事件中直接派发 `setExpandedProfileId(null)`。 | **采纳红方极简解法**：在主菜单内容容器的原生 `onScroll` 回调中自动收起子菜单，零全局事件开销，零性能损耗，优雅自愈。 |
| **焦点 3：手势穿梭与多行掠过竞态** | 鼠标快速在多个服务商行之间连续划过时，前一行的 150ms `leaveTimer` 容易误杀后一行刚刚展开的子菜单；且 Portal 脱离后父容器的 `onMouseLeave` 会误杀 SafeTriangle。 | 建立代际追踪（Generation Epoch / Token）与 5 重 RAII 清理网（组件卸载、菜单关闭、窗口失焦 `window.blur`、页面隐藏 `visibilitychange`）。 | **采纳代际 Token + RAII 清理网**：每次 Hover 切换生成单调递增的 `timerToken`，彻底清除旧闭包时序干扰；SafeTriangle 仅由几何判定与超时退出。 |
| **焦点 4：模态弹窗与 DialogOverlay 穿透** | 在设置模态框（Modal Dialog，`z-index: 1000`）内打开时，若 portal 到 `document.body`，子菜单会被 Dialog 遮罩压在底层并被 `aria-modal` 标记为 `inert`。 | 消费 `DialogOverlayContext`，处于 Dialog 内时挂载到 Dialog 内部容器，普通窗口挂载到 `document.body`。 | **完全采纳**：子菜单与主菜单共享 `DialogOverlayContext`，实现模态框与普通窗口的无缝同构。 |
| **焦点 5：Radix 外点判定与 LIFO 退栈** | 子菜单 Portal 化后，用户点击子菜单会被主菜单 Radix Popover 的 `onPointerDownOutside` 误判为外点误杀父菜单。 | 在 `Menu.tsx` 的 `onPointerDownOutside` 中增加 `layerStackService.getDescendants(menuId)` 放行；子菜单注册 `type: 'cascade-submenu'`（权重 50）。 | **完全采纳**：在基座 `Menu.tsx` 建立严谨的子孙层放行机制，既保护当前级联菜单，又惠及全仓所有级联组件。 |
| **焦点 6：反过度设计与代码极简度** | 严厉阻断了 150 行重复造轮子的 `useCascadeSubmenu` 抽象和全局 scroll 捕获器，要求将代码增量控制在极小范围。 | 仅增加一个纯几何计算函数 `calculateSubmenuPosition`，组件内直接复用 `SafeTriangleTracker` 与 `useLayerRegistration`，零重型抽象。 | **坚决贯彻反过度设计红线**：不增加额外第三方依赖，不新建冗余 Hook，纯函数计算 + 既有基建无损集成。 |

---

## 3. 最终胜出方案：蓝方工程韧性加固方案（加装红方 4 项极简修正）

终极方案由以下 4 个核心构件组成：

### 构件 1：纯函数刚性双向钳位几何引擎（`position.ts`）
```typescript
export interface SubmenuPlacementResult {
  x: number;
  y: number;
  side: 'left' | 'right';
  transformOrigin: string;
}

export function calculateSubmenuPosition(
  rowRect: DOMRect,
  submenuWidth = 190,
  submenuHeight = 280,
  sideOffset = 4,
  edgePadding = 8
): SubmenuPlacementResult {
  const vp = getEffectiveViewport();
  const minX = vp.offsetLeft + edgePadding;
  const maxX = vp.offsetLeft + vp.width - edgePadding;
  const minY = vp.offsetTop + edgePadding;
  const maxY = vp.offsetTop + vp.height - edgePadding;

  const spaceLeft = rowRect.left - minX - sideOffset;
  const spaceRight = maxX - rowRect.right - sideOffset;

  let side: 'left' | 'right' = 'left';
  let targetX = rowRect.left - submenuWidth - sideOffset;

  if (submenuWidth > spaceLeft && spaceRight >= spaceLeft) {
    side = 'right';
    targetX = rowRect.right + sideOffset;
  }

  // 刚性双向数学钳位，绝对防止任何负坐标或右侧越界
  const clampedX = Math.min(
    Math.max(minX, targetX),
    Math.max(minX, maxX - submenuWidth)
  );

  // 垂直方向：默认顶部对齐，底部贴边向上钳位
  const targetY = rowRect.top - 4;
  const clampedY = Math.min(
    Math.max(minY, targetY),
    Math.max(minY, maxY - submenuHeight)
  );

  return {
    x: clampedX,
    y: clampedY,
    side,
    transformOrigin: side === 'left' ? 'top right' : 'top left',
  };
}
```

### 构件 2：基座外点穿透与 Context 连通（`Menu.tsx`）
- 在 `Menu.tsx` 中创建并导出 `MenuContext = createContext<{ menuId: string | null }>({ menuId: null })`；
- 在 `onPointerDownOutside` 与 `onInteractOutside` 中，除了检查 `triggerEl.contains(target)`，增加：
  ```typescript
  const isDescendantLayer = layerStackService
    .getDescendants(menuId)
    .some((child) => {
      const el = child.elementRef.current;
      return el && target && el.contains(target);
    });
  if (isDescendantLayer) {
    e.preventDefault();
  }
  ```

### 构件 3：无 autoFocus 模态感知与 SafeTriangle 轨迹保护（`ModelBadgePickerMenu.tsx`）
- 彻底清除 JSX 节点上的 `autoFocus`；
- 鼠标 Hover 展开只更新 `expandedProfileId`，不触碰焦点与滚动；
- 键盘（`ArrowLeft` / `ArrowRight` / `Enter`）显式调用目标项 `.focus({ preventScroll: true })`；
- 集成 `SafeTriangleTracker`，在鼠标斜向滑向子菜单时提供 300ms 宽限期；
- 父容器 `onScroll` 时直接收起子菜单，防止漂移。

### 构件 4：Portal 独立挂载与 LayerStack 拓扑注册
- 子菜单通过 `createPortal` 挂载至 `dialogOverlay ?? document.body`；
- 子菜单调用 `useLayerRegistration`，注册为 `type: 'cascade-submenu'`（权重 50），传入 `parentId: parentMenuContext.menuId`；
- 支持 Esc 逐级退栈（50 先关，40 后关）。

---

## 4. 实施裁决与就绪状态

本裁判报告标志着方案规划与红蓝对抗阶段圆满完成。最终技术方案已在 `00-总方案.md` 中同步更新，随时可进入执行与自动化测试验证阶段。
