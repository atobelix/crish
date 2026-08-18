/**
 * W2 acceptance harness — code single surface
 *
 * Pure unit tests for MdxBlocksCode / fence parse roundtrip (no DOM required).
 * Optional DOM checks (mount with one code block) when document + MarkdownEditor exist.
 *
 * Usage:
 *   Browser console (after scripts load):
 *     var r = window.MdxW2Harness.runAll(); console.table(r.results);
 *   HTML page markdown-editor-w2-test.html auto-runs and paints PASS/FAIL.
 *   Node-less pure: ensure MdxBlocksCode + MdxParse (+ highlight), then runAll({ skipDom: true }).
 *
 * Coverage (W2 / F-CODE-HL · F-CODE-SRC · F-CODE-FENCE · C-R21 gutter · F-CODE-LANG · F-CODE-FOLD):
 *   - MdxBlocksCode.readHtml → highlight class or mdx-tok
 *   - MdxBlocksCode.readHtml → mdx-code-gutter / line count / trailing-\n
 *   - MdxBlocksCode.sourceHtml / LineSource → contains ```
 *   - parse fence roundtrip lang + text
 *   - fold pure: count/shouldDefaultFold/slice/readHtml fold marks
 *   - lang menu: data-mdx-code-lang + COMMON_LANGS / menu HTML
 *   - DOM: editor mount with one code block (optional)
 *   - DOM: gutter nodes + bodyTextFromCard pure body
 */
