# ModelBadgePickerMenu 级联菜单几何布局与 CSS 渲染独立修复方案

> **文档标识**：`docs/cascade-menu-repair/independent-plans/01-ui-geometry-plan.md`  
> **角色定位**：UI 渲染与几何布局专家（UI & Geometry Architect）  
> **权威遵循**：`AGENTS.md`（反退避与架构优雅铁律）、`.agents/LOGIC_PLAN_NO_RETREAT.md`  
> **目标组件**：`apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx` 及同类级联菜单体系

---

## 1. 执行摘要与问题定义

在 Conex / Crish 桌面工作区中，用户点击底部工具栏或卡片顶栏的模型徽标（Model Badge）展开 `ModelBadgePickerMenu` 主菜单后，当鼠标 Hover 到包含可用模型的服务商行（如「OpenCode Go 订阅」）时，系统出现严重的 UI 渲染故障：
1. **二级级联子菜单（`.mbSubMenu`）未正常弹出并完全不可见**；
2. **主菜单（`.mbMenu`）右侧异常出现垂直滚动条，伴随主菜单内容抖动与宽度挤压**；
3. **视口边界越界隐患**：二级菜单硬编码向左弹出（`right: calc(100% + 4px)`），当主菜单位于屏幕左侧时存在坐标越界截断（$X < 0$）的物理风险。

本方案基于 W3C CSS 盒模型标准、滚动容器上下文（Scroll Container & Containing Block）以及几何向量碰撞算法，给出彻底根除此问题的 Portal 解耦、视口自适应翻转（Flip）、Chevron 图标动态同步及 SafeTriangle 防闪退架构方案。

---

## 2. 问题机理与 CSS 裁剪/视口越界深层分析

### 2.1 W3C CSS 包含块与溢出裁剪机理（Root Cause Analysis）

根据 W3C CSS Overflow Level 3 与 CSS Box Model 规范：

```
┌──────────────────────────────────────────────────────────────────────────┐
│  .menuContent / .mbMenu (Scroll Container, Containing Block)             │
│  - max-height: min(360px, 70vh)                                          │
│  - overflow-y: auto; overflow-x: hidden;                                 │
│  ┌──────────────────────────────────────────────┐                        │
│  │ .mbRowContainer (position: relative)         │                        │
│  │ ┌──────────────────────────────────────────┐ │                        │
│  │ │ .mbRow (Button)                          │ │                        │
│  │ └──────────────────────────────────────────┘ │                        │
│  │                                              │                        │
│  │ ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐                │                        │
│  │   .mbSubMenu (position: abs)                 │                        │
│  │   right: calc(100% + 4px)   │                │                        │
│  │   width: 190px;                              │                        │
│  │ └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘                │                        │
│  │         ▲                                    │                        │
│  │         │                                    │                        │
│  │  X 轴超出左边界 (负坐标)                      │                        │
│  │  被 overflow-x: hidden 强制截断 (不可见)     │                        │
│  └──────────────────────────────────────────────┘                        │
│                                                 │                        │
│  Y 轴计算高度 = Row + SubMenu 高度 (280px)      ▼ 触发 Y 轴滚动条        │
│  撑大 Scrollable Overflow Area ───────────────► 产生垂直 Scrollbar      │
└──────────────────────────────────────────────────────────────────────────┘
```

#### 关键源码定位与断层证据：

1. **主菜单滚动容器声明**（`apps/crish-desktop/src/components/ui/Menu/Menu.module.css:16-22` & `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css:12-19`）：
   ```css
   /* Menu.module.css */
   .menuContent {
     max-height: min(var(--radix-popover-content-available-height, 360px), 70vh, 360px);
     overflow-y: auto;
     overflow-x: hidden;
   }
   /* ModelBadgePickerMenu.module.css */
   .mbMenu {
     width: 170px;
     max-height: min(var(--radix-popover-content-available-height, 360px), 70vh, 360px);
     overflow-y: auto;
   }
   ```
