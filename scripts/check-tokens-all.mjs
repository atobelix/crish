#!/usr/bin/env node
/**
 * scripts/check-tokens-all.mjs
 * Token 域门禁聚合入口（T14 接线收口）
 *
 * 为什么需要它：逐个跑门禁时，第一个 FAIL 会中断后续（`&&` 链），
 * 使用者看不到全貌，也无法一次性拿到全部「正确做法」指引。
 * 本入口**全部跑完再汇总**，并为每个失败项附上 `--guide` 提示。
 *
 * Run: node scripts/check-tokens-all.mjs [--json]
 */
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const JSON_OUT = process.argv.includes('--json');

/** Token 域门禁清单（顺序 = 由基础到细分；每项 [显示名, 脚本相对路径, 额外参数[]]） */
const GUARDS = [
  ['仓库完整性', 'scripts/check-repo-integrity.mjs', []],
  ['防御体系自审', 'scripts/check-guard-system.mjs', []],
  ['Token 一致性', 'scripts/check-token-consistency.mjs', []],
  ['真源唯一化', 'scripts/check-token-ssot.mjs', []],
  ['布局 Token 棘轮', 'scripts/check-layout-tokens.mjs', []],
  ['布局几何', 'scripts/check-layout-geometry.mjs', []],
  ['文字色 SSOT', 'scripts/check-text-color-tokens.mjs', []],
  ['色彩 SSOT', 'scripts/check-color-ssot.mjs', []],
  ['线性宽度 SSOT', 'scripts/check-line-width-ssot.mjs', []],
  ['图标 SSOT', 'scripts/check-icon-ssot.mjs', []],
  ['输入框四态', 'scripts/check-input-guardrails.mjs', []],
  ['Tooltip 卫生', 'scripts/check-tooltip-hygiene.mjs', []],
  ['Markdown 样式合规', 'scripts/check-markdown-style-compliance.mjs', []],
  ['CSS 编码', 'scripts/check-css-encoding.mjs', ['--whitelist-dirty-check']],
];

const results = [];
for (const [label, rel, extra] of GUARDS) {
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) {
    results.push({ label, rel, status: 'MISSING', code: null, out: '脚本不存在（接线清单与实现不一致）' });
    continue;
  }
  let code = 0;
  let out = '';
  try {
    out = execFileSync('node', [abs, ...extra], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : 1;
    out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim();
  }
  results.push({ label, rel, status: code === 0 ? 'PASS' : 'FAIL', code, out });
}

if (JSON_OUT) {
  console.log(JSON.stringify(results.map(({ label, rel, status, code }) => ({ label, rel, status, code })), null, 2));
} else {
  console.log('[check-tokens-all] Token 域门禁聚合结果\n');
  const w = Math.max(...results.map((r) => r.label.length));
  for (const r of results) {
    const mark = r.status === 'PASS' ? 'PASS' : r.status === 'FAIL' ? 'FAIL' : 'MISS';
    console.log(`  [${mark}] ${r.label.padEnd(w)}  ${r.rel}`);
  }
  const failed = results.filter((r) => r.status !== 'PASS');
  console.log('');
  if (failed.length === 0) {
    console.log('[check-tokens-all] OK: Token 域全部门禁通过');
  } else {
    console.log(`[check-tokens-all] ${failed.length} 项未通过。逐项正确做法：`);
    for (const r of failed) {
      console.log(`\n── ${r.label}（${r.rel}）──`);
      const tail = r.out.split('\n').filter((l) => l.trim()).slice(0, 12).join('\n');
      console.log(tail.split('\n').map((l) => `    ${l}`).join('\n'));
      const guideHint = r.out.match(/--guide\s+([a-z_]+)/g);
      if (guideHint) {
        for (const g of [...new Set(guideHint)]) {
          console.log(`    → 复现指引：node ${r.rel} ${g}`);
        }
      }
    }
    console.log('');
    console.log('  纪律：不得抬高棘轮基线掩盖；存量登记到 docs/token-consumption-unification/基线记录/gap-registry.md。');
  }
}

process.exit(results.some((r) => r.status !== 'PASS') ? 1 : 0);
