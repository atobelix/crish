/**
 * apps/crish-desktop/src/components/workspace/previewCardG2.contract.test.ts
 *
 * G² 第二波戊 · PreviewCard 族形状迁移定向契约。
 *
 * 三挂载点（ui .popup / workspace .histPanelFloat / .inspectorBadge）：
 * 形状与油漆改由 G2Surface 生成路径承接（档位 + 填充 + 同路径描边 +
 * drop-shadow 单层近似）；宿主 CSS 只留布局与兜底圆弧；死规则 18 类清零。
 * 本文件只做源码级断言，不渲染组件（丙批模式）；产物几何由两份
 * PreviewCard.test.tsx 的 G² describe 覆盖。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI_DIR = resolve(__dirname, '../ui');
const WS_DIR = resolve(__dirname);

/** 读取源码并剥离注释（注释内的反例文本不得被误判为真实声明） */
function readSrc(...segments: string[]): string {
  const raw = readFileSync(resolve(...segments), 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 取行首顶格规则体（行中出现的同名选择器，如暗色 :global 规则，不计） */
function ruleBody(css: string, selector: string): string {
  const re = new RegExp(
    `(?:^|\\n)${escapeRegExp(selector)}\\s*\\{([^{}]*)\\}`,
    'm'
  );
  const m = re.exec(css);
  expect(m, `缺失规则：${selector}`).not.toBeNull();
  return m![1] ?? '';
}

/** 取暗色 :global(html[data-theme='dark']) 下的同名规则体 */
function darkRuleBody(css: string, selector: string): string {
  const re = new RegExp(
    `:global\\(html\\[data-theme='dark'\\]\\)\\s*${escapeRegExp(selector)}\\s*\\{([^{}]*)\\}`
  );
  const m = re.exec(css);
  expect(m, `缺失暗色规则：${selector}`).not.toBeNull();
  return m![1] ?? '';
}

const uiCss = readSrc(UI_DIR, 'PreviewCard/PreviewCard.module.css');
const wsCss = readSrc(WS_DIR, 'PreviewCard.module.css');
const uiTsx = readSrc(UI_DIR, 'PreviewCard/PreviewCard.tsx');
const historyTsx = readSrc(WS_DIR, 'PreviewHistoryPanel.tsx');
const overlayTsx = readSrc(WS_DIR, 'PreviewCardInspectorOverlay.tsx');

/** 第二波戊清退的 18 类死规则（方法 A 导入方穷尽 + 方法 B 全仓 grep） */
const DEAD_18 = [
  'browserNote',
  'empty',
  'emptyDesc',
  'emptyIco',
  'emptySection',
  'emptySectionTitle',
  'iframe',
  'inspectorCloseBtn',
  'miniActionBtn',
  'minimalEmptyContent',
  'portValue',
  'pureBlankCanvas',
  'pureTextLink',
  'pureTextLinkWithIcon',
  'recentIcon',
  'recentText',
  'statusHint',
  'textLinksColumn',
] as const;

describe('G² 第二波戊 · PreviewCard 族形状迁移', () => {
  it('ui .popup：油漆已迁出（无 background/border/box-shadow），只留兜底圆弧', () => {
    const body = ruleBody(uiCss, '.popup');
    expect(body).not.toMatch(/background:/);
    expect(body).not.toMatch(/(^|;)\s*border:/);
    expect(body).not.toMatch(/box-shadow:/);
    expect(body).toMatch(/border-radius:\s*var\(--radius-xl\)/);
  });

  it('ui .popup：阴影变量 --preview-card-g2-shadow 两主题皆有定义（--shadow-2xl 主导层）', () => {
    const light = ruleBody(uiCss, '.popup');
    expect(light).toMatch(
      /--preview-card-g2-shadow:\s*0 32px 64px\s*color-mix\(in srgb, var\(--shadow-color\) 3\.5%, transparent\)/
    );
    const dark = darkRuleBody(uiCss, '.popup');
    expect(dark).toMatch(
      /--preview-card-g2-shadow:\s*0 32px 64px\s*color-mix\(in srgb, var\(--shadow-color\) 40%, transparent\)/
    );
  });

  it("ui PreviewCard.tsx：弹窗挂 G2Surface（r16 + 填充 + 描边 + 阴影变量），三角仍在", () => {
    expect(uiTsx).toContain("import { G2Surface } from '../G2Surface'");
    expect(uiTsx).toContain('<G2Surface');
    expect(uiTsx).toContain('radius="r16"');
    expect(uiTsx).toContain('fill="var(--bg-elevated)"');
    expect(uiTsx).toContain('stroke="var(--border-color)"');
    expect(uiTsx).toContain('dropShadow="var(--preview-card-g2-shadow)"');
    expect(uiTsx).toContain('<PreviewCardArrow');
  });

  it('workspace .histPanelFloat：油漆已迁出，只留定位/布局与兜底圆弧', () => {
    const body = ruleBody(wsCss, '.histPanelFloat');
    expect(body).not.toMatch(/background:/);
    expect(body).not.toMatch(/(^|;)\s*border:/);
    expect(body).not.toMatch(/box-shadow:/);
    expect(body).toMatch(/border-radius:\s*var\(--radius-md\)/);
    expect(body).toMatch(/position:\s*absolute/);
  });

  it('workspace .histPanelFloat：阴影变量 --preview-hist-g2-shadow 两主题皆有定义（--shadow-md 主导层）', () => {
    const light = ruleBody(wsCss, '.histPanelFloat');
    expect(light).toMatch(
      /--preview-hist-g2-shadow:\s*0 2px 8px hsl\(0 0% 0% \/ 0\.06\)/
    );
    const dark = darkRuleBody(wsCss, '.histPanelFloat');
    expect(dark).toMatch(
      /--preview-hist-g2-shadow:\s*0 2px 8px hsl\(0 0% 0% \/ 0\.2\)/
    );
  });

  it('workspace .histPanel：形状根节点纪律——无 overflow/background/border-bottom', () => {
    const body = ruleBody(wsCss, '.histPanel');
    expect(body).not.toMatch(/overflow:/);
    expect(body).not.toMatch(/background:/);
    expect(body).not.toMatch(/border-bottom:/);
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/max-height:/);
  });

  it('workspace .inspectorBadge：油漆已迁出，只留定位/布局与兜底圆弧', () => {
    const body = ruleBody(wsCss, '.inspectorBadge');
    expect(body).not.toMatch(/background:/);
    expect(body).not.toMatch(/(^|;)\s*border:/);
    expect(body).not.toMatch(/box-shadow:/);
    expect(body).toMatch(/border-radius:\s*var\(--radius-md\)/);
  });

  it('workspace 两 TSX：历史浮层与拾取徽标挂 G2Surface（control 档 + 绝对定位纠正）', () => {
    for (const tsx of [historyTsx, overlayTsx]) {
      expect(tsx).toContain('<G2Surface');
      expect(tsx).toContain('radius="control"');
      expect(tsx).toContain(`style={{ position: 'absolute' }}`);
      expect(tsx).toContain('stroke="var(--border-color)"');
    }
    expect(historyTsx).toContain(
      "import { G2Surface } from '../ui/G2Surface'"
    );
    expect(historyTsx).toContain(
      'fill="var(--bg-elevated, var(--bg-primary))"'
    );
    expect(historyTsx).toContain(
      'dropShadow="var(--preview-hist-g2-shadow)"'
    );
    expect(overlayTsx).toContain(
      "import { G2Surface } from '../ui/G2Surface'"
    );
    expect(overlayTsx).toContain('fill="var(--bg-elevated, var(--bg-card))"');
    expect(overlayTsx).toContain(
      'dropShadow="0 2px 8px var(--state-strong)"'
    );
  });

  it('死规则清零：18 类在 workspace PreviewCard.module.css 中零残留', () => {
    for (const name of DEAD_18) {
      const re = new RegExp(`\\.${name}(?![\\w-])`);
      expect(wsCss, `死类残留：.${name}`).not.toMatch(re);
    }
  });

  it('死规则剥离不断活类：.aiStopBtn 仍在（原与 .miniActionBtn 共规则）', () => {
    expect(wsCss).toMatch(/\.aiStopBtn\s*\{/);
  });

  it('两份 CSS 均无手写 clip-path: path（G3 零容忍，只走 G2Surface 的 clip 形态）', () => {
    expect(uiCss).not.toContain('clip-path: path(');
    expect(wsCss).not.toContain('clip-path: path(');
  });
});
