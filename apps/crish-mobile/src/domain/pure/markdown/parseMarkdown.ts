// markdown 解析层（MD1)：markdown-it 只作解析器，token 流在此映射为自有 AST
// （types.ts)。选型与口径（审计 §C.2)：
// - CommonMark 导向，与桌面 Rust 渲染器风味差最小；token 流扁平、映射直接；
// - html: false —— 内嵌 HTML 按纯文本呈现（安全口径，审计 B.1)，不渲染 HTML；
// - linkify: true —— 裸 URL 自动链接化（审计 C.5)，链接出口在呈现层统一收口；
// - breaks: true —— 单个换行即断行，贴合模型输出的聊天文本习惯；
// - typographer: false —— 不改写引号 / 破折号，正文逐字保真。
// 纯函数 + 小容量结果缓存（按全文键，历史消息回滚不重解析，审计 C.4)。
import MarkdownIt from 'markdown-it';
import type { MdBlock, MdListItem, MdSpan, MdTableAlign } from './types';

/** 解析器 token 的最小结构面（自有定义，隔离 @types/markdown-it 的版本差异） */
interface MdToken {
  type: string;
  tag: string;
  nesting: number;
  content: string;
  info: string;
  children: MdToken[] | null;
  attrs: [string, string][] | null;
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

const CACHE_LIMIT = 50;
const cache = new Map<string, MdBlock[]>();

function cacheGet(text: string): MdBlock[] | undefined {
  const hit = cache.get(text);
  if (hit) {
    // LRU 续期：命中项挪到队尾
    cache.delete(text);
    cache.set(text, hit);
  }
  return hit;
}

function cacheSet(text: string, blocks: MdBlock[]): void {
  cache.set(text, blocks);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** 测试隔离：清空解析缓存 */
export function clearMarkdownCacheForTest(): void {
  cache.clear();
}

function attrOf(token: MdToken, name: string): string | null {
  if (!token.attrs) return null;
  for (const [key, value] of token.attrs) {
    if (key === name) return value;
  }
  return null;
}

/** 相邻 text 片段合并（渲染层少建节点，签名比较更稳定） */
function pushText(spans: MdSpan[], text: string): void {
  if (text === '') return;
  const last = spans[spans.length - 1];
  if (last && last.type === 'text') {
    last.text += text;
    return;
  }
  spans.push({ type: 'text', text });
}

function collectText(tokens: readonly MdToken[]): string {
  let out = '';
  for (const token of tokens) {
    if (token.type === 'text' || token.type === 'text_special') {
      out += token.content;
    }
    if (token.children) out += collectText(token.children);
  }
  return out;
}

/** inline token 的 children → MdSpan[]（开闭标记以栈配对，嵌套格式天然成树） */
export function parseSpans(children: readonly MdToken[]): MdSpan[] {
  const root: MdSpan[] = [];
  const stack: MdSpan[][] = [root];
  const top = (): MdSpan[] => stack[stack.length - 1]!;

  for (const token of children) {
    switch (token.type) {
      case 'text':
      case 'text_special':
        pushText(top(), token.content);
        break;
      case 'softbreak':
      case 'hardbreak':
        top().push({ type: 'break' });
        break;
      case 'code_inline':
        top().push({ type: 'code', text: token.content });
        break;
      case 'strong_open': {
        const span: MdSpan = { type: 'strong', children: [] };
        top().push(span);
        stack.push((span as { children: MdSpan[] }).children);
        break;
      }
      case 'em_open': {
        const span: MdSpan = { type: 'em', children: [] };
        top().push(span);
        stack.push((span as { children: MdSpan[] }).children);
        break;
      }
      case 's_open': {
        const span: MdSpan = { type: 'del', children: [] };
        top().push(span);
        stack.push((span as { children: MdSpan[] }).children);
        break;
      }
      case 'strong_close':
      case 'em_close':
      case 's_close':
        if (stack.length > 1) stack.pop();
        break;
      case 'link_open': {
        const span: MdSpan = {
          type: 'link',
          href: attrOf(token, 'href') ?? '',
          children: [],
        };
        top().push(span);
        stack.push((span as { children: MdSpan[] }).children);
        break;
      }
      case 'link_close':
        if (stack.length > 1) stack.pop();
        break;
      case 'image':
        top().push({
          type: 'image',
          src: attrOf(token, 'src') ?? '',
          alt: token.children ? collectText(token.children) : token.content,
        });
        break;
      case 'html_inline':
        // html:false 下基本不出现；防御性按原文呈现（与纯文本口径一致）
        pushText(top(), token.content);
        break;
      default:
        // 未知行内容器：拍平其 children，不丢内容
        if (token.children) {
          for (const span of parseSpans(token.children)) top().push(span);
        } else if (token.content) {
          pushText(top(), token.content);
        }
        break;
    }
  }
  return root;
}

interface Cursor {
  tokens: readonly MdToken[];
  i: number;
}

function peek(cursor: Cursor): MdToken | undefined {
  return cursor.tokens[cursor.i];
}

/** 任务列表标记：段首文本以 [ ] / [x] / [X] 开头（markdown-it 无任务列表插件，
 * 以 GFM 通行写法在映射层识别；命中后剥掉标记字符） */
const TASK_MARKER = /^\[([ xX])\]\s+/;

function applyTaskMarker(item: MdListItem): void {
  const first = item.blocks[0];
  if (!first || first.type !== 'paragraph') return;
  const head = first.spans[0];
  if (!head || head.type !== 'text') return;
  const match = TASK_MARKER.exec(head.text);
  if (!match) return;
  item.checked = match[1] !== ' ';
  const rest = head.text.slice(match[0].length);
  if (rest === '') {
    first.spans.shift();
  } else {
    first.spans[0] = { type: 'text', text: rest };
  }
}

function parseList(cursor: Cursor, ordered: boolean): MdBlock {
  const open = peek(cursor)!;
  const startAttr = attrOf(open, 'start');
  const start = startAttr ? Number.parseInt(startAttr, 10) || 1 : 1;
  cursor.i += 1; // list_open
  const items: MdListItem[] = [];
  while (peek(cursor) && peek(cursor)!.type === 'list_item_open') {
    cursor.i += 1; // list_item_open
    const blocks = parseBlockList(cursor, 'list_item_close');
    cursor.i += 1; // list_item_close
    const item: MdListItem = { checked: null, blocks };
    applyTaskMarker(item);
    items.push(item);
  }
  cursor.i += 1; // list_close
  return { type: 'list', ordered, start, items };
}

function alignOf(token: MdToken): MdTableAlign {
  const style = attrOf(token, 'style') ?? '';
  if (style.includes('text-align:center')) return 'center';
  if (style.includes('text-align:right')) return 'right';
  if (style.includes('text-align:left')) return 'left';
  return null;
}

function parseTable(cursor: Cursor): MdBlock {
  cursor.i += 1; // table_open
  const header: MdSpan[][] = [];
  const align: MdTableAlign[] = [];
  const rows: MdSpan[][][] = [];

  const readRow = (cellTag: 'th' | 'td', sink: MdSpan[][]): void => {
    cursor.i += 1; // tr_open
    while (peek(cursor) && peek(cursor)!.type === `${cellTag}_open`) {
      const cellToken = peek(cursor)!;
      if (cellTag === 'th') align.push(alignOf(cellToken));
      cursor.i += 1; // cell_open
      const inline = peek(cursor);
      sink.push(
        inline && inline.type === 'inline'
          ? parseSpans(inline.children ?? [])
          : []
      );
      if (inline) cursor.i += 1; // inline
      cursor.i += 1; // cell_close
    }
    cursor.i += 1; // tr_close
  };

  if (peek(cursor)?.type === 'thead_open') {
    cursor.i += 1;
    if (peek(cursor)?.type === 'tr_open') readRow('th', header);
    cursor.i += 1; // thead_close
  }
  if (peek(cursor)?.type === 'tbody_open') {
    cursor.i += 1;
    while (peek(cursor)?.type === 'tr_open') {
      const row: MdSpan[][] = [];
      readRow('td', row);
      rows.push(row);
    }
    cursor.i += 1; // tbody_close
  }
  cursor.i += 1; // table_close
  return { type: 'table', header, align, rows };
}

/** 块级 token 流 → MdBlock[]；stopType 为容器闭合 token（命中即停，闭合由调用方消费） */
export function parseBlockList(
  cursor: Cursor,
  stopType: string | null
): MdBlock[] {
  const blocks: MdBlock[] = [];
  for (;;) {
    const token = peek(cursor);
    if (!token) break;
    if (stopType && token.type === stopType) break;
    switch (token.type) {
      case 'paragraph_open': {
        cursor.i += 1;
        const inline = peek(cursor);
        const spans =
          inline && inline.type === 'inline'
            ? parseSpans(inline.children ?? [])
            : [];
        if (inline) cursor.i += 1;
        cursor.i += 1; // paragraph_close
        if (spans.length === 1 && spans[0]!.type === 'image') {
          const image = spans[0] as { src: string; alt: string };
          blocks.push({ type: 'image', src: image.src, alt: image.alt });
        } else if (spans.length > 0) {
          blocks.push({ type: 'paragraph', spans });
        }
        break;
      }
      case 'heading_open': {
        const level = Number.parseInt(token.tag.slice(1), 10);
        cursor.i += 1;
        const inline = peek(cursor);
        const spans =
          inline && inline.type === 'inline'
            ? parseSpans(inline.children ?? [])
            : [];
        if (inline) cursor.i += 1;
        cursor.i += 1; // heading_close
        blocks.push({
          type: 'heading',
          level: Math.min(6, Math.max(1, level)) as 1 | 2 | 3 | 4 | 5 | 6,
          spans,
        });
        break;
      }
      case 'fence':
      case 'code_block': {
        cursor.i += 1;
        const lang =
          token.type === 'fence'
            ? token.info.trim().split(/\s+/)[0] || null
            : null;
        blocks.push({
          type: 'code',
          lang,
          text: token.content.replace(/\n$/, ''),
        });
        break;
      }
      case 'bullet_list_open':
        blocks.push(parseList(cursor, false));
        break;
      case 'ordered_list_open':
        blocks.push(parseList(cursor, true));
        break;
      case 'blockquote_open': {
        cursor.i += 1;
        const inner = parseBlockList(cursor, 'blockquote_close');
        cursor.i += 1; // blockquote_close
        blocks.push({ type: 'quote', blocks: inner });
        break;
      }
      case 'table_open':
        blocks.push(parseTable(cursor));
        break;
      case 'hr':
        cursor.i += 1;
        blocks.push({ type: 'hr' });
        break;
      case 'html_block':
        // html:false 下 HTML 源码以 paragraph 形态到达，此处为防御分支：
        // 万一出现 html_block，一律降为原文段落（纯文本口径，不渲染 HTML）
        cursor.i += 1;
        if (token.content.trim() !== '') {
          blocks.push({
            type: 'paragraph',
            spans: [{ type: 'text', text: token.content.trim() }],
          });
        }
        break;
      default:
        // 未识别块级 token：跳过本 token，不中断整体解析（前向兼容）
        cursor.i += 1;
        break;
    }
  }
  return blocks;
}

/** markdown 原文 → 自有 AST（静态 / 终态入口；流式入口见 closeDraft.ts) */
export function parseMarkdown(text: string): MdBlock[] {
  if (text === '') return [];
  const cached = cacheGet(text);
  if (cached) return cached;
  const tokens = md.parse(text, {}) as unknown as MdToken[];
  const blocks = parseBlockList({ tokens, i: 0 }, null);
  cacheSet(text, blocks);
  return blocks;
}
