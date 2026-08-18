# Block: `code_block` + mark `inline_code`

> 索引：[02-block-catalog.md](../02-block-catalog.md)  
> **优先级**：P0

---

## 1. 目标 / 非目标

- **目标**：围栏代码块（语言标签、纯文本编辑、阅读态高亮可选）；行内 `` `code` ``。
- **非目标**：代码块内协作光标；完整 LSP；缩进语言自动检测（可 P2）。

---

## 2. 标识

| type / mark | id |
|-------------|-----|
| 块 | `code_block` |
| slash | `insert.code_block` |
| 行内 | mark `inline_code` 或 atom（引擎统一）；toggle `toggle.inline_code` |

---

## 3. Markdown（GFM）

### 3.1 代码块

````md
```ts
const x = 1
```

~~~js
// 波浪围栏也可解析
~~~
````

- 序列化：**统一反引号围栏 \`\`\`**；lang 小写 trim。
- 缩进围栏（前 0–3 空格）可解析。
- 信息串：只取首 token 为 `lang`；其余 `meta` 可丢或进 props（P1）。

### 3.2 行内

```md
使用 `code` 与 `` a`b `` 转义。
```

---

## 4. props schema

```ts
interface CodeBlockProps {
  lang: string;      // '' = 纯文本
  meta?: string;     // 信息串剩余，可选
}

interface CodeBlock {
  id: string;
  type: 'code_block';
  props: CodeBlockProps;
  /** 纯文本，不用 InlineNode；保留 \n */
  text: string;
}
```

**注意**：与叶子 `content: InlineNode[]` 不同，代码块用 `text: string` 避免 marks 污染。

行内：

```ts
// 作为 mark
{ type: 'text', text: 'x', marks: [{ type: 'inline_code' }] }
// 或 atom
{ type: 'inline_code', text: 'x' }
```

**引擎二选一，全库统一；推荐 atom 节点**，禁止嵌套 mark。

---

## 5. 阅读 DOM

### 5.1 代码块

```html
<div class="mdx-block mdx-block--code-block mdx-block--reading"
     data-block-type="code_block" data-lang="ts" data-state="reading">
  <div class="mdx-block__gutter"></div>
  <div class="mdx-block__body">
    <div class="mdx-code">
      <div class="mdx-code__header">
        <span class="mdx-code__lang">ts</span>
        <button type="button" class="mdx-code__copy" aria-label="复制代码">复制</button>
      </div>
      <pre class="mdx-code__pre"><code class="mdx-code__code language-ts">const x = 1</code></pre>
    </div>
  </div>
</div>
```

| class | 用途 |
|-------|------|
| `mdx-code` | 卡片容器 |
| `mdx-code__lang` | 语言标签 |
| `mdx-code__copy` | 复制；左簇/顶栏右缘均可，避免与流 UI 两端拉扯冲突时放 header 右内侧 |
| `mdx-code__pre` / `__code` | 等宽文本 |
| `mdx-code--editing` | 编辑态 |

高亮：阅读态可对 `code` 注入 span（`mdx-token--*`）；**编辑态用纯 textarea 或 plaintext-only**，禁止高亮 span 抢 caret。

### 5.2 行内

```html
<code class="mdx-mark--inline-code">x</code>
```

---

## 6. 编辑交互

### 6.1 代码块

| 操作 | 行为 |
|------|------|
| Click 代码区 | 进入 editing：`textarea.mdx-code__input` 或 `contenteditable=plaintext-only` |
| Click 语言标签 | 打开小菜单改 `lang`（P0 可用）；空 = 纯文本 |
| Enter | **插入换行**，不拆块 |
| Mod+Enter | 退出块并在后方聚焦/新建 paragraph（推荐） |
| Esc | 退出 editing → reading（保持选中可选） |
| Backspace 空代码块且 caret 0 | 删除块或转 paragraph（推荐 **删块** 若从 slash 新建且从未输入） |
| Tab | 插入空格/缩进（2 或 4，编辑器默认 2）；不焦点逃逸 |
| 粘贴 | 纯文本；保留 `\n`；不解析 MD |

### 6.2 行内 code

| 操作 | 行为 |
|------|------|
| 输入配对 `` ` `` | 输入法友好：选区包 `` ` `` 或 toggle 命令 |
| 在 inline_code 内 Enter | 不支持硬拆；Enter 由父块处理（先退出 mark） |
| Arrow 边界 | 跳出 atom |

---

## 7. Placeholder

- 代码块空：`编写代码`
- 显示于 textarea placeholder 属性或 `mdx-placeholder`
- 行内无单独占位

---

## 8. 序列化边界

| 情况 | 处理 |
|------|------|
| text 含 \`\`\` | 改用更长围栏 \`\`\`\` 或加空格策略；**检测内容围栏长度 +1** |
| 尾随换行 | 围栏前保留单个 `\n`；text 本身 trimEnd 可选——**保留内部，文件末统一** |
| lang 含空格/奇怪字符 | sanitize 为 `[a-z0-9_+-#]*`；否则清空 |
| 空 code_block | \`\`\`\n\n\`\`\` |
| 缩进代码（4 空格）输入 | parse 可升为 code_block 或 paragraph；serialize 只用围栏 |
| inline 含 `` ` `` | 外层用双反引号包裹 |
| 安全 | 阅读高亮后 HTML 消毒；禁止原始 HTML 注入 |

---

## 9. canMergeWith

`false`。邻接两个 code_block 不自动合并（用户可手选合并命令 P2）。

---

## 10. a11y

- `pre/code` 语义；`aria-label` 含语言：`代码块 TypeScript`。
- 复制按钮可键盘激活；`aria-live` 提示「已复制」（短暂）。
- textarea：`spellcheck="false"` `autocapitalize="off"`。

---

## 11. 测试点

1. 往返保留 lang 与多行 text。  
2. text 含 \`\`\` 时围栏加长。  
3. Enter 不拆块；Mod+Enter 退出。  
4. 复制按钮写 clipboard。  
5. inline `` a`b `` 往返。  
6. placeholder「编写代码」不进 text。

---

## 12. 分期

| 项 | 期 |
|----|-----|
| 围栏 + 纯文本编辑 + lang | P0 |
| 复制按钮 | P0 |
| 阅读态语法高亮 | P1 |
| meta 信息串 | P1 |
| 语言自动检测 | P2 |
