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
        window.__interactiveTableApp?.selectionManager?.selectRow(rowIndex);
        this.contextMenu.openRowMenu(rowBtn, rowIndex, isHeader);
      }
    });
  }

  syncHandlesPosition() {
    window.__interactiveTableApp?.renderer?.mountHandles();
  }
};
