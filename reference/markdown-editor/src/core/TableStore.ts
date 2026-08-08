import { create } from 'zustand';

export interface SelectedCell {
  tableId: string;
  lineIndex: number;
  colIndex: number;
  isEditing: boolean; // false = cell selection mode (1-click), true = cell in-place text edit mode (2-click)
}

interface TableState {
  tableWidths: Record<string, number[]>; // key: table block ID, value: column widths in px
  selectedCell: SelectedCell | null;
  setColumnWidth: (tableId: string, colIndex: number, width: number) => void;
  setTableWidths: (tableId: string, widths: number[]) => void;
  setSelectedCell: (cell: SelectedCell | null) => void;
  setCellEditing: (isEditing: boolean) => void;
  enterCellSelection: (tableId: string, lineIndex: number, colIndex: number) => void;
  enterCellEdit: (tableId?: string, lineIndex?: number, colIndex?: number) => void;
  exitCellEdit: () => void;
  clearCellSelection: () => void;
}

export const useTableStore = create<TableState>((set) => ({
  tableWidths: {},
  selectedCell: null,
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
  setCellEditing: (isEditing) =>
    set((state) => ({
      selectedCell: state.selectedCell
        ? { ...state.selectedCell, isEditing }
        : null,
    })),
  enterCellSelection: (tableId, lineIndex, colIndex) =>
    set(() => ({
      selectedCell: {
        tableId,
        lineIndex,
        colIndex,
        isEditing: false,
      },
    })),
  enterCellEdit: (tableId, lineIndex, colIndex) =>
    set((state) => {
      if (tableId !== undefined && lineIndex !== undefined && colIndex !== undefined) {
        return {
          selectedCell: {
            tableId,
            lineIndex,
            colIndex,
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

