#!/usr/bin/env node
/**
 * scripts/check-source-assets-tracked.mjs
 *
 * W9-C 源资产入库门禁：**源码 `import` 的 `.json` 必须已被 git 跟踪**。
 *
 * 要解决的根因（docs/model-config-ssot-convergence/plans/09 §5.4、00-兼容清册 F 节）：
 *   仓库 .gitignore 曾用全局裸 `*.json` 忽略临时产物，误伤源码树下的数据资产——
 *   `apps/crish-desktop/src/services/modelsAutofillBaselineData.json`（被
 *   `modelsAutofillBaseline.ts:19` import）因此**从未入库**，且 `git log` 为空。
 *   该缺陷无声无息：本地文件在、构建能过，只有他人 clone / CI checkout 后才断裂。
 *
 * 本门禁把「源码引用的 json 是否入库」变成可判定断言：
 *   ① 扫描 apps\*\*\/src\/\*\* 与 packages\*\*\/src\/\*\* 下的源码；
 *   ② 抓取 `import ... from '<相对路径>.json'`（含单双引号 / 副作用 import / 动态 import）；
 *   ③ 解析为绝对路径后，断言每个文件都被 git 跟踪（git ls-files 命中）。
 *   未跟踪即 FAIL 并列出文件（含引用点 file:line）。
 *
 * 用法：
 *   node scripts/check-source-assets-tracked.mjs           # 判定，违规即 exit 1
 *   node scripts/check-source-assets-tracked.mjs --list    # 打印全部「源码 -> json」引用清单
 *   node scripts/check-source-assets-tracked.mjs --guide   # 打印正确做法
 *
 * 纯 Node ESM，无第三方依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const LIST = process.argv.includes('--list');
const GUIDE = process.argv.includes('--guide');

/** 扫描根：源码树（相对仓库根）。 */
const SOURCE_ROOTS = ['apps', 'packages'];

/** 视为「源码」的扩展名（TS/JS 家族；含测试文件——测试引用的 json 同样须入库）。 */
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** 跳过目录：构建产物 / 依赖。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', '.turbo', 'coverage']);

const GUIDE_TEXT = [
  '源码 `import` 的 .json 是构建期依赖，必须纳入版本控制，否则他人 clone / CI checkout 后断裂。',
  '常见根因：.gitignore 用全局裸 `*.json` 忽略临时产物，误伤 apps/**/src 或 packages/**/src 下的数据资产。',
  '正确做法（二选一，优先 ①）：',
  '  ① 在 .gitignore 追加目录级放行：`!apps/**/src/**/*.json`、`!packages/**/src/**/*.json`（一次覆盖所有源码资产）；',
  '  ② 若该 json 确属临时/生成物 → 改为运行时生成，不要用 import 静态引用。',
  '验证：`git ls-files --error-unmatch <file>` 应命中；`git status` 应能看到该文件。',
].join('\n  ');

// ───────────────────────────── 采集 ─────────────────────────────

/** 递归收集源码文件。 */
function collectSourceFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectSourceFiles(full, out);
    } else if (SOURCE_EXTS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/** 去除注释，降低「注释里的 import」误报。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 从源码文本抓取「相对路径 .json」引用。
 * 覆盖：`import x from './y.json'` / `import './y.json'` / `export {x} from './y.json'` / `import('./y.json')`。
 */
function extractJsonSpecs(src) {
  const specs = new Set();
  const patterns = [
    /\bfrom\s*['"](\.[^'"]+\.json)['"]/g, // import/export ... from '...'
    /\bimport\s*\(\s*['"](\.[^'"]+\.json)['"]\s*\)/g, // 动态 import('...')
    /\bimport\s*['"](\.[^'"]+\.json)['"]/g, // 副作用 import '...'
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) specs.add(m[1]);
  }
  return specs;
}

// ───────────────────────────── 主流程 ─────────────────────────────

const rootDirs = SOURCE_ROOTS.map((r) => path.join(REPO_ROOT, r));
const sourceFiles = rootDirs
  .flatMap((d) => collectSourceFiles(d))
  // 精确限定为 `apps/**/src/**` 与 `packages/**/src/**`（路径含 `src` 段）
  .filter((f) => path.relative(REPO_ROOT, f).split(path.sep).includes('src'));

