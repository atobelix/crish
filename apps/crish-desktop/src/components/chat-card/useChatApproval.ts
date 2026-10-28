import {
  usePermissionField,
  selectPermissionMode,
} from '../../store/storeAccess';
import type { PermissionMode } from '../../api/permissionModes';
import { useChatApprovalHandlers } from './useChatApprovalHandlers';
import type { SessionMessage, SessionAgent } from '../../store/types';

export interface UseChatApprovalOptions {
  activeSessionId: string | null;
  messages: SessionMessage[];
  agents: SessionAgent[];
}

export interface UseChatApprovalResult {
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
  approvalState: ReturnType<typeof useChatApprovalHandlers>;
}

export function useChatApproval({
  activeSessionId,
  messages,
  agents,
}: UseChatApprovalOptions): UseChatApprovalResult {
  const permissionMode = usePermissionField(selectPermissionMode);
  const setPermissionMode = usePermissionField((s) => s.setPermissionMode);

  const approvalState = useChatApprovalHandlers({
    activeSessionId,
    messages,
    agents,
  });

  return {
    permissionMode,
    setPermissionMode,
    approvalState,
  };
}
