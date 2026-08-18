/**
 * file-preview/model/types.js — 类型常量与工厂
 */
(function () {
  'use strict';

  var KIND = {
    IMAGE: 'image',
    PDF: 'pdf',
    MARKDOWN: 'markdown',
    DOCX: 'docx',
    SPREADSHEET: 'spreadsheet',
    TEXT: 'text',
    UNKNOWN: 'unknown',
  };

  var CAP = {
    CLOSE: 'close',
    DOWNLOAD: 'download',
    ZOOM: 'zoom',
    ROTATE: 'rotate',
    PAGE: 'page',
    THUMBNAILS: 'thumbnails',
    SEARCH: 'search',
    COPY: 'copy',
    CROP: 'crop',
    BRUSH: 'brush',
    SHEET: 'sheet',
  };

  var STATUS = {
    LOADING: 'loading',
    READY: 'ready',
    ERROR: 'error',
  };

  var _id = 0;
  function nextId() {
    _id += 1;
    return 'fp-' + Date.now().toString(36) + '-' + _id;
  }

  /**
   * @param {Partial<object>} partial
   * @returns {object}
   */
  function createModel(partial) {
    partial = partial || {};
    return {
      id: partial.id || nextId(),
      kind: partial.kind || KIND.UNKNOWN,
      name: partial.name || '未命名文件',
      size: partial.size,
      mime: partial.mime,
      status: partial.status || STATUS.LOADING,
      errorMessage: partial.errorMessage,
      capabilities: partial.capabilities || [CAP.CLOSE],
      payload: partial.payload != null ? partial.payload : null,
      source: partial.source || null,
      downloadUrl: partial.downloadUrl || null,
      downloadBlob: partial.downloadBlob || null,
    };
  }

  window.FilePreviewTypes = {
    KIND: KIND,
    CAP: CAP,
    STATUS: STATUS,
    nextId: nextId,
    createModel: createModel,
  };
})();
