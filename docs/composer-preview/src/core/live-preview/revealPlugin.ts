/**
 * revealPlugin — 语法分隔符的显形控制
 *
 * 显隐策略（性能关键）：
 *   CSS 默认把所有 `.md-syntax` 设为 `display:none`，
 *   本插件只为**光标/选区所触及的那几个分隔符**生成 `is-revealed` 装饰。
 *   于是无论文档多长，Decoration 数量都恒定在个位数，
 *   不存在旧版「每次事务重建全文档 DecorationSet」的开销。
 *
 * 显形规则：贴边即显形。
 *   光标只要落在某个 mark 作用域 `[scopeFrom, scopeTo]` 的闭区间内
 *   （含紧贴左右两端的位置），该作用域的分隔符就整体显形。
 *
 *   这条规则有个重要的副产物：**光标永远不可能停在一个隐藏分隔符的边界上**——
 *   因为一旦贴到边界，它就已经显形了。于是不需要任何「方向键跳过隐藏区」
 *   或「退格键整段删除」的特判逻辑，光标行为交给浏览器原生即可。
 *   曾经写过这两段特判，测试证明它们永远不会被触发，已删除。
 *
 *   用户体验上这也正是 Obsidian 的手感：
 *     输入 `**粗体**` 收尾 → 光标贴着右边界 → 仍看得见 `**`；
 *     再敲一个空格 → 光标离开作用域 → `**` 收起，只剩**粗体**。
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isSyntaxRevealed, type SyntaxSpan } from './inlineParser';
import { parseBlock } from './blockSyntax';
import { getBlockText, isLivePreviewTextblock } from './reconcile';

export const revealPluginKey = new PluginKey('livePreviewReveal');

/**
 * 解析结果缓存。
 *
 * ProseMirror 的 Node 是不可变的，同一个对象引用的内容永远不变，
 * 因此可以安全地按引用缓存；节点被替换后旧条目由 GC 自动回收。
 * 这让「同一个块在连续多次选区变化中反复计算」的开销降为一次。
 */
const parseCache = new WeakMap<PMNode, SyntaxSpan[]>();

function getSyntaxSpans(node: PMNode): SyntaxSpan[] {
  let spans = parseCache.get(node);
  if (!spans) {
    spans = parseBlock(getBlockText(node)).syntax;
    parseCache.set(node, spans);
  }
  return spans;
}

/* ────────────────────────────────────────────
 * 装饰计算
 * ──────────────────────────────────────────── */

function buildDecorations(state: EditorState): DecorationSet {
  const { from, to } = state.selection;
  const decorations: Decoration[] = [];

  // 只遍历选区覆盖到的块——其余块的分隔符由 CSS 默认隐藏，零成本
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!isLivePreviewTextblock(node, state)) return true;

    const spans = getSyntaxSpans(node);
    if (spans.length === 0) return false;

    const contentStart = pos + 1;
    const relFrom = from - contentStart;
    const relTo = to - contentStart;

    for (const span of spans) {
      if (!isSyntaxRevealed(span, relFrom, relTo)) continue;
      decorations.push(
        Decoration.inline(contentStart + span.from, contentStart + span.to, {
          class: 'is-revealed',
        }),
      );
    }
    return false;
  });

  return DecorationSet.create(state.doc, decorations);
}

/* ────────────────────────────────────────────
 * Plugin
 * ──────────────────────────────────────────── */

export function createRevealPlugin(): Plugin {
  return new Plugin({
    key: revealPluginKey,

    state: {
      init: (_config, state) => buildDecorations(state),
      apply: (tr, prev, _old, newState) => {
        // 文档与选区都没动时直接复用上一次结果，避免无谓重算
        if (!tr.docChanged && !tr.selectionSet) return prev;
        return buildDecorations(newState);
      },
    },

    props: {
      decorations(state) {
        return revealPluginKey.getState(state) as DecorationSet;
      },
    },
  });
}
