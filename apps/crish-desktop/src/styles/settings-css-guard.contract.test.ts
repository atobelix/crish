// @vitest-environment jsdom
/**
 * 契约测试：设置范围 CSS 裸 px 高度守门（SETTINGS-CSS-HEIGHT-GUARD，R8 落地）
 *
 * 背景（审计 H4）：设置各页曾大量把控件/容器高度写死为裸 px，与
 * --control-height-* / --space-* 的 token 体系脱节。本守门采用「棘轮」形态
 * （与 check-i18n-hardcoded 的基线文化一致）：
 * - 已达标文件（GUARDED_FILES）：一行裸 px 高度都不许有，回归即红；
 * - 已知债务文件（DEBT_FILES）：计数封顶，只许减不许增；减到 0 必须移入
 *   已达标清单（测试会以失败提示强制迁移），债务只减不增地烧完；
 * - 设置范围内出现清单外的新 CSS 文件即红，强制先归类再合入。
 *
 * 计数口径：剥离注释后，匹配 height / min-height / max-height 的裸 px
 * 声明；line-height（字阶体系另有口径）与 --* 自定义属性定义（本地刻度
 * 定义本身）不计。
 *
 * 未设守门的一项（评估后否决，见 R8 报告）：「border 作行分隔线」无法机械
 * 守门——定版 SettingsUI 的行间分隔本身就是 hairline border-bottom
 * （SettingsUI.module.css .settingsUiRow），且存量 border-top/bottom 多为
 * 弹窗头尾/分区分隔等 chrome 用途，文本扫描无法与「行分隔」区分。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(currentDir, '..');

/** 设置范围：设置各页与承载「登录设备」页的账号域 CSS */
const SCOPE_DIRS = [
  'components/settings',
  'components/settings-extensions',
  'components/settings-mcp',
  'components/settings-models',
  'components/settings-skills',
  'components/account',
] as const;

/** 已达标：零裸 px 高度，回归即红 */
const GUARDED_FILES = [
  'components/account/AccountProfilePane.module.css',
  'components/account/accountAuth.module.css',
  'components/account/changePassword.module.css',
  'components/settings-extensions/ExtensionDetailModal.module.css',
  'components/settings/ExternalSessionImport.module.css',
  'components/settings/FontSettingsSection.module.css',
  'components/settings/RunDetailDialog.module.css',
  'components/settings/RunHistoryList.module.css',
  'components/settings/SettingsArchiveTab.module.css',
  'components/settings/SettingsDevicesTab.module.css',
  'components/settings/SettingsPanel.module.css',
  'components/settings/SettingsQuickMenu.module.css',
  'components/settings/SettingsScheduleTab.module.css',
  'components/settings/SettingsSecurityTab.module.css',
  'components/settings/SettingsShortcutsTab.module.css',
  'components/settings/SettingsUI.module.css',
  'components/settings/StatusDiagnosticsPanel.module.css',
  'components/settings/WorkflowEditModal.module.css',
  'components/settings/usage/UsageSummaryHero.module.css',
] as const;

/**
 * 已知债务：裸 px 高度计数基线（只许减不许增）。
 * 构成以非控件几何为主：图表绘图区/单元格、弹窗与编辑器尺寸、骨架占位、
 * 输入域高度、圆点与进度条等微件；其中控件档候选（28/32/36px 等）由收口
 * 批次逐项 token 化后把文件移入 GUARDED_FILES。
 * FontSelectField 的 3 处为代码内已注明「刻度外裸值，授权保留」的刻度标记，
 * 仍计入台账封顶，防止无声增长。
 * 烧减记录（2026-11-01）：总数 74 → 52；changePassword、
 * ExtensionDetailModal、SettingsQuickMenu 三文件清零移入 GUARDED_FILES；
 * 其余保留处均已在各 CSS 文件内逐处注明「刻度外裸值……授权保留」的性质。
 * 烧减记录（2026-11-02，高度分档收编）：RunDetailDialog 三处详情区上限
 * 入档（--expand-max-h-viewport-sm）清零，移入 GUARDED_FILES；
 * ModelsSettingsTab 下拉 210 入档（8 → 7）；SkillEditorModal 候选 220
 * 入档（6 → 5）。
 */
