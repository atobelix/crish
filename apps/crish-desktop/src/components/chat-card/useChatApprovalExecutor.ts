import { useCallback, useEffect, useState } from 'react';
import { getSessionById } from '../../store/storeAccess';
import { updateMessageToolCall } from '../../api/storeAccess';
import { engineApproveTool, engineDenyTool } from '../../api/chatBridge';
import { toast } from '../../services/toast/ToastContext';
import {
  shouldSkipApprovalRollback,
  shouldSkipDenyRollback,
} from '../../api/chat-approval/approvalRollbackGuard';
import { resolveBatchApprovalPairs } from '../../api/chat-approval/approvalBatchResolver';
import { inFlightApprovalRegistry } from '../../api/chat-approval/inFlightApprovalRegistry';

function findChatTool(sessionId: string, msgId: string, toolId: string) {
  const sess = getSessionById(sessionId);
  const m = sess?.messages?.find((x) => x.id === msgId);
  const t =
    m?.toolCalls?.find((x) => x.id === toolId) ??
    sess?.messages
      ?.flatMap((x) => x.toolCalls ?? [])
      .find((x) => x.id === toolId);
  return { sess, m, t };
}

export function useChatApprovalExecutor(activeSessionId: string | null) {
  const showToast = (m: string) => toast.show(m);
  const [, setLockVersion] = useState(0);

  useEffect(() => {
    return inFlightApprovalRegistry.subscribe(() => {
      setLockVersion((v) => v + 1);
    });
  }, []);

  const isToolBusy = useCallback((toolId: string): boolean => {
    return inFlightApprovalRegistry.isBusy(toolId);
  }, []);

  const handleApprovalAllow = useCallback(
    async (toolId: string, msgId: string, _remember?: boolean) => {
      const tid = String(toolId || '').trim();
      const mid = String(msgId || '').trim();
      if (!activeSessionId || !tid || !mid) return;

      const acquired = inFlightApprovalRegistry.acquire([tid]);
      if (acquired.length === 0) return;

      try {
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
        await engineApproveTool(tid);
      } catch (_err) {
        const { t: currentTc } = findChatTool(activeSessionId, mid, tid);
        if (shouldSkipApprovalRollback(currentTc)) return;

        updateMessageToolCall(activeSessionId, mid, tid, {
          status: 'error',
          output: '批准失败',
        });
        showToast('批准失败，请重试');
      } finally {
        inFlightApprovalRegistry.release([tid]);
      }
    },
    [activeSessionId, showToast]
  );

  const handleApprovalDeny = useCallback(
    async (toolId: string, msgId: string) => {
      const tid = String(toolId || '').trim();
      const mid = String(msgId || '').trim();
      if (!activeSessionId || !tid || !mid) return;

      const acquired = inFlightApprovalRegistry.acquire([tid]);
      if (acquired.length === 0) return;

      try {
        updateMessageToolCall(activeSessionId, mid, tid, {
          status: 'error',
          output: '已拒绝',
        });
        await engineDenyTool(tid);
      } catch (_err) {
        const { t: currentTc } = findChatTool(activeSessionId, mid, tid);
        if (shouldSkipDenyRollback(currentTc)) return;

        updateMessageToolCall(activeSessionId, mid, tid, {
          status: 'pending_approval',
          output: '拒绝未送达',
        });
        showToast('拒绝未送达，请重试');
      } finally {
        inFlightApprovalRegistry.release([tid]);
      }
    },
    [activeSessionId, showToast]
  );

  const handleBatchApprove = useCallback(
    async (msgIds: string[], toolIds: string[] = []) => {
      if (!activeSessionId) return;
      const pairs = resolveBatchApprovalPairs(activeSessionId, msgIds, toolIds);
      if (pairs.length === 0) return;

      const allTids = pairs.map((p) => p.toolId);
      const acquiredTids = new Set(inFlightApprovalRegistry.acquire(allTids));
      const runnablePairs = pairs.filter((p) => acquiredTids.has(p.toolId));
      if (runnablePairs.length === 0) return;

      for (const { toolId, msgId } of runnablePairs) {
        updateMessageToolCall(activeSessionId, msgId, toolId, {
          status: 'running',
          output: '执行中…',
        });
      }

      try {
        const results = await Promise.allSettled(
          runnablePairs.map(({ toolId }) => engineApproveTool(toolId))
        );
        let failCount = 0;
        results.forEach((r, i) => {
          if (r.status === 'rejected') {
            const { toolId, msgId } = runnablePairs[i]!;
            const { t: currentTc } = findChatTool(
              activeSessionId,
              msgId,
              toolId
            );
            if (shouldSkipApprovalRollback(currentTc)) return;
            failCount += 1;
            updateMessageToolCall(activeSessionId, msgId, toolId, {
              status: 'error',
              output: '批准失败',
            });
          }
        });
        if (failCount > 0) {
          showToast(
            failCount === runnablePairs.length
              ? '批量批准失败，请重试'
              : `${failCount} 个工具批准失败，请重试`
          );
        }
      } catch (_err) {
        for (const { toolId, msgId } of runnablePairs) {
          const { t: currentTc } = findChatTool(activeSessionId, msgId, toolId);
          if (shouldSkipApprovalRollback(currentTc)) continue;
          updateMessageToolCall(activeSessionId, msgId, toolId, {
            status: 'error',
            output: '批准失败',
          });
        }
        showToast('批量批准失败，请重试');
      } finally {
        inFlightApprovalRegistry.release(runnablePairs.map((p) => p.toolId));
      }
    },
    [activeSessionId, showToast]
  );

  const handleBatchDeny = useCallback(
    async (msgIds: string[], toolIds: string[] = []) => {
      if (!activeSessionId) return;
      const pairs = resolveBatchApprovalPairs(activeSessionId, msgIds, toolIds);
      if (pairs.length === 0) return;

      const allTids = pairs.map((p) => p.toolId);
      const acquiredTids = new Set(inFlightApprovalRegistry.acquire(allTids));
      const runnablePairs = pairs.filter((p) => acquiredTids.has(p.toolId));
      if (runnablePairs.length === 0) return;

      for (const { toolId, msgId } of runnablePairs) {
        updateMessageToolCall(activeSessionId, msgId, toolId, {
          status: 'error',
          output: '已拒绝',
        });
      }

      try {
        const results = await Promise.allSettled(
          runnablePairs.map(({ toolId }) => engineDenyTool(toolId))
        );
        let failCount = 0;
        results.forEach((r, i) => {
          if (r.status === 'rejected') {
            const { toolId, msgId } = runnablePairs[i]!;
            const { t: currentTc } = findChatTool(
              activeSessionId,
              msgId,
              toolId
            );
            if (shouldSkipDenyRollback(currentTc)) return;
            failCount += 1;
            updateMessageToolCall(activeSessionId, msgId, toolId, {
              status: 'pending_approval',
              output: '拒绝未送达',
            });
          }
        });
        if (failCount > 0) {
          showToast(
            failCount === runnablePairs.length
              ? '批量拒绝未送达，请重试'
              : `${failCount} 个工具拒绝未送达，请重试`
          );
        }
      } catch (_err) {
        for (const { toolId, msgId } of runnablePairs) {
          const { t: currentTc } = findChatTool(activeSessionId, msgId, toolId);
          if (shouldSkipDenyRollback(currentTc)) continue;
          updateMessageToolCall(activeSessionId, msgId, toolId, {
            status: 'pending_approval',
            output: '拒绝未送达',
          });
        }
        showToast('批量拒绝未送达，请重试');
      } finally {
        inFlightApprovalRegistry.release(runnablePairs.map((p) => p.toolId));
      }
    },
    [activeSessionId, showToast]
  );

  return {
    approvalBusy: inFlightApprovalRegistry.getCount() > 0,
    isToolBusy,
    handleApprovalAllow,
    handleApprovalDeny,
    handleBatchApprove,
    handleBatchDeny,
  };
}
