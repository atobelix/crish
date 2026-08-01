/**
 * 前端错误翻译层（Round 11-A）。
 *
 * 将 CrishErrorPayload（结构化错误负载）翻译为 UserVisibleError（用户可见展示模型），
 * 并提供 unknown -> CrishErrorPayload 的兜底标准化与 CrishErrorPayload -> CrishError 的反序列化。
 *
 * 设计依据：analysis/iterative-repair/v2/ROUND-11-frontend.md §3
 *
 * 约束：
 * - 仅依赖 @crish/shared-types，不引入新运行时依赖（禁令 8）
 * - 通过内置英文映射表提供 title/action 回退，未命中码回退到通用英文文案
 * - translate 函数可选，未提供时使用内置英文回退字符串
 * - 不手写 77 个码的 switch/case，仅覆盖用户可见的高频码（>= 20 条）
 */

import {
  CrishError,
  toErrorPayload,
  fromUnknownError,
  CRISH_ERROR_CAUSE_MAX_DEPTH,
  type CrishErrorPayload,
} from '@crish/shared-types';

/** 用户可见的错误展示模型 */
export interface UserVisibleError {
  /** 是否对终端用户可见（由 payload.public 决定；severity=silent 时消费方也应隐藏） */
  readonly visible: boolean;
  /** 用户可见的标题（translate 提供时为本地化文案，否则为内置英文回退） */
  readonly title: string;
  /** 用户可见的消息（直接使用 payload.message，已由 Rust 端本地化） */
  readonly message: string;
  /** 用户可执行的操作建议（translate 提供时为本地化文案，否则为内置英文回退） */
  readonly action: string;
  /** 是否可重试（前端据此决定是否展示"重试"按钮） */
  readonly retryable: boolean;
  /** 错误码（供日志与遥测使用，不对用户展示原始码） */
  readonly code: string;
  /** 严重级别（由 category 映射，控制 UI 展示样式：toast / banner / silent） */
  readonly severity: 'info' | 'warning' | 'error' | 'silent';
}

/**
 * i18n 键 -> 用户可见文案的查表函数。
 *
 * 设计为接受外部注入的 translate 函数，避免 error-translation.ts 硬依赖 i18n 库。
 * 调用方（如 Toast 组件）注入自己的 t() 函数。未命中翻译时回退到 fallback 字符串。
 */
export type TranslateFn = (key: string, fallback?: string) => string;

/**
 * 内置错误码 -> 英文 title/action 映射表。
 *
 * 仅覆盖用户可见的高频码（33 条，覆盖 common / store / event_store / agent /
 * context / runtime / provider / subagent 域；与 77 码注册表一致——Rust 侧
 * T06.5.8 的 store 域、event_store 域映射码，以及 T04.3-3 发射点日志的
 * agent.max_turns_reached、context.length_exceeded 均在此表命中）。
 * 未命中此表的码回退到 DEFAULT_DISPLAY 的通用英文文案。
 * translate 函数提供时，调用方可通过 i18n 键获取本地化文案，以此表英文为回退。
 */
const BUILTIN_ERROR_DISPLAY: Readonly<
  Record<string, { readonly title: string; readonly action: string }>
