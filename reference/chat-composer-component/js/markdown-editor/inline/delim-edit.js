/**
 * markdown-editor/inline/delim-edit.js
 * ux-D2 成对删除定界符（Backspace / Delete → unwrap mark，保留纯文本）
 *
 * - 纯逻辑委托 MdxMarksModel.tryPairUnwrapMd
 * - DOM：读 htmlToInlineMd + caretMd → 写 mdToEditHtml + setCaret
 * - IME composition / 非折叠选区 / 完整源码态 / code 源：不处理
 * - editor keydown 仅薄接线 handleKeydown
 */
(function () {
  'use strict';

  function Model() {
    return window.MdxMarksModel;
  }
  function Live() {
    return window.MdxLiveMarks;
  }
  function Util() {
    return window.MdxUtil;
  }

  function htmlToInlineMd(el) {
    if (Live() && typeof Live().htmlToInlineMd === 'function') return Live().htmlToInlineMd(el);
    if (Util() && typeof Util().htmlToInlineMd === 'function') return Util().htmlToInlineMd(el);
    if (!el) return '';
    var t = el.innerText != null ? el.innerText : el.textContent || '';
    return t.replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n');
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

  function isComposing(editEl, e) {
    if (e && (e.isComposing || e.keyCode === 229)) return true;
    if (editEl && editEl._mdxLiveComposing) return true;
    return false;
  }

  function selectionCollapsedIn(editEl) {
    var sel = window.getSelection && window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    var range = sel.getRangeAt(0);
    if (!editEl.contains(range.commonAncestorContainer)) return false;
    return !!range.collapsed;
  }

  /**
   * 在 editEl 上尝试成对 unwrap
   * @param {HTMLElement} editEl
   * @param {'backspace'|'delete'} dir
   * @returns {boolean} 是否已改 DOM
   */
  function tryPairUnwrap(editEl, dir) {
    if (!editEl || !editEl.isContentEditable) return false;
    if (editEl.getAttribute && editEl.getAttribute('data-mdx-code-source') != null) {
      return false;
    }
    if (isFullSourceEdit(editEl)) return false;
    if (editEl._mdxLiveComposing || editEl._mdxLiveApplying) return false;
    if (!selectionCollapsedIn(editEl)) return false;

    var M = Model();
    var L = Live();
    if (!M || typeof M.tryPairUnwrapMd !== 'function') return false;

    var md = htmlToInlineMd(editEl);
    var caretMd =
      L && typeof L.getCaretMdOffset === 'function' ? L.getCaretMdOffset(editEl) : md.length;
    var result = M.tryPairUnwrapMd(md, caretMd, dir);
    if (!result) return false;

    // 写回编辑态 HTML（保持 caret 邻域 reveal）
    var nextHtml;
    if (L && typeof L.mdToEditHtml === 'function') {
      nextHtml = L.mdToEditHtml(result.md, {
        caretMd: result.caretMd,
        showDelimsNearCaret: true,
      });
    } else if (M.runsToEditHtml && M.parseInline) {
      nextHtml = M.runsToEditHtml(M.parseInline(result.md), {
        caretMd: result.caretMd,
        showDelimsNearCaret: true,
      });
    } else {
      nextHtml = result.md;
    }

    editEl._mdxLiveApplying = true;
    try {
      editEl.innerHTML = nextHtml || '';
      // 失效 live 缓存，避免下一次 apply 误跳过
      editEl._mdxLiveMd = null;
      editEl._mdxLiveRevealKey = null;
      if (L && typeof L.setCaretMdOffset === 'function') {
        L.setCaretMdOffset(editEl, result.caretMd);
      }
    } finally {
      editEl._mdxLiveApplying = false;
    }
    return true;
  }

  /**
   * keydown：Backspace / Delete 成对拆格式
   * @returns {boolean} true = 已处理（调用方 preventDefault + commit）
   */
  function handleKeydown(e, editEl) {
    if (!e || !editEl) return false;
    if (isComposing(editEl, e)) return false;
    if (e.metaKey || e.ctrlKey || e.altKey) return false;

    var dir = null;
    if (e.key === 'Backspace') dir = 'backspace';
    else if (e.key === 'Delete') dir = 'delete';
    else return false;

    if (!tryPairUnwrap(editEl, dir)) return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  window.MdxDelimEdit = {
    handleKeydown: handleKeydown,
    tryPairUnwrap: tryPairUnwrap,
    tryPairUnwrapMd: function (md, caretMd, dir) {
      var M = Model();
      if (!M || typeof M.tryPairUnwrapMd !== 'function') return null;
      return M.tryPairUnwrapMd(md, caretMd, dir);
    },
  };
})();
