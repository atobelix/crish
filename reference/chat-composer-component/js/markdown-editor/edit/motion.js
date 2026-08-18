/**
 * markdown-editor/edit/motion.js
 * W9 motion helper — prefers-reduced-motion + enter/leave class helpers.
 *
 *   MdxMotion.prefersReducedMotion() → boolean
 *   MdxMotion.runEnter(el, { className?, durationMs? }) → Promise
 *   MdxMotion.runLeave(el, { className?, durationMs? }) → Promise
 *   MdxMotion.motionMs(kind) → number   // 'fast' | 'med' | 'md' | 'lg' | …
 *
 * Does not touch height-lock; callers should MdxHeightLock.lock before morph.
 */
(function () {
  'use strict';

  var MQ = '(prefers-reduced-motion: reduce)';
  var cached = null;
  var mqList = null;

  function bindMq() {
    if (mqList || typeof window === 'undefined' || !window.matchMedia) return;
    try {
      mqList = window.matchMedia(MQ);
      cached = !!mqList.matches;
      var onChange = function () {
        cached = !!mqList.matches;
      };
      if (typeof mqList.addEventListener === 'function') {
        mqList.addEventListener('change', onChange);
      } else if (typeof mqList.addListener === 'function') {
        mqList.addListener(onChange);
      }
    } catch (e) {
      cached = false;
    }
  }

  /**
   * @returns {boolean}
   */
  function prefersReducedMotion() {
    if (cached !== null) return cached;
    bindMq();
    if (cached !== null) return cached;
    try {
      return !!(window.matchMedia && window.matchMedia(MQ).matches);
    } catch (e) {
      return false;
    }
  }

  /**
   * Read a motion duration token from an element (or .mdx-root).
   * @param {'fast'|'med'|'xs'|'sm'|'md'|'lg'|'xl'|'panel'|string} kind
   * @param {Element} [el]
   * @returns {number} milliseconds
   */
  function motionMs(kind, el) {
    if (prefersReducedMotion()) return 0;
    var map = {
      fast: '--mdx-motion-fast',
      med: '--mdx-motion-med',
      xs: '--mdx-motion-xs',
      sm: '--mdx-motion-sm',
      md: '--mdx-motion-md',
      lg: '--mdx-motion-lg',
      xl: '--mdx-motion-xl',
      panel: '--mdx-motion-panel',
    };
    var prop = map[kind] || kind;
    if (prop.charAt(0) !== '-') prop = '--mdx-motion-' + prop;
    var node =
      el ||
      (typeof document !== 'undefined' &&
        (document.querySelector('.mdx-root, .mdx-editor') || document.documentElement));
    if (!node || typeof getComputedStyle === 'undefined') {
      return kind === 'med' || kind === 'xl' ? 180 : 120;
    }
    var raw = getComputedStyle(node).getPropertyValue(prop).trim();
    if (!raw) return kind === 'med' || kind === 'xl' ? 180 : 120;
    if (raw.indexOf('ms') !== -1) return parseFloat(raw) || 0;
    if (raw.indexOf('s') !== -1) return (parseFloat(raw) || 0) * 1000;
    return parseFloat(raw) || 0;
  }

  function waitAnimation(el, fallbackMs) {
    return new Promise(function (resolve) {
      if (!el || prefersReducedMotion()) {
        resolve();
        return;
      }
      var done = false;
      var timer = null;
      function finish() {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        el.removeEventListener('animationend', onEnd);
        el.removeEventListener('transitionend', onEnd);
        resolve();
      }
      function onEnd(e) {
        if (e && e.target !== el) return;
        finish();
      }
      el.addEventListener('animationend', onEnd);
      el.addEventListener('transitionend', onEnd);
      timer = setTimeout(finish, Math.max(0, (fallbackMs || 200) + 50));
    });
  }

  /**
   * @param {HTMLElement} el
   * @param {{ className?: string, durationMs?: number }} [opts]
   * @returns {Promise<void>}
   */
  function runEnter(el, opts) {
    opts = opts || {};
    var cls = opts.className || 'mdx-block--enter';
    if (!el || !el.classList) return Promise.resolve();
    if (prefersReducedMotion()) {
      el.classList.remove(cls);
      return Promise.resolve();
    }
    el.classList.remove(cls);
    // force reflow so re-adding restarts animation
    void el.offsetWidth;
    el.classList.add(cls);
    var ms = opts.durationMs != null ? opts.durationMs : motionMs('md', el);
    return waitAnimation(el, ms).then(function () {
      if (el && el.classList) el.classList.remove(cls);
    });
  }

  /**
   * @param {HTMLElement} el
   * @param {{ className?: string, durationMs?: number }} [opts]
   * @returns {Promise<void>}
   */
  function runLeave(el, opts) {
    opts = opts || {};
    var cls = opts.className || 'mdx-block--leave';
    if (!el || !el.classList) return Promise.resolve();
    if (prefersReducedMotion()) {
      el.classList.remove(cls);
      return Promise.resolve();
    }
    el.classList.add(cls);
    var ms = opts.durationMs != null ? opts.durationMs : motionMs('lg', el);
    return waitAnimation(el, ms);
  }

  window.MdxMotion = {
    prefersReducedMotion: prefersReducedMotion,
    motionMs: motionMs,
    runEnter: runEnter,
    runLeave: runLeave,
  };
})();
