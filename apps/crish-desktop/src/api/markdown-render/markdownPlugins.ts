/**
 * Markdown 语法插件扩展、代码高亮、列表与代码块解析
 */

import { highlightCode } from '../codeHighlight';
import { escapeHtml, stripThoughtPlaceholders } from '../markdownRenderLite';
import {
  isLocalPathRef,
  isSafeHref,
  isSafeImgSrc,
  linkDestinationUrl,
  sanitizeUrlCandidate,
  wrapCjkTextSegment,
} from './markdownSanitizer';
import { extractTables } from './markdownTable';

/** 列表缩进视觉宽度：Tab → 对齐到 4 列，避免 \t 嵌套错位 */
function visualIndent(ws: string): number {
  let n = 0;
  for (let i = 0; i < ws.length; i++) {
    if (ws[i] === '\t') n += 4 - (n % 4);
    else n += 1;
  }
  return n;
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
export function applyInline(html: string): string {
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

export type ListKind = 'ul' | 'ol' | 'task';

export type MatchedListItem = {
  indent: number;
  kind: ListKind;
  taskChecked?: boolean;
  content: string;
  /** 有序列表原始序号（用于 start 属性） */
  olStart?: number;
};

export function matchListItem(line: string): MatchedListItem | null {
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

export function isIndentedContinuation(line: string, baseIndent: number): boolean {
  if (!line.trim()) return false;
  // 续行：视觉缩进严格大于列表基线（Tab 按 4 列展开）
  const m = line.match(/^(\s+)/);
  if (!m) return false;
  return visualIndent(m[1] ?? '') > baseIndent;
}

export function renderListItemHtml(
  kind: ListKind,
  content: string,
  taskChecked?: boolean
): string {
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
 * 行级列表块解析：松散列表、缩进续行、一级嵌套列表收进同一结构
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
        let j = i + 1;
        while (j < lines.length && !lines[j]!.trim()) j += 1;
        if (j >= lines.length) break;
        const nextItem = matchListItem(lines[j]!);
        if (nextItem && nextItem.indent <= baseIndent + 8) {
          i = j;
          continue;
        }
        if (isIndentedContinuation(lines[j]!, baseIndent)) {
          cur.content += `<br />${lines[j]!.trim()}`;
          i = j + 1;
          continue;
        }
        break;
      }

      const item = matchListItem(line);
      if (item) {
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
export function langFromFenceInfo(info: string): string {
  const raw = (String(info || '').trim().split(/\s+/)[0] ?? '')
    .replace(/^language-/, '')
    .replace(/^\./, '');
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
export function extractFilePathFromFenceInfo(info: string): string {
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
  const langBadge = langClean
    ? `<span class="md-code-lang" data-lang="${escapeHtml(langClean)}" aria-label="${escapeHtml(langClean)}">${escapeHtml(langClean)}</span>`
    : '';
  const blockAttr = langClean ? ` data-lang="${escapeHtml(langClean)}"` : '';
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
  return `<div class="md-code-block"${blockAttr}>${breadcrumb}${langBadge}<button type="button" class="md-code-copy" aria-label="复制代码">复制</button><pre class="md-code-pre hljs"><code class="language-${escapeHtml(langClean)}">${inner}</code></pre></div>`;
}

/**
 * 抽出 fenced code：闭合 ```…```，以及文末未闭合 fence（流式输出中间态）。
 */
function extractCodeFences(text: string): {
  text: string;
  fences: string[];
} {
  const fences: string[] = [];
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
  out = out.replace(/```([^\n`]*)\r?\n([\s\S]*)$/, (full, info, code) => {
    if (/(^|\n)```/.test(code)) return full;
    const i = fences.length;
    const langClean = langFromFenceInfo(info);
    const filePath = extractFilePathFromFenceInfo(info);
    fences.push(buildCodeFenceHtml(code, langClean, filePath));
    return `\n%%FENCE${i}%%\n`;
  });
  return { text: out, fences };
}

const MAX_MARKDOWN_INPUT = 100_000;

export function parseMarkdownToHtmlUncached(raw: string): string {
  if (raw == null || raw === '') return '';
  let source = typeof raw === 'string' ? raw : String(raw);
  if (!source.trim()) return '';
  if (source.length > MAX_MARKDOWN_INPUT)
    source = source.slice(0, MAX_MARKDOWN_INPUT);
  let text = stripThoughtPlaceholders(
    source.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  );
  if (!text) return '';

  text = text.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n');

  const extractedFences = extractCodeFences(text);
  text = extractedFences.text;
  const fences = extractedFences.fences;

  const extracted = extractTables(text);
  text = extracted.text;
  const tables = extracted.tables;

  const inlines: string[] = [];
  const pushInline = (htmlFrag: string) => {
    const i = inlines.length;
    inlines.push(htmlFrag);
    return `%%INLINE${i}%%`;
  };

  const renderImgFromDest = (alt: string, rawDest: string): string => {
    const rawSrc = linkDestinationUrl(rawDest);
    if (!isSafeImgSrc(rawSrc)) {
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
        `<button type="button" class="md-path-link" data-path="${escapeHtml(path)}">${escapeHtml(t)}</button>`
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

  text = text.replace(
    /!\[([^\]]{0,2000})\]\(\s*<([^>\n]{0,2000})>\s*(?:(["'])[\s\S]{0,2000}?\3\s*)?\)/g,
    (_m, alt: string, dest: string) => renderImgFromDest(alt, dest)
  );
  text = text.replace(
    /\[([^\]]{1,2000})\]\(\s*<([^>\n]{0,2000})>\s*(?:(["'])[\s\S]{0,2000}?\3\s*)?\)/g,
    (_m, t: string, dest: string) => renderLinkFromDest(t, dest)
  );

  text = text.replace(
    /!\[([^\]]{0,2000})\]\(([^)]{1,10000})\)/g,
    (_m, alt: string, rawDest: string) => renderImgFromDest(alt, rawDest)
  );
  text = text.replace(
    /\[([^\]]{1,2000})\]\(([^)]{1,10000})\)/g,
    (_m, t: string, rawDest: string) => renderLinkFromDest(t, rawDest)
  );

  text = text.replace(
    /(?<!["`>])((?:[A-Za-z]:[\\/]|\/|~\/|\.\.?\/|apps\/|packages\/|src\/)[^\s`"'<>|]{2,160}\.[A-Za-z0-9]{1,12})/g,
    (full, path: string) => {
      if (path.length > 160) return full;
      return pushInline(
        `<button type="button" class="md-path-link" data-path="${escapeHtml(path)}">${escapeHtml(path)}</button>`
      );
    }
  );

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

  html = html.replace(/%%INLINE(\d+)%%/g, (_, i) => inlines[Number(i)] || '');
  html = applyInline(html);

  html = html.replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, content) => {
    const level = Math.min(hashes.length, 4);
    return `<h${level} class="md-h${level}">${content}</h${level}>`;
  });

  html = html.replace(/^---+$/gm, '');
  html = processListBlocks(html);

  html = html.replace(/%%FENCE(\d+)%%/g, (_, i) => fences[Number(i)] || '');
  html = html.replace(/%%TABLE(\d+)%%/g, (_, i) => tables[Number(i)] || '');

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
      const inner = t.replace(/\n/g, '<br />');
      return `<p class="md-p">${inner}</p>`;
    })
    .join('\n');

  return html;
}
