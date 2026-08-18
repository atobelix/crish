/**
 * markdown-editor/ai/actions.js — AI 写作动作编排
 *
 * 动作：summarize / rewrite / continue / expand / translate
 * 统一走 MdxAiPorts.complete；默认写回策略：插入选区/当前块下方新段落。
 * 支持流式 ghost 预览；完成才提交一条历史；Abort 可取消。
 *
 * Prefix: MdxAiActions
 */
(function () {
  'use strict';

  var ACTION_DEFS = [
    {
      id: 'summarize',
      title: '总结',
      aliases: ['summary', '摘要', '总结'],
      section: 'AI',
      needsSelection: false,
      description: '总结选区或当前上下文，插入下方',
    },
    {
      id: 'rewrite',
      title: '改写',
      aliases: ['rewrite', '改写', '润色'],
      section: 'AI',
      needsSelection: true,
      description: '改写选中文本，插入下方',
    },
    {
      id: 'continue',
      title: '续写',
      aliases: ['continue', '续写', '接着写'],
      section: 'AI',
      needsSelection: false,
      description: '根据上下文续写，插入下方',
    },
    {
      id: 'expand',
      title: '扩写',
      aliases: ['expand', '扩写', 'longer'],
      section: 'AI',
      needsSelection: true,
      description: '扩展选中内容，插入下方',
    },
    {
      id: 'translate',
      title: '翻译',
      aliases: ['translate', '翻译', '中英'],
      section: 'AI',
      needsSelection: true,
      description: '中英互译（简单切换），插入下方',
    },
  ];

  function findDef(id) {
    for (var i = 0; i < ACTION_DEFS.length; i++) {
      if (ACTION_DEFS[i].id === id) return ACTION_DEFS[i];
    }
    return null;
  }

  /**
   * @param {object} ctx
   * @param {() => boolean} ctx.viewOnly
   * @param {() => string} ctx.getSelectionText
   * @param {() => string} ctx.getDocumentMd
   * @param {() => string|null} ctx.getActiveBlockId
   * @param {(text: string, opts?: object) => string|null} ctx.insertParagraphBelow — 返回新块 id
   * @param {(id: string, text: string) => void} [ctx.updateParagraphText]
   * @param {(msg: string) => void} [ctx.announce]
   * @param {() => function|null} ctx.getComplete
   * @param {HTMLElement} [ctx.root]
   * @param {(busy: boolean) => void} [ctx.onBusyChange]
   * @param {() => void} [ctx.flush]
   */
  function createController(ctx) {
    ctx = ctx || {};
    var busy = false;
    var generation = 0;
    var abortCtrl = null;
    var ghostEl = null;
    var destroyed = false;

    function announce(msg) {
      if (typeof ctx.announce === 'function') ctx.announce(msg);
    }

    function setBusy(v) {
      busy = !!v;
      if (ctx.root) {
        if (busy) ctx.root.setAttribute('aria-busy', 'true');
        else ctx.root.removeAttribute('aria-busy');
        ctx.root.classList.toggle('mdx-ai-busy', busy);
      }
      if (typeof ctx.onBusyChange === 'function') ctx.onBusyChange(busy);
    }

    function isBusy() {
      return busy;
    }

    function abort() {
      if (abortCtrl) {
        try {
          abortCtrl.abort();
        } catch (e) {
          /* ignore */
        }
      }
      clearGhost();
      if (busy) {
        setBusy(false);
        announce('已取消');
      }
    }

    function clearGhost() {
      if (ghostEl && ghostEl.parentNode) {
        ghostEl.parentNode.removeChild(ghostEl);
      }
      ghostEl = null;
    }

    function ensureGhost() {
      if (ghostEl) return ghostEl;
      var root = ctx.root;
      if (!root) return null;
      var scroller = root.querySelector('[data-mdx-scroller]') || root;
      ghostEl = document.createElement('div');
      ghostEl.className = 'mdx-ai-ghost';
      ghostEl.setAttribute('aria-live', 'polite');
      ghostEl.innerHTML =
        '<div class="mdx-ai-ghost__label">AI 生成中…</div>' +
        '<div class="mdx-ai-ghost__body" data-mdx-ai-ghost-body></div>' +
        '<span class="mdx-ai-ghost__caret" aria-hidden="true"></span>';
      scroller.appendChild(ghostEl);
      return ghostEl;
    }

    function updateGhost(acc) {
      var g = ensureGhost();
      if (!g) return;
      var body = g.querySelector('[data-mdx-ai-ghost-body]');
      if (body) body.textContent = acc || '';
      try {
        g.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch (e) {
        /* ignore */
      }
    }

    function listActions() {
      var complete = typeof ctx.getComplete === 'function' ? ctx.getComplete() : null;
      if (!complete) return [];
      return ACTION_DEFS.map(function (d) {
        return {
          id: d.id,
          title: d.title,
          aliases: d.aliases.slice(),
          section: d.section,
          needsSelection: d.needsSelection,
          description: d.description,
        };
      });
    }

    /**
     * @param {string} actionId
     * @param {{ selection?: string }} [opts]
     * @returns {Promise<{ ok: boolean, text?: string, error?: string, cancelled?: boolean }>}
     */
    function run(actionId, opts) {
      opts = opts || {};
      if (destroyed) {
        return Promise.resolve({ ok: false, error: 'destroyed' });
      }
      if (ctx.viewOnly && ctx.viewOnly()) {
        announce('只读模式不可使用 AI 写回');
        return Promise.resolve({ ok: false, error: 'viewOnly' });
      }
      var def = findDef(actionId);
      if (!def) {
        return Promise.resolve({ ok: false, error: 'unknown action' });
      }
      var complete = typeof ctx.getComplete === 'function' ? ctx.getComplete() : null;
      if (!complete) {
        // 无宿主端口：不生成任何假文案
        return Promise.resolve({ ok: false, error: 'no-ai-port', reason: 'no-ai-port' });
      }
      if (busy) {
        announce('生成中，请稍候或取消');
        return Promise.resolve({ ok: false, error: 'busy' });
      }

      var selection =
        opts.selection != null
          ? String(opts.selection)
          : typeof ctx.getSelectionText === 'function'
            ? ctx.getSelectionText() || ''
            : '';
      selection = String(selection);

      if (def.needsSelection && !selection.trim()) {
        announce('请先选中文本');
        return Promise.resolve({ ok: false, error: 'need selection' });
      }

      // 续写：若无选区，用当前块/文档末尾作上下文
      if (actionId === 'continue' && !selection.trim()) {
        var md = typeof ctx.getDocumentMd === 'function' ? ctx.getDocumentMd() : '';
        selection = (md || '').slice(-800);
      }
      if (actionId === 'summarize' && !selection.trim()) {
        var md2 = typeof ctx.getDocumentMd === 'function' ? ctx.getDocumentMd() : '';
        selection = (md2 || '').slice(0, 12000);
      }

      var gen = ++generation;
      if (abortCtrl) {
        try {
          abortCtrl.abort();
        } catch (e0) {
          /* ignore */
        }
      }
      abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var signal = abortCtrl ? abortCtrl.signal : undefined;

      setBusy(true);
      clearGhost();
      updateGhost('');

      var Ports = window.MdxAiPorts;
      if (!Ports || typeof Ports.consumeComplete !== 'function') {
        setBusy(false);
        clearGhost();
        return Promise.resolve({ ok: false, error: 'ports missing', reason: 'no-ai-port' });
      }

      var req = {
        action: actionId,
        selection: selection,
        documentMd:
          typeof ctx.getDocumentMd === 'function' ? ctx.getDocumentMd() || '' : '',
        signal: signal,
      };

      // 只转发宿主 complete，绝不在库内合成正文
      var accText = '';
      var rawResult;
      try {
        rawResult = complete(req);
      } catch (callErr) {
        setBusy(false);
        clearGhost();
        return Promise.resolve({
          ok: false,
          error: (callErr && callErr.message) || 'ai-port-error',
          reason: 'ai-port-error',
        });
      }

      return Ports.consumeComplete(rawResult, {
        signal: signal,
        onChunk: function (piece) {
          if (gen !== generation) return;
          accText += piece == null ? '' : String(piece);
          updateGhost(accText);
        },
      })
        .then(function (text) {
          if (gen !== generation) {
            return { ok: false, cancelled: true };
          }
          clearGhost();
          setBusy(false);
          text = text == null ? '' : String(text).trim();
          if (!text) {
            announce('无有效结果');
            return { ok: false, error: 'empty' };
          }
          var newId = null;
          if (typeof ctx.insertParagraphBelow === 'function') {
            newId = ctx.insertParagraphBelow(text, { reason: 'ai:' + actionId });
          }
          announce(successMessage(actionId));
          if (typeof ctx.flush === 'function') ctx.flush();
          return { ok: true, text: text, blockId: newId };
        })
        .catch(function (err) {
          if (gen !== generation) {
            return { ok: false, cancelled: true };
          }
          clearGhost();
          setBusy(false);
          if (err && (err.name === 'AbortError' || /abort/i.test(err.message || ''))) {
            announce('已取消');
            return { ok: false, cancelled: true };
          }
          var msg = (err && err.message) || 'AI 调用失败';
          announce(msg);
          return { ok: false, error: msg };
        });
    }

    function successMessage(actionId) {
      switch (actionId) {
        case 'summarize':
          return '已插入摘要';
        case 'rewrite':
          return '已插入改写';
        case 'continue':
          return '已插入续写';
        case 'expand':
          return '已插入扩写';
        case 'translate':
          return '已插入翻译';
        default:
          return '已插入 AI 结果';
      }
    }

    function destroy() {
      destroyed = true;
      generation += 1;
      abort();
      clearGhost();
    }

    return {
      listActions: listActions,
      run: run,
      abort: abort,
      isBusy: isBusy,
      destroy: destroy,
      defs: ACTION_DEFS,
    };
  }

  window.MdxAiActions = {
    ACTION_DEFS: ACTION_DEFS,
    findDef: findDef,
    createController: createController,
  };
})();
