/**
 * A) 硬件检测引擎
 *
 * 启动时异步检测所有硬件参数，不阻塞主线程。
 * 每条检测都有防御性回退路径：当 API 不可用 / 抛异常时返回合理默认值。
 */

export interface HardwareProfile {
  cpu: {
    cores: number;
    model?: string;
    speed?: number;
  };
  memory: {
    total: number;
    deviceMemory?: number;
  };
  gpu: {
    available: boolean;
    webgpu: boolean;
    webgl: boolean;
    canvas2d: boolean;
    vendor?: string;
    renderer?: string;
  };
  storage: {
    type: 'ssd' | 'hdd' | 'unknown';
    quota?: number;
  };
  platform: 'windows' | 'macos' | 'linux';
  isTauri: boolean;
}

export interface HardwareProfileInit {
  /** 跳过 storage 基准测试，使用 'unknown' 以加速启动 */
  skipStorageBench?: boolean;
  /** 超时时间 ms（默认 3000） */
  timeout?: number;
}

function detectPlatform(): 'windows' | 'macos' | 'linux' {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  return 'linux';
}

function detectIsTauri(): boolean {
  return !!(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

function detectCpuCores(): number {
  try {
    const c = navigator.hardwareConcurrency;
    return c > 0 ? c : 2;
  } catch {
    return 2;
  }
}

async function detectCpuModel(): Promise<string | undefined> {
  try {
    const nav = navigator as unknown as Record<string, unknown>;
    if (nav['gpu'] && typeof (nav['gpu'] as Record<string, unknown>)['requestAdapter'] === 'function') {
      const gpu = nav['gpu'] as { requestAdapter: () => Promise<unknown> };
      const adapter = await gpu.requestAdapter() as Record<string, unknown> | null;
      if (adapter) {
        const info = adapter['info'] as Record<string, unknown> | undefined;
        return (info?.['description'] as string) || (info?.['vendor'] as string) || undefined;
      }
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

async function detectGpu(): Promise<HardwareProfile['gpu']> {
  const canvas2d = (() => {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('2d'));
    } catch {
      return false;
    }
  })();

  const webgl = (() => {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') as WebGL2RenderingContext | null;
      if (gl) return true;
      const gl1 = c.getContext('webgl') as WebGLRenderingContext | null;
      return !!gl1;
    } catch {
      return false;
    }
  })();

  // WebGPU detection
  let webgpu = false;
  let vendor: string | undefined;
  let renderer: string | undefined;

  try {
    const nav = navigator as unknown as Record<string, unknown>;
    if (nav['gpu'] && typeof (nav['gpu'] as Record<string, unknown>)['requestAdapter'] === 'function') {
      const gpu = nav['gpu'] as { requestAdapter: () => Promise<unknown> };
      const adapter = await gpu.requestAdapter() as Record<string, unknown> | null;
      if (adapter) {
        webgpu = true;
        const info = adapter['info'] as Record<string, unknown> | undefined;
        vendor = (info?.['vendor'] as string) || undefined;
        renderer = (info?.['architecture'] as string) || undefined;
      }
    }
  } catch {
    /* WebGPU not available */
  }

  // Fallback: try to get GPU from WebGL debug info
  if (!vendor || !renderer) {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') as WebGLRenderingContext | null;
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) {
          const v = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) as string;
          const r = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
          if (!vendor) vendor = v || undefined;
          if (!renderer) renderer = r || undefined;
        }
      }
    } catch {
      /* ignored */
    }
  }

  const available = webgpu || webgl || canvas2d;

  return { available, webgpu, webgl, canvas2d, vendor, renderer };
}

function detectMemory(): HardwareProfile['memory'] {
  let deviceMemory: number | undefined;
  let total = 512 * 1024 * 1024; // fallback 512MB

  try {
    if ('deviceMemory' in navigator) {
      deviceMemory = (navigator as Navigator & { deviceMemory: number }).deviceMemory;
    }
  } catch {
    /* not available */
  }

  try {
    const mem = (performance as unknown as Record<string, unknown>)['memory'] as
      | { jsHeapSizeLimit: number }
      | undefined;
    if (mem?.jsHeapSizeLimit) {
      total = mem.jsHeapSizeLimit;
    } else if (deviceMemory) {
      total = deviceMemory * 1024 * 1024 * 1024;
    }
  } catch {
    /* fallback to deviceMemory */
    if (deviceMemory) {
      total = deviceMemory * 1024 * 1024 * 1024;
    }
  }

  return { total, deviceMemory };
}

/**
 * SSD/HDD 探测：通过写入少量数据并测量耗时来估算。
 * 写入 1KB 随机数据，如果延迟 < 2ms 判断为 SSD。
 */