2. **包含块内联嵌套与绝对定位**（`apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx:113-146`）：
   ```tsx
   <div
     key={p.id}
     className={styles.mbRowContainer}
     onMouseEnter={() => handleRowEnter(p.id)}
     onMouseLeave={handleRowLeave}
   >
     <button className={styles.mbRow}>...</button>
     {isExpanded && hasModels && (
       <div className={styles.mbSubMenu} role="menu">...</div>
     )}
   </div>
   ```
3. **内联子菜单定位属性**（`apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css:32-35, 73-93`）：
   ```css
   .mbRowContainer {
     position: relative;
     width: 100%;
   }
   .mbSubMenu {
     position: absolute;
     top: -4px;
     right: calc(100% + 4px);
     width: 190px;
     max-height: min(var(--radix-popover-content-available-height, 280px), 70vh, 280px);
     overflow-y: auto;
   }
   ```

#### 故障机理三步推导：
- **步骤 1（包含块捕获）**：`.mbSubMenu` 声明为 `position: absolute`，其向上寻找最近的 non-static 祖先为 `.mbRowContainer`（`position: relative`）。
- **步骤 2（X 轴剪裁隐身）**：`.mbSubMenu` 偏移为 `right: calc(100% + 4px)`，在水平方向脱离 `.mbRowContainer` 并在主菜单左侧 $-194\text{px}$ 处排布。祖先 `.menuContent` 具备 `overflow-x: hidden`（以及 `overflow-y: auto` 隐式形成的滚动容器裁剪盒）。根据 CSS 规范，所有超出滚动容器内边距盒（Padding Box）的像素被严格剪裁不可见。
- **步骤 3（Y 轴溢出与滚动条异常）**：虽然 $X$ 轴被裁剪，但在 CSS 布局计算中，`.mbSubMenu` 依然占据垂直方向的物理尺寸（`max-height: 280px`）。当它在包含块内挂载时，滚动容器的 **Scrollable Overflow Rectangle** 在 $Y$ 方向被动膨胀。由于容器设置了 `overflow-y: auto`，主菜单立即触发垂直滚动条，压缩主菜单有效宽度并破坏视觉对齐。

---

### 2.2 视口越界与硬编码缺陷

在原实现中存在严重的单向硬编码：
1. **弹出方向单向硬编码**：`right: calc(100% + 4px)` 强制向左展开。
2. **指示箭头单向硬编码**（`ModelBadgePickerMenu.tsx:137-139`）：
   ```tsx
   {hasModels && (
     <Lucide.ChevronLeft size={14} className={styles.mbChevron} />
   )}
   ```
3. **视口边界越界危害**：
   - 典型场景：用户将窗口缩窄（如 600px 视口）或在屏幕左侧激活徽标（如 $X_{\text{anchor}} \le 200\text{px}$），主菜单位于 $X = 12\text{px}$。
   - 子菜单向左弹出需要 $190\text{px} + 4\text{px}$，计算得到二级菜单的绝对横坐标为：
     $$X_{\text{sub}} = 12\text{px} - 194\text{px} = -182\text{px} < 0$$
   - 此时即便消除 CSS 裁剪，二级菜单也将穿出视口左边界（负坐标），用户完全无法点击模型项。

---

## 3. 几何与布局改造方案（Geometry & Layout Architecture）

### 3.1 核心解耦架构：从「内联 DOM 嵌套」到「Portal 独立浮层」

为了彻底消除滚动容器裁剪，必须在 **DOM 树物理层面** 实现主菜单容器与二级级联浮层的完全解耦。

```
【重构前：内联嵌套，受父级 overflow 剪裁】
Popover.Portal (主菜单)
  └── Popover.Content (.menuContent .mbMenu [overflow-y: auto, overflow-x: hidden])
        └── .mbRowContainer (position: relative)
              ├── .mbRow (Button)
              └── .mbSubMenu (position: absolute) ───► 被 .menuContent 剪裁并撑大 Y 轴！

【重构后：Portal 独立挂载，几何引擎精确定位】
Popover.Portal (主菜单)
  └── Popover.Content (.menuContent .mbMenu [overflow-y: auto])
        └── .mbRowContainer
              └── .mbRow (Button, 作为二级子菜单的 Anchor)

Popover.Portal (二级级联子菜单，独立挂载至 body 或 #dialog-overlay)
  └── Popover.Content / SubmenuPanel (.mbSubMenuPanel)
        ├── 物理逃逸主菜单的 overflow 裁剪
        ├── 不撑大主菜单 scrollHeight
        └── 基于 calculateSubmenuPosition / Radix Anchor 实现视口自适应
```

