/**
 * markdown-editor/inline/marks-model.js
 * 行内 Markdown ↔ 扁平 runs（F-INL-*）
 *
 * run: { type: 'text'|'bold'|'italic'|'strike'|'code'|'link'|'highlight'|'underline', text, href? }
 * 不嵌套树：内容区可递归解析（code 除外）再展平。
 */
(function () {
  'use strict';

  function esc(s) {
    if (window.MdxUtil && window.MdxUtil.esc) return window.MdxUtil.esc(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function pushText(runs, buf) {
    if (!buf) return;
    var last = runs.length ? runs[runs.length - 1] : null;
    if (last && last.type === 'text') {
      last.text += buf;
    } else {
      runs.push({ type: 'text', text: buf });
    }
  }

  function pushRun(runs, run) {
    if (!run || run.text == null || run.text === '') return;
    var last = runs.length ? runs[runs.length - 1] : null;
    if (last && last.type === run.type && run.type !== 'link' && last.href === run.href) {
      last.text += run.text;
      return;
    }
    runs.push(run);
  }

  /**
   * 解析行内 MD → runs
   * 仅闭合定界符成为 mark；未闭合的 * ` ~ = + [ 留在 text 中（源码可见）
   */
  function parseInline(md) {
    md = String(md == null ? '' : md);
    var runs = [];
    var i = 0;
    var n = md.length;
    var textBuf = '';

    function flushText() {
      if (textBuf) {
        pushText(runs, textBuf);
        textBuf = '';
      }
    }

    function isSpace(ch) {
      return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
    }

    /** 在 [from, end) 找 token，不跨 \n（行内 marks 不跨行） */
    function findClose(token, from) {
      var idx = md.indexOf(token, from);
      while (idx >= 0) {
        var chunk = md.slice(from, idx);
        if (chunk.indexOf('\n') >= 0) return -1;
        return idx;
      }
      return -1;
    }

    while (i < n) {
      var ch = md.charAt(i);

      // 行内代码 `...`（最高优先）
      if (ch === '`') {
        var cEnd = findClose('`', i + 1);
        if (cEnd > i + 1) {
          // 内容非空
          flushText();
          var codeInner = md.slice(i + 1, cEnd);
          pushRun(runs, { type: 'code', text: codeInner });
          i = cEnd + 1;
          continue;
        }
        textBuf += ch;
        i += 1;
        continue;
      }

      // 链接 [text](url)
      if (ch === '[') {
        var rb = md.indexOf('](', i + 1);
        if (rb > i + 1) {
          var mid = md.slice(i + 1, rb);
          if (mid.indexOf('\n') < 0) {
            var rp = md.indexOf(')', rb + 2);
            if (rp > rb + 2) {
              var url = md.slice(rb + 2, rp).trim();
              if (url && mid) {
                flushText();
                // label 可含简单 marks：递归解析后再标为 link 不方便；W4：label 纯文本
                pushRun(runs, { type: 'link', text: mid, href: url });
                i = rp + 1;
                continue;
              }
            }
          }
        }
        textBuf += ch;
        i += 1;
        continue;
      }

      // 粗体 **...**
      if (ch === '*' && md.charAt(i + 1) === '*') {
        var bEnd = findClose('**', i + 2);
        if (bEnd > i + 2) {
          var bInner = md.slice(i + 2, bEnd);
          if (bInner && !isSpace(bInner.charAt(0)) && !isSpace(bInner.charAt(bInner.length - 1))) {
            flushText();
            var bParsed = parseInline(bInner);
            // 内容若全是 text，标 bold；若有嵌套 marks 保留内层
            if (bParsed.length === 1 && bParsed[0].type === 'text') {
              pushRun(runs, { type: 'bold', text: bParsed[0].text });
            } else {
              for (var bi = 0; bi < bParsed.length; bi++) {
                var br = bParsed[bi];
                if (br.type === 'text') pushRun(runs, { type: 'bold', text: br.text });
                else pushRun(runs, br);
              }
            }
            i = bEnd + 2;
            continue;
          }
        }
        textBuf += '**';
        i += 2;
        continue;
      }

      // 删除线 ~~...~~
      if (ch === '~' && md.charAt(i + 1) === '~') {
        var sEnd = findClose('~~', i + 2);
        if (sEnd > i + 2) {
          var sInner = md.slice(i + 2, sEnd);
          if (sInner) {
            flushText();
            pushRun(runs, { type: 'strike', text: sInner });
            i = sEnd + 2;
            continue;
          }
        }
        textBuf += '~~';
        i += 2;
        continue;
      }

      // 高亮 ==...==（P1 扩展）
      if (ch === '=' && md.charAt(i + 1) === '=') {
        var hEnd = findClose('==', i + 2);
        if (hEnd > i + 2) {
          var hInner = md.slice(i + 2, hEnd);
          if (hInner) {
            flushText();
            pushRun(runs, { type: 'highlight', text: hInner });
            i = hEnd + 2;
            continue;
          }
        }
        textBuf += '==';
        i += 2;
        continue;
      }

      // 下划线 ++...++（P1 扩展）
      if (ch === '+' && md.charAt(i + 1) === '+') {
        var uEnd = findClose('++', i + 2);
        if (uEnd > i + 2) {
          var uInner = md.slice(i + 2, uEnd);
          if (uInner) {
            flushText();
            pushRun(runs, { type: 'underline', text: uInner });
            i = uEnd + 2;
            continue;
          }
        }
        textBuf += '++';
        i += 2;
        continue;
      }

      // 斜体 *...*（非 **；内侧不贴空格）
      if (ch === '*') {
        var iEnd = -1;
        var j = i + 1;
        while (j < n) {
          if (md.charAt(j) === '\n') break;
          if (md.charAt(j) === '*' && md.charAt(j + 1) === '*') {
            j += 2;
            continue;
          }
          if (md.charAt(j) === '*') {
            iEnd = j;
            break;
          }
          j += 1;
        }
        if (iEnd > i + 1) {
          var iInner = md.slice(i + 1, iEnd);
          if (
            iInner &&
            !isSpace(iInner.charAt(0)) &&
            !isSpace(iInner.charAt(iInner.length - 1))
          ) {
            flushText();
            pushRun(runs, { type: 'italic', text: iInner });
            i = iEnd + 1;
            continue;
          }
        }
        textBuf += '*';
        i += 1;
        continue;
      }

      textBuf += ch;
      i += 1;
    }

    flushText();
    return runs;
  }

  /** runs → 行内 Markdown */
  function serializeRuns(runs) {
    if (!runs || !runs.length) return '';
    var out = '';
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      var t = r.text == null ? '' : String(r.text);
      switch (r.type) {
        case 'bold':
          out += '**' + t + '**';
          break;
        case 'italic':
          out += '*' + t + '*';
          break;
        case 'strike':
          out += '~~' + t + '~~';
          break;
        case 'code':
          out += '`' + t.replace(/`/g, '') + '`';
          break;
        case 'highlight':
          out += '==' + t + '==';
          break;
        case 'underline':
          out += '++' + t + '++';
          break;
        case 'link':
          out += '[' + t + '](' + (r.href || '') + ')';
          break;
        default:
          out += t;
      }
    }
    return out;
  }

  /** 定界符元数据（快捷键 / wrap 用） */
  var DELIMS = {
    bold: { open: '**', close: '**' },
    italic: { open: '*', close: '*' },
    strike: { open: '~~', close: '~~' },
    code: { open: '`', close: '`' },
    highlight: { open: '==', close: '==' },
    underline: { open: '++', close: '++' },
  };

  /**
   * 单个 run 的 open/close 定界符（与 serializeRuns 一致；link 含 url）
   * @returns {{ open: string, close: string } | null}
   */
  function runOpenClose(r) {
    if (!r || !r.type || r.type === 'text') return null;
    if (r.type === 'link') {
      return { open: '[', close: '](' + String(r.href || '') + ')' };
    }
    var d = DELIMS[r.type];
    if (!d) return null;
    return { open: d.open, close: d.close };
  }

  /** 序列化后该 run 占用的 MD 字符数（与 serializeRuns / htmlToInlineMd 对齐） */
  function runSerializedLength(r) {
    if (!r) return 0;
    var t = r.text == null ? '' : String(r.text);
    if (r.type === 'code') t = t.replace(/`/g, '');
    var d = runOpenClose(r);
    if (!d) return t.length;
    return d.open.length + t.length + d.close.length;
  }

  /**
   * 第 index 个 run 在 serialize 后的 MD 半开区间 [start, end)
   * @returns {{ start: number, end: number, open: string, close: string, type: string }}
   */
  function runMdSpan(runs, index) {
    var start = 0;
    var i;
    if (!runs || !runs.length || index < 0) {
      return { start: 0, end: 0, open: '', close: '', type: 'text' };
    }
    for (i = 0; i < index && i < runs.length; i++) {
      start += runSerializedLength(runs[i]);
    }
    if (index >= runs.length) {
      return { start: start, end: start, open: '', close: '', type: 'text' };
    }
    var r = runs[index];
    var d = runOpenClose(r) || { open: '', close: '' };
    var len = runSerializedLength(r);
    return {
      start: start,
      end: start + len,
      open: d.open,
      close: d.close,
      type: r.type || 'text',
    };
  }

  /** 灰显定界符节点（contenteditable=false，避免半删非法 MD） */
  function delimHtml(token) {
    var tok = String(token == null ? '' : token);
    return (
      '<span class="mdx-src-delim" data-mdx-delim="' +
      esc(tok) +
      '" contenteditable="false">' +
      esc(tok) +
      '</span>'
    );
  }

  /**
   * runs → 编辑态 HTML（闭合 marks 为语义标签；text 中的未闭合定界符原样转义）
   *
   * opts:
   *   caretMd {number|null} — 行内 MD 语义偏移；null/undefined 时默认不灰显定界符
   *   showDelimsNearCaret {boolean} — 默认：当 caretMd != null 时为 true
   *
   * ux-D2 选项 A：仅 caret 落在该 mark 的 MD 区间（含 open/close）时插入 .mdx-src-delim
   */
  function runsToEditHtml(runs, opts) {
    if (!runs || !runs.length) return '';
    opts = opts || {};
    var caretMd = opts.caretMd;
    var hasCaret = caretMd != null && caretMd === caretMd; /* not NaN */
    var showNear =
      opts.showDelimsNearCaret !== undefined ? !!opts.showDelimsNearCaret : hasCaret;

    var html = '';
    var mdPos = 0;
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      var raw = r.text == null ? '' : String(r.text);
      var t = esc(raw).replace(/\n/g, '<br>');
      var d = runOpenClose(r);
      var spanLen = runSerializedLength(r);
      var spanStart = mdPos;
      var spanEnd = mdPos + spanLen;
      mdPos = spanEnd;

      // 邻域：caret 在 [openStart, closeEnd]（含紧贴 close 之后的折叠位置）
      var near =
        showNear &&
        hasCaret &&
        d &&
        caretMd >= spanStart &&
        caretMd <= spanEnd;

      switch (r.type) {
        case 'bold':
          if (near) {
            html +=
              '<strong class="mdx-mark-near" data-mdx-mark="bold">' +
              delimHtml('**') +
              t +
              delimHtml('**') +
              '</strong>';
          } else {
            html += '<strong>' + t + '</strong>';
          }
          break;
        case 'italic':
          if (near) {
            html +=
              '<em class="mdx-mark-near" data-mdx-mark="italic">' +
              delimHtml('*') +
              t +
              delimHtml('*') +
              '</em>';
          } else {
            html += '<em>' + t + '</em>';
          }
          break;
        case 'strike':
          if (near) {
            html +=
              '<del class="mdx-mark-near" data-mdx-mark="strike">' +
              delimHtml('~~') +
              t +
              delimHtml('~~') +
              '</del>';
          } else {
            html += '<del>' + t + '</del>';
          }
          break;
        case 'code':
          if (near) {
            html +=
              '<code class="mdx-code mdx-mark-near" data-mdx-mark="code">' +
              delimHtml('`') +
              t +
              delimHtml('`') +
              '</code>';
          } else {
            html += '<code class="mdx-code">' + t + '</code>';
          }
          break;
        case 'highlight':
          if (near) {
            html +=
              '<mark class="mdx-mark-hl mdx-mark-near" data-mdx-mark="highlight">' +
              delimHtml('==') +
              t +
              delimHtml('==') +
              '</mark>';
          } else {
            html += '<mark class="mdx-mark-hl">' + t + '</mark>';
          }
          break;
        case 'underline':
          if (near) {
            html +=
              '<u class="mdx-mark-near" data-mdx-mark="underline">' +
              delimHtml('++') +
              t +
              delimHtml('++') +
              '</u>';
          } else {
            html += '<u>' + t + '</u>';
          }
          break;
        case 'link': {
          var href = String(r.href || '');
          // 编辑态禁止 javascript:
          if (/^\s*javascript:/i.test(href)) href = '#';
          var openL = '[';
          var closeL = '](' + href + ')';
          if (near) {
            html +=
              '<a class="mdx-a mdx-mark-near" href="' +
              esc(href) +
              '" data-mdx-link="1" data-mdx-mark="link" rel="noopener noreferrer">' +
              delimHtml(openL) +
              t +
              delimHtml(closeL) +
              '</a>';
          } else {
            html +=
              '<a class="mdx-a" href="' +
              esc(href) +
              '" data-mdx-link="1" rel="noopener noreferrer">' +
              t +
              '</a>';
          }
          break;
        }
        default:
          html += t;
      }
    }
    return html;
  }

  function wrapText(type, text) {
    var d = DELIMS[type];
    if (!d) return text;
    return d.open + (text == null ? '' : text) + d.close;
  }

  /** 若整段已被该 mark 包裹则剥除，否则包裹 */
  function toggleWrapMd(type, selectedMd) {
    var d = DELIMS[type];
    if (!d) return selectedMd;
    var s = String(selectedMd == null ? '' : selectedMd);
    if (type === 'link') return s;
    if (s.indexOf(d.open) === 0 && s.lastIndexOf(d.close) === s.length - d.close.length && s.length > d.open.length + d.close.length) {
      return s.slice(d.open.length, s.length - d.close.length);
    }
    // 也识别 HTML 往返后的纯内容再包
    return d.open + s + d.close;
  }

  /** 合并相邻 text run（unwrap 后展平） */
  function mergeAdjacentTextRuns(runs) {
    if (!runs || !runs.length) return [];
    var out = [];
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      if (!r) continue;
      var last = out.length ? out[out.length - 1] : null;
      if (r.type === 'text' && last && last.type === 'text') {
        last.text = String(last.text || '') + String(r.text || '');
      } else {
        out.push({
          type: r.type,
          text: r.text == null ? '' : String(r.text),
          href: r.href,
        });
      }
    }
    return out;
  }

  /**
   * caret 邻域 reveal 指纹（仅 mark 索引+类型）；用于 applyLiveMarks 跳过无意义整段刷新
   * @param {string} md
   * @param {number|null|undefined} caretMd
   * @returns {string}
   */
  function computeRevealKey(md, caretMd) {
    if (caretMd == null || caretMd !== caretMd) return '';
    var runs = parseInline(md);
    if (!runs.length) return '';
    var keys = [];
    var mdPos = 0;
    var c = caretMd | 0;
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      var d = runOpenClose(r);
      var len = runSerializedLength(r);
      var start = mdPos;
      var end = mdPos + len;
      mdPos = end;
      if (!d || r.type === 'text') continue;
      if (c >= start && c <= end) {
        keys.push(i + ':' + (r.type || ''));
      }
    }
    return keys.join('|');
  }

  /**
   * 在 caret 边界成对去掉 open+close 定界符，保留内文（unwrap mark → 纯文本）
   *
   * Backspace：
   *   - caret 在 open 后 / 内文起点 → unwrap，caret 落在纯文起点
   *   - caret 在 close 内或紧贴 close 后 → unwrap，caret 落在纯文末
   * Delete：
   *   - caret 在 open 前 / open 内 → unwrap，caret 落在纯文起点
   *   - caret 在内文末（close 前）或 close 内 → unwrap，caret 落在纯文末
   *
   * @param {string} md
   * @param {number} caretMd
   * @param {'backspace'|'delete'} dir
   * @returns {{ md: string, caretMd: number, type: string } | null}
   */
  function tryPairUnwrapMd(md, caretMd, dir) {
    md = String(md == null ? '' : md);
    caretMd = caretMd | 0;
    dir = dir === 'delete' ? 'delete' : 'backspace';
    var runs = parseInline(md);
    if (!runs.length) return null;

    var best = null;
    var mdPos = 0;
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      var d = runOpenClose(r);
      var len = runSerializedLength(r);
      var start = mdPos;
      var end = mdPos + len;
      mdPos = end;
      if (!d || !r.type || r.type === 'text') continue;
      var oLen = d.open.length;
      var cLen = d.close.length;
      if (oLen + cLen >= len) continue;
      var contentStart = start + oLen;
      var contentEnd = end - cLen;
      if (contentEnd < contentStart) continue;
      var text = r.text == null ? '' : String(r.text);
      if (r.type === 'code') text = text.replace(/`/g, '');

      var hit = false;
      var place = 'start'; // 'start' | 'end'
      if (dir === 'backspace') {
        // 开 delim 之后（含落在 open 字符上）→ 内文起点
        if (caretMd > start && caretMd <= contentStart) {
          hit = true;
          place = 'start';
        } else if (caretMd > contentEnd && caretMd <= end) {
          // close 内或紧贴 close 后
          hit = true;
          place = 'end';
        }
      } else {
        // delete：open 前或 open 内
        if (caretMd >= start && caretMd < contentStart) {
          hit = true;
          place = 'start';
        } else if (caretMd >= contentEnd && caretMd < end) {
          // 内文末（删 close）或 close 内
          hit = true;
          place = 'end';
        }
      }
      if (!hit) continue;
      // 重叠时取 start 更大者（更靠后 / 更「内」）
      if (!best || start >= best.start) {
        best = {
          index: i,
          start: start,
          contentStart: contentStart,
          contentEnd: contentEnd,
          end: end,
          text: text,
          type: r.type,
          place: place,
        };
      }
    }
    if (!best) return null;

    var nextRuns = [];
    for (var j = 0; j < runs.length; j++) {
      if (j === best.index) {
        nextRuns.push({ type: 'text', text: best.text });
      } else {
        nextRuns.push(runs[j]);
      }
    }
    nextRuns = mergeAdjacentTextRuns(nextRuns);
    var newMd = serializeRuns(nextRuns);
    var newCaret =
      best.place === 'end' ? best.start + best.text.length : best.start;
    if (newCaret < 0) newCaret = 0;
    if (newCaret > newMd.length) newCaret = newMd.length;
    return { md: newMd, caretMd: newCaret, type: best.type };
  }

  window.MdxMarksModel = {
    parseInline: parseInline,
    serializeRuns: serializeRuns,
    runsToEditHtml: runsToEditHtml,
    runMdSpan: runMdSpan,
    runSerializedLength: runSerializedLength,
    runOpenClose: runOpenClose,
    wrapText: wrapText,
    toggleWrapMd: toggleWrapMd,
    tryPairUnwrapMd: tryPairUnwrapMd,
    computeRevealKey: computeRevealKey,
    mergeAdjacentTextRuns: mergeAdjacentTextRuns,
    DELIMS: DELIMS,
    esc: esc,
  };
})();
