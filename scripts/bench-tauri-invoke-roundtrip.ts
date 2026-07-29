/**
 * Stream F 基准：Tauri invoke 往返开销
 *
 * 目标：测量 Tauri invoke 封装层（tauriInvoke.ts 的 invokeResult / invokeCmd）
 * 的 JS 侧往返开销，建立 Stream C/D/E 切换 invoke 路径前后的基线。
 *
 * 测量矩阵：
 *   1. missing 路径 — Tauri 运行时不可用（Node 环境 baseline）
 *      覆盖 getTauriInvoke() → null → return missing 的完整代码路径
 *   2. ok 路径 — 使用 mock invoke（同步返回），测量 try/catch + 对象包装开销
 *      真实 IPC 开销 = 此测量值 + Tauri runtime IPC 延迟（需在 Tauri 环境补充）
 *   3. error 路径 — mock invoke 抛错，测量错误格式化 + isMissingCommandMessage 开销
 *   4. 批量 100 次 — 顺序 invoke 的累计开销（tauri.invoke.batch.100）
 *   5. 并发 100 次 — Promise.all 并发 invoke 的开销
 *
 * 可重复执行：npx tsx scripts/bench-tauri-invoke-roundtrip.ts
 * 输出：perf-report/bench-tauri-invoke-roundtrip.json
 */
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// =============================================================================
// 导入真实的 invokeResult / invokeCmd（测量 missing 路径的真实开销）
// =============================================================================
import {
  invokeResult as realInvokeResult,
  invokeCmd as realInvokeCmd,
} from '../apps/crish-desktop/src/api/tauriInvoke';

// =============================================================================
// mock invoke：模拟 Tauri runtime 的 invoke 函数（同步返回，无 IPC 延迟）
// 用于测量 invokeResult/invokeCmd 封装层在 ok / error 路径的 JS 侧开销。
// 真实 IPC 延迟需在 Tauri 环境中补充测量。
// =============================================================================

type MockInvokeState = 'ok' | 'error' | 'missing';

let mockState: MockInvokeState = 'ok';
let mockCallCount = 0;

function resetMock(state: MockInvokeState = 'ok'): void {
  mockState = state;
  mockCallCount = 0;
}

/**
 * mock invoke：忠实复刻 @tauri-apps/api/core 的 invoke 签名。
 * ok 状态返回 null（无操作 command 的最小返回值）。
 * error 状态抛出非 missing 模式的错误（触发 invokeResult 的 error 分支）。
 */
async function mockInvoke(cmd: string, args?: unknown): Promise<unknown> {
  mockCallCount++;
  // 模拟 IPC 的 async tick（真实 invoke 至少经过一次 microtask）
  await Promise.resolve();
  if (mockState === 'error') {
    throw new Error(`mock invoke error for ${cmd}`);
  }
  // ok 路径：无操作 command 返回 null
  return null;
}

// =============================================================================
// invokeResult / invokeCmd 副本：忠实复刻 tauriInvoke.ts 的封装逻辑，
// 但使用 mockInvoke 替代 getTauriInvoke()，以测量 ok / error 路径。
// =============================================================================

type InvokeOk<T> = { status: 'ok'; data: T };
type InvokeMissing = { status: 'missing' };
type InvokeErr = { status: 'error'; message: string };
type InvokeResult<T> = InvokeOk<T> | InvokeMissing | InvokeErr;

function formatInvokeError(err: unknown): string {
  if (err == null) return '未知错误';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    if (typeof o.message === 'string') return o.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

function isMissingCommandMessage(msg: string): boolean {
  return /not allowed|command .* not found|unknown command|not implemented|Cannot find module|Failed to fetch dynamically/i.test(
    msg,
  );
}

async function mockInvokeResult<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<InvokeResult<T>> {
  try {
    const data = (await mockInvoke(cmd, args)) as T;
    return { status: 'ok', data };
  } catch (err) {
    const msg = formatInvokeError(err);
    if (isMissingCommandMessage(msg)) return { status: 'missing' };
    return { status: 'error', message: msg };
  }
}

async function mockInvokeCmd<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  const res = await mockInvokeResult<T>(cmd, args);
  if (res.status === 'ok') return res.data;
  return null;
}

// =============================================================================
// 基准测量工具
// =============================================================================

interface BenchSample {
  index: number;
  elapsedMs: number;
}

interface BenchResult {
  name: string;
  iterations: number;
  warmupIterations: number;
  samples: BenchSample[];
  warmupSamples: BenchSample[];
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  ops: number;
}

function percentile(sorted: number[], rank: number): number {
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * rank) - 1),
  );
  return Math.round(sorted[i]! * 1000) / 1000;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

