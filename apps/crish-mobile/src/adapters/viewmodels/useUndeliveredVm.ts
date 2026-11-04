// 未送达行视图模型（批 C 03-4）：approvalStore 的 outbox 镜像 +
// pending/history 连接 → domain/pure/undelivered 的每会话一行投影。
// 本 VM 只负责单会话面（会话屏现场）；全量计数走 approvalStore
// .outboxCount 既有面（主页汇总入口），不在此重复投影。
// 转绿退场：flash 的 expiresAtMs 到点后以一次定时刷新让投影自然
// 退场（恰 2000ms 的判定在纯函数里以 nowMs 裁决，本 VM 只负责
// 在到点时重算）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { approvalStore } from '@/domain/store/approvalStore';
import type { OutboxItem } from '@/domain/data/outbox';
import {
  deriveDeliveredFlashes,
  groupUndelivered,
  type DeliveredFlash,
  type UndeliveredGroup,
  type UndeliveredJoin,
} from '@/domain/pure/undelivered';
import { retryApprovalDecision } from '@/adapters/wiring/approvalWiring';

export interface UndeliveredVm {
  /** 本会话未送达组（无未送达条目时为 null） */
  group: UndeliveredGroup | null;
  /** 本会话送达转绿投影（有未送达组时让位于未送达行，不并存） */
  flash: DeliveredFlash | null;
  /** 重发组内全部条目（action='resend' 时有效） */
  resend: () => void;
  /** 编辑目标（组代表条目的 toolCallId；action='edit' 时有效） */
  editToolCallId: string | null;
}

export function useUndeliveredVm(sessionId: string): UndeliveredVm {
  const outboxItems = useStore(approvalStore, (s) => s.outboxItems);
  const pending = useStore(approvalStore, (s) => s.pending);
  const history = useStore(approvalStore, (s) => s.history);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // toolCallId → 审批连接（pending 优先，history 兜底；判据见
  // undelivered.ts 的 UndeliveredJoin 注释，只取可验证事实）
  const joinOf = useCallback(
    (item: OutboxItem): UndeliveredJoin => {
      const pendingItem = pending.find(
        (p) => p.request.toolCallId === item.toolCallId
      );
      if (pendingItem) {
        return {
          sessionId: pendingItem.request.sessionId || null,
          settled: 'pending',
        };
      }
      const record = history.find((h) => h.toolCallId === item.toolCallId);
      if (record) {
        const changed =
          record.channel !== 'mobile' || record.decision !== item.decision;
        return {
          sessionId: record.sessionId || null,
          settled: changed ? 'changed' : 'pending',
        };
      }
      return { sessionId: null, settled: 'missing' };
    },
    [pending, history]
  );

  const group = useMemo(() => {
    const groups = groupUndelivered(outboxItems, joinOf, nowMs);
    return groups.find((g) => g.sessionId === sessionId) ?? null;
  }, [outboxItems, joinOf, nowMs, sessionId]);

  const flash = useMemo(() => {
    if (group) return null;
    const flashes = deriveDeliveredFlashes(outboxItems, joinOf, nowMs);
    return flashes.find((f) => f.sessionId === sessionId) ?? null;
  }, [group, outboxItems, joinOf, nowMs, sessionId]);

  // 转绿到点退场：expiresAtMs 时重算一次投影（纯函数以 nowMs 判定
  // 窗口，本处只提供重算触发，不另设第二套计时语义）
  useEffect(() => {
    if (!flash) return;
    const delay = Math.max(0, flash.expiresAtMs - Date.now()) + 20;
    const timer = setTimeout(() => setNowMs(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [flash]);

  const resend = useCallback(() => {
    if (!group) return;
    for (const item of group.items) {
      retryApprovalDecision(item.id);
    }
  }, [group]);

  return {
    group,
    flash,
    resend,
    editToolCallId: group ? group.representative.toolCallId : null,
  };
}
