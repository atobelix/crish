// sessionStore 纯逻辑 reducers（M5 §3.1：集合更新纯函数，store 动作只转发，jest 直测）
// 覆盖：会话列表 upsert（幂等，F5 §2.1 / M6 §10.5 session.updated）、排序（F1 §4.4 活动置顶
//       + F5 §2.1 updatedAt 降序 + isPinned 优先段）、选中态、未读数（F5 §6.3 本地未读模型）
import type { SessionIndexEntry } from '@crish/shared-types';

// 组合纪律（M5 §1.3 / D4 §9.3）：SessionSummary = 契约 SessionIndexEntry & 本地附加，禁止复制契约字段
export interface SessionSummary extends SessionIndexEntry {
  /** 本地附加：会话面消息到达时刻 ms（updatedAt 缺失时排序兜底） */
  receivedAtMs: number;
  /** 本地附加：未读游标（F5 §6.3：本地持久化，条目点击进入即清零） */
  lastReadSequence: number;
  /** 本地附加：未读计数派生缓存（applyLatestSeq 时重算；角标红点数字，F5 §6.3） */
  unreadCount: number;
  /** 本地附加：活动 run id 集合（agent-start 加 / run-terminal 清，F1 §4.4 活动置顶数据面） */
  activeRunIds: string[];
  /** 本地附加：待审批计数（approval-requested +1 / resolved −1，F1 §5.3 角标口径） */
  pendingApprovalCount: number;
  /**
   * 本地附加：本机观察到的最近一次运行完成时刻 ms（run-terminal 落地打点，
   * applyRunActive(false) 写入；新一轮运行开始即清）。null/缺省 = 未观察到完成。
   * 主界面状态板「本次连接后完成」资格 = completedAtMs >= 连接纪元起点——
   * 连接前就完成的历史会话没有这个本地打点，天然不进状态板。
   */
  completedAtMs?: number | null;
  /**
   * 本地附加：最近一次运行以失败终结的时刻 ms（run-terminal 的
   * terminal='failed' 落地打点，批 D 抽屉行失败态的数据面；非失败
   * 终结（completed/cancelled）与新一轮运行开始均清零）。null/缺省 =
   * 最近一次终结不是失败（或未亲历终结）。与 completedAtMs 分工：
   * 那个记「完成过」，这个记「最近一次是失败」。
   */
  lastRunFailedAtMs?: number | null;
}

/** 会话活跃判定（F1 §4.4：有活动 run 或待审批 → 置顶） */
export function isSessionActive(item: SessionSummary): boolean {
  return item.activeRunIds.length > 0 || item.pendingApprovalCount > 0;
}

/** 新建会话条目（本地附加初始化） */
export function createSessionSummary(
  session: SessionIndexEntry,
  nowMs: number
): SessionSummary {
  return {
    ...session,
    receivedAtMs: nowMs,
    lastReadSequence: 0,
    unreadCount: 0,
    activeRunIds: [],
    pendingApprovalCount: 0,
    completedAtMs: null,
    lastRunFailedAtMs: null,
  };
}

/**
 * 会话排序（F1 §4.4 + F5 §2.1 合并语义）：
 * 1. isPinned 置顶优先段（F5 §2.1 桌面 partition 语义）；
 * 2. 活动会话置顶（有活动 run / 有待审批，F1 §4.4）；
 * 3. 其余按 updatedAt 降序（F5 §2.1 / 桌面 hydrateSessionsFromRust 排序直觉）；
 * 4. 稳定兜底：id 升序。
 */
