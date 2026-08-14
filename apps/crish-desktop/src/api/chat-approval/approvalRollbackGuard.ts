import type { MessageToolCall } from '../../store/types';

/**
 * 判定在允许操作（Approve）失败后，是否跳过错误回滚。
 * 若工具已被并发推进至 success 终态，或已在 running 且输出了真实结果，严禁回滚为 error。
 */
export function shouldSkipApprovalRollback(
  currentTc?: MessageToolCall | null
): boolean {
  if (!currentTc) return false;
  if (currentTc.status === 'success') return true;
  if (
    currentTc.status === 'running' &&
    currentTc.output &&
    currentTc.output !== '执行中…'
  ) {
    return true;
  }
  return false;
}

/**
 * 判定在拒绝操作（Deny）失败后，是否跳过回滚。
 * 若工具已被并发推进至 running 或 success，严禁回退为 pending_approval。
 */
export function shouldSkipDenyRollback(
  currentTc?: MessageToolCall | null
): boolean {
  if (!currentTc) return false;
  return currentTc.status === 'running' || currentTc.status === 'success';
}
