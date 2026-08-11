/**
 * HeightMap：回填改变滚动偏移估算
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_ESTIMATE_PX, HeightMap, STABLE_EPSILON } from './HeightMap';

describe('HeightMap', () => {
  it('初始全预估：offsetOf / totalHeight 为 prefix sum', () => {
    const hm = new HeightMap(5, 20);
    expect(hm.count).toBe(5);
    expect(hm.totalHeight()).toBe(100);
    expect(hm.offsetOf(0)).toBe(0);
    expect(hm.offsetOf(3)).toBe(60);
    expect(hm.offsetOf(5)).toBe(100);
  });

  it('实测回填改变后续 offset 估算', () => {
    const hm = new HeightMap(4, 10);
    // 块 0 实测 40（原 10）→ 总高 +30，块 2 的 offset 从 20 → 50
    expect(hm.offsetOf(2)).toBe(20);
    const changed = hm.measure(0, 40);
    expect(changed).toBe(true);
    expect(hm.get(0)).toEqual({ px: 40, estimated: false });
    expect(hm.offsetOf(1)).toBe(40);
    expect(hm.offsetOf(2)).toBe(50);
    expect(hm.totalHeight()).toBe(70); // 40+10+10+10
  });

  it('偏差 ≤ STABLE_EPSILON 不改高度，仅可落印 estimated', () => {
    const hm = new HeightMap(2, 30);
    expect(hm.measure(0, 30 + STABLE_EPSILON)).toBe(true); // 仍为估算 → 标实测
    expect(hm.get(0)?.px).toBe(30);
    expect(hm.get(0)?.estimated).toBe(false);
    // 再次同值：无变更
    expect(hm.measure(0, 30)).toBe(false);
  });

  it('indexAt 二分定位（非像素测距）', () => {
    const hm = new HeightMap(0);
    hm.resize(3, 100);
    // [0,100) → 0; [100,200) → 1; [200,300) → 2
    expect(hm.indexAt(0)).toBe(0);
    expect(hm.indexAt(99)).toBe(0);
    expect(hm.indexAt(100)).toBe(1);
    expect(hm.indexAt(250)).toBe(2);
    expect(hm.indexAt(9999)).toBe(2);
  });

  it('insert/remove 维护 prefix 与 totalHeight', () => {
    const hm = new HeightMap(3, 10);
    hm.insert(1, 2, 5); // [10, 5, 5, 10, 10]
    expect(hm.count).toBe(5);
    expect(hm.totalHeight()).toBe(40);
    hm.remove(1, 2);
    expect(hm.count).toBe(3);
    expect(hm.totalHeight()).toBe(30);
  });

  it('bindId / sliceHeights 输出 MountSpec 形切片', () => {
    const hm = new HeightMap(3, DEFAULT_ESTIMATE_PX);
    hm.bindId(0, 'a');
    hm.bindId(1, 'b');
    hm.measure(1, 50);
    const slice = hm.sliceHeights(0, 2);
    expect(slice).toEqual([
      { id: 'a', px: DEFAULT_ESTIMATE_PX, estimated: true },
      { id: 'b', px: 50, estimated: false },
    ]);
    expect(hm.indexOfId('b')).toBe(1);
  });

  it('measureBatch 批量回填只重算一次 prefix', () => {
    const hm = new HeightMap(5, 10);
    const n = hm.measureBatch([
      { index: 0, px: 20 },
      { index: 2, px: 30 },
      { index: 4, px: 40 },
    ]);
    expect(n).toBe(3);
    expect(hm.totalHeight()).toBe(20 + 10 + 30 + 10 + 40);
    expect(hm.offsetOf(3)).toBe(20 + 10 + 30);
  });
});
