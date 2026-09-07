/**
 * scripts/check-markdown-style-compliance.mjs
 *
 * Markdown 排版样式合规与 Token 静态守门脚本
 *
 * 校验断言：
 * 1. 零裸 Hex / 零裸 RGB：除注释外，严禁硬编码色值（必须 100% 消费 var()、color-mix 或 hsl）；
 * 2. 零未声明 Token：引用的所有 --md-* 变量必须在 tokens.css 中已完整声明；
 * 3. 严禁幽灵选择器：严禁出现 msg-assistant-text 幽灵类选择器。
 *
 * 运行方式：
 *   node scripts/check-markdown-style-compliance.mjs
 *
 * 退出码：0 = 全部合规；1 = 存在违规（CI 阻断）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url));
const MARKDOWN_CSS_PATH = resolve(
  ROOT_DIR,
  'apps/crish-desktop/src/styles/markdown-typography.css'
);
const TOKENS_CSS_PATH = resolve(
  ROOT_DIR,
  'apps/crish-desktop/src/styles/tokens.css'
);

function runComplianceCheck() {
  const errors = [];
  const warnings = [];

  console.log('🔍 开始 Markdown 样式合规与 Token 静态守门扫描...');

  // 1. 检查目标文件存在性
  if (!existsSync(MARKDOWN_CSS_PATH)) {
    console.error(`❌ 未找到目标样式文件: ${MARKDOWN_CSS_PATH}`);
    process.exit(1);
  }
  if (!existsSync(TOKENS_CSS_PATH)) {
    console.error(`❌ 未找到 Design Tokens 文件: ${TOKENS_CSS_PATH}`);
    process.exit(1);
  }

  // 2. 解析 tokens.css 中声明的全部 CSS 变量白名单
  const tokensContent = readFileSync(TOKENS_CSS_PATH, 'utf-8');
  const declaredTokens = new Set();
  const tokenDeclRegex = /(--[a-zA-Z0-9_-]+)\s*:/g;
  let tokenMatch;
  while ((tokenMatch = tokenDeclRegex.exec(tokensContent)) !== null) {
    declaredTokens.add(tokenMatch[1]);
  }

  console.log(`📋 从 tokens.css 解析到 ${declaredTokens.size} 个有效 Design Token 声明。`);

  // 3. 读取 markdown-typography.css
  const mdCssRaw = readFileSync(MARKDOWN_CSS_PATH, 'utf-8');

  // 3.1 校验断言 3：严禁出现 msg-assistant-text 幽灵选择器
  const ghostSelectorRegex = /\.?msg-assistant-text\b/g;
  let ghostMatch;
  while ((ghostMatch = ghostSelectorRegex.exec(mdCssRaw)) !== null) {
    // 定位行号
    const lineNo = mdCssRaw.slice(0, ghostMatch.index).split('\n').length;
    errors.push(
      `[断言 3 违规: 幽灵选择器] 第 ${lineNo} 行命中禁止的幽灵选择器: "msg-assistant-text"`
    );
  }

  // 3.2 准备逐行扫描（剥离行内注释前建立行映射）
  const lines = mdCssRaw.split(/\r?\n/);
  let insideBlockComment = false;

  const HEX_COLOR_REGEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
  const RGB_COLOR_REGEX = /\brgba?\s*\([^)]*\)/gi;
  const MD_VAR_REF_REGEX = /var\(\s*(--md-[a-zA-Z0-9_-]+)/g;

  const scannedMdVars = new Set();

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNo = i + 1;

    // 清理多行注释状态
    let cleanLine = '';
    let cursor = 0;

    while (cursor < rawLine.length) {
      if (insideBlockComment) {
        const commentEnd = rawLine.indexOf('*/', cursor);
        if (commentEnd === -1) {
          // 整行都在注释内
          cursor = rawLine.length;
        } else {
          insideBlockComment = false;
          cursor = commentEnd + 2;
        }
      } else {
        const commentStart = rawLine.indexOf('/*', cursor);
        if (commentStart === -1) {
          cleanLine += rawLine.slice(cursor);
          cursor = rawLine.length;
        } else {
          cleanLine += rawLine.slice(cursor, commentStart);
          insideBlockComment = true;
          cursor = commentStart + 2;
        }
      }
    }

    const trimmedCode = cleanLine.trim();
    if (!trimmedCode) continue;

    // 校验断言 1：零裸 Hex / 零裸 RGB
    const hexHits = trimmedCode.match(HEX_COLOR_REGEX);
    if (hexHits) {
      errors.push(
        `[断言 1 违规: 裸 Hex] 第 ${lineNo} 行发现硬编码 Hex 颜色: ${hexHits.join(', ')}。必须使用 var()、color-mix() 或 hsl()`
      );
    }

    const rgbHits = trimmedCode.match(RGB_COLOR_REGEX);
    if (rgbHits) {
      errors.push(
        `[断言 1 违规: 裸 RGB] 第 ${lineNo} 行发现硬编码 RGB/RGBA 颜色: ${rgbHits.join(', ')}。必须使用 var()、color-mix() 或 hsl()`
      );
    }

    // 校验断言 2：引用的 --md-* 变量必须在 tokens.css 中已声明
    let varMatch;
    while ((varMatch = MD_VAR_REF_REGEX.exec(trimmedCode)) !== null) {
      const varName = varMatch[1];
      scannedMdVars.add(varName);
      if (!declaredTokens.has(varName)) {
        errors.push(
          `[断言 2 违规: 未声明 Token] 第 ${lineNo} 行引用了未在 tokens.css 中声明的变量: "${varName}"`
        );
      }
    }
  }

  // 4. 汇总输出结果
  console.log(`🔎 扫描完成：共检查 ${lines.length} 行代码，引用了 ${scannedMdVars.size} 个 --md-* 语义化变量。`);

  if (warnings.length > 0) {
    console.warn(`\n⚠️ 发现 ${warnings.length} 处提示：`);
    warnings.forEach((w) => console.warn(`  - ${w}`));
  }

  if (errors.length > 0) {
    console.error(`\n❌ Markdown 样式合规门禁未通过，发现 ${errors.length} 处违规：`);
    errors.forEach((err) => console.error(`  - ${err}`));
    process.exit(1);
  }

  console.log('\n✅ Markdown 样式合规门禁检查通过：');
  console.log('  - 断言 1 通过: 100% 零裸 Hex / 零裸 RGB');
  console.log(`  - 断言 2 通过: 全量 ${scannedMdVars.size} 个 --md-* 变量均已在 tokens.css 完备声明`);
  console.log('  - 断言 3 通过: 零 msg-assistant-text 幽灵选择器');
  process.exit(0);
}

runComplianceCheck();