const DEBT_FILES: Record<string, number> = {
  'components/account/account.module.css': 1,
  'components/account/accountControls.module.css': 1,
  'components/settings-extensions/SettingsExtensionsTab.module.css': 1,
  'components/settings-mcp/McpSettingsTab.module.css': 1,
  'components/settings-models/ModelsSettingsTab.module.css': 7,
  'components/settings-models/ScanResultsModal.module.css': 1,
  'components/settings-models/YamlConfigEditorModal.module.css': 2,
  'components/settings-skills/SkillEditorModal.module.css': 5,
  'components/settings-skills/SkillsSettingsTab.module.css': 10,
  'components/settings/FontSelectField.module.css': 3,
  'components/settings/PriceConfigModal.module.css': 1,
  'components/settings/ScheduledTasksPanel.module.css': 2,
  'components/settings/SettingsAboutTab.module.css': 1,
  'components/settings/SettingsRulesTab.module.css': 2,
  'components/settings/SettingsUsageTab.module.css': 3,
  'components/settings/usage/ActivityMatrixHeatmap.module.css': 1,
  'components/settings/usage/ModelDistributionSection.module.css': 2,
  'components/settings/usage/UsageTrendChart.module.css': 3,
};

const BARE_PX_HEIGHT =
  /(?:^|[\n;{])\s*(?:min-height|max-height|height)\s*:\s*\d+(?:\.\d+)?px/g;

function countBarePxHeights(cssText: string): number {
  const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...stripped.matchAll(BARE_PX_HEIGHT)].length;
}

function readSrcFile(relPath: string): string {
  const fullPath = resolve(srcDir, relPath);
  if (!existsSync(fullPath)) {
    throw new Error(`[settings-css-guard] Target file not found: ${fullPath}`);
  }
  return readFileSync(fullPath, 'utf8');
}

function collectScopeCssFiles(): string[] {
  const out: string[] = [];
  const walk = (absDir: string) => {
    for (const entry of readdirSync(absDir)) {
      const abs = resolve(absDir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
      } else if (entry.endsWith('.css')) {
        out.push(relative(srcDir, abs).split(sep).join('/'));
      }
    }
  };
  for (const dir of SCOPE_DIRS) walk(resolve(srcDir, dir));
  return out.sort();
}

describe('SETTINGS-CSS-HEIGHT-GUARD 设置 CSS 裸 px 高度守门', () => {
  it('契约 1：清单完备——设置范围 CSS 全集 = 已达标 ∪ 已知债务', () => {
    const actual = collectScopeCssFiles();
    const listed = [...GUARDED_FILES, ...Object.keys(DEBT_FILES)].sort();
    expect(
      actual,
      '设置范围出现未归类 CSS 文件（或清单文件已被删除/改名）：新文件须先判定达标或计入债务台账'
    ).toEqual(listed);
  });

  it('契约 2：已达标文件不得出现裸 px 高度（须走 --control-height-*/--space-*）', () => {
    for (const relPath of GUARDED_FILES) {
      const count = countBarePxHeights(readSrcFile(relPath));
      expect(
        count,
        `${relPath} 已在达标清单内，新增裸 px 高度即回归；确需固定高度时先入 token 体系`
      ).toBe(0);
    }
  });

  it('契约 3：已知债务计数只许减不许增，减到 0 必须移入达标清单', () => {
    for (const [relPath, baseline] of Object.entries(DEBT_FILES)) {
      const count = countBarePxHeights(readSrcFile(relPath));
      expect(
        count,
        `${relPath} 裸 px 高度计数 ${count} 超过基线 ${baseline}：债务只许烧减，新增须先更新台账并说明`
      ).toBeLessThanOrEqual(baseline);
      expect(
        count,
        `${relPath} 裸 px 高度已清零，请把该文件从 DEBT_FILES 移入 GUARDED_FILES 锁定`
      ).toBeGreaterThan(0);
    }
  });
});
