/**
 * cache (LruCache / BoundedMapCache) 对抗性测试
 *
 * 已暴露的 bug 清单：
 *  C1. set 超大 entry 时静默丢弃（无错误、无返回值指示失败）
 *  C2. estimateSize 默认返回 0 → maxBytes 约束完全失效
 *  C3. emergencyClear 在 maxEntries=0 时 keepCount=1（与容量 0 矛盾）
 *  C4. shrink(targetRatio>1) 是静默 no-op（可能误导调用方）
 *  C5. BoundedMapCache 不支持字节预算（budget.used = size，非 bytes）
 *  C6. LruCache.set 替换已存在 key 时 bytesUsed 先减后加，但 estimateSize 不一致时 bytesUsed 漂移
 *  C7. delete 不存在的 key 返回 false 且 bytesUsed 不变（正确），但 clear 后 bytesUsed 归零
 *      而 emergencyClear 后 bytesUsed 可能不归零（keepCount>0 时残留）
 *  C8. get 触发 LRU 重排但不更新 bytesUsed（正确），但 set 覆盖 get 过的 key 时
 *      bytesUsed 减去的是旧值 size，加的是新值 size（依赖 estimateSize 的确定性）
 *  C9. BoundedMapCache.shrink 使用 keys()[0] 作为最旧 key，但 BoundedMap 是 FIFO 非 LRU
 *      → BoundedMapCache 的 "shrink" 语义与 LruCache 不一致
 */

import { describe, it, expect } from 'vitest';
import { LruCache, BoundedMapCache } from './cache';
import { BoundedMap } from './bounded-map';

