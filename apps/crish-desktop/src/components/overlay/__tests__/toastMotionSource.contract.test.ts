// @vitest-environment jsdom
/**
 * Toast 变换真源契约（2026-11-06 裁定，见 Toast甲板窥边修复报告）：
 * 堆叠/扇形/退场几何只走 motion 层（ToastCard 的 animate + layoutStack target），
 * CSS 模块不再写卡片 transform/opacity/transition。根因：根 m.div 的 style 含
 * MotionValue，motion 写内联 transform: none，压制一切 CSS transform 规则（实测）。
 * 若此契约变红，说明有人把几何写回了 CSS——那条路已被实测证伪，不要修契约，
 * 把几何搬回 motion 层。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));
const CRISH_DESKTOP_ROOT = join(DIR, '../../../..');
const readRepoFile = (p: string): string =>
  readFileSync(join(CRISH_DESKTOP_ROOT, p), 'utf-8');

const TOAST_CSS = readRepoFile(
  'src/components/overlay/ToastStackModern.module.css'
);
const TOAST_CARD = readRepoFile('src/components/overlay/ToastCard.tsx');

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `缺少规则 ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('Toast 变换真源：CSS 不再写卡片 transform', () => {
  it('堆叠/扇形 transform 规则已退役（无 --peek/--swipe 变量引用）', () => {
    expect(TOAST_CSS).not.toMatch(/--peek/);
    expect(TOAST_CSS).not.toMatch(/--swipe-x|--swipe-y/);
    expect(TOAST_CSS).not.toMatch(/translateX\(var\(--swipe-x\)\)/);
    expect(TOAST_CSS).not.toMatch(/translateY\(calc\(var\(--toast-offset-y/);
    expect(TOAST_CSS).not.toMatch(/--scale: calc/);
  });

  it('入场死帧已删除（data-state 从不取 entering）', () => {
    expect(TOAST_CSS).not.toMatch(/@keyframes toastEnterBottom/);
    expect(TOAST_CSS).not.toMatch(/\[data-state='entering'\]/);
  });

  it('退场规则不再写滑出 transform（卡片只留 pointer-events）', () => {
    expect(TOAST_CSS).not.toMatch(/translateX\(calc\(100% \+ 40px\)\)/);
    expect(TOAST_CSS).not.toMatch(/scale\(0\.96\)/);
  });

  it('.toastCard 本体不再声明 transition（transform/opacity 由 motion 驱动）', () => {
    const base = ruleBody(TOAST_CSS, '.toastCard');
    expect(base).not.toMatch(/^\s*transition:/m);
  });

  it('ToastCard 经 motion 驱动堆叠几何与退场', () => {
    expect(TOAST_CARD).toMatch(
      /animate=\{\{ y: stackY, scale: stackScale \}\}/
    );
    expect(TOAST_CARD).toMatch(/animate\(x, width \+ 40/);
    expect(TOAST_CARD).toMatch(/const stackY = target\?\.y \?\? 0/);
  });
});
