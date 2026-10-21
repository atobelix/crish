#!/usr/bin/env node
/**
 * scripts/check-line-counts.mjs
 * RL-03 Line Budgets 行数门禁（05 代码质量方案步骤② · 批次 7.3）。
 *
 * 三级语义（对齐 .agents/AGENTS.md 规则 1/3 与 05 方案步骤②）：
 * - ≥85% 上限 → 警告（仅报告，不阻断）；
 * - ≥100% 上限 → 违规（fail）；
 * - >650 行（任意类别）→ 硬阻断（fail；对类型契约类 800 行上限的补充——
 *   硬阻断阈值 = max(650, 上限)，类型契约档即 800 自身，30-reviews/02 P1-2 口径）；
 * - 叠加 per-file 基线机制（`基线记录/frontend-line-counts-baseline.md` 标记区）：
 *   有基线条目的文件以"基线值"为上限（存量冻结、增长必 fail、下降放行）；
 *   无条目的文件按声明上限严格执行（新文件零豁免）。
 *
 * 类别上限（有效代码行，注释/空行不计）：
 * - UI Components（.tsx / components/）：≤ 500
 * - Business Logic（.ts / hooks / store）：≤ 400
 * - Type Contracts（*.types.ts / *-types.ts / types/ 目录 / .d.ts）：≤ 800
 *   （分类正则已收敛为后缀匹配，避免 /types?/i 误命中 prototypes 类命名）
 *
 * 基线维护：
 * - `--update`：扫描并把"超过 85% 上限"的文件以实测行数写回标记区（存量登记、
 *   提升必须显式执行 + git diff 复核）；低于 85% 上限的文件条目自动移除（清零即
 *   进入全量生效）。
 *
 * Usage:
 *   node scripts/check-line-counts.mjs [path...]      # 指定目录/文件
 *   node scripts/check-line-counts.mjs --all          # 全量（apps/crish-desktop/src）
 *   node scripts/check-line-counts.mjs --update [--all] [--baseline <path>]
 */

import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── --guide（T-DEBT-08：正确做法指引 · 五元规约） ─────────────────────────────
// 用法：node scripts/check-line-counts.mjs --guide → 打印违反项/定位/阈值/正确做法。
// 仅在直接运行且带 --guide 时早退；不带 flag 时既有行为零变化。
const __debt08GuideFlag = process.argv.includes('--guide');
if (__debt08GuideFlag) {
  const __debt08Guide = [
    "违反项：前端文件行数达三级阈值——≥85% 上限（警告）、≥100% 上限（fail）、>650 行硬阻断；或基线文件行数增长。",
    "文件:行号 / 当前值：FAIL 输出文件、类别、上限、实测行数、占比。",
    "阈值：上限见 RL-03 类别表；>650 硬阻断（类型契约类 800）；基线条目 = 冻结上限（只许降）。",
    "正确做法：拆文件或登记 基线记录/frontend-line-counts-baseline.md（冻结上限，拆分按期执行）；禁止为过门禁切割空壳。",
    "复核：node scripts/check-line-counts.mjs  # 期望 OK",
  ];
  console.log('[check-line-counts] 正确做法 · 五元规约\n');
  for (const l of __debt08Guide) console.log('  ' + l);
  process.exit(0);
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TARGET_DIR = join(REPO_ROOT, 'apps', 'crish-desktop', 'src', 'components', 'chat-composer');
const FULL_SRC_DIR = join(REPO_ROOT, 'apps', 'crish-desktop', 'src');
const DEFAULT_BASELINE = join(
  REPO_ROOT,
  'docs/multi-agent-repair/基线记录/frontend-line-counts-baseline.md'
);
const START_MARKER = '<!-- BASELINE_START -->';
const END_MARKER = '<!-- BASELINE_END -->';
const HARD_BLOCK_LINE = 650;

function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const UPDATE = process.argv.includes('--update');
const baselinePath = argVal('--baseline')
  ? resolve(REPO_ROOT, argVal('--baseline'))
  : DEFAULT_BASELINE;

/**
 * Strips comments and blank lines to count effective code lines.
 */
function countEffectiveLines(content) {
  // Remove multiline comments /* ... */
  const noMultiLineComments = content.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = noMultiLineComments.split('\n');

  let count = 0;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('//')) continue;
    count++;
  }
  return count;
}

/** 绝对路径 → 相对仓库根的 posix 路径（大小写归一，Windows 安全） */
function toRepoRelative(filePath) {
  let p = String(filePath).replace(/\\/g, '/');
  const root = REPO_ROOT.replace(/\\/g, '/');
  if (p.toLowerCase().startsWith(root.toLowerCase())) p = p.slice(root.length);
  return p.replace(/^\/+/, '');
}

