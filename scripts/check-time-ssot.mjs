#!/usr/bin/env node
/**
 * X-03 TM-P5 防回归：时间真源只允许 `crates/conex-shared/src/time.rs`。
 *
 * 生产 Rust（排除 tests/benches/examples、*_tests.rs、*_test.rs、tests.rs、
 * 文件内 `#[cfg(test)] mod ...` 之后的测试块）：
 * - 禁止出现 `UNIX_EPOCH`；
 * - 禁止定义本地时间换算/时钟函数（civil_from_days / days_from_civil /
 *   now_millis / now_secs / now_unix / unix_millis / now_ms_u64 /
 *   now_iso_utc / iso8601_from* / iso_from_millis / parse_iso8601* /
 *   current_utc_timestamp / now_unix_str）；
 * - 禁止零参自由函数 `fn now_ms()`（Clock trait 的 `fn now_ms(&self)` 属实现面，不在此列）。
 *
 * `crates/conex-test-utils` 是测试时钟工具（TestClock 固有方法由 X-03 明确保留），不扫描。
 *
 * Run: node scripts/check-time-ssot.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const roots = ['crates', 'apps/agent-workbench/src-tauri/src'];
const skipDirs = new Set(['target', 'node_modules', 'dist', '.git', 'tests', 'benches', 'examples']);
const skipCrate = 'crates/conex-test-utils/';

const banned = [
  /\bUNIX_EPOCH\b/,
  /\bfn\s+(?:civil_from_days|days_from_civil|now_millis|now_secs|now_unix|unix_millis|now_ms_u64|now_iso_utc|now_unix_str|iso_from_millis|iso8601_from\w*|parse_iso8601\w*|current_utc_timestamp)\b/,
  /\bfn\s+now_ms\s*\(\s*\)/,
];

function isTestFile(rel) {
  const parts = rel.split('/');
  return (
    parts.includes('tests') ||
    rel.endsWith('tests.rs') ||
    rel.endsWith('_tests.rs') ||
    rel.endsWith('_test.rs')
  );
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function truncateInlineTests(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*#\[cfg\(test\)\]\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 12); j += 1) {
      const line = lines[j].trim();
      if (line === '' || line.startsWith('//') || line.startsWith('#[')) continue;
      if (/^(?:pub\s+)?mod\s+\w+/.test(line)) return lines.slice(0, i).join('\n');
      break;
    }
  }
  return text;
}

const violations = [];
function scanFile(full, rel) {
  if (rel === 'crates/conex-shared/src/time.rs') return;
  if (rel.startsWith(skipCrate)) return;
  if (isTestFile(rel)) return;
  const text = truncateInlineTests(stripComments(readFileSync(full, 'utf8')));
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const re of banned) {
      if (re.test(lines[i])) violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
    }
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith('.rs')) {
      scanFile(full, relative(root, full).split(sep).join('/'));
    }
  }
}

for (const rel of roots) walk(join(root, rel));

if (violations.length > 0) {
  console.error('[check-time-ssot] FAIL: 生产代码必须使用 conex_shared::time');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log('[check-time-ssot] OK — 时间真源唯一');
