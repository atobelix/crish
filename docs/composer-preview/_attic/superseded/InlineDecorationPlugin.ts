/**
 * InlineDecorationPlugin — 行内 Markdown 语法标记的实时显示/隐藏
 *
 * 设计哲学（参考截图中 Obsidian 的实时预览）：
 * - 光标 **进入** 某个 mark（如 bold）时 → 在 mark 前后注入 `**` 装饰
 * - 光标 **离开** 后 → 装饰消失，只显示渲染后的格式效果
 * - 标题行：光标在标题内时，行首显示 `## ` 前缀
 *
 * 支持的行内标记：
 * | Mark       | 语法          |
 * |------------|---------------|
 * | bold       | **...**       |
 * | italic     | *...*         |
 * | strike     | ~~...~~       |
 * | code       | `...`         |
 * | highlight  | ==...==       |
 * | underline  | <u>...</u>    |
 *
 * 性能：只对光标所在的 **当前块节点** 计算装饰，不遍历全文档。
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const inlineDecorationPluginKey = new PluginKey('inlineDecoration');

/* ────────────────────────────────────────────
 * Mark 类型 → 语法标记映射
 * ──────────────────────────────────────────── */

interface MarkSyntax {
  open: string;
  close: string;
}

const MARK_SYNTAX: Record<string, MarkSyntax> = {
  bold:      { open: '**', close: '**' },
  italic:    { open: '*',  close: '*' },
  strike:    { open: '~~', close: '~~' },
  code:      { open: '`',  close: '`' },
  highlight: { open: '==', close: '==' },
  underline: { open: '<u>', close: '</u>' },
};

/* ────────────────────────────────────────────
 * 创建 DOM 元素的工厂函数
 * ──────────────────────────────────────────── */

function createMarkerWidget(text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'md-marker';
  span.textContent = text;
  // contentEditable=false 让 ProseMirror 跳过这个 DOM 节点
  span.contentEditable = 'false';
  return span;
}

function createHeadingPrefixWidget(level: number): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'md-heading-prefix';
  span.textContent = '#'.repeat(level) + ' ';
  span.contentEditable = 'false';
  return span;
}

/* ────────────────────────────────────────────
 * 装饰计算核心逻辑
 * ──────────────────────────────────────────── */

/**
 * 收集当前光标所在块节点内，需要显示语法标记的 mark 区间。
 *
 * 算法：
 * 1. resolve 光标位置，找到所在的块节点（depth > 0 的最内层 block）
 * 2. 遍历块节点的 inline content
 * 3. 对每段文本的每个 mark，检查光标是否在 mark 覆盖范围内
 * 4. 如果是，生成 opening/closing widget decoration
 */
function computeDecorations(state: EditorState): DecorationSet {
  const { selection } = state;
  const { from, to, empty } = selection;
  const decorations: Decoration[] = [];

  // ── 1. 标题前缀装饰 ──
  // 找到光标所在的顶层节点
  const $from = state.doc.resolve(from);
  
  // 遍历 resolve 路径，找到最近的 heading
  for (let depth = $from.depth; depth >= 1; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'heading') {
      const headingStart = $from.start(depth);
      const level = node.attrs.level as number;
      decorations.push(
        Decoration.widget(headingStart, () => createHeadingPrefixWidget(level), {
          side: -1,
          key: `heading-prefix-${headingStart}`,
        })
      );
      break;
    }
  }

  // ── 2. 行内 mark 语法标记装饰 ──
  // 找到光标所在的文本块（最内层的 block 或 inline parent）
  const parentDepth = $from.depth;
  const parentNode = $from.parent;

  // 只处理包含 inline content 的块节点
  if (!parentNode.isTextblock) {
    return DecorationSet.create(state.doc, decorations);
  }

  const blockStart = $from.start(parentDepth);

  // 收集每个 mark 在块内的 [from, to] 区间
  // 由于同一个 mark 可能跨越多个 text node（因中间有其他 mark），
  // 我们需要合并连续的同类 mark 区间
  interface MarkSpan {
    markName: string;
    from: number;  // 文档绝对位置
    to: number;
  }

  const markSpans: MarkSpan[] = [];
  
  // 遍历块的所有子节点（inline content）
  let offset = blockStart;
  parentNode.forEach((child, childOffset) => {
    const childFrom = blockStart + childOffset;
    const childTo = childFrom + child.nodeSize;

    if (child.isText && child.marks.length > 0) {
      for (const mark of child.marks) {
        const markName = mark.type.name;
        if (!(markName in MARK_SYNTAX)) continue;

        // 尝试合并到已有 span（如果上一个 span 的 to 等于当前 childFrom 且 markName 相同）
        const lastSpan = markSpans[markSpans.length - 1];
        if (lastSpan && lastSpan.markName === markName && lastSpan.to === childFrom) {
          lastSpan.to = childTo;
        } else {
          markSpans.push({ markName, from: childFrom, to: childTo });
        }
      }
    }
  });

  // 对每个 mark span，检查光标是否在其中
  for (const span of markSpans) {
    const syntax = MARK_SYNTAX[span.markName];
    if (!syntax) continue;

    // 光标在 mark 区间内（包含边界）
    const cursorInside = from >= span.from && from <= span.to;
    // 或者选区与 mark 区间有重叠
    const selectionOverlaps = !empty && from < span.to && to > span.from;

    if (cursorInside || selectionOverlaps) {
      // 开标记：在 mark 起始位置前插入
      decorations.push(
        Decoration.widget(span.from, () => createMarkerWidget(syntax.open), {
          side: -1,
          key: `mark-open-${span.markName}-${span.from}`,
        })
      );
      // 闭标记：在 mark 结束位置后插入
      decorations.push(
        Decoration.widget(span.to, () => createMarkerWidget(syntax.close), {
          side: 1,
          key: `mark-close-${span.markName}-${span.to}`,
        })
      );
    }
  }

  return DecorationSet.create(state.doc, decorations);
}

/* ────────────────────────────────────────────
 * 创建 Plugin
 * ──────────────────────────────────────────── */

export function createInlineDecorationPlugin(): Plugin {
  return new Plugin({
    key: inlineDecorationPluginKey,

    state: {
      init(_config, state) {
        return computeDecorations(state);
      },
      apply(_tr, _old, _oldState, newState) {
        return computeDecorations(newState);
      },
    },

    props: {
      decorations(state) {
        return inlineDecorationPluginKey.getState(state) as DecorationSet;
      },
    },
  });
}
