#!/usr/bin/env node
/**
 * scripts/check-layout-tokens.mjs
 * 布局 Token 门禁（BATCH-06 · docs/layout-token-system/00-总方案 §8）
 *
 * 语义（基线 ratchet，对齐 check-token-consistency 范式）：
 * 扫描 apps/crish-desktop/src 全部 CSS，核算三项指标：
 *   1. negative_margin_gt2 —— margin/padding 声明中负值绝对值 > 2px 的条目数
 *      （白名单 -1px / -2px：分割线贴合与极小修正，见总方案 §2.4）。
 *   2. bad_space_fallback  —— `var(--space-X, fallback)` 中 fallback 与
 *      tokens.css :root 默认值不等价的条目数（错误 fallback 清洗，§5.2）。
 *   3. density_matrix_viol —— small/large 密度档 --space-* 存在奇数或
 *      非严格单调的条目数（密度齿轮矩阵，§4）。
 *
 * 基线 ratchet：
 * - 实测 > 登记 → FAIL（新增即拦）；实测 ≤ 登记 → 通过（存量按分维文档收敛）；
 * - `--update`：把当前三项实测值写回标记区（提升基线必须显式、有意）；
 * - 首次运行（基线文件缺失）→ 自动写入初始基线并 exit 0（MVP 接入，避免全红门禁）；
 * - 基线格式：`docs/layout-token-system/基线记录/layout-token-baseline.md`
 *   标记区 `<metric> <count>`，与 check-token-consistency 同形。
 *
 * 解析复用：CSS 规则级解析直接 import check-input-guardrails.mjs 的
 * `extractCssRules`（穿透 @media/@supports/@container，剔除注释），
 * 禁止另写第三套行级正则引擎（§8.1）。
 *
 * Run: node scripts/check-layout-tokens.mjs [--update] [--list] [--baseline <file>]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 复用 input-guard 的块级解析器与仓库根路径（禁止另写行级正则解析器）
import { extractCssRules, REPO_ROOT, DESKTOP_SRC } from './check-input-guardrails.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const START_MARKER = '<!-- BASELINE_START -->';
const END_MARKER = '<!-- BASELINE_END -->';

const BASELINE_PATH_DEFAULT = resolve(
  REPO_ROOT,
  'docs/layout-token-system/基线记录/layout-token-baseline.md'
);

function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BASELINE_PATH = (() => {
  const v = argVal('--baseline');
  return v ? resolve(REPO_ROOT, v) : BASELINE_PATH_DEFAULT;
})();

const UPDATE = process.argv.includes('--update');
const LIST = process.argv.includes('--list');

if (UPDATE && LIST) {
  console.error('[check-layout-tokens] FAIL: 模式互斥，--update 与 --list 不能同时使用');
  process.exit(1);
}

// ── tokens.css 默认 --space-* 解析 ─────────────────────────────────────────
const TOKENS_CSS = resolve(DESKTOP_SRC, 'styles/tokens.css');

/**
 * 从 tokens.css 的 :root 块提取 `--space-*: <px>` 默认表。
 * 密度档（[data-ui-size='small'|'large']）单独提取。
 * 返回 Map<tokenName, pxNumber>。
 */
function parseSpaceTokens(cssText, selectorPattern) {
  const rules = extractCssRules(cssText);
  const map = new Map();
  for (const { selector, body } of rules) {
    if (!selectorPattern.test(selector)) continue;
    const re = /(--space-[\w-]+)\s*:\s*(-?[\d.]+)px\s*;/g;
    let m;
    while ((m = re.exec(body))) {
      map.set(m[1], parseFloat(m[2]));
    }
  }
  return map;
}

/** 密度档 token 顺序（用于单调性判定，与 §4 表一致） */
const SPACE_ORDER = [
  '--space-0',
  '--space-0_5',
  '--space-1',
  '--space-1_5',
  '--space-2',
  '--space-2_5',
  '--space-3',
  '--space-3_5',
  '--space-4',
  '--space-5',
  '--space-6',
  '--space-7',
  '--space-8',
  '--space-10',
];

// ── 扫描逻辑 ───────────────────────────────────────────────────────────────