> = {
  // ── common 域 ──
  'common.unknown': {
    title: 'Unknown error',
    action: 'Please try again or report the issue.',
  },
  'common.unsupported': {
    title: 'Unsupported operation',
    action: 'Please check the app version.',
  },
  'common.not_found': {
    title: 'Resource not found',
    action: 'Please check the resource reference.',
  },
  'common.invalid_input': {
    title: 'Invalid input',
    action: 'Please check the input and try again.',
  },
  'common.encoding': {
    title: 'Encoding error',
    action: 'Please use a supported text encoding.',
  },
  // ── store 域 ──
  'store.write_failed': {
    title: 'Storage write failed',
    action: 'Retrying automatically.',
  },
  'store.read_failed': {
    title: 'Storage read failed',
    action: 'Retrying automatically.',
  },
  'store.corrupted': {
    title: 'Storage corrupted',
    action: 'Please restore from backup.',
  },
  'store.capacity_exceeded': {
    title: 'Storage capacity exceeded',
    action: 'Please clean up or expand storage.',
  },
  'store.io': {
    title: 'Storage I/O error',
    action: 'Retrying automatically.',
  },
  // ── event_store 域 ──
  'event_store.append_failed': {
    title: 'Event append failed',
    action: 'Retrying automatically.',
  },
  'event_store.read_failed': {
    title: 'Event read failed',
    action: 'Retrying automatically.',
  },
  'event_store.consistency_violation': {
    title: 'Event consistency error',
    action: 'Please rebuild the index.',
  },
  'event_store.degraded': {
    title: 'Event storage degraded',
    action: 'Please check disk space.',
  },
  // ── agent 域 ──
  'agent.max_turns_reached': {
    title: 'Turn limit reached',
    action: 'Please start a new session or shorten the task.',
  },
  // ── context 域 ──
  'context.length_exceeded': {
    title: 'Context length exceeded',
    action: 'Please shorten the task or start a new session.',
  },
  // ── runtime 域 ──
  'runtime.unexpected_state': {
    title: 'Runtime state error',
    action: 'Please restart the session.',
  },
  'runtime.transition_failed': {
    title: 'State transition failed',
    action: 'Please report the issue.',
  },
  'runtime.aborted': {
    title: 'Aborted',
    action: '',
  },
  'runtime.timeout': {
    title: 'Runtime timeout',
    action: 'Please retry.',
  },
  // ── provider 域 ──
  'provider.network': {
    title: 'Network error',
    action: 'Service is temporarily unavailable. Please try again later.',
  },
  'provider.rate_limit': {
    title: 'Rate limited',
    action: 'Too many requests. Please wait and retry.',
  },
  'provider.server': {
    title: 'Server error',
    action: 'Service is temporarily unavailable. Please try again later.',
  },
  'provider.timeout': {
    title: 'Request timeout',
    action: 'The request timed out. Please retry.',
  },
  'provider.cancelled': {
    title: 'Request cancelled',
    action: '',
  },
  'provider.stream_interrupted': {
    title: 'Stream interrupted',
    action: 'Streaming was interrupted. Please retry.',
  },
  'provider.auth': {
    title: 'Authentication failed',
    action: 'Please check the API key in Settings.',
  },
  'provider.quota': {
    title: 'Quota exhausted',
    action: 'Please top up or switch providers.',
  },
  'provider.endpoint_unavailable': {
    title: 'Endpoint unavailable',
    action: 'Please check the provider endpoint.',
  },
  'provider.unknown': {
    title: 'Unknown provider error',
    action: 'Please report the issue.',
  },
  // ── subagent 域 ──
  'subagent.depth_exceeded': {
    title: 'Subagent depth exceeded',
    action: 'Please simplify the task.',
  },
  'subagent.deadlock_detected': {
    title: 'Subagent deadlock',
    action: 'Please replan the task.',
  },
  'subagent.timeout': {
    title: 'Subagent timeout',
    action: 'Please retry.',
  },
};

/** 未知码的通用英文回退（未命中 BUILTIN_ERROR_DISPLAY 时使用） */
const DEFAULT_DISPLAY: Readonly<{ readonly title: string; readonly action: string }> = {
  title: 'Error',
  action: 'Please try again or contact support.',
};

/** 查内置英文映射表，未命中返回通用回退 */
function resolveDisplay(code: string): { readonly title: string; readonly action: string } {
  return BUILTIN_ERROR_DISPLAY[code] ?? DEFAULT_DISPLAY;
}

/**
 * 将 category 映射为 severity。
 *
 * 映射规则（设计依据 ROUND-11-frontend.md §3.1.1）：
 * - transient -> warning（可重试，黄色 toast）
 * - permanent -> error（不可恢复，红色 banner）
 * - security -> error（安全拦截，红色 banner）
 * - protocol -> warning（协议违规，黄色 toast）
 * - runtime.aborted / provider.cancelled -> silent（用户主动取消，不打扰）
 * - 未知 category -> error（保守处理）
 */
function mapSeverity(payload: CrishErrorPayload): UserVisibleError['severity'] {
  // 用户主动取消：silent（不打扰）
  if (payload.code === 'runtime.aborted' || payload.code === 'provider.cancelled') {
    return 'silent';
  }
  switch (payload.category) {
    case 'transient':
      return 'warning';
    case 'permanent':
      return 'error';
    case 'security':
      return 'error';
    case 'protocol':
      return 'warning';
    default:
      return 'error';
  }
}

/**
 * 将 CrishErrorPayload 转换为用户可见的错误展示模型。
 *
 * 设计原则：
 * - 通过内置英文映射表查表，未命中码回退到通用英文文案
 * - public=false 的错误返回 visible=false（内部诊断码不展示给用户）
 * - severity=silent 的错误（runtime.aborted / provider.cancelled）消费方也应隐藏
 * - action 为 i18n 键，translate 提供时按 key 查本地化文案，否则用内置英文回退
 *
 * @param payload Rust 端 / daemon 传来的结构化错误负载
 * @param translate 可选的 i18n 查表函数，未提供时使用内置英文回退
 */
