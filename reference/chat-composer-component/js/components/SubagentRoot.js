/**
 * SubagentRoot — mock: icon + name + 工作中 N秒; line2 progress; expand nested stream
 */
(function () {
  'use strict';

  var FC = (window.FlowComponents = window.FlowComponents || {});

  function formatElapsed(node) {
    if (node.elapsed != null && node.elapsed !== '') {
      var s = String(node.elapsed);
      if (/秒|s$/i.test(s)) return s.replace(/s$/i, '秒');
      return s;
    }
    var ms = node.elapsedMs;
    if (ms == null || ms === '') return '';
    ms = Number(ms);
    if (isNaN(ms) || ms < 0) return '';
    var sec = ms / 1000;
    if (sec < 10) return (Math.round(sec * 10) / 10) + '秒';
    return Math.round(sec) + '秒';
  }

  function normalizeColumns(traces) {
    if (!traces || !traces.length) return [['工作中…']];
    var isNested = Array.isArray(traces[0]);
    if (isNested) {
      var cols = [];
      for (var i = 0; i < traces.length && cols.length < 3; i++) {
        var col = (traces[i] || []).map(String).filter(Boolean);
        if (col.length) cols.push(col);
      }
      return cols.length ? cols : [['工作中…']];
    }
    var flat = traces.map(String).filter(Boolean);
    if (!flat.length) return [['工作中…']];
    // show last few as single stream of status pairs when possible
    return [flat];
  }

  function isRunningStatus(status) {
    return status === 'running' || status === 'active' || status === 'in_progress';
  }

  function appendChildren(panel, children, opts) {
    if (!children || !children.length) return;
    if (opts && typeof opts.renderChildren === 'function') {
      var result = opts.renderChildren(children);
      if (!result) return;
      if (result.nodeType === 11 || result.nodeType === 1) {
        panel.appendChild(result);
      } else if (Array.isArray(result)) {
        result.forEach(function (el) {
          if (el && el.nodeType) panel.appendChild(el);
        });
      }
    }
  }

  function render(node, opts) {
    opts = opts || {};
    node = node || {};
    var dom = FC.dom || {};
    var name = node.name || '子任务';
    var running = isRunningStatus(node.status);
    var elapsed = formatElapsed(node);
    var columns = normalizeColumns(node.traces);
    var children = node.children || node.blocks || [];
    var open = !!opts.initiallyOpen;

    var root = document.createElement('div');
    root.className = 'flow-subagent' + (running ? ' is-running' : '') + (open ? ' is-open' : '');
    if (node.id) root.dataset.id = node.id;
    root.dataset.kind = 'subagent';
    root.dataset.status = node.status || (running ? 'running' : 'done');

    // Line 1
    var line1 = document.createElement('button');
    line1.type = 'button';
    line1.className = 'flow-subagent__line1';
    line1.setAttribute('aria-expanded', open ? 'true' : 'false');

    var icon = document.createElement('span');
    icon.className = 'flow-subagent__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML =
      (dom.iconHtml && dom.iconHtml('branch')) ||
      '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/></svg>';

    var title = document.createElement('span');
    title.className = 'flow-subagent__title';
    title.textContent = name;

    var status = document.createElement('span');
    status.className = 'flow-subagent__status';
    if (running) {
      status.textContent = '工作中 ' + (elapsed || '0秒');
      // tick
      if (!elapsed || elapsed === '0秒') {
        var started = Date.now() - 3000;
        var tickEl = status;
        var t = setInterval(function () {
          if (!root.isConnected) {
            clearInterval(t);
            return;
          }
          var s = ((Date.now() - started) / 1000) | 0;
          tickEl.textContent = '工作中 ' + s + '秒';
        }, 400);
      }
    } else {
      status.textContent = elapsed ? '完成 · ' + elapsed : '';
    }

    line1.appendChild(icon);
    line1.appendChild(title);
    line1.appendChild(status);

    // Line 2 — latest traces as "· 进度"
    var line2 = document.createElement('div');
    line2.className = 'flow-subagent__line2';
    var tracesWrap = document.createElement('div');
    tracesWrap.className = 'flow-subagent__traces';

    columns.forEach(function (col) {
      var colEl = document.createElement('div');
      colEl.className = 'flow-subagent__col';
      var lead = document.createElement('span');
      lead.className = 'flow-subagent__trace-lead';
      lead.setAttribute('aria-hidden', 'true');
      lead.textContent = '·';
      colEl.appendChild(lead);
      col.forEach(function (text, i) {
        var item = document.createElement('span');
        item.className = 'flow-subagent__trace' + (i === col.length - 1 ? ' is-live' : '');
        item.textContent = text;
        colEl.appendChild(item);
      });
      tracesWrap.appendChild(colEl);
    });
    line2.appendChild(tracesWrap);

    // Panel
    var panel = document.createElement('div');
    panel.className = 'flow-subagent__panel';
    if (!open) panel.hidden = true;
    var panelInner = document.createElement('div');
    panelInner.className = 'flow-subagent__panel-inner';
    appendChildren(panelInner, children, opts);
    panelInner.classList.add('flow-scroll-nested');
    panel.appendChild(panelInner);

    function refreshFade() {
      if (dom.updateOverflowFade) dom.updateOverflowFade(panel, panelInner);
    }

    function setOpen(next) {
      open = !!next;
      root.classList.toggle('is-open', open);
      line1.setAttribute('aria-expanded', open ? 'true' : 'false');
      panel.hidden = !open;
      if (open) requestAnimationFrame(refreshFade);
    }

    line1.addEventListener('click', function () {
      setOpen(!open);
    });
    line1.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(!open);
      }
    });

    if (dom.bindOverflowFade) {
      dom.bindOverflowFade(panel, panelInner);
    }

    root.appendChild(line1);
    root.appendChild(line2);
    root.appendChild(panel);
    if (open) requestAnimationFrame(refreshFade);
    return root;
  }

  FC.SubagentRoot = { render: render };
})();
