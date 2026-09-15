import React from 'react';
import { useTableStore } from '../core/TableStore';
import { useEditorStore } from '../core/EditorStore';
import {
  findTableRange,
  mergeSelectedCells,
  unmergeCells,
  setColumnAlign,
  insertRow,
  insertColumn,
  deleteRow,
  deleteColumn,
  type TableRange,
} from '../core/TableOperations';
import {
  isSingleCell,
  normalizeSelection,
  selectionToLines,
  lineToRow,
} from '../core/tableSelection';
import { TableCellsMerge, TableCellsSplit } from 'lucide-react';

/** 表内相对行数（分隔行不占行号）。 */
function rowCountOf(range: TableRange): number {
  return range.lines.length - (range.separatorLineIndex >= 0 ? 1 : 0);
}

/**
 * 表内相对**行下标** → 表内相对**行序**（分隔行不占行号）。
 * 经权威 `lineToRow` 折算，禁止本地 `startLine + row`（§3.1 唯一换算入口）。
 */
function relativeRowOf(range: TableRange, lineIdx: number): number | null {
  const start = range.startLineIndex;
  if (start === undefined) return null;
  const sep = range.separatorLineIndex >= 0 ? start + range.separatorLineIndex : null;
  return lineToRow(start + lineIdx, start, start + range.lines.length - 1, sep);
}

