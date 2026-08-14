/**
 * 子 agent（侧栏 AgentCard / 内联 InlineAgentPanel）审批：
 * 与主对话 ChatCard 同路径——乐观摘 pending、白名单 remember、基于 inFlightToolIdsRef 请求级持久锁防重入。
 * 二次确认 UI 在 ApprovalAskCard（ChatToolStack 已挂载）；本 hook 只做决定落地。
 * 错误回滚：在 .catch() 中配置状态防倒退守卫，避免后发过期错误覆写已推进的 success/completed 终态或已接收实际输出的 running 态。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { engineApproveTool, engineDenyTool } from '../api/chatBridge';
import { rememberPrefixFromToolArgs } from '../api/approvalMeta';
import { extractCommandForMatch } from '../api/commandPermissions';
import {
  addCommandPermission,
  getSessionAgent,
  getSessionById,
  patchAgentTool,
} from '../api/storeAccess';
import type { MessageToolCallStatus } from '../store/types';
import {
  shouldSkipApprovalRollback,
  shouldSkipDenyRollback,
} from '../api/chat-approval/approvalRollbackGuard';

function findAgentTool(
  parentSessionId: string,
  agentId: string,
  msgId: string,
  toolId: string
) {
  const sess = getSessionById(parentSessionId);
  const ag =
    getSessionAgent(parentSessionId, agentId) ??
    sess?.agents?.find((a) => a.id === agentId);
  const m = ag?.messages?.find((x) => x.id === msgId);
  const t =
    m?.toolCalls?.find((x) => x.id === toolId) ??
    ag?.messages
      ?.flatMap((x) => x.toolCalls ?? [])
      .find((x) => x.id === toolId);
  return { sess, ag, m, t };
}

export type AgentApprovalHandlers = {
  approvalBusy: boolean;
  isToolBusy?: (toolId: string) => boolean;
  onApprovalAllow: (toolId: string, msgId: string, remember?: boolean) => void;
  onApprovalDeny: (toolId: string, msgId: string) => void;
};

/**
 * @param parentSessionId 主会话 id
 * @param agentId 子 agent id
 * @param onShowToast 可选；send 失败时提示（与 ChatCard 批准/拒绝失败对称）
 */
export function useAgentToolApproval(
  parentSessionId: string,
  agentId: string,
  onShowToast?: (message: string) => void
): AgentApprovalHandlers {
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

  const onApprovalAllow = useCallback(
    async (toolId: string, msgId: string, remember = false) => {
      const tid = String(toolId || '').trim();
      const mid = String(msgId || '').trim();
      if (!parentSessionId || !agentId || !tid) return;

      // 严格防重入：已在请求飞行中的 toolId 直接拦截，消除弱网连击与重复派发
      if (inFlightToolIdsRef.current.has(tid)) {
        return;
      }

      inFlightToolIdsRef.current.add(tid);
      setInFlightCount(inFlightToolIdsRef.current.size);

      try {
        if (remember) {
          const { t } = findAgentTool(parentSessionId, agentId, mid, tid);
          const prefix = rememberPrefixFromToolArgs(
            t?.name || '',
            t?.arguments || '',
            extractCommandForMatch
          );
          if (prefix) addCommandPermission(prefix);
        }

        // 乐观标 running；send 失败回滚 error
        patchAgentTool(parentSessionId, agentId, tid, {
          status: 'running' as MessageToolCallStatus,
          output: '执行中…',
        });

        await engineApproveTool(tid);
      } catch (_err) {
        // 关键防倒退守卫：核对当前 Store 中该工具的最新状态
        const { t: currentTc } = findAgentTool(
          parentSessionId,
          agentId,
          mid,
          tid
        );
        // 若已被并发事件推进至 success 终态，或已有实际执行输出，坚决拦截后发过期 catch 覆写为 error
        if (shouldSkipApprovalRollback(currentTc)) {
          return;
        }

        patchAgentTool(parentSessionId, agentId, tid, {
          status: 'error' as MessageToolCallStatus,
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
    [parentSessionId, agentId, onShowToast]
  );

  const onApprovalDeny = useCallback(
    async (toolId: string, msgId: string) => {
      const tid = String(toolId || '').trim();
      const mid = String(msgId || '').trim();
      if (!parentSessionId || !agentId || !tid) return;

      // 严格防重入：已在请求飞行中的 toolId 直接拦截
      if (inFlightToolIdsRef.current.has(tid)) {
        return;
      }

      inFlightToolIdsRef.current.add(tid);
      setInFlightCount(inFlightToolIdsRef.current.size);

      try {
        // 乐观标已拒绝；send 失败回滚 pending_approval
        patchAgentTool(parentSessionId, agentId, tid, {
          status: 'error' as MessageToolCallStatus,
          output: '已拒绝',
        });

        await engineDenyTool(tid);
      } catch (_err) {
        // 关键防倒退守卫：核对当前 Store 中该工具的最新状态
        const { t: currentTc } = findAgentTool(
          parentSessionId,
          agentId,
          mid,
          tid
        );
        // 若已被并发事件推进至 running / success，坚决拦截后发 catch 覆写为 pending_approval
        if (shouldSkipDenyRollback(currentTc)) {
          return;
        }

        patchAgentTool(parentSessionId, agentId, tid, {
          status: 'pending_approval' as MessageToolCallStatus,
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
    [parentSessionId, agentId, onShowToast]
  );

  return {
    approvalBusy: inFlightCount > 0,
    isToolBusy,
    onApprovalAllow,
    onApprovalDeny,
  };
}
