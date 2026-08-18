# Crish Desktop - Chat Composer 设计规范 (Design System Guidelines)

这份规范提炼了我们在重构 `chat-composer-component` 时确立的核心 UI/UX 原则，供后续移植与全量开发时严格遵守，确保整体风格一致。

## 一、 核心设计哲学

1. **绝对极简与高级感 (Minimalist & Premium)**
   - 界面应当保持极致的克制，避免任何多余的修饰。
   - 拒绝大面积色块堆砌，使用大面积留白与呼吸感。
   - UI 元素必须显得精致、轻盈，不能有“笨重感”或“廉价感”。

2. **绝对零蓝色原则 (Zero-Blue Policy)**
   - 整个界面（包括字体、边框、背景、高亮、Focus 状态）**绝对不允许出现任何蓝色的痕迹**。
   - 超链接、活动状态、选中状态等通常使用蓝色的地方，一律改用中性色（灰色系）、黑白反差色，或符合全局主题的特定高级色调。

3. **优雅的微动效 (Elegant Micro-Animations)**
   - 所有状态切换（Hover、Focus、Active）必须伴随平滑、柔和的过渡动画（如 `transition: all 150ms ease` 或 `cubic-bezier`）。
   - 动效应当克制，不能喧宾夺主。例如滚动条悬浮、刻度放大、复制按钮图标切换，都需要行云流水般的细腻感。

## 二、 交互控件规范

1. **输入框与聚焦状态 (Input & Focus States)**
   - **禁止厚重阴影**：输入框或组件不要使用沉重的 `box-shadow`。
   - **极弱边缘强化**：Focus 或 Active 状态下，**绝对不能出现粗黑边框**（如 `0 0 0 1px` 的实黑）。
   - **对比度控制**：边框颜色只能比原本的背景或基础边框稍微深一点点（最多混合 5%-10% 的 `--text-primary`），仅仅足以暗示激活区域，必须保护用户视力，保持视觉柔和。

2. **滚动条设计 (Scrollbars)**
   - 废除浏览器原生的宽大实心滚动条。
   - 全局采用“悬浮胶囊”样式（Capsule Scrollbar）。
   - **规范属性**：
     - `width: 14px;` (留出足够点击空间，但视觉上显得细)
     - `background-color: rgba(0, 0, 0, 0.15)` (半透明中性灰)
     - `background-clip: padding-box; border: 4px solid transparent;` (核心技巧：利用边框透明挤压出悬浮感)
     - 轨道（Track）必须完全透明。

3. **导航与定位条 (Scrubber / Minimap)**
   - 对于长列表（如对话流），应提供快捷定位的迷你图（FlowScrubber）。
   - **无轨设计**：只显示消息映射的刻度（Ticks），不要绘制轨道背景。
   - **高度映射**：刻度的高度必须按比例映射真实消息块的高度（`heightPercent`），使得迷你图真实反映页面内容分布，避免视觉上的分散和零碎感。
   - 刻度线使用 `--text-tertiary` 等极弱颜色，Hover 时提供放大加深并弹出气泡的反馈。

4. **提示信息 (Tooltips)**
   - **禁止使用原生 `title` 属性**：浏览器默认的 `title` 悬浮提示样式陈旧且不可控。
   - 必须使用自定义的悬浮气泡组件（如带有圆角、柔和阴影和极简动画的自定义 DOM 节点），确保气泡与整体极简高级的 UI 风格一致。

## 三、 排版与颜色系统

1. **字体栈 (Typography)**
   - **西文与数字**：优先使用 `Geist`，提供极佳的几何现代感与代码级清晰度。
   - **中文**：无缝降级至 `MiSans`，保障大段中文阅读的通透性和现代感。
   - 通过 `-webkit-font-smoothing: antialiased;` 确保字体的锐利与 LCD 亚像素抗锯齿效果。

2. **设计令牌 (Design Tokens)**
   - 严禁在 CSS 中硬编码具体的 HEX 颜色值（除了极个别绝对黑白）。
   - 全部使用 CSS Variables 进行映射：
     - `--bg-page`: 页面基底色
     - `--text-primary`: 核心正文内容（通常非纯黑，如 `#1a1a1a`）
     - `--text-secondary`: 辅助性信息、时间戳
     - `--text-tertiary`: 最弱的 UI 元素（如未激活的刻度线）
     - `--border-color`: 极弱的分界线

## 四、 常见开发避坑指南

- **防止绝对定位被裁切**：使用 `position: fixed` 或确保外层父容器没有 `overflow: hidden`，以防止类似悬浮胶囊、迷你图、Tooltips 这样的悬浮层被意外裁切。
- **DOM 操作克制**：在纯 JS/DOM 实现中，尽量复用节点。对于高频更新（如计算滚动百分比），注意使用节流（Throttle）或 `MutationObserver` 的防抖策略。
