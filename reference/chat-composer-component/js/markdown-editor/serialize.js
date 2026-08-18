/**
 * markdown-editor/serialize.js — Block[] → Markdown
 */
(function () {
  'use strict';

  function indentSpaces(n) {
    var s = '';
    for (var i = 0; i < (n || 0); i++) s += '  ';
    return s;
  }

  function escapeTableCell(s) {
    return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  }

  /**
   * expand-blank：有 cells 时按逻辑网格展开；covered → ''；仅 anchor 保留 text。
   * 无 merge 字段时与 plain rows 一致。
   */
  function flattenTableRowsExpandBlank(b) {
    if (b && b.cells && b.cells.length) {
      var out = [];
      for (var r = 0; r < b.cells.length; r++) {
        var row = b.cells[r] || [];
        var line = [];
        for (var c = 0; c < row.length; c++) {
          var cell = row[c];
          if (!cell || cell.covered) {
            line.push('');
          } else {
            line.push(cell.text != null ? String(cell.text) : '');
          }
        }
        out.push(line);
      }
      return out;
    }
    var rows = b && b.rows;
    if ((!rows || !rows.length) && b && b.cells && window.MdxSchema && window.MdxSchema.cellsToRows) {
      rows = window.MdxSchema.cellsToRows(b.cells);
    }
    return rows;
  }

  function serializeBlock(b) {
    if (!b) return '';
    var type = b.type;
    var text = b.text != null ? String(b.text) : '';

    switch (type) {
      case 'heading': {
        var lv = Math.max(1, Math.min(6, b.level || 1));
        var hashes = '';
        for (var h = 0; h < lv; h++) hashes += '#';
        return hashes + ' ' + text.replace(/\n/g, ' ');
      }
      case 'bullet_item':
        return indentSpaces(b.indent) + '- ' + text;
      case 'ordered_item':
        return indentSpaces(b.indent) + '1. ' + text;
      case 'task_item':
        return indentSpaces(b.indent) + '- [' + (b.checked ? 'x' : ' ') + '] ' + text;
      case 'quote': {
        return text
          .split('\n')
          .map(function (l) {
            return '> ' + l;
          })
          .join('\n');
      }
      case 'code': {
        var lang = b.lang || '';
        return '```' + lang + '\n' + text.replace(/\n$/, '') + '\n```';
      }
      case 'mermaid': {
        // 与 fence ```mermaid 同形（prefer code+lang；type=mermaid 亦导出标准 fence）
        return '```mermaid\n' + text.replace(/\n$/, '') + '\n```';
      }
      case 'math': {
        var latex = text.replace(/^\n+/, '').replace(/\n+$/, '');
        return '$$\n' + latex + '\n$$';
      }
      case 'divider':
        return '---';
      case 'callout': {
        var kind = (b.callout || 'note').toUpperCase();
        var lines = text.split('\n');
        var title = lines[0] || '';
        var body = lines.slice(1);
        var out = ['> [!' + kind + ']' + (title ? ' ' + title : '')];
        body.forEach(function (l) {
          out.push('> ' + l);
        });
        if (body.length === 0 && !title) out.push('>');
        return out.join('\n');
      }
      case 'table': {
        /*
         * GFM flatten strategy (F-T-0017, pure-gfm default for this path):
         * GFM pipe tables have no rowspan/colspan. We use expand-blank:
         *   - anchor text stays in top-left slot only
         *   - covered slots export as empty cells
         * Re-import will NOT restore merge (honest). JSON Doc keeps merge lossless.
         * Other modes (expand-repeat / html-table / conex-fence) are host opts later.
         */
        var rows = flattenTableRowsExpandBlank(b);
        if (!rows || !rows.length) rows = [['']];
        var cols = rows[0].length || 1;
        var align = b.align || [];
        var head = rows[0]
          .map(function (c) {
            return escapeTableCell(c);
          })
          .join(' | ');
        var sepParts = [];
        for (var si = 0; si < cols; si++) {
          var a = align[si] || 'left';
          if (a === 'center') sepParts.push(':---:');
          else if (a === 'right') sepParts.push('---:');
          else sepParts.push('---');
        }
        var sep = sepParts.join(' | ');
        var linesT = ['| ' + head + ' |', '| ' + sep + ' |'];
        for (var r = 1; r < rows.length; r++) {
          var row = rows[r] || [];
          var cellTexts = [];
          for (var c = 0; c < cols; c++) cellTexts.push(escapeTableCell(row[c] || ''));
          linesT.push('| ' + cellTexts.join(' | ') + ' |');
        }
        return linesT.join('\n');
      }
      case 'file_chip': {
        var path = b.path || text;
        if (b.text && b.text !== path) return '[[file:' + path + '|' + b.text + ']]';
        return '[[file:' + path + ']]';
      }
      case 'image': {
        if (window.MdxBlocksImage && typeof window.MdxBlocksImage.toMd === 'function') {
          return window.MdxBlocksImage.toMd(b);
        }
        var alt = b.alt != null ? String(b.alt) : text;
        var src = b.src != null ? String(b.src) : '';
        var title = b.title || b.caption || '';
        if (title) return '![' + alt + '](' + src + ' "' + String(title).replace(/"/g, '\\"') + '")';
        return '![' + alt + '](' + src + ')';
      }
      case 'toc': {
        if (window.MdxBlocksToc && typeof window.MdxBlocksToc.toMd === 'function') {
          return window.MdxBlocksToc.toMd(b);
        }
        return '@[toc]';
      }
      case 'paragraph':
      default:
        return text;
    }
  }

  function serialize(docOrBlocks, opts) {
    opts = opts || {};
    var blocks = Array.isArray(docOrBlocks)
      ? docOrBlocks
      : (docOrBlocks && docOrBlocks.blocks) || [];
    var parts = [];
    for (var i = 0; i < blocks.length; i++) {
      var s = serializeBlock(blocks[i]);
      // skip trailing empty single paragraph at end if multiple blocks? keep for fidelity
      parts.push(s);
    }
    // join with blank line between block types that need it
    var out = [];
    for (var j = 0; j < parts.length; j++) {
      out.push(parts[j]);
      if (j < parts.length - 1) {
        var cur = blocks[j];
        var next = blocks[j + 1];
        var tightList =
          cur &&
          next &&
          /_item$/.test(cur.type) &&
          /_item$/.test(next.type);
        if (tightList) {
          out.push('\n');
        } else {
          out.push('\n\n');
        }
      }
    }
    var md = out.join('').replace(/\n{3,}/g, '\n\n');
    if (opts.trim !== false) md = md.replace(/^\n+/, '').replace(/\n+$/, '') + (md ? '\n' : '');
    return md;
  }

  window.MdxSerialize = {
    serialize: serialize,
    serializeBlock: serializeBlock,
  };
})();
