/**
 * markdown — 文档 ⇄ Markdown 的序列化
 *
 * Token-in-Document 架构给这一层带来的最大红利：
 * **行内部分不需要序列化。**
 *
 * 因为 `**` `` ` `` `[](…)` `#` 这些字符本来就真实存在于文档里，
 * 一个文本块的 Markdown 源码就等于它的 `textContent`——
 * 不需要「根据 bold mark 反推该输出几个星号」，
 * 也就不存在旧方案里那些转义翻倍、`\,` 变 `,`、
 * `> [!NOTE]` 被转义成 `> \[!NOTE\]` 的问题。
 *
 * 于是这一层只剩下**块级结构**的职责：
 *   - 代码块的围栏与语言
 *   - 列表 / 引用的行首前缀与缩进
 *   - 块与块之间的空行
 *
 * ── 当前覆盖范围 ──────────────────────────────
 * 已接入 Token-in-Document（前缀是真字符，原样进出）：
 *   段落、标题
 * 仍为结构化节点（前缀在序列化时生成、反序列化时消费）：
 *   代码块、引用、无序/有序列表、任务列表、分割线
 */

import type { Node as PMNode, Schema } from '@tiptap/pm/model';

/* ════════════════════════════════════════════
 * 文档 → Markdown
 * ════════════════════════════════════════════ */

export interface SerializeOptions {
  /** 无序列表使用的符号，默认 `-` */
  bulletMarker?: '-' | '*' | '+';
  /** 代码围栏字符数，默认 3 */
  fenceLength?: number;
}

/**
 * 把 ProseMirror 文档序列化成 Markdown。
 *
 * 段落与标题直接取 `textContent`——它们的语法字符就在文本里。
 */
