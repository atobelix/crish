import { describe, it, expect } from 'vitest';
import { ErrorClassifier, ErrorDomain } from '../error-classifier';
import { ConnectionError, StreamInterruptedError } from '../provider-transport/connection-manager';

describe('ErrorClassifier.classify', () => {
  it('401 status → CLIENT_AUTH, not retryable, does not trip breaker', () => {
    const result = ErrorClassifier.classify(new Error('unauthorized'), { status: 401 });
    expect(result.domain).toBe(ErrorDomain.CLIENT_AUTH);
    expect(result.retryable).toBe(false);
    expect(result.httpStatus).toBe(401);
  });

  it('403 status → CLIENT_AUTH', () => {
    const result = ErrorClassifier.classify(new Error('forbidden'), { status: 403 });
    expect(result.domain).toBe(ErrorDomain.CLIENT_AUTH);
    expect(result.httpStatus).toBe(403);
  });

  it('429 status → RATE_LIMIT, retryable', () => {
    const result = ErrorClassifier.classify(new Error('too many'), { status: 429 });
    expect(result.domain).toBe(ErrorDomain.RATE_LIMIT);
    expect(result.retryable).toBe(true);
  });

  it('500 status → TRANSIENT_SERVER, retryable', () => {
    const result = ErrorClassifier.classify(new Error('server error'), { status: 500 });
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_SERVER);
    expect(result.retryable).toBe(true);
  });

  it('402 status → QUOTA_EXHAUSTED', () => {
    const result = ErrorClassifier.classify(new Error('payment required'), { status: 402 });
    expect(result.domain).toBe(ErrorDomain.QUOTA_EXHAUSTED);
    expect(result.httpStatus).toBe(402);
  });

  it('413 status → CLIENT_INVALID_INPUT with subType payload_too_large', () => {
    const result = ErrorClassifier.classify(new Error('payload too large'), { status: 413 });
    expect(result.domain).toBe(ErrorDomain.CLIENT_INVALID_INPUT);
    expect(result.subType).toBe('payload_too_large');
    expect(result.httpStatus).toBe(413);
  });

  it('AbortError (DOMException) → USER_ABORT with silent severity', () => {
    const err = new DOMException('The operation was aborted', 'AbortError');
    const result = ErrorClassifier.classify(err);
    expect(result.domain).toBe(ErrorDomain.USER_ABORT);
    expect(result.uiSeverity).toBe('silent');
    expect(result.retryable).toBe(false);
  });

  it('timeout message → TRANSIENT_NETWORK', () => {
    const result = ErrorClassifier.classify(new Error('Request timed out after 30000ms'));
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_NETWORK);
    expect(result.retryable).toBe(true);
  });

  it('ECONNRESET message → TRANSIENT_NETWORK', () => {
    const result = ErrorClassifier.classify(new Error('read ECONNRESET'));
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_NETWORK);
    expect(result.retryable).toBe(true);
  });

  it('non-Error input (string) does not crash', () => {
    const result = ErrorClassifier.classify('something went wrong');
    expect(result.domain).toBe(ErrorDomain.UNKNOWN);
    expect(result.retryable).toBe(false);
  });

  it('status code takes priority over message when both provided', () => {
    const result = ErrorClassifier.classify(new Error('timeout'), { status: 402 });
    expect(result.domain).toBe(ErrorDomain.QUOTA_EXHAUSTED);
    expect(result.httpStatus).toBe(402);
  });

  it('unknown status code → UNKNOWN, not retryable', () => {
    const result = ErrorClassifier.classify(new Error('weird error'), { status: 999 });
    expect(result.domain).toBe(ErrorDomain.UNKNOWN);
    expect(result.retryable).toBe(false);
    expect(result.httpStatus).toBe(999);
  });

  it('Retry-After header parsed into retryAfterMs', () => {
    const headers = new Headers({ 'Retry-After': '120' });
    const result = ErrorClassifier.classify(new Error('rate limited'), {
      status: 429,
      headers,
    });
    expect(result.domain).toBe(ErrorDomain.RATE_LIMIT);
    expect(result.retryAfterMs).toBe(120_000);
  });

  // ── 网络错误识别 ──────────────────────────────────────────

  it('ECONNREFUSED message → TRANSIENT_NETWORK, retryable', () => {
    const result = ErrorClassifier.classify(new Error('connect ECONNREFUSED 127.0.0.1:443'));
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_NETWORK);
    expect(result.retryable).toBe(true);
    expect(result.uiSeverity).toBe('warning');
  });

  it('ENOTFOUND message → TRANSIENT_NETWORK', () => {
    const result = ErrorClassifier.classify(new Error('getaddrinfo ENOTFOUND api.example.com'));
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_NETWORK);
    expect(result.retryable).toBe(true);
  });

  it('fetch failed message → TRANSIENT_NETWORK', () => {
    const result = ErrorClassifier.classify(new Error('fetch failed: connection refused'));
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_NETWORK);
    expect(result.retryable).toBe(true);
  });

  it('socket hang up message → TRANSIENT_NETWORK', () => {
    const result = ErrorClassifier.classify(new Error('socket hang up'));
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_NETWORK);
    expect(result.retryable).toBe(true);
  });

  it('ConnectionError instance → TRANSIENT_NETWORK with recoveryHint', () => {
    const result = ErrorClassifier.classify(new ConnectionError('all transports failed', 'E_FAIL'));
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_NETWORK);
    expect(result.retryable).toBe(true);
    expect(result.recoveryHint).toContain('所有传输通道均失败');
  });

  // ── HTTP 状态码映射 ──────────────────────────────────────

  it('404 status → ENDPOINT_UNAVAILABLE', () => {
    const result = ErrorClassifier.classify(new Error('not found'), { status: 404 });
    expect(result.domain).toBe(ErrorDomain.ENDPOINT_UNAVAILABLE);
    expect(result.httpStatus).toBe(404);
    expect(result.retryable).toBe(false);
  });

  it('405 status → ENDPOINT_UNAVAILABLE', () => {
    const result = ErrorClassifier.classify(new Error('method not allowed'), { status: 405 });
    expect(result.domain).toBe(ErrorDomain.ENDPOINT_UNAVAILABLE);
    expect(result.httpStatus).toBe(405);
  });

  it('415 status → ENDPOINT_UNAVAILABLE', () => {
    const result = ErrorClassifier.classify(new Error('unsupported media type'), { status: 415 });
    expect(result.domain).toBe(ErrorDomain.ENDPOINT_UNAVAILABLE);
    expect(result.httpStatus).toBe(415);
  });

  it('400 status → CLIENT_INVALID_INPUT', () => {
    const result = ErrorClassifier.classify(new Error('bad request'), { status: 400 });
    expect(result.domain).toBe(ErrorDomain.CLIENT_INVALID_INPUT);
    expect(result.retryable).toBe(false);
    expect(result.httpStatus).toBe(400);
  });

  it('400 status with context overflow → CLIENT_INVALID_INPUT, retryable, subType context_length_exceeded', () => {
    const result = ErrorClassifier.classify(
      new Error('maximum context length exceeded'),
      { status: 400 },
    );
    expect(result.domain).toBe(ErrorDomain.CLIENT_INVALID_INPUT);
    expect(result.subType).toBe('context_length_exceeded');
    expect(result.retryable).toBe(true);
    expect(result.legacyKind).toBe('context-overflow');
  });

  it('422 status → CLIENT_INVALID_INPUT', () => {
    const result = ErrorClassifier.classify(new Error('unprocessable entity'), { status: 422 });
    expect(result.domain).toBe(ErrorDomain.CLIENT_INVALID_INPUT);
    expect(result.httpStatus).toBe(422);
  });

  it('502 status → TRANSIENT_SERVER, retryable', () => {
    const result = ErrorClassifier.classify(new Error('bad gateway'), { status: 502 });
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_SERVER);
    expect(result.retryable).toBe(true);
    expect(result.httpStatus).toBe(502);
  });

  it('503 status → TRANSIENT_SERVER', () => {
    const result = ErrorClassifier.classify(new Error('service unavailable'), { status: 503 });
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_SERVER);
    expect(result.retryable).toBe(true);
  });

  it('504 status → TRANSIENT_SERVER', () => {
    const result = ErrorClassifier.classify(new Error('gateway timeout'), { status: 504 });
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_SERVER);
    expect(result.retryable).toBe(true);
  });

  it('520 status → TRANSIENT_SERVER', () => {
    const result = ErrorClassifier.classify(new Error('unknown error'), { status: 520 });
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_SERVER);
    expect(result.retryable).toBe(true);
  });

  it('522 status → TRANSIENT_SERVER', () => {
    const result = ErrorClassifier.classify(new Error('connection timed out'), { status: 522 });
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_SERVER);
    expect(result.retryable).toBe(true);
  });

  it('523 status → TRANSIENT_SERVER', () => {
    const result = ErrorClassifier.classify(new Error('origin unreachable'), { status: 523 });
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_SERVER);
    expect(result.retryable).toBe(true);
  });

  it('524 status → TRANSIENT_SERVER', () => {
    const result = ErrorClassifier.classify(new Error('a timeout occurred'), { status: 524 });
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_SERVER);
    expect(result.retryable).toBe(true);
  });

  // ── 超时识别 ──────────────────────────────────────────────

  it('"timed out" message → TRANSIENT_NETWORK', () => {
    const result = ErrorClassifier.classify(new Error('Connection timed out'));
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_NETWORK);
    expect(result.retryable).toBe(true);
  });

  it('"timeout" in long message → TRANSIENT_NETWORK', () => {
    const result = ErrorClassifier.classify(new Error('socket timeout after 60000ms of inactivity'));
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_NETWORK);
    expect(result.retryable).toBe(true);
  });

  it('timeout message with recoveryHint', () => {
    const result = ErrorClassifier.classify(new Error('Request timed out'));
    expect(result.recoveryHint).toBe('请求超时');
  });

  it('timeout message overridden by status code', () => {
    const result = ErrorClassifier.classify(new Error('timed out'), { status: 401 });
    expect(result.domain).toBe(ErrorDomain.CLIENT_AUTH);
    expect(result.httpStatus).toBe(401);
  });

  // ── 认证错误 ──────────────────────────────────────────────

  it('"invalid api key" message → CLIENT_AUTH', () => {
    const result = ErrorClassifier.classify(new Error('Invalid API key provided'));
    expect(result.domain).toBe(ErrorDomain.CLIENT_AUTH);
    expect(result.retryable).toBe(false);
  });

  it('"invalid authentication" message → CLIENT_AUTH', () => {
    const result = ErrorClassifier.classify(new Error('invalid authentication credentials'));
    expect(result.domain).toBe(ErrorDomain.CLIENT_AUTH);
    expect(result.retryable).toBe(false);
  });

  it('"unauthorized" message without status → CLIENT_AUTH', () => {
    const result = ErrorClassifier.classify(new Error('unauthorized'));
    expect(result.domain).toBe(ErrorDomain.CLIENT_AUTH);
    expect(result.retryable).toBe(false);
  });

  it('"forbidden" in message → CLIENT_AUTH', () => {
    const result = ErrorClassifier.classify(new Error('forbidden: access denied'));
    expect(result.domain).toBe(ErrorDomain.CLIENT_AUTH);
  });

  // ── retryable 字段 ────────────────────────────────────────

  it('quota exhausted message → QUOTA_EXHAUSTED, not retryable', () => {
    const result = ErrorClassifier.classify(new Error('Quota exceeded for API key'));
    expect(result.domain).toBe(ErrorDomain.QUOTA_EXHAUSTED);
    expect(result.retryable).toBe(false);
  });

  it('context_length_exceeded message → retryable true', () => {
    const result = ErrorClassifier.classify(new Error('context_length_exceeded'));
    expect(result.domain).toBe(ErrorDomain.CLIENT_INVALID_INPUT);
    expect(result.subType).toBe('context_length_exceeded');
    expect(result.retryable).toBe(true);
  });

  it('rate limit message → RATE_LIMIT, retryable', () => {
    const result = ErrorClassifier.classify(new Error('rate limit exceeded'));
    expect(result.domain).toBe(ErrorDomain.RATE_LIMIT);
    expect(result.retryable).toBe(true);
  });

  it('"too many requests" message → RATE_LIMIT, retryable', () => {
    const result = ErrorClassifier.classify(new Error('too many requests'));
    expect(result.domain).toBe(ErrorDomain.RATE_LIMIT);
    expect(result.retryable).toBe(true);
  });

  // ── 边界：空消息 / 非标准格式 ──────────────────────────

  it('empty string error → UNKNOWN', () => {
    const result = ErrorClassifier.classify(new Error(''));
    expect(result.domain).toBe(ErrorDomain.UNKNOWN);
    expect(result.retryable).toBe(false);
    expect(result.httpStatus).toBeUndefined();
  });

  it('null error → UNKNOWN (coerced to string "null")', () => {
    const result = ErrorClassifier.classify(null);
    expect(result.domain).toBe(ErrorDomain.UNKNOWN);
    expect(result.retryable).toBe(false);
  });

  it('undefined error → UNKNOWN (coerced to string "undefined")', () => {
    const result = ErrorClassifier.classify(undefined);
    expect(result.domain).toBe(ErrorDomain.UNKNOWN);
  });

  it('number error → UNKNOWN', () => {
    const result = ErrorClassifier.classify(42);
    expect(result.domain).toBe(ErrorDomain.UNKNOWN);
  });

  it('object error → UNKNOWN', () => {
    const result = ErrorClassifier.classify({ code: 500, message: 'boom' });
    expect(result.domain).toBe(ErrorDomain.UNKNOWN);
    expect(result.retryable).toBe(false);
  });

  it('Error with whitespace-only message → UNKNOWN', () => {
    const result = ErrorClassifier.classify(new Error('   '));
    expect(result.domain).toBe(ErrorDomain.UNKNOWN);
  });

  it('no options passed → works without crash', () => {
    const result = ErrorClassifier.classify(new Error('something broke'));
    expect(result.domain).toBe(ErrorDomain.UNKNOWN);
  });

  // ── 其他边缘场景 ──────────────────────────────────────

  it('StreamInterruptedError instance → STREAM_INTERRUPT, retryable', () => {
    const result = ErrorClassifier.classify(
      new StreamInterruptedError('transport-1', 'connection lost', true),
    );
    expect(result.domain).toBe(ErrorDomain.STREAM_INTERRUPT);
    expect(result.retryable).toBe(true);
    expect(result.recoveryHint).toContain('流在传输');
  });

  it('abort signal set → USER_ABORT even with status code', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = ErrorClassifier.classify(
      new Error('request aborted'),
      { signal: ctrl.signal, status: 500 },
    );
    expect(result.domain).toBe(ErrorDomain.USER_ABORT);
    expect(result.retryable).toBe(false);
    expect(result.uiSeverity).toBe('silent');
  });

  it('"cancelled" message → USER_ABORT', () => {
    const result = ErrorClassifier.classify(new Error('cancelled by user'));
    expect(result.domain).toBe(ErrorDomain.USER_ABORT);
    expect(result.retryable).toBe(false);
  });

  it('"canceled" (single L) message → USER_ABORT', () => {
    const result = ErrorClassifier.classify(new Error('canceled'));
    expect(result.domain).toBe(ErrorDomain.USER_ABORT);
  });

  it('"aborted" in message → USER_ABORT', () => {
    const result = ErrorClassifier.classify(new Error('the user aborted the request'));
    expect(result.domain).toBe(ErrorDomain.USER_ABORT);
  });

  it('providerId propagated to result', () => {
    const result = ErrorClassifier.classify(new Error('server error'), {
      status: 500,
      providerId: 'openai',
    });
    expect(result.providerId).toBe('openai');
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_SERVER);
  });

  it('"bad gateway" message → TRANSIENT_SERVER without status', () => {
    const result = ErrorClassifier.classify(new Error('Bad Gateway from upstream'));
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_SERVER);
    expect(result.retryable).toBe(true);
  });

  it('"overloaded" message → TRANSIENT_SERVER', () => {
    const result = ErrorClassifier.classify(new Error('server is overloaded'));
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_SERVER);
    expect(result.retryable).toBe(true);
  });

  it('"temporarily unavailable" message → TRANSIENT_SERVER', () => {
    const result = ErrorClassifier.classify(new Error('temporarily unavailable'));
    expect(result.domain).toBe(ErrorDomain.TRANSIENT_SERVER);
    expect(result.retryable).toBe(true);
  });

  it('"insufficient_quota" message → QUOTA_EXHAUSTED', () => {
    const result = ErrorClassifier.classify(new Error('insufficient_quota'));
    expect(result.domain).toBe(ErrorDomain.QUOTA_EXHAUSTED);
  });

  it('"out of credits" message → QUOTA_EXHAUSTED', () => {
    const result = ErrorClassifier.classify(new Error('out of credits'));
    expect(result.domain).toBe(ErrorDomain.QUOTA_EXHAUSTED);
  });

  it('"payload too large" in message → CLIENT_INVALID_INPUT with subType', () => {
    const result = ErrorClassifier.classify(new Error('payload too large'));
    expect(result.domain).toBe(ErrorDomain.CLIENT_INVALID_INPUT);
    expect(result.subType).toBe('payload_too_large');
    expect(result.legacyKind).toBe('payload-too-large');
  });

  it('"entity too large" in message → CLIENT_INVALID_INPUT', () => {
    const result = ErrorClassifier.classify(new Error('entity too large'));
    expect(result.domain).toBe(ErrorDomain.CLIENT_INVALID_INPUT);
    expect(result.subType).toBe('payload_too_large');
  });
});
