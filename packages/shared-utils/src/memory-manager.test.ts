import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheProvider } from './cache';
import {
  DEFAULT_ABSOLUTE_LIMITS,
  MemoryManager,
  memoryManager,
  type MemoryPressureEvent,
} from './memory-manager';

const MB = 1024 * 1024;

function setHeap(usedMB: number | undefined) {
  if (usedMB === undefined) {
    vi.stubGlobal('performance', { now: () => 0 });
    return;
  }
  vi.stubGlobal('performance', {
    now: () => 0,
    memory: { usedJSHeapSize: usedMB * MB, jsHeapSizeLimit: 4096 * MB },
  });
}

function fakeCache() {
  return { shrink: vi.fn() } as unknown as CacheProvider<unknown, unknown> & {
    shrink: ReturnType<typeof vi.fn>;
  };
}

function track(m: MemoryManager): MemoryPressureEvent[] {
  const events: MemoryPressureEvent[] = [];
  m.onPressure((e) => events.push(e));
  return events;
}

beforeEach(() => {
  setHeap(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MemoryManager 阈值判定', () => {
  it('默认阈值为 60/90/130MB，恢复线 42MB；absoluteLimits 返回副本', () => {
    const m = new MemoryManager();
    expect(m.absoluteLimits).toEqual({
      lowWarnBytes: 60 * MB,
      mediumPressureBytes: 90 * MB,
      criticalBytes: 130 * MB,
      restoreBytes: 42 * MB,
    });
    const copy = m.absoluteLimits;
    copy.criticalBytes = 1;
    expect(m.absoluteLimits.criticalBytes).toBe(130 * MB);
    expect(DEFAULT_ABSOLUTE_LIMITS.criticalBytes).toBe(130 * MB);
    expect(m.level).toBe(0);
  });

  it.each([
    [59, 0],
    [60, 1],
    [89, 1],
    [90, 2],
    [129, 2],
    [130, 3],
    [500, 3],
  ] as const)('从 0 档起，已用 %iMB → 档位 %i', (usedMB, level) => {
    const m = new MemoryManager();
    const events = track(m);
    setHeap(usedMB);
    m.evaluate();
    expect(m.level).toBe(level);
    if (level === 0) {
      expect(events).toEqual([]);
    } else {
      expect(events).toEqual([
        { level, usedBytes: usedMB * MB, limits: m.absoluteLimits },
      ]);
    }
  });

  it('滞后带（42MB ≤ used < 60MB）保持当前档位，低于 42MB 才回落 0 档', () => {
    const m = new MemoryManager();
    const events = track(m);
    setHeap(100);
    m.evaluate();
    expect(m.level).toBe(2);

    setHeap(50);
    m.evaluate();
    expect(m.level).toBe(2);

    setHeap(42);
    m.evaluate();
    expect(m.level).toBe(2);

    setHeap(41);
    m.evaluate();
    expect(m.level).toBe(0);
    expect(events.map((e) => e.level)).toEqual([2, 0]);
  });

  it('档位不变时不重复广播', () => {
    const m = new MemoryManager();
    const events = track(m);
    setHeap(70);
    m.evaluate();
    setHeap(80);
    m.evaluate();
    expect(events).toHaveLength(1);
  });

  it('自定义阈值部分覆盖默认值', () => {
    const m = new MemoryManager({ limits: { criticalBytes: 100 * MB } });
    expect(m.absoluteLimits.criticalBytes).toBe(100 * MB);
    expect(m.absoluteLimits.lowWarnBytes).toBe(60 * MB);
    setHeap(100);
    m.evaluate();
    expect(m.level).toBe(3);
  });

  it('无 performance.memory、字段类型不对或读取抛错时静默跳过', () => {
    const m = new MemoryManager();
    const events = track(m);
    m.evaluate();
    vi.stubGlobal('performance', {
      memory: { usedJSHeapSize: '999', jsHeapSizeLimit: 1 },
    });
    m.evaluate();
    const perf = {};
    Object.defineProperty(perf, 'memory', {
      get() {
        throw new Error('denied');
      },
    });
    vi.stubGlobal('performance', perf);
    m.evaluate();
    expect(m.level).toBe(0);
    expect(events).toEqual([]);
  });
});

describe('缓存收缩与监听器', () => {
  it('按档位比例收缩已注册缓存；单个缓存失败不影响其余；unregister 后不再收缩', () => {
    const m = new MemoryManager();
    const a = fakeCache();
    const b = fakeCache();
    const c = fakeCache();
    a.shrink.mockImplementation(() => {
      throw new Error('shrink failed');
    });
    m.register(a);
    m.register(b);
    m.register(c);
    expect(m.getCaches()).toEqual([a, b, c]);

    setHeap(60);
    m.evaluate();
    expect(b.shrink).toHaveBeenLastCalledWith(0.8);
    setHeap(90);
    m.evaluate();
    expect(b.shrink).toHaveBeenLastCalledWith(0.5);
    setHeap(130);
    m.evaluate();
    expect(b.shrink).toHaveBeenLastCalledWith(0.1);
    setHeap(10);
    m.evaluate();
    expect(b.shrink).toHaveBeenLastCalledWith(1.0);
    expect(c.shrink).toHaveBeenCalledTimes(4);

    m.unregister(c);
    m.unregister(c); // 重复注销无副作用
    expect(m.getCaches()).toEqual([a, b]);
    setHeap(200);
    m.evaluate();
    expect(c.shrink).toHaveBeenCalledTimes(4);
    expect(b.shrink).toHaveBeenCalledTimes(5);
  });

  it('监听器异常被记录且不阻断后续监听器；退订后不再接收', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const m = new MemoryManager();
    const boom = new Error('listener bug');
    m.onPressure(() => {
      throw boom;
    });
    const good = vi.fn();
    const off = m.onPressure(good);

    setHeap(95);
    m.evaluate();
    expect(good).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      '[MemoryManager] 压力监听器执行异常:',
      boom
    );

    off();
    off();
    setHeap(10);
    m.evaluate();
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe('定时采样', () => {
  it('start 按 checkIntervalMs 周期采样，重复 start 只建一个定时器；stop 后停止', () => {
    vi.useFakeTimers();
    const m = new MemoryManager({ checkIntervalMs: 1000 });
    const events = track(m);
    m.stop(); // 未启动时 stop 为空操作
    m.start();
    m.start();
    expect(vi.getTimerCount()).toBe(1);

    setHeap(70);
    vi.advanceTimersByTime(999);
    expect(m.level).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.level).toBe(1);

    m.stop();
    expect(vi.getTimerCount()).toBe(0);
    setHeap(200);
    vi.advanceTimersByTime(5000);
    expect(m.level).toBe(1);
    expect(events).toHaveLength(1);
  });

  it('默认采样间隔 30s', () => {
    vi.useFakeTimers();
    const m = new MemoryManager();
    setHeap(140);
    m.start();
    vi.advanceTimersByTime(29_999);
    expect(m.level).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.level).toBe(3);
    m.stop();
  });

  it('导出的单例使用默认阈值', () => {
    expect(memoryManager).toBeInstanceOf(MemoryManager);
    expect(memoryManager.absoluteLimits).toEqual(DEFAULT_ABSOLUTE_LIMITS);
  });
});
