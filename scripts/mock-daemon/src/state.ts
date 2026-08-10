// =======================================================================
// mock daemon v0（R0-06）——Mock 状态（单一事实源）
//
// 职责：
//   1. 逐会话事件存储（EventStore）：按 sequence 单调分配并保存全部
//      events.push 载荷，供 events.resume 续传分页与 readSessionEvents 查询；
//   2. 设备注册表：配对记录（deviceId → 设备名/平台/配对时间/最近活跃），
//      重连续接与多客户端并发都以 deviceId 为键；
//   3. 审批状态：pendingApprovals（待审批集合）+ approvalHistory（已决策记录）
//      + approvalGates（场景时间线等待决策的闸门）——approve/deny 命令、
//      listPendingApprovals、approvalHistory 都从这里读；
//   4. 写命令幂等缓存：同 msgId 重发回显首次结果（D3 §5.4，TTL 5 分钟）。
//
// 与真实桌面网关的差异：mock 只维护内存状态，进程退出即清零（纯测试基建，
// 不做持久化）；sequence 分配策略与桌面 events 表一致（会话内单调递增）。
// =======================================================================

import type { JsonValue } from '../../../packages/shared-types/src/primitive-types';
import type { ApprovalDecision, PendingApproval, ApprovalHistoryItem, SessionIndexEntry, Manifest } from '../../../packages/shared-types/src/generated/device/types';
import { nowIso } from './util.js';

/** 会话内单调 sequence（从 1 起；与桌面 events 表同语义，0 保留给「无事件」游标） */
export type Sequence = number;

/** 事件存储条目（events.push 的 event 载荷 + 会话归属） */
export interface StoredEvent {
  sequence: Sequence;
  sessionId: string;
  event: JsonValue;
  /** 预览帧（sequence 未落库）不写入存储，故存储内恒为持久化事件 */
}

/** 设备记录（配对成功后登记；重连以 deviceId 为键续接） */
export interface DeviceRecord {
  deviceId: string;
  deviceName: string;
  platform?: string;
  pairedAt: number;
  lastSeenAt: number;
}

/** 待审批项（审批场景的当前闸门 + listPendingApprovals 的数据源） */
export interface PendingApprovalState {
  request: PendingApproval;
  /** 等待决策的闸门；approve/deny 命令触发 resolve */
  gate: { toolCallId: string; resolve: (decision: ApprovalDecision, reason: string | undefined) => void } | null;
  resolved: boolean;
}

/** 审批决策等待结果（场景时间线 await 用） */
export interface ApprovalDecisionResult {
  decision: ApprovalDecision;
  reason: string | undefined;
}

/** 幂等缓存默认 TTL（毫秒；D3 §5.4 写命令 5 分钟） */
export const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

/** 会话事件存储：sequence 分配 + 开区间分页（对齐 EventPage 契约） */
export class SessionStore {
  readonly sessionId: string;
  private items: StoredEvent[] = [];

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** 追加一条事件，返回分配的 sequence（单调递增） */
  append(event: JsonValue): Sequence {
    const sequence = this.maxSequence() + 1;
    this.items.push({ sequence, sessionId: this.sessionId, event });
    return sequence;
  }

  maxSequence(): Sequence {
    return this.items.length === 0 ? 0 : this.items[this.items.length - 1]!.sequence;
  }

  /** 开区间分页（afterSequence 之后的 maxEvents 条；复用 EventPage 契约） */
  since(afterSequence: Sequence, maxEvents: number): { events: StoredEvent[]; nextAfterSequence: Sequence; hasMore: boolean } {
    const start = this.items.findIndex((it) => it.sequence > afterSequence);
    const slice = start < 0 ? [] : this.items.slice(start, start + maxEvents);
    const nextAfterSequence = slice.length === 0 ? afterSequence : slice[slice.length - 1]!.sequence;
    return {
      events: slice,
      nextAfterSequence,
      hasMore: start + maxEvents < this.items.length,
    };
  }

  /** 全量（供测试与 readRunEvents 过滤） */
  all(): StoredEvent[] {
    return [...this.items];
  }
}

/** Mock 全局状态（server 与 connection/commands 共享） */
export class MockState {
  readonly desktopId: string;
  readonly pairCode: string;
  readonly pairMode: boolean;
  readonly sessions = new Map<string, SessionStore>();
  readonly devices = new Map<string, DeviceRecord>();
  readonly pendingApprovals = new Map<string, PendingApprovalState>();
  readonly approvalHistory: ApprovalHistoryItem[] = [];
  readonly manifest: Manifest;
  /** 写命令幂等缓存（deviceId → msgId → 响应结果；与配对注册表解耦，重连不丢） */
  private readonly idempotency = new Map<string, Map<string, { at: number; result: JsonValue }>>();
  private historySequence = 0;

  constructor(opts: { desktopId?: string; pairCode: string; pairMode: boolean; manifest: Manifest }) {
    this.desktopId = opts.desktopId ?? 'desktop-mock-0001';
    this.pairCode = opts.pairCode;
    this.pairMode = opts.pairMode;
    this.manifest = opts.manifest;
  }

