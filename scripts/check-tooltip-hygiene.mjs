#!/usr/bin/env node
/**
 * scripts/check-tooltip-hygiene.mjs
 * Tooltip 静态卫生与规范防御门禁脚本 (Tooltip Hygiene & Design Tokens Guardrail)
 *
 * 依据 docs/desktop-ui-systemic-repair/ 战役总方案与分维详案 04：
 * 1. 拦截原生 HTML title="..." 属性回潮（除 SVG <title> 标签外）：
 *    扫描 apps/crish-desktop/src 源码，严禁任何原生 JSX DOM 节点使用裸 title 属性（违反 AGENTS.md §12）；
 * 2. 拦截在 Tooltip 内部或样式文件中出现的裸 Hex / RGB 色值：
 *    检查 Tooltip 组件源码及样式（Tooltip.module.css 等），强制提示使用 Design Tokens；
 * 3. 检测典型的复读机式 Tooltip（同名文本包裹）：
 *    当 <Button>文本</Button> 或类似组件被 <Tooltip content="文本"> 包裹且两者文字相同时，报错阻断并给出优化指引；
 *
 * 校验通过输出绿色提示并 exit 0；违规时报错阻断并 exit 1。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── --guide（T-DEBT-08：正确做法指引 · 五元规约） ─────────────────────────────
// 用法：node scripts/check-tooltip-hygiene.mjs --guide → 打印违反项/定位/阈值/正确做法。
// 仅在直接运行且带 --guide 时早退；不带 flag 时既有行为零变化。
const __debt08GuideFlag = process.argv.includes('--guide');
if (__debt08GuideFlag) {
  const __debt08Guide = [
    "违反项：① 原生 HTML title=\"...\" 属性回潮（SVG <title> 标签除外）；② Tooltip 组件/样式内裸 Hex / RGB；③ 复读机式 Tooltip（同名文本包裹）。",
    "文件:行号 / 当前值：FAIL 逐条给出文件:行号。",
    "阈值：全部 0。",
    "正确做法：改用 Tooltip 组件 + design tokens；文案保持提示语义不与触发文本重复。",
    "复核：node scripts/check-tooltip-hygiene.mjs  # 期望 OK",
  ];
  console.log('[check-tooltip-hygiene] 正确做法 · 五元规约\n');
  for (const l of __debt08Guide) console.log('  ' + l);
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const DESKTOP_SRC = resolve(REPO_ROOT, 'apps/crish-desktop/src');
const TOOLTIP_DIR = resolve(DESKTOP_SRC, 'components/ui/Tooltip');

function toPosix(p) {
  return normalize(p).split(sep).join('/');
}

/** 递归收集指定目录下的 tsx / jsx 文件（排除测试文件及 __tests__） */
function collectJsxFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      collectJsxFiles(full, out);
    } else if (/\.(tsx|jsx)$/.test(entry.name)) {
      if (/\.(test|spec)\.(tsx|jsx)$/.test(entry.name)) continue;
      out.push(full);
    }
  }
  return out;
}

/** 剥离代码注释，避免注释内伪代码触发误报 */
function stripComments(code) {
  // 替换块注释与行注释为空格，保留换行符以保持行号对应
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) || []).length))
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * 规则 1：拦截原生 HTML title="..." 属性（除 SVG <title> 标签外）
 * 检查：小写开头的原生 HTML 标签（如 <button title="...">, <div title="...">, <span title="..."> 等）
 */
function checkNativeTitleAttributes(files, errors) {
  // 匹配小写开头的 HTML 标签，且含有 title="..." / title='...' / title={"..."} 属性
  // 排除标签名为 title 的情况（如 SVG <title>）
  const nativeTagTitleRegex = /<([a-z][a-z0-9-]*)\b(?:\s+[^>]*?)?\s+title\s*=\s*(?:"([^"]*)"|'([^']*)'|{\s*["'`]([^"'`]+)["'`]\s*})/g;

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const cleanContent = stripComments(content);
    const lines = content.split('\n');
    const rel = toPosix(relative(REPO_ROOT, file));

    let match;
    nativeTagTitleRegex.lastIndex = 0;
    while ((match = nativeTagTitleRegex.exec(cleanContent)) !== null) {
      const tag = match[1];
      if (tag === 'title') {
        // SVG 中的 <title> 标签是合法的子元素，放行
        continue;
      }

      const matchIndex = match.index;
      const lineNum = cleanContent.slice(0, matchIndex).split('\n').length;
      const lineText = (lines[lineNum - 1] || '').trim();
      const titleVal = match[2] || match[3] || match[4] || '';

      errors.push({
        file: rel,
        line: lineNum,
        type: '原生 HTML title 属性违规 (AGENTS.md §12)',
        snippet: lineText,
        message: `在原生 HTML <${tag}> 标签上检测到裸 title="${titleVal}" 属性。`,
        guidance: `AGENTS.md §12 严禁使用原生浏览器 title 悬停气泡。请改用项目中统一的自定义组件：\n       import { Tooltip } from '@/components/ui';\n       <Tooltip content="${titleVal}">\n         <${tag} ...>\n       </Tooltip>`,
      });
    }
  }
}

/**
 * 规则 2：拦截在 Tooltip 内部或样式文件中出现的裸 Hex / RGB 色值
 * 检查：Tooltip.module.css, Tooltip.tsx 等 Tooltip 原子组件核心文件
 */
