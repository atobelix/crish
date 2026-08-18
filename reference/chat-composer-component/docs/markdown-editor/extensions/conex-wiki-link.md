# Extension: `conex.wiki_link` — `[[doc:…]]` 文档链接（流兼容）

> 索引：[06-extensions.md](../06-extensions.md)  
> 宿主：[08-integration.md](../08-integration.md) · 对话流 artifact / Notebook  
> **优先级**：P1（兼容现网 demo / 文案）  
> **meta.id**：`conex.wiki_link`  
> **形态**：行内 atom  

---

## 1. 目标 / 非目标

### 目标

- 兼容对话流与 demo 中已出现的 **`[[doc:标题]]`** 写法（例：`[[doc:重构变更摘要.md]]`）。  
- 阅读态渲染为可点击 wiki chip；点击 → **`onOpenPath(target, { kind: 'wiki-link' })`**，由宿主解析为：  
  - 已有 artifact / `docStore` 文档 → 打开 **Notebook**  
  - 或工作区文档路径 → 打开编辑器/侧栏  
- Markdown 可往返；非 Conex 环境可降级为普通链接或纯文本标题。

### 非目标

- 完整 Obsidian 双链图谱 / 反链面板。  
- 任意 `[[自由标题]]` 无前缀协议（v1 **要求** `doc:` 或显式 kind，避免与将来扩展冲突）。  
- 块级「嵌入全文」（见 `conex.embed` P2）。

---

## 2. 与 file_chip / 流 的分工

| 语法 | 含义 | 回调 kind | 典型宿主行为 |
|------|------|-----------|--------------|
| `[[file:path/to.ts]]` | 工作区 **源码/文件** | `file-chip` | 右侧 Files 面板 |
| `[[doc:重构变更摘要.md]]` | **文档类** artifact / 笔记标题 | `wiki-link` | Notebook 浮层 / 文档 store |
| 普通 `[t](url)` | URL 或相对 md | `md-link`（修饰键可选） | 浏览器或预览 |

**产品铁律**（CONVERSATION_FLOW_SPEC §5.5）：源码 path 不进 Notebook；`doc:` 才是生成文档入口语义。

---

## 3. 语法

### 3.1 规范形式

```md
完整报告见 [[doc:重构变更摘要.md]]。
```

### 3.2 显示名

```md
见 [[doc:重构变更摘要.md|变更摘要]]。
```

### 3.3 文法

```
wiki-link ::= "[[" kind ":" target ( "|" label )? "]]"
kind      ::= "doc" | "ref"     ; v1 主用 doc；ref 预留锚点/稳定 id
target    ::= 非 "]" 非 "|" 字符，trim 非空，长度 ≤ 256
label     ::= 非 "]" 字符，trim
```

**kind 大小写**：解析不敏感，序列化 **小写** `doc` / `ref`。

### 3.4 明确不支持（v1）

| 写法 | 处理 |
|------|------|
| `[[无前缀标题]]` | 纯文本（或 P2 再开） |
| `[[Doc:x]]` | 可接受为 doc（大小写不敏感） |
| `[[file:…]]` | 归 file_chip，非本扩展 |
| `[[doc:]]` 空 target | 不匹配 |

---

## 4. 数据形状

```ts
interface WikiLinkInline {
  type: 'wiki_link';
  kind: 'doc' | 'ref';
  target: string;   // 标题或文档键，如「重构变更摘要.md」
  label?: string;   // 展示；默认 target
}

// 不单独建块类型；始终行内 atom
// 宿主 OpenPathMeta:
// { kind: 'wiki-link', sourceBlockId?: string }
```

**target 语义（宿主约定，编辑器不强制）**：

| 约定 | 说明 |
|------|------|
| 等于 artifact title | `NotebookPanel.open(title)` / `docStore[title]` |
| 等于 `title.md` | 可与 store 键互相同一化（去 `.md` 再查） |
| `ref:` | 稳定 id（P2）；v1 可当 target 字面打开失败则 toast |

---

## 5. parseInline / serialize

### 5.1 解析（I3，在 `file:` 之后尝试）

```ts
function parseWikiLink(ctx: InlineParseContext) {
  const s = ctx.text;
  const i = ctx.offset;
  if (s.slice(i, i + 2) !== '[[') return null;
  // 快速排除 file:
  if (s.slice(i, i + 7) === '[[file:') return null;
  const close = s.indexOf(']]', i + 2);
  if (close < 0) return null;
  const inner = s.slice(i + 2, close);
  const m = inner.match(/^(doc|ref)\s*:\s*([^|]+?)(?:\|(.*))?$/i);
  if (!m) return null;
  const kind = m[1].toLowerCase() as 'doc' | 'ref';
  const target = m[2].trim();
  if (!target) return null;
  let label = m[3] != null ? m[3].trim() : undefined;
  if (label === '') label = undefined;
  return {
    node: { type: 'wiki_link', kind, target, label },
    consumed: close + 2 - i,
  };
}
```

### 5.2 序列化

