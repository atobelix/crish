#!/usr/bin/env node
/**
 * check:ui-layer — ui 原子层依赖门禁（PE-05 T05.1.1）
 *
 * 扫描 apps/crish-desktop/src/components/ui/ 下全部 ts/tsx 文件的 import，
 * 命中以下任一业务路径即失败（依赖规则见 components/ui/README.md）：
 *   - components/ 下除 ui/ 以外的一切目录（业务组件）
 *   - src/store/、src/hooks/、src/api/、src/services/
 *
 * 放行项：
 *   - react / react-dom / @radix-ui/* 等裸依赖
 *   - ui/ 目录内部相互 import（如 Tooltip → Dialog/useAnimatedPresence）
 *   - 测试文件的 @testing-library/* 等裸依赖
 *
 * 用法：npm run check:ui-layer；退出码 0 通过，1 违规。
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = join(REPO_ROOT, 'apps', 'crish-desktop', 'src', 'components', 'ui');
const SRC_DIR = join(REPO_ROOT, 'apps', 'crish-desktop', 'src');

const IMPORT_RE =
  /(?:import\s+(?:[^'"]*?\s+from\s+)?|require\s*\(\s*|import\s*\()\s*['"]([^'"]+)['"]/g;

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 递归收集目录下全部 ts/tsx 文件 */
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

/** 规范化路径为 '/' 分隔，便于跨平台模式匹配 */
function toPosix(p) {
  return normalize(p).split(sep).join('/');
}

/** 解析 import 说明符为绝对路径（相对/@ 别名）；裸依赖返回 null */
function resolveSpecifier(specifier, importerFile) {
  if (specifier.startsWith('.')) {
    return resolve(dirname(importerFile), specifier);
  }
  if (specifier.startsWith('@/')) {
    return join(SRC_DIR, specifier.slice(2));
  }
  return null;
}

/** 校验单个已解析路径是否命中禁止依赖 */
function violationOf(resolved, importerFile, specifier) {
  const p = toPosix(resolved);
  const srcMarker = '/src/';
  const srcIdx = p.lastIndexOf(srcMarker);
  const withinSrc = srcIdx >= 0 ? p.slice(srcIdx + srcMarker.length) : p;

  // components/ 下除 ui/ 以外的一切路径（业务组件）
  const compMatch = withinSrc.match(/^components\/([^/]+)/);
  if (compMatch && compMatch[1] !== 'ui') {
    return `禁止依赖业务组件目录 components/${compMatch[1]}/（import "${specifier}"）`;
  }

  // store / hooks / api / services 顶层业务目录
  for (const forbidden of ['store/', 'hooks/', 'api/', 'services/']) {
    if (withinSrc.startsWith(forbidden)) {
      return `禁止依赖业务模块 ${forbidden}（import "${specifier}"）`;
    }
  }
  return null;
}

function main() {
  if (!isFile(join(UI_DIR, 'index.ts'))) {
    console.error(`[check:ui-layer] 未找到 ui 原子层目录：${UI_DIR}`);
    process.exit(1);
  }

  const files = collectFiles(UI_DIR);
  const violations = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(IMPORT_RE)) {
      const specifier = match[1];
      // 样式/CSS 资源与本目录内部文件放行给后续解析判断
      const resolved = resolveSpecifier(specifier, file);
      if (!resolved) continue; // 裸依赖（react/@radix-ui/...）放行
      if (specifier.endsWith('.css')) continue; // CSS Modules 归属自身组件目录
      const violation = violationOf(resolved, file, specifier);
      if (violation) {
        violations.push(`${toPosix(file)} → ${violation}`);
      }
    }
  }

  if (violations.length > 0) {
    console.error('[check:ui-layer] 发现 ui 原子层违规依赖：');
    for (const v of violations) {
      console.error(`  ✗ ${v}`);
    }
    console.error('[check:ui-layer] 请将公共逻辑下沉到 ui/ 内部或抽共享 hook，勿从原子层反向依赖业务模块。');
    process.exit(1);
  }

  console.log(`[check:ui-layer] 通过：扫描 ${files.length} 个文件，无业务依赖违规。`);
}

main();
