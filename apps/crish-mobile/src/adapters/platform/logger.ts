// 日志门面（工程健康审计 M-5 防再发）：非 UI 层唯一的日志出口。
//
// 背景：修复波之前，连接对账失败仅 console.warn、模型拉取失败无错误码、
// 断线提交静默吞稿——根源之一是全仓没有日志规范：随手一处 warn 即算
// 「处理过」。本门面把非 UI 层（adapters / domain / network / db /
// notifications / pairing）的日志收口为一个入口，并由
// src/__tests__/logger.guard.test.ts 静态守卫禁止再写裸 console.*。
//
// 口径：
// - 分级 debug / info / warn / error + 域标签（createLogger('wiring')），
//   输出统一为单行字符串 `[域] 消息`，经对应 console 方法发出
//   （warn→console.warn、error→console.error……），既有测试对
//   stringContaining 的断言口径不变。
// - 开发（__DEV__）全量输出；生产降噪：debug / info 不发出，
//   warn / error 必留痕（error 任何配置下都发出）。
// - 脱敏是门面职责：上下文对象按敏感键名（token / ticket / apiKey /
//   secret / password / authorization / credential 等）打码；消息与
//   字符串上下文统一 scrub 掉 Bearer 凭据与 URL 查询串里的
//   ticket/token 等参数——外部错误文本（服务端消息、relay 错误码）
//   折进日志时不把凭据带出去。
// - 不引入新依赖；门面自身零应用内导入，不产生循环依赖。
// - UI 呈现层（presentation/、app/）已于收口批迁完最后 4 处并纳入守卫，
//   全仓生产源码再无裸 console 豁免面。

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** 生产降噪线：warn 及以上必留痕；开发全量。 */
function defaultMinLevel(): LogLevel {
  return __DEV__ ? 'debug' : 'warn';
}

let minLevelOverride: LogLevel | null = null;
let sinkOverride: ((level: LogLevel, line: string) => void) | null = null;

/**
 * 测试专用：覆盖最低级别与输出 sink；不传参恢复默认。
 * 生产代码禁止调用。
 */
export function configureLoggerForTest(opts?: {
  minLevel?: LogLevel | null;
  sink?: ((level: LogLevel, line: string) => void) | null;
}): void {
  minLevelOverride = opts?.minLevel ?? null;
  sinkOverride = opts?.sink ?? null;
}

const SENSITIVE_KEY =
  /token|ticket|secret|password|passwd|api[-_]?key|authorization|credential|refresh/i;

/** 字符串级脱敏：Bearer 凭据与 URL 查询串中的票据/令牌参数。 */
export function scrubLogString(text: string): string {
  return text
    .replace(/(Bearer\s+)[^\s'"]+/gi, '$1***')
    .replace(
      /((?:ticket|token|access_token|api_key|apikey)=)[^&\s'"]+/gi,
      '$1***'
    );
}

const MAX_CONTEXT_CHARS = 1000;

function formatContext(context: unknown, seen: WeakSet<object>): string {
  if (context === undefined || context === null) return '';
  if (context instanceof Error) {
    const head = `${context.name}: ${scrubLogString(context.message)}`;
    if (__DEV__ && context.stack) {
      return `${head}\n${scrubLogString(context.stack)}`;
    }
    return head;
  }
  if (typeof context === 'string') return scrubLogString(context);
  if (typeof context === 'number' || typeof context === 'boolean') {
    return String(context);
  }
  if (typeof context === 'object') {
    try {
      const json = JSON.stringify(context, (key, value: unknown) => {
        if (key && SENSITIVE_KEY.test(key)) return '***';
        if (typeof value === 'string') return scrubLogString(value);
        if (value !== null && typeof value === 'object') {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        if (value instanceof Error) {
          return { name: value.name, message: scrubLogString(value.message) };
        }
        return value;
      });
      if (json === undefined) return '';
      return json.length > MAX_CONTEXT_CHARS
        ? `${json.slice(0, MAX_CONTEXT_CHARS)}…`
        : json;
    } catch {
      return '[unserializable context]';
    }
  }
  return String(context);
}

function emit(
  level: LogLevel,
  domain: string,
  message: string,
  context?: unknown
): void {
  const min = minLevelOverride ?? defaultMinLevel();
  if (LEVEL_ORDER[level] < LEVEL_ORDER[min]) return;
  const suffix = formatContext(context, new WeakSet());
  const line = scrubLogString(
    `[${domain}] ${message}${suffix ? ` ${suffix}` : ''}`
  );
  if (sinkOverride) {
    sinkOverride(level, line);
    return;
  }
  // 门面是唯一允许直触 console 的文件（守卫豁免本文件）。
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (level === 'info') console.info(line);
  else console.debug(line);
}

/** 按域创建 logger：域 = 模块面（wiring / account / db / notifications……）。 */
export function createLogger(domain: string): Logger {
  return {
    debug: (message, context) => emit('debug', domain, message, context),
    info: (message, context) => emit('info', domain, message, context),
    warn: (message, context) => emit('warn', domain, message, context),
    error: (message, context) => emit('error', domain, message, context),
  };
}
