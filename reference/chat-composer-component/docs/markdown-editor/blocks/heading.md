# Block: `heading`

> 索引：[02-block-catalog.md](../02-block-catalog.md)  
> **优先级**：level 1–3 = **P0**；level 4–6 = **P1**

---

## 1. 目标 / 非目标

- **目标**：GFM ATX 标题；阅读态语义标题；编辑态整块编辑。
- **非目标**：Setext（`===`/`---` 下划线）写入（解析可降级为 heading，序列化统一 ATX）；目录自动生成（宿主可选）。

---

## 2. 标识

| 字段 | 值 |
|------|-----|
| type id | `heading` |
| slash | `insert.heading1` … `insert.heading6` |
| atom | 否 |

---

## 3. Markdown（GFM）

```md
# 一级标题
## 二级标题
### 三级标题
#### 四级
##### 五级
###### 六级
```

- 闭合式 `# Title #`：解析接受，序列化输出左侧 `#` 仅。
- 前置最多 3 空格；`#` 后至少一个空格（严格 GFM）。

---

## 4. props schema

```ts
interface HeadingProps {
  level: 1 | 2 | 3 | 4 | 5 | 6;
}

interface HeadingBlock {
  id: string;
  type: 'heading';
  props: HeadingProps;
  content: InlineNode[];
}
```

- `level` 必填；越界 clamp 到 1..6。
- 允许 marks：bold/italic/code/link；**不推荐** heading 内复杂嵌套，序列化照常。

---

## 5. 阅读 DOM

```html
<div class="mdx-block mdx-block--heading mdx-block--heading-2 mdx-block--reading"
     data-block-id="…" data-block-type="heading" data-heading-level="2" data-state="reading">
  <div class="mdx-block__gutter" aria-hidden="true"></div>
  <div class="mdx-block__body">
    <h2 class="mdx-heading mdx-heading--2">标题文本</h2>
  </div>
</div>
```

| class / attr | 用途 |
|--------------|------|
| `mdx-heading` | 标题根 |
| `mdx-heading--{n}` | 级别 |
| `mdx-block--heading-{n}` | 块壳级别（样式钩子） |
| `data-heading-level` | 程序读取 |

**必须**使用原生 `h1`–`h6`，禁止全用 `div` 假标题。

---

## 6. 编辑交互

| 操作 | 行为 |
|------|------|
| Click | 进入 editing；可编辑表面在 `h{n}` |
| Enter | **始终**拆出后半为新 **`paragraph`**（不拆成两个 heading） |
| Enter 在空 heading | 将本块转为 `paragraph`（或删除本块新建 paragraph——推荐 **转 paragraph** 保留 id） |
| Backspace 块首 | 转为 `paragraph` 保留 content（降级），**不**与上一段合并为 heading |
| Backspace 空 heading | 删除块 |
| 行首 `/` `、` | 同 paragraph（空标题时可 slash 换成其他块） |

**改级别**：slash 再选标题；或快捷 `Mod+Alt+1..6`（可选 P1）。

---

## 7. Placeholder

| level | 文案 |
|-------|------|
| 1 | `标题` |
| 2 | `二级标题` |
| 3 | `三级标题` |
| 4 | `四级标题` |
| 5 | `五级标题` |
| 6 | `六级标题` |

---

## 8. 序列化边界

| 情况 | 处理 |
|------|------|
| 空 heading | 输出 `## \n` 或省略；推荐 **省略空标题块**（若用户显式插入空标题则 `## \n`） |
| content 含换行 | 压成单行空格 |
| 行内 `#` 字符 | 普通文本，不转义（ATX 行首才有意义） |
| 前后块 | `\n\n# Title\n\n` |
| Setext 输入 | parse → heading level 1/2；serialize → ATX |

---

## 9. canMergeWith

```ts
() => false // 标题不参与文本合并
```

Backspace 块首 → convert to paragraph，再由用户继续 Backspace 合并。

---

## 10. a11y

- 原生 heading 级别与 `props.level` 一致。
- 单页多个 `h1`：产品不强制唯一；Notebook 文档允许（宿主可告警）。
- 编辑态保持同一 `h{n}` 节点，避免级别跳跃丢焦点。

---

## 11. 测试点

1. `## Hi` → level 2 → serialize `## Hi`。  
2. Enter 中部 → heading + paragraph。  
3. 空 H 上 Enter → paragraph。  
4. Backspace 块首 → paragraph 同文案。  
5. slash `insert.heading1` 插入后 placeholder「标题」。

---

## 12. 分期

| 项 | 期 |
|----|-----|
| H1–H3 + slash | P0 |
| H4–H6 | P1 |
| 快捷键改级 | P1 |
| Setext 写出 | 不做 |
