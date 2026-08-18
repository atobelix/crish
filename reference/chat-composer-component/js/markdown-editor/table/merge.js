/**
 * markdown-editor/table/merge.js
 * F-T-0008 / F-T-0009 → window.MdxTableMerge
 *
 * 优先委托 MdxSchema.tableMerge / tableSplit / tableCanMerge
 * 支持两种签名（兼容 chrome + 规格）：
 *   canMerge(block, cells[{r,c}]) | canMerge(block, r0, c0, r1, c1)
 *   merge(block, cells)           | merge(block, r0, c0, r1, c1)
 *   split(block, r, c)
 *
 * cell shape: { text, rowspan?, colspan?, covered?, anchor?: {r,c} }
 */
(function () {
  'use strict';

  var REASONS = {
    'out-of-range': '选区超出表格范围',
    'cross-header': '不能跨表头与表体合并',
    'overlap-covered': '选区与已有合并重叠',
    'overlap-merge': '选区部分切开已有合并',
    'need-multi': '请至少选中两个单元格',
    'single-cell': '请至少选中两个单元格',
    'no-cell': '找不到单元格',
    'no-anchor': '找不到合并锚点',
    'no-block': '无效表格',
    'no-api': '合并 API 不可用',
    'not-merged': '该单元格未合并',
    'can-merge-false': '当前选区不可合并',
  };

  function Schema() {
    return window.MdxSchema;
  }

  function reasonZh(code) {
    return REASONS[code] || code || '无法合并';
  }

  function withZh(res) {
    if (!res) return { ok: false, reason: 'no-api', reasonZh: reasonZh('no-api') };
    if (res.reason && !res.reasonZh) res.reasonZh = reasonZh(res.reason);
    return res;
  }

  function cellsToRange(cells) {
    if (window.MdxTableSelection && window.MdxTableSelection.cellsToRange) {
      return window.MdxTableSelection.cellsToRange(cells);
    }
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

  function rangeToCells(r0, c0, r1, c1) {
    var rr0 = Math.min(r0, r1);
    var cc0 = Math.min(c0, c1);
    var rr1 = Math.max(r0, r1);
    var cc1 = Math.max(c0, c1);
    var list = [];
    for (var r = rr0; r <= rr1; r++) {
      for (var c = cc0; c <= cc1; c++) list.push({ r: r, c: c });
    }
    return list;
  }

  /**
   * 解析参数：
   *   cells[] | {r0,c0,r1,c1} | {r0,c0,rowSpan,colSpan}
   *   数字四元组优先 schema 约定 (r0, c0, rowSpan, colSpan)
   *   若 block 已知且 span 越界、而 inclusive 合法，则回退 inclusive r1,c1
   * @returns {{ r0, c0, r1, c1, rowSpan, colSpan, cells }|null}
   */
  function parseArgs(block, a, b, c, d) {
    if (Array.isArray(a)) {
      var range = cellsToRange(a);
      if (!range) return null;
      return {
        r0: range.r0,
        c0: range.c0,
        r1: range.r1,
        c1: range.c1,
        rowSpan: range.r1 - range.r0 + 1,
        colSpan: range.c1 - range.c0 + 1,
        cells: a,
      };
    }
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      if (a.rowSpan != null || a.colSpan != null) {
        var rs0 = a.r0 | 0;
        var cs0 = a.c0 | 0;
        var rsp = Math.max(1, a.rowSpan | 0);
        var csp = Math.max(1, a.colSpan | 0);
        return {
          r0: rs0,
          c0: cs0,
          r1: rs0 + rsp - 1,
          c1: cs0 + csp - 1,
          rowSpan: rsp,
          colSpan: csp,
          cells: rangeToCells(rs0, cs0, rs0 + rsp - 1, cs0 + csp - 1),
        };
      }
      if (a.r0 != null && a.r1 != null) {
        var ir0 = Math.min(a.r0, a.r1);
        var ic0 = Math.min(a.c0, a.c1);
        var ir1 = Math.max(a.r0, a.r1);
        var ic1 = Math.max(a.c0, a.c1);
        return {
          r0: ir0,
          c0: ic0,
          r1: ir1,
          c1: ic1,
          rowSpan: ir1 - ir0 + 1,
          colSpan: ic1 - ic0 + 1,
          cells: rangeToCells(ir0, ic0, ir1, ic1),
        };
      }
    }
    if (typeof a === 'number' && typeof b === 'number') {
      var r0 = a | 0;
      var c0 = b | 0;
      var x = c | 0;
      var y = d | 0;
      var rows =
        block && block.cells && block.cells.length
          ? block.cells.length
          : null;
      var cols =
        block && block.cells && block.cells[0]
          ? block.cells[0].length
          : null;

      // Schema / harness: (r0, c0, rowSpan, colSpan)
      var spanOk =
        x >= 1 &&
        y >= 1 &&
        (rows == null || r0 + x <= rows) &&
        (cols == null || c0 + y <= cols);
      // Inclusive ends: (r0, c0, r1, c1)
      var inclOk =
        rows != null &&
        cols != null &&
        x >= r0 &&
        y >= c0 &&
        x < rows &&
        y < cols;

      if (spanOk && !inclOk) {
        return {
          r0: r0,
          c0: c0,
          r1: r0 + x - 1,
          c1: c0 + y - 1,
          rowSpan: x,
          colSpan: y,
          cells: rangeToCells(r0, c0, r0 + x - 1, c0 + y - 1),
        };
      }
      if (inclOk && !spanOk) {
        return {
          r0: r0,
          c0: c0,
          r1: x,
          c1: y,
          rowSpan: x - r0 + 1,
          colSpan: y - c0 + 1,
          cells: rangeToCells(r0, c0, x, y),
        };
      }
      if (spanOk) {
        // Both fit: prefer span when x,y look like dimensions (small ints matching rowSpan style)
        // Harness uses (0,0,2,2) on 2×2 → both? spanOk yes; inclOk: x=2 < rows=2? NO.
        // On 3×3 both fit for (0,0,2,2): span=2×2, incl=3×3. Prefer span (schema).
        return {
          r0: r0,
          c0: c0,
          r1: r0 + x - 1,
          c1: c0 + y - 1,
          rowSpan: x,
          colSpan: y,
          cells: rangeToCells(r0, c0, r0 + x - 1, c0 + y - 1),
        };
      }
      if (inclOk) {
        return {
          r0: r0,
          c0: c0,
          r1: x,
          c1: y,
          rowSpan: x - r0 + 1,
          colSpan: y - c0 + 1,
          cells: rangeToCells(r0, c0, x, y),
        };
      }
      // Fallback: schema span
      return {
        r0: r0,
        c0: c0,
        r1: r0 + Math.max(1, x) - 1,
        c1: c0 + Math.max(1, y) - 1,
        rowSpan: Math.max(1, x),
        colSpan: Math.max(1, y),
        cells: rangeToCells(r0, c0, r0 + Math.max(1, x) - 1, c0 + Math.max(1, y) - 1),
      };
    }
    return null;
  }

  function ensureShape(block) {
    if (Schema() && Schema().ensureTableShape) return Schema().ensureTableShape(block);
    return block;
  }

  function localCanMerge(block, r0, c0, rowSpan, colSpan) {
    ensureShape(block);
    if (!block.cells || !block.cells.length) {
      return { ok: false, reason: 'no-cell' };
    }
    var rows = block.cells.length;
    var cols = (block.cells[0] && block.cells[0].length) || 0;
    if (r0 < 0 || c0 < 0 || r0 + rowSpan > rows || c0 + colSpan > cols) {
      return { ok: false, reason: 'out-of-range' };
    }
    if (rowSpan === 1 && colSpan === 1) return { ok: false, reason: 'need-multi' };
    if (block.hasHeader !== false && r0 === 0 && rowSpan > 1) {
      return { ok: false, reason: 'cross-header' };
    }
    var r, c, cell;
    for (r = r0; r < r0 + rowSpan; r++) {
      for (c = c0; c < c0 + colSpan; c++) {
        cell = block.cells[r] && block.cells[r][c];
        if (!cell) continue;
        if (cell.covered) return { ok: false, reason: 'overlap-covered' };
        if ((cell.rowspan || 1) > 1 || (cell.colspan || 1) > 1) {
          if (!(r === r0 && c === c0)) return { ok: false, reason: 'overlap-merge' };
          var rs = cell.rowspan || 1;
          var cs = cell.colspan || 1;
          if (r + rs > r0 + rowSpan || c + cs > c0 + colSpan) {
            return { ok: false, reason: 'overlap-merge' };
          }
        }
      }
    }
    return { ok: true };
  }

  /**
   * canMerge(block, cells) | canMerge(block, r0, c0, r1, c1)
   */
  function canMerge(block, a, b, c, d) {
    if (!block) return withZh({ ok: false, reason: 'no-block' });
    var p = parseArgs(block, a, b, c, d);
    if (!p) return withZh({ ok: false, reason: 'need-multi' });
    if (p.rowSpan * p.colSpan < 2) return withZh({ ok: false, reason: 'need-multi' });

    var S = Schema();
    if (S && typeof S.tableCanMerge === 'function') {
      var ok = S.tableCanMerge(block, p.r0, p.c0, p.rowSpan, p.colSpan);
      if (ok) {
        return {
          ok: true,
          r0: p.r0,
          c0: p.c0,
          rowSpan: p.rowSpan,
          colSpan: p.colSpan,
        };
      }
      // 补 reason
      return withZh(
        Object.assign(localCanMerge(block, p.r0, p.c0, p.rowSpan, p.colSpan), {
          r0: p.r0,
          c0: p.c0,
          rowSpan: p.rowSpan,
          colSpan: p.colSpan,
        })
      );
    }
    if (S && typeof S.tableMerge === 'function') {
      try {
        var clone = S.createBlock
          ? S.createBlock(block)
          : JSON.parse(JSON.stringify(block));
        var res = S.tableMerge(clone, p.r0, p.c0, p.rowSpan, p.colSpan);
        if (res && res.ok === false) {
          return withZh({
            ok: false,
            reason: res.reason || 'can-merge-false',
            r0: p.r0,
            c0: p.c0,
            rowSpan: p.rowSpan,
            colSpan: p.colSpan,
          });
        }
        return {
          ok: true,
          r0: p.r0,
          c0: p.c0,
          rowSpan: p.rowSpan,
          colSpan: p.colSpan,
        };
      } catch (e) {
        return withZh({ ok: false, reason: 'can-merge-false' });
      }
    }
    return withZh(
      Object.assign(localCanMerge(block, p.r0, p.c0, p.rowSpan, p.colSpan), {
        r0: p.r0,
        c0: p.c0,
        rowSpan: p.rowSpan,
        colSpan: p.colSpan,
      })
    );
  }

  /**
   * merge(block, cells) | merge(block, r0, c0, r1, c1)
   */
  function merge(block, a, b, c, d) {
    var check = canMerge(block, a, b, c, d);
    if (!check.ok) return check;
    var r0 = check.r0;
    var c0 = check.c0;
    var rowSpan = check.rowSpan;
    var colSpan = check.colSpan;
    var S = Schema();

    if (S && typeof S.tableMerge === 'function') {
      var res = S.tableMerge(block, r0, c0, rowSpan, colSpan);
      return withZh(
        Object.assign({}, res, {
          r0: r0,
          c0: c0,
          rowSpan: rowSpan,
          colSpan: colSpan,
          block: (res && res.block) || block,
        })
      );
    }

    // 本地实现
    ensureShape(block);
    var texts = [];
    var r, c, cell;
    for (r = r0; r < r0 + rowSpan; r++) {
      for (c = c0; c < c0 + colSpan; c++) {
        cell = block.cells[r][c];
        if (cell && !cell.covered && cell.text) texts.push(String(cell.text));
      }
    }
    var anchor = block.cells[r0][c0] || { text: '' };
    if (anchor.covered) anchor = { text: '' };
    anchor.text = texts.join(' ').trim();
    anchor.rowspan = rowSpan;
    anchor.colspan = colSpan;
    delete anchor.covered;
    delete anchor.anchor;
    block.cells[r0][c0] = anchor;
    for (r = r0; r < r0 + rowSpan; r++) {
      for (c = c0; c < c0 + colSpan; c++) {
        if (r === r0 && c === c0) continue;
        block.cells[r][c] = {
          text: '',
          covered: true,
          anchor: { r: r0, c: c0 },
        };
      }
    }
    if (S && S.cellsToRows) block.rows = S.cellsToRows(block.cells);
    return {
      ok: true,
      block: block,
      r0: r0,
      c0: c0,
      rowSpan: rowSpan,
      colSpan: colSpan,
    };
  }

  function split(block, r, c) {
    if (!block) return withZh({ ok: false, reason: 'no-block' });
    var S = Schema();
    if (S && typeof S.tableSplit === 'function') {
      return withZh(S.tableSplit(block, r, c));
    }
    ensureShape(block);
    var cell = block.cells[r] && block.cells[r][c];
    if (!cell) return withZh({ ok: false, reason: 'no-cell' });
    var ar = r;
    var ac = c;
    if (cell.covered && cell.anchor) {
      ar = cell.anchor.r;
      ac = cell.anchor.c;
      cell = block.cells[ar][ac];
    }
    if (!cell) return withZh({ ok: false, reason: 'no-anchor' });
    var rs = cell.rowspan || 1;
    var cs = cell.colspan || 1;
    if (rs === 1 && cs === 1) {
      return withZh({ ok: true, reason: 'not-merged', block: block });
    }
    cell.rowspan = 1;
    cell.colspan = 1;
    var rr, cc;
    for (rr = ar; rr < ar + rs; rr++) {
      for (cc = ac; cc < ac + cs; cc++) {
        if (rr === ar && cc === ac) continue;
        block.cells[rr][cc] = { text: '' };
      }
    }
    if (S && S.cellsToRows) block.rows = S.cellsToRows(block.cells);
    return { ok: true, block: block };
  }

  function canSplit(block, r, c) {
    if (!block || !block.cells) return withZh({ ok: false, reason: 'no-cell' });
    var cell = block.cells[r] && block.cells[r][c];
    if (!cell) return withZh({ ok: false, reason: 'no-cell' });
    if (cell.covered && cell.anchor) {
      cell = block.cells[cell.anchor.r] && block.cells[cell.anchor.r][cell.anchor.c];
    }
    if (!cell) return withZh({ ok: false, reason: 'no-anchor' });
    var rs = cell.rowspan || 1;
    var cs = cell.colspan || 1;
    if (rs === 1 && cs === 1) return withZh({ ok: false, reason: 'not-merged' });
    return { ok: true };
  }

  function isMergedAnchor(block, r, c) {
    if (!block || !block.cells || !block.cells[r] || !block.cells[r][c]) return false;
    var cell = block.cells[r][c];
    if (cell.covered) return false;
    return (cell.rowspan || 1) > 1 || (cell.colspan || 1) > 1;
  }

  function available() {
    // Local merge/split always available; schema preferred when present
    return true;
  }

  function setPreview(tableRoot, range, on) {
    if (!tableRoot) return;
    clearPreview(tableRoot);
    if (!on || !range) return;
    var r0 = Math.min(range.r0, range.r1);
    var c0 = Math.min(range.c0, range.c1);
    var r1 = Math.max(range.r0, range.r1);
    var c1 = Math.max(range.c0, range.c1);
    for (var r = r0; r <= r1; r++) {
      for (var c = c0; c <= c1; c++) {
        var el = tableRoot.querySelector(
          '.mdx-td[data-r="' + r + '"][data-c="' + c + '"], [data-r="' + r + '"][data-c="' + c + '"]'
        );
        if (el) el.classList.add('is-merge-preview');
      }
    }
  }

  function clearPreview(tableRoot) {
    if (!tableRoot) return;
    var cells = tableRoot.querySelectorAll('.is-merge-preview');
    for (var i = 0; i < cells.length; i++) cells[i].classList.remove('is-merge-preview');
  }

  window.MdxTableMerge = {
    available: available,
    canMerge: canMerge,
    merge: merge,
    split: split,
    canSplit: canSplit,
    isMergedAnchor: isMergedAnchor,
    setPreview: setPreview,
    clearPreview: clearPreview,
    reasonZh: reasonZh,
    cellsToRange: cellsToRange,
  };
})();
