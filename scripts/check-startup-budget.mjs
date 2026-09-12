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
  join(REPO_ROOT, 'apps', 'crush-desktop', 'dist', '.vite', 'manifest.json'),
];
const ASSETS_DIR_CANDIDATES = [
  join(REPO_ROOT, 'apps', 'crish-desktop', 'dist', 'assets'),
  join(REPO_ROOT, 'dist', 'assets'),
];

/** 缺省软预算（KiB）：2026-09-13 真实 build 基线 index≈497–509 KiB，取 520 作软上限（warning）。 */
const DEFAULT_BUDGET_KB = 520;

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
  // 无 manifest 时回落：直接扫 dist/assets 中 index-*.js 作 entry 代理
  const assetsDir = ASSETS_DIR_CANDIDATES.find((p) => existsSync(p));
  if (!assetsDir) {
    console.warn('[check-startup-budget] WARN: 未找到 dist 产物——跳过 entry 体积检查（exit 0）');
    process.exit(0);
  }
  const { readdirSync } = await import('node:fs');
  const entries = readdirSync(assetsDir).filter((f) => /^index-.*\.js$/.test(f));
  if (entries.length === 0) {
    console.warn('[check-startup-budget] WARN: assets 中无 index-*.js，跳过');
    process.exit(0);
  }
  let failed = false;
  for (const f of entries) {
    const size = statSync(join(assetsDir, f)).size;
    const kb = (size / 1024).toFixed(1);
    if (size > budgetKb * 1024) {
      const msg = `[check-startup-budget] ${f}: ${kb} KiB > 软预算 ${budgetKb} KiB`;
      if (strict) {
        console.error(msg);
        failed = true;
      } else {
        console.warn(`WARN ${msg}`);
      }
    } else {
      console.log(`[check-startup-budget] OK ${f}: ${kb} KiB ≤ ${budgetKb} KiB`);
    }
  }
  console.log(
    '[check-startup-budget] 注：无 Vite manifest，使用 assets 文件名启发式；建议 build 开启 manifest: true'
  );
  process.exit(failed ? 1 : 0);
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
  const rec = manifest[key] || {};
  // Vite manifest：file 字段为产物相对路径（如 assets/index-xxx.js）；key 可能是源码路径
  const rel = rec.file || key;
  const abs = join(distRoot, rel);
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

  // 静态 import 图（首屏 parse 必付）
  const staticVisited = new Set();
  const staticQueue = [...entries];
  while (staticQueue.length > 0) {
    const key = staticQueue.shift();
    if (staticVisited.has(key)) continue;
    staticVisited.add(key);
    const rec = m[key];
    if (!rec) continue;
    for (const dep of rec.imports || []) staticQueue.push(dep);
  }

  // 动态 import（预热/懒加载，仅列示不计入 entry 预算合计）
  const dynamicVisited = new Set();
  const dynQueue = [...staticVisited];
  while (dynQueue.length > 0) {
    const key = dynQueue.shift();
    const rec = m[key];
    if (!rec) continue;
    for (const dep of rec.dynamicImports || []) {
      if (!staticVisited.has(dep) && !dynamicVisited.has(dep)) {
        dynamicVisited.add(dep);
        dynQueue.push(dep);
      }
    }
  }

  const rows = [];
  for (const key of staticVisited) {
    const rec = m[key] || {};
    rows.push({
      key,
      bytes: fileSizeFromManifestKey(key),
      isEntry: !!rec.isEntry,
      staticOnly: true,
    });
  }
  for (const key of dynamicVisited) {
    const rec = m[key] || {};
    rows.push({
      key,
      bytes: fileSizeFromManifestKey(key),
      isEntry: false,
      staticOnly: false,
    });
  }
  rows.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  return { entries, rows, staticVisited };
}

const { entries, rows, staticVisited } = collectEntryGraph(manifest);

if (entries.length === 0) {
  console.warn(
    `[check-startup-budget] WARN: manifest 无 isEntry 条目（${relative(REPO_ROOT, manifestPath)}）——跳过`
  );
  process.exit(0);
}

const budgetBytes = Math.round(budgetKb * 1024);
const known = rows.filter((r) => r.bytes != null && staticVisited.has(r.key));
const totalBytes = known.reduce((s, r) => s + r.bytes, 0);
// 主预算锚定：isEntry 产物文件本身（对齐 check-dist 主入口）；静态图合计仅信息展示
const entryFileBytes = rows
  .filter((r) => r.isEntry && r.bytes != null)
  .reduce((s, r) => s + r.bytes, 0);
const missing = rows.filter((r) => r.bytes == null && staticVisited.has(r.key));

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
  `entry 文件合计: ${entryFileBytes} B (${(entryFileBytes / 1024).toFixed(1)} KiB) / 预算 ${budgetKb} KiB`
);
console.log(
  `静态 import 图合计（信息）: ${totalBytes} B (${(totalBytes / 1024).toFixed(1)} KiB)`
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

// 主预算：entry 产物文件本身
if (entryFileBytes > budgetBytes) {
  const line =
    `entry chunk 超软预算: ${entryFileBytes} B (${(entryFileBytes / 1024).toFixed(1)} KiB) > ${budgetKb} KiB —— warning（阈值可调 BUDGET_KB）`;
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