  /** 取会话存储（不存在则创建） */
  store(sessionId: string): SessionStore {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = new SessionStore(sessionId);
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** 配对登记（重复配对 = 更新记录；撤销走 device.unlink） */
  pairDevice(deviceId: string, deviceName: string, platform?: string): void {
    const prev = this.devices.get(deviceId);
    this.devices.set(deviceId, {
      deviceId,
      deviceName,
      ...(platform !== undefined ? { platform } : {}),
      pairedAt: prev?.pairedAt ?? Date.now(),
      lastSeenAt: Date.now(),
    });
  }

  /** 会话期活跃登记（心跳/命令时刷新 lastSeenAt） */
  touchDevice(deviceId: string): void {
    const d = this.devices.get(deviceId);
    if (d) d.lastSeenAt = Date.now();
  }

  isPaired(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  /**
   * 注册待审批项（审批场景发出 approval-requested 时调用）。
   * gate 由场景传入：命令决策后 resolve。
   */
  registerPendingApproval(request: PendingApproval, gate: PendingApprovalState['gate']): void {
    this.pendingApprovals.set(request.toolCallId, { request, gate, resolved: false });
  }

  /**
   * 提交审批决策（approve/deny 命令入口）：
   *   - 命中待审批集合 → resolve 闸门 + 记历史 + 返回 ok；
   *   - 未命中 → 返回 null（调用方回 cmd.approval_mismatch，I-02 语义）。
   */
  resolveApproval(
    toolCallId: string,
    decision: ApprovalDecision,
    reason: string | undefined,
    channel: 'mobile' = 'mobile',
  ): { ok: true; request: PendingApproval; sequence: number } | { ok: false } {
    const pending = this.pendingApprovals.get(toolCallId);
    if (!pending || pending.resolved) return { ok: false };
    pending.resolved = true;
    if (pending.gate) pending.gate.resolve(decision, reason);
    this.historySequence += 1;
    this.approvalHistory.push({
      sequence: this.historySequence,
      toolCallId,
      ...(pending.request.toolName !== undefined ? { toolName: pending.request.toolName } : {}),
      decision,
      ...(reason !== undefined ? { reason } : {}),
      channel,
      resolvedAt: Date.now(),
      ...(pending.request.sessionId !== undefined ? { sessionId: pending.request.sessionId } : {}),
      ...(pending.request.runId !== undefined ? { runId: pending.request.runId } : {}),
    });
    return { ok: true, request: pending.request, sequence: this.historySequence };
  }

  /** 待审批集合投影（listPendingApprovals 数据源） */
  listPendingApprovals(): PendingApproval[] {
    return [...this.pendingApprovals.values()]
      .filter((p) => !p.resolved)
      .map((p) => p.request);
  }

  /** 审批历史按 sequence 水位过滤（approvalHistory 数据源） */
  approvalHistorySince(afterSequence: number, limit: number): { items: ApprovalHistoryItem[]; nextAfterSequence: number; hasMore: boolean } {
    const items = this.approvalHistory.filter((it) => it.sequence > afterSequence).slice(0, limit);
    const nextAfterSequence = items.length === 0 ? afterSequence : items[items.length - 1]!.sequence;
    return { items, nextAfterSequence, hasMore: this.approvalHistory.length > afterSequence + items.length };
  }

  /**
   * 写命令幂等回显：命中缓存返回缓存的响应（重发不重复执行）。
   * 缓存与配对注册表解耦（deviceId 直接作键），配对关闭/重连场景同样生效。
   */
  replayIfCached(deviceId: string, msgId: string): unknown | null {
    const hit = this.idempotency.get(deviceId)?.get(msgId);
    if (!hit) return null;
    if (Date.now() - hit.at > IDEMPOTENCY_TTL_MS) {
      this.idempotency.get(deviceId)?.delete(msgId);
      return null;
    }
    return hit.result;
  }

  /** 写命令响应缓存（approve/deny 等；重发同 msgId 回显首次结果） */
  cacheResult(deviceId: string, msgId: string, result: unknown): void {
    let perDevice = this.idempotency.get(deviceId);
    if (!perDevice) {
      perDevice = new Map();
      this.idempotency.set(deviceId, perDevice);
    }
    perDevice.set(msgId, { at: Date.now(), result: result as JsonValue });
  }

  /** 会话索引夹具（listSessions 数据源；按需补充最后消息预览） */
  sessionIndex(): SessionIndexEntry[] {
    const entries: SessionIndexEntry[] = [];
    for (const store of this.sessions.values()) {
      const lastRunId = lastRunIdOf(store);
      entries.push({
        id: store.sessionId,
        title: `mock 会话 ${store.sessionId}`,
        folder: '常规会话',
        isPinned: false,
        isArchived: false,
        timestamp: new Date().toISOString(),
        updatedAt: Date.now(),
        messageCount: store.all().length,
        engineCursor: store.maxSequence(),
        ...(lastRunId !== undefined ? { engineLastRunId: lastRunId } : {}),
        hydratedFromEngine: true,
      });
    }
    return entries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 历史条目的时间戳（供 test 断言用） */
  now(): string {
    return nowIso();
  }
}

/** 从会话事件中提取最近一次 run-terminal 的 runId（列表展示用；无则 undefined） */
function lastRunIdOf(store: SessionStore): string | undefined {
  const events = store.all();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!.event as Record<string, unknown>;
    if (e['type'] === 'run-terminal' && typeof e['runId'] === 'string') return e['runId'];
  }
  return undefined;
}
