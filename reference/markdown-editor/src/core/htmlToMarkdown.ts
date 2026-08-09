// src/core/htmlToMarkdown.ts
// R4-E 剪贴板语义纯函数模块（04 编辑深度扩展 §5.3 方案 1 / §5.4 接入点）：
// 1. htmlToMarkdown：HTML → Markdown 粗粒度转换器（覆盖常见粘贴标签：
//    p/br/strong/em/del/code/a/img/ul/ol/li/table/h1-h6/blockquote/hr/pre，
//    不做完整 html-to-md——嵌套深度语义、属性细节不处理）；
// 2. tabularTextToMarkdown：剪贴板 \t+\n 结构 → markdown 表格（Excel/
//    表格粘贴高频场景，parseRowCells「逐分隔符拆单元格」思路的本地实现）；
// 3. wrapUrlWithSelection：纯 URL 粘贴 → 选区文本包 [text](url) /
//    无选区时插入 URL 原文；
// 4. buildPasteText：粘贴内容编排（优先级：表格结构（text/plain 优先）>
//    纯 URL > HTML → Markdown > 纯文本原文），返回 null 表示无内容。
// 全部为纯函数（输入字符串输出字符串，无外部副作用），DOM 解析惰性
// 获取（仅 htmlToMarkdown 需要 DOMParser，浏览器/jsdom 均可用），
// 便于单元测试与复用。

// —— HTML → Markdown 粗粒度转换器 ——

/** 行内强样式标签（内容直接包裹 markdown 记号） */
const STRONG_TAGS = new Set(['strong', 'b']);
const EM_TAGS = new Set(['em', 'i']);
const DEL_TAGS = new Set(['del', 's', 'strike']);

/**
 * 折叠文本空白：HTML 渲染语义中连续空白（含换行/制表符）等价单空格，
 * 粘贴的 HTML 源码常带排版缩进/换行，必须折叠为单空格再入 markdown；
 * nbsp（\u00A0，Word/网页复制常见）归一为普通空格，避免破坏解析。
 */
function collapseWhitespace(text: string): string {
  return text.replace(/[\t\n\r ]+/g, ' ').replace(/\u00A0/g, ' ');
}

/**
 * 递归渲染节点树为 markdown 文本。
 * 块级标签：产出独立块（前后空行包裹）；行内标签：产出包裹样式；
 * 文本节点：折叠空白（pre 上下文保留原样）；其余标签视为透明容器。
 */
function renderNode(node: Node, preserveWhitespace: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return preserveWhitespace
      ? node.nodeValue ?? ''
      : collapseWhitespace(node.nodeValue ?? '');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  // 内联内容：pre 内继续保留空白（代码原文），其余按当前上下文
  const inner = () => renderChildren(el, preserveWhitespace || tag === 'pre');

  if (tag === 'pre') {
    // 代码块：围栏语法（语言信息粗粒度不识别，空语言围栏兜底；
    // 尾部换行剔除防空行）
    const code = (el.textContent ?? '').replace(/\n$/, '');
    return '\n\n```\n' + code + '\n```\n\n';
  }
  if (tag === 'br') return '\n';
  if (STRONG_TAGS.has(tag)) return `**${inner().trim()}**`;
  if (EM_TAGS.has(tag)) return `*${inner().trim()}*`;
  if (DEL_TAGS.has(tag)) return `~~${inner().trim()}~~`;
  if (tag === 'code') return '`' + (el.textContent ?? '').trim() + '`';
  if (tag === 'a') {
    const href = el.getAttribute('href') ?? '';
    const text = inner().trim();
    if (text && href) return `[${text}](${href})`;
    // 无文字链接（图片链接等）：退化为 href 原文，不丢信息
    return href || text;
  }
  if (tag === 'img') {
    const src = el.getAttribute('src') ?? '';
    const alt = el.getAttribute('alt') ?? '';
    return src ? `![${alt}](${src})` : '';
  }
  if (tag === 'hr') return '\n\n---\n\n';
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    return '\n\n' + '#'.repeat(level) + ' ' + inner().trim() + '\n\n';
  }
  if (tag === 'p') return '\n\n' + inner().trim() + '\n\n';
  if (tag === 'blockquote') {
    // 引用：内容每行加 '> ' 前缀（内嵌换行——br/块级——逐行覆盖）
    const lines = inner().trim().split('\n');
    return '\n\n' + lines.map((line) => '> ' + line).join('\n') + '\n\n';
  }
  if (tag === 'ul' || tag === 'ol') {
    return '\n\n' + renderList(el, tag === 'ol') + '\n\n';
  }
  if (tag === 'table') {
    const md = tableToMarkdown(el);
    return md ? '\n\n' + md + '\n\n' : '';
  }
  // 其余标签（div/span/section/article/thead 等）：透明容器递归透传
  return renderChildren(el, preserveWhitespace);
}

