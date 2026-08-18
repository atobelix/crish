/**
 * file-preview/viewers/MarkdownViewer.js — 复用 MarkdownEditor 查看态
 */
(function () {
  'use strict';

  function mount(host, model, opts) {
    opts = opts || {};
    host.innerHTML = '';

    var stage = document.createElement('div');
    stage.className = 'fp-md-stage fp-fade-in';
    host.appendChild(stage);

    var markdown =
      model && model.payload && model.payload.markdown != null
        ? String(model.payload.markdown)
        : '';

    var api = null;
    var destroyed = false;

    if (window.MarkdownEditor && typeof window.MarkdownEditor.mount === 'function') {
      try {
        api = window.MarkdownEditor.mount(stage, {
          markdown: markdown,
          viewOnly: true,
          onOpenPath: opts.onOpenPath,
          onOpenDoc: opts.onOpenDoc,
        });
      } catch (err) {
        // 编辑器异常时降级为纯文本，避免整页空白
        console.error('[MarkdownViewer] mount failed', err);
        api = null;
      }
    }

    if (!api) {
      // 临时降级：MarkdownEditor 未加载时静态 pre（仍无「只读」文案）
      var pre = document.createElement('pre');
      pre.className = 'fp-md-fallback';
      pre.textContent = markdown;
      stage.appendChild(pre);
      return {
        destroy: function () {
          destroyed = true;
          host.innerHTML = '';
        },
        getText: function () {
          return markdown;
        },
        getMarkdown: function () {
          return markdown;
        },
      };
    }

    return {
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        try {
          if (api && typeof api.destroy === 'function') api.destroy();
        } catch (e) {
          /* ignore */
        }
        host.innerHTML = '';
      },
      getText: function () {
        if (api && typeof api.getMarkdown === 'function') {
          return api.getMarkdown() || '';
        }
        return markdown;
      },
      getMarkdown: function () {
        if (api && typeof api.getMarkdown === 'function') {
          return api.getMarkdown() || '';
        }
        return markdown;
      },
      handleAction: function (id) {
        // 复制已由 shell 工具栏经 getText 处理；此处预留扩展
        if (id === 'copy' && api && typeof api.getMarkdown === 'function') {
          return api.getMarkdown();
        }
      },
    };
  }

  window.FilePreviewViewers = window.FilePreviewViewers || {};
  window.FilePreviewViewers.MarkdownViewer = { mount: mount };
})();
