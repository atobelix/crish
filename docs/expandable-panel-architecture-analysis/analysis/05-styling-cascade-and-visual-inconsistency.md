# 展开面板架构审查 05：样式层叠污染、滚动条挂载错位与同心圆角失真分析

> **审查定位**：聚焦 `SmartExpandablePanel.module.css`、`Menu.module.css`、`SmartPanelCascadeSubmenu.tsx`、`SmartPanelList.tsx` 及 `PositionEngine.ts` 的视觉层叠、同心圆角几何契约、滚动条挂载位置与高度约束机制。
> **核心诉求对齐**：
> 1. 二级级联子菜单绝不能盲目拉伸到 760px 直冲天际，必须建立 280px~320px（约 7~8 项）的合理黄金最大高度约束；
> 2. 滚动条绝不能挂在最外层卡片上破坏 14px 外圆角与 6px 内衬边框，必须彻底解耦并内嵌至列表容器中，且仅在内容溢出时优雅自适应呈现。

---

## 一、用户直观反馈与视觉根因定位

### 1.1 用户核心痛点还原

在真实业务使用场景中，用户针对二级展开面板提出了两条不可妥协的直观体验红线：

```text
1. “对于这种展开面板，凡是这种带有多个选项列表的，肯定是不能超过容器的一定高度的呀，不然的话不就太长了嘛。”
   —— 痛点：子菜单高度失控，长列表直接撑到 760px 甚至贴满屏幕顶底，主子面板视觉体量严重失衡，视线搜索疲劳。

2. “第二点就是不需要在整个级联面板的最外层加上这个滚动条，显得超级丑好吗（当然有一种情况是高度不够了，这样才需要加上这个滚动条，其余的时候不允许加上这个滚动条的）。”
   —— 痛点：滚动条挂在卡片最外层，硬直的垂直滚动条切入 14px 大圆角与外边框，破坏阴影与衬距；且滚动条无溢出时也可能隐现或占位。
```

### 1.2 现状视觉缺陷全景诊断

通过对组件代码与 DOM 结构的深度审查，当前实现存在四大严重视觉架构缺陷：

| 缺陷维度 | 现有代码缺陷表现 | 视觉与交互后果 |
| :--- | :--- | :--- |
| **滚动条挂载层级倒错** | `overflow-y: auto` 挂载在最外层卡片 `.cascadeSubmenu` 上 | 滚动条紧贴外层 1px 边框与 14px 圆角边缘，硬生生切碎圆角弧度，破坏外层阴影与 6px 呼吸衬距 |
| **高度边界失控 (760px 虚高)** | `MAX_CASCADE_PANEL_HEIGHT = 760;` 及 CSS `max-height: min(760px, ...)` | 子菜单随项数线性暴增至 760px，在 1080p 屏幕上霸占全屏，与轻巧的主面板形成怪异的反差 |
| **外壳与内容未解耦** | `SmartPanelCascadeSubmenu.tsx` 用单层 `<div>` 兼任浮层容器与滚动容器 | 违背“卡片负责外壳契约，列表负责内容流动”的单一职责原则，容器 padding 与内部滚动严重混杂 |
| **CSS 模块双重继承污染** | `className={`${menuStyles.menuContent} ${styles.cascadeSubmenu}`}` | 两个独立模块的样式在同一 DOM 上强制碰撞，产生多重 `max-height`、`padding`、`border` 与 `box-shadow` 的优先级竞争与冗余覆盖 |

---

## 二、滚动条挂载位置错误深度剖析

### 2.1 现有 DOM 盒子模型与滚动条渲染机制

在现代浏览器（Blink / Chromium 引擎）规范中，元素的滚动条挂载在 **Padding Box** 的右侧边缘，位于 Border Box 的内侧。

#### 现有实现的单层混杂盒子模型：

