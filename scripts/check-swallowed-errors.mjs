#!/usr/bin/env node
/**
 * G4 错误吞没统计脚本（I8 治理收口）。
 *
 * 语义（对齐 docs/multi-agent-repair/improvement/04-治理收尾方案.md G4，
 * jcode check_swallowed_error_budget.py 语义）：
 * - 统计 crates/** 生产代码（测试文件与 cfg(test) 块除外，规则同
 *   check-unwrap-baseline.mjs）的两类吞错模式：
 *     1. `let _ = ...`（含 `let _: T = ...`）丢弃赋值；
 *     2. `if let Ok(_)` / `Ok(_) =>` 忽略 Ok 值（错误面静默）模式；
 * - 与 `基线记录/swallowed-errors-baseline.md` 的 BASELINE_START/END 标记区比对：
 *   任一 crate 任一类计数 > 基线 → exit 1（新增吞错必须登记或消除）；
 * - 存量下降 → exit 0（提示可显式 `--update` 刷新基线）；
 * - `--update`：把当前计数全量写回标记区（提升基线必须显式、有意的登记）。
 *
 * 自测/集成选项：
 * - `--scan <crate根>`：覆盖扫描根（可重复传入；默认 = crates/ 全部子目录）
 * - `--baseline <路径>`：覆盖基线文件路径（默认 =
 *   docs/multi-agent-repair/基线记录/swallowed-errors-baseline.md）
 *
 * Run: node scripts/check-swallowed-errors.mjs [--update] [--scan <dir>] [--baseline <file>]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── --guide（T-DEBT-08：正确做法指引 · 五元规约） ─────────────────────────────
// 用法：node scripts/check-swallowed-errors.mjs --guide → 打印违反项/定位/阈值/正确做法。
// 仅在直接运行且带 --guide 时早退；不带 flag 时既有行为零变化。
const __debt08GuideFlag = process.argv.includes('--guide');
if (__debt08GuideFlag) {
  const __debt08Guide = [
    "违反项：crates/** 生产代码新增 `let _ = ...` 丢弃赋值或 `if let Ok(_)` / `Ok(_) =>` 静默模式（测试文件与 cfg(test) 块不计）。",
    "文件:行号 / 当前值：FAIL 按 crate 列出新增项与基线对比；当前值 = 生产计数。",
    "阈值：任一 crate 生产计数 > 基线即 fail（ratchet 只许降）。",
    "正确做法：用 ? 传播、日志记录或显式处理消除；确属有意的清理下降后 --update 刷新 基线记录/swallowed-errors-baseline.md。",
    "复核：node scripts/check-swallowed-errors.mjs  # 期望 exit 0",
  ];
  console.log('[check-swallowed-errors] 正确做法 · 五元规约\n');
  for (const l of __debt08Guide) console.log('  ' + l);
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const START_MARKER = '<!-- BASELINE_START -->';
const END_MARKER = '<!-- BASELINE_END -->';

const UPDATE = process.argv.includes('--update');

function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 扫描根：--scan 可重复传入；默认 crates/ 全部子目录 */
const scanRoots =
  process.argv.includes('--scan')
    ? process.argv
        .map((v, i) => (v === '--scan' ? process.argv[i + 1] : null))
        .filter(Boolean)
        .map((s) => resolve(root, s))
    : readdirSync(resolve(root, 'crates'), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => resolve(root, 'crates', e.name));

const baselinePath = argVal('--baseline')
  ? resolve(root, argVal('--baseline'))
  : join(root, 'docs/multi-agent-repair/基线记录/swallowed-errors-baseline.md');

/** 测试文件判定（对齐 check-unwrap-baseline.mjs 口径并补 `*_tests_*.rs` 中缀，
 *  T-GAP-11：`projection_tests_commit.rs` / `anthropic_tests_usage.rs` /
 *  `tests_cas_gc.rs` 等旁挂测试模块（经 #[cfg(test)] #[path] 接线）此前被误计生产口径） */
