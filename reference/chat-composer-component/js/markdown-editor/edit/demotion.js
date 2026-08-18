/**
 * markdown-editor/edit/demotion.js
 * F-CORE-04：Backspace 降级阶梯 — 纯函数，无 DOM 依赖。
 *
 * 全局阶梯（§2.6 / F-CORE-04 gold）：
 *   1) body 非空且 caret>0     → delete-char（交给浏览器）
 *   2) body 非空且 caret==0    → merge-prev（首块 noop）
 *   3) body 空且有 gap         → strip-gap（删标记与正文间空格，标记「将死」）
 *   4) body 空且无 gap + 有结构 → demote-heading / strip-mark / to-paragraph
 *   5) 已是 paragraph 且空     → merge-prev（非首块）
 *   6) 文档首块 / 唯一空段落   → noop
 *
 * 标题特则：空 body 连续 Backspace → strip-gap → level-1（##→#）→ H1→paragraph
 * 列表/任务/引用：空 body → strip-gap → 去标记变 paragraph（soft · 同 hard 结构）
 * 绝不在「结构化空块」第一次空 Backspace 时直接删整块（除非已是空 paragraph → merge-prev）
 *
 * Composition：本模块不感知 IME；宿主在 composition 期间不得调用 demoteStep
 * （editor.js / MdxImeGuard 已挡 demote/promote）。
 *
 * API:
 *   MdxDemotion.isBodyEmpty(text) → boolean
 *   MdxDemotion.demoteStep(block, ctx?) → { action, patch?, note? }
 *   MdxDemotion.simulateLadder(block, n?, baseCtx?) → steps[]
 *   MdxDemotion.LADDER_GOLD → 文档化期望阶梯表
 */
