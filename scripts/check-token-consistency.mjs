#!/usr/bin/env node
/**
 * 设计 Token 一致性门禁（G1/G2 · docs/design-token-ssot/00-总方案 §6.5）。
 *
 * 语义（基线 ratchet，对齐 crate-size / swallowed-errors 两线同形约定）：
 * 扫描前端源码，核算三项指标：
 *   1. undefined_refs  —— `var(--x)` 中被引用、但 CSS 定义集与 JS 运行时注入集
 *      都不含 `--x` 的条目数。此类引用在浏览器中整条声明变为
 *      invalid at computed-value time（属性退回 inherit/initial），**静默失效**。
 *   2. nofallback_refs —— 上者中「所有引用点都没有 `var(--x, fallback)` 兜底」的子集，
 *      属高危（无任何降级路径，且不报错）。
 *   3. dead_tokens     —— CSS 中定义了、但全仓无任何消费方的条目数。消费方口径：
 *      `var(--x)` 引用 / `readCssVar`·`getPropertyValue` 按名读取 / JS `setProperty` 写入
 *      （运行时注入，CSS 定义与 JS 写入呈双真源）/ **契约测试按名断言**
 *      （`.test.ts(x)` 内以引号包裹的 token 名字面量，仅计入本项，不参与 undefined_refs）。
 * - 三项均与 `基线记录/token-consistency-baseline.md` 标记区比对：
 *   实测 > 登记 → FAIL（新增即拦）；实测 ≤ 登记 → 通过（存量按方案分维文档顺序收敛）；
 * - `--update`：把当前三项实测值写回标记区（提升基线必须显式、有意）；
 * - `--list`：打印 nofallback_refs 与 dead_tokens 全量清单（含引用/定义点），供分维文档逐条处置；
 * - `--check-format`：校验标记区每行匹配 `^\S+\s+\d+$`（防手改坏格式）；
 *
 * 检测实现说明：
 * - 定义集 = CSS `--x:` 声明（任意选择器块内）+ JS 运行时注入
 *   （`setProperty('--x'`，以及对象键 `'--x':` 与计算键 `['--x' as string]:`）；
 * - 引用集 = 全部 `var(--x` 出现点（含 `.css` 与 `.ts/.tsx` 内的字符串模板）；
 * - **先剥离注释**（CSS/JS 块注释 + JS 整行/行尾 `//`，跳过 `https://` 分隔），
 *   避免把注释里的示例写法误判为引用（历史误报：useXtermTerminal 的文档示例
 *   `var(--x, fallback)`、两个 contract 测试的说明性注释）；
 * - fallback 判定 = 对每处 `var(` 做括号配平扫描，判断顶层实参内是否存在逗号，
 *   而非按行正则（避免多行声明与嵌套 `var()` 误判）；
 * - dead 判定另收两类"非 var() 形态"的消费方（只影响 dead_tokens，不影响
 *   undefined_refs —— 后者吃引用集会因否定断言凭空造误报）：
 *     a. **契约测试按名断言**：`.test.ts(x)` 内引号包裹的 token 字面量
 *        （`'--x'`）与正则字面量中的 token 名（`/--x:\s*[^;]+/`，见
 *        style-contract.test.ts:287）。二者被删时测试直接失败，属实消费。
 *     b. **JS `setProperty` 写入**：CSS 给未初始化默认、JS 按用户偏好覆盖，
 *        属有意的双源设计（`--bg-paper` / `--shell-inset-bg` /
 *        `--accent-*-light-adaptive`），只算定义不算消费会误判成死令牌。
 * - 外部注入白名单 `EXTERNALLY_INJECTED`（当前仅 Radix 浮层两项）不计入指标，
 *   但单独报数；新增条目须注明注入方，名单刻意保持最小。
 *
 * 不做的判定（明确划出，避免误解为已覆盖）：
 * - 不检查裸 hex/rgb/hsl/oklch 与颜色关键字（G3，见方案 §6.5 G3）；
 * - 不检查刻度合规（G5）、内联 style 硬编码（G4）、逃逸值（G6）。
 *
 * Run: node scripts/check-token-consistency.mjs [--update|--list|--check-format] [--scan <dir>] [--baseline <file>]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const START_MARKER = '<!-- BASELINE_START -->';
const END_MARKER = '<!-- BASELINE_END -->';

const BASELINE_PATH_DEFAULT = resolve(
  root,
  'docs/multi-agent-repair/基线记录/token-consistency-baseline.md'
);

/** `--baseline <file>` 覆盖基线文件路径（自测/集成用，对齐 check-crate-size 约定） */
const BASELINE_PATH = (() => {
  const v = argVal('--baseline');
  return v ? resolve(root, v) : BASELINE_PATH_DEFAULT;
})();

