/**
 * commands — 面向 Token-in-Document 的格式命令
 *
 * 在传统富文本编辑器里，「加粗」是给选区套一个 mark。
 * 但在本架构里 mark 只是文本的投影，真正的事实是那两个星号。
 * 所以这里所有格式命令做的都是**编辑文本**：
 *
 *   加粗   → 在选区两侧插入 `**`
 *   取消加粗 → 删掉包住选区的那两个 `**`
 *   改标题级别 → 改写行首的井号
 *
 * 好处是命令、键盘、菜单三条路径产生的结果完全一致，
 * 也天然与用户手打的语法等价——不存在「菜单加的粗」和
 * 「手打的粗」两套内部表示。
 */

import type { RawCommands } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { parseBlock, detectBlockPrefix } from './blockSyntax';
import { getBlockText, isLivePreviewTextblock } from './reconcile';
import type { InlineMarkName } from './inlineParser';

/** 分隔符 → 对应的 mark 名 */
export const MARKER_TO_MARK: Record<string, InlineMarkName> = {
  '**': 'bold',
  '*': 'italic',
  '~~': 'strike',
  '==': 'highlight',
  '`': 'code',
};

/** mark 名 → 首选分隔符 */
export const MARK_TO_MARKER: Record<string, string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  highlight: '==',
  code: '`',
};

/* ────────────────────────────────────────────
 * 定位辅助
 * ──────────────────────────────────────────── */

interface BlockContext {
  /** 块内容起点的文档绝对位置 */
  contentStart: number;
  text: string;
  /** 选区在块内的相对偏移 */
  relFrom: number;
  relTo: number;
}

function blockContext(state: EditorState): BlockContext | null {
  const { $from, from, to } = state.selection;
  const node = $from.parent;
  if (!isLivePreviewTextblock(node, state)) return null;
  // 跨块选区不做处理——格式命令的语义在跨块时并不明确
  if (to > $from.end()) return null;

  const contentStart = $from.start();
  return {
    contentStart,
    text: getBlockText(node),
    relFrom: from - contentStart,
    relTo: to - contentStart,
  };
}

/**
 * 找出「正好包住当前选区」的指定类型 mark，并返回它的两段分隔符。
 *
 * 用于判断该执行「加」还是「去」：找得到就是去，找不到就是加。
 */
function enclosingDelimiters(
  ctx: BlockContext,
  markName: InlineMarkName,
): { open: { from: number; to: number }; close: { from: number; to: number } } | null {
  const { marks, syntax } = parseBlock(ctx.text);

  // 取包住选区的、范围最小的那个同类 mark
  const candidates = marks
    .filter((m) => m.name === markName && m.from <= ctx.relFrom && m.to >= ctx.relTo)
    .sort((a, b) => a.to - a.from - (b.to - b.from));
  const target = candidates[0];
  if (!target) return null;

  const owned = syntax
    .filter((s) => s.scopeFrom === target.from && s.scopeTo === target.to)
    .sort((a, b) => a.from - b.from);
  if (owned.length !== 2) return null;

  return { open: owned[0], close: owned[1] };
}

/* ────────────────────────────────────────────
 * 行内格式
 * ──────────────────────────────────────────── */

function applyToggleMarker(
  state: EditorState,
  tr: Transaction,
  marker: string,
): boolean {
  const ctx = blockContext(state);
  if (!ctx) return false;

  const markName = MARKER_TO_MARK[marker];
  const existing = markName ? enclosingDelimiters(ctx, markName) : null;

  if (existing) {
    // ── 取消格式：删掉两段分隔符，后面的先删以免位置失效 ──
    const closeFrom = ctx.contentStart + existing.close.from;
    const closeTo = ctx.contentStart + existing.close.to;
    const openFrom = ctx.contentStart + existing.open.from;
    const openTo = ctx.contentStart + existing.open.to;

    tr.delete(closeFrom, closeTo);
    tr.delete(openFrom, openTo);

    // 选区跟着左移一个开分隔符的宽度
    const shift = existing.open.to - existing.open.from;
    const nextFrom = Math.max(openFrom, ctx.contentStart + ctx.relFrom - shift);
    const nextTo = Math.max(nextFrom, ctx.contentStart + ctx.relTo - shift);
    tr.setSelection(TextSelection.create(tr.doc, nextFrom, nextTo));
    return true;
  }

  // ── 添加格式 ──
  const from = ctx.contentStart + ctx.relFrom;
  const to = ctx.contentStart + ctx.relTo;

  if (ctx.relFrom === ctx.relTo) {
    // 空选区：插入一对分隔符并把光标放中间，用户接着打字即可
    tr.insertText(marker + marker, from);
    tr.setSelection(TextSelection.create(tr.doc, from + marker.length));
    return true;
  }

  tr.insertText(marker, to);
  tr.insertText(marker, from);
  tr.setSelection(
    TextSelection.create(tr.doc, from + marker.length, to + marker.length),
  );
  return true;
}

/* ────────────────────────────────────────────
 * 链接
 * ──────────────────────────────────────────── */

