#!/usr/bin/env node
/**
 * scripts/check-layout-geometry.mjs
 * 顶栏布局几何与 Token 契约防御门禁脚本 (Layout Geometry & Token Contract Guardrail)
 *
 * 依据 docs/desktop-ui-systemic-repair/ 战役总方案与分维详案 04：
 * 1. 顶栏单轨同层高度校验：
 *    - 检查 AppTopBar.module.css 中 .topBar 的 height / min-height / max-height
 *      必须严格等于 var(--header-height, 36px) 或 var(--header-height) 或 36px，
 *      严禁多层顶栏或双重高度；
 *    - 检查 AppTopBar.module.css 中 .topBar 必须为浮层（position: absolute），
 *      严禁回潮为挤占垂直文档流的常规块；
 * 2. 避让体系 Token 引用校验：
 *    - 检查 PaneHeader.module.css 必须包含基于 [data-top-row="true"][data-right-edge="true"]
 *      对 var(--edge-reserve-right-win) 的避让声明，严禁物理缺失避让或裸写像素；
 *    - 检查包含对 var(--edge-reserve-right-macos) 的 macOS 避让声明；
 *
 * 校验通过输出绿色提示并 exit 0；违规时报错阻断并 exit 1。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── --guide（T-DEBT-08：正确做法指引 · 五元规约） ─────────────────────────────
// 用法：node scripts/check-layout-geometry.mjs --guide → 打印违反项/定位/阈值/正确做法。
// 仅在直接运行且带 --guide 时早退；不带 flag 时既有行为零变化。
const __debt08GuideFlag = process.argv.includes('--guide');
if (__debt08GuideFlag) {
  const __debt08Guide = [
    "违反项：顶栏布局几何/Token 契约破坏——.topBar 高度不等于 var(--header-height, 36px) 口径、",
    "  多层顶栏/双重高度、.topBar 回潮为挤占文档流的常规块（应为 position: absolute 浮层）等。",
    "文件:行号 / 当前值：FAIL 逐条给出 CSS 文件:行号与实际值。",
    "阈值：契约值唯一（--header-height, 36px）。",
    "正确做法：按 docs/desktop-ui-systemic-repair/ 分维详案 04 恢复契约值；禁止引入第二套高度变量。",
    "复核：node scripts/check-layout-geometry.mjs  # 期望 OK",
  ];
  console.log('[check-layout-geometry] 正确做法 · 五元规约\n');
  for (const l of __debt08Guide) console.log('  ' + l);
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const APP_TOP_BAR_CSS = resolve(
  REPO_ROOT,
  'apps/crish-desktop/src/components/top-bar/AppTopBar.module.css'
);

const PANE_HEADER_CSS = resolve(
  REPO_ROOT,
  'apps/crish-desktop/src/components/binary-tree/PaneHeader.module.css'
);

/** 剥离 CSS 中的注释，避免注释内伪代码干扰检测 */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 提取规则块：解析简单选择器及块体 */
function extractRules(cleanCss) {
  const rules = [];
  const ruleRegex = /([^{}]+)\{([^{}]+)\}/g;
  let match;
  while ((match = ruleRegex.exec(cleanCss)) !== null) {
    rules.push({
      selector: match[1].trim(),
      body: match[2].trim(),
    });
  }
  return rules;
}

