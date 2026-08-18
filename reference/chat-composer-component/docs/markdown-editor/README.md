# Conex Markdown 块编辑器（设计文档总览）

> **位置**：`reference/chat-composer-component/docs/markdown-editor/`  
> **性质**：设计与实现规格库（当前约 **8.2k 行**），**不是**临时笔记。  
> **消费者**：后续多 agent 实现 / 评审 / 迁 desktop 时的唯一真相源。  
> **整合入口**：**先读 [CROSSCUTTING.md](./CROSSCUTTING.md)**（冻结决策 D1–D18），再读专题。  
> **数据/架构 v2**：[10-data-format](./10-data-format.md) · [11-system-architecture](./11-system-architecture.md) · [12-integration-contract](./12-integration-contract.md)  
> **演示页**：`../../markdown-editor.html`（干净文档壳，非产品 chrome）  
> **关联**：对话流 Notebook（`NotebookPanel`）是首个宿主；File Preview 为 viewOnly 宿主。

---

## 0. 产品一句话

做一个 **Notion 气质、Markdown 兼容、块级可拖拽** 的精致阅读/编辑体验：

- 默认 **阅读态渲染**（精致组件）
- 编辑是 **整行/整块** 粒度（解决 blur 才预览的失败）
- 行/块可 **上下拖拽重排**
- 行首 **`/` 或 `、`** 打开命令面板
- **GFM + Conex 扩展**（callout、file-chip、wiki-link…）

当前 `markdown-lite.js` + 整文档 re-render **将被替换**（见路线图 M0+）。

---

## 1. 文档地图

| 文件 | 主题 | 状态 | 约行数 |
|------|------|------|--------|
| [CROSSCUTTING.md](./CROSSCUTTING.md) | **交叉决策冻结（必读）** | ✅ 1.0 | ~150 |
| [AGENT_BRIEFING.md](./AGENT_BRIEFING.md) | 子 agent 全局须知 | ✅ | ~75 |
| [README.md](./README.md) | 本总览 | ✅ | — |
| [00-product-vision.md](./00-product-vision.md) | 目标/非目标/竞品/术语 | ✅ | ~385 |
| [01-architecture.md](./01-architecture.md) | 模型/事务/解析/性能 | ✅ | ~1070 |
| [02-block-catalog.md](./02-block-catalog.md) | 块类型总表 | ✅ | ~335 |
| [03-line-renderer.md](./03-line-renderer.md) | 整行渲染与实时预览 | ✅ | ~1030 |
| [04-dnd-reorder.md](./04-dnd-reorder.md) | Notion 式拖拽 | ✅ | ~695 |
| [05-slash-commands.md](./05-slash-commands.md) | `/` 与 `、` 面板 | ✅ | ~560 |
| [06-extensions.md](./06-extensions.md) | 扩展体系 | ✅ | ~545 |
| [07-visual-system.md](./07-visual-system.md) | 排版与皮肤 | ✅ | ~310 |
| [08-integration.md](./08-integration.md) | Notebook/宿主接入 | ✅ | ~375 |
| [09-implementation-roadmap.md](./09-implementation-roadmap.md) | M0–M6 与文件所有权 | ✅ | ~310 |
| [10-data-format.md](./10-data-format.md) | **Doc v2 / Block / 集成序列化** | ✅ 冻结 | — |
| [11-system-architecture.md](./11-system-architecture.md) | **系统分层 + Notion 对齐 + 多 agent DAG** | ✅ | — |
| [12-integration-contract.md](./12-integration-contract.md) | **主软件接入契约** | ✅ | — |
| [references/](./references/) | Notion 截图与对齐笔记 | ✅ | — |
| [blocks/](./blocks/) | 单块深度规格 | ✅ P0 核心 | — |
| [extensions/](./extensions/) | 单扩展深度规格 | ✅ | — |
| [ux/](./ux/) | slash 微文案、键盘图 | ✅ | — |

### blocks/

| 文件 | 类型 |
|------|------|
| paragraph, heading, list, task, table, code, callout, divider | P0/P1 深度 |

### extensions/

| 文件 | 内容 |
|------|------|
| gfm-baseline | GFM 保证子集 |
| conex-callout | `> [!TIP]` + `:::` 兼容 |
| conex-file-chip | `[[file:]]` → 右侧面板 |
| conex-wiki-link | `[[doc:]]` |
| conex-embed | P2 嵌入卡片 |

---

## 2. 设计原则（硬约束）

1. **优雅优先**：阅读态达到 Composer / Notion 级精致。  
2. **块优先，Markdown 为序列化**。  
3. **整行/块渲染**：禁止热路径全文 `innerHTML = render(all)`。  
4. **左簇控件**：把手与 chevron 不靠右拉扯（与对话流工具行一致）。  
5. **注册表扩展**：新块 = schema + render + serialize + slash。  
6. **IME 一等公民**（中文输入法）。  
7. **安全消毒**链接与 HTML。  
8. 对话流禁令：无侧边轨、无 hover 阴影洗版。

---

## 3. 实现代码规划路径（尚未落地）

```
reference/chat-composer-component/
  js/markdown-editor/     # 见 09
  css/markdown-editor/    # 见 07
  docs/markdown-editor/   # 本目录
  tests/markdown-editor/
```

---

## 4. 实现状态（reference）

| 阶段 | 状态 |
|------|------|
| M0 scaffold | ✅ |
| M1 行级读写 + autosave | ✅ |
| M2 `/` + `、` slash | ✅ |
| M3 DnD + Alt+↑↓ | ✅ |
| M4 表/代码/callout | ✅ |
| M5 file-chip / wiki-link | ✅ |
| M6 虚拟化 / desktop 包 | ⏳ 未做（万行虚拟化按需） |

代码：`js/markdown-editor/` · 皮肤：`css/markdown-editor/` · 测试：`tests/markdown-editor/roundtrip.test.js`

---

## 5. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| 0.1 | 2026-08-02 | 建档 |
| 0.2 | 2026-08-02 | 8 agent 并行设计完成；CROSSCUTTING 冻结；索引更新 |
