#!/usr/bin/env node
/**
 * scripts/check-perf-budgets.mjs
 * 性能预算 SSOT 门禁（D0 / U-BUDGET · INV-8）
 *
 * 规格来源：docs/performance-audit/materials/plans/detail-D0-预算SSOT.md §1.3
 * 任务书：  docs/performance-audit/92-修复总方案.md §3 / INV-8
 *
 * 语义（终态 fail 级，无「永久 warn」默认）：
 *   硬失败：
 *     defined_outside_sot  已登记预算常量名在 SoT/镜像之外出现定义型 const
 *     third_source         存在被当作权威的 scripts/perf-budgets.json（禁建）
 *     mirror_drift         perf_budget.rs 与 perfBudgets.ts 同名导出数值漂移
 *     pe02_production      PE02_* 被业务 crate 生产 import（解锁前禁止）
 *   允许：
 *     单元测试 fixture 内字面量；perf_budget.rs / perfBudgets.ts 自身；
 *     bounds.ts（package 导出面）；re-export / import 形态；
 *     同值不同语义的其它预算（如 git MAX_OUTPUT_BYTES ≠ TOOL_OUTPUT_BYTE_CAP）
 *
 * 输出契约：每条 FAIL 必须给出
 *   「违反项 · 路径:行号 · 当前值 · 应从何处 import · 正确做法」五元组
 *
 * CLI：node scripts/check-perf-budgets.mjs [--list] [--guide <const>] [--update]
 * 默认模式 = fail（FM-10；若须 warn 须附删除日期 + issue 登记——评审 02 AC-1）
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── CLI ────────────────────────────────────────────────────────────────
function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const LIST = process.argv.includes('--list');
const UPDATE = process.argv.includes('--update');
const GUIDE = argVal('--guide');

const BASELINE_PATH = resolve(REPO_ROOT, 'docs/performance-audit/基线记录/perf-budgets-baseline.json');

// ── 登记表：预算常量（name → 元数据） ─────────────────────────────────
/**
 * type: 'bytes' | 'count' | 'kb' | 'ms' | 'bool'
 * fe: true 表示 FE 镜像面也有同名导出（参与 mirror drift）
 * reserved: PE02 等解锁前禁止生产引用
 */
