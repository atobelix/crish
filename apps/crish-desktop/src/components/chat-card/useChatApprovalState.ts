import { useMemo } from 'react';
import type { SessionMessage, SessionAgent } from '../../store/types';
import { toolHumanLabel } from '../../api/toolPresentation';
import {
  approvalDockLabel,
  collectPendingApprovals,
  planApprovalUi,
} from '../../api/chatApprovalUi';

export function useChatApprovalState(
  messages: SessionMessage[],
  agents: SessionAgent[]
) {
  const pendingApprovalScan = useMemo(() => {
    const agentLists = (agents || []).map((ag) => ag.messages || []);
    return collectPendingApprovals(messages, agentLists);
  }, [messages, agents]);

  const pendingApprovalMsgId = pendingApprovalScan.first?.msgId || '';
  const pendingApprovalToolId = pendingApprovalScan.first?.toolId || '';

  const approvalUiPlan = useMemo(
    () => planApprovalUi(pendingApprovalScan.counts),
    [pendingApprovalScan.counts]
  );
  const pendingApprovalCount = approvalUiPlan.total;

  const pendingApprovalSummary = useMemo(() => {
    const first = pendingApprovalScan.first;
    if (!first) return '';
    if (first.summary) {
      const fromMsg =
        messages
          .flatMap((m) => m.toolCalls || [])
          .find((tc) => tc.id === first.toolId) ||
        (agents || [])
          .flatMap((ag) => ag.messages || [])
          .flatMap((m) => m.toolCalls || [])
          .find((tc) => tc.id === first.toolId);
      if (fromMsg) return toolHumanLabel(fromMsg);
      return first.summary;
    }
    return '';
  }, [pendingApprovalScan.first, messages, agents]);

  const approvalDockVisible = approvalUiPlan.showDock;
  const pendingApprovalDockLabel = approvalDockLabel(
    pendingApprovalScan.counts,
    pendingApprovalSummary
  );

  return {
    pendingApprovalScan,
    pendingApprovalMsgId,
    pendingApprovalToolId,
    approvalUiPlan,
    pendingApprovalCount,
    pendingApprovalSummary,
    approvalDockVisible,
    pendingApprovalDockLabel,
  };
}
