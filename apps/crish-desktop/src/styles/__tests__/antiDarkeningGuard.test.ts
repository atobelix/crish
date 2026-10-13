// @vitest-environment jsdom
/**
 * antiDarkeningGuard.test.ts
 * 全界面防变黑、Token 单源与 A11y 胶囊设计规范静态守卫测试套件
 *
 * 严格落实 AGENTS.md §12 (A11y Tooltip)、§13 (柔和焦点与克制边框)、§14 (Zero-Blue 纯中性与现代 CSS)
 * 覆盖详案 02 与详案 05 终态集成 10 项严密断言
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

function readFile(relPath: string): string {
  const target = `../../../${relPath}`;
  return readFileSync(new URL(target, import.meta.url), 'utf8');
}

function getSrcRoot(): string {
  const anchorRel = 'src/styles/tokens.css';
  const target = `../../../${anchorRel}`;
  return fileURLToPath(new URL(target, import.meta.url)).replace(
    /[\\/]styles[\\/]tokens\.css$/,
    ''
  );
}

function walkFiles(dir: string, filterExts: string[]): string[] {
  let results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(walkFiles(fullPath, filterExts));
    } else if (
      filterExts.some((ext) => entry.name.endsWith(ext)) &&
      !/\.test\.(ts|tsx)$/.test(entry.name)
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Design System: Anti-Darkening, SSOT & A11y Guardrails (Master Suite)', () => {
  const srcRoot = getSrcRoot();

  // 1. 响应式断点单一真源断言 (0px 漂移)
  it('RULE-01: enforces --breakpoint-sm is defined in tokens.css :root and removed from responsive.css', () => {
    const tokensCss = readFile('src/styles/tokens.css');
    const responsiveCss = readFile('src/styles/responsive.css');

    // tokens.css 顶层 :root 中包含标准 640px 断点
    expect(tokensCss).toMatch(/--breakpoint-sm:\s*640px/);
    // responsive.css 中物理清除断点，消除主题覆盖冲突
    expect(responsiveCss).not.toMatch(/--breakpoint-sm/);
    expect(responsiveCss).not.toMatch(/--breakpoint-md/);
    expect(responsiveCss).not.toMatch(/--breakpoint-lg/);
    expect(responsiveCss).not.toMatch(/--breakpoint-xl/);
  });

  // 2. 全工程 CSS Module 0 处裸写 background: var(--text-primary)
  it('RULE-02: verifies zero raw background: var(--text-primary) across all UI CSS modules', () => {
    const cssModules = walkFiles(join(srcRoot, 'components'), ['.module.css']);
    const violations: string[] = [];

    for (const file of cssModules) {
      const content = readFileSync(file, 'utf8');
      if (/background(-color)?:\s*var\(--text-primary\)/.test(content)) {
        violations.push(relative(srcRoot, file));
      }
    }

    expect(
      violations,
      `Found raw background: var(--text-primary) in: ${violations.join(', ')}`
    ).toEqual([]);
  });

  // 3. 全工程边框加深混入比例严格 <= 10% (AGENTS.md §13)
  it('RULE-03: enforces border color-mix with text-primary is <= 10% (AGENTS.md §13)', () => {
    const cssFiles = walkFiles(srcRoot, ['.css']);
    const violations: string[] = [];
    const regex =
      /border[\w-]*:[^;]*?color-mix\((?:(?![;])[\s\S])*?var\(--text-primary\)(?:(?![;])[\s\S])*?(\d+)%/g;

    for (const file of cssFiles) {
      const content = readFileSync(file, 'utf8');
      let match;
      while ((match = regex.exec(content)) !== null) {
        const percentage = parseInt(match[1], 10);
        if (percentage > 10) {
          violations.push(`${relative(srcRoot, file)} (${percentage}%)`);
        }
      }
    }

    expect(
      violations,
      `Border text-primary mix exceeds 10% in: ${violations.join(', ')}`
    ).toEqual([]);
  });

  // 4. 全工程 0 处未定义悬空 Token (--color-text-dim)
  it('RULE-04: verifies zero dangling --color-text-dim references across src files', () => {
    const files = walkFiles(srcRoot, ['.css', '.tsx', '.ts']);
    const violations: string[] = [];

    for (const file of files) {
      if (file.endsWith('tokens.css')) continue; // tokens.css 中的兜底别名除外
      const content = readFileSync(file, 'utf8');
      if (
        content.includes('var(--color-text-dim)') ||
        /color:\s*var\(--color-text-dim\)/.test(content)
      ) {
        violations.push(relative(srcRoot, file));
      }
    }

    expect(
      violations,
      `Dangling --color-text-dim found in: ${violations.join(', ')}`
    ).toEqual([]);
  });

  // 5. 全工程 0 处 --badge-git-* 幽灵变量
  it('RULE-05: verifies zero --badge-git-* ghost variables across src files', () => {
    const files = walkFiles(srcRoot, ['.css', '.tsx', '.ts']);
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      if (content.includes('--badge-git-')) {
        violations.push(relative(srcRoot, file));
      }
    }

    expect(
      violations,
      `Ghost --badge-git-* variables found in: ${violations.join(', ')}`
    ).toEqual([]);
  });

  // 6. UI 组件 0 处原生 DOM title= 属性 (AGENTS.md §12)
  it('RULE-06: enforces zero native DOM title= attributes across components', () => {
    const tsxFiles = walkFiles(join(srcRoot, 'components'), ['.tsx']);
    const violations: string[] = [];
    const domTitleRegex =
      /<(?:button|div|span|input|a|p|section|svg|label|li|ul|ol|img|select|textarea)\b[^>]*?\stitle\s*=/i;

    for (const file of tsxFiles) {
      const content = readFileSync(file, 'utf8');
      if (domTitleRegex.test(content)) {
        violations.push(relative(srcRoot, file));
      }
    }

    expect(
      violations,
      `Native DOM title= attributes found in: ${violations.join(', ')}`
    ).toEqual([]);
  });

  // 7. Tooltip 组件圆角为 var(--radius-full) 胶囊且阴影为 --shadow-sm
  it('RULE-07: enforces Tooltip module uses radius-full and soft shadow-sm', () => {
    const tooltipCss = readFile('src/components/ui/Tooltip/Tooltip.module.css');
    expect(tooltipCss).toContain('var(--radius-full');
    expect(tooltipCss).toContain('var(--shadow-sm)');
    expect(tooltipCss).not.toContain('var(--shadow-lg)');
  });

  // 8. Zero-Blue 铁律，Git 徽标与改动列表 Hue 210°~215° 偏色清零
  it('RULE-08: enforces zero blue hue (Hue 200-240) in GitStatusBadge and changes list', () => {
    const gitBadgeCss = readFile(
      'src/components/overview/GitStatusBadge.module.css'
    );
    const overviewListCss = readFile(
      'src/components/overview/OverviewChangesList.module.css'
    );

    expect(gitBadgeCss).not.toMatch(/hsl\(21[0-9]\s/);
    expect(gitBadgeCss).not.toMatch(/hsl\(20[0-9]\s/);
    expect(overviewListCss).not.toMatch(/hsl\(21[0-9]\s/);
    expect(overviewListCss).not.toMatch(/hsl\(20[0-9]\s/);
  });

  // 9. --accent-color 翠绿签名且亮度 >= 30%
  it('RULE-09: --accent-color in Light theme must be Emerald and lightness >= 30%', () => {
    const tokensCss = readFile('src/styles/tokens.css');
    const match = tokensCss.match(
      /--accent-color:\s*hsl\(\s*(\d+)\s+([\d.]+)%\s+([\d.]+)%\s*\);/
    );
    expect(match).not.toBeNull();
    if (match) {
      const hue = parseInt(match[1], 10);
      const lightness = parseFloat(match[3]);
      expect(hue).toBeGreaterThanOrEqual(150);
      expect(hue).toBeLessThanOrEqual(170);
      expect(lightness).toBeGreaterThanOrEqual(30);
    }
  });

  // 10. tokens.css 级联隔离（无重复 --z-* 变量，z-index.css 为单一真源）
  it('RULE-10: enforces tokens.css does not redeclare --z-* tokens to prevent cascade traps', () => {
    const tokensCss = readFile('src/styles/tokens.css');
    expect(tokensCss).not.toMatch(/--z-tooltip:\s*9000/);
    expect(tokensCss).not.toMatch(/--z-modal:\s*1000/);
    expect(tokensCss).not.toMatch(/--z-base:\s*0/);
  });

  // 11. 紧凑工具栏高度对齐与防二次 Hover 叠黑门禁 (PLAN-12)
  it('RULE-11A: enforces zero custom hover backgrounds on .actionBtn and .filesNavBtn to prevent double overlay', () => {
    const diffCardCss = readFile('src/components/diff/DiffCard.module.css');
    const filesCardCss = readFile('src/components/files/FilesCard.module.css');

    expect(diffCardCss).not.toMatch(/\.actionBtn:hover\s*\{[^}]*background/);
    expect(diffCardCss).not.toMatch(
      /\.actionBtn\.isActive\s*\{[^}]*background/
    );
    expect(filesCardCss).not.toMatch(
      /\.filesNavBtn:hover[^}]*\{[^}]*background/
    );
  });

  it('RULE-11B: enforces Select.module.css trigger has min-height: 0 to allow compact scaling', () => {
    const selectCss = readFile('src/components/ui/Select/Select.module.css');
    expect(selectCss).not.toMatch(
      /\.trigger\s*\{[^}]*min-height:\s*var\(--control-height,\s*32px\)/
    );
    expect(selectCss).toMatch(/\.trigger\s*\{[^}]*min-height:\s*0/);
  });

  it('RULE-11C: enforces DiffHeaderControls explicitly sets size="sm" on all Select instances', () => {
    const diffHeaderTsx = readFile(
      'src/components/diff/DiffHeaderControls.tsx'
    );
    const selectMatches = diffHeaderTsx.match(/<Select\b[^>]*>/g) || [];
    expect(selectMatches.length).toBeGreaterThan(0);
    for (const selectTag of selectMatches) {
      expect(selectTag).toMatch(/size=["']sm["']/);
    }
  });
});
