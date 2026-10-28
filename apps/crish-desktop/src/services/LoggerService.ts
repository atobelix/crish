import { RingBuffer, redactDeep, redactSecrets } from '@crish/shared-utils';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  level: LogLevel;
  time: string;
  msg: string;
  module?: string;
  sessionId?: string;
  runId?: string;
  err?: { message: string; stack?: string; code?: string; name?: string };
}

/**
 * 错误对象 → 日志安全载荷（PE-04 T04.4-1；K-05 脱敏面）。
 * Error / string / 含 message 对象归一；null / undefined → undefined。
 */
export function toErrMeta(err: unknown): LogEntry['err'] | undefined {
  if (err == null) return undefined;
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack, name: err.name };
  }
  if (typeof err === 'string') {
    return { message: err };
  }
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    return {
      message: typeof o.message === 'string' ? o.message : String(err),
      ...(typeof o.code === 'string' ? { code: o.code } : {}),
      ...(typeof o.name === 'string' ? { name: o.name } : {}),
    };
  }
  return { message: String(err) };
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

const STYLE_MAP: Record<LogLevel, string> = {
  debug: 'color:#888',
  info: 'color:#0ae',
  warn: 'color:#fa0;font-weight:bold',
  error: 'color:#e33;font-weight:bold',
  fatal: 'color:#e33;font-weight:bold;background:#fee',
};

const isDev = (): boolean =>
  typeof process !== 'undefined' && process.env.NODE_ENV === 'development';

/** 深度脱敏 meta（err.message / query 参数 / 嵌套字符串叶子；K-05 全局钩子） */
function redactMeta(
  meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>
): Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>> | undefined {
  if (!meta) return undefined;
  return redactDeep(meta) as Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>;
}

class LoggerService {
  static getInstance(): LoggerService {
    return logger;
  }
  private buffer = new RingBuffer<LogEntry>(200);
  private level: LogLevel = 'debug';
  private sessionContext: { sessionId?: string; runId?: string } = {};

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getRecentLogs(): LogEntry[] {
    return this.buffer.toArray();
  }

  /** 清空环形缓冲（测试 / 日志导出后重置用） */
  clearLogs(): void {
    this.buffer.clear();
  }

  /** 全局 sessionId/runId 上下文（调用点 meta 优先于全局） */
  setSessionContext(ctx: { sessionId?: string; runId?: string }): void {
    this.sessionContext = { ...this.sessionContext, ...ctx };
  }

  resetSessionContext(): void {
    this.sessionContext = {};
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.level];
  }

  private log(
    level: LogLevel,
    msg: string,
    meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>
  ): void {
    if (!this.shouldLog(level)) return;
    // K-05：全局脱敏钩子——msg 与 meta 在写库/输出前统一过脱敏层
    const safeMsg = redactSecrets(msg);
    const safeMeta = {
      ...this.sessionContext,
      ...redactMeta(meta),
    };
    const entry: LogEntry = {
      level,
      time: new Date().toISOString(),
      msg: safeMsg,
      ...safeMeta,
    };
    this.buffer.pushOverwritingOldest(entry);

    if (isDev()) {
      const style = STYLE_MAP[level];
      const prefix = entry.module ? `[${entry.module}]` : '';
      const args: unknown[] = [`%c${prefix} ${safeMsg}`, style];
      if (safeMeta) args.push(safeMeta);
      switch (level) {
        case 'debug':
          console.debug(...args);
          break;
        case 'info':
          console.info(...args);
          break;
        case 'warn':
          console.warn(...args);
          break;
        case 'error':
        case 'fatal':
          console.error(...args);
          break;
      }
    } else {
      console.log(JSON.stringify(entry));
    }
  }

  debug(
    msg: string,
    meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>
  ): void {
    this.log('debug', msg, meta);
  }

  info(
    msg: string,
    meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>
  ): void {
    this.log('info', msg, meta);
  }

  warn(
    msg: string,
    meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>
  ): void {
    this.log('warn', msg, meta);
  }

  error(
    msg: string,
    meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>
  ): void {
    this.log('error', msg, meta);
  }

  fatal(
    msg: string,
    meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>
  ): void {
    this.log('fatal', msg, meta);
  }
}

export const logger = new LoggerService();
