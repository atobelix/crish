#!/usr/bin/env node
/**
 * check:store-writes —— raw setState 清零门禁（T-E 批次 5，03 方案步骤 4）。
 *
 * 扫描 apps/crish-desktop/src 下生产文件（排除 *.test.* / *.spec.*）的
 * `*Store.setState(` 调用点。允许面：
 *   - `src/store/` 目录（store 自身 action 定义 / 中间件 / index 重建等）；
 *   - `src/api/store-access/`（编排层，T11 域写分发点）；
 *   - `src/store/bootstrapStores.ts`（装配注入点）；
 *   - dev-only 分支（`import.meta.env.DEV` 包裹，dev 调试用）。
 *
 * 目标态：事件 handler → env.callbacks → layoutStore action → 写 store 单一通道，
 * 生产代码 `*Store.setState` 零残留（白名单外命中即失败）。
 *
 * 顺带断言：`bootstrapStores.ts` 含 `bindMessageSnapshotsOps` 调用
 * （快照桥注入点防线 ②，防 P0-1 再犯——注入点丢失即红）。
 *
 * Run: npm run check:store-writes
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(REPO_ROOT, 'apps', 'crish-desktop', 'src');

/** 全部受检 store 实例的 setState 调用形态 */
const STORE_SETSTATE_RE =
  /use(?:Layout|Session|Workspace|SettingsUi|Terminal|Settings|Worker|Permission)Store\.setState\s*\(/g;

/** 允许面目录（相对 SRC_DIR，posix 分隔） */
const ALLOWED_DIRS = [
  'store/', // store 自身 action 定义
  'api/store-access/', // 编排层
  'store/bootstrapStores.ts', // 装配注入点（目录前缀已含，此处仅文档化）
];

function toPosix(p) {
  return normalize(p).split(sep).join('/');
}

function isAllowed(relPosix) {
  return ALLOWED_DIRS.some((prefix) => relPosix.startsWith(prefix));
}

function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectFiles(full, out);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

let failed = false;
function fail(msg) {
  console.error(`[check:store-writes] ${msg}`);
  failed = true;
}

const files = collectFiles(SRC_DIR);
let violations = 0;

for (const abs of files) {
  const rel = toPosix(abs).replace(toPosix(SRC_DIR) + '/', '');
  // 测试 / 规格文件豁免（mock 替身属测试设施）
  if (/\.(test|spec)\.(ts|tsx)$/.test(rel)) continue;
  if (isAllowed(rel)) continue;

  const src = readFileSync(abs, 'utf8');
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!STORE_SETSTATE_RE.test(line)) continue;
    // dev-only 分支豁免：行首或行内含 import.meta.env.DEV 守卫
    const trimmed = line.trimStart();
    if (trimmed.startsWith('if (import.meta.env?.DEV') || trimmed.startsWith('if (import.meta.env.DEV')) {
      continue;
    }
    violations += 1;
    fail(`${rel}:${i + 1} raw \`*Store.setState\`（事件/组件面须改走 store action 或 api/store-access 编排）`);
    console.error(`  ${trimmed}`);
  }
}

// 快照桥注入点防线（P0-1）：bootstrapStores 必须装配 bindMessageSnapshotsOps
const bootstrapPath = join(SRC_DIR, 'store', 'bootstrapStores.ts');
if (!statSync(bootstrapPath).isFile()) {
  fail('missing src/store/bootstrapStores.ts');
} else {
  const bs = readFileSync(bootstrapPath, 'utf8');
  if (!/bindMessageSnapshotsOps\s*\(/.test(bs)) {
    fail('bootstrapStores.ts missing bindMessageSnapshotsOps call (快照桥注入点失联)');
  }
}

if (failed) {
  console.error(
    '[check:store-writes] FAIL: 生产代码 `*Store.setState` 应归零（白名单 = store/ 自身 + api/store-access/ + bootstrapStores + 测试 + dev-only）；事件写入必须走 layoutStore action 单一通道',
  );
  process.exit(1);
}

console.log(
  `[check:store-writes] OK — ${files.length} 生产文件扫描，白名单外 raw setState = ${violations}；bootstrapStores 快照桥注入点在案`,
);
