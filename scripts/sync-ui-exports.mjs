#!/usr/bin/env node
/**
 * scripts/sync-ui-exports.mjs
 *
 * 自动化 UI 导出中枢与 package.json exports 同步器（借鉴 appica-ui 演进）
 *
 * 职责：
 * 1. 扫描 UI 包 src/ 下的白名单命名空间目录；
 * 2. 自动生成 packages/ui/src/index.ts 或 apps/crish-desktop/src/components/ui/index.ts（统一出口 Barrel）；
 * 3. 自动同步更新 packages/ui/package.json 中的 "exports" 映射（若存在独立包）；
 * 4. 严格隔离 internal/，物理禁止私有实现逃逸到外部；
 * 5. 支持 --check 标志位，接入 CI 门禁与 pre-commit。
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  writeSync,
  ftruncateSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

// 适配过渡期（若尚在 apps/crish-desktop 内）与抽取后（packages/ui）双阶段
const UI_PKG_DIR = existsSync(join(REPO_ROOT, 'packages', 'ui'))
  ? join(REPO_ROOT, 'packages', 'ui')
  : join(REPO_ROOT, 'apps', 'crish-desktop', 'src', 'components', 'ui');

const SRC_DIR = existsSync(join(UI_PKG_DIR, 'src')) ? join(UI_PKG_DIR, 'src') : UI_PKG_DIR;
const PKG_JSON_PATH = existsSync(join(UI_PKG_DIR, 'package.json'))
  ? join(UI_PKG_DIR, 'package.json')
  : null;
const BARREL_PATH = join(SRC_DIR, 'index.ts');

const BARREL_BANNER = `/**
 * @crish/ui 原子设计系统统一入口（Single Truth Barrel）
 *
 * [AUTO-GENERATED FILE] 本文件由 scripts/sync-ui-exports.mjs 自动生成。
 * 严禁手工编辑！新增组件或原语请遵循命名空间规范落盘，运行 \`npm run sync:ui-exports\` 自动同步。
 */\n\n`;

const ENTRY_FILE_RE = /\.(tsx?)$/;
const TEST_FILE_RE = /(\.test|\.spec)\.(tsx?)$/;
const PRIVATE_FILE_RE = /(^_|\.internal\.|\.helper\.)/;

// 非组件目录/文件（当处于无 components/ 子目录的过渡期扫描根目录时过滤）
const RESERVED_NAMES = new Set([
  'internal', 'icons', 'layer', 'layer-stack', 'primitives', 'hooks',
  'styles', 'utils', '__tests__', 'node_modules', 'dist',
  'index.ts', 'index.tsx', 'llms.txt', 'README.md', 'agent-rules.md',
  'SmartPanel', // SmartExpandablePanel 已包含 SmartPanel 完整能力并作为 SSOT 统一导出，避免 TS2308 命名冲突
]);

function safeWriteFileSync(filePath, content) {
  try {
    writeFileSync(filePath, content, 'utf8');
  } catch (err) {
    if (err.code === 'UNKNOWN' || err.errno === -4094) {
      if (!existsSync(filePath)) {
        const createFd = openSync(filePath, 'a');
        closeSync(createFd);
      }
      const fd = openSync(filePath, 'r+');
      ftruncateSync(fd, 0);
      writeSync(fd, content, 0, 'utf8');
      closeSync(fd);
      return;
    }
    throw err;
  }
}

function resolveEntry(baseDir, name) {
  const folder = join(baseDir, name);
  if (existsSync(folder) && statSync(folder).isDirectory()) {
    // 强制契约：组件目录必须通过显式 index.ts 控制公开导出表面（Opaque Exports）
    if (existsSync(join(folder, 'index.ts')) || existsSync(join(folder, 'index.tsx'))) {
      return `${name}/index`;
    }
    if (existsSync(join(folder, `${name}.tsx`)) || existsSync(join(folder, `${name}.ts`))) {
      return `${name}/${name}`;
    }
    // 兜底扫描首个非测试入口文件
    const children = readdirSync(folder);
    const match = children.find(c => new RegExp(`^${name}\\.(tsx?)$`, 'i').test(c) && !TEST_FILE_RE.test(c));
    if (match) return `${name}/${match.replace(ENTRY_FILE_RE, '')}`;
  }
  // 排除私有前缀文件（如 _private.ts 或 helper.internal.ts）
  if (PRIVATE_FILE_RE.test(name)) return null;
  if (existsSync(join(baseDir, `${name}.tsx`)) || existsSync(join(baseDir, `${name}.ts`))) {
    return name;
  }
  return null;
}

function listComponentEntries() {
  const hasSubComponents = existsSync(join(SRC_DIR, 'components'));
  const compDir = hasSubComponents ? join(SRC_DIR, 'components') : SRC_DIR;
  if (!existsSync(compDir)) return [];

  const entries = new Set();
  for (const item of readdirSync(compDir, { withFileTypes: true })) {
    if (item.name.startsWith('.') || item.name === 'internal') continue;
    if (!hasSubComponents && RESERVED_NAMES.has(item.name)) continue;
    if (PRIVATE_FILE_RE.test(item.name)) continue;
    if (item.isDirectory()) {
      if (item.name === '__tests__' || item.name === 'node_modules') continue;
      entries.add(item.name);
    } else if (item.isFile() && ENTRY_FILE_RE.test(item.name) && !TEST_FILE_RE.test(item.name)) {
      entries.add(item.name.replace(ENTRY_FILE_RE, ''));
    }
  }
  return [...entries]
    .map((name) => ({ name, importPath: resolveEntry(compDir, name) }))
    .filter((e) => e.importPath !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listNamespaceEntries(namespaceDir) {
  const dir = join(SRC_DIR, namespaceDir);
  if (!existsSync(dir)) return [];

  // 若命名空间本身带有统一出口 index.ts，以其作为唯一代表导出（Opaque Exports）
  if (existsSync(join(dir, 'index.ts')) || existsSync(join(dir, 'index.tsx'))) {
    return [{ name: namespaceDir, importPath: 'index' }];
  }

  const entries = new Set();
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.name === '__tests__' || item.name === 'internal' || item.name.startsWith('.')) continue;
    if (PRIVATE_FILE_RE.test(item.name)) continue;
    if (item.isDirectory()) {
      entries.add(item.name);
    } else if (item.isFile() && ENTRY_FILE_RE.test(item.name) && !TEST_FILE_RE.test(item.name)) {
      entries.add(item.name.replace(ENTRY_FILE_RE, ''));
    }
  }
  return [...entries]
    .map((name) => ({ name, importPath: resolveEntry(dir, name) }))
    .filter((e) => e.importPath !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const hasSubComponents = existsSync(join(SRC_DIR, 'components'));
const layerDir = existsSync(join(SRC_DIR, 'layer-stack'))
  ? 'layer-stack'
  : existsSync(join(SRC_DIR, 'layer'))
    ? 'layer'
    : null;

const NAMESPACES = [
  {
    dir: hasSubComponents ? 'components' : '',
    subpathPrefix: '',
    displayName: 'components',
    getEntries: () => listComponentEntries(),
  },
  {
    dir: 'icons',
    subpathPrefix: 'icons',
    displayName: 'icons',
    getEntries: () => listNamespaceEntries('icons'),
  },
  ...(layerDir ? [{
    dir: layerDir,
    subpathPrefix: 'layer-stack',
    displayName: 'layer-stack',
    getEntries: () => listNamespaceEntries(layerDir),
  }] : []),
  {
    dir: 'primitives',
    subpathPrefix: 'primitives/',
    displayName: 'primitives',
    getEntries: () => listNamespaceEntries('primitives'),
  },
  {
    dir: 'hooks',
    subpathPrefix: 'hooks/',
    displayName: 'hooks',
    getEntries: () => listNamespaceEntries('hooks'),
  },
  ...(existsSync(join(SRC_DIR, 'utils', 'cn.ts')) ? [{
    dir: 'utils',
    subpathPrefix: 'utils/',
    displayName: 'utils',
    getEntries: () => {
      const utilsList = [];
      if (existsSync(join(SRC_DIR, 'utils', 'cn.ts'))) utilsList.push({ name: 'cn', importPath: 'cn' });
      if (existsSync(join(SRC_DIR, 'utils', 'mergeRefs.ts'))) utilsList.push({ name: 'mergeRefs', importPath: 'mergeRefs' });
      if (existsSync(join(SRC_DIR, 'utils', 'modelAbbreviation.ts'))) utilsList.push({ name: 'modelAbbreviation', importPath: 'modelAbbreviation' });
      return utilsList;
    }
  }] : []),
];

function buildBarrel(namespaces) {
  const lines = [];
  for (const { dir, displayName, entries } of namespaces) {
    if (entries.length === 0) continue;
    lines.push(`// ─── Namespace: ${displayName || dir} (精准公开表面收敛) ───────────────────`);
    for (const { importPath } of entries) {
      const relPath = dir ? `./${dir}/${importPath}` : `./${importPath}`;
      lines.push(`export * from '${relPath}';`);
    }
    lines.push('');
  }
  return BARREL_BANNER + lines.join('\n').trim() + '\n';
}

