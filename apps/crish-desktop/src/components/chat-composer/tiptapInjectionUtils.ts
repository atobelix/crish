/**
 * apps/crish-desktop/src/components/chat-composer/tiptapInjectionUtils.ts
 * ProseMirror 事务 Meta 抑制与占位符选区扫描算法（详案 03 §2.4）。
 * - INJECTION_TRANSACTION_META：注入事务标记，Slash / Mention 建议扩展识别后
 *   跳过本次事务的字符扫描（不弹窗）；
 * - locateFirstPlaceholder：遍历 PM AST 扫描首个占位符区间 {{...}} / <...> / [...];
 * - focusAndSelectFirstPlaceholder：将编辑器聚焦并全选首个占位符（用户直接键入即覆盖）。
 *
 * CI Guardrail: Max 400 lines of effective code, UTF-8 无 BOM.
 */

import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { exitSuggestion } from '@tiptap/suggestion';
import { slashSuggestionKey, mentionSuggestionKey } from './SlashExtension';
import { findSlashOrEnumerationMatch } from './slashTriggerAlias';

/** 注入事务 Meta 标记：SlashExtension 与 MentionSuggestionExtension 识别后跳过本次弹窗 */
export const INJECTION_TRANSACTION_META = 'CRISH_PROMPT_INJECTION_META';

/**
 * 组字上屏后让斜杠建议再判一次。
 * 不改文档，顿号和半角斜杠都留在正文里。
 */
export function resyncSlashTriggerAfterComposition(editor: Editor): void {
  try {
    if (!editor || editor.isDestroyed) return;
    const view = editor.view;
    if (!view || view.composing || !view.state.selection.empty) return;
    if (slashSuggestionKey.getState(view.state)?.active) return;
    const match = findSlashOrEnumerationMatch({
      char: '/',
      allowSpaces: false,
      allowToIncludeChar: false,
      allowedPrefixes: [' '],
      startOfLine: false,
      $position: view.state.selection.$from,
    });
    if (!match) return;
    view.dispatch(view.state.tr.setMeta('addToHistory', false));
  } catch {
    /* 视图未挂载时忽略 */
  }
}

/** 占位符匹配正则：匹配 {{...}}、<...> 或形如 [描述...] 的中文占位（2~30 字） */
const PLACEHOLDER_REGEX = /\{\{([^}]+)\}\}|<([^>]+)>|\[([^[\]]{2,30})\]/;

export interface PlaceholderRange {
  from: number;
  to: number;
  text: string;
}

/**
 * 遍历 ProseMirror AST 扫描首个占位符区间；无占位符返回 null。
 * 命中文本节点即终止（result 哨兵 + 返回 false 剪枝）。
 */
export function locateFirstPlaceholder(
  doc: ProseMirrorNode
): PlaceholderRange | null {
  let result: PlaceholderRange | null = null;

  doc.descendants((node, pos) => {
    if (result) return false;
    if (!node.isText || !node.text) return true;
    const match = PLACEHOLDER_REGEX.exec(node.text);
    if (match) {
      result = {
        from: pos + match.index,
        to: pos + match.index + match[0].length,
        text: match[0],
      };
      return false;
    }
    return true;
  });

  return result;
}

/**
 * 将编辑器聚焦并全选首个占位符（用户直接键入即可覆盖占位文本）。
 * 选区事务附带 INJECTION_TRANSACTION_META，抑制 Slash/Mention 弹窗误触发；
 * 无占位符时定位至文末（return false 供调用方区分）。
 */
export function focusAndSelectFirstPlaceholder(editor: Editor): boolean {
  if (!editor || editor.isDestroyed) return false;

  const { doc, tr } = editor.state;
  const match = locateFirstPlaceholder(doc);

  if (match) {
    const selection = TextSelection.create(doc, match.from, match.to);
    tr.setSelection(selection);
    tr.setMeta(INJECTION_TRANSACTION_META, true);
    editor.view.dispatch(tr);
    editor.view.focus();
    // 程序性注入后确定性关闭建议弹层：模板文本含 "/schedule " 等触发前缀，
    // suggestion 插件会在本次事务后进入活跃态——复用本仓 exitSuggestion 原语
    // 将 slash / mention 两个 keyed plugin 置回非活跃（对齐 SlashExtension 既有用法）
    try {
      exitSuggestion(editor.view, slashSuggestionKey);
      exitSuggestion(editor.view, mentionSuggestionKey);
    } catch {
      /* 建议插件未挂载（极端裁剪环境）时忽略 */
    }
    return true;
  }

  editor.commands.focus('end');
  return false;
}
