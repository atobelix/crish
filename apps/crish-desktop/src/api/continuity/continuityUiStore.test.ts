/**
 * D8 §3.7.4 continuityUiStore：临时通知（老虎机滚动状态）。
 * 事件 → store 单一数据源。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
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
