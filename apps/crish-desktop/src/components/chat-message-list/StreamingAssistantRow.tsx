/**
 * StreamingAssistantRow —— 页面壳层流式装配行（T4 A1）。
 *
 * 订阅 streamingStore 热缓冲，经 `useStreamMessageViewModel` 装配
 * 「已合并 view model」，复合行（ChatAssistantMessageRow）只收合并结果——
 * 渲染主路径不再有任何组件直连热缓冲（原 MessageContent 内联
 * selector/merge 与 ChatAssistantMessageRow 的 useStreamingStore 直连
 * 均上移至此壳层装配点）。
 *
 * - 非流式行 selector 命中稳定空切片 → 零重渲染（与旧内联订阅同构）；
 * - React.memo 以 assistantRowPropsEqual 守父级重渲染（props 未变跳过）；
 *   流式 tick 经内部订阅驱动，装配后经 msg/streamText 变化传导给行。
 */
import React from 'react';
import {
  ChatAssistantMessageRow,
  type ChatAssistantMessageRowProps,
} from '../chat-message-row/ChatAssistantMessageRow';
import { assistantRowPropsEqual } from '../chat-message-row/chatMessageRowUtils';
import { useStreamMessageViewModel } from '../chat-message/streamMessageViewModel';

export type StreamingAssistantRowProps = ChatAssistantMessageRowProps;

const StreamingAssistantRowInner: React.FC<StreamingAssistantRowProps> = (
  props
) => {
  const sessionId = props.toolStackProps.activeSessionId;
  const { msg, streamText } = useStreamMessageViewModel(props.msg, sessionId);
  return (
    <ChatAssistantMessageRow {...props} msg={msg} streamText={streamText} />
  );
};

export const StreamingAssistantRow = React.memo(
  StreamingAssistantRowInner,
  assistantRowPropsEqual
);

StreamingAssistantRow.displayName = 'StreamingAssistantRow';
