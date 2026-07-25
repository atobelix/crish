/**
 * StreamRecovery —— 流恢复协议
 *
 * 职责：
 * - 追踪活跃的 SSE/WebSocket 流状态
 * - 定时扫描卡住流（超过 10s 无数据标记为 SUSPECT → paused）
 * - 查询引擎 run 状态，按结果恢复/终止/续接流
 * - 通过 eventBus 发布流状态变更事件
 * - 导出单例 streamRecovery，供全应用共享
 */

import { getDesktopDaemonClient } from '../api/daemonClient';
import { eventBus } from './EventBus';

export interface StreamState {
  sessionId: string;
  runId: string;
  status: 'streaming' | 'paused' | 'completed' | 'failed';
  lastMessageTime: number;
  lastSequenceNumber: number;
  receivedBytes: number;
}

interface InternalStreamState extends StreamState {
  error?: string | undefined;
}

const STALL_TIMEOUT_MS = 10_000;
const SCAN_INTERVAL_MS = 5_000;
const RECOVERY_TIMEOUT_MS = 8_000;

export class StreamRecovery {
  private streams = new Map<string, InternalStreamState>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private replayHandlers = new Map<string, ((payload: ReplayPayload) => void) | null>();

  registerStream(sessionId: string, runId: string): void {
    const existing = this.streams.get(sessionId);
    if (existing) {
      existing.runId = runId;
      existing.status = 'streaming';
      existing.lastMessageTime = Date.now();
      existing.error = undefined;
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

  getStream(sessionId: string): StreamState | undefined {
    return this.streams.get(sessionId);
  }

  /** 记录渲染缓冲区大小（供背压观察用），当前为简化版留空 */
  noteRenderBuffer(_sessionId: string, _bytes: number): void {
    // 无背压逻辑；简化版 StreamRecovery 不实现 buffer 层
  }

  markCompleted(sessionId: string): void {
    const s = this.streams.get(sessionId);
    if (!s) return;
    s.status = 'completed';
    eventBus.emit('stream:completed', { sessionId }, 'daemon');
  }

  markFailed(sessionId: string, error: string): void {
    const s = this.streams.get(sessionId);
    if (!s) return;
    s.status = 'failed';
    s.error = error;
    eventBus.emit('stream:failed', { sessionId, error }, 'daemon');
  }

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

  async recoverStream(sessionId: string): Promise<boolean> {
    const s = this.streams.get(sessionId);
    if (!s) return false;

    const client = getDesktopDaemonClient();
    try {
      const res = (await client.request(
        { type: 'get-run-status', runId: s.runId, sessionId },
        'run-status-response',
        RECOVERY_TIMEOUT_MS,
      )) as Record<string, unknown>;

      const remoteStatus = String(res.status ?? 'unknown');

      switch (remoteStatus) {
        case 'running':
          s.status = 'paused';
          eventBus.emit('stream:paused', { sessionId, runId: s.runId, lastSequenceNumber: s.lastSequenceNumber }, 'daemon');
          return true;
        case 'completed':
          s.status = 'completed';
          eventBus.emit('stream:completed', { sessionId, runId: s.runId }, 'daemon');
          return true;
        case 'failed':
        case 'error':
        case 'cancelled':
          s.status = 'failed';
          s.error = String(res.error ?? remoteStatus);
          eventBus.emit('stream:failed', { sessionId, runId: s.runId, error: s.error }, 'daemon');
          return false;
        default:
          s.status = 'failed';
          s.error = `unknown remote status: ${remoteStatus}`;
          eventBus.emit('stream:failed', { sessionId, runId: s.runId, error: s.error }, 'daemon');
          return false;
      }
    } catch (e) {
      s.status = 'paused';
      eventBus.emit('stream:paused', { sessionId, runId: s.runId, error: String(e) }, 'daemon');
      return false;
    }
  }

  async recoverAllStreams(): Promise<number> {
    const active = [...this.streams.values()].filter(
      (s) => s.status === 'streaming' || s.status === 'paused',
    );
    if (active.length === 0) return 0;

    const client = getDesktopDaemonClient();
    try {
      const sessionIds = active.map((s) => s.sessionId);
      const runIds = active.map((s) => s.runId);
      const res = (await client.request(
        { type: 'batch-run-status', sessions: sessionIds, runIds },
        'batch-run-status-response',
        RECOVERY_TIMEOUT_MS,
      )) as Record<string, unknown>;

      const statusMap = (res.statuses ?? res.runs ?? []) as Array<Record<string, unknown>>;
      let recovered = 0;

      for (const entry of statusMap) {
        const sid = String(entry.sessionId ?? entry.session_id ?? '');
        const rs = String(entry.status ?? 'unknown');
        const s = sid ? this.streams.get(sid) : null;
        if (!s) continue;

        switch (rs) {
          case 'running':
            s.status = 'paused';
            eventBus.emit('stream:paused', { sessionId: sid, runId: s.runId, lastSequenceNumber: s.lastSequenceNumber }, 'daemon');
            recovered++;
            break;
          case 'completed':
            s.status = 'completed';
            eventBus.emit('stream:completed', { sessionId: sid, runId: s.runId }, 'daemon');
            recovered++;
            break;
          case 'failed':
          case 'error':
          case 'cancelled':
            s.status = 'failed';
            s.error = String(entry.error ?? rs);
            eventBus.emit('stream:failed', { sessionId: sid, runId: s.runId, error: s.error }, 'daemon');
            break;
          default:
            s.status = 'failed';
            s.error = `unknown remote status: ${rs}`;
            eventBus.emit('stream:failed', { sessionId: sid, runId: s.runId, error: s.error }, 'daemon');
            break;
        }
      }

      const covered = new Set(statusMap.map((e) => String(e.sessionId ?? e.session_id ?? '')));
      for (const s of active) {
        if (!covered.has(s.sessionId)) {
          if (await this.recoverStream(s.sessionId)) recovered++;
        }
      }

      return recovered;
    } catch {
      let recovered = 0;
      for (const s of active) {
        if (await this.recoverStream(s.sessionId)) recovered++;
      }
      return recovered;
    }
  }

  getActiveStreams(): StreamState[] {
    return [...this.streams.values()].map((s) => ({
      sessionId: s.sessionId,
      runId: s.runId,
      status: s.status,
      lastMessageTime: s.lastMessageTime,
      lastSequenceNumber: s.lastSequenceNumber,
      receivedBytes: s.receivedBytes,
    }));
  }

  clearSession(sessionId: string): void {
    if (this.streams.delete(sessionId)) {
      eventBus.emit('stream:cleared', { sessionId }, 'daemon');
    }
    this.replayHandlers.delete(sessionId);
    if (this.streams.size === 0) this.stopScanning();
  }

  /**
   * 更新指定 session 的最后一个已应用序列号，供流恢复时请求续接点使用。
   */
  setLastSequence(sessionId: string, sequence: number): void {
    const s = this.streams.get(sessionId);
    if (s && sequence > s.lastSequenceNumber) {
      s.lastSequenceNumber = sequence;
    }
  }

  /**
   * 注册 / 清除指定 session 的重播事件处理器。
   * handler 为 null 时清除已注册的处理器。
   */
  setReplayHandler(sessionId: string, handler: ((payload: ReplayPayload) => void) | null): void {
    if (handler === null) {
      this.replayHandlers.delete(sessionId);
    } else {
      this.replayHandlers.set(sessionId, handler);
    }
  }

  /**
   * 触发指定 session 的重播处理器（供内部流恢复逻辑调用）。
   */
  dispatchReplay(sessionId: string, payload: ReplayPayload): void {
    const handler = this.replayHandlers.get(sessionId);
    if (handler) handler(payload);
  }


  clearAll(): void {
    this.streams.clear();
    this.stopScanning();
    eventBus.emit('stream:all-cleared', null, 'daemon');
  }

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
        eventBus.emit('stream:paused', { sessionId, runId: s.runId, reason: 'stalled' }, 'daemon');
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

  // (backpressure queue: 已在重构中移除。旧版 backpressure 逻辑请参考 git history)
}

// ---- Helper types ----
export interface ReplayEvent {
  sequence: number;
  type: string;
  [key: string]: unknown;
}

export type ReplayPayload = Record<string, unknown>;

// ---- Helper functions (restored for API compatibility) ----

export function extractEventSequence(obj: unknown): number | null {
  if (!obj || typeof obj !== 'object') return null;
  const r = obj as Record<string, unknown>;
  if (typeof r.sequence === 'number') return r.sequence;
  if (typeof r.eventSequence === 'number') return r.eventSequence;
  if (typeof r.seq === 'number') return r.seq;
  return null;
}

export function orchestratorEventToAgentEvent(
  event: unknown,
): Record<string, unknown> | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const ev = event as Record<string, unknown>;
  const type = ev.type as string | undefined;
  if (!type) return null;
  if (type === 'runtime-event') {
    return { ...(ev.payload as Record<string, unknown> ?? {}), type: 'message-delta' };
  }
  if (type === 'run-completed') {
    return { type: 'run-terminal', terminal: 'completed', runId: ev.runId };
  }
  if (type === 'run-failed' || type === 'run-cancelled') {
    return { type: 'run-terminal', terminal: type.replace('run-', ''), runId: ev.runId };
  }
  return ev;
}

export function projectAssistantTextFromEvents(events: unknown[]): string {
  let text = '';
  for (const item of events) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const ev = item as Record<string, unknown>;
    const payload = ev.payload as Record<string, unknown> | undefined;
    if (payload?.text && typeof payload.text === 'string') {
      text += payload.text;
    }
  }
  return text;
}

export function suffixDelta(existing: string, delta: string): string {
  if (delta.startsWith(existing)) return delta.slice(existing.length);
  return delta;
}

export const streamRecovery = new StreamRecovery();
