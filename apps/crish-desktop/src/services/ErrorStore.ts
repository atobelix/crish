/**
 * ErrorStore —— 错误状态管理 Store
 *
 * 职责：
 * - 集中管理应用内所有错误/异常状态
 * - 提供连接状态和持久化状态的追踪
 * - 支持订阅通知，用于 UI 组件响应式更新
 * - 相同 code 的活跃错误自动合并（更新 timestamp）
 * - 导出单例 errorStore，供全应用共享
 */

import { eventBus } from './EventBus';
import { classifyError } from './FailoverReason';
import { telemetry } from './TelemetryService';
import type { FailoverReason, ClassifiedError } from './FailoverReason';

export type Unsubscribe = () => void;

export interface UiError {
  id: string;
  code: string;
  module: string;
  severity: 'silent' | 'info' | 'warning' | 'error' | 'critical';
  message: string;
  technical?: string;
  timestamp: number;
  resolved: boolean;
  autoResolve?: boolean;
  reason: FailoverReason;
  classified: ClassifiedError;
}

export type ConnectionStatus = 'connected' | 'reconnecting' | 'waiting' | 'disconnected' | 'degraded';

export type PersistenceStatus = 'healthy' | 'warning' | 'critical';

export interface ErrorState {
  activeErrors: UiError[];
  errorHistory: UiError[];
  connectionStatus: ConnectionStatus;
  connectionLastReady: number | null;
  persistenceStatus: PersistenceStatus;
  persistenceQuotaPercent: number;
}

const MAX_HISTORY = 50;

/** 比较两个活跃错误列表是否相等（用于决定是否通知 subscribeActive） */
function activeErrorsEqual(a: UiError[], b: UiError[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    // 治理防线 #3（noUncheckedIndexedAccess）：下标访问返回 T | undefined，
    // 长度已相等且 i < a.length，但 b[i] 仍可能为 undefined（理论上不会，
    // 但需要显式守卫避免在 undefined 上访问属性
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (x.id !== y.id) return false;
    if (x.code !== y.code) return false;
    if (x.severity !== y.severity) return false;
    if (x.message !== y.message) return false;
    if (x.technical !== y.technical) return false;
    if (x.timestamp !== y.timestamp) return false;
    if (x.resolved !== y.resolved) return false;
    if (x.autoResolve !== y.autoResolve) return false;
  }
  return true;
}

/** 从完整错误列表派生活跃错误（resolved === false 且 severity !== 'silent'） */
function deriveActiveErrors(errors: UiError[]): UiError[] {
  return errors.filter((e) => !e.resolved && e.severity !== 'silent');
}

export class ErrorStore {
  private errorHistory: UiError[] = [];
  private activeErrors: UiError[] = [];
  private connectionStatus: ConnectionStatus = 'disconnected';
  private connectionLastReady: number | null = null;
  private persistenceStatus: PersistenceStatus = 'healthy';
  private persistenceQuotaPercent: number = 0;

  private listeners = new Set<(state: ErrorState) => void>();
  private activeListeners = new Set<(errors: UiError[]) => void>();

  private compactHistory(): void {
    const cutoff = Date.now() - 3600000;
    let i = 0;
    while (i < this.errorHistory.length) {
      const entry = this.errorHistory[i]!;
      if (entry.resolved && entry.timestamp < cutoff) {
        this.errorHistory.splice(i, 1);
      } else {
        i++;
      }
    }
  }

