/**
 * 导出与复制模块（B4 N5：renderToHTML 导出 + N9 复制映射 + 复制按钮剪贴板）
 *
 * 定位（docs/analysis/plan-P2-执行方案.md B4 / status-P3 N5）：
 * CommonMark 近似投影 + KaTeX 支持的导出投影器——与 BlockRenderer 为
 * 双实现、各自单源：
 * - renderToHtml：AST → HTML 纯函数投影（无交互层/虚拟滚动/注册表），
 *   输出即「完成态权威渲染」的最小验证面（status-P3 N5 / N1 E2.2 复用）；
 * - BlockRenderer：交互式行级渲染器（注册表/软渲染/复制按钮/工具产物）。
 *
 * 本模块从 tests/commonmark/astToHtml.ts 迁移投影核心（行级映射逐函数
 * 迁移；不含测试专用归一化 normalizeHtml），并相对其增强：
 * - math 占位 → KaTeX 真实渲染（renderMathToHtml 注入点，与渲染层同源）；
 * - 引擎扩展语法（mark/spoiler/footnote/checkbox）保持语义 HTML 映射
 *   （与 astToHtml 一致，一致性由 tests/unit/render-export.test.ts 锁定）。
 * 同步红线：astToHtml（tests/commonmark/，B8b 域）保持独立演进，本模块
 * 不得反向依赖它——两投影器的一致性以等价断言维持，不做代码级耦合。
 *
 * 另承载 N9 只读复制映射（DOM 选区 → 源码偏移：data-token-start /
 * data-sub-offset 无损映射，与 MarkdownEngine 光标定位同源）与 N5 复制
 * 按钮的剪贴板写入工具——导出/复制同属「文本出口」域，共用本模块。
 */
import type { MarkdownDocument, LineNode, InlineNode } from './ast';
import { renderMathToHtml } from './renderTheme';

/** 文本转义：& < >（与 astToHtml / CommonMark 渲染器的文本转义规则一致） */
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

/** 从行原文中剥离行首的 blockquote 前缀（> 及其前导空白）。
 *  导出为 BlockRenderer 复制按钮共用（复制整块内容时剥前缀）。 */
