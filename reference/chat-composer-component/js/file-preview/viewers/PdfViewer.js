/**
 * file-preview/viewers/PdfViewer.js — canvas 真渲染 PDF
 *
 * 动作：pagePrev / pageNext / zoomIn / zoomOut / zoomReset / thumbnails
 * 工具栏状态：pageLabel、zoomLabel、pagePrevDisabled、pageNextDisabled、thumbnails
 */
(function () {
  'use strict';

  var MIN_SCALE = 0.5;
  var MAX_SCALE = 3;
  var SCALE_STEP = 0.15;
  var DEFAULT_SCALE = 1;
  var THUMB_SCALE = 0.18;

  /**
   * @param {HTMLElement} host
   * @param {object} model
   * @param {object} [handlers]
   */
  function mount(host, model, handlers) {
    handlers = handlers || {};
    host.innerHTML = '';

    var payload = (model && model.payload) || {};
    var pdfDocument = payload.pdfDocument;
    var numPages = payload.numPages || (pdfDocument && pdfDocument.numPages) || 0;

    if (!pdfDocument || numPages < 1) {
      // 不应到达：Router 会在非 ready 时走 EmptyViewer
      var err = document.createElement('div');
      err.className = 'fp-pdf-error';
      err.textContent = 'PDF 文档不可用';
      host.appendChild(err);
      return {
        destroy: function () {
          host.innerHTML = '';
        },
        handleAction: function () {},
        getToolbarState: function () {
          return {};
        },
      };
    }

    var state = {
      page: 1,
      scale: DEFAULT_SCALE,
      thumbsOpen: numPages > 1,
      destroyed: false,
      renderTask: null,
      renderToken: 0,
      thumbsBuilt: false,
      thumbTasks: [],
      toolbarBridge: null,
    };

    // —— DOM ——
    var root = document.createElement('div');
    root.className = 'fp-pdf fp-fade-in';
    root.tabIndex = 0;

    var thumbsEl = document.createElement('aside');
    thumbsEl.className = 'fp-pdf-thumbs';
    thumbsEl.setAttribute('aria-label', '缩略图');
    if (!state.thumbsOpen) thumbsEl.hidden = true;

    var stage = document.createElement('div');
    stage.className = 'fp-pdf-stage';
    stage.setAttribute('role', 'document');

    var pageWrap = document.createElement('div');
    pageWrap.className = 'fp-pdf-page';
    pageWrap.setAttribute('aria-live', 'polite');

    var canvas = document.createElement('canvas');
    canvas.className = 'fp-pdf-canvas';
    pageWrap.appendChild(canvas);

    var statusEl = document.createElement('div');
    statusEl.className = 'fp-pdf-status';
    statusEl.hidden = true;

    stage.appendChild(pageWrap);
    stage.appendChild(statusEl);
    root.appendChild(thumbsEl);
    root.appendChild(stage);
    host.appendChild(root);

    function zoomLabel() {
      return Math.round(state.scale * 100) + '%';
    }

    function pageLabel() {
      return state.page + ' / ' + numPages;
    }

    function getToolbarState() {
      return {
        pageLabel: pageLabel(),
        zoomLabel: zoomLabel(),
        pagePrevDisabled: state.page <= 1,
        pageNextDisabled: state.page >= numPages,
        thumbnails: state.thumbsOpen,
      };
    }

    function pushToolbar() {
      var st = getToolbarState();
      if (state.toolbarBridge && typeof state.toolbarBridge.updateState === 'function') {
        state.toolbarBridge.updateState(st);
      }
      if (handlers.onToolbarState) handlers.onToolbarState(st);
    }

    function cancelRender() {
      if (state.renderTask && typeof state.renderTask.cancel === 'function') {
        try {
          state.renderTask.cancel();
        } catch (e) {
          /* ignore */
        }
      }
      state.renderTask = null;
    }

    function setStatus(msg) {
      if (!msg) {
        statusEl.hidden = true;
        statusEl.textContent = '';
        return;
      }
      statusEl.hidden = false;
      statusEl.textContent = msg;
    }

    /**
     * 渲染当前页到主 canvas
     */
    async function renderPage() {
      if (state.destroyed) return;
      cancelRender();
      var token = ++state.renderToken;
      setStatus('');
      pageWrap.classList.add('is-rendering');

      try {
        var page = await pdfDocument.getPage(state.page);
        if (state.destroyed || token !== state.renderToken) return;

        var viewport = page.getViewport({ scale: state.scale });
        var outputScale = window.devicePixelRatio || 1;
        var ctx = canvas.getContext('2d', { alpha: false });

        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = Math.floor(viewport.width) + 'px';
        canvas.style.height = Math.floor(viewport.height) + 'px';

        var transform =
          outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;

        var task = page.render({
          canvasContext: ctx,
          viewport: viewport,
          transform: transform || undefined,
        });
        state.renderTask = task;
        await task.promise;

        if (state.destroyed || token !== state.renderToken) return;
        state.renderTask = null;
        pageWrap.classList.remove('is-rendering');
        pageWrap.setAttribute(
          'aria-label',
          '第 ' + state.page + ' 页，共 ' + numPages + ' 页'
        );
        highlightThumb();
      } catch (err) {
        if (state.destroyed || token !== state.renderToken) return;
        state.renderTask = null;
        pageWrap.classList.remove('is-rendering');
        // RenderingCancelledException 忽略
        var name = err && err.name;
        if (name === 'RenderingCancelledException') return;
        setStatus((err && err.message) || '页面渲染失败');
      }
    }

    function goToPage(n) {
      var next = Math.max(1, Math.min(numPages, n | 0));
      if (next === state.page) return;
      state.page = next;
      stage.scrollTop = 0;
      pushToolbar();
      renderPage();
    }

    function setScale(s) {
      var next = Math.round(s * 100) / 100;
      next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
      if (Math.abs(next - state.scale) < 0.001) return;
      state.scale = next;
      pushToolbar();
      renderPage();
    }

    function toggleThumbs() {
      state.thumbsOpen = !state.thumbsOpen;
      thumbsEl.hidden = !state.thumbsOpen;
      root.classList.toggle('fp-pdf--thumbs-open', state.thumbsOpen);
      pushToolbar();
      if (state.thumbsOpen && !state.thumbsBuilt) {
        buildThumbnails();
      }
    }

    function highlightThumb() {
      var cards = thumbsEl.querySelectorAll('.fp-pdf-thumb');
      for (var i = 0; i < cards.length; i++) {
        var el = cards[i];
        var p = Number(el.dataset.page);
        el.classList.toggle('is-active', p === state.page);
        if (p === state.page) {
          try {
            el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          } catch (e) {
            /* ignore */
          }
        }
      }
    }

    /**
     * 懒生成缩略图（打开侧栏时）
     */
    async function buildThumbnails() {
      if (state.thumbsBuilt || state.destroyed) return;
      state.thumbsBuilt = true;
      thumbsEl.innerHTML = '';

      var list = document.createElement('div');
      list.className = 'fp-pdf-thumbs-list';

      for (var i = 1; i <= numPages; i++) {
        (function (pageNum) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'fp-pdf-thumb';
          btn.dataset.page = String(pageNum);
          btn.setAttribute('aria-label', '第 ' + pageNum + ' 页');
          if (pageNum === state.page) btn.classList.add('is-active');

          var c = document.createElement('canvas');
          c.className = 'fp-pdf-thumb-canvas';
          var label = document.createElement('span');
          label.className = 'fp-pdf-thumb-label';
          label.textContent = String(pageNum);

          btn.appendChild(c);
          btn.appendChild(label);
          btn.addEventListener('click', function () {
            goToPage(pageNum);
          });
          list.appendChild(btn);

          // 异步逐页绘制，避免阻塞
          renderThumb(pageNum, c);
        })(i);
      }

      thumbsEl.appendChild(list);
    }

    async function renderThumb(pageNum, canvasEl) {
      if (state.destroyed) return;
      try {
        var page = await pdfDocument.getPage(pageNum);
        if (state.destroyed) return;
        var viewport = page.getViewport({ scale: THUMB_SCALE });
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvasEl.width = Math.floor(viewport.width * dpr);
        canvasEl.height = Math.floor(viewport.height * dpr);
        canvasEl.style.width = Math.floor(viewport.width) + 'px';
        canvasEl.style.height = Math.floor(viewport.height) + 'px';
        var ctx = canvasEl.getContext('2d', { alpha: false });
        var task = page.render({
          canvasContext: ctx,
          viewport: viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        state.thumbTasks.push(task);
        await task.promise;
      } catch (e) {
        /* 单页缩略失败不阻塞 */
      }
    }

    function handleAction(id) {
      if (state.destroyed) return;
      switch (id) {
        case 'pagePrev':
          goToPage(state.page - 1);
          break;
        case 'pageNext':
          goToPage(state.page + 1);
          break;
        case 'zoomIn':
          setScale(state.scale + SCALE_STEP);
          break;
        case 'zoomOut':
          setScale(state.scale - SCALE_STEP);
          break;
        case 'zoomReset':
          setScale(DEFAULT_SCALE);
          break;
        case 'thumbnails':
          toggleThumbs();
          break;
        default:
          break;
      }
    }

    function onKeyDown(e) {
      if (state.destroyed) return;
      // 输入框内不劫持
      var t = e.target;
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        goToPage(state.page - 1);
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        // Space 仅在 stage 焦点时
        if (e.key === ' ' && document.activeElement !== root && document.activeElement !== stage) {
          return;
        }
        e.preventDefault();
        goToPage(state.page + 1);
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        setScale(state.scale + SCALE_STEP);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        setScale(state.scale - SCALE_STEP);
      } else if (e.key === '0') {
        e.preventDefault();
        setScale(DEFAULT_SCALE);
      }
    }

    root.addEventListener('keydown', onKeyDown);

    // Ctrl+滚轮缩放（不劫持普通滚动）
    function onWheel(e) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      var delta = e.deltaY > 0 ? -SCALE_STEP : SCALE_STEP;
      setScale(state.scale + delta);
    }
    stage.addEventListener('wheel', onWheel, { passive: false });

    // 初始渲染
    root.classList.toggle('fp-pdf--thumbs-open', state.thumbsOpen);
    if (state.thumbsOpen) buildThumbnails();
    renderPage();
    // 首帧后同步 toolbar（bindToolbar 可能在 mount 后接 bridge）
    requestAnimationFrame(pushToolbar);

    return {
      destroy: function () {
        if (state.destroyed) return;
        state.destroyed = true;
        cancelRender();
        state.thumbTasks.forEach(function (task) {
          try {
            if (task && typeof task.cancel === 'function') task.cancel();
          } catch (e) {
            /* ignore */
          }
        });
        state.thumbTasks = [];
        root.removeEventListener('keydown', onKeyDown);
        stage.removeEventListener('wheel', onWheel);
        // 释放 PDFDocument
        if (payload.dispose) {
          try {
            payload.dispose();
          } catch (e2) {
            /* ignore */
          }
        } else if (pdfDocument && typeof pdfDocument.destroy === 'function') {
          try {
            pdfDocument.destroy();
          } catch (e3) {
            /* ignore */
          }
        }
        host.innerHTML = '';
      },
      handleAction: handleAction,
      getToolbarState: getToolbarState,
      setToolbarBridge: function (bridge) {
        state.toolbarBridge = bridge || null;
        pushToolbar();
      },
    };
  }

  window.FilePreviewViewers = window.FilePreviewViewers || {};
  window.FilePreviewViewers.PdfViewer = { mount: mount };
})();
