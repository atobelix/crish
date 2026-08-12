// 审批纯逻辑 reducers（M5 §3.1：所有集合更新纯函数放此处，store 动作只做转发，jest 直测）
// 覆盖：排序（主键剩余时间升序 + A2 裁决次键）、upsert 幂等、决策状态机（idle→sending→sent/failed 防双点）、
//       决策后移除与审计回执记录（F2 §7）
import type { ApprovalItem, ApprovalRecord } from '../types/domain';
import type { ApprovalDecision } from '../../../../../packages/shared-types/src/generated/device/types';

// 引擎审批超时（F2 §2.1 / core_run_commands.rs:88 APPROVAL_TIMEOUT = 120s）
export const APPROVAL_TIMEOUT_MS = 120_000;
// 决策防双点窗口（F2 §9.3-3 / R2UX-04-03：移动端 300ms 防抖，桌面 200ms 放宽值）
export const DECISION_BUSY_MS = 300;
// 历史保留上限（F2 §7.1：本地保留最近 500 条）
export const APPROVAL_HISTORY_MAX = 500;
// 已决/过期条目在待办列表的保留时长（F2 §4.2-4：过期条目置灰保留 24 小时）
export const FINISHED_RETENTION_MS = 24 * 3_600_000;

// 终态集合：此后同 toolCallId 的 approval-requested 迟到事件一律幂等忽略（F2 §11.2 事件迟到）
const TERMINAL_STATUSES = new Set([
  'approved',
  'denied',
  'expired',
  'conflict',
]);

function isTerminal(item: ApprovalItem): boolean {
  return TERMINAL_STATUSES.has(item.status);
}

/**
 * 待办排序（F2 §4.2 契约 + A2 主控裁决放行次键，R2UX §6.3）：
 * - 主键（不可改）：剩余时间升序（expiresAt 升序，最紧急在顶部）；
 * - 次键 1：同 run 的多个审批聚合相邻（runId 相同 → 共享组号，稳定相邻）；
 * - 次键 2：同剩余时间内 L2 高风险优先于 L1；
 * - 兜底：receivedAtMs 升序（稳定）。
 * 次键仅在主键相等（同剩余时间）时生效，不改变紧急程度判定。
 */
export function sortApprovals(items: readonly ApprovalItem[]): ApprovalItem[] {
  // 预分配 run 组号（先于比较器执行，保证组号分配与比较顺序无关）
  const groupOf = new Map<string, number>();
  const groups = items.map((item) => {
    if (item.runId === null) {
      // 无 run 上下文的条目各自独立成组，不做「无 run」间的聚合
      return -1;
    }
    let g = groupOf.get(item.runId);
    if (g === undefined) {
      g = groupOf.size;
      groupOf.set(item.runId, g);
    }
    return g;
  });

  return [...items]
    .map((item, index) => ({ item, group: groups[index]! }))
    .sort((a, b) => {
      // 主键：剩余时间升序（F2 §4.2 契约）
      if (a.item.expiresAt !== b.item.expiresAt) {
        return a.item.expiresAt - b.item.expiresAt;
      }
      // 次键 2：同剩余时间 L2 优先（R2UX §6.3-2）
      if (a.item.dangerLevel !== b.item.dangerLevel) {
        return b.item.dangerLevel - a.item.dangerLevel;
      }
      // 次键 1：同 run 聚合相邻（R2UX §6.3-1；同剩余时间同危险级别内生效）
      if (a.group !== b.group) {
        return a.group - b.group;
      }
      // 兜底稳定序
      return a.item.receivedAtMs - b.item.receivedAtMs;
    })
    .map(({ item }) => item);
}

export interface UpsertPendingResult {
  items: ApprovalItem[];
  /** true = 新增或内容变更；false = 幂等忽略（终态或内容一致） */
  changed: boolean;
}

/**
 * 事件流入 upsert（F2 §4.1 / §11.2）：
 * - 同 toolCallId 幂等：实时预览 + 收口流双发（E2E-10）只保留一份；
 * - 已存在且非终态 → 覆盖内容，保留 receivedAtMs/expiresAt/status（不重置本地倒计时）；
 * - 已存在且终态（approved/denied/expired/conflict）→ 忽略（事件迟到，F2 §11.2）。
 */
