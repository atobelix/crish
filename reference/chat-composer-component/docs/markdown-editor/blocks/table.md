# Block: `table` / `table_row` / `table_cell`

> 索引：[02-block-catalog.md](../02-block-catalog.md)  
> **优先级**：P0（建表、改单元格、增删行列、header）  
> **非目标 v1**：合并单元格、列宽拖拽持久化（P1/P2）、复杂 HTML table 导入。

---

## 1. 目标 / 非目标

### 目标

- GFM pipe table 解析与序列化。
- 单元格内 **行内** 编辑（marks：bold/italic/code/link）。
- **Tab / Shift+Tab** 在单元格间移动。
- 增删行/列；第一行可标为 header。
- 明确 **pipe round-trip 限制**，避免假承诺字节级还原。

### 非目标

- `colspan` / `rowspan`。
- 单元格内嵌套 block（list/code_block/paragraph 多段）——v1 **仅 inline**。
- 粘贴 Excel 全保真（尽力解析 TSV P1）。

---

## 2. 标识

| type id | 角色 |
|---------|------|
| `table` | 根容器 |
| `table_row` | 行 |
| `table_cell` | 格（header 与 body 共用 type，用 props.header 区分） |

| slash | 默认 |
|-------|------|
| `insert.table` | 3 列 × 2 行 body + 1 header 行；全空 cell |

内部 type 无独立 slash。

---

## 3. Markdown（GFM pipe）

```md
| 名称 | 类型 | 说明 |
| --- | :---: | ---: |
| id | string | 主键 |
| n | number | 计数 |
```

### 3.1 对齐

分隔行 `:---` / `:---:` / `---:` → 列对齐 `left|center|right`。

### 3.2 解析规则

- 每行以 `|` 可选起始；引擎 split `|` 后 trim 单元格。
- 首行为 header 行；次行必须为分隔行（`---` 片段）。
- 列数以 **header 列数** 为准；短行补空 cell，长行截断或扩展表宽（**推荐：扩展列数取 max，短行右侧补空**）。

### 3.3 序列化规则

- 始终输出：header 行 + 分隔行 + body 行。
- 分隔行按 `columnAligns[i]` 写 `---` / `:---:` / `---:`。
- 单元格内 `|` → 转义 `\|` 或替换——**GFM 无标准转义**；采用 `\|` 并在 parse 识别（扩展容错）。
- 单元格内换行：**不允许**；序列化时 `\n` → 空格。
- 外层两侧 `|` **始终写出**（便于 round-trip）。

---

## 4. props schema

```ts
type ColAlign = 'left' | 'center' | 'right';

interface TableProps {
  /** 每列对齐；长度 = 列数 */
  columnAligns: ColAlign[];
  /** 是否有 header 行；v1 恒 true（GFM 需要）。false 时序列化仍写空 header 或用首行当 header */
  hasHeader: boolean; // 默认 true
}

interface TableRowProps {
  // 无；header 与否由在 table.children 中的 index === 0 且 hasHeader 决定
}

interface TableCellProps {
  /** 若行是 header 行，render 为 th */
  // 冗余可选：header?: boolean
}

interface TableCellBlock {
  id: string;
  type: 'table_cell';
  props: TableCellProps;
  content: InlineNode[]; // 仅 inline
}

interface TableRowBlock {
  id: string;
  type: 'table_row';
  props: TableRowProps;
  children: TableCellBlock[]; // 长度应 == 列数
}

interface TableBlock {
  id: string;
  type: 'table';
  props: TableProps;
  children: TableRowBlock[]; // [header?, ...body]
}
```

**不变量**：

1. 所有 row 的 `children.length` 相等 = `colCount`。
2. `columnAligns.length === colCount`。
3. `hasHeader === true` 时 `children[0]` 为表头行。
4. 最少 1 列 × 1 行（插入默认 3×3 含头）。

**默认插入**：

```ts
colCount = 3
rows = 1 header + 2 body
columnAligns = ['left','left','left']
cells content = []
```

