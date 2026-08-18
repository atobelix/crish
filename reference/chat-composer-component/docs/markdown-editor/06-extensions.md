# 06 — Markdown 扩展：架构、兼容、目录

> **角色**：Conex 块编辑器在 **GFM 之上** 的扩展语法总规；单扩展深度见 [`extensions/`](./extensions/)。  
> **不写**：视觉 token 全集（见 [`07-visual-system.md`](./07-visual-system.md)）、DnD 物理、slash 面板 UI 细节。  
> **读者**：Parser/Serializer 实现 agent、块注册表作者、宿主集成。  
> **关联**：[01-architecture](./01-architecture.md) · [02-block-catalog](./02-block-catalog.md) · [08-integration](./08-integration.md) · [blocks/callout](./blocks/callout.md)

---

## 1. 目标 / 非目标

### 目标

1. 定义 **扩展插件接口**（块级 `parse` / 行内 `parseInline` / `serialize` / 可选 `slash` / `theme`），与 `BlockRegistry` 对齐。  
2. 冻结 **解析优先级** 与 **语法版本**，避免扩展互相抢 token。  
3. 保证 **非 Conex 阅读器可降级**：导出的 Markdown 在 GitHub / VS Code / 普通 MD 预览中仍可读（语义不丢或弱化为标准结构）。  
4. 给出 **安全边界**（协议、路径、HTML、围栏语言）。  
5. 建立 **往返测试矩阵**（L0 语义必达）。  
6. 索引全部 Conex 扩展与 P2 预留（math / mermaid / footnotes / embed）。

### 非目标

| 非目标 | 说明 |
|--------|------|
| 完整 CommonMark 合规证明 | 以 GFM 实用子集 + 可测往返为准 |
| 任意用户自定义 HTML 块 | 安全禁令；仅白名单容器 |
| 协同冲突合并 | 非 v1 |
| 插件运行时热加载远程脚本 | 扩展为编译期/启动期注册 |
| 视觉皮肤全集 | 只定义 class 钩子名 |

---

## 2. 设计原则

| # | 原则 | 含义 |
|---|------|------|
| E1 | **Markdown 为序列化主格式** | 内存是 `Block[]`；落盘/剪贴板/autosave 为 MD |
| E2 | **可往返** | Conex → MD → Conex 语义相等（忽略 runtime id / exists 等） |
| E3 | **优雅降级** | 外站打开时，扩展块变成「仍可读」的 GFM/HTML 子集，不出现裸控制字符墙 |
| E4 | **安全默认拒绝** | 未知协议、脚本、危险路径不渲染为可执行面 |
| E5 | **优先级显式** | 围栏 > 表 > 列表…；扩展块解析插入固定档位 |
| E6 | **版本可演进** | 语法带 `syntaxVersion`；旧文档可识别、新字段可忽略 |
| E7 | **注册表扩展** | 新语法 = 一项 `ExtensionSpec`，禁止核心 `if-else` 巨石 |

---

## 3. 扩展接口（实现契约）

与 [01-architecture](./01-architecture.md) 的 `BlockTypeSpec` / `parseInline` 对齐；扩展层再包一层元数据。

