/**
 * markdown-editor/media/drop-paste.js — 粘贴 / 拖放图片
 * 导出 window.MdxMediaDropPaste
 *
 * 宿主端口：options.uploadImage?(file) => Promise<{url, alt?}>
 * 无端口：object URL + 可预览 src（不抛异常）
 */
(function () {
  'use strict';

  var IMAGE_MIME = /^image\//i;
  var IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

  function isImageFile(file) {
    if (!file) return false;
    if (file.type && IMAGE_MIME.test(file.type)) return true;
    if (file.name && IMAGE_EXT.test(file.name)) return true;
    return false;
  }

  function filesFromClipboard(e) {
    var out = [];
    var cd = e && e.clipboardData;
    if (!cd) return out;
    if (cd.files && cd.files.length) {
      for (var i = 0; i < cd.files.length; i++) {
        if (isImageFile(cd.files[i])) out.push(cd.files[i]);
      }
    }
    if (!out.length && cd.items) {
      for (var j = 0; j < cd.items.length; j++) {
        var it = cd.items[j];
        if (it.kind === 'file' && IMAGE_MIME.test(it.type || '')) {
          var f = it.getAsFile && it.getAsFile();
          if (f) out.push(f);
        }
      }
    }
    return out;
  }

  function filesFromDataTransfer(dt) {
    var out = [];
    if (!dt || !dt.files) return out;
    for (var i = 0; i < dt.files.length; i++) {
      if (isImageFile(dt.files[i])) out.push(dt.files[i]);
    }
    return out;
  }

  /**
   * 上传或本地 blob 预览
   * @param {File} file
   * @param {{ uploadImage?: function, maxBytes?: number, source?: string, blockId?: string }} ports
   * @returns {Promise<{url:string, alt?:string, name?:string, status?:string}>}
   */
  function resolveImageFile(file, ports) {
    ports = ports || {};
    var max = ports.maxBytes != null ? ports.maxBytes : 20 * 1024 * 1024;
    if (file.size > max) {
      return Promise.reject(new Error('图片超过大小限制（' + Math.round(max / 1024 / 1024) + 'MB）'));
    }
    if (typeof ports.uploadImage === 'function') {
      return Promise.resolve(
        ports.uploadImage(file, {
          kind: 'image',
          source: ports.source || 'paste',
          blockId: ports.blockId,
        })
      ).then(function (res) {
        if (!res || !res.url) throw new Error('上传未返回 url');
        return {
          url: res.url,
          alt: res.alt || file.name || '',
          name: res.name || file.name,
          status: 'ready',
        };
      });
    }
    // 无端口：object URL 本地预览
    var url = URL.createObjectURL(file);
    return Promise.resolve({
      url: url,
      alt: file.name || 'pasted-image',
      name: file.name,
      status: 'ready',
    });
  }

  /**
   * 绑定编辑器根节点 paste / drop
   * @param {HTMLElement} root
   * @param {{
   *   viewOnly?: boolean,
   *   getUploadImage?: function,
   *   maxUploadBytes?: number,
   *   onInsertImages?: function(Array<{src,alt,title?}>, meta): void,
   *   onError?: function(Error|string): void,
   *   preferImage?: boolean
   * }} api
   * @returns {{ destroy: function }}
   */
  function bind(root, api) {
    api = api || {};
    if (!root) return { destroy: function () {} };

    function uploadPort() {
      if (typeof api.getUploadImage === 'function') return api.getUploadImage();
      return api.uploadImage;
    }

    function handleFiles(files, source, e) {
      if (!files || !files.length) return false;
      if (api.viewOnly) return false;
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      var ports = {
        uploadImage: uploadPort(),
        maxBytes: api.maxUploadBytes,
        source: source,
      };
      var tasks = files.map(function (f) {
        return resolveImageFile(f, ports);
      });
      Promise.all(
        tasks.map(function (p) {
          return p.then(
            function (r) {
              return r;
            },
            function (err) {
              if (api.onError) api.onError(err);
              return null;
            }
          );
        })
      ).then(function (results) {
        var blocks = [];
        for (var i = 0; i < results.length; i++) {
          var r = results[i];
          if (!r || !r.url) continue;
          blocks.push({
            type: 'image',
            src: r.url,
            alt: r.alt || '',
            text: r.alt || '',
            title: '',
            caption: '',
            meta: { status: r.status || 'ready' },
          });
        }
        if (blocks.length && typeof api.onInsertImages === 'function') {
          api.onInsertImages(blocks, { source: source });
        }
      });
      return true;
    }

    function onPaste(e) {
      if (api.viewOnly) return;
      var files = filesFromClipboard(e);
      if (!files.length) return;
      // 有图时默认优先图（媒体面）
      handleFiles(files, 'paste', e);
    }

    function onDragOver(e) {
      if (api.viewOnly) return;
      var dt = e.dataTransfer;
      if (!dt) return;
      if (dt.types && (dt.types.indexOf('Files') >= 0 || (dt.types.contains && dt.types.contains('Files')))) {
        e.preventDefault();
        dt.dropEffect = 'copy';
        root.classList.add('mdx-editor--media-drag');
      }
    }

    function onDragLeave(e) {
      if (!root.contains(e.relatedTarget)) {
        root.classList.remove('mdx-editor--media-drag');
      }
    }

    function onDrop(e) {
      root.classList.remove('mdx-editor--media-drag');
      if (api.viewOnly) return;
      var files = filesFromDataTransfer(e.dataTransfer);
      if (!files.length) return;
      handleFiles(files, 'drop', e);
    }

    root.addEventListener('paste', onPaste);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('dragleave', onDragLeave);
    root.addEventListener('drop', onDrop);

    return {
      destroy: function () {
        root.removeEventListener('paste', onPaste);
        root.removeEventListener('dragover', onDragOver);
        root.removeEventListener('dragleave', onDragLeave);
        root.removeEventListener('drop', onDrop);
        root.classList.remove('mdx-editor--media-drag');
      },
      isImageFile: isImageFile,
      resolveImageFile: resolveImageFile,
    };
  }

  window.MdxMediaDropPaste = {
    bind: bind,
    isImageFile: isImageFile,
    filesFromClipboard: filesFromClipboard,
    filesFromDataTransfer: filesFromDataTransfer,
    resolveImageFile: resolveImageFile,
  };
})();
