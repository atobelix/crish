// @vitest-environment jsdom
/**
 * 01 视口包含块 · 源码契约（骨架落盘）。
 * 测绿 ≠ 视口已交付；9222 盒模型另验。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const layoutRel = './shell-layout.css';
const indexRel = '../../index.css';
const moduleRel = '../../components/binary-tree/BinaryTreeWorkspace.module.css';
const appRel = '../../App.tsx';
const boundaryRel = '../../components/AppErrorBoundary.tsx';

function readBeside(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

function ruleBlock(css: string, selector: string): string {
  const needle = `${selector} {`;
  const idx = css.indexOf(needle);
  expect(idx, `缺少选择器 ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  expect(close, `${selector} 块未闭合`).toBeGreaterThan(open);
  return css.slice(open, close + 1);
}

describe('shell-layout 高度链骨架', () => {
  const layoutCss = readBeside(layoutRel);

  it('含 #root / .app-container / .main-layout / .workspaces-*，共享块有 min-height:0 与 flex: 1 1 0%', () => {
    expect(layoutCss).toContain('#root');
    expect(layoutCss).toContain('.app-container');
    expect(layoutCss).toContain('.main-layout');
    expect(layoutCss).toContain('.workspaces-column');
    expect(layoutCss).toContain('.workspaces-stack');
    expect(layoutCss).toContain('.workspaces-container');

    const shared = ruleBlock(layoutCss, '.workspaces-container');
    expect(shared).toMatch(/min-height:\s*0/);
    expect(shared).toMatch(/flex:\s*1\s+1\s+0%/);
  });

  it('.main-layout 钉死 row', () => {
    const block = ruleBlock(layoutCss, '.main-layout');
    expect(block).toMatch(/flex-direction:\s*row/);
  });

  it('无皮选择器、无伪加速、无 !important', () => {
    expect(layoutCss).not.toMatch(/transform/i);
    expect(layoutCss).not.toContain('!important');
    expect(layoutCss).not.toContain('.app-top-bar');
    expect(layoutCss).not.toContain('.workspace-card');
    expect(layoutCss).not.toContain('.settings-');
    expect(layoutCss).not.toContain('shell-chrome');
  });

  it('整文件行数 ≤ 120', () => {
    const lines = layoutCss.split(/\r?\n/).length;
    expect(lines, `shell-layout.css 行数 ${lines}`).toBeLessThanOrEqual(120);
  });
});

describe('入口与画布刚性', () => {
  it('index.css 在 reset 后 import layout，不引其它 shell 皮表', () => {
    const indexCss = readBeside(indexRel);
    expect(indexCss).toContain("@import './styles/shell/shell-layout.css';");
    expect(indexCss).not.toMatch(/shell-workspace/);
    expect(indexCss).not.toMatch(/shell-polish/);
    expect(indexCss).not.toMatch(/shell-menus/);
    expect(indexCss).not.toMatch(/shell-sidebar/);
    expect(indexCss).not.toMatch(/shell-dragdrop/);
  });

  it('.canvas 不再 height:auto，且为 flex: 1 1 0%', () => {
    const moduleCss = readBeside(moduleRel);
    const canvas = ruleBlock(moduleCss, '.canvas');
    expect(canvas).not.toMatch(/height:\s*auto/);
    expect(canvas).toMatch(/flex:\s*1\s+1\s+0%/);
    const treeBody = ruleBlock(moduleCss, '.treeBody');
    expect(treeBody).toMatch(/flex:\s*1\s+1\s+0%/);
    expect(moduleCss).not.toContain(':global(.is-narrow)');
  });

  it('App.tsx 仍挂全局 class 字符串，未改 module 双轨', () => {
    const appTsx = readBeside(appRel);
    expect(appTsx).toContain('className={`app-container ${appModeClass}`}');
    expect(appTsx).toContain('className="main-layout"');
    expect(appTsx).not.toContain('styles.appContainer');
    expect(appTsx).not.toContain('styles.mainLayout');
  });

  it('AppErrorBoundary 成功态仍 display:contents（不断链）', () => {
    const src = readBeside(boundaryRel);
    expect(src).toMatch(/display:\s*['"]contents['"]/);
  });
});