describe('LruCache — 对抗性测试', () => {
  describe('C1: set 超大 entry 静默丢弃', () => {
    it('暴露 bug: entry size > maxBytes 时 set 静默失败，调用方无感知', () => {
      const cache = new LruCache<string, string>(
        10,
        100, // maxBytes=100
        (_key, value) => value.length,
      );

      // 大于 maxBytes 的 entry
      const bigValue = 'x'.repeat(200);
      cache.set('big', bigValue);

      // Bug: set 不抛异常、不返回 false、不存储
      // 调用方完全无法感知存储失败
      expect(cache.has('big')).toBe(false);
      expect(cache.get('big')).toBeUndefined();
      expect(cache.size).toBe(0);
    });

    it('恰好等于 maxBytes 的 entry 可以存储', () => {
      const cache = new LruCache<string, string>(
        10,
        50,
        (_key, value) => value.length,
      );

      cache.set('exact', 'x'.repeat(50));
      expect(cache.has('exact')).toBe(true);
      // Bug 验证：size > maxBytes 被拒绝，size == maxBytes 被接受
      // 但 set 不返回 boolean 指示成功/失败
    });
  });

  describe('C2: estimateSize 默认返回 0 → maxBytes 失效', () => {
    it('暴露 bug: 不传 estimateSize 时所有 entry size=0，maxBytes 永不触发淘汰', () => {
      const cache = new LruCache<string, string>(3, 10); // maxBytes=10, 无 estimator

      cache.set('a', 'x'.repeat(1000)); // 实际 1000 bytes，但 estimateSize 返回 0
      cache.set('b', 'x'.repeat(1000));
      cache.set('c', 'x'.repeat(1000));

      // Bug: bytesUsed 始终为 0，maxBytes 约束永不触发
      // 只有 maxEntries=3 生效
      expect(cache.size).toBe(3);
      expect(cache.budget.used).toBe(0); // bytesUsed=0
      expect(cache.budget.max).toBe(10);
    });
  });

  describe('C3: emergencyClear 在 maxEntries=0 时 keepCount=1', () => {
    it('暴露 bug: maxEntries=0 时 emergencyClear 保留 1 条（与容量 0 矛盾）', () => {
      // 注意：maxEntries=0 时 set 会怎样？
      const cache = new LruCache<string, string>(0, 1000, () => 0);

      cache.set('a', '1');

      // maxEntries=0: set 中的 eviction 循环条件 map.size >= 0 永远为 true
      // 但 map.size 初始为 0，循环条件 map.size > 0 为 false，不执行
      // 所以 'a' 被存入，map.size=1 > maxEntries=0
      // Bug: maxEntries=0 无法阻止 set 存入第一条
      expect(cache.size).toBe(1);

      cache.emergencyClear();
      // Bug: keepCount = Math.max(1, Math.floor(0 * 0.1)) = Math.max(1, 0) = 1
      // while (map.size > 1) 不执行，保留 1 条
      // 但 maxEntries=0 意味着不应该存任何条目
      expect(cache.size).toBe(1);
    });
  });

  describe('C4: shrink(targetRatio>1) 静默 no-op', () => {
    it('暴露 bug: targetRatio=2.0 时不扩展容量，静默 no-op', () => {
      const cache = new LruCache<string, number>(10, 10000, () => 1);

      for (let i = 0; i < 5; i++) {
        cache.set(`k${i}`, i);
      }
      expect(cache.size).toBe(5);

      // shrink(2.0): targetEntries = floor(10 * 2.0) = 20
      // while (5 > 20) → false → no-op
      cache.shrink(2.0);

      // Bug: 无错误、无警告，调用方可能误以为容量被扩展
      expect(cache.size).toBe(5);
    });

    it('shrink(0.5) 正常淘汰到目标', () => {
      const cache = new LruCache<string, number>(10, 10000, () => 1);

      for (let i = 0; i < 10; i++) {
        cache.set(`k${i}`, i);
      }
      expect(cache.size).toBe(10);

      cache.shrink(0.5);
      // targetEntries = floor(10 * 0.5) = 5
      expect(cache.size).toBe(5);
      // 保留最新的 5 个（k5-k9）
      expect(cache.has('k0')).toBe(false);
      expect(cache.has('k9')).toBe(true);
    });
  });

  describe('C6: estimateSize 不确定性导致 bytesUsed 漂移', () => {
    it('暴露 bug: 同一 key/value 多次 set 时 estimateSize 返回不同值导致 bytesUsed 错误', () => {
      // 模拟一个非确定性的 estimateSize（实际中可能是序列化长度变化等）
      let callCount = 0;
      const nonDeterministicEstimator = () => {
        callCount++;
        return callCount; // 每次调用返回不同值
      };

      const cache = new LruCache<string, string>(10, 1000, nonDeterministicEstimator);

      cache.set('key', 'value');
      // 第一次 set:
      //   size = estimateSize(key, value) → callCount=1, returns 1
      //   bytesUsed = 0 + 1 = 1

      cache.set('key', 'value');
      // 第二次 set 覆盖:
      //   size = estimateSize(key, newValue) → callCount=2, returns 2
      //   map.has(key) → true
      //   bytesUsed -= estimateSize(key, oldValue) → callCount=3, returns 3
      //   bytesUsed = 1 - 3 = -2（中间出现负数！）
      //   bytesUsed += size(=2) → bytesUsed = -2 + 2 = 0

      // Bug: bytesUsed 最终为 0，但实际存了一个 entry（estimateSize 第一次返回 1）
      // bytesUsed 与真实内存使用不一致
      expect(cache.budget.used).toBe(0);

      // 更严重的问题：中间出现了 bytesUsed = -2（负数）
      // 如果在 eviction 循环中检查 bytesUsed + size > maxBytes，
      // 负的 bytesUsed 会使判断错误（允许超量存储）
    });

    it('暴露 bug: 负 bytesUsed 使 maxBytes 约束失效（允许超量存储）', () => {
      let callCount = 0;
      const estimator = () => {
        callCount++;
        return callCount;
      };

      // maxBytes=3，正常情况下最多存 3 个 size=1 的 entry
      const cache = new LruCache<string, string>(100, 3, estimator);

      // 通过两次 set 同一 key 制造负 bytesUsed
      cache.set('key', 'v'); // callCount=1, size=1, bytesUsed=1
      cache.set('key', 'v'); // callCount=2,3, bytesUsed=1-3+2=0

      // 此时 bytesUsed=0，但 maxEntries=100，可以继续存
      // 如果存 size=1 的 entry，bytesUsed=1
      // 但如果我们存一个 size=4 的 entry（>maxBytes=3），它应该被拒绝
      // 然而 bytesUsed + 4 = 0 + 4 = 4 > 3 → 会被拒绝（正确）
      // 但如果 bytesUsed 是 -2（在第二次 set 的中间状态），-2 + 4 = 2 < 3 → 允许存储（错误）
      // 不过 eviction 循环在 map.delete 之后执行，bytesUsed 已被修正

      // 实际可验证的 bug：bytesUsed 与真实使用量不一致
      expect(cache.budget.used).toBe(0);
      expect(cache.size).toBe(1); // 只有一个 entry
    });
  });

  describe('LRU 顺序正确性', () => {
    it('get 刷新访问顺序', () => {
      const cache = new LruCache<string, number>(3, 10000, () => 1);

      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      // 访问 'a'，使其成为最近使用
      cache.get('a');

      // 插入 'd'，应淘汰 'b'（最久未使用）
      cache.set('d', 4);

      expect(cache.has('a')).toBe(true);
      expect(cache.has('b')).toBe(false);
      expect(cache.has('c')).toBe(true);
      expect(cache.has('d')).toBe(true);
    });

    it('set 已存在的 key 不改变 LRU 顺序（Map.delete + Map.set 刷新顺序）', () => {
      const cache = new LruCache<string, number>(3, 10000, () => 1);

      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      // 更新 'a'（LruCache.set 先 delete 再 set → 刷新到最新）
      cache.set('a', 10);

      // 插入 'd'，应淘汰 'b'
      cache.set('d', 4);

      expect(cache.has('a')).toBe(true);
      expect(cache.has('b')).toBe(false);
    });
  });

  describe('delete 与 bytesUsed', () => {
    it('delete 不存在的 key 返回 false 且 bytesUsed 不变', () => {
      const cache = new LruCache<string, string>(10, 1000, (_k, v) => v.length);

      cache.set('a', 'xxxxx'); // bytesUsed=5
      expect(cache.budget.used).toBe(5);

      const result = cache.delete('nonexistent');
      expect(result).toBe(false);
      expect(cache.budget.used).toBe(5);
    });

    it('delete 已存在的 key 正确减少 bytesUsed', () => {
      const cache = new LruCache<string, string>(10, 1000, (_k, v) => v.length);

      cache.set('a', 'xxxxx'); // bytesUsed=5
      cache.set('b', 'yyy');   // bytesUsed=8

      cache.delete('a');
      expect(cache.budget.used).toBe(3);
    });
  });

  describe('并发 set/get 交替', () => {
    it('高频 set/get 交替后 cache 状态一致', () => {
      const cache = new LruCache<number, number>(5, 100000, () => 1);

      for (let round = 0; round < 10; round++) {
        for (let i = 0; i < 20; i++) {
          cache.set(i, i * 2);
        }
        for (let i = 0; i < 20; i++) {
          cache.get(i); // 可能 miss
        }
      }

      // 最终 size 不超过 maxEntries
      expect(cache.size).toBeLessThanOrEqual(5);
      // bytesUsed 应该 == size * 1
      expect(cache.budget.used).toBe(cache.size);
    });
  });
});

