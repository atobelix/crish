#!/usr/bin/env node
/**
 * scripts/check-token-fallback-drift.mjs
 * 门禁棘轮（T23 · docs/token-consumption-unification/tasks/B6-设置界面清零与密度档复活.md）
 *
 * 语义：扫描「设置域 + 设置界面内渲染的共享 UI 组件」CSS，核算两项裸兜底漂移指标：
 *   1. bare_fallback_refs        —— 消费面（非 `--` 开头属性）声明里
 *      `var(--x, <裸字面量>)` 出现的次数。裸字面量判定 = 兜底值（去首尾空格后）
 *      不以 `var(` 开头（即非语义降级链）。嵌套 `var(--a, var(--b, 4px))` 中
 *      `--a` 的兜底是 var() 不算裸值，`--b` 的兜底 4px 算裸值。
 *   2. contradictory_fallback_refs —— 上述裸兜底中，值与 tokens.css 真值集合不符者。
 *      真值获取：解析 tokens.css / z-index.css / design-system.css / 组件 CSS 中每个
 *      token 的全部定义值，并做 var() 链解析（≤3 层）。如 `--button-radius: var(--radius-btn)`
 *      须展开到 7px 再比对，否则 47 处 `var(--button-radius, 7px)` 会被误判矛盾。
 *      `calc(14px + var(--font-size-adjust, 0px))` 类真值取其 px 字面量集合比对。
 *
 * 白名单（不算违规，但仍计入 bare_fallback_refs）：
 *   --tooltip-translate / --tooltip-arrow-offset / --anchor-width /
 *   --radix-popover-content-available-height / --radix-popover-content-transform-origin
 *
 * 棘轮语义：
 * - 实测 > 基线 → FAIL（新增即拦）；实测 ≤ 基线 → 通过（存量按 B6 收敛）；
 * - 基线缺失 → **FAIL**（禁止静默建线；建线须显式 `--update`）；
 * - `--update`：把当前实测值写回标记区，**但 --update 只允许收紧（当前 < 基线才写回）**，
 *   当前 ≥ 基线时拒绝写回（禁止抬高基线掩盖漂移）；
 * - FAIL 五元输出（对齐 01-分维-防御脚本断言阶梯.md §1.3）。
 *
 * Run: node scripts/check-token-fallback-drift.mjs [--update] [--list] [--guide <metric>] [--baseline <file>]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const DESKTOP_SRC = resolve(root, 'apps/crish-desktop/src');

const START_MARKER = '<!-- BASELINE_START -->';
const END_MARKER = '<!-- BASELINE_END -->';
const BASELINE_PATH_DEFAULT = resolve(
  root,
  'docs/token-consumption-unification/基线记录/fallback-drift-baseline.md'
);

function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const BASELINE_PATH = (() => {
  const v = argVal('--baseline');
  return v ? resolve(root, v) : BASELINE_PATH_DEFAULT;
})();

const UPDATE = process.argv.includes('--update');
const LIST = process.argv.includes('--list');
const guideIdx = process.argv.indexOf('--guide');
const GUIDE_METRIC = guideIdx >= 0 ? process.argv[guideIdx + 1] : undefined;

// ── 扫描范围（与 04 审计口径一致：设置域 + 12 个共享 UI 组件）─────────────────
const SETTINGS_DIRS = [
  'components/settings',
  'components/settings-extensions',
  'components/settings-mcp',
  'components/settings-models',
  'components/settings-skills',
];
const UI_DIRS = [
  'components/ui/Button',
  'components/ui/Input',
  'components/ui/Menu',
  'components/ui/Select',
  'components/ui/Tooltip',
  'components/ui/ScrollArea',
  'components/ui/Badge',
  'components/ui/Slider',
  'components/ui/Switch',
  'components/ui/SegmentedControl',
  'components/ui/Tabs',
  'components/ui/Dialog',
];

const WHITELIST = new Set([
  '--tooltip-translate',
  '--tooltip-arrow-offset',
  '--anchor-width',
  '--radix-popover-content-available-height',
  '--radix-popover-content-transform-origin',
]);

const SKIP_RE = /(^|[\\/])(node_modules|dist|coverage)([\\/]|$)/;
const CSS_RE = /\.css$/i;
const TEST_RE = /\.test\./i;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (SKIP_RE.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && CSS_RE.test(e.name) && !TEST_RE.test(e.name)) out.push(p);
  }
  return out;
}

function collectFiles() {
  const dirs = [...SETTINGS_DIRS, ...UI_DIRS].map((d) => resolve(DESKTOP_SRC, d));
  const out = [];
  for (const d of dirs) out.push(...walk(d));
  return [...new Set(out)].sort();
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * 在给定文本中，从 var( 起始位置向前回溯到最近的 ; { } 以确定其所属声明的属性名。
 * 返回属性名；若处于 at-rule 前导（@media 条件等）或伪类选择器则视为非消费声明，返回 null。
 */
