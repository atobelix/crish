import { create } from 'zustand';
import { resolveTableId } from './tableIdentity';

export interface CellSelection {
  tableId: string;
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
  isEditing: boolean; // false = cell selection mode (range), true = cell in-place text edit mode (single)
}

export type ColumnAlignment = 'left' | 'center' | 'right';

interface TableState {
  tableWidths: Record<string, number[]>; // key: table block ID, value: column widths in px
  tableScrollLeft: Record<string, number>; // key: table block ID, value: horizontal scrollLeft in px
  tableAlignments: Record<string, ColumnAlignment[]>; // key: table block ID, value: alignments per column
  selectedCell: CellSelection | null;
  isDraggingCell: boolean;
  setColumnWidth: (tableId: string, colIndex: number, width: number) => void;
  setTableWidths: (tableId: string, widths: number[]) => void;
  setTableScrollLeft: (tableId: string, scrollLeft: number) => void;
  setTableAlignments: (tableId: string, alignments: ColumnAlignment[]) => void;
  /**
   * 自愈读取：列数不符即视为脏状态并丢弃（返回 `undefined`），由调用方重算。
   *
   * 背景（根因断层 D3 / 症状 S7）：视图状态以表格身份为键，而列数可能因
   * 增删列、表头编辑、身份迁移而与该表当前列数不一致；直接读取会得到
   * 「长度错位」的数组，导致列宽串列、对齐错位。
   * 权威：docs/table-systemic-remediation/03-分维-表格语义模型与身份SSOT.md
   */
  getWidthsFor: (tableId: string, cols: number) => number[] | undefined;
  /** 自愈读取：同 `getWidthsFor`，作用于列对齐。 */
  getAlignmentsFor: (tableId: string, cols: number) => ColumnAlignment[] | undefined;
  /**
   * 清理已不存在表格的视图状态（整文替换 / 文档大幅收缩后调用）。
   * @returns 被移除的 tableId 列表
   */
  pruneTables: (activeIds: ReadonlySet<string>) => string[];
  setSelectedCell: (cell: CellSelection | null) => void;
  setCellEditing: (isEditing: boolean) => void;
  setDraggingCell: (isDragging: boolean) => void;
  enterCellSelection: (tableId: string, startLine: number, startCol: number, endLine?: number, endCol?: number) => void;
  updateCellSelectionEnd: (endLine: number, endCol: number) => void;
  enterCellEdit: (tableId?: string, lineIndex?: number, colIndex?: number) => void;
  exitCellEdit: () => void;
  clearCellSelection: () => void;
}