  private generateErrorId(): string {
    try {
      return crypto.randomUUID();
    } catch {
      return `${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
    }
  }

  push(error: Omit<UiError, 'id' | 'timestamp' | 'resolved' | 'reason' | 'classified'>): string {
    const existing = this.errorHistory.find(
      (e) => e.code === error.code && !e.resolved && e.severity === error.severity,
    );

    const classified = classifyError(error.code, error.message);

    if (existing) {
      existing.timestamp = Date.now();
      if (error.message) existing.message = error.message;
      if (error.technical !== undefined) existing.technical = error.technical;
      if (error.autoResolve !== undefined) existing.autoResolve = error.autoResolve;
      existing.reason = classified.reason;
      existing.classified = classified;
      this.notifyIfActiveChanged();
      if (this.isToastableSeverity(error.severity)) {
        eventBus.emit('toast:show', existing);
      }
      return existing.id;
    }

    this.compactHistory();
    const id = this.generateErrorId();
    const entry: UiError = {
      id,
      code: error.code,
      module: error.module,
      severity: error.severity,
      message: error.message,
      timestamp: Date.now(),
      resolved: false,
      reason: classified.reason,
      classified,
      ...(error.technical !== undefined ? { technical: error.technical } : {}),
      ...(error.autoResolve !== undefined ? { autoResolve: error.autoResolve } : {}),
    };

    this.errorHistory.push(entry);
    if (this.errorHistory.length > MAX_HISTORY) {
      this.errorHistory.shift();
    }

    telemetry.error(entry.module, entry.message, undefined, {
      code: entry.code, severity: entry.severity, classified: entry.classified,
    });

    this.notifyIfActiveChanged();
    this.notifyAll();

    if (this.isToastableSeverity(error.severity)) {
      eventBus.emit('toast:show', entry);
    }
    return id;
  }

  resolve(id: string): void {
    const entry = this.errorHistory.find((e) => e.id === id);
    if (!entry || entry.resolved) return;

    entry.resolved = true;
    this.notifyIfActiveChanged();
    this.notifyAll();
  }

  /** 按 code 批量解决（用于自动恢复场景） */
  resolveByCode(code: string): void {
    let changed = false;
    for (const e of this.errorHistory) {
      if (e.code === code && !e.resolved) {
        e.resolved = true;
        changed = true;
      }
    }
    if (!changed) return;
    this.notifyIfActiveChanged();
    this.notifyAll();
  }

  /** 按 module 批量解决 */
  resolveByModule(module: string): void {
    let changed = false;
    for (const e of this.errorHistory) {
      if (e.module === module && !e.resolved) {
        e.resolved = true;
        changed = true;
      }
    }
    if (!changed) return;
    this.notifyIfActiveChanged();
    this.notifyAll();
  }

  setConnectionStatus(status: ConnectionStatus): void {
    if (this.connectionStatus === status) return;
    this.connectionStatus = status;
    if (status === 'connected') {
      this.connectionLastReady = Date.now();
    }
    this.notifyAll();
  }

  setPersistenceStatus(status: PersistenceStatus, quotaPercent?: number): void {
    this.persistenceStatus = status;
    if (quotaPercent !== undefined) {
      this.persistenceQuotaPercent = quotaPercent;
    }
    this.notifyAll();
  }

  getState(): ErrorState {
    return {
      activeErrors: this.getActiveErrors(),
      errorHistory: [...this.errorHistory],
      connectionStatus: this.connectionStatus,
      connectionLastReady: this.connectionLastReady,
      persistenceStatus: this.persistenceStatus,
      persistenceQuotaPercent: this.persistenceQuotaPercent,
    };
  }

  getActiveErrors(): UiError[] {
    return deriveActiveErrors(this.errorHistory);
  }

  subscribe(callback: (state: ErrorState) => void): Unsubscribe {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  subscribeActive(callback: (errors: UiError[]) => void): Unsubscribe {
    this.activeListeners.add(callback);
    return () => {
      this.activeListeners.delete(callback);
    };
  }

  private notifyAll(): void {
    const state = this.getState();
    for (const cb of this.listeners) {
      try {
        cb(state);
      } catch (err) {
        console.error('[ErrorStore] subscriber error:', err);
      }
    }
  }

  private isToastableSeverity(severity: UiError['severity']): boolean {
    return severity === 'warning' || severity === 'error' || severity === 'critical';
  }

  private notifyIfActiveChanged(): void {
    const next = deriveActiveErrors(this.errorHistory);
    if (activeErrorsEqual(this.activeErrors, next)) return;
    this.activeErrors = next;
    for (const cb of this.activeListeners) {
      try {
        cb(next);
      } catch (err) {
        console.error('[ErrorStore] active subscriber error:', err);
      }
    }
  }
}

/** 全局单例 */
export const errorStore = new ErrorStore();
