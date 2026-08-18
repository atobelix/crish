# Block: `bullet_list` / `ordered_list` / `list_item`

> 索引：[02-block-catalog.md](../02-block-catalog.md)  
> **优先级**：P0  
> 任务列表见 [task.md](./task.md)（结构类似，checkbox 不同）。

---

## 1. 目标 / 非目标

- **目标**：GFM 无序/有序列表；缩进嵌套；Enter/Tab/Backspace 进出层与拆项。
- **非目标**：自定义 bullet 符号 props；续写编号的复杂 GFM 宽忍（序列化统一 `1.` 或规范递增）。

---

## 2. 标识

| type id | 说明 |
|---------|------|
| `bullet_list` | 容器 `ul` |
| `ordered_list` | 容器 `ol` |
| `list_item` | 子项；可含 paragraph + 嵌套 list |

| slash | 结果 |
|-------|------|
| `insert.bullet_list` | 一 `bullet_list` + 一空 `list_item` |
| `insert.ordered_list` | 一 `ordered_list` + 一空 `list_item` |

---

## 3. Markdown（GFM）

```md
- 甲
- 乙
  - 乙-1
* 也可用星号

1. 第一
2. 第二
   1. 嵌套有序
```

- 无序标记：`-` `*` `+` 解析皆可；**序列化统一 `-`**。
- 有序：`1.` / `1)` 解析可；**序列化统一 `1.` 风格且按深度重编号**（或保持起始 `start`，见 props）。
- 缩进：2 或 4 空格；引擎 normalize 为 2 空格一层。

---

## 4. props schema

```ts
interface BulletListProps {
  // 无
}

interface OrderedListProps {
  start?: number; // 默认 1；GFM 起始编号
}

interface ListItemProps {
  // 无；任务项见 task_item
}

interface ListBlock {
  id: string;
  type: 'bullet_list' | 'ordered_list';
  props: BulletListProps | OrderedListProps;
  children: ListItemBlock[]; // 至少 0；UI 插入时至少 1
}

interface ListItemBlock {
  id: string;
  type: 'list_item';
  props: ListItemProps;
  /** 首子通常为 paragraph；后续可为嵌套 list */
  children: Block[];
}
```

**内容模型（v1）**：

```
list_item
  ├── paragraph (必需语义上的「主文本」；可空)
  └── (bullet_list | ordered_list | task_list)?  // 至多一个尾嵌套列表，或允许多个同类
```

简化：item 的 `content` 直接挂 InlineNode，嵌套 list 放 `children`——**二选一需引擎统一**。  
**本规格采用**：`list_item.children[0]` 为 `paragraph`（主文本），其后可选嵌套 list 容器。

---

## 5. 阅读 DOM

```html
<div class="mdx-block mdx-block--bullet-list" data-block-type="bullet_list" data-state="reading">
  <div class="mdx-block__gutter"></div>
  <div class="mdx-block__body">
    <ul class="mdx-list mdx-list--bullet">
      <li class="mdx-list-item" data-block-id="item-1" data-block-type="list_item">
        <p class="mdx-paragraph">甲</p>
        <ul class="mdx-list mdx-list--bullet">…</ul>
      </li>
    </ul>
  </div>
</div>
```

有序：`ol.mdx-list.mdx-list--ordered`，`start` 属性映射 `props.start`。

| class | 用途 |
|-------|------|
| `mdx-list` | 列表根 |
| `mdx-list--bullet` / `--ordered` | 种类 |
| `mdx-list-item` | 项 |
| `mdx-list--nested` | 可选，嵌套 ul/ol |

**编辑态**：整表可 `data-state=editing`，焦点在具体 item 的 paragraph。

---

## 6. 编辑交互

### 6.1 焦点模型

- 用户感知：编辑某一 `list_item` 的主 paragraph。
- 容器 `bullet_list` 选中用于拖拽整表（DnD 见 `04`）。

### 6.2 键盘

| 操作 | 行为 |
|------|------|
| Enter 非空 item | 在后插入新 `list_item`（同级），caret 进新项 |
| Enter 空 item（非嵌套唯一） | **退出列表**：删空项；若列表空则删列表；其后插入 `paragraph` |
| Enter 空嵌套 item | 提升一层（outdent）或退出嵌套 |
| Tab | indent：变为上一兄弟的子 list 中新项（无上一兄弟则 no-op） |
| Shift+Tab | outdent：提升到父 list 同级 |
| Backspace 项首且非空 | 按 paragraph 规则删字符 |
| Backspace 项首且空 | 删除该项，caret 到前项末；若唯一项则退出为 paragraph |
| Backspace 项首且内容非空 | **可选 P1**：与前项合并文本 |

### 6.3 点击

- Click 子弹圆/数字：选中项或 focus 主文本（不切换 checkbox——那是 task）。
- 从 paragraph 粘贴多行：拆成多项（P0 期望）。

### 6.4 有序编号

- 显示用 CSS `list-style` 或 `value`；`props.start` 仅第一项生效。
- 中间插入/删除后 **显示重排**；serialize 写 `1.` `2.` … 或全 `1.`（GFM 宽松）——**推荐递增写出**。

---

## 7. Placeholder

- 空 `list_item` 主段：`列表项`
- 不在 `ul`/`ol` 层显示总占位。

---

## 8. 序列化边界

| 情况 | 处理 |
|------|------|
| 空 list | 不输出 或 输出 `- \n`；推荐插入态保留一项 `- ` |
| 空 item | `- \n`（单项占位） |
| 混合 bullet/ordered 错误嵌套 | parse 容错；serialize 按实际 type |
| item 内多 paragraph | GFM 紧随缩进续行；v1 可限制仅一 paragraph，多余合并 |
| `ordered_list.start = 3` | 首行 `3. `，后续 `4.`… |
| 标记混用 `*` `-` | 统一 `-` |
| 列表后紧接段落 | 段前空行，避免粘进 list |

**嵌套示例输出**：

```md
- 甲
  - 甲-1
- 乙
```

---

## 9. canMergeWith

- list 容器之间：不自动 merge（用户 DnD 拼接另议）。
- list_item 主 paragraph 与独立 paragraph：仅在「退出列表」路径转换，不跨块 merge API。

---

## 10. a11y

- `ul`/`ol`/`li` 语义正确。
- `ol[start]`。
- 嵌套列表挂在 `li` 内，不挂在 `ul` 旁路错误结构。

---

## 11. 测试点

1. 无序/有序往返；嵌套一层往返。  
2. Enter 空项退出列表。  
3. Tab / Shift+Tab 缩进矩阵。  
4. slash 插入后一项 + placeholder「列表项」。  
5. `start: 3` 的 ordered serialize。  
6. 多行粘贴拆项。

---

## 12. 分期

| 项 | 期 |
|----|-----|
| 单层 list + item 编辑 | P0 |
| 嵌套 ≥1 层 | P0 |
| Tab indent | P0 |
| 多 paragraph 每项 | P1 |
| 深度 >3 性能 | 虚拟化属架构 |
