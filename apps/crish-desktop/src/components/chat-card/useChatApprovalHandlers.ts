import type { SessionMessage, SessionAgent } from '../../store/types';
import type { ShowToastFn } from '../../hooks/useToastQueue';
import { useChatApprovalState } from './useChatApprovalState';
import { useChatApprovalExecutor } from './useChatApprovalExecutor';

export interface UseChatApprovalHandlersOptions {
  activeSessionId: string | null;
  messages: SessionMessage[];
  agents: SessionAgent[];
  onShowToast: ShowToastFn;
}

export function useChatApprovalHandlers({
  activeSessionId,
  messages,
  agents,
  onShowToast,
}: UseChatApprovalHandlersOptions) {
  const state = useChatApprovalState(messages, agents);
  const executor = useChatApprovalExecutor(activeSessionId, onShowToast);

  return {
    ...state,
    ...executor,
  };
}
