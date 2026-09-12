#!/usr/bin/env node
/**
 * scripts/check-startup-budget.mjs
 * 启动体积预算门禁（D9-A / U-START-GATE · fail 模型）
 *
 * 职责表（DEL-4 双真源收敛）：
 * - 本脚本承载**图谱级主路径**：entry 单文件预算 + 静态 import 图 JS 合计
 *   预算 + 静态图 deny 名单；
 * - `check-dist.mjs` 承载 CSP / vendor 存在性 / preload 白名单；
 * - vite `chunkSizeGatePlugin` 承载单块 600 KiB 硬线。
 * 阈值数值唯一来源 = D0 预算 SSOT（crates/conex-shared/src/perf_budget.rs
 * STARTUP_ENTRY_BUDGET_KB / STARTUP_STATIC_GRAPH_BUDGET_KB_TRANSITION）；
 * 本脚本缺省值与其对齐，禁止第三真源长期分叉（CFL-01）。
 *
 * 语义：
 * - 读取 Vite 构建产物 manifest（优先 apps/crish-desktop/dist/.vite/manifest.json，
 *   回退仓库根 dist/.vite/manifest.json）；
 * - 无 manifest / 无 dist → warn + exit 0（未构建不是失败）；
 * - 有 manifest → 汇总 entry 及其静态 import 图（entry graph）的 JS 体积：
 *   ① entry 单文件 ≤ BUDGET_KB（缺省 520）；
 *   ② 静态图 JS 合计 ≤ STATIC_GRAPH_BUDGET_KB（缺省 1800，过渡阈值）；
 *   ③ 静态图内命中 deny 名单（STATIC_GRAPH_DENY / --deny）→ 直接 exit 1；
 * - 默认（非 strict）：超预算进 warnings（exit 0）；deny 命中仍 exit 1；
 * - --strict（CI 强制）：超预算进 errors → exit 1。
 *
 * 用法：
 *   node scripts/check-startup-budget.mjs
 *   node scripts/check-startup-budget.mjs --strict
 *   node scripts/check-startup-budget.mjs --budget-kb 520 --static-graph-kb 1800
 *   node scripts/check-startup-budget.mjs --deny chat-provider-catalog
 *   STATIC_GRAPH_DENY=a,b node scripts/check-startup-budget.mjs --strict
 *
 * 退出码：
 *   0 = 通过或仅有 warning（默认非 strict 下超预算）；
 *   1 = --strict 下超预算，或 deny 名单命中（任何模式）；
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

/** 缺省 entry 预算（KiB）：对齐 D0 perf_budget STARTUP_ENTRY_BUDGET_KB = 520。 */
const DEFAULT_BUDGET_KB = 520;
/** 缺省静态图合计预算（KiB）：对齐 D0 STARTUP_STATIC_GRAPH_BUDGET_KB_TRANSITION = 1800（断边后由 D9-B 下调至 900 冻结）。 */
const DEFAULT_STATIC_GRAPH_BUDGET_KB = 1800;
/**
 * 缺省 deny 名单（静态图内禁入 chunk key 子串）。
 * 断边验收（D9-B）合入前保持为空——防止断边未合就 deny 误红主干；
 * D9-B 验收后追加 `chat-provider-catalog`。
 * 运行时可经 env STATIC_GRAPH_DENY（逗号分隔）或 --deny 覆盖/追加。
 */
const DEFAULT_STATIC_GRAPH_DENY = [];

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let budgetKb = Number.parseFloat(process.env.BUDGET_KB || '') || DEFAULT_BUDGET_KB;
let staticGraphKb =
  Number.parseFloat(process.env.STATIC_GRAPH_BUDGET_KB || '') || DEFAULT_STATIC_GRAPH_BUDGET_KB;
