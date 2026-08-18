# 01 — 架构：数据模型、引擎分层、序列化

> **状态**：设计中 · Architecture  
> **读者**：实现 agent / 评审  
> **关联**：[README](./README.md) · [AGENT_BRIEFING](./AGENT_BRIEFING.md) · [00-product-vision](./00-product-vision.md) · [02-block-catalog](./02-block-catalog.md) · [03-line-renderer](./03-line-renderer.md) · [04-dnd-reorder](./04-dnd-reorder.md) · [05-slash-commands](./05-slash-commands.md) · [08-integration](./08-integration.md)

---

## 0. 目标与非目标

### 目标

1. 用 **块级文档模型** 替换 `NotebookPanel` 当前「整页 `contenteditable` + blur 再 `MarkdownLite.render`」路径。  
2. 内存真相源为 `Doc`（`Block[]`）；磁盘/剪贴板/宿主回调序列化主格式为 **Markdown**（扩展语法可往返）。  
3. 编辑粒度是 **整块**：阅读态渲染 + 激活块内编辑，禁止全文 `innerHTML = render(all)` 热路径。  
4. 分层清晰：Host → Controller → Model → Registry → Views → Parser/Serializer → Palette / DnD / History。  
5. 块类型通过 **注册表** 扩展，核心不堆 `if (type === …)`。  
6. 中文输入（composition / IME）一等公民；命令触发 `/` 与 `、`。  
7. 预留性能边界（脏区间、虚拟化钩子）与安全边界（消毒、链接策略）。

### 非目标（v1）

| 非目标 | 说明 |
|---
> **命名冻结**：CSS 类前缀统一为 mdx-（见 [CROSSCUTTING.md](./CROSSCUTTING.md) D8）。本文历史草稿中的 cx-md-* 已批量改为 mdx-*。
-----|------|
| 协同 / OT / CRDT | 单用户本地编辑 |
| 预览/源码硬切换 UI | 产品已决；仅保留内部调试出口可选 |
| 代码文件进 Notebook | 只服务文档类 artifact |
| 表格复杂合并（rowspan/colspan） | v2；v1 建表 + 改单元格即可 |
| 完整 ProseMirror 兼容 | vanilla 先验证；见 §12 迁移路径 |
| 服务端权威校验 | 客户端消毒即可 |

### 替换边界（Notebook body）

**保留**（`NotebookPanel.js` 外壳）：

- pin / 拖顶栏 / Esc 关闭策略 / `docStore` 标题键 / 定位 `positionNear` / hide debounce

**替换**（`.nb-body` 内）：

```
现状：
  .nb-content[contenteditable]  →  全文 textContent 编辑
  blur → MarkdownLite.render 整页 innerHTML

目标：
  .nb-body
    └── .mdx-editor[data-mdx-root]
          ├── .mdx-scroller          # 滚动/虚拟化宿主
          │     └── .mdx-block[]   # 每块独立 DOM
          ├── .mdx-palette         # slash 浮层（portal 可选）
          └── .mdx-drop-indicator  # DnD 指示线
```

宿主契约见 §11 与 [08-integration](./08-integration.md)。

---

## 1. 分层架构

```
┌─────────────────────────────────────────────────────────────────┐
│ Host: NotebookPanel (pin / drag header / docStore / autosave)   │
│  - open(title, md) / flush() / onChange(md)                     │
└────────────────────────────┬────────────────────────────────────┘
                             │ mount(rootEl, { markdown, onChange })
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ EditorController                                                │
│  mode FSM · 事件总线 · 焦点/选区 · 调度 Transaction               │
│  持有: model, registry, history, palette, dnd, views            │
└───┬─────────────┬──────────────┬──────────────┬─────────────────┘
    │             │              │              │
    ▼             ▼              ▼              ▼
 DocumentModel  BlockRegistry  CommandPalette  DnDController
 (Doc+Selection) (type→spec)   (/ 与 、)       (reorder ops)
    │             │
    │             ▼
    │          BlockViews
    │          (read DOM / edit surface / 局部 patch)
    ▼
 Parser / Serializer
 Markdown ⇄ tokens ⇄ Block[]
    │
    ▼
 History (undo/redo command stack)
```

### 层职责一览

| 层 | 职责 | 禁止 |
|----|------|------|
| **Host** | 外壳 UI、持久化、打开关闭 | 解析 MD、操作单块 DOM |
| **EditorController** | 模式、输入路由、应用事务、通知视图 | 具体块 HTML 细节 |
| **DocumentModel** | 不可变式更新后的新 Doc 引用；查询 API | 直接碰 DOM |
| **BlockRegistry** | 类型元数据、parse/serialize/render/edit/slash | 全局状态 |
| **BlockViews** | 块 DOM 生命周期、阅读/编辑切换、脏标记 | 改 history 规则 |
| **Parser/Serializer** | MD ↔ Doc | UI |
| **CommandPalette** | 过滤、插入、键盘导航 | 改模型算法（只发 Transaction） |
| **DnDController** | 把手拖拽、落点、发出 `move` | 序列化 |
| **History** | undo/redo 栈、合并策略 | 渲染 |

### 数据流方向

```
用户事件 → Controller.route(event)
         → 构造 Transaction
         → applyTransaction(doc, tr) → { doc', selection', inverse }
         → History.push(inverse)
         → Views.patch(dirtyBlockIds | structureChange)
         → Host.onChange(toMarkdown(doc'))  // debounced
```

---

## 2. 核心 TypeScript 类型

> Runtime 首版为 **vanilla JS**；类型作契约草稿，实现可用 JSDoc `@typedef` 或后续 `.d.ts`。

