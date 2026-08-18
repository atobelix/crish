/**
 * file-preview/adapters/text.js — 纯文本 / 代码
 */
(function () {
  'use strict';

  var Types = window.FilePreviewTypes;
  function getBase() { return window.FilePreviewBase || {}; }
  function getSniff() { return window.FilePreviewSniff || {}; }

  var adapter = {
    kind: Types.KIND.TEXT,
    match: function (name, mime) {
      return getSniff().sniff({ name: name, mime: mime }) === Types.KIND.TEXT;
    },
    load: async function (ctx) {
      var norm = getBase().normalizeSource(ctx.source);
      try {
        var text = '';
        if (norm.file || norm.url || norm.text != null) {
          text = await getBase().readTextFromNormalized(norm, ctx.isCancelled);
        }
        var lang = getSniff().languageHint(norm.name);
        return Types.createModel({
          kind: Types.KIND.TEXT,
          name: norm.name,
          size: norm.size != null ? norm.size : text.length,
          mime: norm.mime || 'text/plain',
          status: Types.STATUS.READY,
          capabilities: [
            Types.CAP.CLOSE,
            Types.CAP.DOWNLOAD,
            Types.CAP.COPY,
          ],
          payload: { text: text, language: lang },
          downloadBlob: norm.file || null,
          downloadUrl: norm.url || null,
          source: ctx.source,
        });
      } catch (err) {
        if (Base.isAbort(err)) throw err;
        return Base.errorModel(
          norm,
          Types.KIND.TEXT,
          (err && err.message) || '无法读取文本'
        );
      }
    },
  };

  window.FilePreviewAdapters = window.FilePreviewAdapters || {};
  window.FilePreviewAdapters.text = adapter;

  if (window.FilePreviewRouter && typeof window.FilePreviewRouter.registerAdapter === 'function') {
    window.FilePreviewRouter.registerAdapter(Types.KIND.TEXT, adapter);
  }
})();
