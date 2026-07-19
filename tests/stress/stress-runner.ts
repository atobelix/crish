import { performance } from "node:perf_hooks";
import { writeFileSync, mkdirSync } from "node:fs";

export interface StressMetrics {
  fps: { current: number; min: number; samples: number[] };
  memory: {
    startHeap: number;
    maxHeap: number;
    endHeap: number;
    samples: number[];
  };
  latency: number[];
  errors: number;
  totalOps: number;
}

export interface StressScenario {
  name: string;
  duration: number;
  concurrency: number;
  scenario: () => AsyncGenerator<() => Promise<unknown>>;
  expectedErrorRate: number;
  expected: {
    fps: { min: number };
    memory: { maxHeap: number };
    latency: { p95: number; p99: number };
  };
}

export interface StressResult {
  name: string;
  duration: number;
  concurrency: number;
  metrics: StressMetrics;
  passed: boolean;
  error?: string;
}

export async function runStressTest(scenario: StressScenario): Promise<StressResult> {
  const startTime = performance.now();
  const endTime = startTime + scenario.duration;

  const metrics: StressMetrics = {
    fps: { current: 0, min: Infinity, samples: [] },
    memory: { startHeap: 0, endHeap: 0, maxHeap: 0, samples: [] },
    latency: [],
    errors: 0,
    totalOps: 0,
  };

  const startHeap = process.memoryUsage().heapUsed;
  metrics.memory.startHeap = startHeap;
  metrics.memory.maxHeap = startHeap;

  let frameCount = 0;
  let lastFpsSample = startTime;
  const fpsInterval = 1000;

  try {
    const generator = scenario.scenario();
    const activeTasks: Promise<void>[] = [];

    const runBatch = async () => {
      while (performance.now() < endTime) {
        const { value: operation, done } = await generator.next();
        if (done) break;

        const opStart = performance.now();
        try {
          await operation();
          metrics.totalOps++;
        } catch {
          metrics.errors++;
        }
        const opEnd = performance.now();
        metrics.latency.push(opEnd - opStart);
        frameCount++;

        const now = performance.now();
        if (now - lastFpsSample >= fpsInterval) {
          const fps = Math.round((frameCount / (now - lastFpsSample)) * 1000);
          metrics.fps.samples.push(fps);
          if (fps < metrics.fps.min) metrics.fps.min = fps;
          metrics.fps.current = fps;
          frameCount = 0;
          lastFpsSample = now;
        }

        const heap = process.memoryUsage().heapUsed;
        metrics.memory.samples.push(heap);
        if (heap > metrics.memory.maxHeap) metrics.memory.maxHeap = heap;
      }
    };

    const workers = Array.from({ length: scenario.concurrency }, () => runBatch());
    await Promise.all(workers);
  } catch (err) {
    return {
      name: scenario.name,
      duration: scenario.duration,
      concurrency: scenario.concurrency,
      metrics,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  metrics.memory.endHeap = process.memoryUsage().heapUsed;

  const sortedLatency = [...metrics.latency].sort((a, b) => a - b);
  const p95 = sortedLatency[Math.floor(sortedLatency.length * 0.95)] || 0;
  const p99 = sortedLatency[Math.floor(sortedLatency.length * 0.99)] || 0;

  const errorRate = metrics.totalOps > 0 ? metrics.errors / metrics.totalOps : 0;
  const checkedFps = metrics.fps.min >= scenario.expected.fps.min;
  const checkedMemory = metrics.memory.maxHeap - metrics.memory.startHeap <= scenario.expected.memory.maxHeap;
  const checkedLatency = p95 <= scenario.expected.latency.p95 && p99 <= scenario.expected.latency.p99;
  const checkedErrorRate = errorRate <= scenario.expectedErrorRate;

  const passed = checkedFps && checkedMemory && checkedLatency && checkedErrorRate;

  console.log(`[${passed ? "PASS" : "FAIL"}] ${scenario.name}`);
  console.log(`  FPS: min=${metrics.fps.min} (要求 >= ${scenario.expected.fps.min})`);
  console.log(`  内存: ${Math.round((metrics.memory.maxHeap - metrics.memory.startHeap) / 1024 / 1024)}MB (要求 <= ${Math.round(scenario.expected.memory.maxHeap / 1024 / 1024)}MB)`);
  console.log(`  延迟: p95=${Math.round(p95)}ms p99=${Math.round(p99)}ms (要求 p95<=${scenario.expected.latency.p95} p99<=${scenario.expected.latency.p99})`);
  console.log(`  错误率: ${(errorRate * 100).toFixed(1)}% (要求 <= ${(scenario.expectedErrorRate * 100).toFixed(0)}%)`);
  console.log(`  总操作: ${metrics.totalOps}`);

  return {
    name: scenario.name,
    duration: scenario.duration,
    concurrency: scenario.concurrency,
    metrics,
    passed,
  };
}

export async function runAllStressTests(scenarios: StressScenario[]): Promise<{
  results: StressResult[];
  summary: { total: number; passed: number; failed: number };
}> {
  const results: StressResult[] = [];

  for (const scenario of scenarios) {
    console.log(`\n开始压力测试: ${scenario.name} (${scenario.duration / 1000}s, 并发=${scenario.concurrency})`);
    const result = await runStressTest(scenario);
    results.push(result);
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log("\n" + "=".repeat(60));
  console.log("压力测试摘要");
  console.log("=".repeat(60));
  console.log(`总计: ${results.length}, 通过: ${passed}, 失败: ${failed}`);

  mkdirSync("perf-report", { recursive: true });
  writeFileSync("perf-report/stress-result.json", JSON.stringify({ results, summary: { total: results.length, passed, failed } }, null, 2), "utf8");

  if (failed > 0) process.exitCode = 1;

  return { results, summary: { total: results.length, passed, failed } };
}
