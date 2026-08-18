/**
 * 05-C 源码棘轮：三张合法纸面皮的 6% 软环公式仍在库内。
 *
 * 钉 `blockChrome.css` / `paperList.css` / `NotePaperPanel.module.css`
 * 的 `--bp-focus-*` / `--np-focus-*` = color-mix(border 94% + text 6%)。
 * 纸面焦点选择器不得改回 `var(--focus-ring)` / `--focus-ring-strong`
 *（禁止吃全局暗色 30% 外环 / 3px strong）。
 *
 * 测头自钉：源码棘轮 ≠ CSSOM 已进产品视口 ≠ 打开完成。
 * 本测只读盘，不渲染、不读 CSSOM、不跑 9222。公式不对则红，不改 CSS。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const SKIN_REL = {
  chrome: 'packages/block-paper/src/chrome/blockChrome.css',
  list: 'packages/block-paper/src/list/paperList.css',
  module: 'apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css',
} as const;

function locateRepoRoot(): string {
  let dir = DIR;
  while (true) {
    if (existsSync(join(dir, SKIN_REL.chrome))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`无法定位仓库根（起始 ${DIR}）`);
    }
    dir = parent;
  }
}

const REPO_ROOT = locateRepoRoot();

function readSkin(rel: string): string {
  const full = join(REPO_ROOT, rel);
  expect(existsSync(full), `缺皮文件 ${rel}`).toBe(true);
  return readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 选择器前缀后的第一段规则体（纸面焦点块无嵌套 `{}`）。 */
