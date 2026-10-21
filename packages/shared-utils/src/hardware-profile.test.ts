/**
 * hardware-profile 行为测试。
 *
 * 被测模块只依赖浏览器宿主全局（navigator / window / document / performance /
 * indexedDB），这里用 vi.stubGlobal 构造不同宿主能力组合，验证每条探测的
 * 主路径与防御性回退；被测函数本身不做任何 mock。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectHardware } from './hardware-profile';

const realNow = performance.now.bind(performance);

type CanvasMode = {
  ctx2d?: boolean;
  webgl2?: boolean;
  webgl?: unknown;
  throws?: boolean;
};

function stubDocument(mode: CanvasMode) {
  vi.stubGlobal('document', {
    createElement: vi.fn(() => {
      if (mode.throws) throw new Error('no canvas');
      return {
        getContext: (kind: string) => {
          if (kind === '2d') return mode.ctx2d ? {} : null;
          if (kind === 'webgl2') return mode.webgl2 ? {} : null;
          if (kind === 'webgl') return mode.webgl ?? null;
          return null;
        },
      };
    }),
  });
}

/** 最小 IndexedDB 假实现：open → upgradeneeded → success → put → oncomplete */
function stubIndexedDb(
  opts: { delayMs?: number; fail?: 'open-throws' | 'open-error' } = {}
) {
  const deleteDatabase = vi.fn();
  const open = vi.fn((_name: string) => {
    if (opts.fail === 'open-throws') throw new Error('idb disabled');
    const req: {
      result?: unknown;
      onupgradeneeded?: () => void;
      onsuccess?: () => void;
      onerror?: () => void;
    } = {};
    const db = {
      createObjectStore: vi.fn(),
      close: vi.fn(),
      transaction: () => {
        const tx: {
          oncomplete?: () => void;
          objectStore: () => { put: () => void };
        } = {
          objectStore: () => ({
            put: () => {
              const done = () => tx.oncomplete?.();
              if (opts.delayMs) setTimeout(done, opts.delayMs);
              else queueMicrotask(done);
            },
          }),
        };
        return tx;
      },
    };
    req.result = db;
    queueMicrotask(() => {
      if (opts.fail === 'open-error') {
        req.onerror?.();
        return;
      }
      req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  });
  vi.stubGlobal('indexedDB', { open, deleteDatabase });
  return { open, deleteDatabase };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('detectHardware', () => {
  it('Tauri + Windows + WebGPU：合并同步与异步探测结果', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      hardwareConcurrency: 16,
      deviceMemory: 8,
      gpu: {
        requestAdapter: async () => ({
          info: {
            vendor: 'nvidia',
            architecture: 'ampere',
            description: 'RTX 3080',
          },
        }),
      },
      storage: { estimate: async () => ({ quota: 1_000_000_000 }) },
    });
    // requestIdleCallback 永不回调 → CPU 测速任务走超时兜底（不合入 speed）
    const ric = vi.fn();
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: {},
      requestIdleCallback: ric,
    });
    vi.stubGlobal('performance', {
      now: realNow,
      memory: { jsHeapSizeLimit: 4_000_000_000 },
    });
    stubDocument({ ctx2d: true, webgl2: true });
    const idb = stubIndexedDb();

    const p = await detectHardware({ timeout: 50 });

    expect(p.platform).toBe('windows');
    expect(p.isTauri).toBe(true);
    expect(p.cpu).toEqual({ cores: 16, model: 'RTX 3080' });
    expect(p.memory).toEqual({ total: 4_000_000_000, deviceMemory: 8 });
    expect(p.gpu).toEqual({
      available: true,
      webgpu: true,
      webgl: true,
      canvas2d: true,
      vendor: 'nvidia',
      renderer: 'ampere',
    });
    expect(p.storage).toEqual({ type: 'ssd', quota: 1_000_000_000 });
    expect(ric).toHaveBeenCalledWith(expect.any(Function), { timeout: 500 });
    // 基准库用完即删，名称带固定前缀
    expect(idb.open.mock.calls[0]![0]).toMatch(/^__crish_storage_bench_\d+$/);
    expect(idb.deleteDatabase).toHaveBeenCalledWith(idb.open.mock.calls[0]![0]);
  });

  it('macOS、无 WebGPU 适配器：WebGL1 debug 扩展兜底 vendor/renderer；skipStorageBench 不碰 IndexedDB', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
      hardwareConcurrency: 0,
      deviceMemory: 2,
      gpu: { requestAdapter: async () => null },
    });
    vi.stubGlobal('window', { requestIdleCallback: vi.fn() });
    vi.stubGlobal('performance', { now: realNow });
    const gl1 = {
      getExtension: (name: string) =>
        name === 'WEBGL_debug_renderer_info'
          ? { UNMASKED_VENDOR_WEBGL: 1, UNMASKED_RENDERER_WEBGL: 2 }
          : null,
      getParameter: (k: number) => (k === 1 ? 'Intel Inc.' : 'Intel Iris'),
    };
    stubDocument({ ctx2d: false, webgl2: false, webgl: gl1 });
    const idb = stubIndexedDb();

    const p = await detectHardware({ skipStorageBench: true, timeout: 30 });

    expect(p.platform).toBe('macos');
    expect(p.isTauri).toBe(false);
    // hardwareConcurrency=0 视为不可信 → 2 核
    expect(p.cpu.cores).toBe(2);
    expect(p.cpu.model).toBeUndefined();
    // 无 performance.memory → 按 deviceMemory GiB 估算
    expect(p.memory).toEqual({ total: 2 * 1024 ** 3, deviceMemory: 2 });
    expect(p.gpu).toEqual({
      available: true,
      webgpu: false,
      webgl: true,
      canvas2d: false,
      vendor: 'Intel Inc.',
      renderer: 'Intel Iris',
    });
    expect(p.storage).toEqual({ type: 'unknown' });
    expect(idb.open).not.toHaveBeenCalled();
  });

  it('Linux、各 API 全部抛错：每项回退到默认值，整体不抛', async () => {
    const nav = {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
      deviceMemory: 4,
      gpu: {
        requestAdapter: async () => Promise.reject(new Error('gpu lost')),
      },
      storage: { estimate: async () => Promise.reject(new Error('denied')) },
    };
    Object.defineProperty(nav, 'hardwareConcurrency', {
      get() {
        throw new Error('blocked');
      },
    });
    vi.stubGlobal('navigator', nav);
    vi.stubGlobal('window', { requestIdleCallback: vi.fn() });
    const perf = { now: realNow };
    Object.defineProperty(perf, 'memory', {
      get() {
        throw new Error('no memory api');
      },
    });
    vi.stubGlobal('performance', perf);
    stubDocument({ throws: true });
    stubIndexedDb({ fail: 'open-throws' });

    const p = await detectHardware({ timeout: 30 });

    expect(p.platform).toBe('linux');
    expect(p.cpu).toEqual({ cores: 2, model: undefined });
    // performance.memory 抛错 → catch 分支按 deviceMemory 估算
    expect(p.memory).toEqual({ total: 4 * 1024 ** 3, deviceMemory: 4 });
    expect(p.gpu).toEqual({
      available: false,
      webgpu: false,
      webgl: false,
      canvas2d: false,
      vendor: undefined,
      renderer: undefined,
    });
    expect(p.storage).toEqual({ type: 'unknown', quota: undefined });
  });

  it('无 deviceMemory 且无 performance.memory → 512MB 兜底；IndexedDB open 报错 → unknown', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'x11 linux',
      hardwareConcurrency: 4,
    });
    vi.stubGlobal('window', { requestIdleCallback: vi.fn() });
    vi.stubGlobal('performance', { now: realNow });
    stubDocument({ ctx2d: true });
    stubIndexedDb({ fail: 'open-error' });

    const p = await detectHardware({ timeout: 30 });

    expect(p.memory).toEqual({
      total: 512 * 1024 * 1024,
      deviceMemory: undefined,
    });
    expect(p.storage.type).toBe('unknown');
    // 只有 canvas2d 也算 GPU 能力可用
    expect(p.gpu.available).toBe(true);
    expect(p.gpu.canvas2d).toBe(true);
    expect(p.gpu.webgl).toBe(false);
  });

  it('IndexedDB 写入耗时 ≥2ms 判为 hdd；适配器无 description 时 CPU model 回落为 vendor', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'linux',
      hardwareConcurrency: 8,
      gpu: { requestAdapter: async () => ({ info: { vendor: 'amd' } }) },
    });
    vi.stubGlobal('window', { requestIdleCallback: vi.fn() });
    vi.stubGlobal('performance', { now: realNow });
    stubDocument({});
    stubIndexedDb({ delayMs: 15 });

    const p = await detectHardware({ timeout: 200 });

    expect(p.storage.type).toBe('hdd');
    expect(p.cpu.model).toBe('amd');
    expect(p.gpu.webgpu).toBe(true);
    expect(p.gpu.vendor).toBe('amd');
    // 没有 architecture，且 WebGL 不可用 → renderer 仍为空
    expect(p.gpu.renderer).toBeUndefined();
  });

  it('超时兜底：异步探测迟迟不返回时按 timeout 返回同步部分', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'win',
      hardwareConcurrency: 4,
      gpu: { requestAdapter: () => new Promise(() => {}) },
    });
    vi.stubGlobal('window', { requestIdleCallback: vi.fn() });
    vi.stubGlobal('performance', { now: realNow });
    stubDocument({});

    const t0 = Date.now();
    const p = await detectHardware({ skipStorageBench: true, timeout: 40 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(p.cpu).toEqual({ cores: 4 });
    expect(p.gpu).toEqual({
      available: false,
      webgpu: false,
      webgl: false,
      canvas2d: false,
    });
  });

  it('CPU 测速：requestIdleCallback 调度，结果夹在 [0.5, 6.0] GHz 且保留 1 位小数', async () => {
    vi.stubGlobal('navigator', { userAgent: 'linux', hardwareConcurrency: 2 });
    vi.stubGlobal('window', {
      requestIdleCallback: (cb: () => void) => setTimeout(cb, 0),
    });
    vi.stubGlobal('performance', { now: realNow });
    stubDocument({});

    const p = await detectHardware({ skipStorageBench: true, timeout: 2000 });
    const speed = p.cpu.speed!;
    expect(speed).toBeGreaterThanOrEqual(0.5);
    expect(speed).toBeLessThanOrEqual(6.0);
    expect(Math.round(speed * 10) / 10).toBe(speed);
  });

  it('CPU 测速：无 requestIdleCallback 时退化为 setTimeout 调度', async () => {
    vi.stubGlobal('navigator', { userAgent: 'linux', hardwareConcurrency: 2 });
    vi.stubGlobal('window', {});
    vi.stubGlobal('performance', { now: realNow });
    stubDocument({});

    const p = await detectHardware({ skipStorageBench: true, timeout: 2000 });
    expect(p.cpu.speed).toBeGreaterThanOrEqual(0.5);
  });

  it('CPU 测速内部异常 → 1.0 GHz 默认值', async () => {
    vi.stubGlobal('navigator', { userAgent: 'linux', hardwareConcurrency: 2 });
    vi.stubGlobal('window', {
      requestIdleCallback: (cb: () => void) => setTimeout(cb, 0),
    });
    // skipStorageBench 下只有测速循环会调用 performance.now，令其抛错
    vi.stubGlobal('performance', {
      now: () => {
        throw new Error('timer unavailable');
      },
    });
    stubDocument({});

    const p = await detectHardware({ skipStorageBench: true, timeout: 2000 });
    expect(p.cpu.speed).toBe(1.0);
  });
});
