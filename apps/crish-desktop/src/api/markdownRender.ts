/**
 * 对话正文 Markdown → 安全 HTML（正式版紧凑排版）。
 */

import { highlightCode } from './codeHighlight';
import {
  clearMarkdownHtmlCache,
  getMarkdownHtmlCache,
  markdownHtmlCacheSize,
  setMarkdownHtmlCache,
} from './markdownCache';
import { escapeHtml, stripThoughtPlaceholders } from './markdownRenderLite';

// 缓存 API 再导出，保持既有 import 路径稳定
export { clearMarkdownHtmlCache, markdownHtmlCacheSize };
// 轻量 API 再导出，保持既有 import 路径兼容（Chat 行请直接用 markdownRenderLite）
export { escapeHtml, stripThoughtPlaceholders } from './markdownRenderLite';

/**
 * 剥控制符 / BOM / 零宽 / bidi 覆盖，防止 smuggle `javascript:` 等危险 scheme。
 * 用于 href/src 安全判定前的归一化（不改变展示用原文 escape 路径）。
 */
function sanitizeUrlCandidate(url: string): string {
  return String(url ?? '')
    .replace(
      // eslint-disable-next-line no-control-regex -- intentional sanitization of C0 controls
      /[\u0000-\u001f\u007f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g,
      ''
    )
    .trim();
}

/**
 * 生成 scheme 判定用变体：原文 + 至多 2 次 decodeURIComponent。
 * 捕获 `javascript%3A` / `java%09script:` 等百分号走私；写入属性仍用调用方 sanitize 后的原文。
 */
function urlSafetyVariants(url: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (u: string) => {
    const s = sanitizeUrlCandidate(u);
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  add(url);
  let cur = String(url ?? '');
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(cur);
      if (decoded === cur) break;
      cur = decoded;
      add(decoded);
    } catch {
      break;
    }
  }
  return out;
}

function hasEmbeddedUrlWhitespace(t: string): boolean {
  return /[\s\u00a0\u3000]/.test(t);
}

/**
 * 危险 scheme：javascript: / data:text/html / vbscript: 等不得写入 href/src。
 * 允许：http(s)、mailto、相对/本地路径（无 scheme 或 # 锚点）。
 * 任一 decode 变体含危险 scheme 或内嵌空白 → 拒绝。
 */
function isSafeHref(url: string): boolean {
  const variants = urlSafetyVariants(url);
  if (!variants.length) return false;
  for (const t of variants) {
    if (hasEmbeddedUrlWhitespace(t)) return false;
  }
  const primary = variants[0]!;
  if (primary.startsWith('#')) return true;
  for (const t of variants) {
    if (/^https?:\/\//i.test(t) || /^mailto:/i.test(t)) return true;
  }
  // 任意变体带其它 scheme（含 javascript: / data: / vbscript: / 百分号解码后）一律拒绝
  for (const t of variants) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return false;
  }
  return true;
}

/**
 * 图片 src：http(s) / 相对路径 / 光栅 data:image（png/jpeg/gif/webp/avif/bmp）。
 * 拒绝 data:text/html、data:image/svg+xml（可内嵌脚本）及其它 scheme。
 * 百分号解码变体参与判定，防止 data%3Aimage/svg+xml 等走私。
 */
function isSafeImgSrc(url: string): boolean {
  const variants = urlSafetyVariants(url);
  if (!variants.length) return false;
  for (const t of variants) {
    if (hasEmbeddedUrlWhitespace(t)) return false;
  }
  for (const t of variants) {
    if (/^https?:\/\//i.test(t)) return true;
    // 仅安全光栅；分号或逗号起 payload（;base64, / ,raw）
    if (/^data:image\/(png|jpe?g|gif|webp|avif|bmp)[;,]/i.test(t)) return true;
  }
  for (const t of variants) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return false;
  }
  return true;
}

