/**
 * blockSyntax — 块级 Markdown 前缀
 *
 * 与行内同一套哲学：`# ` `## ` 这些前缀也是**文档里的真字符**，
 * 节点类型与标题级别反过来由文本推导。于是：
 *
 *   在段落行首敲 `## ` → 立刻变成二级标题（前缀留在文本里，只是被隐藏）
 *   在标题行首再敲一个 `#` → 立刻降一级
 *   把 `#` 全删光      → 立刻退回普通段落
 *
 * 这比「输入规则吃掉 `#` 再换节点类型」高明的地方在于**可逆**：
 * 传统 input rule 是单向的，`#` 一旦被吃掉就再也不能通过编辑文本改回来，
 * 用户只能靠快捷键或菜单。这里则是所见即所得的源码编辑。
 *
 * ── 为什么只做标题，不做列表和引用 ──────────────────────
 * 标题是**同一层级的节点类型替换**（paragraph ⇄ heading），
 * `setNodeMarkup` 不改变任何位置，光标天然稳定。
 * 而列表项和引用需要**包裹/解包**结构（paragraph → listItem → bulletList），
 * 会产生位置偏移、需要处理跨块合并与缩进层级，风险量级完全不同。
 * 它们走独立切片，不和本模块混在一起。
 */

import type { Node as PMNode, NodeType, Schema } from '@tiptap/pm/model';
import { parseInline, type InlineParseResult, type SyntaxSpan } from './inlineParser';

/** 标题前缀：1~6 个井号 + 至少一个空格 */
const HEADING_RE = /^(#{1,6})([ \t]+)/;

export interface BlockPrefix {
  kind: 'heading';
  /** 前缀在块文本中占据的字符数（含尾随空格） */
  length: number;
  level: number;
}

/** 目标节点形态 */
export interface BlockShape {
  typeName: 'heading' | 'paragraph';
  attrs: Record<string, unknown>;
}

/* ────────────────────────────────────────────
 * 前缀识别
 * ──────────────────────────────────────────── */

/**
 * 从块文本中识别块级前缀。
 *
 * 注意 `#tag` 不会被误判——标题前缀要求井号后必须有空白，
 * 而标签语法里井号后紧跟的是文字。
 */
export function detectBlockPrefix(text: string): BlockPrefix | null {
  const m = HEADING_RE.exec(text);
  if (!m) return null;
  return {
    kind: 'heading',
    length: m[1].length + m[2].length,
    level: m[1].length,
  };
}

/** 根据前缀推导块应有的节点形态 */
export function shapeForPrefix(prefix: BlockPrefix | null): BlockShape {
  if (prefix?.kind === 'heading') {
    return { typeName: 'heading', attrs: { level: prefix.level } };
  }
  return { typeName: 'paragraph', attrs: {} };
}

/* ────────────────────────────────────────────
 * 与当前节点比对
 * ──────────────────────────────────────────── */

export interface BlockRetype {
  type: NodeType;
  attrs: Record<string, unknown>;
}

/**
 * 计算该块是否需要换节点类型 / 改属性。
 *
 * @returns 需要改动时返回目标类型与属性，无需改动时返回 null
 */
export function resolveBlockRetype(
  node: PMNode,
  text: string,
  schema: Schema,
): BlockRetype | null {
  // 只接管 paragraph 与 heading 两种形态之间的互转。
  // 列表项内部的段落、引用内部的段落等嵌套场景一律跳过，
  // 避免在结构化容器里做出无法安全撤销的类型替换。
  const current = node.type.name;
  if (current !== 'paragraph' && current !== 'heading') return null;

  const shape = shapeForPrefix(detectBlockPrefix(text));
  const targetType = schema.nodes[shape.typeName];
  if (!targetType) return null;

  if (current === shape.typeName) {
    // 类型相同，检查属性（标题级别）
    if (shape.typeName !== 'heading') return null;
    if (node.attrs.level === shape.attrs.level) return null;
    return { type: targetType, attrs: { ...node.attrs, ...shape.attrs } };
  }

  return { type: targetType, attrs: shape.attrs };
}

/* ────────────────────────────────────────────
 * 前缀的语法区间
 * ──────────────────────────────────────────── */

/**
 * 把块级前缀转成一条语法区间。
 *
 * 作用域取**整个块**：光标落在这一行的任何位置，`## ` 都保持可见。
 * 这与 Obsidian 一致，也符合直觉——用户在编辑标题文字时，
 * 理应看得见自己正在编辑的是几级标题。
 */
export function prefixSyntaxSpan(
  prefix: BlockPrefix,
  textLength: number,
): SyntaxSpan {
  return {
    from: 0,
    to: prefix.length,
    scopeFrom: 0,
    scopeTo: textLength,
  };
}

/* ────────────────────────────────────────────
 * 块级 + 行内的统一解析入口
 * ──────────────────────────────────────────── */

/**
 * 解析一个文本块的完整 Markdown 语法（块级前缀 + 行内标记）。
 *
 * 这是 reconcile 与 revealPlugin 共用的**唯一**解析入口，
 * 保证「写进文档的 mark」和「决定显隐的区间」永远出自同一份计算，
 * 不会出现两边规则漂移。
 *
 * 行内解析只作用于前缀之后的正文，再整体右移，
 * 这样将来接入 `- ` `> ` 这类含 `*` 的前缀时也不会互相干扰。
 */
export function parseBlock(text: string): InlineParseResult {
  const prefix = detectBlockPrefix(text);
  if (!prefix) return parseInline(text);

  const shift = prefix.length;
  const body = parseInline(text.slice(shift));

  return {
    marks: body.marks.map((m) => ({ ...m, from: m.from + shift, to: m.to + shift })),
    syntax: [
      prefixSyntaxSpan(prefix, text.length),
      ...body.syntax.map((s) => ({
        from: s.from + shift,
        to: s.to + shift,
        scopeFrom: s.scopeFrom + shift,
        scopeTo: s.scopeTo + shift,
      })),
    ],
  };
}
