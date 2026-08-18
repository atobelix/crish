# 03 — 表格全能力规格（含合并 / 单元格级编辑）

> **分册**：Markdown 编辑器 v3 · `v3-complete/03-table-advanced.md`  
> **状态**：冻结草案（实现前规格）  
> **读者**：schema / editor / table-chrome / serialize / 测试 agent  
> **硬约束**：见 [README U4 / U5](./README.md)  
> **真相源升级对象**：[`10-data-format.md` §3.3](../10-data-format.md)、[`blocks/table.md`](../blocks/table.md)、`js/markdown-editor/schema.js`、`editor.js`、`ui/table-chrome.js`  
> **交叉引用**：[05-motion-system.md](./05-motion-system.md)（动效）、[04-inline-marks-live.md](./04-inline-marks-live.md)（单元格内 marks）、[02-render-model.md](./02-render-model.md)

---

## 0. 产品冻结（本轮不可推翻）

### 0.1 用户原话释义（U4）

| 用户表述 | 正确产品解释 | 错误解释（禁止） |
|----------|--------------|------------------|
| 「编辑表格不用显示源代码用当前形式」 | 表块始终是 **结构化网格 UI**（`<table>` + chrome）；用户不进入「整表 pipe MD 源码框」 | 点进表后出现整段 `\| a \| b \|` 文本编辑器 |
| 「为什么不是细化到单元格」 | 选择 / 编辑粒度 **到单元格**；格内是 **WYSIWYG 内联编辑表面**（可有 bold/italic/code/link 等 runs）；可选高级「显示格内 raw MD」 | 只有整行字符串；或只有整表 MD；或必须打开源码才能改格式 |

**默认体验**：

1. **网格 UI**（行列可见、hover `+`、右键菜单、框选范围）。  
2. **单元格内** contenteditable 表面：渲染态 marks + 局部格式工具条（与全局 selection-toolbar 共用 marks 管道）。  
3. **可选高级**：单元格属性面板中的「显示/编辑 raw」开关（单格 MD 行内源，**非整表**）。默认关。  

### 0.2 必须做 / 明确不做

| 必须（v3 P0–P1） | 不做（本册范围外） |
|------------------|-------------------|
| 合并 / 拆分单元格（`rowspan` / `colspan`） | **完整 Notion Database**（人员类型、公式引擎、关联属性、看板视图） |
| 单元格 `text` + `runs` 双轨 | 单元格内嵌套多 block（list / code_block / 多 paragraph）——P3 占位 |
| 增删行列、对齐、表头、TSV 复制粘贴 | Excel 全保真样式 / 条件格式 |
| 拖列宽（可会话级；持久化进 `meta` / JSON Doc 可选） | 协同 OT/CRDT 表格锁 |
| 选择范围、合并预览、完整右键 IA | 筛选/排序作为 **Database 查询**；仅做 **视图层临时** 排序筛选（P2） |
| GFM export 时合并 **降级策略** 明确 | 声称 pipe MD 可无损表示合并表 |

人员列 / 公式列等：**P3 占位类型** 写在 `meta.columnTypes`，UI 灰显「即将支持」，**不实现引擎**。

---

## 1. 目标与成功标准

### 1.1 目标

1. 表格编辑 **永远** 是网格 + 单元格，不整表源码。  
2. 数据模型支持 **合并矩形** 与 **单元格级 runs**；运行时以 `cells[][]` 为真相，`rows` 为 plain 缓存。  
3. 功能从「能点 + / 右键几项」升级到「能用」：框选、合并、拆分、TSV、列宽、排序/筛选（视图）、完整菜单。  
4. 序列化：JSON Doc 完整保留合并；Markdown/GFM 按策略降级且 **可文档化、可测**。  
5. API 面清晰：`tableMerge` / `tableSplit` / … 可供 AI 端口与宿主调用。  

### 1.2 成功标准（摘要）

- 用户可框选 2×3 区域 → 合并 → 拆分 → GFM 导出后打开仍「可理解」且不崩溃。  
- 单元格内 `**粗**` 实时显示（见 04 册）；不因表格特殊路径退化为纯文本。  
- 验收用例 ≥40 全部可自动化或半自动。  
- 与 [05 动效册](./05-motion-system.md) 的 table chrome / 菜单 / 合并预览 token 对齐。  

---

## 2. 数据模型扩展

### 2.1 从 v2 到 v3

当前（v2，`10-data-format.md` §3.3 / `schema.js`）：

```ts
interface TableCellV2 {
  text: string;
  header?: boolean;
  align?: 'left' | 'center' | 'right';
  // rowspan/colspan 注释预留，未实现
}
```

v3 目标：

```ts
/** Doc.version 建议 3，或 version=2 + meta.tableModel='v3' 双读；实现优先 bump 到 3 并 migrate */
type ColAlign = 'left' | 'center' | 'right';

interface TextRun {
  text: string;
  marks?: TextMark[]; // 与全局 TextMark 一致：bold|italic|strike|code|link|…
}

/**
 * 逻辑网格中的一个「槽位」。
 * 合并：anchor 格持有内容 + rowspan/colspan；被覆盖槽位用 covered:true 占位（稀疏可选）。
 */
interface TableCell {
  /** 纯文本缓存；与 runs 同步。序列化 plain 时用 */
  text: string;
  /** 富文本；优先于 text 渲染与格内编辑。无 runs 时等价 [{ text }] */
  runs?: TextRun[];
  /** 表头语义（行 0 或列头扩展） */
  header?: boolean;
  /** 单元格级对齐覆盖；缺省继承列 align[c] */
  align?: ColAlign;
  /**
   * 合并：仅 anchor 写 >1；缺省 / 1 表示不合并。
   * 被覆盖格：要么不存在于 DOM，要么 model 中 { covered: true, anchor: { r, c } }
   */
  rowspan?: number; // >=1
  colspan?: number; // >=1
  /** 本槽被其它 anchor 覆盖 */
  covered?: boolean;
  /** 覆盖本槽的 anchor 坐标（covered=true 时必填） */
  anchor?: { r: number; c: number };
  /** 格级扩展：raw 编辑缓存、批注等 */
  meta?: Record<string, unknown>;
}

interface TableBlock {
  id: BlockId;
  type: 'table';
  indent: 0;
  text?: string; // 表级 plain 摘要可选，默认可 ''
  hasHeader?: boolean; // 默认 true
  /** 列对齐；长度 === colCount */
  align?: Array<ColAlign | null>;
  /**
   * 逻辑网格 cells[r][c]，矩形，所有行 length === colCount。
   * 合并后仍保留满矩形槽位（covered 占位），便于 index 稳定。
   */
  cells: TableCell[][];
  /**
   * plain 缓存：cellsToRows 导出；禁止单独作为合并真相。
   * 兼容旧代码路径；任何 mutation 后必须 sync。
   */
  rows?: string[][];
  /** 表标题 / caption（序列化 HTML 注释或段落约定，见 §2.7） */
  caption?: string;
  /**
   * 列宽（px 或 fr）；仅 JSON Doc / meta 持久化；GFM 丢弃。
   * length === colCount；0 / 缺省 = auto
   */
  colWidths?: number[];
  /**
   * 视图层状态（不进 GFM；进 JSON Doc 可选）
   */
  view?: TableViewState;
  meta?: {
    /** P3 占位：列类型 database-ish，不实现引擎 */
    columnTypes?: Array<'text' | 'number' | 'select' | 'person' | 'formula' | 'date' | null>;
    /** 导出策略覆盖 */
    mergeExport?: MergeExportMode;
    [k: string]: unknown;
  };
}

interface TableViewState {
  /** 临时排序：null = 文档序 */
  sort?: { col: number; dir: 'asc' | 'desc' } | null;
  /** 临时筛选：简单 contains；null = 全显示 */
  filter?: { col: number; query: string } | null;
  /** 隐藏列索引 */
  hiddenCols?: number[];
}
```

