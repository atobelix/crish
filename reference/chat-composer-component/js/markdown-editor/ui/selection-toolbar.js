/**
 * markdown-editor/ui/selection-toolbar.js
 * 选区浮动格式条（D16）：仅非空选区时显示在选区上方，禁止页顶格式栏。
 */
(function () {
  'use strict';

  var BTNS = [
    { cmd: 'bold', label: 'B', title: '粗体', cls: 'mdx-sel-btn--bold' },
    { cmd: 'italic', label: 'I', title: '斜体', cls: 'mdx-sel-btn--italic' },
    { cmd: 'strike', label: 'S', title: '删除线', cls: 'mdx-sel-btn--strike' },
    { cmd: 'code', label: '{}', title: '行内代码', cls: 'mdx-sel-btn--code' },
  ];

  /**
   * @param {HTMLElement} rootEl
   * @param {{ onCommand?: (cmd: string) => void }} [opts]
   */
  function mount(rootEl, opts) {
    opts = opts || {};
    var onCommand = opts.onCommand || function () {};
    var bar = document.createElement('div');
    bar.className = 'mdx-sel-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '文本格式');
    bar.hidden = true;

    var html = '';
    for (var i = 0; i < BTNS.length; i++) {
      var b = BTNS[i];
      html +=
        '<button type="button" class="mdx-sel-btn ' +
        b.cls +
        '" data-cmd="' +
        b.cmd +
        '" title="' +
        b.title +
        '" aria-label="' +
        b.title +
        '">' +
        b.label +
        '</button>';
    }
    bar.innerHTML = html;
    rootEl.appendChild(bar);

    var destroyed = false;
    var raf = 0;

    function scheduleSync() {
      if (destroyed) return;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(function () {
        raf = 0;
        sync();
      });
    }

    function onBarMouseDown(e) {
      // 避免 mousedown 抢走 contenteditable 选区
      e.preventDefault();
    }

    function onBarClick(e) {
      var btn = e.target.closest && e.target.closest('.mdx-sel-btn');
      if (!btn || !bar.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      var cmd = btn.getAttribute('data-cmd');
      if (!cmd) return;
      applyCommand(cmd);
      onCommand(cmd);
      scheduleSync();
    }

    bar.addEventListener('mousedown', onBarMouseDown);
    bar.addEventListener('click', onBarClick);

    document.addEventListener('selectionchange', scheduleSync);

    function hide() {
      bar.hidden = true;
      bar.classList.remove('is-visible');
    }

    function isInsideRoot(node) {
      if (!node) return false;
      if (node === rootEl) return true;
      if (node.nodeType === 3) node = node.parentNode;
      return !!(node && rootEl.contains(node));
    }

    function selectionInEditable() {
      var sel = window.getSelection && window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
      var range = sel.getRangeAt(0);
      if (!range || range.collapsed) return null;
      var text = (sel.toString && sel.toString()) || '';
      if (!text.replace(/\u00a0/g, ' ').trim()) return null;

      var anchor = sel.anchorNode;
      var focus = sel.focusNode;
      if (!isInsideRoot(anchor) || !isInsideRoot(focus)) return null;

      // 选区须落在编辑器内容区内（排除 slash / sel-bar 自身）
      var common = range.commonAncestorContainer;
      if (common.nodeType === 3) common = common.parentNode;
      if (!common || !rootEl.contains(common)) return null;
      if (bar.contains(common)) return null;

      // 优先 contenteditable；表格单元格也允许
      var host =
        (common.closest && common.closest('[contenteditable="true"]')) ||
        (common.closest && common.closest('[data-mdx-edit]')) ||
        (common.closest && common.closest('.mdx-block__content'));
      if (!host || !rootEl.contains(host)) return null;

      // view-only 根上不挂本条，这里再兜底
      if (rootEl.classList.contains('is-view-only')) return null;

      return range;
    }

    function positionAbove(range) {
      var rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        // 某些浏览器对折叠多段选区给零矩形，尝试 client rects
        var rects = range.getClientRects();
        if (rects && rects.length) rect = rects[0];
      }
      if (!rect || (rect.width === 0 && rect.height === 0 && rect.top === 0)) {
        hide();
        return;
      }

      var rootRect = rootEl.getBoundingClientRect();
      bar.hidden = false;
      bar.classList.add('is-visible');

      // 先显示再量宽高
      var barW = bar.offsetWidth || 120;
      var barH = bar.offsetHeight || 32;
      var gap = 8;
      var left = rect.left + rect.width / 2 - barW / 2 - rootRect.left;
      var top = rect.top - rootRect.top - barH - gap;

      // 夹在 root 可视区内
      var maxL = Math.max(4, rootEl.clientWidth - barW - 4);
      left = Math.max(4, Math.min(left, maxL));
      if (top < 4) {
        // 上方空间不足则放到选区下方
        top = rect.bottom - rootRect.top + gap;
      }

      bar.style.left = Math.round(left) + 'px';
      bar.style.top = Math.round(top) + 'px';
    }

    function sync() {
      if (destroyed) return;
      if (rootEl.classList.contains('is-view-only')) {
        hide();
        return;
      }
      try {
        var range = selectionInEditable();
        if (!range) {
          hide();
          return;
        }
        positionAbove(range);
      } catch (err) {
        hide();
      }
    }

    /**
     * 在当前选区执行格式化（contenteditable + execCommand v1）
     */
    function applyCommand(cmd) {
      var sel = window.getSelection && window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;

      if (cmd === 'bold') {
        document.execCommand('bold', false, null);
        return;
      }
      if (cmd === 'italic') {
        document.execCommand('italic', false, null);
        return;
      }
      if (cmd === 'strike') {
        document.execCommand('strikeThrough', false, null);
        return;
      }
      if (cmd === 'code') {
        wrapSelectionTag('code');
      }
    }

    function wrapSelectionTag(tagName) {
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      var range = sel.getRangeAt(0);

      // 若已在同标签内，则拆出（toggle）
      var node = range.commonAncestorContainer;
      if (node.nodeType === 3) node = node.parentNode;
      var existing = node && node.closest ? node.closest(tagName) : null;
      if (existing && rootEl.contains(existing)) {
        // unwrap
        var parent = existing.parentNode;
        while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
        parent.removeChild(existing);
        parent.normalize && parent.normalize();
        return;
      }

      try {
        var el = document.createElement(tagName);
        el.className = tagName === 'code' ? 'mdx-code' : '';
        range.surroundContents(el);
        sel.removeAllRanges();
        var r = document.createRange();
        r.selectNodeContents(el);
        sel.addRange(r);
      } catch (err) {
        // surroundContents 失败时（跨元素）退化为 extract + insert
        try {
          var frag = range.extractContents();
          var wrap = document.createElement(tagName);
          if (tagName === 'code') wrap.className = 'mdx-code';
          wrap.appendChild(frag);
          range.insertNode(wrap);
        } catch (e2) {
          /* ignore */
        }
      }
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      document.removeEventListener('selectionchange', scheduleSync);
      bar.removeEventListener('mousedown', onBarMouseDown);
      bar.removeEventListener('click', onBarClick);
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    }

    return {
      sync: sync,
      destroy: destroy,
      el: bar,
    };
  }

  window.MdxSelectionToolbar = {
    mount: mount,
  };
})();
