/**
 * StreamRecovery —— 流恢复协议
 *
 * 职责：
 * - 追踪活跃的 SSE/WebSocket 流状态（session × run 维度）
 * - 定时扫描卡住流（超过 STALL_TIMEOUT_MS 无数据 → paused）
 * - recoverStream 实现 snapshot + read-run-events 两步重放协议：
 *     1. get-run-snapshot 查询 run 远端状态
 *     2. 若 running → read-run-events 拉取缺失事件（分页）→ 过滤 + 排序 → dispatch replay
 *     3. 若 completed/failed → 设置 sticky terminal 状态
 * - 背压管理：
 *     render buffer 超高水位 → stream-pause；低于低水位 → stream-resume
 *     pause 期间 chunk 入队（不丢失），resume 后 drain
 * - 通过 eventBus 发布流状态变更事件
 * - 导出单例 streamRecovery，供全应用共享
 *
 * 设计契约：
 * - terminal 状态（completed/failed）是 sticky 的：一旦进入不可回退
 * - replay 事件在 dispatch 前按 sequence 过滤（seq > lastSequenceNumber），防止重复应用
 * - 背压信号是 fire-and-forget：发送 pause/resume 不阻塞渲染
 * - backpressure queue 不丢 chunk：pause 期间 chunk 入队，resume 后 drain
 * - getStream / getActiveStreams 返回浅拷贝，防止外部直接修改内部状态
 */

import {
  getDesktopDaemonClient,
  sendStreamPause,
  sendStreamResume,
} from '../api/daemonClient';
import { eventBus } from './EventBus';

// ---- Constants ----

const STALL_TIMEOUT_MS = 10_000;
const SCAN_INTERVAL_MS = 5_000;
const RECOVERY_TIMEOUT_MS = 8_000;

/** 背压高水位：render buffer 超过此值 → 发送 stream-pause（64KB） */
export const BACKPRESSURE_HIGH_WATER = 64 * 1024;
/** 背压低水位：render buffer 低于此值 → 发送 stream-resume（16KB） */
export const BACKPRESSURE_LOW_WATER = 16 * 1024;

/** recoverStream 中 read-run-events 分页拉取的最大迭代次数（防 daemon bug 导致死循环） */
const MAX_RECOVERY_ITERATIONS = 10;

// ---- Types ----

/**
 * StreamRecovery 追踪的流状态快照（公开接口）。
 *
 * 与 daemonChatBridge.StreamState 区别：
 * - 此接口描述「流恢复层」追踪的 session × run 元数据
 * - daemonChatBridge.StreamState 描述「UI 渲染层」的 assistant 文本 / 思考状态
 */
export interface TrackedStream {
  sessionId: string;
  runId: string;
  status: 'streaming' | 'paused' | 'completed' | 'failed';
  lastMessageTime: number;
  lastSequenceNumber: number;
  receivedBytes: number;
  /** 失败原因（仅 status='failed' 时存在） */
  error?: string;
}

interface InternalStreamState extends TrackedStream {
  error?: string;
}

/** 重放事件：至少包含 sequence 和 type，其余字段透传 */
export interface ReplayEvent {
  sequence: number;
  type: string;
  [key: string]: unknown;
}

/**
 * 重放载荷：recoverStream 通过 dispatchReplay 传给 replay handler 的结构。
 *
 * - events: 已过滤 + 排序的 fresh 事件（seq > afterSequence）
 * - afterSequence: 本次重放的起点（调用方已应用的 max sequence）
 * - nextAfterSequence: 本次重放后的新游标（daemon 返回的权威值）
 * - hasMore: daemon 是否还有更多事件未拉取（分页标识）
 */
export interface ReplayPayload {
  sessionId?: string;
  runId?: string;
  events: unknown[];
  afterSequence?: number;
  nextAfterSequence?: number;
  hasMore?: boolean;
}

/** 背压状态：per-session */
interface BackpressureState {
  paused: boolean;
  queue: string[];
  queuedBytes: number;
}

