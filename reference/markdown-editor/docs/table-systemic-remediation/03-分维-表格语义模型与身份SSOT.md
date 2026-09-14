# 03 分维：表格语义模型与身份 SSOT

> 上位：`00-总方案-表格子系统端到端重构.md`（§3 根因、§5 ADR-1/ADR-3、§6 I4/I5/I10、§7 T1/T2、§8 文件域）。
> 证据台账：`01-分维-现状诊断与证据链.md`（C1/C4/C5/C6/C14）。目标态：`02-分维-参考对齐规格-Alcove表格.md`。
> 本文件是 T1 + T2 的实现级详案；所有结论以「文件:行号」为据，行号已逐条复核。
## 1. 上位与目标

| 任务 | 目标 | 断层 | 不变量 |
|---|---|---|---|
| **T1** `TableModel` 单一语义模型 | 表头 / 列数 / 对齐 / 跨列跨行合并 / 源行区间**收敛到一处推导**，消灭「逐行二次推导」 | **D2**、**D3** | **I5** |
| **T2** 表格身份稳定化 | `TableModel.id` 改为**稳定块身份**并跨编辑保持；视图状态键迁移；过渡期自愈 | **D2**、**D3** | **I4**、**I10** |

一句话：**语义真源从「行」上移到「模型」，身份真源从「首行行号」上移到「块身份」**；两者都不替换行式虚拟化主干（ADR-1）。
## 2. 现状证据（复核后的最小充分集）

| # | 事实 | 证据 |
|---|---|---|
| E1 | AST 无表格聚合节点，只有两种**行**类型 + 两种**行内**类型 | `src/core/ast.ts:13-14`、`ast.ts:51-52`、`ast.ts:78-97`（`LineNode` 仅 `type/raw/inlineTokens/localOffset/length`，无 `rows/cols/alignments`） |
| E2 | 合并语义**部分**挂在 `InlineNode` | `src/core/ast.ts:69-73`（`colSpan/rowSpan/isMergedMaster/isMergedSlave/mergeType`） |
| E3 | 分隔行判定：前导/尾随 `\|` 可选 | `src/core/parser.ts:2302-2312`（`^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$`） |
| E4 | 成表判定：`pipeCount>=2 && (以\|开头 \|\| 以\|结尾 \|\| pipeCount>=3)` | `parser.ts:2380-2391`；管道计数 `parser.ts:1418-1426`；轻量同构 `parser.ts:1441-1447` |
| E5 | 分组与合并标记在 parser 内，**但只累计同行 `colSpan`，从不累计 `rowSpan`** | `parser.ts:2427-2430`（调用）、`parser.ts:2523-2600`、`parser.ts:2577-2597`（`'>'`→`:2581-2587`、`'^'`→`:2588-2591`、普通格 `rowSpan=1`→`:2592-2596`） |
| E6 | `tableId` 由**首行行号向上探测**生成，条件 `trim().startsWith('\|')`，与 E4 **不一致** | `src/components/MarkdownEngine.tsx:548-562`（`:549` 早退、`:551-560` 循环、`:561` 拼 id） |
| E7 | 视图状态全以 `tableId` 为键；选区身份是**绝对行号** | `src/core/TableStore.ts:15-17`、`TableStore.ts:3-10`（`CellSelection` 含 `tableId` + 绝对 `startLine/endLine`）、`TableStore.ts:12`（`ColumnAlignment` 仅 3 值） |
| E8 | 表头二次推导；对齐从分隔行**即时解析**并写 store | `src/components/BlockRenderer.tsx:1565`；对齐初始化 `BlockRenderer.tsx:1570-1586`（`:1574` 正则回解 id → `:1577` 读 `headerIdx+1`）；解析 `src/core/TableOperations.ts:657-667` |
| E9 | 消费点：取不到列宽/对齐即落**弹性兜底** | `src/components/InlineRenderer.tsx:466-478`（`:470` `??100`、`:473` `??0`、`:476-478` `minWidth:100px;flex:1 0 auto`）、`:481-491`（`??'left'`） |
| E10 | 行区间定位另一套判定：`isTableLine` 要求 `trim().startsWith('\|')` | `TableOperations.ts:76-81`；`findTableRange` `:96-177`（列数 `maxCols` `:143-145`、`columnCount: maxCols\|\|1` `:175`）；切分 `parseRowCells` `:52-71` |
| E11 | 编辑落盘已算出行级 splice 计划 | `src/core/EditorStore.ts:2043-2052`（`planChange`）、`:2074-2082`（`updateLinesIncremental`）、行 splice `:793-803`；`applyTableChange` 是薄封装 `:2224-2226`；`setText` 整档重置 `:1788-1827`；文档级 `version` `:658`/`:2216` |
| E12 | 工具栏**所有**表格操作走 `applyTableChange(0, text.length, …)` 整文替换 | `src/components/TableToolbar.tsx:84,100,111,128,139,150,161` |
| E13 | `BlockIntervalTree` 类型含 `'table'`，但**不产出** table 区间；该类在 `src/` 内**零实例化** | `BlockIntervalTree.ts:8` vs `:94-103,133-142,152-161,70-178`；`new BlockIntervalTree(` 仅 `tests/unit/block-interval-tree.test.ts:11`；引擎实际用 `MarkdownEngine.tsx:37-66` 的 LRU |
| E14 | 死代码（本维不复活，T8 清退） | `TableStore.ts:20,40`（`setColumnWidth`）、`TableOperations.ts:398`（`formatTable`）、`:672`（`appendRowAtEnd`） |
> 结论：**表头、列数、对齐、合并、身份五者各有各的推导路径**（E3/E4/E5/E6/E8/E10），判定条件互不一致（E6 vs E4、E10 vs E4）——这就是 I5 与 I10 的直接对象。
## 3. TableModel 设计（T1）
### 3.1 数据结构（`src/core/tableModel.ts`，新增）