```ts
/** 语法版本：写在文档 frontmatter 或引擎默认 */
type ConexMdSyntaxVersion = 1; // v1 冻结本文件所列

interface ExtensionMeta {
  id: string;                 // 如 'conex.callout'
  syntaxVersion: ConexMdSyntaxVersion;
  /** 产品分期 */
  priority: 'P0' | 'P1' | 'P2';
  /** 是否默认启用 */
  enabledByDefault: boolean;
  /** 导出纯 MD 时的降级策略 id */
  degrade: DegradeStrategyId;
}

/**
 * 块级扩展：消费 token 流或原始行窗口
 * 对应 BlockTypeSpec.parse / serialize
 */
interface BlockExtension {
  meta: ExtensionMeta;
  /** 绑定的 BlockTypeId；无则纯行内扩展 */
  blockType?: BlockTypeId;
  /**
   * 块级解析：从 ctx.tokens[ctx.index] 起尝试。
   * 成功返回 block + 消费 token 数；失败返回 null（不改 index）。
   */
  parse?: (ctx: ParseContext) => { block: Block; consumed: number } | null;
  /**
   * 行驱动备用入口（多行容器如 ::: / $$）。
   * 在 tokenize 阶段也可注册 lineRule；二选一或并存时 lineRule 先产出 token。
   */
  parseLine?: (ctx: LineParseContext) => LineParseResult | null;
  serialize: (block: Block, ctx: SerializeContext) => string;
  /** 可选 slash 插入（详细 UI 见 05） */
  slash?: {
    id: string;
    title: string;
    keywords: string[];
    group?: string;
    insert: (ctx: SlashInsertContext) => Block | Block[];
  };
  /** 主题钩子：class / data-* 前缀，具体色值见 07 */
  theme?: {
    blockClass: string;           // e.g. 'mdx-callout'
    kindModifier?: (kind: string) => string; // → 'mdx-callout--warning'
  };
  /** 渲染留给 BlockViews；扩展可提供默认 render 工厂 */
  renderReading?: BlockTypeSpec['render'];
  edit?: BlockTypeSpec['edit'];
  isVoid?: boolean;
}

/**
 * 行内扩展：在 parseInline 管道中按优先级扫描
 */
interface InlineExtension {
  meta: ExtensionMeta;
  /** 产生的 inline node / mark 类型 */
  marks?: Array<'bold' | 'italic' | 'strike' | 'link' | 'inline_code' | string>;
  atoms?: Array<'file_chip' | 'wiki_link' | 'mention' | 'hard_break' | string>;
  /**
   * 从 offset 起匹配；返回 node + 消费字符数。
   * 禁止跨越 code span 已锁定区间。
   */
  parseInline: (ctx: InlineParseContext) => { node: InlineNode; consumed: number } | null;
  serializeInline: (node: InlineNode, ctx: SerializeContext) => string;
  /** 点击等宿主回调类型提示 */
  openPathKind?: 'file-chip' | 'wiki-link' | 'md-link';
}

type ExtensionSpec = BlockExtension | InlineExtension | (BlockExtension & InlineExtension);

interface ParseContext {
  tokens: BlockToken[];
  index: number;
  parseInline: (text: string) => InlineNode[];
  syntaxVersion: ConexMdSyntaxVersion;
  features: EditorFeatureFlags;
}

interface LineParseContext {
  lines: string[];
  index: number;
  /** 是否已在 fence 内（true 时大多数规则禁用） */
  inFence: boolean;
  syntaxVersion: ConexMdSyntaxVersion;
}

type LineParseResult =
  | { kind: 'token'; token: BlockToken; consumedLines: number }
  | { kind: 'block'; block: Block; consumedLines: number };

interface InlineParseContext {
  text: string;
  offset: number;
  /** 已被更高优规则锁定的 [start,end) 区间 */
  locked: Array<{ start: number; end: number }>;
  syntaxVersion: ConexMdSyntaxVersion;
}

interface SerializeContext {
  serializeInline: (nodes: InlineNode[]) => string;
  serializeChildren?: (blocks: Block[]) => string;
  prev?: Block | null;
  next?: Block | null;
  /** pure | conex：导出模式 */
  mode: 'conex' | 'pure-gfm';
  syntaxVersion: ConexMdSyntaxVersion;
}

interface EditorFeatureFlags {
  gfm: boolean;              // 默认 true
  callout: boolean;          // P1 默认 true
  fileChip: boolean;         // P1 默认 true
  wikiLink: boolean;         // P1 默认 true（流兼容）
  embed: boolean;            // P2 默认 false
  math: boolean;             // P2 默认 false
  mermaid: boolean;          // P2 默认 false
  footnotes: boolean;        // P2 默认 false
  autolink: boolean;         // 默认 true
  containerFence: boolean;   // ::: 容器；P1 解析可选，默认 true 只读 / serialize 优先 GH alert
}
```

### 3.1 注册

```ts
function registerExtension(registry: BlockRegistry, ext: ExtensionSpec): void {
  // 1) meta.id 唯一
  // 2) 若有 blockType → registry.registerBlockType({...})
  // 3) 若有 parseInline → inlinePipeline.insert(ext.meta.priorityBand, ext)
  // 4) feature flag 关闭则 skip parse，仍可 serialize 已有块（防丢数据）
}
```

**启动默认集（Notebook）**：

```
P0: gfm-baseline（内置，非「扩展包」但本文件约束）
P1: conex-callout, conex-file-chip, conex-wiki-link
P2: conex-embed, math, mermaid, footnotes（flag 关）
```

---

