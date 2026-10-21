import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldSettleComposerHeight } from './composerHeightSettle';

const dir = dirname(fileURLToPath(import.meta.url));
const composerCss = readFileSync(join(dir, 'ChatComposer.module.css'), 'utf8');

const base = {
  previousHeight: 40,
  nextHeight: 96,
  previousWidth: 640,
  nextWidth: 640,
  previousMultiline: '0',
  nextMultiline: '1',
  previousAttached: false,
  nextAttached: false,
  reducedMotion: false,
};

describe('输入框高度过渡', () => {
  it('单行切多行时减速展开', () => {
    expect(shouldSettleComposerHeight(base)).toBe(true);
  });

  it('附件条出现或消失时展开或收回', () => {
    expect(
      shouldSettleComposerHeight({
        ...base,
        previousMultiline: '1',
        nextMultiline: '1',
        nextAttached: true,
      })
    ).toBe(true);
    expect(
      shouldSettleComposerHeight({
        ...base,
        previousHeight: 120,
        nextHeight: 72,
        previousMultiline: '1',
        nextMultiline: '1',
        previousAttached: true,
        nextAttached: false,
      })
    ).toBe(true);
  });

  it('多行内部继续换行、分屏拉宽、减弱动效都不锁高度', () => {
    expect(
      shouldSettleComposerHeight({
        ...base,
        previousMultiline: '1',
        nextMultiline: '1',
        previousHeight: 96,
        nextHeight: 120,
      })
    ).toBe(false);
    expect(
      shouldSettleComposerHeight({
        ...base,
        nextWidth: 480,
      })
    ).toBe(false);
    expect(
      shouldSettleComposerHeight({
        ...base,
        reducedMotion: true,
      })
    ).toBe(false);
    expect(
      shouldSettleComposerHeight({
        ...base,
        previousHeight: 0,
      })
    ).toBe(false);
  });

  it('卡片高度与附件入场都走减速令牌，不写死曲线', () => {
    expect(composerCss).toMatch(
      /\.composerCard\s*\{[^}]*border-radius\s+var\(--duration-normal\)\s+var\(--ease-decelerate\)[^}]*height\s+var\(--transition-accordion\)/
    );
    expect(composerCss).toMatch(
      /@keyframes composerAttachArrive\s*\{[^}]*translateY\(-6px\)/
    );
    expect(composerCss).toMatch(
      /animation:\s*composerAttachArrive\s+var\(--transition-accordion\)/
    );
    expect(composerCss).not.toMatch(/composerAttachArrive[^;{]*cubic-bezier/);
  });
});
