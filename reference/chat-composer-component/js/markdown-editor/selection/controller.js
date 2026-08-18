/**
 * selection/controller.js — 跨块多选指针/键盘/复制删除（U1）
 * Prefix: MdxSelectionController
 */
(function () {
  'use strict';

  function Model() {
    return window.MdxSelectionModel;
  }

  /**
   * @param {object} host
   * @param {HTMLElement} host.root
   * @param {() => string[]} host.getOrderedIds
   * @param {() => object[]} host.getBlocks
   * @param {() => object} host.getState  // mutable selection state
   * @param {(state) => void} host.setState
   * @param {() => void} host.paint
   * @param {(id: string, opts?) => void} host.enterEdit
   * @param {(commit?: boolean) => void} host.exitEdit
   * @param {() => string|null} host.getActiveId
   * @param {(ids: string[]) => void} host.deleteBlocks
   * @param {(md: string) => void} [host.onCopyMarkdown]
   * @param {() => boolean} [host.viewOnly]
   * @param {(msg: string) => void} [host.announce]
   */
  function attach(host) {
    host = host || {};
    var root = host.root;
    var destroyed = false;
    var dragging = false;
    var dragMoved = false;
    var pointerId = null;
    var dragStartX = 0;
    var dragStartY = 0;
    var DRAG_THRESHOLD_PX = 6;

    function state() {
      return host.getState();
    }

    function orderedIds() {
      return host.getOrderedIds() || [];
    }

    function commit(next) {
      host.setState(next);
      if (host.paint) host.paint();
    }

    function M() {
      return Model();
    }

    function clearMulti() {
      var s = state();
      if (!s || (!s.selectedIds.length && s.mode === 'idle')) return;
      M().clear(s);
      commit(s);
    }

    function applyRange(anchorId, focusId) {
      var s = state();
      M().setRange(s, orderedIds(), anchorId, focusId);
      commit(s);
      return s;
    }

    function onPointerDown(e) {
      if (destroyed || (host.viewOnly && host.viewOnly())) return;
      if (e.button != null && e.button !== 0) return;
      // 忽略表内、输入控件、slash、命令面板
      if (e.target.closest && e.target.closest('.mdx-table, .mdx-slash, .mdx-cmd-portal, input, textarea, [contenteditable="true"]')) {
        // 若在 contenteditable 且已是 active 编辑，不抢
        if (e.target.closest('[contenteditable="true"]')) return;
      }
      var blockEl = e.target.closest && e.target.closest('.mdx-block');
      if (!blockEl || !root.contains(blockEl)) {
        // 点空白：清多选
        if (M().isMulti(state()) || state().selectedIds.length) {
          if (host.exitEdit) host.exitEdit(true);
          clearMulti();
        }
        return;
      }
      if (e.target.closest && e.target.closest('.mdx-handle')) return;

      var id = blockEl.dataset.blockId;
      if (!id) return;

      var mod = e.metaKey || e.ctrlKey;
      var shift = e.shiftKey;

      // Ctrl/Cmd+点击：切换加入选区
      if (mod && !shift) {
        e.preventDefault();
        if (host.exitEdit) host.exitEdit(true);
        var s1 = state();
        M().toggle(s1, orderedIds(), id);
        commit(s1);
        return;
      }

      // Shift+点击：范围选
      if (shift) {
        e.preventDefault();
        if (host.exitEdit) host.exitEdit(true);
        var s2 = state();
        var anchor = s2.anchorId || host.getActiveId && host.getActiveId() || id;
        M().setRange(s2, orderedIds(), anchor, id);
        // 至少两块才 multi；一块则仍可高亮
        if (s2.selectedIds.length > 1) s2.mode = 'multi';
        commit(s2);
        return;
      }

      // 普通按下：准备拖选（在 read 态块上）
      var active = host.getActiveId && host.getActiveId();
      var inEdit = active === id && e.target.closest && e.target.closest('[contenteditable="true"]');
      if (inEdit) return;

      dragging = true;
      dragMoved = false;
      dragStartX = e.clientX || 0;
      dragStartY = e.clientY || 0;
      pointerId = e.pointerId;
      try {
        if (blockEl.setPointerCapture && e.pointerId != null) {
          blockEl.setPointerCapture(e.pointerId);
        }
      } catch (err) {
        /* ignore */
      }
      var s3 = state();
      M().beginDrag(s3, id);
      // 先不 exitEdit，等确认真拖或 mouseup 再决定
      s3._pendingClickId = id;
      // 单击路径不提前 commit 选中高亮，避免「点一下就整段蓝」与真实意图不符
      // beginDrag 状态先留在 model；paint 仅在超过阈值后
    }

    function blockIdFromPoint(x, y) {
      var el = document.elementFromPoint(x, y);
      if (!el) return null;
      var blockEl = el.closest && el.closest('.mdx-block');
      if (!blockEl || !root.contains(blockEl)) return null;
      return blockEl.dataset.blockId || null;
    }

    function onPointerMove(e) {
      if (!dragging || destroyed) return;
      var dx = (e.clientX || 0) - dragStartX;
      var dy = (e.clientY || 0) - dragStartY;
      if (!dragMoved && dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        return;
      }
      var id = blockIdFromPoint(e.clientX, e.clientY);
      if (!id) return;
      var s = state();
      if (s.focusId === id && dragMoved) return;
      if (s.anchorId && id !== s.anchorId) {
        dragMoved = true;
        if (host.exitEdit) host.exitEdit(true);
      } else if (!dragMoved && s.anchorId === id) {
        // 同块内移动超过阈值仍不算跨块多选
        return;
      }
      if (!dragMoved) {
        dragMoved = true;
        if (host.exitEdit) host.exitEdit(true);
      }
      M().extendDrag(s, orderedIds(), id);
      if (s.selectedIds.length > 1) {
        s.mode = 'dragging';
        commit(s);
      } else if (s.selectedIds.length === 1 && dragMoved) {
        // 单块拖选：仍高亮该块（与 anchor 一致）
        s.mode = 'multi';
        commit(s);
      }
    }

    function onPointerUp(e) {
      if (!dragging || destroyed) return;
      dragging = false;
      var s = state();
      var pending = s._pendingClickId;
      delete s._pendingClickId;
      M().endDrag(s);

      if (!dragMoved && pending) {
        // 单击：清 multi，进单块编辑
        M().setSingle(s, pending);
        commit(s);
        if (host.enterEdit) host.enterEdit(pending);
        return;
      }

      if (s.selectedIds.length > 1) {
        s.mode = 'multi';
        commit(s);
        if (host.announce) host.announce('已选中 ' + s.selectedIds.length + ' 块');
      } else if (s.selectedIds.length === 1) {
        M().setSingle(s, s.selectedIds[0]);
        commit(s);
        if (host.enterEdit) host.enterEdit(s.selectedIds[0]);
      } else {
        commit(s);
      }
    }

    function copySelection(e) {
      var s = state();
      var multi =
        M().isMulti(s) || (s.selectedIds && s.selectedIds.length > 1);
      // 多选（≥2）或 block-multi 模式：强制 MD
      // 单块：若浏览器已有字符选区则放行（完整源码态本身就是 MD）
      if (!multi) {
        return false;
      }
      if (!host.selectionToMarkdown) return false;
      var md = host.selectionToMarkdown(s);
      if (!md) return false;
      if (e && e.clipboardData) {
        e.preventDefault();
        e.clipboardData.setData('text/plain', md);
        try {
          e.clipboardData.setData('text/markdown', md);
        } catch (err) {
          /* ignore */
        }
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(md).catch(function () {});
      }
      if (host.onCopyMarkdown) host.onCopyMarkdown(md);
      if (host.announce) host.announce('已复制 ' + s.selectedIds.length + ' 块');
      return true;
    }

    function deleteSelection() {
      var s = state();
      if (!s.selectedIds || s.selectedIds.length < 1) return false;
      if (!M().isMulti(s) && s.selectedIds.length < 2) return false;
      var ids = s.selectedIds.slice();
      if (host.exitEdit) host.exitEdit(false);
      if (host.deleteBlocks) host.deleteBlocks(ids);
      M().clear(s);
      commit(s);
      return true;
    }

    function onKeyDown(e) {
      if (destroyed || (host.viewOnly && host.viewOnly())) return;
      var s = state();
      var multi = M().isMulti(s) || (s.mode === 'dragging' && s.selectedIds.length > 1);
      if (!multi) return;

      // 多选时：方向键扩展（Shift）或折叠
      if (e.key === 'Escape') {
        e.preventDefault();
        clearMulti();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelection();
        return;
      }
      var mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'c' || e.key === 'C')) {
        if (copySelection(e)) {
          e.preventDefault();
        }
        return;
      }
      if (mod && (e.key === 'x' || e.key === 'X')) {
        if (copySelection(e)) {
          e.preventDefault();
          deleteSelection();
        }
        return;
      }
      if (mod && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        var ids = orderedIds();
        if (!ids.length) return;
        M().setRange(s, ids, ids[0], ids[ids.length - 1]);
        s.mode = 'multi';
        commit(s);
        return;
      }

      // Shift+Arrow 扩展 focus
      if (e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        var order = orderedIds();
        var fi = M().indexOfId(order, s.focusId || s.anchorId);
        if (fi < 0) return;
        var next = e.key === 'ArrowDown' ? Math.min(order.length - 1, fi + 1) : Math.max(0, fi - 1);
        M().setRange(s, order, s.anchorId || order[fi], order[next]);
        if (s.selectedIds.length > 1) s.mode = 'multi';
        commit(s);
      }
    }

    function onCopy(e) {
      copySelection(e);
    }

    root.addEventListener('pointerdown', onPointerDown, true);
    root.addEventListener('pointermove', onPointerMove, true);
    root.addEventListener('pointerup', onPointerUp, true);
    root.addEventListener('pointercancel', onPointerUp, true);
    root.addEventListener('keydown', onKeyDown, true);
    root.addEventListener('copy', onCopy, true);

    return {
      clear: clearMulti,
      applyRange: applyRange,
      copySelection: copySelection,
      deleteSelection: deleteSelection,
      isMulti: function () {
        return M().isMulti(state());
      },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        root.removeEventListener('pointerdown', onPointerDown, true);
        root.removeEventListener('pointermove', onPointerMove, true);
        root.removeEventListener('pointerup', onPointerUp, true);
        root.removeEventListener('pointercancel', onPointerUp, true);
        root.removeEventListener('keydown', onKeyDown, true);
        root.removeEventListener('copy', onCopy, true);
      },
    };
  }

  window.MdxSelectionController = {
    attach: attach,
  };
})();