```ts
export type TableId = string;                       // 稳定块身份（ADR-3），不再是 "table-<首行行号>"
/** 'none' = 分隔行该列无冒号；投影到 TableStore 时 none → 'left'（保持 E7 的 3 值契约） */
export type ColumnAlignment = 'left' | 'center' | 'right' | 'none';

export interface TableCell {
  rowIndex: number; colIndex: number;               // 表内相对坐标（0 起；hasHeader 时 row 0 = 表头）
  lineIndex: number;                                // 绝对源行号（回写/装饰/选区几何）
  raw: string; text: string;                        // raw 剥离首尾管道符未 trim；text = raw.trim()
  isEmpty: boolean;                                 // text === '' && !isMergedSlave
  children: InlineNode[];                           // **直接引用** parser 行内 token，模型不重建行内解析
  colSpan: number; rowSpan: number;                 // ≥1；主格累计；slave 恒 1
  isMergedMaster: boolean;                          // colSpan > 1 || rowSpan > 1
  isMergedSlave: boolean;
  mergeType?: 'horizontal' | 'vertical';            // 仅 slave
  masterRef?: { rowIndex: number; colIndex: number }; // 仅 slave
}
export interface TableSpan { rowIndex: number; colIndex: number; colSpan: number; rowSpan: number; }
export interface TableSourceRange { startLine: number; endLine: number; }

export interface TableModel {
  id: TableId;
  sourceRange: TableSourceRange;                    // 含表头行与分隔行
  separatorLine: number;                            // 分隔行绝对行号（必存在，否则不构造模型）
  hasHeader: boolean;                               // = separatorLine > startLine
  headerLineIndex: number;                          // 绝对行号；无表头 = -1
  cols: number;                                     // 归一后逻辑列数（≥1）
  rows: TableCell[][];                              // 行主序；hasHeader 时 rows[0] = 表头；**不含分隔行**
  bodyStartRow: number;                             // 0（无表头）或 1（有表头）
  alignments: ColumnAlignment[];                    // 长度 === cols
  spans: TableSpan[];                               // 仅主格（colSpan>1 || rowSpan>1）
  sourceLineIndexes: number[];                      // 每个 row 的绝对行号（含表头，不含分隔行）
  signature: string;                                // 缓存失效签名（§3.4）
}
```
设计要点：① `rows` 含表头行（ADR-1 的 `rows: Cell[][]` 形态），`hasHeader`/`bodyStartRow` 供消费方跳过表头，取代 E8 的 `tableId === 'table-' + index`；② **span 由模型自算，不消费 E5 的 parser 字段**——E5 的 `rowSpan` 恒为 1、`colSpan` 只同行累计，若再消费等于在其上做二次推导，与 I5 相悖，故模型直接读 `raw` 标记重算；③ `children` 引用 parser 输出，不建第二份行内真源。
### 3.2 派生算法（伪代码）
```
buildTableModel(id, source): TableModel | null
  // source = { startLine, endLine, getLine(i), getInlineTokens(i) }

  // ① 定位首个分隔行
  sep = 首个 i ∈ [startLine..endLine] 使 isSeparatorLine(getLine(i))
  if (sep === -1) return null                    // 边界 B1：裸 pipe 行不成表
  hasHeader = sep > startLine                    // 边界 B2：分隔行在首行 → 无表头

  // ② 收集非分隔行（保持源序）
  rowLines = [ i ∈ [startLine..endLine] 且 !isSeparatorLine(getLine(i)) ]
  // ③ 逐行切分单元格（排除 \| 转义，语义对齐 parseRowCells）
  rawRows = rowLines.map(i => splitRowCells(getLine(i)))

  // ④ 列数归一：尾随空列按最长行补齐
  cols = max(rawRows.map(r => r.length)); if (cols === 0) return null
  rawRows = rawRows.map(r => r.concat(Array(cols - r.length).fill('')))

  // ⑤ 建 cells（1:1，raw 保留，children 取 parser token）
  rows = rawRows.map((r, ri) => r.map((raw, ci) =>
           mkCell(ri, ci, rowLines[ri], raw, source.getInlineTokens(rowLines[ri]))))

  // ⑥ 水平合并（同行）：'>' → 左邻主格 colSpan+1；'^' 或普通格 → 复位 master
  for each row:
    master = null
    for ci in 0..cols-1:
      t = rows[ri][ci].text
      if t === '>':  slave(horizontal); masterRef = master; if (master) master.colSpan++
      else if t === '^': slave(vertical); masterRef = null; master = null   // 垂直 slave 不参与水平累计
      else: master = cell

  // ⑦ 垂直合并（同列）：'^' → 向上回溯至同列主格，rowSpan+1
  for ci in 0..cols-1:
    for ri in 0..rows-1:
      if rows[ri][ci].text === '^':
        mr = ri - 1; while (mr >= 0 && rows[mr][ci].text === '^') mr--
        if (mr >= 0) { rows[mr][ci].rowSpan++; rows[ri][ci].masterRef = { rowIndex: mr, colIndex: ci } }

  // ⑧ 主格标记 + isEmpty
  for each cell: isMergedMaster = (colSpan > 1 || rowSpan > 1)
                 isEmpty = (text === '' && !isMergedSlave)

  // ⑨ 对齐（唯一真源 = 分隔行）
  alignments = parseAlignments(getLine(sep)) 补齐至 cols，缺省 'none'

  return { id, sourceRange, separatorLine: sep, hasHeader, headerLineIndex: hasHeader ? startLine : -1,
           cols, rows, bodyStartRow: hasHeader ? 1 : 0, alignments,
           spans: 收集(colSpan>1 || rowSpan>1), sourceLineIndexes: rowLines, signature }
```
`parseAlignments` 语义同 E8 的 `parseTableAlignments`（`TableOperations.ts:657-667`），仅把「无冒号」由 `'left'` 细化为 `'none'`；`center`/`right` 判定不变（`:661-665`）。
### 3.3 边界（逐条给出期望）

