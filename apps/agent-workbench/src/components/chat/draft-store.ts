/**
 * draft-store - 输入草稿持久化
 *
 * 将 ChatInput 的输入内容按 sessionId 持久化到 localStorage，
 * 页面刷新后可恢复未发送的草稿。
 */

const INPUT_DRAFT_PREFIX = 'conex:input-draft:';

export function inputDraftKey(sessionId?: string): string {
  return INPUT_DRAFT_PREFIX + (sessionId ?? 'global');
}

export function loadInputDraft(sessionId?: string): string {
  try {
    return localStorage.getItem(inputDraftKey(sessionId)) ?? '';
  } catch {
    return '';
  }
}

export function saveInputDraft(sessionId: string | undefined, value: string): void {
  try {
    const key = inputDraftKey(sessionId);
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}
