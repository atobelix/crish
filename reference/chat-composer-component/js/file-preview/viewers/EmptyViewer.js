/**
 * file-preview/viewers/EmptyViewer.js — loading / error / unsupported
 */
(function () {
  'use strict';

  var Types = window.FilePreviewTypes;
  var Base = window.FilePreviewBase;

  var ICON_FILE =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  var ICON_WARN =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

  function mount(host, model, handlers) {
    handlers = handlers || {};
    host.innerHTML = '';

    var wrap = document.createElement('div');
    wrap.className = 'fp-empty fp-fade-in';

    if (!model || model.status === Types.STATUS.LOADING) {
      wrap.innerHTML =
        '<div class="fp-skeleton" aria-busy="true" aria-label="加载中">' +
        '<div class="fp-skeleton-bar w100"></div>' +
        '<div class="fp-skeleton-bar w80"></div>' +
        '<div class="fp-skeleton-bar w60"></div>' +
        '<div class="fp-skeleton-bar w100"></div>' +
        '<div class="fp-skeleton-bar w80"></div>' +
        '</div>';
      host.appendChild(wrap);
      return { destroy: function () { host.innerHTML = ''; } };
    }

    var unsupported = model.payload && model.payload.unsupported;
    var title = unsupported ? '无法预览' : '打开失败';
    var desc =
      model.errorMessage ||
      (unsupported ? '此格式暂不支持在线预览' : '文件解析出错');

    var icon = document.createElement('div');
    icon.className = 'fp-empty-icon';
    icon.innerHTML = unsupported ? ICON_FILE : ICON_WARN;

    var h = document.createElement('div');
    h.className = 'fp-empty-title';
    h.textContent = title;

    var p = document.createElement('div');
    p.className = 'fp-empty-desc';
    p.textContent = desc;

    wrap.appendChild(icon);
    wrap.appendChild(h);
    wrap.appendChild(p);

    var canDownload =
      model.capabilities &&
      model.capabilities.indexOf(Types.CAP.DOWNLOAD) >= 0 &&
      (model.downloadBlob || model.downloadUrl);

    if (canDownload) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fp-empty-action';
      btn.textContent = '下载文件';
      btn.addEventListener('click', function () {
        if (handlers.onDownload) handlers.onDownload(model);
        else Base.triggerDownload(model);
      });
      wrap.appendChild(btn);
    }

    host.appendChild(wrap);
    return {
      destroy: function () {
        host.innerHTML = '';
      },
    };
  }

  window.FilePreviewViewers = window.FilePreviewViewers || {};
  window.FilePreviewViewers.EmptyViewer = { mount: mount };
})();
