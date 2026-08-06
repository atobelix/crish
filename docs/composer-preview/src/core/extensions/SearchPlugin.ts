/**
 * SearchPlugin — ProseMirror 搜索装饰插件
 *
 * 在文档中高亮所有匹配文本，支持：
 *   - 纯文本搜索 / 正则搜索
 *   - 大小写敏感切换
 *   - 当前命中高亮（区别于其他匹配）
 *   - 替换 / 全部替换
 *
 * 设计：
 *   用 DecorationSet 做高亮，不修改文档结构；
 *   搜索状态存在 pluginState 里，UI 层通过 getMeta/setMeta 通信。
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import { Extension } from '@tiptap/core';

/* ── 类型 ── */

export interface SearchState {
  /** 当前搜索词 */
  query: string;
  /** 是否区分大小写 */
  caseSensitive: boolean;
  /** 是否正则模式 */
  regex: boolean;
  /** 所有匹配的位置 [from, to] */
  matches: Array<{ from: number; to: number }>;
  /** 当前聚焦的匹配索引 */
  currentIndex: number;
  /** 装饰集 */
  decorations: DecorationSet;
}

/** 外部发给插件的指令 */
export type SearchAction =
  | { type: 'setQuery'; query: string; caseSensitive: boolean; regex: boolean }
  | { type: 'nextMatch' }
  | { type: 'prevMatch' }
  | { type: 'replaceCurrent'; replacement: string }
  | { type: 'replaceAll'; replacement: string }
  | { type: 'close' };

export const searchPluginKey = new PluginKey<SearchState>('searchPlugin');

/* ── 匹配计算 ── */

function findMatches(
  doc: EditorState['doc'],
  query: string,
  caseSensitive: boolean,
  useRegex: boolean,
): Array<{ from: number; to: number }> {
  if (!query) return [];

  const matches: Array<{ from: number; to: number }> = [];

  // 从文档中提取纯文本，保留位置映射
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;

    const text = node.text;
    let searchText = text;
    let searchQuery = query;

    if (!caseSensitive && !useRegex) {
      searchText = text.toLowerCase();
      searchQuery = query.toLowerCase();
    }

    if (useRegex) {
      try {
        const flags = caseSensitive ? 'g' : 'gi';
        const re = new RegExp(query, flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          if (m[0].length === 0) break; // 防死循环
          matches.push({ from: pos + m.index, to: pos + m.index + m[0].length });
        }
      } catch {
        // 正则无效时静默忽略
      }
    } else {
      let idx = 0;
      while ((idx = searchText.indexOf(searchQuery, idx)) !== -1) {
        matches.push({ from: pos + idx, to: pos + idx + query.length });
        idx += query.length;
      }
    }
  });

  // 按位置排序
  matches.sort((a, b) => a.from - b.from);
  return matches;
}

function buildDecorations(
  matches: Array<{ from: number; to: number }>,
  currentIndex: number,
  doc: EditorState['doc'],
): DecorationSet {
  const decorations: Decoration[] = matches.map((m, i) =>
    Decoration.inline(m.from, m.to, {
      class: i === currentIndex ? 'search-match search-match--current' : 'search-match',
    }),
  );
  return DecorationSet.create(doc, decorations);
}

/* ── 空状态 ── */

function emptyState(doc: EditorState['doc']): SearchState {
  return {
    query: '',
    caseSensitive: false,
    regex: false,
    matches: [],
    currentIndex: -1,
    decorations: DecorationSet.empty,
  };
}

/* ── 插件 ── */

