# 10 — 实施计划（DAG · 多 Agent · DoD）

> **唯一执行入口**。分册 01–09 为规格真相；本册为排期与文件所有权。  
> **策略**：先修 U2/U3/U1/U4 主路径（Wave 1），再媒体/公式/包（Wave 2+）。

---

## 1. 波次总览

```
Wave 1  渲染模型 + 代码单表面 + 展示页 + 表合并P0 + marks 基线 + 动效基线
Wave 2  表增强(TSV/列宽/排序) + 媒体块 + TOC + 双链/标签
Wave 3  Mermaid/KaTeX + AI mock UI + 导入导出占位
Wave 4  packages/conex-mdx TS 抽取 + 主软件适配样例
```

---

## 2. Wave 1 — 详细

### W1-A 文本 focus-render（U3）— P0

| 项 | 内容 |
|----|------|
| 读 | 02 §4、04 §关键路径 |
| 改 | `editor.js` `enterEdit` / `commitActiveFromDom`；禁止文本块 `innerText = block.text` |
| 做 | 进入编辑时 `contenteditable` 填 **inlineHtml(runs/text)**；提交 **htmlToInlineMd**；列表保留 marker 结构 |
| DoD | 打开含 `**粗**` 的段，点击后仍显示粗体；编辑后 getMarkdown 含记号 |

### W1-B 代码块单表面（U2）— P0

| 项 | 内容 |
|----|------|
| 读 | 02 §5 |
| 改 | `editor.js` code 分支；`css` code；可选 `ui/code-highlight.js` 轻量高亮 |
| 做 | 读：`<pre><code class=lang>` + highlight；点：隐藏 pre，显示 **唯一** source（textarea 或 pre-wrap ce）；禁双可见；Esc/失焦回读 |
| DoD | 任何时刻只见高亮 **或** 源码其一 |

### W1-C 实时 marks 基线（U3 增强）— P0

| 项 | 内容 |
|----|------|
| 读 | 04 |
| 改 | `util.js` + editor input 管道；selection-toolbar 改 toggleMark |
| 做 | 输入闭合 `**` `*` `` ` `` `~~` 时折叠定界符并套 mark；IME 组字期跳过 |
| DoD | 键入 `**ab**` 后 ab 粗体且源为 `**ab**` |

### W1-D 表格合并 P0（U4）— P0

| 项 | 内容 |
|----|------|
| 读 | 03 §2/§9/§15 |
| 改 | `schema.js` merge/split/covered；`table-chrome` 框选+菜单；`serialize` expand 或 html；parse 尽力 |
| 做 | 框选 → 合并；拆分；插删行列前 split 跨缝；GFM export expand-repeat |
| DoD | showcase 可合并演示；往返 JSON 不丢 rowspan |

### W1-E Showcase 满页（U1）— P0

| 项 | 内容 |
|----|------|
| 读 | 06 |
| 改 | `markdown-editor.html` SAMPLE + 可选 TOC |
| 做 | 分章覆盖清单；mock media/ai 可后置但章节文案在 |
| DoD | 滚动一页可见「不是玩具」 |

### W1-F 动效基线（U5）— P1

| 项 | 内容 |
|----|------|
| 读 | 05 A01–A12 |
| 改 | `css/markdown-editor` motion tokens；slash/sel-bar/table + |
| DoD | reduce-motion 瞬切；无阴影呼吸 |

### W1-G 兼容与测试

- `tests/markdown-editor` 扩展：merge、inline roundtrip、code  
- 保持 `MarkdownEditor.mount` 签名  
- `index.html` script 顺序不变（可增 ui 文件）

---

## 3. 文件所有权（防冲突）

| Agent | 独占 |
|-------|------|
| W1-A/C | `editor.js` 文本路径（可串行：先 A 后 C） |
| W1-B | code 渲染路径 + `ui/code-highlight.js` |
| W1-D | `schema.js` table*、`table-chrome.js`、serialize 表 |
| W1-E | `markdown-editor.html` only |
| W1-F | `css/markdown-editor/**` motion（不删 B/D 类名） |

`editor.js` 冲突：W1-A 先合，再 B/C 补丁。

---

## 4. Wave 2+（摘要）

| Wave | 内容 | 规格 |
|------|------|------|
| 2 | image/video/audio/attachment + TOC + tag/wiki | 09 |
| 2 | 表 TSV/列宽/排序筛选 | 03 P1 |
| 3 | mermaid/math peer 加载 | 01/09 |
| 3 | AI mock slash/右键 | 08 |
| 4 | `packages/conex-mdx` TS | 07 |

---

## 5. 语言与包

- Wave 1 **仍在 vanilla JS** 填满行为，避免双栈。  
- Wave 4 按 07 迁 TS；目录镜像 `schema/ model/ blocks/ ui/ render/`。  
- 主软件集成：`12-integration-contract` + 07 最小清单。

---

## 6. 成功标准（整体 v3.0）

- [ ] U1 showcase 覆盖主清单章节  
- [ ] U2 代码单表面  
- [ ] U3 编辑非裸源 + 实时 ** * ` ~~  
- [ ] U4 合并/拆分可用  
- [ ] 动效基线 + reduce-motion  
- [ ] roundtrip 测试扩展通过  
- [ ] 无「加行」「页顶格式条」回潮  

---

## 7. 立即启动顺序

1. W1-A 文本 focus-render  
2. 并行 W1-B 代码、W1-D 表合并、W1-E showcase  
3. W1-C marks（依赖 A）  
4. W1-F 动效  
5. 测试收口  
