#!/usr/bin/env node
/**
 * TSC error-count gate (guardrail 26).
 *
 * Runs `npx tsc --noEmit`, parses the error count, and compares against a
 * threshold. Pass = error count strictly less than threshold.
 *
 * Env:
 *   TSC_ERROR_THRESHOLD — threshold, default 50 (guardrail 26 Round 11 target)
 *
 * Run: node scripts/check-tsc-threshold.mjs
 */

import { execSync } from 'node:child_process';

// ── --guide（T-DEBT-08：正确做法指引 · 五元规约） ─────────────────────────────
// 用法：node scripts/check-tsc-threshold.mjs --guide → 打印违反项/定位/阈值/正确做法。
// 仅在直接运行且带 --guide 时早退；不带 flag 时既有行为零变化。
const __debt08GuideFlag = process.argv.includes('--guide');
if (__debt08GuideFlag) {
  const __debt08Guide = [
    "违反项：`npx tsc --noEmit` 错误数 ≥ 阈值。",
    "文件:行号 / 当前值：输出错误总数与阈值对比；明细见 tsc 输出。",
    "阈值：默认 50（guardrail 26 Round 11），可用 env TSC_ERROR_THRESHOLD 覆盖；语义为严格小于。",
    "正确做法：修掉真实错误使计数下降；降下来后显式下调 env 阈值锁住成果；禁止抬阈值还债。",
    "复核：node scripts/check-tsc-threshold.mjs  # 期望 PASS",
  ];
  console.log('[check-tsc-threshold] 正确做法 · 五元规约\n');
  for (const l of __debt08Guide) console.log('  ' + l);
  process.exit(0);
}

const THRESHOLD = parseInt(process.env.TSC_ERROR_THRESHOLD ?? '50', 10);

if (!Number.isFinite(THRESHOLD) || THRESHOLD < 0) {
  console.error(
    `check-tsc-threshold: invalid TSC_ERROR_THRESHOLD="${process.env.TSC_ERROR_THRESHOLD}"`
  );
  process.exit(2);
}

console.log(`check-tsc-threshold: running tsc --noEmit (threshold < ${THRESHOLD})...`);

let output = '';
try {
  execSync('npx tsc --noEmit', {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  // tsc exited 0 — no errors.
} catch (err) {
  output = err.stderr?.toString() ?? err.stdout?.toString() ?? '';
}

// tsc error line format: file(line,col): error TSxxxx: message
const errorLines = output
  .split(/\r?\n/)
  .filter((line) => /\berror TS\d+:/i.test(line));
const errorCount = errorLines.length;

console.log(`check-tsc-threshold: TSC error count = ${errorCount}`);

if (errorCount >= THRESHOLD) {
  console.error(
    `check-tsc-threshold: FAIL — ${errorCount} errors >= threshold ${THRESHOLD}`
  );
  if (errorLines.length > 0) {
    console.error('\nFirst 20 errors:');
    for (const line of errorLines.slice(0, 20)) {
      console.error(`  ${line}`);
    }
  }
  process.exit(1);
}

console.log(
  `check-tsc-threshold: PASS — ${errorCount} errors < threshold ${THRESHOLD}`
);