// ---- Helper functions ----

/**
 * 从事件对象中提取 sequence 号。
 * 支持字段名：sequence / eventSequence / seq。
 * 找不到返回 null。
 */
export function extractEventSequence(obj: unknown): number | null {
  if (!obj || typeof obj !== 'object') return null;
  const r = obj as Record<string, unknown>;
  if (typeof r.sequence === 'number') return r.sequence;
  if (typeof r.eventSequence === 'number') return r.eventSequence;
  if (typeof r.seq === 'number') return r.seq;
  return null;
}

/**
 * 把 orchestrator 事件转换为 agent 事件。
 *
 * 映射规则：
 * - runtime-event → 解包 payload.event（内部 agent 事件，含 type/block 等字段）
 * - run-completed → { type: 'run-terminal', terminal: 'completed', runId }
 * - run-failed / run-cancelled → { type: 'run-terminal', terminal: 'failed' | 'cancelled', runId }
 * - 其他 → 原样返回
 *
 * 返回 null 表示输入无效或无法解包。
 */
export function orchestratorEventToAgentEvent(
  event: unknown,
): Record<string, unknown> | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const ev = event as Record<string, unknown>;
  const type = ev.type as string | undefined;
  if (!type) return null;

  if (type === 'runtime-event') {
    const payload = ev.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    // 解包 payload.event → agent 事件（含 type / block 等字段）
    const inner = payload.event as Record<string, unknown> | undefined;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return inner;
    }
    // 兼容：payload 自身就是 agent 事件（无嵌套 event 字段）
    return { ...payload, type: String(payload.type ?? 'message-delta') };
  }

  if (type === 'run-completed') {
    return { type: 'run-terminal', terminal: 'completed', runId: ev.runId };
  }
  if (type === 'run-failed' || type === 'run-cancelled') {
    return { type: 'run-terminal', terminal: type.replace('run-', ''), runId: ev.runId };
  }

  return ev;
}

/**
 * 从事件列表中投影出 assistant 正文文本。
 *
 * 支持多种事件 shape（按优先级匹配）：
 * 1. { block: { text } }                     — 直接 agent 事件
 * 2. { text }                                — 直接文本字段
 * 3. { payload: { event: { block: { text } } } } — runtime-event 信封
 * 4. { payload: { event: { text } } }           — runtime-event 信封（无 block）
 * 5. { payload: { block: { text } } }           — 带包装层的 agent 事件
 * 6. { payload: { text } }                      — 带包装层的文本
 */
export function projectAssistantTextFromEvents(events: unknown[]): string {
  let text = '';
  for (const item of events) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    text += extractTextFromEvent(item as Record<string, unknown>);
  }
  return text;
}

function extractTextFromEvent(ev: Record<string, unknown>): string {
  // 1. 直接 agent 事件：{ block: { text } }
  const block = ev.block;
  if (block && typeof block === 'object' && !Array.isArray(block)) {
    const t = (block as Record<string, unknown>).text;
    if (typeof t === 'string') return t;
  }
  // 2. 直接文本字段
  if (typeof ev.text === 'string') return ev.text;
  // 3. 包装在 payload 中
  const payload = ev.payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const p = payload as Record<string, unknown>;
    // 3a. payload.event.block.text (runtime-event 信封)
    const inner = p.event;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const innerRec = inner as Record<string, unknown>;
      const innerBlock = innerRec.block;
      if (innerBlock && typeof innerBlock === 'object' && !Array.isArray(innerBlock)) {
        const t = (innerBlock as Record<string, unknown>).text;
        if (typeof t === 'string') return t;
      }
      if (typeof innerRec.text === 'string') return innerRec.text;
    }
    // 3b. payload.block.text
    const pBlock = p.block;
    if (pBlock && typeof pBlock === 'object' && !Array.isArray(pBlock)) {
      const t = (pBlock as Record<string, unknown>).text;
      if (typeof t === 'string') return t;
    }
    // 3c. payload.text
    if (typeof p.text === 'string') return p.text;
  }
  return '';
}