function ruleBlockAfter(css: string, selectorPrefix: string): string {
  const idx = css.indexOf(selectorPrefix);
  expect(idx, `缺少选择器 ${selectorPrefix}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  expect(close, `${selectorPrefix} 块未闭合`).toBeGreaterThan(open);
  return css.slice(open, close + 1);
}

function assertSoftMix94_6(src: string, label: string): void {
  expect(src, `${label} 须含 color-mix`).toMatch(/color-mix\s*\(/);
  expect(src, `${label} 须含 94%`).toMatch(/94%/);
  expect(src, `${label} 须含 6%`).toMatch(/6%/);
}

/** `--name: color-mix(... 94% ... 6%)` */
function assertFocusVarMix(css: string, name: string): void {
  const re = new RegExp(`${name}:\\s*color-mix\\([\\s\\S]*?94%[\\s\\S]*?6%\\s*\\)`);
  expect(css, `${name} 须为 color-mix 94% + 6%`).toMatch(re);
}

/**
 * 禁止纸面焦点吃全局 30% / 3px。
 * 注释可提 `--focus-ring` 作反例；剥注释后不得当属性值。
 */
function assertNotGlobalFocusRing(css: string, label: string): void {
  const stripped = stripCssComments(css);
  expect(
    stripped,
    `${label}：禁止纸面焦点吃全局 var(--focus-ring) 30%`
  ).not.toMatch(/var\(\s*--focus-ring(?:-color|-strong)?[\s,)]/);
  expect(
    stripped,
    `${label}：禁止 --focus-ring-strong（3px / 22%）`
  ).not.toMatch(/--focus-ring-strong\b/);
  expect(
    stripped,
    `${label}：禁止 box-shadow 3px 全局强环`
  ).not.toMatch(/box-shadow\s*:[^;{]*\b3px\b/);
}

describe('05-C 纸面焦点环源码棘轮（库内 6% 软环）', () => {
  const chrome = readSkin(SKIN_REL.chrome);
  const list = readSkin(SKIN_REL.list);
  const moduleCss = readSkin(SKIN_REL.module);

  it('测头自钉：源码棘轮 ≠ CSSOM 已进产品视口 ≠ 打开完成', () => {
    const self = readFileSync(
      join(DIR, 'notePaperFocusRing.contract.test.ts'),
      'utf8'
    );
    expect(self).toMatch(/源码棘轮 ≠ CSSOM 已进产品视口 ≠ 打开完成/);
    expect(self).not.toMatch(/getComputedStyle\s*\(/);
    expect(self).not.toMatch(/document\.styleSheets/);
    expect(self).not.toMatch(/127\.0\.0\.1:9222/);
  });

  it('三张皮文本仍含 color-mix + 94% + 6%', () => {
    assertSoftMix94_6(chrome, SKIN_REL.chrome);
    assertSoftMix94_6(list, SKIN_REL.list);
    assertSoftMix94_6(moduleCss, SKIN_REL.module);
  });

  it('module --np-focus-edge / --np-focus-row 仍是 94% + 6%', () => {
    const panel = ruleBlockAfter(moduleCss, '.panel {');
    expect(panel).toMatch(/--np-focus-edge\s*:/);
    expect(panel).toMatch(/--np-focus-row\s*:/);
    assertFocusVarMix(panel, '--np-focus-edge');
    assertFocusVarMix(panel, '--np-focus-row');
    expect(panel).toMatch(/var\(--border-color\)\s*94%/);
    expect(panel).toMatch(/var\(--text-primary\)\s*6%/);
  });

  it('chrome --bp-focus-row / --bp-focus-ctrl 仍是 94% + 6%', () => {
    const alias = ruleBlockAfter(chrome, '.bp-chrome-root,');
    expect(alias).toMatch(/--bp-focus-row\s*:/);
    expect(alias).toMatch(/--bp-focus-ctrl\s*:/);
    assertFocusVarMix(alias, '--bp-focus-row');
    assertFocusVarMix(alias, '--bp-focus-ctrl');
  });

  it('paperList 行环 fallback 仍是 94% + 6%（--np-focus-row / --np-focus-edge）', () => {
    expect(list).toMatch(
      /\.bp-paper-block\[tabindex\]:not\(\[tabindex='-1'\]\):focus-visible/
    );
    const row = ruleBlockAfter(list, ".bp-paper-block[data-handle='focus']");
    expect(row).toMatch(/--np-focus-row/);
    expect(row).toMatch(/--np-focus-edge/);
    expect(row).toMatch(/inset 0 0 0 1px/);
    assertSoftMix94_6(row, 'paperList 行环');
  });

  it('chrome slash / .bp-paper-block 环用 --bp-focus-*，不用全局环', () => {
    const slash = ruleBlockAfter(
      chrome,
      '.bp-slash-host button.bp-slash-item:focus-visible'
    );
    expect(slash).toMatch(/box-shadow:\s*0 0 0 2px var\(--bp-focus-ctrl\)/);
    expect(slash).toMatch(/outline:\s*none/);
    assertNotGlobalFocusRing(slash, 'slash 项');

    expect(chrome).toMatch(
      /\.bp-paper-block\[tabindex\]:not\(\[tabindex='-1'\]\):focus-visible/
    );
    const paperBlock = ruleBlockAfter(
      chrome,
      ".bp-paper-block[data-bp-paper-block][data-bp-focus='1']"
    );
    expect(paperBlock).toMatch(
      /box-shadow:\s*inset 0 0 0 1px var\(--bp-focus-row\)/
    );
    expect(paperBlock).toMatch(/outline:\s*none/);
    assertNotGlobalFocusRing(paperBlock, '.bp-paper-block 行环');

    const chromeRow = ruleBlockAfter(
      chrome,
      ".bp-block-row:has(.bp-block-handle[data-handle-visibility='focus'])"
    );
    expect(chromeRow).toMatch(/var\(--bp-focus-row\)/);
    assertNotGlobalFocusRing(chromeRow, '.bp-block-row focus');
  });

  it('module badge / button / input / .blockRow 用 --np-focus-*，不用全局环', () => {
    const badge = ruleBlockAfter(moduleCss, 'button.badge:focus-visible');
    expect(badge).toMatch(/box-shadow:\s*0 0 0 2px var\(--np-focus-edge\)/);
    expect(badge).toMatch(/outline:\s*none/);

    const button = ruleBlockAfter(
      moduleCss,
      '.panel :global(button):focus-visible'
    );
    expect(button).toMatch(/box-shadow:\s*0 0 0 2px var\(--np-focus-edge\)/);

    const input = ruleBlockAfter(
      moduleCss,
      '.panel :global(input):focus-visible'
    );
    expect(input).toMatch(/box-shadow:\s*0 0 0 2px var\(--np-focus-edge\)/);

    expect(moduleCss).toMatch(
      /\.blockRow\[tabindex\]:not\(\[tabindex='-1'\]\):focus-visible/
    );
    const row = ruleBlockAfter(moduleCss, ".blockRow[data-handle='focus']");
    expect(row).toMatch(
      /box-shadow:\s*inset 0 0 0 1px var\(--np-focus-row,\s*var\(--np-focus-edge\)\)/
    );
    expect(row).toMatch(/outline:\s*none/);

    assertNotGlobalFocusRing(badge, 'button.badge');
    assertNotGlobalFocusRing(button, 'panel button');
    assertNotGlobalFocusRing(input, 'panel input');
    assertNotGlobalFocusRing(row, '.blockRow');
  });

  it('三张皮剥注释后：禁止纸面焦点吃全局 30% / 3px', () => {
    assertNotGlobalFocusRing(chrome, SKIN_REL.chrome);
    assertNotGlobalFocusRing(list, SKIN_REL.list);
    assertNotGlobalFocusRing(moduleCss, SKIN_REL.module);
  });
});
