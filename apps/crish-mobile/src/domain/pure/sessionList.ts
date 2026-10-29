// 会话列表的纯函数：关键词过滤 + 「今天 / 更早」分组（抽屉与测试共用）。
import type { SessionSummary } from '@/domain/store/sessionReducers';

export interface SessionDayGroups {
  today: SessionSummary[];
  earlier: SessionSummary[];
}

/** 会话的活跃时刻：优先引擎 updatedAt，缺失时用本地收达时刻兜底 */
export function sessionActivityMs(session: SessionSummary): number {
  return session.updatedAt > 0 ? session.updatedAt : session.receivedAtMs;
}

/** 本地时区当天 0 点（ms） */
export function startOfLocalDay(nowMs: number): number {
  const day = new Date(nowMs);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * 按标题或最近预览过滤，忽略大小写；空关键词原样返回。
 * previewOf 由调用方注入，避免纯函数依赖事件窗口结构。
 */
export function filterSessions(
  sessions: readonly SessionSummary[],
  query: string,
  previewOf: (sessionId: string) => string
): readonly SessionSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return sessions;
  return sessions.filter(
    (session) =>
      (session.title ?? '').toLowerCase().includes(needle) ||
      previewOf(session.id).toLowerCase().includes(needle)
  );
}

/** 保持输入顺序，按本地当天 0 点切成「今天 / 更早」两组 */
export function groupSessionsByDay(
  sessions: readonly SessionSummary[],
  nowMs: number
): SessionDayGroups {
  const dayStart = startOfLocalDay(nowMs);
  const groups: SessionDayGroups = { today: [], earlier: [] };
  for (const session of sessions) {
    if (sessionActivityMs(session) >= dayStart) groups.today.push(session);
    else groups.earlier.push(session);
  }
  return groups;
}