---

## 5. 阅读 DOM

```html
<div class="mdx-block mdx-block--table mdx-block--reading"
     data-block-type="table" data-state="reading">
  <div class="mdx-block__gutter"></div>
  <div class="mdx-block__body">
    <div class="mdx-table-wrap">
      <table class="mdx-table">
        <thead class="mdx-table__head">
          <tr class="mdx-table__row" data-block-id="r0" data-block-type="table_row">
            <th class="mdx-table__cell mdx-table__cell--header" data-block-id="c0"
                data-block-type="table_cell" data-align="left" scope="col">
              名称
            </th>
            …
          </tr>
        </thead>
        <tbody class="mdx-table__body">
          <tr class="mdx-table__row" data-block-id="r1">
            <td class="mdx-table__cell" data-block-id="c3" data-align="left">id</td>
            …
          </tr>
        </tbody>
      </table>
    </div>
    <!-- 编辑态工具条：增删行列 -->
    <div class="mdx-table__controls" hidden>…</div>
  </div>
</div>
```

| class | 用途 |
|-------|------|
| `mdx-table-wrap` | 横向滚动容器 |
| `mdx-table` | 表 |
| `mdx-table__row` | 行 |
| `mdx-table__cell` | 格 |
| `mdx-table__cell--header` | th |
| `mdx-table__cell--editing` | 当前编辑格 |
| `mdx-table__cell--selected` | 多选格（P1） |
| `mdx-table__controls` | 行列操作 |

`data-align` ↔ `text-align` CSS。

---

## 6. 编辑交互（关键）

### 6.1 进入 / 退出

| 操作 | 行为 |
|------|------|
| Click 某 cell | 表块 `editing`；该 cell `--editing`；caret 在 inline 末或 hit |
| Click 表外 | 退出编辑；表回 reading |
| Esc | 先清 cell 编辑 → 表仍可选中 → 再 Esc 失焦 |

同时仅 **一个** cell 处于文本编辑。

### 6.2 单元格内

| 操作 | 行为 |
|------|------|
| 输入 | 改 `cell.content` |
| Enter | **不**在 cell 内换行；行为 = **移到下一行同列**（无则 `addRowBelow` 再移）——Notion 习惯；若产品选「禁止 Enter」，则 Enter 无操作。**本规格：Enter = 下一行同列，必要时增行** |
| Shift+Enter | v1 无硬换行；可忽略或插入空格 |
| Backspace 空 cell 首 | 不删表；停在格内 |
| Mod+B/I/E | 行内 marks |

### 6.3 Tab 导航

| 操作 | 行为 |
|------|------|
| Tab | 下一 cell：同行向右；行末 → 下一行首；**最后一格 Tab → 新增一行** 并进新行首格 |
| Shift+Tab | 上一 cell；首格 Shift+Tab → 焦点留在首格或走出表到前块（推荐 **留在首格**） |

顺序：行优先（row-major）。

### 6.4 方向键

- 在 cell **内容边界** 再按 ←/→/↑/↓ → 移到相邻 cell。
- 在内容中 → 移动 caret。

### 6.5 增删行列

**触发**：表 hover/选中时 `mdx-table__controls`，或块菜单。

| 命令 id | 行为 |
|---------|------|
| `table.addRowBelow` | 当前行下插空行（同列数） |
| `table.addRowAbove` | 上插 |
| `table.addColRight` | 当前列右插空列；`columnAligns` 插 `left` |
| `table.addColLeft` | 左插 |
| `table.deleteRow` | 删当前行；若只剩 header+0 body 则保留一行 body；**不可**删到 0 行 |
| `table.deleteCol` | 删当前列；至少留 1 列 |
| `table.toggleHeader` | P1：无 header 模式（serialize 仍可能伪造空头） |

**最少结构**：1 列 ×（1 header + 0..n body）；删除到极致保留 header 一行 + 可选一空 body。

### 6.6 选中整表 / 行 / 列

