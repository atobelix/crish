/**
 * markdown-editor/index.js — public mount API
 *
 * Script load order (W1–W3 + W6 media/structure + W8 AI):
 *   util.js → ui/code-highlight.js
 *   → schema.js → model.js → parse.js → serialize.js → registry.js
 *   → ui/line-source.js → ui/slash-menu.js
 *   → edit/height-lock.js → edit/ime-guard.js → edit/demotion.js → edit/promote.js → edit/motion.js
 *   → blocks/text-read.js → blocks/code-read.js → blocks/code-edit.js
 *   → blocks/mermaid.js → blocks/math.js   // W7；peers 可选
 *   → blocks/image.js → blocks/toc.js → media/drop-paste.js
 *   → edit/clipboard/paste.js → edit/clipboard/copy.js   // U3 clipboard
 *   → table/selection.js → table/merge.js → table/context-menu.js → table/clipboard-tsv.js
 *   → ui/table-chrome.js → ui/code-chrome.js → ui/code-lang-menu.js
 *   → selection/model.js → selection/chrome.js → selection/controller.js
 *   → ai/ports.js → ai/actions.js → ui/command-palette.js
 *   → (optional) ui/selection-toolbar.js  // only if mounting with selectionToolbar:true
 *   → editor.js → index.js
 *   optional peers (demo/host only, not core): katex, mermaid CDN
 *
 * options.ai（薄端口 · 宿主负责 AI · 运行时禁止 mock）:
 *   - 缺省 / false / null / 无 complete → AI 关闭，入口隐藏
 *   - { complete(req) } 或 complete 函数 → 仅转发宿主结果
 *       req = { action, selection, documentMd, signal }
 *       返回 Promise<string> 或 AsyncIterable<string>
 *
 * 宿主接入（Conex 主软件）:
 *   MarkdownEditor.mount(el, {
 *     markdown: md,
 *     ai: { complete: (req) => hostAi.run(req) },
 *   });
 *
 * 演示样本文档可由独立 agent 生成真实 MD 文件；不得写入库内 mock complete。
 * 外部: api.runAi(action) 仅在已注入端口时有效
 */
(function () {
  'use strict';

  function Schema() {
    return window.MdxSchema;
  }

  /**
   * @param {HTMLElement} hostEl
   * @param {{
   *   markdown?: string,
   *   doc?: object,
   *   viewOnly?: boolean,
   *   onChange?: (md: string, doc: object) => void,
   *   onOpenPath?: (path: string, meta?: object) => void,
   *   onOpenDoc?: (title: string) => void,
   *   uploadImage?: (file: File, ctx?: object) => Promise<{url: string}>,
   *   media?: { uploadImage?: function, resolveUrl?: function },
   *   resolveUrl?: (ref: string, kind?: string) => string,
   *   maxUploadBytes?: number,
   *   features?: { media?: boolean, maxUploadBytes?: number },
   *   autosaveMs?: number,
   *   selectionToolbar?: boolean,
   *   ai?: { complete: Function } | Function,
   *   commandPalette?: boolean,
   *   openOnCtrlP?: boolean,
   *   onToggleSource?: () => void
   * }} [options]
   *
   * options.doc 优先于 options.markdown
   * viewOnly=true：查看态（不可编辑、无 slash/DnD、可选中复制；忽略 onChange/autosave）
   * selectionToolbar=true：挂载选区浮动条（默认关闭，F-CORE-08）
   * uploadImage / media.uploadImage：粘贴与拖放图片（W6）；无端口时用 blob URL 预览
   * ai：仅宿主注入 complete 时启用；无端口则 AI 入口隐藏，绝不 mock
   */
  function mount(hostEl, options) {
    if (!hostEl) throw new Error('MdxEditor.mount: hostEl required');
    if (!window.MdxEditor || !window.MdxEditor.createEditor) {
      throw new Error('MdxEditor core missing — check script order');
    }
    options = options || {};
    var editor = window.MdxEditor.createEditor(hostEl, options);

    function getDoc() {
      var raw = editor.getDoc ? editor.getDoc() : editor.model && editor.model.getDoc();
      if (Schema()) return Schema().cloneDoc(raw);
      return raw;
    }

    function setDoc(doc) {
      var next = Schema() ? Schema().migrate(doc) : doc;
      if (editor.setDoc) {
        editor.setDoc(next);
        return;
      }
      // 回退：直接写 model + 若无 re-render 至少数据正确
      if (editor.model && editor.model.setDoc) {
        editor.model.setDoc(next, { silentHistory: true, reason: 'setDoc' });
      }
    }

    return {
      getMarkdown: function () {
        return editor.getMarkdown();
      },
      setMarkdown: function (md) {
        editor.setMarkdown(md);
      },
      getDoc: getDoc,
      setDoc: setDoc,
      flush: function () {
        editor.flush();
      },
      destroy: function () {
        editor.destroy();
      },
      focus: function () {
        editor.focus();
      },
      viewOnly: !!editor.viewOnly,
      el: editor.root,
      aiEnabled: !!editor.aiEnabled,
      runAi: function (action, opts) {
        if (typeof editor.runAi === 'function') return editor.runAi(action, opts);
        return Promise.resolve({ ok: false, error: 'no ai' });
      },
      abortAi: function () {
        if (typeof editor.abortAi === 'function') editor.abortAi();
      },
      openCommandPalette: function (q) {
        if (typeof editor.openCommandPalette === 'function') editor.openCommandPalette(q);
      },
    };
  }

  window.MarkdownEditor = {
    mount: mount,
    parse: function (md) {
      return window.MdxParse.parse(md);
    },
    serialize: function (doc) {
      return window.MdxSerialize.serialize(doc);
    },
  };
})();
