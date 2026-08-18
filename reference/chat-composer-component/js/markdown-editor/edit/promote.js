/**
 * markdown-editor/edit/promote.js
 * F-CORE-05 / §2.9：段落行首前缀提升 — 纯函数，无 DOM 依赖。
 *
 * 仅在「完整前缀 + 空格」时提升（防 #Title / *item 误伤）。
 * Composition：本模块不感知 IME；宿主组字中不得调用。
 *
 * API:
 *   MdxPromote.tryPromoteFromParagraph(text) → patch|null
 *   MdxPromote.isPromotePrefixComplete(text) → boolean
 */
(function () {
  'use strict';

  /**
   * 段落正文 → 结构块 patch；不完整前缀返回 null。
   *
   * 完成表（gold §2.9）：
   *   #–###### + 空格 → heading
   *   * / - / + + 空格 → bullet_item
   *   1. / 2. … + 空格 → ordered_item
   *   - [ ] / * [ ] / + [ ] → task_item
   *   > + 空格 → quote
   *   > [!NOTE] 等 → callout
   *   --- / *** / ___ 独占行 → divider
   *
   * @param {string} text
   * @returns {{ type: string, text?: string, level?: number, indent?: number, checked?: boolean, callout?: string, _mark?: string }|null}
   */
  function tryPromoteFromParagraph(text) {
    if (text == null) return null;
    var line = String(text).replace(/\r\n/g, '\n');
    // 多行段落：仅首行参与 promote（与 line-source 一致）
    var first = line.split('\n')[0] || '';
    var rest = line.indexOf('\n') >= 0 ? line.slice(line.indexOf('\n') + 1) : '';

    // 独占分割线
    if (!rest && /^(-{3,}|\*{3,}|_{3,})\s*$/.test(first.trim())) {
      return { type: 'divider', text: '' };
    }

    // 标题：必须有 hashes 后空格
    var hm = first.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      return {
        type: 'heading',
        level: hm[1].length,
        text: hm[2] || '',
      };
    }
    // 仅 # / ## 无空格 → 不 promote
    if (/^#{1,6}(\S|$)/.test(first) && !/^#{1,6}\s/.test(first)) {
      return null;
    }

    // callout：> [!NOTE] …
    var cm = first.match(/^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
    if (cm) {
      var bodyLines = rest
        ? rest.split('\n').map(function (l) {
            return l.replace(/^>\s?/, '');
          })
        : [];
      var title = cm[2] || '';
      var body = bodyLines.join('\n');
      return {
        type: 'callout',
        callout: cm[1].toLowerCase(),
        text: title + (body ? '\n' + body : ''),
      };
    }

    // 引用：必须 `>` + 空白（`>text` 不 promote）
    if (/^>\s/.test(first) || first === '> ') {
      var qtext = line
        .split('\n')
        .map(function (l) {
          return l.replace(/^>\s?/, '');
        })
        .join('\n');
      return { type: 'quote', text: qtext };
    }

    // 任务优先于 bullet：- [ ] / * [x]
    var tm = first.match(/^(\s*)([-*+])\s+\[([ xX])\]\s?(.*)$/);
    if (tm) {
      return {
        type: 'task_item',
        indent: Math.floor(tm[1].length / 2),
        checked: /x/i.test(tm[3]),
        text: tm[4] || '',
      };
    }

    // 无序：* / - / + 后必须有空格
    var bm = first.match(/^(\s*)([-*+])\s+(.*)$/);
    if (bm) {
      return {
        type: 'bullet_item',
        indent: Math.floor(bm[1].length / 2),
        text: bm[3] || '',
        _mark: bm[2],
      };
    }
    // 仅 * 无空格 → 不 promote（用户仍在输入）
    if (/^(\s*)([-*+])$/.test(first)) {
      return null;
    }

    // 有序：n. + 空格
    var om = first.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (om) {
      return {
        type: 'ordered_item',
        indent: Math.floor(om[1].length / 2),
        text: om[3] || '',
      };
    }

    return null;
  }

  function isPromotePrefixComplete(text) {
    return tryPromoteFromParagraph(text) != null;
  }

  window.MdxPromote = {
    tryPromoteFromParagraph: tryPromoteFromParagraph,
    isPromotePrefixComplete: isPromotePrefixComplete,
  };
})();
