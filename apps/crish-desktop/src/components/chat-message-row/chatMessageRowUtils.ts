/**
 * ChatMessageRow 纯工具函数与类型定义
 */
import type { FileDiff, SessionMessage } from '../../store/types';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import type { ToolRenderItem } from '../../api/toolPresentation';
import type { PermissionMode } from '../../api/permissionModes';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';

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

/**
 * ChatAssistantMessageRow props 契约（T4 A1 后由壳层 StreamingAssistantRow
 * 装配 view model 传入；消息行本身不再直读 streamingStore）。
 *
 * 定义放本工具模块而非组件文件：react-refresh/only-export-components 要求
 * 组件文件只导出组件；memo 契约（类型/字段清单/比较器）为跨文件共享符号，
 * 与 messageVirtualizerMemo.ts 同法。
 */
export type ChatAssistantMessageRowProps = {
  /**
   * 已合并的流式渲染 view model（T4 A1：壳层 StreamingAssistantRow 装配后传入；
   * 本行不再直读 streamingStore）。
   */
  msg: SessionMessage;
  /**
   * 流式累积正文（undefined = 热缓冲无条目；壳层透传，MessageContent 流式增量区数据面）。
   */
  streamText?: string;
  isFollowUp: boolean;
  isPinned: boolean;
  isSearchHit: boolean;
  isThinkingMsg: boolean;
  hideThinkingBlock: boolean;
  inPlanMode: boolean;
  planApproved: boolean;
  isLastAssistant: boolean;
  toolStackProps: ChatToolStackSharedProps;
  onTogglePin: (msgId: string) => void;
  onRegenerate: (assistantMsgId: string) => void;
  onBranch: () => void;
  onOpenDiff: (diff: FileDiff) => void;
  onOpenDiffPanel?: (() => void) | undefined;
  setPermissionMode: (mode: PermissionMode) => void;
  setPlanApproved: (v: boolean) => void;
  onFillFollowUp?: ((prompt: string) => void) | undefined;
  onSendFollowUp?: ((prompt: string) => void) | undefined;
  followUpDismissed?: boolean | undefined;
  onDismissFollowUp?: ((msgId: string) => void) | undefined;
  /** 最后一条助手 / 生成中：消息流撤回（不在 composer 页脚） */
  onRetract?: (() => void) | undefined;
  messageIndex: number;
  virtualScrollManager: VirtualScrollManager | null;
};

/**
 * 比较器字段清单（T4.3，R-06 守卫，与 MessageVirtualizer 同法）。
 *
 * messageIndex / virtualScrollManager 为组件内 void 化的非渲染字段
 *（改动不影响输出），豁免比较器覆盖（_NON_COMPARED_FIELDS 白名单）；
 * 其余字段必须出现在 assistantRowPropsEqual 源码中（memo 测试源文本
 * 探针锁定），新增 prop 忘收录 → 类型级穷尽检查编译红。
 */
export const MEMO_COMPARE_FIELDS = [
  'msg',
  'streamText',
  'isFollowUp',
  'isPinned',
  'isSearchHit',
  'isThinkingMsg',
  'hideThinkingBlock',
  'inPlanMode',
  'planApproved',
  'isLastAssistant',
  'toolStackProps',
  'onTogglePin',
  'onRegenerate',
  'onBranch',
  'onOpenDiff',
  'onOpenDiffPanel',
  'setPermissionMode',
  'setPlanApproved',
  'onFillFollowUp',
  'onSendFollowUp',
  'followUpDismissed',
  'onDismissFollowUp',
  'onRetract',
] as const satisfies readonly (keyof ChatAssistantMessageRowProps)[];

/** 组件内 void 化的非渲染字段（豁免比较器覆盖） */
type _NonComparedFields = 'messageIndex' | 'virtualScrollManager';

/** 新增 prop 忘收录 → 编译红（类型级穷尽检查） */
type _Exhausted =
  Exclude<
    keyof ChatAssistantMessageRowProps,
    (typeof MEMO_COMPARE_FIELDS)[number] | _NonComparedFields
  > extends never
    ? true
    : false;
const _exhaustedCheck: _Exhausted = true;

export function assistantRowPropsEqual(
  prev: ChatAssistantMessageRowProps,
  next: ChatAssistantMessageRowProps
): boolean {
  return (
    prev.msg.id === next.msg.id &&
    prev.msg.status === next.msg.status &&
    prev.msg.text === next.msg.text &&
    prev.msg.thinking === next.msg.thinking &&
    prev.msg.toolCalls === next.msg.toolCalls &&
    prev.msg.blocks === next.msg.blocks &&
    prev.msg.injections === next.msg.injections &&
    prev.msg.thinkingTime === next.msg.thinkingTime &&
    prev.msg.timestamp === next.msg.timestamp &&
    prev.msg.cacheMetrics === next.msg.cacheMetrics &&
    prev.streamText === next.streamText &&
    prev.isPinned === next.isPinned &&
    prev.isSearchHit === next.isSearchHit &&
    prev.isFollowUp === next.isFollowUp &&
    prev.isThinkingMsg === next.isThinkingMsg &&
    prev.hideThinkingBlock === next.hideThinkingBlock &&
    prev.inPlanMode === next.inPlanMode &&
    prev.planApproved === next.planApproved &&
    prev.isLastAssistant === next.isLastAssistant &&
    prev.followUpDismissed === next.followUpDismissed &&
    toolStackSharedPropsEqual(prev.toolStackProps, next.toolStackProps) &&
    prev.onTogglePin === next.onTogglePin &&
    prev.onRegenerate === next.onRegenerate &&
    prev.onBranch === next.onBranch &&
    prev.onOpenDiff === next.onOpenDiff &&
    prev.onOpenDiffPanel === next.onOpenDiffPanel &&
    prev.setPermissionMode === next.setPermissionMode &&
    prev.setPlanApproved === next.setPlanApproved &&
    prev.onFillFollowUp === next.onFillFollowUp &&
    prev.onSendFollowUp === next.onSendFollowUp &&
    prev.onDismissFollowUp === next.onDismissFollowUp &&
    prev.onRetract === next.onRetract
  );
}
