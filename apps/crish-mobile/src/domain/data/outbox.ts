// 离线决策 outbox（F2 §8.2 / M5 §4.6 / D6 §6.2-6.3）：三态队列 + 幂等重发（纯逻辑，jest 直测）
// - 三态：pending（待发，可立即重放）/ sent（已送达，等待 approval-resolved 事件确认出队，D6 §6.3 确认等待）/ failed（失败退避中，到点可重试）
// - 幂等键：toolCallId + decision（D6 §6.2：(requestId, decision) 本地唯一；任务书 R2-04 指定 toolCallId + decision）
// - 重发：指数退避 1s→4s→16s→60s 封顶（D6 §6.3 / M5 §4.6.2 裁决修正 AU1 P2-7 口径）；FIFO 顺序 + 单飞（M5 §4.6.1）
// - 上限：容量（D6 §6.3 默认 200，超限仅剔除已完成的 sent 条目，未完成永不剔除）+ 同键去重覆盖
// - 崩溃恢复：hydrateOutbox 恢复旧队列 + collectReplayable 扫描重发（任务书 R2-04「应用重启恢复扫描」）

// 队列容量上限（D6 §6.3：默认 200 条）
export const OUTBOX_MAX_ITEMS = 200;
// 连续失败 ≥ 5 次转人工提示（F2 §8.2 / M5 §4.6.1），但保留队列元素（无硬上限，TTL 兜底）
export const OUTBOX_MAX_ATTEMPTS = 5;
// 条目 TTL（D6 §6.4 默认 24h；到期置灰展示「可能已过期」，仍在队列中）
export const OUTBOX_TTL_MS = 24 * 3_600_000;

export type OutboxStatus = 'pending' | 'sent' | 'failed';

export interface OutboxItem {
  /** 本地动作 id（uuid/nextId） */
  id: string;
  /** 幂等键（引擎侧 I-02 校验，D3 §8.2） */
  toolCallId: string;
  /** 决策（deny 可带 reason） */
  decision: 'approved' | 'denied';
  /** 拒绝理由（仅 deny） */
  reason?: string;
  /** 命令载荷 runId */
  runId?: string;
  /** 命令消息 msgId（同 msgId 重发幂等，D3 §8.5） */
  msgId: string;
  status: OutboxStatus;
  /** 重试计数 */
  attempts: number;
  lastError: string | null;
  /** 下次可重放时刻（pending 为 null；failed 由退避表计算） */
  nextRetryAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface OutboxState {
  items: OutboxItem[];
  /** 重放单飞标志（M5 §4.6.1：禁止并发重放同一批） */
  replaying: boolean;
}

export function createOutboxState(): OutboxState {
  return { items: [], replaying: false };
}

/**
 * 失败退避表（D6 §6.3 / M5 §4.6.2 修正口径）：第 N 次失败后的等待 1s→4s→16s→60s 封顶。
 */
export function outboxBackoffMs(attempts: number): number {
  if (attempts <= 1) return 1_000;
  if (attempts === 2) return 4_000;
  if (attempts === 3) return 16_000;
  return 60_000;
}

/** 幂等键：toolCallId + decision（D6 §6.2 同键去重语义） */
export function outboxIdempotencyKey(
  toolCallId: string,
  decision: OutboxItem['decision']
): string {
  return `${toolCallId}::${decision}`;
}

export type EnqueueInput = {
  /** 本地动作 id（uuid/nextId） */
  id: string;
  /** 幂等键（引擎侧 I-02 校验，D3 §8.2） */
  toolCallId: string;
  /** 决策（deny 可带 reason） */
  decision: 'approved' | 'denied';
  /** 拒绝理由（仅 deny） */
  reason?: string;
  /** 命令载荷 runId */
  runId?: string;
  /** 命令消息 msgId（同 msgId 重发幂等，D3 §8.5） */
  msgId: string;
  /** 入队时刻 ms */
  createdAtMs: number;
};

export interface EnqueueResult {
  state: OutboxState;
  /** 入队结果：ok（新增）/ superseded（同键覆盖旧决策）/ full（容量满且无可剔除 → 拒绝） */
  outcome: 'ok' | 'superseded' | 'full';
}

/**
 * 决策入队（F2 §8.2 / D6 §6.2）：
 * - 同幂等键（toolCallId + decision）已存在 → 覆盖原条目（重复决策覆盖语义，D6 §6.2）；
 * - 容量：满且无「已完成」sent 条目 → 拒绝（未完成元素永不剔除，D6 §6.3）；
 * - 满且有 sent → 剔除最早已完成（sent）的条目。
 */
export function enqueueDecision(
  state: OutboxState,
  input: EnqueueInput,
  nowMs: number
): EnqueueResult {
  const key = outboxIdempotencyKey(input.toolCallId, input.decision);
  const existingIndex = state.items.findIndex(
    (i) => outboxIdempotencyKey(i.toolCallId, i.decision) === key
  );
  if (existingIndex >= 0) {
    const existing = state.items[existingIndex]!;
    const next = [...state.items];
    // 覆盖语义（D6 §6.2 重复决策覆盖同键元素）：id/toolCallId/createdAtMs 保持原条目（同一键），
    // decision 同键必相同；reason/runId/msgId 换新输入内容，未提供则清空（改主意覆盖，F2 §8.2）；
    // status 重置 pending、attempts 重置（原 sent 则 0）、lastError/nextRetryAtMs 清空
    next[existingIndex] = {
      id: existing.id,
      toolCallId: existing.toolCallId,
      decision: existing.decision,
      // exactOptionalPropertyTypes 兼容：可选字段仅在输入定义时写入
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      msgId: input.msgId,
      createdAtMs: existing.createdAtMs,
      status: 'pending',
      attempts: existing.status === 'sent' ? 0 : existing.attempts,
      lastError: null,
      nextRetryAtMs: null,
      updatedAtMs: nowMs,
    };
    return { state: { ...state, items: next }, outcome: 'superseded' };
  }

  const items = [...state.items];
  const item: OutboxItem = {
    id: input.id,
    toolCallId: input.toolCallId,
    decision: input.decision,
    // exactOptionalPropertyTypes：可选字段仅在定义时写入
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    msgId: input.msgId,
    createdAtMs: input.createdAtMs,
    status: 'pending',
    attempts: 0,
    lastError: null,
    nextRetryAtMs: null,
    updatedAtMs: nowMs,
  };
  if (items.length >= OUTBOX_MAX_ITEMS) {
    // 容量满：剔除最早完成的 sent 条目；无则拒绝
    const sentIndex = items.findIndex((i) => i.status === 'sent');
    if (sentIndex < 0) {
      return { state, outcome: 'full' };
    }
    items.splice(sentIndex, 1);
  }
  items.push(item);
  return { state: { ...state, items }, outcome: 'ok' };
}

/**
 * 重放扫描（F2 §8.2 / M5 §4.6.1）：可重放 = pending（立即）或 failed 且退避到期；
 * 按 FIFO（createdAtMs 升序）返回副本；sent 不参与重放（等待事件确认）。
 */
export function collectReplayable(
  state: OutboxState,
  nowMs: number
): OutboxItem[] {
  return state.items
    .filter((i) => {
      if (i.status === 'pending') return true;
      if (i.status === 'failed' && i.nextRetryAtMs !== null)
        return i.nextRetryAtMs <= nowMs;
      return false;
    })
    .sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id))
    .map((i) => ({ ...i }));
}

