/**
 * markdown-editor/table/selection.js
 * F-T-0006 多选 / 框选 → window.MdxTableSelection
 *
 * 状态：anchor {r,c}, focus {r,c} → 逻辑矩形选区
 * API：begin / extend / clear / getRange / isSelected / getCells
 * 指针：mousedown → begin；超阈值拖动 → extend
 * 键盘：extendByKey / moveByKey（Shift+方向键由 editor 调用）
 *
 * create(tableRoot, opts) → 绑定 DOM 的控制器（chrome 用）
 * create(opts)            → 纯状态控制器（无 DOM）
 */
(function () {
  'use strict';

  var DEFAULT_THRESHOLD = 3;
  var CELL_SEL = '.mdx-td, .mdx-table__cell, th.mdx-td, td.mdx-td';

  function cellMeta(cellEl) {
    if (!cellEl) return null;
    var r = cellEl.getAttribute('data-r');
    var c = cellEl.getAttribute('data-c');
    if (r == null || c == null) return null;
    return { row: +r, col: +c, cellEl: cellEl };
  }

  function findCell(el, root) {
    if (!el || !el.closest) return null;
    var cell = el.closest(CELL_SEL);
    if (!cell || (root && !root.contains(cell))) return null;
    return cell;
  }

  function normalizeRange(sel) {
    if (!sel) return null;
    return {
      r0: Math.min(sel.r0, sel.r1),
      c0: Math.min(sel.c0, sel.c1),
      r1: Math.max(sel.r0, sel.r1),
      c1: Math.max(sel.c0, sel.c1),
    };
  }

  function rangeCount(sel) {
    var n = normalizeRange(sel);
    if (!n) return 0;
    return (n.r1 - n.r0 + 1) * (n.c1 - n.c0 + 1);
  }

  function rangeToCells(range) {
    var n = normalizeRange(range);
    if (!n) return [];
    var list = [];
    for (var r = n.r0; r <= n.r1; r++) {
      for (var c = n.c0; c <= n.c1; c++) list.push({ r: r, c: c });
    }
    return list;
  }

  function cellsToRange(cells) {
    if (!cells || !cells.length) return null;
    var r0 = cells[0].r;
    var r1 = cells[0].r;
    var c0 = cells[0].c;
    var c1 = cells[0].c;
    for (var i = 1; i < cells.length; i++) {
      r0 = Math.min(r0, cells[i].r);
      r1 = Math.max(r1, cells[i].r);
      c0 = Math.min(c0, cells[i].c);
      c1 = Math.max(c1, cells[i].c);
    }
    return { r0: r0, c0: c0, r1: r1, c1: c1 };
  }

  /**
   * @param {HTMLElement|object} [tableRootOrOpts]
   * @param {object} [options]
   */
  function create(tableRootOrOpts, options) {
    var tableRoot = null;
    var opts = {};
    if (tableRootOrOpts && tableRootOrOpts.nodeType === 1) {
      tableRoot = tableRootOrOpts;
      opts = options || {};
    } else {
      opts = tableRootOrOpts || {};
    }

    var threshold = opts.threshold != null ? opts.threshold : DEFAULT_THRESHOLD;
    var anchor = null; // { r, c }
    var focus = null;
    var drag = null;
    var bound = false;

    function fromAF() {
      if (!anchor || !focus) return null;
      return normalizeRange({
        r0: anchor.r,
        c0: anchor.c,
        r1: focus.r,
        c1: focus.c,
      });
    }

    function notify() {
      if (opts.onChange) opts.onChange(fromAF());
    }

    function clearClasses() {
      if (!tableRoot) return;
      var cells = tableRoot.querySelectorAll('.is-selected, .is-focused');
      for (var i = 0; i < cells.length; i++) {
        cells[i].classList.remove('is-selected');
        cells[i].classList.remove('is-focused');
        cells[i].removeAttribute('aria-selected');
      }
    }

    function applyClasses() {
      if (!tableRoot) return;
      clearClasses();
      var n = fromAF();
      if (!n) return;
      for (var r = n.r0; r <= n.r1; r++) {
        for (var c = n.c0; c <= n.c1; c++) {
          var el = tableRoot.querySelector(
            '.mdx-td[data-r="' +
              r +
              '"][data-c="' +
              c +
              '"], [data-r="' +
              r +
              '"][data-c="' +
              c +
              '"]'
          );
          if (el) {
            el.classList.add('is-selected');
            el.setAttribute('aria-selected', 'true');
            if (anchor && anchor.r === r && anchor.c === c) {
              el.classList.add('is-focused');
            }
          }
        }
      }
    }

    function begin(r, c) {
      anchor = { r: r | 0, c: c | 0 };
      focus = { r: r | 0, c: c | 0 };
      applyClasses();
      notify();
      return fromAF();
    }

    function extend(r, c) {
      if (!anchor) return begin(r, c);
      focus = { r: r | 0, c: c | 0 };
      applyClasses();
      notify();
      return fromAF();
    }

    function clear() {
      anchor = null;
      focus = null;
      clearClasses();
      notify();
    }

    function getRange() {
      return fromAF();
    }

    function setRange(next) {
      if (!next) {
        clear();
        return;
      }
      var n = normalizeRange(next);
      anchor = { r: n.r0, c: n.c0 };
      focus = { r: n.r1, c: n.c1 };
      // 若调用方带 anchor 角
      if (next.anchorR != null) anchor = { r: next.anchorR | 0, c: next.anchorC | 0 };
      applyClasses();
      notify();
    }

    function isSelected(r, c) {
      var n = fromAF();
      if (!n) return false;
      return r >= n.r0 && r <= n.r1 && c >= n.c0 && c <= n.c1;
    }

    function getCells() {
      return rangeToCells(fromAF());
    }

    function getAnchor() {
      return anchor ? { r: anchor.r, c: anchor.c } : null;
    }

    function getFocus() {
      return focus ? { r: focus.r, c: focus.c } : null;
    }

    function cellCount() {
      return rangeCount(fromAF());
    }

    function hasMulti() {
      return cellCount() > 1;
    }

    function extendByKey(key, bounds) {
      bounds = bounds || {};
      var maxR = bounds.maxR != null ? bounds.maxR : 1e9;
      var maxC = bounds.maxC != null ? bounds.maxC : 1e9;
      if (!anchor) return null;
      if (!focus) focus = { r: anchor.r, c: anchor.c };
      var nr = focus.r;
      var nc = focus.c;
      if (key === 'ArrowUp') nr = Math.max(0, nr - 1);
      else if (key === 'ArrowDown') nr = Math.min(maxR, nr + 1);
      else if (key === 'ArrowLeft') nc = Math.max(0, nc - 1);
      else if (key === 'ArrowRight') nc = Math.min(maxC, nc + 1);
      else return fromAF();
      return extend(nr, nc);
    }

    function moveByKey(key, bounds) {
      bounds = bounds || {};
      var maxR = bounds.maxR != null ? bounds.maxR : 1e9;
      var maxC = bounds.maxC != null ? bounds.maxC : 1e9;
      var cur = focus || anchor;
      if (!cur) return null;
      var nr = cur.r;
      var nc = cur.c;
      if (key === 'ArrowUp') nr = Math.max(0, nr - 1);
      else if (key === 'ArrowDown') nr = Math.min(maxR, nr + 1);
      else if (key === 'ArrowLeft') nc = Math.max(0, nc - 1);
      else if (key === 'ArrowRight') nc = Math.min(maxC, nc + 1);
      else return fromAF();
      return begin(nr, nc);
    }

    /* ---------- pointer (DOM-bound) ---------- */

    function onPointerDown(e) {
      if (e.button !== 0) return;
      var cell = findCell(e.target, tableRoot);
      if (!cell) return;
      var meta = cellMeta(cell);
      if (!meta) return;
      drag = {
        r: meta.row,
        c: meta.col,
        x: e.clientX,
        y: e.clientY,
        moved: false,
      };
      begin(meta.row, meta.col);
    }

    function onPointerMove(e) {
      if (!drag) return;
      var dx = Math.abs(e.clientX - drag.x);
      var dy = Math.abs(e.clientY - drag.y);
      if (!drag.moved && dx < threshold && dy < threshold) return;
      drag.moved = true;
      var hit = document.elementFromPoint(e.clientX, e.clientY);
      var cell = findCell(hit, tableRoot);
      if (!cell) return;
      var meta = cellMeta(cell);
      if (!meta) return;
      extend(meta.row, meta.col);
      e.preventDefault();
    }

    function onPointerEnterCell(e) {
      if (!drag || !drag.moved) return;
      var cell = findCell(e.target, tableRoot);
      if (!cell) return;
      var meta = cellMeta(cell);
      if (!meta) return;
      extend(meta.row, meta.col);
    }

    function onPointerUp() {
      drag = null;
    }

    function bind() {
      if (!tableRoot || bound) return;
      bound = true;
      tableRoot.addEventListener('pointerdown', onPointerDown);
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      tableRoot.addEventListener('pointerenter', onPointerEnterCell, true);
    }

    function unbind() {
      if (!bound) return;
      bound = false;
      if (tableRoot) {
        tableRoot.removeEventListener('pointerdown', onPointerDown);
        tableRoot.removeEventListener('pointerenter', onPointerEnterCell, true);
      }
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      drag = null;
    }

    function destroy() {
      unbind();
      clearClasses();
      anchor = null;
      focus = null;
    }

    return {
      // user / F-T-0006
      begin: begin,
      extend: extend,
      clear: clear,
      getRange: getRange,
      isSelected: isSelected,
      getCells: getCells,
      getAnchor: getAnchor,
      getFocus: getFocus,
      cellCount: cellCount,
      hasMulti: hasMulti,
      extendByKey: extendByKey,
      moveByKey: moveByKey,
      // chrome compat
      setRange: setRange,
      count: cellCount,
      normalize: normalizeRange,
      applyClasses: applyClasses,
      clearClasses: clearClasses,
      bind: bind,
      unbind: unbind,
      destroy: destroy,
      isDragging: function () {
        return !!(drag && drag.moved);
      },
      cellMeta: cellMeta,
      findCell: function (el) {
        return findCell(el, tableRoot);
      },
    };
  }

  /** 模块级轻量默认实例（无 DOM）— harness / 快捷 API */
  var _ephemeral = null;
  function ephemeral() {
    if (!_ephemeral) _ephemeral = create();
    return _ephemeral;
  }

  window.MdxTableSelection = {
    create: create,
    normalizeRange: normalizeRange,
    rangeCount: rangeCount,
    rangeToCells: rangeToCells,
    cellsToRange: cellsToRange,
    cellMeta: cellMeta,
    DRAG_THRESHOLD_PX: DEFAULT_THRESHOLD,
    // 模块级别名（无 tableRoot 的纯状态）
    setRange: function (range) {
      return ephemeral().setRange(range);
    },
    setSelection: function (range) {
      return ephemeral().setRange(range);
    },
    getRange: function () {
      return ephemeral().getRange();
    },
    getSelection: function () {
      return ephemeral().getRange();
    },
    clear: function () {
      return ephemeral().clear();
    },
    clearSelection: function () {
      return ephemeral().clear();
    },
    begin: function (r, c) {
      return ephemeral().begin(r, c);
    },
    extend: function (r, c) {
      return ephemeral().extend(r, c);
    },
    isSelected: function (r, c) {
      return ephemeral().isSelected(r, c);
    },
  };
})();
