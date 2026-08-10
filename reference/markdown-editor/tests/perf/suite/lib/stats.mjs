// tests/perf/suite/lib/stats.mjs
// 基准套件共享统计工具（从既有四脚本单向提取，口径完全复刻）：
// - median / pct / sum：R0/R2/R3/R6 同款实现，保证新旧产物可比；
// - summarizeSamples：中位数汇总（既有脚本同款）；
// - sigmaReject：3σ 离群剔除（A6 §3.4 防抖第 2 条：> 均值+3σ 丢弃）；
// - summarize：汇总 + 3σ 剔除后的稳健统计（套件判定统一走此函数）；
// - fpsBand：帧率档位判定（final-verify 同款口径）。
// 纪律：UTF-8 无 BOM；中文注释；不 commit。

/** 中位数（升序排序后取中；空数组返回 NaN；与既有脚本同款） */
export function median(arr) {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 百分位（升序排序后按下标比例取；空数组返回 NaN；与既有脚本同款）。
 * 注意：既有脚本口径为「下标取整」（floor(n*p)），套件继续沿用该口径，
 * 保证与 R0-R6 历史产物直接可比。
 */
export function pct(arr, p) {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

/** 求和（空数组返回 0；与既有脚本同款） */
export function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

/** 均值（空数组返回 NaN） */
export function mean(arr) {
  if (arr.length === 0) return NaN;
  return sum(arr) / arr.length;
}

/**
 * 3σ 离群剔除（A6 §3.4 防抖第 2 条）：
 * 丢弃 |x - mean| > 3×std 的样本后返回新数组。
 * 样本数 < 4 时不剔除（样本太少时 σ 估计不可靠，保留原样）。
 */
export function sigmaReject(arr) {
  if (arr.length < 4) return [...arr];
  const m = mean(arr);
  const variance = sum(arr.map((v) => (v - m) * (v - m))) / arr.length;
  const sigma = Math.sqrt(variance);
  if (!isFinite(sigma) || sigma === 0) return [...arr];
  const limit = 3 * sigma;
  return arr.filter((v) => Math.abs(v - m) <= limit);
}

/**
 * 中位数汇总（与既有脚本 summarizeSamples 同款形状：
 * { samples, medianMs }）。
 */
export function summarizeSamples(raw) {
  const samples = raw.map((v) => Number(v.toFixed(3)));
  return { samples, medianMs: Number(median(raw).toFixed(3)) };
}

/**
 * 稳健汇总（套件判定统一入口）：
 * - raw 先过 3σ 剔除，再出中位/均值/分位；
 * - 同时保留剔除前的原始分位（rawP95 等），供报告对比「剔除前后差异」，
 *   让环境噪声的影响可见、可审计（A6 §3.4 防抖审计要求）。
 */
export function summarize(raw) {
  const clean = sigmaReject(raw);
  const p50 = median(clean);
  const p95 = pct(clean, 0.95);
  const p99 = pct(clean, 0.99);
  return {
    count: raw.length,
    rejected: raw.length - clean.length,
    medianMs: isFinite(p50) ? Number(p50.toFixed(3)) : null,
    p95Ms: isFinite(p95) ? Number(p95.toFixed(3)) : null,
    p99Ms: isFinite(p99) ? Number(p99.toFixed(3)) : null,
    meanMs: isFinite(mean(clean)) ? Number(mean(clean).toFixed(3)) : null,
    minMs: clean.length ? Number(Math.min(...clean).toFixed(3)) : null,
    maxMs: clean.length ? Number(Math.max(...clean).toFixed(3)) : null,
    rawP95Ms: isFinite(pct(raw, 0.95)) ? Number(pct(raw, 0.95).toFixed(3)) : null,
    rawMedianMs: isFinite(median(raw)) ? Number(median(raw).toFixed(3)) : null,
  };
}

/** 60fps 保底帧间隔预算（毫秒；A6 口径，对齐 final-verify） */
export const FRAME_BUDGET_MS = 16.6;

/**
 * 帧率档位判定（final-verify fpsBand 同款口径）：
 * - P95 < 16.6ms → 60fps 达标；名义刷新率 ≥120 时再按 P50 判 120/140fps；
 * - 返回 { band, actualHz }；headless（60Hz 渲染器）下 120/140 不可达，
 *   由调用方结合环境指纹标注。
 */
export function fpsBand(p50, p95, nominalHz) {
  const actualHz = p50 ? Number((1000 / p50).toFixed(0)) : null;
  let band;
  if (p95 < FRAME_BUDGET_MS) {
    band = '60fps PASS';
    if (nominalHz >= 120 && p50 < 7.14) band = '140fps';
    else if (nominalHz >= 120 && p50 < 8.33) band = '120fps';
    else if (nominalHz >= 120) band = '60fps PASS（名义 120Hz 未达）';
  } else {
    band = '60fps FAIL';
  }
  if (nominalHz < 120 && p95 < FRAME_BUDGET_MS) {
    band = '60fps PASS（渲染器上限 60Hz，120/140 不可达）';
  }
  return { band, actualHz };
}
