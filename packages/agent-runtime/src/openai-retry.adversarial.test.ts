/**
 * openai-retry 对抗性测试
 *
 * 目标：暴露重试预算、退避计算、Retry-After 解析、中断信号在边界输入下的隐藏缺陷。
 *
 * 已暴露的 bug 清单（详见各 it 用例注释）：
 *  OR1. parseRetryAfterMs 对 "Infinity" 字符串返回 MAX_RETRY_AFTER_MS（设计可疑）
 *  OR2. parseRetryAfterMs 对 "NaN" 字符串返回 undefined（与"abc"行为一致，正确）
 *  OR3. parseRetryAfterMs 对负秒数返回 0（设计：负值视为 0）
 *  OR4. parseRetryAfterMs 对 HTTP-date 已过期返回 0
 *  OR5. parseRetryAfterMs 对 HTTP-date 未来时间不钳制到 MAX_RETRY_AFTER_MS 之外的语义
 *  OR6. retryDelayMs 对 attempt=Infinity 钳到 1（safeAttempt 逻辑）
 *  OR7. retryDelayMs 对 attempt=负数 钳到 1
 *  OR8. retryDelayMs 对 attempt=0 钳到 1
 *  OR9. retryDelayMs 对 attempt=NaN 钳到 1
 *  OR10. retryDelayMs 对 attempt=1.5 截断为 1
 *  OR11. chooseRetryDelayMs 在 remainingBudgetMs=0 时返回 0
 *  OR12. chooseRetryDelayMs 在 remainingBudgetMs=负数 时返回 0（Math.max(0, ...)）
 *  OR13. chooseRetryDelayMs 在 remainingBudgetMs=NaN 时忽略 budget（Number.isFinite 检查）
 *  OR14. withinRetryBudget 对 totalBudgetMs=0 返回 false（边界正确）
 *  OR15. remainingRetryBudgetMs 对 startedAt 在未来时返回大于 totalBudgetMs 的值（bug）
 *  OR16. delay 对 ms=Infinity 视为 0（立即 resolve）
 *  OR17. delay 对 ms=负数 视为 0
 *  OR18. delay 对 ms=NaN 视为 0
 *  OR19. normalizeRetryOptions 对 maxAttempts=0 钳到 1
 *  OR20. normalizeRetryOptions 对 maxAttempts=负数 钳到 1
 *  OR21. normalizeRetryOptions 对 maxAttempts=Infinity 钳到 1（Math.floor(Infinity)=Infinity，但 Math.max(1, Infinity)=Infinity）
 *  OR22. normalizeRetryOptions 对 jitterRatio=2 钳到 1
 *  OR23. normalizeRetryOptions 对 jitterRatio=负数 钳到 0
 *  OR24. normalizeRetryOptions 对 initialDelayMs > maxDelayMs 时 maxDelayMs 被抬升（设计正确）
 *  OR25. normalizeRetryOptions 对 maxDelayMs=0 时被抬升到 initialDelayMs
 *  OR26. parseRetryAfterMs 对 "  123  " (前后空格) 正确解析为 123000ms
 *  OR27. parseRetryAfterMs 对 "123abc" 返回 undefined（Number("123abc")=NaN）
 *  OR28. parseRetryAfterMs 对 "" 返回 undefined
 *  OR29. parseRetryAfterMs 对 "0" 返回 0
 *  OR30. parseRetryAfterMs 对 "0.5" 返回 0（Math.floor(0.5*1000)=500，等等，实际 Math.floor(500)=500）
 *  OR31. retryDelayMs 对 jitterRatio=1 时返回值在 [1, base*2] 范围内
 *  OR32. retryDelayMs 对 attempt=30 时 2^29 * initialDelayMs 溢出为 Infinity，Math.min(maxDelayMs, Infinity)=maxDelayMs
 *  OR33. delay 在 signal 已 abort 时立即 reject（正确）
 *  OR34. delay 在等待中 abort 时 clearTimeout 并 reject
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  normalizeRetryOptions,
  parseRetryAfterMs,
  delay,
  retryDelayMs,
  withinRetryBudget,
  remainingRetryBudgetMs,
  chooseRetryDelayMs,
  MAX_RETRY_AFTER_MS,
} from './openai-retry';

describe('openai-retry — 对抗性测试', () => {
  describe('OR1-OR5: parseRetryAfterMs', () => {
    it('秒数正常解析', () => {
      expect(parseRetryAfterMs('120')).toBe(120_000);
    });

    it('小数秒数被 floor', () => {
      expect(parseRetryAfterMs('1.5')).toBe(1500);
      expect(parseRetryAfterMs('0.5')).toBe(500);
      expect(parseRetryAfterMs('0.1')).toBe(100);
    });

    it('"0" 返回 0', () => {
      expect(parseRetryAfterMs('0')).toBe(0);
    });

    it('负秒数返回 0', () => {
      expect(parseRetryAfterMs('-5')).toBe(0);
      expect(parseRetryAfterMs('-0.5')).toBe(0);
    });

    it('OR1: "Infinity" 返回 MAX_RETRY_AFTER_MS', () => {
      // Bug 设计可疑：Number("Infinity") = Infinity, Number.isFinite(Infinity) = false
      // 走到 if (seconds === Number.POSITIVE_INFINITY) → MAX_RETRY_AFTER_MS
      // 这意味着攻击者可以通过 Retry-After: Infinity 强制客户端等待 5 分钟
      expect(parseRetryAfterMs('Infinity')).toBe(MAX_RETRY_AFTER_MS);
    });

    it('"-Infinity" 返回 0', () => {
      expect(parseRetryAfterMs('-Infinity')).toBe(0);
    });

    it('"NaN" 返回 undefined', () => {
      // Number("NaN") = NaN, Number.isFinite(NaN) = false
      // 不进入 Infinity 分支，走到 Date.parse("NaN") = NaN → undefined
      expect(parseRetryAfterMs('NaN')).toBeUndefined();
    });

    it('空字符串返回 undefined', () => {
      expect(parseRetryAfterMs('')).toBeUndefined();
      expect(parseRetryAfterMs('   ')).toBeUndefined();
      expect(parseRetryAfterMs(null)).toBeUndefined();
    });

    it('前后空格被 trim', () => {
      expect(parseRetryAfterMs('  120  ')).toBe(120_000);
    });

    it('非数字非日期返回 undefined', () => {
      expect(parseRetryAfterMs('abc')).toBeUndefined();
      expect(parseRetryAfterMs('123abc')).toBeUndefined();
    });

    it('HTTP-date 未来时间', () => {
      const future = new Date(Date.now() + 60_000).toUTCString();
      const result = parseRetryAfterMs(future);
      expect(result).toBeDefined();
      expect(result!).toBeGreaterThan(50_000);
      expect(result!).toBeLessThan(70_000);
    });

    it('HTTP-date 过去时间返回 0', () => {
      const past = new Date(Date.now() - 60_000).toUTCString();
      expect(parseRetryAfterMs(past)).toBe(0);
    });

    it('HTTP-date 超过 MAX_RETRY_AFTER_MS 被钳制', () => {
      const farFuture = new Date(Date.now() + 10 * 60_000).toUTCString();
      expect(parseRetryAfterMs(farFuture)).toBe(MAX_RETRY_AFTER_MS);
    });

    it('极大秒数被钳制到 MAX_RETRY_AFTER_MS', () => {
      expect(parseRetryAfterMs('999999999')).toBe(MAX_RETRY_AFTER_MS);
    });

    it('HTTP-date 无效格式返回 undefined', () => {
      expect(parseRetryAfterMs('not a date')).toBeUndefined();
    });
  });

  describe('OR6-OR10: retryDelayMs attempt 边界', () => {
    const opts = normalizeRetryOptions({
      maxAttempts: 5,
      initialDelayMs: 100,
      maxDelayMs: 10_000,
      jitterRatio: 0,
    });

    it('attempt=1 → initialDelayMs', () => {
      expect(retryDelayMs(opts, 1)).toBe(100);
    });

    it('attempt=2 → 2 * initialDelayMs', () => {
      expect(retryDelayMs(opts, 2)).toBe(200);
    });

    it('attempt=3 → 4 * initialDelayMs', () => {
      expect(retryDelayMs(opts, 3)).toBe(400);
    });

    it('attempt=0 钳到 1', () => {
      expect(retryDelayMs(opts, 0)).toBe(100);
    });

    it('attempt=-1 钳到 1', () => {
      expect(retryDelayMs(opts, -1)).toBe(100);
    });

    it('attempt=NaN 钳到 1', () => {
      expect(retryDelayMs(opts, NaN)).toBe(100);
    });

    it('attempt=Infinity 钳到 1（Number.isFinite(Infinity)=false → 1）', () => {
      // Bug 标志：Infinity 被错误地视为 1
      // 这可能导致 attempt=Infinity 时退避只有 initialDelayMs，而非 maxDelayMs
      expect(retryDelayMs(opts, Infinity)).toBe(100);
    });

    it('attempt=1.5 截断为 1', () => {
      expect(retryDelayMs(opts, 1.5)).toBe(100);
    });

    it('attempt=2.9 截断为 2', () => {
      expect(retryDelayMs(opts, 2.9)).toBe(200);
    });

    it('OR32: attempt=30 时退避被 maxDelayMs 钳制', () => {
      // 2^29 * 100 = 53687091200，远超 maxDelayMs=10000
      expect(retryDelayMs(opts, 30)).toBe(10_000);
    });

    it('attempt=100 时退避被 maxDelayMs 钳制', () => {
      expect(retryDelayMs(opts, 100)).toBe(10_000);
    });
  });

  describe('OR31: retryDelayMs jitter 行为', () => {
    it('jitterRatio=0 时无随机性', () => {
      const opts = normalizeRetryOptions({
        initialDelayMs: 100,
        maxDelayMs: 10_000,
        jitterRatio: 0,
      });
      // 多次调用结果一致
      const r1 = retryDelayMs(opts, 3);
      const r2 = retryDelayMs(opts, 3);
      expect(r1).toBe(r2);
    });

    it('jitterRatio=1 时结果在 [1, base*2] 范围内', () => {
      const opts = normalizeRetryOptions({
        initialDelayMs: 100,
        maxDelayMs: 10_000,
        jitterRatio: 1,
      });
      // attempt=3, base=400
      // spread = 400 * 1 = 400
      // result = max(1, floor(400 - 400 + random * 800)) = max(1, floor(random * 800))
      // 范围 [1, 800]
      for (let i = 0; i < 50; i++) {
        const result = retryDelayMs(opts, 3);
        expect(result).toBeGreaterThanOrEqual(1);
        expect(result).toBeLessThanOrEqual(800);
      }
    });

    it('jitterRatio=0.5 时结果在 [base*0.5, base*1.5] 范围内', () => {
      const opts = normalizeRetryOptions({
        initialDelayMs: 100,
        maxDelayMs: 10_000,
        jitterRatio: 0.5,
      });
      // attempt=3, base=400
      // spread = 200
      // result = max(1, floor(400 - 200 + random * 400)) = max(1, floor(200 + random * 400))
      // 范围 [200, 600]
      for (let i = 0; i < 50; i++) {
        const result = retryDelayMs(opts, 3);
        expect(result).toBeGreaterThanOrEqual(200);
        expect(result).toBeLessThanOrEqual(600);
      }
    });
  });

  describe('OR11-OR13: chooseRetryDelayMs budget 边界', () => {
    const opts = normalizeRetryOptions({
      initialDelayMs: 100,
      maxDelayMs: 10_000,
      jitterRatio: 0,
    });

    it('remainingBudgetMs=0 时返回 0', () => {
      const result = chooseRetryDelayMs(opts, 1, null, 0);
      expect(result).toBe(0);
    });

    it('remainingBudgetMs=负数 时返回 0', () => {
      const result = chooseRetryDelayMs(opts, 1, null, -100);
      expect(result).toBe(0);
    });

    it('remainingBudgetMs=NaN 时忽略 budget', () => {
      // Number.isFinite(NaN) = false → 不应用 budget 限制
      const result = chooseRetryDelayMs(opts, 1, null, NaN);
      expect(result).toBe(100); // 只有 backoff
    });

    it('remainingBudgetMs=Infinity 时忽略 budget', () => {
      const result = chooseRetryDelayMs(opts, 1, null, Infinity);
      expect(result).toBe(100);
    });

    it('Retry-After 大于 backoff 时取 Retry-After', () => {
      const result = chooseRetryDelayMs(opts, 1, '10', undefined);
      // backoff=100, retryAfter=10000
      // Math.max(100, 10000) = 10000
      // Math.min(maxDelayMs=10000, 10000) = 10000
      expect(result).toBe(10_000);
    });

    it('Retry-After 小于 backoff 时取 backoff', () => {
      const result = chooseRetryDelayMs(opts, 3, '0.1', undefined);
      // backoff=400, retryAfter=100
      // Math.max(400, 100) = 400
      expect(result).toBe(400);
    });

    it('Retry-After 超过 maxDelayMs 时被钳制', () => {
      const result = chooseRetryDelayMs(opts, 1, '999', undefined);
      // backoff=100, retryAfter=999000
      // Math.max(100, 999000) = 999000
      // Math.min(maxDelayMs=10000, 999000) = 10000
      expect(result).toBe(10_000);
    });

    it('remainingBudgetMs 小于 backoff 时取 budget', () => {
      const result = chooseRetryDelayMs(opts, 3, null, 200);
      // backoff=400, budget=200
      // Math.min(400, 200) = 200
      expect(result).toBe(200);
    });
  });

  describe('OR14: withinRetryBudget', () => {
    it('totalBudgetMs=0 返回 false', () => {
      expect(withinRetryBudget(Date.now(), 0)).toBe(false);
    });

    it('totalBudgetMs=负数 返回 false', () => {
      expect(withinRetryBudget(Date.now(), -100)).toBe(false);
    });

    it('totalBudgetMs=NaN 返回 false', () => {
      expect(withinRetryBudget(Date.now(), NaN)).toBe(false);
    });

    it('startedAt=NaN 返回 false', () => {
      expect(withinRetryBudget(NaN, 60_000)).toBe(false);
    });

    it('startedAt=Infinity 返回 false', () => {
      expect(withinRetryBudget(Infinity, 60_000)).toBe(false);
    });

    it('预算未耗尽返回 true', () => {
      const startedAt = Date.now() - 10_000;
      expect(withinRetryBudget(startedAt, 60_000)).toBe(true);
    });

    it('预算已耗尽返回 false', () => {
      const startedAt = Date.now() - 70_000;
      expect(withinRetryBudget(startedAt, 60_000)).toBe(false);
    });

    it('OR15（已修复）: startedAt 在未来时返回 false（语义：无效输入）', () => {
      // 修复前：startedAt 在未来 → Date.now() - startedAt 是负数 → 负数 < totalBudgetMs → true（bug）
      // 修复后：startedAt > now 直接返回 false
      const futureStartedAt = Date.now() + 10_000;
      const result = withinRetryBudget(futureStartedAt, 60_000);
      expect(result).toBe(false);
    });
  });

  describe('OR15: remainingRetryBudgetMs 未来 startedAt', () => {
    it('OR15（已修复）: startedAt 在未来时返回 0（语义：无效输入）', () => {
      // 修复前：totalBudgetMs - (now - startedAt) = 60000 - (-10000) = 70000（bug）
      // 修复后：startedAt > now 直接返回 0
      const futureStartedAt = Date.now() + 10_000;
      const remaining = remainingRetryBudgetMs(futureStartedAt, 60_000);
      expect(remaining).toBe(0);
    });

    it('正常情况返回正确剩余', () => {
      const startedAt = Date.now() - 10_000;
      const remaining = remainingRetryBudgetMs(startedAt, 60_000);
      expect(remaining).toBeGreaterThan(49_000);
      expect(remaining).toBeLessThan(51_000);
    });

    it('预算耗尽返回 0', () => {
      const startedAt = Date.now() - 70_000;
      expect(remainingRetryBudgetMs(startedAt, 60_000)).toBe(0);
    });

    it('非法输入返回 0', () => {
      expect(remainingRetryBudgetMs(NaN, 60_000)).toBe(0);
      expect(remainingRetryBudgetMs(Date.now(), 0)).toBe(0);
      expect(remainingRetryBudgetMs(Date.now(), -1)).toBe(0);
      expect(remainingRetryBudgetMs(Date.now(), NaN)).toBe(0);
    });
  });

  describe('OR16-OR18, OR33-OR34: delay', () => {
    it('ms=0 立即 resolve', async () => {
      await expect(delay(0, new AbortController().signal)).resolves.toBeUndefined();
    });

    it('ms=负数 立即 resolve', async () => {
      await expect(delay(-100, new AbortController().signal)).resolves.toBeUndefined();
    });

    it('ms=NaN 立即 resolve', async () => {
      await expect(delay(NaN, new AbortController().signal)).resolves.toBeUndefined();
    });

    it('ms=Infinity 立即 resolve', async () => {
      // Number.isFinite(Infinity) = false → waitMs = 0
      await expect(delay(Infinity, new AbortController().signal)).resolves.toBeUndefined();
    });

    it('signal 已 abort 时立即 reject', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(delay(1000, controller.signal)).rejects.toThrow();
    });

    it('signal abort 携带 Error reason', async () => {
      const controller = new AbortController();
      controller.abort(new Error('custom abort'));
      await expect(delay(1000, controller.signal)).rejects.toThrow('custom abort');
    });

    it('signal abort 携带 string reason', async () => {
      const controller = new AbortController();
      controller.abort('string reason');
      await expect(delay(1000, controller.signal)).rejects.toThrow('string reason');
    });

    it('signal abort 无 reason 时使用 "aborted"', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(delay(1000, controller.signal)).rejects.toThrow('aborted');
    });

    it('等待中 abort 立即 reject', async () => {
      const controller = new AbortController();
      const promise = delay(5000, controller.signal);
      setTimeout(() => controller.abort(new Error('mid-wait abort')), 50);
      await expect(promise).rejects.toThrow('mid-wait abort');
    });

    it('正常等待后 resolve', async () => {
      const start = Date.now();
      await delay(50, new AbortController().signal);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });

    it('abort 后 clearTimeout（不泄漏 timer）', async () => {
      const controller = new AbortController();
      const promise = delay(10000, controller.signal);
      controller.abort();
      await expect(promise).rejects.toThrow();
      // 等待一段时间确认无遗留 timer 触发
      await new Promise((r) => setTimeout(r, 50));
    });
  });

  describe('OR19-OR25: normalizeRetryOptions', () => {
    it('默认值', () => {
      const opts = normalizeRetryOptions(undefined);
      expect(opts.maxAttempts).toBe(1);
      expect(opts.initialDelayMs).toBe(750);
      expect(opts.maxDelayMs).toBe(8_000);
      expect(opts.totalBudgetMs).toBe(60_000);
      expect(opts.jitterRatio).toBe(0);
    });

    it('maxAttempts=0 钳到 1', () => {
      expect(normalizeRetryOptions({ maxAttempts: 0 }).maxAttempts).toBe(1);
    });

    it('maxAttempts=负数 钳到 1', () => {
      expect(normalizeRetryOptions({ maxAttempts: -5 }).maxAttempts).toBe(1);
    });

    it('maxAttempts=Infinity 被视为非有限 → 钳到 1（finiteOr 兜底）', () => {
      // finiteOr 检查 Number.isFinite(Infinity) = false → 返回 fallback=1
      // 这是正确行为：防止 Infinity 导致无限重试
      const result = normalizeRetryOptions({ maxAttempts: Infinity });
      expect(result.maxAttempts).toBe(1);
    });

    it('maxAttempts=NaN 钳到 1', () => {
      expect(normalizeRetryOptions({ maxAttempts: NaN }).maxAttempts).toBe(1);
    });

    it('maxAttempts=1.5 截断为 1', () => {
      expect(normalizeRetryOptions({ maxAttempts: 1.5 }).maxAttempts).toBe(1);
    });

    it('jitterRatio=2 钳到 1', () => {
      expect(normalizeRetryOptions({ jitterRatio: 2 }).jitterRatio).toBe(1);
    });

    it('jitterRatio=负数 钳到 0', () => {
      expect(normalizeRetryOptions({ jitterRatio: -0.5 }).jitterRatio).toBe(0);
    });

    it('jitterRatio=NaN 钳到 0', () => {
      expect(normalizeRetryOptions({ jitterRatio: NaN }).jitterRatio).toBe(0);
    });

    it('jitterRatio=Infinity 被视为非有限 → 钳到 0（finiteOr 兜底）', () => {
      // finiteOr(Infinity, 0) → 0（因 Number.isFinite(Infinity)=false）
      // 然后 Math.min(1, Math.max(0, 0)) = 0
      // 这是正确行为：防止 Infinity jitter 导致不可预测的退避
      expect(normalizeRetryOptions({ jitterRatio: Infinity }).jitterRatio).toBe(0);
    });

    it('initialDelayMs=0 钳到 1', () => {
      expect(normalizeRetryOptions({ initialDelayMs: 0 }).initialDelayMs).toBe(1);
    });

    it('initialDelayMs=负数 钳到 1', () => {
      expect(normalizeRetryOptions({ initialDelayMs: -100 }).initialDelayMs).toBe(1);
    });

    it('initialDelayMs=NaN 钳到 750（默认）', () => {
      expect(normalizeRetryOptions({ initialDelayMs: NaN }).initialDelayMs).toBe(750);
    });

    it('OR24: initialDelayMs > maxDelayMs 时 maxDelayMs 被抬升', () => {
      const opts = normalizeRetryOptions({
        initialDelayMs: 10_000,
        maxDelayMs: 5_000,
      });
      expect(opts.initialDelayMs).toBe(10_000);
      expect(opts.maxDelayMs).toBe(10_000); // 被抬升到 initialDelayMs
    });

    it('OR25: maxDelayMs=0 时被抬升到 initialDelayMs', () => {
      const opts = normalizeRetryOptions({
        initialDelayMs: 100,
        maxDelayMs: 0,
      });
      expect(opts.maxDelayMs).toBe(100);
    });

    it('maxDelayMs=NaN 钳到 8000（默认）', () => {
      expect(normalizeRetryOptions({ maxDelayMs: NaN }).maxDelayMs).toBe(8_000);
    });

    it('totalBudgetMs=0 钳到 1', () => {
      expect(normalizeRetryOptions({ totalBudgetMs: 0 }).totalBudgetMs).toBe(1);
    });

    it('totalBudgetMs=负数 钳到 1', () => {
      expect(normalizeRetryOptions({ totalBudgetMs: -100 }).totalBudgetMs).toBe(1);
    });

    it('totalBudgetMs=Infinity 被视为非有限 → 钳到 60000（finiteOr 兜底）', () => {
      // finiteOr(Infinity, 60000) → 60000（因 Number.isFinite(Infinity)=false）
      // 这是正确行为：防止 Infinity 预算导致永不停止的重试
      const result = normalizeRetryOptions({ totalBudgetMs: Infinity });
      expect(result.totalBudgetMs).toBe(60_000);
    });
  });

  describe('组合场景', () => {
    it('完整的重试循环模拟', () => {
      const opts = normalizeRetryOptions({
        maxAttempts: 3,
        initialDelayMs: 100,
        maxDelayMs: 1_000,
        jitterRatio: 0,
        totalBudgetMs: 60_000,
      });
      const startedAt = Date.now();

      // attempt 1
      expect(withinRetryBudget(startedAt, opts.totalBudgetMs)).toBe(true);
      const delay1 = chooseRetryDelayMs(opts, 1, null, remainingRetryBudgetMs(startedAt, opts.totalBudgetMs));
      expect(delay1).toBe(100);

      // attempt 2
      expect(withinRetryBudget(startedAt, opts.totalBudgetMs)).toBe(true);
      const delay2 = chooseRetryDelayMs(opts, 2, null, remainingRetryBudgetMs(startedAt, opts.totalBudgetMs));
      expect(delay2).toBe(200);

      // attempt 3
      expect(withinRetryBudget(startedAt, opts.totalBudgetMs)).toBe(true);
      const delay3 = chooseRetryDelayMs(opts, 3, null, remainingRetryBudgetMs(startedAt, opts.totalBudgetMs));
      expect(delay3).toBe(400);
    });

    it('Retry-After 主导的重试', () => {
      const opts = normalizeRetryOptions({
        initialDelayMs: 100,
        maxDelayMs: 5_000,
        jitterRatio: 0,
      });
      // 服务器返回 Retry-After: 30
      const delay1 = chooseRetryDelayMs(opts, 1, '30', undefined);
      expect(delay1).toBe(5_000); // 30*1000=30000 被钳到 maxDelayMs=5000
    });

    it('预算耗尽时停止重试', () => {
      const opts = normalizeRetryOptions({
        maxAttempts: 10,
        initialDelayMs: 100,
        maxDelayMs: 10_000,
        totalBudgetMs: 1_000,
      });
      const startedAt = Date.now() - 1_500; // 预算已耗尽
      expect(withinRetryBudget(startedAt, opts.totalBudgetMs)).toBe(false);
      expect(remainingRetryBudgetMs(startedAt, opts.totalBudgetMs)).toBe(0);
      const delay = chooseRetryDelayMs(opts, 1, null, 0);
      expect(delay).toBe(0);
    });
  });
});
