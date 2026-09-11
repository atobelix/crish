#!/usr/bin/env node
/**
 * scripts/check-color-ssot.mjs
 * 色彩宪法门禁：拦截全属性硬编码颜色与假 Token fallback。
 * 覆盖属性：color, background, border, outline, fill, stroke, box-shadow
 * 拦截形态：裸 Hex、裸 RGB/RGBA、裸 HSL/HSLA、裸 OKLCH/LCH/HWB、假 token fallback (var(--x, #hex|rgba))
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
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
      walk(p, out);
    } else if (/\.(css|tsx|ts)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const errors = [];

// 1. tokens.css L2 别名与表面变量禁止独立取裸色
if (fs.existsSync(TOKENS)) {
  const tokensCss = stripComments(fs.readFileSync(TOKENS, 'utf8'));
  const surfaceAssign = /(--(?:bg|surface)-[a-z0-9-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = surfaceAssign.exec(tokensCss))) {
    const key = m[1];
    const val = m[2].trim();
    if (L0_KEYS.has(key)) continue;
    if (/^#|^hsl|^rgb|^oklch|^white|^black/i.test(val)) {
      errors.push({
        file: 'styles/tokens.css',
        line: 0,
        message: `tokens.css L2/别名禁止独立取值: ${key}: ${val.slice(0, 48)}`,
      });
    }
  }
}

// 2. 假 Token fallback 检测（支持多行/行级检测，禁止形如 var(--foo, #hex) 或 var(--shadow, rgba(...))）
const fakeFallbackRe =
  /var\(\s*--[a-zA-Z0-9_-]+\s*,\s*[^)]*?(#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|lch|hwb)\s*\(|\b(?:white|black)\b)/i;

// 3. 全属性匹配正则：color, background, border, outline, fill, stroke, box-shadow
const ALL_COLOR_PROPS_RE =
  /(?:^|[;{\s])((?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|block|inline))?(?:-color)?|outline(?:-color)?|fill|stroke|box-shadow))\s*:\s*([^;]+)/gi;

const BARE_HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const BARE_COLOR_FN_RE = /\b(?:rgba?|hsla?|oklch|lch|hwb)\s*\(/i;

for (const abs of walk(SRC)) {
  const rel = path.relative(SRC, abs).replace(/\\/g, '/');
  if (isAllowed(rel)) continue;

  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split('\n');

  // A. 静态逐行扫描 fake token fallback（CSS 与 TS/TSX 全覆盖）
  if (!rel.endsWith('tokens.css')) {
    lines.forEach((line, i) => {
      const cleanLine = line.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '');
      if (cleanLine.includes('ssot-color-ignore')) return;
      if (fakeFallbackRe.test(cleanLine)) {
        errors.push({
          file: rel,
          line: i + 1,
          message: `假 Token 兜底（禁止 var(--x, #hex|rgba|hsl)）：${cleanLine.trim().slice(0, 80)}`,
        });
      }
    });
  }

  // B. CSS 全属性硬编码颜色扫描
  if (rel.endsWith('.css')) {
    let ignoreNextLine = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('ssot-color-ignore')) {
        ignoreNextLine = true;
        continue;
      }
      if (ignoreNextLine) {
        ignoreNextLine = false;
        continue;
      }

      const cleanLine = line.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '');
      if (!cleanLine.trim()) continue;

      let hm;
      ALL_COLOR_PROPS_RE.lastIndex = 0;
      while ((hm = ALL_COLOR_PROPS_RE.exec(cleanLine))) {
        const prop = hm[1].toLowerCase();
        const val = hm[2].trim();

        // 检查是否包含裸色
        const hasHex = BARE_HEX_RE.test(val);
        const hasColorFn = BARE_COLOR_FN_RE.test(val);

        if (hasHex || hasColorFn) {
          errors.push({
            file: rel,
            line: i + 1,
            message: `硬编码 ${prop}: ${val.slice(0, 64)}`,
          });
        }
      }
    }
  }
}

if (errors.length) {
  console.error('[check-color-ssot] FAIL: 色彩宪法 SSOT 门禁拦截到硬编码颜色或假 Token 兜底：\n');
  for (const e of errors.slice(0, 80)) {
    const loc = e.line > 0 ? `${e.file}:${e.line}` : e.file;
    console.error(`  - ${loc}  ${e.message}`);
  }
  if (errors.length > 80) {
    console.error(`  ... 另有 ${errors.length - 80} 处`);
  }

  console.error(`\n共拦截到 ${errors.length} 处色彩违规。`);
  console.error('\n==================== 明确修复指引 ====================');
  console.error('1. 全属性拦截范围：color, background, border, outline, fill, stroke, box-shadow；');
  console.error('2. 禁止裸 Hex (#hex)、裸 rgb()/rgba()、裸 hsl()/hsla()、裸 oklch()；');
  console.error('3. 必须使用 apps/crish-desktop/src/styles/tokens.css 中定义的规范 Token：');
  console.error('   - 文本色：var(--text-primary), var(--text-secondary), var(--text-tertiary) 等；');
  console.error('   - 背景色：var(--bg-primary), var(--bg-card), var(--bg-elevated) 等；');
  console.error('   - 边框色：var(--border-color), var(--border-subtle), var(--hairline-strong) 等；');
  console.error('   - 阴影：var(--shadow-sm), var(--shadow-md), var(--shadow-lg), var(--shadow-2xl) 等；');
  console.error('4. 若使用 color-mix() 微调透明度，混色参数必须为合法 Token（如 var(--color-white)、var(--color-black) 或 transparent）；');
  console.error('5. 严禁假 Token 兜底（如 var(--foo, #hex)），请直接使用 var(--foo)；');
  console.error('6. 若确属色谱选择器等物理交互图元，在上方添加 /* ssot-color-ignore: <reason> */ 并说明理由。');
  console.error('======================================================');
  process.exit(1);
}

console.log('[check-color-ssot] OK: 色彩 SSOT 门禁通过（已全量覆盖 color, background, border, outline, fill, stroke, box-shadow）');
