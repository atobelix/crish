/**
 * ThinkingBlock — Illustrator style
 * Done:  思考了 3 秒 >
 * Live:  思考中 · 3秒  (seconds tick like slot machine)
 * Expand: body with top/bottom fade when overflowing
 */
(function () {
  'use strict';

  window.FlowComponents = window.FlowComponents || {};

  function parseElapsedSeconds(node) {
    if (node.elapsed != null && node.elapsed !== '') {
      var s = String(node.elapsed).trim();
      var m = s.match(/^([\d.]+)\s*s$/i);
      if (m) return parseFloat(m[1]);
      var m2 = s.match(/^([\d.]+)/);
      if (m2) return parseFloat(m2[1]);
    }
    if (node.elapsedMs != null && !isNaN(Number(node.elapsedMs))) {
      return Number(node.elapsedMs) / 1000;
    }
    return null;
  }

  function formatSec(sec) {
    if (sec == null || isNaN(sec)) return '';
    if (sec < 10) {
      var r = Math.round(sec * 10) / 10;
      return r % 1 === 0 ? String(Math.round(r)) : r.toFixed(1);
    }
    return String(Math.round(sec));
  }

  function render(node, opts) {
    opts = opts || {};
    node = node || {};
    var dom = window.FlowComponents.dom;
    var el = dom.el;

    var open = !!opts.initiallyOpen;
    var live = !!(node.live || node.status === 'running');
    var sec = parseElapsedSeconds(node);
    if (sec == null && live) sec = 0;
    if (sec == null) sec = 0;

    var root = el('div', 'flow-thinking' + (live ? ' is-live' : '') + (open ? ' is-open' : ''), {
      'data-id': node.id || '',
      'data-kind': 'thinking',
      'data-status': live ? 'running' : 'done',
    });

    var head = el('button', 'flow-thinking__head', {
      type: 'button',
      'aria-expanded': open ? 'true' : 'false',
    });

    var tick = el('span', 'flow-thinking__tick flow-thinking__elapsed');
    var tickNum = el('span', 'flow-thinking__tick-num flow-num-unit');
    var tickSuffix = el('span', 'flow-thinking__tick-suffix', { textContent: '秒' });
    tick.appendChild(tickNum);
    tick.appendChild(tickSuffix);

    var chev = el('span', 'flow-thinking__chevron', { 'aria-hidden': 'true' });
    chev.innerHTML = dom.chevronSvg();

    var lastRenderedSecStr = '';

    function updateNum(valStr) {
      if (valStr === lastRenderedSecStr) return;
      lastRenderedSecStr = valStr;
      tickNum.textContent = valStr;
    }

    function paintHead() {
      head.innerHTML = '';
      if (live) {
        head.appendChild(el('span', 'flow-thinking__live-label flow-shimmer-text', { textContent: '思考中' }));
        head.appendChild(el('span', 'flow-thinking__sep', { textContent: '·', 'aria-hidden': 'true' }));
        updateNum(formatSec(sec));
        tickSuffix.textContent = '秒';
        head.appendChild(tick);
      } else {
        head.appendChild(el('span', 'flow-thinking__label', { textContent: '思考了' }));
        head.appendChild(document.createTextNode(' '));
        updateNum(formatSec(sec));
        tickSuffix.textContent = ' 秒';
        head.appendChild(tick);
        head.appendChild(chev);
      }
    }

    paintHead();
    root.appendChild(head);

    var acc = el('div', 'flow-acc flow-thinking__acc', {
      'data-open': open ? 'true' : 'false',
    });
    var inner = el('div', 'flow-acc__inner');
    var fade = el('div', 'flow-thinking__fade');
    var body = el('div', 'flow-thinking__body flow-scroll-nested', { title: '点击收起' });
    body.textContent = node.content || '';
    fade.appendChild(body);
    inner.appendChild(fade);
    acc.appendChild(inner);
    root.appendChild(acc);

    function refreshFade() {
      if (dom.updateOverflowFade) dom.updateOverflowFade(fade, body);
    }

    dom.setOpen(acc, open);
    dom.bindToggle(head, acc, function (next) {
      root.classList.toggle('is-open', next);
      if (next) requestAnimationFrame(refreshFade);
    });

    if (dom.bindOverflowFade) {
      dom.bindOverflowFade(fade, body);
    }

    body.addEventListener('click', function () {
      if (acc.getAttribute('data-open') === 'true') {
        dom.setOpen(acc, false);
        head.setAttribute('aria-expanded', 'false');
        root.classList.remove('is-open');
      }
    });

    /* Live second ticker (smooth 200ms RAF-synchronized interval) */
    var timer = null;
    if (live) {
      var started =
        typeof node.startedAt === 'number'
          ? node.startedAt
          : Date.now() - (sec || 0) * 1000;
      timer = setInterval(function () {
        if (!root.isConnected) {
          clearInterval(timer);
          return;
        }
        sec = (Date.now() - started) / 1000;
        updateNum(formatSec(sec));
      }, 200);
      root._flowTickClear = function () {
        if (timer) clearInterval(timer);
      };
    }

    /**
     * Smoothly settle the thinking block into completed state.
     * @param {number} [finalSec]
     */
    root.settle = function (finalSec) {
      if (timer) clearInterval(timer);
      if (typeof finalSec === 'number') sec = finalSec;
      live = false;
      root.classList.remove('is-live');
      root.dataset.status = 'done';
      paintHead();
    };

    if (open) requestAnimationFrame(refreshFade);

    return root;
  }

  window.FlowComponents.ThinkingBlock = { render: render };
})();