| # | 边界 | 期望 |
|---|---|---|
| B1 | **无分隔行**（裸 pipe 行） | 返回 `null`。与 E4 不冲突：E4 判「行是 `table_row`」，模型判「区间存在分隔行才成表」 |
| B2 | **分隔行在首行** | `hasHeader=false`、`headerLineIndex=-1`、`bodyStartRow=0`；分隔行不入 `rows` |
| B3 | `pipeCount>=3` 且**不以 `\|` 开头/结尾**的合法行（`a \| b \| c`） | 以 **E4 的 parser 行类型为唯一真源**收集，**不得**复用 E10 的 `isTableLine`（它要求 `startsWith('\|')`，会漏行）→ §8 U-B |
| B4 | 空单元格（`\| a \|  \| c \|`） | `text=''`、`isEmpty=true`，占列位，`colIndex` 不错位 |
| B5 | 尾随空单元格缺失（`\| a \| b \|` vs `\| a \| b \|  \|`） | 步骤 ④ 归一：`cols = 最长行`，短行补空 |
| B6 | `\|` 转义 | `splitRowCells` 排除前导反斜杠的管道符（同 `parseRowCells:55`），`cols=2`，首格 `text='a \| b'` |
| B7 | `<br>` | 属行内 token（`ast.ts:44-47` 的 `html_tag`），**不拆行**；单元格高度交 T4 测量 |
| B8 | 跨列 `>` | 步骤 ⑥：主格 `colSpan` 累计；slave `mergeType='horizontal'` |
| B9 | 跨行 `^` | 步骤 ⑦：主格 `rowSpan` 累计；slave `mergeType='vertical'`。**必须自算**（E5 从不累计 `rowSpan`） |
| B10 | 矩形合并（`mergeSelectedCells` 产物：主格 + 同行 `>` + 下方 `^`，`TableOperations.ts:734-742`） | 主格 `colSpan=W,rowSpan=H`，其余 `W×H-1` 格为 slave |
| B11 | 仅分隔行一行 | `rows=[]`、`cols` 取分隔行列数、`hasHeader=false`，合法空表 |
| B12 | 表头行与数据行列数不同 | 步骤 ④ 归一（不抛错、不截断） |
### 3.4 缓存与失效

