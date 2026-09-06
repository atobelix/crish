import type {
  MessageVirtualizerProps,
  PinnedItem,
} from './chatMessageListProps';

export type { MessageVirtualizerProps, PinnedItem };

/** 8 大领域分组对象及核心字段清单（收敛后契约） */
export const MEMO_COMPARE_FIELDS = [
  'messages',
  'activeSessionId',
  'navigation',
  'approval',
  'composer',
  'generation',
  'pins',
  'flowControl',
  'interaction',
  'searchHighlightQuery',
  'renderSnapshot',
] as const satisfies readonly (keyof MessageVirtualizerProps)[];

/** 8 大领域分组对象及核心状态极速 O(1) 浅比对 */
export function messageVirtualizerPropsEqual(
  prev: MessageVirtualizerProps,
  next: MessageVirtualizerProps
): boolean {
  if (prev.messages !== next.messages || prev.messages.length !== next.messages.length) return false;
  if (prev.activeSessionId !== next.activeSessionId) return false;
  if (
    (prev.flowControl?.thinkingMsgId ?? prev.thinkingMsgId) !==
    (next.flowControl?.thinkingMsgId ?? next.thinkingMsgId)
  ) {
    return false;
  }
  if (prev.searchHighlightQuery !== next.searchHighlightQuery || prev.renderSnapshot !== next.renderSnapshot) return false;

  // 8 大领域分组对象引用浅比对
  if (
    prev.navigation !== next.navigation ||
    prev.approval !== next.approval ||
    prev.composer !== next.composer ||
    prev.generation !== next.generation ||
    prev.pins !== next.pins ||
    prev.flowControl !== next.flowControl ||
    prev.interaction !== next.interaction
  ) {
    return false;
  }

  // 兼容扁平传参浅比对
  if (prev.pinnedItems !== next.pinnedItems || prev.pinsOpen !== next.pinsOpen) return false;
  if (prev.expandedUserMsgs !== next.expandedUserMsgs || prev.dismissedFollowUps !== next.dismissedFollowUps) return false;
  if (prev.toolStackProps !== next.toolStackProps || prev.lastAssistantId !== next.lastAssistantId) return false;
  if (prev.lastUserId !== next.lastUserId || prev.hideThinkingBlock !== next.hideThinkingBlock) return false;
  if (prev.inPlanMode !== next.inPlanMode || prev.planApproved !== next.planApproved) return false;
  if (prev.showAllMessages !== next.showAllMessages || prev.clearHeightsSignal !== next.clearHeightsSignal) return false;

  return true;
}
