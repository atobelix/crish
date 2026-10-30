#!/usr/bin/env node
/**
 * X-04 EC-P5 防回归：生产代码禁止裸写已注册错误码字符串。
 *
 * 真源：`crates/conex-types/contracts/error-codes.json`（由 Rust catalog 导出）。
 * 生产 Rust/TS（排除 generated、tests、i18n 资源、conex-test-utils，
 * 以及有独立契约的 conex-device-protocol）中，出现与任一已注册 code 完全
 * 相同的字符串字面量即失败；调用点必须引用 `codes::*` / 生成常量。
 *
 * Run: node scripts/check-error-code-literals.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const contract = JSON.parse(
  readFileSync(join(root, 'crates/conex-types/contracts/error-codes.json'), 'utf8')
);
const codes = contract.codes.map((entry) => entry.code);
const codeSet = new Set(codes);
const roots = ['crates', 'apps/agent-workbench/src-tauri/src', 'packages'];
const skipDirs = new Set(['target', 'node_modules', 'dist', '.git', 'tests', 'benches', 'examples']);
const skipPrefixes = [
  'crates/conex-test-utils/',
  'crates/conex-device-protocol/',
  'crates/conex-types/src/error/codes.rs',
  'packages/shared-types/src/generated/',
  'apps/crish-desktop/src/i18n/',
];

function isTestFile(rel) {
  const parts = rel.split('/');
  return (
    parts.includes('tests') ||
    rel.endsWith('tests.rs') ||
    rel.endsWith('_tests.rs') ||
    rel.endsWith('_test.rs') ||
    rel.endsWith('.test.ts') ||
    rel.endsWith('.test.tsx')
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
  if (isTestFile(rel)) return;
  if (skipPrefixes.some((prefix) => rel.startsWith(prefix))) return;
  const text = truncateInlineTests(stripComments(readFileSync(full, 'utf8')));
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const literals = [...lines[i].matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((m) => m[1]);
    for (const literal of literals) {
      if (codeSet.has(literal)) {
        violations.push(`${rel}:${i + 1}: ${literal}`);
      }
    }
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && /\.(rs|ts|tsx)$/.test(entry.name)) {
      scanFile(full, relative(root, full).split(sep).join('/'));
    }
  }
}

for (const rel of roots) walk(join(root, rel));

if (violations.length > 0) {
  console.error('[check-error-code-literals] FAIL: 生产代码出现已注册错误码字面量');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`[check-error-code-literals] OK — ${codes.length} 个错误码均由常量引用`);
