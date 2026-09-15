#!/usr/bin/env node
/**
 * Round9 · block-workspace 数值门测量脚手架（本机可跑；CI 默认不跑）
 *
 * 输出：stdout **JSON 行**（每指标一行）
 *   { metric, n, p50_ms, p95_ms, os, arch, cpu_logical, ... }
 *
 * 覆盖：
 *   1) HeightMap 1k（默认）offsetOf + indexAt 查询 — packages/editor-kit
 *   2) DocSession open N 块 insert batch — crates/conex-doc-collab（可选 --rust）
 *
 * 用法：
 *   npm run perf:block-workspace
 *   npm run perf:block-workspace -- --rust
 *   npm run perf:block-workspace -- --n 10000 --iters 7 --rust
 *   node scripts/block-workspace-perf.mjs --heightmap-only
 *
 * 纪律（H3 / perf-baseline.md）：
 *   - **禁止** 本脚本改写 perf-baseline.md 的 TBD
 *   - 结果仅打印；人工回填见 perf-baseline.md §7
 */

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// ─── CLI ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    n: 1000,
    iters: 7,
    warmup: 1,
    queries: 10_000,
    rust: false,
    heightmapOnly: false,
    rustOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--rust') out.rust = true;
    else if (a === '--heightmap-only') out.heightmapOnly = true;
    else if (a === '--rust-only') {
      out.rustOnly = true;
      out.rust = true;
    } else if (a === '--n' && argv[i + 1]) out.n = Math.max(1, Number(argv[++i]) || 1000);
    else if (a === '--iters' && argv[i + 1])
      out.iters = Math.max(1, Number(argv[++i]) || 7);
    else if (a === '--warmup' && argv[i + 1])
      out.warmup = Math.max(0, Number(argv[++i]) || 1);
    else if (a === '--queries' && argv[i + 1])
      out.queries = Math.max(1, Number(argv[++i]) || 10_000);
  }
  return out;
}

