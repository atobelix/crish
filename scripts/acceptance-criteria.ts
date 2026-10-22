import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';

interface AcceptanceEntry {
  module: string;
  benchmarks: string[];
  targets: Record<string, number>;
  memBenchmarks?: string[];
  startupTests?: string[];
}

interface BenchResult {
  name: string;
  avgMs: number;
  passed: boolean;
}

interface MemResult {
  name: string;
  maxHeapDelta: number;
  maxListenerDelta: number;
  passed: boolean;
}

const ACCEPTANCE_CRITERIA: AcceptanceEntry[] = [
  {
    module: 'BoundedMap / LruMap',
    benchmarks: ['bounded-map.set.10k', 'lru.cache.10k.hits'],
    targets: { 'bounded-map.set.10k': 10, 'lru.cache.10k.hits': 5 },
    memBenchmarks: ['cache.eviction.no-leak', 'lru-map.no-leak'],
  },
  {
    module: 'JsonlAppendBatcher',
    benchmarks: ['jsonl.append.1000'],
    targets: { 'jsonl.append.1000': 10 },
    memBenchmarks: ['jsonl-batcher.no-leak'],
  },
  {
    module: 'AsyncMutex',
    benchmarks: ['async-mutex.contention.100'],
    targets: { 'async-mutex.contention.100': 5 },
    memBenchmarks: ['async-mutex.no-leak'],
  },
  {
    module: 'RingBuffer',
    benchmarks: ['ring-buffer.10k.rw'],
    targets: { 'ring-buffer.10k.rw': 5 },
    memBenchmarks: ['ring-buffer.no-leak'],
  },
  {
    module: '工具函数',
    benchmarks: ['deep-equal.1k.props', 'object.clone.1k'],
    targets: { 'deep-equal.1k.props': 1, 'object.clone.1k': 2 },
  },
];

interface AcceptanceResult {
  timestamp: string;
  modules: Array<{
    name: string;
    passed: boolean;
    perfPassed: number;
    perfFailed: number;
    memPassed: number;
    memFailed: number;
    details: string[];
  }>;
  summary: {
    totalModules: number;
    passedModules: number;
    failedModules: number;
  };
}

function loadBenchResults(): BenchResult[] {
  const path = 'perf-report/benchmark-result.json';
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return raw.benchmarks.map((b: Record<string, unknown>) => ({
    name: b.name as string,
    avgMs: b.avgMs as number,
    passed: b.passed as boolean,
  }));
}

function loadMemResults(): MemResult[] {
  const path = 'perf-report/mem-benchmark-result.json';
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return raw.tests.map((t: Record<string, unknown>) => ({
    name: t.name as string,
    maxHeapDelta: t.maxHeapDelta as number,
    maxListenerDelta: t.maxListenerDelta as number,
    passed: t.passed as boolean,
  }));
}

function matchName(pattern: string, name: string): boolean {
  if (pattern.includes('*')) {
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
    );
    return regex.test(name);
  }
  return pattern === name;
}

function main() {
  const benchResults = loadBenchResults();
  const memResults = loadMemResults();

  const results: AcceptanceResult['modules'] = [];
  let passedModules = 0;
  let failedModules = 0;

  for (const criteria of ACCEPTANCE_CRITERIA) {
    const details: string[] = [];
    let perfPassed = 0;
    let perfFailed = 0;

    for (const benchPattern of criteria.benchmarks) {
      const matched = benchResults.filter((b) =>
        matchName(benchPattern, b.name)
      );
      if (matched.length === 0) {
        details.push(`基准未找到: ${benchPattern}`);
        perfFailed++;
        continue;
      }
      for (const b of matched) {
        const target = criteria.targets[b.name];
        if (target !== undefined) {
          if (b.avgMs <= target) {
            details.push(`${b.name}: ${b.avgMs}ms <= ${target}ms [PASS]`);
            perfPassed++;
          } else {
            details.push(`${b.name}: ${b.avgMs}ms > ${target}ms [FAIL]`);
            perfFailed++;
          }
        } else {
          details.push(`${b.name}: ${b.passed ? 'PASS' : 'FAIL'} (无精确目标)`);
          if (b.passed) perfPassed++;
          else perfFailed++;
        }
      }
    }

    let memPassed = 0;
    let memFailed = 0;
    if (criteria.memBenchmarks) {
      for (const memPattern of criteria.memBenchmarks) {
        const matched = memResults.filter((m) => matchName(memPattern, m.name));
        if (matched.length === 0) {
          details.push(`内存测试未找到: ${memPattern}`);
          memFailed++;
          continue;
        }
        for (const m of matched) {
          if (m.passed) {
            details.push(
              `${m.name}: heap=${(m.maxHeapDelta / 1024).toFixed(1)}KB listeners=${m.maxListenerDelta} [PASS]`
            );
            memPassed++;
          } else {
            details.push(
              `${m.name}: heap=${(m.maxHeapDelta / 1024).toFixed(1)}KB [FAIL]`
            );
            memFailed++;
          }
        }
      }
    }

    const modulePassed = perfFailed === 0 && memFailed === 0;
    if (modulePassed) passedModules++;
    else failedModules++;

    results.push({
      name: criteria.module,
      passed: modulePassed,
      perfPassed,
      perfFailed,
      memPassed,
      memFailed,
      details,
    });
  }

  const acceptanceResult: AcceptanceResult = {
    timestamp: new Date().toISOString(),
    modules: results,
    summary: {
      totalModules: ACCEPTANCE_CRITERIA.length,
      passedModules,
      failedModules,
    },
  };

  console.log('='.repeat(60));
  console.log('验收标准检查');
  console.log('='.repeat(60));

  for (const mod of results) {
    const status = mod.passed ? 'PASS' : 'FAIL';
    console.log(`\n[${status}] ${mod.name}`);
    for (const d of mod.details) {
      console.log(`  ${d}`);
    }
  }

  console.log('\n' + '-'.repeat(60));
  console.log(`摘要: ${passedModules}/${ACCEPTANCE_CRITERIA.length} 模块通过`);
  if (failedModules > 0) {
    console.log(
      `失败模块: ${results
        .filter((r) => !r.passed)
        .map((r) => r.name)
        .join(', ')}`
    );
  }

  mkdirSync('perf-report', { recursive: true });
  writeFileSync(
    'perf-report/acceptance-result.json',
    JSON.stringify(acceptanceResult, null, 2),
    'utf8'
  );
  console.log('\n验收结果已保存到 perf-report/acceptance-result.json');

  if (failedModules > 0) {
    process.exitCode = 1;
  }
}

main();
