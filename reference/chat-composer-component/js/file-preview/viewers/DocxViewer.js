/**
 * file-preview/viewers/DocxViewer.js — DOCX 文章阅读区
 *
 * 只消费 PreviewModel.payload.html（已由 adapter 消毒），
 * 不二次解析文件、不执行脚本。
 */
(function () {
  'use strict';

  /**
   * @param {HTMLElement} host
   * @param {object} model
   * @returns {{ destroy: function, getText?: function }}
   */
  function mount(host, model) {
    host.innerHTML = '';

    var root = document.createElement('div');
    root.className = 'fp-docx fp-fade-in';
    root.setAttribute('role', 'document');

    var article = document.createElement('article');
    article.className = 'fp-docx-article';

    var html =
      model && model.payload && model.payload.html != null
        ? String(model.payload.html)
        : '';

    // 已消毒 HTML；使用 innerHTML 渲染版式
    article.innerHTML = html;

    // 外链安全：统一 noopener（adapter 已剥离 javascript:）
    var links = article.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var href = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href) || href.indexOf('//') === 0) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
    }

    root.appendChild(article);
    host.appendChild(root);

    return {
      destroy: function () {
        host.innerHTML = '';
      },
      getText: function () {
        return article.innerText || article.textContent || '';
      },
    };
  }

  window.FilePreviewViewers = window.FilePreviewViewers || {};
  window.FilePreviewViewers.DocxViewer = { mount: mount };
})();
