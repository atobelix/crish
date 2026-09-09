/**
 * 按会话隔离的运行时状态容器。
 * 非 Zustand store，使用 Map<string, SessionRuntimeState> 管理。
 *
 * 职责：
 * - diffFiles：按会话隔离的 diff 状态
 * - attachments：按会话隔离的附件
 * - thinkingTitle：本会话思考档位 Title（yaml 字典 key）；不进 yaml / SessionState
 * - chatMainSurface：主面板视图模式
 * - fileCompareModes：文件对比模式
 * - scrollPosition / lastActivePanelTab：UI 恢复
 */

import type { FileDiff } from '../store/types';
import type { QueuedMessage } from '../hooks/chat-stream/types';
import { emitUiEvent } from './uiEvents';

export interface Attachment {
  id: string;
  name: string;
  path?: string;
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
  /**
   * 本会话选中的思考档位 Title（yaml `thinking` 字典 key）。
   * 与 attachments 同级；不进 yaml、不进 SessionState 消息库。
   * `null` = 未选 / 切到非思考模型已清空。
   */
  thinkingTitle?: string | null;
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
      state.thinkingTitle = null;
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
      thinkingTitle: null,
    };
  }
}

/** 全局单例 */
export const sessionRuntimeRegistry = new SessionRuntimeRegistry();

/**
 * 写入本会话思考档位 Title。只碰 runtime，不写 yaml / SessionState。
 * 空 sessionId 为 no-op，避免落幽灵槽。
 * 写入后广播 `thinking-title-changed`，Picker 与 Composer 胶囊订阅同步。
 */
export function setSessionThinkingTitle(
  sessionId: string,
  title: string | null,
): void {
  if (!sessionId) return;
  sessionRuntimeRegistry.save(sessionId, { thinkingTitle: title });
  emitUiEvent('thinking-title-changed', { sessionId });
}

/**
 * 读取本会话思考档位 Title。未创建 runtime 或空 sessionId → `null`。
 * 只读已有槽，不因查询新建/挤出其它会话。
 */
export function getSessionThinkingTitle(sessionId: string): string | null {
  if (!sessionId) return null;
  if (!sessionRuntimeRegistry.exists(sessionId)) return null;
  return sessionRuntimeRegistry.get(sessionId).thinkingTitle ?? null;
}

// ── 跨会话、按模型持久化的思考档位（localStorage） ───────────────────────────

/** localStorage 键名：按提供者 + 模型 ID 存档用户选择的思考强度 */
function modelThinkingPrefKey(providerId: string, modelId: string): string {
  return `conex:model-thinking-pref:${providerId}:${modelId}`;
}

/**
 * 持久化用户为某模型选择的思考档位 Title 到 localStorage。
 * 跨会话保留，下次打开同模型时恢复。
 */
export function saveModelThinkingPref(
  providerId: string,
  modelId: string,
  title: string | null,
): void {
  if (!providerId || !modelId) return;
  try {
    const key = modelThinkingPrefKey(providerId, modelId);
    if (title == null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, title);
    }
  } catch {
    // localStorage 不可用时静默跳过
  }
}

/**
 * 读取用户为某模型选择的思考档位 Title（来自 localStorage）。
 * 未存档 → `null`。
 */
export function loadModelThinkingPref(
  providerId: string,
  modelId: string,
): string | null {
  if (!providerId || !modelId) return null;
  try {
    return localStorage.getItem(modelThinkingPrefKey(providerId, modelId));
  } catch {
    return null;
  }
}
