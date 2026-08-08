import { create } from 'zustand';

interface TableState {
  tableWidths: Record<string, number[]>; // key: table block ID (usually first line index or block signature), value: column widths in px
  setColumnWidth: (tableId: string, colIndex: number, width: number) => void;
  setTableWidths: (tableId: string, widths: number[]) => void;
}

export const useTableStore = create<TableState>((set) => ({
  tableWidths: {},
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
}));
