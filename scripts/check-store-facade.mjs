#!/usr/bin/env node
// check:store-facade —— 组件直引 store 门禁（R-03 归 T-E，03 方案步骤 5）。
//
// 扫描 apps/crish-desktop/src/components 下全部 ts/tsx 文件（排除 *.test.* /
// *.spec.* 与 components/ui/——ui 原子层已由 check:ui-layer 禁入 store，
// 双门禁不重叠），import 说明符解析（相对路径 + @/ 别名 → src 内绝对路径）
// 后命中 src/store/ 前缀即命中检查面。
//
// 白名单（路径级，入口集合制）：
//   - src/store/index.ts（barrel——facade hook 合法入口）
//   - src/store/storeAccess.ts（T11 新域读面）
//   - src/store/types.ts（类型导入；类型-only 由 typecheck 把关）
//   - 组件私有 store 天然豁免（flowDagStore.ts / SlashExtension 内部 store 在
//     components/ 下，不匹配 store/ 前缀）
//
// 基线机制：--baseline 首次运行输出 scripts/components-store-direct-imports.json
// （文件 → import 行清单）作为计数基线（02-A2 迁移的度量工具）；普通模式报告
// 当前违规数 vs 基线数。02-A2 迁移逐域清零后基线文件删除（或置 0），CI 接线
// 以 0 违规为门槛。
//
// Run: npm run check:store-facade [--baseline]
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── --guide（T-DEBT-08：正确做法指引 · 五元规约） ─────────────────────────────
// 用法：node scripts/check-store-facade.mjs --guide → 打印违反项/定位/阈值/正确做法。
// 仅在直接运行且带 --guide 时早退；不带 flag 时既有行为零变化。
const __debt08GuideFlag = process.argv.includes('--guide');
if (__debt08GuideFlag) {
  const __debt08Guide = [
    "违反项：components 下 ts/tsx 直引 src/store/（import 解析后命中 store/ 前缀）。",
    "允许入口：src/store/index.ts（barrel）、src/store/storeAccess.ts（T11 域读面）、src/store/types.ts（类型-only）；components/ 下私有 store 天然豁免。",
    "文件:行号 / 当前值：FAIL 输出文件与 import 行清单；普通模式报当前违规数 vs 基线。",
    "阈值：向 0 违规收敛（02-A2 迁移完成后以 0 为 CI 门槛）。",
    "正确做法：组件改经 facade hook / storeAccess 消费；新增直引先问接口归属，不进白名单。",
    "复核：npm run check:store-facade  # 期望 OK",
  ];
  console.log('[check-store-facade] 正确做法 · 五元规约\n');
  for (const l of __debt08Guide) console.log('  ' + l);
  process.exit(0);
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPONENTS_DIR = join(REPO_ROOT, 'apps', 'crish-desktop', 'src', 'components');
const SRC_DIR = join(REPO_ROOT, 'apps', 'crish-desktop', 'src');
const BASELINE_FILE = join(REPO_ROOT, 'scripts', 'components-store-direct-imports.json');

const IMPORT_RE =
  /(?:import\s+(?:[^'"]*?\s+from\s+)?|require\s*\(\s*|import\s*\()\s*['"]([^'"]+)['"]/g;

function toPosix(p) {
  return normalize(p).split(sep).join('/');
}

function resolveSpecifier(specifier, importerFile) {
  if (specifier.startsWith('.')) {
    return resolve(dirname(importerFile), specifier);
  }
  if (specifier.startsWith('@/')) {
    return join(SRC_DIR, specifier.slice(2));
  }
  return null;
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

const STORE_PREFIX = toPosix(SRC_DIR) + '/store/';

/** 白名单（posix 绝对路径；import 解析可能带/不带扩展名） */
function isWhitelisted(abs) {
  const p = toPosix(abs);
  const stripExt = (x) => (/\.[a-z]+$/.test(x) ? x.replace(/\.[a-z]+$/, '') : x);
  const target = stripExt(p);
  const whitelist = [
    join(SRC_DIR, 'store', 'index'),
    join(SRC_DIR, 'store', 'storeAccess'),
    join(SRC_DIR, 'store', 'types'),
    // layout-tree 是纯几何/树模型域 barrel（无 zustand 状态），Dock 组件消费其
    // 纯函数与类型；仍禁止直引域内叶文件，统一经 barrel 收敛。
    join(SRC_DIR, 'store', 'layout-tree'),
    join(SRC_DIR, 'store', 'layout-tree', 'index'),
  ].map((x) => toPosix(x));
  return whitelist.includes(target);
}

function scan() {
  const violations = {}; // relFile → Array<{ line, importSpec, target }>
  const files = collectFiles(COMPONENTS_DIR);
  const srcPrefix = toPosix(SRC_DIR);

  for (const abs of files) {
    const rel = toPosix(abs).replace(srcPrefix + '/', '');
    if (/\.(test|spec)\.(ts|tsx)$/.test(rel)) continue;
    if (rel.startsWith('components/ui/')) continue; // ui 原子层由 check:ui-layer 管

    const src = readFileSync(abs, 'utf8');
    const matches = src.matchAll(IMPORT_RE);
    for (const m of matches) {
      // 全文扫描（兼容多行 import `import {\n ... \n} from '...'`）；
      // 行号 = match 起始位置前的换行数 + 1
      const line = src.slice(0, m.index).split(/\r?\n/).length;
      const spec = m[1];
      if (!spec || spec.startsWith('react') || spec.includes('@radix-ui')) continue;
      const resolved = resolveSpecifier(spec, abs);
      if (!resolved) continue;
      const resolvedPosix = toPosix(resolved);
      if (!resolvedPosix.startsWith(STORE_PREFIX)) continue;
      if (isWhitelisted(resolved)) continue;
      if (!violations[rel]) violations[rel] = [];
      violations[rel].push({
        line,
        importSpec: spec,
        target: resolvedPosix.replace(srcPrefix + '/', ''),
      });
    }
  }
  return { files: files.length, violations };
}

const { files, violations } = scan();
const count = Object.values(violations).reduce(
  (n, list) => n + list.length,
  0,
);

const baselineMode = process.argv.includes('--baseline');
if (baselineMode) {
  writeFileSync(BASELINE_FILE, JSON.stringify(violations, null, 2), 'utf8');
  console.log(
    `[check:store-facade] 基线已写入 scripts/components-store-direct-imports.json：${count} 处直引 / ${Object.keys(violations).length} 文件（${files} 组件文件扫描）。`,
  );
  console.log('  02-A2 迁移以此为度量：每批跑 `npm run check:store-facade` 核对递减；归零后删除基线文件并接 CI。');
  process.exit(0);
}

let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
} catch {
  /* 无基线文件：直接报告当前违规数 */
}

const baselineCount = Object.values(baseline).reduce(
  (n, list) => n + (Array.isArray(list) ? list.length : 0),
  0,
);

let failed = false;
if (count > 0) {
  failed = true;
  console.error(
    `[check:store-facade] FAIL — ${count} 处组件直引 src/store/（基线 ${baselineCount}）`,
  );
  for (const [rel, list] of Object.entries(violations)) {
    for (const v of list) {
      console.error(`  ${rel}:${v.line} import "${v.importSpec}" → ${v.target}`);
    }
  }
  console.error('  建议入口：store/index.ts（barrel facade hook）/ store/storeAccess.ts（域读面）/ store/types.ts（类型）');
} else if (baselineCount > 0) {
  console.log(
    `[check:store-facade] OK — 直引归零（基线 ${baselineCount} 已清零）；可删除基线文件并接 CI 快层。`,
  );
} else {
  console.log(
    `[check:store-facade] OK — ${files} 组件文件扫描，store 直引 = 0（含白名单放行）。`,
  );
}

process.exit(failed ? 1 : 0);
