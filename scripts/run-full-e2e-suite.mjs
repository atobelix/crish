import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const ROOT_DIR = process.cwd();
const ARTIFACTS_DIR = resolve(ROOT_DIR, 'scratch/reports');

if (!existsSync(ARTIFACTS_DIR)) {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

console.log(`\n=======================================================`);
console.log(`🚀 Conex E2E 自动化一键巡检与集成测试套件执行器`);
console.log(`=======================================================\n`);

const testSuites = [
  {
    name: 'L1: Agent Protocol Headless E2E',
    cmd: 'npx',
    args: ['vitest', 'run', 'packages/agent-daemon/src/__tests__/agent-protocol.e2e.test.ts', '--reporter=basic'],
  },
  {
    name: 'L1-Ext: Agent Real Workflow & Tool Approval E2E',
    cmd: 'npx',
    args: ['vitest', 'run', 'packages/agent-daemon/src/__tests__/agent-real-workflow-e2e.test.ts', '--reporter=basic'],
  },
  {
    name: 'L2: UI State & Store Invariants E2E',
    cmd: 'npx',
    args: ['vitest', 'run', 'apps/crish-desktop/src/__tests__/agentWorkflowUIIntegration.test.ts', '--reporter=basic'],
  },
  {
    name: 'L2-Ext: Playwright UI & Store Update Guard E2E',
    cmd: 'node',
    args: ['scripts/audit-ui-runtime-errors.mjs'],
  },
  {
    name: 'L2-Chaos: Chaos Resilience & Anti-Jitter E2E',
    cmd: 'npx',
    args: ['vitest', 'run', 'apps/crish-desktop/src/__tests__/chaosAndResilience.test.ts', '--reporter=basic'],
  },
  {
    name: 'L2-Perf: Performance & Memory Leak E2E',
    cmd: 'npx',
    args: ['vitest', 'run', 'apps/crish-desktop/src/__tests__/memoryLeak.test.tsx', '--reporter=basic'],
  },
  {
    name: 'L3: Desktop Native Smoke E2E',
    cmd: 'npx',
    args: ['vitest', 'run', 'tests/e2e/tauri-native-smoke.spec.ts', '--reporter=basic'],
  },
  {
    name: 'L3-Native: Native Deep Features E2E',
    cmd: 'npx',
    args: ['vitest', 'run', 'apps/crish-desktop/src/api/desktopNativeFeatures.test.ts', '--reporter=basic'],
  },
];

async function runTask(task) {
  const startTime = Date.now();
  console.log(`▶ 正在运行自动化测试套件: [${task.name}]...`);

  return new Promise((res) => {
    const proc = spawn(task.cmd, task.args, {
      cwd: ROOT_DIR,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.stderr.on('data', (d) => { output += d.toString(); });

    proc.on('close', (code) => {
      const durationMs = Date.now() - startTime;
      const passed = code === 0;
      if (passed) {
        console.log(`✅ [${task.name}] 测试通过 (${(durationMs / 1000).toFixed(2)}s)`);
      } else {
        console.error(`❌ [${task.name}] 测试失败 (退出码: ${code}, 耗延时: ${(durationMs / 1000).toFixed(2)}s)`);
      }
      res({
        name: task.name,
        passed,
        durationMs,
        output: output.slice(-1000),
      });
    });
  });
}

async function main() {
  const results = [];
  for (const suite of testSuites) {
    const result = await runTask(suite);
    results.push(result);
  }

  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.filter((r) => !r.passed).length;
  const totalDuration = results.reduce((acc, r) => acc + r.durationMs, 0);

  console.log(`\n=======================================================`);
  console.log(`📊 全量 E2E 自动化测试套件汇总结果`);
  console.log(`=======================================================`);
  console.log(`测试套件总数: ${results.length}`);
  console.log(`通过套件: ${passedCount}`);
  console.log(`失败套件: ${failedCount}`);
  console.log(`总耗时: ${(totalDuration / 1000).toFixed(2)}s`);
  console.log(`=======================================================\n`);

  const reportPath = resolve(ARTIFACTS_DIR, 'e2e-full-report.json');
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        summary: { total: results.length, passed: passedCount, failed: failedCount, durationMs: totalDuration },
        results,
      },
      null,
      2
    )
  );

  console.log(`📁 自动化报告已成功生成至: ${reportPath}\n`);

  if (failedCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('一键自动化测试执行过程中抛出未捕获异常:', err);
  process.exit(1);
});