function walkCss(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist') walkCss(p, out);
    } else if (e.isFile() && e.name.endsWith('.css')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * R1：margin/padding 负值绝对值 > 2px → 违规（白名单 -1px / -2px）。
 * 返回违规条目数组。
 */
function checkNegativeMargins(cssFiles) {
  const violations = [];
  // 匹配 margin / margin-top|bottom|left|right / padding 系列声明中的负 px 值
  const declRe =
    /(?:^|[{;\s])(margin(?:-(?:top|bottom|left|right))?|padding(?:-(?:top|bottom|left|right))?)\s*:\s*([^;]+);/gi;

  for (const file of cssFiles) {
    const content = readFileSync(file, 'utf-8');
    const relPath = relative(REPO_ROOT, file).split(sep).join('/');
    const rules = extractCssRules(content);
    for (const { selector, body } of rules) {
      let m;
      declRe.lastIndex = 0;
      while ((m = declRe.exec(body))) {
        const prop = m[1].toLowerCase();
        const value = m[2];
        // 提取该声明值中所有负 px 长度
        const negRe = /(-[\d.]+)px/g;
        let nm;
        while ((nm = negRe.exec(value))) {
          const px = Math.abs(parseFloat(nm[1]));
          if (px > 2) {
            violations.push({
              file: relPath,
              selector: selector.slice(0, 80),
              prop,
              value: nm[0],
            });
          }
        }
      }
    }
  }
  return violations;
}

/**
 * R2：var(--space-X, fallback) fallback 与 :root 默认表不等价 → 违规。
 * 只检查显式 fallback 的引用；无 fallback 的 var(--space-X) 天然正确。
 */
function checkSpaceFallbacks(cssFiles, defaultSpace) {
  const violations = [];
  const varRe = /var\(\s*(--space-[\w-]+)\s*,\s*([^)]+)\)/g;

  for (const file of cssFiles) {
    const content = readFileSync(file, 'utf-8');
    // 剔除注释，避免把文档示例误判为引用
    const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '');
    const relPath = relative(REPO_ROOT, file).split(sep).join('/');
    let m;
    while ((m = varRe.exec(stripped))) {
      const token = m[1];
      const fallbackRaw = m[2].trim();
      const defaultPx = defaultSpace.get(token);
      if (defaultPx === undefined) continue; // 未知 token 交给 token-consistency 门禁
      // 解析 fallback：期望为纯 px 字面量（如 8px）
      const fbMatch = fallbackRaw.match(/^(-?[\d.]+)px$/);
      if (!fbMatch) continue; // 非纯 px fallback（calc/var 嵌套）跳过，避免误判
      const fbPx = parseFloat(fbMatch[1]);
      if (Math.abs(fbPx - defaultPx) > 0.01) {
        violations.push({
          file: relPath,
          token,
          fallback: fallbackRaw,
          expected: `${defaultPx}px`,
        });
      }
    }
  }
  return violations;
}

/**
 * R3：small/large 密度档 --space-* 必须全偶数且严格单调。
 * 返回违规条目数组（奇数 / 非单调）。
 */
