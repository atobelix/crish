/**
 * User-facing error policy for the desktop product.
 *
 * - Prefer calm, short copy for connectivity / setup issues.
 * - Agent runtime detail stays out of the bubble unless we classify a soft setup hint.
 */

const NETWORK_RE =
  /network|websocket|timeout|offline|econn|enotfound|econnrefused|not connected|failed to connect|connect(?:ion)? (?:failed|refused|reset|closed)|disconnected|daemon (?:offline|not|unavailable)|unable to connect|proxy|dns|net::|fetch failed|socket/i;

const NO_KEY_RE =
  /no provider|missing.*(?:api.?key|credential)|api.?key.*(?:missing|unset|required)|NO_PROVIDER|credential.*not|hasApiKey.?false/i;

const AUTH_RE =
  /invalid.?api.?key|unauthorized|401|authentication|auth.?failed|api.?key.*invalid|key.*expired|credential.*invalid/i;

const NO_PROJECT_RE =
  /no (?:project|workspace|cwd)|workspace (?:required|not set)|cwd (?:required|missing)/i;

const BLOCKED_RE =
  /blocked|denied by policy|hardline|permission denied|not allowed|safety/i;

export type SoftFailureKind = 'network' | 'no_key' | 'auth' | 'no_project' | 'blocked' | 'ended' | null;

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

export function classifySoftFailure(input: unknown): SoftFailureKind {
  const text = normalizeErrorText(input);
  if (!text) return null;
  if (NO_KEY_RE.test(text)) return 'no_key';
  if (AUTH_RE.test(text)) return 'auth';
  if (NO_PROJECT_RE.test(text)) return 'no_project';
  if (isNetworkishError(text)) return 'network';
  if (BLOCKED_RE.test(text)) return 'blocked';
  // Generic run failure without technical dump
  if (/run failed|RUN_ERROR|failed|error/i.test(text)) return 'ended';
  return null;
}

export function networkUserMessage(_detail?: unknown): string {
  return '服务暂时不可用，正在自动恢复，请稍后再试。';
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
    case 'ended':
      return '这一轮任务中断了：可能是引擎繁忙、模型无响应，或运行被取消。请稍后重试；若刚改过密钥或地址，请到设置确认。';
    default:
      return null;
  }
}

/**
 * @deprecated 禁止再写入 assistant 气泡。错误/中断只走 onRunError → 横幅/toast。
 * 仍返回文案供 surfaceStreamFailure 组 notice，勿 updateMessageText 进气泡。
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
