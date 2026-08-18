/**
 * dom-utils.js — shared DOM helpers for FlowComponents
 * Icons, chevron, open/toggle, overflow fade, scroll chain.
 */
(function () {
  'use strict';

  window.FlowComponents = window.FlowComponents || {};

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function el(tag, className, attrs) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var val = attrs[key];
        if (val == null) return;
        if (key === 'textContent' || key === 'innerHTML') {
          node[key] = val;
        } else if (key === 'className') {
          node.className = val;
        } else if (key.slice(0, 2) === 'on' && typeof val === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), val);
        } else if (key === 'dataset' && typeof val === 'object') {
          Object.keys(val).forEach(function (dk) {
            node.dataset[dk] = val[dk];
          });
        } else if (key === 'style' && typeof val === 'object') {
          Object.keys(val).forEach(function (sk) {
            node.style[sk] = val[sk];
          });
        } else if (val === true) {
          node.setAttribute(key, '');
        } else if (val !== false) {
          node.setAttribute(key, String(val));
        }
      });
    }
    return node;
  }

  /** Small right chevron matching mock "›" after labels */
  function chevronSvg() {
    return (
      '<svg class="tc-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none"' +
      ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' +
      ' aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>'
    );
  }

  function pulseDotHtml() {
    return '<span class="flow-dot flow-dot--running" aria-hidden="true"></span>';
  }

  /* Lucide-ish 14px stroke icons — aligned in fixed icon column */
  var ICONS = {
    search:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    terminal:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
    file:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    edit:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    branch:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
    spark:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>',
    folder:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    /* circle-terminal style for shell (mock) */
    shell:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="9 9.5 11.5 12 9 14.5"/><line x1="13" y1="15" x2="16" y2="15"/></svg>',
  };

  function iconHtml(name) {
    return ICONS[name] || ICONS.file;
  }

  /**
   * Map tool kind/name → icon.
   * Order matters: edit before search (search_replace must not become search).
   */
  function iconForKind(kind, toolName) {
    var k = (kind || '').toLowerCase();
    var n = (toolName || '').toLowerCase();

    // edit / write first
    if (
      k === 'edit' ||
      n.indexOf('write') >= 0 ||
      n.indexOf('replace') >= 0 ||
      n.indexOf('edit') >= 0 ||
      n.indexOf('patch') >= 0 ||
      n === 'search_replace' ||
      n === 'apply_patch'
    ) {
      return 'edit';
    }
    // shell
    if (
      k === 'shell' ||
      n.indexOf('shell') >= 0 ||
      n.indexOf('terminal') >= 0 ||
      n.indexOf('bash') >= 0 ||
      n === 'run_command' ||
      n === 'run_terminal_cmd' ||
      n.indexOf('exec') >= 0
    ) {
      return 'shell';
    }
    // search (not search_replace — already handled)
    if (
      k === 'search' ||
      n === 'grep' ||
      n === 'rg' ||
      n.indexOf('grep') >= 0 ||
      n.indexOf('codebase_search') >= 0 ||
      (n.indexOf('search') >= 0 && n.indexOf('replace') < 0)
    ) {
      return 'search';
    }
    // list / browse dir
    if (k === 'list' || n.indexOf('list') >= 0 || n.indexOf('glob') >= 0 || n.indexOf('dir') >= 0) {
      return 'folder';
    }
    // read / file
    if (k === 'file' || n.indexOf('read') >= 0 || n.indexOf('view') >= 0 || n.indexOf('cat') >= 0) {
      return 'file';
    }
    if (n.indexOf('subagent') >= 0 || k === 'subagent') return 'branch';
    if (k === 'artifact' || k === 'document') return 'file';
    return 'file';
  }

  function setOpen(accEl, open) {
    if (!accEl) return;
    accEl.setAttribute('data-open', open ? 'true' : 'false');
    if (open) {
      accEl.classList.add('is-open');
      var root = accEl.closest('.flow-thinking, .flow-purpose, .flow-action, .flow-subagent');
      if (root) root.classList.add('is-open');
    } else {
      accEl.classList.remove('is-open');
      var root2 = accEl.closest('.flow-thinking, .flow-purpose, .flow-action, .flow-subagent');
      if (root2) root2.classList.remove('is-open');
    }
  }

  function bindToggle(headEl, accEl, onChange) {
    if (!headEl || !accEl) return;

    function currentOpen() {
      return accEl.getAttribute('data-open') === 'true';
    }

    function toggle(e) {
      if (e && e.defaultPrevented) return;
      var next = !currentOpen();
      setOpen(accEl, next);
      headEl.setAttribute('aria-expanded', next ? 'true' : 'false');
      if (typeof onChange === 'function') onChange(next);
    }

    headEl.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('[data-stop-toggle]')) return;
      toggle(e);
    });

    headEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle(e);
      }
    });

    headEl.setAttribute('aria-expanded', currentOpen() ? 'true' : 'false');
  }

  /**
   * Toggle is-overflowing on a fade host when its scroller exceeds max height.
   * Guarded against unnecessary class mutation to prevent forced reflow.
   * @param {HTMLElement} fadeHost  element that gets ::before/::after fades
   * @param {HTMLElement} scroller  the overflow:auto child
   */
  function updateOverflowFade(fadeHost, scroller) {
    if (!fadeHost || !scroller) return;
    var overflowing = scroller.scrollHeight > scroller.clientHeight + 2;
    if (fadeHost.classList.contains('is-overflowing') !== overflowing) {
      fadeHost.classList.toggle('is-overflowing', overflowing);
    }
  }

  function bindOverflowFade(fadeHost, scroller) {
    if (!fadeHost || !scroller) return function () {};
    var scheduled = false;
    function check() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        updateOverflowFade(fadeHost, scroller);
      });
    }
    // Initial async check
    requestAnimationFrame(function () {
      updateOverflowFade(fadeHost, scroller);
    });
    scroller.addEventListener('scroll', check, { passive: true });
    return function () {
      scroller.removeEventListener('scroll', check);
    };
  }

  /**
   * Scroll chaining: do NOT intercept wheel.
   * Previous manual chain (preventDefault + scrollTop += deltaY) caused
   * jitter / overshoot because:
   * - deltaY may be lines/pages not pixels
   * - non-overflowing nested nodes matched and stole every wheel
   * - fought with native scroll on the stream
   *
   * Nested panels use overscroll-behavior: auto so the browser chains
   * to the parent stream naturally when at top/bottom.
   */
  function bindScrollChain(/* streamEl */) {
    // no-op: keep API for FlowMount; native chaining only
  }

  window.FlowComponents.dom = {
    esc: esc,
    el: el,
    chevronSvg: chevronSvg,
    pulseDotHtml: pulseDotHtml,
    iconHtml: iconHtml,
    iconForKind: iconForKind,
    setOpen: setOpen,
    bindToggle: bindToggle,
    updateOverflowFade: updateOverflowFade,
    bindOverflowFade: bindOverflowFade,
    bindScrollChain: bindScrollChain,
  };
})();
