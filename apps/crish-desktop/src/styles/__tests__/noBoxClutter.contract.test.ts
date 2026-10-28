/**
 * 防回潮门禁：禁止平直容器圆角、设置页越权描边与盒中盒堆砌
 *
 * 门禁断言：
 * 1. 平直对比与停靠列表容器（DiffCard.module.css）：
 *    .flatFileList, .fileNode, .fileRow, .diffPane, .diffPane .scrollParent,
 *    .scrollParent, .plainScrollParent, .linesContainer, .collapseBar
 *    必须显式声明 border-radius: 0; 且绝不声明 var(--radius-*)。
 * 2. 设置页两层底色（SettingsPanel.module.css）：
 *    [role='dialog'].settingsModal, .settingsNav, .settingsHeader, .coverContent
 *    必须统一使用通底背景色（var(--surface-outer) 或 var(--surface-main)），
 *    同时 .coverContent 作用域定义 --cover-card-bg: var(--surface-input);（T-BLK-07c：
 *    --bg-card 定义收敛至 tokens.css 唯一真源；--cover-card-bg 唯一定义点 = SettingsPanel.module.css）；
 *    且在所有设置页模块样式中，var(--color-error-border)、var(--color-warning-border)、
 *    var(--color-success-border) 发生计数为 0（严禁子 Tab 绕过 --settings-card-border: transparent 绘制 1px 有色边框）。
 * 3. 标签指示滑块无双重边框、Badge 无有色描边（Tabs.module.css / Badge.module.css）：
 *    Tabs .indicatorPill 必须声明 border: none; 且 0 处裸 rgba(；
 *    Badge 各语态类（.toneNeutral, .toneBrand, .toneInfo, .toneSuccess, .toneWarning, .toneDanger）
 *    的 --badge-border 必须为 transparent，严禁包含 color-mix( 有色描边。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = resolve(__dirname, '../..');

function readSrcFile(relPath: string): string {
  return readFileSync(resolve(srcRoot, relPath), 'utf8');
}

/**
 * 全 src 扫描某个 CSS 自定义属性的「定义点」（形如 `--name:` 或 JS 内联 `'--name':`）。
 * onlyAllowedFiles：允许持有定义的文件（相对 srcRoot）。其余文件出现定义即计入违规。
 * 说明：`--name-subtle:` 等派生名不会误报（冒号紧跟校验）；*.test.* 文件跳过（避免正则字面量误报）。
 */
function scanCustomPropertyDefinitions(
  propName: string,
  onlyAllowedFiles: readonly string[]
): string[] {
  const escaped = propName.replace(/[-]/g, '\\$&');
  const defRe = new RegExp(`${escaped}\\s*:`);
  const allowed = new Set(onlyAllowedFiles);
  const violations: string[] = [];

  const walk = (dir: string, rel: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const relPath = `${rel}${rel ? '/' : ''}${item.name}`;
      if (item.isDirectory()) {
        walk(resolve(dir, item.name), relPath);
        continue;
      }
      if (item.name.includes('.test.')) continue;
      if (!/\.(css|scss|ts|tsx)$/.test(item.name)) continue;
      if (allowed.has(relPath)) continue;
      const content = readFileSync(resolve(dir, item.name), 'utf8');
      if (defRe.test(content)) violations.push(relPath);
    }
  };
  walk(srcRoot, '');
  return violations;
}

/** 剥离 CSS 块注释与行注释 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 从 CSS 源码中提取目标选择器对应的声明块（支持单选或组合选择器） */
function extractRuleBlock(css: string, selector: string): string {
  const clean = stripComments(css);
  const idx = clean.indexOf(selector);
  if (idx === -1) {
    throw new Error(`Selector "${selector}" not found in CSS`);
  }
  const open = clean.indexOf('{', idx);
  if (open === -1) {
    throw new Error(`Opening brace "{" not found for selector "${selector}"`);
  }
  const close = clean.indexOf('}', open);
  if (close === -1) {
    throw new Error(`Closing brace "}" not found for selector "${selector}"`);
  }
  return clean.slice(open + 1, close);
}