- P0：cell 编辑 + 整表块选中（拖拽用）。
- P1：行/列选择后批量清内容、删行列。

### 6.7 粘贴

| 源 | 行为 |
|----|------|
| 单 cell 文本 | 写入当前 cell |
| 多行 TSV / 多 cell HTML | P1：扩展行列填入 |
| 整段 MD pipe | 若选中整表可替换；P0 可当纯文本写入一格 |

---

## 7. Placeholder

- **单元格不显示中文占位**（避免表格视觉噪声）。
- 空表插入后 caret 落在 header 第一格；无字即可。
- 控件按钮 aria：`在下方插入行`、`在右侧插入列`、`删除行`、`删除列`。

---

## 8. 序列化边界与 round-trip 限制

### 8.1 保证语义往返

| 语义 | 往返 |
|------|------|
| 行列内容文本 | 是 |
| 列对齐 | 是 |
| header 行文本 | 是 |
| 行内 bold/italic/code/link | **尽力**；嵌套复杂 mark 可能归一 |
| 列宽、行高 | **否**（不进 MD） |
| 合并单元格 | **否** |
| cell 内多段落/列表 | **否**（压成 inline 或丢结构） |
| 前导/对齐空格美化 | 不保证；可 pretty-print 对齐竖线 |

### 8.2 危险字符

| 字符 | 策略 |
|------|------|
| `\|` | 写 `\|`；parse 时当字面量 |
| 换行 | → 空格 |
| 首尾 `\|` | 始终补齐 |
| HTML | 消毒；`<br>` 不当多行 cell |

### 8.3 畸形输入

```md
| a | b
| --- |
| 1 | 2 | 3 |
```

→ colCount = max(2,2,3) = 3；补空。

无分隔行的「像表」段落 → **不**当 table，当 paragraph（避免误伤）。

### 8.4 空表

所有 cell 空：

```md
|  |  |  |
| --- | --- | --- |
|  |  |  |
|  |  |  |
```

---

## 9. canMergeWith

`false`。表不与任何块文本合并。  
Backspace 在表前块末：焦点进表或删前块，**不**把表拆进 paragraph。

---

## 10. a11y

- 真 `<table>`、`th[scope=col]`。
- 编辑中 cell：`aria-selected` / 焦点可见。
- 控件按钮全部可键盘操作；快捷键说明进 `ux/`。
- 读屏：`表格，3 列 3 行`。

---

## 11. 状态机（实现锚）

```
idle (reading)
  --click cell--> editing(cellId)
  --select block--> selected (atom-like chrome)

editing(cellId)
  --Tab--> editing(next) | addRow + editing(newFirst)
  --Shift+Tab--> editing(prev)
  --Enter--> editing(below) | addRow + editing
  --Esc--> selected | idle
  --click outside--> idle
  --arrow at edge--> editing(neighbor)
```

---

## 12. 测试点

1. Fixture 表 MD → model → MD：文本与 align 一致。  
2. `insert.table` 得 3×(1+2)。  
3. Tab 扫过所有格；末格 Tab 增行。  
4. Enter 到下一行；末行 Enter 增行。  
5. addCol / deleteCol 不变量列齐。  
6. cell 内 `\|` 往返。  
7. 无分隔行的伪表不解析为 table。  
8. 性能：10×20 表编辑不重渲染整篇文档。

---

## 13. 分期

| 项 | 期 |
|----|-----|
| 解析/序列化 GFM、cell 编辑、Tab、默认增行 | **P0** |
| 显式增删行列控件 | **P0** |
| 对齐切换 UI | P1 |
| TSV 粘贴扩展 | P1 |
| 列宽拖拽 | P2 |
| 合并单元格 | v2 |
| 单元格嵌套 block | v2 |

---

## 14. 与其它文档

- Slash 面板只调 `insert.table` → 见 `05-slash-commands.md`。
- 拖整表 → `04-dnd-reorder.md`。
- 皮肤 → `07-visual-system.md`。
