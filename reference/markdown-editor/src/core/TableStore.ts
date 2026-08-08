import { create } from 'zustand';

export interface CellSelection {
  tableId: string;
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
  isEditing: boolean; // false = cell selection mode (range), true = cell in-place text edit mode (single)
}

interface TableState {
  tableWidths: Record<string, number[]>; // key: table block ID, value: column widths in px
  selectedCell: CellSelection | null;
  isDraggingCell: boolean;
  setColumnWidth: (tableId: string, colIndex: number, width: number) => void;
  setTableWidths: (tableId: string, widths: number[]) => void;
  setSelectedCell: (cell: CellSelection | null) => void;
  setCellEditing: (isEditing: boolean) => void;
  setDraggingCell: (isDragging: boolean) => void;
  enterCellSelection: (tableId: string, startLine: number, startCol: number, endLine?: number, endCol?: number) => void;
  updateCellSelectionEnd: (endLine: number, endCol: number) => void;
  enterCellEdit: (tableId?: string, lineIndex?: number, colIndex?: number) => void;
  exitCellEdit: () => void;
  clearCellSelection: () => void;
}

export const useTableStore = create<TableState>((set) => ({
  tableWidths: {},
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


