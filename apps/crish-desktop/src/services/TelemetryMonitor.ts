import { invokeResult } from '../api/tauriInvoke';

export interface TelemetryLog {
  timestamp: number;
  type: 'action' | 'error';
  actionName?: string | undefined;
  durationMs?: number | undefined;
  sessionId?: string | undefined;
  errorStack?: string | undefined;
  context?: unknown;
}

class TelemetryMonitor {
  private static instance: TelemetryMonitor;
  private buffer: string[] = [];
  private flushInterval: number | null = null;
  private _disposed = false;
  private errorHandler: ((e: ErrorEvent) => void) | null = null;
  private rejectionHandler: ((e: PromiseRejectionEvent) => void) | null = null;
  // Use absolute path for local disk storage mapped to workspace
  private logFilePath: string = 'c:/Software/conex/apps/crish-desktop/logs/telemetry_runtime.jsonl';

  private constructor() {
    if (typeof window !== 'undefined' && typeof window.setInterval === 'function') {
      this.flushInterval = window.setInterval(() => this.flush(), 5000);
    }
    
    // Listen for uncaught global errors
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.errorHandler = (e: ErrorEvent) => { this.logError(e.error); };
      this.rejectionHandler = (e: PromiseRejectionEvent) => { this.logError(e.reason); };
      window.addEventListener('error', this.errorHandler);
      window.addEventListener('unhandledrejection', this.rejectionHandler);
    }
  }

  dispose(): void {
    this._disposed = true;
    if (this.flushInterval !== null) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    if (typeof window !== 'undefined') {
      if (this.errorHandler) window.removeEventListener('error', this.errorHandler);
      if (this.rejectionHandler) window.removeEventListener('unhandledrejection', this.rejectionHandler);
    }
    this.errorHandler = null;
    this.rejectionHandler = null;
    this.buffer = [];
  }

  static getInstance(): TelemetryMonitor {
    if (!this.instance) {
      this.instance = new TelemetryMonitor();
    }
    return this.instance;
  }

  /**
   * Log a timing metric for an action
   */
  logAction(actionName: string, durationMs: number, sessionId?: string, context?: unknown) {
    const entry: TelemetryLog = {
      timestamp: Date.now(),
      type: 'action',
      actionName,
      durationMs,
      sessionId,
      context
    };
    this.buffer.push(JSON.stringify(entry));
    if (this.buffer.length > 1000) {
      this.buffer.shift();
    }
    if (this.buffer.length >= 10) {
      this.flush();
    }
  }

  /**
   * Log a lossless error with stack and context
   */
  logError(error: unknown, sessionId?: string, context?: unknown) {
    const entry: TelemetryLog = {
      timestamp: Date.now(),
      type: 'error',
      errorStack: error instanceof Error ? error.stack || String(error) : String(error),
      sessionId,
      context
    };
    this.buffer.push(JSON.stringify(entry));
    if (this.buffer.length > 1000) {
      this.buffer.shift();
    }
    this.flush(); // Errors should be flushed immediately
  }

  private async flush() {
    if (this.buffer.length === 0) return;
    const linesToFlush = [...this.buffer];
    this.buffer = [];
    try {
      const result = await invokeResult('perf_jsonl_append', {
        path: this.logFilePath,
        lines: linesToFlush,
        flush: true,
        workspaceRoot: 'c:/Software/conex'
      });
      if (result.status !== 'ok') {
        this.buffer.unshift(...linesToFlush);
        if (this.buffer.length > 1000) {
          this.buffer = this.buffer.slice(0, 1000);
        }
        if (result.status === 'error') {
          console.error('Failed to flush telemetry logs to native host:', result.message);
        }
      }
    } catch (err) {
      if (typeof process === 'undefined' || process.env.NODE_ENV !== 'test') {
        console.error('Failed to flush telemetry logs to native host:', err);
      }
      this.buffer.unshift(...linesToFlush);
      if (this.buffer.length > 1000) {
        this.buffer = this.buffer.slice(0, 1000);
      }
    }
  }
}

export const telemetryMonitor = TelemetryMonitor.getInstance();
