# 挑刺审查报告 06：主界面流式 Markdown 排版与分块渲染 Token 体系严苛审查

> **审查范围**：
> - `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css`
> - `apps/crish-desktop/src/components/chat-message-row/streaming-animation.css`
> - `apps/crish-desktop/src/components/chat-message/MessageContent.tsx` (内联样式与类名)
> - `apps/crish-desktop/src/styles/tokens.css` (相关 Markdown 变量)
>
> **审查原则**：严苛只挑刺、逐行排查硬编码魔术值、列出所有缺失的 Design Token 与语义层级断层、剖析暗黑/明亮主题 WCAG AA 对比度缺陷与 Zero-Blue 违规项。

---

## 0. 审查总览与统计数据

经过对审查范围内 4 个核心样式/组件文件及关联渲染链路的逐行静态代码与 Token 依赖拓扑审计，统计缺陷如下：

| 审查维度 | 发现缺陷数 | 严重级别分布 | 核心影响 |
| :--- | :---: | :--- | :--- |
| **硬编码色值与魔术数字** | **28 处** | P0: 6 / P1: 14 / P2: 8 | 裸写 Hex/RGB/HSL 破坏主题一致性；魔术 px 导致视口跳变 |
| **Markdown 排版 Token 完整度** | **18 项缺失** | P0: 4 / P1: 9 / P2: 5 | 标题字号无层级阶梯；行内代码与列表任务框裸奔无样式 |
| **光标与流式动画体系** | **8 处断层** | P1: 5 / P2: 3 | 双样式表定义冲突；硬编码 0.8s/100ms 且无视 Eco 性能档 |
| **暗黑/明亮主题与 WCAG AA** | **9 处违规** | P0: 3 / P1: 4 / P2: 2 | 降级回退黑字黑底导致 1.09:1 极端不可读；Zero-Blue 铁律被刺穿 |

---

## 1. 硬编码色值与魔术数字严苛排查清单

### 1.1 `ChatMessageRow.module.css` 裸写魔术值与失效 Fallback

#### (1) 刺穿 Zero-Blue 铁律的硬编码蓝色 Fallback (P0)
- **位置**：`ChatMessageRow.module.css:550, 552`
  ```css
  /* 活跃单元格呼吸脉冲边框反馈 */
  .assistantText[data-streaming='true'] table tbody tr:last-child td:last-child {
    position: relative;
    outline: 1px dashed var(--accent-color, hsl(215 90% 52%)); /* 裸写明亮蓝 hsl(215 90% 52%) */
    outline-offset: -1px;
    background: color-mix(in srgb, var(--accent-color, hsl(215 90% 52%)) 4%, transparent);
  }
  ```
- **问题**：`hsl(215 90% 52%)` 是标准饱和蓝色，直接违反 Conex 全局中性墨阶/翡翠绿「Zero-Blue 铁律」；在暗黑主题下若发生回退，将闪烁刺眼的亮蓝色虚线。

#### (2) 表格与正文强制回退亮色浅灰，暗黑模式下闪白 (P0)
- **位置**：`ChatMessageRow.module.css:335, 348, 350`
  ```css
  .assistantText table th,
  .assistantText table td {
    border-bottom: 1px solid var(--border-subtle, hsl(0 0% 92%)); /* 浅灰 92% */
  }
  .assistantText table thead th {
    background: var(--bg-card, hsl(0 0% 98%)); /* 亮白 98% */
    border-bottom: 1px solid var(--border-color, hsl(0 0% 88%)); /* 浅灰 88% */
  }
  ```
- **问题**：暗黑主题背景色为 `hsl(0, 0%, 11%)` 或 `#0c0c0b`。若 CSS 变量未加载完成或继承中断，fallback 值的 `hsl(0 0% 98%)` 会在暗黑界面瞬间炸出一道刺眼的白底灰边。

