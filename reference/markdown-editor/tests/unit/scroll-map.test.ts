import { describe, it, expect } from 'vitest';
import { ScrollMap, SCROLL_PHYSICAL_CAP, SCROLL_MAP_THRESHOLD } from '../../src/core/scrollMap';

describe('ScrollMap 分段映射', () => {
  it('恒等短路：总高 ≤ 阈值时零开销直通', () => {
    const sm = new ScrollMap(() => 1_000_000, () => 800);
    expect(sm.enabled).toBe(false);
    expect(sm.apply(12345)).toBe(12345);
    expect(sm.inverse(12345)).toBe(12345);
    expect(sm.physicalTotalHeight()).toBe(1_000_000);
  });

  it('启用：总高超过阈值时映射生效', () => {
    const sm = new ScrollMap(() => 60_000_000, () => 800);
    expect(sm.enabled).toBe(true);
  });

  it('端点对齐：f(0)=0、f⁻¹(f(x))=x（恒等区内）', () => {
    const sm = new ScrollMap(() => 60_000_000, () => 800);
    expect(sm.apply(0)).toBe(0);
    // 恒等区内（视口顶附近 + 文末保留区之前）
    for (const x of [0, 10, 800, 5000, 1_000_000]) {
      expect(sm.apply(x)).toBeCloseTo(x, 0);
    }
    // 逆映射一致性（压缩区）
    for (const p of [0, 10_000_000, 25_000_000, SCROLL_PHYSICAL_CAP]) {
      const logical = sm.inverse(p);
      const back = sm.apply(logical);
      expect(Math.abs(back - p)).toBeLessThan(2); // 物理往返近似一致
    }
  });

  it('文末钳制（评审高危②）：拖到底 = 逻辑文末，无空白', () => {
    const sm = new ScrollMap(() => 60_000_000, () => 800);
    // 逻辑文末（60M 附近）应压缩到物理上限附近——滚动条拖到底显示文末
    const phys = sm.apply(60_000_000);
    expect(phys).toBeLessThanOrEqual(SCROLL_PHYSICAL_CAP);
    expect(phys).toBeGreaterThan(SCROLL_PHYSICAL_CAP - 2);
    // 物理上限 → 逆映射回逻辑文末
    const logicalEnd = sm.inverse(SCROLL_PHYSICAL_CAP);
    expect(logicalEnd).toBeGreaterThanOrEqual(60_000_000 - 1);
    expect(logicalEnd).toBeLessThanOrEqual(60_000_000);
    // 恒等区终点在物理保留余量内（1:1 区安全）
    expect(sm.apply(SCROLL_PHYSICAL_CAP - 1_000_000)).toBe(SCROLL_PHYSICAL_CAP - 1_000_000);
  });

  it('物理总高：压缩后不超过物理上限', () => {
    const sm = new ScrollMap(() => 60_000_000, () => 800);
    const phys = sm.physicalTotalHeight();
    expect(phys).toBeLessThanOrEqual(SCROLL_PHYSICAL_CAP);
    expect(phys).toBeGreaterThan(0);
    // 未启用时物理=逻辑
    const sm2 = new ScrollMap(() => 1_000_000, () => 800);
    expect(sm2.physicalTotalHeight()).toBe(1_000_000);
  });

  it('f/f⁻¹ 单调性：逻辑与物理均单调不减', () => {
    const sm = new ScrollMap(() => 60_000_000, () => 800);
    let prev = -1;
    for (let x = 0; x <= 60_000_000; x += 500_000) {
      const p = sm.apply(x);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});
