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
 *   标记区（格式 `<相对路径> <登记行数>`，与 frontend-line-counts 基线同形）；
 *   登记 = 限速豁免（冻结上限）：实测 ≤ 登记行数 → 通过（拆分按登记时限执行）；
 *   实测 > 登记行数 → FAIL（已登记但回涨同样被拦，G-01 语义硬化）；
 *   未登记超限 → FAIL（新增超限必须显式登记）；
 * - `--update`：把当前超限清单全量写回标记区（含实测行数；登记豁免必须显式、
 *   有意的决策，理由与拆分时限写入维护注记）；
 * - `--migrate`：只读既有登记条目（路径）逐条实测行数后回写为
 *   `path count` 新格式；绝不写入任何未登记超限文件（独立迁移路径，
 *   禁止与 `--update` 混用）；
 * - `--check-format`：校验标记区每行匹配 `^\S+\s+\d+$`（无行数旧格式 → exit 1）；
 * - 测试规模顺带计数（jcode check_test_size_budget 语义）：各 crate 测试
 *   文件行数 / cfg(test) 块行数 / 用例数，只出计数不设门禁。
 *
 * 自测/集成选项：
 * - `--scan <crate根>`：覆盖扫描根（可重复传入；默认 = crates/* + src-tauri）
 * - `--baseline <路径>`：覆盖基线文件路径（默认 =
 *   docs/multi-agent-repair/基线记录/crate-size-baseline.md）
 *
 * Run: node scripts/check-crate-size.mjs [--update|--migrate|--check-format] [--scan <dir>] [--baseline <file>]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── --guide（T-DEBT-08：正确做法指引 · 五元规约） ─────────────────────────────
// 用法：node scripts/check-crate-size.mjs --guide → 打印违反项/定位/阈值/正确做法。
// 仅在直接运行且带 --guide 时早退；不带 flag 时既有行为零变化。
const __debt08GuideFlag = process.argv.includes('--guide');
if (__debt08GuideFlag) {
  const __debt08Guide = [
    "违反项：crate 入口（lib.rs / main.rs）超 800 行，或其余 mod 文件超 600 行且未登记基线。",
    "文件:行号 / 当前值：FAIL 输出超限文件与实测/登记行数。",
    "阈值：入口 ≤ 800；mod ≤ 600；基线条目 = 冻结上限（实测 ≤ 登记值放行，增长即 fail）。",
    "正确做法：拆分超限文件；确需限速的登记 基线记录/crate-size-baseline.md 标记区（登记行数 = 拆分期限上限，非永久豁免）。",
    "复核：node scripts/check-crate-size.mjs  # 期望 OK",
  ];
  console.log('[check-crate-size] 正确做法 · 五元规约\n');
  for (const l of __debt08Guide) console.log('  ' + l);
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const START_MARKER = '<!-- BASELINE_START -->';
const END_MARKER = '<!-- BASELINE_END -->';

const LIB_LIMIT = 800;
const MOD_LIMIT = 600;

const UPDATE = process.argv.includes('--update');
const MIGRATE = process.argv.includes('--migrate');
const CHECK_FORMAT = process.argv.includes('--check-format');

const modes = [
  ['--update', UPDATE],
  ['--migrate', MIGRATE],
  ['--check-format', CHECK_FORMAT],
].filter(([, on]) => on);
if (modes.length > 1) {
  console.error(
    `[check-crate-size] FAIL: 模式互斥，只能二选一：${modes.map(([n]) => n).join(' / ')}`
  );
  process.exit(1);
}

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

/**
 * 解析基线标记区：每行一个 `<相对路径> <登记行数>` 条目（与 frontend-line-counts
 * 基线同形）；无行数旧格式条目记入 legacyEntries（不授予豁免，须迁移或重登记）。
 * 返回 { entries: Map<path, count>, legacyEntries: Set<path> }；标记缺失 → null。
 */
function parseBaseline(text) {
  const si = text.indexOf(START_MARKER);
  const ei = text.indexOf(END_MARKER);
  if (si < 0 || ei < 0 || ei <= si) return null;
  const entries = new Map();
  const legacyEntries = new Set();
  for (const raw of text.slice(si + START_MARKER.length, ei).split('\n')) {
    const line = raw.replace(/\r$/, '');
    const p = line.trim();
    if (!p || p.startsWith('#')) continue;
    const m = p.match(/^(\S+)\s+(\d+)$/);
    if (m) {
      entries.set(m[1].replace(/\\/g, '/'), Number(m[2]));
    } else {
      legacyEntries.add(p.replace(/\\/g, '/'));
    }
  }
  return { entries, legacyEntries };
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

if (CHECK_FORMAT) {
  if (!existsSync(baselinePath)) {
    console.error(`[check-crate-size] FAIL: 基线文件不存在：${baselinePath}`);
    process.exit(1);
  }
  const head = readFileSync(baselinePath, 'utf8');
  const si = head.indexOf(START_MARKER);
  const ei = head.indexOf(END_MARKER);
  if (si < 0 || ei <= si) {
    console.error('[check-crate-size] FAIL: 基线文件缺少 BASELINE_START/END 标记区');
    process.exit(1);
  }
  let total = 0;
  let bad = 0;
  for (const raw of head.slice(si + START_MARKER.length, ei).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    total++;
    if (!/^\S+\s+\d+$/.test(line.trim())) {
      bad++;
      console.error(`[check-crate-size] FAIL: 标记区格式错误（须为 \`path count\`）：${JSON.stringify(line)}`);
    }
  }
  if (bad > 0) {
    console.error(`[check-crate-size] FAIL: --check-format 未通过：${bad}/${total} 行不符合格式`);
    process.exit(1);
  }
  console.log(`[check-crate-size] --check-format 通过：条目数 = ${total}，全部含行数（格式 \`path count\`）`);
  process.exit(0);
}

if (UPDATE) {
  const lines = over.map((f) => `${f.path} ${f.lines}`);
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
    `[check-crate-size] --update 完成：标记区已登记 ${lines.length} 个超限文件（已带实测行数 \`path count\`，git diff 可复核）`
  );
  process.exit(0);
}