#### (3) 思考链与里程碑中的大面积裸写 Hex (P1)
- **位置**：`ChatMessageRow.module.css:638, 649, 664, 685, 737, 745, 818, 900, 908, 932, 944, 980, 988, 1000, 1027, 1083`
  - 第 638 行：`color: var(--flow-meta, var(--text-secondary, #4a4a4a));`（裸写 `#4a4a4a`）
  - 第 649 行：`color: var(--flow-meta-hover, var(--text-primary, #2a2a2a));`（裸写 `#2a2a2a`）
  - 第 664 行：`background: var(--brand, #10b981);`（裸写 `#10b981`）
  - 第 685 行：`color: var(--brand-deep, #059669);`（裸写 `#059669`）
  - 第 737 行：`color: var(--flow-chevron-color, var(--text-tertiary, #a3a3a3));`（裸写 `#a3a3a3`）
  - 第 745 行：`color: var(--flow-chevron-hover, var(--text-secondary, #7a7a7a));`（裸写 `#7a7a7a`）
  - 第 794/804 行：`var(--bg-page, #ffffff)`（裸写 `#ffffff`）
  - 第 900/980 行：`color: var(--text-secondary, #5c5850);`（裸写温暖浅褐 `#5c5850`）
  - 第 908/932 行：`color: var(--text-primary, #1c1b18);`（裸写 `#1c1b18`）
  - 第 944 行：`color: var(--text-muted, #8c877d);`（裸写 `#8c877d`）
  - 第 988 行：`background: var(--text-tertiary, #a3a3a3);`（裸写 `#a3a3a3`）
  - 第 1027 行：`color: var(--brand-deep, #059669);`（裸写 `#059669`）
  - 第 1083 行：`color: var(--flow-meta-soft, var(--text-tertiary, #5c5c5c));`（裸写 `#5c5c5c`）
- **问题**：这些硬编码 Hex 绝大多数来自特定浅色模式调色板，在暗黑模式下如果发生回退，`#1c1b18`（几乎纯黑）在暗黑背景（`#0c0c0b`）上渲染，对比度仅 **1.09:1**，文字直接隐形！

#### (4) 裸写魔术数字像素（Magic Px / Sub-pixel） (P1)
- `ChatMessageRow.module.css:5`: `margin-bottom: 22px;`（非标准间距，未走 `--space-*`）
- `ChatMessageRow.module.css:12`: `scroll-margin-top: 56px;`（硬编码顶部导航高度）
- `ChatMessageRow.module.css:65`: `border-radius: 14px 14px 4px 14px;`（异形气泡未抽象 Token）
- `ChatMessageRow.module.css:66`: `padding: 10px 14px;`（裸写非标准内边距）
- `ChatMessageRow.module.css:131`: `margin: 8px 0 2px;`（硬编码局部 margin）
- `ChatMessageRow.module.css:138`: `padding: 5px 12px;`（裸写 5px）
- `ChatMessageRow.module.css:155`: `margin: 10px 0 4px;`
- `ChatMessageRow.module.css:188`: `padding: 5px 10px 5px 12px; max-width: 220px;`
- `ChatMessageRow.module.css:333`: `padding: 8px 12px;`（表格单元格裸写内边距）
- `ChatMessageRow.module.css:563-564`: `max-width: min(100%, 420px); max-height: 280px;`
- `ChatMessageRow.module.css:850-858`: `top: 30px; left: 7.625px; width: 0.75px;`（极度脆弱的亚像素 `7.625px` 和 `0.75px` 脊柱绝对定位，在高 DPI 缩放 125%/150% 下会发生 1px 锯齿错位）

---

### 1.2 `streaming-animation.css` 裸写色值与动画魔术值

#### (1) 打字机光标裸写 Tailwind 蓝灰 Hex (P0)
- **位置**：`streaming-animation.css:74`
  ```css
  .conex-streaming-caret {
    display: inline-block;
    width: 2px;
    height: 0.95em;
    margin-left: 2px;
    vertical-align: text-bottom;
    background: var(--text-tertiary, #94a3b8); /* 裸写 #94a3b8 (Slate-400) */
    border-radius: 1px;
    animation: conex-caret-blink 0.8s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }
  ```
- **问题**：
  1. `#94a3b8`（RGB: 148, 163, 184 / HSL: 215, 20%, 65%）是典型的带蓝调灰（Slate），严重违背 Conex UI 中性无蓝准则。
  2. `#94a3b8` 在纯白背景（`#ffffff`）下的对比度仅为 **2.52:1**，未达到 WCAG AA 非文本 UI 元素 3:1 的基线要求。

