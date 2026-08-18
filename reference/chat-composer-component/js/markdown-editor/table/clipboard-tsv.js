/**
 * markdown-editor/table/clipboard-tsv.js
 * MdxTableTsv — TSV encode/decode + clipboard helpers for table selection
 */
(function () {
  'use strict';

  /** last internal paste buffer (when system clipboard unreadable) */
  var internalBuffer = null;

  function Schema() {
    return window.MdxSchema;
  }

  function plainOfCell(cell) {
    if (cell == null) return '';
    if (typeof cell === 'string') return cell;
    if (cell.covered) return '';
    if (cell.runs && cell.runs.length) {
      return cell.runs
        .map(function (r) {
          return r.text || '';
        })
        .join('');
    }
    return cell.text != null ? String(cell.text) : '';
  }

  function rowsOf(block) {
    if (!block) return [];
    if (block.cells && block.cells.length) {
      return block.cells.map(function (row) {
        return (row || []).map(plainOfCell);
      });
    }
    if (block.rows) {
      return block.rows.map(function (row) {
        return (row || []).map(function (c) {
          return c == null ? '' : String(c);
        });
      });
    }
    return [];
  }

  function escapeTsvCell(s) {
    s = s == null ? '' : String(s);
    // Normalize newlines inside cell for TSV safety
    s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, ' ');
    if (/[\t"]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /**
   * @param {object} block
   * @param {{ r0:number,c0:number,r1:number,c1:number }|null} [range]
   * @param {'blank'|'repeat'} [mode]  expand-blank for covered slots
   */
  function toTsv(block, range, mode) {
    mode = mode || 'blank';
    var grid = rowsOf(block);
    if (!grid.length) return '';
    var r0 = 0;
    var c0 = 0;
    var r1 = grid.length - 1;
    var c1 = (grid[0] && grid[0].length ? grid[0].length : 1) - 1;
    if (range) {
      r0 = Math.max(0, Math.min(range.r0, range.r1));
      c0 = Math.max(0, Math.min(range.c0, range.c1));
      r1 = Math.min(grid.length - 1, Math.max(range.r0, range.r1));
      c1 = Math.min((grid[0].length || 1) - 1, Math.max(range.c0, range.c1));
    }
    var lines = [];
    for (var r = r0; r <= r1; r++) {
      var cols = [];
      for (var c = c0; c <= c1; c++) {
        var text = '';
        if (block.cells && block.cells[r] && block.cells[r][c]) {
          var cell = block.cells[r][c];
          if (cell.covered) {
            if (mode === 'repeat' && cell.anchor) {
              var ar = cell.anchor.r;
              var ac = cell.anchor.c;
              text = plainOfCell(block.cells[ar] && block.cells[ar][ac]);
            } else {
              text = '';
            }
          } else {
            text = plainOfCell(cell);
          }
        } else {
          text = (grid[r] && grid[r][c]) || '';
        }
        cols.push(escapeTsvCell(text));
      }
      lines.push(cols.join('\t'));
    }
    return lines.join('\n');
  }

  function tableToTsv(block, mode) {
    return toTsv(block, null, mode);
  }

  /**
   * Parse TSV / simple CSV-ish paste into string[][]
   * Handles quoted fields with tabs.
   */
  function parseTsv(text) {
    if (text == null) return [];
    text = String(text).replace(/^\uFEFF/, '');
    if (!text) return [['']];
    // Normalize line ends; drop trailing empty line from Excel
    var raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (raw.endsWith('\n')) raw = raw.slice(0, -1);

    var rows = [];
    var i = 0;
    var len = raw.length;
    var row = [];
    var field = '';
    var inQuotes = false;

    while (i < len) {
      var ch = raw.charAt(i);
      if (inQuotes) {
        if (ch === '"') {
          if (raw.charAt(i + 1) === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i++;
          continue;
        }
        field += ch;
        i++;
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (ch === '\t') {
        row.push(field);
        field = '';
        i++;
        continue;
      }
      if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        i++;
        continue;
      }
      field += ch;
      i++;
    }
    row.push(field);
    rows.push(row);

    // If single cell with no tabs/newlines, still one row
    if (!rows.length) rows = [['']];
    return rows;
  }

  /**
   * Apply grid starting at (atR, atC); expand rows/cols as needed.
   * Mutates block via schema helpers when available.
   */
  function applyGrid(block, grid, atR, atC) {
    if (!block || !grid || !grid.length) return block;
    atR = atR | 0;
    atC = atC | 0;
    var S = Schema();
    if (S && S.ensureTableShape) S.ensureTableShape(block);

    var needRows = atR + grid.length;
    var needCols = atC;
    for (var g = 0; g < grid.length; g++) {
      needCols = Math.max(needCols, atC + (grid[g] ? grid[g].length : 0));
    }

    var curRows =
      (block.cells && block.cells.length) || (block.rows && block.rows.length) || 0;
    var curCols =
      (block.cells && block.cells[0] && block.cells[0].length) ||
      (block.rows && block.rows[0] && block.rows[0].length) ||
      0;

    while (curRows < needRows) {
      if (S && S.tableAddRow) S.tableAddRow(block);
      else {
        if (!block.rows) block.rows = [];
        var empty = [];
        for (var ec = 0; ec < Math.max(curCols, 1); ec++) empty.push('');
        block.rows.push(empty);
      }
      curRows++;
    }
    while (curCols < needCols) {
      if (S && S.tableAddCol) S.tableAddCol(block);
      else {
        (block.rows || []).forEach(function (row) {
          row.push('');
        });
      }
      curCols++;
      if (block.align) block.align.push('left');
    }

    if (S && S.ensureTableShape) S.ensureTableShape(block);

    for (var r = 0; r < grid.length; r++) {
      var line = grid[r] || [];
      for (var c = 0; c < line.length; c++) {
        var tr = atR + r;
        var tc = atC + c;
        var val = line[c] != null ? String(line[c]) : '';
        if (S && S.tableSetCell) {
          S.tableSetCell(block, tr, tc, val);
        } else {
          if (!block.rows) block.rows = [];
          if (!block.rows[tr]) block.rows[tr] = [];
          block.rows[tr][tc] = val;
          if (block.cells && block.cells[tr] && block.cells[tr][tc]) {
            block.cells[tr][tc].text = val;
          }
        }
      }
    }
    return block;
  }

  function applyTsv(block, tsv, atR, atC) {
    var grid = typeof tsv === 'string' ? parseTsv(tsv) : tsv;
    return applyGrid(block, grid, atR, atC);
  }

  function writeClipboard(text) {
    text = text == null ? '' : String(text);
    internalBuffer = { type: 'text', text: text };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        fallbackCopy(text);
      });
    }
    fallbackCopy(text);
    return Promise.resolve();
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) {
      /* ignore */
    }
  }

  function copyRange(block, range) {
    var tsv = toTsv(block, range, 'blank');
    internalBuffer = { type: 'mdx-table-tsv', text: tsv, range: range };
    return writeClipboard(tsv);
  }

  function copyTable(block) {
    var tsv = tableToTsv(block, 'blank');
    internalBuffer = { type: 'mdx-table-tsv', text: tsv };
    return writeClipboard(tsv);
  }

  function getInternalBuffer() {
    return internalBuffer;
  }

  /**
   * Prefer clipboard event data; else internal buffer.
   */
  function textFromPasteEvent(e) {
    if (e && e.clipboardData) {
      var t = e.clipboardData.getData('text/plain');
      if (t != null && t !== '') return t;
    }
    if (internalBuffer && internalBuffer.text) return internalBuffer.text;
    return '';
  }

  function looksLikeTsv(text) {
    if (!text) return false;
    return text.indexOf('\t') >= 0 || text.indexOf('\n') >= 0;
  }

  /**
   * Parse TSV → { rows, cells } or string[][] compatible with harness
   */
  function fromTsv(text) {
    var grid = parseTsv(text);
    var cells = grid.map(function (row, ri) {
      return (row || []).map(function (t) {
        return { text: t == null ? '' : String(t), header: ri === 0 };
      });
    });
    return {
      rows: grid,
      cells: cells,
    };
  }

  window.MdxTableTsv = {
    toTsv: toTsv,
    tableToTsv: tableToTsv,
    tableToTSV: tableToTsv,
    toTSV: tableToTsv,
    parseTsv: parseTsv,
    fromTsv: fromTsv,
    fromTSV: fromTsv,
    tableFromTSV: fromTsv,
    tableFromTsv: fromTsv,
    applyTsv: applyTsv,
    applyGrid: applyGrid,
    copyRange: copyRange,
    copyTable: copyTable,
    writeClipboard: writeClipboard,
    getInternalBuffer: getInternalBuffer,
    textFromPasteEvent: textFromPasteEvent,
    looksLikeTsv: looksLikeTsv,
  };
})();
