import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 标签条动效单一真理路径契约守卫
 *
 * 锁定四条不可回潮的架构事实：
 * 1. CSS 侧时长/缓动只引用 tokens.css，幽灵 token（--dur-fast/--ease-default）禁入；
 * 2. 条带入场 = @starting-style 单轨（零 JS 入场状态机）；
 * 3. 条带离场 = [data-leaving] 目标态 + 负 margin 抵消 gap（零收尾跳变）；
 * 4. 条带生命周期由 transitionend 驱动，禁止字面量毫秒定时器；几何常量单一来源。
 */

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const CRISH_DESKTOP_ROOT = join(DIR, '../../../..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(CRISH_DESKTOP_ROOT, relativePath), 'utf-8');
}

const paneCss = readRepoFile('src/components/binary-tree/PaneHeader.module.css');
const toolCss = readRepoFile(
  'src/components/binary-tree/LeafToolTabStrip.module.css'
);
const paneTsx = readRepoFile('src/components/binary-tree/PaneHeader.tsx');
const paneTabItemTsx = readRepoFile(
  'src/components/binary-tree/PaneTabItem.tsx'
);
const toolTsx = readRepoFile('src/components/binary-tree/LeafToolTabStrip.tsx');
const dragFeelTs = readRepoFile(
  'src/components/shell/sessionTabDragFeel.ts'
);
const tokensCss = readRepoFile('src/styles/tokens.css');
const motionTs = readRepoFile('src/utils/motionTokens.ts');

describe('标签条动效单一真理路径契约', () => {
  it('两条条带 CSS 均无幽灵动效 token', () => {
    for (const [name, css] of [
      ['PaneHeader.module.css', paneCss],
      ['LeafToolTabStrip.module.css', toolCss],
    ] as const) {
      expect(css, name).not.toMatch(/--dur-fast|--ease-default/);
    }
  });

  it('两条条带入场均为 @starting-style 单轨，无入场类状态机', () => {
    expect(paneCss).toContain('@starting-style');
    expect(toolCss).toContain('@starting-style');
    expect(paneTsx).not.toMatch(/tabItemEntering|isEntering/);
    expect(toolTsx).not.toMatch(/isEntering/);
    expect(paneTsx).not.toMatch(/enteringTabIds|enterTimersRef/);
  });

  it('两条条带离场均以负 margin 精确抵消右侧 gap', () => {
    expect(paneCss).toContain('calc(-1 * var(--tab-gap))');
    expect(toolCss).toContain('calc(-1 * var(--tab-gap))');
  });

  it('条带生命周期由 transitionend 驱动，禁止字面量毫秒定时器', () => {
    // 会话标签项的事件接线在拆分出的 PaneTabItem 中
    expect(paneTabItemTsx).toMatch(/onTransitionEnd/);
    expect(paneTabItemTsx).not.toMatch(/setTimeout\([^,]*,\s*\d{2,3}\s*\)/);
    for (const [name, tsx] of [
      ['PaneHeader.tsx', paneTsx],
      ['LeafToolTabStrip.tsx', toolTsx],
    ] as const) {
      expect(tsx, name).toMatch(/finalizeClose/);
      expect(tsx, name).not.toMatch(/setTimeout\([^,]*,\s*\d{2,3}\s*\)/);
      expect(tsx, name).not.toMatch(/\b(120|140|160|180|190|220|250)\b\s*ms/);
    }
  });

  it('几何常量单一来源：双条带与拖拽手感均接入 tabStripGeometry', () => {
    expect(paneTsx).toContain("from '../../utils/tabStripGeometry'");
    expect(toolTsx).toContain("from '../../utils/tabStripGeometry'");
    expect(dragFeelTs).toContain("from '../../utils/tabStripGeometry'");
  });

  it('TS 侧动效镜像与 tokens.css 正典缓动同步', () => {
    expect(tokensCss).toContain('--ease-standard: cubic-bezier(0.4, 0, 0.2, 1)');
    expect(tokensCss).toContain(
      '--ease-emphasized: cubic-bezier(0.16, 1, 0.3, 1)'
    );
    expect(tokensCss).toContain('--duration-micro: 100ms');
    expect(tokensCss).toContain('--duration-fast: 150ms');
    expect(motionTs).toContain("'cubic-bezier(0.4, 0, 0.2, 1)'");
    expect(motionTs).toContain("'cubic-bezier(0.16, 1, 0.3, 1)'");
    expect(motionTs).toContain('DURATION_MICRO_MS = 100');
    expect(motionTs).toContain('DURATION_FAST_MS = 150');
  });

  it('等宽锁定为单变量通道： PaneHeader 无 --tab-locked-width 与 !important 声明', () => {
    expect(paneCss).not.toContain('--tab-locked-width');
    expect(paneCss).not.toMatch(/!important\s*[;}]/);
  });

  it('原生 app-region 遮蔽在场：两条条带必须显式 no-drag（WebView2 HWND 层通道，勿删）', () => {
    // 顶栏 spacer 的 app-region:drag 由 WebView2 在 HWND 层原生命中（绕过 JS），
    // 罩住顶行标签条带；条带必须显式 no-drag 才能挡住原生标题栏双击最大化。
    // 2026-09-06 事故：误判 app-region 为死代码删除后，双击标签即被原生 caption 最大化。
    expect(paneCss).toMatch(/-webkit-app-region:\s*no-drag/);
    expect(paneCss).toMatch(/\.tabsContainer[\s\S]{0,400}?app-region:\s*no-drag/);
    expect(paneCss).toMatch(/\.tabItem[\s\S]{0,1200}?app-region:\s*no-drag/);
    expect(toolCss).toMatch(/-webkit-app-region:\s*no-drag/);
  });
});
