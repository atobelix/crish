/**
 * NotebookPanel — floating notebook host for generated docs.
 * Body uses Markdown block editor (mdx). Shell: pin / drag / Esc.
 * No hard preview/source mode toggle.
 */
(function () {
  'use strict';

  var FC = (window.FlowComponents = window.FlowComponents || {});

  var HIDE_DELAY_MS = 300;
  var AUTOSAVE_MS = 400;

  var IC = {
    x:
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
      ' stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/>' +
      '<line x1="6" y1="6" x2="6" y2="18"/></svg>',
    pin:
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
      ' stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>',
    pinFilled:
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5"' +
      ' stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>',
    doc:
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
      ' stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
      '<polyline points="14 2 14 8 20 8"/></svg>',
  };

  // fix broken x icon path (was duplicated wrong)
  IC.x =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
    ' stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/>' +
    '<line x1="6" y1="6" x2="18" y2="18"/></svg>';

  var docStore = Object.create(null);
  var state = {
    el: null,
    title: null,
    pinned: false,
    hideTimer: null,
    drag: null,
    anchorEl: null,
    escBound: false,
    editor: null,
  };

  function ensureDoc(title, content) {
    if (title == null) return '';
    if (docStore[title] == null) docStore[title] = content != null ? String(content) : '';
    else if (content != null && content !== '' && docStore[title] === '') {
      docStore[title] = String(content);
    }
    return docStore[title];
  }

  function clearHideTimer() {
    if (state.hideTimer) {
      clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
  }

  function scheduleHide() {
    clearHideTimer();
    if (state.pinned) return;
    state.hideTimer = setTimeout(function () {
      if (!state.pinned) close(false);
    }, HIDE_DELAY_MS);
  }

  function flush() {
    if (state.editor && typeof state.editor.flush === 'function') {
      state.editor.flush();
    }
    if (state.editor && state.title) {
      docStore[state.title] = state.editor.getMarkdown();
    }
  }

  function destroyEditor() {
    if (state.editor && typeof state.editor.destroy === 'function') {
      try {
        // destroy without double-flush side effects if already flushed
        state.editor.destroy();
      } catch (e) {
        console.warn('[NotebookPanel] editor destroy', e);
      }
    }
    state.editor = null;
  }

  function mountEditor(md) {
    var host = state.el && state.el.querySelector('[data-nb-editor-host]');
    if (!host) return;
    destroyEditor();

    if (!window.MarkdownEditor || typeof window.MarkdownEditor.mount !== 'function') {
      host.innerHTML =
        '<div class="nb-content is-reading md-preview" style="padding:12px;opacity:0.6">Markdown 编辑器未加载</div>';
      return;
    }

    state.editor = window.MarkdownEditor.mount(host, {
      markdown: md || '',
      autosaveMs: AUTOSAVE_MS,
      onChange: function (nextMd) {
        if (state.title) docStore[state.title] = nextMd;
      },
      onOpenPath: function (path) {
        try {
          console.info('[Notebook] open path', path);
          if (window.FlowMount && window.FlowMount.toast) {
            window.FlowMount.toast('将在右侧文件面板打开：' + path);
          }
        } catch (e) {
          /* ignore */
        }
      },
      onOpenDoc: function (title) {
        var content = docStore[title] != null ? docStore[title] : '';
        open(title, content, state.anchorEl, { pin: state.pinned });
      },
    });
  }

  function updatePinUi() {
    if (!state.el) return;
    state.el.classList.toggle('is-pinned', state.pinned);
    var pinBtn = state.el.querySelector('[data-nb-pin]');
    if (pinBtn) {
      pinBtn.innerHTML = state.pinned ? IC.pinFilled : IC.pin;
      pinBtn.title = state.pinned ? '取消固定' : '固定';
      pinBtn.setAttribute('aria-label', state.pinned ? '取消固定' : '固定');
    }
  }

  function positionNear(anchorEl) {
    if (!state.el || !anchorEl) return;
    if (state.pinned && state.drag && state.drag.userMoved) return;
    var rect = anchorEl.getBoundingClientRect();
    var w = state.el.offsetWidth || 480;
    var h = state.el.offsetHeight || 420;
    var left = rect.left;
    var top = rect.bottom + 8;
    if (left + w > window.innerWidth - 12) left = window.innerWidth - w - 12;
    if (left < 12) left = 12;
    if (top + h > window.innerHeight - 12) top = rect.top - h - 8;
    if (top < 12) top = 12;
    state.el.style.left = left + 'px';
    state.el.style.top = top + 'px';
    state.el.style.transform = 'none';
  }

  function onEsc(e) {
    if (e.key !== 'Escape') return;
    if (!state.el || !state.el.classList.contains('is-open')) return;
    // slash menu handles its own Esc via editor
    close(true);
  }

  function wirePanel(el) {
    var header = el.querySelector('[data-nb-drag]');
    header.addEventListener('pointerdown', function (e) {
      if (e.target.closest && e.target.closest('.nb-btn')) return;
      e.preventDefault();
      var r = el.getBoundingClientRect();
      state.drag = {
        ox: e.clientX - r.left,
        oy: e.clientY - r.top,
        userMoved: true,
      };
      el.classList.add('is-dragging');
      try {
        header.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    });
    header.addEventListener('pointermove', function (e) {
      if (!state.drag || state.drag.ox == null) return;
      var left = e.clientX - state.drag.ox;
      var top = e.clientY - state.drag.oy;
      left = Math.max(8, Math.min(left, window.innerWidth - el.offsetWidth - 8));
      top = Math.max(8, Math.min(top, window.innerHeight - 48));
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.style.transform = 'none';
    });
    header.addEventListener('pointerup', function () {
      if (state.drag) state.drag.ox = null;
      el.classList.remove('is-dragging');
    });

    el.querySelector('[data-nb-close]').addEventListener('click', function () {
      state.pinned = false;
      close(true);
    });

    el.querySelector('[data-nb-pin]').addEventListener('click', function () {
      state.pinned = !state.pinned;
      updatePinUi();
      if (state.pinned) clearHideTimer();
    });

    el.addEventListener('mouseenter', clearHideTimer);
    el.addEventListener('mouseleave', function () {
      if (!state.pinned) scheduleHide();
    });
  }

  function ensure() {
    if (state.el) return state.el;

    var el = document.createElement('div');
    el.className = 'nb-panel is-reading';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', '文档记事本');
    el.innerHTML =
      '<div class="nb-header" data-nb-drag>' +
      '<span class="nb-icon" aria-hidden="true">' +
      IC.doc +
      '</span>' +
      '<span class="nb-title"></span>' +
      '<div class="nb-actions">' +
      '<button type="button" class="nb-btn" data-nb-pin title="固定" aria-label="固定">' +
      IC.pin +
      '</button>' +
      '<button type="button" class="nb-btn" data-nb-close title="关闭" aria-label="关闭">' +
      IC.x +
      '</button>' +
      '</div>' +
      '</div>' +
      '<div class="nb-body" data-nb-editor-host></div>';
    el.setAttribute('hidden', '');
    document.body.appendChild(el);
    state.el = el;
    wirePanel(el);

    if (!state.escBound) {
      state.escBound = true;
      document.addEventListener('keydown', onEsc);
    }
    return el;
  }

  /**
   * @param {string} title
   * @param {string} [content]
   * @param {HTMLElement|null} [anchorEl]
   * @param {{ pin?: boolean, content?: string }} [opts]
   */
  function open(title, content, anchorEl, opts) {
    opts = opts || {};
    if (content && typeof content === 'object' && content.nodeType != null) {
      opts = anchorEl || {};
      anchorEl = content;
      content = opts.content;
    }
    if (opts.content != null && (content == null || content === '')) {
      content = opts.content;
    }

    ensure();
    var md = ensureDoc(title, content != null ? content : '');
    state.anchorEl = anchorEl || null;

    // same title already open: refresh content if editor exists
    var same = state.title === title && state.el.classList.contains('is-open') && state.editor;
    state.title = title;

    if (opts.pin === true) {
      state.pinned = true;
    }

    state.el.querySelector('.nb-title').textContent = String(title || '').replace(/\.md$/i, '');
    updatePinUi();

    if (same) {
      state.editor.setMarkdown(md);
    } else {
      mountEditor(md);
    }

    state.el.removeAttribute('hidden');
    state.el.classList.add('is-open');

    if (!state.pinned || !state.drag || !state.drag.userMoved) {
      if (state.drag) state.drag.userMoved = false;
      requestAnimationFrame(function () {
        positionNear(anchorEl);
      });
    }

    clearHideTimer();
    return state.el;
  }

  function close(force) {
    if (!state.el) return;
    if (state.pinned && !force) return;
    flush();
    destroyEditor();
    state.el.classList.remove('is-open');
    state.el.setAttribute('hidden', '');
    clearHideTimer();
    if (force) {
      state.pinned = false;
      state.drag = null;
      state.el.classList.remove('is-pinned');
      updatePinUi();
    }
  }

  function setPinned(pinned) {
    state.pinned = !!pinned;
    ensure();
    updatePinUi();
    if (state.pinned) clearHideTimer();
  }

  function isPinned() {
    return !!state.pinned;
  }

  function isOpen() {
    return !!(state.el && state.el.classList.contains('is-open'));
  }

  FC.NotebookPanel = {
    ensure: ensure,
    open: open,
    close: close,
    flush: flush,
    setPinned: setPinned,
    isPinned: isPinned,
    isOpen: isOpen,
    scheduleHide: scheduleHide,
    clearHideTimer: clearHideTimer,
    docStore: docStore,
    ensureDoc: ensureDoc,
  };
})();
