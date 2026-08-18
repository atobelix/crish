/**
 * file-preview/index.js — 公共 API：FilePreview.open / close / isOpen
 */
(function () {
  'use strict';

  var Types = window.FilePreviewTypes;
  var Base = window.FilePreviewBase;
  var Router = window.FilePreviewRouter;

  var shell = null;
  var toolbarApi = null;
  var viewerApi = null;
  var currentModel = null;
  var session = 0;
  var dirtyGuard = null; // () => boolean | Promise 是否允许关闭

  function ensureShell() {
    if (shell) return shell;
    var root =
      document.getElementById('filePreviewRoot') ||
      document.getElementById('previewModal');
    if (!root) {
      root = document.createElement('div');
      root.id = 'filePreviewRoot';
      document.body.appendChild(root);
    }
    // 若仍是旧 previewModal 全套 DOM，清空后由 Shell 接管
    if (root.id === 'previewModal') {
      root.id = 'filePreviewRoot';
      root.className = '';
      root.innerHTML = '';
    }
    shell = window.FilePreviewShell.create(root);
    return shell;
  }

  function destroyViewer() {
    if (viewerApi && typeof viewerApi.destroy === 'function') {
      try {
        viewerApi.destroy();
      } catch (e) {
        /* ignore */
      }
    }
    viewerApi = null;
  }

  /** 未挂载 Viewer 时回收 adapter 分配的资源（如图片 objectURL） */
  function revokeModelResources(model) {
    if (!model || !model.payload) return;
    var p = model.payload;
    if (p.revokeOnDestroy && p.objectUrl && String(p.objectUrl).indexOf('blob:') === 0) {
      try {
        URL.revokeObjectURL(p.objectUrl);
      } catch (e) {
        /* ignore */
      }
      p.revokeOnDestroy = false;
    }
  }

  function destroyToolbar() {
    if (toolbarApi && typeof toolbarApi.destroy === 'function') {
      try {
        toolbarApi.destroy();
      } catch (e) {
        /* ignore */
      }
    }
    toolbarApi = null;
  }

  function bindToolbar(model) {
    var s = ensureShell();
    destroyToolbar();
    var handlers = {
      onAction: function (id, detail) {
        if (id === 'close') {
          close();
          return;
        }
        if (id === 'download') {
          Base.triggerDownload(model);
          return;
        }
        if (id === 'copy') {
          var text = '';
          if (viewerApi && typeof viewerApi.getText === 'function') {
            text = viewerApi.getText() || '';
          } else if (model.payload) {
            text =
              model.payload.markdown ||
              model.payload.text ||
              model.payload.html ||
              '';
          }
          if (text && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(function () {});
          }
          return;
        }
        // 转发给当前 viewer
        if (viewerApi && typeof viewerApi.handleAction === 'function') {
          viewerApi.handleAction(id, detail || {});
        }
      },
    };

    toolbarApi = window.FilePreviewToolbar.mount(s.toolbarHost, {
      capabilities: model.capabilities || [Types.CAP.CLOSE],
      handlers: handlers,
      state: (viewerApi && viewerApi.getToolbarState
        ? viewerApi.getToolbarState()
        : {}) || {},
    });

    // viewer 可回调更新 toolbar 状态
    if (viewerApi && typeof viewerApi.setToolbarBridge === 'function') {
      viewerApi.setToolbarBridge({
        updateState: function (st) {
          if (toolbarApi) toolbarApi.updateState(st);
        },
      });
    }
  }

  function showModel(model, mySession) {
    if (mySession !== session) return;
    var s = ensureShell();
    currentModel = model;
    s.setTitle(model.name);
    s.markStageLoading();

    destroyViewer();
    var handlers = {
      onDownload: function () {
        Base.triggerDownload(model);
      },
      onDirtyChange: function (dirty) {
        dirtyGuard = dirty
          ? function () {
              return window.confirm('有未保存的修改，确定关闭？');
            }
          : null;
      },
      onToolbarState: function (st) {
        if (toolbarApi) toolbarApi.updateState(st);
      },
    };

    viewerApi = Router.mountViewer(s.stageEl, model, handlers);
    bindToolbar(model);

    // 底栏（图片等）
    if (viewerApi && typeof viewerApi.mountBottomBar === 'function') {
      s.setBottomVisible(true);
      viewerApi.mountBottomBar(s.bottomEl);
    } else {
      s.setBottomVisible(false);
    }

    requestAnimationFrame(function () {
      if (mySession !== session) return;
      s.markStageReady();
    });
  }

  /**
   * @param {object} source
   * @param {object} [options]
   */
  async function open(source, options) {
    options = options || {};
    if (!source) return;

    // 规范化 card 简写
    if (source.nodeType === 1) {
      source = { type: 'card', el: source };
    } else if (source.type == null && source.kind === 'card') {
      source = { type: 'card', el: source.el };
    } else if (source.type == null && source.file) {
      source = { type: 'file', file: source.file, name: source.name };
    } else if (source.type == null && source.text != null) {
      source = {
        type: 'text',
        name: source.name,
        text: source.text,
        mime: source.mime,
      };
    }

    var s = ensureShell();
    session += 1;
    var mySession = session;
    dirtyGuard = null;

    var norm = Base.normalizeSource(source);
    var kind = Router.resolveKind(source);
    var loading = Base.loadingModel(norm, kind);

    if (!s.isOpen()) {
      s.enter({
        title: loading.name,
        onRequestClose: function () {
          close();
        },
      });
    } else {
      s.setTitle(loading.name);
    }

    showModel(loading, mySession);

    var cancelled = false;
    try {
      var model = await Router.loadModel(source, {
        isCancelled: function () {
          return mySession !== session || cancelled;
        },
      });
      if (mySession !== session) {
        // Viewer 未挂载时仍需释放 adapter 创建的 objectURL
        revokeModelResources(model);
        return;
      }
      showModel(model, mySession);
    } catch (err) {
      if (Base.isAbort(err) || mySession !== session) return;
      showModel(
        Base.errorModel(norm, kind, (err && err.message) || '打开失败'),
        mySession
      );
    }

    return {
      cancel: function () {
        cancelled = true;
      },
    };
  }

  async function close(opts) {
    opts = opts || {};
    var s = shell;
    if (!s || (!s.isOpen() && !document.body.classList.contains('fp-preview-open'))) {
      return;
    }

    if (!opts.force && dirtyGuard) {
      var ok = dirtyGuard();
      if (ok && typeof ok.then === 'function') ok = await ok;
      if (!ok) return;
    }

    session += 1;
    destroyViewer();
    destroyToolbar();
    currentModel = null;
    dirtyGuard = null;
    await s.leave();
  }

  function isOpen() {
    return !!(shell && shell.isOpen());
  }

  function registerAdapter(kind, adapter) {
    Router.registerAdapter(kind, adapter);
  }

  function getModel() {
    return currentModel;
  }

  // 确保 unknown adapter 已注册
  if (window.FilePreviewAdapters && window.FilePreviewAdapters.unknown) {
    registerAdapter(Types.KIND.UNKNOWN, window.FilePreviewAdapters.unknown);
  }

  window.FilePreview = {
    open: open,
    close: close,
    isOpen: isOpen,
    registerAdapter: registerAdapter,
    getModel: getModel,
  };
})();