function checkTooltipRawColors(errors) {
  if (!existsSync(TOOLTIP_DIR)) return;

  const targetFiles = [
    resolve(TOOLTIP_DIR, 'Tooltip.module.css'),
    resolve(TOOLTIP_DIR, 'Tooltip.tsx'),
    resolve(TOOLTIP_DIR, 'tooltipController.ts'),
    resolve(TOOLTIP_DIR, 'tooltipPositioning.ts'),
  ].filter((f) => existsSync(f));

  // 裸 Hex 颜色正则（如 #fff, #ffffff, #1a1a1a 等）
  const hexColorRegex = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
  // 裸 rgb/rgba 数值正则（排除包含 var(...) 的情况）
  const rgbColorRegex = /\brgba?\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+/g;

  for (const file of targetFiles) {
    const raw = readFileSync(file, 'utf8');
    const clean = stripComments(raw);
    const lines = raw.split('\n');
    const rel = toPosix(relative(REPO_ROOT, file));

    // 检查 Hex 色值
    let hexMatch;
    hexColorRegex.lastIndex = 0;
    while ((hexMatch = hexColorRegex.exec(clean)) !== null) {
      const lineNum = clean.slice(0, hexMatch.index).split('\n').length;
      const lineText = (lines[lineNum - 1] || '').trim();
      errors.push({
        file: rel,
        line: lineNum,
        type: 'Tooltip 裸色值违规 (Design Tokens SSOT)',
        snippet: lineText,
        message: `检测到硬编码 Hex 色值: '${hexMatch[0]}'`,
        guidance: `Tooltip 组件与样式必须 100% 遵从 Design Tokens（tokens.css）。\n       例如使用 var(--bg-elevated), var(--text-primary), var(--hairline-strong) 等，禁止裸写十六进制颜色。`,
      });
    }

    // 检查 RGB/RGBA 色值
    let rgbMatch;
    rgbColorRegex.lastIndex = 0;
    while ((rgbMatch = rgbColorRegex.exec(clean)) !== null) {
      const lineNum = clean.slice(0, rgbMatch.index).split('\n').length;
      const lineText = (lines[lineNum - 1] || '').trim();
      errors.push({
        file: rel,
        line: lineNum,
        type: 'Tooltip 裸色值违规 (Design Tokens SSOT)',
        snippet: lineText,
        message: `检测到硬编码 rgb/rgba 色值: '${rgbMatch[0]}...'`,
        guidance: `Tooltip 样式中禁止硬编码 rgba 颜色，请使用 Design Tokens 变量。`,
      });
    }
  }
}

/**
 * 规则 3：检测典型的复读机 Tooltip（如同名文本包裹）
 * 检查模式：<Tooltip content="ABC"> ... <Button/button/span/div...>ABC</...> ... </Tooltip>
 */
function checkParrotTooltips(files, errors) {
  // 匹配 <Tooltip content="X"> 内部紧随只有纯文本 X 的子组件
  const parrotRegex = /<Tooltip\b[^>]*\bcontent\s*=\s*(?:["']([^"']+)["']|\{["']([^"']+)["']\})[^>]*>\s*<([A-Za-z0-9_]+)\b[^>]*>\s*([^\s<]+(?:\s+[^\s<]+)*)\s*<\/\3>\s*<\/Tooltip>/g;

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const cleanContent = stripComments(content);
    const lines = content.split('\n');
    const rel = toPosix(relative(REPO_ROOT, file));

    let match;
    parrotRegex.lastIndex = 0;
    while ((match = parrotRegex.exec(cleanContent)) !== null) {
      const tipText = (match[1] || match[2] || '').trim();
      const childTag = match[3];
      const childText = (match[4] || '').trim();

      if (tipText && childText && tipText === childText) {
        const lineNum = cleanContent.slice(0, match.index).split('\n').length;
        const lineText = (lines[lineNum - 1] || '').trim();

        errors.push({
          file: rel,
          line: lineNum,
          type: '纯文字复读机式 Tooltip 违规 (UX Anti-Pattern)',
          snippet: lineText,
          message: `<Tooltip content="${tipText}"> 与内部 <${childTag}> 的可见文本 "${childText}" 100% 重复。`,
          guidance: `docs/desktop-ui-systemic-repair/03-分维详案 明确裁决：纯文字复读机坚决物理切除。\n       当按钮本身已显式渲染该文字时，悬停再出同名气泡会造成严重认知干扰，请直接移除外层 <Tooltip>。`,
        });
      }
    }
  }
}

function main() {
  const jsxFiles = collectJsxFiles(DESKTOP_SRC);
  const errors = [];

  checkNativeTitleAttributes(jsxFiles, errors);
  checkTooltipRawColors(errors);
  checkParrotTooltips(jsxFiles, errors);

  if (errors.length > 0) {
    console.error('\x1b[31m%s\x1b[0m', `✗ Tooltip hygiene check failed (${errors.length} violations found):\n`);
    for (const err of errors) {
      console.error(`  \x1b[33m${err.file}:${err.line}\x1b[0m - \x1b[31m[${err.type}]\x1b[0m`);
      console.error(`    问题: ${err.message}`);
      if (err.snippet) {
        console.error(`    代码: ${err.snippet}`);
      }
      console.error(`    指引: ${err.guidance}\n`);
    }
    process.exit(1);
  }

  console.log('\x1b[32m%s\x1b[0m', '✓ Tooltip hygiene check passed (0 violations)');
  console.log(`  - 扫描了 ${jsxFiles.length} 个 JSX/TSX 文件的原生 title 与复读机包裹`);
  console.log('  - 校验了 Tooltip 原子层组件与样式 Design Token 纯度');
}

main();