#### (2) 动画时长与贝塞尔曲线魔术值硬编码 (P1)
- **位置**：`streaming-animation.css:10, 21, 35-37, 53, 76, 87`
  - `transform: translateY(2px);`（硬编码位移距离 2px）
  - `animation-duration: var(--sd-duration, var(--conex-duration, 100ms));`（硬编码 100ms）
  - `animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1);`（未复用 `--easing-enter`）
  - `animation: conex-caret-blink 0.8s cubic-bezier(0.4, 0, 0.6, 1) infinite;`（硬编码 0.8s 与贝塞尔曲线）
  - `contain-intrinsic-size: auto 48px;`（封口块假设固定高度 48px，若真实内容高达 300px 会引发滚动条跳变）

---

### 1.3 `MessageContent.tsx` 内联样式与未定义 Token

#### (1) `ErrorMessageBanner` 充斥内联魔术数字与假 Token (P0)
- **位置**：`MessageContent.tsx:51-64`
  ```tsx
  <div
    style={{
      padding: '10px 14px',
      background: 'var(--bg-error-subtle, rgba(239, 68, 68, 0.04))',
      border: '1px solid var(--border-color)',
      borderRadius: 6,
      fontSize: 13,
      color: 'var(--text-secondary)',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
    }}
  >
    <AlertCircle size={13} style={{ color: 'var(--color-error)' }} />
  ```
- **问题**：
  1. `--bg-error-subtle` 在 `tokens.css` 中**根本不存在**（未定义变量，属于虚假 Token）。
  2. 依赖 fallback `rgba(239, 68, 68, 0.04)`，在暗黑模式 `#0c0c0b` 下计算出的背景为 `#150d0d`，与正文背景无任何视知觉反差。
  3. `padding: '10px 14px'`, `borderRadius: 6`, `fontSize: 13`, `gap: 8`, `<AlertCircle size={13} />` 全部是裸写数字，未走 `--space-*`、`--radius-md`、`--font-size-sm`。

---

## 2. Markdown 排版 Token 体系缺失与语义层级断层

通过对 `tokens.css` 与 `ChatMessageRow.module.css` 的对比审计，当前设计系统在 Markdown 排版领域存在极其严重的 **Token 供给断层**。

### 2.1 `tokens.css` 现存 Markdown Token 现状（仅 4 个！）
在 `tokens.css` 超过 1070 行的样式定义中，与 Markdown 直接相关的 Token 竟然仅有以下 4 个变量：
```css
--md-code-bg: ...;
--md-code-border: ...;
--md-code-fg: ...;
--md-code-tab-size: 2;
```
除此之外，**所有正文、标题、列表、引用、表格、分割线、行内代码、交互式路径链接均无独立 `--md-*` Token！**

---

### 2.2 核心 Markdown 元素 Token 缺失与样式断层清单

#### (1) 标题（Headings H1 ~ H6）字号扁平化与层级灾难 (P0)
- **现状代码** (`ChatMessageRow.module.css:292-301`)：
  ```css
  .assistantText :global(.md-h1),
  .assistantText :global(.md-h2),
  .assistantText :global(.md-h3),
  .assistantText :global(.md-h4),
  .assistantText :global(.md-h5),
  .assistantText :global(.md-h6) {
    margin: 0.35em 0 0.25em;
    font-weight: var(--font-weight-semibold, 600);
    line-height: 1.35;
  }
  ```
- **灾难表现**：
  - `h1` 到 `h6` **完全没有定义 `font-size` 规则**！
  - 所有标题直接继承父级 `.assistantText` 的 `font-size: var(--font-size-base, 14px)`。
  - 一个包含顶级一级标题 `# 系统架构总览` 和六级标题 `###### 补充说明` 的长文档，在界面上呈现出的字号居然**完全一模一样（全部是 14px）**，仅有 600 粗体，排版层级彻底被抹平！
- **缺失 Token**：
  - `--md-h1-size`, `--md-h1-line-height`, `--md-h1-margin`
  - `--md-h2-size`, `--md-h2-line-height`, `--md-h2-margin`
  - `--md-h3-size`, `--md-h3-line-height`, `--md-h3-margin`
  - `--md-h4-size`, `--md-h4-line-height`, `--md-h4-margin`

