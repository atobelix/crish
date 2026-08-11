// tests/unit/stream-metrics.test.ts
// W3-4 包流式专项指标（S-T-3-04）测试：
//
// 1. S-T-3-04a：计数单调递增（recordAppendCommit / recordDirectCommit
//    多次调用后计数正确，中间态不回落）；
// 2. S-T-3-04b：append 耗时采样可观测（注入已知耗时后计数/均值/最近值
//    符合预期——注入式设计：接线方负责计时，本模块只登记，避免计时
//    精度与平台计时器差异进入断言面）；
// 3. S-T-3-04c：直刷占比派生正确（直刷/总提交组合断言，无提交时 0）；
// 4. S-T-3-04d：清零/快照接口行为（resetStreamMetrics 归零 append 耗时
//    采样与提交计数，帧间隙窗口保留——与 FPS 同源，不破坏既有契约）；
// 5. 帧间隙派生：复用 FPS rAF 采样窗口，均值/最近值/样本数正确；
// 6. 快照结构完整性：新增流式专项字段形状齐全。
//
// 本包只做指标定义与单元测试；采集接线（streamAppend / appendText
// 调用点）归 W3-4 后续批次。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMetrics } from '../../src/core/metrics';

afterEach(() => {
  vi.unstubAllGlobals();
});

// 手动驱动 rAF 的 stub（与 metrics.test.ts 同款）：每次注册记录回调，
// 由测试显式推进帧时间戳
function stubRaf() {
  const frames: number[] = [];
  let nextCb: FrameRequestCallback | null = null;
  vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) => {
    nextCb = cb;
    frames.push(frames.length + 1);
    return frames.length;
  }) as typeof requestAnimationFrame);
  const tick = (ts: number) => {
    const cb = nextCb!;
    nextCb = null;
    cb(ts);
  };
  return {
    tick,
    registeredCount: () => frames.length,
  };
}

describe('S-T-3-04a 提交计数单调递增', () => {
  it('append 提交多次调用后计数正确，中间态单调不回落', () => {
    const m = createMetrics();
    expect(m.getSnapshot().commits).toEqual({
      appendCommits: 0,
      directCommits: 0,
    });
    m.recordAppendCommit();
    expect(m.getSnapshot().commits.appendCommits).toBe(1);
    m.recordAppendCommit();
    m.recordAppendCommit();
    m.recordDirectCommit();
    expect(m.getSnapshot().commits.appendCommits).toBe(3);
    expect(m.getSnapshot().commits.directCommits).toBe(1);
    // 单调性：追加调用后计数不回退（补一次调用验证严格递增）
    m.recordDirectCommit();
    expect(m.getSnapshot().commits.directCommits).toBe(2);
    m.stopFpsSampling();
  });

  it('直刷通道独立计数：recordDirectCommit 不影响 append 提交计数', () => {
    const m = createMetrics();
    m.recordDirectCommit();
    m.recordDirectCommit();
    expect(m.getSnapshot().commits.directCommits).toBe(2);
    expect(m.getSnapshot().commits.appendCommits).toBe(0);
    m.stopFpsSampling();
  });
});

describe('S-T-3-04b append 耗时采样可观测', () => {
  it('注入已知耗时后计数/均值/最近值符合预期（注入式计时）', () => {
    const m = createMetrics();
    expect(m.getSnapshot().appendTime).toEqual({
      count: 0,
      averageMs: 0,
      lastMs: 0,
    });
    // 注入两个已知耗时：均值 = (10 + 30) / 2 = 20，最近值 = 30
    m.recordAppendTime(10);
    m.recordAppendTime(30);
    const stats = m.getSnapshot().appendTime;
    expect(stats.count).toBe(2);
    expect(stats.averageMs).toBe(20);
    expect(stats.lastMs).toBe(30);
    m.stopFpsSampling();
  });

  it('耗时采样与提交计数相互独立：recordAppendTime 不动提交计数', () => {
    const m = createMetrics();
    m.recordAppendTime(8);
    m.recordAppendTime(4);
    const snap = m.getSnapshot();
    expect(snap.appendTime.count).toBe(2);
    expect(snap.appendTime.averageMs).toBe(6);
    expect(snap.commits.appendCommits).toBe(0);
    expect(snap.commits.directCommits).toBe(0);
    m.stopFpsSampling();
  });
});

describe('S-T-3-04c 直刷占比派生', () => {
  it('无提交时直刷占比为 0（避免除零）', () => {
    const m = createMetrics();
    expect(m.getSnapshot().directRatio).toBe(0);
    m.stopFpsSampling();
  });

  it('直刷/总提交组合：3 append + 1 直刷 → 0.25', () => {
    const m = createMetrics();
    m.recordAppendCommit();
    m.recordAppendCommit();
    m.recordAppendCommit();
    m.recordDirectCommit();
    const snap = m.getSnapshot();
    expect(snap.commits.appendCommits).toBe(3);
    expect(snap.commits.directCommits).toBe(1);
    expect(snap.directRatio).toBe(0.25);
    m.stopFpsSampling();
  });

  it('直刷/总提交组合：2 append + 2 直刷 → 0.5', () => {
    const m = createMetrics();
    m.recordAppendCommit();
    m.recordAppendCommit();
    m.recordDirectCommit();
    m.recordDirectCommit();
    expect(m.getSnapshot().directRatio).toBe(0.5);
    m.stopFpsSampling();
  });

  it('全部直刷：5 直刷 + 0 append → 1', () => {
    const m = createMetrics();
    for (let i = 0; i < 5; i++) m.recordDirectCommit();
    expect(m.getSnapshot().directRatio).toBe(1);
    m.stopFpsSampling();
  });
});

