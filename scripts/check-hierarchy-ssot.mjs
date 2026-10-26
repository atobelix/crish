#!/usr/bin/env node
/**
 * scripts/check-hierarchy-ssot.mjs
 * 视觉层级与清晰度 SSOT 门禁（P0-U06 / 00-总方案 §11.1 / P0 详案 §8）
 *
 * 覆盖 9 个规范区域：
 * 1. chat-message-row/
 * 2. chat-message/
 * 3. chat-message-list/
 * 4. chat-tool-call/
 * 5. chat-composer/
 * 6. sidebar/
 * 7. top-bar/
 * 8. binary-tree/PaneHeader*
 * 9. chat-card/UnitChromeActions*
 *
 * 三大规则：
 * H1 字阶：检测 font-size, line-height, font-weight 字面量及非 §4.2 允许的旧字号 token
 * H2 描边：检测展示型容器中的实体描边声明（放行 --edge-control, --edge-focus, --edge-semantic-*, --edge-rim）
 * H3 强调与主题特判：检测组件 CSS 内 html[data-theme 主题特判选择器，以及非白名单组件中的 --accent-*
 *
 * 棘轮机制（只减不增）：
 * - 比对 docs/visual-hierarchy-clarity-analysis/baseline/hierarchy-ratchet.json
 * - 实测 > 基线 => FAIL (process.exit(1))
 * - 实测 <= 基线 => PASS (process.exit(0))
 * - 支持 --update-baseline / --update（只允许降低或维持基线，禁止向上放宽）
 * - 支持 --strict-zero（供 P9 终态全归零验证）
 * - 支持 --guide（五元规约指引）
 * - 支持 --list（列出所有指标与覆盖域）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── --guide（五元规约指引） ──────────────────────────────────────────────────
if (process.argv.includes('--guide')) {
  console.log('[check-hierarchy-ssot] 正确做法 · 五元规约\n');
  const guideLines = [
    '违反项：',
    '  - H1 字阶：在覆盖域内使用裸 font-size / line-height / font-weight 字面量，或使用非 §4.2 允许的旧字阶 token；',
    '  - H2 描边：在展示型容器中声明实体 border 描边（未走明度阶梯或未引用 --edge-* 预算）；',
    '  - H3 强调与特判：组件 CSS 内硬编码 html[data-theme] 主题特判，或在非白名单组件内使用 --accent-*。',
    '覆盖区域（9 域）：',
    '  chat-message-row, chat-message, chat-message-list, chat-tool-call, chat-composer,',
    '  sidebar, top-bar, binary-tree/PaneHeader*, chat-card/UnitChromeActions*',
    '定位与当前值：',
    '  - 运行 node scripts/check-hierarchy-ssot.mjs 输出违规明细（文件:行号）与当前统计表；',
    '  - 基线文件：docs/visual-hierarchy-clarity-analysis/baseline/hierarchy-ratchet.json。',
    '阈值原则：',
    '  - 棘轮原则（只减不增）：任何区域违规数 > 基线即阻断；',
    '  - 终态目标（P9）：全覆盖域全部归零（--strict-zero）。',
    '正确做法：',
    '  - H1：字体改用排版角色 var(--type-*) 或 §4.2 标准字阶 var(--font-size-caption/meta/body/subhead/heading/title)；',
    '  - H2：展示型容器去除 border，依靠明度差分层；可交互表单使用 --edge-control，高亮使用 --edge-rim；',
    '  - H3：去除 html[data-theme]，主题差异由 Design Token 统一表达；稳态信息中性化，强调色归还主行动/错误。',
    '复核命令：',
    '  npm run check:hierarchy-ssot',
  ];
  for (const line of guideLines) console.log('  ' + line);
  process.exit(0);
}

// ── --list（列出指标与覆盖域） ────────────────────────────────────────────────
if (process.argv.includes('--list')) {
  console.log('[check-hierarchy-ssot] 校验指标与覆盖域列表：\n');
  console.log('规则：');
  console.log('  H1: typography_violations (font-size/line-height/font-weight literals & non-standard tokens)');
  console.log('  H2: presentation_borders  (border/outline declarations not in --edge-* budget)');
  console.log('  H3: theme_and_accent      (html[data-theme] overrides & unauthorized --accent-*)');
  console.log('\n覆盖域：');
  console.log('  1. chat-message-row (dir)');
  console.log('  2. chat-message (dir)');
  console.log('  3. chat-message-list (dir)');
  console.log('  4. chat-tool-call (dir)');
  console.log('  5. chat-composer (dir)');
  console.log('  6. sidebar (dir)');
  console.log('  7. top-bar (dir)');
  console.log('  8. binary-tree/PaneHeader (file prefix)');
  console.log('  9. chat-card/UnitChromeActions (file prefix)');
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const COMPONENTS_ROOT = path.resolve(REPO_ROOT, 'apps/crish-desktop/src/components');

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const BASELINE_PATH_DEFAULT = path.resolve(
  REPO_ROOT,
  'docs/visual-hierarchy-clarity-analysis/baseline/hierarchy-ratchet.json'
);
const BASELINE_PATH = getArgValue('--baseline')
  ? path.resolve(REPO_ROOT, getArgValue('--baseline'))
  : BASELINE_PATH_DEFAULT;

const UPDATE_BASELINE = process.argv.includes('--update-baseline') || process.argv.includes('--update');
const STRICT_ZERO = process.argv.includes('--strict-zero');

// ── 9 个覆盖域定义 ────────────────────────────────────────────────────────────
const DOMAIN_DEFS = [
  { id: 'chat-message-row', type: 'dir', path: 'chat-message-row' },
  { id: 'chat-message', type: 'dir', path: 'chat-message' },
  { id: 'chat-message-list', type: 'dir', path: 'chat-message-list' },
  { id: 'chat-tool-call', type: 'dir', path: 'chat-tool-call' },
  { id: 'chat-composer', type: 'dir', path: 'chat-composer' },
  { id: 'sidebar', type: 'dir', path: 'sidebar' },
  { id: 'top-bar', type: 'dir', path: 'top-bar' },
  { id: 'binary-tree/PaneHeader', type: 'prefix', dir: 'binary-tree', prefix: 'PaneHeader' },
  { id: 'chat-card/UnitChromeActions', type: 'prefix', dir: 'chat-card', prefix: 'UnitChromeActions' },
];

// §4.2 允许的标准字号 token
const ALLOWED_FONT_SIZES = new Set([
  '--font-size-caption',
  '--font-size-meta',
  '--font-size-body',
  '--font-size-subhead',
  '--font-size-heading',
  '--font-size-title',
]);

/**
 * 递归获取属于该覆盖域的 CSS 文件绝对路径
 */
