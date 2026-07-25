

export interface MemBenchmark {
  name: string;
  setup?: () => Promise<void>;
  execute: () => Promise<unknown>;
  teardown?: () => Promise<void>;
  expectedMaxHeapDelta: number;
  expectedMaxEventListenerLeak: number;
}

export interface MemBenchmarkSample {
  heapUsedBefore: number;
  heapUsedAfter: number;
  heapDelta: number;
  listenerCountBefore: number;
  listenerCountAfter: number;
  listenerDelta: number;
}

export interface MemBenchmarkResult {
  name: string;
  expectedMaxHeapDelta: number;
  expectedMaxEventListenerLeak: number;
  samples: MemBenchmarkSample[];
  avgHeapDelta: number;
  maxHeapDelta: number;
  avgListenerDelta: number;
  maxListenerDelta: number;
  passed: boolean;
  error?: string;
}

export interface MemBenchmarkSuiteResult {
  timestamp: string;
  environment: {
    os: string;
    nodeVersion: string;
  };
  tests: MemBenchmarkResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
}

function gc(): void {
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
  }
}

function getHeapUsed(): number {
  return process.memoryUsage().heapUsed;
}

function countEventListeners(): number {
  const eventNames = process.eventNames();
  let count = 0;
  for (const name of eventNames) {
    count += process.listenerCount(name);
  }
  return count;
}

export async function runMemBenchmark(benchmark: MemBenchmark, iterations = 3): Promise<MemBenchmarkResult> {
  const samples: MemBenchmarkSample[] = [];

  try {
    for (let i = 0; i < iterations; i++) {
      if (benchmark.setup) {
        await benchmark.setup();
      }

      gc();
      await new Promise((r) => setTimeout(r, 10));
      const heapUsedBefore = getHeapUsed();
      const listenerCountBefore = countEventListeners();

      await benchmark.execute();

      gc();
      await new Promise((r) => setTimeout(r, 10));
      const heapUsedAfter = getHeapUsed();
      const listenerCountAfter = countEventListeners();

      const heapDelta = heapUsedAfter - heapUsedBefore;
      const listenerDelta = listenerCountAfter - listenerCountBefore;

      samples.push({
        heapUsedBefore,
        heapUsedAfter,
        heapDelta,
        listenerCountBefore,
        listenerCountAfter,
        listenerDelta,
      });

      if (benchmark.teardown) {
        await benchmark.teardown();
      }

      gc();
      await new Promise((r) => setTimeout(r, 10));
    }
  } catch (err) {
    return {
      name: benchmark.name,
      expectedMaxHeapDelta: benchmark.expectedMaxHeapDelta,
      expectedMaxEventListenerLeak: benchmark.expectedMaxEventListenerLeak,
      samples: [],
      avgHeapDelta: Infinity,
      maxHeapDelta: Infinity,
      avgListenerDelta: Infinity,
      maxListenerDelta: Infinity,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const heapDeltas = samples.map((s) => s.heapDelta);
  const listenerDeltas = samples.map((s) => s.listenerDelta);
  const avgHeapDelta = Math.round(heapDeltas.reduce((a, b) => a + b, 0) / heapDeltas.length);
  const maxHeapDelta = Math.max(...heapDeltas);
  const avgListenerDelta = Math.round(listenerDeltas.reduce((a, b) => a + b, 0) / listenerDeltas.length);
  const maxListenerDelta = Math.max(...listenerDeltas);

  const passed =
    maxHeapDelta <= benchmark.expectedMaxHeapDelta &&
    maxListenerDelta <= benchmark.expectedMaxEventListenerLeak;

  return {
    name: benchmark.name,
    expectedMaxHeapDelta: benchmark.expectedMaxHeapDelta,
    expectedMaxEventListenerLeak: benchmark.expectedMaxEventListenerLeak,
    samples,
    avgHeapDelta,
    maxHeapDelta,
    avgListenerDelta,
    maxListenerDelta,
    passed,
  };
}

export async function runAllMemBenchmarks(benchmarks: MemBenchmark[]): Promise<MemBenchmarkSuiteResult> {
  const results: MemBenchmarkResult[] = [];

  for (const benchmark of benchmarks) {
    const result = await runMemBenchmark(benchmark);
    results.push(result);
    const status = result.passed ? "PASS" : "FAIL";
    console.log(
      `[${status}] ${result.name}: heapDelta=${result.maxHeapDelta} bytes ` +
        `(limit=${benchmark.expectedMaxHeapDelta}) listeners=${result.maxListenerDelta}`,
    );
    if (result.error) {
      console.error(`  error: ${result.error}`);
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  return {
    timestamp: new Date().toISOString(),
    environment: {
      os: `${process.platform} ${process.arch}`,
      nodeVersion: process.version,
    },
    tests: results,
    summary: { total: results.length, passed, failed },
  };
}
