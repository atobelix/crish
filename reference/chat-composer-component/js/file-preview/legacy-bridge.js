/**
 * file-preview/legacy-bridge.js — 兼容 window.openPreview(card)
 * 旧 preview-modal.js 不再作为主路径；此桥接保证附件卡 / 上传逻辑不改。
 */
(function () {
  'use strict';

  // 保留 liveFileStore 供上传链路写入
  window.liveFileStore = window.liveFileStore || new Map();

  /**
   * @param {HTMLElement} card
   */
  window.openPreview = function openPreview(card) {
    if (!window.FilePreview || typeof window.FilePreview.open !== 'function') {
      console.warn('[file-preview] FilePreview 未加载');
      return;
    }
    if (!card) return;
    window.FilePreview.open({ type: 'card', el: card });
  };

  // 兼容部分代码直接 close
  window.closePreview = function closePreview() {
    if (window.FilePreview) window.FilePreview.close();
  };
})();
