/**
 * markdown-editor/ui/table-chrome.js
 * Notion-style table chrome: hover + add row/col; wires selection, context menu, TSV.
 * D10: no textual「加行」「加列」buttons — only circular +
 *
 * Depends (optional graceful):
 *   MdxTableSelection, MdxTableMerge, MdxTableContextMenu, MdxTableTsv
 */
(function () {
  'use strict';

  var CHROME_KEY = '_mdxChrome';

  function CtxMenu() {
    return window.MdxTableContextMenu || window.MdxContextMenu || null;
  }

  function Selection() {
    return window.MdxTableSelection || null;
  }

  function Merge() {
    return window.MdxTableMerge || null;
  }

  function Tsv() {
    return window.MdxTableTsv || null;
  }

  function closeMenu() {
    var m = CtxMenu();
    if (m && m.close) m.close();
  }

  function cellMeta(cellEl, wrap) {
    if (!cellEl) return null;
    if (Selection() && Selection().cellMeta) {
      var base = Selection().cellMeta(cellEl);
      if (!base) return null;
      var isHeader = detectHeader(cellEl, wrap, base.row);
      return {
        row: base.row,
        col: base.col,
        isHeader: isHeader,
        cellEl: cellEl,
      };
    }
    var r = cellEl.getAttribute('data-r');
    var c = cellEl.getAttribute('data-c');
    if (r == null || c == null) return null;
    var ri = +r;
    return {
      row: ri,
      col: +c,
      isHeader: detectHeader(cellEl, wrap, ri),
      cellEl: cellEl,
    };
  }

  function detectHeader(cellEl, wrap, ri) {
    if (cellEl.tagName === 'TH' || cellEl.classList.contains('mdx-table__cell--header')) {
      return true;
    }
    if (ri !== 0) return false;
    var block =
      wrap && wrap[CHROME_KEY] && wrap[CHROME_KEY].handlers && wrap[CHROME_KEY].handlers.getBlock
        ? wrap[CHROME_KEY].handlers.getBlock()
        : null;
    return !block || block.hasHeader !== false;
  }

  /**
   * @param {HTMLElement} tableRoot  .mdx-table-wrap
   * @param {{
   *   onAddRow?: Function,
   *   onAddCol?: Function,
   *   onContextAction?: Function,
   *   getBlock?: Function
   * }} handlers
   */
  function enhance(tableRoot, handlers) {
    if (!tableRoot) return;
    destroy(tableRoot);
    handlers = handlers || {};

    // --- hover + controls (no Chinese text) ---
    var addCol = document.createElement('button');
    addCol.type = 'button';
    addCol.className = 'mdx-table-add-col';
    addCol.setAttribute('aria-label', '添加列');
    addCol.setAttribute('tabindex', '-1');
    addCol.textContent = '+';

    var addRow = document.createElement('button');
    addRow.type = 'button';
    addRow.className = 'mdx-table-add-row';
    addRow.setAttribute('aria-label', '添加行');
    addRow.setAttribute('tabindex', '-1');
    addRow.textContent = '+';

    // Remove legacy text toolbars if present
    var legacy = tableRoot.querySelectorAll('.mdx-table-tools');
    for (var li = 0; li < legacy.length; li++) {
      if (legacy[li].parentNode) legacy[li].parentNode.removeChild(legacy[li]);
    }

    tableRoot.appendChild(addCol);
    tableRoot.appendChild(addRow);

    // --- selection module ---
    var selCtrl = null;
    if (Selection() && Selection().create) {
      selCtrl = Selection().create(tableRoot, {
        threshold: 3,
        getBlock: handlers.getBlock,
      });
      selCtrl.bind();
    } else {
      // minimal fallback selection
      selCtrl = createFallbackSelection(tableRoot);
    }

    function onAddColClick(e) {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      if (handlers.onAddCol) handlers.onAddCol();
    }
    function onAddRowClick(e) {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      if (handlers.onAddRow) handlers.onAddRow();
    }

    function onContextMenu(e) {
      var cell =
        e.target &&
        e.target.closest &&
        e.target.closest('th, td, .mdx-td, .mdx-table__cell');
      if (!cell || !tableRoot.contains(cell)) return;
      e.preventDefault();
      e.stopPropagation();

      var meta = cellMeta(cell, tableRoot);
      if (!meta) return;

      var n = selCtrl.count ? selCtrl.count() : 0;
      var range = selCtrl.getRange ? selCtrl.getRange() : null;
      // Right-click outside selection → single cell
      if (n <= 1 || !range || meta.row < range.r0 || meta.row > range.r1 || meta.col < range.c0 || meta.col > range.c1) {
        if (selCtrl.setRange) {
          selCtrl.setRange({ r0: meta.row, c0: meta.col, r1: meta.row, c1: meta.col });
        }
        range = { r0: meta.row, c0: meta.col, r1: meta.row, c1: meta.col };
        n = 1;
      }

      meta.selection = range;
      meta.cells =
        selCtrl.getCells
          ? selCtrl.getCells()
          : window.MdxTableSelection && window.MdxTableSelection.rangeToCells
            ? window.MdxTableSelection.rangeToCells(range)
            : null;
      var block = handlers.getBlock ? handlers.getBlock() : null;
      var items;
      var menu = CtxMenu();
      var ctx = {
        isHeader: meta.isHeader,
        selection: range,
        selCount: n,
        block: block,
        row: meta.row,
        col: meta.col,
        hasHeader: block ? block.hasHeader !== false : true,
      };

      if (menu && menu.buildItems) {
        items = menu.buildItems(ctx);
      } else if (menu && menu.headerItems && menu.bodyItems) {
        items = meta.isHeader ? menu.headerItems(ctx) : menu.bodyItems(ctx);
      } else {
        items = meta.isHeader ? fallbackHeaderItems(n) : fallbackBodyItems(n);
      }

      var openFn = menu && menu.open ? menu.open.bind(menu) : null;
      if (!openFn) return;

      openFn(e.clientX, e.clientY, items, function (actionId) {
        // Merge preview clear
        if (Merge() && Merge().clearPreview) Merge().clearPreview(tableRoot);

        if (actionId === 'copy-tsv' && Tsv() && block) {
          Tsv().copyRange(block, range);
          if (handlers.onContextAction) handlers.onContextAction(actionId, meta);
          return;
        }
        if (actionId === 'copy-text' && Tsv() && block && n > 1) {
          Tsv().copyRange(block, range);
          if (handlers.onContextAction) handlers.onContextAction(actionId, meta);
          return;
        }
        if (handlers.onContextAction) {
          handlers.onContextAction(actionId, meta);
        }
      });
    }

    function onKeydown(e) {
      // Tab between cells when focus is inside table (backup if cell handlers missing)
      if (e.key !== 'Tab') return;
      var t = e.target;
      if (!t || !tableRoot.contains(t)) return;
      if (!t.classList || (!t.classList.contains('mdx-td') && !t.isContentEditable)) return;
      // Prefer editor's onTableKeydown when already bound; only handle if not prevented
      // Do not double-handle — editor already binds Tab. Leave no-op unless data flag.
      if (t.getAttribute('data-mdx-tab-bound') === '1') return;
      e.preventDefault();
      var cells = Array.prototype.slice.call(
        tableRoot.querySelectorAll('.mdx-td[contenteditable="true"], .mdx-td[contenteditable]')
      );
      var i = cells.indexOf(t);
      if (i < 0) return;
      var next = e.shiftKey ? cells[i - 1] : cells[i + 1];
      if (next) next.focus();
    }

    function onCopy(e) {
      if (!Tsv()) return;
      var range = selCtrl.getRange && selCtrl.getRange();
      var n = selCtrl.count ? selCtrl.count() : 0;
      if (n < 2 || !range) return;
      var block = handlers.getBlock ? handlers.getBlock() : null;
      if (!block) return;
      // Only intercept when selection spans multiple cells
      var tsv = Tsv().toTsv(block, range, 'blank');
      if (e.clipboardData) {
        e.clipboardData.setData('text/plain', tsv);
        e.preventDefault();
      }
      if (Tsv().writeClipboard) Tsv().writeClipboard(tsv);
    }

    function onPaste(e) {
      if (!Tsv()) return;
      var t = e.target;
      if (!t || !tableRoot.contains(t)) return;
      var text = Tsv().textFromPasteEvent(e);
      if (!text || !Tsv().looksLikeTsv(text)) return;
      // Multi-cell TSV paste → let editor handler via synthetic context action
      var cell = t.closest && t.closest('.mdx-td, th, td');
      var meta = cellMeta(cell, tableRoot);
      if (!meta) return;
      e.preventDefault();
      meta.pasteText = text;
      meta.selection = selCtrl.getRange ? selCtrl.getRange() : {
        r0: meta.row,
        c0: meta.col,
        r1: meta.row,
        c1: meta.col,
      };
      if (handlers.onContextAction) handlers.onContextAction('paste', meta);
    }

    addCol.addEventListener('click', onAddColClick);
    addRow.addEventListener('click', onAddRowClick);
    tableRoot.addEventListener('contextmenu', onContextMenu);
    tableRoot.addEventListener('keydown', onKeydown);
    tableRoot.addEventListener('copy', onCopy);
    tableRoot.addEventListener('paste', onPaste);

    // Chrome open state for focus-within visibility
    function onFocusIn() {
      tableRoot.classList.add('is-chrome-open');
    }
    function onFocusOut(e) {
      if (tableRoot.contains(e.relatedTarget)) return;
      tableRoot.classList.remove('is-chrome-open');
    }
    tableRoot.addEventListener('focusin', onFocusIn);
    tableRoot.addEventListener('focusout', onFocusOut);

    tableRoot[CHROME_KEY] = {
      handlers: handlers,
      addCol: addCol,
      addRow: addRow,
      selCtrl: selCtrl,
      selection: selCtrl,
      onAddColClick: onAddColClick,
      onAddRowClick: onAddRowClick,
      onContextMenu: onContextMenu,
      onKeydown: onKeydown,
      onCopy: onCopy,
      onPaste: onPaste,
      onFocusIn: onFocusIn,
      onFocusOut: onFocusOut,
      getSelection: function () {
        return selCtrl.getRange ? selCtrl.getRange() : null;
      },
      getCells: function () {
        if (selCtrl.getCells) return selCtrl.getCells();
        var rg = selCtrl.getRange ? selCtrl.getRange() : null;
        if (window.MdxTableSelection && window.MdxTableSelection.rangeToCells) {
          return window.MdxTableSelection.rangeToCells(rg);
        }
        return [];
      },
      extendByKey: function (key, limits) {
        if (selCtrl.extendByKey) return selCtrl.extendByKey(key, limits);
        return null;
      },
      clearSelection: function () {
        if (selCtrl.clear) selCtrl.clear();
      },
    };
  }

  function createFallbackSelection(tableRoot) {
    var sel = null;
    var drag = null;
    function clearSelClass() {
      var cells = tableRoot.querySelectorAll('.is-selected');
      for (var i = 0; i < cells.length; i++) cells[i].classList.remove('is-selected');
    }
    function applySelClass() {
      clearSelClass();
      if (!sel) return;
      var r0 = Math.min(sel.r0, sel.r1);
      var r1 = Math.max(sel.r0, sel.r1);
      var c0 = Math.min(sel.c0, sel.c1);
      var c1 = Math.max(sel.c0, sel.c1);
      for (var r = r0; r <= r1; r++) {
        for (var c = c0; c <= c1; c++) {
          var el = tableRoot.querySelector('.mdx-td[data-r="' + r + '"][data-c="' + c + '"]');
          if (el) el.classList.add('is-selected');
        }
      }
    }
    function onPointerDown(e) {
      if (e.button !== 0) return;
      var cell = e.target && e.target.closest && e.target.closest('.mdx-td');
      if (!cell || !tableRoot.contains(cell)) return;
      var meta = cellMeta(cell, tableRoot);
      if (!meta) return;
      drag = { r: meta.row, c: meta.col, x: e.clientX, y: e.clientY, moved: false };
    }
    function onPointerMove(e) {
      if (!drag) return;
      if (!drag.moved && Math.abs(e.clientX - drag.x) < 3 && Math.abs(e.clientY - drag.y) < 3) return;
      drag.moved = true;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      var cell = el && el.closest && el.closest('.mdx-td');
      if (!cell || !tableRoot.contains(cell)) return;
      var meta = cellMeta(cell, tableRoot);
      if (!meta) return;
      sel = { r0: drag.r, c0: drag.c, r1: meta.row, c1: meta.col };
      applySelClass();
      e.preventDefault();
    }
    function onPointerUp() {
      drag = null;
    }
    tableRoot.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    return {
      getRange: function () {
        if (!sel) return null;
        return {
          r0: Math.min(sel.r0, sel.r1),
          c0: Math.min(sel.c0, sel.c1),
          r1: Math.max(sel.r0, sel.r1),
          c1: Math.max(sel.c0, sel.c1),
        };
      },
      setRange: function (r) {
        sel = r;
        applySelClass();
      },
      count: function () {
        if (!sel) return 0;
        return (
          (Math.abs(sel.r1 - sel.r0) + 1) * (Math.abs(sel.c1 - sel.c0) + 1)
        );
      },
      bind: function () {},
      destroy: function () {
        tableRoot.removeEventListener('pointerdown', onPointerDown);
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        clearSelClass();
      },
      _fallback: true,
      onPointerDown: onPointerDown,
      onPointerMove: onPointerMove,
      onPointerUp: onPointerUp,
    };
  }

  function fallbackHeaderItems(selCount) {
    var items = [
      { id: 'insert-col-left', label: '在左侧插入列' },
      { id: 'insert-col-right', label: '在右侧插入列' },
      { id: 'delete-col', label: '删除列', danger: true },
      { sep: true },
      { id: 'align-left', label: '左对齐' },
      { id: 'align-center', label: '居中对齐' },
      { id: 'align-right', label: '右对齐' },
    ];
    if (selCount > 1) {
      items.push({ sep: true });
      items.push({ id: 'merge-cells', label: '合并单元格' });
    }
    items.push({ id: 'split-cell', label: '拆分单元格' });
    return items;
  }

  function fallbackBodyItems(selCount) {
    var items = [
      { id: 'insert-row-above', label: '在上方插入行' },
      { id: 'insert-row-below', label: '在下方插入行' },
      { id: 'delete-row', label: '删除行', danger: true },
      { sep: true },
      { id: 'clear-cell', label: '清空内容' },
      { id: 'copy-text', label: '复制文本' },
      { id: 'copy-tsv', label: '复制为 TSV' },
    ];
    if (selCount > 1) {
      items.push({ sep: true });
      items.push({ id: 'merge-cells', label: '合并单元格' });
    }
    items.push({ id: 'split-cell', label: '拆分单元格' });
    return items;
  }

  function destroy(tableRoot) {
    closeMenu();
    if (!tableRoot) return;
    var state = tableRoot[CHROME_KEY];
    if (!state) {
      var orphans = tableRoot.querySelectorAll('.mdx-table-add-col, .mdx-table-add-row');
      for (var i = 0; i < orphans.length; i++) {
        if (orphans[i].parentNode) orphans[i].parentNode.removeChild(orphans[i]);
      }
      return;
    }
    if (state.selCtrl && state.selCtrl.destroy) state.selCtrl.destroy();
    if (Merge() && Merge().clearPreview) Merge().clearPreview(tableRoot);
    if (state.addCol) {
      state.addCol.removeEventListener('click', state.onAddColClick);
      if (state.addCol.parentNode) state.addCol.parentNode.removeChild(state.addCol);
    }
    if (state.addRow) {
      state.addRow.removeEventListener('click', state.onAddRowClick);
      if (state.addRow.parentNode) state.addRow.parentNode.removeChild(state.addRow);
    }
    tableRoot.removeEventListener('contextmenu', state.onContextMenu);
    if (state.onKeydown) tableRoot.removeEventListener('keydown', state.onKeydown);
    if (state.onCopy) tableRoot.removeEventListener('copy', state.onCopy);
    if (state.onPaste) tableRoot.removeEventListener('paste', state.onPaste);
    if (state.onFocusIn) tableRoot.removeEventListener('focusin', state.onFocusIn);
    if (state.onFocusOut) tableRoot.removeEventListener('focusout', state.onFocusOut);
    // legacy fallback pointer listeners were cleaned by selCtrl.destroy
    tableRoot.classList.remove('is-chrome-open');
    delete tableRoot[CHROME_KEY];
  }

  window.MdxTableChrome = {
    enhance: enhance,
    destroy: destroy,
  };
})();