export function sortSessions(
  items: readonly SessionSummary[]
): SessionSummary[] {
  return [...items].sort((a, b) => {
    const aPin = a.isPinned === true ? 1 : 0;
    const bPin = b.isPinned === true ? 1 : 0;
    if (aPin !== bPin) return bPin - aPin;
    const aAct = isSessionActive(a) ? 1 : 0;
    const bAct = isSessionActive(b) ? 1 : 0;
    if (aAct !== bAct) return bAct - aAct;
    const at = a.updatedAt ?? 0;
    const bt = b.updatedAt ?? 0;
    if (at !== bt) return bt - at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface UpsertSessionResult {
  items: SessionSummary[];
  /** true = 新增或契约字段变更；false = 内容一致幂等忽略 */
  changed: boolean;
}

/**
 * 会话 upsert（session.updated 会话面消息 / list_sessions 条目）：
 * - 同 id 幂等：契约字段以最新消息覆盖，**本地附加保留不重置**
 *   （重复 session.updated 不重置未读游标/活动标记/审批计数，F5 §6.3 清理纪律反向）；
 * - 新增：初始化本地附加（未读 0 / 无活动 run / 审批 0）。
 */
export function upsertSessionItem(
  items: readonly SessionSummary[],
  session: SessionIndexEntry,
  nowMs: number
): UpsertSessionResult {
  const index = items.findIndex((s) => s.id === session.id);
  if (index < 0) {
    return {
      items: sortSessions([...items, createSessionSummary(session, nowMs)]),
      changed: true,
    };
  }
  const existing = items[index]!;
  const merged: SessionSummary = {
    ...session,
    // 本地附加保留（幂等去重：不重置）
    receivedAtMs: existing.receivedAtMs,
    lastReadSequence: existing.lastReadSequence,
    unreadCount: existing.unreadCount,
    activeRunIds: existing.activeRunIds,
    pendingApprovalCount: existing.pendingApprovalCount,
    completedAtMs: existing.completedAtMs ?? null,
    lastRunFailedAtMs: existing.lastRunFailedAtMs ?? null,
  };
  const next = [...items];
  next[index] = merged;
  return { items: sortSessions(next), changed: true };
}

/** 会话移除（session.removed；本地未读游标随之清理，F5 §6.3） */
export function removeSessionItem(
  items: readonly SessionSummary[],
  sessionId: string
): { items: SessionSummary[]; found: boolean } {
  const index = items.findIndex((s) => s.id === sessionId);
  if (index < 0) return { items: items as SessionSummary[], found: false };
  const next = [...items];
  next.splice(index, 1);
  return { items: next, found: true };
}

/**
 * 契约字段相等（对账差分判定面）：SessionSummary 的展示数据只来自这些字段，
 * 任一不同即真实差分；本地附加由对账保留，不参与判定。
 */
function sessionEntryEqual(
  a: SessionIndexEntry,
  b: SessionIndexEntry
): boolean {
  return (
    a.id === b.id &&
    (a.title ?? null) === (b.title ?? null) &&
    (a.folder ?? null) === (b.folder ?? null) &&
    (a.isPinned ?? null) === (b.isPinned ?? null) &&
    (a.isArchived ?? null) === (b.isArchived ?? null) &&
    (a.timestamp ?? null) === (b.timestamp ?? null) &&
    (a.updatedAt ?? null) === (b.updatedAt ?? null) &&
    (a.messageCount ?? null) === (b.messageCount ?? null)
  );
}

export interface ReconcileSessionsResult {
  items: SessionSummary[];
  /** true = 权威列表与现状存在真实差分；false = 无差分（items 为入参原引用，调用方不得写状态） */
  changed: boolean;
}

/**
 * 全量对账（连接建立校准 / session.updatedAll 信号后的重拉 / 下拉刷新，F5 §2.1 收敛漂移）：
 * 以权威列表为准，本地附加按 id 合并保留（未读游标/活动标记/完成打点不丢）。
 * 增量口径（2026-11-02）：逐条比对契约字段算差分——无差分时返回入参原引用 +
 * changed=false，上层据此静默收尾（不写状态、不置同步标志、不打成功点）。
 */
export function reconcileSessions(
  items: readonly SessionSummary[],
  list: readonly SessionIndexEntry[],
  nowMs: number
): ReconcileSessionsResult {
  const byId = new Map(items.map((s) => [s.id, s]));
  const merged = list.map((session) => {
    const local = byId.get(session.id);
    if (!local) return createSessionSummary(session, nowMs);
    const next: SessionSummary = {
      ...session,
      receivedAtMs: local.receivedAtMs,
      lastReadSequence: local.lastReadSequence,
      unreadCount: local.unreadCount,
      activeRunIds: local.activeRunIds,
      pendingApprovalCount: local.pendingApprovalCount,
      completedAtMs: local.completedAtMs ?? null,
      lastRunFailedAtMs: local.lastRunFailedAtMs ?? null,
    };
    return next;
  });
  const sorted = sortSessions(merged);
  const changed =
    sorted.length !== items.length ||
    sorted.some((entry, i) => !sessionEntryEqual(entry, items[i]!));
  if (!changed) {
    return { items: items as SessionSummary[], changed: false };
  }
  return { items: sorted, changed: true };
}

/**
 * 已读（F5 §6.3：会话详情打开且滚动到底部 → lastReadSequence 前移 + 未读清零；
 * P1 不写回服务端）。sequence 只升不降（回退的已读标记整体忽略，不清未读）。
 */
export function markSessionRead(
  item: SessionSummary,
  sequence: number
): SessionSummary {
  if (sequence <= item.lastReadSequence) return item;
  return { ...item, lastReadSequence: sequence, unreadCount: 0 };
}

/**
 * 未读重算（F5 §6.3 未读判定：lastReadSequence < 最新 sequence **且**最新消息为助手消息）：
 * - 助手消息且游标落后 → unreadCount = 差值（角标红点数字）；
 * - 非助手消息 / 游标已追平 → 0。
 * latestIsAssistant 由接线层从 message-end 事件（message.role === 'assistant'）派生注入。
 */
export function applyLatestSeq(
  item: SessionSummary,
  latestSeq: number,
  latestIsAssistant: boolean
): SessionSummary {
  const unread =
    latestIsAssistant && latestSeq > item.lastReadSequence
      ? latestSeq - item.lastReadSequence
      : 0;
  if (unread === item.unreadCount) return item;
  return { ...item, unreadCount: unread };
}

/**
 * 活动 run 标记（agent-start 置活跃 / run-terminal 清除；幂等）。
 * 完成打点（nowMs 在场时）：run-terminal 落地 = 本机亲历的一次完成 → 写
 * completedAtMs（哪怕该 run 的 start 没被观察到——如连接前已启动、本次连接内
 * 才结束）；新一轮 run 开始 → 清 completedAtMs（回到运行中口径）。
 * 失败打点（terminal 在场时，批 D）：run-terminal 的三态透传——
 * 'failed' 写 lastRunFailedAtMs、'completed'/'cancelled' 清之（最近
 * 一次终结不是失败）；'unknown'/缺省不表态、保留原值。新一轮 run
 * 开始与完成打点同律清失败打点（旧失败不压新运行）。
 */
export function applyRunActive(
  item: SessionSummary,
  runId: string,
  active: boolean,
  nowMs?: number,
  terminal?: string
): SessionSummary {
  const failedAt = item.lastRunFailedAtMs ?? null;
  if (active) {
    const hasRun = item.activeRunIds.includes(runId);
    const completed = item.completedAtMs ?? null;
    if (hasRun && completed === null && failedAt === null) return item;
    return {
      ...item,
      activeRunIds: hasRun ? item.activeRunIds : [...item.activeRunIds, runId],
      completedAtMs: null,
      lastRunFailedAtMs: null,
    };
  }
  const hasRun = item.activeRunIds.includes(runId);
  if (!hasRun && nowMs === undefined && terminal === undefined) return item;
  const nextFailedAt =
    terminal === 'failed'
      ? (nowMs ?? failedAt)
      : terminal === 'completed' ||
          terminal === 'cancelled' ||
          terminal === 'canceled'
        ? null
        : failedAt;
  return {
    ...item,
    activeRunIds: hasRun
      ? item.activeRunIds.filter((r) => r !== runId)
      : item.activeRunIds,
    completedAtMs: nowMs ?? item.completedAtMs ?? null,
    lastRunFailedAtMs: nextFailedAt,
  };
}

/** 待审批计数（approval-requested +1 / resolved −1；钳制 ≥0，F1 §5.3） */
export function applyApprovalDelta(
  item: SessionSummary,
  delta: 1 | -1
): SessionSummary {
  const next = Math.max(0, item.pendingApprovalCount + delta);
  if (next === item.pendingApprovalCount) return item;
  return { ...item, pendingApprovalCount: next };
}
