#!/usr/bin/env node
/**
 * Test-coverage gate.
 *
 * Reads coverage/coverage-summary.json (produced by `vitest run --coverage`)
 * and checks statement coverage for key packages against per-package
 * thresholds. Exits 1 if any package is below its threshold.
 *
 * If the coverage file is missing, or a gated package has no coverage data,
 * the gate FAILS (exit 1): a missing report means the coverage run did not
 * happen or the json-summary reporter / include globs regressed, and silently
 * passing would turn the gate into a no-op.
 *
 * Run: node scripts/check-coverage-threshold.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── --guide（T-DEBT-08：正确做法指引 · 五元规约） ─────────────────────────────
// 用法：node scripts/check-coverage-threshold.mjs --guide → 打印违反项/定位/阈值/正确做法。
// 仅在直接运行且带 --guide 时早退；不带 flag 时既有行为零变化。
const __debt08GuideFlag = process.argv.includes('--guide');
if (__debt08GuideFlag) {
  const __debt08Guide = [
    '违反项：per-package 语句覆盖率低于阈值，或 coverage-summary.json 解析失败。',
    '文件:行号 / 当前值：输出 [FAIL] <包片段>: <实测>%（threshold <阈值>%）；当前值 = 聚合语句覆盖率。',
    '阈值：packages/shared-types ≥ 80%；packages/shared-utils ≥ 70%；apps/crish-desktop ≥ 45%（脚本 THRESHOLDS 常量）。',
    '数据源：coverage/coverage-summary.json，由 npm run test:coverage（vitest run --coverage + json-summary reporter）产出。',
    '正确做法：为低于阈值的包补真实测试抬覆盖率；禁止下调阈值还债；coverage 文件缺失或某包无数据一律 FAIL（先跑 npm run test:coverage，并确认 json-summary reporter 与 coverage.include 覆盖该包）。',
    '复核：npm run test:coverage && node scripts/check-coverage-threshold.mjs  # 期望 PASS',
  ];
  console.log('[check-coverage-threshold] 正确做法 · 五元规约\n');
  for (const l of __debt08Guide) console.log('  ' + l);
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const COVERAGE_SUMMARY = resolve(root, 'coverage', 'coverage-summary.json');

// Per-package minimum statement-coverage thresholds (percent).
// Keys are path fragments matched against coverage-summary file paths.
const THRESHOLDS = {
  'packages/shared-types': 80,
  'packages/shared-utils': 70,
  'apps/crish-desktop': 45,
};

if (!existsSync(COVERAGE_SUMMARY)) {
  console.error(
    'check-coverage-threshold: FAIL — coverage/coverage-summary.json not found (run `npm run test:coverage` first; the json-summary reporter must stay enabled in vitest.config.ts)'
  );
  process.exit(1);
}

let summary;
try {
  summary = JSON.parse(readFileSync(COVERAGE_SUMMARY, 'utf-8'));
} catch (err) {
  console.error(
    `check-coverage-threshold: FAIL — could not parse coverage-summary.json: ${err.message}`
  );
  process.exit(1);
}

// istanbul-format summary: { "/abs/path/to/file.ts": { statements: { pct: N, ... }, ... } }
// We aggregate per package by matching the path fragment.
const perPackageStats = {};
for (const [filePath, data] of Object.entries(summary)) {
  if (!data || typeof data.statements?.pct !== 'number') continue;
  for (const fragment of Object.keys(THRESHOLDS)) {
    const normalized = filePath.replace(/\\/g, '/');
    if (normalized.includes(fragment)) {
      if (!perPackageStats[fragment]) {
        perPackageStats[fragment] = { total: 0, covered: 0 };
      }
      // istanbul provides total/covered/skipped/pct — we use pct weighted
      // by total statements to compute an aggregate package pct.
      const total = data.statements.total ?? 0;
      const covered = data.statements.covered ?? 0;
      perPackageStats[fragment].total += total;
      perPackageStats[fragment].covered += covered;
      break;
    }
  }
}

let failed = false;
console.log('check-coverage-threshold: per-package statement coverage');
for (const [fragment, threshold] of Object.entries(THRESHOLDS)) {
  const stats = perPackageStats[fragment];
  if (!stats || stats.total === 0) {
    console.error(
      `  [FAIL] ${fragment}: no coverage data found (package missing from coverage.include or not exercised by this run)`
    );
    failed = true;
    continue;
  }
  const pct = (stats.covered / stats.total) * 100;
  const pass = pct >= threshold;
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(
    `  [${tag}] ${fragment}: ${pct.toFixed(2)}% (threshold ${threshold}%)`
  );
  if (!pass) failed = true;
}

if (failed) {
  console.error(
    'check-coverage-threshold: FAIL — one or more packages below threshold'
  );
  process.exit(1);
}

console.log('check-coverage-threshold: PASS — all packages meet thresholds');
