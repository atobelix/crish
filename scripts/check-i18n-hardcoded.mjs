#!/usr/bin/env node
/**
 * scripts/check-i18n-hardcoded.mjs
 * 源码硬编码中文与伪国际化 AST 扫描门禁与基线棘轮 (Wave 0 · AGENT-GATE-HARDCODED)
 *
 * 架构：两段式混合动力引擎（正则预检快筛 + TypeScript Compiler API AST 深度语义分析）
 * 语义：全仓解析 apps/crish-desktop/src/ 下的 .ts / .tsx 源码，扫描硬编码中文与伪国际化违规。
 *
 * 运行方式:
 *   node scripts/check-i18n-hardcoded.mjs                     # 门禁检查（比对基线棘轮）
 *   node scripts/check-i18n-hardcoded.mjs --list              # 打印全部违规项清单 (文件:行:列 · 代码片段 · AST节点类型)
 *   node scripts/check-i18n-hardcoded.mjs --guide <metric>    # 打印指标指引 (hardcoded_chinese_in_source, baseline_exceeded, missing_baseline)
 *   node scripts/check-i18n-hardcoded.mjs --update-baseline   # 初始化/收紧基线记录（只降不升）
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DESKTOP_SRC = resolve(REPO_ROOT, 'apps/crish-desktop/src');

const START_MARKER = '<!-- BASELINE_START -->';
const END_MARKER = '<!-- BASELINE_END -->';

const BASELINE_PATH_DEFAULT = resolve(
  REPO_ROOT,
  'docs/i18n-full-remediation/基线记录/i18n-hardcoded-baseline.md'
);

function getArgVal(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const BASELINE_PATH = (() => {
  const v = getArgVal('--baseline');
  return v ? resolve(REPO_ROOT, v) : BASELINE_PATH_DEFAULT;
})();

const LIST = process.argv.includes('--list');
const UPDATE_BASELINE =
  process.argv.includes('--update-baseline') || process.argv.includes('--update');
const guideIdx = process.argv.indexOf('--guide');
const GUIDE_METRIC = guideIdx >= 0 ? process.argv[guideIdx + 1] : undefined;

// ── 排除范围规则 ────────────────────────────────────────────────────────────
// 排除 *.test.ts, *.test.tsx, *.spec.ts, **/tests/**, src/i18n/locales/zh-CN/** 以及纯类型声明
const EXCLUDE_FILE_RE = /(\.(test|spec)\.(ts|tsx)$|[\/\\]__tests__[\/\\]|[\/\\]tests[\/\\]|src[\/\\]i18n[\/\\]locales[\/\\]zh-CN|\.d\.ts$)/;

function toPosix(p) {
  return p.split(sep).join('/');
}

// 递归收集目标源码文件 (.ts / .tsx)
function collectSourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== '.git') {
        collectSourceFiles(full, out);
      }
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        const rel = toPosix(relative(REPO_ROOT, full));
        if (!EXCLUDE_FILE_RE.test(rel)) {
          out.push(full);
        }
      }
    }
  }
  return out;
}

// ── 中文字符集与专有名词白名单 ────────────────────────────────────────────────
const CHINESE_REGEX = /[\u4e00-\u9fa5]/;

const BRAND_ALLOWLIST = [
  'DeepSeek', 'Qwen', '百度', '文心一言', '通义千问', '智谱AI', '智谱', '月之暗面',
  'MiniMax', '零一万物', '商汤科技', '百川智能', '讯飞星火', 'Kimi', 'Claude',
  'OpenAI', 'ChatGPT', 'Grok', 'Ollama', 'Gemini', 'Anthropic', 'Mistral',
  'Markdown', 'JSON', 'YAML', 'Git', 'API', 'OAuth', 'UTF-8', 'HTTP', 'HTTPS',
  'WebSocket', 'IPC', 'Tauri', 'Rust', 'React'
];

function filterBrands(text) {
  if (!text) return '';
  let s = text;
  for (const brand of BRAND_ALLOWLIST) {
    if (s.includes(brand)) {
      s = s.replaceAll(brand, '');
    }
  }
  return s;
}

function hasChinese(text) {
  if (!text) return false;
  return CHINESE_REGEX.test(filterBrands(text));
}

// 剥离注释（保留物理换行结构以便准确计算行号）
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) || []).length))
    .replace(/\/\/[^\n]*/g, '');
}

