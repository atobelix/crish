/**
 * markdown-editor/demo/showcase-sample.js
 * 完整能力审查 SAMPLE（活文档）— 供 markdown-editor.html 加载
 * 章节顺序对齐 v3-complete/06-showcase-demo §2.3 + 近期 P0/P1
 */
(function (root) {
  'use strict';

  var SAMPLE =
    '# Conex Markdown · 完整能力审查\n\n' +
    '本文是**可编辑的活文档**：点选即改，用来核对当前已实现能力与体验。\n\n' +
    '> [!NOTE]\n' +
    '> **产品原则**：Markdown 是真相 · Block 是体验 · AI 仅宿主端口。\n' +
    '> **交互**：未聚焦 = 精致渲染；聚焦 = 预览质感 + 灰结构标（非等宽整行 dump）。\n' +
    '> **页面壳**：无页顶格式条。格式靠源码手感、快捷键、`/` / `、`；调试在右下 **···**。\n\n' +
    '## 0 · 如何验收（请先读）\n\n' +
    '1. **软编辑**：点标题 → 灰 `##` + 正文仍粗体/斜体；**不要**整行 monospaced 源码墙\n' +
    '2. **行内定界符**：点进粗体 → 灰 `**`；词首 Backspace 拆格式\n' +
    '3. **Callout**：点 NOTE → 「注意」+ `[!NOTE]` + 正文粗体，失焦与读态同构\n' +
    '4. **多选**：拖选只高亮；块末 Shift+↓ 扩展选区；`Ctrl+C` 复制 GFM\n' +
    '5. **列表**：空 bullet 按 Enter → 退出列表（变段落）\n' +
    '6. **代码**：行号 + 折叠 + 点语言改 lang；复制无行号\n' +
    '7. **表 / 动效 / Slash**：对齐表、`/` 淡入、可插 H4\n\n' +
    '- [ ] 软编辑无跳变（标题/列表/callout）\n' +
    '- [ ] Callout 读/编同构（中文标签 + 灰 kind）\n' +
    '- [ ] 光标邻域灰 `**` + 成对 Backspace\n' +
    '- [ ] 代码行号/折叠/语言菜单\n' +
    '- [ ] 表列对齐 + 合并菜单\n' +
    '- [ ] 空列表 Enter 退出列表\n' +
    '- [ ] Slash / Ctrl+P 有 enter 淡入\n' +
    '- [ ] 无页顶格式条 / 无整行描边\n\n' +
    '## 1 · 基础 Markdown\n\n' +
    '普通段落：中英文混排与 **粗体**、*斜体*、~~删除线~~、`行内代码`、[链接](https://example.com)、==高亮==、++下划线++。\n\n' +
    '在 **粗体短语** 上点一下，核对灰定界符；再点到句外，定界符应收起。\n\n' +
    '### 标题层级\n\n' +
    '#### 四级标题\n\n' +
    '##### 五级标题\n\n' +
    '###### 六级标题\n\n' +
    '分割线如下：\n\n' +
    '---\n\n' +
    '## 2 · 列表与任务\n\n' +
    '- 无序一项（点圆点：`·` ↔ `*`）\n' +
    '- 无序二项\n' +
    '  - 嵌套一层\n' +
    '    - 再嵌一层\n\n' +
    '1. 有序第一\n' +
    '2. 有序第二\n' +
    '3. 有序第三\n\n' +
    '- [x] 软编辑主路径\n' +
    '- [x] 行内定界符邻域\n' +
    '- [x] 代码读态行号\n' +
    '- [x] 表 GFM align 解析\n' +
    '- [x] 动效 CSS 基线（popover enter / delim opacity）\n' +
    '- [ ] 字符级跨块选区（未做）\n' +
    '- [ ] 🔄 代码折叠行为（CSS `.mdx-code-fold-btn` 已备，JS 未合入）\n' +
    '- [ ] 🔄 语言菜单行为（CSS `.mdx-code-lang-menu` 已备，JS 未合入）\n' +
    '- [ ] 🔄 图片灯箱行为（CSS `.mdx-lightbox` 已备，JS 未合入）\n' +
    '- [ ] 🔄 成对删定界符（逻辑未合入）\n\n' +
    '## 3 · 行内格式（快捷键）\n\n' +
    '| 操作 | 快捷键 | 验收 |\n' +
    '| --- | --- | --- |\n' +
    '| 粗体 | Ctrl+B | 选区 toggle；键入 `**x**` 折叠 |\n' +
    '| 斜体 | Ctrl+I | 同上 |\n' +
    '| 删除线 | Ctrl+Shift+X 或 `~~` | 视实现 |\n' +
    '| 行内码 | `` ` `` | 键入闭合折叠 |\n\n' +
    '试打：在下方空段输入 `**demo**` 后应立即变粗。\n\n' +
    '\n\n' +
    '## 4 · 引用与 Callout\n\n' +
    '> 普通引用：激活反馈靠光标与把手，不是色块描边。\n\n' +
    '> [!NOTE]\n' +
    '> **页面壳** 与 **软编辑**：单行 callout 标题可为类型标签，正文渲染粗体。\n\n' +
    '> [!TIP]\n' +
    '> 输入 `/callout` 或 `/` 选「高亮提示」。\n\n' +
    '> [!IMPORTANT]\n' +
    '> 合并表导出 GFM 会展开；JSON Doc 可保留 rowspan。\n\n' +
    '> [!WARNING]\n' +
    '> 勿在编辑器内接 mock AI；无宿主 `complete` 时 AI 项应不可用。\n\n' +
    '> [!CAUTION]\n' +
    '> 全源码 `fullSourceEdit` 仅调试；产品默认 soft。\n\n' +
    '## 5 · 代码（行号 · 高亮 · 单表面）\n\n' +
    '读态应见左侧 **行号**；点代码区进入 **同一卡片** 源码（含围栏）；Esc/失焦回读。\n\n' +
    '验收（折叠 / 语言菜单 — **未合入行为则保持未勾**）：\n\n' +
    '- [ ] 行号与高亮\n' +
    '- [ ] 单表面读↔源\n' +
    '- [ ] 🔄 折叠按钮收起长代码（`.mdx-code-fold-btn`）\n' +
    '- [ ] 🔄 语言菜单切换 lang（`.mdx-code-lang-menu`）\n\n' +
    '```js\n' +
    '// 多行 JS — 核对行号 1..N 与高亮\n' +
    'function softEdit(block) {\n' +
    "  const marks = parseInline(block.text);\n" +
    '  return renderSoft(marks);\n' +
    '}\n' +
    "console.log(softEdit({ text: '**ok**' }));\n" +
    '```\n\n' +
    '```python\n' +
    'def train(epochs: int = 3):\n' +
    '    for i in range(epochs):\n' +
    '        step(i)\n' +
    '    return True\n' +
    '```\n\n' +
    '```ts\n' +
    'export type Block = { id: string; type: string; text?: string };\n' +
    'export function isTextLike(t: string): boolean {\n' +
    "  return ['paragraph', 'heading'].includes(t);\n" +
    '}\n' +
    '```\n\n' +
    '```rust\n' +
    'fn main() {\n' +
    '    println!("conex-mdx");\n' +
    '}\n' +
    '```\n\n' +
    '```diff\n' +
    '- fullSource dump monospaced\n' +
    '+ soft edit + grey structure marks\n' +
    '```\n\n' +
    '```json\n' +
    '{\n' +
    '  "version": 2,\n' +
    '  "softEdit": true\n' +
    '}\n' +
    '```\n\n' +
    '## 6 · Mermaid\n\n' +
    '```mermaid\n' +
    'graph LR\n' +
    '  MD[Markdown] --> B[Blocks]\n' +
    '  B --> R[Render]\n' +
    '  B --> E[Soft Edit]\n' +
    '  E --> MD\n' +
    '```\n\n' +
    '```mermaid\n' +
    'sequenceDiagram\n' +
    '  participant U as User\n' +
    '  participant E as Editor\n' +
    '  U->>E: focus block\n' +
    '  E-->>U: soft surface + grey marks\n' +
    '```\n\n' +
    '## 7 · 数学公式\n\n' +
    '行内：$E=mc^2$ · $\\alpha+\\beta$ · 货币不应误判：$3 到 $5。\n\n' +
    '$$\n' +
    '\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}\n' +
    '$$\n\n' +
    '$$\n' +
    '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n' +
    '$$\n\n' +
    '## 8 · 表格（对齐 · 网格 · 合并）\n\n' +
    '### 对齐验收表（GFM separator）\n\n' +
    '| 左对齐 | 居中 | 右对齐 |\n' +
    '| :--- | :---: | ---: |\n' +
    '| left | center | right |\n' +
    '| 中文列 | 中间 | 999 |\n' +
    '| a | b | c |\n\n' +
    '### 能力表\n\n' +
    '| 能力 | 状态 | 说明 |\n' +
    '| --- | --- | --- |\n' +
    '| 软编辑 | ✅ | renderSoftEditSurface |\n' +
    '| 定界符邻域 | ✅ | ux-D2 caret near |\n' +
    '| 代码行号 | ✅ | mdx-code-gutter |\n' +
    '| 表 align | ✅ | parseAlignRow |\n' +
    '| 多选 chrome | ✅ | 不刷源码 |\n' +
    '| 动效 CSS | ✅ | motion.css popover/delim |\n' +
    '| 折叠/语言菜单 | 🔄 | CSS 钩子；JS 未合入 |\n' +
    '| 灯箱 | 🔄 | CSS 钩子；JS 未合入 |\n' +
    '| 字符跨块 | ❌ | 后置 |\n\n' +
    '### 合并练习（拖选 → 右键合并）\n\n' +
    '| A1 | B1 | C1 |\n' +
    '| --- | --- | --- |\n' +
    '| A2 | B2 | C2 |\n' +
    '| A3 | B3 | C3 |\n\n' +
    '## 9 · 媒体\n\n' +
    '![示意图](assets/icons/image.svg "Conex 图片占位")\n\n' +
    '空段 `/image` 插图；**粘贴截图** 走宿主 `uploadImage`（本页 blob 本地预览）。\n\n' +
    '- [ ] 图片读态 figure 正常\n' +
    '- [ ] 🔄 点击/双击灯箱放大（`.mdx-lightbox`；**行为未接线则勿勾**）\n\n' +
    '## 10 · 结构 · TOC · 双链\n\n' +
    '@[toc]\n\n' +
    '文档链：[[doc:ICESat-2数据]] · [[doc:产品愿景|打开愿景]] · 文件：[[file:docs/design.md|设计说明]]\n\n' +
    '独占文件芯片：\n\n' +
    '[[file:src/main.rs|主入口]]\n\n' +
    '标签示意：`#遥感` `#编辑器`（词法增强中；系统标签后置）。\n\n' +
    '> [!NOTE]\n' +
    '> **反链** 由宿主索引；编辑器只暴露本页出链。\n\n' +
    '## 11 · 多选 · 剪贴板 · 撤销\n\n' +
    '**多选**：Shift+点块 或拖选多块 → 浅蓝高亮；复制为 GFM 多块。\n\n' +
    '**粘贴**：从别处复制 MD / HTML / 纯文本粘贴进空段，应成块而非脏 HTML。\n\n' +
    '**撤销**：连续打字应合并；Mod+Z / Mod+Shift+Z。\n\n' +
    '## 12 · 动效与微交互（核对）\n\n' +
    '- [ ] Slash `/` 打开：短淡入 + 微上移（非弹跳）\n' +
    '- [ ] Ctrl+P 命令面板：dialog + backdrop enter\n' +
    '- [ ] 表右键 ctx：短淡入（static shadow，无 shadow 动画）\n' +
    '- [ ] 插入新块：轻入场 opacity/transform\n' +
    '- [ ] 把手 hover：opacity 渐显\n' +
    '- [ ] 表 `+`：opacity 过渡\n' +
    '- [ ] 多选块：浅蓝底短促 transition（无 border 动画）\n' +
    '- [ ] 代码读↔源：表面切换无双壳闪两套\n' +
    '- [ ] 定界符显隐：opacity ≤90ms，不剧烈闪烁\n' +
    '- [ ] Toast / ··· 菜单：克制\n' +
    '- [ ] prefers-reduced-motion：动画关闭\n\n' +
    '原则：**短而完整**（~90–200ms）、**服务空间关系**、**禁止阴影呼吸与激活行描边动画**。\n\n' +
    '逐步清单见：`docs/markdown-editor/ux-readiness/10-showcase-review-checklist.md`。\n\n' +
    '## 13 · AI 端口（宿主）\n\n' +
    '- 编辑器 **不内置模型**、**禁止 mock 输出**\n' +
    '- 宿主注入 `ai.complete` 后，命令面板才出现扩写/润色等\n' +
    '- 本页默认 **不** 注入 AI（正确关闭）\n' +
    '- Ctrl+P 打开命令面板核对\n\n' +
    '## 14 · 导入导出\n\n' +
    '- ··· → 复制 Markdown\n' +
    '- ··· → 查看源码（整页只读调试）\n' +
    '- pure-gfm 导出会剥离部分 Conex 扩展\n' +
    '- PDF/Word 属宿主\n\n' +
    '## 15 · 总验收清单\n\n' +
    '- [ ] U1 章节齐全、可扫读\n' +
    '- [ ] U2 代码高亮 / 点源码 / 行号\n' +
    '- [ ] U3 软编辑 + 定界符邻域 + 非裸源\n' +
    '- [ ] U4 表对齐 / 合并 / hover+\n' +
    '- [ ] U5 动效基线 + reduce-motion（slash/palette/ctx/delim）\n' +
    '- [ ] 多选不刷源码\n' +
    '- [ ] Callout 读态 inline 粗体\n' +
    '- [ ] 无页顶格式条、无「加行」业余按钮\n' +
    '- [ ] IME 中文组字不拆词（抽测）\n' +
    '- [ ] 未把 🔄 折叠/语言菜单/灯箱/成对删误勾为已交付\n\n' +
    '---\n\n' +
    '在空白处继续写点什么…\n';

  root.MdxShowcaseSample = {
    markdown: SAMPLE,
    version: '2026-08-03-review',
  };
})(typeof window !== 'undefined' ? window : this);
