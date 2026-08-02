import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

export interface StartupTarget {
  skeletonMs: number;
  interactiveMs: number;
  fullMs: number;
}

export interface StartupTest {
  name: string;
  measure: "cold" | "warm" | "hot";
  target: StartupTarget;
  command: string;
  args: string[];
  readyPattern?: string;
  timeoutMs?: number;
}

export interface StartupSample {
  skeletonMs: number;
  interactiveMs: number;
  fullMs: number;
  error?: string;
}

export interface StartupResult {
  name: string;
  measure: string;
  target: StartupTarget;
  samples: StartupSample[];
  avgSkeletonMs: number;
  avgInteractiveMs: number;
  avgFullMs: number;
  passed: boolean;
  error?: string;
}

export async function runStartupTest(test: StartupTest, iterations = 3): Promise<StartupResult> {
  const samples: StartupSample[] = [];
  const timeoutMs = test.timeoutMs || 30_000;

  try {
    for (let i = 0; i < iterations; i++) {
      const sample = await measureStartup(test, timeoutMs);
      samples.push(sample);

      console.log(
        `  [${i + 1}/${iterations}] skeleton=${Math.round(sample.skeletonMs)}ms ` +
          `interactive=${Math.round(sample.interactiveMs)}ms full=${Math.round(sample.fullMs)}ms`,
      );
    }
  } catch (err) {
    return {
      name: test.name,
      measure: test.measure,
      target: test.target,
      samples,
      avgSkeletonMs: Infinity,
      avgInteractiveMs: Infinity,
      avgFullMs: Infinity,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const avgSkeletonMs = samples.reduce((a, s) => a + s.skeletonMs, 0) / samples.length;
  const avgInteractiveMs = samples.reduce((a, s) => a + s.interactiveMs, 0) / samples.length;
  const avgFullMs = samples.reduce((a, s) => a + s.fullMs, 0) / samples.length;

  const passed =
    avgSkeletonMs <= test.target.skeletonMs &&
    avgInteractiveMs <= test.target.interactiveMs &&
    avgFullMs <= test.target.fullMs;

  return {
    name: test.name,
    measure: test.measure,
    target: test.target,
    samples,
    avgSkeletonMs: Math.round(avgSkeletonMs),
    avgInteractiveMs: Math.round(avgInteractiveMs),
    avgFullMs: Math.round(avgFullMs),
    passed,
  };
}

async function measureStartup(
  test: StartupTest,
  timeoutMs: number,
): Promise<StartupSample> {
  return new Promise((resolve, reject) => {
    const startTime = performance.now();
    let skeletonTime = 0;
    let interactiveTime = 0;
    let fullTime = 0;
    let settled = false;

    const child = spawn(test.command, test.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const settle = (fn: (value: StartupSample) => void, value: StartupSample) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const cleanup = () => {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
    };

    let buffer = "";

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();

        if (!skeletonTime && (trimmed.includes("skeleton") || trimmed.includes("ready"))) {
          skeletonTime = performance.now() - startTime;
        }

        if (!interactiveTime && (trimmed.includes("interactive") || trimmed.includes("listening on"))) {
          interactiveTime = performance.now() - startTime;
        }
      }
    });

    child.stderr.on("data", (_chunk: Buffer) => {
      /* ignore */
    });

    child.on("error", (err) => {
      settle(reject, err as unknown as never);
    });

    child.on("exit", (code) => {
      fullTime = performance.now() - startTime;
      if (!skeletonTime) skeletonTime = fullTime;
      if (!interactiveTime) interactiveTime = fullTime;

      if (code === 0 || code === null) {
        settle(resolve, { skeletonMs: skeletonTime, interactiveMs: interactiveTime, fullMs: fullTime });
      } else {
        settle(resolve, {
          skeletonMs: skeletonTime || fullTime,
          interactiveMs: interactiveTime || fullTime,
          fullMs: fullTime,
          error: `exit code ${code}`,
        });
      }
    });

    const timeout = setTimeout(() => {
      child.kill();
      fullTime = performance.now() - startTime;
      settle(resolve, {
        skeletonMs: skeletonTime || fullTime,
        interactiveMs: interactiveTime || fullTime,
        fullMs: fullTime,
        error: "timeout",
      });
    }, timeoutMs);

    child.on("exit", () => clearTimeout(timeout));
  });
}

export async function runAllStartupTests(tests: StartupTest[]): Promise<{
  results: StartupResult[];
  summary: { total: number; passed: number; failed: number };
}> {
  const results: StartupResult[] = [];

  for (const test of tests) {
    console.log(`\n启动测试: ${test.name} (${test.measure})`);
    const result = await runStartupTest(test);
    results.push(result);

    const status = result.passed ? "PASS" : "FAIL";
    console.log(
      `[${status}] ${result.name}: skeleton=${result.avgSkeletonMs}ms ` +
        `interactive=${result.avgInteractiveMs}ms full=${result.avgFullMs}ms`,
    );
    if (result.error) console.error(`  error: ${result.error}`);
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log("\n" + "=".repeat(60));
  console.log("启动测试摘要");
  console.log(`总计: ${results.length}, 通过: ${passed}, 失败: ${failed}`);

  mkdirSync("perf-report", { recursive: true });
  writeFileSync("perf-report/startup-result.json", JSON.stringify({ results, summary: { total: results.length, passed, failed } }, null, 2), "utf8");

  if (failed > 0) process.exitCode = 1;

  return { results, summary: { total: results.length, passed, failed } };
}
