# 07 — 视觉系统（Visual System）

> **读者**：实现 UI 皮肤 / CSS 的 agent  
> **依赖**：[`AGENT_BRIEFING.md`](./AGENT_BRIEFING.md)、[`README.md`](./README.md)、`css/conversation-tokens.css`、`css/design-tokens.css`、`css/flow/artifact-notebook.css`  
> **不做**：序列化算法、块 schema 全集、DnD 物理细节（见 02–06 / 04）

---

## 1. 目标 / 非目标

### 目标

- 阅读态达到 **Composer 同族 surface** 精致度：冷静、近黑 opacity 层级、无侧边时间线轨。
- 与对话流 Notebook（`nb-panel` / `artifact-notebook.css`）视觉连续；块编辑器装入 `nb-body` 后不「换皮」。
- 块交互控件（把手、slash 菜单、落点指示）**可发现但不抢戏**。
- 全部皮肤走 **`mdx-` 前缀** + token 变量；禁止硬编码随机灰阶。

### 非目标

- 不引入第二套品牌色盘 / 不借 Notion 整套皮肤。
- 不做预览/源码双模式 chrome。
- 不在 v1 做完整 Dark Theme 产品开关（仅预留 token 钩子，见 §5）。
- 不做 hover 阴影抬升、不洗版动效。

---

## 2. Token 继承契约

编辑器 **不重新发明** 字号与 ink；优先复用 flow / design tokens：

| 语义 | 变量 | 默认值 | 用途 |
|------|------|--------|------|
| 正文字号 | `--flow-font-body` / `--font-body` | 14px | 段落、列表、普通标题以外 |
| 元信息 | `--flow-font-meta` | 13px | 表头、caption、slash 项副标 |
| 微字 | `--flow-font-micro` | 12px | 代码块、语言标签、把手 tip |
| 主墨 | `--flow-ink` / `--flow-color-l0` | #0a0a0a @ 0.92 | 正文 |
| 次墨 | `--flow-color-l1` | @ 0.60 | 占位、次级说明 |
| 弱墨 | `--flow-color-l2` | @ 0.42 | 把手 idle、装饰 |
| 文档强调 | `--flow-doc-ink` | #0a5c5c | 链接、wiki、file-chip 文字 |
| 表面 | `--bg-popover` / `#fff` | — | 面板与菜单 |
| 悬停填充 | `--bg-hover` | rgba(0,0,0,0.035) | 行 hover、菜单项 |
| 发丝线 | `--flow-hairline` / `--border-color` | #e2e2e2 | 表框、代码框、菜单边 |
| 圆角 | `--flow-radius` / `--flow-radius-sm` | 10 / 8 | 面板 / 块皮肤 |
| 静态影 | `--flow-shadow-panel` / `--shadow-popover` | — | 浮层菜单 **仅 static** |
| 动效 | `--flow-accordion-ms` / `--flow-spring` / `--flow-hover-ms` | 240 / spring / 120 | 见 §8 |

编辑器私有 token（挂在 `.mdx-root`）：

```css
.mdx-root {
  --mdx-body: var(--flow-font-body, 14px);
  --mdx-meta: var(--flow-font-meta, 13px);
  --mdx-micro: var(--flow-font-micro, 12px);
  --mdx-h1: 15px; /* Notebook 内唯一 +1；见 §3 */
  --mdx-lh-body: 1.7;
  --mdx-lh-heading: 1.35;
  --mdx-block-gap: 6px;       /* 块与块之间垂直节奏 */
  --mdx-block-pad-y: 3px;     /* 块内上下 padding（可点区） */
  --mdx-block-pad-x: 2px;
  --mdx-gutter: 28px;         /* 左侧把手栏宽 */
  --mdx-indent: 1.25em;       /* 列表缩进 */
  --mdx-focus-ring: 0 0 0 2px color-mix(in srgb, var(--flow-doc-ink, #0a5c5c) 35%, transparent);
  --mdx-selection-bg: color-mix(in srgb, var(--flow-doc-ink, #0a5c5c) 14%, transparent);
  --mdx-drop-line: var(--flow-doc-ink, #0a5c5c);
  --mdx-callout-bg: rgba(0, 0, 0, 0.02);
  --mdx-code-bg: rgba(0, 0, 0, 0.025);
  --mdx-quote-bar: rgba(10, 10, 10, 0.12);
}
```