```ts
/** 稳定块 ID：nanoid / crypto.randomUUID 缩短版；序列化进 MD 时默认不落盘（除非扩展属性） */
type BlockId = string;

/**
 * 块类型字符串。内置用短名；扩展用命名空间。
 * 完整目录见 02-block-catalog.md
 */
type BlockType =
  | 'paragraph'
  | 'heading'
  | 'bullet_list_item'
  | 'ordered_list_item'
  | 'todo_item'
  | 'quote'
  | 'code'
  | 'table'
  | 'divider'
  | 'image'
  | 'callout'
  | string; // 扩展：'conex.file_ref' 等

/** 行内标记（扁平 runs，不嵌套树；重叠用相邻 run 拆分） */
type InlineMark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'code' }
  | { type: 'strike' }
  | { type: 'link'; href: string; title?: string }
  | { type: 'mention'; id: string; label: string } // 扩展，见 06
  | { type: string; [k: string]: unknown };

interface TextRun {
  text: string;
  marks?: InlineMark[];
}

/** 块级内容：多数块是 TextRun[]；code/table 用专用 props */
interface Block {
  id: BlockId;
  type: BlockType;
  /** 扁平文档上的缩进层级，0 = 顶层。见 §3 */
  indent: number;
  /** 行内文本；无文本块可为空数组 */
  runs: TextRun[];
  /** 类型专有字段：level, language, checked, rows, align… */
  props: Record<string, unknown>;
  /** 解析残留 / 未知语法保真 */
  meta?: {
    raw?: string;
    sourceStart?: number; // 源 MD 行号（0-based），可选
    sourceEnd?: number;
  };
}

interface Doc {
  version: 1;
  blocks: Block[];
  /** 文档级元数据：标题由 Host 管，此处仅扩展 */
  meta?: Record<string, unknown>;
}

/** 编辑器选区：块锚点 + 块内偏移（UTF-16 code unit，与 JS 字符串一致） */
interface Selection {
  anchor: { blockId: BlockId; offset: number };
  focus: { blockId: BlockId; offset: number };
  /** 是否块级选中（整块高亮，用于多块删除/拖） */
  blockLevel?: boolean;
}

type TransactionStep =
  | { op: 'insert'; index: number; blocks: Block[] }
  | { op: 'delete'; ids: BlockId[] }
  | { op: 'update'; id: BlockId; patch: Partial<Pick<Block, 'type' | 'indent' | 'runs' | 'props' | 'meta'>> }
  | { op: 'move'; ids: BlockId[]; toIndex: number } // toIndex = 移除后目标索引语义见 §4
  | { op: 'replace'; id: BlockId; block: Block }   // 类型转换常用
  | { op: 'set_selection'; selection: Selection | null };

interface Transaction {
  steps: TransactionStep[];
  /** 若缺省，由 apply 根据 steps 推导合理选区 */
  selection?: Selection | null;
  meta?: {
    source?: 'input' | 'paste' | 'slash' | 'dnd' | 'history' | 'api' | 'ime';
    addToHistory?: boolean; // default true；composition 中间态 false
    mergeKey?: string;      // 同 key 短时间合并 undo（如同一段落连续输入）
    label?: string;         // 调试
  };
}

interface ApplyResult {
  doc: Doc;
  selection: Selection | null;
  /** 用于 undo 的逆事务 */
  inverse: Transaction;
  /** 视图层最小更新提示 */
  dirty: {
    structure: boolean;      // 增删移导致需重排 DOM
    blockIds: BlockId[];     // 内容/类型变化的块
  };
}

/** 块注册规格 */
interface BlockTypeSpec {
  type: BlockType;
  /** slash 展示；详细词条见 05 */
  slash?: {
    title: string;
    keywords: string[];      // 含中文
    icon?: string;
    group?: string;
  };
  /** 从 token 流消费并产出 Block；返回消费的 token 数 */
  parse?: (ctx: ParseContext) => { block: Block; consumed: number } | null;
  serialize: (block: Block, ctx: SerializeContext) => string;
  /** 阅读态：返回 HTMLElement 或填充 container */
  render: (block: Block, ctx: RenderContext) => HTMLElement;
  /** 进入编辑：在 container 内挂编辑表面（contenteditable 子节点或 input） */
  edit?: (block: Block, ctx: EditContext) => EditSession;
  /** 允许的 indent 范围；默认 0..6 */
  indentRange?: { min: number; max: number };
  /** 空块回车 / 退格行为钩子 */
  keymap?: Partial<Record<string, (ctx: KeyContext) => boolean>>;
  isVoid?: boolean; // divider / image 等无文本 caret
}

interface EditSession {
  el: HTMLElement;
  getRuns(): TextRun[];
  getProps?(): Record<string, unknown>;
  setCaret?(offset: number): void;
  destroy(): void;
}
```

### 辅助查询 API（DocumentModel）

```ts
interface DocumentModel {
  getDoc(): Doc;
  getBlock(id: BlockId): Block | undefined;
  indexOf(id: BlockId): number;
  blockAt(index: number): Block | undefined;
  /** 按序切片，供多块选区 */
  slice(from: number, to: number): Block[];
  /** 相邻同 type+indent 的 list 视觉成组（不改数据） */
  listGroupBounds(id: BlockId): { start: number; end: number } | null;
}
```

---

## 3. 文档模型规则

### 3.1 推荐策略：**扁平 `Block[]` + `indent` 层级**

**选定：flat + indent，不采用真树 `children[]`。**

| 维度 | 扁平 + indent | 真树 children |
|------|---------------|---------------|
| 与 MD 同构 | 列表缩进本身是线性文本 | 需额外 flatten/unflatten |
| DnD 重排 | 数组 splice + 可选 clamp indent | 跨父节点 reparent 复杂 |
| 选区/多块删除 | 连续 index 区间 | 需树遍历与跨枝选区 |
| 虚拟化 | 线性窗口天然 | 需 DFS 可见列表 |
| Undo | 步语义简单 | move 跨层 inverse 难 |
| Quote/Callout 内嵌 | 用 indent 或「容器块 + 后续 indent>容器」约定 | 真嵌套更直观但序列化贵 |

**代价与约定：**

1. **列表**：连续的 `bullet_list_item` / `ordered_list_item` / `todo_item` 在阅读态由 View **视觉成组**（`<ul>`/`<ol>` 包裹），数据层仍是逐条 Block。  
2. **引用 / Callout**：v1 采用 **单块多行**（`runs` 内 `\n` 或 `props.lines`）**或** 连续 `quote` 块同 indent 视觉合并；复杂嵌套列表进 quote 放到 v2 扩展语法。  
3. **表格**：整表 **一个** `type: 'table'` 块，`props.rows: string[][]`，`props.align?: ('left'|'center'|'right')[]`；不把每个单元格做成独立顶层块。  
4. **代码围栏**：一个 `code` 块，`props.language`，正文在 `runs[0].text` 或 `props.code`（二选一，实现锁定 `props.code` 避免 marks 干扰）。  
5. **indent 范围**：默认 `0..6`；Tab / Shift-Tab 在 list item 上调整；非 list 块 Tab 可转为 list 或忽略（见 05/keymap）。  
6. **空文档**：至少一个空 `paragraph`（`runs: []`），禁止 `blocks.length === 0` 进入稳定态。