### 3.2 级联子菜单定位策略与自适应计算引擎

二级菜单定位基于仓内标准几何引擎 `apps/crish-desktop/src/components/ui/Menu/position.ts` 的 `calculateMenuPosition` 进行针对性扩展，实现二级子菜单的精确排布。

#### 二级子菜单定位算法规范（Submenu Geometry Engine）：

```typescript
export interface SubmenuPlacementResult {
  x: number;
  y: number;
  side: 'left' | 'right';
  transformOrigin: string;
  isFlippedX: boolean;
}

export function calculateSubmenuPosition(
  rowRect: DOMRect,
  submenuWidth = 190,
  submenuHeight = 280,
  sideOffset = 4,
  edgePadding = 8
): SubmenuPlacementResult {
  const vp = getEffectiveViewport();
  
  // 1. 水平可用空间分析
  // 左侧可用空间：行左边缘至视口左边界
  const spaceLeft = rowRect.left - vp.offsetLeft - sideOffset - edgePadding;
  // 右侧可用空间：行右边缘至视口右边界
  const spaceRight = vp.offsetLeft + vp.width - rowRect.right - sideOffset - edgePadding;

  let side: 'left' | 'right' = 'left';
  let targetX = rowRect.left - submenuWidth - sideOffset;
  let isFlippedX = false;

  // 2. 水平放置决策：默认向左；若左侧放不下且右侧空间更大，则翻转至右侧
  if (submenuWidth > spaceLeft && spaceRight > spaceLeft) {
    side = 'right';
    targetX = rowRect.right + sideOffset;
    isFlippedX = true;
  } else if (submenuWidth > spaceLeft && spaceLeft <= 0) {
    // 左右空间均极其受限时强制贴靠屏幕边缘
    targetX = Math.max(vp.offsetLeft + edgePadding, targetX);
  }

  // 3. 垂直对齐决策：默认顶部对齐 (align: start, top: rowRect.top - 4)
  let targetY = rowRect.top - 4;
  const maxAvailableHeight = vp.offsetTop + vp.height - edgePadding;
  
  if (targetY + submenuHeight > maxAvailableHeight) {
    // 底部超出，向上提升对齐
    targetY = Math.max(
      vp.offsetTop + edgePadding,
      maxAvailableHeight - submenuHeight
    );
  }

  const transformOrigin = `${side === 'left' ? 'top right' : 'top left'}`;

  return {
    x: Math.round(targetX),
    y: Math.round(targetY),
    side,
    transformOrigin,
    isFlippedX,
  };
}
```

---

## 4. 视口防碰撞与左右翻转检测（Flip & Directional Sync）

### 4.1 左右翻折与 Chevron 箭头动态同步矩阵

为保证视觉一致性与指引明确性，Chevron 指示箭头必须与实际计算出的弹出方向严格保持同步：

| 触发场景 | 视口几何条件 | 展开方向 (`side`) | Chevron 图标 | 变换原点 (`transform-origin`) |
| :--- | :--- | :--- | :--- | :--- |
| **标准桌面（空间充裕）** | `spaceLeft >= 194px` | `'left'`（向左展开） | `<Lucide.ChevronLeft />` | `top right` |
| **靠左窗口 / 极窄分屏** | `spaceLeft < 194px` 且 `spaceRight >= 194px` | `'right'`（向右翻折） | `<Lucide.ChevronRight />` | `top left` |
| **极限挤压（左右均不足）** | `spaceLeft < 194px` 且 `spaceRight < 194px` | 偏向较大侧并启用视口钳位 | 相应方向箭头 | 边缘对齐原点 |

### 4.2 行指示箭头的双向渲染机制