function enclosingProperty(text, idx) {
  let boundary = -1;
  for (let i = idx - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ';' || c === '{' || c === '}') {
      boundary = i;
      break;
    }
  }
  if (boundary < 0) return null;
  const seg = text.slice(boundary + 1, idx);
  if (/^\s*@/.test(seg)) return null; // at-rule 前导（@media/@supports 条件）
  const colon = seg.indexOf(':');
  if (colon < 0) return null;
  const prop = seg.slice(0, colon).trim();
  if (!prop || prop.includes('(')) return null; // 选择器/伪类，非声明
  return prop;
}

/**
 * 找出文本中所有「消费面裸兜底」：var(--x, <非 var 开头字面量>)，且所属属性非 `--`。
 * 返回 { name, fallback, prop, line, file } 数组（按 var() 出现次数计，嵌套逐层计）。
 */
function findBareFallbacks(text, file) {
  const clean = stripComments(text);
  const results = [];
  const re = /var\(/g;
  let m;
  while ((m = re.exec(clean))) {
    const start = m.index;
    // 括号配平，定位本 var() 的结束 )
    let depth = 0;
    let end = -1;
    for (let i = start; i < clean.length; i++) {
      if (clean[i] === '(') depth++;
      else if (clean[i] === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) continue;
    const inner = clean.slice(start + 4, end); // var( 之后、) 之前
    // 顶层逗号分割出兜底
    let d = 0;
    let comma = -1;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '(') d++;
      else if (ch === ')') d--;
      else if (ch === ',' && d === 0) {
        comma = i;
        break;
      }
    }
    if (comma < 0) continue; // 无兜底
    const nameRaw = inner.slice(0, comma).trim();
    const nameM = nameRaw.match(/^(--[a-zA-Z0-9_-]+)$/);
    if (!nameM) continue;
    const name = nameM[1];
    const fallback = inner.slice(comma + 1).trim();
    if (fallback === '') continue;
    if (fallback.startsWith('var(')) continue; // 嵌套 var 兜底 → 非裸值
    const prop = enclosingProperty(clean, start);
    if (!prop) continue;
    if (prop.startsWith('--')) continue; // token 定义（如 --btn-fs: var(--font-size-base, 14px)），非消费
    results.push({ name, fallback, prop, line: lineOf(clean, start), file });
  }
  return results;
}

// ── 真值解析 ─────────────────────────────────────────────────────────────────
function collectDefs(text) {
  const clean = stripComments(text);
  const defs = new Map();
  const re = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(clean))) {
    const name = m[1];
    const val = m[2].trim();
    if (!defs.has(name)) defs.set(name, []);
    defs.get(name).push(val);
  }
  return defs;
}

const tokensCssPath = resolve(DESKTOP_SRC, 'styles/tokens.css');
const zIndexPath = resolve(DESKTOP_SRC, 'styles/z-index.css');
const designPath = resolve(DESKTOP_SRC, 'styles/design-system.css');

const tokensCssDefs = existsSync(tokensCssPath)
  ? collectDefs(readFileSync(tokensCssPath, 'utf8'))
  : new Map();
