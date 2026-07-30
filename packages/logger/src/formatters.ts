/**
 * @crish/logger — 日志格式化器
 *
 * 提供 JSON 与人类可读两种格式化策略，供 transports 与 RotatingFileSink 使用。
 * 不引入 chalk 等外部依赖，ANSI 着色仅在 TTY 环境下启用。
 */
import type { LogEntry } from './logger';

/** 格式化函数类型：将 LogEntry 转换为待输出的字符串行 */
export type Formatter = (entry: LogEntry) => string;

/**
 * JSON 格式化器（与 createJSONStreamTransport / DaemonFileLogger 的序列化一致）。
 * 输出单行 JSON + 换行符，保持向后兼容。
 */
export function formatJSON(entry: LogEntry): string {
  return JSON.stringify(entry) + '\n';
}

const ANSI_LEVEL_COLOR: Readonly<Record<string, string>> = {
  debug: '\x1b[90m', // gray
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  fatal: '\x1b[35m', // magenta
};
const ANSI_RESET = '\x1b[0m';

function stdoutIsTTY(): boolean {
  return (
    typeof process !== 'undefined' &&
    typeof process.stdout !== 'undefined' &&
    process.stdout.isTTY === true
  );
}

/**
 * 人类可读控制台格式化器：`[time] [LEVEL] [module] msg {meta}`
 * 在 TTY 环境下按日志级别着色（ANSI 转义码），非 TTY 输出纯文本。
 */
export function formatConsole(entry: LogEntry): string {
  const time = entry.time;
  const level = entry.level.toUpperCase();
  const module = entry.module ?? '-';
  const msg = entry.msg;

  const metaKeys: string[] = [];
  for (const key of Object.keys(entry)) {
    if (key === 'level' || key === 'time' || key === 'msg' || key === 'module')
      continue;
    metaKeys.push(key);
  }
  const metaStr =
    metaKeys.length > 0 ? ' ' + JSON.stringify(pickMeta(entry, metaKeys)) : '';

  const line = `[${time}] [${level}] [${module}] ${msg}${metaStr}\n`;

  if (stdoutIsTTY()) {
    const color = ANSI_LEVEL_COLOR[entry.level] ?? '';
    return color !== '' ? `${color}${line}${ANSI_RESET}` : line;
  }
  return line;
}

function pickMeta(entry: LogEntry, keys: string[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const key of keys) {
    obj[key] = entry[key];
  }
  return obj;
}

/** LogEntry['err'] 的结构类型（避免内联重复） */
type LogErr = NonNullable<LogEntry['err']>;

/**
 * 从任意 unknown 值提取结构化错误信息，供 LogEntry.err 字段使用。
 * 与 daemon-file-logger.ts 的 toLogErr 逻辑等价，提取为通用 formatter。
 */
export function formatLogErr(err: unknown): LogErr | undefined {
  if (err == null) return undefined;
  if (err instanceof Error) {
    return {
      message: err.message,
      stack: err.stack,
      code: (err as { code?: string }).code,
      name: err.name,
    };
  }
  return {
    message: String(err),
    stack: undefined,
    code: undefined,
    name: undefined,
  };
}
