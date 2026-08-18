# Extension: `conex.callout` — 高亮提示块

> 索引：[06-extensions.md](../06-extensions.md)  
> 块规格：[blocks/callout.md](../blocks/callout.md)（交互/DOM 以块文为准；本文冻结 **扩展语法与往返**）  
> **优先级**：P1  
> **meta.id**：`conex.callout`  
> **blockType**：`callout`

---

## 1. 目标 / 非目标

### 目标

- 支持 GitHub Alerts 兼容语法与 `:::` 容器解析。  
- 序列化默认写回 `> [!KIND]`，保证 GH / 外站可读。  
- 与普通 `quote` 严格区分；kind/title/children 可往返。

### 非目标

- 折叠 callout（用 toggle P2）。  
- 任意 HTML / 自定义 CSS 注入。  
- 容器多层嵌套容器。

---

## 2. 语法

### 2.1 主形式（序列化标准）

```md
> [!NOTE]
> 默认说明文案

> [!TIP] 小窍门
> 正文第一段
>
> 正文第二段

> [!WARNING]
> - 列表项一
> - 列表项二
```

**首行文法**：

```
callout-open ::= ">" ws* "[!" KIND "]" ( ws+ TITLE )? ws*
KIND         ::= [A-Za-z][A-Za-z0-9_-]{0,31}
TITLE        ::= 非换行字符（trim 后可空则无 title）
body-line    ::= ">" ws? BODY?
```

`KIND` 大小写不敏感；**序列化输出大写**（`NOTE`…）。

### 2.2 兼容解析：`:::` 容器

```md
::: warning 注意磁盘
清理前请备份
:::
```

见 [06-extensions.md](../06-extensions.md) §5.2。  
**parse 入 callout**；**serialize 默认不输出 `:::`**。

### 2.3 非 callout

```md
> 普通引用
> 第二行
```

→ `quote`，不是 callout。

```md
> [!NOTE]仅粘在一起无空格标题？
```

- `[!NOTE]` 后无空格且后随非空白：整段可当 title 或 kind 行无 title + 同行剩余当正文——**锁定：`]` 后可选空格再 title；同行剩余若无空格分隔则视为 title 全文**。  
  例：`> [!NOTE]标题` → title=`标题`。

---

## 3. 数据形状

```ts
type CalloutKind =
  | 'note'
  | 'tip'
  | 'important'
  | 'warning'
  | 'caution'
  | 'success'
  | string;

interface CalloutProps {
  kind: CalloutKind;   // 小写存储
  title?: string;      // 用户自定义；无则 UI 用默认中文标签
}

interface CalloutBlock {
  id: string;
  type: 'callout';
  props: CalloutProps;
  /** 子块：paragraph / list…；引擎若扁平则用 indent 约定，语义等价 */
  children?: Block[];
  // 扁平引擎备选：
  // runs?: TextRun[]; // 单块多行，不推荐新实现
}
```

**kind → 默认中文标题**（仅 UI，不进 MD 除非用户写入 title）：

| kind | 中文 |
|------|------|
| note | 说明 |
| tip | 提示 |
| important | 重要 |
| warning | 警告 |
| caution | 注意 |
| success | 成功 |

**KIND 别名（解析）**：

| 输入 | 归一 |
|------|------|
| info | note |
| warn | warning |
| danger | caution |
| ok | success |

---

## 4. parse / serialize

### 4.1 `parse`（token 阶段）

```ts
function parseCallout(ctx: ParseContext) {
  const t = ctx.tokens[ctx.index];
  if (t.kind !== 'quote' && t.kind !== 'callout') return null;
  // tokenize 已把 Alert 识别为 kind:'callout' 更佳
  const body = stripOneLevelGt(t.raw);
  const lines = body.split('\n');
  const m = lines[0].match(/^\[!([A-Za-z][A-Za-z0-9_-]*)\](?:\s+(.*))?$/);
  if (!m) return null;
  const kind = normalizeKind(m[1]);
  const title = m[2]?.trim() || undefined;
  const rest = lines.slice(1).join('\n');
  const children = rest.trim()
    ? fromMarkdown(rest, ctx.registry).blocks
    : [emptyParagraph()];
  return {
    block: { id: newId(), type: 'callout', props: { kind, title }, children },
    consumed: 1,
  };
}
```

