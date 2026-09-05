// 审批中心列表视图模型（M4 §2.2.2 范式：审批 Tab 唯一数据入口，状态×命令投影）
// - 读：approvalStore.pending（store 已按 F2 §4.2 主键 + A2 裁决次键排好序，页面不重排）
//       / history / outboxCount；
// - 倒计时：useCountdownTick 本地派生剩余时间（M5 §3.3 不进 store），列表无待办时停表（M4 §8.2 节能）；
// - 本地过期兜底（F2 §8.3：引擎不广播 expired 事件，pending/deciding 到期自动置 expired 保留 24h）；
// - 四态：phase（loading 首帧 → ready）+ error（错误通道预留，repository 接线后注入；
//   本轮网络域未接线恒为 null，错误横幅与重试入口已就位，对齐 F2 §13.3 异常态文案）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApprovalItem, ApprovalRecord } from '@/domain/types/domain';
import { approvalStore } from '@/domain/store/approvalStore';
import { useApprovalStore } from '@/adapters/hooks/useAppStore';
import { useCountdownTick } from '@/adapters/hooks/useCountdownTick';
import { ensureApprovalWiring } from '@/adapters/wiring/approvalWiring';
import {
  ensureObservationWiring,
  getObservationWiring,
} from '@/adapters/wiring/observationWiring';

/** 已处理区展示条数（F2 §7.1 本地保留 500 条；列表只展示最近 N 条，全量查询归历史页） */
export const APPROVAL_HISTORY_RECENT_SHOWN = 5;

/** 本地倒计时步进（R2UX-04-06 最后 15s 变红依赖秒级 tick / M5 §3.3） */
export const COUNTDOWN_TICK_MS = 1000;

/** 待办行（store 排序后的条目 + 每秒派生的剩余决策时间） */
export interface ApprovalRow {
  item: ApprovalItem;
  /** 剩余决策时间 ms（expiresAt - now，父级每秒派生，M5 §3.3） */
  remainingMs: number;
}

export interface ApprovalListVm {
  /** 四态相位：loading（首帧）/ ready（数据态/空态/错误态在页面层分支） */
  phase: 'loading' | 'ready';
  /** 错误态文案（repository 接线后注入；null = 无错误） */
  error: string | null;
  /** 待办行（store 排序：剩余时间升序 + A2 次键，F2 §4.2） */
  rows: ApprovalRow[];
  /** 主 agent 裁决只读项计数（F2 §4.3 概览条「桌面端 N 项 Agent 自动裁决」） */
  mainAgentCount: number;
  /** outbox 待发送数（R2UX §3.5：与待批角标并列可区分，'待发送' 徽标） */
  outboxCount: number;
  /** 最近已处理记录（时间倒序，F2 §7.1 查询口径） */
  historyRecent: ApprovalRecord[];
  /** 重试（错误态恢复；本轮同步数据源无 IO，重试即重新就绪，repository 接线后触发对账） */
  retry: () => void;
}

export function useApprovalListVm(): ApprovalListVm {
  const pending = useApprovalStore((s) => s.pending);
  const outboxCount = useApprovalStore((s) => s.outboxCount);
  const history = useApprovalStore((s) => s.history);

  // 秒级本地倒计时（无待办时不空转，M4 §8.2 节能）
  const now = useCountdownTick(COUNTDOWN_TICK_MS, pending.length > 0);

  const [phase, setPhase] = useState<'loading' | 'ready'>('loading');
  const [error, setError] = useState<string | null>(null);

  // 首帧加载态：数据源为同步 store（无异步 IO），首次 effect 后即就绪（M4 §5.9 加载态不空转）
  useEffect(() => {
    // 审批接线装配点：观测面未启动时随审批页启动（冷启动深链直进审批场景），
    // 已启动则复用同一网关/连接；幂等单例（useFilesVm 同款装配模式）。
    const wiring = getObservationWiring() ?? ensureObservationWiring();
    if (wiring) ensureApprovalWiring();
    setPhase('ready');
  }, []);

  // 本地倒计时到期兜底（F2 §8.3 / R1）：仅未过期条目触发，store 幂等，置 expired 后不再命中
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

  const mainAgentCount = useMemo(
    () => pending.filter((p) => p.arbiter === 'main-agent').length,
    [pending]
  );

  // 最近 N 条、时间倒序（F2 §7.1：历史查询按时间倒序；列表只做预览）
  const historyRecent = useMemo(
    () => [...history].slice(-APPROVAL_HISTORY_RECENT_SHOWN).reverse(),
    [history]
  );

  const retry = useCallback(() => {
    setError(null);
    setPhase('ready');
  }, []);

  return {
    phase,
    error,
    rows,
    mainAgentCount,
    outboxCount,
    historyRecent,
    retry,
  };
}