/**
 * 计算后缀增量：从 delta 中去掉与 existing 重叠的前缀部分。
 *
 * 对称处理两种前缀关系：
 * - delta 以 existing 开头 → 返回 delta.slice(existing.length)（delta 是 existing 的扩展）
 * - existing 以 delta 开头 → 返回 ''（delta 是 existing 的子串，无新内容）
 * - 无前缀关系 → 返回 delta 原样（无法对齐，emit 全量）
 *
 * 这保证：
 * - 全量 replay（afterSequence=0）时，已收正文是投影全文的前缀 → 只 emit suffix
 * - 部分 replay（afterSequence>0）时，delta 是纯新增段 → emit delta 全量
 * - 乱序 / 重放时，delta 是 existing 的子串 → 不重复 emit
 */
export function suffixDelta(existing: string, delta: string): string {
  if (!existing) return delta;
  if (!delta) return '';
  if (delta.startsWith(existing)) return delta.slice(existing.length);
  if (existing.startsWith(delta)) return '';
  return delta;
}

// ---- StreamRecovery class ----

export class StreamRecovery {
  private streams = new Map<string, InternalStreamState>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private replayHandlers = new Map<string, ((payload: ReplayPayload) => void) | null>();
  private backpressure = new Map<string, BackpressureState>();

  // ── 注册与心跳 ──────────────────────────────────────────

  registerStream(sessionId: string, runId: string): void {
    const existing = this.streams.get(sessionId);
    if (existing) {
      existing.runId = runId;
      existing.status = 'streaming';
      existing.lastMessageTime = Date.now();
      existing.lastSequenceNumber = 0;
      existing.receivedBytes = 0;
      delete existing.error;
    } else {
      this.streams.set(sessionId, {
        sessionId,
        runId,
        status: 'streaming',
        lastMessageTime: Date.now(),
        lastSequenceNumber: 0,
        receivedBytes: 0,
      });
    }
    this.ensureScanning();
    eventBus.emit('stream:registered', { sessionId, runId }, 'daemon');
  }

  updateHeartbeat(sessionId: string, options?: { sequence?: number; bytes?: number }): void {
    const s = this.streams.get(sessionId);
    if (!s) return;
    s.lastMessageTime = Date.now();
    if (options?.sequence !== undefined && options.sequence > s.lastSequenceNumber) {
      s.lastSequenceNumber = options.sequence;
    }
    if (options?.bytes !== undefined) {
      s.receivedBytes += options.bytes;
    }
    if (s.status === 'paused') {
      s.status = 'streaming';
      eventBus.emit('stream:resumed', { sessionId }, 'daemon');
    }
  }

  /** 更新指定 session 的最后一个已应用序列号（供 EventRouter 回写游标） */
  setLastSequence(sessionId: string, sequence: number): void {
    const s = this.streams.get(sessionId);
    if (s && sequence > s.lastSequenceNumber) {
      s.lastSequenceNumber = sequence;
    }
  }

  // ── 查询 ──────────────────────────────────────────────

  getStream(sessionId: string): TrackedStream | undefined {
    const s = this.streams.get(sessionId);
    return s ? this.toTrackedStream(s) : undefined;
  }

  getActiveStreams(): TrackedStream[] {
    return [...this.streams.values()].map((s) => this.toTrackedStream(s));
  }

  private toTrackedStream(s: InternalStreamState): TrackedStream {
    const result: TrackedStream = {
      sessionId: s.sessionId,
      runId: s.runId,
      status: s.status,
      lastMessageTime: s.lastMessageTime,
      lastSequenceNumber: s.lastSequenceNumber,
      receivedBytes: s.receivedBytes,
    };
    if (s.error !== undefined) {
      result.error = s.error;
    }
    return result;
  }

  // ── Terminal 状态（sticky 幂等） ────────────────────────

