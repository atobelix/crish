/**
 * DynamicAdaptationEngine 行为测试。
 *
 * 引擎依赖宿主的 requestAnimationFrame / performance.memory / indexedDB 与定时器，
 * 这里用 fake timers + vi.stubGlobal 驱动这些外部输入，被测引擎与
 * performance-tier 规则均为真实实现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HardwareProfile } from './hardware-profile';
import {
  DynamicAdaptationEngine,
  createAdaptationEngine,
  type MetricEvent,
} from './dynamic-adaptation';
import { PerformanceLevel, TIER_CONFIGS } from './performance-tier';

const GiB = 1024 ** 3;

/** 弱机：1 核、无 GPU、HDD → 引擎内评分 0 */
function weakProfile(
  overrides: Partial<HardwareProfile> = {}
): HardwareProfile {
  return {
    cpu: { cores: 1 },
    memory: { total: 1 * GiB, deviceMemory: 1 },
    gpu: { available: false, webgpu: false, webgl: false, canvas2d: false },
    storage: { type: 'hdd' },
    platform: 'linux',
    isTauri: false,
    ...overrides,
  };
}

/** 强机：8 核、16GB、WebGPU+NVIDIA、SSD → assignTier 115 分（Level3） */
function strongProfile(): HardwareProfile {
  return {
    cpu: { cores: 8 },
    memory: { total: 16 * GiB, deviceMemory: 8 },
    gpu: {
      available: true,
      webgpu: true,
      webgl: true,
      canvas2d: true,
      vendor: 'NVIDIA',
    },
    storage: { type: 'ssd' },
    platform: 'windows',
    isTauri: true,
  };
}

let rafCallbacks: Map<number, (ts: number) => void>;
let rafSeq: number;
const raf = vi.fn((cb: (ts: number) => void) => {
  rafSeq += 1;
  rafCallbacks.set(rafSeq, cb);
  return rafSeq;
});
const caf = vi.fn((id: number) => {
  rafCallbacks.delete(id);
});

/** 依次以给定时间戳驱动一帧（总是调用最新注册的回调） */
function frames(timestamps: number[]) {
  for (const ts of timestamps) {
    const id = rafSeq;
    const cb = rafCallbacks.get(id);
    if (!cb) throw new Error('no pending frame');
    rafCallbacks.delete(id);
    cb(ts);
  }
}

function stubPerformance(
  memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number },
  now?: () => number
) {
  vi.stubGlobal('performance', {
    now: now ?? (() => Date.now()),
    ...(memory ? { memory } : {}),
  });
}

