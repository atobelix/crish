/**
 * R3-T11 layoutStore 拆分验收脚本。
 *
 * 检查：
 * 1. layoutStore 接口自声明 action 全量按域标注（无未标注/未知 action）
 * 2. 布局域 action 数 ≤ 8（T11 验收门禁）
 * 3. 4 个新域 store（terminal/worker/permission/settings）存在且各有独立 .test.ts
 * 4. 输出各新 store 的 action/字段统计（供报告引用）
 *
 * Run: node scripts/check-layoutstore-actions.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const storeDir = resolve(root, 'apps/crish-desktop/src/store');

/** 布局域 action → 域标注（T11 归类表 §1；新增布局 action 必须在此登记） */
const LAYOUT_ACTION_DOMAIN = {
  setUiSize: '布局/壳层UI',
  setShellChromeMode: '布局/壳层UI',
  setChatMainSurface: '布局/壳层UI',
  setSidebarCollapsed: '布局/壳层UI',
  setTabModeEnabled: '布局/壳层UI',
  setShowSettingsOverlay: '布局/设置浮层UI',
  setSettingsActiveTab: '布局/设置浮层UI',
  openSettings: '布局/设置浮层UI',
};

const MAX_LAYOUT_ACTIONS = 8;

const NEW_STORES = [
  { name: 'terminalStore', domain: '会话输出缓冲（terminal + diff）' },
  { name: 'workerStore', domain: 'worker' },
  { name: 'permissionStore', domain: '权限/plan' },
  { name: 'settingsStore', domain: '设置/遥测' },
];

let failed = false;

function fail(msg) {
  console.error(`[check-layoutstore-actions] FAIL: ${msg}`);
  failed = true;
}

/** 提取 `export interface X ... { ... }` 顶层块（首列闭合花括号为界） */
function extractInterface(src, name) {
  const marker = `export interface ${name}`;
  const start = src.indexOf(marker);
  if (start === -1) return null;
  const brace = src.indexOf('{', start);
  if (brace === -1) return null;
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(brace + 1, i);
    }
  }
  return null;
}

/** 提取接口块内的方法成员（`name: (` / `name: (` 跨行）与字段成员（`name: T;`） */
function extractMembers(block) {
  const methods = [];
  const fields = [];
  const lines = block.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^\s+([A-Za-z_$][\w$]*)\s*:\s*\(/);
    if (m) {
      methods.push(m[1]);
      i++;
      continue;
    }
    const f = line.match(/^\s+([A-Za-z_$][\w$]*)\s*:\s*[^;=]+;\s*$/);
    if (f) {
      fields.push(f[1]);
      i++;
      continue;
    }
    i++;
  }
  return { methods, fields };
}

// ── layoutStore 检查 ─────────────────────────────────────────────────────────
const layoutPath = resolve(storeDir, 'layoutStore.ts');
if (!existsSync(layoutPath)) {
  fail(`missing file: apps/crish-desktop/src/store/layoutStore.ts`);
} else {
  const src = readFileSync(layoutPath, 'utf8');
  const block = extractInterface(src, 'LayoutStore');
  if (block === null) {
    fail('cannot locate `export interface LayoutStore` block');
  } else {
    const { methods, fields } = extractMembers(block);
    const annotated = [];
    const unknown = [];
    for (const name of methods) {
      if (LAYOUT_ACTION_DOMAIN[name]) {
        annotated.push({ name, domain: LAYOUT_ACTION_DOMAIN[name] });
      } else {
        unknown.push(name);
      }
    }
    console.log('[check-layoutstore-actions] layoutStore 接口自声明 action:');
    for (const { name, domain } of annotated) {
      console.log(`  ✓ ${name}  →  ${domain}`);
    }
    if (methods.length === 0) {
      fail('layoutStore interface has no direct action members (parse issue?)');
    }
    if (unknown.length > 0) {
      fail(
        `layoutStore 存在未按域标注的 action（必须随拆分迁出或登记域）：${unknown.join(', ')}`
      );
    }
    if (annotated.length > MAX_LAYOUT_ACTIONS) {
      fail(
        `布局域 action 数 ${annotated.length} > ${MAX_LAYOUT_ACTIONS}（T11 门禁 ≤ ${MAX_LAYOUT_ACTIONS}）`
      );
    } else {
      console.log(
        `[check-layoutstore-actions] 布局域 action 数 = ${annotated.length}（≤ ${MAX_LAYOUT_ACTIONS} ✓）`
      );
    }
    console.log(`[check-layoutstore-actions] layoutStore 字段成员 = ${fields.length}`);
  }
}

// ── 新 store 存在性与测试文件 ────────────────────────────────────────────────
console.log('[check-layoutstore-actions] 新域 store:');
for (const { name, domain } of NEW_STORES) {
  const storePath = resolve(storeDir, `${name}.ts`);
  const testPath = resolve(storeDir, `${name}.test.ts`);
  if (!existsSync(storePath)) {
    fail(`missing store file: apps/crish-desktop/src/store/${name}.ts`);
    continue;
  }
  if (!existsSync(testPath)) {
    fail(`missing test file: apps/crish-desktop/src/store/${name}.test.ts`);
  }
  const src = readFileSync(storePath, 'utf8');
  const block = extractInterface(src, name[0].toUpperCase() + name.slice(1));
  let stats = { methods: 0, fields: 0 };
  if (block === null) {
    fail(`cannot locate interface in ${name}.ts`);
  } else {
    stats = extractMembers(block);
  }
  console.log(
    `  ✓ ${name}  [${domain}]  actions=${stats.methods}  fields=${stats.fields}  test=${existsSync(testPath) ? '✓' : '✗'}`
  );
}

if (failed) {
  console.error(
    '[check-layoutstore-actions] FAIL: 布局域 action 数 ≤ 8 且全量标注；4 个新 store 与其 .test.ts 必须存在。'
  );
  process.exit(1);
}

console.log(
  '[check-layoutstore-actions] OK — layoutStore 布局域 actions 全量标注且 ≤ 8；4 个新 store + 独立测试齐备。'
);