function checkAppTopBarGeometry(errors) {
  if (!existsSync(APP_TOP_BAR_CSS)) {
    errors.push(`[文件缺失] 找不到 AppTopBar.module.css: ${APP_TOP_BAR_CSS}`);
    return;
  }

  const raw = readFileSync(APP_TOP_BAR_CSS, 'utf8');
  const clean = stripCssComments(raw);
  const rules = extractRules(clean);

  const topBarRule = rules.find((r) => /(?:^|\s|\.)topBar\b/.test(r.selector));
  if (!topBarRule) {
    errors.push(`[规则缺失] AppTopBar.module.css 中未找到 .topBar 样式规则`);
    return;
  }

  // 1. 检查 position 属性（必须为 absolute，保证不挤占垂直文档流）
  const posMatch = topBarRule.body.match(/\bposition\s*:\s*([^;]+);/);
  if (!posMatch || posMatch[1].trim() !== 'absolute') {
    errors.push(
      `[定位违规] .topBar position 必须为 'absolute'（浮层单轨），实际为: '${posMatch ? posMatch[1].trim() : '缺失'}'`
    );
  }

  // 2. 检查 height 声明
  const heightMatch = topBarRule.body.match(/(?:^|;)\s*height\s*:\s*([^;]+);/);
  if (!heightMatch) {
    errors.push(`[高度缺失] .topBar 缺少 height 声明`);
  } else {
    const val = heightMatch[1].trim();
    const isValidHeight =
      val === 'var(--header-height, 36px)' ||
      val === 'var(--header-height)' ||
      val === '36px';
    if (!isValidHeight) {
      errors.push(
        `[高度违规] .topBar height 必须严格为 var(--header-height, 36px) 或 36px，实际为: '${val}'`
      );
    }
  }

  // 3. 检查 min-height / max-height（若存在，必须与 36px 一致）
  for (const prop of ['min-height', 'max-height']) {
    const propMatch = topBarRule.body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+);`));
    if (propMatch) {
      const val = propMatch[1].trim();
      const isValid =
        val === 'var(--header-height, 36px)' ||
        val === 'var(--header-height)' ||
        val === '36px';
      if (!isValid) {
        errors.push(
          `[高度违规] .topBar ${prop} 必须严格为 var(--header-height, 36px) 或 36px，实际为: '${val}'`
        );
      }
    }
  }

  // 4. 检查是否出现除 36px 以外的魔术像素高度（如 72px、48px 等）
  const rawPixelHeights = topBarRule.body.match(/\b(?:height|min-height|max-height)\s*:\s*(\d+)px/g);
  if (rawPixelHeights) {
    for (const item of rawPixelHeights) {
      if (!item.includes('36px')) {
        errors.push(`[魔术数字拦截] .topBar 中存在非法像素高度: '${item}'`);
      }
    }
  }
}

function checkPaneHeaderGeometry(errors) {
  if (!existsSync(PANE_HEADER_CSS)) {
    errors.push(`[文件缺失] 找不到 PaneHeader.module.css: ${PANE_HEADER_CSS}`);
    return;
  }

  const raw = readFileSync(PANE_HEADER_CSS, 'utf8');
  const clean = stripCssComments(raw);
  const rules = extractRules(clean);

  // 1. 检查是否存在基于 [data-top-row="true"][data-right-edge="true"] 的右缘避让规则（兼容 Prettier 单双引号）
  const winRule = rules.find((r) => {
    const sel = r.selector.replace(/'/g, '"');
    return (
      sel.includes('[data-top-row="true"][data-right-edge="true"]') &&
      !sel.includes('data-platform="macos"')
    );
  });

  if (!winRule) {
    errors.push(
      `[避让规则缺失] PaneHeader.module.css 缺少针对顶行最右叶子节点 [data-top-row="true"][data-right-edge="true"] 的避让选择器`
    );
  } else {
    // 检查 Windows 窗控避让 Token
    if (!winRule.body.includes('var(--edge-reserve-right-win)')) {
      errors.push(
        `[Token违规] Windows 右缘避让必须声明 padding-right: var(--edge-reserve-right-win)，实际声明为: '${winRule.body}'`
      );
    }
  }

  // 2. 检查 macOS 平台的右缘避让规则（兼容 Prettier 单双引号）
  const macRule = rules.find((r) => {
    const sel = r.selector.replace(/'/g, '"');
    return (
      sel.includes('[data-top-row="true"][data-right-edge="true"]') &&
      sel.includes('data-platform="macos"')
    );
  });

  if (!macRule) {
    errors.push(
      `[macOS避让缺失] PaneHeader.module.css 缺少针对 macOS 平台的 [data-top-row="true"][data-right-edge="true"] 避让规则`
    );
  } else {
    if (!macRule.body.includes('var(--edge-reserve-right-macos)')) {
      errors.push(
        `[Token违规] macOS 右缘避让必须声明 padding-right: var(--edge-reserve-right-macos)，实际声明为: '${macRule.body}'`
      );
    }
  }

  // 3. 拦截任何在顶行避让中裸写数值（如 padding-right: 144px;）
  const rawPixelPadding = clean.match(
    /\[data-top-row=['"]true['"]\]\[data-right-edge=['"]true['"]\][^{]*\{[^}]*padding-right\s*:\s*\d+px/i
  );
  if (rawPixelPadding) {
    errors.push(
      `[裸值拦截] 严禁在 PaneHeader 右缘避让中裸写像素数字，必须严格使用 Design Tokens`
    );
  }
}

function main() {
  const errors = [];

  checkAppTopBarGeometry(errors);
  checkPaneHeaderGeometry(errors);

  if (errors.length > 0) {
    console.error('\x1b[31m%s\x1b[0m', '✗ Layout geometry check failed:');
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    console.error('\n请参考 docs/desktop-ui-systemic-repair/01-分维详案 修复布局几何契约。');
    process.exit(1);
  }

  console.log('\x1b[32m%s\x1b[0m', '✓ Layout geometry check passed');
}

main();
