/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPUTE_ADAPTATIONS,
  NETWORK_ADAPTATIONS,
  RENDER_ADAPTATIONS,
  STORAGE_ADAPTATIONS,
  applyRenderAdaptation,
  getFullAdaptation,
} from './platform-adaptation';
import { PerformanceLevel, TIER_CONFIGS } from './performance-tier';

const LEVELS = [
  PerformanceLevel.Level0,
  PerformanceLevel.Level1,
  PerformanceLevel.Level2,
  PerformanceLevel.Level3,
] as const;

describe('子系统配置与 TierConfig 的一致性（防两处数值漂移）', () => {
  it.each(LEVELS)('Level %i：计算/网络/存储参数与等级配置对齐', (level) => {
    const tier = TIER_CONFIGS[level];
    const compute = COMPUTE_ADAPTATIONS[level];
    const network = NETWORK_ADAPTATIONS[level];
    const storage = STORAGE_ADAPTATIONS[level];

    expect(compute.workerPool.maxSize).toBe(tier.maxWorkers);
    expect(compute.chunking.sizeBytes).toBe(tier.chunkSizeBytes);
    expect(compute.precompute.enabled).toBe(tier.precomputeEnabled);
    expect(compute.hashImpl === 'webgpu').toBe(tier.hashStrategy === 'webgpu');

    expect(network.maxConnections).toBe(tier.maxConcurrentRequests);
    expect(network.ws.heartbeatMs).toBe(tier.wsHeartbeatIntervalMs);
    expect(network.http2).toBe(tier.http2Multiplexing);

    expect(storage.fsync).toBe(tier.fsyncEnabled);
    expect(storage.dbSuffix).toBe(`_l${level}`);
  });

  it('等级越高资源越宽裕：DOM 上限、Worker、缓存条目单调递增，请求超时单调递减', () => {
    const series = (f: (l: PerformanceLevel) => number) => LEVELS.map(f);
    const increasing = (xs: number[]) =>
      xs.every((x, i) => i === 0 || x > xs[i - 1]!);
    const decreasing = (xs: number[]) =>
      xs.every((x, i) => i === 0 || x < xs[i - 1]!);

    expect(
      increasing(series((l) => RENDER_ADAPTATIONS[l].domStrategy.maxDomNodes))
    ).toBe(true);
    expect(
      increasing(series((l) => COMPUTE_ADAPTATIONS[l].workerPool.maxSize))
    ).toBe(true);
    expect(
      increasing(series((l) => STORAGE_ADAPTATIONS[l].cache.maxEntries))
    ).toBe(true);
    expect(
      decreasing(series((l) => NETWORK_ADAPTATIONS[l].requestTimeoutMs))
    ).toBe(true);
    // 性能目标越高档越严格
    expect(
      decreasing(
        series((l) => COMPUTE_ADAPTATIONS[l].performanceTargets.hash1mbMs)
      )
    ).toBe(true);
  });

  it('只有 Level 3 声明 GPU 加速增益', () => {
    expect(
      LEVELS.filter((l) => COMPUTE_ADAPTATIONS[l].gpuGains !== undefined)
    ).toEqual([3]);
  });

  it.each(LEVELS)(
    'Level %i 渲染 class：添加本级 perf-level-N、移除其余三级，add/remove 无交集',
    (level) => {
      const { add, remove } = RENDER_ADAPTATIONS[level].cssClasses;
      expect(add).toContain(`perf-level-${level}`);
      const others = LEVELS.filter((l) => l !== level).map(
        (l) => `perf-level-${l}`
      );
      expect(remove).toEqual(expect.arrayContaining(others));
      expect(add.filter((c) => remove.includes(c))).toEqual([]);
      expect(RENDER_ADAPTATIONS[level].metaTags).toEqual([
        { name: 'perf-level', content: String(level) },
      ]);
      // GPU 合成仅在 Level2+ 开启
      expect(add.includes('gpu-compositing')).toBe(level >= 2);
      expect(add.includes('gpu-compositing')).toBe(
        TIER_CONFIGS[level].gpuCompositing
      );
    }
  );

  it('getFullAdaptation 聚合同一等级的全部子系统配置', () => {
    for (const level of LEVELS) {
      const full = getFullAdaptation(level);
      expect(full.level).toBe(level);
      expect(full.config).toBe(TIER_CONFIGS[level]);
      expect(full.render).toBe(RENDER_ADAPTATIONS[level]);
      expect(full.compute).toBe(COMPUTE_ADAPTATIONS[level]);
      expect(full.network).toBe(NETWORK_ADAPTATIONS[level]);
      expect(full.storage).toBe(STORAGE_ADAPTATIONS[level]);
    }
  });
});

describe('applyRenderAdaptation（jsdom）', () => {
  const root = () => document.documentElement;

  afterEach(() => {
    root().className = '';
    root().removeAttribute('style');
    document.head.querySelectorAll('meta').forEach((m) => m.remove());
  });

  it('写入 CSS 变量、切换 class、创建 meta；清理后恢复原状', () => {
    root().className = 'app-root perf-level-1';
    const cleanup = applyRenderAdaptation(RENDER_ADAPTATIONS[3]);

    expect(root().style.getPropertyValue('--anim-duration')).toBe('250ms');
    expect(root().style.getPropertyValue('--overscan-px')).toBe('300px');
    expect(root().classList.contains('perf-level-3')).toBe(true);
    expect(root().classList.contains('gpu-accelerated')).toBe(true);
    expect(root().classList.contains('perf-level-1')).toBe(false);
    expect(root().classList.contains('app-root')).toBe(true);
    const meta = document.querySelector('meta[name="perf-level"]');
    expect(meta?.getAttribute('content')).toBe('3');

    cleanup();
    expect(root().className).toBe('app-root perf-level-1');
    expect(root().style.getPropertyValue('--anim-duration')).toBe('');
    expect(document.querySelector('meta[name="perf-level"]')).toBeNull();
  });

  it('已有同名 meta 时复用并改写；原有 CSS 变量在清理后恢复为旧值', () => {
    const existing = document.createElement('meta');
    existing.setAttribute('name', 'perf-level');
    existing.setAttribute('content', 'x');
    document.head.appendChild(existing);
    root().style.setProperty('--anim-duration', '999ms');

    const cleanup = applyRenderAdaptation(RENDER_ADAPTATIONS[0]);
    expect(document.querySelectorAll('meta[name="perf-level"]')).toHaveLength(
      1
    );
    expect(existing.getAttribute('content')).toBe('0');
    expect(root().style.getPropertyValue('--anim-duration')).toBe('0s');
    expect(root().classList.contains('reduce-motion')).toBe(true);

    cleanup();
    expect(root().style.getPropertyValue('--anim-duration')).toBe('999ms');
    expect(root().style.getPropertyValue('--overscan-px')).toBe('');
  });
});
