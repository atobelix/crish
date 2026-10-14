import { describe, expect, it } from 'vitest';
import { CrishError, type CrishErrorPayload } from '@crish/shared-types';
import {
  toUserVisibleError,
  normalizeCrishError,
  fromErrorPayload,
  resolveActionText,
  resolveTitleText,
  isBareKey,
  resolveActionKeyFallback,
  interpolateParams,
  registerErrorTranslateFn,
  getErrorTranslateFn,
} from './error-translation';

/** 构造测试用 CrishErrorPayload 的辅助函数 */
function makePayload(
  overrides: Partial<CrishErrorPayload> = {}
): CrishErrorPayload {
  return {
    code: 'common.unknown',
    message: 'test message',
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.common.report_bug',
    timestamp: 1700000000000,
    ...overrides,
  };
}

/** 构造深度为 N 的 cause 链 payload（顶层 cause 指向下一层，直到 level 0） */
function makeDeepChainPayload(levels: number): CrishErrorPayload {
  let payload: CrishErrorPayload = makePayload({
    message: 'level 0',
    code: 'common.unknown',
  });
  for (let i = 1; i <= levels; i++) {
    payload = makePayload({
      message: `level ${i}`,
      code: 'common.unknown',
      cause: payload,
    });
  }
  return payload;
}

describe('toUserVisibleError', () => {
  it('transient category maps to severity warning and retryable true', () => {
    const payload = makePayload({
      code: 'provider.network',
      message: 'Connection refused',
      category: 'transient',
      retryable: true,
    });
    const visible = toUserVisibleError(payload);
    expect(visible.severity).toBe('warning');
    expect(visible.retryable).toBe(true);
    expect(visible.visible).toBe(true);
    expect(visible.code).toBe('provider.network');
    expect(visible.message).toBe('Connection refused');
  });

  it('permanent category maps to severity error and retryable false', () => {
    const payload = makePayload({
      code: 'config.invalid',
      message: 'bad config',
      category: 'permanent',
      retryable: false,
    });
    const visible = toUserVisibleError(payload);
    expect(visible.severity).toBe('error');
    expect(visible.retryable).toBe(false);
  });

  it('runtime.aborted code maps to severity silent', () => {
    const payload = makePayload({
      code: 'runtime.aborted',
      message: 'user aborted',
      category: 'permanent',
      retryable: false,
    });
    const visible = toUserVisibleError(payload);
    expect(visible.severity).toBe('silent');
    expect(visible.title).toBe('Aborted');
    expect(visible.action).toBe('');
  });

  it('aborted 静默语义：severity=silent 时即便 public=true 消费方也不得 toast（05 §2.10）', () => {
    const payload = makePayload({
      code: 'runtime.aborted',
      message: 'user aborted',
      category: 'permanent',
      retryable: false,
      public: true,
    });
    const visible = toUserVisibleError(payload);
    // 用户主动取消：不打扰。visible 仍为 true（展示模型可透传），
    // 但消费方必须按 severity=silent 隐藏（不 toast / 不 banner）。
    expect(visible.visible).toBe(true);
    expect(visible.severity).toBe('silent');
    expect(visible.retryable).toBe(false);
  });

  it('provider.cancelled code maps to severity silent', () => {
    const payload = makePayload({
      code: 'provider.cancelled',
      message: 'cancelled by user',
      category: 'permanent',
      retryable: false,
    });
    const visible = toUserVisibleError(payload);
    expect(visible.severity).toBe('silent');
  });

  it('security category maps to severity error', () => {
    const payload = makePayload({
      code: 'provider.auth',
      message: 'bad key',
      category: 'security',
      retryable: false,
    });
    const visible = toUserVisibleError(payload);
    expect(visible.severity).toBe('error');
  });

  it('protocol category maps to severity warning', () => {
    const payload = makePayload({
      code: 'provider.schema',
      message: 'bad schema',
      category: 'protocol',
      retryable: false,
    });
    const visible = toUserVisibleError(payload);
    expect(visible.severity).toBe('warning');
  });

  it('public=false maps to visible=false', () => {
    const payload = makePayload({
      code: 'telemetry.trace_lost',
      message: 'trace buffer overflow',
      category: 'transient',
      retryable: true,
      public: false,
    });
    const visible = toUserVisibleError(payload);
    expect(visible.visible).toBe(false);
  });

  it('unknown code falls back to generic English message', () => {
    const payload = makePayload({
      code: 'goal.stalled' as CrishErrorPayload['code'],
      message: 'goal stalled',
      category: 'permanent',
      retryable: false,
    });
    const visible = toUserVisibleError(payload);
    // goal.stalled not in BUILTIN_ERROR_DISPLAY -> DEFAULT_DISPLAY
    expect(visible.title).toBe('Error');
    expect(visible.action).toBe('Please try again or contact support.');
  });

  it('known code uses built-in English title and action', () => {
    const payload = makePayload({
      code: 'provider.network',
      message: 'Connection refused',
      category: 'transient',
      retryable: true,
    });
    const visible = toUserVisibleError(payload);
    expect(visible.title).toBe('Network error');
    expect(visible.action).toBe(
      'Service is temporarily unavailable. Please try again later.'
    );
  });

  it('uses translate function when provided', () => {
    const payload = makePayload({
      code: 'provider.network',
      message: 'Connection refused',
      category: 'transient',
      retryable: true,
      action: 'action.provider.check_network',
    });
    const translate = (key: string, fallback?: string) =>
      `[zh] ${key} :: ${fallback ?? ''}`;
    const visible = toUserVisibleError(payload, translate);
    expect(visible.title).toBe(
      '[zh] error.provider.network.title :: Network error'
    );
    expect(visible.action).toBe(
      '[zh] action.provider.check_network :: Service is temporarily unavailable. Please try again later.'
    );
  });

  it('resolveActionText returns built-in action without translate', () => {
    const payload = makePayload({
      code: 'provider.timeout',
      category: 'transient',
      retryable: true,
    });
    expect(resolveActionText(payload)).toBe(
      'The request timed out. Please retry.'
    );
  });

  it('resolveTitleText returns built-in title without translate', () => {
    const payload = makePayload({
      code: 'store.corrupted',
      category: 'permanent',
      retryable: false,
    });
    expect(resolveTitleText(payload)).toBe('Storage corrupted');
  });
});

