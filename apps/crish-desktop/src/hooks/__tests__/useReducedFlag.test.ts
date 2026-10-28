/** @vitest-environment jsdom */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useReducedFlag, useEffectiveReducedMotion } from '../useReducedFlag';

describe('useReducedFlag & useEffectiveReducedMotion', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-perf-tier');
  });

  afterEach(() => {
    document.documentElement.removeAttribute('data-perf-tier');
  });

  it('useReducedFlag 返回布尔值', () => {
    const { result } = renderHook(() => useReducedFlag());
    expect(typeof result.current).toBe('boolean');
  });

  it('useEffectiveReducedMotion 在默认状态下正常返回', () => {
    const { result } = renderHook(() => useEffectiveReducedMotion());
    expect(result.current.isHydrated).toBe(true);
    expect(result.current.isEcoTier).toBe(false);
  });

  it('当 documentElement 设置 data-perf-tier=eco 时响应式更新 isEcoTier', async () => {
    const { result } = renderHook(() => useEffectiveReducedMotion());
    expect(result.current.isEcoTier).toBe(false);

    document.documentElement.setAttribute('data-perf-tier', 'eco');

    await waitFor(() => {
      expect(result.current.isEcoTier).toBe(true);
      expect(result.current.isReduced).toBe(true);
    });

    document.documentElement.setAttribute('data-perf-tier', 'high');

    await waitFor(() => {
      expect(result.current.isEcoTier).toBe(false);
    });
  });
});
