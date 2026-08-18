/**
 * markdown-editor/edit/clipboard/paste.js
 * U3：文档级粘贴管道 — MD 优先 → HTML 消毒转 MD → plain
 * 导出 window.MdxClipboardPaste
 *
 * 不处理图片文件（交给 media/drop-paste.js）。
 * 不处理表格 TSV（表内 contenteditable 自行处理）。
 */
(function () {
  'use strict';

  var INTERNAL_MIME = 'application/x-conex-blocks+json';

  function Parse() {
    return window.MdxParse;
  }
  function Util() {
    return window.MdxUtil;
  }

  function esc(s) {
    if (Util() && Util().esc) return Util().esc(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 探测粘贴类型
   * @returns {'internal'|'markdown'|'html'|'plain'}
   */
  function detectPasteKind(html, plain, types) {
    types = types || [];
    if (types.indexOf(INTERNAL_MIME) >= 0) return 'internal';
    var p = String(plain == null ? '' : plain);
    var h = String(html == null ? '' : html);

    // 明显 Markdown 结构（优先于 HTML，避免从 VS Code 复制带 HTML 外壳）
    if (looksLikeMarkdown(p)) return 'markdown';

    // 有实质 HTML 标签
    if (h && /<[a-z][\s\S]*>/i.test(h) && !isTrivialHtmlWrapper(h, p)) {
      return 'html';
    }
    if (p) return plainLooksStructured(p) ? 'markdown' : 'plain';
    if (h) return 'html';
    return 'plain';
  }

  function isTrivialHtmlWrapper(html, plain) {
    // Chrome 常把纯文本包成 <meta>…<div>text</div>
    var stripped = String(html)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<meta[^>]*>/gi, '')
      .replace(/<\/?(html|body|head|div|span|br|p)[^>]*>/gi, '')
      .replace(/&nbsp;/gi, ' ')
      .trim();
    var p = String(plain || '').trim();
    if (!p) return false;
    return stripped === p || stripped.replace(/\s+/g, ' ') === p.replace(/\s+/g, ' ');
  }

  function looksLikeMarkdown(text) {
    if (!text) return false;
    var t = String(text);
    if (/^```/m.test(t)) return true;
    if (/^#{1,6}\s+\S/m.test(t)) return true;
    if (/^\s*[-*+]\s+\S/m.test(t)) return true;
    if (/^\s*\d+\.\s+\S/m.test(t)) return true;
    if (/^\s*>\s+\S/m.test(t)) return true;
    if (/^\s*\|.+\|/m.test(t) && /^\s*\|?\s*:?-{3,}/m.test(t)) return true;
    if (/!\[[^\]]*\]\([^)]+\)/.test(t)) return true;
    if (/\*\*[^*\n]+\*\*/.test(t) || /__[^_\n]+__/.test(t)) return true;
    if (/^\s*\$\$/m.test(t)) return true;
    if (/^\s*---\s*$/m.test(t) && t.split('\n').length > 1) return true;
    // 多行且含空行分隔的「文档感」
    if (t.indexOf('\n\n') >= 0 && t.split('\n').length >= 3) return true;
    return false;
  }

  function plainLooksStructured(text) {
    return looksLikeMarkdown(text);
  }

  /**
   * 简易 HTML → Markdown（白名单；禁 script/style/on*）
   */
  function htmlToMarkdown(html) {
    if (!html) return '';
    var raw = String(html);
    var doc = null;
    try {
      if (typeof DOMParser !== 'undefined') {
        doc = new DOMParser().parseFromString(raw, 'text/html');
      }
    } catch (e) {
      doc = null;
    }
    if (!doc || !doc.body || !doc.body.childNodes || !doc.body.childNodes.length) {
      return htmlToMarkdownRegex(raw);
    }

    // 移除危险节点
    var bad = doc.body.querySelectorAll('script,style,iframe,object,embed,link,meta');
    for (var i = 0; i < bad.length; i++) {
      if (bad[i].parentNode) bad[i].parentNode.removeChild(bad[i]);
    }
    // 去掉 on* 属性
    var all = doc.body.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      var attrs = el.attributes ? Array.prototype.slice.call(el.attributes) : [];
      for (var k = 0; k < attrs.length; k++) {
        var n = attrs[k].name || '';
        if (/^on/i.test(n) || n === 'style') el.removeAttribute(n);
        if ((n === 'href' || n === 'src') && /^\s*javascript:/i.test(attrs[k].value || '')) {
          el.removeAttribute(n);
        }
      }
    }

    var out = nodesToMd(doc.body.childNodes).replace(/\n{3,}/g, '\n\n').trim();
    // 解析结果若丢掉了标记，回退 regex
    if (!out && raw) return htmlToMarkdownRegex(raw);
    return out;
  }

  /** 无 DOM 时的保守 regex 转换（Node 测试 / 残缺环境） */
  function htmlToMarkdownRegex(html) {
    var s = String(html || '');
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
    s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
    s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, function (_, lv, inner) {
      var hashes = '';
      for (var i = 0; i < +lv; i++) hashes += '#';
      return '\n' + hashes + ' ' + stripTags(inner).trim() + '\n\n';
    });
    s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, function (_, _t, inner) {
      return '**' + stripTags(inner) + '**';
    });
    s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, function (_, _t, inner) {
      return '*' + stripTags(inner) + '*';
    });
    s = s.replace(/<(s|strike|del)[^>]*>([\s\S]*?)<\/\1>/gi, function (_, _t, inner) {
      return '~~' + stripTags(inner) + '~~';
    });
    s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, function (_, inner) {
      return '`' + stripTags(inner).replace(/`/g, '') + '`';
    });
    s = s.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, function (_, href, inner) {
      if (/^\s*javascript:/i.test(href)) return stripTags(inner);
      return '[' + stripTags(inner) + '](' + href + ')';
    });
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/p>/gi, '\n\n');
    s = s.replace(/<\/div>/gi, '\n');
    s = s.replace(/<\/li>/gi, '\n');
    s = s.replace(/<li[^>]*>/gi, '- ');
    s = s.replace(/<hr\s*\/?>/gi, '\n---\n');
    s = stripTags(s);
    return s.replace(/\n{3,}/g, '\n\n').trim();
  }

  function stripTags(s) {
    return String(s || '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"');
  }

  function nodesToMd(nodes) {
    var out = '';
    for (var i = 0; i < nodes.length; i++) {
      out += nodeToMd(nodes[i]);
    }
    return out;
  }

  function nodeToMd(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    var tag = (node.tagName || '').toLowerCase();
    var inner = nodesToMd(node.childNodes);

    if (tag === 'br') return '\n';
    if (tag === 'strong' || tag === 'b') return inner ? '**' + inner + '**' : '';
    if (tag === 'em' || tag === 'i') return inner ? '*' + inner + '*' : '';
    if (tag === 's' || tag === 'strike' || tag === 'del') return inner ? '~~' + inner + '~~' : '';
    if (tag === 'code') {
      // 块级 pre>code 在 pre 处理
      if (node.parentNode && (node.parentNode.tagName || '').toLowerCase() === 'pre') {
        return inner;
      }
      return inner ? '`' + inner.replace(/`/g, '') + '`' : '';
    }
    if (tag === 'pre') {
      var code = node.querySelector && node.querySelector('code');
      var lang = '';
      if (code) {
        var cls = code.className || '';
        var m = cls.match(/language-([\w+-]+)/i) || cls.match(/lang-([\w+-]+)/i);
        if (m) lang = m[1];
        inner = code.textContent || '';
      } else {
        inner = node.textContent || '';
      }
      return '\n```' + lang + '\n' + String(inner).replace(/\n$/, '') + '\n```\n\n';
    }
    if (tag === 'a') {
      var href = node.getAttribute('href') || '';
      if (!href || /^javascript:/i.test(href)) return inner;
      return '[' + (inner || href) + '](' + href + ')';
    }
    if (tag === 'img') {
      var src = node.getAttribute('src') || '';
      var alt = node.getAttribute('alt') || '';
      if (!src || /^javascript:/i.test(src)) return '';
      return '![' + alt + '](' + src + ')';
    }
    if (/^h[1-6]$/.test(tag)) {
      var lv = parseInt(tag.charAt(1), 10);
      var hashes = '';
      for (var h = 0; h < lv; h++) hashes += '#';
      return '\n' + hashes + ' ' + inlinePlain(inner).trim() + '\n\n';
    }
    if (tag === 'li') {
      var parent = node.parentNode && (node.parentNode.tagName || '').toLowerCase();
      var marker = parent === 'ol' ? '1. ' : '- ';
      return marker + inlinePlain(inner).trim() + '\n';
    }
    if (tag === 'ul' || tag === 'ol') {
      return '\n' + nodesToMd(node.childNodes) + '\n';
    }
    if (tag === 'blockquote') {
      var q = inlinePlain(inner).trim().split('\n').map(function (l) {
        return '> ' + l;
      }).join('\n');
      return '\n' + q + '\n\n';
    }
    if (tag === 'hr') return '\n---\n\n';
    if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') {
      var t = inner.replace(/^\n+|\n+$/g, '');
      if (!t.trim()) return '\n';
      return '\n' + t + '\n\n';
    }
    if (tag === 'table') {
      return tableToMd(node) + '\n\n';
    }
    if (tag === 'br') return '\n';
    return inner;
  }

  function inlinePlain(s) {
    return String(s || '').replace(/\n+/g, ' ').replace(/\s+/g, ' ');
  }

  function tableToMd(table) {
    var rows = [];
    var trs = table.querySelectorAll('tr');
    for (var i = 0; i < trs.length; i++) {
      var cells = trs[i].querySelectorAll('th,td');
      var row = [];
      for (var c = 0; c < cells.length; c++) {
        row.push(inlinePlain(cells[c].textContent || '').replace(/\|/g, '\\|'));
      }
      if (row.length) rows.push(row);
    }
    if (!rows.length) return '';
    var cols = rows[0].length;
    var lines = [];
    lines.push('| ' + rows[0].join(' | ') + ' |');
    var sep = [];
    for (var s = 0; s < cols; s++) sep.push('---');
    lines.push('| ' + sep.join(' | ') + ' |');
    for (var r = 1; r < rows.length; r++) {
      while (rows[r].length < cols) rows[r].push('');
      lines.push('| ' + rows[r].join(' | ') + ' |');
    }
    return lines.join('\n');
  }

  /**
   * 将剪贴板内容解析为 Block 数组（无 id 的 partial 亦可）
   */
  function clipboardToBlocks(html, plain, types) {
    var kind = detectPasteKind(html, plain, types);
    if (kind === 'internal') {
      // 由调用方解析 JSON；此处回落 plain
      kind = looksLikeMarkdown(plain) ? 'markdown' : 'plain';
    }

    var md = '';
    if (kind === 'markdown') {
      md = String(plain || '');
    } else if (kind === 'html') {
      md = htmlToMarkdown(html);
      if (!md.trim() && plain) md = String(plain);
    } else {
      md = String(plain || '');
    }

    md = md.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
    if (!md) return { kind: kind, blocks: [], markdown: '' };

    // 单行且无结构：作为纯文本片段（不强制 parse 成多块）
    if (kind === 'plain' && md.indexOf('\n') < 0 && !looksLikeMarkdown(md)) {
      return {
        kind: 'plain',
        blocks: [{ type: 'paragraph', text: md }],
        markdown: md,
        inlineOnly: true,
      };
    }

    var P = Parse();
    if (P && typeof P.parse === 'function') {
      try {
        var doc = P.parse(md);
        var blocks = (doc && doc.blocks) || [];
        // 去掉唯一空段落噪声
        if (blocks.length === 1 && blocks[0].type === 'paragraph' && !(blocks[0].text || '').trim()) {
          return { kind: kind, blocks: [], markdown: md };
        }
        return { kind: kind, blocks: blocks, markdown: md };
      } catch (eParse) {
        /* fall through */
      }
    }
    return {
      kind: kind,
      blocks: [{ type: 'paragraph', text: md }],
      markdown: md,
    };
  }

  /**
   * 从 paste 事件取数据
   */
  function readClipboardEvent(e) {
    var cd = e && e.clipboardData;
    if (!cd) {
      return { html: '', plain: '', types: [], files: [] };
    }
    var types = [];
    try {
      if (cd.types) {
        for (var i = 0; i < cd.types.length; i++) types.push(cd.types[i]);
      }
    } catch (err) {
      /* ignore */
    }
    var plain = '';
    var html = '';
    try {
      plain = cd.getData('text/plain') || '';
    } catch (e1) {
      plain = '';
    }
    try {
      html = cd.getData('text/html') || '';
    } catch (e2) {
      html = '';
    }
    var files = [];
    if (cd.files && cd.files.length) {
      for (var f = 0; f < cd.files.length; f++) files.push(cd.files[f]);
    }
    return { html: html, plain: plain, types: types, files: files };
  }

  /**
   * 是否应交给本管道（非图片、非 code/math/table 专用表面）
   */
  function shouldHandlePaste(target, root) {
    if (!target || !root) return false;
    if (target.closest && target.closest('input, textarea')) return false;
    // 表单元格、代码/公式源：各自处理
    if (target.closest && target.closest('.mdx-td, [data-mdx-code-source], [data-mdx-math-source]')) {
      return false;
    }
    // 必须在编辑表面或块内
    if (target.closest && target.closest('[data-mdx-edit], .mdx-block, [data-mdx-root]')) {
      return true;
    }
    return root.contains(target);
  }

  /**
   * 绑定 root paste
   * @param {HTMLElement} root
   * @param {{
   *   viewOnly?: function|boolean,
   *   onPasteBlocks?: function(blocks, meta): boolean|void,
   *   onPasteInline?: function(text, meta): boolean|void,
   *   hasImageFiles?: function(e): boolean
   * }} host
   */
  function bind(root, host) {
    host = host || {};
    if (!root) return { destroy: function () {} };

    function isViewOnly() {
      if (typeof host.viewOnly === 'function') return !!host.viewOnly();
      return !!host.viewOnly;
    }

    function onPaste(e) {
      if (isViewOnly()) return;
      if (!shouldHandlePaste(e.target, root)) return;

      // 图片文件：让 media 模块处理
      if (host.hasImageFiles && host.hasImageFiles(e)) return;
      var data = readClipboardEvent(e);
      if (data.files && data.files.length) {
        var hasImg = false;
        for (var i = 0; i < data.files.length; i++) {
          if (data.files[i] && /^image\//i.test(data.files[i].type || '')) {
            hasImg = true;
            break;
          }
        }
        if (hasImg) return;
      }

      if (!data.plain && !data.html) return;

      var result = clipboardToBlocks(data.html, data.plain, data.types);
      var meta = {
        kind: result.kind,
        markdown: result.markdown,
        inlineOnly: !!result.inlineOnly,
        target: e.target,
      };

      // 单行纯文本 → 内联插入（保持光标处粘贴）
      if (result.inlineOnly && host.onPasteInline) {
        var handledInline = host.onPasteInline(result.markdown || data.plain, meta);
        if (handledInline !== false) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      if (host.onPasteBlocks && result.blocks && result.blocks.length) {
        var handled = host.onPasteBlocks(result.blocks, meta);
        if (handled !== false) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    }

    root.addEventListener('paste', onPaste, true);

    return {
      destroy: function () {
        root.removeEventListener('paste', onPaste, true);
      },
    };
  }

  window.MdxClipboardPaste = {
    INTERNAL_MIME: INTERNAL_MIME,
    detectPasteKind: detectPasteKind,
    looksLikeMarkdown: looksLikeMarkdown,
    htmlToMarkdown: htmlToMarkdown,
    clipboardToBlocks: clipboardToBlocks,
    readClipboardEvent: readClipboardEvent,
    shouldHandlePaste: shouldHandlePaste,
    bind: bind,
  };
})();
