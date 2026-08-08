# Premium Markdown Renderer

这是一个极致追求视觉体验与排版细节的高级 Markdown 渲染组件库。该组件基于严格的 HLS 色彩系统构建，特别剔除了所有偏冷、偏蓝的色调，采用“沙珀金 (Sandstone & Amber)”与“高级暖灰 (Warm Ash)”作为主视觉基调，旨在提供类似 Obsidian/Notion 般沉浸、专注、无干扰的阅读体验。

## 核心特性
1. **纯净 HLS 暖色盘**：使用 `hsl()` 定义所有色彩令牌，彻底抛弃 HEX 与 RGB，让主题定制更符合人类直觉。
2. **万行长文性能优化**：底层融入了 `content-visibility: auto` 和 `contain-intrinsic-size`，确保数万行 Markdown 渲染依然如丝般顺滑。
3. **黄金比例排版**：严格执行 14px 基础字号、1.7 行高以及 Modular Scale 的标题体系。
4. **全特性支持**：覆盖从基础文本、嵌套列表、任务清单，到复杂的 LaTeX 数学公式和 Mermaid 流程图。

## 包含文件
- `premium-markdown.css` (>900 行): 完整的样式定义。
- `premium-markdown.html`: 包含穷举 18 种语法的测试厨房 (Kitchen Sink) 以及依赖注入。

## 如何接入项目
1. 将 `premium-markdown.css` 引入你的 HTML 或构建工具链中。
2. 确保渲染输出的最外层包裹在 `class="premium-markdown"` 的容器内。
3. 可选：如果在 React/Vue 中使用，建议搭配 `PrismJS` (代码高亮)、`KaTeX` (公式) 和 `mermaid.js` 插件使用，组件已为其提供了最完美的琥珀色适配主题。

## 自定义主题 (HLS Tokens)
你可以在 `:root` 下微调主色调，例如更改 `Hue` 值：
```css
:root {
  /* 将 25 更改为其他暖色调数值，如 10 (正红) 或 45 (金黄) */
  --pm-accent-base: hsl(25, 85%, 55%);
}
```
