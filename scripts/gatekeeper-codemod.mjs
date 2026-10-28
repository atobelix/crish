#!/usr/bin/env node
/**
 * scripts/gatekeeper-codemod.mjs
 * UI 门禁只读报告器 (Gatekeeper Codemod Reporter)
 *
 * 依据 AGENTS.md §17（2026-10-21 用户裁决）：脚本仅限只读检索与验证执行，
 * 绝对严禁编写或运行任何脚本直接修改、生成或覆写项目代码；代码修改必须
 * 使用原生编辑工具（edit_file / write_file）逐处落地。因此本工具**只报告
 * 可治理项，不写盘**，`--apply` / `--fix` / `--write` 一律拒绝执行。
 *
 * 报告三类可治理项（建议形态，供人工逐个决策）：
 *   1. 内联样式裸数值/裸 px 可映射到精确 Token（如 gap: 8 -> var(--space-2)）
 *   2. 原生 title 属性可提升为 Tooltip 组件包裹
 *   3. 焦点对比度超标的 clamp 候选（12%+ -> 8%）
 *
 * 用法:
 *   node scripts/gatekeeper-codemod.mjs                  # 全量扫描并输出报告（默认，唯一模式）
 *   node scripts/gatekeeper-codemod.mjs --dry-run        # 同默认模式（兼容旧参数）
 *   node scripts/gatekeeper-codemod.mjs --file <path>    # 仅报告指定文件
 *   node scripts/gatekeeper-codemod.mjs --gate <name>    # 仅运行指定门禁的报告器
 *   node scripts/gatekeeper-codemod.mjs --staged         # 仅报告 git 暂存区文件
 *   node scripts/gatekeeper-codemod.mjs --verbose        # 输出详细诊断信息
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// ── 1. 间距数值到 Design Tokens 的 SSOT 映射字典 ──────────────────────────────
// 仅登记「数值与 Token 基值精确相等」的映射：--space-* 是随密度矩阵变化的
// 别名（small/default/large 三档基值不同），写入 px 兜底会冻结某一档的
// 视觉结果（违反 AGENTS §20 的 Token 兜底禁令）；18/22/30/36/48 等无精确
// 对应 Token 的数值不自动建议，必须由人工做设计决策。
export const SPACE_TOKEN_MAP = {
  '2': 'var(--space-0_5)',
  '4': 'var(--space-1)',
  '6': 'var(--space-1_5)',
  '8': 'var(--space-2)',
  '10': 'var(--space-2_5)',
  '12': 'var(--space-3)',
  '14': 'var(--space-3_5)',
  '16': 'var(--space-4)',
  '20': 'var(--space-5)',
  '24': 'var(--space-6)',
  '28': 'var(--space-7)',
  '32': 'var(--space-8)',
  '40': 'var(--space-10)',
};

// ── 2. 加载门禁统一诊断字典 ───────────────────────────────────────────────────
export function loadDiagnostics() {
  const diagPath = path.resolve(__dirname, 'ui-gate-diagnostics.json');
  if (fs.existsSync(diagPath)) {
    try {
      return JSON.parse(fs.readFileSync(diagPath, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

// ── 3. 顶层逗号分割器（穿透嵌套括号，如 var(--a, var(--b)) 中的逗号不切分） ──
export function splitTopLevelCommas(str) {
  const parts = [];
  let depth = 0;
  let inQuote = null;
  let lastIdx = 0;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inQuote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inQuote) inQuote = null;
    } else {
      if (ch === '"' || ch === "'" || ch === '`') {
        inQuote = ch;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
      } else if (ch === ',' && depth === 0) {
        parts.push(str.slice(lastIdx, i).trim());
        lastIdx = i + 1;
      }
    }
  }
  if (lastIdx < str.length) {
    parts.push(str.slice(lastIdx).trim());
  }
  return parts;
}

// ── 4. 提取成对括号函数调用（用于精确定位 color-mix 等多层嵌套） ───────────────
export function extractFunctionCalls(str, fnName) {
  const results = [];
  const lower = str.toLowerCase();
  const searchPattern = fnName.toLowerCase() + '(';
  let searchIdx = 0;

  while (true) {
    const fnIdx = lower.indexOf(searchPattern, searchIdx);
    if (fnIdx === -1) break;
    let depth = 1;
    let i = fnIdx + searchPattern.length;
    let inQuote = null;

    while (i < str.length && depth > 0) {
      const ch = str[i];
      if (inQuote) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === inQuote) {
          inQuote = null;
        }
      } else {
        if (ch === '"' || ch === "'" || ch === '`') {
          inQuote = ch;
        } else if (ch === '(') {
          depth++;
        } else if (ch === ')') {
          depth--;
        }
      }
      i++;
    }

    if (depth === 0) {
      results.push({
        full: str.slice(fnIdx, i),
        args: str.slice(fnIdx + searchPattern.length, i - 1),
        start: fnIdx,
        end: i,
      });
      searchIdx = i;
    } else {
      searchIdx = fnIdx + searchPattern.length;
    }
  }
  return results;
}

// ── 5. 提取 style={{ ... }} 块（配平花括号） ──────────────────────────────────
export function extractStyleBlocks(text) {
  const blocks = [];
  const re = /style=\{\{/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const openEnd = m.index + m[0].length;
    let depth = 2;
    let i = openEnd;
    let inQuote = null;

    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (inQuote) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === inQuote) inQuote = null;
      } else {
        if (ch === '"' || ch === "'" || ch === '`') inQuote = ch;
        else if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (depth === 0) break;
      i++;
    }

    if (depth === 0) {
      blocks.push({
        start: m.index,
        end: i + 1,
        bodyStart: openEnd,
        bodyEnd: i,
        body: text.slice(openEnd, i),
      });
    }
  }
  return blocks;
}

// ── 6. 查找匹配的 JSX 闭合标签 </tag> ──────────────────────────────────────────
export function findMatchingClosingTag(code, tagName, startIndex) {
  let depth = 1;
  let i = startIndex;

  while (i < code.length && depth > 0) {
    const openIdx = code.indexOf(`<${tagName}`, i);
    const closeIdx = code.indexOf(`</${tagName}>`, i);

    if (closeIdx === -1) {
      return -1;
    }

    if (openIdx !== -1 && openIdx < closeIdx) {
      const nextChar = code[openIdx + tagName.length + 1];
      if (/[\s>\/]/.test(nextChar)) {
        let j = openIdx + tagName.length + 1;
        let inQuote = null;
        let braceDepth = 0;
        let isSelfClose = false;

        while (j < code.length) {
          const ch = code[j];
          if (inQuote) {
            if (ch === '\\') {
              j += 2;
              continue;
            }
            if (ch === inQuote) inQuote = null;
          } else if (braceDepth > 0) {
            if (ch === '"' || ch === "'" || ch === '`') inQuote = ch;
            else if (ch === '{') braceDepth++;
            else if (ch === '}') braceDepth--;
          } else {
            if (ch === '"' || ch === "'" || ch === '`') inQuote = ch;
            else if (ch === '{') braceDepth++;
            else if (ch === '/' && code[j + 1] === '>') {
              isSelfClose = true;
              j += 2;
              break;
            } else if (ch === '>') {
              j += 1;
              break;
            }
          }
          j++;
        }
        if (!isSelfClose) depth++;
        i = j;
        continue;
      } else {
        i = openIdx + tagName.length + 1;
        continue;
      }
    } else {
      depth--;
      if (depth === 0) {
        return closeIdx + `</${tagName}>`.length;
      }
      i = closeIdx + `</${tagName}>`.length;
    }
  }

  return -1;
}

// ── 7. 自动补齐 Tooltip 组件引入 ──────────────────────────────────────────────
export function ensureTooltipImport(code) {
  if (/\bimport\s*\{[^}]*\bTooltip\b[^}]*\}\s*from/.test(code)) {
    return code;
  }

  // 若已有从 '@/components/ui' 或 './ui' 的导入，追加 Tooltip
  const uiImportRegex = /(import\s*\{)([^}]*)(\}\s*from\s*['"](?:@\/components\/ui|\.\/ui|\.\.\/ui)['"];?)/;
  if (uiImportRegex.test(code)) {
    return code.replace(uiImportRegex, (m, start, imports, end) => {
      const trimmed = imports.trim();
      const updated = trimmed ? `${trimmed}, Tooltip` : 'Tooltip';
      return `${start} ${updated} ${end}`;
    });
  }

  // 否则在最后一个 import 语句之后插入
  const lastImportIdx = code.lastIndexOf('\nimport ');
  if (lastImportIdx !== -1) {
    const endOfImportLine = code.indexOf('\n', lastImportIdx + 1);
    if (endOfImportLine !== -1) {
      return (
        code.slice(0, endOfImportLine + 1) +
        "import { Tooltip } from '@/components/ui';\n" +
        code.slice(endOfImportLine + 1)
      );
    }
  }

  return "import { Tooltip } from '@/components/ui';\n" + code;
}

// ─────────────────────────────────────────────────────────────────────────────
// 核心修复器 1: 内联样式裸数值转 Token (Fixer A)
// ─────────────────────────────────────────────────────────────────────────────
export function fixInlineNumericStyles(content) {
  let modified = content;
  const changes = [];

  const blocks = extractStyleBlocks(modified);
  // 逆序处理，保证前面字符偏移不受后续变动影响
  for (let b = blocks.length - 1; b >= 0; b--) {
    const block = blocks[b];
    let body = block.body;
    let bodyChanged = false;

    // 排除大段示例伪代码
    if (body.length > 800 || /\bimport\b/.test(body)) continue;

    for (const [num, token] of Object.entries(SPACE_TOKEN_MAP)) {
      // 1. 匹配裸数值: gap: 8 -> gap: 'var(--space-2)'
      const numRegex = new RegExp(
        `\\b(gap|rowGap|columnGap|margin|marginTop|marginBottom|marginLeft|marginRight|marginInline|marginBlock|padding|paddingTop|paddingBottom|paddingLeft|paddingRight|paddingInline|paddingBlock|top|left|right|bottom)\\s*:\\s*${num}\\b(?![\\w.-])`,
        'g'
      );
      body = body.replace(numRegex, (match, prop) => {
        bodyChanged = true;
        changes.push({
          ruleCode: 'INLINE_GAP_NUMERIC',
          gate: 'check-inline-style-hardcode',
          before: match,
          after: `${prop}: '${token}'`,
          property: prop,
          from: num,
          to: token,
        });
        return `${prop}: '${token}'`;
      });

      // 2. 匹配裸 px 字符串: gap: '8px' 或 padding: "12px" -> gap: 'var(--space-2)'
      const pxRegex = new RegExp(
        `\\b(gap|rowGap|columnGap|margin|marginTop|marginBottom|marginLeft|marginRight|marginInline|marginBlock|padding|paddingTop|paddingBottom|paddingLeft|paddingRight|paddingInline|paddingBlock|top|left|right|bottom)\\s*:\\s*['"]${num}px['"]`,
        'g'
      );
      body = body.replace(pxRegex, (match, prop) => {
        bodyChanged = true;
        changes.push({
          ruleCode: 'INLINE_BARE_PX',
          gate: 'check-inline-style-hardcode',
          before: match,
          after: `${prop}: '${token}'`,
          property: prop,
          from: `${num}px`,
          to: token,
        });
        return `${prop}: '${token}'`;
      });
    }

    if (bodyChanged) {
      modified =
        modified.slice(0, block.bodyStart) +
        body +
        modified.slice(block.bodyEnd);
    }
  }

  return { code: modified, changes };
}

// ─────────────────────────────────────────────────────────────────────────────
// 核心修复器 2: 原生 title 转 Tooltip 组件包裹 (Fixer B)
// ─────────────────────────────────────────────────────────────────────────────
export function fixNativeTitleAttributes(content) {
  let code = content;
  const changes = [];
  let hasChanges = false;

  const tagStartRegex = /<([a-z][a-z0-9-]*)\b/g;
  let match;

  while ((match = tagStartRegex.exec(code)) !== null) {
    const tagName = match[1];
    if (tagName === 'svg' || tagName === 'title') {
      continue;
    }

    // 解析当前开标签范围
    let i = match.index + match[0].length;
    let inQuote = null;
    let braceDepth = 0;
    let tagClosed = false;
    let isSelfClosing = false;

    while (i < code.length) {
      const ch = code[i];
      if (inQuote) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === inQuote) inQuote = null;
      } else if (braceDepth > 0) {
        if (ch === '"' || ch === "'" || ch === '`') inQuote = ch;
        else if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
      } else {
        if (ch === '"' || ch === "'" || ch === '`') inQuote = ch;
        else if (ch === '{') braceDepth++;
        else if (ch === '/' && code[i + 1] === '>') {
          isSelfClosing = true;
          i += 2;
          tagClosed = true;
          break;
        } else if (ch === '>') {
          i += 1;
          tagClosed = true;
          break;
        }
      }
      i++;
    }

    if (!tagClosed) continue;

    const openingTagFull = code.slice(match.index, i);
    // 匹配 title 属性
    const titleMatch = /\btitle=(?:"([^"]*)"|'([^']*)'|{\s*(["'`])([^"'`]+)\3\s*}|{([^}]+)})/.exec(
      openingTagFull
    );
    if (!titleMatch) continue;

    const rawTitleAttr = titleMatch[0];
    const titleVal =
      titleMatch[1] ?? titleMatch[2] ?? titleMatch[4] ?? titleMatch[5];
    const isExpr = Boolean(titleMatch[5] && !titleMatch[4]);
    const contentProp = isExpr ? `{${titleVal}}` : `"${titleVal}"`;

    // 剥离 title 属性
    let cleanOpeningTag = openingTagFull
      .replace(rawTitleAttr, '')
      .replace(/\s{2,}/g, ' ');
    cleanOpeningTag = cleanOpeningTag
      .replace(/\s+\/>/, ' />')
      .replace(/\s+>/, '>');

    if (isSelfClosing) {
      const wrapped = `<Tooltip content=${contentProp}>${cleanOpeningTag}</Tooltip>`;
      changes.push({
        ruleCode: 'NATIVE_TITLE_FORBIDDEN',
        gate: 'check-tooltip-hygiene',
        before: openingTagFull,
        after: wrapped,
        title: titleVal,
      });
      code = code.slice(0, match.index) + wrapped + code.slice(i);
      tagStartRegex.lastIndex = match.index + wrapped.length;
      hasChanges = true;
    } else {
      const matchCloseIdx = findMatchingClosingTag(code, tagName, i);
      if (matchCloseIdx !== -1) {
        const innerAndClose = code.slice(i, matchCloseIdx);
        const wholeElement = cleanOpeningTag + innerAndClose;
        const wrapped = `<Tooltip content=${contentProp}>${wholeElement}</Tooltip>`;
        changes.push({
          ruleCode: 'NATIVE_TITLE_FORBIDDEN',
          gate: 'check-tooltip-hygiene',
          before: code.slice(match.index, matchCloseIdx),
          after: wrapped,
          title: titleVal,
        });
        code = code.slice(0, match.index) + wrapped + code.slice(matchCloseIdx);
        tagStartRegex.lastIndex = match.index + wrapped.length;
        hasChanges = true;
      }
    }
  }

  if (hasChanges) {
    code = ensureTooltipImport(code);
  }

  return { code, changes };
}

// ─────────────────────────────────────────────────────────────────────────────
// 核心修复器 3: 焦点对比度 clamp 钳制 (Fixer C)
// ─────────────────────────────────────────────────────────────────────────────
export function fixFocusContrastOverflow(content) {
  let modified = content;
  const changes = [];

  const calls = extractFunctionCalls(modified, 'color-mix');
  const borderRegex = /var\(--border(?:-[\w-]+)?\b/i;
  const darkRegex = /(?:var\(--text-primary\)|var\(--text-color\)|var\(--color-text\)|var\(--text-main\)|#(?:000000|000|111111|111)(?![0-9a-fA-F])|\bblack\b)/i;

  // 逆序处理，防止字符串替换错位
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    // 排除 transparent 渐变或半透明高亮
    if (/\btransparent\b/i.test(call.full)) continue;

    // 仅针对含有 border 变量与深文本色变量的对比度混合
    if (!borderRegex.test(call.full) || !darkRegex.test(call.full)) continue;

    const parts = splitTopLevelCommas(call.args);
    if (parts.length !== 3) continue;

    const colorSpace = parts[0];
    const part1 = parts[1];
    const part2 = parts[2];

    let darkPart = null;
    let basePart = null;
    let darkIsFirst = false;

    if (darkRegex.test(part1) && borderRegex.test(part2)) {
      darkPart = part1;
      basePart = part2;
      darkIsFirst = true;
    } else if (borderRegex.test(part1) && darkRegex.test(part2)) {
      darkPart = part2;
      basePart = part1;
      darkIsFirst = false;
    } else {
      continue;
    }

    const darkPctMatch = darkPart.match(/\s+(\d+(?:\.\d+)?)%/);
    const basePctMatch = basePart.match(/\s+(\d+(?:\.\d+)?)%/);

    let darkPct = null;
    if (darkPctMatch) {
      darkPct = parseFloat(darkPctMatch[1]);
    } else if (basePctMatch) {
      darkPct = 100 - parseFloat(basePctMatch[1]);
    } else {
      darkPct = 50;
    }

    // 若对比度超过 10% 刚性红线，自动钳制至 8%
    if (darkPct > 10) {
      const cleanDark = darkPart.replace(/\s+\d+(?:\.\d+)?%/, '').trim();
      const cleanBase = basePart.replace(/\s+\d+(?:\.\d+)?%/, '').trim();

      const clampedDark = `${cleanDark} 8%`;
      const clampedBase = `${cleanBase} 92%`;

      const newCall = darkIsFirst
        ? `color-mix(${colorSpace}, ${clampedDark}, ${clampedBase})`
        : `color-mix(${colorSpace}, ${clampedBase}, ${clampedDark})`;

      changes.push({
        ruleCode: 'FOCUS_RING_CONTRAST_OVERFLOW',
        gate: 'check-input-guardrails',
        before: call.full,
        after: newCall,
        originalPct: darkPct,
        clampedPct: 8,
      });

      modified =
        modified.slice(0, call.start) + newCall + modified.slice(call.end);
    }
  }

  return { code: modified, changes };
}

// ── 8. 递归扫描指定目录下的目标文件 ───────────────────────────────────────────
function collectFiles(dirs, extensions, excludeDirs = ['node_modules', 'dist', '.git', '__tests__']) {
  const result = [];

  function walk(current) {
    if (!fs.existsSync(current)) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (excludeDirs.includes(entry.name)) continue;
        walk(path.join(current, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (extensions.includes(ext) && !/\.(test|spec)\.[tj]sx?$/.test(entry.name)) {
          result.push(path.join(current, entry.name));
        }
      }
    }
  }

  for (const d of dirs) {
    walk(d);
  }
  return result;
}

// ── 9. 执行单文件只读报告管线（绝不写盘；AGENTS §17） ─────────────────────────
export function processFile(filePath, options = {}) {
  const { gate, diagnostics } = options;
  const ext = path.extname(filePath);
  const isTsxOrJsx = ext === '.tsx' || ext === '.jsx';
  const isCss = ext === '.css';

  const originalContent = fs.readFileSync(filePath, 'utf8');
  let currentContent = originalContent;
  const allChanges = [];

  // 1. Fixer A: 内联裸数值转 Token (仅 tsx/jsx)
  if (isTsxOrJsx && (!gate || gate === 'check-inline-style-hardcode')) {
    const res = fixInlineNumericStyles(currentContent);
    if (res.changes.length > 0) {
      currentContent = res.code;
      allChanges.push(...res.changes);
    }
  }

  // 2. Fixer B: 原生 title 转 Tooltip (仅 tsx/jsx)
  if (isTsxOrJsx && (!gate || gate === 'check-tooltip-hygiene')) {
    const res = fixNativeTitleAttributes(currentContent);
    if (res.changes.length > 0) {
      currentContent = res.code;
      allChanges.push(...res.changes);
    }
  }

  // 3. Fixer C: 焦点对比度 clamp (css 及 tsx/jsx)
  if ((isCss || isTsxOrJsx) && (!gate || gate === 'check-input-guardrails')) {
    const res = fixFocusContrastOverflow(currentContent);
    if (res.changes.length > 0) {
      currentContent = res.code;
      allChanges.push(...res.changes);
    }
  }

  return {
    filePath,
    modified: currentContent !== originalContent,
    changes: allChanges,
  };
}

// ── 10. 主命令行执行入口 ──────────────────────────────────────────────────────
export function run() {
  const args = process.argv.slice(2);
  const writeRequested = ['--apply', '--fix', '--write'].some((flag) =>
    args.includes(flag)
  );
  if (writeRequested) {
    console.error(
      '[gatekeeper-codemod] 拒绝执行：AGENTS.md §17 禁止脚本修改/生成/覆写项目代码。\n' +
        '本工具只输出治理报告；请使用原生编辑工具（edit_file / write_file）逐处修改，并逐一复核语义。'
    );
    process.exit(2);
  }

  const staged = args.includes('--staged');
  const verbose = args.includes('--verbose') || args.includes('-v');

  let gateFilter = null;
  const gateIdx = args.indexOf('--gate');
  if (gateIdx !== -1 && args[gateIdx + 1]) {
    gateFilter = args[gateIdx + 1];
  }

  let singleFile = null;
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    singleFile = path.resolve(ROOT, args[fileIdx + 1]);
  }

  console.log('[gatekeeper-codemod] 启动 UI 静态治理只读报告器（不写盘）...');
  if (gateFilter) {
    console.log(`  Gate Filter: ${gateFilter}`);
  }

  const diagnostics = loadDiagnostics();

  // 收集文件列表
  let targetFiles = [];
  if (singleFile) {
    if (fs.existsSync(singleFile)) {
      targetFiles = [singleFile];
    } else {
      console.error(`[gatekeeper-codemod] 错误: 文件不存在 -> ${singleFile}`);
      process.exit(1);
    }
  } else if (staged) {
    try {
      const output = execSync('git diff --cached --name-only', { encoding: 'utf8' });
      targetFiles = output
        .split('\n')
        .map((p) => p.trim())
        .filter((p) => /\.(tsx?|jsx?|css)$/.test(p))
        .map((p) => path.resolve(ROOT, p))
        .filter(fs.existsSync);
    } catch {
      console.warn('[gatekeeper-codemod] 警告: 获取暂存区文件失败，回退为空列表');
      targetFiles = [];
    }
  } else {
    const scanDirs = [
      path.resolve(ROOT, 'apps/crish-desktop/src'),
      path.resolve(ROOT, 'apps/crish-mobile/src'),
      path.resolve(ROOT, 'packages'),
    ].filter(fs.existsSync);

    targetFiles = collectFiles(scanDirs, ['.tsx', '.jsx', '.css']);
  }

  let totalFilesModified = 0;
  let totalFixCount = 0;

  for (const file of targetFiles) {
    const res = processFile(file, { gate: gateFilter, diagnostics });
    if (res.modified) {
      totalFilesModified++;
      totalFixCount += res.changes.length;
      const relPath = path.relative(ROOT, file).replace(/\\/g, '/');
      console.log(`\n  ✔ ${relPath} (${res.changes.length} 处修复):`);

      for (const ch of res.changes) {
        if (ch.ruleCode === 'INLINE_GAP_NUMERIC' || ch.ruleCode === 'INLINE_BARE_PX') {
          console.log(`    - [${ch.ruleCode}] 样式 Token 化: ${ch.before} -> ${ch.after}`);
        } else if (ch.ruleCode === 'NATIVE_TITLE_FORBIDDEN') {
          console.log(`    - [${ch.ruleCode}] 原生 title 转 Tooltip: title="${ch.title}" -> <Tooltip content="...">`);
        } else if (ch.ruleCode === 'FOCUS_RING_CONTRAST_OVERFLOW') {
          console.log(`    - [${ch.ruleCode}] 焦点对比度钳制: ${ch.originalPct}% -> ${ch.clampedPct}%`);
        }
      }
    } else if (verbose) {
      const relPath = path.relative(ROOT, file).replace(/\\/g, '/');
      console.log(`  · ${relPath}: 无违规`);
    }
  }

  console.log('\n================================================================================');
  if (totalFilesModified > 0) {
    console.log(
      `[gatekeeper-codemod] 报告完成：${totalFilesModified} 个文件存在 ${totalFixCount} 处可治理项（未写盘）。`
    );
    console.log(
      '[gatekeeper-codemod] 请用原生编辑工具逐处修改；禁止用脚本批量落盘（AGENTS §17）。'
    );
  } else {
    console.log('[gatekeeper-codemod] 全仓扫描完毕，未发现可治理项。');
  }
  console.log('================================================================================\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run();
}
