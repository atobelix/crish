/**
 * file-preview/router/PreviewRouter.js — kind 推断 → adapter → viewer
 */
(function () {
  'use strict';

  var Types = window.FilePreviewTypes;
  var Sniff = window.FilePreviewSniff;
  function getBase() {
    return window.FilePreviewBase || {};
  }

  function getAdapters() {
    return window.FilePreviewAdapters || {};
  }

  function getViewers() {
    return window.FilePreviewViewers || {};
  }

  /**
   * 注册表：kind → adapter
   */
  var registry = Object.create(null);

  function registerAdapter(kind, adapter) {
    if (!kind || !adapter) return;
    registry[kind] = adapter;
    window.FilePreviewAdapters = window.FilePreviewAdapters || {};
    window.FilePreviewAdapters[kind] = adapter;
  }

  function resolveAdapter(kind) {
    if (registry[kind]) return registry[kind];
    var bag = getAdapters();
    if (bag[kind]) return bag[kind];
    return bag.unknown || null;
  }

  function resolveViewer(kind, model) {
    var V = getViewers();
    if (!model || model.status !== Types.STATUS.READY) {
      return V.EmptyViewer;
    }
    var map = {
      image: V.ImageViewer,
      pdf: V.PdfViewer,
      markdown: V.MarkdownViewer,
      docx: V.DocxViewer,
      spreadsheet: V.TableViewer,
      text: V.TextViewer,
      unknown: V.EmptyViewer,
    };
    return map[kind] || V.EmptyViewer;
  }

  /**
   * 从 source 推断 kind
   */
  function resolveKind(source) {
    var norm = getBase().normalizeSource(source);
    return Sniff.sniff({
      name: norm.name,
      mime: norm.mime,
      cardType: norm.cardType,
      file: norm.file,
    });
  }

  /**
   * @param {object} source
   * @param {{ isCancelled: function, onProgress?: function }} ctx
   * @returns {Promise<object>} PreviewModel
   */
  async function loadModel(source, ctx) {
    ctx = ctx || {};
    var kind = resolveKind(source);
    var adapter = resolveAdapter(kind);
    if (!adapter || typeof adapter.load !== 'function') {
      adapter = resolveAdapter(Types.KIND.UNKNOWN);
    }
    try {
      var model = await adapter.load({
        source: source,
        isCancelled: ctx.isCancelled || function () {
          return false;
        },
        onProgress: ctx.onProgress,
      });
      if (!model) {
        return getBase().errorModel(
          getBase().normalizeSource(source),
          kind,
          '适配器未返回内容'
        );
      }
      model.kind = model.kind || kind;
      model.source = source;
      return model;
    } catch (err) {
      if (getBase().isAbort(err)) throw err;
      return getBase().errorModel(
        getBase().normalizeSource(source),
        kind,
        (err && err.message) || '解析失败'
      );
    }
  }

  /**
   * 挂载 viewer 到 stage
   * @returns {{ destroy: function, api?: object }}
   */
  function mountViewer(stageEl, model, handlers) {
    var V = getViewers();
    var viewer =
      model && model.status === Types.STATUS.READY
        ? resolveViewer(model.kind, model)
        : V.EmptyViewer;

    if (!viewer || typeof viewer.mount !== 'function') {
      viewer = V.EmptyViewer;
    }
    stageEl.innerHTML = '';
    return viewer.mount(stageEl, model, handlers || {}) || {
      destroy: function () {
        stageEl.innerHTML = '';
      },
    };
  }

  // 预注册 unknown
  if (window.FilePreviewAdapters && window.FilePreviewAdapters.unknown) {
    registerAdapter(Types.KIND.UNKNOWN, window.FilePreviewAdapters.unknown);
  }

  window.FilePreviewRouter = {
    registerAdapter: registerAdapter,
    resolveKind: resolveKind,
    resolveAdapter: resolveAdapter,
    resolveViewer: resolveViewer,
    loadModel: loadModel,
    mountViewer: mountViewer,
  };
})();
