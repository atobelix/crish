# 功能清单对照：用户愿景 vs 实现诚实盘点

> **日期**：2026-08-03  
> **愿景**：Markdown 原生 + Notion 类体验 + AI 增强（非 Notion DB/CRM）  
> **原则**：Markdown 是底层 · Block 是体验 · AI 是增强层  
> **实现真源**：`reference/chat-composer-component/js/markdown-editor/*`  
> **状态标签**：✅ 可用 · ⚠ 半成品/体验差 · ❌ 未做 · 🚫 明确不做/后置 · 📜 仅政策壳 · 🔄 进行中

---

## 0. 总览（一页）

| 大模块 | 覆盖率（粗） | 一句话 |
|--------|-------------|--------|
| 一、基础 MD 内容块 | **~78% 有壳，体验 ~62%** | P0 读/软编跳变已收；**ux-D2 邻域灰定界符已合入**（成对删除仍弱） |
| 二、代码/图/公式 | **~62%** | 代码单表面 + **读态行号 ✅**；折叠/语言菜单 **CSS 钩子 🔄 · JS 未合入** |
| 三、媒体 | **~38%** | 图粘贴/拖放有；**灯箱 CSS 钩子 🔄 · 行为未接**；视频音频附件弱 |
| 四、表格 | **~55%** | 网格+合并；**GFM align parse ✅**；排序筛选列拖/Database ❌ |
| 五、文档结构 | **~30%** | TOC/锚点/wiki 按钮有；面包屑反链标签系统 ❌ |
| 六、编辑体验 | **~72%** | 软编辑默认 ✅；定界符邻域 ✅；**动效 CSS 基线 ✅**；字符级跨块仍 ❌ |
| 七、AI | **📜 薄端口** | 无 complete 则正确关闭；无内置模型 |
| 八、版本 | **❌** | 仅本地 undo 栈 |
| 九、导入导出 | **~20%** | MD 进出有；Word/PDF/Notion ❌ |
| 十、科研增强 | **❌/~5%** | 无 BibTeX/图表块/实验块 |
| 十一、协作 | **❌** | 后置 |

**用户截图对应的 P0 体验债（对照 2026-08-03 实现）：**

| # | 原问题 | 状态 | 证据 |
|---|--------|------|------|
| 1 | Callout **未聚焦**仍见 `**页面壳**` 裸源 | ✅ | `editor.js` `readContentHtml` callout：title/body 走 `inlineHtml`（默认 label 仍 `esc`） |
| 2 | **聚焦**变等宽整行 `> [!NOTE] **…**` | ✅ 主路径 | `enterEdit` → `renderSoftEditSurface`；`renderFullSourceSurface` 仅 `fullSourceEdit` |
| 3 | 多选把块刷成源码 dump | ✅ 默认 chrome-only | `selection/chrome.js`：仅 `forceSourceOnMulti` 才 `paintSourceSurface` |
| 4 | 选区高亮与拖选范围不一致 | ✅ 改善 | `selection/controller.js` `DRAG_THRESHOLD_PX = 6`；块级 multi 仍非字符级 |

---

## 0.1 已做但体验仍弱 / 下一步

| 主题 | 状态 | 说明 |
|------|------|------|
| 行内定界符邻域显源（ux-D2） | ✅ / ⚠ | `runsToEditHtml({caretMd})` + live-marks 刷新；**缺**成对 Backspace 拆格式、选区多 mark reveal |
| 定界符显隐动效 | ✅ CSS | `inline-marks.css`：`.mdx-src-delim` opacity ≤90ms + enter；`prefers-reduced-motion` 关闭 |
| 软路径 demote / split / 往返 | ⚠ | w5 pure/jsdom 加厚；editor 内跨块 split/caret 仍糙 |
| 字符级跨块 range（U1b） | ❌ | 仅块级 multi + 块内 range |
| 多选块底色 | ✅ CSS | `selection.css` + `motion.css`：`.is-block-selected` 短促 bg transition；**禁止** shadow 动画 |
| 代码行号 / 折叠 / 语言菜单 | ✅ / 🔄 | 读态 `.mdx-code-gutter` ✅；**折叠/语言菜单仅 CSS 钩子**（`.mdx-code-fold-btn` / `.mdx-code-lang-menu`），**JS 未合入** |
| 图灯箱 | 🔄 | `motion.css` 通用 `.mdx-lightbox` 皮肤；**image 块行为未接线** |
| Popover 入场动效 | ✅ CSS | slash / ctx / **cmd palette** enter（opacity + translateY）；无 box-shadow transition |
| 表列 align | ✅ | `parseAlignRow` → `block.align`；serialize 往返 OK；UI 菜单已有 |
| Showcase 审查页 | ✅ | `markdown-editor.html` + `demo/showcase-sample.js` 活文档 SAMPLE |
| `renderEditSurface` 半表面死路径 | ⚠ | soft 已默认委托同一实现；清理与命名债仍在 |
| editor.js 体量 / 包迁移 | ⚠ / ❌ | 逻辑仍偏上帝文件；`@conex/mdx` STUB |

