// tests/perf/suite/scenarios/memory-cycle.mjs
// 场景：内存曲线与循环泄漏门禁（M5——A6 §2.5 / G9 heap-growth 口径）。
//
// 口径：
// - 堆 1s 采样曲线（performance.memory，非 Chromium 环境 null 降级不阻塞）；
// - 每轮：注入 → 空闲 3s 取空闲最小值（GC 后稳态近似）；
// - 轮间强制 GC + 冷却由 runner 侧 CDP HeapProfiler.collectGarbage 执行
//   （防跨场景串扰，A6 §3.4 第 5 条）；
// - 判定：
//   M5a 注入堆增长 ≤60MB（R6 实测 +26.9~+43.1，余量 +40%）；
//   M5b 堆峰值 ≤256MB（R6 ≤163.9，余量 +56%）；
//   M5c 3 轮循环 GC 后稳态增量 ≤5%（nightly 专属——ci 单轮曲线不判此项，
//   checks 标记 na；tier 分档在 budgets M5c.steadyGrowthPct.ci=null 落地）。
// 纪律：UTF-8 无 BOM；中文注释；不 commit。

import { budgetFor, TIER_PARAMS } from '../budgets.mjs';

function check(metric, name, actual, budgetEntry, opts = {}) {
  const { value, reportOnly, tuned } = budgetEntry || { value: null, reportOnly: false, tuned: true };
  const na = actual === null || actual === undefined || Number.isNaN(actual) || value === null;
  return {
    metric,
    name,
    actual: na ? null : Number(Number(actual).toFixed(2)),
    budget: value,
    pass: na ? null : actual <= value,
    reportOnly: !!reportOnly,
    tuned: tuned !== false,
    na,
    ...opts,
  };
}

export default {
  id: 'memory-cycle',
  title: '内存曲线与循环泄漏门禁（M5a/M5b/M5c）',
  tiers: ['nightly', 'local'],
  async run(ctx) {
    const { page, fns, tier } = ctx;
    const P = TIER_PARAMS[tier];
    const log = (msg) => ctx.log(`[memory-cycle] ${msg}`);

    log(`内存循环 ${P.memoryRounds} 轮 × 注入 ${(P.memoryInjectMs / 1000).toFixed(0)}s（空闲 3s + runner 侧强制 GC 冷却）...`);
    const r = await page.evaluate(fns.pageMemoryCycle, {
      scenario: 'plain',
      durationMs: P.memoryInjectMs,
      idleMs: 3000,
      tps: 500,
      rounds: P.memoryRounds,
    });

    const checks = [];
    const notes = [];
    if (!r.heapSupported) {
      notes.push('performance.memory 不可用（非 Chromium 环境），M5 标记未采集——不阻塞其余指标（A6 §5.1 环境守卫）');
      checks.push({ metric: 'M5a', name: 'heapGrowthMB', actual: null, budget: null, pass: null, reportOnly: false, tuned: true, na: true });
      return { checks, notes, metrics: r };
    }

    const first = r.rounds[0];
    const last = r.rounds[r.rounds.length - 1];
    checks.push(
      // ---- M5a：注入堆增长（60s 注入口径；ci 单轮 20s 曲线仍按此阈值）----
      check('M5a', 'heapGrowthMB（注入堆增长）', first.growthMB, budgetFor('M5a', 'heapGrowthMB', tier)),
      // ---- M5b：堆峰值 ----
      check('M5b', 'heapPeakMB（堆峰值）', first.peakMB, budgetFor('M5b', 'heapPeakMB', tier)),
      // ---- M5c：3 轮循环稳态增量（ci 单轮 → na 不判；nightly 判 ≤5%）----
      check('M5c', 'steadyGrowthPct（3 轮 GC 后稳态增量）', r.steadyGrowthPct, budgetFor('M5c', 'steadyGrowthPct', tier))
    );
    notes.push(`末轮 GC 后稳态 ${last.idleMinMB}MB（起点 ${first.idleMinMB}MB），3 轮后增量 ${r.steadyGrowthPct === null ? 'n/a（轮数不足）' : r.steadyGrowthPct + '%'}`);
    if (!r.textMatch) {
      notes.push('文本一致性校验失败（内存场景）');
    }

    log(`完成：增长=${first.growthMB}MB 峰值=${first.peakMB}MB 稳态增量=${r.steadyGrowthPct === null ? 'n/a' : r.steadyGrowthPct + '%'}`);
    return { checks, notes, metrics: r };
  },
};
