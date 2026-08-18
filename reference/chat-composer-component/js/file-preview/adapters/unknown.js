/**
 * file-preview/adapters/unknown.js — 不支持格式 / 无内容
 */
(function () {
  'use strict';

  var Types = window.FilePreviewTypes;
  var Base = window.FilePreviewBase;

  var adapter = {
    kind: Types.KIND.UNKNOWN,
    match: function () {
      return true;
    },
    load: async function (ctx) {
      var norm = Base.normalizeSource(ctx.source);
      var caps = [Types.CAP.CLOSE];
      if (norm.file || norm.url) caps.push(Types.CAP.DOWNLOAD);

      // 无 live 文件的 demo 卡：诚实说明无法预览
      var msg = '此格式暂无法在浏览器中预览';
      if (!norm.file && !norm.url && !norm.text) {
        msg = '当前没有可解析的文件内容';
      }

      return Types.createModel({
        kind: Types.KIND.UNKNOWN,
        name: norm.name,
        size: norm.size,
        mime: norm.mime,
        status: Types.STATUS.ERROR,
        errorMessage: msg,
        capabilities: caps,
        payload: {
          name: norm.name,
          size: norm.size,
          mime: norm.mime,
          unsupported: true,
        },
        downloadBlob: norm.file || null,
        downloadUrl: norm.url || null,
        source: ctx.source,
      });
    },
  };

  window.FilePreviewAdapters = window.FilePreviewAdapters || {};
  window.FilePreviewAdapters.unknown = adapter;
})();
