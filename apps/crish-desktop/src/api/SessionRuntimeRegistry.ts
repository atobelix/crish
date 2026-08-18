/**
 * 按会话隔离的运行时状态容器。
 * 非 Zustand store，使用 Map<string, SessionRuntimeState> 管理。
 *
 * 职责：
 * - diffFiles：按会话隔离的 diff 状态
 * - attachments：按会话隔离的附件
 * - chatMainSurface：主面板视图模式
 * - fileCompareModes：文件对比模式
 * - scrollPosition / lastActivePanelTab：UI 恢复
 */

import type { FileDiff } from '../store/types';
import type { QueuedMessage } from '../hooks/chat-stream/types';

export interface Attachment {
  id: string;
  name: string;
  mime?: string;
  dataUrl?: string;
  text?: string;
  size?: number;
}

/** 按会话隔离的运行时状态 */
export interface SessionRuntimeState {
  sessionId: string;
  diffFiles: FileDiff[];
  chatMainSurface: 'chat' | 'scheduled' | null;
  attachments: Attachment[];
  queuedMessages: QueuedMessage[];
  fileCompareModes: Record<string, 'split' | 'unified'>;
  scrollPosition: number;
  lastActivePanelTab: string | null;
}

class SessionRuntimeRegistry {
  private readonly MAX_SESSIONS = 50;
  private readonly GC_INTERVAL_MS = 120_000;
  private readonly GC_MAX_AGE_MS = 600_000;
  private activeIdResolver?: () => string;

  registerActiveIdResolver(resolver: () => string): void {
    this.activeIdResolver = resolver;
  }

  /** 注销活动会话解析器（T06.9.1：模块级注册补注销，供 bootstrap cleanup / HMR 使用） */
  unregisterActiveIdResolver(): void {
    this.activeIdResolver = undefined;
  }

  private states = new Map<string, SessionRuntimeState>();
  private refCounts = new Map<string, number>();
  private retainTimestamps = new Map<string, number>();
  private accessOrder: string[] = [];
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  get(sessionId: string): SessionRuntimeState {
    let state = this.states.get(sessionId);
    if (!state) {
      if (this.states.size >= this.MAX_SESSIONS) {
        const oldest = this.accessOrder.pop();
        if (oldest) this.remove(oldest);
      }
      state = this.createDefault(sessionId);
      this.states.set(sessionId, state);
    }
    const idx = this.accessOrder.indexOf(sessionId);
    if (idx !== -1) this.accessOrder.splice(idx, 1);
    this.accessOrder.unshift(sessionId);
    return state;
  }

  exists(sessionId: string): boolean {
    return this.states.has(sessionId);
  }

  save(sessionId: string, partial: Partial<SessionRuntimeState>): void {
    const existing = this.get(sessionId);
    Object.assign(existing, partial);
  }

  remove(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state) {
      state.diffFiles = [];
      state.attachments = [];
      state.queuedMessages = [];
      state.fileCompareModes = {};
    }
    this.states.delete(sessionId);
    this.refCounts.delete(sessionId);
    this.retainTimestamps.delete(sessionId);
    const idx = this.accessOrder.indexOf(sessionId);
    if (idx !== -1) this.accessOrder.splice(idx, 1);
  }

  retain(sessionId: string): void {
    this.retainTimestamps.set(sessionId, Date.now());
    this.refCounts.set(sessionId, (this.refCounts.get(sessionId) ?? 0) + 1);
  }

  release(sessionId: string): void {
    const count = this.refCounts.get(sessionId);
    if (count === undefined || count <= 1) {
      this.remove(sessionId);
    } else {
      this.refCounts.set(sessionId, count - 1);
    }
  }

  getActiveState(): SessionRuntimeState | null {
    if (!this.activeIdResolver) return null;
    const activeId = this.activeIdResolver();
    if (!activeId) return null;
    return this.get(activeId);
  }

  clearAll(): void {
    this.states.clear();
    this.refCounts.clear();
    this.retainTimestamps.clear();
    this.accessOrder = [];
  }

  startGC(): void {
    this.stopGC();
    this.gcTimer = setInterval(() => this._collectGarbage(), this.GC_INTERVAL_MS);
    if (typeof this.gcTimer?.unref === 'function') this.gcTimer.unref();
  }

  stopGC(): void {
    if (this.gcTimer !== null) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  garbageCollect(olderThanMs = 300_000): number {
    let collected = 0;
    const now = Date.now();
    for (const [sessionId] of this.states) {
      const refs = this.refCounts.get(sessionId) ?? 0;
      if (refs === 0) {
        const ts = this.retainTimestamps.get(sessionId) ?? 0;
        if (now - ts > olderThanMs) {
          this.remove(sessionId);
          collected++;
        }
      }
    }
    return collected;
  }

  get size(): number {
    return this.states.size;
  }

  private _collectGarbage(): void {
    const cutoff = Date.now() - this.GC_MAX_AGE_MS;
    for (const [sessionId, ts] of this.retainTimestamps) {
      if (ts < cutoff && (this.refCounts.get(sessionId) ?? 0) > 0) {
        this.release(sessionId);
      }
    }
  }

  private createDefault(sessionId: string): SessionRuntimeState {
    return {
      sessionId,
      diffFiles: [],
      chatMainSurface: null,
      attachments: [],
      queuedMessages: [],
      fileCompareModes: {},
      scrollPosition: 0,
      lastActivePanelTab: null,
    };
  }
}

/** 全局单例 */
export const sessionRuntimeRegistry = new SessionRuntimeRegistry();
