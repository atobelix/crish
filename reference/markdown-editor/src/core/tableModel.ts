/**
 * TableModel —— 表格语义的**唯一真源**（战役 table-systemic-remediation · T1）
 *
 * 权威文档：docs/table-systemic-remediation/03-分维-表格语义模型与身份SSOT.md
 *          docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（ADR-1 / ADR-3）
 *
 * 设计要点（ADR-1）：
 *   - 本模块是**派生视图**，不是 AST 替换——编辑器的行式虚拟化主干（一行一虚拟项）
 *     **不动**；表格语义（表头 / 列数 / 列对齐 / 跨行列合并 / 源行区间）集中到此处推导，
 *     消灭「在渲染层反复重新推导」的根因断层 D2/D3/D5。
 *   - 真源优先级：**parser 产出的 InlineNode（table_cell / table_separator 行类型）**
 *     优先；无 LineNode 时退化为文本切分（语义与 parser 的 groupTableCells 对齐）。
 *     裁决 R2：成表判定以 **parser 行类型**为准，**不得**用「行文本是否以 `|` 开头」代替。
 *
 * 纪律：
 *   - 本模块为**纯函数 + 模块级缓存**，不依赖 React / DOM / zustand，可独立单测。
 *   - 禁止在此处引入 DOM 测量（列宽/高度属 T3/T4 的渲染层职责）。
 */
import type { InlineNode, LineNode } from './ast';

/** 列对齐。`'none'` = 分隔行未声明（投影到 TableStore 时按裁决 R4 归一为 `'left'`）。 */
export type ColumnAlignment = 'left' | 'center' | 'right' | 'none';

/** 表格合并方向（与 parser 的 `>` / `^` 标记对应）。 */
export type MergeType = 'horizontal' | 'vertical';

export interface TableCell {
  /** 表内相对行号（0-based，**不含**分隔行）。 */
  row: number;
  /** 表内相对列号（0-based）。 */
  col: number;
  /** 单元格原文（保留内部空白，去首尾空白后的 `raw`）。 */
  raw: string;
  /** 源码绝对行号。 */
  lineIndex: number;
  /** 在源码行内的起始偏移（无 LineNode 时为 0）。 */
  localOffset: number;
  /** 在源码行内的长度（无 LineNode 时为 0）。 */
  length: number;
  colSpan: number;
  rowSpan: number;
  isMergedMaster: boolean;
  isMergedSlave: boolean;
  mergeType?: MergeType;
  /** 该单元格是否由「补齐」产生（源码中该行缺少此列）。 */
  isPadding: boolean;
}

export interface TableRow {
  /** 表内相对行号（0-based，不含分隔行）。 */
  row: number;
  lineIndex: number;
  isHeader: boolean;
  cells: TableCell[];
}

export interface TableModel {
  /**
   * 表格身份。
   * 过渡期（T1）为 `table-<startLine>`；T2 接管为**稳定块身份**（ADR-3），
   * 届时本字段的取值来源切换，消费方无需改动。
   */
  id: string;
  /** 表区间起始行（含）。 */
  startLine: number;
  /** 表区间结束行（含）。 */
  endLine: number;
  /** 分隔行行号；无分隔行时为 `null`。 */
  separatorLine: number | null;
  /** 是否存在表头（分隔行紧跟在表格首行之后时为 true）。 */
  hasHeader: boolean;
  /** 列数（各行单元格数的最大值，含补齐）。 */
  cols: number;
  /** 列对齐（长度恒为 cols）。 */
  alignments: ColumnAlignment[];
  /** 表头行；`hasHeader === false` 时为 `null`。 */
  header: TableRow | null;
  /** 数据行（**不含**表头行与分隔行）。 */
  rows: TableRow[];
  /** 源行区间（与 startLine/endLine 同义，供 T2 身份映射消费）。 */
  sourceRange: { startLine: number; endLine: number };
  /** 供缓存失效判定的内容代际。 */
  revision: number;
}

