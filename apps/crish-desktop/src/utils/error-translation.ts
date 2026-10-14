/**
 * 前端错误翻译层（Round 11-A / Wave 2 增强版）。
 *
 * 将 CrishErrorPayload / CrishError / Error / unknown 转化为 UserVisibleError（用户可见展示模型），
 * 并提供安全归一化、双向智能翻译回退、点分裸 key 刚性防御与动态参数插值。
 *
 * 约束：
 * - 仅依赖 @crish/shared-types，不引入新外部运行时依赖
 * - 通过内置英文映射表提供 title/action 回退，未命中码回退到通用英文文案
 * - translate 函数可选，未提供时使用内置英文回退字符串（或全局已注册的翻译器）
 * - 刚性拦截点分裸 key（如 action.tool.*、error.*.title），杜绝向终端用户展示裸 key
 * - 提供 interpolateParams 防御原型链污染（__proto__ / constructor / prototype）
 */

import {
  CrishError,
  toErrorPayload,
  fromUnknownError,
  isCrishErrorCode,
  CRISH_ERROR_CAUSE_MAX_DEPTH,
  type CrishErrorPayload,
  type CrishErrorCode,
  type CrishErrorCategory,
  type JsonObject,
} from '@crish/shared-types';

declare module '@crish/shared-types' {
  interface CrishErrorPayload {
    readonly params?: Record<string, unknown> | undefined;
  }
}