```text
┌───────────────────────────────────────────────────────────────────────┐
│ .cascadeSubmenu (同时承担外层卡片与滚动容器)                           │
│ border: 1px solid var(--border-color);                                │
│ border-radius: 14px;                                                  │
│ box-shadow: var(--sep-shadow);                                        │
│ overflow-y: auto;                                                     │
│                                                                       │
│ ┌───────────────────────────────────────────────────────────┬───────┐ │
│ │ padding: 6px (内衬区)                                     │ 滚动条 │ │ ◄── 滚动条直接贴在外层
│ │                                                           │ 4px   │ │     Padding Box 边缘！
│ │ ┌───────────────────────────────────────────────────────┐ │       │ │     上下两端直接与
│ │ │ MenuItem (border-radius: 8px)                         │ │       │ │     14px 弯角物理碰撞！
│ │ └───────────────────────────────────────────────────────┘ │       │ │
│ │ ┌───────────────────────────────────────────────────────┐ │       │ │
│ │ │ MenuItem (border-radius: 8px)                         │ │       │ │
│ │ └───────────────────────────────────────────────────────┘ │       │ │
│ └───────────────────────────────────────────────────────────┴───────┘ │
└───────────────────────────────────────────────────────────────────────┘
```

#### 该模型引发的五重视觉灾难：

1. **同心圆角破坏（Corner Cutting）**：
   - 滚动条轨槽（Track）与滑块（Thumb）是严格的垂直矩形几何体；
   - 当其位于 `border-radius: 14px` 的容器边缘时，直角滑块在滑动到顶部或底部时，会直接撞在 14px 弯曲的边界上。由于 CSS 对滚动条的圆角裁切在不同 GPU 渲染器下表现不一，极易造成锯齿、白色底色露白或圆角边缘被生生切掉一块。
2. **内衬与滚动条间距倒错（Padding Inversion）**：
   - 容器设置了 `padding: 6px`。根据 CSS 盒模型，选项条目距离边框有 6px 内边距；
   - 但因为滚动条贴在 border 边，导致滚动条和右侧菜单项之间隔着 6px 空白，而滚动条自身却紧贴着外层灰边。视觉上，滚动条仿佛脱离了菜单内容，孤悬在卡片的外墙皮上。
3. **内容滚动穿模（Bleed Through）**：
   - 当内容上下滚动时，菜单项被滚动条容器的 `scrollTop` 向上推移，直接滑动到 `padding-top: 6px` 的区域；
   - 滚动中的条目背景直接平铺到外层圆角边界内侧，甚至在 GPU 栅格化时溢出外框。
4. **常驻与闪烁噪点**：
   - 在某些缩放比例（如 125% DPI）下，未解耦的浮点像素测算误差会导致即使不需要滚动，容器也计算出 1px 的可滚动高度，从而激活动态滚动条闪烁。
5. **命中热区（Hit Area）污染**：
   - 滚动条置于最外层右边界，极易与父级菜单的 Safe-Aim 三角区域检测产生重叠与坐标干扰。

### 2.2 主面板与子面板的“解耦半拉子工程”

在 `SmartExpandablePanel.module.css` 中，原本定义了一个规范的内层列表容器：

```css
/* SmartExpandablePanel.module.css 第 118-126 行 */
.listContainer {
  display: flex;
  flex-direction: column;
  gap: var(--sep-item-gap, 4px);
  max-height: min(calc(100vh - 48px), 600px);
  overflow-y: auto;
  overflow-x: hidden;
  padding: 2px 0;
}
```

**然而极其荒谬的是**：
- 审查整个 `SmartExpandablePanel` 组件源码目录，**没有任何一个 TSX 文件引用了 `.listContainer`**！
- 主面板在 `SmartExpandablePanel.tsx` 中直接将 `<SmartPanelList>` 放在 `<div className={styles.menuWrapper}>` 下，外层依赖 `Popover.Content` 上的 `menuStyles.menuContent` 强行做整卡滚动；
- 二级子菜单在 `SmartPanelCascadeSubmenu.tsx` 中更是直接在最外层 `.cascadeSubmenu` 上套了 `overflow-y: auto`，完全抛弃了卡片外壳与列表滚动分离的正确架构。

---

## 三、高度失控与内部自适应滚动机制

### 3.1 760px 虚高参数的来源与危害

