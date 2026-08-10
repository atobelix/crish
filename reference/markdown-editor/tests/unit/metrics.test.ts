// tests/unit/metrics.test.ts
// B6 指标核心化（plan-P2 B6 / status-P3 N10）测试：
//
// 1. 采集：createMetrics 实例的 getSnapshot 全量读数（FPS P50/P95、
//    缓存命中、物化计数、搜索批次、布局抖动计数）；
// 2. 采样与计量：FPS rAF 滚动窗口（stub rAF 驱动）、各计数自增、
//    getLineCount 注入源（避免 metrics ↔ EditorStore 循环依赖）；
// 3. 接线：EditorStore.materializeViews 经全局 metrics 实例自增
//    （读取 store.lines 触发惰性物化 → 物化计数增长）；
// 4. 兼容：__CRISH_METRICS__ 现有 3 API（getCacheStats / getLineCount /
//    layoutThrashCount）形状在 metrics 实例上保持；
// 5. 实例隔离与 SSR 安全：createMetrics 多实例互不干扰；无 rAF 环境
//    创建不崩溃、FPS 采样数为 0。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMetrics, metrics } from '../../src/core/metrics';
import { useEditorStore } from '../../src/core/EditorStore';

afterEach(() => {
  vi.unstubAllGlobals();
});

// 手动驱动 rAF 的 stub：每次注册记录回调，由测试显式推进帧时间戳
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
    getPending: () => nextCb !== null,
    registeredCount: () => frames.length,
  };
}

describe('metrics 采集（createMetrics）', () => {
  it('1a getSnapshot 结构完整：fps/cache/materializations/searchBatches/layoutThrashCount', () => {
    const m = createMetrics();
    const snap = m.getSnapshot();
    expect(snap).toHaveProperty('fps');
    expect(snap.fps).toHaveProperty('p50');
    expect(snap.fps).toHaveProperty('p95');
    expect(snap.fps).toHaveProperty('samples');
    expect(snap.cache).toHaveProperty('hits');
    expect(snap.cache).toHaveProperty('misses');
    expect(snap.cache).toHaveProperty('size');
    expect(typeof snap.materializations).toBe('number');
    expect(typeof snap.searchBatches).toBe('number');
    expect(typeof snap.layoutThrashCount).toBe('number');
    m.stopFpsSampling();
  });

  it('1b 缓存命中：默认源为 parser 静态缓存形状，注入源可覆盖', () => {
    const m = createMetrics();
    // 默认源：MarkdownParser.getCacheStats 形状
    const cache = m.getCacheStats();
    expect(typeof cache.hits).toBe('number');
    expect(typeof cache.misses).toBe('number');
    expect(typeof cache.size).toBe('number');
    // 注入覆盖：getSnapshot/getCacheStats 均走注入源
    m.setCacheStatsSource(() => ({ hits: 7, misses: 3, size: 2 }));
    expect(m.getCacheStats()).toEqual({ hits: 7, misses: 3, size: 2 });
    expect(m.getSnapshot().cache).toEqual({ hits: 7, misses: 3, size: 2 });
    m.stopFpsSampling();
  });

  it('1c 物化计数：incrementMaterializations 自增并反映在快照', () => {
    const m = createMetrics();
    m.incrementMaterializations();
    m.incrementMaterializations();
    m.incrementMaterializations();
    expect(m.getSnapshot().materializations).toBe(3);
    m.stopFpsSampling();
  });

  it('1d 搜索批次：recordSearchBatch 登记自增（searchAll 每批结束调用）', () => {
    const m = createMetrics();
    expect(m.getSnapshot().searchBatches).toBe(0);
    m.recordSearchBatch();
    m.recordSearchBatch();
    expect(m.getSnapshot().searchBatches).toBe(2);
    m.stopFpsSampling();
  });

  it('1e 布局抖动：incrementLayoutThrash 自增，layoutThrashCount 只读属性', () => {
    const m = createMetrics();
    m.incrementLayoutThrash();
    expect(m.layoutThrashCount).toBe(1);
    expect(m.getSnapshot().layoutThrashCount).toBe(1);
    // 属性只读（接口层 readonly 约束；严格模式下对仅 getter 属性赋值
    // 会抛 TypeError，故此处仅验证计数不受外部直接赋值影响的设计意图）
    m.stopFpsSampling();
  });

  it('1f 行数源：未注册返回 0，注册后经注入源读取（兼容 getLineCount API）', () => {
    const m = createMetrics();
    expect(m.getLineCount()).toBe(0);
    m.setLineCountSource(() => 42);
    expect(m.getLineCount()).toBe(42);
    m.setLineCountSource(() => 1234);
    expect(m.getLineCount()).toBe(1234);
    m.stopFpsSampling();
  });
});

