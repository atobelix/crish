/**
 * 叶右上浮动坞开关（`.topSidePanelBtn`）几何契约 —— 防「遮挡顶栏窗控」与「压到抽屉内容」回潮。
 *
 * 实证缺陷 1（2026-09-15 用户报告）：侧边栏按钮跑到右上角叉号（遮挡窗口关闭按钮）。
 * 根因：按钮父容器是 .leaf（内含第一行 PaneHeader 与第二行 .leafBody）；
 *   若 top 误算为 (header - size) / 2，按钮会升到第一行（Y=4px, right=10px），
 *   直接覆盖在 AppTopBar 的窗口关闭按钮（X / 叉号）上方！
 *
 * 实证缺陷 2（防回潮）：按钮必须越过第一行 PaneHeader（--header-height = 36px），
 *   并在第二行（LeafToolTabStrip 抽屉头或 UnitChromeActions 快捷动作条）内垂直居中：
 *   calc(var(--header-height) + (var(--header-height) - var(--leaf-corner-btn-size)) / 2)
 *   此时按钮落在 [36px, 72px] 区间内，既不遮挡第一行顶栏窗控，也不压到抽屉内容。
 *
 * 本文件钉死的不变量（只增不减）：
 *   ① 按钮**整块落在第二行内**（越过第一行标签条，在第二行抽屉头内垂直居中），
 *      纵向位置由行高与按钮尺寸推导，不得再引入独立间隙 token；
 *   ② 第二行让位区与按钮所在行**同一行**（消费方的 calc 契约不得改动）；
 *   ③ `--leaf-corner-btn-*` 只保留「尺寸 + 右边距」二元组，间隙 token 不得复活。
 */
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 与同目录 tabStripMotionContract.test.ts 同一约定：4 级上溯 = crish-desktop 根
const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(DIR, '../../../..');
const read = (rel: string) => readFileSync(join(APP_ROOT, rel), 'utf8');

const WORKSPACE_CSS = 'src/components/binary-tree/BinaryTreeWorkspace.module.css';
const STRIP_CSS = 'src/components/binary-tree/LeafToolTabStrip.module.css';
const TOKENS_CSS = 'src/styles/tokens.css';

/** 取某条选择器所在规则块的声明文本（选择器整体匹配，避免子串误判）。 */
function declarationsOf(css: string, selector: string): string | null {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (selectors.includes(selector)) return m[2];
  }
  return null;
}

/** 取某个自定义属性的所有定义值（px）。 */
function tokenPx(css: string, name: string): number[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: number[] = [];
  for (const m of clean.matchAll(new RegExp(`${name}\\s*:\\s*(-?[\\d.]+)px`, 'g'))) {
    out.push(Number(m[1]));
  }
  return out;
}

describe('叶右上浮动坞开关 · 几何契约（防遮挡顶栏窗控与抽屉内容压盖）', () => {
  it('① 按钮纵向位置必须越过第一行 PaneHeader 并居中于第二行（抽屉/动作条行）', () => {
    const decl = declarationsOf(read(WORKSPACE_CSS), '.topSidePanelBtn');
    expect(decl, `${WORKSPACE_CSS} 缺少 .topSidePanelBtn 规则`).not.toBeNull();

    const top = /top:\s*([^;]+);/.exec(decl!)?.[1]?.trim() ?? '';
    expect(
      top,
      '按钮必须越过第一行会话标签条 PaneHeader（--header-height），并在第二行抽屉头内垂直居中；'
        + '若误写成第一行居中，按钮会跑到窗口右上角叉号处（遮盖窗控）'
    ).toBe('calc(var(--header-height) + (var(--header-height) - var(--leaf-corner-btn-size)) / 2)');
    expect(
      top,
      '不得再引入独立间隙 token：位置由 header-height 与 size 纯函数推导'
    ).not.toMatch(/--leaf-corner-btn-gap/);

    // 几何自洽：推导出的按钮必须完全落在第二行内 [h, 2*h]
    const heights = tokenPx(read(TOKENS_CSS), '--header-height');
    const size = tokenPx(read(TOKENS_CSS), '--leaf-corner-btn-size');
    expect(heights.length, 'tokens.css 未定义 --header-height').toBeGreaterThan(0);
    expect(size.length, 'tokens.css 未定义 --leaf-corner-btn-size').toBeGreaterThan(0);
    for (const h of heights) {
      for (const s of size) {
        const derivedTop = h + (h - s) / 2;
        expect(
          derivedTop,
          `按钮 top=${derivedTop}px 必须位于第一行下方（>= ${h}px），绝不能遮挡顶栏窗控叉号`
        ).toBeGreaterThanOrEqual(h);
        expect(
          derivedTop + s,
          `按钮下缘 ${derivedTop + s}px 必须位于第二行底界以内（<= ${h * 2}px），绝不能下沉压到抽屉内容`
        ).toBeLessThanOrEqual(h * 2);
      }
    }
  });

  it('② 顶行让位区与按钮所在行同行（消费方 calc 契约不得改动）', () => {
    const decl = declarationsOf(read(STRIP_CSS), '.fixedCluster');
    expect(decl, `${STRIP_CSS} 缺少 .fixedCluster 规则`).not.toBeNull();
    expect(
      decl!,
      '标签条右簇必须为顶行的坞开关预留 (size + inset)：'
        + '若改掉这处 calc，让位区与按钮所在行会再次错位'
    ).toMatch(/padding-right:\s*calc\(var\(--leaf-corner-btn-size\)\s*\+\s*var\(--leaf-corner-btn-inset\)\)/);
  });

  it('③ 间隙 token 不得复活（--leaf-corner-btn-* 只留尺寸与右边距）', () => {
    const tokens = read(TOKENS_CSS);
    expect(
      tokens,
      '--leaf-corner-btn-gap 已随缺陷修复删除（纵向位置改为推导）；'
        + '复活它等于把「按钮放到顶行下方」的写法请回来'
    ).not.toMatch(/--leaf-corner-btn-gap\s*:/);
    expect(tokens).toMatch(/--leaf-corner-btn-size\s*:\s*\d+px/);
    expect(tokens).toMatch(/--leaf-corner-btn-inset\s*:\s*\d+px/);
  });
});
