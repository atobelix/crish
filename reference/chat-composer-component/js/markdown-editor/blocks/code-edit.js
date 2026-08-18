/**
 * markdown-editor/blocks/code-edit.js — 代码块 focus-source 单表面
 * 导出 window.MdxBlocksCodeEdit
 *
 * W2 / F-CODE-SRC：
 * - mountSource：同一卡片内 contenteditable 完整 fence（含 ```lang）
 * - parseSource：从表面拆回 { text, lang }
 * - destroy：解绑监听
 *
 * 禁止：textarea 双壳、语言 input 第二编辑壳、预览+输入并列
 */
(function () {
  'use strict';

  var STATE_KEY = '_mdxCodeEdit';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 完整围栏源串（虚拟展示，不持久化整串）
   * 与 MdxLineSource.toSourceLine(code) 对齐
   */
  function fenceSource(block) {
    block = block || {};
    var lang = block.lang != null ? String(block.lang) : '';
    var text = block.text != null ? String(block.text) : '';
    var LS = window.MdxLineSource;
    if (LS && typeof LS.toSourceLine === 'function') {
      return LS.toSourceLine({ type: 'code', lang: lang, text: text });
    }
    return '```' + lang + '\n' + text.replace(/\n$/, '') + '\n```';
  }

  /**
   * 源码态 HTML：与读态同用 .mdx-code-card，无 bar / 无 lang input
   * @param {object} block
   * @returns {string}
   */
  function sourceHtml(block) {
    var CodeRead = window.MdxBlocksCode;
    if (CodeRead && typeof CodeRead.sourceHtml === 'function') {
      return CodeRead.sourceHtml(block);
    }
    var src = fenceSource(block);
    return (
      '<div class="mdx-code-card is-source" data-mdx-code-card data-mode="source">' +
      '<pre class="mdx-code-source-pre mdx-code-card__pre" data-mdx-edit data-mdx-code-source ' +
      'contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true">' +
      esc(src) +
      '</pre></div>'
    );
  }

  /**
   * 从可编辑 pre 解析 fence → body + lang
   * @param {HTMLElement} pre
   * @returns {{ text: string, lang: string }}
   */
  function parseSource(pre) {
    if (!pre) return { text: '', lang: '' };

    var LS = window.MdxLineSource;
    if (LS && typeof LS.readFromCodeSource === 'function') {
      var cp = LS.readFromCodeSource(pre);
      if (cp && cp.type === 'code') {
        return { text: cp.text || '', lang: cp.lang || '', _noFence: false };
      }
      // 若 parse 出非 code 或失败，继续本地拆 fence
    }

    var raw = (pre.innerText != null ? pre.innerText : pre.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n/g, '\n');

    // 完整 fence：```lang\nbody\n```
    var m = raw.match(/^```([^\n]*)\n?([\s\S]*?)(?:\n```[ \t]*)?\s*$/);
    if (m) {
      return {
        lang: (m[1] || '').trim(),
        text: (m[2] || '').replace(/\n$/, ''),
        _noFence: false,
      };
    }

    // 首行是 fence 但闭合残缺
    if (raw.indexOf('```') === 0) {
      var nl = raw.indexOf('\n');
      if (nl < 0) {
        return { lang: raw.slice(3).trim(), text: '', _noFence: false };
      }
      var langLine = raw.slice(3, nl).trim();
      var body = raw.slice(nl + 1).replace(/\n```[ \t]*\s*$/, '');
      return { lang: langLine, text: body.replace(/\n$/, ''), _noFence: false };
    }

    // 无围栏：整段当 body；_noFence 提示调用方可保留旧 lang
    return { text: raw.replace(/\n$/, ''), lang: '', _noFence: true };
  }

  function insertPlainText(text) {
    try {
      if (document.queryCommandSupported && document.queryCommandSupported('insertText')) {
        document.execCommand('insertText', false, text);
        return true;
      }
    } catch (e) {
      /* fall through */
    }
    return false;
  }

  /**
   * 挂载源码单表面到 content 容器
   * @param {HTMLElement} contentEl  [data-mdx-content]
   * @param {object} block
   * @param {{ onChange?: function, onKeydown?: function, indent?: string }} [opts]
   * @returns {{ pre: HTMLElement, parse: function }|null}
   */
  function mountSource(contentEl, block, opts) {
    if (!contentEl) return null;
    opts = opts || {};
    destroy(contentEl);

    contentEl.innerHTML = sourceHtml(block);
    var pre =
      contentEl.querySelector('[data-mdx-code-source]') ||
      contentEl.querySelector('.mdx-code-source-pre') ||
      contentEl.querySelector('[data-mdx-edit]');
    if (!pre) return null;

    var indent = opts.indent != null ? String(opts.indent) : '  ';
    var composing = false;

    function fireChange() {
      if (composing) return;
      if (typeof opts.onChange !== 'function') return;
      opts.onChange(parseSource(pre), pre);
    }

    function onInput() {
      fireChange();
    }

    function onKeydown(e) {
      // Tab = 缩进，不逃逸焦点
      if (e.key === 'Tab' || e.keyCode === 9) {
        e.preventDefault();
        if (e.shiftKey) {
          // 简易：删行首最多 indent 长度空白（选区折叠时）
          // 完整多行 Shift+Tab 留给后续；此处不炸
          return;
        }
        if (!insertPlainText(indent)) {
          // 降级：拼到末尾（极少）
          pre.textContent = (pre.textContent || '') + indent;
          fireChange();
        } else {
          fireChange();
        }
        return;
      }
      if (typeof opts.onKeydown === 'function') {
        opts.onKeydown(e);
      }
    }

    function onPaste(e) {
      // 纯文本粘贴，不注入 HTML 高亮 span
      if (!e.clipboardData) return;
      var plain = e.clipboardData.getData('text/plain');
      if (plain == null) return;
      e.preventDefault();
      insertPlainText(plain.replace(/\r\n/g, '\n'));
      fireChange();
    }

    function onCompStart() {
      composing = true;
    }
    function onCompEnd() {
      composing = false;
      fireChange();
    }

    pre.addEventListener('input', onInput);
    pre.addEventListener('keydown', onKeydown);
    pre.addEventListener('paste', onPaste);
    pre.addEventListener('compositionstart', onCompStart);
    pre.addEventListener('compositionend', onCompEnd);

    contentEl[STATE_KEY] = {
      pre: pre,
      listeners: [
        ['input', onInput],
        ['keydown', onKeydown],
        ['paste', onPaste],
        ['compositionstart', onCompStart],
        ['compositionend', onCompEnd],
      ],
    };

    return {
      pre: pre,
      parse: function () {
        return parseSource(pre);
      },
    };
  }

  /**
   * 解绑 mountSource 监听（不强制清空 HTML；exitEdit 会覆盖）
   * @param {HTMLElement} contentEl
   */
  function destroy(contentEl) {
    if (!contentEl || !contentEl[STATE_KEY]) return;
    var st = contentEl[STATE_KEY];
    if (st.pre && st.listeners) {
      for (var i = 0; i < st.listeners.length; i++) {
        try {
          st.pre.removeEventListener(st.listeners[i][0], st.listeners[i][1]);
        } catch (err) {
          /* ignore */
        }
      }
    }
    try {
      delete contentEl[STATE_KEY];
    } catch (e2) {
      contentEl[STATE_KEY] = undefined;
    }
  }

  window.MdxBlocksCodeEdit = {
    mountSource: mountSource,
    parseSource: parseSource,
    destroy: destroy,
    fenceSource: fenceSource,
    sourceHtml: sourceHtml,
  };
})();
