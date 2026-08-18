# 06 — 实现路线图与多 Agent 分工

> **本文件是执行入口**。方案确认后按 Phase 起 agent。  
> 每个 agent 提示词以 `AGENT_BRIEFING.md` + 本 Phase 块为准。

---

## 1. 总依赖图（DAG）

```
                    ┌──────── P0 壳与路由 ────────┐
                    │  tokens / Shell / Router     │
                    │  EmptyViewer / Toolbar 骨架   │
                    │  legacy openPreview 桥        │
                    └─────────────┬───────────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          ▼                       ▼                       ▼
   ┌── P1 Markdown ──┐   ┌── P5 Image 迁入 ──┐   ┌── P2 PDF ──┐
   │ viewOnly 编辑器  │   │ ImageViewer      │   │ pdf.js     │
   │ MarkdownViewer  │   │ 裁剪画笔保留      │   │ PdfViewer  │
   └────────┬────────┘   └────────┬──────────┘   └─────┬─────┘
            │                     │                    │
            │            ┌────────┴────────┐           │
            │            ▼                 ▼           │
            │     ┌── P3 表格 ──┐   ┌── P4 DOCX ──┐    │
            │     │ CSV+XLSX    │   │ mammoth     │    │
            │     └──────┬─────┘   └──────┬─────┘    │
            │            │                │          │
            └────────────┴────────┬───────┴──────────┘
                                  ▼
                    ┌──────── P6 收口 ────────┐
                    │ TextViewer / fixtures   │
                    │ 动效打磨 / a11y / 文档  │
                    │ 删除假 PDF / DoD 清单   │
                    └────────────────────────┘
```

**可并行**：P0 完成后，P1 / P2 / P5 并行；P3 / P4 可再并行。  
**P6** 依赖主要 Viewer 合入。

---

## 2. Phase 明细

### P0 — 壳层组件化 + 路由骨架

| 项 | 内容 |
|----|------|
| **Agent** | `fp-p0-shell` |
| **读** | CROSSCUTTING, 02, 04, AGENT_BRIEFING |
| **写** | `js/file-preview/shell/*`, `router/*`, `model/*`, `toolbar/*`, `viewers/EmptyViewer.js`, `css/file-preview/tokens.css`, `shell.css`, `motion.css`, `index.js`, `legacy-bridge.js` |
| **改** | `index.html` 挂载点与 script 顺序 |
| **DoD** | `FilePreview.open` 能打开 loading→unsupported；Esc/遮罩关闭；入场退场动效；旧 `openPreview(card)` 不报错 |
| **不做** | 真 PDF/DOCX 解析 |

---

### P1 — Markdown 查看态

| 项 | 内容 |
|----|------|
| **Agent** | `fp-p1-markdown` |
| **依赖** | P0 |
| **读** | 05, markdown-editor CROSSCUTTING + 08-integration |
| **写** | `markdown-editor` 的 `viewOnly`；`adapters/markdown.js`；`viewers/MarkdownViewer.js`；`css/.../markdown.css` |
| **DoD** | `.md` 附件/fixture 真渲染；不可输入；无只读文案；复制可用 |
| **并行** | 可与 P2、P5 同时 |

---

### P2 — PDF 真解析

| 项 | 内容 |
|----|------|
| **Agent** | `fp-p2-pdf` |
| **依赖** | P0 |
| **写** | `adapters/pdf.js`（动态 load pdf.js）；`viewers/PdfViewer.js`；缩略图侧栏；`css/.../pdf.css` |
| **DoD** | 真 PDF 翻页缩放；失败诚实；**删除**假 `renderRealPdfFile` 内容路径 |
| **注意** | worker 路径、按需加载 |

---

### P3 — 表格 CSV + XLSX