async function bench(
  name: string,
  fn: () => Promise<unknown>,
  iterations: number,
  warmupIterations: number,
): Promise<BenchResult> {
  const warmupSamples: BenchSample[] = [];
  const samples: BenchSample[] = [];

  for (let i = 0; i < warmupIterations; i++) {
    const start = performance.now();
    await fn();
    warmupSamples.push({ index: i, elapsedMs: performance.now() - start });
  }

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    samples.push({ index: i, elapsedMs: performance.now() - start });
  }

  const values = samples.map((s) => s.elapsedMs).sort((a, b) => a - b);
  const avgMs = values.reduce((a, b) => a + b, 0) / values.length;

  return {
    name,
    iterations,
    warmupIterations,
    samples,
    warmupSamples,
    avgMs: round3(avgMs),
    minMs: round3(values[0]!),
    maxMs: round3(values[values.length - 1]!),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    ops: avgMs > 0 ? Math.round(1000 / avgMs) : 0,
  };
}

// =============================================================================
// 基准场景
// =============================================================================

const NOOP_CMD = 'core_noop';
const BATCH_SIZE = 100;

async function scenarioRealMissingInvokeResult(): Promise<void> {
  await realInvokeResult(NOOP_CMD, { ping: 1 });
}

async function scenarioRealMissingInvokeCmd(): Promise<void> {
  await realInvokeCmd(NOOP_CMD, { ping: 1 });
}

async function scenarioMockOkInvokeResult(): Promise<void> {
  resetMock('ok');
  await mockInvokeResult(NOOP_CMD, { ping: 1 });
}

async function scenarioMockOkInvokeCmd(): Promise<void> {
  resetMock('ok');
  await mockInvokeCmd(NOOP_CMD, { ping: 1 });
}

async function scenarioMockErrorInvokeResult(): Promise<void> {
  resetMock('error');
  await mockInvokeResult(NOOP_CMD, { ping: 1 });
}

async function scenarioBatch100Sequential(): Promise<void> {
  resetMock('ok');
  for (let i = 0; i < BATCH_SIZE; i++) {
    await mockInvokeResult(NOOP_CMD, { seq: i });
  }
}

async function scenarioBatch100Concurrent(): Promise<void> {
  resetMock('ok');
  const tasks: Promise<InvokeResult<unknown>>[] = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    tasks.push(mockInvokeResult(NOOP_CMD, { seq: i }));
  }
  await Promise.all(tasks);
}

interface BenchReport {
  name: string;
  timestamp: string;
  environment: string;
  note: string;
  results: BenchResult[];
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('基准：tauri.invoke.roundtrip');
  console.log('='.repeat(60));
  console.log('环境: Node (无 Tauri runtime)');
  console.log('说明: ok 路径使用 mock invoke，仅测量 JS 封装层开销；');
  console.log('      真实 IPC 延迟需在 Tauri 环境补充测量。');

  const iterations = 200;
  const warmupIterations = 20;
  const results: BenchResult[] = [];

  const scenarios: Array<{ name: string; fn: () => Promise<unknown> }> = [
    { name: 'invokeResult.missing', fn: scenarioRealMissingInvokeResult },
    { name: 'invokeCmd.missing', fn: scenarioRealMissingInvokeCmd },
    { name: 'invokeResult.ok', fn: scenarioMockOkInvokeResult },
    { name: 'invokeCmd.ok', fn: scenarioMockOkInvokeCmd },
    { name: 'invokeResult.error', fn: scenarioMockErrorInvokeResult },
    { name: 'invoke.batch.100.sequential', fn: scenarioBatch100Sequential },
    { name: 'invoke.batch.100.concurrent', fn: scenarioBatch100Concurrent },
  ];

  for (const { name, fn } of scenarios) {
    console.log(`\n[${name}]`);
    const result = await bench(name, fn, iterations, warmupIterations);
    results.push(result);
    console.log(
      `  avg=${result.avgMs}ms  p50=${result.p50Ms}ms  p95=${result.p95Ms}ms  ops=${result.ops}`,
    );
  }

  console.log('\n' + '-'.repeat(60));
  console.log('汇总:');
  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(36)} avg=${r.avgMs}ms p95=${r.p95Ms}ms ops=${r.ops}`,
    );
  }

  const report: BenchReport = {
    name: 'tauri.invoke.roundtrip',
    timestamp: new Date().toISOString(),
    environment: 'node-no-tauri-runtime',
    note:
      'ok/error 路径使用 mock invoke（同步返回），仅测量 JS 封装层开销。' +
      '真实 Tauri IPC 延迟需在 Tauri 运行时环境中补充测量。' +
      'missing 路径使用真实 invokeResult/invokeCmd（@tauri-apps/api/core 不可用）。',
    results,
  };

  const reportPath = 'perf-report/bench-tauri-invoke-roundtrip.json';
  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n报告已保存到 ${reportPath}`);
}

main().catch((err) => {
  console.error('基准测试失败:', err);
  process.exitCode = 1;
});
