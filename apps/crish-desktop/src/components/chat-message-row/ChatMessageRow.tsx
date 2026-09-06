/**
 * 消息行：user / assistant 行级组件，React.memo 避免流式时历史行无谓 reconcile。
 * className 与 ChatMessageList 原逻辑保持一致。
 */
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';

import {
  USER_BUBBLE_LONG_CHARS,
  USER_BUBBLE_PREVIEW_CHARS,
  type MessageRole,
  messageRoleLabelZh,
  messageRowAriaLabel,
  pinToggleLabels,
  userBubbleExpandAria,
  formatMsgTime,
  isUserBubbleLong,
  userBubbleDisplayText,
  looksLikePlan,
  shouldHostToolStack,
  buildToolStackHostProps,
  copyTextBestEffort,
  toolStackSharedPropsEqual,
} from './chatMessageRowUtils';

import {
  ChatUserMessageRow,
  type ChatUserMessageRowProps,
} from './ChatUserMessageRow';

import {
  ChatAssistantMessageRow,
  type ChatAssistantMessageRowProps,
} from './ChatAssistantMessageRow';

export {
  USER_BUBBLE_LONG_CHARS,
  USER_BUBBLE_PREVIEW_CHARS,
  type MessageRole,
  messageRoleLabelZh,
  messageRowAriaLabel,
  pinToggleLabels,
  userBubbleExpandAria,
  formatMsgTime,
  isUserBubbleLong,
  userBubbleDisplayText,
  looksLikePlan,
  shouldHostToolStack,
  buildToolStackHostProps,
  copyTextBestEffort,
  toolStackSharedPropsEqual,
  ChatUserMessageRow,
  type ChatUserMessageRowProps,
  ChatAssistantMessageRow,
  type ChatAssistantMessageRowProps,
};

export type ChatToolStackProps = ChatToolStackSharedProps;
