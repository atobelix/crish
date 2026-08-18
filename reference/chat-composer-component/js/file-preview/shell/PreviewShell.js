/**
 * file-preview/shell/PreviewShell.js — 遮罩 / 标题 / 槽位 / 动效 / Esc
 */
(function () {
  'use strict';

  function parseMs(varName, fallback) {
    try {
      var raw = getComputedStyle(document.documentElement)
        .getPropertyValue(varName)
        .trim();
      if (!raw) return fallback;
      if (raw.endsWith('ms')) return parseFloat(raw) || fallback;
      if (raw.endsWith('s')) return (parseFloat(raw) || 0) * 1000 || fallback;
      return parseFloat(raw) || fallback;
    } catch (e) {
      return fallback;
    }
  }

  /**
   * @param {HTMLElement} mountEl — #filePreviewRoot
   */
  function create(mountEl) {
    if (!mountEl) throw new Error('PreviewShell: mountEl required');

    mountEl.innerHTML =
      '<div class="fp-root" id="fpRoot" aria-hidden="true">' +
      '  <div class="fp-backdrop" data-fp-backdrop></div>' +
      '  <div class="fp-panel" role="dialog" aria-modal="true" aria-labelledby="fpTitle" data-fp-panel>' +
      '    <div class="fp-chrome">' +
      '      <div class="fp-title" id="fpTitle" data-fp-title></div>' +
      '      <div class="fp-toolbar-host" data-fp-toolbar></div>' +
      '    </div>' +
      '    <div class="fp-stage">' +
      '      <div class="fp-stage-inner" data-fp-stage></div>' +
      '      <div class="fp-bottom-slot" data-fp-bottom></div>' +
      '    </div>' +
      '  </div>' +
      '</div>';

    var root = mountEl.querySelector('.fp-root');
    var backdrop = mountEl.querySelector('[data-fp-backdrop]');
    var panel = mountEl.querySelector('[data-fp-panel]');
    var titleEl = mountEl.querySelector('[data-fp-title]');
    var toolbarHost = mountEl.querySelector('[data-fp-toolbar]');
    var stageEl = mountEl.querySelector('[data-fp-stage]');
    var bottomEl = mountEl.querySelector('[data-fp-bottom]');

    var trap = window.FilePreviewFocusTrap.create(panel);
    var open = false;
    var leaving = false;
    var onRequestClose = null;
    var leaveTimer = null;

    function onKeydown(e) {
      if (!open || leaving) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (onRequestClose) onRequestClose({ reason: 'escape' });
      }
    }

    function setTitle(name) {
      titleEl.textContent = name || '文件预览';
    }

    function setBottomVisible(visible) {
      bottomEl.classList.toggle('is-visible', !!visible);
      if (!visible) bottomEl.innerHTML = '';
    }

    function markStageReady() {
      stageEl.classList.remove('is-crossfading');
      stageEl.classList.add('is-ready');
    }

    function markStageLoading() {
      stageEl.classList.remove('is-ready');
      stageEl.classList.add('is-crossfading');
    }

    function enter(opts) {
      opts = opts || {};
      if (leaveTimer) {
        clearTimeout(leaveTimer);
        leaveTimer = null;
      }
      open = true;
      leaving = false;
      onRequestClose = opts.onRequestClose || null;
      setTitle(opts.title);
      root.classList.remove('is-leaving');
      root.classList.add('is-open');
      root.setAttribute('aria-hidden', 'false');
      document.body.classList.add('fp-preview-open');
      document.addEventListener('keydown', onKeydown, true);
      trap.activate();

      // 强制 reflow 以便入场
      void root.offsetWidth;
    }

    function leave() {
      return new Promise(function (resolve) {
        if (!open) {
          resolve();
          return;
        }
        leaving = true;
        root.classList.add('is-leaving');
        var ms = parseMs('--fp-leave-ms', 160);
        leaveTimer = setTimeout(function () {
          leaveTimer = null;
          open = false;
          leaving = false;
          root.classList.remove('is-open', 'is-leaving');
          root.setAttribute('aria-hidden', 'true');
          document.body.classList.remove('fp-preview-open');
          document.removeEventListener('keydown', onKeydown, true);
          trap.deactivate();
          stageEl.innerHTML = '';
          bottomEl.innerHTML = '';
          bottomEl.classList.remove('is-visible');
          toolbarHost.innerHTML = '';
          titleEl.textContent = '';
          onRequestClose = null;
          resolve();
        }, ms);
      });
    }

    if (backdrop) {
      backdrop.addEventListener('click', function () {
        if (open && !leaving && onRequestClose) {
          onRequestClose({ reason: 'backdrop' });
        }
      });
    }

    return {
      root: root,
      panel: panel,
      titleEl: titleEl,
      toolbarHost: toolbarHost,
      stageEl: stageEl,
      bottomEl: bottomEl,
      isOpen: function () {
        return open && !leaving;
      },
      enter: enter,
      leave: leave,
      setTitle: setTitle,
      setBottomVisible: setBottomVisible,
      markStageReady: markStageReady,
      markStageLoading: markStageLoading,
    };
  }

  window.FilePreviewShell = { create: create };
})();