  /**
   * 标记流为 completed。
   * 幂等：已处于 terminal 状态（completed/failed）时为 no-op。
   */
  markCompleted(sessionId: string): void {
    const s = this.streams.get(sessionId);
    if (!s) return;
    if (this.isTerminal(s)) return;
    s.status = 'completed';
    delete s.error;
    eventBus.emit('stream:completed', { sessionId }, 'daemon');
  }

  /**
   * 标记流为 failed。
   * 幂等：已处于 terminal 状态（completed/failed）时为 no-op。
   */
  markFailed(sessionId: string, error: string): void {
    const s = this.streams.get(sessionId);
    if (!s) return;
    if (this.isTerminal(s)) return;
    s.status = 'failed';
    s.error = error;
    eventBus.emit('stream:failed', { sessionId, error }, 'daemon');
  }

  private isTerminal(s: InternalStreamState): boolean {
    return s.status === 'completed' || s.status === 'failed';
  }

  // ── 卡住流检测 ─────────────────────────────────────────

  detectStalledStreams(): string[] {
    const now = Date.now();
    const stalled: string[] = [];
    for (const s of this.streams.values()) {
      if (s.status === 'streaming' && now - s.lastMessageTime > STALL_TIMEOUT_MS) {
        stalled.push(s.sessionId);
      }
    }
    return stalled;
  }

  // ── 流恢复协议（snapshot + read-run-events） ────────────

  /**
   * 恢复指定 session 的流：
   *
   * 1. 查询 get-run-snapshot 获取 run 远端状态
   * 2. 若 running → read-run-events 分页拉取缺失事件 → 过滤 + 排序 → dispatch replay
   * 3. 若 completed → markCompleted
   * 4. 若 failed/cancelled/error → markFailed
   *
   * @returns true 表示流已恢复或已正常终态；false 表示恢复失败
   */
  async recoverStream(sessionId: string): Promise<boolean> {
    const s = this.streams.get(sessionId);
    if (!s) return false;

    // Terminal 流不需要恢复
    if (s.status === 'completed') return true;
    if (s.status === 'failed') return false;

    const client = getDesktopDaemonClient();
    const afterSequence = s.lastSequenceNumber;

    try {
      // 1. 查询 run snapshot
      const snapRes = await client.request(
        { type: 'get-run-snapshot', runId: s.runId, sessionId },
        'run-snapshot',
        RECOVERY_TIMEOUT_MS,
      );
      const snapBody = snapRes as Record<string, unknown>;
      const snap = snapBody.snapshot as Record<string, unknown> | undefined;
      const remoteStatus = String(snap?.status ?? 'unknown');

      if (remoteStatus !== 'running') {
        // 远端已终态：映射到本地 terminal
        if (remoteStatus === 'completed') {
          this.markCompleted(sessionId);
          return true;
        }
        if (
          remoteStatus === 'failed' ||
          remoteStatus === 'error' ||
          remoteStatus === 'cancelled'
        ) {
          this.markFailed(sessionId, String(snap?.error ?? remoteStatus));
          return false;
        }
        // 未知状态：防御性标记为 failed
        this.markFailed(sessionId, `unknown remote status: ${remoteStatus}`);
        return false;
      }

      // 2. Running：分页拉取缺失事件
      let currentAfter = afterSequence;
      let finalNextAfter = afterSequence;
      const collected: unknown[] = [];
      let iterations = 0;

      while (iterations < MAX_RECOVERY_ITERATIONS) {
        iterations++;
        const eventsRes = await client.request(
          {
            type: 'read-run-events',
            runId: s.runId,
            sessionId,
            afterSequence: currentAfter,
          },
          'run-events',
          RECOVERY_TIMEOUT_MS,
        );
        const eventsBody = eventsRes as Record<string, unknown>;
        const batchEvents = (eventsBody.events as unknown[]) ?? [];
        const nextAfter =
          typeof eventsBody.nextAfterSequence === 'number'
            ? eventsBody.nextAfterSequence
            : currentAfter;
        const hasMore = eventsBody.hasMore === true;

        // 过滤：只保留 seq > afterSequence（防御 daemon 返回重复事件）
        const fresh = batchEvents.filter((e) => {
          const seq = extractEventSequence(e);
          return seq == null || seq > afterSequence;
        });
        collected.push(...fresh);

        if (nextAfter > finalNextAfter) finalNextAfter = nextAfter;

        if (!hasMore || nextAfter <= currentAfter) break;
        currentAfter = nextAfter;
      }

      // 3. 排序（daemon 可能乱序返回）
      const sorted = collected.sort((a, b) => {
        const sa = extractEventSequence(a) ?? 0;
        const sb = extractEventSequence(b) ?? 0;
        return sa - sb;
      });

      // 4. Dispatch replay（即使 sorted 为空也 dispatch，让 handler 同步游标）
      this.dispatchReplay(sessionId, {
        sessionId,
        runId: s.runId,
        events: sorted,
        afterSequence,
        nextAfterSequence: finalNextAfter,
        hasMore: false,
      });

      // 5. 更新本地游标（防御：handler 可能不回写 setLastSequence）
      if (finalNextAfter > s.lastSequenceNumber) {
        s.lastSequenceNumber = finalNextAfter;
      }

      // 6. 恢复为 streaming（terminal 检查防御并发 markCompleted/markFailed）
      if (!this.isTerminal(s)) {
        s.status = 'streaming';
      }
      eventBus.emit(
        'stream:resumed',
        { sessionId, runId: s.runId, lastSequenceNumber: s.lastSequenceNumber },
        'daemon',
      );
      return true;
    } catch (e) {
      // 恢复失败：标记为 paused（下次扫描可重试）
      if (this.isTerminal(s)) {
        return s.status === 'completed';
      }
      s.status = 'paused';
      eventBus.emit(
        'stream:paused',
        { sessionId, runId: s.runId, error: String(e) },
        'daemon',
      );
      return false;
    }
  }