export function stripBlockquotePrefix(raw: string): string {
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
 * 剥离 up to limit 列前导空白（CommonMark 缩进代码块内容规则）：
 * tab 按停靠 4 展开。不足 limit 列或行尾残留的空白原样保留。
 */
function stripIndentColumns(s: string, limit: number = 4): string {
  let col = 0;
  let i = 0;
  while (i < s.length && col < limit) {
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

/** 字符串的渲染列宽（tab 按停靠 4 展开） */
function textColumns(s: string): number {
  let col = 0;
  for (const ch of s) {
    if (ch === ' ') {
      col++;
    } else if (ch === '\t') {
      col += 4 - (col % 4);
    } else {
      col++;
    }
  }
  return col;
}

/** 行首缩进列宽（tab 按停靠 4 展开） */
function leadingIndentColumns(s: string): number {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ') {
      col++;
    } else if (s[i] === '\t') {
      col += 4 - (col % 4);
    } else {
      break;
    }
  }
  return col;
}

/** 剥离 up to 4 列前导空白（列表标记段判定用） */
function stripFourColumns(s: string): string {
  return stripIndentColumns(s, 4);
}

/**
 * 列表标记段信息：行首为列表标记（task / 项目符号 / 有序）时返回标记前缀
 * 与「内容缩进列偏移」——标记段列宽 = 标记字符 + 标记后空白（tab 停靠 4）；
 * 特例：标记后无内容或空白 ≥5 列时内容缩进列 = 标记宽 + 1。
 */
function listMarkerInfo(
  content: string
): { prefix: string; markerWidth: number } | null {
  const m = /^([-*+]\s*\[[xX\s]\])[ \t]+|^([-*+])[ \t]+|^(\d+\.)[ \t]+/.exec(
    content
  );
  if (!m) return null;
  const prefix = m[1] ?? m[2] ?? m[3];
  const markerSeg = m[0];
  const wPlusN = textColumns(markerSeg);
  const n = wPlusN - prefix.length;
  if (n >= 5 || content.slice(markerSeg.length) === '') {
    return { prefix, markerWidth: prefix.length + 1 };
  }
  return { prefix, markerWidth: wPlusN };
}

/** 列表项内容缩进列（= 行首缩进列 + 标记段宽，spec §5.2） */
function listContentIndent(line: LineNode): number {
  const bqContent = stripBlockquotePrefix(line.raw);
  const info = listMarkerInfo(stripFourColumns(bqContent));
  return leadingIndentColumns(bqContent) + (info ? info.markerWidth : 0);
}

/**
 * 链接 url 字段拆分（CommonMark 渲染惯例）：destination + 可选 title。
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

/**
 * 内联节点 → HTML（结构令牌返回空串，由行级结构承担语义）。
 * 引擎扩展语法保持与 astToHtml 相同的语义映射（mark/spoiler/footnote/
 * checkbox）；math 从占位升级为 KaTeX 真实渲染（B4 N5）。
 */
function renderInline(t: InlineNode): string {
  // 行内原始 HTML：CommonMark 语义为原样透传
  if (t.type === 'html_element' || t.type === ('html_tag' as InlineNode['type'])) {
    return t.raw;
  }
  // HTML 块内容行内 token：raw 即行原文，原样透传
  if (t.type === 'html') {
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
    // —— B4 N5：引擎扩展语法映射 ——
    // math：占位 → KaTeX 真实渲染（display 判定与 InlineRenderer 同源：
    // raw 以 $$ 开头 = 块级公式；公式体 = content）。渲染经 renderTheme
    // 注入点（宿主可换 MathJax/自研），LRU 缓存自动生效。
    case 'math': {
      const isDisplay = t.raw.startsWith('$$');
      return (
        '<span class="math math-rendered">' +
        renderMathToHtml(t.content, isDisplay) +
        '</span>'
      );
    }
    // footnote：语义占位（与 astToHtml 一致——扩展语法在 CommonMark
    // 无对应 HTML，显式保留语义容器而非折叠为纯文本）
    case 'footnote':
      return '<span class="footnote">' + escapeText(t.content) + '</span>';
    case 'link': {
      const { href, title } = splitLinkTarget(t.url ?? '');
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
      return (
        `<a href="${escapeAttr(href)}"${titleAttr}>` +
        inlineChildren(t) +
        '</a>'
      );
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
 * 列表项投影累加器：以「块序列」模型承载单个 <li> 的内容——
 * 首段文本与后续块（<p>…</p> / <pre><code>…</code></pre> / 嵌套列表）。
 */
interface ListItemAcc {
  /** 首段文本：标记行内容 + 紧邻 body 延续（无空行，空格并入） */
  firstText: string;
  /** 后续块：<p>…</p> / <pre><code>…</code></pre> / 嵌套列表 HTML */
  blocks: string[];
  /** 最后追加的块形态（决定紧邻延续的并入位置） */
  lastMode: 'first' | 'p' | 'pre' | 'list' | 'text';
  /** 内容缩进列（列表项延续 / li 内代码判定的基准） */
  contentIndent: number;
}

/**
 * 列表容器投影：支持嵌套、松散列表、项内多段落、li 内缩进代码块、
 * 紧邻 body 延续（迁移自 astToHtml renderListGroup，语义一致）。
 */
function renderListGroup(lines: LineNode[], start: number, out: string[]): number {
  const first = lines[start];
  const kind = listKind(first);
  const indent = first.listIndent ?? 0;
  const bq = first.blockquoteLevel ?? 0;
  const items: ListItemAcc[] = [];
  let j = start;
  let loose = false;
  let anyItem = false;
  // 「空行后」标志：空白行之后的成员行——列表项延续按新段落处理
  let pendingBlank = false;

  // 追加文本：紧邻延续（无空行）按空格并入——p 段并入 p 内，
  // 嵌套列表/代码块之后作为新文本段追加（CommonMark 新段落语义的近似）。
  const appendText = (item: ListItemAcc, inline: string) => {
    if (item.lastMode === 'p') {
      item.blocks[item.blocks.length - 1] =
        item.blocks[item.blocks.length - 1].replace(/<\/p>$/, '') +
        ' ' +
        inline +
        '</p>';
    } else if (item.lastMode === 'first') {
      item.firstText += (item.firstText === '' ? '' : ' ') + inline;
    } else {
      item.blocks.push(inline);
      item.lastMode = 'text';
    }
  };

  // 追加新段落（listContinuation / 空行后 body）：空项首段不包 <p>
  // （紧列表语义）；非空项的后续段包 <p> 并置松散（spec §5.3）。
  const appendParagraph = (item: ListItemAcc, inline: string): boolean => {
    if (item.firstText === '' && item.blocks.length === 0) {
      item.firstText = inline;
      item.lastMode = 'first';
      return false;
    }
    item.blocks.push('<p>' + inline + '</p>');
    item.lastMode = 'p';
    return true;
  };

  while (j < lines.length) {
    const ln = lines[j];
    const bqContent = stripBlockquotePrefix(ln.raw);
    const colIndent = leadingIndentColumns(bqContent);

    // 空白行：向后看是否仍属同一列表（松散分隔）
    if (ln.type === 'empty' || (ln.type === 'body' && bqContent.trim() === '')) {
      let next = j + 1;
      while (
        next < lines.length &&
        (lines[next].type === 'empty' ||
          (lines[next].type === 'body' &&
            stripBlockquotePrefix(lines[next].raw).trim() === ''))
      ) {
        next++;
      }
      if (next < lines.length && (lines[next].blockquoteLevel ?? 0) === bq) {
        const nl = lines[next];
        const nIndent = leadingIndentColumns(stripBlockquotePrefix(nl.raw));
        const nKind = listKind(nl);
        const nListIndent = nl.listIndent ?? 0;
        const last = items[items.length - 1];
        // 成员判定：同级同种列表项 / 嵌套列表项 / 列表项延续 /
        // 紧邻归属 body（列缩进 ≥ 内容缩进）/ li 内缩进代码
        const isMember =
          (nKind !== null &&
            nListIndent >= indent &&
            (nListIndent > indent || nKind === kind)) ||
          nl.listContinuation === true ||
          (nl.type === 'body' && last !== undefined && nIndent >= last.contentIndent) ||
          (nl.type === 'code' && last !== undefined && nIndent >= last.contentIndent + 4);
        if (isMember) {
          pendingBlank = true;
          j = next;
          continue;
        }
      }
      break;
    }

    if ((ln.blockquoteLevel ?? 0) !== bq) break;

    // 列表项内缩进代码块：li 上下文 code 行 → <pre><code> 并入当前项。
    if (ln.type === 'code') {
      const last = items[items.length - 1];
      if (last !== undefined && colIndent >= last.contentIndent + 4) {
        const { content, end } = collectIndentCode(lines, j, last.contentIndent + 4);
        last.blocks.push('<pre><code>' + escapeText(content) + '</code></pre>');
        last.lastMode = 'pre';
        if (pendingBlank && (last.firstText !== '' || last.blocks.length > 1)) {
          loose = true;
        }
        pendingBlank = false;
        j = end;
        continue;
      }
      // 出列表的缩进代码块：组在此结束，交由主循环投影
      break;
    }

    if (ln.listIndent === undefined) break;

    // 列表标记行（task / 项目符号 / 有序）：新项或嵌套递归
    if (listKind(ln) !== null) {
      if ((ln.listIndent ?? 0) < indent) break;
      if ((ln.listIndent ?? 0) > indent) {
        // 嵌套子列表（递归）——并入当前项作为块
        const sub: string[] = [];
        const end = renderListGroup(lines, j, sub);
        const last = items[items.length - 1];
        if (last !== undefined) {
          last.blocks.push(sub.join(''));
          last.lastMode = 'list';
          if (pendingBlank && (last.firstText !== '' || last.blocks.length > 1)) {
            loose = true;
          }
        }
        pendingBlank = false;
        j = end;
        anyItem = true;
        continue;
      }
      // 同级不同种列表：新列表（组结束）
      if (listKind(ln) !== kind) break;
      // 同级列表项（新项）
      items.push({
        firstText: renderLineInline(ln),
        blocks: [],
        lastMode: 'first',
        contentIndent: listContentIndent(ln),
      });
      if (pendingBlank) loose = true; // 项间空行 → 列表松散（spec §5.3）
      pendingBlank = false;
      j++;
      anyItem = true;
      continue;
    }

    // 非标记行：列表项延续（普通 body）——按列缩进判定归属
    if (ln.type === 'body') {
      const last = items[items.length - 1];
      if (last !== undefined && ln.raw.trim() !== '' && colIndent >= last.contentIndent) {
        const inline = renderLineInline(ln);
        if (pendingBlank || ln.listContinuation === true) {
          // 空行后：列表项新段落（listContinuation 语义）
          if (appendParagraph(last, inline)) loose = true;
        } else {
          // 紧邻延续（无空行）：空格并入当前段
          appendText(last, inline);
        }
        pendingBlank = false;
        j++;
        continue;
      }
      break;
    }

    // 其余块级行（heading / hr / blockquote / table 等）：组结束
    break;
  }

  if (!anyItem) return j;
  const joined = items
    .map((item) => {
      if (loose) {
        return (
          '<li>' +
          (item.firstText !== '' ? '<p>' + item.firstText + '</p>' : '') +
          item.blocks.join('') +
          '</li>'
        );
      }
      return '<li>' + item.firstText + item.blocks.join('') + '</li>';
    })
    .join('');
  if (kind === 'ol') {
    const n = olStartNumber(first);
    out.push(`<ol${n > 1 ? ` start="${n}"` : ''}>` + joined + '</ol>');
  } else {
    out.push('<ul>' + joined + '</ul>');
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
 * 数学围栏块（B4 N5）：从 math_fence_start 消费到 math_fence_end——
 * 块内 math_block 内容行按 \n 连接为单个公式体，KaTeX 块级渲染一次
 * （与 BlockRenderer 逐行渲染不同——导出是「完成态」形态，多行公式
 * 必须保持整体；未闭合围栏按已收集内容软渲染）。
 */
function renderMathFencedBlock(
  lines: LineNode[],
  start: number,
  out: string[]
): number {
  const contentLines: string[] = [];
  let j = start + 1;
  while (j < lines.length && lines[j].type !== 'math_fence_end') {
    if (lines[j].type === 'math_block') {
      contentLines.push(stripBlockquotePrefix(lines[j].raw));
    }
    j++;
  }
  if (contentLines.length > 0) {
    out.push(
      '<span class="math math-rendered">' +
        renderMathToHtml(contentLines.join('\n'), true) +
        '</span>'
    );
  }
  return j + 1; // 跳过 math_fence_end（未闭合时 j = lines.length，循环自然结束）
}

/**
 * 缩进代码块内容收集：从 start 消费连续 type==='code' 行，每行剥离引用
 * 前缀后按列剥 up to stripCols 列缩进（tab 停靠 4），按 \n 连接并以 \n
 * 结尾；块尾空白行剔除（spec 例 117），块内空白行保留。
 */
function collectIndentCode(
  lines: LineNode[],
  start: number,
  stripCols: number
): { content: string; end: number } {
  const contentLines: string[] = [];
  let j = start;
  while (j < lines.length && lines[j].type === 'code') {
    contentLines.push(stripIndentColumns(stripBlockquotePrefix(lines[j].raw), stripCols));
    j++;
  }
  while (
    contentLines.length > 0 &&
    contentLines[contentLines.length - 1].trim() === ''
  ) {
    contentLines.pop();
  }
  const content =
    contentLines.join('\n') + (contentLines.length > 0 ? '\n' : '');
  return { content, end: j };
}

/**
 * 缩进代码块投影：主循环遇到的连续 type==='code' 行必然来自缩进代码块
 * （围栏内行已由 renderFencedBlock 消费）——合并为单个 <pre><code>。
 */
function renderIndentCodeBlock(
  lines: LineNode[],
  start: number,
  out: string[]
): number {
  const { content, end } = collectIndentCode(lines, start, 4);
  out.push('<pre><code>' + escapeText(content) + '</code></pre>');
  return end;
}

/**
 * 主入口：MarkdownDocument → 近似 HTML 字符串（导出投影器）。
 * 行级映射与 astToHtml 完全等价（段落合并/标题/hr/引用/围栏代码/缩进
 * 代码/表格/列表/HTML 块），差异仅一处：数学相关行（math 令牌 /
 * math_fence / math_block）由占位标签升级为 KaTeX 真实渲染。
 */
export function renderToHtml(doc: MarkdownDocument): string {
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

    // —— B4 N5：数学围栏整块消费（KaTeX 块级渲染）——
    if (line.type === 'math_fence_start') {
      syncQuotes(bq);
      i = renderMathFencedBlock(lines, i, out);
      continue;
    }

    syncQuotes(bq);

    switch (line.type) {
      case 'empty':
        break;
      // HTML 块行：原样透传（剥离块引用前缀），缩进保留，行间以 \n 连接
      case 'html_block':
        out.push(stripBlockquotePrefix(line.raw) + '\n');
        break;
      case 'body':
        if (line.listIndent !== undefined && listKind(line) !== null) {
          i = renderListGroup(lines, i, out);
          continue;
        }
        // 段落合并：相邻普通 body 行合并为单个 <p>，行间按软换行以空格连接
        {
          let j = i;
          const parts: string[] = [];
          while (j < lines.length && lines[j].type === 'body') {
            const l = lines[j];
            if (l.listIndent !== undefined && listKind(l) !== null) break;
            if ((l.blockquoteLevel ?? 0) !== bq) break;
            if (l.raw.trim() === '') break; // 空行阻断段落
            parts.push(renderLineInline(l));
            j++;
          }
          const text = parts.join(' ');
          // 纯结构令牌行（如块引用空白行 `>>`）不产出空段落
          if (text.trim() !== '') {
            out.push('<p>' + text + '</p>');
          }
          i = j > i ? j : j + 1;
          continue;
        }
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
        // 缩进代码块：连续 code 行合并为单个 <pre><code>
        i = renderIndentCodeBlock(lines, i, out);
        continue;
      case 'table_row':
        out.push(renderTableRow(line));
        break;
      case 'table_separator':
        break;
      // 防御分支：math_block / math_fence_end 恒被 renderMathFencedBlock
      // 消费；单独出现（异常 AST）时按块级公式独立渲染
      case 'math_block':
      case 'math_fence_end':
        out.push(
          '<span class="math math-rendered">' +
            renderMathToHtml(stripBlockquotePrefix(line.raw).trim(), true) +
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

// ============================================================
// N9：DOM 选区 → 源码偏移映射（readOnly 复制为 Markdown）
// ============================================================

/** Node.TEXT_NODE 的数值常量（避免模块在无 DOM 全局环境下引用 Node） */
const TEXT_NODE = 3;

/**
 * 解析 DOM 选区边界 → 全局源码偏移（N9 无损映射链，与 MarkdownEngine
 * 光标定位 handleContainerClick 同源）：
 * - 文本节点：携带文本内偏移直接走祖先链映射（文本内偏移对 token 源码
 *   字符有效——普通文本 token 的文本节点即源码本身）；
 * - 元素节点：偏移 = 子节点序号，解析到子节点起始/末位子节点结束
 *   （递归下降；无子节点按元素自身映射）；
 * - 沿祖先链读取 data-sub-offset（token 内子偏移）与 data-token-start
 *   （token 全局起始）——子偏移存在时得到字符级精确位置；
 * - 无子偏移：文本节点「直达 token」时（父级即 token span，未途经
 *   未映射中间层）文本内偏移仍精确（普通文本 token）；途经未映射
 *   中间层（KaTeX 输出等合成内容，偏移与源码无对应）按整 token 边界
 *   映射（起始 → token 起点，结束 → token 终点）；
 * - 行级兜底：data-line-start 行容器 → 行首 + 文本偏移（钳制行长）；
 * - 全程无映射（容器外/未挂载内容）→ null（调用方放行浏览器默认复制）。
 */
export function domRangeToSourceOffsets(
  range: Range
): { from: number; to: number } | null {
  const from = resolveBoundary(range.startContainer, range.startOffset, false);
  const to = resolveBoundary(range.endContainer, range.endOffset, true);
  if (from === null || to === null) return null;
  // Range 契约保证 start ≤ end；防御性归一化（异常输入不倒置）
  return from <= to ? { from, to } : { from: to, to: from };
}

/** 选区边界解析入口：按容器类型分发 */
function resolveBoundary(node: Node, offset: number, isEnd: boolean): number | null {
  if (node.nodeType === TEXT_NODE) {
    // 文本节点：offset = 文本内字符偏移，直接祖先链映射
    return walkUp(node.parentElement, offset, isEnd, true);
  }
  return resolveFromElement(node as Element, offset, isEnd);
}

/** 元素容器解析：子节点序号 → 子节点边界（递归）；无子节点按自身映射 */
function resolveFromElement(
  el: Element | null,
  offset: number,
  isEnd: boolean
): number | null {
  if (!el) return null;
  const children = el.childNodes;
  if (children.length > 0 && offset <= children.length) {
    if (offset < children.length) {
      // 位置位于第 offset 个子节点之前 → 取该子节点起始位置
      return resolveNodeStart(children[offset]);
    }
    // 位置位于全部子节点之后 → 取最后一个子节点结束位置
    return resolveNodeEnd(children[children.length - 1]);
  }
  // 无子节点可解析：元素自身属性链向上映射（文本偏移 0）
  return walkUp(el, 0, isEnd, false);
}

/** 节点起始位置（递归下降到第一个有内容的子节点） */
function resolveNodeStart(node: Node): number | null {
  if (node.nodeType === TEXT_NODE) return walkUp(node.parentElement, 0, false, true);
  const el = node as Element;
  if (el.childNodes.length > 0) return resolveNodeStart(el.childNodes[0]);
  return walkUp(el, 0, false, false);
}

/** 节点结束位置（递归下降到最后一个子节点的结尾） */
function resolveNodeEnd(node: Node): number | null {
  if (node.nodeType === TEXT_NODE) {
    return walkUp(node.parentElement, node.textContent?.length ?? 0, true, true);
  }
  const el = node as Element;
  if (el.childNodes.length > 0) {
    return resolveNodeEnd(el.childNodes[el.childNodes.length - 1]);
  }
  return walkUp(el, 0, true, false);
}

/**
 * 祖先链映射：data-sub-offset + data-token-start 双属性定位；
 * data-line-start 行容器为兜底；两者皆无 → null。
 * isTextOrigin：边界是否源自文本节点（文本内偏移对源码有效）；
 * crossedUnmapped：到达 token 前是否途经无映射属性的中间层（KaTeX
 * 等合成内容标志——合成内容的文本偏移与源码无对应，按整 token 映射）。
 */
function walkUp(
  el: Element | null,
  textDelta: number,
  isEnd: boolean,
  isTextOrigin: boolean
): number | null {
  let subOffset: number | null = null;
  let crossedUnmapped = false;
  let current: Element | null = el;
  while (current) {
    // 行级兜底（虚拟化行容器 data-line-start/data-line-length）：
    // - 文本偏移/子偏移可循 → 行首 + 偏移（钳制行长）；
    // - 元素边界（br 等无映射元素，无文本偏移可循）→ 行首/行尾边界
    //   （行尾兜底元素如尾随 <br/> 按行尾映射，避免倒置到行首）。
    const lineStartAttr = current.getAttribute('data-line-start');
    if (lineStartAttr !== null) {
      const lineStart = parseInt(lineStartAttr, 10);
      if (Number.isNaN(lineStart)) return null;
      const lineLen = parseInt(current.getAttribute('data-line-length') ?? '0', 10);
      const base = (subOffset ?? 0) + textDelta;
      if (base === 0 && subOffset === null && !isTextOrigin) {
        return isEnd ? lineStart + lineLen : lineStart;
      }
      return lineStart + Math.max(0, Math.min(base, lineLen));
    }
    if (current.hasAttribute('data-sub-offset')) {
      subOffset = parseInt(current.getAttribute('data-sub-offset') || '0', 10);
    }
    const tokenStartAttr = current.getAttribute('data-token-start');
    if (tokenStartAttr !== null) {
      const tokenStart = parseInt(tokenStartAttr, 10);
      if (Number.isNaN(tokenStart)) return null;
      const tokenLen = parseInt(current.getAttribute('data-token-length') || '0', 10);
      if (subOffset !== null) {
        // 字符级精确位置（token 起始 + 子偏移 + 文本内偏移），钳制 token 内
        const pos = tokenStart + subOffset + textDelta;
        return Math.max(tokenStart, Math.min(pos, tokenStart + tokenLen));
      }
      if (isTextOrigin && !crossedUnmapped) {
        // 文本节点直达 token（父级即 token span）：文本内偏移对源码有效
        const pos = tokenStart + textDelta;
        return Math.max(tokenStart, Math.min(pos, tokenStart + tokenLen));
      }
      // 合成内容（KaTeX 等）或元素边界：整 token 边界映射
      return isEnd ? tokenStart + tokenLen : tokenStart;
    }
    // 本层无映射属性 → 合成内容中间层（继续向上找 token）
    crossedUnmapped = true;
    current = current.parentElement;
  }
  return null;
}

/**
 * 原生选区 → Markdown 源码切片（N9 只读复制核心）：
 * DOM 选区经 domRangeToSourceOffsets 映射为源码区间，getText 切片即
 * Markdown 源码。折叠选区/无法映射返回 null——调用方放行浏览器默认
 * 复制（渲染文本）。selection 参数取最小结构类型，便于测试注入。
 */
export function selectionToMarkdown(
  selection: {
    isCollapsed: boolean;
    rangeCount: number;
    getRangeAt(index: number): Range;
  },
  getText: () => string
): string | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;
  const span = domRangeToSourceOffsets(selection.getRangeAt(0));
  if (!span || span.from === span.to) return null;
  return getText().substring(span.from, span.to);
}

// ============================================================
// N5：剪贴板写入工具（代码块复制 / 公式复制按钮共用）
// ============================================================

/**
 * 复制到剪贴板：优先 navigator.clipboard.writeText（异步，权限拒绝/
 * 不可用时回退）；兜底走临时 textarea + execCommand('copy') 传统通道
 * （非安全上下文/旧浏览器；与 HiddenInput.writeClipboardText 同款策略，
 * 模块级独立实现，jsdom 无 execCommand 能力时静默放弃）。
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 权限拒绝/浏览器策略：落入传统通道
    }
  }
  if (
    typeof document === 'undefined' ||
    typeof document.execCommand !== 'function'
  ) {
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(ta);
  }
}
