import { useState, useMemo, useCallback } from 'react';
import { getSessionById, updateMessageToolCall, addCommandPermission } from '../../../api/storeAccess';
import { toolHumanLabel } from '../../../api/toolPresentation';
import { collectPendingApprovals, planApprovalUi, approvalDockLabel } from '../../../api/chatApprovalUi';
import { rememberPrefixFromToolArgs } from '../../../api/approvalMeta';
import { extractCommandForMatch } from '../../../api/commandPermissions';
import type { ShowToastFn } from '../../../hooks/useToastQueue';

export function useChatApproval(activeSessionId: string | null | undefined, messages: readonly any[], agents: readonly any[], onShowToast: ShowToastFn) {
  const [approvalBusy, setApprovalBusy] = useState(false);
  const pendingApprovalScan = useMemo(() => { const ag = (agents || []).map((a: any) => a.messages || []); return collectPendingApprovals(messages, ag); }, [messages, agents]);
  const pendingApprovalMsgId = pendingApprovalScan.first?.msgId || '';
  const pendingApprovalToolId = pendingApprovalScan.first?.toolId || '';
  const approvalUiPlan = useMemo(() => planApprovalUi(pendingApprovalScan.counts), [pendingApprovalScan.counts]);
  const pendingApprovalCount = approvalUiPlan.total;
  const pendingApprovalSummary = useMemo(() => {
    const first = pendingApprovalScan.first; if (!first) return '';
    if (first.summary) { const fm = messages.flatMap((m: any) => m.toolCalls || []).find((tc: any) => tc.id === first.toolId) || (agents || []).flatMap((a: any) => a.messages || []).flatMap((m: any) => m.toolCalls || []).find((tc: any) => tc.id === first.toolId); if (fm) return toolHumanLabel(fm); return first.summary; }
    return '';
  }, [pendingApprovalScan.first, messages, agents]);
  const approvalDockVisible = approvalUiPlan.showDock;
  const pendingApprovalDockLabel = approvalDockLabel(pendingApprovalScan.counts, pendingApprovalSummary);

  const handleApprovalAllow = useCallback((toolId: string, msgId: string, remember = false) => {
    if (!activeSessionId || approvalBusy) return;
    const tid = String(toolId || '').trim(); const mid = String(msgId || '').trim();
    if (!tid || !mid) return;
    setApprovalBusy(true);
    if (remember) { const tc = getSessionById(activeSessionId)?.messages.find((m: any) => m.id === mid)?.toolCalls?.find((t: any) => t.id === tid); const prefix = rememberPrefixFromToolArgs(tc?.name || '', tc?.arguments || '', extractCommandForMatch); if (prefix) addCommandPermission(prefix); }
    updateMessageToolCall(activeSessionId, mid, tid, { status: 'running', output: '执行中…' });
    for (const m of getSessionById(activeSessionId)?.messages || []) { const tc = m.toolCalls?.find((t: any) => t.id === tid && t.status === 'pending_approval'); if (tc && m.id !== mid) updateMessageToolCall(activeSessionId, m.id, tid, { status: 'running', output: '执行中…' }); }
    void import('../../../api/daemonChatBridge').then(({ daemonApproveTool }) => daemonApproveTool(tid)).catch(() => { updateMessageToolCall(activeSessionId, mid, tid, { status: 'error', output: '批准失败' }); onShowToast?.('批准失败，请重试'); }).finally(() => { window.setTimeout(() => setApprovalBusy(false), 200); });
  }, [activeSessionId, approvalBusy, onShowToast]);

  const handleApprovalDeny = useCallback((toolId: string, msgId: string) => {
    if (!activeSessionId || approvalBusy) return;
    const tid = String(toolId || '').trim(); const mid = String(msgId || '').trim();
    if (!tid || !mid) return;
    setApprovalBusy(true);
    updateMessageToolCall(activeSessionId, mid, tid, { status: 'error', output: '已拒绝' });
    void import('../../../api/daemonChatBridge').then(({ daemonDenyTool }) => daemonDenyTool(tid)).catch(() => { updateMessageToolCall(activeSessionId, mid, tid, { status: 'pending_approval', output: '拒绝未送达' }); onShowToast?.('拒绝未送达，请重试'); }).finally(() => { window.setTimeout(() => setApprovalBusy(false), 200); });
  }, [activeSessionId, approvalBusy, onShowToast]);

  const resolveBatchPairs = useCallback((msgIds: string[], toolIds?: string[]) => {
    if (!activeSessionId) return [];
    const sess = getSessionById(activeSessionId);
    if (!sess?.messages?.length) return [];
    const pairs: { toolId: string; msgId: string }[] = []; const seen = new Set<string>();
    if (toolIds && toolIds.length > 0) { const n = Math.min(toolIds.length, msgIds.length || toolIds.length); for (let i = 0; i < n; i++) { const tid = String(toolIds[i] || '').trim(); const mid = String(msgIds[i] ?? msgIds[0] ?? '').trim(); if (!tid || !mid || seen.has(tid)) continue; seen.add(tid); pairs.push({ toolId: tid, msgId: mid }); } return pairs; }
    const targetMsgs = new Set(msgIds.map((id) => String(id || '').trim()).filter(Boolean));
    for (const m of sess.messages) { const mid = String(m.id || '').trim(); if (!mid || !targetMsgs.has(mid)) continue; for (const tc of m.toolCalls || []) { if (tc.status !== 'pending_approval') continue; const tid = String(tc.id || '').trim(); if (!tid || seen.has(tid)) continue; seen.add(tid); pairs.push({ toolId: tid, msgId: mid }); } }
    return pairs;
  }, [activeSessionId]);

  const runBatch = useCallback((msgIds: string[], toolIds: string[], action: 'approve' | 'deny') => {
    if (!activeSessionId || approvalBusy) return;
    const pairs = resolveBatchPairs(msgIds, toolIds);
    if (pairs.length === 0) return;
    setApprovalBusy(true);
    const nextStatus = action === 'approve' ? 'running' : 'error';
    const nextOutput = action === 'approve' ? '执行中…' : '已拒绝';
    for (const { toolId, msgId } of pairs) updateMessageToolCall(activeSessionId, msgId, toolId, { status: nextStatus, output: nextOutput });
    const fn = action === 'approve' ? 'daemonApproveTool' : 'daemonDenyTool';
    const failStatus = action === 'approve' ? 'error' : 'pending_approval';
    const failOutput = action === 'approve' ? '批准失败' : '拒绝未送达';
    const failToast = action === 'approve' ? '批量批准失败，请重试' : '批量拒绝未送达，请重试';
    void import('../../../api/daemonChatBridge').then(async (mod) => {
      const results = await Promise.allSettled(pairs.map(({ toolId }) => (mod as any)[fn](toolId)));
      let failCount = 0;
      results.forEach((r, i) => { if (r.status === 'rejected') { failCount++; const { toolId, msgId } = pairs[i]; updateMessageToolCall(activeSessionId, msgId, toolId, { status: failStatus, output: failOutput }); } });
      if (failCount > 0) onShowToast?.(failCount === pairs.length ? failToast : `${failCount} 个工具${action === 'approve' ? '批准' : '拒绝'}失败，请重试`);
    }).catch(() => { for (const { toolId, msgId } of pairs) updateMessageToolCall(activeSessionId, msgId, toolId, { status: failStatus, output: failOutput }); onShowToast?.(failToast); }).finally(() => { window.setTimeout(() => setApprovalBusy(false), 200); });
  }, [activeSessionId, approvalBusy, onShowToast, resolveBatchPairs]);

  const handleBatchApprove = useCallback((msgIds: string[], toolIds: string[] = []) => runBatch(msgIds, toolIds, 'approve'), [runBatch]);
  const handleBatchDeny = useCallback((msgIds: string[], toolIds: string[] = []) => runBatch(msgIds, toolIds, 'deny'), [runBatch]);

  return { approvalBusy, pendingApprovalMsgId, pendingApprovalToolId, approvalUiPlan, pendingApprovalCount, pendingApprovalSummary, approvalDockVisible, pendingApprovalDockLabel, handleApprovalAllow, handleApprovalDeny, resolveBatchPairs, handleBatchApprove, handleBatchDeny };
}
