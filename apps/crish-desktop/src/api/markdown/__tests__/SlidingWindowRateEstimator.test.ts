import { describe, it, expect, beforeEach } from 'vitest';
import { SlidingWindowRateEstimator } from '../SlidingWindowRateEstimator';
import { AdaptiveAnimateTimeline } from '../AdaptiveAnimateTimeline';

describe('SlidingWindowRateEstimator (SW-TRE) 单元测试矩阵', () => {
  let estimator: SlidingWindowRateEstimator;

  beforeEach(() => {
    estimator = new SlidingWindowRateEstimator(500);
  });

  it('TC-TRE-01: 5 t/s 极低速输入判定为 CRAWL 档位，首字 baseDelay 恒为 0 (零滞后打字机)', () => {
    let now = 1000;
    // 推入 3 个以上样本以脱离冷启动守卫 (5 t/s ≈ 19 chars/s => 每 200ms 约 3.8 字符)
    for (let i = 0; i < 5; i++) {
      now += 200;
      estimator.push(4, now);
    }
    const snap = estimator.push(4, now + 200);
    expect(snap.tier).toBe('CRAWL');
    expect(snap.allowWordSpans).toBe(true);
    expect(snap.staggerStepMs).toBe(40);
    expect(snap.animationDurationMs).toBe(120);

    const timeline = new AdaptiveAnimateTimeline({ now: () => now });
    timeline.beginPass(now);
    const slot = timeline.take(1, snap.staggerStepMs, snap.animationDurationMs, snap.allowWordSpans, now);
    expect(slot.baseDelay).toBe(0);
    expect(slot.allowAnimation).toBe(true);
  });

  it('TC-TRE-02: 60 t/s 常态输入判定为 NORMAL 档位，步长压缩在 320ms 软预算内', () => {
    let now = 1000;
    // 60 t/s ≈ 228 chars/s => 每 16ms 约 3.65 字符 (取 4 chars)
    for (let i = 0; i < 20; i++) {
      now += 16;
      estimator.push(4, now);
    }
    const snap = estimator.push(4, now + 16);
    expect(snap.tier).toBe('NORMAL');
    expect(snap.allowWordSpans).toBe(true);
    expect(snap.animationDurationMs).toBe(100);
    expect(snap.staggerStepMs).toBeGreaterThanOrEqual(4);

    const timeline = new AdaptiveAnimateTimeline({ maxBacklogMs: 320, now: () => now });
    timeline.beginPass(now);
    const slot = timeline.take(20, snap.staggerStepMs, snap.animationDurationMs, snap.allowWordSpans, now);
    expect(slot.baseDelay).toBe(0);
    expect(slot.step).toBeGreaterThanOrEqual(4);
  });

  it('TC-TRE-03: ≥300 t/s 极端突发自动切入 TURBO 档位且禁止 Word Span (0 DOM 膨胀)', () => {
    let now = 1000;
    // 样本 1、2 (冷启动)
    estimator.push(10, now);
    now += 16;
    estimator.push(10, now);
    now += 16;
    // 样本 3: 极大流量输入 (1200 字符在 16ms 内 => 75,000 chars/s ≈ 19,736 tokens/s)
    const snap = estimator.push(1200, now);
    expect(snap.tier).toBe('TURBO');
    expect(snap.allowWordSpans).toBe(false);
    expect(snap.staggerStepMs).toBe(0);
    expect(snap.animationDurationMs).toBe(0);
  });

  it('TC-TRE-04: 速率剧烈阶跃震荡 (5 -> 2000 -> 10 t/s) 非对称 EMA 快速加速与平稳减速', () => {
    let now = 1000;
    // 阶段 1: 5 t/s
    estimator.push(4, now);
    now += 200;
    estimator.push(4, now);
    now += 200;
    estimator.push(4, now);

    // 阶段 2: 突发加速 (2000 t/s)
    now += 16;
    const fastSnap = estimator.push(800, now);
    expect(fastSnap.tier).toBe('TURBO');
    expect(fastSnap.smoothedRate).toBeGreaterThan(1000);

    // 阶段 3: 减速 (10 t/s)，平滑衰减
    now += 100;
    estimator.push(4, now);
    now += 100;
    const slowSnap = estimator.push(4, now);
    expect(slowSnap.smoothedRate).toBeLessThan(fastSnap.smoothedRate);
  });

  it('TC-TRE-07: 冷启动保护：前 2 个样本强制保持 NORMAL 档位，忽略初速度波动', () => {
    const snap1 = estimator.push(1000, 1000);
    expect(snap1.tier).toBe('NORMAL');
    expect(snap1.allowWordSpans).toBe(true);

    const snap2 = estimator.push(1000, 1016);
    expect(snap2.tier).toBe('NORMAL');
    expect(snap2.allowWordSpans).toBe(true);

    // 第 3 个样本才正式派发真实计算档位
    const snap3 = estimator.push(1000, 1032);
    expect(snap3.tier).toBe('TURBO');
  });

  it('防御性测试: 零除数防御 (同一微秒内连续推送)', () => {
    const now = 1000;
    const snap1 = estimator.push(10, now);
    const snap2 = estimator.push(20, now);
    const snap3 = estimator.push(30, now);

    expect(Number.isFinite(snap3.instantRate)).toBe(true);
    expect(Number.isFinite(snap3.smoothedRate)).toBe(true);
    expect(Number.isFinite(snap3.tokenRate)).toBe(true);
  });

  it('维持滑动窗口大小: 超过 500ms 的过期样本被正确剔除', () => {
    let now = 1000;
    estimator.push(100, now);
    now += 100;
    estimator.push(100, now);
    now += 100;
    estimator.push(100, now);

    // 此时窗口跨度 200ms
    const snapBefore = estimator.getSnapshot();
    expect(snapBefore.smoothedRate).toBeGreaterThan(0);

    // 跳跃 600ms，之前样本全过期
    now += 600;
    const snapAfter = estimator.push(10, now);
    // 样本数少于 3 个，冷启动触发
    expect(snapAfter.tier).toBe('NORMAL');
  });

  it('FAST 档位正确判定 (100 ~ 300 t/s)', () => {
    let now = 1000;
    // 200 t/s ≈ 760 chars/s => 每 50ms 约 38 chars
    for (let i = 0; i < 5; i++) {
      now += 50;
      estimator.push(38, now);
    }
    const snap = estimator.push(38, now + 50);
    expect(snap.tier).toBe('FAST');
    expect(snap.allowWordSpans).toBe(true);
    expect(snap.animationDurationMs).toBe(60);
    expect(snap.staggerStepMs).toBeGreaterThanOrEqual(2);
  });

  it('reset() 正确重置所有内部状态', () => {
    estimator.push(100, 1000);
    estimator.push(100, 1016);
    estimator.push(100, 1032);
    expect(estimator.getSnapshot().smoothedRate).toBeGreaterThan(0);

    estimator.reset();
    const snap = estimator.getSnapshot();
    expect(snap.smoothedRate).toBe(0);
    expect(snap.tokenRate).toBe(0);
    expect(snap.tier).toBe('NORMAL');
  });
});