export function docToMarkdown(doc: PMNode, options: SerializeOptions = {}): string {
  const bullet = options.bulletMarker ?? '-';
  const fenceLength = options.fenceLength ?? 3;
  const out: string[] = [];

  doc.forEach((node) => {
    out.push(serializeBlock(node, { bullet, fenceLength, indent: '' }));
  });

  return out.filter((s) => s !== null).join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

interface Ctx {
  bullet: string;
  fenceLength: number;
  indent: string;
}

function serializeBlock(node: PMNode, ctx: Ctx): string {
  switch (node.type.name) {
    /* 段落与标题：语法已在文本里，直接输出 */
    case 'paragraph':
    case 'heading':
      return ctx.indent + inlineText(node);

    case 'horizontalRule':
      return ctx.indent + '---';

    case 'codeBlock': {
      const lang = (node.attrs.language as string) || '';
      const fence = '`'.repeat(Math.max(3, ctx.fenceLength));
      const body = node.textContent
        .split('\n')
        .map((l) => ctx.indent + l)
        .join('\n');
      return `${ctx.indent}${fence}${lang}\n${body}\n${ctx.indent}${fence}`;
    }

    case 'blockquote': {
      const inner: string[] = [];
      node.forEach((child) => inner.push(serializeBlock(child, ctx)));
      return inner
        .join('\n\n')
        .split('\n')
        .map((line) => (line.trim() ? `> ${line}` : '>'))
        .join('\n');
    }

    case 'bulletList':
      return serializeList(node, ctx, () => `${ctx.bullet} `);

    case 'orderedList': {
      const start = Number(node.attrs.start ?? 1) || 1;
      return serializeList(node, ctx, (i) => `${start + i}. `);
    }

    case 'taskList':
      return serializeList(node, ctx, (_i, item) =>
        `${ctx.bullet} [${item.attrs.checked ? 'x' : ' '}] `,
      );

    case 'table':
      return serializeTable(node, ctx);

    case 'mermaidBlock': {
      const fence = '`'.repeat(Math.max(3, ctx.fenceLength));
      const body = node.textContent
        .split('\n')
        .map((l) => ctx.indent + l)
        .join('\n');
      return `${ctx.indent}${fence}mermaid\n${body}\n${ctx.indent}${fence}`;
    }

    case 'diffBlock': {
      const fence = '`'.repeat(Math.max(3, ctx.fenceLength));
      const body = node.textContent
        .split('\n')
        .map((l) => ctx.indent + l)
        .join('\n');
      return `${ctx.indent}${fence}diff\n${body}\n${ctx.indent}${fence}`;
    }

    case 'callout': {
      const calloutType = (node.attrs.type as string) || 'note';
      const inner: string[] = [];
      node.forEach((child) => inner.push(serializeBlock(child, ctx)));
      const body = inner
        .join('\n\n')
        .split('\n')
        .map((line) => (line.trim() ? `> ${line}` : '>'));
      return [`> [!${calloutType}]`, ...body].join('\n');
    }

    case 'mathBlock': {
      const formula = (node.attrs.formula as string) || '';
      return `${ctx.indent}$$\n${formula.split('\n').map((l) => ctx.indent + l).join('\n')}\n${ctx.indent}$$`;
    }

    case 'imageBlock': {
      const src = (node.attrs.src as string) || '';
      const alt = (node.attrs.alt as string) || (node.attrs.caption as string) || '';
      return `${ctx.indent}![${alt}](${src})`;
    }

    case 'toggleHeading':
    case 'toggleList':
    case 'columnLayout':
    case 'tabsBlock': {
      const inner: string[] = [];
      node.forEach((child) => inner.push(serializeBlock(child, ctx)));
      return inner.join('\n\n');
    }

    case 'column':
    case 'tabPanel': {
      const inner: string[] = [];
      node.forEach((child) => inner.push(serializeBlock(child, ctx)));
      return inner.join('\n\n');
    }

    case 'videoBlock':
    case 'audioBlock':
    case 'fileBlock':
    case 'bookmarkBlock':
    case 'embedBlock':
    case 'databaseBlock':
    case 'chartBlock':
    case 'buttonBlock':
    case 'aiBlock':
    case 'tableOfContents':
    case 'syncedBlock':
    case 'subPage':
    case 'breadcrumb':
      return ''; // atom 块无标准 Markdown 对应物，暂不序列化

    default: {
      // 未知块：尽力保留其文字内容，绝不静默丢弃
      if (node.isTextblock) return ctx.indent + inlineText(node);
      const inner: string[] = [];
      node.forEach((child) => inner.push(serializeBlock(child, ctx)));
      return inner.join('\n\n');
    }
  }
}

/**
 * 列表序列化。
 *
 * 首行加前缀，续行按前缀宽度缩进，
 * 这样嵌套列表与列表项内的多段落都能保持合法的 Markdown 缩进。
 */
function serializeList(
  list: PMNode,
  ctx: Ctx,
  markerOf: (index: number, item: PMNode) => string,
): string {
  const lines: string[] = [];

  list.forEach((item, _offset, index) => {
    const marker = markerOf(index, item);
    const pad = ' '.repeat(marker.length);
    const childCtx: Ctx = { ...ctx, indent: '' };

    const chunks: string[] = [];
    item.forEach((child) => chunks.push(serializeBlock(child, childCtx)));

    const body = chunks.join('\n\n').split('\n');
    lines.push(ctx.indent + marker + (body[0] ?? ''));
    for (let i = 1; i < body.length; i++) {
      lines.push(body[i] ? ctx.indent + pad + body[i] : '');
    }
  });

  return lines.join('\n');
}

/**
 * 文本块的行内文本。
 *
 * hardBreak 只输出一个换行符，不补两个空格——
 * 因为「行尾两个空格」这种硬换行标记本身也是真字符，
 * 反序列化时被原样保留在文本里了（见 `paragraphJSON`）。
 * 这与整套架构一致：凡是源码里的字符，就留在文档里，不靠推断还原。
 */
function inlineText(node: PMNode): string {
  let out = '';
  node.forEach((child) => {
    if (child.isText) out += child.text ?? '';
    else if (child.type.name === 'hardBreak') out += '\n';
    else out += child.textContent;
  });
  return out;
}

/* ────────────────────────────────────────────
 * 表格
 * ──────────────────────────────────────────── */

/**
 * 序列化为 GFM 表格。
 *
 * 两个必须处理的现实约束：
 *   1. 单元格里的 `|` 会截断表格，必须转义；
 *   2. 单元格里的换行在 GFM 表格里无法表达，压成空格——
 *      这是 GFM 语法本身的限制，不是实现取舍，因此不做无谓的挣扎。
 */
function serializeTable(table: PMNode, ctx: Ctx): string {
  const rows: string[][] = [];
  const aligns: Array<string | null> = [];

  table.forEach((row, _offset, rowIndex) => {
    const cells: string[] = [];
    row.forEach((cell, _o, colIndex) => {
      const text = inlineText(cell.firstChild ?? cell)
        .replace(/\|/g, '\\|')
        .replace(/\n+/g, ' ')
        .trim();
      cells.push(text);
      // 对齐取自首行，GFM 的对齐是按列而非按格
      if (rowIndex === 0) aligns[colIndex] = (cell.attrs.textAlign as string) ?? null;
    });
    rows.push(cells);
  });

  if (rows.length === 0) return '';

  const colCount = Math.max(...rows.map((r) => r.length));
  const pad = (cells: string[]) =>
    `| ${Array.from({ length: colCount }, (_, i) => cells[i] ?? '').join(' | ')} |`;

  const divider = `| ${Array.from({ length: colCount }, (_, i) => {
    switch (aligns[i]) {
      case 'left': return ':---';
      case 'center': return ':---:';
      case 'right': return '---:';
      default: return '---';
    }
  }).join(' | ')} |`;

  const lines = [pad(rows[0]), divider, ...rows.slice(1).map(pad)];
  return lines.map((l) => ctx.indent + l).join('\n');
}

/* ════════════════════════════════════════════
 * Markdown → 文档
 * ════════════════════════════════════════════ */

/**
 * 把 Markdown 解析成 ProseMirror 文档 JSON。
 *
 * 关键差异：**行内语法一个字符都不动**，原样作为文本存进块里，
 * 之后由 LivePreviewInline 的 reconcile 负责铺 mark。
 * 因此这里只需要识别块级结构。
 */
export function markdownToDoc(markdown: string, schema: Schema): PMNode {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: BlockJSON[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    /* 代码围栏 */
    const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const [, , marker, info] = fence;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // 跳过收尾围栏
      const lang = info.trim().toLowerCase();
      if (lang === 'mermaid') {
        blocks.push({
          type: 'mermaidBlock',
          content: body.length ? [{ type: 'text', text: body.join('\n') }] : [],
        });
      } else if (lang === 'diff') {
        blocks.push({
          type: 'diffBlock',
          attrs: { filename: '' },
          content: body.length ? [{ type: 'text', text: body.join('\n') }] : [],
        });
      } else {
        blocks.push({
          type: 'codeBlock',
          attrs: { language: info.trim() },
          content: body.length ? [{ type: 'text', text: body.join('\n') }] : [],
        });
      }
      continue;
    }

    /* 数学块 $$ */
    if (line.trim() === '$$') {
      const formulaLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '$$') {
        formulaLines.push(lines[i]);
        i++;
      }
      i++; // 跳过结束 $$
      blocks.push({
        type: 'mathBlock',
        attrs: { formula: formulaLines.join('\n') },
      });
      continue;
    }

    /* 分割线 */
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'horizontalRule' });
      i++;
      continue;
    }

    /* 引用 */
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const calloutMatch = /^\[!(\w+)\]/.exec(quoted[0] ?? '');
      if (calloutMatch) {
        const calloutType = calloutMatch[1].toLowerCase();
        const calloutBody = [quoted[0].slice(calloutMatch[0].length).trim(), ...quoted.slice(1)]
          .filter((l) => l.trim() || quoted.length > 1)
          .join('\n');
        const calloutInner = calloutBody.trim()
          ? (markdownToDoc(calloutBody, schema).toJSON() as { content?: BlockJSON[] }).content ?? []
          : [{ type: 'paragraph' }];
        blocks.push({ type: 'callout', attrs: { type: calloutType }, content: calloutInner });
      } else {
        const inner = markdownToDoc(quoted.join('\n'), schema).toJSON() as { content?: BlockJSON[] };
        blocks.push({ type: 'blockquote', content: inner.content ?? [] });
      }
      continue;
    }

    /* 表格：识别 `| a | b |` + 分隔行 */
    if (isTableStart(lines, i)) {
      const consumed = parseTable(lines, i);
      blocks.push(consumed.block);
      i = consumed.next;
      continue;
    }

    /* 列表 */
    const listMatch = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (listMatch) {
      const consumed = parseList(lines, i, schema);
      blocks.push(consumed.block);
      i = consumed.next;
      continue;
    }

    /* 其余：段落 / 标题（前缀留在文本里，节点类型由 reconcile 推导） */
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    if (para.length === 0) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(paragraphJSON(para.join('\n')));
  }

  return schema.nodeFromJSON({
    type: 'doc',
    content: blocks.length ? blocks : [{ type: 'paragraph' }],
  });
}