function machineHints() {
  return {
    os: process.platform,
    arch: process.arch,
    cpu_logical: os.cpus()?.length ?? 0,
    os_release: os.release(),
    node: process.version,
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const w = rank - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function emitJson(obj) {
  // 单行 JSON — 供管道 / 人工复制
  console.log(JSON.stringify(obj));
}

// ─── HeightMap 1k 查询（真实 @crish/editor-kit 实现）────────────────
async function runHeightMap(opts) {
  const n = opts.n;
  const iters = opts.iters;
  const warmup = opts.warmup;
  const queries = opts.queries;
  const hints = machineHints();

  // 经 tsx 动态加载 TS 源（与 package exports 对齐）
  const hmPath = path.join(root, 'packages/editor-kit/src/viewport/HeightMap.ts');
  let HeightMap;
  try {
    // node --import tsx 或由 `npx tsx scripts/...` 启动时可用
    const mod = await import(pathToFileUrl(hmPath));
    HeightMap = mod.HeightMap;
  } catch (e) {
    // 回退：内联 prefix-sum 二分（与 HeightMap.indexAt / offsetOf 同算法），
    // 仍输出 metric，并标记 implementation=inline_fallback
    console.error(
      '[block-workspace-perf] HeightMap TS import failed; using inline fallback:',
      e && e.message ? e.message : e
    );
    return runHeightMapInline(opts, hints, 'inline_fallback');
  }

  const samples = [];
  for (let w = 0; w < warmup; w++) {
    timeHeightMapOnce(HeightMap, n, queries);
  }
  for (let i = 0; i < iters; i++) {
    samples.push(timeHeightMapOnce(HeightMap, n, queries));
  }
  samples.sort((a, b) => a - b);

  emitJson({
    metric: 'heightmap_query',
    metric_id: `heightmap_query_${n}`,
    n,
    queries_per_iter: queries,
    iters,
    warmup,
    p50_ms: round3(percentile(samples, 50)),
    p95_ms: round3(percentile(samples, 95)),
    samples_ms: samples.map(round3),
    implementation: 'packages/editor-kit/src/viewport/HeightMap.ts',
    ...hints,
    note: 'manual backfill only; do not auto-rewrite TBD in perf-baseline.md',
  });
}

function pathToFileUrl(p) {
  const resolved = path.resolve(p);
  let u = resolved.replace(/\\/g, '/');
  if (!u.startsWith('/')) u = '/' + u; // Windows drive
  return 'file://' + u;
}

function timeHeightMapOnce(HeightMap, n, queries) {
  const hm = new HeightMap(n, 28);
  // 轻微扰动高度，避免纯常量退化
  for (let i = 0; i < n; i += 17) {
    hm.setEstimate(i, 28 + (i % 5));
  }
  const total = hm.totalHeight();
  const t0 = performance.now();
  let sink = 0;
  for (let q = 0; q < queries; q++) {
    const idx = q % n;
    sink += hm.offsetOf(idx);
    const px = ((q * 97) % Math.max(1, Math.floor(total))) + (q % 3) * 0.1;
    sink += hm.indexAt(px);
  }
  const ms = performance.now() - t0;
  if (sink === Number.MIN_SAFE_INTEGER) throw new Error('unreachable');
  return ms;
}

/** 与 HeightMap 同构的内联实现（仅 import 失败时使用） */
function runHeightMapInline(opts, hints, implTag) {
  const n = opts.n;
  const iters = opts.iters;
  const warmup = opts.warmup;
  const queries = opts.queries;

  function build(n) {
    const heights = new Array(n).fill(28);
    for (let i = 0; i < n; i += 17) heights[i] = 28 + (i % 5);
    const prefix = new Array(n + 1);
    prefix[0] = 0;
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + heights[i];
    return { heights, prefix, total: prefix[n] };
  }
  function offsetOf(prefix, index) {
    const i = Math.max(0, Math.min(index, prefix.length - 1));
    return prefix[i];
  }
  function indexAt(prefix, n, offsetPx) {
    if (n === 0) return 0;
    const target = Math.max(0, offsetPx);
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (prefix[mid] <= target) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  function once() {
    const { prefix, total } = build(n);
    const t0 = performance.now();
    let sink = 0;
    for (let q = 0; q < queries; q++) {
      sink += offsetOf(prefix, q % n);
      const px = ((q * 97) % Math.max(1, Math.floor(total))) + (q % 3) * 0.1;
      sink += indexAt(prefix, n, px);
    }
    const ms = performance.now() - t0;
    if (sink === Number.MIN_SAFE_INTEGER) throw new Error('unreachable');
    return ms;
  }

  for (let w = 0; w < warmup; w++) once();
  const samples = [];
  for (let i = 0; i < iters; i++) samples.push(once());
  samples.sort((a, b) => a - b);

  emitJson({
    metric: 'heightmap_query',
    metric_id: `heightmap_query_${n}`,
    n,
    queries_per_iter: queries,
    iters,
    warmup,
    p50_ms: round3(percentile(samples, 50)),
    p95_ms: round3(percentile(samples, 95)),
    samples_ms: samples.map(round3),
    implementation: implTag,
    ...hints,
    note: 'manual backfill only; do not auto-rewrite TBD in perf-baseline.md',
  });
}

// ─── Rust DocSession open N 块 ──────────────────────────────────────
function runRust(opts) {
  const env = {
    ...process.env,
    PERF_N: String(opts.n),
    PERF_ITERS: String(opts.iters),
    PERF_WARMUP: String(opts.warmup),
  };
  const args = [
    'test',
    '-p',
    'conex-doc-collab',
    '--test',
    'perf_open_nk_blocks',
    '--release',
    '--',
    '--ignored',
    '--nocapture',
    'perf_open_nk_blocks',
  ];
  console.error('[block-workspace-perf] cargo', args.join(' '));
  console.error(
    `[block-workspace-perf] PERF_N=${env.PERF_N} PERF_ITERS=${env.PERF_ITERS} PERF_WARMUP=${env.PERF_WARMUP}`
  );
  const r = spawnSync('cargo', args, {
    cwd: root,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (r.stdout) {
    // 透传：从 cargo 输出中抽出 JSON 行（以 { 开头且含 "metric"）
    for (const line of r.stdout.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('{') && t.includes('"metric"')) {
        console.log(t);
      } else if (t) {
        console.error(t);
      }
    }
  }
  if (r.stderr) {
    for (const line of r.stderr.split(/\r?\n/)) {
      if (line.trim()) console.error(line);
    }
  }
  if (r.status !== 0) {
    console.error(`[block-workspace-perf] cargo exited ${r.status}`);
    process.exitCode = r.status ?? 1;
  }
}

function printHelp() {
  console.log(`block-workspace-perf — A-PERF 数值门测量脚手架（不改 TBD）

Usage:
  npm run perf:block-workspace [-- options]
  npx tsx scripts/block-workspace-perf.mjs [options]
  node --import tsx scripts/block-workspace-perf.mjs [options]

Options:
  --n <N>            block/slot count (default 1000; try 10000)
  --iters <K>        timed samples (default 7)
  --warmup <W>       warmup rounds (default 1)
  --queries <Q>      HeightMap queries per iter (default 10000)
  --rust             also run DocSession open_nk_blocks (cargo --ignored --release)
  --rust-only        only Rust path
  --heightmap-only   only HeightMap path (default if no --rust)
  -h, --help         this help

Manual backfill:
  Copy JSON lines → docs/block-workspace-architecture/plans/acceptance/perf-baseline.md
  See §7. NEVER let this script rewrite TBD as "pass".
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  // 默认只跑 HeightMap（轻量、无 cargo 编译）；--rust 加重测
  if (!opts.rustOnly) {
    await runHeightMap(opts);
  }
  if (opts.rust) {
    runRust(opts);
  }

  console.error(
    '[block-workspace-perf] done. Copy JSON lines manually into perf-baseline.md (§7). Do not auto-fill TBD.'
  );
}

main().catch((err) => {
  console.error('[block-workspace-perf] failed:', err);
  process.exitCode = 1;
});
