#!/usr/bin/env node
/**
 * scripts/check-token-ssot.mjs
 * 真源唯一化门禁（Token 消费面统一战役 · T1）
 *
 * 规格来源：docs/token-consumption-unification/01-分维-防御脚本断言阶梯.md §二 L2
 * 任务书：  docs/token-consumption-unification/tasks/B1-冻结与清零.md §T1
 *
 * 语义（基线 ratchet，对齐 check-layout-tokens.mjs 范式）：
 *   硬失败（目标恒为 0）：
 *     multi_file_defs     同一 token 名在 >=2 个不同 CSS 文件被定义（授权白名单除外）
 *     js_inject_a_class   JS/TSX 写入的 token 名 ∩ A 类设计 Token（登记 B 类与外部注入除外）
 *     b_class_no_default  登记表声明了 staticDefault 的 B 类 token，在 tokens.css 找不到静态声明
 *     b_class_drift       实际检测到的 JS 写入集合 ↔ 登记表 B 类的双向差集
 *     namespace_overlap   同名 token 同时出现在 bClass 与 componentIslands（双重角色）
 *   棘轮（只降不升）：
 *     whitelist_size      白名单条目总数
 *
 * 数据真源：
 *   - A 类 = apps/crish-desktop/src/styles/tokens.css + （授权外置）z-index.css 中的全部声明
 *   - 登记表 = scripts/token-registry.json（B 类 / 组件孤岛 / 外部注入 / 授权第二定义源）
 *
 * 输出契约（强制，见 01 分维 §1.3）：每条 FAIL 必须给出
 *   「违反项 · 文件:行号 · 当前值 · 阈值 · 正确做法」五元组；禁止只报 `FAIL: X = N > baseline`。
 *
 * Run: node scripts/check-token-ssot.mjs [--list] [--guide <metric>] [--update] [--baseline <file>]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';

// 复用仓库唯一 CSS 解析器（禁止另写第三套行级正则解析器）
import { extractCssRules, REPO_ROOT, DESKTOP_SRC } from './check-input-guardrails.mjs';

const START_MARKER = '<!-- BASELINE_START -->';
const END_MARKER = '<!-- BASELINE_END -->';

const BASELINE_PATH_DEFAULT = resolve(
  REPO_ROOT,
  'docs/token-consumption-unification/基线记录/token-ssot-baseline.md'
);
const REGISTRY_PATH = resolve(REPO_ROOT, 'scripts/token-registry.json');

const A_CLASS_SOURCES = ['apps/crish-desktop/src/styles/tokens.css'];
const AUTHORIZED_EXTRA_SOURCES = ['apps/crish-desktop/src/styles/z-index.css'];
function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BASELINE_PATH = (() => {
  const v = argVal('--baseline');
  return v ? resolve(REPO_ROOT, v) : BASELINE_PATH_DEFAULT;
})();
const LIST = process.argv.includes('--list');
const UPDATE = process.argv.includes('--update');
const GUIDE = argVal('--guide');

if (UPDATE && (LIST || GUIDE)) {
  console.error('[check-token-ssot] FAIL: --update 与 --list/--guide 互斥');
  process.exit(1);
}

// ── 遍历 ───────────────────────────────────────────────────────────────────
function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist' && e.name !== 'coverage') walk(p, exts, out);
    } else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) {
      out.push(p);
    }
  }
  return out;
}

const rel = (p) => relative(REPO_ROOT, p).replace(/\\/g, '/');
const isProd = (p) => !/\.test\.|\.spec\.|test-setup|__mocks__|\.d\.ts$/.test(p);

// ── 登记表 ─────────────────────────────────────────────────────────────────
function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) {
    return { aClass: {}, bClass: [], componentIslands: [], externallyInjected: [], authorizedExtraSources: AUTHORIZED_EXTRA_SOURCES };
  }
  const j = JSON.parse(
    // BOM 防御（2026-09-12 实测踩坑）：PowerShell 5.1 的 `-Encoding utf8` 会写出带 BOM 的
    // 数据文件，JSON.parse 直接拒绝。剥除后继续，但向 stderr 发出可见告警（不容忍静默）。
    (() => {
      const t = readFileSync(REGISTRY_PATH, 'utf8');
      if (t.charCodeAt(0) === 0xfeff) {
        console.error('[check-token-ssot] WARNING: token-registry.json 带 UTF-8 BOM，已自动剥除；请以无 BOM 形式重写该文件。');
        return t.slice(1);
      }
      return t;
    })()
  );
  return {
    aClass: j.aClass || {},
    bClass: j.bClass || [],
    componentIslands: j.componentIslands || [],
    externallyInjected: j.externallyInjected || [],
    authorizedExtraSources: j.authorizedExtraSources || AUTHORIZED_EXTRA_SOURCES,
    themingApis: j.themingApis || [],
    sizeTiers: j.sizeTiers || [],
    variantScopes: j.variantScopes || [],
  };
}

// ── 1. 收集全部 CSS 定义点（带 file:line） ─────────────────────────────────
function collectCssDefs() {
  const files = walk(DESKTOP_SRC, ['.css']);
  /** @type {Map<string, {file:string, line:number, value:string}[]>} */
  const defs = new Map();
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const rules = extractCssRules(text);
    for (const { selector, body } of rules) {
      const re = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+)/g;
      let m;
      while ((m = re.exec(body))) {
        const name = m[1];
        // 计算行号：在原文中查找该声明的首次出现位置
        const idx = text.indexOf(`${name}:`);
        const line = idx === -1 ? 0 : text.slice(0, idx).split('\n').length;
        if (!defs.has(name)) defs.set(name, []);
        defs.get(name).push({ file: rel(f), line, value: m[2].trim(), selector });
      }
    }
  }
  return defs;
}

