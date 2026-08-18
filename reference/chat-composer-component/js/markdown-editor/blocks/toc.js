/**
 * markdown-editor/blocks/toc.js — 文内目录块
 * 导出 window.MdxBlocksToc
 *
 * 序列化：@[toc]（不把 items 写入 MD）
 * 阅读态：根据文档 headings 生成可点击列表 data-mdx-goto-heading
 */
(function () {
  'use strict';

  function esc(s) {
    if (window.MdxUtil && window.MdxUtil.esc) return window.MdxUtil.esc(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 中文友好 slug（F-M-0520）
   * @param {string} text
   * @param {Object.<string, number>} used
   */
  function slugifyHeading(text, used) {
    used = used || Object.create(null);
    var base = String(text == null ? '' : text)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\w\u4e00-\u9fff\-]+/g, '')
      .replace(/\-+/g, '-')
      .replace(/^\-|\-$/g, '');
    if (!base) base = 'section';
    var n = used[base] || 0;
    used[base] = n + 1;
    return n === 0 ? base : base + '-' + n;
  }

  /**
   * 从 blocks 扫描标题
   * @param {Array} blocks
   * @param {{ minLevel?: number, maxLevel?: number }} [opts]
   * @returns {Array<{ blockId, level, text, anchor }>}
   */
  function buildItems(blocks, opts) {
    opts = opts || {};
    var minL = opts.minLevel != null ? opts.minLevel : 1;
    var maxL = opts.maxLevel != null ? opts.maxLevel : 6;
    var used = Object.create(null);
    var items = [];
    var list = blocks || [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b || b.type !== 'heading') continue;
      var lv = Math.max(1, Math.min(6, b.level || 1));
      if (lv < minL || lv > maxL) continue;
      var text = b.text != null ? String(b.text) : '';
      // 去掉行内标记噪声（粗体等）用于显示：保留原文
      var plain = text.replace(/\*\*|__|`/g, '');
      var anchor = slugifyHeading(plain, used);
      items.push({
        blockId: b.id,
        level: lv,
        text: plain || text || '(无标题)',
        anchor: anchor,
      });
    }
    return items;
  }

  /** 是否为 TOC 标记行 */
  function parseMdLine(line) {
    var raw = String(line == null ? '' : line).trim();
    if (/^@\[toc\]\s*$/i.test(raw)) return { type: 'toc', text: '' };
    if (/^<!--\s*conex:toc\s*-->\s*$/i.test(raw)) return { type: 'toc', text: '' };
    return null;
  }

  function toMd(/* block */) {
    return '@[toc]';
  }

  /**
   * @param {object} block
   * @param {{ blocks?: Array, minLevel?: number, maxLevel?: number }} helpers
   */
  function readHtml(block, helpers) {
    helpers = helpers || {};
    block = block || {};
    var minL = block.minLevel != null ? block.minLevel : helpers.minLevel != null ? helpers.minLevel : 1;
    var maxL = block.maxLevel != null ? block.maxLevel : helpers.maxLevel != null ? helpers.maxLevel : 6;
    var items =
      helpers.items ||
      buildItems(helpers.blocks || [], { minLevel: minL, maxLevel: maxL });

    var listHtml;
    if (!items.length) {
      listHtml = '<li class="mdx-toc__empty">暂无标题</li>';
    } else {
      listHtml = items
        .map(function (it) {
          return (
            '<li class="mdx-toc__item mdx-toc__item--h' +
            it.level +
            '" style="--mdx-toc-level:' +
            it.level +
            '">' +
            '<a class="mdx-toc__link" href="#' +
            esc(it.anchor) +
            '" data-mdx-goto-heading="' +
            esc(it.blockId) +
            '" data-mdx-anchor="' +
            esc(it.anchor) +
            '">' +
            esc(it.text) +
            '</a></li>'
          );
        })
        .join('');
    }

    return (
      '<nav class="mdx-toc" data-mdx-toc aria-label="目录">' +
      '<div class="mdx-toc__title">目录</div>' +
      '<ol class="mdx-toc__list">' +
      listHtml +
      '</ol></nav>'
    );
  }

  function editHtml(block, helpers) {
    // 编辑态：显示只读预览 + 说明（改标题即刷新；整块可选中）
    var preview = readHtml(block, helpers);
    return (
      '<div class="mdx-toc-edit" data-mdx-toc-edit data-block-type="toc">' +
      preview +
      '<div class="mdx-toc-edit__hint">目录自动从标题生成 · 不写入 Markdown 列表</div>' +
      '</div>'
    );
  }

  function createEmpty() {
    return { type: 'toc', text: '', minLevel: 1, maxLevel: 6 };
  }

  if (window.MdxRegistry && typeof window.MdxRegistry.register === 'function') {
    try {
      window.MdxRegistry.register({
        type: 'toc',
        renderRead: readHtml,
        toMarkdown: toMd,
        slash: {
          id: 'toc',
          title: '目录',
          aliases: ['toc', '目录', '大纲'],
          section: '结构',
        },
      });
    } catch (eReg) {
      /* ignore */
    }
  }

  window.MdxBlocksToc = {
    slugifyHeading: slugifyHeading,
    buildItems: buildItems,
    parseMdLine: parseMdLine,
    toMd: toMd,
    readHtml: readHtml,
    editHtml: editHtml,
    createEmpty: createEmpty,
  };
})();