// 检查节点是否含有行内或前置抑制注释 (/* i18n-allow */)
function hasSuppression(sf, node) {
  const fullText = sf.getFullText();
  const start = node.getStart(sf);
  const { line } = sf.getLineAndCharacterOfPosition(start);
  const lineStart = sf.getPositionOfLineAndCharacter(line, 0);
  const lineStarts = sf.getLineStarts();
  const nextLineStart =
    line + 1 < lineStarts.length ? sf.getPositionOfLineAndCharacter(line + 1, 0) : fullText.length;
  const currentLine = fullText.slice(lineStart, nextLineStart);

  let prevLine = '';
  if (line > 0) {
    const prevLineStart = sf.getPositionOfLineAndCharacter(line - 1, 0);
    prevLine = fullText.slice(prevLineStart, lineStart);
  }

  const combined = prevLine + '\n' + currentLine;
  return /(?:\/\*[\s\S]*?i18n-allow[\s\S]*?\*\/|\/\/[^\n]*i18n-allow)/i.test(combined);
}

// ── 非 UI 属性与上下文放行 ────────────────────────────────────────────────────
const NON_UI_ATTRS = new Set([
  'className', 'class', 'style', 'id', 'key', 'htmlFor', 'for', 'href', 'src',
  'viewBox', 'fill', 'd', 'path', 'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin',
  'width', 'height', 'type', 'role', 'target', 'rel', 'autoComplete', 'autoCorrect',
  'spellCheck', 'tabIndex', 'xmlns', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'x2', 'y1', 'y2'
]);

function isNonUiAttribute(name) {
  if (name.startsWith('data-')) return true;
  if (NON_UI_ATTRS.has(name)) return true;
  return false;
}

function isInsideTechnicalCall(node) {
  let curr = node.parent;
  while (curr) {
    if (ts.isCallExpression(curr)) {
      const expr = curr.expression;
      const text = expr.getText();
      if (
        text.startsWith('console.') ||
        text === 'fetch' ||
        text === 'encodeURIComponent' ||
        text === 'encodeURI' ||
        text === 'JSON.stringify' ||
        text === 'JSON.parse'
      ) {
        return true;
      }
    }
    curr = curr.parent;
  }
  return false;
}

function isInsideTCall(node) {
  let curr = node.parent;
  while (curr) {
    if (ts.isCallExpression(curr)) {
      const expr = curr.expression;
      if (ts.isIdentifier(expr) && (expr.text === 't' || expr.text === 'translate')) return true;
      if (ts.isPropertyAccessExpression(expr) && (expr.name.text === 't' || expr.name.text === 'translate')) return true;
    }
    curr = curr.parent;
  }
  return false;
}

function isInsideTrans(node) {
  let curr = node.parent;
  while (curr) {
    if (ts.isJsxElement(curr)) {
      const tag = curr.openingElement.tagName.getText();
      if (tag === 'Trans') return true;
    }
    if (ts.isJsxSelfClosingElement(curr)) {
      const tag = curr.tagName.getText();
      if (tag === 'Trans') return true;
    }
    curr = curr.parent;
  }
  return false;
}

function isInsideCodeBlock(node) {
  let curr = node.parent;
  while (curr) {
    if (ts.isJsxElement(curr)) {
      const tag = curr.openingElement.tagName.getText();
      if (['pre', 'code', 'samp', 'kbd'].includes(tag)) return true;
    }
    curr = curr.parent;
  }
  return false;
}

function formatSnippet(text) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 50 ? oneLine.slice(0, 47) + '...' : oneLine;
}

