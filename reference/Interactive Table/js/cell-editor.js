/**
 * cell-editor.js - 单元格内联编辑与高级键盘导航
 * 支持 Tab/Shift+Tab 换格换行、Enter 纵向向下漫游、聚焦撤销栈精准记录
 */

window.InteractiveTable = window.InteractiveTable || {};

window.InteractiveTable.CellEditor = class CellEditor {
  constructor(state, rootElement) {
    this.state = state;
    this.root = rootElement;
    this.activeCell = null;
    this.initialValue = '';

    this.bindEvents();
  }

  bindEvents() {
    // 聚焦时记录编辑前的原始快照
    this.root.addEventListener('focusin', (e) => {
      const cell = e.target.closest('td, th');
      if (!cell || !cell.isContentEditable) return;
      this.activeCell = cell;
      this.initialValue = cell.innerText.trim();
    });

    // 键盘导航
    this.root.addEventListener('keydown', (e) => {
      const cell = e.target.closest('td, th');
      if (!cell || !cell.isContentEditable) return;

      const rowIndex = parseInt(cell.dataset.row, 10);
      const colIndex = parseInt(cell.dataset.col, 10);
      const isHeader = cell.tagName.toLowerCase() === 'th';

      // ---------------- Tab 导航 ----------------
      if (e.key === 'Tab') {
        e.preventDefault();
        const totalCols = this.state.get().columns.length;
        const totalRows = this.state.get().rows.length;

        if (e.shiftKey) {
          // Shift + Tab: 向前导航
          if (colIndex > 0) {
            this.focusCell(isHeader ? -1 : rowIndex, colIndex - 1);
          } else if (!isHeader && rowIndex > 0) {
            this.focusCell(rowIndex - 1, totalCols - 1);
          } else if (!isHeader && rowIndex === 0 && this.state.get().hasHeaderRow) {
            this.focusCell(-1, totalCols - 1);
          }
        } else {
          // Tab: 向后导航
          if (colIndex < totalCols - 1) {
            this.focusCell(isHeader ? -1 : rowIndex, colIndex + 1);
          } else if (isHeader) {
            this.focusCell(0, 0);
          } else if (rowIndex < totalRows - 1) {
            this.focusCell(rowIndex + 1, 0);
          } else {
            this.state.insertRow();
            requestAnimationFrame(() => {
              this.focusCell(totalRows, 0);
            });
          }
        }
      }

      // ---------------- Enter 导航 ----------------
      else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const totalRows = this.state.get().rows.length;

        if (isHeader) {
          this.focusCell(0, colIndex);
        } else if (rowIndex < totalRows - 1) {
          this.focusCell(rowIndex + 1, colIndex);
        } else {
          this.state.insertRow();
          requestAnimationFrame(() => {
            this.focusCell(totalRows, colIndex);
          });
        }
      }

      // ---------------- 方向键导航 ----------------
      else if (e.key === 'ArrowDown') {
        const totalRows = this.state.get().rows.length;
        if (isHeader) {
          this.focusCell(0, colIndex);
        } else if (rowIndex < totalRows - 1) {
          this.focusCell(rowIndex + 1, colIndex);
        }
      } else if (e.key === 'ArrowUp') {
        if (!isHeader && rowIndex > 0) {
          this.focusCell(rowIndex - 1, colIndex);
        } else if (!isHeader && rowIndex === 0 && this.state.get().hasHeaderRow) {
          this.focusCell(-1, colIndex);
        }
      }
    });

    // 失焦时如果内容发生改变，提交到 State 并压入撤销历史栈
    this.root.addEventListener('focusout', (e) => {
      const cell = e.target.closest('td, th');
      if (!cell) return;

      const rowIndex = parseInt(cell.dataset.row, 10);
      const colIndex = parseInt(cell.dataset.col, 10);
      const isHeader = cell.tagName.toLowerCase() === 'th';
      const text = cell.innerText.trim();

      if (text !== this.initialValue) {
        this.state.updateCell(rowIndex, colIndex, text, isHeader);
      }
      this.activeCell = null;
      this.initialValue = '';
    });
  }

  focusCell(rowIndex, colIndex) {
    const selector = rowIndex === -1
      ? `th[data-col="${colIndex}"]`
      : `td[data-row="${rowIndex}"][data-col="${colIndex}"]`;
    
    const cell = this.root.querySelector(selector);
    if (cell) {
      cell.focus();
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(cell);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
};