const REGISTRY = {
  SHELL_PREVIEW_HEAD_BYTES: { value: 24 * 1024, side: 'rust', guide: 'use conex_shared::perf_budget::SHELL_PREVIEW_HEAD_BYTES' },
  SHELL_PREVIEW_TAIL_BYTES: { value: 24 * 1024, side: 'rust', guide: 'use conex_shared::perf_budget::SHELL_PREVIEW_TAIL_BYTES' },
  TOOL_INLINE_BYTES_DEFAULT: { value: 24000, side: 'rust', aliases: ['DEFAULT_INLINE_BYTES'], guide: 'use conex_shared::perf_budget::TOOL_INLINE_BYTES_DEFAULT' },
  SHELL_MAX_OUTPUT_BYTES_DEFAULT: { value: 200000, side: 'rust', guide: 'use conex_shared::perf_budget::SHELL_MAX_OUTPUT_BYTES_DEFAULT' },
  SHELL_ACCUM_HARD_CAP_FACTOR: { value: 8, side: 'rust', guide: 'use conex_shared::perf_budget::SHELL_ACCUM_HARD_CAP_FACTOR（U-MEM）' },
  MCP_STDOUT_MAX_LINE_BYTES: { value: 16 * 1024 * 1024, side: 'rust', guide: 'use conex_shared::perf_budget::MCP_STDOUT_MAX_LINE_BYTES（U-MEM）' },
  READ_FILE_MAX_BYTES_DEFAULT: { value: 256000, side: 'rust', aliases: ['DEFAULT_READ_MAX_BYTES'], guide: 'use conex_shared::perf_budget::READ_FILE_MAX_BYTES_DEFAULT' },
  SEARCH_MAX_FILE_BYTES_DEFAULT: { value: 512000, side: 'rust', aliases: ['DEFAULT_MAX_FILE_BYTES'], guide: 'use conex_shared::perf_budget::SEARCH_MAX_FILE_BYTES_DEFAULT' },
  FS_LIST_DIRECTORY_DEFAULT_LIMIT: { value: 2000, side: 'rust', unwired: true, guide: '登记常量；接线归 D1/D2' },
  G8_TOOL_OUTPUT_MAX_LINES_DEFAULT: { value: 2000, side: 'rust', aliases: ['TOOL_OUTPUT_MAX_LINES_DEFAULT'], guide: 'use conex_shared::perf_budget::G8_TOOL_OUTPUT_MAX_LINES_DEFAULT' },
  G8_TOOL_OUTPUT_MAX_BYTES_DEFAULT: { value: 50 * 1024, side: 'rust', aliases: ['TOOL_OUTPUT_MAX_BYTES_DEFAULT'], guide: 'use conex_shared::perf_budget::G8_TOOL_OUTPUT_MAX_BYTES_DEFAULT' },
  TOOL_OUTPUT_BUDGET_BYTES_DEFAULT: { value: 64 * 1024, side: 'rust', guide: 'use conex_shared::perf_budget::TOOL_OUTPUT_BUDGET_BYTES_DEFAULT（接线归 D1）' },
  TOOL_OUTPUT_LINE_CAP: { value: 2000, side: 'both', guide: "import { TOOL_OUTPUT_LINE_CAP } from '…/api/perfBudgets'" },
  TOOL_OUTPUT_BYTE_CAP: { value: 256 * 1024, side: 'both', guide: "import { TOOL_OUTPUT_BYTE_CAP } from '…/api/perfBudgets'" },
  TOOL_OUTPUT_STORE_HARD_CAP: { value: 256 * 1024, side: 'both', guide: "import { TOOL_OUTPUT_STORE_HARD_CAP } from '…/api/perfBudgets'（生效归 D5）" },
  PTY_HISTORY_MAX_BYTES: { value: 256 * 1024, side: 'both', guide: "import { PTY_HISTORY_MAX_BYTES } from '…/api/perfBudgets'" },
  SESSION_HYDRATE_KEEP_K: { value: 3, side: 'both', guide: "import { SESSION_HYDRATE_KEEP_K } from '…/api/perfBudgets'（驱逐逻辑归 D5）" },
  RUST_MARKDOWN_CACHE_BUDGET_BYTES: { value: 32 * 1024 * 1024, side: 'rust', aliases: ['CACHE_BUDGET_BYTES'], guide: 'use conex_shared::perf_budget::RUST_MARKDOWN_CACHE_BUDGET_BYTES' },
  RUST_MARKDOWN_CACHE_ENTRY_MAX_BYTES: { value: 1024 * 1024, side: 'rust', aliases: ['CACHE_ENTRY_MAX_BYTES'], guide: 'use conex_shared::perf_budget::RUST_MARKDOWN_CACHE_ENTRY_MAX_BYTES' },
  STARTUP_ENTRY_BUDGET_KB: { value: 520, side: 'rust', guide: '门禁命名空间 · D9 check-startup-budget；数值登记于 perf_budget' },
  STARTUP_STATIC_GRAPH_BUDGET_KB_TRANSITION: { value: 1800, side: 'rust', guide: '门禁命名空间 · D9；数值登记于 perf_budget' },
  STARTUP_STATIC_GRAPH_BUDGET_KB_FROZEN: { value: 900, side: 'rust', guide: '门禁命名空间 · D9；数值登记于 perf_budget' },
  EVENT_BUFFER_SOFT_WATERMARK: { value: 64, side: 'rust', guide: 'use conex_shared::perf_budget::EVENT_BUFFER_SOFT_WATERMARK（有界化归 D1）' },
  EVENT_BUFFER_HARD_CAP: { value: 256, side: 'rust', guide: 'use conex_shared::perf_budget::EVENT_BUFFER_HARD_CAP（有界化归 D1）' },
  PE02_MERGE_WINDOW_MAX_EVENTS: { value: 1, side: 'rust', reserved: true, guide: '预留 · 解锁前禁止生产读取' },
  PE02_MERGE_WINDOW_MS: { value: 0, side: 'rust', reserved: true, guide: '预留 · 解锁前禁止生产读取' },
};