async function detectStorageType(): Promise<'ssd' | 'hdd' | 'unknown'> {
  try {
    // Use the StorageManager API as a heuristic
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      // Already a good sign — modern browser, likely SSD on any modern device
    }
  } catch {
    /* ignore */
  }

  // Attempt benchmark via IndexedDB write + read latency
  try {
    const dbName = '__crish_storage_bench_' + Date.now();
    const blob = new Blob([crypto.getRandomValues(new Uint8Array(1024))]);
    const t0 = performance.now();

    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('bench');
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('bench', 'readwrite');
        const store = tx.objectStore('bench');
        store.put(blob, 'data');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject();
      };
      req.onerror = () => reject();
    });

    const t1 = performance.now();
    const elapsed = t1 - t0;

    // Cleanup
    indexedDB.deleteDatabase(dbName);

    // < 2ms for 1KB random write → SSD
    return elapsed < 2 ? 'ssd' : 'hdd';
  } catch {
    return 'unknown';
  }
}

async function detectStorageQuota(): Promise<number | undefined> {
  try {
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      const est = await navigator.storage.estimate();
      return est.quota ?? undefined;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * 硬件基准测试（CPU 速度估算）：
 * 执行少量计算密集操作，通过耗时估算 CPU 相对速度。
 * 完全不阻塞 UI — 使用 requestIdleCallback 调度。
 */
function benchmarkCpuSpeed(): Promise<number> {
  return new Promise((resolve) => {
    const run = () => {
      try {
        const samples = 3;
        let totalOps = 0;
        for (let s = 0; s < samples; s++) {
          const t0 = performance.now();
          let count = 0;
          while (performance.now() - t0 < 10) {
            // SHA256-like mix: register pressure, bit ops
            let h = 0xdeadbeef ^ count;
            for (let i = 0; i < 64; i++) {
              h = ((h << 5) - h + (i * 0x9e3779b9)) | 0;
              h ^= (h >>> 16);
            }
            count++;
          }
          totalOps += count;
        }
        const avgOps = totalOps / samples;
        // Convert ops/10ms to estimated GHz (rough: 1e7 ops/sec ≈ 1GHz single-core)
        const ghz = Math.round((avgOps * 100 / 1e7) * 10) / 10;
        resolve(Math.max(0.5, Math.min(ghz, 6.0)));
      } catch {
        resolve(1.0);
      }
    };

    if ('requestIdleCallback' in window) {
      (window as Window & { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(run, { timeout: 500 });
    } else {
      setTimeout(run, 50);
    }
  });
}

/**
 * 执行完整的硬件检测，返回 HardwareProfile。
 * 所有检测并行运行，以 Promise.all 等待全部完成。
 */
export async function detectHardware(opts?: HardwareProfileInit): Promise<HardwareProfile> {
  const { skipStorageBench = false, timeout = 3000 } = opts ?? {};

  const platform = detectPlatform();
  const isTauri = detectIsTauri();
  const cpuCores = detectCpuCores();
  const memory = detectMemory();

  // 启动时立即返回同步可查的部分，异步检测完成后通过回调/事件系统补充
  const immediate: HardwareProfile = {
    cpu: { cores: cpuCores },
    memory,
    gpu: { available: false, webgpu: false, webgl: false, canvas2d: false },
    storage: { type: 'unknown' },
    platform,
    isTauri,
  };

  // 如果调用方只需要同步结果，可以提前返回初始值
  // 但这里我们使用 Promise.race 确保不超时

  const asyncTasks: Promise<Partial<HardwareProfile>>[] = [
    detectGpu().then((gpu) => ({ gpu }) as Partial<HardwareProfile>),
    benchmarkCpuSpeed().then((speed) => ({ cpu: { cores: cpuCores, speed } }) as Partial<HardwareProfile>),
    detectCpuModel().then((model) => {
      // merge into existing cpu info
      return { cpu: { cores: cpuCores, model } } as Partial<HardwareProfile>;
    }),
  ];

  if (!skipStorageBench) {
    asyncTasks.push(
      Promise.all([
        detectStorageType(),
        detectStorageQuota(),
      ]).then(([type, quota]) => ({ storage: { type, quota } }) as Partial<HardwareProfile>),
    );
  }

  // Enforce timeout on all async detection
  const combined = Promise.all(
    asyncTasks.map((p) =>
      Promise.race([
        p,
        new Promise<Partial<HardwareProfile>>((resolve) =>
          setTimeout(() => resolve({}), timeout),
        ),
      ]),
    ),
  );

  const results = await combined;

  // Merge results: start with immediate sync values, overlay async results
  for (const r of results) {
    if (r.gpu) immediate.gpu = { ...immediate.gpu, ...r.gpu };
    if (r.cpu) immediate.cpu = { ...immediate.cpu, ...r.cpu };
    if (r.storage) immediate.storage = { ...immediate.storage, ...r.storage };
  }

  return immediate;
}

export type HardwareProfileChangeListener = (profile: HardwareProfile) => void;
