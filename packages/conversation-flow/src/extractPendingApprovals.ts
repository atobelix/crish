/**
 * 抽出 pending_approval。不进 Purpose 树，交给 Composer 上沿审批条。
 */

import { extractCommand, fallbackLabel } from './humanize';
import type {
  HumanizeHooks,
  PendingApproval,
  ProjectToolCallInput,
} from './types';

export function extractPendingApprovals(
  toolCalls: readonly ProjectToolCallInput[] | undefined,
  hooks?: HumanizeHooks,
): PendingApproval[] {
  const list = toolCalls ?? [];
  const out: PendingApproval[] = [];
  for (let i = 0; i < list.length; i++) {
    const tc = list[i];
    if (!tc || tc.status !== 'pending_approval') continue;
    const cmd = extractCommand(tc.arguments);
    const item: PendingApproval = {
      id: tc.id || `approval-${i}`,
      summary: fallbackLabel(tc, hooks) || tc.explanation || tc.name || '需要确认',
      command: cmd,
      toolName: tc.name || 'tool',
    };
    const risk = tc.approvalMeta?.risk;
    if (risk) item.risk = risk;
    out.push(item);
  }
  return out;
}
