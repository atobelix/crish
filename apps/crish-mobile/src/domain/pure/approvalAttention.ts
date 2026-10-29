// 需要用户本人裁决的审批：抽屉计数、汉堡提示点、悬浮审批卡共用同一判定。
import type { ApprovalItem } from '@/domain/types/domain';

const AWAITING_STATUSES: ReadonlySet<ApprovalItem['status']> = new Set([
  'pending',
  'deciding',
  'queued',
]);

/** 裁决者是用户，且仍处于待决（含决策中、离线排队） */
export function needsUserDecision(item: ApprovalItem): boolean {
  return item.arbiter === 'user' && AWAITING_STATUSES.has(item.status);
}

export function countUserDecisions(items: readonly ApprovalItem[]): number {
  return items.reduce(
    (total, item) => (needsUserDecision(item) ? total + 1 : total),
    0
  );
}
