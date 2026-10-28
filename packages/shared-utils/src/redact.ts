/**
 * 前端日志/展示脱敏（PE-04 T04.4-4 · R4 批次5 自 crish-desktop 下沉共享包）。
 *
 * 与 Rust 侧 conex-telemetry/src/redact.rs（PE-07 T07.4-D）共享同一正则规范
 * （sk- 前缀、Bearer、query 参数中的 key）；桌面端（crish-desktop）与移动端
 * （crish-mobile）经本包单实现共用，Rust 侧日志脱敏由 PE-07 单实现负责，
 * 本文件不重复实现 Rust 面。
 *
 * 规则（白名单式，宁多勿漏）：
 * - `sk-` 前缀密钥（OpenAI 风格，至少 8 位字母数字）
 * - `Bearer <token>` 认证头值
 * - 常见凭据键值对（apiKey / secret / token / client_secret 等）
 * - URL query 中的 key / api_key / token / auth 参数值
 * - `Authorization` 头赋值行
 */

/** 需要脱敏的授权头行（Authorization: Bearer xxx 等） */
const AUTH_HEADER_RE = /(Authorization\s*:\s*)(.*)$/gim;

/** Bearer token 值（紧跟 Bearer 的连续非空白字符） */
const BEARER_RE = /\bBearer\s+\S+/gi;

/** sk- 前缀密钥（字母数字至少 8 位） */
const SK_KEY_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

/** 常见凭据键值对：key=value / key: value / key value */
const CREDENTIAL_PAIR_RE =
  /(api[_-]?key|apikey|secret|token|access_token|refresh_token|client_secret|password)\s*[=:]\s*\S+/gi;

/** URL query 中的敏感参数值 */
const QUERY_PARAM_RE =
  /([?&](?:key|api_key|token|auth|apikey|api-key)=)[^&\s]+/gi;

const REDACTED = '***';

/**
 * 对文本中的密钥/令牌进行脱敏替换。
 * 匹配内容整体替换为 `***`；键值对 / query 参数保留键名，仅掩掉值。
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  out = out.replace(SK_KEY_RE, REDACTED);
  out = out.replace(BEARER_RE, REDACTED);
  out = out.replace(AUTH_HEADER_RE, (_m, head: string) => `${head}${REDACTED}`);
  out = out.replace(
    CREDENTIAL_PAIR_RE,
    (_m, key: string) => `${key}=${REDACTED}`
  );
  out = out.replace(QUERY_PARAM_RE, (_m, head: string) => `${head}${REDACTED}`);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 错误对象转日志安全载荷（配合 LoggerService 的 err 字段形状） */
function redactError(err: unknown): unknown {
  if (err instanceof Error) {
    return {
      message: redactSecrets(err.message),
      stack: redactSecrets(err.stack ?? ''),
      name: err.name,
    };
  }
  return redactSecrets(String(err));
}

/**
 * 深度脱敏任意日志 meta 值：字符串叶子全部过 redactSecrets，
 * Error 实例转安全载荷。深度上限防循环引用爆栈。
 */
export function redactDeep(value: unknown, depth = 4): unknown {
  if (depth <= 0) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (value instanceof Error) return redactError(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, depth - 1));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactDeep(v, depth - 1);
    }
    return out;
  }
  return value;
}

/**
 * 展示用掩码：保留密钥前缀与末 4 位（sk-abcd…wxyz），
 * 供设置面板等需要「确认是哪个 key」的场景使用；日志面一律用 redactSecrets。
 */
export function maskSecretLast4(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}…`;
  return `${trimmed.slice(0, 5)}…${trimmed.slice(-4)}`;
}
