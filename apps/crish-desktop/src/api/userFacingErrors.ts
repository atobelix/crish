/**
 * User-facing error policy for the desktop product.
 *
 * - Prefer calm, short copy for connectivity / setup issues.
 * - Agent runtime detail stays out of the bubble unless we classify a soft setup hint.
 */

const NETWORK_RE =
  /network|timeout|offline|econn|enotfound|econnrefused|not connected|failed to connect|connect(?:ion)? (?:failed|refused|reset|closed)|disconnected|unable to connect|proxy|dns|net::|fetch failed|socket/i;

const NO_KEY_RE =
  /no provider|missing.*(?:api.?key|credential)|api.?key.*(?:missing|unset|required)|NO_PROVIDER|credential.*not|hasApiKey.?false|引擎未就绪/i;

const AUTH_RE =
  /invalid.?api.?key|unauthorized|401|authentication|auth.?failed|api.?key.*invalid|key.*expired|credential.*invalid/i;

const NO_PROJECT_RE =
  /no (?:project|workspace|cwd)|workspace (?:required|not set)|cwd (?:required|missing)/i;

const BLOCKED_RE =
  /blocked|denied by policy|hardline|permission denied|not allowed|safety/i;

export type SoftFailureKind =
  | 'network'
  | 'no_key'
  | 'auth'
  | 'no_project'
  | 'blocked'
  | 'provider_fault'
  | 'ended'
  | null;

export function normalizeErrorText(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (input instanceof Error) return input.message || String(input);
  if (typeof input === 'object') {
    const o = input as Record<string, unknown>;
    if (typeof o.message === 'string') return o.message;
    if (typeof o.error === 'string') return o.error;
    if (typeof o.code === 'string' && typeof o.message !== 'string') return o.code;
    try {
      return JSON.stringify(input);
    } catch {
      return String(input);
    }
  }
  return String(input);
}

export function isNetworkishError(input: unknown): boolean {
  const text = normalizeErrorText(input);
  if (!text) return false;
  return NETWORK_RE.test(text);
}

/**
 * Rust session-loop 的 provider 收场文案包装：
 *   `provider 错误（{kind}）：{message}`（crates/session-loop/src/loop/handlers/stream_error.rs kind_str）。
 * AA-07 统一规范：kebab 错误码优先识别，前端不再按英文文本重复猜测。
 */
const RUST_PROVIDER_WRAPPER_RE = /provider\s*错误\s*（([^）]+)）\s*：/;

/** kebab 错误码 → 前端软失败分类（未登记码回落到文本正则兜底） */
const KEBAB_KIND_TO_SOFT: Record<string, SoftFailureKind> = {
  auth: 'auth',
  'endpoint-unavailable': 'network',
  network: 'network',
  timeout: 'network',
  quota: 'blocked',
  // S5 域（provider 侧故障）：从 blocked 拆出独立分类，quota → blocked 保持不变
  'server-error': 'provider_fault',
  'rate-limit': 'provider_fault',
  'gateway-challenge': 'provider_fault',
};

function classifyByKebabCode(text: string): SoftFailureKind | null {
  const m = RUST_PROVIDER_WRAPPER_RE.exec(text);
  if (!m) return null;
  return KEBAB_KIND_TO_SOFT[m[1]!] ?? null;
}

export function classifySoftFailure(input: unknown): SoftFailureKind {
  const text = normalizeErrorText(input);
  if (!text) return null;
  // kebab 错误码优先（统一规范）；未登记码 → 落到文本正则兜底
  const kebab = classifyByKebabCode(text);
  if (kebab) return kebab;
  if (NO_KEY_RE.test(text)) return 'no_key';
  if (AUTH_RE.test(text)) return 'auth';
  if (NO_PROJECT_RE.test(text)) return 'no_project';
  if (isNetworkishError(text)) return 'network';
  if (BLOCKED_RE.test(text)) return 'blocked';
  // Generic run failure without technical dump
  if (/run failed|RUN_ERROR|failed|error/i.test(text)) return 'ended';
  return null;
}

/**
 * 差异化六域（docs/error-notification-governance/10-analysis/03 §④ S1-S6）：
 * - S1 本地核心未就绪（waitUntilConnected 超时 / initialized=false）
 * - S2 引擎未就绪（provider 配置缺失）
 * - S3 restore 进行中（restore.state=pending）
 * - S4 provider 网络（kebab 码 network/timeout/endpoint-unavailable）
 * - S5 provider 侧故障（server-error/rate-limit/gateway-challenge）
 * - S6 内部错误（其他 CoreError）
 */
export type ErrorDomain = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6';

/** 差异化文案表（用户裁决选项 A：分层 + 动作指引，不虚假承诺「自动恢复」） */
const DOMAIN_MESSAGES: Record<ErrorDomain, string> = {
  S1: '软件服务正在启动，请稍候片刻。',
  S2: '模型服务尚未配置，请打开 设置 → 模型 完成配置后再发送。',
  S3: '正在恢复上次的会话数据，稍后即可发送。',
  S4: '模型服务商暂时无法连接（网络问题），请检查网络后重发。',
  S5: '模型服务商侧出现故障，请稍后重试或切换模型。',
  S6: '软件内部错误，请稍后重试；若反复出现请重启应用。',
};

/** kebab 错误码 → 域（Rust provider 包装 `provider 错误（{kind}）：{message}`） */
const KEBAB_TO_DOMAIN: Record<string, ErrorDomain> = {
  network: 'S4',
  timeout: 'S4',
  'endpoint-unavailable': 'S4',
  'server-error': 'S5',
  'rate-limit': 'S5',
  'gateway-challenge': 'S5',
};