// ── 2. 收集 JS/TSX 注入点 ──────────────────────────────────────────────────
// 必须覆盖全部形态，否则门禁是瞎的：
//   setProperty('--x')
//   style={{ '--x': v }}                 /  { "--x": v }
//   style={{ ['--x']: v }}               /  { ['--x']: v }
//   style={{ '--x' as string]: v }}      /  与 `'--x' as string` 变体
const INJECT_PATTERNS = [
  /setProperty\(\s*['"`](--[A-Za-z0-9_-]+)['"`]/g,
  // 2026-09-12 修正：负向 lookbehind 排除三元表达式（`cond ? '--a' : '--b'` 是读取键选择，
  // 不是写点——pretextFontBridge.ts 曾被误报为 --font-sans 写者）。
  /(?<![?:]\s*)['"`](--[A-Za-z0-9_-]+)['"`](?:\s+as\s+[A-Za-z_$][\w$]*)?\s*\]?\s*:/g,
  // 对象键形态要求尾随冒号（`obj['--x']` 的方括号读取不再是写点误报）。
  /\[\s*['"`](--[A-Za-z0-9_-]+)['"`]\s*\]\s*:/g,
];

function collectJsInjections() {
  const files = walk(DESKTOP_SRC, ['.ts', '.tsx']).filter(isProd);
  /** @type {Map<string, {file:string, line:number}[]>} */
  const out = new Map();
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const re of INJECT_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const name = m[1];
        const line = text.slice(0, m.index).split('\n').length;
        if (!out.has(name)) out.set(name, []);
        const hit = { file: rel(f), line };
        if (!out.get(name).some((x) => x.file === hit.file && x.line === hit.line)) out.get(name).push(hit);
      }
    }
  }
  return out;
}

// ── 3. 指标核算 ────────────────────────────────────────────────────────────
const cssDefs = collectCssDefs();
const jsInject = collectJsInjections();
const registry = loadRegistry();

const authorized = new Set(registry.authorizedExtraSources);

// A 类 = tokens.css（+ 授权外置源）中定义的全部 token 名
const aClassNames = new Set();
for (const [name, sites] of cssDefs) {
  if (sites.some((s) => A_CLASS_SOURCES.includes(s.file) || authorized.has(s.file))) aClassNames.add(name);
}

const bClassNames = new Set(registry.bClass.map((b) => b.name));
const externalNames = new Set(registry.externallyInjected);
const islandPrefixes = registry.componentIslands.map((c) => c.prefix);

// 指标 1：multi_file_defs（同一 token 在 >=2 个不同文件被定义；授权外置源豁免其承载的命名空间）
// 文档化模式分类（2026-09-12）：以下三类「多文件同名定义」是**已登记的合法架构**，
// 从硬失败指标中分离为 `documented_api_defs`（@ratchet，只许登记后收敛、不许新增未登记项）：
//   ① themingApis —— 组件的 custom-prop 主题化 API（各容器按场景覆写，值有意不同）
//   ② sizeTiers   —— 尺寸分级系统（tokens.css 持全局默认，组件持分级值）
//   ③ variantScopes —— 变体作用域（[data-md-variant] 等高特异性上下文排版，非竞争真源）
const themingApiFamilies = (registry.themingApis || []).map((a) => a.family);
const sizeTierNames = new Set((registry.sizeTiers || []).map((s) => s.name));
const variantScopeFiles = new Set((registry.variantScopes || []).map((v) => v.ownerFile));
const isDocumentedApi = (name, files) =>
  themingApiFamilies.some((f) => (f.endsWith('*') ? name.startsWith(f.slice(0, -1)) : name === f)) ||
  sizeTierNames.has(name) ||
  (registry.variantScopes || []).some((v) =>
    files.some((f) => f.endsWith(v.ownerFile)) && name.startsWith(v.tokenPrefix || '--')
  );

const multiFileDefs = [];
const documentedApiDefs = [];
for (const [name, sites] of cssDefs) {
  const files = [...new Set(sites.map((s) => s.file))];
  if (files.length < 2) continue;
  // 授权例外：--z-* 真源在 z-index.css；降动覆盖在 reduced-motion.css
  if (name.startsWith('--z-') && files.every((f) => f.endsWith('z-index.css') || A_CLASS_SOURCES.includes(f))) continue;
  const others = files.filter((f) => !f.endsWith('reduced-motion.css'));
  if (name.startsWith('--transition-') || name.startsWith('--duration-')) {
    if (others.length < 2) continue;
  }
  if (isDocumentedApi(name, files)) {
    documentedApiDefs.push({ name, files, sites });
    continue;
  }
  multiFileDefs.push({ name, files, sites });
}

// 指标 2：js_inject_a_class
const aClassViolations = [];
for (const [name, sites] of jsInject) {
  if (!aClassNames.has(name)) continue; // 非 A 类（纯运行期量）不算违规
  if (bClassNames.has(name)) continue; // 已登记为 B 类
  if (externalNames.has(name)) continue;
  aClassViolations.push({ name, sites });
}

// 指标 3：b_class_no_default
const bNoDefault = [];
for (const b of registry.bClass) {
  if (!b.staticDefault) continue;
  const sites = cssDefs.get(b.name) || [];
  const inTokens = sites.some((s) => A_CLASS_SOURCES.includes(s.file));
  if (!inTokens) bNoDefault.push({ name: b.name, declared: b.staticDefault });
}

// 指标 4：b_class_drift（双向差集）
const detectedInjectNames = new Set([...jsInject.keys()]);
const bDriftUnregistered = [...detectedInjectNames].filter(
  (n) => !bClassNames.has(n) && !externalNames.has(n) && !aClassNames.has(n)
);
const bDriftPhantom = [...bClassNames].filter((n) => !detectedInjectNames.has(n));

// 指标 5：a_class_multi_writer（同一 A 类 token 被 >=2 个不同 JS 文件写入）
// 这是 P2「两个 JS 写者争用同一 token」的探测器；争用必然带来顺序耦合与不可预测的最终值。
const multiWriter = [];
for (const [name, sites] of jsInject) {
  if (!aClassNames.has(name)) continue;
  const files = [...new Set(sites.map((s) => s.file))];
  if (files.length >= 2) multiWriter.push({ name, files, sites });
}

// 指标 6：namespace_overlap（同名双重角色）
const namespaceOverlap = [...bClassNames].filter((n) => islandPrefixes.some((p) => n.startsWith(p)));

// 指标 6：whitelist_size（棘轮）
const whitelistSize = authorized.size + externalNames.size + islandPrefixes.length;

const metrics = {
  multi_file_defs: multiFileDefs.length,
  documented_api_defs: documentedApiDefs.length,
  js_inject_a_class: aClassViolations.length,
  a_class_multi_writer: multiWriter.length,
  b_class_no_default: bNoDefault.length,
  b_class_drift: bDriftUnregistered.length + bDriftPhantom.length,
  namespace_overlap: namespaceOverlap.length,
  whitelist_size: whitelistSize,
};

// ── 4. 正确做法指引 ────────────────────────────────────────────────────────
const GUIDE_TEXT = {
  multi_file_defs: [
    '一个 token 名只能有一个定义文件（授权白名单：z-index.css 的 --z-*、reduced-motion.css 的降动覆盖）。',
    '你要给组件定制？改名为带前缀的私有 token（例：--badge-fg），并在 scripts/token-registry.json 的 componentIslands 登记。',
    '当第二个文件需要同一语义时 → 必须「晋升」为全局 A 类 token，禁止复制定义。',
    '参考：docs/token-consumption-unification/02-分维-真源唯一化与多轨物理清退.md §四。',
  ],
  js_inject_a_class: [
    'A 类设计 Token 只允许 tokens.css 声明，JS 不得写入（内联样式优先级高于选择器，会遮蔽静态真源）。',
    '正确做法：把该 token 改为 CSS 内派生，JS 只写「参数」。',
    '  --bg-card: color-mix(in srgb, var(--surface-card) calc(var(--user-brightness) * 1%), transparent);',
    '  并删除对应的 setProperty 调用。',
    '若该 token 实为「运行期量」（拖拽/测量驱动）→ 在 scripts/token-registry.json 登记为 B 类并补 tokens.css 静态默认值。',
    '参考：02-分维 §二/§三。',
  ],
  a_class_multi_writer: [
    '同一个 A 类 token 被 >=2 个 JS 文件写入 → 必然顺序耦合，最终值不可预测。',
    '正确做法：收敛为单一写者。若它本就是运行期量 → 登记 B 类并指定唯一 writer；',
    '若它是设计 Token → 删除 JS 写入，改为 CSS 内派生（见 js_inject_a_class 的指引）。',
    '本战役已实例：--text-primary 曾被 themePersonalization 与 oklchColorGuard 双写（已通过纯函数委托收敛）；--font-sans 仍被 fontStore 与 pretextFontBridge 双写。',
  ],
  b_class_no_default: [
    'B 类运行期量必须在 tokens.css 声明静态默认值（例：--sidebar-width: 260px;）。',
    '消费点写裸 var(--sidebar-width)，不得写兜底 —— 默认值由静态声明提供。',
  ],
  b_class_drift: [
    '未登记的 JS 写入：在 token-registry.json 的 bClass 登记 name/writer/consumer/staticDefault，并在 tokens.css 补静态默认。',
    '登记了但无人写：说明是幽灵条目 → 删除该登记项（或补上真实写入点）。',
  ],
  namespace_overlap: [
    '同一 token 名不得同时充当全局 B 类与组件孤岛（双重角色会导致消费者归属不清）。',
    '改名为带前缀的私有 token，或晋升为全局 token，二选一。',
  ],
  whitelist_size: [
    '白名单只能收紧，不能放宽。',
    '新增白名单条目必须在提交信息与物证中说明理由；条目数纳入棘轮。',
  ],
};

// ── 5. 基线读写 ────────────────────────────────────────────────────────────
function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  const text = readFileSync(BASELINE_PATH, 'utf8');
  const s = text.indexOf(START_MARKER);
  const e = text.indexOf(END_MARKER);
  if (s === -1 || e === -1) return null;
  const body = text.slice(s + START_MARKER.length, e);
  const out = {};
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*([a-z_]+)\s+(\d+)\s*$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

function writeBaseline(metrics) {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  const rows = Object.entries(metrics).map(([k, v]) => `${k} ${v}`).join('\n');
  const doc = `# token-ssot 棘轮基线（T1 · 真源唯一化门禁）

> 载体：scripts/check-token-ssot.mjs
> 纪律：**棘轮只降不升**。\`--update\` 仅在指标下降后运行；提升基线必须在提交信息中显式说明理由。
> 硬失败指标（multi_file_defs / js_inject_a_class / b_class_no_default / b_class_drift / namespace_overlap）目标恒为 0。
> 生成时间：${new Date().toISOString()}

${START_MARKER}
${rows}
${END_MARKER}
`;
  writeFileSync(BASELINE_PATH, doc, 'utf8');
}

// ── 6. 主流程 ──────────────────────────────────────────────────────────────
function printGuide(metric) {
  const g = GUIDE_TEXT[metric];
  if (!g) {
    console.error(`[check-token-ssot] 未知指标：${metric}`);
    console.error(`可用：${Object.keys(GUIDE_TEXT).join(', ')}`);
    process.exit(1);
  }
  console.log(`[check-token-ssot] 正确做法 · ${metric}\n`);
  for (const l of g) console.log(`  ${l}`);
  process.exit(0);
}

if (GUIDE) printGuide(GUIDE);

if (LIST) {
  console.log('=== multi_file_defs（同一 token 在 >=2 文件被定义）===');
  for (const d of multiFileDefs) console.log(`  ${d.name}\n      ${d.files.join('\n      ')}`);
  console.log('\n=== js_inject_a_class（JS 写入 A 类设计 Token）===');
  for (const v of aClassViolations) console.log(`  ${v.name}\n      ${v.sites.map((s) => `${s.file}:${s.line}`).join('\n      ')}`);
  console.log('\n=== a_class_multi_writer（同一 A 类 token 被多个 JS 文件写入）===');
  for (const v of multiWriter) console.log(`  ${v.name}\n      ${v.files.join('\n      ')}`);
  console.log(`\n=== b_class_no_default ===`);
  for (const v of bNoDefault) console.log(`  ${v.name}  (声明 staticDefault=${v.declared} 但 tokens.css 无静态声明)`);
  console.log(`\n=== b_class_drift ===`);
  for (const n of bDriftUnregistered) console.log(`  未登记但被写入: ${n}  ->  ${(jsInject.get(n) || []).map((s) => `${s.file}:${s.line}`).join(', ')}`);
  for (const n of bDriftPhantom) console.log(`  已登记但无人写: ${n}`);
  console.log(`\n=== namespace_overlap ===`);
  for (const n of namespaceOverlap) console.log(`  ${n}`);
  console.log(`\n=== whitelist_size ===\n  ${whitelistSize}`);
  process.exit(0);
}

console.log('[check-token-ssot] 扫描根：');
console.log(`  - ${rel(DESKTOP_SRC)}`);
console.log(`[check-token-ssot] A 类 token ${aClassNames.size} 个 · CSS 定义点 ${cssDefs.size} 个 · JS 注入名 ${jsInject.size} 个`);
console.log(`[check-token-ssot] 登记表 B 类 ${bClassNames.size} 个 · 组件孤岛前缀 ${islandPrefixes.length} 个 · 外部注入 ${externalNames.size} 个`);
console.log('');
console.log('[check-token-ssot] 指标：');

// 硬失败指标（目标恒为 0，**不读基线**）。
// 判据：若允许用基线承载存量违规，门禁会「绿而仓库脏」——正是本战役要根除的病。
// 存量的唯一合法载体是 docs/token-consumption-unification/基线记录/gap-registry.md。
const ZERO_TOLERANCE = new Set([
  'multi_file_defs',
  'js_inject_a_class',
  'a_class_multi_writer',
  'b_class_no_default',
  'b_class_drift',
  'namespace_overlap',
]);

const baseline = readBaseline();
if (UPDATE) {
  writeBaseline(metrics);
  console.log(`  已写回基线：${rel(BASELINE_PATH)}`);
  for (const [k, v] of Object.entries(metrics)) console.log(`    ${k} = ${v}`);
  process.exit(0);
}

if (!baseline) {
  // 硬化（2026-09-11）：基线缺失 = FAIL，不自动建线。
  // 理由：自动建线 + exit 0 等价于「删除基线文件即可静默禁用门禁」，是真实绕过漏洞。
  // 建线必须显式 `--update`，使「门禁被关闭/重置」在历史中留痕。
  console.error(`[check-token-ssot] FAIL: 基线文件缺失或标记区非法：${rel(BASELINE_PATH)}`);
  console.error('  ① 首次接入 → 显式运行 `node scripts/check-token-ssot.mjs --update` 建立基线；');
  console.error('  ② 基线被误删 → 从版本库恢复该文件。');
  console.error('  禁止以「基线不存在」为由让门禁静默通过。\n');
  console.error('  当前实测值（供建线参考；注意硬失败指标目标恒为 0，不应以基线承载）：');
  for (const [k, v] of Object.entries(metrics)) {
    const tag = ZERO_TOLERANCE.has(k) ? '目标 0' : '棘轮';
    console.error(`    ${k} = ${v}  (${tag})`);
  }
  process.exit(1);
}

const failures = [];
for (const [k, v] of Object.entries(metrics)) {
  // 硬失败指标的目标恒为 0 —— 不读取基线值。
  // 理由：若允许用基线承载存量违规，门禁会「绿而仓库脏」，正是本战役要根除的病。
  // 存量必须以 gap-registry 登记为待清零，而不是写成可接受基线。
  const b = ZERO_TOLERANCE.has(k) ? 0 : (baseline[k] ?? 0);
  const tag = ZERO_TOLERANCE.has(k) ? '硬失败' : '棘轮';
  console.log(`  ${k.padEnd(20)} 当前 ${String(v).padStart(4)}  基线 ${String(b).padStart(4)}  (${tag})`);
  if (v > b) failures.push({ k, v, b });
}

if (failures.length === 0) {
  console.log('\n[check-token-ssot] OK: 全部指标未超基线');
  process.exit(0);
}

console.error('\n[check-token-ssot] FAIL: 新增 1 项以上（未登记/超基线）：\n');
for (const { k, v, b } of failures) {
  console.error(`▶ ${k}: 当前 ${v} > 基线 ${b}（+${v - b}）`);
  if (k === 'multi_file_defs') {
    for (const d of multiFileDefs.slice(0, 10)) console.error(`    · ${d.name}  @ ${d.files.join(' + ')}`);
  } else if (k === 'js_inject_a_class') {
    for (const x of aClassViolations.slice(0, 20)) {
      console.error(`    · ${x.name}  @ ${x.sites.map((s) => `${s.file}:${s.line}`).join(', ')}`);
    }
  } else if (k === 'a_class_multi_writer') {
    for (const x of multiWriter.slice(0, 20)) {
      console.error(`    · ${x.name}  @ ${x.files.join(' + ')}`);
    }
  } else if (k === 'b_class_no_default') {
    for (const x of bNoDefault.slice(0, 10)) console.error(`    · ${x.name}（应声明 ${x.declared}）`);
  } else if (k === 'b_class_drift') {
    for (const n of bDriftUnregistered.slice(0, 10)) console.error(`    · 未登记但被写入: ${n}`);
    for (const n of bDriftPhantom.slice(0, 10)) console.error(`    · 已登记但无人写: ${n}`);
  } else if (k === 'namespace_overlap') {
    for (const n of namespaceOverlap.slice(0, 10)) console.error(`    · ${n}`);
  }
  console.error(`  正确做法：node scripts/check-token-ssot.mjs --guide ${k}`);
  console.error('');
}
console.error('处置：');
console.error('  · 新增违规 → 按 --guide 的正确做法修复，不得抬高基线掩盖；');
console.error('  · 确属有意 → 显式运行 --update 并在提交信息中说明理由。');
process.exit(1);
