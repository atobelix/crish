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
