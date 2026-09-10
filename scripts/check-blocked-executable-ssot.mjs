#!/usr/bin/env node
/**
 * §4.3 可执行后缀拦截 SSOT 对齐门禁：
 * 前端 blockedExecutableExtensions.ts ↔ Rust host_openers/execute.rs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function extractTsList(src) {
  const m = src.match(
    /export const BLOCKED_EXECUTABLE_EXTENSIONS\s*=\s*\[([\s\S]*?)\]\s*as const/
  );
  if (!m) fail('TS SSOT array not found');
  return [...m[1].matchAll(/'([a-z0-9]+)'/g)].map((x) => x[1]);
}

function extractRustList(src) {
  const m = src.match(
    /const BLOCKED_EXECUTABLE_EXTENSIONS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/
  );
  if (!m) fail('Rust SSOT array not found');
  return [...m[1].matchAll(/"([a-z0-9]+)"/g)].map((x) => x[1]);
}

const tsPath = path.join(
  root,
  'apps/crish-desktop/src/api/blockedExecutableExtensions.ts'
);
const rsPath = path.join(
  root,
  'apps/agent-workbench/src-tauri/src/host_openers/execute.rs'
);

const tsList = extractTsList(fs.readFileSync(tsPath, 'utf8'));
const rsList = extractRustList(fs.readFileSync(rsPath, 'utf8'));

const tsSet = [...new Set(tsList)].sort();
const rsSet = [...new Set(rsList)].sort();

if (tsSet.join(',') !== rsSet.join(',')) {
  fail(
    `executable SSOT mismatch\n  TS:   ${tsSet.join(',')}\n  Rust: ${rsSet.join(',')}`
  );
}

const hoa = fs.readFileSync(
  path.join(root, 'apps/crish-desktop/src/api/hostOpenersApi.ts'),
  'utf8'
);
const usa = fs.readFileSync(
  path.join(
    root,
    'apps/crish-desktop/src/components/chat-card/useChatSessionActions.ts'
  ),
  'utf8'
);
if (!hoa.includes('isBlockedExecutablePath')) {
  fail('hostOpenersApi.ts must call isBlockedExecutablePath');
}
if (!usa.includes('isBlockedExecutablePath')) {
  fail('useChatSessionActions.ts must call isBlockedExecutablePath');
}
if (/\(exe\|bat\|cmd\|msi\|ps1\|vbs\|com\|sh\|bin\)\$/.test(usa)) {
  fail('useChatSessionActions.ts still has inline executable regex (dual-track)');
}

const rs = fs.readFileSync(rsPath, 'utf8');
if (!rs.includes('is_blocked_executable_path(&target)')) {
  fail('execute.rs open_path must call is_blocked_executable_path');
}

console.log(
  `PASS: blocked-executable SSOT aligned (${tsSet.join(',')}) + call sites wired`
);
