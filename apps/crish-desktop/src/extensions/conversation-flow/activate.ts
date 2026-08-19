/**
 * 官方捆绑对话流扩展：登记 chat 叶 stream 槽，不注册新 view。
 * 默认关；激活后挂 host（投影 + 线性 ChatMessageList）。
 */
import { createElement, lazy, Suspense, type ReactElement } from 'react';
import type { ChatMessageListProps } from '../../components/chat-message-list/chatMessageListProps';
import '../../components/chat-message-list/workspaceChatStream.slot';
import { slotCore } from '../../services/view-registry';

/** 关插件时不拉 host，避免默认路径引用投影包 */
const ConversationFlowHost = lazy(async () => {
  const m = await import('./host');
  return { default: m.ConversationFlowHost };
});

function StreamSlotHost(props: ChatMessageListProps): ReactElement {
  return createElement(
    Suspense,
    { fallback: null },
    createElement(ConversationFlowHost, props)
  );
}

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

export function activateConversationFlow(): () => void {
  if (currentDeactivate) {
    currentDeactivate();
  }

  const unregisterSlot = slotCore.registerSingle('workspace.chat.stream', {
    id: 'conversation-flow',
    component: StreamSlotHost,
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
