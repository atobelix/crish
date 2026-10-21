/**
 * 同机交错 A/B 性能对比的统计判定（perf-test.yml「Compare with baselines」使用）。
 *
 * 背景：此前 CI 用共享 runner 上的「单进程一次运行的 avg」去比对一份在开发机上
 * 生成并入库的固定基线（perf-report/baseline.json）。GitHub 托管 runner 的硬件
 * 每次分配都不同，同一提交在两台 runner 上全部基准会整体相差 1.5~2 倍，这种比较
 * 测到的是机器差异而不是代码差异，必然随机误报/漏报。
 *
 * 现在的方法：
 * - base（对比基准提交）与 head（当前代码）在同一台 runner 上、各自独立进程、
 *   交错（ABBA…）运行 N 轮，消除机器差异与运行期间的漂移；
 * - 每轮每项基准取样本中位数（抗 GC/调度尖峰），作为一次独立观测；
 * - 用 head/base 中位数之比作为点估计，种子化 bootstrap 给出置信区间，
 *   保证同一份数据的判定结果完全可复现。
 *
 * 判定（阈值与最小增量语义保持不变，只增加「显著性」这一必要条件）：
 * - regression：点估计变慢超过 threshold，且绝对增量超过 minDeltaMs，
 *   且置信区间下界 > 1（确有变慢，不是噪声）；
 * - suspect：点估计超过阈值但置信区间跨过 1（数据不足以确认），只告警；
 * - improvement：点估计变快超过 threshold 且置信区间上界 < 1；
 * - new：base 中不存在的基准（新增），无从比较；
 * - insufficient：任一侧有效观测少于 minRounds，无法判定（视为失败）。
 */

export interface AbObservation {
  name: string;
  /** base 每轮（每个独立进程）的样本中位数，单位 ms */
  base: number[];
  /** head 每轮（每个独立进程）的样本中位数，单位 ms */
  head: number[];
}

export interface AbDecisionOptions {
  /** 相对阈值，0.2 表示变慢 20% */
  threshold: number;
  /** 绝对增量下限（ms），低于此值的变化不视为退化 */
  minDeltaMs: number;
  /** 置信水平，默认 0.95 */
  confidence: number;
  /** bootstrap 重采样次数 */
  resamples: number;
  /** PRNG 种子，保证判定可复现 */
  seed: number;
  /** 每侧最少有效观测数 */
  minRounds: number;
}

export type AbVerdict =
  'regression' | 'suspect' | 'improvement' | 'neutral' | 'new' | 'insufficient';

export interface AbJudgement {
  name: string;
  verdict: AbVerdict;
  baseRounds: number;
  headRounds: number;
  baseMedianMs: number | null;
  headMedianMs: number | null;
  deltaMs: number | null;
  /** head / base，>1 表示变慢 */
  ratio: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  /** (ratio - 1) * 100，保留两位小数 */
  changePercent: number | null;
}

export const DEFAULT_AB_OPTIONS: AbDecisionOptions = {
  threshold: 0.2,
  minDeltaMs: 0.5,
  confidence: 0.95,
  resamples: 5000,
  seed: 0x5eed,
  minRounds: 3,
};

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError('median() of empty array');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 线性插值分位数（R-7 / numpy 默认），q ∈ [0, 1] */
export function quantile(sortedValues: readonly number[], q: number): number {
  if (sortedValues.length === 0) {
    throw new RangeError('quantile() of empty array');
  }
  const pos = (sortedValues.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (
    sortedValues[lo]! + (sortedValues[hi]! - sortedValues[lo]!) * (pos - lo)
  );
}

/** mulberry32：小而确定的 PRNG，返回 [0, 1) */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function resample(values: readonly number[], rng: () => number): number[] {
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) {
    out[i] = values[Math.floor(rng() * values.length)]!;
  }
  return out;
}

/** head/base 中位数之比的百分位 bootstrap 置信区间 */
export function bootstrapRatioCi(
  base: readonly number[],
  head: readonly number[],
  options: Pick<AbDecisionOptions, 'confidence' | 'resamples' | 'seed'>
): { low: number; high: number } {
  const rng = createRng(options.seed);
  const ratios: number[] = [];
  for (let i = 0; i < options.resamples; i++) {
    const b = median(resample(base, rng));
    const h = median(resample(head, rng));
    if (b > 0) ratios.push(h / b);
  }
  if (ratios.length === 0) {
    return { low: Number.NaN, high: Number.NaN };
  }
  ratios.sort((a, b) => a - b);
  const alpha = (1 - options.confidence) / 2;
  return { low: quantile(ratios, alpha), high: quantile(ratios, 1 - alpha) };
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function isValidSample(v: number): boolean {
  return Number.isFinite(v) && v >= 0;
}

export function judgeAb(
  observation: AbObservation,
  options: AbDecisionOptions = DEFAULT_AB_OPTIONS
): AbJudgement {
  const base = observation.base.filter(isValidSample);
  const head = observation.head.filter(isValidSample);
  const empty: AbJudgement = {
    name: observation.name,
    verdict: 'insufficient',
    baseRounds: base.length,
    headRounds: head.length,
    baseMedianMs: null,
    headMedianMs: null,
    deltaMs: null,
    ratio: null,
    ciLow: null,
    ciHigh: null,
    changePercent: null,
  };

  if (head.length < options.minRounds) {
    return empty;
  }
  if (observation.base.length === 0) {
    return { ...empty, verdict: 'new', headMedianMs: round(median(head), 4) };
  }
  if (base.length < options.minRounds) {
    return empty;
  }

  const baseMedian = median(base);
  const headMedian = median(head);
  const deltaMs = headMedian - baseMedian;
  const ratio =
    baseMedian > 0 ? headMedian / baseMedian : Number.POSITIVE_INFINITY;
  const ci = bootstrapRatioCi(base, head, options);

  let verdict: AbVerdict = 'neutral';
  const slowerBeyondThreshold =
    ratio > 1 + options.threshold && deltaMs > options.minDeltaMs;
  if (slowerBeyondThreshold) {
    verdict = ci.low > 1 ? 'regression' : 'suspect';
  } else if (ratio < 1 - options.threshold && ci.high < 1) {
    verdict = 'improvement';
  }

  return {
    name: observation.name,
    verdict,
    baseRounds: base.length,
    headRounds: head.length,
    baseMedianMs: round(baseMedian, 4),
    headMedianMs: round(headMedian, 4),
    deltaMs: round(deltaMs, 4),
    ratio: round(ratio, 4),
    ciLow: round(ci.low, 4),
    ciHigh: round(ci.high, 4),
    changePercent: round((ratio - 1) * 100, 2),
  };
}
