#!/usr/bin/env node
/**
 * check:ui-negative-churn — UI 统一重塑负产出与死代码清剿刚性验收门禁
 *
 * 规范依据：
 * - 00-总方案实现规划.md §四 (全仓 Net-Negative LOC >= 650 行终审定额)
 * - 02-review-negative-churn-audit.md §6.2 (真实物理基线字典与零作弊守门引擎)
 * - 03-review-test-assets-protection.md §4.3 (收窄 --sep-* 与 --artifact-* 活变量保护)
 *
 * 验收规则：
 *   Rule 1: 物理真实重构文件行数必须真实下沉，禁止虚假路径免测送分
 *   Rule 2: 176 个物理死 Token 彻底绝迹，严禁误杀活跃滚动条与受保护 SEP / AICard / Artifact 变量
 *   Rule 3: 8 处 Button + 4 处 Input 裸写私有类名在真实物理文件中彻底拔除
 *   Rule 4: 全仓有效代码净负产出 Net LOC 必须 >= 650 行
 *
 * 选项：
 *   --report / --dry-run: 仅打印审计诊断报告，不执行 exit 1 阻断（适用于 Phase 0-4 过程监控）
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// ── --guide（T-DEBT-08：正确做法指引 · 五元规约） ─────────────────────────────
// 用法：node scripts/check-ui-negative-churn.mjs --guide → 打印违反项/定位/阈值/正确做法。
// 仅在直接运行且带 --guide 时早退；不带 flag 时既有行为零变化。
const __debt08GuideFlag = process.argv.includes('--guide');
if (__debt08GuideFlag) {
  const __debt08Guide = [
    "违反项：Rule 1 物理真实重构文件行数未真实下沉 / 虚假路径免测送分；--sep-* 与 --artifact-* 活变量被收窄保护外使用。",
    "文件:行号 / 当前值：FAIL 输出文件与实测行数对比物理基线字典（02-review §6.2）。",
    "阈值：全仓 Net-Negative LOC ≥ 650 行终审定额（00-总方案 §四）。",
    "正确做法：真实删除/下沉代码达成负产出；按 §6.2 物理基线字典核对，禁止注释搬家、拆文件凑负数。",
    "复核：node scripts/check-ui-negative-churn.mjs  # 期望 OK",
  ];
  console.log('[check-ui-negative-churn] 正确做法 · 五元规约\n');
  for (const l of __debt08Guide) console.log('  ' + l);
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const DESKTOP_SRC = join(REPO_ROOT, 'apps', 'crish-desktop', 'src');

const isReportOnly =
  process.argv.includes('--report') || process.argv.includes('--dry-run');

/** 统计有效代码行数（过滤块级注释与单行注释及空行） */
function countEffectiveLines(content) {
  const noComments = content.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = noComments.split('\n');
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    count++;
  }
  return count;
}

// 物理真实文件基线字典（经 2026-09-05 现场核实定额，严禁虚假目录）
const REAL_BASELINE_TARGETS = [
  {
    relPath: 'styles/tokens.css',
    baselineLines: 1758,
    minNetReduction: 250, // 目标削减 >= 250 行
    targetMaxLines: 1508,
  },
  {
    relPath: 'components/settings/SettingsPanel.module.css',
    baselineLines: 295,
    minNetReduction: 120, // 拔除 navBack(27) + search(44) + sidebarTab(53)
    targetMaxLines: 175,
  },
  {
    relPath: 'components/sidebar/Sidebar.module.css',
    baselineLines: 462,
    minNetReduction: 70, // 拔除 sidebarToggle(32) + settingsGear(29) + userCard(11)
    targetMaxLines: 392,
  },
  {
    relPath: 'components/sidebar/SidebarNav.module.css',
    baselineLines: 132,
    minNetReduction: 90, // 拔除 navItem(69) + search(30)
    targetMaxLines: 42,
  },
  {
    relPath: 'components/workspace/PreviewCard.module.css',
    baselineLines: 654,
    minNetReduction: 38, // 拔除 urlInput/urlClear(42)
    targetMaxLines: 616,
  },
  {
    relPath: 'components/diff/DiffCard.module.css',
    baselineLines: 906,
    minNetReduction: 30, // 拔除 inlineActionBtn(33)
    targetMaxLines: 876,
  },
  {
    relPath: 'components/chat-tool-call/ModernToolCall.module.css',
    baselineLines: 592,
    minNetReduction: 40, // 拔除 approvalBtn*(43)
    targetMaxLines: 552,
  },
  {
    relPath: 'components/chat-tool-call/ChatToolCallBlock.module.css',
    baselineLines: 1007,
    minNetReduction: 35, // 拔除 batchBarBtn(39)
    targetMaxLines: 972,
  },
  {
    relPath: 'components/files/FilesCard.module.css',
    baselineLines: 879,
    minNetReduction: 35, // 拔除 filesSoftBtn*(38)
    targetMaxLines: 844,
  },
  {
    relPath: 'components/overlay/FirstRunWizard.module.css',
    baselineLines: 260,
    minNetReduction: 35, // 拔除 firstRunBtn*(38)
    targetMaxLines: 225,
  },
  {
    relPath: 'components/top-bar/AppTopBar.module.css',
    baselineLines: 85,
    minNetReduction: 25, // 拔除 helpBtn(28)
    targetMaxLines: 60,
  },
  {
    relPath: 'components/shell/WindowControls.module.css',
    baselineLines: 40,
    minNetReduction: 25, // 拔除 winBtn(27)
    targetMaxLines: 15,
  },
];