## 4. 解析优先级（硬顺序）

### 4.1 块级 tokenize（行扫描）

自上而下 **先匹配者胜**；进入某规则后消费完整多行结构，禁止半截泄漏。

| 档位 | 规则 | 识别摘要 | 产出 |
|------|------|----------|------|
| **B0** | 缩进/围栏代码 | 行首 \`\`\` / ~~~ 或 4 空格代码（v1 可仅 fence） | `fence` |
| **B1** | 数学显示块（P2） | 独占行 `$$` … `$$` | `math_block` / fence 特例 |
| **B2** | 自定义容器（P1 解析） | 行首 `::: kind` … `:::` | `callout` 等 |
| **B3** | 表格 | 含 `\|` 的表头 + 分隔行 `---` | `table` |
| **B4** | 标题 | `#{1,6} ` | `heading` |
| **B5** | 分隔线 | `---` / `***` / `___`（整行） | `hr` |
| **B6** | 引用 / Callout | 行首 `>`；首内容行匹配 `[!KIND]` → callout，否则 quote | `callout` / `quote` |
| **B7** | 列表 / 任务 | `[-*+] ` / `\d+. ` / `- [ ]` | `list_item` |
| **B8** | 块级 wiki/file 独占行（可选） | 整行仅 `[[file:…]]` 或 `[[doc:…]]` | `file_chip` / wiki 段 |
| **B9** | 段落 | 其余非空行合并至空行 | `paragraph` |
| **B10** | 空行 | | `blank`（丢弃或作分隔） |

**铁律**：

1. **围栏内**（B0 开启至闭合）：禁止 B1–B9 解释；内容原样。  
2. **表格** 优先于「带 `|` 的段落」。  
3. **任务列表** 是 list 的特化：`- [ ]` / `- [x]` 在 B7 内优先于普通 bullet。  
4. **Callout vs Quote**：仅当引用块 **第一有效内容行** 匹配 `^\s*\[!([A-Za-z0-9_-]+)\](\s+.*)?$` 时升级为 callout。  
5. 扩展 `parse` 在 token 映射阶段按 **注册 order** 尝试，但 **不得** 绕过 B0 围栏锁定。

### 4.2 行内 parseInline 管道

对段落/标题/表单元格/列表项文本做线性扫描。  
**锁定顺序**（先锁定区间，后填剩余 text）：

| 档位 | 规则 | 模式摘要 |
|------|------|----------|
| **I0** | 行内代码 | `` `...` ``（可 `` ` `` 转义策略见 gfm-baseline） |
| **I1** | 自动链接 `<...>` | `<http://…>` / `<mailto:…>` / `<user@host>` |
| **I2** | 显式链接 / 图片 | `[text](url)` / `![alt](src)` |
| **I3** | Conex wiki / file atom | `[[file:path]]` / `[[doc:title]]` / `[[doc:title\|label]]` |
| **I4** | 强调 | `**` / `*` / `__` / `_` / `~~`（嵌套规则见 gfm-baseline） |
| **I5** | 裸 URL autolink（可选） | `https?://…` 词边界 |
| **I6** | 裸 email autolink（可选） | 简化 RFC；见 §9 |
| **I7** | 纯文本 | 剩余字符 |

**铁律**：

- I0 锁定区内 **禁止** 再解析 wiki/强调。  
- file/wiki atom 失败（非法字符）→ 退化为纯文本，不吞后续。  
- 链接 `javascript:` 等 → 见 §7 安全：解析可保留文本，**不**生成可点击危险 href。

### 4.3 伪代码：块扫描

```ts
function tokenizeBlocks(lines: string[]): BlockToken[] {
  const tokens: BlockToken[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isFenceOpen(lines[i])) {
      const { token, end } = takeFence(lines, i); // B0
      tokens.push(token);
      i = end;
      continue;
    }
    if (features.math && isDollarDollarOpen(lines[i])) { /* B1 P2 */ }
    if (features.containerFence && /^:::\s*\S/.test(lines[i])) {
      const r = takeContainer(lines, i); // B2
      tokens.push(r.token);
      i += r.consumed;
      continue;
    }
    if (isTableStart(lines, i)) { /* B3 */ continue; }
    if (/^#{1,6}\s/.test(lines[i])) { /* B4 */ continue; }
    if (isHr(lines[i])) { /* B5 */ continue; }
    if (/^ {0,3}>/.test(lines[i])) {
      const q = takeQuoteOrCallout(lines, i); // B6
      tokens.push(q.token);
      i += q.consumed;
      continue;
    }
    if (isListItem(lines[i])) { /* B7 */ continue; }
    if (isLoneFileOrWikiLine(lines[i])) { /* B8 */ continue; }
    if (lines[i].trim() === '') { tokens.push({ kind: 'blank' }); i++; continue; }
    // B9 paragraph 合并
    const p = takeParagraph(lines, i);
    tokens.push(p.token);
    i += p.consumed;
  }
  return tokens;
}
```