`:::` 在 **lineRule / tokenize** 产出与上相同结构。

### 4.2 `serialize`

```ts
function serializeCallout(block: CalloutBlock, ctx: SerializeContext): string {
  const kind = String(block.props.kind || 'note').toUpperCase();
  const title = block.props.title?.trim();
  const head = title ? `> [!${kind}] ${title}` : `> [!${kind}]`;
  const inner = ctx.serializeChildren?.(block.children || []) || '';
  const body = inner
    .split('\n')
    .map((ln) => (ln === '' ? '>' : `> ${ln}`))
    .join('\n');
  return body ? `${head}\n${body}` : head;
}
```

**pure-gfm 模式**（无 Alert 时）：

```md
> **警告：** 自定义标题
> 正文
```

`export.calloutStyle === 'bold-prefix'` 时启用。

### 4.3 ExtensionSpec 摘要

```ts
const conexCallout: BlockExtension = {
  meta: {
    id: 'conex.callout',
    syntaxVersion: 1,
    priority: 'P1',
    enabledByDefault: true,
    degrade: 'github-alert',
  },
  blockType: 'callout',
  parse: parseCallout,
  parseLine: parseContainerLine, // :::
  serialize: serializeCallout,
  slash: {
    id: 'insert.callout',
    title: '提示块',
    keywords: ['提示', 'callout', '注意', '警告', 'warning', 'tip', 'note'],
    group: '基础',
    insert: () => ({
      type: 'callout',
      props: { kind: 'note' },
      children: [{ type: 'paragraph', content: [] }],
    }),
  },
  theme: {
    blockClass: 'mdx-callout',
    kindModifier: (k) => `mdx-callout--${k}`,
  },
};
```

---

## 5. 交互

详见 [blocks/callout.md](../blocks/callout.md) §6。摘要：

| 操作 | 行为 |
|------|------|
| slash `insert.callout` | 插入 note + 空段 |
| 变体 slash | `insert.callout_warning` 等改 kind |
| Enter 空段 | 退出 callout |
| Backspace 首段首 | 解除为 paragraph 们 |
| kind 菜单 | 改 props.kind，保留 children |

---

## 6. 阅读 DOM（契约）

```html
<aside class="mdx-callout mdx-callout--tip" data-callout-kind="tip" role="note">
  <div class="mdx-callout__header">
    <span class="mdx-callout__icon" aria-hidden="true"></span>
    <span class="mdx-callout__title">提示</span>
  </div>
  <div class="mdx-callout__content"><!-- children --></div>
</aside>
```

色板 → `07`；禁止仅靠颜色区分 warning。

---

## 7. 边界情况

| 情况 | 处理 |
|------|------|
| 未知 `[!FOO]` | `kind: 'foo'`，样式 fallback note |
| 空 body | 保留一空 paragraph；serialize 可只写 head + `>` |
| callout 内 table | P2；v1 可当文本行或有限支持 |
| 与 quote 相邻 | 不自动合并 |
| SUCCESS 在 GH | 外站可能当未知 alert；仍可读 body |
| 中文 title | 允许 |
| kind 超长 | 截断 32 |

---

## 8. a11y

- `role="note"`；caution/warning 不强制 `alert`（避免打断读屏）。  
- 可访问名：`{title或默认中文}：{首段预览}`。  
- 图标装饰性隐藏。

---

## 9. 安全

- children 走统一 sanitize。  
- title 纯文本，禁止 HTML。  
- 无用户 URL 字段。

---

## 10. 测试点

1. 五种 GH kind + SUCCESS 往返。  
2. 自定义 title 往返。  
3. `::: tip 标题\n正文\n:::` → serialize 为 Alert。  
4. 普通 `>` 不变 callout。  
5. 多段 + 列表子结构。  
6. slash 默认 note。  
7. pure-gfm bold-prefix 无 `[!`。  
8. 别名 info→note。

---

## 11. 分期

| 项 | 期 |
|----|-----|
| Alert 解析/序列化 + 子段 | P1 |
| `:::` 解析 | P1 |
| success / 别名 | P1 |
| 块内 table | P2 |
| 折叠 | 不做（toggle） |

---

## 12. 修订

| 版本 | 日期 | 说明 |
|------|------|------|
| 0.1 | 2026-08-02 | 语法与往返冻结；DOM/交互引用 blocks/callout |
