#!/usr/bin/env node
/**
 * scripts/check-color-ssot.mjs
 * 色彩宪法门禁：拦截全属性硬编码颜色与假 Token fallback。
 * 覆盖属性：color, background, border, outline, fill, stroke, box-shadow 及组件私有 CSS 变量中的裸颜色
 * 拦截形态：裸 Hex、裸 RGB/RGBA、裸 HSL/HSLA、裸 OKLCH/OKLAB/LCH/LAB/HWB、假 token fallback (var(--x, #hex|rgba|hsl))
 * 物理图元豁免：支持语句级 ssot-color-ignore: <reason> 与块级 ssot-color-ignore-start ... ssot-color-ignore-end
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── --guide（T-DEBT-08：正确做法指引 · 五元规约） ─────────────────────────────
// 用法：node scripts/check-color-ssot.mjs --guide → 打印违反项/定位/阈值/正确做法。
// 仅在直接运行且带 --guide 时早退；不带 flag 时既有行为零变化。
const __debt08GuideFlag = process.argv.includes('--guide');
if (__debt08GuideFlag) {
  const __debt08Guide = [
    "违反项：全属性硬编码颜色（裸 Hex / RGB / RGBA / HSL / HSLA / OKLCH / OKLAB / LCH / LAB / HWB）或假 token fallback（var(--x, #hex|rgba|hsl)）。",
    "覆盖属性：color, background, border, outline, fill, stroke, box-shadow，以及组件内部私有 CSS 变量。",
    "文件:行号 / 当前值：FAIL 逐条给出文件:行号与命中文本；当前值 = 命中数。",
    "阈值：0（严格零容忍，物理图元经规约注释豁免）。",
    "正确做法：",
    "  1. 消费 tokens.css / tokens-*.css 中定义的语义 Design Tokens；",
    "  2. 禁止在 var(--token, fallback) 中书写任何颜色兜底，直接使用纯净的 var(--token)；",
    "  3. 若确属专业取色器、调色板等底层物理图元，添加规范注释豁免：",
    "     - 单条语句：/* ssot-color-ignore: <物理交互图元说明> */（支持多行属性自动跟随至语句分号结束）",
    "     - 多行区块：/* ssot-color-ignore-start: <说明> */ ... /* ssot-color-ignore-end */",
    "复核：node scripts/check-color-ssot.mjs  # 期望 OK",
  ];
  console.log('[check-color-ssot] 正确做法 · 五元规约\n');
  for (const l of __debt08Guide) console.log('  ' + l);
  process.exit(0);
}

const SHOW_ALL = process.argv.includes('--list') || process.argv.includes('--all');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC = path.resolve(REPO_ROOT, 'apps/crish-desktop/src');
const TOKENS_FILES = [
  path.join(SRC, 'styles/tokens.css'),
  path.join(SRC, 'styles/tokens-surface.css'),
];

const ALLOW_PATHS = [
  'styles/tokens',
  'styles/__tests__/',
  'styles/a11y-contrast.test.ts',
  'components/gallery/',
  'components/shell/WindowControls.module.css',
  'components/agent-card/agentCardUtils.ts',
  'components/sidebar/sidebarHelpers.ts',
  'main.tsx',
  'assets/icons/',
  'services/LoggerService.ts',
  'components/ui/icons/',
];

