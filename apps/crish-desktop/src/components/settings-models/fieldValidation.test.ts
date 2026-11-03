import { describe, expect, it } from 'vitest';
import {
  isHttpUrlText,
  isPositiveIntegerText,
  positiveIntegerError,
} from './fieldValidation';

describe('fieldValidation 表单族共用字段校验', () => {
  it('正整数：空为未设置合法，正整数合法，零/负数/小数/非数字非法', () => {
    expect(isPositiveIntegerText(undefined)).toBe(true);
    expect(isPositiveIntegerText(null)).toBe(true);
    expect(isPositiveIntegerText('')).toBe(true);
    expect(isPositiveIntegerText('  ')).toBe(true);
    expect(isPositiveIntegerText('128000')).toBe(true);
    expect(isPositiveIntegerText(' 4096 ')).toBe(true);
    expect(isPositiveIntegerText('0')).toBe(false);
    expect(isPositiveIntegerText('-5')).toBe(false);
    expect(isPositiveIntegerText('1.5')).toBe(false);
    expect(isPositiveIntegerText('12k')).toBe(false);
    expect(isPositiveIntegerText('abc')).toBe(false);
  });

  it('positiveIntegerError：合法返回 null，非法返回文案', () => {
    expect(positiveIntegerError('')).toBeNull();
    expect(positiveIntegerError('8192')).toBeNull();
    expect(positiveIntegerError('abc')).toBeTruthy();
    expect(positiveIntegerError('0')).toBeTruthy();
  });

  it('http(s) URL：空合法，http/https 合法，其余协议与不可解析文本非法', () => {
    expect(isHttpUrlText('')).toBe(true);
    expect(isHttpUrlText('https://api.example.com/v1')).toBe(true);
    expect(isHttpUrlText('http://localhost:11434')).toBe(true);
    expect(isHttpUrlText('api.example.com/v1')).toBe(false);
    expect(isHttpUrlText('ftp://example.com')).toBe(false);
    expect(isHttpUrlText('not a url')).toBe(false);
  });
});
