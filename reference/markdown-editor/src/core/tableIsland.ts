/**
 * TableIsland —— 表格岛（战役 table-systemic-remediation · T3）
 *
 * 权威文档：docs/table-systemic-remediation/04-分维-单容器渲染与测量时序.md
 *          docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（ADR-2 / ADR-4）
 *
 * 本模块只放**纯逻辑**（可独立单测、零 DOM / 零 React 依赖）：
 *   - 特性开关（默认关闭；`00-总方案` §9.2「B 期新渲染路径必须可一键关闭」）
 *   - 岛内**行窗口化**：行数超阈值时只渲染视口附近的行
 *   - **列宽栅格**：由列宽数组生成 CSS `grid-template-columns`
 *
 * 岛式布局的核心契约（ADR-2 / ADR-4）：
 *   ① 整表**一个**横向滚动所有者（岛容器），不再每行一个 `overflow-x`；
 *   ② 列宽由**岛的栅格模板**统一驱动（每个行容器共用同一模板），
 *      故不再需要 per-cell 的 `flex: 0 0 Npx` 写回（旧路径的写回在 T8 随旧路径清退）；
 *   ③ 行窗口化在岛内完成——外层虚拟化把整表视为**一个**虚拟项（T4 接线）。
 */

/** 行数超过该阈值才启用岛内窗口化（小表全量渲染，避免无谓的窗口计算）。 */
export const ISLAND_WINDOW_THRESHOLD = 60;

/** 窗口外预渲染的行数（上下各留，减少快速滚动时的白屏）。 */
export const ISLAND_OVERSCAN_ROWS = 8;

/** 单列最小宽度（与既有 `InlineRenderer` 的 100px 兜底口径对齐）。 */
export const MIN_COL_WIDTH = 100;

/**
 * 岛式渲染开关（ADR-2 的特性开关）。
 *
 * **默认关闭**——旧逐行路径保持为默认行为，直到 B 期验收矩阵全绿
 * （`00-总方案` §9.2 规则 2：开关默认值变更须为独立提交且以验收全绿为前置）。
 *
 * 开发期可用 `window.__CONEX_TABLE_ISLAND__ = true` 临时开启以做视觉/交互验收；
 * 生产路径不读 localStorage（避免宿主状态漂移）。
 */
export function isTableIslandEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return (window as unknown as { __CONEX_TABLE_ISLAND__?: boolean })
    .__CONEX_TABLE_ISLAND__ === true;
}

/** 仅供测试/宿主显式设置开关（等价于写 `window.__CONEX_TABLE_ISLAND__`）。 */
export function setTableIslandEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  (window as unknown as { __CONEX_TABLE_ISLAND__?: boolean }).__CONEX_TABLE_ISLAND__ =
    enabled;
}

export interface IslandWindow {
  /** 需要渲染的行下标区间（闭区间，作用于传入的 rowTops 数组下标）。 */
  startRow: number;
  endRow: number;
  /** 是否启用了窗口化（false = 全量渲染）。 */
  windowed: boolean;
}

/**
 * 计算岛内需要渲染的行窗口。
 *
 * @param rowCount 表内行数（不含分隔行）
 * @param rowTops 各行相对岛顶部的像素偏移（升序；长度应为 rowCount + 1，末项为总高）
 * @param scrollTop 岛相对外层滚动容器的可见顶部偏移
 * @param viewportHeight 外层可视高度
 */
export function computeIslandWindow(
  rowCount: number,
  rowTops: readonly number[],
  scrollTop: number,
  viewportHeight: number
): IslandWindow {
  if (rowCount <= ISLAND_WINDOW_THRESHOLD) {
    return { startRow: 0, endRow: Math.max(0, rowCount - 1), windowed: false };
  }
  const top = Math.max(0, scrollTop);
  const bottom = top + Math.max(0, viewportHeight);

  // rowTops[i] = 第 i 行顶部；rowTops[i+1] = 第 i 行底部
  let first = 0;
  while (first < rowCount && (rowTops[first + 1] ?? 0) <= top) first++;
  let last = first;
  while (last < rowCount - 1 && (rowTops[last] ?? 0) < bottom) last++;

  const startRow = Math.max(0, first - ISLAND_OVERSCAN_ROWS);
  const endRow = Math.min(rowCount - 1, last + ISLAND_OVERSCAN_ROWS);
  return { startRow, endRow, windowed: true };
}

/**
 * 由列宽数组生成 CSS `grid-template-columns` 值（岛的列宽真源，ADR-4）。
 * 宽度非法（非有限数 / 小于最小宽）时回退为 `MIN_COL_WIDTH`。
 */
export function buildGridTemplate(colWidths: readonly number[] | undefined): string {
  if (!colWidths || colWidths.length === 0) return '';
  return colWidths
    .map((w) => `${Math.max(MIN_COL_WIDTH, Number.isFinite(w) ? Math.round(w) : MIN_COL_WIDTH)}px`)
    .join(' ');
}

/**
 * 校验列宽数组是否与该表当前列数一致（自愈：不一致即视为脏状态 → 回退为均分）。
 * 与 `TableStore.getWidthsFor` 的自愈口径一致（裁决 R4 的边界投影）。
 */
export function normalizeColWidths(
  colWidths: readonly number[] | undefined,
  cols: number
): number[] | undefined {
  if (!colWidths || colWidths.length !== cols) return undefined;
  return colWidths.map((w) => Math.max(MIN_COL_WIDTH, Number.isFinite(w) ? w : MIN_COL_WIDTH));
}