(function (root) {
  'use strict';

  var results = [];

  function BlocksCode() {
    return root.MdxBlocksCode || (root.window && root.window.MdxBlocksCode) || null;
  }

  function BlocksCodeEdit() {
    return (
      root.MdxBlocksCodeEdit ||
      (root.window && root.window.MdxBlocksCodeEdit) ||
      null
    );
  }

  function LineSrc() {
    return root.MdxLineSource || (root.window && root.window.MdxLineSource) || null;
  }

  function Parse() {
    return root.MdxParse || (root.window && root.window.MdxParse) || null;
  }

  function Serialize() {
    return root.MdxSerialize || (root.window && root.window.MdxSerialize) || null;
  }

  function Highlight() {
    return (
      root.MdxCodeHighlight ||
      (root.window && root.window.MdxCodeHighlight) ||
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

  function hasHighlightSignal(html) {
    var s = String(html || '');
    return (
      s.indexOf('mdx-tok') >= 0 ||
      s.indexOf('mdx-code-card') >= 0 ||
      /language-[\w-]*/.test(s) ||
      s.indexOf('mdx-pre') >= 0
    );
  }

  function sampleCodeBlock() {
    return {
      type: 'code',
      lang: 'js',
      text: "const x = 1;\nconsole.log('hi');",
    };
  }

  /** Pure tests — no DOM */
  function runPure() {
    var Code = BlocksCode();
    var LS = LineSrc();
    var P = Parse();
    var S = Serialize();
    var HL = Highlight();

    // --- modules available ---
    if (!Code || typeof Code.readHtml !== 'function') {
      fail(
        'MdxBlocksCode available',
        'window.MdxBlocksCode missing — load blocks/code-read.js'
      );
    } else {
      pass('MdxBlocksCode available');
    }

    if (!HL || typeof HL.highlightCode !== 'function') {
      // soft: readHtml still works via esc fallback; still note it
      fail(
        'MdxCodeHighlight available',
        'window.MdxCodeHighlight missing — load ui/code-highlight.js'
      );
    } else {
      pass('MdxCodeHighlight available');
    }

    var block = sampleCodeBlock();

    // --- readHtml: highlight class or mdx-tok ---
    if (Code && typeof Code.readHtml === 'function') {
      var read = Code.readHtml(block);
      assert(
        typeof read === 'string' && read.length > 0,
        'readHtml returns non-empty string',
        read ? read.slice(0, 80) : ''
      );

      var hasTok = String(read).indexOf('mdx-tok') >= 0;
      var hasHlClass =
        hasHighlightSignal(read) ||
        String(read).indexOf('language-js') >= 0 ||
        String(read).indexOf('mdx-code-card__code') >= 0;
      assert(
        hasTok || hasHlClass,
        'readHtml contains highlight class or mdx-tok',
        hasTok
          ? 'found mdx-tok'
          : 'html slice: ' + String(read).slice(0, 160)
      );

      // stronger signal when highlighter is present
      if (HL && typeof HL.highlightCode === 'function') {
        var hlOnly = HL.highlightCode(block.text, block.lang);
        assert(
          String(hlOnly).indexOf('mdx-tok') >= 0,
          'highlightCode emits mdx-tok spans for js sample',
          hlOnly ? hlOnly.slice(0, 120) : ''
        );
      }

      assert(
        String(read).indexOf('mdx-code-card') >= 0,
        'readHtml is single code card surface',
        'expect .mdx-code-card'
      );

      // C-R21 / F-CODE-LINES：读态行号 gutter
      assert(
        String(read).indexOf('mdx-code-gutter') >= 0,
        'readHtml contains mdx-code-gutter',
        'expect line-number gutter'
      );
      assert(
        String(read).indexOf('mdx-code-gutter__n') >= 0,
        'readHtml contains gutter line numbers',
        'expect .mdx-code-gutter__n'
      );
      // sample: "const x = 1;\nconsole.log('hi');" → 2 行
      var n1 = (String(read).match(/mdx-code-gutter__n/g) || []).length;
      assert(
        n1 === 2,
        'readHtml gutter line count matches body (2)',
        'count=' + n1
      );
      // 空代码至少 1 行
      var emptyRead = Code.readHtml({ type: 'code', lang: '', text: '' });
      var nEmpty = (String(emptyRead).match(/mdx-code-gutter__n/g) || []).length;
      assert(
        nEmpty === 1,
        'empty code gutter has 1 line',
        'count=' + nEmpty
      );
      // 末尾 \n 不多算一行
      var tailRead = Code.readHtml({
        type: 'code',
        lang: 'js',
        text: "const x = 1;\nconsole.log('hi');\n",
      });
      var nTail = (String(tailRead).match(/mdx-code-gutter__n/g) || []).length;
      assert(
        nTail === 2,
        'trailing newline does not add extra gutter line',
        'count=' + nTail
      );
      // body 包裹 gutter + pre
      assert(
        String(read).indexOf('mdx-code-card__body') >= 0,
        'readHtml wraps gutter+pre in mdx-code-card__body',
        'expect .mdx-code-card__body'
      );

      // F-CODE-LANG：语言标签可点（button + data-mdx-code-lang）
      assert(
        String(read).indexOf('data-mdx-code-lang') >= 0 &&
          String(read).indexOf('mdx-code-card__lang') >= 0,
        'readHtml lang control has data-mdx-code-lang',
        'expect [data-mdx-code-lang].mdx-code-card__lang'
      );
      assert(
        /<button[^>]*mdx-code-card__lang/.test(String(read)) ||
          String(read).indexOf('data-mdx-code-lang') >= 0,
        'readHtml lang is interactive control',
        'button or data attr'
      );
    }

    // --- F-CODE-FOLD pure helpers ---
    if (Code) {
      var thr =
        typeof Code.FOLD_THRESHOLD === 'number' ? Code.FOLD_THRESHOLD : 24;
      var prev =
        typeof Code.FOLD_PREVIEW === 'number' ? Code.FOLD_PREVIEW : 12;
      assert(
        thr === 24 && prev === 12,
        'fold defaults N=24 preview=12',
        'thr=' + thr + ' prev=' + prev
      );

      if (typeof Code.shouldDefaultFold === 'function') {
        assert(
          Code.shouldDefaultFold(24) === false,
          'shouldDefaultFold(24) is false (strict > N)',
          '24 not folded'
        );
        assert(
          Code.shouldDefaultFold(25) === true,
          'shouldDefaultFold(25) is true',
          '25 folds'
        );
        assert(
          Code.shouldDefaultFold(30) === true,
          'shouldDefaultFold(30) is true',
          '30 folds'
        );
      } else {
        fail('shouldDefaultFold available', 'missing pure fold helper');
      }

      if (typeof Code.foldVisibleLines === 'function') {
        assert(
          Code.foldVisibleLines(30, false) === 12,
          'foldVisibleLines(30,false) === 12',
          'got=' + Code.foldVisibleLines(30, false)
        );
        assert(
          Code.foldVisibleLines(30, true) === 30,
          'foldVisibleLines(30,true) === 30',
          'got=' + Code.foldVisibleLines(30, true)
        );
        assert(
          Code.foldVisibleLines(10, false) === 10,
          'short block not clipped',
          'got=' + Code.foldVisibleLines(10, false)
        );
      }

      if (typeof Code.sliceFirstLines === 'function') {
        var longLines = [];
        for (var li = 1; li <= 30; li++) longLines.push('line' + li);
        var longText = longLines.join('\n');
        var sliced = Code.sliceFirstLines(longText, 12);
        var slicedN = Code.countLines(sliced);
        assert(
          slicedN === 12,
          'sliceFirstLines(30,12) yields 12 lines',
          'count=' + slicedN
        );
        assert(
          String(sliced).indexOf('line12') >= 0 &&
            String(sliced).indexOf('line13') < 0,
          'sliceFirstLines keeps line12, drops line13',
          sliced.slice(0, 80)
        );
      }

      // 30 行默认折叠 HTML 标记
      var longBody = [];
      for (var lj = 1; lj <= 30; lj++) longBody.push('const a' + lj + ' = ' + lj + ';');
      var longBlock = {
        type: 'code',
        lang: 'js',
        text: longBody.join('\n'),
      };
      if (typeof Code.readHtml === 'function') {
        var foldedHtml = Code.readHtml(longBlock);
        assert(
          String(foldedHtml).indexOf('data-folded') >= 0 ||
            String(foldedHtml).indexOf('is-folded') >= 0,
          '30-line readHtml is folded by default',
          'expect data-folded / is-folded'
        );
        assert(
          String(foldedHtml).indexOf('data-mdx-code-fold') >= 0 ||
            String(foldedHtml).indexOf('mdx-code-card__fold') >= 0,
          'folded readHtml has expand control',
          'expect fold button'
        );
        var foldGutterN = (String(foldedHtml).match(/mdx-code-gutter__n/g) || [])
          .length;
        assert(
          foldGutterN === 12,
          'folded gutter shows 12 visible line numbers',
          'count=' + foldGutterN
        );
        assert(
          String(foldedHtml).indexOf('data-mdx-code-full') >= 0,
          'folded readHtml stashes full body for copy',
          'expect [data-mdx-code-full]'
        );
        var expandedHtml = Code.readHtml(longBlock, { expanded: true });
        assert(
          String(expandedHtml).indexOf('data-folded') < 0 &&
            String(expandedHtml).indexOf('is-folded') < 0,
          'expanded readHtml not folded',
          'opts.expanded=true'
        );
        var expGutterN = (String(expandedHtml).match(/mdx-code-gutter__n/g) || [])
          .length;
        assert(
          expGutterN === 30,
          'expanded gutter shows all 30 lines',
          'count=' + expGutterN
        );
        assert(
          String(expandedHtml).indexOf('data-mdx-code-fold="collapse"') >= 0 ||
            String(expandedHtml).indexOf('收起') >= 0,
          'expanded readHtml has collapse control',
          'expect 收起'
        );
        // 源码态不受折叠影响
        var srcLong = Code.sourceHtml(longBlock);
        assert(
          String(srcLong).indexOf('mdx-code-card__fold') < 0 &&
            String(srcLong).indexOf('data-folded') < 0,
          'sourceHtml has no fold chrome',
          'source unaffected'
        );
      }
    }

    // --- F-CODE-LANG menu module ---
    var LangMenu =
      root.MdxCodeLangMenu ||
      (root.window && root.window.MdxCodeLangMenu) ||
      null;
    if (!LangMenu) {
      fail(
        'MdxCodeLangMenu available',
        'window.MdxCodeLangMenu missing — load ui/code-lang-menu.js'
      );
    } else {
      pass('MdxCodeLangMenu available');
      assert(
        LangMenu.COMMON_LANGS && LangMenu.COMMON_LANGS.length >= 8,
        'COMMON_LANGS has engineer defaults',
        'len=' + (LangMenu.COMMON_LANGS ? LangMenu.COMMON_LANGS.length : 0)
      );
      var ids = (LangMenu.COMMON_LANGS || [])
        .map(function (x) {
          return x.id;
        })
        .join(',');
      assert(
        ids.indexOf('js') >= 0 &&
          ids.indexOf('python') >= 0 &&
          ids.indexOf('rust') >= 0 &&
          ids.indexOf('text') >= 0,
        'COMMON_LANGS includes js/python/rust/text',
        ids.slice(0, 120)
      );
    }

    // --- sourceHtml / LineSource: contains ``` ---
    var sourceStr = '';
    if (Code && typeof Code.sourceHtml === 'function') {
      sourceStr = Code.sourceHtml(block);
      assert(
        typeof sourceStr === 'string' && sourceStr.indexOf('```') >= 0,
        'sourceHtml contains ``` fence',
        sourceStr ? sourceStr.slice(0, 120) : ''
      );
      assert(
        String(sourceStr).indexOf('textarea') < 0,
        'sourceHtml has no nested textarea',
        'single contenteditable surface'
      );
    } else {
      fail('sourceHtml available', 'MdxBlocksCode.sourceHtml missing');
    }

    // --- MdxBlocksCodeEdit mount/parse ---
    var CodeEdit = BlocksCodeEdit();
    if (!CodeEdit) {
      fail(
        'MdxBlocksCodeEdit available',
        'window.MdxBlocksCodeEdit missing — load blocks/code-edit.js'
      );
    } else {
      pass('MdxBlocksCodeEdit available');
      if (typeof CodeEdit.parseSource === 'function' && typeof CodeEdit.fenceSource === 'function') {
        var fence = CodeEdit.fenceSource(block);
        assert(
          fence.indexOf('```js') === 0 || fence.indexOf('```') === 0,
          'CodeEdit.fenceSource starts with fence',
          fence.slice(0, 40)
        );
      }
      if (typeof CodeEdit.sourceHtml === 'function') {
        var se = CodeEdit.sourceHtml(block);
        assert(
          se.indexOf('```') >= 0 && se.indexOf('textarea') < 0,
          'CodeEdit.sourceHtml fence, no textarea',
          se.slice(0, 100)
        );
      }
    }

    if (LS && typeof LS.toSourceLine === 'function') {
      var fenceSrc = LS.toSourceLine(block);
      assert(
        typeof fenceSrc === 'string' && fenceSrc.indexOf('```') >= 0,
        'LineSource.toSourceLine contains ```',
        fenceSrc ? fenceSrc.slice(0, 48) : ''
      );
      assert(
        startsWithFence(fenceSrc, 'js'),
        'toSourceLine starts with ```js',
        fenceSrc ? fenceSrc.split('\n')[0] : ''
      );
    } else {
      fail(
        'LineSource.toSourceLine available',
        'window.MdxLineSource missing — load ui/line-source.js'
      );
    }

    if (LS && typeof LS.renderCodeSourceSurface === 'function') {
      var surf = LS.renderCodeSourceSurface(block);
      assert(
        typeof surf === 'string' &&
          surf.indexOf('```') >= 0 &&
          surf.indexOf('mdx-code-source') >= 0,
        'renderCodeSourceSurface is fence single surface',
        surf ? surf.slice(0, 140) : ''
      );
    }

    // --- parse fence roundtrip lang + text ---
    if (!P || typeof P.parse !== 'function') {
      fail('MdxParse available', 'window.MdxParse missing — load parse.js');
    } else {
      pass('MdxParse available');

      var md =
        '```js\n' +
        "const x = 1;\nconsole.log('hi');\n" +
        '```';
      var docObj = P.parse(md);
      var blocks = docObj && docObj.blocks ? docObj.blocks : [];
      var codeBlk = null;
      for (var i = 0; i < blocks.length; i++) {
        if (blocks[i] && blocks[i].type === 'code') {
          codeBlk = blocks[i];
          break;
        }
      }
      assert(!!codeBlk, 'parse fence → code block', 'blocks=' + blocks.length);
      if (codeBlk) {
        assert(
          (codeBlk.lang || '') === 'js',
          'parse fence lang === js',
          'lang=' + j(codeBlk.lang)
        );
        assert(
          String(codeBlk.text || '').indexOf('const x = 1') >= 0 &&
            String(codeBlk.text || '').indexOf("console.log('hi')") >= 0,
          'parse fence text preserves body',
          j(codeBlk.text)
        );
      }

      // LineSource parseSourceLine fence roundtrip
      if (LS && typeof LS.parseSourceLine === 'function' && typeof LS.toSourceLine === 'function') {
        var src = LS.toSourceLine({
          type: 'code',
          lang: 'python',
          text: 'print(1)',
        });
        var parsed = LS.parseSourceLine(src);
        assert(
          parsed &&
            parsed.type === 'code' &&
            (parsed.lang || '') === 'python' &&
            String(parsed.text || '').replace(/\n$/, '') === 'print(1)',
          'parseSourceLine fence roundtrip lang+text',
          parsed ? j(parsed) : 'null'
        );
      }

      // serialize roundtrip when available
      if (S && typeof S.serialize === 'function' && codeBlk) {
        var out = S.serialize(docObj);
        assert(
          typeof out === 'string' &&
            out.indexOf('```js') >= 0 &&
            out.indexOf('const x = 1') >= 0,
          'serialize fence roundtrip keeps lang+text',
          out ? out.slice(0, 80) : ''
        );
      }
    }
  }

  function startsWithFence(s, lang) {
    var first = String(s || '').split('\n')[0] || '';
    return first.indexOf('```') === 0 && (!lang || first.indexOf(lang) >= 0);
  }

  /** DOM tests when document + mount exist */
  function runDom() {
    var d = doc();
    if (!d) {
      fail('DOM available', 'no document — skip DOM tests');
      return;
    }

    var Code = BlocksCode();
    if (Code && typeof Code.readHtml === 'function') {
      var wrap = d.createElement('div');
      wrap.innerHTML = Code.readHtml(sampleCodeBlock());
      var card = wrap.querySelector('.mdx-code-card, [data-mdx-code-card]');
      var tok = wrap.querySelector('[class*="mdx-tok"]');
      var codeEl = wrap.querySelector('code');
      var copyBtn = wrap.querySelector('[data-mdx-code-copy]');
      assert(
        !!card,
        'DOM readHtml mounts .mdx-code-card',
        card ? card.className : 'missing'
      );
      assert(
        !!tok ||
          (codeEl &&
            (codeEl.className.indexOf('language-') >= 0 ||
              codeEl.innerHTML.indexOf('mdx-tok') >= 0)),
        'DOM readHtml has mdx-tok or language class',
        tok
          ? tok.className
          : codeEl
            ? codeEl.className + ' / ' + codeEl.innerHTML.slice(0, 60)
            : 'no code'
      );
      assert(!!copyBtn, 'DOM readHtml has copy button', copyBtn ? 'ok' : 'missing');

      // C-R21：DOM 行号 gutter 存在且与逻辑行一致
      var gutter = wrap.querySelector('.mdx-code-gutter');
      var gutterNs = wrap.querySelectorAll('.mdx-code-gutter__n');
      assert(!!gutter, 'DOM readHtml has mdx-code-gutter', gutter ? 'ok' : 'missing');
      assert(
        gutterNs && gutterNs.length === 2,
        'DOM gutter has 2 line numbers for sample',
        gutterNs ? 'count=' + gutterNs.length : 'missing'
      );
      // 复制路径：bodyTextFromCard 只取 code 节点，不含行号数字列
      var Chrome = root.MdxCodeChrome || (root.window && root.window.MdxCodeChrome);
      if (Chrome && typeof Chrome.bodyTextFromCard === 'function' && card) {
        var copied = Chrome.bodyTextFromCard(card);
        var pure =
          String(copied).indexOf('const x = 1') >= 0 &&
          String(copied).indexOf("console.log('hi')") >= 0 &&
          // 首行应是代码，不是孤立行号 "1"
          !/^\s*1\s*$/.test(String(copied).split('\n')[0] || '') &&
          // 不应出现 "1const" 粘连或行号夹在行首
          !/^\d+\s*const/.test(String(copied));
        assert(
          pure,
          'DOM bodyTextFromCard is pure code body (no gutter)',
          copied ? copied.slice(0, 80) : ''
        );
      }
    }

    var CodeEditDom = BlocksCodeEdit();
    if (CodeEditDom && typeof CodeEditDom.mountSource === 'function') {
      var mountHost = d.createElement('div');
      var handle = CodeEditDom.mountSource(mountHost, sampleCodeBlock(), {});
      var pre =
        (handle && handle.pre) ||
        mountHost.querySelector('[data-mdx-code-source], .mdx-code-source-pre');
      var text = pre
        ? pre.innerText != null
          ? pre.innerText
          : pre.textContent || ''
        : '';
      assert(!!pre, 'DOM mountSource creates editable pre', pre ? pre.className : 'missing');
      assert(
        text.indexOf('```') >= 0,
        'DOM mountSource shows full fence source',
        text.slice(0, 60)
      );
      assert(
        mountHost.querySelectorAll('textarea').length === 0,
        'DOM mountSource has no textarea',
        'count=' + mountHost.querySelectorAll('textarea').length
      );
      if (typeof CodeEditDom.parseSource === 'function' && pre) {
        var parsed = CodeEditDom.parseSource(pre);
        assert(
          parsed &&
            String(parsed.text || '').indexOf('const x = 1') >= 0 &&
            (parsed.lang || '') === 'js',
          'DOM parseSource recovers lang+body',
          parsed ? JSON.stringify(parsed) : 'null'
        );
      }
      if (typeof CodeEditDom.destroy === 'function') {
        CodeEditDom.destroy(mountHost);
        pass('DOM CodeEdit.destroy runs', 'ok');
      }
    }

    // Optional: live mount with one code block (if harness page provides host or we create one)
    var ME = EditorAPI();
    var host = d.getElementById('editorHost') || d.querySelector('[data-mdx-w2-host]');
    if (ME && typeof ME.mount === 'function' && host) {
      // Prefer inspecting already-mounted sample from the HTML page
      var liveCard =
        host.querySelector('.mdx-code-card, [data-mdx-code-card], .mdx-block--code, [data-block-type="code"]') ||
        host.querySelector('pre.mdx-pre, code.language-js, code[class*="language-"]');
      assert(
        !!liveCard,
        'DOM editor mount shows one code block surface',
        liveCard
          ? liveCard.className || liveCard.tagName
          : 'no code surface under #editorHost'
      );

      // Single surface: at most one dual-shell smell (no simultaneous visible textarea + pre highlight siblings as dual shells)
      var dual =
        host.querySelectorAll('.mdx-code-card textarea, .mdx-code textarea').length > 0 &&
        host.querySelectorAll('.mdx-code-card pre, .mdx-code pre').length > 0;
      // Dual shell would be both an edit textarea AND a highlight pre inside the same card at once.
      // Read mode only has pre — that is OK. Fail only if both present under same card.
      var cards = host.querySelectorAll('.mdx-code-card, [data-mdx-code-card]');
      var dualShell = false;
      for (var c = 0; c < cards.length; c++) {
        var hasTa = cards[c].querySelector('textarea');
        var hasPre = cards[c].querySelector('pre');
        if (hasTa && hasPre) {
          dualShell = true;
          break;
        }
      }
      assert(
        !dualShell,
        'DOM no dual-shell (textarea+pre) on code card',
        dualShell ? 'found textarea + pre together' : 'single surface ok'
      );
      // silence unused
      void dual;
    } else if (!host) {
      pass(
        'DOM editor mount skipped',
        'no #editorHost — pure + fragment DOM only (ok)'
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
      'W2 code-surface harness: ' +
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
    summary.className = 'w2-harness-summary ' + (report.ok ? 'is-pass' : 'is-fail');
    summary.textContent =
      (report.ok ? 'ALL PASS' : 'SOME FAILED') +
      ' — ' +
      report.passed +
      ' passed / ' +
      report.failed +
      ' failed';

    var list = d.createElement('ul');
    list.className = 'w2-harness-list';
    for (var i = 0; i < report.results.length; i++) {
      var r = report.results[i];
      var li = d.createElement('li');
      li.className = r.ok ? 'w2-pass' : 'w2-fail';
      var badge = d.createElement('span');
      badge.className = 'w2-badge';
      badge.textContent = r.ok ? 'PASS' : 'FAIL';
      var name = d.createElement('span');
      name.className = 'w2-name';
      name.textContent = r.name;
      li.appendChild(badge);
      li.appendChild(name);
      if (r.detail) {
        var det = d.createElement('span');
        det.className = 'w2-detail';
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

  root.MdxW2Harness = api;
  if (root.window) root.window.MdxW2Harness = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