// ── T04.3 前端错误码化：77 码体系新码映射（store.*/event_store.*/common.*）──
describe('error code mapping for store/event_store/common domains (T04.3)', () => {
  it('store.io maps to built-in title', () => {
    const payload = makePayload({
      code: 'store.io',
      message: 'disk io error',
      category: 'transient',
      retryable: true,
    });
    const visible = toUserVisibleError(payload);
    expect(visible.title).toBe('Storage I/O error');
    expect(visible.action).toBe('Retrying automatically.');
    expect(visible.retryable).toBe(true);
  });

  it('event_store.append_failed maps to built-in title', () => {
    const payload = makePayload({
      code: 'event_store.append_failed',
      message: 'append failed',
      category: 'transient',
      retryable: true,
    });
    const visible = toUserVisibleError(payload);
    expect(visible.title).toBe('Event append failed');
    expect(visible.action).toBe('Retrying automatically.');
  });

  it('event_store.read_failed maps to built-in title', () => {
    const payload = makePayload({
      code: 'event_store.read_failed',
      message: 'read failed',
      category: 'transient',
      retryable: true,
    });
    expect(toUserVisibleError(payload).title).toBe('Event read failed');
  });

  it('event_store.consistency_violation maps to built-in title', () => {
    const payload = makePayload({
      code: 'event_store.consistency_violation',
      message: 'consistency violation',
      category: 'permanent',
      retryable: false,
    });
    const visible = toUserVisibleError(payload);
    expect(visible.title).toBe('Event consistency error');
    expect(visible.action).toBe('Please rebuild the index.');
  });

  it('event_store.degraded maps to built-in title', () => {
    const payload = makePayload({
      code: 'event_store.degraded',
      message: 'degraded',
      category: 'permanent',
      retryable: false,
    });
    const visible = toUserVisibleError(payload);
    expect(visible.title).toBe('Event storage degraded');
    expect(visible.action).toBe('Please check disk space.');
  });

  it('common.invalid_input maps to built-in title', () => {
    const payload = makePayload({
      code: 'common.invalid_input',
      message: 'bad input',
      category: 'permanent',
      retryable: false,
    });
    expect(toUserVisibleError(payload).title).toBe('Invalid input');
  });

  it('common.encoding maps to built-in title', () => {
    const payload = makePayload({
      code: 'common.encoding',
      message: 'bad encoding',
      category: 'permanent',
      retryable: false,
    });
    expect(toUserVisibleError(payload).title).toBe('Encoding error');
  });

  it('agent.max_turns_reached maps to built-in title', () => {
    const payload = makePayload({
      code: 'agent.max_turns_reached',
      message: 'max turns reached',
      category: 'permanent',
      retryable: false,
    });
    const visible = toUserVisibleError(payload);
    expect(visible.title).toBe('Turn limit reached');
    expect(visible.action).toBe(
      'Please start a new session or shorten the task.'
    );
  });

  it('context.length_exceeded maps to built-in title', () => {
    const payload = makePayload({
      code: 'context.length_exceeded',
      message: 'context too long',
      category: 'transient',
      retryable: true,
    });
    const visible = toUserVisibleError(payload);
    expect(visible.title).toBe('Context length exceeded');
    expect(visible.action).toBe(
      'Please shorten the task or start a new session.'
    );
  });

  it('normalizeCrishError preserves the typed store code', () => {
    const result = normalizeCrishError({
      code: 'event_store.append_failed',
      message: 'append failed',
      category: 'transient',
      retryable: true,
      public: false,
    });
    expect(result.code).toBe('event_store.append_failed');
    const visible = toUserVisibleError(result);
    expect(visible.title).toBe('Event append failed');
  });
});

