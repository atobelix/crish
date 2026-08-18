/**
 * markdown-editor/schema.js — Doc v2 契约、工厂、迁移
 * 真相源：docs/markdown-editor/10-data-format.md
 */
(function () {
  'use strict';

  var VERSION = 2;

  var BLOCK_TYPES = {
    paragraph: 1,
    heading: 1,
    bullet_item: 1,
    ordered_item: 1,
    task_item: 1,
    quote: 1,
    code: 1,
    table: 1,
    divider: 1,
    callout: 1,
    file_chip: 1,
    image: 1,
    toc: 1,
    math: 1,
    mermaid: 1,
    embed: 1,
  };

  function uid(prefix) {
    if (window.MdxUtil && window.MdxUtil.uid) return window.MdxUtil.uid(prefix || 'b');
    return (prefix || 'b') + '_' + Math.random().toString(36).slice(2, 10);
  }

  /**
   * @param {object} [partial]
   * @returns {object}
   */
  function createBlock(partial) {
    var p = partial || {};
    var block = {
      id: p.id || uid('b'),
      type: p.type && BLOCK_TYPES[p.type] ? p.type : p.type || 'paragraph',
      indent: typeof p.indent === 'number' ? Math.max(0, p.indent | 0) : 0,
    };

    if (p.text != null) block.text = String(p.text);
    else block.text = '';

    if (p.runs) block.runs = cloneRuns(p.runs);
    if (p.level != null) block.level = p.level;
    if (p.checked != null) block.checked = !!p.checked;
    if (p.lang != null) block.lang = String(p.lang);
    if (p.hasHeader != null) block.hasHeader = !!p.hasHeader;
    if (p.callout != null) block.callout = p.callout;
    if (p.path != null) block.path = String(p.path);
    // image / media
    if (p.src != null) block.src = String(p.src);
    if (p.alt != null) block.alt = String(p.alt);
    if (p.title != null) block.title = String(p.title);
    if (p.caption != null) block.caption = String(p.caption);
    // toc range
    if (p.minLevel != null) block.minLevel = p.minLevel | 0;
    if (p.maxLevel != null) block.maxLevel = p.maxLevel | 0;
    // table align[] vs image align string
    if (p.align) {
      if (Array.isArray(p.align)) block.align = p.align.slice();
      else if (typeof p.align === 'string') block.align = p.align;
    }
    if (p.meta) block.meta = Object.assign({}, p.meta);

    // image 默认
    if (block.type === 'image') {
      if (block.src == null) block.src = '';
      if (block.alt == null) block.alt = block.text || '';
    }
    // toc 默认
    if (block.type === 'toc') {
      if (block.minLevel == null) block.minLevel = 1;
      if (block.maxLevel == null) block.maxLevel = 6;
    }

    // 表格：优先 cells，兼容 rows
    if (p.cells) {
      block.cells = cloneCells(p.cells);
      block.rows = cellsToRows(block.cells);
    } else if (p.rows) {
      block.rows = JSON.parse(JSON.stringify(p.rows));
      block.cells = rowsToCells(block.rows);
    }

    if (block.type === 'table') {
      if (block.hasHeader == null) block.hasHeader = true;
      if (!block.cells || !block.cells.length) {
        block.cells = [
          [
            { text: '', header: true },
            { text: '', header: true },
            { text: '', header: true },
          ],
          [{ text: '' }, { text: '' }, { text: '' }],
          [{ text: '' }, { text: '' }, { text: '' }],
        ];
        block.rows = cellsToRows(block.cells);
      }
    }

    if (block.type === 'heading' && block.level == null) block.level = 1;
    if (block.type === 'task_item' && block.checked == null) block.checked = false;

    return block;
  }

  function cloneRuns(runs) {
    return (runs || []).map(function (r) {
      return {
        text: String(r.text || ''),
        marks: r.marks
          ? r.marks.map(function (m) {
              return Object.assign({}, m);
            })
          : undefined,
      };
    });
  }

  /**
   * cell shape: { text, header?, align?, rowspan?, colspan?, covered?, anchor? }
   * covered 槽：covered:true + anchor:{r,c}；text 推荐 ''
   */
  function copyCellFields(src, base) {
    var out = base || {};
    if (!src || typeof src !== 'object') return out;
    if (src.header != null) out.header = !!src.header;
    if (src.align) out.align = src.align;
    if (src.rowspan != null && (src.rowspan | 0) > 1) out.rowspan = src.rowspan | 0;
    if (src.colspan != null && (src.colspan | 0) > 1) out.colspan = src.colspan | 0;
    if (src.covered) {
      out.covered = true;
      if (src.anchor && typeof src.anchor.r === 'number' && typeof src.anchor.c === 'number') {
        out.anchor = { r: src.anchor.r | 0, c: src.anchor.c | 0 };
      }
    }
    return out;
  }

  function rowsToCells(rows) {
    return (rows || []).map(function (row, ri) {
      return (row || []).map(function (cell) {
        if (cell && typeof cell === 'object' && cell.text != null) {
          return copyCellFields(cell, {
            text: String(cell.text),
            header: !!cell.header,
          });
        }
        return { text: cell == null ? '' : String(cell), header: ri === 0 };
      });
    });
  }

  function cellsToRows(cells) {
    return (cells || []).map(function (row) {
      return (row || []).map(function (c) {
        // covered 推荐空串（I6）
        if (c && c.covered) return '';
        return c && c.text != null ? String(c.text) : '';
      });
    });
  }

  function cloneCells(cells) {
    return (cells || []).map(function (row) {
      return (row || []).map(function (c) {
        return copyCellFields(c, {
          text: c && c.text != null ? String(c.text) : '',
          header: !!(c && c.header),
        });
      });
    });
  }

  function emptyDoc() {
    return {
      version: VERSION,
      blocks: [createBlock({ type: 'paragraph', text: '' })],
    };
  }

  function cloneDoc(doc) {
    if (!doc) return emptyDoc();
    return {
      version: doc.version || VERSION,
      blocks: (doc.blocks || []).map(function (b) {
        return createBlock(b);
      }),
      meta: doc.meta ? JSON.parse(JSON.stringify(doc.meta)) : undefined,
    };
  }

  /**
   * 任意旧 doc → v2
   */
  function migrate(doc) {
    if (!doc || typeof doc !== 'object') return emptyDoc();
    var next = {
      version: VERSION,
      blocks: [],
      meta: doc.meta ? JSON.parse(JSON.stringify(doc.meta)) : undefined,
    };
    var list = doc.blocks || [];
    if (!list.length) {
      next.blocks = [createBlock({ type: 'paragraph', text: '' })];
      return next;
    }
    for (var i = 0; i < list.length; i++) {
      var b = list[i] || {};
      var type = b.type || 'paragraph';
      if (!BLOCK_TYPES[type]) {
        next.blocks.push(
          createBlock({
            type: 'paragraph',
            text: b.text || '',
            indent: b.indent || 0,
            meta: Object.assign({}, b.meta || {}, { unknownType: type }),
          })
        );
        continue;
      }
      next.blocks.push(createBlock(b));
    }
    return next;
  }

  function plainText(block) {
    if (!block) return '';
    if (block.runs && block.runs.length) {
      return block.runs
        .map(function (r) {
          return r.text || '';
        })
        .join('');
    }
    return block.text != null ? String(block.text) : '';
  }

  function setPlainText(block, text) {
    block.text = text != null ? String(text) : '';
    if (block.runs) delete block.runs;
    return block;
  }

  /** 表格工具 */
  function ensureTableShape(block) {
    if (!block || block.type !== 'table') return block;
    if (!block.cells || !block.cells.length) {
      if (block.rows) block.cells = rowsToCells(block.rows);
      else {
        block.cells = [
          [
            { text: '', header: true },
            { text: '', header: true },
          ],
          [{ text: '' }, { text: '' }],
        ];
      }
    }
    block.rows = cellsToRows(block.cells);
    return block;
  }

  function tableAddRow(block, atIndex) {
    ensureTableShape(block);
    var cols = (block.cells[0] && block.cells[0].length) || 1;
    var row = [];
    for (var c = 0; c < cols; c++) row.push({ text: '' });
    var i =
      atIndex == null ? block.cells.length : Math.max(0, Math.min(atIndex, block.cells.length));
    block.cells.splice(i, 0, row);
    block.rows = cellsToRows(block.cells);
    return block;
  }

  function tableAddCol(block, atIndex) {
    ensureTableShape(block);
    var i = atIndex;
    for (var r = 0; r < block.cells.length; r++) {
      var cell = {
        text: '',
        header: r === 0 && block.hasHeader !== false,
      };
      if (i == null || i >= block.cells[r].length) block.cells[r].push(cell);
      else block.cells[r].splice(Math.max(0, i), 0, cell);
    }
    block.rows = cellsToRows(block.cells);
    return block;
  }

  function tableRemoveRow(block, rowIndex) {
    ensureTableShape(block);
    if (block.cells.length <= 1) return block;
    if (rowIndex < 0 || rowIndex >= block.cells.length) return block;
    block.cells.splice(rowIndex, 1);
    block.rows = cellsToRows(block.cells);
    return block;
  }

  function tableRemoveCol(block, colIndex) {
    ensureTableShape(block);
    var cols = (block.cells[0] && block.cells[0].length) || 0;
    if (cols <= 1) return block;
    if (colIndex < 0 || colIndex >= cols) return block;
    for (var r = 0; r < block.cells.length; r++) {
      block.cells[r].splice(colIndex, 1);
    }
    block.rows = cellsToRows(block.cells);
    return block;
  }

  function tableSetCell(block, r, c, text) {
    ensureTableShape(block);
    if (!block.cells[r]) return block;
    if (!block.cells[r][c]) block.cells[r][c] = { text: '' };
    var cell = block.cells[r][c];
    // covered 槽写入映射到 anchor
    if (cell.covered && cell.anchor) {
      var ar = cell.anchor.r;
      var ac = cell.anchor.c;
      if (block.cells[ar] && block.cells[ar][ac]) {
        block.cells[ar][ac].text = text != null ? String(text) : '';
      }
    } else {
      cell.text = text != null ? String(text) : '';
    }
    block.rows = cellsToRows(block.cells);
    return block;
  }

  /**
   * 合并矩形 [r0..r0+rowSpan) × [c0..c0+colSpan)
   * 左上为 anchor；其余 covered + anchor 指针
   */
  function tableMerge(block, r0, c0, rowSpan, colSpan) {
    ensureTableShape(block);
    rowSpan = Math.max(1, rowSpan | 0);
    colSpan = Math.max(1, colSpan | 0);
    var rows = block.cells.length;
    var cols = (block.cells[0] && block.cells[0].length) || 0;
    if (r0 < 0 || c0 < 0 || r0 + rowSpan > rows || c0 + colSpan > cols) {
      return { ok: false, reason: 'out-of-range' };
    }
    if (rowSpan === 1 && colSpan === 1) return { ok: true, block: block };

    // 禁止跨 header/body（有表头时）
    if (block.hasHeader !== false && r0 === 0 && rowSpan > 1) {
      return { ok: false, reason: 'cross-header' };
    }

    var texts = [];
    var r, c, cell;
    for (r = r0; r < r0 + rowSpan; r++) {
      for (c = c0; c < c0 + colSpan; c++) {
        cell = block.cells[r][c];
        if (!cell) continue;
        if (cell.covered) return { ok: false, reason: 'overlap-covered' };
        if ((cell.rowspan || 1) > 1 || (cell.colspan || 1) > 1) {
          if (!(r === r0 && c === c0)) return { ok: false, reason: 'overlap-merge' };
        }
        if (cell.text) texts.push(String(cell.text));
      }
    }

    var anchor = block.cells[r0][c0] || { text: '' };
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
    block.rows = cellsToRows(block.cells);
    return { ok: true, block: block };
  }

  function tableSplit(block, r, c) {
    ensureTableShape(block);
    var cell = block.cells[r] && block.cells[r][c];
    if (!cell) return { ok: false, reason: 'no-cell' };
    var ar = r;
    var ac = c;
    if (cell.covered && cell.anchor) {
      ar = cell.anchor.r;
      ac = cell.anchor.c;
      cell = block.cells[ar][ac];
    }
    if (!cell) return { ok: false, reason: 'no-anchor' };
    var rs = cell.rowspan || 1;
    var cs = cell.colspan || 1;
    if (rs === 1 && cs === 1) return { ok: true, block: block };
    cell.rowspan = 1;
    cell.colspan = 1;
    var rr, cc;
    for (rr = ar; rr < ar + rs; rr++) {
      for (cc = ac; cc < ac + cs; cc++) {
        if (rr === ar && cc === ac) continue;
        block.cells[rr][cc] = { text: '' };
      }
    }
    block.rows = cellsToRows(block.cells);
    return { ok: true, block: block };
  }

  function tableCanMerge(block, r0, c0, rowSpan, colSpan) {
    var res = tableMerge(
      JSON.parse(JSON.stringify(ensureTableShape(createBlock(block)))),
      r0,
      c0,
      rowSpan,
      colSpan
    );
    return !!res.ok;
  }

  window.MdxSchema = {
    VERSION: VERSION,
    BLOCK_TYPES: BLOCK_TYPES,
    uid: uid,
    createBlock: createBlock,
    emptyDoc: emptyDoc,
    cloneDoc: cloneDoc,
    migrate: migrate,
    plainText: plainText,
    setPlainText: setPlainText,
    rowsToCells: rowsToCells,
    cellsToRows: cellsToRows,
    ensureTableShape: ensureTableShape,
    tableAddRow: tableAddRow,
    tableAddCol: tableAddCol,
    tableMerge: tableMerge,
    tableSplit: tableSplit,
    tableCanMerge: tableCanMerge,
    tableRemoveRow: tableRemoveRow,
    tableRemoveCol: tableRemoveCol,
    tableSetCell: tableSetCell,
  };
})();
