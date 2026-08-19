/**
 * 官方捆绑对话流扩展：登记 chat 叶 stream + composerAbove 槽，不注册新 view。
 * 默认关；激活后挂 host（投影 + 线性 ChatMessageList）与冷静审批条。
 */
import { createElement, lazy, Suspense, type ReactElement } from 'react';
import type { ChatComposerAboveProps } from '../../components/chat-card/chatComposerAboveProps';
import '../../components/chat-card/workspaceChatComposerAbove.slot';
import type { ChatMessageListProps } from '../../components/chat-message-list/chatMessageListProps';
import '../../components/chat-message-list/workspaceChatStream.slot';
import { slotCore } from '../../services/view-registry';

/** 关插件时不拉 host，避免默认路径引用投影包 */
const ConversationFlowHost = lazy(async () => {
  const m = await import('./host');
  return { default: m.ConversationFlowHost };
});

const ConversationFlowPermissionBar = lazy(async () => {
  const m = await import('./PermissionBar');
  return { default: m.PermissionBar };
});

function StreamSlotHost(props: ChatMessageListProps): ReactElement {
  return createElement(
    Suspense,
    { fallback: null },
    createElement(ConversationFlowHost, props)
  );
}

function ComposerAboveSlotHost(props: ChatComposerAboveProps): ReactElement {
  return createElement(
    Suspense,
    { fallback: null },
    createElement(ConversationFlowPermissionBar, props)
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

  const unregisterStream = slotCore.registerSingle('workspace.chat.stream', {
    id: 'conversation-flow',
    component: StreamSlotHost,
  });
  const unregisterComposerAbove = slotCore.registerSingle(
    'workspace.chat.composerAbove',
    {
      id: 'conversation-flow',
      component: ComposerAboveSlotHost,
    }
  );

  const deactivate = (): void => {
    unregisterStream();
    unregisterComposerAbove();
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
