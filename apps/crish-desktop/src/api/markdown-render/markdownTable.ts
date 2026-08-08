/**
 * Markdown GFM 表格解析与 HTML table 转换
 */

import { escapeHtml } from '../markdownRenderLite';
import { wrapCjkTextSegment } from './markdownSanitizer';

export function isTableSepLine(line: string): boolean {
  // | --- | :---: | ---: | 或 ---|---（至少两列分隔，避免把 --- 水平线当表）
  const t = line.trim();
  if (!t) return false;
  // 分隔行不用转义管道语义；去掉首尾 | 后按 | 切
  const core = t.replace(/^\|/, '').replace(/\|$/, '');
  const cells = core
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (cells.length < 2) return false;
  return cells.every((c) => /^:?-{2,}:?$/.test(c));
}

export function isTableRowLine(line: string): boolean {
  const t = line.trim();
  if (!t.includes('|')) return false;
  if (isTableSepLine(t)) return false;
  // 至少一处 | 且有实际单元格文字（全空 | | | 不当表体行，便于收尾）
  return (
    (t.match(/\|/g) || []).length >= 1 && t.replace(/\|/g, '').trim().length > 0
  );
}

/**
 * 切分表格单元格；支持 `\|` 转义管道（计入单元格正文，不作为列界）。
 * 尾部孤立 `\` 保留原样。
 */
export function splitTableCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && i + 1 < t.length && t[i + 1] === '|') {
      cur += '|';
      i += 1;
      continue;
    }
    if (t[i] === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** 从 GFM 分隔行解析列对齐：--- / :--- / ---: / :---: */
export function parseTableAlignments(
  sepLine: string
): Array<'left' | 'center' | 'right'> {
  return splitTableCells(sepLine).map((c) => {
    const t = c.trim();
    // 忽略单元格内误写的转义残留，只看 : 与 -
    const norm = t.replace(/\\/g, '');
    const left = norm.startsWith(':');
    const right = norm.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

function tableCellAlignAttr(
  align: 'left' | 'center' | 'right' | undefined
): string {
  // 白名单：禁止把任意字符串写入 style
  if (align === 'center' || align === 'right') {
    return ` style="text-align:${align}"`;
  }
  return '';
}

/** 对齐数组对齐到 colCount（缺列补 left，多余截断） */
function normalizeAlignments(
  aligns: Array<'left' | 'center' | 'right'>,
  colCount: number
): Array<'left' | 'center' | 'right'> {
  const out: Array<'left' | 'center' | 'right'> = [];
  for (let i = 0; i < colCount; i++) {
    out.push(aligns[i] ?? 'left');
  }
  return out;
}

function formatMarkdownTextSegment(text: string): string {
  if (!text) return '';
  const codes: string[] = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    const i = codes.length;
    codes.push(`<code class="md-inline-code">${code}</code>`);
    return `%%CODE${i}%%`;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(
    /(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g,
    (full, inner: string) => {
      const t = inner.trim();
      if (!t || t.length > 80) return full;
      if (/\s{2,}/.test(inner)) return full;
      return `<em>${inner}</em>`;
    }
  );
  s = s.replace(/%%CODE(\d+)%%/g, (_, i) => codes[Number(i)] || '');
  return wrapCjkTextSegment(s);
}

function applyInline(html: string): string {
  if (!html) return '';
  return html.replace(
    /(^|>)([^<]*)/g,
    (_full, prefix: string, text: string) => {
      return prefix + formatMarkdownTextSegment(text);
    }
  );
}

/**
 * 将 GFM 表格块转为 HTML table（在 escape 之前用占位符保护）。
 */
export function extractTables(text: string): { text: string; tables: string[] } {
  const tables: string[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (
      i + 1 < lines.length &&
      isTableRowLine(lines[i]!) &&
      isTableSepLine(lines[i + 1]!)
    ) {
      const header = splitTableCells(lines[i]!);
      const rawAligns = parseTableAlignments(lines[i + 1]!);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRowLine(lines[i]!)) {
        rows.push(splitTableCells(lines[i]!));
        i += 1;
      }
      const colCount = header.length;
      const aligns = normalizeAlignments(rawAligns, colCount);
      const th = header
        .map((c, ci) => {
          const align = aligns[ci];
          return `<th class="md-th" scope="col"${tableCellAlignAttr(align)}>${applyInline(escapeHtml(c))}</th>`;
        })
        .join('');
      const trs = rows
        .map((row, ri) => {
          const cells = [...row];
          while (cells.length < colCount) cells.push('');
          const stripe = ri % 2 === 1 ? ' md-tr-alt' : '';
          return `<tr class="md-tr${stripe}">${cells
            .slice(0, colCount)
            .map((c, ci) => {
              const align = aligns[ci];
              return `<td class="md-td"${tableCellAlignAttr(align)}>${applyInline(escapeHtml(c))}</td>`;
            })
            .join('')}</tr>`;
        })
        .join('');
      const html = `<div class="md-table-wrap" role="region" aria-label="表格"><table class="md-table"><thead><tr class="md-tr">${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
      const idx = tables.length;
      tables.push(html);
      out.push(`%%TABLE${idx}%%`);
      if (i < lines.length && lines[i]!.trim() !== '') {
        // keep going
      }
      continue;
    }
    out.push(lines[i]!);
    i += 1;
  }

  return { text: out.join('\n'), tables };
}