/** 用户可见的错误展示模型 */
export interface UserVisibleError {
  /** 是否对终端用户可见（由 payload.public 决定；severity=silent 时消费方也应隐藏） */
  readonly visible: boolean;
  /** 用户可见的标题（translate 提供时为本地化文案，否则为内置英文回退） */
  readonly title: string;
  /** 用户可见的消息（直接使用 payload.message 或参数插值后的文案） */
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
 * 调用方（如 Toast 组件、useI18n）注入自己的 t() 函数。
 * 支持可选的 params 参数用于模板安全插值。未命中翻译时回退到 fallback 字符串。
 */
export type TranslateFn = (
  key: string,
  fallback?: string,
  params?: Record<string, unknown>
) => string;

/**
 * 内置错误码 -> 英文 title/action 映射表。
 * 覆盖用户可见的高频码，未命中的码回退到 DEFAULT_DISPLAY 通用文案。
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
  // ── tool 域 ──
  'tool.not_found': {
    title: 'Tool not found',
    action: 'Please check the tool name and availability.',
  },
  'tool.exec_failed': {
    title: 'Tool execution failed',
    action: 'Please check tool parameters and try again.',
  },
  'tool.path_escape': {
    title: 'Path access violation',
    action: 'Operation outside allowed workspace is forbidden.',
  },
  'tool.permission_denied': {
    title: 'Tool permission denied',
    action: 'Please grant the required tool permissions.',
  },
  'tool.timeout': {
    title: 'Tool timeout',
    action: 'The tool execution timed out. Please retry.',
  },
  'tool.write_path_conflict': {
    title: 'File write conflict',
    action: 'Another operation is modifying this file. Retrying.',
  },
  // ── config 域 ──
  'config.invalid': {
    title: 'Invalid configuration',
    action: 'Please check the configuration settings.',
  },
  'config.missing': {
    title: 'Configuration missing',
    action: 'Please provide the required configuration value.',
  },
  'config.parse_failed': {
    title: 'Configuration parse error',
    action: 'Please verify configuration syntax.',
  },
  // ── session 域 ──
  'session.not_found': {
    title: 'Session not found',
    action: 'Please select an existing session or start a new one.',
  },
  'session.invalid_state': {
    title: 'Invalid session state',
    action: 'Please restart the session.',
  },
  'session.save_failed': {
    title: 'Session save failed',
    action: 'Retrying automatically.',
  },
  // ── plugin 域 ──
  'plugin.not_found': {
    title: 'Plugin not found',
    action: 'Please verify that the plugin is installed.',
  },
  'plugin.permission_denied': {
    title: 'Plugin permission denied',
    action: 'Please check plugin permissions in Settings.',
  },
  // ── security 域 ──
  'security.violation': {
    title: 'Security violation',
    action: 'Operation blocked for security reasons.',
  },
};

/** 内置 action 点分 key 到人格化英文操作建议的映射字典 */
export const BUILTIN_ACTION_DISPLAY: Readonly<Record<string, string>> = {
  // common
  'action.common.report_bug': 'Please try again or report the issue.',
  'action.common.check_field': 'Please check the input field and try again.',
  'action.common.check_encoding': 'Please use a supported text encoding.',
  'action.common.check_version': 'Please check the application version.',
  'action.common.check_resource': 'Please check the resource reference.',

  // config
  'action.config.check_field': 'Please check the configuration settings.',
  'action.config.provide_value':
    'Please provide the required configuration value.',
  'action.config.verify_syntax': 'Please verify configuration syntax.',

  // session
  'action.session.select_existing':
    'Please select an existing session or start a new one.',
  'action.session.restart': 'Please restart the session.',
  'action.session.check_entry': 'Please check the session entry and retry.',
  'action.session.refresh': 'Please refresh the session.',
  'action.session.retry_save': 'Retrying session save automatically.',
  'action.session.check_rewind_target': 'Please check the rewind target point.',
  'action.session.wait_switch': 'Please wait for the current switch to finish.',

  // agent
  'action.agent.increase_max_turns':
    'Please start a new session or increase max turns limit.',
  'action.agent.intervene':
    'Please review agent progress and intervene if necessary.',
  'action.agent.review': 'Please review the execution results.',

  // runtime
  'action.runtime.restart_session': 'Please restart the session.',
  'action.runtime.report_bug': 'Please report the issue.',
  'action.runtime.none': '',
  'action.runtime.retry': 'Please retry.',

  // provider
  'action.provider.check_network':
    'Service is temporarily unavailable. Please try again later.',
  'action.provider.disable_proxy': 'Please check network proxy settings.',
  'action.provider.wait_retry': 'Too many requests. Please wait and retry.',
  'action.provider.check_api_key': 'Please check the API key in Settings.',
  'action.provider.check_key': 'Please check the API key in Settings.',
  'action.provider.top_up': 'Please top up or switch providers.',
  'action.provider.check_endpoint':
    'Please check the provider endpoint in Settings.',
  'action.provider.fix_request':
    'Please adjust your prompt or request parameters.',
  'action.provider.retry': 'Please retry.',
  'action.provider.report_bug': 'Please report the issue.',
  'action.provider.check_connection':
    'Please check your connection to the model service.',
  'action.provider.reauth': 'Please re-authenticate your account in Settings.',

  // context
  'action.context.compact':
    'Please compact the context or start a new session.',
  'action.context.retry_compact': 'Please retry context compaction.',
  'action.context.manual_trim': 'Please manually clear earlier messages.',

  // tool
  'action.tool.check_name': 'Please check the tool name and availability.',
  'action.tool.fix_input': 'Please check and fix tool input arguments.',
  'action.tool.retry': 'Please retry the tool execution.',
  'action.tool.check_path': 'Please check the file path and permissions.',
  'action.tool.refresh_and_retry': 'Please refresh the tool state and retry.',
  'action.tool.request_path_allowance':
    'Please grant workspace access permissions.',
  'action.tool.wait_retry':
    'Another operation is running. Please wait and retry.',
  'action.tool.aborted_before_dispatch':
    'Tool execution was cancelled before start.',
  'action.tool.cancelled': 'Tool execution was cancelled.',
  'action.tool.outcome_unknown':
    'Tool outcome is unknown. Please verify manually.',
  'action.tool.exec_failed': 'Please check tool parameters and try again.',

  // browser
  'action.browser.wait_ready': 'Please wait for the browser to become ready.',
  'action.browser.check_target':
    'Please check the target browser tab or window.',
  'action.browser.enable_capability':
    'Please enable browser automation capability.',
  'action.browser.resnapshot': 'Please refresh the page snapshot.',
  'action.browser.check_whitelist': 'Please verify domain whitelist settings.',
  'action.browser.close_tabs': 'Please close unnecessary browser tabs.',
  'action.browser.check_version':
    'Please update your browser to a compatible version.',

  // computer
  'action.computer.fix_input':
    'Please check the input coordinates and parameters.',
  'action.computer.refresh_perception':
    'Please refresh the screen perception capture.',
  'action.computer.manual_operation': 'Please perform the operation manually.',
  'action.computer.enable_session': 'Please enable computer use permissions.',
  'action.computer.wait_retry': 'Please wait a moment and retry.',
  'action.computer.none': '',
  'action.computer.check_capability':
    'Please check OS accessibility permissions.',
  'action.computer.check_supported':
    'This action is not supported on the current platform.',

  // mcp
  'action.mcp.check_server': 'Please check the MCP server status.',
  'action.mcp.report_bug':
    'Please report the issue to the MCP server maintainer.',
  'action.mcp.check_config': 'Please check the MCP configuration file.',

  // store
  'action.store.retry_write': 'Retrying storage write automatically.',
  'action.store.retry_read': 'Retrying storage read automatically.',
  'action.store.restore_backup': 'Please restore from backup.',
  'action.store.cleanup_or_expand': 'Please clean up or expand storage.',

  // subagent
  'action.subagent.reduce_depth':
    'Please simplify the task to avoid deep nesting.',
  'action.subagent.ask_main_agent':
    'Please request delegation from the main agent.',
  'action.subagent.verify_id': 'Please verify the subagent ID.',
  'action.subagent.break_cycle': 'Please break the subagent dependency cycle.',
  'action.subagent.retry': 'Please retry the subagent task.',

  // plugin
  'action.plugin.check_install':
    'Please verify that the plugin is properly installed.',
  'action.plugin.check_manifest': 'Please check plugin manifest configuration.',
  'action.plugin.grant_permission':
    'Please grant plugin permissions in Settings.',

  // event_store
  'action.event_store.retry_append': 'Retrying event append automatically.',
  'action.event_store.rebuild_index': 'Please rebuild the event index.',
  'action.event_store.retry_read': 'Retrying event read automatically.',
  'action.event_store.check_disk': 'Please check disk space.',

  // security
  'action.security.check_target': 'Operation blocked for security reasons.',

  // goal
  'action.goal.review_progress': 'Please review goal progress.',
  'action.goal.break_loop': 'Goal loop detected. Please intervene.',
  'action.goal.increase_max_rounds':
    'Please increase the max rounds limit for this goal.',
};

/** 未知码的通用英文回退（未命中 BUILTIN_ERROR_DISPLAY 时使用） */
const DEFAULT_DISPLAY: Readonly<{
  readonly title: string;
  readonly action: string;
}> = {
  title: 'Error',
  action: 'Please try again or contact support.',
};

/** 查内置英文映射表，未命中返回通用回退 */
function resolveDisplay(code: string): {
  readonly title: string;
  readonly action: string;
} {
  return BUILTIN_ERROR_DISPLAY[code] ?? DEFAULT_DISPLAY;
}

/**
 * 将 category 映射为 severity。
 *
 * 映射规则：
 * - transient -> warning（可重试，黄色 toast）
 * - permanent -> error（不可恢复，红色 banner）
 * - security -> error（安全拦截，红色 banner）
 * - protocol -> warning（协议违规，黄色 toast）
 * - runtime.aborted / provider.cancelled -> silent（用户主动取消，不打扰）
 * - 未知 category -> error（保守处理）
 */
function mapSeverity(payload: CrishErrorPayload): UserVisibleError['severity'] {
  // 用户主动取消：silent（不打扰）
  if (
    payload.code === 'runtime.aborted' ||
    payload.code === 'provider.cancelled'
  ) {
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

let activeTranslateFn: TranslateFn | null = null;

/**
 * 注册全局默认的错误翻译函数（通常由 I18nProvider / useI18n 注入）。
 * 当未显式传入 translate 时，自动使用已注册的翻译函数解析错误标题与操作建议。
 */
export function registerErrorTranslateFn(fn: TranslateFn | null): void {
  activeTranslateFn = fn;
}

/**
 * 获取当前全局注册的错误翻译函数。
 */
export function getErrorTranslateFn(): TranslateFn | null {
  return activeTranslateFn;
}

/**
 * 判断给定值是否为未翻译的点分裸 key（例如 "action.tool.exec_failed" 或 "error.provider.network.title"）。
 * 刚性防御：用于拦截并降级暴露给用户的裸配置键。
 */
export function isBareKey(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  // 包含空格或换行则必定是可读语句或翻译后的文案，不是裸 key
  if (/\s/.test(trimmed)) return false;
  // 满足点分标识符格式：形如 a.b 或 a.b.c，且仅由字母、数字、下划线、短横线、点组成
  return /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)+$/.test(trimmed);
}

/**
 * 将 action 点分 key 解析为人格化的可读英文文案，杜绝直接向终端用户暴露裸 key。
 */
export function resolveActionKeyFallback(actionKey: string): string {
  if (!actionKey) return '';
  const found = BUILTIN_ACTION_DISPLAY[actionKey];
  if (found !== undefined) {
    return found;
  }
  if (isBareKey(actionKey)) {
    const parts = actionKey.split('.');
    const domain = parts[1] ?? 'operation';
    const actionName = parts.slice(2).join(' ').replace(/[_-]+/g, ' ');
    if (actionName) {
      return `Please check ${domain} ${actionName} and try again.`;
    }
    return DEFAULT_DISPLAY.action;
  }
  return actionKey;
}

/**
 * 安全的模板参数插值函数，严格防御原型链注入（__proto__ / constructor / prototype）。
 * 针对复杂对象/数组自动以安全 JSON 序列化，杜绝 "[object Object]" 裸露。
 */
export function interpolateParams(
  template: string,
  params?: Record<string, unknown>
): string {
  if (typeof template !== 'string') {
    return '';
  }
  if (!params || typeof params !== 'object') {
    return template;
  }
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, paramKey) => {
    if (
      paramKey === '__proto__' ||
      paramKey === 'constructor' ||
      paramKey === 'prototype' ||
      !Object.prototype.hasOwnProperty.call(params, paramKey)
    ) {
      return match;
    }
    const val = params[paramKey];
    if (val === null || val === undefined) {
      return '';
    }
    if (typeof val === 'number') {
      if (Number.isNaN(val) || !Number.isFinite(val)) {
        return '-';
      }
      return String(val);
    }
    if (val instanceof Error) {
      return val.message || String(val);
    }
    if (typeof val === 'object') {
      try {
        const json = JSON.stringify(val);
        return json !== undefined ? json : '';
      } catch {
        return '';
      }
    }
    if (typeof val === 'function') {
      return '';
    }
    return String(val);
  });
}

