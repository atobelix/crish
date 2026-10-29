import { describe, expect, it } from 'vitest';
import {
  evaluatePassword,
  formatCountdown,
  isValidEmail,
  isValidPassword,
  normalizeCode,
} from './accountRules';

describe('accountRules 账号前端校验', () => {
  it('isValidEmail 校验基本邮箱格式并忽略首尾空白', () => {
    expect(isValidEmail(' heson@flowbit.me ')).toBe(true);
    expect(isValidEmail('heson@flowbit')).toBe(false);
    expect(isValidEmail('heson')).toBe(false);
  });

  it('密码硬性规则：8–128 码点，拒绝明显弱口令', () => {
    expect(isValidPassword('Ab1!')).toBe(false);
    expect(isValidPassword('12345678')).toBe(false);
    expect(isValidPassword('abcdabcd')).toBe(false);
    expect(isValidPassword('password123')).toBe(false);
    expect(isValidPassword('hesonflowbit', 'hesonflowbit@flowbit.me')).toBe(
      false
    );
    expect(isValidPassword('abcdefgz')).toBe(true);
  });

  it('密码强度：weak / medium / strong 与拒绝原因', () => {
    expect(evaluatePassword('Ab1!')).toMatchObject({
      acceptable: false,
      reason: 'too_short',
    });
    expect(evaluatePassword('a'.repeat(129))).toMatchObject({
      acceptable: false,
      reason: 'too_long',
    });
    expect(evaluatePassword('12345678')).toMatchObject({
      acceptable: false,
      reason: 'too_weak',
    });
    expect(evaluatePassword('abcdefgz')).toEqual({
      acceptable: true,
      strength: 'weak',
    });
    expect(evaluatePassword('abcdefg1')).toEqual({
      acceptable: true,
      strength: 'medium',
    });
    expect(evaluatePassword('Str0ng-Passw0rd!')).toEqual({
      acceptable: true,
      strength: 'strong',
    });
  });

  it('normalizeCode 只保留数字并截断到 6 位', () => {
    expect(normalizeCode('12 34-56789')).toBe('123456');
    expect(normalizeCode('ab1')).toBe('1');
  });

  it('formatCountdown 输出 m:ss', () => {
    expect(formatCountdown(42)).toBe('0:42');
    expect(formatCountdown(60)).toBe('1:00');
    expect(formatCountdown(-3)).toBe('0:00');
  });
});