// ── AST 语义深度分析单文件 ──────────────────────────────────────────────────
export function analyzeFileWithAst(relPath, content, sf) {
  const violations = [];
  const processedNodes = new Set();

  function getLoc(node) {
    const start = node.getStart(sf);
    const { line, character } = sf.getLineAndCharacterOfPosition(start);
    return { line: line + 1, col: character + 1 };
  }

  function visit(node) {
    if (processedNodes.has(node)) return;

    // 行内抑制注释直接跳过
    if (hasSuppression(sf, node)) {
      return;
    }

    // 排除导入导出语句
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      return;
    }

    // 排除纯类型声明与类型注解
    if (
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeNode(node) ||
      ts.isTypeElement(node)
    ) {
      return;
    }

    // 排除底层技术日志与系统工具调用
    if (isInsideTechnicalCall(node)) {
      return;
    }

    // 排除国际化 t() 与 translate() 调用内部
    if (isInsideTCall(node)) {
      return;
    }

    // 排除技术代码标签与富文本标签内部
    if (isInsideCodeBlock(node) || isInsideTrans(node)) {
      return;
    }

    // 1. JSX Text 裸文本节点: <div>新建会话</div>
    if (ts.isJsxText(node)) {
      const raw = node.text.trim();
      if (raw && hasChinese(raw)) {
        const { line, col } = getLoc(node);
        violations.push({
          relPath,
          line,
          col,
          kind: 'JsxText',
          text: formatSnippet(raw),
        });
      }
      return;
    }

    // 2. JSX Attribute 属性字符串: <Button title="设置" placeholder="输入消息..." aria-label="关闭" />
    if (ts.isJsxAttribute(node)) {
      const attrName = node.name.getText(sf);
      if (!isNonUiAttribute(attrName) && node.initializer) {
        if (ts.isStringLiteral(node.initializer) && hasChinese(node.initializer.text)) {
          const { line, col } = getLoc(node);
          violations.push({
            relPath,
            line,
            col,
            kind: 'JsxAttribute',
            text: formatSnippet(`${attrName}="${node.initializer.text}"`),
          });
          processedNodes.add(node.initializer);
          return;
        }
      }
    }

    // 3. 三元条件表达式: cond ? '保存' : 'Save'
    if (ts.isConditionalExpression(node)) {
      const trueHas =
        (ts.isStringLiteral(node.whenTrue) || ts.isNoSubstitutionTemplateLiteral(node.whenTrue)) &&
        hasChinese(node.whenTrue.text);
      const falseHas =
        (ts.isStringLiteral(node.whenFalse) || ts.isNoSubstitutionTemplateLiteral(node.whenFalse)) &&
        hasChinese(node.whenFalse.text);
      if (trueHas || falseHas) {
        const { line, col } = getLoc(node);
        violations.push({
          relPath,
          line,
          col,
          kind: 'ConditionalExpression',
          text: formatSnippet(node.getText(sf)),
        });
        processedNodes.add(node.whenTrue);
        processedNodes.add(node.whenFalse);
        return;
      }
    }

    // 4. 二元加号拼接: '总计: ' + count 或 t('item') + '：' + count
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const leftHas =
        (ts.isStringLiteral(node.left) || ts.isNoSubstitutionTemplateLiteral(node.left)) &&
        hasChinese(node.left.text);
      const rightHas =
        (ts.isStringLiteral(node.right) || ts.isNoSubstitutionTemplateLiteral(node.right)) &&
        hasChinese(node.right.text);
      if (leftHas || rightHas) {
        const { line, col } = getLoc(node);
        violations.push({
          relPath,
          line,
          col,
          kind: 'BinaryExpression',
          text: formatSnippet(node.getText(sf)),
        });
        if (ts.isStringLiteral(node.left)) processedNodes.add(node.left);
        if (ts.isStringLiteral(node.right)) processedNodes.add(node.right);
        return;
      }
    }

    // 5. 模板字面量: `${fileCount} 个文件`
    if (ts.isTemplateExpression(node)) {
      let tHas = hasChinese(node.head.text);
      for (const span of node.templateSpans) {
        if (hasChinese(span.literal.text)) tHas = true;
      }
      if (tHas) {
        const { line, col } = getLoc(node);
        violations.push({
          relPath,
          line,
          col,
          kind: 'TemplateLiteral',
          text: formatSnippet(node.getText(sf)),
        });
        for (const span of node.templateSpans) {
          ts.forEachChild(span.expression, visit);
        }
        return;
      }
    } else if (ts.isNoSubstitutionTemplateLiteral(node)) {
      if (hasChinese(node.text)) {
        const { line, col } = getLoc(node);
        violations.push({
          relPath,
          line,
          col,
          kind: 'TemplateLiteral',
          text: formatSnippet(node.text),
        });
        return;
      }
    }

    // 6. 对象字面量属性值: { label: '保存' }
    if (ts.isPropertyAssignment(node)) {
      const propName = node.name.getText(sf);
      if (node.initializer) {
        if (
          (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer)) &&
          hasChinese(node.initializer.text)
        ) {
          const { line, col } = getLoc(node);
          violations.push({
            relPath,
            line,
            col,
            kind: 'PropertyAssignment',
            text: formatSnippet(`${propName}: "${node.initializer.text}"`),
          });
          processedNodes.add(node.initializer);
          return;
        }
      }
    }

    // 7. 通用字符串字面量: 兜底捕获代码逻辑中的中文字符串
    if (ts.isStringLiteral(node) && hasChinese(node.text)) {
      const { line, col } = getLoc(node);
      violations.push({
        relPath,
        line,
        col,
        kind: 'StringLiteral',
        text: formatSnippet(`"${node.text}"`),
      });
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return violations;
}

