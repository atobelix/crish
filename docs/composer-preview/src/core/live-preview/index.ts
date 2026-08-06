/**
 * LivePreviewInline — Token-in-Document 行内实时预览引擎（组装入口）
 *
 * 把四块拼在一起：
 *   marks.ts         无输入规则的行内 mark，保证语法字符不被吞掉
 *   syntaxMark.ts    给语法字符打的 `mdSyntax` 标记
 *   reconcile.ts     文本 → marks 的重解析（appendTransaction）
 *   revealPlugin.ts  显形装饰 + 键盘行为
 *
 * 用法（见 shell/Editor.tsx）：
 * ```ts
 * StarterKit.configure({ ...STARTER_KIT_DISABLED }),
 * LivePreviewInline,
 * ```
 *
 * 已知边界（后续切片处理）：
 *   - 块级语法（`# `、`> `、`- `）尚未纳入，属于 S2；
 *   - Markdown 导入导出尚未改造，属于 S3。
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { SyntaxMark } from './syntaxMark';
import { LIVE_PREVIEW_MARKS } from './marks';
import { LIVE_PREVIEW_NODES } from './nodes';
import { livePreviewCommands } from './commands';
import { createRevealPlugin } from './revealPlugin';
import { getChangedRanges, reconcileRanges, reconcileAll } from './reconcile';

export const reconcilePluginKey = new PluginKey('livePreviewReconcile');

/** 事务上打此 meta 表示「这是重解析产生的」，避免自我触发形成死循环 */
export const RECONCILE_META = 'livePreviewReconcile';

/* ────────────────────────────────────────────
 * 重解析插件
 * ──────────────────────────────────────────── */

/** 给一个事务打上「这是重解析产生的」标记：不自我触发、不占撤销步骤 */
function tagReconcileTransaction(tr: import('@tiptap/pm/state').Transaction): void {
  tr.setMeta(RECONCILE_META, true);
  // marks 是文本的纯函数，撤销时会被重新算出来，不需要也不应该单独占一步历史
  tr.setMeta('addToHistory', false);
}

/**
 * 对全文做一次重解析并派发。
 *
 * 用 `queueMicrotask` 推迟一拍：EditorView 构造过程中同步 dispatch 会造成重入，
 * 推到微任务里既能保证在首帧渲染前完成，又避开了重入。
 */
function runInitialReconcile(view: EditorView): void {
  queueMicrotask(() => {
    if (view.isDestroyed) return;
    const tr = view.state.tr;
    if (!reconcileAll(tr, view.state)) return;
    tagReconcileTransaction(tr);
    view.dispatch(tr);
  });
}

function createReconcilePlugin(): Plugin {
  let view: EditorView | null = null;
  /** compositionend 之后补跑一次重解析的定时器 */
  let pendingCompositionFlush = 0;

  return new Plugin({
    key: reconcilePluginKey,

    view(editorView) {
      view = editorView;

      // 初始内容是「原始 Markdown 文本」，挂载后立刻解析一次。
      // 放在插件的 view 生命周期而不是 Extension.onCreate 里，
      // 是因为这里能拿到确定可用的 EditorView，不依赖 Tiptap 的命令链时序。
      runInitialReconcile(editorView);

      return {
        destroy() {
          view = null;
          if (pendingCompositionFlush) {
            clearTimeout(pendingCompositionFlush);
            pendingCompositionFlush = 0;
          }
        },
      };
    },

    props: {
      handleDOMEvents: {
        /**
         * 输入法组合结束后补一次重解析。
         *
         * 组合期间（`view.composing`）我们完全不碰文档，否则会打断候选词框；
         * 组合一结束，用户刚敲进去的那段文字还没被解析过，需要在这里补上。
         * 放进 setTimeout 是为了让 ProseMirror 先把 DOM 变更同步进文档。
         */
        compositionend() {
          if (pendingCompositionFlush) clearTimeout(pendingCompositionFlush);
          pendingCompositionFlush = window.setTimeout(() => {
            pendingCompositionFlush = 0;
            if (!view || view.isDestroyed) return;
            const { state } = view;
            const tr = state.tr;
            const { from, to } = state.selection;
            if (reconcileRanges(tr, state, [{ from, to }])) {
              tagReconcileTransaction(tr);
              view.dispatch(tr);
            }
          }, 0);
          return false;
        },
      },
    },

    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      // 自己产生的事务不再触发自己
      if (transactions.some((tr) => tr.getMeta(RECONCILE_META))) return null;
      // 输入法组合期间一律不动文档
      if (view?.composing) return null;

      const ranges = getChangedRanges(transactions);
      if (ranges.length === 0) return null;

      const tr = newState.tr;
      if (!reconcileRanges(tr, newState, ranges)) return null;

      tagReconcileTransaction(tr);
      return tr;
    },
  });
}

/* ────────────────────────────────────────────
 * 扩展组装
 * ──────────────────────────────────────────── */

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    livePreview: {
      /** 对整篇文档重新解析行内语法（载入内容 / 导入 Markdown 后调用） */
      reconcileDocument: () => ReturnType;
    };
  }
}

export const LivePreviewInline = Extension.create({
  name: 'livePreviewInline',

  addExtensions() {
    return [SyntaxMark, ...LIVE_PREVIEW_MARKS, ...LIVE_PREVIEW_NODES];
  },

  addProseMirrorPlugins() {
    return [createReconcilePlugin(), createRevealPlugin()];
  },

  addCommands() {
    return {
      ...livePreviewCommands,

      reconcileDocument:
        () =>
        ({ state, tr }) => {
          // 只改写传入的事务并返回 true，由 Tiptap 的命令管理器统一派发
          reconcileAll(tr, state);
          tagReconcileTransaction(tr);
          return true;
        },
    };
  },

  /**
   * 快捷键与菜单共用同一套命令。
   *
   * Mod-b 走的不是 ProseMirror 的 toggleMark，而是往文本里插 `**`——
   * 于是「快捷键加的粗」与「手打星号加的粗」在文档里是同一个东西。
   */
  addKeyboardShortcuts() {
    const map: Record<string, () => boolean> = {
      'Mod-b': () => this.editor.commands.toggleBold(),
      'Mod-i': () => this.editor.commands.toggleItalic(),
      'Mod-Shift-s': () => this.editor.commands.toggleStrike(),
      'Mod-Shift-h': () => this.editor.commands.toggleHighlight(),
      'Mod-e': () => this.editor.commands.toggleCode(),
      'Mod-Alt-0': () => this.editor.commands.setHeadingLevel(0),
    };
    // Mod-Alt-1..6 直接设置标题级别
    for (let level = 1; level <= 6; level++) {
      map[`Mod-Alt-${level}`] = () => this.editor.commands.setHeadingLevel(level);
    }
    return map;
  },
});

export { SyntaxMark, SYNTAX_MARK_NAME, OWNED_MARKS } from './syntaxMark';
export { STARTER_KIT_DISABLED } from './marks';
export { parseInline, isSyntaxRevealed } from './inlineParser';
export { parseBlock, detectBlockPrefix } from './blockSyntax';
export { MARKER_TO_MARK, MARK_TO_MARKER, livePreviewKeymap } from './commands';
export type { MarkSpan, SyntaxSpan, InlineMarkName, InlineParseResult } from './inlineParser';
