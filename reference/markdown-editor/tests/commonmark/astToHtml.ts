/**
 * CommonMark 合规基线轮（R0-B）：引擎 AST → 近似 HTML 投影器
 *
 * 契约（防作弊条款，详见同目录 README.md）：
 * 1. 零语义修复——不补语法、不改语义，只做结构映射。
 * 2. 引擎不支持的 CommonMark 语法（引用链接 / 自动链接 / 实体 /
 *    ~~~ 围栏 / HTML 块 / 下划线强调等）在 AST 中已退化为
 *    普通 text 节点，投影器按 text 规则原样转义输出；期望 <h2> 而投影
 *    <p>title</p> 即记 FAIL——这是符合度统计的正确行为，不得补偿。
 *    （Setext 标题 / 缩进代码块已由 R1 轮引擎原生支持，见 README。）
 * 3. 引擎扩展语法（math / mark / spoiler / footnote / checkbox）在 CommonMark
 *    中无对应 HTML，投影为占位标签（如 <span class="math">），显式暴露与
 *    CommonMark 文本渲染的差异（计 FAIL），不得折叠为纯文本掩盖差异。
 * 4. 行内原始 HTML（html_element / html_tag）按 CommonMark 语义原样透传
 *    （不转义、不重组），与 Raw HTML 章节的期望一致。
 * 5. 行级块结构全部为确定性映射；登记偏差点有「列表行按 listIndent
 *    启发式分组」与「缩进代码块合并」（见 README「偏差点登记」）。
 */
import type {
  MarkdownDocument,
  LineNode,
  InlineNode,
} from '../../src/core/ast';

/** 文本转义：& < >（与 CommonMark 渲染器的文本转义规则一致） */
export function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 属性值转义：& < > "（用于 href / alt / class 等属性） */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 从行原文中剥离行首的 blockquote 前缀（> 及其前导空白） */
function stripBlockquotePrefix(raw: string): string {
  let s = raw;
  let m: RegExpExecArray | null;
  while ((m = /^\s*>\s?/.exec(s))) {
    s = s.slice(m[0].length);
  }
  return s;
}

