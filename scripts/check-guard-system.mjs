#!/usr/bin/env node
/**
 * scripts/check-guard-system.mjs
 * 防御体系自审门禁（2026-09-11 事故与误判驱动新增）
 *
 * 要解决的元问题：**门禁本身没有守卫**。实战中出现的四类失效——
 *   ① 门禁写好了但没人跑（未接入 husky / CI）→ 「有门禁」是纸面事实；
 *   ② 门禁 FAIL 时只说「X = N > baseline」，后续 Agent 不知如何修 → 指引缺失；
 *   ③ 基线缺失即自动建线并 exit 0 → **删除基线文件即可静默禁用门禁**（真实绕过漏洞）；
 *   ④ 守卫脚本语法损坏 → 永不产出结论，等同于不存在。
 * 本门禁把这四类失效变成可判定的指标，使「防御体系」自身进入受防守状态。
 *
 * 契约标记：
 *   silent_baseline_pass  @zero-tolerance（不读基线，目标恒为 0）
 *   unwired_guard / guide_capable_missing / broken_guard  @ratchet（只降不升）
 *
 * Run: node scripts/check-guard-system.mjs [--list] [--guide <metric>] [--update]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, relative, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts');

const START_MARKER = '<!-- BASELINE_START -->';
const END_MARKER = '<!-- BASELINE_END -->';
const BASELINE_PATH = resolve(
  REPO_ROOT,
  'docs/token-consumption-unification/基线记录/guard-system-baseline.md'
);

const LIST = process.argv.includes('--list');
const UPDATE = process.argv.includes('--update');
const guideIdx = process.argv.indexOf('--guide');
const GUIDE = guideIdx >= 0 ? process.argv[guideIdx + 1] : undefined;

const ZERO_TOLERANCE = new Set(['silent_baseline_pass', 'unreleased_guard']);

/**
 * 显式豁免：未接入任何自动触发点但**有意保留**的守卫，必须逐条给出理由。
 * 纪律：本名单只能收紧。新增条目须在提交信息与台账中说明理由。
 */
const UNWIRED_ALLOWLIST = [
  { name: 'check-convergence-metrics.mjs', reason: '仅度量不判定（无失败语义），刻意不接入阻断链路' },
  { name: 'check-coverage-threshold.mjs', reason: '需先跑完整覆盖率，耗时不适合 hook；待接入 CI 慢速通道' },
  { name: 'check-chat-state.mjs', reason: '专题诊断脚本，非通用门禁' },
  { name: 'check-tsc-threshold.mjs', reason: '与 typecheck 重复，待评估合并' },
  { name: 'check-lr-t1-memory-prod-ban.mjs', reason: '专题禁令，待评估接入 CI' },
  { name: 'check-legacy-shim.mjs', reason: '规则集需先对齐现行口径，否则误报' },
  { name: 'check-sec7-gfm-emoji.mjs', reason: '安全专题，待评估接入 CI' },
  { name: 'check-layoutstore-actions.mjs', reason: '专题结构断言，待评估接入 CI' },
  { name: 'check-ui-negative-churn.mjs', reason: '基线内嵌于脚本，待迁移为标记区基线后接入' },
  // ── 以下 3 条为仍实测 FAIL 的存量债务（2026-10-20 DEBT-09 复核：原 6 条中
  // color-ssot / line-width-ssot / frontend-convergence 已实测 PASS，移出本名单并
  // 接入 .github/workflows/ci-mid.yml 的 desktop-guards job）──
  // 接入前提：**先修好**，否则接进 ci-mid 的 desktop-guards 会让 PR 全红。
  // 修好后必须从本豁免名单移除并接入 .github/workflows/ci-mid.yml 的 desktop-guards job。
  {
    name: 'check-token-ssot.mjs',
    reason:
      '实测 FAIL（2026-10-20 DEBT-09 复测）：js_inject_a_class 26 > 基线 0（硬失败，JS 直接注入 A 类设计 Token，owner=T-BLK-07b 26 处参数化，待派）；documented_api_defs 25 ≤ 26 已达标。归零后接入 desktop-guards',
  },
  {
    name: 'check-tokens-all.mjs',
    reason:
      '聚合门禁：因 check-token-ssot 的 js_inject_a_class 26 > 0 而 FAIL（见该条，owner=T-BLK-07b）。随其归零后一并接入 desktop-guards',
  },
  {
    name: 'check-conex-db-size.mjs',
    reason:
      '实测 FAIL：crates/conex-db/src/usage_analytics.rs 825 行 > 600（最大 mod 1085 > 600）。owner=T-BLK-08（9 文件按职责拆分，事务/GC 语义不变），拆分后接入 desktop-guards',
  },
];

