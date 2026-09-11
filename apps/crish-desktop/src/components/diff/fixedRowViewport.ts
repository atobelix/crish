/**
 * 确定性固定行高视口计算（Mode-FIXED）。
 * Diff 分栏 / 统一视图 / 文件树共用：误差为 0，禁止估高→实测改总高。
 */
export interface FixedRowViewport {
  startIndex: number;
  endIndex: number;
  offsetTop: number;
  totalHeight: number;
}

export function computeFixedRowViewport(
  scrollTop: number,
  viewportHeight: number,
  itemCount: number,
  rowHeight: number,
  overscan: number,
): FixedRowViewport {
  const h = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 22;
  const count = Number.isFinite(itemCount) && itemCount > 0 ? Math.floor(itemCount) : 0;
  if (count === 0) {
    return { startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight: 0 };
  }
  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const view = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0;
  const pad = Math.max(0, Math.floor(overscan));
  const startIndex = Math.max(0, Math.floor(top / h) - pad);
  const endIndex = Math.min(
    count,
    Math.ceil((top + view) / h) + pad,
  );
  return {
    startIndex,
    endIndex,
    offsetTop: startIndex * h,
    totalHeight: count * h,
  };
}

/** Diff 行高必须与 CSS .collapseBar / .splitLine 契约一致 */
export const DIFF_FIXED_ROW_HEIGHT = 22;
