// event-envelope 宽容读取原语单测（T4 投影原语下沉；mobile/desktop 共用）
import { describe, expect, it } from 'vitest';
import { readBool, readNumber, readRecord, readString } from './event-envelope';

describe('readRecord', () => {
  it('对象 → 原引用；非对象/数组 → undefined', () => {
    const obj = { a: 1 };
    expect(readRecord(obj)).toBe(obj);
    expect(readRecord(null)).toBeUndefined();
    expect(readRecord(undefined)).toBeUndefined();
    expect(readRecord('str')).toBeUndefined();
    expect(readRecord(42)).toBeUndefined();
    expect(readRecord([1])).toBeUndefined();
  });
});

describe('readString', () => {
  it('字符串 → 值；缺失/类型错 → undefined', () => {
    expect(readString({ a: 'x' }, 'a')).toBe('x');
    expect(readString({ a: 1 }, 'a')).toBeUndefined();
    expect(readString({}, 'a')).toBeUndefined();
    expect(readString(null, 'a')).toBeUndefined();
    expect(readString({ a: '' }, 'a')).toBe('');
  });
});

describe('readNumber', () => {
  it('有限数字 → 值；缺失/NaN/Infinity/字符串 → undefined', () => {
    expect(readNumber({ a: 42 }, 'a')).toBe(42);
    expect(readNumber({ a: 0 }, 'a')).toBe(0);
    expect(readNumber({ a: Number.NaN }, 'a')).toBeUndefined();
    expect(readNumber({ a: Number.POSITIVE_INFINITY }, 'a')).toBeUndefined();
    expect(readNumber({ a: '42' }, 'a')).toBeUndefined();
    expect(readNumber({}, 'a')).toBeUndefined();
  });
});

describe('readBool', () => {
  it('true → true；缺失/非 true → false', () => {
    expect(readBool({ a: true }, 'a')).toBe(true);
    expect(readBool({ a: false }, 'a')).toBe(false);
    expect(readBool({}, 'a')).toBe(false);
    expect(readBool({ a: 1 }, 'a')).toBe(false);
  });

  it('多级路径下钻；任一层缺失/非对象 → false', () => {
    expect(readBool({ a: { b: true } }, 'a', 'b')).toBe(true);
    expect(readBool({ a: { b: false } }, 'a', 'b')).toBe(false);
    expect(readBool({ a: {} }, 'a', 'b')).toBe(false);
    expect(readBool({ a: 1 }, 'a', 'b')).toBe(false);
    expect(readBool({}, 'a', 'b')).toBe(false);
  });
});