#### (2) 行内代码（Inline Code `.md-inline-code`）样式裸奔 (P0)
- **现状**：
  - Rust 渲染器生成 `<code class="md-inline-code">...</code>`。
  - 在 `ChatMessageRow.module.css` 中**对 `.md-inline-code` 的选择器规则数为 0**！
  - 在 `shell-reset.css:58` 中仅声明了 `font-weight: var(--font-weight-code, 400); tab-size: 2;`。
- **灾难表现**：
  - 助手输出的正文行内代码没有背景色（`background`）、没有微圆角（`border-radius`）、没有内边距（`padding`）、没有微弱边框（`border`）。
  - 用户在阅读 `使用 \`cargo run\` 启动` 时，`cargo run` 与前后汉字混在一起，无任何视觉胶囊隔离。
- **缺失 Token**：
  - `--md-code-inline-bg`, `--md-code-inline-fg`, `--md-code-inline-border`, `--md-code-inline-radius`, `--md-code-inline-padding`, `--md-code-inline-size`

#### (3) 交互式本地路径链接（`.md-path-link`）与超链接（`.md-a`）样式丢失 (P0)
- **现状**：
  - Rust 渲染器输出 `<button type="button" class="md-path-link" data-path="...">`。
  - 在整个前端工程中，`.md-path-link` **没有任何 CSS 样式表命中**！
- **灾难表现**：
  - 浏览器将按原生 `<button>` 渲染，在 Windows WebKit/Blink 下显示为带灰底、立体浮雕边框的原生按钮，极其突兀丑陋。
  - `.md-a` 超链接亦无 hover 下划线平滑过渡或外链图标指示 Token。
- **缺失 Token**：
  - `--md-path-link-bg`, `--md-path-link-hover-bg`, `--md-path-link-fg`, `--md-path-link-radius`, `--md-path-link-font`
  - `--md-link-color`, `--md-link-hover-color`, `--md-link-underline-offset`

#### (4) 任务列表项（Task List `.md-task-item` / `.md-task-box`）无对齐与状态样式 (P1)
- **现状**：
  - Rust 渲染器输出 `<li class="md-li md-task-item done"><span class="md-task-box checked">...`。
  - `ChatMessageRow.module.css` 中完全缺失 `.md-task-item`、`.md-task-box`、`.done` 规则。
- **灾难表现**：
  - 复选框 `span.md-task-box` 宽高为 0，勾选状态无法显示；已完成任务文本无删除线（`line-through`）或弱化颜色。
- **缺失 Token**：
  - `--md-task-box-size`, `--md-task-box-border`, `--md-task-box-radius`, `--md-task-box-bg`, `--md-task-box-checked-bg`

#### (5) 引用块（Blockquote `.md-quote`）使用魔术数字 (P1)
- **现状** (`ChatMessageRow.module.css:309-315`)：
  ```css
  .assistantText :global(.md-quote) {
    margin: 0.35em 0;
    padding-left: 1em;
    border-left: 3px solid var(--border-color);
    color: var(--text-secondary);
  }
  ```
- **缺失 Token**：
  - `--md-quote-border-left-width`（硬编码 3px）
  - `--md-quote-border-color`
  - `--md-quote-padding-left`（硬编码 1em）
  - `--md-quote-margin-y`（硬编码 0.35em）
  - `--md-quote-bg`（无背景衬垫 Token）

#### (6) 表格斑马纹与间距 Token 缺失 (P1)
- **现状**：
  - Rust 渲染器生成交替行 `<tr class="md-tr md-tr-alt">`。
  - `ChatMessageRow.module.css` **完全没有定义 `.md-tr-alt` 的样式**，斑马纹能力彻底失效。
  - `padding: 8px 12px;` 裸写魔术值。
- **缺失 Token**：
  - `--md-table-zebra-bg`
  - `--md-table-cell-pad-x`, `--md-table-cell-pad-y`
  - `--md-table-header-bg`, `--md-table-header-fg`, `--md-table-header-border`
  - `--md-table-active-outline`, `--md-table-active-bg`