**载体**：`tableModel.ts` 内模块级 `Map<TableId, TableModel>`（默认方案）。ADR-1 建议「由 `BlockIntervalTree` **已有的** `'table'` 区间能力承接」，但该能力**不存在**（E13）且该类零实例化——故本维改用模块级缓存，并把「是否补建 table 区间」升级为待裁决项（§8 U-A）。

**失效签名**：`signature = ${startLine}:${endLine}:${blockVersion}`，`blockVersion` 为该表的**块级版本号**（每次作用于该表的编辑事务 +1）。**不要**直接用 `EditorStore.version`（E11：文档级单调计数，任一编辑都变，过粗）。

**失效条件**（覆盖全部编辑路径）：① 区间端点变化（上方增删行，E11 的 `plan.startLineIdx`）；② 表内任一行 `raw` 变；③ 分隔行变化（对齐真源变，消除 E8 的 stale 风险）；④ 流式追加（`EditorStore.ts:1806,1852`）。

**避免每帧重建**：渲染层每行只调 `getTableModel(id)`（O(1) 签名比对，命中返回同引用）。这取代 E6 的 O(N²) 向上探测：一张 N 行表从 O(N²) 次字符串探测降为 **O(渲染行数)** 次 Map 查表。
### 3.5 API 面
```ts
export interface TableSource {
  startLine: number; endLine: number;
  getLine: (i: number) => string;
  getLineType?: (i: number) => LineType;                    // 用于以 parser 行类型为成表真源（B3）
  getInlineTokens?: (i: number) => InlineNode[] | undefined; // 复用 parser 行内解析
}
export function buildTableModel(id: TableId, source: TableSource): TableModel | null; // 纯函数
export function getTableModel(id: TableId, source?: TableSource): TableModel | null;   // 带缓存
export function invalidateTableModel(id: TableId): void;
export function tableModelSignature(source: TableSource, blockVersion: number): string;
```
`TableOperations` 改为**消费**模型（导出与语义只增不改）：

| 函数 | 现状 | T1 改造 |
|---|---|---|
| `parseTableAlignments(sepLine)` `:657-667` | 独立实现 | 保留导出；实现委托模型对齐推导，标 `@deprecated 由 TableModel.alignments 取代，T8 删除` |
| `findTableRange` `:96-177` | 自建行判定与列数 | **新增可选入参** `model?: TableModel`；命中直接返回 `{ startLineIndex: model.sourceRange.startLine, separatorLineIndex: model.separatorLine - start, columnCount: model.cols }`；未命中保持现状（不改既有行为，§8 U-B） |
| `insertRow` `:182` / `insertColumn` `:274` | `table.columnCount`（`:186`/`:286`） | 列数来源改为模型 `cols`，与 I5 一致 |
| 其余（删行/删列/对齐/合并/拆分/导航） | 纯文本操作 | 语义不变；调用点可注入模型以省重复解析 |
## 4. 表格身份设计（T2，ADR-3 落地）
### 4.1 机制：从「首行行号」到「块槽位身份」

现状（E6/E7）：`id = "table-" + firstTableIndex` 由向上探测得到；上方任意编辑 → `firstTableIndex` 平移 → id 变 → `tableWidths`/`tableAlignments`/`selectedCell` 全部落到错误目标。