describe('normalizeCrishError', () => {
  it('returns CrishErrorPayload as-is', () => {
    const payload = makePayload({
      code: 'provider.timeout',
      message: 'timed out',
      category: 'transient',
      retryable: true,
    });
    const result = normalizeCrishError(payload);
    expect(result).toBe(payload);
  });

  it('wraps string with common.unknown code', () => {
    const result = normalizeCrishError('something went wrong');
    expect(result.code).toBe('common.unknown');
    expect(result.message).toBe('something went wrong');
    expect(result.category).toBe('permanent');
    expect(result.retryable).toBe(false);
  });

  it('wraps Error with error.message', () => {
    const result = normalizeCrishError(new Error('boom'));
    expect(result.code).toBe('common.unknown');
    expect(result.message).toBe('boom');
    expect(result.category).toBe('permanent');
    expect(result.retryable).toBe(false);
  });

  it('returns default payload for null', () => {
    const result = normalizeCrishError(null);
    expect(result.code).toBe('common.unknown');
    expect(result.message).toBe('Unknown error');
    expect(result.category).toBe('permanent');
    expect(result.retryable).toBe(false);
  });

  it('returns default payload for undefined', () => {
    const result = normalizeCrishError(undefined);
    expect(result.code).toBe('common.unknown');
    expect(result.message).toBe('Unknown error');
  });

  it('converts CrishError instance to payload via toErrorPayload', () => {
    const cause = new CrishError(
      'underlying',
      'provider.network',
      'transient',
      true
    );
    const err = new CrishError(
      'timeout',
      'provider.timeout',
      'transient',
      true,
      undefined,
      { cause }
    );
    const result = normalizeCrishError(err);
    expect(result.code).toBe('provider.timeout');
    expect(result.message).toBe('timeout');
    expect(result.category).toBe('transient');
    expect(result.retryable).toBe(true);
    expect(result.cause).toBeDefined();
    expect(result.cause?.code).toBe('provider.network');
    expect(result.timestamp).toBeTypeOf('number');
  });
});