### 2.2 逻辑网格 vs 渲染网格

| 概念 | 定义 |
|------|------|
| **逻辑网格** | `cells[R][C]` 满矩形；坐标 `(r,c)` 稳定 |
| **Anchor 格** | `!covered && (rowspan>1 \|\| colspan>1 \|\| 正常 1×1 内容格)` |
| **Covered 槽** | `covered===true`，内容忽略；读写转发到 `anchor` |
| **渲染网格** | DOM 只输出 anchor 格，带 `rowspan`/`colspan` 属性；covered 不输出 `<td>` |

**不变量 I1–I8**：

1. **I1** 所有行 `cells[r].length === colCount ≥ 1`。  
2. **I2** `rowCount ≥ 1`；有 header 时 row0 为表头语义。  
3. **I3** 对任意 anchor `(r,c)`，矩形 `[r, r+rs) × [c, c+cs)` 内除 anchor 外全部 `covered` 且 `anchor` 指回 `(r,c)`。  
4. **I4** 合并矩形 **不得越界** 网格。  
5. **I5** 两个 anchor 的占用矩形 **不得重叠**。  
6. **I6** `rows[r][c] === plainText(cells[r][c])`（covered 槽 plain 建议 `''` 或与 anchor 同步策略二选一；**推荐 covered 为 `''`，export 用 anchor**）。  
7. **I7** `align.length === colCount`（mutation 后 `ensureAlignLen`）。  
8. **I8** `hasHeader===true` 时，合并矩形 **不得跨过 header/body 边界**（不得 `r=0` 的 rowspan 吃进 body，也不得 body 向上吃 header）。*例外产品开关 `meta.allowHeaderBodyMerge===true` 默认 false。*

### 2.3 合并约束（算法级）

```
canMerge(block, r0, c0, r1, c1) → { ok: boolean, reason?: string }
```

规则：

| # | 规则 | 失败 reason |
|---|------|-------------|
| M1 | 归一化选区为 `r0≤r1, c0≤c1` | — |
| M2 | 至少 2 格（`(r1-r0+1)*(c1-c0+1) ≥ 2`） | `single-cell` |
| M3 | 选区内每个逻辑槽：要么未合并 1×1，要么其完整 anchor 矩形 **完全落在** 选区内 | `partial-merge` |
| M4 | 合并后将选区变为单一 anchor：内容 = 选区内所有非空 plain/runs **按阅读序拼接**（见 §2.4） | — |
| M5 | 遵守 I8 header/body | `cross-header` |
| M6 | 视图排序/筛选激活时：默认 **禁用合并** 或先「退出视图态」 | `view-active` |

**拆分 `tableSplit(block, r, c)`**：

- `(r,c)` 必须是 anchor。  
- 若 `rowspan===1 && colspan===1` → no-op。  
- 将矩形拆回 1×1：anchor 保留内容；其余槽 `covered=false`，`text:''`，`runs` 删除，`rowspan/colspan=1`。  

**部分拆分（P2）**：`tableSplit(block, r, c, { mode: 'row' | 'col' | 'all' })`。P0 仅 `all`。

### 2.4 合并时内容合并策略

```
readingOrder(cells in rect): row-major, skip covered
join:
  texts = nonEmpty plain of each anchor in order
  runs  = concat runs with optional separator run { text: ' ' } 或 '\n'（表内禁止真换行时用 ' · '）
默认 separator = ' '（空格）
meta.mergeJoin = 'space' | 'dot' | 'slash' | 'none'
```

冲突 marks：简单 concat，不尝试智能去重。

### 2.5 `rows` 兼容与 sync

```js
function plainOfCell(cell) {
  if (!cell || cell.covered) return '';
  if (cell.runs && cell.runs.length)
    return cell.runs.map(r => r.text || '').join('');
  return cell.text != null ? String(cell.text) : '';
}

function cellsToRows(cells) {
  return cells.map(row => row.map(plainOfCell));
}

function syncRows(block) {
  block.rows = cellsToRows(block.cells);
  return block;
}
```

旧路径只写 `rows`：`migrate` / `createBlock` 转 `cells`，**丢失** rowspan/colspan（全 1×1）。  
只写 `cells`：必须 `syncRows`。

### 2.6 列宽 / 视图态持久化

| 字段 | JSON Doc | GFM MD | 说明 |
|------|----------|--------|------|
| `cells` 含 merge/runs | ✅ | 部分（见 §3） | 运行时真相 |
| `align` | ✅ | ✅ 分隔行 | |
| `colWidths` | ✅ | ❌ | 可写 HTML comment 可选扩展 |
| `view` | 可选 | ❌ | 会话可只放内存 |
| `caption` | ✅ | 表后斜体段落或 `<!-- mdx-table-caption:… -->` | 产品选一种写死 |

### 2.7 版本与 migrate

```ts
// migrate v2 → v3 table
function migrateTableCell(c: TableCellV2): TableCell {
  return {
    text: c.text || '',
    header: c.header,
    align: c.align,
    rowspan: 1,
    colspan: 1,
    // runs 缺省；后续 parse inline 可填
  };
}
```

- `doc.version: 2` 且无 rowspan → 读时惰性当 1×1。  
- 写出若启用合并 → `version: 3` 或 `meta.features.tableMerge = true`。  

---

## 3. 序列化：JSON 完整 / GFM 降级

### 3.1 JSON Doc（无损）

完整写出 `cells`（含 `runs`、`rowspan`、`colspan`、`covered`、`anchor`）。  
推荐写 covered 占位以简化加载校验；也可稀疏存储，加载时 `recomputeCovered(block)`。

### 3.2 GFM pipe 限制

GFM 表格 **无** `rowspan`/`colspan` 标准语法。  
因此：**任何合并表导出到 pure GFM 必降级**。

### 3.3 降级模式 `MergeExportMode`

```ts
type MergeExportMode =
  | 'expand-repeat'   // 默认：逻辑网格展开，anchor 文本填满矩形每个 pipe 格
  | 'expand-blank'    // anchor 只写左上，其余 pipe 格空
  | 'html-table'      // 输出 HTML <table>（GFM 多数渲染器支持 inline HTML）
  | 'conex-fence';    // ```conex-table JSON``` 围栏（pure-gfm 关闭时）
  | 'annotate';        // expand-blank + 表后注释说明曾合并
  ;
```

**默认**：`mode==='conex'` → 优先 `html-table`（保留合并视觉）或 `conex-fence` 若宿主关闭 HTML；  
`mode==='pure-gfm'` → **强制** `expand-repeat` 或 `expand-blank`（配置，默认 `expand-repeat`）。

#### 3.3.1 `expand-repeat` 算法

