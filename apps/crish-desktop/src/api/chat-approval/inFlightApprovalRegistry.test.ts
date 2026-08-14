import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inFlightApprovalRegistry } from './inFlightApprovalRegistry';

describe('inFlightApprovalRegistry (A-05 跨实例审批锁)', () => {
  beforeEach(() => {
    inFlightApprovalRegistry.clearForTest();
  });

  it('并发 acquire 仅首个成功获取锁，重复 acquire 返回空数组', () => {
    const first = inFlightApprovalRegistry.acquire(['tool-1', 'tool-2']);
    expect(first).toEqual(['tool-1', 'tool-2']);
    expect(inFlightApprovalRegistry.isBusy('tool-1')).toBe(true);
    expect(inFlightApprovalRegistry.isBusy('tool-2')).toBe(true);
    expect(inFlightApprovalRegistry.getCount()).toBe(2);

    // 重复 acquire 同 toolId
    const second = inFlightApprovalRegistry.acquire(['tool-1', 'tool-3']);
    expect(second).toEqual(['tool-3']);
    expect(inFlightApprovalRegistry.getCount()).toBe(3);
  });

  it('release 释放锁并通知订阅者', () => {
    const listener = vi.fn();
    const unsub = inFlightApprovalRegistry.subscribe(listener);

    inFlightApprovalRegistry.acquire(['tool-1']);
    expect(listener).toHaveBeenCalledTimes(1);

    inFlightApprovalRegistry.release(['tool-1']);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(inFlightApprovalRegistry.isBusy('tool-1')).toBe(false);
    expect(inFlightApprovalRegistry.getCount()).toBe(0);

    unsub();
  });
});