/**
 * 提取并合并用于模板插值的动态参数：
 * 优先级：payload 基础字段 ({ code, message, category }) < metadata < params (Rust/IPC 动态参数) < 显式调用参数 params
 */
function extractPayloadParams(
  payload: CrishErrorPayload,
  explicitParams?: Record<string, unknown>
): Record<string, unknown> {
  const rawParams = (payload as { params?: unknown }).params;
  const metadataMap =
    payload.metadata &&
    typeof payload.metadata === 'object' &&
    !Array.isArray(payload.metadata)
      ? (payload.metadata as Record<string, unknown>)
      : {};
  const paramsMap =
    rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? (rawParams as Record<string, unknown>)
      : {};

  return {
    code: payload.code,
    message: payload.message,
    category: payload.category,
    ...metadataMap,
    ...paramsMap,
    ...(explicitParams ?? {}),
  };
}

/**
 * 双向智能翻译调用包装：
 * 1. 优先调用外部注入的 translate 函数；
 * 2. 若 translate 翻译成功且返回非裸 key，直接采用；
 * 3. 若 translate 返回了特定的外部裸 key，尝试就地解析该裸 key；
 * 4. 若 fallback 已经是非裸 key 的有效文案（例如 BUILTIN_ERROR_DISPLAY），平滑回退至 fallback；
 * 5. 若 fallback 也是裸 key，自动通过 resolveActionKeyFallback 展开为人格化文案；
 * 6. 终极双重守门，杜绝任何裸 key 返回，并自动执行参数插值格式化。
 */