(function () {
  'use strict';

  var STRUCTURED = {
    heading: true,
    bullet_item: true,
    ordered_item: true,
    task_item: true,
    quote: true,
    callout: true,
  };

  /**
   * Gold ladder expectation table（测试 / 文档）
   * steps = simulateLadder 在默认 empty+hasGap 下的 action 序列（至 merge/noop 前含终点结构）
   */
  var LADDER_GOLD = [
    {
      id: 'heading-h3',
      block: { type: 'heading', level: 3, text: '' },
      // demote-heading 后恢复 gap（_hasGap:true），故每级之间再 strip-gap
      steps: [
        'strip-gap',
        'demote-heading',
        'strip-gap',
        'demote-heading',
        'strip-gap',
        'to-paragraph',
      ],
      note: 'H3 empty: gap → H2 → gap → H1 → gap → paragraph',
    },
    {
      id: 'heading-h2',
      block: { type: 'heading', level: 2, text: '' },
      steps: ['strip-gap', 'demote-heading', 'strip-gap', 'to-paragraph'],
      note: 'H2 empty: gap → H1 → gap → paragraph',
    },
    {
      id: 'heading-h1',
      block: { type: 'heading', level: 1, text: '' },
      steps: ['strip-gap', 'to-paragraph'],
      note: 'H1 empty: gap → paragraph',
    },
    {
      id: 'bullet',
      block: { type: 'bullet_item', text: '' },
      steps: ['strip-gap', 'strip-mark'],
      note: 'empty bullet: gap → paragraph (strip-mark)',
    },
    {
      id: 'ordered',
      block: { type: 'ordered_item', text: '' },
      steps: ['strip-gap', 'strip-mark'],
      note: 'empty ordered: gap → paragraph',
    },
    {
      id: 'task',
      block: { type: 'task_item', text: '', checked: false },
      steps: ['strip-gap', 'strip-mark'],
      note: 'empty task: gap → paragraph (checked discarded)',
    },
    {
      id: 'quote',
      block: { type: 'quote', text: '' },
      steps: ['strip-gap', 'to-paragraph'],
      note: 'empty quote: gap → paragraph',
    },
    {
      id: 'callout',
      block: { type: 'callout', text: '', callout: 'note' },
      steps: ['strip-gap', 'to-paragraph'],
      note: 'empty callout: gap → paragraph',
    },
    {
      id: 'paragraph-first',
      block: { type: 'paragraph', text: '' },
      baseCtx: { isFirstBlock: true, soleBlock: false },
      steps: ['noop'],
      note: 'empty paragraph at doc start → noop',
    },
    {
      id: 'paragraph-sole',
      block: { type: 'paragraph', text: '' },
      baseCtx: { soleBlock: true, isFirstBlock: true },
      steps: ['noop'],
      note: 'sole empty paragraph → noop',
    },
    {
      id: 'paragraph-merge',
      block: { type: 'paragraph', text: '' },
      baseCtx: { isFirstBlock: false, soleBlock: false },
      steps: ['merge-prev'],
      note: 'empty paragraph not first → merge-prev',
    },
  ];

  /**
   * 正文是否视为空（仅空白 / 零宽 / nbsp）
   * @param {string|null|undefined} text
   * @returns {boolean}
   */
  function isBodyEmpty(text) {
    if (text == null) return true;
    var s = String(text)
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/\r\n/g, '\n');
    return s.replace(/\s+/g, '') === '';
  }

  function action(name, patch, note) {
    var out = { action: name };
    if (patch != null) out.patch = patch;
    if (note != null) out.note = note;
    return out;
  }

  /**
   * 单步降级决策（纯函数）。
   *
   * @param {object} block
   *   { type, text?, level?, indent?, checked?, callout? }
   * @param {object} [ctx]
   *   {
   *     hasGap?: boolean,       // 标记与正文间源空格是否仍在；默认 true（结构化块）
   *     caretOffset?: number,   // 默认 0（阶梯入口假设在 body 起点）
   *     isFirstBlock?: boolean, // 文档首块
   *     soleBlock?: boolean,    // 文档唯一块
   *     markSoft?: boolean,     // 列表 soft ·（F-CORE-05）；不影响阶梯终点
   *     markPresent?: boolean,  // 结构标记是否仍在；默认 true（结构化）
   *   }
   * @returns {{
   *   action: 'delete-char'|'strip-gap'|'strip-mark'|'demote-heading'|'to-paragraph'|'merge-prev'|'noop',
   *   patch?: object,
   *   note?: string
   * }}
   */
  function demoteStep(block, ctx) {
    block = block || {};
    ctx = ctx || {};

    var type = block.type || 'paragraph';
    var text = block.text != null ? String(block.text) : '';
    var empty = isBodyEmpty(text);
    var caret =
      typeof ctx.caretOffset === 'number' && isFinite(ctx.caretOffset) ? ctx.caretOffset : 0;
    var isFirst = !!ctx.isFirstBlock;
    var sole = !!ctx.soleBlock;
    var structured = !!STRUCTURED[type];

    // hasGap：结构化块默认 true；段落无 gap
    var hasGap;
    if (typeof ctx.hasGap === 'boolean') {
      hasGap = ctx.hasGap;
    } else {
      hasGap = structured;
    }

    var markPresent;
    if (typeof ctx.markPresent === 'boolean') {
      markPresent = ctx.markPresent;
    } else {
      markPresent = structured;
    }

    // —— 1) body 非空且 caret > 0：标准删字 ——
    if (!empty && caret > 0) {
      return action('delete-char', null, 'body-char');
    }

    // —— 2) body 非空且 caret == 0：与上块合并（必须带上当前正文）——
    if (!empty && caret <= 0) {
      if (isFirst) {
        return action('noop', null, 'caret-start-nonempty-first');
      }
      return action('merge-prev', { text: text }, 'caret-start-nonempty-merge');
    }

    // 以下 body 为空

    // —— 3) 空 body + gap：先剥间隙，标记进入将死灰态 ——
    if (structured && hasGap) {
      return action(
        'strip-gap',
        {
          type: type,
          text: '',
          level: block.level,
          indent: block.indent,
          checked: block.checked,
          _hasGap: false,
          _markLoose: true,
        },
        'remove-structure-gap'
      );
    }

    // —— 4) 空 body + 无 gap + 结构标记仍在：按类型降级 ——
    if (structured && markPresent) {
      return demoteStructure(block, ctx);
    }

    // —— 5/6) 段落（或已无结构）：merge 或 noop ——
    // sole 空段 → noop；首块无 prev → noop；否则 merge-prev
    if (type === 'paragraph' || !structured) {
      if (sole) {
        return action('noop', { type: 'paragraph', text: '' }, 'sole-empty-paragraph');
      }
      if (isFirst) {
        return action('noop', null, 'first-empty-paragraph');
      }
      return action('merge-prev', { type: 'paragraph', text: '' }, 'empty-paragraph-merge');
    }

    return action('noop', null, 'fallback');
  }

  /**
   * 结构化块在无 gap 时的降级
   */
  function demoteStructure(block, ctx) {
    var type = block.type;

    // 标题：level>1 → demote-heading；level==1 → to-paragraph
    if (type === 'heading') {
      var lv = Math.max(1, Math.min(6, parseInt(block.level, 10) || 1));
      if (lv > 1) {
        var next = lv - 1;
        return action(
          'demote-heading',
          {
            type: 'heading',
            level: next,
            text: '',
            _hasGap: true, // 降级后恢复 gap，便于再走阶梯
            _markLoose: false,
          },
          'heading-' + lv + '-to-' + next
        );
      }
      return action(
        'to-paragraph',
        { type: 'paragraph', text: '', level: undefined },
        'heading-1-to-paragraph'
      );
    }

    // 无序：strip-mark → paragraph（soft · 与 hard * 同终点）
    if (type === 'bullet_item') {
      return action(
        'strip-mark',
        {
          type: 'paragraph',
          text: '',
          indent: 0,
          _from: 'bullet_item',
          _soft: !!ctx.markSoft,
        },
        ctx.markSoft ? 'soft-bullet-to-paragraph' : 'bullet-to-paragraph'
      );
    }

    // 有序
    if (type === 'ordered_item') {
      return action(
        'strip-mark',
        {
          type: 'paragraph',
          text: '',
          indent: 0,
          _from: 'ordered_item',
        },
        'ordered-to-paragraph'
      );
    }

    // 任务：丢弃 checked
    if (type === 'task_item') {
      return action(
        'strip-mark',
        {
          type: 'paragraph',
          text: '',
          indent: 0,
          checked: undefined,
          _from: 'task_item',
        },
        'task-to-paragraph'
      );
    }

    // 引用
    if (type === 'quote') {
      return action(
        'to-paragraph',
        { type: 'paragraph', text: '' },
        'quote-to-paragraph'
      );
    }

    // callout → paragraph（简洁可测；可扩展为 callout→quote→p）
    if (type === 'callout') {
      return action(
        'to-paragraph',
        { type: 'paragraph', text: '', callout: undefined },
        'callout-to-paragraph'
      );
    }

    // divider：Backspace → 段落
    if (type === 'divider') {
      return action(
        'to-paragraph',
        { type: 'paragraph', text: '' },
        'divider-to-paragraph'
      );
    }

    return action('noop', null, 'unknown-structure');
  }

  /**
   * 从 line-source 表面状态构造 ctx（可选辅助）
   */
  function ctxFromSurface(surface, pos) {
    surface = surface || {};
    pos = pos || {};
    return {
      hasGap: surface.hasGap,
      markSoft: surface.markSoft,
      markPresent: surface.markPresent,
      caretOffset: surface.caretOffset,
      isFirstBlock: pos.isFirstBlock,
      soleBlock: pos.soleBlock,
      hasMore: pos.hasMore,
    };
  }

  /**
   * 连续模拟 n 次空 body 阶梯（测试 / 文档演示）
   * 例：H3 空 → [strip-gap, demote-heading(2), strip-gap, demote-heading(1), strip-gap, to-paragraph]
   * @returns {Array<{action,patch?,note?}>}
   */
  function simulateLadder(block, n, baseCtx) {
    var steps = [];
    var b = {
      type: block.type,
      text: block.text != null ? block.text : '',
      level: block.level,
      indent: block.indent,
      checked: block.checked,
    };
    var ctx = {
      hasGap: true,
      caretOffset: 0,
      markPresent: true,
    };
    if (baseCtx) {
      var k;
      for (k in baseCtx) {
        if (Object.prototype.hasOwnProperty.call(baseCtx, k)) {
          ctx[k] = baseCtx[k];
        }
      }
    }
    // 段落默认无 gap / 无 mark
    if (b.type === 'paragraph' || !STRUCTURED[b.type]) {
      if (typeof (baseCtx && baseCtx.hasGap) !== 'boolean') ctx.hasGap = false;
      if (typeof (baseCtx && baseCtx.markPresent) !== 'boolean') ctx.markPresent = false;
    }
    var i;
    for (i = 0; i < (n || 8); i++) {
      var step = demoteStep(b, ctx);
      steps.push(step);
      if (
        step.action === 'noop' ||
        step.action === 'delete-char' ||
        step.action === 'merge-prev'
      ) {
        break;
      }
      if (step.action === 'strip-gap') {
        ctx.hasGap = false;
        ctx.markPresent = true;
        b.text = '';
        continue;
      }
      if (step.action === 'demote-heading' && step.patch) {
        b.type = 'heading';
        b.level = step.patch.level;
        b.text = '';
        ctx.hasGap = step.patch._hasGap !== false;
        ctx.markPresent = true;
        continue;
      }
      if (
        (step.action === 'to-paragraph' || step.action === 'strip-mark') &&
        step.patch
      ) {
        b.type = step.patch.type || 'paragraph';
        b.level = undefined;
        b.text = step.patch.text != null ? step.patch.text : '';
        b.indent = step.patch.indent;
        b.checked = undefined;
        ctx.hasGap = false;
        ctx.markPresent = false;
        continue;
      }
      break;
    }
    return steps;
  }

  /**
   * 校验 gold 表一条是否与 simulateLadder 一致（纯测试辅助）
   * @returns {{ ok: boolean, expected: string[], actual: string[], id: string }}
   */
  function matchGoldEntry(entry) {
    entry = entry || {};
    var ladder = simulateLadder(entry.block || {}, 10, entry.baseCtx || null);
    var actual = [];
    var i;
    for (i = 0; i < ladder.length; i++) {
      actual.push(ladder[i].action);
      // gold 表结构终点到 strip-mark / to-paragraph 为止；merge/noop 若在表中则保留
      if (
        ladder[i].action === 'noop' ||
        ladder[i].action === 'merge-prev' ||
        ladder[i].action === 'to-paragraph' ||
        ladder[i].action === 'strip-mark'
      ) {
        // 若 gold 只期望到结构终点且下一步会 merge，截断到期望长度
        if (entry.steps && actual.length >= entry.steps.length) break;
      }
    }
    // 与期望等长截取
    if (entry.steps && actual.length > entry.steps.length) {
      actual = actual.slice(0, entry.steps.length);
    }
    var expected = entry.steps || [];
    var ok = expected.length === actual.length;
    if (ok) {
      for (i = 0; i < expected.length; i++) {
        if (expected[i] !== actual[i]) {
          ok = false;
          break;
        }
      }
    }
    return {
      ok: ok,
      id: entry.id || '',
      expected: expected,
      actual: actual,
    };
  }

  window.MdxDemotion = {
    isBodyEmpty: isBodyEmpty,
    demoteStep: demoteStep,
    ctxFromSurface: ctxFromSurface,
    simulateLadder: simulateLadder,
    matchGoldEntry: matchGoldEntry,
    LADDER_GOLD: LADDER_GOLD,
    STRUCTURED_TYPES: STRUCTURED,
  };
})();
