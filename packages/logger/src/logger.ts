/**
 * @crish/logger — Logger 核心类
 *
 * 设计决策（ROUND-02 §6.2 推荐方案）：
 * LogTransport 保持纯函数式类型 `(entry: LogEntry) => void`，不扩展为联合类型。
 * 需要异步刷新的对象式 sink（如 RotatingFileSink，由 Agent 2-B 实现）通过：
 *   1. `sink.asTransport()` 返回函数式 transport 注册到 Logger（保持 LogTransport 类型简单）
 *   2. `logger.setFlushable(sink)` 单独注册可刷新对象，`logger.flush()` 遍历 `_flushables` 调用 flush
 *   3. CrashHandler 通过 `setFlushable` 获取 flushSync 能力（需另外的 setFlushSyncable，由 Agent 2-B/2-D 补充）
 * 这样函数式 transport 与对象式 sink 解耦，LogTransport 类型零改动。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  level: LogLevel;
  time: string;
  msg: string;
  module?: string | undefined;
  sessionId?: string | undefined;
  runId?: string | undefined;
  clientId?: string | undefined;
  err?:
    | {
        message: string;
        stack?: string | undefined;
        code?: string | undefined;
        name?: string | undefined;
      }
    | undefined;
  [key: string]: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

export function shouldLog(configured: LogLevel, entry: LogLevel): boolean {
  return LEVEL_PRIORITY[entry] >= LEVEL_PRIORITY[configured];
}

export type LogTransport = (entry: LogEntry) => void;

export type RedactFn = (text: string) => string;

export interface LoggerOptions {
  level?: LogLevel | undefined;
  module?: string | undefined;
  transports?: LogTransport[] | undefined;
  redactor?: RedactFn | undefined;
}

/** Logger 注入 span 上下文的 sink 接口（与 @crish/telemetry LogSpanSink 结构兼容，鸭子类型解耦） */
export interface LogSpanSink {
  onLog(entry: LogEntry): void;
}

export class Logger {
  private _level: LogLevel;
  protected _module: string | undefined;
  private _transports: LogTransport[];
  private _redactor: RedactFn | undefined;
  private _spanSink: LogSpanSink | undefined;
  private _contextDefaults:
    Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>> | undefined;
  private _flushables: Array<{ flush(): Promise<void> }>;

  constructor(options: LoggerOptions = {}) {
    this._level = options.level ?? 'info';
    this._module = options.module;
    this._transports = options.transports ?? [];
    this._redactor = options.redactor;
    this._flushables = [];
  }

  get level(): LogLevel {
    return this._level;
  }

  setLevel(level: LogLevel): void {
    this._level = level;
  }

  setRedactor(fn: RedactFn | undefined): void {
    this._redactor = fn;
  }

  setSpanSink(sink: LogSpanSink | undefined): void {
    this._spanSink = sink;
  }

  setFlushable(flushable: { flush(): Promise<void> }): void {
    this._flushables.push(flushable);
  }

  addTransport(transport: LogTransport): void {
    this._transports.push(transport);
  }

  child(context: Partial<LoggerOptions>): Logger {
    const module = context.module ?? this._module;
    const childLogger = new Logger({
      level: context.level ?? this._level,
      ...(module !== undefined ? { module } : {}),
      transports: [...this._transports, ...(context.transports ?? [])],
      ...(this._redactor !== undefined ? { redactor: this._redactor } : {}),
    });
    childLogger._spanSink = this._spanSink;
    childLogger._contextDefaults = this._contextDefaults;
    return childLogger;
  }

  withContext(
    context: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>
  ): Logger {
    const childLogger = this.child({});
    childLogger._contextDefaults = { ...this._contextDefaults, ...context };
    return childLogger;
  }

  async flush(): Promise<void> {
    for (const f of this._flushables) {
      await f.flush();
    }
  }

  private _redact(text: string): string {
    return this._redactor ? this._redactor(text) : text;
  }

  private log(
    level: LogLevel,
    msg: string,
    meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>
  ): void {
    if (!shouldLog(this._level, level)) return;
    const entry: LogEntry = {
      level,
      time: new Date().toISOString(),
      msg: this._redact(msg),
      ...(this._module !== undefined ? { module: this._module } : {}),
      ...(this._contextDefaults ? { ...this._contextDefaults } : {}),
      ...meta,
    };
    for (const t of this._transports) {
      t(entry);
    }
    if (this._spanSink) {
      this._spanSink.onLog(entry);
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
