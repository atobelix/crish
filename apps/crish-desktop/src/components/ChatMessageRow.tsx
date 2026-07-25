/**
 * 消息行：user / assistant 行级组件，React.memo 避免流式时历史行无谓 reconcile。
 * className 与 ChatMessageList 原逻辑保持一致。
 */
import type { ChatToolStackSharedProps } from './ChatToolCallBlock';

import {
  USER_BUBBLE_LONG_CHARS,
  USER_BUBBLE_PREVIEW_CHARS,
  type MessageRole,
  messageRoleLabelZh,
  messageRowAriaLabel,
  pinToggleLabels,
  userBubbleExpandAria,
  thinkingFoldAria,
  formatMsgTime,
  isUserBubbleLong,
  userBubbleDisplayText,
  looksLikePlan,
  shouldHostToolStack,
  buildToolStackHostProps,
  copyTextBestEffort,
  toolStackSharedPropsEqual,
} from './chat-message-row/chatMessageRowUtils';

import {
  ChatUserMessageRow,
  type ChatUserMessageRowProps,
} from './chat-message-row/ChatUserMessageRow';

import {
  ChatAssistantMessageRow,
  type ChatAssistantMessageRowProps,
} from './chat-message-row/ChatAssistantMessageRow';

import {
  MessageAvatar,
  type MessageAvatarProps,
} from './chat-message/MessageAvatar';

import {
  MessageContent,
  type MessageContentProps,
} from './chat-message/MessageContent';

import {
  MessageActions,
  type MessageActionsProps,
} from './chat-message/MessageActions';

import {
  MessageThinkingBlock,
  type MessageThinkingBlockProps,
} from './chat-message/MessageThinkingBlock';

export {
  USER_BUBBLE_LONG_CHARS,
  USER_BUBBLE_PREVIEW_CHARS,
  type MessageRole,
  messageRoleLabelZh,
  messageRowAriaLabel,
  pinToggleLabels,
  userBubbleExpandAria,
  thinkingFoldAria,
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
  MessageAvatar,
  type MessageAvatarProps,
  MessageContent,
  type MessageContentProps,
  MessageActions,
  type MessageActionsProps,
  MessageThinkingBlock,
  type MessageThinkingBlockProps,
};

export type ChatToolStackProps = ChatToolStackSharedProps;
