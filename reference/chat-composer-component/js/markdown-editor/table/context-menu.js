/**
 * markdown-editor/table/context-menu.js
 * MdxTableContextMenu — floating context menu + header/body table IA
 *
 * Header (column-centric): insert/delete col, align L/C/R, merge/split, clear, copy
 * Body (row+content): insert/delete row/col, align, clear, copy/TSV, merge/split
 */
(function () {
  'use strict';

  var menuEl = null;
  var menuOnPick = null;
  var menuOutsideBound = false;

  function esc(s) {
    if (window.MdxUtil && window.MdxUtil.esc) return window.MdxUtil.esc(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ensureMenuEl() {
    if (menuEl && menuEl.parentNode) return menuEl;
    menuEl = document.createElement('div');
    menuEl.className = 'mdx-ctx-menu';
    menuEl.setAttribute('role', 'menu');
    menuEl.hidden = true;
    document.body.appendChild(menuEl);
    return menuEl;
  }

  function close() {
    if (!menuEl) return;
    menuEl.hidden = true;
    menuEl.classList.remove('is-visible');
    menuEl.removeAttribute('data-open');
    menuEl.innerHTML = '';
    menuOnPick = null;
  }

  function onDocPointerDown(e) {
    if (!menuEl || menuEl.hidden) return;
    if (menuEl.contains(e.target)) return;
    close();
  }

  function onDocKeydown(e) {
    if (e.key === 'Escape' && menuEl && !menuEl.hidden) {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (!menuEl || menuEl.hidden) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
    var items = menuEl.querySelectorAll('.mdx-ctx-menu__item:not([disabled]):not(.is-disabled)');
    if (!items.length) return;
    var active = menuEl.querySelector('.mdx-ctx-menu__item.is-active, .mdx-ctx-menu__item:focus');
    var idx = -1;
    for (var i = 0; i < items.length; i++) {
      if (items[i] === active) {
        idx = i;
        break;
      }
    }
    if (e.key === 'Enter') {
      if (active && !active.disabled) {
        e.preventDefault();
        active.click();
      }
      return;
    }
    e.preventDefault();
    if (e.key === 'ArrowDown') idx = idx < items.length - 1 ? idx + 1 : 0;
    else idx = idx > 0 ? idx - 1 : items.length - 1;
    for (var j = 0; j < items.length; j++) items[j].classList.remove('is-active');
    items[idx].classList.add('is-active');
    items[idx].focus();
  }

  function bindMenuGlobal() {
    if (menuOutsideBound) return;
    menuOutsideBound = true;
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeydown, true);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {{ id?: string, label?: string, sep?: boolean, danger?: boolean, disabled?: boolean, check?: boolean, checked?: boolean }[]} items
   * @param {(id: string) => void} onPick
   */
  function open(x, y, items, onPick) {
    bindMenuGlobal();
    var el = ensureMenuEl();
    menuOnPick = onPick;
    var html = '';
    for (var i = 0; i < (items || []).length; i++) {
      var it = items[i];
      if (it.sep) {
        html += '<div class="mdx-ctx-menu__sep" role="separator"></div>';
        continue;
      }
      if (it.labelOnly || it.section) {
        html += '<div class="mdx-ctx-menu__label">' + esc(it.label || '') + '</div>';
        continue;
      }
      var checkMark = it.check ? (it.checked ? '✓ ' : '   ') : '';
      html +=
        '<button type="button" class="mdx-ctx-menu__item' +
        (it.danger ? ' mdx-ctx-menu__item--danger' : '') +
        (it.disabled ? ' is-disabled' : '') +
        '" role="menuitem" data-action="' +
        esc(it.id || '') +
        '"' +
        (it.disabled ? ' disabled' : '') +
        (it.check ? ' aria-checked="' + (it.checked ? 'true' : 'false') + '"' : '') +
        '>' +
        checkMark +
        esc(it.label || '') +
        '</button>';
    }
    el.innerHTML = html;
    el.hidden = false;
    el.classList.add('is-visible');
    el.setAttribute('data-open', 'true');

    el.style.left = '0px';
    el.style.top = '0px';
    var rect = el.getBoundingClientRect();
    var left = x;
    var top = y;
    var pad = 8;
    if (left + rect.width > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (top + rect.height > window.innerHeight - pad) {
      top = Math.max(pad, window.innerHeight - rect.height - pad);
    }
    if (left < pad) left = pad;
    if (top < pad) top = pad;
    el.style.left = left + 'px';
    el.style.top = top + 'px';

    el.onclick = function (e) {
      var btn = e.target && e.target.closest && e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      var action = btn.getAttribute('data-action');
      var pick = menuOnPick;
      close();
      if (action && pick) pick(action);
    };
  }

  function mergeModulePresent() {
    return !!(window.MdxTableMerge && window.MdxTableMerge.available && window.MdxTableMerge.available());
  }

  function selectionCount(ctx) {
    if (ctx.selCount != null) return ctx.selCount | 0;
    if (ctx.selection) {
      var s = ctx.selection;
      return (Math.abs(s.r1 - s.r0) + 1) * (Math.abs(s.c1 - s.c0) + 1);
    }
    return 1;
  }

  function canMergeFromCtx(ctx) {
    if (!mergeModulePresent()) return false;
    var n = selectionCount(ctx);
    if (n < 2) return false;
    if (!ctx.block || !ctx.selection) return n >= 2;
    var s = ctx.selection;
    // Prefer cells[] so merge module can normalize; span form also works
    var cells = [];
    var r0 = Math.min(s.r0, s.r1);
    var c0 = Math.min(s.c0, s.c1);
    var r1 = Math.max(s.r0, s.r1);
    var c1 = Math.max(s.c0, s.c1);
    for (var rr = r0; rr <= r1; rr++) {
      for (var cc = c0; cc <= c1; cc++) cells.push({ r: rr, c: cc });
    }
    var res = window.MdxTableMerge.canMerge(ctx.block, cells);
    return !!(res && res.ok);
  }

  function canSplitFromCtx(ctx) {
    if (!mergeModulePresent() || !ctx.block) return false;
    if (window.MdxTableMerge.isMergedAnchor) {
      return window.MdxTableMerge.isMergedAnchor(ctx.block, ctx.row | 0, ctx.col | 0);
    }
    var cell =
      ctx.block.cells &&
      ctx.block.cells[ctx.row] &&
      ctx.block.cells[ctx.row][ctx.col];
    if (!cell || cell.covered) return false;
    return (cell.rowspan || 1) > 1 || (cell.colspan || 1) > 1;
  }

  function rowCount(ctx) {
    if (ctx.rowCount != null) return ctx.rowCount;
    if (ctx.block && ctx.block.cells) return ctx.block.cells.length;
    if (ctx.block && ctx.block.rows) return ctx.block.rows.length;
    return 2;
  }

  function colCount(ctx) {
    if (ctx.colCount != null) return ctx.colCount;
    if (ctx.block && ctx.block.cells && ctx.block.cells[0]) return ctx.block.cells[0].length;
    if (ctx.block && ctx.block.rows && ctx.block.rows[0]) return ctx.block.rows[0].length;
    return 2;
  }

  /**
   * Header row cell menu — column-centric
   * @param {{ selCount?: number, selection?: object, block?: object, row?: number, col?: number, hasHeader?: boolean }} ctx
   */
  function headerItems(ctx) {
    ctx = ctx || {};
    var cols = colCount(ctx);
    var n = selectionCount(ctx);
    var mergeOk = canMergeFromCtx(ctx);
    var splitOk = canSplitFromCtx(ctx);
    var items = [
      { id: 'insert-col-left', label: '在左侧插入列' },
      { id: 'insert-col-right', label: '在右侧插入列' },
      { id: 'delete-col', label: '删除列', danger: true, disabled: cols <= 1 },
      { sep: true },
      { id: 'align-left', label: '左对齐' },
      { id: 'align-center', label: '居中对齐' },
      { id: 'align-right', label: '右对齐' },
      { sep: true },
      {
        id: 'toggle-header',
        label: '表头行',
        check: true,
        checked: ctx.hasHeader !== false && (ctx.block ? ctx.block.hasHeader !== false : true),
      },
    ];

    if (mergeModulePresent()) {
      items.push({ sep: true });
      items.push({
        id: 'merge-cells',
        label: '合并单元格',
        disabled: !mergeOk,
      });
      items.push({
        id: 'split-cell',
        label: '拆分单元格',
        disabled: !splitOk,
      });
    }

    items.push({ sep: true });
    items.push({ id: 'clear-cell', label: '清空内容' });
    items.push({ id: 'copy-text', label: n > 1 ? '复制' : '复制文本' });
    items.push({ id: 'copy-tsv', label: '复制为 TSV' });
    items.push({ id: 'paste', label: '粘贴' });
    return items;
  }

  /**
   * Body cell menu — row + content centric
   */
  function bodyItems(ctx) {
    ctx = ctx || {};
    var rows = rowCount(ctx);
    var cols = colCount(ctx);
    var n = selectionCount(ctx);
    var mergeOk = canMergeFromCtx(ctx);
    var splitOk = canSplitFromCtx(ctx);
    var items = [
      { id: 'insert-row-above', label: '在上方插入行' },
      { id: 'insert-row-below', label: '在下方插入行' },
      { id: 'delete-row', label: '删除行', danger: true, disabled: rows <= 1 },
      { sep: true },
      { id: 'insert-col-left', label: '在左侧插入列' },
      { id: 'insert-col-right', label: '在右侧插入列' },
      { id: 'delete-col', label: '删除列', danger: true, disabled: cols <= 1 },
      { sep: true },
      { id: 'align-left', label: '左对齐' },
      { id: 'align-center', label: '居中对齐' },
      { id: 'align-right', label: '右对齐' },
    ];

    if (mergeModulePresent()) {
      items.push({ sep: true });
      items.push({
        id: 'merge-cells',
        label: '合并单元格',
        disabled: !mergeOk,
      });
      items.push({
        id: 'split-cell',
        label: '拆分单元格',
        disabled: !splitOk,
      });
    }

    items.push({ sep: true });
    items.push({ id: 'clear-cell', label: '清空内容' });
    items.push({ id: 'copy-text', label: n > 1 ? '复制' : '复制文本' });
    items.push({ id: 'copy-tsv', label: '复制为 TSV' });
    items.push({ id: 'paste', label: '粘贴' });
    return items;
  }

  /**
   * Build items for hit cell context
   * @param {{ isHeader: boolean } & object} ctx
   */
  function buildItems(ctx) {
    ctx = ctx || {};
    return ctx.isHeader ? headerItems(ctx) : bodyItems(ctx);
  }

  // Back-compat alias used by older chrome
  window.MdxContextMenu = {
    open: open,
    close: close,
  };

  window.MdxTableContextMenu = {
    open: open,
    close: close,
    buildItems: buildItems,
    headerItems: headerItems,
    bodyItems: bodyItems,
    mergeModulePresent: mergeModulePresent,
  };
})();
