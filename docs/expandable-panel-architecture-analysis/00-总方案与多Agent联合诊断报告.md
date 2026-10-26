# 级联展开面板多 Agent 联合诊断与架构收敛报告

> **诊断时间**：2026-10-25
> **诊断对象**：`SmartExpandablePanel`、`SmartPanelCascadeSubmenu`、`ComposePlusMenu`、`PositionEngine`
> **参考设计基准**：`reference/展开面板设计.html`

---

## 一、用户核心疑问的正面解答

### 疑问 1：“现在这个展开面板是有很多地方都负责，导致了修改困难还是怎么样呢？”
**回答：完全命中痛点！目前的展开面板确实处于严重的“多头负责、相互踩踏”状态。**

经多 Agent 全景代码链路穿透分析，当前展开面板被 4 个完全不同源的技术方案强行拼凑在一起：
1. **基础定位层（Radix）**：主面板包裹了 `@radix-ui/react-popover`，由 Radix Popper 负责视口边界与锚点定位；
2. **脱壳子菜单层（Portal + 手写 Engine）**：二级级联子菜单脱离了 Radix，采用 `ReactDOM.createPortal` 强行逃逸到全局 `document.body`，由自研的 `PositionEngine` 计算绝对坐标；
   - **后果**：主菜单是 Radix 的 Popper 局部坐标系，子菜单是 Window 的绝对屏幕坐标系，两者处于两套完全割裂的生命周期、坐标系和重绘机制中；
3. **双重样式继承层（CSS 冲突）**：
   - 子菜单不仅引用了通用菜单的 `Menu.module.css`（里面写死了 `max-height: 640px` 与 `overflow-y: auto`），又叠加了 `SmartExpandablePanel.module.css` 的 `.cascadeSubmenu`；
   - 两套 CSS Modules 都在抢夺 `max-height`、`overflow`、`border-radius` 与 `padding` 的解释权；
4. **状态与事件层（三方争抢）**：
   - `LayerStackManager` 维护图层栈与 Esc/点外关闭；
   - `Radix Popover` 也有自己的 `onPointerDownOutside`；
   - `SafeAimEngine` 维护单例 SVG 虚拟图层与 4 个散落的 `setTimeout` 定时器。

**结论**：多头负责导致了极大的修改摩擦力——“改了 PositionEngine 碰到了 CSS 继承，改了 CSS 又破坏了 Radix Portal，改了滚动条又割断了外圆角”。

---

## 二、六维 Agent 协同诊断结论

### 维度 1：调用方矩阵与意图失衡（Caller Matrix）
* **全仓现状**：全仓共有 `ComposePlusMenu`、`ChatHeaderMore`、`SelectAdapter`、`MenuAdapter` 等 9 处调用。
* **致命矛盾**：
  * 在 `ComposePlusMenu` 中，主菜单只有 **2 个选项**（`添加文件或附件`、`使用 skill`），高度仅约 **80px**；
  * 而展开的技能列表却有 **12 个条目**（真实展开高度曾高达 440px）；
  * 一个 80px 的超矮主菜单，强行唤起一个 440px 的庞大子菜单，主子比例达 1:5.5，造成严重的视觉与物理失衡。

### 维度 2：原型设计与落实现状断层（Prototype Gap）
* **原型标准（`reference/展开面板设计.html`）**：
  * 原型是单一 DOM 树 + 单一生命周期引擎（`SmartExpandablePanelEngine`）统一调度，没有外部 Popover 库干扰；
  * **原型中外层卡片绝无滚动条**：外层卡片始终保持完美的同心圆角与阴影；滚动条只在内部列表（`#itemList`）超出时以 4px 微调微条滚动。
* **落实现状断层**：
  * 落实现状此前把 `overflow-y: auto` 粗暴加在 `.cascadeSubmenu` 外层，直接把滚动条贴在 14px 外边框上，把外圆角切成了直角。

### 维度 3：几何定位与垂直脱节（Geometry & Placement）
* **“冲上天际”的根因**：
  * 当主菜单在底部（y=700，高80px），子菜单高达 440px 时，原算法为避免底部溢出，把 `top` 计算为 `788 - 440 = 348px`；
  * 导致子菜单顶部冲到 y=348，主菜单留在 y=700，两者垂直重叠区域仅剩下 48px，80% 的子菜单悬浮在主菜单上方的虚空里！

### 维度 4：Safe Aim 物理穿空与交互摩擦（Interaction Friction）
* **轨迹断裂**：
  * 当子菜单顶部冲到 y=348 时，用户鼠标想要去点第 1 个技能，必须从 (100, 700) 跨越大面积空白工作区斜向大角度移动到 (250, 360)；
  * 光标脱离主菜单触发了 `onMouseLeave`，而大角度斜向移动又极易触发 Safe Aim 倒退判定，导致菜单在移动中闪退。

### 维度 5：视觉层叠与滚动条失控（Styling & Scrollbars）
* **用户指出的核心痛点**：
  1. “带有多个选项列表的，肯定是不能超过容器的一定高度的呀，不然的话不就太长了嘛”；
  2. “不需要在整个级联面板的最外层加上这个滚动条，显得超级丑好吗（当然有一种情况是高度不够了，这样才需要加上这个滚动条，其余的时候不允许加上这个滚动条的）”。

---

## 三、彻底架构重构方案落地（Shell - Body - Footer 三段式）

为了彻底根治上述问题，我们彻底废弃了以往的局部修补，实行了严谨的 **Shell - Body - Footer 三段式架构**：

```
┌──────────────────────────────────────────────┐
│ .cascadeSubmenu (Shell)                      │
│ - 纯外层卡片，overflow: visible (绝对无滚动条) │
│ - 14px 纯净同心圆角、6px 统一内衬、阴影与背景  │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ .cascadeListBody (Body)                │  │
│  │ - 弹性条目容器，max-height: 240px (~7项)│  │
│  │ - 仅在条目 > 7 项时才在内部展示 4px 微条 │  │
│  │ - 条目 <= 7 项时 100% 纯净零滚动条      │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ .cascadeFooter (Footer)                │  │
│  │ - 底部固定操作栏（分割线 + 管理技能...）  │  │
│  │ - 永远吸附在卡片底部，绝不随滚动条移出   │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

### 1. 结构解耦与滚动条归位
- **外层卡片 Shell (`.cascadeSubmenu`)**：
  设置 `overflow: visible;`，移除一切外层滚动条，彻底保护 14px 外圆角与阴影；
- **内层数据 Body (`.cascadeListBody`)**：
  `max-height: 240px;`（约 7 项高度），设置 `overflow-y: auto;`。
  当项数少于等于 7 项时，完全不出现滚动条；
  当项数超出时，**仅在列表内部渲染 4px 极细微调滚动条**，距离外边框有 6px 内衬保护，再也不破坏外层质感；
- **底部常驻 Footer (`.cascadeFooter`)**：
  自动识别尾部分割线与常驻操作（`action:manage-skills`），将其作为固定 Footer 吸附在底端，无论技能列表如何滚动，“管理技能...”始终清晰可见、易于点击。

### 2. 高度预算刚性控制与几何收敛
- 将最大限制高度从失控的 760px/440px 刚性收敛至 **`MAX_CASCADE_PANEL_HEIGHT = 300px`**（内层 240px + 底栏 44px + 内衬 12px）；
- **效果**：即便主菜单只有 80px，子菜单也仅约为 290px，向上抬升时仅仅高出主菜单约 100px，两者保持紧密拥抱对齐，Safe Aim 处于最佳锥形角度，彻底消除“上冲天际、父子错位 350px”的荒谬感！