// 必须彻底清零的真实死 Token 清单（严格保护活跃滚动条、受保护 SEP 与 custom-tags 活跃变量）
const DEAD_TOKEN_PATTERNS = [
  { name: '--thought-* (思考链死变量)', regex: /--thought-[a-zA-Z0-9_-]+\s*:/g },
  { name: '--banner-error-* (横幅死层)', regex: /--banner-error-[a-zA-Z0-9_-]+\s*:/g },
  {
    name: '--diff-line/gutter-* (Legacy Diff 兼容别名)',
    regex: /--diff-(?:line|gutter|word)-(?:add|del)-[a-zA-Z0-9_-]+\s*:/g,
  },
  {
    name: '--aicard-* (AI步骤卡片未消费占位，保护活跃 status/badge)',
    regex: /--aicard-(?!(?:status-|badge-))[a-zA-Z0-9_-]+\s*:/g,
  },
  {
    name: '--artifact-* (Artifacts未消费占位，保护 custom-tags 活跃消费)',
    regex: /--artifact-(?!(?:card-(?:bg|border|radius)|header-(?:bg|border)|btn-))[a-zA-Z0-9_-]+\s*:/g,
  },
  {
    name: '--md-table-* (废弃Markdown表格)',
    regex: /--md-table-(?:border|header-z|row|cell)-[a-zA-Z0-9_-]+\s*:/g,
  },
  {
    name: '--sep-* (已清剿的 12 个脚手架死变量)',
    regex: /--sep-(?:font-size-(?:base|sm|header)|bg-(?:canvas|panel-solid|item-selected)|border-hover|accent-(?:color|light)|ease-(?:spring|shrink)|duration-(?:open|close))\s*:/g,
  },
];

// 必须在物理真实文件中彻底拔除的业务私有裸写样式类名
const PURGED_CLASS_PATTERNS = [
  {
    file: 'components/settings/SettingsPanel.module.css',
    pattern: /\.navBack|\.searchWrap|\.sidebarTab/,
  },
  {
    file: 'components/sidebar/Sidebar.module.css',
    pattern: /\.sidebarToggleBtn|\.settingsGearBtn/,
  },
  {
    file: 'components/sidebar/SidebarNav.module.css',
    pattern: /\.navItem\b|\.navItem\[role='search'\]/,
  },
  {
    file: 'components/workspace/PreviewCard.module.css',
    pattern: /\.urlInput\b|\.urlClear\b/,
  },
  {
    file: 'components/top-bar/AppTopBar.module.css',
    pattern: /\.helpBtn\b/,
  },
  {
    file: 'components/shell/WindowControls.module.css',
    pattern: /\.winBtn\b/,
  },
  {
    file: 'components/diff/DiffCard.module.css',
    pattern: /\.inlineActionBtn\b/,
  },
  {
    file: 'components/chat-tool-call/ModernToolCall.module.css',
    pattern: /\.approvalBtn\b|\.approvalBtnPrimary\b/,
  },
];