  /**
   * 恢复所有活跃流（status=streaming 或 paused）。
   * 并行调用 recoverStream，返回成功恢复的数量。
   */
  async recoverAllStreams(): Promise<number> {
    const active = [...this.streams.values()].filter(
      (s) => s.status === 'streaming' || s.status === 'paused',
    );
    if (active.length === 0) return 0;

    const results = await Promise.allSettled(
      active.map((s) => this.recoverStream(s.sessionId)),
    );
    return results.filter(
      (r): r is PromiseFulfilledResult<boolean> =>
        r.status === 'fulfilled' && r.value === true,
    ).length;
  }

  // ── Replay handler 注册与派发 ───────────────────────────

  /**
   * 注册 / 清除指定 session 的重放事件处理器。
   * handler 为 null 时清除已注册的处理器。
   */
  setReplayHandler(
    sessionId: string,
    handler: ((payload: ReplayPayload) => void) | null,
  ): void {
    if (handler === null) {
      this.replayHandlers.delete(sessionId);
    } else {
      this.replayHandlers.set(sessionId, handler);
    }
  }

  /**
   * 触发指定 session 的重播处理器（供 recoverStream 内部调用）。
   */
  dispatchReplay(sessionId: string, payload: ReplayPayload): void {
    const handler = this.replayHandlers.get(sessionId);
    if (handler) handler(payload);
  }

  // ── 背压管理 ──────────────────────────────────────────

