/**
 * markdown-editor/blocks/math.js — 块级 / 行内公式
 * 导出 window.MdxBlocksMath
 *
 * W7：type=math + $$…$$；读态 KaTeX 或等宽源；编辑含 $$ 单表面；行内 $…$
 * KaTeX 不进 core（宿主可选 CDN）
 */
(function () {
  'use strict';

  var STATE_KEY = '_mdxMathEdit';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isMathBlock(block) {
    return !!(block && block.type === 'math');
  }

  function dollarSource(block) {
    var text = block && block.text != null ? String(block.text) : '';
    text = text.replace(/^\n+/, '').replace(/\n+$/, '');
    return '$$\n' + text + '\n$$';
  }

  /** @param {string} latex @param {{ display?: boolean }} [opts] */
  function renderLatex(latex, opts) {
    opts = opts || {};
    var src = latex != null ? String(latex) : '';
    var display = opts.display !== false;
    var katex = window.katex;
    if (katex && typeof katex.renderToString === 'function') {
      try {
        return katex.renderToString(src, {
          displayMode: !!display,
          throwOnError: false,
          strict: 'ignore',
          output: 'html',
          trust: false,
        });
      } catch (e) {
        /* fallthrough */
      }
    }
    var cls =
      'mdx-math-fallback mdx-math-fallback--' + (display ? 'display' : 'inline');
    return '<code class="' + cls + '">' + esc(src) + '</code>';
  }

  function readHtml(block) {
    block = block || {};
    var raw = block.text != null ? String(block.text) : '';
    var inner = !String(raw).trim()
      ? '<span class="mdx-ph mdx-math__ph">输入 LaTeX</span>'
      : renderLatex(raw, { display: true });
    return (
      '<div class="mdx-math" data-mdx-math data-mode="read" aria-label="公式">' +
      '<div class="mdx-math__render" data-cx-no-edit>' +
      inner +
      '</div></div>'
    );
  }

  function sourceHtml(block) {
    return (
      '<div class="mdx-math is-source" data-mdx-math data-mode="source">' +
      '<pre class="mdx-math-source-pre" data-mdx-edit data-mdx-math-source ' +
      'contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true" ' +
      'aria-label="公式源码">' +
      esc(dollarSource(block)) +
      '</pre></div>'
    );
  }

  function parseSource(pre) {
    if (!pre) return { text: '' };
    var raw = (pre.innerText != null ? pre.innerText : pre.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n/g, '\n');
    var m = raw.match(/^\$\$\s*\n?([\s\S]*?)\n?\s*\$\$\s*$/);
    if (m) return { text: (m[1] || '').replace(/^\n+/, '').replace(/\n+$/, '') };
    if (raw.indexOf('$$') === 0) {
      return {
        text: raw
          .slice(2)
          .replace(/^\n/, '')
          .replace(/\n?\$\$\s*$/, '')
          .replace(/^\n+/, '')
          .replace(/\n+$/, ''),
      };
    }
    return { text: raw.replace(/^\n+/, '').replace(/\n+$/, '') };
  }

  function insertPlainText(text) {
    try {
      if (document.queryCommandSupported && document.queryCommandSupported('insertText')) {
        document.execCommand('insertText', false, text);
        return true;
      }
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  function mountSource(contentEl, block, opts) {
    if (!contentEl) return null;
    opts = opts || {};
    destroy(contentEl);
    contentEl.innerHTML = sourceHtml(block);
    var pre =
      contentEl.querySelector('[data-mdx-math-source]') ||
      contentEl.querySelector('[data-mdx-edit]');
    if (!pre) return null;
    var composing = false;
    function fire() {
      if (!composing && typeof opts.onChange === 'function') opts.onChange(parseSource(pre), pre);
    }
    function onKey(e) {
      if (typeof opts.onKeydown === 'function') opts.onKeydown(e);
    }
    function onPaste(e) {
      if (!e.clipboardData) return;
      var plain = e.clipboardData.getData('text/plain');
      if (plain == null) return;
      e.preventDefault();
      insertPlainText(plain.replace(/\r\n/g, '\n'));
      fire();
    }
    var listeners = [
      ['input', fire],
      ['keydown', onKey],
      ['paste', onPaste],
      [
        'compositionstart',
        function () {
          composing = true;
        },
      ],
      [
        'compositionend',
        function () {
          composing = false;
          fire();
        },
      ],
    ];
    for (var i = 0; i < listeners.length; i++) pre.addEventListener(listeners[i][0], listeners[i][1]);
    contentEl[STATE_KEY] = { pre: pre, listeners: listeners };
    return {
      pre: pre,
      parse: function () {
        return parseSource(pre);
      },
    };
  }

  function destroy(contentEl) {
    if (!contentEl || !contentEl[STATE_KEY]) return;
    var st = contentEl[STATE_KEY];
    if (st.pre && st.listeners) {
      for (var i = 0; i < st.listeners.length; i++) {
        try {
          st.pre.removeEventListener(st.listeners[i][0], st.listeners[i][1]);
        } catch (err) {
          /* ignore */
        }
      }
    }
    try {
      delete contentEl[STATE_KEY];
    } catch (e2) {
      contentEl[STATE_KEY] = undefined;
    }
  }

  function findClose(s, from) {
    for (var i = from; i < s.length; i++) {
      if (s.charAt(i) === '\n') return -1;
      if (s.charAt(i) === '$' && s.charAt(i - 1) !== '\\') {
        if (s.charAt(i + 1) === '$') return -1;
        return i;
      }
    }
    return -1;
  }

  function nextDollar(s, from) {
    for (var i = from; i < s.length; i++) {
      if (s.charAt(i) === '$' && s.charAt(i - 1) !== '\\') return i;
    }
    return -1;
  }

  /**
   * 行内 $...$：开闭内侧无空格、不跨行；$$ 交给块级
   * @param {string} text
   * @param {{ baseInline?: function }} [opts]
   */
  function inlineToHtml(text, opts) {
    opts = opts || {};
    var base =
      opts.baseInline ||
      function (chunk) {
        return esc(chunk);
      };
    var s = String(text == null ? '' : text);
    var out = '';
    var i = 0;
    while (i < s.length) {
      if (s.charAt(i) === '\\' && s.charAt(i + 1) === '$') {
        var nEsc = nextDollar(s, i + 2);
        var endEsc = nEsc < 0 ? s.length : nEsc;
        out += base(s.slice(i, endEsc).replace(/\\\$/g, '$'));
        i = endEsc;
        continue;
      }
      if (s.charAt(i) === '$' && s.charAt(i + 1) === '$') {
        out += base('$$');
        i += 2;
        continue;
      }
      if (s.charAt(i) === '$') {
        var end = findClose(s, i + 1);
        if (end > i + 1) {
          var latex = s.slice(i + 1, end);
          if (latex.length && !/^\s|\s$/.test(latex)) {
            // data-latex：编辑往返真相；禁止依赖 KaTeX DOM 文本（会碎成 E=mc / 2）
            out +=
              '<span class="mdx-math-inline" data-mdx-math-inline data-latex="' +
              esc(latex) +
              '">' +
              renderLatex(latex, { display: false }) +
              '</span>';
            i = end + 1;
            continue;
          }
        }
        out += base('$');
        i += 1;
        continue;
      }
      var n = nextDollar(s, i + 1);
      if (n < 0) n = s.length;
      var dd = s.indexOf('$$', i);
      if (dd >= i && dd < n) n = dd;
      out += base(s.slice(i, n));
      i = n;
    }
    return out;
  }

  function replaceInlineMath(escapedText) {
    return String(escapedText == null ? '' : escapedText).replace(
      /(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\$)/g,
      function (_, pre, body) {
        var latex = body
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&');
        return (
          pre +
          '<span class="mdx-math-inline" data-mdx-math-inline data-latex="' +
          esc(latex) +
          '">' +
          renderLatex(latex, { display: false }) +
          '</span>'
        );
      }
    );
  }

  function register() {
    var Reg = window.MdxRegistry;
    if (!Reg || typeof Reg.register !== 'function') return;
    Reg.register({
      type: 'math',
      toMarkdown: dollarSource,
      renderRead: readHtml,
      renderEdit: sourceHtml,
      slash: {
        id: 'math',
        title: '公式块',
        aliases: ['math', 'latex', '公式', 'equation', 'katex'],
        section: '高级',
      },
    });
  }

  window.MdxBlocksMath = {
    isMathBlock: isMathBlock,
    dollarSource: dollarSource,
    renderLatex: renderLatex,
    readHtml: readHtml,
    sourceHtml: sourceHtml,
    parseSource: parseSource,
    mountSource: mountSource,
    destroy: destroy,
    replaceInlineMath: replaceInlineMath,
    inlineToHtml: inlineToHtml,
    register: register,
  };

  try {
    register();
  } catch (e) {
    /* ignore */
  }
})();
