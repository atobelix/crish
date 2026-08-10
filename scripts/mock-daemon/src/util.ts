// =======================================================================
// mock daemon v0（R0-06）——通用工具（msgId / 日志 / 延时）
// =======================================================================

/** 消息编号计数（进程级单调递增，供 msgId 拼接） */
let msgSeq = 0;

/**
 * 生成发送方唯一 msgId：`<前缀>-<毫秒时间戳>-<自增序号>-<随机后缀>`。
 * 规范对齐 M6 §3.3（长度 8-64，发送方唯一）。
 */
export function nextMsgId(prefix: string): string {
  msgSeq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${msgSeq}-${rand}`;
}

/** 日志级别（-v / -q 控制） */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = 'info';

/** 设置日志级别（CLI 启动参数解析后调用） */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * 统一日志入口：`[mock-daemon] <级别> <消息>`。中文注释规范：日志内容用中文，
 * 便于联调人员直接阅读；协议 kind / 字段名保留英文原样。
 */
export function log(level: LogLevel, message: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const line = `[mock-daemon] ${new Date().toISOString()} [${level}] ${message}`;
  if (level === 'error' || level === 'warn') {
    // 警告与错误走 stderr，正常日志走 stdout（便于管道过滤）
    console.error(line);
  } else {
    console.log(line);
  }
}

/** 便捷封装 */
export const info = (m: string): void => log('info', m);
export const debug = (m: string): void => log('debug', m);
export const warn = (m: string): void => log('warn', m);
export const err = (m: string): void => log('error', m);

/** 延时（毫秒）；scenarioSpeed 为 CLI 传入的速度倍率（≤1 为加速，测试用 0） */
export function sleep(ms: number, speed = 1): Promise<void> {
  const scaled = Math.max(0, Math.round(ms * speed));
  if (scaled === 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, scaled));
}

/** ISO 时间戳（与引擎事件 timestamp 字段同形态：ISO 字符串） */
export function nowIso(): string {
  return new Date().toISOString();
}