/** 让 IndexedDB 假实现的 Promise 回调链跑完 */
async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function collect(engine: DynamicAdaptationEngine): MetricEvent[] {
  const events: MetricEvent[] = [];
  engine.onEvent((e) => events.push(e));
  return events;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  rafCallbacks = new Map();
  rafSeq = 0;
  raf.mockClear();
  caf.mockClear();
  vi.stubGlobal('requestAnimationFrame', raf);
  vi.stubGlobal('cancelAnimationFrame', caf);
  stubPerformance();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('构造与访问器', () => {
  it('未指定 initialLevel 时按 assignTier 定级', () => {
    const p = strongProfile();
    const e = new DynamicAdaptationEngine(p);
    expect(e.level).toBe(PerformanceLevel.Level3);
    expect(e.config).toBe(TIER_CONFIGS[PerformanceLevel.Level3]);
    expect(e.profile).toBe(p);
  });

  it('指定 initialLevel 时优先于硬件评分', () => {
    const e = new DynamicAdaptationEngine(strongProfile(), {
      initialLevel: PerformanceLevel.Level0,
    });
    expect(e.level).toBe(PerformanceLevel.Level0);
    expect(e.config.label).toBe(TIER_CONFIGS[0].label);
  });

  it('updateProfile 替换 profile，影响后续评分', () => {
    const e = new DynamicAdaptationEngine(weakProfile(), {
      initialLevel: PerformanceLevel.Level1,
    });
    expect(e.getMetrics().compositeScore).toBe(0);
    const next = strongProfile();
    e.updateProfile(next);
    expect(e.profile).toBe(next);
    // 引擎评分的内存项取 performance.memory（此处缺省 512MB → 0 分）：40 + 20 + 10 + 5
    expect(e.getMetrics().compositeScore).toBe(75);
  });
});

describe('getMetrics', () => {
  it('读取 performance.memory 计算堆占用与空闲比例', () => {
    stubPerformance({ usedJSHeapSize: 3 * GiB, jsHeapSizeLimit: 4 * GiB });
    const e = new DynamicAdaptationEngine(
      weakProfile({ storage: { type: 'ssd' } }),
      {
        initialLevel: PerformanceLevel.Level1,
      }
    );
    e.recordWsRtt(100);
    e.recordWsRtt(200);
    const m = e.getMetrics();
    expect(m.heapUsed).toBe(3 * GiB);
    expect(m.heapTotal).toBe(4 * GiB);
    expect(m.memoryFreeRatio).toBeCloseTo(0.25);
    expect(m.storageType).toBe('ssd');
    expect(m.avgWsRttMs).toBe(150);
    expect(m.fps).toBe(0);
    expect(m.dropFrameRate).toBe(0);
    expect(m.avgWriteLatencyMs).toBe(0);
    // 堆上限 4GiB → +25；SSD → +5
    expect(m.compositeScore).toBe(30);
  });

  it('无 performance.memory 或读取抛错时用 512MB / 0.5 兜底', () => {
    const e = new DynamicAdaptationEngine(weakProfile(), {
      initialLevel: PerformanceLevel.Level1,
    });
    expect(e.getMetrics()).toMatchObject({
      heapUsed: 0,
      heapTotal: 512 * 1024 * 1024,
      memoryFreeRatio: 0.5,
    });

    const perf = { now: () => 0 };
    Object.defineProperty(perf, 'memory', {
      get() {
        throw new Error('blocked');
      },
    });
    vi.stubGlobal('performance', perf);
    expect(e.getMetrics()).toMatchObject({
      heapUsed: 0,
      heapTotal: 512 * 1024 * 1024,
      memoryFreeRatio: 0.5,
    });
  });

  it('评分各档：核数 4/2、堆 8GiB/2GiB、WebGL/Canvas、非 WebGPU 时厂商不加分', () => {
    stubPerformance({ usedJSHeapSize: 0, jsHeapSizeLimit: 8 * GiB });
    const e = new DynamicAdaptationEngine(
      weakProfile({
        cpu: { cores: 4 },
        gpu: {
          available: true,
          webgpu: false,
          webgl: true,
          canvas2d: true,
          vendor: 'nvidia',
        },
      }),
      { initialLevel: PerformanceLevel.Level1 }
    );
    expect(e.getMetrics().compositeScore).toBe(25 + 40 + 10);

    stubPerformance({ usedJSHeapSize: 0, jsHeapSizeLimit: 2 * GiB });
    e.updateProfile(
      weakProfile({
        cpu: { cores: 2 },
        gpu: { available: true, webgpu: false, webgl: false, canvas2d: true },
      })
    );
    expect(e.getMetrics().compositeScore).toBe(10 + 10 + 5);
  });
});

describe('网络 RTT 降级', () => {
  it('均值 >300ms 且评分低于本级 60% 时降一级，10s 内不重复切换，Level0 不再降', () => {
    const e = new DynamicAdaptationEngine(weakProfile(), {
      initialLevel: PerformanceLevel.Level2,
    });
    const events = collect(e);

    e.recordWsRtt(400);
    expect(e.level).toBe(PerformanceLevel.Level1);
    expect(e.config).toBe(TIER_CONFIGS[1]);
    expect(events).toEqual([
      {
        type: 'network_latency',
        timestamp: 1_000_000,
        metrics: { avgWsRttMs: 400 },
        fromLevel: 2,
        toLevel: 1,
      },
    ]);

    // 冷却期内
    vi.setSystemTime(1_000_000 + 9_999);
    e.recordWsRtt(400);
    expect(events).toHaveLength(1);

    vi.setSystemTime(1_000_000 + 10_000);
    e.recordWsRtt(400);
    expect(e.level).toBe(PerformanceLevel.Level0);
    expect(events[1]).toMatchObject({
      type: 'network_latency',
      fromLevel: 1,
      toLevel: 0,
    });

    vi.setSystemTime(1_000_000 + 30_000);
    e.recordWsRtt(1000);
    expect(events).toHaveLength(2);
  });

  it('均值 ≤300ms 不降级', () => {
    const e = new DynamicAdaptationEngine(weakProfile(), {
      initialLevel: PerformanceLevel.Level2,
    });
    const events = collect(e);
    e.recordWsRtt(300);
    e.recordWsRtt(250);
    expect(events).toEqual([]);
    expect(e.level).toBe(PerformanceLevel.Level2);
  });

  it('评分足够高时即使 RTT 很差也不降级', () => {
    stubPerformance({ usedJSHeapSize: 0, jsHeapSizeLimit: 16 * GiB });
    const e = new DynamicAdaptationEngine(strongProfile());
    const events = collect(e);
    e.recordWsRtt(5000);
    expect(events).toEqual([]);
    expect(e.level).toBe(PerformanceLevel.Level3);
  });
});

describe('升级与监听器', () => {
  it('checkUpgrade 需达到下一级阈值 120%，逐级升且受 10s 冷却约束', () => {
    stubPerformance({ usedJSHeapSize: 0, jsHeapSizeLimit: 16 * GiB });
    const e = new DynamicAdaptationEngine(strongProfile(), {
      initialLevel: PerformanceLevel.Level0,
    });
    const events = collect(e);

    e.checkUpgrade();
    expect(e.level).toBe(PerformanceLevel.Level1);
    expect(events[0]).toEqual({
      type: 'level_up',
      timestamp: 1_000_000,
      metrics: {},
      fromLevel: 0,
      toLevel: 1,
    });

    e.checkUpgrade();
    expect(e.level).toBe(PerformanceLevel.Level1);

    for (const expected of [2, 3, 3]) {
      vi.advanceTimersByTime(10_000);
      e.checkUpgrade();
      expect(e.level).toBe(expected);
    }
    expect(events.map((x) => x.toLevel)).toEqual([1, 2, 3]);
  });

  it('评分不足以升级时保持不变', () => {
    const e = new DynamicAdaptationEngine(weakProfile(), {
      initialLevel: PerformanceLevel.Level0,
    });
    const events = collect(e);
    e.checkUpgrade();
    expect(e.level).toBe(PerformanceLevel.Level0);
    expect(events).toEqual([]);
  });

  it('stop 之后 checkUpgrade / start 都是空操作', () => {
    stubPerformance({ usedJSHeapSize: 0, jsHeapSizeLimit: 16 * GiB });
    const e = new DynamicAdaptationEngine(strongProfile(), {
      initialLevel: PerformanceLevel.Level0,
    });
    e.stop();
    e.checkUpgrade();
    expect(e.level).toBe(PerformanceLevel.Level0);
    e.start();
    expect(raf).not.toHaveBeenCalled();
  });

  it('监听器抛错不影响其他监听器；取消订阅后不再收到事件', () => {
    const e = new DynamicAdaptationEngine(weakProfile(), {
      initialLevel: PerformanceLevel.Level3,
    });
    const bad = vi.fn(() => {
      throw new Error('listener bug');
    });
    const good = vi.fn();
    e.onEvent(bad);
    const off = e.onEvent(good);

    e.recordWsRtt(999);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);

    off();
    vi.advanceTimersByTime(10_000);
    e.recordWsRtt(999);
    expect(bad).toHaveBeenCalledTimes(2);
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe('FPS 监测', () => {
  it('掉帧率均值 >30% 触发 fps_drop 降级，并把目标帧率切到新等级', () => {
    const e = new DynamicAdaptationEngine(weakProfile(), {
      initialLevel: PerformanceLevel.Level2,
    });
    const events = collect(e);
    e.start();
    e.start(); // 重复 start 不会重复注册帧回调
    expect(raf).toHaveBeenCalledTimes(1);

    // 10fps，目标 60fps → 掉帧率 1 - 1/6
    frames([0, 100]);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('fps_drop');
    expect(events[0]!.fromLevel).toBe(2);
    expect(events[0]!.toLevel).toBe(1);
    expect(events[0]!.metrics.fps).toBeCloseTo(10);
    expect(events[0]!.metrics.dropFrameRate).toBeCloseTo(5 / 6);
    expect(e.getMetrics().fps).toBeCloseTo(10);

    e.stop();
    expect(caf).toHaveBeenCalledWith(rafSeq);
  });

  it('帧率达标时不降级；单帧不产生采样', () => {
    const e = new DynamicAdaptationEngine(weakProfile(), {
      initialLevel: PerformanceLevel.Level2,
    });
    const events = collect(e);
    e.start();
    frames([0]);
    expect(e.getMetrics().fps).toBe(0);
    frames([1000 / 60, 2000 / 60, 3000 / 60, 4000 / 60]);
    expect(events).toEqual([]);
    expect(e.getMetrics().fps).toBeCloseTo(60);
    expect(e.getMetrics().dropFrameRate).toBeCloseTo(0);
    e.stop();
  });

  it('帧时间戳窗口最多保留 60 帧（旧帧滑出后 fps 反映最近窗口）', () => {
    const e = new DynamicAdaptationEngine(weakProfile(), {
      initialLevel: PerformanceLevel.Level0,
      fpsSampleWindow: 1,
    });
    e.start();
    // 先 61 帧 60fps，再 1 帧间隔 1s：窗口 [1..61] 中最后一段很慢
    const ts = Array.from({ length: 61 }, (_, i) => (i * 1000) / 60);
    frames(ts);
    expect(e.getMetrics().fps).toBeCloseTo(60);
    frames([ts[60]! + 1000]);
    // 窗口保留最近 60 帧（第 3..62 帧）：58 个 1/60s 间隔 + 1 个 1s 间隔
    const elapsed = (58 * 1000) / 60 + 1000;
    expect(e.getMetrics().fps).toBeCloseTo(59 / (elapsed / 1000));
    e.stop();
  });
});

describe('内存与存储监测（定时器）', () => {
  it('每 5s 采样，空闲比例 <20% 触发 memory_pressure 降级', () => {
    stubPerformance({ usedJSHeapSize: 0.9 * GiB, jsHeapSizeLimit: 1 * GiB });
    const e = new DynamicAdaptationEngine(weakProfile(), {
      initialLevel: PerformanceLevel.Level1,
    });
    const events = collect(e);
    e.start();

    vi.advanceTimersByTime(4_999);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('memory_pressure');
    expect(events[0]!.metrics.heapUsed).toBe(0.9 * GiB);
    expect(events[0]!.metrics.memoryFreeRatio).toBeCloseTo(0.1);
    expect(e.level).toBe(PerformanceLevel.Level0);
    e.stop();
  });

  it('内存充足时不降级；stop 后定时器清除', () => {
    stubPerformance({ usedJSHeapSize: 0.5 * GiB, jsHeapSizeLimit: 1 * GiB });
    const e = new DynamicAdaptationEngine(weakProfile(), {
      initialLevel: PerformanceLevel.Level1,
    });
    const events = collect(e);
    e.start();
    vi.advanceTimersByTime(20_000);
    expect(events).toEqual([]);

    stubPerformance({ usedJSHeapSize: 0.99 * GiB, jsHeapSizeLimit: 1 * GiB });
    e.stop();
    vi.advanceTimersByTime(60_000);
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  function stubIdb(mode: 'ok' | 'error') {
    const deleteDatabase = vi.fn();
    const open = vi.fn(() => {
      const req: {
        result?: unknown;
        onupgradeneeded?: () => void;
        onsuccess?: () => void;
        onerror?: () => void;
      } = {};
      const tx: {
        oncomplete?: () => void;
        onerror?: () => void;
        objectStore: () => { put: () => void };
      } = {
        objectStore: () => ({
          put: () => void Promise.resolve().then(() => tx.oncomplete?.()),
        }),
      };
      req.result = {
        createObjectStore: vi.fn(),
        close: vi.fn(),
        transaction: () => tx,
      };
      void Promise.resolve().then(() => {
        if (mode === 'error') return req.onerror?.();
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    });
    vi.stubGlobal('indexedDB', { open, deleteDatabase });
    return { open, deleteDatabase };
  }

  it('SSD 写延迟均值 >5ms：profile 改判 HDD 并触发 storage_slowdown 降级', async () => {
    let t = 0;
    stubPerformance(undefined, () => (t += 10));
    const idb = stubIdb('ok');
    const profile = weakProfile({ storage: { type: 'ssd' } });
    const e = new DynamicAdaptationEngine(profile, {
      initialLevel: PerformanceLevel.Level1,
    });
    const events = collect(e);
    e.start();

    await vi.advanceTimersByTimeAsync(30_000);
    await flushMicrotasks();

    expect(idb.open).toHaveBeenCalledTimes(1);
    expect(idb.deleteDatabase).toHaveBeenCalledWith(
      expect.stringMatching(/^__crish_latency_\d+$/)
    );
    expect(profile.storage.type).toBe('hdd');
    expect(e.getMetrics().avgWriteLatencyMs).toBe(10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'storage_slowdown',
      metrics: { storageType: 'hdd', avgWriteLatencyMs: 10 },
      fromLevel: 1,
      toLevel: 0,
    });
    e.stop();
  });

  it('非 SSD 时只记录延迟不降级；IndexedDB 出错时忽略该次采样', async () => {
    let t = 0;
    stubPerformance(undefined, () => (t += 10));
    stubIdb('ok');
    const e = new DynamicAdaptationEngine(weakProfile(), {
      initialLevel: PerformanceLevel.Level1,
    });
    const events = collect(e);
    e.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await flushMicrotasks();
    expect(e.getMetrics().avgWriteLatencyMs).toBe(10);
    expect(events).toEqual([]);

    const failing = stubIdb('error');
    await vi.advanceTimersByTimeAsync(30_000);
    await flushMicrotasks();
    expect(failing.open).toHaveBeenCalledTimes(1);
    expect(failing.deleteDatabase).not.toHaveBeenCalled();
    expect(e.getMetrics().avgWriteLatencyMs).toBe(10);
    expect(events).toEqual([]);
    e.stop();
  });
});

describe('createAdaptationEngine', () => {
  it('创建后立即启动监测', () => {
    const e = createAdaptationEngine(weakProfile(), {
      initialLevel: PerformanceLevel.Level1,
    });
    expect(raf).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(2);
    e.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
