/**
 * 对话正文 Markdown → 安全 HTML（正式版紧凑排版）。
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 去掉模型常夹带的「正在思考…」占位，避免与思考区重复 */
export function stripThoughtPlaceholders(text: string): string {
  if (!text) return '';
  return text
    .replace(/^(正在思考中[….\s]*|正在处理[….\s]*)+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isTableSepLine(line: string): boolean {
  // | --- | :---: | ---: | 或 ---|---
  const t = line.trim();
  if (!t) return false;
  const core = t.replace(/^\|/, '').replace(/\|$/, '');
  const cells = core.split('|').map((c) => c.trim());
  if (cells.length < 1) return false;
  return cells.every((c) => /^:?-{2,}:?$/.test(c));
}

function isTableRowLine(line: string): boolean {
  const t = line.trim();
  if (!t.includes('|')) return false;
  if (isTableSepLine(t)) return false;
  // 至少两个 | 或 |cell| 形式
  return (t.match(/\|/g) || []).length >= 1 && t.replace(/\|/g, '').trim().length > 0;
}

function splitTableCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

/**
 * 将 GFM 表格块转为 HTML table（在 escape 之前用占位符保护）。
 */
function extractTables(text: string): { text: string; tables: string[] } {
  const tables: string[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // 需要：表头行 + 分隔行
    if (
      i + 1 < lines.length &&
      isTableRowLine(lines[i]) &&
      isTableSepLine(lines[i + 1])
    ) {
      const header = splitTableCells(lines[i]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRowLine(lines[i])) {
        rows.push(splitTableCells(lines[i]));
        i += 1;
      }
      // 对齐列数
      const colCount = header.length;
      const th = header
        .map((c) => `<th class="md-th">${escapeHtml(c)}</th>`)
        .join('');
      const trs = rows
        .map((row) => {
          const cells = [...row];
          while (cells.length < colCount) cells.push('');
          return `<tr class="md-tr">${cells
            .slice(0, colCount)
            .map((c) => `<td class="md-td">${escapeHtml(c)}</td>`)
            .join('')}</tr>`;
        })
        .join('');
      const html = `<div class="md-table-wrap"><table class="md-table"><thead><tr class="md-tr">${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
      const idx = tables.length;
      tables.push(html);
      out.push(`%%TABLE${idx}%%`);
      // 表格后补空行，方便段落切分
      if (i < lines.length && lines[i].trim() !== '') {
        // keep going
      }
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }

  return { text: out.join('\n'), tables };
}

function applyInline(html: string): string {
  let s = html;
  s = s.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  return s;
}

export function parseMarkdownToHtml(raw: string): string {
  if (!raw) return '';
  let text = stripThoughtPlaceholders(raw);
  if (!text) return '';

  // 去掉对话里无意义的水平线（--- / *** / ___）
  text = text.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n');

  // 保护代码块
  const fences: string[] = [];
  text = text.replace(/```(\w*)\r?\n([\s\S]*?)```/g, (_, lang, code) => {
    const i = fences.length;
    fences.push(
      `<pre class="md-code-block"><code class="language-${escapeHtml(lang || '')}">${escapeHtml(
        code.replace(/\n$/, ''),
      )}</code></pre>`,
    );
    return `\n%%FENCE${i}%%\n`;
  });

  // 表格（在 escape 前抽出，单元格内再 escape）
  const extracted = extractTables(text);
  text = extracted.text;
  const tables = extracted.tables;

  // 行内图片 ![alt](url)
  text = text.replace(
    /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_, alt, url) =>
      `<img class="md-img" src="${escapeHtml(url)}" alt="${escapeHtml(alt || '')}" loading="lazy" />`,
  );

  // 链接 [t](u)
  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_, t, u) =>
      `<a class="md-a" href="${escapeHtml(u)}" target="_blank" rel="noreferrer">${escapeHtml(t)}</a>`,
  );

  // 其余文本 escape（已是 HTML 的 img/a 占位用特殊标记避免双重 escape——上面已写入标签）
  // 对剩余纯文本行：若整行已是我们的 HTML 标签则跳过
  let html = text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (
        t.startsWith('<img ') ||
        t.startsWith('<a ') ||
        t.startsWith('%%FENCE') ||
        t.startsWith('%%TABLE')
      ) {
        return line;
      }
      return escapeHtml(line);
    })
    .join('\n');

  // 还原代码块与表格
  html = html.replace(/%%FENCE(\d+)%%/g, (_, i) => fences[Number(i)] || '');
  html = html.replace(/%%TABLE(\d+)%%/g, (_, i) => tables[Number(i)] || '');

  // 行内格式（仅作用于非标签片段时仍可能影响属性——表格已完整 HTML）
  html = applyInline(html);

  // 标题 # ## ###
  html = html.replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, content) => {
    const level = Math.min(hashes.length, 4);
    return `<h${level} class="md-h${level}">${content}</h${level}>`;
  });

  // 对话流不渲染 --- 分隔线（模型爱刷，干扰阅读）
  html = html.replace(/^---+$/gm, '');

  // 任务列表与普通列表
  html = html.replace(
    /^(?:\s*)[-*]\s+\[ \]\s+(.+)$/gm,
    '<li class="md-li md-task-item"><span class="md-task-box"></span>$1</li>',
  );
  html = html.replace(
    /^(?:\s*)[-*]\s+\[[xX]\]\s+(.+)$/gm,
    '<li class="md-li md-task-item done"><span class="md-task-box checked"></span>$1</li>',
  );
  html = html.replace(/^(?:\s*)[-*]\s+(.+)$/gm, '<li class="md-li">$1</li>');
  html = html.replace(/^(?:\s*)\d+\.\s+(.+)$/gm, '<li class="md-li md-ol-item">$1</li>');

  // 合并连续 li
  html = html.replace(/(?:<li class="md-li[^"]*">[\s\S]*?<\/li>\s*)+/g, (block) => {
    if (block.includes('md-ol-item')) {
      return `<ol class="md-ol">${block}</ol>`;
    }
    return `<ul class="md-ul">${block}</ul>`;
  });

  // 段落：按空行切分
  const parts = html.split(/\n{2,}/);
  html = parts
    .map((block) => {
      const t = block.trim();
      if (!t) return '';
      if (
        t.startsWith('<pre') ||
        t.startsWith('<ul') ||
        t.startsWith('<ol') ||
        t.startsWith('<h') ||
        t.startsWith('<hr') ||
        t.startsWith('<img') ||
        t.startsWith('<table') ||
        t.startsWith('<div class="md-table')
      ) {
        return t;
      }
      // 单换行 → <br>
      const inner = t.replace(/\n/g, '<br />');
      return `<p class="md-p">${inner}</p>`;
    })
    .join('');

  return html;
}
