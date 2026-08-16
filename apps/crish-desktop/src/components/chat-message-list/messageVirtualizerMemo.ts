import type { FileDiff, SessionMessage } from '../../store/types';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import type { PermissionMode } from '../../api/permissionModes';

export interface PinnedItem {
  id: string;
  sender: 'user' | 'assistant';
  snippet: string;
}

export interface MessageVirtualizerProps {
  messages: SessionMessage[];
  visibleMessages: SessionMessage[];
  messageWindow: {
    startIndex: number;
    hiddenCount: number;
    visibleCount: number;
    totalCount: number;
    hasOlder: boolean;
    effectiveExpanded: number;
  };
  olderStep: number;
  offerShowAllOlder: boolean;
  expandOlderStep: () => void;
  expandOlderAll: () => void;
  pinnedItems: PinnedItem[];
  pinsOpen: boolean;
  setPinsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  jumpToPinned: (id: string) => void;
  togglePin: (id: string) => void;
  searchHighlightQuery?: string;
  expandedUserMsgs: Record<string, boolean>;
  onToggleExpandUser: (msgId: string) => void;
  onShowToast: (message: string) => void;
  hideThinkingBlock: boolean;
  inPlanMode: boolean;
  planApproved: boolean;
  lastAssistantId: string | null;
  thinkingMsgId?: string;
  toolStackProps: ChatToolStackSharedProps;
  handleRegenerateRow: (assistantMsgId: string) => void;
  onBranch: () => void;
  onOpenDiff: (diff: FileDiff) => void;
  onOpenDiffPanel?: () => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setPlanApproved: (v: boolean) => void;
  handleFillFollowUp: (prompt: string) => void;
  onSendFollowUp?: (prompt: string) => void;
  handleSendFollowUp: (prompt: string) => void;
  dismissedFollowUps: Record<string, true>;
  handleDismissFollowUp: (msgId: string) => void;
  showAllMessages: boolean;
  activeSessionId: string;
  handleMarkdownClick: (e: React.MouseEvent) => void;
  clearHeightsSignal?: number;
}

/**
 * memo 比较器字段清单（T4.3，R-06 守卫，08-detail 4.1-③）。
 *
 * 双层防护：
 * 1. 类型级穷尽检查（下方 _exhaustedCheck）：新增 prop 忘收录到本清单 →
 *    `Exclude<keyof Props, 清单成员>` 非 never → tsc 编译红；
 * 2. 源文本探针（MessageVirtualizer.memo.test.tsx）：清单成员必须出现在
 *    messageVirtualizerPropsEqual 源码中——收录但忘写比较器 → 测试红。
 */
export const MEMO_COMPARE_FIELDS = [
  'messages',
  'visibleMessages',
  'messageWindow',
  'olderStep',
  'offerShowAllOlder',
  'expandOlderStep',
  'expandOlderAll',
  'pinnedItems',
  'pinsOpen',
  'setPinsOpen',
  'jumpToPinned',
  'togglePin',
  'searchHighlightQuery',
  'expandedUserMsgs',
  'onToggleExpandUser',
  'onShowToast',
  'hideThinkingBlock',
  'inPlanMode',
  'planApproved',
  'lastAssistantId',
  'thinkingMsgId',
  'toolStackProps',
  'handleRegenerateRow',
  'onBranch',
  'onOpenDiff',
  'onOpenDiffPanel',
  'setPermissionMode',
  'setPlanApproved',
  'handleFillFollowUp',
  'onSendFollowUp',
  'handleSendFollowUp',
  'dismissedFollowUps',
  'handleDismissFollowUp',
  'showAllMessages',
  'activeSessionId',
  'handleMarkdownClick',
  'clearHeightsSignal',
] as const satisfies readonly (keyof MessageVirtualizerProps)[];

/** 新增 prop 忘收录 → 编译红（类型级穷尽检查） */
type _Exhausted =
  Exclude<
    keyof MessageVirtualizerProps,
    (typeof MEMO_COMPARE_FIELDS)[number]
  > extends never
    ? true
    : false;
const _exhaustedCheck: _Exhausted = true;

/** 仅在可见消息身份/长度、思考中消息、窗口与关键 UI 状态变化时放行重渲染 */
export function messageVirtualizerPropsEqual(
  prev: MessageVirtualizerProps,
  next: MessageVirtualizerProps
): boolean {
  if (prev.visibleMessages !== next.visibleMessages) return false;
  if (prev.visibleMessages.length !== next.visibleMessages.length) return false;
  if (prev.thinkingMsgId !== next.thinkingMsgId) return false;
  if (prev.activeSessionId !== next.activeSessionId) return false;
  if (prev.lastAssistantId !== next.lastAssistantId) return false;
  if (prev.hideThinkingBlock !== next.hideThinkingBlock) return false;
  if (prev.inPlanMode !== next.inPlanMode) return false;
  if (prev.planApproved !== next.planApproved) return false;
  if (prev.showAllMessages !== next.showAllMessages) return false;
  if (prev.pinsOpen !== next.pinsOpen) return false;
  if (prev.searchHighlightQuery !== next.searchHighlightQuery) return false;
  if (prev.olderStep !== next.olderStep) return false;
  if (prev.offerShowAllOlder !== next.offerShowAllOlder) return false;
  if (prev.clearHeightsSignal !== next.clearHeightsSignal) return false;
  if (prev.pinnedItems !== next.pinnedItems) return false;
  if (prev.expandedUserMsgs !== next.expandedUserMsgs) return false;
  if (prev.dismissedFollowUps !== next.dismissedFollowUps) return false;
  if (prev.toolStackProps !== next.toolStackProps) return false;
  if (prev.messageWindow !== next.messageWindow) {
    const a = prev.messageWindow;
    const b = next.messageWindow;
    if (
      a.startIndex !== b.startIndex ||
      a.hiddenCount !== b.hiddenCount ||
      a.visibleCount !== b.visibleCount ||
      a.totalCount !== b.totalCount ||
      a.hasOlder !== b.hasOlder ||
      a.effectiveExpanded !== b.effectiveExpanded
    ) {
      return false;
    }
  }
  // messages 全量仅用于少数路径；F7-F16：身份变化（含同长度替换——
  // 撤回/编辑）即放行重渲染，不得以长度不变为由拦截
  if (prev.messages !== next.messages) {
    return false;
  }
  return (
    prev.expandOlderStep === next.expandOlderStep &&
    prev.expandOlderAll === next.expandOlderAll &&
    prev.setPinsOpen === next.setPinsOpen &&
    prev.jumpToPinned === next.jumpToPinned &&
    prev.togglePin === next.togglePin &&
    prev.onToggleExpandUser === next.onToggleExpandUser &&
    prev.onShowToast === next.onShowToast &&
    prev.handleRegenerateRow === next.handleRegenerateRow &&
    prev.onBranch === next.onBranch &&
    prev.onOpenDiff === next.onOpenDiff &&
    prev.onOpenDiffPanel === next.onOpenDiffPanel &&
    prev.setPermissionMode === next.setPermissionMode &&
    prev.setPlanApproved === next.setPlanApproved &&
    prev.handleFillFollowUp === next.handleFillFollowUp &&
    prev.onSendFollowUp === next.onSendFollowUp &&
    prev.handleSendFollowUp === next.handleSendFollowUp &&
    prev.handleDismissFollowUp === next.handleDismissFollowUp &&
    prev.handleMarkdownClick === next.handleMarkdownClick
  );
}
