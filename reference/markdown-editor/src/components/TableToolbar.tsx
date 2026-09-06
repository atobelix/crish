import React from 'react';
import { useTableStore } from '../core/TableStore';
import { useEditorStore } from '../core/EditorStore';
import {
  mergeSelectedCells,
  unmergeCells,
  setColumnAlign,
  insertRow,
  insertColumn,
  deleteRow,
  deleteColumn,
  clearCell,
} from '../core/TableOperations';

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
      const cellEl =
        document.querySelector(
          `[data-table-id="${selectedCell.tableId}"][data-line-index="${selectedCell.startLine}"][data-col-index="${selectedCell.startCol}"]`
        ) ||
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

  const isMultiCell =
    selectedCell.startLine !== selectedCell.endLine ||
    selectedCell.startCol !== selectedCell.endCol;

  const handleMerge = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const state = editorStore.getState();
    const text = state.getText();
    const res = mergeSelectedCells(
      text,
      selectedCell.startLine,
      selectedCell.startCol,
      selectedCell.endLine,
      selectedCell.endCol
    );
    if (res.newText !== text) {
      state.applyTableChange(0, text.length, res.newText, res.newCursorPos);
      useTableStore.getState().enterCellSelection(
        selectedCell.tableId,
        Math.min(selectedCell.startLine, selectedCell.endLine),
        Math.min(selectedCell.startCol, selectedCell.endCol)
      );
    }
  };

  const handleUnmerge = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const state = editorStore.getState();
    const text = state.getText();
    const res = unmergeCells(text, selectedCell.startLine, selectedCell.startCol);
    if (res.newText !== text) {
      state.applyTableChange(0, text.length, res.newText, res.newCursorPos);
    }
  };

  const handleAlign = (align: 'left' | 'center' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const state = editorStore.getState();
    const text = state.getText();
    const res = setColumnAlign(text, state.cursorPos, align, selectedCell.startCol);
    if (res.newText !== text) {
      state.applyTableChange(0, text.length, res.newText, state.cursorPos);
      // 同步更新 TableStore 中的列对齐缓存
      const currentAlignments = [
        ...(useTableStore.getState().tableAlignments[selectedCell.tableId] || []),
      ];
      currentAlignments[selectedCell.startCol] = align;
      useTableStore.getState().setTableAlignments(selectedCell.tableId, currentAlignments);
    }
  };

  const handleInsertRow = (pos: 'above' | 'below') => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const state = editorStore.getState();
    const text = state.getText();
    const res = insertRow(text, state.cursorPos, pos);
    if (res.newText !== text) {
      state.applyTableChange(0, text.length, res.newText, res.newCursorPos);
    }
  };

  const handleInsertCol = (pos: 'left' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const state = editorStore.getState();
    const text = state.getText();
    const res = insertColumn(text, state.cursorPos, pos);
    if (res.newText !== text) {
      state.applyTableChange(0, text.length, res.newText, res.newCursorPos);
    }
  };

  const handleDeleteRow = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const state = editorStore.getState();
    const text = state.getText();
    const res = deleteRow(text, state.cursorPos);
    if (res.newText !== text) {
      state.applyTableChange(0, text.length, res.newText, res.newCursorPos);
    }
  };

  const handleDeleteCol = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const state = editorStore.getState();
    const text = state.getText();
    const res = deleteColumn(text, state.cursorPos);
    if (res.newText !== text) {
      state.applyTableChange(0, text.length, res.newText, res.newCursorPos);
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
        zIndex: 120,
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
          <span className="toolbar-btn-icon">🔲</span>
          <span className="toolbar-btn-text">合并</span>
        </button>
        <button
          type="button"
          className="table-toolbar-btn"
          onClick={handleUnmerge}
          title="拆分单元格 (还原为独立单元格)"
        >
          <span className="toolbar-btn-icon">✂️</span>
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