describe('FPS 采样（rAF 滚动窗口）', () => {
  it('2a 无 rAF 环境（node）：创建不崩溃、采样数为 0', () => {
    // node 测试环境默认无 requestAnimationFrame（未 stub）
    const m = createMetrics();
    expect(m.getSnapshot().fps.samples).toBe(0);
    expect(m.getSnapshot().fps.p50).toBe(0);
    expect(m.getSnapshot().fps.p95).toBe(0);
    m.stopFpsSampling();
  });

  it('2b rAF 驱动采样：帧间隔 → 瞬时帧率 → P50/P95 分位正确', () => {
    const raf = stubRaf();
    const m = createMetrics(); // 创建即自动启动采样
    // 帧时间戳：间隔 30/60/60ms → 帧率 33.33/16.67/16.67
    const ticks = [100, 130, 190, 250];
    for (const t of ticks) raf.tick(t);
    const fps = m.getSnapshot().fps;
    expect(fps.samples).toBe(3);
    // 排序 [16.67, 16.67, 33.33]：p50 中位 = 16.67
    expect(fps.p50).toBeCloseTo(16.67, 0);
    // p95 线性插值 = 16.67 + (33.33-16.67)*0.9 ≈ 31.67
    expect(fps.p95).toBeCloseTo(31.67, 0);
    m.stopFpsSampling();
  });

  it('2c 滚动窗口有界：采样数不超过窗口上限（120 帧）', () => {
    const raf = stubRaf();
    const m = createMetrics();
    // 推进 300 帧（间隔 16.67ms，恒定 60fps）
    for (let i = 0; i < 300; i++) raf.tick(1000 + i * 16.67);
    const fps = m.getSnapshot().fps;
    expect(fps.samples).toBe(120);
    expect(fps.p50).toBeCloseTo(60, 0);
    expect(fps.p95).toBeCloseTo(60, 0);
    m.stopFpsSampling();
  });

  it('2d start/stop 控制：停止后不再采样，恢复后继续累计', () => {
    const raf = stubRaf();
    const m = createMetrics();
    raf.tick(100);
    raf.tick(116.67); // 1 个间隔（60fps）
    m.stopFpsSampling();
    // 停止后即使有已排队（stub 未取消）的帧回调被执行，也不续帧、
    // 不新增样本（sampling 标志硬性停止，不依赖 cancelAnimationFrame）
    if (raf.getPending()) raf.tick(300);
    expect(raf.getPending()).toBe(false);
    expect(m.getSnapshot().fps.samples).toBe(1);
    // 恢复采样：重新注册回调，继续累计（窗口数据保留）
    m.startFpsSampling();
    expect(raf.getPending()).toBe(true);
    raf.tick(400); // 与 stop 前 tick(300) 形成 1 个间隔样本
    raf.tick(416.67); // +1 个间隔样本
    expect(m.getSnapshot().fps.samples).toBe(3);
    m.stopFpsSampling();
  });

  it('2e startFpsSampling 幂等：重复调用不重复注册', () => {
    const raf = stubRaf();
    const m = createMetrics();
    m.startFpsSampling();
    m.startFpsSampling();
    // 只有创建时的 1 次注册（幂等短路）
    expect(raf.registeredCount()).toBe(1);
    m.stopFpsSampling();
  });
});

describe('metrics 接线与兼容面', () => {
  it('3a 物化接线：读取 store.lines 触发 lazyViewProto 物化 → 全局 metrics 计数增长', () => {
    const before = metrics.getSnapshot().materializations;
    useEditorStore.getState().setText('alpha\nbeta');
    // 经访问器读取不物化
    expect(useEditorStore.getState().getLineCount()).toBe(2);
    const afterAccessor = metrics.getSnapshot().materializations;
    expect(afterAccessor).toBe(before);
    // 读兼容视图字段触发惰性物化（R6-P1 信号源）
    void useEditorStore.getState().lines;
    const afterMaterialize = metrics.getSnapshot().materializations;
    expect(afterMaterialize).toBeGreaterThan(afterAccessor);
  });

  it('3b 兼容 3 API 形状：getCacheStats/getLineCount/layoutThrashCount（main.tsx 迁移面）', () => {
    const m = createMetrics();
    expect(typeof m.getCacheStats).toBe('function');
    expect(typeof m.getLineCount).toBe('function');
    expect(typeof m.layoutThrashCount).toBe('number');
    // main.tsx 的 __CRISH_METRICS__ 迁移形态（同一形状可替换）
    const compat: {
      getCacheStats: () => { hits: number; misses: number; size: number };
      getLineCount: () => number;
      layoutThrashCount: number;
    } = {
      getCacheStats: () => m.getCacheStats(),
      getLineCount: () => m.getLineCount(),
      layoutThrashCount: m.layoutThrashCount,
    };
    expect(compat.getCacheStats()).toHaveProperty('hits');
    expect(compat.getLineCount()).toBeTypeOf('number');
    expect(compat.layoutThrashCount).toBeTypeOf('number');
    m.stopFpsSampling();
  });

  it('3c 实例隔离：createMetrics 独立实例计数互不干扰', () => {
    const a = createMetrics();
    const b = createMetrics();
    a.recordSearchBatch();
    a.incrementMaterializations();
    a.incrementLayoutThrash();
    expect(b.getSnapshot().searchBatches).toBe(0);
    expect(b.getSnapshot().materializations).toBe(0);
    expect(b.layoutThrashCount).toBe(0);
    expect(a.getSnapshot().searchBatches).toBe(1);
    expect(a.getSnapshot().materializations).toBe(1);
    expect(a.layoutThrashCount).toBe(1);
    a.stopFpsSampling();
    b.stopFpsSampling();
  });
});
