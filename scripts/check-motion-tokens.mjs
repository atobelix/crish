#!/usr/bin/env node
/**
 * scripts/check-motion-tokens.mjs
 *
 * 动效 token 口径门禁（批 A · Cherry 深比 06-2/6 防回潮门）
 *
 * 背景：动效时长/曲线的正典出生地是 apps/crish-desktop/src/styles/
 * tokens-base.css 的 --duration-* / --transition-* 令牌。历史上消费面
 * 出现两类系统性漂移（2026-11-03 核查 ㉞ 实测）：
 *   1. fallback 漂移：`var(--transition-fast, 120ms)` 一类兜底值与令牌
 *      真值（150ms）不符——令牌恒在时零视觉影响，但兜底一旦生效即走
 *      错口径，且错误值曾成多数派（66 处 vs 正确 23 处）；
 *   2. 裸字面量逃逸：组件 CSS / TSX 内联样式在 transition/animation
 *      声明里直写时长字面量（如 md-mermaid-loading 1.2s、
 *      ApprovalAskCard 内联 0.1s/0.3s），绕开令牌单源。
 *
 * 规则（扫描 apps/crish-desktop/src 全部 .css/.ts/.tsx，跳过测试文件）：
 *   R1 fallback 一致性：凡 `var(--<motion 令牌>, <兜底>)` 且兜底不以
 *      var( 开头（非降级链）且含时间字面量者，其首个时间字面量（单位
 *      归一后）必须等于该令牌在 tokens-base.css :root 中的正典时长
 *      （var 链展开 ≤4 层）。兜底中的缓动词（ease 等）是降级近似，
 *      不在本规则比对面内——本规则只钉时长。
 *   R2 裸字面量清零：transition / transition-duration / transition-delay /
 *      animation / animation-duration / animation-delay 声明中，剥除
 *      var(...) 后仍残留的时间字面量（0ms/0s 除外，归零语义无法漂移）
 *      即违规。自定义属性定义（--x: …）不是消费声明，不匹配本规则。
 *
 * 豁免面：
 *   - 基础设施文件：styles/tokens-base.css（令牌定义本体）、
 *     styles/reduced-motion.css（全局减动效归零表）整文件豁免 R2；
 *   - 基线文件 scripts/check-motion-tokens-baseline.json：逐条登记
 *     {file, rule, match, reason}。登记条目必须真实命中一处违规，
 *     失效条目（零命中）同样判 FAIL——基线只许随收敛收缩，不许沉淀。
 *
 * 不在扫描面：JS 数值时长（motion/react 的 transition 对象、
 * setTimeout 等）是另一表面（秒制、无 CSS 令牌对应），不在本门范围；
 * keyframes 本体不带时长，不扫；颜色/尺寸等非动效令牌的兜底归
 * check-token-fallback-drift.mjs（设置域）管辖，本门只管动效令牌。
 *
 * Run: node scripts/check-motion-tokens.mjs [--list]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const DESKTOP_SRC = resolve(root, 'apps/crish-desktop/src');
const TOKENS_BASE = resolve(DESKTOP_SRC, 'styles/tokens-base.css');
const BASELINE_PATH = resolve(__dirname, 'check-motion-tokens-baseline.json');
const LIST = process.argv.includes('--list');

const EXEMPT_FILES = new Set([
  'apps/crish-desktop/src/styles/tokens-base.css',
  'apps/crish-desktop/src/styles/reduced-motion.css',
]);

const SKIP_RE = /(^|[\\/])(node_modules|dist|coverage)([\\/]|$)/;
const SRC_RE = /\.(css|ts|tsx)$/i;
const TEST_RE = /\.(test|spec)\.[tj]sx?$/i;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (SKIP_RE.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && SRC_RE.test(e.name) && !TEST_RE.test(e.name))
      out.push(p);
  }
  return out;
}

const rel = (p) => relative(root, p).split(sep).join('/');
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

/** 注释剥除（以空格填充保行号）：CSS/TS 的块注释 + TS 行注释（字符串外） */
function stripComments(text, isTs) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, ' ')
  );
  if (!isTs) return out;
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let quote = null;
    for (let j = 0; j < line.length - 1; j++) {
      const ch = line[j];
      if (quote) {
        if (ch === '\\') j++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '/' && line[j + 1] === '/') {
        lines[i] = line.slice(0, j);
        break;
      }
    }
  }
  return lines.join('\n');
}

const TIME_RE = /(\d+(?:\.\d+)?)(ms|s)\b/;
function firstTimeMs(text) {
  const m = TIME_RE.exec(text);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return m[2] === 's' ? Math.round(v * 1000) : v;
}

