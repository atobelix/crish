# 10 — 数据格式契约（Doc / Block / Markdown）

> **状态**：冻结 v2（2026-08-02）  
> **用途**：主软件集成时的唯一序列化真相源；实现 agent 与宿主适配器都读本文。  
> **原则**：Markdown 是磁盘/交换格式；Block 是运行时编辑模型；AI 是增强层，不污染 Doc 核心。

---

## 1. 设计原则

| 原则 | 说明 |
|------|------|
| **MD 为底层** | 默认往返 GFM；Conex 扩展可 `mode: pure-gfm` 降级 |
| **Block 为体验** | 编辑、拖拽、表格 UI 都操作 Block，不操作原始 MD 字符串 |
| **宿主无感** | 宿主只需 `markdown: string` 进出；可选消费 JSON Doc 以加速 |
| **版本可演进** | `doc.version` 递增；旧文档由 `migrate(doc)` 升级 |
| **不复制 Notion DB** | 不做看板/CRM；表格是文档表格，不是 Database |

---

## 2. 交换格式

### 2.1 主格式：Markdown 文本

```ts
// 宿主默认
type MarkdownDocument = string; // UTF-8
```

- 编码：UTF-8 无 BOM  
- 换行：LF 优先；读入时归一化 `\r\n` → `\n`  
- 扩展语法见 §5  

### 2.2 运行时：JSON Doc（可选持久化）

宿主若要「无缝集成」且避免反复 parse，可存：

```json
{
  "version": 2,
  "meta": {
    "title": "可选标题",
    "createdAt": "ISO-8601",
    "updatedAt": "ISO-8601",
    "locale": "zh-CN"
  },
  "blocks": [ /* Block[] */ ]
}
```

文件建议扩展名：`.conex.md.json` 或与 MD 并列的 sidecar。  
**默认产品路径仍是 `.md` 单文件。**

---

## 3. Doc Schema v2

```ts
/** 文档根 */
interface Doc {
  version: 2;
  blocks: Block[];
  meta?: DocMeta;
}

interface DocMeta {
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  locale?: string;
  /** 导出时是否剥离 Conex 扩展 */
  pureGfm?: boolean;
  /** 扩展槽：宿主自定义，编辑器不解释 */
  host?: Record<string, unknown>;
}
```

### 3.1 Block 统一形状

```ts
type BlockId = string; // 稳定 id，格式 b_ + base36

type BlockType =
  | 'paragraph'
  | 'heading'
  | 'bullet_item'
  | 'ordered_item'
  | 'task_item'
  | 'quote'
  | 'code'
  | 'table'
  | 'divider'
  | 'callout'
  | 'file_chip'
  | 'image'       // v2+
  | 'math'        // v2.1 预留
  | 'mermaid'     // v2.1 预留
  | 'embed';      // 预留

interface Block {
  id: BlockId;
  type: BlockType;
  /** 列表嵌套层级，0 起；非列表恒 0 */
  indent: number;
  /**
   * 纯文本兜底（无 marks 时）或与 runs 同步的 plain 缓存。
   * 序列化优先 runs；无 runs 用 text。
   */
  text?: string;
  /** 富文本 runs（v2）；无则等价 [{ text }] */
  runs?: TextRun[];
  /** 类型专有字段，扁平放在 block 上（便于 vanilla 访问） */
  level?: 1 | 2 | 3 | 4 | 5 | 6;   // heading
  checked?: boolean;                 // task_item
  lang?: string;                     // code
  rows?: string[][];                 // table 简化；见 TableBlock
  cells?: TableCell[][];             // table 增强（优先于 rows）
  hasHeader?: boolean;               // table 默认 true
  align?: Array<'left' | 'center' | 'right' | null>; // 列对齐
  callout?: 'note' | 'tip' | 'important' | 'warning' | 'caution';
  path?: string;                     // file_chip / image src
  alt?: string;                      // image
  caption?: string;                  // image / table
  meta?: Record<string, unknown>;    // 块级扩展槽
}
```

### 3.2 富文本 TextRun

```ts
interface TextRun {
  text: string;
  marks?: TextMark[];
}

type TextMark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'strike' }
  | { type: 'underline' }
  | { type: 'code' }
  | { type: 'highlight'; color?: string }
  | { type: 'link'; href: string }
  | { type: 'wiki'; title: string }   // [[title]]
  | { type: 'file'; path: string }    // [[file:path]]
  | { type: 'tag'; name: string };   // #tag
```

**序列化规则（摘要）**：

| Mark | Markdown |
|------|----------|
| bold | `**t**` |
| italic | `*t*` 或 `_t_`（导出统一 `*`） |
| strike | `~~t~~` |
| underline | `<u>t</u>` 或 Conex `++t++`（pure-gfm 降级为 plain） |
| code | `` `t` `` |
| highlight | `==t==`（pure-gfm 降级 plain） |
| link | `[t](url)` |
| wiki | `[[title]]` |
| file | `[[file:path]]` |
| tag | `#tag`（词边界） |