// 允许定义的文件（相对 REPO_ROOT，正斜杠）
const SOT_RUST = 'crates/conex-shared/src/perf_budget.rs';
const MIRROR_FE = 'apps/crish-desktop/src/api/perfBudgets.ts';
const BOUNDS_TS = 'packages/shared-utils/src/bounds.ts';
const STARTUP_SCRIPT = 'scripts/check-startup-budget.mjs';

const ALLOW_DEFINE = new Set([SOT_RUST, MIRROR_FE]);
const ALLOW_MAGIC = new Set([SOT_RUST, MIRROR_FE, BOUNDS_TS, STARTUP_SCRIPT]);

// 扫描根
const SCAN_ROOTS = [
  'crates',
  'apps/crish-desktop/src',
  'apps/agent-workbench/src-tauri/src',
];

const SKIP_DIRS = new Set(['target', 'node_modules', 'dist', 'coverage', '.git', '__snapshots__', 'fixtures']);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('fixture')) continue;
      walk(join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

const rel = (p) => relative(REPO_ROOT, p).replace(/\\/g, '/');

function isTestFile(p) {
  return /\.test\.|\.spec\.|test-setup|__mocks__|_tests\.|tests\.rs|test_support/.test(p);
}

function isScanTarget(p) {
  return /\.(rs|ts|tsx|mjs|js)$/.test(p) && !/\.(d\.ts|test\.ts|test\.tsx|spec\.ts|spec\.tsx)$/.test(p);
}

// ── 表达式求值（仅支持 a * b / a_000 / 数字字面量） ───────────────────
function evalBudgetExpr(expr) {
  const s = expr.replace(/_/g, '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  const mul = s.match(/^(\d+)\s*\*\s*(\d+)$/);
  if (mul) return Number(mul[1]) * Number(mul[2]);
  return null;
}

// ── 扫描 ───────────────────────────────────────────────────────────────
function collectFiles() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    walk(resolve(REPO_ROOT, root), files);
  }
  return files.filter((p) => isScanTarget(p));
}

function namePatterns() {
  /** name → regex source for defining const */
  const map = new Map();
  for (const [name, meta] of Object.entries(REGISTRY)) {
    const names = [name, ...(meta.aliases || [])];
    map.set(name, names);
  }
  return map;
}