```
for r in 0..R-1:
  for c in 0..C-1:
    cell = cells[r][c]
    if cell.covered:
      pipe[r][c] = plainOfCell(cells[anchor.r][anchor.c])  // 重复
    else:
      pipe[r][c] = serializeInline(cell)  // runs → md marks；转义 |
```

Round-trip：**合并信息丢失**，变成重复文本的独立格。  
文档/UI 应在 pure-gfm 导出前提示。

#### 3.3.2 `expand-blank`

Covered → `''`；仅 anchor 有文本。语义更接近「合并」但再导入不会自动合并。

#### 3.3.3 `html-table`

```html
<table>
  <thead>…</thead>
  <tbody>
    <tr>
      <td rowspan="2" colspan="2">合并内容</td>
      <td>…</td>
    </tr>
    …
  </tbody>
</table>
```

- 内联 marks → 对应 `<strong>` 等（已消毒）。  
- Parse：若 HTML table 含 rowspan/colspan → **重建** cells 模型（P1 必须）。  
- pure-gfm 宿主可禁用。

#### 3.3.4 `conex-fence`

````md
```conex-table
{"hasHeader":true,"align":["left"],"cells":[...]}
```
````

往返无损；GitHub 上显示为代码块。适合 Conex 内部。

### 3.4 列对齐序列化

分隔行：

| align | 片段 |
|-------|------|
| left | `---`, `:---` |
| center | `:---:` |
| right | `---:` |

当前实现 **未** 写 align 到 sep（差距，见 §8）——v3 必须写。

### 3.5 单元格内联序列化

- 优先 `runs` → MD marks（与全局 serialize 一致）。  
- 无 runs 用 `text`；若 text 含未解析 `**` 可保持字面。  
- `|` → `\|`；`\n` → 空格。  
- covered 不输出独立语义（随 mode）。

### 3.6 解析（import）

| 输入 | 结果 |
|------|------|
| GFM pipe | 满 1×1 cells；sep → `align`；header 行 `header:true` |
| HTML table | 解析 rowspan/colspan → covered 矩阵 |
| `conex-table` fence | JSON → block |
| 畸形 pipe | 与现网一致：无 sep 不当表 |

Parse 后跑 `normalizeTable(block)`：补齐矩形、`recomputeCovered`、校验 I1–I8，失败则拆成全 1×1 并 `meta.repair: 'merge-invalid'`。

---

## 4. 功能矩阵

### 4.1 总表

| ID | 功能 | 优先级 | 现状 | v3 目标 |
|----|------|--------|------|---------|
| F01 | 插入默认表 3×(1h+2b) | P0 | ✅ slash | 保持；cells 含 runs 空 |
| F02 | 单元格点击编辑（网格） | P0 | ✅ contenteditable plain | + runs WYSIWYG |
| F03 | 非整表 MD 源码 | P0 | ✅ | 冻结 |
| F04 | 单元格内 inline marks | P0 | ⚠️ 读态 inlineHtml；编态 esc 纯文本 | 编态实时 marks |
| F05 | 单元格 raw 高级开关 | P2 | ❌ | 单格 raw |
| F06 | Hover `+` 加行/列 | P0 | ✅ | 保持；动效见 05 |
| F07 | 右键：插行/列、删行/列 | P0 | ✅ 分 header/body 面板 | 统一 IA + 更多项 |
| F08 | 列对齐 L/C/R | P0 | ⚠️ 菜单有；serialize 丢 | 写 sep + DOM |
| F09 | 清空单元格 | P0 | ✅ | + 清 runs |
| F10 | 复制单元格文本 | P0 | ✅ | + 复制 runs/TSV |
| F11 | Tab / Shift+Tab 导航 | P0 | ✅ 基础 | 跳过 covered；合并格算一格 |
| F12 | Enter → 下行同列 | P0 | ❌ 未做 | 必须；末行增行 |
| F13 | 方向键边界穿格 | P1 | ❌ | 必须 |
| F14 | 框选范围 | P0 | ⚠️ CSS 有 `.is-selected` 未接线 | pointer 拖选 |
| F15 | 合并单元格 | P0 | ❌ | tableMerge |
| F16 | 拆分单元格 | P0 | ❌ | tableSplit |
| F17 | 合并预览高亮 | P0 | ❌ | 选区 rect overlay |
| F18 | 拖列宽 | P1 | ❌ | colWidths + handle |
| F19 | 表头切换 | P1 | ⚠️ hasHeader 字段；无 UI | 菜单 toggle |
| F20 | 复制 TSV（多格） | P0 | ❌ | clipboard |
| F21 | 粘贴 TSV 扩展表 | P0 | ❌ | 扩行列填入 |
| F22 | 粘贴 HTML table | P1 | ❌ | 含 merge 尽力 |
| F23 | 排序（视图） | P2 | ❌ | 不改文档序可选「写回」 |
| F24 | 筛选（视图） | P2 | ❌ | contains |
| F25 | 隐藏列 | P2 | ❌ | view.hiddenCols |
| F26 | 行/列选择手柄 | P1 | ❌ | 顶/左 gutter |
| F27 | 整表选择 | P1 | 块选有限 | chrome 框 |
| F28 | 删除表 | P0 | 块级删除路径 | 菜单项 |
| F29 | caption | P2 | 字段预留 | UI |
| F30 | 列类型 P3 占位 | P3 | ❌ | 灰显 |
| F31 | 撤销/重做结构变更 | P0 | ⚠️ mutation 进 history；输入 addToHistory:false | 输入 debounce 合并 |
| F32 | a11y 表角色/读屏 | P1 | 部分 th scope | 完整 |
| F33 | viewOnly 无 chrome | P0 | ✅ CSS | 保持 |
| F34 | 移动端长按菜单 | P2 | ❌ | contextmenu 等价 |

### 4.2 右键菜单完整 IA（Information Architecture）

**统一菜单**（不再严格 header/body 二分；按上下文 **启用/禁用** 项）：

```
┌─────────────────────────────┐
│ 在上方插入行                 │
│ 在下方插入行                 │
│ 删除行                   ░危险 │
│ ───────────                 │
│ 在左侧插入列                 │
│ 在右侧插入列                 │
│ 删除列                   ░危险 │
│ ───────────                 │
│ 对齐                   ›    │ → 左 / 中 / 右（列）
│ 切换表头行               ☑   │  // 仅当 row===0 或整表
│ ───────────                 │
│ 合并单元格                   │  // 选区≥2 且 canMerge
│ 拆分单元格                   │  // anchor 且 rs|cs>1
│ ───────────                 │
│ 清空内容                     │
│ 复制                         │  // 单格文本 / 多格 TSV
│ 粘贴                         │  // 若 clipboard 可读
│ 复制 TSV                     │
│ ───────────                 │
│ 排序 A→Z / Z→A          ›   │  // P2 视图
│ 按本列筛选…                  │  // P2
│ ───────────                 │
│ 显示单元格 Markdown     ☑   │  // P2 高级 raw
│ 删除表格                 ░危险 │
└─────────────────────────────┘
```

**禁用规则**：

| 项 | disabled 当 |
|----|-------------|
| 删除行 | `rowCount≤1` 或（header-only 策略保留 1 body） |
| 删除列 | `colCount≤1` |
| 合并 | `!canMerge` 或 view 排序中 |
| 拆分 | 非 anchor 或 1×1 |
| 粘贴 | 无 clipboard 权限且无内部 paste buffer |