---

## 5. 自定义容器（两种写法）

### 5.1 主序列化：GitHub Alert 引用式（推荐写回）

兼容 GitHub / 多数预览；与 [`blocks/callout.md`](./blocks/callout.md) 一致。

```md
> [!TIP] 可选标题
> 第一段
>
> - 列表也可
```

| kind（大小写不敏感，序列化大写） | 语义 |
|----------------------------------|------|
| `NOTE` | 说明 |
| `TIP` | 提示 |
| `IMPORTANT` | 重要 |
| `WARNING` | 警告 |
| `CAUTION` | 危险/注意 |
| `SUCCESS` | Conex 扩展；纯 GH 模式可映射 `TIP` |

**解析**：

```
连续 > 行 → 去掉一级 > 前缀得到 bodyLines
bodyLines[0] 匹配 [!KIND] optionalTitle
  → type=callout, props.kind=lower(KIND), props.title?
  → 其余 body 再 parse 为 children（paragraph/list…）
否则 → type=quote
```

### 5.2 兼容解析：`:::` 围栏容器

便于从 VuePress / some MD 生态粘贴；**默认 serialize 不写 `:::`，写回 Alert 式**（除非 `features.preferContainerFence`）。

```md
::: tip 标题
content

多段也可
:::
```

**语法**

```
open  ::= "::: " kind ( " " title )?   |  ":::" kind
kind  ::= [a-zA-Z][a-zA-Z0-9_-]*
close ::= ":::"  (整行，可前后空白)
```

| 输入 kind | 映射 callout.kind |
|-----------|-------------------|
| tip / TIP | tip |
| note / info | note |
| warning / warn | warning |
| danger / caution | caution |
| important | important |
| success / ok | success |
| 未知 | 保留小写字符串；主题 fallback `note` 样式 |

**边界**：

- `:::` 出现在 fence 代码内 → 不解释。  
- 未闭合 `:::` → 从 open 起到 EOF 视为容器 body；serialize 时补闭合 Alert 式（不输出残缺 `:::`）。  
- 容器内可嵌套 GFM，**v1 不支持** 容器嵌套容器。

### 5.3 降级（pure-gfm 导出）

| mode | 输出 |
|------|------|
| `conex` | `> [!TIP] 标题` + body |
| `pure-gfm` | 同 Alert（GH 已支持）或退化为：`> **提示：** 标题\n> body`（无 Alert 的阅读器） |

配置 `export.calloutStyle: 'github-alert' | 'bold-prefix'`。

---

## 6. 扩展目录（索引）

| 扩展 id | 文档 | 类型 | 分期 | 默认 |
|---------|------|------|------|------|
| `gfm.baseline` | [gfm-baseline.md](./extensions/gfm-baseline.md) | 内置子集 | P0 | 开 |
| `conex.callout` | [conex-callout.md](./extensions/conex-callout.md) | 块 | P1 | 开 |
| `conex.file_chip` | [conex-file-chip.md](./extensions/conex-file-chip.md) | 行内 atom + 可独占块 | P1 | 开 |
| `conex.wiki_link` | [conex-wiki-link.md](./extensions/conex-wiki-link.md) | 行内 atom | P1 | 开 |
| `conex.embed` | [conex-embed.md](./extensions/conex-embed.md) | 块 | P2 | 关 |
| `conex.math` | （本节 §8，无独立文件） | 块 + 行内 | P2 | 关 |
| `conex.mermaid` | （本节 §8） | fence 语言 | P2 | 关 |
| `conex.footnotes` | （本节 §8） | 块 + 行内 | P2 | 关 |

---

## 7. 安全

### 7.1 链接与协议

