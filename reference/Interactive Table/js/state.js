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
      ],
      merges: [] // 合并单元格注册表 [{ id, minR, maxR, minC, maxC }]
    };
    if (!this.state.merges) this.state.merges = [];
  }

  // 静态工具：安全提取值与样式
  static getCellValue(raw) {
    if (raw === null || raw === undefined) return '';
    if (typeof raw === 'object') return raw.value ?? '';
    return String(raw);
  }

  static getCellStyle(raw) {
    if (raw && typeof raw === 'object' && raw.style) {
      return raw.style;
    }
    return {};
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

  // ------------------------- 单元格编辑与样式 -------------------------
  getCellValue(r, c) {
    if (r === -1) return TableState.getCellValue(this.state.headers[c]);
    return TableState.getCellValue(this.state.rows[r]?.cells[c]);
  }

  getCellStyle(r, c) {
    if (r === -1) return TableState.getCellStyle(this.state.headers[c]);
    return TableState.getCellStyle(this.state.rows[r]?.cells[c]);
  }

  updateCell(rowIndex, colIndex, value, isHeader = false) {
    this.pushHistory();
    if (isHeader) {
      const currentStyle = TableState.getCellStyle(this.state.headers[colIndex]);
      this.state.headers[colIndex] = Object.keys(currentStyle).length > 0
        ? { value, style: currentStyle }
        : value;
    } else {
      if (this.state.rows[rowIndex]) {
        const currentStyle = TableState.getCellStyle(this.state.rows[rowIndex].cells[colIndex]);
        this.state.rows[rowIndex].cells[colIndex] = Object.keys(currentStyle).length > 0
          ? { value, style: currentStyle }
          : value;
      }
    }
    this.notify('cell-updated');
  }

  // 批量应用样式修饰 (加粗、倾斜、下划线、删除线、文字颜色、背景填充、水平垂直对齐)
  applyCellStyle(range, patch) {
    if (!range || !patch) return;
    this.pushHistory();
    const { minR, maxR, minC, maxC } = range;
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        if (r === -1) {
          const raw = this.state.headers[c];
          const val = TableState.getCellValue(raw);
          const style = { ...TableState.getCellStyle(raw), ...patch };
          this.state.headers[c] = { value: val, style };
        } else if (this.state.rows[r]) {
          const raw = this.state.rows[r].cells[c];
          const val = TableState.getCellValue(raw);
          const style = { ...TableState.getCellStyle(raw), ...patch };
          this.state.rows[r].cells[c] = { value: val, style };
        }
      }
    }
    this.notify('cell-style-updated');
  }

  // 清除指定区域的格式样式 (保留文本内容)
  clearCellStyle(range) {
    if (!range) return;
    this.pushHistory();
    const { minR, maxR, minC, maxC } = range;
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        if (r === -1) {
          this.state.headers[c] = TableState.getCellValue(this.state.headers[c]);
        } else if (this.state.rows[r]) {
          this.state.rows[r].cells[c] = TableState.getCellValue(this.state.rows[r].cells[c]);
        }
      }
    }
    this.notify('cell-style-updated');
  }

  // 批量清空指定区域内的所有单元格 (保留单元格样式)
  clearCellsRange(minRow, maxRow, minCol, maxCol) {
    this.pushHistory();
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        if (r === -1) {
          const style = TableState.getCellStyle(this.state.headers[c]);
          this.state.headers[c] = Object.keys(style).length > 0 ? { value: '', style } : '';
        } else if (this.state.rows[r]) {
          const style = TableState.getCellStyle(this.state.rows[r].cells[c]);
          this.state.rows[r].cells[c] = Object.keys(style).length > 0 ? { value: '', style } : '';
        }
      }
    }
    this.notify('range-cleared');
  }

  // ------------------------- 单元格合并与拆分 -------------------------
  getMerges() {
    return this.state.merges || [];
  }

  getMergeAt(r, c) {
    const merges = this.getMerges();
    return merges.find(m => r >= m.minR && r <= m.maxR && c >= m.minC && c <= m.maxC) || null;
  }

  isMergeMaster(r, c) {
    const m = this.getMergeAt(r, c);
    return m ? (m.minR === r && m.minC === c) : false;
  }

  isMergeHidden(r, c) {
    const m = this.getMergeAt(r, c);
    return m ? !(m.minR === r && m.minC === c) : false;
  }

  mergeRange(range) {
    if (!range) return false;
    const { minR, maxR, minC, maxC } = range;
    const count = (maxR - minR + 1) * (maxC - minC + 1);
    if (count < 2) return false;

    this.pushHistory();
    this.state.merges = this.state.merges || [];

    // 移除与当前区域有重叠的旧合并块
    this.state.merges = this.state.merges.filter(m => {
      const overlapR = !(m.maxR < minR || m.minR > maxR);
      const overlapC = !(m.maxC < minC || m.minC > maxC);
      return !(overlapR && overlapC);
    });

    const newMerge = {
      id: 'merge_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      minR,
      maxR,
      minC,
      maxC
    };
    this.state.merges.push(newMerge);
    this.notify('cells-merged');
    return true;
  }

  splitMerge(rangeOrMergeId) {
    this.state.merges = this.state.merges || [];
    if (this.state.merges.length === 0) return false;

    this.pushHistory();
    let removed = false;

    if (typeof rangeOrMergeId === 'string') {
      const initLen = this.state.merges.length;
      this.state.merges = this.state.merges.filter(m => m.id !== rangeOrMergeId);
      removed = this.state.merges.length < initLen;
    } else if (rangeOrMergeId) {
      const { minR, maxR, minC, maxC } = rangeOrMergeId;
      const initLen = this.state.merges.length;
      this.state.merges = this.state.merges.filter(m => {
        const overlapR = !(m.maxR < minR || m.minR > maxR);
        const overlapC = !(m.maxC < minC || m.minC > maxC);
        return !(overlapR && overlapC);
      });
      removed = this.state.merges.length < initLen;
    }

    if (removed) {
      this.notify('cells-split');
      return true;
    }
    return false;
  }

  // 批量更新二维数据矩阵 (用于剪贴板 TSV 粘贴、批量导入)
  // 支持自动按需扩展列与行，单次事务入栈，确保高性能与无损撤销
  batchUpdateMatrix(startRow, startCol, matrix) {
    if (!matrix || matrix.length === 0) return { endRow: startRow, endCol: startCol };

    this.pushHistory();

    const maxPasteRows = matrix.length;
    let maxPasteCols = 0;
    matrix.forEach(row => {
      if (row.length > maxPasteCols) maxPasteCols = row.length;
    });

    const neededCols = startCol + maxPasteCols;
    const isStartHeader = startRow === -1;
    const bodyRowsNeeded = isStartHeader ? (maxPasteRows - 1) : (startRow + maxPasteRows);

    // 1. 自动向右扩展所需列数
    while (this.state.columns.length < neededCols) {
      const newColId = 'col_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
      this.state.columns.push({ id: newColId, width: 190 });
      this.state.headers.push('');
      this.state.rows.forEach(r => r.cells.push(''));
    }

    // 2. 自动向下扩展所需数据行数
    while (this.state.rows.length < bodyRowsNeeded) {
      const newRowId = 'row_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
      const cells = new Array(this.state.columns.length).fill('');
      this.state.rows.push({ id: newRowId, cells });
    }

    // 3. 填充数据
    for (let rIdx = 0; rIdx < matrix.length; rIdx++) {
      const targetRow = startRow + rIdx;
      const rowData = matrix[rIdx];

      for (let cIdx = 0; cIdx < rowData.length; cIdx++) {
        const targetCol = startCol + cIdx;
        const val = rowData[cIdx];

        if (targetRow === -1) {
          const currentStyle = TableState.getCellStyle(this.state.headers[targetCol]);
          this.state.headers[targetCol] = Object.keys(currentStyle).length > 0 ? { value: val, style: currentStyle } : val;
        } else if (targetRow >= 0 && this.state.rows[targetRow]) {
          const currentStyle = TableState.getCellStyle(this.state.rows[targetRow].cells[targetCol]);
          this.state.rows[targetRow].cells[targetCol] = Object.keys(currentStyle).length > 0 ? { value: val, style: currentStyle } : val;
        }
      }
    }

    this.notify('matrix-updated');

    const endRow = startRow + maxPasteRows - 1;
    const endCol = startCol + maxPasteCols - 1;
    return { endRow, endCol };
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
