# 11 — 系统架构（完整 Markdown 渲染/编辑系统）

> **定位**：Markdown 原生 + Notion 类块体验 + AI 增强插槽  
> **参照**：`references/notion-page.png`（Notion 可视化对齐）  
> **集成**：主软件通过稳定 API 适配，不必 fork demo 壳

---

## 1. 一句话

**磁盘是 Markdown，内存是 Doc(Block[])，界面是 block-per-row，AI 与媒体是可插拔端口。**

---

## 2. 包边界（可迁 desktop）

```
reference/chat-composer-component/
  js/markdown-editor/           ← 可整夹复制为 packages/markdown-editor
    index.js                    公共 API
    schema.js                   Doc v2 / migrate / validators
    model.js                    DocumentModel + History
    parse.js                    MD → Doc
    serialize.js                Doc → MD
    registry.js                 BlockType 注册表
    editor.js                   Controller（薄）
    blocks/                     块定义（parse/serialize/read/edit）
      paragraph.js
      heading.js
      list.js
      quote.js
      code.js
      table.js
      divider.js
      callout.js
      media.js                  image 等
    ui/
      slash-menu.js
      dnd.js
      selection-toolbar.js      选区浮动：粗斜链（无整页顶栏）
      context-menu.js           块/单元格右键
      table-chrome.js           表格 hover 加行加列、列宽
    util.js
  css/markdown-editor/
    index.css                   汇总入口
    tokens.css                  （可拆）
    blocks.css
    table.css
    menus.css
  docs/markdown-editor/         规格
  tests/markdown-editor/        往返 / schema
  markdown-editor.html          纯演示宿主（非产品 chrome）
```

主软件集成：只依赖 `js/markdown-editor/**` + `css/markdown-editor/**`。

---

## 3. 分层

```
┌──────────────────────────────────────────────────────────┐
│ Host App（Conex Desktop / Notebook / FilePreview）         │
│  持久化 · 路由 · AI 面板 · 上传 · 权限                     │
└────────────────────────┬─────────────────────────────────┘
                         │ mount / onChange / ports
                         ▼
┌──────────────────────────────────────────────────────────┐
│ EditorController (editor.js)                             │
│  焦点 · 输入路由 · Transaction · viewOnly · IME          │
└───┬──────────┬──────────┬──────────┬──────────┬──────────┘
    ▼          ▼          ▼          ▼          ▼
  Model     Registry   Parser    Serializer   UI Plugins
  History   Blocks[]   MD→Doc    Doc→MD       slash/dnd/
                                              table/ctx/sel
```

| 层 | 职责 | 禁止 |
|----|------|------|
| Host | 存盘、AI、上传 | 直接改 block DOM |
| Controller | 事件、事务、协调 | 具体 MD 语法细节 |
| Model | Doc 真相、undo | DOM |
| Registry+Blocks | 类型行为 | 全局单例状态污染 |
| Parser/Serializer | 往返 | UI |
| UI Plugins | 菜单/拖拽/表格 chrome | 绕过 Model 写 text |

---

## 4. 渲染模型（Notion 对齐）

### 4.1 从 Notion 观测到的体验基线

| 项 | Notion 观察 | 我们的目标 |
|----|-------------|------------|
| 页面 | 白底、内容区居中宽约 900px 级 | demo 纸张居中；嵌入宿主时 100% |
| 块 | 无持续整行描边/底色 | **禁止** is-active 全行 ring/fill |
| 交互 | 左侧把手 hover 出现 | 同左 gutter handle |
| 表格 | 结构化网格，非「加行」「加列」文字按钮 | **右边/下边 hover +** 指引 |
| 顶栏 | 文档级（分享/历史），非编辑格式条占满 | demo **无** 重置/源码/复制工具条刷屏 |
| 字体 | ~16px 阅读体感 | 宿主可 token；Notebook 内 14 体系可覆盖 |

### 4.2 block-per-row

```
未聚焦：readView（精致 HTML，可点）
聚焦：  editView（contenteditable / 专用控件）
切块：  只 reconcile 脏 blockId，禁止全文 innerHTML
```

