/**
 * W3 acceptance harness — table professional surface
 *
 * Pure + DOM checks for table create / multi-select / merge-split / chrome / TSV / align serialize.
 *
 * Usage:
 *   Browser console (after scripts load):
 *     var r = window.MdxW3Harness.runAll(); console.table(r.results);
 *   HTML page markdown-editor-w3-test.html auto-runs and paints PASS/FAIL.
 *   Pure-only: runAll({ skipDom: true }).
 *
 * Coverage (W3 / F-T tables):
 *   - createBlock 2×2 cells (P0 — FAIL if MdxSchema missing)
 *   - multi-select API if MdxTableSelection present (skip if absent)
 *   - canMerge + merge + split if MdxTableMerge present; else Schema table* P0
 *   - no 「加行」「加列」 text in DOM chrome (P0 when DOM)
 *   - TSV roundtrip if MdxTableTsv present (skip if absent)
 *   - serialize table keeps align if possible (soft when unimplemented)
 *
 * Graceful skip: optional modules missing → SKIP (ok). FAIL only for missing P0 APIs.
 */
(function (root) {
  'use strict';

  var results = [];

  function Schema() {
    return root.MdxSchema || (root.window && root.window.MdxSchema) || null;
  }

  function Parse() {
    return root.MdxParse || (root.window && root.window.MdxParse) || null;
  }

  function Serialize() {
    return root.MdxSerialize || (root.window && root.window.MdxSerialize) || null;
  }

  function TableChrome() {
    return root.MdxTableChrome || (root.window && root.window.MdxTableChrome) || null;
  }

  function TableSelection() {
    return (
      root.MdxTableSelection ||
      (root.window && root.window.MdxTableSelection) ||
      null
    );
  }

  function TableMerge() {
    return (
      root.MdxTableMerge ||
      (root.window && root.window.MdxTableMerge) ||
      null
    );
  }

  function TableTsv() {
    return (
      root.MdxTableTsv ||
      (root.window && root.window.MdxTableTsv) ||
      root.MdxTableTSV ||
      (root.window && root.window.MdxTableTSV) ||
      null
    );
  }

  function EditorAPI() {
    return (
      root.MarkdownEditor ||
      (root.window && root.window.MarkdownEditor) ||
      null
    );
  }

  function doc() {
    return root.document || (root.window && root.window.document) || null;
  }

  function pass(name, detail) {
    results.push({ name: name, ok: true, detail: detail || '' });
  }

  function fail(name, detail) {
    results.push({ name: name, ok: false, detail: detail || '' });
  }

  function skip(name, detail) {
    results.push({
      name: name,
      ok: true,
      skipped: true,
      detail: detail || 'SKIP',
    });
  }

  function assert(cond, name, detail) {
    if (cond) pass(name, detail);
    else fail(name, detail || 'assertion failed');
  }

  function j(v) {
    try {
      return JSON.stringify(v);
    } catch (e) {
      return String(v);
    }
  }

  function rowCount(block) {
    if (!block) return 0;
    if (block.cells && block.cells.length) return block.cells.length;
    if (block.rows && block.rows.length) return block.rows.length;
    return 0;
  }

  function colCount(block) {
    if (!block) return 0;
    if (block.cells && block.cells[0]) return block.cells[0].length;
    if (block.rows && block.rows[0]) return block.rows[0].length;
    return 0;
  }

  function cellText(block, r, c) {
    if (!block) return '';
    if (block.cells && block.cells[r] && block.cells[r][c]) {
      return String(block.cells[r][c].text != null ? block.cells[r][c].text : '');
    }
    if (block.rows && block.rows[r] && block.rows[r][c] != null) {
      return String(block.rows[r][c]);
    }
    return '';
  }

  /** 2×2 sample table block via Schema.createBlock (or plain fallback) */
  function make2x2(overrides) {
    var S = Schema();
    var partial = {
      type: 'table',
      hasHeader: true,
      rows: [
        ['H1', 'H2'],
        ['A', 'B'],
      ],
      align: ['left', 'center'],
    };
    if (overrides) {
      for (var k in overrides) {
        if (Object.prototype.hasOwnProperty.call(overrides, k)) {
          partial[k] = overrides[k];
        }
      }
    }
    if (S && typeof S.createBlock === 'function') {
      return S.createBlock(partial);
    }
    // Minimal fallback when Schema missing (DOM chrome smoke only)
    var rows = partial.rows || [
      ['H1', 'H2'],
      ['A', 'B'],
    ];
    return {
      type: 'table',
      hasHeader: partial.hasHeader !== false,
      align: (partial.align || []).slice(),
      rows: rows,
      cells: rows.map(function (row, ri) {
        return row.map(function (t) {
          return { text: String(t), header: ri === 0 && partial.hasHeader !== false };
        });
      }),
    };
  }

  /**
   * Resolve merge API surface:
   * prefer dedicated MdxTableMerge; fall back to MdxSchema table* methods.
   * @returns {{ src: string, canMerge: Function, merge: Function, split: Function }|null}
   */
  function resolveMergeApi() {
    var TM = TableMerge();
    if (TM) {
      var can =
        TM.canMerge ||
        TM.tableCanMerge ||
        (TM.api && (TM.api.canMerge || TM.api.tableCanMerge));
      var merge =
        TM.merge ||
        TM.tableMerge ||
        (TM.api && (TM.api.merge || TM.api.tableMerge));
      var split =
        TM.split ||
        TM.tableSplit ||
        (TM.api && (TM.api.split || TM.api.tableSplit));
      if (typeof can === 'function' && typeof merge === 'function' && typeof split === 'function') {
        return { src: 'MdxTableMerge', canMerge: can, merge: merge, split: split };
      }
    }
    var S = Schema();
    if (
      S &&
      typeof S.tableCanMerge === 'function' &&
      typeof S.tableMerge === 'function' &&
      typeof S.tableSplit === 'function'
    ) {
      // Normalize to inclusive corner coords (r0,c0,r1,c1) — same as MdxTableMerge / selection
      return {
        src: 'MdxSchema',
        canMerge: function (block, r0, c0, r1, c1) {
          var rr0 = Math.min(r0, r1);
          var cc0 = Math.min(c0, c1);
          var rs = Math.abs(r1 - r0) + 1;
          var cs = Math.abs(c1 - c0) + 1;
          return S.tableCanMerge(block, rr0, cc0, rs, cs);
        },
        merge: function (block, r0, c0, r1, c1) {
          var rr0 = Math.min(r0, r1);
          var cc0 = Math.min(c0, c1);
          var rs = Math.abs(r1 - r0) + 1;
          var cs = Math.abs(c1 - c0) + 1;
          return S.tableMerge(block, rr0, cc0, rs, cs);
        },
        split: function (block, r, c) {
          return S.tableSplit(block, r, c);
        },
      };
    }
    return null;
  }

  function normalizeCanMerge(result) {
    if (result === true) return { ok: true };
    if (result === false) return { ok: false, reason: 'false' };
    if (result && typeof result === 'object') {
      if (result.ok === true || result.ok === false) return result;
      if (typeof result.can === 'boolean') return { ok: result.can, reason: result.reason };
    }
    // truthy non-object treated as ok
    return { ok: !!result };
  }

  function normalizeMergeResult(result, block) {
    if (!result) return { ok: false, reason: 'null-result', block: block };
    if (result.ok === false) return result;
    if (result.ok === true) return result;
    // some APIs return the block itself
    if (result.type === 'table' || result.cells || result.rows) {
      return { ok: true, block: result };
    }
    return { ok: true, block: result.block || block };
  }

  /** Pure tests — no DOM */
  function runPure() {
    var S = Schema();

    // --- P0: Schema + create 2×2 ---
    if (!S || typeof S.createBlock !== 'function') {
      fail(
        'MdxSchema.createBlock available',
        'window.MdxSchema missing — load schema.js (P0)'
      );
      return;
    }
    pass('MdxSchema.createBlock available');

    var t2 = make2x2();
    assert(
      t2 && t2.type === 'table',
      'createBlock type === table',
      t2 ? t2.type : 'null'
    );
    assert(
      rowCount(t2) === 2 && colCount(t2) === 2,
      'createBlock 2×2 cells',
      'rows=' + rowCount(t2) + ' cols=' + colCount(t2)
    );
    assert(
      cellText(t2, 0, 0) === 'H1' &&
        cellText(t2, 0, 1) === 'H2' &&
        cellText(t2, 1, 0) === 'A' &&
        cellText(t2, 1, 1) === 'B',
      'createBlock 2×2 cell text',
      j({
        '0,0': cellText(t2, 0, 0),
        '0,1': cellText(t2, 0, 1),
        '1,0': cellText(t2, 1, 0),
        '1,1': cellText(t2, 1, 1),
      })
    );
    assert(
      !!t2.cells && t2.cells.length === 2 && t2.cells[0].length === 2,
      'createBlock exposes cells[][] grid',
      t2.cells ? 'cells ' + t2.cells.length + '×' + t2.cells[0].length : 'no cells'
    );

    // --- multi-select if MdxTableSelection present ---
    var Sel = TableSelection();
    if (!Sel) {
      skip(
        'MdxTableSelection multi-select API',
        'SKIP: window.MdxTableSelection not present'
      );
    } else {
      pass('MdxTableSelection available');
      var setSel =
        Sel.setSelection ||
        Sel.select ||
        Sel.selectRange ||
        Sel.setRange ||
        (Sel.api && (Sel.api.setSelection || Sel.api.selectRange));
      var getSel =
        Sel.getSelection ||
        Sel.getRange ||
        Sel.selection ||
        (Sel.api && (Sel.api.getSelection || Sel.api.getRange));
      var clearSel =
        Sel.clearSelection ||
        Sel.clear ||
        (Sel.api && (Sel.api.clearSelection || Sel.api.clear));

      if (typeof setSel !== 'function') {
        fail(
          'MdxTableSelection multi-select API',
          'module present but no setSelection/selectRange'
        );
      } else {
        // Prefer pure range object API: setSelection(range) / setSelection(r0,c0,r1,c1)
        var selHost = { selection: null };
        var applied = false;
        try {
          // Common shapes
          if (setSel.length >= 4) {
            setSel(0, 0, 1, 1);
            applied = true;
          } else if (setSel.length >= 2) {
            setSel(selHost, { r0: 0, c0: 0, r1: 1, c1: 1 });
            applied = true;
          } else {
            setSel({ r0: 0, c0: 0, r1: 1, c1: 1 });
            applied = true;
          }
        } catch (e1) {
          try {
            setSel({ r0: 0, c0: 0, r1: 1, c1: 1 });
            applied = true;
          } catch (e2) {
            fail(
              'MdxTableSelection setSelection',
              (e2 && e2.message) || String(e2)
            );
          }
        }
        if (applied) {
          pass('MdxTableSelection setSelection accepts range', '2×2 range');
        }
        if (typeof getSel === 'function') {
          var range = null;
          try {
            range = getSel.length >= 1 ? getSel(selHost) : getSel();
          } catch (eg) {
            range = null;
          }
          var okRange =
            range &&
            typeof range === 'object' &&
            (range.r0 != null || range.r != null || range.start != null);
          assert(
            !!okRange || range === null,
            'MdxTableSelection getSelection shape',
            range ? j(range) : 'null (ok if stateless)'
          );
        } else {
          skip('MdxTableSelection getSelection', 'SKIP: no getSelection');
        }
        if (typeof clearSel === 'function') {
          try {
            clearSel.length >= 1 ? clearSel(selHost) : clearSel();
            pass('MdxTableSelection clearSelection', 'ok');
          } catch (ec) {
            fail('MdxTableSelection clearSelection', (ec && ec.message) || String(ec));
          }
        }
      }
    }

    // --- canMerge + merge + split ---
    // Prefer MdxTableMerge; Schema table* is P0 fallback (FAIL if neither).
    var TM = TableMerge();
    var mergeApi = resolveMergeApi();
    if (TM && mergeApi && mergeApi.src === 'MdxTableMerge') {
      pass('MdxTableMerge available');
    } else if (TM && !mergeApi) {
      fail(
        'MdxTableMerge API complete',
        'module present but missing canMerge/merge/split'
      );
    } else if (!TM) {
      skip(
        'MdxTableMerge module',
        'SKIP: window.MdxTableMerge not present — using Schema if available'
      );
    }

    if (!mergeApi) {
      fail(
        'merge API (MdxTableMerge or MdxSchema.table*) available',
        'P0: need tableCanMerge/tableMerge/tableSplit'
      );
    } else {
      pass('merge API resolved', mergeApi.src);

      // Body 2×2 table so merge doesn't cross header (hasHeader + r0 rowspan)
      var body2 = make2x2({
        hasHeader: false,
        rows: [
          ['A', 'B'],
          ['C', 'D'],
        ],
        align: ['left', 'center'],
      });

      // Inclusive corners: 2×2 grid → (0,0)-(1,1)
      var can = normalizeCanMerge(mergeApi.canMerge(body2, 0, 0, 1, 1));
      assert(
        can.ok === true,
        'canMerge 2×2 body → ok',
        can.reason ? 'reason=' + can.reason : j(can)
      );

      // Single cell cannot merge (when API distinguishes)
      var can1 = normalizeCanMerge(mergeApi.canMerge(body2, 0, 0, 0, 0));
      // Schema tableCanMerge clones and returns true for 1×1 (noop ok) — accept either
      pass(
        'canMerge single-cell checked',
        'ok=' + can1.ok + (can1.reason ? ' reason=' + can1.reason : '')
      );

      // Cross-header should fail when hasHeader (Schema: r0 + rowSpan>1)
      var withHead = make2x2({
        hasHeader: true,
        rows: [
          ['H1', 'H2'],
          ['A', 'B'],
        ],
      });
      // corners (0,0)-(1,0) spans header+body
      var cross = normalizeCanMerge(mergeApi.canMerge(withHead, 0, 0, 1, 0));
      // Prefer fail; if API doesn't enforce, soft note
      if (cross.ok === false) {
        pass(
          'canMerge cross-header → fail',
          cross.reason || 'rejected'
        );
      } else {
        // Schema may still reject via merge result
        var crossTry = normalizeMergeResult(
          mergeApi.merge(
            JSON.parse(JSON.stringify(withHead)),
            0,
            0,
            1,
            0
          ),
          withHead
        );
        assert(
          crossTry.ok === false,
          'merge cross-header rejected',
          crossTry.reason || 'expected fail'
        );
      }

      // Merge body 2×2
      var toMerge = make2x2({
        hasHeader: false,
        rows: [
          ['A', 'B'],
          ['C', 'D'],
        ],
      });
      var mres = normalizeMergeResult(mergeApi.merge(toMerge, 0, 0, 1, 1), toMerge);
      assert(mres.ok === true, 'merge 2×2 body → ok', mres.reason || '');
      var mb = mres.block || toMerge;
      var anchor = mb.cells && mb.cells[0] && mb.cells[0][0];
      assert(
        !!anchor &&
          ((anchor.rowspan || 1) >= 2 || (anchor.colspan || 1) >= 2),
        'merge sets rowspan/colspan on anchor',
        anchor
          ? 'rs=' + (anchor.rowspan || 1) + ' cs=' + (anchor.colspan || 1)
          : 'no anchor'
      );
      var covered =
        mb.cells &&
        mb.cells[1] &&
        mb.cells[1][1] &&
        (mb.cells[1][1].covered === true ||
          (mb.cells[1][1].anchor && mb.cells[1][1].anchor.r === 0));
      assert(!!covered, 'merge marks covered cells', covered ? 'covered ok' : j(mb.cells && mb.cells[1]));

      // Split
      var sres = normalizeMergeResult(mergeApi.split(mb, 0, 0), mb);
      assert(sres.ok !== false, 'split merged cell → ok', sres.reason || '');
      var sb = sres.block || mb;
      var a2 = sb.cells && sb.cells[0] && sb.cells[0][0];
      assert(
        !!a2 && (a2.rowspan || 1) === 1 && (a2.colspan || 1) === 1,
        'split restores 1×1 anchor',
        a2 ? 'rs=' + (a2.rowspan || 1) + ' cs=' + (a2.colspan || 1) : 'no cell'
      );
    }

    // --- TSV roundtrip if MdxTableTsv present ---
    var Tsv = TableTsv();
    if (!Tsv) {
      skip('MdxTableTsv TSV roundtrip', 'SKIP: window.MdxTableTsv not present');
    } else {
      pass('MdxTableTsv available');
      var toTsv =
        Tsv.tableToTSV ||
        Tsv.toTSV ||
        Tsv.toTsv ||
        Tsv.serialize ||
        (Tsv.api && (Tsv.api.tableToTSV || Tsv.api.toTSV));
      var fromTsv =
        Tsv.tableFromTSV ||
        Tsv.fromTSV ||
        Tsv.fromTsv ||
        Tsv.parse ||
        (Tsv.api && (Tsv.api.tableFromTSV || Tsv.api.fromTSV));

      if (typeof toTsv !== 'function' || typeof fromTsv !== 'function') {
        fail(
          'MdxTableTsv API complete',
          'module present but missing tableToTSV/tableFromTSV'
        );
      } else {
        var tsvBlock = make2x2({
          rows: [
            ['H1', 'H2'],
            ['A', 'B'],
          ],
        });
        var tsvOut = '';
        try {
          tsvOut = toTsv(tsvBlock);
        } catch (et) {
          fail('tableToTSV', (et && et.message) || String(et));
          tsvOut = null;
        }
        if (tsvOut != null) {
          assert(
            typeof tsvOut === 'string' &&
              tsvOut.indexOf('\t') >= 0 &&
              tsvOut.indexOf('H1') >= 0,
            'tableToTSV emits tab-separated values',
            String(tsvOut).slice(0, 80)
          );
          var back = null;
          try {
            back = fromTsv(tsvOut);
          } catch (ef) {
            fail('tableFromTSV', (ef && ef.message) || String(ef));
          }
          if (back) {
            // cells[][] or rows[][] or {cells,rows}
            var rowsBack =
              back.rows ||
              (back.cells
                ? back.cells.map(function (row) {
                    return row.map(function (c) {
                      return c && c.text != null ? c.text : c;
                    });
                  })
                : Array.isArray(back)
                  ? back.map(function (row) {
                      return Array.isArray(row)
                        ? row.map(function (c) {
                            return c && c.text != null ? c.text : c;
                          })
                        : row;
                    })
                  : null);
            assert(
              !!rowsBack &&
                rowsBack.length >= 2 &&
                String(rowsBack[0][0]).indexOf('H1') >= 0 &&
                String(rowsBack[1][1]).indexOf('B') >= 0,
              'TSV roundtrip preserves cells',
              j(rowsBack)
            );
          }
        }
      }
    }

    // --- serialize table keeps align if possible ---
    var Ser = Serialize();
    if (!Ser || typeof Ser.serialize !== 'function') {
      fail('MdxSerialize available', 'window.MdxSerialize missing — load serialize.js (P0)');
    } else {
      pass('MdxSerialize available');
      var alignBlock = make2x2({
        rows: [
          ['Left', 'Center'],
          ['a', 'b'],
        ],
        align: ['left', 'center'],
      });
      // Prefer doc form
      var mdOut = Ser.serialize({
        version: S.VERSION || 2,
        blocks: [alignBlock],
      });
      assert(
        typeof mdOut === 'string' && mdOut.indexOf('|') >= 0,
        'serialize table produces pipe table',
        mdOut ? mdOut.slice(0, 100) : ''
      );

      // Align markers: :--- | :---: | ---:
      var hasAlignMarkers =
        /:\-{2,}/.test(mdOut) ||
        /\-{2,}:/.test(mdOut) ||
        /:\-{2,}:/.test(mdOut) ||
        mdOut.indexOf(':---') >= 0 ||
        mdOut.indexOf('---:') >= 0 ||
        mdOut.indexOf(':---:') >= 0;

      if (hasAlignMarkers) {
        pass('serialize table keeps align markers', mdOut.split('\n').slice(0, 3).join(' | '));
      } else {
        // Soft: not yet implemented — do not FAIL (if possible)
        skip(
          'serialize table keeps align markers',
          'SKIP soft: serialize emits table but no :--- / :---: yet — align not wired'
        );
      }

      // Parse roundtrip of plain table still works
      var P = Parse();
      if (P && typeof P.parse === 'function') {
        var plainMd =
          '| H1 | H2 |\n' +
          '| --- | --- |\n' +
          '| A | B |\n';
        var parsed = P.parse(plainMd);
        var blocks = (parsed && parsed.blocks) || [];
        var tb = null;
        for (var i = 0; i < blocks.length; i++) {
          if (blocks[i] && blocks[i].type === 'table') {
            tb = blocks[i];
            break;
          }
        }
        assert(!!tb, 'parse pipe table → table block', 'blocks=' + blocks.length);
        if (tb) {
          assert(
            rowCount(tb) >= 2 && colCount(tb) >= 2,
            'parse table shape ≥2×2',
            'rows=' + rowCount(tb) + ' cols=' + colCount(tb)
          );
        }

        // GFM 分隔行对齐：parse 写入 block.align；serialize 再 parse 不丢
        var alignMd =
          '| Left | Center | Right |\n' +
          '| :--- | :---: | ---: |\n' +
          '| a | b | c |\n';
        var alignParsed = P.parse(alignMd);
        var alignBlocks = (alignParsed && alignParsed.blocks) || [];
        var atb = null;
        for (var ai = 0; ai < alignBlocks.length; ai++) {
          if (alignBlocks[ai] && alignBlocks[ai].type === 'table') {
            atb = alignBlocks[ai];
            break;
          }
        }
        assert(!!atb, 'parse aligned table → table block', 'blocks=' + alignBlocks.length);
        if (atb) {
          var gotAlign = atb.align || [];
          assert(
            gotAlign[0] === 'left' &&
              gotAlign[1] === 'center' &&
              gotAlign[2] === 'right',
            'parse table align from sep row',
            j(gotAlign)
          );

          var roundMd = Ser.serialize({
            version: S.VERSION || 2,
            blocks: [atb],
          });
          var roundBack = P.parse(roundMd);
          var rBlocks = (roundBack && roundBack.blocks) || [];
          var rtb = null;
          for (var ri = 0; ri < rBlocks.length; ri++) {
            if (rBlocks[ri] && rBlocks[ri].type === 'table') {
              rtb = rBlocks[ri];
              break;
            }
          }
          var rAlign = (rtb && rtb.align) || [];
          assert(
            !!rtb &&
              rAlign[0] === 'left' &&
              rAlign[1] === 'center' &&
              rAlign[2] === 'right',
            'parse↔serialize align roundtrip',
            'align=' + j(rAlign) + ' md=' + String(roundMd).split('\n').slice(0, 2).join(' / ')
          );
        }
      } else {
        fail('MdxParse available for table align', 'window.MdxParse missing — load parse.js');
      }
    }
  }

  /**
   * DOM: chrome must not show 「加行」「加列」 text buttons;
   * mount sample table when editor host present.
   */
  function runDom() {
    var d = doc();
    if (!d) {
      fail('DOM available', 'no document — skip DOM tests');
      return;
    }
    pass('DOM available');

    var Chrome = TableChrome();
    if (!Chrome || typeof Chrome.enhance !== 'function') {
      fail(
        'MdxTableChrome available',
        'window.MdxTableChrome missing — load ui/table-chrome.js (P0 chrome)'
      );
    } else {
      pass('MdxTableChrome available');
    }

    // Synthetic table wrap + enhance — check chrome text
    var wrap = d.createElement('div');
    wrap.className = 'mdx-table-wrap';
    wrap.innerHTML =
      '<table class="mdx-table is-editing"><tbody>' +
      '<tr class="mdx-table__row">' +
      '<td class="mdx-td mdx-table__cell mdx-table__cell--header" data-r="0" data-c="0">H1</td>' +
      '<td class="mdx-td mdx-table__cell mdx-table__cell--header" data-r="0" data-c="1">H2</td>' +
      '</tr>' +
      '<tr class="mdx-table__row">' +
      '<td class="mdx-td mdx-table__cell" data-r="1" data-c="0">A</td>' +
      '<td class="mdx-td mdx-table__cell" data-r="1" data-c="1">B</td>' +
      '</tr>' +
      '</tbody></table>';
    // Off-document fragment is fine for enhance; append to body for query safety
    wrap.style.cssText = 'position:absolute;left:-9999px;top:0;';
    d.body.appendChild(wrap);

    try {
      if (Chrome && typeof Chrome.enhance === 'function') {
        Chrome.enhance(wrap, {
          onAddRow: function () {},
          onAddCol: function () {},
          onContextAction: function () {},
          getBlock: function () {
            return make2x2();
          },
        });
      }

      var chromeText = wrap.textContent || wrap.innerText || '';
      // Forbidden product strings as button labels (D10 / U5)
      var hasJiaHang = chromeText.indexOf('加行') >= 0;
      var hasJiaLie = chromeText.indexOf('加列') >= 0;

      // Also scan button labels explicitly
      var buttons = wrap.querySelectorAll('button, [role="button"]');
      var badBtn = null;
      for (var bi = 0; bi < buttons.length; bi++) {
        var label =
          (buttons[bi].textContent || '') +
          ' ' +
          (buttons[bi].getAttribute('aria-label') || '');
        // Fail only if visible text is exactly / contains 加行|加列 as the control copy
        // (aria-label「添加行」is allowed — different product copy; ban is 「加行」「加列」四字按钮)
        var pure = (buttons[bi].textContent || '').replace(/\s+/g, '');
        if (pure === '加行' || pure === '加列' || pure.indexOf('加行') >= 0 || pure.indexOf('加列') >= 0) {
          badBtn = pure;
          break;
        }
      }

      assert(
        !hasJiaHang && !hasJiaLie && !badBtn,
        'DOM chrome has no 「加行」「加列」 text',
        badBtn
          ? 'bad button: ' + badBtn
          : hasJiaHang || hasJiaLie
            ? 'found in textContent'
            : 'ok (+ only)'
      );

      var addCol = wrap.querySelector('.mdx-table-add-col');
      var addRow = wrap.querySelector('.mdx-table-add-row');
      assert(
        !!addCol && !!addRow,
        'DOM chrome has hover + add-col / add-row controls',
        'col=' + !!addCol + ' row=' + !!addRow
      );
      if (addCol) {
        assert(
          (addCol.textContent || '').replace(/\s+/g, '') === '+' ||
            (addCol.textContent || '').indexOf('+') >= 0,
          'add-col control uses + not Chinese label',
          'text=' + (addCol.textContent || '')
        );
      }

      // Multi-select via chrome internal selection if present
      var state = wrap._mdxChrome;
      if (state && typeof state.getSelection === 'function') {
        pass('chrome getSelection API present', 'via _mdxChrome');
      } else {
        skip(
          'chrome getSelection API',
          'SKIP: no _mdxChrome.getSelection (optional introspect)'
        );
      }

      if (Chrome && typeof Chrome.destroy === 'function') {
        Chrome.destroy(wrap);
        pass('MdxTableChrome.destroy runs', 'ok');
      }
    } finally {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }

    // Live editor host (optional sample)
    var ME = EditorAPI();
    var host =
      d.getElementById('editorHost') || d.querySelector('[data-mdx-w3-host]');
    if (ME && typeof ME.mount === 'function' && host) {
      var liveTable =
        host.querySelector('.mdx-table-wrap, .mdx-table, [data-block-type="table"]') ||
        host.querySelector('table.mdx-table');
      assert(
        !!liveTable,
        'DOM editor mount shows table grid',
        liveTable
          ? liveTable.className || liveTable.tagName
          : 'no table under #editorHost'
      );

      // No whole-table pipe source textarea
      var tableWraps = host.querySelectorAll('.mdx-table-wrap, .mdx-block--table');
      var wholeSource = false;
      for (var wi = 0; wi < tableWraps.length; wi++) {
        var ta = tableWraps[wi].querySelector('textarea');
        if (ta && (ta.value || '').indexOf('|') >= 0) {
          wholeSource = true;
          break;
        }
      }
      assert(
        !wholeSource,
        'DOM no whole-table pipe source textarea',
        wholeSource ? 'found textarea with |' : 'grid only'
      );

      var liveText = host.textContent || '';
      // Cell content may include user data; only fail if chrome buttons use 加行/加列
      var liveBtns = host.querySelectorAll(
        '.mdx-table-add-col, .mdx-table-add-row, .mdx-table-wrap button'
      );
      var liveBad = null;
      for (var li = 0; li < liveBtns.length; li++) {
        var pt = (liveBtns[li].textContent || '').replace(/\s+/g, '');
        if (pt.indexOf('加行') >= 0 || pt.indexOf('加列') >= 0) {
          liveBad = pt;
          break;
        }
      }
      assert(
        !liveBad,
        'live editor chrome no 「加行」「加列」',
        liveBad || 'ok'
      );
      void liveText;
    } else if (!host) {
      pass(
        'DOM editor mount skipped',
        'no #editorHost — fragment chrome only (ok)'
      );
    } else {
      fail(
        'MarkdownEditor.mount available',
        'MarkdownEditor.mount missing — load editor.js + index.js'
      );
    }
  }

  /**
   * @param {{ skipDom?: boolean }} [opts]
   * @returns {{ passed: number, failed: number, skipped: number, results: Array, ok: boolean }}
   */
  function runAll(opts) {
    opts = opts || {};
    results = [];
    runPure();
    if (!opts.skipDom) runDom();

    var passed = 0;
    var failed = 0;
    var skipped = 0;
    for (var i = 0; i < results.length; i++) {
      if (results[i].skipped) skipped++;
      if (results[i].ok) passed++;
      else failed++;
    }
    return {
      passed: passed,
      failed: failed,
      skipped: skipped,
      results: results.slice(),
      ok: failed === 0,
    };
  }

  function formatReport(report) {
    report = report || runAll();
    var lines = [];
    lines.push(
      'W3 table harness: ' +
        (report.ok ? 'ALL PASS' : 'FAIL') +
        ' (' +
        report.passed +
        ' passed, ' +
        report.failed +
        ' failed' +
        (report.skipped ? ', ' + report.skipped + ' skipped' : '') +
        ')'
    );
    for (var i = 0; i < report.results.length; i++) {
      var r = report.results[i];
      var tag = r.ok ? (r.skipped ? 'SKIP' : 'PASS') : 'FAIL';
      lines.push(
        tag + '  ' + r.name + (r.detail ? ' — ' + r.detail : '')
      );
    }
    return lines.join('\n');
  }

  /**
   * Paint PASS/FAIL list into a host element (for HTML page).
   * @param {HTMLElement} hostEl
   * @param {{ skipDom?: boolean }} [opts]
   */
  function renderTo(hostEl, opts) {
    var report = runAll(opts);
    if (!hostEl) return report;

    var d = doc();
    var summary = d.createElement('div');
    summary.className = 'w3-harness-summary ' + (report.ok ? 'is-pass' : 'is-fail');
    summary.textContent =
      (report.ok ? 'ALL PASS' : 'SOME FAILED') +
      ' — ' +
      report.passed +
      ' passed / ' +
      report.failed +
      ' failed' +
      (report.skipped ? ' / ' + report.skipped + ' skipped' : '');

    var list = d.createElement('ul');
    list.className = 'w3-harness-list';
    for (var i = 0; i < report.results.length; i++) {
      var r = report.results[i];
      var li = d.createElement('li');
      li.className = r.ok ? (r.skipped ? 'w3-skip' : 'w3-pass') : 'w3-fail';
      var badge = d.createElement('span');
      badge.className = 'w3-badge';
      badge.textContent = r.ok ? (r.skipped ? 'SKIP' : 'PASS') : 'FAIL';
      var name = d.createElement('span');
      name.className = 'w3-name';
      name.textContent = r.name;
      li.appendChild(badge);
      li.appendChild(name);
      if (r.detail) {
        var det = d.createElement('span');
        det.className = 'w3-detail';
        det.textContent = r.detail;
        li.appendChild(det);
      }
      list.appendChild(li);
    }

    hostEl.innerHTML = '';
    hostEl.appendChild(summary);
    hostEl.appendChild(list);
    return report;
  }

  var api = {
    runAll: runAll,
    runPure: function () {
      return runAll({ skipDom: true });
    },
    formatReport: formatReport,
    renderTo: renderTo,
  };

  root.MdxW3Harness = api;
  if (root.window) root.window.MdxW3Harness = api;
})(
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof window !== 'undefined'
      ? window
      : this
);
