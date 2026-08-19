/**
 * 冷静审批条纯函数：首条 +「还有 N」。无倒计时。
 */

export function permissionBarMoreCount(pendingCount: number): number {
  if (typeof pendingCount !== 'number' || !Number.isFinite(pendingCount)) {
    return 0;
  }
  const n = Math.floor(pendingCount);
  return n > 1 ? n - 1 : 0;
}

export function permissionBarMoreLabel(more: number): string | null {
  if (typeof more !== 'number' || !Number.isFinite(more) || more <= 0) {
    return null;
  }
  return `还有 ${Math.floor(more)}`;
}

export function shouldRenderPermissionBar(
  pendingCount: number,
  firstToolId: string | undefined
): boolean {
  const id = String(firstToolId || '').trim();
  if (!id) return false;
  if (typeof pendingCount !== 'number' || !Number.isFinite(pendingCount)) {
    return false;
  }
  return Math.floor(pendingCount) > 0;
}
