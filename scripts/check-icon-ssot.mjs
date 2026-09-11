#!/usr/bin/env node
/**
 * scripts/check-icon-ssot.mjs
 * 图标 SSOT 门禁：禁止业务直连 lucide-react / @hugeicons/*，强制经 AppIcon。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC = path.resolve(REPO_ROOT, 'apps/crish-desktop/src');
const ICONS_DIR = path.resolve(SRC, 'components/ui/icons');

const BAN = [
  /from\s*['"]lucide-react['"]/,
  /from\s*['"]@hugeicons\/core-free-icons['"]/,
  /from\s*['"]@hugeicons\/react['"]/,
];

const ALLOW = new Set([
  'components/ui/icons/AppIcon.tsx',
  'components/ui/icons/iconMap.ts',
  'components/ui/icons/index.ts',
  'components/ui/icons/customIcons.tsx',
  'components/ui/icons/iconTokens.ts',
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const errors = [];
for (const abs of walk(SRC)) {
  const rel = path.relative(SRC, abs).replace(/\\/g, '/');
  if (ALLOW.has(rel)) continue;
  const text = fs.readFileSync(abs, 'utf8');
  for (const re of BAN) {
    if (re.test(text)) {
      errors.push(`${rel}  直连图标库（应改用 AppIcon）: ${re}`);
    }
  }
}

if (errors.length) {
  console.error('❌ 图标 SSOT 门禁失败 (check-icon-ssot)\n');
  for (const e of errors) console.error('  - ' + e);
  console.error(`\n共 ${errors.length} 处。业务只能 import AppIcon from ui/icons。`);
  process.exit(1);
}
console.log('✅ 图标 SSOT 门禁通过');