通过溯源，`760px` 这一硬编码数字来自于参考原型中的视口极端上限：

```typescript
// PositionEngine.ts 第 258 行
export const MAX_CASCADE_PANEL_HEIGHT = 760;

// SmartExpandablePanel.module.css 第 336 行
.cascadeSubmenu {
  ...
  max-height: min(760px, calc(100vh - 24px));
  ...
}
```

#### 为什么 760px 在桌面端是不可接受的？

1. **极端体量失衡**：
   - 一级主面板通常仅有 4~8 项常用操作，高度一般在 200px ~ 320px 之间；
   - 当用户悬停展开一个包含 15 项的二级子菜单时，子菜单直接膨胀到 `12 + 15 * 36 = 552px` 甚至 760px，其高度是一级面板的近 3 倍；
   - 界面视觉重心瞬间被二级面板野蛮掠夺，形成“子吞母”的畸形比例。
2. **视线跨度与认知负荷**：
   - 760px 的竖向跨度需要用户大幅度上下转动眼球，鼠标光标移动轨迹拉长 2~3 倍，严重违背交互人机工程学。
3. **定位翻转（Flip）频发**：
   - 760px 的巨大预估高度导致 `placeCascadeSubmenu` 算法极易判定“下方空间不足”，从而在用户微小的鼠标晃动下剧烈上下跳跃颠簸。

### 3.2 黄金最大高度与条目数学测算

为了彻底解决“子菜单太长”的问题，必须基于条目高度建立严谨的数学模型。

#### 条目尺寸度量基准：
- 单个标准条目基准高度：`--sep-item-height: 28px`（紧凑）或 `32px`（舒适，带 sublabel 或 icon 时）；
- 条目间距：`--sep-item-gap: 2px`；
- 内层滚动容器上下安全内边距：`padding: 2px 0`；
- 外层卡片上下内衬：`padding: 6px * 2 = 12px`；
- 外层边框厚度：`1px * 2 = 2px`。

#### 高度梯队测算表（以 32px 条目 + 2px 间距为例）：

| 选项项数 | 纯列表高度 (Items + Gaps) | 卡片总物理高度 (含外衬与边框) | 视觉呈现模式 | 滚动条状态 |
| :---: | :---: | :---: | :---: | :---: |
| **1 项** | $1 \times 32 = 32\text{px}$ | $32 + 4 + 12 + 2 = 50\text{px}$ | 极简自适应紧凑 | 无滚动条 |
| **3 项** | $3 \times 32 + 2 \times 2 = 100\text{px}$ | $100 + 4 + 12 + 2 = 118\text{px}$ | 自适应紧凑 | 无滚动条 |
| **5 项** | $5 \times 32 + 4 \times 2 = 168\text{px}$ | $168 + 4 + 12 + 2 = 186\text{px}$ | 理想舒适展开 | 无滚动条 |
| **7 项** | $7 \times 32 + 6 \times 2 = 236\text{px}$ | $236 + 4 + 12 + 2 = 254\text{px}$ | 黄金视域饱和态 | 无滚动条 |
| **8 项** | $8 \times 32 + 7 \times 2 = 270\text{px}$ | $270 + 4 + 12 + 2 = 288\text{px}$ | 临界饱和态 | 无滚动条 |
| **8.5 项 (推荐)** | $8.5 \times 32 + 8 \times 2 = 288\text{px}$ | $288 + 4 + 12 + 2 \approx \mathbf{306\text{px}}$ | **截断提示（Peek Cue）** | **自适应内嵌滚动** |
| **15 项以上** | 溢出被严格拦截 | **最大高度钳制在 300px ~ 310px** | **优雅内卷，严禁冲天** | **自适应内嵌滚动** |

> [!IMPORTANT]
> **黄金截断法则（8.5 项法则）**：
> 将二级子菜单最大高度设为 **`300px ~ 310px`**（或内层列表容器 `max-height: 280px`）。当列表超过 8 项时，第 9 项恰好露出约一半（约 14px~16px 的顶部）。
> 这种物理截断能够给用户极其强烈的“下方还有更多内容”的视觉潜意识引导，无需依赖显眼的滚动条也能传达滚动暗示。

