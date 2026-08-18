/**
 * U3 paste + full-source split/demote pure harness
 * Load after line-source.js + clipboard/paste.js
 */
(function () {
  'use strict';

  function run(report) {
    var results = [];
    function assert(cond, name, detail) {
      results.push({ ok: !!cond, name: name, detail: detail || '' });
      if (report) report(!!cond, name, detail);
    }

    var LS = window.MdxLineSource;
    var CP = window.MdxClipboardPaste;

    assert(!!LS, 'MdxLineSource loaded');
    assert(!!CP, 'MdxClipboardPaste loaded');

    // --- toSourceLine keeps ** ---
    if (LS) {
      var srcBold = LS.toSourceLine({ type: 'paragraph', text: 'hello **world**' });
      assert(srcBold.indexOf('**world**') >= 0, 'toSourceLine keeps **bold**', srcBold);

      var srcH = LS.toSourceLine({ type: 'heading', level: 2, text: 'Title **x**' });
      assert(srcH.indexOf('## ') === 0, 'heading source starts with ## ', srcH);
      assert(srcH.indexOf('**x**') >= 0, 'heading source keeps inline **', srcH);

      // parse roundtrip
      var p = LS.parseSourceLine('## Hello **world**');
      assert(p && p.type === 'heading' && p.level === 2, 'parse ## heading', JSON.stringify(p));
      assert(p && p.text === 'Hello **world**', 'parse keeps ** in body', p && p.text);

      // full source surface contains raw **
      var html = LS.renderFullSourceSurface({ type: 'paragraph', text: 'a **b** c' });
      assert(html.indexOf('**b**') >= 0, 'renderFullSourceSurface shows **', html.slice(0, 120));
      assert(html.indexOf('<strong>') < 0, 'full source does not fold strong', html.slice(0, 120));
    }

    // --- splitFullSourceAt ---
    if (LS && LS.splitFullSourceAt) {
      // "## Hello world" — offset after "Hello" (prefix ##␠ + Hello = 3+5 = 8)
      var sp1 = LS.splitFullSourceAt('## Hello world', 8, { type: 'heading', level: 2 });
      assert(sp1.before && sp1.before.type === 'heading', 'split left is heading', JSON.stringify(sp1.before));
      assert(
        String(sp1.before.text || '').replace(/\s+$/, '') === 'Hello',
        'split left body without ##',
        sp1.before && sp1.before.text
      );
      assert(sp1.after && sp1.after.type === 'paragraph', 'split right heading→paragraph', JSON.stringify(sp1.after));
      assert(
        String(sp1.after.text || '').replace(/^\s+/, '') === 'world',
        'split right is world',
        sp1.after && sp1.after.text
      );

      // "* item one more" — offset after "item" ( "* " + "item" = 2+4 = 6 )
      var spList = LS.splitFullSourceAt('* item one more', 6, { type: 'bullet_item' });
      assert(spList.before && spList.before.type === 'bullet_item', 'split list left bullet', JSON.stringify(spList.before));
      assert(spList.after && spList.after.type === 'bullet_item', 'split list right continues bullet', JSON.stringify(spList.after));
      assert(
        spList.before.text.indexOf('*') < 0,
        'list left body has no marker',
        spList.before && spList.before.text
      );

      var rawMid = 'hello **world**';
      var off = 'hello **wo'.length; // 10
      var spB = LS.splitFullSourceAt(rawMid, off, { type: 'paragraph' });
      assert(spB.before.text === 'hello **wo', 'split mid-bold left', spB.before && spB.before.text);
      assert(spB.after.text === 'rld**', 'split mid-bold right', spB.after && spB.after.text);
    }

    // --- fullSourceBackspaceAtStart ---
    if (LS && LS.fullSourceBackspaceAtStart) {
      var d1 = LS.fullSourceBackspaceAtStart('## Hello', { type: 'heading', level: 2 }, {});
      assert(d1.action === 'merge-prev', 'bs at start non-empty body → merge', d1.action);
      assert(d1.bodyText === 'Hello', 'merge bodyText is body only', d1.bodyText);

      var d2 = LS.fullSourceBackspaceAtStart('## ', { type: 'heading', level: 2 }, {});
      assert(
        d2.action === 'apply-raw' || d2.action === 'demote-heading' || d2.action === 'to-paragraph',
        'bs empty heading structure demotes',
        d2.action
      );

      var d3 = LS.fullSourceBackspaceAtStart('##', { type: 'heading', level: 2 }, {});
      assert(
        d3.action === 'demote-heading' || d3.action === 'to-paragraph',
        'bs ## only demotes level',
        d3.action + ' ' + JSON.stringify(d3.patch)
      );

      var d4 = LS.fullSourceBackspaceAtStart('* ', { type: 'bullet_item' }, {});
      assert(d4.action === 'to-paragraph', 'bs empty bullet → paragraph', d4.action);

      var d5 = LS.fullSourceBackspaceAtStart('', { type: 'paragraph' }, { isFirstBlock: false, hasMore: true });
      assert(d5.action === 'merge-prev', 'bs empty para → merge', d5.action);
    }

    // --- paste detect + htmlToMd ---
    if (CP) {
      assert(CP.looksLikeMarkdown('## Title\n\npara'), 'looksLikeMarkdown heading');
      assert(CP.looksLikeMarkdown('- a\n- b'), 'looksLikeMarkdown list');
      assert(CP.looksLikeMarkdown('```js\nx\n```'), 'looksLikeMarkdown fence');
      assert(!CP.looksLikeMarkdown('just a line'), 'plain line not forced md');

      var kind1 = CP.detectPasteKind('', '## Hi\n\nbody', ['text/plain']);
      assert(kind1 === 'markdown', 'detect MD plain', kind1);

      var kind2 = CP.detectPasteKind('<p>hello <strong>x</strong></p>', 'hello x', ['text/html', 'text/plain']);
      assert(kind2 === 'html' || kind2 === 'plain' || kind2 === 'markdown', 'detect html-ish', kind2);

      var mdFromHtml = CP.htmlToMarkdown('<h2>Title</h2><p>a <strong>bold</strong> t</p>');
      assert(mdFromHtml.indexOf('## ') >= 0 || mdFromHtml.indexOf('Title') >= 0, 'htmlToMarkdown heading', mdFromHtml);
      assert(mdFromHtml.indexOf('**bold**') >= 0, 'htmlToMarkdown bold', mdFromHtml);

      var blocks = CP.clipboardToBlocks('', '## A\n\nB **c**\n\n- item', ['text/plain']);
      assert(blocks.blocks && blocks.blocks.length >= 2, 'clipboardToBlocks multi', blocks.blocks && blocks.blocks.length);
      assert(
        blocks.blocks.some(function (b) {
          return b.type === 'heading';
        }),
        'clipboardToBlocks has heading'
      );
      assert(
        blocks.blocks.some(function (b) {
          return b.type === 'bullet_item' || (b.text && b.text.indexOf('item') >= 0);
        }),
        'clipboardToBlocks has list-ish'
      );

      var inline = CP.clipboardToBlocks('', 'hello', ['text/plain']);
      assert(inline.inlineOnly === true, 'single plain is inlineOnly', JSON.stringify(inline));
    }

    var passed = results.filter(function (r) {
      return r.ok;
    }).length;
    var failed = results.length - passed;
    return { results: results, passed: passed, failed: failed, total: results.length };
  }

  window.MdxU3PasteFullsrcHarness = { run: run };

  // auto-run if #u3-out present
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function () {
      var out = document.getElementById('u3-out');
      if (!out) return;
      var r = run(function (ok, name, detail) {
        var line = document.createElement('div');
        line.className = ok ? 'pass' : 'fail';
        line.textContent = (ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : '');
        out.appendChild(line);
      });
      var sum = document.createElement('div');
      sum.style.marginTop = '12px';
      sum.style.fontWeight = '600';
      sum.textContent = 'Result: ' + r.passed + '/' + r.total + (r.failed ? ' FAILED' : ' OK');
      out.appendChild(sum);
    });
  }
})();