function classifyFile(filePath) {
  const posixPath = filePath.split(sep).join('/');
  const filename = posixPath.split('/').pop() || '';

  // Type contracts：后缀匹配（.d.ts / *.types.ts / *-types.ts / types/ 目录），
  // 收敛 30-reviews/02 P1-2 的 /types?/i 过宽正则（prototypes.ts 类命名误分类）。
  if (
    filename.endsWith('.d.ts') ||
    filename.endsWith('.types.ts') ||
    filename.endsWith('-types.ts') ||
    posixPath.includes('/types/')
  ) {
    return { category: 'Types Contract', limit: 800 };
  }

  // UI components
  if (
    filename.endsWith('.tsx') ||
    filename.endsWith('.jsx') ||
    posixPath.includes('/components/')
  ) {
    return { category: 'UI Component', limit: 500 };
  }

  // Business logic
  return { category: 'Business Logic', limit: 400 };
}

/** 解析基线标记区：`<相对路径> <有效行数>`；键小写化仅用于查表，路径保留原大小写供 git diff 复核 */
function parseBaseline(text) {
  const si = text.indexOf(START_MARKER);
  const ei = text.indexOf(END_MARKER);
  if (si < 0 || ei < 0 || ei <= si) return null;
  const items = new Map();
  for (const line of text.slice(si + START_MARKER.length, ei).split('\n')) {
    const m = line.match(/^\s*(\S+)\s+(\d+)\s*$/);
    if (m) items.set(m[1].toLowerCase(), { path: m[1], count: Number(m[2]) });
  }
  return items;
}

function collectSourceFiles(targetPath, out = []) {
  if (!existsSync(targetPath)) return out;
  const stat = statSync(targetPath);
  if (stat.isFile()) {
    if (
      /\.(ts|tsx|js|jsx|mts|cts)$/.test(targetPath) &&
      !/\.(test|spec)\.(ts|tsx|mts|cts)$/.test(targetPath)
    ) {
      out.push(targetPath);
    }
    return out;
  }

  try {
    const entries = readdirSync(targetPath);
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry === '__tests__') {
        continue;
      }
      const fullPath = join(targetPath, entry);
      const childStat = statSync(fullPath);
      if (childStat.isDirectory()) {
        collectSourceFiles(fullPath, out);
      } else if (
        /\.(ts|tsx|js|jsx|mts|cts)$/.test(entry) &&
        !/\.(test|spec)\.(ts|tsx|mts|cts)$/.test(entry)
      ) {
        out.push(fullPath);
      }
    }
  } catch (err) {
    console.error(`Error scanning path ${targetPath}:`, err.message);
  }
  return out;
}

/** 计算单个文件的行数状态（基线内 → 上限=基线值；硬阻断阈值 = max(650, 上限)） */
function computeStatus(effectiveLines, categoryLimit, baseEntry) {
  const limit = baseEntry !== undefined ? baseEntry : categoryLimit;
  const hardBlock = Math.max(HARD_BLOCK_LINE, limit);
  if (effectiveLines > hardBlock) return { status: 'hard-block', limit, hardBlock };
  if (effectiveLines > limit) return { status: 'violation', limit, hardBlock };
  if (baseEntry !== undefined) return { status: 'baselined', limit, hardBlock };
  if (effectiveLines > limit * 0.85) return { status: 'warning', limit, hardBlock };
  return { status: 'pass', limit, hardBlock };
}

