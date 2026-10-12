#!/usr/bin/env node
/**
 * G3 unwrap/expect 计数基线脚本（I8 治理收口）。
 *
 * 语义（对齐 docs/multi-agent-repair/improvement/04-治理收尾方案.md G3，
 * jcode check_panic_budget.py 语义）：
 * - 统计 crates/** 生产代码的 `.unwrap(` / `.expect(` 计数，按 crate 汇总；
 * - 生产/测试区分：tests/、benches/ 目录内文件与 tests.rs 等测试文件整体
 *   计入测试侧；src 内 `#[cfg(test)]` 块按花括号配平剔除，不计入门禁；
 * - 与 `基线记录/unwrap-baseline.md` 的 BASELINE_START/END 标记区比对：
 *   任一 crate 生产 unwrap/expect 计数 > 基线 → exit 1（新增 > 阈值即失败）；
 * - 存量下降 → exit 0（提示可显式 `--update` 刷新基线，只许降不许升）；
 * - `--update`：把当前计数全量写回标记区（提升基线必须显式、有意的清理）。
 *
 * 自测/集成选项：
 * - `--scan <crate根>`：覆盖扫描根（可重复传入；默认 = crates/ 全部子目录）
 * - `--baseline <路径>`：覆盖基线文件路径（默认 =
 *   docs/multi-agent-repair/基线记录/unwrap-baseline.md）
 *
 * Run: node scripts/check-unwrap-baseline.mjs [--update] [--scan <dir>] [--baseline <file>]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  : join(root, 'docs/multi-agent-repair/基线记录/unwrap-baseline.md');

/** 测试文件判定：tests/、benches/ 目录内，或文件名 tests.rs / test_* / *_tests.rs / tests_* / *_test_* / *_test.rs */
function isTestFile(file) {
  const p = file.replace(/\\/g, '/');
  if (/\/tests\//.test(p) || /\/benches\//.test(p)) return true;
  const base = basename(p);
  return (
    base === 'tests.rs' ||
    base.startsWith('test_') ||
    base.endsWith('_tests.rs') ||
    base.startsWith('tests_') ||
    base.includes('_test_') ||
    base.endsWith('_test.rs')
  );
}

/** 剔除行注释（///、//! 同属行注释，一并剔除）后统计计数 */
function countFile(file) {
  const text = readFileSync(file, 'utf8');
  const out = { prod: { unwrap: 0, expect: 0 }, test: { unwrap: 0, expect: 0 } };
  if (isTestFile(file)) {
    // 测试文件整体计入测试侧（不做 cfg(test) 块切换）
    for (const raw of text.split('\n')) {
      const code = raw.replace(/\/\/.*$/, '');
      out.test.unwrap += (code.match(/\.unwrap\(/g) || []).length;
      out.test.expect += (code.match(/\.expect\(/g) || []).length;
    }
    return out;
  }
  let mode = 'code'; // code | pending | test
  let depth = 0;
  for (const raw of text.split('\n')) {
    const code = raw.replace(/\/\/.*$/, '');
    if (mode === 'code') {
      if (/cfg\s*\(\s*test\s*\)/.test(code)) {
        // 块内花括号配平（attr 行或声明行出现 '{' 即入块）
        if (code.includes('{')) {
          mode = 'test';
          depth = 1;
        } else {
          mode = 'pending';
        }
        continue;
      }
    } else if (mode === 'pending') {
      // pending 只持续一行：下一行无 '{' 则回到生产计数（防 attr 单行形式吞码）
      if (code.includes('{')) {
        mode = 'test';
        depth = 1;
        continue;
      }
      mode = 'code';
    } else {
      // 测试块内：配平花括号
      depth += (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
      if (depth <= 0) {
        mode = 'code';
        depth = 0;
      }
      out.test.unwrap += (code.match(/\.unwrap\(/g) || []).length;
      out.test.expect += (code.match(/\.expect\(/g) || []).length;
      continue;
    }
    out.prod.unwrap += (code.match(/\.unwrap\(/g) || []).length;
    out.prod.expect += (code.match(/\.expect\(/g) || []).length;
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
      console.error(`[check-unwrap-baseline] FAIL: 扫描根不存在：${scan}`);
      process.exit(1);
    }
    const name = basename(scan);
    const files = walkRs(join(scan, 'src'), []);
    for (const file of files) {
      const c = countFile(file);
      const cur = crates.get(name) || {
        prod: { unwrap: 0, expect: 0 },
        test: { unwrap: 0, expect: 0 },
      };
      cur.prod.unwrap += c.prod.unwrap;
      cur.prod.expect += c.prod.expect;
      cur.test.unwrap += c.test.unwrap;
      cur.test.expect += c.test.expect;
      crates.set(name, cur);
    }
  }
  return crates;
}

/** 解析基线标记区：`<crate> <unwrap> <expect>` */
function parseBaseline(text) {
  const si = text.indexOf(START_MARKER);
  const ei = text.indexOf(END_MARKER);
  if (si < 0 || ei < 0 || ei <= si) return null;
  const items = new Map();
  for (const line of text.slice(si + START_MARKER.length, ei).split('\n')) {
    const m = line.match(/^\s*(\S+)\s+(\d+)\s+(\d+)\s*$/);
    if (m) items.set(m[1], { unwrap: Number(m[2]), expect: Number(m[3]) });
  }
  return items;
}

const current = collect();

if (UPDATE) {
  const names = [...current.keys()].sort();
  const lines = names.map(
    (n) => `${n} ${current.get(n).prod.unwrap} ${current.get(n).prod.expect}`
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
    `[check-unwrap-baseline] --update 完成：标记区已刷新为 ${lines.length} 个 crate（git diff 可复核）`
  );
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(
    `[check-unwrap-baseline] FAIL: 基线文件不存在：${baselinePath}`
  );
  console.error('处置：先显式运行 `node scripts/check-unwrap-baseline.mjs --update` 建立基线');
  process.exit(1);
}

const baseline = parseBaseline(readFileSync(baselinePath, 'utf8'));
if (!baseline) {
  console.error('[check-unwrap-baseline] FAIL: 基线文件缺少 BASELINE_START/END 标记区');
  process.exit(1);
}

let failed = false;
const added = [];
const removed = [];
for (const [name, cur] of [...current.entries()].sort()) {
  const base = baseline.get(name) || { unwrap: 0, expect: 0 };
  const du = cur.prod.unwrap - base.unwrap;
  const de = cur.prod.expect - base.expect;
  if (du > 0) added.push(`${name} unwrap +${du}`);
  if (de > 0) added.push(`${name} expect +${de}`);
  if (du < 0 || de < 0) removed.push(`${name} -${Math.abs(du)}/-${Math.abs(de)}`);
  console.log(
    `[check-unwrap-baseline] ${name.padEnd(20)} 生产 unwrap ${String(cur.prod.unwrap).padStart(4)}（基线 ${String(base.unwrap).padStart(4)}） expect ${String(cur.prod.expect).padStart(3)}（基线 ${String(base.expect).padStart(3)}） 测试 ${cur.test.unwrap}/${cur.test.expect}`
  );
}

if (added.length > 0) {
  failed = true;
  console.error(`[check-unwrap-baseline] FAIL: 新增 ${added.length} 项（生产代码 unwrap/expect 超基线）：`);
  for (const a of added) console.error(`  - ${a}`);
  console.error('处置：新增 unwrap/expect 必须消除；若确属有意清理后的基线提升，显式运行 `node scripts/check-unwrap-baseline.mjs --update`');
}

if (failed) process.exit(1);

if (removed.length > 0) {
  console.log(`[check-unwrap-baseline] OK: 存量下降 ${removed.length} 项（ratchet 允许下降；清理有意后可显式 \`--update\` 刷新基线）`);
} else {
  console.log('[check-unwrap-baseline] OK: 各 crate 生产计数均在基线内（新增 0）');
}