---

## 0.2 本波（微动效 + showcase）诚实状态

| 项 | 状态 | 证据 / 备注 |
|----|------|-------------|
| Showcase 活文档 | ✅ | `js/markdown-editor/demo/showcase-sample.js` 由 `markdown-editor.html` 引用；`MdxShowcaseSample.markdown` |
| 逐步核对清单 | ✅ 文档 | [10-showcase-review-checklist.md](./10-showcase-review-checklist.md) |
| Slash enter | ✅ CSS | `.mdx-slash` + `mdx-popover-in`（`motion.css`） |
| Palette enter | ✅ CSS | `.mdx-cmd-portal.is-open .mdx-cmd-dialog` / backdrop |
| Ctx menu enter | ✅ CSS | `.mdx-ctx-menu.is-visible` + `mdx-popover-in` |
| 定界符 opacity | ✅ CSS | ≤90ms；reduce 关 |
| 多选 bg 短过渡 | ✅ CSS | ≤90ms；无 active-row border 动画（D16 仍守） |
| 代码折叠 JS | ❌ / 🔄 | **未合入**；仅 `.mdx-code-fold-btn` 样式钩子 |
| 语言菜单 JS | ❌ / 🔄 | **未合入**；仅 `.mdx-code-lang-menu` 样式钩子 |
| 成对删定界符 | ❌ / ⚠ | **未合入**逻辑；仍靠整段 refresh |
| 图片灯箱行为 | ❌ / 🔄 | **未合入**；仅 `.mdx-lightbox` 通用样式 |
| `box-shadow` transition | 🚫 | 政策禁止；CSS 已避免 |
| 激活行 border 动画 | 🚫 | D16；`.mdx-block` `transition: none` |

---

## 一、基础 Markdown 内容块

### 1.1 文本 / 行内

| 能力 | 状态 | 证据 | 体验 0–5 | 缺口 |
|------|------|------|----------|------|
| Paragraph | ✅ | schema + parse + text-read | 3–4 | 空段 placeholder 有；软编跳变已减 |
| Bold `**` | ✅/⚠ | util + live-marks + ux-D2 邻域灰 `**` | 4 | 成对删/闪烁边角仍 ⚠ |
| Italic | ✅/⚠ | 同上 | 4 | 同左 |
| Strike | ✅/⚠ | `~~` + keymap + 邻域 | 3–4 | 同左 |
| Underline `++` | ⚠ | util + keymap | 2 | 非 GFM 标准；文档弱 |
| Highlight `==` | ⚠ | util + keymap | 2 | 同左 |
| Inline code | ⚠ | util | 3 | 读态 OK |
| Link | ⚠ | util `[t](u)` | 3 | 无 Ctrl+K 专用链路面板 |
| Tag `#tag` | ❌ | — | 0 | 无标签系统 |

### 1.2 标题

| 能力 | 状态 | 体验 | 缺口 |
|------|------|------|------|
| H1–H6 | ✅/⚠ | 3–4 | 软编保持 h 字号 + 灰 `##`；非 monospaced full-src |
| TOC | ⚠ | 3 | `@[toc]` 块有；层级/刷新边角 |
| 标题锚点跳转 | ⚠ | 3 | withHeadingAnchor + TOC click |

### 1.3 列表

| 能力 | 状态 | 体验 | 缺口 |
|------|------|------|------|
| 无序 | ✅/⚠ | 3–4 | soft `·` / hard `*` 有；默认软路径 |
| 有序 | ✅/⚠ | 3 | 重编号边界弱 |
| 多级 indent | ⚠ | 2–3 | Tab 缩进有；嵌套视觉/合并弱 |
| Todo | ✅/⚠ | 3 | `- [ ]` parse/serialize 有 |

