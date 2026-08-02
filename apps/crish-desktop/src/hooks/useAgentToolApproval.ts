/**
 * 子 agent（侧栏 AgentCard / 内联 InlineAgentPanel）审批：
 * 与主对话 ChatCard 同路径——乐观摘 pending、白名单 remember、busy 防双点。
 * 二次确认 UI 在 ApprovalAskCard（ChatToolStack 已挂载）；本 hook 只做决定落地。
 * deny/allow send 失败：回滚或标 error + 可选 toast（与 ChatCard 对称）。
 *
 * 治理防线 #33（DRY）：原实现绕过 action 层、直接 useLayoutStore.setState
 * 修改 agent toolCall（含「残留 pending 防御」扫描其他消息），
 * 现改走 storeAccess.patchAgentTool → sessionAction.patchAgentTool 纯函数路径：
 *   - 类型安全：sanitizeToolCallUpdates + applyMessageToolCallPatch 消除类型逃逸
 *   - 单一职责：终态后忽略 status 回退逻辑集中在 sanitizeToolCallUpdates
 *   - 不再扫描「同 toolId 残留 pending」：daemon 协议保证 toolId 唯一，
 *     若出现重复是 daemon bug，应在 chatBridge 修复而非在视图层兜底
 */
import { useCallback, useState } from 'react';
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
      // 乐观标 running；send 失败回滚 error
      // 治理防线 #33：走 patchAgentTool action，复用 sanitizeToolCallUpdates 终态守卫
      patchAgentTool(parentSessionId, agentId, toolId, {
        status: 'running' as MessageToolCallStatus,
        output: '执行中…',
      });
      void engineApproveTool(toolId)
        .catch(() => {
          patchAgentTool(parentSessionId, agentId, toolId, {
            status: 'error' as MessageToolCallStatus,
            output: '批准失败',
          });
          onShowToast?.('批准失败，请重试');
        })
        .finally(() => {
          window.setTimeout(() => setApprovalBusy(false), 200);
        });
    },
    [parentSessionId, agentId, onShowToast]
  );

  const onApprovalDeny = useCallback(
    (toolId: string, _msgId: string) => {
      if (!parentSessionId || !agentId || !toolId) return;
      setApprovalBusy(true);
      // 乐观标已拒绝；send 失败回滚 pending_approval（与 ChatCard 对称）
      patchAgentTool(parentSessionId, agentId, toolId, {
        status: 'error' as MessageToolCallStatus,
        output: '已拒绝',
      });
      void engineDenyTool(toolId)
        .catch(() => {
          patchAgentTool(parentSessionId, agentId, toolId, {
            status: 'pending_approval' as MessageToolCallStatus,
            output: '拒绝未送达',
          });
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
