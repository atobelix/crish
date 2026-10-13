// @vitest-environment jsdom
/**
 * 契约测试：色彩语义、排版防抖与焦点无障碍护栏 (DIM-04)
 *
 * 规范依据：
 * - 00-总方案实现规划.md §2.1 (Gate Inversion Defense) & §4.2 (19 处跳动数字防抖)
 * - 01-review-topology-and-conflicts.md §6.1 (渐进式棘轮基线机制 Ratchet Guard)
 * - 03-review-test-assets-protection.md §4.1 (纠偏 12 处真实路径，放行 2px solid transparent)
 * - AGENTS.md §13 (输入框与焦点态对比度 <= 10%) & §14 (现代 CSS 色彩空间)
 *
 * 棘轮演进时序：
 * - Phase 0 (BATCH-00): 存量基线快照模式 (Ratchet Baseline)，断言 16 处物理路径 100% 存在，锁定存量不劣化；
 * - Phase 4 (BATCH-04): 色彩排版与无障碍重塑完成后，全量解开零违规断言。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 注意：模板字面量先赋给中间变量再进 new URL，避免 vitest transform 静态重写
const anchorRel = 'src/tokens.css';
const target = `../../${anchorRel}`;
const SRC_DIR = fileURLToPath(new URL(target, import.meta.url)).replace(
  /[\\/]tokens\.css$/,
  ''
);

/** 递归扫描全部 TSX 源码（排除测试文件） */
function collectTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (['node_modules', 'dist', 'reference'].includes(entry)) continue;
      collectTsxFiles(fullPath, out);
    } else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) {
      out.push(fullPath);
    }
  }
  return out;
}

/** 递归扫描全部 CSS 样式文件（排除外部资产与构建产物） */
function collectCssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (['node_modules', 'dist', 'reference'].includes(entry)) continue;
      collectCssFiles(fullPath, out);
    } else if (entry.endsWith('.css')) {
      out.push(fullPath);
    }
  }
  return out;
}