interface BlockJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: unknown[];
}

/** 判断某一行是否开启了一个新的块级结构 */
function isBlockStart(line: string): boolean {
  return (
    /^(\s*)(`{3,}|~{3,})/.test(line) ||
    /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*\|.*\|\s*$/.test(line) ||
    /^(\s*)([-*+]|\d+\.)\s+/.test(line)
  );
}

/* ───────────────────────────────────────────
 * 表格解析
 * ──────────────────────────────────────────── */

const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
const TABLE_DIVIDER_RE = /^\s*\|[\s:|-]+\|\s*$/;

/** GFM 表格必须是「表头行 + 分隔行」开头，只有一行不算表格 */
function isTableStart(lines: string[], index: number): boolean {
  return (
    TABLE_ROW_RE.test(lines[index] ?? '') &&
    TABLE_DIVIDER_RE.test(lines[index + 1] ?? '') &&
    (lines[index + 1] ?? '').includes('-')
  );
}

/** 切分一行的单元格，跳过被反斜杠转义的竖线 */
function splitRow(line: string): string[] {
  const inner = TABLE_ROW_RE.exec(line)?.[1] ?? '';
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && inner[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/** 从分隔行读出每列的对齐方式 */
function parseAligns(divider: string): Array<string | null> {
  return splitRow(divider).map((spec) => {
    const left = spec.startsWith(':');
    const right = spec.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

function parseTable(lines: string[], start: number): { block: BlockJSON; next: number } {
  const header = splitRow(lines[start]);
  const aligns = parseAligns(lines[start + 1]);
  let i = start + 2;

  const bodyRows: string[][] = [];
  while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
    bodyRows.push(splitRow(lines[i]));
    i++;
  }

  const colCount = Math.max(header.length, ...bodyRows.map((r) => r.length), 1);

  const makeCell = (type: string, text: string, colIndex: number): BlockJSON => ({
    type,
    attrs: aligns[colIndex] ? { textAlign: aligns[colIndex] } : {},
    content: [paragraphJSON(text)],
  });

  const rows: BlockJSON[] = [
    {
      type: 'tableRow',
      content: Array.from({ length: colCount }, (_, c) =>
        makeCell('tableHeader', header[c] ?? '', c),
      ),
    },
    ...bodyRows.map((cells) => ({
      type: 'tableRow',
      content: Array.from({ length: colCount }, (_, c) =>
        makeCell('tableCell', cells[c] ?? '', c),
      ),
    })),
  ];

  return { block: { type: 'table', content: rows }, next: i };
}

/**
 * 一段纯文本 → 段落 JSON。
 *
 * 行尾空白**不做裁剪**：Markdown 里「行尾两个空格」是有语义的硬换行标记，
 * 裁掉就等于丢信息。按本架构的一贯做法，它作为真字符留在文本里，
 * 序列化时原样吐出去即可。
 */
function paragraphJSON(text: string): BlockJSON {
  const parts = text.split('\n');
  const content: unknown[] = [];
  parts.forEach((part, idx) => {
    if (part) content.push({ type: 'text', text: part });
    if (idx < parts.length - 1) content.push({ type: 'hardBreak' });
  });
  return { type: 'paragraph', content };
}

/** 解析一段连续的列表行 */
function parseList(
  lines: string[],
  start: number,
  schema: Schema,
): { block: BlockJSON; next: number } {
  const first = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[start])!;
  const baseIndent = first[1].length;
  const ordered = /\d+\./.test(first[2]);

  const items: BlockJSON[] = [];
  let i = start;
  let isTask = false;

  while (i < lines.length) {
    const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
    if (!m || m[1].length !== baseIndent) break;

    let body = m[3];
    let checked: boolean | null = null;
    const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
    if (task) {
      isTask = true;
      checked = task[1].toLowerCase() === 'x';
      body = task[2];
    }
    i++;

    // 收集该项下方缩进更深的续行
    const cont: string[] = [];
    while (i < lines.length && lines[i].trim() && /^\s+/.test(lines[i])) {
      const indent = /^(\s*)/.exec(lines[i])![1].length;
      if (indent <= baseIndent) break;
      cont.push(lines[i].slice(baseIndent + 2));
      i++;
    }

    const inner = cont.length
      ? ((markdownToDoc([body, '', ...cont].join('\n'), schema).toJSON() as { content?: BlockJSON[] })
          .content ?? [])
      : [paragraphJSON(body)];

    items.push(
      checked === null
        ? { type: 'listItem', content: inner }
        : { type: 'taskItem', attrs: { checked }, content: inner },
    );
  }

  const listType = isTask ? 'taskList' : ordered ? 'orderedList' : 'bulletList';
  const attrs = ordered ? { start: parseInt(first[2], 10) || 1 } : undefined;
  return { block: { type: listType, attrs, content: items }, next: i };
}