/** L0 基础地表面与原生透明遮罩，允许在 tokens-surface.css 中独立声明原始物理值 */
const L0_KEYS = new Set([
  '--surface-base-default',
  '--surface-sunken',
  '--surface-canvas',
  '--surface-shell',
  '--surface-card',
  '--surface-raised',
  '--surface-overlay',
  '--surface-outer',
  '--surface-main',
  '--surface-input',
  '--surface-paper',
  '--surface-elevated',
  '--surface-chrome',
  '--surface-scrim',
  '--surface-overlay-fg',
  '--surface-translucent',
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

// 1. tokens.css / tokens-surface.css L2 别名与表面变量禁止独立取裸色
for (const tokenFile of TOKENS_FILES) {
  if (!fs.existsSync(tokenFile)) continue;
  const tokensCss = stripComments(fs.readFileSync(tokenFile, 'utf8'));
  const surfaceAssign = /(--(?:bg|surface)-[a-z0-9-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = surfaceAssign.exec(tokensCss))) {
    const key = m[1];
    const val = m[2].trim();
    if (L0_KEYS.has(key)) continue;
    if (/^#|^hsl|^rgb|^oklch|^oklab|^lch|^lab|^white|^black/i.test(val)) {
      errors.push({
        file: path.relative(SRC, tokenFile).replace(/\\/g, '/'),
        line: 0,
        type: 'token-l2',
        message: `tokens L2/别名禁止独立取值: ${key}: ${val.slice(0, 48)}`,
      });
    }
  }
}

// 颜色特征匹配正则
const BARE_HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const BARE_COLOR_FN_RE = /\b(?:rgba?|hsla?|oklch|oklab|lch|lab|hwb)\s*\(/i;
const COLOR_KEYWORDS_RE = /\b(?:white|black)\b/i;
const NAMED_COLORS_RE = /\b(?:red|blue|green|yellow|orange|purple|cyan|magenta)\b/i;

function containsColorValue(str) {
  if (!str) return false;
  return (
    BARE_HEX_RE.test(str) ||
    BARE_COLOR_FN_RE.test(str) ||
    COLOR_KEYWORDS_RE.test(str) ||
    NAMED_COLORS_RE.test(str)
  );
}

/**
 * 构建文件行级忽略掩码（支持语句级与块级豁免）
 * @param {string[]} lines 文件原始行数组
 * @param {boolean} isCss 是否为 CSS 文件
 * @returns {boolean[]} 每行是否被忽略
 */
function buildIgnoreMask(lines, isCss) {
  const mask = new Array(lines.length).fill(false);
  let inBlock = false;
  let inStatement = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];

    // 块级忽略
    if (rawLine.includes('ssot-color-ignore-start')) {
      inBlock = true;
      mask[i] = true;
      continue;
    }
    if (rawLine.includes('ssot-color-ignore-end')) {
      inBlock = false;
      mask[i] = true;
      continue;
    }
    if (inBlock) {
      mask[i] = true;
      continue;
    }

    // 语句级忽略注释
    if (rawLine.includes('ssot-color-ignore')) {
      inStatement = true;
      mask[i] = true;
    } else if (inStatement) {
      mask[i] = true;
    }

    // 判定语句终止：移除注释后检查终止符
    if (inStatement) {
      const codePart = rawLine.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '').trim();
      const terminates = isCss
        ? codePart.includes(';') || codePart.includes('}')
        : codePart.includes(';') || codePart.includes(',') || codePart.includes('}');
      if (terminates) {
        inStatement = false;
      }
    }
  }

  return mask;
}

/**
 * 健壮扫描假 Token 兜底（支持跨行、嵌套括号配平）
 */
function scanFakeFallbacks(content, lines, ignoreMask, rel) {
  const varPattern = /\bvar\s*\(/g;
  let match;

  while ((match = varPattern.exec(content)) !== null) {
    const startIndex = match.index;
    const lineNumber = content.slice(0, startIndex).split('\n').length;
    if (ignoreMask[lineNumber - 1]) continue;

    // 配平括号提取完整 var(...)
    let depth = 1;
    let i = startIndex + match[0].length;
    let inQuote = null;

    while (i < content.length && depth > 0) {
      const ch = content[i];
      if (inQuote) {
        if (ch === inQuote && content[i - 1] !== '\\') inQuote = null;
      } else if (ch === "'" || ch === '"' || ch === '`') {
        inQuote = ch;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
      }
      i++;
    }

    if (depth !== 0) continue;

    const fullVar = content.slice(startIndex, i);
    // 检查是否存在顶层逗号
    let commaIndex = -1;
    let parenLevel = 0;
    let quote = null;

    for (let j = match[0].length; j < fullVar.length - 1; j++) {
      const c = fullVar[j];
      if (quote) {
        if (c === quote && fullVar[j - 1] !== '\\') quote = null;
      } else if (c === "'" || c === '"' || c === '`') {
        quote = c;
      } else if (c === '(') {
        parenLevel++;
      } else if (c === ')') {
        parenLevel--;
      } else if (c === ',' && parenLevel === 0) {
        commaIndex = j;
        break;
      }
    }

    if (commaIndex === -1) continue; // 无 fallback

    const varName = fullVar.slice(match[0].length, commaIndex).trim();
    if (!varName.startsWith('--')) continue; // 非 CSS Token

    const fallback = fullVar.slice(commaIndex + 1, -1).trim();

    // 检查 fallback 是否包含硬编码色彩
    if (containsColorValue(fallback)) {
      const compactSnippet = fullVar.replace(/\s+/g, ' ').slice(0, 80);
      errors.push({
        file: rel,
        line: lineNumber,
        type: 'fake-fallback',
        message: `假 Token 兜底（禁止 var(--x, #hex|rgba|hsl)）：${compactSnippet}`,
      });
    }
  }
}

/**
 * 健壮扫描 CSS 全属性硬编码颜色（支持多行属性值解析）
 */
const COLOR_DECLARATION_RE =
  /(?:^|[;{\s])((?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|block|inline))?(?:-color)?|outline(?:-color)?|fill|stroke|box-shadow|--[a-zA-Z0-9_-]+))\s*:\s*([^;{}]+)/gi;

