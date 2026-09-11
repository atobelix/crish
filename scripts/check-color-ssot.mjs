#!/usr/bin/env node
/**
 * scripts/check-color-ssot.mjs
 * 色彩宪法门禁：禁止业务硬编码颜色与假 token fallback。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC = path.resolve(REPO_ROOT, 'apps/crish-desktop/src');
const TOKENS = path.join(SRC, 'styles/tokens.css');

const ALLOW_PATHS = [
  'styles/tokens.css',
  'styles/__tests__/',
  'components/gallery/',
  'components/shell/WindowControls.module.css',
  'components/agent-card/agentCardUtils.ts',
  'components/sidebar/sidebarHelpers.ts',
  'main.tsx',
  'assets/icons/',
  'services/LoggerService.ts',
  'components/ui/icons/',
];

const L0_KEYS = new Set([
  '--surface-paper',
  '--surface-card',
  '--surface-elevated',
  '--surface-chrome',
  '--surface-sunken',
  '--surface-scrim',
  '--surface-overlay',
  '--surface-overlay-fg',
]);

function isAllowed(rel) {
  return ALLOW_PATHS.some((p) => rel === p || rel.startsWith(p));
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      walk(p, out);
    } else if (/\.(css|tsx|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

const errors = [];

// tokens.css L2 aliases must not assign raw colors
const tokensCss = stripComments(fs.readFileSync(TOKENS, 'utf8'));
const surfaceAssign = /(--(?:bg|surface)-[a-z0-9-]+)\s*:\s*([^;]+);/g;
let m;
while ((m = surfaceAssign.exec(tokensCss))) {
  const key = m[1];
  const val = m[2].trim();
  if (L0_KEYS.has(key)) continue;
  if (/^#|^hsl|^rgb|^oklch|^white|^black/i.test(val)) {
    errors.push(`tokens.css  L2/别名禁止独立取值: ${key}: ${val.slice(0, 48)}`);
  }
}

const fakeFallback =
  /var\(\s*--[a-z0-9-]+\s*,\s*(#[0-9a-fA-F]{3,8}|hsla?\(|rgba?\(|white|black)/i;
const hardProp = /(?:^|[;{\s])(background(?:-color)?|color)\s*:\s*([^;]+)/gi;

for (const abs of walk(SRC)) {
  const rel = path.relative(SRC, abs).replace(/\\/g, '/');
  if (isAllowed(rel)) continue;
  const text = stripComments(fs.readFileSync(abs, 'utf8'));

  if (!rel.endsWith('tokens.css')) {
    text.split('\n').forEach((line, i) => {
      if (fakeFallback.test(line)) {
        errors.push(`${rel}:${i + 1}  假 token fallback（禁止 var(--x, #hex)）`);
      }
    });
  }

  if (rel.endsWith('.css')) {
    let hm;
    while ((hm = hardProp.exec(text))) {
      const prop = hm[1].toLowerCase();
      const val = hm[2].trim();
      if (
        /transparent|none|inherit|currentColor|var\(--|color-mix\([^)]*var\(--/.test(val)
      ) {
        continue;
      }
      if (/^\s*(#|hsl|rgb|oklch|white|black)/i.test(val)) {
        errors.push(`${rel}  硬编码 ${prop}: ${val.slice(0, 52)}`);
      }
    }
  }
}

if (errors.length) {
  console.error('❌ 色彩 SSOT 门禁失败 (check-color-ssot)\n');
  for (const e of errors.slice(0, 80)) console.error('  - ' + e);
  if (errors.length > 80) console.error(`  … 另有 ${errors.length - 80} 处`);
  console.error(`\n共 ${errors.length} 处。请改用 tokens.css L1 语义 token。`);
  process.exit(1);
}
console.log('✅ 色彩 SSOT 门禁通过');
