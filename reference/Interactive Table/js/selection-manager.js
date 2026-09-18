/**
 * selection-manager.js - 单元格多选与内联编辑解耦管理器
 * 1. 单击单元格：单元格聚焦选中（蓝框，无光标）
 * 2. 双击或按键/回车：进入文字编辑态
 * 3. 拖拽解耦：在单元格内拖拽为选中文本；一旦超出单元格，立即切换为多单元格矩形范围框选
 * 4. 框选支持 Delete 批量清空、Escape 取消
 */

window.InteractiveTable = window.InteractiveTable || {};

window.InteractiveTable.SelectionManager = class SelectionManager {
  constructor(state, rootElement) {
    this.state = state;
    this.root = rootElement;

    this.mode = 'NONE'; // 'NONE' | 'CELL_SELECTED' | 'CELL_EDITING' | 'RANGE_SELECTED'
    this.activeCell = null; // { row, col, el }
    this.dragOriginCell = null;
    this.selectedRange = null; // { minR, maxR, minC, maxC }
    this.isMouseDown = false;

    this.rangeBox = null;

    this.onMouseDown = this.onMouseDown.bind(this);
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);
    this.onDoubleClick = this.onDoubleClick.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);

    this.bindEvents();
  }

  bindEvents() {
    this.root.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mouseup', this.onMouseUp);
    this.root.addEventListener('dblclick', this.onDoubleClick);
    document.addEventListener('keydown', this.onKeyDown);
    this.root.addEventListener('contextmenu', this.onContextMenu.bind(this));
  }

  onContextMenu(e) {
    const cell = e.target.closest('td, th');
    if (!cell) return;

    if (e.target.closest('.col-handle-btn, .row-handle-btn, .add-column-strip, .add-row-strip, .col-divider-badge, .row-divider-badge, .col-resizer')) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const cellInfo = this.getCellInfo(cell);
    if (!cellInfo) return;

    const isInsideRange = this.selectedRange &&
      cellInfo.row >= this.selectedRange.minR &&
      cellInfo.row <= this.selectedRange.maxR &&
      cellInfo.col >= this.selectedRange.minC &&
      cellInfo.col <= this.selectedRange.maxC;

    if (!isInsideRange) {
      this.selectSingleCell(cellInfo);
    }

    const range = this.selectedRange || {
      minR: cellInfo.row,
      maxR: cellInfo.row,
      minC: cellInfo.col,
      maxC: cellInfo.col
    };

    window.__interactiveTableApp?.contextMenu?.openCellContextMenu(e.clientX, e.clientY, cellInfo, range);
  }

  getRangeBox() {
    const contentArea = this.root.querySelector('.table-content-area');
    if (!this.rangeBox || !this.root.contains(this.rangeBox)) {
      this.rangeBox = document.createElement('div');
      this.rangeBox.className = 'selection-range-box';
      if (contentArea) contentArea.appendChild(this.rangeBox);
    }
    return this.rangeBox;
  }

  getCellInfo(el) {
    const cell = el?.closest('td, th');
    if (!cell) return null;
    const isHeader = cell.tagName.toLowerCase() === 'th';
    const row = isHeader ? -1 : parseInt(cell.dataset.row, 10);
    const col = parseInt(cell.dataset.col, 10);
    return { row, col, el: cell, isHeader };
  }

  onMouseDown(e) {
    if (e.button === 2) return; // 忽略鼠标右键

    // 忽略手柄、添加条、列宽调整器与弹窗点击
    if (e.target.closest('.col-handle-btn, .row-handle-btn, .add-column-strip, .add-row-strip, .col-resizer, .notion-popover')) {
      return;
    }

    const cellInfo = this.getCellInfo(e.target);
    if (!cellInfo) {
      this.clearSelection();
      return;
    }

    this.isMouseDown = true;
    this.dragOriginCell = cellInfo;

    // 如果当前处于某单元格的编辑态中
    if (this.mode === 'CELL_EDITING') {
      if (this.activeCell && this.activeCell.el === cellInfo.el) {
        // 在正在编辑的单元格内点击，保持编辑态，允许原生选取文字
        return;
      } else {
        // 点击其他单元格，退出前一个编辑态
        this.exitEditing();
      }
    }

    // 默认进入单单元格选中态
    this.selectSingleCell(cellInfo);
  }

  onMouseMove(e) {
    if (!this.isMouseDown || !this.dragOriginCell) return;

    const currentCell = this.getCellInfo(document.elementFromPoint(e.clientX, e.clientY));
    if (!currentCell) return;

    // 关键解耦逻辑：判断鼠标是否超出起始单元格
    if (currentCell.el !== this.dragOriginCell.el) {
      // 超出起始单元格边界：立即终止文本原生选择，无缝进入多选框选模式
      if (this.mode === 'CELL_EDITING') {
        this.exitEditing();
      }

      window.getSelection()?.removeAllRanges();
      this.mode = 'RANGE_SELECTED';

      // 考虑拖拽起始单元格与目标单元格若属于合并块时的真实物理几何边界
      const originMerge = this.state.getMergeAt ? this.state.getMergeAt(this.dragOriginCell.row, this.dragOriginCell.col) : null;
      const targetMerge = this.state.getMergeAt ? this.state.getMergeAt(currentCell.row, currentCell.col) : null;

      const originMinR = originMerge ? originMerge.minR : this.dragOriginCell.row;
      const originMaxR = originMerge ? originMerge.maxR : this.dragOriginCell.row;
      const originMinC = originMerge ? originMerge.minC : this.dragOriginCell.col;
      const originMaxC = originMerge ? originMerge.maxC : this.dragOriginCell.col;

      const targetMinR = targetMerge ? targetMerge.minR : currentCell.row;
      const targetMaxR = targetMerge ? targetMerge.maxR : currentCell.row;
      const targetMinC = targetMerge ? targetMerge.minC : currentCell.col;
      const targetMaxC = targetMerge ? targetMerge.maxC : currentCell.col;

      const rawMinR = Math.min(originMinR, targetMinR);
      const rawMaxR = Math.max(originMaxR, targetMaxR);
      const rawMinC = Math.min(originMinC, targetMinC);
      const rawMaxC = Math.max(originMaxC, targetMaxC);

      this.updateRangeSelection(rawMinR, rawMaxR, rawMinC, rawMaxC);
    }
  }

  onMouseUp() {
    this.isMouseDown = false;
  }

  onDoubleClick(e) {
    if (e.target.closest('.col-resizer')) return;
    const cellInfo = this.getCellInfo(e.target);
    if (cellInfo) {
      this.enterEditing(cellInfo);
    }
  }

  onKeyDown(e) {
    // 编辑态下由文本输入框自身或快捷键接管
    if (this.mode === 'CELL_EDITING') {
      if (e.key === 'Escape') {
        e.preventDefault();
        const cell = this.activeCell;
        this.exitEditing();
        if (cell) this.selectSingleCell(cell);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const cell = this.activeCell;
        this.exitEditing();
        // 自动聚焦到下一行
        if (cell) {
          const nextRow = cell.row + 1;
          const totalRows = this.state.get().rows.length;
          if (nextRow < totalRows) {
            this.selectSingleCell({ row: nextRow, col: cell.col });
          } else {
            this.state.insertRow();
            requestAnimationFrame(() => {
              this.selectSingleCell({ row: nextRow, col: cell.col });
            });
          }
        }
      }
      return;
    }

    // 框选态与单选态快捷操作
    if (this.mode === 'RANGE_SELECTED' || this.mode === 'CELL_SELECTED') {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        this.selectAll();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (this.activeCell) {
          if (this.activeCell.isHeader) {
            this.state.duplicateColumn(this.activeCell.col);
          } else {
            this.state.duplicateRow(this.activeCell.row);
          }
        }
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (this.selectedRange) {
          const { minR, maxR, minC, maxC } = this.selectedRange;
          this.state.clearCellsRange(minR, maxR, minC, maxC);
        } else if (this.activeCell) {
          this.state.updateCell(this.activeCell.row, this.activeCell.col, '', this.activeCell.isHeader);
        }
      } else if (e.key === 'Escape') {
        this.clearSelection();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (this.activeCell) {
          this.enterEditing(this.activeCell);
        }
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // 在选中态下直接按字符键：直接进入编辑态并录入字符
        if (this.activeCell) {
          this.enterEditing(this.activeCell, true);
        }
      }
    }
  }

  selectAll() {
    const data = this.state.get();
    const minR = data.hasHeaderRow ? -1 : 0;
    const maxR = data.rows.length - 1;
    const minC = 0;
    const maxC = data.columns.length - 1;
    this.mode = 'RANGE_SELECTED';
    this.updateRangeSelection(minR, maxR, minC, maxC);
  }

  selectRange(minR, maxR, minC, maxC) {
    this.clearSelection();
    this.mode = 'RANGE_SELECTED';
    this.updateRangeSelection(minR, maxR, minC, maxC);
  }

  selectColumn(colIndex) {
    this.clearSelection();
    const data = this.state.get();
    const minR = data.hasHeaderRow ? -1 : 0;
    const maxR = data.rows.length - 1;
    this.mode = 'RANGE_SELECTED';
    this.updateRangeSelection(minR, maxR, colIndex, colIndex);
  }

  selectRow(rowIndex) {
    this.clearSelection();
    const data = this.state.get();
    const minC = 0;
    const maxC = data.columns.length - 1;
    this.mode = 'RANGE_SELECTED';
    this.updateRangeSelection(rowIndex, rowIndex, minC, maxC);
  }

  expandRangeForMerges(range) {
    if (!range || !this.state.getMerges) return { ...range };
    const merges = this.state.getMerges();
    if (!merges || merges.length === 0) return { ...range };

    let { minR, maxR, minC, maxC } = range;
    let expanded = true;

    // 迭代级联外扩，直到当前矩形不再与任何合并单元格发生边缘截断相交
    while (expanded) {
      expanded = false;
      for (const m of merges) {
        // 判断当前选区与该合并块是否有交集
        const overlapR = !(m.maxR < minR || m.minR > maxR);
        const overlapC = !(m.maxC < minC || m.minC > maxC);

        if (overlapR && overlapC) {
          if (m.minR < minR) { minR = m.minR; expanded = true; }
          if (m.maxR > maxR) { maxR = m.maxR; expanded = true; }
          if (m.minC < minC) { minC = m.minC; expanded = true; }
          if (m.maxC > maxC) { maxC = m.maxC; expanded = true; }
        }
      }
    }

    return { minR, maxR, minC, maxC };
  }

  selectSingleCell(cellInfo) {
    this.clearSelection();
    
    let el = cellInfo.el;
    if (!el) {
      const sel = cellInfo.row === -1
        ? `th[data-col="${cellInfo.col}"]`
        : `td[data-row="${cellInfo.row}"][data-col="${cellInfo.col}"]`;
      el = this.root.querySelector(sel);
    }
    if (!el) return;

    this.activeCell = { row: cellInfo.row, col: cellInfo.col, el, isHeader: cellInfo.isHeader };
    this.mode = 'CELL_SELECTED';

    // 统一样式口径：无论是单选还是多选，统一由 updateRangeSelection 绘制带 2px 纯蓝描边的连续外包围框
    this.updateRangeSelection(cellInfo.row, cellInfo.row, cellInfo.col, cellInfo.col);
  }

  updateRangeSelection(minR, maxR, minC, maxC) {
    // 关键核心：自适应级联外扩，自动吞并相交的合并单元格，保证选区永不出现缺角与漏选白块
    const expanded = this.expandRangeForMerges({ minR, maxR, minC, maxC });
    minR = expanded.minR;
    maxR = expanded.maxR;
    minC = expanded.minC;
    maxC = expanded.maxC;

    this.selectedRange = { minR, maxR, minC, maxC };

    // 关键：清除单个单元格的 cell-focused 边框，确保多选时只显示统一的连续外包围框，杜绝出现双重框
    this.root.querySelectorAll('.cell-focused').forEach(c => c.classList.remove('cell-focused'));
    this.root.querySelectorAll('.cell-selected').forEach(c => c.classList.remove('cell-selected'));

    const cellsInRange = [];
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const sel = r === -1
          ? `th[data-col="${c}"]`
          : `td[data-row="${r}"][data-col="${c}"]`;
        const cell = this.root.querySelector(sel);
        if (cell) {
          cell.classList.add('cell-selected');
          cellsInRange.push(cell);
        }
      }
    }

    // 绘制围绕整块矩形选区的蓝色连续包围框
    this.drawRangeBox(cellsInRange);
  }

  drawRangeBox(cells) {
    if (!cells.length) return;

    const contentArea = this.root.querySelector('.table-content-area');
    if (!contentArea) return;

    const areaRect = contentArea.getBoundingClientRect();
    let minLeft = Infinity, minTop = Infinity, maxRight = -Infinity, maxBottom = -Infinity;

    cells.forEach(cell => {
      if (cell.classList.contains('cell-merged-hidden') || cell.style.display === 'none') return;
      const rect = cell.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      minLeft = Math.min(minLeft, rect.left);
      minTop = Math.min(minTop, rect.top);
      maxRight = Math.max(maxRight, rect.right);
      maxBottom = Math.max(maxBottom, rect.bottom);
    });

    const box = this.getRangeBox();
    box.style.display = 'block';
    box.style.left = `${minLeft - areaRect.left}px`;
    box.style.top = `${minTop - areaRect.top}px`;
    box.style.width = `${maxRight - minLeft}px`;
    box.style.height = `${maxBottom - minTop}px`;
  }

  enterEditing(cellInfo, clearInitial = false) {
    this.clearSelection();
    this.mode = 'CELL_EDITING';

    let el = cellInfo.el;
    if (!el) {
      const sel = cellInfo.row === -1
        ? `th[data-col="${cellInfo.col}"]`
        : `td[data-row="${cellInfo.row}"][data-col="${cellInfo.col}"]`;
      el = this.root.querySelector(sel);
    }
    if (!el) return;

    this.activeCell = { row: cellInfo.row, col: cellInfo.col, el, isHeader: cellInfo.isHeader };
    el.classList.add('editing');
    el.contentEditable = 'true';

    if (clearInitial) {
      el.innerText = '';
    }

    el.focus();

    // 移动光标至末尾
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(el);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  exitEditing() {
    if (this.mode !== 'CELL_EDITING' || !this.activeCell) return;
    const { row, col, el, isHeader } = this.activeCell;

    el.classList.remove('editing');
    el.contentEditable = 'false';

    const text = el.innerText.trim();
    this.state.updateCell(row, col, text, isHeader);

    this.mode = 'NONE';
    this.activeCell = null;
  }

  clearSelection() {
    this.mode = 'NONE';
    if (this.activeCell?.el) {
      this.activeCell.el.classList.remove('cell-focused');
      this.activeCell.el.classList.remove('editing');
      this.activeCell.el.contentEditable = 'false';
    }
    this.activeCell = null;
    this.selectedRange = null;

    this.root.querySelectorAll('.cell-selected, .cell-focused').forEach(c => {
      c.classList.remove('cell-selected');
      c.classList.remove('cell-focused');
    });

    if (this.rangeBox) {
      this.rangeBox.style.display = 'none';
    }
  }
};
