#!/usr/bin/env node
/**
 * scripts/check-reflow-guards.mjs
 * 启动 reflow / 强制同步布局守卫（Wave A · TU7）
 *
 * 扫描面（全仓递归，排除 node_modules / dist / coverage / .git）：
 * 1. getComputedStyle —— 仅在「启动关键路径」文件上 hard-fail；
 *    测试文件白名单（*.test.* / *.spec.* / __tests__ / test-）不报；
 *    非启动路径的交互模块（拖拽 / 菜单 / 虚拟列表等）不拦。
 * 2. html.preload * 通配 —— CSS 中禁止无排除的 `html.preload *` 裸通配；
 *    授权白名单：带 :not(.app-initial-loader …) 的冷启动 FOUC 门闩
 *    （apps/crush-desktop/src/styles/tokens.css 首屏 latch）。
 * 3. requestIdleCallback(..., { timeout: N }) —— 默认 warn；
 *    --strict 时 hard-fail（可选严格，对接 CI 前先软跑）。
 *
 * 用法：
 *   node scripts/check-reflow-guards.mjs
 *   node scripts/check-reflow-guards.mjs --strict
 *   node scripts/check-reflow-guards.mjs --guide <metric>   打印该指标的正确做法（未知/缺省 metric → 列出可用指标并 exit 1）
 *
 * 指标（= FAIL/WARN 行的规则名）：
 *   startup_forced_reflow   启动关键路径 getComputedStyle
 *   preload_wildcard_latch  html.preload * 裸通配
 *   idle_callback_timeout   requestIdleCallback(..., { timeout })
 *
 * 退出码：0 = 无 error（warn 不挡）；1 = 有 error；2 = 参数错误
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DESKTOP_SRC = join(REPO_ROOT, 'apps', 'crish-desktop', 'src');

const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '.vite',
  '.agent-outputs',
  'target',
  '.next',
  'out',
]);

const CODE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.html',
]);

// ── 启动关键路径（相对 apps/crush-desktop/src 的 POSIX 路径）────────────────
// 仅这些文件上的 getComputedStyle 视为启动 reflow 违规。
// 判定依据：main 入口 / bootstrap 链 / 首帧壳与 token 样式。
const STARTUP_CRITICAL_RES = [
  /^main\.tsx$/,
  /^App\.tsx$/,
  /^bootstrap-[a-z-]+\.ts$/,
  /^createSsrGlobals\.ts$/,
  /^index\.css$/,
  /^styles\//,
  /^app\/AppBootstrap\.ts$/,
  /^api\/themeStore\.ts$/,
  /^api\/fontStore\.ts$/,
  /^services\/visualThemeController\.ts$/,
  /^services\/LoggerService\.ts$/,
  /^services\/view-registry\.ts$/,
];

/** 测试 / mock 永不作为 getComputedStyle 违规面 */
const TEST_PATH_RE = /(^|\/)(__tests__|__mocks__|test-utils)(\/|$)|\.test\.|\.spec\.|test-setup/i;

/** 已登记豁免（文件相对仓库根）——逐条必须有注释理由；空表起步 */
const GET_COMPUTED_STYLE_ALLOWLIST = new Set([
  // 预留：确证「读一次 CSS 变量且不触发启动 reflow」后再登记
]);

/** html.preload 门闩授权：选择器必须含 app-initial-loader 排除 */
const PRELOAD_EXCLUSION = ':not(.app-initial-loader';

// ── 指引（--guide <metric>）──────────────────────────────────────────────────
// 输出契约（五元规约）：违反项 · 文件:行号 · 当前值 · 阈值 · 正确做法。
function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const GUIDE_FLAG = process.argv.includes('--guide');
const GUIDE = argVal('--guide');

