/**
 * 子 agent（侧栏 AgentCard / 内联 InlineAgentPanel）审批：
 * 与主对话 ChatCard 同路径——乐观摘 pending、白名单 remember、busy 防双点。
 * 二次确认 UI 在 ApprovalAskCard（ChatToolStack 已挂载）；本 hook 只做决定落地。
 * deny/allow send 失败：回滚或标 error + 可选 toast（与 ChatCard 对称）。
 */
import { useCallback, useState } from 'react';
import { daemonApproveTool, daemonDenyTool } from '../api/daemonChatBridge';
import { rememberPrefixFromToolArgs } from '../api/approvalMeta';
import { extractCommandForMatch } from '../api/commandPermissions';
import {
  addCommandPermission,
  getSessionAgent,
  getSessionById,
} from '../api/storeAccess';
import { useLayoutStore } from '../store/layoutStore';
import type { MessageToolCallStatus } from '../store/types';

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
  const t = m?.toolCalls?.find((x) => x.id === toolId);
  return { sess, ag, m, t };
}

function patchAgentTool(
  parentSessionId: string,
  agentId: string,
  msgId: string,
  toolId: string,
  status: MessageToolCallStatus,
  output: string
) {
  // agent 消息仍走 layout immer setState（session actions 尚无专用 patch agent tool）
  useLayoutStore.setState((state) => {
    const sess =
      state.sessionsById[parentSessionId] ||
      state.sessions.find((s) => s.id === parentSessionId);
    const ag = sess?.agents?.find((a) => a.id === agentId);
    const m = ag?.messages?.find((x) => x.id === msgId);
    const t = m?.toolCalls?.find((x) => x.id === toolId);
    if (t) {
      t.status = status;
      t.output = output;
    }
    // 同 toolId 残留 pending（防御）；回滚时勿误改其它消息终态
    for (const other of ag?.messages || []) {
      if (other.id === msgId) continue;
      const ot = other.toolCalls?.find(
        (x) => x.id === toolId && x.status === 'pending_approval'
      );
      if (ot) {
        ot.status = status;
        ot.output = output;
      }
    }
  });
}

export type AgentApprovalHandlers = {
  approvalBusy: boolean;
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
  const [approvalBusy, setApprovalBusy] = useState(false);

  const onApprovalAllow = useCallback(
    (toolId: string, msgId: string, remember = false) => {
      if (!parentSessionId || !agentId || !toolId) return;
      setApprovalBusy(true);
      if (remember) {
        const { t } = findAgentTool(parentSessionId, agentId, msgId, toolId);
        const prefix = rememberPrefixFromToolArgs(
          t?.name || '',
          t?.arguments || '',
          extractCommandForMatch
        );
        if (prefix) addCommandPermission(prefix);
      }
      patchAgentTool(
        parentSessionId,
        agentId,
        msgId,
        toolId,
        'running',
        '执行中…'
      );
      void daemonApproveTool(toolId)
        .catch(() => {
          patchAgentTool(
            parentSessionId,
            agentId,
            msgId,
            toolId,
            'error',
            '批准失败'
          );
          onShowToast?.('批准失败，请重试');
        })
        .finally(() => {
          window.setTimeout(() => setApprovalBusy(false), 200);
        });
    },
    [parentSessionId, agentId, onShowToast]
  );

  const onApprovalDeny = useCallback(
    (toolId: string, msgId: string) => {
      if (!parentSessionId || !agentId || !toolId) return;
      setApprovalBusy(true);
      // 乐观标已拒绝；send 失败回滚 pending_approval（与 ChatCard 对称）
      patchAgentTool(
        parentSessionId,
        agentId,
        msgId,
        toolId,
        'error',
        '已拒绝'
      );
      void daemonDenyTool(toolId)
        .catch(() => {
          patchAgentTool(
            parentSessionId,
            agentId,
            msgId,
            toolId,
            'pending_approval',
            '拒绝未送达'
          );
          onShowToast?.('拒绝未送达，请重试');
        })
        .finally(() => {
          window.setTimeout(() => setApprovalBusy(false), 200);
        });
    },
    [parentSessionId, agentId, onShowToast]
  );

  return { approvalBusy, onApprovalAllow, onApprovalDeny };
}