### 1.4 引用 / Callout

| 能力 | 状态 | 体验 | 缺口 |
|------|------|------|------|
| Blockquote | ⚠ | 3 | 读态 OK；软编灰 `>` |
| GitHub Alert / Callout | ✅/⚠ | **3–4** | 读态 title/body `inlineHtml`；软编 **保持卡片 + `[!KIND]` 灰标**，非 `> [!NOTE]` dump |

### 1.5 分割线

| 能力 | 状态 | 体验 | 缺口 |
|------|------|------|------|
| `---` | ✅ | 3 | 编辑态提示弱 |

---

## 二、代码相关

| 能力 | 状态 | 体验 | 缺口 |
|------|------|------|------|
| 多语言 fence | ⚠ | 3 | 轻量 highlight，非 Prism 全集 |
| 语法高亮 | ⚠ | 3 | code-highlight.js 规则集有限 |
| 复制按钮 | ✅ | 4 | code-chrome |
| 行号 | ✅ | 4 | 读态 `.mdx-code-gutter`；源码态无 |
| 行高亮 | ❌ | 0 | — |
| 折叠 | 🔄 | 1 | **CSS** `.mdx-code-fold-btn`；**无 JS** |
| 语言菜单 | 🔄 | 1 | **CSS** `.mdx-code-lang-menu`；读态 lang pill 有、**无下拉** |
| Mermaid 多图类型 | ⚠ | 3 | peer CDN；错误 UI 弱 |
| 行内/块公式 | ⚠ | 3 | KaTeX peer；$ 货币策略有 |
| Diff fence | ⚠ | 2 | highlightDiff 有着色；无并排 diff UI |

---

## 三、媒体

| 能力 | 状态 | 体验 | 缺口 |
|------|------|------|------|
| 图拖拽/粘贴 | ⚠ | 3 | drop-paste + upload 端口/blob |
| 自动上传 | 📜 | — | 宿主 uploadImage |
| 压缩/标注/画框 | ❌ | 0 | — |
| 题注/描述 | ⚠ | 2 | schema 字段有；UI 弱 |
| 灯箱放大 | 🔄 | 1 | **CSS** `.mdx-lightbox`；**点击放大未接线** |
| 视频/音频 | ❌ | 0 | — |
| 文件附件 | ⚠ | 2 | file_chip 弱 |

---

## 四、表格

| 能力 | 状态 | 体验 | 缺口 |
|------|------|------|------|
| GFM 表 | ✅/⚠ | 3–4 | parse/serialize + align |
| 网格编辑 | ⚠ | 3 | 非整表 pipe 源码 |
| 合并单元格 | ⚠ | 2–3 | merge 有；GFM 导出诚实性 |
| 列对齐 align | ✅ | 4 | `parseAlignRow` + serialize + chrome 菜单 |
| 拖列/排序/筛选 | ❌ | 0 | — |
| 单元格格式 | ❌ | 0 | — |
| Notion Database | 🚫 | — | **明确不做**（污染定位） |

---

## 五、文档结构

| 能力 | 状态 | 体验 | 缺口 |
|------|------|------|------|
| TOC | ⚠ | 3 | 见上 |
| 面包屑 | ❌ | 0 | — |
| 双链 `[[doc:]]` | ⚠ | 2 | 按钮片段；无图谱 |
| 标签 `#` | ❌ | 0 | — |
| Backlinks | ❌ | 0 | — |

---

## 六、编辑体验（原最大用户痛点；P0 已收口主路径）

| 能力 | 状态 | 体验 | 缺口 |
|------|------|------|------|
| Slash `/` `、` | ⚠ | 3–4 | 有；**enter 动效 CSS ✅**；焦点/关闭边角 ⚠ |
| 快捷键 B/I/… | ⚠ | 3 | 软表面路径需与定界符策略统一 |
| 拖拽 Block | ⚠ | 3 | handle DnD |
| Command Palette | ⚠ | 3–4 | Ctrl+P；**dialog enter CSS ✅** |
| **失焦=精致渲染** | ✅/⚠ | **3–4** | callout/文本走 `inlineHtml`；边角类型仍有债 |
| **聚焦=接近预览+可见语法** | ✅/⚠ | **3–4** | **默认 soft surface**；full-src 仅调试开关；定界符邻域 ✅ |
| **多选高亮** | ✅/⚠ | **3–4** | **默认 chrome-only**；bg 短过渡 ✅；字符级跨块仍 ❌ |
| 拖选阈值 | ✅ 改善 | 3 | 6px 阈值；命中块序仍可调 |
| 粘贴 MD/HTML | ⚠ | 3 | U3 paste 有；需回归 |
| Undo 粒度 | ⚠ | 3 | mergeKey 有 |
| demote / promote 阶梯 | ✅/⚠ | 3–4 | 纯函数 + w5 harness；soft DOM 往返 ⚠ |
| 动效基线（W9） | ✅ CSS | 3–4 | `motion.css` + `edit/motion.js`；reduce 关 |