describe('fromErrorPayload', () => {
  it('reconstructs CrishError from payload', () => {
    const payload = makePayload({
      code: 'provider.timeout',
      message: 'request timed out',
      category: 'transient',
      retryable: true,
    });
    const err = fromErrorPayload(payload);
    expect(err).toBeInstanceOf(CrishError);
    expect(err.message).toBe('request timed out');
    expect(err.code).toBe('provider.timeout');
    expect(err.category).toBe('transient');
    expect(err.retryable).toBe(true);
  });

  it('reconstructs cause chain recursively', () => {
    const payload = makePayload({
      code: 'provider.timeout',
      message: 'request timed out',
      category: 'transient',
      retryable: true,
      cause: makePayload({
        code: 'provider.network',
        message: 'underlying network error',
        category: 'transient',
        retryable: true,
      }),
    });
    const err = fromErrorPayload(payload);
    expect(err).toBeInstanceOf(CrishError);
    expect(err.cause).toBeInstanceOf(CrishError);
    expect(err.cause?.code).toBe('provider.network');
    expect(err.cause?.message).toBe('underlying network error');
  });

  it('truncates cause chain at depth 8', () => {
    // 12-level chain: level 12 -> level 11 -> ... -> level 0
    const payload = makeDeepChainPayload(12);
    const err = fromErrorPayload(payload);
    // Walk the chain and count levels
    let current: CrishError | undefined = err;
    let count = 0;
    while (current !== undefined) {
      count++;
      current = current.cause;
    }
    // depth 0-7 recurse (8 edges), depth 8 stops -> 9 levels total
    expect(count).toBe(9);
  });

  it('preserves public and action fields', () => {
    const payload = makePayload({
      code: 'provider.auth',
      message: 'bad key',
      category: 'security',
      retryable: false,
      public: true,
      action: 'action.provider.check_api_key',
    });
    const err = fromErrorPayload(payload);
    expect(err.public).toBe(true);
    expect(err.action).toBe('action.provider.check_api_key');
  });

  it('preserves metadata field', () => {
    const payload = makePayload({
      code: 'common.unknown',
      message: 'with meta',
      category: 'permanent',
      retryable: false,
      metadata: { legacyCode: 42, source: 'test' },
    });
    const err = fromErrorPayload(payload);
    expect(err.metadata).toEqual({ legacyCode: 42, source: 'test' });
  });

  it('handles payload without cause (no recursion)', () => {
    const payload = makePayload({
      code: 'common.unknown',
      message: 'no cause',
      category: 'permanent',
      retryable: false,
    });
    const err = fromErrorPayload(payload);
    expect(err.cause).toBeUndefined();
  });
});

describe('polymorphic inputs to toUserVisibleError', () => {
  it('directly handles CrishError instance', () => {
    const err = new CrishError(
      'Subagent nesting exceeded',
      'subagent.depth_exceeded',
      'transient',
      true
    );
    const visible = toUserVisibleError(err);
    expect(visible.code).toBe('subagent.depth_exceeded');
    expect(visible.message).toBe('Subagent nesting exceeded');
    expect(visible.title).toBe('Subagent depth exceeded');
    expect(visible.retryable).toBe(true);
    expect(visible.severity).toBe('warning');
  });

  it('directly handles standard Error instance', () => {
    const err = new Error('Database locked');
    const visible = toUserVisibleError(err);
    expect(visible.code).toBe('common.unknown');
    expect(visible.message).toBe('Database locked');
    expect(visible.title).toBe('Unknown error');
    expect(visible.severity).toBe('error');
    expect(visible.retryable).toBe(false);
  });

  it('directly handles raw string error message', () => {
    const visible = toUserVisibleError('Raw network timeout');
    expect(visible.code).toBe('common.unknown');
    expect(visible.message).toBe('Raw network timeout');
    expect(visible.title).toBe('Unknown error');
  });

  it('directly handles null and undefined inputs', () => {
    const visibleNull = toUserVisibleError(null);
    expect(visibleNull.code).toBe('common.unknown');
    expect(visibleNull.message).toBe('Unknown error');

    const visibleUndefined = toUserVisibleError(undefined);
    expect(visibleUndefined.code).toBe('common.unknown');
    expect(visibleUndefined.message).toBe('Unknown error');
  });

  it('handles object with code but missing category for known code', () => {
    const visible = toUserVisibleError({
      code: 'provider.network',
      message: 'Failed to reach host',
    });
    expect(visible.code).toBe('provider.network');
    expect(visible.message).toBe('Failed to reach host');
    expect(visible.severity).toBe('warning'); // transient mapped to warning
    expect(visible.title).toBe('Network error');
  });

  it('handles object with code but missing category for unknown code', () => {
    const visible = toUserVisibleError({
      code: 'nonexistent.code.123',
      message: 'Some failure',
    });
    expect(visible.code).toBe('common.unknown');
    expect(visible.message).toBe('Some failure');
    expect(visible.title).toBe('Unknown error');
  });

  it('handles arbitrary unknown object input', () => {
    const visible = toUserVisibleError({ unexpectedField: 12345 });
    expect(visible.code).toBe('common.unknown');
    expect(visible.title).toBe('Unknown error');
    expect(visible.severity).toBe('error');
  });
});

