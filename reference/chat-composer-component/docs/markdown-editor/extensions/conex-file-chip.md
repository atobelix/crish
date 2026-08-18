# Extension: `conex.file_chip` — 工作区路径芯片

> 索引：[06-extensions.md](../06-extensions.md)  
> 块目录：[02-block-catalog.md](../02-block-catalog.md) §7.6  
> 宿主：[08-integration.md](../08-integration.md) `onOpenPath`  
> **优先级**：P1  
> **meta.id**：`conex.file_chip`  
> **形态**：行内 atom（主）；独占行可升为块 `file_chip`

---

## 1. 目标 / 非目标

### 目标

- 在 Markdown 中稳定表达 **工作区文件路径**，阅读态渲染为精致 chip。  
- 点击 → 宿主 **`onOpenPath(path, { kind: 'file-chip' })`**，打开右侧文件面板（与对话流 ActionRow 路径 chip 同源体验）。  
- 可往返；pure-gfm 降级为普通 MD 链接或行内代码路径。

### 非目标

- 在 Notebook 内预览/编辑 `.ts/.rs` 源码（产品禁令：源码走 Files 面板）。  
- 任意文件系统浏览 UI（由宿主负责）。  
- 多文件选择器完整规格（slash 可调宿主 API，细节 P1 最小：手输 path）。

---

## 2. 语法

### 2.1 规范形式（序列化标准）

```md
见 [[file:src/core-handler.ts]] 的变更。
```

**独占行（块级可选）**：

```md
[[file:docs/plan.md]]
```

### 2.2 带显示名（可选）

```md
[[file:src/a.ts|core-handler]]
```

管道 `|` 分隔：左侧 path，右侧 label。  
label 缺省 = path 的 basename。

### 2.3 文法

```
file-chip   ::= "[[" "file:" path ( "|" label )? "]]"
path        ::= 非 "]" 非 "|" 字符序列，trim 后非空；长度 ≤ 512
label       ::= 非 "]" 字符序列，trim；可空则视作无 label
```

**路径规范化（parse 后）**：

1. 统一 `\` → `/`。  
2. 去掉首部 `./`。  
3. 拒绝（不生成 atom，保留原文或生成 blocked 节点）：  
   - 空 path  
   - 含 `]]` 未闭合变体  
   - 控制字符 `\0-\x1F`  
   - parse 时 **允许** `../` 字面进入 props；**打开时** 由宿主 resolve 并防逃逸工作区

### 2.4 不采用的形态（可识别为未来，v1 不写回）

| 形态 | v1 |
|------|-----|
| `` 📎`path` `` | 不解析为 chip |
| HTML comment | 不使用 |
| `[file:path](...)` | 当普通链接 |

---

## 3. 数据形状

```ts
/** 行内 */
interface FileChipInline {
  type: 'file_chip';
  path: string;       // 规范化相对路径
  label?: string;     // 展示名
}

/** 块级（独占行时可选） */
interface FileChipBlock {
  id: string;
  type: 'file_chip';
  props: {
    path: string;
    label?: string;
    exists?: boolean; // 仅运行时，不序列化
  };
  // 无 content
}

