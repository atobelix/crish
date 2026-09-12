#!/usr/bin/env node
/**
 * Test-coverage gate.
 *
 * Reads coverage/coverage-summary.json (produced by `vitest run --coverage`)
 * and checks statement coverage for key packages against per-package
 * thresholds. Exits 1 if any package is below its threshold.
 *
 * If the coverage file is missing, prints a warning and exits 0 — this
 * script must not fail CI when coverage was not generated.
 *
 * Run: node scripts/check-coverage-threshold.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  console.warn(
    'check-coverage-threshold: WARN — coverage/coverage-summary.json not found; skipping (run `npm run test:coverage` to generate)'
  );
  process.exit(0);
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
    console.warn(
      `  [WARN] ${fragment}: no coverage data found, skipping`
    );
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