### 3.3 表格增强

```ts
interface TableCell {
  /** 单元格纯文本（v2 简化；后续可 runs） */
  text: string;
  /** 表头行 / 列头标记（可选） */
  header?: boolean;
  align?: 'left' | 'center' | 'right';
  /** 预留：合并（v3，当前禁止序列化非 1x1） */
  // rowspan?: number;
  // colspan?: number;
}

/** 兼容：若仅有 rows: string[][]，加载时迁移为 cells */
```

迁移：

```
rows[r][c]  →  cells[r][c] = { text: rows[r][c] }
```

---

## 4. 公共 API（集成面）

```ts
// window.MarkdownEditor / package export
interface MarkdownEditorAPI {
  getMarkdown(): string;
  setMarkdown(md: string): void;
  getDoc(): Doc;                 // 深拷贝
  setDoc(doc: Doc): void;
  flush(): void;                 // 立刻 onChange
  focus(blockId?: string): void;
  destroy(): void;
  el: HTMLElement;               // 根节点
  /** 调试 / 宿主高级 */
  getSelection?(): EditorSelection | null;
}

interface MountOptions {
  markdown?: string;
  doc?: Doc;                     // 与 markdown 二选一，doc 优先
  viewOnly?: boolean;            // 查看态：无编辑 chrome，无「只读」文案
  autosaveMs?: number;           // 默认 400
  mode?: 'conex' | 'pure-gfm';   // 序列化模式
  onChange?: (md: string, doc: Doc) => void;
  onOpenPath?: (path: string) => void;
  onOpenDoc?: (title: string) => void;
  onSelectionChange?: (sel: EditorSelection | null) => void;
  /** 宿主提供：粘贴图片上传等 */
  media?: {
    uploadImage?: (file: File) => Promise<{ url: string; alt?: string }>;
  };
  /** 主题 class 挂在 root */
  className?: string;
  placeholder?: string;
}

function mount(host: HTMLElement, options?: MountOptions): MarkdownEditorAPI;
```

**兼容**：现有 `MarkdownEditor.mount` / `viewOnly` 行为保持。

---

## 5. Conex Markdown 扩展（往返）

| 语法 | Block / Mark | pure-gfm 降级 |
|------|--------------|---------------|
| `> [!NOTE]` / `> [!TIP]` … | callout | 普通 quote |
| `[[file:path]]` | file_chip / mark | 链接或 plain |
| `[[title]]` | wiki mark | plain |
| `==highlight==` | highlight | plain |
| 语言标记 \`\`\`js | code.lang | 保留 |

GitHub Alerts 兼容：

```md
> [!WARNING]
> 正文
```

---

## 6. 事务（内部）

```ts
interface Transaction {
  steps: Step[];
  selection?: EditorSelection;
  meta?: {
    addToHistory?: boolean;
    mergeKey?: string;  // 合并连续输入
    reason?: string;
  };
}

type Step =
  | { op: 'insert'; index: number; blocks: Block[] }
  | { op: 'remove'; ids: BlockId[] }
  | { op: 'update'; id: BlockId; patch: Partial<Block> }
  | { op: 'move'; id: BlockId; toIndex: number }
  | { op: 'replace'; blocks: Block[] };
```

宿主 **不** 需要直接发 Transaction；高级插件以后通过 `editor.apply(tr)` 扩展。

---

## 7. 迁移

| 从 | 到 | 规则 |
|----|----|------|
| version 缺省 / 1 | 2 | `blocks` 补 `indent:0`；`text` 保留；无 `runs` |
| `rows` only table | cells | §3.3 |
| 未知 type | paragraph | `meta.unknownType` 保留原 type 名 |

```js
MdxSchema.migrate(doc) → Doc(version:2)
```

---

## 8. 与主软件集成清单

宿主适配最少实现：

1. 挂载容器 `HTMLElement`  
2. 初始 `markdown` 或 `doc`  
3. `onChange` 写回存储  
4. （可选）`onOpenPath` / `onOpenDoc` 路由  
5. （可选）`viewOnly` 预览  
6. 引入 CSS：`css/markdown-editor/index.css`（或打包后的 bundle）  
7. 脚本顺序：`util → schema → model → parse → serialize → registry → blocks/* → ui/* → editor → index`

**不要**：

- 依赖 demo 页 `markdown-editor.html` 壳层  
- 依赖 `index.html` Composer  
- 假设全局只有一个编辑器实例  

---

## 9. 非目标（数据层）

- CRDT / 协同 OT  
- Notion Database 属性类型  
- 二进制嵌入进 JSON（图片用 URL / 附件路径）  
- 单元格 rowspan/colspan 序列化（v3）  

---

## 10. 变更流程

改 schema：

1. bump `version`  
2. 写 `migrate`  
3. 更新 parse/serialize 往返测试  
4. 改本文 + CROSSCUTTING  
5. 再改代码  