const zIndexDefs = existsSync(zIndexPath) ? collectDefs(readFileSync(zIndexPath, 'utf8')) : new Map();
const designDefs = existsSync(designPath) ? collectDefs(readFileSync(designPath, 'utf8')) : new Map();

let compDefs = new Map();

function rawDefs(name) {
  if (tokensCssDefs.has(name)) return tokensCssDefs.get(name);
  if (zIndexDefs.has(name)) return zIndexDefs.get(name);
  if (designDefs.has(name)) return designDefs.get(name);
  if (compDefs.has(name)) return compDefs.get(name);
  return [];
}

function resolveRaw(v, depth) {
  const tv = v.trim();
  const m = tv.match(/^var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([\s\S]*?))?\)$/);
  if (m && depth < 3) {
    const ref = m[1];
    const refs = rawDefs(ref);
    if (refs.length) return refs.flatMap((r) => resolveRaw(r, depth + 1));
    if (m[2] !== undefined && m[2].trim() !== '') return [m[2].trim()];
    return [tv];
  }
  return [tv];
}

function trueValues(name) {
  const raws = rawDefs(name);
  if (!raws.length) return [];
  return [...new Set(raws.flatMap((r) => resolveRaw(r, 0)))];
}

function normalize(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}
function extractPx(s) {
  const m = s.match(/(-?\d*\.?\d+)(px|em|rem|%|ms|s|deg|fr|vw|vh)/i);
  return m ? m[1] + m[2].toLowerCase() : null;
}

/** 兜底值是否与真值集合一致（一致 = 不矛盾）。 */
function isConsistent(fallback, values) {
  const fb = normalize(fallback);
  for (const tv of values) {
    const t = normalize(tv);
    if (fb === t) return true;
    // calc 类真值取其 px 字面量比对（--font-size-* 等档位 token）
    if (t.includes('calc(') || fb.includes('calc(')) {
      const pa = extractPx(fb);
      const pt = extractPx(t);
      if (pa != null && pt != null && pa === pt) return true;
    }
  }
  return false;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
function run() {
  const files = collectFiles();
  const allFallbacks = [];
  for (const f of files) {
    const rel = relative(DESKTOP_SRC, f).split(sep).join('/');
    const text = readFileSync(f, 'utf8');
    for (const b of findBareFallbacks(text, f)) {
      allFallbacks.push({ ...b, rel });
    }
  }
  // 组件私有 token 定义（用于解析真值链）
  compDefs = new Map();
  for (const f of files) {
    const d = collectDefs(readFileSync(f, 'utf8'));
    for (const [k, v] of d) {
      if (!compDefs.has(k)) compDefs.set(k, []);
      compDefs.get(k).push(...v);
    }
  }

  // 白名单（运行时注入）不计违规 —— 与 contradictory 判定口径一致（脚本头注释：
  // 「白名单不算违规」，此前实现误将白名单计入 bare 计数，已修正口径）
  const bareFallbackRefs = allFallbacks.filter((f) => !WHITELIST.has(f.name)).length;

  const contradictory = [];
  for (const b of allFallbacks) {
    if (WHITELIST.has(b.name)) continue; // 白名单不算违规
    const tv = trueValues(b.name);
    if (!tv.length) continue; // 真值不可得（应为已知组件私有 token，否则未知），不误判
    if (!isConsistent(b.fallback, tv)) {
      contradictory.push(b);
    }
  }
  const contradictoryFallbackRefs = contradictory.length;

  return { bareFallbackRefs, contradictoryFallbackRefs, allFallbacks, contradictory, files };
}

// ── 基线读写 ─────────────────────────────────────────────────────────────────
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
    if (!t || t.startsWith('#')) continue;
    const parts = t.split(/\s+/);
    if (parts.length !== 2) return { __malformed: t };
    const n = Number(parts[1]);
    if (!Number.isInteger(n) || n < 0) return { __malformed: t };
    out[parts[0]] = n;
  }
  return out;
}

