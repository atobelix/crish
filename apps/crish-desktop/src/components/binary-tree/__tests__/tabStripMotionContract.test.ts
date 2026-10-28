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
  const content = readFileSync(join(CRISH_DESKTOP_ROOT, relativePath), 'utf-8');
  if (relativePath === 'src/styles/tokens.css') {
    return content.replace(/@import\s+['"]\.\/([^'"]+)['"];/g, (_, file) => {
      return readFileSync(
        join(CRISH_DESKTOP_ROOT, 'src/styles', file),
        'utf-8'
      );
    });
  }
  return content;
}

const paneCss = readRepoFile(
  'src/components/binary-tree/PaneHeader.module.css'
);
const launcherCss = readRepoFile(
  'src/components/binary-tree/NewTabLauncherPopover.module.css'
);
const toolCss = readRepoFile(
  'src/components/binary-tree/LeafToolTabStrip.module.css'
);
const paneTsx = readRepoFile('src/components/binary-tree/PaneHeader.tsx');
const paneTabItemTsx = readRepoFile(
  'src/components/binary-tree/PaneTabItem.tsx'
);
const toolTsx = readRepoFile('src/components/binary-tree/LeafToolTabStrip.tsx');
const dragFeelTs = readRepoFile('src/components/shell/sessionTabDragFeel.ts');
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
    expect(paneCss).toContain('calc(-1 * var(--pane-tab-gap))');
    expect(toolCss).toContain('calc(-1 * var(--pane-tab-gap))');
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
    const varsTs = readRepoFile('src/components/binary-tree/tabStripVars.ts');
    expect(paneTsx).toContain("from '../../utils/tabStripGeometry'");
    expect(
      toolTsx.includes("from '../../utils/tabStripGeometry'") ||
        varsTs.includes("from '../../utils/tabStripGeometry'")
    ).toBe(true);
    expect(dragFeelTs).toContain("from '../../utils/tabStripGeometry'");
  });

  it('TS 侧动效镜像与 tokens.css 正典缓动同步', () => {
    expect(tokensCss).toContain(
      '--ease-standard: cubic-bezier(0.4, 0, 0.2, 1)'
    );
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

  it('原生 app-region 遮蔽在场：功能区显式 no-drag，非功能区保留原生窗口拖拽', () => {
    // 顶栏 spacer 的 app-region:drag 由 WebView2 在 HWND 层原生命中（绕过 JS）；
    // 功能区（标签条、会话项、加号包裹区与加号按钮）必须显式 no-drag 才能挡住原生标题栏手势劫持。
    // 而容器非功能区域（空白标题栏区域）不带 no-drag，保证鼠标按下移动可正常拖拽窗口。
    expect(paneCss).toMatch(/-webkit-app-region:\s*no-drag/);
    expect(paneCss).toMatch(/\.tabsList[\s\S]{0,400}?app-region:\s*no-drag/);
    expect(paneCss).toMatch(
      /\.launcherWrapper[\s\S]{0,400}?app-region:\s*no-drag/
    );
    expect(paneCss).toMatch(/\.tabItem[\s\S]{0,1200}?app-region:\s*no-drag/);
    expect(toolCss).toMatch(/-webkit-app-region:\s*no-drag/);

    // 加号启动器自身及其功能区元素（按钮/图标/弹出菜单）必须显式具备 no-drag，防御原生标题栏劫持
    expect(launcherCss).toMatch(
      /\.newTabBtn[\s\S]{0,600}?app-region:\s*no-drag/
    );
    expect(launcherCss).toMatch(
      /\.newTabBtn[\s\S]{0,600}?-webkit-app-region:\s*no-drag/
    );
    expect(launcherCss).toMatch(
      /\.popoverContent[\s\S]{0,600}?app-region:\s*no-drag/
    );
    expect(launcherCss).toMatch(
      /\.plusIconWrap[\s\S]{0,400}?app-region:\s*no-drag/
    );
  });

  it('TS 侧弹簧与 tokens-base.css 原生 37 点 linear() 曲线双向锁定', () => {
    // 1. 验证 37 点采样点严格一致
    expect(tokensCss).toContain('--ease-spring: linear(0, 0.0213, 0.0739,');
    expect(tokensCss).toContain('0.9955, 0.9963, 1);');
    expect(motionTs).toContain('EASE_SPRING_LINEAR =');
    expect(motionTs).toContain("'linear(0, 0.0213, 0.0739,");

    // 2. 验证弹簧阶梯时长双向同步
    expect(tokensCss).toContain('--duration-spring-snappy: 260ms');
    expect(tokensCss).toContain('--duration-spring-smooth: 400ms');
    expect(tokensCss).toContain('--duration-spring-morph: 420ms');
    expect(tokensCss).toContain('--duration-spring: 580ms');

    expect(motionTs).toContain('DURATION_SPRING_SNAPPY_MS = 260');
    expect(motionTs).toContain('DURATION_SPRING_SMOOTH_MS = 400');
    expect(motionTs).toContain('DURATION_SPRING_MORPH_MS = 420');
    expect(motionTs).toContain('DURATION_SPRING_MS = 580');

    // 3. 验证 MOTION_SPRING 对象的关键物理参数锁定
    expect(motionTs).toContain(
      "snappy: { type: 'spring', visualDuration: 0.26, bounce: 0 }"
    );
    expect(motionTs).toContain(
      "smooth: { type: 'spring', visualDuration: 0.4, bounce: 0 }"
    );
    expect(motionTs).toContain(
      "morph: { type: 'spring', visualDuration: 0.42, bounce: 0 }"
    );
  });

  it('节能档与减弱动效全量覆盖归零契约（零幽灵漏网）', () => {
    // 验证 eco 档清零
    expect(tokensCss).toMatch(
      /html\[data-perf-tier=['"]eco['"]\]\s*\{[\s\S]*?--duration-spring-snappy:\s*0ms;/
    );
    expect(tokensCss).toMatch(
      /html\[data-perf-tier=['"]eco['"]\]\s*\{[\s\S]*?--transition-spring-morph:\s*0ms;/
    );
    expect(tokensCss).toMatch(
      /html\[data-perf-tier=['"]eco['"]\]\s*\{[\s\S]*?--stagger-max:\s*0ms;/
    );
    expect(tokensCss).toMatch(
      /html\[data-perf-tier=['"]eco['"]\]\s*\{[\s\S]*?--blur-subtle:\s*0px;/
    );

    // 验证 prefers-reduced-motion 媒体查询全量清零
    expect(tokensCss).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?--duration-spring-smooth:\s*0ms;/
    );
    expect(tokensCss).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?--transition-spring:\s*0ms;/
    );
    expect(tokensCss).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?--blur-soft:\s*0px;/
    );
  });

  it('所有物理弹簧、交错步长与动态模糊 Token 均具备正典定义与契约锁定', () => {
    const springTokens = [
      '--ease-spring',
      '--duration-spring-snappy',
      '--duration-spring-smooth',
      '--duration-spring-morph',
      '--duration-spring',
      '--transition-spring-snappy',
      '--transition-spring-smooth',
      '--transition-spring-morph',
      '--transition-spring',
      '--stagger-char',
      '--stagger-item',
      '--stagger-word',
      '--stagger-line',
      '--stagger-max',
      '--blur-subtle',
      '--blur-soft',
      '--blur-text',
    ];
    for (const token of springTokens) {
      expect(tokensCss).toContain(`${token}:`);
    }
  });
});
