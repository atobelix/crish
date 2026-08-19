/**
 * 官方捆绑对话流扩展：登记 chat 叶 stream 槽，不注册新 view。
 * 默认关；激活后仅线性包装 ChatMessageList，证明可卸。
 */
import {
  createElement,
  lazy,
  Suspense,
  type CSSProperties,
  type ReactElement,
} from 'react';
import type { ChatMessageListProps } from '../../components/chat-message-list/chatMessageListProps';
import '../../components/chat-message-list/workspaceChatStream.slot';
import { slotCore } from '../../services/view-registry';

const ChatMessageList = lazy(async () => {
  const m = await import('../../components/chat-message-list/ChatMessageList');
  return { default: m.ChatMessageList };
});

/** 包装根不占盒，避免插入 SlotOutlet 后撑破 .chatDocFlow 的 flex 包含块 */
const HOST_STYLE: CSSProperties = { display: 'contents' };

let currentDeactivate: (() => void) | null = null;
let officialOverride: boolean | null = null;

export function shouldActivateOfficialConversationFlow(): boolean {
  return officialOverride ?? false;
}

/** 测 / 未来设置注入；null 恢复默认关 */
export function setOfficialConversationFlowActivateForTesting(
  value: boolean | null
): void {
  officialOverride = value;
}

function LinearStreamHost(props: ChatMessageListProps): ReactElement {
  return createElement(
    'div',
    { 'data-conversation-flow': 'on', style: HOST_STYLE },
    createElement(
      Suspense,
      { fallback: null },
      createElement(ChatMessageList, props)
    )
  );
}

export function activateConversationFlow(): () => void {
  if (currentDeactivate) {
    currentDeactivate();
  }

  const unregisterSlot = slotCore.registerSingle('workspace.chat.stream', {
    id: 'conversation-flow',
    component: LinearStreamHost,
  });

  const deactivate = (): void => {
    unregisterSlot();
    if (currentDeactivate === deactivate) {
      currentDeactivate = null;
    }
  };
  currentDeactivate = deactivate;
  return deactivate;
}

export function deactivateConversationFlow(): void {
  if (!currentDeactivate) return;
  currentDeactivate();
}
