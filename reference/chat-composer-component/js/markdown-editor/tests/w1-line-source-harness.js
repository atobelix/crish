/**
 * W1 acceptance harness — line-source model + demotion
 *
 * Pure unit tests for MdxLineSource / MdxDemotion (no DOM required).
 * Optional DOM checks (renderEditSurface, sel-bar) when document exists.
 *
 * Usage:
 *   Browser console (after scripts load):
 *     var r = window.MdxW1Harness.runAll(); console.table(r.results);
 *   HTML page markdown-editor-w1-test.html auto-runs and paints PASS/FAIL.
 *   Node-less pure: ensure window.MdxLineSource + window.MdxDemotion, then runAll({ skipDom: true }).
 *
 * demoteStep contract (edit/demotion.js):
 *   demoteStep(block, ctx?) → { action, patch?, note? }
 *   Empty heading needs ctx.hasGap === false to skip strip-gap and hit level demote.
 */
(function (root) {
  'use strict';

  var results = [];

  function LineSrc() {
    return root.MdxLineSource || (root.window && root.window.MdxLineSource);
  }

  function Demotion() {
    return root.MdxDemotion || (root.window && root.window.MdxDemotion) || null;
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

  function assert(cond, name, detail) {
    if (cond) pass(name, detail);
    else fail(name, detail || 'assertion failed');
  }

  function startsWith(s, prefix) {
    return String(s || '').indexOf(prefix) === 0;
  }

  function j(v) {
    try {
      return JSON.stringify(v);
    } catch (e) {
      return String(v);
    }
  }

  /** Pure tests — no DOM */
  function runPure() {
    var LS = LineSrc();
    var DM = Demotion();

    if (!LS || typeof LS.toSourceLine !== 'function') {
      fail(
        'MdxLineSource available',
        'window.MdxLineSource missing — load ui/line-source.js'
      );
      return;
    }
    pass('MdxLineSource available');

    // --- toSourceLine: heading starts with ## ---
    var h2Src = LS.toSourceLine({ type: 'heading', level: 2, text: 'Title' });
    assert(
      startsWith(h2Src, '##'),
      'toSourceLine heading starts with ##',
      'got: ' + j(h2Src)
    );

    var h1Src = LS.toSourceLine({ type: 'heading', level: 1, text: 'A' });
    assert(
      startsWith(h1Src, '# ') || h1Src === '# A',
      'toSourceLine H1 is # + text',
      h1Src
    );

    var bulletSrc = LS.toSourceLine({ type: 'bullet_item', text: 'item' });
    assert(startsWith(bulletSrc, '* '), 'toSourceLine bullet uses *', bulletSrc);

    var quoteSrc = LS.toSourceLine({ type: 'quote', text: 'q' });
    assert(startsWith(quoteSrc, '> '), 'toSourceLine quote uses >', quoteSrc);

    var codeSrc = LS.toSourceLine({ type: 'code', lang: 'js', text: 'x' });
    assert(startsWith(codeSrc, '```'), 'toSourceLine code is fenced', codeSrc.slice(0, 24));

    // --- parseSourceLine ---
    if (typeof LS.parseSourceLine !== 'function') {
      fail('parseSourceLine available', 'missing');
    } else {
      var parsed = LS.parseSourceLine('## Hi');
      assert(
        parsed && parsed.type === 'heading' && parsed.level === 2,
        "parseSourceLine('## Hi') → heading level 2",
        parsed ? j(parsed) : 'null'
      );
      assert(
        parsed && parsed.text === 'Hi',
        "parseSourceLine('## Hi').text === 'Hi'",
        parsed && parsed.text
      );

      var pBullet = LS.parseSourceLine('* item');
      assert(
        pBullet && pBullet.type === 'bullet_item',
        "parseSourceLine('* item') → bullet_item",
        pBullet && pBullet.type
      );

      var pQuote = LS.parseSourceLine('> hi');
      assert(
        pQuote && pQuote.type === 'quote',
        "parseSourceLine('> hi') → quote",
        pQuote && pQuote.type
      );

      var pPara = LS.parseSourceLine('plain');
      assert(
        pPara && pPara.type === 'paragraph',
        "parseSourceLine('plain') → paragraph",
        pPara && pPara.type
      );
    }

    // --- demoteStep (MdxDemotion pure API) ---
    if (!DM || typeof DM.demoteStep !== 'function') {
      fail(
        'demoteStep available',
        'window.MdxDemotion.demoteStep missing — load edit/demotion.js'
      );
    } else {
      pass('demoteStep available');

      // Empty structured default first step is strip-gap
      var stripFirst = DM.demoteStep({ type: 'heading', level: 2, text: '' });
      assert(
        stripFirst && stripFirst.action === 'strip-gap',
        'demoteStep empty H2 (default gap) → strip-gap',
        stripFirst ? j(stripFirst) : 'null'
      );

      // After gap gone: H2 → H1
      var d2 = DM.demoteStep(
        { type: 'heading', level: 2, text: '' },
        { hasGap: false, caretOffset: 0 }
      );
      assert(
        d2 &&
          d2.action === 'demote-heading' &&
          d2.patch &&
          d2.patch.type === 'heading' &&
          d2.patch.level === 1,
        'demoteStep empty heading level 2 → level 1',
        d2 ? j(d2) : 'null'
      );

      // H1 → paragraph
      var d1 = DM.demoteStep(
        { type: 'heading', level: 1, text: '' },
        { hasGap: false, caretOffset: 0 }
      );
      assert(
        d1 &&
          d1.action === 'to-paragraph' &&
          d1.patch &&
          d1.patch.type === 'paragraph',
        'demoteStep empty heading level 1 → paragraph',
        d1 ? j(d1) : 'null'
      );

      var d3 = DM.demoteStep(
        { type: 'heading', level: 3, text: '' },
        { hasGap: false, caretOffset: 0 }
      );
      assert(
        d3 &&
          d3.action === 'demote-heading' &&
          d3.patch &&
          d3.patch.level === 2,
        'demoteStep empty heading level 3 → level 2',
        d3 ? j(d3) : 'null'
      );

      var dBullet = DM.demoteStep(
        { type: 'bullet_item', text: '' },
        { hasGap: false, caretOffset: 0 }
      );
      assert(
        dBullet &&
          (dBullet.action === 'strip-mark' || dBullet.action === 'to-paragraph') &&
          dBullet.patch &&
          dBullet.patch.type === 'paragraph',
        'demoteStep empty bullet → paragraph',
        dBullet ? j(dBullet) : 'null'
      );

      // Empty paragraph: sole → noop; not first → merge-prev
      var dParaSole = DM.demoteStep(
        { type: 'paragraph', text: '' },
        { soleBlock: true, caretOffset: 0 }
      );
      assert(
        dParaSole && dParaSole.action === 'noop',
        'demoteStep sole empty paragraph → noop',
        dParaSole ? j(dParaSole) : 'null'
      );

      // simulateLadder optional smoke
      if (typeof DM.simulateLadder === 'function') {
        var ladder = DM.simulateLadder({ type: 'heading', level: 2, text: '' }, 6);
        var actions = ladder.map(function (s) {
          return s.action;
        });
        var hasDemote = actions.indexOf('demote-heading') >= 0;
        var hasToP = actions.indexOf('to-paragraph') >= 0;
        assert(
          hasDemote && hasToP,
          'simulateLadder H2 empty reaches demote-heading + to-paragraph',
          actions.join(' → ')
        );
      }
    }
  }

  /** DOM tests when document + renderEditSurface exist */
  function runDom() {
    var LS = LineSrc();
    var d = doc();
    if (!d) {
      fail('DOM available', 'no document — skip DOM tests');
      return;
    }
    if (!LS || typeof LS.renderEditSurface !== 'function') {
      fail('renderEditSurface available', 'missing');
      return;
    }

    var html = LS.renderEditSurface(
      { type: 'heading', level: 2, text: 'Hi' },
      { softListMark: true }
    );
    assert(
      typeof html === 'string' && html.indexOf('mdx-src-mark') >= 0,
      'renderEditSurface contains mdx-src-mark',
      html ? html.slice(0, 120) : ''
    );
    assert(
      typeof html === 'string' && html.indexOf('##') >= 0,
      'renderEditSurface contains ##',
      html ? html.slice(0, 160) : ''
    );

    // selection toolbar not visible by default
    var visibleBar = d.querySelector('.mdx-sel-bar.is-visible');
    var bar = d.querySelector('.mdx-sel-bar');
    var selOk =
      !visibleBar &&
      (!bar || bar.hidden === true || !bar.classList.contains('is-visible'));
    assert(
      selOk,
      'selection toolbar not visible by default',
      visibleBar
        ? 'found .mdx-sel-bar.is-visible'
        : bar
          ? 'bar present, hidden=' + bar.hidden + ' class=' + bar.className
          : 'no .mdx-sel-bar in DOM (ok)'
    );
  }

  /**
   * @param {{ skipDom?: boolean }} [opts]
   * @returns {{ passed: number, failed: number, results: Array, ok: boolean }}
   */
  function runAll(opts) {
    opts = opts || {};
    results = [];
    runPure();
    if (!opts.skipDom) runDom();

    var passed = 0;
    var failed = 0;
    for (var i = 0; i < results.length; i++) {
      if (results[i].ok) passed++;
      else failed++;
    }
    return {
      passed: passed,
      failed: failed,
      results: results.slice(),
      ok: failed === 0,
    };
  }

  function formatReport(report) {
    report = report || runAll();
    var lines = [];
    lines.push(
      'W1 line-source harness: ' +
        (report.ok ? 'ALL PASS' : 'FAIL') +
        ' (' +
        report.passed +
        ' passed, ' +
        report.failed +
        ' failed)'
    );
    for (var i = 0; i < report.results.length; i++) {
      var r = report.results[i];
      lines.push(
        (r.ok ? 'PASS' : 'FAIL') +
          '  ' +
          r.name +
          (r.detail ? ' — ' + r.detail : '')
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
    summary.className = 'w1-harness-summary ' + (report.ok ? 'is-pass' : 'is-fail');
    summary.textContent =
      (report.ok ? 'ALL PASS' : 'SOME FAILED') +
      ' — ' +
      report.passed +
      ' passed / ' +
      report.failed +
      ' failed';

    var list = d.createElement('ul');
    list.className = 'w1-harness-list';
    for (var i = 0; i < report.results.length; i++) {
      var r = report.results[i];
      var li = d.createElement('li');
      li.className = r.ok ? 'w1-pass' : 'w1-fail';
      var badge = d.createElement('span');
      badge.className = 'w1-badge';
      badge.textContent = r.ok ? 'PASS' : 'FAIL';
      var name = d.createElement('span');
      name.className = 'w1-name';
      name.textContent = r.name;
      li.appendChild(badge);
      li.appendChild(name);
      if (r.detail) {
        var det = d.createElement('span');
        det.className = 'w1-detail';
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

  root.MdxW1Harness = api;
  if (root.window) root.window.MdxW1Harness = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
