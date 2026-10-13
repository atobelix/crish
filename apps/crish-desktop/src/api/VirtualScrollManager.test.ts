import { describe, it, expect, beforeEach } from 'vitest';
import {
  VirtualScrollManager,
  estimateTimelineMessageHeight,
  makeScopeKey,
  parseScopeKey,
  formatScopeKey,
  registerScope,
  unregisterScope,
  getScope,
  hasScope,
  clearAllScopes,
  _activeVsmByScope,
  captureScrollAnchor,
  restoreScrollAnchor,
  computePrependHeightDelta,
  prependIdsWithScrollAnchor,
  InertialGestureGuard,
  computeHybridBuckets,
  createHybridBucketCssStyle,
  DEFAULT_GESTURE_SETTLE_WINDOW_MS,
  DEFAULT_HYBRID_BUCKET_SIZE,
  MAX_ACTIVE_HYBRID_BUCKETS,
  HYBRID_BUCKET_CSS_STYLE,
} from './VirtualScrollManager';
import type { SessionMessage } from '../store/types';

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

  it('invalidateActual resets actual and keeps transitional estimate to prevent scroll collapse', () => {
    const vsm = new VirtualScrollManager(100);
    vsm.syncOrder(['a', 'b', 'c']);
    vsm.setActual('a', 40);
    vsm.setActual('b', 60);
    vsm.setActual('c', 80);
    vsm.invalidateActual('b');
    // 关键断言：作废 actual 后保持过渡估计 60px，绝不直接回退到 100/120 fallback 导致 2000px 视口抖动
    expect(vsm.getHeight('b')).toBe(60);
    expect(vsm.getOffset(2)).toBe(40 + 60);
    expect(vsm.getActualHeight('b')).toBe(null); // actual 已清空，待重新测量
    vsm.setEstimated('b', 70); // actual 为 null 时，允许更新 estimate
    expect(vsm.getHeight('b')).toBe(70);
    expect(vsm.getOffset(2)).toBe(40 + 70);
  });

  it('hydrateHeightMap hydrates measured heights in batch and updates offsets', () => {
    const vsm = new VirtualScrollManager(120);
    vsm.syncOrder(['m1', 'm2', 'm3']);
    vsm.hydrateHeightMap({ m1: 800, m2: 250, m3: 400 });

    expect(vsm.getHeight('m1')).toBe(800);
    expect(vsm.getHeight('m2')).toBe(250);
    expect(vsm.getHeight('m3')).toBe(400);
    expect(vsm.getOffset(0)).toBe(0);
    expect(vsm.getOffset(1)).toBe(800);
    expect(vsm.getOffset(2)).toBe(1050);
    expect(vsm.getTotalHeight(3)).toBe(1450);
  });

  it('hydrateHeightMap ignores invalid/negative/non-finite heights', () => {
    const vsm = new VirtualScrollManager(120);
    vsm.syncOrder(['m1']);
    vsm.hydrateHeightMap({ m1: -100, '': 200, m2: NaN });
    expect(vsm.getHeight('m1')).toBe(120); // 未被污染，仍为 fallback
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

describe('Fenwick Tree (BIT) Dynamic Height & Binary Search Precision', () => {
  it('maintains mathematical precision with random mutations across 1,000 items', () => {
    const vsm = new VirtualScrollManager(120);
    const count = 1000;
    const testIds = ids(count, 'msg_');
    vsm.syncOrder(testIds);

    const groundTruth = new Array<number>(count).fill(120);

    // Apply 200 random updates
    for (let k = 0; k < 200; k++) {
      const idx = (k * 37) % count;
      const newH = 50 + ((k * 17) % 300);
      groundTruth[idx] = newH;
      vsm.setActual(testIds[idx]!, newH);
    }

    // Verify prefix sums against ground truth
    let expectedSum = 0;
    for (let i = 0; i < count; i++) {
      expect(vsm.getOffset(i)).toBeCloseTo(expectedSum, 4);
      expectedSum += groundTruth[i]!;
    }
    expect(vsm.getTotalHeight()).toBeCloseTo(expectedSum, 4);
  });

  it('performs 5,000 point updates in under 20ms (O(log N) assertion)', () => {
    const vsm = new VirtualScrollManager(100);
    const count = 5000;
    const testIds = ids(count, 'perf_');
    vsm.syncOrder(testIds);

    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) {
      const targetIdx = (i * 13) % count;
      vsm.setActual(testIds[targetIdx]!, 150 + (i % 100));
    }
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(50); // fast < 50ms (typically < 10ms for 2000 BIT updates)
  });

  it('findIndexAtOffset accurately pinpoints items on boundaries and intermediate offsets', () => {
    const vsm = new VirtualScrollManager(100);
    vsm.syncOrder(['a', 'b', 'c', 'd']);
    vsm.setActual('a', 50); // [0, 50)
    vsm.setActual('b', 100); // [50, 150)
    vsm.setActual('c', 200); // [150, 350)
    vsm.setActual('d', 80); // [350, 430)

    expect(vsm.findIndexAtOffset(0)).toBe(0);
    expect(vsm.findIndexAtOffset(25)).toBe(0);
    expect(vsm.findIndexAtOffset(50)).toBe(1);
    expect(vsm.findIndexAtOffset(149.9)).toBe(1);
    expect(vsm.findIndexAtOffset(150)).toBe(2);
    expect(vsm.findIndexAtOffset(349)).toBe(2);
    expect(vsm.findIndexAtOffset(350)).toBe(3);
    expect(vsm.findIndexAtOffset(500)).toBe(3); // clamp to last index
  });
});

describe('estimateTimelineMessageHeight 几何稳定测试', () => {
  it('PureCarrier 消息高度必须精确估算为 24px，杜绝 100px 保底 (DEF-11)', () => {
    const carrierMsg: SessionMessage = {
      id: 'carrier-1',
      sender: 'assistant',
      text: '',
      injections: [{ id: 's1', metadata: { mode: 'context-state' } }],
      blocks: [
        {
          type: 'context_injection',
          id: 's1',
          injection: { metadata: { mode: 'context-state' } },
        },
      ],
    };

    const estHeight = estimateTimelineMessageHeight(carrierMsg);
    expect(estHeight).toBe(24);
  });
});

describe('lastMeasured survives invalidateActual + preloadEstimates', () => {
  it('preloadEstimates does not overwrite the last measured height', () => {
    const vsm = new VirtualScrollManager(100);
    vsm.syncOrder(['a', 'b']);
    vsm.setActual('a', 180);
    vsm.invalidateActual('a');
    expect(vsm.getActualHeight('a')).toBeNull();
    expect(vsm.getHeight('a')).toBe(180);

    const changed = vsm.preloadEstimates([
      { id: 'a', height: 44 },
      { id: 'b', height: 55 },
    ]);
    expect(changed).toBe(true);
    expect(vsm.getHeight('a')).toBe(180);
    expect(vsm.getActualHeight('a')).toBeNull();
    expect(vsm.getHeight('b')).toBe(55);
  });

  it('clear() drops lastMeasured so clearHeights can re-estimate', () => {
    const vsm = new VirtualScrollManager(100);
    vsm.syncOrder(['a']);
    vsm.setActual('a', 180);
    vsm.invalidateActual('a');
    vsm.clear();
    vsm.syncOrder(['a']);
    vsm.preloadEstimates([{ id: 'a', height: 44 }]);
    expect(vsm.getHeight('a')).toBe(44);
  });
});

describe('W3-C / Review 05：树状数组 NaN、无穷大与负数高度刚性守门魔鬼用例', () => {
  it('传入 NaN、Infinity、-Infinity、-50、0 时，setActual/preloadEstimates/hydrateHeightMap 100% 拦截，前缀和与总高零 NaN 污染', () => {
    const vsm = new VirtualScrollManager(120);
    const itemIds = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'];
    vsm.syncOrder(itemIds);

    // 先写入部分合法实测高度
    expect(vsm.setActual('m0', 100)).toBe(true);
    expect(vsm.setActual('m1', 200)).toBe(true);
    expect(vsm.setActual('m2', 150)).toBe(true);

    // 连续注入魔鬼畸变高度：NaN, Infinity, -Infinity, -50, 0
    expect(vsm.setActual('m0', Number.NaN)).toBe(false);
    expect(vsm.setActual('m1', Number.POSITIVE_INFINITY)).toBe(false);
    expect(vsm.setActual('m2', Number.NEGATIVE_INFINITY)).toBe(false);
    expect(vsm.setActual('m3', -50)).toBe(false);
    expect(vsm.setActual('m4', 0)).toBe(false);
    expect(vsm.setActual('m5', -0.0001)).toBe(false);

    // 批量预估与快照回灌同样注入魔鬼畸变值
    expect(
      vsm.preloadEstimates([
        { id: 'm3', height: Number.NaN },
        { id: 'm4', height: Number.POSITIVE_INFINITY },
        { id: 'm5', height: -50 },
      ])
    ).toBe(false);

    vsm.hydrateHeightMap({
      m0: Number.NaN,
      m1: Number.NEGATIVE_INFINITY,
      m3: -50,
      m4: Number.POSITIVE_INFINITY,
    });

    vsm.setEstimated('m3', Number.NaN);
    vsm.setEstimated('m4', -50);
    vsm.setEstimated('m5', Number.POSITIVE_INFINITY);

    // 验证各项高度保持合法有限值（m0=100, m1=200, m2=150, m3..m5=120 fallback）
    const expectedHeights = [100, 200, 150, 120, 120, 120];
    let runningOffset = 0;
    for (let i = 0; i < itemIds.length; i++) {
      const h = vsm.getHeight(itemIds[i]!);
      const hAt = vsm.getHeightAt(i);
      const offset = vsm.getOffset(i);

      expect(Number.isFinite(h)).toBe(true);
      expect(Number.isFinite(hAt)).toBe(true);
      expect(Number.isFinite(offset)).toBe(true);
      expect(h).toBe(expectedHeights[i]);
      expect(hAt).toBe(expectedHeights[i]);
      expect(offset).toBe(runningOffset);
      runningOffset += expectedHeights[i]!;
    }

    const totalHeight = vsm.getTotalHeight();
    expect(Number.isFinite(totalHeight)).toBe(true);
    expect(totalHeight).toBe(810);

    // 验证二分查找与可视区间计算保持严格单调与有限合法
    for (let offset = 0; offset <= totalHeight + 100; offset += 50) {
      const idx = vsm.findIndexAtOffset(offset);
      expect(Number.isFinite(idx)).toBe(true);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(itemIds.length);
    }
  });
});

describe('W2-5 / VULN-04：复合作用域隔离 (${paneId}::${sessionId}) 与多窗格状态独立性', () => {
  beforeEach(() => {
    clearAllScopes();
  });

  describe('复合键工具函数契约与边界 (makeScopeKey / parseScopeKey / formatScopeKey)', () => {
    it('makeScopeKey 正确生成 ${paneId}::${sessionId} 格式', () => {
      expect(makeScopeKey('session-100', 'pane-left')).toBe(
        'pane-left::session-100'
      );
      expect(makeScopeKey('session-100', 'pane-right')).toBe(
        'pane-right::session-100'
      );
    });

    it('makeScopeKey 在 paneId 为 null/undefined 时回退到 default 窗格', () => {
      expect(makeScopeKey('session-100')).toBe('default::session-100');
      expect(makeScopeKey('session-100', null)).toBe('default::session-100');
      expect(makeScopeKey('session-100', undefined)).toBe(
        'default::session-100'
      );
      expect(makeScopeKey('session-100', '')).toBe('default::session-100');
    });

    it('makeScopeKey 若传入已是复合键的 sessionId 且无 paneId 时幂等保留', () => {
      expect(makeScopeKey('pane-x::session-100')).toBe('pane-x::session-100');
    });

    it('formatScopeKey 格式化一致性', () => {
      expect(formatScopeKey('pane-a', 'session-b')).toBe('pane-a::session-b');
      expect(formatScopeKey(null, 'session-b')).toBe('default::session-b');
    });

    it('parseScopeKey 正确解析复合键结构', () => {
      const parsed = parseScopeKey('pane-split-1::session-uuid-1234');
      expect(parsed.paneId).toBe('pane-split-1');
      expect(parsed.sessionId).toBe('session-uuid-1234');
      expect(parsed.isComposite).toBe(true);
    });

    it('parseScopeKey 兼容旧式单个 sessionId 回退', () => {
      const parsed = parseScopeKey('session-legacy-5678');
      expect(parsed.paneId).toBe('default');
      expect(parsed.sessionId).toBe('session-legacy-5678');
      expect(parsed.isComposite).toBe(false);
    });

    it('parseScopeKey 边界防御：空字符串与首定界符', () => {
      const empty = parseScopeKey('');
      expect(empty.paneId).toBe('default');
      expect(empty.sessionId).toBe('');
      expect(empty.isComposite).toBe(false);

      const leadingDelimiter = parseScopeKey('::session-only');
      expect(leadingDelimiter.paneId).toBe('default');
      expect(leadingDelimiter.sessionId).toBe('session-only');
      expect(leadingDelimiter.isComposite).toBe(true);
    });
  });

  describe('同一会话多窗格隔离与非对称排版高度独立性 (VULN-04)', () => {
    it('同一 sessionId 在不同 paneId 下分别注册，两者的实例相互独立且互不覆盖', () => {
      const vsmLeft = new VirtualScrollManager(100);
      const vsmRight = new VirtualScrollManager(100);
      const sessionId = 'session-shared-split';

      registerScope(sessionId, 'pane-left', vsmLeft);
      registerScope(sessionId, 'pane-right', vsmRight);

      // 验证检索精确匹配各自窗格实例
      expect(getScope(sessionId, 'pane-left')).toBe(vsmLeft);
      expect(getScope(sessionId, 'pane-right')).toBe(vsmRight);
      expect(getScope(sessionId, 'pane-left')).not.toBe(
        getScope(sessionId, 'pane-right')
      );

      // 验证实例绑定的作用域属性
      expect(vsmLeft.getPaneId()).toBe('pane-left');
      expect(vsmLeft.getSessionId()).toBe(sessionId);
      expect(vsmLeft.getScopeKey()).toBe('pane-left::session-shared-split');

      expect(vsmRight.getPaneId()).toBe('pane-right');
      expect(vsmRight.getSessionId()).toBe(sessionId);
      expect(vsmRight.getScopeKey()).toBe('pane-right::session-shared-split');
    });

    it('左右两窗格不同宽度下，高度快照缓存（heightCache）与滚动偏移状态各自独立维护', () => {
      const vsmLeft = new VirtualScrollManager(100); // 模拟窄屏 (450px)
      const vsmRight = new VirtualScrollManager(100); // 模拟宽屏 (900px)
      const sessionId = 'session-width-diff';

      registerScope(sessionId, 'pane-narrow', vsmLeft);
      registerScope(sessionId, 'pane-wide', vsmRight);

      const messageIds = ['msg-short', 'msg-long-text', 'msg-code-block'];
      vsmLeft.syncOrder(messageIds);
      vsmRight.syncOrder(messageIds);

      // 窄窗格：长文本折行为更多行，高度明显更高
      vsmLeft.setActual('msg-short', 60);
      vsmLeft.setActual('msg-long-text', 360); // 450px 宽度多行排版
      vsmLeft.setActual('msg-code-block', 200);

      // 宽窗格：长文本仅占更少行，高度显著紧凑
      vsmRight.setActual('msg-short', 60);
      vsmRight.setActual('msg-long-text', 140); // 900px 宽度单行排版
      vsmRight.setActual('msg-code-block', 200);

      // 1. 验证各自实测高度严格隔离，绝无全局污染
      expect(vsmLeft.getHeight('msg-long-text')).toBe(360);
      expect(vsmRight.getHeight('msg-long-text')).toBe(140);

      // 2. 验证 Fenwick 树前缀和偏移与总高度各自独立
      expect(vsmLeft.getOffset(1)).toBe(60);
      expect(vsmLeft.getOffset(2)).toBe(60 + 360); // 420
      expect(vsmLeft.getTotalHeight()).toBe(60 + 360 + 200); // 620

      expect(vsmRight.getOffset(1)).toBe(60);
      expect(vsmRight.getOffset(2)).toBe(60 + 140); // 200
      expect(vsmRight.getTotalHeight()).toBe(60 + 140 + 200); // 400

      // 3. 验证 heightCache 快照字典严格互不侵扰
      expect(vsmLeft.heightCache['msg-long-text']).toBe(360);
      expect(vsmRight.heightCache['msg-long-text']).toBe(140);

      const leftCache = vsmLeft.getHeightCache();
      const rightCache = vsmRight.getHeightCache();
      expect(leftCache).toEqual({
        'msg-short': 60,
        'msg-long-text': 360,
        'msg-code-block': 200,
      });
      expect(rightCache).toEqual({
        'msg-short': 60,
        'msg-long-text': 140,
        'msg-code-block': 200,
      });

      // 4. 清空左窗格（例如切换其内部滚动重置）绝不影响右窗格状态
      vsmLeft.clear();
      expect(vsmLeft.getHeight('msg-long-text')).toBe(100); // fallback
      expect(vsmRight.getHeight('msg-long-text')).toBe(140); // 完好保留！
      expect(vsmRight.getTotalHeight()).toBe(400);
    });

    it('根治幽灵注销（VULN-04）：当 pane-1 注销时，pane-2 的 VSM 实例依然存活且状态不受损', () => {
      const vsm1 = new VirtualScrollManager(120);
      const vsm2 = new VirtualScrollManager(120);
      const sessionId = 'session-ghost-unregister-guard';

      registerScope(sessionId, 'pane-1', vsm1);
      registerScope(sessionId, 'pane-2', vsm2);

      vsm1.syncOrder(['m1', 'm2']);
      vsm1.setActual('m1', 80);
      vsm1.setActual('m2', 90);

      vsm2.syncOrder(['m1', 'm2']);
      vsm2.setActual('m1', 150);
      vsm2.setActual('m2', 160);

      expect(hasScope(sessionId, 'pane-1')).toBe(true);
      expect(hasScope(sessionId, 'pane-2')).toBe(true);

      // 用户关闭窗格 1：卸载 pane-1 对应的虚拟滚动管理器
      const unregisterResult = unregisterScope(sessionId, 'pane-1');
      expect(unregisterResult).toBe(true);

      // 核心断言：pane-1 已被精确移除
      expect(getScope(sessionId, 'pane-1')).toBeUndefined();
      expect(hasScope(sessionId, 'pane-1')).toBe(false);

      // 核心反幽灵断言：pane-2 实例必须完整存活，状态与高度快照零损毁！
      expect(hasScope(sessionId, 'pane-2')).toBe(true);
      const retrievedPane2 = getScope(sessionId, 'pane-2');
      expect(retrievedPane2).toBe(vsm2);
      expect(retrievedPane2?.getHeight('m1')).toBe(150);
      expect(retrievedPane2?.getHeight('m2')).toBe(160);
      expect(retrievedPane2?.getOffset(1)).toBe(150);
      expect(retrievedPane2?.getTotalHeight()).toBe(310);
      expect(retrievedPane2?.heightCache['m1']).toBe(150);

      // 彻底关闭窗格 2
      expect(unregisterScope(sessionId, 'pane-2')).toBe(true);
      expect(getScope(sessionId, 'pane-2')).toBeUndefined();
      expect(hasScope(sessionId, 'pane-2')).toBe(false);
    });

    it('支持直接传入复合键字符串进行精确注销', () => {
      const vsm = new VirtualScrollManager(100);
      const compKey = 'pane-editor::session-doc-99';

      registerScope(compKey, vsm);
      expect(getScope(compKey)).toBe(vsm);
      expect(hasScope(compKey)).toBe(true);

      const removed = unregisterScope(compKey);
      expect(removed).toBe(true);
      expect(getScope(compKey)).toBeUndefined();
      expect(hasScope(compKey)).toBe(false);
    });
  });

  describe('默认窗格作用域与 O(1) 严格寻址契约 (§3.2.1)', () => {
    it('未指定 paneId 时归一化至 default 窗格复合键', () => {
      const vsmDefault = new VirtualScrollManager(100);
      const sessionId = 'session-legacy-single';

      registerScope(sessionId, vsmDefault);

      // 默认窗格检索
      expect(getScope(sessionId)).toBe(vsmDefault);
      expect(getScope(sessionId, 'default')).toBe(vsmDefault);
      expect(getScope(`default::${sessionId}`)).toBe(vsmDefault);

      // 默认窗格注销
      expect(unregisterScope(sessionId)).toBe(true);
      expect(getScope(sessionId)).toBeUndefined();
    });

    it('废除 O(N) 后缀遍历降级：未指定 paneId 时仅查 default 窗格，绝不跨窗格线性扫描', () => {
      const vsm = new VirtualScrollManager(100);
      registerScope('session-wildcard', 'pane-right', vsm);

      // 显式指定 paneId 精确 O(1) 命中
      expect(getScope('session-wildcard', 'pane-right')).toBe(vsm);
      // 省略 paneId 时查找 default::session-wildcard，不进行 O(N) 后缀遍历匹配其他窗格
      expect(getScope('session-wildcard')).toBeUndefined();
    });

    it('默认窗格单键注销不连带伤及已存在的分屏窗格', () => {
      const vsmPane = new VirtualScrollManager(100);
      const sessionId = 'session-mix-unregister';

      registerScope(sessionId, 'pane-alpha', vsmPane);

      // 尝试以无 paneId 单键注销
      unregisterScope(sessionId);

      // 分屏窗格必须依然安然无恙！
      expect(getScope(sessionId, 'pane-alpha')).toBe(vsmPane);
    });
  });

  describe('作用域注册表与构造函数集成契约', () => {
    it('作用域函数提供精确的注册与检索 API', () => {
      const vsm = new VirtualScrollManager(100);
      const sessionId = 'session-static-test';

      registerScope(sessionId, 'pane-st', vsm);
      expect(getScope(sessionId, 'pane-st')).toBe(vsm);
      expect(hasScope(sessionId, 'pane-st')).toBe(true);
      expect(_activeVsmByScope.has('pane-st::session-static-test')).toBe(true);

      expect(unregisterScope(sessionId, 'pane-st')).toBe(true);
      expect(getScope(sessionId, 'pane-st')).toBeUndefined();
    });

    it('VirtualScrollManager 构造函数单轨接收复合作用域键自动绑定作用域', () => {
      const vsm1 = new VirtualScrollManager(
        100,
        makeScopeKey('session-init', 'pane-init')
      );
      expect(vsm1.getPaneId()).toBe('pane-init');
      expect(vsm1.getSessionId()).toBe('session-init');
      expect(vsm1.getScopeKey()).toBe('pane-init::session-init');

      const vsm2 = new VirtualScrollManager(100, 'pane-direct::session-direct');
      expect(vsm2.getPaneId()).toBe('pane-direct');
      expect(vsm2.getSessionId()).toBe('session-direct');
      expect(vsm2.getScopeKey()).toBe('pane-direct::session-direct');
    });

    it('clearAllScopes 清空全部活跃作用域映射', () => {
      const vsm1 = new VirtualScrollManager(100);
      const vsm2 = new VirtualScrollManager(100);
      registerScope('s1', 'p1', vsm1);
      registerScope('s2', 'p2', vsm2);

      expect(_activeVsmByScope.size).toBeGreaterThanOrEqual(2);
      clearAllScopes();
      expect(_activeVsmByScope.size).toBe(0);
      expect(getScope('s1', 'p1')).toBeUndefined();
      expect(getScope('s2', 'p2')).toBeUndefined();
    });
  });
});

describe('virtualScrollAnchor 独立纯函数与委托契约', () => {
  it('captureScrollAnchor / restoreScrollAnchor / computePrependHeightDelta / prependIdsWithScrollAnchor 保持 0 偏移', () => {
    const vsm = new VirtualScrollManager(100);
    vsm.syncOrder(['m2', 'm3', 'm4']);
    vsm.setActual('m2', 120);
    vsm.setActual('m3', 180);
    vsm.setActual('m4', 200);

    const anchor = captureScrollAnchor(vsm, 150);
    expect(anchor).toEqual({
      anchorId: 'm3',
      anchorIndex: 1,
      offsetInItem: 30,
    });

    const delta = computePrependHeightDelta(
      vsm,
      ['m0', 'm1'],
      [
        { id: 'm0', height: 90 },
        { id: 'm1', height: 110 },
      ]
    );
    expect(delta).toBe(200);

    const prepended = prependIdsWithScrollAnchor(vsm, ['m0', 'm1'], 150);
    expect(prepended.newOrder).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(prepended.heightDelta).toBe(200);
    expect(prepended.compensatedScrollTop).toBe(350);
    expect(restoreScrollAnchor(vsm, anchor, 150)).toBe(350);
  });

  it('captureScrollAnchor 与 restoreScrollAnchor 处理空列表、负偏移及锚点缺失回退边界', () => {
    const vsm = new VirtualScrollManager(100);

    // 空列表捕获与恢复
    const emptyAnchor = vsm.captureScrollAnchor(-40);
    expect(emptyAnchor).toEqual({
      anchorId: null,
      anchorIndex: 0,
      offsetInItem: 0,
    });
    expect(vsm.restoreScrollAnchor(emptyAnchor, 0)).toBe(0);

    vsm.syncOrder(['a', 'b', 'c']);
    vsm.setActual('a', 100);
    vsm.setActual('b', 150);
    vsm.setActual('c', 200);

    // 负数 scrollTop 归一化至首项 0 偏移
    expect(vsm.captureScrollAnchor(-15)).toEqual({
      anchorId: 'a',
      anchorIndex: 0,
      offsetInItem: 0,
    });

    // 锚点 ID 在重排后被移除时，按 anchorIndex 回退计算偏移
    const anchorB = vsm.captureScrollAnchor(125); // b (index 1), offsetInItem = 25
    expect(anchorB).toEqual({
      anchorId: 'b',
      anchorIndex: 1,
      offsetInItem: 25,
    });
    vsm.syncOrder(['a', 'c']); // 'b' 被移除，index 1 变为 'c' (offset 100)
    expect(vsm.restoreScrollAnchor(anchorB, 125)).toBe(125);
  });

  it('prependIdsWithScrollAnchor 幂等去重、空输入短路与连续多页前插 0 抖动', () => {
    const vsm = new VirtualScrollManager(100);
    vsm.syncOrder(['m4', 'm5']);
    vsm.setActual('m4', 140);
    vsm.setActual('m5', 160);

    // 1. 空数组前插短路
    const emptyRes = vsm.prependIdsWithScrollAnchor([], 170);
    expect(emptyRes).toEqual({
      newOrder: ['m4', 'm5'],
      heightDelta: 0,
      compensatedScrollTop: 170,
    });

    // 2. 全重复 ID 前插短路
    const dupRes = vsm.prependIdsWithScrollAnchor(['m4', 'm5'], 170);
    expect(dupRes).toEqual({
      newOrder: ['m4', 'm5'],
      heightDelta: 0,
      compensatedScrollTop: 170,
    });

    // 3. 部分重复 + 预估高度前插（m5 内部偏移 30px）
    const step1 = vsm.prependIdsWithScrollAnchor(['m2', 'm3', 'm4'], 170, [
      { id: 'm2', height: 80 },
      { id: 'm3', height: 120 },
    ]);
    expect(step1.newOrder).toEqual(['m2', 'm3', 'm4', 'm5']);
    expect(step1.heightDelta).toBe(200);
    expect(step1.compensatedScrollTop).toBe(370);
    expect(vsm.getOffset(vsm.getIndex('m5')!) + 30).toBe(
      step1.compensatedScrollTop
    );

    // 4. 二次连续向前翻页前插
    const step2 = vsm.prependIdsWithScrollAnchor(
      ['m0', 'm1'],
      step1.compensatedScrollTop,
      [
        { id: 'm0', height: 60 },
        { id: 'm1', height: 90 },
      ]
    );
    expect(step2.newOrder).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
    expect(step2.heightDelta).toBe(150);
    expect(step2.compensatedScrollTop).toBe(520);
    expect(vsm.getOffset(vsm.getIndex('m5')!) + 30).toBe(520);
  });

  it('virtualScrollScope O(1) Map 精确寻址与单轨化零遗留别名守卫', () => {
    clearAllScopes();
    for (let i = 0; i < 500; i++) {
      registerScope(
        `sess-${i}`,
        `pane-${i % 4}`,
        new VirtualScrollManager(100)
      );
    }
    const targetVsm = new VirtualScrollManager(120);
    registerScope('sess-target', 'pane-main', targetVsm);

    // O(1) 精确命中指定复合作用域，不匹配其他 pane
    expect(getScope('sess-target', 'pane-main')).toBe(targetVsm);
    expect(getScope('pane-main::sess-target')).toBe(targetVsm);
    expect(getScope('sess-target', 'pane-other')).toBeUndefined();
    expect(getScope('sess-target')).toBeUndefined();
    expect(getScope('')).toBeUndefined();
    expect(unregisterScope('')).toBe(false);

    // 实例方法不再暴露已移除的伪兼容别名
    const proto = VirtualScrollManager.prototype as Record<string, unknown>;
    expect(proto['getHeightMap']).toBeUndefined();
    expect(proto['clearScrollAnchor']).toBeUndefined();
    expect(proto['setScrollAnchor']).toBeUndefined();
    expect(proto['hasScrollAnchor']).toBeUndefined();

    clearAllScopes();
  });
});

describe('virtualScrollGestureGuard 与 VirtualScrollManager 协同契约', () => {
  it('VirtualScrollManager 门面重新导出全部手势保护与混合分桶原语', () => {
    expect(InertialGestureGuard).toBeDefined();
    expect(computeHybridBuckets).toBeDefined();
    expect(createHybridBucketCssStyle).toBeDefined();
    expect(DEFAULT_GESTURE_SETTLE_WINDOW_MS).toBe(120);
    expect(DEFAULT_HYBRID_BUCKET_SIZE).toBe(100);
    expect(MAX_ACTIVE_HYBRID_BUCKETS).toBe(3);
    expect(HYBRID_BUCKET_CSS_STYLE.contentVisibility).toBe('auto');
  });

  it('VSM 测高数据无缝注入 computeHybridBuckets 保持高度与视口计算一致', () => {
    const vsm = new VirtualScrollManager(80);
    const order = Array.from({ length: 250 }, (_, i) => `msg_${i}`);
    vsm.syncOrder(order);
    vsm.setActual('msg_0', 120);
    vsm.setActual('msg_1', 150);

    const buckets = computeHybridBuckets({
      messageIds: vsm.getOrder(),
      getItemHeight: (id) => vsm.getHeight(id),
      bucketSize: 100,
      scrollTop: 0,
      viewportHeight: 600,
    });

    expect(buckets.bucketSize).toBe(100);
    expect(buckets.length).toBe(3); // 250 条消息划分为 3 个桶 (100, 100, 50)
    expect(buckets.activeBuckets.length).toBeLessThanOrEqual(
      MAX_ACTIVE_HYBRID_BUCKETS
    );
    expect(buckets.totalEstimatedHeight).toBe(vsm.getTotalHeight());
  });

  it('InertialGestureGuard 与 VSM stickToBottomLock 协同防抖熔断', () => {
    const vsm = new VirtualScrollManager(100);
    const guard = new InertialGestureGuard();

    // 模拟流式生成开始：锁定吸底
    vsm.setStickToBottomLock(true);
    guard.setPinnedToBottom(vsm.isStickToBottomLocked());

    expect(guard.isPinnedToBottom).toBe(true);

    // 测量更新产生折叠导致的负差量（例如 -200px）
    const decision = guard.recordHeightDelta(-200);
    expect(decision.fusedByPinnedBottom).toBe(true);
    expect(decision.immediateScrollDelta).toBe(0);
    expect(guard.pendingHeightDelta).toBe(0);
    expect(guard.fusedCount).toBe(1);

    // 流式结束释放吸底锁
    vsm.setStickToBottomLock(false);
    guard.setPinnedToBottom(vsm.isStickToBottomLocked());
    expect(guard.isPinnedToBottom).toBe(false);
  });
});