function safeTranslate(
  translate: TranslateFn | undefined,
  key: string,
  fallback: string,
  params?: Record<string, unknown>,
  isTitle = false
): string {
  let translated: string | undefined;

  if (translate && key) {
    try {
      translated = translate(key, fallback, params);
    } catch {
      translated = undefined;
    }
  }

  // 若 translate 成功且返回了非裸 key 的有效文案，直接使用
  if (translated && translated !== key && !isBareKey(translated)) {
    return interpolateParams(translated, params);
  }

  // 若 translate 返回了一个特定的不同裸 key，优先尝试将其解析为人格化文案
  if (translated && isBareKey(translated) && translated !== key) {
    const resolvedFromTranslated = !isTitle
      ? resolveActionKeyFallback(translated)
      : undefined;
    if (resolvedFromTranslated && !isBareKey(resolvedFromTranslated)) {
      return interpolateParams(resolvedFromTranslated, params);
    }
  }

  // 降级漏斗 1：若 fallback 已经是非裸 key 的有效文案（如 BUILTIN_ERROR_DISPLAY 中的英文文案），优先使用 fallback
  if (fallback && !isBareKey(fallback)) {
    return interpolateParams(fallback, params);
  }

  // 降级漏斗 2：若 fallback 是裸 key，或者 fallback 为空，尝试将 key 或 fallback 解析为人格化文案
  const bareKey = isBareKey(fallback) ? fallback : key;
  const resolved = isTitle
    ? DEFAULT_DISPLAY.title
    : resolveActionKeyFallback(bareKey);

  const finalStr =
    resolved || (isTitle ? DEFAULT_DISPLAY.title : DEFAULT_DISPLAY.action);
  return interpolateParams(finalStr, params);
}

