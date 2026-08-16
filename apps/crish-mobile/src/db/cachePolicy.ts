// 缓存清理策略（M5 §5.5：容量上限/清理窗口纯函数 + 执行器）
// 口径（M5 §5.5 表 + D6 §10.7 双上限）：events 每会话窗口 + 全局兜底；其余表按状态/时间窗清理。
// 纯函数保证可单测；执行器注入 SqlDriver（真实环境 expo-sqlite / 测试内存 mock）。
import type { SqlDriver } from './driver';

/** 缓存清理上限（M5 §5.5；D6 §10.7 的「每会话 2000」为同步草案口径，以 M5 为准） */
export interface CacheLimits {
  /** events：每会话保留最近条数（M5 §5.5：5000） */
  eventsPerSession: number;
  /** events：全局保留上限（M5 §5.5：5 万） */
  eventsGlobal: number;
  /** approval_history：已决/过期保留天数（M5 §5.5：30；pending 恒保留） */
  approvalHistoryKeepDays: number;
  /** session_summaries：保留最近会话数（M5 §5.5：200） */
  sessionKeepCount: number;
  /** approval_queue：sent 条目保留天数（M5 §5.5：7；pending/failed 恒保留） */
  outboxKeepDays: number;
  /** notifications：resolved 保留天数（M5 §5.5：7） */
  notificationsKeepDays: number;
}

/** 默认清理上限（M5 §5.5 数值） */
export const DEFAULT_CACHE_LIMITS: CacheLimits = {
  eventsPerSession: 5000,
  eventsGlobal: 50_000,
  approvalHistoryKeepDays: 30,
  sessionKeepCount: 200,
  outboxKeepDays: 7,
  notificationsKeepDays: 7,
};