### 3.2 不变量（Invariants）

```
I1. blocks 内 id 全局唯一
I2. 每个 block.indent ∈ [0, MAX_INDENT]
I3. 稳定态 blocks.length >= 1
I4. Selection 的 blockId 必须存在于 doc（否则 clamp 到最近块）
I5. void 块 offset 视为 0；不可拆出半块文本
I6. applyTransaction 产出新 doc 引用（blocks 数组可结构共享未脏块对象）
```

### 3.3 块 ID 策略

- 创建：`id = 'b_' + random(10)`  
- **默认不写入 Markdown**（往返靠位置重建 id）  
- 会话内 id 稳定；`fromMarkdown` 全量替换时生成新 id（Host 换文档）  
- 可选：HTML 注释 `<!-- cx:id=... -->` 仅调试，产品路径关闭

---

## 4. Transaction 流水线与 History

### 4.1 设计原则

- **所有** 文档变更必须经 `applyTransaction`（含 paste、slash、DnD、API `setMarkdown`）。  
- 一次 Transaction 可含多 step，**原子提交**；失败则整单拒绝。  
- History 存 **inverse Transaction**，不存整文档快照（大文档友好）。  
- 连续输入用 `mergeKey`（如 `type:${blockId}`）在 N ms 内合并为一条 undo。

### 4.2 `applyTransaction` 伪代码

```ts
function applyTransaction(doc: Doc, tr: Transaction): ApplyResult {
  assertInvariants(doc);

  let blocks = doc.blocks.slice(); // 浅拷贝数组
  const idMap = new Map(blocks.map((b, i) => [b.id, i]));
  const inverseSteps: TransactionStep[] = [];
  const dirtyIds = new Set<BlockId>();
  let structure = false;
  let selection = tr.selection !== undefined
    ? tr.selection
    : /* 调用方可在 Controller 保留旧选区 */ null;

  const reindex = () => {
    idMap.clear();
    blocks.forEach((b, i) => idMap.set(b.id, i));
  };

  for (const step of tr.steps) {
    switch (step.op) {
      case 'insert': {
        const idx = clamp(step.index, 0, blocks.length);
        // 深拷贝插入块，确保 id 唯一
        const copies = step.blocks.map(ensureUniqueId);
        blocks.splice(idx, 0, ...copies);
        inverseSteps.unshift({
          op: 'delete',
          ids: copies.map((b) => b.id),
        });
        copies.forEach((b) => dirtyIds.add(b.id));
        structure = true;
        reindex();
        break;
      }
      case 'delete': {
        const doomed = step.ids
          .map((id) => idMap.get(id))
          .filter((i): i is number => i != null)
          .sort((a, b) => b - a); // 从后往前删
        const restored: { index: number; block: Block }[] = [];
        for (const i of doomed) {
          restored.push({ index: i, block: blocks[i] });
          dirtyIds.add(blocks[i].id);
          blocks.splice(i, 1);
        }
        // inverse：按原 index 从前往后插回
        restored.sort((a, b) => a.index - b.index);
        for (const r of restored) {
          inverseSteps.unshift({
            op: 'insert',
            index: r.index,
            blocks: [cloneBlock(r.block)],
          });
        }
        structure = true;
        // 禁止删空
        if (blocks.length === 0) {
          const p = createEmptyParagraph();
          blocks.push(p);
          dirtyIds.add(p.id);
          inverseSteps.unshift({ op: 'delete', ids: [p.id] });
        }
        reindex();
        break;
      }
      case 'update': {
        const i = idMap.get(step.id);
        if (i == null) break;
        const prev = blocks[i];
        const next = {
          ...prev,
          ...step.patch,
          props: step.patch.props
            ? { ...prev.props, ...step.patch.props }
            : prev.props,
          runs: step.patch.runs ?? prev.runs,
        };
        blocks[i] = next;
        inverseSteps.unshift({
          op: 'update',
          id: prev.id,
          patch: {
            type: prev.type,
            indent: prev.indent,
            runs: prev.runs,
            props: prev.props,
            meta: prev.meta,
          },
        });
        dirtyIds.add(prev.id);
        break;
      }
      case 'replace': {
        const i = idMap.get(step.id);
        if (i == null) break;
        const prev = blocks[i];
        blocks[i] = { ...step.block, id: prev.id }; // 保留 id
        inverseSteps.unshift({ op: 'replace', id: prev.id, block: cloneBlock(prev) });
        dirtyIds.add(prev.id);
        // 类型变化可能影响 list 成组 → 标 structure 更稳
        if (prev.type !== step.block.type || prev.indent !== step.block.indent) {
          structure = true;
        }
        break;
      }
      case 'move': {
        // 语义：先按当前序取出 ids，再插入到「移除后」的 toIndex
        const ordered = blocks.filter((b) => step.ids.includes(b.id));
        if (ordered.length === 0) break;
        const fromIndices = ordered.map((b) => idMap.get(b.id)!);
        const minFrom = Math.min(...fromIndices);
        blocks = blocks.filter((b) => !step.ids.includes(b.id));
        let to = clamp(step.toIndex, 0, blocks.length);
        // 记录 inverse：移回 minFrom（简化；精确多段可拆多 step）
        inverseSteps.unshift({
          op: 'move',
          ids: ordered.map((b) => b.id),
          toIndex: minFrom,
        });
        blocks.splice(to, 0, ...ordered);
        ordered.forEach((b) => dirtyIds.add(b.id));
        structure = true;
        reindex();
        break;
      }
      case 'set_selection': {
        selection = step.selection;
        // 选区不进 inverse 内容；History 可附带选区快照
        break;
      }
    }
  }

  // 选区校验
  selection = clampSelection(selection, blocks);

  const nextDoc: Doc = { ...doc, blocks };
  assertInvariants(nextDoc);

  const inverse: Transaction = {
    steps: inverseSteps,
    selection: /* 应用前选区由 History 另存 */ undefined,
    meta: { source: 'history', addToHistory: false },
  };

  return {
    doc: nextDoc,
    selection,
    inverse,
    dirty: { structure, blockIds: [...dirtyIds] },
  };
}
```

