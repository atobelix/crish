import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

interface EnvInfo {
  os: string;
  cpu: string;
  memory: string;
  nodeVersion: string;
}

interface BenchResult {
  name: string;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  ops: number;
  targetMs: number;
  passed: boolean;
}

interface MemTestResult {
  name: string;
  heapDelta: number;
  leakedListeners: number;
  passed: boolean;
}

interface Regression {
  name: string;
  previousAvgMs: number;
  currentAvgMs: number;
  changePercent: number;
}

interface PerfReport {
  commit: string;
  timestamp: string;
  environment: EnvInfo;
  benchmarks: BenchResult[];
  memTests: MemTestResult[];
  summary: {
    totalBenchmarks: number;
    passed: number;
    failed: number;
    regressions: Regression[];
  };
}

function getCommitHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function loadJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const benchmarkResult = loadJson("perf-report/benchmark-result.json") as Record<string, unknown> | null;
  const memResult = loadJson("perf-report/mem-benchmark-result.json") as Record<string, unknown> | null;
  const comparisonResult = loadJson("perf-report/comparison-result.json") as Record<string, unknown> | null;

  const environment: EnvInfo = benchmarkResult
    ? (benchmarkResult.environment as EnvInfo)
    : { os: process.platform, cpu: "unknown", memory: "unknown", nodeVersion: process.version };

  const benchmarks: BenchResult[] = benchmarkResult
    ? (benchmarkResult.benchmarks as Array<Record<string, unknown>>).map((b) => ({
        name: b.name as string,
        avgMs: b.avgMs as number,
        p50Ms: b.p50Ms as number,
        p95Ms: b.p95Ms as number,
        p99Ms: b.p99Ms as number,
        ops: b.ops as number,
        targetMs: ((b.target as Record<string, unknown>)?.maxMs as number) ?? 0,
        passed: b.passed as boolean,
      }))
    : [];

  const memTests: MemTestResult[] = memResult
    ? (memResult.tests as Array<Record<string, unknown>>).map((t) => ({
        name: t.name as string,
        heapDelta: t.maxHeapDelta as number,
        leakedListeners: t.maxListenerDelta as number,
        passed: t.passed as boolean,
      }))
    : [];

  const regressions: Regression[] = comparisonResult
    ? (comparisonResult.regressions as Regression[])
    : [];

  const passedBenchmarks = benchmarks.filter((b) => b.passed).length;
  const failedBenchmarks = benchmarks.filter((b) => !b.passed).length;

  const report: PerfReport = {
    commit: getCommitHash(),
    timestamp: new Date().toISOString(),
    environment,
    benchmarks,
    memTests,
    summary: {
      totalBenchmarks: benchmarks.length + memTests.length,
      passed: passedBenchmarks + memTests.filter((t) => t.passed).length,
      failed: failedBenchmarks + memTests.filter((t) => !t.passed).length,
      regressions,
    },
  };

  const html = generateHtml(report);

  mkdirSync("perf-report", { recursive: true });
  writeFileSync("perf-report/report.json", JSON.stringify(report, null, 2), "utf8");
  writeFileSync("perf-report/report.html", html, "utf8");

  console.log("=".repeat(60));
  console.log("性能报告");
  console.log("=".repeat(60));
  console.log(`Commit: ${report.commit}`);
  console.log(`时间: ${report.timestamp}`);
  console.log(`环境: ${environment.os} / ${environment.nodeVersion}`);
  console.log(`\n基准测试: ${benchmarks.length} (通过: ${passedBenchmarks}, 失败: ${failedBenchmarks})`);
  console.log(`内存测试: ${memTests.length} (通过: ${memTests.filter((t) => t.passed).length}, 失败: ${memTests.filter((t) => !t.passed).length})`);
  if (regressions.length > 0) {
    console.log(`\n退化: ${regressions.length}`);
    for (const r of regressions) {
      console.log(`  ${r.name}: ${r.previousAvgMs}ms -> ${r.currentAvgMs}ms (+${r.changePercent}%)`);
    }
  }
  console.log("\n报告已保存到 perf-report/report.html");
}

