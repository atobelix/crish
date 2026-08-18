/**
 * ArtifactChip — 「已生成」文档胶囊
 * - 普通悬停：不预览（避免误触）
 * - Ctrl + 悬停：临时预览（未固定）
 * - 单击：打开并固定预览卡片
 */
(function () {
  'use strict';

  var FC = (window.FlowComponents = window.FlowComponents || {});

  function esc(s) {
    if (FC.dom && typeof FC.dom.esc === 'function') return FC.dom.esc(s);
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function displayTitle(title) {
    return String(title || '未命名文档').replace(/\.md$/i, '');
  }

  function resolveNotebook(opts) {
    opts = opts || {};
    if (opts.notebook) return opts.notebook;
    return FC.NotebookPanel || null;
  }

  /**
   * @param {{ kind?: string, id?: string, title: string, mime?: string, content?: string }} node
   * @param {{ notebook?: object }} [opts]
   * @returns {HTMLElement}
   */
  function render(node, opts) {
    opts = opts || {};
    node = node || {};
    var nb = resolveNotebook(opts);
    var title = node.title || '未命名文档';
    var content = node.content != null ? String(node.content) : '';

    if (nb && typeof nb.ensureDoc === 'function') {
      nb.ensureDoc(title, content);
    } else if (nb && nb.docStore && nb.docStore[title] == null) {
      nb.docStore[title] = content;
    }

    var root = document.createElement('div');
    root.className = 'flow-artifact';
    if (node.id) root.dataset.id = node.id;
    root.dataset.kind = 'artifact';
    root.dataset.docTitle = title;

    var icon = document.createElement('span');
    icon.className = 'flow-artifact__icon';
    icon.setAttribute('aria-hidden', 'true');
    if (window.FlowComponents && window.FlowComponents.dom && window.FlowComponents.dom.iconHtml) {
      icon.innerHTML = window.FlowComponents.dom.iconHtml('file');
    }

    var main = document.createElement('span');
    main.className = 'flow-artifact__main';

    var prefix = document.createElement('span');
    prefix.className = 'flow-artifact__prefix';
    prefix.textContent = '已生成';

    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'flow-artifact__chip';
    chip.setAttribute('data-doc-title', title);
    chip.textContent = displayTitle(title);
    chip.title = '点击展开 · Ctrl 悬停预览';

    main.appendChild(prefix);
    main.appendChild(chip);
    root.appendChild(icon);
    root.appendChild(main);

    function openNotebook(pin) {
      if (!nb || typeof nb.open !== 'function') return;
      var stored =
        nb.docStore && nb.docStore[title] != null ? nb.docStore[title] : content;
      nb.open(title, stored, chip, { pin: !!pin, content: stored });
      if (pin && typeof nb.setPinned === 'function') nb.setPinned(true);
    }

    function isCtrlPreview(e) {
      return !!(e && (e.ctrlKey || e.metaKey));
    }

    /* Ctrl+悬停：临时预览；松开 Ctrl 且未固定则收起 */
    chip.addEventListener('mouseenter', function (e) {
      if (!isCtrlPreview(e)) return;
      if (nb && typeof nb.clearHideTimer === 'function') nb.clearHideTimer();
      openNotebook(false);
    });

    chip.addEventListener('mousemove', function (e) {
      if (!isCtrlPreview(e)) return;
      if (nb && typeof nb.clearHideTimer === 'function') nb.clearHideTimer();
      /* 已打开同文档则不必反复 open；仍调 open 以定位 */
      openNotebook(false);
    });

    chip.addEventListener('mouseleave', function () {
      if (nb && typeof nb.scheduleHide === 'function') {
        if (!nb.isPinned || !nb.isPinned()) nb.scheduleHide();
      }
    });

    /* 单击：固定展开预览卡片 */
    chip.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openNotebook(true);
    });

    /* 在预览卡片与胶囊之间移动时：仅当已打开且未固定时保持 */
    root.addEventListener('mouseleave', function () {
      if (nb && typeof nb.scheduleHide === 'function') {
        if (!nb.isPinned || !nb.isPinned()) nb.scheduleHide();
      }
    });

    return root;
  }

  function toHtml(node) {
    node = node || {};
    var title = node.title || '未命名文档';
    return (
      '<div class="flow-artifact" data-kind="artifact"' +
      (node.id ? ' data-id="' + esc(node.id) + '"' : '') +
      ' data-doc-title="' +
      esc(title) +
      '">' +
      '<span class="flow-artifact__icon" aria-hidden="true"></span>' +
      '<span class="flow-artifact__main">' +
      '<span class="flow-artifact__prefix">已生成</span>' +
      '<button type="button" class="flow-artifact__chip" data-doc-title="' +
      esc(title) +
      '" title="点击展开 · Ctrl 悬停预览">' +
      esc(displayTitle(title)) +
      '</button></span></div>'
    );
  }

  FC.ArtifactChip = {
    render: render,
    toHtml: toHtml,
  };
})();