function applyLink(state: EditorState, tr: Transaction, href: string): boolean {
  const ctx = blockContext(state);
  if (!ctx) return false;

  const from = ctx.contentStart + ctx.relFrom;
  const to = ctx.contentStart + ctx.relTo;

  const existing = enclosingDelimiters(ctx, 'link');
  if (existing) {
    // 已是链接：仅改写 URL 部分 `](old)` → `](new)`
    tr.replaceWith(
      ctx.contentStart + existing.close.from,
      ctx.contentStart + existing.close.to,
      state.schema.text(`](${href})`),
    );
    return true;
  }

  if (ctx.relFrom === ctx.relTo) {
    const text = `[链接](${href})`;
    tr.insertText(text, from);
    // 光标落在链接文字上，方便立刻改名
    tr.setSelection(TextSelection.create(tr.doc, from + 1, from + 3));
    return true;
  }

  tr.insertText(`](${href})`, to);
  tr.insertText('[', from);
  tr.setSelection(TextSelection.create(tr.doc, from + 1, to + 1));
  return true;
}

function removeLink(state: EditorState, tr: Transaction): boolean {
  const ctx = blockContext(state);
  if (!ctx) return false;
  const existing = enclosingDelimiters(ctx, 'link');
  if (!existing) return false;

  tr.delete(ctx.contentStart + existing.close.from, ctx.contentStart + existing.close.to);
  tr.delete(ctx.contentStart + existing.open.from, ctx.contentStart + existing.open.to);
  return true;
}

/* ────────────────────────────────────────────
 * 标题级别
 * ──────────────────────────────────────────── */

function applyHeadingLevel(
  state: EditorState,
  tr: Transaction,
  level: number,
): boolean {
  const ctx = blockContext(state);
  if (!ctx) return false;

  const prefix = detectBlockPrefix(ctx.text);
  const currentLevel = prefix?.level ?? 0;
  // 点击已激活的级别 = 取消，回到普通段落
  const nextLevel = currentLevel === level ? 0 : level;

  const desired = nextLevel === 0 ? '' : `${'#'.repeat(nextLevel)} `;
  const oldLength = prefix?.length ?? 0;

  if (desired.length === oldLength && desired === ctx.text.slice(0, oldLength)) {
    return false;
  }

  const start = ctx.contentStart;
  if (oldLength > 0) tr.delete(start, start + oldLength);
  if (desired) tr.insertText(desired, start);

  const delta = desired.length - oldLength;
  const caret = Math.max(start, ctx.contentStart + ctx.relFrom + delta);
  tr.setSelection(TextSelection.create(tr.doc, Math.min(caret, tr.doc.content.size)));
  return true;
}

/* ────────────────────────────────────────────
 * 命令注册
 * ──────────────────────────────────────────── */

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    livePreviewFormat: {
      /** 在选区两侧插入/删除指定的 Markdown 分隔符 */
      toggleMarker: (marker: string) => ReturnType;
      /** 加粗（插入/删除 `**`） */
      toggleBold: () => ReturnType;
      /** 斜体（插入/删除 `*`） */
      toggleItalic: () => ReturnType;
      /** 删除线（插入/删除 `~~`） */
      toggleStrike: () => ReturnType;
      /** 高亮（插入/删除 `==`） */
      toggleHighlight: () => ReturnType;
      /** 行内代码（插入/删除 `` ` ``） */
      toggleCode: () => ReturnType;
      /** 设置链接；传入相同级别时改写 URL */
      setMarkdownLink: (href: string) => ReturnType;
      /** 取消链接，保留链接文字 */
      unsetMarkdownLink: () => ReturnType;
      /** 设置标题级别；传 0 或重复当前级别则回退为段落 */
      setHeadingLevel: (level: number) => ReturnType;
    };
  }
}

export const livePreviewCommands: Partial<RawCommands> = {
  toggleMarker:
    (marker: string) =>
    ({ state, tr, dispatch }) => {
      if (!dispatch) return true;
      return applyToggleMarker(state, tr, marker);
    },

  toggleBold:
    () =>
    ({ state, tr, dispatch }) =>
      dispatch ? applyToggleMarker(state, tr, '**') : true,

  toggleItalic:
    () =>
    ({ state, tr, dispatch }) =>
      dispatch ? applyToggleMarker(state, tr, '*') : true,

  toggleStrike:
    () =>
    ({ state, tr, dispatch }) =>
      dispatch ? applyToggleMarker(state, tr, '~~') : true,

  toggleHighlight:
    () =>
    ({ state, tr, dispatch }) =>
      dispatch ? applyToggleMarker(state, tr, '==') : true,

  toggleCode:
    () =>
    ({ state, tr, dispatch }) =>
      dispatch ? applyToggleMarker(state, tr, '`') : true,

  setMarkdownLink:
    (href: string) =>
    ({ state, tr, dispatch }) =>
      dispatch ? applyLink(state, tr, href) : true,

  unsetMarkdownLink:
    () =>
    ({ state, tr, dispatch }) =>
      dispatch ? removeLink(state, tr) : true,

  setHeadingLevel:
    (level: number) =>
    ({ state, tr, dispatch }) =>
      dispatch ? applyHeadingLevel(state, tr, level) : true,
};

/** 键盘快捷键：与菜单走同一套命令，保证行为一致 */
export const livePreviewKeymap: Record<string, string> = {
  'Mod-b': 'toggleBold',
  'Mod-i': 'toggleItalic',
  'Mod-Shift-s': 'toggleStrike',
  'Mod-Shift-h': 'toggleHighlight',
  'Mod-e': 'toggleCode',
};
