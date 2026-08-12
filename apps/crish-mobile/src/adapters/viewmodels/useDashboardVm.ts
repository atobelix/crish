// 仪表盘视图模型（M4 §2.2.2 页面唯一数据入口，L2 页面只消费本模型）：
// - 读：connectionStore（相位/最近错误/最后同步）、eventStore.network（F3 §3.2.1
//   事件流域相位）、devicePresenceStore（设备数）、sessionStore.sessions（待审批/活动
//   run 聚合，F1 §5.3 角标口径 + F03 活动任务口径）、windowOf(最新会话)（feed 数据面，
//   环形 500 条上限由 eventStore 保证，R2UX-05-09）；
// - 过滤状态（R2UX-05-06：只看错误 / 只看当前 run / 只看工具）：本地 useState 持有
//   （F3 §5.1 过滤不丢已缓冲条目——仅渲染层筛选，数据不重拉），实际筛选在 EventFeed
//   渲染层执行；
// - 写：retry（ConnectionBanner 重试入口 → 观测接线单例 reconnect，M4 §3.7）；
// - 派生纯函数导出供单测（排序/聚合不变量，F5 §2.1 / F1 §4.4）。
import { useMemo, useState } from 'react';
import type { FeedNetwork } from '@/domain/store/eventStore';
import { windowOf } from '@/domain/store/eventStore';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import type { FeedEntry } from '@/domain/store/eventReducers';
import { readString } from '@/domain/store/eventReducers';
import type { ConnectionPhase } from '@/domain/store/connectionStore';
import { useConnectionStore } from '@/adapters/hooks/useAppStore';
import { useEventStore } from '@/adapters/hooks/useAppStore';
import { useSessionStore } from '@/adapters/hooks/useAppStore';
import { useDevicePresenceStore } from '@/adapters/hooks/useAppStore';
import { getObservationWiring } from '@/adapters/wiring/observationWiring';

// ── 派生纯函数（可单测）───────────────────────────────────────────────

/** 待审批总数（F1 §5.3 角标口径：各会话待审批计数之和；查询兜底前的事件驱动计数） */
export function pendingApprovalTotal(
  sessions: readonly SessionSummary[]
): number {
  return sessions.reduce((sum, s) => sum + s.pendingApprovalCount, 0);
}

/** 活动 run 总数（F1 F03 活动任务口径：各会话 activeRunIds 之和，agent-start 加 / run-terminal 清） */
export function activeRunTotal(sessions: readonly SessionSummary[]): number {
  return sessions.reduce((sum, s) => sum + s.activeRunIds.length, 0);
}

/** feed 所属会话（会话排序不变量 sessions[0] = pinned → 活动 → updatedAt 降序，F5 §2.1） */
export function feedSessionOf(
  sessions: readonly SessionSummary[]
): SessionSummary | null {
  return sessions[0] ?? null;
}

/**
 * 「当前 run」派生（F3 §5.1 只看当前 run 数据面）：
 * 会话 engineLastRunId（权威，F1 §4.4 会话绑定最新 run）优先；
 * 缺失（旧条目/会话未同步）→ 取窗口内最新带 runId 条目的 runId；
 * 均无 → null（此时「只看当前 run」无对象，渲染层显示空态）。
 */
export function deriveCurrentRunId(
  session: SessionSummary | null,
  entries: readonly FeedEntry[]
): string | null {
  if (session?.engineLastRunId) return session.engineLastRunId;
  for (let i = entries.length - 1; i >= 0; i--) {
    const runId = readString(entries[i], 'runId');
    if (runId) return runId;
  }
  return null;
}

export interface DashboardFilterState {
  errorsOnly: boolean;
  runOnly: boolean;
  toolOnly: boolean;
}

export interface DashboardVm extends DashboardFilterState {
  /** 连接相位（M5 §4.3.1 投影表：disconnected/connecting/ready/recovering/offline） */
  phase: ConnectionPhase;
  /** 事件流域相位（F3 §3.2.1：live/reconnecting/offline） */
  network: FeedNetwork;
  /** 最近一次连接错误（null = 无记录；错误态横幅数据面，M4 §6.4） */
  lastError: string | null;
  /** 最后同步时刻 ms（connectionStore ready 相位打点；stale 灰字数据面，R2UX-05-10） */
  lastSyncAt: number | null;
  /** stale 标记（网络非 live = 数据可能过期，F1 §4.7 诚实化） */
  stale: boolean;
  /** 设备数（null = 未知，不伪造 0，R2UX §6.1 P2） */
  deviceCount: number | null;
  /** 待审批总数（F1 §5.3） */
  pendingApprovalCount: number;
  /** 活动 run 总数（F1 F03） */
  activeRunCount: number;
  /** feed 所属会话 id（null = 无会话 → 空态） */
  sessionId: string | null;
  /** feed 条目（环形窗口原序，未过滤；过滤在渲染层） */
  entries: readonly FeedEntry[];
  /** 当前 run id（「只看当前 run」筛选数据面；null = 无 run） */
  currentRunId: string | null;
  toggleErrorsOnly: () => void;
  toggleRunOnly: () => void;
  toggleToolOnly: () => void;
  /** ConnectionBanner 重试（观测接线单例 reconnect；未启动则静默） */
  retry: () => void;
}

export function useDashboardVm(): DashboardVm {
  const phase = useConnectionStore((s) => s.phase);
  const lastError = useConnectionStore((s) => s.lastError);
  const lastSyncAt = useConnectionStore((s) => s.lastSyncAt);
  const network = useEventStore((s) => s.network);
  const sessions = useSessionStore((s) => s.sessions);
  const deviceCount = useDevicePresenceStore((s) => s.count);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [runOnly, setRunOnly] = useState(false);
  const [toolOnly, setToolOnly] = useState(false);

  const session = useMemo(() => feedSessionOf(sessions), [sessions]);
  // feed 窗口读取（windowOf 未建窗返回空窗口视图，不触发额外渲染）
  const entries = useMemo(
    () => (session ? windowOf(session.id).entries : []),
    [session]
  );

  const currentRunId = useMemo(
    () => deriveCurrentRunId(session, entries),
    [session, entries]
  );

  return {
    phase,
    network,
    lastError,
    lastSyncAt,
    stale: network !== 'live',
    deviceCount,
    pendingApprovalCount: pendingApprovalTotal(sessions),
    activeRunCount: activeRunTotal(sessions),
    sessionId: session?.id ?? null,
    entries,
    currentRunId,
    errorsOnly,
    runOnly,
    toolOnly,
    toggleErrorsOnly: () => setErrorsOnly((v) => !v),
    toggleRunOnly: () => setRunOnly((v) => !v),
    toggleToolOnly: () => setToolOnly((v) => !v),
    retry: () => {
      getObservationWiring()?.reconnect();
    },
  };
}
