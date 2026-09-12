#!/usr/bin/env node
/**
 * scripts/check-inline-style-hardcode.mjs
 * 门禁棘轮（T23 · docs/token-consumption-unification/tasks/B6-设置界面清零与密度档复活.md T24）
 *
 * 语义：扫描设置域 TSX 里的 `style={{ ... }}`，检出携带硬编码值的内联样式块：
 *   - 裸数值：`gap: 8` / `margin: -1`（数字字面量）
 *   - 裸 px 字符串：`'12px'` / `"12px"`
 *   - 裸颜色：`'#fff...'` / `'rgba(...)'` / `'hsl(...)'` / `'oklch(...)'`
 *
 * 豁免（不算硬编码）：
 *   - 动态插值：模板字符串（`${x}px`）、三元中的变量引用
 *   - 纯关键字值：`position: 'absolute'` / `display: 'flex'` 等无数值语义
 *   - `var(--token)` / `var(--token, fallback)` 引用（含兜底，因 token 本身是 SSOT）
 *
 * 口径：块级计数 —— 一个 `style={{...}}` 含 ≥1 处硬编码即计 1。
 *
 * 棘轮语义（与 check-token-fallback-drift.mjs 一致）：
 *   - 实测 > 基线 → FAIL；基线缺失/格式非法 → FAIL（禁止静默建线）；
 *   - `--update` 只允许收紧（当前 > 基线时拒绝写回）。
 *
 * Run: node scripts/check-inline-style-hardcode.mjs [--update] [--list] [--guide]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const SRC = resolve(root, 'apps/crish-desktop/src/components');

const START_MARKER = '<!-- BASELINE_START -->';
const END_MARKER = '<!-- BASELINE_END -->';
const BASELINE_PATH = resolve(
  root,
  'docs/token-consumption-unification/基线记录/inline-style-hardcode-baseline.md'
);

const UPDATE = process.argv.includes('--update');
const LIST = process.argv.includes('--list');

// ── 扫描范围：设置域 5 个目录 ──────────────────────────────────────────────
const DIRS = [
  'settings',
  'settings-extensions',
  'settings-mcp',
  'settings-models',
  'settings-skills',
];

function* walkTsx(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkTsx(p);
    else if (e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx')) yield p;
  }
}

// ── 检测 ───────────────────────────────────────────────────────────────────
// 从 tsx 文本中提取顶层 `style={{ ... }}` 块（配平花括号，支持跨行）
function extractStyleBlocks(text) {
  const blocks = [];
  const re = /style=\{\{/g;
  let m;
  while ((m = re.exec(text))) {
    const openEnd = m.index + m[0].length; // 注意：match 对象没有 .end，须自算
    let depth = 2;
    let i = openEnd;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      if (depth === 0) break;
      i++;
    }
    blocks.push({ start: m.index, end: i + 1, body: text.slice(openEnd, i) });
  }
  return blocks;
}

const RE_NUM = /:\s*(?![`'"])(-?\d+(?:\.\d+)?)\s*(?:,|$)/;
const RE_PX = /[`'"](-?\d+(?:\.\d+)?px)[`'"]/;
const RE_COLOR = /[`'"](#[0-9a-fA-F]{3,8}\b|rgba?\([^`'"]*\)|hsla?\([^`'"]*\)|oklch\([^`'"]*\))[`'"]/;
const RE_DYNAMIC = /\$\{/;
const RE_TOKEN = /var\(--[\w-]+/;

function hardcodesIn(body) {
  const found = [];
  // 模板字符串里内嵌的示例代码（如 schema 演示源码）不是本组件样式，跳过
  if (body.length > 600 || /\bimport\b/.test(body)) return found;
  if (RE_COLOR.test(body)) found.push('裸颜色');
  if (RE_PX.test(body) && !RE_DYNAMIC.test(body)) found.push('裸px字符串');
  // 裸数值：先剥掉字符串与模板串，再找 `: <number>`（块尾无逗号也命中）
  const stripped = body
    .replace(/`[^`]*`/g, '``')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/\s+/g, ' ');
  if (!RE_DYNAMIC.test(body) && RE_NUM.test(stripped)) found.push('裸数值');
  return found;
}

function run() {
  const hits = [];
  let files = 0;
  for (const d of DIRS) {
    const dir = resolve(SRC, d);
    if (!existsSync(dir)) continue;
    for (const f of walkTsx(dir)) {
      files++;
      const text = readFileSync(f, 'utf8');
      const rel = relative(SRC, f).split(sep).join('/');
      for (const b of extractStyleBlocks(text)) {
        const kinds = hardcodesIn(b.body);
        if (kinds.length) {
          const line = text.slice(0, b.start).split('\n').length;
          hits.push({ rel, line, kinds, snippet: b.body.replace(/\s+/g, ' ').slice(0, 90) });
        }
      }
    }
  }
  return { count: hits.length, hits, files };
}

// ── 基线读写 ───────────────────────────────────────────────────────────────
function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  const text = readFileSync(BASELINE_PATH, 'utf8');
  const si = text.indexOf(START_MARKER);
  const ei = text.indexOf(END_MARKER);
  if (si < 0 || ei < 0 || ei < si) return null;
  const body = text.slice(si + START_MARKER.length, ei);
  const out = {};
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('>')) continue;
    const parts = t.split(/\s+/);
    if (parts.length !== 2) return { __malformed: t };
    const n = Number(parts[1]);
    if (!Number.isInteger(n) || n < 0) return { __malformed: t };
    out[parts[0]] = n;
  }
  return out;
}

function writeBaseline(count) {
  const block = [START_MARKER, `inline_hardcode_blocks ${count}`, END_MARKER].join('\n');
  let text = existsSync(BASELINE_PATH) ? readFileSync(BASELINE_PATH, 'utf8') : '';
  if (!text) {
    text = [
      '# 内联样式硬编码门禁基线（T23/T24 · 设置域）',
      '',
      '> 由 `node scripts/check-inline-style-hardcode.mjs --update` 生成/刷新（仅允许收紧）。',
      '> 语义：实测 > 基线 → FAIL；实测 ≤ 基线 → 通过（存量按 T24 收敛）。',
      '',
    ].join('\n');
  }
  const si = text.indexOf(START_MARKER);
  const ei = text.indexOf(END_MARKER);
  if (si >= 0 && ei > si) {
    text = text.slice(0, si) + block + text.slice(ei + END_MARKER.length);
  } else {
    text = text.trimEnd() + '\n\n' + block + '\n';
  }
  writeFileSync(BASELINE_PATH, text, 'utf8');
}

function printGuide() {
  console.error('  正确做法：');
  console.error('  1. 把内联样式迁入组件同名 `.module.css` 并 token 化（`gap:8` → `gap: var(--space-2)`）；');
  console.error('  2. 视觉隐藏一律复用 `styles/sr-only.css` 的 `.sr-only` 全局类，禁止内联重写；');
  console.error('  3. 动态定位（如 `${placement.x}px`）属运行时计算，可保留并在值旁注释说明；');
  console.error('  4. 收敛后运行 `node scripts/check-inline-style-hardcode.mjs --update` 收紧基线。');
}

// ── CLI ───────────────────────────────────────────────────────────────────
const isDirectRun =
  process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')) ||
    fileURLToPath(import.meta.url) === resolve(process.argv[1]));

if (!isDirectRun) {
  // 作为模块 import 时不执行 CLI
} else {
  const { count, hits, files } = run();
  console.log('[check-inline-style-hardcode] 扫描根：设置域 5 目录');
  console.log(`[check-inline-style-hardcode] TSX 文件 ${files} 个`);
  console.log('[check-inline-style-hardcode] 指标：');
  console.log(`  ${'inline_hardcode_blocks'.padEnd(24)} ${count}`);

  if (LIST) {
    for (const h of hits) {
      console.log(`  ${h.rel}:${h.line}  [${h.kinds.join('/')}]  {${h.snippet}}`);
    }
    process.exit(0);
  }

  if (UPDATE) {
    const baseline = readBaseline();
    if (baseline && !baseline.__malformed && count > baseline.inline_hardcode_blocks) {
      console.error('[check-inline-style-hardcode] FAIL: --update 拒绝抬高基线（棘轮只降不升）：');
      console.error(`  - inline_hardcode_blocks: 当前 ${count} > 基线 ${baseline.inline_hardcode_blocks}`);
      process.exit(1);
    }
    writeBaseline(count);
    console.log(`\n[check-inline-style-hardcode] --update 已写回基线：${relative(root, BASELINE_PATH).split(sep).join('/')}`);
    process.exit(0);
  }

  const baseline = readBaseline();
  if (baseline === null) {
    console.error('[check-inline-style-hardcode] FAIL: 基线文件缺失或标记区不完整');
    console.error(`  当前实测值（供建线参考）：inline_hardcode_blocks = ${count}`);
    printGuide();
    process.exit(1);
  }
  if (baseline.__malformed) {
    console.error(`[check-inline-style-hardcode] FAIL: 基线标记区格式非法：${baseline.__malformed}`);
    process.exit(1);
  }
  if (count > baseline.inline_hardcode_blocks) {
    console.error('[check-inline-style-hardcode] FAIL: 内联硬编码超基线（棘轮只降不升）：');
    console.error(`  - inline_hardcode_blocks: 当前 ${count} > 基线 ${baseline.inline_hardcode_blocks}`);
    printGuide();
    process.exit(1);
  }
  console.log('[check-inline-style-hardcode] OK: 内联硬编码未超基线');
  process.exit(0);
}