| 场景 | 允许 | 拒绝 |
|------|------|------|
| MD 链接 / 图片 src | `http:` `https:` `mailto:` 相对路径 `/` `./` `../` | `javascript:` `vbscript:` `data:text/html` |
| `data:image/*` | P2 可选，体积上限 | 默认关 |
| file chip path | 工作区相对路径；规范化去 `..` 逃逸 | 绝对盘符出工作区、`\\server`、空 path |
| wiki `doc:` | 标题字符串；长度 cap | HTML 标签、控制字符 |

阅读态 `<a>`：`rel="noopener noreferrer"`；外链可 `target="_blank"`（产品可选）。

### 7.2 HTML

- **不**解析任意 HTML 块为 DOM（` <script>` / `<iframe>` 当纯文本或转义）。  
- 唯一例外：P2 toggle 可用受控 `<details><summary>` **序列化**，读入时白名单标签。  
- 用户粘贴 HTML → 转纯文本或 MD 子集（宿主 paste 管道）。

### 7.3 围栏语言（mermaid 等）

- `language` 仅作 class 钩子：`language-js` / `language-mermaid`。  
- mermaid **禁止** 在渲染前 `eval`；使用官方渲染器 + 沙箱；失败显示源码。  
- 未知 language → 纯文本 code，不加载插件。

### 7.4 路径打开（`onOpenPath`）

见 [08-integration](./08-integration.md) §4.3。扩展只发：

```ts
callbacks.onOpenPath?.(path, { kind: 'file-chip' | 'wiki-link' | 'md-link', sourceBlockId })
```

不直接 `window.open` 本地 file。

### 7.5 资源耗尽

| 限制 | 建议默认 |
|------|----------|
| 单 fence 体 | 1MB 字符 |
| 单文档块数 | 软警告 2k；虚拟化 >500 |
| wiki/file 正则回溯 | 禁止灾难性回溯；手写扫描 |
| autolink 扫描 | 单行 max 10k |

---

## 8. P2 语法预留

### 8.1 数学 `$$` / `$`

**块**

```md
$$
E = mc^2
$$
```

- 开闭 `$$` 须独占行（可前后空白）。  
- `props: { latex: string, display: true }`  
- 阅读态：KaTeX/MathJax 容器 `div.mdx-math`；失败显示源码。  
- serialize：原样 `$$\n…\n$$`。

**行内（可选）**：`$E=mc^2$`，需避免货币 `$` 误伤：要求内侧非空格贴邻。

**降级 pure-gfm**：保留 `$$` 源码（多数渲染器当段落）；或 code 化。

### 8.2 Mermaid fence

````md
```mermaid
flowchart LR
  A --> B
```
````

- 仍是 `code_block`，`props.language === 'mermaid'`。  
- 阅读态：若 `features.mermaid` → `div.mdx-mermaid` 替换 pre；否则 pre/code。  
- serialize：标准 fence，**无** Conex 专有语法 → pure-gfm 天然兼容。

### 8.3 脚注 Footnotes

```md
正文里有一个脚注[^1]。

[^1]: 脚注内容，可多段（后续缩进行）。
```

| 节点 | 说明 |
|------|------|
| 行内 | `footnote_ref` atom：`[^id]` |
| 块 | 文档尾 `footnote_def` 列表；或 Doc.meta.footnotes |

v1 **不实现**；解析器遇 `[^` 可当文本。预留 id 与往返，避免未来占用。

---

## 9. 自动链接

### 9.1 尖括号 autolink（GFM/CommonMark）

```md
<https://example.com/path>
<user@example.com>
```

- 产出 `link` mark 或 atom；href 对 email 为 `mailto:user@example.com`。  
- 角括号在序列化时 **保留**（L1）或可省略为裸链（配置）。

### 9.2 裸 URL（GFM extended）

```
访问 https://example.com/a?x=1 结束
```

规则（实用子集）：

