import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';

/**
 * 压力测试框架（PS-02 T2.3 纠偏版）。
 *
 * - `fps` 指标重命名为 `ops`（ops/sec）：Node 下无浏览器帧概念，原命名误导。
 * - 新增 `verify` 不变式钩子：场景在计时循环结束后执行正确性校验，
 *   全部通过才判 PASS（防"性能阈值 trivially 通过但行为已坏"的空转）。
 * - 新增 `modules` 字段：输出真实生产模块清单，证明场景非 Node 内置自嗨。
 */

/**
 * 压力测试框架（PS-02 T2.3 纠偏版）。
 *
 * - `fps` 指标重命名为 `ops`（ops/sec）：Node 下无浏览器帧概念，原命名误导。
 * - 新增 `verify` 不变式钩子：场景在计时循环结束后执行正确性校验，
 *   全部通过才判 PASS（防"性能阈值 trivially 通过但行为已坏"的空转）。
 * - 新增 `modules` 字段：输出真实生产模块清单，证明场景非 Node 内置自嗨。
 */

export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed | 0;
    if (this.state === 0) this.state = 1;
  }

  /** mulberry32 — 确定性的 32 位 PRNG */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 返回 [0, max) 的整数 */
  nextInt(max: number): number {
    return Math.floor(this.next() * max);
  }

  /** 返回 [min, max) 的整数 */
  nextIntRange(min: number, max: number): number {
    return min + this.nextInt(max - min);
  }

  /** 返回指定长度的随机字母数字字符串 */
  nextString(length: number): string {
    const chars =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars[this.nextInt(chars.length)];
    }
    return result;
  }

  /** 从给定集合中随机取一个元素 */
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)]!;
  }
}

export interface StressMetrics {
  /** 每秒操作吞吐（Node 下无帧概念，原 fps 命名纠偏） */
  ops: { current: number; min: number; samples: number[] };
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

export interface InvariantCheck {
  ok: boolean;
  message: string;
}

export interface StressScenario {
  name: string;
  duration: number;
  concurrency: number;
  scenario: () => AsyncGenerator<() => Promise<unknown>>;
  seed?: number;
  expectedErrorRate: number;
  /** 场景驱动的真实生产模块清单（防空转审计输出） */
  modules: readonly string[];
  expected: {
    ops: { min: number };
    memory: { maxHeap: number };
    latency: { p95: number; p99: number };
  };
  /**
   * 正确性不变式：计时循环结束后执行，全部通过场景才判 PASS。
   * 注入 bug（改坏生产逻辑/断言目标）时此处必须可红（R7：真实缺陷形态）。
   */
  verify?: () => InvariantCheck[];
}

export interface StressResult {
  name: string;
  duration: number;
  concurrency: number;
  metrics: StressMetrics;
  invariants: InvariantCheck[];
  passed: boolean;
  error?: string;
}

export async function runStressTest(
  scenario: StressScenario
): Promise<StressResult> {
  const startTime = performance.now();
  const endTime = startTime + scenario.duration;

  const metrics: StressMetrics = {
    ops: { current: 0, min: Infinity, samples: [] },
    memory: { startHeap: 0, endHeap: 0, maxHeap: 0, samples: [] },
    latency: [],
    errors: 0,
    totalOps: 0,
  };

  const startHeap = process.memoryUsage().heapUsed;
  metrics.memory.startHeap = startHeap;
  metrics.memory.maxHeap = startHeap;

  let opCountInWindow = 0;
  let lastSample = startTime;
  const sampleInterval = 1000;

  try {
    const generator = scenario.scenario();

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
        opCountInWindow++;

        const now = performance.now();
        if (now - lastSample >= sampleInterval) {
<<<<<<< Updated upstream
          const opsPerSec = Math.round(
            (opCountInWindow / (now - lastSample)) * 1000
          );
=======
          const opsPerSec = Math.round((opCountInWindow / (now - lastSample)) * 1000);
>>>>>>> Stashed changes
          metrics.ops.samples.push(opsPerSec);
          if (opsPerSec < metrics.ops.min) metrics.ops.min = opsPerSec;
          metrics.ops.current = opsPerSec;
          opCountInWindow = 0;
          lastSample = now;
        }

        const heap = process.memoryUsage().heapUsed;
        metrics.memory.samples.push(heap);
        if (heap > metrics.memory.maxHeap) metrics.memory.maxHeap = heap;
      }
    };