function main() {
  const args = process.argv.slice(2);
  // 剔除门禁自身的旗标与取值，剩余视为扫描路径
  const skipNext = new Set(['--baseline']);
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--update' || a === '--all') continue;
    if (skipNext.has(a)) {
      i++;
      continue;
    }
    positional.push(a);
  }

  let scanPaths = [];

  if (args.includes('--all')) {
    scanPaths = [FULL_SRC_DIR];
  } else if (positional.length > 0) {
    scanPaths = positional.map((arg) => resolve(REPO_ROOT, arg));
  } else {
    scanPaths = [DEFAULT_TARGET_DIR];
  }

  console.log('[check-line-counts] Starting RL-03 Line Budget Verification...');
  console.log(`[check-line-counts] Target paths: ${scanPaths.map(p => p.replace(REPO_ROOT + sep, '')).join(', ')}`);
  console.log(`[check-line-counts] Baseline: ${toRepoRelative(baselinePath)}（--update 显式维护）`);

  const files = [];
  for (const p of scanPaths) {
    collectSourceFiles(p, files);
  }

  const baseline = existsSync(baselinePath)
    ? parseBaseline(readFileSync(baselinePath, 'utf8'))
    : null;

  let violationsCount = 0;
  let warningsCount = 0;
  let hardBlockCount = 0;
  let baselinedCount = 0;
  let scannedCount = 0;

  for (const filePath of files) {
    scannedCount++;
    const content = readFileSync(filePath, 'utf8');
    const effectiveLines = countEffectiveLines(content);
    const { category, limit: categoryLimit } = classifyFile(filePath);
    const relativePath = toRepoRelative(filePath);
    const baseEntry = baseline ? baseline.get(relativePath.toLowerCase()) : undefined;
    const baseCount = baseEntry ? baseEntry.count : undefined;
    const { status, limit, hardBlock } = computeStatus(effectiveLines, categoryLimit, baseCount);

    // 登记判定（与"无条目的文件按声明上限执行"一致）：仅超 85% 上限的文件需要基线保护
    // （登记/移除逻辑在 --update 分支统一按扫描面重算，此处仅输出状态）

    if (status === 'hard-block') {
      hardBlockCount++;
      console.error(
        `  ❌ [HARD BLOCK] ${relativePath}\n` +
        `     Category: ${category} | Effective Lines: ${effectiveLines} | 硬阻断: > ${hardBlock}（严重超标）`
      );
    } else if (status === 'violation') {
      violationsCount++;
      console.error(
        `  ❌ [VIOLATION] ${relativePath}\n` +
        `     Category: ${category} | Effective Lines: ${effectiveLines} | Budget: ≤ ${limit}`
      );
    } else if (status === 'baselined') {
      baselinedCount++;
      const reclaimed = effectiveLines <= categoryLimit ? '，已回落到类别上限内（--update 将移除条目）' : '';
      console.log(
        `  📦 [BASELINE] ${relativePath}\n` +
        `     Category: ${category} | Effective Lines: ${effectiveLines} | 基线: ${limit}（存量登记）${reclaimed}`
      );
    } else if (status === 'warning') {
      warningsCount++;
      console.warn(
        `  ⚠️ [WARNING] ${relativePath}\n` +
        `     Category: ${category} | Effective Lines: ${effectiveLines} | Budget: ≤ ${limit}`
      );
    } else {
      console.log(
        `  ✅ [PASS] ${relativePath} (${category}: ${effectiveLines}/${limit} lines)`
      );
    }
  }

  if (UPDATE) {
    // 保留扫描面外条目（原大小写路径），扫描面内以实测为准；按小写键去重，展示保留原大小写
    const merged = new Map();
    if (baseline) {
      for (const [key, entry] of baseline) merged.set(key, { path: entry.path, count: entry.count });
    }
    for (const filePath of files) {
      const rel = toRepoRelative(filePath);
      const lower = rel.toLowerCase();
      const content = readFileSync(filePath, 'utf8');
      const effectiveLines = countEffectiveLines(content);
      const { limit: categoryLimit } = classifyFile(filePath);
      if (effectiveLines > categoryLimit * 0.85) {
        merged.set(lower, { path: rel, count: effectiveLines });
      } else {
        merged.delete(lower);
      }
    }
    const lines = [...merged.entries()]
      .sort((a, b) => (a[1].path < b[1].path ? -1 : 1))
      .map(([, entry]) => `${entry.path} ${entry.count}`);
    const eol = existsSync(baselinePath)
      ? (readFileSync(baselinePath, 'utf8').includes('\r\n') ? '\r\n' : '\n')
      : '\n';
    const head = existsSync(baselinePath) ? readFileSync(baselinePath, 'utf8') : '';
    const si = head.indexOf(START_MARKER);
    const ei = head.indexOf(END_MARKER);
    const newText =
      si >= 0 && ei > si
        ? head.slice(0, si + START_MARKER.length) + eol + lines.join(eol) + eol + head.slice(ei)
        : head +
          (head.endsWith('\n') ? '' : '\n') +
          START_MARKER +
          '\n' +
          lines.join('\n') +
          '\n' +
          END_MARKER +
          '\n';
    writeFileSync(baselinePath, newText);
    console.log(`\n[check-line-counts] --update 完成：${lines.length} 个基线条目已写回（git diff 可复核）`);
    process.exit(0);
  }

  console.log(`\n[check-line-counts] Summary:`);
  console.log(`  Scanned: ${scannedCount} files`);
  console.log(`  Warnings: ${warningsCount}`);
  console.log(`  Violations: ${violationsCount}`);
  console.log(`  Hard blocks: ${hardBlockCount}`);
  console.log(`  Baselined (存量登记): ${baselinedCount}`);

  if (hardBlockCount > 0 || violationsCount > 0) {
    console.error('\n[check-line-counts] ❌ Line budget verification failed!');
    process.exit(1);
  }

  console.log('\n[check-line-counts] ✅ All scanned files passed RL-03 line budget checks!');
  process.exit(0);
}

main();
