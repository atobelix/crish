/**
 * markdown-editor/ui/line-source.js
 * Typora 式行源码：块 ↔ 行源码字符串；编辑表面 HTML（灰标记 + 正文）
 *
 * 规则摘要：
 * - 未聚焦：精致渲染（由 editor readContentHtml）
 * - 聚焦文本行：显示结构前缀源码（## / * / 1. / >）+ 正文
 * - 退格：先删正文 → 空格 → 灰色标记 → 降级类型 → 段落
 * - 列表：软渲染时标记显示 ·，点标记还原 *
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

  function inlineHtml(text) {
    if (window.MdxUtil && window.MdxUtil.inlineHtml) {
      return window.MdxUtil.inlineHtml(text).replace(/\n/g, '<br>');
    }
    return esc(text).replace(/\n/g, '<br>');
  }

  /** 与 text-read / editor 读态一致的中文类型标签 */
  var CALLOUT_LABEL = {
    note: '注意',
    tip: '提示',
    important: '重要',
    warning: '警告',
    caution: '危险',
  };

  function calloutLabel(kind) {
    kind = (kind || 'note').toLowerCase();
    return CALLOUT_LABEL[kind] || kind;
  }

  /** block → 单行/多行源码（编辑态整行真相） */
  function toSourceLine(block) {
    if (!block) return '';
    var text = block.text != null ? String(block.text) : '';
    var ind = '';
    var i;
    for (i = 0; i < (block.indent || 0); i++) ind += '  ';

    switch (block.type) {
      case 'heading': {
        var lv = Math.max(1, Math.min(6, block.level || 1));
        var hashes = '';
        for (i = 0; i < lv; i++) hashes += '#';
        return hashes + (text ? ' ' + text.replace(/\n/g, ' ') : '');
      }
      case 'bullet_item':
        return ind + '* ' + text;
      case 'ordered_item':
        return ind + '1. ' + text;
      case 'task_item':
        return ind + '- [' + (block.checked ? 'x' : ' ') + '] ' + text;
      case 'quote':
        if (!text) return '> ';
        return text
          .split('\n')
          .map(function (l) {
            return '> ' + l;
          })
          .join('\n');
      case 'callout': {
        var kind = (block.callout || 'note').toUpperCase();
        var lines = text.split('\n');
        var title = lines[0] || '';
        var out = ['> [!' + kind + ']' + (title ? ' ' + title : '')];
        lines.slice(1).forEach(function (l) {
          out.push('> ' + l);
        });
        return out.join('\n');
      }
      case 'divider':
        return '---';
      case 'code': {
        var lang = block.lang || '';
        return '```' + lang + '\n' + text.replace(/\n$/, '') + '\n```';
      }
      case 'mermaid': {
        return '```mermaid\n' + text.replace(/\n$/, '') + '\n```';
      }
      case 'math': {
        var MathMod = window.MdxBlocksMath;
        if (MathMod && typeof MathMod.dollarSource === 'function') {
          return MathMod.dollarSource(block);
        }
        return '$$\n' + text.replace(/^\n+/, '').replace(/\n+$/, '') + '\n$$';
      }
      case 'paragraph':
      default:
        return text;
    }
  }

  /**
   * 解析一行（或代码 fence 全文）→ patch
   * @returns {{ type: string, text?: string, level?: number, indent?: number, checked?: boolean, lang?: string, callout?: string }|null}
   */
  function parseSourceLine(raw) {
    var line = String(raw == null ? '' : raw).replace(/\r\n/g, '\n');
    // 公式 $$…$$
    var mathM = line.match(/^\$\$\s*\n?([\s\S]*?)\n?\s*\$\$\s*$/);
    if (mathM || (line.indexOf('$$') === 0 && line.lastIndexOf('$$') > 1)) {
      var mm = line.match(/^\$\$\s*\n?([\s\S]*?)\n?\s*\$\$\s*$/);
      if (mm) {
        return {
          type: 'math',
          text: (mm[1] || '').replace(/^\n+/, '').replace(/\n+$/, ''),
        };
      }
    }
    // 代码围栏（含 mermaid → code+lang）
    var fence = line.match(/^```([^\n]*)\n([\s\S]*?)(?:\n```)?$/);
    if (fence || line.indexOf('```') === 0) {
      var m = line.match(/^```([^\n]*)\n?([\s\S]*?)(?:\n```\s*)?$/);
      if (m) {
        return {
          type: 'code',
          lang: (m[1] || '').trim(),
          text: (m[2] || '').replace(/\n$/, ''),
        };
      }
    }

    // 多行 quote / callout：取首行判断
    var first = line.split('\n')[0] || '';
    var rest = line.indexOf('\n') >= 0 ? line.slice(line.indexOf('\n') + 1) : '';

    var hm = first.match(/^(#{1,6})(\s*)(.*)$/);
    if (hm) {
      return {
        type: 'heading',
        level: hm[1].length,
        text: hm[3] || '',
        _hashOnly: !hm[2] && !hm[3],
        _noSpace: !hm[2] && !!hm[3],
      };
    }

    var tm = first.match(/^(\s*)([-*+])\s+\[([ xX])\]\s?(.*)$/);
    if (tm) {
      return {
        type: 'task_item',
        indent: Math.floor(tm[1].length / 2),
        checked: /x/i.test(tm[3]),
        text: tm[4] || '',
      };
    }

    var bm = first.match(/^(\s*)([-*+])(\s+)(.*)$/);
    if (bm) {
      return {
        type: 'bullet_item',
        indent: Math.floor(bm[1].length / 2),
        text: bm[4] || '',
        _mark: bm[2],
      };
    }
    // 仅 * 无空格
    var bonly = first.match(/^(\s*)([-*+])$/);
    if (bonly) {
      return {
        type: 'bullet_item',
        indent: Math.floor(bonly[1].length / 2),
        text: '',
        _markOnly: true,
        _mark: bonly[2],
      };
    }

    var om = first.match(/^(\s*)(\d+)\.(\s+)(.*)$/);
    if (om) {
      return {
        type: 'ordered_item',
        indent: Math.floor(om[1].length / 2),
        text: om[4] || '',
      };
    }

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

    if (/^>\s?/.test(first) || first === '>') {
      var qtext = line
        .split('\n')
        .map(function (l) {
          return l.replace(/^>\s?/, '');
        })
        .join('\n');
      return { type: 'quote', text: qtext };
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(first.trim()) && !rest) {
      return { type: 'divider', text: '' };
    }

    return { type: 'paragraph', text: line };
  }

  /**
   * 编辑表面 HTML：结构标记灰显 + 正文 contenteditable
   * softListMark：列表用 · 显示（data-src 保留 *）
   */
  function renderEditSurface(block, opts) {
    opts = opts || {};
    var softList = opts.softListMark !== false;
    var text = block.text != null ? String(block.text) : '';
    var bodyHtml = text ? inlineHtml(text) : '';
    var mark = '';
    var markClass = 'mdx-src-mark';
    var gap = '<span class="mdx-src-gap" data-mdx-gap> </span>';
    var type = block.type;

    if (type === 'heading') {
      var lv = Math.max(1, Math.min(6, block.level || 1));
      var hashes = '';
      for (var i = 0; i < lv; i++) hashes += '#';
      mark =
        '<span class="' +
        markClass +
        ' mdx-src-mark--heading" contenteditable="false" data-mdx-mark data-kind="heading" data-level="' +
        lv +
        '">' +
        esc(hashes) +
        '</span>';
      return (
        '<div class="mdx-line-edit mdx-h mdx-h' +
        lv +
        '" data-mdx-line-edit data-block-type="heading">' +
        mark +
        gap +
        '<div class="mdx-src-body mdx-edit" data-mdx-edit contenteditable="true" role="textbox" data-placeholder="标题">' +
        bodyHtml +
        '</div></div>'
      );
    }

    if (type === 'bullet_item') {
      // soft · 默认；hard * 时加 is-source-visible。固定槽宽见 .mdx-src-mark--bullet
      var bullet = softList ? '·' : '*';
      var bulletExtra = softList ? '' : ' is-source-visible';
      mark =
        '<span class="' +
        markClass +
        ' mdx-src-mark--bullet' +
        bulletExtra +
        '" contenteditable="false" tabindex="0" data-mdx-mark data-kind="bullet" data-src="*" title="*" aria-label="列表标记">' +
        esc(bullet) +
        '</span>';
      return (
        '<div class="mdx-line-edit mdx-li" data-mdx-line-edit data-block-type="bullet_item" style="padding-left:' +
        (block.indent || 0) * 1.25 +
        'em">' +
        mark +
        gap +
        '<div class="mdx-src-body mdx-edit" data-mdx-edit contenteditable="true" role="textbox" data-placeholder="列表项">' +
        bodyHtml +
        '</div></div>'
      );
    }

    if (type === 'ordered_item') {
      mark =
        '<span class="' +
        markClass +
        ' mdx-src-mark--ordered" contenteditable="false" data-mdx-mark data-kind="ordered" data-src="1.">1.</span>';
      return (
        '<div class="mdx-line-edit mdx-li" data-mdx-line-edit data-block-type="ordered_item" style="padding-left:' +
        (block.indent || 0) * 1.25 +
        'em">' +
        mark +
        gap +
        '<div class="mdx-src-body mdx-edit" data-mdx-edit contenteditable="true" role="textbox" data-placeholder="列表项">' +
        bodyHtml +
        '</div></div>'
      );
    }

    if (type === 'task_item') {
      var ck = block.checked ? 'x' : ' ';
      mark =
        '<span class="' +
        markClass +
        ' mdx-src-mark--task" contenteditable="false" data-mdx-mark data-kind="task">- [' +
        ck +
        ']</span>';
      return (
        '<div class="mdx-line-edit mdx-li" data-mdx-line-edit data-block-type="task_item" style="padding-left:' +
        (block.indent || 0) * 1.25 +
        'em">' +
        mark +
        gap +
        '<div class="mdx-src-body mdx-edit" data-mdx-edit contenteditable="true" role="textbox" data-placeholder="待办">' +
        bodyHtml +
        '</div></div>'
      );
    }

    if (type === 'quote') {
      mark =
        '<span class="' +
        markClass +
        ' mdx-src-mark--quote" contenteditable="false" data-mdx-mark data-kind="quote">&gt;</span>';
      return (
        '<div class="mdx-line-edit mdx-quote" data-mdx-line-edit data-block-type="quote">' +
        mark +
        gap +
        '<div class="mdx-src-body mdx-edit" data-mdx-edit contenteditable="true" role="textbox" data-placeholder="引用">' +
        bodyHtml +
        '</div></div>'
      );
    }

    if (type === 'callout') {
      // 与读态同构：卡片 + 类型标签 + 标题/正文分区；禁止 > [!NOTE] 等宽 dump
      // 单行文本：读态 title=中文 label、body=全文 → 软编同样（label 只读，正文可编）
      // 多行：首行=可编标题，其余=可编正文
      var kind = (block.callout || 'note').toLowerCase();
      var kindUp = kind.toUpperCase();
      var labelC = calloutLabel(kind);
      var linesC = text.split('\n');
      var modeSingle = linesC.length <= 1;
      var markHtml =
        '<span class="' +
        markClass +
        ' mdx-src-mark--callout" contenteditable="false" data-mdx-mark data-kind="callout" data-callout="' +
        esc(kind) +
        '">[!' +
        esc(kindUp) +
        ']</span>';
      if (modeSingle) {
        return (
          '<div class="mdx-line-edit mdx-callout mdx-callout--' +
          esc(kind) +
          '" data-mdx-line-edit data-block-type="callout" data-callout="' +
          esc(kind) +
          '" data-callout-mode="body-only">' +
          '<div class="mdx-callout__title mdx-callout__title--static">' +
          '<span class="mdx-callout__label">' +
          esc(labelC) +
          '</span> ' +
          markHtml +
          '</div>' +
          '<div class="mdx-callout__body mdx-src-body mdx-edit" data-mdx-edit data-mdx-callout-part="body" contenteditable="true" role="textbox" data-placeholder="提示正文">' +
          (text ? inlineHtml(text).replace(/\n/g, '<br>') : '') +
          '</div></div>'
        );
      }
      var titleC = linesC[0] || '';
      var bodyC = linesC.slice(1).join('\n');
      return (
        '<div class="mdx-line-edit mdx-callout mdx-callout--' +
        esc(kind) +
        '" data-mdx-line-edit data-block-type="callout" data-callout="' +
        esc(kind) +
        '" data-callout-mode="title-body">' +
        '<div class="mdx-callout__kind">' +
        markHtml +
        '</div>' +
        '<div class="mdx-callout__title mdx-src-body mdx-edit" data-mdx-edit data-mdx-callout-part="title" contenteditable="true" role="textbox" data-placeholder="标题">' +
        (titleC ? inlineHtml(titleC) : '') +
        '</div>' +
        '<div class="mdx-callout__body mdx-src-body mdx-edit" data-mdx-edit data-mdx-callout-part="body" contenteditable="true" role="textbox" data-placeholder="正文">' +
        (bodyC ? inlineHtml(bodyC).replace(/\n/g, '<br>') : '') +
        '</div></div>'
      );
    }

    // paragraph / default：纯正文；前缀在输入中识别
    return (
      '<div class="mdx-line-edit mdx-p" data-mdx-line-edit data-block-type="paragraph">' +
      '<div class="mdx-src-body mdx-edit" data-mdx-edit contenteditable="true" role="textbox" data-placeholder="输入，或 / 插入块">' +
      bodyHtml +
      '</div></div>'
    );
  }

  /**
   * 软编辑表面（默认主路径）：预览质感 + 结构灰标可见
   * - 标题保持 h 字号；列表 soft ·；callout 保持卡片
   * - 正文 inline 渲染（粗体即粗体），非等宽整行 dump
   * - 与 readContentHtml 视觉对齐，减少进出跳变
   */
  function renderSoftEditSurface(block, opts) {
    opts = opts || {};
    opts.softListMark = opts.softListMark !== false;
    return renderEditSurface(block, opts);
  }

  /**
   * 代码块编辑：干净 monospaced 源码（完整 fence），无语言输入条
   * 与读态同用 .mdx-code-card 单表面（W2 / F-CODE-SRC）
   */
  function renderCodeSourceSurface(block) {
    var src = toSourceLine(block);
    return (
      '<div class="mdx-code-card is-source" data-mdx-code-card data-mode="source" data-mdx-code-source-wrap>' +
      '<pre class="mdx-code-source-pre mdx-code-card__pre" data-mdx-edit data-mdx-code-source contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true">' +
      esc(src) +
      '</pre></div>'
    );
  }

  /**
   * 文本类块
   */
  function isTextLikeType(type) {
    return (
      type === 'paragraph' ||
      type === 'heading' ||
      type === 'bullet_item' ||
      type === 'ordered_item' ||
      type === 'task_item' ||
      type === 'quote' ||
      type === 'callout'
    );
  }

  /**
   * 完整行源码（仅调试 / 显式 opts.fullSourceEdit）
   * 默认编辑路径请用 renderSoftEditSurface，避免预览↔等宽跳变。
   */
  function renderFullSourceSurface(block) {
    var src = toSourceLine(block);
    var type = (block && block.type) || 'paragraph';
    var typeClass = 'mdx-full-src--' + type;
    if (type === 'heading') {
      typeClass += ' mdx-full-src--h' + Math.max(1, Math.min(6, (block && block.level) || 1));
    }
    return (
      '<div class="mdx-line-edit mdx-full-src-wrap" data-mdx-line-edit data-mdx-full-src data-block-type="' +
      esc(type) +
      '">' +
      '<div class="mdx-full-src mdx-edit ' +
      typeClass +
      '" data-mdx-edit data-mdx-full-src-edit contenteditable="true" role="textbox" aria-multiline="true" spellcheck="true">' +
      esc(src).replace(/\n/g, '<br>') +
      '</div></div>'
    );
  }

  /** 完整源码表面 → 纯文本（MD 真相，不用 htmlToInlineMd） */
  function plainTextFromFullSource(editEl) {
    if (!editEl) return '';
    var raw = (editEl.innerText != null ? editEl.innerText : editEl.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n/g, '\n');
    // contenteditable 末尾常带多余换行
    return raw.replace(/\n$/, '');
  }

  function isFullSourceEditEl(editEl) {
    if (!editEl || !editEl.getAttribute) return false;
    if (editEl.getAttribute('data-mdx-full-src-edit') != null) return true;
    if (editEl.closest && editEl.closest('[data-mdx-full-src]')) return true;
    return false;
  }

  /** 从完整源码表面读回 patch（parseSourceLine） */
  function readFromFullSource(editEl) {
    if (!editEl) return null;
    return parseSourceLine(plainTextFromFullSource(editEl));
  }

  /**
   * 结构前缀在源码串中的长度（用于 caret 拆分 body）
   * 例：`## Hello` → 3（`## `）；`* item` → 2
   */
  function structuralPrefixLength(raw, parsed) {
    raw = String(raw == null ? '' : raw).replace(/\r\n/g, '\n');
    parsed = parsed || parseSourceLine(raw);
    if (!parsed) return 0;
    var first = raw.split('\n')[0] || '';
    var body = parsed.text != null ? String(parsed.text) : '';

    if (parsed.type === 'heading') {
      var hm = first.match(/^(#{1,6})(\s*)/);
      if (!hm) return 0;
      // 有空格：hashes+spaces；无空格仅 hashes（#Title）
      return hm[1].length + (hm[2] ? hm[2].length : 0);
    }
    if (parsed.type === 'bullet_item') {
      var bm = first.match(/^(\s*[-*+])(\s*)/);
      return bm ? bm[1].length + (bm[2] ? bm[2].length : 0) : 0;
    }
    if (parsed.type === 'ordered_item') {
      var om = first.match(/^(\s*\d+\.)(\s*)/);
      return om ? om[1].length + (om[2] ? om[2].length : 0) : 0;
    }
    if (parsed.type === 'task_item') {
      var tm = first.match(/^(\s*[-*+]\s+\[[ xX]\])(\s*)/);
      return tm ? tm[1].length + (tm[2] ? tm[2].length : 0) : 0;
    }
    if (parsed.type === 'quote' || parsed.type === 'callout') {
      // 多行 quote：按首行 `> `；拆分时用整段逻辑
      var qm = first.match(/^(>\s?)/);
      return qm ? qm[1].length : 0;
    }
    if (parsed.type === 'divider') {
      return raw.length;
    }
    // paragraph / 其它：无结构前缀
    if (body && raw.endsWith && raw.indexOf(body) === raw.length - body.length) {
      return raw.length - body.length;
    }
    return 0;
  }

  /**
   * 完整行源码在 caret 处拆成两块 patch（Enter 拆块用）
   * - 标题：左保留 heading，右变 paragraph
   * - 列表：右继续同类型列表项
   * - 正文：两端 paragraph
   */
  function splitFullSourceAt(raw, offset, fallbackBlock) {
    raw = String(raw == null ? '' : raw).replace(/\r\n/g, '\n');
    offset = Math.max(0, Math.min(offset | 0, raw.length));
    var beforeRaw = raw.slice(0, offset);
    var afterRaw = raw.slice(offset);

    var leftParsed = beforeRaw.length ? parseSourceLine(beforeRaw) : { type: 'paragraph', text: '' };
    if (!leftParsed) leftParsed = { type: 'paragraph', text: beforeRaw };

    // 左块：规范化字段
    var left = patchFromParsed(leftParsed, fallbackBlock);

    // 右块
    var right;
    var contType = left.type;
    var afterParsed = afterRaw.length ? parseSourceLine(afterRaw) : { type: 'paragraph', text: '' };

    // 若 after 自身带完整结构前缀，尊重解析
    var afterHasOwnStructure =
      afterParsed &&
      afterParsed.type &&
      afterParsed.type !== 'paragraph' &&
      structuralPrefixLength(afterRaw, afterParsed) > 0 &&
      // after 以结构标记开头（非半截正文）
      /^(\s*#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|\s*>\s|\s*```)/.test(afterRaw);

    if (afterHasOwnStructure) {
      right = patchFromParsed(afterParsed, null);
    } else if (contType === 'heading') {
      right = { type: 'paragraph', text: afterRaw };
    } else if (
      contType === 'bullet_item' ||
      contType === 'ordered_item' ||
      contType === 'task_item'
    ) {
      right = {
        type: contType,
        text: afterRaw,
        indent: left.indent || 0,
      };
      if (contType === 'task_item') right.checked = false;
    } else if (contType === 'quote') {
      right = { type: 'quote', text: afterRaw.replace(/^>\s?/, '') };
    } else if (contType === 'callout') {
      right = { type: 'paragraph', text: afterRaw };
    } else {
      right = { type: 'paragraph', text: afterRaw };
    }

    // 空左：保证可编辑
    if (left.text == null) left.text = '';
    if (right.text == null) right.text = '';

    return { before: left, after: right, beforeRaw: beforeRaw, afterRaw: afterRaw };
  }

  function patchFromParsed(parsed, fallback) {
    if (!parsed) {
      return { type: (fallback && fallback.type) || 'paragraph', text: '' };
    }
    var p = {
      type: parsed.type || 'paragraph',
      text: parsed.text != null ? parsed.text : '',
    };
    if (parsed.level != null) p.level = parsed.level;
    if (parsed.indent != null) p.indent = parsed.indent;
    if (parsed.checked != null) p.checked = parsed.checked;
    if (parsed.callout) p.callout = parsed.callout;
    if (parsed.lang != null) p.lang = parsed.lang;
    // 未完成前缀：当作 paragraph 保留 raw
    if (parsed._hashOnly || parsed._markOnly) {
      p.type = 'paragraph';
      // text 可能空；调用方应用 beforeRaw
    }
    return p;
  }

  /**
   * 完整源码态：光标在行首时的 Backspace 决策
   * @returns {{ action: string, patch?: object, bodyText?: string }}
   */
  function fullSourceBackspaceAtStart(raw, block, ctx) {
    ctx = ctx || {};
    raw = String(raw == null ? '' : raw).replace(/\r\n/g, '\n').replace(/\n$/, '');
    var parsed = parseSourceLine(raw);
    var body = parsed && parsed.text != null ? String(parsed.text) : '';
    var bodyEmpty = !body.replace(/\u00a0/g, ' ').trim();

    // 非空正文 + 行首 → 合并到上一块
    if (!bodyEmpty) {
      return { action: 'merge-prev', bodyText: body, patch: { text: body } };
    }

    // 整行空
    if (!raw.replace(/\s/g, '')) {
      if (ctx.soleBlock || (ctx.isFirstBlock && !ctx.hasMore)) {
        return { action: 'noop' };
      }
      if (ctx.isFirstBlock) return { action: 'noop' };
      return { action: 'merge-prev', bodyText: '', patch: { text: '' } };
    }

    // 仅结构前缀（## / ## / * / > 等）
    var type = (parsed && parsed.type) || (block && block.type) || 'paragraph';

    if (type === 'heading') {
      var lv = (parsed && parsed.level) || (block && block.level) || 1;
      // `## ` 带尾空格 → 先去掉空格变成 `##`
      if (/\s+$/.test(raw) && /^#{1,6}\s+$/.test(raw)) {
        var hashesOnly = raw.replace(/\s+$/, '');
        return {
          action: 'apply-raw',
          raw: hashesOnly,
          patch: { type: 'paragraph', text: hashesOnly },
        };
      }
      // `###` / `##` / `#` 无正文
      if (lv > 1) {
        return {
          action: 'demote-heading',
          patch: { type: 'heading', level: lv - 1, text: '' },
        };
      }
      return { action: 'to-paragraph', patch: { type: 'paragraph', text: '' } };
    }

    if (
      type === 'bullet_item' ||
      type === 'ordered_item' ||
      type === 'task_item' ||
      type === 'quote' ||
      type === 'callout'
    ) {
      return { action: 'to-paragraph', patch: { type: 'paragraph', text: '' } };
    }

    // 已是 paragraph 但 raw 非空（例如只剩 `*` 未完成）→ 删一字交给浏览器
    if (raw.length > 0) {
      return { action: 'delete-char' };
    }
    return { action: 'merge-prev', bodyText: '', patch: { text: '' } };
  }

  /** 纯文本 caret 偏移（完整源码 / 简单 CE） */
  function getPlainCaretOffset(editEl) {
    if (!editEl) return 0;
    var sel = window.getSelection && window.getSelection();
    if (!sel || !sel.rangeCount) {
      return plainTextFromFullSource(editEl).length;
    }
    var range = sel.getRangeAt(0);
    if (!editEl.contains(range.startContainer)) {
      return plainTextFromFullSource(editEl).length;
    }
    try {
      var pre = range.cloneRange();
      pre.selectNodeContents(editEl);
      pre.setEnd(range.startContainer, range.startOffset);
      return pre.toString().replace(/\u00a0/g, ' ').length;
    } catch (e) {
      return 0;
    }
  }

  function setPlainCaretOffset(editEl, offset) {
    if (!editEl) return;
    offset = Math.max(0, offset | 0);
    var sel = window.getSelection && window.getSelection();
    if (!sel) return;
    // 遍历文本节点
    var walker = document.createTreeWalker(editEl, NodeFilter.SHOW_TEXT, null);
    var node;
    var acc = 0;
    while ((node = walker.nextNode())) {
      var len = (node.nodeValue || '').length;
      if (acc + len >= offset) {
        var r = document.createRange();
        r.setStart(node, Math.max(0, offset - acc));
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        return;
      }
      acc += len;
    }
    // 末尾
    try {
      var end = document.createRange();
      end.selectNodeContents(editEl);
      end.collapse(false);
      sel.removeAllRanges();
      sel.addRange(end);
    } catch (e2) {
      /* ignore */
    }
  }

  function bodyTextFromEl(body) {
    if (!body) return '';
    var text;
    if (window.MdxUtil && window.MdxUtil.htmlToInlineMd) {
      text = window.MdxUtil.htmlToInlineMd(body);
    } else {
      text = (body.innerText || body.textContent || '').replace(/\u00a0/g, ' ');
    }
    return text.replace(/\n+$/, '');
  }

  /**
   * 从 line-edit / content 表面读回 patch：
   * 正文来自 [data-mdx-edit]，结构来自 [data-mdx-mark]（level / checked / kind）。
   * @param {HTMLElement} contentEl  line-root 或块 content 容器
   */
  function readFromEditSurface(contentEl) {
    if (!contentEl) return null;
    var lineRoot =
      contentEl.getAttribute && contentEl.getAttribute('data-mdx-line-edit') != null
        ? contentEl
        : contentEl.querySelector
          ? contentEl.querySelector('[data-mdx-line-edit]')
          : null;
    if (!lineRoot) {
      // 允许直接传 body：仅正文
      if (contentEl.getAttribute && contentEl.getAttribute('data-mdx-edit') != null) {
        return { type: 'paragraph', text: bodyTextFromEl(contentEl) };
      }
      return null;
    }
    return readFromLineEdit(lineRoot);
  }

  /** 从 line-edit 表面读回 patch（结构 mark + body） */
  function readFromLineEdit(lineRoot) {
    if (!lineRoot) return null;
    var type = lineRoot.getAttribute('data-block-type') || 'paragraph';
    var mark = lineRoot.querySelector('[data-mdx-mark]');
    var gap = lineRoot.querySelector('[data-mdx-gap]');
    var softMark = false;
    if (mark && mark.getAttribute('data-kind') === 'bullet') {
      softMark = (mark.textContent || '').trim() === '·';
    }

    // Callout：body-only / title-body 分区（与读态约定一致）
    if (type === 'callout') {
      var ck =
        (mark && mark.getAttribute('data-callout')) ||
        lineRoot.getAttribute('data-callout') ||
        'note';
      var mode = lineRoot.getAttribute('data-callout-mode') || '';
      var titleEl = lineRoot.querySelector('[data-mdx-callout-part="title"]');
      var bodyEl = lineRoot.querySelector('[data-mdx-callout-part="body"]');
      if (mode === 'body-only' || (bodyEl && !titleEl)) {
        return {
          type: 'callout',
          callout: ck,
          text: bodyTextFromEl(bodyEl || lineRoot.querySelector('[data-mdx-edit]')),
        };
      }
      if (titleEl || bodyEl) {
        var tTitle = bodyTextFromEl(titleEl);
        var tBody = bodyTextFromEl(bodyEl);
        var combined =
          tBody !== '' && tBody != null
            ? tTitle + '\n' + tBody
            : tTitle;
        return { type: 'callout', callout: ck, text: combined };
      }
      // 旧单区 fallback
      return {
        type: 'callout',
        callout: ck,
        text: bodyTextFromEl(lineRoot.querySelector('[data-mdx-edit]')),
      };
    }

    var body = lineRoot.querySelector('[data-mdx-edit]');
    var text = bodyTextFromEl(body);

    if (type === 'heading') {
      var level = mark ? parseInt(mark.getAttribute('data-level') || '1', 10) : 1;
      // 若 gap 被移除且正文空，标记-only
      if (!gap && !text) {
        return {
          type: 'heading',
          level: level,
          text: '',
          _prefixOnly: true,
          _hasGap: false,
        };
      }
      return {
        type: 'heading',
        level: level,
        text: text,
        _hasGap: !!gap,
        _markLoose: !!(mark && mark.classList && mark.classList.contains('is-loose')),
      };
    }
    if (type === 'bullet_item') {
      return {
        type: 'bullet_item',
        text: text,
        _hasGap: !!gap,
        _markSoft: softMark,
        _mark: mark ? mark.getAttribute('data-src') || '*' : '*',
      };
    }
    if (type === 'ordered_item') {
      return { type: 'ordered_item', text: text, _hasGap: !!gap };
    }
    if (type === 'task_item') {
      var mt = mark ? mark.textContent || '' : '';
      var checked = /\[x\]/i.test(mt);
      return { type: 'task_item', text: text, checked: checked, _hasGap: !!gap };
    }
    if (type === 'quote') {
      return { type: 'quote', text: text, _hasGap: !!gap };
    }
    // paragraph：尝试从正文解析行首结构（# * > 1. ---）
    var parsed = parseSourceLine(text);
    return parsed;
  }

  function readFromCodeSource(pre) {
    if (!pre) return null;
    var raw = (pre.innerText || pre.textContent || '').replace(/\u00a0/g, ' ');
    return parseSourceLine(raw);
  }

  /**
   * 将 MdxDemotion.demoteStep 结果应用到编辑表面 DOM（可选，避免整块重渲跳动）
   * @param {HTMLElement} contentEl line-root 或 content
   * @param {{ action: string, patch?: object }} demoteResult
   * @returns {boolean} 是否已就地处理
   */
  function applyDemoteVisual(contentEl, demoteResult) {
    if (!contentEl || !demoteResult) return false;
    var lineRoot =
      contentEl.getAttribute && contentEl.getAttribute('data-mdx-line-edit') != null
        ? contentEl
        : contentEl.querySelector
          ? contentEl.querySelector('[data-mdx-line-edit]')
          : contentEl;
    if (!lineRoot) return false;

    var action = demoteResult.action;
    var mark = lineRoot.querySelector('[data-mdx-mark]');
    var gap = lineRoot.querySelector('[data-mdx-gap]');
    var body = lineRoot.querySelector('[data-mdx-edit]');

    if (action === 'strip-gap') {
      if (gap && gap.parentNode) {
        gap.parentNode.removeChild(gap);
      }
      if (mark && mark.classList) mark.classList.add('is-loose');
      return true;
    }

    if (action === 'demote-heading' && demoteResult.patch) {
      var lv = Math.max(1, Math.min(6, demoteResult.patch.level || 1));
      if (mark) {
        var hashes = '';
        for (var i = 0; i < lv; i++) hashes += '#';
        mark.setAttribute('data-level', String(lv));
        mark.textContent = hashes;
        if (mark.classList) mark.classList.remove('is-loose');
      }
      lineRoot.className = 'mdx-line-edit mdx-h mdx-h' + lv;
      lineRoot.setAttribute('data-block-type', 'heading');
      // 恢复 gap
      if (!lineRoot.querySelector('[data-mdx-gap]') && mark) {
        var g = document.createElement('span');
        g.className = 'mdx-src-gap';
        g.setAttribute('data-mdx-gap', '');
        g.textContent = ' ';
        if (mark.after) mark.after(g);
        else if (mark.parentNode) mark.parentNode.insertBefore(g, mark.nextSibling);
      }
      if (body) body.setAttribute('data-placeholder', '标题');
      return true;
    }

    // to-paragraph / strip-mark：结构剥离，宿主通常会 reconcile；此处尽量就地变段落壳
    if (action === 'to-paragraph' || action === 'strip-mark') {
      if (mark && mark.parentNode) mark.parentNode.removeChild(mark);
      var gap2 = lineRoot.querySelector('[data-mdx-gap]');
      if (gap2 && gap2.parentNode) gap2.parentNode.removeChild(gap2);
      lineRoot.className = 'mdx-line-edit mdx-p';
      lineRoot.setAttribute('data-block-type', 'paragraph');
      if (body) {
        body.setAttribute('data-placeholder', '输入，或 / 插入块');
      }
      return true;
    }

    return false;
  }

  /**
   * Backspace 在正文开头：处理结构降级
   * @returns {{ handled: boolean, patch?: object, convertParagraph?: boolean, deleteBlock?: boolean }}
   */
  function handleBackspaceAtBodyStart(block, lineRoot) {
    var body = lineRoot && lineRoot.querySelector('[data-mdx-edit]');
    if (!body) return { handled: false };
    var text =
      window.MdxUtil && window.MdxUtil.htmlToInlineMd
        ? window.MdxUtil.htmlToInlineMd(body)
        : body.innerText || '';
    text = text.replace(/\u00a0/g, ' ');
    var gap = lineRoot.querySelector('[data-mdx-gap]');
    var mark = lineRoot.querySelector('[data-mdx-mark]');
    var type = block.type;

    // 正文非空且光标在开头：不拦截（删字符）
    // 调用方保证 at start；若正文还有字，返回 not handled
    if (text.length > 0) {
      return { handled: false };
    }

    // 正文已空
    if (gap && gap.parentNode) {
      // 删掉结构空格 → 标记进入「粘连」灰态
      gap.parentNode.removeChild(gap);
      if (mark) mark.classList.add('is-loose');
      return { handled: true, patch: { text: '' } };
    }

    // 无 gap：降级标记
    if (type === 'heading' && mark) {
      var lv = parseInt(mark.getAttribute('data-level') || '1', 10);
      if (lv > 1) {
        lv -= 1;
        var hashes = '';
        for (var i = 0; i < lv; i++) hashes += '#';
        mark.setAttribute('data-level', String(lv));
        mark.textContent = hashes;
        lineRoot.className = 'mdx-line-edit mdx-h mdx-h' + lv;
        // 恢复 gap
        if (!lineRoot.querySelector('[data-mdx-gap]')) {
          var g = document.createElement('span');
          g.className = 'mdx-src-gap';
          g.setAttribute('data-mdx-gap', '');
          g.textContent = ' ';
          mark.after(g);
        }
        mark.classList.remove('is-loose');
        return { handled: true, patch: { type: 'heading', level: lv, text: '' } };
      }
      // 一级 → 段落
      return { handled: true, convertParagraph: true };
    }

    if (type === 'bullet_item' || type === 'ordered_item' || type === 'task_item' || type === 'quote') {
      return { handled: true, convertParagraph: true };
    }

    return { handled: false };
  }

  /**
   * 段落行首即时结构：* + 空格 → 列表等（F-CORE-05 / §2.9）
   * 优先委托 MdxPromote（需完整前缀+空格）；否则本地保守解析。
   */
  function tryPromoteFromParagraph(text) {
    if (window.MdxPromote && typeof window.MdxPromote.tryPromoteFromParagraph === 'function') {
      return window.MdxPromote.tryPromoteFromParagraph(text);
    }
    // 回退：parseSourceLine，但拒绝无空格前缀与 mark-only
    var p = parseSourceLine(text);
    if (!p || p.type === 'paragraph' || p.type === 'code') return null;
    if (p._hashOnly || p._noSpace || p._markOnly) return null;
    if (p.type === 'heading') {
      // 无空格的 #Title 已由 _noSpace 挡；再保险
      var raw = String(text == null ? '' : text).split('\n')[0] || '';
      if (!/^#{1,6}\s+/.test(raw)) return null;
    }
    if (p.type === 'quote') {
      var q0 = String(text == null ? '' : text).split('\n')[0] || '';
      if (!/^>\s/.test(q0)) return null;
    }
    return p;
  }

  /** soft · — 固定槽宽，不改 layout */
  function showBulletMarkSoft(markEl) {
    if (!markEl || markEl.getAttribute('data-kind') !== 'bullet') return;
    markEl.textContent = '·';
    markEl.classList.remove('is-source-visible');
    markEl.classList.remove('is-source');
    markEl.removeAttribute('data-src-visible');
  }

  /** hard * — 点击 / 焦点到标记 slot */
  function showBulletMarkHard(markEl) {
    if (!markEl || markEl.getAttribute('data-kind') !== 'bullet') return;
    var src = markEl.getAttribute('data-src') || '*';
    markEl.textContent = src;
    markEl.classList.add('is-source-visible');
    markEl.setAttribute('data-src-visible', 'true');
  }

  /** 点击列表标记：· → *；再次点击可折回 · */
  function toggleBulletMarkSource(markEl) {
    if (!markEl || markEl.getAttribute('data-kind') !== 'bullet') return;
    var cur = (markEl.textContent || '').trim();
    if (cur === '·' || !markEl.classList.contains('is-source-visible')) {
      showBulletMarkHard(markEl);
    } else {
      showBulletMarkSoft(markEl);
    }
  }

  /**
   * 绑定 bullet mark soft/hard 交互（宿主 enterEdit 调用）
   * - click / focus mark → hard *
   * - body focus → soft ·
   */
  function bindBulletMarkInteraction(lineRootOrContent) {
    if (!lineRootOrContent || !lineRootOrContent.querySelector) return null;
    var markEl = lineRootOrContent.querySelector(
      '[data-mdx-mark][data-kind="bullet"]'
    );
    if (!markEl) return null;
    var body = lineRootOrContent.querySelector
      ? lineRootOrContent.querySelector('[data-mdx-edit]')
      : null;

    function onMarkActivate(ev) {
      if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      showBulletMarkHard(markEl);
      try {
        markEl.focus();
      } catch (e) {
        /* ignore */
      }
    }

    markEl.addEventListener('click', onMarkActivate);
    markEl.addEventListener('focus', function () {
      showBulletMarkHard(markEl);
    });
    markEl.addEventListener('keydown', function (ev) {
      // 空格 / Enter 在标记上 → hard；Backspace 留给宿主 demote
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        showBulletMarkHard(markEl);
      }
    });

    if (body) {
      body.addEventListener('focus', function () {
        showBulletMarkSoft(markEl);
      });
    }

    return markEl;
  }

  window.MdxLineSource = {
    toSourceLine: toSourceLine,
    parseSourceLine: parseSourceLine,
    renderEditSurface: renderEditSurface,
    renderSoftEditSurface: renderSoftEditSurface,
    renderFullSourceSurface: renderFullSourceSurface,
    renderCodeSourceSurface: renderCodeSourceSurface,
    readFromLineEdit: readFromLineEdit,
    readFromFullSource: readFromFullSource,
    plainTextFromFullSource: plainTextFromFullSource,
    isFullSourceEditEl: isFullSourceEditEl,
    structuralPrefixLength: structuralPrefixLength,
    splitFullSourceAt: splitFullSourceAt,
    fullSourceBackspaceAtStart: fullSourceBackspaceAtStart,
    getPlainCaretOffset: getPlainCaretOffset,
    setPlainCaretOffset: setPlainCaretOffset,
    /** 与 readFromLineEdit 等价；接受 content 容器或 line-root */
    readFromEditSurface: readFromEditSurface,
    readFromCodeSource: readFromCodeSource,
    isTextLikeType: isTextLikeType,
    handleBackspaceAtBodyStart: handleBackspaceAtBodyStart,
    tryPromoteFromParagraph: tryPromoteFromParagraph,
    toggleBulletMarkSource: toggleBulletMarkSource,
    showBulletMarkSoft: showBulletMarkSoft,
    showBulletMarkHard: showBulletMarkHard,
    bindBulletMarkInteraction: bindBulletMarkInteraction,
    applyDemoteVisual: applyDemoteVisual,
  };
})();