---

## 3. 打字光标 Caret 与流式动画 Token 割裂与硬编码

### 3.1 两个样式表定义冲突与割裂 (P1)

项目中存在两套互相冲突的光标定义：

| 维度 | `ChatMessageRow.module.css` (第 517-533 行) | `streaming-animation.css` (第 68-83 行) | 冲突影响 |
| :--- | :--- | :--- | :--- |
| **类选择器** | `.assistantText.isStreaming::after, .streamingCaret` | `.conex-streaming-caret` | 选择器命名割裂，双轨并存 |
| **动画机制** | `animation: caret var(--transition-blink) infinite;` (`1s step-end`) | `animation: conex-caret-blink 0.8s cubic-bezier(...) infinite;` | 一边是 1.0s 阶跃闪烁，一边是 0.8s 渐变呼吸，视觉节奏不一致 |
| **光标颜色** | `background: var(--text-tertiary);` (无 fallback) | `background: var(--text-tertiary, #94a3b8);` (蓝灰 Hex) | 主题颜色解析不一致 |
| **间距与圆角** | `margin-left: var(--space-0_5);` / 无圆角 | `margin-left: 2px;` / `border-radius: 1px;` | 几何形体不一致 |

### 3.2 缺乏流式专用 Design Token (P1)
当前工程中完全缺失 `--stream-*` 命名空间：
- 缺少 `--stream-caret-width`（硬编码 2px）
- 缺少 `--stream-caret-height`（硬编码 0.95em）
- 缺少 `--stream-caret-color`
- 缺少 `--stream-caret-radius`
- 缺少 `--stream-caret-blink-duration`
- 缺少 `--stream-fade-duration`（硬编码 100ms）
- 缺少 `--stream-fade-offset-y`（硬编码 2px）
- 缺少 `--stream-turbo-containment`

### 3.3 性能档位穿透失效：Eco 档无视流式动画 (P1)
- 在 `tokens.css:1056-1070` 中，`html[data-perf-tier='eco']` 将所有 transition 归零为 `0ms`。
- 但是在 `streaming-animation.css` 中：
  ```css
  [data-conex-animate="true"],
  [data-sd-animate="true"] {
    animation-name: conex-fade-in;
    animation-duration: var(--sd-duration, var(--conex-duration, 100ms));
  }
  ```
- **缺陷**：未适配 `html[data-perf-tier='eco']` 或 `@media (prefers-reduced-motion)`，在低配或省电模式下，依然对每个分块执行 CSS Keyframe 动画，浪费 GPU 算力。

---

## 4. 暗黑 / 明亮主题适配与 WCAG AA 对比度违规审查

根据 WCAG 2.1 规范：
- **正文文本（Normal Text < 18pt / 24px）**：对比度必须 **≥ 4.5:1**（AA 级标准）；
- **UI 控件与非文本图形（Graphical Objects & UI Components）**：对比度必须 **≥ 3.0:1**（SC 1.4.11 标准）。

对相关色值在 Light (`#ffffff` / `#f4f5f7`) 与 Dark (`#0c0c0b` / `#141412`) 下进行严格色度对比计算：

```
WCAG 对比度公式: (L1 + 0.05) / (L2 + 0.05)
```

