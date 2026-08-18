/**
 * markdown-lite.js — minimal MD → HTML for live preview (tables, headings, lists, code, bold)
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function inline(s) {
    var t = esc(s);
    t = t.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
    t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/\*(.+?)\*/g, '<em>$1</em>');
    t = t.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a class="md-a" href="$2" target="_blank" rel="noopener">$1</a>'
    );
    return t;
  }

  function isTableSep(line) {
    return /^\s*\|?[\s:-]+\|[\s|:-]+\|?\s*$/.test(line);
  }

  function splitRow(line) {
    var s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    return s.split('|').map(function (c) {
      return c.trim();
    });
  }

  function render(md) {
    var lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    var html = [];
    var i = 0;
    var inCode = false;
    var codeBuf = [];
    var listType = null;

    function closeList() {
      if (listType) {
        html.push(listType === 'ol' ? '</ol>' : '</ul>');
        listType = null;
      }
    }

    while (i < lines.length) {
      var line = lines[i];

      if (/^```/.test(line)) {
        closeList();
        if (!inCode) {
          inCode = true;
          codeBuf = [];
        } else {
          html.push('<pre class="md-pre"><code>' + esc(codeBuf.join('\n')) + '</code></pre>');
          inCode = false;
        }
        i++;
        continue;
      }
      if (inCode) {
        codeBuf.push(line);
        i++;
        continue;
      }

      // Table
      if (
        line.indexOf('|') >= 0 &&
        i + 1 < lines.length &&
        isTableSep(lines[i + 1])
      ) {
        closeList();
        var headers = splitRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        html.push('<div class="md-table-wrap"><table class="md-table"><thead><tr>');
        headers.forEach(function (h) {
          html.push('<th>' + inline(h) + '</th>');
        });
        html.push('</tr></thead><tbody>');
        rows.forEach(function (row) {
          html.push('<tr>');
          headers.forEach(function (_, idx) {
            html.push('<td>' + inline(row[idx] != null ? row[idx] : '') + '</td>');
          });
          html.push('</tr>');
        });
        html.push('</tbody></table></div>');
        continue;
      }

      if (/^###\s+/.test(line)) {
        closeList();
        html.push('<h3 class="md-h3">' + inline(line.replace(/^###\s+/, '')) + '</h3>');
        i++;
        continue;
      }
      if (/^##\s+/.test(line)) {
        closeList();
        html.push('<h2 class="md-h2">' + inline(line.replace(/^##\s+/, '')) + '</h2>');
        i++;
        continue;
      }
      if (/^#\s+/.test(line)) {
        closeList();
        html.push('<h1 class="md-h1">' + inline(line.replace(/^#\s+/, '')) + '</h1>');
        i++;
        continue;
      }
      if (/^>\s?/.test(line)) {
        closeList();
        html.push('<blockquote class="md-quote">' + inline(line.replace(/^>\s?/, '')) + '</blockquote>');
        i++;
        continue;
      }
      if (/^[-*]\s+/.test(line)) {
        if (listType !== 'ul') {
          closeList();
          listType = 'ul';
          html.push('<ul class="md-ul">');
        }
        html.push('<li>' + inline(line.replace(/^[-*]\s+/, '')) + '</li>');
        i++;
        continue;
      }
      if (/^\d+\.\s+/.test(line)) {
        if (listType !== 'ol') {
          closeList();
          listType = 'ol';
          html.push('<ol class="md-ol">');
        }
        html.push('<li>' + inline(line.replace(/^\d+\.\s+/, '')) + '</li>');
        i++;
        continue;
      }
      if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
        closeList();
        html.push('<hr class="md-hr">');
        i++;
        continue;
      }
      if (!line.trim()) {
        closeList();
        i++;
        continue;
      }
      closeList();
      html.push('<p class="md-p">' + inline(line) + '</p>');
      i++;
    }
    closeList();
    if (inCode) {
      html.push('<pre class="md-pre"><code>' + esc(codeBuf.join('\n')) + '</code></pre>');
    }
    return html.join('') || '<p class="md-p md-empty">（空文档）</p>';
  }

  window.MarkdownLite = { render: render, esc: esc };
})();