function generateHtml(report: PerfReport): string {
  const benchRows = report.benchmarks
    .map(
      (b) => `<tr class="${b.passed ? "pass" : "fail"}">
      <td>${b.name}</td>
      <td>${b.avgMs}ms</td>
      <td>${b.p50Ms}ms</td>
      <td>${b.p95Ms}ms</td>
      <td>${b.p99Ms}ms</td>
      <td>${b.ops}/s</td>
      <td>${b.targetMs}ms</td>
      <td>${b.passed ? "PASS" : "FAIL"}</td>
    </tr>`,
    )
    .join("\n");

  const memRows = report.memTests
    .map(
      (t) => `<tr class="${t.passed ? "pass" : "fail"}">
      <td>${t.name}</td>
      <td>${(t.heapDelta / 1024).toFixed(1)}KB</td>
      <td>${t.leakedListeners}</td>
      <td>${t.passed ? "PASS" : "FAIL"}</td>
    </tr>`,
    )
    .join("\n");

  const regRows = report.summary.regressions
    .map(
      (r) => `<tr class="regression">
      <td>${r.name}</td>
      <td>${r.previousAvgMs}ms</td>
      <td>${r.currentAvgMs}ms</td>
      <td class="bad">+${r.changePercent}%</td>
    </tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>性能报告 - ${report.commit}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 960px; margin: 40px auto; padding: 0 20px; background: #f5f5f5; }
h1 { color: #333; }
h2 { color: #555; margin-top: 32px; }
table { width: 100%; border-collapse: collapse; margin: 16px 0; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #eee; }
th { background: #fafafa; font-weight: 600; color: #444; }
tr.pass { background: #f0fdf4; }
tr.fail { background: #fef2f2; }
tr.regression { background: #fff7ed; }
.bad { color: #dc2626; font-weight: 600; }
.good { color: #16a34a; }
.summary { display: flex; gap: 24px; margin: 16px 0; }
.card { background: #fff; padding: 16px 24px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); flex: 1; }
.card h3 { margin: 0 0 8px; font-size: 14px; color: #666; }
.card .value { font-size: 28px; font-weight: 700; color: #333; }
.meta { color: #888; font-size: 13px; }
</style>
</head>
<body>
<h1>性能报告</h1>
<p class="meta">
  Commit: ${report.commit} | ${report.timestamp}<br>
  环境: ${report.environment.os} / ${report.environment.nodeVersion}
</p>

<div class="summary">
  <div class="card">
    <h3>基准测试</h3>
    <div class="value">${report.benchmarks.length}</div>
    <div>通过: ${report.benchmarks.filter(b => b.passed).length} / 失败: ${report.benchmarks.filter(b => !b.passed).length}</div>
  </div>
  <div class="card">
    <h3>内存测试</h3>
    <div class="value">${report.memTests.length}</div>
    <div>通过: ${report.memTests.filter(t => t.passed).length} / 失败: ${report.memTests.filter(t => !t.passed).length}</div>
  </div>
  <div class="card">
    <h3>退化</h3>
    <div class="value">${report.summary.regressions.length}</div>
    <div>总计: ${report.summary.totalBenchmarks} 项</div>
  </div>
</div>

${benchRows ? `<h2>基准测试结果</h2>
<table>
<thead><tr><th>名称</th><th>平均</th><th>P50</th><th>P95</th><th>P99</th><th>吞吐量</th><th>目标</th><th>状态</th></tr></thead>
<tbody>${benchRows}</tbody>
</table>` : ""}

${memRows ? `<h2>内存测试结果</h2>
<table>
<thead><tr><th>名称</th><th>堆增长</th><th>泄漏监听器</th><th>状态</th></tr></thead>
<tbody>${memRows}</tbody>
</table>` : ""}

${regRows ? `<h2>性能退化</h2>
<table>
<thead><tr><th>名称</th><th>之前</th><th>当前</th><th>变化</th></tr></thead>
<tbody>${regRows}</tbody>
</table>` : ""}

</body>
</html>`;
}

main();