const UPDATE = process.argv.includes('--update');
const LIST = process.argv.includes('--list');
const CHECK_FORMAT = process.argv.includes('--check-format');

const modes = [
  ['--update', UPDATE],
  ['--list', LIST],
  ['--check-format', CHECK_FORMAT],
].filter(([, on]) => on);
if (modes.length > 1) {
  console.error(
    `[check-token-consistency] FAIL: 模式互斥，只能选一：${modes.map(([n]) => n).join(' / ')}`
  );
  process.exit(1);
}

function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 默认扫描根：桌面端 + avatar-studio（其余包未接入 token 体系，见方案 §2.3） */
const defaultScans = () => [
  resolve(root, 'apps/crish-desktop/src'),
  resolve(root, 'apps/avatar-studio/src'),
];

const scans = (() => {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--scan' && process.argv[i + 1]) out.push(resolve(root, process.argv[i + 1]));
  }
  return out.length ? out : defaultScans();
})();

const SKIP_DIR = new RegExp(
  [/(^|[\\/])node_modules([\\/]|$)/.source, /(^|[\\/])dist([\\/]|$)/.source, /(^|[\\/])\.git([\\/]|$)/.source].join('|')
);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (SKIP_DIR.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (statSync(p).isFile()) out.push(p);
  }
  return out;
}

const CSS_RE = /\.css$/i;
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

const rel = (p) => relative(root, p).split(sep).join('/');

/** 定义集：CSS `--x:` */
const cssDefs = new Map(); // name -> 'file:line'
/** 定义集：JS 运行时注入 */
const jsDefs = new Map(); // name -> 'file:line'
/** 引用集：name -> Array<{ at, hasFallback }> */
const refs = new Map();
/** 契约引用集（仅测试按名断言）：name -> Array<at>。只参与 dead_tokens 判定 */
const contractRefs = new Map();

/**
 * 外部注入白名单：由第三方库在**元素级 style** 上注入、本仓无法也不应定义的变量。
 * 新增条目必须在注释里写明「注入方」出处，否则视为掩盖问题（见方案 §3 R5 对
 * 「白名单过大」的批评）——本名单刻意保持最小。
 */
const EXTERNALLY_INJECTED = new Set([
  // Radix UI 浮层：在目标元素上写 style 属性提供定位/可用高度，不入本仓 CSS
  '--radix-popover-content-available-height',
  '--radix-popover-content-transform-origin',
]);

/**
 * 去除注释，避免把注释里的示例写法误判为真实引用
 * （真实误报来源：useXtermTerminal.ts 的 `var(--x, fallback)` 文档示例、
 *  motion-concentric-contract.test.ts 与 style-contract.test.ts 的说明性注释）。
 * 行号靠等长替换保留：块注释内容整体替换为等长空白（保留换行）。
 */
function stripComments(text, isCss) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  if (!isCss) {
    out = out
      .split('\n')
      .map((line) => {
        const i = line.indexOf('//');
        if (i < 0) return line;
        if (i > 0 && line[i - 1] === ':') return line; // `https://` 等协议分隔，非注释
        return line.slice(0, i);
      })
      .join('\n');
  }
  return out;
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

/** 从 `var(` 的 '(' 位置开始配平扫描，返回 { hasFallback } */
function scanVarArgs(text, openParenIdx) {
  let depth = 0;
  let topLevelComma = false;
  for (let i = openParenIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) break;
    } else if (ch === ',' && depth === 1) topLevelComma = true;
  }
  return { hasFallback: topLevelComma };
}

