// sessionStore 纯逻辑 reducers（M5 §3.1：集合更新纯函数，store 动作只转发，jest 直测）
// 覆盖：会话列表 upsert（幂等，F5 §2.1 / M6 §10.5 session.updated）、排序（F1 §4.4 活动置顶
//       + F5 §2.1 updatedAt 降序 + isPinned 优先段）、选中态、未读数（F5 §6.3 本地未读模型）
import type { SessionIndexEntry } from '../../../../../packages/shared-types/src/generated/device/types';

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
 * 全量对账（session.updatedAll 信号后的 list_sessions 重拉 / 下拉刷新，F5 §2.1 收敛漂移）：
 * 以权威列表为准替换，本地附加按 id 合并保留（未读游标/活动标记不丢）。
 */
export function reconcileSessions(
  items: readonly SessionSummary[],
  list: readonly SessionIndexEntry[],
  nowMs: number
): SessionSummary[] {
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
    };
    return next;
  });
  return sortSessions(merged);
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

/** 活动 run 标记（agent-start 置活跃 / run-terminal 清除；幂等） */
export function applyRunActive(
  item: SessionSummary,
  runId: string,
  active: boolean
): SessionSummary {
  if (active) {
    if (item.activeRunIds.includes(runId)) return item;
    return { ...item, activeRunIds: [...item.activeRunIds, runId] };
  }
  if (!item.activeRunIds.includes(runId)) return item;
  return {
    ...item,
    activeRunIds: item.activeRunIds.filter((r) => r !== runId),
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