export function toUserVisibleError(
  payload: CrishErrorPayload,
  translate?: TranslateFn,
): UserVisibleError {
  const severity = mapSeverity(payload);
  const display = resolveDisplay(payload.code);
  const title = translate
    ? translate(`error.${payload.code}.title`, display.title)
    : display.title;
  const action = translate
    ? translate(payload.action, display.action)
    : display.action;
  return {
    visible: payload.public,
    title,
    message: payload.message,
    action,
    retryable: payload.retryable,
    code: payload.code,
    severity,
  };
}

/**
 * 解析 payload 的 action i18n 键为用户可见文案。
 *
 * translate 提供时按 payload.action（i18n 键）查本地化文案，未命中回退到内置英文 title。
 * translate 未提供时直接返回内置英文 title。
 */
export function resolveActionText(
  payload: CrishErrorPayload,
  translate?: TranslateFn,
): string {
  const display = resolveDisplay(payload.code);
  if (!translate) return display.action;
  return translate(payload.action, display.action);
}

/**
 * 解析 payload 的 title i18n 键为用户可见文案。
 *
 * translate 提供时按 `error.<code>.title` 查本地化文案，未命中回退到内置英文 title。
 * translate 未提供时直接返回内置英文 title。
 */
export function resolveTitleText(
  payload: CrishErrorPayload,
  translate?: TranslateFn,
): string {
  const display = resolveDisplay(payload.code);
  if (!translate) return display.title;
  return translate(`error.${payload.code}.title`, display.title);
}

/**
 * 将任意未知错误标准化为 CrishErrorPayload。
 *
 * 转换优先级（设计依据 ROUND-11-frontend.md §2.1 步骤 2）：
 * 1. null / undefined -> 兜底 common.unknown payload
 * 2. CrishError 实例 -> toErrorPayload()（保留 cause 链，补 timestamp）
 * 3. CrishErrorPayload（鸭子类型：含 code + category 字符串字段）-> 原样返回
 * 4. 字符串 -> fromUnknownError()（兜底 common.unknown，message=字符串）
 * 5. Error / 其他 -> fromUnknownError()（兜底 common.unknown）
 *
 * 此函数为 store 与 daemon client 的 try-catch 兜底入口，
 * 确保所有错误状态字段统一为 CrishErrorPayload 类型。
 */
export function normalizeCrishError(error: unknown): CrishErrorPayload {
  if (error === null || error === undefined) {
    return fromUnknownError(new Error('Unknown error'));
  }
  // CrishError 优先于鸭子类型检查（CrishError 也有 code/category 字段但缺 timestamp）
  if (error instanceof CrishError) {
    return toErrorPayload(error);
  }
  // 鸭子类型识别 CrishErrorPayload（纯数据对象，含 code + category 字符串字段）
  if (
    typeof error === 'object' &&
    typeof (error as Record<string, unknown>).code === 'string' &&
    typeof (error as Record<string, unknown>).category === 'string'
  ) {
    return error as CrishErrorPayload;
  }
  // 字符串 / Error / 其他 -> fromUnknownError 兜底
  return fromUnknownError(error);
}

/**
 * 从 CrishErrorPayload 反序列化为 CrishError 实例。
 *
 * 用途（设计依据 ROUND-11-frontend.md §2.1 步骤 3）：
 * - tauriInvoke.ts 的 error 路径：从 IpcResponse.error 还原 CrishError
 * - 测试断言：从 payload 构造 CrishError 以便 instanceof 判断
 *
 * cause 链递归还原，最多 CRISH_ERROR_CAUSE_MAX_DEPTH（8）层，
 * 与 toErrorPayload 的截断一致，避免无限递归。
 *
 * @param payload 跨进程序列化的错误负载
 * @param depth 当前递归深度（内部使用，外部调用不传）
 */
export function fromErrorPayload(
  payload: CrishErrorPayload,
  depth = 0,
): CrishError {
  const cause =
    depth < CRISH_ERROR_CAUSE_MAX_DEPTH && payload.cause !== undefined
      ? fromErrorPayload(payload.cause, depth + 1)
      : undefined;
  const options: { cause?: CrishError; public?: boolean; action?: string } = {
    public: payload.public,
    action: payload.action,
  };
  if (cause !== undefined) {
    options.cause = cause;
  }
  return new CrishError(
    payload.message,
    payload.code,
    payload.category,
    payload.retryable,
    payload.metadata,
    options,
  );
}
