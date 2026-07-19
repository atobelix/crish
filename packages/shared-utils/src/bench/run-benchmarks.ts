import { runAllBenchmarks } from "./perf-benchmark";
import { BENCHMARKS } from "./bench-definitions";

async function main() {
  console.log("=".repeat(60));
  console.log("性能基准测试");
  console.log("=".repeat(60));

  const result = await runAllBenchmarks(BENCHMARKS);

  console.log("\n" + "=".repeat(60));
  console.log("摘要");
  console.log("-".repeat(60));
  console.log(`总计: ${result.summary.total}`);
  console.log(`通过: ${result.summary.passed}`);
  console.log(`失败: ${result.summary.failed}`);
  console.log(`时间: ${result.timestamp}`);
  console.log(`环境: ${result.environment.os} / Node ${result.environment.nodeVersion}`);

  const reportPath = "perf-report/benchmark-result.json";
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(result, null, 2), "utf8");
  console.log(`\n报告已保存到 ${reportPath}`);

  if (result.summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("基准测试失败:", err);
  process.exitCode = 1;
});