| 项 | 内容 |
|----|------|
| **Agent** | `fp-p3-table` |
| **依赖** | P0 |
| **写** | `adapters/spreadsheet.js`；`viewers/TableViewer.js`；CSV 单测；xlsx 按需 |
| **DoD** | 真 CSV；xlsx 至少第一张表；大表截断提示 |

---

### P4 — Word DOCX

| 项 | 内容 |
|----|------|
| **Agent** | `fp-p4-docx` |
| **依赖** | P0 |
| **写** | `adapters/docx.js`（mammoth + 消毒）；`viewers/DocxViewer.js`；`docx.css` |
| **DoD** | 真 docx 可读；脚本剥离；.doc 降级 unsupported |

---

### P5 — 图片工作台迁入

| 项 | 内容 |
|----|------|
| **Agent** | `fp-p5-image` |
| **依赖** | P0 |
| **写** | 从 `preview-modal.js` 迁 zoom/rotate/crop/brush → `ImageViewer` |
| **DoD** | 能力不回退；objectURL 不泄漏；底栏 slot 正确 |

---

### P6 — 文本/代码 + 收口

| 项 | 内容 |
|----|------|
| **Agent** | `fp-p6-polish` 或 orchestrator |
| **依赖** | P1–P5 主路径 |
| **写** | `TextViewer`；fixtures；清掉 preview-modal 死代码；a11y；README 实现状态勾选 |
| **DoD** | 全格式冒烟；无假解析；动效与 reduce-motion；中文无乱码 |

---

## 3. 推荐并行波次

| 波次 | Agents | 说明 |
|------|--------|------|
| **Wave 0** | 仅文档（本目录） | ✅ 已完成 |
| **Wave 1** | P0 单 agent | 骨架必须先合 |
| **Wave 2** | P1 + P2 + P5 三并行 | 注意改 `index.html` 时串行 merge |
| **Wave 3** | P3 + P4 双并行 | 依赖库隔离 |
| **Wave 4** | P6 收口 | 冲突消解 + DoD |

`index.html` / `tokens` 冲突：Wave 2 起约定 **P0 owner 为壳唯一修改者**，其它 agent 只加 script 块通过 PR 式说明交给 P6 或 orchestrator 合并。

---

## 4. 多 Agent 提示词模板

```
你是 fp-p{N}-{name}。
1. 阅读 docs/file-preview/AGENT_BRIEFING.md 与 CROSSCUTTING.md
2. 阅读 docs/file-preview/06 中 P{N} 段落及列出的专题文档
3. 只修改该 Phase 允许的路径
4. 完成后列出：改动文件、如何手工验证、已知限制
5. 中文 UI/注释安全写入；禁止假解析
```

---

## 5. 风险与缓解

| 风险 | 缓解 |
|------|------|
| pdf.js 体积 | 动态 import；失败降级 |
| mammoth 样式丑 | 专用文章 CSS，不追求 100% Word 还原 |
| xlsx 内存 | 行数上限 + 截断提示 |
| viewOnly 漏编辑 | 单测 + 手工狂按键盘 |
| 多 agent 改同一 CSS | tokens 只 P0/P6 动 |
| Windows 文字发虚 | 不用父级 opacity 叠正文 |

---

## 6. 成功标准（整体）

- [ ] PDF / MD / DOCX / CSV / XLSX / 图片 / 文本 均有真路径或诚实失败  
- [ ] Markdown 复用块编辑器查看态，无解释性模式文案  
- [ ] 组件树清晰，旧单体可删  
- [ ] 动效高级克制  
- [ ] 附件四卡 + 上传 live 文件冒烟通过  

---

## 7. 下一步（等人确认）

方案（Wave 0）已落在本目录。确认后执行：

1. 启动 **P0** agent  
2. P0 合入后并行 **P1 / P2 / P5**  
3. 再 **P3 / P4**  
4. **P6** 收口  

无需改方案即可开工；若要砍范围，优先保 **P0 + P1 + P2 + P3(CSV)**，DOCX/XLSX 可列为 P1.5。