/**
 * 将任意错误（CrishErrorPayload、CrishError、标准 Error、原始字符串或未知对象）
 * 转换为用户可见的错误展示模型。
 *
 * @param input 输入错误对象，支持多态归一化
 * @param translate 可选的 i18n 查表函数，未提供时使用内置英文回退（或全局已注册的翻译器）
 * @param params 可选的动态格式化参数，用于模板安全插值
 */
export function toUserVisibleError(
  input: unknown,
  translate?: TranslateFn,
  params?: Record<string, unknown>
): UserVisibleError {
  const payload = normalizeCrishError(input);
  const effectiveTranslate = translate ?? activeTranslateFn ?? undefined;
  const severity = mapSeverity(payload);
  const display = resolveDisplay(payload.code);

  const mergedParams = extractPayloadParams(payload, params);

  const title = safeTranslate(
    effectiveTranslate,
    `error.${payload.code}.title`,
    display.title,
    mergedParams,
    true
  );

  let action = '';
  if (
    payload.code === 'runtime.aborted' ||
    payload.code === 'provider.cancelled' ||
    payload.action === 'action.runtime.none' ||
    payload.action === 'action.telemetry.none' ||
    payload.action === 'action.computer.none'
  ) {
    action = '';
  } else {
    action = safeTranslate(
      effectiveTranslate,
      payload.action,
      display.action,
      mergedParams,
      false
    );
  }

  const message = interpolateParams(payload.message, mergedParams);

  return {
    visible: payload.public,
    title,
    message,
    action,
    retryable: payload.retryable,
    code: payload.code,
    severity,
  };
}

/**
 * 解析 payload 的 action i18n 键为用户可见文案。
 *
 * translate 提供时按 payload.action 查本地化文案，未命中回退到内置英文 action。
 * translate 未提供时使用全局注册的翻译器或直接返回内置英文 action。
 */
export function resolveActionText(
  input: unknown,
  translate?: TranslateFn,
  params?: Record<string, unknown>
): string {
  const payload = normalizeCrishError(input);
  const effectiveTranslate = translate ?? activeTranslateFn ?? undefined;
  const display = resolveDisplay(payload.code);
  const mergedParams = extractPayloadParams(payload, params);

  if (
    payload.code === 'runtime.aborted' ||
    payload.code === 'provider.cancelled' ||
    payload.action === 'action.runtime.none' ||
    payload.action === 'action.telemetry.none' ||
    payload.action === 'action.computer.none'
  ) {
    return '';
  }

  return safeTranslate(
    effectiveTranslate,
    payload.action,
    display.action,
    mergedParams,
    false
  );
}

