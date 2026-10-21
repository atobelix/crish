/**
 * TiptapEditorField keymap 纯函数（F1-β 拆分）：
 * Enter 发送判定 / IME 合成门，无 React 依赖，可独立单测。
 * 发送执行（序列化 + 回调 + 清空）留在装配层（TiptapEditorExtensions），
 * 本文件只做「决策」。
 */

export type TiptapKeydownAction = 'send' | 'pass' | 'insertIndent';

export interface TiptapKeydownContext {
  /** 发送快捷键偏好（与设置同一钥匙：crish_settings.sendShortcut） */
  sendShortcut: 'enter' | 'ctrlEnter';
  /** 光标位于 codeBlock 内（Enter 只换行，绝不触发发送） */
  inCodeBlock: boolean;
  /** 斜杠 / 提及 / 目录树建议打开时 Tab 交给建议层 */
  suggestionActive?: boolean;
}

/**
 * Enter / Tab 决策：
 * - Shift+Enter → 硬换行（pass，交给 ProseMirror 默认）
 * - codeBlock 内 Enter → 换行（pass，SRS 3.7.1 代码块保护）
 * - sendShortcut=enter 且无修饰键 → send
 * - sendShortcut=ctrlEnter 且 Ctrl/Cmd 按下 → send
 * - codeBlock 内 Tab（无修饰、无建议弹层）→ insertIndent
 * - 其余 → pass
 */
export function resolveTiptapKeydown(
  event: {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey?: boolean;
  },
  ctx: TiptapKeydownContext
): TiptapKeydownAction {
  const isShift = event.shiftKey;
  const isCtrlOrCmd = event.ctrlKey || event.metaKey;
  const isAlt = Boolean(event.altKey);

  // Shift+Enter inserts hard break
  if (event.key === 'Enter' && isShift) return 'pass';

  // CodeBlock Enter 保护（SRS 3.7.1）：代码块内 Enter 只换行，绝不触发发送
  if (event.key === 'Enter' && ctx.inCodeBlock) return 'pass';

  // 斜杠 / 顿号 / 提及菜单打开时，回车交给建议层选中，不发送正文
  if (event.key === 'Enter' && ctx.suggestionActive) return 'pass';

  if (event.key === 'Enter') {
    if (ctx.sendShortcut === 'enter' && !isShift && !isCtrlOrCmd) {
      return 'send';
    }
    if (ctx.sendShortcut === 'ctrlEnter' && isCtrlOrCmd) {
      return 'send';
    }
  }

  if (
    event.key === 'Tab' &&
    !isShift &&
    ctx.inCodeBlock &&
    !ctx.suggestionActive &&
    !isCtrlOrCmd &&
    !isAlt
  ) {
    return 'insertIndent';
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
