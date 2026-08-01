import { describe, expect, it } from 'vitest';
import { CrishError, type CrishErrorPayload } from '@crish/shared-types';
import {
  toUserVisibleError,
  normalizeCrishError,
  fromErrorPayload,
  resolveActionText,
  resolveTitleText,
} from './error-translation';

/** 构造测试用 CrishErrorPayload 的辅助函数 */
function makePayload(
  overrides: Partial<CrishErrorPayload> = {},
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
      'Service is temporarily unavailable. Please try again later.',
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
      '[zh] error.provider.network.title :: Network error',
    );
    expect(visible.action).toBe(
      '[zh] action.provider.check_network :: Service is temporarily unavailable. Please try again later.',
    );
  });

  it('resolveActionText returns built-in action without translate', () => {
    const payload = makePayload({
      code: 'provider.timeout',
      category: 'transient',
      retryable: true,
    });
    expect(resolveActionText(payload)).toBe(
      'The request timed out. Please retry.',
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
      'Please start a new session or shorten the task.',
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
      'Please shorten the task or start a new session.',
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
      true,
    );
    const err = new CrishError(
      'timeout',
      'provider.timeout',
      'transient',
      true,
      undefined,
      { cause },
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