**表头单元格**与 **body** 共用结构；`切换表头行` 在任意格可点（作用于整表 `hasHeader`）。

### 4.3 工具条 / chrome 控件

| 控件 | 位置 | 行为 |
|------|------|------|
| `+` 列 | wrap 右侧中 | `tableAddCol` 末尾 |
| `+` 行 | wrap 底边中 | `tableAddRow` 末尾 |
| 列宽拖杆 | 每列右边界 | 改 `colWidths[c]` |
| 列选择条 | 表头上方（hover） | 选整列 |
| 行选择条 | 行左侧（hover） | 选整行 |
| 浮动 mini bar | 选区上方（多选时） | 合并 / 对齐 / 粗斜体 |

禁止恢复文字按钮「加行」「加列」（D10 / `table.css` 已藏 `.mdx-table-tools`）。

---

## 5. 交互规格

### 5.1 状态机

```
table_idle (reading 网格)
  | click cell        → cell_editing(r,c)
  | pointerdown cell + drag → selecting → selected_range
  | click gutter row/col → selected_row / selected_col
  | contextmenu       → menu_open (基于 hit cell / 选区)

cell_editing
  | input             → update cell runs/text (debounce history)
  | Tab / S-Tab       → 邻格 editing（跳过 covered）
  | Enter             → 下行同列 anchor；无则 addRow + focus
  | Shift+Enter       → 忽略或插入空格（v3：插入空格）
  | Arrow @ edge      → 邻格
  | pointer drag out  → selecting
  | Esc               → selected_range(单格) 或 table_idle
  | click outside table → table_idle；commit

selected_range
  | Merge 命令        → tableMerge；选区变单 anchor；editing 可选
  | Split             → tableSplit
  | Copy              → TSV
  | Delete/Backspace  → 清空选区所有 anchor 内容
  | 方向键            → 移动选区锚点
  | Enter/F2          → cell_editing 焦点锚格

menu_open
  | pick              → action + close
  | Esc / outside     → close
```

### 5.2 Hover `+`

- 默认 `opacity:0`；`:hover` / `.is-chrome-open` / 焦点在表内 → 显示。  
- 动效：**05 册** `motion.tableChromeFade`（约 120ms opacity）。  
- 键盘：表 focused 时 `Alt+=` 加行、`Alt+Shift+=` 加列（可选，写进 keyboard-map）。  

### 5.3 选择范围

**指针**：

1. `pointerdown` 在 cell → `anchor = (r,c)`，`focus = (r,c)`。  
2. `pointermove` 过其它 cell（hitTest 逻辑坐标，合并格用 anchor 坐标）→ 更新 `focus`。  
3. `pointerup` → `selected_range = normalize(anchor, focus)`。  
4. 单击无拖动 → 进入 `cell_editing`（与 Notion 类似：第一次选中，第二次或立即编辑——**本规格：mousedown 编辑，拖动超过 3px 转选择**）。  

**键盘扩展选区**：`Shift+Arrow` 扩展 focus 角。

**视觉**：

- `.mdx-td.is-selected` 填充（已有 CSS 变量）。  
- 合并预览：若用户执行合并前，选区矩形加 `.mdx-table__merge-preview` 虚线框（05 册 stroke 动画可选）。  

**逻辑坐标 hitTest**：

```
DOM td[data-r][data-c] → 若 model covered，映射到 anchor
选区包含整个 merge 矩形（选中 covered 即选中全 anchor 矩形）
```

### 5.4 合并预览

- 仅当 `canMerge` 时工具条「合并」高亮。  
- Hover 合并按钮：选区 overlay 加深 + 角标「将合并为 1 格」。  
- `!canMerge`：按钮 disabled + tooltip 显示 `reason` 中文（如「不能跨越表头与表体」）。  

### 5.5 键盘完整表

| 按键 | 上下文 | 行为 |
|------|--------|------|
| Tab | editing | 下一 **可见 anchor** 格；末格加行 |
| Shift+Tab | editing | 上一 anchor；首格停住 |
| Enter | editing | 下方同行列 anchor；无则加行 |
| Shift+Enter | editing | 插入空格（不换行） |
| Esc | editing | 退出到选中单格 |
| Esc | selected | 清选区 → idle |
| Esc | menu | 关菜单 |
| ↑↓←→ | editing @ 内容边界 | 穿格到邻 anchor |
| ↑↓←→ | selected | 移动选区 |
| Shift+↑↓←→ | selected/editing | 扩展选区 |
| Mod+A | editing | 先选满格文本；再按选满表 |
| Mod+C | selected | 复制 TSV |
| Mod+V | editing/selected | 粘贴 TSV/纯文本 |
| Mod+B/I/E | editing 有选字 | marks（04 册） |
| Backspace | selected 多格 | 清空内容不删结构 |
| Backspace | editing 空格首 | 停在格内（不删表） |
| Delete | 同 Backspace | |
| Alt+Shift+M | selected | 合并 |
| Alt+Shift+S | anchor | 拆分 |
| F2 | selected | 进入 editing |
| ContextMenu 键 | focus cell | 开菜单 |

### 5.6 复制粘贴

**复制**：

```
单格: plain text + text/html 片段 <td>…
多格: text/plain = TSV (tab 分隔，\n 行)；text/html = <table> 片段
内部 buffer: { type:'mdx-table-slice', cells, merges }
```

合并格 TSV：`expand-blank` 语义（左上有值，其余空）或 `expand-repeat`——**默认 blank** 以免重复。

**粘贴**：

| 剪贴板 | 行为 |
|--------|------|
| 单行无 tab | 写入当前格（可带 inline parse） |
| 多格 TSV | 从当前格起覆盖；不足则 `tableAddRow/Col` |
| HTML table | 解析 grid；尽量保留 merge |
| 整表 MD pipe | 若选中整表可替换；否则当文本 |

粘贴 **不** 默认拆开已有 merge，除非覆盖范围与 merge 部分相交 → 先 split 相交 anchor（安全策略）。

### 5.7 列宽拖拽

- handle 在列边界；`pointerdown` → 拖 → `colWidths[c] = clamp(min=56, max=480, x)`。  
- 双击 handle → 该列 auto。  
- 持久化：JSON Doc；MD 丢失。  

### 5.8 排序 / 筛选（P2 视图层）

- **排序**：只改 DOM 呈现顺序或使用 `view.sort` 映射；默认 **不写回** `cells` 行序。菜单「写回文档顺序」显式确认。  
- **筛选**：隐藏不匹配行（header 始终显示）；清空筛选恢复。  
- 激活 view 时：合并/插行 **警告** 或禁用（M6）。  

### 5.9 单元格级编辑表面（核心 UX）

```
┌──────────────────────────────┐
│  th / td                     │
│  ┌────────────────────────┐  │
│  │  WYSIWYG inline surface │  │  ← 默认：runs 渲染，contenteditable
│  │  **粗** 与 _斜_ 实时    │  │
│  └────────────────────────┘  │
│  [可选 raw] | **粗** 与 _斜_ |  │  ← meta.cellEditMode='raw'
└──────────────────────────────┘
```

- **禁止** 用单个 `<textarea>` 包整张表。  
- 读态：`inlineHtml(runs|text)`。  
- 编态：与 04 册 live marks 同一 pipeline；`tableSetCellRuns`。  
- 高级 raw：仅当前格；blur 时 parse 回 runs。  

---

## 6. 动效要求（挂钩 05 册）