T2 机制（ADR-3「由 `EditorStore` 在编辑操作中重映射」的直接落地）：`EditorStore` 维护有序身份表 `tableIdentities: { id: TableId; anchorLine: number }[]`（`anchorLine` = 该表区间起点行号），并提供 `getTableIdForLine(i)`；重映射复用 E11 已算好的行级计划：

| 编辑路径 | 重映射规则 | 结果 |
|---|---|---|
| 变更区间**完全在表之前**（`plan.startLineIdx + plan.deleteCount <= anchorLine`） | `anchorLine += lineDelta`（`lineDelta = insertedLines.length - deleteCount`） | **id 不变** → I4 |
| 变更区间**在表之后** | 不变 | id 不变 |
| 变更区间**与表相交** | id 不变；块版本 +1（§3.4）；若整表被删（`deleteRow` 删空表，`TableOperations.ts:245-250`） | 身份销毁 |
| 编辑**产生新表区间** | 事务内为新区间分配新 id | 新身份 |
| `applyTableChange(0, text.length, …)`（E12 整文替换） | 替换前后各扫描一次表块序列；**数量与顺序一致 → 逐槽位继承 id**（工具栏增删行列/对齐/合并全属此类，必须继承，否则 I4 失效）；数量不等 → 前缀配对继承、尾部新增/销毁 | id 继承 |
| `setText`（E11 整档重置） | 全部旧身份作废重建；同时清空 `useTableStore` 悬挂键 | 新文档新身份 |
> 关键：**身份是编辑器分配的不透明 id，不由内容派生**（ADR-3 已否决「分隔行内容哈希」；同理不采用「上一行内容哈希」）。内容只影响「块版本」，不影响 id。
### 4.2 过渡期自愈

1. **列数校验**：读取 `tableWidths[id]` / `tableAlignments[id]` 时校验 `stored.length === model.cols`；不符 → 丢弃该键并重算（ADR-3「存储列数 == 当前列数」）。落点：`InlineRenderer.tsx:466-491` 消费点前加 guard；`TableStore` 新增 `pruneTableState(id, cols)`。
2. **旧 `tableId` 推导函数保留 + 删除标记**：`MarkdownEngine.tsx:548-562` 在 T2 期间**原位保留**，加注释 `// @deprecated 由 EditorStore.getTableIdForLine 取代；T8 删除`。T2 **不触碰** `MarkdownEngine.tsx`（§8 互斥表把该文件划归 T4）→ 消费点切换归 T4，见 §8 U-C。
### 4.3 I4 与 I10 的断言设计

**I4**（表格上方插入/删除行 → 列宽/列对齐/选区不变）：前置文档 `[p0, p1, TABLE(3 列), p2]`，记录 `id`/`model.cols`/`model.alignments`/`tableWidths[id]`/`selectedCell`；在 TABLE 上方插入 2 行、删除 1 行。断言：① `id` 前后恒等；② `cols` 恒等；③ `alignments` 深等；④ `tableWidths[id]` 深等；⑤ `selectedCell` 的**相对坐标** `(rowIndex,colIndex)` 语义等价（绝对 `lineIndex` 允许随锚点平移）；⑥ `anchorLine` 恰好平移 `lineDelta`。

**I10**（不再向上探测）：静态——T4 完成后 `MarkdownEngine.tsx` 的 tableId 推导路径中 `startsWith('|')` 向上探测**零命中**；运行时——构造 N=500 行表，向上探测调用次数 `=== 0`，`getTableModel` 调用次数 ≤ `O(渲染行数)`（非 `O(N²)`）。**依赖注记**：I10 运行时断言在 T2 阶段记 `pending`，需 T4 切换消费点后转绿（§8 U-C）。
## 5. 与既有契约的关系

