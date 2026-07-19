import { readFileSync, existsSync } from "node:fs";

interface PerfResult {
  name: string;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  ops: number;
  passed: boolean;
}

function main() {
  const path = "perf-report/benchmark-result.json";
  if (!existsSync(path)) {
    console.error(`报告文件不存在: ${path}`);
    console.error("请先运行 npm run bench");
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(path, "utf8"));
  const benchmarks: PerfResult[] = data.benchmarks || [];

  const nameLen = Math.max(23, ...benchmarks.map((b) => b.name.length));
  const sep = `├${"─".repeat(nameLen + 2)}┼${"─".repeat(10)}┼${"─".repeat(10)}┼${"─".repeat(10)}┼${"─".repeat(10)}┼${"─".repeat(10)}┼${"─".repeat(8)}┤`;
  const top = `┌${"─".repeat(nameLen + 2)}┬${"─".repeat(10)}┬${"─".repeat(10)}┬${"─".repeat(10)}┬${"─".repeat(10)}┬${"─".repeat(10)}┬${"─".repeat(8)}┐`;
  const bot = `└${"─".repeat(nameLen + 2)}┴${"─".repeat(10)}┴${"─".repeat(10)}┴${"─".repeat(10)}┴${"─".repeat(10)}┴${"─".repeat(10)}┴${"─".repeat(8)}┘`;
  const hdr = `│ ${"Benchmark".padEnd(nameLen)} │ Avg (ms) │ Min (ms) │ Max (ms) │ P50 (ms) │ P95 (ms) │ Status │`;

  console.log(top);
  console.log(hdr);
  console.log(sep);

  for (const b of benchmarks) {
    const name = b.name.padEnd(nameLen);
    const avg = String(b.avgMs.toFixed(1)).padStart(8);
    const min = String(b.minMs.toFixed(1)).padStart(8);
    const max = String(b.maxMs.toFixed(1)).padStart(8);
    const p50 = String(b.p50Ms.toFixed(1)).padStart(8);
    const p95 = String(b.p95Ms.toFixed(1)).padStart(8);
    const status = b.passed ? " PASS " : " FAIL ";
    console.log(`│ ${name} │ ${avg} │ ${min} │ ${max} │ ${p50} │ ${p95} │${status}│`);
  }

  console.log(bot);

  const passed = benchmarks.filter((b) => b.passed).length;
  const failed = benchmarks.filter((b) => !b.passed).length;
  console.log(`\n总计: ${benchmarks.length} | 通过: ${passed} | 失败: ${failed}`);
  console.log(`环境: ${data.environment?.os || "?"} / Node ${data.environment?.nodeVersion || "?"}`);
}

main();
