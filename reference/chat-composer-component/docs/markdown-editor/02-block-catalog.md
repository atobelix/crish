# 02 — 块类型目录（Block Catalog）

> **角色**：块注册表的产品/规格索引。单块交互细节见 [`blocks/`](./blocks/)。  
> **不写**：DnD 物理（见 `04-dnd-reorder.md`）、命令面板 UI（见 `05-slash-commands.md`）、视觉 token 全集（见 `07-visual-system.md`）。  
> **CSS 前缀**：全部阅读/编辑 DOM 使用 `mdx-`（markdown editor），禁止与对话流 `flow-*` 冲突。

---

## 1. 目标 / 非目标

### 目标

- 为每个块类型给出 **稳定 type id**、GFM/扩展语法、props schema、阅读 DOM、编辑交互、slash id、空态文案、序列化边界、v1 优先级。
- 实现 agent 可按本目录 + `blocks/*` 直接 `registerBlockType(...)`，无需口头补全。
- 表格、列表、任务、代码等 **往返 Markdown** 规则可测。

### 非目标

- 协同 OT/CRDT、评论锚点、块级权限。
- 复杂表格合并单元格（v2）。
- 自定义 HTML 任意块（安全禁令）。

---

## 2. 共享数据形状

```ts
/** 稳定字符串，注册表主键；序列化 JSON 快照也用此 id */
type BlockTypeId =
  | 'paragraph'
  | 'heading'
  | 'bullet_list'
  | 'ordered_list'
  | 'list_item'
  | 'task_list'
  | 'task_item'
  | 'quote'
  | 'code_block'
  | 'table'
  | 'table_row'
  | 'table_cell'
  | 'divider'
  | 'callout'
  | 'image'
  | 'toggle'
  | 'math_block'
  | 'embed_link'
  | 'file_chip'
  | 'mention'; // 多为 inline atom；见 marks/atoms

interface BlockBase {
  id: string;           // 运行时 uuid，不进 Markdown
  type: BlockTypeId;
  props: Record<string, unknown>;
  children?: Block[];   // 仅容器块（list / quote / callout / toggle / table…）
  content?: InlineNode[]; // 叶子文本块
}

type InlineNode =
  | { type: 'text'; text: string; marks?: Mark[] }
  | { type: 'hard_break' }
  | { type: 'inline_code'; text: string }
  | { type: 'mention'; userId: string; label: string }
  | { type: 'file_chip'; path: string; label?: string };

type Mark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'strike' }
  | { type: 'link'; href: string; title?: string }
  | { type: 'inline_code' }; // 也可作 mark；与 atom 二选一，引擎统一一种
```

**约定**：

| 层级 | 谁拥有文本 | 说明 |
|------|------------|------|
| 叶子块（paragraph/heading/…） | `content: InlineNode[]` | 无 `children` |
| 容器块（list/quote/callout） | `children: Block[]` | 子项再持文本 |
| 表格 | `table` → `table_row[]` → `table_cell` | cell 内 v1 仅 paragraph 级 inline |

---

## 3. 共享 DOM / class 契约

### 3.1 根与块壳

```html
<div class="mdx-editor" data-mdx-root>
  <div class="mdx-block mdx-block--paragraph mdx-block--reading"
       data-block-id="…" data-block-type="paragraph" data-state="reading|editing">
    <div class="mdx-block__gutter" aria-hidden="true"><!-- 6-dot / + 见 04 --></div>
    <div class="mdx-block__body">…</div>
  </div>
</div>
```

| class / attr | 含义 |
|--------------|------|
| `mdx-editor` | 编辑器根 |
| `mdx-block` | 每块外壳 |
| `mdx-block--{type}` | 类型修饰（type id 中 `_` 保留或改 `-`：`mdx-block--bullet-list`） |
| `mdx-block--reading` / `--editing` | 与 `data-state` 同步 |
| `mdx-block__gutter` | 左簇把手区 |
| `mdx-block__body` | 内容区 |
| `mdx-placeholder` | 空块占位（`::before` 或子节点） |
| `mdx-inline` / `mdx-mark--bold` … | 行内节点 |

