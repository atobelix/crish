/**
 * file-preview/viewers/TextViewer.js — 纯文本 / 代码查看
 */
(function () {
  'use strict';

  function mount(host, model) {
    host.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;';

    var meta = document.createElement('div');
    meta.className = 'fp-text-meta';
    var lang =
      (model.payload && model.payload.language) || 'text';
    var size = model.size != null ? model.size + ' bytes' : '';
    meta.textContent = [lang, size].filter(Boolean).join(' · ');

    var pre = document.createElement('pre');
    pre.className = 'fp-text fp-fade-in';
    pre.textContent =
      (model.payload && model.payload.text != null)
        ? String(model.payload.text)
        : '';

    wrap.appendChild(meta);
    wrap.appendChild(pre);
    host.appendChild(wrap);

    return {
      destroy: function () {
        host.innerHTML = '';
      },
      getText: function () {
        return pre.textContent || '';
      },
    };
  }

  window.FilePreviewViewers = window.FilePreviewViewers || {};
  window.FilePreviewViewers.TextViewer = { mount: mount };
})();