/** 重放单飞标记（M5 §4.6.1：开始/结束重放批次） */
export function setReplaying(
  state: OutboxState,
  replaying: boolean
): OutboxState {
  return { ...state, replaying };
}

/** 送达成功（命令回执 ok，M5 §4.6.1）：pending/failed → sent；等待 approval-resolved 确认出队（D6 §6.3） */
export function markSent(
  state: OutboxState,
  id: string,
  nowMs: number
): OutboxState {
  return {
    ...state,
    items: state.items.map((i) =>
      i.id === id
        ? {
            ...i,
            status: 'sent',
            nextRetryAtMs: null,
            lastError: null,
            updatedAtMs: nowMs,
          }
        : i
    ),
  };
}

/**
 * 送达失败（网络失败/超时，非 NotFound）：pending → failed + 退避表 nextRetryAtMs；
 * attempts ≥ OUTBOX_MAX_ATTEMPTS 标记 needsHumanAttention（F2 §8.2 ≥5 次转人工提示，队列元素保留）。
 */
export function recordFailure(
  state: OutboxState,
  id: string,
  error: string,
  nowMs: number
): OutboxState {
  return {
    ...state,
    items: state.items.map((i) => {
      if (i.id !== id || i.status === 'sent') return i;
      const attempts = i.attempts + 1;
      return {
        ...i,
        status: 'failed',
        attempts,
        lastError: error,
        nextRetryAtMs: nowMs + outboxBackoffMs(attempts),
        updatedAtMs: nowMs,
      };
    }),
  };
}

/** 是否达到人工提示阈值（F2 §8.2：≥5 次失败） */
export function needsHumanAttention(item: OutboxItem): boolean {
  return item.attempts >= OUTBOX_MAX_ATTEMPTS;
}

/** 条目 TTL 到期（D6 §6.4：仅展示层语义「可能已过期」，仍在队列中——命令仍可能被桌面接受） */
export function isTtlExpired(item: OutboxItem, nowMs: number): boolean {
  return nowMs - item.createdAtMs > OUTBOX_TTL_MS;
}

/**
 * approval-resolved 事件确认（F2 §8.2 / M5 §4.6.2）：
 * - 补发成功收口：sent → 出队入历史；
 * - 事件先到（未发送/发送中）：同 toolCallId 条目 superseded → 本地清理（M5 §4.6.2 冲突收敛表）。
 */
export function confirmResolved(
  state: OutboxState,
  toolCallId: string
): OutboxState {
  return {
    ...state,
    items: state.items.filter((i) => i.toolCallId !== toolCallId),
  };
}

/** 持久化快照（应用被终止不丢，D6 §6.6 硬底线）：返回深拷贝条目数组 */
export function snapshotOutbox(state: OutboxState): OutboxItem[] {
  return state.items.map((i) => ({ ...i }));
}

/**
 * 应用重启恢复（任务书 R2-04「应用重启恢复扫描」）：从持久化快照恢复队列；
 * - pending/failed/sent 三态原样恢复（本设计无 in-flight 瞬态，无需归一）；
 * - 恢复后调用方以 collectReplayable(nowMs) 扫描未完成决策重发；
 * - 超容量裁剪：仅剔除最早已完成的 sent（未完成永不剔除，D6 §6.3）。
 */
export function hydrateOutbox(
  items: readonly OutboxItem[],
  _nowMs: number
): OutboxState {
  let restored = items.map((i) => ({ ...i }));
  if (restored.length > OUTBOX_MAX_ITEMS) {
    const excess = restored.length - OUTBOX_MAX_ITEMS;
    let removed = 0;
    restored = restored.filter((i) => {
      if (i.status !== 'sent' || removed >= excess) return true;
      removed += 1;
      return false;
    });
  }
  return { items: restored, replaying: false };
}