function main() {
  console.log('🔍 [check:ui-negative-churn] 启动 UI 刚性负产出物理真实验收门禁...\n');
  let hasError = false;
  let totalEffectiveReduction = 0;

  console.log('📊 1. 物理真实文件有效代码行 (Effective LOC) 下沉审计:');
  console.log('----------------------------------------------------------------------');
  for (const item of REAL_BASELINE_TARGETS) {
    const fullPath = join(DESKTOP_SRC, item.relPath);
    if (!existsSync(fullPath)) {
      console.error(`  ❌ 致命错误：核心监控文件不存在: ${item.relPath} (零作弊守门拒绝送分)`);
      hasError = true;
      continue;
    }

    const content = readFileSync(fullPath, 'utf8');
    const currentLines = countEffectiveLines(content);
    const actualReduction = item.baselineLines - currentLines;
    totalEffectiveReduction += actualReduction;

    const pass = actualReduction >= item.minNetReduction;
    const status = pass ? '✅ 达标' : '❌ 未达标';
    console.log(
      `  ${status} ${item.relPath.padEnd(46)}: 基线 ${item.baselineLines}L -> 当前 ${currentLines}L (净减 ${actualReduction}L / 要求 ≥${item.minNetReduction}L)`
    );

    if (!pass) hasError = true;
  }

  console.log('\n📊 2. 废弃死 Token (Dead CSS Variables) 清零审计 (tokens.css):');
  console.log('----------------------------------------------------------------------');
  const tokensPath = join(DESKTOP_SRC, 'styles', 'tokens.css');
  const tokensContent = readFileSync(tokensPath, 'utf8');

  for (const pattern of DEAD_TOKEN_PATTERNS) {
    const matches = tokensContent.match(pattern.regex) || [];
    if (matches.length > 0) {
      console.error(`  ❌ 发现残留死 Token: ${pattern.name} (残留 ${matches.length} 处)`);
      hasError = true;
    } else {
      console.log(`  ✅ 彻底绝迹: ${pattern.name}`);
    }
  }

  console.log('\n📊 3. 业务私有原生类名拔除审计 (Purged Private Classes):');
  console.log('----------------------------------------------------------------------');
  for (const item of PURGED_CLASS_PATTERNS) {
    const fullPath = join(DESKTOP_SRC, item.file);
    if (!existsSync(fullPath)) {
      console.error(`  ❌ 目标文件缺失: ${item.file}`);
      hasError = true;
      continue;
    }
    const content = readFileSync(fullPath, 'utf8');
    if (item.pattern.test(content)) {
      console.error(`  ❌ 发现未拔除的私有类名: ${item.file} 依然匹配 ${item.pattern}`);
      hasError = true;
    } else {
      console.log(`  ✅ 私有类彻底绝迹: ${item.file}`);
    }
  }

  console.log('\n📊 4. 全仓 Git 物理净负产出 (Net-Negative LOC) 刚性校验:');
  console.log('----------------------------------------------------------------------');
  try {
    const diffStat = execSync('git diff --stat HEAD apps/crish-desktop/src/', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    console.log(`  Git Diff 状态: ${diffStat.trim().split('\n').slice(-1)[0] || '无改动统计'}`);
  } catch {
    console.log('  (非 Git 或无未提交变更环境，以有效行下沉统计为准)');
  }

  console.log(`  全仓核心文件有效行净下沉累计: ${totalEffectiveReduction} 行 (硬指标 ≥ 650 行)`);
  if (totalEffectiveReduction < 650) {
    console.error(`  ❌ 净下沉行数未达到 650 行底线！`);
    hasError = true;
  } else {
    console.log(`  ✅ 负产出硬指标达成！`);
  }

  if (hasError) {
    if (isReportOnly) {
      console.log('\nℹ️ [INFO] 当前处于过程审计模式 (--report)，已输出诊断状态，跳过阻断。');
      process.exit(0);
    }
    console.error('\n🚨 [FATAL] 负产出与死代码验收未通过！请修正上述违规项后再行合并。');
    process.exit(1);
  } else {
    console.log('\n🎉 [PASS] 所有刚性负产出指标全部达成，零死代码残留，放行收口！');
    process.exit(0);
  }
}

main();