/** 解析 tokens-base.css 首个 :root 块的 --duration-* / --transition-* 正典时长 */
function loadCanonicalDurations() {
  const raw = readFileSync(TOKENS_BASE, 'utf8');
  // 只取减动效 @media 归零段之前的定义（归零段是同一批令牌的 0ms 覆盖）
  const cut = raw.indexOf('@media (prefers-reduced-motion');
  const head = cut >= 0 ? raw.slice(0, cut) : raw;
  const text = stripComments(head, false);
  const defs = new Map();
  const defRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = defRe.exec(text)) !== null) {
    if (/^--(duration|transition)-/.test(m[1])) defs.set(m[1], m[2].trim());
  }
  // var 链展开为值文本后再取首个时间字面量（缓动类令牌展开后是
  // bezier/linear 数字串，无时间字面量，不干扰时长提取）
  const expand = (name, depth) => {
    const rawVal = defs.get(name);
    if (rawVal == null) return null;
    if (depth >= 4) return rawVal;
    return rawVal.replace(/var\(\s*(--[\w-]+)\s*\)/g, (whole, inner) => {
      const innerExpanded = expand(inner, depth + 1);
      return innerExpanded == null ? whole : innerExpanded;
    });
  };
  const canonical = new Map();
  for (const name of defs.keys()) {
    const expanded = expand(name, 0);
    const ms = expanded == null ? null : firstTimeMs(expanded);
    if (ms != null) canonical.set(name, ms);
  }
  return canonical;
}

const VAR_RE = /var\(\s*(--[\w-]+)\s*,\s*((?:[^()]|\([^()]*\))*)\)/g;
const DECL_RE =
  /(?<![\w-])(transition|transition-duration|transition-delay|animation|animation-duration|animation-delay)\s*:\s*([^;}{]+)/gi;
const BARE_TIME_RE = /\d+(?:\.\d+)?(?:ms|s)\b/g;

function scanFile(file, canonical) {
  const raw = readFileSync(file, 'utf8');
  const isTs = /\.(ts|tsx)$/i.test(file);
  const text = stripComments(raw, isTs);
  const relPath = rel(file);
  const violations = [];

  // R1：fallback 一致性
  let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(text)) !== null) {
    const token = m[1];
    if (!canonical.has(token)) continue;
    const fallback = m[2].trim();
    if (fallback.startsWith('var(')) continue; // 降级链不管
    const fbMs = firstTimeMs(fallback);
    if (fbMs == null) continue;
    const canon = canonical.get(token);
    if (fbMs !== canon) {
      violations.push({
        file: relPath,
        line: lineOf(text, m.index),
        rule: 'fallback',
        detail: `${token} 兜底 ${fbMs}ms ≠ 正典 ${canon}ms`,
        lineText: (raw.split('\n')[lineOf(text, m.index) - 1] || '').trim(),
      });
    }
  }

  // R2：裸字面量（基础设施文件豁免）
  if (!EXEMPT_FILES.has(relPath)) {
    DECL_RE.lastIndex = 0;
    while ((m = DECL_RE.exec(text)) !== null) {
      let value = m[2];
      // 剥除 var(...)（含一层嵌套），余下文本里的时间字面量即裸写
      let prev;
      do {
        prev = value;
        value = value.replace(/var\((?:[^()]|\([^()]*\))*\)/g, ' ');
      } while (value !== prev);
      const times = value.match(BARE_TIME_RE) || [];
      for (const t of times) {
        if (t === '0ms' || t === '0s' || t === '0.0s') continue;
        violations.push({
          file: relPath,
          line: lineOf(text, m.index),
          rule: 'literal',
          detail: `${m[1]} 声明含裸时长 ${t}（须经 var(--duration-*/--transition-*) 令牌）`,
          lineText: (raw.split('\n')[lineOf(text, m.index) - 1] || '').trim(),
        });
      }
    }
  }
  return violations;
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    return Array.isArray(parsed.exemptions) ? parsed.exemptions : [];
  } catch {
    return [];
  }
}

const canonical = loadCanonicalDurations();
const files = walk(DESKTOP_SRC).sort();
const all = [];
for (const f of files) all.push(...scanFile(f, canonical));

const baseline = loadBaseline();
const usedBaseline = new Set();
const live = [];
for (const v of all) {
  const idx = baseline.findIndex(
    (b) => b.file === v.file && b.rule === v.rule && v.lineText.includes(b.match)
  );
  if (idx >= 0) {
    usedBaseline.add(idx);
    if (LIST) console.log(`[baseline] ${v.file}:${v.line} ${v.detail}`);
  } else {
    live.push(v);
  }
}
const stale = baseline.filter((_, i) => !usedBaseline.has(i));

if (LIST) {
  for (const v of live) console.log(`${v.file}:${v.line} [${v.rule}] ${v.detail}`);
}

if (live.length > 0 || stale.length > 0) {
  if (live.length > 0) {
    console.error(`\n[check-motion-tokens] FAIL: ${live.length} 处动效口径漂移：`);
    for (const v of live) console.error(`  ${v.file}:${v.line} [${v.rule}] ${v.detail}`);
    console.error(
      '\n正确做法：时长/曲线一律消费 tokens-base.css 的 --duration-*/--transition-* 令牌；' +
        'var() 兜底的首个时长必须与令牌正典值相等。确属独立配方的，在 ' +
        'scripts/check-motion-tokens-baseline.json 登记并注明出处。'
    );
  }
  if (stale.length > 0) {
    console.error(`\n[check-motion-tokens] FAIL: ${stale.length} 条基线登记已失效（零命中），须删除：`);
    for (const s of stale) console.error(`  ${s.file} [${s.rule}] match="${s.match}"`);
  }
  process.exit(1);
}

console.log(
  `[check-motion-tokens] PASS（扫描 ${files.length} 个文件，正典令牌 ${canonical.size} 个，` +
    `基线登记 ${baseline.length} 条，0 处漂移）`
);