| 元素 / 位置 | 声明色值与 Fallback | 背景色 | 测算对比度 | WCAG AA 判定 | 缺陷说明 |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **打字光标 Caret**<br>`streaming-animation.css:74` | `#94a3b8` (Slate-400 fallback) | Light `#ffffff` | **2.52 : 1** | <font color="red">**FAIL (< 3.0:1)**</font> | 浅色模式下光标对比度严重不足，且存在蓝调污染 |
| **步骤数字标题**<br>`ChatMessageRow.module.css:908` | `var(--text-primary, #1c1b18)` | Dark `#0c0c0b` | **1.09 : 1** | <font color="red">**CRITICAL FAIL (< 4.5:1)**</font> | 暗黑模式回退到黑字，黑字黑底，文字直接隐形 |
| **思考链元信息**<br>`ChatMessageRow.module.css:638` | `var(--flow-meta, var(--..., #4a4a4a))` | Dark `#0c0c0b` | **2.06 : 1** | <font color="red">**FAIL (< 4.5:1)**</font> | 暗黑模式 fallback 为浅色深灰 `#4a4a4a`，对比度严重不足 |
| **折叠箭头 Chevron**<br>`ChatMessageRow.module.css:737` | `var(--..., #a3a3a3)` | Light `#ffffff` | **2.59 : 1** | <font color="red">**FAIL (< 3.0:1)**</font> | 浅色模式下 fallback `#a3a3a3` 图标对比度未达 3:1 |
| **错误横幅背景与图标**<br>`MessageContent.tsx:54` | `rgba(239, 68, 68, 0.04)`<br>`var(--color-error)` | Dark `#0c0c0b`<br>Light `#ffffff` | **1.04 : 1** (背景反差)<br>**3.55 : 1** (图标) | <font color="red">**FAIL (< 4.5:1)**</font> | 假 Token `--bg-error-subtle`，4% 红色在暗黑模式完全融为黑底 |
| **流式活跃表格单元格**<br>`ChatMessageRow.module.css:552` | `hsl(215 90% 52%) 4% mix` | Dark `#0c0c0b`<br>Light `#ffffff` | **1.02 : 1** | <font color="red">**FAIL**</font> | 4% 极低饱和混色，脉冲背景几乎完全不可见，且违背 Zero-Blue |
| **子步骤圆点**<br>`ChatMessageRow.module.css:988` | `var(--text-tertiary, #a3a3a3)` | Light `#ffffff` | **2.59 : 1** | <font color="red">**FAIL (< 3.0:1)**</font> | 浅色下 4px 小圆点清晰度不足 |

---

## 5. 挑刺审查缺陷清单（DEF-TYPO）

| 缺陷编号 | 缺陷分类 | 严重级别 | 缺陷定位 | 核心表现与破坏力 |
| :--- | :--- | :--- | :--- | :--- |
| **DEF-TYPO-01** | 排版层级断层 | **P0 致命** | `ChatMessageRow.module.css:292` | 标题 h1~h6 无 font-size 阶梯定义，全部平铺为 14px，视觉层级彻底坍塌 |
| **DEF-TYPO-02** | 样式完全裸奔 | **P0 致命** | `ChatMessageRow.module.css` (缺失) | 行内代码 `.md-inline-code`、路径链接 `.md-path-link`、超链接 `.md-a` 零样式 |
| **DEF-TYPO-03** | 暗黑模式文字隐形 | **P0 致命** | `ChatMessageRow.module.css:908` | Fallback `#1c1b18` 在暗黑主题下引发黑字黑底（对比度 1.09:1），严重不可读 |
| **DEF-TYPO-04** | 假 Token 与内联魔术 | **P0 致命** | `MessageContent.tsx:54` | 引用未定义假 Token `--bg-error-subtle`，充斥内联魔术数字与不可读色值 |
| **DEF-TYPO-05** | Zero-Blue 铁律穿透 | **P0 致命** | `ChatMessageRow.module.css:550`<br>`streaming-animation.css:74` | 裸写亮蓝 `hsl(215 90% 52%)` 与 Tailwind 蓝灰 `#94a3b8`，破坏纯中性设计准则 |
| **DEF-TYPO-06** | 浅白暗黑闪白 | **P1 严重** | `ChatMessageRow.module.css:335, 348` | 表格 fallback 裸写浅白 `hsl(0 0% 98%)`，暗黑主题切换瞬间发生刺眼闪白 |
| **DEF-TYPO-07** | 光标定义严重割裂 | **P1 严重** | `ChatMessageRow.module.css:517`<br>`streaming-animation.css:68` | 存在双套光标类名、双套动画频率（1s step vs 0.8s bezier），无统一 Token |
| **DEF-TYPO-08** | 省电模式性能击穿 | **P1 严重** | `streaming-animation.css:30` | GPU 逐词淡入动画无视 `html[data-perf-tier='eco']` 与减弱动效偏好 |
| **DEF-TYPO-09** | 任务列表与斑马纹失效 | **P1 严重** | `ChatMessageRow.module.css` (缺失) | 缺少 `.md-task-box`、`.done` 及 `.md-tr-alt` 规则，Rust 渲染特性无法展现 |
| **DEF-TYPO-10** | 脆弱的亚像素绝对定位 | **P1 严重** | `ChatMessageRow.module.css:856` | 脊柱线裸写 `left: 7.625px; width: 0.75px;`，不同 DPI 缩放下发生锯齿偏移 |
| **DEF-TYPO-11** | 封口块高度假设崩塌 | **P2 一般** | `streaming-animation.css:87` | `contain-intrinsic-size: auto 48px` 假设偏窄，大代码块离屏引发滚动跳跃 |
| **DEF-TYPO-12** | 引用块魔术数字边框 | **P2 一般** | `ChatMessageRow.module.css:312` | 裸写 `border-left: 3px solid` 与 `padding-left: 1em`，缺乏 `--md-quote-*` Token |
| **DEF-TYPO-13** | 大量未收敛 Hex 色值 | **P2 一般** | `ChatMessageRow.module.css` (14 处) | 散落 `#4a4a4a`, `#2a2a2a`, `#5c5850`, `#8c877d` 等，未收敛至设计变量 |
| **DEF-TYPO-14** | 缺少 `--stream-*` 体系 | **P2 一般** | `tokens.css` (全篇缺失) | 全局 Design Token 缺少流式渲染、光标、分块间隙专用变量命名空间 |