> 细节 token / easing 以 [05-motion-system.md](./05-motion-system.md) 为准；本册只定 **触点与语义**。

| 触点 | 动效 ID（建议） | 语义 | reduced-motion |
|------|-----------------|------|----------------|
| `+` 显隐 | `table.chromeFade` | opacity 0→1，120ms | 瞬间切换 |
| 右键菜单 | `menu.open` | opacity + 2px translateY | 无位移 |
| 选区填充 | `table.selFill` | background 80ms | 可关 |
| 合并预览框 | `table.mergePreview` | border-opacity 脉冲可选 | 静态虚线 |
| 合并执行 | `table.mergeCommit` | 选区收缩到 anchor 120–160ms | 瞬切 |
| 拆分 | `table.splitCommit` | 格线显现 | 瞬切 |
| 增行/列 | `table.rowInsert` | 新行高度 0→auto（max-height） | 瞬切 |
| 删行/列 | `table.rowRemove` | 反向 | 瞬切 |
| 列宽拖 | 无弹簧；跟手 1:1 | | — |
| 排序行重排 | `table.reorder` | 行 FLIP 200ms P2 | 瞬切 |

CSS 钩子（扩展 `table.css`）：

```
.mdx-table-wrap.is-chrome-open
.mdx-td.is-selected
.mdx-td.is-merge-preview
.mdx-table.is-anim-merge
.mdx-ctx-menu.is-visible
```

实现 agent 不得在 JS 里写死另一套 duration，应对齐 05 的 CSS 变量，例如：

```css
--mdx-motion-table-chrome: 120ms;
--mdx-motion-table-merge: 160ms;
```

---

## 7. DOM / CSS 契约

### 7.1 编辑态 DOM（目标）

```html
<div class="mdx-table-wrap is-chrome-open" data-block-id="b_xxx">
  <div class="mdx-table-col-guides" aria-hidden="true"><!-- 列宽 handle --></div>
  <table class="mdx-table is-editing" role="grid" aria-rowcount="R" aria-colcount="C">
    <thead><!-- hasHeader -->
      <tr class="mdx-table__row" data-r="0" role="row">
        <th class="mdx-td mdx-table__cell mdx-table__cell--header is-focused"
            role="gridcell" contenteditable="true"
            data-r="0" data-c="0" data-align="left"
            rowspan="1" colspan="2"
            scope="col">…</th>
        <!-- covered (0,1) 不输出 -->
      </tr>
    </thead>
    <tbody>
      <tr data-r="1">…</tr>
    </tbody>
  </table>
  <button type="button" class="mdx-table-add-col" aria-label="添加列">+</button>
  <button type="button" class="mdx-table-add-row" aria-label="添加行">+</button>
  <div class="mdx-table-range" hidden><!-- 选区 overlay --></div>
</div>
```

### 7.2 data 属性

| 属性 | 说明 |
|------|------|
| `data-r` / `data-c` | 逻辑坐标（anchor） |
| `data-align` | left/center/right |
| `data-rowspan` / `data-colspan` | 与属性同步冗余，便于 CSS |
| `aria-selected` | 选中格 |
| `aria-rowspan` / `aria-colspan` | a11y |

### 7.3 类名

| 类 | 含义 |
|----|------|
| `.mdx-td.is-focused` | 正在编辑 |
| `.mdx-td.is-selected` | 在选区内 |
| `.mdx-td.is-merge-preview` | 合并预览 |
| `.mdx-table__cell--header` | 表头 |
| `.mdx-table-add-col/row` | chrome + |
| `.mdx-ctx-menu` | 右键 |

---

## 8. 当前实现差距（逐函数）

路径根：`C:\Software\conex\reference\chat-composer-component\js\markdown-editor\`

### 8.1 `schema.js`

| 函数 | 现状 | 差距 | v3 改造 |
|------|------|------|---------|
| `createBlock` | table 默认 3×3 cells；`text/header/align` only | 无 rowspan/colspan/runs/covered | 默认填 `rowspan:1,colspan:1`；接受 runs |
| `rowsToCells` | string/object → `{text,header,align}` | 丢 merge/runs | 映射保留字段；string → 1×1 |
| `cellsToRows` | 只取 `c.text` | 忽略 runs/covered | 用 `plainOfCell` |
| `cloneCells` | 浅拷贝三字段 | 丢 merge/runs/meta | 深拷贝全字段 |
| `ensureTableShape` | 保证有 cells+rows | 不校验矩形/merge | + `normalizeTable` |
| `tableAddRow` | splice 空 `{text:''}` | 不处理跨行 merge | 穿过 rowspan 时扩展 covered / 禁止在矩形中部插入时破坏 I3——**插入时 split 相交 merge 或扩展 anchor**（规格：插行默认 **split 所有跨该缝的 rowspan**） |
| `tableAddCol` | 类似 | 同左 colspan | 同：跨缝 colspan split |
| `tableRemoveRow` | splice；最少 1 行 | 不处理 merge | 删前 split 涉及行 |
| `tableRemoveCol` | 同 | 同 | 删前 split |
| `tableSetCell` | 只设 text | 无 runs；可写 covered | `tableSetCell(block,r,c,text\|{text,runs})`；covered 转发 anchor |
| — | **缺失** | — | `tableMerge` / `tableSplit` / `canMerge` / `recomputeCovered` / `tableSetAlign` / `tableSetHeader` / `tableFromTSV` / `tableToTSV` |

### 8.2 `ui/table-chrome.js`

| 函数 | 现状 | 差距 | v3 |
|------|------|------|-----|
| `ensureMenuEl` / `openContextMenu` / `closeContextMenu` | 通用菜单 | 无 submenu、无 checkbox 项 | 扩展 item 类型：`sep` / `label` / `check` / `submenu` / `danger` |
| `headerMenuItems` | 插列/删列/对齐 | 无合并、TSV、表头切换 | 替换为 §4.2 完整 IA |
| `bodyMenuItems` | 插行/删行/清空/复制 | 同上 | 合并 |
| `cellMeta` | r,c,isHeader | 无选区感知 | + `getSelection()` 注入 |
| `enhance` | + 行/列 + contextmenu | 无框选、无 col resize、无 row/col gutter | 增加 selection controller 钩子或拆 `table-selection.js` |
| `destroy` | 清按钮与监听 | — | 同步清 selection/handles |
| `MdxContextMenu` | open/close | 无键盘在菜单内上下 | 方向键 + Enter |

### 8.3 `editor.js`（表格相关闭包函数）

| 函数 | 现状 | 差距 | v3 |
|------|------|------|-----|
| `tableRowsOf` | rows 优先否则 cellsToRows | 应用 plainOfCell | 对齐 schema |
| `renderTableHtml` | 双层 for 输出所有格；编态 `esc` 纯文本 | **无 rowspan/colspan**；编态无 runs；无 thead 分离可选 | 跳过 covered；属性 rs/cs；编态 live inline surface |
| `readTableFromDom` | 读 contenteditable → rows/cells text | 丢 marks/merge | 读 data-r/c + 内联 HTML→runs；merge 从 model 保留 |
| `applyTableMutation` | DOM commit → mutator → enterEdit 全量重渲 | 每次结构变更整表重挂 chrome | 可接受 P0；P1 局部 patch DOM |
| `destroyTableChromeIn` | destroy wrap | — | + selection |
| `handleTableContextAction` | 插删行列/对齐/清空/复制文本 | 无 merge/split/TSV/表头/删表 | 接满 IA |
| `ensureAlignLen` | 补 left | serialize 未用 | 保留；serialize 修 |
| `commitTable` / `commitActiveFromDom` | 写 rows+cells | 无 runs | patch runs |
| `enterEdit` table 分支 | 绑 input→tableSetCell 纯文本；chrome enhance；Tab 在 onTableKeydown | 无框选、Enter、箭头、paste | 补齐 §5 |
| `onTableKeydown` | 仅 Tab / Esc | 缺 Enter/箭头/Mod+C/V/合并快捷键 | 完整 |
| slash 插表 | 固定中文「列 1…」 | 可 i18n | 可配置 |

### 8.4 `parse.js`

| 逻辑 | 现状 | 差距 |
|------|------|------|
| pipe 表识别 | header+sep+body → rows | 不解析 align 分隔符 `:` |
| HTML table | 无 | 需 P1 |
| conex-table fence | 无 | 需 P1 |
| 单元格 inline → runs | 无（整格 string） | 接 inline parse |

### 8.5 `serialize.js`

| 逻辑 | 现状 | 差距 |
|------|------|------|
| `case 'table'` | 用 rows；sep 全是 `---` | **忽略 align**；忽略 cells.runs；忽略 merge |
| escape | `escapeTableCell` | 保持；+ runs 序列化 |
| 导出模式 | 无 | `MergeExportMode` 分支 |

### 8.6 `model.js`

| 逻辑 | 现状 | 差距 |
|------|------|------|
| `updateBlock` rows/cells 互斥删除 | 有 | merge 字段随 cells 整表替换即可；注意 history 深拷贝 `cloneCells` 必须完整 |

### 8.7 `css/markdown-editor/table.css`

| 现状 | 差距 |
|------|------|
| wrap/+ 按钮/菜单/selected/focus 已有 | 缺：col resize handle、row/col gutter、merge-preview、range overlay、insert 动画类 |

### 8.8 `blocks/table.md` / `10-data-format.md`

| 现状 | 差距 |
|------|------|
| 明确非目标含 colspan；§3.3 注释预留 | **本册覆盖**；实现后回写 10 与 blocks/table，冲突以 v3-complete + U4 为准 |

### 8.9 `selection-toolbar.js`

| 现状 | 差距 |
|------|------|
| 支持 contenteditable 含表格单元格 | 多选格时应变「表浮动条」；单格选字时 marks——需与 table selection 协调 |

---

## 9. API 规格

### 9.1 Schema / Model 层（纯函数，可单测）

```ts
/** 均 mutate block 并 return block；调用方负责 history */

