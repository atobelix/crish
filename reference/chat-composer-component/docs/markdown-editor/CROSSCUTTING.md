# 交叉决策冻结（Cross-cutting）

> **状态**：2026-08-02 设计轮整合 · **v2 架构冲刺**  
> **用途**：消解并行文档中的命名/模型冲突；实现 agent **以此为准**，冲突时改专题文而非各写各的。  
> **新增必读**：[10-data-format](./10-data-format.md) · [11-system-architecture](./11-system-architecture.md) · [12-integration-contract](./12-integration-contract.md)

---

## 1. 文档库规模

约 **8.2k 行** 设计规格（`docs/markdown-editor/**`），覆盖愿景 → 架构 → 块 → 渲染 → DnD → Slash → 扩展 → 视觉 → 集成 → 路线图。

---

## 2. 冻结决策（实现前不可再争论）

| ID | 议题 | 冻结值 | 来源 |
|----|------|--------|------|
| D1 | 文档模型 | **扁平 `Block[]` + `indent`**，非真树 `children[]` | 01-architecture §3 |
| D2 | 渲染单元 | **~~block-per-row 换壳作终局~~ → 否决**。过渡期遗留 IIFE 仍可能按块调度；**融合实时编辑终局见 ux-D10 / [11-SYSTEMIC-REFACTOR-PLAN](./ux-readiness/11-SYSTEMIC-REFACTOR-PLAN.md)**；硬禁见 [BANNED-VISUAL-UX](./BANNED-VISUAL-UX.md) | 03 历史 · 11 新 |
| D3 | 预览/源码硬切换 | **不做** 默认 UI | 00 + CONVERSATION_FLOW_SPEC |
| D4 | 序列化主格式 | Markdown（GFM + Conex 扩展可往返） | 01, 06 |
| D5 | 命令触发 | **`/` 与 `、`** 同一面板；行首/仅空白后 | 05 |
| D6 | DnD 引擎 | **Pointer 自定义**（非 HTML5 DnD 主路径）；仅把手启动 | 04 |
| D7 | DnD 嵌套 v1 | **同级重排**；indent 用 Tab/Shift-Tab，不 drop-into | 04 |
| D8 | CSS 前缀 | **`mdx-`**（markdown-editor）。废弃 `cx-md-*` 若 01 中出现 | 02/04/07；**本表覆盖 01** |
| D9 | 字号 | 正文 14；Notebook 内 h1 最多 +1（15）；流外三档仍适用 | 07 |
| D10 | 表格 v1→v2 | 可建含表头、改单元格、Tab；**hover 右/下 + 加列/行**；右键表头/单元格分面板；**禁止**「加行」「加列」文字按钮；无合并单元格 | 02, 05, 11 |
| D16 | 编辑 chrome | **禁止**页顶永久格式栏；选区浮动条 + 块把手 + slash；**禁止**激活行全行描边/底色 | 11, Notion 对照 |
| D17 | Doc version | **v2**（schema.js）；v1 自动 migrate | 10 |
| D18 | 集成面 | 主软件只依赖 mount API + mdx CSS；demo HTML 非产品依赖 | 12 |
| D11 | 引擎基座 v1 | **Vanilla JS** 块模型；TipTap/Lexical 仅迁移后备 | 01 §12 |
| D12 | 宿主首发 | `NotebookPanel` body；chip 打开逻辑保留 | 08 |
| D13 | 扩展降级 | `mode: conex \| pure-gfm` 导出 | 06 |
| D14 | 文件芯片 | `[[file:path]]` → `onOpenPath`；代码不进 Notebook | 06 file-chip |
| D15 | 文档链接 | `[[doc:title]]` 对齐对话流 wiki 引用 | 06 wiki-link |

---

## 3. 核心数据形状（摘要）

```ts
type BlockId = string;

type Block = {
  id: BlockId;
  type: string;       // paragraph | heading | ...
  indent: number;     // 0..n，列表层级
  props: Record<string, unknown>;
  // 文本块：
  runs?: TextRun[];   // 或 content: string + marks
};

type Doc = {
  version: 1;
  blocks: Block[];
  meta?: { title?: string; conexMd?: 1 };
};

type Transaction = {
  steps: Step[];      // insert | delete | update | move | replace
  selection?: Selection;
  meta?: { addToHistory?: boolean; mergeKey?: string };
};
```

完整定义见 `01-architecture.md`。

---

## 4. 分层（实现挂载顺序）

```
NotebookPanel (shell: pin/drag/esc)
  └── MarkdownEditor.mount(host, { get/setMarkdown, onChange, onOpenPath })
        ├── DocumentModel + History
        ├── BlockRegistry
        ├── LineRenderer (reconcile by blockId)
        ├── SlashPalette (/  and 、)
        ├── DnDController (handle only)
        └── Extensions (parse/serialize hooks)
```

---

## 5. 实现分期（摘自 09，不可跳 DoD）

| 阶段 | Demo | 依赖 |
|------|------|------|
| **M0** | 空编辑器挂 Notebook | — |
| **M1** | 段/标题/列表 行级读写 + autosave | M0 |
| **M2** | `/` + `、` slash | M1 |
| **M3** | 把手 DnD 重排 | M1 |
| **M4** | 表/代码/callout 精致 | M1；可与 M3 部分并行 |
| **M5** | file-chip / wiki-link | M1 + 链接皮肤 |
| **M6** | 虚拟化 + desktop 包边界 | API 稳定 |

多 agent 文件所有权见 `09-implementation-roadmap.md` §4（A-Engine / B-Blocks / C-UI / D-Host / E-Test）。

---

## 6. 已知文档小冲突与处理

| 冲突 | 处理 |
|------|------|
| 01 若写 `cx-md-*`，02/04/07 写 `mdx-` | **一律 `mdx-`**（D8） |
| list 真树 vs flat indent | **flat + indent**（D1） |
| 是否 v1 支持 drop 进容器 | **否**（D7） |
| 拼音过滤 slash | P2，不挡 M2 |

实现 agent 发现新冲突：先改本文件 + 相关专题，再写代码。

---

## 7. 与对话流 UI 本轮小修（已落地）

工具调用摘要行：

- 文案与 chevron **左簇**排列（不再 primary 拉满、roller 靠右）
- Purpose / Action **轻微 padding-left 缩进**
- 修改：`css/flow/purpose.css`、`action.css`、`PurposeBlock.js`

Markdown 编辑器 **已落地**（reference）：

- `js/markdown-editor/*` + `css/markdown-editor/index.css`
- `NotebookPanel` body 挂载块编辑器
- 能力：块级读写、`/`/`、` slash、DnD 把手、表/代码/callout/file-chip、autosave
- 测试：`tests/markdown-editor/roundtrip.test.js`

---

## 8. 给下一轮实现 agent 的最短路径

1. 读 `AGENT_BRIEFING.md` + **本文件**  
2. 读 `09-implementation-roadmap.md` M0–M1  
3. 实现时对照 `01` 事务 API + `03` reconcile + `02` paragraph/heading  
4. **禁止** 热路径全文 `innerHTML = MarkdownLite.render(all)`  
5. 中文 IME：`compositionstart/end` 期间 `addToHistory: false`

---

## 9. 修订

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-08-02 | 8 agent 设计轮整合；冻结 D1–D15 |