---

## 四、同心圆角几何契约（Concentric Radii Contract）

### 4.1 数学定理与系统 Token

现代现代化 UI 设计规范中，嵌套元素的圆角必须满足**同心曲率定理**：

$$\mathbf{R_{outer} = R_{inner} + Padding}$$

在当前 Design Tokens (`tokens.css`) 中，已经存在经过严格验证的圆角系统：

```css
/* tokens.css */
--sep-radius-outer: 14px; /* 枢纽键：8px (item) + 6px (pad) 完美同心 */
--radius-md: 8px;        /* 标准控件基准: 菜单项基座 */
--sep-item-radius: var(--radius-md); /* 8px */
```

- 外层卡片边框圆角 $R_{outer} = 14\text{px}$；
- 外层内衬 $Padding = 6\text{px}$；
- 内部菜单项圆角 $R_{inner} = 8\text{px}$；
- 验证公式：$8\text{px} + 6\text{px} = 14\text{px}$。曲率圆心完全重合，浑然天成。

### 4.2 滚动条挂载位置对同心圆角的破坏机理

```text
【错误架构：外层滚动】                     【正确架构：内层滚动】
  
  R_outer = 14px                            R_outer = 14px
┌─────────────────────────┐               ┌─────────────────────────┐
│     Padding: 6px        │               │     Padding: 6px        │
│ ┌─────────────────┐ █ │ ◄ 滚动条撞角！   │ ┌─────────────────┐     │
│ │ Item (R=8px)    │ █ │                 │ │ Item (R=8px)    │ █ │ ◄ 滚动条在内层！
│ └─────────────────┘ █ │   (直角割裂圆角)  │ └─────────────────┘ █ │   与 14px 外角隔离
│ ┌─────────────────┐ █ │                 │ ┌─────────────────┐ █ │   外框圆润如初
│ │ Item (R=8px)    │ █ │                 │ │ Item (R=8px)    │ █ │
│ └─────────────────┘ █ │                 │ └─────────────────┘ █ │
└─────────────────────────┘               └─────────────────────────┘
```

当滚动条内嵌于独立的列表容器中时：
1. **外层卡片**保持为纯净的几何框体：仅应用 `border-radius: 14px; padding: 6px;`，四周呈现 360 度无死角的平滑外曲率；
2. **滚动通道**处于卡片内侧安全的矩形区域：滚动条距离外层边框至少保留 `6px` 的内衬留白，绝对不与 14px 的外圆角发生物理重叠；
3. **完全保护了外层投影与高亮边框**：外层的 `box-shadow` 与 `border: 1px solid var(--border-color)` 是一体化完整渲染的，不受滚动条重绘与图层提升（Layer Promotion）的侵蚀。

---

## 五、CSS 模块层叠冲突与类名污染分析

在现有的 `SmartPanelCascadeSubmenu.tsx` 中，存在极其混乱的类名混搭：

```tsx
<div
  ref={cascadeSubmenuRef}
  className={`${menuStyles.menuContent} ${styles.cascadeSubmenu}`}
  ...
>
```

### 5.1 属性冲突全景对照

两个独立的 CSS 模块对同一 DOM 节点注入了相互冲突的声明：

| CSS 属性 | `menuStyles.menuContent` (Menu.module.css) | `styles.cascadeSubmenu` (SmartExpandablePanel.module.css) | 实际生效与冲突分析 |
| :--- | :--- | :--- | :--- |
| **`max-height`** | `min(..., 640px)` | `min(760px, calc(100vh - 24px))` | **冲突竞争**：打包后后引入的覆盖前者，导致 760px 覆盖 640px，双双失控 |
| **`max-width`** | `min(340px, calc(100vw - 16px))` | `min(280px, calc(100vw - 24px))` | **冲突竞争**：级联子菜单宽度规范被扰乱 |
| **`box-shadow`** | `var(--shadow-lg)` | `var(--sep-shadow)` | **冲突竞争**：主菜单阴影与全局二级阴影混用 |
| **`gap`** | `2px` | `var(--sep-item-gap, 4px)` | **布局冲突**：Flex 项间距反复跳变 |
| **`overflow-y`** | `auto` | `auto` | **冗余绑定**：双重申明最外层滚动 |
| **`animation`** | `@keyframes crish-popover-enter` | `@keyframes crish-popover-enter` | **动画重叠**：重复绑定入场动效 |

