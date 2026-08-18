/**
 * markdown-editor/editor.js — block-per-row render, edit, slash, dnd
 * Prefix: mdx-
 */
(function () {
  'use strict';

  function U() {
    return window.MdxUtil;
  }
  function Model() {
    return window.MdxModel;
  }
  function Parse() {
    return window.MdxParse;
  }
  function Ser() {
    return window.MdxSerialize;
  }
  function Schema() {
    return window.MdxSchema;
  }
  function TableChrome() {
    return window.MdxTableChrome;
  }
  function TableMerge() {
    return window.MdxTableMerge;
  }
  function TableSelection() {
    return window.MdxTableSelection;
  }
  function LineSrc() {
    return window.MdxLineSource;
  }
  function HeightLock() {
    return window.MdxHeightLock;
  }
  function Demotion() {
    return window.MdxDemotion;
  }
  function Promote() {
    return window.MdxPromote;
  }
  function ImeGuardApi() {
    return window.MdxImeGuard;
  }
  function BlocksTextRead() {
    return window.MdxBlocksTextRead;
  }
  function BlocksCode() {
    return window.MdxBlocksCode;
  }
  function BlocksCodeEdit() {
    return window.MdxBlocksCodeEdit;
  }
  function CodeLangMenu() {
    return window.MdxCodeLangMenu;
  }
  function BlocksMermaid() {
    return window.MdxBlocksMermaid;
  }
  function BlocksMath() {
    return window.MdxBlocksMath;
  }
  function BlocksImage() {
    return window.MdxBlocksImage;
  }
  function BlocksToc() {
    return window.MdxBlocksToc;
  }
  function SlashMenu() {
    return window.MdxSlashMenu;
  }
  function MediaDropPaste() {
    return window.MdxMediaDropPaste;
  }
  function AiPorts() {
    return window.MdxAiPorts;
  }
  function AiActions() {
    return window.MdxAiActions;
  }
  function CommandPalette() {
    return window.MdxCommandPalette;
  }
  function SelectionModelApi() {
    return window.MdxSelectionModel;
  }
  function SelectionChromeApi() {
    return window.MdxSelectionChrome;
  }
  function SelectionControllerApi() {
    return window.MdxSelectionController;
  }
  function ClipboardPasteApi() {
    return window.MdxClipboardPaste;
  }

  var CALLOUT_LABEL = {
    note: '注意',
    tip: '提示',
    important: '重要',
    warning: '警告',
    caution: '危险',
  };

  var SLASH_COMMANDS = [
    { id: 'paragraph', title: '正文', aliases: ['text', 'p', '段落'], section: '基础', type: 'paragraph' },
    { id: 'h1', title: '标题 1', aliases: ['h1', 'heading1'], section: '基础', type: 'heading', level: 1 },
    { id: 'h2', title: '标题 2', aliases: ['h2'], section: '基础', type: 'heading', level: 2 },
    { id: 'h3', title: '标题 3', aliases: ['h3'], section: '基础', type: 'heading', level: 3 },
    { id: 'h4', title: '标题 4', aliases: ['h4', 'heading4'], section: '基础', type: 'heading', level: 4 },
    { id: 'h5', title: '标题 5', aliases: ['h5', 'heading5'], section: '基础', type: 'heading', level: 5 },
    { id: 'h6', title: '标题 6', aliases: ['h6', 'heading6'], section: '基础', type: 'heading', level: 6 },
    { id: 'bullet', title: '无序列表', aliases: ['ul', 'list', '列表'], section: '列表', type: 'bullet_item' },
    { id: 'ordered', title: '有序列表', aliases: ['ol', 'numbered'], section: '列表', type: 'ordered_item' },
    { id: 'task', title: '待办', aliases: ['todo', 'task', '任务'], section: '列表', type: 'task_item' },
    { id: 'quote', title: '引用', aliases: ['quote', '引用'], section: '基础', type: 'quote' },
    { id: 'code', title: '代码块', aliases: ['code', '代码'], section: '基础', type: 'code' },
    { id: 'math', title: '公式块', aliases: ['math', 'latex', '公式', 'equation'], section: '高级', type: 'math' },
    { id: 'mermaid', title: 'Mermaid 图', aliases: ['mermaid', 'diagram', '图表', 'flowchart'], section: '高级', type: 'code', lang: 'mermaid' },
    { id: 'table', title: '表格', aliases: ['table', '表'], section: '高级', type: 'table' },
    { id: 'divider', title: '分割线', aliases: ['hr', 'divider', '分割'], section: '基础', type: 'divider' },
    { id: 'callout', title: '高亮提示', aliases: ['callout', 'tip', '提示'], section: '高级', type: 'callout', callout: 'tip' },
    { id: 'image', title: '图片', aliases: ['image', 'img', '图片', '图'], section: '媒体', type: 'image' },
    { id: 'toc', title: '目录', aliases: ['toc', '目录', '大纲'], section: '结构', type: 'toc' },
    { id: 'file', title: '文件引用', aliases: ['file', '文件'], section: '高级', type: 'file_chip' },
  ];
  var SLASH_COMMANDS_FALLBACK = SLASH_COMMANDS;

  function createEditor(hostEl, options) {
    options = options || {};
    var viewOnly = !!options.viewOnly;
    var onChange = viewOnly ? function () {} : options.onChange || function () {};
    var onOpenPath = options.onOpenPath || function () {};
    var onOpenDoc = options.onOpenDoc || function () {};
    var uploadImage =
      options.uploadImage ||
      (options.media && options.media.uploadImage) ||
      null;
    var resolveUrl =
      options.resolveUrl ||
      (options.media && options.media.resolveUrl) ||
      null;
    var maxUploadBytes =
      (options.features && options.features.maxUploadBytes) ||
      options.maxUploadBytes ||
      20 * 1024 * 1024;
    var onToggleSource =
      typeof options.onToggleSource === 'function' ? options.onToggleSource : null;
    var autosaveMs = viewOnly
      ? 0
      : options.autosaveMs != null
        ? options.autosaveMs
        : 400;

    // AI：仅宿主 complete；无端口则关闭，库内不 mock
    var aiNormalized =
      AiPorts() && typeof AiPorts().normalize === 'function'
        ? AiPorts().normalize(options.ai)
        : { enabled: false, complete: null };
    var aiComplete = aiNormalized.complete;
    var aiEnabled = !!aiNormalized.enabled && typeof aiComplete === 'function';

    // options.doc 优先于 markdown（Doc v2 / migrate 由 createModel 处理）
    var initialDoc = null;
    if (options.doc != null) {
      initialDoc = options.doc;
    } else if (options.markdown != null) {
      initialDoc = Parse().parse(options.markdown);
    }
    var model = Model().createModel(initialDoc);

    var root = document.createElement('div');
    root.className = 'mdx-root mdx-editor' + (viewOnly ? ' is-view-only' : '');
    root.setAttribute('data-mdx-root', '1');
    if (viewOnly) root.setAttribute('data-mdx-view-only', '1');
    root.innerHTML =
      '<div class="mdx-dnd-live sr-only" aria-live="assertive"></div>' +
      '<div class="mdx-drop-indicator" hidden></div>' +
      '<div class="mdx-scroller" data-mdx-scroller>' +
      '<div class="mdx-blocks" data-mdx-blocks></div>' +
      '</div>' +
      (viewOnly
        ? ''
        : '<div class="mdx-slash" hidden role="listbox" aria-label="插入命令"></div>');

    hostEl.innerHTML = '';
    hostEl.appendChild(root);

    var blocksEl = root.querySelector('[data-mdx-blocks]');
    var slashEl = root.querySelector('.mdx-slash');
    var dropEl = root.querySelector('.mdx-drop-indicator');
    var liveEl = root.querySelector('.mdx-dnd-live');

    var activeId = null;
    var composing = false;
    var activeImeGuard = null;
    /** callout 等多区 IME：副区 guard 一并销毁 */
    var extraImeGuards = [];
    var saveTimer = null;
    var blockEls = Object.create(null); // id → element
    var slashState = null;
    var slashCloseTimer = null;
    var dnd = null;
    var destroyed = false;
    // 选区浮动条：默认关闭；仅 options.selectionToolbar === true 时挂载
    var selToolbar = null;
    var enableSelToolbar = options.selectionToolbar === true;
    var inputDebounce = null;
    var mediaBinder = null;
    var pasteBinder = null;

    function slashCommandsList() {
      var SM = SlashMenu();
      if (SM && typeof SM.allCommands === 'function') return SM.allCommands();
      return SLASH_COMMANDS_FALLBACK;
    }
    var aiController = null;
    var cmdPalette = null;
    // U1 跨块多选
    var blockSelection = SelectionModelApi()
      ? SelectionModelApi().create()
      : { mode: 'idle', anchorId: null, focusId: null, selectedIds: [] };
    var selectionChrome = null;
    var selectionController = null;

    function getOrderedBlockIds() {
      return model.getBlocks().map(function (b) {
        return b.id;
      });
    }

    function paintBlockSelection(paintOpts) {
      if (!selectionChrome) return;
      root.classList.toggle(
        'is-block-multi',
        !!(blockSelection.selectedIds && blockSelection.selectedIds.length > 1)
      );
      selectionChrome.paint(
        Object.assign({ activeEditId: activeId }, paintOpts || {})
      );
    }

    function deleteBlocksByIds(ids) {
      if (!ids || !ids.length) return;
      if (typeof model.removeBlocks === 'function') {
        model.removeBlocks(ids, { addToHistory: true, reason: 'multi-delete' });
      } else {
        var set = Object.create(null);
        ids.forEach(function (id) {
          set[id] = true;
        });
        var blocks = model.getBlocks();
        var first = true;
        for (var i = blocks.length - 1; i >= 0; i--) {
          if (set[blocks[i].id]) {
            model.removeBlock(blocks[i].id, {
              addToHistory: first,
              reason: 'multi-delete',
            });
            first = false;
          }
        }
        if (!model.getBlocks().length) {
          model.insertBlock(0, { type: 'paragraph', text: '' }, { addToHistory: false, reason: 'ensure' });
        }
      }
      activeId = null;
      reconcile();
      scheduleEmit();
    }

    /**
     * U3：粘贴块序列插入（替换当前空段 / 在光标处拆分后插入）
     * 多块粘贴一步 undo（首 insert/update 入栈，后续 silent）。
     */
    function insertPasteBlocks(blocks, meta) {
      meta = meta || {};
      if (!blocks || !blocks.length) return false;
      // 去掉 createBlock 带来的 id，让 model 重新分配
      var partials = blocks.map(function (b) {
        var p = Object.assign({}, b);
        delete p.id;
        return p;
      });

      var idx;
      var replaceActive = false;
      var splitLeft = null;
      var splitRight = null;
      var elPaste = activeId ? blockEls[activeId] : null;
      var editPaste = elPaste && elPaste.querySelector('[data-mdx-edit]');
      var isFullPaste =
        editPaste &&
        ((LineSrc() && LineSrc().isFullSourceEditEl && LineSrc().isFullSourceEditEl(editPaste)) ||
          editPaste.getAttribute('data-mdx-full-src-edit') != null);

      if (activeId && isFullPaste && LineSrc() && LineSrc().splitFullSourceAt) {
        // 在光标处拆开当前行，再把粘贴块夹在中间
        var rawP =
          LineSrc().plainTextFromFullSource
            ? LineSrc().plainTextFromFullSource(editPaste)
            : textFromEditEl(editPaste);
        var offP =
          LineSrc().getPlainCaretOffset
            ? LineSrc().getPlainCaretOffset(editPaste)
            : rawP.length;
        var curBlock = model.getBlocks()[model.findIndex(activeId)];
        var partsP = LineSrc().splitFullSourceAt(rawP, offP, curBlock);
        splitLeft = partsP.before;
        splitRight = partsP.after;
        idx = model.findIndex(activeId);
        // 当前是否可视为「空段替换」
        if (
          !(rawP || '').trim() &&
          curBlock &&
          curBlock.type === 'paragraph'
        ) {
          replaceActive = true;
          splitLeft = null;
          splitRight = null;
        }
      } else if (activeId) {
        try {
          commitActiveFromDom();
        } catch (e0) {
          /* ignore */
        }
        idx = model.findIndex(activeId);
        var cur = idx >= 0 ? model.getBlocks()[idx] : null;
        if (cur && cur.type === 'paragraph' && !(cur.text || '').trim()) {
          replaceActive = true;
        }
      } else {
        idx = model.getBlocks().length - 1;
      }
      if (idx < 0) idx = 0;

      // 光标拆分插入：left | paste… | right
      if (splitLeft && !replaceActive) {
        model.updateBlock(activeId, splitLeft, { addToHistory: true, reason: 'paste' });
        var baseIdx = model.findIndex(activeId);
        var insertAt = baseIdx + 1;
        for (var pi = 0; pi < partials.length; pi++) {
          model.insertBlock(insertAt + pi, partials[pi], {
            addToHistory: false,
            reason: 'paste',
          });
        }
        // 右半仅非空时插入
        var rightHas =
          splitRight &&
          ((splitRight.text != null && String(splitRight.text).length > 0) ||
            (splitRight.type && splitRight.type !== 'paragraph'));
        if (rightHas && (splitRight.text || '').length + (partials.length ? 1 : 0) >= 0) {
          var rightEmpty =
            !(splitRight.text || '').trim() &&
            (splitRight.type === 'paragraph' || !splitRight.type);
          if (!rightEmpty || partials.length === 0) {
            if (!(splitRight.text || '').trim() && splitRight.type === 'paragraph') {
              // skip pure empty right
            } else {
              model.insertBlock(insertAt + partials.length, splitRight, {
                addToHistory: false,
                reason: 'paste',
              });
            }
          }
        }
        activeId = null;
        reconcile();
        var focusIdx = insertAt + partials.length - 1;
        var focusBlock = model.getBlocks()[focusIdx] || model.getBlocks()[baseIdx];
        if (focusBlock) enterEdit(focusBlock.id);
        scheduleEmit();
        announce('已粘贴 ' + partials.length + ' 块');
        return true;
      }

      // 单块纯文本且当前空段：整块替换
      if (replaceActive && partials.length === 1 && partials[0].type === 'paragraph') {
        model.updateBlock(activeId, partials[0], { addToHistory: true, reason: 'paste' });
        reconcile();
        enterEdit(activeId);
        scheduleEmit();
        announce('已粘贴');
        return true;
      }

      if (replaceActive) {
        // 第一块替换空段，其余插入
        model.updateBlock(activeId, partials[0], { addToHistory: true, reason: 'paste' });
        var baseId = activeId;
        var baseIdx2 = model.findIndex(baseId);
        for (var i = 1; i < partials.length; i++) {
          model.insertBlock(baseIdx2 + i, partials[i], { addToHistory: false, reason: 'paste' });
        }
        activeId = null;
        reconcile();
        var last =
          model.getBlocks()[baseIdx2 + partials.length - 1] ||
          model.getBlocks()[baseIdx2];
        if (last) enterEdit(last.id);
        scheduleEmit();
        announce('已粘贴 ' + partials.length + ' 块');
        return true;
      }

      // 在当前块后插入
      var insertAt2 = idx + 1;
      var firstCreated = null;
      for (var j = 0; j < partials.length; j++) {
        var created = model.insertBlock(insertAt2 + j, partials[j], {
          addToHistory: j === 0,
          reason: 'paste',
        });
        if (j === 0) firstCreated = created;
      }
      activeId = null;
      reconcile();
      var focusBlock2 =
        model.getBlocks()[insertAt2 + partials.length - 1] || firstCreated;
      if (focusBlock2 && focusBlock2.id) enterEdit(focusBlock2.id);
      scheduleEmit();
      announce('已粘贴 ' + partials.length + ' 块');
      return true;
    }

    /** 在完整源码 / 编辑表面光标处插入纯文本 */
    function insertPlainAtCaret(text, meta) {
      if (text == null) return false;
      text = String(text);
      if (!activeId) return false;
      var el = blockEls[activeId];
      var edit = el && el.querySelector('[data-mdx-edit]');
      if (!edit) return false;

      var isFull =
        LineSrc() && LineSrc().isFullSourceEditEl
          ? LineSrc().isFullSourceEditEl(edit)
          : edit.getAttribute('data-mdx-full-src-edit') != null;

      if (isFull || edit.getAttribute('contenteditable') === 'true') {
        // 优先 execCommand 以支持浏览器原生 undo 局部；失败则手写
        var ok = false;
        try {
          ok = document.execCommand('insertText', false, text);
        } catch (eIns) {
          ok = false;
        }
        if (!ok) {
          var raw =
            LineSrc() && LineSrc().plainTextFromFullSource
              ? LineSrc().plainTextFromFullSource(edit)
              : textFromEditEl(edit);
          var off =
            LineSrc() && LineSrc().getPlainCaretOffset
              ? LineSrc().getPlainCaretOffset(edit)
              : raw.length;
          var next = raw.slice(0, off) + text + raw.slice(off);
          if (isFull) {
            edit.innerHTML = U().esc(next).replace(/\n/g, '<br>');
            if (LineSrc() && LineSrc().setPlainCaretOffset) {
              LineSrc().setPlainCaretOffset(edit, off + text.length);
            }
          } else {
            edit.textContent = next;
          }
        }
        onEditInput();
        return true;
      }
      return false;
    }

    function getScroller() {
      return root.querySelector('[data-mdx-scroller]');
    }

    function lockBlockHeight(el) {
      var HL = HeightLock();
      if (HL && typeof HL.lock === 'function') return HL.lock(el);
      return 0;
    }

    function raiseBlockHeight(el) {
      var HL = HeightLock();
      if (!HL || !el) return 0;
      var h =
        typeof HL.measureHeight === 'function' ? HL.measureHeight(el) : el.offsetHeight || 0;
      if (typeof HL.raise === 'function') return HL.raise(el, h);
      return 0;
    }

    function unlockBlockHeight(el) {
      var HL = HeightLock();
      if (HL && typeof HL.unlock === 'function') HL.unlock(el);
    }

    function destroyImeGuard() {
      if (activeImeGuard && typeof activeImeGuard.destroy === 'function') {
        try {
          activeImeGuard.destroy();
        } catch (e0) {
          /* ignore */
        }
      }
      activeImeGuard = null;
      if (extraImeGuards && extraImeGuards.length) {
        for (var gi = 0; gi < extraImeGuards.length; gi++) {
          try {
            if (extraImeGuards[gi] && typeof extraImeGuards[gi].destroy === 'function') {
              extraImeGuards[gi].destroy();
            }
          } catch (eX) {
            /* ignore */
          }
        }
        extraImeGuards = [];
      }
    }

    function isComposingNow() {
      if (activeImeGuard && typeof activeImeGuard.isComposing === 'function') {
        return !!activeImeGuard.isComposing();
      }
      return !!composing;
    }

    function getMarkdown() {
      return Ser().serialize(model.getDoc());
    }

    /** 从 contenteditable 读回 markdown 行内记号（有 marks 则保留） */
    function textFromEditEl(edit) {
      if (!edit) return '';
      // 完整行源码表面：DOM 即 MD，禁止 htmlToInlineMd（会把 ** 弄乱 / 吞标签）
      var full =
        (LineSrc() && LineSrc().isFullSourceEditEl && LineSrc().isFullSourceEditEl(edit)) ||
        (edit.getAttribute && edit.getAttribute('data-mdx-full-src-edit') != null) ||
        (edit.closest && edit.closest('[data-mdx-full-src]'));
      if (full) {
        if (LineSrc() && LineSrc().plainTextFromFullSource) {
          return LineSrc().plainTextFromFullSource(edit);
        }
        return U().textFromEditable(edit).replace(/\n$/, '');
      }
      if (U().htmlToInlineMd) return U().htmlToInlineMd(edit);
      return U().textFromEditable(edit);
    }

    function scheduleEmit() {
      if (viewOnly) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        saveTimer = null;
        if (!destroyed) onChange(getMarkdown(), model.getDoc());
      }, autosaveMs);
    }

    function flush() {
      if (viewOnly) return;
      clearTimeout(saveTimer);
      saveTimer = null;
      onChange(getMarkdown(), model.getDoc());
    }

    function announce(msg) {
      if (liveEl) liveEl.textContent = msg || '';
    }

    /** 标题锚点：挂 id + data-block-id，供 TOC 滚动 */
    function withHeadingAnchor(block, html) {
      if (!block || !html) return html;
      var TocMod = BlocksToc();
      var used = Object.create(null);
      // 与文档内其它标题一致的冲突消解：按出现顺序重算
      var blocks = model.getBlocks();
      var anchor = '';
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        if (!b || b.type !== 'heading') continue;
        var plain = String(b.text || '').replace(/\*\*|__|`/g, '');
        var a =
          TocMod && TocMod.slugifyHeading
            ? TocMod.slugifyHeading(plain, used)
            : 'h-' + (b.id || i);
        if (b.id === block.id) {
          anchor = a;
          break;
        }
      }
      if (!anchor) {
        anchor =
          TocMod && TocMod.slugifyHeading
            ? TocMod.slugifyHeading(String(block.text || ''), used)
            : 'h-' + (block.id || 'x');
      }
      // 在第一个标题标签上注入 id
      return String(html).replace(
        /<(h[1-6])(\s|>)/i,
        '<' +
          '$1' +
          ' id="' +
          U().esc(anchor) +
          '" data-mdx-heading-id="' +
          U().esc(block.id) +
          '"$2'
      );
    }

    function scrollToHeadingBlock(blockId) {
      if (!blockId) return;
      var el = blockEls[blockId];
      if (!el) {
        el = blocksEl.querySelector('[data-block-id="' + blockId + '"]');
      }
      if (!el) return;
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (eScr) {
        el.scrollIntoView(true);
      }
      // 短暂高亮
      el.classList.add('mdx-block--toc-target');
      setTimeout(function () {
        el.classList.remove('mdx-block--toc-target');
      }, 1200);
    }

    function insertImageBlocks(imageBlocks, meta) {
      if (!imageBlocks || !imageBlocks.length) return;
      meta = meta || {};
      var idx;
      if (activeId) {
        try {
          commitActiveFromDom();
        } catch (e0) {
          /* ignore */
        }
        idx = model.findIndex(activeId);
      } else {
        idx = model.getBlocks().length - 1;
      }
      if (idx < 0) idx = 0;
      var lastId = null;
      for (var i = 0; i < imageBlocks.length; i++) {
        var created = model.insertBlock(idx + 1 + i, imageBlocks[i], {
          addToHistory: i === 0,
          reason: meta.source === 'drop' ? 'drop-image' : 'paste-image',
        });
        if (created) lastId = created.id;
      }
      // 若当前是空段落且被用作 slash 触发，可保留；不自动删
      reconcile();
      if (lastId) {
        // 图片读态即可，不强制进编辑
        activeId = null;
        scheduleEmit();
        announce('已插入图片');
      }
    }

    /* ---------- render ---------- */

    function orderedIndexFor(blockId) {
      var blocks = model.getBlocks();
      var n = 0;
      for (var i = 0; i < blocks.length; i++) {
        if (blocks[i].type === 'ordered_item') {
          n += 1;
          if (blocks[i].id === blockId) return n;
        } else if (blocks[i].type !== 'bullet_item' && blocks[i].type !== 'task_item') {
          // reset on non-list
          if (blocks[i].id === blockId) return 1;
          n = 0;
        }
      }
      return Math.max(1, n);
    }

    function markerHtml(block) {
      if (block.type === 'bullet_item') return '<span class="mdx-list-mark" aria-hidden="true">•</span>';
      if (block.type === 'ordered_item') {
        return (
          '<span class="mdx-list-mark" aria-hidden="true">' +
          orderedIndexFor(block.id) +
          '.</span>'
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

    function readContentHtml(block) {
      // Prefer extracted block modules when present (F-CORE-10 / no-god-file)
      // Mermaid：type=mermaid 或 code+lang=mermaid
      var Mmd = BlocksMermaid();
      if (Mmd && typeof Mmd.isMermaidBlock === 'function' && Mmd.isMermaidBlock(block)) {
        if (typeof Mmd.readHtml === 'function') return Mmd.readHtml(block);
      }

      if (block.type === 'math') {
        var MathModR = BlocksMath();
        if (MathModR && typeof MathModR.readHtml === 'function') {
          return MathModR.readHtml(block);
        }
        return (
          '<div class="mdx-math" data-mdx-math data-mode="read"><code class="mdx-math-fallback mdx-math-fallback--display">' +
          U().esc(block.text || '') +
          '</code></div>'
        );
      }

      if (block.type === 'code') {
        var CodeMod = BlocksCode();
        if (CodeMod && typeof CodeMod.readHtml === 'function') {
          return CodeMod.readHtml(block);
        }
        return renderCodeReadHtml(block);
      }

      if (block.type === 'image') {
        var ImgMod = BlocksImage();
        if (ImgMod && typeof ImgMod.readHtml === 'function') {
          return ImgMod.readHtml(block, { resolveUrl: resolveUrl });
        }
        var isrc = block.src || '';
        var ialt = block.alt || block.text || '';
        return (
          '<figure class="mdx-img mdx-image"><div class="mdx-image__frame">' +
          (isrc
            ? '<img class="mdx-image__img" src="' + U().esc(isrc) + '" alt="' + U().esc(ialt) + '"/>'
            : '<div class="mdx-image__placeholder">添加图片</div>') +
          '</div></figure>'
        );
      }

      if (block.type === 'toc') {
        var TocMod = BlocksToc();
        if (TocMod && typeof TocMod.readHtml === 'function') {
          return TocMod.readHtml(block, { blocks: model.getBlocks() });
        }
        return '<nav class="mdx-toc" aria-label="目录"><div class="mdx-toc__title">目录</div></nav>';
      }

      var TextMod = BlocksTextRead();
      if (TextMod && typeof TextMod.readContentHtml === 'function') {
        var fromMod = TextMod.readContentHtml(block, {
          esc: U().esc,
          inlineHtml: U().inlineHtml,
          orderedIndexFor: orderedIndexFor,
          viewOnly: viewOnly,
        });
        if (fromMod != null) {
          // heading: 挂稳定锚点 id，供 TOC 滚动
          if (block.type === 'heading') {
            return withHeadingAnchor(block, fromMod);
          }
          return fromMod;
        }
      }

      var t = block.text || '';
      switch (block.type) {
        case 'heading': {
          var lv = Math.max(1, Math.min(6, block.level || 1));
          var tag = 'h' + lv;
          return withHeadingAnchor(
            block,
            '<' +
              tag +
              ' class="mdx-h mdx-h' +
              lv +
              '">' +
              U().inlineHtml(t) +
              '</' +
              tag +
              '>'
          );
        }
        case 'quote':
          return '<blockquote class="mdx-quote">' + U().inlineHtml(t).replace(/\n/g, '<br>') + '</blockquote>';
        case 'divider':
          return '<hr class="mdx-hr"/>';
        case 'callout': {
          var kind = block.callout || 'tip';
          var label = CALLOUT_LABEL[kind] || kind;
          var lines = t.split('\n');
          var title;
          var body;
          if (lines.length <= 1) {
            title = label;
            body = lines[0] || '';
          } else {
            title = lines[0] || label;
            body = lines.slice(1).join('\n');
          }
          // 与 text-read 一致：标题统一 inlineHtml（含默认 label 路径）
          return (
            '<div class="mdx-callout mdx-callout--' +
            U().esc(kind) +
            '"><div class="mdx-callout__title">' +
            U().inlineHtml(title || label) +
            '</div><div class="mdx-callout__body">' +
            (body ? U().inlineHtml(body).replace(/\n/g, '<br>') : '') +
            '</div></div>'
          );
        }
        case 'table':
          return renderTableHtml(block, false);
        case 'file_chip': {
          var path = block.path || t;
          var lab = t || path;
          return (
            '<button type="button" class="mdx-file-chip mdx-file-chip--block" data-mdx-file="' +
            U().esc(path) +
            '">' +
            U().esc(lab) +
            '</button>'
          );
        }
        case 'bullet_item':
        case 'ordered_item':
        case 'task_item':
          return (
            '<div class="mdx-li-row">' +
            markerHtml(block) +
            '<div class="mdx-li-text">' +
            (t
              ? U().inlineHtml(t)
              : viewOnly
                ? ''
                : '<span class="mdx-ph">列表项</span>') +
            '</div></div>'
          );
        case 'paragraph':
        default:
          if (!t) {
            return viewOnly
              ? '<p class="mdx-p"></p>'
              : '<p class="mdx-p mdx-p--empty"><span class="mdx-ph">输入，或 / 插入块</span></p>';
          }
          return '<p class="mdx-p">' + U().inlineHtml(t).replace(/\n/g, '<br>') + '</p>';
      }
    }

    function tableRowsOf(block) {
      if (!block) return [['', '']];
      if (block.rows && block.rows.length) return block.rows;
      if (block.cells && Schema() && Schema().cellsToRows) {
        return Schema().cellsToRows(block.cells);
      }
      return [['', '']];
    }

    // 会话态：代码折叠展开（不进 model / MD；id → true）
    var codeFoldExpanded = Object.create(null);

    /** 代码读态：单卡片高亮（无双壳）— 优先 MdxBlocksCode */
    function renderCodeReadHtml(block) {
      var CodeMod = BlocksCode();
      var foldOpts = {
        expanded: !!(block && block.id && codeFoldExpanded[block.id]),
      };
      if (CodeMod && typeof CodeMod.readHtml === 'function') {
        return CodeMod.readHtml(block, foldOpts);
      }
      var lang = (block.lang || '').trim();
      var raw = block.text || '';
      var body;
      if (U().highlightCode) {
        body = U().highlightCode(raw, lang);
      } else {
        body = U().esc(raw);
      }
      return (
        '<div class="mdx-code-card" data-mdx-code-card data-mode="read" data-lang="' +
        U().esc(lang) +
        '">' +
        '<div class="mdx-code-card__bar">' +
        '<button type="button" class="mdx-code-card__lang" data-mdx-code-lang aria-haspopup="menu" title="' +
        U().esc(lang || 'text') +
        '">' +
        U().esc(lang || 'text') +
        '</button>' +
        '<button type="button" class="mdx-code-card__copy" data-mdx-code-copy aria-label="复制代码" title="复制">' +
        '复制</button>' +
        '</div>' +
        '<pre class="mdx-pre mdx-code-card__pre" data-lang="' +
        U().esc(lang) +
        '"><code class="mdx-code-card__code language-' +
        U().esc(lang || 'text') +
        '">' +
        body +
        '</code></pre>' +
        '</div>'
      );
    }

    /** 代码源码态：完整 fence 纯文本，同卡单表面（无 textarea / 无 lang input） */
    function renderCodeSourceHtml(block) {
      var CodeEdit = BlocksCodeEdit();
      if (CodeEdit && typeof CodeEdit.sourceHtml === 'function') {
        return CodeEdit.sourceHtml(block);
      }
      var CodeMod = BlocksCode();
      if (CodeMod && typeof CodeMod.sourceHtml === 'function') {
        return CodeMod.sourceHtml(block);
      }
      if (LineSrc() && LineSrc().renderCodeSourceSurface) {
        return LineSrc().renderCodeSourceSurface(block);
      }
      var src =
        '```' +
        (block.lang || '') +
        '\n' +
        (block.text || '') +
        '\n```';
      return (
        '<div class="mdx-code-card is-source" data-mdx-code-card data-mode="source">' +
        '<pre class="mdx-code-source-pre mdx-code-card__pre" data-mdx-edit data-mdx-code-source contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true">' +
        U().esc(src) +
        '</pre></div>'
      );
    }

    /** 读态复制 chrome：仅 body，不进编辑 */
    function bindCodeCardChrome(content, blockOrId) {
      var CodeMod = BlocksCode();
      var getBody;
      if (typeof blockOrId === 'string') {
        var bid = blockOrId;
        getBody = function () {
          var b = model.getBlocks()[model.findIndex(bid)];
          return (b && b.text) || '';
        };
      } else {
        var snap = blockOrId || {};
        getBody = function () {
          return snap.text || '';
        };
      }
      if (CodeMod && typeof CodeMod.bindCopy === 'function') {
        CodeMod.bindCopy(content, getBody);
        return;
      }
      var copyBtn = content.querySelector('[data-mdx-code-copy]');
      if (copyBtn && !copyBtn._mdxCopyBound) {
        copyBtn._mdxCopyBound = true;
        copyBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          var text = getBody();
          if (CodeMod && CodeMod.copyBody) {
            CodeMod.copyBody(text, { button: copyBtn });
          } else if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(function () {});
          }
        });
      }
    }

    function wireCodeReadChrome(content, block) {
      if (!content || !block) return;
      var Mmd = BlocksMermaid();
      if (Mmd && typeof Mmd.isMermaidBlock === 'function' && Mmd.isMermaidBlock(block)) {
        if (typeof Mmd.hydrate === 'function') {
          var mEl = content.querySelector('[data-mdx-mermaid]');
          if (mEl) Mmd.hydrate(mEl);
        }
        return;
      }
      if (block.type !== 'code') return;
      bindCodeCardChrome(content, block.id || block);
    }

    function renderTableHtml(block, editable) {
      var rows = tableRowsOf(block);
      var align = block.align || [];
      var cells = block.cells;
      var html = '<div class="mdx-table-wrap">';
      html += '<table class="mdx-table' + (editable ? ' is-editing' : '') + '"><tbody>';
      for (var r = 0; r < rows.length; r++) {
        html += '<tr class="mdx-table__row">';
        var row = rows[r] || [];
        for (var c = 0; c < row.length; c++) {
          var cellObj = cells && cells[r] && cells[r][c];
          if (cellObj && cellObj.covered) {
            // 被合并覆盖的格不输出 DOM
            continue;
          }
          var isHeader = r === 0 && block.hasHeader !== false;
          var tag = isHeader ? 'th' : 'td';
          var a = (cellObj && cellObj.align) || align[c] || 'left';
          var rs = (cellObj && cellObj.rowspan) || 1;
          var cs = (cellObj && cellObj.colspan) || 1;
          var cls =
            'mdx-td mdx-table__cell' + (isHeader ? ' mdx-table__cell--header' : '');
          if (rs > 1 || cs > 1) cls += ' mdx-table__cell--merged';
          var style = a && a !== 'left' ? ' style="text-align:' + U().esc(a) + '"' : '';
          var alignAttr = ' data-align="' + U().esc(a) + '"';
          var spanAttr =
            (rs > 1 ? ' rowspan="' + rs + '"' : '') +
            (cs > 1 ? ' colspan="' + cs + '"' : '');
          var cellText = row[c] || '';
          // 单元格读态/编态：显示 inline 渲染（编态可再 contenteditable）
          var cellInner = editable
            ? U().esc(cellText)
            : U().inlineHtml(cellText);
          if (editable) {
            html +=
              '<' +
              tag +
              ' class="' +
              cls +
              '" contenteditable="true" data-r="' +
              r +
              '" data-c="' +
              c +
              '"' +
              alignAttr +
              spanAttr +
              style +
              (isHeader ? ' scope="col"' : '') +
              '>' +
              cellInner +
              '</' +
              tag +
              '>';
          } else {
            html +=
              '<' +
              tag +
              ' class="' +
              cls +
              '"' +
              alignAttr +
              spanAttr +
              style +
              (isHeader ? ' scope="col"' : '') +
              '>' +
              U().inlineHtml(row[c] || '') +
              '</' +
              tag +
              '>';
          }
        }
        html += '</tr>';
      }
      html += '</tbody></table></div>';
      return html;
    }

    /**
     * 从当前 DOM 读出表格文本 → 写回 model。
     * 保留既有 cells 的 rowspan/colspan/covered/anchor（只更新可见 anchor 的 text）。
     */
    function readTableFromDom(content, block) {
      var cellsEls = content.querySelectorAll('.mdx-td[contenteditable], .mdx-table__cell[contenteditable]');
      var cells;
      if (block.cells && block.cells.length) {
        cells = Schema() && Schema().createBlock
          ? Schema().createBlock(block).cells
          : JSON.parse(JSON.stringify(block.cells));
      } else if (Schema() && Schema().rowsToCells) {
        cells = Schema().rowsToCells(tableRowsOf(block));
      } else {
        cells = tableRowsOf(block).map(function (row, ri) {
          return (row || []).map(function (t) {
            return { text: t == null ? '' : String(t), header: ri === 0 };
          });
        });
      }
      if (!cells.length) cells = [[{ text: '', header: true }]];
      var cols = cells[0].length || 1;
      cellsEls.forEach(function (cellEl) {
        var r = +cellEl.dataset.r;
        var c = +cellEl.dataset.c;
        if (!cells[r]) {
          cells[r] = [];
          for (var i = 0; i < cols; i++) cells[r][i] = { text: '' };
        }
        if (!cells[r][c]) cells[r][c] = { text: '' };
        // covered 无 DOM；仅更新可见格（含 merge anchor）
        if (cells[r][c].covered) return;
        cells[r][c].text = (cellEl.innerText || '').replace(/\n/g, ' ').trim();
      });
      if (block.hasHeader !== false && cells[0]) {
        for (var ci = 0; ci < cells[0].length; ci++) {
          if (cells[0][ci] && !cells[0][ci].covered) cells[0][ci].header = true;
        }
      }
      var rows =
        Schema() && Schema().cellsToRows
          ? Schema().cellsToRows(cells)
          : cells.map(function (row) {
              return (row || []).map(function (c) {
                return c && c.text != null ? String(c.text) : '';
              });
            });
      return { rows: rows, cells: cells };
    }

    /** 在工作副本上应用表格结构变更，再写回 model（同步 cells + rows + align） */
    function applyTableMutation(id, mutator, opts) {
      opts = opts || {};
      var el = blockEls[id];
      var content = el && el.querySelector('[data-mdx-content]');
      var block = model.getBlocks()[model.findIndex(id)];
      if (!block) return;
      // 先把 DOM 文本合入
      if (content) {
        var snap = readTableFromDom(content, block);
        var patch0 = { rows: snap.rows };
        if (snap.cells) patch0.cells = snap.cells;
        model.updateBlock(id, patch0, { addToHistory: false, reason: 'update' });
        block = model.getBlocks()[model.findIndex(id)];
      }
      var working = Schema() ? Schema().createBlock(block) : JSON.parse(JSON.stringify(block));
      if (Schema()) Schema().ensureTableShape(working);
      mutator(working);
      if (Schema()) {
        Schema().ensureTableShape(working);
      } else if (working.cells && !working.rows) {
        working.rows = working.cells.map(function (row) {
          return row.map(function (c) {
            return c && c.text != null ? String(c.text) : '';
          });
        });
      }
      var colCount =
        (working.cells && working.cells[0] && working.cells[0].length) ||
        (working.rows && working.rows[0] && working.rows[0].length) ||
        1;
      if (!working.align) working.align = (block.align || []).slice();
      ensureAlignLen(working, colCount);
      var patch = {
        cells: working.cells,
        rows: working.rows,
        align: working.align.slice(),
        hasHeader: working.hasHeader,
      };
      model.updateBlock(id, patch, {
        addToHistory: opts.addToHistory !== false,
        reason: 'update',
      });
      if (opts.rerender !== false) {
        enterEdit(id, {
          noFocus: !!opts.noFocus,
          focusCell: opts.focusCell,
        });
      }
    }

    function destroyTableChromeIn(content) {
      if (!content || !TableChrome()) return;
      var wrap = content.querySelector('.mdx-table-wrap');
      if (wrap) TableChrome().destroy(wrap);
    }

    function buildBlockEl(block) {
      var el = document.createElement('div');
      el.className = 'mdx-block';
      el.dataset.blockId = block.id;
      el.dataset.type = block.type;
      el.dataset.indent = String(block.indent || 0);
      // 侧栏 TOC / 锚点：标题 level 暴露给宿主（data-level）
      if (block.type === 'heading' && block.level != null) {
        el.dataset.level = String(block.level);
      }
      if (block.indent) el.style.setProperty('--mdx-block-indent', block.indent);

      if (viewOnly) {
        el.innerHTML =
          '<div class="mdx-block__gutter" aria-hidden="true"></div>' +
          '<div class="mdx-block__content" data-mdx-content></div>';
      } else {
        el.innerHTML =
          '<div class="mdx-block__gutter">' +
          '<button type="button" class="mdx-handle" aria-label="拖动以重排" aria-grabbed="false" tabindex="-1">' +
          '<span class="mdx-handle__dots" aria-hidden="true"></span>' +
          '</button>' +
          '</div>' +
          '<div class="mdx-block__content" data-mdx-content></div>';
      }

      var content = el.querySelector('[data-mdx-content]');
      content.innerHTML = readContentHtml(block);
      wireCodeReadChrome(content, block);

      if (block.type === 'bullet_item' || block.type === 'ordered_item' || block.type === 'task_item') {
        el.style.paddingLeft = 6 + (block.indent || 0) * 18 + 'px';
      }

      return el;
    }

    function fullRender() {
      // 整文档重置：不走块入场动画，避免打开/setMarkdown 时上百块 stagger 闪烁
      var blocks = model.getBlocks();
      blocksEl.innerHTML = '';
      blockEls = Object.create(null);
      if (selectionChrome && selectionChrome.clearPainted) selectionChrome.clearPainted();
      for (var i = 0; i < blocks.length; i++) {
        var el = buildBlockEl(blocks[i]);
        blocksEl.appendChild(el);
        blockEls[blocks[i].id] = el;
        if (blocks[i].id === activeId) {
          el.classList.add('is-active');
        }
      }
      paintBlockSelection();
    }

    function patchBlock(id) {
      var blocks = model.getBlocks();
      var idx = model.findIndex(id);
      if (idx < 0) return;
      var block = blocks[idx];
      var old = blockEls[id];
      var wasActive = activeId === id;
      var el = buildBlockEl(block);
      if (old && old.parentNode) {
        old.parentNode.replaceChild(el, old);
      } else {
        blocksEl.appendChild(el);
      }
      blockEls[id] = el;
      if (wasActive && !composing) {
        // keep active styling; re-enter edit if needed externally
        el.classList.add('is-active');
      }
    }

    function reconcile() {
      var blocks = model.getBlocks();
      var nextIds = {};
      var fragOrder = [];
      // 仅「新 id」入场；refresh / fullRender 不进此列表
      var enteredEls = [];
      var Motion = window.MdxMotion;

      for (var i = 0; i < blocks.length; i++) {
        nextIds[blocks[i].id] = true;
        fragOrder.push(blocks[i].id);
        if (!blockEls[blocks[i].id]) {
          var el = buildBlockEl(blocks[i]);
          blockEls[blocks[i].id] = el;
          enteredEls.push(el);
        } else if (activeId !== blocks[i].id) {
          // refresh non-active from model（不入场）
          var refreshed = buildBlockEl(blocks[i]);
          if (blockEls[blocks[i].id].parentNode) {
            blockEls[blocks[i].id].parentNode.replaceChild(refreshed, blockEls[blocks[i].id]);
          }
          blockEls[blocks[i].id] = refreshed;
        }
      }

      // 收集待删：先从 map 摘掉，避免 reorder 再 append
      var removeList = [];
      Object.keys(blockEls).forEach(function (id) {
        if (!nextIds[id]) {
          removeList.push(blockEls[id]);
          delete blockEls[id];
        }
      });

      function hardRemoveNode(n) {
        if (n && n.parentNode) n.parentNode.removeChild(n);
      }

      // 轻量离场：仅 1–3 块且未 reduce；多块即时卸 DOM
      var useLeave =
        Motion &&
        typeof Motion.runLeave === 'function' &&
        removeList.length >= 1 &&
        removeList.length <= 3 &&
        !Motion.prefersReducedMotion();
      if (useLeave) {
        removeList.forEach(function (n) {
          if (!n) return;
          Motion.runLeave(n).then(function () {
            hardRemoveNode(n);
          });
        });
      } else {
        removeList.forEach(hardRemoveNode);
      }

      // reorder
      for (var j = 0; j < fragOrder.length; j++) {
        var node = blockEls[fragOrder[j]];
        if (node) blocksEl.appendChild(node);
      }

      // 新块入场（DOM 已挂载后播；reduce 时 runEnter 瞬切）
      if (
        enteredEls.length &&
        Motion &&
        typeof Motion.runEnter === 'function'
      ) {
        for (var ei = 0; ei < enteredEls.length; ei++) {
          Motion.runEnter(enteredEls[ei]);
        }
      }

      // active class
      Object.keys(blockEls).forEach(function (id) {
        blockEls[id].classList.toggle('is-active', id === activeId);
      });
      if (selectionChrome && selectionChrome.clearPainted) selectionChrome.clearPainted();
      paintBlockSelection();
    }

    model.onChange(function (_doc, reason) {
      // 整文档替换由 setMarkdown/setDoc 自己 fullRender，避免双重 reconcile + 整表 enter
      if (reason === 'setMarkdown' || reason === 'setDoc') {
        scheduleEmit();
        return;
      }
      // 编辑中的文本更新 / 降级不整表 reconcile，避免行切换跳动
      if (activeId && (reason === 'update' || reason === 'demote')) {
        scheduleEmit();
        return;
      }
      if (activeId && reason === 'promote') {
        // enterEdit 已重建当前块；只刷新其它块
        var scroller = root.querySelector('[data-mdx-scroller]');
        var st = scroller ? scroller.scrollTop : 0;
        reconcile();
        if (scroller) scroller.scrollTop = st;
        scheduleEmit();
        return;
      }
      var sc0 = root.querySelector('[data-mdx-scroller]');
      var st0 = sc0 ? sc0.scrollTop : 0;
      reconcile();
      if (sc0) sc0.scrollTop = st0;
      scheduleEmit();
    });

    /* ---------- edit mode ---------- */

    function exitEdit(commit) {
      if (!activeId) return;
      // F-CORE-09：切块 leave 时强制结束组字（避免半提交状态）；组字中不 demote/promote
      if (isComposingNow()) {
        if (activeImeGuard && typeof activeImeGuard.forceEnd === 'function') {
          try {
            activeImeGuard.forceEnd();
          } catch (eForce) {
            /* ignore */
          }
        }
        composing = false;
      }
      var id = activeId;
      var el = blockEls[id];
      if (el && commit !== false) {
        commitActiveFromDom();
      }
      if (el) {
        destroyTableChromeIn(el.querySelector('[data-mdx-content]'));
      }
      destroyImeGuard();
      composing = false;
      if (window.MdxContextMenu) window.MdxContextMenu.close();
      activeId = null;
      root.classList.remove('is-editing');
      if (model.clearMergeKey) model.clearMergeKey();
      var sc = getScroller();
      var scrollTop = sc ? sc.scrollTop : 0;
      if (el) {
        lockBlockHeight(el);
        el.classList.remove('is-active', 'is-editing');
        var block = model.getBlocks()[model.findIndex(id)];
        if (block) {
          el.dataset.type = block.type;
          el.setAttribute('data-type', block.type);
          var content = el.querySelector('[data-mdx-content]');
          if (content) {
            var CodeEditLeave = BlocksCodeEdit();
            if (CodeEditLeave && typeof CodeEditLeave.destroy === 'function') {
              CodeEditLeave.destroy(content);
            }
            var MathLeave = BlocksMath();
            if (MathLeave && typeof MathLeave.destroy === 'function') {
              MathLeave.destroy(content);
            }
            content.innerHTML = readContentHtml(block);
            wireCodeReadChrome(content, block);
          }
        }
        // 换壳后抬高 min-height，再双 rAF unlock，减少标题/callout 高度跳
        raiseBlockHeight(el);
        if (sc) sc.scrollTop = scrollTop;
        unlockBlockHeight(el);
      }
      // 标题变更后刷新文内 TOC 读态
      refreshTocBlocks();
      closeSlash();
    }

    function refreshTocBlocks() {
      var blocks = model.getBlocks();
      for (var i = 0; i < blocks.length; i++) {
        if (blocks[i].type !== 'toc') continue;
        if (activeId === blocks[i].id) continue;
        var tel = blockEls[blocks[i].id];
        if (!tel) continue;
        var tcontent = tel.querySelector('[data-mdx-content]');
        if (tcontent) tcontent.innerHTML = readContentHtml(blocks[i]);
      }
    }

    function ensureAlignLen(w, cols) {
      if (!w.align) w.align = [];
      while (w.align.length < cols) w.align.push('left');
      if (w.align.length > cols) w.align.length = cols;
    }

    function handleTableContextAction(id, action, meta) {
      if (!meta) return;
      var r = meta.row | 0;
      var c = meta.col | 0;
      var Tsv = window.MdxTableTsv;

      if (action === 'copy-text' || action === 'copy-tsv') {
        var bCopy = model.getBlocks()[model.findIndex(id)];
        var selCopy = meta.selection;
        var multiCopy =
          selCopy && (selCopy.r0 !== selCopy.r1 || selCopy.c0 !== selCopy.c1);
        if (Tsv && bCopy && (action === 'copy-tsv' || multiCopy)) {
          Tsv.copyRange(bCopy, selCopy || { r0: r, c0: c, r1: r, c1: c });
          return;
        }
        var text = '';
        if (meta.cellEl) text = (meta.cellEl.innerText || '').replace(/\n/g, ' ').trim();
        else {
          var rows = tableRowsOf(bCopy);
          text = (rows[r] && rows[r][c]) || '';
        }
        if (Tsv && Tsv.writeClipboard) Tsv.writeClipboard(text);
        else if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).catch(function () {});
        } else {
          try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
          } catch (err) {
            /* ignore */
          }
        }
        return;
      }

      if (action === 'paste') {
        var pasteText = meta.pasteText || '';
        if (!pasteText && Tsv && Tsv.getInternalBuffer) {
          var buf = Tsv.getInternalBuffer();
          if (buf && buf.text) pasteText = buf.text;
        }
        if (!pasteText) {
          if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard.readText().then(function (t) {
              if (!t) return;
              meta.pasteText = t;
              handleTableContextAction(id, 'paste', meta);
            }).catch(function () {});
          }
          return;
        }
        applyTableMutation(
          id,
          function (w) {
            if (Tsv && Tsv.applyTsv) Tsv.applyTsv(w, pasteText, r, c);
            else if (Schema() && Schema().tableSetCell) {
              Schema().tableSetCell(w, r, c, String(pasteText).split('\n')[0]);
            }
            var colsP =
              (w.cells && w.cells[0] && w.cells[0].length) ||
              (w.rows && w.rows[0] && w.rows[0].length) ||
              1;
            ensureAlignLen(w, colsP);
          },
          { focusCell: { r: r, c: c } }
        );
        return;
      }

      applyTableMutation(
        id,
        function (w) {
          var cols = (w.cells && w.cells[0] && w.cells[0].length) || (w.rows && w.rows[0] && w.rows[0].length) || 1;
          ensureAlignLen(w, cols);

          if (action === 'insert-col-left') {
            if (Schema() && Schema().tableAddCol) Schema().tableAddCol(w, c);
            w.align.splice(c, 0, 'left');
          } else if (action === 'insert-col-right') {
            if (Schema() && Schema().tableAddCol) Schema().tableAddCol(w, c + 1);
            w.align.splice(c + 1, 0, 'left');
          } else if (action === 'delete-col') {
            if (Schema() && Schema().tableRemoveCol) Schema().tableRemoveCol(w, c);
            if (w.align && w.align.length > c) w.align.splice(c, 1);
          } else if (action === 'align-left' || action === 'align-center' || action === 'align-right') {
            var a = action === 'align-center' ? 'center' : action === 'align-right' ? 'right' : 'left';
            ensureAlignLen(w, cols);
            // Column align → block.align[c] + cells[*][c].align; re-render via mutation
            w.align[c] = a;
            if (w.cells) {
              for (var ri = 0; ri < w.cells.length; ri++) {
                if (w.cells[ri] && w.cells[ri][c]) w.cells[ri][c].align = a;
              }
            }
          } else if (action === 'insert-row-above') {
            if (Schema() && Schema().tableAddRow) Schema().tableAddRow(w, r);
          } else if (action === 'insert-row-below') {
            if (Schema() && Schema().tableAddRow) Schema().tableAddRow(w, r + 1);
          } else if (action === 'delete-row') {
            if (Schema() && Schema().tableRemoveRow) Schema().tableRemoveRow(w, r);
          } else if (action === 'clear-cell') {
            var csel = meta.selection || { r0: r, c0: c, r1: r, c1: c };
            var cr0 = Math.min(csel.r0, csel.r1);
            var cc0 = Math.min(csel.c0, csel.c1);
            var cr1 = Math.max(csel.r0, csel.r1);
            var cc1 = Math.max(csel.c0, csel.c1);
            for (var crr = cr0; crr <= cr1; crr++) {
              for (var ccc = cc0; ccc <= cc1; ccc++) {
                if (Schema() && Schema().tableSetCell) Schema().tableSetCell(w, crr, ccc, '');
                else if (w.rows && w.rows[crr]) w.rows[crr][ccc] = '';
              }
            }
          } else if (action === 'toggle-header') {
            w.hasHeader = w.hasHeader === false;
          } else if (action === 'merge-cells') {
            var sel = meta.selection || { r0: r, c0: c, r1: r, c1: c };
            var mergeCells =
              meta.cells && meta.cells.length
                ? meta.cells
                : TableSelection() && TableSelection().rangeToCells
                  ? TableSelection().rangeToCells(sel)
                  : null;
            if (!mergeCells) {
              var r0m = Math.min(sel.r0, sel.r1);
              var c0m = Math.min(sel.c0, sel.c1);
              var r1m = Math.max(sel.r0, sel.r1);
              var c1m = Math.max(sel.c0, sel.c1);
              mergeCells = [];
              for (var rr = r0m; rr <= r1m; rr++) {
                for (var cc = c0m; cc <= c1m; cc++) mergeCells.push({ r: rr, c: cc });
              }
            }
            if (TableMerge()) {
              var mres = TableMerge().merge(w, mergeCells);
              if (mres && !mres.ok && typeof console !== 'undefined') {
                console.warn('[mdx table] merge failed:', mres.reasonZh || mres.reason);
              }
            } else if (Schema() && Schema().tableMerge) {
              var r0 = Math.min(sel.r0, sel.r1);
              var c0 = Math.min(sel.c0, sel.c1);
              var r1 = Math.max(sel.r0, sel.r1);
              var c1 = Math.max(sel.c0, sel.c1);
              var mres2 = Schema().tableMerge(w, r0, c0, r1 - r0 + 1, c1 - c0 + 1);
              if (mres2 && !mres2.ok && typeof console !== 'undefined') {
                console.warn('[mdx table] merge failed:', mres2.reason);
              }
            }
          } else if (action === 'split-cell') {
            if (TableMerge()) {
              TableMerge().split(w, r, c);
            } else if (Schema() && Schema().tableSplit) {
              Schema().tableSplit(w, r, c);
            }
          }
        },
        {
          focusCell: {
            r:
              action === 'insert-row-above'
                ? r + 1
                : action === 'merge-cells' && meta.selection
                  ? Math.min(meta.selection.r0, meta.selection.r1)
                  : r,
            c:
              action === 'insert-col-left'
                ? c + 1
                : action === 'delete-col'
                  ? Math.max(0, c - 1)
                  : action === 'merge-cells' && meta.selection
                    ? Math.min(meta.selection.c0, meta.selection.c1)
                    : c,
          },
        }
      );
    }

    function commitActiveFromDom() {
      if (!activeId) return;
      var idx = model.findIndex(activeId);
      if (idx < 0) return;
      var block = model.getBlocks()[idx];
      var el = blockEls[activeId];
      if (!el) return;
      var content = el.querySelector('[data-mdx-content]');
      if (!content) return;

      if (block.type === 'math') {
        var mathPre =
          content.querySelector('[data-mdx-math-source]') ||
          content.querySelector('.mdx-math-source-pre, [data-mdx-edit]');
        var MathEdit = BlocksMath();
        var mathParsed = null;
        if (MathEdit && typeof MathEdit.parseSource === 'function' && mathPre) {
          mathParsed = MathEdit.parseSource(mathPre);
        }
        if (mathParsed) {
          model.updateBlock(
            activeId,
            { type: 'math', text: mathParsed.text || '' },
            { addToHistory: true, reason: 'update' }
          );
        } else if (mathPre) {
          var mraw = (mathPre.innerText || '').replace(/\u00a0/g, ' ');
          var mbody = mraw.replace(/^\$\$\s*\n?/, '').replace(/\n?\$\$\s*$/, '');
          model.updateBlock(
            activeId,
            { type: 'math', text: mbody },
            { addToHistory: true, reason: 'update' }
          );
        }
        return;
      }

      // mermaid type 或 code：统一 fence 提交；mermaid type 可落回 code+lang
      if (block.type === 'code' || block.type === 'mermaid') {
        var pre =
          content.querySelector('[data-mdx-code-source]') ||
          content.querySelector('.mdx-code-source-pre, [data-mdx-edit]');
        var CodeEdit = BlocksCodeEdit();
        var parsed = null;
        if (CodeEdit && typeof CodeEdit.parseSource === 'function' && pre) {
          parsed = CodeEdit.parseSource(pre);
        } else if (pre && LineSrc() && LineSrc().readFromCodeSource) {
          var cp = LineSrc().readFromCodeSource(pre);
          if (cp && cp.type === 'code') {
            parsed = { text: cp.text || '', lang: cp.lang || '' };
          }
        }
        if (parsed) {
          // 有围栏：lang 原样（可空 = plaintext）；无围栏：保留旧 lang
          var nextLang = parsed._noFence
            ? block.lang || (block.type === 'mermaid' ? 'mermaid' : '')
            : parsed.lang != null
              ? parsed.lang
              : block.lang || (block.type === 'mermaid' ? 'mermaid' : '');
          // prefer code+lang=mermaid over type=mermaid
          model.updateBlock(
            activeId,
            {
              type: 'code',
              text: parsed.text || '',
              lang: nextLang,
            },
            { addToHistory: true, reason: 'update' }
          );
          return;
        }
        if (pre) {
          var raw = (pre.innerText || '').replace(/\u00a0/g, ' ');
          var body = raw.replace(/^```[^\n]*\n?/, '').replace(/\n```\s*$/, '');
          var langM = raw.match(/^```([^\n]*)/);
          model.updateBlock(
            activeId,
            {
              type: 'code',
              text: body,
              lang: langM ? (langM[1] || '').trim() : block.lang || (block.type === 'mermaid' ? 'mermaid' : ''),
            },
            { addToHistory: true, reason: 'update' }
          );
        }
        return;
      }
      if (block.type === 'table') {
        commitTable(content, block);
        return;
      }
      if (block.type === 'divider') return;
      if (block.type === 'toc') return; // TOC 不序列化 items；编辑态只读

      if (block.type === 'image') {
        var ImgModC = BlocksImage();
        if (ImgModC && typeof ImgModC.readFromEdit === 'function') {
          var imgPatch = ImgModC.readFromEdit(content);
          if (imgPatch) {
            model.updateBlock(activeId, imgPatch, { addToHistory: true, reason: 'update' });
            return;
          }
        }
        var imgEdit = content.querySelector('[data-mdx-edit]');
        if (imgEdit) {
          var imgRaw = textFromEditEl(imgEdit).trim();
          var parsedImg =
            ImgModC && ImgModC.parseMdLine ? ImgModC.parseMdLine(imgRaw) : null;
          if (parsedImg) {
            model.updateBlock(
              activeId,
              {
                type: 'image',
                src: parsedImg.src || '',
                alt: parsedImg.alt || '',
                text: parsedImg.alt || '',
                title: parsedImg.title || '',
                caption: parsedImg.caption || parsedImg.title || '',
              },
              { addToHistory: true, reason: 'update' }
            );
            return;
          }
          if (!imgRaw) {
            model.updateBlock(
              activeId,
              { type: 'image', src: '', alt: '', text: '' },
              { addToHistory: true, reason: 'update' }
            );
            return;
          }
          model.updateBlock(
            activeId,
            { type: 'paragraph', text: imgRaw },
            { addToHistory: true, reason: 'update' }
          );
        }
        return;
      }

      // 完整行源码表面（优先）：整行 MD → parseSourceLine
      var fullEdit =
        content.querySelector('[data-mdx-full-src-edit]') ||
        content.querySelector('[data-mdx-full-src] [data-mdx-edit]');
      if (fullEdit && LineSrc() && LineSrc().readFromFullSource) {
        var fullPatch = LineSrc().readFromFullSource(fullEdit);
        if (fullPatch) {
          var fup = { text: fullPatch.text != null ? fullPatch.text : '' };
          if (fullPatch.type) fup.type = fullPatch.type;
          if (fullPatch.level != null) fup.level = fullPatch.level;
          if (fullPatch.checked != null) fup.checked = fullPatch.checked;
          if (fullPatch.indent != null) fup.indent = fullPatch.indent;
          if (fullPatch.callout) fup.callout = fullPatch.callout;
          if (fullPatch.lang != null) fup.lang = fullPatch.lang;
          if (fullPatch.type === 'image' && fullPatch.src != null) {
            fup.src = fullPatch.src;
            fup.alt = fullPatch.alt;
            fup.title = fullPatch.title;
            fup.caption = fullPatch.caption;
          }
          if (fullPatch.type === 'divider') {
            fup.type = 'divider';
            fup.text = '';
          }
          // 与打字 mergeKey 合并，避免 leave 再多压一层重复历史
          model.updateBlock(activeId, fup, {
            addToHistory: true,
            mergeKey: 'type:' + activeId,
            reason: 'update',
          });
          return;
        }
      }

      var lineRoot = content.querySelector('[data-mdx-line-edit]');
      if (lineRoot && LineSrc() && LineSrc().readFromLineEdit && !content.querySelector('[data-mdx-full-src]')) {
        var patch = LineSrc().readFromLineEdit(lineRoot);
        if (patch) {
          var up = { text: patch.text != null ? patch.text : '' };
          if (patch.type && patch.type !== block.type) up.type = patch.type;
          if (patch.level != null) up.level = patch.level;
          if (patch.checked != null) up.checked = patch.checked;
          if (patch.indent != null) up.indent = patch.indent;
          if (patch.callout) up.callout = patch.callout;
          if (patch.lang != null) up.lang = patch.lang;
          if (patch.type === 'image' && patch.src != null) {
            up.src = patch.src;
            up.alt = patch.alt;
            up.title = patch.title;
            up.caption = patch.caption;
          }
          model.updateBlock(activeId, up, { addToHistory: true, reason: 'update' });
          return;
        }
      }

      var edit = content.querySelector('[data-mdx-edit]');
      if (!edit) return;
      var text = textFromEditEl(edit);
      model.updateBlock(
        activeId,
        { text: text },
        { addToHistory: true, reason: 'update' }
      );
    }

    function commitTable(content, block) {
      var snap = readTableFromDom(content, block);
      if (!snap.rows || !snap.rows.length) return;
      var patch = { rows: snap.rows };
      if (snap.cells) patch.cells = snap.cells;
      if (block.align) patch.align = block.align.slice();
      if (block.hasHeader != null) patch.hasHeader = block.hasHeader;
      model.updateBlock(activeId, patch, { addToHistory: true, reason: 'update' });
    }

    function enterEdit(id, opts) {
      if (viewOnly) return;
      opts = opts || {};
      if (activeId && activeId !== id) exitEdit(true);
      // same-id rebuild: drop previous IME guard before rebinding
      if (activeId === id) destroyImeGuard();
      var idx = model.findIndex(id);
      if (idx < 0) return;
      var block = model.getBlocks()[idx];
      var el = blockEls[id];
      if (!el) return;

      // 新编辑会话：打断上一次打字 merge，保证本次可独立撤销
      if (model.clearMergeKey) model.clearMergeKey();

      activeId = id;
      root.classList.add('is-editing');
      el.classList.add('is-active', 'is-editing');
      var content = el.querySelector('[data-mdx-content]');
      if (!content) return;

      var sc = getScroller();
      var scrollTop = sc ? sc.scrollTop : 0;
      // F-CORE-03：DOM 替换前锁高度，paint 后双 rAF unlock；保持 scroller.scrollTop
      lockBlockHeight(el);

      function restoreScrollUnlock() {
        // 内容已就位：抬到新高度再 unlock，避免进标题/callout 时先矮后高
        raiseBlockHeight(el);
        if (sc) sc.scrollTop = scrollTop;
        unlockBlockHeight(el);
      }

      if (block.type === 'divider') {
        content.innerHTML = '<hr class="mdx-hr"/><div class="mdx-ph">分割线（Backspace 删除）</div>';
        restoreScrollUnlock();
        return;
      }

      if (block.type === 'math') {
        // W7 单表面：含 $$ 定界源，无预览双壳
        var MathMount = BlocksMath();
        var mathPre = null;
        if (MathMount && typeof MathMount.mountSource === 'function') {
          var mathMounted = MathMount.mountSource(content, block, {
            onChange: function (parsed) {
              if (isComposingNow()) return;
              clearTimeout(inputDebounce);
              inputDebounce = setTimeout(function () {
                if (!activeId || activeId !== id || isComposingNow()) return;
                if (!parsed) return;
                model.updateBlock(
                  id,
                  { type: 'math', text: parsed.text || '' },
                  { addToHistory: false, reason: 'update' }
                );
                scheduleEmit();
              }, 120);
            },
            onKeydown: onEditKeydown,
          });
          mathPre = mathMounted && mathMounted.pre;
        } else {
          content.innerHTML =
            '<div class="mdx-math is-source" data-mdx-math data-mode="source">' +
            '<pre class="mdx-math-source-pre" data-mdx-edit data-mdx-math-source contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true">' +
            U().esc('$$\n' + (block.text || '') + '\n$$') +
            '</pre></div>';
          mathPre = content.querySelector('[data-mdx-math-source]');
          if (mathPre) mathPre.addEventListener('keydown', onEditKeydown);
        }
        if (mathPre && !opts.noFocus) {
          mathPre.focus();
          placeCaretEnd(mathPre);
        }
        restoreScrollUnlock();
        return;
      }

      // code 或 type=mermaid：fence 单表面（mermaid 优先 code+lang）
      if (block.type === 'code' || block.type === 'mermaid') {
        // W2 单表面：同卡完整 fence 源，无 textarea 双壳 / 无 lang input
        var codeBlock =
          block.type === 'mermaid'
            ? { type: 'code', lang: 'mermaid', text: block.text || '', id: block.id }
            : block;
        var CodeEditMount = BlocksCodeEdit();
        var codePre = null;
        if (CodeEditMount && typeof CodeEditMount.mountSource === 'function') {
          var mounted = CodeEditMount.mountSource(content, codeBlock, {
            onChange: function (parsed) {
              if (isComposingNow()) return;
              clearTimeout(inputDebounce);
              inputDebounce = setTimeout(function () {
                if (!activeId || activeId !== id || isComposingNow()) return;
                if (!parsed) return;
                var cur = model.getBlocks()[model.findIndex(id)] || {};
                var lang = parsed._noFence
                  ? cur.lang || (cur.type === 'mermaid' ? 'mermaid' : '')
                  : parsed.lang != null
                    ? parsed.lang
                    : cur.lang || (cur.type === 'mermaid' ? 'mermaid' : '');
                model.updateBlock(
                  id,
                  {
                    type: 'code',
                    text: parsed.text || '',
                    lang: lang,
                  },
                  { addToHistory: false, reason: 'update' }
                );
                scheduleEmit();
              }, 120);
            },
            onKeydown: onEditKeydown,
          });
          codePre = mounted && mounted.pre;
        } else {
          content.innerHTML = renderCodeSourceHtml(codeBlock);
          codePre =
            content.querySelector('[data-mdx-code-source]') ||
            content.querySelector('.mdx-code-source-pre, [data-mdx-edit]');
          if (codePre) {
            codePre.addEventListener('input', function () {
              if (isComposingNow()) return;
              clearTimeout(inputDebounce);
              inputDebounce = setTimeout(function () {
                if (!activeId || activeId !== id || isComposingNow()) return;
                var parsed =
                  CodeEditMount && CodeEditMount.parseSource
                    ? CodeEditMount.parseSource(codePre)
                    : LineSrc() && LineSrc().readFromCodeSource
                      ? LineSrc().readFromCodeSource(codePre)
                      : null;
                if (parsed) {
                  var text = parsed.text != null ? parsed.text : parsed.type === 'code' ? parsed.text : '';
                  var lang = parsed.lang != null ? parsed.lang : '';
                  if (parsed.type === 'code') {
                    text = parsed.text || '';
                    lang = parsed.lang || '';
                  }
                  model.updateBlock(
                    id,
                    { type: 'code', text: text || '', lang: lang || '' },
                    { addToHistory: false, reason: 'update' }
                  );
                }
                scheduleEmit();
              }, 120);
            });
            codePre.addEventListener('keydown', onEditKeydown);
          }
        }
        if (codePre) {
          codePre.addEventListener('compositionstart', function () {
            composing = true;
          });
          codePre.addEventListener('compositionend', function () {
            composing = false;
          });
          if (!opts.noFocus) {
            codePre.focus();
            placeCaretEnd(codePre);
          }
        }
        restoreScrollUnlock();
        return;
      }

      if (block.type === 'table') {
        destroyTableChromeIn(content);
        content.innerHTML = renderTableHtml(block, true);
        content.querySelectorAll('.mdx-td[contenteditable]').forEach(function (cell) {
          cell.setAttribute('data-mdx-tab-bound', '1');
          cell.addEventListener('input', function () {
            // 即时同步 cells + rows，避免 autosave 丢格内容
            var r = +cell.dataset.r;
            var c = +cell.dataset.c;
            var text = (cell.innerText || '').replace(/\n/g, ' ');
            var cur = model.getBlocks()[model.findIndex(id)];
            if (!cur) return;
            if (Schema() && Schema().tableSetCell) {
              var w = Schema().createBlock(cur);
              Schema().tableSetCell(w, r, c, text);
              model.updateBlock(
                id,
                { cells: w.cells, rows: w.rows, align: w.align, hasHeader: w.hasHeader },
                { addToHistory: false, reason: 'update' }
              );
            } else {
              var rows = tableRowsOf(cur).map(function (row) {
                return row.slice();
              });
              if (!rows[r]) rows[r] = [];
              rows[r][c] = text;
              model.updateBlock(id, { rows: rows }, { addToHistory: false, reason: 'update' });
            }
            scheduleEmit();
          });
          cell.addEventListener('keydown', onTableKeydown);
        });
        var wrap = content.querySelector('.mdx-table-wrap');
        if (wrap && TableChrome()) {
          TableChrome().enhance(wrap, {
            getBlock: function () {
              return model.getBlocks()[model.findIndex(id)];
            },
            onAddRow: function () {
              applyTableMutation(id, function (w) {
                if (Schema() && Schema().tableAddRow) Schema().tableAddRow(w);
                else {
                  var cols = (w.rows && w.rows[0] && w.rows[0].length) || 1;
                  var nr = [];
                  for (var i = 0; i < cols; i++) nr.push('');
                  w.rows = (w.rows || []).concat([nr]);
                }
              });
            },
            onAddCol: function () {
              applyTableMutation(id, function (w) {
                if (Schema() && Schema().tableAddCol) Schema().tableAddCol(w);
                else {
                  w.rows = (w.rows || [['']]).map(function (r) {
                    return r.concat(['']);
                  });
                }
                // align 同步扩一列
                var cols = (w.rows && w.rows[0] && w.rows[0].length) || 1;
                if (!w.align) w.align = [];
                while (w.align.length < cols) w.align.push('left');
              });
            },
            onContextAction: function (action, meta) {
              handleTableContextAction(id, action, meta);
            },
          });
        }
        if (!opts.noFocus) {
          var focusEl = null;
          if (opts.focusCell) {
            focusEl = content.querySelector(
              '.mdx-td[data-r="' + opts.focusCell.r + '"][data-c="' + opts.focusCell.c + '"]'
            );
          }
          if (!focusEl) focusEl = content.querySelector('.mdx-td[contenteditable]');
          if (focusEl) focusEl.focus();
        }
        restoreScrollUnlock();
        return;
      }

      if (block.type === 'file_chip') {
        content.innerHTML =
          '<div class="mdx-file-edit">' +
          '<label>路径 <input type="text" class="mdx-input" data-file-path value="' +
          U().esc(block.path || '') +
          '"/></label>' +
          '<label>标签 <input type="text" class="mdx-input" data-file-label value="' +
          U().esc(block.text || '') +
          '"/></label></div>';
        content.querySelectorAll('input').forEach(function (inp) {
          inp.addEventListener('input', function () {
            var path = content.querySelector('[data-file-path]').value.trim();
            var label = content.querySelector('[data-file-label]').value.trim();
            model.updateBlock(
              id,
              { path: path, text: label || path },
              { addToHistory: false, reason: 'update' }
            );
            scheduleEmit();
          });
          inp.addEventListener('keydown', onEditKeydown);
        });
        if (!opts.noFocus) content.querySelector('input').focus();
        restoreScrollUnlock();
        return;
      }

      if (block.type === 'image') {
        var ImgEdit = BlocksImage();
        if (ImgEdit && typeof ImgEdit.editHtml === 'function') {
          content.innerHTML = ImgEdit.editHtml(block);
        } else {
          var srcLine =
            '![' +
            (block.alt || block.text || '') +
            '](' +
            (block.src || '') +
            (block.title || block.caption
              ? ' "' + String(block.title || block.caption).replace(/"/g, '\\"') + '"'
              : '') +
            ')';
          content.innerHTML =
            '<div class="mdx-line-edit mdx-image-edit" data-mdx-line-edit data-block-type="image">' +
            '<div class="mdx-src-body mdx-edit" data-mdx-edit contenteditable="true" spellcheck="false">' +
            U().esc(srcLine) +
            '</div></div>';
        }
        var imgEditEl = content.querySelector('[data-mdx-edit]');
        if (imgEditEl) {
          imgEditEl.addEventListener('keydown', onEditKeydown);
          imgEditEl.addEventListener('input', function () {
            if (isComposingNow()) return;
            clearTimeout(inputDebounce);
            inputDebounce = setTimeout(function () {
              if (!activeId || activeId !== id || isComposingNow()) return;
              scheduleEmit();
            }, 120);
          });
          if (!opts.noFocus) {
            imgEditEl.focus();
            placeCaretEnd(imgEditEl);
          }
        }
        restoreScrollUnlock();
        return;
      }

      if (block.type === 'toc') {
        var TocEdit = BlocksToc();
        if (TocEdit && typeof TocEdit.editHtml === 'function') {
          content.innerHTML = TocEdit.editHtml(block, { blocks: model.getBlocks() });
        } else {
          content.innerHTML = readContentHtml(block);
        }
        // TOC 编辑态只读预览；Backspace 删块走 onEditKeydown 需可聚焦
        var tocFocus = content.querySelector('.mdx-toc-edit') || content;
        tocFocus.setAttribute('tabindex', '0');
        tocFocus.addEventListener('keydown', onEditKeydown);
        if (!opts.noFocus) tocFocus.focus();
        restoreScrollUnlock();
        return;
      }

      // 文本行：软编辑（预览质感 + 灰结构标 ## / · / >）— 默认不再用等宽整行 dump
      // opts.fullSourceEdit === true 时才走完整源码（调试）
      var forceFullSrc = opts.fullSourceEdit === true;
      if (forceFullSrc && LineSrc() && LineSrc().renderFullSourceSurface) {
        content.innerHTML = LineSrc().renderFullSourceSurface(block);
      } else if (LineSrc() && typeof LineSrc().renderSoftEditSurface === 'function') {
        content.innerHTML = LineSrc().renderSoftEditSurface(block, { softListMark: true });
      } else if (LineSrc() && LineSrc().renderEditSurface) {
        content.innerHTML = LineSrc().renderEditSurface(block, { softListMark: true });
      } else {
        content.innerHTML =
          '<div class="mdx-line-edit mdx-p" data-mdx-line-edit data-block-type="paragraph">' +
          '<div class="mdx-src-body mdx-edit" data-mdx-edit contenteditable="true"></div></div>';
        var fallback = content.querySelector('[data-mdx-edit]');
        if (fallback) fallback.textContent = block.text || '';
      }

      // 可能多区可编（callout title+body）；全部接线，主焦优先 body
      var editNodes = content.querySelectorAll('[data-mdx-edit]');
      if (!editNodes || !editNodes.length) {
        restoreScrollUnlock();
        return;
      }
      var edit =
        content.querySelector('[data-mdx-callout-part="body"]') ||
        content.querySelector('[data-mdx-edit]');

      // 完整源码态：禁止 applyLiveMarks；软编辑态：启用 live marks（粗体即粗体）
      var isFullSrc = !!(
        content.querySelector('[data-mdx-full-src]') ||
        edit.getAttribute('data-mdx-full-src-edit') != null
      );

      // 列表 soft/hard ·/*
      if (LineSrc() && LineSrc().bindBulletMarkInteraction) {
        try {
          LineSrc().bindBulletMarkInteraction(content);
        } catch (eBind) {
          /* ignore */
        }
      }

      var Ime = ImeGuardApi();
      for (var ei = 0; ei < editNodes.length; ei++) {
        (function (node) {
          node.addEventListener('keydown', onEditKeydown);
          if (Ime && typeof Ime.attach === 'function') {
            // 主区 activeImeGuard；副区进 extraImeGuards，exit 一并 destroy
            var guard = Ime.attach(node, {
              onSafeInput: function () {
                onEditInput();
              },
              onCompositionStart: function () {
                composing = true;
              },
              onCompositionEnd: function () {
                composing = false;
              },
            });
            if (node === edit) activeImeGuard = guard;
            else extraImeGuards.push(guard);
          } else {
            node.addEventListener('input', onEditInput);
            node.addEventListener('compositionstart', function () {
              composing = true;
            });
            node.addEventListener('compositionend', function () {
              composing = false;
              onEditInput();
            });
          }
          if (!isFullSrc && U().applyLiveMarks && block.type !== 'code') {
            try {
              U().applyLiveMarks(node);
            } catch (eLm0) {
              /* ignore */
            }
          }
        })(editNodes[ei]);
      }
      if (!opts.noFocus) {
        edit.focus();
        placeCaretEnd(edit);
      }
      restoreScrollUnlock();
    }

    /** 当前块内正在输入的 contenteditable（支持 callout 多区） */
    function activeEditEl(blockEl) {
      if (!blockEl) return null;
      var ae = document.activeElement;
      if (
        ae &&
        blockEl.contains(ae) &&
        ae.getAttribute &&
        ae.getAttribute('data-mdx-edit') != null
      ) {
        return ae;
      }
      return (
        blockEl.querySelector('[data-mdx-callout-part="body"]') ||
        blockEl.querySelector('[data-mdx-edit]')
      );
    }

    function placeCaretEnd(el) {
      try {
        var range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) {
        /* ignore */
      }
    }

    function onEditInput() {
      if (isComposingNow() || !activeId) return;
      var el = blockEls[activeId];
      if (!el) return;
      var edit = activeEditEl(el);
      if (!edit) return;

      clearTimeout(inputDebounce);
      inputDebounce = setTimeout(function () {
        if (isComposingNow() || !activeId) return;
        var block = model.getBlocks()[model.findIndex(activeId)];
        if (!block) return;
        edit = activeEditEl(el) || edit;

        var isFullSrcEdit = !!(
          el.querySelector('[data-mdx-full-src]') ||
          edit.getAttribute('data-mdx-full-src-edit') != null
        );

        // 完整源码态：永不折叠 **；仅解析整行类型变化
        // 半表面态：才 applyLiveMarks（仅当前焦点区，避免双区互相冲）
        if (!isFullSrcEdit && U().applyLiveMarks && block.type !== 'code') {
          try {
            U().applyLiveMarks(edit);
          } catch (e2) {
            /* ignore */
          }
        }

        var lineRoot = el.querySelector('[data-mdx-line-edit]');
        var text = textFromEditEl(edit);

        // 完整源码：始终 parse 整行 → 模型只存 body text，** 保留在 text 内
        if (isFullSrcEdit && LineSrc() && LineSrc().parseSourceLine) {
          var liveParsed = LineSrc().parseSourceLine(text);
          if (liveParsed && liveParsed.type !== 'code') {
            var typeHistKey = 'type:' + activeId;
            // 仅前缀（## 或 *）未完成时：先把 raw 写进 paragraph，避免丢字
            if (liveParsed._hashOnly || liveParsed._markOnly) {
              model.updateBlock(
                activeId,
                { type: 'paragraph', text: text },
                { addToHistory: true, mergeKey: typeHistKey, reason: 'update' }
              );
            } else {
              var fpatch = {
                type: liveParsed.type || 'paragraph',
                text: liveParsed.text != null ? liveParsed.text : '',
              };
              if (liveParsed.level != null) fpatch.level = liveParsed.level;
              if (liveParsed.indent != null) fpatch.indent = liveParsed.indent;
              if (liveParsed.checked != null) fpatch.checked = liveParsed.checked;
              if (liveParsed.callout) fpatch.callout = liveParsed.callout;
              model.updateBlock(activeId, fpatch, {
                addToHistory: true,
                mergeKey: typeHistKey,
                reason: 'update',
              });
            }
            // 同步块外壳 data-type（不重渲 DOM，避免丢光标）
            if (el && liveParsed.type && !liveParsed._hashOnly && !liveParsed._markOnly) {
              el.dataset.type = liveParsed.type;
              el.setAttribute('data-type', liveParsed.type);
            }
            scheduleEmit();
            // slash 仅在「像空段触发」时
            if ((liveParsed.type === 'paragraph' || liveParsed._hashOnly) && /^[/、]/.test(text)) {
              maybeOpenSlash(text, edit);
            } else {
              closeSlash();
            }
            return;
          }
        }

        // 段落行首 * / # / > / 1. / - [ ] 结构提升（半表面 / 纯段落）
        if (!isFullSrcEdit && block.type === 'paragraph') {
          var tryPromo =
            (Promote() && Promote().tryPromoteFromParagraph) ||
            (LineSrc() && LineSrc().tryPromoteFromParagraph) ||
            null;
          if (tryPromo) {
            var promo = tryPromo(text);
            if (promo && promo.type && promo.type !== 'paragraph') {
              var sc = getScroller();
              var scrollTop = sc ? sc.scrollTop : 0;
              model.updateBlock(
                activeId,
                {
                  type: promo.type,
                  text: promo.text != null ? promo.text : '',
                  level: promo.level,
                  indent: promo.indent || 0,
                  checked: promo.checked,
                  callout: promo.callout,
                },
                { addToHistory: true, reason: 'promote' }
              );
              // 重建编辑表面但不跳动（bullet 默认 soft ·）
              enterEdit(activeId, { noFocus: false });
              if (sc) sc.scrollTop = scrollTop;
              scheduleEmit();
              return;
            }
          }
        }

        if (lineRoot && LineSrc() && LineSrc().readFromLineEdit) {
          var patch = LineSrc().readFromLineEdit(lineRoot);
          if (patch) {
            var up = { text: patch.text != null ? patch.text : text };
            if (patch.level != null) up.level = patch.level;
            if (patch.checked != null) up.checked = patch.checked;
            model.updateBlock(activeId, up, {
              addToHistory: true,
              mergeKey: 'type:' + activeId,
              reason: 'update',
            });
            scheduleEmit();
            maybeOpenSlash(up.text || '', edit);
            return;
          }
        }

        model.updateBlock(activeId, { text: text }, {
          addToHistory: true,
          mergeKey: 'type:' + activeId,
          reason: 'update',
        });
        scheduleEmit();
        maybeOpenSlash(text, edit);
      }, 80);
    }

    function maybeOpenSlash(text, editEl) {
      // only if single line starts with / or 、
      var line = text.split('\n')[0] || '';
      var m = line.match(/^([/、])(.*)$/);
      if (!m) {
        closeSlash();
        return;
      }
      // only at block that is "empty trigger" style: entire text is trigger+query
      if (text.indexOf('\n') >= 0) {
        closeSlash();
        return;
      }
      openSlash(m[1], m[2] || '', editEl);
    }

    /* ---------- slash ---------- */

    function openSlash(trigger, query, anchorEl) {
      if (viewOnly || !slashEl) return;
      // 取消进行中的关闭延迟，保证可立即重开并播入场
      if (slashCloseTimer) {
        clearTimeout(slashCloseTimer);
        slashCloseTimer = null;
      }
      // 仅「关→开」时播入场；输入过滤时不重启动画
      var wasClosed =
        slashEl.hidden ||
        slashEl.hasAttribute('hidden') ||
        slashEl.classList.contains('is-closing') ||
        !slashEl.classList.contains('is-open');
      slashState = { trigger: trigger, query: query, anchor: anchorEl, index: 0 };
      renderSlash();
      slashEl.classList.remove('is-closing');
      // 用 removeAttribute 对齐 motion.css 的 :not([hidden]) 过渡/入场
      slashEl.removeAttribute('hidden');
      slashEl.hidden = false;
      slashEl.classList.add('is-open');
      if (wasClosed) {
        // 强制 reflow，仅在真正打开时重启 animation
        void slashEl.offsetWidth;
      }
      positionSlash(anchorEl);
    }

    function closeSlash() {
      slashState = null;
      if (!slashEl) return;
      if (slashCloseTimer) {
        clearTimeout(slashCloseTimer);
        slashCloseTimer = null;
      }
      // 已隐藏：只清内容
      if (slashEl.hidden || slashEl.hasAttribute('hidden')) {
        slashEl.classList.remove('is-open', 'is-closing');
        slashEl.innerHTML = '';
        return;
      }
      var Motion = window.MdxMotion;
      // reduce 或无 motion：瞬关
      if (!Motion || Motion.prefersReducedMotion()) {
        slashEl.hidden = true;
        slashEl.setAttribute('hidden', '');
        slashEl.classList.remove('is-open', 'is-closing');
        slashEl.innerHTML = '';
        return;
      }
      // 先 is-closing 播短淡出，再 hidden（避免 display:none 砍断过渡）
      slashEl.classList.remove('is-open');
      slashEl.classList.add('is-closing');
      var ms =
        typeof Motion.motionMs === 'function' ? Motion.motionMs('fast', slashEl) : 120;
      slashCloseTimer = setTimeout(function () {
        slashCloseTimer = null;
        // 关闭期间若已 openSlash，保留新状态
        if (slashState) return;
        slashEl.hidden = true;
        slashEl.setAttribute('hidden', '');
        slashEl.classList.remove('is-open', 'is-closing');
        slashEl.innerHTML = '';
      }, Math.max(0, ms) + 20);
    }

    /** slash 命令表 = SlashMenu/内置块 +（有 AI 端口时）AI 动作 */
    function allSlashCommands() {
      var list = slashCommandsList().slice();
      // 保证 image/toc 在表中（旧缓存或缺模块时）
      var hasImage = false;
      var hasToc = false;
      for (var j = 0; j < list.length; j++) {
        if (list[j].type === 'image' || list[j].id === 'image') hasImage = true;
        if (list[j].type === 'toc' || list[j].id === 'toc') hasToc = true;
      }
      if (!hasImage) {
        list.push({
          id: 'image',
          title: '图片',
          aliases: ['image', 'img', '图片', '图'],
          section: '媒体',
          type: 'image',
        });
      }
      if (!hasToc) {
        list.push({
          id: 'toc',
          title: '目录',
          aliases: ['toc', '目录', '大纲'],
          section: '结构',
          type: 'toc',
        });
      }
      if (aiEnabled && aiController) {
        var acts = aiController.listActions();
        for (var i = 0; i < acts.length; i++) {
          var a = acts[i];
          list.push({
            id: 'ai:' + a.id,
            title: 'AI · ' + a.title,
            aliases: (a.aliases || []).concat(['ai', a.id]),
            section: 'AI',
            aiAction: a.id,
          });
        }
      }
      return list;
    }

    function filterCommands(q) {
      q = (q || '').trim().toLowerCase();
      var all = allSlashCommands();
      if (!q) return all;
      return all.filter(function (cmd) {
        if (cmd.title.toLowerCase().indexOf(q) >= 0) return true;
        return (cmd.aliases || []).some(function (a) {
          return a.toLowerCase().indexOf(q) >= 0;
        });
      });
    }

    /* ---------- AI helpers ---------- */

    function getSelectionTextInEditor() {
      var sel = window.getSelection && window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
      try {
        var range = sel.getRangeAt(0);
        if (!root.contains(range.commonAncestorContainer)) return '';
        return String(sel.toString() || '').replace(/\u00a0/g, ' ');
      } catch (e) {
        return '';
      }
    }

    function insertParagraphBelowActive(text, opts) {
      opts = opts || {};
      if (viewOnly) return null;
      // 尽量落在当前编辑块下方
      var anchorId = activeId;
      if (!anchorId) {
        var blocks0 = model.getBlocks();
        if (blocks0.length) anchorId = blocks0[blocks0.length - 1].id;
      }
      var idx = anchorId != null ? model.findIndex(anchorId) : -1;
      if (idx < 0) idx = model.getBlocks().length - 1;
      if (activeId) {
        try {
          commitActiveFromDom();
        } catch (eC) {
          /* ignore */
        }
      }
      var created = model.insertBlock(
        idx + 1,
        { type: 'paragraph', text: text == null ? '' : String(text) },
        { addToHistory: true, reason: opts.reason || 'ai' }
      );
      reconcile();
      if (created && created.id) {
        enterEdit(created.id);
        return created.id;
      }
      return null;
    }

    function applySlashBlockCommand(cmd) {
      if (!activeId || !cmd || !cmd.type) return;
      var patch = { type: cmd.type, text: '' };
      if (cmd.level) patch.level = cmd.level;
      if (cmd.callout) patch.callout = cmd.callout;
      if (cmd.type === 'task_item') patch.checked = false;
      if (cmd.type === 'code') {
        patch.text = '';
        patch.lang = cmd.lang != null ? cmd.lang : '';
      }
      if (cmd.type === 'math') {
        patch.text = '';
      }
      if (cmd.type === 'mermaid') {
        // prefer code+lang=mermaid
        patch.type = 'code';
        patch.lang = 'mermaid';
        patch.text = 'graph LR\n  A --> B';
      }
      if (cmd.type === 'table') {
        patch.rows = [
          ['列 1', '列 2', '列 3'],
          ['', '', ''],
          ['', '', ''],
        ];
        patch.hasHeader = true;
        patch.align = ['left', 'left', 'left'];
        patch.text = '';
        if (Schema() && Schema().rowsToCells) {
          patch.cells = Schema().rowsToCells(patch.rows);
        }
      }
      if (cmd.type === 'file_chip') {
        patch.path = 'src/example.ts';
        patch.text = 'src/example.ts';
      }
      if (cmd.type === 'callout') {
        patch.text = '提示\n在此填写内容';
      }
      if (cmd.type === 'image') {
        patch.src = '';
        patch.alt = '';
        patch.text = '';
        patch.title = '';
        patch.caption = '';
      }
      if (cmd.type === 'toc') {
        patch.text = '';
        patch.minLevel = 1;
        patch.maxLevel = 6;
      }

      model.updateBlock(activeId, patch, { addToHistory: true, reason: 'slash' });
      closeSlash();
      var id = activeId;
      activeId = null;
      reconcile();
      enterEdit(id);
      announce('已插入' + cmd.title);
    }

    function renderSlash() {
      if (!slashState) return;
      var list = filterCommands(slashState.query);
      slashState.list = list;
      if (slashState.index >= list.length) slashState.index = Math.max(0, list.length - 1);
      if (!list.length) {
        slashEl.innerHTML =
          '<div class="mdx-slash__empty">未找到相关命令<div class="mdx-slash__hint">试试「标题」「表格」「任务」</div></div>';
        return;
      }
      var sections = {};
      list.forEach(function (c) {
        sections[c.section] = sections[c.section] || [];
        sections[c.section].push(c);
      });
      var html = '';
      var flatIndex = 0;
      Object.keys(sections).forEach(function (sec) {
        html += '<div class="mdx-slash__section">' + U().esc(sec) + '</div>';
        sections[sec].forEach(function (cmd) {
          var active = flatIndex === slashState.index;
          html +=
            '<button type="button" role="option" class="mdx-slash__item' +
            (active ? ' is-active' : '') +
            '" data-cmd="' +
            U().esc(cmd.id) +
            '" data-idx="' +
            flatIndex +
            '">' +
            '<span class="mdx-slash__title">' +
            U().esc(cmd.title) +
            '</span></button>';
          flatIndex++;
        });
      });
      slashEl.innerHTML = html;
      slashEl.querySelectorAll('.mdx-slash__item').forEach(function (btn) {
        btn.addEventListener('mousedown', function (e) {
          e.preventDefault();
          runSlashCommand(btn.getAttribute('data-cmd'));
        });
      });
    }

    function positionSlash(anchorEl) {
      if (!anchorEl || !slashEl) return;
      var rect = anchorEl.getBoundingClientRect();
      var rootRect = root.getBoundingClientRect();
      var top = rect.bottom - rootRect.top + 4;
      var left = rect.left - rootRect.left;
      slashEl.style.top = top + 'px';
      slashEl.style.left = Math.max(8, left) + 'px';
    }

    function runSlashCommand(cmdId) {
      if (!activeId || !slashState) return;
      var cmd = null;
      var allCmd = allSlashCommands();
      for (var ci = 0; ci < allCmd.length; ci++) {
        if (allCmd[ci].id === cmdId) {
          cmd = allCmd[ci];
          break;
        }
      }
      if (!cmd) return;

      // AI 动作：清掉 slash 触发符后跑端口
      if (cmd.aiAction) {
        closeSlash();
        var edit = blockEls[activeId] && blockEls[activeId].querySelector('[data-mdx-edit]');
        if (edit && edit.getAttribute && edit.getAttribute('contenteditable')) {
          var t = textFromEditEl(edit);
          // 去掉行首 / 或 、触发
          var cleaned = t.replace(/^[/、][^\n]*$/, '');
          if (cleaned !== t) {
            edit.innerText = cleaned;
            model.updateBlock(activeId, { text: cleaned }, { addToHistory: false });
          }
        }
        if (aiController) {
          aiController.run(cmd.aiAction).catch(function () {});
        }
        return;
      }

      var idx = model.findIndex(activeId);
      if (idx < 0) return;
      applySlashBlockCommand(cmd);
    }

    /* ---------- command palette commands ---------- */

    function buildPaletteCommands() {
      var cmds = [];

      // 插入块
      SLASH_COMMANDS.forEach(function (c) {
        cmds.push({
          id: 'insert:' + c.id,
          title: '插入 · ' + c.title,
          aliases: (c.aliases || []).concat(['insert', c.id]),
          section: '插入',
          run: function () {
            if (viewOnly) {
              announce('只读模式');
              return;
            }
            // 确保有活动块
            if (!activeId) {
              var blocks = model.getBlocks();
              if (blocks[0]) enterEdit(blocks[0].id);
            }
            if (!activeId) return;
            // 空段直接转换；否则下方插入再转换
            var blk = model.getBlocks()[model.findIndex(activeId)];
            var empty = blk && !(blk.text || '').trim() && blk.type === 'paragraph';
            if (!empty) {
              var idx = model.findIndex(activeId);
              var created = model.insertBlock(
                idx + 1,
                { type: 'paragraph', text: '' },
                { addToHistory: true, reason: 'palette-insert' }
              );
              reconcile();
              enterEdit(created.id);
            }
            applySlashBlockCommand(c);
          },
        });
      });

      // AI
      if (aiEnabled && aiController) {
        aiController.listActions().forEach(function (a) {
          cmds.push({
            id: 'ai:' + a.id,
            title: 'AI · ' + a.title,
            aliases: (a.aliases || []).concat(['ai', a.id]),
            section: 'AI',
            hint: a.description || '',
            disabled: viewOnly,
            disabledReason: viewOnly ? '只读' : '',
            run: function () {
              return aiController.run(a.id);
            },
          });
        });
        cmds.push({
          id: 'ai:abort',
          title: 'AI · 取消生成',
          aliases: ['abort', 'cancel', '取消'],
          section: 'AI',
          run: function () {
            if (aiController) aiController.abort();
          },
        });
      }

      // 编辑
      if (!viewOnly) {
        cmds.push({
          id: 'edit:undo',
          title: '撤销',
          aliases: ['undo', '撤销'],
          section: '编辑',
          hint: 'Ctrl+Z',
          run: function () {
            if (activeId) exitEdit(true);
            if (model.undo()) {
              reconcile();
              announce('已撤销');
              scheduleEmit();
            }
          },
        });
        cmds.push({
          id: 'edit:redo',
          title: '重做',
          aliases: ['redo', '重做'],
          section: '编辑',
          hint: 'Ctrl+Y',
          run: function () {
            if (activeId) exitEdit(true);
            if (model.redo()) {
              reconcile();
              announce('已重做');
              scheduleEmit();
            }
          },
        });
      }

      // 视图
      if (onToggleSource) {
        cmds.push({
          id: 'view:source',
          title: '切换源码视图',
          aliases: ['source', '源码', 'markdown'],
          section: '视图',
          hint: 'Ctrl+\\',
          run: function () {
            onToggleSource();
          },
        });
      }

      cmds.push({
        id: 'help:palette',
        title: '关于命令面板',
        aliases: ['help', '帮助', 'command'],
        section: '帮助',
        run: function () {
          announce('Ctrl+P 打开命令面板 · / 插入块 · AI 需宿主注入端口');
        },
      });

      return cmds;
    }

    /* ---------- keydown ---------- */

    function onEditKeydown(e) {
      if (slashState && !slashEl.hidden) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          slashState.index = Math.min((slashState.list || []).length - 1, slashState.index + 1);
          renderSlash();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          slashState.index = Math.max(0, slashState.index - 1);
          renderSlash();
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          var list = slashState.list || [];
          if (list[slashState.index]) runSlashCommand(list[slashState.index].id);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          // remove trigger char
          var edit = e.currentTarget;
          if (edit && edit.getAttribute && edit.getAttribute('contenteditable')) {
            edit.innerText = '';
            model.updateBlock(activeId, { text: '' }, { addToHistory: false });
          }
          closeSlash();
          return;
        }
      }

      // 行内 marks 快捷键（Ctrl/Cmd+B/I/E…）；无 sel-bar 依赖
      // + ux-D2 成对 Backspace/Delete 拆定界符（MdxDelimEdit 薄接线）
      if (
        !viewOnly &&
        !isComposingNow() &&
        !(e.isComposing || e.keyCode === 229)
      ) {
        var editForMark = e.currentTarget;
        var blkForMark = model.getBlocks()[model.findIndex(activeId)];
        if (blkForMark && blkForMark.type !== 'code' && editForMark) {
          var markHandled = false;
          // 成对 unwrap 优先于块级 Backspace 合并（仅边界命中时吞键）
          if (
            window.MdxDelimEdit &&
            typeof window.MdxDelimEdit.handleKeydown === 'function'
          ) {
            try {
              markHandled = !!window.MdxDelimEdit.handleKeydown(e, editForMark);
            } catch (eDelim) {
              markHandled = false;
            }
          }
          if (
            !markHandled &&
            window.MdxKeymapMarks &&
            typeof window.MdxKeymapMarks.handleKeydown === 'function'
          ) {
            try {
              markHandled = !!window.MdxKeymapMarks.handleKeydown(e, editForMark);
            } catch (eMark) {
              markHandled = false;
            }
          }
          if (markHandled) {
            // 快捷键 / 成对删已改 DOM：走同一 commit（htmlToInlineMd）
            onEditInput();
            return;
          }
        }
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // Esc 分层：AI 生成中先取消
        if (aiController && aiController.isBusy && aiController.isBusy()) {
          aiController.abort();
          return;
        }
        exitEdit(true);
        return;
      }

      // 上下方向键：在完整源码行首/行末时跨块移动
      if (
        (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        activeId
      ) {
        var navEdit = e.currentTarget;
        var isFullNav =
          (LineSrc() && LineSrc().isFullSourceEditEl && LineSrc().isFullSourceEditEl(navEdit)) ||
          (navEdit.getAttribute && navEdit.getAttribute('data-mdx-full-src-edit') != null);
        if (isFullNav && LineSrc()) {
          var navRaw =
            LineSrc().plainTextFromFullSource
              ? LineSrc().plainTextFromFullSource(navEdit)
              : textFromEditEl(navEdit);
          var navOff =
            LineSrc().getPlainCaretOffset
              ? LineSrc().getPlainCaretOffset(navEdit)
              : 0;
          var atLineStart = navOff === 0;
          var atLineEnd = navOff >= navRaw.length;
          var navIdx = model.findIndex(activeId);
          if (e.key === 'ArrowUp' && atLineStart && navIdx > 0) {
            e.preventDefault();
            var prevId = model.getBlocks()[navIdx - 1].id;
            exitEdit(true);
            enterEdit(prevId);
            return;
          }
          if (e.key === 'ArrowDown' && atLineEnd && navIdx >= 0 && navIdx < model.getBlocks().length - 1) {
            e.preventDefault();
            var nextId = model.getBlocks()[navIdx + 1].id;
            exitEdit(true);
            enterEdit(nextId);
            return;
          }
        }
      }

      if (e.key === 'Enter' && !e.shiftKey && e.currentTarget.tagName !== 'TEXTAREA') {
        var block = model.getBlocks()[model.findIndex(activeId)];
        if (!block) return;
        if (block.type === 'code' || block.type === 'mermaid' || block.type === 'math') return; // fence/$$ surface: Enter = newline
        e.preventDefault();
        splitBlock();
        return;
      }

      if (e.key === 'Backspace') {
        // F-CORE-09：组字中永不 demote / merge
        if (isComposingNow() || e.isComposing) return;
        var editEl = e.currentTarget;
        var isEdit = editEl.getAttribute && editEl.getAttribute('contenteditable');
        if (!isEdit) return;
        var sel = window.getSelection && window.getSelection();
        var atStart = false;
        if (sel && sel.rangeCount) {
          var r0 = sel.getRangeAt(0);
          if (r0.collapsed && editEl.contains(r0.startContainer)) {
            // 是否在正文最前
            var pre = document.createRange();
            try {
              pre.selectNodeContents(editEl);
              pre.setEnd(r0.startContainer, r0.startOffset);
              atStart = pre.toString().length === 0;
            } catch (errB) {
              atStart = r0.startOffset === 0;
            }
          }
        }
        if (atStart) {
          var blk = model.getBlocks()[model.findIndex(activeId)];
          var lineRoot = editEl.closest && editEl.closest('[data-mdx-line-edit]');
          var isFullSrcBs =
            (LineSrc() && LineSrc().isFullSourceEditEl && LineSrc().isFullSourceEditEl(editEl)) ||
            editEl.getAttribute('data-mdx-full-src-edit') != null ||
            !!(lineRoot && lineRoot.getAttribute && lineRoot.getAttribute('data-mdx-full-src') != null);

          // —— 完整源码态：专用阶梯（DOM 含 ##/*，不能当 body）——
          if (isFullSrcBs && LineSrc() && LineSrc().fullSourceBackspaceAtStart) {
            var rawBs =
              LineSrc().plainTextFromFullSource
                ? LineSrc().plainTextFromFullSource(editEl)
                : textFromEditEl(editEl);
            var idxBs = model.findIndex(activeId);
            var allBs = model.getBlocks();
            var stepFs = LineSrc().fullSourceBackspaceAtStart(rawBs, blk, {
              isFirstBlock: idxBs === 0,
              soleBlock: allBs.length === 1,
              hasMore: allBs.length > 1,
            });
            if (stepFs.action === 'delete-char') return;
            if (stepFs.action === 'noop') {
              e.preventDefault();
              return;
            }
            if (stepFs.action === 'merge-prev') {
              e.preventDefault();
              mergeWithPrev(stepFs.bodyText != null ? stepFs.bodyText : '');
              return;
            }
            if (stepFs.action === 'apply-raw' && stepFs.patch) {
              e.preventDefault();
              model.updateBlock(activeId, stepFs.patch, {
                addToHistory: true,
                reason: 'demote',
              });
              enterEdit(activeId);
              return;
            }
            if (stepFs.action === 'demote-heading' && stepFs.patch) {
              e.preventDefault();
              model.updateBlock(activeId, stepFs.patch, {
                addToHistory: true,
                reason: 'demote',
              });
              enterEdit(activeId);
              return;
            }
            if (stepFs.action === 'to-paragraph' && stepFs.patch) {
              e.preventDefault();
              model.updateBlock(activeId, stepFs.patch, {
                addToHistory: true,
                reason: 'demote',
              });
              enterEdit(activeId);
              return;
            }
          }

          var bodyText = textFromEditEl(editEl);
          // 完整源码若未走上面分支：body 取 parse 后
          if (isFullSrcBs && LineSrc() && LineSrc().parseSourceLine) {
            var pb = LineSrc().parseSourceLine(bodyText);
            if (pb && pb.text != null && pb.type !== 'paragraph') {
              bodyText = String(pb.text);
            } else if (pb && (pb._hashOnly || pb._markOnly)) {
              bodyText = '';
            }
          }
          var Dem = Demotion();
          var bodyEmpty =
            Dem && typeof Dem.isBodyEmpty === 'function'
              ? Dem.isBodyEmpty(bodyText)
              : !String(bodyText || '').replace(/\u00a0/g, ' ').trim();

          // 优先 MdxDemotion.demoteStep（F-CORE-04）
          // 非空 body + caret0 → merge-prev（合并当前正文到上块）；空 body → 阶梯
          if (blk && Dem && typeof Dem.demoteStep === 'function' && !isFullSrcBs) {
            var markNode = lineRoot && lineRoot.querySelector('[data-mdx-mark]');
            var gapNode = lineRoot && lineRoot.querySelector('[data-mdx-gap]');
            var idxD = model.findIndex(activeId);
            var allBlocks = model.getBlocks();
            var step = Dem.demoteStep(
              {
                type: blk.type,
                text: bodyText,
                level: blk.level,
                indent: blk.indent,
                checked: blk.checked,
                callout: blk.callout,
              },
              {
                // 非空时 gap 不影响 merge 决策；空时读 DOM
                hasGap: bodyEmpty ? !!gapNode : false,
                markPresent: bodyEmpty ? !!markNode : !!markNode,
                markSoft: !!(
                  markNode &&
                  markNode.getAttribute('data-kind') === 'bullet' &&
                  (markNode.textContent || '').trim() === '·'
                ),
                caretOffset: 0,
                isFirstBlock: idxD === 0,
                soleBlock: allBlocks.length === 1,
                hasMore: allBlocks.length > 1,
              }
            );

            if (step.action === 'delete-char') return;
            if (step.action === 'noop') {
              e.preventDefault();
              return;
            }
            if (step.action === 'merge-prev') {
              e.preventDefault();
              // patch.text 为当前 body（非空 merge 时携带）；mergeWithPrev 从 DOM 再读一次
              mergeWithPrev(step.patch && step.patch.text != null ? step.patch.text : bodyText);
              return;
            }
            // 结构降级仅在 body 空时执行
            if (!bodyEmpty) return;

            if (step.action === 'strip-gap') {
              e.preventDefault();
              if (gapNode && gapNode.parentNode) gapNode.parentNode.removeChild(gapNode);
              if (markNode) markNode.classList.add('is-loose');
              model.updateBlock(activeId, { text: '' }, { addToHistory: true, reason: 'demote' });
              scheduleEmit();
              return;
            }
            if (step.action === 'demote-heading' && step.patch) {
              e.preventDefault();
              model.updateBlock(
                activeId,
                { type: 'heading', level: step.patch.level, text: '' },
                { addToHistory: true, reason: 'demote' }
              );
              enterEdit(activeId);
              return;
            }
            if (
              (step.action === 'to-paragraph' || step.action === 'strip-mark') &&
              step.patch
            ) {
              e.preventDefault();
              model.updateBlock(
                activeId,
                {
                  type: 'paragraph',
                  text: step.patch.text != null ? step.patch.text : '',
                  level: undefined,
                  indent: step.patch.indent != null ? step.patch.indent : 0,
                  checked: undefined,
                },
                { addToHistory: true, reason: 'demote' }
              );
              enterEdit(activeId);
              return;
            }
          }

          // 回退：LineSrc.handleBackspaceAtBodyStart（仅空 body）
          if (bodyEmpty && blk && lineRoot && LineSrc() && LineSrc().handleBackspaceAtBodyStart) {
            var hr = LineSrc().handleBackspaceAtBodyStart(blk, lineRoot);
            if (hr.handled) {
              e.preventDefault();
              if (hr.convertParagraph) {
                model.updateBlock(
                  activeId,
                  { type: 'paragraph', text: '', level: undefined },
                  { addToHistory: true, reason: 'demote' }
                );
                enterEdit(activeId);
                return;
              }
              if (hr.patch) {
                model.updateBlock(activeId, hr.patch, { addToHistory: true, reason: 'demote' });
                if (hr.patch.type && hr.patch.type !== blk.type) {
                  enterEdit(activeId);
                } else if (hr.patch.level != null && hr.patch.level !== blk.level) {
                  enterEdit(activeId);
                } else {
                  scheduleEmit();
                }
                return;
              }
            }
          }
          var idx = model.findIndex(activeId);
          if (idx > 0 && bodyEmpty) {
            e.preventDefault();
            mergeWithPrev('');
            return;
          }
        }
      }

      // Shift+↑/↓ 在块边界：扩展块级多选（U1 键盘路径；非字符级跨块）
      if (
        e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown')
      ) {
        var editNav = e.currentTarget;
        var atEdge = false;
        try {
          var selN = window.getSelection && window.getSelection();
          if (selN && selN.rangeCount && selN.isCollapsed) {
            var rn = selN.getRangeAt(0);
            if (editNav.contains(rn.startContainer)) {
              var preN = document.createRange();
              preN.selectNodeContents(editNav);
              preN.setEnd(rn.startContainer, rn.startOffset);
              var beforeLen = preN.toString().length;
              var fullLen = (editNav.innerText || editNav.textContent || '').replace(
                /\n$/,
                ''
              ).length;
              if (e.key === 'ArrowUp' && beforeLen === 0) atEdge = true;
              if (e.key === 'ArrowDown' && beforeLen >= fullLen) atEdge = true;
            }
          }
        } catch (eEdge) {
          atEdge = false;
        }
        if (atEdge && SelectionModelApi() && blockSelection) {
          e.preventDefault();
          commitActiveFromDom();
          var idsOrder = model.getBlocks().map(function (b) {
            return b.id;
          });
          var curIdx = idsOrder.indexOf(activeId);
          if (curIdx < 0) return;
          var nextIdx =
            e.key === 'ArrowDown'
              ? Math.min(idsOrder.length - 1, curIdx + 1)
              : Math.max(0, curIdx - 1);
          if (nextIdx === curIdx) return;
          var anchor = blockSelection.anchorId || activeId;
          SelectionModelApi().setRange(
            blockSelection,
            idsOrder,
            anchor,
            idsOrder[nextIdx]
          );
          if (blockSelection.selectedIds && blockSelection.selectedIds.length > 1) {
            blockSelection.mode = 'multi';
            exitEdit(true);
          }
          paintBlockSelection();
          return;
        }
      }

      // Alt+Up/Down move
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        var from = model.findIndex(activeId);
        if (from < 0) return;
        var to = e.key === 'ArrowUp' ? from - 1 : from + 1;
        if (to < 0 || to >= model.getBlocks().length) return;
        commitActiveFromDom();
        var id = activeId;
        model.moveBlock(from, e.key === 'ArrowUp' ? from - 1 : from + 1, { addToHistory: true });
        reconcile();
        enterEdit(id);
        return;
      }

      // Tab indent list
      if (e.key === 'Tab') {
        var b = model.getBlocks()[model.findIndex(activeId)];
        if (b && /_item$/.test(b.type)) {
          e.preventDefault();
          var ind = b.indent || 0;
          model.updateBlock(
            activeId,
            { indent: e.shiftKey ? Math.max(0, ind - 1) : Math.min(6, ind + 1) },
            { addToHistory: true }
          );
          enterEdit(activeId);
        }
      }

      // undo redo
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        exitEdit(false);
        if (e.shiftKey) model.redo();
        else model.undo();
        fullRender();
      }
    }

    function onTableKeydown(e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        var cells = Array.prototype.slice.call(
          e.currentTarget.closest('[data-mdx-content]').querySelectorAll('.mdx-td[contenteditable]')
        );
        var i = cells.indexOf(e.currentTarget);
        var next = e.shiftKey ? cells[i - 1] : cells[i + 1];
        if (next) next.focus();
        else if (!e.shiftKey && activeId) {
          // 最后一格 Tab → 加行并聚焦新行首格
          var curR = +e.currentTarget.dataset.r;
          var curC = +e.currentTarget.dataset.c;
          applyTableMutation(
            activeId,
            function (w) {
              if (Schema() && Schema().tableAddRow) Schema().tableAddRow(w);
              else {
                var cols = (w.rows && w.rows[0] && w.rows[0].length) || 1;
                var nr = [];
                for (var c = 0; c < cols; c++) nr.push('');
                w.rows = (w.rows || []).concat([nr]);
              }
            },
            { focusCell: { r: curR + 1, c: 0 } }
          );
        }
        return;
      }
      // F-T-0006：Shift+方向键扩展选区（委托 chrome.selCtrl = MdxTableSelection）
      if (
        e.shiftKey &&
        (e.key === 'ArrowUp' ||
          e.key === 'ArrowDown' ||
          e.key === 'ArrowLeft' ||
          e.key === 'ArrowRight')
      ) {
        var wrapEl =
          e.currentTarget.closest && e.currentTarget.closest('.mdx-table-wrap');
        var chromeState = wrapEl && wrapEl._mdxChrome;
        var selCtrl = chromeState && chromeState.selCtrl;
        if (selCtrl && (selCtrl.extendByKey || selCtrl.setRange)) {
          e.preventDefault();
          var blk = model.getBlocks()[model.findIndex(activeId)];
          var maxR = (blk && blk.cells && blk.cells.length ? blk.cells.length : 1) - 1;
          var maxC =
            (blk && blk.cells && blk.cells[0] && blk.cells[0].length
              ? blk.cells[0].length
              : 1) - 1;
          var ar = +e.currentTarget.dataset.r;
          var ac = +e.currentTarget.dataset.c;
          if (!selCtrl.getRange || !selCtrl.getRange()) {
            if (selCtrl.begin) selCtrl.begin(ar, ac);
            else if (selCtrl.setRange) {
              selCtrl.setRange({ r0: ar, c0: ac, r1: ar, c1: ac });
            }
          }
          if (selCtrl.extendByKey) {
            selCtrl.extendByKey(e.key, { maxR: maxR, maxC: maxC });
          }
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        exitEdit(true);
      }
    }

    function splitBlock() {
      if (!activeId) return;
      var idx = model.findIndex(activeId);
      var block = model.getBlocks()[idx];
      if (!block) return;
      var el = blockEls[activeId];
      var edit = el && el.querySelector('[data-mdx-edit]');
      if (!edit) return;

      var isFull =
        (LineSrc() && LineSrc().isFullSourceEditEl && LineSrc().isFullSourceEditEl(edit)) ||
        edit.getAttribute('data-mdx-full-src-edit') != null ||
        !!(edit.closest && edit.closest('[data-mdx-full-src]'));

      // —— 完整行源码：按 MD 源串拆，再 parse 左右块（禁止把 `##` 写进 text）——
      if (isFull && LineSrc() && typeof LineSrc().splitFullSourceAt === 'function') {
        var raw =
          LineSrc().plainTextFromFullSource
            ? LineSrc().plainTextFromFullSource(edit)
            : textFromEditEl(edit);
        var offset =
          LineSrc().getPlainCaretOffset
            ? LineSrc().getPlainCaretOffset(edit)
            : raw.length;

        // 空列表项 Enter → 退出列表（Typora 习惯）
        var parsedLine = LineSrc().parseSourceLine ? LineSrc().parseSourceLine(raw) : null;
        var bodyEmpty =
          parsedLine &&
          !(String(parsedLine.text || '')
            .replace(/\u00a0/g, ' ')
            .trim());
        if (
          bodyEmpty &&
          parsedLine &&
          (parsedLine.type === 'bullet_item' ||
            parsedLine.type === 'ordered_item' ||
            parsedLine.type === 'task_item')
        ) {
          model.updateBlock(
            activeId,
            { type: 'paragraph', text: '', indent: 0, checked: undefined },
            { addToHistory: true, reason: 'exit-list' }
          );
          enterEdit(activeId);
          scheduleEmit();
          return;
        }
        // 空标题 Enter → 下方新段落
        if (bodyEmpty && parsedLine && parsedLine.type === 'heading') {
          model.updateBlock(
            activeId,
            {
              type: 'heading',
              level: parsedLine.level || block.level || 1,
              text: '',
            },
            { addToHistory: true, reason: 'split' }
          );
          var emptyBelow = model.insertBlock(
            idx + 1,
            { type: 'paragraph', text: '' },
            { addToHistory: false, reason: 'split' }
          );
          activeId = null;
          reconcile();
          if (emptyBelow) enterEdit(emptyBelow.id);
          scheduleEmit();
          return;
        }

        var parts = LineSrc().splitFullSourceAt(raw, offset, block);
        var left = parts.before || { type: 'paragraph', text: '' };
        var right = parts.after || { type: 'paragraph', text: '' };
        // 未完成前缀（仅 `##`）时 left 可能丢 raw
        if (
          left.type === 'paragraph' &&
          !(left.text || '').trim() &&
          parts.beforeRaw &&
          /^#{1,6}$/.test(parts.beforeRaw.trim())
        ) {
          left = { type: 'paragraph', text: parts.beforeRaw };
        }
        model.updateBlock(activeId, left, { addToHistory: true, reason: 'split' });
        var createdFull = model.insertBlock(idx + 1, right, {
          addToHistory: false,
          reason: 'split',
        });
        activeId = null;
        reconcile();
        if (createdFull && createdFull.id) enterEdit(createdFull.id);
        scheduleEmit();
        return;
      }

      // —— 半表面 / 软编辑路径 ——
      commitActiveFromDom();
      idx = model.findIndex(activeId);
      block = model.getBlocks()[idx];
      el = blockEls[activeId];
      edit = el && activeEditEl(el);
      var text = edit ? textFromEditEl(edit) : (block && block.text) || '';

      // 空列表项 Enter → 退出列表（Typora：变段落，不插新 bullet）
      if (
        block &&
        /_item$/.test(block.type) &&
        !String(text || '')
          .replace(/\u00a0/g, ' ')
          .trim()
      ) {
        model.updateBlock(
          activeId,
          { type: 'paragraph', text: '', indent: 0, checked: undefined },
          { addToHistory: true, reason: 'exit-list' }
        );
        enterEdit(activeId);
        scheduleEmit();
        return;
      }

      // 空标题 Enter → 下方新段落
      if (
        block &&
        block.type === 'heading' &&
        !String(text || '')
          .replace(/\u00a0/g, ' ')
          .trim()
      ) {
        var emptyBelowH = model.insertBlock(
          idx + 1,
          { type: 'paragraph', text: '' },
          { addToHistory: true, reason: 'split' }
        );
        reconcile();
        if (emptyBelowH) enterEdit(emptyBelowH.id);
        scheduleEmit();
        return;
      }

      // callout 标题区 Enter：焦点移到正文（不拆块）
      if (
        block &&
        block.type === 'callout' &&
        edit &&
        edit.getAttribute('data-mdx-callout-part') === 'title'
      ) {
        var bodyPart = el.querySelector('[data-mdx-callout-part="body"]');
        if (bodyPart) {
          bodyPart.focus();
          placeCaretEnd(bodyPart);
          return;
        }
      }

      var before = text;
      var after = '';
      var sel = window.getSelection();
      if (sel && sel.rangeCount && edit) {
        var range = sel.getRangeAt(0);
        if (edit.contains(range.startContainer)) {
          try {
            var preR = range.cloneRange();
            preR.selectNodeContents(edit);
            preR.setEnd(range.startContainer, range.startOffset);
            var preWrap = document.createElement('div');
            preWrap.appendChild(preR.cloneContents());
            before = textFromEditEl(preWrap);

            var postR = range.cloneRange();
            postR.selectNodeContents(edit);
            postR.setStart(range.endContainer, range.endOffset);
            var postWrap = document.createElement('div');
            postWrap.appendChild(postR.cloneContents());
            after = textFromEditEl(postWrap);
          } catch (err) {
            var pre = range.cloneRange();
            pre.selectNodeContents(edit);
            pre.setEnd(range.startContainer, range.startOffset);
            before = pre.toString();
            var post = range.cloneRange();
            post.selectNodeContents(edit);
            post.setStart(range.endContainer, range.endOffset);
            after = post.toString();
          }
        }
      }

      // callout 正文区拆分：左留在 callout，右新建段落（不复制 callout 壳）
      if (block && block.type === 'callout') {
        var lineRootC = el.querySelector('[data-mdx-line-edit]');
        var modeC = lineRootC && lineRootC.getAttribute('data-callout-mode');
        var part = edit && edit.getAttribute('data-mdx-callout-part');
        if (modeC === 'body-only' || part === 'body') {
          var leftBody = before;
          var rightPara = after;
          if (modeC === 'title-body' && part === 'body') {
            var titleElC = lineRootC.querySelector('[data-mdx-callout-part="title"]');
            var tKeep = titleElC ? textFromEditEl(titleElC) : '';
            model.updateBlock(
              activeId,
              {
                type: 'callout',
                callout: block.callout || 'note',
                text: tKeep + (leftBody ? '\n' + leftBody : ''),
              },
              { addToHistory: true, reason: 'split' }
            );
          } else {
            model.updateBlock(
              activeId,
              {
                type: 'callout',
                callout: block.callout || 'note',
                text: leftBody,
              },
              { addToHistory: true, reason: 'split' }
            );
          }
          var createdCall = model.insertBlock(
            idx + 1,
            { type: 'paragraph', text: rightPara },
            { addToHistory: false, reason: 'split' }
          );
          reconcile();
          if (createdCall) enterEdit(createdCall.id);
          scheduleEmit();
          return;
        }
      }

      model.updateBlock(activeId, { text: before }, { addToHistory: true, reason: 'split' });
      var newType = /_item$/.test(block.type) ? block.type : 'paragraph';
      var nb = {
        type: newType,
        text: after,
        indent: block.indent || 0,
      };
      if (newType === 'task_item') nb.checked = false;
      if (block.type === 'heading') {
        nb.type = 'paragraph';
      }
      var created = model.insertBlock(idx + 1, nb, { addToHistory: false, reason: 'split' });
      reconcile();
      enterEdit(created.id);
    }

    /**
     * 将当前块正文合并进上一块末尾（F-CORE-04 merge-prev）
     * @param {string} [overrideCurText] 优先使用（来自 demoteStep.patch.text 或 DOM 快照）
     */
    function mergeWithPrev(overrideCurText) {
      if (!activeId) return;
      var idx = model.findIndex(activeId);
      if (idx <= 0) {
        // 首块：空结构可降为段落；非空 noop
        var b = model.getBlocks()[idx];
        if (b && b.type !== 'paragraph' && !(b.text || '').trim()) {
          model.updateBlock(
            activeId,
            { type: 'paragraph', text: '', level: undefined },
            { addToHistory: true, reason: 'demote' }
          );
          enterEdit(activeId);
        }
        return;
      }
      var el = blockEls[activeId];
      var edit = el && el.querySelector('[data-mdx-edit]');
      var isFull =
        edit &&
        ((LineSrc() && LineSrc().isFullSourceEditEl && LineSrc().isFullSourceEditEl(edit)) ||
          edit.getAttribute('data-mdx-full-src-edit') != null);

      // 完整源码：先从 DOM parse 出 body，禁止把 `##` 拼进上一块
      var curText;
      if (overrideCurText != null) {
        curText = String(overrideCurText);
      } else if (isFull && LineSrc() && LineSrc().readFromFullSource) {
        var fp = LineSrc().readFromFullSource(edit);
        curText = fp && fp.text != null ? String(fp.text) : '';
      } else if (edit) {
        curText = textFromEditEl(edit);
        // 若误读到带前缀的源码，再 parse 一次
        if (LineSrc() && LineSrc().parseSourceLine && /^#{1,6}\s|^[-*+]\s|^\d+\.\s|^>\s/.test(curText)) {
          var pp = LineSrc().parseSourceLine(curText);
          if (pp && pp.text != null && pp.type !== 'paragraph') curText = String(pp.text);
        }
      } else {
        var cur0 = model.getBlocks()[idx];
        curText = cur0 && cur0.text != null ? String(cur0.text) : '';
      }

      var prev = model.getBlocks()[idx - 1];
      var prevText = prev.text != null ? String(prev.text) : '';
      // 原子块（code/table…）不把正文拼进去，只删除当前空块
      var atomicPrev =
        prev.type === 'code' ||
        prev.type === 'table' ||
        prev.type === 'math' ||
        prev.type === 'mermaid' ||
        prev.type === 'image' ||
        prev.type === 'divider' ||
        prev.type === 'toc';
      var prevId = prev.id;
      var caretAt = prevText.length;
      if (!atomicPrev && (prev.text != null || prev.type === 'paragraph' || prev.type === 'heading' || /_item$/.test(prev.type) || prev.type === 'quote')) {
        var merged = prevText + curText;
        model.updateBlock(prevId, { text: merged }, { addToHistory: true, reason: 'merge-prev' });
      } else {
        // 上一块不可拼文本：仅删当前（若当前也空）
        model.updateBlock(activeId, { text: curText }, { addToHistory: true, reason: 'merge-prev' });
      }
      model.removeBlock(activeId, { addToHistory: false });
      activeId = null;
      reconcile();
      enterEdit(prevId);
      // 尽量把 caret 放在合并点
      try {
        var prevEl = blockEls[prevId];
        var prevEdit = prevEl && prevEl.querySelector('[data-mdx-edit]');
        if (prevEdit && window.getSelection) {
          var textNode = null;
          var walk = document.createTreeWalker(prevEdit, NodeFilter.SHOW_TEXT, null);
          var acc = 0;
          var n;
          while ((n = walk.nextNode())) {
            var len = (n.nodeValue || '').length;
            if (acc + len >= caretAt) {
              textNode = n;
              var range = document.createRange();
              range.setStart(n, Math.max(0, caretAt - acc));
              range.collapse(true);
              var sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
              break;
            }
            acc += len;
          }
          if (!textNode) placeCaretEnd(prevEdit);
        }
      } catch (eMerge) {
        /* ignore */
      }
    }

    /* ---------- pointer / click ---------- */

    function onRootClick(e) {
      var fileChip = e.target.closest && e.target.closest('[data-mdx-file]');
      if (fileChip) {
        e.preventDefault();
        e.stopPropagation();
        onOpenPath(fileChip.getAttribute('data-mdx-file'), { kind: 'file-chip' });
        return;
      }
      var wiki = e.target.closest && e.target.closest('[data-mdx-doc]');
      if (wiki) {
        e.preventDefault();
        e.stopPropagation();
        onOpenDoc(wiki.getAttribute('data-mdx-doc'));
        return;
      }

      // TOC：跳转到标题块
      var tocLink = e.target.closest && e.target.closest('[data-mdx-goto-heading]');
      if (tocLink) {
        e.preventDefault();
        e.stopPropagation();
        scrollToHeadingBlock(tocLink.getAttribute('data-mdx-goto-heading'));
        return;
      }

      // F-CODE-COPY：复制 body，不进入 focus-source
      var copyBtn = e.target.closest && e.target.closest('[data-mdx-code-copy]');
      if (copyBtn) {
        e.preventDefault();
        e.stopPropagation();
        var codeBlockEl = copyBtn.closest('.mdx-block');
        var codeId = codeBlockEl && codeBlockEl.dataset.blockId;
        var codeBlock =
          codeId != null ? model.getBlocks()[model.findIndex(codeId)] : null;
        var body = (codeBlock && codeBlock.text) || '';
        var CodeMod = BlocksCode();
        if (CodeMod && typeof CodeMod.copyBody === 'function') {
          CodeMod.copyBody(body, { button: copyBtn });
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(body).catch(function () {});
        }
        return;
      }

      // F-CODE-FOLD：展开 / 收起（仅读态；不改 model.text）
      var foldBtn = e.target.closest && e.target.closest('[data-mdx-code-fold]');
      if (foldBtn) {
        e.preventDefault();
        e.stopPropagation();
        var foldBlockEl = foldBtn.closest('.mdx-block');
        var foldId = foldBlockEl && foldBlockEl.dataset.blockId;
        if (!foldId) return;
        var foldAction = foldBtn.getAttribute('data-mdx-code-fold') || '';
        if (foldAction === 'collapse' || codeFoldExpanded[foldId]) {
          delete codeFoldExpanded[foldId];
        } else {
          codeFoldExpanded[foldId] = true;
        }
        // 若正在源码编辑则先提交再读态重渲（fold 条仅读态出现，双保险）
        if (activeId === foldId) {
          exitEdit(true);
        } else {
          patchBlock(foldId);
        }
        return;
      }

      // F-CODE-LANG：读态语言标签 → 菜单改 lang 并 re-highlight（不进源码）
      var langEl =
        e.target.closest &&
        e.target.closest('.mdx-code-card__lang, [data-mdx-code-lang]');
      if (langEl) {
        e.preventDefault();
        e.stopPropagation();
        var langBlockEl = langEl.closest('.mdx-block');
        var langBlockId = langBlockEl && langBlockEl.dataset.blockId;
        var langBlock =
          langBlockId != null
            ? model.getBlocks()[model.findIndex(langBlockId)]
            : null;
        var curLang = (langBlock && langBlock.lang) || '';
        var Menu = CodeLangMenu();
        if (Menu && typeof Menu.open === 'function') {
          Menu.open(langEl, {
            current: curLang,
            blockId: langBlockId,
            onSelect: function (lang) {
              if (!langBlockId) return;
              var next = String(lang || '').trim();
              model.updateBlock(
                langBlockId,
                { lang: next },
                { addToHistory: !viewOnly, reason: 'code-lang' }
              );
              try {
                root.dispatchEvent(
                  new CustomEvent('mdx-code-lang', {
                    bubbles: true,
                    detail: {
                      blockId: langBlockId,
                      lang: next,
                      source: 'editor',
                    },
                  })
                );
              } catch (evErr) {
                /* ignore */
              }
              if (activeId === langBlockId) {
                // 源码态极少走到（bar 隐藏）；提交后以新 lang 重渲
                exitEdit(true);
              } else {
                patchBlock(langBlockId);
              }
            },
          });
        }
        return;
      }

      // 图片灯箱：点击就绪图放大（viewOnly / 编辑态读图均可；不进源码）
      var imgZoom =
        e.target.closest &&
        e.target.closest('.mdx-image__img:not(.mdx-image__img--preview)');
      if (imgZoom && imgZoom.getAttribute('src')) {
        var ImgLb = BlocksImage();
        if (ImgLb && typeof ImgLb.openLightbox === 'function') {
          e.preventDefault();
          e.stopPropagation();
          ImgLb.openLightbox(imgZoom.getAttribute('src'), imgZoom.getAttribute('alt') || '');
          return;
        }
      }

      if (viewOnly) return;

      // LEGACY-ISLAND: remove in R4 — 待办勾选必须可点，禁止整块换壳抢走
      var taskCb =
        e.target.closest && e.target.closest('input.mdx-task-check, .mdx-task-check');
      if (taskCb) {
        e.stopPropagation();
        var taskBlockEl = taskCb.closest('.mdx-block');
        var taskId = taskBlockEl && taskBlockEl.dataset.blockId;
        if (!taskId) return;
        var taskBlock = model.getBlocks()[model.findIndex(taskId)];
        if (!taskBlock || taskBlock.type !== 'task_item') return;
        // 若已在编辑岛，让原生 checkbox 改 DOM 后 commit；读态直接改 model
        if (activeId === taskId) {
          // 等原生 toggle 完成
          setTimeout(function () {
            var checked = !!(taskCb.checked || taskCb.getAttribute('checked'));
            model.updateBlock(
              taskId,
              { checked: checked },
              { addToHistory: true, reason: 'task-check' }
            );
            scheduleEmit();
          }, 0);
          return;
        }
        e.preventDefault();
        model.updateBlock(
          taskId,
          { checked: !taskBlock.checked },
          { addToHistory: true, reason: 'task-check' }
        );
        patchBlock(taskId);
        scheduleEmit();
        return;
      }

      // LEGACY-ISLAND: data-cx-no-edit 控件不触发整块 enterEdit（复制/语言/折叠已处理）
      if (e.target.closest && e.target.closest('[data-cx-no-edit]')) {
        return;
      }

      // U1：Shift/Ctrl 多选由 selection controller 处理；多选态单击也由 controller 收尾
      if (e.shiftKey || e.metaKey || e.ctrlKey) return;
      if (
        selectionController &&
        blockSelection &&
        blockSelection.selectedIds &&
        blockSelection.selectedIds.length > 1
      ) {
        return;
      }

      var blockEl = e.target.closest && e.target.closest('.mdx-block');
      if (!blockEl) {
        if (activeId && !e.target.closest('.mdx-slash')) exitEdit(true);
        if (selectionController) selectionController.clear();
        return;
      }
      if (e.target.closest('.mdx-handle')) return;
      var id = blockEl.dataset.blockId;
      if (id && id !== activeId) enterEdit(id);
    }

    /* ---------- viewOnly: block mutating keys, keep copy/scroll ---------- */

    function isAllowedViewOnlyKey(e) {
      var mod = e.metaKey || e.ctrlKey;
      var key = e.key || '';
      var lower = key.toLowerCase();
      // 复制 / 全选 / 查找
      if (mod && (lower === 'c' || lower === 'a' || lower === 'f' || lower === 'insert')) {
        return true;
      }
      // 纯修饰键
      if (
        key === 'Control' ||
        key === 'Meta' ||
        key === 'Alt' ||
        key === 'Shift' ||
        key === 'CapsLock' ||
        key === 'ContextMenu'
      ) {
        return true;
      }
      // 导航与滚动相关
      if (
        key === 'ArrowUp' ||
        key === 'ArrowDown' ||
        key === 'ArrowLeft' ||
        key === 'ArrowRight' ||
        key === 'Home' ||
        key === 'End' ||
        key === 'PageUp' ||
        key === 'PageDown' ||
        key === 'Escape' ||
        key === 'Tab' ||
        key === 'F1' ||
        key === 'F2' ||
        key === 'F3' ||
        key === 'F4' ||
        key === 'F5' ||
        key === 'F6' ||
        key === 'F7' ||
        key === 'F8' ||
        key === 'F9' ||
        key === 'F10' ||
        key === 'F11' ||
        key === 'F12'
      ) {
        return true;
      }
      return false;
    }

    function onViewOnlyKeydown(e) {
      if (!viewOnly) return;
      if (isAllowedViewOnlyKey(e)) return;
      // 空格留给滚动；其余会改文档的按键拦截
      if (e.key === ' ' || e.code === 'Space') return;
      e.preventDefault();
      e.stopPropagation();
    }

    function onViewOnlyBeforeInput(e) {
      if (!viewOnly) return;
      e.preventDefault();
    }

    /* ---------- DnD ---------- */

    function onHandlePointerDown(e) {
      if (viewOnly) return;
      var handle = e.target.closest && e.target.closest('.mdx-handle');
      if (!handle) return;
      e.preventDefault();
      e.stopPropagation();
      var blockEl = handle.closest('.mdx-block');
      if (!blockEl) return;
      if (activeId) exitEdit(true);

      var id = blockEl.dataset.blockId;
      var from = model.findIndex(id);
      handle.setAttribute('aria-grabbed', 'true');
      root.classList.add('mdx-editor--dragging');
      blockEl.classList.add('mdx-block--dragging');

      dnd = {
        id: id,
        from: from,
        startY: e.clientY,
        handle: handle,
        blockEl: blockEl,
      };

      try {
        handle.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }

      function onMove(ev) {
        if (!dnd) return;
        var y = ev.clientY;
        var targetIndex = hitIndex(y);
        showDrop(targetIndex);
        dnd.to = targetIndex;
      }
      function onUp() {
        if (!dnd) return;
        handle.releasePointerCapture && handle.releasePointerCapture(e.pointerId);
        handle.setAttribute('aria-grabbed', 'false');
        root.classList.remove('mdx-editor--dragging');
        blockEl.classList.remove('mdx-block--dragging');
        dropEl.hidden = true;
        var to = dnd.to;
        var fromIdx = dnd.from;
        var movedId = dnd.id;
        dnd = null;
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        if (to == null || to === fromIdx || to === fromIdx + 1) return;
        // convert drop index to move target
        var dest = to > fromIdx ? to - 1 : to;
        model.moveBlock(fromIdx, dest, { addToHistory: true });
        reconcile();
        announce('已移动块');
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    }

    function hitIndex(clientY) {
      var blocks = model.getBlocks();
      var nodes = blocksEl.querySelectorAll('.mdx-block');
      for (var i = 0; i < nodes.length; i++) {
        var r = nodes[i].getBoundingClientRect();
        var mid = r.top + r.height / 2;
        if (clientY < mid) return i;
      }
      return blocks.length;
    }

    function showDrop(index) {
      var nodes = blocksEl.querySelectorAll('.mdx-block');
      var rootRect = root.getBoundingClientRect();
      var y;
      if (index <= 0) {
        if (!nodes[0]) return;
        y = nodes[0].getBoundingClientRect().top - rootRect.top;
      } else if (index >= nodes.length) {
        var last = nodes[nodes.length - 1];
        y = last.getBoundingClientRect().bottom - rootRect.top;
      } else {
        y = nodes[index].getBoundingClientRect().top - rootRect.top;
      }
      dropEl.hidden = false;
      dropEl.style.top = y + 'px';
      dropEl.style.left = '28px';
      dropEl.style.right = '8px';
      dropEl.style.width = 'auto';
    }

    /* ---------- public ---------- */

    function setMarkdown(md) {
      exitEdit(false);
      model.setDoc(Parse().parse(md), { silentHistory: true, reason: 'setMarkdown' });
      // clear history baseline
      fullRender();
      scheduleEmit();
    }

    function setDoc(doc) {
      exitEdit(false);
      var next =
        window.MdxSchema && window.MdxSchema.migrate
          ? window.MdxSchema.migrate(doc)
          : doc;
      model.setDoc(next, { silentHistory: true, reason: 'setDoc' });
      fullRender();
      scheduleEmit();
    }

    function destroy() {
      destroyed = true;
      clearTimeout(saveTimer);
      clearTimeout(inputDebounce);
      destroyImeGuard();
      if (mediaBinder && typeof mediaBinder.destroy === 'function') {
        try {
          mediaBinder.destroy();
        } catch (eMed) {
          /* ignore */
        }
        mediaBinder = null;
      }
      if (aiController && typeof aiController.destroy === 'function') {
        try {
          aiController.destroy();
        } catch (eAi) {
          /* ignore */
        }
        aiController = null;
      }
      if (cmdPalette && typeof cmdPalette.destroy === 'function') {
        try {
          cmdPalette.destroy();
        } catch (eCp) {
          /* ignore */
        }
        cmdPalette = null;
      }
      if (selectionController && typeof selectionController.destroy === 'function') {
        try {
          selectionController.destroy();
        } catch (eSel) {
          /* ignore */
        }
        selectionController = null;
      }
      selectionChrome = null;
      if (pasteBinder && typeof pasteBinder.destroy === 'function') {
        try {
          pasteBinder.destroy();
        } catch (ePaste) {
          /* ignore */
        }
        pasteBinder = null;
      }
      if (mediaBinder && typeof mediaBinder.destroy === 'function') {
        try {
          mediaBinder.destroy();
        } catch (eMedia) {
          /* ignore */
        }
        mediaBinder = null;
      }
      if (selToolbar && typeof selToolbar.destroy === 'function') {
        try {
          selToolbar.destroy();
        } catch (eDes) {
          /* ignore */
        }
        selToolbar = null;
      }
      if (window.MdxContextMenu) window.MdxContextMenu.close();
      if (window.MdxCodeLangMenu && typeof window.MdxCodeLangMenu.close === 'function') {
        window.MdxCodeLangMenu.close(true);
      }
      codeFoldExpanded = Object.create(null);
      if (!viewOnly) {
        // force leave even if composing (destroy path)
        composing = false;
        if (activeId) {
          var forceId = activeId;
          var forceEl = blockEls[forceId];
          if (forceEl) {
            try {
              commitActiveFromDom();
            } catch (eC) {
              /* ignore */
            }
          }
          activeId = null;
        }
        flush();
      }
      root.removeEventListener('click', onRootClick);
      root.removeEventListener('pointerdown', onHandlePointerDown);
      root.removeEventListener('keydown', onViewOnlyKeydown, true);
      root.removeEventListener('beforeinput', onViewOnlyBeforeInput, true);
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    function focus() {
      if (viewOnly) {
        var scroller = root.querySelector('[data-mdx-scroller]');
        if (scroller && typeof scroller.focus === 'function') {
          try {
            scroller.focus({ preventScroll: true });
          } catch (err) {
            scroller.focus();
          }
        }
        return;
      }
      var blocks = model.getBlocks();
      if (blocks[0]) enterEdit(blocks[0].id);
    }

    // wire
    root.addEventListener('click', onRootClick);
    if (!viewOnly) {
      root.addEventListener('pointerdown', onHandlePointerDown);
      // W6：粘贴 / 拖放图片
      if (MediaDropPaste() && typeof MediaDropPaste().bind === 'function') {
        mediaBinder = MediaDropPaste().bind(root, {
          viewOnly: viewOnly,
          getUploadImage: function () {
            return uploadImage;
          },
          maxUploadBytes: maxUploadBytes,
          onInsertImages: insertImageBlocks,
          onError: function (err) {
            announce((err && err.message) || String(err || '图片处理失败'));
          },
        });
      }
      // U3：文档级 MD/HTML/plain 粘贴（捕获阶段；图片仍由 media 优先）
      if (ClipboardPasteApi() && typeof ClipboardPasteApi().bind === 'function') {
        pasteBinder = ClipboardPasteApi().bind(root, {
          viewOnly: function () {
            return viewOnly;
          },
          hasImageFiles: function (e) {
            var cd = e && e.clipboardData;
            if (!cd) return false;
            if (cd.files && cd.files.length) {
              for (var i = 0; i < cd.files.length; i++) {
                if (cd.files[i] && /^image\//i.test(cd.files[i].type || '')) return true;
              }
            }
            if (cd.items) {
              for (var j = 0; j < cd.items.length; j++) {
                if (cd.items[j].kind === 'file' && /^image\//i.test(cd.items[j].type || '')) {
                  return true;
                }
              }
            }
            return false;
          },
          onPasteInline: function (text) {
            // 多选时：整段替换为粘贴内容
            if (
              selectionController &&
              selectionController.isMulti &&
              selectionController.isMulti()
            ) {
              return false;
            }
            return insertPlainAtCaret(text, { kind: 'plain' });
          },
          onPasteBlocks: function (blocks, meta) {
            if (
              selectionController &&
              selectionController.isMulti &&
              selectionController.isMulti()
            ) {
              var s = blockSelection;
              var ids = (s && s.selectedIds) || [];
              if (ids.length) {
                // 删多选后在原位置插入
                var firstIdx = model.findIndex(ids[0]);
                deleteBlocksByIds(ids);
                if (firstIdx < 0) firstIdx = 0;
                for (var pi = 0; pi < blocks.length; pi++) {
                  var pb = Object.assign({}, blocks[pi]);
                  delete pb.id;
                  model.insertBlock(firstIdx + pi, pb, {
                    addToHistory: pi === 0,
                    reason: 'paste-replace',
                  });
                }
                reconcile();
                var focus = model.getBlocks()[firstIdx + blocks.length - 1];
                if (focus) enterEdit(focus.id);
                scheduleEmit();
                announce('已粘贴替换 ' + blocks.length + ' 块');
                return true;
              }
            }
            // 单行 plain 已走 inline；多块 / MD 结构走块插入
            if (meta && meta.inlineOnly && blocks.length === 1) {
              var t = blocks[0].text != null ? String(blocks[0].text) : '';
              if (insertPlainAtCaret(t, meta)) return true;
            }
            return insertPasteBlocks(blocks, meta);
          },
        });
      }
      // F-CORE-08：选区浮动条默认关闭；仅 options.selectionToolbar === true 挂载
      if (
        enableSelToolbar &&
        window.MdxSelectionToolbar &&
        typeof window.MdxSelectionToolbar.mount === 'function'
      ) {
        root.classList.add('mdx-sel-bar-enabled');
        selToolbar = window.MdxSelectionToolbar.mount(root, {
          onCommand: function () {
            scheduleEmit();
          },
        });
      }
    } else {
      // 捕获阶段拦截会改文档的键盘；保留复制与滚动
      root.addEventListener('keydown', onViewOnlyKeydown, true);
      root.addEventListener('beforeinput', onViewOnlyBeforeInput, true);
      root.setAttribute('tabindex', '0');
    }

    // W8：AI 控制器（无端口则不挂）
    if (
      aiEnabled &&
      AiActions() &&
      typeof AiActions().createController === 'function'
    ) {
      aiController = AiActions().createController({
        viewOnly: function () {
          return viewOnly;
        },
        getSelectionText: getSelectionTextInEditor,
        getDocumentMd: getMarkdown,
        getActiveBlockId: function () {
          return activeId;
        },
        insertParagraphBelow: insertParagraphBelowActive,
        announce: announce,
        getComplete: function () {
          return aiComplete;
        },
        root: root,
        flush: scheduleEmit,
      });
    }

    // W8：命令面板（Ctrl+P / Ctrl+Shift+P）；viewOnly 仍可打开只读子集
    if (
      options.commandPalette !== false &&
      CommandPalette() &&
      typeof CommandPalette().mount === 'function'
    ) {
      cmdPalette = CommandPalette().mount(root, {
        getCommands: buildPaletteCommands,
        alsoCtrlShiftP: true,
        openOnCtrlP: options.openOnCtrlP !== false,
      });
    }

    // U1：跨块多选 + 多选行源码
    if (
      !viewOnly &&
      options.multiBlockSelection !== false &&
      SelectionChromeApi() &&
      typeof SelectionChromeApi().create === 'function'
    ) {
      selectionChrome = SelectionChromeApi().create({
        getState: function () {
          return blockSelection;
        },
        getBlocks: function () {
          return model.getBlocks();
        },
        getBlockEls: function () {
          return blockEls;
        },
        readHtml: function (block) {
          return readContentHtml(block);
        },
      });
    }
    if (
      !viewOnly &&
      options.multiBlockSelection !== false &&
      SelectionControllerApi() &&
      typeof SelectionControllerApi().attach === 'function'
    ) {
      selectionController = SelectionControllerApi().attach({
        root: root,
        getOrderedIds: getOrderedBlockIds,
        getBlocks: function () {
          return model.getBlocks();
        },
        getState: function () {
          return blockSelection;
        },
        setState: function (s) {
          blockSelection = s;
        },
        paint: function () {
          paintBlockSelection();
        },
        enterEdit: enterEdit,
        exitEdit: exitEdit,
        getActiveId: function () {
          return activeId;
        },
        deleteBlocks: deleteBlocksByIds,
        selectionToMarkdown: function (s) {
          if (!selectionChrome) return '';
          return selectionChrome.selectionToMarkdown(s, model.getBlocks());
        },
        viewOnly: function () {
          return viewOnly;
        },
        announce: announce,
      });
    }

    fullRender();
    paintBlockSelection();

    return {
      root: root,
      getMarkdown: getMarkdown,
      setMarkdown: setMarkdown,
      setDoc: setDoc,
      flush: flush,
      destroy: destroy,
      focus: focus,
      viewOnly: viewOnly,
      getDoc: function () {
        return model.getDoc();
      },
      model: model,
      /** U1 调试/宿主：当前块级多选 id */
      getBlockSelection: function () {
        return {
          mode: blockSelection.mode,
          selectedIds: (blockSelection.selectedIds || []).slice(),
          anchorId: blockSelection.anchorId,
          focusId: blockSelection.focusId,
        };
      },
      /** 宿主外部触发 AI（与 slash / 面板共用管线） */
      runAi: function (actionId, opts) {
        if (!aiController) {
          return Promise.resolve({ ok: false, error: 'no port' });
        }
        return aiController.run(actionId, opts);
      },
      abortAi: function () {
        if (aiController) aiController.abort();
      },
      openCommandPalette: function (q) {
        if (cmdPalette) cmdPalette.open(q);
      },
      aiEnabled: aiEnabled,
    };
  }

  window.MdxEditor = { createEditor: createEditor };
})();
