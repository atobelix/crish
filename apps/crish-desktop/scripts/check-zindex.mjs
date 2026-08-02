#!/usr/bin/env node
/**
 * check:zindex —— z-index 双源一致性校验（PE-05 T05.5.3）
 *
 * 真源约定：styles/z-index.css（CSS 变量，运行期唯一真值）；
 * TS 侧 styles/tokens/zindex.ts 常量必须与之一致，禁止手改一端。
 *
 * 校验项：
 *  1. z-index.css 每个 --z-* 变量在 zindex.ts 中存在同名常量且值相等
 *  2. zindex.ts 每个 Z_* 常量在 z-index.css 中存在对应变量（防漏抄）
 *  3. tokens.css 不得再出现任何 --z-* 定义（防止第三源复活）
 *
 * 不一致时退出码 1，供 CI / npm run typecheck 同级检查链使用。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles');

function read(name) {
  return readFileSync(join(root, name), 'utf-8');
}

/** CSS 变量名 --z-xxx-yyy → TS 常量名 Z_XXX_YYY */
function cssToTsName(cssName) {
  return cssName
    .replace(/^--z-/, 'Z_')
    .replace(/-/g, '_')
    .toUpperCase();
}

function parseCssVars(css) {
  const map = new Map();
  const re = /--z-[a-z0-9-]+\s*:\s*([0-9]+)\s*;/g;
  for (const m of css.matchAll(re)) {
    const full = m[0].trim();
    const name = full.slice(0, full.indexOf(':')).trim();
    map.set(name, m[1]);
  }
  return map;
}

function parseTsConsts(ts) {
  const map = new Map();
  const re = /export\s+const\s+(Z_[A-Z0-9_]+)\s*=\s*([0-9]+)\s*;/g;
  for (const m of ts.matchAll(re)) {
    map.set(m[1], m[2]);
  }
  return map;
}

const cssVars = parseCssVars(read('z-index.css'));
const tsConsts = parseTsConsts(read('tokens/zindex.ts'));
const tokensCss = read('tokens.css');

const errors = [];

// 1) 每个 CSS 变量都有 TS 常量且值一致
for (const [cssName, cssValue] of cssVars) {
  const tsName = cssToTsName(cssName);
  const tsValue = tsConsts.get(tsName);
  if (tsValue === undefined) {
    errors.push(`z-index.css 变量 ${cssName} 在 zindex.ts 无对应常量 ${tsName}`);
  } else if (tsValue !== cssValue) {
    errors.push(`值不一致：z-index.css ${cssName}=${cssValue}，zindex.ts ${tsName}=${tsValue}`);
  }
}

// 2) 每个 TS 常量都有 CSS 变量（双向覆盖，防漏）
for (const [tsName, tsValue] of tsConsts) {
  const cssName = '--' + tsName.toLowerCase().replace(/_/g, '-');
  const cssValue = cssVars.get(cssName);
  if (cssValue === undefined) {
    errors.push(`zindex.ts 常量 ${tsName} 在 z-index.css 无对应变量 ${cssName}`);
  } else if (cssValue !== tsValue) {
    errors.push(`值不一致：zindex.ts ${tsName}=${tsValue}，z-index.css ${cssName}=${cssValue}`);
  }
}

// 3) tokens.css 不得含 z-index 变量（单源约束）
const tokensZ = [...tokensCss.matchAll(/--z-[a-z0-9-]+\s*:/g)].map((m) => m[0].trim().replace(/:$/, ''));
for (const name of tokensZ) {
  errors.push(`tokens.css 仍定义 ${name}（应统一在 z-index.css）`);
}

if (errors.length > 0) {
  console.error('[check:zindex] 校验失败：');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(
  `[check:zindex] 通过：z-index.css ${cssVars.size} 个变量 ↔ zindex.ts ${tsConsts.size} 个常量一致，tokens.css 无 --z-* 定义`,
);
