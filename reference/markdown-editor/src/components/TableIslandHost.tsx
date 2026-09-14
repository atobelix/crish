/**
 * TableIslandHost —— 岛宿主行（战役 table-systemic-remediation · T4）
 *
 * 权威文档：docs/table-systemic-remediation/04-分维-单容器渲染与测量时序.md §3.1
 *          docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（ADR-2 / ADR-5）
 *
 * 角色：表格在**外层虚拟化里的唯一虚拟项**（ADR-2「整表作为单一虚拟项」）。
 * 它承担三件事：
 *   ① 作为 `.virtual-row` 参与既有行定位通道（`data-index` + `rowRef` →
 *      `virtualizer.measureElement` / 点击定位 / 高度回填注册表），
 *      故位置与其它行**同构**，外层窗口/滚动/锚定逻辑零特判；
 *   ② 承载整表高度（岛自测量经 `onIslandHeight` 上报，I3 唯一上报源）；
 *   ③ 把引擎侧上下文（store / 装饰集 / 行高估算 / 列宽真源）转交给 `TableBlock`。
 *
 * 与 `LineItem` 的差别：内容不是一行，而是整个表格岛；行内定位样式为**静态**
 * （岛高度由内容决定，故不写 minHeight——`LineItem` 的 28px 兜底在这里会与
 * 岛自测量打架）。
 */
import React from 'react';
import type { EditorStore } from '../core/EditorStore';
import type { DecorationSet } from '../core/DecorationSet';
import { getLineState } from '../core/lineUnit';
import type { TableRangeInfo } from '../core/tableIslandRanges';
import { TableBlock } from './TableBlock';

/**
 * 岛宿主行定位样式（静态常量——岛高由岛自测量决定，故不含任何高度声明；
 * 引用稳定亦避免每帧新建对象触发下行 memo 失效）。
 */
const HOST_ROW_STYLE: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  width: '100%',
  maxWidth: '100%',
  minWidth: '100%',
  boxSizing: 'border-box',
};

export interface TableIslandHostProps {
  /** 表区间（含宿主行 / 分隔行 / 末行） */
  range: TableRangeInfo;
  /** 岛在岛内坐标下的可见顶部（= 虚拟滚动偏移 − 宿主行 start） */
  visibleTop: number;
  /** 外层可视高度 */
  visibleHeight: number;
  /** 已定型列宽（未定型 `undefined`，由岛内探针定型） */
  colWidths?: readonly number[];
  decorations: DecorationSet;
  decorationVersion: number;
  store: EditorStore;
  /** 流式末行行号（无则 null） */
  streamTailLine: number | null;
  estimateRowHeight: (lineIndex: number) => number;
  /** 岛高上报（唯一上报源，I3） */
  onIslandHeight: (height: number) => void;
  /** 岛内行实测样本（回喂预言机校准，不改行高） */
  onRowHeightMeasured?: (lineIndex: number, height: number) => void;
  /** 列宽定型回调（ADR-4 §3.5）：`(tableId, widths)`——宿主按身份转发 */
  onColWidths: (tableId: string, widths: number[]) => void;
  /** 行注册（外层虚拟化的行元素注册表） */
  rowRef: (el: HTMLElement | null) => void;
  useGpuLayer?: boolean;
  scrollLeft?: number;
  onScrollLeftChange?: (left: number) => void;
}

export const TableIslandHost: React.FC<TableIslandHostProps> = ({
  range,
  visibleTop,
  visibleHeight,
  colWidths,
  decorations,
  decorationVersion,
  store,
  streamTailLine,
  estimateRowHeight,
  onIslandHeight,
  onRowHeightMeasured,
  onColWidths,
  rowRef,
  useGpuLayer,
  scrollLeft,
  onScrollLeftChange,
}) => {
  // 列宽定型转发：把身份注入回调，保持岛内 `onColWidths` 引用稳定
  // （TableBlock 的定型 effect 依赖它，每帧新建闭包会造成无谓重跑）。
  const handleColWidths = React.useCallback(
    (widths: number[]) => onColWidths(range.id, widths),
    [onColWidths, range.id]
  );

  return (
  <div
    data-index={range.startLine}
    data-island-host={range.id}
    ref={rowRef}
    className={`virtual-row${useGpuLayer ? ' virtual-row-gpu' : ''}`.trim()}
    style={HOST_ROW_STYLE}
  >
    <TableBlock
      tableId={range.id}
      startLine={range.startLine}
      endLine={range.endLine}
      separatorLine={range.separatorLine}
      cols={range.cols}
      colWidths={colWidths}
      visibleTop={visibleTop}
      visibleHeight={visibleHeight}
      getLine={(i: number) => store.getState().getLine(i)}
      isCodeAt={(i: number) => getLineState(store.getState(), i)}
      decorations={decorations}
      decorationVersion={decorationVersion}
      store={store}
      streamTailLine={streamTailLine}
      estimateRowHeight={estimateRowHeight}
      onIslandHeight={onIslandHeight}
      onRowHeightMeasured={onRowHeightMeasured}
      onColWidths={handleColWidths}
      scrollLeft={scrollLeft}
      onScrollLeftChange={onScrollLeftChange}
    />
  </div>
  );
};
