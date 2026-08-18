/**
 * file-preview/adapters/base.js — 源读取与通用工具
 */
(function () {
  'use strict';

  var Types = window.FilePreviewTypes;

  /**
   * 从 PreviewSource 解析出 { name, mime, size, file?, url?, text?, cardEl? }
   */
  function normalizeSource(source) {
    if (!source) return { name: '未命名文件' };
    if (source.type === 'card' || source.kind === 'card') {
      var el = source.el || source.card;
      if (!el) return { name: '未命名文件' };
      var fileId = el.getAttribute('data-file-id');
      var liveFile =
        fileId && window.liveFileStore ? window.liveFileStore.get(fileId) : null;
      var name =
        (liveFile && liveFile.name) ||
        el.getAttribute('data-file-name') ||
        '未命名文件';
      var cardType = el.getAttribute('data-file-type') || '';
      var realText = window.REAL_FILE_MAP ? window.REAL_FILE_MAP[name.toLowerCase().trim()] : null;
      return {
        name: name,
        mime: liveFile ? liveFile.type : '',
        size: liveFile ? liveFile.size : (realText ? realText.length : undefined),
        file: liveFile || null,
        text: realText || null,
        cardEl: el,
        cardType: cardType,
        fileId: fileId,
      };
    }
    if (source.type === 'file' || source.file instanceof File) {
      var f = source.file || source;
      return {
        name: source.name || f.name || '未命名文件',
        mime: f.type || source.mime || '',
        size: f.size,
        file: f,
      };
    }
    if (source.type === 'text' || (source.text != null && source.name)) {
      return {
        name: source.name || '未命名文件',
        mime: source.mime || 'text/plain',
        text: String(source.text),
        size: String(source.text).length,
      };
    }
    if (source.type === 'url' || source.url) {
      return {
        name: source.name || guessNameFromUrl(source.url) || '远程文件',
        mime: source.mime || '',
        url: source.url,
      };
    }
    if (source.type === 'path' || source.path) {
      return {
        name: source.name || source.path.split(/[\\/]/).pop() || '本地文件',
        path: source.path,
        mime: source.mime || '',
      };
    }
    return { name: source.name || '未命名文件', mime: source.mime || '' };
  }

  function guessNameFromUrl(url) {
    try {
      var u = new URL(url, location.href);
      var seg = u.pathname.split('/').filter(Boolean).pop();
      return seg ? decodeURIComponent(seg) : null;
    } catch (e) {
      return null;
    }
  }

  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result || ''));
      };
      reader.onerror = function () {
        reject(new Error('读取文件失败'));
      };
      reader.readAsText(file);
    });
  }

  function readFileAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.onerror = function () {
        reject(new Error('读取文件失败'));
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result || ''));
      };
      reader.onerror = function () {
        reject(new Error('读取文件失败'));
      };
      reader.readAsDataURL(file);
    });
  }

  async function readTextFromNormalized(norm, isCancelled) {
    if (norm.text != null) return String(norm.text);
    if (norm.file) {
      if (isCancelled && isCancelled()) throw cancelError();
      return readFileAsText(norm.file);
    }
    if (norm.url) {
      if (isCancelled && isCancelled()) throw cancelError();
      var res = await fetch(norm.url);
      if (!res.ok) throw new Error('网络请求失败 (' + res.status + ')');
      return res.text();
    }
    throw new Error('没有可读取的文本内容');
  }

  async function readBufferFromNormalized(norm, isCancelled) {
    if (norm.file) {
      if (isCancelled && isCancelled()) throw cancelError();
      return readFileAsArrayBuffer(norm.file);
    }
    if (norm.url) {
      if (isCancelled && isCancelled()) throw cancelError();
      var res = await fetch(norm.url);
      if (!res.ok) throw new Error('网络请求失败 (' + res.status + ')');
      return res.arrayBuffer();
    }
    throw new Error('没有可读取的二进制内容');
  }

  function cancelError() {
    var err = new Error('已取消');
    err.name = 'AbortError';
    return err;
  }

  function isAbort(err) {
    return err && (err.name === 'AbortError' || err.message === '已取消');
  }

  function loadingModel(norm, kind) {
    return Types.createModel({
      kind: kind || Types.KIND.UNKNOWN,
      name: norm.name,
      size: norm.size,
      mime: norm.mime,
      status: Types.STATUS.LOADING,
      capabilities: [Types.CAP.CLOSE],
      payload: null,
    });
  }

  function errorModel(norm, kind, message, caps) {
    return Types.createModel({
      kind: kind || Types.KIND.UNKNOWN,
      name: norm.name,
      size: norm.size,
      mime: norm.mime,
      status: Types.STATUS.ERROR,
      errorMessage: message || '无法打开此文件',
      capabilities: caps || [Types.CAP.CLOSE, Types.CAP.DOWNLOAD],
      payload: { name: norm.name, size: norm.size, mime: norm.mime },
      downloadBlob: norm.file || null,
      downloadUrl: norm.url || null,
    });
  }

  function formatSize(n) {
    if (n == null || isNaN(n)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function triggerDownload(model) {
    if (!model) return;
    if (model.downloadBlob instanceof Blob) {
      var url = URL.createObjectURL(model.downloadBlob);
      var a = document.createElement('a');
      a.href = url;
      a.download = model.name || 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 1000);
      return;
    }
    if (model.downloadUrl) {
      var a2 = document.createElement('a');
      a2.href = model.downloadUrl;
      a2.download = model.name || 'download';
      a2.target = '_blank';
      a2.rel = 'noopener';
      document.body.appendChild(a2);
      a2.click();
      a2.remove();
      return;
    }
    if (model.payload && model.payload.markdown != null) {
      var blob = new Blob([model.payload.markdown], {
        type: 'text/markdown;charset=utf-8',
      });
      model.downloadBlob = blob;
      return triggerDownload(model);
    }
    if (model.payload && model.payload.text != null) {
      var blob2 = new Blob([model.payload.text], {
        type: 'text/plain;charset=utf-8',
      });
      model.downloadBlob = blob2;
      return triggerDownload(model);
    }
  }

  window.FilePreviewBase = {
    normalizeSource: normalizeSource,
    readFileAsText: readFileAsText,
    readFileAsArrayBuffer: readFileAsArrayBuffer,
    readFileAsDataUrl: readFileAsDataUrl,
    readTextFromNormalized: readTextFromNormalized,
    readBufferFromNormalized: readBufferFromNormalized,
    cancelError: cancelError,
    isAbort: isAbort,
    loadingModel: loadingModel,
    errorModel: errorModel,
    formatSize: formatSize,
    triggerDownload: triggerDownload,
  };
})();
