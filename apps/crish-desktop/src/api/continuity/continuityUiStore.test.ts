/**
 * D8 §3.7.4/§3.7.5 continuityUiStore：临时通知（老虎机滚动状态）+
 * 熔断横幅（触发/关闭）。事件 → store 单一数据源。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  CIRCUIT_BANNER_DEFAULT_MESSAGE,
  isCircuitTripDetail,
  resetContinuityUiStoreForTests,
  useContinuityUiStore,
} from './continuityUiStore';

describe('applyRetryNotice（临时通知老虎机滚动）', () => {
  beforeEach(() => {
    resetContinuityUiStoreForTests();
  });

  it('provider-diagnostic phase=retry 到达 → 投影 attempt/maxAttempts', () => {
    useContinuityUiStore.getState().applyRetryNotice('s1', 1, 6);
    const notice = useContinuityUiStore.getState().retryNotices['s1'];
    expect(notice).toBeDefined();
    expect(notice!.attempt).toBe(1);
    expect(notice!.maxAttempts).toBe(6);
  });

  it('attempt 递增覆盖（1/6 → 2/6），不叠层', () => {
    useContinuityUiStore.getState().applyRetryNotice('s1', 1, 6);
    useContinuityUiStore.getState().applyRetryNotice('s1', 2, 6);
    const notice = useContinuityUiStore.getState().retryNotices['s1'];
    expect(notice!.attempt).toBe(2);
    expect(
      Object.keys(useContinuityUiStore.getState().retryNotices)
    ).toHaveLength(1);
  });

  it('maxAttempts 未下发（0/缺省）→ 不写分母字段', () => {
    useContinuityUiStore.getState().applyRetryNotice('s1', 1);
    const notice = useContinuityUiStore.getState().retryNotices['s1'];
    expect(notice!.attempt).toBe(1);
    expect(notice!.maxAttempts).toBeUndefined();
  });

  it('会话隔离：不同 sessionId 互不干扰', () => {
    useContinuityUiStore.getState().applyRetryNotice('s1', 1, 6);
    useContinuityUiStore.getState().applyRetryNotice('s2', 2, 6);
    expect(useContinuityUiStore.getState().retryNotices['s1']!.attempt).toBe(1);
    expect(useContinuityUiStore.getState().retryNotices['s2']!.attempt).toBe(2);
  });

  it('空 sessionId 拒绝写入', () => {
    useContinuityUiStore.getState().applyRetryNotice('', 1, 6);
    expect(
      Object.keys(useContinuityUiStore.getState().retryNotices)
    ).toHaveLength(0);
  });
});

describe('clearRetryNotice（重连完成/失败清除）', () => {
  beforeEach(() => {
    resetContinuityUiStoreForTests();
  });

  it('重连成功/失败 → 清除（不留残余滚动态）', () => {
    useContinuityUiStore.getState().applyRetryNotice('s1', 2, 6);
    useContinuityUiStore.getState().clearRetryNotice('s1');
    expect(useContinuityUiStore.getState().retryNotices['s1']).toBeUndefined();
    expect(
      Object.keys(useContinuityUiStore.getState().retryNotices)
    ).toHaveLength(0);
  });

  it('无状态时清除幂等', () => {
    useContinuityUiStore.getState().clearRetryNotice('s1');
    expect(
      Object.keys(useContinuityUiStore.getState().retryNotices)
    ).toHaveLength(0);
  });
});

describe('raiseCircuitBanner / dismissCircuitBanner（熔断横幅）', () => {
  beforeEach(() => {
    resetContinuityUiStoreForTests();
  });

  it('熔断触发 → 横幅展示（默认文案 + reason）', () => {
    useContinuityUiStore
      .getState()
      .raiseCircuitBanner('s1', CIRCUIT_BANNER_DEFAULT_MESSAGE, 'circuit-trip');
    const banner = useContinuityUiStore.getState().circuitBanners['s1'];
    expect(banner).toBeDefined();
    expect(banner!.message).toBe(CIRCUIT_BANNER_DEFAULT_MESSAGE);
    expect(banner!.reason).toBe('circuit-trip');
    expect(banner!.dismissed).toBe(false);
  });

  it('手动关闭 → dismissed=true（同 session 不重弹）', () => {
    useContinuityUiStore
      .getState()
      .raiseCircuitBanner('s1', CIRCUIT_BANNER_DEFAULT_MESSAGE);
    useContinuityUiStore.getState().dismissCircuitBanner('s1');
    expect(
      useContinuityUiStore.getState().circuitBanners['s1']!.dismissed
    ).toBe(true);
  });

  it('新触发覆盖已关闭态（dismissed 复位）', () => {
    useContinuityUiStore.getState().raiseCircuitBanner('s1', 'a');
    useContinuityUiStore.getState().dismissCircuitBanner('s1');
    useContinuityUiStore
      .getState()
      .raiseCircuitBanner('s1', 'b', 'circuit-trip');
    const banner = useContinuityUiStore.getState().circuitBanners['s1'];
    expect(banner!.dismissed).toBe(false);
    expect(banner!.message).toBe('b');
  });

  it('会话隔离 + 空 sessionId 拒绝', () => {
    useContinuityUiStore.getState().raiseCircuitBanner('s1', 'a');
    useContinuityUiStore.getState().raiseCircuitBanner('', 'x');
    expect(
      useContinuityUiStore.getState().circuitBanners['s2']
    ).toBeUndefined();
    expect(
      Object.keys(useContinuityUiStore.getState().circuitBanners)
    ).toHaveLength(1);
  });
});

describe('isCircuitTripDetail', () => {
  it('detail=circuit-trip 判定', () => {
    expect(isCircuitTripDetail('circuit-trip')).toBe(true);
    expect(isCircuitTripDetail('')).toBe(false);
    expect(isCircuitTripDetail(null)).toBe(false);
    expect(isCircuitTripDetail('other')).toBe(false);
  });
});
