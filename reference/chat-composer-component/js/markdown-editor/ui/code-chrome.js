/**
 * markdown-editor/ui/code-chrome.js
 * Code block chrome helpers (F-CODE-COPY): copy body text, no enter-edit.
 *
 * Exports window.MdxCodeChrome:
 *   bindCopy(btn, getText) → unbind()
 *   writeClipboard(text) → Promise<boolean>
 *   bodyTextFromCard(card) → string
 *   installDelegate(root?)  // capture click for [data-mdx-code-copy]
 */
(function () {
  'use strict';

  var LABEL_COPY = '复制';
  var LABEL_COPIED = '已复制';
  var COPIED_MS = 1200;
  var boundFlag = 'mdxCopyBound';
  var delegateInstalled = false;

  function bodyTextFromCard(card) {
    if (!card) return '';
    // 折叠预览时 code 仅可见行；优先全文 stash（F-CODE-FOLD + F-CODE-COPY）
    var stash = card.querySelector('[data-mdx-code-full]');
    if (stash) {
      return (stash.textContent || stash.innerText || '').replace(/\u00a0/g, ' ');
    }
    var mode = card.getAttribute('data-mode') || '';
    var code = card.querySelector(
      '.mdx-code-card__code, .mdx-code-card__pre > code, pre.mdx-code-card__pre > code'
    );
    if (code && mode !== 'source') {
      return (code.innerText || code.textContent || '').replace(/\u00a0/g, ' ');
    }
    var pre = card.querySelector('.mdx-code-source-pre, [data-mdx-edit]');
    if (pre) {
      var raw = (pre.innerText || pre.textContent || '').replace(/\u00a0/g, ' ');
      return raw.replace(/^```[^\n]*\n?/, '').replace(/\n```\s*$/, '');
    }
    if (code) {
      return (code.innerText || code.textContent || '').replace(/\u00a0/g, ' ');
    }
    return '';
  }

  function writeClipboard(text) {
    text = text == null ? '' : String(text);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).then(
        function () {
          return true;
        },
        function () {
          return fallbackCopy(text);
        }
      );
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  function setCopiedState(btn, ok) {
    if (!btn) return;
    if (btn._mdxCopyTimer) {
      clearTimeout(btn._mdxCopyTimer);
      btn._mdxCopyTimer = null;
    }
    var prev = btn.getAttribute('data-label') || btn.textContent || LABEL_COPY;
    if (!btn.getAttribute('data-label')) {
      btn.setAttribute('data-label', prev.trim() || LABEL_COPY);
    }
    if (ok) {
      btn.classList.add('is-copied');
      btn.textContent = LABEL_COPIED;
      btn.setAttribute('aria-label', LABEL_COPIED);
      btn._mdxCopyTimer = setTimeout(function () {
        btn.classList.remove('is-copied');
        var restore = btn.getAttribute('data-label') || LABEL_COPY;
        btn.textContent = restore;
        btn.setAttribute('aria-label', '复制代码');
        btn._mdxCopyTimer = null;
      }, COPIED_MS);
    }
  }

  /**
   * @param {HTMLElement} btn
   * @param {() => string} getText
   * @returns {() => void}
   */
  function bindCopy(btn, getText) {
    if (!btn || typeof getText !== 'function') {
      return function () {};
    }
    if (btn._mdxCopyBound || (btn.dataset && btn.dataset[boundFlag] === '1')) {
      return function () {};
    }
    btn._mdxCopyBound = true;
    if (btn.dataset) btn.dataset[boundFlag] = '1';

    if (!btn.getAttribute('aria-label')) {
      btn.setAttribute('aria-label', '复制代码');
    }
    if (!btn.getAttribute('type')) {
      btn.setAttribute('type', 'button');
    }

    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();
      var text = '';
      try {
        text = getText() || '';
      } catch (err) {
        text = '';
      }
      writeClipboard(text).then(function (ok) {
        setCopiedState(btn, ok);
      });
    }

    btn.addEventListener('click', onClick);
    return function unbind() {
      btn.removeEventListener('click', onClick);
      btn._mdxCopyBound = false;
      if (btn.dataset) delete btn.dataset[boundFlag];
      if (btn._mdxCopyTimer) {
        clearTimeout(btn._mdxCopyTimer);
        btn._mdxCopyTimer = null;
      }
    };
  }

  /**
   * Capture-phase delegate so copy never enters focus-source (F-CODE-COPY).
   * @param {ParentNode} [root]
   */
  function installDelegate(root) {
    if (delegateInstalled && !root) return;
    var target = root || document;
    if (!root) delegateInstalled = true;

    target.addEventListener(
      'click',
      function (e) {
        var el = e.target;
        if (!el || !el.closest) return;
        var btn = el.closest('[data-mdx-code-copy]');
        if (!btn) return;
        // Explicit bindCopy / blocks.bindCopy already owns the button
        if (btn._mdxCopyBound) return;
        if (btn.dataset && btn.dataset[boundFlag] === '1') return;

        e.preventDefault();
        e.stopPropagation();

        var card =
          btn.closest('[data-mdx-code-card]') ||
          btn.closest('.mdx-code-card') ||
          null;
        var text = bodyTextFromCard(card);
        writeClipboard(text).then(function (ok) {
          setCopiedState(btn, ok);
        });
      },
      true
    );
  }

  // Default: global capture so read-card copy works without editor wiring
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        installDelegate();
      });
    } else {
      installDelegate();
    }
  }

  window.MdxCodeChrome = {
    bindCopy: bindCopy,
    writeClipboard: writeClipboard,
    bodyTextFromCard: bodyTextFromCard,
    installDelegate: installDelegate,
  };
})();
