// 全局审批悬浮卡的可见性与形态（纯函数，jest 直测）。
// 规则：只呈现需要用户本人裁决的条目；审批 / 工具 / 欢迎 / 配对 / 账号 / 设置页下隐藏；
// 有 Composer 的页面（新对话、会话）贴在输入条上方，其余贴底部安全区。
import type { ApprovalItem } from '@/domain/types/domain';
import { needsUserDecision } from '@/domain/pure/approvalAttention';

/** 前缀匹配：`/approval` 同时覆盖 `/approval/[id]`、`/approvals`、`/approval-history` */
export const APPROVAL_FLOAT_HIDDEN_PREFIXES = [
  '/approval',
  '/tools',
  '/welcome',
  '/pair',
  '/account',
  '/settings',
] as const;

export type ApprovalFloatAnchor = 'composer' | 'safeArea';

/** 低风险卡内直接裁决；高风险只给「查看并滑动确认」 */
export type ApprovalFloatMode = 'quick' | 'review';

export interface ApprovalFloatModel {
  item: ApprovalItem;
  /** 除当前条以外仍待裁决的条数（> 0 时显示「还有 N 个」） */
  others: number;
  mode: ApprovalFloatMode;
  anchor: ApprovalFloatAnchor;
}

export function isApprovalFloatHiddenOn(pathname: string): boolean {
  return APPROVAL_FLOAT_HIDDEN_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix)
  );
}

export function approvalFloatAnchorFor(pathname: string): ApprovalFloatAnchor {
  return pathname === '/' || pathname.startsWith('/session/')
    ? 'composer'
    : 'safeArea';
}

export function approvalFloatModel(
  pending: readonly ApprovalItem[],
  pathname: string
): ApprovalFloatModel | null {
  if (isApprovalFloatHiddenOn(pathname)) return null;
  // pending 已按剩余时间升序，首条即最紧急
  const actionable = pending.filter(needsUserDecision);
  const item = actionable[0];
  if (!item) return null;
  return {
    item,
    others: actionable.length - 1,
    mode: item.dangerLevel === 2 ? 'review' : 'quick',
    anchor: approvalFloatAnchorFor(pathname),
  };
}
