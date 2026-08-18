/**
 * markdown-editor/edit/height-lock.js
 * F-CORE-03：高度锁定 / 滚动位置保持，防止行源码 enter/leave 时文档跳动。
 *
 * 用法：
 *   MdxHeightLock.lock(blockEl)           // 替换内容前锁定 min-height
 *   MdxHeightLock.unlock(blockEl)         // 双 rAF 后释放（或立即）
 *   MdxHeightLock.withScrollPreserve(scroller, fn)
 */
(function () {
  'use strict';

  var ATTR = 'data-mdx-height-lock';
  var CLASS = 'mdx-height-locked';
  /** WeakMap 不可用时退到 data 属性 */
  var lockMap = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  function measureHeight(el) {
    if (!el) return 0;
    var h = el.offsetHeight;
    if (h > 0) return h;
    try {
      var r = el.getBoundingClientRect();
      return r && r.height ? r.height : 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 锁定元素最小高度：取当前 offsetHeight，写入 style.minHeight。
   * 优先锁块根；若传入 content 子节点也可。
   * @param {HTMLElement} el
   * @param {{ minPx?: number }} [opts]
   * @returns {number} 锁定的像素高度
   */
  function lock(el, opts) {
    if (!el || !el.style) return 0;
    opts = opts || {};
    var prev = 0;
    var prevMinStyle = el.style.minHeight || '';
    if (lockMap && lockMap.has(el)) {
      prev = lockMap.get(el).px || 0;
    } else if (el.getAttribute && el.getAttribute(ATTR)) {
      prev = parseFloat(el.getAttribute(ATTR)) || 0;
    }
    var measured = measureHeight(el);
    var px = Math.max(measured, prev, opts.minPx || 0);
    if (px <= 0) return 0;

    el.style.minHeight = px + 'px';
    if (el.classList) el.classList.add(CLASS);
    if (el.setAttribute) el.setAttribute(ATTR, String(px));
    if (lockMap) {
      lockMap.set(el, { px: px, prevMin: prevMinStyle });
    }
    return px;
  }

  /**
   * 释放 min-height。默认双 rAF 后再清，避免 leave 瞬间闪缩。
   * @param {HTMLElement} el
   * @param {{ immediate?: boolean, afterPaint?: boolean }} [opts]
   *   afterPaint（默认 true）：先再测一次并 raise，再解锁，减少换壳后跳变
   */
  function unlock(el, opts) {
    if (!el || !el.style) return;
    opts = opts || {};

    function clear() {
      if (!el || !el.style) return;
      el.style.minHeight = '';
      if (el.classList) el.classList.remove(CLASS);
      if (el.removeAttribute) el.removeAttribute(ATTR);
      if (lockMap) lockMap.delete(el);
    }

    if (opts.immediate) {
      clear();
      return;
    }

    // 内容已替换时：抬到当前高度，避免「先锁矮再突然变高」
    if (opts.afterPaint !== false) {
      try {
        raise(el, measureHeight(el));
      } catch (eRaise) {
        /* ignore */
      }
    }

    // 双 rAF：等布局/绘制稳定后再 unlock（F-CORE-03 验收）
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () {
        // 再抬一次：字体/图片/inline 可能二次布局
        if (opts.afterPaint !== false) {
          try {
            raise(el, measureHeight(el));
          } catch (e2) {
            /* ignore */
          }
        }
        requestAnimationFrame(clear);
      });
    } else {
      setTimeout(clear, 32);
    }
  }

  /**
   * lock → fn → raise(新高度) → unlock，进出软编辑一站式。
   * @param {HTMLElement} el
   * @param {function(): *} fn
   * @returns {*}
   */
  function around(el, fn) {
    lock(el);
    var result;
    try {
      result = typeof fn === 'function' ? fn() : undefined;
    } finally {
      raise(el, measureHeight(el));
      unlock(el);
    }
    return result;
  }

  /**
   * 在 scroller 上保存 scrollTop，执行 fn，再恢复（补偿中间布局变化）。
   * @param {HTMLElement|Window|null} scrollerEl
   * @param {function(): *} fn
   * @returns {*} fn 返回值
   */
  function withScrollPreserve(scrollerEl, fn) {
    var isWin = !scrollerEl || scrollerEl === window;
    var top = 0;
    var left = 0;

    if (isWin) {
      top =
        window.pageYOffset != null
          ? window.pageYOffset
          : (document.documentElement && document.documentElement.scrollTop) ||
            (document.body && document.body.scrollTop) ||
            0;
      left =
        window.pageXOffset != null
          ? window.pageXOffset
          : (document.documentElement && document.documentElement.scrollLeft) ||
            (document.body && document.body.scrollLeft) ||
            0;
    } else {
      top = scrollerEl.scrollTop || 0;
      left = scrollerEl.scrollLeft || 0;
    }

    var result;
    try {
      result = typeof fn === 'function' ? fn() : undefined;
    } finally {
      if (isWin) {
        if (typeof window.scrollTo === 'function') {
          window.scrollTo(left, top);
        } else {
          if (document.documentElement) {
            document.documentElement.scrollTop = top;
            document.documentElement.scrollLeft = left;
          }
          if (document.body) {
            document.body.scrollTop = top;
            document.body.scrollLeft = left;
          }
        }
      } else if (scrollerEl) {
        scrollerEl.scrollTop = top;
        scrollerEl.scrollLeft = left;
      }
    }
    return result;
  }

  /**
   * 可选：在 lock 状态下把 min-height 抬到至少 newPx（内容变高时）。
   */
  function raise(el, newPx) {
    if (!el || !el.style || !(newPx > 0)) return 0;
    var cur = 0;
    if (lockMap && lockMap.has(el)) cur = lockMap.get(el).px || 0;
    else if (el.getAttribute) cur = parseFloat(el.getAttribute(ATTR)) || 0;
    var px = Math.max(cur, newPx, measureHeight(el));
    el.style.minHeight = px + 'px';
    if (el.setAttribute) el.setAttribute(ATTR, String(px));
    if (lockMap) lockMap.set(el, { px: px });
    if (el.classList) el.classList.add(CLASS);
    return px;
  }

  function isLocked(el) {
    if (!el) return false;
    if (lockMap && lockMap.has(el)) return true;
    return !!(el.getAttribute && el.getAttribute(ATTR));
  }

  window.MdxHeightLock = {
    lock: lock,
    unlock: unlock,
    raise: raise,
    around: around,
    isLocked: isLocked,
    withScrollPreserve: withScrollPreserve,
    measureHeight: measureHeight,
  };
})();