export function upsertPendingItem(
  items: readonly ApprovalItem[],
  incoming: ApprovalItem
): UpsertPendingResult {
  const index = items.findIndex(
    (p) => p.request.toolCallId === incoming.request.toolCallId
  );
  if (index < 0) {
    return { items: sortApprovals([...items, incoming]), changed: true };
  }
  const existing = items[index]!;
  if (isTerminal(existing)) {
    return { items: items as ApprovalItem[], changed: false };
  }
  const merged: ApprovalItem = {
    ...incoming,
    // 幂等去重：保留本地倒计时与既有通道状态（E2E-10 双发不重置）
    receivedAtMs: existing.receivedAtMs,
    expiresAt: existing.expiresAt,
    status: existing.status,
    decisionStatus: existing.decisionStatus,
    decisionBusy: existing.decisionBusy,
    decisionSentAtMs: existing.decisionSentAtMs,
    decision: existing.decision,
  };
  const next = [...items];
  next[index] = merged;
  return { items: next, changed: true };
}

/**
 * 决策发送开始（状态机 idle→sending，F2 §11.3 乐观更新）：
 * - 防双点（F2 §9.3-3）：decisionBusy 为 true，或距上次发送 < 300ms → 拒绝；
 * - 仅 pending 可发起（queued/deciding/终态拒绝）；
 * - 乐观置 status='deciding'（F2 §11.3）。
 */
export function beginDecision(
  items: readonly ApprovalItem[],
  busy: Readonly<Record<string, boolean>>,
  toolCallId: string,
  nowMs: number
): { items: ApprovalItem[]; busy: Record<string, boolean>; ok: boolean } {
  const index = items.findIndex((p) => p.request.toolCallId === toolCallId);
  if (index < 0)
    return { items: items as ApprovalItem[], busy: { ...busy }, ok: false };
  const item = items[index]!;
  if (
    item.status !== 'pending' ||
    item.decisionBusy ||
    busy[toolCallId] === true
  ) {
    return { items: items as ApprovalItem[], busy: { ...busy }, ok: false };
  }
  if (
    item.decisionSentAtMs !== undefined &&
    nowMs - item.decisionSentAtMs < DECISION_BUSY_MS
  ) {
    return { items: items as ApprovalItem[], busy: { ...busy }, ok: false };
  }
  const next = [...items];
  next[index] = {
    ...item,
    status: 'deciding',
    decisionStatus: 'sending',
    decisionBusy: true,
    decisionSentAtMs: nowMs,
  };
  return { items: next, busy: { ...busy, [toolCallId]: true }, ok: true };
}

export interface ResolveResult {
  items: ApprovalItem[];
  /** 移除条目时产生的审计回执记录（未移除则为 null） */
  record: ApprovalRecord | null;
  /** 是否命中条目（未命中 = 已移除/未知 toolCallId，幂等容忍） */
  found: boolean;
}

/**
 * 决策落定（命令回执 ok 或 approval-resolved 事件到达，先到者；F2 §11.3）：
 * - sending/deciding → 从待办移除 + 审计回执入历史；
 * - expired 决策（引擎补发/对账，F2 §8.3 / R1）同样移除，历史渠道 'auto'。
 */
export function resolveApproval(
  items: readonly ApprovalItem[],
  toolCallId: string,
  decision: ApprovalDecision,
  resolvedAtMs: number
): ResolveResult {
  const index = items.findIndex((p) => p.request.toolCallId === toolCallId);
  if (index < 0)
    return { items: items as ApprovalItem[], record: null, found: false };
  const item = items[index]!;
  const next = [...items];
  next.splice(index, 1);
  const record: ApprovalRecord = {
    toolCallId: item.request.toolCallId,
    toolName: item.request.toolName,
    sessionId: item.request.sessionId,
    runId: item.runId,
    decision: decision === 'expired' ? 'expired' : decision,
    // 渠道判定（F2 §7.1-3）：本机发送过 → mobile；expired → auto；否则为其他设备处理
    channel:
      decision === 'expired'
        ? 'auto'
        : item.decisionSentAtMs !== undefined
          ? 'mobile'
          : 'desktop',
    reason: item.reason,
    resolvedAtMs,
  };
  return { items: next, record, found: true };
}

/**
 * 决策发送失败回滚（F2 §11.3：网络失败 → deciding→pending 回滚，保留已选理由；F2 §12.3「决策未送达，将自动重试」）：
 * - 发送通道状态机 sending→failed；
 * - 业务状态 deciding→pending（回滚后可再次 beginDecision）。
 */