const GUIDE_TEXT = {
  startup_forced_reflow: [
    '违反项：启动关键路径文件调用 getComputedStyle（FAIL 行：getComputedStyle 启动关键路径违规 · <file>:<line>）。',
    '当前值：该文件命中 getComputedStyle 调用（本次实测扫描 7873 文件 / 启动关键路径命中 33 文件）；阈值：启动关键路径上命中数 = 0。',
    '判定面：STARTUP_CRITICAL_RES（main.tsx / App.tsx / bootstrap-*.ts / index.css / styles/** / themeStore.ts / fontStore.ts / visualThemeController.ts …）。',
    '正确做法：启动期一律不读布局；需要的值改为静态常量或设计 token，交互期（点击/拖拽/ResizeObserver 回调）再读。',
    '  错误：const h = window.getComputedStyle(el).height;   // 启动期同步读 → 强制 reflow',
    '  正确：const h = STATIC_HEIGHT;                        // 或把读取移入回调：new ResizeObserver(() => { /* 此处读 */ }).observe(el);',
    '确证「只读一次 CSS 变量且不触发启动 reflow」的极少数场景，逐条登记到 GET_COMPUTED_STYLE_ALLOWLIST 并写明理由（该名单只能收紧）。',
    '权威出处：docs/startup-performance-audit/06-空闲预热与后台协程争抢详案.md §4.7.3（ACT-701）；docs/startup-performance-audit/audits/04-立体验证模型与防御门禁审计报告.md §3.3。',
  ],
  preload_wildcard_latch: [
    '违反项：CSS 出现 html.preload * 裸通配（FAIL 行：html.preload 裸通配 · <file>:<line>）。',
    '当前值：选择器头部命中 html.preload *；阈值：裸通配命中数 = 0（唯一授权形态是带 app-initial-loader 排除的冷启动 FOUC 门闩）。',
    '机理：该通配会把 loader 在内的整棵子树冻结在「无过渡/无动画」态，首屏样式重算被放大。',
    '正确做法（授权写法，tokens.css 首屏 latch）：',
    '  html.preload *:not(.app-initial-loader, .app-initial-loader *) { transition: none !important; animation: none !important; }',
    '若只是要抑制某个局部的过渡，把选择器收窄到该局部类名（如 html.preload .myPanel *），禁止整树通配。',
    '权威出处：docs/startup-performance-audit/06-空闲预热与后台协程争抢详案.md §4.7.3（FORBIDDEN_WILDCARD_LATCH）。',
  ],
  idle_callback_timeout: [
    '违反项：requestIdleCallback 传入 { timeout }（非 --strict 为 WARN；--strict 下升为 FAIL）。',
    '当前值（实测现行犯）：packages/shared-utils/src/hardware-profile.ts:281；阈值：带 timeout 的 requestIdleCallback 命中数 = 0。',
    '机理：timeout 会在忙帧后强制入队，削弱 idle 语义并可能把非关键工作提前到首屏窗口。',
    '正确做法二选一：',
    '  ① 去掉 timeout：requestIdleCallback(fn);',
    '  ② 确实需要「最迟多久执行」的语义 → 改用宏任务并显式控频：setTimeout(fn, 2000);（由调用方排队/去抖）',
    '  错误：requestIdleCallback(fn, { timeout: 2000 });',
    '权威出处：docs/startup-performance-audit/06-空闲预热与后台协程争抢详案.md §4.7.3（FORBIDDEN_IDLE_TIMEOUT）。',
  ],
};

function printGuide(metric) {
  const g = GUIDE_TEXT[metric];
  if (!g) {
    console.error(`[check-reflow-guards] 未知指标：${metric}`);
    console.error(`可用：${Object.keys(GUIDE_TEXT).join(', ')}`);
    process.exit(1);
  }
  console.log(`[check-reflow-guards] 正确做法 · ${metric}\n`);
  for (const l of g) console.log(`  ${l}`);
  process.exit(0);
}

if (GUIDE_FLAG) printGuide(GUIDE);

// ── argv ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let strictIdle = false;
for (const a of argv) {
  if (a === '--strict') strictIdle = true;
  else if (a === '--help' || a === '-h') {
    console.log(
      '用法: node scripts/check-reflow-guards.mjs [--strict]\n' +
        '  --strict  将 requestIdleCallback(..., {timeout}) 升为 error'
    );
    process.exit(0);
  } else {
    console.error(`check-reflow-guards: 未知参数 ${a}`);
    process.exit(2);
  }
}

// ── walk ─────────────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) walk(p, out);
    } else if (e.isFile()) {
      const lower = e.name.toLowerCase();
      let keep = false;
      for (const ext of CODE_EXTS) {
        if (lower.endsWith(ext)) {
          keep = true;
          break;
        }
      }
      if (keep) out.push(p);
    }
  }
  return out;
}

const rel = (p) => relative(REPO_ROOT, p).replace(/\\/g, '/');

function isStartupCritical(absPath) {
  const r = rel(absPath);
  const prefix = 'apps/crish-desktop/src/';
  if (!r.startsWith(prefix)) return false;
  const srcRel = r.slice(prefix.length);
  return STARTUP_CRITICAL_RES.some((re) => re.test(srcRel));
}

function lineOf(content, index) {
  let n = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) n++;
  }
  return n;
}

// ── patterns ─────────────────────────────────────────────────────────────────
/**
 * getComputedStyle / window.getComputedStyle 调用（排除 typeof 探测中的
 * `typeof window.getComputedStyle` 探测分支单独处理：探测本身无 reflow，
 * 实际调用行仍会命中）。
 */