在 `ModelBadgePickerMenu.tsx` 中，根据子菜单预估/实时判定方向渲染 Chevron：
```tsx
const isFlippedToRight = preferredSubmenuSide === 'right';

{hasModels && (
  isFlippedToRight ? (
    <Lucide.ChevronRight size={14} className={styles.mbChevron} />
  ) : (
    <Lucide.ChevronLeft size={14} className={styles.mbChevron} />
  )
)}
```

### 4.3 SafeTriangle 向量三角区防闪退协同

当用户鼠标从父级服务商行斜向滑向二级子菜单时，光标极易短暂穿过相邻的其他服务商行。若无缓冲防护，相邻行的 `handleRowEnter` 会瞬间切换展开项，导致二级子菜单闪退。

引入已在仓内验证的 `SafeTriangleTracker`（`apps/crish-desktop/src/components/ui/internal/SafeTriangle.ts:127-203`）：
- 当光标离开行按钮并朝向子菜单移动时，根据光标点 $P(x,y)$ 与二级子菜单包围盒 $V_{\text{top}}, V_{\text{bottom}}$ 构造 Safe Triangle。
- 在 300ms Grace Period 内，若后续指针在三角形内部，锁定当前 `expandedProfileId` 不被相邻行 hover 抢占；
- 指针进入二级菜单内容区后，调用 `safeTrackerRef.current.reach()` 常驻展开。

---

## 5. 精确的 CSS 改造与 DOM 结构方案

### 5.1 DOM 结构演进对比

#### 原结构（有问题）：
```html
<Menu panel={{ contentClassName: "mbMenu" }}>
  <!-- mbMenu 带有 overflow-y: auto -->
  <div class="mbRowContainer">
    <button class="mbRow">
      <span class="mbRowText">OpenCode Go 订阅</span>
      <ChevronLeft class="mbChevron" />
    </button>
    <!-- 错误：子菜单内嵌在滚动容器中 -->
    <div class="mbSubMenu">...</div>
  </div>
</Menu>
```

#### 新结构（方案 A：基于 Radix Popover 级联 Submenu 组件）：
```html
<Menu panel={{ contentClassName: "mbMenu" }}>
  <div class="mbRowContainer">
    <button ref={rowRef} class="mbRow">
      <span class="mbRowText">OpenCode Go 订阅</span>
      <!-- 动态 Chevron 图标 -->
      <ChevronLeft / ChevronRight class="mbChevron" />
    </button>
  </div>
</Menu>

<!-- 独立挂载至 Popover.Portal 的二级浮层 -->
<Popover.Portal container={dialogOverlay ?? undefined}>
  <div
    class="mbSubMenuFloating"
    data-side="left|right"
    style="position: fixed; left: ${x}px; top: ${y}px;"
    role="menu"
    aria-label="服务商模型列表"
  >
    <!-- 子菜单模型列表项 -->
    <button class="mbSubRow">...</button>
  </div>
</Popover.Portal>
```

---

### 5.2 CSS 精确改造对比（`ModelBadgePickerMenu.module.css`）

