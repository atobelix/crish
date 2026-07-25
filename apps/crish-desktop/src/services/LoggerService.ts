import { RingBuffer } from "@crish/shared-utils";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogEntry {
  level: LogLevel;
  time: string;
  msg: string;
  module?: string;
  sessionId?: string;
  runId?: string;
  err?: { message: string; stack?: string; code?: string; name?: string };
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

const STYLE_MAP: Record<LogLevel, string> = {
  debug: "color:#888",
  info: "color:#0ae",
  warn: "color:#fa0;font-weight:bold",
  error: "color:#e33;font-weight:bold",
  fatal: "color:#e33;font-weight:bold;background:#fee",
};

const isDev = (): boolean =>
  typeof process !== "undefined" && process.env.NODE_ENV === "development";

export class LoggerService {
  static getInstance(): LoggerService {
    return logger;
  }
  private buffer = new RingBuffer<LogEntry>(200);
  private level: LogLevel = "debug";

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getRecentLogs(): LogEntry[] {
    return this.buffer.toArray();
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.level];
  }

  private log(level: LogLevel, msg: string, meta?: Partial<Omit<LogEntry, "level" | "time" | "msg">>): void {
    if (!this.shouldLog(level)) return;
    const entry: LogEntry = {
      level,
      time: new Date().toISOString(),
      msg,
      ...meta,
    };
    this.buffer.pushOverwritingOldest(entry);

    if (isDev()) {
      const style = STYLE_MAP[level];
      const prefix = entry.module ? `[${entry.module}]` : "";
      const args: unknown[] = [`%c${prefix} ${msg}`, style];
      if (meta) args.push(meta);
      switch (level) {
        case "debug":
          console.debug(...args);
          break;
        case "info":
          console.info(...args);
          break;
        case "warn":
          console.warn(...args);
          break;
        case "error":
        case "fatal":
          console.error(...args);
          break;
      }
    } else {
      console.log(JSON.stringify(entry));
    }
  }

  debug(msg: string, meta?: Partial<Omit<LogEntry, "level" | "time" | "msg">>): void {
    this.log("debug", msg, meta);
  }

  info(msg: string, meta?: Partial<Omit<LogEntry, "level" | "time" | "msg">>): void {
    this.log("info", msg, meta);
  }

  warn(msg: string, meta?: Partial<Omit<LogEntry, "level" | "time" | "msg">>): void {
    this.log("warn", msg, meta);
  }

  error(msg: string, meta?: Partial<Omit<LogEntry, "level" | "time" | "msg">>): void {
    this.log("error", msg, meta);
  }

  fatal(msg: string, meta?: Partial<Omit<LogEntry, "level" | "time" | "msg">>): void {
    this.log("fatal", msg, meta);
  }
}

export const logger = new LoggerService();