const PROVIDER_CONFIG_MISSING_RE = /provider\s*配置缺失|provider config.*missing/i;
const RESTORE_IN_PROGRESS_RE = /restore in progress|restore.*进行中/i;
const LOCAL_CORE_NOT_READY_RE = /engine not ready|引擎未就绪|核心未就绪/i;
const PROVIDER_SIDE_FAULT_RE = /server.?error|5\d{2}|rate.?limit|gateway/i;
const INTERNAL_ERROR_RE =
  /invalid\s?input|encoding error|io error|not found|cancelled|internal:|tauri command not available|command not available|^unknown:/i;

/** core_get_status 返回体形状判定（serde camelCase：initialized/engineReady/restore 等） */
function isStatusLike(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return false;
  }
  const o = input as Record<string, unknown>;
  return (
    typeof o.initialized === 'boolean' ||
    typeof o.engineReady === 'boolean' ||
    typeof o.engine_ready === 'boolean' ||
    typeof o.dbReady === 'boolean' ||
    o.restore != null
  );
}

/**
 * core_get_status 状态对象 → 域（S1/S2/S3；就绪 → null）。
 * 判定顺序对齐 Rust 门禁（core_run_commands.rs:2851-2874）：
 * initialized=false → S1；restore.state=pending → S3；engineReady=false → S2。
 */
function classifyStatusDomain(status: Record<string, unknown>): ErrorDomain | null {
  if (status.initialized === false) return 'S1';
  const restore =
    typeof status.restore === 'object' && status.restore !== null
      ? (status.restore as Record<string, unknown>)
      : null;
  if (restore?.state === 'pending') return 'S3';
  const engineReady = status.engineReady ?? status.engine_ready;
  if (engineReady === false) return 'S2';
  return null;
}

/**
 * 差异化六域判定（03 §④ 4.3 必改项：networkUserMessage 消费 detail 的判定面）。
 * 支持两类 detail：core_get_status 状态对象（S1/S2/S3）与错误文本/对象（S1-S6）。
 * 未命中任何域 → null（保留既有 classifySoftFailure 分类路径，不做越权判定）。
 */
export function classifyErrorDomain(input: unknown): ErrorDomain | null {
  if (isStatusLike(input)) return classifyStatusDomain(input);
  const text = normalizeErrorText(input);
  if (!text) return null;
  // kebab 错误码优先（统一规范）；未登记码（auth/quota 等）→ 既有分类接管
  const wrapper = RUST_PROVIDER_WRAPPER_RE.exec(text);
  if (wrapper) return KEBAB_TO_DOMAIN[wrapper[1]!] ?? null;
  // S2 先于 S1：Rust 门禁文案「engine not ready（provider 配置缺失）」同时含两者
  if (PROVIDER_CONFIG_MISSING_RE.test(text)) return 'S2';
  if (RESTORE_IN_PROGRESS_RE.test(text)) return 'S3';
  if (LOCAL_CORE_NOT_READY_RE.test(text)) return 'S1';
  if (isNetworkishError(text)) return 'S4';
  if (PROVIDER_SIDE_FAULT_RE.test(text)) return 'S5';
  if (INTERNAL_ERROR_RE.test(text)) return 'S6';
  return null;
}

/** 差异化文案取值（S1-S6 域 → 用户可见文案） */
export function domainUserMessage(domain: ErrorDomain): string {
  return DOMAIN_MESSAGES[domain];
}

/**
 * 网络/连接类失败的用户文案（03 §④：不再一刀切「正在自动恢复」）。
 * 消费 detail 做分域判定（S1-S6）；detail 缺失或未命中任何域 → S6 兜底
 *（诚实通用句：不虚假承诺自动恢复，给出重试/重启指引）。
 */
export function networkUserMessage(detail?: unknown): string {
  const domain = classifyErrorDomain(detail);
  return domain ? DOMAIN_MESSAGES[domain] : DOMAIN_MESSAGES.S6;
}

export function productStartingMessage(): string {
  return '正在启动…';
}

export function softFailureMessage(kind: SoftFailureKind): string | null {
  switch (kind) {
    case 'network':
      return networkUserMessage();
    case 'no_key':
      return '还没有配置可用的模型密钥。请打开设置 → 模型，填写密钥后再试。';
    case 'auth':
      return '模型密钥无效或已过期，请打开设置 → 模型检查密钥与服务商地址。';
    case 'no_project':
      return '请先选择项目工作区，再继续对话。';
    case 'blocked':
      return '该操作未获允许（可能被安全策略或计划模式拦截）。';
    case 'provider_fault':
      // S5 域：provider 侧故障（server-error/rate-limit/gateway-challenge）
      return DOMAIN_MESSAGES.S5;
    case 'ended':
      return '这一轮任务中断了：可能是引擎繁忙、模型无响应，或运行被取消。请稍后重试；若刚改过密钥或地址，请到设置确认。';
    default:
      return null;
  }
}

/**
 * @deprecated 禁止再写入 assistant 气泡。错误/中断只走 onRunError → 横幅/toast。
 * 仍返回文案供 surfaceStreamFailure 组 notice，勿 updateMessageText 进气泡。
 * @see onRunError（横幅/toast 错误链路）
 */
export function assistantBubbleForFailure(input: unknown): string | null {
  const kind = classifySoftFailure(input);
  if (kind) return softFailureMessage(kind);
  if (isNetworkishError(input)) return networkUserMessage(input);
  return null;
}

export function logInternalError(scope: string, input: unknown): void {
  try {
    console.warn(`[crish-desktop][${scope}]`, normalizeErrorText(input) || input);
  } catch {
    /* ignore */
  }
}
