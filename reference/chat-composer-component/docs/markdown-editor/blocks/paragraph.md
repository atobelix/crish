# Block: `paragraph`

> 索引：[02-block-catalog.md](../02-block-catalog.md)  
> **优先级**：P0

---

## 1. 目标 / 非目标

- **目标**：默认叶子块；承载正文与行内 marks；Enter 拆分 / Backspace 合并的基准实现。
- **非目标**：段落级对齐、首行缩进 props（v2）；多栏布局。

---

## 2. 标识

| 字段 | 值 |
|------|-----|
| type id | `paragraph` |
| slash | `insert.paragraph` |
| atom | 否 |

---

## 3. Markdown（GFM）

```md
普通一段文字，可含 **粗体**、*斜体*、`代码`、[链接](url)。

下一段（空行分隔）。
```

- 单换行：GFM soft break → 序列化为空格或 `  \n` / `\n`（引擎统一 soft-break 策略；推荐保留 `hard_break` 节点时输出 `  \n`）。
- 不以 `#`、列表标记、围栏、`>`、`|`、`---` 开头的连续文本归为 paragraph。

---

## 4. props schema

```ts
interface ParagraphProps {
  // 无必备字段；预留
  textAlign?: 'left' | 'center' | 'right'; // v2，默认不序列化
}

interface ParagraphBlock {
  id: string;
  type: 'paragraph';
  props: ParagraphProps;
  content: InlineNode[];
}
```

空段：`content: []` 或单零宽忽略；序列化为空行占位时按「相邻空段折叠」规则（见 §8）。

---

## 5. 阅读 DOM

```html
<div class="mdx-block mdx-block--paragraph mdx-block--reading"
     data-block-id="…" data-block-type="paragraph" data-state="reading">
  <div class="mdx-block__gutter" aria-hidden="true"></div>
  <div class="mdx-block__body">
    <p class="mdx-paragraph">
      <span class="mdx-inline">文本</span>
      <strong class="mdx-mark--bold">粗</strong>
      <code class="mdx-mark--inline-code">x</code>
    </p>
  </div>
</div>
```

| class | 用途 |
|-------|------|
| `mdx-paragraph` | 段落根 |
| `mdx-placeholder` | 空且可显示占位时挂在 `p` 上 |

---

## 6. 编辑交互

| 操作 | 行为 |
|------|------|
| Click 文字 | `editing`；contenteditable 或等价 surface 于 `.mdx-paragraph` |
| Enter | 在 caret **拆分**为两个 `paragraph`；后块继承 marks 边界规则（拆在 mark 中则 mark 分属两侧） |
| Enter 在空 paragraph | 仍新建空 paragraph（连续空段）；slash 场景下首字符 `/` 优先命令 |
| Backspace 在块首 | 与上一块 `canMergeWith`：上一 `paragraph` 或同级可合并叶子 → 合并 content，删本 id |
| Backspace 空块 | 删除本块，caret → 上一块末 |
| 行首 `/` 或 `、` | 块空或仅触发符 → 打开 slash（消费触发符） |

**IME**：composition 期间不触发 slash、不拆分 Enter（等 compositionend）。

---

## 7. Placeholder

- 文案：`输入正文，或键入 / 打开命令`
- class：`mdx-placeholder`
- 不进 `textContent` 序列化 / 剪贴板纯文本

---

## 8. 序列化边界

| 情况 | 处理 |
|------|------|
| 空 paragraph 夹在两块之间 | 输出单个空行作分隔即可；不输出多余空段 |
| 文档仅一空段 | 输出 `""` 或 `\n`（宿主统一） |
| 仅空格 | trim 后空 → 当空段；或保留 nbsp 策略：**trim 序列化** |
| 全 soft-break | 归一为一个空段或保留 hard_break |
| 与 heading 相邻 | 块间 `\n\n` |

---

## 9. canMergeWith

```ts
(a, b) => a.type === 'paragraph' && b.type === 'paragraph'
```

---

## 10. a11y

- 阅读：原生 `<p>`
- 编辑：`aria-label="正文"`（可选，避免刷屏可只在空块时）
- placeholder：`aria-hidden="true"`

---

## 11. 测试点

1. `hello **x**` 往返保留 bold。  
2. Enter 中点拆分 → 两 block content 正确。  
3. Backspace 块首合并。  
4. 空段 placeholder 中文不进 serialize。  
5. IME 输入中文时不误开 slash。

---

## 12. 分期

P0 必达；`textAlign` 为 P2。