function scan(files) {
  const violations = [];
  const patterns = namePatterns();
  const allNames = new Set();
  for (const names of patterns.values()) for (const n of names) allNames.add(n);

  // 反查 alias → canonical
  const aliasToCanonical = new Map();
  for (const [canon, names] of patterns) for (const n of names) aliasToCanonical.set(n, canon);

  for (const file of files) {
    const r = rel(file);
    if (ALLOW_DEFINE.has(r) || ALLOW_MAGIC.has(r) && r === SOT_RUST) continue;
    if (isTestFile(file)) continue;

    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);

    // 1) PE02 生产引用（reserved）——业务 crate 中出现 use/import PE02_* 即 fail
    if (r.startsWith('crates/') && r !== SOT_RUST) {
      lines.forEach((line, i) => {
        const t = line.trim();
        if (/^\s*(\/\/|\/\*|\*)/.test(t)) return;
        if (/PE02_MERGE_WINDOW/.test(line) && /\buse\b/.test(line)) {
          violations.push({
            kind: 'pe02_production',
            file: r,
            line: i + 1,
            value: t.slice(0, 120),
            from: SOT_RUST,
            fix: 'PE02_* 解锁前禁止生产读取（T2 会签后才允许消费）',
          });
        }
      });
    }

    // 2) 定义型 const（非 re-export）
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      // re-export / use 形态允许
      if (/^\s*(pub\s+)?use\s+/.test(line)) return;
      if (/^\s*export\s*\{/.test(line)) return;
      if (/^\s*export\s+type\b/.test(line)) return;
      if (/^\s*\/\/|\/\*|^\s*\*/.test(trimmed)) return;

      // Rust: pub(crate) const NAME: TYPE = VALUE;
      // TS: export const NAME = VALUE;  / const NAME = VALUE;
      const defRe = /(?:export\s+)?(?:pub(?:\([^)]*\))?\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*([^;]+);/;
      const m = trimmed.match(defRe);
      if (!m) return;
      const constName = m[1];
      const rhs = m[2].trim();
      if (!allNames.has(constName)) return;

      const canon = aliasToCanonical.get(constName);
      // bounds.ts 缓存族允许（短暂登记；数值真源在 package）
      if (r === BOUNDS_TS) return;
      // 启动脚本 DEFAULT_BUDGET_KB 特例（D9 拥有）
      if (r === STARTUP_SCRIPT && constName === 'DEFAULT_BUDGET_KB') return;
      // SoT / mirror 自身
      if (ALLOW_DEFINE.has(r)) return;

      // re-export / import 形态的 const 定义仍算定义 —— fail
      violations.push({
        kind: 'defined_outside_sot',
        file: r,
        line: i + 1,
        value: `${constName} = ${rhs}`,
        from: REGISTRY[canon]?.guide || SOT_RUST,
        fix: `删除本地定义，改为从 SoT/镜像 re-export 或 import（${canon}）`,
      });
    });

    // 3) 魔数（保守）：仅当业务源出现「已登记专属名」的赋值字面量
    //    ——纯数值巧合（如 git MAX_OUTPUT_BYTES=256KB 与 TOOL_OUTPUT_BYTE_CAP 同值
    //    但语义不同）不在此检出；同语义第二定义靠上面 NAME 匹配覆盖。
  }

  // 4) 第三真源：scripts/perf-budgets.json 不得作为权威
  const third = resolve(REPO_ROOT, 'scripts/perf-budgets.json');
  if (existsSync(third)) {
    violations.push({
      kind: 'third_source',
      file: 'scripts/perf-budgets.json',
      line: 1,
      value: 'file exists',
      from: SOT_RUST,
      fix: '禁止长期独立 perf-budgets.json 作第三真源（CFL-01）；启动图谱用 startup-graph-budget.json 且仅 D9 读',
    });
  }

  // 5) 镜像漂移：同名导出数值一致性
  violations.push(...checkMirrorDrift());

  return violations;
}

function extractRustConsts() {
  const p = resolve(REPO_ROOT, SOT_RUST);
  if (!existsSync(p)) return new Map();
  const text = readFileSync(p, 'utf8');
  const map = new Map();
  const re = /pub const ([A-Z][A-Z0-9_]*):\s*[^=]+=\s*([^;]+);/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = evalBudgetExpr(m[2]);
    if (v !== null) map.set(m[1], v);
  }
  return map;
}

function extractTsConsts() {
  const p = resolve(REPO_ROOT, MIRROR_FE);
  if (!existsSync(p)) return new Map();
  const text = readFileSync(p, 'utf8');
  const map = new Map();
  const re = /export const ([A-Z][A-Z0-9_]*)\s*=\s*([^;]+);/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = evalBudgetExpr(m[2]);
    if (v !== null) map.set(m[1], v);
  }
  return map;
}

function checkMirrorDrift() {
  const rust = extractRustConsts();
  const fe = extractTsConsts();
  const out = [];
  // 同名子集必须相等（FE-only 子集允许——缓存族转口不在 Rust 同名）
  for (const [name, feVal] of fe) {
    if (!rust.has(name)) continue; // FE-only / re-export from bounds
    const rsVal = rust.get(name);
    if (rsVal !== feVal) {
      out.push({
        kind: 'mirror_drift',
        file: `${MIRROR_FE} ↔ ${SOT_RUST}`,
        line: 0,
        value: `${name}: rust=${rsVal} fe=${feVal}`,
        from: SOT_RUST,
        fix: '改数值先改 perf_budget.rs，再同步 perfBudgets.ts（同名必须一致）',
      });
    }
  }
  return out;
}

// ── 基线（棘轮：违规数只降不升；--update 须显式） ─────────────────────
function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    const t = readFileSync(BASELINE_PATH, 'utf8');
    const j = JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
    return j;
  } catch {
    return null;
  }
}

