import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { engineApproveTool, engineDenyTool } from '../../api/chatBridge';
import type { ShowToastFn } from '../../hooks/useToastQueue';

export interface UseChatApprovalHandlersOptions {
  activeSessionId: string | null;
  messages: SessionMessage[];
  agents: SessionAgent[];
  onShowToast: ShowToastFn;
}

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

export function useChatApprovalHandlers({
  activeSessionId,
  messages,
  agents,
  onShowToast,
}: UseChatApprovalHandlersOptions) {
  // 请求级闭包持久锁：记录在途请求中的 toolId 集合，与 Promise 生命周期强绑定
  const inFlightToolIdsRef = useRef<Set<string>>(new Set());
  const [inFlightCount, setInFlightCount] = useState(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const isToolBusy = useCallback((toolId: string): boolean => {
    return inFlightToolIdsRef.current.has(toolId);
  }, []);

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
    async (toolId: string, msgId: string, remember = false) => {
      const tid = String(toolId || '').trim();
      const mid = String(msgId || '').trim();
      if (!activeSessionId || !tid || !mid) return;

      // 严格防重入：已在请求飞行中的 toolId 直接拦截，消除弱网连击与重复派发
      if (inFlightToolIdsRef.current.has(tid)) {
        return;
      }

      inFlightToolIdsRef.current.add(tid);
      setInFlightCount(inFlightToolIdsRef.current.size);

      try {
        if (remember) {
          const { t: tc } = findChatTool(activeSessionId, mid, tid);
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

        await engineApproveTool(tid);
      } catch (_err) {
        // 关键防倒退守卫：核对当前 Store 中该工具的最新状态
        const { t: currentTc } = findChatTool(activeSessionId, mid, tid);
        // 若已被并发事件推进至 success / completed 终态，或已有实际执行输出，坚决拦截后发过期 catch 覆写为 error
        if (
          currentTc?.status === 'success' ||
          (currentTc?.status as string) === 'completed' ||
          (currentTc?.status === 'running' &&
            currentTc?.output &&
            currentTc.output !== '执行中…')
        ) {
          return;
        }

        updateMessageToolCall(activeSessionId, mid, tid, {
          status: 'error',
          output: '批准失败',
        });
        onShowToast?.('批准失败，请重试');
      } finally {
        inFlightToolIdsRef.current.delete(tid);
        if (isMountedRef.current) {
          setInFlightCount(inFlightToolIdsRef.current.size);
        }
      }
    },
    [activeSessionId, onShowToast]
  );

  const handleApprovalDeny = useCallback(
    async (toolId: string, msgId: string) => {
      const tid = String(toolId || '').trim();
      const mid = String(msgId || '').trim();
      if (!activeSessionId || !tid || !mid) return;

      // 严格防重入：已在请求飞行中的 toolId 直接拦截
      if (inFlightToolIdsRef.current.has(tid)) {
        return;
      }

      inFlightToolIdsRef.current.add(tid);
      setInFlightCount(inFlightToolIdsRef.current.size);

      try {
        updateMessageToolCall(activeSessionId, mid, tid, {
          status: 'error',
          output: '已拒绝',
        });

        await engineDenyTool(tid);
      } catch (_err) {
        // 关键防倒退守卫：核对当前 Store 中该工具的最新状态
        const { t: currentTc } = findChatTool(activeSessionId, mid, tid);
        // 若已被并发事件推进至 running / success / completed，坚决拦截后发 catch 覆写为 pending_approval
        if (
          currentTc?.status === 'running' ||
          currentTc?.status === 'success' ||
          (currentTc?.status as string) === 'completed'
        ) {
          return;
        }

        updateMessageToolCall(activeSessionId, mid, tid, {
          status: 'pending_approval',
          output: '拒绝未送达',
        });
        onShowToast?.('拒绝未送达，请重试');
      } finally {
        inFlightToolIdsRef.current.delete(tid);
        if (isMountedRef.current) {
          setInFlightCount(inFlightToolIdsRef.current.size);
        }
      }
    },
    [activeSessionId, onShowToast]
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
    async (msgIds: string[], toolIds: string[] = []) => {
      if (!activeSessionId) return;
      const pairs = resolveBatchPairs(msgIds, toolIds);
      if (pairs.length === 0) return;
      const runnablePairs = pairs.filter(
        ({ toolId }) => !inFlightToolIdsRef.current.has(toolId)
      );
      if (runnablePairs.length === 0) return;

      for (const { toolId } of runnablePairs) {
        inFlightToolIdsRef.current.add(toolId);
      }
      setInFlightCount(inFlightToolIdsRef.current.size);

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
            if (
              currentTc?.status === 'success' ||
              (currentTc?.status as string) === 'completed' ||
              (currentTc?.status === 'running' &&
                currentTc?.output &&
                currentTc.output !== '执行中…')
            ) {
              return;
            }
            failCount += 1;
            updateMessageToolCall(activeSessionId, msgId, toolId, {
              status: 'error',
              output: '批准失败',
            });
          }
        });
        if (failCount > 0) {
          onShowToast?.(
            failCount === runnablePairs.length
              ? '批量批准失败，请重试'
              : `${failCount} 个工具批准失败，请重试`
          );
        }
      } catch (_err) {
        for (const { toolId, msgId } of runnablePairs) {
          const { t: currentTc } = findChatTool(activeSessionId, msgId, toolId);
          if (
            currentTc?.status === 'success' ||
            (currentTc?.status as string) === 'completed' ||
            (currentTc?.status === 'running' &&
              currentTc?.output &&
              currentTc.output !== '执行中…')
          ) {
            continue;
          }
          updateMessageToolCall(activeSessionId, msgId, toolId, {
            status: 'error',
            output: '批准失败',
          });
        }
        onShowToast?.('批量批准失败，请重试');
      } finally {
        for (const { toolId } of runnablePairs) {
          inFlightToolIdsRef.current.delete(toolId);
        }
        if (isMountedRef.current) {
          setInFlightCount(inFlightToolIdsRef.current.size);
        }
      }
    },
    [activeSessionId, onShowToast, resolveBatchPairs]
  );

  const handleBatchDeny = useCallback(
    async (msgIds: string[], toolIds: string[] = []) => {
      if (!activeSessionId) return;
      const pairs = resolveBatchPairs(msgIds, toolIds);
      if (pairs.length === 0) return;
      const runnablePairs = pairs.filter(
        ({ toolId }) => !inFlightToolIdsRef.current.has(toolId)
      );
      if (runnablePairs.length === 0) return;

      for (const { toolId } of runnablePairs) {
        inFlightToolIdsRef.current.add(toolId);
      }
      setInFlightCount(inFlightToolIdsRef.current.size);

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
            if (
              currentTc?.status === 'running' ||
              currentTc?.status === 'success' ||
              (currentTc?.status as string) === 'completed'
            ) {
              return;
            }
            failCount += 1;
            updateMessageToolCall(activeSessionId, msgId, toolId, {
              status: 'pending_approval',
              output: '拒绝未送达',
            });
          }
        });
        if (failCount > 0) {
          onShowToast?.(
            failCount === runnablePairs.length
              ? '批量拒绝未送达，请重试'
              : `${failCount} 个工具拒绝未送达，请重试`
          );
        }
      } catch (_err) {
        for (const { toolId, msgId } of runnablePairs) {
          const { t: currentTc } = findChatTool(activeSessionId, msgId, toolId);
          if (
            currentTc?.status === 'running' ||
            currentTc?.status === 'success' ||
            (currentTc?.status as string) === 'completed'
          ) {
            continue;
          }
          updateMessageToolCall(activeSessionId, msgId, toolId, {
            status: 'pending_approval',
            output: '拒绝未送达',
          });
        }
        onShowToast?.('批量拒绝未送达，请重试');
      } finally {
        for (const { toolId } of runnablePairs) {
          inFlightToolIdsRef.current.delete(toolId);
        }
        if (isMountedRef.current) {
          setInFlightCount(inFlightToolIdsRef.current.size);
        }
      }
    },
    [activeSessionId, onShowToast, resolveBatchPairs]
  );

  return {
    approvalBusy: inFlightCount > 0,
    isToolBusy,
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
