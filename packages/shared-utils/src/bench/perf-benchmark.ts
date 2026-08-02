import { performance } from "node:perf_hooks";
import { totalmem } from "node:os";

export interface BenchmarkTarget {
  maxMs: number;
  minOps: number;
}

export interface PerfBenchmark {
  name: string;
  setup?: () => Promise<void>;
  run: () => Promise<unknown>;
  teardown?: () => Promise<void>;
  iterations: number;
  warmupIterations: number;
  target: BenchmarkTarget;
  toleranceMs?: number;
}

export interface BenchmarkSample {
  index: number;
  elapsedMs: number;
}

export interface BenchmarkResult {
  name: string;
  target: BenchmarkTarget;
  samples: BenchmarkSample[];
  warmupSamples: BenchmarkSample[];
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  ops: number;
  passed: boolean;
  error?: string;
}

export interface BenchmarkSuiteResult {
  timestamp: string;
  environment: {
    os: string;
    cpu: string;
    memory: string;
    nodeVersion: string;
  };
  benchmarks: BenchmarkResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
}

export async function runBenchmark(benchmark: PerfBenchmark): Promise<BenchmarkResult> {
  const warmupSamples: BenchmarkSample[] = [];
  const samples: BenchmarkSample[] = [];

  const runWithLifecycle = async (_index: number, _isWarmup: boolean): Promise<number> => {
    if (benchmark.setup) {
      await benchmark.setup();
    }
    const start = performance.now();
    try {
      await benchmark.run();
    } finally {
      if (benchmark.teardown) {
        await benchmark.teardown();
      }
    }
    return performance.now() - start;
  };

  try {
    for (let i = 0; i < benchmark.warmupIterations; i++) {
      const elapsed = await runWithLifecycle(i, true);
      warmupSamples.push({ index: i, elapsedMs: elapsed });
    }

    for (let i = 0; i < benchmark.iterations; i++) {
      const elapsed = await runWithLifecycle(i, false);
      samples.push({ index: i, elapsedMs: elapsed });
    }
  } catch (err) {
    return {
      name: benchmark.name,
      target: benchmark.target,
      samples: [],
      warmupSamples: [],
      avgMs: Infinity,
      minMs: Infinity,
      maxMs: Infinity,
      p50Ms: Infinity,
      p95Ms: Infinity,
      p99Ms: Infinity,
      ops: 0,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const elapsedValues = samples.map((s) => s.elapsedMs).sort((a, b) => a - b);
  const avgMs = elapsedValues.reduce((a, b) => a + b, 0) / elapsedValues.length;
  const minMs = elapsedValues[0]!;
  const maxMs = elapsedValues[elapsedValues.length - 1]!;
  const p50Ms = percentile(elapsedValues, 0.5);
  const p95Ms = percentile(elapsedValues, 0.95);
  const p99Ms = percentile(elapsedValues, 0.99);
  const ops = avgMs > 0 ? Math.round(1000 / avgMs) : 0;
  const passed = avgMs <= benchmark.target.maxMs && ops >= benchmark.target.minOps;

  return {
    name: benchmark.name,
    target: benchmark.target,
    samples,
    warmupSamples,
    avgMs: round2(avgMs),
    minMs: round2(minMs),
    maxMs: round2(maxMs),
    p50Ms: round2(p50Ms),
    p95Ms: round2(p95Ms),
    p99Ms: round2(p99Ms),
    ops,
    passed,
  };
}

export async function runAllBenchmarks(benchmarks: PerfBenchmark[]): Promise<BenchmarkSuiteResult> {
  const results: BenchmarkResult[] = [];

  for (const benchmark of benchmarks) {
    const result = await runBenchmark(benchmark);
    results.push(result);
    const status = result.passed ? "PASS" : "FAIL";
    console.log(`[${status}] ${result.name}: avg=${result.avgMs}ms ops=${result.ops} target=${result.target.maxMs}ms`);
    if (result.error) {
      console.error(`  error: ${result.error}`);
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  return {
    timestamp: new Date().toISOString(),
    environment: collectEnvironment(),
    benchmarks: results,
    summary: { total: results.length, passed, failed },
  };
}

function collectEnvironment() {
  return {
    os: `${process.platform} ${process.arch}`,
    cpu: process.env.CPU_MODEL || "unknown",
    memory: `${Math.round(totalmem() / (1024 * 1024))}MB`,
    nodeVersion: process.version,
  };
}

function percentile(sortedValues: number[], rank: number): number {
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * rank) - 1));
  return round2(sortedValues[index]!);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