/** 渲染父节点全部子节点并拼接 */
function renderChildren(parent: Node, preserveWhitespace: boolean): string {
  let out = '';
  for (const child of Array.from(parent.childNodes)) {
    out += renderNode(child, preserveWhitespace);
  }
  return out;
}

/**
 * 列表渲染：ul → '-' 前缀、ol → 序号前缀（一层；li 内嵌套列表的后续行
 * 统一两空格缩进，保持嵌套层级的视觉层级——粗粒度不深入递归缩进）
 */
function renderList(list: HTMLElement, ordered: boolean): string {
  let index = 1;
  const items: string[] = [];
  for (const child of Array.from(list.children)) {
    const el = child as HTMLElement;
    if (el.tagName.toLowerCase() !== 'li') continue;
    const prefix = ordered ? `${index}. ` : '- ';
    const content = renderChildren(el, false)
      .trim()
      .split('\n')
      // 嵌套块级（ul/ol）在 li 内产出空行包裹：空行剔除，防孤立缩进行
      .filter((line) => line.trim() !== '')
      // 首行与 li 前缀同排，后续行（嵌套列表/换行内容）统一缩进
      .map((line, i) => (i === 0 ? line : '  ' + line))
      .join('\n');
    items.push(prefix + content);
    index += 1;
  }
  return items.join('\n');
}

/**
 * 表格渲染：收集所有 tr 行（thead/tbody/tfoot 不区分，th/td 均按单元格），
 * 首行作表头 + 对齐分隔行 + 数据行；列数取最大行宽补齐，单元格内
 * 管道符转义（\|）、换行折叠为空格，保证输出为合法 markdown 表格。
 */
