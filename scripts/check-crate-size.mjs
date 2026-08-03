#!/usr/bin/env node
/**
 * G6 行数门禁泛化脚本（I8 治理收口）。
 *
 * 语义（对齐 docs/multi-agent-repair/improvement/04-治理收尾方案.md G6；
 * 由 check-conex-db-size.mjs 的 LIB_LIMIT/MOD_LIMIT 泛化）：
 * - 扫描全部 crate 的 src/**（crates/* 与 apps/agent-workbench/src-tauri）：
 *     - 入口文件（lib.rs，无 lib.rs 则 main.rs）≤ 800 行；
 *     - 其余 mod 文件（含 src 内 tests.rs 等）≤ 600 行；
 * - 超限文件必须登记于 `基线记录/crate-size-baseline.md` 的 BASELINE_START/END
 *   标记区（豁免登记 + 维护注记理由与拆分时限）；新增超限文件未登记 → exit 1；
 * - 存量超限（已在基线内）→ 通过（拆分由后续轮次按登记时限执行）；
 * - `--update`：把当前超限清单全量写回标记区（登记豁免必须显式、有意的决策）；
 * - 测试规模顺带计数（jcode check_test_size_budget 语义）：各 crate 测试
 *   文件行数 / cfg(test) 块行数 / 用例数，只出计数不设门禁。
 *
 * 自测/集成选项：
 * - `--scan <crate根>`：覆盖扫描根（可重复传入；默认 = crates/* + src-tauri）
 * - `--baseline <路径>`：覆盖基线文件路径（默认 =
 *   docs/multi-agent-repair/基线记录/crate-size-baseline.md）
 *
 * Run: node scripts/check-crate-size.mjs [--update] [--scan <dir>] [--baseline <file>]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const START_MARKER = '<!-- BASELINE_START -->';
const END_MARKER = '<!-- BASELINE_END -->';

const LIB_LIMIT = 800;
const MOD_LIMIT = 600;

const UPDATE = process.argv.includes('--update');

function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 默认扫描根：crates/* + apps/agent-workbench/src-tauri */
const defaultScans = () => {
  const out = readdirSync(resolve(root, 'crates'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => resolve(root, 'crates', e.name));
  const tauri = resolve(root, 'apps/agent-workbench/src-tauri');
  if (existsSync(tauri)) out.push(tauri);
  return out;
};

const scanRoots = process.argv.includes('--scan')
  ? process.argv
      .map((v, i) => (v === '--scan' ? process.argv[i + 1] : null))
      .filter(Boolean)
      .map((s) => resolve(root, s))
  : defaultScans();

const baselinePath = argVal('--baseline')
  ? resolve(root, argVal('--baseline'))
  : join(root, 'docs/multi-agent-repair/基线记录/crate-size-baseline.md');

/** 行数口径与 check-conex-db-size.mjs 一致：'\n' 计数，末尾无换行 +1 */
function countLines(file) {
  const content = readFileSync(file, 'utf8');
  let lines = 0;
  for (const ch of content) {
    if (ch === '\n') lines++;
  }
  if (content.length > 0 && !content.endsWith('\n')) lines++;
  return lines;
}

function walkRs(dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkRs(p, acc);
    else if (entry.name.endsWith('.rs')) acc.push(p);
  }
  return acc;
}

