/**
 * markdown-editor/inline/live-marks.js
 * 行内 as-you-type 折叠（F-INL-* / W4）+ caret 邻域定界符灰显（ux-D2）
 * - 非 composition 时 editor 调 applyLiveMarks
 * - htmlToInlineMd → parse → 闭合 mark 渲 HTML；未闭合定界符留源码
 * - caret 落在 mark MD 区间内时插入 .mdx-src-delim（灰 ** / * / ` 等）
 * - caret 用 MD 偏移保存/恢复；真实 delim 在 DOM 时不再虚拟叠加 open/close
 */
(function () {
  'use strict';

  function Model() {
    return window.MdxMarksModel;
  }
  function Util() {
    return window.MdxUtil;
  }

  function htmlToInlineMd(el) {
    if (Util() && typeof Util().htmlToInlineMd === 'function') return Util().htmlToInlineMd(el);
    if (!el) return '';
    var t = el.innerText != null ? el.innerText : el.textContent || '';
    return t.replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n');
  }

  /**
   * MD → 编辑态 HTML（闭合 → 标签，开放定界符保留）
   * @param {string} md
   * @param {{ caretMd?: number|null, showDelimsNearCaret?: boolean }} [opts]
   */
  function mdToEditHtml(md, opts) {
    var M = Model();
    if (!M) {
      return Util() && Util().inlineHtml
        ? Util().inlineHtml(md).replace(/\n/g, '<br>')
        : String(md == null ? '' : md);
    }
    return M.runsToEditHtml(M.parseInline(md), opts);
  }

  function isDelimNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.getAttribute && node.getAttribute('data-mdx-delim') != null) return true;
    var cls = node.className;
    if (typeof cls === 'string' && cls.indexOf('mdx-src-delim') >= 0) return true;
    if (node.classList && node.classList.contains && node.classList.contains('mdx-src-delim')) return true;
    return false;
  }

  /** 节点内（或自身）是否已有真实灰显定界符 */
  function hasRealDelims(node) {
    if (!node || node.nodeType !== 1) return false;
    if (isDelimNode(node)) return true;
    if (!node.querySelector) return false;
    try {
      return !!node.querySelector('[data-mdx-delim], .mdx-src-delim');
    } catch (e) {
      return false;
    }
  }

  /**
   * 语义标签的虚拟 open/close 长度。
   * 若 node 内已有 [data-mdx-delim]，返回 {open:0,close:0}（真实定界符在 DOM 文本里计）。
   */
  function delimLens(tag, node) {
    // 真实定界符已在 DOM：父 mark 不再叠加虚拟 open/close
    if (node && hasRealDelims(node)) {
      return { open: 0, close: 0 };
    }
    tag = (tag || '').toLowerCase();
    if (tag === 'strong' || tag === 'b') return { open: 2, close: 2 };
    if (tag === 'em' || tag === 'i') return { open: 1, close: 1 };
    if (tag === 'del' || tag === 's' || tag === 'strike') return { open: 2, close: 2 };
    if (tag === 'code') return { open: 1, close: 1 };
    if (tag === 'mark') return { open: 2, close: 2 };
    if (tag === 'u') return { open: 2, close: 2 };
    if (tag === 'a') {
      var href = (node && node.getAttribute && node.getAttribute('href')) || '';
      return { open: 1, close: 3 + String(href).length }; // [text](url)
    }
    if (tag === 'br') return { open: 0, close: 0, br: true };
    return { open: 0, close: 0 };
  }

  function nodeMdLength(node) {
    if (!node) return 0;
    if (node.nodeType === 3) return (node.nodeValue || '').length;
    if (node.nodeType !== 1) return 0;
    // span[data-mdx-delim]：计其文本长度（作为普通元素下的 text）
    var d = delimLens(node.tagName, node);
    if (d.br) return 1;
    var inner = 0;
    for (var i = 0; i < node.childNodes.length; i++) inner += nodeMdLength(node.childNodes[i]);
    return d.open + inner + d.close;
  }

  function firstText(node) {
    if (!node) return null;
    if (node.nodeType === 3) return node;
    for (var i = 0; i < node.childNodes.length; i++) {
      var f = firstText(node.childNodes[i]);
      if (f) return f;
    }
    return null;
  }

  function lastText(node) {
    if (!node) return null;
    if (node.nodeType === 3) return node;
    for (var i = node.childNodes.length - 1; i >= 0; i--) {
      var f = lastText(node.childNodes[i]);
      if (f) return f;
    }
    return null;
  }

  /** 跳过 contenteditable=false 的定界符，找可放 caret 的文本 */
  function firstEditableText(node) {
    if (!node) return null;
    if (node.nodeType === 3) {
      var p = node.parentNode;
      if (p && isDelimNode(p)) return null;
      return node;
    }
    if (node.nodeType !== 1) return null;
    if (isDelimNode(node)) return null;
    for (var i = 0; i < node.childNodes.length; i++) {
      var f = firstEditableText(node.childNodes[i]);
      if (f) return f;
    }
    return null;
  }

  function lastEditableText(node) {
    if (!node) return null;
    if (node.nodeType === 3) {
      var p = node.parentNode;
      if (p && isDelimNode(p)) return null;
      return node;
    }
    if (node.nodeType !== 1) return null;
    if (isDelimNode(node)) return null;
    for (var i = node.childNodes.length - 1; i >= 0; i--) {
      var f = lastEditableText(node.childNodes[i]);
      if (f) return f;
    }
    return null;
  }

  function setRange(node, offset, collapseEnd) {
    try {
      var r = document.createRange();
      if (node.nodeType === 3) {
        var len = (node.nodeValue || '').length;
        r.setStart(node, Math.max(0, Math.min(offset, len)));
      } else if (collapseEnd) {
        r.selectNodeContents(node);
        r.collapse(false);
      } else {
        r.setStart(node, offset || 0);
      }
      r.collapse(true);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** DOM 光标 → 行内 MD 偏移（语义标签按定界符计入） */
  function getCaretMdOffset(editEl) {
    if (!editEl) return 0;
    var sel = window.getSelection && window.getSelection();
    if (!sel || !sel.rangeCount) return htmlToInlineMd(editEl).length;
    var range = sel.getRangeAt(0);
    if (!editEl.contains(range.startContainer)) return 0;
    var target = range.startContainer;
    var targetOff = range.startOffset;
    var md = 0;
    var found = false;

    function walk(node) {
      if (found || !node) return;
      if (node.nodeType === 3) {
        if (node === target) {
          md += Math.min(targetOff, (node.nodeValue || '').length);
          found = true;
        } else md += (node.nodeValue || '').length;
        return;
      }
      if (node.nodeType !== 1) return;
      if (node === target) {
        var d0 = delimLens(node.tagName, node);
        md += d0.open;
        for (var c = 0; c < targetOff && c < node.childNodes.length; c++) {
          md += nodeMdLength(node.childNodes[c]);
        }
        found = true;
        return;
      }
      var d = delimLens(node.tagName, node);
      if (d.br) {
        md += 1;
        return;
      }
      md += d.open;
      for (var i = 0; i < node.childNodes.length; i++) {
        walk(node.childNodes[i]);
        if (found) return;
      }
      md += d.close;
    }

    for (var i = 0; i < editEl.childNodes.length; i++) {
      walk(editEl.childNodes[i]);
      if (found) break;
    }
    return found ? md : htmlToInlineMd(editEl).length;
  }

  /**
   * 将光标放到 MD 偏移处。
   * 落在 contenteditable=false 的定界符上时吸附到内容边界。
   */
  function setCaretMdOffset(editEl, mdOffset) {
    if (!editEl) return;
    var left = Math.max(0, mdOffset | 0);
    var placed = false;

    function placeAfterDelim(delimNode) {
      var n = delimNode.nextSibling;
      while (n && isDelimNode(n)) n = n.nextSibling;
      if (n) {
        var ft = firstEditableText(n) || firstText(n);
        if (ft) return setRange(ft, 0);
      }
      var parent = delimNode.parentNode;
      if (parent) {
        var ft2 = firstEditableText(parent);
        if (ft2) return setRange(ft2, 0);
      }
      return false;
    }

    function placeBeforeDelim(delimNode) {
      var p = delimNode.previousSibling;
      while (p && isDelimNode(p)) p = p.previousSibling;
      if (p) {
        var lt = lastEditableText(p) || lastText(p);
        if (lt) return setRange(lt, (lt.nodeValue || '').length);
      }
      var parent = delimNode.parentNode;
      if (parent) {
        var lt2 = lastEditableText(parent);
        if (lt2) return setRange(lt2, (lt2.nodeValue || '').length);
      }
      return false;
    }

    function walk(node) {
      if (placed || !node) return;
      if (node.nodeType === 3) {
        var len = (node.nodeValue || '').length;
        // 文本若在定界符内：吸附
        if (node.parentNode && isDelimNode(node.parentNode)) {
          var dlen = len;
          if (left <= dlen) {
            var delim = node.parentNode;
            // open（前无兄弟内容）→ 内容起点；close → 内容末尾
            if (!delim.previousSibling || isDelimNode(delim.previousSibling)) {
              placed = placeAfterDelim(delim);
            } else {
              placed = placeBeforeDelim(delim);
            }
            return;
          }
          left -= dlen;
          return;
        }
        if (left <= len) {
          placed = setRange(node, left);
          return;
        }
        left -= len;
        return;
      }
      if (node.nodeType !== 1) return;

      // 整节点是定界符：按文本长度计，落点吸附
      if (isDelimNode(node)) {
        var dSpan = nodeMdLength(node);
        if (left <= dSpan) {
          if (!node.previousSibling || isDelimNode(node.previousSibling)) {
            placed = placeAfterDelim(node);
          } else {
            placed = placeBeforeDelim(node);
          }
          return;
        }
        left -= dSpan;
        return;
      }

      var d = delimLens(node.tagName, node);
      if (d.br) {
        if (left <= 1) {
          try {
            var rb = document.createRange();
            rb.setStartAfter(node);
            rb.collapse(true);
            var sb = window.getSelection();
            sb.removeAllRanges();
            sb.addRange(rb);
            placed = true;
          } catch (e) {
            /* ignore */
          }
          return;
        }
        left -= 1;
        return;
      }
      if (left < d.open) {
        var ft = firstEditableText(node) || firstText(node);
        placed = ft ? setRange(ft, 0) : setRange(node, 0);
        return;
      }
      left -= d.open;
      for (var i = 0; i < node.childNodes.length; i++) {
        walk(node.childNodes[i]);
        if (placed) return;
      }
      if (left < d.close) {
        var lt = lastEditableText(node) || lastText(node);
        placed = lt ? setRange(lt, (lt.nodeValue || '').length) : false;
        return;
      }
      left -= d.close;
    }

    for (var j = 0; j < editEl.childNodes.length; j++) {
      walk(editEl.childNodes[j]);
      if (placed) break;
    }
    if (!placed) setRange(editEl, 0, true);
  }

  /** 视觉纯文本偏移 */
  function getCaretOffset(editEl) {
    if (!editEl) return 0;
    var sel = window.getSelection && window.getSelection();
    if (!sel || !sel.rangeCount) {
      var t = editEl.innerText != null ? editEl.innerText : editEl.textContent || '';
      return t.length;
    }
    var range = sel.getRangeAt(0);
    if (!editEl.contains(range.startContainer)) return 0;
    try {
      var pre = document.createRange();
      pre.selectNodeContents(editEl);
      pre.setEnd(range.startContainer, range.startOffset);
      return pre.toString().length;
    } catch (e) {
      return 0;
    }
  }

  function setCaretOffset(editEl, offset) {
    if (!editEl) return;
    var left = Math.max(0, offset | 0);
    var placed = false;
    function walk(node) {
      if (placed || !node) return;
      if (node.nodeType === 3) {
        var len = (node.nodeValue || '').length;
        if (left <= len) {
          placed = setRange(node, left);
          return;
        }
        left -= len;
        return;
      }
      if (node.nodeType !== 1) return;
      if ((node.tagName || '').toLowerCase() === 'br') {
        if (left <= 0) {
          try {
            var rb = document.createRange();
            rb.setStartAfter(node);
            rb.collapse(true);
            var sb = window.getSelection();
            sb.removeAllRanges();
            sb.addRange(rb);
            placed = true;
          } catch (e2) {
            /* ignore */
          }
          return;
        }
        left -= 1;
        return;
      }
      // 视觉偏移：delim 文本仍占位（innerText 可见）
      for (var i = 0; i < node.childNodes.length; i++) {
        walk(node.childNodes[i]);
        if (placed) return;
      }
    }
    for (var j = 0; j < editEl.childNodes.length; j++) {
      walk(editEl.childNodes[j]);
      if (placed) break;
    }
    if (!placed) setRange(editEl, 0, true);
  }

  /**
   * HTML 规范化比较：压缩无关空白，保留 delim / mark 语义属性差异
   * （避免仅空白/属性序导致的无意义整段刷新）
   */
  function normalizeHtml(h) {
    return String(h || '')
      .replace(/\u00a0/g, ' ')
      .replace(/<br\s*\/?>/gi, '<br>')
      // 标签间空白
      .replace(/>\s+</g, '><')
      // 属性间多余空白
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+>/g, '>')
      .trim();
  }

  /** 语义 MD + reveal 指纹：无变化则跳过 innerHTML */
  function revealKey(md, caretMd) {
    var M = Model();
    if (M && typeof M.computeRevealKey === 'function') {
      return M.computeRevealKey(md, caretMd);
    }
    return String(caretMd == null ? '' : caretMd);
  }

  function bindLinkGuard(editEl) {
    if (!editEl || editEl._mdxLinkGuard) return;
    editEl._mdxLinkGuard = true;
    editEl.addEventListener(
      'click',
      function (e) {
        var a = e.target && e.target.closest && e.target.closest('a.mdx-a, a[data-mdx-link]');
        if (!a || !editEl.contains(a)) return;
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
      },
      true
    );
  }

  /**
   * 绑定 caret 移动后刷新邻域定界符（keyup / mouseup / click / selectionchange）
   * composition 期间跳过，避免 IME 乱闪
   */
  function bindCaretRefresh(editEl) {
    if (!editEl || editEl._mdxDelimCaretBound) return;
    editEl._mdxDelimCaretBound = true;
    var timer = null;

    function schedule() {
      if (editEl._mdxLiveComposing || editEl._mdxLiveApplying) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        if (editEl._mdxLiveComposing || editEl._mdxLiveApplying) return;
        try {
          var sel = window.getSelection && window.getSelection();
          // 仅当选区仍在本编辑根内时刷新（避免失焦 caretMd=0 误 reveal 首 mark）
          if (!sel || !sel.rangeCount || !editEl.contains(sel.anchorNode)) return;
        } catch (e) {
          return;
        }
        applyLiveMarks(editEl);
      }, 48);
    }

    editEl.addEventListener('compositionstart', function () {
      editEl._mdxLiveComposing = true;
    });
    editEl.addEventListener('compositionend', function () {
      editEl._mdxLiveComposing = false;
      schedule();
    });
    editEl.addEventListener('keyup', schedule);
    editEl.addEventListener('mouseup', schedule);
    editEl.addEventListener('click', schedule);

    function onSelChange() {
      try {
        var sel = window.getSelection && window.getSelection();
        if (!sel || !sel.rangeCount) return;
        if (!editEl.contains(sel.anchorNode)) return;
        schedule();
      } catch (e2) {
        /* ignore */
      }
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('selectionchange', onSelChange);
      editEl._mdxDelimOnSelChange = onSelChange;
    }
  }

  /**
   * as-you-type：闭合定界符 → strong/em…；caret 邻域灰显 delim；保持 caret
   * 防闪：仅当语义 MD 或 reveal 集合变化时整段刷新；normalize 忽略无关空白
   * @returns {boolean}
   */
  function applyLiveMarks(editEl) {
    if (!editEl || !editEl.isContentEditable) return false;
    if (editEl.getAttribute && editEl.getAttribute('data-mdx-code-source') != null) return false;
    if (editEl._mdxLiveComposing) return false;
    if (editEl._mdxLiveApplying) return false;

    bindCaretRefresh(editEl);

    editEl._mdxLiveApplying = true;
    try {
      var md = htmlToInlineMd(editEl);
      var caretMd = getCaretMdOffset(editEl);
      var rKey = revealKey(md, caretMd);

      // 语义 + reveal 均未变：跳过（caret 在同一 mark 内滑动最常见）
      if (editEl._mdxLiveMd === md && editEl._mdxLiveRevealKey === rKey) {
        return false;
      }

      var next = mdToEditHtml(md, {
        caretMd: caretMd,
        showDelimsNearCaret: true,
      });
      var cur = editEl.innerHTML || '';
      if (!md && !cur.replace(/<br\s*\/?>/gi, '').trim()) {
        editEl._mdxLiveMd = md;
        editEl._mdxLiveRevealKey = rKey;
        return false;
      }
      // delim 显隐 / 折叠变化才写 DOM；normalize 忽略无关空白
      if (normalizeHtml(cur) === normalizeHtml(next)) {
        editEl._mdxLiveMd = md;
        editEl._mdxLiveRevealKey = rKey;
        return false;
      }

      editEl.innerHTML = next || '';
      editEl._mdxLiveMd = md;
      editEl._mdxLiveRevealKey = rKey;
      setCaretMdOffset(editEl, caretMd);
      bindLinkGuard(editEl);
      return true;
    } finally {
      editEl._mdxLiveApplying = false;
    }
  }

  /** 仅按当前 caret 刷新邻域定界符（applyLiveMarks 别名） */
  function refreshDelimsNearCaret(editEl) {
    return applyLiveMarks(editEl);
  }

  window.MdxLiveMarks = {
    applyLiveMarks: applyLiveMarks,
    refreshDelimsNearCaret: refreshDelimsNearCaret,
    htmlToInlineMd: htmlToInlineMd,
    mdToEditHtml: mdToEditHtml,
    getCaretOffset: getCaretOffset,
    setCaretOffset: setCaretOffset,
    getCaretMdOffset: getCaretMdOffset,
    setCaretMdOffset: setCaretMdOffset,
    bindCaretRefresh: bindCaretRefresh,
    normalizeHtml: normalizeHtml,
  };

  if (window.MdxUtil && typeof window.MdxUtil.applyLiveMarks !== 'function') {
    window.MdxUtil.applyLiveMarks = function (el) {
      return applyLiveMarks(el);
    };
  }
})();