  /**
   * 上报 render buffer 当前字节数，返回背压信号。
   *
   * - bytes > BACKPRESSURE_HIGH_WATER 且未暂停 → 'pause'（发送 stream-pause）
   * - bytes < BACKPRESSURE_LOW_WATER 且已暂停 → 'resume'（发送 stream-resume）
   * - 其他 → 'none'
   *
   * pause/resume 信号是 fire-and-forget：异步发送，不阻塞渲染。
   */
  noteRenderBuffer(sessionId: string, bytes: number): 'pause' | 'resume' | 'none' {
    const s = this.streams.get(sessionId);
    if (!s) return 'none';
    const bp = this.getBackpressure(sessionId);

    if (bytes > BACKPRESSURE_HIGH_WATER) {
      if (bp.paused) return 'none';
      bp.paused = true;
      void sendStreamPause(s.runId).catch((e) => {
        console.error('[StreamRecovery] stream-pause failed', e);
      });
      eventBus.emit(
        'stream:backpressure',
        { sessionId, action: 'pause', bytes },
        'daemon',
      );
      return 'pause';
    }

    if (bytes < BACKPRESSURE_LOW_WATER) {
      if (!bp.paused) return 'none';
      bp.paused = false;
      void sendStreamResume(s.runId).catch((e) => {
        console.error('[StreamRecovery] stream-resume failed', e);
      });
      eventBus.emit(
        'stream:backpressure',
        { sessionId, action: 'resume', bytes },
        'daemon',
      );
      return 'resume';
    }

    return 'none';
  }

  /** 当前是否处于背压暂停状态 */
  isBackpressurePaused(sessionId: string): boolean {
    return this.backpressure.get(sessionId)?.paused ?? false;
  }

  /**
   * 将 chunk 入队到背压缓冲区（pause 期间不丢失 chunk）。
   * @returns true 表示入队成功；false 表示 session 未注册
   */
  enqueueBackpressureChunk(sessionId: string, chunk: string): boolean {
    if (!this.streams.has(sessionId)) return false;
    const bp = this.getBackpressure(sessionId);
    bp.queue.push(chunk);
    bp.queuedBytes += chunk.length;
    return true;
  }

  /** 当前背压队列中待消费的字节数 */
  pendingBackpressureBytes(sessionId: string): number {
    return this.backpressure.get(sessionId)?.queuedBytes ?? 0;
  }

  /**
   * 排空背压队列，返回所有 chunk（按入队顺序）。
   * 排空后队列清零。
   */
  drainBackpressureChunks(sessionId: string): string[] {
    const bp = this.backpressure.get(sessionId);
    if (!bp) return [];
    const chunks = bp.queue;
    bp.queue = [];
    bp.queuedBytes = 0;
    return chunks;
  }

  private getBackpressure(sessionId: string): BackpressureState {
    let bp = this.backpressure.get(sessionId);
    if (!bp) {
      bp = { paused: false, queue: [], queuedBytes: 0 };
      this.backpressure.set(sessionId, bp);
    }
    return bp;
  }

  // ── 清理 ──────────────────────────────────────────────

  clearSession(sessionId: string): void {
    if (this.streams.delete(sessionId)) {
      eventBus.emit('stream:cleared', { sessionId }, 'daemon');
    }
    this.replayHandlers.delete(sessionId);
    this.backpressure.delete(sessionId);
    if (this.streams.size === 0) this.stopScanning();
  }

  clearAll(): void {
    this.streams.clear();
    this.replayHandlers.clear();
    this.backpressure.clear();
    this.stopScanning();
    eventBus.emit('stream:all-cleared', null, 'daemon');
  }

  // ── 扫描定时器 ─────────────────────────────────────────

  private ensureScanning(): void {
    if (this.started) return;
    this.started = true;
    this.scanTimer = setInterval(() => {
      const stalled = this.detectStalledStreams();
      if (stalled.length === 0) return;
      eventBus.emit('stream:stalled', stalled, 'daemon');
      for (const sessionId of stalled) {
        const s = this.streams.get(sessionId);
        if (!s || s.status !== 'streaming') continue;
        s.status = 'paused';
        eventBus.emit(
          'stream:paused',
          { sessionId, runId: s.runId, reason: 'stalled' },
          'daemon',
        );
      }
    }, SCAN_INTERVAL_MS);
  }

  private stopScanning(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    this.started = false;
  }
}

// ---- Singleton ----

export const streamRecovery = new StreamRecovery();