**class 命名规则**：BEM-ish；type 段用 **kebab-case**（`task_item` → `mdx-block--task-item`）；禁止 `flow-*`、`composer-md-*` 新前缀。

### 3.2 焦点与选区

- 阅读态：块可 `tabindex="-1"`，点击文字 → 该块 `data-state="editing"`，caret 落点由 hit-test 决定。
- 同时仅 **一个** 块处于 editing（表格例外：编辑焦点在 cell，块壳仍 `editing`）。
- Esc：退出当前块编辑 → reading；面板打开时先关面板。

---

## 4. 共享编辑交互（默认，块可覆盖）

| 操作 | 默认行为 |
|------|----------|
| Click 块内文字 | 进入 editing，caret 到点击处 |
| Click 块空白（无字） | 进入 editing，caret 在末尾或 placeholder 起点 |
| Enter（叶子块） | 在 caret 处拆分：前半保留当前块，后半新建 **同型或 paragraph**（见各块） |
| Enter（空叶子） | 多数变为 paragraph 或退出容器（见 list/quote） |
| Backspace 块首 | 与 **上一可合并块** 合并文本；容器首项特殊（见 list） |
| Backspace 空块 | 删除本块，caret 到上一块末 |
| Delete 块末 | 与下一块合并（对称） |
| 行首 `/` 或 `、` | 仅当块为空或仅触发符时打开 slash（见 `05`） |
| Mod+B/I/E | bold / italic / inline_code（有 content 的块） |

**合并规则（共享）**：

1. 仅同 `type` 且 props 兼容时可 merge 文本（heading 级别不同不 merge）。
2. `code_block`、`divider`、`table`、`image` 不与邻居「文本合并」；Backspace 在边界只删除/聚焦。
3. 合并后 `id` 保留 **前块** id。

---

## 5. 共享序列化

| 方向 | 规则 |
|------|------|
| Block[] → MD | 块间默认空行分隔（list/table 内部按 GFM）；尾部单换行 |
| MD → Block[] | 容错：未知 HTML 丢弃或降级 paragraph；不丢用户可见文本 |
| 往返 | 语义等价优先于字节等价；允许空白归一 |
| JSON 快照 | 可选；含 `id`/`type`/`props`；不替代 MD 主格式 |

扩展语法（callout、file_chip、toggle）见 `06-extensions.md`；catalog 写 **表面语法** 与 props。

---

## 6. 索引表（全部类型）