### 5.2 根除方案：剥离 `menuStyles.menuContent`

级联子菜单并不是普通的 Radix Popover Content，而是由 `PositionEngine` 通过 `position: fixed` 精确微调计算的专用浮层组件。
**必须彻底剥离 `menuStyles.menuContent` 类**，让 `SmartPanelCascadeSubmenu` 拥有完全自主、自洽、单一数据源（SSOT）的样式定义。

---

## 六、滚动条渲染规范：外层 vs 内层微条实测表现

### 6.1 浏览器引擎渲染差异剖析

| 滚动条特性 | 挂在外层卡片时的渲染缺陷 | 内嵌在列表容器时的理想表现 |
| :--- | :--- | :--- |
| **`::-webkit-scrollbar` 宽度** | 设为 4px 时贴着右边框，鼠标很难精准按住，且视觉上像“边框变粗了” | 4px 悬浮微条，位于列表右侧 `2px` 安全槽位，精致克制 |
| **滑轨背景 (`track`)** | 透明 track 会透出卡片背景甚至阴影边缘，造成断层 | 透明 track 位于纯色列表背景上，完全无感知 |
| **滑块圆角 (`thumb`)** | `border-radius: 4px` 与外层 `14px` 圆角极度不谐调 | `border-radius: 4px` 与内部 `8px` 菜单项形成舒适的二级缩微几何 |
| **`scrollbar-width: thin` (Firefox)** | 系统默认 8px-10px 粗条，直接遮蔽外层边框与内衬 | 规范缩微在内部槽位中，不影响外层卡片边界 |
| **滚动自适应 (`auto`)** | 不超出时，若未妥善设置易产生 1px 细微占位或布局跳动 | 未超出时完全隐藏（`display: none` / 无占位），超出时平滑淡入 |

---

## 七、架构级解耦重构方案与立体代码蓝图

### 7.1 解耦后的全新 DOM 盒子架构

```text
┌────────────────────────────────────────────────────────────────────────┐
│ .cascadeSubmenu (外层卡片：只管外壳视觉契约，严禁滚动！)                 │
│ position: fixed;                                                       │
│ border-radius: 14px;                                                   │
│ border: 1px solid var(--border-color);                                 │
│ background: var(--sep-bg-panel-solid, var(--bg-elevated));             │
│ box-shadow: var(--sep-shadow);                                         │
│ padding: 6px;                                                          │
│ max-height: 310px;                                                     │
│ overflow: visible; (或 hidden，杜绝外层滚动条！)                         │
│                                                                        │
│ ┌────────────────────────────────────────────────────────────┬───────┐ │
│ │ .cascadeListContainer (内层列表容器：管滚动与流动排版)       │ 滚动条│ │
│ │ max-height: 298px;                                         │ 4px   │ │
│ │ overflow-y: auto;                                          │ 悬浮  │ │
│ │ overscroll-behavior: contain;                              │ 微条  │ │
│ │ padding-right: 2px;                                        │       │ │
│ │                                                            │       │ │
│ │ ┌────────────────────────────────────────────────────────┐ │       │ │
│ │ │ <SmartPanelItem> (8px 同心圆角)                        │ │       │ │
│ │ └────────────────────────────────────────────────────────┘ │       │ │
│ │ ┌────────────────────────────────────────────────────────┐ │       │ │
│ │ │ <SmartPanelItem>                                       │ │       │ │
│ │ └────────────────────────────────────────────────────────┘ │       │ │
│ └────────────────────────────────────────────────────────────┴───────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

### 7.2 组件重构：`SmartPanelCascadeSubmenu.tsx`

彻底解耦外层卡片与内层列表容器，剔除外部污染类名：

```tsx
import React from 'react';
import ReactDOM from 'react-dom';
import type { MenuItem } from './types';
import { SmartPanelItem } from './SmartPanelItem';
import styles from './SmartExpandablePanel.module.css';

