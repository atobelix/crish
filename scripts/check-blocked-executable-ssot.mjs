#!/usr/bin/env node
/**
 * §4.3 可执行后缀拦截 SSOT 对齐门禁：
 * 前端 blockedExecutableExtensions.ts ↔ Rust host_openers/execute.rs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── --guide（T-DEBT-08：正确做法指引 · 五元规约） ─────────────────────────────
// 用法：node scripts/check-blocked-executable-ssot.mjs --guide → 打印违反项/定位/阈值/正确做法。
// 仅在直接运行且带 --guide 时早退；不带 flag 时既有行为零变化。
const __debt08GuideFlag = process.argv.includes('--guide');
if (__debt08GuideFlag) {
  const __debt08Guide = [
    "违反项：前端 blockedExecutableExtensions.ts 与 Rust host_openers/execute.rs 的可执行后缀拦截清单不一致。",
    "文件:行号 / 当前值：FAIL 输出逐条给出差异侧与差异后缀。",
    "阈值：两侧后缀集合完全一致（SSOT 镜像）。",
    "正确做法：以后端 SSOT 为准，在同一次提交内同步两侧数组；新增后缀先改 Rust 侧再镜像前端，或反之，禁止只改一侧。",
    "复核：node scripts/check-blocked-executable-ssot.mjs  # 期望 OK",
  ];
  console.log('[check-blocked-executable-ssot] 正确做法 · 五元规约\n');
  for (const l of __debt08Guide) console.log('  ' + l);
  process.exit(0);
}

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