export function failDecision(
  items: readonly ApprovalItem[],
  busy: Readonly<Record<string, boolean>>,
  toolCallId: string
): { items: ApprovalItem[]; busy: Record<string, boolean>; found: boolean } {
  const index = items.findIndex((p) => p.request.toolCallId === toolCallId);
  if (index < 0)
    return { items: items as ApprovalItem[], busy: { ...busy }, found: false };
  const item = items[index]!;
  if (item.status !== 'deciding') {
    return { items: items as ApprovalItem[], busy: { ...busy }, found: false };
  }
  const next = [...items];
  next[index] = {
    ...item,
    status: 'pending',
    decisionStatus: 'failed',
    decisionBusy: false,
  };
  const nextBusy = { ...busy };
  delete nextBusy[toolCallId];
  return { items: next, busy: nextBusy, found: true };
}

/**
 * 冲突标记（F2 §11.2：NotFound 冲突 / 双端并发后到者 → conflict；F2 §3.3 提示后转 expired 或刷新）。
 */
export function markConflictItem(
  items: readonly ApprovalItem[],
  toolCallId: string
): { items: ApprovalItem[]; found: boolean } {
  const index = items.findIndex((p) => p.request.toolCallId === toolCallId);
  if (index < 0) return { items: items as ApprovalItem[], found: false };
  const item = items[index]!;
  const next = [...items];
  next[index] = {
    ...item,
    status: 'conflict',
    decisionStatus: 'failed',
    decisionBusy: false,
  };
  return { items: next, found: true };
}

export interface ExpireResult {
  items: ApprovalItem[];
  /** 本地倒计时到期（F2 §8.3）：pending/deciding → expired（条目保留置灰 24h，F2 §4.2-4） */
  record: ApprovalRecord | null;
  found: boolean;
}

/**
 * 本地倒计时到期（F2 §8.3，无服务端事件，引擎不广播 expired）：
 * - 仅 pending/deciding 可置 expired（M5 §3.1 markExpired 语义）；
 * - 条目保留在待办列表（status='expired' 置灰，保留 FINISHED_RETENTION_MS，F2 §4.2-4）；
 * - 同步产生历史记录（channel 'auto'，F2 §7.1-2）。
 */
export function expireApproval(
  items: readonly ApprovalItem[],
  toolCallId: string,
  nowMs: number
): ExpireResult {
  const index = items.findIndex((p) => p.request.toolCallId === toolCallId);
  if (index < 0)
    return { items: items as ApprovalItem[], record: null, found: false };
  const item = items[index]!;
  if (item.status !== 'pending' && item.status !== 'deciding') {
    return { items: items as ApprovalItem[], record: null, found: false };
  }
  const next = [...items];
  next[index] = {
    ...item,
    status: 'expired',
    decisionStatus: 'failed',
    decisionBusy: false,
  };
  const record: ApprovalRecord = {
    toolCallId: item.request.toolCallId,
    toolName: item.request.toolName,
    sessionId: item.request.sessionId,
    runId: item.runId,
    decision: 'expired',
    channel: 'auto',
    reason: item.reason,
    resolvedAtMs: nowMs,
  };
  return { items: next, record, found: true };
}

/**
 * 手动清理过期条目（F2 §4.2-4 可手动清理）与对账移除：直接移出待办列表。
 */
export function dismissItem(
  items: readonly ApprovalItem[],
  toolCallId: string
): { items: ApprovalItem[]; found: boolean } {
  const index = items.findIndex((p) => p.request.toolCallId === toolCallId);
  if (index < 0) return { items: items as ApprovalItem[], found: false };
  const next = [...items];
  next.splice(index, 1);
  return { items: next, found: true };
}

/** 历史追加（保留最近 APPROVAL_HISTORY_MAX 条，F2 §7.1） */
export function appendHistory(
  history: readonly ApprovalRecord[],
  record: ApprovalRecord
): ApprovalRecord[] {
  const next = [...history, record];
  if (next.length <= APPROVAL_HISTORY_MAX) return next;
  return next.slice(next.length - APPROVAL_HISTORY_MAX);
}

/** 按过期时刻清理已过保留期的终态条目（F2 §4.2-4 24h；返回清理后的列表与清理数） */
export function pruneExpired(
  items: readonly ApprovalItem[],
  nowMs: number
): { items: ApprovalItem[]; removed: number } {
  const retained = items.filter(
    (p) =>
      p.status !== 'expired' || nowMs - p.expiresAt <= FINISHED_RETENTION_MS
  );
  return { items: retained, removed: items.length - retained.length };
}
