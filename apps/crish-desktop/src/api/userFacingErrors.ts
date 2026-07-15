/**
 * User-facing error policy for the desktop product.
 *
 * - Prefer calm, short copy for connectivity / setup issues.
 * - Agent runtime detail stays out of the bubble unless we classify a soft setup hint.
 */

const NETWORK_RE =
  /network|websocket|timeout|offline|econn|enotfound|econnrefused|not connected|failed to connect|connect(?:ion)? (?:failed|refused|reset|closed)|disconnected|daemon (?:offline|not|unavailable)|unable to connect|proxy|dns|net::|fetch failed|socket/i;

const NO_KEY_RE =
  /no provider|missing.*(?:api.?key|credential)|api.?key.*(?:missing|unset|required)|NO_PROVIDER|credential.*not|hasApiKey.?false|unauthorized|401|invalid.?api.?key/i;

const NO_PROJECT_RE =
  /no (?:project|workspace|cwd)|workspace (?:required|not set)|cwd (?:required|missing)/i;

const BLOCKED_RE =
  /blocked|denied by policy|hardline|permission denied|not allowed|safety/i;

export type SoftFailureKind = 'network' | 'no_key' | 'no_project' | 'blocked' | 'ended' | null;

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
      return '还没有配置可用的模型密钥。请打开设置完成配置后再试。';
    case 'no_project':
      return '请先选择工作目录，再继续。';
    case 'blocked':
      return '该操作未获允许。';
    case 'ended':
      return '这一轮没有完成。你可以换个说法再试一次。';
    default:
      return null;
  }
}

/**
 * Text for assistant bubble. Prefer soft setup/network hints; hide raw stacks.
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
