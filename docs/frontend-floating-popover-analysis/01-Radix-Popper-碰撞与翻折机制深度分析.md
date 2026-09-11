# 01 - Radix Popper 碰撞与翻折机制深度分析报告

**分析者**：Agent 01 (Radix 碰撞与 Popper 引擎深度分析师)
**审计目标**：`apps/crish-desktop/src/components/ui/Menu/` 及底层依赖 `@radix-ui/react-popover`、`@radix-ui/react-popper`、`@floating-ui/react-dom`、`@floating-ui/dom`、`@floating-ui/core`
**审计基准**：源码穿透审计、运行期生命周期时序、数学几何模型推导、Ref/Slot 绑定机制

---

## 目录

1. **核心问题根因穿透：为什么 `side="top"` 依然发生向下翻折并撞击视口底部？**
2. **挂载生命周期与测量时序彻底穿透**
   - 2.1 挂载首帧（Mount Frame）防闪烁与异步测量状态机
   - 2.2 运行期观察者模型（ResizeObserver / ScrollObserver / LayoutShift）
   - 2.3 `avoidCollisions`、`collisionPadding` 与 `collisionBoundary` 决策树
   - 2.4 为什么翻折后不会向上回弹？自适应高度与滚动根治机制
3. **`Menu.tsx` 架构模式与 Ref 绑定深度审查**
   - 3.1 `Popover.Anchor virtualRef={...}` 的几何测量与时序差异
   - 3.2 `Popover.Trigger asChild` 的 `Slot` 机制与 Ref 抢占/丢失风险
4. **架构断层清单与治理建议（纯分析与技术断言）**

---

## 一、核心问题根因穿透：为什么 `side="top"` 会向下翻折并撞击视口底部？

### 1.1 依赖链路与中间件执行栈拓扑

在 Conex/Crish 前端架构中，菜单浮层定位链路如下：
`Menu.tsx` -> `@radix-ui/react-popover` (v1.1.x) -> `@radix-ui/react-popper` (v1.2.x) -> `@floating-ui/react-dom` -> `@floating-ui/dom` -> `@floating-ui/core`。

在 PopperContent 中，Radix 向 Floating UI 注入的中间件（Middleware）数组顺序如下：

```javascript
// node_modules/@radix-ui/react-popper/dist/index.mjs:139-173
middleware: [
  offset({ mainAxis: sideOffset + arrowHeight, alignmentAxis: alignOffset }), // [1]
  avoidCollisions && shift({                                                 // [2]
    mainAxis: true,
    crossAxis: false,
    limiter: sticky === "partial" ? limitShift() : void 0,
    ...detectOverflowOptions
  }),
  avoidCollisions && flip({ ...detectOverflowOptions }),                      // [3]
  size({                                                                      // [4]
    ...detectOverflowOptions,
    apply: ({ elements, rects, availableWidth, availableHeight }) => {
      const { width: anchorWidth, height: anchorHeight } = rects.reference;
      const contentStyle = elements.floating.style;
      contentStyle.setProperty("--radix-popper-available-width", `${availableWidth}px`);
      contentStyle.setProperty("--radix-popper-available-height", `${availableHeight}px`);
      contentStyle.setProperty("--radix-popper-anchor-width", `${anchorWidth}px`);
      contentStyle.setProperty("--radix-popper-anchor-height", `${anchorHeight}px`);
    }
  }),
  arrow && floatingUIarrow({ element: arrow, padding: arrowPadding }),        // [5]
  transformOrigin({ arrowWidth, arrowHeight }),                               // [6]
  hideWhenDetached && hide({ ... })                                           // [7]
]
```

---

### 1.2 碰撞检测的数学公式与几何模型推导

在 `detectOverflow` 中，Floating UI 计算元素四向溢出距离的数学定义为：

$$
\begin{aligned}
\text{overflow.top} &= \frac{\text{clipping.top} - \text{element.top} + \text{padding.top}}{\text{scale}_y} \\
\text{overflow.bottom} &= \frac{\text{element.bottom} - \text{clipping.bottom} + \text{padding.bottom}}{\text{scale}_y}
\end{aligned}
$$

其中：

- 视口高度 $V_h$（例如 $600\text{px}$ 或 $800\text{px}$），$\text{clipping.top} = 0$，$\text{clipping.bottom} = V_h$。
- 内边距 $\text{padding} = \text{collisionPadding} = 12\text{px}$（见 `Menu.tsx:328`）。
- 锚点在视口中的绝对纵坐标为 $Y_{\text{ref}}$，高度为 $H_{\text{ref}}$。
- 菜单自身在未受约束下的渲染高度为 $H_{\text{floating}}$（`Menu.module.css:11` 声明为 `max-height: min(70vh, 360px)`，在典型场景下 $H_{\text{floating}} \approx 280\text{px} \sim 360\text{px}$）。
- 间距 $\text{sideOffset} = 6\text{px}$。

