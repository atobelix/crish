/**
 * TableSelectionRect —— 表内选区**单矩形**几何（战役 table-systemic-remediation · T5）
 *
 * 权威文档：docs/table-systemic-remediation/05-分维-选区覆盖层与交互范式.md（ADR-6）
 *          docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（I6 / I7）
 *
 * 要拔除的断层（D7 / 症状 S3）：
 *   旧范式把选区轮廓**拼**出来——每个命中单元格各自加一段 `inset box-shadow`
 *   （上/下/左/右边界各由边界格负责），于是「一个选区」在 DOM 上是 N 段互不
 *   相识的边框；单格选中又是另一种画法（外环 + 圆角 + zIndex）。后果：选区
 *   无法表达为一个矩形、跨窗口截断无处安放、拖拽重排时轮廓与几何脱钩。
 *
 * 本模块的解法：选区 = **一个矩形**，由「表内相对行号区间 × 列号区间」经
 * 行/列**前缀坐标**求交得到。纯函数、确定性（I6 的「与角单元格几何一致」在
 * 这里就是矩形的四个边 = 角单元格的四条外边）。
 *
 * 坐标空间：**表内局部坐标**（原点 = 表首行左上角，即岛轨原点）。
 *   - `rowTops[i]` = 表内第 i 行顶部（长度 = 行数 + 1，末项 = 表高）；
 *   - `colLefts[j]` = 第 j 列左侧（长度 = 列数 + 1，末项 = 表宽）。
 * 调用方（岛）负责把「绝对行号」折算为「表内相对行号」——本模块不认绝对行号，
 * 故与行号漂移（D3）无关。
 */

/** 表内选区（相对坐标；含端点，允许反向区间，由本模块归一）。 */
export interface TableSelectionRange {
  /** 表内相对行号（0 = 表首行 / 表头行） */
  startRow: number;
  endRow: number;
  /** 列号（0 基） */
  startCol: number;
  endCol: number;
}

/** 表内局部坐标下的矩形（像素）。 */
export interface TableSelectionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 由列宽数组生成列左前缀（长度 = 列数 + 1）。非法宽度按 0 计。 */
export function buildColLefts(colWidths: readonly number[] | undefined): number[] {
  const out: number[] = [0];
  if (!colWidths) return out;
  let acc = 0;
  for (const w of colWidths) {
    acc += Number.isFinite(w) && w > 0 ? w : 0;
    out.push(acc);
  }
  return out;
}

/**
 * 由行前缀 + 列前缀求选区**单矩形**。
 *
 * - 区间归一（`min`/`max`）⇒ 反向拖拽（右下往左上）与正向拖拽几何恒等；
 * - 越界行/列一律**钳制**到有效范围（选区可能由「绝对行号」映射而来，
 *   增删行列后允许短暂越界，钳制保证矩形永远落在表内且非负）；
 * - 表内无有效行/列（空表 / 空列宽）→ 返回 `null`（调用方不画覆盖层）。
 *
 * @param rowTops 行顶部前缀（长度 ≥ 行数 + 1）
 * @param colLefts 列左前缀（长度 ≥ 列数 + 1）
 */
export function computeSelectionRect(
  range: TableSelectionRange,
  rowTops: readonly number[],
  colLefts: readonly number[]
): TableSelectionRect | null {
  const rowCount = rowTops.length - 1;
  const colCount = colLefts.length - 1;
  if (rowCount <= 0 || colCount <= 0) return null;

  const clampRow = (r: number): number =>
    Math.max(0, Math.min(rowCount - 1, Math.trunc(Number.isFinite(r) ? r : 0)));
  const clampCol = (c: number): number =>
    Math.max(0, Math.min(colCount - 1, Math.trunc(Number.isFinite(c) ? c : 0)));

  const r0 = clampRow(Math.min(range.startRow, range.endRow));
  const r1 = clampRow(Math.max(range.startRow, range.endRow));
  const c0 = clampCol(Math.min(range.startCol, range.endCol));
  const c1 = clampCol(Math.max(range.startCol, range.endCol));

  const top = rowTops[r0];
  const bottom = rowTops[r1 + 1];
  const left = colLefts[c0];
  const right = colLefts[c1 + 1];
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;

  return {
    left: Math.round(left * 100) / 100,
    top: Math.round(top * 100) / 100,
    width: Math.max(0, Math.round((right - left) * 100) / 100),
    height: Math.max(0, Math.round((bottom - top) * 100) / 100),
  };
}

/**
 * 绝对行号区间 → 表内相对行号区间（I7 的映射原语）。
 *
 * 增删行/列后，视图状态里保存的绝对行号可能落在表外；本函数只做
 * 「绝对 → 相对」的确定性折算与钳制，**不**尝试跨表匹配（那是身份层的事）。
 * 表区间为闭区间 `[tableStart, tableEnd]`。
 */
export function toRelativeRange(
  absStartRow: number,
  absEndRow: number,
  tableStart: number,
  tableEnd: number
): { startRow: number; endRow: number } {
  const last = Math.max(0, tableEnd - tableStart);
  const clamp = (r: number): number =>
    Math.max(0, Math.min(last, Math.trunc(Number.isFinite(r) ? r : 0) - tableStart));
  const a = clamp(absStartRow);
  const b = clamp(absEndRow);
  return { startRow: Math.min(a, b), endRow: Math.max(a, b) };
}