/**
 * 解析 payload 的 title i18n 键为用户可见文案。
 *
 * translate 提供时按 `error.<code>.title` 查本地化文案，未命中回退到内置英文 title。
 * translate 未提供时使用全局注册的翻译器或直接返回内置英文 title。
 */
export function resolveTitleText(
  input: unknown,
  translate?: TranslateFn,
  params?: Record<string, unknown>
): string {
  const payload = normalizeCrishError(input);
  const effectiveTranslate = translate ?? activeTranslateFn ?? undefined;
  const display = resolveDisplay(payload.code);
  const mergedParams = extractPayloadParams(payload, params);

  return safeTranslate(
    effectiveTranslate,
    `error.${payload.code}.title`,
    display.title,
    mergedParams,
    true
  );
}

/**
 * 将任意未知错误标准化为 CrishErrorPayload。
 *
 * 转换优先级：
 * 1. null / undefined -> 兜底 common.unknown payload
 * 2. CrishError 实例 -> toErrorPayload()（保留 cause 链，补 timestamp）
 * 3. CrishErrorPayload（鸭子类型：含 code + category 字符串字段）-> 原样/安全规整返回
 * 4. 普通对象含 code 字段 -> 查表补齐元数据
 * 5. 字符串 / Error / 其他 -> fromUnknownError()（兜底 common.unknown）
 */
export function normalizeCrishError(error: unknown): CrishErrorPayload {
  if (error === null || error === undefined) {
    return fromUnknownError(new Error('Unknown error'));
  }
  // CrishError 优先于鸭子类型检查（CrishError 也有 code/category 字段但缺 timestamp）
  if (error instanceof CrishError) {
    const payload = toErrorPayload(error);
    const rawParams = (error as { params?: unknown }).params;
    if (
      rawParams &&
      typeof rawParams === 'object' &&
      !Array.isArray(rawParams)
    ) {
      return {
        ...payload,
        params: rawParams as Record<string, unknown>,
      };
    }
    return payload;
  }
  // 鸭子类型识别 CrishErrorPayload（纯数据对象，含 code + category 字符串字段）
  if (
    typeof error === 'object' &&
    typeof (error as Record<string, unknown>).code === 'string' &&
    typeof (error as Record<string, unknown>).category === 'string'
  ) {
    return error as CrishErrorPayload;
  }
  // 识别包含 code 字段但缺 category 的错误对象（如 IPC 简略错误）
  if (
    typeof error === 'object' &&
    typeof (error as Record<string, unknown>).code === 'string'
  ) {
    const obj = error as Record<string, unknown>;
    const codeStr = obj.code as string;
    const isCodeValid = isCrishErrorCode(codeStr);
    const display = resolveDisplay(codeStr);
    const isTransient =
      codeStr.endsWith('.network') ||
      codeStr.endsWith('.timeout') ||
      codeStr.endsWith('.rate_limit');
    return {
      code: (isCodeValid ? codeStr : 'common.unknown') as CrishErrorCode,
      message: typeof obj.message === 'string' ? obj.message : display.title,
      category: (isTransient ? 'transient' : 'permanent') as CrishErrorCategory,
      retryable: isTransient,
      public: true,
      action:
        typeof obj.action === 'string'
          ? obj.action
          : 'action.common.report_bug',
      timestamp: Date.now(),
      ...(obj.params !== undefined &&
      typeof obj.params === 'object' &&
      !Array.isArray(obj.params)
        ? { params: obj.params as Record<string, unknown> }
        : {}),
      ...(obj.metadata !== undefined
        ? { metadata: obj.metadata as JsonObject }
        : {}),
      ...(typeof obj.stack === 'string' ? { stack: obj.stack } : {}),
    };
  }
  // 字符串 / Error / 其他 -> fromUnknownError 兜底
  return fromUnknownError(error);
}

/**
 * 从 CrishErrorPayload 反序列化为 CrishError 实例。
 *
 * @param payload 跨进程序列化的错误负载
 * @param depth 当前递归深度（内部使用，外部调用不传）
 */
export function fromErrorPayload(
  payload: CrishErrorPayload,
  depth = 0
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
    options
  );
}
