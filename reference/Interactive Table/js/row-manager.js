/**
 * row-manager.js - 行手柄点击菜单呼出防抖与纵向动态定位
 */

window.InteractiveTable = window.InteractiveTable || {};

window.InteractiveTable.RowManager = class RowManager {
  constructor(state, rootElement, contextMenuManager) {
    this.state = state;
    this.root = rootElement;
    this.contextMenu = contextMenuManager;

    this.bindEvents();
  }

  bindEvents() {
    this.root.addEventListener('click', (e) => {
      const rowBtn = e.target.closest('.row-handle-btn');
      if (rowBtn && !rowBtn.classList.contains('dragging')) {
        if (window.__interactiveTableApp?.dragDropManager?.justDragged) return;
        e.stopPropagation();
        const rowIndex = parseInt(rowBtn.dataset.row, 10);
        const isHeader = rowBtn.dataset.isHeader === 'true';
        this.contextMenu.openRowMenu(rowBtn, rowIndex, isHeader);
      }
    });
  }

  syncHandlesPosition() {
    const table = this.root.querySelector('.notion-table');
    if (!table) return;

    const trElements = table.querySelectorAll('tr');
    trElements.forEach((tr, idx) => {
      const rowBtn = this.root.querySelector(`.row-handle-btn[data-tr-index="${idx}"]`);
      if (rowBtn && tr) {
        const top = tr.offsetTop + tr.offsetHeight / 2 - 11;
        rowBtn.style.top = `${top}px`;
      }
    });
  }
};
