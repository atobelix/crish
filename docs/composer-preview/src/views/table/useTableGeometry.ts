/**
 * useTableGeometry — 测量当前悬浮的表格
 *
 * 覆盖层需要知道：表格在视口里的位置、每一行的纵向范围、每一列的横向范围。
 * 这些只能从真实 DOM 量，因为列宽是 prosemirror-tables 通过 `<colgroup>`
 * 动态维护的，文档模型里并没有最终像素值。
 *
 * ── 为什么用视口坐标而不是相对坐标 ──────────────────
 *   覆盖层用 `position: fixed` + `getBoundingClientRect`，
 *   不依赖任何定位祖先，也就不会因为编辑器容器加了 `overflow` 或
 *   `transform` 而错位——那类错位极难排查。
 *
 * ── 性能 ──────────────────────────────────────────────
 *   mousemove 里只做一次 `closest('table')`（O(树深)），
 *   只有在「换了一张表」或「表格尺寸变化」时才重新量整表；
 *   滚动时走 rAF 节流，且只更新偏移量。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface TrackGeometry {
  /** 行/列序号，从 0 开始 */
  index: number;
  /** 视口坐标下的起点（行为 top，列为 left） */
  start: number;
  /** 长度（行为 height，列为 width） */
  size: number;
  /** 该行/列的代表性单元格，用于把选区定位过去 */
  cell: HTMLTableCellElement;
}

export interface TableGeometry {
  table: HTMLTableElement;
  rect: Rect;
  rows: TrackGeometry[];
  cols: TrackGeometry[];
  /** 首行是否为表头 */
  hasHeaderRow: boolean;
}

/** 鼠标离开表格后仍保持显示的外扩范围，保证右/下的加行加列条够得着 */
const HOVER_MARGIN = 28;

function measure(table: HTMLTableElement): TableGeometry | null {
  const rows = Array.from(table.rows);
  if (rows.length === 0) return null;

  const tableRect = table.getBoundingClientRect();
  const rect: Rect = {
    top: tableRect.top,
    left: tableRect.left,
    width: tableRect.width,
    height: tableRect.height,
  };

  const rowTracks: TrackGeometry[] = rows.map((row, index) => {
    const r = row.getBoundingClientRect();
    return {
      index,
      start: r.top,
      size: r.height,
      cell: row.cells[0] as HTMLTableCellElement,
    };
  });

  // 列的几何取首行——它一定覆盖所有列（合并单元格的场景下也以首行为准）
  const firstRow = rows[0];
  const colTracks: TrackGeometry[] = Array.from(firstRow.cells).map((cell, index) => {
    const r = cell.getBoundingClientRect();
    return { index, start: r.left, size: r.width, cell: cell as HTMLTableCellElement };
  });

  return {
    table,
    rect,
    rows: rowTracks,
    cols: colTracks,
    hasHeaderRow: firstRow.cells[0]?.tagName === 'TH',
  };
}

function isWithin(rect: Rect, x: number, y: number, margin: number): boolean {
  return (
    x >= rect.left - margin &&
    x <= rect.left + rect.width + margin &&
    y >= rect.top - margin &&
    y <= rect.top + rect.height + margin
  );
}

/**
 * 追踪鼠标下的表格。
 *
 * @param root 编辑器根元素；为 null 时不追踪
 */
export function useTableGeometry(root: HTMLElement | null): TableGeometry | null {
  const [geometry, setGeometry] = useState<TableGeometry | null>(null);
  const currentTableRef = useRef<HTMLTableElement | null>(null);
  const rafRef = useRef(0);

  const refresh = useCallback(() => {
    const table = currentTableRef.current;
    if (!table || !table.isConnected) {
      currentTableRef.current = null;
      setGeometry(null);
      return;
    }
    setGeometry(measure(table));
  }, []);

  /* ── 鼠标追踪 ── */
  useEffect(() => {
    if (!root) return;

    const onPointerMove = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      const hovered = target?.closest?.('table') as HTMLTableElement | null;

      if (hovered) {
        if (hovered !== currentTableRef.current) {
          currentTableRef.current = hovered;
          setGeometry(measure(hovered));
        }
        return;
      }

      // 没直接命中表格，但可能落在外扩范围内（右侧加列条、下方加行条）
      const current = currentTableRef.current;
      if (!current) return;
      const rect = current.getBoundingClientRect();
      const stillNear = isWithin(
        { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        event.clientX,
        event.clientY,
        HOVER_MARGIN,
      );
      if (!stillNear) {
        currentTableRef.current = null;
        setGeometry(null);
      }
    };

    const onPointerLeave = () => {
      currentTableRef.current = null;
      setGeometry(null);
    };

    document.addEventListener('pointermove', onPointerMove, { passive: true });
    root.addEventListener('pointerleave', onPointerLeave);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerleave', onPointerLeave);
    };
  }, [root]);

  /* ── 滚动 / 窗口尺寸变化时重新量，rAF 节流 ── */
  useEffect(() => {
    const schedule = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        refresh();
      });
    };

    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      cancelAnimationFrame(rafRef.current);
    };
  }, [refresh]);

  /* ── 表格自身尺寸变化（拖列宽、输入撑高）时重新量 ── */
  useEffect(() => {
    const table = geometry?.table;
    if (!table) return;
    const observer = new ResizeObserver(() => refresh());
    observer.observe(table);
    return () => observer.disconnect();
  }, [geometry?.table, refresh]);

  return geometry;
}
