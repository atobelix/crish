/**
 * 对话正文 Markdown → 安全 HTML（正式版紧凑排版）。
 */

import { highlightCode } from './codeHighlight';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isLocalPathRef(s: string): boolean {
  const t = (s || '').trim();
  if (!t || t.startsWith('http://') || t.startsWith('https://') || t.startsWith('mailto:')) {
    return false;
  }
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (t.startsWith('/') || t.startsWith('~/') || t.startsWith('./') || t.startsWith('../')) return true;
  if (/^(apps|packages|src|docs)\//.test(t)) return true;
  if (/\.(ts|tsx|js|jsx|css|md|json|rs|py|toml|yml|yaml)$/i.test(t) && !t.includes('://')) return true;
  return false;
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
  // 粗体先于斜体；斜体仅同行、非空，避免未闭合 * 吞掉整段
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(
    /(?<!\*)\*([^*\n]+?)\*(?!\*)/g,
    (full, inner: string) => {
      const t = inner.trim();
      // 过长或像整句未闭合时不套 em（防止 * 与远处 * 配对）
      if (!t || t.length > 80) return full;
      if (/\s{2,}/.test(inner)) return full;
      return `<em>${inner}</em>`;
    },
  );
  return s;
}

/** 未变化正文的 HTML 缓存（按规范化后的源文本）；命中时跳过完整解析 */
const MARKDOWN_HTML_CACHE = new Map<string, string>();
const MARKDOWN_HTML_CACHE_MAX = 240;

/** 测试/调试：清空缓存 */
export function clearMarkdownHtmlCache(): void {
  MARKDOWN_HTML_CACHE.clear();
}

/** 测试：当前缓存条目数 */
export function markdownHtmlCacheSize(): number {
  return MARKDOWN_HTML_CACHE.size;
}

function markdownCacheKey(raw: string): string {
  // 过长键只取头尾 + 长度，降低 Map 内存；碰撞概率极低
  if (raw.length <= 512) return raw;
  return `${raw.length}:${raw.slice(0, 200)}:${raw.slice(-200)}`;
}

/**
 * Markdown → 安全 HTML。相同 raw 重复渲染时走缓存。
 */
export function parseMarkdownToHtml(raw: string): string {
  if (!raw) return '';
  const key = markdownCacheKey(raw);
  const hit = MARKDOWN_HTML_CACHE.get(key);
  if (hit !== undefined) return hit;
  const html = parseMarkdownToHtmlUncached(raw);
  if (MARKDOWN_HTML_CACHE.size >= MARKDOWN_HTML_CACHE_MAX) {
    // 简单 FIFO：删最早插入的一条
    const first = MARKDOWN_HTML_CACHE.keys().next().value;
    if (first !== undefined) MARKDOWN_HTML_CACHE.delete(first);
  }
  MARKDOWN_HTML_CACHE.set(key, html);
  return html;
}

function parseMarkdownToHtmlUncached(raw: string): string {
  if (!raw) return '';
  let text = stripThoughtPlaceholders(raw);
  if (!text) return '';

  // 去掉对话里无意义的水平线（--- / *** / ___）
  text = text.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n');

  // 保护代码块（highlight.js 着色）
  const fences: string[] = [];
  text = text.replace(/```(\w*)\r?\n([\s\S]*?)```/g, (_, lang, code) => {
    const i = fences.length;
    const body = code.replace(/\n$/, '');
    const langClean = String(lang || '').trim();
    let inner: string;
    try {
      inner = highlightCode(body, langClean);
    } catch {
      inner = escapeHtml(body);
    }
    // 容器 + 复制按钮；data-copy 存原始代码（属性转义）
    fences.push(
      `<div class="md-code-block"><button type="button" class="md-code-copy" data-copy="${escapeHtml(body)}" title="复制">复制</button><pre class="md-code-pre hljs"><code class="language-${escapeHtml(langClean)}">${inner}</code></pre></div>`,
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

  // 链接与路径 → 占位，escape 后再还原
  const inlines: string[] = [];
  const pushInline = (html: string) => {
    const i = inlines.length;
    inlines.push(html);
    return `%%INLINE${i}%%`;
  };

  // 链接 [t](u) — 本地路径走侧栏打开
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    const url = String(u || '');
    if (isLocalPathRef(url) || isLocalPathRef(t)) {
      const path = isLocalPathRef(url) ? url : t;
      return pushInline(
        `<button type="button" class="md-path-link" data-path="${escapeHtml(path)}" title="${escapeHtml(path)}">${escapeHtml(t)}</button>`,
      );
    }
    return pushInline(
      `<a class="md-a" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(t)}</a>`,
    );
  });

  // 裸路径：盘符 / 相对路径 / monorepo 前缀
  text = text.replace(
    /(?<!["`>])((?:[A-Za-z]:[\\/]|\/|~\/|\.\.?\/|apps\/|packages\/|src\/)[^\s`"'<>|]{2,160}\.[A-Za-z0-9]{1,12})/g,
    (full, path: string) => {
      if (path.length > 160) return full;
      return pushInline(
        `<button type="button" class="md-path-link" data-path="${escapeHtml(path)}" title="${escapeHtml(path)}">${escapeHtml(path)}</button>`,
      );
    },
  );

  // 其余文本 escape
  let html = text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (
        t.startsWith('<img ') ||
        t.startsWith('%%FENCE') ||
        t.startsWith('%%TABLE') ||
        t.startsWith('%%INLINE')
      ) {
        return line;
      }
      return escapeHtml(line);
    })
    .join('\n');

  // 还原代码块、表格、内联
  html = html.replace(/%%FENCE(\d+)%%/g, (_, i) => fences[Number(i)] || '');
  html = html.replace(/%%TABLE(\d+)%%/g, (_, i) => tables[Number(i)] || '');
  html = html.replace(/%%INLINE(\d+)%%/g, (_, i) => inlines[Number(i)] || '');

  // 行内格式（仅作用于非标签片段时仍可能影响属性——表格已完整 HTML）
  html = applyInline(html);

  // 标题 # ## ###
  html = html.replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, content) => {
    const level = Math.min(hashes.length, 4);
    return `<h${level} class="md-h${level}">${content}</h${level}>`;
  });

  // 对话流不渲染 --- 分隔线（模型爱刷，干扰阅读）
  html = html.replace(/^---+$/gm, '');

  // 列表项之间的空行压成单换行，避免 split(/\n{2,}/) 把列表拆成多块、间距翻倍
  {
    let prev = '';
    while (prev !== html) {
      prev = html;
      html = html.replace(
        /^([ \t]*(?:[-*]|\d+\.)[ \t]+[^\n]+)\n\n+(?=[ \t]*(?:[-*]|\d+\.)[ \t]+)/gm,
        '$1\n',
      );
    }
  }
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

  // 合并连续 li。注意：不要用 \s* 吞掉列表后的空行，否则会和前后段落粘成一块 <p>
  html = html.replace(
    /(?:<li class="md-li[^"]*">[\s\S]*?<\/li>(?:[ \t]*\r?\n)?)+/g,
    (block) => {
      const compact = block.replace(/>\s*</g, '><').replace(/\s+$/g, '');
      const tag = compact.includes('md-ol-item') ? 'ol' : 'ul';
      const cls = compact.includes('md-ol-item') ? 'md-ol' : 'md-ul';
      // 两侧补空行，保证后续按段落切开
      return `\n\n<${tag} class="${cls}">${compact}</${tag}>\n\n`;
    },
  );

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
        t.startsWith('<div class="md-table') ||
        t.startsWith('<div class="md-code-block')
      ) {
        return t;
      }
      // 块内若仍混有块级列表，拆开，禁止 <p><ul>…
      if (t.includes('<ul') || t.includes('<ol')) {
        return t
          .replace(/(<\/?(?:ul|ol)[^>]*>)/g, '\n$1\n')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            if (line.startsWith('<ul') || line.startsWith('<ol') || line.startsWith('</')) {
              return line;
            }
            return `<p class="md-p">${line.replace(/\n/g, '<br />')}</p>`;
          })
          .join('');
      }
      // 单换行 → <br>
      const inner = t.replace(/\n/g, '<br />');
      return `<p class="md-p">${inner}</p>`;
    })
    .join('\n');

  return html;
}
