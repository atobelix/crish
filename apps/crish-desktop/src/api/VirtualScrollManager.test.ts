import { describe, it, expect } from 'vitest';
import { VirtualScrollManager } from './VirtualScrollManager';

function ids(n: number, prefix = 'm'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

describe('VirtualScrollManager (messageId + suffix rebuild)', () => {
  it('stores height by messageId and exposes index views via syncOrder', () => {
    const vsm = new VirtualScrollManager(100);
    vsm.syncOrder(['a', 'b', 'c']);
    vsm.setActual('a', 50);
    vsm.setActual('b', 80);
    vsm.setEstimated('c', 120);

    expect(vsm.getHeight('a')).toBe(50);
    expect(vsm.getHeightAt(0)).toBe(50);
    expect(vsm.getHeightAt(1)).toBe(80);
    expect(vsm.getHeightAt(2)).toBe(120);
    expect(vsm.getOffset(0)).toBe(0);
    expect(vsm.getOffset(1)).toBe(50);
    expect(vsm.getOffset(2)).toBe(130);
    expect(vsm.getTotalHeight(3)).toBe(250);
  });

  it('retains same-id height after index shift (window pan remap)', () => {
    const vsm = new VirtualScrollManager(100);
    // Window shows m2,m3,m4
    vsm.syncOrder(['m2', 'm3', 'm4']);
    vsm.setActual('m2', 200);
    vsm.setActual('m3', 300);
    vsm.setActual('m4', 400);

    expect(vsm.getHeightAt(0)).toBe(200);
    expect(vsm.getOffset(1)).toBe(200);

    // Window pans earlier: m0,m1,m2,m3,m4 — m2/m3/m4 keep heights
    vsm.syncOrder(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(vsm.getHeight('m2')).toBe(200);
    expect(vsm.getHeight('m3')).toBe(300);
    expect(vsm.getHeight('m4')).toBe(400);
    // m0/m1 fall back until measured
    expect(vsm.getHeightAt(0)).toBe(100);
    expect(vsm.getHeightAt(2)).toBe(200);
    expect(vsm.getOffset(3)).toBe(100 + 100 + 200);
    expect(vsm.getTotalHeight(5)).toBe(100 + 100 + 200 + 300 + 400);
  });

  /**
   * 契约：窗口平移 / expand older 只 syncOrder，禁止 clear。
   * 多次 pan 后同 id 高度与 hasHeight 仍保留。
   */
  it('window pan without clear keeps heights across multiple expand-older steps', () => {
    const vsm = new VirtualScrollManager(100);
    vsm.syncOrder(['m5', 'm6', 'm7']);
    vsm.setActual('m5', 111);
    vsm.setActual('m6', 222);
    vsm.setActual('m7', 333);

    // expand older step 1: prepend m3,m4
    vsm.syncOrder(['m3', 'm4', 'm5', 'm6', 'm7']);
    expect(vsm.hasHeight('m5')).toBe(true);
    expect(vsm.hasHeight('m6')).toBe(true);
    expect(vsm.hasHeight('m7')).toBe(true);
    expect(vsm.getHeight('m5')).toBe(111);
    expect(vsm.getHeight('m6')).toBe(222);
    expect(vsm.getHeight('m7')).toBe(333);
    expect(vsm.getHeightAt(2)).toBe(111);
    expect(vsm.getOffset(2)).toBe(100 + 100); // m3,m4 fallback
    expect(vsm.getTotalHeight(5)).toBe(100 + 100 + 111 + 222 + 333);

    // expand older step 2: prepend m0,m1,m2 — still no clear
    vsm.syncOrder(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    expect(vsm.getHeight('m5')).toBe(111);
    expect(vsm.getHeight('m6')).toBe(222);
    expect(vsm.getHeight('m7')).toBe(333);
    expect(vsm.getHeightAt(5)).toBe(111);
    expect(vsm.getOffset(5)).toBe(100 * 5);
    expect(vsm.getTotalHeight(8)).toBe(100 * 5 + 111 + 222 + 333);

    // clear 仅用于会话切换语义
    vsm.clear();
    expect(vsm.hasHeight('m5')).toBe(false);
    expect(vsm.getHeight('m5')).toBe(100);
    expect(vsm.getOrder()).toEqual([]);
  });

  it('suffix rebuild: changing index 0 height updates offset(n) correctly', () => {
    const vsm = new VirtualScrollManager(100);
    const order = ids(5);
    vsm.syncOrder(order);
    for (const id of order) vsm.setActual(id, 100);

    expect(vsm.getOffset(4)).toBe(400);
    expect(vsm.getTotalHeight(5)).toBe(500);

    // Change first item only
    vsm.setActual('m0', 250);
    expect(vsm.getOffset(0)).toBe(0);
    expect(vsm.getOffset(1)).toBe(250);
    expect(vsm.getOffset(2)).toBe(350);
    expect(vsm.getOffset(4)).toBe(550);
    expect(vsm.getTotalHeight(5)).toBe(650);
  });

  it('suffix rebuild from middle index without full clear', () => {
    const vsm = new VirtualScrollManager(100);
    const order = ids(6);
    vsm.syncOrder(order);
    for (const id of order) vsm.setActual(id, 100);

    // Warm offsets
    expect(vsm.getOffset(5)).toBe(500);

    // Change middle item (index 2)
    vsm.setActual('m2', 180);
    // Prefix offsets before changed item stay consistent
    expect(vsm.getOffset(0)).toBe(0);
    expect(vsm.getOffset(1)).toBe(100);
    expect(vsm.getOffset(2)).toBe(200); // sum of m0+m1 still 200
    // Suffix from index 3 onward reflects new height
    expect(vsm.getOffset(3)).toBe(380); // 200 + 180
    expect(vsm.getOffset(5)).toBe(580);
    expect(vsm.getTotalHeight(6)).toBe(680);
  });

  it('does not drop offsetsCache on height change (suffix semantics)', () => {
    const vsm = new VirtualScrollManager(100);
    vsm.syncOrder(ids(4));
    for (const id of ids(4)) vsm.setActual(id, 100);
    const before = vsm.getOffset(3);
    expect(before).toBe(300);

    // Mid change
    vsm.setActual('m1', 150);
    expect(vsm.getOffset(1)).toBe(100); // prefix intact
    expect(vsm.getOffset(2)).toBe(250);
    expect(vsm.getOffset(3)).toBe(350);
  });

  it('setEstimated does not override actual', () => {
    const vsm = new VirtualScrollManager();
    vsm.syncOrder(['x']);
    vsm.setActual('x', 222);
    vsm.setEstimated('x', 50);
    expect(vsm.getHeight('x')).toBe(222);
  });

  it('invalidateActual resets actual and estimated so height truly recomputes', () => {
    const vsm = new VirtualScrollManager(100);
    vsm.syncOrder(['a', 'b', 'c']);
    vsm.setActual('a', 40);
    vsm.setActual('b', 60);
    vsm.setActual('c', 80);
    vsm.invalidateActual('b');
    // setActual 曾把 estimated 同步为 60；invalidate 必须一并重置，否则 getHeight 仍回落旧值
    expect(vsm.getHeight('b')).toBe(100); // fallback
    expect(vsm.getOffset(2)).toBe(40 + 100);
    vsm.setEstimated('b', 70); // actual null，允许新的 estimated
    expect(vsm.getHeight('b')).toBe(70);
    expect(vsm.getOffset(2)).toBe(40 + 70);
  });

  it('clear wipes heights; used on session switch', () => {
    const vsm = new VirtualScrollManager();
    vsm.syncOrder(['a', 'b']);
    vsm.setActual('a', 10);
    vsm.clear();
    expect(vsm.getHeight('a')).toBe(120);
    expect(vsm.getOrder()).toEqual([]);
    expect(vsm.getTotalHeight(0)).toBe(0);
  });

  it('defends against NaN / negative / empty id', () => {
    const vsm = new VirtualScrollManager(90);
    vsm.syncOrder(['a', 'b']);
    vsm.setActual('a', NaN);
    vsm.setActual('b', -20);
    vsm.setEstimated('', 999);
    expect(vsm.getHeight('a')).toBe(90);
    expect(vsm.getHeight('b')).toBe(90);
    expect(vsm.getOffset(1)).toBe(90);
    expect(() => vsm.computeVisibleRange(NaN, Infinity, 2, -1)).not.toThrow();
  });

  it('computeVisibleRange uses per-id heights', () => {
    const vsm = new VirtualScrollManager(100);
    vsm.syncOrder(ids(10));
    for (const id of ids(10)) vsm.setActual(id, 100);
    const range = vsm.computeVisibleRange(250, 200, 10, 1);
    expect(range.startIndex).toBeLessThanOrEqual(2);
    expect(range.endIndex).toBeGreaterThan(range.startIndex);
    expect(range.estimatedTotalHeight).toBe(1000);
  });

  describe('Round 2 guards', () => {
    it('空状态 clear 应跳过', () => {
      const vsm = new VirtualScrollManager(100);
      vsm.clear();
      expect(vsm.getOrder()).toEqual([]);
      expect(vsm.getGeneration()).toBe(0);
    });

    it('双重 clear 应安全', () => {
      const vsm = new VirtualScrollManager(100);
      vsm.syncOrder(['a']);
      vsm.clear();
      const gen = vsm.getGeneration();
      vsm.clear();
      expect(vsm.getGeneration()).toBe(gen);
    });

    it('clear 后快速 syncOrder 应正常重建', () => {
      const vsm = new VirtualScrollManager(100);
      vsm.syncOrder(['a', 'b']);
      vsm.setActual('a', 50);
      vsm.setActual('b', 80);
      vsm.clear();
      vsm.syncOrder(['a', 'b', 'c']);
      vsm.setActual('c', 120);
      expect(vsm.getHeight('a')).toBe(100);
      expect(vsm.getHeight('c')).toBe(120);
      expect(vsm.getTotalHeight(3)).toBe(100 + 100 + 120);
    });

    it('空 ids 但非空 order 应清空', () => {
      const vsm = new VirtualScrollManager(100);
      vsm.syncOrder(['a', 'b']);
      vsm.syncOrder([]);
      expect(vsm.getOrder()).toEqual([]);
    });

    it('computeVisibleRange 空 order 返回零范围', () => {
      const vsm = new VirtualScrollManager(100);
      const range = vsm.computeVisibleRange(0, 600, 0, 6);
      expect(range.startIndex).toBe(0);
      expect(range.endIndex).toBe(0);
      expect(range.estimatedTotalHeight).toBe(0);
    });

    it('getHeightAt 空 order 返回 fallback', () => {
      const vsm = new VirtualScrollManager(100);
      expect(vsm.getHeightAt(0)).toBe(100);
      expect(vsm.getHeightAt(5)).toBe(100);
    });

    it('窗口平移时高度缓存应保留', () => {
      const vsm = new VirtualScrollManager(100);
      vsm.syncOrder(['a', 'b', 'c']);
      vsm.setActual('a', 50);
      vsm.setActual('b', 80);
      vsm.syncOrder(['x', 'y', 'a', 'b', 'c']);
      expect(vsm.getHeight('a')).toBe(50);
      expect(vsm.getHeight('b')).toBe(80);
    });

    it('expand older 后高度缓存保留', () => {
      const vsm = new VirtualScrollManager(100);
      vsm.syncOrder(['m5', 'm6']);
      vsm.setActual('m5', 200);
      vsm.setActual('m6', 300);
      vsm.syncOrder(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']);
      expect(vsm.hasHeight('m5')).toBe(true);
      expect(vsm.getHeight('m5')).toBe(200);
      expect(vsm.getHeight('m6')).toBe(300);
    });

    it('双重 syncOrder 相同 ids 应跳过', () => {
      const vsm = new VirtualScrollManager(100);
      vsm.syncOrder(['a', 'b']);
      vsm.setActual('a', 50);
      vsm.syncOrder(['a', 'b']);
      expect(vsm.getHeight('a')).toBe(50);
      expect(vsm.getOffset(2)).toBe(50 + 100);
    });

    it('syncOrder 1000 条应在 10ms 内', () => {
      const vsm = new VirtualScrollManager(100);
      const big = ids(1000);
      const start = performance.now();
      vsm.syncOrder(big);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(10);
    });

    it('getDebugInfo returns correct info', () => {
      const vsm = new VirtualScrollManager(100);
      const info = vsm.getDebugInfo();
      expect(info.orderLength).toBe(0);
      expect(info.heightsSize).toBe(0);
      expect(info.generation).toBe(0);
      vsm.syncOrder(['a']);
      const info2 = vsm.getDebugInfo();
      expect(info2.orderLength).toBe(1);
    });

    it('setActual with stale generation should be ignored', () => {
      const vsm = new VirtualScrollManager(100);
      vsm.syncOrder(['a']);
      vsm.setActual('a', 50, 0);
      expect(vsm.getHeight('a')).toBe(50);
      vsm.setActual('a', 999, 999);
      expect(vsm.getHeight('a')).toBe(50);
    });

    it('锚点补偿：expand older 后按 getHeight 计算 scrollDelta', () => {
      const vsm = new VirtualScrollManager(100);
      vsm.syncOrder(['m5', 'm6', 'm7']);
      vsm.setActual('m5', 111);
      vsm.setActual('m6', 222);
      vsm.setActual('m7', 333);

      // expand older: prepend m3, m4
      const prevIds = ['m5', 'm6', 'm7'];
      const nextIds = ['m3', 'm4', 'm5', 'm6', 'm7'];
      vsm.syncOrder(nextIds);

      // ChatMessageList 锚点补偿逻辑
      const anchorId = prevIds[0];
      const newIndexOfAnchor = nextIds.indexOf(anchorId);
      expect(newIndexOfAnchor).toBe(2);

      let prependedHeight = 0;
      for (let i = 0; i < newIndexOfAnchor; i++) {
        prependedHeight += vsm.getHeight(nextIds[i]);
      }
      // m3, m4 未测量 → fallback 100  each
      expect(prependedHeight).toBe(200);

      // 再次 expand：prepend m0, m1, m2
      const prevIds2 = nextIds;
      const nextIds2 = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];
      vsm.syncOrder(nextIds2);
      const anchorId2 = prevIds2[0];
      const newIndexOfAnchor2 = nextIds2.indexOf(anchorId2);
      expect(newIndexOfAnchor2).toBe(3);

      let prependedHeight2 = 0;
      for (let i = 0; i < newIndexOfAnchor2; i++) {
        prependedHeight2 += vsm.getHeight(nextIds2[i]);
      }
      // m0, m1, m2 未测量 → fallback 100 each
      expect(prependedHeight2).toBe(300);
    });

    it('order.length 守卫：clear 后空 order 跳过补偿', () => {
      const vsm = new VirtualScrollManager(100);
      vsm.syncOrder(['m5', 'm6', 'm7']);
      vsm.setActual('m5', 111);
      vsm.clear();
      // 补偿前置守卫：order.length === 0 → return
      expect(vsm.getOrder().length).toBe(0);
    });

    it('generation 守卫：clear 使 generation 递增，旧补偿跳过', () => {
      const vsm = new VirtualScrollManager(100);
      vsm.syncOrder(['m5', 'm6', 'm7']);
      const genBeforeClear = vsm.getGeneration();
      vsm.clear();
      // generation 递增
      expect(vsm.getGeneration()).toBe(genBeforeClear + 1);
      // ChatMessageList 补偿守卫：
      // if (manager.generation !== expectedGenerationRef.current) return;
    });

    it('setActual with callerGeneration 跳过过时 generation', () => {
      const vsm = new VirtualScrollManager(100);
      vsm.syncOrder(['a']);
      vsm.setActual('a', 50, 0);
      expect(vsm.getHeight('a')).toBe(50);
      // 模拟 clear 后 generation 递增
      vsm.clear();
      // 过时 generation 的 setActual 应被忽略
      vsm.syncOrder(['a']);
      vsm.setActual('a', 999, 0);
      expect(vsm.getHeight('a')).toBe(100); // fallback, not 999
    });
  });
});

describe('T4.1（R-04）：setActual 同值跳过', () => {
  it('同值（actual/estimated 均等于新值）→ 返回 false 且不重建 offset 缓存', () => {
    const vsm = new VirtualScrollManager(100);
    vsm.syncOrder(['a', 'b']);
    expect(vsm.setActual('a', 50)).toBe(true);
    expect(vsm.getActualHeight('a')).toBe(50);
    // 同值再写：offset 缓存保持有效（rebuildOffsets 不重跑）
    expect(vsm.setActual('a', 50)).toBe(false);
    expect(vsm.getActualHeight('a')).toBe(50);
    // 不同值 → true
    expect(vsm.setActual('a', 66)).toBe(true);
    expect(vsm.getActualHeight('a')).toBe(66);
  });

  it('invalidate 态（actual == null）仍照常写入', () => {
    const vsm = new VirtualScrollManager(100);
    vsm.syncOrder(['a']);
    vsm.setActual('a', 50);
    vsm.invalidateActual('a');
    expect(vsm.getActualHeight('a')).toBe(null);
    // invalidate 后同高度重测 → 必须视为变更写回
    expect(vsm.setActual('a', 50)).toBe(true);
    expect(vsm.getActualHeight('a')).toBe(50);
  });

  it('过时 generation 返回 false（不 markDirty）', () => {
    const vsm = new VirtualScrollManager(100);
    vsm.syncOrder(['a']);
    vsm.clear();
    vsm.syncOrder(['a']);
    expect(vsm.setActual('a', 999, 0)).toBe(false);
    expect(vsm.getActualHeight('a')).toBe(null);
  });
});