function tableToMarkdown(table: HTMLElement): string {
  const rows: string[][] = [];
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    const cells: string[] = [];
    for (const cell of Array.from(tr.children)) {
      const tag = cell.tagName.toLowerCase();
      if (tag !== 'th' && tag !== 'td') continue;
      cells.push(renderChildren(cell, false).trim());
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (row: string[]) => [
    ...row,
    ...Array(Math.max(0, cols - row.length)).fill(''),
  ];
  const escapeCell = (cell: string) =>
    cell.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rowLines = rows.map(
    (row) => '| ' + pad(row).map(escapeCell).join(' | ') + ' |'
  );
  const separator = '|' + Array(cols).fill(' --- ').join('|') + '|';
  return [rowLines[0], separator, ...rowLines.slice(1)].join('\n');
}

/** DOMParser 惰性获取（浏览器/jsdom 可用；node 裸环境调用时给出明确错误） */
let domParser: DOMParser | null | undefined;
function getDomParser(): DOMParser {
  if (domParser === undefined) {
    domParser = typeof DOMParser !== 'undefined' ? new DOMParser() : null;
  }
  if (!domParser) {
    throw new Error('htmlToMarkdown 需要 DOMParser 环境（浏览器或 jsdom）');
  }
  return domParser;
}

/**
 * HTML → Markdown 粗粒度转换（04 §5.3 方案 1 C1）：
 * 解析为文档后仅遍历 body；连续空行折叠（嵌套块级产出的 \n\n\n 归并为
 * \n\n），整体 trim。空 HTML/纯文本输入返回 ''。
 */
export function htmlToMarkdown(html: string): string {
  const doc = getDomParser().parseFromString(html, 'text/html');
  return renderChildren(doc.body, false)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// —— 剪贴板表格结构（\t+\n → markdown 表格）——

/**
 * 表格结构检测：文本含制表符即视为表格粘贴（Excel/表格复制统一带 \t；
 * 单行多列也成立——粘贴即表格的直觉语义）
 */
export function isTabularText(text: string): boolean {
  return text.includes('\t');
}

/**
 * 剪贴板表格文本 → markdown 表格：\n 拆行（容忍 \r\n）、\t 拆单元格、
 * 空行剔除；首行作表头 + 对齐分隔行 + 数据行；列数取最大行宽补齐，
 * 单元格管道符转义（parseRowCells「按分隔符拆格」思路的本地实现）。
 */
export function tabularTextToMarkdown(text: string): string {
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => line.split('\t').map((cell) => cell.trim()));
  if (rows.length === 0) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (row: string[]) => [
    ...row,
    ...Array(Math.max(0, cols - row.length)).fill(''),
  ];
  const escapeCell = (cell: string) => cell.replace(/\|/g, '\\|');
  const rowLines = rows.map(
    (row) => '| ' + pad(row).map(escapeCell).join(' | ') + ' |'
  );
  const separator = '|' + Array(cols).fill(' --- ').join('|') + '|';
  return [rowLines[0], separator, ...rowLines.slice(1)].join('\n');
}

// —— 纯 URL 粘贴包装 ——

/** 纯 URL 检测：单行、含制表符/换行者不算；协议限 http/https（粗粒度） */
const PLAIN_URL_RE = /^https?:\/\/[^\s]+$/i;

export function isPlainUrl(text: string): boolean {
  const trimmed = text.trim();
  return (
    !trimmed.includes('\n') &&
    !trimmed.includes('\t') &&
    PLAIN_URL_RE.test(trimmed)
  );
}

/**
 * URL 包装：选区有文本 → [text](url)（选区多行折叠为单行，防破坏
 * markdown 链接语法）；无选区 → 返回 URL 原文（04 §5.3 方案 1 C3）。
 */
export function wrapUrlWithSelection(
  url: string,
  selectionText: string
): string {
  const trimmed = url.trim();
  const sel = selectionText.trim();
  if (!sel) return trimmed;
  return `[${sel.replace(/\s+/g, ' ')}](${trimmed})`;
}

// —— 粘贴内容编排 ——

/**
 * 粘贴内容编排（04 §5.3 方案 1，text/plain 优先）：
 * 1. 表格结构（含 \t）→ markdown 表格（Excel 粘贴不依赖 html 字段）；
 * 2. 纯 URL → [选区文本](url) / URL 原文；
 * 3. 剪贴板含 HTML 标签 → htmlToMarkdown 转换（网页富文本语义保留）；
 * 4. 否则纯文本原文透传。
 * 返回 null 表示无任何可粘贴内容（调用方不拦截，浏览器默认处理为空）。
 */
export function buildPasteText(
  plainText: string,
  htmlText: string,
  selectionText: string
): string | null {
  if (isTabularText(plainText)) return tabularTextToMarkdown(plainText);
  if (isPlainUrl(plainText)) {
    return wrapUrlWithSelection(plainText, selectionText);
  }
  const html = htmlText ?? '';
  // 粗粒度 HTML 检测：含形如 <tag 的尖括号结构才走转换（纯文本复制时
  // 部分浏览器也会写入 text/html 字段，但为纯文本无标签，直接透传）
  if (html && /<[a-zA-Z][^>]*>/.test(html)) {
    // HTML 存在但转换结果为空（如 <p></p>）→ 归并为 null（无内容可粘）
    return htmlToMarkdown(html) || null;
  }
  return plainText || null;
}