/** 统计一个文件里 cfg(test) 块行数（仅 src 生产文件用） */
function countCfgTestLines(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let n = 0;
  let mode = 'code';
  let depth = 0;
  for (const raw of lines) {
    const code = raw.replace(/\/\/.*$/, '');
    if (mode === 'code') {
      if (/cfg\s*\(\s*test\s*\)/.test(code)) {
        mode = code.includes('{') ? 'test' : 'pending';
        if (mode === 'test') depth = 1;
        continue;
      }
    } else if (mode === 'pending') {
      if (code.includes('{')) {
        mode = 'test';
        depth = 1;
      } else {
        mode = 'code';
        continue;
      }
    } else {
      depth += (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
      if (depth <= 0) {
        mode = 'code';
        depth = 0;
      }
      n++;
      continue;
    }
    if (mode === 'test') n++;
  }
  return n;
}

/**
 * 收集：{ name, files: [{ path, rel, lines, kind }], test: { lines, cases } }
 * kind = entry | mod
 */
function collect() {
  const crates = [];
  for (const scan of scanRoots) {
    if (!existsSync(scan) || !statSync(scan).isDirectory()) {
      console.error(`[check-crate-size] FAIL: 扫描根不存在：${scan}`);
      process.exit(1);
    }
    const name = basename(scan);
    const srcDir = join(scan, 'src');
    if (!existsSync(srcDir)) continue;
    const entryName = existsSync(join(srcDir, 'lib.rs')) ? 'lib.rs' : 'main.rs';
    const files = [];
    let testLines = 0;
    let testCases = 0;
    for (const file of walkRs(srcDir, [])) {
      const rel = relative(root, file).replace(/\\/g, '/');
      const fname = basename(file);
      if (fname === entryName) {
        files.push({ path: rel, lines: countLines(file), kind: 'entry' });
        continue;
      }
      // 测试规模顺带计数（只计数不设门禁）
      if (fname === 'tests.rs' || fname.startsWith('test_') || fname.endsWith('_tests.rs')) {
        testLines += countLines(file);
      } else {
        testLines += countCfgTestLines(file);
      }
      const text = readFileSync(file, 'utf8');
      testCases += (text.match(/^\s*#\[(tokio::)?test\]/gm) || []).length;
      files.push({ path: rel, lines: countLines(file), kind: 'mod' });
    }
    // 集成测试目录（tests/、benches/）计入测试规模
    for (const sub of ['tests', 'benches']) {
      const dir = join(scan, sub);
      if (existsSync(dir)) {
        for (const f of walkRs(dir, [])) {
          testLines += countLines(f);
          const text = readFileSync(f, 'utf8');
          testCases += (text.match(/^\s*#\[(tokio::)?test\]/gm) || []).length;
        }
      }
    }
    crates.push({ name, files, test: { lines: testLines, cases: testCases } });
  }
  return crates;
}

/** 解析基线标记区：每行一个超限文件相对路径 */
function parseBaseline(text) {
  const si = text.indexOf(START_MARKER);
  const ei = text.indexOf(END_MARKER);
  if (si < 0 || ei < 0 || ei <= si) return null;
  const items = new Set();
  for (const line of text.slice(si + START_MARKER.length, ei).split('\n')) {
    const p = line.trim();
    if (p && !p.startsWith('#')) items.add(p.replace(/\\/g, '/'));
  }
  return items;
}

const crates = collect();
const over = [];
for (const c of crates) {
  for (const f of c.files) {
    const limit = f.kind === 'entry' ? LIB_LIMIT : MOD_LIMIT;
    if (f.lines > limit) over.push({ ...f, name: c.name, limit });
  }
}
over.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

// 测试规模汇总（观察项，不设门禁）
let totalTestLines = 0;
let totalTestCases = 0;
for (const c of crates) {
  totalTestLines += c.test.lines;
  totalTestCases += c.test.cases;
}

if (UPDATE) {
  const lines = over.map((f) => f.path);
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
    `[check-crate-size] --update 完成：标记区已登记 ${lines.length} 个超限文件（git diff 可复核）`
  );
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(`[check-crate-size] FAIL: 基线文件不存在：${baselinePath}`);
  console.error('处置：先显式运行 `node scripts/check-crate-size.mjs --update` 建立基线');
  process.exit(1);
}

const baseline = parseBaseline(readFileSync(baselinePath, 'utf8'));
if (!baseline) {
  console.error('[check-crate-size] FAIL: 基线文件缺少 BASELINE_START/END 标记区');
  process.exit(1);
}

let failed = false;
for (const c of crates) {
  for (const f of c.files) {
    const limit = f.kind === 'entry' ? LIB_LIMIT : MOD_LIMIT;
    const isOver = f.lines > limit;
    const registered = baseline.has(f.path.replace(/\\/g, '/'));
    if (isOver && !registered) {
      failed = true;
      console.error(
        `[check-crate-size] FAIL: ${f.path} 行数 ${f.lines} > ${limit}（${f.kind === 'entry' ? '入口' : 'mod'}）且未登记豁免`
      );
    }
    if (isOver) {
      console.log(
        `[check-crate-size]  超限（已登记${registered ? '✓' : '✗'}） ${f.path} = ${f.lines} 行（${f.kind === 'entry' ? '≤800' : '≤600'}）`
      );
    }
  }
  console.log(
    `[check-crate-size] ${c.name.padEnd(20)} 文件 ${String(c.files.length).padStart(3)} 最大 ${String(Math.max(...c.files.map((f) => f.lines))).padStart(5)} 行 | 测试 ${String(c.test.lines).padStart(6)} 行 / ${String(c.test.cases).padStart(4)} 用例`
  );
}
console.log(`[check-crate-size] 超限文件数 = ${over.length}（基线登记 ${[...baseline].filter((p) => over.some((f) => f.path === p)).length}）`);
console.log(`[check-crate-size] 测试规模顺带计数（观察项）：全仓测试 ${totalTestLines} 行 / ${totalTestCases} 用例`);

if (failed) {
  console.error('处置：新增超限文件必须拆分，或在 `node scripts/check-crate-size.mjs --update` 显式登记豁免（理由与拆分时限写入维护注记）');
  process.exit(1);
}

console.log('[check-crate-size] OK — 超限文件全部在基线登记内（lib.rs/main.rs ≤ 800，mod ≤ 600）');
