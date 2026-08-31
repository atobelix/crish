import { describe, it, expect, beforeEach } from 'vitest';
import { AdaptiveAnimateTimeline } from '../AdaptiveAnimateTimeline';

describe('AdaptiveAnimateTimeline 单元测试矩阵', () => {
  let timeline: AdaptiveAnimateTimeline;
  let mockClock: number;

  beforeEach(() => {
    mockClock = 1000;
    timeline = new AdaptiveAnimateTimeline({
      maxBacklogMs: 320,
      minStaggerStepMs: 4,
      now: () => mockClock,
    });
  });

  it('TC-TRE-01: 单词极慢速到达时，baseDelay 恒为 0 (零滞后即来即显)', () => {
    timeline.beginPass(mockClock);
    const slot = timeline.take(1, 40, 120, true, mockClock);

    expect(slot.baseDelay).toBe(0);
    expect(slot.step).toBe(40);
    expect(slot.duration).toBe(120);
    expect(slot.allowAnimation).toBe(true);
  });

  it('TC-TRE-02: 批次词数较多时，自动压缩 step 以保证总交错不超出 320ms 软预算', () => {
    timeline.beginPass(mockClock);
    // 20 个词，理想步长 40ms => 理想跨度 19 * 40 = 760ms > 320ms 预算
    const slot = timeline.take(20, 40, 100, true, mockClock);

    expect(slot.baseDelay).toBe(0);
    // 压缩后的 step: 320 / 19 ≈ 16.84ms
    expect(slot.step).toBeLessThan(40);
    expect(slot.step).toBeGreaterThanOrEqual(4);
    // 最后一个词的实际延迟 = (20 - 1) * step <= 320ms
    expect(19 * slot.step).toBeLessThanOrEqual(320.01);
  });

  it('TC-TRE-05: StrictMode / 并发渲染下 mark 与 rewind 确保游标分配绝对幂等', () => {
    timeline.beginPass(mockClock);

    const mark = timeline.mark();
    const slot1 = timeline.take(5, 20, 100, true, mockClock);

    // 模拟 React StrictMode 双执行或并发重试
    timeline.rewind(mark);
    const slot2 = timeline.take(5, 20, 100, true, mockClock);

    expect(slot1.baseDelay).toBe(slot2.baseDelay);
    expect(slot1.step).toBe(slot2.step);
    expect(slot1.duration).toBe(slot2.duration);
    expect(slot1.allowAnimation).toBe(slot2.allowAnimation);
  });

  it('TC-TRE-06: beginPass 自动削峰历史超调债务，将跨帧滞后上限锁定在 320ms 内', () => {
    timeline.beginPass(mockClock);
    // 产生大量词 (200 词)，即使 minStep=4ms 也会超调到 800ms
    timeline.take(200, 4, 100, true, mockClock);
    timeline.commitPass();

    // 进入下一帧 (16ms 之后)
    mockClock += 16;
    timeline.beginPass(mockClock);
    const mark = timeline.mark();

    // 削峰保护：下一个 Pass 的起点不得超过 mockClock + 320ms
    expect(mark).toBeLessThanOrEqual(mockClock + 320);
  });

  it('挂钟时间推进后，若上一帧游标已落后于当前时间，游标自动重置为当前时间 (零滞后)', () => {
    timeline.beginPass(mockClock);
    timeline.take(2, 20, 100, true, mockClock); // passNextStartAt = 1000 + 40 = 1040
    timeline.commitPass();

    // 挂钟跳过 200ms
    mockClock += 200; // now = 1200 > 1040
    timeline.beginPass(mockClock);

    const slot = timeline.take(1, 20, 100, true, mockClock);
    expect(slot.baseDelay).toBe(0);
  });

  it('TURBO 或 allowWordSpans=false 模式下，返回 allowAnimation=false 与 0 延迟', () => {
    timeline.beginPass(mockClock);
    const slot = timeline.take(10, 0, 0, false, mockClock);

    expect(slot.allowAnimation).toBe(false);
    expect(slot.baseDelay).toBe(0);
    expect(slot.step).toBe(0);
    expect(slot.duration).toBe(0);
  });

  it('单次 Pass 中连续 take 多个 Block，时间轴游标连续累加', () => {
    timeline.beginPass(mockClock);

    // Block 1: 5 words, step 10ms -> span 50ms
    const slot1 = timeline.take(5, 10, 100, true, mockClock);
    expect(slot1.baseDelay).toBe(0);

    // Block 2: 5 words, step 10ms -> baseDelay 50ms
    const slot2 = timeline.take(5, 10, 100, true, mockClock);
    expect(slot2.baseDelay).toBe(50);
  });

  it('reset() 清空时间轴已提交与未提交游标', () => {
    timeline.beginPass(mockClock);
    timeline.take(5, 20, 100, true, mockClock);
    timeline.commitPass();

    timeline.reset();
    timeline.beginPass(mockClock);
    expect(timeline.mark()).toBe(mockClock);
  });
});