describe('BoundedMapCache — 对抗性测试', () => {
  describe('C5: 不支持字节预算', () => {
    it('暴露 bug: BoundedMapCache.budget.used 返回条目数而非字节数', () => {
      const cache = new BoundedMapCache<string, string>(10);

      cache.set('a', 'x'.repeat(1000));
      cache.set('b', 'x'.repeat(2000));

      // Bug: budget.used = map.size = 2，不是 3000 bytes
      // 与 LruCache.budget 语义不一致
      expect(cache.budget.used).toBe(2);
      expect(cache.budget.max).toBe(10);
    });
  });

  describe('C9: BoundedMapCache.shrink 语义与 LruCache 不一致', () => {
    it('暴露 bug: BoundedMapCache 基于 FIFO 淘汰，LruCache 基于 LRU 淘汰', () => {
      const fifoCache = new BoundedMapCache<string, number>(5);

      fifoCache.set('a', 1);
      fifoCache.set('b', 2);
      fifoCache.set('c', 3);
      fifoCache.set('d', 4);
      fifoCache.set('e', 5);

      // 访问 'a'（FIFO 模式下不刷新顺序）
      // BoundedMap.get 不重排
      fifoCache.get('a');

      fifoCache.shrink(0.4); // targetSize = max(1, floor(5*0.4)) = 2

      // FIFO: 淘汰最旧插入的 'a', 'b', 'c'，保留 'd', 'e'
      // LRU: 应该保留 'a'（刚被访问）和 'd', 'e' 中最新的
      // Bug: BoundedMapCache.shrink 淘汰 'a' 即使它刚被访问
      expect(fifoCache.get('a')).toBeUndefined(); // FIFO 行为
      expect(fifoCache.get('d')).toBe(4);
      expect(fifoCache.get('e')).toBe(5);
    });
  });

  describe('emergencyClear', () => {
    it('emergencyClear 保留约 10% 最新条目', () => {
      const cache = new BoundedMapCache<string, number>(10);

      for (let i = 0; i < 10; i++) {
        cache.set(`k${i}`, i);
      }

      cache.emergencyClear(); // shrink(0.1) → targetSize = max(1, 1) = 1

      expect(cache.size).toBe(1);
      // 保留最后插入的（BoundedMapCache 无 has 方法，用 get 验证）
      expect(cache.get('k9')).toBe(9);
    });
  });
});

