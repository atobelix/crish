/**
 * column-manager.js - 列宽调整 (Resizing) 与列菜单呼出防抖
 */

window.InteractiveTable = window.InteractiveTable || {};

window.InteractiveTable.ColumnManager = class ColumnManager {
  constructor(state, rootElement, contextMenuManager) {
    this.state = state;
    this.root = rootElement;
    this.contextMenu = contextMenuManager;
    this.resizingCol = null;
    this.startX = 0;
    this.startWidth = 0;

    this.onMouseMove = this.onMouseMove.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);

    this.bindEvents();
  }

  bindEvents() {
    this.root.addEventListener('click', (e) => {
      const colBtn = e.target.closest('.col-handle-btn');
      if (colBtn && !colBtn.classList.contains('dragging')) {
        if (window.__interactiveTableApp?.dragDropManager?.justDragged) return;
        e.stopPropagation();
        const colIndex = parseInt(colBtn.dataset.col, 10);
        window.__interactiveTableApp?.selectionManager?.selectColumn(colIndex);
        this.contextMenu.openColumnMenu(colBtn, colIndex);
      }
    });

    this.root.addEventListener('mousedown', (e) => {
      const resizer = e.target.closest('.col-resizer');
      if (!resizer) return;

      e.preventDefault();
      e.stopPropagation();

      const colIndex = parseInt(resizer.dataset.col, 10);
      const col = this.state.get().columns[colIndex];
      if (!col) return;

      this.resizingCol = colIndex;
      this.startX = e.clientX;
      this.startWidth = col.width || 190;

      resizer.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      document.addEventListener('mousemove', this.onMouseMove);
      document.addEventListener('mouseup', this.onMouseUp);
    });
  }

  onMouseMove(e) {
    if (this.resizingCol === null) return;
    const deltaX = e.clientX - this.startX;
    const newWidth = Math.max(80, this.startWidth + deltaX);

    const colElements = this.root.querySelectorAll(`col[data-col="${this.resizingCol}"]`);
    colElements.forEach(el => {
      el.style.width = `${newWidth}px`;
    });

    this.syncControlsPosition();
  }

  onMouseUp(e) {
    if (this.resizingCol === null) return;
    const deltaX = e.clientX - this.startX;
    const finalWidth = Math.max(80, this.startWidth + deltaX);

    this.state.setColumnWidth(this.resizingCol, finalWidth);

    const resizers = this.root.querySelectorAll('.col-resizer.resizing');
    resizers.forEach(r => r.classList.remove('resizing'));

    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mouseup', this.onMouseUp);

    this.resizingCol = null;
  }

  syncControlsPosition() {
    const table = this.root.querySelector('.notion-table');
    if (!table) return;

    const headerCells = table.querySelectorAll('th, tr.header-row td');
    headerCells.forEach((th, idx) => {
      const colBtn = this.root.querySelector(`.col-handle-btn[data-col="${idx}"]`);
      if (colBtn && th) {
        const left = th.offsetLeft + th.offsetWidth / 2;
        colBtn.style.left = `${left}px`;
      }
    });
  }
};
