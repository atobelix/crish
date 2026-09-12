#!/usr/bin/env node
/**
 * scripts/check-startup-budget.mjs
 * 启动体积预算门禁（Wave A · TU7 · 软门禁）
 *
 * 语义：
 * - 读取 Vite 构建产物 manifest（优先 apps/crush-desktop/dist/.vite/manifest.json，
 *   回退仓库根 dist/.vite/manifest.json）；
 * - 无 manifest / 无 dist → warn + exit 0（未构建不是失败）；
 * - 有 manifest → 汇总 entry 及其静态 import 图（entry graph）的 JS/CSS 体积，
 *   与 BUDGET_KB（env，缺省 240）对比：仅 warning，不 hard-fail（未建基线前
 *   禁止 hard 180KB 一刀切）；
 * - 显式禁止对不存在/未登记的 chat-bridge 674KB 等历史数字做断言。
 *
 * 用法：
 *   node scripts/check-startup-budget.mjs
 *   BUDGET_KB=180 node scripts/check-startup-budget.mjs
 *   node scripts/check-startup-budget.mjs --budget-kb 180
 *   node scripts/check-startup-budget.mjs --strict   # 超预算改为 exit 1（可选）
 *
 * 退出码：
 *   0 = 通过或仅有 warning（默认）；--strict 下超预算为 1
 *   2 = 参数错误
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 兼容 Vite outDir（桌面壳与仓库根两种布局） */
const MANIFEST_CANDIDATES = [
  join(REPO_ROOT, 'apps', 'crish-desktop', 'dist', '.vite', 'manifest.json'),
  join(REPO_ROOT, 'dist', '.vite', 'manifest.json'),
];

/** 缺省软预算（KiB）。未基线前只 warn，不 hard 180。 */
const DEFAULT_BUDGET_KB = 240;

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let budgetKb = Number.parseFloat(process.env.BUDGET_KB || '') || DEFAULT_BUDGET_KB;
let strict = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--budget-kb') {
    const v = Number(argv[++i]);
    if (!Number.isFinite(v) || v <= 0) {
      console.error(`check-startup-budget: --budget-kb 需要正数，收到 ${argv[i]}`);
      process.exit(2);
    }
    budgetKb = v;
  } else if (a === '--strict') {
    strict = true;
  } else if (a === '--help' || a === '-h') {
    console.log(
      '用法: node scripts/check-startup-budget.mjs [--budget-kb N] [--strict]\n' +
        `  env BUDGET_KB 覆盖缺省预算（当前缺省 ${DEFAULT_BUDGET_KB} KiB，仅 warning）`
    );
    process.exit(0);
  } else {
    console.error(`check-startup-budget: 未知参数 ${a}`);
    process.exit(2);
  }
}

if (!Number.isFinite(budgetKb) || budgetKb <= 0) {
  console.error(`check-startup-budget: 无效预算 BUDGET_KB=${process.env.BUDGET_KB}`);
  process.exit(2);
}