| 既有契约 | 立场 |
|---|---|
| **ADR-1：不改行式虚拟化主干** | 严格遵守。`TableModel` 是**派生视图**：不改 AST 行类型（`ast.ts:13-14`）、不改 parser 产出（`parser.ts:2427-2430` 保持）、不改 `HeightMap` 行项模型。T1/T2 只**新增模型 + 改读取路径** |
| ADR-1 被否决路径 | 不得让 parser 产出 `TableNode` 替换行类型；不得引入第三方表格库 |
| ADR-3 被否决路径 | 不得用「分隔行内容哈希」当身份 |
| `docs/analysis/plan-A4-表格流式.md` | **不推翻**。A4 定「何时定型」，本维只提供语义模型；流式追加时模型按 `signature`（§3.4 条件 ④）失效重建，不改定型时机 |
| **测试资产只增不减** | `tests/unit/table-merge.test.ts`、`table-operations.test.ts`、`table-parser-ast.test.ts`、`table-stream-parse.test.ts`、`stream-table-lock.test.ts`、`stream-table-structure-lock.test.ts`、`block-interval-tree.test.ts` 等不得删除/弱化 |
| 既有死代码 | `setColumnWidth`（`TableStore.ts:20,40`）、`formatTable`（`TableOperations.ts:398`）、`appendRowAtEnd`（`:672`）本维**不复活**，留待 T8 |
## 6. 文件域与影响面

**T1 触碰**：`src/core/tableModel.ts`（**新增**）；`src/core/TableOperations.ts`（改：`parseTableAlignments` 委托、`findTableRange` 可选 `model` 入参、增删行列列数取模型）；`src/components/BlockRenderer.tsx`（改：表格行读取路径改走 `getTableModel`，取代 `:1565` 表头二次推导与 `:1570-1586` 对齐即时解析）。

**T2 触碰**：`src/core/tableModel.ts`（改：`id` 语义、`signature`）；`src/core/EditorStore.ts`（改：表身份表 + 编辑重映射，复用 `planChange`）；`src/core/TableStore.ts`（改：键迁移 + `pruneTableState` 列数自愈）。

**本维不触碰**（`00 §8` 归属他任务）：`src/core/ast.ts`、`src/core/parser.ts`（产出不变）；`src/core/HeightMap.ts`（T4）；`src/core/renderToHtml.ts`（T7）；`src/components/MarkdownEngine.tsx`（T4，含 `:548-562` 消费点切换）；`src/components/TableBlock.tsx`（T3）；`src/components/InlineRenderer.tsx`（T5）；`src/components/TableToolbar.tsx`（T6）；`src/index.css`（T3/T6）；`src/core/BlockIntervalTree.ts`（§8 未列 owner，见 §8 U-A）。
## 7. 验收断言
### 7.1 `tests/unit/table-model.test.ts`（新增，纯函数）

| # | 用例 | 断言 |
|---|---|---|
| 1 | 基本表（表头 + 2 数据行 × 3 列） | `cols=3`、`hasHeader=true`、`rows.length=3`、`bodyStartRow=1` |
| 2 | 无表头（分隔行在首行） | `hasHeader=false`、`headerLineIndex=-1`、`bodyStartRow=0` |
| 3 | 无分隔行（裸 pipe 行） | 返回 `null`（B1） |
| 4 | `pipeCount>=3` 裸行成表（`a \| b \| c`） | 成表、`cols=3`（以 E4 行类型为真源，B3） |
| 5 | 空单元格（B4） | 中间格 `isEmpty=true`、`colIndex=1` 不错位 |
| 6 | 尾随空单元格缺失（B5） | 归一 `cols=3`，短行补空 |
| 7 | `\|` 转义（B6） | `cols=2`、首格 `text='a \| b'` |
| 8 | `<br>`（B7） | 不拆行，`children` 含 `html_tag` |
| 9 | 跨列 `>`（B8） | 主格 `(0,0).colSpan=2`；slave `(0,1).masterRef=(0,0)` |
| 10 | 跨行 `^`（B9） | 主格 `(0,0).rowSpan=2`；slave `(1,0).mergeType='vertical'` |
| 11 | 矩形合并（B10） | 主格 `colSpan=2,rowSpan=2`；3 个 slave 的 `masterRef` 均指向主格 |
| 12 | 对齐（`:---:`/`---:`/`---`） | 模型 `center/right/none`；投影到 store 时 `none→left`（E7 契约） |
| 13 | 缓存 | 同 `signature` 二次 `getTableModel` 返回**同一对象引用**；改行内容 → 新对象 |
| 14 | 行内解析不重建 | `cell.children` 与 `getInlineTokens` 输出引用相等 |
### 7.2 `tests/unit/table-identity.test.ts`（新增）

