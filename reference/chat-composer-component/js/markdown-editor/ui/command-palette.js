/**
 * markdown-editor/ui/command-palette.js — 全局命令面板（Ctrl/Cmd+P）
 *
 * - Ctrl+P / Ctrl+Shift+P 打开（可配）
 * - 模糊过滤：中文 title + 英文 id/aliases
 * - ↑↓ 导航 · Enter 执行 · Esc 关闭
 * - Portal 挂到 body，样式克制
 *
 * Prefix: MdxCommandPalette
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

  /**
   * 简单模糊分：子串命中 + 前缀加权；支持多关键词空格 AND
   */
  function fuzzyScore(query, target, aliases) {
    query = (query || '').trim().toLowerCase();
    if (!query) return 1;
    target = String(target || '').toLowerCase();
    var hay = target;
    var als = aliases || [];
    for (var i = 0; i < als.length; i++) {
      hay += ' ' + String(als[i] || '').toLowerCase();
    }
    var parts = query.split(/\s+/).filter(Boolean);
    var score = 0;
    for (var p = 0; p < parts.length; p++) {
      var q = parts[p];
      var idx = hay.indexOf(q);
      if (idx < 0) {
        // 逐字子序列
        if (!subsequence(q, hay)) return 0;
        score += 0.3;
      } else {
        score += idx === 0 || hay[idx - 1] === ' ' ? 2 : 1;
        if (target.indexOf(q) === 0) score += 1.5;
      }
    }
    return score;
  }

  function subsequence(q, hay) {
    var j = 0;
    for (var i = 0; i < hay.length && j < q.length; i++) {
      if (hay[i] === q[j]) j++;
    }
    return j === q.length;
  }

  /**
   * @param {HTMLElement} rootEl — 编辑器 root（用于作用域快捷键）
   * @param {{
   *   getCommands: () => Array<{id,title,aliases?,section?,disabled?,disabledReason?,run?:Function}>,
   *   onRun?: (cmd) => void|Promise,
   *   bindTarget?: HTMLElement|Document,
   *   openOnCtrlP?: boolean,
   *   alsoCtrlShiftP?: boolean,
   * }} opts
   */
  function mount(rootEl, opts) {
    opts = opts || {};
    var getCommands = opts.getCommands || function () {
      return [];
    };
    var onRun = opts.onRun || function () {};
    var bindTarget = opts.bindTarget || document;
    var openOnCtrlP = opts.openOnCtrlP !== false;
    var alsoCtrlShiftP = opts.alsoCtrlShiftP !== false;

    var open = false;
    var index = 0;
    var filtered = [];
    var destroyed = false;
    var lastFocus = null;
    var closeTimer = null;

    var portal = document.createElement('div');
    portal.className = 'mdx-cmd-portal';
    portal.hidden = true;
    portal.innerHTML =
      '<div class="mdx-cmd-backdrop" data-mdx-cmd-backdrop></div>' +
      '<div class="mdx-cmd-dialog" role="dialog" aria-modal="true" aria-label="命令面板">' +
      '<div class="mdx-cmd-search-wrap">' +
      '<input type="text" class="mdx-cmd-input" data-mdx-cmd-input placeholder="搜索命令…" autocomplete="off" spellcheck="false" />' +
      '<kbd class="mdx-cmd-kbd">Esc</kbd>' +
      '</div>' +
      '<div class="mdx-cmd-list" data-mdx-cmd-list role="listbox"></div>' +
      '<div class="mdx-cmd-footer"><span data-mdx-cmd-hint>↑↓ 选择 · Enter 执行</span></div>' +
      '</div>';
    document.body.appendChild(portal);

    var inputEl = portal.querySelector('[data-mdx-cmd-input]');
    var listEl = portal.querySelector('[data-mdx-cmd-list]');
    var backdrop = portal.querySelector('[data-mdx-cmd-backdrop]');

    function isOpen() {
      return open;
    }

    function openPalette(initialQuery) {
      if (destroyed) return;
      // 取消关闭动画，允许立即重开
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      portal.classList.remove('is-closing');
      if (open) {
        // 已打开时只更新查询
        if (initialQuery != null) {
          inputEl.value = String(initialQuery);
          index = 0;
          renderList();
        }
        try {
          inputEl.focus();
        } catch (e0) {
          /* ignore */
        }
        return;
      }
      open = true;
      lastFocus = document.activeElement;
      portal.hidden = false;
      portal.removeAttribute('hidden');
      portal.classList.add('is-open');
      portal.setAttribute('aria-hidden', 'false');
      // reflow 以重启 dialog 入场动画
      void portal.offsetWidth;
      inputEl.value = initialQuery != null ? String(initialQuery) : '';
      index = 0;
      renderList();
      // 下一帧 focus，避免与触发键冲突
      requestAnimationFrame(function () {
        try {
          inputEl.focus();
          inputEl.select();
        } catch (e) {
          /* ignore */
        }
      });
    }

    function finishCloseDom() {
      portal.hidden = true;
      portal.setAttribute('hidden', '');
      portal.classList.remove('is-open', 'is-closing');
      portal.setAttribute('aria-hidden', 'true');
      inputEl.value = '';
      listEl.innerHTML = '';
      filtered = [];
    }

    function restoreFocusAfterClose() {
      var el = lastFocus;
      lastFocus = null;
      if (el && typeof el.focus === 'function') {
        try {
          el.focus({ preventScroll: true });
        } catch (e) {
          try {
            el.focus();
          } catch (e2) {
            /* ignore */
          }
        }
      } else if (rootEl && typeof rootEl.focus === 'function') {
        try {
          rootEl.focus({ preventScroll: true });
        } catch (e3) {
          /* ignore */
        }
      }
    }

    function closePalette() {
      // 始终可关：标志先落下，DOM 可短延迟淡出
      var wasOpen = open;
      open = false;
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      if (!wasOpen) {
        finishCloseDom();
        return;
      }
      var Motion = window.MdxMotion;
      var reduce = Motion && Motion.prefersReducedMotion && Motion.prefersReducedMotion();
      if (reduce) {
        finishCloseDom();
        restoreFocusAfterClose();
        return;
      }
      // is-closing：保持 display 以完成 opacity+rise 离场
      portal.classList.remove('is-open');
      portal.classList.add('is-closing');
      portal.setAttribute('aria-hidden', 'true');
      var ms =
        Motion && typeof Motion.motionMs === 'function'
          ? Motion.motionMs('fast', portal)
          : 120;
      closeTimer = setTimeout(function () {
        closeTimer = null;
        // 关闭过程中若已 reopen，跳过
        if (open) return;
        finishCloseDom();
      }, Math.max(0, ms) + 20);
      restoreFocusAfterClose();
    }

    function toggle() {
      if (open) closePalette();
      else openPalette();
    }

    function collectFiltered() {
      var q = inputEl.value || '';
      var all = getCommands() || [];
      var scored = [];
      for (var i = 0; i < all.length; i++) {
        var c = all[i];
        if (!c || !c.id) continue;
        var s = fuzzyScore(q, c.title || c.id, (c.aliases || []).concat([c.id, c.section || '']));
        if (s > 0) {
          scored.push({ cmd: c, score: s });
        }
      }
      scored.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        var sa = a.cmd.section || '';
        var sb = b.cmd.section || '';
        if (sa !== sb) return sa < sb ? -1 : 1;
        return String(a.cmd.title || '').localeCompare(String(b.cmd.title || ''), 'zh');
      });
      filtered = scored.map(function (x) {
        return x.cmd;
      });
      if (index >= filtered.length) index = Math.max(0, filtered.length - 1);
      if (index < 0) index = 0;
    }

    function renderList() {
      collectFiltered();
      if (!filtered.length) {
        listEl.innerHTML =
          '<div class="mdx-cmd-empty">未找到命令<div class="mdx-cmd-empty__hint">试试「标题」「表格」「总结」</div></div>';
        return;
      }
      var html = '';
      var lastSec = null;
      for (var i = 0; i < filtered.length; i++) {
        var c = filtered[i];
        var sec = c.section || '其它';
        if (sec !== lastSec) {
          html += '<div class="mdx-cmd-section">' + esc(sec) + '</div>';
          lastSec = sec;
        }
        var active = i === index;
        var dis = !!c.disabled;
        html +=
          '<button type="button" role="option" class="mdx-cmd-item' +
          (active ? ' is-active' : '') +
          (dis ? ' is-disabled' : '') +
          '" data-idx="' +
          i +
          '" aria-selected="' +
          (active ? 'true' : 'false') +
          '"' +
          (dis ? ' aria-disabled="true"' : '') +
          '>' +
          '<span class="mdx-cmd-item__title">' +
          esc(c.title || c.id) +
          '</span>' +
          (c.disabledReason
            ? '<span class="mdx-cmd-item__reason">' + esc(c.disabledReason) + '</span>'
            : c.hint
              ? '<span class="mdx-cmd-item__hint">' + esc(c.hint) + '</span>'
              : '') +
          '</button>';
      }
      listEl.innerHTML = html;
      var activeBtn = listEl.querySelector('.mdx-cmd-item.is-active');
      if (activeBtn && activeBtn.scrollIntoView) {
        try {
          activeBtn.scrollIntoView({ block: 'nearest' });
        } catch (e) {
          /* ignore */
        }
      }
    }

    function runIndex(i) {
      var cmd = filtered[i];
      if (!cmd) return;
      if (cmd.disabled) return;
      closePalette();
      var result;
      try {
        if (typeof cmd.run === 'function') {
          result = cmd.run();
        } else {
          result = onRun(cmd);
        }
      } catch (err) {
        if (typeof opts.onError === 'function') opts.onError(err, cmd);
        return;
      }
      if (result && typeof result.then === 'function') {
        result.catch(function (err) {
          if (typeof opts.onError === 'function') opts.onError(err, cmd);
        });
      }
    }

    function onInput() {
      index = 0;
      renderList();
    }

    function onInputKeydown(e) {
      if (!open) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        if (!filtered.length) return;
        index = Math.min(filtered.length - 1, index + 1);
        renderList();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        if (!filtered.length) return;
        index = Math.max(0, index - 1);
        renderList();
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        index = 0;
        renderList();
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        index = Math.max(0, filtered.length - 1);
        renderList();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        runIndex(index);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closePalette();
      }
    }

    function onListClick(e) {
      var btn = e.target.closest && e.target.closest('.mdx-cmd-item');
      if (!btn || !listEl.contains(btn)) return;
      e.preventDefault();
      var i = +btn.getAttribute('data-idx');
      if (!isNaN(i)) runIndex(i);
    }

    function onListMouseMove(e) {
      var btn = e.target.closest && e.target.closest('.mdx-cmd-item');
      if (!btn || !listEl.contains(btn)) return;
      var i = +btn.getAttribute('data-idx');
      if (!isNaN(i) && i !== index) {
        index = i;
        renderList();
      }
    }

    /**
     * 点空白关闭：点在对话框外（遮罩 / portal 空隙 / 页面其它区域）均关闭。
     * 使用 capture，避免被其它 handler 截断。
     */
    function isInsideDialog(target) {
      if (!target || !target.closest) return false;
      return !!target.closest('.mdx-cmd-dialog');
    }

    function onPortalMouseDown(e) {
      if (!open || destroyed) return;
      // 点在搜索框/列表内：不关
      if (isInsideDialog(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      closePalette();
    }

    function onDocumentMouseDown(e) {
      if (!open || destroyed) return;
      // 对话框内
      if (isInsideDialog(e.target)) return;
      // portal 内空白（遮罩）已由 onPortalMouseDown 处理；文档其它区域也关
      if (portal.contains(e.target) && e.target !== portal && e.target !== backdrop) {
        // 仍在 portal 但非 dialog：当作空白
        if (!isInsideDialog(e.target)) {
          e.preventDefault();
          closePalette();
        }
        return;
      }
      if (!portal.contains(e.target)) {
        closePalette();
      }
    }

    function onGlobalKeydown(e) {
      if (destroyed) return;
      var mod = e.ctrlKey || e.metaKey;
      if (!mod) {
        // Esc：任意焦点下关闭
        if (open && e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closePalette();
        }
        return;
      }
      var key = e.key;
      var isP = key === 'p' || key === 'P';
      if (!isP) return;

      // Ctrl+Shift+P 或 Ctrl+P
      if (e.shiftKey && alsoCtrlShiftP) {
        e.preventDefault();
        e.stopPropagation();
        toggle();
        return;
      }
      if (!e.shiftKey && openOnCtrlP && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }
    }

    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('keydown', onInputKeydown);
    listEl.addEventListener('click', onListClick);
    listEl.addEventListener('mousemove', onListMouseMove);
    portal.addEventListener('mousedown', onPortalMouseDown);
    // 捕获阶段：点页面任意空白也能关
    document.addEventListener('mousedown', onDocumentMouseDown, true);
    bindTarget.addEventListener('keydown', onGlobalKeydown, true);

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      open = false;
      finishCloseDom();
      inputEl.removeEventListener('input', onInput);
      inputEl.removeEventListener('keydown', onInputKeydown);
      listEl.removeEventListener('click', onListClick);
      listEl.removeEventListener('mousemove', onListMouseMove);
      portal.removeEventListener('mousedown', onPortalMouseDown);
      document.removeEventListener('mousedown', onDocumentMouseDown, true);
      bindTarget.removeEventListener('keydown', onGlobalKeydown, true);
      if (portal.parentNode) portal.parentNode.removeChild(portal);
    }

    return {
      open: openPalette,
      close: closePalette,
      toggle: toggle,
      isOpen: isOpen,
      destroy: destroy,
      refresh: function () {
        if (open) renderList();
      },
    };
  }

  window.MdxCommandPalette = {
    mount: mount,
    fuzzyScore: fuzzyScore,
  };
})();