function scanCssHardcodedColors(content, lines, ignoreMask, rel) {
  let m;
  COLOR_DECLARATION_RE.lastIndex = 0;

  while ((m = COLOR_DECLARATION_RE.exec(content)) !== null) {
    const prop = m[1].toLowerCase();
    const val = m[2].trim();
    const startIndex = m.index;
    const lineNumber = content.slice(0, startIndex).split('\n').length;

    if (ignoreMask[lineNumber - 1]) continue;

    // 自定义变量检测
    if (prop.startsWith('--')) {
      const hasBareColor = BARE_HEX_RE.test(val) || BARE_COLOR_FN_RE.test(val);
      if (hasBareColor) {
        const compactVal = val.replace(/\s+/g, ' ').slice(0, 64);
        errors.push({
          file: rel,
          line: lineNumber,
          type: 'hardcoded',
          message: `硬编码变量 ${prop}: ${compactVal}`,
        });
      }
      continue;
    }

    const hasHex = BARE_HEX_RE.test(val);
    const hasColorFn = BARE_COLOR_FN_RE.test(val);

    if (hasHex || hasColorFn) {
      const compactVal = val.replace(/\s+/g, ' ').slice(0, 64);
      errors.push({
        file: rel,
        line: lineNumber,
        type: 'hardcoded',
        message: `硬编码 ${prop}: ${compactVal}`,
      });
    }
  }
}

function stripCommentsPreserveLayout(text) {
  // 将块注释替换为等长空格（保留 \n），确保字符索引与行号 100% 对应
  let result = text.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    return match.replace(/[^\n]/g, ' ');
  });
  // 将行注释替换为等长空格（保留 \n）
  result = result.replace(/\/\/.*$/gm, (match) => {
    return match.replace(/[^\n]/g, ' ');
  });
  return result;
}

// 遍历扫描所有文件
for (const abs of walk(SRC)) {
  const rel = path.relative(SRC, abs).replace(/\\/g, '/');
  if (isAllowed(rel)) continue;

  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split('\n');
  const isCss = rel.endsWith('.css');
  const ignoreMask = buildIgnoreMask(lines, isCss);
  const cleanContent = stripCommentsPreserveLayout(raw);

  // A. 静态扫描 fake token fallback（CSS 与 TS/TSX 全覆盖，支持多行与嵌套）
  if (!rel.endsWith('tokens.css')) {
    scanFakeFallbacks(cleanContent, lines, ignoreMask, rel);
  }

  // B. CSS 全属性硬编码颜色扫描（支持多行声明与属性块）
  if (isCss) {
    scanCssHardcodedColors(cleanContent, lines, ignoreMask, rel);
  }
}

// 门禁判定与输出
if (errors.length) {
  console.error('[check-color-ssot] FAIL: 色彩宪法 SSOT 门禁拦截到硬编码颜色或假 Token 兜底：\n');

  const displayList = SHOW_ALL ? errors : errors.slice(0, 80);
  for (const e of displayList) {
    const loc = e.line > 0 ? `${e.file}:${e.line}` : e.file;
    console.error(`  - ${loc}  ${e.message}`);
  }
  if (!SHOW_ALL && errors.length > 80) {
    console.error(`  ... 另有 ${errors.length - 80} 处（使用 --list 查看全量明细）`);
  }

  // 统计分类
  const fakeFallbackCount = errors.filter((e) => e.type === 'fake-fallback').length;
  const hardcodedCount = errors.filter((e) => e.type === 'hardcoded').length;
  const tokenL2Count = errors.filter((e) => e.type === 'token-l2').length;

  console.error(`\n共拦截到 ${errors.length} 处色彩违规：`);
  console.error(`  - 假 Token 兜底：${fakeFallbackCount} 处`);
  console.error(`  - 裸色硬编码：${hardcodedCount} 处`);
  if (tokenL2Count > 0) {
    console.error(`  - Token L2 违规赋值：${tokenL2Count} 处`);
  }

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

console.log('[check-color-ssot] OK: 色彩 SSOT 门禁通过（已全量覆盖 color, background, border, outline, fill, stroke, box-shadow，0 裸色，0 假兜底）');