function createSearchPlugin(): Plugin<SearchState> {
  return new Plugin<SearchState>({
    key: searchPluginKey,

    state: {
      init(_, state) {
        return emptyState(state.doc);
      },

      apply(tr, prev, _oldState, newState) {
        const action = tr.getMeta(searchPluginKey) as SearchAction | undefined;

        if (action) {
          switch (action.type) {
            case 'setQuery': {
              const matches = findMatches(newState.doc, action.query, action.caseSensitive, action.regex);
              const currentIndex = matches.length > 0 ? 0 : -1;
              return {
                query: action.query,
                caseSensitive: action.caseSensitive,
                regex: action.regex,
                matches,
                currentIndex,
                decorations: buildDecorations(matches, currentIndex, newState.doc),
              };
            }
            case 'nextMatch': {
              if (prev.matches.length === 0) return prev;
              const nextIdx = (prev.currentIndex + 1) % prev.matches.length;
              return {
                ...prev,
                currentIndex: nextIdx,
                decorations: buildDecorations(prev.matches, nextIdx, newState.doc),
              };
            }
            case 'prevMatch': {
              if (prev.matches.length === 0) return prev;
              const prevIdx = (prev.currentIndex - 1 + prev.matches.length) % prev.matches.length;
              return {
                ...prev,
                currentIndex: prevIdx,
                decorations: buildDecorations(prev.matches, prevIdx, newState.doc),
              };
            }
            case 'close': {
              return emptyState(newState.doc);
            }
            default:
              break;
          }
        }

        // 文档变更时重新计算匹配
        if (tr.docChanged && prev.query) {
          const matches = findMatches(newState.doc, prev.query, prev.caseSensitive, prev.regex);
          const currentIndex = matches.length > 0
            ? Math.min(prev.currentIndex, matches.length - 1)
            : -1;
          return {
            ...prev,
            matches,
            currentIndex,
            decorations: buildDecorations(matches, currentIndex, newState.doc),
          };
        }

        return prev;
      },
    },

    props: {
      decorations(state) {
        return this.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },
  });
}

/* ── 辅助函数：派发搜索指令 ── */

export function dispatchSearch(view: EditorView, action: SearchAction): void {
  const tr = view.state.tr.setMeta(searchPluginKey, action);
  view.dispatch(tr);
}

/** 替换当前匹配 */
export function replaceCurrent(view: EditorView, replacement: string): void {
  const state = searchPluginKey.getState(view.state);
  if (!state || state.currentIndex < 0) return;
  const match = state.matches[state.currentIndex];
  if (!match) return;

  const tr = view.state.tr.replaceWith(
    match.from,
    match.to,
    view.state.schema.text(replacement),
  );
  view.dispatch(tr);
}

/** 替换所有匹配（从后往前替换避免位移） */
export function replaceAll(view: EditorView, replacement: string): void {
  const state = searchPluginKey.getState(view.state);
  if (!state || state.matches.length === 0) return;

  let tr = view.state.tr;
  // 从后往前替换，这样前面的位置不会被影响
  for (let i = state.matches.length - 1; i >= 0; i--) {
    const m = state.matches[i];
    tr = tr.replaceWith(m.from, m.to, view.state.schema.text(replacement));
  }
  view.dispatch(tr);
}

/** 滚动到当前匹配位置 */
export function scrollToCurrentMatch(view: EditorView): void {
  const state = searchPluginKey.getState(view.state);
  if (!state || state.currentIndex < 0) return;
  const match = state.matches[state.currentIndex];
  if (!match) return;

  // 设置选区到当前匹配
  // @ts-ignore
  const { Selection } = require('@tiptap/pm/state');
  const tr = view.state.tr.setSelection(Selection.near(view.state.doc.resolve(match.from)));
  tr.scrollIntoView();
  view.dispatch(tr);
}

/* ── Tiptap Extension 包装 ── */

export const SearchExtension = Extension.create({
  name: 'search',

  addProseMirrorPlugins() {
    return [createSearchPlugin()];
  },

  addKeyboardShortcuts() {
    return {
      'Mod-f': () => {
        // 由 React 组件处理 UI 显示
        // 这里仅用于标记快捷键被触发
        this.editor.commands.setMeta('openSearch', { mode: 'find' });
        return true;
      },
      'Mod-h': () => {
        this.editor.commands.setMeta('openSearch', { mode: 'replace' });
        return true;
      },
    };
  },
});