### 4.3 History（命令栈）

```ts
interface HistoryEntry {
  forward: Transaction;  // 可选，redo 用
  inverse: Transaction;
  beforeSel: Selection | null;
  afterSel: Selection | null;
  mergeKey?: string;
  ts: number;
}

class History {
  undoStack: HistoryEntry[] = [];
  redoStack: HistoryEntry[] = [];
  max = 200;
  mergeWindowMs = 500;

  push(entry: HistoryEntry, trMeta?: Transaction['meta']) {
    if (trMeta?.addToHistory === false) return;
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      top &&
      entry.mergeKey &&
      top.mergeKey === entry.mergeKey &&
      entry.ts - top.ts < this.mergeWindowMs
    ) {
      // 合并：保留 earliest inverse 起点 + 最新 afterSel
      top.forward = compose(top.forward, entry.forward);
      top.afterSel = entry.afterSel;
      top.ts = entry.ts;
      // inverse 应覆盖「从 earliest before 到 now」——
      // 实现上可在 composition 结束时再 push 单条，输入中 addToHistory:false
      return;
    }
    this.undoStack.push(entry);
    if (this.undoStack.length > this.max) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(doc: Doc): ApplyResult | null { /* pop inverse, apply, push to redo */ }
  redo(doc: Doc): ApplyResult | null { /* pop forward */ }
}
```

**IME 与 History：** composition 期间所有 `update` 的 `addToHistory: false`；`compositionend` 后把「开始快照 → 结束」压成 **一条** undo。

### 4.4 Controller 包装

```ts
class EditorController {
  apply(tr: Transaction) {
    const before = this.model.getDoc();
    const beforeSel = this.selection;
    const result = applyTransaction(before, tr);
    this.model.replace(result.doc);
    this.selection = result.selection;
    this.history.push({
      forward: tr,
      inverse: result.inverse,
      beforeSel,
      afterSel: result.selection,
      mergeKey: tr.meta?.mergeKey,
      ts: Date.now(),
    }, tr.meta);
    this.views.applyDirty(result.dirty);
    this.scheduleHostChange();
  }
}
```

---

## 5. Parse / Serialize 流水线

### 5.1 总览

```
Markdown string
    → normalizeNewlines (\r\n → \n)
    → line[] + 预扫描围栏/表格边界
    → Token[]          (block-level tokens)
    → Block[]          (Registry.parse 优先，fallback 内置)
    → Doc

Doc
    → 逐块 Registry.serialize
    → 块间连接规则（list 紧凑、段落空行）
    → Markdown string
```

### 5.2 Token 形状（块级，非 CommonMark 全量 AST）

```ts
type BlockToken =
  | { kind: 'heading'; level: 1|2|3|4|5|6; text: string; raw: string }
  | { kind: 'paragraph'; text: string; raw: string }
  | { kind: 'fence'; language: string; body: string; raw: string }
  | { kind: 'list_item'; ordered: boolean; order?: number; checked?: boolean | null; indent: number; text: string; raw: string }
  | { kind: 'quote'; text: string; raw: string }
  | { kind: 'table'; header: string[]; align: string[]; rows: string[][]; raw: string }
  | { kind: 'hr'; raw: string }
  | { kind: 'blank' }
  | { kind: 'unknown'; raw: string };
```

行内二次解析：`text → TextRun[]`（bold/italic/code/link）；未知字符原样进 run。

### 5.3 `fromMarkdown` 伪代码

```ts
function fromMarkdown(md: string, registry: BlockRegistry): Doc {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const tokens = tokenizeBlocks(lines); // 处理 ``` 与 table 多行
  const blocks: Block[] = [];
  let i = 0;

  while (i < tokens.length) {
    if (tokens[i].kind === 'blank') {
      i++;
      continue;
    }

    // 1) 扩展注册表：按注册顺序尝试
    let matched = false;
    for (const spec of registry.listParseable()) {
      const ctx = { tokens, index: i, parseInline };
      const res = spec.parse?.(ctx);
      if (res) {
        blocks.push(res.block);
        i += res.consumed;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // 2) 内置映射
    const t = tokens[i];
    blocks.push(tokenToBlock(t, parseInline));
    i++;
  }

  if (blocks.length === 0) blocks.push(createEmptyParagraph());

  return { version: 1, blocks };
}

function parseInline(text: string): TextRun[] {
  // 线性扫描：`code`、**bold**、*italic*、[label](url)
  // 输出不重叠的 runs；简化实现可先整段再 regex 分段
  // 中文与 emoji：按 JS 字符串 index，不按 codepoint 打断 marks 边界即可
  ...
}
```

### 5.4 `toMarkdown` 伪代码

```ts
function toMarkdown(doc: Doc, registry: BlockRegistry): string {
  const out: string[] = [];
  const blocks = doc.blocks;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const spec = registry.get(b.type);
    const chunk = spec
      ? spec.serialize(b, { serializeInline, prev: blocks[i - 1], next: blocks[i + 1] })
      : fallbackSerialize(b);

    // 连接规则：
    // - 相邻 list_item：单换行
    // - paragraph/heading/code/table：块后空行
    out.push(chunk);
    if (needsBlankLineAfter(b, blocks[i + 1])) out.push('');
  }

  // 去尾部多余空行，保留文件末单换行
  return trimTrailingBlanks(out).join('\n') + (out.length ? '\n' : '');
}

