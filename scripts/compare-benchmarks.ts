/**
 * 基准对比：读取 scripts/perf-ab.ts 产出的同机交错 A/B 数据，逐项判定是否退化。
 *
 * 不再与入库的固定基线（旧 perf-report/baseline.json，开发机上生成）比较——
 * 托管 runner 硬件每次不同，跨机器单次 avg 对比测到的是机器差异（同一提交
 * 在两台 runner 上全部基准整体相差 1.5~2 倍），也不再把当次结果写回基线。
 * 判定规则见 packages/shared-utils/src/bench/ab-stats.ts。
 *
 * 用法: npx tsx scripts/compare-benchmarks.ts [--threshold 0.2] [--min-delta 0.5]
 *       [--confidence 0.95] [--input perf-report/ab-result.json]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  type AbDecisionOptions,
  type AbJudgement,
  DEFAULT_AB_OPTIONS,
  judgeAb,
} from '../packages/shared-utils/src/bench/ab-stats';
import type { AbResultFile } from './perf-ab';

export interface Regression {
  name: string;
  previousMs: number;
  currentMs: number;
  changePercent: number;
  ciLow: number;
  ciHigh: number;
}

interface ComparisonResult {
  timestamp: string;
  method: AbResultFile['method'];
  baseRef: string;
  baseSha: string;
  headSha: string;
  rounds: number;
  environment: AbResultFile['environment'];
  options: AbDecisionOptions;
  judgements: AbJudgement[];
  regressions: Regression[];
  suspects: Regression[];
  improvements: Regression[];
  insufficient: string[];
  passed: boolean;
}

function parseArgs(argv: string[]): {
  options: AbDecisionOptions;
  input: string;
} {
  const options: AbDecisionOptions = { ...DEFAULT_AB_OPTIONS };
  let input = 'perf-report/ab-result.json';
  const num = (flag: string, raw: string | undefined): number => {
    const v = Number.parseFloat(raw ?? '');
    if (!Number.isFinite(v))
      throw new Error(`${flag} 需要数值参数，收到 ${raw}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--threshold') options.threshold = num(a, argv[++i]);
    else if (a === '--min-delta') options.minDeltaMs = num(a, argv[++i]);
    else if (a === '--confidence') options.confidence = num(a, argv[++i]);
    else if (a === '--input') input = argv[++i] ?? input;
    else if (a === '--help') {
      console.log(
        '用法: npx tsx scripts/compare-benchmarks.ts [--threshold 0.2] [--min-delta 0.5] [--confidence 0.95] [--input perf-report/ab-result.json]'
      );
      process.exit(0);
    } else throw new Error(`未知参数: ${a}`);
  }
  if (!(options.confidence > 0 && options.confidence < 1)) {
    throw new Error(`--confidence 必须在 (0,1) 内，收到 ${options.confidence}`);
  }
  return { options, input };
}

function toRegression(j: AbJudgement): Regression {
  return {
    name: j.name,
    previousMs: j.baseMedianMs ?? Number.NaN,
    currentMs: j.headMedianMs ?? Number.NaN,
    changePercent: j.changePercent ?? Number.NaN,
    ciLow: j.ciLow ?? Number.NaN,
    ciHigh: j.ciHigh ?? Number.NaN,
  };
}

function fmtRow(j: AbJudgement): string {
  if (j.verdict === 'new')
    return `  ${j.name}: 新增基准（base 无此项） head=${j.headMedianMs}ms`;
  if (j.verdict === 'insufficient')
    return `  ${j.name}: 有效观测不足 base=${j.baseRounds} head=${j.headRounds}`;
  const sign = (j.changePercent ?? 0) > 0 ? '+' : '';
  return `  ${j.name}: ${j.baseMedianMs}ms -> ${j.headMedianMs}ms (${sign}${j.changePercent}%, 比值 95%CI [${j.ciLow}, ${j.ciHigh}])`;
}

function annotate(
  level: 'error' | 'warning',
  title: string,
  message: string
): void {
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::${level} title=${title}::${message}`);
  }
}

function main(): void {
  const { options, input } = parseArgs(process.argv.slice(2));
  if (!existsSync(input)) {
    console.error(
      `A/B 结果不存在: ${input}（先运行 npx tsx scripts/perf-ab.ts）`
    );
    process.exitCode = 1;
    return;
  }
  const ab = JSON.parse(readFileSync(input, 'utf8')) as AbResultFile;

  const judgements = ab.benchmarks.map((b) =>
    judgeAb(
      {
        name: b.name,
        base: b.base.map((v) => (v === null ? Number.NaN : v)),
        head: b.head.map((v) => (v === null ? Number.NaN : v)),
      },
      options
    )
  );

  const by = (v: AbJudgement['verdict']) =>
    judgements.filter((j) => j.verdict === v);
  const regressions = by('regression').map(toRegression);
  const suspects = by('suspect').map(toRegression);
  const improvements = by('improvement').map(toRegression);
  const insufficient = by('insufficient').map((j) => j.name);

  const result: ComparisonResult = {
    timestamp: new Date().toISOString(),
    method: ab.method,
    baseRef: ab.baseRef,
    baseSha: ab.baseSha,
    headSha: ab.headSha,
    rounds: ab.rounds,
    environment: ab.environment,
    options,
    judgements,
    regressions,
    suspects,
    improvements,
    insufficient,
    passed: regressions.length === 0 && insufficient.length === 0,
  };

  console.log('='.repeat(60));
  console.log('基准对比报告（同机交错 A/B）');
  console.log('='.repeat(60));
  console.log(
    `base: ${ab.baseRef} (${ab.baseSha.slice(0, 9)})  head: ${ab.headSha.slice(0, 9)}${ab.headDirty ? '+dirty' : ''}`
  );
  console.log(
    `环境: ${ab.environment.os} / ${ab.environment.cpu} x${ab.environment.cpuCount} / Node ${ab.environment.nodeVersion}`
  );
  console.log(
    `轮数: ${ab.rounds}  阈值: ${(options.threshold * 100).toFixed(0)}%  最小回归增量: ${options.minDeltaMs}ms  置信水平: ${options.confidence * 100}%`
  );
  console.log('\n全部基准（每轮中位数的中位数）:');
  for (const j of judgements) console.log(`${fmtRow(j)}  [${j.verdict}]`);

  if (improvements.length > 0) {
    console.log('\n改进:');
    for (const j of by('improvement')) console.log(fmtRow(j));
  }
  if (suspects.length > 0) {
    console.log(
      '\n疑似退化（点估计超阈值但置信区间跨过 1，数据不足以确认，仅告警）:'
    );
    for (const j of by('suspect')) {
      console.log(fmtRow(j));
      annotate('warning', `疑似性能退化 ${j.name}`, fmtRow(j).trim());
    }
  }
  if (regressions.length > 0) {
    console.log('\n退化:');
    for (const j of by('regression')) {
      console.log(fmtRow(j));
      annotate('error', `性能退化 ${j.name}`, fmtRow(j).trim());
    }
  }
  if (insufficient.length > 0) {
    console.log(`\n无法判定（有效观测不足）: ${insufficient.join(', ')}`);
    annotate('error', '基准数据不足', insufficient.join(', '));
  }

  console.log(
    result.passed
      ? '\n结果: 通过 - 未检测到性能退化'
      : `\n结果: 失败 - ${regressions.length} 个性能退化，${insufficient.length} 项无法判定`
  );

  mkdirSync('perf-report', { recursive: true });
  writeFileSync(
    'perf-report/comparison-result.json',
    JSON.stringify(result, null, 2),
    'utf8'
  );
  console.log('\n对比报告已保存到 perf-report/comparison-result.json');

  if (!result.passed) {
    process.exitCode = 1;
  }
}

main();