describe('interpolateParams and parameter formatting', () => {
  it('interpolates single and multiple matching variables', () => {
    const res = interpolateParams('Tool {tool} failed with exit code {code}', {
      tool: 'bash',
      code: 127,
    });
    expect(res).toBe('Tool bash failed with exit code 127');
  });

  it('leaves unmatched variables intact', () => {
    const res = interpolateParams('Hello {name}, your role is {role}', {
      name: 'Alice',
    });
    expect(res).toBe('Hello Alice, your role is {role}');
  });

  it('converts null and undefined parameters to empty strings', () => {
    const res = interpolateParams('User {name} id {id}', {
      name: null,
      id: undefined,
    });
    expect(res).toBe('User  id ');
  });

  it('defends against prototype pollution tokens', () => {
    const maliciousParams = JSON.parse(
      '{"__proto__": "polluted", "constructor": "bad", "prototype": "bad"}'
    );
    const res = interpolateParams(
      'Safe {__proto__} {constructor} {prototype}',
      maliciousParams
    );
    expect(res).toBe('Safe {__proto__} {constructor} {prototype}');
  });

  it('gracefully handles non-string templates and non-object params', () => {
    expect(interpolateParams(null as unknown as string)).toBe('');
    expect(interpolateParams(undefined as unknown as string)).toBe('');
    expect(
      interpolateParams(
        'Static string',
        null as unknown as Record<string, unknown>
      )
    ).toBe('Static string');
    expect(interpolateParams('Static string', undefined)).toBe('Static string');
  });

  it('toUserVisibleError applies params to message and translate function', () => {
    const payload = makePayload({
      code: 'tool.exec_failed',
      message: 'Command {cmd} failed with code {exitCode}',
      category: 'permanent',
    });
    const visible = toUserVisibleError(payload, undefined, {
      cmd: 'git fetch',
      exitCode: 1,
    });
    expect(visible.message).toBe('Command git fetch failed with code 1');
  });

  it('toUserVisibleError automatically merges payload.metadata for interpolation', () => {
    const payload = makePayload({
      code: 'tool.exec_failed',
      message: 'Execution of {toolName} timed out after {timeoutSec}s',
      metadata: { toolName: 'ripgrep', timeoutSec: 30 },
    });
    const visible = toUserVisibleError(payload);
    expect(visible.message).toBe('Execution of ripgrep timed out after 30s');
  });
});

