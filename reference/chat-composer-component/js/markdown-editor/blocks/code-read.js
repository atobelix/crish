/**
 * markdown-editor/blocks/code-read.js — 代码块 READ / 源码表面 HTML
 * 导出 window.MdxBlocksCode
 *
 * W2 硬规则：
 * - readHtml：token 高亮读态单卡片（无双壳）+ 行号 gutter（C-R21）
 * - sourceHtml：同一 .mdx-code-card 内完整 fence 源（含 ```lang）；无 gutter
 * - copyBody：只复制 body（不含围栏 / 不含行号）
 *
 * P1 增强：
 * - F-CODE-LANG：语言标签可点（button + data-mdx-code-lang）
 * - F-CODE-FOLD：行数 > N(24) 默认折前 12 行 + 展开/收起（仅读态）
 */
(function () {
  'use strict';

  /** 超过此行数默认折叠（F-CODE-FOLD 本实现取值） */
  var FOLD_THRESHOLD = 24;
  /** 折叠时展示前若干行 */
  var FOLD_PREVIEW = 12;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 高亮：优先 MdxCodeHighlight，其次 MdxUtil.highlightCode，否则纯转义 */
  function highlightBody(raw, lang) {
    var HL = window.MdxCodeHighlight;
    if (HL && typeof HL.highlightCode === 'function') {
      return HL.highlightCode(raw, lang);
    }
    if (window.MdxUtil && typeof window.MdxUtil.highlightCode === 'function') {
      return window.MdxUtil.highlightCode(raw, lang);
    }
    return esc(raw);
  }

  /**
   * 完整围栏源串
   * @param {object} block
   * @returns {string}
   */
  function fenceSource(block) {
    block = block || {};
    var lang = block.lang != null ? String(block.lang) : '';
    var text = block.text != null ? String(block.text) : '';
    var LS = window.MdxLineSource;
    if (LS && typeof LS.toSourceLine === 'function') {
      return LS.toSourceLine({ type: 'code', lang: lang, text: text });
    }
    return '```' + lang + '\n' + text.replace(/\n$/, '') + '\n```';
  }

  /**
   * 逻辑行数：按 \n 分割；空代码至少 1 行；末尾单独 \n 不计入多一行
   * @param {string} text
   * @returns {number}
   */
  function countLines(text) {
    var raw = text != null ? String(text) : '';
    // 常见 fence body 尾随 \n：不另算一行
    if (raw.length > 0 && raw.charAt(raw.length - 1) === '\n') {
      raw = raw.slice(0, -1);
    }
    if (raw === '') return 1;
    return raw.split('\n').length;
  }

  /**
   * 是否默认应折叠（纯函数，便于 harness）
   * @param {number} lineCount
   * @returns {boolean}
   */
  function shouldDefaultFold(lineCount) {
    return (lineCount | 0) > FOLD_THRESHOLD;
  }

  /**
   * 折叠可见行数
   * @param {number} lineCount 总逻辑行
   * @param {boolean} expanded 用户是否已展开
   * @returns {number}
   */
  function foldVisibleLines(lineCount, expanded) {
    var n = Math.max(0, lineCount | 0);
    if (n === 0) return 1;
    if (shouldDefaultFold(n) && !expanded) {
      return Math.min(FOLD_PREVIEW, n);
    }
    return n;
  }

  /**
   * 取前 n 逻辑行（保留用于高亮的正文；末尾不强制补 \n）
   * @param {string} text
   * @param {number} n
   * @returns {string}
   */
  function sliceFirstLines(text, n) {
    var raw = text != null ? String(text) : '';
    var hadTrailing = raw.length > 0 && raw.charAt(raw.length - 1) === '\n';
    var body = hadTrailing ? raw.slice(0, -1) : raw;
    if (body === '') return '';
    var parts = body.split('\n');
    var max = Math.max(0, n | 0);
    if (max <= 0) return '';
    if (parts.length <= max) return text != null ? String(text) : '';
    return parts.slice(0, max).join('\n');
  }

  /**
   * 折叠决策（纯）
   * @param {number} lineCount
   * @param {boolean} [expanded]
   * @returns {{ foldable: boolean, folded: boolean, visible: number, total: number }}
   */
  function resolveFold(lineCount, expanded) {
    var total = Math.max(1, lineCount | 0);
    var foldable = shouldDefaultFold(total);
    var folded = foldable && !expanded;
    return {
      foldable: foldable,
      folded: folded,
      visible: foldVisibleLines(total, !!expanded),
      total: total,
    };
  }

  /**
   * 行号 gutter HTML（aria-hidden，不进复制）
   * @param {number} n 显示行数
   * @param {number} [start=1] 起始行号
   * @returns {string}
   */
  function gutterHtml(n, start) {
    var lines = Math.max(1, n | 0);
    var from = start != null ? start | 0 : 1;
    if (from < 1) from = 1;
    var parts = ['<div class="mdx-code-gutter" aria-hidden="true">'];
    for (var i = 0; i < lines; i++) {
      parts.push('<span class="mdx-code-gutter__n">' + (from + i) + '</span>');
    }
    parts.push('</div>');
    return parts.join('');
  }

  /**
   * 折叠条 HTML（仅读态）
   * @param {{ folded: boolean, total: number }} fold
   * @returns {string}
   */
  function foldBarHtml(fold) {
    if (!fold || !fold.foldable) return '';
    if (fold.folded) {
      var more = Math.max(0, (fold.total | 0) - FOLD_PREVIEW);
      return (
        '<div class="mdx-code-card__fold-bar" data-cx-no-edit>' +
        '<button type="button" class="mdx-code-card__fold" data-mdx-code-fold="expand" ' +
        'aria-expanded="false" data-cx-no-edit ' +
        'title="展开全部代码">' +
        '展开全部 · ' +
        esc(String(fold.total)) +
        ' 行' +
        (more > 0 ? '（+' + esc(String(more)) + '）' : '') +
        '</button></div>'
      );
    }
    return (
      '<div class="mdx-code-card__fold-bar" data-cx-no-edit>' +
      '<button type="button" class="mdx-code-card__fold" data-mdx-code-fold="collapse" ' +
      'aria-expanded="true" data-cx-no-edit title="收起代码">' +
      '收起</button></div>'
    );
  }

  /**
   * 代码读态：单卡片 + 可选语言标签 + 复制 + 行号 gutter + 高亮 pre/code
   * @param {object} block
   * @param {{ expanded?: boolean, foldThreshold?: number, foldPreview?: number }} [opts]
   * @returns {string}
   */
  function readHtml(block, opts) {
    block = block || {};
    opts = opts || {};
    var lang = (block.lang || '').trim();
    var raw = block.text || '';
    var langLabel = lang || 'text';
    var aria = '代码块 ' + langLabel;
    var totalLines = countLines(raw);

    // 允许测试覆盖阈值；生产默认 24 / 12
    var thr =
      opts.foldThreshold != null ? opts.foldThreshold | 0 : FOLD_THRESHOLD;
    var prev =
      opts.foldPreview != null ? opts.foldPreview | 0 : FOLD_PREVIEW;
    // 临时改常量式决策：内联 resolve
    var foldable = totalLines > thr;
    var expanded = !!opts.expanded;
    var folded = foldable && !expanded;
    var visible = folded ? Math.min(prev, totalLines) : totalLines;
    var displayRaw = folded ? sliceFirstLines(raw, visible) : raw;
    var body = highlightBody(displayRaw, lang);

    var foldMeta = {
      foldable: foldable,
      folded: folded,
      total: totalLines,
      visible: visible,
    };

    var cardClass = 'mdx-code-card';
    if (folded) cardClass += ' is-folded';
    if (foldable && expanded) cardClass += ' is-expanded';

    // 折叠时 DOM 仅含预览行；全文 stash 供复制（F-CODE-COPY + F-CODE-FOLD）
    var fullStash = folded
      ? '<div class="mdx-code-card__full-stash" data-mdx-code-full hidden aria-hidden="true">' +
        esc(raw) +
        '</div>'
      : '';

    return (
      '<div class="' +
      cardClass +
      '" data-mdx-code-card data-mode="read" data-lang="' +
      esc(lang) +
      '"' +
      (foldable ? ' data-foldable="1"' : '') +
      (folded ? ' data-folded="1"' : '') +
      (foldable && expanded ? ' data-expanded="1"' : '') +
      ' data-line-count="' +
      esc(String(totalLines)) +
      '" aria-label="' +
      esc(aria) +
      '">' +
      fullStash +
      '<div class="mdx-code-card__bar" data-cx-no-edit>' +
      '<button type="button" class="mdx-code-card__lang" data-mdx-code-lang ' +
      'data-cx-no-edit title="' +
      esc(langLabel) +
      ' · 点击切换语言" aria-haspopup="menu" aria-label="代码语言 ' +
      esc(langLabel) +
      '">' +
      esc(langLabel) +
      '</button>' +
      '<button type="button" class="mdx-code-card__copy" data-mdx-code-copy data-cx-no-edit ' +
      'aria-label="复制代码" title="复制">' +
      '复制</button>' +
      '</div>' +
      '<div class="mdx-code-card__body">' +
      gutterHtml(visible) +
      '<pre class="mdx-pre mdx-code-card__pre" data-lang="' +
      esc(lang) +
      '"><code class="mdx-code-card__code language-' +
      esc(langLabel) +
      '">' +
      body +
      '</code></pre>' +
      '</div>' +
      foldBarHtml(foldMeta) +
      '</div>'
    );
  }

  /**
   * 源码态：同一卡片壳，无语言 bar / 无 textarea；仅 contenteditable fence 全文
   * （折叠不影响源码态）
   * @param {object} block
   * @returns {string}
   */
  function sourceHtml(block) {
    block = block || {};
    var src = fenceSource(block);
    return (
      '<div class="mdx-code-card is-source" data-mdx-code-card data-mode="source">' +
      '<pre class="mdx-code-source-pre mdx-code-card__pre" data-mdx-edit data-mdx-code-source ' +
      'contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true" ' +
      'aria-label="代码源码">' +
      esc(src) +
      '</pre></div>'
    );
  }

  /**
   * 本地 fallback（无 MdxBlocksCodeEdit 时）— 等同 sourceHtml
   * @deprecated 使用 sourceHtml
   */
  function localSourceHtml(block) {
    return sourceHtml(block);
  }

  /**
   * 复制 body 纯文本（不含围栏）
   * @param {string} bodyText
   * @param {{ button?: HTMLElement, liveMs?: number }} [opts]
   * @returns {Promise<boolean>|boolean}
   */
  function copyBody(bodyText, opts) {
    opts = opts || {};
    var text = bodyText != null ? String(bodyText) : '';
    var btn = opts.button;
    var liveMs = opts.liveMs != null ? opts.liveMs : 1200;

    function feedback(ok) {
      if (!btn) return;
      var prev = btn.getAttribute('data-mdx-copy-label') || btn.textContent || '复制';
      if (!btn.getAttribute('data-mdx-copy-label')) {
        btn.setAttribute('data-mdx-copy-label', prev);
      }
      btn.textContent = ok ? '已复制' : '复制失败';
      btn.classList.toggle('is-copied', !!ok);
      clearTimeout(btn._mdxCopyTimer);
      btn._mdxCopyTimer = setTimeout(function () {
        btn.textContent = btn.getAttribute('data-mdx-copy-label') || '复制';
        btn.classList.remove('is-copied');
      }, liveMs);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () {
          feedback(true);
          return true;
        },
        function () {
          var ok = fallbackCopy(text);
          feedback(ok);
          return ok;
        }
      );
    }
    var ok2 = fallbackCopy(text);
    feedback(ok2);
    return ok2;
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  /**
   * 绑定读态复制按钮（不进编辑）
   * 优先 MdxCodeChrome.bindCopy(btn, getText)
   * @param {HTMLElement} contentEl
   * @param {function(): string|string} getBody  body 文本或工厂
   */
  function bindCopy(contentEl, getBody) {
    if (!contentEl) return;
    var btn = contentEl.querySelector('[data-mdx-code-copy]');
    if (!btn || btn._mdxCopyBound) return;

    function resolveBody() {
      return typeof getBody === 'function'
        ? getBody()
        : getBody != null
          ? String(getBody)
          : '';
    }

    var Chrome = window.MdxCodeChrome;
    if (Chrome && typeof Chrome.bindCopy === 'function') {
      // Chrome sets _mdxCopyBound / dataset flag itself
      Chrome.bindCopy(btn, resolveBody);
      return;
    }

    btn._mdxCopyBound = true;
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      copyBody(resolveBody(), { button: btn });
    });
  }

  window.MdxBlocksCode = {
    readHtml: readHtml,
    sourceHtml: sourceHtml,
    localSourceHtml: localSourceHtml,
    fenceSource: fenceSource,
    copyBody: copyBody,
    bindCopy: bindCopy,
    highlightBody: highlightBody,
    countLines: countLines,
    // F-CODE-FOLD 纯函数 API（harness / chrome）
    FOLD_THRESHOLD: FOLD_THRESHOLD,
    FOLD_PREVIEW: FOLD_PREVIEW,
    shouldDefaultFold: shouldDefaultFold,
    foldVisibleLines: foldVisibleLines,
    sliceFirstLines: sliceFirstLines,
    resolveFold: resolveFold,
    gutterHtml: gutterHtml,
  };
})();