```
url <- "http://" / "https://" 后续至空白或 <>"'` 等终止符
尾部剥离常见标点：. , ; : ! ? ) 若括号不配对则保留 )
```

### 9.3 裸 email

```
联系 dev@conex.local 即可
```

- 简化：`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`  
- 不在 `file_chip` path、code span 内生效。  
- serialize：默认写回裸 email（不强制 `<>`）。

---

## 10. 兼容性与降级总表

| Conex 结构 | `mode: conex` 序列化 | `mode: pure-gfm` / 外站 | 用户感知 |
|------------|----------------------|-------------------------|----------|
| callout | `> [!TIP]…` | 同左或 `> **提示**` | 仍是引用块 |
| file_chip | `[[file:src/a.ts]]` | `` [`a.ts`](src/a.ts) `` 或 `` `src/a.ts` `` | 可点链接或等宽路径 |
| wiki_link | `[[doc:重构变更摘要.md]]` | `[重构变更摘要.md](#)` 或纯文本标题 | 不报错、不丢标题 |
| embed P2 | `@[embed](url)` | 普通链接段落 | 可点 URL |
| math P2 | `$$…$$` | 同左 | 源码可见 |
| mermaid | \`\`\`mermaid | 同左 | 源码或外站渲染 |
| 未知扩展 | `meta.raw` 原样 | 原样 | 不丢字节 |

**剪贴板**：

- 复制「纯文本」→ pure-gfm 串。  
- 复制「Conex 内部多块」→ 可用 `text/markdown` + 可选 `application/x-conex-blocks+json`（P2）。

---

## 11. 语法版本

```ts
// 文档级（可选 frontmatter，Notebook 默认可无）
---
conex-md: 1
---
```

| 版本 | 变更策略 |
|------|----------|
| `1` | 本文件冻结：Alert callout、`[[file:]]` / `[[doc:]]`、GFM 子集 |
| `2`（未来） | 仅 **添加** 可忽略节点；旧引擎跳过未知 atom 为文本 |
| 缺省 | 视为 `1` |

**引擎行为**：

- 读入更高版本：未知块 → `paragraph` + 警告；能识别的子集仍解析。  
- 写回：`syntaxVersion` 取文档与引擎支持的 min；不主动升级 frontmatter 除非用户功能开关。

序列化 **不** 默认写入 frontmatter（Notebook artifact 干净）；仅桌面工作区文档可选。

---

## 12. 数据形状（引擎侧）

```ts
interface Doc {
  version: 1;
  syntaxVersion?: ConexMdSyntaxVersion;
  blocks: Block[];
  meta?: {
    footnotes?: FootnoteDef[]; // P2
    title?: string;
  };
}

// 扩展相关 InlineNode 增量（与 02 catalog 对齐并扩展 wiki）
type InlineNode =
  | { type: 'text'; text: string; marks?: Mark[] }
  | { type: 'hard_break' }
  | { type: 'inline_code'; text: string }
  | { type: 'mention'; userId: string; label: string }
  | { type: 'file_chip'; path: string; label?: string }
  | { type: 'wiki_link'; target: string; kind: 'doc' | 'ref'; label?: string };

type Mark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'strike' }
  | { type: 'link'; href: string; title?: string }
  | { type: 'inline_code' };
```

**注意**：`file_chip` 既可作 **行内 atom**，也可在 B8 独占行时升为块 `type: 'file_chip'`（见 file-chip 文档）。实现二选一或双形态；**序列化字符串一致**。

---

## 13. 交互（扩展共性）

| 交互 | 行为 |
|------|------|
| 阅读态点 file_chip | `onOpenPath(path, { kind: 'file-chip' })` |
| 阅读态点 wiki_link | `onOpenPath(target, { kind: 'wiki-link' })`；宿主解析为 artifact / 文档 |
| 阅读态点普通链接 | 外链新开；工作区相对路径可走 onOpenPath |
| 编辑态 atom | `contenteditable=false` 芯片；Backspace 整粒删除 |
| slash 插入 | 见各扩展 `slash.id`；面板 UI → `05` |
| feature flag 关 | 已有块仍显示/serialize；新 parse 不升级扩展节点 |

---

## 14. 边界情况

| 情况 | 处理 |
|------|------|
| 半截 `[[file:abc` | 纯文本 |
| `[[file:a]]` 在 code 内 | 纯文本 |
| callout 内再 `>` 无 kind | 子内容 quote 或 paragraph（v1 扁平） |
| 表格单元格内 wiki | 允许 I3 |
| 冲突：`[[file:x]]` 与 link 语法 | I3 在 I2 后；已写成 `[t](u)` 的不改 |
| 极大 kind 字符串 | kind max 32 chars |
| Windows 路径 `\` | file 序列化统一 `/`；解析接受 `\` |
| 中文标题 wiki | 允许；禁止 `]]` 未转义出现在 target |

---

## 15. a11y

- 扩展 atom：`role="link"` 或 `role="button"` + 可聚焦 `tabindex="0"`；Enter/Space 触发与 click 相同。  
- callout：见 callout 规格 `role="note"`；色不唯一语义。  
- 纯装饰 icon：`aria-hidden="true"`。  
- 降级为文本时不要求额外 ARIA。

---

## 16. 往返测试矩阵

### 16.1 级别

| 级别 | 要求 | v1 |
|------|------|-----|
| L0 语义 | 二轮 `fromMarkdown` 后 Doc 语义相等（忽略 id） | 必达 |
| L1 格式 | 标题 `#`、list `-`、强调 `**` 规范化 | 尽量 |
| L2 字节 | 空白/空行/强调符混用 | 不保证 |