describe('S-T-3-04d 清零与快照接口行为', () => {
  it('resetStreamMetrics 归零 append 耗时采样与提交计数', () => {
    const m = createMetrics();
    m.recordAppendTime(12);
    m.recordAppendTime(36);
    m.recordAppendCommit();
    m.recordAppendCommit();
    m.recordDirectCommit();
    expect(m.getSnapshot().appendTime.count).toBe(2);
    expect(m.getSnapshot().commits.appendCommits).toBe(2);
    expect(m.getSnapshot().directRatio).toBeCloseTo(1 / 3, 10);

    m.resetStreamMetrics();
    const snap = m.getSnapshot();
    expect(snap.appendTime).toEqual({ count: 0, averageMs: 0, lastMs: 0 });
    expect(snap.commits).toEqual({ appendCommits: 0, directCommits: 0 });
    expect(snap.directRatio).toBe(0);

    // 清零后可重新累计（不破坏后续采样）
    m.recordAppendTime(5);
    m.recordAppendCommit();
    expect(m.getSnapshot().appendTime).toEqual({
      count: 1,
      averageMs: 5,
      lastMs: 5,
    });
    expect(m.getSnapshot().commits.appendCommits).toBe(1);
    m.stopFpsSampling();
  });

  it('resetStreamMetrics 不清帧间隙窗口（与 FPS 同源，既有契约保留）', () => {
    const raf = stubRaf();
    const m = createMetrics();
    // 采集 2 个帧间隔样本（30ms + 60ms）
    raf.tick(100);
    raf.tick(130);
    raf.tick(190);
    expect(m.getSnapshot().frameGaps.samples).toBe(2);
    m.recordDirectCommit();
    m.recordAppendTime(9);
    m.resetStreamMetrics();
    // 提交与耗时采样归零，帧间隙窗口保留（与 fps 同源不清零）
    expect(m.getSnapshot().commits.directCommits).toBe(0);
    expect(m.getSnapshot().appendTime.count).toBe(0);
    expect(m.getSnapshot().frameGaps.samples).toBe(2);
    expect(m.getSnapshot().fps.samples).toBe(2);
    m.stopFpsSampling();
  });
});

describe('帧间隙派生（复用 FPS 采样窗口）', () => {
  it('帧间隔样本 → 最近值/均值正确，样本数与 fps 同源', () => {
    const raf = stubRaf();
    const m = createMetrics();
    // 帧时间戳：间隔 30ms 与 60ms → 最近值 60、均值 45
    raf.tick(100);
    raf.tick(130);
    raf.tick(190);
    const gaps = m.getSnapshot().frameGaps;
    expect(gaps.samples).toBe(2);
    expect(gaps.lastMs).toBe(60);
    expect(gaps.averageMs).toBe(45);
    // 与 FPS 采样同一窗口：样本数一致
    expect(m.getSnapshot().fps.samples).toBe(gaps.samples);
    m.stopFpsSampling();
  });

  it('无 rAF 环境（node）：帧间隙统计为空（与 fps 行为一致）', () => {
    // 未 stub rAF：创建时采样循环静默跳过
    const m = createMetrics();
    expect(m.getSnapshot().frameGaps).toEqual({
      samples: 0,
      lastMs: 0,
      averageMs: 0,
    });
    m.stopFpsSampling();
  });

  it('滚动窗口有界：帧间隙样本数不超窗口上限（与 fps 同窗口 120 帧）', () => {
    const raf = stubRaf();
    const m = createMetrics();
    for (let i = 0; i < 300; i++) raf.tick(1000 + i * 16.67);
    const gaps = m.getSnapshot().frameGaps;
    expect(gaps.samples).toBe(120);
    // 恒定间隔：均值与最近值均为 16.67ms
    expect(gaps.lastMs).toBeCloseTo(16.67, 0);
    expect(gaps.averageMs).toBeCloseTo(16.67, 0);
    m.stopFpsSampling();
  });
});

describe('快照结构完整性（W3-4 新增字段）', () => {
  it('getSnapshot 含 appendTime/commits/directRatio/frameGaps 全形状', () => {
    const m = createMetrics();
    const snap = m.getSnapshot();
    expect(snap.appendTime).toHaveProperty('count');
    expect(snap.appendTime).toHaveProperty('averageMs');
    expect(snap.appendTime).toHaveProperty('lastMs');
    expect(snap.commits).toHaveProperty('appendCommits');
    expect(snap.commits).toHaveProperty('directCommits');
    expect(typeof snap.directRatio).toBe('number');
    expect(snap.frameGaps).toHaveProperty('samples');
    expect(snap.frameGaps).toHaveProperty('lastMs');
    expect(snap.frameGaps).toHaveProperty('averageMs');
    m.stopFpsSampling();
  });

  it('接口面：四个流式专项方法均为函数（采集接线方调用面）', () => {
    const m = createMetrics();
    expect(typeof m.recordAppendTime).toBe('function');
    expect(typeof m.recordAppendCommit).toBe('function');
    expect(typeof m.recordDirectCommit).toBe('function');
    expect(typeof m.resetStreamMetrics).toBe('function');
    m.stopFpsSampling();
  });
});
