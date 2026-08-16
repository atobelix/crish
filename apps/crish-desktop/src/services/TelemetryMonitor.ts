import { invokeResult } from '../api/tauriInvoke';
import { getWorkspacePath } from '../api/workspaceFsApi';
import { logInternalError } from '../api/userFacingErrors';
import { errorStore } from './ErrorStore';

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
  // 日志文件仅存文件名常量；完整路径在 flush 时按当前工作区派生（随工作区切换自然更新）
  private logFileName: string = 'telemetry_runtime.jsonl';

  private constructor() {
    if (
      typeof window !== 'undefined' &&
      typeof window.setInterval === 'function'
    ) {
      this.flushInterval = window.setInterval(() => this.flush(), 5000);
    }

    // Listen for uncaught global errors
    if (
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function'
    ) {
      // T5-4：全局错误双写——JSONL 落盘（既有 logError）+ errorStore
      // 非阻塞全局错误槽位（GlobalErrorBanner 消费；React 渲染树之外的
      // 模块级异常也可见可 dismiss）
      this.errorHandler = (e: ErrorEvent) => {
        this.logError(e.error ?? e.message);
        this.reportGlobalError(e.error ?? e.message);
      };
      this.rejectionHandler = (e: PromiseRejectionEvent) => {
        this.logError(e.reason);
        this.reportGlobalError(e.reason);
      };
      window.addEventListener('error', this.errorHandler);
      window.addEventListener('unhandledrejection', this.rejectionHandler);
    }
  }

  /**
   * T5-4：全局错误双写 errorStore（GLOBAL_UNCAUGHT_ERROR 槽位；同 code
   * 自动合并更新 timestamp——连续多次未预期错误只占一条活跃错误）。
   * 上报失败不递归（catch 兜底）。
   */
  private reportGlobalError(error: unknown): void {
    try {
      const technical =
        error instanceof Error
          ? error.stack || error.message || String(error)
          : String(error);
      errorStore.push({
        code: 'GLOBAL_UNCAUGHT_ERROR',
        module: 'TelemetryMonitor',
        severity: 'error',
        message: '发生一次未预期的错误',
        ...(technical ? { technical } : {}),
      });
    } catch {
      /* 上报失败不阻断全局错误处理 */
    }
  }

  dispose(): void {
    this._disposed = true;
    if (this.flushInterval !== null) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    if (typeof window !== 'undefined') {
      if (this.errorHandler)
        window.removeEventListener('error', this.errorHandler);
      if (this.rejectionHandler)
        window.removeEventListener('unhandledrejection', this.rejectionHandler);
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
  logAction(
    actionName: string,
    durationMs: number,
    sessionId?: string,
    context?: unknown
  ) {
    const entry: TelemetryLog = {
      timestamp: Date.now(),
      type: 'action',
      actionName,
      durationMs,
      sessionId,
      context,
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
      errorStack:
        error instanceof Error ? error.stack || String(error) : String(error),
      sessionId,
      context,
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
      const root = getWorkspacePath()?.trim();
      // 相对路径由 Rust 侧按 workspace_root 解析；无工作区时传 undefined → for_default_workspace 兜底
      const logFilePath = root
        ? `${root}/logs/${this.logFileName}`
        : `logs/${this.logFileName}`;
      const result = await invokeResult('core_jsonl_append', {
        path: logFilePath,
        lines: linesToFlush,
        flush: true,
        workspaceRoot: root || undefined,
      });
      if (result.status !== 'ok') {
        this.buffer.unshift(...linesToFlush);
        if (this.buffer.length > 1000) {
          this.buffer = this.buffer.slice(0, 1000);
        }
        if (result.status === 'error') {
          console.error(
            'Failed to flush telemetry logs to native host:',
            result.message
          );
        } else if (result.status === 'missing') {
          // missing 不再静默：接线后此分支出现即代表 Rust 侧命令未注册
          if (
            typeof process === 'undefined' ||
            process.env.NODE_ENV !== 'test'
          ) {
            logInternalError(
              '[telemetry] core_jsonl_append missing — telemetry 落盘未生效',
              {
                path: logFilePath,
              }
            );
          }
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
