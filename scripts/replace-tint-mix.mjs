#!/usr/bin/env node
/**
 * 一次性工具：混色收敛替换（01-S2，批次 2.3）
 *
 * 只替换 `color-mix(in srgb, var(--text-primary) X%, transparent|var(--bg-primary))`
 * 形态的消费点（text-primary 基底），按 scripts/tint-map.json 档位映射表归位到 --tint-* token。
 *
 * 红线：
 *  - 默认 --dry-run，仅输出 diff 到 stdout；--apply 必须配合 --only <相对路径/目录> 使用，
 *    禁止整仓一次 --apply。
 *  - 行首 `--xxx:` 的 token 定义行不匹配；tokens.css / theme-dark.css / themeStore.ts 硬编码跳过。
 *  - 只动 color-mix(...) 表达式本身，不动选择器/属性名/其他值。
 *
 * 用法：
 *   node scripts/replace-tint-mix.mjs                 # dry-run 全仓
 *   node scripts/replace-tint-mix.mjs --only src/styles/shell
 *   node scripts/replace-tint-mix.mjs --only src/components/diff/DiffCard.module.css --apply
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', 'apps', 'crish-desktop');
const MAP = JSON.parse(
  readFileSync(new URL('./tint-map.json', import.meta.url), 'utf8')
);
const SKIP_FILES = new Set([
  'tokens.css',
  'theme-dark.css',
  'themeStore.ts',
  'style-contract.test.ts', // 断言内含混色字面量，防误替换
]);
const DEF_LINE_RE = /^\s*--[\w-]+\s*:/;
const MIX_RE =
  /color-mix\(in srgb, var\(--text-primary\) (\d+(?:\.\d+)?)%, (transparent|var\(--bg-primary\))\)/g;

const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const filesIdx = args.indexOf('--files');
const filesArg = filesIdx >= 0 ? args[filesIdx + 1] : null;
const apply = args.includes('--apply');
if (apply && !only && !filesArg) {
  console.error('红线：--apply 必须配合 --only 或 --files 使用，禁止整仓一次写盘');
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(css|tsx|ts)$/.test(entry)) out.push(p);
  }
  return out;
}

const all = walk(join(ROOT, 'src'));
const norm = (p) => relative(ROOT, p).replaceAll('\\', '/');
const fileSet = filesArg ? new Set(filesArg.split(',').map((s) => s.trim())) : null;
const target = fileSet
  ? all.filter((p) => fileSet.has(norm(p)))
  : only
    ? all.filter((p) => norm(p).startsWith(only.replaceAll('\\', '/')))
    : all;

let total = 0;
const perToken = new Map();
const perFile = new Map();

for (const file of target) {
  const base = file.split(/[\\/]/).pop();
  if (SKIP_FILES.has(base)) continue;
  const rel = norm(file);
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (DEF_LINE_RE.test(line)) continue;
    const replaced = line.replace(MIX_RE, (full, pct, baseMix) => {
      const token = MAP[pct];
      if (!token) return full;
      total += 1;
      perToken.set(token, (perToken.get(token) ?? 0) + 1);
      perFile.set(rel, (perFile.get(rel) ?? 0) + 1);
      return `var(${token})`;
    });
    if (replaced !== line) {
      changed = true;
      console.log(`${rel}:${i + 1}`);
      console.log(`- ${line.trim()}`);
      console.log(`+ ${replaced.trim()}`);
      lines[i] = replaced;
    }
  }
  if (changed && apply) {
    writeFileSync(file, lines.join('\n'), 'utf8');
  }
}

console.log('\n===== 汇总 =====');
console.log(`替换处数：${total}`);
console.log(
  '按 token：' +
    [...perToken.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
);
if (!apply) {
  console.log('（dry-run 未写盘；--apply 须配合 --only）');
}