// ── locate manifest ──────────────────────────────────────────────────────────
function findManifest() {
  for (const p of MANIFEST_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

const manifestPath = findManifest();
if (!manifestPath) {
  console.warn('[check-startup-budget] WARN: 未找到 dist/.vite/manifest.json');
  console.warn(
    '[check-startup-budget] WARN: 无构建产物——跳过 entry 体积检查（exit 0）。先跑 npm run build:desktop 再启用。'
  );
  process.exit(0);
}

// ── parse manifest ───────────────────────────────────────────────────────────
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (e) {
  console.error(
    `[check-startup-budget] FAIL: manifest 解析失败 ${relative(REPO_ROOT, manifestPath)}: ${e.message}`
  );
  process.exit(1);
}

const distRoot = join(dirname(manifestPath), '..'); // .../dist

function fileSizeFromManifestKey(key) {
  // manifest key 相对 outDir；产物路径 = dist/<file>
  const abs = join(distRoot, key);
  try {
    return statSync(abs).size;
  } catch {
    return null;
  }
}

// ── collect entry graph ──────────────────────────────────────────────────────
/**
 * entry graph = isEntry 的 chunk + 其静态 imports/dynamicImports（随首屏
 * 动态预取一并登记；体积按文件实测）。不做 chat-bridge 等名字断言。
 */
function collectEntryGraph(m) {
  const entries = [];
  for (const [key, rec] of Object.entries(m)) {
    if (rec && rec.isEntry) entries.push(key);
  }

  const visited = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const key = queue.shift();
    if (visited.has(key)) continue;
    visited.add(key);
    const rec = m[key];
    if (!rec) continue;
    for (const dep of rec.imports || []) queue.push(dep);
    // dynamicImports 仍属启动可触发面，纳入 soft 清单（不 hard 断言）
    for (const dep of rec.dynamicImports || []) {
      if (m[dep] && !visited.has(dep)) queue.push(dep);
    }
  }

  const rows = [];
  for (const key of visited) {
    const rec = m[key] || {};
    const bytes = fileSizeFromManifestKey(key);
    rows.push({
      key,
      bytes,
      isEntry: !!rec.isEntry,
      isDynamicOnly: !rec.isEntry && visited.has(key) && !(rec.imports || []).length,
    });
  }
  rows.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  return { entries, rows };
}

const { entries, rows } = collectEntryGraph(manifest);

if (entries.length === 0) {
  console.warn(
    `[check-startup-budget] WARN: manifest 无 isEntry 条目（${relative(REPO_ROOT, manifestPath)}）——跳过`
  );
  process.exit(0);
}

const budgetBytes = Math.round(budgetKb * 1024);
const known = rows.filter((r) => r.bytes != null);
const totalBytes = known.reduce((s, r) => s + r.bytes, 0);
const missing = rows.filter((r) => r.bytes == null);

// ── report ───────────────────────────────────────────────────────────────────
console.log('=== startup budget（软门禁）===');
console.log(`manifest: ${relative(REPO_ROOT, manifestPath)}`);
console.log(`entries (${entries.length}):`);
for (const e of entries) {
  const rec = manifest[e];
  const b = fileSizeFromManifestKey(e);
  console.log(`  [entry] ${e}${b != null ? `  ${b} B (${(b / 1024).toFixed(1)} KiB)` : '  (missing file)'}`);
}
console.log(`entry graph chunks (${rows.length}):`);
for (const r of rows) {
  const tag = r.isEntry ? 'entry' : 'import';
  const size = r.bytes != null ? `${r.bytes} B (${(r.bytes / 1024).toFixed(1)} KiB)` : 'missing';
  console.log(`  [${tag}] ${r.key}  ${size}`);
}
console.log(
  `entry graph JS/CSS 合计: ${totalBytes} B (${(totalBytes / 1024).toFixed(1)} KiB) / 预算 ${budgetKb} KiB`
);

const warnings = [];
const errors = [];

if (missing.length > 0) {
  warnings.push(
    `${missing.length} 个 manifest 条目对应文件缺失（构建不完整？）: ${missing
      .map((m) => m.key)
      .join(', ')}`
  );
}

// 逐 entry soft check + 汇总 soft check（不点名 chat-bridge）
for (const e of entries) {
  const b = fileSizeFromManifestKey(e);
  if (b != null && b > budgetBytes) {
    const line =
      `entry chunk 超软预算: ${e} = ${b} B (${(b / 1024).toFixed(1)} KiB) > ${budgetKb} KiB —— 仅 warning（未基线，勿 hard 180KB）`;
    if (strict) errors.push(line);
    else warnings.push(line);
  }
}
if (totalBytes > budgetBytes) {
  const line =
    `entry graph 合计超软预算: ${totalBytes} B (${(totalBytes / 1024).toFixed(1)} KiB) > ${budgetKb} KiB —— warning（可调 BUDGET_KB 或拆 chunk）`;
  if (strict) errors.push(line);
  else warnings.push(line);
}

for (const w of warnings) {
  console.warn(`[check-startup-budget] WARN: ${w}`);
}
for (const e of errors) {
  console.error(`[check-startup-budget] FAIL: ${e}`);
}

if (errors.length > 0) {
  process.exit(1);
}
console.log(
  `[check-startup-budget] OK（软模式${strict ? ' + strict' : ''}；阈值 ${budgetKb} KiB；无 chat-bridge 硬断言）`
);
process.exit(0);
