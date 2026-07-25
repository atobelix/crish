export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  level: LogLevel;
  time: string;
  msg: string;
  module?: string | undefined;
  sessionId?: string | undefined;
  runId?: string | undefined;
  clientId?: string | undefined;
  err?: { message: string; stack?: string | undefined; code?: string | undefined; name?: string | undefined } | undefined;
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

type RedactFn = (text: string) => string;
let _redactFn: RedactFn | undefined;

export function setLogRedactor(fn: RedactFn | undefined): void {
  _redactFn = fn;
}

export function redactSensitive(text: string): string {
  return _redactFn ? _redactFn(text) : text;
}

export type LogTransport = (entry: LogEntry) => void;

export function createConsoleTransport(): LogTransport {
  return (entry: LogEntry) => {
    const line = JSON.stringify(entry);
    switch (entry.level) {
      case 'debug': console.debug(line); break;
      case 'info': console.log(line); break;
      case 'warn': console.warn(line); break;
      case 'error':
      case 'fatal': console.error(line); break;
    }
  };
}

export interface LoggerOptions {
  level?: LogLevel | undefined;
  module?: string | undefined;
  transports?: LogTransport[] | undefined;
}

export class Logger {
  private _level: LogLevel;
  protected _module: string | undefined;
  private _transports: LogTransport[];

  constructor(options: LoggerOptions = {}) {
    this._level = options.level ?? 'info';
    this._module = options.module;
    this._transports = options.transports ?? [];
  }

  get level(): LogLevel { return this._level; }

  setLevel(level: LogLevel): void {
    this._level = level;
  }

  addTransport(transport: LogTransport): void {
    this._transports.push(transport);
  }

  child(context: Partial<LoggerOptions>): Logger {
    const module = context.module ?? this._module;
    return new Logger({
      level: context.level ?? this._level,
      ...(module !== undefined ? { module } : {}),
      transports: [...this._transports, ...(context.transports ?? [])],
    });
  }

  private log(level: LogLevel, msg: string, meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>): void {
    if (!shouldLog(this._level, level)) return;
    const entry: LogEntry = {
      level,
      time: new Date().toISOString(),
      msg: redactSensitive(msg),
      ...(this._module !== undefined ? { module: this._module } : {}),
      ...meta,
    };
    for (const t of this._transports) {
      t(entry);
    }
  }

  debug(msg: string, meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>): void { this.log('debug', msg, meta); }
  info(msg: string, meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>): void { this.log('info', msg, meta); }
  warn(msg: string, meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>): void { this.log('warn', msg, meta); }
  error(msg: string, meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>): void { this.log('error', msg, meta); }
  fatal(msg: string, meta?: Partial<Omit<LogEntry, 'level' | 'time' | 'msg'>>): void { this.log('fatal', msg, meta); }
}
