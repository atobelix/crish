import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CRISH_ERROR_CAUSE_MAX_DEPTH,
  CrishError,
  PermissionError,
  ProtocolError,
  ProviderError,
  SessionError,
  codeFromHttpStatus,
  domainOf,
  err,
  flatMapResult,
  fromErrorPayload,
  fromPromise,
  fromUnknownError,
  getOrThrow,
  isCrishErrorCode,
  isErr,
  isOk,
  makeErrorPayload,
  mapErr,
  mapResult,
  match,
  ok,
  promiseResult,
  toErrorPayload,
  unwrapOr,
  type CrishResult,
} from './index';

describe('CrishError 构造与注册表元信息', () => {
  it('注册表内的新码：public/action/titleKey/actionKey 取自注册表', () => {
    const e = new CrishError('越界', 'tool.path_escape', 'security', false, {
      path: '/etc',
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('CrishError');
    expect(e.message).toBe('越界');
    expect(e.code).toBe('tool.path_escape');
    expect(e.category).toBe('security');
    expect(e.retryable).toBe(false);
    expect(e.metadata).toEqual({ path: '/etc' });
    expect(e.public).toBe(true);
    expect(e.action).toBe('action.tool.check_path');
    expect(e.titleKey).toBe('error.tool.path_escape.title');
    expect(e.actionKey).toBe('action.tool.check_path');
    expect(e.cause).toBeUndefined();
  });

  it('旧裸码（不在注册表）回退 common.unknown 元信息，但保留原 code', () => {
    const e = new CrishError('legacy', 'TOOL_ERROR', 'permanent', true);
    expect(e.code).toBe('TOOL_ERROR');
    expect(e.retryable).toBe(true);
    expect(e.action).toBe('action.common.report_bug');
    expect(e.titleKey).toBe('error.common.unknown.title');
    expect(e.actionKey).toBe('action.common.report_bug');
  });

  it('原型链上的键（如 toString）不会被误认为注册码', () => {
    const e = new CrishError('x', 'toString', 'permanent', false);
    expect(e.titleKey).toBe('error.common.unknown.title');
  });

  it('options 覆盖注册表默认值，并通过 Error cause 透传', () => {
    const root = new CrishError(
      'root',
      'session.not_found',
      'permanent',
      false
    );
    const e = new CrishError(
      'wrap',
      'tool.path_escape',
      'security',
      false,
      undefined,
      {
        cause: root,
        public: false,
        action: 'action.custom',
        titleKey: 'k.title',
        actionKey: 'k.action',
      }
    );
    expect(e.cause).toBe(root);
    expect(e.public).toBe(false);
    expect(e.action).toBe('action.custom');
    expect(e.titleKey).toBe('k.title');
    expect(e.actionKey).toBe('k.action');
  });

  it.each([
    [
      () => new ProviderError('p', 'provider.auth', true, { s: 401 }),
      'ProviderError',
      'transient',
      true,
    ],
    [
      () => new PermissionError('perm', 'tool.path_escape'),
      'PermissionError',
      'security',
      false,
    ],
    [
      () => new SessionError('s', 'not_found'),
      'SessionError',
      'permanent',
      false,
    ],
    [
      () => new ProtocolError('pr', 'run.invalid_state'),
      'ProtocolError',
      'protocol',
      false,
    ],
  ] as const)(
    'deprecated 适配子类 %#：name/category/retryable 固定',
    (make, name, category, retryable) => {
      const e = make();
      expect(e).toBeInstanceOf(CrishError);
      expect(e.name).toBe(name);
      expect(e.category).toBe(category);
      expect(e.retryable).toBe(retryable);
    }
  );
});

describe('codes 辅助函数', () => {
  it('domainOf 取首段', () => {
    expect(domainOf('tool.path_escape')).toBe('tool');
    expect(domainOf('tool.browser.timeout' as never)).toBe('tool');
  });

  it('isCrishErrorCode 只接受小写点分两段及以上', () => {
    expect(isCrishErrorCode('tool.path_escape')).toBe(true);
    expect(isCrishErrorCode('tool.browser.nav_timeout')).toBe(true);
    expect(isCrishErrorCode('TOOL_ERROR')).toBe(false);
    expect(isCrishErrorCode('tool')).toBe(false);
    expect(isCrishErrorCode('Tool.Path')).toBe(false);
    expect(isCrishErrorCode('tool.path-escape')).toBe(false);
    expect(isCrishErrorCode('tool.')).toBe(false);
  });
});

describe('CrishResult ADT', () => {
  const boom = new CrishError('boom', 'common.unknown', 'permanent', false);
  const okR: CrishResult<number> = ok(2);
  const errR: CrishResult<number> = err(boom);

  it('ok()/err() 构造判别联合；无参 ok 的 value 为 undefined', () => {
    expect(okR).toEqual({ ok: true, value: 2 });
    expect(errR).toEqual({ ok: false, error: boom });
    expect(ok()).toEqual({ ok: true, value: undefined });
  });

  it('getOrThrow / unwrapOr', () => {
    expect(getOrThrow(okR)).toBe(2);
    expect(() => getOrThrow(errR)).toThrow(boom);
    expect(unwrapOr(okR, 9)).toBe(2);
    expect(unwrapOr(errR, 9)).toBe(9);
  });

  it('mapResult 只变换 ok 分支，err 分支原样返回（同一引用）', () => {
    expect(mapResult(okR, (v) => v * 10)).toEqual({ ok: true, value: 20 });
    const fn = vi.fn();
    expect(mapResult(errR, fn)).toBe(errR);
    expect(fn).not.toHaveBeenCalled();
  });

  it('flatMapResult 串联可能失败的步骤', () => {
    const half = (v: number): CrishResult<number> =>
      v % 2 === 0
        ? ok(v / 2)
        : err(
            new CrishError('odd', 'common.invalid_input', 'permanent', false)
          );
    expect(flatMapResult(ok(8), half)).toEqual({ ok: true, value: 4 });
    const odd = flatMapResult(ok(3), half);
    expect(isErr(odd) && odd.error.message).toBe('odd');
    expect(flatMapResult(errR, half)).toBe(errR);
  });

  it('mapErr 只变换 err 分支', () => {
    const wrapped = mapErr(
      errR,
      (e) =>
        new CrishError(
          `wrapped: ${e.message}`,
          'common.unknown',
          'transient',
          true,
          undefined,
          { cause: e }
        )
    );
    expect(isErr(wrapped)).toBe(true);
    if (!wrapped.ok) {
      expect(wrapped.error.message).toBe('wrapped: boom');
      expect(wrapped.error.cause).toBe(boom);
    }
    expect(mapErr(okR, () => boom)).toBe(okR);
  });

  it('match 按分支分派；isOk/isErr 互斥', () => {
    const h = {
      ok: (v: number) => `ok:${v}`,
      err: (e: CrishError) => `err:${e.message}`,
    };
    expect(match(okR, h)).toBe('ok:2');
    expect(match(errR, h)).toBe('err:boom');
    expect(isOk(okR)).toBe(true);
    expect(isErr(okR)).toBe(false);
    expect(isOk(errR)).toBe(false);
    expect(isErr(errR)).toBe(true);
  });

  it('fromPromise：resolve → ok；CrishError 原样保留；普通 Error/非 Error 包装为 common.unknown', async () => {
    expect(await fromPromise(Promise.resolve('v'))).toEqual({
      ok: true,
      value: 'v',
    });

    const r1 = await fromPromise(Promise.reject(boom));
    expect(!r1.ok && r1.error).toBe(boom);

    const r2 = await fromPromise(Promise.reject(new TypeError('bad type')));
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error).toBeInstanceOf(CrishError);
      expect(r2.error.message).toBe('bad type');
      expect(r2.error.code).toBe('common.unknown');
      expect(r2.error.category).toBe('permanent');
    }

    const r3 = await fromPromise(Promise.reject(42));
    expect(!r3.ok && r3.error.message).toBe('42');
  });

  it('promiseResult：ok → resolve，err → reject 原错误', async () => {
    await expect(promiseResult(okR)).resolves.toBe(2);
    await expect(promiseResult(errR)).rejects.toBe(boom);
  });
});

