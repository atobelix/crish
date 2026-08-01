/**
 * 错误分类统一规范测试：
 * Rust 侧已分类的 kebab 错误码（provider 错误（auth）：… / endpoint-unavailable）
 * 必须被前端 classifySoftFailure 正确识别——前端不再按英文文本重复猜测。
 */
import { describe, expect, it } from 'vitest';
import { classifySoftFailure, softFailureMessage } from './userFacingErrors';

describe('classifySoftFailure：Rust kebab 错误码优先识别（统一规范）', () => {
  it('auth：Rust provider 错误（auth）包装被识别', () => {
    expect(classifySoftFailure('provider 错误（auth）：鉴权失败（HTTP Some(401)）')).toBe(
      'auth',
    );
    expect(classifySoftFailure('provider 错误（auth）：invalid api key')).toBe('auth');
  });

  it('network：endpoint-unavailable / network / timeout 归为网络', () => {
    expect(
      classifySoftFailure('provider 错误（endpoint-unavailable）：端点不可用（HTTP Some(404)）'),
    ).toBe('network');
    expect(classifySoftFailure('provider 错误（network）：connection reset')).toBe('network');
    expect(classifySoftFailure('provider 错误（timeout）：request timed out')).toBe('network');
  });

  it('blocked：quota / rate-limit / gateway-challenge 归为受限', () => {
    expect(classifySoftFailure('provider 错误（quota）：Insufficient balance')).toBe('blocked');
    expect(classifySoftFailure('provider 错误（rate-limit）：429 Too Many Requests')).toBe(
      'blocked',
    );
    expect(classifySoftFailure('provider 错误（gateway-challenge）：cf_chl')).toBe('blocked');
  });

  it('no_key：Rust 密钥缺失文案被识别', () => {
    expect(classifySoftFailure('引擎未就绪（provider 配置缺失或加载失败）')).toBe('no_key');
  });

  it('ended：无法分类的通用失败', () => {
    expect(classifySoftFailure('boom')).toBeNull();
    expect(classifySoftFailure('task failed: boom')).toBe('ended');
    expect(classifySoftFailure('run error occurred')).toBe('ended');
    expect(classifySoftFailure('')).toBeNull();
    expect(classifySoftFailure(null)).toBeNull();
  });
});

describe('softFailureMessage：分类文案覆盖', () => {
  it('所有分类都有用户可读文案', () => {
    for (const kind of ['network', 'no_key', 'auth', 'no_project', 'blocked', 'ended'] as const) {
      expect(softFailureMessage(kind)).toBeTruthy();
    }
  });
});