---

## 3. 排版刻度（阅读态）

对齐对话流 **14 body**；Notebook 内 **仅 h1 允许 +1 档（15px）**（与 `artifact-notebook.css` 现有 h1=16px 收敛到 15，避免与产品 14 体系脱节）。

| 元素 | font-size | weight | line-height | letter-spacing | 颜色 |
|------|-----------|--------|-------------|----------------|------|
| body / p | 14px (`--mdx-body`) | 400 | 1.7 | normal | `--flow-color-l0` |
| h1 | **15px** (`--mdx-h1`) | 600 | 1.35 | -0.01em | solid ink |
| h2 | 14px | 600 | 1.35 | normal | solid ink |
| h3 | 13px (`--mdx-meta`) | 600 | 1.4 | normal | solid ink |
| h4–h6 | 13px | 600 | 1.4 | normal | l1（略弱） |
| 列表项 | 14px | 400 | 1.65 | — | l0 |
| 引用 | 14px | 400 | 1.65 | — | l1 |
| 行内 code | 0.92em | 400 | inherit | — | solid + 浅底 |
| 代码块 | 12px (`--mdx-micro`) | 400 | 1.55 | — | solid |
| 表格 | 13px | 400/600 th | 1.45 | — | solid |
| callout 标题 | 13px | 600 | 1.4 | — | solid |
| 空态占位 | 14px | 400 | 1.7 | — | placeholder 0.35 |

**字重纪律**：正文字重不上 500；标题最多 600。禁止 700/800 标题。

**中文**：使用系统 UI 栈，不强制指定中文字体文件；`word-break: break-word`；列表标记与中文齐平（`list-style-position: outside` + gutter 对齐）。

---

## 4. 块间距节奏

```
┌─ .mdx-root ─────────────────────────────┐
│  gutter(28) │ content                   │
│  [handle]   │  .mdx-block               │  pad-y 3
│             │  ── gap 6px ──            │
│  [handle]   │  .mdx-block               │
│             │  ── gap 6px ──            │
│             │  .mdx-block--table (多)   │  表前后外距 8–10
└─────────────────────────────────────────┘
```

| 规则 | 值 | 说明 |
|------|-----|------|
| 块间 `gap` | 6px | flex/grid 列；避免 margin 塌陷 |
| 块内 pad-y | 3px | 扩大可点热区，视觉仍紧 |
| 段落后额外 | 0（靠 gap） | 不叠加 `p { margin-bottom: 0.65em }` 双份 |
| 列表项内 | 2px | 项间距更紧 |
| 嵌套列表 | indent 1.25em × depth | 最大视觉深度 3；更深仍缩进但 gutter 不增 |
| 分隔线 `hr` | 上下 10px + 1px hairline | 无粗线 |
| 首块 / 末块 | 上 2 / 下 12 | 贴 header 渐变与底安全区 |

**空文档**：单一空 `paragraph` 占位，显示灰色「输入 `/` 或 `、` 插入块…」，不居中大空态插画。

---

## 5. 组件皮肤（premium，非 Bootstrap 默认）

### 5.1 表格 `.mdx-table`

```
.mdx-table-wrap
  └─ table.mdx-table
       thead > th.mdx-th
       tbody > td.mdx-td
```

| 属性 | 规格 |
|------|------|
| 外框 | 1px `--border-subtle`，圆角 8px，`overflow: hidden` |
| 表头底 | `rgba(0,0,0,0.02)`，**无** 粗底边双线 |
| 单元格 | pad 6×10；竖线 hairline；末行无底线可省略 |
| 选中单元格 | 背景 `--mdx-selection-bg`，无 3px 蓝框 |
| 列宽 | 默认 auto；拖拽改宽时显示 2px 中央指示线（doc-ink 40%） |
| 空表 | 2×2 骨架，placeholder 文字 l2 |

禁止：斑马纹高对比、双线外框、Bootstrap `.table-striped` 观感。

### 5.2 代码块 `.mdx-code`

```
.mdx-code
  ├─ .mdx-code__bar   (lang label 左；可选 copy 右，opacity 0.42)
  └─ pre > code
```

