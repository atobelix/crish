/**
 * D8 §3.7.4 临时通知纯逻辑：老虎机滚动 label / 递增判定 / 错误 kind 中文映射。
 */
import { describe, expect, it } from 'vitest';
import {
  formatRetryLabel,
  isKnownErrorKind,
  isRetryAdvancing,
  isRetryInFlight,
  resolveErrorKindLabel,
} from './continuityNotices';
import { PROVIDER_ERROR_KIND_VALUES } from '../../../../../packages/shared-types/src/generated/engine';

describe('formatRetryLabel（老虎机滚动文案）', () => {
  it('1/6 → 2/6 递增文案', () => {
    expect(formatRetryLabel(1, 6)).toBe('重连中 1/6');
    expect(formatRetryLabel(2, 6)).toBe('重连中 2/6');
  });

  it('分母缺省（引擎未下发）按 0 显示，不臆测上限', () => {
    expect(formatRetryLabel(1, undefined)).toBe('重连中 1/0');
  });

  it('分母对齐：分子按分母位数补零（1/10 与 2/10 同宽不跳列）', () => {
    expect(formatRetryLabel(1, 10)).toBe('重连中 01/10');
    expect(formatRetryLabel(2, 10)).toBe('重连中 02/10');
    expect(formatRetryLabel(1, 6)).toBe('重连中 1/6');
  });

  it('非数值/负数宽容归一', () => {
    expect(formatRetryLabel(-3, 6)).toBe('重连中 0/6');
  });
});

describe('isRetryAdvancing（老虎机滚动触发判定）', () => {
  it('无前值或递增 → true（触发滚动）', () => {
    expect(isRetryAdvancing(undefined, 1)).toBe(true);
    expect(isRetryAdvancing(1, 2)).toBe(true);
  });

  it('重复值/回退 → false（不抖动）', () => {
    expect(isRetryAdvancing(2, 2)).toBe(false);
    expect(isRetryAdvancing(2, 1)).toBe(false);
  });
});

describe('isRetryInFlight（重连进行中判定）', () => {
  it('attempt>0 且未达上限 → 进行中', () => {
    expect(isRetryInFlight(1, 6)).toBe(true);
    expect(isRetryInFlight(5, 6)).toBe(true);
  });

  it('达上限/attempt=0 → 不在进行中（完成清除）', () => {
    expect(isRetryInFlight(6, 6)).toBe(false);
    expect(isRetryInFlight(0, 6)).toBe(false);
  });

  it('上限未下发（0/缺省）→ 有 attempt 即视为进行中', () => {
    expect(isRetryInFlight(2, undefined)).toBe(true);
    expect(isRetryInFlight(2, 0)).toBe(true);
  });
});

describe('resolveErrorKindLabel（kebab-case → 中文）', () => {
  it('登记 kind 全覆盖（与生成枚举一致，防漂移）', () => {
    for (const kind of PROVIDER_ERROR_KIND_VALUES) {
      expect(isKnownErrorKind(kind)).toBe(true);
      const label = resolveErrorKindLabel(kind);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(kind);
    }
  });

  it('常见 kind 中文映射', () => {
    expect(resolveErrorKindLabel('timeout')).toBe('请求超时');
    expect(resolveErrorKindLabel('network')).toBe('网络异常');
    expect(resolveErrorKindLabel('rate-limit')).toBe('触发限流');
    expect(resolveErrorKindLabel('auth')).toBe('认证失败');
  });

  it('空值 → 空串（不渲染幽灵徽标）', () => {
    expect(resolveErrorKindLabel('')).toBe('');
    expect(resolveErrorKindLabel(null)).toBe('');
    expect(resolveErrorKindLabel(undefined)).toBe('');
  });

  it('未知值原样透传（引擎新枚举不静默吞）', () => {
    expect(resolveErrorKindLabel('brand-new-kind')).toBe('brand-new-kind');
  });
});