/**
 * 表格分隔行正则（**唯一真源**）。
 * 与 `src/core/parser.ts:2305-2307` 的判定保持一致：前导/尾随 `|` 可选，
 * 仅由破折号、冒号、空白与管道符构成。
 */
export const TABLE_SEPARATOR_RE = /^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/;

/** 单行文本是否为表格分隔行（长度上限与 parser 的 MAX_PARSE_CHARS 对齐）。 */
export function isSeparatorText(text: string): boolean {
  if (text.length > 10_000) return false;
  return TABLE_SEPARATOR_RE.test(text);
}

/**
 * 文本切分单元格（无 LineNode 时的退化路径）。
 * 语义与 parser 的 `groupTableCells` 对齐：
 *   - 管道符为分隔符；
 *   - 首个管道符**之前**若有内容，视为第 0 列；
 *   - 末尾**纯空白**的尾随单元格被丢弃（对应 parser 的 `isJustEmptySpace` 分支）。
 */
export function splitRowCells(raw: string): string[] {
  const parts = raw.split('|');
  const hasLeading = raw.trimStart().startsWith('|');
  // 首管道前有内容 → parts[0] 是真实单元格；否则 parts[0] 为前导空段
  const start = hasLeading || parts[0].trim() === '' ? 1 : 0;
  const cells = parts.slice(start);
  // 尾随空段（`| a | b |` 的最后一个 parts 为空串）丢弃
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

/** 从分隔行文本解析列对齐（长度 = 该行声明的列数）。 */
export function parseAlignments(separatorText: string): ColumnAlignment[] {
  return splitRowCells(separatorText).map((cell) => {
    const t = cell.trim();
    const starts = t.startsWith(':');
    const ends = t.endsWith(':');
    if (starts && ends) return 'center';
    if (ends) return 'right';
    if (starts) return 'left';
    return 'none';
  });
}

export interface BuildTableModelOptions {
  /** 表区间起始行（含）。 */
  startLine: number;
  /** 表区间结束行（含）。 */
  endLine: number;
  /** 行原文访问器。 */
  getLine: (lineIndex: number) => string;
  /** 行节点访问器（可选；提供时走 parser token 真源路径）。 */
  getLineNode?: (lineIndex: number) => LineNode | undefined;
  /** 内容代际（缓存失效判定；调用方在文档变化时递增即可）。 */
  revision?: number;
  /** 身份覆盖（T2 传入稳定块身份；缺省为 `table-<startLine>`）。 */
  id?: string;
}

/**
 * 构建 TableModel（纯函数，无缓存）。
 *
 * 表头判定（I5 唯一真源）：分隔行紧跟在表格首行之后 → 首行为表头；
 * 分隔行本身就是表格首行 → 无表头（parser 允许分隔行作为表格首行）。
 */
export function buildTableModel(opts: BuildTableModelOptions): TableModel {
  const { startLine, endLine, getLine, getLineNode, revision = 0, id } = opts;

  // ① 定位分隔行：只认「首行」或「次行」，与 GFM 语义一致
  let separatorLine: number | null = null;
  if (endLine >= startLine) {
    if (isSeparatorText(getLine(startLine))) separatorLine = startLine;
    else if (endLine > startLine && isSeparatorText(getLine(startLine + 1))) separatorLine = startLine + 1;
  }
  const hasHeader = separatorLine !== null && separatorLine === startLine + 1;

  // ② 收集数据行（跳过分隔行），逐行取单元格
  const dataLineIndexes: number[] = [];
  for (let i = startLine; i <= endLine; i++) {
    if (i === separatorLine) continue;
    dataLineIndexes.push(i);
  }

  const rawRows = dataLineIndexes.map((lineIndex) => ({
    lineIndex,
    cells: readRowCells(lineIndex, getLine, getLineNode),
  }));

  // ③ 列数归一：取各行最大值，短行补齐（补齐单元格标记 isPadding）
  let cols = 0;
  for (const r of rawRows) cols = Math.max(cols, r.cells.length);
  if (separatorLine !== null) cols = Math.max(cols, splitRowCells(getLine(separatorLine)).length);

  // ④ 组装行 / 单元格
  //    合并语义**统一从 raw 派生**（而非继承 token 上的标记）——保证文本路径与
  //    Token 路径产出完全一致，且重复构建幂等（单一真源）。
  const rows: TableRow[] = rawRows.map((r, row) => {
    const isHeader = hasHeader && r.lineIndex === startLine;
    const cells: TableCell[] = [];
    for (let col = 0; col < cols; col++) {
      const src = r.cells[col];
      const raw = src ? src.raw : '';
      const trimmed = raw.trim();
      const isHorizontalSlave = trimmed === '>';
      const isVerticalSlave = trimmed === '^';
      cells.push({
        row,
        col,
        raw,
        lineIndex: r.lineIndex,
        localOffset: src ? src.localOffset : 0,
        length: src ? src.length : 0,
        colSpan: 1,
        rowSpan: 1,
        isMergedMaster: false,
        isMergedSlave: isHorizontalSlave || isVerticalSlave,
        mergeType: isHorizontalSlave ? 'horizontal' : isVerticalSlave ? 'vertical' : undefined,
        isPadding: !src,
      });
    }
    return { row, lineIndex: r.lineIndex, isHeader, cells };
  });

  // ⑤ 跨列合并：`>` 为水平从属，向上游最近的非从属格累加 colSpan（与 parser 同语义）
  applyColSpans(rows, cols);

  // ⑥ 跨行合并（裁决 R10）：`^` 为垂直从属，向上连续计数得出主格的 rowSpan
  applyRowSpans(rows, cols);

  // ⑥ 列对齐（长度恒为 cols；缺省 none）
  const alignments: ColumnAlignment[] = new Array(cols).fill('none');
  if (separatorLine !== null) {
    const parsed = parseAlignments(getLine(separatorLine));
    for (let c = 0; c < cols && c < parsed.length; c++) alignments[c] = parsed[c];
  }

  return {
    id: id ?? `table-${startLine}`,
    startLine,
    endLine,
    separatorLine,
    hasHeader,
    cols,
    alignments,
    header: hasHeader ? (rows.find((r) => r.isHeader) ?? null) : null,
    rows: rows.filter((r) => !r.isHeader),
    sourceRange: { startLine, endLine },
    revision,
  };
}

interface RawCell {
  raw: string;
  localOffset: number;
  length: number;
}

/**
 * 取一行的单元格原文。优先走 parser 的 `table_cell` token（真源，提供精确偏移）；
 * 无 LineNode 时退化为文本切分（语义与 `groupTableCells` 对齐）。
 * 合并语义（`>` / `^`）不在此处判定——统一在 `buildTableModel` 中从 raw 派生。
 */
function readRowCells(
  lineIndex: number,
  getLine: (i: number) => string,
  getLineNode?: (i: number) => LineNode | undefined
): RawCell[] {
  const node = getLineNode ? getLineNode(lineIndex) : undefined;
  const tokenCells = node?.inlineTokens?.filter((t: InlineNode) => t.type === 'table_cell');
  if (tokenCells && tokenCells.length > 0) {
    return tokenCells.map((t) => ({
      raw: t.raw,
      localOffset: t.localOffset,
      length: t.length,
    }));
  }
  const raw = getLine(lineIndex);
  return splitRowCells(raw).map((cell) => ({ raw: cell, localOffset: 0, length: 0 }));
}

/** `>` 水平合并：主格 colSpan = 1 + 其后连续 `>` 数（与 parser 的 groupTableCells 同语义）。 */
function applyColSpans(rows: TableRow[], cols: number): void {
  for (const row of rows) {
    let masterCol = -1;
    for (let col = 0; col < cols; col++) {
      const cell = row.cells[col];
      if (!cell) continue;
      if (cell.mergeType === 'horizontal') {
        cell.isMergedSlave = true;
        cell.colSpan = 1;
        if (masterCol >= 0) {
          const master = row.cells[masterCol];
          if (master) {
            master.isMergedMaster = true;
            master.colSpan += 1;
          }
        }
      } else if (cell.mergeType === 'vertical') {
        // 垂直从属不参与水平主格链
        masterCol = -1;
      } else {
        cell.colSpan = 1;
        masterCol = col;
      }
    }
  }
}

/** `^` 垂直合并：主格 rowSpan = 1 + 其下连续 `^` 行数（裁决 R10；parser 恒置 1）。 */
function applyRowSpans(rows: TableRow[], cols: number): void {
  for (let col = 0; col < cols; col++) {
    let masterRow = -1;
    for (let row = 0; row < rows.length; row++) {
      const cell = rows[row]?.cells[col];
      if (!cell) continue;
      if (cell.mergeType === 'vertical') {
        cell.isMergedSlave = true;
        cell.rowSpan = 1;
        if (masterRow >= 0) {
          const master = rows[masterRow]?.cells[col];
          if (master) {
            master.isMergedMaster = true;
            master.rowSpan = (master.rowSpan ?? 1) + 1;
          }
        }
      } else {
        masterRow = row;
      }
    }
  }
}

// ── 表区间解析（**唯一实现**：替换散落在 MarkdownEngine / BlockRenderer 的向上探测）──

/**
 * 由任意一行向上探测其所属表格的起始行。
 *
 * **单一实现**：此前该逻辑在 `MarkdownEngine.tsx:548-562`（身份推导）与
 * `BlockRenderer.tsx`（表头判定）各有一份，属根因断层 D2 的载体。
 *
 * 判定口径（裁决 R2）：优先用 **parser 行类型**；未提供 `getLineType` 时退化为
 * 「行文本 trim 后以 `|` 开头」——该退化口径与 `TableOperations.isTableLine`
 * 一致，已登记为已知识别缺陷（`01-分维` C16），本战役**不修**。
 *
 * @returns 起始行号；该行不属于表格时返回 `null`。
 */
export function resolveTableStartLine(
  lineIndex: number,
  getLine: (i: number) => string,
  getLineType?: (i: number) => string | undefined
): number | null {
  const belongs = (i: number): boolean => {
    if (getLineType) {
      const t = getLineType(i);
      if (t !== undefined) return t === 'table_row' || t === 'table_separator';
    }
    return getLine(i).trim().startsWith('|');
  };

  if (lineIndex < 0 || !belongs(lineIndex)) return null;
  let start = lineIndex;
  while (start > 0 && belongs(start - 1)) start--;
  return start;
}

// ── 模块级缓存（裁决 R1：不依赖 BlockIntervalTree —— 该类在 src/ 内零实例化）──

interface CacheEntry {
  signature: string;
  model: TableModel;
}

const cache = new Map<string, CacheEntry>();
/** 缓存容量上限（表格数量级远小于此；防内存无界增长）。 */
const CACHE_LIMIT = 256;

/**
 * 带缓存的 TableModel 访问器。
 *
 * 缓存键 = `revision:startLine`；签名 = 表区间内各行的**原始文本拼接**（表格很小）。
 * 签名不符即重建——保证「同一 revision 内不同行反复取模型」为 O(1)。
 */
export function getTableModel(opts: BuildTableModelOptions): TableModel {
  const key = `${opts.revision ?? 0}:${opts.startLine}`;
  let signature = '';
  for (let i = opts.startLine; i <= opts.endLine; i++) signature += opts.getLine(i) + '\n';

  const hit = cache.get(key);
  if (hit && hit.signature === signature) return hit.model;

  const model = buildTableModel(opts);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { signature, model });
  return model;
}

/** 清空缓存（文档整文替换 / 测试隔离用）。 */
export function clearTableModelCache(): void {
  cache.clear();
}

/** 缓存条目数（测试与观测用）。 */
export function tableModelCacheSize(): number {
  return cache.size;
}