| 属性 | 规格 |
|------|------|
| 背景 | `--mdx-code-bg`（≈2.5% 黑） |
| 边框 | **无边** 或 1px 极淡；优先无边 + 圆角 8 |
| 内边距 | 10×12；bar 高 28，字 micro |
| 滚动 | 横向 thin scrollbar（同 notebook 6px） |
| 行内 code | pad 1×4，radius 4，背景 4% 黑 |
| 语法高亮 | v1 可单色；若上 highlight，色相饱和度 ≤ 桌面主题，禁止霓虹 |

### 5.3 引用 `.mdx-quote`

- 左侧 **2px** 竖条 `--mdx-quote-bar`（非粗色条、非全彩左边框）。
- 正文 opacity 用 l1；无斜体强制（中文斜体差，可 `font-style: normal`）。
- 内边距左 12，上下 4。

### 5.4 标注 / Callout `.mdx-callout`

| 变体 | 左边点缀 | 背景 |
|------|----------|------|
| note（默认） | 2px solid rgba(10,10,10,0.14) | `--mdx-callout-bg` |
| tip | 2px solid color-mix(doc-ink 55%) | 极淡 teal 2% |
| warn | 2px solid accent-orange @ 0.55 | orange-bg 35% 混白 |
| danger | 2px solid flow-error | rose-bg 30% 混白 |

结构：图标（14px，左簇）+ 标题 + 正文。**无** 大色块 alert、无 dismiss 按钮默认露出。

### 5.5 列表 / 任务

- 无序：自定义 `::marker` 或 5px 圆点，opacity 0.28（对齐 `--flow-marker`）。
- 有序：tabular 数字，弱墨。
- 任务：14×14 checkbox，圆角 4，勾选用 solid ink 而非高饱和绿铺满。

### 5.6 链接 / 扩展芯片（视觉占位）

- 普通链接：`color: var(--flow-doc-ink)`，无 underline 默认；hover underline 1px。
- file-chip / wiki-link：pill，同 `flow-artifact__chip` 气质（见 06）；shadow static only。

---

## 6. 暗色模式（可选注记）

**v1 产品不做开关。** 预留：

```css
@media (prefers-color-scheme: dark) {
  /* 不默认启用；仅当宿主 root 带 [data-theme="dark"] 时覆盖 */
}
.mdx-root[data-theme="dark"] {
  /* 反相 fill / border；ink 改近白 opacity ladder */
}
```

实现 agent：token 全部走变量；禁止 `background:#fff` 散落（除与 notebook 强制一致处用 `var(--bg-popover,#fff)`）。

---

## 7. 选区 / 焦点环

| 状态 | 表现 |
|------|------|
| 文本选区 `::selection` | `--mdx-selection-bg` + ink 文字 |
| 块聚焦（键盘） | 块容器 `box-shadow: var(--mdx-focus-ring)`；**不用**浏览器默认 outline |
| 编辑态 caret | `caret-color: var(--flow-ink)` |
| 菜单项 focus | 背景 `--bg-hover`，左侧无色条 |
| 把手 focus-visible | 2px doc-ink ring，radius 4 |
| 禁用 outline 场景 | 必须有等价 focus-visible 替代 |

**禁令**：`:focus { outline: none }` 无替代；蓝色系统 focus 大框。

---

## 8. 交互控件视觉

### 8.1 块把手 `.mdx-handle`

```
.mdx-block
  ├─ .mdx-gutter
  │    └─ button.mdx-handle   (6-dot)
  └─ .mdx-block__body
```

| 状态 | 可见性 | 样式 |
|------|--------|------|
| 默认 | opacity 0 | 不占布局抖动（gutter 常在） |
| 块 hover / 焦点 | opacity 0.42 | 6-dot 2×3，弱墨 |
| handle hover | opacity 0.78 + bg-hover | cursor: grab |
| dragging | opacity 0.9 | cursor: grabbing；源块 opacity 0.45 |

尺寸：热区 22×22，图标 14×14。左簇对齐，**不**放到右侧。

### 8.2 Slash / `、` 菜单 `.mdx-slash`