/** 毫秒转天数工具 */
export function daysToMs(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// events 清理计划（纯函数）
// ---------------------------------------------------------------------------

/** 单会话事件清理步骤：删除该会话内 sequence 小于 keepCount 后第 keepCount 新的那条之前的全部旧事件 */
export interface EventsCleanupStep {
  sessionId: string;
  /** 该会话保留的条数（原值或全局兜底收缩值） */
  keepCount: number;
}

/** 输入会话摘要（清理计算用） */
export interface SessionEventSummary {
  sessionId: string;
  /** 该会话事件行数 */
  count: number;
  /** 会话最近更新时间（毫秒，用于全局兜底时按旧优先裁剪） */
  updatedAtMs: number;
}

/**
 * 计算 events 清理步骤（纯函数，M5 §5.5）：
 * - 每会话超出 eventsPerSession 的旧事件删除（LRU 近似 = 会话内 sequence 最旧者，D6 §10.7 同语义）；
 * - 每会话清理后若仍超全局上限，按「会话最旧优先」进一步收缩各会话保留数，直至 ≤ eventsGlobal；
 * - 返回需要清理的会话步骤；无需清理的会话不在结果中。
 */
export function computeEventsCleanup(
  sessions: readonly SessionEventSummary[],
  limits: CacheLimits = DEFAULT_CACHE_LIMITS
): EventsCleanupStep[] {
  // 第一步：每会话截断到 eventsPerSession
  const kept = sessions.map((s) => ({
    ...s,
    keepCount: Math.min(s.count, limits.eventsPerSession),
  }));
  let totalKept = kept.reduce((sum, s) => sum + s.keepCount, 0);
  if (totalKept <= limits.eventsGlobal) {
    // 未超全局上限：只返回需要截断的会话
    return kept
      .filter((s) => s.count > s.keepCount)
      .map((s) => ({ sessionId: s.sessionId, keepCount: s.keepCount }));
  }
  // 第二步：全局兜底——按会话 updated_at 最旧优先收缩保留数（LRU 近似，M5 §5.5 注释）
  const ordered = [...kept].sort(
    (a, b) =>
      a.updatedAtMs - b.updatedAtMs || a.sessionId.localeCompare(b.sessionId)
  );
  const result = ordered.map((s) => ({ ...s }));
  let i = 0;
  while (totalKept > limits.eventsGlobal && i < result.length) {
    const s = result[i]!;
    const shrink = Math.min(s.keepCount, totalKept - limits.eventsGlobal);
    s.keepCount -= shrink;
    totalKept -= shrink;
    i += 1;
  }
  return result
    .filter((s) => s.count > s.keepCount)
    .map((s) => ({ sessionId: s.sessionId, keepCount: s.keepCount }));
}

// ---------------------------------------------------------------------------
// 时间窗口清理（纯函数）
// ---------------------------------------------------------------------------

/** 单条清理 SQL 计划 */
export interface CleanupSql {
  table: string;
  /** 清理说明（测试断言/日志用） */
  description: string;
  sql: string;
  params: number[];
}

/**
 * 生成时间窗口清理 SQL（纯函数，M5 §5.5）：
 * - approval_history：非待办态（approved/denied/expired/superseded/conflict 等）且 decided_at 超窗；
 * - approval_queue：sent 且 updated_at_ms 超窗（pending/failed 恒保留，D6 §6.3 未完成永不剔除）；
 * - notifications：resolved 且 received_at 超窗。
 */
export function buildTimeWindowCleanup(
  nowMs: number,
  limits: CacheLimits = DEFAULT_CACHE_LIMITS
): CleanupSql[] {
  const historyBefore = nowMs - daysToMs(limits.approvalHistoryKeepDays);
  const outboxBefore = nowMs - daysToMs(limits.outboxKeepDays);
  const notificationBefore = nowMs - daysToMs(limits.notificationsKeepDays);
  return [
    {
      table: 'approval_history',
      description: `已决审批保留 ${limits.approvalHistoryKeepDays} 天（pending 恒保留）`,
      sql: `DELETE FROM approval_history WHERE status NOT IN ('pending', 'deciding', 'queued') AND decided_at < ?`,
      params: [historyBefore],
    },
    {
      table: 'approval_queue',
      description: `sent 条目保留 ${limits.outboxKeepDays} 天（pending/failed 恒保留）`,
      sql: `DELETE FROM approval_queue WHERE status = 'sent' AND updated_at_ms < ?`,
      params: [outboxBefore],
    },
    {
      table: 'notifications',
      description: `resolved 通知保留 ${limits.notificationsKeepDays} 天`,
      sql: `DELETE FROM notifications WHERE status = 'resolved' AND received_at < ?`,
      params: [notificationBefore],
    },
  ];
}

// ---------------------------------------------------------------------------
// 执行器
// ---------------------------------------------------------------------------

/** 清理执行结果摘要 */
export interface CleanupSummary {
  eventsDeleted: number;
  sessionsDeleted: number;
  approvalsDeleted: number;
  outboxDeleted: number;
  notificationsDeleted: number;
}

/**
 * 执行全部缓存清理（M5 §5.5：启动时 + 每 6 小时 / 日级触发）：
 * 1. events 每会话窗口 + 全局兜底（经 computeEventsCleanup）；
 * 2. session_summaries 保留最近 sessionKeepCount 个；
 * 3. 时间窗口清理（approval_history / approval_queue / notifications）。
 * @returns 各表删除行数摘要（行数经 COUNT 差值计算，语义与真实 SQLite 一致）
 */
export async function runCleanup(
  db: SqlDriver,
  nowMs: number,
  limits: CacheLimits = DEFAULT_CACHE_LIMITS
): Promise<CleanupSummary> {
  const summary: CleanupSummary = {
    eventsDeleted: 0,
    sessionsDeleted: 0,
    approvalsDeleted: 0,
    outboxDeleted: 0,
    notificationsDeleted: 0,
  };

  // 1. events：按会话窗口清理
  const sessionRows = await db.getAll<{ session_id: string }>(
    'SELECT DISTINCT session_id FROM events'
  );
  const sessionSummaries: SessionEventSummary[] = [];
  for (const s of sessionRows) {
    if (s.session_id === null) continue;
    const count =
      (
        await db.getFirst<{ count: number }>(
          'SELECT COUNT(*) AS count FROM events WHERE session_id = ?',
          [s.session_id]
        )
      )?.count ?? 0;
    const latest =
      (
        await db.getFirst<{ max: number | null }>(
          'SELECT MAX(ingested_at) AS max FROM events WHERE session_id = ?',
          [s.session_id]
        )
      )?.max ?? 0;
    sessionSummaries.push({
      sessionId: s.session_id,
      count,
      updatedAtMs: latest,
    });
  }
  const steps = computeEventsCleanup(sessionSummaries, limits);
  for (const step of steps) {
    const sessionCount =
      sessionSummaries.find((s) => s.sessionId === step.sessionId)?.count ?? 0;
    if (step.keepCount <= 0) {
      // 保留 0 条 → 删除该会话全部事件
      // > 统一输入流收敛战役 R1 §4.6（显式降级登记）：本窗口物理删除为
      // > **缓存回收**（事实源在桌面 daemon），语义上「缓存 ≠ 时间线
      // > 删除」——撤回是逻辑截断（timeline-truncate 事件，只追加不变
      // > 量保持），不物理删事件行。接入事件持久化重放时须把本窗口收敛
      // > 为逻辑截断（截断标记 / 缓存窗口边界），本轮仅登记降级语义。
      await db.exec('DELETE FROM events WHERE session_id = ?', [
        step.sessionId,
      ]);
      summary.eventsDeleted += sessionCount;
      continue;
    }
    // 保留窗口下界：该会话按 sequence 降序第 keepCount 条的 sequence
    // > R1 降级登记同上：per-session 窗口删除保留，但改逻辑截断思维
    // >（截断标记 / 缓存窗口边界，事件流只追加语义），不物理删事件行。
    const keepRows = await db.getAll<{ sequence: number }>(
      'SELECT sequence FROM events WHERE session_id = ? ORDER BY sequence DESC LIMIT ?',
      [step.sessionId, step.keepCount]
    );
    if (keepRows.length === 0) continue;
    const keepFloor = keepRows[keepRows.length - 1]!.sequence;
    await db.exec('DELETE FROM events WHERE session_id = ? AND sequence < ?', [
      step.sessionId,
      keepFloor,
    ]);
    summary.eventsDeleted += Math.max(0, sessionCount - keepRows.length);
  }

  // 2. session_summaries：保留最近 sessionKeepCount 个（LRU 近似 = updated_at 排序）
  const totalSessions =
    (
      await db.getFirst<{ count: number }>(
        'SELECT COUNT(*) AS count FROM session_summaries'
      )
    )?.count ?? 0;
  if (totalSessions > limits.sessionKeepCount) {
    const keepRows = await db.getAll<{ session_id: string }>(
      'SELECT session_id FROM session_summaries ORDER BY updated_at DESC LIMIT ?',
      [limits.sessionKeepCount]
    );
    if (keepRows.length === 0) {
      await db.exec('DELETE FROM session_summaries');
      summary.sessionsDeleted = totalSessions;
    } else {
      const placeholders = keepRows.map(() => '?').join(', ');
      await db.exec(
        `DELETE FROM session_summaries WHERE session_id NOT IN (${placeholders})`,
        keepRows.map((r) => r.session_id)
      );
      summary.sessionsDeleted = totalSessions - keepRows.length;
    }
  }

  // 3. 时间窗口清理
  for (const plan of buildTimeWindowCleanup(nowMs, limits)) {
    const countSql = `SELECT COUNT(*) AS count FROM ${plan.table}`;
    const beforeCount =
      (await db.getFirst<{ count: number }>(countSql))?.count ?? 0;
    await db.exec(plan.sql, plan.params);
    const afterCount =
      (await db.getFirst<{ count: number }>(countSql))?.count ?? 0;
    const deleted = Math.max(0, beforeCount - afterCount);
    if (plan.table === 'approval_history') summary.approvalsDeleted += deleted;
    if (plan.table === 'approval_queue') summary.outboxDeleted += deleted;
    if (plan.table === 'notifications') summary.notificationsDeleted += deleted;
  }

  return summary;
}
