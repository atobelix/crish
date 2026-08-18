/**
 * file-preview/toolbar/Toolbar.js — 按 capability 渲染动作条
 */
(function () {
  'use strict';

  var Cap = window.FilePreviewCapabilities;

  /**
   * @param {HTMLElement} host
   * @param {{ capabilities: string[], handlers: object, state?: object }} opts
   */
  function mount(host, opts) {
    opts = opts || {};
    var handlers = opts.handlers || {};
    var state = opts.state || {};
    host.innerHTML = '';

    var bar = document.createElement('div');
    bar.className = 'fp-tb';
    bar.setAttribute('role', 'toolbar');

    var items = Cap.buildActions(opts.capabilities || ['close']);
    var refs = Object.create(null);

    items.forEach(function (item) {
      if (item.kind === 'sep') {
        var sep = document.createElement('div');
        sep.className = 'fp-tb-sep';
        sep.setAttribute('aria-hidden', 'true');
        bar.appendChild(sep);
        return;
      }
      if (item.kind === 'label') {
        var lab = document.createElement('span');
        lab.className = 'fp-tb-label';
        lab.dataset.fpAction = item.id;
        if (item.id === 'pageIndicator') {
          lab.textContent = state.pageLabel || '—';
        } else if (item.id === 'zoomLabel') {
          lab.textContent = state.zoomLabel || '100%';
        } else {
          lab.textContent = '';
        }
        refs[item.id] = lab;
        bar.appendChild(lab);
        return;
      }
      if (item.kind === 'select') {
        var sel = document.createElement('select');
        sel.className = 'fp-tb-select';
        sel.dataset.fpAction = item.id;
        sel.title = item.title;
        var sheets = state.sheets || [];
        sheets.forEach(function (s, i) {
          var opt = document.createElement('option');
          opt.value = String(i);
          opt.textContent = s.name || 'Sheet ' + (i + 1);
          if (i === (state.activeSheet || 0)) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', function () {
          if (handlers.onAction) {
            handlers.onAction('sheetSelect', { index: Number(sel.value) });
          }
        });
        refs[item.id] = sel;
        bar.appendChild(sel);
        return;
      }

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fp-tb-btn';
      btn.dataset.fpAction = item.id;
      btn.title = item.title;
      btn.setAttribute('aria-label', item.title);
      btn.innerHTML = item.icon || '';
      if (item.toggle && state[item.id]) {
        btn.classList.add('is-active');
        btn.setAttribute('aria-pressed', 'true');
      }
      btn.addEventListener('click', function () {
        if (handlers.onAction) handlers.onAction(item.id, {});
      });
      refs[item.id] = btn;
      bar.appendChild(btn);
    });

    host.appendChild(bar);

    return {
      el: bar,
      refs: refs,
      updateState: function (next) {
        state = Object.assign({}, state, next || {});
        if (refs.pageIndicator && state.pageLabel != null) {
          refs.pageIndicator.textContent = state.pageLabel;
        }
        if (refs.zoomLabel && state.zoomLabel != null) {
          refs.zoomLabel.textContent = state.zoomLabel;
        }
        ['thumbnails', 'crop', 'brush'].forEach(function (id) {
          if (!refs[id]) return;
          var on = !!state[id];
          refs[id].classList.toggle('is-active', on);
          refs[id].setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        if (refs.pagePrev) refs.pagePrev.disabled = !!state.pagePrevDisabled;
        if (refs.pageNext) refs.pageNext.disabled = !!state.pageNextDisabled;
        // 工作表下拉：同步选项与当前选中
        if (refs.sheetSelect) {
          var sel = refs.sheetSelect;
          var sheets = state.sheets || [];
          if (sheets.length) {
            var needRebuild =
              sel.options.length !== sheets.length ||
              sheets.some(function (s, i) {
                var opt = sel.options[i];
                var label = (s && s.name) || 'Sheet ' + (i + 1);
                return !opt || opt.textContent !== label;
              });
            if (needRebuild) {
              sel.innerHTML = '';
              sheets.forEach(function (s, i) {
                var opt = document.createElement('option');
                opt.value = String(i);
                opt.textContent = (s && s.name) || 'Sheet ' + (i + 1);
                sel.appendChild(opt);
              });
            }
            var active =
              typeof state.activeSheet === 'number' ? state.activeSheet : 0;
            if (active >= 0 && active < sel.options.length) {
              sel.selectedIndex = active;
            }
          }
        }
      },
      destroy: function () {
        host.innerHTML = '';
      },
    };
  }

  window.FilePreviewToolbar = { mount: mount };
})();