function getDomainFiles(domain) {
  const files = [];
  if (domain.type === 'dir') {
    const dirPath = path.join(COMPONENTS_ROOT, domain.path);
    if (!fs.existsSync(dirPath)) return files;
    function walk(d) {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) {
          walk(full);
        } else if (ent.name.endsWith('.css')) {
          files.push(full);
        }
      }
    }
    walk(dirPath);
  } else {
    const dirPath = path.join(COMPONENTS_ROOT, domain.dir);
    if (!fs.existsSync(dirPath)) return files;
    for (const ent of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!ent.isDirectory() && ent.name.startsWith(domain.prefix) && ent.name.endsWith('.css')) {
        files.push(path.join(dirPath, ent.name));
      }
    }
  }
  return files.sort();
}

/**
 * 剥离块注释并保留换行符，以确保精确行号对齐
 */
function stripComments(content) {
  return content.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    const nls = match.match(/\n/g);
    return nls ? nls.join('') : '';
  });
}

/**
 * 扫描单个 CSS 文件，提取违规项
 */
function scanCssFile(filePath, domainId) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const clean = stripComments(raw);
  const lines = clean.split('\n');

  const h1 = [];
  const h2 = [];
  const h3 = [];

  let ignoreNext = false;

  lines.forEach((line, lineIdx) => {
    const lineNum = lineIdx + 1;
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed.includes('hierarchy-ssot-ignore') || trimmed.includes('ssot-color-ignore')) {
      ignoreNext = true;
      return;
    }
    if (ignoreNext) {
      ignoreNext = false;
      return;
    }

    // ── H3 检查：主题特判选择器与未授权强调色 ─────────────────────────
    // 1. html[data-theme 选择器
    const themeMatch = trimmed.match(/html\[data-theme/g);
    if (themeMatch) {
      themeMatch.forEach(() => {
        h3.push({
          line: lineNum,
          rule: 'H3',
          snippet: trimmed.slice(0, 80),
          message: '组件 CSS 严禁硬编码 html[data-theme] 选择器，主题差异必须经 Token 表达',
        });
      });
    }

    // 2. --accent-* 强调色 token（非白名单组件内）
    const accentMatch = trimmed.match(/--accent-[a-zA-Z0-9_-]+/g);
    if (accentMatch) {
      accentMatch.forEach((tok) => {
        h3.push({
          line: lineNum,
          rule: 'H3',
          snippet: trimmed.slice(0, 80),
          message: `未收敛强调色 token: ${tok}（稳态信息须中性化）`,
        });
      });
    }

    // ── H1 检查：字阶、行高、字重字面量及非法字阶 token ────────────────
    // 1. font-size
    const fsMatch = trimmed.match(/(?:^|[;{\s])font-size\s*:\s*([^;]+)/i);
    if (fsMatch) {
      const val = fsMatch[1].trim();
      if (val !== 'inherit') {
        const varMatch = val.match(/var\(\s*(--[a-zA-Z0-9_-]+)/);
        if (varMatch) {
          const tok = varMatch[1];
          if (!ALLOWED_FONT_SIZES.has(tok) && !tok.startsWith('--type-')) {
            h1.push({
              line: lineNum,
              rule: 'H1',
              snippet: trimmed.slice(0, 80),
              message: `使用了非 §4.2 允许的旧字阶 token: ${tok}`,
            });
          }
        } else {
          h1.push({
            line: lineNum,
            rule: 'H1',
            snippet: trimmed.slice(0, 80),
            message: `硬编码 font-size 字面量: ${val}`,
          });
        }
      }
    }

    // 2. line-height
    const lhMatch = trimmed.match(/(?:^|[;{\s])line-height\s*:\s*([^;]+)/i);
    if (lhMatch) {
      const val = lhMatch[1].trim();
      if (val !== 'inherit') {
        if (!val.includes('var(')) {
          h1.push({
            line: lineNum,
            rule: 'H1',
            snippet: trimmed.slice(0, 80),
            message: `硬编码 line-height 字面量: ${val}`,
          });
        }
      }
    }

    // 3. font-weight
    const fwMatch = trimmed.match(/(?:^|[;{\s])font-weight\s*:\s*([^;]+)/i);
    if (fwMatch) {
      const val = fwMatch[1].trim();
      if (val !== 'inherit' && !val.includes('var(')) {
        if (/^[1-9]00$/.test(val) || /^(?:bold|normal)$/i.test(val)) {
          h1.push({
            line: lineNum,
            rule: 'H1',
            snippet: trimmed.slice(0, 80),
            message: `硬编码 font-weight 字面量: ${val}`,
          });
        }
      }
    }

    // 4. font 简写
    const fontMatch = trimmed.match(/(?:^|[;{\s])font\s*:\s*([^;]+)/i);
    if (fontMatch) {
      const val = fontMatch[1].trim();
      if (val !== 'inherit' && !val.startsWith('var(--type-')) {
        h1.push({
          line: lineNum,
          rule: 'H1',
          snippet: trimmed.slice(0, 80),
          message: `非规范角色 font 简写: ${val}（应使用 var(--type-*)）`,
        });
      }
    }

    // ── H2 检查：展示型容器中的实体描边声明 ───────────────────────────
    // 放行白名单：--edge-control, --edge-focus, --edge-semantic-*, --edge-rim
    if (!/--edge-(?:control|focus|semantic|rim)/.test(trimmed)) {
      if (domainId === 'top-bar' && /border-bottom\s*:\s*none/.test(trimmed)) {
        // top-bar 顶栏 reset 放行
      } else if (domainId === 'binary-tree/PaneHeader' && /border-bottom\s*:\s*none/.test(trimmed)) {
        // PaneHeader 标签底线 reset 放行
      } else {
        const bMatch = trimmed.match(/(?:^|[;{\s])(border(?:-(?:top|right|bottom|left|block|inline|color|width|style))?)\s*:\s*([^;]+)/i);
        if (bMatch) {
          h2.push({
            line: lineNum,
            rule: 'H2',
            snippet: trimmed.slice(0, 80),
            message: `展示型容器描边声明: ${bMatch[1]}: ${bMatch[2].trim()}`,
          });
        }
      }
    }
  });

  return { h1, h2, h3 };
}

// ── 执行全量扫描 ──────────────────────────────────────────────────────────────
const scanResults = {};
const allViolations = [];
let totalCurrentH1 = 0;
let totalCurrentH2 = 0;
let totalCurrentH3 = 0;

for (const domain of DOMAIN_DEFS) {
  const files = getDomainFiles(domain);
  const domainViolations = { h1: [], h2: [], h3: [] };

  for (const filePath of files) {
    const relPath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
    const { h1, h2, h3 } = scanCssFile(filePath, domain.id);

    for (const item of h1) {
      domainViolations.h1.push({ file: relPath, ...item });
      allViolations.push({ domain: domain.id, file: relPath, ...item });
    }
    for (const item of h2) {
      domainViolations.h2.push({ file: relPath, ...item });
      allViolations.push({ domain: domain.id, file: relPath, ...item });
    }
    for (const item of h3) {
      domainViolations.h3.push({ file: relPath, ...item });
      allViolations.push({ domain: domain.id, file: relPath, ...item });
    }
  }

  scanResults[domain.id] = {
    fileCount: files.length,
    h1: domainViolations.h1.length,
    h2: domainViolations.h2.length,
    h3: domainViolations.h3.length,
    violations: domainViolations,
  };

  totalCurrentH1 += domainViolations.h1.length;
  totalCurrentH2 += domainViolations.h2.length;
  totalCurrentH3 += domainViolations.h3.length;
}

// ── --update-baseline 处理 ───────────────────────────────────────────────────
if (UPDATE_BASELINE) {
  let existingBaseline = null;
  if (fs.existsSync(BASELINE_PATH)) {
    try {
      existingBaseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    } catch (err) {
      console.error(`[check-hierarchy-ssot] 警告: 既有基线文件格式损毁 (${err.message})，将重新初始化。`);
    }
  }

  // 严格执行棘轮只减不增原则：若已存在有效基线，任一域 current > baseline 则拒绝更新并报错
  if (existingBaseline && existingBaseline.directories) {
    const ratchetViolations = [];
    for (const domain of DOMAIN_DEFS) {
      const base = existingBaseline.directories[domain.id];
      if (base) {
        const cur = scanResults[domain.id];
        if (cur.h1 > base.h1) {
          ratchetViolations.push(`${domain.id} H1 违规增加: ${cur.h1} > ${base.h1}`);
        }
        if (cur.h2 > base.h2) {
          ratchetViolations.push(`${domain.id} H2 违规增加: ${cur.h2} > ${base.h2}`);
        }
        if (cur.h3 > base.h3) {
          ratchetViolations.push(`${domain.id} H3 违规增加: ${cur.h3} > ${base.h3}`);
        }
      }
    }
    if (ratchetViolations.length > 0) {
      console.error('[check-hierarchy-ssot] FAIL: 拒绝写入基线！违规数违反只减不增棘轮原则：');
      for (const rv of ratchetViolations) console.error(`  - ${rv}`);
      process.exit(1);
    }
  }

  const baselineData = {
    version: 1,
    description: 'Visual Hierarchy & Clarity Ratchet Baseline (H1 Typography, H2 Borders, H3 Themes/Accents)',
    updated_at: new Date().toISOString(),
    limits: {
      total_h1: totalCurrentH1,
      total_h2: totalCurrentH2,
      total_h3: totalCurrentH3,
    },
    directories: {},
  };

  for (const domain of DOMAIN_DEFS) {
    baselineData.directories[domain.id] = {
      h1: scanResults[domain.id].h1,
      h2: scanResults[domain.id].h2,
      h3: scanResults[domain.id].h3,
    };
  }

  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baselineData, null, 2) + '\n', 'utf8');
  console.log(`[check-hierarchy-ssot] OK: 成功更新基线文件 -> ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
  console.log(`  Limits: H1=${totalCurrentH1}, H2=${totalCurrentH2}, H3=${totalCurrentH3}`);
  process.exit(0);
}

// ── 检查基线文件存在性 ───────────────────────────────────────────────────────
if (!fs.existsSync(BASELINE_PATH)) {
  console.error(`[check-hierarchy-ssot] FAIL: 缺失基线文件: ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
  console.error('基线缺失视为门禁失效漏洞。请运行 `node scripts/check-hierarchy-ssot.mjs --update-baseline` 生成初始基线。');
  process.exit(1);
}

let baseline;
try {
  baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
} catch (err) {
  console.error(`[check-hierarchy-ssot] FAIL: 基线文件损坏无法解析 JSON: ${err.message}`);
  process.exit(1);
}

// ── 比对实测值与基线（棘轮原则：只减不增） ──────────────────────────────────
let hasFailure = false;
const failureDetails = [];
const summaryRows = [];

for (const domain of DOMAIN_DEFS) {
  const cur = scanResults[domain.id];
  const base = (baseline.directories && baseline.directories[domain.id]) || { h1: 0, h2: 0, h3: 0 };

  const h1Exceeded = STRICT_ZERO ? cur.h1 > 0 : cur.h1 > base.h1;
  const h2Exceeded = STRICT_ZERO ? cur.h2 > 0 : cur.h2 > base.h2;
  const h3Exceeded = STRICT_ZERO ? cur.h3 > 0 : cur.h3 > base.h3;

  if (h1Exceeded || h2Exceeded || h3Exceeded) {
    hasFailure = true;
    for (const v of cur.violations.h1) {
      failureDetails.push(`[${domain.id}] ${v.file}:${v.line} (${v.rule}) ${v.message} :: ${v.snippet}`);
    }
    for (const v of cur.violations.h2) {
      failureDetails.push(`[${domain.id}] ${v.file}:${v.line} (${v.rule}) ${v.message} :: ${v.snippet}`);
    }
    for (const v of cur.violations.h3) {
      failureDetails.push(`[${domain.id}] ${v.file}:${v.line} (${v.rule}) ${v.message} :: ${v.snippet}`);
    }
  }

  summaryRows.push({
    domain: domain.id,
    files: cur.fileCount,
    h1: `${cur.h1}/${base.h1}`,
    h2: `${cur.h2}/${base.h2}`,
    h3: `${cur.h3}/${base.h3}`,
    status: (h1Exceeded || h2Exceeded || h3Exceeded) ? 'FAIL' : 'PASS',
  });
}

// ── 输出校验结果 ─────────────────────────────────────────────────────────────
console.log('\n=== Visual Hierarchy & Clarity SSOT 门禁校验报告 ===');
console.log('--------------------------------------------------------------------------------');
console.log(
  '覆盖域'.padEnd(30) +
  '文件数'.padEnd(8) +
  'H1(实测/基线)'.padEnd(16) +
  'H2(实测/基线)'.padEnd(16) +
  'H3(实测/基线)'.padEnd(16) +
  '状态'
);
console.log('--------------------------------------------------------------------------------');
for (const row of summaryRows) {
  console.log(
    row.domain.padEnd(30) +
    String(row.files).padEnd(8) +
    row.h1.padEnd(16) +
    row.h2.padEnd(16) +
    row.h3.padEnd(16) +
    row.status
  );
}
console.log('--------------------------------------------------------------------------------');
console.log(
  '总计'.padEnd(30) +
  '38'.padEnd(8) +
  `${totalCurrentH1}/${baseline.limits?.total_h1 ?? '-'}`.padEnd(16) +
  `${totalCurrentH2}/${baseline.limits?.total_h2 ?? '-'}`.padEnd(16) +
  `${totalCurrentH3}/${baseline.limits?.total_h3 ?? '-'}`.padEnd(16) +
  (hasFailure ? 'FAIL' : 'PASS')
);
console.log('================================================================================\n');

if (hasFailure) {
  console.error(`[check-hierarchy-ssot] FAIL: 视觉层级违规数超出棘轮基线（共 ${failureDetails.length} 处违规明细）：\n`);
  for (const item of failureDetails.slice(0, 100)) {
    console.error('  ' + item);
  }
  if (failureDetails.length > 100) {
    console.error(`  ... 另有 ${failureDetails.length - 100} 条未展开`);
  }
  console.error('\n请遵循 docs/visual-hierarchy-clarity-analysis/P0-基线与度量底座.md 规范收敛或修复样式。');
  process.exit(1);
}

console.log('[check-hierarchy-ssot] OK: 全部 9 个覆盖域均满足棘轮基线（current <= baseline）。门禁通过！');
process.exit(0);