interface SmartPanelCascadeSubmenuProps {
  parent: MenuItem & { children: MenuItem[] };
  ariaLabel: string;
  style: React.CSSProperties;
  side: 'left' | 'right';
  submenuRef: React.RefObject<HTMLDivElement | null>;
  container: Element | DocumentFragment;
  onPointerEnter: () => void;
  onPointerLeave?: () => void;
  onSelect: (item: MenuItem) => void;
  onRequestClose: () => void;
}

/**
 * 二级级联子菜单
 * 架构重构：
 * 1. 外层 .cascadeSubmenu：负责 fixed 定位、14px 同心外圆角、6px 内衬、阴影与背景；
 * 2. 内层 .cascadeListContainer：负责 300px 黄金高度限制、条目排版与自适应内嵌 4px 微条滚动。
 */
export const SmartPanelCascadeSubmenu: React.FC<
  SmartPanelCascadeSubmenuProps
> = ({
  parent: activeSubmenu,
  ariaLabel,
  style: submenuStyle,
  side,
  submenuRef: cascadeSubmenuRef,
  container,
  onPointerEnter,
  onPointerLeave,
  onSelect,
  onRequestClose,
}) =>
  ReactDOM.createPortal(
    <div
      ref={cascadeSubmenuRef}
      className={styles.cascadeSubmenu}
      role="menu"
      data-side={side}
      aria-label={ariaLabel}
      style={submenuStyle}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <div className={styles.cascadeListContainer}>
        {activeSubmenu.children.map((subItem) => (
          <SmartPanelItem
            key={subItem.id}
            item={subItem}
            onSelect={(item, ev) => {
              subItem.onSelect?.(item, ev);
              subItem.onClick?.();
              onSelect(item);
              if (subItem.closeOnSelect !== false) {
                onRequestClose();
              }
            }}
          />
        ))}
      </div>
    </div>,
    container
  );
```

### 7.3 样式重构：`SmartExpandablePanel.module.css`

重写 `.cascadeSubmenu` 并引入 `.cascadeListContainer`：

```css
/* ==========================================================================
   二级子菜单卡片（14px 外圆角 / 6px 内衬 / 8px 条目，同心圆角外层卡片）
   ========================================================================== */
.cascadeSubmenu {
  position: fixed;
  margin: 0;
  width: max-content;
  min-width: 160px;
  max-width: min(280px, calc(100vw - 24px));
  height: auto;
  /* 黄金高度约束：卡片总高严控在 310px 以内（~8.5 项），绝不撑到 760px 冲天 */
  max-height: min(310px, calc(100vh - 24px));
  /* 严禁在外层卡片挂载滚动条，保护 14px 圆角与外边框完整性 */
  overflow: visible;
  border-radius: var(--sep-radius-outer, 14px);
  border: 1px solid var(--border-color);
  background: var(--sep-bg-panel-solid, var(--bg-elevated));
  box-shadow: var(--sep-shadow);
  padding: 6px;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  z-index: var(--z-dropdown-menu, 310);
  outline: none;
  transform-origin: left top;
  animation: crish-popover-enter var(--transition-popover-enter) forwards;
  will-change: transform, opacity;
}

/* 跨面板透明安全命中桥（Hit Bridge） */
.cascadeSubmenu::before {
  content: '';
  position: absolute;
  top: -8px;
  bottom: -8px;
  width: 12px;
  pointer-events: auto;
}

.cascadeSubmenu[data-side='right']::before {
  left: -8px;
}

.cascadeSubmenu[data-side='left']::before {
  right: -8px;
}

/* ==========================================================================
   二级子菜单内嵌列表滚动容器（核心重构：内嵌滚动、自适应微条、零圆角干涉）
   ========================================================================== */