function ensureTableShape(block: Block): Block;
function normalizeTable(block: Block): Block; // I1–I8 + recomputeCovered

function plainOfCell(cell: TableCell): string;
function cellsToRows(cells: TableCell[][]): string[][];
function syncRows(block: Block): Block;

function tableAddRow(block: Block, atIndex?: number): Block;
function tableAddCol(block: Block, atIndex?: number): Block;
function tableRemoveRow(block: Block, rowIndex: number): Block;
function tableRemoveCol(block: Block, colIndex: number): Block;

function tableSetCell(
  block: Block,
  r: number,
  c: number,
  value: string | { text?: string; runs?: TextRun[] }
): Block;

function tableSetCellAlign(block: Block, r: number, c: number, align: ColAlign): Block;
function tableSetColAlign(block: Block, c: number, align: ColAlign): Block;
function tableSetHeader(block: Block, hasHeader: boolean): Block;

function tableClearRange(
  block: Block,
  r0: number, c0: number, r1: number, c1: number
): Block;

/**
 * 合并选区 [r0,c0]–[r1,c1]（含端点）为单一 anchor @ 左上。
 * 失败 throw 或 return { ok:false, reason }——实现选一种；推荐 Result。
 */
function tableMerge(
  block: Block,
  r: number,
  c: number,
  rowSpan: number,
  colSpan: number
): Block;
// 语义：anchor=(r,c)，占用 rowSpan×colSpan；等价选区 (r,c)–(r+rowSpan-1,c+colSpan-1)

function canMerge(
  block: Block,
  r: number,
  c: number,
  rowSpan: number,
  colSpan: number
): { ok: true } | { ok: false; reason: string };

/**
 * 拆分 anchor (r,c) 覆盖的矩形为 1×1。
 * 若 (r,c) 为 covered，先解析到 anchor 再拆。
 */
function tableSplit(block: Block, r: number, c: number, opts?: { mode?: 'all' | 'row' | 'col' }): Block;

function recomputeCovered(block: Block): Block;

function tableToTSV(block: Block, range?: Rect, mode?: 'blank' | 'repeat'): string;
function tableFromTSV(tsv: string): TableCell[][]; // 无 merge

function tableMapRange(
  block: Block,
  r0: number, c0: number, r1: number, c1: number,
  fn: (cell: TableCell, r: number, c: number) => void
): void;
```

**`tableMerge` 伪代码**：

```
function tableMerge(block, r, c, rowSpan, colSpan):
  assert rowSpan>=1 && colSpan>=1
  if rowSpan===1 && colSpan===1: return block
  check = canMerge(block, r, c, rowSpan, colSpan)
  if !check.ok: throw MergeError(check.reason)

  // 收集内容
  runs = []
  for each (ri,ci) in rect:
    cell = block.cells[ri][ci]
    if cell.covered: continue
    // 若已是更大 merge，其矩形必在选内（canMerge 保证）
    append non-empty runs/text to runs with separator

  // 清空矩形
  for each (ri,ci) in rect:
    if ri===r && ci===c:
      block.cells[ri][ci] = {
        text: plain(runs),
        runs: runs.length ? runs : undefined,
        header: block.cells[r][c].header,
        align: block.cells[r][c].align,
        rowspan: rowSpan,
        colspan: colSpan,
        covered: false
      }
    else:
      block.cells[ri][ci] = {
        text: '',
        covered: true,
        anchor: { r, c },
        rowspan: 1,
        colspan: 1
      }

  return syncRows(block)
```

**`tableSplit` 伪代码**：

```
function tableSplit(block, r, c):
  cell = resolveAnchor(block, r, c)
  (ar, ac) = anchor coords
  rs = cell.rowspan || 1
  cs = cell.colspan || 1
  if rs===1 && cs===1: return block
  content = { text, runs, header, align } from anchor
  for ri in ar..ar+rs-1:
    for ci in ac..ac+cs-1:
      if ri===ar && ci===ac:
        block.cells[ri][ci] = { ...content, rowspan:1, colspan:1, covered:false }
      else:
        block.cells[ri][ci] = { text:'', rowspan:1, colspan:1, covered:false }
  return syncRows(block)
```

### 9.2 Editor 命令层（给 slash / 菜单 / AI）

```ts
type TableCommand =
  | { type: 'table.addRow'; id: BlockId; at?: number }
  | { type: 'table.addCol'; id: BlockId; at?: number }
  | { type: 'table.removeRow'; id: BlockId; row: number }
  | { type: 'table.removeCol'; id: BlockId; col: number }
  | { type: 'table.setCell'; id: BlockId; r: number; c: number; text?: string; runs?: TextRun[] }
  | { type: 'table.merge'; id: BlockId; r: number; c: number; rowSpan: number; colSpan: number }
  | { type: 'table.split'; id: BlockId; r: number; c: number }
  | { type: 'table.setColAlign'; id: BlockId; col: number; align: ColAlign }
  | { type: 'table.toggleHeader'; id: BlockId }
  | { type: 'table.clearRange'; id: BlockId; range: Rect }
  | { type: 'table.pasteTSV'; id: BlockId; r: number; c: number; tsv: string }
  | { type: 'table.setColWidth'; id: BlockId; col: number; width: number | null }
  ;
