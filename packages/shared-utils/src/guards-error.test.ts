import { describe, expect, it } from 'vitest';
import { errorMessage } from './error';
import { isNodeError, isPromiseLike, isRecord, nonEmptyString } from './guards';

describe('errorMessage', () => {
  it('Error 实例取 message（含子类）', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage(new TypeError('bad type'))).toBe('bad type');
  });
  it('字符串原样返回（含空串）', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage('')).toBe('');
  });
  it('带字符串 message 的普通对象取 message', () => {
    expect(errorMessage({ message: 'from-object', code: 1 })).toBe(
      'from-object'
    );
  });
  it('message 非字符串的对象与其他值走 String()', () => {
    expect(errorMessage({ message: 42 })).toBe('[object Object]');
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage(404)).toBe('404');
  });
});

describe('guards', () => {
  it('isRecord：普通对象为真；null/数组/原始值为假', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });

  it('isPromiseLike：then 为函数才为真', () => {
    expect(isPromiseLike(Promise.resolve(1))).toBe(true);
    expect(isPromiseLike({ then: () => undefined })).toBe(true);
    expect(isPromiseLike({ then: 'not-fn' })).toBe(false);
    expect(isPromiseLike(null)).toBe(false);
    expect(isPromiseLike(() => undefined)).toBe(false);
  });

  it('nonEmptyString：纯空白/空串/null/undefined → undefined，否则原样返回（不 trim）', () => {
    expect(nonEmptyString(' a ')).toBe(' a ');
    expect(nonEmptyString('   ')).toBeUndefined();
    expect(nonEmptyString('')).toBeUndefined();
    expect(nonEmptyString(null)).toBeUndefined();
    expect(nonEmptyString(undefined)).toBeUndefined();
  });

  it('isNodeError：仅带 code 的 Error 为真', () => {
    const e = Object.assign(new Error('nope'), { code: 'ENOENT' });
    expect(isNodeError(e)).toBe(true);
    expect(isNodeError(new Error('no code'))).toBe(false);
    expect(isNodeError({ code: 'ENOENT', message: 'x' })).toBe(false);
  });
});
