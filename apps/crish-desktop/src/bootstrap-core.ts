let coreReady = false;
export function isCoreReady(): boolean { return coreReady; }

export async function bootstrapCore(): Promise<void> {
  const start = performance.now();

  await Promise.all([
    // 1. 硬件检测 + 轻量模式配置（不阻塞渲染）
    (async () => {
      const { detectPlatform } = await import('./api/platformDetect');
      await detectPlatform();
      const { applyLightweightConfig } = await import('./api/lightweightMode');
      applyLightweightConfig();
    })(),

    // 2. Worker 池初始化（最小：只创建 2 个核心 Worker）
    (async () => {
      const { initMinimalPool } = await import('./workers/index');
      initMinimalPool();
    })(),

    // 3. 最小配置读取 (只读必要的 localStorage key)
    (async () => {
      const { loadMinimalConfig } = await import('./store/minimalConfig');
      await loadMinimalConfig();
    })(),
  ]);

  coreReady = true;
  window.__crish_coreReady = true;
  window.__crish_perf = { ...window.__crish_perf, coreReady: performance.now() };
  console.debug(`[perf] bootstrapCore: ${performance.now() - start}ms`);
}
