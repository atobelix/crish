/**
 * TableBlock —— 表格岛组件（战役 table-systemic-remediation · T3）
 *
 * 权威文档：docs/table-systemic-remediation/04-分维-单容器渲染与测量时序.md
 *          docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（ADR-2 / ADR-4 / 裁决 R6）
 *
 * 与旧逐行渲染的**根本差别**（ADR-2）：
 *   旧路径：**每一行**各自一个 `.line-table`（`overflow-x: auto`）容器，跨行对齐靠
 *          `TableStore.tableScrollLeft` 手工回写 → 根因断层 D1（症状 S1 多滚动条 / S2 幽灵列）。
 *   岛路径：**整表一个**容器持有横向滚动；行是岛内的栅格行，共用同一列宽模板 →
 *          滚动所有权唯一（I1），无需跨行同步。
 *
 * 关键契约：
 *   - **单一横向滚动所有者**：本组件内只有根节点声明 `overflow-x`（由 `table-island` 类提供）；
 *     行容器**不得**再有滚动。
 *   - **列宽真源唯一**（ADR-4）：列宽经 `buildGridTemplate` 生成 `grid-template-columns`
 *     下发到每个行容器；栅格项上的 `flex` 声明自然失效（grid 忽略 flex），
 *     故旧路径的 per-cell `flex: 0 0 Npx` 写回对岛**无影响**。
 *   - **表头随表横向滚动**（裁决 R6）：表头行是岛内普通行，天然随岛滚动；
 *     **不做**文档级纵向吸顶（同一 `overflow-x` 容器无法同时提供两者）。
 *   - **岛内行窗口化**：仅在提供 `rowTops`（T4 接线）且行数超阈值时启用，
 *     窗口外用等高占位块维持滚动高度。
 *
 * 分阶段说明（`00-总方案` §9.1）：
 *   本组件在 T3 交付**布局引擎与组件本体**；**渲染路径接线**（把整表交由此组件渲染、
 *   外层虚拟化将其视为一个虚拟项）随 T4 落地——届时由 `isTableIslandEnabled()` 开关控制，
 *   默认关闭，旧逐行路径保持为默认行为。
 */
import React from 'react';
import type { InlineNode } from '../core/ast';
import type { ActiveState } from '../core/measure';
import { InlineRenderer } from './InlineRenderer';
import {
  ISLAND_WINDOW_THRESHOLD,
  buildGridTemplate,
  computeIslandWindow,
} from '../core/tableIsland';

/** 岛内一行所需的渲染数据（由外层按行装配）。 */
export interface TableIslandRow {
  /** 源码绝对行号。 */
  lineIndex: number;
  /** 是否表头行（来自 `tableIdentity.isTableHeaderRow`，I5 唯一入口）。 */
  isHeader: boolean;
  /** 该行的行内 token（parser 产物）。 */
  tokens: InlineNode[];
  /** 该行在文档中的起始偏移（`InlineRenderer` 需要）。 */
  lineOffset: number;
  /** 该行的活动态（光标/选区装饰）。 */
  activeState?: ActiveState | null;
}

export interface TableBlockProps {
  /** 表格身份（`tableIdentity.resolveTableId` 产出）。 */
  tableId: string;
  /** 岛内行（**不含**分隔行；顺序即渲染顺序）。 */
  rows: TableIslandRow[];
  /** 列宽（长度应与 `cols` 一致；不一致时按无宽度处理，由调用方自愈重算）。 */
  colWidths?: readonly number[];
  /** 岛相对外层滚动容器的可见顶部偏移（T4 接线；缺省 0）。 */
  visibleTop?: number;
  /** 外层可视高度（T4 接线；缺省 0）。 */
  visibleHeight?: number;
  /** 各行相对岛顶部的像素偏移（长度 = rows.length + 1；缺省则不窗口化）。 */
  rowTops?: readonly number[];
  /** 受控横向滚动位置（与 `TableStore.tableScrollLeft` 同源）。 */
  scrollLeft?: number;
  /** 横向滚动回调（节流后回写 store）。 */
  onScrollLeftChange?: (left: number) => void;
}

export const TableBlock: React.FC<TableBlockProps> = ({
  tableId,
  rows,
  colWidths,
  visibleTop = 0,
  visibleHeight = 0,
  rowTops,
  scrollLeft,
  onScrollLeftChange,
}) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const syncingRef = React.useRef(false);

  const gridTemplate = React.useMemo(() => buildGridTemplate(colWidths), [colWidths]);

  const win = React.useMemo(() => {
    if (!rowTops || rows.length <= ISLAND_WINDOW_THRESHOLD) return null;
    return computeIslandWindow(rows.length, rowTops, visibleTop, visibleHeight);
  }, [rows.length, rowTops, visibleTop, visibleHeight]);

  const visible = win ? rows.slice(win.startRow, win.endRow + 1) : rows;
  const topSpacer = win && win.startRow > 0 ? (rowTops?.[win.startRow] ?? 0) : 0;
  const bottomSpacer =
    win && rowTops ? Math.max(0, (rowTops[rowTops.length - 1] ?? 0) - (rowTops[win.endRow + 1] ?? 0)) : 0;

  // 受控 scrollLeft → 岛容器（与旧路径同款 rAF 守卫，避免回写回环）
  React.useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || scrollLeft === undefined) return;
    if (Math.abs(el.scrollLeft - scrollLeft) > 0.5) {
      syncingRef.current = true;
      el.scrollLeft = scrollLeft;
      requestAnimationFrame(() => {
        syncingRef.current = false;
      });
    }
  }, [scrollLeft]);

  const handleScroll = React.useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (syncingRef.current) return;
      onScrollLeftChange?.(e.currentTarget.scrollLeft);
    },
    [onScrollLeftChange]
  );

  const rowStyle = gridTemplate ? { gridTemplateColumns: gridTemplate } : undefined;

  return (
    <div
      className="table-island"
      data-table-id={tableId}
      ref={containerRef}
      onScroll={handleScroll}
    >
      {topSpacer > 0 && (
        <div className="table-island-spacer" style={{ height: topSpacer }} aria-hidden="true" />
      )}
      {visible.map((row) => (
        <div
          key={row.lineIndex}
          className={`line-table-row table-island-row${row.isHeader ? ' table-header-row' : ''}`}
          data-line-index={row.lineIndex}
          style={rowStyle}
        >
          <InlineRenderer
            tokens={row.tokens}
            lineOffset={row.lineOffset}
            activeState={row.activeState}
            tableId={tableId}
            lineIndex={row.lineIndex}
          />
        </div>
      ))}
      {bottomSpacer > 0 && (
        <div className="table-island-spacer" style={{ height: bottomSpacer }} aria-hidden="true" />
      )}
    </div>
  );
};
