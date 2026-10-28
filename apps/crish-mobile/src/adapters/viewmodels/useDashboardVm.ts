// 仪表盘视图模型（M4 §2.2.2 页面唯一数据入口 · R4 批次3 F1 状态卡补全）：
// - 读：connectionStore（相位/最近错误/最后同步/尝试次数）、eventStore.network
//   （F3 §3.2.1 事件流域相位）、devicePresenceStore（设备数）、sessionStore.sessions
//   （待审批/活动 run 聚合，F1 §5.3 角标口径 + F03 活动任务口径）、
//   eventStore.windows[feedSession.id]（feed 数据面——R4 批次3 改经 useEventStore
//   订阅响应式读取，修复旧 windowOf() 非响应式读法；环形 500 条上限由 eventStore 保证）；
// - 过滤状态：仪表盘摘要不承载过滤条（过滤属会话详情 EventFeed），R4 批次3 移除
//   无消费的 toggle 三态；
// - 写：retry（ConnectionBanner 重试入口 → 观测接线单例 reconnect，M4 §3.7）；
// - 派生纯函数导出供单测（排序/聚合不变量，F5 §2.1 / F1 §4.4）。
import { useMemo } from 'react';
import type { FeedNetwork } from '@/domain/store/eventStore';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import type { FeedEntry } from '@/domain/store/eventReducers';
import { readString } from '@/domain/store/eventReducers';
import type { ConnectionPhase } from '@/domain/store/connectionStore';
import {
  useConnectionStore,
  useEventStore,
  useSessionStore,
  useDevicePresenceStore,
} from '@/adapters/hooks/useAppStore';
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
 * 「当前 run」派生（F3 §5.1 数据面）：
 * 会话 engineLastRunId（权威，F1 §4.4 会话绑定最新 run）优先；
 * 缺失（旧条目/会话未同步）→ 取窗口内最新带 runId 条目的 runId；
 * 均无 → null。
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

/** feed 摘要条数（首页最近动态预览上限；完整流在会话详情 EventFeed） */
export const DASHBOARD_FEED_PREVIEW_LIMIT = 5;

/** feed 摘要切片（窗口尾部 N 条 = 最新在前预览；纯函数供单测） */
export function feedPreviewOf(
  entries: readonly FeedEntry[],
  limit: number = DASHBOARD_FEED_PREVIEW_LIMIT
): FeedEntry[] {
  return entries.slice(Math.max(0, entries.length - limit)).reverse();
}

export interface DashboardVm {
  /** 连接相位（M5 §4.3.1 投影表：disconnected/connecting/ready/recovering/offline） */
  phase: ConnectionPhase;
  /** 事件流域相位（F3 §3.2.1：live/reconnecting/offline） */
  network: FeedNetwork;
  /** 最近一次连接错误（null = 无记录；错误态横幅数据面，M4 §6.4） */
  lastError: string | null;
  /** 最后同步时刻 ms（connectionStore ready 相位打点；stale 灰字数据面，R2UX-05-10） */
  lastSyncAt: number | null;
  /** 累计连接/重连尝试次数（诊断数据面） */
  attemptCount: number;
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
  /** feed 所属会话标题（null = 无会话；「查看全部」跳转数据面） */
  sessionTitle: string | null;
  /** feed 条目（环形窗口原序，未过滤；预览切片在渲染层 feedPreviewOf） */
  entries: readonly FeedEntry[];
  /** 当前 run id（null = 无 run） */
  currentRunId: string | null;
  /** ConnectionBanner 重试（观测接线单例 reconnect；未启动则静默） */
  retry: () => void;
}

export function useDashboardVm(): DashboardVm {
  const phase = useConnectionStore((s) => s.phase);
  const lastError = useConnectionStore((s) => s.lastError);
  const lastSyncAt = useConnectionStore((s) => s.lastSyncAt);
  const attemptCount = useConnectionStore((s) => s.attemptCount);
  const network = useEventStore((s) => s.network);
  const sessions = useSessionStore((s) => s.sessions);
  const deviceCount = useDevicePresenceStore((s) => s.count);

  const session = useMemo(() => feedSessionOf(sessions), [sessions]);
  const sessionId = session?.id ?? null;
  // R4 批次3：经 useEventStore 订阅窗口（响应式——事件到达触发重渲染），
  // 修复旧 windowOf() 直读 store 的非响应式读法
  const entries = useEventStore((s) =>
    sessionId !== null
      ? (s.windows[sessionId]?.entries ?? EMPTY_ENTRIES)
      : EMPTY_ENTRIES
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
    attemptCount,
    stale: network !== 'live',
    deviceCount,
    pendingApprovalCount: pendingApprovalTotal(sessions),
    activeRunCount: activeRunTotal(sessions),
    sessionId,
    sessionTitle: session?.title ?? null,
    entries,
    currentRunId,
    retry: () => {
      getObservationWiring()?.reconnect();
    },
  };
}

/** 空条目兜底常量（useShallow 引用稳定：未建窗不触发重渲染） */
const EMPTY_ENTRIES: readonly FeedEntry[] = [];