function buildExportsMap(namespaces) {
  const exportsMap = {
    '.': {
      development: {
        types: './src/index.ts',
        import: './src/index.ts',
        default: './src/index.ts',
      },
      types: './dist/index.d.ts',
      import: './dist/index.js',
      default: './dist/index.js',
    },
    './styles.css': './dist/styles.css',
  };

  for (const { dir, subpathPrefix, entries } of namespaces) {
    // 命名空间整体入口（如 @crish/ui/icons, @crish/ui/layer-stack）
    if (subpathPrefix && !subpathPrefix.endsWith('/')) {
      exportsMap[`./${subpathPrefix}`] = {
        development: {
          types: `./src/${dir}/index.ts`,
          import: `./src/${dir}/index.ts`,
          default: `./src/${dir}/index.ts`,
        },
        types: `./dist/${dir}/index.d.ts`,
        import: `./dist/${dir}/index.js`,
        default: `./dist/${dir}/index.js`,
      };
    }

    for (const { name, importPath } of entries) {
      const subpath = subpathPrefix.endsWith('/')
        ? `./${subpathPrefix}${name}`
        : `./${name}`;
      exportsMap[subpath] = {
        development: {
          types: `./src/${dir}/${importPath}.ts`,
          import: `./src/${dir}/${importPath}.ts`,
          default: `./src/${dir}/${importPath}.ts`,
        },
        types: `./dist/${dir}/${importPath}.d.ts`,
        import: `./dist/${dir}/${importPath}.js`,
        default: `./dist/${dir}/${importPath}.js`,
      };
    }
  }

  exportsMap['./package.json'] = './package.json';
  return exportsMap;
}