function isLocalPathRef(s: string): boolean {
  const variants = urlSafetyVariants(s);
  const t = variants[0] ?? sanitizeUrlCandidate(s);
  if (!t) return false;
  // 任一变体已是 http(s)/mailto 或危险 scheme → 非本地路径
  for (const v of variants) {
    if (/^https?:\/\//i.test(v) || /^mailto:/i.test(v)) return false;
    if (/^(javascript|vbscript|data):/i.test(v)) return false;
  }
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (
    t.startsWith('/') ||
    t.startsWith('~/') ||
    t.startsWith('./') ||
    t.startsWith('../')
  )
    return true;
  if (/^(apps|packages|src|docs)\//.test(t)) return true;
  if (
    /\.(ts|tsx|js|jsx|css|md|json|rs|py|toml|yml|yaml)$/i.test(t) &&
    !t.includes('://')
  )
    return true;
  return false;
}

/**
 * 窄屏 CJK 断行：在标签外文本插入 <wbr>。
 * - CJK ↔ 拉丁/数字/路径字符边界
 * - 长纯 CJK 串每隔 10 字（表格窄列、列表长句）
 */
function wrapCjkTextSegment(text: string): string {
  let s = text
    .replace(
      /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])([A-Za-z0-9@._/\\-])/g,
      '$1<wbr>$2'
    )
    .replace(
      /([A-Za-z0-9@._/\\-])([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g,
      '$1<wbr>$2'
    );
  s = s.replace(
    /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{10})(?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g,
    '$1<wbr>'
  );
  return s;
}

/** 列表缩进视觉宽度：Tab → 对齐到 4 列，避免 \\t 嵌套错位 */
function visualIndent(ws: string): number {
  let n = 0;
  for (let i = 0; i < ws.length; i++) {
    if (ws[i] === '\t') n += 4 - (n % 4);
    else n += 1;
  }
  return n;
}

/** 从 markdown 链目标字符串取出 URL（去掉可选 title；支持尖括号） */
function linkDestinationUrl(raw: string): string {
  let dest = String(raw ?? '').trim();
  if (!dest) return '';
  // <http://...> 或残缺 `<javascript:alert(1`（无闭合 > 时仍剥开头 <，避免当相对路径放行）
  if (dest.startsWith('<')) {
    const end = dest.indexOf('>');
    if (end > 0) return dest.slice(1, end).trim();
    dest = dest.slice(1).trim();
  }
  // url "title" / url 'title'
  const titled = dest.match(/^(\S+)\s+["'][\s\S]*["']\s*$/);
  if (titled) return titled[1] ?? dest;
  // 无 title：整段（可含 alert(1) 的括号）视为 URL，仅在空白处截断首 token
  if (!/\s/.test(dest)) return dest;
  return dest.split(/\s+/)[0] || dest;
}

function isTableSepLine(line: string): boolean {
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

function isTableRowLine(line: string): boolean {
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
function splitTableCells(line: string): string[] {
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
function parseTableAlignments(
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
      // 对齐列数；单元格 escape 后再套行内格式 + CJK 断行（表格在列表解析后才还原）
      const colCount = header.length;
      const aligns = normalizeAlignments(rawAligns, colCount);
      const th = header
        .map((c, ci) => {
          const align = aligns[ci];
          return `<th class="md-th" scope="col"${tableCellAlignAttr(align)}>${applyInline(escapeHtml(c))}</th>`;
        })
        .join('');
      // 无表体时仍输出空 tbody，保证 DOM 稳定；短行 pad、长行截断
      const trs = rows
        .map((row, ri) => {
          const cells = [...row];
          while (cells.length < colCount) cells.push('');
          const stripe = ri % 2 === 1 ? ' md-tr-alt' : '';
          return `<tr class="md-tr${stripe}">${cells
            .slice(0, colCount)
            .map((c, ci) => {
              const align = aligns[ci];
              // 空单元格保持空 td（不插 &nbsp;，避免复制噪音）
              return `<td class="md-td"${tableCellAlignAttr(align)}>${applyInline(escapeHtml(c))}</td>`;
            })
            .join('')}</tr>`;
        })
        .join('');
      const html = `<div class="md-table-wrap" role="region" aria-label="表格"><table class="md-table"><thead><tr class="md-tr">${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
      const idx = tables.length;
      tables.push(html);
      out.push(`%%TABLE${idx}%%`);
      // 表格后补空行，方便段落切分
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

/**
 * 纯文本段行内格式：code 占位保护后再 bold/italic，最后 CJK wbr。
 * 不处理 HTML 标签；由 applyInline 按标签外文本切分调用。
 */
function formatMarkdownTextSegment(text: string): string {
  if (!text) return '';
  const codes: string[] = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    const i = codes.length;
    codes.push(`<code class="md-inline-code">${code}</code>`);
    return `%%CODE${i}%%`;
  });
  // 粗体先于斜体；斜体仅同行、非空，避免未闭合 * 吞掉整段
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // 斜体：开口 * 后不能是空白（否则与「* 列表项」冲突，会吞掉列表标记并留下残片）
  s = s.replace(
    /(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g,
    (full, inner: string) => {
      const t = inner.trim();
      // 过长或像整句未闭合时不套 em（防止 * 与远处 * 配对）
      if (!t || t.length > 80) return full;
      if (/\s{2,}/.test(inner)) return full;
      return `<em>${inner}</em>`;
    }
  );
  s = s.replace(/%%CODE(\d+)%%/g, (_, i) => codes[Number(i)] || '');
  return wrapCjkTextSegment(s);
}

/**
 * 行内格式：仅处理标签外文本，避免
 * - 破坏已还原的 <a href> / <img src> 属性（* 被当成斜体）
 * - 把 code 内的 * 再套 <em>
 */
function applyInline(html: string): string {
  if (!html) return '';
  // 无标签时仍走 CJK 快路径（format 内也会 wbr）
  return html.replace(
    /(^|>)([^<]*)/g,
    (_full, prefix: string, text: string) => {
      return prefix + formatMarkdownTextSegment(text);
    }
  );
}

/**
 * 无序列表 / 任务列表行（- * +；任务列表 [ ] / [x]）。
 * 允许 `- ` / `-` 空项（内容可空），避免 trim 后空 li 丢失。
 */
const RE_UL_ITEM = /^(\s*)([-*+])(?:\s+(?:\[([ xX])\]\s+)?(.*))?$/;
/** 有序列表行（捕获起始序号，供 start= 使用；允许 `1.` 空项） */
const RE_OL_ITEM = /^(\s*)(\d+)\.(?:\s+(.*))?$/;

type ListKind = 'ul' | 'ol' | 'task';

type MatchedListItem = {
  indent: number;
  kind: ListKind;
  taskChecked?: boolean;
  content: string;
  /** 有序列表原始序号（用于 start 属性） */
  olStart?: number;
};

function matchListItem(line: string): MatchedListItem | null {
  const ul = line.match(RE_UL_ITEM);
  if (ul) {
    const indent = visualIndent(ul[1]!);
    const content = ul[4] ?? '';
    if (ul[3] !== undefined) {
      return {
        indent,
        kind: 'task',
        taskChecked: ul[3].toLowerCase() === 'x',
        content,
      };
    }
    return { indent, kind: 'ul', content };
  }
  const ol = line.match(RE_OL_ITEM);
  if (ol) {
    const n = parseInt(ol[2]!, 10);
    return {
      indent: visualIndent(ol[1]!),
      kind: 'ol',
      content: ol[3] ?? '',
      olStart: Number.isFinite(n) && n > 0 ? n : 1,
    };
  }
  return null;
}

function isIndentedContinuation(line: string, baseIndent: number): boolean {
  if (!line.trim()) return false;
  // 续行：视觉缩进严格大于列表基线（Tab 按 4 列展开）
  const m = line.match(/^(\s+)/);
  if (!m) return false;
  return visualIndent(m[1] ?? '') > baseIndent;
}

function renderListItemHtml(
  kind: ListKind,
  content: string,
  taskChecked?: boolean
): string {
  // 空内容仍输出合法 li，避免松散空项被丢弃造成序号错位
  if (kind === 'task') {
    const done = taskChecked ? ' done' : '';
    const box = taskChecked ? ' checked' : '';
    return `<li class="md-li md-task-item${done}"><span class="md-task-box${box}"></span>${content}</li>`;
  }
  if (kind === 'ol') {
    return `<li class="md-li md-ol-item">${content}</li>`;
  }
  return `<li class="md-li">${content}</li>`;
}

/**
 * 行级列表块解析：松散列表、缩进续行、一级嵌套列表收进同一结构，
 * 避免多项被拆成多个单元素列表（窄屏下像「大列表 + 浮层小列表」重影）。
 */
function processListBlocks(html: string): string {
  const lines = html.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const head = matchListItem(lines[i]!);
    if (!head) {
      out.push(lines[i]!);
      i += 1;
      continue;
    }

    // 收集连续列表区（允许空行；续行并入当前项；更深缩进为嵌套）
    type Item = {
      kind: ListKind;
      content: string;
      taskChecked?: boolean;
      indent: number;
      children: Item[];
      olStart?: number;
    };
    const items: Item[] = [];
    let cur: Item = {
      kind: head.kind,
      content: head.content,
      indent: head.indent,
      children: [],
      ...(head.taskChecked !== undefined && { taskChecked: head.taskChecked }),
      ...(head.olStart !== undefined && { olStart: head.olStart }),
    };
    const baseIndent = head.indent;
    i += 1;

    while (i < lines.length) {
      const line = lines[i]!;
      const trimmed = line.trim();

      if (!trimmed) {
        // 空行：若后面仍是列表项或续行，视为松散列表内部空白
        let j = i + 1;
        while (j < lines.length && !lines[j]!.trim()) j += 1;
        if (j >= lines.length) break;
        const nextItem = matchListItem(lines[j]!);
        if (nextItem && nextItem.indent <= baseIndent + 8) {
          i = j;
          continue;
        }
        if (isIndentedContinuation(lines[j]!, baseIndent)) {
          // 空行 + 续段 → 项内换行
          cur.content += `<br />${lines[j]!.trim()}`;
          i = j + 1;
          continue;
        }
        break;
      }

      const item = matchListItem(line);
      if (item) {
        // 同级：缩进 ≤ base+1（常见 0）
        if (item.indent <= baseIndent + 1) {
          items.push(cur);
          cur = {
            kind: item.kind,
            content: item.content,
            indent: item.indent,
            children: [],
            ...(item.taskChecked !== undefined && { taskChecked: item.taskChecked }),
            ...(item.olStart !== undefined && { olStart: item.olStart }),
          };
          i += 1;
          continue;
        }
        // 嵌套（含多级）：按缩进挂到正确祖先的 children
        if (item.indent >= baseIndent + 2) {
          const node: Item = {
            kind: item.kind,
            content: item.content,
            indent: item.indent,
            children: [],
            ...(item.taskChecked !== undefined && { taskChecked: item.taskChecked }),
            ...(item.olStart !== undefined && { olStart: item.olStart }),
          };
          let parent: Item = cur;
          while (parent.children.length) {
            const last = parent.children[parent.children.length - 1]!;
            if (item.indent >= last.indent + 2) {
              parent = last;
            } else {
              break;
            }
          }
          parent.children.push(node);
          i += 1;
          continue;
        }
      }

      if (isIndentedContinuation(line, baseIndent)) {
        cur.content += `<br />${line.trim()}`;
        i += 1;
        continue;
      }

      // 非列表、非续行 → 结束本列表块
      break;
    }
    items.push(cur);

    const renderNested = (kids: Item[]): string => {
      if (!kids.length) return '';
      let segKind: 'ul' | 'ol' | null = null;
      let seg: string[] = [];
      let segStart: number | undefined;
      let htmlNest = '';
      const flushNest = () => {
        if (!seg.length || !segKind) return;
        const tag = segKind;
        const cls = tag === 'ol' ? 'md-ol md-ol-nested' : 'md-ul md-ul-nested';
        // 嵌套 ol 若从非 1 起号，保留 start
        const startAttr =
          tag === 'ol' && segStart != null && segStart > 1
            ? ` start="${segStart}"`
            : '';
        htmlNest += `<${tag} class="${cls}"${startAttr}>${seg.join('')}</${tag}>`;
        seg = [];
        segKind = null;
        segStart = undefined;
      };
      for (const k of kids) {
        const group: 'ul' | 'ol' = k.kind === 'ol' ? 'ol' : 'ul';
        if (segKind && segKind !== group) flushNest();
        if (!segKind) {
          segKind = group;
          segStart = k.olStart;
        }
        const childHtml = renderNested(k.children);
        const open =
          k.kind === 'task'
            ? `<li class="md-li md-task-item${k.taskChecked ? ' done' : ''}"><span class="md-task-box${k.taskChecked ? ' checked' : ''}"></span>${k.content}`
            : k.kind === 'ol'
              ? `<li class="md-li md-ol-item">${k.content}`
              : `<li class="md-li">${k.content}`;
        seg.push(`${open}${childHtml}</li>`);
      }
      flushNest();
      return htmlNest;
    };

    // 按 ul/ol 分段输出（task 归 ul）；避免 ul 项被错误包进 ol
    let segKind: 'ul' | 'ol' | null = null;
    let seg: string[] = [];
    let segStart: number | undefined;
    const flush = () => {
      if (!seg.length || !segKind) return;
      const tag = segKind;
      const cls = tag === 'ol' ? 'md-ol' : 'md-ul';
      const startAttr =
        tag === 'ol' && segStart != null && segStart > 1
          ? ` start="${segStart}"`
          : '';
      out.push('');
      out.push(`<${tag} class="${cls}"${startAttr}>${seg.join('')}</${tag}>`);
      out.push('');
      seg = [];
      segKind = null;
      segStart = undefined;
    };
    for (const it of items) {
      const group: 'ul' | 'ol' = it.kind === 'ol' ? 'ol' : 'ul';
      if (segKind && segKind !== group) flush();
      if (!segKind) {
        segKind = group;
        segStart = it.olStart;
      }
      const nested = renderNested(it.children);
      if (nested) {
        // 带嵌套：手动拼 li，把子列表塞进 li 内
        if (it.kind === 'task') {
          const done = it.taskChecked ? ' done' : '';
          const box = it.taskChecked ? ' checked' : '';
          seg.push(
            `<li class="md-li md-task-item${done}"><span class="md-task-box${box}"></span>${it.content}${nested}</li>`
          );
        } else if (it.kind === 'ol') {
          seg.push(`<li class="md-li md-ol-item">${it.content}${nested}</li>`);
        } else {
          seg.push(`<li class="md-li">${it.content}${nested}</li>`);
        }
      } else {
        seg.push(renderListItemHtml(it.kind, it.content, it.taskChecked));
      }
    }
    flush();
  }

  return out.join('\n');
}

/** fence info string → 语言 id（首 token；c++ 等别名归一） */
function langFromFenceInfo(info: string): string {
  const raw = (String(info || '').trim().split(/\s+/)[0] ?? '').replace(/^language-/, '').replace(/^\./, '');
  if (!raw) return '';
  const lower = raw.toLowerCase();
  const aliases: Record<string, string> = {
    'c++': 'cpp',
    'c#': 'csharp',
    cs: 'csharp',
    js: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    md: 'markdown',
    ps1: 'bash',
    powershell: 'bash',
  };
  return aliases[lower] || lower;
}

/** 从 fence info string 提取 file="…" 属性值 */
function extractFilePathFromFenceInfo(info: string): string {
  const m = String(info || '').match(/\bfile=(?:"([^"]*)"|(\S+))/);
  return m ? (m[1] ?? m[2] ?? '') : '';
}

function buildCodeFenceHtml(
  bodyRaw: string,
  langClean: string,
  filePath?: string
): string {
  const body = bodyRaw.replace(/\n$/, '');
  let inner: string;
  try {
    inner = highlightCode(body, langClean);
  } catch {
    inner = escapeHtml(body);
  }
  // 语言徽章：data-lang 供样式/选择；无语言时不渲染徽章（避免空 pill）
  const langBadge = langClean
    ? `<span class="md-code-lang" data-lang="${escapeHtml(langClean)}" aria-label="${escapeHtml(langClean)}">${escapeHtml(langClean)}</span>`
    : '';
  const blockAttr = langClean ? ` data-lang="${escapeHtml(langClean)}"` : '';
  // 文件路径面包屑
  let breadcrumb = '';
  if (filePath) {
    const segments = filePath.split('/');
    const parts = segments.map((s, i) => {
      const isLast = i === segments.length - 1;
      const cls = isLast
        ? 'md-code-breadcrumb-file'
        : 'md-code-breadcrumb-segment';
      return `<span class="${cls}">${escapeHtml(s)}</span>`;
    });
    breadcrumb = `<span class="md-code-breadcrumb">${parts.join('<span class="md-code-breadcrumb-separator">/</span>')}</span>`;
  }
  /* 不把正文塞进 data-copy（长代码会撑破属性/误显）；点击时从相邻 pre 取文本 */
  return `<div class="md-code-block"${blockAttr}>${breadcrumb}${langBadge}<button type="button" class="md-code-copy" title="复制" aria-label="复制代码">复制</button><pre class="md-code-pre hljs"><code class="language-${escapeHtml(langClean)}">${inner}</code></pre></div>`;
}

/**
 * 抽出 fenced code：闭合 ```…```，以及文末未闭合 fence（流式输出中间态）。
 * info string 取首词作语言（支持 `ts title="x"`）。
 */
function extractCodeFences(text: string): { text: string; fences: string[] } {
  const fences: string[] = [];
  // 闭合 fence：允许 info string（非换行）
  let out = text.replace(
    /```([^\n`]{0,500})\r?\n([\s\S]{0,50000}?)```/g,
    (_, info, code) => {
      const i = fences.length;
      const langClean = langFromFenceInfo(info);
      const filePath = extractFilePathFromFenceInfo(info);
      fences.push(buildCodeFenceHtml(code, langClean, filePath));
      return `\n%%FENCE${i}%%\n`;
    }
  );
  // 文末未闭合：```lang\n…（无收尾 ```）— 流式时仍渲染为代码块
  out = out.replace(/```([^\n`]*)\r?\n([\s\S]*)$/, (full, info, code) => {
    // 避免误伤：若 body 内又出现独立 ``` 行则放弃（残缺多 fence）
    if (/(^|\n)```/.test(code)) return full;
    const i = fences.length;
    const langClean = langFromFenceInfo(info);
    const filePath = extractFilePathFromFenceInfo(info);
    fences.push(buildCodeFenceHtml(code, langClean, filePath));
    return `\n%%FENCE${i}%%\n`;
  });
  return { text: out, fences };
}

/**
 * Markdown → 安全 HTML。相同 raw 重复渲染时走缓存。
 * 空 / 纯空白 / 仅噪音占位 → 恒为 ''（不写缓存键噪音）。
 */
export function parseMarkdownToHtml(raw: string): string {
  if (raw == null || raw === '') return '';
  const source = typeof raw === 'string' ? raw : String(raw);
  if (!source.trim()) return '';
  const hit = getMarkdownHtmlCache(source);
  if (hit !== undefined) return hit;
  const html = parseMarkdownToHtmlUncached(source);
  // 空结果不缓存，避免占位 key
  if (!html) return '';
  return setMarkdownHtmlCache(source, html);
}

const MAX_MARKDOWN_INPUT = 100_000;

function parseMarkdownToHtmlUncached(raw: string): string {
  if (raw == null || raw === '') return '';
  let source = typeof raw === 'string' ? raw : String(raw);
  if (!source.trim()) return '';
  if (source.length > MAX_MARKDOWN_INPUT)
    source = source.slice(0, MAX_MARKDOWN_INPUT);
  // 统一换行，避免 \r 干扰列表/表格行匹配
  let text = stripThoughtPlaceholders(
    source.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  );
  if (!text) return '';

  // 去掉对话里无意义的水平线（--- / *** / ___）
  text = text.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n');

  // 保护代码块（highlight.js 着色 + 语言标签；支持 info string / 流式未闭合 fence）
  const extractedFences = extractCodeFences(text);
  text = extractedFences.text;
  const fences = extractedFences.fences;

  // 表格（在 escape 前抽出，单元格内再 escape）
  const extracted = extractTables(text);
  text = extracted.text;
  const tables = extracted.tables;

  // 链接 / 图片 / 裸路径 → 占位，escape 后再还原（图片也必须占位，否则行中 img 被 escapeHtml 打碎并被路径正则误伤）
  const inlines: string[] = [];
  const pushInline = (htmlFrag: string) => {
    const i = inlines.length;
    inlines.push(htmlFrag);
    return `%%INLINE${i}%%`;
  };

  const renderImgFromDest = (alt: string, rawDest: string): string => {
    const rawSrc = linkDestinationUrl(rawDest);
    if (!isSafeImgSrc(rawSrc)) {
      // 降级为纯文本；后续行级 escapeHtml 再转义，避免双重 escape
      return alt ? String(alt) : rawSrc;
    }
    const src = sanitizeUrlCandidate(rawSrc);
    return pushInline(
      `<img class="md-img" src="${escapeHtml(src)}" alt="${escapeHtml(alt || '')}" loading="lazy" />`
    );
  };

  const renderLinkFromDest = (t: string, rawDest: string): string => {
    const rawUrl = linkDestinationUrl(rawDest);
    if (isLocalPathRef(rawUrl) || isLocalPathRef(t)) {
      const pathRaw = isLocalPathRef(rawUrl) ? rawUrl : t;
      const path = sanitizeUrlCandidate(pathRaw) || pathRaw;
      return pushInline(
        `<button type="button" class="md-path-link" data-path="${escapeHtml(path)}" title="${escapeHtml(path)}">${escapeHtml(t)}</button>`
      );
    }
    if (!isSafeHref(rawUrl)) {
      return pushInline(`<span class="md-a-unsafe">${escapeHtml(t)}</span>`);
    }
    const url = sanitizeUrlCandidate(rawUrl);
    return pushInline(
      `<a class="md-a" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(t)}</a>`
    );
  };

  // 尖括号目标优先：![alt](<url>) / [t](<url>)，允许 url 内含 `)`（CommonMark）
  text = text.replace(
    /!\[([^\]]{0,2000})\]\(\s*<([^>\n]{0,2000})>\s*(?:(["'])[\s\S]{0,2000}?\3\s*)?\)/g,
    (_m, alt: string, dest: string) => renderImgFromDest(alt, dest)
  );
  text = text.replace(
    /\[([^\]]{1,2000})\]\(\s*<([^>\n]{0,2000})>\s*(?:(["'])[\s\S]{0,2000}?\3\s*)?\)/g,
    (_m, t: string, dest: string) => renderLinkFromDest(t, dest)
  );

  // 普通目标：[^)]+ 可含零宽/BOM（再经 sanitize）；避免 [^)\s] 漏匹配
  text = text.replace(
    /!\[([^\]]{0,2000})\]\(([^)]{1,10000})\)/g,
    (_m, alt: string, rawDest: string) => renderImgFromDest(alt, rawDest)
  );
  text = text.replace(
    /\[([^\]]{1,2000})\]\(([^)]{1,10000})\)/g,
    (_m, t: string, rawDest: string) => renderLinkFromDest(t, rawDest)
  );

  // 裸路径：盘符 / 相对路径 / monorepo 前缀
  text = text.replace(
    /(?<!["`>])((?:[A-Za-z]:[\\/]|\/|~\/|\.\.?\/|apps\/|packages\/|src\/)[^\s`"'<>|]{2,160}\.[A-Za-z0-9]{1,12})/g,
    (full, path: string) => {
      if (path.length > 160) return full;
      return pushInline(
        `<button type="button" class="md-path-link" data-path="${escapeHtml(path)}" title="${escapeHtml(path)}">${escapeHtml(path)}</button>`
      );
    }
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

  // 先还原内联；代码块/表格仍用占位，避免 applyInline 与列表解析改写其内部的 -/* 行
  html = html.replace(/%%INLINE(\d+)%%/g, (_, i) => inlines[Number(i)] || '');

  // 行内格式（占位保护期内不会碰到 fence/table 正文）
  html = applyInline(html);

  // 标题 # ## ###
  html = html.replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, content) => {
    const level = Math.min(hashes.length, 4);
    return `<h${level} class="md-h${level}">${content}</h${level}>`;
  });

  // 对话流不渲染 --- 分隔线（模型爱刷，干扰阅读）
  html = html.replace(/^---+$/gm, '');

  // 行级列表块：松散列表 / 缩进续行合并为单一 ul|ol（禁止拆成多个单 li 列表）
  html = processListBlocks(html);

  // 列表与段落结构完成后再还原代码块、表格
  html = html.replace(/%%FENCE(\d+)%%/g, (_, i) => fences[Number(i)] || '');
  html = html.replace(/%%TABLE(\d+)%%/g, (_, i) => tables[Number(i)] || '');

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
      // 块内若仍混有块级列表，拆开，禁止 <p><ul>… 与 <p><li>…（浏览器会重排成重影列表）
      if (t.includes('<ul') || t.includes('<ol') || t.includes('<li')) {
        return t
          .replace(/(<\/?(?:ul|ol)[^>]*>)/g, '\n$1\n')
          .replace(/(<\/?li\b[^>]*>)/g, '\n$1\n')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            if (
              line.startsWith('<ul') ||
              line.startsWith('<ol') ||
              line.startsWith('<li') ||
              line.startsWith('</')
            ) {
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
