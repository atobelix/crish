import { describe, expect, it } from 'vitest';
import type { HardwareProfile } from './hardware-profile';
import {
  assignTier,
  PerformanceLevel,
  shouldDowngrade,
  shouldUpgrade,
  TIER_CONFIGS,
} from './performance-tier';

const GB = 1024 * 1024 * 1024;

function profile(p: {
  cores?: number;
  memGB?: number;
  webgpu?: boolean;
  webgl?: boolean;
  canvas2d?: boolean;
  vendor?: string;
  storage?: 'ssd' | 'hdd' | 'unknown';
}): HardwareProfile {
  return {
    cpu: { cores: p.cores ?? 4 },
    memory: { total: (p.memGB ?? 4) * GB, deviceMemory: undefined },
    gpu: {
      available: !!(p.webgpu || p.webgl || p.canvas2d),
      webgpu: p.webgpu ?? false,
      webgl: p.webgl ?? false,
      canvas2d: p.canvas2d ?? false,
      vendor: p.vendor,
    },
    storage: { type: p.storage ?? 'unknown' },
    platform: 'linux',
    isTauri: false,
  };
}

describe('assignTier 评分与等级映射', () => {
  it('最低配（1 核、1GB、无 GPU、HDD）→ Level0，原因逐项列出', () => {
    const r = assignTier(profile({ cores: 1, memGB: 1, storage: 'hdd' }));
    expect(r.level).toBe(PerformanceLevel.Level0);
    expect(r.config).toBe(TIER_CONFIGS[PerformanceLevel.Level0]);
    expect(r.reasons).toEqual([
      'CPU 1核 <2 → +0',
      '内存 1.0GB <2 → +0',
      '无GPU → +0',
      '总分 0 → Level 0',
    ]);
  });

  it('高配（16 核、32GB、WebGPU、NVIDIA、SSD）→ Level3，含厂商与 SSD 加分', () => {
    const r = assignTier(
      profile({
        cores: 16,
        memGB: 32,
        webgpu: true,
        vendor: 'NVIDIA',
        storage: 'ssd',
      })
    );
    expect(r.level).toBe(PerformanceLevel.Level3);
    expect(r.reasons).toContain('NVIDIA 中高端GPU → +10');
    expect(r.reasons).toContain('SSD → +5');
    expect(r.reasons.at(-1)).toBe('总分 115 → Level 3');
  });

  it('厂商加分仅在 WebGPU 可用时生效', () => {
    const r = assignTier(
      profile({ cores: 8, memGB: 8, webgl: true, vendor: 'AMD' })
    );
    expect(r.reasons.some((x) => x.includes('中高端GPU'))).toBe(false);
    expect(r.reasons.at(-1)).toBe('总分 90 → Level 3');
  });

  it('分数边界：19→L0, 20→L1, 54→L1, 55→L2, 89→L2, 90→L3', () => {
    // 2核(+10) + 2GB(+10) = 20
    expect(assignTier(profile({ cores: 2, memGB: 2 })).level).toBe(
      PerformanceLevel.Level1
    );
    // 2核(+10) + 1GB(0) + canvas(+5) = 15
    expect(
      assignTier(profile({ cores: 2, memGB: 1, canvas2d: true })).level
    ).toBe(PerformanceLevel.Level0);
    // 4核(+25) + 4GB(+25) = 50；+ SSD = 55
    expect(assignTier(profile({ cores: 4, memGB: 4 })).level).toBe(
      PerformanceLevel.Level1
    );
    expect(
      assignTier(profile({ cores: 4, memGB: 4, storage: 'ssd' })).level
    ).toBe(PerformanceLevel.Level2);
    // 8核(+40) + 4GB(+25) + webgpu(+20) = 85 → L2；+ ssd = 90 → L3
    expect(
      assignTier(profile({ cores: 8, memGB: 4, webgpu: true })).level
    ).toBe(PerformanceLevel.Level2);
    expect(
      assignTier(profile({ cores: 8, memGB: 4, webgpu: true, storage: 'ssd' }))
        .level
    ).toBe(PerformanceLevel.Level3);
  });

  it('GPU 档位优先级 webgpu > webgl > canvas2d', () => {
    expect(
      assignTier(profile({ webgpu: true, webgl: true, canvas2d: true })).reasons
    ).toContain('WebGPU可用 → +20');
    expect(
      assignTier(profile({ webgl: true, canvas2d: true })).reasons
    ).toContain('WebGL可用 → +10');
    expect(assignTier(profile({ canvas2d: true })).reasons).toContain(
      'Canvas 2D可用 → +5'
    );
  });

  it('vendor 缺省不抛异常且不加分；大小写不敏感（apple）', () => {
    expect(
      assignTier(profile({ webgpu: true })).reasons.some((x) =>
        x.includes('中高端')
      )
    ).toBe(false);
    expect(
      assignTier(profile({ webgpu: true, vendor: 'Apple' })).reasons
    ).toContain('Apple 中高端GPU → +10');
  });
});