/** 围栏信息串（raw 中 ``` 之后的部分，已剥离引用前缀并 trim） */
function fenceInfo(raw: string): string {
  const s = stripBlockquotePrefix(raw);
  const m = /^```+(.*)$/.exec(s);
  return m ? m[1].trim() : '';
}

/**
 * 剥离 up to 4 列前导空白（CommonMark 缩进代码块内容规则）：
 * tab 按停靠 4 展开（与引擎 computeLineOffsets 的 leadingIndentColumns
 * 列宽语义一致，spec §Tabs）。不足 4 列或行尾残留的空白原样保留
 * （如 6 空格空白行 → 剥 4 列 → 内容保留 2 空格，对齐 spec 例 112）。
 */
function stripIndentColumns(s: string): string {
  let col = 0;
  let i = 0;
  while (i < s.length && col < 4) {
    if (s[i] === ' ') {
      col++;
      i++;
    } else if (s[i] === '\t') {
      col += 4 - (col % 4);
      i++;
    } else {
      break;
    }
  }
  return s.substring(i);
}

/**
 * 链接 url 字段拆分（CommonMark 渲染惯例）：destination + 可选 title。
 * 引擎的 link 正则把 "(dest "title")" 整体捕获进 url 字段，
 * 按 CommonMark 规则拆出 href 与 title 是投影的渲染惯例，非语义修复。
 */
export function splitLinkTarget(
  rawUrl: string
): { href: string; title?: string } {
  const u = rawUrl.trim();
  if (u.startsWith('<')) {
    const end = u.indexOf('>');
    if (end !== -1) {
      const href = u.slice(1, end);
      const rest = u.slice(end + 1).trim();
      return { href, title: parseTitle(rest) };
    }
  }
  const m = /^(\S+)(?:\s+(.+))?$/.exec(u);
  if (m) {
    return { href: m[1], title: parseTitle(m[2] ?? '') };
  }
  return { href: u };
}

/** 解析标题："..." / '...' / (...) 三种形式，无法解析返回 undefined */
function parseTitle(rest: string): string | undefined {
  if (!rest) return undefined;
  const m = /^(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))$/.exec(rest.trim());
  if (!m) return undefined;
  return m[1] ?? m[2] ?? m[3];
}

/** 从 image 节点的 raw（![alt](url)）中提取 alt 文本 */
function extractImageAlt(raw: string): string {
  const m = /^!\[((?:[^\]\\]|\\.)*)\]/.exec(raw);
  if (!m) return '';
  return m[1].replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

/** 内联节点 → HTML（结构令牌返回空串，由行级结构承担语义） */
function renderInline(t: InlineNode): string {
  // 行内原始 HTML：CommonMark 语义为原样透传。
  // 引擎 INLINE_RULES 在运行时还会产出未收录于 InlineType 联合类型的
  // 'html_tag' 令牌（无闭合标签的孤立 HTML 片段），一并按透传处理。
  if (t.type === 'html_element' || t.type === ('html_tag' as InlineNode['type'])) {
    return t.raw;
  }
  switch (t.type) {
    case 'text':
      return escapeText(t.content);
    case 'bold':
      return '<strong>' + inlineChildren(t) + '</strong>';
    case 'italic':
      return '<em>' + inlineChildren(t) + '</em>';
    // 加粗+斜体联合节点：按 CommonMark 参考实现惯例 <em><strong>
    case 'bold_italic':
      return '<em><strong>' + inlineChildren(t) + '</strong></em>';
    case 'strike':
      return '<del>' + inlineChildren(t) + '</del>';
    case 'mark':
      return '<mark>' + inlineChildren(t) + '</mark>';
    case 'spoiler':
      return '<span class="spoiler">' + inlineChildren(t) + '</span>';
    case 'kbd':
      return '<kbd>' + inlineChildren(t) + '</kbd>';
    case 'sub':
      return '<sub>' + inlineChildren(t) + '</sub>';
    case 'sup':
      return '<sup>' + inlineChildren(t) + '</sup>';
    case 'code':
      return '<code>' + escapeText(t.content) + '</code>';
    // 引擎扩展语法：CommonMark 无对应 HTML，占位标签显式暴露差异
    case 'math':
      return '<span class="math">' + escapeText(t.content) + '</span>';
    case 'footnote':
      return '<span class="footnote">' + escapeText(t.content) + '</span>';
    case 'link': {
      const { href, title } = splitLinkTarget(t.url ?? '');
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
      return `<a href="${escapeAttr(href)}"${titleAttr}>` +
        inlineChildren(t) +
        '</a>';
    }
    case 'image': {
      const { href, title } = splitLinkTarget(t.url ?? '');
      const alt = extractImageAlt(t.raw);
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
      return `<img src="${escapeAttr(href)}" alt="${escapeAttr(alt)}"${titleAttr} />`;
    }
    case 'checkbox':
      return t.isChecked
        ? '<input type="checkbox" checked="" disabled="" />'
        : '<input type="checkbox" disabled="" />';
    // 代码高亮令牌（仅存在于代码行内，代码行按 raw 投影故此处不产出）
    case 'comment':
    case 'string':
    case 'keyword':
      return escapeText(t.content);
    // 结构令牌：由行级结构承担语义，不输出
    case 'heading_prefix':
    case 'list_bullet':
    case 'list_number':
    case 'list_task':
    case 'blockquote_prefix':
    case 'table_pipe':
    case 'table_cell':
      return '';
    // 兜底：运行时出现的未知令牌类型按结构令牌跳过，不产生猜测性 HTML
    default:
      return '';
  }
}

/** 渲染内联节点的子内容：有 children 用 children，否则用转义后的 content */
function inlineChildren(t: InlineNode): string {
  if (t.children && t.children.length > 0) {
    return t.children.map(renderInline).join('');
  }
  return escapeText(t.content);
}

/** 行的内联令牌 → HTML（结构性令牌由 renderInline 自行跳过） */
function renderLineInline(line: LineNode): string {
  return line.inlineTokens.map(renderInline).join('');
}

/** 判断列表行种类：'ul'（项目符号 / 任务）| 'ol'（有序）| null（非列表行） */
function listKind(line: LineNode): 'ul' | 'ol' | null {
  for (const t of line.inlineTokens) {
    if (t.type === 'list_bullet' || t.type === 'list_task') return 'ul';
    if (t.type === 'list_number') return 'ol';
  }
  return null;
}

/** 有序列表起始序号（从 listPrefix 中取；<=1 时不输出 start 属性） */
function olStartNumber(line: LineNode): number {
  const n = parseInt(line.listPrefix ?? '', 10);
  return Number.isFinite(n) ? n : 1;
}

/**
 * 列表行启发式分组（登记偏差点一，详见 README「偏差点登记」）：
 * 连续、同种类（ul/ol）、同 listIndent、同引用层级的列表行归入一个列表容器，
 * 每行一个 <li>。引擎 AST 无列表容器节点，这是投影器侧的结构近似；
 * 嵌套列表 / 松散列表（loose/tight <p> 包裹）/ 多行列表项等语义
 * 引擎不承载，如实按简化结构投影（与 CommonMark 期望不同则计 FAIL）。
 */
function renderListGroup(lines: LineNode[], start: number, out: string[]): number {
  const first = lines[start];
  const kind = listKind(first);
  const indent = first.listIndent ?? 0;
  const bq = first.blockquoteLevel ?? 0;
  const items: string[] = [];
  let j = start;
  while (j < lines.length) {
    const ln = lines[j];
    if ((ln.blockquoteLevel ?? 0) !== bq) break;
    if (ln.listIndent === undefined || ln.listIndent !== indent) break;
    if (listKind(ln) !== kind) break;
    items.push('<li>' + renderLineInline(ln) + '</li>');
    j++;
  }
  if (kind === 'ol') {
    const n = olStartNumber(first);
    out.push(`<ol${n > 1 ? ` start="${n}"` : ''}>` + items.join('') + '</ol>');
  } else {
    out.push('<ul>' + items.join('') + '</ul>');
  }
  return j;
}

/** 表格行 → <tr><td>…</td></tr>（近似投影；CommonMark 无表格语义） */
function renderTableRow(line: LineNode): string {
  const cells = line.inlineTokens.filter((t) => t.type === 'table_cell');
  return (
    '<tr>' +
    cells
      .map(
        (c) =>
          '<td>' +
          (c.children ?? []).map(renderInline).join('') +
          '</td>'
      )
      .join('') +
    '</tr>'
  );
}

/** 围栏代码块：从 code_fence_start 消费到 code_fence_end，返回下一条行号 */
function renderFencedBlock(
  lines: LineNode[],
  start: number,
  out: string[]
): number {
  const info = fenceInfo(lines[start].raw);
  const lang = info ? info.split(/\s+/)[0] : '';
  const contentLines: string[] = [];
  let j = start + 1;
  while (j < lines.length && lines[j].type !== 'code_fence_end') {
    if (lines[j].type === 'code') {
      contentLines.push(stripBlockquotePrefix(lines[j].raw));
    }
    j++;
  }
  // CommonMark 序列化惯例：内容行以 \n 连接且以 \n 结尾（空块除外）
  const content =
    contentLines.join('\n') + (contentLines.length > 0 ? '\n' : '');
  out.push(
    '<pre><code' +
      (lang ? ` class="language-${escapeAttr(lang)}"` : '') +
      '>' +
      escapeText(content) +
      '</code></pre>'
  );
  return j + 1; // 跳过 code_fence_end
}

/**
 * 缩进代码块投影（登记偏差点，详见 README「偏差点登记」）：
 * 引擎 AST 无 codeBlockState 字段（围栏内内容行与缩进代码行同为
 * type==='code'），但围栏内行已由 renderFencedBlock 消费，主循环遇到的
 * 连续 type==='code' 行必然来自缩进代码块（含块内空白行，引擎状态机
 * inIndentCode 保持语义）——以此作为区分启发式，不误合并围栏代码。
 * CommonMark 缩进代码块是整块语义：合并为单个 <pre><code>，每行剥离
 * blockquote 前缀后剥 up to 4 列缩进（stripIndentColumns），按 \n 连接
 * 并以 \n 结尾；块尾空白行（trim 后为空）不属于块内容，剔除（spec 例 117）。
 */
function renderIndentCodeBlock(
  lines: LineNode[],
  start: number,
  out: string[]
): number {
  const contentLines: string[] = [];
  let j = start;
  while (j < lines.length && lines[j].type === 'code') {
    // 缩进判定发生在 blockquote 前缀剥离之后（与引擎 computeLineOffsets 一致）
    contentLines.push(stripIndentColumns(stripBlockquotePrefix(lines[j].raw)));
    j++;
  }
  // 块尾空白行剔除（CommonMark：块尾空行不属于代码块内容）
  while (
    contentLines.length > 0 &&
    contentLines[contentLines.length - 1].trim() === ''
  ) {
    contentLines.pop();
  }
  const content =
    contentLines.join('\n') + (contentLines.length > 0 ? '\n' : '');
  out.push('<pre><code>' + escapeText(content) + '</code></pre>');
  return j;
}

/**
 * 主入口：MarkdownDocument → 近似 HTML 字符串。
 * 行级映射：body→<p>、heading→<h{n}>、hr→<hr />、blockquote 按行级
 * blockquoteLevel 开合容器、围栏代码→<pre><code>（renderFencedBlock）、
 * 缩进代码→连续 code 行合并为单个 <pre><code>（renderIndentCodeBlock）、
 * table_row→<tr><td>、列表行→<ul>/<ol><li>（listIndent 启发式分组）。
 */
export function astToHtml(doc: MarkdownDocument): string {
  const out: string[] = [];
  const lines = doc.lines;
  let openQuotes = 0;
  let i = 0;

  const syncQuotes = (target: number) => {
    while (openQuotes < target) {
      out.push('<blockquote>');
      openQuotes++;
    }
    while (openQuotes > target) {
      out.push('</blockquote>');
      openQuotes--;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const bq = line.blockquoteLevel ?? 0;

    if (line.type === 'code_fence_start') {
      syncQuotes(bq);
      i = renderFencedBlock(lines, i, out);
      continue;
    }

    syncQuotes(bq);

    switch (line.type) {
      case 'empty':
        break;
      case 'body':
        if (line.listIndent !== undefined && listKind(line) !== null) {
          i = renderListGroup(lines, i, out);
          continue;
        }
        out.push('<p>' + renderLineInline(line) + '</p>');
        break;
      case 'heading':
        out.push(
          `<h${line.headingLevel ?? 1}>` +
            renderLineInline(line) +
            `</h${line.headingLevel ?? 1}>`
        );
        break;
      case 'hr':
        out.push('<hr />');
        break;
      case 'code':
        // 缩进代码块（R1-A2d）：连续 code 行合并为单个 <pre><code>，
        // 每行剥 up to 4 列缩进；围栏内 code 行已被 renderFencedBlock
        // 消费，不会在此出现（不误合并围栏代码）。
        i = renderIndentCodeBlock(lines, i, out);
        continue;
      case 'table_row':
        out.push(renderTableRow(line));
        break;
      case 'table_separator':
        break;
      case 'math_fence_start':
      case 'math_block':
      case 'math_fence_end':
        // 引擎扩展语法：占位标签显式暴露与 CommonMark 文本渲染的差异
        out.push(
          '<span class="math">' +
            escapeText(stripBlockquotePrefix(line.raw)) +
            '</span>'
        );
        break;
      case 'blockquote':
        out.push('<p>' + renderLineInline(line) + '</p>');
        break;
    }
    i++;
  }
  syncQuotes(0);
  return out.join('');
}

/**
 * 归一化（对比前使用，使「渲染等价」的输出相等）：
 * 1. CRLF → LF；
 * 2. <pre> 块整体保护——块内换行与缩进是语义，不做任何折叠；
 * 3. 非 pre 部分：标签规整（属性按名排序、单双引号统一为双引号、
 *    空白规整、自闭合统一为 " />"）+ 文本段空白折叠（\s+ → 空格、
 *    文本段边缘空格剔除，等价于 HTML 渲染的空白塌陷）；
 * 4. 整体 trim。
 */
export function normalizeHtml(html: string): string {
  let s = html.replace(/\r\n?/g, '\n');
  const preParts: string[] = [];
  s = s.replace(/<pre>[\s\S]*?<\/pre>/g, (m) => {
    const idx = preParts.length;
    preParts.push(m);
    return `\u0000PRE${idx}\u0000`;
  });
  s = s.replace(/(<[^>]*>|[^<]+)/g, (seg) => {
    if (seg.startsWith('<')) return normalizeTag(seg);
    return foldText(seg);
  });
  s = s.replace(/\u0000PRE(\d+)\u0000/g, (_m, idx: string) => preParts[Number(idx)]);
  return s.trim();
}

/** 文本段空白折叠：连续空白 → 单空格，剔除段边缘空格 */
function foldText(seg: string): string {
  return seg.replace(/\s+/g, ' ').replace(/^ /, '').replace(/ $/, '');
}

/**
 * 标签规整：属性按名排序、单引号统一为双引号、空白规整、自闭合 " />"。
 * 无法解析的标签原样返回（如 <!-- 注释 -->）。
 */
function normalizeTag(tag: string): string {
  const t = tag.replace(/\s+/g, ' ').trim();
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)(.*?)(\/?)>$/.exec(t);
  if (!m) return t;
  const [, slash, name, attrStr, selfClose] = m;
  const attrs: string[] = [];
  const attrRe =
    /([a-zA-Z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let mm: RegExpExecArray | null;
  while ((mm = attrRe.exec(attrStr)) !== null) {
    const attrName = mm[1].toLowerCase();
    let value = mm[2] ?? mm[3] ?? mm[4] ?? '';
    value = value.replace(/'/g, '"');
    attrs.push(`${attrName}="${value}"`);
  }
  attrs.sort();
  const attrPart = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
  const sc = selfClose === '/' ? ' /' : '';
  return `<${slash}${name}${attrPart}${sc}>`;
}
