/**
 * PurposeBlock — left cluster primary + secondary/status; chevron after (hidden when running)
 */
(function () {
  'use strict';

  window.FlowComponents = window.FlowComponents || {};

  function anyActionRunning(actions) {
    if (!actions || !actions.length) return false;
    for (var i = 0; i < actions.length; i++) {
      if (actions[i] && actions[i].status === 'running') return true;
    }
    return false;
  }

  function currentActionLabel(actions) {
    if (!actions || !actions.length) return '';
    var running = null;
    var last = null;
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      if (!a) continue;
      last = a;
      if (a.status === 'running') running = a;
    }
    var pick = running || last;
    if (!pick) return '';
    var parts = [];
    if (pick.status === 'running') {
      if (pick.verb) parts.push(pick.verb.indexOf('正在') === 0 ? pick.verb : '正在' + (pick.verb || '执行'));
      else parts.push('正在执行');
    } else if (pick.verb) {
      parts.push(pick.verb);
    }
    if (pick.objectLabel) parts.push(pick.objectLabel);
    else if (pick.path) {
      var s = String(pick.path).replace(/\\/g, '/');
      var segs = s.split('/');
      parts.push(segs[segs.length - 1] || pick.path);
    }
    return parts.join(' ');
  }

  function render(node, opts) {
    opts = opts || {};
    node = node || {};
    var dom = window.FlowComponents.dom;
    var el = dom.el;

    var actions = node.actions || [];
    var secondary = node.secondary || [];
    var running = node.status === 'running' || anyActionRunning(actions);
    var open = !!opts.initiallyOpen;

    var rootCls = 'flow-purpose';
    if (running) rootCls += ' is-running';
    if (node.status === 'error') rootCls += ' is-error';
    if (open) rootCls += ' is-open';

    var root = el('div', rootCls, {
      'data-id': node.id || '',
      'data-kind': 'purpose',
      'data-status': running ? 'running' : node.status || 'success',
    });

    var head = el('button', 'flow-purpose__head', {
      type: 'button',
      'aria-expanded': open ? 'true' : 'false',
    });

    head.appendChild(
      el('span', 'flow-purpose__primary', {
        textContent: node.primary || '',
      })
    );

    var rollerText = '';
    if (running) {
      rollerText = secondary.length ? secondary[secondary.length - 1] : currentActionLabel(actions);
      // prefer 正在… form
      if (rollerText && rollerText.indexOf('正在') !== 0 && !/已/.test(rollerText.slice(0, 1))) {
        /* keep as-is from secondary */
      }
    } else if (secondary.length) {
      rollerText = ''; // collapsed done: mock only shows primary + chevron
    }

    var rollerInner = null;
    if (rollerText) {
      var roller = el('span', 'flow-purpose__roller', {
        'aria-hidden': secondary.length > 1 ? 'false' : 'true',
      });
      rollerInner = el('span', 'flow-purpose__roller-text');
      rollerInner.textContent = rollerText;
      roller.appendChild(rollerInner);
      head.appendChild(roller);
    }

    var chev = el('span', 'flow-purpose__chevron', { 'aria-hidden': 'true' });
    chev.innerHTML = dom.chevronSvg();
    head.appendChild(chev);

    root.appendChild(head);

    var acc = el('div', 'flow-acc flow-purpose__acc', {
      'data-open': open ? 'true' : 'false',
    });
    var inner = el('div', 'flow-acc__inner');
    var body = el('div', 'flow-purpose__body');

    var renderAction =
      typeof opts.renderAction === 'function'
        ? opts.renderAction
        : function (action) {
            var AR = window.FlowComponents.ActionRow;
            if (AR && typeof AR.render === 'function') {
              return AR.render(action, { onOpenPath: opts.onOpenPath });
            }
            var row = document.createElement('div');
            row.className = 'flow-action is-static';
            row.textContent = (action.verb || '') + ' ' + (action.objectLabel || action.path || '');
            return row;
          };

    for (var i = 0; i < actions.length; i++) {
      var actionEl = renderAction(actions[i], { onOpenPath: opts.onOpenPath });
      if (actionEl) body.appendChild(actionEl);
    }

    /* continuous rail only when 2+ actions */
    if (actions.length <= 1) {
      body.classList.add('is-single');
    }

    inner.appendChild(body);
    acc.appendChild(inner);
    root.appendChild(acc);

    dom.setOpen(acc, open);
    dom.bindToggle(head, acc, function (next) {
      root.classList.toggle('is-open', next);
    });

    if (running && secondary.length > 1 && rollerInner) {
      var idx = secondary.length - 1;
      var timer = setInterval(function () {
        if (!root.isConnected) {
          clearInterval(timer);
          return;
        }
        idx = (idx + 1) % secondary.length;
        rollerInner.textContent = secondary[idx];
      }, 1400);
      root._flowRollerClear = function () {
        clearInterval(timer);
      };
    }

    return root;
  }

  window.FlowComponents.PurposeBlock = { render: render };
})();
