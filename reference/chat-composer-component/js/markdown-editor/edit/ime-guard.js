/**
 * markdown-editor/edit/ime-guard.js
 * F-CORE-09：IME composition 防护。
 *
 * composition 期间禁止 onSafeInput（及由此触发的 promote / demote / leave morph）。
 *
 *   var guard = MdxImeGuard.attach(editEl, {
 *     onSafeInput: function (e) { ... },  // 仅非组字时调用
 *     onCompositionEnd: function (e) { ... }  // 可选：end 后再扫一次
 *   });
 *   guard.isComposing(); // boolean
 *   guard.destroy();
 */
(function () {
  'use strict';

  /**
   * @param {HTMLElement} editEl contenteditable / textarea / pre
   * @param {{
   *   onSafeInput?: (e: Event) => void,
   *   onCompositionStart?: (e: Event) => void,
   *   onCompositionEnd?: (e: Event) => void,
   *   inputEvent?: string  // 默认 'input'
   * }} [options]
   * @returns {{ destroy: function, isComposing: function(): boolean, getPending: function }}
   */
  function attach(editEl, options) {
    if (!editEl || !editEl.addEventListener) {
      return {
        destroy: function () {},
        isComposing: function () {
          return false;
        },
        getPending: function () {
          return null;
        },
      };
    }

    options = options || {};
    var composing = false;
    var pendingEnd = false;
    var lastInputEvent = null;
    var inputName = options.inputEvent || 'input';
    var destroyed = false;

    function onCompositionStart(e) {
      composing = true;
      pendingEnd = false;
      if (typeof options.onCompositionStart === 'function') {
        options.onCompositionStart(e);
      }
    }

    function onCompositionEnd(e) {
      composing = false;
      pendingEnd = true;
      // compositionend 后浏览器通常还会再发一次 input；
      // 先同步调一次 onSafeInput，保证 end 后立刻可 promote。
      if (typeof options.onSafeInput === 'function') {
        try {
          options.onSafeInput(e);
        } catch (err) {
          /* 宿主错误不拆 guard */
        }
      }
      if (typeof options.onCompositionEnd === 'function') {
        try {
          options.onCompositionEnd(e);
        } catch (err2) {
          /* ignore */
        }
      }
      // 微任务后清 pending，避免紧随的 input 双触发业务（宿主可自防抖）
      pendingEnd = false;
    }

    function onInput(e) {
      // 永不在 composition 中调用 onSafeInput
      if (composing) {
        lastInputEvent = e;
        return;
      }
      // 部分浏览器 e.isComposing 在 end 前仍 true
      if (e && e.isComposing) {
        lastInputEvent = e;
        return;
      }
      lastInputEvent = e;
      if (typeof options.onSafeInput === 'function') {
        options.onSafeInput(e);
      }
    }

    // keydown 辅助：宿主可用 isComposing() 挡 demote；此处只维护状态
    function onKeyDown(e) {
      if (e && e.isComposing) {
        composing = true;
      }
    }

    editEl.addEventListener('compositionstart', onCompositionStart);
    editEl.addEventListener('compositionend', onCompositionEnd);
    editEl.addEventListener(inputName, onInput);
    editEl.addEventListener('keydown', onKeyDown);

    // 兼容：部分 WebView 用 compositionupdate 而不稳定发 start
    function onCompositionUpdate() {
      composing = true;
    }
    editEl.addEventListener('compositionupdate', onCompositionUpdate);

    return {
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        editEl.removeEventListener('compositionstart', onCompositionStart);
        editEl.removeEventListener('compositionend', onCompositionEnd);
        editEl.removeEventListener(inputName, onInput);
        editEl.removeEventListener('keydown', onKeyDown);
        editEl.removeEventListener('compositionupdate', onCompositionUpdate);
        composing = false;
        lastInputEvent = null;
      },
      isComposing: function () {
        return !!composing;
      },
      /** 最近一次 input 事件（调试 / 测试） */
      getPending: function () {
        return lastInputEvent;
      },
      /** 强制结束（如 blur 策略） */
      forceEnd: function () {
        if (!composing) return;
        composing = false;
        if (typeof options.onSafeInput === 'function') {
          options.onSafeInput(lastInputEvent || { type: 'compositionend', forced: true });
        }
      },
    };
  }

  /**
   * 无 DOM 时的轻量状态机（单测 / 非 DOM 路径）
   */
  function createState() {
    var composing = false;
    return {
      start: function () {
        composing = true;
      },
      end: function () {
        composing = false;
      },
      isComposing: function () {
        return composing;
      },
    };
  }

  window.MdxImeGuard = {
    attach: attach,
    createState: createState,
  };
})();