    const workers = Array.from({ length: scenario.concurrency }, () =>
      runBatch()
    );
    await Promise.all(workers);
  } catch (err) {
    return {
      name: scenario.name,
      duration: scenario.duration,
      concurrency: scenario.concurrency,
      metrics,
<<<<<<< Updated upstream
      invariants: [
        {
          ok: false,
          message: `运行异常: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
=======
      invariants: [{ ok: false, message: `运行异常: ${err instanceof Error ? err.message : String(err)}` }],
>>>>>>> Stashed changes
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  metrics.memory.endHeap = process.memoryUsage().heapUsed;

  const sortedLatency = [...metrics.latency].sort((a, b) => a - b);
  const p95 = sortedLatency[Math.floor(sortedLatency.length * 0.95)] || 0;
  const p99 = sortedLatency[Math.floor(sortedLatency.length * 0.99)] || 0;

  const invariants: InvariantCheck[] = scenario.verify ? scenario.verify() : [];
  const invariantsOk = invariants.every((i) => i.ok);

<<<<<<< Updated upstream
  const errorRate =
    metrics.totalOps > 0 ? metrics.errors / metrics.totalOps : 0;
=======
  const errorRate = metrics.totalOps > 0 ? metrics.errors / metrics.totalOps : 0;
>>>>>>> Stashed changes
  // ops 门禁用全程平均吞吐（totalOps/duration）：min 窗口对长耗时 op 噪声大
  // （窗口内可能只完成 1-2 个 op），平均吞吐是更稳定的回归探测器
  const avgOpsPerSec = metrics.totalOps / (scenario.duration / 1000);
  const checkedOps = avgOpsPerSec >= scenario.expected.ops.min;
<<<<<<< Updated upstream
  const checkedMemory =
    metrics.memory.maxHeap - metrics.memory.startHeap <=
    scenario.expected.memory.maxHeap;
  const checkedLatency =
    p95 <= scenario.expected.latency.p95 &&
    p99 <= scenario.expected.latency.p99;
  const checkedErrorRate = errorRate <= scenario.expectedErrorRate;

  const passed =
    checkedOps &&
    checkedMemory &&
    checkedLatency &&
    checkedErrorRate &&
    invariantsOk;

  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${scenario.name}`);
  console.log(`  生产模块: ${scenario.modules.join(' / ')}`);
  console.log(
    `  ops/sec: avg=${avgOpsPerSec.toFixed(1)} (要求 >= ${scenario.expected.ops.min}) min窗口=${metrics.ops.min}`
  );
  console.log(
    `  内存: ${Math.round((metrics.memory.maxHeap - metrics.memory.startHeap) / 1024 / 1024)}MB (要求 <= ${Math.round(scenario.expected.memory.maxHeap / 1024 / 1024)}MB)`
  );
  console.log(
    `  延迟: p95=${Math.round(p95)}ms p99=${Math.round(p99)}ms (要求 p95<=${scenario.expected.latency.p95} p99<=${scenario.expected.latency.p99})`
  );
  console.log(
    `  错误率: ${(errorRate * 100).toFixed(1)}% (要求 <= ${(scenario.expectedErrorRate * 100).toFixed(0)}%)`
  );
  console.log(`  总操作: ${metrics.totalOps}`);
  for (const inv of invariants) {
    console.log(`  不变式 [${inv.ok ? 'OK' : 'VIOLATED'}] ${inv.message}`);
=======
  const checkedMemory = metrics.memory.maxHeap - metrics.memory.startHeap <= scenario.expected.memory.maxHeap;
  const checkedLatency = p95 <= scenario.expected.latency.p95 && p99 <= scenario.expected.latency.p99;
  const checkedErrorRate = errorRate <= scenario.expectedErrorRate;

  const passed = checkedOps && checkedMemory && checkedLatency && checkedErrorRate && invariantsOk;

  console.log(`[${passed ? "PASS" : "FAIL"}] ${scenario.name}`);
  console.log(`  生产模块: ${scenario.modules.join(" / ")}`);
  console.log(`  ops/sec: avg=${avgOpsPerSec.toFixed(1)} (要求 >= ${scenario.expected.ops.min}) min窗口=${metrics.ops.min}`);
  console.log(`  内存: ${Math.round((metrics.memory.maxHeap - metrics.memory.startHeap) / 1024 / 1024)}MB (要求 <= ${Math.round(scenario.expected.memory.maxHeap / 1024 / 1024)}MB)`);
  console.log(`  延迟: p95=${Math.round(p95)}ms p99=${Math.round(p99)}ms (要求 p95<=${scenario.expected.latency.p95} p99<=${scenario.expected.latency.p99})`);
  console.log(`  错误率: ${(errorRate * 100).toFixed(1)}% (要求 <= ${(scenario.expectedErrorRate * 100).toFixed(0)}%)`);
  console.log(`  总操作: ${metrics.totalOps}`);
  for (const inv of invariants) {
    console.log(`  不变式 [${inv.ok ? "OK" : "VIOLATED"}] ${inv.message}`);
>>>>>>> Stashed changes
  }

  return {
    name: scenario.name,
    duration: scenario.duration,
    concurrency: scenario.concurrency,
    metrics,
    invariants,
    passed,
  };
}

export async function runAllStressTests(scenarios: StressScenario[]): Promise<{
  results: StressResult[];
  summary: { total: number; passed: number; failed: number };
}> {
  const results: StressResult[] = [];

  for (const scenario of scenarios) {
    console.log(
      `\n开始压力测试: ${scenario.name} (${scenario.duration / 1000}s, 并发=${scenario.concurrency})`
    );
    const result = await runStressTest(scenario);
    results.push(result);
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log('\n' + '='.repeat(60));
  console.log('压力测试摘要');
  console.log('='.repeat(60));
  console.log(`总计: ${results.length}, 通过: ${passed}, 失败: ${failed}`);

  mkdirSync('perf-report', { recursive: true });
  writeFileSync(
    'perf-report/stress-result.json',
    JSON.stringify(
      { results, summary: { total: results.length, passed, failed } },
      null,
      2
    ),
    'utf8'
  );

  if (failed > 0) process.exitCode = 1;

  return { results, summary: { total: results.length, passed, failed } };
}
