/**
 * markdown-editor/edit/clipboard/copy.js
 * 选区 / 块 → Markdown 剪贴板
 * 导出 window.MdxClipboardCopy
 */
(function () {
  'use strict';

  function Ser() {
    return window.MdxSerialize;
  }
  function Schema() {
    return window.MdxSchema;
  }
  function LineSrc() {
    return window.MdxLineSource;
  }

  /**
   * 有序块列表 → GFM Markdown
   */
  function blocksToMarkdown(blocks) {
    if (!blocks || !blocks.length) return '';
    if (Ser() && typeof Ser().serialize === 'function') {
      var doc = { version: 2, blocks: blocks };
      if (Schema() && Schema().migrate) {
        try {
          doc = Schema().migrate(doc);
        } catch (e) {
          /* ignore */
        }
      }
      try {
        return Ser().serialize(doc);
      } catch (e2) {
        /* fall */
      }
    }
    if (Ser() && typeof Ser().serializeBlock === 'function') {
      return blocks
        .map(function (b) {
          return Ser().serializeBlock(b);
        })
        .filter(Boolean)
        .join('\n\n');
    }
    var LS = LineSrc();
    return blocks
      .map(function (b) {
        if (LS && LS.toSourceLine) return LS.toSourceLine(b);
        return b.text || '';
      })
      .join('\n\n');
  }

  /**
   * 写入剪贴板事件或 navigator
   */
  function writeMarkdown(md, e) {
    if (!md) return false;
    if (e && e.clipboardData) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', md);
      try {
        e.clipboardData.setData('text/markdown', md);
      } catch (err) {
        /* ignore */
      }
      return true;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(md).catch(function () {});
      return true;
    }
    return false;
  }

  window.MdxClipboardCopy = {
    blocksToMarkdown: blocksToMarkdown,
    writeMarkdown: writeMarkdown,
  };
})();
