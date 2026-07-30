/**
 * retry (retryWithBackoff / calculateBackoff) 对抗性测试
 *
 * 已暴露的 bug 清单：
 *  R1. 【误报已排除】jitterFactor 未传入时 calculateBackoff 的默认参数 0.2 生效，无 NaN
 *      但 retryWithBackoff 中 const jitterFactor = options.jitterFactor 读取为 undefined，
 *      依赖 calculateBackoff 的默认参数兜底——如果 calculateBackoff 签名变更去掉默认值就会触发
 *  R2. maxAttempts=0 → throw undefined（非 Error 对象）
 *  R3. calculateBackoff 的 jitter 可使 delay 超过 maxMs（乘性 jitter 突破上限）
 *  R4. shouldRetry 抛异常时，错误不是 lastError 而是 shouldRetry 的错误
 *  R5. calculateBackoff 负数 attempt 产生 < baseMs 的 delay（语义模糊）
 *  R6. retryWithBackoff 不传 options 时使用 baseMs=200，但 calculateBackoff 默认 baseMs=1000（默认值不一致）
 *  R7. jitterFactor 为负数时 jitter < 1，delay 小于 exponential（反向退避）
 *  R8. jitterFactor 为极大值时 delay 远超 maxMs
 */

import { describe, it, expect } from 'vitest';
import { calculateBackoff, retryWithBackoff } from './retry';