```diff
Index: apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css
===================================================================
--- apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css
+++ apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css
@@ -1,7 +1,7 @@
 .mbMenu {
   width: 170px;
   background: var(--bg-elevated);
   border: 1px solid var(--border-color);
   border-radius: var(--radius-xl);
   box-shadow: var(--shadow-lg);
   padding: var(--space-1);
   display: flex;
   flex-direction: column;
   animation: crish-popover-enter var(--transition-popover-enter) forwards;
   transform-origin: top left;
   max-height: min(
     var(--radix-popover-content-available-height, 360px),
     70vh,
     360px
   );
   overflow-y: auto;
+  overflow-x: hidden;
   -webkit-app-region: no-drag;
 }
 
 .mbMenuExit {
   animation: crish-popover-exit var(--transition-popover-exit) forwards;
 }
 
 .mbEmpty {
   padding: 12px 10px;
   text-align: center;
   font-size: var(--font-size-sm);
   color: var(--text-tertiary);
 }
 
 .mbRowContainer {
-  position: relative;
   width: 100%;
 }
 
 .mbRow {
   display: flex;
   align-items: center;
   gap: var(--space-2);
   width: 100%;
   border: none;
   background: transparent;
   padding: 7px 8px;
   border-radius: var(--radius-lg);
   cursor: pointer;
   font-family: inherit;
   text-align: left;
   transition: background var(--transition-micro);
   color: var(--text-primary);
 }
 
 .mbRow:hover,
 .mbRow.isExpanded {
   background: var(--bg-hover);
 }
 
 .mbRowText {
   flex: 1;
   font-size: var(--font-size-sm);
   font-weight: var(--font-weight-normal);
   color: var(--text-primary);
   overflow: hidden;
   text-overflow: ellipsis;
   white-space: nowrap;
 }
 
 .mbChevron {
   color: var(--text-tertiary);
   flex-shrink: 0;
 }
 
-/* 废弃原内联绝对定位 .mbSubMenu */
-.mbSubMenu {
-  position: absolute;
-  top: -4px;
-  right: calc(100% + 4px);
-  width: 190px;
-  background: var(--bg-elevated);
-  border: 1px solid var(--border-color);
-  border-radius: var(--radius-xl);
-  box-shadow: var(--shadow-lg);
-  padding: var(--space-1);
-  z-index: var(--z-sidebar-menu);
-  display: flex;
-  flex-direction: column;
-  max-height: min(
-    var(--radix-popover-content-available-height, 280px),
-    70vh,
-    280px
-  );
-  overflow-y: auto;
-  -webkit-app-region: no-drag;
-}
+/* 新增独立 Portal 挂载的子菜单样式 */
+.mbSubMenuFloating {
+  position: fixed;
+  width: 190px;
+  background: var(--bg-elevated);
+  border: 1px solid var(--border-color);
+  border-radius: var(--radius-xl);
+  box-shadow: var(--shadow-lg);
+  padding: var(--space-1);
+  z-index: var(--z-dropdown-menu, 400);
+  display: flex;
+  flex-direction: column;
+  max-height: min(
-    var(--radix-popover-content-available-height, 280px),
-    70vh,
-    280px
-  );
-  overflow-y: auto;
-  overflow-x: hidden;
-  -webkit-app-region: no-drag;
-  animation: crish-popover-enter var(--transition-popover-enter) forwards;
-}
```

---

### 5.3 LayerStack 与 Escape 键分层管理

在 Portal 化后，二级子菜单与主菜单在 DOM 树上成为平级兄弟，必须确保键盘与焦点行为严格符合分层栈契约：
1. **Esc 逐级关闭契约**（`ModelBadgePickerMenu.tsx:89-98`）：
   - 当二级子菜单展开时，按 `Escape` 拦截事件（`event.preventDefault()`），仅关闭二级子菜单，并将焦点归还至当前服务商行按钮（`rowRefsRef.current[expandedProfileId]?.focus()`）；
   - 二级子菜单关闭后，再次按 `Escape`，放行至 `Menu` 基座，关闭整个 `ModelBadgePickerMenu`。
2. **Outside Click / Hover 判定**：
   - 鼠标在二级子菜单内部点击或移动时，阻止主菜单触发 `onInteractOutside`。

---

## 6. 全仓同类组件影响与兼容性评估