const GUIDE_TEXT = {
  unwired_guard: [
    '守卫脚本必须至少接入一个自动触发点，否则「有门禁」只是纸面事实。',
    '二选一：① 在 package.json 增加 `check:<name>` 脚本，并在 .husky/* 或 .github/workflows/* 中调用；',
    '        ② 若有意保留为手动/专题脚本，加入本脚本的 UNWIRED_ALLOWLIST 并写明理由。',
    '注意：只写进 package.json 但无人调用 = 仍未接线（本门禁会持续报出）。',
  ],
  guide_capable_missing: [
    '守卫 FAIL 时必须告诉执行者「正确做法」，否则后续 Agent 只能猜。',
    '要求：脚本支持 `--list`（全量明细）或 `--guide <metric>`（打印该指标的正确做法与可复制修复形态）。',
    '输出契约（五元规约）：违反项 · 文件:行号 · 当前值 · 阈值 · 正确做法。',
    '禁止只报 `FAIL: X = N > baseline`。',
  ],
  silent_baseline_pass: [
    '严禁「基线文件缺失 → 自动建线 + exit 0」。',
    '该行为等价于：**删除基线文件即可静默禁用门禁**（无产出即无违规），是真实绕过漏洞。',
    '正确做法：基线缺失 → FAIL，并提示「① 首次接入请显式运行 --update；② 误删请从版本库恢复」。',
    '同理：硬失败（zero-tolerance）指标不得读取基线值——存量不得用基线承载，只能登记到缺口台账。',
  ],
  broken_guard: [
    '守卫脚本必须能被 node 解析，否则永不产出结论 = 等同于不存在。',
    '用 `node --check <script>` 复现；修好语法或从版本库恢复。',
    '注意：若脚本带 BOM，`node --check` 会误报（BOM+shebang 组合），本门禁已剥离 BOM 后再判定；',
    '      BOM 本身由 bom_in_guard 单独计量。',
  ],
  bom_in_guard: [
    '守卫脚本不应带 UTF-8 BOM。BOM 会让 `node --check` 误报、且与仓库既有 check-css-encoding 的禁令不一致。',
    '修法：以 UTF-8 **无 BOM** 重写该文件（PowerShell：',
    '  [System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($false)))）。',
  ],
  unreleased_guard: [
    '.gitignore 有全局忽略 `*.mjs` / `*.json`，scripts/ 下的守卫脚本与真源登记表必须**逐条显式放行**。',
    '未放行的后果：新增门禁不进版本库 → 他人 clone / CI checkout 后脚本缺失 → 聚合入口直接断裂；',
    '本地一切正常，**故障只在别人的环境里出现**，属最隐蔽的一类。',
    '修法：在 .gitignore 的「门禁脚本放行」区追加一行 `!scripts/<name>`（沿用既有惯例与注释格式）。',
    '验证：`git check-ignore -v scripts/<name>` 应无输出；`git status` 应能看到该文件。',
  ],
};

// ── 采集守卫清单 ───────────────────────────────────────────────────────────
const guards = readdirSync(SCRIPTS_DIR)
  .filter((f) => f.startsWith('check-') && f.endsWith('.mjs'))
  .sort();

