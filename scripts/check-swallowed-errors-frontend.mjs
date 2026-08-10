#!/usr/bin/env node
/**
 * 前端吞错统计/基线脚本（05 代码质量方案步骤①③ · 批次 7.3）。
 *
 * 语义（镜像 scripts/check-swallowed-errors.mjs 的 Rust 侧惯例）：
 * - 统计全仓 TS/TSX 生产代码的"未注解空 catch"（规则口径与 eslint 本地规则
 *   local/no-silent-catch 完全一致——本脚本以 reportAll 模式复用同一规则计数，
 *   不另写扫描器，保证"本地过 CI 挂"零偏差）：
 *     1. 空 catch 块（无绑定 / 有绑定，body 无语句或仅 EmptyStatement）；
 *     2. Promise 链静默：`.catch(() => {})` / `.catch((e) => {})`（箭头/函数表达式空体）；
 *   - 注释豁免（阶段 A）：body 内有任意注释即视为已注解（不计数）；阶段 B
 *     （markerRequired）仅 `swallow-ok` marker 豁免——当前建线阶段为阶段 A。
 *   - 测试文件豁免（*.test.ts(x) / *.spec.ts / __tests__ / tests/ / test-utils，
 *     与 eslint 配置豁免面一致）。
 * - 与 `基线记录/frontend-swallowed-errors-baseline.md` 的 BASELINE_START/END
 *   标记区比对：任一文件计数 > 基线 → exit 1（新增吞错必须登记或消除）；
 *   存量下降 → exit 0（提示可显式 `--update` 刷新基线）。
 * - 门禁本体 = eslint 规则本身（lint:all / CI lint job 自动生效，零新增 job）；
 *   本脚本为统计/刷新通道（--report 便于 diff 观察趋势）。
 *
 * 用法：
 *   node scripts/check-swallowed-errors-frontend.mjs [--update] [--report]
 *        [--baseline <路径>] [--scope <glob>...]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASELINE = join(
  ROOT,
  'docs/multi-agent-repair/基线记录/frontend-swallowed-errors-baseline.md'
);
const START_MARKER = '<!-- BASELINE_START -->';
const END_MARKER = '<!-- BASELINE_END -->';

const UPDATE = process.argv.includes('--update');

function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const baselinePath = argVal('--baseline')
  ? resolve(ROOT, argVal('--baseline'))
  : DEFAULT_BASELINE;

const scopeArgs = process.argv
  .map((v, i) => (v === '--scope' ? process.argv[i + 1] : null))
  .filter(Boolean);
const scanGlobs = scopeArgs.length > 0 ? scopeArgs : ['**/*.{ts,tsx,cts,mts}'];

/** 绝对路径 → 相对仓库根的 posix 路径（与 eslint.config.js toRepoRelative 同口径） */
function toRepoRelative(absPath) {
  let p = String(absPath).replace(/\\/g, '/');
  const root = ROOT.replace(/\\/g, '/');
  if (p.toLowerCase().startsWith(root.toLowerCase())) p = p.slice(root.length);
  return p.replace(/^\/+/, '');
}

function parseBaseline(text) {
  const si = text.indexOf(START_MARKER);
  const ei = text.indexOf(END_MARKER);
  if (si < 0 || ei < 0 || ei <= si) return null;
  const items = new Map();
  for (const line of text.slice(si + START_MARKER.length, ei).split('\n')) {
    const m = line.match(/^\s*(\S+)\s+(\d+)\s*$/);
    if (m) items.set(m[1].toLowerCase(), Number(m[2]));
  }
  return items;
}

/** 以 reportAll 模式复用 eslint 规则计数：与门禁同口径的每文件未注解空 catch 数 */
async function collect() {
  const eslint = new ESLint({
    cwd: ROOT,
    // 不传 overrideConfigFile：eslint 自动发现根目录 eslint.config.js（flat config
    // 下 overrideConfigFile: true 会使配置文件失效，必须省略）。overrideConfig
    // 在仓库配置之后合并，reportAll 覆盖仅作用于 no-silent-catch 单条规则。
    overrideConfig: [
      {
        files: ['**/*.{ts,tsx,cts,mts}'],
        rules: {
          'local/no-silent-catch': ['error', { reportAll: true, baselineFile: baselinePath }],
        },
      },
      // 与 eslint.config.js 测试豁免面保持一致
      {
        files: [
          '**/*.test.ts',
          '**/*.test.tsx',
          '**/*.spec.ts',
          '**/__tests__/**',
          '**/tests/**',
          '**/packages/test-utils/**',
        ],
        rules: { 'local/no-silent-catch': 'off' },
      },
    ],
  });
  const results = await eslint.lintFiles(scanGlobs);
  const perFile = new Map();
  for (const result of results) {
    const count = result.messages.filter(
      (m) => m.ruleId === 'local/no-silent-catch' && !m.fatal
    ).length;
    if (count > 0) perFile.set(toRepoRelative(result.filePath), count);
  }
  return new Map([...perFile.entries()].sort());
}

const current = await collect();

if (UPDATE) {
  const lines = [...current.entries()].map(([rel, count]) => `${rel} ${count}`);
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
  console.log(
    `[check-swallowed-errors-frontend] --update 完成：${lines.length} 个文件已写入标记区（git diff 可复核）`
  );
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(`[check-swallowed-errors-frontend] FAIL: 基线文件不存在：${baselinePath}`);
  console.error('处置：先显式运行 `node scripts/check-swallowed-errors-frontend.mjs --update` 建立基线');
  process.exit(1);
}

const baseline = parseBaseline(readFileSync(baselinePath, 'utf8'));
if (!baseline) {
  console.error('[check-swallowed-errors-frontend] FAIL: 基线文件缺少 BASELINE_START/END 标记区');
  process.exit(1);
}

let failed = false;
const added = [];
const removed = [];
let totalCurrent = 0;
let totalBaseline = 0;
for (const [rel, count] of current) {
  const base = baseline.get(rel.toLowerCase()) ?? 0;
  totalCurrent += count;
  totalBaseline += base;
  const delta = count - base;
  if (delta > 0) added.push(`${rel} +${delta}（当前 ${count}，基线 ${base}）`);
  if (delta < 0) removed.push(`${rel} -${-delta}（当前 ${count}，基线 ${base}）`);
  console.log(
    `[check-swallowed-errors-frontend] ${rel.padEnd(78)} 未注解 ${String(count).padStart(3)}（基线 ${String(base).padStart(3)}）`
  );
}

console.log(
  `[check-swallowed-errors-frontend] 合计：未注解空 catch ${totalCurrent} 处（基线 ${totalBaseline} 处，覆盖 ${current.size} 个文件）`
);

if (added.length > 0) {
  failed = true;
  console.error(`[check-swallowed-errors-frontend] FAIL: 新增 ${added.length} 项（未注解空 catch 超基线）：`);
  for (const a of added) console.error(`  - ${a}`);
  console.error(
    '处置：新增静默必须消除或显式登记；若确属有意，运行 `node scripts/check-swallowed-errors-frontend.mjs --update` 刷新基线'
  );
}

if (failed) process.exit(1);

if (removed.length > 0) {
  console.log(
    `[check-swallowed-errors-frontend] OK: 存量下降 ${removed.length} 项（ratchet 允许下降；清理有意后可显式 \`--update\` 刷新基线）`
  );
} else {
  console.log('[check-swallowed-errors-frontend] OK: 各文件未注解空 catch 均在基线内（新增 0）');
}