function serializeInline(runs: TextRun[]): string {
  return runs.map((r) => {
    let s = escapeMdText(r.text); // 仅转义必要字符，避免二次转义
    for (const m of r.marks || []) {
      if (m.type === 'code') s = '`' + r.text.replace(/`/g, '\\`') + '`';
      else if (m.type === 'bold') s = `**${s}**`;
      else if (m.type === 'italic') s = `*${s}*`;
      else if (m.type === 'link') s = `[${s}](${m.href})`;
    }
    return s;
  }).join('');
}
```

### 5.5 往返保证（Round-trip）

| 级别 | 保证 | 说明 |
|------|------|------|
| **L0 语义** | v1 必达 | 块类型、文本、indent、table 单元格、code 语言/正文、todo checked |
| **L1 格式** | 尽量 | 标题 `#` 风格统一；list 统一 `-` 或有序 `1.`；表格对齐符号规范化 |
| **L2 字节级** | 不保证 | 原 MD 空格风格、多余空行、强调符 `**` vs `__` 混用 |

**保真策略：**

- 未知块 / 解析失败行 → `paragraph` 或 `type: 'raw'`（若注册）+ `meta.raw`，serialize 时原样吐回。  
- 行内未识别语法保留为纯文本 runs（不丢字符）。  
- 测试夹具：`fixtures/*.md` → `fromMarkdown` → `toMarkdown` → `fromMarkdown`，第二次 Doc **语义相等**（忽略 id）。

```ts
function semanticEqual(a: Doc, b: Doc): boolean {
  if (a.blocks.length !== b.blocks.length) return false;
  return a.blocks.every((bl, i) =>
    bl.type === b.blocks[i].type &&
    bl.indent === b.blocks[i].indent &&
    JSON.stringify(bl.runs) === JSON.stringify(b.blocks[i].runs) &&
    JSON.stringify(normalizeProps(bl)) === JSON.stringify(normalizeProps(b.blocks[i]))
  );
}
```

### 5.6 与现有 `markdown-lite.js` 关系

| 能力 | markdown-lite | 新 Parser |
|------|---------------|-----------|
| 目标 | 字符串 → HTML | 字符串 → Doc →（View）HTML |
| 表格/标题/列表/代码 | 有 | 有，并进 Block |
| 编辑 | 无 | 有 |
| 命运 | 只读 fallback / 流内 TextBlock 可暂留 | Notebook 主体替换 |

过渡期：`MarkdownLite.render` 可继续服务对话流旁路；Notebook 不再调用它做主预览。

---

## 6. 编辑器模式（FSM）

```
                    open()
                      │
                      ▼
              ┌───────────────┐
              │    reading    │◄──────────────┐
              └───┬───────┬───┘               │
     click block  │       │  Esc / blur*      │
                  ▼       │                   │
         ┌────────────────┴───┐               │
         │   editing-block    │───────────────┤
         └───┬────────────┬───┘  commit block │
    `/` `、` │            │ pointer on handle │
             ▼            ▼                   │
    ┌─────────────┐  ┌──────────┐             │
    │ palette-open│  │ dragging │─────────────┘
    └─────────────┘  └──────────┘   drop/cancel
```

\* blur：若焦点仍在编辑器根内（palette/toolbar）不退出；焦点离开编辑器 → 提交当前块并回 reading。

### 模式表

| Mode | 用户可见 | 输入路由 | DOM |
|------|----------|----------|-----|
| `reading` | 精致渲染；hover 显示左把手 | 点击进编辑；快捷键可选 | 块 `contenteditable=false` |
| `editing-block` | 当前块编辑表面 | keydown/input/composition → 块内；Enter 拆块 | 仅该块可编 |
| `palette-open` | slash 列表 | 上下确认 Esc；过滤 query | palette 焦点陷阱 |
| `dragging` | 落点指示线 | pointermove/up；禁文本输入 | `user-select: none` |

```ts
type EditorMode =
  | { name: 'reading' }
  | { name: 'editing-block'; blockId: BlockId }
  | { name: 'palette-open'; blockId: BlockId; query: string; trigger: '/' | '、'; startOffset: number }
  | { name: 'dragging'; ids: BlockId[]; originIndex: number };
```

**互斥：** `palette-open` 期间不进入 `dragging`；`dragging` 结束强制 `reading` 或恢复编辑。

---

## 7. 事件流

### 7.1 捕获点

编辑器根 `el` 使用 **事件委托**（不给每块绑全套监听）：

```
.mdx-editor
  keydown     (capture: true 用于拦截 Tab/Enter 优先)
  keyup
  beforeinput
  input
  compositionstart / compositionupdate / compositionend
  pointerdown / pointermove / pointerup
  focusin / focusout
  copy / cut / paste
  drag*（若用 HTML5 DnD；推荐 Pointer + 自绘，见 04）
```

### 7.2 keydown（摘要）

| 键 | reading | editing-block | palette-open |
|----|---------|---------------|--------------|
| Enter | — | 拆块 / 列表续项 / 空 list 升格 paragraph | 确认命令 |
| Backspace 块首 | — | 与上块合并 | 删 query |
| Tab / S-Tab | — | indent | 无 |
| `/` 或 `、` 在行首或空块 | — | 打开 palette | 进 query |
| Esc | Host 可关面板 | 退出编辑 → reading | 关 palette |
| Mod+Z / Mod+Y | undo/redo | 同左 | 同左 |
| Arrow | 块间移动焦点 | 块内 caret；边界穿梭 | 高亮项 |

### 7.3 input / beforeinput

- 优先 `beforeinput`（可 `preventDefault` 后手动 `update` runs），降级 `input`。  
- 每次落到 **当前编辑块** 的 `runs` 同步（从 EditSession 读）。  
- `mergeKey: 'type:'+blockId`。

### 7.4 Composition（中文 IME）— 硬约束

```
compositionstart
  → ctrl.composing = true
  → 暂停：slash 检测、undo merge 提交、autosave 强制 flush

compositionupdate
  → 可更新预览 DOM，但不 commit 最终 runs 到 history

compositionend
  → ctrl.composing = false
  → 读取最终文本 → Transaction update runs
  → 再跑 slash 检测（若以 / 或 、 开头）
  → history 压一条
```

**禁止** 在 `compositionupdate` 中：

- 替换整个 `textContent` / 重挂 `innerHTML` 导致 IME 断会话  
- 移动 caret 到块外  
- 打开/重定位 palette 抢走焦点（可等 end）

**DOM 策略：** 编辑表面使用 **稳定 text node** 或单 `contenteditable` 子节点；marks 可视化在 composition 期间降级为纯文本，end 后再装饰（见 03）。

### 7.5 selectionchange

```
document.onselectionchange → 防抖 0~16ms
  → 若 selection 在 editor 内
  → 映射 DOM range → Selection { blockId, offset }
  → 更新 Controller.selection（不进 history）
  → 多块拖选：blockLevel 标记 + 高亮 class
```

跨块选区删除 → 单 Transaction：`delete` 中间块 + `update` 首尾合并文本。

### 7.6 事件 → Transaction 示例

```ts
function onEnter(ctx) {
  if (ctx.composing) return;
  const { block, offset } = ctx;
  const [left, right] = splitRuns(block.runs, offset);
  ctx.apply({
    steps: [
      { op: 'update', id: block.id, patch: { runs: left } },
      {
        op: 'insert',
        index: ctx.indexOf(block.id) + 1,
        blocks: [{
          id: newId(),
          type: defaultNextType(block), // list 续 list，否则 paragraph
          indent: block.indent,
          runs: right,
          props: {},
        }],
      },
    ],
    selection: { anchor: { blockId: newIdRef, offset: 0 }, focus: { ... } },
    meta: { source: 'input' },
  });
}
```

---

## 8. 插件 / 注册 API

### 8.1 注册表

```ts
class BlockRegistry {
  private map = new Map<string, BlockTypeSpec>();
  private order: string[] = []; // parse 优先级

  register(spec: BlockTypeSpec): () => void {
    if (this.map.has(spec.type)) {
      console.warn('[mdx] override block type', spec.type);
    }
    this.map.set(spec.type, spec);
    if (!this.order.includes(spec.type)) this.order.push(spec.type);
    return () => this.unregister(spec.type);
  }

  unregister(type: string) { ... }
  get(type: string): BlockTypeSpec | undefined { return this.map.get(type); }
  listParseable(): BlockTypeSpec[] {
    return this.order.map((t) => this.map.get(t)!).filter((s) => s.parse);
  }
  listSlash(): BlockTypeSpec[] {
    return [...this.map.values()].filter((s) => s.slash);
  }
}

// 全局单例（prototype 阶段）
window.CxMarkdownEditor = window.CxMarkdownEditor || {};
window.CxMarkdownEditor.registerBlockType = (spec) => defaultRegistry.register(spec);
```

### 8.2 最小注册示例

```js
registerBlockType({
  type: 'heading',
  slash: {
    title: '标题 1',
    keywords: ['h1', '标题', 'heading'],
    group: '基础',
  },
  parse(ctx) {
    const t = ctx.tokens[ctx.index];
    if (!t || t.kind !== 'heading') return null;
    return {
      consumed: 1,
      block: {
        id: newId(),
        type: 'heading',
        indent: 0,
        runs: ctx.parseInline(t.text),
        props: { level: t.level },
      },
    };
  },
  serialize(block, ctx) {
    const level = Number(block.props.level) || 1;
    return '#'.repeat(clamp(level, 1, 6)) + ' ' + ctx.serializeInline(block.runs);
  },
  render(block, ctx) {
    const h = document.createElement('h' + (block.props.level || 1));
    h.className = 'mdx-h mdx-h' + (block.props.level || 1);
    h.appendChild(ctx.renderRuns(block.runs));
    return h;
  },
  edit(block, ctx) {
    return ctx.mountTextEditor(block); // 共享段落编辑器
  },
});
```

### 8.3 扩展点一览

| 扩展点 | 用途 |
|--------|------|
| `registerBlockType` | 新块 |
| `registerInlineMark`（v1.1） | mention、高亮 |
| `registerSerializerRule` | 块间空行策略 |
| `registerKeymap` | 全局热键 |
| `registerInputRule` | 行首 `### ` 转标题等 |

Input rules 在 `compositionend` 与普通 `input` 后跑；与 slash 互不抢：slash 优先当 query 面板已打开。

---

## 9. 性能

### 9.1 禁止事项

```
❌ 每次按键：toMarkdown(doc) 全量 + fromMarkdown + 整树 innerHTML
❌ 每次按键：根节点 replaceChildren(全部块)
❌ 滚动监听里同步 layout 读 + 写交错无 rAF
```

### 9.2 增量更新

```
ApplyResult.dirty
  structure=false && blockIds=[id]
    → Views.updateBlock(id)  // 只 patch 该块 DOM
  structure=true
    → Views.reconcileList(doc.blocks)
         按 blockId 复用已有节点；插入/移动/删除其余
```

**Reconcile 算法（简化）：**

```ts
function reconcileList(parent: HTMLElement, blocks: Block[]) {
  const prev = new Map(
    [...parent.children]
      .filter((el) => el.dataset.blockId)
      .map((el) => [el.dataset.blockId!, el as HTMLElement])
  );
  const nextNodes: HTMLElement[] = [];
  for (const b of blocks) {
    let el = prev.get(b.id);
    if (!el) el = mountBlockShell(b);
    else if (dirtyIds.has(b.id)) patchBlock(el, b);
    nextNodes.push(el);
    prev.delete(b.id);
  }
  prev.forEach((el) => el.remove());
  // 有序对齐：用最短移动或 parent.append 顺序重建
  reorderChildren(parent, nextNodes);
}
```

### 9.3 脏区间解析

- **编辑路径**：不重新 parse Markdown；直接改 `runs`/`props`。  
- **粘贴 MD 字符串**：仅对粘贴片段 `fromMarkdown(fragment)`，再 `insert` steps。  
- **外部 `setMarkdown`**：全量 parse 一次 + 全量 reconcile（可接受）。  
- **可选优化**：Host 流式追加文档时 API `appendMarkdown(chunk)` → tokenize 增量尾部。

### 9.4 虚拟化

| 块数 | 策略 |
|------|------|
| &lt; 200 | 全量 DOM |
| 200–500 | 仍全量；开始测 FPS |
| &gt; 500 | **强制** 窗口虚拟化 |

虚拟化接口（先设计，后实现）：

```ts
interface Virtualizer {
  measure(id: BlockId): number;
  getVisibleRange(scrollTop: number, height: number): { start: number; end: number };
  // 仅挂载 [start, end) + overscan
}
```

**约束：** 编辑中的块与其 ±1 邻居必须挂载；DnD 拖动态可临时全量或扩大 overscan。  
占位高度：缓存 `heightMap[id]`，resize 后更新。

### 9.5 序列化与 autosave

- `toMarkdown`：**debounce 400ms**（与现 Notebook `AUTOSAVE_MS` 对齐）或 idle 回调。  
- 大文档：可增量拼接「未脏前缀缓存 + 脏中段 + 后缀」，v1 可全量 serialize（500 块通常 &lt; 5ms）。

---

## 10. 安全

### 10.1 原则

- **永不** `innerHTML = userMarkdown` 直出。  
- 阅读态 DOM 由 `render` 用 `createElement` + `textContent` 构建；唯一 `innerHTML` 仅限已消毒片段（尽量不用）。  
- 链接：`href` 白名单协议。

### 10.2 链接策略

```ts
const SAFE_PROTO = /^(https?:|mailto:|tel:|#|\/)/i;

function sanitizeHref(href: string): string | null {
  const h = String(href || '').trim();
  if (!h) return null;
  if (/^(javascript:|data:|vbscript:)/i.test(h)) return null;
  if (SAFE_PROTO.test(h)) return h;
  // 无协议相对路径可接受为站内
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(h)) return h;
  return null;
}

// <a href="..." target="_blank" rel="noopener noreferrer">
```

### 10.3 HTML / 原始 HTML 块

- v1 **不解析** 任意 HTML 块为可执行 DOM；遇到 `<div>` 等作纯文本 paragraph 或 raw 保真。  
- 若未来允许受限 HTML：必须走 allowlist sanitizer（标签+属性），禁 `script`、`on*`、`iframe`（除非产品明确嵌入策略）。

### 10.4 代码块

- 代码正文 `textContent` 放入 `<pre><code>`；**不做** 浏览器侧任意高亮库的 HTML 注入除非转义。  
- 语法高亮若用库，仅输出 span 类名，源文本仍转义。

### 10.5 剪贴板

- paste：优先 `text/plain`；若 `text/html` 则降级提取文本或有限 MD。  
- copy 多块：写出 Markdown 到 `text/plain`；可选 `application/x-conex-blocks+json` 保真。

---

## 11. 文件布局提案

```
reference/chat-composer-component/
  js/
    markdown-lite.js              # 过渡保留
    markdown-editor/
      index.js                    # 导出 mount / registerBlockType
      controller.js               # EditorController + mode FSM
      model.js                    # Doc helpers / applyTransaction
      history.js
      selection.js                # DOM ↔ Selection 映射
      registry.js
      parse/
        tokenize.js
        from-markdown.js
        inline.js
      serialize/
        to-markdown.js
      view/
        editor-view.js            # 根视图 reconcile
        block-view.js
        inline-view.js
        virtualizer.js            # 可空实现
      input/
        keymap.js
        before-input.js
        composition.js
        input-rules.js
      dnd/
        dnd-controller.js
      palette/
        command-palette.js
      blocks/
        paragraph.js
        heading.js
        list-item.js
        todo.js
        quote.js
        code.js
        table.js
        divider.js
        index.js                  # registerDefaults()
      util/
        id.js
        escape.js
        debounce.js
      host/
        notebook-adapter.js       # 对接 NotebookPanel
    components/
      NotebookPanel.js            # 改 body 挂载 adapter；外壳保留

  css/
    markdown-editor/
      editor.css                  # 根、滚动、选区、把手槽
      blocks.css                  # h1–h3、p、list、quote、code、table
      palette.css
      dnd.css
      tokens.css                  # 与 design-tokens / conversation-tokens 对齐的局部变量
```

### 11.1 CSS class 契约（核心）

| Class | 用途 |
|-------|------|
| `mdx-editor` | 根；`data-mode=reading\|editing\|palette\|dragging` |
| `mdx-scroller` | 滚动容器 |
| `mdx-block` | 块壳；`data-block-id` `data-type` `data-indent` |
| `mdx-block.is-active` | 当前编辑块 |
| `mdx-block.is-selected` | 块级多选 |
| `mdx-handle` | 左 6-dot 把手 |
| `mdx-block__content` | 阅读/编辑内容槽 |
| `mdx-palette` | 命令面板 |
| `mdx-drop-indicator` | DnD 指示 |
| `mdx-h1`…`mdx-pre` `mdx-table`… | 阅读态皮肤（见 07） |

### 11.2 DOM 草图（单块）

```html
<div class="mdx-block" data-block-id="b_xxx" data-type="paragraph" data-indent="0">
  <button type="button" class="mdx-handle" aria-label="拖动排序" tabindex="-1">⋮⋮</button>
  <div class="mdx-block__content" data-cx-content>
    <!-- reading: <p class="mdx-p">...</p> -->
    <!-- editing: <div class="mdx-edit" contenteditable="true">...</div> -->
  </div>
</div>
```

### 11.3 Host 挂载伪代码

```js
// notebook-adapter.js
function mountNotebookEditor(contentParent, { getMarkdown, setMarkdown, onChange }) {
  contentParent.innerHTML = ''; // 仅一次
  const root = document.createElement('div');
  root.className = 'mdx-editor';
  contentParent.appendChild(root);

  const editor = CxMarkdownEditor.mount(root, {
    markdown: getMarkdown(),
    onChange: (md) => {
      setMarkdown(md);
      onChange?.(md);
    },
  });

  return {
    setMarkdown: (md) => editor.setMarkdown(md),
    getMarkdown: () => editor.getMarkdown(),
    focus: () => editor.focus(),
    destroy: () => editor.destroy(),
  };
}
```

`NotebookPanel` 中：删除 `enterEditMode` 全文 `textContent` 路径；`showReadingView` 改为 `adapter.setMarkdown` 或初始 mount；`flush` 读 `adapter.getMarkdown()`。

---

## 12. Vanilla 优先 vs TipTap / Lexical 迁移

### 12.1 决策（reference 阶段）

**Vanilla JS Block Model 先行**，原因：

1. 产品交互是 **块级 Notion 式**，不是长文 inline 编辑为主；PM/TipTap 的文档节点树与扁平 indent 模型要做适配层。  
2. 原型在 `reference/chat-composer-component`，无构建链负担时可更快验证 DnD / slash / IME。  
3. 已有决策：引擎可自研；PM/TipTap/Lexical **仅作参考**。

### 12.2 何时考虑迁移

| 信号 | 动作 |
|------|------|
| 行内 marks 嵌套/边界 bug 过多 | 评估引入 ProseMirror 仅作 **块内** 编辑 |
| 需要协同 | 再评估（当前非目标） |
| 桌面端接入要求统一富文本栈 | 在 `08-integration` 重开 RFC |

### 12.3 迁移路径（保持 Doc 不变）

```
阶段 A（现）
  Doc + vanilla EditSession(contenteditable)

阶段 B（可选）
  Doc 不变
  paragraph/heading 的 edit() 内部换成 TipTap/Lexical 微型实例
  serialize 仍出 Markdown via 我们的 Block.serialize

阶段 C（仅当整树迁移）
  写 Doc ↔ PM Node 双向映射
  Transaction 适配器：我们的 Step → PM tr
  Registry 块 → PM NodeSpec
```

**稳定契约（迁移不变量）：**

- 对外 API：`mount` / `setMarkdown` / `getMarkdown` / `registerBlockType` / `onChange`  
- 序列化主格式：Markdown L0 语义  
- Host 仍不感知内部引擎

---

## 13. 失败模式与恢复

| 失败 | 检测 | 恢复 |
|------|------|------|
| 解析抛错 | `fromMarkdown` try/catch | 整文落入单 `code` 或单 `paragraph`（纯文本）；`meta.parseError=true`；UI toast「已用纯文本打开」 |
| 半截围栏 \`\`\` | tokenize 直到 EOF | 未闭合 code 块仍生成，serialize 补闭合 |
| 坏表（无分隔行） | table 识别失败 | 各行 paragraph |
| 事务后不变量破坏 | `assertInvariants` | 回滚到 apply 前 doc；`console.error`；不写 history |
| 选区指向已删块 | `clampSelection` | 落到相邻块 offset 0 |
| 编辑中块 type 被 replace | View | destroy EditSession → 按新 type mount |
| IME 中强制 setMarkdown | Controller | 队列至 compositionend |
| 超大粘贴（>1MB 文本） | paste 钩子 | 截断或 Web Worker parse + loading 态 |
| localStorage/docStore 满 | Host | 捕获 QuotaExceeded；内存保留，提示保存失败 |
| 虚拟化高度错误 | 滚动跳跃 | 重新 measure 可见块；滚动校正 |
| Registry 缺 type | render | fallback `paragraph` + 警告；serialize 用 `meta.raw` 或 runs 文本 |
| DnD drop 越界 | DnDController | clamp index；取消时无 Transaction |
| Undo 栈 inverse 失败 | History.undo | 清空 redo；保留 doc；打点日志 |

### 13.1 空态 / 超长

- **空态：** 单空 paragraph；placeholder「输入 `/` 或 `、` 插入块…」（中文产品文案）。  
- **超长：** >500 块开虚拟化；>5000 块 Host 可只读警告（可选）。  
- **单块超长 code（>100k 字符）：** 编辑态用 `textarea` 降级，禁行内高亮。

### 13.2 崩溃恢复（Host）

```
每次成功 toMarkdown → docStore[title] = md
可选：sessionStorage 键 `mdx-draft:${title}` 更频繁写
打开时：若 draft 更新于 store 则提示恢复（v1 可直接 draft 优先）
```

---

## 14. 无障碍（a11y）要点

| 项 | 要求 |
|----|------|
| 根 | `role="document"` 或保留 Host `dialog`；内部块列表 `role="list"` 可选 |
| 块 | 阅读态可 `tabindex="-1"`；编辑态焦点进 contenteditable |
| 把手 | `aria-label="拖动排序"`；键盘排序另提供 Alt+↑/↓（见 04） |
| Palette | `role="listbox"` + `aria-activedescendant`；焦点陷阱 |
| 活区 | 块类型变更可 `aria-live="polite"` 短提示（节流） |
| 对比度 | 跟随 07 visual tokens；禁仅靠颜色表达 todo 状态 |

---

## 15. 测试点

### 单元

1. `fromMarkdown` / `toMarkdown` 语义往返：heading/list/todo/table/code/quote/hr  
2. `applyTransaction`：insert/delete/update/move/replace；删空再生 paragraph  
3. `clampSelection`：越界 id  
4. `sanitizeHref`：javascript: 拒绝  
5. inverse：random walk transactions → undo 回初始 semanticEqual  
6. indent clamp  
7. IME：模拟 composition 序列不拆 history 多条（集成更佳）

### 集成

1. slash `/` 与 `、` 插入 heading  
2. Enter 拆段、Backspace 合并  
3. DnD 两块交换  
4. Notebook：open → 编辑 → flush → 再 open 内容一致  
5. 粘贴 GFM 表格  

### 夹具目录（规划）

```
js/markdown-editor/__fixtures__/
  basic.md
  gfm-table.md
  nested-list.md
  cjk-inline.md
```

---

## 16. 分期（与本架构相关）

| 期 | 交付 | DoD |
|----|------|-----|
| **M0** | model + parse/serialize + registry + 只读 render 挂进 Notebook | 往返测试绿；无编辑 |
| **M1** | 单块编辑 + Enter/BS + history + IME | 中文输入稳定；autosave MD |
| **M2** | slash 面板 + 基础块类型齐全 | `/` `、` 插入 |
| **M3** | DnD + 多块选区 | 见 04 |
| **M4** | 表格编辑 + 虚拟化钩子 | >500 块可滚动 |
| **M5** | 扩展语法 + 迁移评估 | 见 06/09 |

---

## 17. 边界情况速查

| 场景 | 行为 |
|------|------|
| 仅一个空块再 Backspace | 不删除；可清空 runs |
| 在 void 块 Enter | 下方插入 paragraph 并聚焦 |
| 列表项空 + Enter | 降级为同 indent paragraph 或减少 indent（Notion 风，实现锁一种） |
| 阅读态点链接 | 默认跟链（target=_blank）；Mod+click 与 click 策略见 03 |
| 编辑态点链接 | 先聚焦块，不立刻跳转 |
| 全选删除 | 余一个空 paragraph |
| setMarkdown 于 editing | 确认 composition 结束后替换；尽量保留同 id 匹配（启发式） |

---

## 18. 实现检查清单（交给实现 agent）

- [ ] `applyTransaction` 纯函数 + 不变量  
- [ ] `fromMarkdown` / `toMarkdown` L0 往返  
- [ ] `registerBlockType` 默认块注册  
- [ ] Controller 四模式 FSM  
- [ ] composition 三件套不打断 IME  
- [ ] View 按 dirty 局部更新，禁全文 innerHTML  
- [ ] 链接消毒 + rel  
- [ ] Notebook adapter 替换 `.nb-content` 路径  
- [ ] 单测夹具与 undo 往返  

---

## 19. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| 0.1 | 2026-08-02 | 首版架构：扁平 indent 模型、事务管线、MD 往返、模式/事件/注册表/性能/安全/布局/迁移/失败恢复 |
