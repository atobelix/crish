/**
 * file-preview/shell/focus-trap.js — 简易焦点陷阱
 */
(function () {
  'use strict';

  var SELECTOR =
    'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function getFocusable(root) {
    if (!root) return [];
    return Array.prototype.slice
      .call(root.querySelectorAll(SELECTOR))
      .filter(function (el) {
        return el.offsetParent !== null || el === document.activeElement;
      });
  }

  /**
   * @param {HTMLElement} root
   * @returns {{ activate: function, deactivate: function }}
   */
  function createFocusTrap(root) {
    var prev = null;
    var onKey = null;

    return {
      activate: function () {
        prev = document.activeElement;
        onKey = function (e) {
          if (e.key !== 'Tab') return;
          var list = getFocusable(root);
          if (!list.length) {
            e.preventDefault();
            return;
          }
          var first = list[0];
          var last = list[list.length - 1];
          if (e.shiftKey) {
            if (document.activeElement === first || !root.contains(document.activeElement)) {
              e.preventDefault();
              last.focus();
            }
          } else {
            if (document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        };
        document.addEventListener('keydown', onKey, true);
        var list = getFocusable(root);
        if (list[0]) list[0].focus();
        else if (root) {
          root.setAttribute('tabindex', '-1');
          root.focus();
        }
      },
      deactivate: function () {
        if (onKey) document.removeEventListener('keydown', onKey, true);
        onKey = null;
        if (prev && typeof prev.focus === 'function') {
          try {
            prev.focus();
          } catch (e) {
            /* ignore */
          }
        }
        prev = null;
      },
    };
  }

  window.FilePreviewFocusTrap = { create: createFocusTrap };
})();