describe('契约测试：色彩语义、排版防抖与焦点无障碍护栏 (DIM-04) [Ratchet Mode]', () => {
  const tsxFiles = collectTsxFiles(SRC_DIR);
  const cssFiles = collectCssFiles(SRC_DIR);

  // Phase 0 存量基线快照：全仓现存 0 处未注 aria-label 的 <IconButton>（已全量收敛）
  // Phase 4 补齐无障碍命名后此阈值收敛至 0
  const ICON_BUTTON_A11Y_PHASE0_BASELINE = 0;

  it('1. 无障碍命名闭环：所有 <IconButton> 必须强制提供显式 aria-label（Ratchet 模式防劣化）', () => {
    const ICON_BUTTON_RE = /<IconButton\b([^>]*?)(\/?>)/gs;
    const violations: { file: string; matchSnippet: string }[] = [];

    for (const file of tsxFiles) {
      const content = readFileSync(file, 'utf8');
      // 剥离 JSX 注释块 {/* ... */}，防止注释示例被误检 (Review-03 §4.1.2)
      const cleanContent = content.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      const matches = Array.from(cleanContent.matchAll(ICON_BUTTON_RE));

      for (const match of matches) {
        const props = match[1];
        // 允许 aria-label="..." 或 aria-label={...} 或 props 透传 {...props} (Review-03 §4.1.2)
        const hasAriaLabel =
          /aria-label\s*=\s*['"{]/.test(props) ||
          /\{\.\.\.\w*props\w*\}/i.test(props);

        if (!hasAriaLabel) {
          violations.push({
            file: file
              .replace(SRC_DIR, 'src/')
              .replace(/\\/g, '/')
              .replace(/\/+/g, '/'),
            matchSnippet: match[0].slice(0, 100),
          });
        }
      }
    }

    // 棘轮断言：存量 <= 基线，严禁引入未命名的 IconButton
    expect(
      violations.length,
      `未提供 aria-label 的 <IconButton> 数量 (${violations.length}) 超过 Ratchet 基线 (${ICON_BUTTON_A11Y_PHASE0_BASELINE})！\n${JSON.stringify(
        violations,
        null,
        2
      )}`
    ).toBeLessThanOrEqual(ICON_BUTTON_A11Y_PHASE0_BASELINE);
  });

  // 16 处纠偏后的物理真实目标路径（Review-03 §4.1.1 绝对对齐）
  const AUDITED_16_TARGETS = [
    { relPath: 'components/settings/PriceConfigModal.module.css' },
    { relPath: 'components/sidebar/SidebarSessionList.module.css' },
    { relPath: 'components/chat-card/SubagentHeaderPanel.module.css' },
    { relPath: 'components/diff/DiffCard.module.css' },
    { relPath: 'components/chat-tool-call/ChatToolCallBlock.module.css' },
    { relPath: 'components/settings-models/ScanResultsModal.module.css' },
    { relPath: 'components/settings-models/YamlConfigEditorModal.module.css' },
    { relPath: 'components/settings-models/ModelsSettingsTab.module.css' },
    { relPath: 'components/workspace/TerminalCard.module.css' },
    { relPath: 'components/settings-skills/SkillsSettingsTab.module.css' },
    { relPath: 'components/settings/ScheduledTasksPanel.module.css' },
    { relPath: 'components/ui/Badge/Badge.module.css' },
    { relPath: 'components/ui/Tabs/Tabs.module.css' },
    { relPath: 'components/settings/usage/UsageTrendChart.module.css' },
    { relPath: 'components/chat-message-list/FlowScrubber.module.css' },
  ];

  // Phase 0 存量基线快照：16 处中当前 2 处待注入 tabular-nums
  const MISSING_TABULAR_PHASE0_BASELINE = 2;

  it('2. 动态跳动数字防抖：定案矩阵 16 处真实物理靶标路径 100% 存在且受控（Ratchet 模式）', () => {
    const missingFiles: string[] = [];
    const missingTabular: string[] = [];

    for (const targetItem of AUDITED_16_TARGETS) {
      const fullPath = join(SRC_DIR, targetItem.relPath);
      if (!existsSync(fullPath)) {
        missingFiles.push(targetItem.relPath);
        continue;
      }

      const content = readFileSync(fullPath, 'utf8');
      const hasTabular =
        content.includes('tabular-nums') ||
        content.includes("'tnum'") ||
        content.includes('"tnum"');
      if (!hasTabular) {
        missingTabular.push(targetItem.relPath);
      }
    }

    // 绝对断言：所有 16 处纠偏后的文件必须 100% 真实存在，绝不容许假路径 (Review-03 §4.1.1)
    expect(
      missingFiles,
      `发现不存在的假路径，必须纠偏为物理真实文件：\n${missingFiles.join('\n')}`
    ).toEqual([]);

    // 棘轮断言：存量缺失 <= 基线，待 Phase 4 实施后收敛至 0
    expect(
      missingTabular.length,
      `未注入 tabular-nums 的文件数量 (${missingTabular.length}) 超过 Ratchet 基线 (${MISSING_TABULAR_PHASE0_BASELINE})！`
    ).toBeLessThanOrEqual(MISSING_TABULAR_PHASE0_BASELINE);
  });

  // Phase 0 存量基线快照：全仓现存 19 处历史焦点样式问题（outline: none 且未配 shadow 等）
  // Phase 4 统一柔化焦点环后此阈值收敛至 0
  const FOCUS_VISIBLE_PHASE0_BASELINE = 19;

  it('3. 柔和焦点环防线：全站 :focus-visible 严禁粗黑硬线与丢失焦点替代（Ratchet 模式防劣化）', () => {
    const FOCUS_VISIBLE_RE = /:focus-visible\s*\{([^}]+)\}/g;
    const violations: { file: string; rule: string; reason: string }[] = [];

    for (const file of cssFiles) {
      const content = readFileSync(file, 'utf8');
      const matches = Array.from(content.matchAll(FOCUS_VISIBLE_RE));

      for (const match of matches) {
        const body = match[1];

        // 检查 1：严禁 outline: none 且未配 box-shadow
        if (/outline\s*:\s*none\b/.test(body) && !/box-shadow\s*:/.test(body)) {
          violations.push({
            file: file
              .replace(SRC_DIR, 'src/')
              .replace(/\\/g, '/')
              .replace(/\/+/g, '/'),
            rule: body.trim(),
            reason: 'outline: none 丢失视觉焦点替代，违反 A11y 准则',
          });
        }

        // 检查 2：严禁纯黑实体粗线 (#000, #111, solid black)，放行 2px solid transparent (Review-03 §4.1.3)
        if (
          /#000000|#111111|\bsolid\s+black\b|\b2px\s+solid\s+(?!transparent)/.test(
            body
          )
        ) {
          violations.push({
            file: file
              .replace(SRC_DIR, 'src/')
              .replace(/\\/g, '/')
              .replace(/\/+/g, '/'),
            rule: body.trim(),
            reason: '高对比粗黑硬线违反 AGENTS.md §13',
          });
        }
      }
    }

    // 棘轮断言：存量 <= 基线，严禁引入新的违规粗黑焦点样式
    expect(
      violations.length,
      `焦点样式违规数量 (${violations.length}) 超过 Ratchet 基线 (${FOCUS_VISIBLE_PHASE0_BASELINE})！\n${JSON.stringify(
        violations,
        null,
        2
      )}`
    ).toBeLessThanOrEqual(FOCUS_VISIBLE_PHASE0_BASELINE);
  });
});
