/**
 * app.js - 主应用组装总装配
 * 组装状态机、渲染引擎、选区与解耦编辑、行列拖拽排序、边框扩展加号、右侧/底部快速新增
 */

(function () {
  const {
    TableState,
    TableRenderer,
    ContextMenuManager,
    SelectionManager,
    DragDropManager,
    DividerInserter,
    ColumnManager,
    RowManager,
    ClipboardManager
  } = window.InteractiveTable;

  class InteractiveTableApp {
    constructor(rootSelector) {
      this.root = document.querySelector(rootSelector);
      if (!this.root) {
        console.error(`Mount root "${rootSelector}" not found.`);
        return;
      }

      this.init();
    }

    init() {
      // 1. 初始化数据中心
      this.state = new TableState();

      // 2. 初始化渲染引擎
      this.renderer = new TableRenderer(this.state, this.root);
      this.renderer.render();

      // 3. 上下文菜单管理器
      this.contextMenu = new ContextMenuManager(this.state);

      // 4. 单元格选区与内联编辑解耦管理器 (单击选区/双击编辑/拖拽超出变框选)
      this.selectionManager = new SelectionManager(this.state, this.root);

      // 5. 行列手柄拖拽排序管理器 (严格对齐行列双模态拖拽)
      this.dragDropManager = new DragDropManager(this.state, this.root, this.contextMenu);

      // 6. 边框扩展像素灰变蓝与加号插入线 (严格还原图三与图四)
      this.dividerInserter = new DividerInserter(this.state, this.root);

      // 7. 列管理器 (列宽微调、列菜单)
      this.columnManager = new ColumnManager(this.state, this.root, this.contextMenu);

      // 8. 行管理器 (行菜单)
      this.rowManager = new RowManager(this.state, this.root, this.contextMenu);

      // 9. 剪贴板 TSV 互通管理器 (Excel / Word / Sheets 无缝互通与自动扩充)
      this.clipboardManager = new ClipboardManager(this.state, this.root, this.selectionManager);

      // 10. 绑定快速加列/加行与全局快捷键
      this.bindGlobalEvents();

      // 11. 订阅状态机变化，自动更新视图
      this.state.subscribe((_, actionType) => {
        if (actionType !== 'cell-updated') {
          this.renderer.render();
          if (actionType !== 'matrix-updated') {
            this.selectionManager.clearSelection();
          }
        }
      });

      // 11. 窗口缩放自适应手柄位置
      window.addEventListener('resize', () => {
        this.renderer.mountHandles();
      });
    }

    bindGlobalEvents() {
      // 点击右侧新增列条与底部新增行条
      this.root.addEventListener('click', (e) => {
        if (e.target.closest('#add-column-btn')) {
          this.state.insertColumn();
        } else if (e.target.closest('#add-row-btn')) {
          this.state.insertRow();
        }
      });

      // 全局快捷键: Ctrl+Z (撤销) / Ctrl+Y (重做)
      document.addEventListener('keydown', (e) => {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const isCtrl = isMac ? e.metaKey : e.ctrlKey;

        // 如果处于纯文本输入状态中，不抢占浏览器原生撤销
        if (this.selectionManager.mode === 'CELL_EDITING') return;

        if (isCtrl && !e.shiftKey && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          this.state.undo();
        } else if ((isCtrl && e.key.toLowerCase() === 'y') || (isCtrl && e.shiftKey && e.key.toLowerCase() === 'z')) {
          e.preventDefault();
          this.state.redo();
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    window.__interactiveTableApp = new InteractiveTableApp('#interactive-table-root');
  });
})();
