/**
 * selection/chrome.js — 多选高亮 + 多块行源码表面（U1）
 * Prefix: MdxSelectionChrome
 */
(function () {
  'use strict';

  function LineSrc() {
    return window.MdxLineSource;
  }
  function Ser() {
    return window.MdxSerialize;
  }
  function Schema() {
    return window.MdxSchema;
  }

  /** 适合就地显示行源的块类型 */
  function isTextLike(type) {
    return (
      type === 'paragraph' ||
      type === 'heading' ||
      type === 'bullet_item' ||
      type === 'ordered_item' ||
      type === 'task_item' ||
      type === 'quote' ||
      type === 'callout'
    );
  }

  function isAtomic(type) {
    return (
      type === 'code' ||
      type === 'mermaid' ||
      type === 'math' ||
      type === 'table' ||
      type === 'image' ||
      type === 'divider' ||
      type === 'toc' ||
      type === 'file_chip'
    );
  }

  /**
   * @param {object} opts
   * @param {() => object} opts.getState
   * @param {() => object[]} opts.getBlocks
   * @param {() => Object.<string, HTMLElement>} opts.getBlockEls
   * @param {(block) => string} [opts.readHtml] 读态 HTML 回退
   * @param {() => void} [opts.onAfterPaint]
   */
  function create(opts) {
    opts = opts || {};
    var paintedSource = Object.create(null); // id → true

    function clearClasses(blockEls) {
      Object.keys(blockEls || {}).forEach(function (id) {
        var el = blockEls[id];
        if (!el) return;
        el.classList.remove('is-block-selected', 'is-multi-source', 'is-selection-anchor', 'is-selection-focus');
      });
    }

    function paintSourceSurface(content, block) {
      var LS = LineSrc();
      // 与单块编辑同一套完整行源码视觉
      if (LS && typeof LS.renderFullSourceSurface === 'function' && isTextLike(block.type)) {
        content.innerHTML = LS.renderFullSourceSurface(block);
        var fe = content.querySelector('[data-mdx-edit]');
        if (fe) {
          fe.setAttribute('contenteditable', 'false');
          fe.setAttribute('tabindex', '-1');
        }
        return;
      }
      if (LS && typeof LS.toSourceLine === 'function' && isTextLike(block.type)) {
        var src = LS.toSourceLine(block);
        content.innerHTML =
          '<pre class="mdx-multi-src mdx-full-src" data-mdx-multi-src spellcheck="false">' +
          (window.MdxUtil && window.MdxUtil.esc ? window.MdxUtil.esc(src) : String(src)) +
          '</pre>';
        return;
      }
      if (isAtomic(block.type)) {
        // 原子块：仅加选中框，不改内部（避免破坏表/代码交互）
        return;
      }
      // fallback：纯文本
      var t = block.text != null ? String(block.text) : '';
      content.innerHTML =
        '<pre class="mdx-multi-src" data-mdx-multi-src>' +
        (window.MdxUtil && window.MdxUtil.esc ? window.MdxUtil.esc(t) : t) +
        '</pre>';
    }

    function restoreRead(id, block, el) {
      if (!el || !block) return;
      var content = el.querySelector('[data-mdx-content]');
      if (!content) return;
      if (typeof opts.readHtml === 'function') {
        content.innerHTML = opts.readHtml(block) || '';
      }
      delete paintedSource[id];
    }

    /**
     * 根据 state 刷新 DOM class 与多选源码表面
     * @param {{ skipSource?: boolean, activeEditId?: string|null }} paintOpts
     */
    function paint(paintOpts) {
      paintOpts = paintOpts || {};
      var state = opts.getState ? opts.getState() : null;
      var blocks = opts.getBlocks ? opts.getBlocks() : [];
      var blockEls = opts.getBlockEls ? opts.getBlockEls() : {};
      var byId = Object.create(null);
      for (var i = 0; i < blocks.length; i++) byId[blocks[i].id] = blocks[i];

      clearClasses(blockEls);

      if (!state || !state.selectedIds || !state.selectedIds.length) {
        // 恢复所有曾画源码的块
        Object.keys(paintedSource).forEach(function (id) {
          if (byId[id] && blockEls[id] && id !== paintOpts.activeEditId) {
            restoreRead(id, byId[id], blockEls[id]);
          }
        });
        paintedSource = Object.create(null);
        if (opts.onAfterPaint) opts.onAfterPaint();
        return;
      }

      var multi = state.mode === 'multi' || state.mode === 'dragging' && state.selectedIds.length > 1;
      var selectedSet = Object.create(null);
      state.selectedIds.forEach(function (id) {
        selectedSet[id] = true;
        var el = blockEls[id];
        if (!el) return;
        el.classList.add('is-block-selected');
        if (id === state.anchorId) el.classList.add('is-selection-anchor');
        if (id === state.focusId) el.classList.add('is-selection-focus');
      });

      // 多选：选中文本块显示源码；离开选区的恢复读态
      Object.keys(paintedSource).forEach(function (id) {
        if (!selectedSet[id] && byId[id] && blockEls[id] && id !== paintOpts.activeEditId) {
          restoreRead(id, byId[id], blockEls[id]);
        }
      });

      // 默认：多选只加 chrome 高亮，不把内容改写成等宽源码（避免「没编辑也像源码」+ 跳变）
      // 仅 opts.forceSourceOnMulti === true 时才 paintSourceSurface
      if (multi && paintOpts.forceSourceOnMulti) {
        state.selectedIds.forEach(function (id) {
          if (id === paintOpts.activeEditId) return;
          var block = byId[id];
          var el = blockEls[id];
          if (!block || !el) return;
          if (isAtomic(block.type)) {
            el.classList.add('is-multi-source');
            return;
          }
          if (!isTextLike(block.type)) return;
          var content = el.querySelector('[data-mdx-content]');
          if (!content) return;
          el.classList.add('is-multi-source');
          paintSourceSurface(content, block);
          paintedSource[id] = true;
        });
      } else if (multi) {
        // 保持读态渲染，仅标记选中
        state.selectedIds.forEach(function (id) {
          var el = blockEls[id];
          if (el) el.classList.add('is-multi-source');
        });
      }

      if (opts.onAfterPaint) opts.onAfterPaint();
    }

    /**
     * 选区 → Markdown 字符串
     */
    function selectionToMarkdown(state, blocks) {
      if (!state || !state.selectedIds || !state.selectedIds.length) return '';
      var set = Object.create(null);
      state.selectedIds.forEach(function (id) {
        set[id] = true;
      });
      var picked = [];
      for (var i = 0; i < blocks.length; i++) {
        if (set[blocks[i].id]) picked.push(blocks[i]);
      }
      if (!picked.length) return '';
      if (window.MdxClipboardCopy && typeof window.MdxClipboardCopy.blocksToMarkdown === 'function') {
        return window.MdxClipboardCopy.blocksToMarkdown(picked);
      }
      if (Ser() && typeof Ser().serialize === 'function') {
        var doc = { version: 2, blocks: picked };
        if (Schema() && Schema().migrate) doc = Schema().migrate(doc);
        try {
          return Ser().serialize(doc);
        } catch (eSer) {
          /* fall through */
        }
      }
      if (Ser() && typeof Ser().serializeBlock === 'function') {
        return picked
          .map(function (b) {
            return Ser().serializeBlock(b);
          })
          .filter(Boolean)
          .join('\n\n');
      }
      // fallback: line-source 拼接
      var LS = LineSrc();
      return picked
        .map(function (b) {
          if (LS && LS.toSourceLine) return LS.toSourceLine(b);
          return b.text || '';
        })
        .join('\n\n');
    }

    return {
      paint: paint,
      selectionToMarkdown: selectionToMarkdown,
      isTextLike: isTextLike,
      isAtomic: isAtomic,
      clearPainted: function () {
        paintedSource = Object.create(null);
      },
    };
  }

  window.MdxSelectionChrome = {
    create: create,
    isTextLike: isTextLike,
    isAtomic: isAtomic,
  };
})();
