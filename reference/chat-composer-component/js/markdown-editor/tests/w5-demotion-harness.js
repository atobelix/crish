/**
 * W5 acceptance harness — demotion ladder + promote + soft-edit surface
 *
 * Pure unit tests for MdxDemotion.simulateLadder / LADDER_GOLD + MdxPromote.
 * Soft surface string checks（无 mdx-full-src）+ optional DOM 往返。
 *
 * Usage:
 *   Browser: MdxW5Harness.runAll() / markdown-editor-w5-test.html
 *   Pure:    MdxW5Harness.runAll({ skipDom: true })
 *
 * Coverage (F-CORE-04 / F-CORE-05 + soft-edit P0):
 *   - simulateLadder H1–H3 / bullet / ordered / task / quote / callout
 *   - empty paragraph first/sole → noop；else merge-prev
 *   - nonempty caret0 → merge-prev with text patch
 *   - tryPromoteFromParagraph: * # > 1. - [ ] 需空格
 *   - soft mark · + fixed width class in renderEditSurface
 *   - renderSoftEditSurface：heading/list/callout 非 monospaced full-src
 *   - callout soft 保持 mdx-callout / [! 结构
 *   - readFromLineEdit soft DOM 往返（DOM 可用时）
 */
(function (root) {
  'use strict';

  var results = [];

  function Demotion() {
    return root.MdxDemotion || (root.window && root.window.MdxDemotion) || null;
  }

  function Promote() {
    return root.MdxPromote || (root.window && root.window.MdxPromote) || null;
  }

  function LineSrc() {
    return root.MdxLineSource || (root.window && root.window.MdxLineSource) || null;
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

  function actionsOf(ladder) {
    return (ladder || []).map(function (s) {
      return s.action;
    });
  }

  function prefixMatch(actual, expected) {
    if (!actual || actual.length < expected.length) return false;
    for (var i = 0; i < expected.length; i++) {
      if (actual[i] !== expected[i]) return false;
    }
    return true;
  }

  /** Pure tests */
  function runPure() {
    var DM = Demotion();
    var PM = Promote();
    var LS = LineSrc();

    if (!DM || typeof DM.demoteStep !== 'function') {
      fail('MdxDemotion available', 'load edit/demotion.js');
      return;
    }
    pass('MdxDemotion available');

    assert(
      typeof DM.simulateLadder === 'function',
      'simulateLadder available'
    );

    // --- LADDER_GOLD table ---
    if (DM.LADDER_GOLD && DM.LADDER_GOLD.length) {
      pass('LADDER_GOLD present', DM.LADDER_GOLD.length + ' entries');
      for (var g = 0; g < DM.LADDER_GOLD.length; g++) {
        var entry = DM.LADDER_GOLD[g];
        var match =
          typeof DM.matchGoldEntry === 'function'
            ? DM.matchGoldEntry(entry)
            : null;
        if (match) {
          assert(
            match.ok,
            'gold[' + entry.id + '] ' + (entry.note || ''),
            match.ok
              ? match.actual.join(' → ')
              : 'expected ' +
                  match.expected.join(' → ') +
                  ' got ' +
                  match.actual.join(' → ')
          );
        } else {
          var lad = DM.simulateLadder(entry.block, 10, entry.baseCtx || null);
          var acts = actionsOf(lad);
          assert(
            prefixMatch(acts, entry.steps),
            'gold[' + entry.id + '] ladder',
            acts.join(' → ')
          );
        }
      }
    } else {
      fail('LADDER_GOLD present', 'missing export');
    }

    // --- explicit simulateLadder cases (W5) ---
    // demote-heading 恢复 gap，故级间穿插 strip-gap（与 LADDER_GOLD / DOM applyDemoteVisual 一致）
    var h3 = actionsOf(DM.simulateLadder({ type: 'heading', level: 3, text: '' }, 10));
    assert(
      prefixMatch(h3, [
        'strip-gap',
        'demote-heading',
        'strip-gap',
        'demote-heading',
        'strip-gap',
        'to-paragraph',
      ]),
      'simulateLadder H3 → gap → H2 → gap → H1 → gap → P',
      h3.join(' → ')
    );
    // demote-heading levels（跳过 strip-gap 步）
    var h3steps = DM.simulateLadder({ type: 'heading', level: 3, text: '' }, 10);
    var demoteLevels = [];
    for (var di = 0; di < h3steps.length; di++) {
      if (h3steps[di].action === 'demote-heading' && h3steps[di].patch) {
        demoteLevels.push(h3steps[di].patch.level);
      }
    }
    assert(
      demoteLevels.length >= 2 && demoteLevels[0] === 2 && demoteLevels[1] === 1,
      'H3 demote levels 2 then 1',
      j(demoteLevels)
    );

    var bullet = actionsOf(
      DM.simulateLadder({ type: 'bullet_item', text: '' }, 6)
    );
    assert(
      prefixMatch(bullet, ['strip-gap', 'strip-mark']) ||
        prefixMatch(bullet, ['strip-gap', 'to-paragraph']),
      'simulateLadder empty bullet → paragraph',
      bullet.join(' → ')
    );

    var ordered = actionsOf(
      DM.simulateLadder({ type: 'ordered_item', text: '' }, 6)
    );
    assert(
      prefixMatch(ordered, ['strip-gap', 'strip-mark']) ||
        prefixMatch(ordered, ['strip-gap', 'to-paragraph']),
      'simulateLadder empty ordered → paragraph',
      ordered.join(' → ')
    );

    var task = actionsOf(
      DM.simulateLadder({ type: 'task_item', text: '', checked: true }, 6)
    );
    assert(
      prefixMatch(task, ['strip-gap', 'strip-mark']) ||
        prefixMatch(task, ['strip-gap', 'to-paragraph']),
      'simulateLadder empty task → paragraph',
      task.join(' → ')
    );

    var quote = actionsOf(DM.simulateLadder({ type: 'quote', text: '' }, 6));
    assert(
      prefixMatch(quote, ['strip-gap', 'to-paragraph']) ||
        prefixMatch(quote, ['strip-gap', 'strip-mark']),
      'simulateLadder empty quote → paragraph',
      quote.join(' → ')
    );

    var calloutLad = actionsOf(
      DM.simulateLadder({ type: 'callout', text: '', callout: 'tip' }, 6)
    );
    assert(
      prefixMatch(calloutLad, ['strip-gap', 'to-paragraph']),
      'simulateLadder empty callout → paragraph',
      calloutLad.join(' → ')
    );

    // paragraph boundaries
    var pFirst = DM.demoteStep(
      { type: 'paragraph', text: '' },
      { isFirstBlock: true, caretOffset: 0 }
    );
    assert(
      pFirst && pFirst.action === 'noop',
      'empty paragraph at start → noop',
      j(pFirst)
    );

    var pSole = DM.demoteStep(
      { type: 'paragraph', text: '' },
      { soleBlock: true, caretOffset: 0 }
    );
    assert(pSole && pSole.action === 'noop', 'sole empty paragraph → noop', j(pSole));

    var pMerge = DM.demoteStep(
      { type: 'paragraph', text: '' },
      { isFirstBlock: false, soleBlock: false, caretOffset: 0 }
    );
    assert(
      pMerge && pMerge.action === 'merge-prev',
      'empty paragraph not first → merge-prev',
      j(pMerge)
    );

    // nonempty caret 0 → merge with text
    var nonEmptyMerge = DM.demoteStep(
      { type: 'paragraph', text: 'tail' },
      { isFirstBlock: false, caretOffset: 0 }
    );
    assert(
      nonEmptyMerge &&
        nonEmptyMerge.action === 'merge-prev' &&
        nonEmptyMerge.patch &&
        nonEmptyMerge.patch.text === 'tail',
      'nonempty caret0 → merge-prev with text',
      j(nonEmptyMerge)
    );

    var nonEmptyFirst = DM.demoteStep(
      { type: 'heading', level: 1, text: 'Hi' },
      { isFirstBlock: true, caretOffset: 0 }
    );
    assert(
      nonEmptyFirst && nonEmptyFirst.action === 'noop',
      'nonempty first block caret0 → noop',
      j(nonEmptyFirst)
    );

    // soft mark 不影响终点
    var softBullet = DM.demoteStep(
      { type: 'bullet_item', text: '' },
      { hasGap: false, markSoft: true, caretOffset: 0 }
    );
    assert(
      softBullet &&
        (softBullet.action === 'strip-mark' || softBullet.action === 'to-paragraph') &&
        softBullet.patch &&
        softBullet.patch.type === 'paragraph',
      'soft · empty bullet still → paragraph',
      j(softBullet)
    );

    // --- Promote ---
    var tryPromo =
      (PM && PM.tryPromoteFromParagraph) ||
      (LS && LS.tryPromoteFromParagraph) ||
      null;

    if (!tryPromo) {
      fail('tryPromoteFromParagraph available', 'load edit/promote.js or line-source');
    } else {
      pass('tryPromoteFromParagraph available', PM ? 'MdxPromote' : 'MdxLineSource');

      function promoType(s) {
        var p = tryPromo(s);
        return p && p.type;
      }

      assert(promoType('* item') === 'bullet_item', "promote '* item' → bullet", promoType('* item'));
      assert(promoType('- item') === 'bullet_item', "promote '- item' → bullet", promoType('- item'));
      assert(promoType('# Title') === 'heading', "promote '# Title' → heading", promoType('# Title'));
      assert(
        tryPromo('# Title') && tryPromo('# Title').level === 1,
        "promote '# Title' level 1",
        j(tryPromo('# Title'))
      );
      assert(
        tryPromo('## H') && tryPromo('## H').level === 2,
        "promote '## H' level 2",
        j(tryPromo('## H'))
      );
      assert(promoType('> hi') === 'quote', "promote '> hi' → quote", promoType('> hi'));
      assert(promoType('1. a') === 'ordered_item', "promote '1. a' → ordered", promoType('1. a'));
      assert(
        promoType('- [ ] todo') === 'task_item',
        "promote '- [ ] todo' → task",
        promoType('- [ ] todo')
      );
      assert(
        tryPromo('- [x] done') && tryPromo('- [x] done').checked === true,
        "promote '- [x] done' checked",
        j(tryPromo('- [x] done'))
      );

      // incomplete: no promote
      assert(tryPromo('*') == null, "promote '*' alone → null");
      assert(tryPromo('#') == null, "promote '#' alone → null");
      assert(tryPromo('#Title') == null, "promote '#Title' no space → null");
      assert(tryPromo('plain') == null, "promote 'plain' → null");
      assert(tryPromo('*item') == null, "promote '*item' no space → null", j(tryPromo('*item')));
    }

    // isBodyEmpty
    if (typeof DM.isBodyEmpty === 'function') {
      assert(DM.isBodyEmpty('') === true, 'isBodyEmpty empty');
      assert(DM.isBodyEmpty('  \n') === true, 'isBodyEmpty whitespace');
      assert(DM.isBodyEmpty('a') === false, 'isBodyEmpty text');
    }

    // --- Soft edit surface (string-level, no monospaced full-src) ---
    runSoftSurfacePure(LS);
  }

  /**
   * Soft surface 纯字符串断言：默认编辑路径 ≠ full-src dump
   */
  function runSoftSurfacePure(LS) {
    if (!LS) {
      fail('soft surface LineSource', 'missing MdxLineSource');
      return;
    }

    var softFn =
      typeof LS.renderSoftEditSurface === 'function'
        ? function (b, o) {
            return LS.renderSoftEditSurface(b, o);
          }
        : typeof LS.renderEditSurface === 'function'
          ? function (b, o) {
              return LS.renderEditSurface(b, o);
            }
          : null;

    if (!softFn) {
      fail('renderSoftEditSurface|renderEditSurface available', 'missing');
      return;
    }
    pass(
      'soft render available',
      typeof LS.renderSoftEditSurface === 'function'
        ? 'renderSoftEditSurface'
        : 'renderEditSurface fallback'
    );

    function isFullSrc(html) {
      return (
        html.indexOf('mdx-full-src') >= 0 ||
        html.indexOf('data-mdx-full-src') >= 0 ||
        html.indexOf('data-mdx-full-src-edit') >= 0
      );
    }

    // heading
    var hHtml = softFn(
      { type: 'heading', level: 2, text: '**Title**' },
      { softListMark: true }
    );
    assert(!isFullSrc(hHtml), 'soft heading: no mdx-full-src', hHtml.slice(0, 120));
    assert(
      hHtml.indexOf('mdx-src-mark--heading') >= 0 || hHtml.indexOf('data-kind="heading"') >= 0,
      'soft heading: has structure mark',
      hHtml.slice(0, 160)
    );
    assert(
      hHtml.indexOf('mdx-h2') >= 0 || hHtml.indexOf('mdx-h') >= 0,
      'soft heading: keeps h sizing class',
      hHtml.slice(0, 120)
    );
    assert(
      hHtml.indexOf('data-mdx-edit') >= 0 && hHtml.indexOf('mdx-src-body') >= 0,
      'soft heading: body editable (not full-src box)',
      hHtml.slice(0, 160)
    );

    // bullet list soft ·
    var bHtml = softFn(
      { type: 'bullet_item', text: 'item' },
      { softListMark: true }
    );
    assert(!isFullSrc(bHtml), 'soft bullet: no mdx-full-src', bHtml.slice(0, 120));
    assert(
      bHtml.indexOf('mdx-src-mark--bullet') >= 0,
      'soft bullet: mdx-src-mark--bullet',
      bHtml.slice(0, 160)
    );
    assert(
      bHtml.indexOf('·') >= 0 || /&#183;|&middot;/.test(bHtml),
      'soft bullet: shows ·',
      bHtml.slice(0, 160)
    );
    assert(
      bHtml.indexOf('data-block-type="bullet_item"') >= 0 ||
        bHtml.indexOf("data-block-type='bullet_item'") >= 0,
      'soft bullet: data-block-type bullet_item',
      bHtml.slice(0, 120)
    );

    // callout card shell
    var cHtml = softFn(
      {
        type: 'callout',
        callout: 'tip',
        text: '**注意**\nbody line',
      },
      { softListMark: true }
    );
    assert(!isFullSrc(cHtml), 'soft callout: no mdx-full-src', cHtml.slice(0, 140));
    assert(
      cHtml.indexOf('mdx-callout') >= 0,
      'soft callout: keeps mdx-callout card class',
      cHtml.slice(0, 160)
    );
    assert(
      cHtml.indexOf('mdx-callout--tip') >= 0 || cHtml.indexOf('data-callout="tip"') >= 0,
      'soft callout: kind tip class/attr',
      cHtml.slice(0, 160)
    );
    assert(
      cHtml.indexOf('[!') >= 0 || cHtml.indexOf('mdx-src-mark--callout') >= 0,
      'soft callout: [! / callout mark structure',
      cHtml.slice(0, 200)
    );
    // 禁止整行 GFM dump 作为唯一内容（允许 mark 显示 [!TIP]，但不应是 > [!TIP] 整行 full-src）
    assert(
      cHtml.indexOf('&gt; [!') < 0 && cHtml.indexOf('> [!') < 0,
      'soft callout: not full-line > [! dump',
      cHtml.slice(0, 200)
    );
    // 多行：title-body 分区；单行：body-only + 中文 label
    assert(
      cHtml.indexOf('data-callout-mode="title-body"') >= 0 ||
        cHtml.indexOf('data-mdx-callout-part="title"') >= 0,
      'soft multi-line callout: title-body parts',
      cHtml.slice(0, 220)
    );
    var cSingle = softFn(
      { type: 'callout', callout: 'note', text: '**页面壳**' },
      { softListMark: true }
    );
    assert(
      cSingle.indexOf('data-callout-mode="body-only"') >= 0,
      'soft single-line callout: body-only mode',
      cSingle.slice(0, 200)
    );
    assert(
      cSingle.indexOf('注意') >= 0 || cSingle.indexOf('mdx-callout__label') >= 0,
      'soft single-line callout: Chinese label',
      cSingle.slice(0, 200)
    );
    assert(
      cSingle.indexOf('[!NOTE]') >= 0 || cSingle.indexOf('[! NOTE]') < 0,
      'soft callout: GFM [!NOTE] without space',
      cSingle.slice(0, 200)
    );

    // contrast: full source surface MUST carry mdx-full-src when available
    if (typeof LS.renderFullSourceSurface === 'function') {
      var fullH = LS.renderFullSourceSurface({
        type: 'heading',
        level: 2,
        text: 'Title',
      });
      assert(
        isFullSrc(fullH),
        'fullSource heading: has mdx-full-src (debug path)',
        fullH.slice(0, 120)
      );
      var fullC = LS.renderFullSourceSurface({
        type: 'callout',
        callout: 'note',
        text: 't',
      });
      assert(
        isFullSrc(fullC) || fullC.indexOf('[!NOTE]') >= 0 || fullC.indexOf('&gt;') >= 0,
        'fullSource callout: monospaced/src dump path',
        fullC.slice(0, 140)
      );
    } else {
      pass('renderFullSourceSurface optional', 'skip contrast');
    }

    // parseSourceLine pure roundtrip samples (soft 不依赖 full line，但结构解析仍应稳)
    if (typeof LS.parseSourceLine === 'function') {
      var pH = LS.parseSourceLine('## Soft');
      assert(
        pH && pH.type === 'heading' && pH.level === 2 && pH.text === 'Soft',
        "parseSourceLine('## Soft') roundtrip fields",
        j(pH)
      );
      var pC = LS.parseSourceLine('> [!TIP] Hello');
      assert(
        pC && pC.type === 'callout' && pC.callout === 'tip',
        "parseSourceLine('> [!TIP] Hello') → callout tip",
        j(pC)
      );
      var pB = LS.parseSourceLine('* list');
      assert(
        pB && pB.type === 'bullet_item' && pB.text === 'list',
        "parseSourceLine('* list') → bullet",
        j(pB)
      );
    }
  }

  function runDom() {
    var LS = LineSrc();
    var d = doc();
    if (!d) {
      fail('DOM available', 'no document');
      return;
    }
    if (!LS || typeof LS.renderEditSurface !== 'function') {
      fail('renderEditSurface available', 'missing');
      return;
    }

    var softFn =
      typeof LS.renderSoftEditSurface === 'function'
        ? function (b, o) {
            return LS.renderSoftEditSurface(b, o);
          }
        : function (b, o) {
            return LS.renderEditSurface(b, o);
          };

    var html = softFn(
      { type: 'bullet_item', text: 'x' },
      { softListMark: true }
    );
    assert(
      html.indexOf('mdx-src-mark--bullet') >= 0,
      'bullet surface has mdx-src-mark--bullet',
      html.slice(0, 180)
    );
    assert(
      html.indexOf('·') >= 0 || /&#183;|&middot;/.test(html),
      'soft mark shows ·',
      html.slice(0, 200)
    );
    assert(
      html.indexOf('data-src="*"') >= 0 || html.indexOf("data-src='*'") >= 0,
      'soft mark keeps data-src=*',
      html.slice(0, 200)
    );
    assert(
      html.indexOf('mdx-full-src') < 0,
      'DOM soft bullet: still no mdx-full-src',
      html.slice(0, 100)
    );

    // mount into DOM to check computed slot width stability classes
    var wrap = d.createElement('div');
    wrap.style.cssText = 'position:absolute;left:-9999px;top:0;';
    wrap.innerHTML = html;
    d.body.appendChild(wrap);
    var mark = wrap.querySelector('.mdx-src-mark--bullet');
    assert(!!mark, 'bullet mark element in DOM');
    if (mark) {
      var softW = mark.getBoundingClientRect().width;
      if (LS.showBulletMarkHard) LS.showBulletMarkHard(mark);
      else {
        mark.textContent = '*';
        mark.classList.add('is-source-visible');
      }
      var hardW = mark.getBoundingClientRect().width;
      // 固定槽：宽差应极小（容差 2px；无样式表时可能同为 0）
      var delta = Math.abs(softW - hardW);
      assert(
        delta <= 2 || softW === 0,
        'bullet mark slot width stable ·↔* (Δ≤2px)',
        'soft=' + softW.toFixed(2) + ' hard=' + hardW.toFixed(2) + ' Δ=' + delta.toFixed(2)
      );
      if (LS.showBulletMarkSoft) LS.showBulletMarkSoft(mark);
    }
    if (wrap.parentNode) wrap.parentNode.removeChild(wrap);

    // --- soft DOM 往返：renderSoft → mount → readFromLineEdit ---
    if (typeof LS.readFromLineEdit === 'function') {
      function roundtrip(block, name) {
        var sHtml = softFn(block, { softListMark: true });
        var host = d.createElement('div');
        host.style.cssText = 'position:absolute;left:-9999px;top:0;';
        host.innerHTML = sHtml;
        d.body.appendChild(host);
        var lineRoot = host.querySelector('[data-mdx-line-edit]');
        assert(!!lineRoot, name + ': mounted line-root');
        var patch = lineRoot ? LS.readFromLineEdit(lineRoot) : null;
        if (host.parentNode) host.parentNode.removeChild(host);
        return patch;
      }

      var rh = roundtrip({ type: 'heading', level: 3, text: 'Head' }, 'heading RT');
      assert(
        rh && rh.type === 'heading' && rh.level === 3 && rh.text === 'Head',
        'readFromLineEdit soft heading roundtrip',
        j(rh)
      );

      var rb = roundtrip({ type: 'bullet_item', text: 'li' }, 'bullet RT');
      assert(
        rb && rb.type === 'bullet_item' && rb.text === 'li',
        'readFromLineEdit soft bullet roundtrip',
        j(rb)
      );

      var rc = roundtrip(
        { type: 'callout', callout: 'warning', text: 'Warn title' },
        'callout RT'
      );
      assert(
        rc && rc.type === 'callout' && rc.callout === 'warning',
        'readFromLineEdit soft callout type/kind',
        j(rc)
      );
      assert(
        rc && String(rc.text || '').indexOf('Warn title') >= 0,
        'readFromLineEdit soft callout text',
        j(rc)
      );
    } else {
      fail('readFromLineEdit available', 'missing for soft DOM RT');
    }

    // callout soft DOM structure classes
    var cHost = d.createElement('div');
    cHost.style.cssText = 'position:absolute;left:-9999px;top:0;';
    cHost.innerHTML = softFn(
      { type: 'callout', callout: 'note', text: 'N' },
      { softListMark: true }
    );
    d.body.appendChild(cHost);
    assert(
      !!cHost.querySelector('.mdx-callout') ||
        !!cHost.querySelector('[data-block-type="callout"]'),
      'DOM soft callout: card/root present'
    );
    assert(
      !!cHost.querySelector('.mdx-src-mark--callout') ||
        !!(cHost.querySelector('[data-mdx-mark]') &&
          (cHost.querySelector('[data-mdx-mark]').textContent || '').indexOf('[!') >= 0),
      'DOM soft callout: [! mark structure'
    );
    assert(
      !cHost.querySelector('[data-mdx-full-src]') &&
        !cHost.querySelector('.mdx-full-src'),
      'DOM soft callout: no full-src nodes'
    );
    if (cHost.parentNode) cHost.parentNode.removeChild(cHost);

    // promote module optional note in DOM path
    if (Promote()) pass('MdxPromote loaded in page');
    else pass('MdxPromote optional (LineSource fallback)');
  }

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
      ladderTable: (Demotion() && Demotion().LADDER_GOLD) || [],
    };
  }

  function formatReport(report) {
    report = report || runAll();
    var lines = [];
    lines.push(
      'W5 demotion/promote harness: ' +
        (report.ok ? 'ALL PASS' : 'FAIL') +
        ' (' +
        report.passed +
        ' passed, ' +
        report.failed +
        ' failed)'
    );
    lines.push('');
    lines.push('--- Ladder gold table ---');
    var table = report.ladderTable || [];
    for (var t = 0; t < table.length; t++) {
      var e = table[t];
      lines.push(
        e.id +
          ': ' +
          (e.steps || []).join(' → ') +
          (e.note ? '  // ' + e.note : '')
      );
    }
    lines.push('');
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

  function renderTo(hostEl, opts) {
    var report = runAll(opts);
    if (!hostEl) return report;
    var d = doc();

    var summary = d.createElement('div');
    summary.className = 'w5-harness-summary ' + (report.ok ? 'is-pass' : 'is-fail');
    summary.textContent =
      (report.ok ? 'ALL PASS' : 'SOME FAILED') +
      ' — ' +
      report.passed +
      ' passed / ' +
      report.failed +
      ' failed';

    var ladderTitle = d.createElement('h3');
    ladderTitle.className = 'w5-ladder-title';
    ladderTitle.textContent = 'Demotion ladder (gold)';

    var ladderPre = d.createElement('pre');
    ladderPre.className = 'w5-ladder-table';
    var lt = report.ladderTable || [];
    var ltLines = [];
    for (var i = 0; i < lt.length; i++) {
      ltLines.push(
        (lt[i].id || '') +
          '\t' +
          (lt[i].steps || []).join(' → ') +
          (lt[i].note ? '\t' + lt[i].note : '')
      );
    }
    ladderPre.textContent = ltLines.join('\n');

    var list = d.createElement('ul');
    list.className = 'w5-harness-list';
    for (var j = 0; j < report.results.length; j++) {
      var r = report.results[j];
      var li = d.createElement('li');
      li.className = r.ok ? 'w5-pass' : 'w5-fail';
      var badge = d.createElement('span');
      badge.className = 'w5-badge';
      badge.textContent = r.ok ? 'PASS' : 'FAIL';
      var name = d.createElement('span');
      name.className = 'w5-name';
      name.textContent = r.name;
      li.appendChild(badge);
      li.appendChild(name);
      if (r.detail) {
        var det = d.createElement('span');
        det.className = 'w5-detail';
        det.textContent = r.detail;
        li.appendChild(det);
      }
      list.appendChild(li);
    }

    hostEl.innerHTML = '';
    hostEl.appendChild(summary);
    hostEl.appendChild(ladderTitle);
    hostEl.appendChild(ladderPre);
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

  root.MdxW5Harness = api;
  if (root.window) root.window.MdxW5Harness = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