if (MIGRATE) {
  if (!existsSync(baselinePath)) {
    console.error(`[check-crate-size] FAIL: 基线文件不存在：${baselinePath}`);
    process.exit(1);
  }
  const head = readFileSync(baselinePath, 'utf8');
  const eol = head.includes('\r\n') ? '\r\n' : '\n';
  const si = head.indexOf(START_MARKER);
  const ei = head.indexOf(END_MARKER);
  if (si < 0 || ei <= si) {
    console.error('[check-crate-size] FAIL: 基线文件缺少 BASELINE_START/END 标记区');
    process.exit(1);
  }
  // 迁移遍历的是既有登记条目（含旧格式），绝不混入未登记超限文件（不触碰 over）
  const parsed = parseBaseline(head);
  const registered = new Set([...parsed.entries.keys(), ...parsed.legacyEntries]);
  const missing = [];
  const migrated = [];
  for (const p of registered) {
    const abs = resolve(root, p);
    if (!existsSync(abs)) {
      missing.push(p);
      continue;
    }
    migrated.push(`${p} ${countLines(abs)}`);
  }
  if (missing.length > 0) {
    console.error('[check-crate-size] FAIL: --migrate 中止——以下登记文件不存在（须人工处理后再迁移）：');
    for (const m of missing) console.error(`  ${m}`);
    process.exit(1);
  }
  migrated.sort();
  const newText =
    head.slice(0, si + START_MARKER.length) + eol + migrated.join(eol) + eol + head.slice(ei);
  writeFileSync(baselinePath, newText);
  console.log(
    `[check-crate-size] --migrate 完成：既有登记 ${migrated.length} 条已迁移为 \`path count\`（实测行数；未写入任何未登记超限文件，git diff 可复核）`
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
const toCleanup = [];
for (const c of crates) {
  for (const f of c.files) {
    const limit = f.kind === 'entry' ? LIB_LIMIT : MOD_LIMIT;
    const isOver = f.lines > limit;
    const rel = f.path.replace(/\\/g, '/');
    const regCount = baseline.entries.get(rel);
    if (isOver && regCount === undefined) {
      failed = true;
      console.error(
        `[check-crate-size] FAIL: ${f.path} 行数 ${f.lines} > ${limit}（${f.kind === 'entry' ? '入口' : 'mod'}）且未登记豁免`
      );
    } else if (isOver && f.lines > regCount) {
      failed = true;
      console.error(
        `[check-crate-size] FAIL: ${f.path} 已登记但回涨：登记值 ${regCount} → 实测 ${f.lines}（${f.kind === 'entry' ? '入口' : 'mod'}）；登记 = 限速豁免（冻结上限），增长即 FAIL`
      );
    }
    if (isOver) {
      console.log(
        `[check-crate-size]  超限（已登记${regCount !== undefined ? '✓' : '✗'}） ${f.path} = ${f.lines} 行（${f.kind === 'entry' ? '≤800' : '≤600'}）`
      );
    } else if (regCount !== undefined) {
      toCleanup.push(rel);
      console.log(
        `[check-crate-size]  提示（不 FAIL）：已回落至限额内可清理登记条目 ${f.path} = ${f.lines} 行（登记值 ${regCount}）`
      );
    }
  }
  console.log(
    `[check-crate-size] ${c.name.padEnd(20)} 文件 ${String(c.files.length).padStart(3)} 最大 ${String(Math.max(...c.files.map((f) => f.lines))).padStart(5)} 行 | 测试 ${String(c.test.lines).padStart(6)} 行 / ${String(c.test.cases).padStart(4)} 用例`
  );
}
console.log(`[check-crate-size] 超限文件数 = ${over.length}（基线登记 ${over.filter((f) => baseline.entries.has(f.path)).length}）`);
console.log(`[check-crate-size] 测试规模顺带计数（观察项）：全仓测试 ${totalTestLines} 行 / ${totalTestCases} 用例`);
if (toCleanup.length > 0) {
  console.log(`[check-crate-size] 提示：${toCleanup.length} 个登记条目已回落至限额内，可清理（不 FAIL）`);
}

if (failed) {
  console.error('处置：超限且未登记必须拆分，或在 `node scripts/check-crate-size.mjs --update` 显式登记（写入实测行数 + 维护注记理由与拆分时限）；已登记回涨同样 FAIL（拆分或收紧登记值）');
  process.exit(1);
}

console.log('[check-crate-size] OK — 超限文件全部在基线登记内且未回涨（lib.rs/main.rs ≤ 800，mod ≤ 600；登记 = 冻结上限）');
