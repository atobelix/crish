/**
 * ChatMessageRow 纯工具函数与类型定义
 */
import type { SessionMessage } from '../../store/types';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import type { ToolRenderItem } from '../../api/toolPresentation';

export const USER_BUBBLE_LONG_CHARS = 260;
export const USER_BUBBLE_PREVIEW_CHARS = 240;

export type MessageRole = SessionMessage['sender'];

export function messageRoleLabelZh(role: MessageRole): string {
  return role === 'user' ? '你' : '助手';
}

export function messageRowAriaLabel(opts: {
  role: MessageRole;
  isPinned?: boolean;
  isThinking?: boolean;
  status?: SessionMessage['status'];
}): string {
  const parts: string[] = [messageRoleLabelZh(opts.role)];
  if (opts.isPinned) parts.push('已固定');
  if (opts.status === 'queued') parts.push('排队中');
  else if (opts.isThinking || opts.status === 'processing')
    parts.push('生成中');
  return parts.join(' · ');
}

export function pinToggleLabels(isPinned: boolean): {
  title: string;
  ariaLabel: string;
} {
  return isPinned
    ? { title: '取消固定', ariaLabel: '取消固定' }
    : { title: '固定', ariaLabel: '固定消息' };
}

export function userBubbleExpandAria(isExpanded: boolean): string {
  return isExpanded ? '收起全文' : '展开全文';
}

export function thinkingFoldAria(opts: {
  isLive: boolean;
  isOpen: boolean;
}): string {
  if (opts.isLive) return '思考中';
  return opts.isOpen ? '收起思考' : '展开思考';
}

export function formatMsgTime(ts?: number): string {
  if (!ts) return '';
  const date = new Date(ts);
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function isUserBubbleLong(text: string | undefined | null): boolean {
  return (text || '').length > USER_BUBBLE_LONG_CHARS;
}

export function userBubbleDisplayText(
  text: string | undefined | null,
  isExpanded: boolean
): string {
  const t = text || '';
  if (isUserBubbleLong(t) && !isExpanded) {
    return t.slice(0, USER_BUBBLE_PREVIEW_CHARS) + '…';
  }
  return t;
}

export function looksLikePlan(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  if (/步骤|计划/.test(t)) return true;
  if (/^#{1,3}\s/m.test(t)) return true;
  if (/(?:^|\n)\s*\d+[.、]\s*\S/.test(t)) return true;
  return false;
}

export function shouldHostToolStack(
  items: readonly ToolRenderItem[] | undefined | null
): boolean {
  return Array.isArray(items) && items.length > 0;
}

export function buildToolStackHostProps(
  items: ToolRenderItem[],
  msgId: string,
  shared: ChatToolStackSharedProps
): ChatToolStackSharedProps & { items: ToolRenderItem[]; msgId: string } {
  return { items, msgId, ...shared };
}

export async function copyTextBestEffort(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function toolStackSharedPropsEqual(
  a: ChatToolStackSharedProps,
  b: ChatToolStackSharedProps
): boolean {
  return (
    a.expandedTools === b.expandedTools &&
    a.approvalBusy === b.approvalBusy &&
    a.pendingApprovalMsgId === b.pendingApprovalMsgId &&
    a.agents === b.agents &&
    a.activeSessionId === b.activeSessionId
  );
}

export function focusChatComposer(): void {
  const scope =
    document.querySelector<HTMLElement>('.chat-body') ??
    document.querySelector<HTMLElement>('.chat-doc-flow') ??
    document.body;
  const ta =
    scope.querySelector<HTMLTextAreaElement>(
      '.input-container textarea:not([disabled])'
    ) ?? scope.querySelector<HTMLTextAreaElement>('textarea:not([disabled])');
  ta?.focus();
}
