export type TelemetryLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TelemetryEntry {
  id: string;
  timestamp: number;
  level: TelemetryLevel;
  module: string;
  message: string;
  data?: Record<string, unknown> | undefined;
  error?: { message: string; stack?: string; code?: string } | undefined;
  sessionId?: string | undefined;
}

const MAX_BUFFER = 1000;
const STORAGE_KEY = 'crish_telemetry_log';

export class TelemetryService {
  private buffer: TelemetryEntry[] = [];
  private sessionId: string;
  private enabled = true;

  constructor() {
    this.sessionId = this.generateSessionId();
    this.loadPersisted();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 静默发送崩溃/异常诊断报告；当前环境无远端接收器时以自定义事件暴露 */
  sendReport(): void {
    if (!this.enabled) return;
    const payload = {
      sessionId: this.sessionId,
      timestamp: Date.now(),
      context: this.captureContext(),
      entries: this.buffer.slice(),
    };
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('crish-crash-report', { detail: payload }));
    }
    console.info('[crish] crash telemetry report dispatched silently', payload.context);
    // 发送后清空旧日志，避免下次启动重复上报
    this.clear();
  }

  private generateSessionId(): string {
    try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
  }

  private loadPersisted(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.buffer = JSON.parse(raw);
    } catch { /* ignore corrupt data */ }
  }

  private persist(): void {
    try {
      const tail = this.buffer.slice(-200);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tail));
    } catch { /* storage full */ }
  }

  log(level: TelemetryLevel, module: string, message: string, data?: Record<string, unknown>): void {
    if (!this.enabled) return;
    // 治理防线 #2（exactOptionalPropertyTypes）：data?: Record<string, unknown>
    // 不接受 undefined 值，必须用条件展开剔除 undefined 键
    const entry: TelemetryEntry = {
      id: this.generateEntryId(),
      timestamp: performance.now(),
      level,
      module,
      message,
      ...(data !== undefined ? { data } : {}),
      sessionId: this.sessionId,
    };
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
    this.persist();
  }

  debug(module: string, message: string, data?: Record<string, unknown>): void {
    this.log('debug', module, message, data);
  }
  info(module: string, message: string, data?: Record<string, unknown>): void {
    this.log('info', module, message, data);
  }
  warn(module: string, message: string, data?: Record<string, unknown>): void {
    this.log('warn', module, message, data);
  }
  error(module: string, message: string, error?: Error, data?: Record<string, unknown>): void {
    this.log('error', module, message, {
      ...data,
      error: error
        ? { message: error.message, stack: error.stack, code: 'code' in error ? (error as { code?: unknown }).code : undefined }
        : undefined,
    });
  }

  captureContext(): Record<string, unknown> {
    return {
      timestamp: Date.now(),
      sessionId: this.sessionId,
      url: typeof window !== 'undefined' ? window.location.href : '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      recentEntries: this.buffer.slice(-50),
    };
  }

  exportLog(): Blob {
    const context = this.captureContext();
    const payload = JSON.stringify({ context, entries: this.buffer }, null, 2);
    return new Blob([payload], { type: 'application/json' });
  }

  downloadLog(filename?: string): void {
    const blob = this.exportLog();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename ?? `crish-telemetry-${new Date().toISOString().slice(0, 19)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  clear(): void {
    this.buffer = [];
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
  }

  getEntries(): TelemetryEntry[] {
    return this.buffer;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Check if previous session had error entries (indicates possible crash) */
  hasPreviousCrash(): boolean {
    return this.buffer.some(e => e.level === 'error');
  }

  private generateEntryId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }
}

export const telemetry = new TelemetryService();
