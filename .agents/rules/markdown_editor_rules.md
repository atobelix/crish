# Markdown 编辑器开发与设计硬性规则 (Markdown Editor Specification & Red Lines)

本文档记录了该 Markdown 编辑器项目已确立的所有硬性规则与设计规范。所有 Agent 在后续维护、迭代或重构时必须严格执行，绝不允许擅自修改或偷懒简化。

---

## 1. 严格 HSL 颜色体系 (HSL Color Palette)

- 所有 CSS 颜色声明**必须严格使用** `hsl(...)` 或 `hsla(...)`，禁止引入 HEX (`#xxx`)、RGB/RGBA 或多余颜色关键字（`transparent` 除外）。
- **允许使用的色彩池**：
  - **纯白**：`hsl(0, 0%, 100%)` （白天模式编辑纸张基色）
  - **纯黑**：`hsl(0, 0%, 0%)` （正文文本与光标基色）
  - **灰度三阶**：`hsl(0, 0%, 45%)``hsl(0, 0%, 70%)``hsl(0, 0%, 90%)` （网格线条与关键字/注释/链接）
  - **偏黄 2%**：`hsla(50, 100%, 50%, 0.02)` / `hsl(50, 100%, 35%)` （格子纸衬底偏色与字符串高亮）
  - **选中心蓝色**：`hsla(210, 90%, 78%, 0.45)` （偏白的浅淡蓝色高亮，用于选中文本）
- **红线**：严禁加入任何未经允许的杂色、渐变卡片或暗黑主题混淆。

---

## 2. 绝对全无描边与极简界面 (Zero Border & Minimal UI)

- **无描边**：必须保持 `border: none; outline: none; box-shadow: none;`，严禁产生任何黑色边框或阴影线。
- **无多余元素**：严禁擅自添加顶部标题栏、功能按钮、行号列、底部状态栏或任何浮动面板。

---

## 3. 桌面与移动端双端通用响应式架构 (Desktop & Mobile Universal Responsive Architecture)

- **双端自适应**：
  - **桌面端 (Desktop Mouse)**：保持居中 820px 格子纸排版与物理网格。
  - **移动端 (Mobile Touch)**：在 600px 以下屏幕自适应为 100vw/100vh 铺满模式，扩大手指触控热区（`padding: 4px 6px`），消除 Tap 高亮色斑（`-webkit-tap-highlight-color: transparent`）。
- **双端事件桥接 (`click` + `touchend`)**：所有交互组件（复选框物理切换、链接 Portal 卡片）同时绑定 `click` 与 `touchend` 事件，确保手机触摸屏与电脑鼠标无缝融合。

---

## 4. 标题实际阶梯字号 (Distinct Heading Sizes)

- **真实字号**：符合 `# ` 格式的标题行必须按实际标题大小阶梯渲染（H1: `1.7rem`、H2: `1.38rem`、H3: `1.18rem`、H4: `1.05rem`、H5: `0.95rem`、H6: `0.88rem`）。
- **红线**：**严禁为了对齐而偷懒将所有标题统一改成 14px 普通字号**。

---

## 5. 空行充填与双重 data 属性映射规约 (`data-line-idx` & `data-token-idx`)

- **行块级与 Token 级 DOM 双层显式属性绑定**：
  - 每行 `line-block` DOM 节点必须赋予 `data-line-idx="${i}"` 唯一标识。
  - 每个 Token DOM 节点赋予 `data-token-idx="${k}"` 唯一标识。
- **空行 `<span data-token-idx="0"><br></span>` 节点防护**：
  - 当渲染空行 `""` 时，必须强制插入 `span[data-token-idx="0"]` DOM 占位元素。
  - **红线**：确保在连续按下 Enter 创建多个空行时，Selection Range 能够 100% 精准锁定到目标空行内部，绝对不发生丢失光标或强行跳回第一行（Line 0）的问题！

---

## 6. 精确 Token 节点 DOM 光标定位算法 (Token-Node Caret Positioning & Line-Block Architecture)

- **精确 Token 节点 DOM 光标定位 (`setCaretPosition`)**：
  - `setCaretPosition` 直接精准锁定 Raw 列偏移落入的具体 Token DOM 子节点（`childNodes[targetTokenIndex]`），在该 Token 节点的 Text Node 内部直接设置 Range 偏移。
  - **红线**：严禁在全行 Text Node 之间跨节点边界模糊累加，彻底消除点击后光标被挤出目标节点跳跃到相邻 Token 的问题。
- **按行 DOM 隔离**：使用按行 DOM 结构（`<div class="line-block line-h1">`），结合全量 `documentRawState` 文档状态持久化。

---

## 7. 内容完整性 (Content Preservation)

- 预置的 Markdown 样例文本必须保留，不得随意删除或削减。

---

## 8. Agent 协作与验证纪律 (Agent Workflow & Verification)

- **严格 1 对 1 执行**：“你说一个，我做一项”，绝不擅做主张。
- **CDP 事实核验**：每次修改后必须通过 CDP DevTools (Port 9222) 进行页面 navigate 与 screenshot 视觉核验，确保无报错、无漂移后方可交付。