function saveBaseline(violations) {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  const payload = {
    note: 'D0 perf-budgets 违规基线（只降不升；--update 须在提交信息说明理由）',
    updatedAt: new Date().toISOString().slice(0, 10),
    violations: violations.map((v) => ({
      kind: v.kind,
      file: v.file,
      line: v.line,
      value: v.value,
    })),
    count: violations.length,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

// ── 主流程 ─────────────────────────────────────────────────────────────
function printGuide(name) {
  const meta = REGISTRY[name];
  if (!meta) {
    console.error(`[check-perf-budgets] 未知常量: ${name}`);
    console.error(`  已登记: ${Object.keys(REGISTRY).join(', ')}`);
    process.exit(1);
  }
  console.log(`常量: ${name}`);
  console.log(`  值:     ${meta.value}`);
  console.log(`  侧:     ${meta.side}`);
  console.log(`  正确做法: ${meta.guide}`);
  if (meta.reserved) console.log('  ⚠ 预留：解锁前禁止生产读取');
  if (meta.unwired) console.log('  ⚠ 已登记未接线（接线主责见详案）');
  process.exit(0);
}

function printList() {
  console.log('已登记性能预算常量：');
  for (const [name, meta] of Object.entries(REGISTRY)) {
    const flags = [
      meta.reserved ? 'RESERVED' : null,
      meta.unwired ? 'UNWIRED' : null,
    ].filter(Boolean).join(',');
    console.log(`  ${name.padEnd(42)} = ${String(meta.value).padEnd(12)} [${meta.side}]${flags ? ` (${flags})` : ''}`);
  }
  console.log(`\nSoT:   ${SOT_RUST}`);
  console.log(`镜像:  ${MIRROR_FE}`);
  console.log(`转口:  ${BOUNDS_TS}（缓存族数值真源）`);
  process.exit(0);
}

function failOut(violations) {
  console.error('[check-perf-budgets] FAIL');
  for (const v of violations) {
    console.error(
      `  违反项: ${v.kind} · ${v.file}:${v.line} · 当前值: ${v.value}\n` +
      `    应从: ${v.from}\n` +
      `    正确做法: ${v.fix}`
    );
  }
  console.error(`\n共 ${violations.length} 条违规。`);
  console.error('  · 参考: node scripts/check-perf-budgets.mjs --guide <CONST>');
  console.error('  · 参考: node scripts/check-perf-budgets.mjs --list');
  console.error('  · 纪律: 预算数字只出现在 perf_budget / perfBudgets（+ bounds 转口）；禁第三真源。');
  process.exit(1);
}

function main() {
  if (UPDATE && (LIST || GUIDE)) {
    console.error('[check-perf-budgets] FAIL: --update 与 --list/--guide 互斥');
    process.exit(1);
  }
  if (LIST) printList();
  if (GUIDE) printGuide(GUIDE);

  const files = collectFiles();
  const violations = scan(files);

  if (UPDATE) {
    saveBaseline(violations);
    console.log(`[check-perf-budgets] 基线已写入（${violations.length} 条）: ${rel(BASELINE_PATH)}`);
    process.exit(0);
  }

  if (violations.length === 0) {
    console.log(`PASS: perf-budgets SSOT 对齐（扫描 ${files.length} 文件 · 登记 ${Object.keys(REGISTRY).length} 常量）`);
    process.exit(0);
  }

  // 基线棘轮：已登记违规不新增才可通过
  const baseline = loadBaseline();
  if (baseline && Array.isArray(baseline.violations)) {
    const key = (v) => `${v.kind}|${v.file}|${v.value}`;
    const baseKeys = new Set(baseline.violations.map(key));
    const news = violations.filter((v) => !baseKeys.has(key(v)));
    if (news.length === 0 && violations.length <= baseline.count) {
      console.log(
        `PASS (baseline): ${violations.length} 条已登记违规（基线 ${baseline.count}，无新增）。` +
        `终态须清零——全部迁入 SoT 后删除基线。`
      );
      process.exit(0);
    }
    if (news.length > 0) {
      failOut(news);
    }
  }

  failOut(violations);
}

main();
