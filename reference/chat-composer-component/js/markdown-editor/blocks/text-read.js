/**
 * markdown-editor/blocks/text-read.js — 文本类块 READ 态 HTML
 * 导出 window.MdxBlocksTextRead
 *
 * 覆盖：paragraph / heading / bullet_item / ordered_item / task_item / quote / callout / divider
 * 不覆盖：code（见 code-read.js）、table、file_chip
 */
(function () {
  'use strict';

  var CALLOUT_LABEL = {
    note: '注意',
    tip: '提示',
    important: '重要',
    warning: '警告',
    caution: '危险',
  };

  /**
   * 列表标记 HTML（bullet / ordered / task）
   * @param {object} block
   * @param {{ orderedIndexFor?: function, viewOnly?: boolean }} helpers
   */
  function markerHtml(block, helpers) {
    helpers = helpers || {};
    var viewOnly = !!helpers.viewOnly;
    if (block.type === 'bullet_item') {
      return '<span class="mdx-list-mark" aria-hidden="true">•</span>';
    }
    if (block.type === 'ordered_item') {
      var n =
        helpers.orderedIndexFor && typeof helpers.orderedIndexFor === 'function'
          ? helpers.orderedIndexFor(block.id)
          : 1;
      return (
        '<span class="mdx-list-mark" aria-hidden="true">' + n + '.</span>'
      );
    }
    if (block.type === 'task_item') {
      return (
        '<input type="checkbox" class="mdx-task-check" ' +
        (block.checked ? 'checked ' : '') +
        (viewOnly ? 'disabled ' : '') +
        'tabindex="-1" aria-label="完成状态"/>'
      );
    }
    return '';
  }

  /**
   * 文本类块读态 inner HTML（与 editor.js readContentHtml 对应分支一致）
   * @param {object} block
   * @param {{ esc: function, inlineHtml: function, orderedIndexFor?: function, viewOnly?: boolean }} helpers
   * @returns {string|null} 非本模块类型返回 null，便于调用方 fallback
   */
  function readContentHtml(block, helpers) {
    helpers = helpers || {};
    var esc = helpers.esc || function (s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    };
    var inlineHtml =
      helpers.inlineHtml ||
      function (t) {
        return esc(t);
      };
    var viewOnly = !!helpers.viewOnly;
    var t = block.text || '';

    switch (block.type) {
      case 'heading': {
        var lv = Math.max(1, Math.min(6, block.level || 1));
        var tag = 'h' + lv;
        return (
          '<' +
          tag +
          ' class="mdx-h mdx-h' +
          lv +
          '">' +
          inlineHtml(t) +
          '</' +
          tag +
          '>'
        );
      }
      case 'quote':
        return (
          '<blockquote class="mdx-quote">' +
          inlineHtml(t).replace(/\n/g, '<br>') +
          '</blockquote>'
        );
      case 'divider':
        return '<hr class="mdx-hr"/>';
      case 'callout': {
        var kind = block.callout || 'tip';
        var label = CALLOUT_LABEL[kind] || kind;
        var lines = t.split('\n');
        // 约定：首行非空 = 标题（含行内 MD）；若只有一行则整段当正文，标题用类型标签
        // 避免 GFM `> [!NOTE]\n> **正文**` 被拆成「标题=源码」的假象
        var title;
        var body;
        if (lines.length <= 1) {
          title = label;
          body = lines[0] || '';
        } else {
          title = lines[0] || label;
          body = lines.slice(1).join('\n');
          // 首行若像整段正文（过长）仍按标题渲 inline
        }
        // 标题统一走 inlineHtml：默认 label 无记号时等价转义；
        // 用户标题含 **粗** / `code` 时读态正确渲染（禁止 esc 吞记号）
        return (
          '<div class="mdx-callout mdx-callout--' +
          esc(kind) +
          '"><div class="mdx-callout__title">' +
          inlineHtml(title || label) +
          '</div><div class="mdx-callout__body">' +
          (body ? inlineHtml(body).replace(/\n/g, '<br>') : '') +
          '</div></div>'
        );
      }
      case 'bullet_item':
      case 'ordered_item':
      case 'task_item':
        return (
          '<div class="mdx-li-row">' +
          markerHtml(block, helpers) +
          '<div class="mdx-li-text">' +
          (t
            ? inlineHtml(t)
            : viewOnly
              ? ''
              : '<span class="mdx-ph">列表项</span>') +
          '</div></div>'
        );
      case 'paragraph':
        if (!t) {
          return viewOnly
            ? '<p class="mdx-p"></p>'
            : '<p class="mdx-p mdx-p--empty"><span class="mdx-ph">输入，或 / 插入块</span></p>';
        }
        return '<p class="mdx-p">' + inlineHtml(t).replace(/\n/g, '<br>') + '</p>';
      default:
        // 非文本类（code / table / file_chip 等）交回调用方
        return null;
    }
  }

  window.MdxBlocksTextRead = {
    CALLOUT_LABEL: CALLOUT_LABEL,
    markerHtml: markerHtml,
    readContentHtml: readContentHtml,
  };
})();
