import { usePermissionField, selectPermissionMode, selectPlanModeEnabled, selectPlanApproved } from '../../store/storeAccess';
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
  planModeEnabled: boolean;
  planApproved: boolean;
  setPlanApproved: (approved: boolean) => void;
  inPlanMode: boolean;
  approvalState: ReturnType<typeof useChatApprovalHandlers>;
}

export function useChatApproval({
  activeSessionId,
  messages,
  agents,
}: UseChatApprovalOptions): UseChatApprovalResult {
  const permissionMode = usePermissionField(selectPermissionMode);
  const setPermissionMode = usePermissionField((s) => s.setPermissionMode);
  const planModeEnabled = usePermissionField(selectPlanModeEnabled);
  const planApproved = usePermissionField(selectPlanApproved);
  const setPlanApproved = usePermissionField((s) => s.setPlanApproved);
  const inPlanMode = permissionMode === 'plan' || planModeEnabled;

  const approvalState = useChatApprovalHandlers({
    activeSessionId,
    messages,
    agents,
  });

  return {
    permissionMode,
    setPermissionMode,
    planModeEnabled,
    planApproved,
    setPlanApproved,
    inPlanMode,
    approvalState,
  };
}
