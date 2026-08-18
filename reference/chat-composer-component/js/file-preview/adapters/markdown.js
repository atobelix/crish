/**
 * file-preview/adapters/markdown.js — Markdown 源 → PreviewModel
 */
(function () {
  'use strict';

  var Types = window.FilePreviewTypes;
  function getBase() { return window.FilePreviewBase || {}; }
  function getSniff() { return window.FilePreviewSniff || {}; }

  var MD_EXT = /\.(md|mdx|markdown)$/i;

  function isMarkdownName(name) {
    return !!(name && MD_EXT.test(name));
  }

  function isMarkdownMime(mime) {
    if (!mime || typeof mime !== 'string') return false;
    var m = mime.toLowerCase().split(';')[0].trim();
    return m === 'text/markdown' || m === 'text/x-markdown';
  }

  var adapter = {
    kind: Types.KIND.MARKDOWN,
    match: function (name, mime) {
      if (isMarkdownName(name) || isMarkdownMime(mime)) return true;
      return getSniff().sniff({ name: name, mime: mime }) === Types.KIND.MARKDOWN;
    },
    load: async function (ctx) {
      var norm = getBase().normalizeSource(ctx.source);
      try {
        var text = '';
        if (norm.file || norm.url || norm.text != null) {
          text = await getBase().readTextFromNormalized(norm, ctx.isCancelled);
        }
        return Types.createModel({
          kind: Types.KIND.MARKDOWN,
          name: norm.name || 'document.md',
          size: norm.size != null ? norm.size : text.length,
          mime: norm.mime || 'text/markdown',
          status: Types.STATUS.READY,
          capabilities: [
            Types.CAP.CLOSE,
            Types.CAP.DOWNLOAD,
            Types.CAP.COPY,
          ],
          payload: { markdown: text },
          downloadBlob: norm.file || null,
          downloadUrl: norm.url || null,
          source: ctx.source,
        });
      } catch (err) {
        if (getBase().isAbort(err)) throw err;
        return getBase().errorModel(
          norm,
          Types.KIND.MARKDOWN,
          (err && err.message) || '无法读取 Markdown'
        );
      }
    },
  };

  window.FilePreviewAdapters = window.FilePreviewAdapters || {};
  window.FilePreviewAdapters.markdown = adapter;

  if (window.FilePreviewRouter && typeof window.FilePreviewRouter.registerAdapter === 'function') {
    window.FilePreviewRouter.registerAdapter(Types.KIND.MARKDOWN, adapter);
  }
})();