describe('错误序列化', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('toErrorPayload 保留字段、递归 cause、非注册码归一为 common.unknown', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const inner = new CrishError('inner', 'LEGACY_CODE', 'transient', true);
    const outer = new CrishError(
      'outer',
      'provider.auth',
      'security',
      false,
      { status: 401 },
      { cause: inner }
    );
    const p = toErrorPayload(outer);
    expect(p.code).toBe('provider.auth');
    expect(p.message).toBe('outer');
    expect(p.category).toBe('security');
    expect(p.retryable).toBe(false);
    expect(p.public).toBe(true);
    expect(p.action).toBe('action.provider.check_api_key');
    expect(p.metadata).toEqual({ status: 401 });
    expect(p.timestamp).toBe(1_700_000_000_000);
    expect(p.cause?.code).toBe('common.unknown');
    expect(p.cause?.message).toBe('inner');
    expect(p.cause?.retryable).toBe(true);
    expect(p.cause?.cause).toBeUndefined();
  });

  it('非 production 携带 stack；production 不携带；无 metadata 时不出现该键', () => {
    const e = new CrishError('x', 'common.unknown', 'permanent', false);
    vi.stubEnv('NODE_ENV', 'development');
    const dev = toErrorPayload(e);
    expect(dev.stack).toBe(e.stack);
    expect('metadata' in dev).toBe(false);
    expect('cause' in dev).toBe(false);

    vi.stubEnv('NODE_ENV', 'production');
    const prod = toErrorPayload(e);
    expect('stack' in prod).toBe(false);
  });

  it(`cause 链超过 ${CRISH_ERROR_CAUSE_MAX_DEPTH} 层时截断为占位 payload`, () => {
    let e = new CrishError('level-0', 'common.unknown', 'permanent', false);
    for (let i = 1; i <= 12; i++) {
      e = new CrishError(
        `level-${i}`,
        'common.unknown',
        'permanent',
        false,
        undefined,
        { cause: e }
      );
    }
    let p = toErrorPayload(e);
    const messages: string[] = [];
    for (;;) {
      messages.push(p.message);
      if (!p.cause) break;
      p = p.cause;
    }
    expect(messages).toHaveLength(CRISH_ERROR_CAUSE_MAX_DEPTH + 1);
    expect(messages[0]).toBe('level-12');
    expect(messages[CRISH_ERROR_CAUSE_MAX_DEPTH - 1]).toBe('level-5');
    expect(p.message).toBe(
      `cause chain truncated at depth ${CRISH_ERROR_CAUSE_MAX_DEPTH}`
    );
    expect(p.public).toBe(false);
    expect(p.action).toBe('action.runtime.none');
  });

  it('fromErrorPayload 还原实例与 cause 链（往返一致）', () => {
    const inner = new CrishError(
      'inner',
      'session.not_found',
      'permanent',
      false
    );
    const outer = new CrishError(
      'outer',
      'tool.path_escape',
      'security',
      false,
      { p: 1 },
      { cause: inner, public: false, action: 'a.custom' }
    );
    const back = fromErrorPayload(toErrorPayload(outer));
    expect(back).toBeInstanceOf(CrishError);
    expect(back.message).toBe('outer');
    expect(back.code).toBe('tool.path_escape');
    expect(back.public).toBe(false);
    expect(back.action).toBe('a.custom');
    expect(back.metadata).toEqual({ p: 1 });
    expect(back.cause).toBeInstanceOf(CrishError);
    expect(back.cause?.code).toBe('session.not_found');
    expect(back.cause?.cause).toBeUndefined();
  });

  it('fromUnknownError / makeErrorPayload 兜底', () => {
    const crish = new CrishError('c', 'provider.auth', 'security', false);
    expect(fromUnknownError(crish).code).toBe('provider.auth');

    const plain = fromUnknownError(new Error('plain'));
    expect(plain.code).toBe('common.unknown');
    expect(plain.message).toBe('plain');
    expect(plain.public).toBe(true);
    expect(plain.action).toBe('action.common.report_bug');
    expect(typeof plain.stack).toBe('string');

    const str = makeErrorPayload('just a string');
    expect(str.message).toBe('just a string');
    expect('stack' in str).toBe(false);
    expect(makeErrorPayload({ a: 1 }).message).toBe('[object Object]');
  });

  it('codeFromHttpStatus 静态映射，未知状态码回退 common.unknown', () => {
    expect(codeFromHttpStatus(400)).toBe('provider.schema');
    expect(codeFromHttpStatus(401)).toBe('provider.auth');
    expect(codeFromHttpStatus(402)).toBe('provider.quota');
    expect(codeFromHttpStatus(403)).toBe('provider.auth');
    expect(codeFromHttpStatus(404)).toBe('provider.endpoint_unavailable');
    expect(codeFromHttpStatus(429)).toBe('provider.rate_limit');
    expect(codeFromHttpStatus(503)).toBe('provider.server');
    expect(codeFromHttpStatus(524)).toBe('provider.server');
    expect(codeFromHttpStatus(200)).toBe('common.unknown');
    expect(codeFromHttpStatus(418)).toBe('common.unknown');
  });
});
