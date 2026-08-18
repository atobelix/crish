/**
 * ActionRow — icon + 已搜索/已执行 + object
 *
 * Expand rules (in-stream body only):
 *   - shell / edit with non-trivial output or diffs → expandable
 *   - search / list / trivial inspect → NOT expandable
 *
 * Open-path rules (right Files panel):
 *   - only project file paths from read/edit tools
 *   - never for search patterns / shell commands
 */
(function () {
  'use strict';

  window.FlowComponents = window.FlowComponents || {};

  function basename(p) {
    if (!p) return '';
    var s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
    var parts = s.split('/');
    return parts[parts.length - 1] || s;
  }

  function isShell(node) {
    if (node.kind === 'shell') return true;
    var n = (node.toolName || '').toLowerCase();
    return (
      n === 'shell' ||
      n === 'bash' ||
      n === 'run_command' ||
      n === 'run_terminal_cmd' ||
      n.indexOf('shell') >= 0 ||
      n.indexOf('bash') >= 0 ||
      n.indexOf('exec') >= 0 ||
      n.indexOf('terminal') >= 0
    );
  }

  function isSearch(node) {
    if (node.kind === 'search') return true;
    var n = (node.toolName || '').toLowerCase();
    if (n.indexOf('replace') >= 0 || n.indexOf('write') >= 0 || n.indexOf('edit') >= 0) return false;
    return (
      n === 'grep' ||
      n === 'rg' ||
      n.indexOf('grep') >= 0 ||
      n.indexOf('codebase_search') >= 0 ||
      (n.indexOf('search') >= 0 && n.indexOf('replace') < 0)
    );
  }

  function isList(node) {
    var n = (node.toolName || '').toLowerCase();
    return n.indexOf('list') >= 0 || n.indexOf('glob') >= 0 || n.indexOf('dir') >= 0;
  }

  function isEdit(node) {
    if (node.kind === 'edit') return true;
    var n = (node.toolName || '').toLowerCase();
    return (
      n.indexOf('write') >= 0 ||
      n.indexOf('replace') >= 0 ||
      n.indexOf('edit') >= 0 ||
      n.indexOf('patch') >= 0 ||
      n === 'search_replace'
    );
  }

  function isRead(node) {
    if (node.kind === 'file') return true;
    var n = (node.toolName || '').toLowerCase();
    return n.indexOf('read') >= 0 || n.indexOf('view') >= 0 || n === 'open_file';
  }

  /** Looks like a project file path (not a search pattern / raw command). */
  function looksLikeProjectPath(path) {
    if (!path) return false;
    var p = String(path).trim();
    if (!p) return false;
    // URL / pure pattern noise
    if (/^https?:\/\//i.test(p)) return false;
    if (/^[\^$.*+?()[\]{}|\\]/.test(p) && p.indexOf('/') < 0 && p.indexOf('\\') < 0) return false;
    // has extension or path separator
    if (/\.[a-zA-Z0-9]{1,8}$/.test(p)) return true;
    if (/[\\/]/.test(p)) return true;
    return false;
  }

  /**
   * Right-panel open: only project source files from read/edit.
   * Search / shell / list never open side panel.
   */
  function isOpenablePath(node) {
    if (!node || !node.path) return false;
    if (isSearch(node) || isShell(node) || isList(node)) return false;
    if (!(isRead(node) || isEdit(node) || node.kind === 'file' || node.kind === 'edit')) {
      // kind other but path looks like file → still openable
      if (!looksLikeProjectPath(node.path)) return false;
    }
    return looksLikeProjectPath(node.path);
  }

  /**
   * In-stream expand: meaningful output only.
   * Search never expands (no value in dumping grep payload inline).
   * List rarely expands.
   */
  function isExpandable(node) {
    if (typeof node.expandable === 'boolean') {
      // projector may set it; still force-off search
      if (isSearch(node)) return false;
      return node.expandable;
    }
    if (node.status === 'running' || node.status === 'pending_approval') return false;
    if (isSearch(node)) return false;
    if (isList(node)) return false;

    if (node.diffStat && (node.diffStat.add || node.diffStat.del)) return true;
    if (node.diffs && node.diffs.length) return true;

    var out = String(node.output || '').trim();
    if (!out) return false;
    if (/^(完成|成功|ok|done|success)$/i.test(out)) return false;
    if (out.length < 8) return false;
    // multi-line or long single line with substance
    if (out.indexOf('\n') >= 0 || out.length > 40) return true;
    return false;
  }

  function displayVerb(node) {
    var v = node.verb || '';
    if (node.status === 'running') {
      if (v.indexOf('正在') === 0) return v;
      if (v) return '正在' + v.replace(/^已/, '');
      return '正在执行';
    }
    if (v === '搜索' || v === '已搜索') return '已搜索';
    if (v === '运行' || v === '已运行' || v === '已执行') return '已执行';
    if (v === '查看' || v === '已查看') return '已查看';
    if (v === '浏览' || v === '已浏览') return '已浏览';
    if (v === '修改' || v === '已修改') return '已修改';
    if (v === '写入' || v === '已写入') return '已写入';
    if (v && v.indexOf('已') !== 0 && node.status === 'success') return '已' + v;
    return v || '已完成';
  }

  function render(node, opts) {
    opts = opts || {};
    node = node || {};
    var dom = window.FlowComponents.dom;
    var el = dom.el;

    var expandable = isExpandable(node);
    var openable = isOpenablePath(node);
    var running = node.status === 'running';
    var isError = node.status === 'error';
    var open = !!(opts.initiallyOpen && expandable);
    var shell = isShell(node);

    var rootCls = 'flow-action';
    if (running) rootCls += ' is-running';
    if (isError) rootCls += ' is-error';
    if (expandable) rootCls += ' is-expandable';
    else rootCls += ' is-static';
    if (open) rootCls += ' is-open';

    var root = el('div', rootCls, {
      'data-id': node.id || '',
      'data-kind': 'action',
      'data-status': node.status || '',
      'data-tool': node.toolName || '',
    });

    var headTag = expandable ? 'button' : 'div';
    var head = el(
      headTag,
      'flow-action__head' + (expandable ? '' : ' is-static'),
      expandable
        ? { type: 'button', 'aria-expanded': open ? 'true' : 'false' }
        : { role: 'group' }
    );

    /* icon column */
    if (running) {
      var marker = el('span', 'flow-action__marker', { 'aria-hidden': 'true' });
      marker.innerHTML = dom.pulseDotHtml();
      head.appendChild(marker);
    } else {
      var icon = el('span', 'flow-action__icon', { 'aria-hidden': 'true' });
      icon.innerHTML = dom.iconHtml(dom.iconForKind(node.kind, node.toolName));
      head.appendChild(icon);
    }

    var textWrap = el('span', 'flow-action__text');
    textWrap.appendChild(el('span', 'flow-action__verb', { textContent: displayVerb(node) }));

    if (shell && (node.command || node.objectLabel)) {
      var cmd = node.command || node.objectLabel;
      textWrap.appendChild(document.createTextNode(' '));
      textWrap.appendChild(
        el('span', 'flow-action__cmd-inline', { textContent: '$ ' + cmd })
      );
    } else if (node.path && (isRead(node) || isEdit(node) || isList(node) || openable)) {
      var pathLabel = basename(node.path) || node.path;
      if (openable) {
        var pathBtn = el('button', 'flow-action__path is-openable', {
          type: 'button',
          title: node.path,
          'data-stop-toggle': '1',
          'data-path': node.path,
        });
        pathBtn.textContent = pathLabel;
        pathBtn.style.pointerEvents = 'auto';
        pathBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          e.preventDefault();
          if (typeof opts.onOpenPath === 'function') opts.onOpenPath(node.path);
        });
        textWrap.appendChild(document.createTextNode(' '));
        textWrap.appendChild(pathBtn);
      } else {
        textWrap.appendChild(document.createTextNode(' '));
        textWrap.appendChild(
          el('span', 'flow-action__path', {
            textContent: pathLabel,
            title: node.path,
          })
        );
      }
    } else if (node.objectLabel) {
      textWrap.appendChild(document.createTextNode(' '));
      textWrap.appendChild(
        el('span', 'flow-action__object', { textContent: node.objectLabel })
      );
    }

    if (node.diffStat && (node.diffStat.add != null || node.diffStat.del != null)) {
      var diff = el('span', 'flow-action__diff');
      diff.appendChild(
        el('span', 'flow-action__diff-add', { textContent: '+' + (node.diffStat.add || 0) })
      );
      diff.appendChild(
        el('span', 'flow-action__diff-del', { textContent: '−' + (node.diffStat.del || 0) })
      );
      textWrap.appendChild(diff);
    }

    head.appendChild(textWrap);

    if (expandable) {
      var chev = el('span', 'flow-action__chevron', { 'aria-hidden': 'true' });
      chev.innerHTML = dom.chevronSvg();
      textWrap.appendChild(chev);
    }

    root.appendChild(head);

    if (expandable) {
      var acc = el('div', 'flow-acc flow-action__acc', {
        'data-open': open ? 'true' : 'false',
      });
      var inner = el('div', 'flow-acc__inner');
      var body = el('div', 'flow-action__body');
      var bodyInner = el('div', 'flow-action__body-inner flow-scroll-nested');

      if (shell && node.command) {
        var cmdBlockWrap = el('div', 'flow-action__cmd-block-wrap');
        var cmdEl = el('div', 'flow-action__cmd', { textContent: '$ ' + node.command });
        cmdBlockWrap.appendChild(cmdEl);
        
        var copyBtn2 = el('button', 'flow-action__copy-btn flow-action__copy-btn--block', { title: '复制命令', 'aria-label': '复制命令', 'data-stop-toggle': '1' });
        copyBtn2.innerHTML = dom.copySvg ? dom.copySvg() : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        copyBtn2.addEventListener('click', function (e) {
          e.stopPropagation();
          e.preventDefault();
          navigator.clipboard.writeText(node.command);
          var originalHtml = copyBtn2.innerHTML;
          copyBtn2.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
          setTimeout(function() { copyBtn2.innerHTML = originalHtml; }, 1200);
        });
        cmdBlockWrap.appendChild(copyBtn2);
        
        bodyInner.appendChild(cmdBlockWrap);
      }

      var outText = String(node.output || '').trim();
      if (outText) {
        var out = el('pre', 'flow-action__out');
        out.textContent = outText;
        bodyInner.appendChild(out);
      } else if (node.diffs && node.diffs.length) {
        var outDiff = el('pre', 'flow-action__out');
        outDiff.textContent = Array.isArray(node.diffs) ? node.diffs.join('\n') : String(node.diffs);
        bodyInner.appendChild(outDiff);
      }

      body.appendChild(bodyInner);
      inner.appendChild(body);
      acc.appendChild(inner);
      root.appendChild(acc);

      dom.setOpen(acc, open);

      function refreshFade() {
        if (dom.updateOverflowFade) dom.updateOverflowFade(body, bodyInner);
      }

      dom.bindToggle(head, acc, function (next) {
        root.classList.toggle('is-open', next);
        if (next) {
          requestAnimationFrame(refreshFade);
        }
      });

      if (dom.bindOverflowFade) {
        dom.bindOverflowFade(body, bodyInner);
      }
      if (open) requestAnimationFrame(refreshFade);
    }

    return root;
  }

  window.FlowComponents.ActionRow = {
    render: render,
    isExpandable: isExpandable,
    isOpenablePath: isOpenablePath,
  };
})();