/** 引用清单：[{ importer, line, spec, abs }] */
const references = [];
for (const file of sourceFiles) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const stripped = stripComments(raw);
  const specs = extractJsonSpecs(stripped);
  if (specs.size === 0) continue;
  const rawLines = raw.split(/\r?\n/);
  for (const spec of specs) {
    const abs = path.resolve(path.dirname(file), spec);
    // 定位引用行（在原始文本里找 spec，用于报告 file:line）
    const lineNo = rawLines.findIndex((l) => l.includes(spec)) + 1;
    references.push({
      importer: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
      line: lineNo || 0,
      spec,
      abs,
      rel: path.relative(REPO_ROOT, abs).split(path.sep).join('/'),
    });
  }
}

// 去重（同一 json 被多处引用时保留全部引用点用于报告）
const uniqueTargets = [...new Set(references.map((r) => r.rel))].sort();

// ── git 跟踪判定（一次调用，性能关键：避免逐文件 spawn） ──
function gitTrackedSet(rels) {
  if (rels.length === 0) return { ok: true, tracked: new Set() };
  const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (probe.status !== 0) return { ok: false, tracked: new Set() };
  const res = spawnSync('git', ['ls-files', '-z', '--', ...rels], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.status !== 0) return { ok: false, tracked: new Set() };
  const tracked = new Set(
    `${res.stdout || ''}`
      .split('\0')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(path.sep).join('/'))
  );
  return { ok: true, tracked };
}

const { ok: gitOk, tracked } = gitTrackedSet(uniqueTargets);
// 分类：
//   · untracked = 文件存在但未入库 → 本门禁判定目标（.gitignore 误伤类缺陷）
//   · missing   = 文件不存在 → import 断裂（tsc/vitest 兜底），仅告警、不判 FAIL
const untracked = references.filter((r) => !tracked.has(r.rel) && fs.existsSync(r.abs));
const missing = references.filter((r) => !tracked.has(r.rel) && !fs.existsSync(r.abs));

// ───────────────────────────── 输出 ─────────────────────────────

if (GUIDE) {
  console.log('[check-source-assets-tracked] 正确做法：');
  console.log(`  ${GUIDE_TEXT}`);
  process.exit(0);
}

if (LIST) {
  console.log(`[check-source-assets-tracked] 源码引用的 .json 共 ${uniqueTargets.length} 个：`);
  for (const t of uniqueTargets) {
    const abs = path.join(REPO_ROOT, t);
    const mark = !fs.existsSync(abs) ? '缺失' : tracked.has(t) ? '已入库' : '未入库';
    console.log(`  [${mark}] ${t}`);
    for (const r of references.filter((x) => x.rel === t)) {
      console.log(`        ← ${r.importer}:${r.line}  (${r.spec})`);
    }
  }
  process.exit(untracked.length ? 1 : 0);
}

console.log('[check-source-assets-tracked] 源资产入库门禁');
console.log(`  扫描源码根：${SOURCE_ROOTS.map((r) => `${r}/**/src/**`).join(' , ')}`);
console.log(`  源码文件 ${sourceFiles.length} 个；发现 .json 引用 ${references.length} 处（去重目标 ${uniqueTargets.length} 个）`);

if (!gitOk) {
  console.error('[check-source-assets-tracked] FAIL: git 不可用（无法判定入库状态），拒绝静默通过。');
  console.error('  请在 git 工作区内运行；`git rev-parse --show-toplevel` 应成功。');
  process.exit(1);
}

// 缺失文件：import 断裂，仅告警（非本门禁判定范围，由 tsc / vitest 兜底）
if (missing.length) {
  console.log(`\n  [告警] ${missing.length} 处 import 指向的 .json 不存在（import 断裂，非「未入库」类缺陷）：`);
  for (const r of missing) {
    console.log(`    · ${r.rel}  ← ${r.importer}:${r.line}  (${r.spec})`);
  }
}

if (untracked.length === 0) {
  console.log(`  OK: 全部 ${uniqueTargets.length} 个被源码 import 的 .json 均已纳入版本控制（或为缺失告警）。`);
  process.exit(0);
}

console.error('\n[check-source-assets-tracked] FAIL: 以下被源码 import 的 .json 未被 git 跟踪：\n');
for (const r of untracked) {
  console.error(`  ▶ ${r.rel}`);
  console.error(`      引用点：${r.importer}:${r.line}  (${r.spec})`);
}
console.error('\n  正确做法：`node scripts/check-source-assets-tracked.mjs --guide`');
console.error('  根因多为 .gitignore 全局裸 `*.json` 误伤源码树，应加目录级放行。');
process.exit(1);
