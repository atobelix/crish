// 审批详情页视图模型（M4 §2.2.2 范式：页面唯一数据入口，状态×命令投影）
// - 读：approvalStore.pending / decisionBusy / history + 本地倒计时 tick（M5 §3.3 不进 store）；
// - 写：beginDecision（决策发送开始，decisionBusy 语义，F2 §9.3-3 防双点由 store 强制执行）
//       → outbox 入队（F2 §8.2）→ markQueued（待发送态）；
//       本阶段网络发送桥未接线（repositories 属 R2-04 后续），入队即「待发送」，
//       送达/回执由仓库接线后经 markDecisionSent / handleResolved 收敛（F2 §11.3）。
import { useCallback, useEffect, useMemo } from 'react';
import type { ApprovalItem } from '@/domain/types/domain';
import { approvalStore } from '@/domain/store/approvalStore';
import { useApprovalStore } from '@/adapters/hooks/useAppStore';
import { useCountdownTick } from '@/adapters/hooks/useCountdownTick';
import {
  createOutboxState,
  enqueueDecision,
  type EnqueueInput,
  type OutboxState,
} from '@/domain/data/outbox';

// 临时内存 outbox（F2 §8.2 纯逻辑接线；持久化与重放由 domain/repositories 接管，届时本态移除）
let outboxState: OutboxState = createOutboxState();

/** 未完成 outbox 条数（pending/failed 计入角标，sent 等待确认不计，R2UX-04-05） */
export function approvalOutboxCount(): number {
  return outboxState.items.filter((i) => i.status !== 'sent').length;
}

/** 测试隔离：清空内存 outbox 队列（仅测试调用） */
export function resetApprovalOutboxForTest(): void {
  outboxState = createOutboxState();
}

/**
 * 决策入 outbox（幂等键 toolCallId + decision，D6 §6.2；msgId 供重发幂等，D3 §8.5）。
 * 返回 outbox 入队结果：ok / superseded（同键覆盖）/ full（容量满拒绝）。
 */
export function enqueueApprovalDecision(
  item: ApprovalItem,
  decision: 'approved' | 'denied',
  reason?: string
): 'ok' | 'superseded' | 'full' {
  const nowMs = Date.now();
  const input: EnqueueInput = {
    id: `${item.request.toolCallId}::${decision}::${nowMs}`,
    toolCallId: item.request.toolCallId,
    decision,
    ...(reason !== undefined ? { reason } : {}),
    ...(item.runId !== null ? { runId: item.runId } : {}),
    msgId: `approval-${item.request.toolCallId}-${decision}-${nowMs}`,
    createdAtMs: nowMs,
  };
  const result = enqueueDecision(outboxState, input, nowMs);
  outboxState = result.state;
  return result.outcome;
}

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
      const s = approvalStore.getState();
      if (outcome === 'full') {
        // 队列满：回滚 deciding→pending 并反馈失败（F2 §8.2 容量语义）
        s.markDecisionFailed(toolCallId);
        s.setOutboxCount(approvalOutboxCount());
        return { ok: false, reason: 'queue-full' };
      }
      // 决策已入 outbox → 待发送态（网络恢复后由仓库补发，F2 §8.2 / R2UX-04-05）
      s.markQueued(toolCallId);
      s.setOutboxCount(approvalOutboxCount());
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