```

宿主 / AI：

```ts
editor.exec(command: TableCommand): void;
// 或
editor.table.merge(blockId, r, c, rowSpan, colSpan);
editor.table.split(blockId, r, c);
```

### 9.3 导出 API

```ts
interface SerializeTableOptions {
  mergeMode?: MergeExportMode;
  pureGfm?: boolean;
}

// serialize.js 内
function serializeTable(block: Block, opts?: SerializeTableOptions): string;
```

---

## 10. 增删行列与合并的交叉规则（实现必读）

| 操作 | 规则 |
|------|------|
| 在行缝 `i` 上方插行 | 所有 `rowspan` 跨过缝 `i` 的 anchor → **先按缝 split 行方向** 或 **rowspan+1 且新行对应列 covered**（二选一；**推荐 P0：split 跨缝 merge**，行为可预期） |
| 删行 `i` | 若 anchor 在该行：删除整个 merge 内容（或先 split）；若 covered：anchor.rowspan-- 并 recompute |
| 插列/删列 | 对称 colspan |
| P0 简化策略 | **任何插删行列前：`splitAllMergesIntersecting(block, band)`**，再改结构，再 normalize |

推荐 P0 全部走「先 split 再结构变更」，P1 再做「智能扩展 rowspan」。

---

## 11. 性能

| 场景 | 要求 |
|------|------|
| 20×30 表编辑单格 | 禁止 `fullRender` 全文；仅表块 reconcile |
| 输入 | `updateBlock` 可 debounce history 300ms；model 文本即时 |
| 框选 | pointermove 用 rAF 节流 |
| 合并 | O(行*列) 可接受至 100×20 |

---

## 12. a11y

- `role="grid"` + `gridcell`；读屏「表格，R 行 C 列」。  
- 合并：`aria-rowspan` / `aria-colspan`。  
- 菜单：`role="menu"` / `menuitem`；焦点陷阱轻量。  
- `+` 按钮 `aria-label` 中文。  
- 选区变化可 `aria-live` polite 短公告（可选，防吵）。  

---

## 13. 安全

- 单元格 HTML 消毒与全局一致。  
- 粘贴 HTML table 剥 script/style/on*。  
- `conex-table` JSON parse 用 reviver 限制原型污染。  

---

## 14. 验收用例（≥40）

格式：`T-xxx` | 前置 | 步骤 | 期望

### 14.1 基础网格与非源码

1. **T-001** 空文档 slash 插表 → 3 列 × 3 行网格，非 textarea 整表 MD。  
2. **T-002** 点击 body 格 → contenteditable 格内 caret，无整表源码。  
3. **T-003** 读态渲染 `**a**` 单元格 → 粗体；点入编辑 → 仍见粗体（非裸 `**a**`）除非 raw 模式。  
4. **T-004** viewOnly → 无 `+`、无右键菜单项生效。  
5. **T-005** 禁止出现可见「加行」「加列」文字按钮。  

### 14.2 增删行列

6. **T-006** hover 点 `+` 行 → 底增一行同列数。  
7. **T-007** hover 点 `+` 列 → 右增一列，`align` 变长。  
8. **T-008** 右键「上方插行」→ 当前行之上空行，焦点策略符合 §4。  
9. **T-009** 「下方插行」对称。  
10. **T-010** 「左侧/右侧插列」对称。  
11. **T-011** 删行至只剩 1 行 → 菜单禁用或 no-op。  
12. **T-012** 删列至只剩 1 列 → 同上。  
13. **T-013** 插列后 `align` 与 `colWidths` 长度一致。  

### 14.3 单元格内容

14. **T-014** 输入中文与 emoji → rows/cells 一致。  
15. **T-015** 格内 `|` → 序列化转义，再 parse 恢复。  
16. **T-016** 格内换行被压成空格。  
17. **T-017** 清空单元格 → text `''` 且 runs 无。  
18. **T-018** `tableSetCell` 写 runs → plain 缓存同步。  
19. **T-019** covered 格 `tableSetCell` → 写到 anchor。  

### 14.4 对齐与表头

20. **T-020** 列对齐中 → DOM `text-align:center` + `data-align`。  
21. **T-021** 序列化 sep 为 `:---:`。  
22. **T-022** parse `:---:` → `align[c]==='center'`。  
23. **T-023** 切换 hasHeader false → 首行变 td（或产品定义保持 th 样式关闭）。  
24. **T-024** hasHeader true 时 th `scope="col"`。  

### 14.5 键盘导航

25. **T-025** Tab 扫过一行；行末到下一行首。  
26. **T-026** 最后一格 Tab → 增行并聚焦新行首。  
27. **T-027** Shift+Tab 首格不离开表。  
28. **T-028** Enter → 下一行同列。  
29. **T-029** 末行 Enter → 增行。  
30. **T-030** Esc → 退出编辑。  
31. **T-031** 合并格 Tab 只停一次 anchor。  

### 14.6 选择与剪贴板

32. **T-032** 拖选 2×2 → 四格（逻辑）`.is-selected`。  
33. **T-033** Mod+C → TSV 两行 tab 分隔。  
34. **T-034** 粘贴 `a\tb\nc\td` 到 1×1 起点 → 扩表至少 2×2 且内容正确。  
35. **T-035** 单格复制粘贴到另一格。  
36. **T-036** Backspace 多选 → 清空不删行列。  

### 14.7 合并 / 拆分

37. **T-037** 选 1×2 → `tableMerge(r,c,1,2)` → DOM 一格 `colspan=2`。  
38. **T-038** 选 2×1 → rowspan=2。  
39. **T-039** 选 2×2 → rs=2,cs=2；covered 槽无独立 td。  
40. **T-040** 合并后 plain 拼接原非空内容。  
41. **T-041** `tableSplit` → 恢复 1×1；内容在左上。  
42. **T-042** 跨 header/body 选区 `canMerge.ok===false`。  
43. **T-043** 部分覆盖已有 merge → `partial-merge` 失败。  
44. **T-044** 右键合并/拆分与 API 一致。  
45. **T-045** 合并后 JSON Doc round-trip 保留 rs/cs。  

### 14.8 GFM 降级

46. **T-046** pure-gfm + expand-repeat → pipe 每格重复文本，无 HTML。  
47. **T-047** expand-blank → 仅左上有文本。  
48. **T-048** html-table 模式含 rowspan 属性。  
49. **T-049** html-table 再 parse → merge 恢复。  
50. **T-050** conex-fence round-trip 无损 cells。  

### 14.9 结构交叉

51. **T-051** 存在 colspan 时删中间列 → 不破坏剩余网格不变量（先 split）。  
52. **T-052** 存在 rowspan 时在中间插行 → normalize 后无重叠。  
53. **T-053** undo 合并 → 恢复选区内容与结构。  
54. **T-054** redo 再合并成功。  

### 14.10 列宽 / 视图（P1–P2）

55. **T-055** 拖列宽 → `colWidths` 更新；刷新块后保持（JSON）。  
56. **T-056** GFM 导出丢 colWidths 不炸。  
57. **T-057** 排序视图 A→Z 仅视觉；写回后 cells 行序变（若点写回）。  
58. **T-058** 筛选隐藏行；清筛选恢复。  

### 14.11 其它

59. **T-059** 10×20 表连续输入无明显全文闪烁。  
60. **T-060** 畸形 pipe 无 sep → 不当表。  
61. **T-061** 空表序列化仍合法 GFM 三行头。  
62. **T-062** 删除表格菜单 → 块移除。  
63. **T-063** 对齐左/中/右菜单对 body 格也改 **列** align。  
64. **T-064** 复制文本菜单单格无 tab。  
65. **T-065** reduced-motion 下合并无位移动画。  

（共 65 条；实现可裁 P2 相关为 skip，但 P0 项 T-001–T-054 中标 P0 的必须过。）

---

## 15. 分期实施

| 期 | 交付 | DoD |
|----|------|-----|
| **P0** | 模型 merge 字段；tableMerge/Split；框选；菜单 IA 核心；Enter/箭头；TSV；serialize align；GFM expand 降级；禁止整表源码保持 | T-001–T-045 主路径绿 |
| **P1** | runs 格内 live；html-table import/export；列宽；行列表头 gutter；粘贴 HTML；history debounce | 04 册交叉绿 |
| **P2** | 排序/筛选视图；raw 单格；caption；菜单 submenu 动效精修；智能插行不 split | T-055–T-058 |
| **P3** | `columnTypes` 占位 UI；人员/公式 **不实现引擎**；单元格嵌套 block 评估 | 仅占位 |

---

## 16. 非目标（再确认）

1. **完整 Notion Database**（属性类型系统、rollup、relation、看板、日历）。  
2. 人员列选择器 / 公式执行引擎（可 `meta.columnTypes` 灰显）。  
3. 单元格内多 block 嵌套（list/code）——非本阶段。  
4. 协同编辑冲突合并。  
5. 字节级 MD 美化空格 round-trip。  
6. 用整表 Markdown 源码作为默认编辑 UI。  

---

## 17. 文件与模块落点（实现地图）

| 模块 | 职责 |
|------|------|
| `schema.js`（或 TS `table-model.ts`） | 纯函数 merge/split/normalize/TSV |
| `ui/table-chrome.js` | + 按钮、菜单 IA、列宽 handle 可选 |
| `ui/table-selection.js`（新） | 框选、键盘选区、overlay |
| `editor.js` | 绑事件、命令、render/read DOM |
| `parse.js` / `serialize.js` | align、merge 降级、html/fence |
| `css/.../table.css` | 皮肤 + 05 motion 变量 |
| `tests/markdown-editor/table-*.test.js` | 模型单测 + 往返 |

迁移包名见 [07-package-migration.md](./07-package-migration.md)：`packages/conex-mdx` 下 `table/` 子路径。

---

## 18. 与其它分册接口

| 分册 | 接口 |
|------|------|
| [02-render-model](./02-render-model.md) | 表块 reading/editing 状态；非整表源码 |
| [04-inline-marks-live](./04-inline-marks-live.md) | 格内 surface 与 marks 管道 |
| [05-motion-system](./05-motion-system.md) | §6 动效 ID |
| [08-ai-ports](./08-ai-ports.md) | `editor.table.*` 供 AI 调 |
| [01-feature-matrix](./01-feature-matrix.md) | F01–F34 汇总 |
| [10-implementation-plan](./10-implementation-plan.md) | DAG 节点 `table-merge` |

回写：实现完成后更新 `10-data-format.md` §3.3 解注 rowspan/colspan，并修订 `blocks/table.md` 非目标列表。

---

## 19. 中文文案表（菜单 / 错误）

| id | 文案 |
|----|------|
| insert-row-above | 在上方插入行 |
| insert-row-below | 在下方插入行 |
| delete-row | 删除行 |
| insert-col-left | 在左侧插入列 |
| insert-col-right | 在右侧插入列 |
| delete-col | 删除列 |
| align-left | 左对齐 |
| align-center | 居中对齐 |
| align-right | 右对齐 |
| toggle-header | 切换表头行 |
| merge-cells | 合并单元格 |
| split-cell | 拆分单元格 |
| clear-cell | 清空内容 |
| copy | 复制 |
| copy-tsv | 复制为 TSV |
| paste | 粘贴 |
| sort-asc | 排序 A→Z |
| sort-desc | 排序 Z→A |
| filter-col | 按本列筛选… |
| cell-raw | 显示单元格 Markdown |
| delete-table | 删除表格 |
| reason.single-cell | 请选择多个单元格再合并 |
| reason.partial-merge | 选区未包含完整的已合并单元格 |
| reason.cross-header | 不能跨表头与表体合并 |
| reason.view-active | 请先退出排序/筛选再合并 |
| reason.overlap | 与现有合并区域冲突 |

---

## 20. 附录 A — 最小 normalize 算法

```
normalizeTable(block):
  ensure rectangular (pad {text:''})
  for all cells without rowspan/colspan: set 1
  clear all covered flags
  for each cell where !covered && (rs>1 or cs>1):
    for offsets in rect except 0,0:
      if OOB: clamp or split to fit
      mark covered + anchor
  validate no double-cover → else repair to 1×1
  syncRows
  ensureAlignLen