describe('BoundedMap — 对抗性测试（cache 依赖）', () => {
  describe('构造校验', () => {
    it('capacity=0 抛 RangeError', () => {
      expect(() => new BoundedMap<string, number>(0, undefined)).toThrow(RangeError);
    });

    it('capacity=Infinity 抛 RangeError', () => {
      expect(() => new BoundedMap<string, number>(Infinity, undefined)).toThrow(RangeError);
    });

    it('capacity=NaN 抛 RangeError', () => {
      expect(() => new BoundedMap<string, number>(NaN, undefined)).toThrow(RangeError);
    });

    it('capacity=-1 抛 RangeError', () => {
      expect(() => new BoundedMap<string, number>(-1, undefined)).toThrow(RangeError);
    });
  });

  describe('FIFO 淘汰', () => {
    it('超容量时淘汰最旧条目', () => {
      const map = new BoundedMap<string, number>(3, undefined);
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3);
      map.set('d', 4); // 淘汰 'a'

      expect(map.size).toBe(3);
      expect(map.has('a')).toBe(false);
      expect(map.has('b')).toBe(true);
      expect(map.has('c')).toBe(true);
      expect(map.has('d')).toBe(true);
    });

    it('onEvict 回调在淘汰时被调用', () => {
      const evicted: Array<[string, number]> = [];
      const map = new BoundedMap<string, number>(2, (k, v) => {
        evicted.push([k, v]);
      });

      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3); // 淘汰 'a'

      expect(evicted).toEqual([['a', 1]]);
    });
  });

  describe('更新已存在 key 不触发淘汰', () => {
    it('set 已存在 key 只更新值，不改变插入顺序，不淘汰', () => {
      const evicted: Array<[string, number]> = [];
      const map = new BoundedMap<string, number>(3, (k, v) => {
        evicted.push([k, v]);
      });

      map.set('a', 1);
      map.set('b', 2);
      map.set('a', 10); // 更新 'a'，不淘汰

      expect(map.size).toBe(2);
      expect(map.get('a')).toBe(10);
      expect(evicted).toHaveLength(0);

      // 验证 'a' 仍在最旧位置（插入顺序未刷新）
      map.set('c', 3);
      map.set('d', 4); // 应淘汰 'a'（最旧）
      expect(evicted).toEqual([['a', 10]]);
    });
  });

  describe('F8-20: LruCache 非法/分数容量拒绝', () => {
    it('分数容量 (0,1) 抛 RangeError（修复前无校验：0.5 时容量形同 1，静默退化）', () => {
      expect(() => new LruCache<string, string>(0.5, 1000)).toThrow(RangeError);
    });

    it('NaN 容量抛 RangeError（修复前无校验：NaN 比较恒 false → 永不淘汰 → 无限增长）', () => {
      expect(() => new LruCache<string, string>(NaN, 1000)).toThrow(RangeError);
    });

    it('负数容量抛 RangeError', () => {
      expect(() => new LruCache<string, string>(-1, 1000)).toThrow(RangeError);
    });
  });
});
