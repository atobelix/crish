# Block: `divider`

> 索引：[02-block-catalog.md](../02-block-catalog.md)  
> **优先级**：P0

---

## 1. 目标 / 非目标

- **目标**：GFM  thematic break；atom 块，点击选中而非文本 caret。
- **非目标**：自定义厚度/颜色 props（走主题 CSS）；`***` / `___` 写出多样性（序列化统一 `---`）。

---

## 2. 标识

| 字段 | 值 |
|------|-----|
| type id | `divider` |
| slash | `insert.divider` |
| atom | **是** |

---

## 3. Markdown（GFM）

```md
---
***
___
```

- 解析：行内 ≥3 的 `-`/`*`/`_`（可含空格）且无其它内容。
- **序列化统一**：`---` + 前后空行。

---

## 4. props schema

```ts
interface DividerProps {
  // 无
}

interface DividerBlock {
  id: string;
  type: 'divider';
  props: DividerProps;
  // 无 content / children
}
```

---

## 5. 阅读 DOM

```html
<div class="mdx-block mdx-block--divider mdx-block--reading"
     data-block-id="…" data-block-type="divider" data-state="reading">
  <div class="mdx-block__gutter" aria-hidden="true"></div>
  <div class="mdx-block__body">
    <hr class="mdx-divider" />
  </div>
</div>
```

选中态：`mdx-block--selected` 描边（视觉见 `07`），仍无 caret。

---

## 6. 编辑交互

| 操作 | 行为 |
|------|------|
| Click | 选中 atom 块（`selected`），不进入文本编辑 |
| Enter | 在 **后方** 插入新 `paragraph` 并 focus |
| Backspace / Delete（选中时） | 删除 divider；caret 到相邻块 |
| 方向键 | 跨 atom 移动焦点到相邻块 |
| 输入字符 | 若误聚焦：在后方建 paragraph 并写入（可选） |
| `/` `、` | 不在 divider 上触发；应在相邻空段 |

**不可** contenteditable 的 `hr`。

---

## 7. Placeholder

无。无文本空态。

---

## 8. 序列化边界

| 情况 | 处理 |
|------|------|
| 连续多个 divider | 各输出 `---\n\n`；不合并 |
| 文档首尾 | 允许；首行 `---` 勿与 front matter 混淆——Notebook **无** YAML front matter 时按 HR 解析；若宿主有 FM，解析器需上下文（标注：v1 Notebook 无 FM） |
| 与 Setext 冲突 | 单独一行 `---` 且上行非段落文本 → HR；有上行段落时 GFM 可能 Setext h2——**解析优先级**：空行包围的 `---` → divider；紧贴短段落下的 `---` → 可按 heading 2 或强制要求空行（推荐：**要求 HR 上下空行** 才稳定 round-trip） |

---

## 9. canMergeWith

`false`；永不合并。

---

## 10. a11y

- `<hr class="mdx-divider">` 或 `role="separator"` + `aria-orientation="horizontal"`
- 选中时 `aria-selected="true"` 于块壳

---

## 11. 测试点

1. `***` parse → divider → serialize `---`。  
2. slash 插入后选中态，Enter 出新段。  
3. Backspace 删除。  
4. 不出现可输入 caret。

---

## 12. 分期

P0 全部。样式 token → `07-visual-system.md`。