describe('retry — 对抗性测试', () => {
  describe('R1: jitterFactor 未传入时的行为验证', () => {
    it('验证: jitterFactor 未传入时 calculateBackoff 默认参数 0.2 生效（不产生 NaN）', () => {
      // calculateBackoff 签名: jitterFactor: number = 0.2
      // JS 默认参数: 显式传入 undefined 时使用默认值
      // 所以 calculateBackoff(0, 1000, 5000, undefined) 等价于 calculateBackoff(0, 1000, 5000, 0.2)

      const delay = calculateBackoff(0, 1000, 5000, undefined);
      expect(Number.isNaN(delay)).toBe(false);
      expect(delay).toBeGreaterThanOrEqual(1000); // baseMs * 2^0 * 1 = 1000
      expect(delay).toBeLessThanOrEqual(1200); // baseMs * 2^0 * 1.2 = 1200
    });

    it('验证: retryWithBackoff 不传 jitterFactor 时退避正常工作', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        throw new Error('fail');
      };

      const start = Date.now();
      await expect(
        retryWithBackoff(fn, { maxAttempts: 3, baseMs: 50, maxMs: 500 })
      ).rejects.toThrow('fail');
      const elapsed = Date.now() - start;

      expect(attempts).toBe(3);
      // 有实际延迟（jitterFactor 默认 0.2 生效）
      expect(elapsed).toBeGreaterThanOrEqual(50);
    });

    it('暴露隐患: jitterFactor=null 时不触发默认参数，jitter 被禁用', () => {
      // null 不是 undefined，不会触发默认参数
      // Math.random() * null = Math.random() * 0 = 0
      // jitter = 1 + 0 = 1，delay = exponential（无 jitter）
      const delay = calculateBackoff(0, 1000, 5000, null as unknown as number);
      expect(delay).toBe(1000); // 精确 1000，无 jitter 随机性
    });
  });

  describe('R2: maxAttempts=0 → throw undefined', () => {
    it('暴露 bug: maxAttempts=0 时 throw undefined（非 Error 对象）', async () => {
      const fn = async () => {
        throw new Error('real error');
      };

      // Bug: for 循环不执行，lastError 是 undefined
      // throw undefined 而非 throw new Error('real error')
      try {
        await retryWithBackoff(fn, { maxAttempts: 0 });
        expect.unreachable('应该抛异常');
      } catch (e) {
        // Bug: 抛出的是 undefined，不是 Error
        expect(e).toBeUndefined();
      }
    });

    it('暴露 bug: maxAttempts 为负数时同样 throw undefined', async () => {
      const fn = async () => {
        throw new Error('real error');
      };

      try {
        await retryWithBackoff(fn, { maxAttempts: -5 });
        expect.unreachable('应该抛异常');
      } catch (e) {
        expect(e).toBeUndefined();
      }
    });
  });

  describe('R3: jitter 可使 delay 超过 maxMs', () => {
    it('暴露 bug: exponential=maxMs 时，乘性 jitter 使 delay > maxMs', () => {
      // calculateBackoff: exponential = Math.min(maxMs, baseMs * 2^attempt)
      // 当 baseMs * 2^attempt >= maxMs 时，exponential = maxMs
      // jitter = 1 + Math.random() * jitterFactor
      // delay = Math.round(exponential * jitter) = Math.round(maxMs * (1 + ~0.2))
      // 所以 delay 可达 maxMs * 1.2

      const baseMs = 1000;
      const maxMs = 5000;
      const jitterFactor = 0.2;

      // attempt 足够大使 exponential 被 clamp 到 maxMs
      // baseMs * 2^10 = 1024000 > maxMs
      let maxObserved = 0;
      for (let i = 0; i < 1000; i++) {
        const delay = calculateBackoff(10, baseMs, maxMs, jitterFactor);
        if (delay > maxObserved) maxObserved = delay;
      }

      // Bug: maxObserved 应该 > maxMs（jitter 突破上限）
      expect(maxObserved).toBeGreaterThan(maxMs);
      // 理论上限: maxMs * 1.2 = 6000
      expect(maxObserved).toBeLessThanOrEqual(
        Math.ceil(maxMs * (1 + jitterFactor))
      );
    });
  });

  describe('R4: shouldRetry 抛异常时传播错误错误', () => {
    it('暴露 bug: shouldRetry 抛异常时，retryWithBackoff reject 的是 shouldRetry 的错误而非 lastError', async () => {
      const realError = new Error('real failure');
      const shouldRetryError = new Error('shouldRetry crashed');

      let attempts = 0;
      const fn = async () => {
        attempts++;
        throw realError;
      };

      const shouldRetry = () => {
        throw shouldRetryError;
      };

      try {
        await retryWithBackoff(fn, { maxAttempts: 5, shouldRetry });
        expect.unreachable('应该抛异常');
      } catch (e) {
        // Bug: 抛出的是 shouldRetryError 而非 realError
        // 因为 shouldRetry 在 catch 块中被调用，其抛出会传播出 catch
        expect(e).toBe(shouldRetryError);
        expect(e).not.toBe(realError);
      }

      // fn 只被调用一次（shouldRetry 在第一次失败后就抛异常）
      expect(attempts).toBe(1);
    });
  });

  describe('R5: 负数 attempt 产生 < baseMs 的 delay', () => {
    it('暴露 bug: attempt=-1 时 delay = baseMs * 0.5 * jitter（小于 baseMs）', () => {
      const baseMs = 1000;
      const delay = calculateBackoff(-1, baseMs, 30000, 0);

      // 2^(-1) = 0.5
      // exponential = min(30000, 1000 * 0.5) = 500
      // jitter = 1 + 0 = 1
      // delay = 500
      expect(delay).toBe(500);
      // Bug: 负数 attempt 不被拒绝，产生语义模糊的 delay
    });

    it('暴露 bug: attempt=-100 时 delay 接近 0', () => {
      const delay = calculateBackoff(-100, 1000, 30000, 0);
      // 2^(-100) ≈ 0，delay ≈ 0
      expect(delay).toBe(0);
    });
  });

  describe('R6: 默认值不一致', () => {
    it('暴露 bug: calculateBackoff 默认 baseMs=1000，但 retryWithBackoff 默认 baseMs=200', () => {
      // 直接调用 calculateBackoff 不传 baseMs
      const directDelay = calculateBackoff(0); // 使用默认 baseMs=1000
      // 通过 retryWithBackoff 调用，不传 baseMs
      // retryWithBackoff: const baseMs = options.baseMs ?? 200;
      // 然后: calculateBackoff(attempt - 1, baseMs, maxMs, jitterFactor)
      // 所以 baseMs=200

      // 两者使用不同的 baseMs，行为不一致
      // calculateBackoff(0, 1000, 30000, 0.2) vs calculateBackoff(0, 200, 1500, undefined)
      // 前者: 1000 * 1 * (1+random*0.2)
      // 后者: NaN（R1 bug）

      expect(directDelay).toBeGreaterThanOrEqual(1000); // 默认 baseMs=1000
      // retryWithBackoff 默认 baseMs=200 — 文档化不一致
    });
  });

  describe('R7: 负数 jitterFactor 产生反向退避', () => {
    it('暴露 bug: jitterFactor=-0.5 时 jitter < 1，delay 小于 exponential', () => {
      const baseMs = 1000;
      const maxMs = 30000;

      // jitterFactor=-0.5: jitter = 1 + random * (-0.5) → [0.5, 1.0]
      // delay = exponential * jitter → 小于 exponential
      let maxDelay = 0;
      let minDelay = Infinity;
      for (let i = 0; i < 1000; i++) {
        const delay = calculateBackoff(0, baseMs, maxMs, -0.5);
        if (delay > maxDelay) maxDelay = delay;
        if (delay < minDelay) minDelay = delay;
      }

      // exponential = 1000 * 2^0 = 1000
      // Bug: delay 可以小于 1000（反向退避）
      expect(minDelay).toBeLessThan(1000);
    });
  });

  describe('R8: 极大 jitterFactor 使 delay 远超 maxMs', () => {
    it('暴露 bug: jitterFactor=100 时 delay 可达 maxMs * 101', () => {
      const maxMs = 5000;
      const jitterFactor = 100;

      let maxObserved = 0;
      for (let i = 0; i < 1000; i++) {
        const delay = calculateBackoff(10, 1000, maxMs, jitterFactor);
        if (delay > maxObserved) maxObserved = delay;
      }

      // Bug: delay 可远超 maxMs
      // jitter = 1 + random * 100 → [1, 101]
      // delay = maxMs * jitter → 最多 maxMs * 101 = 505000
      expect(maxObserved).toBeGreaterThan(maxMs * 10);
    });
  });

  describe('基本功能验证（确保不是误报）', () => {
    it('成功时不重试', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
      };

      await retryWithBackoff(fn, { maxAttempts: 3 });
      expect(attempts).toBe(1);
    });

    it('失败后按 shouldRetry 决定是否重试', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 3) throw new Error('retryable');
      };

      const shouldRetry = (e: unknown) => {
        return e instanceof Error && e.message === 'retryable';
      };

      await retryWithBackoff(fn, {
        maxAttempts: 5,
        baseMs: 1,
        maxMs: 10,
        jitterFactor: 0,
        shouldRetry,
      });
      expect(attempts).toBe(3);
    });
  });
});