#### 【阶段一：初始 `side="top"` 决策分支】

1. 初始坐标计算：
   $$Y_{\text{top}} = Y_{\text{ref}} - H_{\text{floating}} - \text{sideOffset}$$
2. 上边界溢出量计算：
   $$\text{overflow.top} = 0 - Y_{\text{top}} + 12 = -Y_{\text{ref}} + H_{\text{floating}} + \text{sideOffset} + 12$$
3. **触发翻折的充要条件**：
   只要锚点位置满足：
   $$Y_{\text{ref}} < H_{\text{floating}} + 18\text{px}$$
   则 $\text{overflow.top} > 0$！
4. 因为 $\text{overflow.top} > 0$，`flip` 判定 `initialPlacement`（`top`）发生碰撞，生成重置指令 `{ reset: { placement: "bottom" } }`，重新启动生命周期计算。

#### 【阶段二：翻折至 `side="bottom"` 后的碰撞与 `bestFit` 裁决】

1. 重新计算 `bottom` 坐标：
   $$Y_{\text{bottom}} = Y_{\text{ref}} + H_{\text{ref}} + \text{sideOffset}$$
   $$\text{element.bottom} = Y_{\text{bottom}} + H_{\text{floating}} = Y_{\text{ref}} + H_{\text{ref}} + 6 + H_{\text{floating}}$$
2. 下边界溢出量计算：
   $$\text{overflow.bottom} = \text{element.bottom} - V_h + 12 = Y_{\text{ref}} + H_{\text{ref}} + H_{\text{floating}} + 18 - V_h$$
3. 若此时处于低视口（如 $V_h = 600\text{px}$）或输入框位于窗口底部附近（如 $Y_{\text{ref}} = 350\text{px}$）：
   此时，`top` 与 `bottom` 两端均可能发生溢出。
4. `fallbackStrategy='bestFit'` 排序决议：
   `flip` 比较两端的正向溢出总量，由于下方溢出量被测算为略小于上方溢出量，`bestFit` 算法**强行判定 `bottom` 为最优解**，将 `resetPlacement` 锁定为 `bottom`！

---

### 1.3 翻折后直接撞击视口底部的两大架构断层

#### 断层 A：`shift` 中间件的轴向反转失效

在 `PopperContent` 中，Radix 显式配置 `crossAxis: false`。在垂直定位（`top`/`bottom`）模式下，Floating UI 内部的 `crossAxis` 才是垂直 Y 轴。这意味着 **`shift` 中间件被严格禁止在垂直 Y 轴做任何平移避让**！当菜单翻折到 `bottom` 且下方空间不足时，`shift` 根本不会将菜单向上推入视口内。

#### 断层 B：`size` 中间件与 CSS 样式解耦（CSS 变量悬空）

在 `PopperContent` 中，Radix 的 `size` 中间件实现为向 DOM 注入 CSS 自定义变量 `--radix-popper-available-height`（并在 Popover 层暴露为 `--radix-popover-content-available-height`）。

- **断裂点**：`Menu.module.css:11` 写死了静态的 `max-height: min(70vh, 360px)`，完全没有消费该变量！
- **闭环死锁**：DOM 元素高度依然保持 360px，`platform.getDimensions` 检测到 DOM 高度未缩小，菜单以完整高度 360px 绘制，直接穿透视口底部边界！

---

## 二、架构治理与根治方案

### 核心解法：响应式高度自适应（标准解法）

在 `Menu.module.css` 中让容器高度严格绑定 Radix 暴露的可用高度变量：

```css
.menuContent {
  max-height: min(
    var(--radix-popover-content-available-height, 360px),
    70vh,
    360px
  );
  overflow-y: auto;
}
```

**数学闭环证明**：
当菜单尝试在 `side="top"` 渲染时，`size` 中间件计算出 $\text{availableHeight} = Y_{\text{ref}} - \text{sideOffset} - \text{padding.top}$。
CSS 强制将 DOM 元素高度截断至该可用高度。代入溢出公式：
$$\text{overflow.top} = -Y_{\text{ref}} + (Y_{\text{ref}} - 18) + 18 = 0 \le 0$$
**因为 $\text{overflow.top} \le 0$，`flip` 中间件判定上方完美容纳，翻折判定永远不会被触发！菜单将永久锁定在 `side="top"`，内部超出内容自动呈现滚动条！**