describe('防回潮门禁：禁止平直容器圆角、设置页越权描边与盒中盒堆砌', () => {
  describe('Assertion 1 (Flat Diff & Dock List Containers = 0 border-radius)', () => {
    const diffCardCss = readSrcFile('components/diff/DiffCard.module.css');
    const FLAT_SELECTORS = [
      '.flatFileList',
      '.fileNode',
      '.fileRow',
      '.diffPane',
      '.diffPane .scrollParent',
      '.scrollParent',
      '.plainScrollParent',
      '.linesContainer',
      '.collapseBar',
    ] as const;

    const varRadiusRegex = new RegExp(
      ['border-radius:\\s*var\\(', '--radius-'].join('')
    );
    for (const sel of FLAT_SELECTORS) {
      it(`${sel} 必须声明 border-radius: 0; 且绝不声明 radius 圆角 token`, () => {
        const block = extractRuleBlock(diffCardCss, sel);
        expect(block, `${sel} 缺少 border-radius: 0; 声明`).toMatch(
          /border-radius:\s*0\b/
        );
        expect(block, `${sel} 严禁声明 radius 圆角 token`).not.toMatch(
          varRadiusRegex
        );
      });
    }
  });

  describe('Assertion 2 (Settings Two-Tier Surface & No --color-*-border Escape)', () => {
    const settingsPanelCss = readSrcFile(
      'components/settings/SettingsPanel.module.css'
    );
    const TWO_TIER_SURFACE_SELECTORS = [
      "[role='dialog'].settingsModal",
      '.settingsNav',
      '.settingsHeader',
      '.coverContent',
    ] as const;

    it('设置面板外层、导航、顶栏、内容区统一使用底色 token（var(--surface-outer) 或 var(--surface-main)）', () => {
      for (const sel of TWO_TIER_SURFACE_SELECTORS) {
        const block = extractRuleBlock(settingsPanelCss, sel);
        expect(block, `${sel} 背景色必须为两层底色系统中的通底色`).toMatch(
          /background:\s*var\(--surface-(?:outer|main)\);/
        );
      }
    });

    it('.coverContent 必须设置 --cover-card-bg: var(--surface-input); 形成两层底色（T-BLK-07c 改名后）', () => {
      const block = extractRuleBlock(settingsPanelCss, '.coverContent');
      expect(
        block,
        '.coverContent 必须定义 --cover-card-bg 为 var(--surface-input)'
      ).toMatch(/--cover-card-bg:\s*var\(--surface-input\);/);
    });

    it('负向：--bg-card 定义（--bg-card:）不得出现在 styles/tokens.css 之外（T-BLK-07c SSOT 收口）', () => {
      const violations = scanCustomPropertyDefinitions('--bg-card', [
        'styles/tokens.css',
        'styles/tokens-surface.css',
      ]);
      expect(
        violations,
        `--bg-card 的唯一真源是 styles/tokens.css，以下文件出现定义（覆写/重定义均禁止）:\n${violations.join('\n')}`
      ).toEqual([]);
    });

    it('负向：--cover-card-bg 只允许在 SettingsPanel.module.css 定义（T-BLK-07c SSOT 收口）', () => {
      const violations = scanCustomPropertyDefinitions('--cover-card-bg', [
        'components/settings/SettingsPanel.module.css',
      ]);
      expect(
        violations,
        `--cover-card-bg 唯一定义点必须是 SettingsPanel.module.css 的 .coverContent，以下文件出现定义:\n${violations.join('\n')}`
      ).toEqual([]);
      // 正向兜底：唯一定义点必须真实存在（防扫描失效导致负向断言恒真）
      const block = extractRuleBlock(settingsPanelCss, '.coverContent');
      expect(block).toMatch(/--cover-card-bg:\s*var\(--surface-input\);/);
    });

    it('所有设置模块样式中，颜色边框逃逸 token 发生计数为 0（严禁子 Tab 绕过 --settings-card-border 逃逸）', () => {
      const compDir = resolve(srcRoot, 'components');
      const settingsCssFiles: string[] = [];

      for (const entry of readdirSync(compDir)) {
        if (!entry.startsWith('settings')) continue;
        const fullDir = resolve(compDir, entry);
        if (!statSync(fullDir).isDirectory()) continue;

        const walk = (dir: string): void => {
          for (const item of readdirSync(dir, { withFileTypes: true })) {
            const p = resolve(dir, item.name);
            if (item.isDirectory()) {
              walk(p);
            } else if (
              item.name.endsWith('.module.css') &&
              !item.name.includes('YamlConfigEditorModal')
            ) {
              settingsCssFiles.push(p);
            }
          }
        };
        walk(fullDir);
      }

      const violations: string[] = [];
      const borderEscapeRe = new RegExp(
        ['var\\(', '--color-', '(?:error|warning|success)-border\\)'].join(''),
        'g'
      );

      for (const file of settingsCssFiles) {
        const content = readFileSync(file, 'utf8');
        const matches = content.match(borderEscapeRe);
        if (matches) {
          violations.push(
            `${file}: 发现 ${matches.length} 处非法有色边框逃逸 (${matches.join(', ')})`
          );
        }
      }

      expect(
        violations,
        `设置子 Tab 样式中严禁出现有色卡片边框：\n${violations.join('\n')}`
      ).toEqual([]);
    });
  });

  describe('Assertion 3 (No Double-Border Pill Indicators or Colored Badge Borders)', () => {
    it('Tabs .indicatorPill 必须声明 border: none; 且 0 处裸 rgba(', () => {
      const tabsCss = readSrcFile('components/ui/Tabs/Tabs.module.css');
      const block = extractRuleBlock(tabsCss, '.indicatorPill');
      expect(
        block,
        '.indicatorPill 必须声明 border: none; 消除双层描边'
      ).toMatch(/border:\s*none;/);
      expect(block, '.indicatorPill 严禁使用裸 rgba(').not.toContain('rgba(');
    });

    it('Badge 各语态类（tone*）--badge-border 必须为 transparent，严禁包含 color-mix( 描边', () => {
      const badgeCss = readSrcFile('components/ui/Badge/Badge.module.css');
      const TONES = [
        'toneNeutral',
        'toneBrand',
        'toneInfo',
        'toneSuccess',
        'toneWarning',
        'toneDanger',
      ] as const;

      for (const tone of TONES) {
        const block = extractRuleBlock(badgeCss, `.${tone}`);
        expect(block, `.${tone} 必须声明 --badge-border: transparent;`).toMatch(
          /--badge-border:\s*transparent;/
        );
        expect(
          block,
          `.${tone} 的边框严禁使用 color-mix( 有色描边`
        ).not.toMatch(/--badge-border:\s*color-mix\(/);
      }
    });
  });
});