```

## 21. 附录 B — 现状代码锚点（便于 PR）

| 锚点 | 文件 |
|------|------|
| 菜单项仅 6+5 | `ui/table-chrome.js` `headerMenuItems` / `bodyMenuItems` |
| 渲染无 merge | `editor.js` `renderTableHtml` |
| 无 merge API | `schema.js` exports 末尾 |
| serialize 无 align | `serialize.js` `case 'table'` sep 全 `---` |
| parse 无 align | `parse.js` 表分支未读 `:` |
| 选中样式未接线 | `table.css` `.is-selected` vs editor 无 classList |

## 22. 附录 C — 用户认知 FAQ（可进 showcase）

**Q：为什么编辑表格不是改 Markdown 源码？**  
A：表格结构（行列、合并、列宽）用网格操作更安全；Markdown 只是保存/交换格式。  

**Q：为什么要「细化到单元格」？**  
A：对齐、格式、合并都以格为粒度；格内再支持行内格式，而不是一次编辑整表字符串。  

**Q：合并后导出 GitHub 会怎样？**  
A：GitHub 不支持合并；导出时按策略展开或输出 HTML。Conex 内 JSON/`conex-table` 可无损。  

---

## 23. 完成检查清单（本规格文档）

- [x] 数据模型：`text`/`runs`/`rowspan`/`colspan`/covered/约束  
- [x] GFM 降级策略多模式  
- [x] 功能矩阵 + 右键完整 IA  
- [x] 交互：hover+、选区、合并预览、键盘  
- [x] 动效挂钩 05  
- [x] 当前实现逐函数差距  
- [x] API：`tableMerge` / `tableSplit` / …  
- [x] 验收用例 ≥40（本文 65）  
- [x] 明确不做完整 Notion Database  
- [x] 中文、可实施、路径落点清晰  

---

*文档结束 · mdx-v3-analyst-03 · 表格全能力*