describe('bare key rigid defense and smart fallback', () => {
  it('isBareKey accurately detects bare dot-separated keys', () => {
    expect(isBareKey('action.tool.exec_failed')).toBe(true);
    expect(isBareKey('error.provider.network.title')).toBe(true);
    expect(isBareKey('common.unknown')).toBe(true);
    expect(isBareKey('tool.write_path_conflict')).toBe(true);

    expect(isBareKey('Network error')).toBe(false);
    expect(isBareKey('Please try again or report the issue.')).toBe(false);
    expect(isBareKey('网络错误')).toBe(false);
    expect(isBareKey('')).toBe(false);
    expect(isBareKey('   ')).toBe(false);
    expect(isBareKey(12345)).toBe(false);
    expect(isBareKey(null)).toBe(false);
    expect(isBareKey(undefined)).toBe(false);
  });

  it('resolveActionKeyFallback resolves known action keys to English text', () => {
    expect(resolveActionKeyFallback('action.common.report_bug')).toBe(
      'Please try again or report the issue.'
    );
    expect(resolveActionKeyFallback('action.provider.check_api_key')).toBe(
      'Please check the API key in Settings.'
    );
    expect(resolveActionKeyFallback('action.tool.retry')).toBe(
      'Please retry the tool execution.'
    );
    expect(resolveActionKeyFallback('action.runtime.none')).toBe('');
  });

  it('resolveActionKeyFallback humanizes unknown action keys rather than exposing bare dotted keys', () => {
    const humanized = resolveActionKeyFallback(
      'action.tool.custom_sandbox_fail'
    );
    expect(humanized).toBe(
      'Please check tool custom sandbox fail and try again.'
    );
    expect(isBareKey(humanized)).toBe(false);

    const fallbackGeneric = resolveActionKeyFallback(
      'unknown_bare_key.without_action_prefix'
    );
    expect(isBareKey(fallbackGeneric)).toBe(false);
  });

  it('resolveActionKeyFallback handles empty string and plain readable text', () => {
    expect(resolveActionKeyFallback('')).toBe('');
    expect(resolveActionKeyFallback('Already human readable text')).toBe(
      'Already human readable text'
    );
  });

  it('toUserVisibleError defends against translateFn returning bare key identical to queried key', () => {
    const payload = makePayload({
      code: 'provider.network',
      action: 'action.provider.check_network',
    });
    // Mock translate function that returns the key itself on miss (common i18n miss behavior)
    const mockReturningKeyTranslate = (key: string) => key;

    const visible = toUserVisibleError(payload, mockReturningKeyTranslate);

    // Title should fall back to built-in 'Network error', NOT 'error.provider.network.title'
    expect(visible.title).toBe('Network error');
    // Action should fall back to built-in human action, NOT 'action.provider.check_network'
    expect(visible.action).toBe(
      'Service is temporarily unavailable. Please try again later.'
    );
    expect(isBareKey(visible.title)).toBe(false);
    expect(isBareKey(visible.action)).toBe(false);
  });

  it('toUserVisibleError defends against translateFn returning a different bare dotted key', () => {
    const payload = makePayload({
      code: 'common.unknown',
      action: 'action.common.report_bug',
    });
    // Translate returning another dotted key
    const mockDottedTranslate = () => 'action.tool.exec_failed';

    const visible = toUserVisibleError(payload, mockDottedTranslate);

    // Must be humanized or mapped, never bare dotted key
    expect(isBareKey(visible.action)).toBe(false);
    expect(visible.action).toBe('Please check tool parameters and try again.');
  });

  it('toUserVisibleError handles translateFn throwing exceptions gracefully', () => {
    const payload = makePayload({
      code: 'provider.timeout',
      action: 'action.provider.retry',
    });
    const throwingTranslate = () => {
      throw new Error('i18n engine failure');
    };

    const visible = toUserVisibleError(payload, throwingTranslate);
    expect(visible.title).toBe('Request timeout');
    expect(visible.action).toBe('The request timed out. Please retry.');
  });
});

describe('global error translation registration and text resolvers', () => {
  it('registers and retrieves global error translation function', () => {
    const customTranslate = (key: string, fallback?: string) =>
      `[GLOBAL] ${key} (${fallback ?? ''})`;
    registerErrorTranslateFn(customTranslate);
    expect(getErrorTranslateFn()).toBe(customTranslate);

    const payload = makePayload({
      code: 'provider.timeout',
      action: 'action.provider.retry',
    });
    const visible = toUserVisibleError(payload);
    expect(visible.title).toContain('[GLOBAL] error.provider.timeout.title');

    // Clean up
    registerErrorTranslateFn(null);
    expect(getErrorTranslateFn()).toBeNull();
  });

  it('resolveActionText and resolveTitleText respect silent action codes', () => {
    const abortedPayload = makePayload({
      code: 'runtime.aborted',
      action: 'action.runtime.none',
    });
    expect(resolveActionText(abortedPayload)).toBe('');
    expect(resolveTitleText(abortedPayload)).toBe('Aborted');

    const cancelledPayload = makePayload({
      code: 'provider.cancelled',
    });
    expect(resolveActionText(cancelledPayload)).toBe('');
  });

  it('resolveActionText and resolveTitleText support parameter interpolation', () => {
    const payload = makePayload({
      code: 'tool.exec_failed',
      action: 'action.tool.retry',
      message: 'Failed to run {name}',
    });
    const title = resolveTitleText(payload);
    expect(title).toBe('Tool execution failed');

    const action = resolveActionText(payload);
    expect(action).toBe('Please check tool parameters and try again.');
  });
});

