import type { SessionMessage, SessionAgent } from '../../store/types';
import type { } from '../../hooks/useToastQueue';
import { useChatApprovalState } from './useChatApprovalState';
import { useChatApprovalExecutor } from './useChatApprovalExecutor';

export interface UseChatApprovalHandlersOptions {
  activeSessionId: string | null;
  messages: SessionMessage[];
  agents: SessionAgent[];
}

export function useChatApprovalHandlers({
  activeSessionId,
  messages,
  agents,
  }: UseChatApprovalHandlersOptions) {
  const state = useChatApprovalState(messages, agents);
  const executor = useChatApprovalExecutor(activeSessionId, );

  return {
    ...state,
    ...executor,
  };
}
