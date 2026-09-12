import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryManager, DEFAULT_ABSOLUTE_LIMITS } from '@crish/shared-utils';

describe('Memory Pressure Handling (ACT-606 绝对物理阈值)', () => {
  const MB = 1024 * 1024;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubHeap(usedBytes: number): void {
    Object.defineProperty(performance, 'memory', {
      configurable: true,
      value: {
        usedJSHeapSize: usedBytes,
        jsHeapSizeLimit: 4 * 1024 * MB, // 虚假 4GB 上限（证明绝对阈值独立于它）
      },
    });
  }

  it('handles pressure level escalation without throwing', () => {
    const mm = new MemoryManager({ checkIntervalMs: 60000 });
    // 无 performance.memory 时 evaluate 静默跳过
    mm.evaluate();
    expect(mm.level).toBe(0);
  });

  it('暂定默认阈值为 60/90/130MB（待测标记）', () => {
    expect(DEFAULT_ABSOLUTE_LIMITS.lowWarnBytes).toBe(60 * MB);
    expect(DEFAULT_ABSOLUTE_LIMITS.mediumPressureBytes).toBe(90 * MB);
    expect(DEFAULT_ABSOLUTE_LIMITS.criticalBytes).toBe(130 * MB);
    expect(DEFAULT_ABSOLUTE_LIMITS.restoreBytes).toBe(42 * MB);
  });

  it('绝对阈值分级：60→L1, 90→L2, 130→L3', () => {
    const mm = new MemoryManager({ checkIntervalMs: 60_000_000 });
    const events: Array<{ level: number; usedBytes: number }> = [];
    mm.onPressure((evt) => events.push({ level: evt.level, usedBytes: evt.usedBytes }));

    stubHeap(61 * MB);
    mm.evaluate();
    expect(mm.level).toBe(1);

    stubHeap(95 * MB);
    mm.evaluate();
    expect(mm.level).toBe(2);

    stubHeap(140 * MB);
    mm.evaluate();
    expect(mm.level).toBe(3);

    expect(events.map((e) => e.level)).toEqual([1, 2, 3]);
  });

  it('滞后恢复：降至 restoreBytes 以下回落 Level 0', () => {
    const mm = new MemoryManager({ checkIntervalMs: 60_000_000 });
    stubHeap(140 * MB);
    mm.evaluate();
    expect(mm.level).toBe(3);

    // 滞后带内（42 < used < 60）：保持 L3 防抖
    stubHeap(50 * MB);
    mm.evaluate();
    expect(mm.level).toBe(3);

    stubHeap(40 * MB);
    mm.evaluate();
    expect(mm.level).toBe(0);
  });

  it('apps 熔断经 onPressure 注入；packages 不感知订阅者', () => {
    const mm = new MemoryManager({ checkIntervalMs: 60_000_000 });
    const clear = vi.fn();
    const off = mm.onPressure((evt) => {
      if (evt.level === 3) clear();
    });

    stubHeap(140 * MB);
    mm.evaluate();
    expect(clear).toHaveBeenCalledTimes(1);

    off();
    stubHeap(50 * MB);
    mm.evaluate();
    stubHeap(140 * MB);
    mm.evaluate();
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