export function syncUIExports(isCheck = false) {
  const collected = NAMESPACES.map((ns) => ({
    ...ns,
    entries: ns.getEntries(),
  }));

  const updates = [];

  // 1. 同步 Barrel (src/index.ts)
  const nextBarrel = buildBarrel(collected);
  const currentBarrel = existsSync(BARREL_PATH) ? readFileSync(BARREL_PATH, 'utf8') : '';
  if (currentBarrel.replace(/\r\n/g, '\n') !== nextBarrel.replace(/\r\n/g, '\n')) {
    if (!isCheck) {
      safeWriteFileSync(BARREL_PATH, nextBarrel);
    }
    updates.push(existsSync(join(REPO_ROOT, 'packages', 'ui')) ? 'packages/ui/src/index.ts' : 'apps/crish-desktop/src/components/ui/index.ts');
  }

  // 2. 同步 package.json exports (若存在独立包)
  if (PKG_JSON_PATH && existsSync(PKG_JSON_PATH)) {
    const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, 'utf8'));
    const nextExports = buildExportsMap(collected);
    if (JSON.stringify(pkg.exports) !== JSON.stringify(nextExports)) {
      if (!isCheck) {
        pkg.exports = nextExports;
        safeWriteFileSync(PKG_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n');
      }
      updates.push('package.json (exports)');
    }
  }

  const summary = collected.map((c) => `${c.displayName || c.dir}: ${c.entries.length}`).join(' | ');

  if (updates.length === 0) {
    console.log(`[sync-ui-exports] ✓ 导出契约完全同步 (${summary})`);
    return true;
  }

  if (isCheck) {
    console.error(`[sync-ui-exports] ✗ 导出契约脱节：${updates.join(', ')}。`);
    console.error(`[sync-ui-exports] 请立即执行 \`npm run sync:ui-exports\` 自动重新生成！`);
    return false;
  }

  console.log(`[sync-ui-exports] ✓ 自动更新生成：${updates.join(', ')} (${summary})`);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const checkMode = process.argv.includes('--check');
  const ok = syncUIExports(checkMode);
  if (!ok) process.exit(1);
}