### 16.2 夹具表（实现必须覆盖）

| ID | 夹具意图 | 输入要点 | 断言 |
|----|----------|----------|------|
| RT-G01 | 标题+段 | `# H\n\npara` | heading+paragraph |
| RT-G02 | 围栏 | \`\`\`ts 含 \`\`\` 内 markdown | 不二次解析 |
| RT-G03 | 表 | pipe + align | 单元格文本 |
| RT-G04 | 任务列表 | `- [x] a` | checked true |
| RT-G05 | 引用 | `> a` | quote 非 callout |
| RT-C01 | callout NOTE | `> [!NOTE]` | kind=note |
| RT-C02 | callout 标题 | `> [!WARNING] 自定义` | title 往返 |
| RT-C03 | `::: tip` | 容器 | 解析为 callout；serialize Alert |
| RT-C04 | success | `[!SUCCESS]` | kind 保留 |
| RT-F01 | 行内 file | `见 [[file:src/a.ts]]` | atom path |
| RT-F02 | 独占 file 行 | 整行 chip | 块或段内单 atom |
| RT-F03 | 路径空格 | `[[file:my dir/x.ts]]` | 允许或编码规则一致 |
| RT-W01 | wiki doc | `[[doc:重构变更摘要.md]]` | 与 demo-data 一致 |
| RT-W02 | wiki label | `[[doc:t\|显示名]]` | label 往返 |
| RT-A01 | 尖括号 URL | `<https://a.com>` | link |
| RT-A02 | 裸 URL | 段中 https | link 或 text 按 flag |
| RT-A03 | email | `a@b.co` | mailto |
| RT-X01 | 混合 | callout 内 file_chip | 子 inline 保留 |
| RT-X02 | pure 导出 | file_chip → 链接 | 无 `[[` 若 mode pure |
| RT-S01 | 危险协议 | `[x](javascript:1)` | 不渲染可执行 |
| RT-S02 | path `../` | file chip | 规范化或拒绝打开 |

**测试伪代码**：

```ts
function assertRoundTrip(md: string) {
  const d1 = fromMarkdown(md, reg);
  const out = toMarkdown(d1, reg, { mode: 'conex' });
  const d2 = fromMarkdown(out, reg);
  expect(semanticEqual(d1, d2)).toBe(true);
}
```

---

## 17. DOM / class 契约（扩展钩子）

| 结构 | class / attr |
|------|----------------|
| 编辑器根 | `mdx-editor`（架构壳层或 `cx-md-editor`，实现锁定一种并全仓一致） |
| callout | `mdx-callout mdx-callout--{kind}` |
| file chip | `mdx-file-chip` + `data-path` |
| wiki link | `mdx-wiki-link` + `data-wiki-kind` + `data-wiki-target` |
| embed | `mdx-embed` |
| math | `mdx-math` |
| mermaid 容器 | `mdx-mermaid` |
| 危险链接剥离后 | `mdx-link mdx-link--blocked` 可选 |

具体色板 → `07-visual-system.md`。

---

## 18. 分期

| 期 | 交付 |
|----|------|
| **P0** | gfm-baseline 全量；优先级 B0–B10 / I0–I7 骨架；往返 RT-G\* |
| **P1** | callout（Alert + 解析 `:::`）；file_chip；wiki_link；onOpenPath；RT-C/F/W |
| **P2** | embed；math；mermaid 渲染；footnotes；pure-gfm 导出开关 UI |

---

## 19. 修订

| 版本 | 日期 | 说明 |
|------|------|------|
| 0.1 | 2026-08-02 | 首版：接口、优先级、容器、安全、版本、测试矩阵、扩展索引 |