### 4.3 编辑 chrome 纪律

**允许**（按需浮出，贴内容）：

- 选区浮动工具条（B/I/S/`/链接）  
- 块把手菜单（转换/删除/复制）  
- 表格右键面板（表头/单元格分套）  
- Slash `/` `、`  

**禁止**：

- 页顶永久格式工具栏（「整行都是笔」）  
- 激活行描边 + 底色  
- 表格下方「加行」「加列」纯文字按钮  

---

## 5. 模块职责

### 5.1 schema.js

- `VERSION = 2`  
- `createBlock` / `emptyDoc` / `migrate` / `validate`  
- `plainText(block)` / `blockFromPlain`  

### 5.2 registry.js

```js
registerBlockType({
  type: 'heading',
  toMarkdown(block, ctx),
  fromMatch(line, ctx),      // 行级 parse 钩子可选
  renderRead(block, ctx),
  renderEdit(block, ctx),
  slash: { title, aliases, section },
})
```

### 5.3 blocks/table.js + ui/table-chrome.js

- 数据：`cells[][]`（兼容 rows）  
- UI：  
  - 悬停表格右侧中部：`+` 加列  
  - 悬停表格底边中部：`+` 加行  
  - 右键表头：排序占位、对齐、删除列、在左/右插列  
  - 右键单元格：复制、清空、在上/下插行、删除行  
  - `contextmenu` 拦截默认菜单  

### 5.4 ui/selection-toolbar.js

选中非空文本时，在选区上方浮出；无选区立即销毁。  
**不**做固定顶栏。

### 5.5 AI 端口（Host）

```js
// 预留，本阶段只定接口
options.ai = {
  rewrite?(selectionText, intent): Promise<string>,
  continue?(prefix): Promise<string>,
}
```

编辑器只负责：取选区文本、替换 runs/text、不实现模型调用。

---

## 6. 多 Agent 执行 DAG（本轮）

```
        ┌─ W0 规格冻结（10/11/12 + CROSSCUTTING bump）─┐
        └────────────────────┬────────────────────────┘
                             ▼
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
   A-Schema/Model      B-Visual/CSS         C-Table UX
   schema+migrate      Notion 对齐           hover+/右键
   registry 骨架       demo 去顶栏            cells 模型
        │                    │                    │
        └──────────┬─────────┴──────────┬─────────┘
                   ▼                    ▼
            D-Inline/Selection    E-Blocks split
            marks + 浮动条         从 editor 抽 blocks/*
                   │                    │
                   └──────────┬─────────┘
                              ▼
                       F-Integration polish
                       测试往返 · API 文档 · demo
```

**并行安全**：

| Agent | 写路径 |
|-------|--------|
| A | `schema.js`, `model.js`, `registry.js`, 轻改 parse/serialize 迁移入口 |
| B | `css/markdown-editor/**`, `markdown-editor.html` |
| C | `blocks/table.js` 或 `ui/table-chrome.js`, `css` 表格段, editor 表格钩子 |
| D | `ui/selection-toolbar.js`, util marks, editor 选区 |
| E | `blocks/*.js` 拆分（可后置） |
| F | `tests/**`, `docs/12-integration-contract.md` |

---

## 7. 成功标准（本轮）

- [ ] Doc v2 schema + migrate 可测  
- [ ] 公共 API 稳定，demo 与 Notebook/FilePreview 共用  
- [ ] 无页顶业余工具条；编辑反馈无整行描边底色  
- [ ] 表格：hover + 加行/列；右键表头/单元格分面板  
- [ ] 选区浮动格式条（至少 B/I/` ）  
- [ ] 往返测试：基础 GFM + 表格 + callout  
- [ ] 主软件集成契约文档可照做  

---

## 8. 明确不做（本轮）

- 完整 Notion Database  
- Mermaid/LaTeX 渲染引擎（可占位 block type）  
- 实时协同  
- AI 后端实现  
- 合并单元格  
