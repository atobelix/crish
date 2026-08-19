/**
 * 叙事流 stream 宿主：喂 projectMessage，S3 前仍画线性 ChatMessageList。
 * 崩溃不在此吞掉，交给 SlotOutlet abdicate → ChatCard fallback。
 */
import {
  lazy,
  Suspense,
  useMemo,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { projectMessage } from '@crish/conversation-flow';
import type { ChatMessageListProps } from '../../components/chat-message-list/chatMessageListProps';
import type { SessionMessage } from '../../store/types';

const ChatMessageList = lazy(async () => {
  const m = await import('../../components/chat-message-list/ChatMessageList');
  return { default: m.ChatMessageList };
});

/** 包装根不占盒，避免插入 SlotOutlet 后撑破 .chatDocFlow 的 flex 包含块 */
const HOST_STYLE: CSSProperties = { display: 'contents' };

function countAssistantFlowNodes(messages: SessionMessage[]): number {
  let n = 0;
  for (const msg of messages) {
    if (msg.sender !== 'assistant') continue;
    const projected = projectMessage(msg);
    n += projected.nodes.length;
  }
  return n;
}

export function ConversationFlowHost(
  props: ChatMessageListProps
): ReactElement {
  const nodeCount = useMemo(
    () => countAssistantFlowNodes(props.messages.messages),
    [props.messages.messages]
  );

  return (
    <div
      data-conversation-flow="on"
      data-flow-node-count={nodeCount}
      style={HOST_STYLE}
    >
      <Suspense fallback={null}>
        <ChatMessageList {...props} />
      </Suspense>
    </div>
  );
}