| 属性 | 规格 |
|------|------|
| 宽 | min 220 / max 280 |
| 背景 | `#fff` / `--bg-popover` |
| 边框 | hairline |
| 阴影 | `--shadow-popover` **static**；hover 项 **不** 改 shadow |
| 圆角 | 12（`--radius-popover`） |
| 项高 | 32–34；图标 16 左 + 主标 13/14 + 副标 micro l2 |
| 分组标题 | micro、opacity 0.36、上 8 下 4 |
| 空匹配 | 「无匹配命令」l2 居中偏左 |
| 入场 | opacity 0→1 + translateY(3px)，280ms spring；`prefers-reduced-motion` 则瞬切 |

定位：锚在 caret 下方 4px；撞边 flip。z-index 高于 notebook（建议 90+，notebook 80）。

### 8.3 落点指示 `.mdx-drop-indicator`

- 2px 高横线，颜色 `--mdx-drop-line`，左右缩进与 content 齐（不含 gutter）。
- 两端可 3px 圆头（伪元素）。
- **禁止** 整块蓝色半透明大罩（除非嵌套容器目标，用 1px 虚线描边 + 2% 填）。

### 8.4 拖拽幽灵

- 半透明克隆（opacity 0.85），宽度跟源块 content 宽；可轻微 scale 0.98。
- 无重阴影；可用 static soft shadow 一层。

---

## 9. 动效规则

| 允许 | 规格 |
|------|------|
| 手把 / 按钮 opacity | 120ms ease（`--flow-hover-ms`） |
| 菜单入场 | 280ms spring + 3px 上移 |
| 手风琴（callout 折叠若有） | 240ms grid 0fr→1fr + spring |
| 落点线出现 | ≤120ms opacity |

| **禁止** | 原因 |
|----------|------|
| hover 时 `box-shadow` 动画 / 抬升 | 对话流硬禁令 |
| 块 hover 大面积阴影卡片化 | 阅读态变「瓷砖墙」 |
| 弹性乱晃、页面级 parallax | 冷静调性 |
| 输入时全页 fade re-render | 性能 + 眩晕 |
| 未尊重 `prefers-reduced-motion` | a11y |

```css
@media (prefers-reduced-motion: reduce) {
  .mdx-slash,
  .mdx-handle,
  .mdx-drop-indicator,
  .mdx-block {
    transition: none !important;
    animation: none !important;
  }
}
```

---

## 10. CSS 文件拆分计划

路径：`reference/chat-composer-component/css/markdown-editor/`

| 文件 | 职责 | 依赖顺序 |
|------|------|----------|
| `_tokens.css` | `.mdx-root` 私有变量；可 re-export 注释 | 1 |
| `base.css` | root、排版、选区、滚动条、空态 | 2 |
| `blocks.css` | paragraph/heading/list/todo/hr/quote | 3 |
| `table.css` | 表格皮肤 + 选中格 | 3 |
| `code.css` | 行内 + 围栏代码 | 3 |
| `callout.css` | callout 变体 | 3 |
| `chrome.css` | handle、+ 按钮、块 hover 态 | 4 |
| `slash-menu.css` | 命令面板 | 4 |
| `dnd.css` | drop indicator、ghost、dragging | 4 |
| `focus.css` | focus-visible / selection 统一 | 5 |
| `index.css` | `@import` 聚合入口 | 末 |

**加载**：Notebook 宿主在 `artifact-notebook.css` 之后引入 `css/markdown-editor/index.css`。  
**隔离**：所有选择器以 `.mdx-` 开头；禁止污染 `.nb-panel` 全局 `p/h1`（迁移期可双挂 class，见 08）。

### Class 前缀契约

| 前缀 | 用途 |
|------|------|
| `mdx-root` | 编辑器根 |
| `mdx-block` / `mdx-block--{type}` | 块容器 |
| `mdx-block.is-active` / `.is-editing` / `.is-dragging` | 状态 |
| `mdx-handle` / `mdx-gutter` | 拖拽把手 |
| `mdx-slash` / `mdx-slash__item` | 命令面板 |
| `mdx-drop-indicator` | 落点 |
| `mdx-table` / `mdx-code` / `mdx-callout` / `mdx-quote` | 皮肤 |
| `mdx-file-chip` / `mdx-wiki` | 扩展（06） |

BEM 风格：`mdx-block__body`、`mdx-code__bar`。状态用 `is-*`。

---

## 11. DOM 草图（阅读+chrome）

