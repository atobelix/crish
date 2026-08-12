// 审批详情页视图模型（M4 §2.2.2 范式：页面唯一数据入口，状态×命令投影）
// - 读：approvalStore.pending / decisionBusy / history + 本地倒计时 tick（M5 §3.3 不进 store）；
// - 写：beginDecision（决策发送开始，decisionBusy 语义，F2 §9.3-3 防双点由 store 强制执行）
//       → 决策入 outbox（F2 §8.2，接线层 approvalWiring 持有队列）→ markQueued（待发送态）；
//       送达/回执由接线层重放闭环（invoke → markSent / approval-resolved → 收敛，F2 §11.3），
//       本 VM 只负责入队与状态呈现，不接触网络。
import { useCallback, useEffect, useMemo } from 'react';
import type { ApprovalItem } from '@/domain/types/domain';
import { approvalStore } from '@/domain/store/approvalStore';
import { useApprovalStore } from '@/adapters/hooks/useAppStore';
import { useCountdownTick } from '@/adapters/hooks/useCountdownTick';
import {
  approvalOutboxCount,
  enqueueApprovalDecision,
  resetApprovalOutboxForTest,
} from '@/adapters/wiring/approvalWiring';

// 兼容出口：outbox 状态与入队已迁移至接线层（approvalWiring），
// 本模块保留导出签名供 presentation 层既有引用（approvalDetailScreen.test 等）。
export {
  approvalOutboxCount,
  enqueueApprovalDecision,
  resetApprovalOutboxForTest,
};

export interface ApprovalHistoryResult {
  decision: 'approved' | 'denied' | 'expired';
  channel: string;
}

/** 决策发送结果（供页面反馈；本阶段无网络桥，正常路径恒为 queued 待发送） */
export type DecideResult =
  | { ok: true; queued: true }
  | { ok: false; reason: 'busy' | 'not-startable' | 'queue-full' };

export interface ApprovalDetailVm {
  /** 待办条目（未找到为 null） */
  item: ApprovalItem | null;
  /** 决策后审计回执（条目已移除时展示结果态，F2 §7） */
  historyResult: ApprovalHistoryResult | null;
  /** 剩余决策时间 ms（倒计时派生，M5 §3.3 不进 store） */
  remainingMs: number;
  /** decisionBusy 状态位（store 驱动，组件不自行计时，R2UX-04-03） */
  busy: boolean;
  /** 允许（单击即决策，F2 §5.2 L1 语义；L2 滑轨未在本任务范围） */
  onAllow: () => void;
  /** 拒绝（触发二次确认弹窗后发送，本阶段无拒绝理由输入，F2 §5.2 理由面板未含） */
  onDeny: () => void;
}

export function useApprovalDetailVm(toolCallId: string): ApprovalDetailVm {
  const pending = useApprovalStore((s) => s.pending);
  const decisionBusy = useApprovalStore((s) => s.decisionBusy);
  const history = useApprovalStore((s) => s.history);
  const now = useCountdownTick(1000, true);

  const item = useMemo(
    () => pending.find((p) => p.request.toolCallId === toolCallId) ?? null,
    [pending, toolCallId]
  );

  const historyResult = useMemo<ApprovalHistoryResult | null>(() => {
    const record = history.find((r) => r.toolCallId === toolCallId);
    if (!record) return null;
    return { decision: record.decision, channel: record.channel };
  }, [history, toolCallId]);

  const remainingMs = item ? Math.max(0, item.expiresAt - now) : 0;
  const busy = item ? decisionBusy[toolCallId] === true : false;

  // 本地倒计时到期（F2 §8.3：引擎不广播 expired，移动端本地兜底 pending/deciding → expired）
  useEffect(() => {
    if (
      item &&
      (item.status === 'pending' || item.status === 'deciding') &&
      now >= item.expiresAt
    ) {
      approvalStore.getState().markExpired(toolCallId, now);
    }
  }, [item, toolCallId, now]);

  const decide = useCallback(
    (decision: 'approved' | 'denied', reason?: string): DecideResult => {
      // decisionBusy 状态位防双点（R2UX-04-03：组件不自行计时，由 store 统一拦截）
      if (decisionBusy[toolCallId]) return { ok: false, reason: 'busy' };
      const ok = approvalStore.getState().beginDecision(toolCallId);
      if (!ok) return { ok: false, reason: 'not-startable' };
      const current = approvalStore
        .getState()
        .pending.find((p) => p.request.toolCallId === toolCallId);
      const outcome = current
        ? enqueueApprovalDecision(current, decision, reason)
        : 'full';
      if (outcome === 'full') {
        // 队列满：回滚 deciding→pending 并反馈失败（F2 §8.2 容量语义；
        // outboxCount 角标已由接线层 enqueue 同步）
        approvalStore.getState().markDecisionFailed(toolCallId);
        return { ok: false, reason: 'queue-full' };
      }
      // 决策已入 outbox → 待发送态（接线层重放：在线立即发送，离线等重连补发，
      // F2 §8.2 / R2UX-04-05）
      approvalStore.getState().markQueued(toolCallId);
      return { ok: true, queued: true };
    },
    [decisionBusy, toolCallId]
  );

  const onAllow = useCallback(() => {
    void decide('approved');
  }, [decide]);

  const onDeny = useCallback(() => {
    void decide('denied');
  }, [decide]);

  return { item, historyResult, remainingMs, busy, onAllow, onDeny };
}