// ── 基线操作 (Baseline Ratchet) ─────────────────────────────────────────────
export function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  const content = readFileSync(BASELINE_PATH, 'utf8');
  const start = content.indexOf(START_MARKER);
  const end = content.indexOf(END_MARKER);
  if (start < 0 || end < 0 || end < start) return null;

  const body = content.slice(start + START_MARKER.length, end);
  const map = new Map();
  let totalCount = 0;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 2) return { __malformed: `格式非法行: ${trimmed}` };
    const count = parseInt(parts[1], 10);
    if (isNaN(count)) return { __malformed: `数值非法: ${trimmed}` };
    map.set(parts[0], count);
    totalCount += count;
  }
  return { filesMap: map, totalFiles: map.size, totalCount };
}

export function writeBaseline(fileViolationsMap) {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  const lines = [START_MARKER];
  const sortedFiles = [...fileViolationsMap.keys()].sort();
  for (const f of sortedFiles) {
    const count = fileViolationsMap.get(f);
    if (count > 0) {
      lines.push(`${f} ${count}`);
    }
  }
  lines.push(END_MARKER);

  const block = lines.join('\n');
  const header = [
    '# i18n 源码硬编码中文门禁基线',
    '',
    '> 由 `node scripts/check-i18n-hardcoded.mjs --update-baseline` 自动生成/收紧。',
    '> 语义：实测 > 基线 → FAIL；实测 ≤ 基线 → PASS。存量按战役波次单调递减收敛。',
    '',
  ].join('\n');

  let currentContent = existsSync(BASELINE_PATH) ? readFileSync(BASELINE_PATH, 'utf8') : '';
  const start = currentContent.indexOf(START_MARKER);
  const end = currentContent.indexOf(END_MARKER);

  let finalOutput = '';
  if (start >= 0 && end > start) {
    finalOutput =
      currentContent.slice(0, start) + block + currentContent.slice(end + END_MARKER.length);
  } else {
    finalOutput = header + block + '\n';
  }
  writeFileSync(BASELINE_PATH, finalOutput, 'utf8');
}