function isTestFile(file) {
  const p = file.replace(/\\/g, '/');
  if (
    /\/tests\//.test(p) ||
    /\/benches\//.test(p) ||
    /_tests\//.test(p) ||
    /\/tests_[^/]+\//.test(p)
  )
    return true;
  const base = basename(p);
  return (
    base === 'tests.rs' ||
    base.startsWith('test_') ||
    base.startsWith('tests_') ||
    base.includes('_tests_') ||
    base.endsWith('_tests.rs') ||
    base.endsWith('_test.rs')
  );
}

/** 吞错模式正则（行注释剔除后匹配） */
const LET_UNDERSCORE_RE = /let\s+_(?:\s*:\s*[^=;]+)?\s*=\s*/;
const OK_PATTERN_RE = /if\s+let\s+Ok\(_\s*\)|Ok\(_\s*\)\s*=>/g;

/** 按行扫描一个源文件（cfg(test) 块剔除规则与 unwrap 脚本一致） */
function countFile(file) {
  const text = readFileSync(file, 'utf8');
  const out = { prod: { let_underscore: 0, ok_pattern: 0 }, test: { let_underscore: 0, ok_pattern: 0 } };
  if (isTestFile(file)) {
    // 测试文件整体计入测试侧（不做 cfg(test) 块切换）
    for (const raw of text.split('\n')) {
      const code = raw.replace(/\/\/.*$/, '');
      if (LET_UNDERSCORE_RE.test(code)) out.test.let_underscore++;
      out.test.ok_pattern += (code.match(OK_PATTERN_RE) || []).length;
    }
    return out;
  }
  let mode = 'code'; // code | pending | test
  let depth = 0;
  for (const raw of text.split('\n')) {
    const code = raw.replace(/\/\/.*$/, '');
    if (mode === 'code') {
      if (/cfg\s*\(\s*test\s*\)/.test(code)) {
        if (code.includes('{')) {
          mode = 'test';
          depth = 1;
        } else {
          mode = 'pending';
        }
        continue;
      }
    } else if (mode === 'pending') {
      if (code.includes('{')) {
        mode = 'test';
        depth = 1;
        continue;
      }
      mode = 'code';
    } else {
      depth += (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
      if (depth <= 0) {
        mode = 'code';
        depth = 0;
      }
      if (LET_UNDERSCORE_RE.test(code)) out.test.let_underscore++;
      out.test.ok_pattern += (code.match(OK_PATTERN_RE) || []).length;
      continue;
    }
    if (LET_UNDERSCORE_RE.test(code)) out.prod.let_underscore++;
    out.prod.ok_pattern += (code.match(OK_PATTERN_RE) || []).length;
  }
  return out;
}

function walkRs(dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkRs(p, acc);
    else if (entry.name.endsWith('.rs')) acc.push(p);
  }
  return acc;
}

/** 按 crate 汇总（crate 名 = 扫描根目录名） */
function collect() {
  const crates = new Map();
  for (const scan of scanRoots) {
    if (!existsSync(scan) || !statSync(scan).isDirectory()) {
      console.error(`[check-swallowed-errors] FAIL: 扫描根不存在：${scan}`);
      process.exit(1);
    }
    const name = basename(scan);
    for (const file of walkRs(join(scan, 'src'), [])) {
      const c = countFile(file);
      const cur = crates.get(name) || {
        prod: { let_underscore: 0, ok_pattern: 0 },
        test: { let_underscore: 0, ok_pattern: 0 },
      };
      cur.prod.let_underscore += c.prod.let_underscore;
      cur.prod.ok_pattern += c.prod.ok_pattern;
      cur.test.let_underscore += c.test.let_underscore;
      cur.test.ok_pattern += c.test.ok_pattern;
      crates.set(name, cur);
    }
  }
  return crates;
}