function checkDensityMatrix(tokensCssText) {
  const violations = [];
  const small = parseSpaceTokens(tokensCssText, /\[data-ui-size=['"]small['"]\]/);
  const large = parseSpaceTokens(tokensCssText, /\[data-ui-size=['"]large['"]\]/);

  for (const [label, map] of [
    ['small', small],
    ['large', large],
  ]) {
    // 偶数检查
    for (const [name, px] of map) {
      if (!Number.isInteger(px) || px % 2 !== 0) {
        violations.push({ density: label, token: name, kind: 'odd', value: px });
      }
    }
    // 单调性检查（按 SPACE_ORDER 中出现在该档的 token）
    let prev = -Infinity;
    let prevName = '';
    for (const name of SPACE_ORDER) {
      if (!map.has(name)) continue;
      const px = map.get(name);
      if (px <= prev) {
        violations.push({
          density: label,
          token: name,
          kind: 'non-monotonic',
          value: px,
          prev: `${prevName}=${prev}px`,
        });
      }
      prev = px;
      prevName = name;
    }
  }
  return violations;
}

// ── 基线读写 ───────────────────────────────────────────────────────────────

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  const text = readFileSync(BASELINE_PATH, 'utf-8');
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
    `negative_margin_gt2 ${m.negative_margin_gt2}`,
    `bad_space_fallback ${m.bad_space_fallback}`,
    `density_matrix_viol ${m.density_matrix_viol}`,
    END_MARKER,
  ].join('\n');
  let text = existsSync(BASELINE_PATH) ? readFileSync(BASELINE_PATH, 'utf-8') : '';
  if (!text) {
    text = [
      '# 布局 Token 门禁基线（BATCH-06）',
      '',
      '> 由 `node scripts/check-layout-tokens.mjs --update` 生成/刷新。',
      '> 语义：实测 > 基线 → FAIL；实测 ≤ 基线 → 通过（存量按分维文档收敛）。',
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
  writeFileSync(BASELINE_PATH, text, 'utf-8');
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

function run() {
  const cssFiles = walkCss(DESKTOP_SRC);
  const tokensCssText = existsSync(TOKENS_CSS) ? readFileSync(TOKENS_CSS, 'utf-8') : '';
  const defaultSpace = parseSpaceTokens(tokensCssText, /^:root\b/);

  const negMargins = checkNegativeMargins(cssFiles);
  const badFallbacks = checkSpaceFallbacks(cssFiles, defaultSpace);
  const densityViols = checkDensityMatrix(tokensCssText);

  const metrics = {
    negative_margin_gt2: negMargins.length,
    bad_space_fallback: badFallbacks.length,
    density_matrix_viol: densityViols.length,
  };

  return { metrics, negMargins, badFallbacks, densityViols, cssFileCount: cssFiles.length };
}

// ── CLI 入口 ───────────────────────────────────────────────────────────────

const isDirectRun =
  process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')) ||
    fileURLToPath(import.meta.url) === resolve(process.argv[1]));

if (!isDirectRun) {
  // 作为模块 import 时不执行 CLI
} else {
  const { metrics, negMargins, badFallbacks, densityViols, cssFileCount } = run();

  console.log(`[check-layout-tokens] 扫描 ${cssFileCount} 个 CSS 文件（${relative(REPO_ROOT, DESKTOP_SRC).split(sep).join('/')}）`);
  console.log('[check-layout-tokens] 指标：');
  for (const [k, now] of Object.entries(metrics)) {
    console.log(`  ${k.padEnd(22)} ${now}`);
  }

  if (LIST) {
    if (negMargins.length) {
      console.log(`\n=== R1 负 margin/padding >2px（${negMargins.length}）===`);
      for (const v of negMargins.slice(0, 40)) {
        console.log(`  ${v.file} (${v.selector}) ${v.prop}: ${v.value}`);
      }
      if (negMargins.length > 40) console.log(`  …共 ${negMargins.length} 处`);
    }
    if (badFallbacks.length) {
      console.log(`\n=== R2 错误 space fallback（${badFallbacks.length}）===`);
      for (const v of badFallbacks.slice(0, 40)) {
        console.log(`  ${v.file} var(${v.token}, ${v.fallback}) → 期望 ${v.expected}`);
      }
      if (badFallbacks.length > 40) console.log(`  …共 ${badFallbacks.length} 处`);
    }
    if (densityViols.length) {
      console.log(`\n=== R3 密度矩阵违规（${densityViols.length}）===`);
      for (const v of densityViols) {
        console.log(
          `  [${v.density}] ${v.token} ${v.kind}: ${v.value}${v.prev ? ` (prev ${v.prev})` : ''}`
        );
      }
    }
    process.exit(0);
  }

  if (UPDATE) {
    const before = readBaseline();
    writeBaseline(metrics);
    console.log(`\n[check-layout-tokens] --update 已写回基线：${relative(REPO_ROOT, BASELINE_PATH).split(sep).join('/')}`);
    if (before && !before.__malformed) {
      for (const k of Object.keys(metrics)) {
        const b = before[k];
        const now = metrics[k];
        const arrow =
          b === undefined
            ? '（新建）'
            : b === now
              ? '='
              : b > now
                ? `↓ ${b} → ${now}`
                : `↑ ${b} → ${now}`;
        console.log(`  ${k}: ${now}  ${arrow}`);
      }
    }
    process.exit(0);
  }

  const baseline = readBaseline();
  if (baseline === null) {
    // 首次运行：自动生成基线并 exit 0（MVP 接入，避免无基线全红门禁）
    writeBaseline(metrics);
    console.log(
      `\n[check-layout-tokens] 首次运行：已生成初始基线 ${relative(REPO_ROOT, BASELINE_PATH).split(sep).join('/')}`
    );
    console.log('[check-layout-tokens] 后续运行将 ratchet 比对；如需刷新基线请显式运行 --update。');
    process.exit(0);
  }
  if (baseline.__malformed) {
    console.error(
      `[check-layout-tokens] FAIL: 基线标记区格式非法（应 \`<metric> <count>\`）：${baseline.__malformed}`
    );
    process.exit(1);
  }

  const regressions = [];
  const improvements = [];
  for (const [k, now] of Object.entries(metrics)) {
    const base = baseline[k];
    if (base === undefined) {
      regressions.push(`${k}: 基线未登记（当前 ${now}）`);
    } else if (now > base) {
      regressions.push(`${k}: 当前 ${now} > 基线 ${base}（+${now - base}）`);
    } else if (now < base) {
      improvements.push(`${k}: 当前 ${now} < 基线 ${base}（可 --update 收敛基线）`);
    }
  }

  if (improvements.length) {
    console.log('\n[check-layout-tokens] 存量下降（可刷新基线）：');
    for (const i of improvements) console.log(`  - ${i}`);
  }

  if (regressions.length) {
    console.error('\n[check-layout-tokens] FAIL: 新增违规（未登记/超基线）：');
    for (const r of regressions) console.error(`  - ${r}`);
    console.error('\n处置：');
    console.error('  · 若为新增问题 → 修复 CSS，不得提升基线掩盖；');
    console.error('  · 若确属有意 → 显式运行 `node scripts/check-layout-tokens.mjs --update` 并说明理由。');
    console.error('  · 全量清单：`node scripts/check-layout-tokens.mjs --list`');
    process.exit(1);
  }

  console.log('\n[check-layout-tokens] OK: 三项指标均未超基线');
  process.exit(0);
}

export { run, parseSpaceTokens, SPACE_ORDER };