// ── 打印指标修复指引 (--guide) ──────────────────────────────────────────────
export function printGuide(metric) {
  const guides = {
    hardcoded_chinese_in_source:
      'hardcoded_chinese_in_source 正确做法：源码中严禁包含未声明的硬编码中文或伪国际化拼接。应将中文文案抽取至 apps/crish-desktop/src/i18n/locales/zh-CN/ 对应领域模块，并在组件中使用 t(\'module.key\') 进行消费；若包含动态变量，使用 {param} 命名插值，严禁字符串拼接。',
    baseline_exceeded:
      'baseline_exceeded 正确做法：当前文件的硬编码中文数量超出了基线配额或新文件引入了硬编码中文。请将新增或存量中文抽取至 i18n 字典后重试。基线棘轮只降不升，严禁人为调大基线。',
    missing_baseline:
      'missing_baseline 正确做法：基线文件缺失或标记区损坏。严禁静默建线跳过门禁。若首次建线或合规收紧，请显式运行 `node scripts/check-i18n-hardcoded.mjs --update-baseline` 初始化或更新基线文件。',
  };
  console.log(`[check-i18n-hardcoded] --guide ${metric}：`);
  console.log(
    `  ${guides[metric] || '未知指标。可选：hardcoded_chinese_in_source / baseline_exceeded / missing_baseline'}`
  );
}

// ── 全仓扫描主流程 ──────────────────────────────────────────────────────────
export function runScan() {
  const t0 = Date.now();
  const allFiles = collectSourceFiles(DESKTOP_SRC);
  const fileViolationsMap = new Map();
  const allViolations = [];
  let astParsedCount = 0;

  for (const file of allFiles) {
    const rawContent = readFileSync(file, 'utf8');
    const stripped = stripComments(rawContent);
    if (!CHINESE_REGEX.test(stripped)) {
      continue;
    }

    astParsedCount++;
    const sf = ts.createSourceFile(
      file,
      rawContent,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    const relPath = toPosix(relative(REPO_ROOT, file));
    const violations = analyzeFileWithAst(relPath, rawContent, sf);
    if (violations.length > 0) {
      fileViolationsMap.set(relPath, violations.length);
      for (const v of violations) {
        allViolations.push(v);
      }
    }
  }

  const elapsed = Date.now() - t0;
  return {
    allFilesCount: allFiles.length,
    astParsedCount,
    fileViolationsMap,
    allViolations,
    elapsed,
  };
}

// ── CLI 执行入口 ────────────────────────────────────────────────────────────
const isDirectRun =
  process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')) ||
    fileURLToPath(import.meta.url) === resolve(process.argv[1]));