/** 解析基线标记区：`<crate> <let_underscore> <ok_pattern>` */
function parseBaseline(text) {
  const si = text.indexOf(START_MARKER);
  const ei = text.indexOf(END_MARKER);
  if (si < 0 || ei < 0 || ei <= si) return null;
  const items = new Map();
  for (const line of text.slice(si + START_MARKER.length, ei).split('\n')) {
    const m = line.match(/^\s*(\S+)\s+(\d+)\s+(\d+)\s*$/);
    if (m) items.set(m[1], { let_underscore: Number(m[2]), ok_pattern: Number(m[3]) });
  }
  return items;
}

const current = collect();

if (UPDATE) {
  const names = [...current.keys()].sort();
  const lines = names.map(
    (n) => `${n} ${current.get(n).prod.let_underscore} ${current.get(n).prod.ok_pattern}`
  );
  const eol = existsSync(baselinePath)
    ? (readFileSync(baselinePath, 'utf8').includes('\r\n') ? '\r\n' : '\n')
    : '\n';
  const head = existsSync(baselinePath) ? readFileSync(baselinePath, 'utf8') : '';
  const si = head.indexOf(START_MARKER);
  const ei = head.indexOf(END_MARKER);
  const newText =
    (si >= 0 && ei > si
      ? head.slice(0, si + START_MARKER.length) + eol + lines.join(eol) + eol + head.slice(ei)
      : head + (head.endsWith('\n') ? '' : '\n') + START_MARKER + '\n' + lines.join('\n') + '\n' + END_MARKER + '\n');
  writeFileSync(baselinePath, newText);
  console.log(
    `[check-swallowed-errors] --update 完成：标记区已刷新为 ${lines.length} 个 crate（git diff 可复核）`
  );
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(`[check-swallowed-errors] FAIL: 基线文件不存在：${baselinePath}`);
  console.error('处置：先显式运行 `node scripts/check-swallowed-errors.mjs --update` 建立基线');
  process.exit(1);
}

const baseline = parseBaseline(readFileSync(baselinePath, 'utf8'));
if (!baseline) {
  console.error('[check-swallowed-errors] FAIL: 基线文件缺少 BASELINE_START/END 标记区');
  process.exit(1);
}

let failed = false;
const added = [];
const removed = [];
for (const [name, cur] of [...current.entries()].sort()) {
  const base = baseline.get(name) || { let_underscore: 0, ok_pattern: 0 };
  const du = cur.prod.let_underscore - base.let_underscore;
  const de = cur.prod.ok_pattern - base.ok_pattern;
  if (du > 0) added.push(`${name} let_= +${du}`);
  if (de > 0) added.push(`${name} Ok(_) +${de}`);
  if (du < 0 || de < 0) removed.push(`${name} -${Math.abs(du)}/-${Math.abs(de)}`);
  console.log(
    `[check-swallowed-errors] ${name.padEnd(20)} 生产 let_= ${String(cur.prod.let_underscore).padStart(3)}（基线 ${String(base.let_underscore).padStart(3)}） Ok(_) ${String(cur.prod.ok_pattern).padStart(3)}（基线 ${String(base.ok_pattern).padStart(3)}） 测试 ${cur.test.let_underscore}/${cur.test.ok_pattern}`
  );
}

if (added.length > 0) {
  failed = true;
  console.error(`[check-swallowed-errors] FAIL: 新增 ${added.length} 项（生产代码吞错模式超基线）：`);
  for (const a of added) console.error(`  - ${a}`);
  console.error('处置：新增吞错必须消除或显式登记；若确属有意，运行 `node scripts/check-swallowed-errors.mjs --update` 刷新基线');
}

if (failed) process.exit(1);

if (removed.length > 0) {
  console.log(`[check-swallowed-errors] OK: 存量下降 ${removed.length} 项（ratchet 允许下降；清理有意后可显式 \`--update\` 刷新基线）`);
} else {
  console.log('[check-swallowed-errors] OK: 各 crate 生产吞错计数均在基线内（新增 0）');
}
