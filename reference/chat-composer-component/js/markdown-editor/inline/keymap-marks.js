/**
 * markdown-editor/inline/keymap-marks.js
 * 行内格式快捷键（无浮动 sel-bar 依赖）
 *
 * Ctrl/Cmd+B 粗体 · I 斜体 · Shift+S / Shift+X 删除线 · E 行内代码
 * 可选：Shift+H 高亮 · U 下划线
 */
(function () {
  'use strict';

  function Live() {
    return window.MdxLiveMarks;
  }
  function Marks() {
    return window.MdxMarksModel;
  }
  function Util() {
    return window.MdxUtil;
  }

  function isMod(e) {
    return !!(e.metaKey || e.ctrlKey);
  }

  function htmlToInlineMd(el) {
    if (Live() && Live().htmlToInlineMd) return Live().htmlToInlineMd(el);
    if (Util() && Util().htmlToInlineMd) return Util().htmlToInlineMd(el);
    return (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ');
  }

  /**
   * 选区在 editEl 内的 MD 起止偏移；折叠选区时 from===to
   */
  function getSelectionMdRange(editEl) {
    var L = Live();
    if (!L || !editEl) return null;
    var sel = window.getSelection && window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    if (!editEl.contains(range.commonAncestorContainer)) return null;

    // 起点
    var r0 = range.cloneRange();
    // 用临时 collapse 测偏移
    var start = 0;
    var end = 0;
    try {
      var save = range.cloneRange();
      // start
      var a = document.createRange();
      a.setStart(range.startContainer, range.startOffset);
      a.collapse(true);
      sel.removeAllRanges();
      sel.addRange(a);
      start = L.getCaretMdOffset(editEl);
      // end
      var b = document.createRange();
      b.setStart(range.endContainer, range.endOffset);
      b.collapse(true);
      sel.removeAllRanges();
      sel.addRange(b);
      end = L.getCaretMdOffset(editEl);
      // restore
      sel.removeAllRanges();
      sel.addRange(save);
    } catch (e) {
      try {
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e2) {
        /* ignore */
      }
      return null;
    }
    if (start > end) {
      var t = start;
      start = end;
      end = t;
    }
    return { from: start, to: end };
  }

  function isFullSourceEdit(editEl) {
    if (!editEl) return false;
    if (editEl.getAttribute && editEl.getAttribute('data-mdx-full-src-edit') != null) {
      return true;
    }
    if (editEl.closest && editEl.closest('[data-mdx-full-src]')) return true;
    if (window.MdxLineSource && typeof window.MdxLineSource.isFullSourceEditEl === 'function') {
      return window.MdxLineSource.isFullSourceEditEl(editEl);
    }
    return false;
  }

  function plainFromEdit(editEl) {
    return (editEl.innerText != null ? editEl.innerText : editEl.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n/g, '\n')
      .replace(/\n$/, '');
  }

  function getPlainSelectionRange(editEl) {
    var sel = window.getSelection && window.getSelection();
    if (!sel || !sel.rangeCount || !editEl) return null;
    var range = sel.getRangeAt(0);
    if (!editEl.contains(range.commonAncestorContainer)) return null;
    try {
      var pre = range.cloneRange();
      pre.selectNodeContents(editEl);
      pre.setEnd(range.startContainer, range.startOffset);
      var from = pre.toString().replace(/\u00a0/g, ' ').length;
      var mid = range.cloneRange();
      var selected = mid.toString().replace(/\u00a0/g, ' ');
      var to = from + selected.length;
      if (from > to) {
        var t = from;
        from = to;
        to = t;
      }
      return { from: from, to: to };
    } catch (e) {
      return null;
    }
  }

  function writePlainSource(editEl, md) {
    // 完整源码：纯文本 + br，禁止再折成 strong
    var esc =
      Util() && Util().esc
        ? Util().esc
        : function (s) {
            return String(s == null ? '' : s)
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');
          };
    editEl.innerHTML = esc(md).replace(/\n/g, '<br>');
  }

  function setPlainCaret(editEl, offset) {
    if (window.MdxLineSource && window.MdxLineSource.setPlainCaretOffset) {
      window.MdxLineSource.setPlainCaretOffset(editEl, offset);
      return;
    }
    try {
      var sel = window.getSelection();
      var walker = document.createTreeWalker(editEl, NodeFilter.SHOW_TEXT, null);
      var node;
      var acc = 0;
      while ((node = walker.nextNode())) {
        var len = (node.nodeValue || '').length;
        if (acc + len >= offset) {
          var r = document.createRange();
          r.setStart(node, Math.max(0, offset - acc));
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
          return;
        }
        acc += len;
      }
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * 对选区 toggle 某种 mark（MD 层改写再回写 DOM）
   * @returns {boolean}
   */
  function toggleMarkOnSelection(editEl, markType) {
    if (!editEl || !Marks()) return false;
    var L = Live();
    var M = Marks();
    var fullSrc = isFullSourceEdit(editEl);
    var md = fullSrc ? plainFromEdit(editEl) : htmlToInlineMd(editEl);
    var range = fullSrc ? getPlainSelectionRange(editEl) : getSelectionMdRange(editEl);
    if (!range) {
      // 无选区：在 caret 插入一对定界符
      var caret;
      if (fullSrc) {
        caret =
          (window.MdxLineSource && window.MdxLineSource.getPlainCaretOffset
            ? window.MdxLineSource.getPlainCaretOffset(editEl)
            : md.length) || 0;
      } else {
        caret = L ? L.getCaretMdOffset(editEl) : md.length;
      }
      range = { from: caret, to: caret };
    }

    var d = M.DELIMS[markType];
    if (!d) return false;

    var before = md.slice(0, range.from);
    var selected = md.slice(range.from, range.to);
    var after = md.slice(range.to);

    var newSelected;
    var newCaret;

    if (range.from === range.to) {
      // 折叠：插入 open+close，光标夹在中间
      newSelected = d.open + d.close;
      md = before + newSelected + after;
      newCaret = range.from + d.open.length;
    } else {
      newSelected = M.toggleWrapMd(markType, selected);
      md = before + newSelected + after;
      // 选区覆盖新内容
      newCaret = null; // 用 from/to
    }

    if (fullSrc) {
      writePlainSource(editEl, md);
      if (newCaret != null) {
        setPlainCaret(editEl, newCaret);
      } else {
        setPlainCaret(editEl, range.from + newSelected.length);
      }
      return true;
    }

    var html = L && L.mdToEditHtml ? L.mdToEditHtml(md) : md;
    editEl.innerHTML = html || '';

    if (newCaret != null) {
      if (L) L.setCaretMdOffset(editEl, newCaret);
    } else {
      // 恢复选区：from → from+newSelected 的 MD 映射到视觉
      var from = range.from;
      var to = range.from + newSelected.length;
      // 简化：折叠到 to
      if (L) {
        L.setCaretMdOffset(editEl, to);
        // 尝试扩展选区
        trySelectMdRange(editEl, from, to);
      }
    }
    return true;
  }

  function trySelectMdRange(editEl, from, to) {
    var L = Live();
    if (!L) return;
    try {
      L.setCaretMdOffset(editEl, from);
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      var startRange = sel.getRangeAt(0).cloneRange();
      L.setCaretMdOffset(editEl, to);
      if (!sel.rangeCount) return;
      var endRange = sel.getRangeAt(0);
      var r = document.createRange();
      r.setStart(startRange.startContainer, startRange.startOffset);
      r.setEnd(endRange.startContainer, endRange.startOffset);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) {
      L.setCaretMdOffset(editEl, to);
    }
  }

  /**
   * keydown 处理器。返回 true 表示已处理（调用方应 preventDefault 并 commit）
   */
  function handleKeydown(e, editEl) {
    if (!e || !editEl) return false;
    if (e.isComposing || e.keyCode === 229) return false;
    if (!isMod(e)) return false;
    // 输入框/代码源不处理
    if (editEl.tagName === 'TEXTAREA' || editEl.tagName === 'INPUT') return false;
    if (editEl.getAttribute && editEl.getAttribute('data-mdx-code-source') != null) {
      return false;
    }

    var key = e.key;
    if (!key) return false;
    var k = key.length === 1 ? key.toLowerCase() : key;

    var mark = null;
    // Ctrl/Cmd+B
    if (k === 'b' && !e.shiftKey && !e.altKey) mark = 'bold';
    // Ctrl/Cmd+I
    else if (k === 'i' && !e.shiftKey && !e.altKey) mark = 'italic';
    // Ctrl/Cmd+Shift+S 或 Ctrl/Cmd+Shift+X
    else if ((k === 's' || k === 'x' || k === 'S' || k === 'X') && e.shiftKey && !e.altKey) {
      mark = 'strike';
    }
    // Ctrl/Cmd+E
    else if ((k === 'e' || key === '`') && !e.shiftKey && !e.altKey) mark = 'code';
    // Ctrl/Cmd+Shift+H 高亮（可选）
    else if ((k === 'h' || k === 'H') && e.shiftKey && !e.altKey) mark = 'highlight';
    // Ctrl/Cmd+U 下划线（可选）
    else if (k === 'u' && !e.shiftKey && !e.altKey) mark = 'underline';
    else return false;

    e.preventDefault();
    e.stopPropagation();
    return toggleMarkOnSelection(editEl, mark);
  }

  window.MdxKeymapMarks = {
    handleKeydown: handleKeydown,
    toggleMarkOnSelection: toggleMarkOnSelection,
    getSelectionMdRange: getSelectionMdRange,
  };
})();
