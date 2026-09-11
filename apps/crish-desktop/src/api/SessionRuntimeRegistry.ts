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
  /**
   * 本会话上一轮真实发送时的上下文状态签名（模型+服务商+权限+思考档位快照）。
   * 仅用于发送比对：若用户切出去又切回相同状态，或连续多轮未换模型，则不弹出居中切换提示。
   */
  lastSentContextSignature?: string | null;
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
      state.lastSentContextSignature = null;
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

/**
 * 记录本会话上一轮真实发送时的上下文状态签名。
 */
export function setLastSentContextSignature(
  sessionId: string,
  signature: string | null,
): void {
  if (!sessionId) return;
  sessionRuntimeRegistry.save(sessionId, { lastSentContextSignature: signature });
}

/**
 * 读取本会话上一轮真实发送时的上下文状态签名。未记录返回 null。
 */
export function getLastSentContextSignature(sessionId: string): string | null {
  if (!sessionId) return null;
  if (!sessionRuntimeRegistry.exists(sessionId)) return null;
  return sessionRuntimeRegistry.get(sessionId).lastSentContextSignature ?? null;
}

// ── 跨会话、按模型持久化的思考档位（localStorage） ───────────────────────────

/** localStorage 键名：按提供者 + 模型 ID 存档用户选择的思考强度 */
function modelThinkingPrefKey(providerId: string, modelId: string): string {
  return `conex:model-thinking-pref:${providerId}:${modelId}`;
}

/** 全局最近一次选中的思考强度偏好 */
const GLOBAL_THINKING_PREF_KEY = 'conex:global-thinking-pref';

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

/** 保存全局最近一次选中的思考强度偏好 */
export function saveGlobalThinkingPref(title: string | null): void {
  try {
    if (title == null) {
      localStorage.removeItem(GLOBAL_THINKING_PREF_KEY);
    } else {
      localStorage.setItem(GLOBAL_THINKING_PREF_KEY, title);
    }
  } catch {
    // localStorage 不可用时静默跳过
  }
}

/** 读取全局最近一次选中的思考强度偏好 */
export function loadGlobalThinkingPref(): string | null {
  try {
    return localStorage.getItem(GLOBAL_THINKING_PREF_KEY);
  } catch {
    return null;
  }
}

/**
 * 统一解析生效的思考档位（SSOT 单一真理源）：
 * 优先级 1: 当前会话显式设定的 thinkingTitle（会话临时覆盖）
 * 优先级 2: 该模型本地持久化保存的思考强度（跨会话记忆，用户设置绝对优先）
 * 优先级 3: 用户最近一次全局设定的思考强度（跨模型继承意图）
 * 未命中返回 null，交由 resolveThinkingHandoff 稳态计算。
 */
export function resolveEffectiveThinkingTitle(
  sessionId?: string | null,
  providerId?: string | null,
  modelId?: string | null,
): string | null {
  const p = (providerId || '').trim();
  const m = (modelId || '').trim();
  const s = (sessionId || '').trim();

  // 1. 会话临时覆盖
  if (s) {
    const sessionVal = getSessionThinkingTitle(s);
    if (sessionVal != null && sessionVal.trim() !== '') {
      return sessionVal.trim();
    }
  }

  // 2. 该模型历史持久化偏好（用户设置绝对优先）
  if (p && m) {
    const modelPref = loadModelThinkingPref(p, m);
    if (modelPref != null && modelPref.trim() !== '') {
      return modelPref.trim();
    }
  }

  // 3. 用户最近一次全局思考偏好（例如刚在另一个模型选了 High，切换过来优先继承 High）
  const globalPref = loadGlobalThinkingPref();
  if (globalPref != null && globalPref.trim() !== '') {
    return globalPref.trim();
  }

  return null;
}

/**
 * 统一持久化思考档位选择：
 * 同时写入会话运行时、模型持久化存储与全局偏好，确保跨会话、重启后用户设置永不丢失。
 */
export function persistThinkingSelection(
  sessionId: string | null | undefined,
  providerId: string | null | undefined,
  modelId: string | null | undefined,
  title: string | null,
): void {
  const p = (providerId || '').trim();
  const m = (modelId || '').trim();
  const s = (sessionId || '').trim();

  if (s) {
    setSessionThinkingTitle(s, title);
  }
  if (p && m) {
    saveModelThinkingPref(p, m, title);
  }
  saveGlobalThinkingPref(title);
}
