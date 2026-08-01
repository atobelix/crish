/**
 * utils/redact 单元测试（PE-04 T04.4-4 前端日志面脱敏）。
 *
 * 与 Rust 侧 conex-telemetry/src/redact.rs（PE-07 T07.4-D）共享同一正则规范；
 * 覆盖：sk- 前缀、Bearer、Authorization 头、凭据键值对、URL query 参数、
 * redactDeep 深度脱敏、maskSecretLast4 展示掩码。
 */
import { describe, expect, it } from 'vitest';
import { maskSecretLast4, redactDeep, redactSecrets } from './redact';

const FAKE_SK = 'sk-abcdefghijklmnopqrstuvwxyz123456';

describe('redactSecrets', () => {
  it('sk- 前缀密钥替换为掩码', () => {
    const out = redactSecrets(`openai key=${FAKE_SK} here`);
    expect(out).not.toContain(FAKE_SK);
    expect(out).toContain('***');
  });

  it('Bearer token 整体掩掉', () => {
    const out = redactSecrets('Authorization: Bearer tok_1234567890abcdef');
    expect(out).not.toContain('tok_1234567890abcdef');
    expect(out).toContain('***');
  });

  it('Authorization 头值掩掉（保留头名）', () => {
    const out = redactSecrets('Authorization: sk-secretvalue12345');
    expect(out).toBe('Authorization: ***');
  });

  it('凭据键值对掩值不掩键', () => {
    const out = redactSecrets('api_key=abcdef1234567890');
    expect(out).toContain('api_key=');
    expect(out).not.toContain('abcdef1234567890');
  });

  it('URL query 参数掩值不掩键', () => {
    const out = redactSecrets('https://api.example.com/v1?key=abc123xyz&model=gpt');
    expect(out).toContain('key=***');
    expect(out).toContain('model=gpt');
    expect(out).not.toContain('abc123xyz');
  });

  it('无敏感内容时原样返回', () => {
    const text = '普通日志内容：run started 200ms';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('redactDeep', () => {
  it('深度遍历对象中的字符串叶子', () => {
    const out = redactDeep({
      ok: true,
      url: `https://x.ai?key=${FAKE_SK}`,
      nested: { err: { message: `Bearer tok_secret7890` } },
    });
    expect(JSON.stringify(out)).not.toContain(FAKE_SK);
    expect(JSON.stringify(out)).not.toContain('tok_secret7890');
    expect(JSON.stringify(out)).toContain('***');
  });

  it('Error 实例转安全载荷', () => {
    const out = redactDeep(new Error(`boom ${FAKE_SK}`));
    const o = out as { message: string; stack?: string };
    expect(o.message).not.toContain(FAKE_SK);
    expect(o.message).toContain('***');
  });

  it('数组元素逐个脱敏', () => {
    const out = redactDeep([`a=${FAKE_SK}`, 'plain']);
    expect(JSON.stringify(out)).not.toContain(FAKE_SK);
  });
});

describe('maskSecretLast4', () => {
  it('保留前缀与末 4 位', () => {
    expect(maskSecretLast4(FAKE_SK)).toBe('sk-ab…3456');
  });

  it('短值只留前缀', () => {
    expect(maskSecretLast4('abc')).toBe('ab…');
  });

  it('空串返回空', () => {
    expect(maskSecretLast4('')).toBe('');
  });
});
