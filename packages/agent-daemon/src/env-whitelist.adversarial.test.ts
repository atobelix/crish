/**
 * env-whitelist 对抗性测试套件
 *
 * 目标：暴露白名单环境变量访问的解析 bug 与潜在密钥泄露。
 *
 * 期望暴露的 bug：
 *  - readEnvAsNumber 对空白字符串、hex、科学计数法的误解析
 *  - snapshotAllowed 返回敏感环境变量的真实值（日志泄露风险）
 *  - readEnvOrDefault 不校验默认值
 *  - 白名单硬编码，无法扩展
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import {
  readEnv,
  readEnvOrDefault,
  readEnvAsNumber,
  isSensitiveEnv,
  snapshotAllowed,
} from './env-whitelist';

const ALLOWED_TEST_VARS = ['DAEMON_PORT', 'DAEMON_LOG_LEVEL', 'CRISH_API_KEY', 'OPENAI_API_KEY'];

describe('env-whitelist — readEnv 白名单强制', () => {
  beforeEach(() => {
    for (const k of ALLOWED_TEST_VARS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ALLOWED_TEST_VARS) delete process.env[k];
  });

  it('白名单内变量可读', () => {
    process.env.DAEMON_PORT = '12345';
    expect(readEnv('DAEMON_PORT')).toBe('12345');
  });

  it('白名单外变量抛错', () => {
    process.env.SECRET_TOKEN = 'leak';
    expect(() => readEnv('SECRET_TOKEN')).toThrow(/denied/);
    delete process.env.SECRET_TOKEN;
  });

  it('未设置的变量返回 undefined', () => {
    expect(readEnv('DAEMON_PORT')).toBeUndefined();
  });
});

describe('env-whitelist — readEnvOrDefault 语义', () => {
  it('变量存在返回变量值', () => {
    process.env.DAEMON_PORT = '12345';
    expect(readEnvOrDefault('DAEMON_PORT', '9999')).toBe('12345');
    delete process.env.DAEMON_PORT;
  });

  it('变量不存在返回默认值', () => {
    expect(readEnvOrDefault('DAEMON_PORT', '9999')).toBe('9999');
  });

  it('暴露 bug: 默认值不做任何校验，可注入任意字符串', () => {
    // 如果调用方期望数字，但传了非数字默认值，不会被发现
    expect(readEnvOrDefault('DAEMON_PORT', 'not-a-number')).toBe('not-a-number');
  });
});

describe('env-whitelist — readEnvAsNumber 数值解析', () => {
  beforeEach(() => {
    delete process.env.DAEMON_PORT;
  });
  afterEach(() => {
    delete process.env.DAEMON_PORT;
  });

  it('正常整数解析', () => {
    process.env.DAEMON_PORT = '8080';
    expect(readEnvAsNumber('DAEMON_PORT')).toBe(8080);
  });

  it('空字符串返回 undefined', () => {
    process.env.DAEMON_PORT = '';
    expect(readEnvAsNumber('DAEMON_PORT')).toBeUndefined();
  });

  it('未设置返回 undefined', () => {
    expect(readEnvAsNumber('DAEMON_PORT')).toBeUndefined();
  });

  it('非数字字符串返回 undefined', () => {
    process.env.DAEMON_PORT = 'abc';
    expect(readEnvAsNumber('DAEMON_PORT')).toBeUndefined();
  });

  it('Infinity 返回 undefined', () => {
    process.env.DAEMON_PORT = 'Infinity';
    expect(readEnvAsNumber('DAEMON_PORT')).toBeUndefined();
  });

  it('暴露 bug: 空白字符串 " " 被解析为 0 而非 undefined', () => {
    process.env.DAEMON_PORT = ' ';
    // Number(" ") === 0，但 isFinite(0) === true，所以返回 0
    // 调用方可能期望 undefined（视为未设置）
    expect(readEnvAsNumber('DAEMON_PORT')).toBe(0);
  });

  it('暴露 bug: hex 字符串 "0x10" 被静默解析为 16', () => {
    process.env.DAEMON_PORT = '0x10';
    // Number("0x10") === 16
    expect(readEnvAsNumber('DAEMON_PORT')).toBe(16);
    // 如果调用方期望端口号，0x10 = 16 是合法端口，但用户可能输入了字面 "0x10"
  });

  it('暴露 bug: 科学计数法 "1e5" 被静默解析为 100000', () => {
    process.env.DAEMON_PORT = '1e5';
    expect(readEnvAsNumber('DAEMON_PORT')).toBe(100000);
  });

  it('暴露 bug: 前后空格被 Number() 自动 trim', () => {
    process.env.DAEMON_PORT = '  8080  ';
    expect(readEnvAsNumber('DAEMON_PORT')).toBe(8080);
    // Number("  8080  ") === 8080，但原始值有空格
  });

  it('暴露 bug: "1_000" 在某些引擎下被解析为 1000', () => {
    process.env.DAEMON_PORT = '1_000';
    // V8 中 Number("1_000") === NaN（数字分隔符仅在字面量中有效）
    expect(readEnvAsNumber('DAEMON_PORT')).toBeUndefined();
    // 这个测试是反向验证：确认 V8 行为
  });

  it('暴露 bug: 浮点数被静默接受', () => {
    process.env.DAEMON_PORT = '8080.5';
    expect(readEnvAsNumber('DAEMON_PORT')).toBe(8080.5);
    // 端口号不应该是浮点数，但函数未校验
  });

  it('暴露 bug: 负数被静默接受', () => {
    process.env.DAEMON_PORT = '-1';
    expect(readEnvAsNumber('DAEMON_PORT')).toBe(-1);
    // 端口号不能为负，但函数未校验
  });

  it('属性测试: 对任意字符串，返回值要么是有限数要么是 undefined', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 32 }), (s) => {
        process.env.DAEMON_PORT = s;
        const result = readEnvAsNumber('DAEMON_PORT');
        if (result !== undefined) {
          expect(Number.isFinite(result)).toBe(true);
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });
});

describe('env-whitelist — isSensitiveEnv 敏感标记', () => {
  it('CRISH_API_KEY 被标记为敏感', () => {
    expect(isSensitiveEnv('CRISH_API_KEY')).toBe(true);
  });

  it('DAEMON_PORT 不被标记为敏感', () => {
    expect(isSensitiveEnv('DAEMON_PORT')).toBe(false);
  });

  it('暴露 bug: 白名单外的变量一律返回 false（即使名字含 KEY/SECRET）', () => {
    // 例如 GITHUB_TOKEN 不在白名单，isSensitiveEnv 返回 false
    // 但 readEnv 会抛错，所以不会泄露
    expect(isSensitiveEnv('GITHUB_TOKEN')).toBe(false);
    expect(isSensitiveEnv('DATABASE_PASSWORD')).toBe(false);
  });
});

describe('env-whitelist — snapshotAllowed 密钥泄露风险', () => {
  beforeEach(() => {
    delete process.env.CRISH_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    delete process.env.CRISH_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('暴露 bug: snapshotAllowed 返回敏感变量的真实值', () => {
    process.env.CRISH_API_KEY = 'sk-leak-me-12345';
    process.env.OPENAI_API_KEY = 'sk-another-leak';
    const snapshot = snapshotAllowed();
    const crishEntry = snapshot.find(s => s.name === 'CRISH_API_KEY');
    const openaiEntry = snapshot.find(s => s.name === 'OPENAI_API_KEY');
    expect(crishEntry?.value).toBe('sk-leak-me-12345');
    expect(crishEntry?.isSensitive).toBe(true);
    expect(openaiEntry?.value).toBe('sk-another-leak');
    // 如果调用方把这个 snapshot 写入日志，密钥就泄露了
  });

  it('snapshotAllowed 标记 isSensitive=true 但不脱敏', () => {
    process.env.CRISH_API_KEY = 'secret';
    const snapshot = snapshotAllowed();
    const entry = snapshot.find(s => s.name === 'CRISH_API_KEY');
    expect(entry?.isSensitive).toBe(true);
    expect(entry?.value).toBe('secret'); // 未脱敏
  });

  it('snapshotAllowed 包含所有白名单变量', () => {
    const snapshot = snapshotAllowed();
    const names = snapshot.map(s => s.name);
    expect(names).toContain('DAEMON_PORT');
    expect(names).toContain('CRISH_API_KEY');
    expect(names).toContain('OPENAI_API_KEY');
    expect(names).toContain('DAEMON_SECRET');
  });
});
