#!/usr/bin/env node
/**
 * scripts/check-ui-subpath-imports.mjs
 *
 * 门禁职责：
 * 守护 UI 组件库 Subpath Exports 与 internal/ 封装边界（E3-03 / PE-05）。
 *
 * 规则契约：
 * 1. 外部业务模块（apps/crish-desktop/src 下除 components/ui/ 以外的所有代码）：
 *    - 严禁直接跨层深路径引用 internal/*（如 @/components/ui/internal/* 或 ../ui/internal/*）；
 *    - 一律通过 @/components/ui 或 @/components/ui/<Component> / @/components/ui/icons 导入。
 * 2. 严禁外部穿透访问私有模块实现。
 *
 * 遵循 T-DEBT-08 五元规约（--guide）。
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, normalize, sep, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __debt08GuideFlag = process.argv.includes('--guide');
if (__debt08GuideFlag) {
  const guide = [
    '违反项：非 components/ui 业务模块直接导入 @/components/ui/internal/* 或相对路径 .../ui/internal/*。',
    '文件:行号 / 当前值：FAIL 逐条给出违规文件、行号与 import 说明符。',
    '阈值：0（严禁直接跨层深路径引用 @/components/ui/internal/*）。',
    '正确做法：通过 @/components/ui 或 @/components/ui/<Component> 标准导出导入；公共状态感知使用 @/components/ui 的 useIsModalActive / useFloatingActive / layerStackManager 等。',
    '复核：npm run check:ui-subpath-imports  # 期望 OK (0 违规)',
  ];
  console.log('[check-ui-subpath-imports] 正确做法 · 五元规约\n');
  for (const l of guide) console.log('  ' + l);
  process.exit(0);
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(REPO_ROOT, 'apps', 'crish-desktop', 'src');
const UI_DIR = join(SRC_DIR, 'components', 'ui');

function toPosix(p) {
  return normalize(p).split(sep).join('/');
}

function collectTsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      collectTsFiles(full, out);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const IMPORT_RE =
  /(?:import\s+(?:[^'"]*?\s+from\s+)?|require\s*\(\s*|import\s*\()\s*['"]([^'"]+)['"]/g;

const files = collectTsFiles(SRC_DIR).filter((file) => {
  const posix = toPosix(file);
  return !posix.includes('/components/ui/');
});

const violations = [];

for (const file of files) {
  const content = readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;
    IMPORT_RE.lastIndex = 0;
    while ((match = IMPORT_RE.exec(line)) !== null) {
      const specifier = match[1];

      // 1. 检查是否直接引用 internal
      let isInternalViolation = false;
      let reason = '';

      if (specifier.startsWith('@/components/ui/internal') || specifier === '@/components/ui/internal') {
        isInternalViolation = true;
        reason = `直接引用 @/components/ui/internal/* 私有内部实现`;
      } else if (specifier.startsWith('.')) {
        const resolved = resolve(dirname(file), specifier);
        const posixResolved = toPosix(resolved);
        const posixUiDir = toPosix(UI_DIR);
        if (posixResolved.startsWith(`${posixUiDir}/internal`) || posixResolved === `${posixUiDir}/internal`) {
          isInternalViolation = true;
          reason = `相对路径直接穿透引用 ui/internal/* 私有内部实现`;
        }
      }

      if (isInternalViolation) {
        const relPath = toPosix(relative(REPO_ROOT, file));
        violations.push({
          file: relPath,
          line: i + 1,
          specifier,
          reason,
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`[check:ui-subpath-imports] 发现 ${violations.length} 处非法 internal 穿透引用：`);
  for (const v of violations) {
    console.error(`  ✗ ${v.file}:${v.line} -> import "${v.specifier}" (${v.reason})`);
  }
  console.error('\n[check:ui-subpath-imports] 修复建议：');
  console.error('  严禁业务层直接跨层深路径引用 @/components/ui/internal/*！');
  console.error('  请将公共交互基元与感知 Hook 统一经由 @/components/ui 或 @/components/ui/<Component> 标准导出。');
  process.exit(1);
}

console.log(`[check:ui-subpath-imports] 通过：扫描 ${files.length} 个业务文件，0 违规，UI Subpath 与 internal 封装完备守门。`);
