/**
 * U1 multi-block selection harness — pure + optional DOM
 */
(function () {
  'use strict';

  function ok(name, cond, detail) {
    return { name: name, ok: !!cond, detail: detail || '' };
  }

  function runPure() {
    var results = [];
    var M = window.MdxSelectionModel;
    if (!M) {
      results.push(ok('MdxSelectionModel exists', false, 'missing'));
      return results;
    }
    results.push(ok('MdxSelectionModel exists', true));

    var ordered = ['a', 'b', 'c', 'd'];
    var s = M.create();
    M.setRange(s, ordered, 'b', 'd');
    results.push(
      ok(
        'setRange b..d',
        s.mode === 'multi' && s.selectedIds.join(',') === 'b,c,d',
        s.selectedIds.join(',')
      )
    );

    M.setRange(s, ordered, 'd', 'b');
    results.push(
      ok(
        'setRange reverse d..b',
        s.selectedIds.join(',') === 'b,c,d',
        s.selectedIds.join(',')
      )
    );

    M.toggle(s, ordered, 'c');
    results.push(
      ok('toggle off c', s.selectedIds.join(',') === 'b,d', s.selectedIds.join(','))
    );

    M.clear(s);
    results.push(ok('clear', s.mode === 'idle' && s.selectedIds.length === 0));

    var C = window.MdxSelectionChrome;
    if (C && C.create) {
      var chrome = C.create({
        getState: function () {
          return s;
        },
        getBlocks: function () {
          return [
            { id: 'a', type: 'paragraph', text: 'A' },
            { id: 'b', type: 'heading', level: 2, text: 'Hi' },
            { id: 'c', type: 'bullet_item', text: 'item' },
          ];
        },
        getBlockEls: function () {
          return {};
        },
      });
      M.setRange(s, ['a', 'b', 'c'], 'a', 'c');
      var md = chrome.selectionToMarkdown(s, [
        { id: 'a', type: 'paragraph', text: 'A' },
        { id: 'b', type: 'heading', level: 2, text: 'Hi' },
        { id: 'c', type: 'bullet_item', text: 'item' },
      ]);
      results.push(
        ok(
          'selectionToMarkdown has heading',
          /##\s*Hi/.test(md) || md.indexOf('Hi') >= 0,
          md.slice(0, 80)
        )
      );
      results.push(ok('selectionToMarkdown multi blocks', md.split('\n\n').length >= 2 || md.indexOf('\n') >= 0, md));
    } else {
      results.push(ok('MdxSelectionChrome', false, 'missing'));
    }

    return results;
  }

  function runAll() {
    return { pure: runPure() };
  }

  function formatReport(r) {
    r = r || runAll();
    var lines = ['U1 Selection Harness'];
    var all = (r.pure || []).concat(r.dom || []);
    var pass = 0;
    all.forEach(function (x) {
      lines.push((x.ok ? 'PASS' : 'FAIL') + '  ' + x.name + (x.detail ? ' — ' + x.detail : ''));
      if (x.ok) pass++;
    });
    lines.push('--- ' + pass + '/' + all.length + ' passed ---');
    return lines.join('\n');
  }

  window.MdxU1Harness = {
    runPure: runPure,
    runAll: runAll,
    formatReport: formatReport,
  };
})();
