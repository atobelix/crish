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
] as const satisfies readonly (keyof MessageVirtualizerProps)[];

/** 8 大领域分组对象及核心状态极速 O(1) 浅比对 */
export function messageVirtualizerPropsEqual(
  prev: MessageVirtualizerProps,
  next: MessageVirtualizerProps
): boolean {
  if (prev.messages !== next.messages || prev.messages.length !== next.messages.length) return false;
  if (prev.activeSessionId !== next.activeSessionId) return false;
  if (prev.flowControl?.thinkingMsgId !== next.flowControl?.thinkingMsgId) {
    return false;
  }
  if (prev.searchHighlightQuery !== next.searchHighlightQuery) return false;

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

  return true;
}