对前端代码库中所有涉及多级级联或下拉展开的组件进行全面扫描与比对分析：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 全仓同类组件架构横向对比                                                    │
├──────────────────────────┬──────────────────────┬───────────────────────────┤
│ 组件名                   │ 当前实现方式         │ 潜在风险 / 架构对齐建议   │
├──────────────────────────┼──────────────────────┼───────────────────────────┤
│ ModelBadgePickerMenu     │ 内联绝对定位         │ 当前存在剪裁与滚动条膨胀  │
│                          │ (right: calc(100%))  │ ──► 本方案作为基准重构    │
├──────────────────────────┼──────────────────────┼───────────────────────────┤
│ ProjectPickerMenu        │ 局部 overflow:visible│ 当前仅在非滚动区域有效    │
│                          │ + 内部 .scrollArea   │ 若未来迁移至滚动行内需   │
│                          │ + 内联 left: 100%    │ 统一迁移至 Portal 架构    │
├──────────────────────────┼──────────────────────┼───────────────────────────┤
│ ModelsCascadeSelect      │ 内联绝对定位         │ 依赖父级 overflow:visible │
│ (ModelProfileList.tsx)   │ + SafeTriangleTracker│ 在极窄设置面板中存在越界  │
│                          │                      │ 建议后续对齐翻转检测      │
├──────────────────────────┼──────────────────────┼───────────────────────────┤
│ FileBreadcrumb           │ Radix Popover        │ 已实现自适应对齐与翻折    │
│                          │ (Portal 挂载)        │ 架构健全，无需改动        │
└──────────────────────────┴──────────────────────┴───────────────────────────┘
```

### 关键组件详析：

1. **`ProjectPickerMenu.tsx`**：
   - 当前在 `panel.contentStyle` 中显式设置了 `{ overflow: 'visible' }`，并将滚动限制在内部 `.scrollArea`（`max-height: 180px`）。
   - 「添加项目」级联菜单位于 `.scrollArea` 外部（分割线下方），因此未被剪裁。
   - **改进建议**：当前硬编码 `left: 100%`（向右展开），在靠近屏幕右侧时有越界风险。建议后续复用本方案的 `calculateSubmenuPosition`。

2. **`ModelsCascadeSelect`（`ModelProfileList.tsx:20-157`）**：
   - 使用了 `SafeTriangleTracker` 保护鼠标斜切轨迹（`line 83-104`），值得在 `ModelBadgePickerMenu` 中吸收。
   - 但其 `.cascadeFlyout` 同样硬编码 `right: calc(100% + 6px)`（`ModelsSettingsTab.module.css:1058`），在左侧空间不足时存在越界隐患。

---

## 7. 验收与断言标准（Verification Matrix）

本方案包含覆盖极限几何场景、物理尺寸、键盘流与渲染断言的自动化验证套件设计：

### 7.1 Vitest 单元与集成测试用例设计

在 `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.test.tsx` 及 `PhysicalGeometryGuards.test.tsx` 中追加以下断言用例：

```typescript
describe('ModelBadgePickerMenu 级联几何与渲染脱截守卫 (GEO-CASCADE-01 ~ 06)', () => {
  // GEO-CASCADE-01: 主菜单滚动条绝不因 Hover 子菜单而异常出现
  it('GEO-CASCADE-01: Hover 展开二级菜单时，主菜单 scrollHeight 恒等于 clientHeight，滚动条不出现', async () => {
    seedProfiles();
    render(<Wrapper />);
    const menuContent = await screen.findByRole('dialog');
    const initialScrollHeight = menuContent.scrollHeight;

    // Hover 展开子菜单
    const row = screen.getByTestId('profile-item-p1');
    fireEvent.mouseEnter(row);

    await waitFor(() => {
      expect(screen.getByRole('menu', { name: /测试服务商/ })).toBeInTheDocument();
    });

    // 断言：主菜单的 scrollHeight 绝不发生跳变
    expect(menuContent.scrollHeight).toBe(initialScrollHeight);
    expect(menuContent.classList.contains('hasVerticalScrollbar')).toBe(false);
  });

  // GEO-CASCADE-02: 600x400 低视口左侧锚定自适应向右翻折 (Flip Right)
  it('GEO-CASCADE-02: 视口宽度 600px 且徽标在 X=20px 靠左位置时，二级菜单向右展开且 Chevron 指向右侧', async () => {
    MockPhysicalGeometryEngine.getInstance().setViewport({ width: 600, height: 400 });
    render(<Wrapper anchorRect={{ left: 20, top: 350, width: 100, height: 32 }} />);
    
    const row = screen.getByTestId('profile-item-p1');
    fireEvent.mouseEnter(row);

    const subMenu = await screen.findByRole('menu', { name: /测试服务商/ });
    const subRect = subMenu.getBoundingClientRect();

    // 断言：二级菜单在主菜单右侧 (X >= 170px)，且完全在视口内 (X + W <= 592px)
    expect(subRect.left).toBeGreaterThanOrEqual(170);
    expect(subRect.right).toBeLessThanOrEqual(592);
    expect(subRect.left).toBeGreaterThanOrEqual(8);
    
    // 断言：Chevron 箭头渲染为 ChevronRight
    expect(row.querySelector('svg.lucide-chevron-right')).toBeInTheDocument();
  });

  // GEO-CASCADE-03: 1200x800 充裕视口标准向左展开 (Flip Left)
  it('GEO-CASCADE-03: 视口宽度 1200px 且空间充裕时，二级菜单向左展开且 Chevron 指向左侧', async () => {
    MockPhysicalGeometryEngine.getInstance().setViewport({ width: 1200, height: 800 });
    render(<Wrapper anchorRect={{ left: 600, top: 350, width: 100, height: 32 }} />);
    
    const row = screen.getByTestId('profile-item-p1');
    fireEvent.mouseEnter(row);

    const subMenu = await screen.findByRole('menu', { name: /测试服务商/ });
    const subRect = subMenu.getBoundingClientRect();

    // 断言：二级菜单在主菜单左侧
    expect(subRect.right).toBeLessThanOrEqual(600);
    expect(subRect.left).toBeGreaterThanOrEqual(8);
    
    // 断言：Chevron 箭头渲染为 ChevronLeft
    expect(row.querySelector('svg.lucide-chevron-left')).toBeInTheDocument();
  });

  // GEO-CASCADE-04: Esc 逐级关闭与焦点归还沙盒
  it('GEO-CASCADE-04: 二级菜单展开时第一击 Esc 仅关闭子菜单并归还焦点，第二击 Esc 关闭主菜单', async () => {
    seedProfiles();
    const onClose = vi.fn();
    render(<Wrapper onClose={onClose} />);

    const row = screen.getByTestId('profile-item-p1');
    fireEvent.click(row);

    const subMenu = await screen.findByRole('menu', { name: /测试服务商/ });
    expect(subMenu).toBeInTheDocument();

    // 第一击 Esc
    fireEvent.keyDown(subMenu, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: /测试服务商/ })).not.toBeInTheDocument();
    });
    expect(row).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    // 第二击 Esc
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  // GEO-CASCADE-05: 物理脱截验证（不在主菜单 DOM 树内）
  it('GEO-CASCADE-05: 二级子菜单节点挂载在 Portal 根，主菜单不是其 DOM 祖先', async () => {
    seedProfiles();
    render(<Wrapper />);
    
    const row = screen.getByTestId('profile-item-p1');
    fireEvent.mouseEnter(row);

    const subMenu = await screen.findByRole('menu', { name: /测试服务商/ });
    const menuDialog = screen.getByRole('dialog');

    expect(menuDialog.contains(subMenu)).toBe(false);
    expect(document.body.contains(subMenu)).toBe(true);
  });
});
```

---

## 8. 实施路径与演进路线

1. **第一阶段（几何算法库就绪）**：在 `apps/crish-desktop/src/components/ui/Menu/position.ts` 中封装 `calculateSubmenuPosition` 函数，覆盖双向 Flip、视口边界垫片与 transformOrigin 计算。
2. **第二阶段（组件解耦与 Portal 化）**：重构 `ModelBadgePickerMenu.tsx` 与 `ModelBadgePickerMenu.module.css`，将 `.mbSubMenu` 剥离出 `.mbRowContainer` 并挂载于 `Popover.Portal`，注入动态方向判定与 Chevron 箭头切换。
3. **第三阶段（交互增强与防闪退）**：集成 `SafeTriangleTracker`，保障鼠标斜切操作流畅度与 300ms 宽限保护。
4. **第四阶段（全量回归验证）**：运行 `npm run test` 与 `PhysicalGeometryGuards.test.tsx`，确保所有低视口（400x600, 600x400）与分屏场景 100% 绿灯。

---
*方案编制人：UI & Geometry Architect*  
*编制时间：2026-08-20*