| # | 用例 | 断言 |
|---|---|---|
| 1 | **I4-a** 上方插入 1 行 | `id`/`cols`/`alignments`/`tableWidths[id]` 全等；`anchorLine += 1` |
| 2 | **I4-b** 上方删除 1 行 | 同上；`anchorLine -= 1` |
| 3 | **I4-c** 表格下方编辑 | `id` 不变、`anchorLine` 不变 |
| 4 | 表内插入行 | `id` 不变、`cols` 不变、`rows.length +1`、块版本 +1 |
| 5 | `applyTableChange` 整文替换（插列） | `id` **继承**、`cols +1`；自愈：旧 `tableWidths` 长度不符 → 丢弃重算 |
| 6 | 在表 A 之前插入新表 | A 的 `id` 不变；新表分配新 `id` |
| 7 | 删除整表 | 该 `id` 从映射销毁；`TableStore` 悬挂键被 `prune` |
| 8 | `setText` 整档替换 | 全部旧 `id` 作废；`TableStore` 对应键清空 |
| 9 | 自愈：手工写入列数不符的 `tableWidths` | 读取即丢弃并重算（ADR-3 自愈） |
| 10 | **I10** 向上探测调用计数 | T2 阶段 `pending`；T4 切换后 `=== 0`（§8 U-C） |
### 7.3 既有门禁（不得回退）

`npm run check:gate` / `npm run test` / `npm run test:gate` 全绿；E13/E14 列出的既有表格测试与 `tests/unit/block-interval-tree.test.ts` 保持全绿。
## 8. 未决问题（本维无法自决，需主控裁决）

| # | 问题 | 证据 | 本维默认取法 | 影响 |
|---|---|---|---|---|
| **U-A** | ADR-1 称「由 `BlockIntervalTree` **已有的** `'table'` 区间能力承接」缓存，但该能力**不存在**：`buildFromLines` 只产 `code_block`/`callout`/`blockquote`，且该类在 `src/` 内零实例化 | `BlockIntervalTree.ts:8` vs `:94-103,133-142,152-161,70-178`；`new BlockIntervalTree(` 仅 `tests/unit/block-interval-tree.test.ts:11`；引擎实际用 `MarkdownEngine.tsx:37-66` | 用 `tableModel.ts` **模块级缓存**，不触碰 `BlockIntervalTree.ts` | 若主控要求挂区间树，需补建 table 区间并明确 `BlockIntervalTree.ts` 的 owner（§8 互斥表未列该文件） |
| **U-B** | 行判定双源：`isTableLine` 要求 `trim().startsWith('\|')`，与 parser 成表条件（`pipeCount>=3` 裸行）不一致 → `findTableRange` 对裸行表返回 `null`，而渲染层却按表格渲染 | `TableOperations.ts:76-81` vs `parser.ts:2380-2391` | T1 **只增不改**：模型以 parser 行类型为真源（B3），`findTableRange` 保持现状并登记偏差 | 若要求同时收敛 `findTableRange` 判定，可能改变 `table-operations.test.ts` 既有断言（违反「测试只增不减」，需先裁决） |
| **U-C** | T2 是否可触碰 `MarkdownEngine.tsx` 以切换身份消费点：§8 互斥表把该文件划归 **T4** | `00 §8`（`MarkdownEngine.tsx` 仅 T4 有 ●）；旧推导 `MarkdownEngine.tsx:548-562` | T2 **不触碰**；旧推导原位保留 + `@deprecated T8 删除`；消费点切换归 T4 | 决定 I10 运行时断言的**转绿时点**（T2 记 `pending`，T4 后转绿） |
| **U-D** | 模型 `ColumnAlignment` 引入 `'none'`，而 `TableStore.ColumnAlignment`（`TableStore.ts:12`）仅 3 值 | `TableStore.ts:12` vs `TableOperations.ts:657-667`（现状把无冒号也归 `'left'`） | 投影映射 `none → 'left'`，保持 store 3 值契约 | 需确认不改变既有对齐相关断言（如 `css-contract.test.ts`） |
## 9. 变更记录

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-09-14 | 创建 | 首版：T1/T2 详案——TableModel 数据结构 + 派生算法 + 12 条边界 + 缓存失效 + API 面；身份稳定化机制 + 自愈 + I4/I10 断言；文件域互斥；2 个新增测试文件用例清单；4 项待裁决（U-A..U-D） |