function readAll(paths) {
  return paths
    .filter((p) => {
      try {
        return existsSync(p) && !statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n');
}

/** 列出目录下的文件（跳过子目录，如 .husky/_） */
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

// 触发点文本：package.json + husky + CI
const pkgText = existsSync(join(REPO_ROOT, 'package.json'))
  ? readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')
  : '';
const huskyText = readAll(listFiles(join(REPO_ROOT, '.husky')));
const ciText = readAll(listFiles(join(REPO_ROOT, '.github', 'workflows')));

const allowNames = new Set(UNWIRED_ALLOWLIST.map((a) => a.name));

// 建立「门禁文件 ← npm 脚本名」映射。
// 必要性：CI/husky 通常以 `npm run check:xxx` 调用，**不含文件名**——
// 只按文件名字面量判断会产生假阴性（把已接线的门禁误报为未接线）。
let pkgScripts = {};
try {
  pkgScripts = JSON.parse(pkgText || '{}').scripts || {};
} catch {
  pkgScripts = {};
}
const fileToNpmKeys = new Map();
for (const [key, cmd] of Object.entries(pkgScripts)) {
  const re = /scripts\/(check-[\w.-]+\.mjs)/g;
  let m;
  while ((m = re.exec(String(cmd)))) {
    if (!fileToNpmKeys.has(m[1])) fileToNpmKeys.set(m[1], []);
    fileToNpmKeys.get(m[1]).push(key);
  }
}

function wiredVia(g) {
  // 直接按文件名接线
  if (huskyText.includes(`scripts/${g}`) || ciText.includes(`scripts/${g}`)) return 'direct';
  // 经由 npm 脚本间接接线（`check:xxx` 或 `npm run check:xxx`）
  for (const key of fileToNpmKeys.get(g) || []) {
    if (huskyText.includes(key) || ciText.includes(key)) return `npm:${key}`;
  }
  return null;
}

// ── 指标 1：unwired_guard ──────────────────────────────────────────────────
const unwired = [];
for (const g of guards) {
  const via = wiredVia(g);
  if (!via && !allowNames.has(g)) {
    unwired.push({ name: g, inPkg: pkgText.includes(`scripts/${g}`), npmKeys: fileToNpmKeys.get(g) || [] });
  }
}

// ── 指标 2：guide_capable_missing ──────────────────────────────────────────
const noGuidance = [];
for (const g of guards) {
  const src = readFileSync(join(SCRIPTS_DIR, g), 'utf8');
  const hasList = /--list/.test(src);
  const hasGuide = /--guide/.test(src);
  if (!hasList && !hasGuide) noGuidance.push(g);
}

// ── 指标 3：silent_baseline_pass（@zero-tolerance） ────────────────────────
// 必须**块级精确匹配**：早期版本用 `[\s\S]{0,1200}?` 跨块匹配，会把紧随其后的
// 成功分支（合法 `process.exit(0)`）误判为违规 —— 假阳性会让人不信任门禁。
// 做法：定位「基线缺失」判定语句 → 花括号配平取出该 if 块 → 只在该块内查 exit(0)。
const MISSING_BASELINE_RE =
  /if\s*\(\s*(?:!\s*baseline\b|baseline\s*===?\s*null\b|!\s*existsSync\([^)]*BASELINE[^)]*\))\s*\)/g;

function extractIfBlock(src, matchIndex, matchLength) {
  const braceStart = src.indexOf('{', matchIndex + matchLength);
  if (braceStart === -1) return '';
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  return src.slice(braceStart); // 未配平：保守返回余下全文
}

const silentPass = [];
for (const g of guards) {
  if (g === 'check-guard-system.mjs') continue; // 自治守卫含检测模式串，排除自我误报
  const src = readFileSync(join(SCRIPTS_DIR, g), 'utf8');
  MISSING_BASELINE_RE.lastIndex = 0;
  let m;
  while ((m = MISSING_BASELINE_RE.exec(src))) {
    const block = extractIfBlock(src, m.index, m[0].length);
    if (/process\.exit\(\s*0\s*\)/.test(block)) {
      silentPass.push(g);
      break;
    }
  }
}

// ── 指标 4：broken_guard（真实的语法错误） ─────────────────────────────────
// 陷阱更正（2026-09-11）：`node --check <file>` 在「BOM + shebang」组合上会
// **误报** SyntaxError（实测：报错的脚本 `node <file>` 运行正常且 exit 0）。
// 因此这里先剥掉 BOM 写入临时副本再 check，把「BOM」与「真实语法错误」分离。
// BOM 本身另由 bom_in_guard 作为卫生债计量（ratchet），不谎报为"脚本损坏"。
const broken = [];
const bomGuards = [];
let tmpDir = null;
for (const g of guards) {
  const abs = join(SCRIPTS_DIR, g);
  const buf = readFileSync(abs);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (hasBom) bomGuards.push(g);

  let checkTarget = abs;
  if (hasBom) {
    if (!tmpDir) {
      tmpDir = join(tmpdir(), `guard-check-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
    }
    checkTarget = join(tmpDir, g);
    writeFileSync(checkTarget, buf.subarray(3));
  }
  try {
    execFileSync('node', ['--check', checkTarget], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    broken.push({ name: g, err: `${e.stderr ?? ''}`.split('\n').slice(0, 3).join(' | ').trim() });
  }
}
if (tmpDir) {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响判定 */
  }
}

// ── 指标 5：unreleased_guard（@zero-tolerance） ────────────────────────────
// 发现（2026-09-11）：`.gitignore:381 *.mjs` / `:378 *.json` 全局忽略，
// 而 scripts/ 下的守卫脚本与真源登记表**必须逐条显式 `!` 放行**，否则：
//   新增门禁 → 不进版本库 → CI checkout 后脚本缺失 → check:tokens-all 直接断裂。
// 后果是「防御体系无法生长」这一结构性缺陷，且**无声无息**（本地一切正常）。
const GUARD_ASSETS = [...guards.map((g) => `scripts/${g}`), 'scripts/token-registry.json'];

let gitUsable = true;
try {
  execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch {
  gitUsable = false;
}

// 批量调用（**性能关键**）：逐路径调用 `git check-ignore` 共 45 次 spawn，
// 在本仓库（60 万+ 资产）实测 ~2 分 50 秒，作为 pre-commit 完全不可用。
// 一次传入全部路径并解析 stdout，把开销降到单次 spawn。
// 语义：命中忽略规则的路径会逐行输出；全部未命中时 exit 1 且无输出（正常，非错误）。
const ignoredSet = new Set();
if (gitUsable && GUARD_ASSETS.length) {
  let out = '';
  try {
    out = execFileSync('git', ['check-ignore', '--', ...GUARD_ASSETS], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = `${e.stdout ?? ''}`;
  }
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (t) ignoredSet.add(t.replace(/\\/g, '/'));
  }
}
const unreleased = gitUsable ? GUARD_ASSETS.filter((p) => ignoredSet.has(p)) : [];

const metrics = {
  unwired_guard: unwired.length,
  guide_capable_missing: noGuidance.length,
  silent_baseline_pass: silentPass.length,
  broken_guard: broken.length,
  bom_in_guard: bomGuards.length,
  unreleased_guard: unreleased.length,
};

// ── 基线 ───────────────────────────────────────────────────────────────────
function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  const text = readFileSync(BASELINE_PATH, 'utf8');
  const s = text.indexOf(START_MARKER);
  const e = text.indexOf(END_MARKER);
  if (s === -1 || e === -1) return null;
  const out = {};
  for (const line of text.slice(s + START_MARKER.length, e).split('\n')) {
    const m = line.match(/^\s*([a-z_]+)\s+(\d+)\s*$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

function writeBaseline() {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  const rows = Object.entries(metrics).map(([k, v]) => `${k} ${v}`).join('\n');
  writeFileSync(
    BASELINE_PATH,
    `# guard-system 棘轮基线（防御体系自审）

> 载体：scripts/check-guard-system.mjs
> 纪律：棘轮只降不升；\`silent_baseline_pass\` 为 @zero-tolerance，恒与 0 比较、不读基线。
> 生成时间：${new Date().toISOString()}

${START_MARKER}
${rows}
${END_MARKER}
`,
    'utf8'
  );
}

// ── 输出 ───────────────────────────────────────────────────────────────────
if (GUIDE) {
  const g = GUIDE_TEXT[GUIDE];
  if (!g) {
    console.error(`[check-guard-system] 未知指标：${GUIDE}`);
    console.error(`可用：${Object.keys(GUIDE_TEXT).join(', ')}`);
    process.exit(1);
  }
  console.log(`[check-guard-system] 正确做法 · ${GUIDE}\n`);
  for (const l of g) console.log(`  ${l}`);
  process.exit(0);
}

if (LIST) {
  console.log(`=== unwired_guard（未接入 husky/CI 且未豁免）: ${unwired.length} ===`);
  for (const u of unwired) {
    const npm = u.npmKeys.length ? u.npmKeys.join(',') : '(无 npm 脚本)';
    console.log(`  ${u.name}   [npm 脚本=${npm}]`);
  }
  console.log(`\n=== guide_capable_missing（无 --list 也无 --guide）: ${noGuidance.length} ===`);
  for (const n of noGuidance) console.log(`  ${n}`);
  console.log(`\n=== silent_baseline_pass（基线缺失即静默通过）: ${silentPass.length} ===`);
  for (const n of silentPass) console.log(`  ${n}`);
  console.log(`\n=== broken_guard（node --check 不通过，已剥离 BOM 后判定）: ${broken.length} ===`);
  for (const b of broken) console.log(`  ${b.name}  ::  ${b.err}`);
  console.log(`\n=== bom_in_guard（守卫脚本带 UTF-8 BOM）: ${bomGuards.length} ===`);
  for (const n of bomGuards) console.log(`  ${n}`);
  console.log(`\n=== unreleased_guard（守卫资产未被 .gitignore 放行）: ${unreleased.length} ===`);
  for (const n of unreleased) console.log(`  ${n}`);
  process.exit(0);
}

console.log(`[check-guard-system] 守卫脚本 ${guards.length} 个；触发点来源：package.json / .husky / .github/workflows`);
console.log('');
console.log('[check-guard-system] 指标：');

const baseline = readBaseline();

if (UPDATE) {
  writeBaseline();
  console.log(`  已写回基线：${relative(REPO_ROOT, BASELINE_PATH).split('\\').join('/')}`);
  for (const [k, v] of Object.entries(metrics)) console.log(`    ${k} = ${v}`);
  process.exit(0);
}

if (!baseline) {
  console.error(`[check-guard-system] FAIL: 基线文件缺失或标记区非法：${relative(REPO_ROOT, BASELINE_PATH).split('\\').join('/')}`);
  console.error('  ① 首次接入 → 显式运行 `node scripts/check-guard-system.mjs --update`；');
  console.error('  ② 误删 → 从版本库恢复。');
  console.error('  禁止以「基线不存在」为由让门禁静默通过。\n');
  for (const [k, v] of Object.entries(metrics)) console.error(`    ${k} = ${v}`);
  process.exit(1);
}

const failures = [];
for (const [k, v] of Object.entries(metrics)) {
  const b = ZERO_TOLERANCE.has(k) ? 0 : (baseline[k] ?? 0);
  const tag = ZERO_TOLERANCE.has(k) ? '@zero-tolerance' : '@ratchet';
  console.log(`  ${k.padEnd(22)} 当前 ${String(v).padStart(3)}  基线 ${String(b).padStart(3)}  (${tag})`);
  if (v > b) failures.push({ k, v, b });
}

if (failures.length === 0) {
  console.log('\n[check-guard-system] OK: 防御体系自审全部通过');
  process.exit(0);
}

console.error('\n[check-guard-system] FAIL:\n');
for (const { k, v, b } of failures) {
  console.error(`▶ ${k}: 当前 ${v} > 基线 ${b}（+${v - b}）`);
  if (k === 'unwired_guard') for (const u of unwired.slice(0, 15)) console.error(`    · ${u.name}`);
  if (k === 'guide_capable_missing') for (const n of noGuidance.slice(0, 15)) console.error(`    · ${n}`);
  if (k === 'silent_baseline_pass') for (const n of silentPass.slice(0, 15)) console.error(`    · ${n}`);
  if (k === 'broken_guard') for (const x of broken.slice(0, 15)) console.error(`    · ${x.name} :: ${x.err}`);
  if (k === 'bom_in_guard') for (const n of bomGuards.slice(0, 15)) console.error(`    · ${n}`);
  if (k === 'unreleased_guard') for (const n of unreleased.slice(0, 15)) console.error(`    · ${n}`);
  console.error(`  正确做法：node scripts/check-guard-system.mjs --guide ${k}\n`);
}
console.error('处置：');
console.error('  · 接入触发点或加入 UNWIRED_ALLOWLIST 并写明理由；');
console.error('  · 禁止把「门禁关闭」写成基线增量。');
process.exit(1);
