import { runAllMemBenchmarks } from "./mem-benchmark";
import { MEM_BENCHMARKS } from "./mem-bench-definitions";

async function main() {
  console.log("=".repeat(60));
  console.log("内存基准测试");
  console.log("=".repeat(60));
  console.log("注意: 请使用 node --expose-gc 运行此脚本\n");

  const result = await runAllMemBenchmarks(MEM_BENCHMARKS);

  console.log("\n" + "=".repeat(60));
  console.log("摘要");
  console.log("-".repeat(60));
  console.log(`总计: ${result.summary.total}`);
  console.log(`通过: ${result.summary.passed}`);
  console.log(`失败: ${result.summary.failed}`);

  const reportPath = "perf-report/mem-benchmark-result.json";
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
  console.error("内存测试失败:", err);
  process.exitCode = 1;
});