export const useTableStore = create<TableState>((set, get) => ({
  tableWidths: {},
  tableScrollLeft: {},
  tableAlignments: {},
  selectedCell: null,
  isDraggingCell: false,
  setColumnWidth: (tableId, colIndex, width) =>
    set((state) => {
      const currentWidths = state.tableWidths[tableId] || [];
      const newWidths = [...currentWidths];
      newWidths[colIndex] = Math.max(50, width); // Minimum width of 50px
      return {
        tableWidths: {
          ...state.tableWidths,
          [tableId]: newWidths,
        },
      };
    }),
  setTableWidths: (tableId, widths) =>
    set((state) => ({
      tableWidths: {
        ...state.tableWidths,
        [tableId]: widths,
      },
    })),
  setTableScrollLeft: (tableId, scrollLeft) =>
    set((state) => {
      if (state.tableScrollLeft[tableId] === scrollLeft) return state;
      return {
        tableScrollLeft: {
          ...state.tableScrollLeft,
          [tableId]: scrollLeft,
        },
      };
    }),
  setTableAlignments: (tableId, alignments) =>
    set((state) => ({
      tableAlignments: {
        ...state.tableAlignments,
        [tableId]: alignments,
      },
    })),
  getWidthsFor: (tableId, cols) => {
    // 经 zustand 的 get() 读状态——不可写 `useTableStore.getState()`：
    // 那会让本 const 在自身初始化器中被引用，TS 无法推断类型（TS7022），
    // 并连锁把 useTableStore 退化为 any，波及全部消费点。
    const widths = get().tableWidths[tableId];
    if (!widths || widths.length !== cols) return undefined;
    return widths;
  },
  getAlignmentsFor: (tableId, cols) => {
    const alignments = get().tableAlignments[tableId];
    if (!alignments || alignments.length !== cols) return undefined;
    return alignments;
  },
  pruneTables: (activeIds) => {
    const removed: string[] = [];
    set((state) => {
      const nextWidths = { ...state.tableWidths };
      const nextScroll = { ...state.tableScrollLeft };
      const nextAlign = { ...state.tableAlignments };
      for (const key of Object.keys(nextWidths)) {
        if (!activeIds.has(key)) {
          delete nextWidths[key];
          removed.push(key);
        }
      }
      for (const key of Object.keys(nextScroll)) {
        if (!activeIds.has(key)) delete nextScroll[key];
      }
      for (const key of Object.keys(nextAlign)) {
        if (!activeIds.has(key)) delete nextAlign[key];
      }
      return {
        tableWidths: nextWidths,
        tableScrollLeft: nextScroll,
        tableAlignments: nextAlign,
      };
    });
    return removed;
  },
  setSelectedCell: (cell) =>
    set(() => ({
      selectedCell: cell,
    })),
  setDraggingCell: (isDragging) =>
    set(() => ({
      isDraggingCell: isDragging,
    })),
  setCellEditing: (isEditing) =>
    set((state) => ({
      selectedCell: state.selectedCell
        ? { ...state.selectedCell, isEditing }
        : null,
    })),
  enterCellSelection: (tableId, startLine, startCol, endLine, endCol) =>
    set(() => ({
      selectedCell: {
        tableId,
        startLine,
        startCol,
        endLine: endLine ?? startLine,
        endCol: endCol ?? startCol,
        isEditing: false,
      },
    })),
  updateCellSelectionEnd: (endLine, endCol) =>
    set((state) => ({
      selectedCell: state.selectedCell
        ? { ...state.selectedCell, endLine, endCol }
        : null,
    })),
  enterCellEdit: (tableId, lineIndex, colIndex) =>
    set((state) => {
      if (tableId !== undefined && lineIndex !== undefined && colIndex !== undefined) {
        return {
          selectedCell: {
            tableId,
            startLine: lineIndex,
            endLine: lineIndex,
            startCol: colIndex,
            endCol: colIndex,
            isEditing: true,
          },
        };
      }
      if (state.selectedCell) {
        return {
          selectedCell: {
            ...state.selectedCell,
            isEditing: true,
          },
        };
      }
      return state;
    }),
  exitCellEdit: () =>
    set((state) => ({
      selectedCell: state.selectedCell
        ? { ...state.selectedCell, isEditing: false }
        : null,
    })),
  clearCellSelection: () =>
    set(() => ({
      selectedCell: null,
    })),
}));

/**
 * 按行号取该行所属表格的**列宽真源**（ADR-4 / ADR-5）。
 *
 * 供高度预言机使用：表格行高预测必须按**真实列宽**逐列估算，
 * 否则列宽定型后预测必然失配（根因断层 D5 → 症状 S8 行位置与实际高度错位）。
 *
 * @param getLine 行文本访问器（惰性；由调用方注入，避免本模块反向依赖 EditorStore）
 * @param lineIndex 目标行号
 * @returns 已定型的列宽数组；该行不属于表格 / 列宽尚未定型时返回 `undefined`
 */
export function tableColWidthsAtLine(
  getLine: (i: number) => string,
  lineIndex: number
): readonly number[] | undefined {
  const id = resolveTableId(getLine, lineIndex);
  if (!id) return undefined;
  const widths = useTableStore.getState().tableWidths[id];
  return widths && widths.length > 0 ? widths : undefined;
}