describe('IPC dynamic error params & complex structure interpolation (AGENT-W4-TAURI-IPC-PAYLOAD)', () => {
  it('safely serializes complex objects and arrays into JSON without producing [object Object]', () => {
    const res = interpolateParams('Error context: {context}, items: {items}', {
      context: { endpoint: 'https://api.openai.com/v1', attempts: 3 },
      items: ['read', 'write'],
    });
    expect(res).not.toContain('[object Object]');
    expect(res).toBe(
      'Error context: {"endpoint":"https://api.openai.com/v1","attempts":3}, items: ["read","write"]'
    );
  });

  it('safely handles NaN and non-finite numbers as dash', () => {
    const res = interpolateParams('Rate: {rate}, Timeout: {timeout}', {
      rate: Number.NaN,
      timeout: Number.POSITIVE_INFINITY,
    });
    expect(res).toBe('Rate: -, Timeout: -');
  });

  it('extracts Error instance message cleanly in interpolation', () => {
    const res = interpolateParams('Cause: {error}', {
      error: new Error('Disk I/O failure'),
    });
    expect(res).toBe('Cause: Disk I/O failure');
  });

  it('toUserVisibleError automatically extracts payload.params from Rust IPC payload', () => {
    const ipcPayload = {
      ...makePayload({
        code: 'tool.write_not_allowed',
        message: 'Write denied for path {path}: policy violation',
      }),
      params: {
        path: '/etc/shadow',
        target: 'system_root',
      },
    };

    const visible = toUserVisibleError(ipcPayload);
    expect(visible.code).toBe('tool.write_not_allowed');
    expect(visible.message).toBe(
      'Write denied for path /etc/shadow: policy violation'
    );
  });

  it('toUserVisibleError automatically injects payload.code as {code} placeholder', () => {
    const ipcPayload = {
      ...makePayload({
        code: 'provider.network',
        message: 'Request failed with error code {code}',
      }),
    };

    const visible = toUserVisibleError(ipcPayload);
    expect(visible.message).toBe(
      'Request failed with error code provider.network'
    );
  });

  it('correctly handles precedence: code < metadata < params < explicitParams', () => {
    const ipcPayload = {
      ...makePayload({
        code: 'provider.timeout',
        message: '{target} operation timed out ({code}) detail: {detail}',
        metadata: {
          target: 'metadata_target',
          detail: 'meta_detail',
        },
      }),
      params: {
        target: 'params_target', // overrides metadata
        detail: { reason: 'socket_hangup' },
      },
    };

    // 1. Without explicit params: params overrides metadata, detail serialized to JSON
    const visible1 = toUserVisibleError(ipcPayload);
    expect(visible1.message).toBe(
      'params_target operation timed out (provider.timeout) detail: {"reason":"socket_hangup"}'
    );

    // 2. With explicit params: explicit overrides params
    const visible2 = toUserVisibleError(ipcPayload, undefined, {
      target: 'explicit_target',
    });
    expect(visible2.message).toBe(
      'explicit_target operation timed out (provider.timeout) detail: {"reason":"socket_hangup"}'
    );
  });

  it('resolveActionText and resolveTitleText properly interpolate dynamic IPC params', () => {
    const ipcPayload = {
      ...makePayload({
        code: 'tool.path_escape',
        action: 'action.common.report_bug',
        message: 'Path {path} is invalid',
      }),
      params: {
        path: '../secret',
      },
    };

    const actionText = resolveActionText(
      ipcPayload,
      (key, fallback, params) => {
        return `Action on ${params?.path}: ${fallback}`;
      }
    );
    expect(actionText).toContain('Action on ../secret:');
  });

  it('api/error-translation bridge re-exports error translation utilities', async () => {
    const apiBridge = await import('../api/error-translation');
    expect(apiBridge.toUserVisibleError).toBeTypeOf('function');
    expect(apiBridge.interpolateParams).toBeTypeOf('function');
    expect(apiBridge.normalizeCrishError).toBeTypeOf('function');
  });
});
