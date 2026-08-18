/**
 * markdown-editor/util.js — shared helpers
 */
(function () {
  'use strict';

  var _seq = 0;
  function uid(prefix) {
    _seq += 1;
    return (prefix || 'b') + '_' + Date.now().toString(36) + '_' + _seq.toString(36);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function unesc(s) {
    return String(s == null ? '' : s)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
  }

  /** Inline MD → safe HTML (bold/italic/code/link/file/doc chips + $math$) */
  function inlineHtml(text, opts) {
    opts = opts || {};
    // 行内公式：MdxBlocksMath 分段（货币 $ 安全策略在 math 模块）
    var MathMod = window.MdxBlocksMath;
    if (MathMod && typeof MathMod.inlineToHtml === 'function' && opts.math !== false) {
      return MathMod.inlineToHtml(text, {
        baseInline: function (chunk) {
          return inlineHtmlCore(chunk, opts);
        },
      });
    }
    return inlineHtmlCore(text, opts);
  }

  function inlineHtmlCore(text, opts) {
    opts = opts || {};
    var t = esc(text);
    // code first
    t = t.replace(/`([^`]+)`/g, '<code class="mdx-code">$1</code>');
    // file chip [[file:path]] or [[file:path|label]]
    t = t.replace(/\[\[file:([^\]|]+)(?:\|([^\]]+))?\]\]/g, function (_, path, label) {
      var p = path.trim();
      var lab = (label || p).trim();
      return (
        '<button type="button" class="mdx-file-chip" data-mdx-file="' +
        esc(p) +
        '" title="' +
        esc(p) +
        '">' +
        esc(lab) +
        '</button>'
      );
    });
    // wiki [[doc:title]] or [[doc:title|label]]（须在 GFM 链接前）
    t = t.replace(/\[\[doc:([^\]|]+)(?:\|([^\]]+))?\]\]/gi, function (_, title, label) {
      var tt = String(title || '').trim();
      if (!tt) return '';
      var lab = (label != null && String(label).trim() ? String(label).trim() : tt);
      return (
        '<button type="button" class="mdx-wiki-link" data-mdx-doc="' +
        esc(tt) +
        '" title="' +
        esc(tt) +
        '">' +
        esc(lab) +
        '</button>'
      );
    });
    // markdown links（跳过已处理的图片语法残留由块级解析；行内仍支持 [text](url)）
    // 不把 ![alt](url) 当成链接：先保护 image 语法
    var imgHold = [];
    t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (full) {
      imgHold.push(full);
      return '\u0000IMG' + (imgHold.length - 1) + '\u0000';
    });
    t = t.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      function (_, label, href) {
        var h = String(href || '').trim();
        // 禁止 javascript:
        if (/^javascript:/i.test(h) || /^vbscript:/i.test(h)) {
          return esc(label);
        }
        return (
          '<a class="mdx-a" href="' +
          esc(h) +
          '" target="_blank" rel="noopener noreferrer">' +
          label +
          '</a>'
        );
      }
    );
    t = t.replace(/\u0000IMG(\d+)\u0000/g, function (_, idx) {
      return imgHold[+idx] || '';
    });
    // bold / italic / strike
    t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*(?!\s)(.+?)(?!\s)\*(?!\*)/g, '$1<em>$2</em>');
    t = t.replace(/~~(.+?)~~/g, '<del>$1</del>');
    // P1 扩展：高亮 / 下划线
    t = t.replace(/==(.+?)==/g, '<mark class="mdx-mark-hl">$1</mark>');
    t = t.replace(/\+\+(.+?)\+\+/g, '<u>$1</u>');
    // 无 Math 模块时的轻量 $...$ 回退
    if (opts.math !== false && !(window.MdxBlocksMath && window.MdxBlocksMath.inlineToHtml)) {
      t = t.replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\$)/g, function (_, pre, body) {
        return (
          pre +
          '<span class="mdx-math-inline" data-mdx-math-inline><code class="mdx-math-fallback mdx-math-fallback--inline">' +
          body +
          '</code></span>'
        );
      });
    }
    return t;
  }

  function textFromEditable(el) {
    if (!el) return '';
    // Prefer plain text; normalize nbsp
    var t = el.innerText != null ? el.innerText : el.textContent || '';
    return t.replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n');
  }

  /**
   * contenteditable 内 HTML → 行内 Markdown（尽力）。
   * 识别 b/strong、i/em、s/strike/del、code；其余取文本。
   * 无格式标签时结果与 textFromEditable 一致（不丢字）。
   */
  function htmlToInlineMd(el) {
    if (!el) return '';
    // 快速路径：无格式 / 无灰显定界符 → 纯文本
    if (
      !el.querySelector ||
      !el.querySelector(
        'b,strong,i,em,s,strike,del,code,u,a,br,mark,[data-mdx-delim],[data-mdx-math-inline],.mdx-math-inline'
      )
    ) {
      return textFromEditable(el);
    }
    var md = nodesToInlineMd(el.childNodes);
    return md.replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  }

  function nodesToInlineMd(nodes) {
    var out = '';
    for (var i = 0; i < nodes.length; i++) {
      out += nodeToInlineMd(nodes[i]);
    }
    return out;
  }

  function nodeToInlineMd(node) {
    if (!node) return '';
    if (node.nodeType === 3) {
      return node.nodeValue || '';
    }
    if (node.nodeType !== 1) return '';
    var tag = (node.tagName || '').toLowerCase();
    if (tag === 'br') return '\n';
    // 灰显定界符装饰：父 strong/em… 仍包 **，此处必须跳过以免双计
    if (node.getAttribute && node.getAttribute('data-mdx-delim') != null) {
      return '';
    }
    if (
      tag === 'span' &&
      ((node.classList && node.classList.contains('mdx-src-delim')) ||
        (typeof node.className === 'string' && node.className.indexOf('mdx-src-delim') >= 0))
    ) {
      return '';
    }
    // 行内公式：只认 data-latex，绝不把 KaTeX 渲染文本当地源（LEGACY-ISLAND / BAN-02）
    if (
      (node.getAttribute && node.getAttribute('data-mdx-math-inline') != null) ||
      (node.classList && node.classList.contains('mdx-math-inline'))
    ) {
      var latex =
        (node.getAttribute && node.getAttribute('data-latex')) ||
        (node.getAttribute && node.getAttribute('data-mdx-latex')) ||
        '';
      if (latex) return '$' + latex + '$';
      // 无 data-latex 时尽量不吞字，但可能已损
      var fb = (node.textContent || '').replace(/\s+/g, '');
      return fb ? '$' + fb + '$' : '';
    }
    var inner = nodesToInlineMd(node.childNodes);
    if (tag === 'b' || tag === 'strong') {
      return inner ? '**' + inner + '**' : '';
    }
    if (tag === 'i' || tag === 'em') {
      return inner ? '*' + inner + '*' : '';
    }
    if (tag === 's' || tag === 'strike' || tag === 'del') {
      return inner ? '~~' + inner + '~~' : '';
    }
    if (tag === 'code') {
      return inner ? '`' + inner.replace(/`/g, '') + '`' : '';
    }
    if (tag === 'a') {
      var href = node.getAttribute && node.getAttribute('href');
      if (href && inner) return '[' + inner + '](' + href + ')';
      return inner;
    }
    if (tag === 'mark') {
      return inner ? '==' + inner + '==' : '';
    }
    if (tag === 'u') {
      return inner ? '++' + inner + '++' : '';
    }
    // div/p/span 等：保留内部；块级 div 之间补换行在调用方处理
    if (tag === 'div' || tag === 'p') {
      return inner;
    }
    return inner;
  }

  /**
   * 行内 as-you-type 折叠：委托 MdxLiveMarks（W4）
   * code-highlight 等旧桩不应覆盖此委托。
   */
  function applyLiveMarks(el) {
    if (window.MdxLiveMarks && typeof window.MdxLiveMarks.applyLiveMarks === 'function') {
      return window.MdxLiveMarks.applyLiveMarks(el);
    }
    return false;
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  window.MdxUtil = {
    uid: uid,
    esc: esc,
    unesc: unesc,
    inlineHtml: inlineHtml,
    textFromEditable: textFromEditable,
    htmlToInlineMd: htmlToInlineMd,
    applyLiveMarks: applyLiveMarks,
    clamp: clamp,
  };
})();
