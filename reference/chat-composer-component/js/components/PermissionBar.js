/**
 * PermissionBar — calm horizontal approval strip above the composer.
 * Never a heavy stream card. Shows first pending item + 「还有 N 条」.
 */
(function () {
  'use strict';

  var FC = (window.FlowComponents = window.FlowComponents || {});

  function esc(s) {
    if (FC.dom && typeof FC.dom.esc === 'function') return FC.dom.esc(s);
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function clip(s, n) {
    s = String(s == null ? '' : s);
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + '…';
  }

  /**
   * @param {Array<{ id: string, summary: string, command?: string, risk?: string, toolName?: string }>} items
   * @param {{ onAllow?: Function, onDeny?: Function, onAlways?: Function }} [callbacks]
   * @returns {HTMLElement}
   */
  function render(items, callbacks) {
    callbacks = callbacks || {};
    items = Array.isArray(items) ? items.slice() : [];

    var bar = document.createElement('div');
    bar.className = 'flow-permission-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', '权限确认');

    if (!items.length) {
      var emptyBar = document.createElement('div');
      emptyBar.className = 'flow-permission-bar is-empty';
      emptyBar.style.display = 'none';
      emptyBar.hidden = true;
      return emptyBar;
    }

    var item = items[0];
    var rest = items.length - 1;

    // Line 1: Summary (left) + Badge & More count (right)
    var line1 = document.createElement('div');
    line1.className = 'flow-permission-bar__line1';

    var summary = document.createElement('span');
    summary.className = 'flow-permission-bar__summary';
    summary.textContent = item.summary || item.toolName || '需要批准的操作';
    summary.title = item.summary || '';

    var metaRight = document.createElement('div');
    metaRight.className = 'flow-permission-bar__meta-right';

    var riskKey = (item.risk || 'medium').toLowerCase();
    var riskText = riskKey === 'high' ? '高风险' : riskKey === 'low' ? '低风险' : '中风险';

    var label = document.createElement('span');
    label.className = 'flow-permission-bar__badge flow-permission-bar__label';
    label.dataset.risk = riskKey;
    label.textContent = riskText;

    // High-end Live 5-Minute Countdown Timer with Per-Digit Independent Slot Machine Rolling & Timing Color Stages
    var timerSpan = document.createElement('div');
    timerSpan.className = 'flow-permission-bar__timer slot-timer';

    var secondsLeft = 300; // Default 5 minutes (300s)

    function formatTimeStr(sec) {
      if (sec < 0) sec = 0;
      var m = Math.floor(sec / 60);
      var s = sec % 60;
      return m + ':' + (s < 10 ? '0' + s : s);
    }

    var prevStr = formatTimeStr(secondsLeft);
    var digitsWrapper = document.createElement('div');
    digitsWrapper.className = 'slot-digits-wrapper';

    function buildSlots(str) {
      digitsWrapper.innerHTML = '';
      for (var i = 0; i < str.length; i++) {
        var ch = str[i];
        var box = document.createElement('span');
        box.className = 'slot-digit-box';
        if (ch === ':') {
          box.className += ' slot-colon';
          box.textContent = ':';
        } else {
          var track = document.createElement('div');
          track.className = 'slot-track';
          var oldNum = document.createElement('span');
          oldNum.className = 'slot-num slot-old';
          oldNum.textContent = ch;
          var newNum = document.createElement('span');
          newNum.className = 'slot-num slot-new';
          newNum.textContent = ch;
          track.appendChild(oldNum);
          track.appendChild(newNum);
          box.appendChild(track);
        }
        digitsWrapper.appendChild(box);
      }
    }

    buildSlots(prevStr);
    timerSpan.appendChild(digitsWrapper);

    function updateTimerUI(sec) {
      var currStr = formatTimeStr(sec);

      if (currStr.length !== prevStr.length) {
        buildSlots(currStr);
        prevStr = currStr;
      } else {
        var boxes = digitsWrapper.children;
        for (var i = 0; i < currStr.length; i++) {
          var newCh = currStr[i];
          var box = boxes[i];
          if (newCh !== ':') {
            var track = box.querySelector('.slot-track');
            if (track) {
              var oldNum = track.querySelector('.slot-old');
              var newNum = track.querySelector('.slot-new');
              if (newNum.textContent !== newCh) {
                oldNum.textContent = newNum.textContent;
                newNum.textContent = newCh;

                // Roll ONLY this specific changed digit box!
                track.classList.remove('is-rolling');
                void track.offsetWidth; // Force reflow
                track.classList.add('is-rolling');
              }
            }
          }
        }
        prevStr = currStr;
      }

      // Timing Color Stages (5m default):
      // 2m (120s): Solid Orange
      // 1m (60s): Amber Flash
      // 30s: Red Flash Alert
      timerSpan.classList.remove('is-orange', 'is-warning-flash', 'is-expired');
      if (sec <= 30) {
        timerSpan.classList.add('is-expired');
      } else if (sec <= 60) {
        timerSpan.classList.add('is-warning-flash');
      } else if (sec <= 120) {
        timerSpan.classList.add('is-orange');
      }
    }

    var intervalId = setInterval(function () {
      secondsLeft--;
      if (!bar.parentNode || bar.classList.contains('is-resolved')) {
        clearInterval(intervalId);
        return;
      }
      if (secondsLeft <= 0) {
        clearInterval(intervalId);
        updateTimerUI(0);
      } else {
        updateTimerUI(secondsLeft);
      }
    }, 1000);

    metaRight.appendChild(timerSpan);

    if (rest > 0) {
      var more = document.createElement('span');
      more.className = 'flow-permission-bar__more';
      more.textContent = '还有 ' + rest + ' 条';
      more.title = '队列中还有 ' + rest + ' 条待确认';
      metaRight.appendChild(more);
    }

    var titleGroup = document.createElement('div');
    titleGroup.className = 'flow-permission-bar__title-group';
    titleGroup.appendChild(summary);
    titleGroup.appendChild(label);

    line1.appendChild(titleGroup);
    line1.appendChild(metaRight);

    // Line 2: Code Command (left) + Actions Cluster (right)
    var line2 = document.createElement('div');
    line2.className = 'flow-permission-bar__line2';

    if (item.command) {
      var cmd = document.createElement('code');
      cmd.className = 'flow-permission-bar__cmd';
      cmd.textContent = item.command;
      cmd.title = item.command;
      line2.appendChild(cmd);
    } else {
      var spacer = document.createElement('span');
      spacer.className = 'flow-permission-bar__spacer';
      line2.appendChild(spacer);
    }

    var actions = document.createElement('div');
    actions.className = 'flow-permission-bar__actions';

    function resolve(kind) {
      var id = item.id;
      // 0ms Optimistic UI Update: Stop timer & disable duplicate clicks instantly
      clearInterval(intervalId);
      bar.classList.add('is-resolved');
      bar.dataset.resolved = kind;
      actions.style.pointerEvents = 'none';

      var msg =
        kind === 'deny' ? '已拒绝' : kind === 'always' ? '已始终允许' : '已批准';
      actions.innerHTML =
        '<span class="flow-permission-bar__resolved" style="font-size: 12px; font-weight: 500; color: var(--text-secondary); animation: cardEntrance 120ms ease;">' + esc(msg) + '</span>';

      // 0ms Instant callback execution
      var cb =
        kind === 'deny'
          ? callbacks.onDeny
          : kind === 'always'
            ? callbacks.onAlways
            : callbacks.onAllow;
      if (typeof cb === 'function') cb(id, item);

      // Fast 80ms smooth transition to unmount or draw next queue item
      setTimeout(function () {
        if (bar.parentNode && typeof callbacks.onResolved === 'function') {
          callbacks.onResolved(id, kind, item);
        }
      }, 80);
    }

    var btnDeny = document.createElement('button');
    btnDeny.type = 'button';
    btnDeny.className = 'flow-permission-bar__btn flow-permission-bar__btn--deny';
    btnDeny.textContent = '拒绝';
    btnDeny.addEventListener('click', function () {
      resolve('deny');
    });

    var btnAllow = document.createElement('button');
    btnAllow.type = 'button';
    btnAllow.className = 'flow-permission-bar__btn flow-permission-bar__btn--allow';
    btnAllow.textContent = '批准';
    btnAllow.addEventListener('click', function () {
      resolve('allow');
    });

    var btnAlways = document.createElement('button');
    btnAlways.type = 'button';
    btnAlways.className = 'flow-permission-bar__btn flow-permission-bar__btn--always';
    btnAlways.textContent = '始终允许';
    btnAlways.addEventListener('click', function () {
      resolve('always');
    });

    actions.appendChild(btnDeny);
    actions.appendChild(btnAllow);
    actions.appendChild(btnAlways);
    line2.appendChild(actions);

    bar.appendChild(line1);
    bar.appendChild(line2);

    if (item.id) bar.dataset.id = item.id;
    if (item.risk) bar.dataset.risk = item.risk;
    bar.dataset.count = String(items.length);

    return bar;
  }

  /**
   * Mount (or replace) the permission bar inside hostEl.
   * @param {HTMLElement} hostEl
   * @param {{
   *   items?: Array,
   *   onAllow?: Function,
   *   onDeny?: Function,
   *   onAlways?: Function,
   *   onResolved?: Function
   * }} options
   * @returns {{ el: HTMLElement, update: Function, destroy: Function }}
   */
  function mount(hostEl, options) {
    options = options || {};
    if (!hostEl) throw new Error('PermissionBar.mount: hostEl required');

    var currentItems = Array.isArray(options.items) ? options.items.slice() : [];
    var callbacks = {
      onAllow: options.onAllow,
      onDeny: options.onDeny,
      onAlways: options.onAlways,
      onResolved: function (id, kind, item) {
        // drop resolved item and re-render queue
        currentItems = currentItems.filter(function (it) {
          return it.id !== id;
        });
        redraw();
        if (typeof options.onResolved === 'function') {
          options.onResolved(id, kind, item);
        }
      },
    };

    var el = null;

    function redraw() {
      if (!currentItems || !currentItems.length) {
        if (el && el.parentNode) {
          el.parentNode.removeChild(el);
        }
        el = null;
        return null;
      }
      var next = render(currentItems, callbacks);
      if (el && el.parentNode) {
        el.parentNode.replaceChild(next, el);
      } else if (hostEl) {
        hostEl.appendChild(next);
      }
      el = next;
      return el;
    }

    el = redraw();

    return {
      el: el,
      update: function (items) {
        currentItems = Array.isArray(items) ? items.slice() : [];
        return redraw();
      },
      getItems: function () {
        return currentItems.slice();
      },
      destroy: function () {
        if (el && el.parentNode) el.parentNode.removeChild(el);
        el = null;
        currentItems = [];
      },
    };
  }

  FC.PermissionBar = {
    render: render,
    mount: mount,
  };
})();
