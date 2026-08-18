/**
 * file-preview/adapters/image.js — 图片格式适配器
 * live File → objectURL；demo 卡 → 缩略图 / picsum
 */
(function () {
  'use strict';

  var Types = window.FilePreviewTypes;
  var Base = window.FilePreviewBase;
  var Sniff = window.FilePreviewSniff;

  var IMAGE_CAPS = [
    Types.CAP.CLOSE,
    Types.CAP.DOWNLOAD,
    Types.CAP.ZOOM,
    Types.CAP.ROTATE,
    Types.CAP.CROP,
    Types.CAP.BRUSH,
  ];

  var IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

  function isImageNameOrMime(name, mime) {
    if (mime && String(mime).toLowerCase().indexOf('image/') === 0) return true;
    if (name && IMAGE_EXT_RE.test(name)) return true;
    return false;
  }

  /**
   * 从 card DOM 解析演示图 URL（缩略图或 picsum 短 id）
   */
  function resolveDemoUrl(norm) {
    var el = norm.cardEl;
    if (!el) return null;

    var fileId = norm.fileId || el.getAttribute('data-file-id') || '';
    // 旧逻辑：短 id 的 demo 卡用 picsum 大图
    if (fileId && fileId.length < 15) {
      return 'https://picsum.photos/1200/800?random=' + encodeURIComponent(fileId);
    }

    var imgEl = el.querySelector('img.file-thumbnail, img.thumbnail, img');
    if (imgEl && imgEl.src) {
      return imgEl.src;
    }
    return null;
  }

  /**
   * 探测图片尺寸（失败不阻断）
   */
  function probeSize(url) {
    return new Promise(function (resolve) {
      var img = new Image();
      var done = false;
      function finish(w, h) {
        if (done) return;
        done = true;
        resolve({ width: w || undefined, height: h || undefined });
      }
      img.onload = function () {
        finish(img.naturalWidth, img.naturalHeight);
      };
      img.onerror = function () {
        finish(undefined, undefined);
      };
      // 跨域 picsum 等不强制 CORS，尺寸仍可读
      try {
        img.src = url;
      } catch (e) {
        finish(undefined, undefined);
      }
      // 超时兜底
      setTimeout(function () {
        finish(img.naturalWidth || undefined, img.naturalHeight || undefined);
      }, 4000);
    });
  }

  var adapter = {
    kind: Types.KIND.IMAGE,

    match: function (name, mime) {
      if (Sniff && typeof Sniff.sniff === 'function') {
        return Sniff.sniff({ name: name, mime: mime }) === Types.KIND.IMAGE;
      }
      return isImageNameOrMime(name, mime);
    },

    load: async function (ctx) {
      var norm = Base.normalizeSource(ctx.source);
      var isCancelled = ctx.isCancelled || function () {
        return false;
      };

      try {
        if (isCancelled()) throw Base.cancelError();

        var objectUrl = null;
        var revokeOnDestroy = false;
        var downloadBlob = null;
        var downloadUrl = null;

        // 1) live File → objectURL
        if (norm.file && (norm.file instanceof Blob)) {
          if (!isImageNameOrMime(norm.name, norm.mime || norm.file.type)) {
            // 嗅探已判定 image，仍尝试打开
          }
          objectUrl = URL.createObjectURL(norm.file);
          revokeOnDestroy = true;
          downloadBlob = norm.file;
        }
        // 2) 显式 url 源
        else if (norm.url) {
          objectUrl = norm.url;
          revokeOnDestroy = false;
          downloadUrl = norm.url;
        }
        // 3) card demo：缩略图 / picsum
        else if (norm.cardEl) {
          objectUrl = resolveDemoUrl(norm);
          revokeOnDestroy = false;
          if (objectUrl) downloadUrl = objectUrl;
        }

        if (!objectUrl) {
          return Base.errorModel(
            norm,
            Types.KIND.IMAGE,
            '没有可预览的图片内容',
            [Types.CAP.CLOSE]
          );
        }

        if (isCancelled()) {
          if (revokeOnDestroy) {
            try {
              URL.revokeObjectURL(objectUrl);
            } catch (e) {
              /* ignore */
            }
          }
          throw Base.cancelError();
        }

        var size = { width: undefined, height: undefined };
        try {
          size = await probeSize(objectUrl);
        } catch (e) {
          /* 尺寸可选 */
        }

        if (isCancelled()) {
          if (revokeOnDestroy) {
            try {
              URL.revokeObjectURL(objectUrl);
            } catch (e2) {
              /* ignore */
            }
          }
          throw Base.cancelError();
        }

        return Types.createModel({
          kind: Types.KIND.IMAGE,
          name: norm.name,
          size: norm.size,
          mime: norm.mime || (norm.file && norm.file.type) || 'image/*',
          status: Types.STATUS.READY,
          capabilities: IMAGE_CAPS.slice(),
          payload: {
            objectUrl: objectUrl,
            width: size.width,
            height: size.height,
            revokeOnDestroy: revokeOnDestroy,
          },
          downloadBlob: downloadBlob,
          downloadUrl: downloadUrl || (revokeOnDestroy ? objectUrl : null),
          source: ctx.source,
        });
      } catch (err) {
        if (Base.isAbort(err)) throw err;
        return Base.errorModel(
          norm,
          Types.KIND.IMAGE,
          (err && err.message) || '无法打开图片'
        );
      }
    },
  };

  window.FilePreviewAdapters = window.FilePreviewAdapters || {};
  window.FilePreviewAdapters.image = adapter;

  // 若 Router 已就绪则注册
  if (window.FilePreviewRouter && typeof window.FilePreviewRouter.registerAdapter === 'function') {
    window.FilePreviewRouter.registerAdapter(Types.KIND.IMAGE, adapter);
  }
  if (window.FilePreview && typeof window.FilePreview.registerAdapter === 'function') {
    window.FilePreview.registerAdapter(Types.KIND.IMAGE, adapter);
  }
})();