---

## 6. 治理建议与建议 Token 体系蓝图（供后续重构执行参考）

### 6.1 `tokens.css` 建议补充的核心 Markdown & 流式 Token 蓝图

```css
/* 建议新增至 tokens.css: Markdown 排版 Token 体系 */
:root {
  /* 1. 标题 Typography Scale */
  --md-h1-size: calc(var(--font-size-base) * 1.35); /* ~19px */
  --md-h2-size: calc(var(--font-size-base) * 1.2);  /* ~17px */
  --md-h3-size: calc(var(--font-size-base) * 1.1);  /* ~15.5px */
  --md-h4-size: var(--font-size-base);              /* 14px */
  --md-h1-margin: 0.55em 0 0.3em;
  --md-h2-margin: 0.45em 0 0.25em;
  --md-h3-margin: 0.4em 0 0.2em;

  /* 2. 行内代码与引用 */
  --md-code-inline-bg: color-mix(in srgb, var(--text-primary) 5%, transparent);
  --md-code-inline-fg: var(--text-primary);
  --md-code-inline-border: color-mix(in srgb, var(--border-color) 80%, transparent);
  --md-code-inline-radius: var(--radius-sm, 4px);
  --md-code-inline-pad: 2px 5px;
  --md-quote-border-color: var(--border-color);
  --md-quote-border-width: 3px;
  --md-quote-pad-left: var(--space-3, 12px);

  /* 3. 表格与斑马纹 */
  --md-table-zebra-bg: color-mix(in srgb, var(--text-primary) 2%, transparent);
  --md-table-pad-x: var(--space-3, 12px);
  --md-table-pad-y: var(--space-2, 8px);
  --md-table-header-bg: var(--bg-card);
  --md-table-active-outline: var(--brand, #10b981);

  /* 4. 任务列表与路径链接 */
  --md-task-box-size: 14px;
  --md-task-box-radius: 3px;
  --md-path-link-bg: color-mix(in srgb, var(--text-primary) 4%, transparent);
  --md-path-link-hover-bg: color-mix(in srgb, var(--text-primary) 8%, transparent);
  --md-path-link-fg: var(--text-primary);
  --md-path-link-radius: var(--radius-sm, 4px);

  /* 5. 流式打字机与动画 Token (--stream-*) */
  --stream-caret-width: 2px;
  --stream-caret-height: 0.95em;
  --stream-caret-color: var(--text-tertiary);
  --stream-caret-radius: 1px;
  --stream-caret-duration: 1s;
  --stream-fade-duration: 100ms;
  --stream-fade-offset-y: 2px;
  --stream-chunk-gap: 0.85em;

  /* 6. 语义背景补充 */
  --bg-error-subtle: color-mix(in srgb, var(--color-error) 6%, transparent);
}
```