function scanFile(file) {
  const isCss = CSS_RE.test(file);
  const raw = readFileSync(file, 'utf8');
  const text = stripComments(raw, isCss);
  const at = rel(file);

  if (isCss) {
    const reDef = /(--[a-zA-Z0-9_-]+)\s*:/g;
    let m;
    while ((m = reDef.exec(text))) {
      if (!cssDefs.has(m[1])) cssDefs.set(m[1], `${at}:${lineOf(text, m.index)}`);
    }
  } else if (CODE_RE.test(file)) {
    const reSet = /(?:setProperty|setCustomProperty)\(\s*[`'"](--[a-zA-Z0-9_-]+)/g;
    let m;
    while ((m = reSet.exec(text))) {
      if (!jsDefs.has(m[1])) jsDefs.set(m[1], `${at}:${lineOf(text, m.index)}`);
    }
    // 对象键：`'--x':` 字面键 与 `['--x' as string]:` 计算键（ToastCard.tsx:103-110 形态）
    const reKey =
      /(?:[`'"](--[a-zA-Z0-9_-]+)[`'"]|[`'"](--[a-zA-Z0-9_-]+)[`'"]\s*as\s+[A-Za-z]+)\s*\]?\s*:/g;
    while ((m = reKey.exec(text))) {
      const name = m[1] ?? m[2];
      if (name && !jsDefs.has(name)) jsDefs.set(name, `${at}:${lineOf(text, m.index)}`);
    }
    // 运行时属性赋值：`tokens['--x'] =` 与 `style['--x'] =`（TokenRuntimeController 形态）
    const reAssign = /\[\s*[`'"](--[a-zA-Z0-9_-]+)[`'"]\s*\]\s*=/g;
    while ((m = reAssign.exec(text))) {
      if (!jsDefs.has(m[1])) jsDefs.set(m[1], `${at}:${lineOf(text, m.index)}`);
    }
  }

  // 引用（css 与代码都算）
  if (CSS_RE.test(file) || CODE_RE.test(file)) {
    const reRef = /var\(\s*(--[a-zA-Z0-9_-]+)/g;
    let m;
    while ((m = reRef.exec(text))) {
      const openParen = text.indexOf('(', m.index);
      const { hasFallback } = scanVarArgs(text, openParen);
      if (!refs.has(m[1])) refs.set(m[1], []);
      refs.get(m[1]).push({ at: `${at}:${lineOf(text, m.index)}`, hasFallback });
    }
    // 按名字读取同样构成消费关系：`readCssVar('--x')` / `getPropertyValue('--x')`。
    // 漏掉这类会让门禁把真实消费方判成死 token（历史误报：useXtermTerminal.ts 的
    // 17 个 --xterm-*，实为 xterm 主题按名读取）。二者均带兜底语义（缺失只返回空串/
    // 默认值，不会令 CSS 声明失效），故记 hasFallback=true，不计入高危。
    if (!isCss) {
      const reRead = /(?:readCssVar|getPropertyValue)\(\s*[`'"](--[a-zA-Z0-9_-]+)/g;
      while ((m = reRead.exec(text))) {
        if (!refs.has(m[1])) refs.set(m[1], []);
        refs.get(m[1]).push({ at: `${at}:${lineOf(text, m.index)}`, hasFallback: true });
      }
    }

    // 契约测试按名断言同样构成消费关系（仅计入 dead_tokens 判定，不参与
    // undefined_refs —— 测试常用 `expect(x).not.toContain('--foo')` 做否定断言，
    // 把未定义名当"不该出现"的样本；若计入引用集会凭空造出 undefined_refs 误报）。
    // 典型真实消费：a11y-contrast 的 parseBlock 建表后按名比对对比度、
    // antiDarkeningGuard 断言 --breakpoint-* 定义位置、style-contract 断言
    // --tint-scrollbar-track 透明。缺失时测试直接失败（不静默），故不计高危。
    // 两种形态都收：引号包裹的字面量 `'--x'`，以及正则字面量 /--x:\s*[^;]+/
    // （后者见 style-contract.test.ts:287，token 名不带引号，漏判会误杀有契约的 token）。
    if (CODE_RE.test(file) && /\.test\.(ts|tsx)$/.test(file)) {
      for (const re of [/[`'"](--[a-zA-Z0-9_-]+)[`'"]/g, /\/(?:[^/\n\\]|\\.)*?(--[a-zA-Z0-9_-]+)/g]) {
        let cm;
        while ((cm = re.exec(text))) {
          if (!contractRefs.has(cm[1])) contractRefs.set(cm[1], []);
          contractRefs.get(cm[1]).push(`${at}:${lineOf(text, cm.index)}`);
        }
      }
    }
  }
}

const files = scans.flatMap((d) => walk(d));
for (const f of files) scanFile(f);

const defined = new Set([...cssDefs.keys(), ...jsDefs.keys()]);

const undefinedRefs = [];
const noFallbackRefs = [];
const externalRefs = [];
for (const [name, sites] of refs) {
  if (defined.has(name)) continue;
  if (EXTERNALLY_INJECTED.has(name)) {
    // 第三方库元素级注入：不计入门禁指标，但单独报数，避免"静默豁免"
    externalRefs.push(name);
    continue;
  }
  undefinedRefs.push(name);
  if (sites.every((s) => !s.hasFallback)) noFallbackRefs.push(name);
}

// dead 判定须与 undefined_refs 的 `defined` 口径对称：`setProperty('--x')` 既是运行时
// 定义、也是对 CSS 静态默认值的消费（CSS 给未初始化默认、JS 按用户偏好覆盖，属有意的
// 双源设计，典型：--bg-paper / --shell-inset-bg / --accent-*-light-adaptive）。
// 只把它算作"定义"而不算"消费"，会让这类 token 被误判成死令牌。
const deadTokens = [...cssDefs.keys()].filter(
  (n) => !refs.has(n) && !contractRefs.has(n) && !jsDefs.has(n)
);

undefinedRefs.sort();
noFallbackRefs.sort();
deadTokens.sort();
externalRefs.sort();

const metrics = {
  undefined_refs: undefinedRefs.length,
  nofallback_refs: noFallbackRefs.length,
  dead_tokens: deadTokens.length,
};

// ── 标记区读写 ────────────────────────────────────────────────────────────
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
    `undefined_refs ${m.undefined_refs}`,
    `nofallback_refs ${m.nofallback_refs}`,
    `dead_tokens ${m.dead_tokens}`,
    END_MARKER,
  ].join('\n');
  let text = existsSync(BASELINE_PATH) ? readFileSync(BASELINE_PATH, 'utf8') : '';
  if (!text) text = '# token 一致性门禁基线\n\n';
  const si = text.indexOf(START_MARKER);
  const ei = text.indexOf(END_MARKER);
  if (si >= 0 && ei > si) {
    text = text.slice(0, si) + block + text.slice(ei + END_MARKER.length);
  } else {
    text = text.trimEnd() + '\n\n' + block + '\n';
  }
  writeFileSync(BASELINE_PATH, text, 'utf8');
}

// ── 执行 ──────────────────────────────────────────────────────────────────
console.log('[check-token-consistency] 扫描根：');
for (const s of scans) console.log(`  - ${rel(s)}（${existsSync(s) ? '存在' : '缺失'}）`);
console.log(`[check-token-consistency] 文件 ${files.length} 个` +
  `（css ${files.filter((f) => CSS_RE.test(f)).length} / 代码 ${files.filter((f) => CODE_RE.test(f)).length}）`);
console.log(
  `[check-token-consistency] css 定义 ${cssDefs.size} · js 运行时注入 ${jsDefs.size} · 引用点去重名 ${refs.size}`
);
console.log(
  `[check-token-consistency] 外部注入白名单命中 ${externalRefs.length} 项` +
    (externalRefs.length ? `：${externalRefs.join(', ')}` : '')
);

if (CHECK_FORMAT) {
  const b = readBaseline();
  if (b === null) {
    console.error('[check-token-consistency] FAIL: 基线文件缺失或标记区不完整');
    process.exit(1);
  }
  if (b.__malformed) {
    console.error(`[check-token-consistency] FAIL: 标记区格式非法（应 \`<metric> <count>\`）：${b.__malformed}`);
    process.exit(1);
  }
  console.log('[check-token-consistency] OK: 标记区格式合法');
  process.exit(0);
}

if (LIST) {
  console.log(`\n=== nofallback_refs 全量清单（${noFallbackRefs.length}）===`);
  for (const name of noFallbackRefs) {
    const sites = refs.get(name) ?? [];
    console.log(`  ${name}`);
    for (const s of sites.slice(0, 4)) console.log(`      ${s.at}`);
    if (sites.length > 4) console.log(`      …共 ${sites.length} 处`);
  }
  console.log(`\n=== undefined_refs 中含 fallback 的（${undefinedRefs.length - noFallbackRefs.length}）===`);
  for (const name of undefinedRefs) {
    if (noFallbackRefs.includes(name)) continue;
    console.log(`  ${name}  @${refs.get(name)?.[0]?.at}`);
  }
  console.log(`\n=== dead_tokens 全量清单（${deadTokens.length}）===`);
  for (const name of deadTokens) {
    const jsWrite = jsDefs.get(name);
    console.log(`  ${name}  @${cssDefs.get(name)}`);
    if (jsWrite) console.log(`      JS 运行时写入: ${jsWrite}`);
  }
  process.exit(0);
}

if (UPDATE) {
  if (metrics.undefined_refs > 0 || metrics.nofallback_refs > 0 || metrics.dead_tokens > 0) {
    console.error('[check-token-consistency] FAIL: 设计令牌基线永久锁死为 0 / 0 / 0，严禁通过 --update 提升基线掩盖未定义或死 token！');
    console.error('  当前实测值：');
    console.error(`    undefined_refs:  ${metrics.undefined_refs}`);
    console.error(`    nofallback_refs: ${metrics.nofallback_refs}`);
    console.error(`    dead_tokens:     ${metrics.dead_tokens}`);
    console.error('  请修复引用、补充定义或物理删除无用定义，使三项全部归零后方可通过门禁。');
    process.exit(1);
  }
  const before = readBaseline();
  writeBaseline(metrics);
  console.log(`\n[check-token-consistency] --update 已写回基线：${BASELINE_PATH.replace(root + sep, '')}`);
  process.exit(0);
}

const baseline = readBaseline();
if (baseline === null) {
  console.error('[check-token-consistency] FAIL: 基线文件缺失或标记区不完整');
  console.error(`  期望：${BASELINE_PATH.replace(root + sep, '')}（含 ${START_MARKER} / ${END_MARKER}）`);
  console.error('  处置：基线必须为 0 / 0 / 0，请检查基线文件');
  process.exit(1);
}
if (baseline.__malformed) {
  console.error(`[check-token-consistency] FAIL: 标记区格式非法（应 \`<metric> <count>\`）：${baseline.__malformed}`);
  process.exit(1);
}
for (const [k, v] of Object.entries(baseline)) {
  if (v !== 0) {
    console.error(`[check-token-consistency] FAIL: 基线违规篡改，${k} 登记为 ${v}，铁律要求必须恒为 0！`);
    process.exit(1);
  }
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

console.log('\n[check-token-consistency] 指标：');
for (const [k, now] of Object.entries(metrics)) {
  const base = baseline[k];
  console.log(`  ${k.padEnd(18)} 当前 ${String(now).padStart(4)}  基线 ${base === undefined ? '—' : String(base).padStart(4)}`);
}

if (regressions.length) {
  console.error('\n[check-token-consistency] FAIL: 拦截到设计 Token 一致性违规（门禁要求 0 / 0 / 0）：');
  for (const r of regressions) console.error(`  - ${r}`);

  if (noFallbackRefs.length) {
    console.error('\n[高危] 无兜底未定义 Token 引用清单 (nofallback_refs)：');
    for (const name of noFallbackRefs) {
      const sites = refs.get(name) ?? [];
      console.error(`  ${name}`);
      for (const s of sites) console.error(`    at ${s.at}`);
    }
  }

  if (undefinedRefs.length - noFallbackRefs.length > 0) {
    console.error('\n[警告] 含兜底但未定义 Token 引用清单 (undefined_refs)：');
    for (const name of undefinedRefs) {
      if (noFallbackRefs.includes(name)) continue;
      const sites = refs.get(name) ?? [];
      console.error(`  ${name}`);
      for (const s of sites) console.error(`    at ${s.at}`);
    }
  }

  if (deadTokens.length) {
    console.error('\n[死码] 无消费方 Token 清单 (dead_tokens)：');
    for (const name of deadTokens) {
      console.error(`  ${name}  at ${cssDefs.get(name)}`);
    }
  }

  console.error('\n==================== 明确修复指引 ====================');
  console.error('1. 未定义引用修复 (undefined_refs / nofallback_refs)：');
  console.error('   - 若该 Token 属于全局设计体系：请在 apps/crish-desktop/src/styles/tokens.css 的 :root 或对应主题块中补充定义；');
  console.error('   - 若属于已有 Token 的拼写笔误：请校对并纠正为规范名称（如 tokens.css 中的既有 --space-*、--text-* 等）；');
  console.error('   - 若属于运行时由 JS 动态注入的属性：请确保使用 setProperty / setCustomProperty 写入，并为 CSS var() 加上安全兜底：var(--token, fallback)；');
  console.error('2. 死 Token 修复 (dead_tokens)：');
  console.error('   - 若属于重构残留或废弃变量：必须从定义文件（tokens.css）中物理删除该声明（DELETE-SYMBOL），禁止留空壳；');
  console.error('   - 若属于新功能待接入：请在组件 CSS 中接入消费，或在契约测试 (*.test.ts) 中增加按名断言。');
  console.error('3. 铁律：基线永久保持 0 / 0 / 0，任何新增违规一律阻断退出码 1，严禁提升基线！');
  console.error('======================================================');
  process.exit(1);
}

if (improvements.length) {
  console.log('\n[check-token-consistency] 存量下降（可刷新基线）：');
  for (const i of improvements) console.log(`  - ${i}`);
}

console.log('\n[check-token-consistency] OK: 三项指标均未超基线');