const RE_GET_COMPUTED = /(?<!typeof\s)window\.getComputedStyle\s*\(|(?<![\w.$])getComputedStyle\s*\(/g;

/** requestIdleCallback(fn, { timeout: N }) —— options 对象含 timeout */
const RE_RIC_TIMEOUT = /requestIdleCallback\s*\(\s*[^,)]+,\s*\{[^}]*\btimeout\s*:/g;

const errors = [];
const warnings = [];
let scanned = 0;
let startupFiles = 0;

const files = walk(REPO_ROOT);

for (const abs of files) {
  const r = rel(abs);
  // 顶层 scripts 自身与 reference 大体量第三方对照库不在启动面
  if (r.startsWith('scripts/')) continue;
  if (r.startsWith('reference/')) continue;

  let content;
  try {
    content = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  scanned++;

  const startup = isStartupCritical(abs);
  if (startup) startupFiles++;
  const isTest = TEST_PATH_RE.test(r);
  const isCss = /\.(css|scss)$/i.test(abs);

  // ── 1) getComputedStyle（启动关键路径 hard）──────────────────────────────
  if (!isCss && content.includes('getComputedStyle')) {
    RE_GET_COMPUTED.lastIndex = 0;
    let m;
    while ((m = RE_GET_COMPUTED.exec(content)) !== null) {
      // typeof 探测：typeof window.getComputedStyle —— 允许（无调用）
      const before = content.slice(Math.max(0, m.index - 20), m.index);
      if (/typeof\s+$/.test(before)) continue;

      const ln = lineOf(content, m.index);
      const loc = `${r}:${ln}`;
      if (isTest || GET_COMPUTED_STYLE_ALLOWLIST.has(r)) continue;
      if (!startup) {
        // 非启动路径：info 级不输出（避免噪音）；可后续 --verbose
        continue;
      }
      errors.push(
        `getComputedStyle 启动关键路径违规 · ${loc} · 同步读样式可触发 reflow · ` +
          `正确做法：启动期缓存到 JS 变量/主题 token，交互期再按需读取`
      );
    }
  }

  // ── 2) html.preload * 裸通配（CSS）────────────────────────────────────────
  if (isCss && /html\s*\.\s*preload/.test(content)) {
    const lines = content.split(/\r?\n/);
    let inComment = false;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (inComment) {
        if (line.includes('*/')) {
          line = line.slice(line.indexOf('*/') + 2);
          inComment = false;
        } else continue;
      }
      const open = line.indexOf('/*');
      if (open >= 0) {
        const close = line.indexOf('*/', open + 2);
        if (close < 0) {
          line = line.slice(0, open);
          inComment = true;
        } else {
          line = line.slice(0, open) + line.slice(close + 2);
        }
      }
      if (!/html\s*\.\s*preload/.test(line)) continue;
      const brace = line.indexOf('{');
      const selPart = brace >= 0 ? line.slice(0, brace) : line;
      // 只拦「preload 后接 *」的通配（含 html.preload * 与 html.preload*,）
      if (!/html\s*\.\s*preload\s*\*/.test(selPart)) continue;
      // 授权 latch：同一选择器头内含 :not(.app-initial-loader
      if (selPart.includes(PRELOAD_EXCLUSION) || /html\s*\.\s*preload\s+\*:not\s*\(\s*\.app-initial-loader/.test(selPart)) {
        continue;
      }
      // 多行选择器：向上拼最多 6 行再判排除
      const windowSlice = lines
        .slice(Math.max(0, i - 2), Math.min(lines.length, i + 8))
        .join('\n');
      if (/html\s*\.\s*preload\s+\*:not\s*\(\s*\.app-initial-loader/.test(windowSlice)) {
        continue;
      }
      errors.push(
        `html.preload 裸通配 · ${r}:${i + 1} · \`html.preload *\` 会冻结含 loader 在内的全树样式 · ` +
          `正确做法：\`html.preload *:not(.app-initial-loader, .app-initial-loader *)\`（tokens.css latch）`
      );
    }
  }

  // ── 3) requestIdleCallback timeout ────────────────────────────────────────
  if (!isCss && content.includes('requestIdleCallback')) {
    RE_RIC_TIMEOUT.lastIndex = 0;
    let m;
    while ((m = RE_RIC_TIMEOUT.exec(content)) !== null) {
      const ln = lineOf(content, m.index);
      const loc = `${r}:${ln}`;
      const msg =
        `requestIdleCallback 带 timeout · ${loc} · timeout 会在忙帧后强制入队，` +
        `削弱 idle 语义并可能提前触发非关键工作 · 正确做法：无 timeout 的 requestIdleCallback，` +
        `或降级 setTimeout 由调用方控频`;
      if (strictIdle) errors.push(msg);
      else warnings.push(msg);
    }
  }
}

// ── 收口 ─────────────────────────────────────────────────────────────────────
console.log('=== reflow guards ===');
console.log(`扫描文件: ${scanned}；启动关键路径命中: ${startupFiles}`);
console.log(
  `规则: getComputedStyle@启动路径 | html.preload *（白名单 latch） | requestIdleCallback timeout（${strictIdle ? 'strict' : 'warn-only'}）`
);

for (const w of warnings) console.warn(`[check-reflow-guards] WARN: ${w}`);
for (const e of errors) console.error(`[check-reflow-guards] FAIL: ${e}`);

if (errors.length > 0) {
  console.error(`[check-reflow-guards] ${errors.length} error(s)`);
  process.exit(1);
}
console.log(
  `[check-reflow-guards] OK（${warnings.length} warning${warnings.length === 1 ? '' : 's'}）`
);
process.exit(0);