// OpenPathMeta 见 08
// { kind: 'file-chip', sourceBlockId?: string }
```

**Inline 与 Block 互转**：

- 序列化字符串 **相同**：`[[file:path]]` 或带 label。  
- 整段仅一 chip 且无其他 inline → 可存块；编辑时也可降为 paragraph 内 atom。实现锁定：**优先行内 atom**，B8 独占行仍包在 paragraph 亦可。

---

## 4. parseInline / serialize

### 4.1 扫描（I3 档）

```ts
function parseFileChip(ctx: InlineParseContext) {
  const s = ctx.text;
  const i = ctx.offset;
  if (s.startsWith('[[file:', i) === false) {
    // 注意：startsWith 第二参在 ES；手写 s.slice(i, i+7) === '[[file:'
  }
  if (s.slice(i, i + 7) !== '[[file:') return null;
  const close = s.indexOf(']]', i + 7);
  if (close < 0) return null;
  const body = s.slice(i + 7, close); // path 或 path|label
  const pipe = body.indexOf('|');
  let path = (pipe >= 0 ? body.slice(0, pipe) : body).trim();
  let label = pipe >= 0 ? body.slice(pipe + 1).trim() : undefined;
  path = normalizePath(path);
  if (!path) return null;
  if (label === '') label = undefined;
  return {
    node: { type: 'file_chip', path, label } as FileChipInline,
    consumed: close + 2 - i,
  };
}
```

**code span 内**：I0 已锁定，不调用。

### 4.2 serialize

```ts
function serializeFileChip(n: FileChipInline, ctx: SerializeContext): string {
  const path = normalizePath(n.path);
  if (ctx.mode === 'pure-gfm') {
    const text = n.label || basename(path);
    // 相对路径作链接目标；空格 encode
    return `[${escapeLabel(text)}](${encodePathForMd(path)})`;
  }
  if (n.label && n.label !== basename(path)) {
    return `[[file:${path}|${n.label}]]`;
  }
  return `[[file:${path}]]`;
}
```

### 4.3 ExtensionSpec

```ts
const conexFileChip: InlineExtension & Partial<BlockExtension> = {
  meta: {
    id: 'conex.file_chip',
    syntaxVersion: 1,
    priority: 'P1',
    enabledByDefault: true,
    degrade: 'md-link',
  },
  atoms: ['file_chip'],
  parseInline: parseFileChip,
  serializeInline: serializeFileChip,
  openPathKind: 'file-chip',
  blockType: 'file_chip',
  slash: {
    id: 'insert.file_chip',
    title: '文件路径',
    keywords: ['文件', '路径', 'file', 'path', '附件', '芯片'],
    group: 'Conex',
    insert: (ctx) => {
      // 最小：插入空 path chip 占位，进入 path 输入；或调宿主 pickFile
      return {
        type: 'paragraph',
        content: [{ type: 'file_chip', path: '', label: undefined }],
      };
    },
  },
  theme: { blockClass: 'mdx-file-chip' },
};
```

空 path 不 serialize 为 `[[file:]]`（非法）；保存前校验或 serialize 为 placeholder 文本 `「选择文件」` 丢弃 atom——**锁定：空 path 序列化为零宽跳过并 warn**。

---

## 5. 交互

| 操作 | 行为 |
|------|------|
| 阅读态 Click / Enter | `callbacks.onOpenPath(path, { kind: 'file-chip', sourceBlockId })` |
| 无 onOpenPath | 可 toast「无法打开路径」；**不** `window.open(file://)` |
| 编辑态 | atom `contenteditable=false`；左右方向键整粒跳过；Backspace/Delete 删整粒 |
| 双击 chip | 可选：就地编辑 path（popover input） |
| slash 插入 | 插入 chip；若宿主提供 `pickWorkspaceFile()` 则填 path |
| `exists === false` | 样式 `mdx-file-chip--missing`；仍可点（宿主决定） |
| 拖拽块 | 随 paragraph 走；块级 chip 可 DnD |

**与对话流一致**：只打开 Files/侧栏，不把源码塞进 Notebook。

---

## 6. 阅读 DOM

```html
<span class="mdx-file-chip" data-path="src/a.ts" role="link" tabindex="0"
      aria-label="打开文件 src/a.ts">
  <span class="mdx-file-chip__icon" aria-hidden="true"></span>
  <span class="mdx-file-chip__label">a.ts</span>
</span>
```

| class | 用途 |
|-------|------|
| `mdx-file-chip` | 根 |
| `mdx-file-chip--missing` | 不存在 |
| `mdx-file-chip__icon` | 左簇文件图标 |
| `mdx-file-chip__label` | 显示名 |

块壳（若块级）：`mdx-block mdx-block--file-chip`。

---

## 7. 边界情况

| 情况 | 处理 |
|------|------|
| `[[file:a.ts\|b\|c]]` | path=`a.ts`，label=`b\|c`（仅首 `\|` 分 path）或拒绝——**锁定首 pipe** |
| path 含空格 | 允许 `src/my file.ts` |
| path 含 `\|` | 必须用 label 语法且 path 不含 pipe；否则不匹配 |
| 未闭合 `[[file:a` | 纯文本 |
| 嵌套 `[[file:[[file:a]]` | 内层先失败；手写扫描找 `]]` |
| Windows `C:\a` | 可 parse；打开时宿主拒绝出工作区 |
| 极长 path | 截断 512 |
| 与 wiki `[[doc:` | 前缀不同，I3 内先尝试 `file:` 再 `doc:` |

---

## 8. a11y

- `role="link"`（语义为打开资源）或 `button`；全编辑器统一 **link**。  
- `tabindex="0"`；Enter / Space 激活。  
- `aria-label`：`打开文件 {path}`；missing 时 `文件不存在：{path}`。  
- 色与图标同时表达 missing，不只靠红。

---

## 9. 安全

| 检查点 | 规则 |
|--------|------|
| serialize | 只输出规范化相对 path |
| click | 只回调 onOpenPath，不拼 `file://` 进 iframe |
| 宿主 | resolve 工作区根；拒绝 symlink 逃逸（宿主责） |
| XSS | label/path 进 DOM 用 textContent |
| 协议 | path 若误写成 `javascript:` 当 path 字面；**打开前** 校验首段非协议 URL |

---

## 10. 测试点

1. RT-F01 行内往返。  
2. RT-F02 独占行。  
3. label 往返与 basename 省略规则。  
4. `\` → `/`。  
5. code 内不解析。  
6. pure-gfm 变为 `[label](path)`。  
7. click 触发 onOpenPath 且 meta.kind 正确。  
8. 空 path 不写非法 MD。  
9. 键盘 Enter 激活。  
10. missing 样式 class。

---

## 11. 分期

| 项 | 期 |
|----|-----|
| 语法 + 行内 atom + onOpenPath | P1 |
| slash 插入 + 手输 path | P1 |
| 宿主文件选择器 | P1 可选 |
| exists 探测 | P1 可选（宿主异步） |
| popover 编辑 path | P1/P2 |

---

## 12. 修订

| 版本 | 日期 | 说明 |
|------|------|------|
| 0.1 | 2026-08-02 | 冻结 `[[file:]]` 与 onOpenPath 契约 |
