/**
 * U2 / ux-D2 — 行内定界符邻域灰显验收 harness
 *
 * 纯函数测试（MdxMarksModel）；有 document 时附加 htmlToInlineMd 不双计。
 *
 * Usage:
 *   Browser: window.MdxU2Harness.runAll(); console.table(...)
 *   Node:    node -e "require('./…')" 或经 u2 测试页
 */
(function (root) {
  'use strict';

  var results = [];

  function Model() {
    return root.MdxMarksModel || (root.window && root.window.MdxMarksModel);
  }

  function Util() {
    return root.MdxUtil || (root.window && root.window.MdxUtil);
  }

  function Live() {
    return root.MdxLiveMarks || (root.window && root.window.MdxLiveMarks);
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

  function runPure() {
    var M = Model();
    if (!M || typeof M.parseInline !== 'function' || typeof M.runsToEditHtml !== 'function') {
      fail('MdxMarksModel available', 'load inline/marks-model.js');
      return;
    }
    pass('MdxMarksModel available');

    var runs = M.parseInline('**ab**');
    assert(
      runs.length === 1 && runs[0].type === 'bold' && runs[0].text === 'ab',
      'parseInline **ab** → bold run',
      JSON.stringify(runs)
    );

    // 无 caret → 不插定界符
    var htmlNoCaret = M.runsToEditHtml(runs);
    assert(
      htmlNoCaret.indexOf('mdx-src-delim') < 0 &&
        htmlNoCaret.indexOf('**') < 0 &&
        /<strong>ab<\/strong>/.test(htmlNoCaret),
      'runsToEditHtml without caret → no mdx-src-delim',
      htmlNoCaret
    );

    // caret 在 mark 内（offset 3 = 内容中 'a' 后）
    var htmlNear = M.runsToEditHtml(runs, { caretMd: 3, showDelimsNearCaret: true });
    assert(
      htmlNear.indexOf('mdx-src-delim') >= 0 &&
        htmlNear.indexOf('data-mdx-delim="**"') >= 0 &&
        htmlNear.indexOf('mdx-mark-near') >= 0 &&
        htmlNear.indexOf('**') >= 0,
      'runsToEditHtml caret in mark → mdx-src-delim + **',
      htmlNear
    );

    // caret 在 mark 外（仅前缀文本场景）
    var runs2 = M.parseInline('x**ab**y');
    var htmlFar = M.runsToEditHtml(runs2, { caretMd: 0 });
    assert(
      htmlFar.indexOf('mdx-src-delim') < 0,
      'caret outside mark → no delim',
      htmlFar
    );
    var htmlIn = M.runsToEditHtml(runs2, { caretMd: 3 });
    assert(
      htmlIn.indexOf('mdx-src-delim') >= 0,
      'caret inside bold of x**ab**y → delim',
      htmlIn
    );

    // 其它 mark 类型
    var emRuns = M.parseInline('*hi*');
    var emHtml = M.runsToEditHtml(emRuns, { caretMd: 1 });
    assert(
      emHtml.indexOf('data-mdx-delim="*"') >= 0,
      'italic near caret → grey *',
      emHtml
    );

    var codeRuns = M.parseInline('`c`');
    var codeHtml = M.runsToEditHtml(codeRuns, { caretMd: 1 });
    assert(
      codeHtml.indexOf('mdx-src-delim') >= 0 && codeHtml.indexOf('`') >= 0,
      'code near caret → grey backtick',
      codeHtml
    );

    // runMdSpan
    if (typeof M.runMdSpan === 'function') {
      var sp = M.runMdSpan(runs, 0);
      assert(
        sp.start === 0 && sp.end === 6 && sp.open === '**',
        'runMdSpan **ab** → [0,6)',
        JSON.stringify(sp)
      );
    } else {
      fail('runMdSpan exported', 'missing');
    }

    // showDelimsNearCaret: false 强制关闭
    var htmlOff = M.runsToEditHtml(runs, { caretMd: 3, showDelimsNearCaret: false });
    assert(
      htmlOff.indexOf('mdx-src-delim') < 0,
      'showDelimsNearCaret:false → no delim',
      htmlOff
    );

    // mdToEditHtml 透传 opts
    var L = Live();
    if (L && typeof L.mdToEditHtml === 'function') {
      var viaLive = L.mdToEditHtml('**ab**', { caretMd: 2 });
      assert(
        viaLive.indexOf('mdx-src-delim') >= 0,
        'mdToEditHtml passes caretMd',
        viaLive
      );
      var viaLive0 = L.mdToEditHtml('**ab**');
      assert(
        viaLive0.indexOf('mdx-src-delim') < 0,
        'mdToEditHtml without opts → no delim',
        viaLive0
      );
    } else {
      pass('mdToEditHtml skip (MdxLiveMarks optional for pure)', '');
    }

    // serialize 往返
    assert(
      M.serializeRuns(runs) === '**ab**',
      'serializeRuns bold still **ab**',
      M.serializeRuns(runs)
    );

    // --- ux-D2 成对 unwrap（纯函数）---
    if (typeof M.tryPairUnwrapMd !== 'function') {
      fail('tryPairUnwrapMd exported', 'missing');
    } else {
      // **hello** caret 在 h 前（offset 2）Backspace → hello
      var u1 = M.tryPairUnwrapMd('**hello**', 2, 'backspace');
      assert(
        u1 && u1.md === 'hello' && u1.caretMd === 0,
        'Backspace at content start of **hello** → hello',
        JSON.stringify(u1)
      );

      // 前缀文本：x**hello** caret=3（h 前）
      var u2 = M.tryPairUnwrapMd('x**hello**', 3, 'backspace');
      assert(
        u2 && u2.md === 'xhello' && u2.caretMd === 1,
        'Backspace after open in x**hello** → xhello caret@1',
        JSON.stringify(u2)
      );

      // caret 在 close 后（offset 9 = end of **hello**）
      var u3 = M.tryPairUnwrapMd('**hello**', 9, 'backspace');
      assert(
        u3 && u3.md === 'hello' && u3.caretMd === 5,
        'Backspace after close of **hello** → hello caret@end',
        JSON.stringify(u3)
      );

      // 内文中间不 unwrap
      var uMid = M.tryPairUnwrapMd('**hello**', 4, 'backspace');
      assert(
        uMid == null,
        'Backspace mid-content → no unwrap',
        JSON.stringify(uMid)
      );

      // Delete 在 open 前
      var uDel = M.tryPairUnwrapMd('**hello**', 0, 'delete');
      assert(
        uDel && uDel.md === 'hello' && uDel.caretMd === 0,
        'Delete before open **hello** → hello',
        JSON.stringify(uDel)
      );

      // Delete 在 close 前（内文末）
      var uDelEnd = M.tryPairUnwrapMd('**hello**', 7, 'delete');
      assert(
        uDelEnd && uDelEnd.md === 'hello' && uDelEnd.caretMd === 5,
        'Delete at content end of **hello** → hello',
        JSON.stringify(uDelEnd)
      );

      // 斜体 / code
      var uEm = M.tryPairUnwrapMd('*hi*', 1, 'backspace');
      assert(
        uEm && uEm.md === 'hi' && uEm.caretMd === 0,
        'Backspace unwrap italic *hi*',
        JSON.stringify(uEm)
      );
      var uCode = M.tryPairUnwrapMd('`c`', 1, 'backspace');
      assert(
        uCode && uCode.md === 'c',
        'Backspace unwrap code `c`',
        JSON.stringify(uCode)
      );

      // 往返：unwrap 后再 parse 无 mark
      var round = M.parseInline(u1.md);
      assert(
        round.length === 1 && round[0].type === 'text' && round[0].text === 'hello',
        'unwrap 后 parse → plain text run',
        JSON.stringify(round)
      );

      // computeRevealKey：caret 内 vs 外
      if (typeof M.computeRevealKey === 'function') {
        var kIn = M.computeRevealKey('x**ab**y', 3);
        var kOut = M.computeRevealKey('x**ab**y', 0);
        assert(
          kIn && kIn.indexOf('bold') >= 0 && kOut === '',
          'computeRevealKey near vs far',
          'in=' + kIn + ' out=' + kOut
        );
      }
    }

    // MdxDelimEdit 代理
    var D =
      root.MdxDelimEdit ||
      (root.window && root.window.MdxDelimEdit);
    if (D && typeof D.tryPairUnwrapMd === 'function') {
      var viaD = D.tryPairUnwrapMd('**ab**', 2, 'backspace');
      assert(
        viaD && viaD.md === 'ab',
        'MdxDelimEdit.tryPairUnwrapMd delegates',
        JSON.stringify(viaD)
      );
    } else {
      pass('MdxDelimEdit skip (optional for pure model tests)', '');
    }
  }

  /** DOM：htmlToInlineMd 不因 delim 双计 ** */
  function runDom() {
    var d = doc();
    var U = Util();
    if (!d || !U || typeof U.htmlToInlineMd !== 'function') {
      pass('htmlToInlineMd DOM skip (no document)', '');
      return;
    }

    var el = d.createElement('div');
    el.innerHTML =
      '<strong class="mdx-mark-near" data-mdx-mark="bold">' +
      '<span class="mdx-src-delim" data-mdx-delim="**" contenteditable="false">**</span>' +
      'ab' +
      '<span class="mdx-src-delim" data-mdx-delim="**" contenteditable="false">**</span>' +
      '</strong>';
    var md = U.htmlToInlineMd(el);
    assert(
      md === '**ab**',
      'htmlToInlineMd with delims → **ab** (no double count)',
      'got: ' + JSON.stringify(md)
    );

    // 无 delim 的 strong 同样正确
    var el2 = d.createElement('div');
    el2.innerHTML = '<strong>ab</strong>';
    assert(
      U.htmlToInlineMd(el2) === '**ab**',
      'htmlToInlineMd plain strong → **ab**',
      U.htmlToInlineMd(el2)
    );

    // 混排
    var el3 = d.createElement('div');
    el3.innerHTML =
      'x' +
      '<em class="mdx-mark-near" data-mdx-mark="italic">' +
      '<span class="mdx-src-delim" data-mdx-delim="*" contenteditable="false">*</span>' +
      'y' +
      '<span class="mdx-src-delim" data-mdx-delim="*" contenteditable="false">*</span>' +
      '</em>' +
      'z';
    assert(
      U.htmlToInlineMd(el3) === 'x*y*z',
      'htmlToInlineMd mixed italic+delim',
      U.htmlToInlineMd(el3)
    );
  }

  function runAll(opts) {
    opts = opts || {};
    results = [];
    runPure();
    if (!opts.skipDom) runDom();
    var failed = 0;
    for (var i = 0; i < results.length; i++) {
      if (!results[i].ok) failed += 1;
    }
    return {
      ok: failed === 0,
      failed: failed,
      total: results.length,
      results: results,
    };
  }

  var api = { runAll: runAll, runPure: runPure, runDom: runDom };
  root.MdxU2Harness = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this);