export const TableToolbar: React.FC = () => {
  const selectedCell = useTableStore((s) => s.selectedCell);
  const editorStore = useEditorStore;
  const tableScrollLeft = useTableStore(
    React.useCallback((s) => (selectedCell ? s.tableScrollLeft[selectedCell.tableId] ?? 0 : 0), [selectedCell])
  );
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null);

  React.useLayoutEffect(() => {
    if (!selectedCell) {
      setPos(null);
      return;
    }
    const updatePosition = () => {
      // 单元格 DOM 的定位键仍是文档绝对行号 → 经 `selectionToLines` 折算（唯一换算入口）；
      // 身份未观测过（null）时退回既有兜底选择器。
      const lines = selectionToLines(selectedCell);
      const cellEl =
        (lines
          ? document.querySelector(
              `[data-table-id="${selectedCell.tableId}"][data-line-index="${lines.startLine}"][data-col-index="${lines.startCol}"]`
            )
          : null) ||
        document.querySelector(
          '.token-table-cell.is-cell-selected, .token-table-cell.is-cell-editing'
        );
      if (!cellEl) return;
      const rect = cellEl.getBoundingClientRect();
      const container =
        cellEl.closest('.editor-scroll-container') ||
        document.querySelector('.editor-scroll-container');
      const cRect = container?.getBoundingClientRect() ?? { top: 0, left: 0, width: 800 };
      const scrollTop = container?.scrollTop ?? 0;
      const scrollLeft = container?.scrollLeft ?? 0;
      const toolbarWidth = 640;
      const rawLeft = rect.left - cRect.left + scrollLeft;
      const maxLeft = Math.max(10, cRect.width - toolbarWidth - 16);
      const clampedLeft = Math.max(10, Math.min(rawLeft, maxLeft));

      setPos({
        top: Math.max(10, rect.top - cRect.top + scrollTop - 44),
        left: clampedLeft,
      });
    };

    updatePosition();
    const container = document.querySelector('.editor-scroll-container');
    container?.addEventListener('scroll', updatePosition, { passive: true });
    window.addEventListener('resize', updatePosition);
    return () => {
      container?.removeEventListener('scroll', updatePosition);
      window.removeEventListener('resize', updatePosition);
    };
  }, [selectedCell, tableScrollLeft]);

  if (!selectedCell) return null;

  // 多格判定由权威 `isSingleCell` 派生（禁止各消费点自行求 min/max）
  const isMultiCell = !isSingleCell(selectedCell);

  const handleMerge = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const state = editorStore.getState();
    const text = state.getText();
    // 合并以**文档绝对行号**为输入 → 经 `selectionToLines` 折算；null = 身份未观测过 → 不动作
    const lines = selectionToLines(selectedCell);
    if (!lines) return;
    const res = mergeSelectedCells(
      text,
      lines.startLine,
      lines.startCol,
      lines.endLine,
      lines.endCol
    );
    if (res.newText !== text) {
      state.applyTableChange(0, text.length, res.newText, res.newCursorPos);
      // 合并后选区收缩为左上单格（既有语义；相对坐标由权威 `normalizeSelection` 派生）
      const b = normalizeSelection(selectedCell);
      useTableStore
        .getState()
        .enterCellSelection(selectedCell.tableId, { row: b.r0, col: b.c0 });
      // I7：结构操作后重映射选区（合并 → 收缩为 {r0,c0} 单格）
      useTableStore.getState().applyStructOp({ kind: 'merge' });
    }
  };

  const handleUnmerge = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const state = editorStore.getState();
    const text = state.getText();
    // 拆分以绝对行号为输入 → `selectionToLines` 折算；null = 身份未观测过 → 不动作
    const lines = selectionToLines(selectedCell);
    if (!lines) return;
    const res = unmergeCells(text, lines.startLine, lines.startCol);
    if (res.newText !== text) {
      state.applyTableChange(0, text.length, res.newText, res.newCursorPos);
      // I7：拆分 → 收缩为 master 单格
      useTableStore.getState().applyStructOp({ kind: 'unmerge' });
    }
  };

  const handleAlign = (align: 'left' | 'center' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const state = editorStore.getState();
    const text = state.getText();
    // 列下标与文档行号无关（列坐标系同源）：`anchor.col` 对应旧 `startCol`
    const col = selectedCell.anchor.col;
    const res = setColumnAlign(text, state.cursorPos, align, col);
    if (res.newText !== text) {
      state.applyTableChange(0, text.length, res.newText, state.cursorPos);
      // 同步更新 TableStore 中的列对齐缓存
      const currentAlignments = [
        ...(useTableStore.getState().tableAlignments[selectedCell.tableId] || []),
      ];
      currentAlignments[col] = align;
      useTableStore.getState().setTableAlignments(selectedCell.tableId, currentAlignments);
    }
  };

  const handleInsertRow = (pos: 'above' | 'below') => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const state = editorStore.getState();
    const cursorPos = state.cursorPos;
    const text = state.getText();
    const res = insertRow(text, cursorPos, pos);
    if (res.newText !== text) {
      state.applyTableChange(0, text.length, res.newText, res.newCursorPos);
      // I7 重映射：插入位取**操作自身落定的光标**所在行（不在渲染层复现 above/below 特判），
      // 经权威 `lineToRow` 折成表内相对行序；bounds 取操作**之后**的表行/列数。
      const after = findTableRange(res.newText, res.newCursorPos);
      const at = after ? relativeRowOf(after, after.activeLineIndex) : null;
      if (after && at !== null) {
        useTableStore
          .getState()
          .applyStructOp(
            { kind: 'insertRow', at },
            { rows: rowCountOf(after), cols: after.columnCount }
          );
      }
    }
  };

  const handleInsertCol = (pos: 'left' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const state = editorStore.getState();
    const cursorPos = state.cursorPos;
    const text = state.getText();
    const res = insertColumn(text, cursorPos, pos);
    if (res.newText !== text) {
      state.applyTableChange(0, text.length, res.newText, res.newCursorPos);
      // I7 重映射：新列占据操作落定光标所在的列下标（left/right 已由操作自身换算）
      const after = findTableRange(res.newText, res.newCursorPos);
      if (after) {
        useTableStore
          .getState()
          .applyStructOp(
            { kind: 'insertCol', at: after.activeCellIndex },
            { rows: rowCountOf(after), cols: after.columnCount }
          );
      }
    }
  };

  const handleDeleteRow = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const state = editorStore.getState();
    const cursorPos = state.cursorPos;
    const text = state.getText();
    // 删除位 = 操作消费的同一表区间里的活动行（`deleteRow` 直接以它为删除下标）
    const before = findTableRange(text, cursorPos);
    const res = deleteRow(text, cursorPos);
    if (res.newText !== text) {
      state.applyTableChange(0, text.length, res.newText, res.newCursorPos);
      if (before) {
        if (before.lines.length <= 2) {
          // 删到只剩 1 行 → TableOperations 整表删除（TableOperations.ts:245-250）
          useTableStore.getState().applyStructOp({ kind: 'deleteTable' });
        } else {
          const at = relativeRowOf(before, before.activeLineIndex);
          if (at !== null) {
            useTableStore
              .getState()
              .applyStructOp(
                { kind: 'deleteRow', at },
                { rows: rowCountOf(before) - 1, cols: before.columnCount }
              );
          }
        }
      }
    }
  };

  const handleDeleteCol = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const state = editorStore.getState();
    const cursorPos = state.cursorPos;
    const text = state.getText();
    // 删除位 = 操作消费的同一表区间里的活动列（`deleteColumn` 直接以它为删除下标）
    const before = findTableRange(text, cursorPos);
    const res = deleteColumn(text, cursorPos);
    if (res.newText !== text) {
      state.applyTableChange(0, text.length, res.newText, res.newCursorPos);
      if (before) {
        if (before.columnCount <= 1) {
          // 删到只剩 1 列 → TableOperations 整表删除（TableOperations.ts:323-328）
          useTableStore.getState().applyStructOp({ kind: 'deleteTable' });
        } else {
          useTableStore
            .getState()
            .applyStructOp(
              { kind: 'deleteCol', at: before.activeCellIndex },
              { rows: rowCountOf(before), cols: before.columnCount - 1 }
            );
        }
      }
    }
  };

  const handleInsertFormat = (prefix: string, suffix: string = prefix) => (
    e: React.MouseEvent
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const state = editorStore.getState();
    const selStart = state.selectionStart;
    const selEnd = state.selectionEnd;
    const text = state.getText();
    const from = Math.min(selStart, selEnd);
    const to = Math.max(selStart, selEnd);
    const selectedContent = text.substring(from, to);
    const inserted = `${prefix}${selectedContent || '文本'}${suffix}`;
    state.applyChange(from, to, inserted, {
      cursorAfter: from + inserted.length,
      merge: 'none',
    });
  };

  const handleInsertBr = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const state = editorStore.getState();
    const pos = state.cursorPos;
    state.applyChange(pos, pos, '<br>', {
      cursorAfter: pos + 4,
      merge: 'none',
    });
  };

  return (
    <div
      className="table-floating-toolbar"
      role="toolbar"
      aria-label="表格操作工具栏"
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: 'absolute',
        top: `${pos?.top ?? -9999}px`,
        left: `${pos?.left ?? -9999}px`,
        zIndex: 'var(--z-toolbar)',
        opacity: pos ? 1 : 0,
        pointerEvents: pos ? 'auto' : 'none',
        transition: 'opacity 0.15s ease',
      }}
    >
      <div className="table-toolbar-group">
        <button
          type="button"
          className="table-toolbar-btn"
          disabled={!isMultiCell}
          onClick={handleMerge}
          title={isMultiCell ? '合并单元格 (Excel 标准合并)' : '请先按住 Shift 或拖选多个单元格'}
        >
          <span className="toolbar-btn-icon"><TableCellsMerge size={14} /></span>
          <span className="toolbar-btn-text">合并</span>
        </button>
        <button
          type="button"
          className="table-toolbar-btn"
          onClick={handleUnmerge}
          title="拆分单元格 (还原为独立单元格)"
        >
          <span className="toolbar-btn-icon"><TableCellsSplit size={14} /></span>
          <span className="toolbar-btn-text">拆分</span>
        </button>
      </div>

      <div className="table-toolbar-separator" />

      <div className="table-toolbar-group">
        <button
          type="button"
          className="table-toolbar-btn"
          onClick={handleAlign('left')}
          title="左对齐 (:---)"
        >
          <span className="toolbar-btn-icon">⇤</span>
        </button>
        <button
          type="button"
          className="table-toolbar-btn"
          onClick={handleAlign('center')}
          title="居中对齐 (:---:)"
        >
          <span className="toolbar-btn-icon">⇔</span>
        </button>
        <button
          type="button"
          className="table-toolbar-btn"
          onClick={handleAlign('right')}
          title="右对齐 (---:)"
        >
          <span className="toolbar-btn-icon">⇥</span>
        </button>
      </div>

      <div className="table-toolbar-separator" />

      <div className="table-toolbar-group">
        <button
          type="button"
          className="table-toolbar-btn"
          onClick={handleInsertRow('above')}
          title="上方插入行"
        >
          +行↑
        </button>
        <button
          type="button"
          className="table-toolbar-btn"
          onClick={handleInsertRow('below')}
          title="下方插入行"
        >
          +行↓
        </button>
        <button
          type="button"
          className="table-toolbar-btn"
          onClick={handleInsertCol('left')}
          title="左侧插入列"
        >
          +列←
        </button>
        <button
          type="button"
          className="table-toolbar-btn"
          onClick={handleInsertCol('right')}
          title="右侧插入列"
        >
          +列→
        </button>
      </div>

      <div className="table-toolbar-separator" />

      <div className="table-toolbar-group">
        <button
          type="button"
          className="table-toolbar-btn font-bold"
          onClick={handleInsertFormat('**')}
          title="加粗 (Ctrl+B)"
        >
          B
        </button>
        <button
          type="button"
          className="table-toolbar-btn font-italic"
          onClick={handleInsertFormat('*')}
          title="斜体 (Ctrl+I)"
        >
          I
        </button>
        <button
          type="button"
          className="table-toolbar-btn font-strike"
          onClick={handleInsertFormat('~~')}
          title="删除线"
        >
          S
        </button>
        <button
          type="button"
          className="table-toolbar-btn font-code"
          onClick={handleInsertFormat('`')}
          title="行内代码"
        >
          &lt;/&gt;
        </button>
        <button
          type="button"
          className="table-toolbar-btn font-br"
          onClick={handleInsertBr}
          title="单元格内换行 (<br>)"
        >
          ↵换行
        </button>
      </div>

      <div className="table-toolbar-separator" />

      <div className="table-toolbar-group">
        <button
          type="button"
          className="table-toolbar-btn text-danger"
          onClick={handleDeleteRow}
          title="删除选中行"
        >
          删行
        </button>
        <button
          type="button"
          className="table-toolbar-btn text-danger"
          onClick={handleDeleteCol}
          title="删除选中列"
        >
          删列
        </button>
      </div>
    </div>
  );
};
