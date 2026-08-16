#!/usr/bin/env node
/**
 * 收敛度量脚本（review.md §22 收敛度量表的可重复测量工具）
 *
 * 每轮执行前/后运行，产出基线数字，供收敛度量表填 Δ：
 *   1. 未接线/临时标记总数（文件数与标记行数）
 *   2. 波次/批次命名文件数（文件名/目录名含 w\d+[a-z]?[_-]、BATCH、Round、SD-\d+）
 *   3. 无日期 fallback/降级候选数（注释含 fallback/降级/临时/内存版 且同文件无日期上下文，仅候选提示）
 *   4. 被 git 跟踪的运行时产物（.db/.db-shm/.db-wal/.log/快照 json）
 *   5. 巨型源文件（>1500 行，生产代码与测试分开）
 *   6. 陪葬测试候选（文件名命中 w\d+|Strict|Skeleton|LocalStorage|RustDb|W6 等波次/轨命名）
 *
 * 用法：node scripts/check-convergence-metrics.mjs [--root <repoRoot>]
 * 依赖：rg（PATH 中可用）
 * 纪律：只读扫描，不修改任何文件；UTF-8 输出。
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv.includes('--root')
  ? path.resolve(process.argv[process.argv.indexOf('--root') + 1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EXCLUDE = [
  'node_modules/**', 'target/**', 'dist/**', 'build/**', 'reference/**',
  'docs/**', '.git/**', 'coverage/**', 'test-results/**', '.agent-outputs/**',
  '.agent-runtime/**', 'scratch/**', 'analysis/**', '.turbo/**',
];

function rg(args) {
  try {
    return execFileSync('rg', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

const globArgs = (exts) =>
  exts.flatMap((e) => ['-g', `*.${e}`]).concat(EXCLUDE.flatMap((e) => ['-g', `!${e}`]));

const srcExts = ['rs', 'ts', 'tsx', 'js', 'jsx', 'vue', 'css', 'html'];

const out = { root, scannedAt: new Date().toISOString(), metrics: {} };

// 1. 未接线/临时标记（同时报行数与 token 数两个口径，避免分母不一致）
const markerRe = '未接线|待接线|临时|TODO|FIXME|hack|占位|降级|workaround';
const markerFiles = rg(['-c', markerRe, '--no-messages', '--no-heading', ...globArgs(srcExts), root]);
let markerLines = 0;
let markerTokens = 0;
for (const l of markerFiles) {
  const m = l.match(/:(\d+)$/);
  if (m) markerLines += Number(m[1]);
  const path = l.replace(/:\d+$/, '');
  const hits = rg(['-o', markerRe, '--no-messages', '--no-heading', path]);
  markerTokens += hits.length;
}
out.metrics.marker = { files: markerFiles.length, lines: markerLines, tokens: markerTokens };

// 2. 波次/批次命名文件（只匹配 basename，避免目录子串误报；分隔符 . _ - 均可触发，
//    覆盖 chrome.w3f_dom.test.ts 中间位与 w5bStrict camelCase；_batch 领域词不误伤）
const waveRe = /(^|[._-])(w\d+[a-z]?[._-]|w\d+[a-z]+[A-Z]|BATCH[-_]|Round\d*[._-]|SD[-_]\d+[._-])/i;
const waveFiles = rg(['--files', '--no-messages', ...globArgs(srcExts), root])
  .map((f) => f.replaceAll('\\', '/'))
  .filter((f) => waveRe.test(f.split('/').pop()));
out.metrics.waveNamedFiles = {
  count: waveFiles.length,
  samples: waveFiles.slice(0, 30),
};

// 3. 无日期 fallback 候选（注释含降级/fallback/临时/内存版；只列候选，人工复核）
const fbRe = 'fallback|降级|备用路径|内存版|待接线|临时方案';
const fbHits = rg(['-n', fbRe, '--no-messages', '--no-heading', ...globArgs(srcExts), root])
  .filter((l) => !/删除日期|removal|expires|过期/.test(l))
  .slice(0, 60);
out.metrics.fallbackCandidates = {
  count: fbHits.length,
  samples: fbHits.slice(0, 20),
};

// 4. 被 git 跟踪的运行时产物（用 git ls-files，不能靠 rg --files）
const tracked = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(db|db-shm|db-wal|log|sqlite|sqlite3)$/.test(f) || /snapshot[^/]*\.json$/.test(f))
  .filter((f) => !f.startsWith('docs/') && !f.startsWith('reference/'));
out.metrics.trackedRuntimeArtifacts = {
  count: tracked.length,
  samples: tracked.slice(0, 20),
};

// 5. 巨型文件（>1500 行）
const big = rg(['-c', '', '--no-messages', '--no-heading', ...globArgs(srcExts), root])
  .map((l) => {
    const m = l.match(/^(.+):(\d+)$/);
    return m ? { path: m[1], lines: Number(m[2]) } : null;
  })
  .filter(Boolean)
  .filter((f) => f.lines > 1500)
  .sort((a, b) => b.lines - a.lines);
const isTest = (p) => /(test|spec|tests)[\\/._-]|_tests?\.rs|\.test\.|\.spec\./.test(p);
out.metrics.giantFiles = {
  production: big.filter((f) => !isTest(f.path)).slice(0, 20),
  test: big.filter((f) => isTest(f.path)).slice(0, 20),
  productionCount: big.filter((f) => !isTest(f.path)).length,
  testCount: big.filter((f) => isTest(f.path)).length,
};

// 6. 陪葬测试候选（波次/轨命名测试）
const graveRe = /(w\d+[a-z]?[_-]|Strict|Skeleton|LocalStorage|RustDb|W6|w[3456][a-z]?)/i;
const graveTests = rg(['--files', '--no-messages', ...globArgs(srcExts), root])
  .map((f) => f.replaceAll('\\', '/'))
  .filter((f) => /\.(test|spec)\.|_tests?\.rs|tests[\\/]/.test(f))
  .filter((f) => graveRe.test(f.split('/').pop()));
out.metrics.graveTestCandidates = {
  count: graveTests.length,
  samples: graveTests.slice(0, 30),
};

console.log(JSON.stringify(out, null, 2));
