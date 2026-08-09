import { useCallback, useMemo, useState } from 'react';
import type { SessionMessage } from '../../store/types';
import { getSessionById } from '../../api/store-access/componentAccess';
import type { SessionAgent } from '../../store/types';
import {
  addCommandPermission,
  updateMessageToolCall,
} from '../../api/storeAccess';
import { toolHumanLabel } from '../../api/toolPresentation';
import {
  approvalDockLabel,
  collectPendingApprovals,
  planApprovalUi,
} from '../../api/chatApprovalUi';
import { rememberPrefixFromToolArgs } from '../../api/approvalMeta';
import { extractCommandForMatch } from '../../api/commandPermissions';
import type { ShowToastFn } from '../../hooks/useToastQueue';

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
  const [approvalBusy, setApprovalBusy] = useState(false);

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

  const handleApprovalAllow = useCallback(
    (toolId: string, msgId: string, remember = false) => {
      if (!activeSessionId || approvalBusy) return;
      const tid = String(toolId || '').trim();
      const mid = String(msgId || '').trim();
      if (!tid || !mid) return;
      setApprovalBusy(true);
      if (remember) {
        const tc = getSessionById(activeSessionId)
          ?.messages.find((m) => m.id === mid)
          ?.toolCalls?.find((t) => t.id === tid);
        const prefix = rememberPrefixFromToolArgs(
          tc?.name || '',
          tc?.arguments || '',
          extractCommandForMatch
        );
        if (prefix) {
          addCommandPermission(prefix);
        }
      }
      updateMessageToolCall(activeSessionId, mid, tid, {
        status: 'running',
        output: '执行中…',
      });
      for (const m of getSessionById(activeSessionId)?.messages || []) {
        const tc = m.toolCalls?.find(
          (t) => t.id === tid && t.status === 'pending_approval'
        );
        if (tc && m.id !== mid) {
          updateMessageToolCall(activeSessionId, m.id, tid, {
            status: 'running',
            output: '执行中…',
          });
        }
      }
      void import('../../api/chatBridge')
        .then(({ engineApproveTool }) => engineApproveTool(tid))
        .catch(() => {
          updateMessageToolCall(activeSessionId, mid, tid, {
            status: 'error',
            output: '批准失败',
          });
          onShowToast?.('批准失败，请重试');
        })
        .finally(() => {
          window.setTimeout(() => setApprovalBusy(false), 200);
        });
    },
    [activeSessionId, approvalBusy, onShowToast]
  );

  const handleApprovalDeny = useCallback(
    (toolId: string, msgId: string) => {
      if (!activeSessionId || approvalBusy) return;
      const tid = String(toolId || '').trim();
      const mid = String(msgId || '').trim();
      if (!tid || !mid) return;
      setApprovalBusy(true);
      updateMessageToolCall(activeSessionId, mid, tid, {
        status: 'error',
        output: '已拒绝',
      });
      void import('../../api/chatBridge')
        .then(({ engineDenyTool }) => engineDenyTool(tid))
        .catch(() => {
          updateMessageToolCall(activeSessionId, mid, tid, {
            status: 'pending_approval',
            output: '拒绝未送达',
          });
          onShowToast?.('拒绝未送达，请重试');
        })
        .finally(() => {
          window.setTimeout(() => setApprovalBusy(false), 200);
        });
    },
    [activeSessionId, approvalBusy, onShowToast]
  );

  const resolveBatchPairs = useCallback(
    (msgIds: string[], toolIds?: string[]) => {
      if (!activeSessionId) return [] as { toolId: string; msgId: string }[];
      const sess = getSessionById(activeSessionId);
      if (!sess?.messages?.length) return [];
      const pairs: { toolId: string; msgId: string }[] = [];
      const seen = new Set<string>();

      if (toolIds && toolIds.length > 0) {
        const n = Math.min(toolIds.length, msgIds.length || toolIds.length);
        for (let i = 0; i < n; i++) {
          const tid = String(toolIds[i] || '').trim();
          const mid = String(msgIds[i] ?? msgIds[0] ?? '').trim();
          if (!tid || !mid || seen.has(tid)) continue;
          seen.add(tid);
          pairs.push({ toolId: tid, msgId: mid });
        }
        return pairs;
      }

      const targetMsgs = new Set(
        msgIds.map((id) => String(id || '').trim()).filter(Boolean)
      );
      for (const m of sess.messages) {
        const mid = String(m.id || '').trim();
        if (!mid || !targetMsgs.has(mid)) continue;
        for (const tc of m.toolCalls || []) {
          if (tc.status !== 'pending_approval') continue;
          const tid = String(tc.id || '').trim();
          if (!tid || seen.has(tid)) continue;
          seen.add(tid);
          pairs.push({ toolId: tid, msgId: mid });
        }
      }
      return pairs;
    },
    [activeSessionId]
  );

  const handleBatchApprove = useCallback(
    (msgIds: string[], toolIds: string[] = []) => {
      if (!activeSessionId || approvalBusy) return;
      const pairs = resolveBatchPairs(msgIds, toolIds);
      if (pairs.length === 0) return;
      setApprovalBusy(true);
      for (const { toolId, msgId } of pairs) {
        updateMessageToolCall(activeSessionId, msgId, toolId, {
          status: 'running',
          output: '执行中…',
        });
      }
      void import('../../api/chatBridge')
        .then(async ({ engineApproveTool }) => {
          const results = await Promise.allSettled(
            pairs.map(({ toolId }) => engineApproveTool(toolId))
          );
          let failCount = 0;
          results.forEach((r, i) => {
            if (r.status === 'rejected') {
              failCount += 1;
              const { toolId, msgId } = pairs[i]!;
              updateMessageToolCall(activeSessionId, msgId, toolId, {
                status: 'error',
                output: '批准失败',
              });
            }
          });
          if (failCount > 0) {
            onShowToast?.(
              failCount === pairs.length
                ? '批量批准失败，请重试'
                : `${failCount} 个工具批准失败，请重试`
            );
          }
        })
        .catch(() => {
          for (const { toolId, msgId } of pairs) {
            updateMessageToolCall(activeSessionId, msgId, toolId, {
              status: 'error',
              output: '批准失败',
            });
          }
          onShowToast?.('批量批准失败，请重试');
        })
        .finally(() => {
          window.setTimeout(() => setApprovalBusy(false), 200);
        });
    },
    [activeSessionId, approvalBusy, onShowToast, resolveBatchPairs]
  );

  const handleBatchDeny = useCallback(
    (msgIds: string[], toolIds: string[] = []) => {
      if (!activeSessionId || approvalBusy) return;
      const pairs = resolveBatchPairs(msgIds, toolIds);
      if (pairs.length === 0) return;
      setApprovalBusy(true);
      for (const { toolId, msgId } of pairs) {
        updateMessageToolCall(activeSessionId, msgId, toolId, {
          status: 'error',
          output: '已拒绝',
        });
      }
      void import('../../api/chatBridge')
        .then(async ({ engineDenyTool }) => {
          const results = await Promise.allSettled(
            pairs.map(({ toolId }) => engineDenyTool(toolId))
          );
          let failCount = 0;
          results.forEach((r, i) => {
            if (r.status === 'rejected') {
              failCount += 1;
              const { toolId, msgId } = pairs[i]!;
              updateMessageToolCall(activeSessionId, msgId, toolId, {
                status: 'pending_approval',
                output: '拒绝未送达',
              });
            }
          });
          if (failCount > 0) {
            onShowToast?.(
              failCount === pairs.length
                ? '批量拒绝未送达，请重试'
                : `${failCount} 个工具拒绝未送达，请重试`
            );
          }
        })
        .catch(() => {
          for (const { toolId, msgId } of pairs) {
            updateMessageToolCall(activeSessionId, msgId, toolId, {
              status: 'pending_approval',
              output: '拒绝未送达',
            });
          }
          onShowToast?.('批量拒绝未送达，请重试');
        })
        .finally(() => {
          window.setTimeout(() => setApprovalBusy(false), 200);
        });
    },
    [activeSessionId, approvalBusy, onShowToast, resolveBatchPairs]
  );

  return {
    approvalBusy,
    setApprovalBusy,
    pendingApprovalMsgId,
    pendingApprovalToolId,
    approvalUiPlan,
    pendingApprovalCount,
    pendingApprovalSummary,
    approvalDockVisible,
    pendingApprovalDockLabel,
    handleApprovalAllow,
    handleApprovalDeny,
    handleBatchApprove,
    handleBatchDeny,
  };
}
