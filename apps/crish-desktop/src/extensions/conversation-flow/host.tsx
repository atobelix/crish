/**
 * 叙事流 stream 宿主：喂 projectMessage，经可选 renderTools / renderThought 注入块。
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
import { createNarrativeRenderers } from './narrativeRenderers';

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
  const list = props.messages.messages;
  const nodeCount = useMemo(() => countAssistantFlowNodes(list), [list]);
  // 思考块内路径链接与正文同轨：宿主 navigation.onOpenPath 透传给
  // ThinkingBlock（此前思考内链接无 onOpenPath 注入、点击无反应）
  const onOpenPath = props.navigation?.onOpenPath;
  const { renderTools, renderThought } = useMemo(
    () => createNarrativeRenderers(list, { onOpenPath }),
    [list, onOpenPath]
  );

  return (
    <div
      data-conversation-flow="on"
      data-flow-node-count={nodeCount}
      style={HOST_STYLE}
    >
      <Suspense fallback={null}>
        <ChatMessageList
          {...props}
          renderTools={renderTools}
          renderThought={renderThought}
        />
      </Suspense>
    </div>
  );
}
