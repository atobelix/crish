/**
 * WorkflowConfirm 确认签名分桶（§5.3）
 * 按 sessionId 分桶；会话销毁时清理。禁止进程级只增不减 Set。
 */
import type { WorkflowConfirmPayload } from './workflowConfirm';

const confirmedBySession = new Map<string, Set<string>>();

export function getPayloadSignature(payload: WorkflowConfirmPayload): string {
  return `${payload.name}::${payload.prompt}::${payload.scheduleType}::${payload.cronExpression || payload.dailyTime || payload.intervalMinutes || ''}`;
}

function bucketKeyForSession(sessionId: string | null | undefined): string {
  const id = String(sessionId || '').trim();
  return id || '__none__';
}

export function getConfirmedBucket(sessionId: string | null | undefined): Set<string> {
  const key = bucketKeyForSession(sessionId);
  let bucket = confirmedBySession.get(key);
  if (!bucket) {
    bucket = new Set();
    confirmedBySession.set(key, bucket);
  }
  return bucket;
}

/** 会话销毁时清理该会话确认签名桶 */
export function clearWorkflowConfirmSignaturesForSession(sessionId: string): void {
  const id = String(sessionId || '').trim();
  if (!id) return;
  confirmedBySession.delete(id);
}

/** 测试用：当前桶数量 */
export function __workflowConfirmBucketCountForTests(): number {
  return confirmedBySession.size;
}

/** 测试用：重置全部 */
export function __resetWorkflowConfirmSignaturesForTests(): void {
  confirmedBySession.clear();
}
