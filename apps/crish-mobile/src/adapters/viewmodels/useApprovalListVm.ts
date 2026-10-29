// 审批列表视图模型：待办 + 倒计时 + 对账刷新。
import { useCallback, useEffect, useMemo } from 'react';
import type { ApprovalItem } from '@/domain/types/domain';
import { approvalStore } from '@/domain/store/approvalStore';
import { useApprovalStore } from '@/adapters/hooks/useAppStore';
import { useCountdownTick } from '@/adapters/hooks/useCountdownTick';
import { ensureApprovalWiring } from '@/adapters/wiring/approvalWiring';

export const COUNTDOWN_TICK_MS = 1000;

export interface ApprovalRow {
  item: ApprovalItem;
  remainingMs: number;
}

export interface ApprovalListVm {
  rows: ApprovalRow[];
  outboxCount: number;
  refresh: () => Promise<void>;
}

export function useApprovalListVm(): ApprovalListVm {
  const pending = useApprovalStore((s) => s.pending);
  const outboxCount = useApprovalStore((s) => s.outboxCount);
  const now = useCountdownTick(COUNTDOWN_TICK_MS, pending.length > 0);

  useEffect(() => {
    const wiring = ensureApprovalWiring();
    void wiring?.reconcile();
  }, []);

  useEffect(() => {
    for (const item of pending) {
      if (
        (item.status === 'pending' ||
          item.status === 'deciding' ||
          item.status === 'queued') &&
        now >= item.expiresAt
      ) {
        approvalStore.getState().markExpired(item.request.toolCallId, now);
      }
    }
  }, [pending, now]);

  const rows = useMemo<ApprovalRow[]>(
    () =>
      pending.map((item) => ({
        item,
        remainingMs: Math.max(0, item.expiresAt - now),
      })),
    [pending, now]
  );

  const refresh = useCallback(async () => {
    await ensureApprovalWiring()?.reconcile();
  }, []);

  return {
    rows,
    outboxCount,
    refresh,
  };
}
