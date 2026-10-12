import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

interface BaselineEntry {
  name: string;
  avgMs: number;
  ops: number;
  p95Ms: number;
}

interface CurrentResult {
  name: string;
  avgMs: number;
  ops: number;
  p95Ms: number;
  passed: boolean;
}

interface Regression {
  name: string;
  previousAvgMs: number;
  currentAvgMs: number;
  changePercent: number;
}

interface ComparisonResult {
  timestamp: string;
  threshold: number;
  minDeltaMs?: number;
  baselines: BaselineEntry[];
  currents: CurrentResult[];
  regressions: Regression[];
  improvements: Regression[];
  passed: boolean;
}

function parseArgs(): {
  threshold: number;
  minDeltaMs: number;
  baselinePath?: string;
} {
  const args = process.argv.slice(2);
  let threshold = 0.2;
  let minDeltaMs = 0.5;
  let baselinePath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--threshold' && i + 1 < args.length) {
      threshold = parseFloat(args[i + 1]);
      i++;
    } else if (args[i] === '--min-delta' && i + 1 < args.length) {
      minDeltaMs = parseFloat(args[i + 1]);
      i++;
    } else if (args[i] === '--baseline' && i + 1 < args.length) {
      baselinePath = args[i + 1];
      i++;
    } else if (args[i] === '--help') {
      console.log(
        '用法: node scripts/compare-benchmarks.ts [--threshold 0.2] [--min-delta 0.5] [--baseline <path>]'
      );
      process.exit(0);
    }
  }

  return { threshold, minDeltaMs, baselinePath };
}

function loadBaselines(path?: string): BaselineEntry[] {
  const defaultPath = 'perf-report/baseline.json';
  const resolvedPath = path || defaultPath;

  if (!existsSync(resolvedPath)) {
    console.log(`基线文件不存在 (${resolvedPath})，跳过对比`);
    return [];
  }

  try {
    const raw = readFileSync(resolvedPath, 'utf8');
    return JSON.parse(raw) as BaselineEntry[];
  } catch (err) {
    console.error(`读取基线文件失败: ${err}`);
    return [];
  }
}

function loadCurrentResults(): CurrentResult[] {
  const resultPath = 'perf-report/benchmark-result.json';
  if (!existsSync(resultPath)) {
    console.error(`当前基准结果不存在: ${resultPath}`);
    process.exit(1);
  }

  try {
    const raw = readFileSync(resultPath, 'utf8');
    const suite = JSON.parse(raw);
    return suite.benchmarks.map(
      (b: {
        name: string;
        avgMs: number;
        ops: number;
        p95Ms: number;
        passed: boolean;
      }) => ({
        name: b.name,
        avgMs: b.avgMs,
        ops: b.ops,
        p95Ms: b.p95Ms,
        passed: b.passed,
      })
    );
  } catch (err) {
    console.error(`读取当前结果失败: ${err}`);
    process.exit(1);
  }
}

function writeBaselineBack(
  baselineFile: string,
  currents: CurrentResult[],
  hadBaseline: boolean
): void {
  const entries: BaselineEntry[] = currents.map((c) => ({
    name: c.name,
    avgMs: c.avgMs,
    ops: c.ops,
    p95Ms: c.p95Ms,
  }));
  const resolvedPath = resolve(baselineFile);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, JSON.stringify(entries, null, 2), 'utf8');
  console.log(
    `\n基线${hadBaseline ? '已更新' : '已初始化'}: ${baselineFile}（${entries.length} 个条目）`
  );
}

function main() {
  const { threshold, minDeltaMs, baselinePath } = parseArgs();
  const baselineFile = baselinePath ?? 'perf-report/baseline.json';
  const baselines = loadBaselines(baselineFile);
  const currents = loadCurrentResults();

  const baselineMap = new Map(baselines.map((b) => [b.name, b]));

  const regressions: Regression[] = [];
  const improvements: Regression[] = [];

  for (const current of currents) {
    const baseline = baselineMap.get(current.name);
    if (!baseline) continue;

    const deltaMs = current.avgMs - baseline.avgMs;
    const changePercent = deltaMs / baseline.avgMs;

    if (changePercent > threshold && deltaMs > minDeltaMs) {
      regressions.push({
        name: current.name,
        previousAvgMs: baseline.avgMs,
        currentAvgMs: current.avgMs,
        changePercent: Math.round(changePercent * 10000) / 100,
      });
    } else if (changePercent < -threshold) {
      improvements.push({
        name: current.name,
        previousAvgMs: baseline.avgMs,
        currentAvgMs: current.avgMs,
        changePercent: Math.round(changePercent * 10000) / 100,
      });
    }
  }

  const result: ComparisonResult = {
    timestamp: new Date().toISOString(),
    threshold,
    minDeltaMs,
    baselines,
    currents,
    regressions,
    improvements,
    passed: regressions.length === 0,
  };

  console.log('='.repeat(60));
  console.log('基准对比报告');
  console.log('='.repeat(60));
  console.log(`阈值: ${(threshold * 100).toFixed(0)}%`);
  console.log(`最小回归增量: ${minDeltaMs}ms`);

  if (improvements.length > 0) {
    console.log('\n改进:');
    for (const imp of improvements) {
      console.log(
        `  ${imp.name}: ${imp.previousAvgMs}ms -> ${imp.currentAvgMs}ms (${imp.changePercent > 0 ? '+' : ''}${imp.changePercent}%)`
      );
    }
  }

  if (regressions.length > 0) {
    console.log('\n退化:');
    for (const reg of regressions) {
      console.log(
        `  ${reg.name}: ${reg.previousAvgMs}ms -> ${reg.currentAvgMs}ms (+${reg.changePercent}%)`
      );
    }
  }

  if (regressions.length === 0) {
    console.log('\n结果: 通过 - 未检测到性能退化');
  } else {
    console.log(`\n结果: 失败 - 检测到 ${regressions.length} 个性能退化`);
  }

  const reportDir = 'perf-report';
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    `${reportDir}/comparison-result.json`,
    JSON.stringify(result, null, 2),
    'utf8'
  );
  console.log(`\n对比报告已保存到 ${reportDir}/comparison-result.json`);

  if (result.passed) {
    writeBaselineBack(baselineFile, currents, baselines.length > 0);
  }

  if (!result.passed) {
    process.exitCode = 1;
  }
}

main();
