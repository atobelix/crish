/**
 * W7 acceptance harness — Math + Mermaid P1
 *
 * Pure unit tests (no DOM required for most).
 * Optional DOM: editor mount when MarkdownEditor + document exist.
 *
 * Usage:
 *   Browser console:
 *     var r = window.MdxW7Harness.runAll(); console.table(r.results);
 *   HTML page markdown-editor-w7-test.html auto-runs.
 *   Pure-only: runAll({ skipDom: true }).
 *
 * Coverage:
 *   - ```mermaid parse → code+lang=mermaid
 *   - type=math parse $$…$$ + serialize roundtrip
 *   - MdxBlocksMermaid.readHtml / sourceHtml
 *   - MdxBlocksMath.readHtml / sourceHtml / parseSource
 *   - inline $...$ via MdxUtil.inlineHtml (safe currency)
 *   - degraded: no mermaid/katex → clean fallback (no essay CTA)
 */
(function (root) {
  'use strict';

  var results = [];

  function g(name) {
    return root[name] || (root.window && root.window[name]) || null;
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

  function skip(name, detail) {
    results.push({ name: name, ok: true, detail: 'SKIP: ' + (detail || '') });
  }

  function sampleMermaidMd() {
    return '```mermaid\ngraph LR\n  A --> B\n```\n';
  }

  function sampleMathMd() {
    return '$$\nE = mc^2\n$$\n';
  }

  function testParseMermaid() {
    var Parse = g('MdxParse');
    if (!Parse) {
      fail('parse-mermaid', 'MdxParse missing');
      return;
    }
    var doc = Parse.parse(sampleMermaidMd());
    var b = doc && doc.blocks && doc.blocks[0];
    assert(!!b, 'parse-mermaid-block', 'no block');
    assert(b && b.type === 'code', 'parse-mermaid-type-code', 'type=' + (b && b.type));
    assert(b && String(b.lang).toLowerCase() === 'mermaid', 'parse-mermaid-lang', 'lang=' + (b && b.lang));
    assert(b && /A\s*-->\s*B/.test(b.text || ''), 'parse-mermaid-body', b && b.text);
  }

  function testParseMath() {
    var Parse = g('MdxParse');
    if (!Parse) {
      fail('parse-math', 'MdxParse missing');
      return;
    }
    var doc = Parse.parse(sampleMathMd());
    var b = doc && doc.blocks && doc.blocks[0];
    assert(!!b && b.type === 'math', 'parse-math-type', b && b.type);
    assert(b && /E\s*=\s*mc\^2/.test(b.text || ''), 'parse-math-body', b && b.text);

    var single = Parse.parse('$$a+b$$\n');
    var s0 = single.blocks && single.blocks[0];
    assert(s0 && s0.type === 'math' && s0.text === 'a+b', 'parse-math-single-line', s0 && s0.text);
  }

  function testSerializeRoundtrip() {
    var Parse = g('MdxParse');
    var Ser = g('MdxSerialize');
    if (!Parse || !Ser) {
      fail('roundtrip', 'Parse/Serialize missing');
      return;
    }
    var md =
      sampleMermaidMd() +
      '\n' +
      sampleMathMd() +
      '\npara with $x_1$\n';
    var doc = Parse.parse(md);
    var out = Ser.serialize(doc);
    assert(/```mermaid/.test(out), 'ser-mermaid-fence', out.slice(0, 80));
    assert(/\$\$/.test(out), 'ser-math-dollars', out);
    var doc2 = Parse.parse(out);
    var types = (doc2.blocks || []).map(function (b) {
      return b.type + (b.lang ? ':' + b.lang : '');
    });
    assert(
      types.some(function (t) {
        return t === 'code:mermaid';
      }),
      'roundtrip-mermaid',
      types.join(',')
    );
    assert(
      types.some(function (t) {
        return t === 'math';
      }),
      'roundtrip-math',
      types.join(',')
    );
  }

  function testMermaidModule() {
    var M = g('MdxBlocksMermaid');
    if (!M) {
      fail('MdxBlocksMermaid', 'module missing');
      return;
    }
    var block = { type: 'code', lang: 'mermaid', text: 'graph TD\n  X-->Y' };
    assert(M.isMermaidBlock(block), 'isMermaidBlock-code-lang');
    assert(M.isMermaidBlock({ type: 'mermaid', text: 'graph TD' }), 'isMermaidBlock-type');
    assert(!M.isMermaidBlock({ type: 'code', lang: 'js', text: 'x' }), 'isMermaidBlock-negative');

    var read = M.readHtml(block);
    assert(/mdx-mermaid/.test(read), 'mermaid-readHtml-shell', read.slice(0, 120));
    assert(/mdx-mermaid-fallback/.test(read), 'mermaid-readHtml-fallback-class');
    assert(!/click to render/i.test(read), 'mermaid-no-cta-essay');
    assert(read.indexOf('graph TD') >= 0 || read.indexOf('X--&gt;Y') >= 0 || read.indexOf('X--&gt;') >= 0 || /X.*Y/.test(read), 'mermaid-readHtml-source', read);

    var src = M.sourceHtml(block);
    assert(/```mermaid/.test(src) || /```mermaid/.test(src.replace(/&/g, '')), 'mermaid-sourceHtml-fence');
    // source is escaped in HTML
    assert(/data-mdx-code-source|mdx-code-source-pre/.test(src), 'mermaid-source-surface');
  }

  function testMathModule() {
    var M = g('MdxBlocksMath');
    if (!M) {
      fail('MdxBlocksMath', 'module missing');
      return;
    }
    var block = { type: 'math', text: 'E=mc^2' };
    var read = M.readHtml(block);
    assert(/mdx-math/.test(read), 'math-readHtml-shell');
    // with or without katex
    var hasKatex = !!(g('katex') && g('katex').renderToString);
    if (hasKatex) {
      assert(/katex|mathjax|mdx-math__render/.test(read), 'math-read-katex-or-render', read.slice(0, 200));
    } else {
      assert(/mdx-math-fallback|E=mc/.test(read), 'math-read-fallback', read.slice(0, 200));
    }

    var src = M.sourceHtml(block);
    assert(/\$\$/.test(src) || /\$\$/.test(src.replace(/&#36;/g, '$')), 'math-sourceHtml-dollars');
    assert(/data-mdx-math-source|mdx-math-source-pre/.test(src), 'math-source-surface');

    // parseSource from fake pre
    var d = g('document');
    if (d && d.createElement) {
      var pre = d.createElement('pre');
      pre.textContent = '$$\na+b\n$$';
      var p = M.parseSource(pre);
      assert(p && p.text === 'a+b', 'math-parseSource', p && p.text);
    } else {
      skip('math-parseSource', 'no document');
    }
  }

  function testInlineMath() {
    var U = g('MdxUtil');
    if (!U || !U.inlineHtml) {
      fail('inline-math', 'MdxUtil.inlineHtml missing');
      return;
    }
    var html = U.inlineHtml('energy $E=mc^2$ ok');
    assert(/mdx-math-inline|mdx-math-fallback|katex/.test(html), 'inline-math-render', html);

    // currency: open $ followed by space or digit-ish ambiguous — our rule requires no space after $
    var money = U.inlineHtml('价格 $3 到 $5');
    // Should NOT wrap both as math (closing needs non-space before $); $3 到 $5 has space after digits before $
    // Pattern: $3 到 $5 — opening $ then 3 (ok) but closing would need $ after non-space; "5" then end without close for first...
    // Actually `$3 到 $5` : first $ opens, body "3 到 " has spaces - rejected by our rule (no space at edges of body).
    // Second lone $5 may not close. Expect no false positive mdx-math-inline or at most none spanning.
    var mathCount = (money.match(/mdx-math-inline/g) || []).length;
    assert(mathCount === 0, 'inline-currency-safe', 'count=' + mathCount + ' html=' + money);
  }

  function testRegistry() {
    var Reg = g('MdxRegistry');
    if (!Reg) {
      skip('registry', 'MdxRegistry missing');
      return;
    }
    var math = Reg.get('math');
    var mmd = Reg.get('mermaid');
    assert(!!math, 'registry-math');
    assert(!!mmd, 'registry-mermaid');
  }

  function testDomOptional(opts) {
    if (opts && opts.skipDom) {
      skip('dom-mount', 'skipDom');
      return;
    }
    var Editor = g('MarkdownEditor');
    var d = g('document');
    if (!Editor || !d || !d.createElement) {
      skip('dom-mount', 'no Editor/document');
      return;
    }
    var host = d.createElement('div');
    host.style.cssText = 'position:fixed;left:-9999px;width:400px;height:200px;';
    d.body.appendChild(host);
    try {
      var api = Editor.mount(host, {
        markdown: sampleMermaidMd() + '\n' + sampleMathMd(),
        viewOnly: true,
      });
      var root = host.querySelector('[data-mdx-root], .mdx-root');
      assert(!!root, 'dom-root');
      var mmdEl = host.querySelector('[data-mdx-mermaid], .mdx-mermaid');
      var mathEl = host.querySelector('[data-mdx-math], .mdx-math');
      assert(!!mmdEl, 'dom-mermaid-el');
      assert(!!mathEl, 'dom-math-el');
      if (api && api.destroy) api.destroy();
    } catch (e) {
      fail('dom-mount', String(e && e.message ? e.message : e));
    }
    try {
      d.body.removeChild(host);
    } catch (e2) {
      /* ignore */
    }
  }

  function runAll(opts) {
    results = [];
    testParseMermaid();
    testParseMath();
    testSerializeRoundtrip();
    testMermaidModule();
    testMathModule();
    testInlineMath();
    testRegistry();
    testDomOptional(opts || {});
    var failed = results.filter(function (r) {
      return !r.ok;
    }).length;
    return {
      ok: failed === 0,
      failed: failed,
      total: results.length,
      results: results,
    };
  }

  root.MdxW7Harness = {
    runAll: runAll,
    results: function () {
      return results.slice();
    },
  };
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
