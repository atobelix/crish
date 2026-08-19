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
import { projectMessage, projectPlanRoot } from '@crish/conversation-flow';
import type { ChatMessageListProps } from '../../components/chat-message-list/chatMessageListProps';
import {
  selectPermissionMode,
  selectPlanApproved,
  selectPlanModeEnabled,
} from '../../store/settingsUiStore';
import { usePermissionStore } from '../../store/permissionStore';
import type { SessionMessage } from '../../store/types';
import { PlanRoot } from './PlanRoot';
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
  const { renderTools, renderThought } = useMemo(
    () => createNarrativeRenderers(list),
    [list]
  );
  const permissionMode = usePermissionStore(selectPermissionMode);
  const planModeEnabled = usePermissionStore(selectPlanModeEnabled);
  const planApproved = usePermissionStore(selectPlanApproved);
  const planNode = useMemo(
    () => projectPlanRoot({ permissionMode, planModeEnabled, planApproved }),
    [permissionMode, planModeEnabled, planApproved]
  );

  return (
    <div
      data-conversation-flow="on"
      data-flow-node-count={nodeCount}
      data-flow-plan-mounted={planNode ? 'true' : 'false'}
      style={HOST_STYLE}
    >
      {planNode ? <PlanRoot plan={planNode} /> : null}
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