---

## 七、AI

| 能力 | 状态 | 说明 |
|------|------|------|
| 扩写/缩写/改写/翻译/润色 | 📜 | `ai/actions.js` 动作表；需宿主 `complete` |
| 总结 / Continue | 📜 | 同上 |
| 文档问答 / Review | ❌/📜 | 无专用动作或未产品化 |
| Mock AI | 🚫 | **禁止**（AI-HOST-POLICY） |

---

## 八～十一（后置为主）

| 模块 | 状态 |
|------|------|
| 历史版本 / Diff / 回滚 | ❌（仅内存 undo） |
| 导入 Word/PDF/Notion | ❌ |
| 导出 PDF/Word/LaTeX | ❌（MD 序列化有） |
| BibTeX / Chart / Dataset / 实验块 | ❌ |
| 评论 / @ / 实时协作 / 权限 | ❌ 后置 |
| `@conex/mdx` 包 | STUB mount throw |

---

## 菜单对照（用户「核心菜单」）

```
基础     文本/标题/列表/引用/分割线     → 有壳 · 软编体验改善
媒体     图 ⚠ · 灯箱 CSS 🔄 · 视频❌ · 音频❌ · 文件⚠
高级     代码✅/⚠(行号有·折叠/语言菜单 CSS 🔄 JS❌) · Mermaid⚠ · 公式⚠ · 表✅/⚠ · 图表❌
结构     目录⚠ · 标签❌ · 双链⚠ · Callout ✅/⚠
AI       端口壳 📜 · 无宿主则不可用（正确）
工具     导入❌ · 导出MD⚠ · 历史❌
```

---

## P0 改进序列（可用日常编辑器）— 进度

| # | 项 | 状态 |
|---|-----|------|
| 1 | 读态 callout/所有文本一律 `inlineHtml` | ✅ |
| 2 | 废弃文本块 monospaced full-source 为主路径 → 软编辑 | ✅ 默认 soft；full 仅 `fullSourceEdit` |
| 3 | 多选只加 chrome，不改写 innerHTML 为源码 | ✅ 默认；`forceSourceOnMulti` 调试 |
| 4 | 拖选阈值 + 命中块序 | ✅ 阈值；命中仍可调 |
| 5 | Callout 编辑保持 callout 壳 | ✅ soft `mdx-callout` + kind 灰标 |
| 6 | 代码失焦高亮 / 聚焦 fence 单表面 | ✅ 保持，勿回退 |
| 7 | 粘贴/undo 回归 | ⚠ 持续 |
| 8a | 行内定界符邻域（ux-D2） | ✅ 主路径；成对删 🔄/❌；delim 动效 CSS ✅ |
| 8b | 代码读态行号 | ✅ gutter；折叠/语言菜单 🔄 仅 CSS |
| 8c | 表 GFM align parse | ✅ `parseAlignRow` 往返 |
| 8d | 动效 / popover enter / 多选 bg | ✅ CSS 基线（本波） |
| 8e | Showcase 审查 SAMPLE + 清单 | ✅ `showcase-sample.js` + `10-…` |
| 9 | 再开功能面（折叠 JS、语言菜单 JS、灯箱行为、视频、导出…） | 后置 / 🔄 钩子已备 |

**明确本阶段不做**：Notion Database、CRM、日历、SaaS 插件、协作、完整科研套件。

---

## 下一刀（与 README 对齐）

1. 定界符 **成对 Backspace** + 减闪（逻辑，非仅 CSS）  
2. 代码 **折叠 / 语言菜单 JS** 接到已有 CSS 钩子  
3. 图片 **灯箱行为** 接到 `.mdx-lightbox`  
4. 字符级跨块 range（U1b）  
5. soft demote/split 编辑器集成边角  
6. `@conex/mdx` 真迁移（U6）
