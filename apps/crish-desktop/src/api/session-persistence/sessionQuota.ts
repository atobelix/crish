/**
 * sessionLocalStorage / sessionRustDb 共用的 localStorage quota 截断标志工具。
 *
 * 独立成模块的原因：sessionRustDb 的 hydrate 链需要读 quota 截断标志
 * （hasQuotaTruncation），sessionLocalStorage 又编排调用 sessionRustDb 的
 * persistAllSessionsRust —— 若标志函数留在 sessionLocalStorage，两者互相 import
 * 形成环形依赖（depcruise no-circular 门禁必红）。抽离共享纯函数后双方均只依赖
 * 本模块（处置口径同 cacheMetricsCompute 先例：共享实现下沉至中性模块）。
 *
 * 背景（P1-F3 / F5-03 修复）：saveSessionBody 主 setItem 抛 QuotaExceededError
 * 时回退 slice(-100) 落盘，旧消息被静默丢弃且无任何提示（审计 F5-03）。修复：
 * 截断落盘时置位会话级截断标志（key 前缀 crish_quota_truncated_），hydrate 链
 * 读取标志 → 数据面暴露 + logInternalError 日志；后续全量写成功（quota 已释放）
 * 时清除标志（恢复策略）。标志自身的读写也 try/catch：quota 耗尽时标志可能写不
 * 进，但绝不允许抛错污染保存主流程。
 */

const QUOTA_TRUNCATED_PREFIX = 'crish_quota_truncated_';

export function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/** 置位会话级 quota 截断标志（截断落盘后调用）。 */
export function markQuotaTruncated(sessionId: string): void {
  const id = asNonEmptyString(sessionId);
  if (!id) return;
  try {
    localStorage.setItem(QUOTA_TRUNCATED_PREFIX + id, '1');
  } catch {
    /* quota / private mode */
  }
}

/** 会话是否存在 quota 截断标志（hydrate / UI 数据面读取）。 */
export function hasQuotaTruncation(sessionId: string): boolean {
  const id = asNonEmptyString(sessionId);
  if (!id) return false;
  try {
    return localStorage.getItem(QUOTA_TRUNCATED_PREFIX + id) !== null;
  } catch {
    return false;
  }
}

/** 清除会话级 quota 截断标志（全量写成功即恢复）。 */
export function clearQuotaTruncation(sessionId: string): void {
  const id = asNonEmptyString(sessionId);
  if (!id) return;
  try {
    localStorage.removeItem(QUOTA_TRUNCATED_PREFIX + id);
  } catch {
    /* ignore */
  }
}
