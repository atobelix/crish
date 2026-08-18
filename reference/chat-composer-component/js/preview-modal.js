/**
 * @deprecated 已迁移至 js/file-preview/*
 * 保留空壳避免外部误引用报 404；真实入口见 legacy-bridge.js + FilePreview API。
 * 请勿在此文件继续堆预览逻辑。
 */
(function () {
  'use strict';
  if (typeof console !== 'undefined' && console.info) {
    console.info(
      '[file-preview] preview-modal.js 已废弃，请使用 FilePreview.open / openPreview'
    );
  }
})();