.cascadeListContainer {
  display: flex;
  flex-direction: column;
  gap: var(--sep-item-gap, 2px);
  width: 100%;
  max-height: 298px; /* 310px - 12px(padding) */
  /* 超出时自适应优雅滚动，未超出时完全隐藏滚动条 */
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  /* 为滚动条预留 2px 留白，防止内容贴边与微颤 */
  padding-right: 2px;
  box-sizing: border-box;
  scrollbar-width: thin;
  scrollbar-color: var(--border-color) transparent;
}

/* 精密内嵌 4px 悬浮微条规范 */
.cascadeListContainer::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}

.cascadeListContainer::-webkit-scrollbar-track {
  background: transparent;
}

.cascadeListContainer::-webkit-scrollbar-thumb {
  background: var(--border-color);
  border-radius: 4px;
  transition: background-color var(--transition-micro);
}

.cascadeListContainer::-webkit-scrollbar-thumb:hover {
  background: var(--border-hover, var(--text-tertiary));
}

.cascadeListContainer::-webkit-scrollbar-button {
  display: none;
  width: 0;
  height: 0;
}

/* 保证内部菜单项具备 8px 同心圆角 */
.cascadeListContainer .item,
.cascadeListContainer [role='menuitem'] {
  width: 100%;
  border-radius: var(--sep-item-radius, 8px);
  min-height: var(--sep-item-height, 28px);
  padding: 5px 8px;
  box-sizing: border-box;
}
```

### 7.4 定位引擎参数对齐：`PositionEngine.ts`

将失真的 760px 常量降噪收敛至 310px，让测算与定位算法与 CSS 严格同频：

```typescript
// PositionEngine.ts 核心修改

/** 级联子菜单最大限制高度（收敛至黄金体验高度 310px，约 8.5 项，告别 760px 巨塔） */
export const MAX_CASCADE_PANEL_HEIGHT = 310;

/** 按子项行数估算级联高度，根据视口与 MAX_CASCADE_PANEL_HEIGHT 弹性自适应 */
export function estimateCascadeHeight(
  children: Array<{ type?: string }> | undefined,
  maxAllowed = MAX_CASCADE_PANEL_HEIGHT
): number {
  const list = children ?? [];
  // 6px 上下 padding = 12px
  let height = 12;
  for (const child of list) {
    // 分割线 9px，标准条目 30px (28px + 2px gap)
    height += child.type === 'divider' ? 9 : 30;
  }
  // 最小 44px，最大严控在 maxAllowed (310px) 以内
  return Math.max(44, Math.min(height, maxAllowed));
}
```

---

## 八、全面验收与回归断言清单

在落实该重构方案后，必须通过以下立体化验收断言：

1. **短列表视觉验收（1~6 项）**：
   - 子菜单高度与项数完全贴合（例如 3 项高度约 106px）；
   - **绝对不出现任何滚动条**，滚动轨槽无任何占位；
   - 14px 外圆角平滑温润，与内部 8px 条目构成完美的 6px 间隙同心圆环。
2. **长列表视觉验收（10~30 项）**：
   - 卡片总高度精确锁死在 **310px**（内层 298px）；
   - 底部最后一个条目呈现约一半的截断效果（Peek Cue），直观展示可向下滚动的物理隐喻；
   - 滚动条以 4px 微条内嵌在选项右侧，距外层边框保留清晰的 6px 内衬留白；
   - **外层 14px 圆角没有任何直角硬物切入或锯齿形变**；
   - 鼠标悬停到滚动条滑块上时，平滑变色为 `--border-hover`，操作极其顺手。
3. **极限空间自适应验收（视口高度不足）**：
   - 当应用窗口被缩小至 400px 高度，且子菜单向下展开遇到视口底部边界时，`placeCascadeSubmenu` 优雅钳制高度至可用视口高度，内层列表自动出现滚动条，绝不溢出窗口之外。
4. **CSS 模块纯净度验收**：
   - 检查 DOM 元素 `className`，确认已彻底剔除 `menuStyles.menuContent`；
   - 元素审查中无任何被划掉的重复 `max-height`、`padding` 或 `box-shadow`。