| type id | 中文名 | MD 概要 | 容器? | slash 主 id | 优先级 | 深度规格 |
|---------|--------|---------|-------|-------------|--------|----------|
| `paragraph` | 正文 | 普通段落 | 否 | `insert.paragraph` | **P0** | [paragraph.md](./blocks/paragraph.md) |
| `heading` | 标题 | `#`–`######` | 否 | `insert.heading1`…`3`（4–6 可） | **P0**（1–3）/ P1（4–6） | [heading.md](./blocks/heading.md) |
| `bullet_list` | 无序列表 | `-` / `*` | 是 | `insert.bullet_list` | **P0** | [list.md](./blocks/list.md) |
| `ordered_list` | 有序列表 | `1.` | 是 | `insert.ordered_list` | **P0** | [list.md](./blocks/list.md) |
| `list_item` | 列表项 | 缩进项 | 半 | （由 list 创建） | **P0** | [list.md](./blocks/list.md) |
| `task_list` | 任务列表 | `- [ ]` | 是 | `insert.task_list` | **P0** | [task.md](./blocks/task.md) |
| `task_item` | 任务项 | `- [x]` | 半 | （由 task_list） | **P0** | [task.md](./blocks/task.md) |
| `quote` | 引用 | `>` | 是 | `insert.quote` | **P0** | 本节 §7.1 |
| `code_block` | 代码块 | \`\`\`lang | 否 | `insert.code_block` | **P0** | [code.md](./blocks/code.md) |
| `table` | 表格 | pipe table | 是 | `insert.table` | **P0** | [table.md](./blocks/table.md) |
| `table_row` | 表行 | \|…\| | 内部 | — | **P0** | [table.md](./blocks/table.md) |
| `table_cell` | 单元格 | 格内 | 内部 | — | **P0** | [table.md](./blocks/table.md) |
| `divider` | 分隔线 | `---` | 否 | `insert.divider` | **P0** | [divider.md](./blocks/divider.md) |
| `callout` | 高亮提示 | `> [!NOTE]` 等 | 是 | `insert.callout` | **P1** | [callout.md](./blocks/callout.md) |
| `image` | 图片 | `![alt](url)` | 否 | `insert.image` | **P2** | 本节 §7.2 |
| `toggle` | 折叠 | 扩展 | 是 | `insert.toggle` | **P2** | 本节 §7.3 |
| `math_block` | 公式块 | `$$` | 否 | `insert.math` | **P2** | 本节 §7.4 |
| `embed_link` | 链接卡片 | 扩展/URL | 否 | `insert.embed_link` | **P2** | 本节 §7.5 |
| `file_chip` | 文件芯片 | 扩展 | 否 | `insert.file_chip` | **P1** | 本节 §7.6 |
| `mention` | @提及 | 扩展 inline | atom | `insert.mention` | **P2** | 本节 §7.7 |
| *(mark)* `inline_code` | 行内代码 | \`code\` | — | `toggle.inline_code` | **P0** | [code.md](./blocks/code.md) §inline |
| *(marks)* bold/italic/strike/link | 强调与链接 | GFM | — | toggle.* | **P0** | 本节 §8 |

---

## 7. 轻量类型（本目录内完整规格）

无独立深度文件时，以下即为实现契约。深度文件已存在的类型以 `blocks/*` 为准。

### 7.1 `quote` — 引用（P0）

**Markdown**

```md
> 第一行
> 第二行
```

嵌套：`>>` v1 可 flatten 为单层或保留一层嵌套 quote（实现选一层嵌套即可）。

**props**

```ts
{ } // 无必备 props
```

**DOM**

```html
<blockquote class="mdx-quote mdx-block--quote" data-block-type="quote">
  <!-- children: paragraph / list … -->
</blockquote>
```

**编辑**

| 键 | 行为 |
|----|------|
| Enter 在 quote 内非空段 | 同 paragraph 拆分，仍在 quote |
| Enter 在 quote 内 **空** paragraph | 退出 quote：空段移到 quote 后为普通 paragraph |
| Backspace 在 quote 首段首 | 解除 quote 包装，保留子段落 |

**slash**：`insert.quote`  
**placeholder**（空子段）：`引用内容`  
**序列化**：每行前 `>` + 空格；子块递归。空 quote 序列化为 `>\n` 或省略（推荐省略空容器）。

---

### 7.2 `image` — 图片（P2）

**Markdown**：`![alt](src "title")`  
**props**：`{ src: string; alt?: string; title?: string; width?: number }`  
**DOM**：`<figure class="mdx-image">` + `<img class="mdx-image__img">` + 可选 caption  
**编辑**：阅读态选中块；双击/工具条改 alt/src；无 caret 文本编辑  
**slash**：`insert.image`  
**placeholder**：`添加图片`  
**安全**：仅 http(s)/相对路径；禁 `javascript:`；缺省不加载远程跟踪参数清洗见 extensions。

---

### 7.3 `toggle` — 折叠（P2）

**扩展 MD（建议）**：

```md
<details>
<summary>标题</summary>

内容段落

</details>
```

或 `>>> 标题` 类扩展（见 `06`）。v1 实现前以 HTML details 往返。  
**props**：`{ summary: InlineNode[]; open?: boolean }`  
**DOM**：`div.mdx-toggle` > `button.mdx-toggle__summary` + `div.mdx-toggle__body`  
**slash**：`insert.toggle`  
**placeholder**：`折叠标题` / 体内 `空折叠内容`

---

### 7.4 `math_block` — 公式块（P2）

**Markdown**：

```md
$$
E = mc^2
$$
```

**props**：`{ latex: string; display: true }`  
**DOM**：`div.mdx-math`，阅读态 KaTeX/MathJax 渲染容器 `mdx-math__render`；编辑态 textarea/code  
**slash**：`insert.math`  
**placeholder**：`输入 LaTeX 公式`  
**序列化**：围栏 `$$`；行内 `$...$` 为 mark/atom，非本块。

---

### 7.5 `embed_link` — 链接卡片（P2）

**Markdown**：裸 URL 段落或扩展：

```md
@[embed](https://example.com)
```

**props**：`{ url: string; title?: string; description?: string; favicon?: string }`  
**DOM**：`a.mdx-embed` 卡片布局，左簇图标+标题  
**slash**：`insert.embed_link`  
**placeholder**：`粘贴链接`  
**降级**：无预览元数据时显示为带样式链接 paragraph。

---

### 7.6 `file_chip` — 文件芯片（P1，Conex）

打开右侧面板预览/定位工作区文件。

**扩展 MD（建议）**：

```md
[[file:path/to/foo.ts]]
```

或 `` 📎`path/to/foo.ts` `` 形态由 `06` 冻结；catalog 绑定 props。

**props**

```ts
{
  path: string;          // 工作区相对或绝对，序列化用相对
  label?: string;        // 展示名，默认 basename
  exists?: boolean;      // 运行时，不序列化
}
```

**DOM**

```html
<span class="mdx-file-chip" data-path="src/a.ts" role="button" tabindex="0">
  <span class="mdx-file-chip__icon" aria-hidden="true"></span>
  <span class="mdx-file-chip__label">a.ts</span>
</span>
```

块级也可包在 `div.mdx-block--file-chip`（单独一行芯片）。  
**交互**：Click → 宿主 `onOpenFile(path)` 开右栏；不进入文本 caret。  
**slash**：`insert.file_chip`  
**placeholder**：`选择文件`  
**序列化**：只写 path；`exists` 丢弃。路径含 `]]` 时转义或改用 HTML comment 兜底（见 extensions）。

---

### 7.7 `mention` — @提及（P2，inline atom）

**扩展**：`[@Display](user:id)` 或 `@name`  
**props**：`{ userId: string; label: string }`  
**DOM**：`span.mdx-mention` contenteditable=false  
**slash**：`insert.mention`（或 `@` 触发，属 `05`）  
**序列化**：稳定 userId；label 可变。

---

## 8. 行内 Marks（P0）

| mark | MD | class | 切换 |
|------|-----|-------|------|
| bold | `**t**` / `__t__` | `mdx-mark--bold` | `toggle.bold` / Mod+B |
| italic | `*t*` / `_t_` | `mdx-mark--italic` | `toggle.italic` / Mod+I |
| strike | `~~t~~` | `mdx-mark--strike` | `toggle.strike` |
| link | `[t](url)` | `mdx-mark--link` | `toggle.link` |
| inline_code | `` `t` `` | `mdx-mark--inline-code` | `toggle.inline_code` / Mod+E |

**边界**：code mark 内不再嵌套其他 mark；link 内可有 bold/italic；序列化优先 GFM 常见形式 `**` 而非 `__`。

---

## 9. Slash 命令 id 一览（块相关）

| command id | 插入 type | 默认 props | 触发关键词（中/英，面板用） |
|------------|-----------|------------|------------------------------|
| `insert.paragraph` | paragraph | — | 正文, 文本, text, p |
| `insert.heading1` | heading | level:1 | 标题1, h1, 大标题 |
| `insert.heading2` | heading | level:2 | 标题2, h2 |
| `insert.heading3` | heading | level:3 | 标题3, h3 |
| `insert.heading4` | heading | level:4 | 标题4, h4 |
| `insert.bullet_list` | bullet_list | 一项空 item | 无序, 列表, bullet, ul |
| `insert.ordered_list` | ordered_list | 一项 | 有序, 数字列表, ol |
| `insert.task_list` | task_list | 一项未勾选 | 任务, todo, 待办 |
| `insert.quote` | quote | 一空段 | 引用, quote |
| `insert.code_block` | code_block | lang:'' | 代码, code |
| `insert.table` | table | 3×2+header | 表格, table |
| `insert.divider` | divider | — | 分割线, 分隔, hr |
| `insert.callout` | callout | kind:note | 提示, callout, 注意 |
| `insert.image` | image | src:'' | 图片, image |
| `insert.toggle` | toggle | — | 折叠, toggle |
| `insert.math` | math_block | — | 公式, math, latex |
| `insert.embed_link` | embed_link | — | 嵌入, 卡片, embed |
| `insert.file_chip` | file_chip | path:'' | 文件, 附件, file |
| `insert.mention` | mention | — | 提及, mention |

面板 UI / 分组 / `、` 触发细节 → `05-slash-commands.md`。

---

## 10. 空态 placeholder（中文产品文案）

| type | placeholder |
|------|-------------|
| paragraph | `输入正文，或键入 / 打开命令` |
| heading level 1–6 | `标题` / `二级标题` / `三级标题` … |
| list_item | `列表项` |
| task_item | `待办事项` |
| quote 内段 | `引用内容` |
| code_block | `编写代码` |
| table_cell | （空，无占位字以免乱表） |
| callout 体 | `提示内容` |
| divider | （无文本） |
| image | `添加图片` |
| file_chip | `选择文件` |
| math_block | `输入 LaTeX 公式` |
| toggle summary | `折叠标题` |
| embed_link | `粘贴链接` |

显示：仅 **空 content 且 editing 或 hover** 时显示 `mdx-placeholder`；灰色、不进序列化、不进选区复制纯文本（复制为空或块结构）。

---

## 11. 注册表接口（实现锚点）

```ts
interface BlockTypeDef {
  type: BlockTypeId;
  propsSchema: JSONSchema | ZodLike;
  parse: (ctx: ParseCtx) => Block | Block[] | null;
  serialize: (block: Block, ctx: SerializeCtx) => string;
  renderReading: (block: Block, ctx: RenderCtx) => HTMLElement;
  renderEditing: (block: Block, ctx: EditCtx) => HTMLElement;
  onKeyDown?: (e: KeyboardEvent, ctx: EditCtx) => boolean; // true = handled
  slash?: { id: string; keywords: string[]; insert: (ctx) => Block };
  canMergeWith?: (a: Block, b: Block) => boolean;
  isAtom?: boolean; // divider/image/file_chip：无文本 caret
  priority: 'P0' | 'P1' | 'P2';
}
```

---

## 12. a11y（共享）

- 块壳：`role` 按语义（heading → 原生 `h1`–`h6`；list → `ul`/`ol`；separator → `hr`/`role="separator"`）。
- 编辑态：焦点在可编辑表面；读屏名可用 `aria-label` 补中文块名。
- 占位符：`aria-hidden="true"` 或 `aria-placeholder`（二者择一，全编辑器统一）。
- 表格：真实 `<table>` / `th`/`td` + `scope`。

---

## 13. 测试点（目录级）

1. 每种 P0 块：MD → Block → MD 语义往返（fixture 集）。  
2. slash 插入每个 P0 command id 后文档结构正确。  
3. Enter/Backspace 跨块矩阵（paragraph↔heading、list 进出、空块删除）。  
4. 表格 Tab/Shift+Tab、增行增列、header 序列化。  
5. class 前缀无 `flow-` 泄漏；无 `innerHTML` 全量刷新路径（架构约束）。  
6. 中文 placeholder 与 `/`、`、` 触发不破坏 IME。

---

## 14. 分期

| 期 | 范围 |
|----|------|
| **v1 / P0** | paragraph, heading(1–3), bullet/ordered list + item, task list + item, quote, code_block, inline marks, table(+row/cell), divider |
| **v1.1 / P1** | heading 4–6, callout, file_chip, 表格列宽记忆（可选） |
| **v2 / P2** | image 完善, toggle, math, embed_link, mention, 合并单元格 |

---

## 15. 修订

| 版本 | 日期 | 说明 |
|------|------|------|
| 0.1 | 2026-08-02 | 首版目录 + 共享契约；深度文件拆出 |