describe('TIER_CONFIGS 单调性（等级越高资源越多）', () => {
  const levels = [0, 1, 2, 3] as const;
  it('level 字段与键一致', () => {
    for (const l of levels) expect(TIER_CONFIGS[l].level).toBe(l);
  });
  it.each([
    'maxWorkers',
    'maxConcurrentRequests',
    'maxConcurrentFileOps',
    'virtualScrollOverscanPx',
    'cacheBudgetPercent',
    'maxCacheItemSize',
    'chunkSizeBytes',
  ] as const)('%s 严格递增', (key) => {
    for (let i = 1; i < levels.length; i++) {
      expect(TIER_CONFIGS[levels[i]!][key]).toBeGreaterThan(
        TIER_CONFIGS[levels[i - 1]!][key]
      );
    }
  });
  it('只有 Level3 启用 WebGPU 计算与 GPU 哈希', () => {
    expect(levels.filter((l) => TIER_CONFIGS[l].webgpuCompute)).toEqual([3]);
    expect(
      levels.filter((l) => TIER_CONFIGS[l].hashStrategy === 'webgpu')
    ).toEqual([3]);
  });
});

describe('shouldDowngrade / shouldUpgrade（滞回带防乒乓）', () => {
  it('分数低于本级阈值 60% 才降一级', () => {
    // Level2 阈值 55 → 降级线 33
    expect(shouldDowngrade(PerformanceLevel.Level2, 32.9)).toBe(
      PerformanceLevel.Level1
    );
    expect(shouldDowngrade(PerformanceLevel.Level2, 33)).toBeNull();
    // Level3 阈值 90 → 54
    expect(shouldDowngrade(PerformanceLevel.Level3, 53)).toBe(
      PerformanceLevel.Level2
    );
    expect(shouldDowngrade(PerformanceLevel.Level1, 11)).toBe(
      PerformanceLevel.Level0
    );
    expect(shouldDowngrade(PerformanceLevel.Level1, 12)).toBeNull();
  });

  it('Level0 非负分不降级', () => {
    expect(shouldDowngrade(PerformanceLevel.Level0, 0)).toBeNull();
  });

  it('分数达到下一级阈值 120% 才升一级；Level3 不再升级', () => {
    // Level1 → Level2 需 ≥ 66
    expect(shouldUpgrade(PerformanceLevel.Level1, 65.9)).toBeNull();
    expect(shouldUpgrade(PerformanceLevel.Level1, 66)).toBe(
      PerformanceLevel.Level2
    );
    expect(shouldUpgrade(PerformanceLevel.Level0, 24)).toBe(
      PerformanceLevel.Level1
    );
    expect(shouldUpgrade(PerformanceLevel.Level2, 107)).toBeNull();
    expect(shouldUpgrade(PerformanceLevel.Level2, 108)).toBe(
      PerformanceLevel.Level3
    );
    expect(shouldUpgrade(PerformanceLevel.Level3, 1000)).toBeNull();
  });

  it('升降级阈值之间存在滞回带：同一分数不会既升又降', () => {
    for (const l of [0, 1, 2, 3] as const) {
      for (let s = 0; s <= 130; s++) {
        expect(
          shouldUpgrade(l, s) !== null && shouldDowngrade(l, s) !== null
        ).toBe(false);
      }
    }
  });
});