```ts
function serializeWikiLink(n: WikiLinkInline, ctx: SerializeContext): string {
  const kind = n.kind || 'doc';
  const target = n.target.trim();
  if (ctx.mode === 'pure-gfm') {
    const text = n.label || target;
    // 无稳定 URL：用标题文本；可选 fragment
    return text; // 或 `[${text}](#doc=${encodeURIComponent(target)})`
  }
  if (n.label && n.label !== target) {
    return `[[${kind}:${target}|${n.label}]]`;
  }
  return `[[${kind}:${target}]]`;
}
```

**pure-gfm 推荐**：默认 **纯文本 label/target**（最不误导）；若宿主已知导出站点，可配置为 markdown link。

### 5.3 ExtensionSpec

```ts
const conexWikiLink: InlineExtension = {
  meta: {
    id: 'conex.wiki_link',
    syntaxVersion: 1,
    priority: 'P1',
    enabledByDefault: true,
    degrade: 'plain-or-md-link',
  },
  atoms: ['wiki_link'],
  parseInline: parseWikiLink,
  serializeInline: serializeWikiLink,
  openPathKind: 'wiki-link',
  slash: {
    id: 'insert.wiki_link',
    title: '文档链接',
    keywords: ['文档', 'wiki', '双链', 'doc', '笔记', 'artifact'],
    group: 'Conex',
    insert: () => ({
      type: 'paragraph',
      content: [{ type: 'wiki_link', kind: 'doc', target: '', label: undefined }],
    }),
  },
};
```

空 target：不写盘；与 file_chip 相同策略。

---

## 6. 交互

| 操作 | 行为 |
|------|------|
| Click / Enter | `onOpenPath(target, { kind: 'wiki-link', sourceBlockId })` |
| 宿主解析成功 | 打开 Notebook 至该 title；可选滚动到顶部 |
| 宿主解析失败 | toast「未找到文档：{target}」；不抛错 |
| 编辑态 | 不可 contenteditable 内部字符；整粒删除；双击 popover 改 target/label |
| 与 IME | 输入 `[[` 不自动抢；以 parse 结果为准 |
| slash | 插入 atom 后弹出 target 输入（可搜索 docStore keys） |

**状态机（点击）**：

```
click wiki_link
  → host.onOpenPath(target, wiki-link)
      → resolveDoc(target)
           ├─ hit → Notebook.open(title, content)
           └─ miss → toast
```

---

## 7. 阅读 DOM

```html
<span class="mdx-wiki-link" data-wiki-kind="doc"
      data-wiki-target="重构变更摘要.md"
      role="link" tabindex="0"
      aria-label="打开文档 重构变更摘要.md">
  <span class="mdx-wiki-link__icon" aria-hidden="true"></span>
  <span class="mdx-wiki-link__label">重构变更摘要.md</span>
</span>
```

| class | 用途 |
|-------|------|
| `mdx-wiki-link` | 根 |
| `mdx-wiki-link--missing` | 宿主标记未找到 |
| `mdx-wiki-link__icon` | 文档图标（与 file 区分） |
| `mdx-wiki-link__label` | 显示文字 |

**视觉**：与 file_chip 同族 chip，但图标/色相区分「文档 vs 源码」（token 见 07）。

---

## 8. 边界情况

| 情况 | 处理 |
|------|------|
| demo 原文 `[[doc:重构变更摘要.md]]` | 必须解析 |
| target 含空格/中文 | 允许 |
| target 含 `\|` | 仅首 pipe 分 label |
| `[[doc:a]]` 在 code 内 | 不解析 |
| 与 `[[file:` 前缀冲突 | file 优先 |
| 超长 target | 256 截断 |
| 标题与 path 都叫 `x.md` | kind 区分行为 |
| 导出 pure | 无 `[[` 残留（纯文本） |

---

## 9. a11y

- `role="link"` + 键盘激活。  
- `aria-label`：`打开文档 {label或target}`。  
- missing：`无法打开文档：{target}`。  
- 与 file_chip 读屏文案必须可区分（「文档」vs「文件」）。

---

## 10. 安全

- target/label → textContent。  
- 不把 target 当 `javascript:` URL 执行。  
- 宿主打开前校验：仅允许应用内文档键 / 工作区相对 md；拒绝绝对 URL 伪装（若 target 像 `https://`，可当外链走 md-link 策略或拒绝）。  
- **锁定**：`doc:` target 若匹配 `^[a-zA-Z][a-zA-Z0-9+.-]*:` 协议形，**拒绝 onOpenPath**，显示 blocked。

---

## 11. 测试点

1. RT-W01：与 demo-data 字符串往返。  
2. RT-W02：label 往返。  
3. click → `kind: 'wiki-link'`。  
4. file 与 doc 前缀互不误伤。  
5. code 内不解析。  
6. pure-gfm 无 `[[`。  
7. 空 target 不序列化。  
8. 协议形 target 拒绝打开。  
9. 键盘可达。  
10. missing class 可由宿主 API 回写。

---

## 12. 分期

| 项 | 期 |
|----|-----|
| `[[doc:]]` 解析/序列化/渲染/onOpenPath | P1 |
| slash + docStore 搜索 | P1 |
| `[[ref:]]` | P2 |
| 无前缀 `[[title]]` | P2 可选 |
| 反链面板 | 非目标 |

---

## 13. 修订

| 版本 | 日期 | 说明 |
|------|------|------|
| 0.1 | 2026-08-02 | 对齐流 demo `[[doc:]]` 与 onOpenPath |
