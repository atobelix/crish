import { initPerformanceAttributes } from './api/performanceEngine';

/**
 * bootstrap-core — 冷启残余最小初始化（ACT-302 净化后）。
 *
 * Stage 3 改造要点：
 * - 彻底切除冷启 Worker 池创建：FCP 前 Worker = 0，JIT 由既有 WorkerPool 承载；
 * - 彻底切除 store 最小配置虚设模块（已物理删除）；
 * - OAuth 调度器移交 bootstrap-full 闲时阶段。
 * 现仅保留：性能属性 + 硬件检测 / 轻量模式（失败不阻塞渲染）。
 * 由 entry-core 的 idle 交接调用，不在首帧关键路径。
 */
let coreReady = false;
export function isCoreReady(): boolean { return coreReady; }

export async function bootstrapCore(): Promise<void> {
  const start = performance.now();

  // 性能分层属性同步写入
  initPerformanceAttributes();

  await Promise.all([
    // 硬件检测 + 轻量模式配置（不阻塞渲染；纯同步读 navigator，仍经
    // async 边界以保持既有调用面契约）
    (async () => {
      const { detectPlatform } = await import('./api/platformDetect');
      await detectPlatform();
      const { applyLightweightConfig } = await import('./api/lightweightMode');
      applyLightweightConfig();
    })(),
  ]);

  coreReady = true;
  window.__crish_coreReady = true;
  window.__crish_perf = { ...window.__crish_perf, coreReady: performance.now() };
  void import('./services/startup/startupMetrics').then((m) =>
    m.markStartupPhase('coreReady')
  );
  console.debug(`[perf] bootstrapCore: ${performance.now() - start}ms`);
}