```html
<div class="mdx-root" data-theme="light" role="document">
  <div class="mdx-block mdx-block--paragraph is-active" data-block-id="b1">
    <div class="mdx-gutter">
      <button type="button" class="mdx-handle" aria-label="拖拽排序" tabindex="-1">
        <!-- 6-dot svg -->
      </button>
    </div>
    <div class="mdx-block__body" data-editable>
      <p>正文…</p>
    </div>
  </div>
  <!-- drop line sibling or absolute in root -->
  <div class="mdx-drop-indicator" hidden style="top: …"></div>
</div>

<!-- portal -->
<div class="mdx-slash" role="listbox" hidden>
  <div class="mdx-slash__group">基础</div>
  <button class="mdx-slash__item is-active" role="option">标题 1</button>
</div>
```

---

## 12. a11y（视觉相关）

- 对比度：正文 l0 on white ≥ 可读；placeholder 仅装饰，不承担唯一信息。
- 把手 `aria-label`；菜单 `role="listbox"` + `aria-activedescendant`。
- 焦点可见（§7）；拖拽提供键盘替代（见 [`ux/keyboard-map.md`](./ux/keyboard-map.md)）。
- 动效可关（§9）。

---

## 13. 边界情况

| 场景 | 视觉处理 |
|------|----------|
| 超长代码行 | 横向滚动，不撑破 notebook 宽 |
| 宽表格 | wrap 横向滚；表头 sticky 可选 v2 |
| 嵌套 callout | 背景不叠加深黑；仅左边条区分 |
| 空单元格 | min-height 28，点击可进编辑 |
| 窄面板（&lt;320） | gutter 缩至 22；菜单 max-width 92vw |
| 打印 | 隐藏 handle/slash/drop；纯阅读 |

---

## 14. 验收 DoD — 视觉清单（截图评审）

实现完成后，用固定夹具文档截图对比，**全部勾选**才算视觉过线：

- [ ] **V1** 正文 14px、行高约 1.7；h1=15、h2=14、h3=13，无 18+ 大标题
- [ ] **V2** 与 `nb-panel` 白底/发丝线/静态阴影一致，无第二套圆角语言
- [ ] **V3** 表格：细线、浅表头、圆角容器，非 Bootstrap 默认
- [ ] **V4** 代码：浅底无重边框；语言条 micro；无霓虹高亮
- [ ] **V5** callout/quote：克制左边条，无大色 alert
- [ ] **V6** 块 hover 仅显 6-dot 把手；无卡片阴影抬升
- [ ] **V7** slash 菜单 static shadow；项 hover 仅背景
- [ ] **V8** 落点为 2px doc-ink 线，非整块蓝罩
- [ ] **V9** focus-visible 有 ring；选区用 doc-ink 浅染
- [ ] **V10** `prefers-reduced-motion` 下无位移动画
- [ ] **V11** 中文标点/混排无乱码；file-chip 与 artifact chip 同族
- [ ] **V12** 类名全部 `mdx-`；CSS 按 §10 拆分可定位

**截图集建议**：空态 / 混合块长文 / 表+代码 / slash 打开 / 拖拽中 / 窄宽。

---

## 15. 分期（视觉）

| 期 | 交付 |
|----|------|
| M0 | `_tokens.css` + `base.css` + 空 root 挂进 notebook |
| M1 | blocks 基础排版 + focus |
| M2 | slash-menu 皮肤 |
| M3 | chrome + dnd 指示 |
| M4 | table/code/callout 抛光 |
| M5 | file-chip/wiki 皮肤 |
| M6 | 虚拟列表滚动条/sticky 微调 + desktop token 对齐检查 |

---

## 16. 测试点

- 视觉回归（Playwright/截图）夹具页：`fixtures/mdx-visual.html`
- Token 缺失时 fallback 仍可读（grep 硬编码 hex 审计）
- 对比 `artifact-notebook.css` 旧 `.md-preview` 不应双份 margin 打架（迁移后移除旧 prose 或降权）

---

## 17. 相关文档

- 集成与 class 挂载：[08-integration.md](./08-integration.md)
- 路线图：[09-implementation-roadmap.md](./09-implementation-roadmap.md)
- 键盘：[ux/keyboard-map.md](./ux/keyboard-map.md)
- 块类型视觉细节：见 `blocks/*`（实现时补）