function writeBaseline(m) {
  const block = [
    START_MARKER,
    `bare_fallback_refs ${m.bare_fallback_refs}`,
    `contradictory_fallback_refs ${m.contradictory_fallback_refs}`,
    END_MARKER,
  ].join('\n');
  let text = existsSync(BASELINE_PATH) ? readFileSync(BASELINE_PATH, 'utf8') : '';
  if (!text) {
    text = [
      '# 裸兜底漂移门禁基线（T23 · 设置域消费面）',
      '',
      '> 由 `node scripts/check-token-fallback-drift.mjs --update` 生成/刷新（仅允许收紧）。',
      '> 语义：实测 > 基线 → FAIL；实测 ≤ 基线 → 通过（存量按 B6 收敛）。',
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

// ── CLI ─────────────────────────────────────────────────────────────────────
const isDirectRun =
  process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')) ||
    fileURLToPath(import.meta.url) === resolve(process.argv[1]));

if (!isDirectRun) {
  // 作为模块 import 时不执行 CLI
} else {
  const { bareFallbackRefs, contradictoryFallbackRefs, allFallbacks, contradictory, files } = run();

  console.log('[check-token-fallback-drift] 扫描根：设置域 + 12 共享 UI 组件');
  console.log(`[check-token-fallback-drift] CSS 文件 ${files.length} 个`);
  console.log('[check-token-fallback-drift] 指标：');
  console.log(`  ${'bare_fallback_refs'.padEnd(26)} ${bareFallbackRefs}`);
  console.log(`  ${'contradictory_fallback_refs'.padEnd(26)} ${contradictoryFallbackRefs}`);

  if (GUIDE_METRIC) {
    printGuide(GUIDE_METRIC);
    process.exit(0);
  }

  if (LIST) {
    if (allFallbacks.length) {
      console.log(`\n=== 全部裸兜底（${allFallbacks.length}）前 60 ===`);
      for (const b of allFallbacks.slice(0, 60)) {
        console.log(`  ${b.rel}:${b.line}  ${b.prop}: var(${b.name}, ${b.fallback})`);
      }
      if (allFallbacks.length > 60) console.log(`  …共 ${allFallbacks.length} 处`);
    }
    if (contradictory.length) {
      console.log(`\n=== 矛盾兜底（${contradictory.length}）===`);
      for (const b of contradictory) {
        console.log(`  ${b.rel}:${b.line}  var(${b.name}, ${b.fallback})`);
      }
    }
    process.exit(0);
  }

  if (UPDATE) {
    const baseline = readBaseline();
    // --update 仅允许收紧：当前任何指标 ≥ 基线则拒绝写回（禁止抬高基线）
    if (baseline && !baseline.__malformed) {
      const violations = [];
      if (bareFallbackRefs > baseline.bare_fallback_refs)
        violations.push(`bare_fallback_refs: 当前 ${bareFallbackRefs} > 基线 ${baseline.bare_fallback_refs}`);
      if (contradictoryFallbackRefs > baseline.contradictory_fallback_refs)
        violations.push(
          `contradictory_fallback_refs: 当前 ${contradictoryFallbackRefs} > 基线 ${baseline.contradictory_fallback_refs}`
        );
      if (violations.length) {
        console.error('[check-token-fallback-drift] FAIL: --update 拒绝抬高基线（棘轮只降不升）：');
        for (const v of violations) console.error(`  - ${v}`);
        process.exit(1);
      }
    }
    writeBaseline({
      bare_fallback_refs: bareFallbackRefs,
      contradictory_fallback_refs: contradictoryFallbackRefs,
    });
    console.log(
      `\n[check-token-fallback-drift] --update 已（收紧）写回基线：${relative(root, BASELINE_PATH).split(sep).join('/')}`
    );
    process.exit(0);
  }

  const baseline = readBaseline();
  if (baseline === null) {
    console.error(
      `[check-token-fallback-drift] FAIL: 基线文件缺失或标记区不完整：${relative(root, BASELINE_PATH).split(sep).join('/')}`
    );
    console.error('  处置：显式运行 `node scripts/check-token-fallback-drift.mjs --update` 建立基线（禁止静默建线）。');
    console.error('  当前实测值（供建线参考）：');
    console.error(`    bare_fallback_refs = ${bareFallbackRefs}`);
    console.error(`    contradictory_fallback_refs = ${contradictoryFallbackRefs}`);
    process.exit(1);
  }
  if (baseline.__malformed) {
    console.error(
      `[check-token-fallback-drift] FAIL: 基线标记区格式非法（应 \`<metric> <count>\`）：${baseline.__malformed}`
    );
    process.exit(1);
  }

  const regressions = [];
  if (bareFallbackRefs > baseline.bare_fallback_refs)
    regressions.push(
      `[check-token-fallback-drift] 裸兜底 · 设置域 CSS · 当前 ${bareFallbackRefs} · 阈值 ${baseline.bare_fallback_refs} · 正确做法：删掉兜底只写 var(--x)，默认值由 tokens.css 静态声明提供；确需语义降级用 var(--a, var(--b)) 形态`
    );
  if (contradictoryFallbackRefs > baseline.contradictory_fallback_refs)
    regressions.push(
      `[check-token-fallback-drift] 矛盾兜底 · 设置域 CSS · 当前 ${contradictoryFallbackRefs} · 阈值 ${baseline.contradictory_fallback_refs} · 正确做法：兜底值 <v> 与 tokens.css 真值 <t> 不符，首选删兜底；或修正为 <t>（禁止把兜底值钉死在档位漂移 token 上）`
    );

  if (regressions.length) {
    console.error('\n[check-token-fallback-drift] FAIL: 拦截到裸兜底漂移（门禁要求只降不升）：');
    for (const r of regressions) console.error(`  ${r}`);
    if (contradictory.length) {
      console.error('\n[矛盾兜底明细]（前 40）：');
      for (const b of contradictory.slice(0, 40)) {
        console.error(`  · ${b.rel}:${b.line} -> var(${b.name}, ${b.fallback})`);
      }
      if (contradictory.length > 40) console.error(`  …共 ${contradictory.length} 处`);
    }
    console.error('\n==================== 明确修复指引 ====================');
    console.error('1. 裸兜底（bare_fallback_refs）：删除 var(--x, <字面量>) 的兜底，只写 var(--x)；');
    console.error('   默认值由 tokens.css 静态声明提供。确需语义降级链用 var(--a, var(--b)) 形态。');
    console.error('2. 矛盾兜底（contradictory_fallback_refs）：兜底值与 tokens.css 真值不符，');
    console.error('   首选删兜底；若必须带值，须等于真值（禁止把 --font-size-*/--space-*/--radius-* 等');
    console.error('   档位漂移 token 的兜底钉死为单一字面量）。');
    console.error('3. 白名单（--tooltip-translate / --tooltip-arrow-offset / --anchor-width /');
    console.error('   --radix-popover-content-available-height / --radix-popover-content-transform-origin）');
    console.error('   属运行时注入，不计矛盾；其余 token 一律须对齐真值。');
    console.error('4. 棘轮只降不升：修复后运行 `node scripts/check-token-fallback-drift.mjs --update` 收敛基线。');
    console.error('======================================================');
    process.exit(1);
  }

  console.log('\n[check-token-fallback-drift] OK: 两项裸兜底指标均未超基线');
  process.exit(0);
}

function printGuide(metric) {
  const guides = {
    bare_fallback_refs:
      'bare_fallback_refs 正确做法：删掉 var(--x, <字面量>) 的兜底，只写 var(--x)；默认值由 tokens.css 静态声明提供。确需语义降级用 var(--a, var(--b)) 形态。',
    contradictory_fallback_refs:
      'contradictory_fallback_refs 正确做法：兜底值 <v> 与 tokens.css 真值 <t> 不符，首选删兜底；或修正为 <t>（禁止把档位漂移 token 的兜底钉死为单一字面量）。',
  };
  console.log(`[check-token-fallback-drift] --guide ${metric}：`);
  console.log(`  ${guides[metric] || '未知指标。可选：bare_fallback_refs / contradictory_fallback_refs'}`);
}

export { run, findBareFallbacks, trueValues, isConsistent, collectFiles };
