import { getSessionById } from '../store-access/componentAccess';

export interface ApprovalBatchPair {
  toolId: string;
  msgId: string;
}

/**
 * 纯逻辑：根据给定的 msgIds 和可选 toolIds，从当前会话解析待审批的 (toolId, msgId) 对
 */
export function resolveBatchApprovalPairs(
  sessionId: string,
  msgIds: string[],
  toolIds?: string[]
): ApprovalBatchPair[] {
  const sess = getSessionById(sessionId);
  if (!sess?.messages?.length) return [];
  const pairs: ApprovalBatchPair[] = [];
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
}
