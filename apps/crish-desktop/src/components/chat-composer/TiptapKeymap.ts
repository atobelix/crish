/**
 * TiptapEditorField keymap 纯函数（F1-β 拆分）：
 * Enter 发送判定 / IME 合成门，无 React 依赖，可独立单测。
 * 发送执行（序列化 + 回调 + 清空）留在装配层（TiptapEditorExtensions），
 * 本文件只做「决策」。
 */

export type TiptapKeydownAction = 'send' | 'pass';

export interface TiptapKeydownContext {
  /** 发送快捷键偏好（与 ComposerField 同 key：crish_send_shortcut） */
  sendShortcut: 'enter' | 'ctrlEnter';
  /** 光标位于 codeBlock 内（Enter 只换行，绝不触发发送） */
  inCodeBlock: boolean;
}

/**
 * Enter 键决策：
 * - Shift+Enter → 硬换行（pass，交给 ProseMirror 默认）
 * - codeBlock 内 Enter → 换行（pass，SRS 3.7.1 代码块保护）
 * - sendShortcut=enter 且无修饰键 → send
 * - sendShortcut=ctrlEnter 且 Ctrl/Cmd 按下 → send
 * - 其余（非 Enter / 修饰键组合不匹配）→ pass
 */
export function resolveTiptapKeydown(
  event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ctx: TiptapKeydownContext
): TiptapKeydownAction {
  const isShift = event.shiftKey;
  const isCtrlOrCmd = event.ctrlKey || event.metaKey;

  // Shift+Enter inserts hard break
  if (event.key === 'Enter' && isShift) return 'pass';

  // CodeBlock Enter 保护（SRS 3.7.1）：代码块内 Enter 只换行，绝不触发发送
  if (event.key === 'Enter' && ctx.inCodeBlock) return 'pass';

  if (event.key === 'Enter') {
    if (ctx.sendShortcut === 'enter' && !isShift && !isCtrlOrCmd) {
      return 'send';
    }
    if (ctx.sendShortcut === 'ctrlEnter' && isCtrlOrCmd) {
      return 'send';
    }
  }

  return 'pass';
}

/**
 * IME Composition Protection Gate（CRM-03）：
 * view.composing + event.isComposing + DOM compositionstart 监听三条件，
 * 任一命中即视为合成态，Enter 放行给浏览器原生候选选择。
 */
export function isImeComposition(
  view: { composing?: boolean },
  event: { isComposing?: boolean },
  composingRef: { current: boolean }
): boolean {
  return Boolean(view.composing || event.isComposing || composingRef.current);
}