let strict = false;
/** --manifest 覆盖（测试夹具注入假 manifest；生产不传，走候选路径探测） */
let manifestOverride = null;
/** deny 名单：缺省 + env + --deny 追加（去重） */
const denySet = new Set(DEFAULT_STATIC_GRAPH_DENY);
if (process.env.STATIC_GRAPH_DENY) {
  for (const raw of process.env.STATIC_GRAPH_DENY.split(',')) {
    const name = raw.trim();
    if (name) denySet.add(name);
  }
}

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--budget-kb') {
    const v = Number(argv[++i]);
    if (!Number.isFinite(v) || v <= 0) {
      console.error(`check-startup-budget: --budget-kb 需要正数，收到 ${argv[i]}`);
      process.exit(2);
    }
    budgetKb = v;
  } else if (a === '--static-graph-kb') {
    const v = Number(argv[++i]);
    if (!Number.isFinite(v) || v <= 0) {
      console.error(`check-startup-budget: --static-graph-kb 需要正数，收到 ${argv[i]}`);
      process.exit(2);
    }
    staticGraphKb = v;
  } else if (a === '--deny') {
    const name = argv[++i];
    if (!name || !name.trim()) {
      console.error('check-startup-budget: --deny 需要非空名称');
      process.exit(2);
    }
    denySet.add(name.trim());
  } else if (a === '--manifest') {
    const p = argv[++i];
    if (!p) {
      console.error('check-startup-budget: --manifest 需要路径');
      process.exit(2);
    }
    manifestOverride = p;
  } else if (a === '--strict') {
    strict = true;
  } else if (a === '--help' || a === '-h') {
    console.log(
      '用法: node scripts/check-startup-budget.mjs [--budget-kb N] [--static-graph-kb N] [--deny name]... [--manifest path] [--strict]\n' +
        `  env BUDGET_KB 覆盖 entry 预算（缺省 ${DEFAULT_BUDGET_KB} KiB）\n` +
        `  env STATIC_GRAPH_BUDGET_KB 覆盖静态图合计预算（缺省 ${DEFAULT_STATIC_GRAPH_BUDGET_KB} KiB）\n` +
        '  env STATIC_GRAPH_DENY 逗号分隔 deny 名单\n' +
        '  --manifest 覆盖 manifest 探测路径（测试夹具用）\n' +
        '  --strict 超预算 exit 1（CI 强制）；deny 命中任何模式 exit 1'
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
if (!Number.isFinite(staticGraphKb) || staticGraphKb <= 0) {
  console.error(
    `check-startup-budget: 无效静态图预算 STATIC_GRAPH_BUDGET_KB=${process.env.STATIC_GRAPH_BUDGET_KB}`
  );
  process.exit(2);
}

// ── locate manifest ──────────────────────────────────────────────────────────
function findManifest() {
  // --manifest 覆盖（测试夹具）：显式路径优先
  if (manifestOverride) {
    if (existsSync(manifestOverride)) return manifestOverride;
    console.error(
      `check-startup-budget: --manifest 指定路径不存在 ${manifestOverride}`
    );
    process.exit(2);
  }
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
const staticGraphBudgetBytes = Math.round(staticGraphKb * 1024);
const known = rows.filter((r) => r.bytes != null && staticVisited.has(r.key));
const totalBytes = known.reduce((s, r) => s + r.bytes, 0);
// 主预算锚定：isEntry 产物文件本身（对齐 check-dist 主入口）
const entryFileBytes = rows
  .filter((r) => r.isEntry && r.bytes != null)
  .reduce((s, r) => s + r.bytes, 0);
const missing = rows.filter((r) => r.bytes == null && staticVisited.has(r.key));

// ── deny 名单（静态图内禁入 chunk key 子串；命中任何模式 exit 1）──────────
const denyHits = [];
if (denySet.size > 0) {
  for (const key of staticVisited) {
    for (const deny of denySet) {
      if (key.includes(deny)) {
        denyHits.push({ key, deny });
      }
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────
console.log(`=== startup budget（${strict ? 'strict' : 'warn'} 模式）===`);
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
  `静态 import 图合计: ${totalBytes} B (${(totalBytes / 1024).toFixed(1)} KiB) / 预算 ${staticGraphKb} KiB`
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
    `entry chunk 超预算: ${entryFileBytes} B (${(entryFileBytes / 1024).toFixed(1)} KiB) > ${budgetKb} KiB（阈值可调 BUDGET_KB / --budget-kb）`;
  if (strict) errors.push(line);
  else warnings.push(line);
}

// 静态图合计预算（图谱级主路径；DEL-8：不再「仅信息」）
if (totalBytes > staticGraphBudgetBytes) {
  const line =
    `静态 import 图合计超预算: ${totalBytes} B (${(totalBytes / 1024).toFixed(1)} KiB) > ${staticGraphKb} KiB（阈值可调 STATIC_GRAPH_BUDGET_KB / --static-graph-kb）`;
  if (strict) errors.push(line);
  else warnings.push(line);
}

// deny 名单命中：任何模式直接 fail（硬违规，不随 strict 缓冲）
for (const hit of denyHits) {
  errors.push(`静态图 deny 名单命中: ${hit.key} 命中 «${hit.deny}»`);
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
  `[check-startup-budget] OK（${strict ? 'strict' : 'warn'} 模式；entry 阈值 ${budgetKb} KiB；静态图阈值 ${staticGraphKb} KiB；deny ${denySet.size} 项）`
);
process.exit(0);
