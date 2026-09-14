/**
 * state.js - 表格状态管理与响应式数据中心
 * 维护行列数据、表头开关、列宽以及撤销/重做快照
 */

window.InteractiveTable = window.InteractiveTable || {};

window.InteractiveTable.TableState = class TableState {
  constructor(initialData) {
    this.listeners = new Set();
    this.undoStack = [];
    this.redoStack = [];

    // 默认初始数据 - 严格对齐原图截屏内容
    this.state = initialData || {
      hasHeaderRow: true,
      hasHeaderColumn: false,
      columns: [
        { id: 'col_1', width: 190 },
        { id: 'col_2', width: 190 },
        { id: 'col_3', width: 190 }
      ],
      headers: ['Step size', 'Path', 'First step'],
      rows: [
        { id: 'row_1', cells: ['0.1', 'Gradual', '0.3'] },
        { id: 'row_2', cells: ['0.2', 'Steady', '0.6'] },
        { id: 'row_3', cells: ['0.5', 'Direct', '1.5'] },
        { id: 'row_4', cells: ['1.2', 'Alternating', '3.6'] }
      ]
    };
  }

  // 获取当前状态快照
  get() {
    return this.state;
  }

  // 订阅状态变更
  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  // 广播状态更新
  notify(actionType = 'update') {
    for (const listener of this.listeners) {
      listener(this.state, actionType);
    }
  }

  // 记录撤销快照
  pushHistory() {
    if (this.undoStack.length > 50) {
      this.undoStack.shift();
    }
    this.undoStack.push(JSON.stringify(this.state));
    this.redoStack = [];
  }

  undo() {
    if (this.undoStack.length === 0) return false;
    this.redoStack.push(JSON.stringify(this.state));
    const previous = JSON.parse(this.undoStack.pop());
    this.state = previous;
    this.notify('undo');
    return true;
  }

  redo() {
    if (this.redoStack.length === 0) return false;
    this.undoStack.push(JSON.stringify(this.state));
    const next = JSON.parse(this.redoStack.pop());
    this.state = next;
    this.notify('redo');
    return true;
  }

  // ------------------------- 单元格编辑 -------------------------
  updateCell(rowIndex, colIndex, value, isHeader = false) {
    this.pushHistory();
    if (isHeader) {
      this.state.headers[colIndex] = value;
    } else {
      if (this.state.rows[rowIndex]) {
        this.state.rows[rowIndex].cells[colIndex] = value;
      }
    }
    this.notify('cell-updated');
  }

  // 批量清空指定区域内的所有单元格
  clearCellsRange(minRow, maxRow, minCol, maxCol) {
    this.pushHistory();
    for (let r = minRow; r <= maxRow; r++) {
      if (r === -1) {
        for (let c = minCol; c <= maxCol; c++) {
          this.state.headers[c] = '';
        }
      } else if (this.state.rows[r]) {
        for (let c = minCol; c <= maxCol; c++) {
          this.state.rows[r].cells[c] = '';
        }
      }
    }
    this.notify('range-cleared');
  }

  // ------------------------- 列操作 -------------------------
  insertColumn(targetIndex, headerText = '', fillValue = '') {
    this.pushHistory();
    const newColId = 'col_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const insertIdx = targetIndex !== undefined ? targetIndex : this.state.columns.length;
    
    // 插入列定义
    this.state.columns.splice(insertIdx, 0, { id: newColId, width: 190 });
    // 插入表头
    this.state.headers.splice(insertIdx, 0, headerText);
    // 插入各行对应单元格
    this.state.rows.forEach(row => {
      row.cells.splice(insertIdx, 0, fillValue);
    });

    this.notify('column-inserted');
  }

  deleteColumn(colIndex) {
    if (this.state.columns.length <= 1) {
      alert('至少保留一列');
      return;
    }
    this.pushHistory();
    this.state.columns.splice(colIndex, 1);
    this.state.headers.splice(colIndex, 1);
    this.state.rows.forEach(row => {
      row.cells.splice(colIndex, 1);
    });
    this.notify('column-deleted');
  }

  duplicateColumn(colIndex) {
    this.pushHistory();
    const sourceCol = this.state.columns[colIndex];
    const newColId = 'col_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const insertIdx = colIndex + 1;

    this.state.columns.splice(insertIdx, 0, { id: newColId, width: sourceCol.width });
    this.state.headers.splice(insertIdx, 0, this.state.headers[colIndex] ? `${this.state.headers[colIndex]} (Copy)` : '');
    this.state.rows.forEach(row => {
      row.cells.splice(insertIdx, 0, row.cells[colIndex] || '');
    });

    this.notify('column-duplicated');
  }

  clearColumn(colIndex) {
    this.pushHistory();
    this.state.headers[colIndex] = '';
    this.state.rows.forEach(row => {
      row.cells[colIndex] = '';
    });
    this.notify('column-cleared');
  }

  setColumnWidth(colIndex, width) {
    const minWidth = 80;
    const finalWidth = Math.max(minWidth, width);
    if (this.state.columns[colIndex]) {
      this.state.columns[colIndex].width = finalWidth;
      this.notify('column-resized');
    }
  }

  // 列拖拽重排 (对应图二交互)
  reorderColumn(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    if (fromIndex >= this.state.columns.length || toIndex >= this.state.columns.length) return;

    this.pushHistory();

    const [movedCol] = this.state.columns.splice(fromIndex, 1);
    this.state.columns.splice(toIndex, 0, movedCol);

    const [movedHeader] = this.state.headers.splice(fromIndex, 1);
    this.state.headers.splice(toIndex, 0, movedHeader);

    this.state.rows.forEach(row => {
      const [movedCell] = row.cells.splice(fromIndex, 1);
      row.cells.splice(toIndex, 0, movedCell);
    });

    this.notify('column-reordered');
  }

  // ------------------------- 行操作 -------------------------
  insertRow(targetIndex, initialValues = null) {
    this.pushHistory();
    const newRowId = 'row_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const colCount = this.state.columns.length;
    const cells = initialValues ? [...initialValues] : new Array(colCount).fill('');
    
    while (cells.length < colCount) cells.push('');
    
    const insertIdx = targetIndex !== undefined ? targetIndex : this.state.rows.length;
    this.state.rows.splice(insertIdx, 0, { id: newRowId, cells });

    this.notify('row-inserted');
  }

  deleteRow(rowIndex) {
    if (this.state.rows.length <= 1) {
      alert('至少保留一行');
      return;
    }
    this.pushHistory();
    this.state.rows.splice(rowIndex, 1);
    this.notify('row-deleted');
  }

  duplicateRow(rowIndex) {
    this.pushHistory();
    const sourceRow = this.state.rows[rowIndex];
    const newRowId = 'row_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const insertIdx = rowIndex + 1;

    this.state.rows.splice(insertIdx, 0, {
      id: newRowId,
      cells: [...sourceRow.cells]
    });

    this.notify('row-duplicated');
  }

  clearRow(rowIndex) {
    this.pushHistory();
    const sourceRow = this.state.rows[rowIndex];
    if (sourceRow) {
      sourceRow.cells = sourceRow.cells.map(() => '');
      this.notify('row-cleared');
    }
  }

  // 行拖拽重排
  reorderRow(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    if (fromIndex >= this.state.rows.length || toIndex >= this.state.rows.length) return;

    this.pushHistory();
    const [movedRow] = this.state.rows.splice(fromIndex, 1);
    this.state.rows.splice(toIndex, 0, movedRow);

    this.notify('row-reordered');
  }

  // ------------------------- 开关表头 -------------------------
  toggleHeaderRow() {
    this.pushHistory();
    this.state.hasHeaderRow = !this.state.hasHeaderRow;
    this.notify('header-row-toggled');
  }

  toggleHeaderColumn() {
    this.pushHistory();
    this.state.hasHeaderColumn = !this.state.hasHeaderColumn;
    this.notify('header-column-toggled');
  }
};
