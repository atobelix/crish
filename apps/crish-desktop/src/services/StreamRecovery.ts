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
  error?: string;
}

const STALL_TIMEOUT_MS = 10_000;
const SCAN_INTERVAL_MS = 5_000;
const RECOVERY_TIMEOUT_MS = 8_000;

export class StreamRecovery {
  private streams = new Map<string, InternalStreamState>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

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

  updateHeartbeat(sessionId: string): void {
    const s = this.streams.get(sessionId);
    if (!s) return;
    s.lastMessageTime = Date.now();
    if (s.status === 'paused') {
      s.status = 'streaming';
      eventBus.emit('stream:resumed', { sessionId }, 'daemon');
    }
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
    if (this.streams.size === 0) this.stopScanning();
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
}

export const streamRecovery = new StreamRecovery();