if (isDirectRun) {
  if (GUIDE_METRIC) {
    printGuide(GUIDE_METRIC);
    process.exit(0);
  }

  const { allFilesCount, astParsedCount, fileViolationsMap, allViolations, elapsed } = runScan();

  if (LIST) {
    console.log(
      `[check-i18n-hardcoded] 扫描完成: ${allFilesCount} 个文件 (AST深检: ${astParsedCount} 个), 耗时: ${elapsed}ms`
    );
    console.log(
      `[check-i18n-hardcoded] 检出硬编码中文违规: ${allViolations.length} 处, 涉及文件: ${fileViolationsMap.size} 个\n`
    );
    console.log('=== 源码硬编码中文详细清单 ===');
    for (const v of allViolations) {
      console.log(`${v.relPath}:${v.line}:${v.col} · ${v.text} · ${v.kind}`);
    }
    process.exit(0);
  }

  if (UPDATE_BASELINE) {
    const baseline = readBaseline();
    if (baseline && !baseline.__malformed) {
      const increases = [];
      for (const [file, count] of fileViolationsMap.entries()) {
        const quota = baseline.filesMap.get(file) || 0;
        if (count > quota) {
          increases.push(`${file}: 当前 ${count} > 基线 ${quota}`);
        }
      }
      if (increases.length > 0) {
        console.error('[check-i18n-hardcoded] FAIL: --update-baseline 拒绝抬高基线（棘轮只降不升）：');
        for (const inc of increases) console.error(`  - ${inc}`);
        process.exit(1);
      }
    }
    writeBaseline(fileViolationsMap);
    console.log(
      `✅ [check-i18n-hardcoded] --update-baseline 已写入基线：${toPosix(relative(REPO_ROOT, BASELINE_PATH))} (违规文件: ${fileViolationsMap.size} 个, 违规总数: ${allViolations.length} 处)`
    );
    process.exit(0);
  }

  const baseline = readBaseline();
  if (baseline === null) {
    console.error(
      `[check-i18n-hardcoded] FAIL: 基线文件缺失或标记区不完整: ${toPosix(relative(REPO_ROOT, BASELINE_PATH))}`
    );
    console.error(
      '  处置：显式运行 `node scripts/check-i18n-hardcoded.mjs --update-baseline` 初始化基线（严禁静默建线）。'
    );
    console.error(
      `  当前实测值（供建线参考）：违规文件 ${fileViolationsMap.size} 个，违规总数 ${allViolations.length} 处`
    );
    process.exit(1);
  }

  if (baseline.__malformed) {
    console.error(`[check-i18n-hardcoded] FAIL: 基线标记区格式非法: ${baseline.__malformed}`);
    process.exit(1);
  }

  const regressions = [];
  for (const [file, count] of fileViolationsMap.entries()) {
    const quota = baseline.filesMap.get(file);
    if (quota === undefined) {
      regressions.push(
        `[check-i18n-hardcoded] 源码硬编码中文 · ${file} · 当前 ${count} 处 · 基线阈值 0 (新文件未登记) · 正确做法: 将中文抽取至 i18n 字典并使用 t('key') 消费`
      );
    } else if (count > quota) {
      regressions.push(
        `[check-i18n-hardcoded] 源码硬编码中文 · ${file} · 当前 ${count} 处 · 基线阈值 ${quota} (超出配额) · 正确做法: 将新增中文抽取至 i18n 字典`
      );
    }
  }

  if (fileViolationsMap.size > baseline.totalFiles) {
    regressions.push(
      `[check-i18n-hardcoded] 违规文件总数 · 全仓 · 当前 ${fileViolationsMap.size} · 基线阈值 ${baseline.totalFiles} · 正确做法: 严禁增加含有硬编码中文的文件`
    );
  }

  if (allViolations.length > baseline.totalCount) {
    regressions.push(
      `[check-i18n-hardcoded] 违规项总数 · 全仓 · 当前 ${allViolations.length} · 基线阈值 ${baseline.totalCount} · 正确做法: 严禁引入新的硬编码中文项`
    );
  }

  if (regressions.length > 0) {
    console.error('\n[check-i18n-hardcoded] FAIL: 源码硬编码中文超出基线棘轮（只降不升）：');
    for (const r of regressions.slice(0, 30)) {
      console.error(`  ${r}`);
    }
    if (regressions.length > 30) {
      console.error(`  ... 另有 ${regressions.length - 30} 项违规未展开（运行 --list 查看全部）`);
    }
    console.error('\n==================== 明确修复指引 ====================');
    console.error('1. 将中文文案抽取至 apps/crish-desktop/src/i18n/locales/zh-CN/ 对应领域模块；');
    console.error('2. 在组件中使用 const { t } = useI18n() 并调用 t(\'module.key\')；');
    console.error('3. 动态文本使用参数化插值 {param}，严禁字符串拼接；');
    console.error('4. 修复后运行 `node scripts/check-i18n-hardcoded.mjs --update-baseline` 收紧基线。');
    console.error('======================================================');
    process.exit(1);
  }

  console.log(
    `[check-i18n-hardcoded] OK: 源码硬编码中文未超基线 (${fileViolationsMap.size} 文件 / ${allViolations.length} 处 <= 基线 ${baseline.totalFiles} 文件 / ${baseline.totalCount} 处)`
  );
  process.exit(0);
}
