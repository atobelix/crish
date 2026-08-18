# Conex / Crish — Chat Composer 组件设计规范 (Design System Guidelines)

这份规范提取自当前 Chat Composer UI 的最终代码状态及多次迭代确立的设计哲学。它不仅包含硬性的数值参数，更记录了“为什么要这么设计”的底层思考，作为后续跨平台移植或交给其他 AI 协助开发时的**强制性设计约束**。

---

## 核心设计哲学 (Core Philosophy)

1. **大气与呼吸感 (Spacious & Organic)**
   坚决避免“小气”的拥挤感。放弃多余的边框和生硬的块状分割，依赖**大号的 `gap` 与 `padding`（留白）**来组织信息层级。元素之间必须有足够的物理空间让视觉呼吸。
2. **极度克制的色彩 (Restrained Palette)**
   绝不允许出现高饱和度的背景色（例如刺眼的黄色或泛蓝的暗色）。界面底色仅允许使用纯白（`#ffffff`）或极浅的暖灰色系（如比纯白暗 3% 的灰色）。所有的文字都不允许出现未经处理的纯蓝色调痕迹，严格遵守项目中定义的 `var(--text-primary)` 等变量。
3. **沉稳与无缝交互 (Grounded Interactions)**
   输入框底座必须给人沉稳的感觉，通过全局层面的滚动条管理和 `overscroll-behavior: contain` 阻断局部容器的滚动冒泡，消除界面的“浮躁感”。

---

## 1. 布局与滚动容器 (Layout & Scroll Strategy)

- **全局滚动视口**：主界面的滚动权严格交给最外层的 `body` 或顶层 App 容器，保证滚动条紧贴整个浏览器窗口的**最右侧边缘**。绝不能在主要信息流 `chat-stream-container` 内部再套一个滚动条。
- **全局滚动条样式**：细长优雅，宽度 `6px`，轨道透明，滑块为 `rgba(0,0,0,0.08)` 及 `4px` 的圆角。
- **底部输入框底座 (Composer Wrapper)**：
  - 必须使用 `position: sticky; bottom: 0;` 或固定定位，紧紧锚定在视口最下方。
  - **背景遮挡**：必须带有与页面背景一致的底色（`var(--bg-page)`），在页面上滚时无缝遮盖底部的历史对话。
  - **滚轮防穿透**：由于 Composer 内部包含文本域，整个 `.composer-container` 必须带有 `overscroll-behavior: contain;`，以防止鼠标在输入框区域滚动时，误触发背后整个大页面的滚动（Scroll Chaining）。

---

## 2. 空间律动与内外边距 (Spatial Rhythm & Metrics)

所有边距需遵循大开大合的设计语言：

- **对话流间距 (Chat Stream Gap)**：
  - 每轮对话之间的间距（Gap）应设定在 `32px` 左右。必须有充裕的垂直空间来区分不同的上下文回合。
- **User 气泡输入**：
  - 用户的气泡不再是紧凑的小框，而是宽敞的卡片。内边距建议设定在 `padding: 14px 20px`，边框圆角需柔和（如 `18px 18px 6px 18px`），体现对话指向性。
- **AI 助手内容**：
  - AI 的输出放弃气泡包裹（`background: transparent`），以“文档流”的形式展现，铺满容器，给予结构化展示（如表格、代码块）最大的可用宽度。
- **Composer 操作台**：
  - 输入框本身的内边距应保持在 `padding: 16px 20px`，使输入体验感觉宽敞从容。

---

## 3. 排版与文字层次 (Typography & Hierarchy)

排版不追求字号的巨大，而追求对比度（Contrast）与行高（Line-height）。

- **基础正文字号 (Base Text)**：
  - `14px`。必须搭配 `1.6` 到 `1.65` 的宽松行高。
- **微小元数据 (Micro Meta)**：
  - `11px` - `12px`。用于时间戳、发送者名称、工具调用状态等次要信息。使用浅灰色（`var(--text-tertiary)`）以降低视觉干扰。
- **标题 (Titles/Headers)**：
  - 如计划节点标题，字号控制在 `15px`，使用 `font-weight: 600`。
- **焦点反差原则**：
  - **图标绝不能大过文字**。例如：阶段节点的序号圆圈（Step Num）限制在 `16x16px` 大小，内部数字仅 `11px`，确保它们在视觉上永远只是“辅助修饰”，绝不能喧宾夺主（抢走 `15px` 标题的风头）。

---

## 4. 几何辅助线与 Timeline 设计规范 (Geometric Timeline Rails)

此规范是解决“竖线看起来乱、不对称、越界”的核心约束：

- **竖线的定位逻辑：左侧分组线 (Bracket Grouping)**
  - 竖线（Rail）**绝对不能**用于连接同级的父节点（例如不能从 Step 1 连到 Step 2）。这种连法会把界面切割成生硬的长条。
  - 竖线的作用仅仅是**“包裹属于当前节点的子任务”**。
- **精准锚点计算 (Pixel-perfect Anchors)**：
  - 竖线的起点（Y1）：应严格对齐当前节点**第一个子元素**的顶部（`firstChildRect.top + 2px`）。
  - 竖线的终点（Y2）：应严格对齐当前节点**最后一个子元素**的底部（`lastChildRect.bottom - 2px`）。
  - **脱离父节点圆圈**：竖线不要跟父节点的圆圈产生直接物理连接。它仅静静悬浮在子节点群的左侧，形成一个优雅的左侧界限。
- **SVG 重绘管线**：
  - 采用独立的 SVG Overlay 绘制竖线，必须随 DOM Resize/Collapse/Expand 动态重计算位置（`getBoundingClientRect`），绝不能使用纯 CSS Border 来伪造复杂的跨节点连线。

---

## 5. 组件状态与动效 (States & Motion)

- **输入框 Focus 状态 (Zero-intrusion Focus)**：
  - 摒弃浏览器默认的深色、粗犷焦点环（如蓝/黑色的硬朗边框）。
  - Composer 聚焦时，通过极其微弱的 `box-shadow` 和边框颜色微调（在同色系内加深一点点）来暗示状态。聚焦变换应该是平滑渐变的（`transition: 180ms ease`）。
- **展开/折叠过渡 (Expand / Collapse)**：
  - 计划列表与详细输出的展开需利用 CSS Grid `grid-template-rows: 0fr -> 1fr` 或 `max-height` 进行丝滑的硬件加速动画，消除突兀跳跃。
- **SVG Chevron (折叠箭头)**：
  - 图标必须做严格对齐。展开时通过 `transform: rotate(90deg)` 平滑过渡 `160ms`，配合极简的悬停状态颜色渐隐。

---

### 给其他 AI 的移植警告 (Warning for AI Agents)
**任何接手此设计迁移的 AI 请注意**：
不要为了省事而把多个独立的 CSS 组件合并，不要随便给容器套 `overflow-y: scroll`，不要用生硬的 `#000` 或纯彩色做边框，不要让竖线越界连到同级容器！必须精确遵循本指南中的间距参数与计算逻辑，维护本项目的“高级感”与“极简审美”。
