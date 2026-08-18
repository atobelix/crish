/**
 * file-preview/viewers/TableViewer.js
 * sticky 表头 · 过滤 · 行/列统计 · 截断提示 · sheet 切换
 */
(function () {
  'use strict';

  var Types = window.FilePreviewTypes;

  var ICON_SEARCH =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
    '<circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<line x1="16.5" y1="16.5" x2="21" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '</svg>';

  /**
   * @param {HTMLElement} host
   * @param {object} model
   * @param {object} [handlers]
   */
  function mount(host, model, handlers) {
    handlers = handlers || {};
    host.innerHTML = '';

    var payload = (model && model.payload) || {};
    var sheets = Array.isArray(payload.sheets) ? payload.sheets : [];
    var activeIndex =
      typeof payload.activeIndex === 'number' && payload.activeIndex >= 0
        ? payload.activeIndex
        : 0;
    if (activeIndex >= sheets.length) activeIndex = 0;

    var maxRows =
      payload.maxRows != null
        ? payload.maxRows
        : (window.FilePreviewAdapters &&
            window.FilePreviewAdapters.spreadsheet &&
            window.FilePreviewAdapters.spreadsheet.DEFAULT_MAX_ROWS) ||
          2000;

    var filterQuery = '';
    var toolbarBridge = null;
    var destroyed = false;

    // ── DOM 骨架 ──────────────────────────────────────────────
    var root = document.createElement('div');
    root.className = 'fp-table fp-fade-in';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', '表格预览');

    var bar = document.createElement('div');
    bar.className = 'fp-table-bar';

    var searchWrap = document.createElement('div');
    searchWrap.className = 'fp-table-search';
    var searchIcon = document.createElement('span');
    searchIcon.className = 'fp-table-search-icon';
    searchIcon.innerHTML = ICON_SEARCH;
    var searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = '筛选行…';
    searchInput.setAttribute('aria-label', '筛选表格行');
    searchInput.autocomplete = 'off';
    searchWrap.appendChild(searchIcon);
    searchWrap.appendChild(searchInput);

    var stats = document.createElement('div');
    stats.className = 'fp-table-stats';
    stats.setAttribute('aria-live', 'polite');

    bar.appendChild(searchWrap);
    bar.appendChild(stats);

    var truncBar = document.createElement('div');
    truncBar.className = 'fp-table-trunc';
    truncBar.hidden = true;

    var scroll = document.createElement('div');
    scroll.className = 'fp-table-scroll';

    var table = document.createElement('table');
    table.className = 'fp-table-grid';

    var thead = document.createElement('thead');
    var tbody = document.createElement('tbody');
    tbody.className = 'fp-row-stagger';

    table.appendChild(thead);
    table.appendChild(tbody);
    scroll.appendChild(table);

    var emptyEl = document.createElement('div');
    emptyEl.className = 'fp-table-empty';
    emptyEl.hidden = true;
    emptyEl.textContent = '没有匹配的行';

    root.appendChild(bar);
    root.appendChild(truncBar);
    root.appendChild(scroll);
    root.appendChild(emptyEl);
    host.appendChild(root);

    // ── 数据辅助 ──────────────────────────────────────────────

    function currentSheet() {
      return sheets[activeIndex] || { name: 'Sheet', rows: [] };
    }

    function isTruncated() {
      var s = currentSheet();
      if (s && s.truncated) return true;
      return !!payload.truncated;
    }

    function splitHeaderBody(rows) {
      rows = rows || [];
      if (!rows.length) {
        return { header: [], body: [], colCount: 0 };
      }
      var header = (rows[0] || []).map(function (c) {
        return c == null ? '' : String(c);
      });
      var body = [];
      for (var i = 1; i < rows.length; i++) {
        body.push(rows[i] || []);
      }
      var colCount = header.length;
      for (var j = 0; j < body.length; j++) {
        if (body[j].length > colCount) colCount = body[j].length;
      }
      // 补齐表头列数
      while (header.length < colCount) header.push('');
      return { header: header, body: body, colCount: colCount };
    }

    function rowMatches(row, q) {
      if (!q) return true;
      for (var i = 0; i < row.length; i++) {
        var cell = row[i] == null ? '' : String(row[i]);
        if (cell.toLowerCase().indexOf(q) >= 0) return true;
      }
      return false;
    }

    function padRow(row, colCount) {
      var out = [];
      for (var i = 0; i < colCount; i++) {
        out.push(row && row[i] != null ? String(row[i]) : '');
      }
      return out;
    }

    // ── 渲染 ──────────────────────────────────────────────────

    function renderTrunc() {
      if (isTruncated()) {
        truncBar.hidden = false;
        truncBar.textContent =
          '仅显示前 ' +
          maxRows +
          ' 行，完整内容请下载原文件';
      } else {
        truncBar.hidden = true;
        truncBar.textContent = '';
      }
    }

    function renderStats(visibleBody, totalBody, colCount) {
      var n = visibleBody;
      var m = colCount;
      if (filterQuery && n !== totalBody) {
        stats.textContent =
          '共 ' + n + ' / ' + totalBody + ' 行 · ' + m + ' 列';
      } else {
        stats.textContent = '共 ' + n + ' 行 · ' + m + ' 列';
      }
    }

    function renderTable() {
      if (destroyed) return;
      var sheet = currentSheet();
      var parts = splitHeaderBody(sheet.rows);
      var q = filterQuery.trim().toLowerCase();

      // 表头
      thead.innerHTML = '';
      if (parts.colCount > 0) {
        var hr = document.createElement('tr');
        // 行号列
        var th0 = document.createElement('th');
        th0.className = 'fp-table-rownum';
        th0.textContent = '#';
        th0.scope = 'col';
        hr.appendChild(th0);

        for (var c = 0; c < parts.colCount; c++) {
          var th = document.createElement('th');
          th.scope = 'col';
          th.textContent = parts.header[c] || '列' + (c + 1);
          th.title = parts.header[c] || '';
          hr.appendChild(th);
        }
        thead.appendChild(hr);
      }

      // 表体（过滤）
      tbody.innerHTML = '';
      // 重新触发 stagger：去掉再加 class
      tbody.classList.remove('fp-row-stagger');
      void tbody.offsetWidth;
      tbody.classList.add('fp-row-stagger');

      var visible = 0;
      for (var r = 0; r < parts.body.length; r++) {
        var raw = parts.body[r] || [];
        if (q && !rowMatches(raw, q)) continue;
        visible += 1;
        var cells = padRow(raw, parts.colCount);
        var tr = document.createElement('tr');

        var numTd = document.createElement('td');
        numTd.className = 'fp-table-rownum';
        numTd.textContent = String(r + 1);
        tr.appendChild(numTd);

        for (var k = 0; k < cells.length; k++) {
          var td = document.createElement('td');
          td.textContent = cells[k];
          if (cells[k]) td.title = cells[k];
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }

      var hasHeader = parts.colCount > 0;
      var showEmpty = hasHeader && visible === 0 && parts.body.length > 0 && !!q;
      emptyEl.hidden = !showEmpty;
      table.hidden = !hasHeader;
      if (!hasHeader) {
        emptyEl.hidden = false;
        emptyEl.textContent = '工作表为空';
      } else if (!showEmpty) {
        emptyEl.textContent = '没有匹配的行';
      }

      renderStats(visible, parts.body.length, parts.colCount);
      renderTrunc();
    }

    function notifyToolbar() {
      var st = getToolbarState();
      if (toolbarBridge && typeof toolbarBridge.updateState === 'function') {
        toolbarBridge.updateState(st);
      }
      if (handlers.onToolbarState) {
        handlers.onToolbarState(st);
      }
    }

    function getToolbarState() {
      return {
        sheets: sheets.map(function (s, i) {
          return { name: (s && s.name) || 'Sheet ' + (i + 1) };
        }),
        activeSheet: activeIndex,
      };
    }

    function handleAction(id, detail) {
      detail = detail || {};
      if (id === 'sheetSelect') {
        var idx =
          typeof detail.index === 'number'
            ? detail.index
            : parseInt(detail.index, 10);
        if (isNaN(idx) || idx < 0 || idx >= sheets.length) return;
        if (idx === activeIndex) return;
        activeIndex = idx;
        // 同步 payload，便于外部读取
        if (model && model.payload) {
          model.payload.activeIndex = activeIndex;
          model.payload.truncated = isTruncated();
        }
        filterQuery = '';
        searchInput.value = '';
        renderTable();
        notifyToolbar();
      }
    }

    // ── 事件 ──────────────────────────────────────────────────

    var searchTimer = null;
    searchInput.addEventListener('input', function () {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        filterQuery = searchInput.value || '';
        renderTable();
      }, 120);
    });

    // 首次渲染
    renderTable();

    return {
      destroy: function () {
        destroyed = true;
        if (searchTimer) clearTimeout(searchTimer);
        toolbarBridge = null;
        host.innerHTML = '';
      },
      handleAction: handleAction,
      getToolbarState: getToolbarState,
      setToolbarBridge: function (bridge) {
        toolbarBridge = bridge || null;
      },
      /** 测试/调试：当前可见 sheet */
      getActiveSheet: function () {
        return currentSheet();
      },
    };
  }

  window.FilePreviewViewers = window.FilePreviewViewers || {};
  window.FilePreviewViewers.TableViewer = { mount: mount };
})();
